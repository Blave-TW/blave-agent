"""A rejection that comes back every round (paper cash short — paper e2e batch 2, 10-18: five
"⚠️ Order failed" in 2m16s) is notified once per symbol and reason per cooldown, on the
Telegram sender and the log-only one alike (both are send_telegram_fn here); the error log
line likewise. order_errors.json still records every round (the pages read its newest row as
"failing now"). A fill on that symbol, or a different reason, makes the next failure news
again. Real rounds on paper: reconcile → manager/reconciler.place_order → order_paper.

Run: cd blave-agent && .venv/bin/python tests/check_order_error_throttle.py
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
WS = Path(tempfile.mkdtemp(prefix="order-err-throttle-", dir=os.environ.get("SCRATCHPAD") or None))
sys.path.insert(0, ROOT)
os.chdir(WS)
os.symlink(os.path.join(ROOT, "lib"), WS / "lib")   # venue_wiring finds lib/order_paper.py from the cwd
for d in ("state", "manager", "strategies/tw_c"):
    (WS / d).mkdir(parents=True, exist_ok=True)
(WS / ".env").write_text("PAPER_API_KEY=paper\nPAPER_SECRET_KEY=paper\nPAPER_BOUND_TS=1\n"
                         "PAPER_INITIAL_EQUITY=1000\n")
json.dump({"rates": {"TWD": 32.0}, "ts": int(time.time())}, open("state/paper_fx.json", "w"))
(WS / "strategies/tw_c/strategy.py").write_text('MARKET = "spot"\n')
json.dump({"type": "portfolio", "market": "spot", "weights": {"2330": 1.0}}, open("strategies/tw_c/state.json", "w"))


def config(amount):
    json.dump({"amounts": {"tw_c": amount}, "exchanges": {"tw_c": "paper"}, "asset_specs": {}},
              open("manager/portfolio_config.json", "w"))


socket.socket.connect = lambda *a, **k: (_ for _ in ()).throw(OSError("offline test"))
import pandas as pd  # noqa: E402
import lib.data as data  # noqa: E402

data.fetch_twstock_price = lambda code, *a: pd.DataFrame({"Close": [2420.0]}, index=pd.to_datetime(["2026-10-16"]))
from lib import order_paper, paper_data, portfolio, venue_wiring  # noqa: E402

ENV = venue_wiring.read_env()

paper_data.tw_session_open = lambda env=None, now=None: True
order_paper.tw_session_open = paper_data.tw_session_open
from manager import reconciler as rec  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


sent = []


def round_():
    buf = io.StringIO()
    h = logging.StreamHandler(buf)
    root = logging.getLogger()
    root.addHandler(h)
    root.setLevel(logging.INFO)
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            portfolio.reconcile(rec._get_positions_guarded, rec.place_order, threshold=rec.THRESHOLD,
                                send_telegram_fn=sent.append)
    finally:
        root.removeHandler(h)
    return [ln for ln in buf.getvalue().splitlines() if "order error 2330" in ln]


def errors():
    try:
        return json.load(open("manager/order_errors.json"))
    except OSError:
        return []


config(2_000_000)   # 62,500 USD of 2330 against 1,000 USD of paper cash
for _ in range(2):   # the first round may only write the own-positions baseline
    round_()
logs = [round_() for _ in range(5)]
fails_sent = [x for x in sent if "Order failed" in x]
check(len(fails_sent) == 1 and "insufficient paper cash" in fails_sent[0],
      f"same symbol, same reason, 5+ rounds: one notice ({len(fails_sent)}: {fails_sent[:2]})")
check(sum(len(x) for x in logs) <= 1, f"…and one error log line at most ({logs})")
n_err = len([e for e in errors() if e.get("symbol") == "2330@spot"])
check(n_err >= 5, f"order_errors.json still gets every round ({n_err} rows, capped at 5)")
check(not order_paper.get_spot_balances(ENV).get("2330"),
      "nothing bought (the venue refused it)")

portfolio.ORDER_ERROR_NOTIFY_COOLDOWN_S, keep = 0, portfolio.ORDER_ERROR_NOTIFY_COOLDOWN_S
round_()
portfolio.ORDER_ERROR_NOTIFY_COOLDOWN_S = keep
check(len([x for x in sent if "Order failed" in x]) == 2, "after the cooldown: notified again")

check(portfolio._order_error_fresh("X", RuntimeError("insufficient paper cash (60908 < 103336)"))
      and not portfolio._order_error_fresh("X", RuntimeError("insufficient paper cash (60911 < 103402)"))
      and portfolio._order_error_fresh("X", RuntimeError("below minimum size")),
      "the reason ignores the moving numbers; a different reason is news at once")

config(20_000)   # within cash: fills
round_()
check(order_paper.get_spot_balances(ENV).get("2330", 0) > 0 and "2330@spot" not in portfolio._order_error_notified,
      "a fill on the symbol clears it")
config(2_000_000)
n = len(sent)
round_()
check(len([x for x in sent[n:] if "Order failed" in x]) == 1, "so the next failure is notified at once")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
