"""A rejection that comes back every round (paper cash short — paper e2e batch 2, 10-18: five
"⚠️ Order failed" in 2m16s; one OKX user, 11-16: 335 rows and 21 mails in 11 hours).

The notice (Wei 11-20, batch 2): every leg alike, an exchange + symbol + leg + reason is told
once it has failed 3 times in a row (not the first time), 24 hours after that one reminder saying
how long and how many times, then nothing until the reason changes or the leg goes through; the
count survives a restart. Rows written before the notice carry `silent` (the platform sends nothing). The Telegram sender and the log-only one
alike (both are send_telegram_fn here); the error log line likewise. order_errors.json does not grow
a row per round: the repeat bumps the row it repeats (last_at, count) with ts and text untouched,
so the platform's P1 (api agent_overview._error_events, one per new (ts, symbol, exchange, text)
row) is sent once too.

The send: an entry leg rejected for the same reason waits 5 min, 15 min, 1 h, then 6 h each time
before it goes again (next_retry_at on its row); a reduce leg goes every round; a reason without
an [order_reject:<kind>] token gets three sends a round apart first. Saving the order settings,
啟動下單, a new reason and a fill on that leg end the wait and start the steps over. Other symbols
trade on in the same round. Kept in state/execution/reject_backoff.json: a restart goes on where
it was; a broken or unreadable file holds nothing back.
Real rounds on paper: reconcile → manager/reconciler.place_order → order_paper.

Run: cd blave-agent && .venv/bin/python tests/check_order_error_throttle.py
"""
import contextlib
import hashlib
import importlib
import io
import json
import logging
import os
import shutil
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
for d in ("state", "manager", "strategies/tw_c", "strategies/tw_d"):
    (WS / d).mkdir(parents=True, exist_ok=True)
(WS / ".env").write_text("PAPER_API_KEY=paper\nPAPER_SECRET_KEY=paper\nPAPER_BOUND_TS=1\n"
                         "PAPER_INITIAL_EQUITY=1000\n")
json.dump({"rates": {"TWD": 32.0}, "ts": int(time.time())}, open("state/paper_fx.json", "w"))
for name, code in (("tw_c", "2330"), ("tw_d", "2317")):
    (WS / f"strategies/{name}/strategy.py").write_text('MARKET = "spot"\n')
    json.dump({"type": "portfolio", "market": "spot", "weights": {code: 1.0}},
              open(f"strategies/{name}/state.json", "w"))
BACKOFF = "state/execution/reject_backoff.json"
SYM, SYM2 = "2330@spot", "2317@spot"


def config(amount, other=None):
    amounts = {"tw_c": amount, **({"tw_d": other} if other else {})}
    json.dump({"amounts": amounts, "exchanges": {k: "paper" for k in amounts}, "asset_specs": {}},
              open("manager/portfolio_config.json", "w"))


socket.socket.connect = lambda *a, **k: (_ for _ in ()).throw(OSError("offline test"))
import pandas as pd  # noqa: E402
import lib.data as data  # noqa: E402

data.fetch_twstock_price = lambda code, *a: pd.DataFrame({"Close": [2420.0]}, index=pd.to_datetime(["2026-10-16"]))
from lib import guard, order_paper, paper_data, portfolio, venue_wiring  # noqa: E402

ENV = venue_wiring.read_env()

paper_data.tw_session_open = lambda env=None, now=None: True
order_paper.tw_session_open = paper_data.tw_session_open
from manager import reconciler as rec  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


T = [time.time()]


def clock():
    portfolio._backoff_clock = lambda: T[0]


clock()
sent = []
calls = []
MODE = {}   # symbol -> "small" (a 10,000 TWD piece) or an error text; absent: the paper venue answers
REDUCE_ERR = {}   # symbol -> the error its reduce leg gets


def place(symbol, signed_diff, asset_spec=None, reduce_only=False, **kw):
    calls.append((symbol, bool(reduce_only)))
    if reduce_only and symbol in REDUCE_ERR:
        raise RuntimeError(REDUCE_ERR[symbol])
    mode = MODE.get(symbol)
    if mode == "small":
        signed_diff = min(signed_diff, 10_000)
    elif mode and not reduce_only:
        raise RuntimeError(mode)
    return rec.place_order(symbol, signed_diff, asset_spec, reduce_only=reduce_only, **kw)


def round_(dt=0):
    T[0] += dt
    del calls[:]
    buf = io.StringIO()
    h = logging.StreamHandler(buf)
    root = logging.getLogger()
    root.addHandler(h)
    root.setLevel(logging.INFO)
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            portfolio.reconcile(rec._get_positions_guarded, place, threshold=rec.THRESHOLD,
                                send_telegram_fn=sent.append)
    finally:
        root.removeHandler(h)
    return [ln for ln in buf.getvalue().splitlines() if "order error 2330" in ln]


def entry_calls(symbol=SYM):
    return calls.count((symbol, False))


def errors():
    try:
        return json.load(open("manager/order_errors.json"))
    except OSError:
        return []


def row(symbol=SYM):
    # the row touched last: a repeat bumps the older row of its own reason, not the newest one
    rows = [e for e in errors() if e.get("symbol") == symbol]
    return max(rows, key=lambda e: e.get("last_at") or e["ts"]) if rows else {}


def told(since=0):
    return [x for x in sent[since:] if "Order failed" in x or "still failing" in x]


def platform_keys():
    # the dedup basis of api openclaw/agent_overview._error_events (origin/main c1f62401)
    return {(e.get("ts"), e.get("symbol"), e.get("exchange"),
             hashlib.sha256(str(e.get("error")).encode()).hexdigest()[:16]) for e in errors()}


# ── the first failure, then the same round after round ──────────────────────
config(2_000_000)   # 62,500 USD of 2330 against 1,000 USD of paper cash
for _ in range(3):   # the first round may only write the own-positions baseline
    first_logs = round_()
    if calls:
        break
T0 = T[0]
check(entry_calls() == 1, f"the first failure is sent ({calls})")
logs = [round_() for _ in range(4)]
check(not told(), f"the first failure is not told ({told()[:2]})")
check(sum(len(x) for x in logs) == 0 and len(first_logs) == 1, f"…and one error log line ({first_logs}, {logs})")
check(entry_calls() == 0, f"…and the 4 rounds inside 5 minutes do not call place_order ({calls})")
check(len([e for e in errors() if e.get("symbol") == SYM]) == 1, f"order_errors.json: one row ({errors()})")
check(row().get("silent") is True, f"…marked silent: the platform sends nothing for it either ({row()})")
check(row().get("next_retry_at") == int(T0 + 300), f"…with next_retry_at 5 minutes on ({row()}, {int(T0 + 300)})")
check(len(platform_keys()) == 1, f"so the platform derives one P1, not one per round ({len(platform_keys())})")
check(not order_paper.get_spot_balances(ENV).get("2330"), "nothing bought (the venue refused it)")

# ── the steps: 5 min, 15 min, 1 h, 6 h, 6 h ─────────────────────────────────
at, seen, expected, tells = T0, [], [], []
for step, nxt in zip((300, 900, 3600, 21600, 21600), (900, 3600, 21600, 21600, 21600)):
    round_(at + step - 1 - T[0])
    before = entry_calls()
    n = len(sent)
    round_(1)
    at = T[0]
    tells.append(len(told(n)))
    seen.append((step, before, entry_calls(), row().get("next_retry_at")))
    expected.append(int(at + nxt))
    if len(seen) == 2:
        third = dict(row())
check(all(b == 0 and c == 1 for _, b, c, _ in seen),
      f"an entry leg waits each step out to the second, then goes ({seen})")
check([s[3] for s in seen] == expected,
      f"next_retry_at follows 15 min, 1 h, 6 h, 6 h ({[s[3] for s in seen]} vs {expected})")
check(tells == [0, 1, 0, 0, 0] and "insufficient paper cash" in told()[0],
      f"told on the 3rd failure in a row only; the 2nd, then 1 h, 7 h, 13 h on: nothing ({tells})")
check(not third.get("silent") and third.get("count") == 3 and third.get("since"),
      f"…the 3rd writes a new row the platform tells (count 3, since) ({third})")
check(row().get("count") == 6 and row().get("last_at", "") > row()["ts"],
      f"the repeats after it bump that row: count and last_at ({row()})")

# ── a day on: one reminder, then nothing ─────────────────────────────────────
n = len(sent)
round_(at + 21600 - T[0])   # T0 + 69,600 s: under 24 h
check(not told(n), f"19 hours on: nothing yet ({told(n)})")
n = len(sent)
round_(21600)   # T0 + 91,200 s
rem = told(n)
check(len(rem) == 1 and "still failing" in rem[0] and "25h" in rem[0] and "8 times" in rem[0],
      f"24 hours on: one reminder, how long and how many times ({rem})")
check(row().get("reminder") is True and row().get("count") == 8 and row().get("since"),
      f"…as a new row the platform reads (reminder, count, since) ({row()})")
n = len(sent)
round_(21600)
check(entry_calls() == 1 and not told(n), f"after the reminder: still sent every 6 h, never told again ({told(n)})")

# ── a restart: the wait and the notice state both carry over ────────────────
importlib.reload(portfolio)
clock()
n = len(sent)
round_(60)
check(entry_calls() == 0, f"restarted: the 6 h wait still holds ({calls})")
round_(21600 - 60)
check(entry_calls() == 1 and not told(n), f"restarted: sent when due, and not told again ({told(n)})")

# ── a new reason: counted from one, the steps start over ─────────────────────
MODE[SYM] = "[order_reject:below_min_size] below the venue's minimum order size"
n = len(sent)
round_(21600)
check(entry_calls() == 1 and not told(n), f"a different reason counts from one: not told yet ({told(n)})")
check(row().get("next_retry_at") == int(T[0] + 300), f"…and waits 5 minutes, step one ({row()})")
MODE.pop(SYM)

# ── saving the order settings: sent next round, steps from one ──────────────
round_(300)   # the cash reason again: a new reason, step one
round_(300)   # step two: 15 minutes
check(entry_calls() == 1 and row().get("next_retry_at") == int(T[0] + 900), f"step two ({row()})")
config(2_000_000)   # the same settings saved again
round_(1)
check(entry_calls() == 1, f"saved order settings: sent the next round ({calls})")
check(row().get("next_retry_at") == int(T[0] + 300), f"…and the steps start over ({row()})")

# ── 啟動下單 (HALT cleared): sent next round, steps from one ─────────────────
round_(300)
check(row().get("next_retry_at") == int(T[0] + 900), f"step two again ({row()})")
guard.trip_halt("test pause", "user")
round_(1)
check(entry_calls() == 0, "under HALT nothing goes")
guard.clear_halt("test")
round_(1)
check(entry_calls() == 1, f"啟動下單: sent the next round ({calls})")
check(row().get("next_retry_at") == int(T[0] + 300), f"…and the steps start over ({row()})")

# ── a fill on the leg ends it: the next failure is told and starts at step one ──
round_(300)   # step two
MODE[SYM] = "small"
round_(900)
check(order_paper.get_spot_balances(ENV).get("2330", 0) > 0, "the leg filled (a 10,000 TWD piece)")
try:
    legs = json.load(open(BACKOFF)).get("legs", {})
except (OSError, ValueError):
    legs = None
check(legs is not None and not [k for k in legs if SYM in k and k.endswith("|entry")],
      f"a fill on the leg clears it ({legs})")
MODE.pop(SYM)
n = len(sent)
round_(1)
check(entry_calls() == 1 and not told(n), f"so the next failure is sent, the count from one ({told(n)})")
check(row().get("next_retry_at") == int(T[0] + 300), f"…from step one ({row()})")
importlib.reload(portfolio)   # a restart between the 1st and the 2nd
clock()
round_(300)
check(entry_calls() == 1 and not told(n), f"restarted, the 2nd in a row: not told ({told(n)})")
round_(900)
check(entry_calls() == 1 and len(told(n)) == 1, f"the 3rd in a row across the restart: told ({told(n)})")

# ── a reason without a token: three sends a round apart, then the wait ─────
MODE[SYM] = "venue busy, code 50001"
n = len(sent)
got = []
tells = []
for dt in (3600, 1, 1, 1):   # 3600: the cash rejection's step three runs out
    m = len(sent)
    round_(dt)
    got.append(entry_calls())
    tells.append(len(told(m)))
check(got == [1, 1, 1, 0], f"no token: the first 3 sent every round, the 4th waits ({got})")
check(tells == [0, 0, 1, 0], f"…told on the 3rd ({tells})")
round_(300)
check(entry_calls() == 1, "…and goes after 5 minutes")
MODE.pop(SYM)

# ── a symbol that waits does not hold another one ───────────────────────────
config(2_000_000, other=20_000)
MODE[SYM2] = "small"   # 2317 fills a piece each round, so it has a leg every round
round_(1)
check(entry_calls() == 1 and entry_calls(SYM2) == 1, f"both sent ({calls})")
round_(1)
check(entry_calls() == 0 and entry_calls(SYM2) == 1, f"2330 waits, 2317 still goes the same round ({calls})")
MODE.pop(SYM2)

# ── a reduce leg goes every round ───────────────────────────────────────────
config(1_000, other=20_000)   # 2330 holds more than 1,000 TWD: a reduce leg
REDUCE_ERR[SYM] = "[order_reject:insufficient_margin] the venue would not take the sell"
got, tells = [], []
for _ in range(4):
    m = len(sent)
    round_(1)
    got.append(calls.count((SYM, True)))
    tells.append(len(told(m)))
check(got == [1, 1, 1, 1], f"a reduce leg rejected the same way is sent every round ({got})")
check(tells == [0, 0, 1, 0], f"…and told on the 3rd in a row only, like an entry ({tells})")
REDUCE_ERR.pop(SYM)

# ── a reduce leg counts every failure, whatever the reason ──────────────────
config(1_000, other=1_000)   # 2317 holds more than 1,000 TWD too: its reduce leg
A, B = "[order_reject:reduce_only_rejected] reduce-only refused", "venue busy, request id deadbeef"
tells = []
for reason in (A, B, A, B, A, B):
    REDUCE_ERR[SYM2] = reason
    m = len(sent)
    round_(1)
    tells.append(len([x for x in told(m) if "2317" in x]))
check(tells == [0, 0, 1, 1, 0, 0],
      f"two reasons taking turns on a close: told on the 3rd failure, once more for the other reason, then quiet ({tells})")

# ── a value that cannot be in a readable file: dropped, the round goes on ───
config(2_000_000, other=1_000)   # 2330 wants an entry again, 2317 still a failing reduce
REDUCE_ERR[SYM2] = A
round_(301)
try:
    doc = json.load(open(BACKOFF))
except (OSError, ValueError):
    doc = {}
doc.setdefault("legs", {})
for key, bad in (("paper|2330@spot|entry", {"next_retry_at": 1e12}), ("paper|9999@spot|entry", {"next_retry_at": 1e20}),
                 ("paper|9998@spot|entry", {"last_at": T[0] + 86400 * 365})):
    doc["legs"][key] = {"reason": "x", "first_at": T[0] - 10, "last_at": T[0] - 5, "count": 1, "sign": 1, **bad}
json.dump(doc, open(BACKOFF, "w"))
try:
    round_(1)
    raised = None
except Exception as e:  # noqa: BLE001
    raised = e
check(raised is None and entry_calls() == 1 and calls.count((SYM2, True)) == 1,
      f"next_retry_at 1e12 / 1e20, last_at a year ahead: nothing raised, the entry and the close both sent ({calls}, {raised!r})")
try:
    legs = json.load(open(BACKOFF)).get("legs", {})
except (OSError, ValueError):
    legs = {"unreadable": True}
check(not [k for k in legs if k.startswith("paper|999")] and "unreadable" not in legs and "1000000000000" not in json.dumps(legs),
      f"…the unusable entries are gone from the file ({sorted(legs)})")
REDUCE_ERR.pop(SYM2)

# ── a broken or unreadable file holds nothing back ──────────────────────────
config(2_000_000, other=20_000)
MODE[SYM] = "[order_reject:insufficient_margin] insufficient cash"
got = []
try:
    for _ in range(3):
        Path(BACKOFF).parent.mkdir(parents=True, exist_ok=True)
        Path(BACKOFF).write_text("{not json")
        round_(1)
        got.append(entry_calls())
    raised = None
except Exception as e:  # noqa: BLE001
    raised = e
check(raised is None and got == [1, 1, 1], f"a broken file: every round sent, nothing raised ({got}, {raised})")
check(Path(BACKOFF + ".corrupt").exists(), "…the broken file is set aside")
if os.path.exists(BACKOFF):
    os.remove(BACKOFF)
os.mkdir(BACKOFF)   # open() on it raises IsADirectoryError
n = len(sent)
got = []
for _ in range(3):
    round_(1)
    got.append(entry_calls())
check(got == [1, 1, 1], f"an unreadable file: every round sent ({got})")
check(len(told(n)) == 1, f"…and this process keeps its count meanwhile: told once, not every round ({told(n)})")
os.rmdir(BACKOFF)
MODE.pop(SYM)

# ── 7 keys reach their notice in one round: no told row is pushed out of the 5 ──
Path("manager/order_errors.json").write_text("[]")
SYMS = [f"X{i}USDT" for i in range(7)]
ERR7 = "[order_reject:insufficient_margin] margin short"


def round7(dt):
    T[0] += dt
    bo = portfolio._RejectBackoff(False)
    out = []
    for sy in SYMS:   # what reconcile does for a rejected reduce leg
        notice, e7 = bo.fail("okx", sy, "reduce", RuntimeError(ERR7), -1, backoff=False)
        extra = {"count": e7["count"], "since": "x", "_reject_leg": "reduce"} if notice else {"_reject_leg": "reduce"}
        portfolio._record_order_error(sy, "okx", RuntimeError(ERR7), extra=extra, repeat=notice is None)
        out.append(notice)
    bo.finish()
    return out


r1, r2, r3 = round7(1), round7(1), round7(1)
loud = [e["symbol"] for e in errors() if not e.get("silent")]
check(r1.count(None) == 7 and r2.count(None) == 7 and r3.count("first") == 5,
      f"the 3rd round: 5 told, 2 wait ({r3})")
check(sorted(loud) == sorted(s7 for s7, n7 in zip(SYMS, r3) if n7) and len(errors()) == 5,
      f"…all 5 told rows are in the file, the silent ones went first ({errors()})")
r4 = round7(60)
check(r4.count("first") == 0 and sorted(e["symbol"] for e in errors() if not e.get("silent")) == sorted(loud),
      f"a minute on: the 2 still wait, the 5 told rows stay ({r4})")
check(all(e.get("silent") or e["symbol"] in loud for e in errors()),
      f"…a repeat written again after it was pushed out is silent ({errors()})")
r5 = round7(300)
check(sorted(s7 for s7, n7 in zip(SYMS, r5) if n7) == sorted(set(SYMS) - set(loud)),
      f"5 minutes on: the 2 that waited are told ({r5})")
check(len([e for e in errors() if not e.get("silent")]) == 5, f"…their rows are in the file ({errors()})")
check(not [e for e in errors() if "_reject_leg" in e], "…the marker reconcile passes is never stored")
loud5 = sorted(e["symbol"] for e in errors())
portfolio._record_order_error("BTCUSDT", "okx", RuntimeError("order P9 sent, no answer"),
                              extra={"kind": "order_unconfirmed", "strategies": ["s"], "park_id": "P9"})
portfolio._record_order_error("ETHUSDT", "okx", RuntimeError("close-all: ETHUSDT not closed (reduce-only refused)"))
syms = [e["symbol"] for e in errors()]
check("BTCUSDT" in syms and "ETHUSDT" in syms and len(syms) == 7,
      f"5 fresh notice rows: a new parked row and a new close-all failure both still land ({syms})")
check(next(e for e in errors() if e["symbol"] == "BTCUSDT").get("park_id") == "P9" and set(loud5) <= set(syms),
      f"…in their own 5: neither pushes the other out ({syms})")
check(all(e.get("leg") == "reduce" for e in errors() if e["symbol"].startswith("X")) and "leg" not in
      next(e for e in errors() if e["symbol"] == "ETHUSDT"), "rejection rows carry their leg; the others do not")


def keeps_both(what):
    syms = [e["symbol"] for e in errors()]
    check("BTCUSDT" in syms and "ETHUSDT" in syms, f"{what}: the parked and the close-all rows are still there ({syms})")


# the audit's sequence: 5 notice rows, then in one round a parked row, a close-all failure, a silent rejection
Path("manager/order_errors.json").write_text("[]")
SYMS = [f"Y{i}USDT" for i in range(5)]
round7(400), round7(1), round7(1)   # 5 notice rows, all fresh
check(len([e for e in errors() if e.get("since")]) == 5, f"5 notice rows in the file ({errors()})")
portfolio._record_order_error("BTCUSDT", "okx", RuntimeError("order P10 sent, no answer"),
                              extra={"kind": "order_unconfirmed", "strategies": ["s"], "park_id": "P10"})
portfolio._record_order_error("ETHUSDT", "okx", RuntimeError("close-all: ETHUSDT not closed (reduce-only refused)"))
portfolio._record_order_error("Z0USDT", "okx", RuntimeError(ERR7), extra={"_reject_leg": "entry"}, repeat=True)
keeps_both("parked, close-all failure, then a silent rejection in the same round")
check("Z0USDT" not in [e["symbol"] for e in errors()], f"…the silent rejection is the one not kept ({errors()})")
# and over many rounds: 7 keys failing every round, their notices due as the window opens
SYMS = [f"W{i}USDT" for i in range(7)]
for dt in (1, 1, 1, 60, 301, 1, 301, 86400 + 400, 1):
    round7(dt)
    keeps_both(f"a rejection round {dt} s on")

# the two budgets of 5, the other way round: 6 parked rows keep their newest 5, a rejection still lands,
# and a rewrite that marks a park released keeps both budgets
Path("manager/order_errors.json").write_text("[]")
for i in range(6):
    portfolio._record_order_error(f"P{i}USDT", "okx", RuntimeError("sent, no answer"),
                                  extra={"kind": "order_unconfirmed", "park_id": f"Q{i}"})
portfolio._record_order_error("R0USDT", "okx", RuntimeError(ERR7), extra={"_reject_leg": "entry"}, repeat=True)
syms = [e["symbol"] for e in errors()]
check(syms == [f"P{i}USDT" for i in range(1, 6)] + ["R0USDT"],
      f"6 parked rows: the oldest goes; a silent rejection beside 5 parked rows is kept ({syms})")
portfolio.mark_park_released("Q3", False)
check([e["symbol"] for e in errors()] == syms and next(e for e in errors() if e.get("park_id") == "Q3").get("released"),
      f"…a park release rewrite keeps every row of both budgets ({[e['symbol'] for e in errors()]})")
old = [{"ts": "2026-01-01T00:00:00", "symbol": f"OLD{i}", "exchange": "okx", "error": ERR7, "count": 3, "since": "x"}
       for i in range(5)]
Path("manager/order_errors.json").write_text(json.dumps(old))
portfolio._record_order_error("NEWUSDT", "okx", RuntimeError(ERR7), repeat=True)
check([e["symbol"] for e in errors()][-1] == "NEWUSDT" and len(errors()) == 5,
      f"told rows past the 5 minutes do not keep a new failure out ({[e['symbol'] for e in errors()]})")

# ── the cooldown the other callers keep (protective orders, 統一's shut market) is unchanged ──
check(portfolio._order_error_fresh("X", RuntimeError("insufficient paper cash (60908 < 103336)"))
      and not portfolio._order_error_fresh("X", RuntimeError("insufficient paper cash (60911 < 103402)"))
      and portfolio._order_error_fresh("X", RuntimeError("below minimum size")),
      "the reason ignores the moving numbers; a different reason is news at once")
check(portfolio._order_error_fresh("Y", RuntimeError("key expired"), "entry")
      and portfolio._order_error_fresh("Y", RuntimeError("key expired"), "reduce")
      and not portfolio._order_error_fresh("Y", RuntimeError("key expired"), "reduce"),
      "an exit failing for the text an entry failed with is still news (the leg is in the key)")

shutil.rmtree(WS, ignore_errors=True)
print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
