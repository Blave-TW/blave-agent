"""Minimal check: the two TW reference examples attach their flow data with align_feed.

On daily bars, the numbers must match the old join (reindex + fillna(0)) exactly, because a
flow published on day D (20:00 / next day 00:00) is known by bar D's close (D+1 00:00). Live,
a day whose row has not landed must raise FeedNotPublished instead of reusing the previous
day's value. Both examples must pass the runner's look-ahead check. No network: the lib.data
fetchers are stubbed with synthetic data (with a stock that has no flow data and a hole day).

Run: cd blave-agent && MPLBACKEND=Agg .venv/bin/python tests/check_examples_align_feed.py
"""
import contextlib
import importlib.util
import io
import os
import sys
import tempfile
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("MPLBACKEND", "Agg")

import numpy as np
import pandas as pd

import lib.data as D
import lib.runner as runner

runner.dotenv_values = lambda *a, **k: {}   # never read the workspace .env

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


def load(rel):
    spec = importlib.util.spec_from_file_location(rel.split("/")[1], os.path.join(ROOT, rel))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


TW100 = load("examples/tw100_foreign_zscore/strategy.py")
TW2317 = load("examples/tw2317_broker_zscore/strategy.py")

rng = np.random.default_rng(21)
DAYS = pd.bdate_range("2022-01-03", "2023-12-29")
HOLE = DAYS[300]                                   # a day the flow source has no row for
IDS = TW100.UNIVERSE[:12]


def price(n=len(DAYS)):
    c = 100 * np.exp(np.cumsum(rng.normal(0, 0.01, n)))
    return pd.DataFrame({"Open": c * (1 + rng.normal(0, 0.002, n)), "Close": c}, index=DAYS)


PRICES = {sid: price() for sid in IDS}
INST = {sid: pd.DataFrame({"foreign_net": rng.normal(0, 1000, len(DAYS)).round(-2)}, index=DAYS).drop(HOLE)
        for sid in IDS[:-2]}                      # the last two stocks have no flow data at all
BRANCH = pd.DataFrame(rng.normal(0, 50, (len(DAYS), 30)).round(), index=DAYS,
                      columns=[f"B{i}" for i in range(30)]).drop(HOLE)
BRANCH_PRICE = price()


def stub(inst=INST, branch=BRANCH):
    D.fetch_twstock_price_adj_batch = lambda ids, s, e, h: {k: v.copy() for k, v in
                                                             {**PRICES, "2317": BRANCH_PRICE}.items() if k in ids}
    D.fetch_twstock_institutional_batch = lambda ids, s, e, h: {k: v.copy() for k, v in inst.items() if k in ids}
    D.fetch_twstock_branch_daily_net = lambda sid, s, e, h, **k: branch.copy()


stub()
TW100.UNIVERSE = IDS
q = io.StringIO()

# ── identical daily-bar numbers vs the old join ─────────────────────────────────────
with contextlib.redirect_stdout(q):
    new = TW100.fetch_data({})
close, opn = pd.DataFrame({k: v["Close"] for k, v in PRICES.items()}), pd.DataFrame({k: v["Open"] for k, v in PRICES.items()})
old_foreign = pd.DataFrame({k: v["foreign_net"] for k, v in INST.items()}).reindex(close.index).fillna(0)
w_new, _ = TW100.compute_signals(new)
w_old, _ = TW100.compute_signals((close, opn, old_foreign))
check(new[0].index.equals(close.index) and np.array_equal(w_new, w_old),
      f"tw100_foreign_zscore: same bars and identical weights as the old reindex+fillna join "
      f"({int(np.count_nonzero(w_new))} nonzero weight cells)")

with contextlib.redirect_stdout(q):
    df_new = TW2317.fetch_data({})
old_df = BRANCH_PRICE.copy()
old_df.attrs["branch_df"] = BRANCH
s_new, s_old = TW2317.compute_signals(df_new), TW2317.compute_signals(old_df)
check(df_new.index.equals(old_df.index) and s_new.equals(s_old),
      f"tw2317_broker_zscore: same bars and identical signals as the old reindex join "
      f"({int((s_new == 1).sum())} long bars)")

# ── live gate: the last day's flow row has not landed ─────────────────────────────────
stub(inst={k: v.drop(DAYS[-1]) for k, v in INST.items()}, branch=BRANCH.drop(DAYS[-1]))
for name, mod in (("tw100_foreign_zscore", TW100), ("tw2317_broker_zscore", TW2317)):
    try:
        with D.live_feeds(), contextlib.redirect_stdout(q):
            mod.fetch_data({})
        check(False, f"{name}: live tick with today's flow missing must raise FeedNotPublished")
    except D.FeedNotPublished as e:
        check(e.need.date() == DAYS[-1].date(), f"{name}: live → FeedNotPublished for {e.need.date()}")
    with contextlib.redirect_stdout(q):
        got = mod.fetch_data({})
    idx = got[0].index if isinstance(got, tuple) else got.index
    check(idx[-1] == DAYS[-2], f"{name}: backtest cuts the unpublished last day instead")
stub()

# ── both pass the runner's look-ahead check ──────────────────────────────────────────
WS = Path(tempfile.mkdtemp(prefix="examples-feed-", dir=os.environ.get("SCRATCHPAD") or None))
os.chdir(WS)
runner._REPO_ROOT = WS
os.environ["BLAVE_MODE"] = "backtest"
for name, mod in (("tw100_foreign_zscore", TW100), ("tw2317_broker_zscore", TW2317)):
    cfg = {k: v for k, v in vars(mod).items() if k.isupper()}
    cfg.update({"STRATEGY_NAME": name, "MCPT": False})
    out, refused = io.StringIO(), None
    with contextlib.redirect_stdout(out):
        try:
            runner.run(cfg, mod.fetch_data, mod.compute_signals)
        except SystemExit as e:
            refused = str(e)
    check(refused is None and "Look-ahead check: passed" in out.getvalue()
          and "fetch_data + compute_signals" in out.getvalue(),
          f"{name}: backtest passes the look-ahead check (feeds replayed by publication time)"
          + (f" — {refused}" if refused else ""))

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
