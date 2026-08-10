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
# 出入金流水的機器端狀態:每所的增量游標(上次成功拉取的時點)+ 供上傳的
# rolling window。與 account.json 同目錄、存活過 reboot;新機被 clear 後不存在,
# 首拉走 INITIAL_LOOKBACK。lib.account_*.get_flows(env, since) 回
# [{ts, direction 'in'/'out', currency, amount, txid}],四所合約一致。
FLOW_STATE_PATH = os.path.join(WORKSPACE, "manager", "flow_state.json")
INITIAL_LOOKBACK_S = 2 * 24 * 3600   # 首拉回看:PnL baseline=launch,更早的不在曲線內
FLOW_PULL_INTERVAL_S = 3600          # get_flows 是重呼叫(89 天滑窗多頁),每小時拉一次
REPULL_OVERLAP_S = 2 * 24 * 3600     # 每次往前多拉 2 天,接住晚結算的 deposit(status 6)
SHIP_WINDOW_S = 35 * 24 * 3600       # rolling window 只留近 35 天,平台 txid dedup 自癒漏送
MAX_SHIP_FLOWS = 200                 # 單所上傳上限,擋 account.json 膨脹

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


def _read_flow_state():
    try:
        with open(FLOW_STATE_PATH) as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_flow_state(state):
    tmp = FLOW_STATE_PATH + ".tmp"
    try:
        with open(tmp, "w") as f:
            json.dump(state, f)
        os.replace(tmp, FLOW_STATE_PATH)  # atomic
    except OSError as e:
        _log(f"flow_state write failed: {type(e).__name__}")


def _clean_flow(raw):
    """一筆 lib get_flows 回傳的最小驗證+正規化;壞的回 None(不上傳污染平台)。"""
    if not isinstance(raw, dict):
        return None
    direction = raw.get("direction")
    txid = raw.get("txid")
    currency = raw.get("currency")
    try:
        ts = int(raw.get("ts"))
        amount = float(raw.get("amount"))
    except (TypeError, ValueError):
        return None
    if direction not in ("in", "out") or not txid or not currency:
        return None
    if not math.isfinite(amount) or amount <= 0 or ts <= 0:
        return None
    return {"ts": ts, "direction": direction, "currency": str(currency)[:20],
            "amount": amount, "txid": str(txid)[:191]}


def _pull_flows(vid, mod, env, flow_state):
    """拉某所的出入金增量、維護 rolling window,回該所要上傳的 flows list。

    相容防呆:lib 沒有 get_flows(舊版)→ 回 None,account.json 就不放 flows 鍵,
    平台端當「沒送流水」走 fallback。get_flows 拋錯→保留現有 window 不推游標,
    best-effort 不拖垮 equity/positions(同 holdings 慣例)。
    """
    if not hasattr(mod, "get_flows"):
        return None

    now = int(time.time())
    st = flow_state.get(vid) or {}
    cursor = st.get("cursor_ts")
    window = [f for f in (st.get("flows") or []) if isinstance(f, dict)]

    # 節流:距上次成功拉取不到一小時就不打交易所,只沿用/修剪既有 window
    if isinstance(cursor, (int, float)) and now - cursor < FLOW_PULL_INTERVAL_S:
        window = [f for f in window if int(f.get("ts", 0)) >= now - SHIP_WINDOW_S]
        flow_state[vid] = {"cursor_ts": cursor, "flows": window[-MAX_SHIP_FLOWS:]}
        return window[-MAX_SHIP_FLOWS:]

    since = int(cursor - REPULL_OVERLAP_S) if isinstance(cursor, (int, float)) \
        else now - INITIAL_LOOKBACK_S
    try:
        fetched = mod.get_flows(env, max(since, 0))
    except Exception as e:
        _log(f"{vid}: get_flows failed ({type(e).__name__}); keeping window")
        return window[-MAX_SHIP_FLOWS:] if window else []

    # 併進 window,txid 去重(平台也 dedup,這裡先省頻寬),剪掉超窗的
    by_txid = {f["txid"]: f for f in window if f.get("txid")}
    for raw in fetched or []:
        cf = _clean_flow(raw)
        if cf:
            by_txid[cf["txid"]] = cf
    merged = sorted(by_txid.values(), key=lambda f: f["ts"])
    merged = [f for f in merged if f["ts"] >= now - SHIP_WINDOW_S][-MAX_SHIP_FLOWS:]
    flow_state[vid] = {"cursor_ts": now, "flows": merged}  # 成功才推游標
    return merged


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


def _norm_holdings(raw):
    """[{'asset','amount','usdt_value','wallet'}, ...] — display-only coin
    holdings. Scrub non-finite numbers, drop rowless dicts, cap at 50 rows
    (a wallet with hundreds of dust coins must not bloat every report)."""
    out = []
    for h in raw or []:
        if not isinstance(h, dict) or not h.get("asset"):
            continue
        out.append({
            "asset": str(h["asset"])[:20],
            "amount": _finite(h.get("amount"), 0.0),
            "usdt_value": _finite(h.get("usdt_value")),
            "wallet": str(h.get("wallet") or "")[:20],
        })
    # sort before capping — an agent-written lib that doesn't pre-sort must
    # not get its LARGEST rows truncated (audit M3)
    out.sort(key=lambda h: -(h["usdt_value"] or 0))
    return out[:50]


def read_venue(vid, env, flow_state=None):
    """One venue → {ok, equity, currency, accounts, positions, holdings,
    flows, error}. Never raises. `flows` absent when the lib has no get_flows
    (older lib) — the platform reads that as "no flows shipped" and falls back."""
    entry = {
        "ok": False, "equity": None, "currency": None,
        "accounts": None, "positions": None, "holdings": None, "error": None,
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
    # Display-only coin holdings (spot/funding wallets) — optional in the
    # module contract and best-effort here: a holdings hiccup must not take
    # equity/positions down with it. None = not supported or failed this tick.
    if hasattr(mod, "get_holdings"):
        try:
            entry["holdings"] = _norm_holdings(mod.get_holdings(env))
        except Exception:
            pass
    # External deposit/withdraw flows for the dual-track PnL — best-effort and
    # absent-when-unsupported, same contract as holdings above. flow_state is
    # mutated in place so the caller can persist the advanced cursor.
    if flow_state is not None:
        flows = _pull_flows(vid, mod, env, flow_state)
        if flows is not None:
            entry["flows"] = flows
    entry["ok"] = True
    return entry


class _VenueTimeout(Exception):
    pass


def _read_venue_timed(vid, env, seconds=60, flow_state=None):
    """Per-venue wall clock: one hanging account module must not starve the
    other venues into the unit's global TimeoutStartSec (which would kill the
    whole run and write nothing). SIGALRM is Linux-only; without it this
    degrades to the unit-level timeout."""
    if not hasattr(signal, "SIGALRM"):
        return read_venue(vid, env, flow_state)

    def _raise(signum, frame):
        raise _VenueTimeout(f"account_{vid} exceeded {seconds}s")

    old = signal.signal(signal.SIGALRM, _raise)
    signal.alarm(seconds)
    try:
        return read_venue(vid, env, flow_state)
    except _VenueTimeout as e:
        # fired between read_venue's own try blocks — record it here
        return {"ok": False, "equity": None, "currency": None, "accounts": None,
                "positions": None, "holdings": None, "error": _err("timeout", e)}
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
    flow_state = _read_flow_state()  # _pull_flows mutates in place (cursor + window)
    out = {"read_at": int(time.time()), "venues": {}}
    for vid in venues:
        entry = _read_venue_timed(vid, env, flow_state=flow_state)
        out["venues"][vid] = entry
        _log(f"{vid}: {'ok' if entry['ok'] else entry['error']['stage'] + ' failed'}")
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    tmp = OUT_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(out, f)
    os.replace(tmp, OUT_PATH)  # atomic: the reporter never sees a half-written file
    # Drop cursors for venues no longer bound (unbound → key gone from .env) so a
    # stale window can't resurface if the venue is rebound later.
    _write_flow_state({v: flow_state[v] for v in venues if v in flow_state})
    _log(f"wrote {len(venues)} venue(s)")


if __name__ == "__main__":
    main()
