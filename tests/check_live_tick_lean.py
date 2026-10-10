"""Minimal check: a live tick writes state.json and nothing else; a performance refresh
(BLAVE_STATS_REFRESH=1 on a live run) rewrites stats.json without minting, without touching
Generated At and without writing state.json (0.1.21 資源優化案 A; spec
.claude/output/backend/live-tick-cpu-spec-2026-10-10.md §1–2). Drives the real lib/runner.run()
in a temp workspace, no network — Type A and Type C each:

  1. backtest → stats.json + v1
  2. live tick → stats.json byte-identical, state.json written, no v2
  3. refresh on longer data → stats.json rewritten (`end` advanced), Generated At and the MCPT
     keys carried, versions/index.json byte-identical, state.json byte-identical, no pnl.png
  4. stats.json removed (what restore() does) → live tick writes nothing; refresh writes nothing
     and says so

Run: cd blave-agent && MPLBACKEND=Agg .venv/bin/python tests/check_live_tick_lean.py
"""
import contextlib
import io
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("MPLBACKEND", "Agg")

import numpy as np
import pandas as pd

import lib.runner as runner
import lib.strategy as strategy

runner.dotenv_values = lambda *a, **k: {}   # never read the workspace .env

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


WS = Path(tempfile.mkdtemp(prefix="live-lean-"))
os.chdir(WS)                    # load_state/save_state are cwd-relative
runner._REPO_ROOT = WS          # stats.json / pnl.png
strategy._REPO_ROOT = WS        # versions/ (lib.strategy.versions_dir)


def run(config, fetch, compute, mode, refresh=False):
    for k in ("BLAVE_MODE", runner.STATS_REFRESH_ENV):
        os.environ.pop(k, None)
    os.environ["BLAVE_MODE"] = mode
    if refresh:
        os.environ[runner.STATS_REFRESH_ENV] = "1"
    try:
        with contextlib.redirect_stdout(io.StringIO()) as out:
            runner.run(config, fetch, compute)
        return out.getvalue()
    finally:
        for k in ("BLAVE_MODE", runner.STATS_REFRESH_ENV):
            os.environ.pop(k, None)


def rb(p):
    return p.read_bytes() if p.exists() else None


def scenario(label, name, config, fetch_short, fetch_long, compute):
    d = WS / "strategies" / name
    stats, state, vdir, pnl = d / "stats.json", d / "state.json", d / "versions", d / "pnl.png"
    run(config, fetch_short, compute, "backtest")
    check(stats.exists() and (vdir / "v1.json").exists() and not state.exists(),
          f"{label}: backtest writes stats.json + v1, no state.json")
    doc = json.loads(stats.read_text())
    doc["MCPT p-value"] = 0.0123   # a carried key, planted so the carry-over is observable on Type C too
    stats.write_text(json.dumps(doc))
    gen_at, stats0, idx0, pnl0 = doc["Generated At"], rb(stats), rb(vdir / "index.json"), rb(pnl)

    run(config, fetch_long, compute, "live")
    check(rb(stats) == stats0, f"{label}: live tick leaves stats.json byte-identical")
    check(state.exists(), f"{label}: live tick writes state.json")
    check(not (vdir / "v2.json").exists() and rb(vdir / "index.json") == idx0,
          f"{label}: live tick mints nothing")
    state0 = rb(state)

    out = run(config, fetch_long, compute, "live", refresh=True)
    new = json.loads(stats.read_text())
    check(rb(stats) != stats0 and new["end"] > doc["end"],
          f"{label}: refresh rewrites stats.json on the longer data (end {doc['end']} → {new['end']})")
    check(new["Generated At"] == gen_at and new.get("MCPT p-value") == 0.0123,
          f"{label}: refresh carries Generated At and the MCPT keys over")
    check(rb(vdir / "index.json") == idx0 and not (vdir / "v2.json").exists(),
          f"{label}: refresh mints nothing, index untouched")
    check(rb(state) == state0, f"{label}: refresh does not write state.json")
    check(rb(pnl) == pnl0, f"{label}: refresh does not redraw pnl.png (quiet)")
    check("discarded" not in out, f"{label}: refresh not discarded")

    stats.unlink()
    run(config, fetch_long, compute, "live")
    check(not stats.exists(), f"{label}: no stats.json → live tick does not recreate it")
    out = run(config, fetch_long, compute, "live", refresh=True)
    check(not stats.exists() and "No stats.json to refresh" in out,
          f"{label}: no stats.json → refresh writes nothing and says to backtest first")


# ── Type A ────────────────────────────────────────────────────────────────────
def frame(n):
    idx = pd.date_range("2024-01-01", periods=n, freq="h")
    close = pd.Series(100 + np.cumsum(np.sin(np.arange(n) / 7.0)), index=idx)
    return pd.DataFrame({"Open": close, "High": close * 1.001, "Low": close * 0.999,
                         "Close": close, "Volume": 1.0}, index=idx)


A_SRC = WS / "strategies" / "lean_a" / "strategy.py"
A_SRC.parent.mkdir(parents=True)
A_SRC.write_text("# lean a\n")
A_CFG = {"STRATEGY_NAME": "lean_a", "SYMBOL": "BTCUSDT", "INTERVAL": "1h", "START": "2024-01-01",
         "FEE": 0.0005, "MCPT": False, "__file__": str(A_SRC)}
scenario("Type A", "lean_a", A_CFG, lambda h: frame(400), lambda h: frame(500),
         lambda d: pd.Series(np.where(np.arange(len(d)) % 40 < 20, 1.0, 0.0), index=d.index))

# ── Type C ────────────────────────────────────────────────────────────────────
rng = np.random.default_rng(9)
IDX = pd.bdate_range("2023-01-02", periods=600)
CLOSE = pd.DataFrame(100 * np.exp(np.cumsum(rng.normal(0.0003, 0.012, (600, 3)), axis=0)),
                     index=IDX, columns=list("ABC"))


def c_fetch(n):
    return lambda h: CLOSE.iloc[:n].copy()


def c_compute(c):
    w = np.zeros(c.shape)
    w[np.arange(len(c)) % 60 < 30, 0] = 0.5
    w[np.arange(len(c)) % 60 >= 30, 1] = 0.5
    return w, pd.concat({"close": c, "open": c}, axis=1)


C_SRC = WS / "strategies" / "lean_c" / "strategy.py"
C_SRC.parent.mkdir(parents=True)
C_SRC.write_text("# lean c\n")
C_CFG = {"STRATEGY_NAME": "lean_c", "INTERVAL": "1d", "START": "2023-01-02", "FEE": 0.001,
         "__file__": str(C_SRC)}
scenario("Type C", "lean_c", C_CFG, c_fetch(500), c_fetch(600), c_compute)

# ── the runner has exactly one place that stamps Generated At per branch, and it is backtest-only ──
src = Path(runner.__file__).read_text(encoding="utf-8")
check(src.count("stats[GENERATED_AT_KEY] = int(time.time())") == 1
      and src.count("carried[GENERATED_AT_KEY] = int(time.time())") == 1
      and "setdefault(GENERATED_AT_KEY" not in src,
      "Generated At is stamped only under `if mode == 'backtest'` (no setdefault left)")

os.chdir(ROOT)
print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
