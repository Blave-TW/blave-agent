"""Minimal check for tools/signal_parity (0.1.22 ②: the gate for "signal zero-difference").

Synthetic 1h cache (two symbols, sine-wave closes so SMA / momentum flip inside a short window),
no network:
  1. Type A, same lib on both sides → exit 0, every bar identical, the position flipped at least
     once in the window, and the close the runner logged per bar is the cache's close AT that bar
     (the cut is pinned to the expected bar, not to the newest cached bar)
  2. Type A, new side = a lib copy whose save_state flips `position` on one bar → exit 1 and
     exactly that bar in diffs.tsv
  3. Type C (weights + bar_at) same lib → exit 0 with weights changing; weights zeroed on one bar
     → exit 1, exactly that bar; a bar where the new side exits 75 without writing is reported as
     "not ready", not as a difference
  4. a probe strategy run through the git-archive path: both sides import lib from their own
     workspace, requests is blocked, BLAVE_AGENT_BASE points into the workspace — and because it
     writes no state.json the tool refuses to call it identical (exit 1, "no state written")
  5. a strategy that crashes → exit 2; --all-slots on a dataset whose labels are off the
     interval grid (TXF-style 16:00 daily labels) → refused, exit 3

Run: cd blave-agent && .venv/bin/python tests/check_signal_parity_tool.py
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools", "signal_parity"))
REPLAY = os.path.join(ROOT, "tools", "signal_parity", "replay.py")

import numpy as np
import pandas as pd

import samples

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


T = tempfile.mkdtemp(prefix="check-signal-parity-")
IDX = pd.date_range("2024-01-01", "2024-02-10 23:00", freq="1h")


def frame(phase, idx=IDX):
    i = np.arange(len(idx), dtype=float)
    close = 100 + 10 * np.sin(i / 9 + phase) + 0.01 * i
    return pd.DataFrame({"Open": close, "High": close + 1, "Low": close - 1, "Close": close, "Volume": 1.0},
                        index=idx)


def write_cache(name, df):
    d = os.path.join(T, "cache", name)
    os.makedirs(d)
    for ym, grp in df.groupby(df.index.strftime("%Y-%m")):
        grp.to_parquet(os.path.join(d, f"{ym}.parquet"))
    return d


FRAMES = {"SYNUSDT": frame(0.0), "SYN2USDT": frame(2.0)}
CACHE = {sym: write_cache(f"kline3_1h_{sym}", df) for sym, df in FRAMES.items()}
# a daily dataset labelled 16:00 UTC (TXF 1d style) — off the 1d grid
OFF = write_cache("kline3_1d_OFFUSDT", frame(0.0, pd.date_range("2024-01-01 16:00", "2024-02-10 16:00", freq="1D")))


def window(flip_mask, n):
    """n consecutive bar labels around the LAST flip of `flip_mask` (bool Series on IDX)."""
    flips = [k for k in np.flatnonzero(flip_mask.to_numpy()) if n // 2 <= k <= len(IDX) - n + n // 2]
    k = int(flips[-1])
    return [IDX[i].isoformat() for i in range(k - n // 2, k - n // 2 + n)]


_a = FRAMES["SYNUSDT"]["Close"]
_sig_a = (_a.rolling(5).mean() > _a.rolling(20).mean()).astype(float)
WIN_A = window(_sig_a != _sig_a.shift(1), 8)                       # the sample's SMA 5/20
_mom = pd.DataFrame({s: f["Close"].pct_change(6) for s, f in FRAMES.items()})
_lead = _mom.fillna(-1e9).idxmax(axis=1)   # all-NaN warm-up rows would raise in pandas 3
WIN_C = window(_lead != _lead.shift(1), 5)                         # the sample's momentum top-1
BAD_A, BAD_C, BAD_75 = WIN_A[4], WIN_C[2], WIN_C[1]


def replay(*args):
    r = subprocess.run([sys.executable, REPLAY, *args], cwd=ROOT, capture_output=True, text=True)
    return r.returncode, r.stdout + r.stderr


def rows(out, fn="parity.tsv"):
    with open(os.path.join(out, fn), encoding="utf-8") as f:
        return [line.rstrip("\n").split("\t") for line in f][1:]


def bare(cell):   # value column without the @close / @bar_at suffix
    return cell.split("@")[0]


# a lib copy whose save_state corrupts the signal on ONE bar — what the tool exists to catch —
# and exits 75 without writing on another (what the runner will do once it has the gate)
MUT = os.path.join(T, "mut")
for d in ("lib", "manager"):
    shutil.copytree(os.path.join(ROOT, d), os.path.join(MUT, d), ignore=shutil.ignore_patterns("__pycache__"))
with open(os.path.join(MUT, "lib", "execute.py"), "a", encoding="utf-8") as f:
    f.write(f"""

_parity_save = save_state


def save_state(strategy_name, state):
    bar = os.environ.get('BLAVE_EXPECTED_BAR')
    if bar == {BAD_75!r} and 'weights' in state:
        raise SystemExit(75)
    if bar == {BAD_A!r} and 'position' in state:
        state['position'] = 1.0 - float(state['position'])
    if bar == {BAD_C!r} and 'weights' in state:
        state['weights'] = {{k: 0.0 for k in state['weights']}}
    _parity_save(strategy_name, state)
""")

CACHE_A = ["--cache", CACHE["SYNUSDT"]]
CACHE_C = CACHE_A + ["--cache", CACHE["SYN2USDT"]]
A_ARGS = ["--sample", "a_sma", "--sample-arg", "symbol=SYNUSDT", "--sample-arg", "interval=1h",
          "--sample-arg", "start=2024-01-01", "--sample-arg", "fast=5", "--sample-arg", "slow=20",
          "--bars", f"{WIN_A[0]}..{WIN_A[-1]}"]
C_ARGS = ["--sample", "c_mom", "--sample-arg", "symbols=SYNUSDT,SYN2USDT", "--sample-arg", "interval=1h",
          "--sample-arg", "start=2024-01-01", "--sample-arg", "fast=6", "--sample-arg", "rebalance=bar",
          "--bars", f"{WIN_C[0]}..{WIN_C[-1]}"]

# ── 1. Type A parity, same lib ────────────────────────────────────────────────
out = os.path.join(T, "a_same")
rc, log = replay(*A_ARGS, *CACHE_A, "--old-lib", ROOT, "--new-lib", ROOT, "--out", out)
rs = rows(out)
check(rc == 0, f"Type A same lib → exit 0 (got {rc})\n{log if rc else ''}")
check(len(rs) == 8 and all(r[6] == "yes" for r in rs) and all(r[1] == r[2] == "0" for r in rs),
      "Type A: 8 bars, every bar identical, both ticks exit 0")
check(len({bare(r[4]) for r in rs}) > 1, f"Type A: the position flipped inside the window ({[bare(r[4]) for r in rs]})")
log_path = os.path.join(out, "old", "strategies", "sp_a_sma_synusdt_1h", "strategy.log")
closes = [float(m) for m in re.findall(r"signal=\S+ close=(\S+)", open(log_path, encoding="utf-8").read())]
want = [float(FRAMES["SYNUSDT"].loc[r[0], "Close"]) for r in rs]
check(closes == want, "Type A: the close the runner saw on each bar is the cache's close AT that bar "
                      "(cut pinned to the expected bar)")
check(all(r[4].endswith("@" + repr(c)) for r, c in zip(rs, want)), "Type A: the tick's close is part of the compared surface")
tick_log = open(os.path.join(out, "logs", "new", rs[0][0].replace(":", "") + ".log"), encoding="utf-8").read()
check("network blocked" not in tick_log and "Traceback" not in tick_log, "Type A: the tick ran clean (no fetch attempted)")

# ── 2. Type A, one bar corrupted on the new side ──────────────────────────────
out = os.path.join(T, "a_mut")
rc, log = replay(*A_ARGS, *CACHE_A, "--old-lib", ROOT, "--new-lib", MUT, "--out", out)
ds = rows(out, "diffs.tsv")
check(rc == 1, f"Type A corrupted bar → exit 1 (got {rc})")
check([d[0] for d in ds] == [BAD_A] and ds and bare(ds[0][4]) != bare(ds[0][5]),
      f"Type A: exactly the corrupted bar is reported ({[(d[0], d[4], d[5]) for d in ds]})")

# ── 3. Type C parity (weights + bar_at), one corrupted bar, one not-ready bar ─
out = os.path.join(T, "c_same")
rc, log = replay(*C_ARGS, *CACHE_C, "--old-lib", ROOT, "--new-lib", ROOT, "--out", out)
rs = rows(out)
check(rc == 0, f"Type C same lib → exit 0 (got {rc})\n{log if rc else ''}")
check(len(rs) == 5 and all(r[3] == "weights" and r[6] == "yes" for r in rs),
      "Type C: 5 bars compared on weights, all identical")
check(len({bare(r[4]) for r in rs}) > 1, f"Type C: the weights changed inside the window ({[bare(r[4]) for r in rs]})")
check(all(re.search(r"@\d+$", r[4]) for r in rs), "Type C: bar_at is part of the compared surface")
out = os.path.join(T, "c_mut")
rc, log = replay(*C_ARGS, *CACHE_C, "--old-lib", ROOT, "--new-lib", MUT, "--out", out)
ds, rs = rows(out, "diffs.tsv"), rows(out)
check(rc == 1 and [d[0] for d in ds] == [BAD_C],
      f"Type C corrupted bar → exit 1, exactly that bar ({rc}, {[d[0] for d in ds]})")
r75 = next(r for r in rs if r[0] == BAD_75)
check(r75[2] == "75" and r75[6] == "n/a" and r75[9] == "new not ready (not a signal difference)",
      f"Type C: new side exiting 75 without writing is 'not ready', not a difference ({r75[2], r75[6], r75[9]})")

# ── 4. probe through the git-archive path: isolation, network block, events base ──
PROBE = os.path.join(T, "probe", "sp_probe")
os.makedirs(PROBE)
with open(os.path.join(PROBE, "strategy.py"), "w", encoding="utf-8") as f:
    f.write('''import os, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))
STRATEGY_NAME = "sp_probe"
INTERVAL      = "1h"
if __name__ == '__main__':
    import lib.data, requests
    ws = os.getcwd()
    own_lib = os.path.abspath(lib.data.__file__).startswith(ws + os.sep)
    try:
        requests.get("https://api.blave.org/kline", timeout=5)
        blocked = False
    except RuntimeError:
        blocked = True
    except Exception:
        blocked = False
    real = os.path.realpath(ws)
    base = all(os.path.realpath(os.environ.get(k, "")) == real for k in ("BLAVE_AGENT_BASE", "BLAVE_AGENT_HOME"))
    open("probe.txt", "w").write(f"{own_lib} {blocked} {base}")
''')
have_git = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True).returncode == 0
old = ["--old-ref", "HEAD"] if have_git else ["--old-lib", ROOT]
out = os.path.join(T, "probe_out")
rc, log = replay("--strategy", PROBE, *CACHE_A, "--bars", f"{WIN_A[0]}..{WIN_A[0]}", *old,
                 "--new-lib", ROOT, "--out", out, "--python", sys.executable)
probes = {side: open(os.path.join(out, side, "probe.txt")).read() if os.path.exists(os.path.join(out, side, "probe.txt")) else None
          for side in ("old", "new")}
check(probes == {"old": "True True True", "new": "True True True"},
      f"probe ({'git archive' if have_git else 'dir'} old side): own lib, requests blocked, BLAVE_AGENT_BASE/HOME in ws ({probes})")
rs = rows(out)
check(rc == 1 and rs and rs[0][6] == "NO" and rs[0][9] == "no state written (both)",
      f"probe wrote no state.json → not identical, exit 1 ({rc}, {rs[0][6] if rs else None}, {rs[0][9] if rs else None})")

# ── 5. crash → exit 2; off-grid labels under --all-slots → refused (3) ────────
CRASH = os.path.join(T, "crash", "sp_crash")
os.makedirs(CRASH)
with open(os.path.join(CRASH, "strategy.py"), "w", encoding="utf-8") as f:
    f.write('STRATEGY_NAME = "sp_crash"\nINTERVAL = "1h"\nif __name__ == "__main__":\n    raise RuntimeError("boom")\n')
rc, log = replay("--strategy", CRASH, *CACHE_A, "--bars", f"{WIN_A[0]}..{WIN_A[0]}", "--old-lib", ROOT,
                 "--new-lib", ROOT, "--out", os.path.join(T, "crash_out"))
check(rc == 2, f"crashing strategy → exit 2 (got {rc})")
rc, log = replay("--sample", "a_sma", "--sample-arg", "symbol=OFFUSDT", "--sample-arg", "interval=1d",
                 "--sample-arg", "start=2024-01-01", "--cache", OFF, "--bars", "2024-02-01T00:00..2024-02-05T00:00",
                 "--all-slots", "--old-lib", ROOT, "--new-lib", ROOT, "--out", os.path.join(T, "off_out"))
check(rc == 3 and "off the 1d grid" in log, f"--all-slots on 16:00-labelled daily data is refused with exit 3 (got {rc})")
rc, log = replay("--strategy", CRASH)   # usage error: no --cache
check(rc == 3, f"usage error exits 3, never 2 (got {rc})")

shutil.rmtree(T, ignore_errors=True)
print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
