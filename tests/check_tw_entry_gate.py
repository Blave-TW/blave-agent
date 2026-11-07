"""Taiwan futures entries go only in the regular session, on a clock checked against the api — no network.

What it protects (統一, 11-04): a market IOC entry sent in the pre-open is accepted (0000)
and queued to the open; the reconciler read "no fill" and sent it again every round
(+110 lots simulated from a 5-lot target). A machine clock 237 s fast computed and sent in
the pre-open believing the market open. And 9868 (close beyond the lots held) was read as
'unknown', parked, and the close sent again every round.

Asserts:
1. lib/tw_clock: session edges (day 08:45:05–13:45, night 15:00:05–05:00, Sat before 05:00
   open, Mon before 05:00 closed), next_open, skew from Date (+Age), the RTT cap, the
   median, no samples = not known.
2. entry_hold: no samples → by the machine's clock; +237 s → held for the clock; samples
   back near 0 → free.
3. reconciler._tw_entry_held for 統一 and 群益: outside the session the entry waits and the
   main loop is woken at the open; a skewed clock holds it with ONE order_errors row and
   one order_denied_clock audit per episode, and resumes (entry_clock_resumed) once the
   clock is back. _capital_place_order: the entry is not sent, the close is.
4. _row_queued: a leg sent outside the session holds until the open + ORDER_SETTLE_S; a
   0000-only leg holds QUEUED_HOLD_S; a filled-status leg never holds.
5. order_president._await: 9868 raises with the reduce_only_rejected token; another 98xx
   stays 'unknown'.

Run: cd blave-agent && .venv/bin/python tests/check_tw_entry_gate.py
"""
import json, os, sys, tempfile, types
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
TMP = tempfile.mkdtemp(prefix="tw-gate-", dir=os.environ.get("SCRATCHPAD") or None)
os.chdir(TMP)
for d in ("manager", "state"):
    os.makedirs(d, exist_ok=True)
open("manager/portfolio_config.json", "w").write("{}")
_ut, _utu = types.ModuleType("unitrade"), types.ModuleType("unitrade.unitrade")
_utu.DOrderObject = type("DOrderObject", (), {})
sys.modules.setdefault("unitrade", _ut)
sys.modules.setdefault("unitrade.unitrade", _utu)

from lib import guard, order_president as op, president_vault, tw_clock  # noqa: E402
from manager import reconciler  # noqa: E402

tw_clock.SKEW_PATH = os.path.join(TMP, "state", "clock_skew.json")  # never the repo's state/
TPE = timezone(timedelta(hours=8))
fails = 0


def check(cond, msg, got=None):
    global fails
    print(("ok   " if cond else "FAIL ") + msg + ("" if cond else f"  got={got!r}"))
    fails += 0 if cond else 1


def T(y, mo, d, h, mi, s=0):
    return datetime(y, mo, d, h, mi, s, tzinfo=TPE).timestamp()


def samples(*skews, at):
    json.dump({"samples": [[at - 60 * (len(skews) - i), s] for i, s in enumerate(skews)]},
              open(tw_clock.SKEW_PATH, "w"))


def audits(name):
    try:
        return [json.loads(l) for l in open("state/audit.jsonl") if json.loads(l).get("event") == name]
    except OSError:
        return []


def errors():
    try:
        return json.load(open("manager/order_errors.json"))
    except OSError:
        return []


# ── 1. session and skew ──────────────────────────────────────────────────────
WED = (2026, 11, 4)
ins = tw_clock.in_session
check(not ins(T(*WED, 8, 44, 59)) and not ins(T(*WED, 8, 45, 0)) and ins(T(*WED, 8, 45, 5)),
      "day session opens at 08:45:05 (the 08:30–08:45 pre-open is out)")
check(ins(T(*WED, 13, 44, 59)) and not ins(T(*WED, 13, 45)), "day session ends at 13:45")
check(not ins(T(*WED, 14, 0, 5)) and not ins(T(*WED, 14, 56)) and not ins(T(*WED, 15, 0, 0))
      and ins(T(*WED, 15, 0, 5)), "14:00 and the 14:50–15:00 pre-open are out; night opens 15:00:05")
check(ins(T(2026, 11, 5, 4, 59)) and not ins(T(2026, 11, 5, 5, 0)), "night session runs to 05:00")
check(ins(T(2026, 11, 7, 4, 0)) and not ins(T(2026, 11, 7, 9, 0)) and not ins(T(2026, 11, 9, 4, 0)),
      "Saturday before 05:00 is Friday's night session; Saturday day and Monday before 05:00 are closed")
check(tw_clock.next_open(T(*WED, 14, 0)) == T(*WED, 15, 0, 5)
      and tw_clock.next_open(T(2026, 11, 7, 9, 0)) == T(2026, 11, 9, 8, 45, 5),
      "next_open: 14:00 → 15:00:05 the same day; Saturday → Monday 08:45:05")

check(tw_clock.skew() is None and tw_clock.entry_hold(T(*WED, 10, 0)) is None,
      "no samples: skew not known, an in-session entry goes")
resp = types.SimpleNamespace(headers={"Date": "Wed, 04 Nov 2026 06:56:00 GMT", "Age": "3"})
real = datetime(2026, 11, 4, 6, 56, 3, tzinfo=timezone.utc).timestamp() + 0.5
tw_clock._last_write = 0.0
tw_clock.note_reply(resp, real + 236.5, real + 237.5)
check(abs(tw_clock.skew(real + 238) - 237) < 0.01, "skew from Date + Age: machine 237 s ahead",
      tw_clock.skew(real + 238))
tw_clock._last_write = 0.0
tw_clock.note_reply(resp, real + 100, real + 100 + tw_clock.SAMPLE_MAX_RTT_S + 1)
check(len(tw_clock._samples()) == 1, "a reply slower than SAMPLE_MAX_RTT_S is not a sample")
tw_clock._last_write = 0.0
tw_clock.note_reply(resp, real + tw_clock.SKEW_MAX_S + 100, real + tw_clock.SKEW_MAX_S + 101)
check(len(tw_clock._samples()) == 1, "a Date more than SKEW_MAX_S off (a wrong api clock, a stale cache) is not a sample")
os.remove(tw_clock.SKEW_PATH)

# ── 2. entry_hold ────────────────────────────────────────────────────────────
now = T(*WED, 15, 0, 5) + 237  # machine 15:04:02, real 15:00:05
samples(237, 237, 237, at=now)
h = tw_clock.entry_hold(now)
check(h and h["why"] == "clock" and abs(h["skew"] - 237) < 1e-6, "+237 s: entry held for the clock", h)
samples(237, 237, 2, at=now)
check(tw_clock.entry_hold(now)["why"] == "clock", "one good sample of three does not resume")
samples(237, 2, 1, at=now)
check(tw_clock.entry_hold(now) is None, "two good samples of three: free")
samples(237, 237, 237, at=now - tw_clock.SAMPLE_MAX_AGE_S - 1)
check(tw_clock.entry_hold(now) is None, "samples older than SAMPLE_MAX_AGE_S: not known, not held")
os.remove(tw_clock.SKEW_PATH)
check(tw_clock.entry_hold(T(*WED, 14, 56))["why"] == "session"
      and tw_clock.entry_hold(T(*WED, 14, 56))["until"] == T(*WED, 15, 0, 5),
      "no samples, pre-open by the machine clock: waits for the session until 15:00:05")
check(tw_clock.queued_until(T(*WED, 14, 56)) == T(*WED, 15, 0, 5) and tw_clock.queued_until(T(*WED, 10, 0)) is None,
      "queued_until: the open outside the session, None inside")

# ── 3. reconciler gate, both venues ──────────────────────────────────────────
real_time = tw_clock.time.time
for venue in ("president", "capital"):
    reconciler._entry_wake_at = None
    reconciler._clock_noted = None
    tw_clock.time.time = lambda: T(*WED, 14, 0, 5)
    check(reconciler._tw_entry_held("TXF", venue) is True and reconciler._entry_wake_at == T(*WED, 15, 0, 5),
          f"{venue}: 14:00:05 entry waits, the main loop wakes at 15:00:05", reconciler._entry_wake_at)
    n_err, n_aud = len(errors()), len(audits("order_denied_clock"))
    tw_clock.time.time = lambda: now
    samples(237, 237, 237, at=now)
    held = [reconciler._tw_entry_held("TXF", venue) for _ in range(3)]
    check(all(held) and len(errors()) == n_err + 1 and len(audits("order_denied_clock")) == n_aud + 1,
          f"{venue}: +237 s holds every entry, one order_errors row and one audit per episode",
          (held, errors()[-1:]))
    check("快了約 4 分鐘" in errors()[-1]["error"] and "平倉照常" in errors()[-1]["error"]
          and errors()[-1].get("kind") == "clock_skew_hold",
          f"{venue}: the row says how far off and that closes go", errors()[-1:])
    samples(1, 0, 1, at=now)
    check(reconciler._tw_entry_held("TXF", venue) is False and reconciler._clock_noted is None
          and audits("entry_clock_resumed")[-1]["venue"] == venue,
          f"{venue}: clock fixed — entries resume on their own, entry_clock_resumed audited")
    os.remove(tw_clock.SKEW_PATH)
tw_clock.time.time = real_time

# _capital_place_order: entry not sent outside the session, close sent
sent = []
import lib.order_capital as oc  # noqa: E402
real_place = oc.place_futures_market_order
oc.place_futures_market_order = lambda env, sym, action, lots, intent: (
    sent.append((action, lots, intent)) or {"status": "filled", "fill_qty": lots, "avg_fill_price": 1.0, "symbol": "TX2611"})
tw_clock.time.time = lambda: T(*WED, 14, 56)
r_entry = reconciler._capital_place_order("TXF", 2)
r_close = reconciler._capital_place_order("TXF", -1, reduce_only=True)
tw_clock.time.time = real_time
oc.place_futures_market_order = real_place
check(r_entry is False and sent == [("sell", 1, "reduce")],
      "群益 pre-open: the entry is not sent, the close is", sent)

# ── 4. _row_queued ───────────────────────────────────────────────────────────
S = president_vault.ORDER_SETTLE_S
t0 = T(*WED, 14, 56)
row_pre = {"legs": [{"at": t0, "status": "sent", "statuscode": "0000", "queued_until": T(*WED, 15, 0, 5)}]}
check(reconciler._row_queued(row_pre, T(*WED, 15, 0, 5) + S - 1) and not reconciler._row_queued(row_pre, T(*WED, 15, 0, 5) + S),
      "a pre-open leg holds until the open + ORDER_SETTLE_S")
row_ack = {"legs": [{"at": t0, "status": "sent", "statuscode": "0000"}]}
check(reconciler._row_queued(row_ack, t0 + reconciler.QUEUED_HOLD_S - 1)
      and not reconciler._row_queued(row_ack, t0 + reconciler.QUEUED_HOLD_S),
      "a 0000-only leg (clock not trusted) holds QUEUED_HOLD_S")
check(not reconciler._row_queued({"legs": [{"at": t0, "status": "sent", "statuscode": "0002"}]}, t0 + 1),
      "a canceled IOC (0002) does not hold")
check(not reconciler._row_queued({"legs": [{"at": t0, "status": "sent"}]}, t0 + 1),
      "a 'sent' leg with neither 0000 nor broker_ack does not hold (統一's unknown legs unchanged)")

# 4b. 群益 'sent' (ncode 0 + sequence number, no report) is 統一's 0000: parked with broker_ack, and
# an unchanged account inside QUEUED_HOLD_S is "may still be queued", not "not taken" — even with
# no clock sample (a fast clock believes the session open, so queued_until is never written)
real_q, real_nets = reconciler._queued_until, reconciler._capital_nets
reconciler._queued_until = lambda: None
reconciler._capital_nets = lambda root=None: {"TXFK6": 0.0}
if os.path.exists(reconciler.CAPITAL_PENDING_PATH):
    os.remove(reconciler.CAPITAL_PENDING_PATH)
reconciler._capital_park("TXF", {"status": "sent", "fill_qty": 0, "seq_no": "0000000000001", "symbol": "TX0000"},
                         -1, {"TXFK6": 0.0})
row = reconciler._pending_sent(reconciler.CAPITAL_PENDING_PATH).get("TXF") or {}
leg = (row.get("legs") or [{}])[0]
check(leg.get("broker_ack") is True and "queued_until" not in leg, "群益 'sent' close leg parked with broker_ack", row)
at = float(leg.get("at") or 0)
reconciler._capital_claim_pending(at + 120)
check("TXF" in reconciler._pending_sent(reconciler.CAPITAL_PENDING_PATH),
      "unchanged account 2 min after a 群益 'sent': kept (may still be queued), not cleared for a re-send")
reconciler._capital_claim_pending(at + reconciler.QUEUED_HOLD_S + 1)
check("TXF" not in reconciler._pending_sent(reconciler.CAPITAL_PENDING_PATH),
      "past QUEUED_HOLD_S with the account unchanged: cleared, the next diff may send again")
# D3 (Wei 11-05): sNewClose=2 has no broker over-close refusal, so a close 群益 took without a report
# holds the next close until the row is settled; an unreported entry does not hold a close
sent2, real_place2 = [], oc.place_futures_market_order
oc.place_futures_market_order = lambda env, sym, action, lots, intent: (
    sent2.append((action, lots, intent)) or {"status": "sent", "fill_qty": 0, "seq_no": f"{len(sent2):013d}", "symbol": "TX00"})
r1 = reconciler._capital_place_order("TXF", -1, reduce_only=True)
r2 = reconciler._capital_place_order("TXF", -1, reduce_only=True)
check(len(sent2) == 1 and r2 is False
      and (reconciler._pending_sent(reconciler.CAPITAL_PENDING_PATH)["TXF"]["legs"][0].get("intent") == "reduce"),
      "a 群益 close came back 'sent': the next close waits, nothing sent twice", sent2)
_close_row = next((e for e in reversed(errors()) if e.get("kind") == "order_unconfirmed"), {})
check("下一筆平倉先停" in _close_row.get("error", "") and "16 分鐘" in _close_row.get("error", "")
      and "平倉照常" not in _close_row.get("error", ""),
      "the user's row for that close says the next close waits up to 16 min, never 'closes go on'", _close_row)
os.remove(reconciler.CAPITAL_PENDING_PATH)
reconciler._capital_park("TXF", {"status": "sent", "fill_qty": 0, "seq_no": "0000000000009", "symbol": "TX00"},
                         1, {"TXFK6": 0.0}, "entry")
r3 = reconciler._capital_place_order("TXF", -1, reduce_only=True)
check(len(sent2) == 2, "an unreported entry does not hold a close", sent2)
oc.place_futures_market_order = real_place2
os.remove(reconciler.CAPITAL_PENDING_PATH)
os.remove("manager/order_errors.json")   # keeps at most 5 rows: the counts below need room
reconciler._capital_park("TXF", {"status": "filled", "fill_qty": 1, "seq_no": "0000000000002", "symbol": "TXFK6"},
                         2, {"TXFK6": 0.0})
row = reconciler._pending_sent(reconciler.CAPITAL_PENDING_PATH).get("TXF") or {}
check(row and not any(l.get("broker_ack") for l in row.get("legs") or []),
      "a short 'filled' (IOC rest canceled) is not marked broker_ack", row)
os.remove(reconciler.CAPITAL_PENDING_PATH)
reconciler._queued_until, reconciler._capital_nets = real_q, real_nets


# ── 5. 9868 is a rejection ───────────────────────────────────────────────────
def await_with(code):
    rep = op._Reports()
    rep.on_reply(types.SimpleNamespace(seq="S1", orderno="Q1", statuscode=code, orderstatus="FUF0092 無足夠口數留倉平倉",
                                       matchqty=0, nomatchqty=1, productid="TXFK6"))
    return op._await(rep, "S1", 1, 0.2, {"symbol": "TXFK6", "venue": "president"})


try:
    await_with("9868")
    check(False, "9868 raises")
except op.PresidentError as e:
    check(str(e).startswith("[order_reject:reduce_only_rejected]") and "9868" in str(e),
          "9868 raises PresidentError with the reduce_only_rejected token", str(e))
r = await_with("9861")
check(r["status"] == "unknown", "another 98xx stays 'unknown' (its meaning is not documented)", r)

# ── 6. the three HALT sources: HALT is a full freeze (lib/guard), so their reason never says closes go
#       on, in zh or en, and they write no tw_entry_hold row (the platform's halt P1 carries the reason) ──
import lib.portfolio as _pf  # noqa: E402
_real_lang = _pf._machine_lang
for lang in ("zh", "en"):
    _pf._machine_lang = lambda _l=lang: _l
    texts = {"words": reconciler._halt_words("群益", "群益下單軟體", "TXF", 2, 3, "0 口", "2 口")}
    n_rows = len(errors())
    tripped = []
    real_trip = reconciler.guard.trip_halt
    reconciler.guard.trip_halt = lambda reason, source, **k: tripped.append(reason)
    reconciler._halt_unknown_booked("TXF", "TXFL6", {"legs": [{"at": 1}]}, "president")
    real_book = _pf.book_late_fill
    _pf.book_late_fill = lambda *a, **k: (_ for _ in ()).throw(PermissionError("locked"))
    try:
        reconciler._book_late_fill_or_halt("統一", "TXF", "president", "TXFL6", 1, "TXFL6@1")
    except PermissionError:
        pass
    _pf.book_late_fill = real_book
    reconciler.guard.trip_halt = real_trip
    texts["unknown"], texts["late"] = (tripped + ["", ""])[:2]
    stated = all(("平倉與停損也不會送" in t) if lang == "zh" else ("All trading paused, closes and stops too" in t) for t in texts.values())
    check(stated and not any("平倉照常" in t or "closes still run" in t for t in texts.values())
          and len(errors()) == n_rows and not any(e.get("kind") == "tw_entry_hold" for e in errors()[n_rows:]),
          f"{lang}: the three HALT sources say a full freeze (closes and stops too), never 'closes go on'; no tw_entry_hold row",
          texts)
    # the api keeps 200 characters of a halt reason (TG / email): the steps at the end must survive it
    check(all(0 < len(t) <= 200 for t in texts.values()) and all(("「啟動下單」" in t and "解除暫停" not in t) if lang == "zh" else ("Start trading" in t and "Release pause" not in t) for t in texts.values())
          and (("核對 TXF 部位，差額 Blave 不會處理" in texts["words"] and "平掉" not in texts["words"]) if lang == "zh"
               else ("won't handle any difference" in texts["words"] and "close it there" not in texts["words"])),
          f"{lang}: every HALT reason fits the api's 200 characters, the steps included; the unexplained one never says to close it (designer 11-07) ({ {k: len(v) for k, v in texts.items()} })")
_pf._machine_lang = _real_lang

# ── 7. under HALT nothing goes out: the two non-HALT tw_entry_hold sources write no row then ──────
n_rows = len(errors())
real_halted = reconciler.guard.halted
reconciler.guard.halted = lambda: True
reconciler._pending_unreadable_noted = reconciler._capital_pending_unreadable_noted = False
reconciler._note_pending_unreadable("TXF", "unreadable (fake)")
reconciler._note_capital_pending_unreadable("TXF", "unreadable (fake)")
reconciler._claim_save_fails.clear()
for _ in range(reconciler.CLAIM_SAVE_FAILS_MAX):
    reconciler._save_claimed({}, "president", end_of_round=True, save=lambda p: (_ for _ in ()).throw(PermissionError("locked")))
reconciler.guard.halted = real_halted
held_rows = errors()[n_rows:]
reconciler._note_pending_unreadable("TXF", "unreadable (fake)")
check(not held_rows and errors()[-1].get("kind") == "tw_entry_hold",
      "under HALT the unreadable / unsaved park file writes no tw_entry_hold row ('closes go on' is false then); "
      "once HALT is cleared the unreadable row is written", (held_rows, errors()[-1:]))
n_rows = len(errors())
reconciler._save_claimed({}, "president", end_of_round=True, save=lambda p: (_ for _ in ()).throw(PermissionError("locked")))
after = errors()[n_rows:]
check(len(after) == 1 and after[0].get("kind") == "tw_entry_hold" and "存不進" in after[0].get("error", after[0].get("message", str(after[0]))),
      "the save-refused row held back under HALT is written on the first refused round after HALT is cleared", after)

print("\ncheck_tw_entry_gate: " + ("all ok" if not fails else f"FAILED ({fails})"))
sys.exit(1 if fails else 0)
