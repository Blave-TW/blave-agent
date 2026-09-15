"""Stop ONE agent-deployed strategy (Type B / cron / daemon) and unregister it.

    cd workspace && python3 manager/stop_strategy.py <name> [--also <registry-name> ...] \\
        [--flatten --venue bingx --symbol XRPUSDT --side long \\
         --key-name BINGX_API_KEY_XRP_V2 --secret-name BINGX_SECRET_KEY_XRP_V2 [--demo-name ...]]

Order: (--flatten) read-only exchange preflight → trip the scoped halts
(state/HALT_<scope>, lib.guard.trip_halt_for) for <name>, every literal slug its
code passes to halted_for/trip_halt_for or sets as STRATEGY_SLUG, and each
--halt-scope; an existing halt file is kept as is → remove every schedule line
that runs <name> or an --also name → wait up to ~90s for their processes →
kill survivors → (--flatten) close the position via manager/close_symbol.py →
drop every name from state/deployments.json → verify what is left.

Not touched: strategies/<name>/ files and state.json, the global HALT (other
strategies keep trading). The scoped halt is only honoured by code that checks
halted_for(<name>) — order libs don't; re-enabling means clear_halt_for first. A 下單設定 portfolio member is refused — Type A/C
route live money through the reconciler by that name, and a web-picked Type B's
`# blave-web` cron line is rewritten from the same list on the next save, so
removing it here would not stick; the web is where it is removed.

Linux/macOS only: on Windows this refuses. The runtime's schtasks purge only
matches task NAMES, which misses a monitor registered under another name —
the exact case this tool exists for.

Exit: 0 stopped, unregistered, (closed) and verified · 1 something is left or a
step failed · 2 refused or the exchange preflight read failed, nothing changed ·
3 no schedule, process or registry entry matched any name, nothing changed ·
4 stopped and verified, but --flatten found no position on that side (nothing
sent; leftover orders on the symbol are listed). Same codes as close_symbol.py.
"""
import argparse
import json
import os
import platform
import re
import signal
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
# not `from manager import ...`: with manager/ as the script dir on sys.path,
# `manager` resolves to manager/manager.py (the optimizer)
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import close_symbol as cs  # noqa: E402
from lib import guard  # noqa: E402

REGISTRY_PATH = os.path.join("state", "deployments.json")
_SCOPE_RE = re.compile(r"[A-Za-z0-9_.-]{1,64}")
_SCOPE_SRC_RE = re.compile(
    r"""(?:\b(?:halted_for|trip_halt_for|halt_info_for|clear_halt_for)\(\s*|\bSTRATEGY_SLUG\s*=\s*)"""
    r"""["']([^"'\n]+)["']""")
WAIT_S = 90
POLL_S = 3
KILL_GRACE_S = 5
NOT_MATCHED = 3


def drop_schedule_lines(text, names):
    """(kept text, dropped lines) for lines that run any of names."""
    pats = [p for n in names for p in cs.strategy_line_patterns(n)]
    kept, dropped = [], []
    for line in (text or "").splitlines():
        if line.strip() and not line.lstrip().startswith("#") and any(p.search(line) for p in pats):
            dropped.append(line)
        else:
            kept.append(line)
    out = "\n".join(kept)
    return (out + "\n" if out else ""), dropped


def read_registry(path):
    try:
        with open(path) as f:
            reg = json.load(f)
    except FileNotFoundError:
        return {}
    if not isinstance(reg, dict):
        raise RuntimeError(f"{path} is not a JSON object — not rewriting it")
    return reg


def unregister(path, names):
    """Remove names from the registry with an atomic write. Returns the removed ones."""
    reg = read_registry(path)
    removed = [n for n in names if reg.pop(n, None) is not None]
    if removed:
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(reg, f, indent=2, ensure_ascii=False)
        os.replace(tmp, path)
    return removed


def crontab():
    out = subprocess.run(["crontab", "-l"], capture_output=True, text=True, timeout=10)
    if out.returncode != 0:
        if "no crontab" in (out.stderr or "").lower():
            return ""
        raise RuntimeError(f"crontab -l failed: {(out.stderr or '').strip()[:120]}")
    return out.stdout


def write_crontab(text):
    subprocess.run(["crontab", "-"], input=text, text=True, timeout=10, check=True)


def halt_scopes(name, extra=(), strategies_dir="strategies"):
    """Scoped-halt names for strategy <name>: the directory name, every literal
    its code uses with the *_for guard functions or as STRATEGY_SLUG (monitors
    often check a slug that differs from the dir — poi_live_05 vs POI_Live_05),
    then --halt-scope values. Order kept, duplicates dropped."""
    found = []
    paths = []
    d = os.path.join(strategies_dir, name)
    if os.path.isdir(d):
        for root, dirs, files in os.walk(d):
            dirs[:] = [x for x in dirs if x != "__pycache__"]
            paths += [os.path.join(root, f) for f in files if f.endswith(".py")]
    single = d + ".py"
    if os.path.isfile(single):
        paths.append(single)
    for p in sorted(paths):
        try:
            with open(p, encoding="utf-8", errors="replace") as f:
                found += _SCOPE_SRC_RE.findall(f.read())
        except OSError:
            pass
    out = []
    for scope in [name, *found, *extra]:
        if not _SCOPE_RE.fullmatch(scope):
            print(f"skipping unusable halt scope {scope!r}")
            continue
        if scope not in out:
            out.append(scope)
    return out


def pids_for(names):
    ps = cs.read_processes()
    return sorted({p for n in names for p in cs.running_pids(n, ps)})


def _verify(names, scopes):
    """Print what is left; True when nothing is and every scoped halt is set."""
    _, left_lines = drop_schedule_lines(crontab(), names)
    left_pids = pids_for(names)
    left_reg = [n for n in names if n in read_registry(REGISTRY_PATH)]
    missing = [s for s in scopes if not os.path.exists(guard.halt_path_for(s))]
    print(f"verify — schedule lines left: {len(left_lines)}; processes left: {left_pids or 0}; "
          f"registry entries left: {left_reg or 0}; scoped halts set: "
          f"{', '.join(guard.halt_path_for(s) for s in scopes if s not in missing) or 'none'}"
          + (f"; MISSING: {', '.join(missing)}" if missing else ""))
    return not (left_lines or left_pids or left_reg or missing)


def stop(name, also=(), flatten=None, halt_scope=()):
    if platform.system() == "Windows":
        raise cs.Refused("Windows is not supported (schtasks tasks under another name can't be "
                         "matched safely) — remove the scheduled tasks by hand and tell the user")
    names = [name, *[a for a in also if a != name]]
    for n in names:
        if not cs._NAME_RE.fullmatch(n):
            raise cs.Refused(f"bad name: {n!r}")
    for h in halt_scope:
        if not _SCOPE_RE.fullmatch(h):
            raise cs.Refused(f"bad --halt-scope: {h!r}")
    members = cs.load_members()
    in_portfolio = [n for n in names if n in members]
    if in_portfolio:
        raise cs.Refused(f"{', '.join(in_portfolio)} in the 下單設定 portfolio — the user removes "
                         f"it on the web 自動下單 page (the reconciler routes live money by that name)")

    ctx = None
    if flatten:
        ctx = cs.prepare(flatten["venue"], flatten["symbol"], flatten["side"],
                         flatten.get("key_name"), flatten.get("secret_name"),
                         flatten.get("passphrase_name"), flatten.get("demo_name"),
                         exclude=tuple(names))
        rows, _, _ = cs.read_before_change(ctx, "preflight")
        cs.check_other_side(ctx, rows)

    text, dropped = drop_schedule_lines(crontab(), names)
    pids = pids_for(names)
    registered = [n for n in names if n in read_registry(REGISTRY_PATH)]
    if not (dropped or pids or registered):
        return NOT_MATCHED

    ok = True
    scopes = halt_scopes(name, halt_scope)
    # before the wait: a monitor that checks halted_for stops opening exposure now
    for scope in scopes:
        path = guard.halt_path_for(scope)
        if os.path.exists(path):
            # keep the strategy's own breaker reason/ts
            print(f"scoped halt {path}: already set, kept ({(guard.halt_info_for(scope) or {}).get('reason')})")
            continue
        try:
            guard.trip_halt_for(scope, "stopped by manager/stop_strategy.py", "stop_strategy")
            print(f"scoped halt {path}: written")
        except OSError as e:
            print(f"scoped halt {path}: write failed ({type(e).__name__}: {e})")
            ok = False

    # Races the runtime listener's _cron_lock (a web deploy rewriting crontab in
    # the same second can lose one side's edit). Accepted: this runs on an
    # explicit user request, and the verification below re-reads crontab.
    try:
        if dropped:
            write_crontab(text)
    except (OSError, subprocess.SubprocessError) as e:
        print(f"crontab write failed ({type(e).__name__}: {e}) — scoped halts are written but the "
              f"schedules were NOT removed; nothing killed, closed or unregistered")
        _verify(names, scopes)
        return cs.FAILED
    print(f"schedule lines removed: {len(dropped)}")
    for l in dropped:
        print(f"    {l}")

    deadline = time.time() + WAIT_S
    if pids:
        print(f"waiting up to {WAIT_S}s for running processes to finish: {pids}")
    while pids and time.time() < deadline:
        time.sleep(POLL_S)
        pids = pids_for(names)
    for sig in (signal.SIGTERM, signal.SIGKILL):
        if not pids:
            break
        print(f"sending {sig.name} to {pids}")
        for p in pids:
            try:
                os.kill(p, sig)
            except ProcessLookupError:
                pass
            except PermissionError:
                print(f"    no permission to signal {p} (another user's process)")
                ok = False
        time.sleep(KILL_GRACE_S)
        pids = pids_for(names)

    close_code = None
    if ctx is not None:
        try:
            close_code = cs.run_close(ctx)
        except Exception as e:  # the stop already happened — still unregister and verify
            print(f"flatten failed: {type(e).__name__}: {e}")
            ok = False
        if close_code == cs.FAILED:
            ok = False

    removed = unregister(REGISTRY_PATH, names)
    print(f"unregistered from {REGISTRY_PATH}: {removed or 'none (not registered)'}")

    if not _verify(names, scopes) or not ok:
        return cs.FAILED
    return cs.NO_POSITION if close_code == cs.NO_POSITION else cs.OK


def main(argv=None):
    ap = argparse.ArgumentParser(description="Stop one strategy and unregister it.")
    ap.add_argument("name")
    ap.add_argument("--also", action="append", default=[])
    ap.add_argument("--halt-scope", action="append", default=[],
                    help="extra scoped-halt name the strategy's code checks (repeatable)")
    ap.add_argument("--flatten", action="store_true")
    ap.add_argument("--venue")
    ap.add_argument("--symbol")
    ap.add_argument("--side", choices=("long", "short"))
    cs.add_key_args(ap)
    a = ap.parse_args(argv)
    key_flags = (a.key_name, a.secret_name, a.passphrase_name, a.demo_name)
    if a.flatten and not (a.venue and a.symbol and a.side):
        ap.error("--flatten needs --venue, --symbol and --side")
    if not a.flatten and (a.venue or a.symbol or a.side or any(key_flags)):
        ap.error("--venue/--symbol/--side/key names only apply with --flatten")
    os.chdir(ROOT)
    flatten = ({"venue": a.venue, "symbol": a.symbol, "side": a.side, "key_name": a.key_name,
                "secret_name": a.secret_name, "passphrase_name": a.passphrase_name,
                "demo_name": a.demo_name} if a.flatten else None)
    try:
        code = stop(a.name, a.also, flatten, a.halt_scope)
    except cs.Refused as e:
        print(f"REFUSED: {e}")
        return cs.REFUSED
    if code == NOT_MATCHED:
        print(f"nothing matched: no schedule line, python/bash process or registry entry for "
              f"{', '.join([a.name, *a.also])} — nothing changed")
    return code


if __name__ == "__main__":
    sys.exit(main())
