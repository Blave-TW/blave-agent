"""Bar-by-bar signal parity: replay a strategy's live ticks over a cached parquet with two libs
and compare what each wrote to state.json.

    python tools/signal_parity/replay.py --strategy examples/btc_sma_cross \\
        --cache ~/blave-agent/cache/kline3_1h_BTCUSDT \\
        --bars 2026-09-29T00:00..2026-09-30T23:00 [--old-ref origin/main] [--new-lib DIR]

For every bar label in the window (naive UTC open time, what wait_for_bar calls `expected`) the
tool runs ONE strategy interpreter per side — old = `lib/` + `manager/` from a git ref, new = the
working tree (or --new-lib) — with BLAVE_MODE=live and BLAVE_EXPECTED_BAR=<label>, the cache cut
at that label (see _tick.py), state.json carried from the previous bar on each side, and
compares the signal surface: Type A `position` + the `close=` the runner logged for the tick,
Type C `weights` + `bar_at`. Output: a per-bar table (parity.tsv), the differences (diffs.tsv),
both workspaces kept under --out for inspection.

Exit codes: 0 every compared bar identical; 1 a bar differs, a side exited 0 without writing
state.json, or no bar at all could be compared; 2 a tick failed on either side (crash, timeout);
3 setup / usage error.

Bars: by default only labels present in EVERY --cache dataset are replayed (the ticks wait_for_bar
would actually run — its freshness probe waits for all of them); --all-slots replays every interval
slot, which exercises the not-ready path once the runner has the BLAVE_EXPECTED_BAR gate (exit 75:
both sides = skipped; one side = "one side not ready", reported and counted but NOT a signal
difference — the old lib has no gate, so this is the tool seeing the gate, unless that side's state
moved while it claimed not-ready).
"""
import argparse
import glob
import io
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
from datetime import datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
TICK = os.path.join(HERE, "_tick.py")
LIB_DIRS = ("lib", "manager")
NOT_READY_RC = 75   # the runner's "data has not landed" exit (design §4); no such path exists yet
# runtime artefacts of a strategy dir that must not leak into the replay
STRATEGY_SKIP = {"state.json", "stats.json", "scan.json", "wf.json", "pnl.png", "heatmap.png",
                 "strategy.log", "versions", "chart", "__pycache__", ".backtest.lock", ".backtest.json"}
_INTERVAL_RE = re.compile(r"^(\d+)(min|m|h|d|w)$")
_UNIT = {"min": "minutes", "m": "minutes", "h": "hours", "d": "days", "w": "weeks"}
_CLOSE_RE = re.compile(r"signal=\S+ close=(\S+)")   # lib/runner.py's per-tick line
EPOCH = datetime(1970, 1, 1)


class _Parser(argparse.ArgumentParser):
    def error(self, message):   # usage errors are setup errors (3), never confused with a failed tick (2)
        self.print_usage(sys.stderr)
        _die(message)


def _die(msg):
    print(f"signal_parity: {msg}", file=sys.stderr)
    sys.exit(3)


def _const(src, name):
    m = re.search(rf'^{name}\s*=\s*(.+?)\s*(#.*)?$', src, re.M)
    if not m:
        return None
    lit = re.fullmatch(r'["\']([^"\']+)["\']', m.group(1).strip())
    if not lit:
        _die(f"{name} = {m.group(1).strip()} is not a string literal — the tool reads it as text, "
             f"write the value out (e.g. {name} = \"1h\")")
    return lit.group(1)


def _interval_td(interval):
    m = _INTERVAL_RE.match(interval)
    if not m:
        _die(f"unrecognised INTERVAL {interval!r}")
    return timedelta(**{_UNIT[m.group(2)]: int(m.group(1))})


def _git(*args, cwd=REPO, **kw):
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, **kw)


def _copytree(src, dst):
    shutil.copytree(src, dst, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"), dirs_exist_ok=True)


def _lib_from_ref(ref, ws):
    r = subprocess.run(["git", "archive", "--format=tar", ref, *LIB_DIRS], cwd=REPO, capture_output=True)
    if r.returncode != 0:
        _die(f"git archive {ref} failed: {r.stderr.decode(errors='replace').strip()}")
    with tarfile.open(fileobj=io.BytesIO(r.stdout)) as tar:
        try:
            tar.extractall(ws, filter="data")
        except TypeError:  # python < 3.12 without the backported filter= argument
            tar.extractall(ws)
    return _git("rev-parse", "--short", ref).stdout.strip()


def _lib_from_dir(src, ws):
    for d in LIB_DIRS:
        if not os.path.isdir(os.path.join(src, d)):
            _die(f"{src} has no {d}/")
        _copytree(os.path.join(src, d), os.path.join(ws, d))
    if os.path.abspath(src) == REPO:
        head = _git("rev-parse", "--short", "HEAD").stdout.strip()
        dirty = _git("status", "--porcelain", "--", *LIB_DIRS).stdout.strip()
        return f"{head}{'+dirty' if dirty else ''} (working tree)"
    return src


def _build_workspace(ws, lib_src, strategy_dir, name, caches, seed_state):
    os.makedirs(ws)
    label = lib_src(ws)
    dst = os.path.join(ws, "strategies", name)
    os.makedirs(dst)
    for entry in os.listdir(strategy_dir):
        if entry in STRATEGY_SKIP:
            continue
        p = os.path.join(strategy_dir, entry)
        (_copytree if os.path.isdir(p) else shutil.copy2)(p, os.path.join(dst, entry))
    os.makedirs(os.path.join(ws, "cache"))
    for src, dest_name in caches:
        d = os.path.join(ws, "cache", dest_name)
        (_copytree if os.path.isdir(src) else shutil.copy2)(src, d)
    os.makedirs(os.path.join(ws, "state"))
    if seed_state:
        shutil.copy2(seed_state, os.path.join(dst, "state.json"))
    return label


def _dataset_labels(path):
    """Naive-UTC labels held by one cache dataset (monthly dir or single parquet)."""
    import pandas as pd
    files = sorted(glob.glob(os.path.join(path, "*.parquet"))) if os.path.isdir(path) else [path]
    labels = set()
    for f in files:
        try:
            df = pd.read_parquet(f)
        except Exception:
            continue
        if len(df) and isinstance(df.index, pd.DatetimeIndex):
            idx = df.index.tz_convert("UTC").tz_localize(None) if df.index.tz is not None else df.index
            labels.update(idx.to_pydatetime())
    if not labels:
        _die(f"no bars readable in {path}")
    return labels


def _bar_list(args, interval, caches):
    td = _interval_td(interval)
    lo, hi = (datetime.fromisoformat(x) for x in args.bars.split("..")) if args.bars else (None, None)
    labels = set.intersection(*(_dataset_labels(src) for src, _ in caches))
    if not labels:
        _die("the --cache datasets share no bar label")
    in_window = sorted(t for t in labels if (lo is None or t >= lo) and (hi is None or t <= hi))
    if args.all_slots:
        if lo is None:
            _die("--all-slots needs --bars FROM..TO")
        off = {t for t in in_window if (t - EPOCH) % td}
        if off:
            _die(f"{len(off)} cached labels in the window are off the {interval} grid (e.g. "
                 f"{min(off).isoformat()}) — a TXF 1d 16:00 / 60m :45 style dataset; --all-slots would "
                 f"leave the gate side never ready, use the default cached-label mode")
        t = EPOCH + ((lo - EPOCH) // td) * td
        bars = []
        while t <= hi:
            bars.append(t)
            t += td
    else:
        bars = in_window if lo is not None else in_window[-(args.max or 20):]
    bars = bars[::max(1, args.every)]
    if args.max:
        bars = bars[:args.max]
    if not bars:
        _die("no bars in the window")
    return bars


def _child_env(ws, bar_iso):
    # BLAVE* (not only BLAVE_): BLAVECLAW_HOME is the old name lib/notify still reads.
    # BLAVE_AGENT_HOME / _BASE point INTO the workspace so lib.notify and lib.events find no
    # config / no runtime events channel there — on an agent machine the defaults would
    # otherwise be the real ones.
    env = {k: v for k, v in os.environ.items() if not k.startswith("BLAVE") and k != "TZ"}
    ws = os.path.realpath(ws)   # what os.getcwd() reports inside the child (macOS /var → /private/var)
    env.update({"BLAVE_MODE": "live", "BLAVE_EXPECTED_BAR": bar_iso, "BLAVE_AGENT_HOME": ws,
                "BLAVE_AGENT_BASE": ws, "MPLBACKEND": "Agg", "PYTHONDONTWRITEBYTECODE": "1",
                "PYTHONUNBUFFERED": "1"})
    return env


def _start(python, ws, name, bar_iso, log_path):
    kw = {"stdin": subprocess.DEVNULL}
    if os.name == "nt":
        kw["creationflags"] = subprocess.CREATE_NO_WINDOW
    log = open(log_path, "w", encoding="utf-8", errors="replace")
    slog = os.path.join(ws, "strategies", name, "strategy.log")
    proc = subprocess.Popen([python, TICK, os.path.join("strategies", name, "strategy.py")],
                            cwd=ws, env=_child_env(ws, bar_iso), stdout=log, stderr=subprocess.STDOUT, **kw)
    proc._log, proc._t0 = log, time.monotonic()
    proc._slog, proc._slog_pos = slog, (os.path.getsize(slog) if os.path.exists(slog) else 0)
    return proc


def _finish(proc, timeout):
    try:
        rc = proc.wait(timeout=max(1.0, timeout - (time.monotonic() - proc._t0)))
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        rc = "TIMEOUT"
    proc._log.close()
    close = None
    if os.path.exists(proc._slog):   # the `signal=… close=…` line THIS tick appended (Type A runner)
        with open(proc._slog, encoding="utf-8", errors="replace") as f:
            f.seek(proc._slog_pos)
            hits = _CLOSE_RE.findall(f.read())
        if hits:
            close = float(hits[-1])
    return rc, round(time.monotonic() - proc._t0, 2), close


def _signal(ws, name, close):
    """(kind, surface) from state.json: ('weights', {weights, bar_at}) for Type C,
    ('position', {position, close}) otherwise; ('', None) when no state.json exists."""
    p = os.path.join(ws, "strategies", name, "state.json")
    if not os.path.exists(p):
        return "", None, None
    with open(p, encoding="utf-8") as f:
        st = json.load(f)
    if st.get("type") == "portfolio":
        return "weights", {"weights": st.get("weights"), "bar_at": st.get("bar_at")}, st.get("rebalance_at")
    return "position", {"position": st.get("position"), "close": close}, None


def _same(a, b):
    """Exact equality, except NaN == NaN (a lib that writes NaN would otherwise differ on every bar)."""
    if isinstance(a, float) and isinstance(b, float) and math.isnan(a) and math.isnan(b):
        return True
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(_same(a[k], b[k]) for k in a)
    if isinstance(a, (list, tuple)) and isinstance(b, (list, tuple)):
        return len(a) == len(b) and all(_same(x, y) for x, y in zip(a, b))
    return a == b


def _fmt(v):
    if v is None:
        return ""
    if "position" in v:
        return f"{v['position']!r}" + (f"@{v['close']!r}" if v.get("close") is not None else "")
    w = json.dumps({k: v["weights"][k] for k in sorted(v["weights"])}, separators=(",", ":")) \
        if isinstance(v.get("weights"), dict) else repr(v.get("weights"))
    return f"{w}@{v.get('bar_at')}"


def _tail(path, n=12):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return "".join(f.readlines()[-n:])
    except OSError:
        return ""


def main(argv=None):
    ap = _Parser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--strategy", help="strategy directory (strategy.py inside)")
    src.add_argument("--sample", help="generate one of samples.py's kinds instead (see --sample-arg)")
    ap.add_argument("--sample-arg", action="append", default=[],
                    help="k=v for samples.make (symbol, symbols=A,B, interval, start, schema, fast, slow, rebalance)")
    ap.add_argument("--cache", action="append", default=[], metavar="SRC[=NAME]",
                    help="cache dataset (monthly dir or single parquet) copied into each replay "
                         "workspace as cache/NAME (default: its basename); repeatable; bars = labels "
                         "present in every one of them")
    ap.add_argument("--bars", help="FROM..TO, naive UTC ISO bar labels, inclusive")
    ap.add_argument("--all-slots", action="store_true", help="every interval slot, not only cached bars")
    ap.add_argument("--every", type=int, default=1, help="replay every Nth bar")
    ap.add_argument("--max", type=int, help="at most N bars (default 20 when --bars is omitted)")
    ap.add_argument("--old-ref", default="origin/main", help="git ref for the old lib/ + manager/")
    ap.add_argument("--old-lib", help="directory holding lib/ + manager/ for the old side (instead of --old-ref)")
    ap.add_argument("--new-lib", default=REPO, help="directory holding lib/ + manager/ for the new side (default: this checkout)")
    ap.add_argument("--python", default=sys.executable)
    ap.add_argument("--out", help="output directory (default: a fresh temp dir, kept)")
    ap.add_argument("--seed-state", help="state.json to start both sides from")
    ap.add_argument("--timeout", type=float, default=900, help="seconds per tick per side")
    ap.add_argument("--serial", action="store_true", help="run the two sides one after the other")
    ap.add_argument("--stop-on-diff", action="store_true")
    args = ap.parse_args(argv)

    if not args.cache:
        _die("--cache is required (at least the dataset the strategy's fetch_data reads)")
    caches = []
    for spec in args.cache:
        src, _, dest = spec.partition("=")
        src = os.path.abspath(os.path.expanduser(src))
        if not os.path.exists(src):
            _die(f"cache {src} not found")
        caches.append((src, dest or os.path.basename(src.rstrip("/\\"))))

    out = os.path.abspath(args.out) if args.out else tempfile.mkdtemp(prefix="signal-parity-")
    os.makedirs(out, exist_ok=True)
    if os.path.commonpath([out, REPO]) == REPO:
        print(f"signal_parity: WARNING --out is inside the checkout — dotenv_values() in the replay "
              f"workspaces will find {REPO}/.env (network is blocked, but keep outputs elsewhere)",
              file=sys.stderr)

    if args.sample:
        sys.path.insert(0, HERE)
        import samples
        kw = {}
        for item in args.sample_arg:
            k, _, v = item.partition("=")
            kw[k] = v.split(",") if k == "symbols" else (int(v) if k in ("fast", "slow") else v)
        strategy_dir = samples.make(args.sample, os.path.join(out, "samples"), **kw)
    else:
        strategy_dir = os.path.abspath(args.strategy)
    strategy_py = os.path.join(strategy_dir, "strategy.py")
    if not os.path.isfile(strategy_py):
        _die(f"{strategy_py} not found")
    with open(strategy_py, encoding="utf-8") as f:
        src_text = f.read()
    name = _const(src_text, "STRATEGY_NAME") or os.path.basename(strategy_dir)
    interval = _const(src_text, "INTERVAL")
    if not interval:
        _die("strategy.py has no INTERVAL — Type B strategies have no bar to replay")

    old_src = (lambda ws: _lib_from_dir(os.path.abspath(args.old_lib), ws)) if args.old_lib \
        else (lambda ws: _lib_from_ref(args.old_ref, ws))
    new_src = lambda ws: _lib_from_dir(os.path.abspath(args.new_lib), ws)
    sides = {}
    for side, lib_src in (("old", old_src), ("new", new_src)):
        ws = os.path.join(out, side)
        if os.path.exists(ws):
            shutil.rmtree(ws)
        sides[side] = (ws, _build_workspace(ws, lib_src, strategy_dir, name, caches, args.seed_state))
        os.makedirs(os.path.join(out, "logs", side), exist_ok=True)

    bars = _bar_list(args, interval, caches)
    print(f"strategy {name} ({interval})  bars {len(bars)}: {bars[0].isoformat()} .. {bars[-1].isoformat()}")
    for side in ("old", "new"):
        print(f"  {side}: {sides[side][1]}")
    print(f"  out: {out}")

    rows, diffs, errors = [], [], []
    compared = not_ready_both = not_ready_one = 0
    prev = {"old": None, "new": None}
    header = ["bar", "old_rc", "new_rc", "kind", "old", "new", "equal", "old_s", "new_s", "note"]
    with open(os.path.join(out, "parity.tsv"), "w", encoding="utf-8") as tsv:
        tsv.write("\t".join(header) + "\n")
        for bar in bars:
            iso = bar.isoformat()
            tag = iso.replace(":", "")
            res = {}
            if args.serial:
                for side in ("old", "new"):
                    p = _start(args.python, sides[side][0], name, iso, os.path.join(out, "logs", side, tag + ".log"))
                    res[side] = _finish(p, args.timeout)
            else:
                procs = {side: _start(args.python, sides[side][0], name, iso,
                                      os.path.join(out, "logs", side, tag + ".log")) for side in ("old", "new")}
                res = {side: _finish(p, args.timeout) for side, p in procs.items()}
            (rc_o, s_o, c_o), (rc_n, s_n, c_n) = res["old"], res["new"]
            kind_o, v_o, _ = _signal(sides["old"][0], name, c_o)
            kind_n, v_n, _ = _signal(sides["new"][0], name, c_n)
            kind = kind_o or kind_n
            equal, note = "n/a", ""
            if rc_o not in (0, NOT_READY_RC) or rc_n not in (0, NOT_READY_RC):
                equal, note = "NO", "tick failed"
                errors.append(iso)
            elif rc_o == NOT_READY_RC and rc_n == NOT_READY_RC:
                note = "both not ready"
                not_ready_both += 1
            elif rc_o != rc_n:
                waiting = "old" if rc_o == NOT_READY_RC else "new"
                moved = not _same(prev[waiting], v_o if waiting == "old" else v_n)
                if moved:
                    equal, note = "NO", f"{waiting} not ready but its state changed"
                else:
                    note = f"{waiting} not ready (not a signal difference)"
                    not_ready_one += 1
            elif not kind_o or not kind_n:
                missing = "both" if not kind_o and not kind_n else ("old" if not kind_o else "new")
                equal, note = "NO", f"no state written ({missing})"
            else:
                compared += 1
                equal = "yes" if _same(v_o, v_n) else "NO"
            prev["old"], prev["new"] = v_o, v_n
            row = [iso, str(rc_o), str(rc_n), kind, _fmt(v_o), _fmt(v_n), equal, str(s_o), str(s_n), note]
            rows.append(row)
            tsv.write("\t".join(row) + "\n")
            tsv.flush()
            mark = "!!" if equal == "NO" else "  "
            print(f"{mark} {iso}  old rc={rc_o} {_fmt(v_o)}  new rc={rc_n} {_fmt(v_n)}  "
                  f"{s_o}s/{s_n}s{('  ' + note) if note else ''}")
            if equal == "NO":
                diffs.append(row)
                for side, rc in (("old", rc_o), ("new", rc_n)):
                    if rc not in (0, NOT_READY_RC):
                        print(f"   --- {side} log tail ---\n{_tail(os.path.join(out, 'logs', side, tag + '.log'))}")
                if args.stop_on_diff:
                    break

    with open(os.path.join(out, "diffs.tsv"), "w", encoding="utf-8") as f:
        f.write("\t".join(header) + "\n")
        for row in diffs:
            f.write("\t".join(row) + "\n")
    changes = sum(1 for a, b in zip(rows, rows[1:]) if a[4].split('@')[0] != b[4].split('@')[0])   # position / weights only
    print(f"\n{len(rows)} bars: {compared} compared ({compared - sum(1 for r in diffs if r[9] == '')} identical), "
          f"{len(diffs)} differ, {len(errors)} failed, {not_ready_one} one-side-not-ready, "
          f"{not_ready_both} both-not-ready; old-side signal changed {changes}× across the window")
    if errors:
        return 2
    if diffs:
        return 1
    if not compared:
        print("no bar produced a comparable signal on both sides — nothing was verified")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
