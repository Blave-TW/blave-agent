"""An order the venue took whose outcome is unknown (an order lib's OrderNotConfirmed carrying
venue / symbol / order id) is parked, not reported as a rejection and not sent again — no network.

What it protects (live 2026-10-24, Binance BTCUSDT): the confirm poll answered -2013 for an order
that had filled; reconcile recorded a P1 交易所拒單, and under self_ledger the fill was not in the
book, so the next round would have bought it a second time.

Asserts (real rounds on paper: reconcile → manager/reconciler.place_order, the order call wrapped):
- the failing round writes an order_errors row with kind order_unconfirmed and the strategy names,
  parks the order, and sends the "outcome unknown" notice — not "Order failed";
- while the query has no answer the symbol gets no order at all (no resend), and no HALT;
- an hour on, ONE stuck row, never a second;
- the query answers FILLED → the fill is booked from the venue's numbers, the park is cleared,
  and the round sends nothing (the book already holds it);
- resolve(symbol, 0) from the agent releases it and the next round trades again;
- a second unknown on the same symbol right after is a new row (no 1-hour throttle);
- a plain rejection carries the strategy names, no kind, nothing parked;
- an unreadable park file → nothing is sent that round.

Run: cd blave-agent && .venv/bin/python tests/check_reconcile_unconfirmed.py
"""
import contextlib
import io
import json
import os
import socket
import sys
import tempfile
import time
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WS = Path(tempfile.mkdtemp(prefix="reconcile-unconfirmed-", dir=os.environ.get("SCRATCHPAD") or None))
sys.path.insert(0, ROOT)
os.chdir(WS)
os.symlink(os.path.join(ROOT, "lib"), WS / "lib")
for d in ("state", "manager", "strategies/tw_c"):
    (WS / d).mkdir(parents=True, exist_ok=True)
(WS / ".env").write_text("PAPER_API_KEY=paper\nPAPER_SECRET_KEY=paper\nPAPER_BOUND_TS=1\n"
                         "PAPER_INITIAL_EQUITY=1000\n")
json.dump({"rates": {"TWD": 32.0}, "ts": int(time.time())}, open("state/paper_fx.json", "w"))
(WS / "strategies/tw_c/strategy.py").write_text('MARKET = "spot"\n')
json.dump({"type": "portfolio", "market": "spot", "weights": {"2330": 1.0}},
          open("strategies/tw_c/state.json", "w"))
json.dump({"amounts": {"tw_c": 16_000}, "exchanges": {"tw_c": "paper"}, "asset_specs": {}},
          open("manager/portfolio_config.json", "w"))

socket.socket.connect = lambda *a, **k: (_ for _ in ()).throw(OSError("offline test"))
import pandas as pd  # noqa: E402
import lib.data as data  # noqa: E402

data.fetch_twstock_price = lambda code, *a: pd.DataFrame({"Close": [2420.0]}, index=pd.to_datetime(["2026-10-16"]))
from lib import guard, order_paper, paper_data, unconfirmed, portfolio, venue_wiring  # noqa: E402

paper_data.tw_session_open = lambda env=None, now=None: True
order_paper.tw_session_open = paper_data.tw_session_open
from manager import reconciler as rec  # noqa: E402

KEY = "2330@spot"
fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


class NotConfirmed(unconfirmed.OrderOutcomeUnknown):
    pass


def unknown(oid=None, cid=None):
    return NotConfirmed(f"order {oid or cid} sent, no answer", venue="paper", venue_symbol="2330",
                        order_id=oid, client_order_id=cid)


MODE = {"raise": None}
CALLS = []
ANSWER = {"res": None, "boom": False}
sent = []


def place(symbol, signed_diff, asset_spec=None, reduce_only=False, exchange=None, contributors=None):
    CALLS.append((symbol, signed_diff, reduce_only))
    if MODE["raise"] is not None:
        raise MODE["raise"]
    return rec.place_order(symbol, signed_diff, asset_spec=asset_spec, reduce_only=reduce_only,
                           exchange=exchange, contributors=contributors)


def query(entry):
    if ANSWER["boom"]:
        raise ValueError("bad parked row")
    return ANSWER["res"]


venue_wiring.query_parked_order = query


def amount(x):
    json.dump({"amounts": {"tw_c": x}, "exchanges": {"tw_c": "paper"}, "asset_specs": {}},
              open("manager/portfolio_config.json", "w"))


def round_():
    del CALLS[:]
    with contextlib.redirect_stdout(io.StringIO()):
        portfolio.reconcile(rec._get_positions_guarded, place, threshold=rec.THRESHOLD,
                            send_telegram_fn=sent.append)
    return len(CALLS)


def rows(kind=None):
    try:
        out = json.load(open("manager/order_errors.json"))
    except OSError:
        return []
    return [r for r in out if kind is None or r.get("kind") == kind]


def parked():
    return unconfirmed.load()


def booked():
    try:
        return [json.loads(x) for x in open("manager/orders.jsonl") if "unconfirmed_park_id" in x]
    except OSError:
        return []


def book_cost():
    return float((portfolio.ledger_positions().get(KEY) or {}).get("size") or 0)


def marker():
    return os.path.isdir("state/execution/inflight") and any(
        f.endswith(".json") for f in os.listdir("state/execution/inflight"))


for _ in range(2):   # the first rounds may only write the own-positions baseline
    if round_():
        break
amount(0)
round_()
amount(16_000)

# ── an entry whose outcome is unknown: parked, not 拒單, never sent again ─────
MODE["raise"] = unknown("X1")
n = round_()
u = rows("order_unconfirmed")
check(n == 1, f"the failing round sends the order once ({n})")
check(len(u) == 1 and u[0].get("symbol") == KEY and u[0].get("strategies") == ["tw_c"],
      f"order_errors row: kind order_unconfirmed, strategies [tw_c] ({rows()[-1:]})")
check(parked().get("X1", {}).get("key") == KEY, "parked under its order id")
note = [x for x in sent if "下單結果不明" in x]
check(len(note) == 1 and "策略 tw_c 的 " in note[0] and "不要手動補單" in note[0] and "🚨" in note[0]
      and not any("Order failed" in x for x in sent), f"machine notice is the canon 🚨 copy ({sent[-1:]})")
check(not guard.halted(), "no HALT")
n = round_()
check(n == 0, f"query has no answer: no resend ({n})")
check(parked()["X1"]["reads"] == 1 and not any(r.get("stuck") for r in rows("order_unconfirmed")),
      "still parked, read counted, no reminder yet")
unconfirmed.update("X1", parked_at=time.time() - 3700)
round_()
round_()
check(len([r for r in rows("order_unconfirmed") if r.get("stuck")]) == 1, "an hour on: one reminder")
unconfirmed.update("X1", reminded_at=time.time() - 86_500)
round_()
round_()
check(len([r for r in rows("order_unconfirmed") if r.get("stuck")]) == 2, "a day later: one more, not one per round")
check(not guard.halted(), "still no HALT")

ANSWER["boom"] = True
try:
    n = round_()
    check(n == 0 and "X1" in parked(), "a parked row that fails to settle: the round still runs, it stays parked")
except Exception as e:
    check(False, f"a parked row that fails to settle killed the round ({type(e).__name__}: {e})")
ANSWER["boom"] = False

ask = parked()["X1"]["signed_diff"]
price = 2420.0 / 32.0
ANSWER["res"] = (ask / price, price)
n = round_()
b = booked()
check(len(b) == 1 and b[0]["unconfirmed_park_id"] == "X1" and b[0]["legs"][0]["executed_qty"] == ask / price
      and b[0]["legs"][0]["signed_qty"] > 0, f"FILLED: booked from the venue's qty and price ({b})")
check("X1" not in parked() and n == 0, f"park cleared; that round sends nothing ({n})")
ANSWER["res"] = None
portfolio.book_unconfirmed(KEY, b[0] | {"signed_diff": ask}, 1.0, 1.0, source="venue", pid="X1")
check(len(booked()) == 1, "a park id already in the book is not booked twice")

# ── while parked: entries held, reduce-only closes of the booked part go out ──
held_cost = book_cost()
amount(32_000)
MODE["raise"] = unknown("X2")
round_()
MODE["raise"] = None
check("X2" in parked() and round_() == 0, "a second entry on the symbol: parked; the next round adds nothing")
amount(0)
n = round_()
legs = list(CALLS)
check(n == 1 and legs[0][2] is True and abs(abs(legs[0][1]) - held_cost) < 1,
      f"target flat while parked: the reduce-only close of the booked part goes out ({legs}, book {held_cost})")
unconfirmed.resolve("2330", 0)

# a parked CLOSE: what it may have taken off is left alone by later closes
amount(16_000)
round_()
amount(0)
MODE["raise"] = unknown("X3")
round_()
MODE["raise"] = None
p3 = parked().get("X3", {})
check(p3.get("reduce_only") is True, f"a close with an unknown outcome is parked too ({p3})")
check(round_() == 0, f"…and no second close goes out for the part it may have sold ({CALLS})")
unconfirmed.resolve("2330", 0)

# ── cannot park → HALT, inflight marker kept ─────────────────────────────────
amount(16_000)
round_()
amount(48_000)
keep_park = unconfirmed.park
unconfirmed.park = lambda *a, **k: (_ for _ in ()).throw(OSError(28, "No space left on device"))
MODE["raise"] = unknown("X4")
round_()
unconfirmed.park = keep_park
check(guard.halted() and marker(), f"park file not writable: HALT, inflight marker kept (halted {guard.halted()}, marker {marker()})")
check(not [r for r in rows() if "X4" in str(r.get("error")) and not r.get("kind")],
      "…and not recorded as a rejection")
MODE["raise"] = None
check("X4" not in parked() and round_() == 0,
      "…and the next round sends nothing for it (re-parked from memory first)")
n = round_()
check("X4" in parked(), "once the file can be written again it is parked from memory")
guard.clear_halt("test")   # 啟動下單
for f in os.listdir("state/execution/inflight"):
    os.remove(os.path.join("state/execution/inflight", f))
check(round_() == 0, "啟動下單 after that HALT: the same entry is not sent again (still parked)")
unconfirmed.resolve("2330", 0)

MODE["raise"] = NotConfirmed("no ids at all")
round_()
MODE["raise"] = None
h = json.load(open(guard.HALT_PATH))
man = [e for pid, e in parked().items() if pid.startswith("manual:")]
check(guard.halted() and h["reason"].startswith(portfolio.UNPARKED_TAG + " " + KEY)
      and h.get("unconfirmed", {}).get("park_id", "").startswith("manual:"),
      f"an unknown outcome without ids: HALT, tagged reason, the park id in the HALT file ({h})")
check(len(man) == 1 and man[0]["key"] == KEY, "…recorded as a manual park so it can be accounted for")
guard.clear_halt("test")   # 啟動下單 before the user answered
for f in os.listdir("state/execution/inflight"):
    os.remove(os.path.join("state/execution/inflight", f))
check(round_() == 0, "啟動下單 before resolving: the entry is not resent")
n_rows = len(rows())
unconfirmed.resolve("2330", 0)
check(round_() == 1, "after resolve(symbol, 0) the next round trades it")

# ── a released park: its rows say so (the pages stop painting 暫停開倉) ───────
MODE["raise"] = unknown("X7")
amount(96_000)
round_()
MODE["raise"] = None
r7 = [r for r in rows("order_unconfirmed") if r.get("park_id") == "X7"]
check(len(r7) == 1 and not r7[0].get("released"), "a parked order's row carries its park id")
ANSWER["res"] = (0.0, 0.0)
round_()
ANSWER["res"] = None
r7 = [r for r in rows("order_unconfirmed") if r.get("park_id") == "X7"]
check(r7 and r7[0].get("released") is True and r7[0].get("filled") is False and r7[0].get("released_at"),
      f"auto-released (nothing filled): row marked released, filled false ({r7})")
MODE["raise"] = unknown("X8")
amount(128_000)
round_()
MODE["raise"] = None
unconfirmed.resolve("2330", 1.0, 75.0)
r8 = [r for r in rows("order_unconfirmed") if r.get("park_id") == "X8"]
check(r8 and r8[0].get("released") is True and r8[0].get("filled") is True,
      f"resolved by the user with a fill: row marked released, filled true ({r8})")

# ── a plain rejection: strategy names, no kind, nothing parked ───────────────
MODE["raise"] = RuntimeError("insufficient paper cash (1 < 2)")
amount(3_200_000)
round_()
last = rows()[-1]
check(last.get("kind") is None and last.get("strategies") == ["tw_c"] and not parked(),
      f"a plain rejection: strategy names, no kind, nothing parked ({last})")
MODE["raise"] = None

# ── TWAP / custom slices: an unknown slice parks and stops the execution ────
from lib import execute  # noqa: E402
import threading  # noqa: E402
keep_auto = venue_wiring.auto_place_order
venue_wiring.auto_place_order = lambda *a, **k: (_ for _ in ()).throw(unknown(cid="x-52DDFAFNtw"))
stop, why = threading.Event(), {}
try:
    execute._place_or_park(KEY, 500.0, None, False, "paper", [{"strategy": "tw_c"}], stop, why)
    check(False, "an unknown slice must not return")
except RuntimeError:
    pk = [e for e in parked().values() if e.get("client_order_id") == "x-52DDFAFNtw"]
    check(stop.is_set() and why.get("stop") == "unknown" and len(pk) == 1 and pk[0]["order_id"] is None,
          "TWAP slice unknown: parked by client id, execution stopped")
venue_wiring.auto_place_order = keep_auto
unconfirmed.resolve("2330", 0)

# ── netted part of an entry is booked with it ────────────────────────────────
portfolio.book_unconfirmed(KEY, {"signed_diff": 100.0, "reduce_only": False, "venue": "paper",
                                 "netted_room": 0.4, "key": KEY}, 1.0, 100.0, source="venue", pid="N1")
nb = [x for x in booked() if x["unconfirmed_park_id"] == "N1"]
check(nb and nb[0]["legs"][0].get("netted_qty") == 0.4, f"netted_qty booked ({nb})")

# ── unreadable park file: nothing is sent, file left as is ───────────────────
Path(unconfirmed.PATH).write_text("{not json")
amount(16_000)
n = round_()
check(n == 0, f"park file unreadable: nothing is sent this round ({n})")
check(Path(unconfirmed.PATH).read_text() == "{not json", "…and the file is left as is")
os.remove(unconfirmed.PATH)

# ── re-audit fixes ───────────────────────────────────────────────────────────
import builtins  # noqa: E402
# a fill found while orders.jsonl cannot be written: the park row stays (its only other record)
MODE["raise"] = unknown("X9")
amount(160_000)
round_()
MODE["raise"] = None
real_open = builtins.open
portfolio.open = lambda f, *a, **k: ((_ for _ in ()).throw(OSError(28, "No space left on device"))
                                     if str(f).endswith("orders.jsonl") and a and "a" in a[0] else real_open(f, *a, **k))
ANSWER["res"] = (1.0, 75.0)
round_()
del portfolio.open
ANSWER["res"] = None
check("X9" in parked() and not any(b.get("unconfirmed_park_id") == "X9" for b in booked()),
      "a fill found but the book cannot be written: the park row is kept, not released")
guard.clear_halt("test")
unconfirmed.resolve("2330", 0, park_id="X9")

# two parks on one symbol: resolve(park_id=) picks the one asked for
for oid in ("Y1", "Y2"):
    MODE["raise"] = unknown(oid)
    amount(192_000 if oid == "Y1" else 0)
    round_()
MODE["raise"] = None
both = sorted(pid for pid, e in parked().items() if e["key"] == KEY)
got = unconfirmed.resolve("2330", 0, park_id="Y2") if "Y2" in both else {}
check(both == ["Y1", "Y2"] and got.get("park_id") == "Y2" and "Y1" in parked() and "Y2" not in parked(),
      f"resolve(park_id=) releases that park only, and says which ({both}, {got.get('park_id')})")
unconfirmed.resolve("2330", 0)

# the direction is stored on its own: a close sized at mark 0 is booked as a sell
portfolio.book_unconfirmed(KEY, {"signed_diff": -0.0, "sign": -1, "reduce_only": True, "venue": "paper",
                                 "key": KEY}, 1.0, 75.0, source="venue", pid="S1")
s1 = [x for x in booked() if x["unconfirmed_park_id"] == "S1"]
check(s1 and s1[0]["legs"][0]["signed_qty"] < 0 and s1[0]["action"] == "SELL",
      f"a park with signed_diff -0.0 and sign -1 books a SELL ({s1})")

# a manual park keeps the venue the order went to (no （） in its reminders)
MODE["raise"] = NotConfirmed("no ids at all")
amount(224_000)
round_()
MODE["raise"] = None
man = [e for pid, e in parked().items() if pid.startswith("manual:")]
check(man and man[-1]["venue"] == "paper", f"manual park: venue from the order's exchange ({man[-1:]})")
guard.clear_halt("test")
for f in os.listdir("state/execution/inflight"):
    os.remove(os.path.join("state/execution/inflight", f))
unconfirmed.resolve("2330", 0)

# the inflight marker cannot be written: no entry this round (closes would still go)
from lib import execute as _ex  # noqa: E402
keep_mark = _ex._write_inflight_marker
_ex._write_inflight_marker = lambda *a, **k: False
amount(256_000)
n = round_()
_ex._write_inflight_marker = keep_mark
check(n == 0, f"inflight marker not writable: the entry is held this round ({CALLS})")

# the machine's TG copy follows its reply language
Path("state/reply_lang").write_text("en\n")
MODE["raise"] = unknown("L1")
del sent[:]
round_()
MODE["raise"] = None
check(any(x.startswith("🚨 Order outcome unknown — 2330@spot on paper, strategy tw_c.") for x in sent),
      f"reply language en: the machine notice is English ({sent[-1:]})")
os.remove("state/reply_lang")
unconfirmed.resolve("2330", 0)

# ── 全部平倉 asks about parked orders first and says what it could not close ─
MODE["raise"] = unknown("X6")
amount(64_000)
round_()
MODE["raise"] = None
from manager import flatten  # noqa: E402
os.chdir(WS)   # importing flatten chdirs to the repo it sits in — run it against the test workspace
flatten._inflight_wait_s = lambda: 0
held_at_zero = []
keep_zero = flatten.zero_ledger_symbols
flatten.zero_ledger_symbols = lambda *a, **k: (held_at_zero.append(unconfirmed._held["depth"]), keep_zero(*a, **k))[1]
check("X6" in parked(), "an entry parked before 全部平倉")
with contextlib.redirect_stdout(io.StringIO()):
    flatten.flatten()
# realpath: mkdtemp under /var/folders is /private/var/folders once chdir'd into (macOS symlink)
check(os.path.realpath(os.getcwd()) == os.path.realpath(WS) and not os.path.exists(os.path.join(ROOT, "manager", "order_errors.json")),
      "flatten ran in the test workspace")
check(held_at_zero and all(d > 0 for d in held_at_zero),
      f"全部平倉 zeroes the book holding the park lock — nothing settles in between ({held_at_zero})")
fl = [r for r in rows("order_unconfirmed") if "close-all" in str(r.get("error"))]
check(len(fl) == 1 and fl[0]["symbol"] == KEY and fl[0].get("stuck") is True and fl[0]["exchange"] == "paper",
      f"全部平倉 with an order still parked: a row says it may have filled and was not closed ({fl})")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
