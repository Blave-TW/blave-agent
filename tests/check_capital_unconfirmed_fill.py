"""群益 entry that came back 'sent' / 0 lots and filled anyway is booked as the bot's — no Windows, no broker.

10-27 win-test-5 (real money): TMF +1 went out on the alias TM0000, the lib saw no fill
report in confirm_timeout + LATE_REPORT_S and returned 'sent' / 0, the reconciler booked 0,
two rounds were skipped by the Read-Your-Writes guard, and the first caught-up snapshot
showed TM2611 +1 — a month the empty book did not hold, so it was excluded as the user's
(manual_month_excluded) and the strategy's exit never sent the sell. Replays that exact
sequence through reconciler.get_positions() (the reconcile round's read) and
_capital_place_order, with the box's portfolio_config and orders.jsonl line.

Run: cd blave-agent && python3 tests/check_capital_unconfirmed_fill.py
"""
import json, os, sys, tempfile, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
TMP = tempfile.mkdtemp(prefix="capital-unconfirmed-", dir=os.environ.get("SCRATCHPAD") or None)
os.chdir(TMP)
os.makedirs("manager", exist_ok=True)
os.makedirs("state", exist_ok=True)

SPEC = {"type": "futures_contracts", "contract_value": 10, "currency": "TWD", "lot_size": 1, "margin": 35050}
CONFIG = {"self_ledger": True, "execution_default": {"type": "market"}, "execution": {},
          "amounts": {"tmf_capital_oneshot": 1.0}, "exchanges": {"tmf_capital_oneshot": "capital"},
          "asset_specs": {"tmf_capital_oneshot": SPEC}, "contracts": {}}

from lib import account_capital, capital_vault, guard  # noqa: E402
import lib.order_capital as oc  # noqa: E402
import lib.portfolio as portfolio  # noqa: E402
from manager import reconciler  # noqa: E402

SNAP = os.path.join(TMP, "capital_account.json")
account_capital._SNAPSHOT = SNAP
capital_vault.LAST_ORDER_PATH = os.path.join(TMP, "capital_last_order_at")
S = capital_vault.ORDER_SETTLE_S
PENDING = getattr(reconciler, "CAPITAL_PENDING_PATH", "state/capital_pending_sent.json")  # getattr: runs on old code too
GAP = getattr(reconciler, "PENDING_UNCHANGED_MIN_S", 5)
fails = 0


def check(cond, msg, detail=None):
    global fails
    print(("ok   " if cond else "FAIL ") + msg + ("" if cond or detail is None else f"  ({detail})"))
    fails += 0 if cond else 1


def reset(seed_symbols=None):
    for p in ("manager/orders.jsonl", "manager/order_errors.json", "state/audit.jsonl", "state/HALT",
              PENDING, capital_vault.LAST_ORDER_PATH, "state/capital_cleared.json"):
        if os.path.exists(p):
            os.remove(p)
    capital_vault._last_order_mem = 0.0
    reconciler._manual_noted.clear()
    getattr(reconciler, "_PARKED_MEM", {}).clear()
    tg.clear()
    json.dump(CONFIG, open("manager/portfolio_config.json", "w"))
    json.dump({"seeded_at": "2026-10-27T01:37:41.641854", "symbols": seed_symbols or {}},
              open("manager/ledger_seed.json", "w"))


def snap(positions, started, cost=46597.0):
    json.dump({"ok": True, "error": None, "holdings": [], "equity": 46483.0, "currency": "TWD",
               "positions": [{"symbol": c, "side": "buy" if q > 0 else "sell", "lots": abs(q), "avg_cost": cost}
                             for c, q in positions.items()],
               "query_started_at": started, "read_at": int(time.time())}, open(SNAP, "w"))


sent = []
tg = []
reconciler.send_telegram = tg.append


def broker(result):
    def place(env, symbol, action, lots, intent, confirm_timeout=15):
        capital_vault.mark_order_sent()
        sent.append((symbol, action, lots, intent))
        guard.audit("order_sent", seq_no=result.get("seq_no"), venue="capital", market="futures",
                    symbol=symbol, action=action, qty=lots, unit="lots", intent=intent)
        return dict(result)
    oc.place_futures_market_order = place


def book_order_line(leg):
    """What portfolio.reconcile appends after _capital_place_order returns (the box's line)."""
    portfolio._append_reconciler_log({
        "action": "BUY", "symbol": "TMF", "signed_diff": 1.0, "exchange": "capital", "asset_spec": SPEC,
        "contributors": [{"strategy": "tmf_capital_oneshot", "position": 1.0, "amount": 1.0, "contribution": 1.0}],
        "legs": [{"signed_diff": 0.0, "reduce_only": False, "fill_price": leg["avg_price"],
                  "executed_qty": leg["executed_qty"], "exchange": "capital",
                  "signed_qty": float(leg["executed_qty"])}]})


def round_read():
    """One reconcile round's position read (the daemon's: claims parked orders)."""
    reconciler._claim_parked = True
    try:
        return reconciler.get_positions()
    finally:
        reconciler._claim_parked = False


def audits(event):
    if not os.path.exists("state/audit.jsonl"):
        return []
    return [r for r in map(json.loads, open("state/audit.jsonl", encoding="utf-8")) if r.get("event") == event]


def pending():
    p = PENDING
    return json.load(open(p, encoding="utf-8")) if os.path.exists(p) else {}


SENT = {"seq_no": "2315619624026", "status": "sent", "symbol": "TM0000", "fill_qty": 0.0,
        "avg_fill_price": 0.0, "fill_ids": [], "market": None}

# ── the 10-27 sequence ──────────────────────────────────────────────────────
reset()
snap({}, time.time())
check(round_read() == {}, "before the entry: flat account, flat book")
broker(SENT)
leg = reconciler._capital_place_order("TMF", 1.0, SPEC)
book_order_line(leg)
order_at = capital_vault.last_order_at()
check(sent == [("TM0000", "buy", 1, "entry")] and leg["executed_qty"] == 0.0,
      "entry TMF +1 on TM0000 comes back 'sent' / 0 and is booked at 0", (sent, leg))
check(not os.path.exists("manager/order_errors.json"),
      "…with no immediate P1 (order_errors row): parked silently, as 統一")
snap({"TM2611": 1}, order_at - 23)  # the worker's read began before the order
try:
    round_read()
    check(False, "a snapshot whose read started before the order is refused")
except reconciler.CapitalCacheLagError:
    check(True, "a snapshot whose read started before the order is refused (round skipped)")
check(not audits("late_fill_adopted"), "…and nothing is claimed from it")
snap({"TM2611": 1}, order_at + S + 5)  # the first caught-up read: the lot is there
got = round_read()
check(not audits("manual_month_excluded"),
      "the bot's own TM2611 +1 is NOT excluded as a manual month", audits("manual_month_excluded"))
check(got.get("TMF", {}).get("side") == "long" and got["TMF"].get("size") == 1.0,
      "the read returns TMF long 1 lot", got)
adopted = audits("late_fill_adopted")
check(len(adopted) == 1 and adopted[0].get("contract") == "TM2611" and adopted[0].get("lots") == 1.0,
      "late_fill_adopted for TM2611 +1", adopted)
book = portfolio.ledger_positions("capital").get("TMF") or {}
check(book.get("side") == "long" and book.get("qty") == 1.0 and book.get("months") == {"2026-11": 1.0},
      "the book holds TMF +1 in 2026-11 (the actual month, not the alias)", book)
check(pending() == {}, "the parked row is gone once booked", pending())
got = round_read()
check(len(audits("late_fill_adopted")) == 1 and got.get("TMF", {}).get("size") == 1.0,
      "a later round does not book it twice")
sent.clear()
broker({"seq_no": "2315619624099", "status": "filled", "symbol": "TM2611", "fill_qty": 1.0,
        "avg_fill_price": 46600.0, "fill_ids": ["x"], "market": "TF"})
snap({"TM2611": 1}, capital_vault.last_order_at() + S + 1)
leg = reconciler._capital_place_order("TMF", -1.0, SPEC, reduce_only=True)
check(sent == [("TM0000", "sell", 1, "reduce")] and leg["executed_qty"] == 1.0,
      "strategy back to 0: the exit sells the lot (reduce)", sent)

# ── parked: no second order for that root until claimed (the double-buy guard) ──
reset()
snap({}, time.time())
sent.clear()
broker(SENT)
reconciler._capital_place_order("TMF", 1.0, SPEC)
p = pending().get("TMF") or {}
check(p.get("lots") == 1.0 and p.get("expected") == {} and audits("order_unfilled_parked"),
      "'sent' / 0 parks +1 against the flat baseline", p)
snap({}, capital_vault.last_order_at() + S + 1)
check(reconciler._capital_place_order("TMF", 1.0, SPEC) is False and len(sent) == 1,
      "the next round's entry for TMF waits while +1 is parked — nothing re-sent", sent)
check(reconciler._capital_place_order("TMF", -1.0, SPEC, reduce_only=True) is False and len(sent) == 1,
      "a close of TMF waits too (sNewClose=2 could open the other side)")
check(round_read() == {} and "TMF" in pending() and not audits("unfilled_order_cleared"),
      "ONE caught-up read with the account unchanged does not clear it (open interest may lag)")
snap({}, capital_vault.last_order_at() + S + 1 + GAP)
check(round_read() == {} and pending() == {} and audits("unfilled_order_cleared"),
      "a second, later caught-up read still unchanged: the IOC did not fill, cleared")
reconciler._capital_place_order("TMF", 1.0, SPEC)
check(len(sent) == 2, "…and the next diff may send again")

# ── the user's other month is left alone; the bot's month is learned from what moved ──
reset()
snap({"TM2612": 1}, time.time())
sent.clear()
broker(SENT)
reconciler._capital_place_order("TMF", 1.0, SPEC)
check((pending().get("TMF") or {}).get("expected") == {"TM2612": 1.0}, "baseline carries the user's TM2612")
snap({"TM2611": 1, "TM2612": 1}, capital_vault.last_order_at() + S + 1)
got = round_read()
book = portfolio.ledger_positions("capital").get("TMF") or {}
check(book.get("months") == {"2026-11": 1.0} and got.get("TMF", {}).get("size") == 1.0
      and [a["contract"] for a in audits("manual_month_excluded")] == ["TM2612"],
      "TM2611 adopted as the bot's, the user's TM2612 still excluded", (book, got))

# ── a flip's entry leg waits for a caught-up snapshot (baseline would be stale) ──
reset()
snap({}, time.time())
sent.clear()
broker({"seq_no": "1", "status": "filled", "symbol": "TM2611", "fill_qty": 1.0, "avg_fill_price": 1.0,
        "fill_ids": ["a"], "market": "TF"})
reconciler._capital_place_order("TMF", 1.0, SPEC)
check(reconciler._capital_place_order("TMF", 1.0, SPEC) is False and len(sent) == 1,
      "a second leg in the same round (snapshot predates the first) is not sent")

# ── the account moved in a way the order does not explain: P1 + HALT after 3 reads ──
reset()
snap({}, time.time())
sent.clear()
broker(SENT)
errs = []
real_err = portfolio._record_order_error
portfolio._record_order_error = lambda sym, venue, err, extra=None, repeat=False: errs.append((sym, venue, err))
reconciler._capital_place_order("TMF", 1.0, SPEC)
errs.clear()
base = capital_vault.last_order_at() + S
for i in range(reconciler.PENDING_SENT_MAX_READS):
    snap({"TM2611": 2}, base + i)
    round_read()
check(guard.halted() and len(errs) == 1 and "群益" in errs[0][2] and pending()["TMF"].get("halted"),
      "+2 for a +1 order: three reads, then one order_errors row and HALT", errs)
check(not audits("late_fill_adopted") and (portfolio.ledger_positions("capital").get("TMF") or {}).get("qty", 0) == 0,
      "…and nothing is booked")
portfolio._record_order_error = real_err

# ── read-only callers (no claim) leave parked orders alone ──
reset()
snap({}, time.time())
broker(SENT)
reconciler._capital_place_order("TMF", 1.0, SPEC)
snap({"TM2611": 1}, capital_vault.last_order_at() + S + 1)
reconciler.get_positions()
check("TMF" in pending() and not audits("late_fill_adopted"), "a read without claim does not book")

# ── the park file does not take the row after the broker accepted (audit P0-1) ──
reset()
snap({}, time.time())
sent.clear()
broker(SENT)
real_save = reconciler._save_pending_sent


def locked(_p, path=None):
    raise PermissionError(13, "locked (fake)")


reconciler._save_pending_sent = locked
raised = None
try:
    reconciler._capital_place_order("TMF", 1.0, SPEC)
except Exception as e:
    raised = e
reconciler._save_pending_sent = real_save
errs_now = json.load(open("manager/order_errors.json", encoding="utf-8")) if os.path.exists("manager/order_errors.json") else []
check(raised is None and guard.halted() and any("2315619624026" in e.get("error", "") and "可能已成交" in e.get("error", "")
                                                for e in errs_now),
      "park write fails after the send: no exception, HALT, an order_errors row naming the seq_no", (raised, errs_now))
snap({}, capital_vault.last_order_at() + S + 1)
round_read()
check(reconciler._capital_place_order("TMF", 1.0, SPEC) is False and len(sent) == 1,
      "…the park is kept in this process: the next round does not send again", sent)
snap({"TM2611": 1}, capital_vault.last_order_at() + S + 9)
round_read()
check(audits("late_fill_adopted") and (portfolio.ledger_positions("capital").get("TMF") or {}).get("qty") == 1.0,
      "…and a later read claims it from memory")
guard.clear_halt("test")

# the park file turns unreadable between the pre-send check and the park
reset()
snap({}, time.time())
sent.clear()


def corrupting(env, symbol, action, lots, intent, confirm_timeout=15):
    capital_vault.mark_order_sent()
    sent.append((symbol, action, lots, intent))
    open(PENDING, "w").write("{not json")
    return dict(SENT)


oc.place_futures_market_order = corrupting
reconciler._capital_place_order("TMF", 1.0, SPEC)
check(guard.halted() and getattr(reconciler, "_PARKED_MEM", {}).get(PENDING, {}).get("TMF", {}).get("lots") == 1.0,
      "park file unreadable at park time: HALT, the lots kept in this process")
os.remove(PENDING)
guard.clear_halt("test")

# ── the position shows up only on the second caught-up read (audit P1-1) ──
reset()
snap({}, time.time())
sent.clear()
broker(SENT)
reconciler._capital_place_order("TMF", 1.0, SPEC)
snap({}, capital_vault.last_order_at() + S + 1)
round_read()
check(reconciler._capital_place_order("TMF", 1.0, SPEC) is False and len(sent) == 1, "first read flat: still parked, no re-send")
snap({"TM2611": 1}, capital_vault.last_order_at() + S + 61)
got = round_read()
check(got.get("TMF", {}).get("size") == 1.0 and len(sent) == 1 and not audits("manual_month_excluded"),
      "the lot appears a read later: booked, one lot on the account, never re-sent", got)

# ── a short 'sent' (sell) parks −1 and is booked short ──
reset()
snap({}, time.time())
sent.clear()
broker(SENT)
reconciler._capital_place_order("TMF", -1.0, SPEC)
check((pending().get("TMF") or {}).get("lots") == -1.0, "a sell 'sent' parks −1")
snap({"TM2611": -1}, capital_vault.last_order_at() + S + 1)
got = round_read()
book = portfolio.ledger_positions("capital").get("TMF") or {}
check(got.get("TMF", {}).get("side") == "short" and book.get("side") == "short" and book.get("months") == {"2026-11": -1.0},
      "…and is booked short in 2026-11", (got, book))

# ── partial: 1 of 2 reported in TM2611, the rest parked against expected + 1 ──
reset()
snap({}, time.time())
sent.clear()
broker({"seq_no": "5", "status": "filled", "symbol": "TM2611", "fill_qty": 1.0, "avg_fill_price": 1.0,
        "fill_ids": ["a"], "market": "TF"})
reconciler._capital_place_order("TMF", 2.0, SPEC)
p = pending().get("TMF") or {}
check(p.get("lots") == 1.0 and p.get("expected") == {"TM2611": 1.0}, "partial 1/2: +1 parked, expected TM2611 +1", p)
portfolio._append_reconciler_log({"action": "BUY", "symbol": "TMF", "signed_diff": 2.0, "exchange": "capital",
                                  "asset_spec": SPEC, "contributors": [],
                                  "legs": [{"signed_diff": 1.0, "reduce_only": False, "executed_qty": 1.0,
                                            "exchange": "capital", "signed_qty": 1.0, "resolved_symbol": "TM2611"}]})
snap({"TM2611": 2}, capital_vault.last_order_at() + S + 1)
round_read()
book = portfolio.ledger_positions("capital").get("TMF") or {}
check(book.get("qty") == 2.0 and book.get("months") == {"2026-11": 2.0}, "…the rest arrives: book TM2611 +2", book)

# ── settlement day: the book's TM2610 cash-settles while +1 is parked (audit P2-3) ──
reset({"TMF@swap|capital": {"size": 1.0, "qty": 1.0, "venue": "capital", "symbol": "TMF",
                            "ts": "2026-10-20T00:00:00", "months": {"2026-10": 1.0}}})
snap({"TM2610": 1}, time.time())
sent.clear()
broker(SENT)
reconciler._capital_place_order("TMF", 1.0, SPEC)
snap({"TM2611": 1}, capital_vault.last_order_at() + S + 1)
try:
    round_read()
except Exception as e:
    print("     (settlement read:", e, ")")
check(not guard.halted() and audits("late_fill_adopted") and audits("late_fill_adopted")[-1]["contract"] == "TM2611",
      "the settled TM2610 is left out of the comparison: TM2611 +1 is adopted, no HALT", pending())

# ── one late-fill notice with the price the avg cost implies; none for the 0-lot leg (audit P3) ──
reset()
snap({}, time.time())
broker(SENT)
reconciler._capital_place_order("TMF", 1.0, SPEC)
snap({"TM2611": 1}, capital_vault.last_order_at() + S + 1)
round_read()
lo = json.loads(open("manager/orders.jsonl", encoding="utf-8").read().strip().splitlines()[-1])
check(tg == ["📈 買進 TMF 1 口 @ 46,597(成交回報晚到)"],
      "one late-fill notice in the machine's language (zh default), with the price", tg)
check(lo.get("late_fill") and lo["legs"][0].get("fill_price") == 46597.0, "…and the booked line carries that price", lo)

# ── two unchanged reads closer than PENDING_UNCHANGED_MIN_S do not clear (audit P1-1) ──
reset()
snap({}, time.time())
sent.clear()
broker(SENT)
reconciler._capital_place_order("TMF", 1.0, SPEC)
base = capital_vault.last_order_at() + S + 1
for dt in (0, GAP - 1):
    snap({}, base + dt)
    round_read()
check("TMF" in pending() and not audits("unfilled_order_cleared"),
      f"two unchanged reads {GAP - 1}s apart: still parked", pending())
snap({}, base + GAP)
round_read()
check(pending() == {} and len(audits("unfilled_order_cleared")) == 1, "a third read ≥GAP after the first clears it")

# ── HALT from three unexplained reads, then the user resumes: the park is dropped ──
reset()
snap({}, time.time())
sent.clear()
broker(SENT)
reconciler._capital_place_order("TMF", 1.0, SPEC)
base = capital_vault.last_order_at() + S
for i in range(reconciler.PENDING_SENT_MAX_READS):
    snap({"TM2611": 2}, base + i)
    round_read()
check(guard.halted() and pending()["TMF"].get("halted"), "three unexplained reads: HALT, park marked halted")
snap({"TM2611": 2}, base + 10)
round_read()
check("TMF" in pending() and not audits("parked_order_dropped"), "while HALT is set the halted park stays")
guard.clear_halt("test")
snap({"TM2611": 2}, base + 20)
round_read()
dropped = audits("parked_order_dropped")
check(pending() == {} and len(dropped) == 1 and dropped[0].get("lots") == 1.0 and not audits("late_fill_adopted"),
      "HALT cleared: the park is dropped as the user's, nothing booked", (pending(), dropped))
check(reconciler._capital_place_order("TMF", 1.0, SPEC) is not False and len(sent) == 2,
      "…and TMF orders resume", sent)

# ── the park file is unreadable before the send: nothing sent, one order_errors row ──
reset()
snap({}, time.time())
sent.clear()
broker(SENT)
open(PENDING, "w").write("{not json")
reconciler._capital_pending_unreadable_noted = False
errs = []
real_err = portfolio._record_order_error
portfolio._record_order_error = lambda sym, venue, err, extra=None, repeat=False: errs.append((sym, venue, err))
r1 = reconciler._capital_place_order("TMF", 1.0, SPEC)
r2 = reconciler._capital_place_order("TMF", -1.0, SPEC, reduce_only=True)
portfolio._record_order_error = real_err
check(r1 is False and r2 is False and sent == [], "unreadable park file: no 群益 order, entry or close", sent)
check(len(errs) == 1 and errs[0][1] == "capital" and "讀不出來" in errs[0][2],
      "…one order_errors row per process, not one per order", errs)
os.remove(PENDING)

# ── the late fill lands outside the front month: booked, audited ──
import lib.president_contracts as tw  # noqa: E402
real_front = tw.front_ym
tw.front_ym = lambda now=None: "2026-11"
for contract, flagged in (("TM2611", False), ("TM2612", True)):
    reset()
    snap({}, time.time())
    broker(SENT)
    reconciler._capital_place_order("TMF", 1.0, SPEC)
    snap({contract: 1}, capital_vault.last_order_at() + S + 1)
    round_read()
    odd = audits("late_fill_month_unexpected")
    check(audits("late_fill_adopted") and (bool(odd) == flagged)
          and (not flagged or (odd[0].get("contract") == contract and odd[0].get("front") == "2026-11")),
          f"late fill in {contract} with front 2026-11: month_unexpected audit {'yes' if flagged else 'no'}", odd)
tw.front_ym = real_front

# ── the avg cost implies the price of lots added on the same side ──
reset()
portfolio._append_reconciler_log({"action": "BUY", "symbol": "TMF", "signed_diff": 1.0, "exchange": "capital",
                                  "asset_spec": SPEC, "contributors": [],
                                  "legs": [{"signed_diff": 1.0, "reduce_only": False, "executed_qty": 1.0,
                                            "exchange": "capital", "signed_qty": 1.0, "resolved_symbol": "TM2611"}]})
snap({"TM2611": 1}, time.time(), cost=46000.0)
broker(SENT)
reconciler._capital_place_order("TMF", 1.0, SPEC)
snap({"TM2611": 2}, capital_vault.last_order_at() + S + 1, cost=46100.0)
round_read()
lo = json.loads(open("manager/orders.jsonl", encoding="utf-8").read().strip().splitlines()[-1])
check(lo.get("late_fill") and lo["legs"][0].get("fill_price") == 46200.0 and "46,200" in (tg or [""])[-1],
      "1 @ 46,000 → 2 @ 46,100: the late lot is priced 46,200", (lo, tg))

# ── a close's late fill has no price (avg cost of what is left says nothing about it) ──
reset()
portfolio._append_reconciler_log({"action": "BUY", "symbol": "TMF", "signed_diff": 1.0, "exchange": "capital",
                                  "asset_spec": SPEC, "contributors": [],
                                  "legs": [{"signed_diff": 1.0, "reduce_only": False, "executed_qty": 1.0,
                                            "exchange": "capital", "signed_qty": 1.0, "resolved_symbol": "TM2611"}]})
check((portfolio.ledger_positions("capital").get("TMF") or {}).get("qty") == 1.0, "book seeded TMF +1 in TM2611")
snap({"TM2611": 1}, time.time())
sent.clear()
broker(SENT)
reconciler._capital_place_order("TMF", -1.0, SPEC, reduce_only=True)
check((pending().get("TMF") or {}).get("lots") == -1.0, "a reduce 'sent' parks −1")
snap({}, capital_vault.last_order_at() + S + 1)
round_read()
lo = json.loads(open("manager/orders.jsonl", encoding="utf-8").read().strip().splitlines()[-1])
book = portfolio.ledger_positions("capital").get("TMF") or {}
check(lo.get("late_fill") and lo["action"] == "SELL" and "fill_price" not in lo["legs"][0]
      and tg == ["📉 平掉多單 TMF 1 口(成交回報晚到)"] and not book.get("qty"),
      "the close's late fill: booked SELL, no price on the line or in the notice, book flat", (lo, tg, book))

# ── a late-fill claim at every failure point: booked exactly once, never lost silently (v035 P1-1) ──
# booked under the row's park id first, the row dropped after; any failure keeps the row
import builtins  # noqa: E402
qty = lambda: (portfolio.ledger_positions("capital").get("TMF") or {}).get("qty") or 0.0  # noqa: E731
real_save = reconciler._save_pending_sent


def park_tmf():
    reset()
    snap({}, time.time())
    broker(SENT)
    reconciler._capital_place_order("TMF", 1.0, SPEC)
    snap({"TM2611": 1}, capital_vault.last_order_at() + S + 1)


def failing_read(exc):
    try:
        round_read()
    except exc as e:
        return e
    return None


# 1. the save is refused after booking: the round goes on, the next one drops the row by its id
park_tmf()


def locked(p, path=None):
    raise PermissionError(13, "locked by AV (fake)")


reconciler._save_pending_sent = locked
e = failing_read(OSError)
reconciler._save_pending_sent = real_save
check(e is None and qty() == 1.0 and "TMF" in pending() and len(audits("late_fill_adopted")) == 1,
      "save refused after booking: no exception (not a failed read), booked once, row still on disk", (e, qty()))
round_read()
check(qty() == 1.0 and pending() == {} and audits("late_fill_already_booked"),
      "…next round: the id is in the book, row dropped, not booked again", qty())

# 2. killed between the booked line and the save
park_tmf()
calls = {"n": 0}


def killed_on_save(p, path=None):
    calls["n"] += 1
    if calls["n"] == 1:
        raise KeyboardInterrupt("killed (fake)")
    return real_save(p, path)


reconciler._save_pending_sent = killed_on_save
e = failing_read(KeyboardInterrupt)
reconciler._save_pending_sent = real_save
round_read()
check(e is not None and qty() == 1.0 and pending() == {} and not guard.halted(),
      "killed after booking, before the save: one lot booked, row dropped next round", qty())

# 3. killed before the line is written
park_tmf()
real_book = portfolio.book_late_fill


def killed(*a, **k):
    raise KeyboardInterrupt("killed (fake)")


portfolio.book_late_fill = killed
e = failing_read(KeyboardInterrupt)
portfolio.book_late_fill = real_book
check(e is not None and qty() == 0 and "TMF" in pending(), "killed before booking: row kept, nothing booked")
round_read()
check(qty() == 1.0 and pending() == {}, "…next round books it once", qty())

# 4. the book cannot be read: HALT + order_errors, raised, row kept, no late_fill_adopted
park_tmf()
real_lb = portfolio.ledger_book


def unreadable(*a, **k):
    raise PermissionError(13, "orders.jsonl locked (fake)")


portfolio.ledger_book = unreadable
e = failing_read(PermissionError)
portfolio.ledger_book = real_lb
errs_now = json.load(open("manager/order_errors.json", encoding="utf-8")) if os.path.exists("manager/order_errors.json") else []
check(e is not None and guard.halted() and any("記不進帳本" in x.get("error", "") for x in errs_now)
      and "TMF" in pending() and qty() == 0 and not audits("late_fill_adopted") and not tg,
      "book unreadable: HALT + order_errors, raised, row kept, no adopted audit, no notice", (e, errs_now))
guard.clear_halt("test")
round_read()
check(qty() == 1.0 and pending() == {}, "…after resume booked once", qty())

# 5. the append is refused (full disk)
park_tmf()


def disk_full(path, mode="r", *a, **k):
    if str(path).endswith("orders.jsonl") and "a" in mode:
        raise OSError(28, "No space left on device (fake)")
    return builtins.open(path, mode, *a, **k)


portfolio.open = disk_full
try:
    e = failing_read(OSError)
finally:
    del portfolio.open
check(e is not None and guard.halted() and "TMF" in pending() and qty() == 0 and not audits("late_fill_adopted"),
      "append refused: HALT, raised, row kept, nothing booked", (e, pending()))
guard.clear_halt("test")
round_read()
check(qty() == 1.0 and pending() == {}, "…after resume booked once", qty())

# 6. append and the HALT file both refused: halted in memory only; after a restart the row books
park_tmf()
real_halt_path = guard.HALT_PATH
open("state/halt_blocker", "w").write("")
guard.HALT_PATH = "state/halt_blocker/HALT"
portfolio.open = disk_full
try:
    e = failing_read(OSError)
finally:
    del portfolio.open
    guard.HALT_PATH = real_halt_path
    os.remove("state/halt_blocker")
check(e is not None and guard._halt_flag and "TMF" in pending() and qty() == 0,
      "append and HALT file refused: halted in memory, row kept", (e, pending()))
guard._halt_flag = False  # the restart
round_read()
check(qty() == 1.0 and pending() == {}, "…after a restart booked once", qty())

# ── one snapshot read: positions and query_started_at never come from two files (v035 P2-2) ──
reset()
snap({}, time.time())
broker(SENT)
reconciler._capital_place_order("TMF", 1.0, SPEC)
order_at = capital_vault.last_order_at()
old = {"ok": True, "error": None, "holdings": [], "equity": 1.0, "currency": "TWD", "positions": [],
       "query_started_at": order_at - 5, "read_at": int(time.time())}
new = dict(old, query_started_at=order_at + S + 1)
reads = iter([old, new, new, new])
real_read = account_capital._read_snapshot
account_capital._read_snapshot = lambda: next(reads)
try:
    round_read()
except reconciler.CapitalCacheLagError:
    pass
account_capital._read_snapshot = real_read
check(not (pending().get("TMF") or {}).get("unchanged"),
      "an old snapshot read next to a newer start time is not counted as an unchanged read", pending())

# ── unchanged reads are a worker poll apart (v035 P2-3) ──
import re as _re  # noqa: E402
polls = [int(_re.search(r"^POLL_S = (\d+)", open(os.path.join(ROOT, "lib", w), encoding="utf-8").read(), _re.M).group(1))
         for w in ("capital_worker.py", "president_worker.py")]
check(GAP >= max(polls), f"PENDING_UNCHANGED_MIN_S ({GAP}) >= the workers' POLL_S ({polls})")

# ── cleared three times in a row: P1 + HALT, not a silent send/clear loop (v035 P2-4) ──
reset()
errs = []
real_err = portfolio._record_order_error
portfolio._record_order_error = lambda sym, venue, err, extra=None, repeat=False: errs.append((sym, venue, err))
sent.clear()
broker(SENT)
for i in range(reconciler.CLEARED_MAX):
    snap({}, capital_vault.last_order_at() + S + 1)
    reconciler._capital_place_order("TMF", 1.0, SPEC)
    t = capital_vault.last_order_at() + S + 1
    for dt in (0, GAP):
        snap({}, t + dt)
        round_read()
    if i < reconciler.CLEARED_MAX - 1:
        check(not guard.halted() and not errs, f"cleared {i + 1}/{reconciler.CLEARED_MAX}: no alarm yet")
portfolio._record_order_error = real_err
check(len(sent) == reconciler.CLEARED_MAX and guard.halted() and len(errs) == 1 and "連續" in errs[0][2]
      and audits("unfilled_order_cleared_repeatedly"),
      f"{reconciler.CLEARED_MAX} clears in a row: one order_errors row and HALT", errs)
guard.clear_halt("test")
reset()
broker(SENT)
for i in range(reconciler.CLEARED_MAX - 1):
    snap({}, capital_vault.last_order_at() + S + 1)
    reconciler._capital_place_order("TMF", 1.0, SPEC)
    t = capital_vault.last_order_at() + S + 1
    for dt in (0, GAP):
        snap({}, t + dt)
        round_read()
broker({"seq_no": "9", "status": "filled", "symbol": "TM2611", "fill_qty": 1.0, "avg_fill_price": 1.0,
        "fill_ids": ["f"], "market": "TF"})
snap({}, capital_vault.last_order_at() + S + 1)
reconciler._capital_place_order("TMF", 1.0, SPEC)
check(reconciler._capital_cleared() == {}, "a confirmed fill resets the count", reconciler._capital_cleared())

# ── more lots reported than were sent: not booked, P1 + HALT (v035 P2-5) ──
reset()
snap({}, time.time())
broker({"seq_no": "7", "status": "filled", "symbol": "TM2611", "fill_qty": 3.0, "avg_fill_price": 1.0,
        "fill_ids": ["a", "b", "c"], "market": "TF"})
errs = []
portfolio._record_order_error = lambda sym, venue, err, extra=None, repeat=False: errs.append((sym, venue, err))
r = reconciler._capital_place_order("TMF", 1.0, SPEC)
portfolio._record_order_error = real_err
check(r is False and guard.halted() and len(errs) == 1 and "比送出的" in errs[0][2] and pending() == {}
      and audits("order_overfill_refused"),
      "3 lots reported for a 1-lot order: nothing returned to book, one order_errors row, HALT", (r, errs))
guard.clear_halt("test")

# ── no price for a partial close (the avg cost of what is left says nothing) or after a partial fill ──
reset()
portfolio._append_reconciler_log({"action": "BUY", "symbol": "TMF", "signed_diff": 2.0, "exchange": "capital",
                                  "asset_spec": SPEC, "contributors": [],
                                  "legs": [{"signed_diff": 2.0, "reduce_only": False, "executed_qty": 2.0,
                                            "exchange": "capital", "signed_qty": 2.0, "resolved_symbol": "TM2611"}]})
snap({"TM2611": 2}, time.time(), cost=46000.0)
broker(SENT)
reconciler._capital_place_order("TMF", -1.0, SPEC, reduce_only=True)
snap({"TM2611": 1}, capital_vault.last_order_at() + S + 1, cost=93000.0)
round_read()
lo = json.loads(open("manager/orders.jsonl", encoding="utf-8").read().strip().splitlines()[-1])
check(lo.get("late_fill") and "fill_price" not in lo["legs"][0] and "@" not in (tg or ["@"])[-1],
      "partial close 2 → 1: no price even when the leftover avg cost would make one", (lo, tg))
reset()
portfolio._append_reconciler_log({"action": "BUY", "symbol": "TMF", "signed_diff": 1.0, "exchange": "capital",
                                  "asset_spec": SPEC, "contributors": [],
                                  "legs": [{"signed_diff": 1.0, "reduce_only": False, "executed_qty": 1.0,
                                            "exchange": "capital", "signed_qty": 1.0, "resolved_symbol": "TM2611"}]})
snap({"TM2611": 1}, time.time(), cost=46000.0)
broker({"seq_no": "5", "status": "filled", "symbol": "TM2611", "fill_qty": 1.0, "avg_fill_price": 46200.0,
        "fill_ids": ["a"], "market": "TF"})
reconciler._capital_place_order("TMF", 2.0, SPEC)
snap({"TM2611": 3}, capital_vault.last_order_at() + S + 1, cost=46100.0)
round_read()
lo = json.loads(open("manager/orders.jsonl", encoding="utf-8").read().strip().splitlines()[-1])
check(lo.get("late_fill") and "fill_price" not in lo["legs"][0], "late rest of a partial fill: no price", lo)

# ── the late-fill notice: machine language, the user's template, the late marker kept ──
reset()
open("state/reply_lang", "w").write("en")
snap({}, time.time())
broker(SENT)
reconciler._capital_place_order("TMF", 1.0, SPEC)
snap({"TM2611": 1}, capital_vault.last_order_at() + S + 1)
round_read()
os.remove("state/reply_lang")
check(tg == ["📈 Bought TMF 1 lots @ 46,597 (fill report came late)"], "reply_lang en: the English notice", tg)
reset()
json.dump(dict(CONFIG, messages={"order_buy": "BUY {symbol} x{amount:g}"}), open("manager/portfolio_config.json", "w"))
snap({}, time.time())
broker(SENT)
reconciler._capital_place_order("TMF", 1.0, SPEC)
snap({"TM2611": 1}, capital_vault.last_order_at() + S + 1)
round_read()
check(tg == ["BUY TMF x1 @ 46,597(成交回報晚到)"], "the user's order_buy template, late marker added", tg)

# ── close-all with lots parked: the root is left out, told once (audit P1-2 / v035 P2-1) ──
from manager import flatten  # noqa: E402
os.chdir(TMP)  # flatten chdirs to the repo on import; the rows below must land in the test dir
reset()
keys = getattr(flatten, "_parked_keys", None)
check(keys is not None and keys("capital") == set() and not os.path.exists("manager/order_errors.json"),
      "close-all, nothing parked: no key, no row")
json.dump({"TMF": {"root": "TMF", "lots": 1.0, "expected": {}}}, open(PENDING, "w"))
got_keys = keys("capital") if keys else None
errs_now = json.load(open("manager/order_errors.json", encoding="utf-8")) if os.path.exists("manager/order_errors.json") else []
check(got_keys == {"TMF"} and len(errs_now) == 1 and errs_now[0].get("kind") == "order_unconfirmed"
      and errs_now[0].get("close_all") is True and "先不平" in errs_now[0].get("error", "") and "TMF" in pending(),
      "close-all with TMF parked: TMF left out, one order_unconfirmed close_all row (P1); the park stays", errs_now)
open(PENDING, "w").write("{not json")
check(keys is not None and keys("capital") is None, "…an unreadable park file: every key may be parked (None)")
os.remove(PENDING)

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
