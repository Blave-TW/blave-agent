"""Account reader: pull live equity/positions from every connected exchange.

Writes workspace/manager/account.json; portfolio_reporter ships that file to
the backend on its own schedule. The split is deliberate (and is the whole
design): this file EXECUTES agent-written lib/account_{venue}.py code, the
reporter only reads JSON — so a hanging or crashing account module can never
take the portfolio report (halt state, heartbeats, positions) down with it,
and a read failure shows up as data ("error" below) instead of silence.

Runs under the system python3 as the agent user, NOT the runtime venv: the
account modules are agent-written workspace code whose dependencies the agent
installed into its own user-site (same interpreter the strategies run on).

Transport note: REST polling per tick. If a venue ever needs to be more
real-time, replace the writer for that venue with a websocket daemon writing
THE SAME account.json — reporter/backend/web never change.
"""
import importlib
import json
import math
import os
import re
import signal
import sys
import time

WORKSPACE = os.environ.get("BLAVE_AGENT_WORKSPACE", "/opt/blave-agent/workspace")
OUT_PATH = os.path.join(WORKSPACE, "manager", "account.json")

# Same discovery rule as portfolio_reporter.venues(): a venue exists iff
# {PREFIX}_API_KEY is in .env (case-insensitive — sinopac_api_key is lowercase),
# and it is readable iff lib/account_{prefix.lower()}.py ships.
_ENV_KEY_RE = re.compile(r"^\s*([A-Za-z0-9_]+)_API_KEY\s*=", re.IGNORECASE)
_RESERVED_PREFIXES = {"BLAVE"}


def _log(msg):
    """Never log values from .env or API responses — shapes and types only."""
    print(f"[account_reader] {msg}", file=sys.stderr)


def _read_env(path):
    """Minimal .env parse (KEY=VALUE, later wins) — the account modules take
    the same dict shape dotenv_values() returns."""
    env = {}
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip("'\"")
    except OSError:
        pass
    return env


def _venues(env):
    out = []
    for k in env:
        m = _ENV_KEY_RE.match(k + "=")
        if not m:
            continue
        prefix = m.group(1)
        if prefix.upper() in _RESERVED_PREFIXES:
            continue
        vid = prefix.lower()
        if os.path.isfile(os.path.join(WORKSPACE, "lib", f"account_{vid}.py")):
            out.append(vid)
    return sorted(set(out))


_ENV_VALUES = []  # set in main(); used to scrub secrets out of error strings


def _err(stage, e):
    # This string ends up in a report the web displays and the platform stores.
    # The modules are supposed to name env KEYS, never values — but they are
    # agent-written, so enforce it: scrub any .env value that leaks into the
    # exception text (echoed request URLs, assert messages) before it leaves
    # the machine.
    msg = str(e)[:500]
    for v in _ENV_VALUES:
        if v and len(v) >= 6 and v in msg:
            msg = msg.replace(v, "***")
    return {"stage": stage, "type": type(e).__name__, "msg": msg[:200]}


def _finite(v, default=None):
    """json.dump would happily emit NaN/Infinity — invalid JSON that kills the
    web's JSON.parse. Coerce non-finite numbers before they reach the file."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    return f if math.isfinite(f) else default


def _norm_positions(raw):
    """Contract shape is {symbol: {'side', 'size': <account currency>}} —
    but the shipped bingx lib (predating the contract) returns a list of
    {'symbol','side','size' in contracts,'mark_price'}. Normalize here so
    every consumer sees one shape."""
    if isinstance(raw, dict):
        # same NaN scrub as the list shape — agent-written dict-contract
        # modules can return non-finite sizes too
        return {
            str(k): {"side": (v or {}).get("side"), "size": _finite((v or {}).get("size"), 0.0)}
            for k, v in raw.items()
        }
    out = {}
    for p in raw or []:
        if not isinstance(p, dict) or not p.get("symbol"):
            continue
        size = _finite(p.get("size", 0), 0.0)
        mark = _finite(p.get("mark_price"))
        if mark is not None:
            size = size * mark
        out[p["symbol"]] = {"side": p.get("side"), "size": round(size, 4)}
    return out


def read_venue(vid, env):
    """One venue → {ok, equity, currency, accounts, positions, error}. Never raises."""
    entry = {
        "ok": False, "equity": None, "currency": None,
        "accounts": None, "positions": None, "error": None,
    }
    try:
        mod = importlib.import_module(f"lib.account_{vid}")
    except Exception as e:
        entry["error"] = _err("import", e)
        return entry
    try:
        eq = mod.get_equity(env)
        entry["equity"] = _finite(eq["equity"])
        entry["currency"] = eq.get("currency")
        if isinstance(eq.get("accounts"), dict):
            entry["accounts"] = {
                str(k): _finite(v, 0.0) for k, v in eq["accounts"].items()
                if isinstance(v, (int, float))
            }
    except Exception as e:
        entry["error"] = _err("get_equity", e)
        return entry
    try:
        entry["positions"] = _norm_positions(mod.get_positions(env))
    except Exception as e:
        entry["error"] = _err("get_positions", e)
        return entry
    entry["ok"] = True
    return entry


class _VenueTimeout(Exception):
    pass


def _read_venue_timed(vid, env, seconds=60):
    """Per-venue wall clock: one hanging account module must not starve the
    other venues into the unit's global TimeoutStartSec (which would kill the
    whole run and write nothing). SIGALRM is Linux-only; without it this
    degrades to the unit-level timeout."""
    if not hasattr(signal, "SIGALRM"):
        return read_venue(vid, env)

    def _raise(signum, frame):
        raise _VenueTimeout(f"account_{vid} exceeded {seconds}s")

    old = signal.signal(signal.SIGALRM, _raise)
    signal.alarm(seconds)
    try:
        return read_venue(vid, env)
    except _VenueTimeout as e:
        # fired between read_venue's own try blocks — record it here
        return {"ok": False, "equity": None, "currency": None, "accounts": None,
                "positions": None, "error": _err("timeout", e)}
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, old)


def main():
    os.chdir(WORKSPACE)  # account modules resolve paths relative to the workspace
    if WORKSPACE not in sys.path:
        sys.path.insert(0, WORKSPACE)
    env = _read_env(os.path.join(WORKSPACE, ".env"))
    _ENV_VALUES.extend(sorted((v for v in env.values() if v), key=len, reverse=True))
    venues = _venues(env)
    out = {"read_at": int(time.time()), "venues": {}}
    for vid in venues:
        entry = _read_venue_timed(vid, env)
        out["venues"][vid] = entry
        _log(f"{vid}: {'ok' if entry['ok'] else entry['error']['stage'] + ' failed'}")
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    tmp = OUT_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(out, f)
    os.replace(tmp, OUT_PATH)  # atomic: the reporter never sees a half-written file
    _log(f"wrote {len(venues)} venue(s)")


if __name__ == "__main__":
    main()
