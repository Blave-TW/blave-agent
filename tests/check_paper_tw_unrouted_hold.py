"""A swap TW stock Type A on paper holds `2330@spot`; when its route goes blank ("" — the
member is kept, no venue for now) the reconciler must hold that key as is, not sell it down
to the routed strategies' target (paper e2e batch 2 B3: tw_a 2,100,000 + tw_c 1,000,000 at
weight 0.4, tw_a routed "" → the next round sold 867 shares, logging "2330 held as is").
Real rounds: reconcile → manager/reconciler.place_order → lib.execute → venue_wiring →
order_paper; prices stubbed, offline.

Run: cd blave-agent && .venv/bin/python tests/check_paper_tw_unrouted_hold.py
"""
import contextlib
import io
import json
import logging
import os
import socket
import sys
import tempfile
import time
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WS = Path(tempfile.mkdtemp(prefix="tw-unrouted-", dir=os.environ.get("SCRATCHPAD") or None))
sys.path.insert(0, ROOT)
os.chdir(WS)
os.symlink(os.path.join(ROOT, "lib"), WS / "lib")   # venue_wiring finds lib/order_paper.py from the cwd
for d in ("state", "manager", "strategies/tw_a", "strategies/tw_c"):
    (WS / d).mkdir(parents=True, exist_ok=True)
(WS / ".env").write_text("PAPER_API_KEY=paper\nPAPER_SECRET_KEY=paper\nPAPER_BOUND_TS=1\n"
                         "PAPER_INITIAL_EQUITY=200000\n")
json.dump({"rates": {"TWD": 32.0}, "ts": int(time.time())}, open("state/paper_fx.json", "w"))
(WS / "strategies/tw_a/strategy.py").write_text('SYMBOL = "2330"\nMARKET = "swap"\n')
(WS / "strategies/tw_c/strategy.py").write_text('MARKET = "spot"\n')
json.dump({"symbol": "2330", "position": 1.0}, open("strategies/tw_a/state.json", "w"))
json.dump({"type": "portfolio", "market": "spot", "weights": {"2330": 0.4}}, open("strategies/tw_c/state.json", "w"))


def config(route_a):
    json.dump({"amounts": {"tw_a": 2_100_000, "tw_c": 1_000_000}, "exchanges": {"tw_a": route_a, "tw_c": "paper"},
               "asset_specs": {}}, open("manager/portfolio_config.json", "w"))


socket.socket.connect = lambda *a, **k: (_ for _ in ()).throw(OSError("offline test"))
import pandas as pd  # noqa: E402
import lib.data as data  # noqa: E402

data.fetch_twstock_price = lambda code, *a: pd.DataFrame({"Close": [2420.0]}, index=pd.to_datetime(["2026-10-16"]))
from lib import order_paper, paper_data, portfolio, venue_wiring  # noqa: E402

paper_data.tw_session_open = lambda env=None, now=None: True
order_paper.tw_session_open = paper_data.tw_session_open
from manager import reconciler as rec  # noqa: E402

ENV = venue_wiring.read_env()
fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


def round_():
    buf = io.StringIO()
    h = logging.StreamHandler(buf)
    logging.getLogger().addHandler(h)
    logging.getLogger().setLevel(logging.INFO)
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            portfolio.reconcile(rec._get_positions_guarded, rec.place_order, threshold=rec.THRESHOLD)
    finally:
        logging.getLogger().removeHandler(h)
    return buf.getvalue()


def shares():
    return order_paper.get_spot_balances(ENV).get("2330", 0.0)


def fills():
    return [f for f in order_paper.snapshot(ENV)["fills"] if f.get("symbol") == "2330"]


config("paper")
for _ in range(3):
    round_()
check(shares() == 1033, f"both routed to paper: 2,500,000 at 2420 = 1033 shares of 2330@spot ({shares()})")
n0 = len(fills())
config("")
log = round_() + round_()
check(shares() == 1033 and len(fills()) == n0,
      f"tw_a routed \"\": 0 orders, all 1033 shares held ({shares()}, {len(fills()) - n0} new fills)")
held = [ln for ln in log.splitlines() if "held as is" in ln]
check(held and all("— 2330@spot held as is" in ln for ln in held), f"the log names the key actually held ({held[:1]})")
t = portfolio.aggregate_portfolio()
check(t.get("2330@spot", {}).get("gated") is True and t["2330@spot"].get("unrouted") == ["tw_a"],
      f"target row 2330@spot gated + unrouted tw_a ({t.get('2330@spot')})")
config("paper")
round_()
check(shares() == 1033 and len(fills()) == n0, "routed again: same target, still no order")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
