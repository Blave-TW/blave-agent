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
              PENDING, capital_vault.LAST_ORDER_PATH):
        if os.path.exists(p):
            os.remove(p)
    capital_vault._last_order_mem = 0.0
    reconciler._manual_noted.clear()
    getattr(reconciler, "_PARKED_MEM", {}).clear()
    tg.clear()
    json.dump(CONFIG, open("manager/portfolio_config.json", "w"))
    json.dump({"seeded_at": "2026-10-27T01:37:41.641854", "symbols": seed_symbols or {}},
              open("manager/ledger_seed.json", "w"))


def snap(positions, started):
    json.dump({"ok": True, "error": None, "holdings": [], "equity": 46483.0, "currency": "TWD",
               "positions": [{"symbol": c, "side": "buy" if q > 0 else "sell", "lots": abs(q), "avg_cost": 46597.0}
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
check(len(tg) == 1 and "Bought TMF 1 lots" in tg[0] and "46,597" in tg[0] and "late" in tg[0],
      "one 'Bought TMF 1 lots @ 46,597 (fill report came late)' notice", tg)
check(lo.get("late_fill") and lo["legs"][0].get("fill_price") == 46597.0, "…and the booked line carries that price", lo)

# ── close-all with lots parked: told, not silently skipped (audit P1-2) ──
from manager import flatten  # noqa: E402
reset()
note = getattr(flatten, "_note_parked", None)
check(note is not None and note("capital") == 0, "close-all, nothing parked: no row")
json.dump({"TMF": {"root": "TMF", "lots": 1.0, "expected": {}}}, open(PENDING, "w"))
n = note("capital") if note else 0
errs_now = json.load(open("manager/order_errors.json", encoding="utf-8")) if os.path.exists("manager/order_errors.json") else []
check(n == 1 and any("TMF" in e.get("error", "") and "沒收到成交回報" in e.get("error", "") and "手動平倉" in e.get("error", "")
                     for e in errs_now) and "TMF" in pending(),
      "close-all with TMF parked: one order_errors row (P1) to check the app; the park stays for the claim", errs_now)
open(PENDING, "w").write("{not json")
check(note is not None and note("capital") == 1, "…an unreadable park file counts as parked")
os.remove(PENDING)

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
