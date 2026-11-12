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
8. close_hold: a close waits while the broker takes no order (13:45–14:51, 05:00–08:31,
   weekends; wake 14:51 / 08:31), goes in the pre-open; no samples → a 15-min slack past each
   close (close-all's deferral), never released on a weekend; a week enumerated: close held ⇒
   entry held, login window shut ⇒ entry held. The reconciler (統一, 群益) holds the close without
   a row and the flip's entry with it; on a clock not measured (no samples, 1–2 that disagree,
   or past SKEW_MAX_S) it first asks the api once (tw_clock.probe, rate-limited), then holds on
   the machine's clock and says so once per spell (tw_clock_unchecked, HALT or not; the same row
   not again within CLOCK_REPEAT_S); HALT's close-all leg goes at the pre-open, the entry stays
   shut. A SessionClosed close: one Chinese row, counted after.
9. order_president: outside president_vault.session_window, SessionClosed before _claim and
   the login — a close on the corrected clock (the machine's when not measured).
10. 9876 is a plain refusal.
11. close-all after the close: 台指期 deferred to the first round after the open, dropped and
   said on the venue's row when 啟動下單 comes first; nothing deferred after a restart stop.

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
h_lone = tw_clock.entry_hold(real + 238)
check(len(tw_clock._samples()) == 1 and tw_clock.skew(real + 238) is None and tw_clock.gross_skew(real + 238) is None
      and h_lone and h_lone["why"] == "clock" and tw_clock._unconfirmed(real + 238) is not None,
      "one sample 237 s off: entries held on it, closes not corrected until a second confirms it (Wei)", tw_clock._samples())
tw_clock._last_write = 0.0
tw_clock.note_reply(resp, real + 236.5, real + 237.5)
check(abs(tw_clock.skew(real + 238) - 237) < 0.01, "skew from Date + Age, confirmed by a second: machine 237 s ahead",
      tw_clock.skew(real + 238))
tw_clock._last_write = 0.0
tw_clock.note_reply(resp, real + 236.5, real + 237.5)
tw_clock._last_write = 0.0
tw_clock.note_reply(resp, real + 100, real + 100 + tw_clock.SAMPLE_MAX_RTT_S + 1)
check(len(tw_clock._samples()) == tw_clock.KEEP and tw_clock._samples()[-1][1] == 237,
      "a reply slower than SAMPLE_MAX_RTT_S is not a sample")
tw_clock._last_write = 0.0
tw_clock.note_reply(resp, real + tw_clock.SKEW_MAX_S + 100, real + tw_clock.SKEW_MAX_S + 101)
check(tw_clock._samples()[-1][1] > tw_clock.SKEW_MAX_S,
      "a Date more than SKEW_MAX_S off is kept (said as a clock P1, not dropped)", tw_clock._samples())
# one bad Date beside one good: not averaged into "an hour off" — neither corrected by nor said
samples(0, 2 * 3600, at=T(*WED, 10, 0))
check(tw_clock.skew(T(*WED, 10, 0)) is None and tw_clock.gross_skew(T(*WED, 10, 0)) is None
      and tw_clock.entry_hold(T(*WED, 10, 0)) is None,
      "two samples (one bad Date): not measured — no 1 h correction, no clock hold on entries")
samples(0, 0, 2 * 3600, at=T(*WED, 10, 0))
check(tw_clock.skew(T(*WED, 10, 0)) == 0, "three samples, one bad Date: the median, 0")
# 1–2 samples that agree within SKEW_BLOCK_S: measured, corrected by and held for (r3 Y1)
samples(600, at=T(*WED, 10, 0))
h1 = tw_clock.entry_hold(T(*WED, 10, 0))
samples(600, 640, at=T(*WED, 10, 0))
h2 = tw_clock.entry_hold(T(*WED, 10, 0))
skew2 = tw_clock.skew(T(*WED, 10, 0))
samples(-600, -590, at=T(*WED, 13, 30))
c_in, c_out = tw_clock.close_hold(T(*WED, 13, 30)), tw_clock.close_hold(T(*WED, 13, 40))
samples(30, at=T(*WED, 10, 0))
lone_small = tw_clock.skew(T(*WED, 10, 0))
check(h1 and h1["why"] == "clock" and h2 and h2["why"] == "clock" and skew2 == 620 and c_in is None and c_out is not None
      and lone_small == 30,
      "1–2 samples: entries held on +600 alone and on +600,+640 (their mean, 620, corrects); two at -600 correct closes "
      "(machine 13:30 = real 13:40 goes, machine 13:40 = real 13:50 waits — no 15-min slack); a lone 30 s is used as is",
      (h1, h2, skew2, c_in, c_out, lone_small))
samples(600, 600 + tw_clock.SKEW_BLOCK_S + 1, at=T(*WED, 10, 0))
s_dis = tw_clock.gross_skew(T(*WED, 10, 0))
samples(2 * 3600, at=T(*WED, 10, 0))
s_far1 = tw_clock.gross_skew(T(*WED, 10, 0))
samples(2 * 3600, 2 * 3600, at=T(*WED, 10, 0))
s_far2 = tw_clock.gross_skew(T(*WED, 10, 0))
e_far2 = tw_clock.entry_hold(T(*WED, 10, 0))
check(e_far2 and e_far2["why"] == "clock",
      "1–2 agreeing samples hours off: not said (gross None) but no entry on them either", e_far2)
check(s_dis is None and s_far1 is None and s_far2 is None,
      "two samples apart by more than SKEW_BLOCK_S, or 1–2 past SKEW_MAX_S: not measured (a lone bad Date)",
      (s_dis, s_far1, s_far2))
samples(3 * 3600, 3 * 3600, 3 * 3600, at=T(*WED, 14, 10))
h = tw_clock.entry_hold(T(*WED, 14, 10))
check(tw_clock.skew(T(*WED, 14, 10)) is None and tw_clock.gross_skew(T(*WED, 14, 10)) == 3 * 3600
      and h and h["why"] == "clock" and h["skew"] == 3 * 3600 and tw_clock.skew_words(h["skew"]) == "快了約 3 小時",
      "past SKEW_MAX_S: not trusted to correct by (skew() not known), entries held for the clock, said in hours", h)
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
    reconciler._last_said = (None, 0.0)
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
real_close_hold = tw_clock.close_hold
tw_clock.close_hold = lambda now=None: None  # these closes run on the wall clock: pinned to a taking broker
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
tw_clock.close_hold = real_close_hold


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

# ── 8. closes wait while the broker takes no order (13:45–14:51, 05:00–08:31, weekends) ──────
SAT, MON = (2026, 11, 7), (2026, 11, 9)
ch = tw_clock.close_hold


def with_samples(at, *skews):
    samples(*(skews or (0, 0, 0)), at=at)


def no_samples():
    if os.path.exists(tw_clock.SKEW_PATH):
        os.remove(tw_clock.SKEW_PATH)


with_samples(T(*WED, 13, 50))
h = ch(T(*WED, 13, 50))
check(h and h["until"] == T(*WED, 14, 51), "13:50 (samples): the close waits, until 14:51 (pre-open + 60 s)", h)
with_samples(T(*WED, 6, 0))
check((ch(T(*WED, 6, 0)) or {}).get("until") == T(*WED, 8, 31), "06:00 (samples): the close waits until 08:31", ch(T(*WED, 6, 0)))
with_samples(T(*WED, 14, 50, 30))
check((ch(T(*WED, 14, 50, 30)) or {}).get("until") == T(*WED, 14, 51), "14:50:30 still waits (a send a second early is 9902)")
for hm, what in (((14, 52, 0), "14:52 pre-open"), ((15, 0, 2), "15:00:02 (the open, before in_session's +5 s)"),
                 ((8, 45, 2), "08:45:02"), ((8, 31, 0), "08:31 pre-open"), ((13, 44, 50), "13:44:50"),
                 ((4, 59, 0), "04:59 night session")):
    with_samples(T(*WED, *hm))
    check(ch(T(*WED, *hm)) is None, f"{what} (samples): the close goes")
with_samples(T(*SAT, 4, 59))
check(ch(T(*SAT, 4, 59)) is None, "Saturday 04:59 is Friday's night session: the close goes")
with_samples(T(*SAT, 6, 0))
check((ch(T(*SAT, 6, 0)) or {}).get("until") == T(*MON, 8, 31), "Saturday 06:00: waits to Monday 08:31")
with_samples(T(*MON, 4, 0))
check((ch(T(*MON, 4, 0)) or {}).get("until") == T(*MON, 8, 31), "Monday 04:00 (no Sunday night session): waits to 08:31")
with_samples(T(*WED, 13, 42) + 237, 237, 237, 237)
check(ch(T(*WED, 13, 42) + 237) is None, "clock +237 s (measured), real 13:42: the close goes")
with_samples(T(*WED, 14, 56) + 237, 237, 237, 237)
check(ch(T(*WED, 14, 56) + 237) is None, "clock +237 s, real 14:56 pre-open: the close goes")
with_samples(T(*WED, 13, 50) + 237, 237, 237, 237)
check((ch(T(*WED, 13, 50) + 237) or {}).get("until") == T(*WED, 14, 51) + 237,
      "clock +237 s, real 13:50: waits, until on the machine's clock")
no_samples()
check(ch(T(*WED, 13, 46)) is None and ch(T(*WED, 13, 59, 59)) is None,
      "no samples, machine 13:46 / 13:59:59: the close goes (a fast clock must not hold a stop)")
check(ch(T(*WED, 13, 44, 50) + 120) is None, "no samples, clock 2 min fast at real 13:44:50: the close goes")
check((ch(T(*WED, 14, 0, 1)) or {}).get("until") == T(*WED, 14, 51), "no samples, 14:00:01: waits until 14:51")
check(ch(T(*SAT, 5, 14)) is None and (ch(T(*SAT, 5, 16)) or {}).get("until") == T(*MON, 8, 31),
      "no samples: Saturday 05:14 goes, 05:16 waits to Monday 08:31")
samples(0, 0, 0, at=T(*SAT, 12, 0) - tw_clock.SAMPLE_MAX_AGE_S - 60)
check((ch(T(*SAT, 12, 0)) or {}).get("until") == T(*MON, 8, 31),
      "samples expired over the weekend (Saturday 12:00): still waits to Monday 08:31, never released")
no_samples()

# enumerated: a held close always means a held entry (a flip never opens the other side on a held
# close), and the lib's login window refusing always means a held entry — every minute of a week
real_skew = tw_clock.skew
bad = []
for s_ in (None, 0, 50, -50, 237, -237):
    tw_clock.skew = lambda now=None, _s=s_: _s
    for m in range(7 * 24 * 60):
        for off in (0, 2, 30):
            now = T(*MON, 0, 0) + m * 60 + off
            eh = tw_clock.entry_hold(now)
            if ch(now) is not None and eh is None:
                bad.append(("close", s_, now))
            win = president_vault.session_window(datetime.fromtimestamp(now, TPE))
            if win is None and eh is None:
                bad.append(("window", s_, now))
tw_clock.skew = real_skew
check(not bad, "every minute of a week, skew none/0/±50/±237: close held ⇒ entry held; login window shut ⇒ entry held",
      [(k, s_, datetime.fromtimestamp(t, TPE).isoformat()) for k, s_, t in bad[:3]])

# reconciler: the close waits, the main loop wakes at the pre-open, no row; the flip's entry waits too
import lib.portfolio as _pfm  # noqa: E402
sends = []
real_pfm, real_ps = op.place_futures_market_order, reconciler._pending_sent
real_cu, real_pn, real_bm = op.snapshot_caught_up, reconciler._president_nets, _pfm.book_months
real_cpf = oc.place_futures_market_order
op.place_futures_market_order = lambda env, sym, action, lots, intent, **k: (
    sends.append(("president", action, lots, intent))
    or {"status": "filled", "fill_qty": lots, "avg_fill_price": 1.0, "symbol": "TMFK6"})
oc.place_futures_market_order = lambda env, sym, action, lots, intent: (
    sends.append(("capital", action, lots, intent))
    or {"status": "filled", "fill_qty": lots, "avg_fill_price": 1.0, "symbol": "TM2611"})
reconciler._pending_sent = lambda path=None: {}
op.snapshot_caught_up = lambda: (True, 0.0, 0.0)
reconciler._president_nets = lambda: {}
_pfm.book_months = lambda venue=None: None


def at_time(ts):
    tw_clock.time.time = lambda: ts


for venue, place, sym in (("president", reconciler._president_place_order, "TMF"),
                          ("capital", reconciler._capital_place_order, "TXF")):
    with_samples(T(*WED, 13, 50))
    at_time(T(*WED, 13, 50))
    reconciler._next_round()
    reconciler._entry_wake_at = None
    n_rows, n_sends = len(errors()), len(sends)
    r_close = place(sym, -1, reduce_only=True)
    r_entry = place(sym, 4)
    check(r_close is False and r_entry is False and len(sends) == n_sends and sym in reconciler._closes_deferred
          and reconciler._entry_wake_at == T(*WED, 14, 51) and len(errors()) == n_rows,
          f"{venue} 13:50: the close waits (no send, no row), the flip's entry waits too, wake at 14:51",
          (r_close, r_entry, sends[n_sends:], reconciler._entry_wake_at, errors()[n_rows:]))
    at_time(T(*WED, 14, 52))
    reconciler._next_round()
    r_close = place(sym, -1, reduce_only=True)
    check(r_close and sends[-1] == (venue, "sell", 1, "reduce"), f"{venue} 14:52 pre-open: the close goes", sends[-1:])
tw_clock.time.time = real_time

# not measured (samples expired, fewer than KEEP, or past SKEW_MAX_S): closes wait on this machine's own
# clock (Wei — sent every round after hours, each a 統一 login refused 9876), said once per spell as
# tw_clock_unchecked (never 平倉照常; 新倉 only where entries are held for the clock), HALT or not
logins = []
real_login = president_vault.login
president_vault.login = lambda *a, **k: logins.append(1) or (_ for _ in ()).throw(RuntimeError("no login here"))
SAT12 = T(*SAT, 12, 0)
UNCHECKED = (("samples expired", lambda: samples(0, 0, 0, at=SAT12 - tw_clock.SAMPLE_MAX_AGE_S - 60), "量不到", "unmeasured"),
             ("two samples", lambda: samples(0, 2 * 3600, at=SAT12), "量不到", "unmeasured"),
             ("samples past SKEW_MAX_S", lambda: samples(*(3 * [3 * 3600]), at=SAT12), "3 小時", "far"))
real_halted = reconciler.guard.halted
for halted in (False, True):
    reconciler.guard.halted = lambda _h=halted: _h
    for label, setup, words, clock in UNCHECKED:
        clock = "far_halt" if halted and clock == "far" else clock
        setup()
        at_time(SAT12)
        reconciler._clock_noted = None
        reconciler._unchecked_noted = False
        reconciler._last_said = (None, 0.0)
        json.dump([], open("manager/order_errors.json", "w"))
        n_sends = len(sends)
        outs = []
        for _ in range(3):
            reconciler._next_round()
            if halted:
                with guard.halt_close_pass("TMF", "close_all_deferred"):
                    outs.append(reconciler._president_place_order("TMF", -1, reduce_only=True))
            else:
                outs.append(reconciler._president_place_order("TMF", -1, reduce_only=True))
        tw_clock.time.time = real_time
        rows = errors()
        tag = f"{'HALT, ' if halted else ''}{label}"
        check(outs == [False] * 3 and len(sends) == n_sends and not logins and "TMF" in reconciler._closes_deferred,
              f"Saturday 12:00, {tag}, three rounds: the close waits on the machine's clock — no send, no login", (outs, sends[n_sends:], logins))
        check(len(rows) == 1 and rows[0].get("kind") == "tw_clock_unchecked" and rows[0].get("clock") == clock
              and words in rows[0]["error"] and "平倉照常" not in rows[0]["error"] and "開盤才送" in rows[0]["error"]
              and ("新倉暫停" in rows[0]["error"]) == (clock == "far"),
              f"{tag}: one tw_clock_unchecked P1 row ({clock}) for the three rounds, closes wait for the machine's clock", rows)
reconciler.guard.halted = real_halted
# HALT cleared with the clock still past SKEW_MAX_S: entries now held for it — the full sentence, once
samples(*(3 * [3 * 3600]), at=SAT12)
at_time(SAT12)
reconciler._tw_close_held("TMF", "president")
reconciler._tw_close_held("TMF", "president")
tw_clock.time.time = real_time
rows = errors()
check(len(rows) == 2 and rows[1].get("clock") == "far" and "新倉暫停" in rows[1]["error"],
      "HALT cleared, still past SKEW_MAX_S: one more row, now saying entries are paused", rows)
reconciler._clock_noted = None
reconciler._unchecked_noted = False
no_samples()
# HALT, not measured, machine 14:52: close_hold lets it go (pre-open), close-all's wait for the open holds
# it on this machine's clock — said by that hold too, once for three rounds
reconciler.guard.halted = lambda: True
json.dump([], open("manager/order_errors.json", "w"))
n_sends = len(sends)
outs = []
for _ in range(3):
    at_time(T(*WED, 14, 52))
    reconciler._next_round()
    with guard.halt_close_pass("TMF", "close_all_deferred"):
        outs.append(reconciler._president_place_order("TMF", -1, reduce_only=True))
    tw_clock.time.time = real_time
rows = errors()
check(outs == [False] * 3 and len(sends) == n_sends and tw_clock.close_hold(T(*WED, 14, 52)) is None
      and [(r.get("kind"), r.get("clock")) for r in rows] == [("tw_clock_unchecked", "unmeasured")],
      "HALT, not measured, 14:52: the wait-for-the-open hold says the unmeasured clock, once", (outs, rows))
# HALT, past SKEW_MAX_S, fixed, then off again in the same HALT: the round ends the far_halt spell,
# but the same row is not written again within CLOCK_REPEAT_S (flicker); past it, it is
reconciler._unchecked_noted = False
reconciler._last_said = (None, 0.0)
json.dump([], open("manager/order_errors.json", "w"))
for sk, t_ in ((3 * 3600, SAT12), (0, SAT12), (3 * 3600, SAT12), (0, SAT12 + 60),
               (3 * 3600, SAT12 + reconciler.CLOCK_REPEAT_S + 60)):
    samples(sk, sk, sk, at=t_)
    at_time(t_)
    reconciler._next_round()
    reconciler._tw_close_held("TMF", "president")
    tw_clock.time.time = real_time
rows = errors()
check([r.get("clock") for r in rows] == ["far_halt", "far_halt"],
      "HALT: off, fixed, off again within the hour: one row; off again past CLOCK_REPEAT_S: a second", rows)
reconciler.guard.halted = real_halted
reconciler._clock_noted = None
reconciler._unchecked_noted = False
no_samples()
# the unchecked note: a fresh spell once samples came back in between — seen by a round alone,
# with no TW futures leg in it to run _clock_episode; flicker (3→2 disagreeing→3, or 3→0→3) within
# CLOCK_REPEAT_S writes nothing new, a spell past it does
reconciler._last_said = (None, 0.0)
json.dump([], open("manager/order_errors.json", "w"))
T_U = T(*WED, 3, 0)
at_time(T_U)
reconciler._unchecked_close_note("TMF", "president", tw_clock, False)
for flick in (lambda: samples(0, 0, 0, at=T_U), lambda: samples(0, 200, at=T_U),
              lambda: samples(0, 0, 0, at=T_U), no_samples):
    flick()
    reconciler._next_round()
    reconciler._unchecked_close_note("TMF", "president", tw_clock, False)
n_flicker = len(errors())
samples(0, 0, 0, at=T_U)
reconciler._next_round()
no_samples()
at_time(T_U + reconciler.CLOCK_REPEAT_S + 1)
reconciler._unchecked_close_note("TMF", "president", tw_clock, False)
reconciler._unchecked_close_note("TMF", "president", tw_clock, False)
tw_clock.time.time = real_time
check(n_flicker == 1 and len(errors()) == 2,
      "unchecked clock: flicker within CLOCK_REPEAT_S writes one row; a spell past it, a second", (n_flicker, errors()))
reconciler._unchecked_noted = False
reconciler._last_said = (None, 0.0)
# bands: ≤ SKEW_MAX_S and past it are different rows; samples gone is not "back within 60 s"
json.dump([], open("manager/order_errors.json", "w"))
reconciler._clock_noted = None
n_res = len(audits("entry_clock_resumed"))
for sk in (237, 3 * 3600, 3 * 3600, 237, 237):
    samples(sk, sk, sk, at=real_time())
    reconciler._clock_episode("TMF", "president", tw_clock)
kinds = [(r.get("kind"), r.get("clock")) for r in errors()]
check(kinds == [("clock_skew_hold", None), ("tw_clock_unchecked", "far"), ("clock_skew_hold", None)],
      "a band change (≤1 h ↔ >1 h) is a new row; the same band again is not", kinds)
no_samples()
reconciler._clock_episode("TMF", "president", tw_clock)
check(reconciler._clock_noted is None and len(audits("entry_clock_resumed")) == n_res,
      "samples gone: the episode ends without entry_clock_resumed (the clock is not back, only unmeasured)")
samples(1, 0, 1, at=real_time())
reconciler._clock_noted = "off"
reconciler._clock_episode("TMF", "president", tw_clock)
check(len(audits("entry_clock_resumed")) == n_res + 1, "back within 60 s: entry_clock_resumed")
no_samples()
reconciler._clock_noted = None

# the lib's window refuses (SessionClosed): the reconciler defers the close, says it once (Chinese, no
# kind: the existing kinds all say closes go), retries in a minute
op.place_futures_market_order = lambda *a, **k: (_ for _ in ()).throw(op.SessionClosed("outside the window (fake)"))
tw_clock.close_hold = lambda now=None: None
reconciler._next_round()
reconciler._entry_wake_at = None
n_rows = len(errors())
r = reconciler._president_place_order("TMF", -1, reduce_only=True)
new = errors()[n_rows:]
check(r is False and "TMF" in reconciler._closes_deferred and len(new) == 1 and "kind" not in new[0]
      and new[0]["error"].startswith("統一期貨現在不收單") and "outside" not in new[0]["error"]
      and reconciler._entry_wake_at and 0 < reconciler._entry_wake_at - real_time() <= 61,
      "the lib refuses outside its window: close deferred, one Chinese order_errors row, retried in a minute", new)
reconciler._next_round()
reconciler._president_place_order("TMF", -1, reduce_only=True)
again = errors()[n_rows:]
check(len(again) == 1 and again[0].get("count") == 2, "the next minute's refusal: the same row counted, no new row", again)
check(reconciler._president_place_order("TMF", 4) is False, "…and that round's entry waits")
tw_clock.close_hold = real_close_hold

# under HALT a close-all leg (halt_close_pass) at the pre-open goes; the entry does not
op.place_futures_market_order = lambda env, sym, action, lots, intent, **k: (
    sends.append(("president", action, lots, intent))
    or {"status": "filled", "fill_qty": lots, "avg_fill_price": 1.0, "symbol": "TMFK6"})
real_halted = reconciler.guard.halted
reconciler.guard.halted = lambda: True
with_samples(T(*WED, 13, 50))
at_time(T(*WED, 13, 50))
reconciler._next_round()
n_sends = len(sends)
with guard.halt_close_pass("TMF", "close_all_deferred"):
    r_held = reconciler._president_place_order("TMF", -1, reduce_only=True)
at_time(T(*WED, 14, 52))
reconciler._next_round()
reconciler._entry_wake_at = None
with guard.halt_close_pass("TMF", "close_all_deferred"):
    r_pre = reconciler._president_place_order("TMF", -1, reduce_only=True)
wake_pre = reconciler._entry_wake_at
at_time(T(*WED, 15, 1))
reconciler._next_round()
with guard.halt_close_pass("TMF", "close_all_deferred"):
    r_go = reconciler._president_place_order("TMF", -1, reduce_only=True)
r_entry = reconciler._president_place_order("TMF", 4)
tw_clock.time.time = real_time
reconciler.guard.halted = real_halted
check(r_held is False and r_pre is False and wake_pre == T(*WED, 15, 0, 5) and r_go and r_entry is False
      and sends[n_sends:] == [("president", "sell", 1, "reduce")],
      "HALT + deferred close-all: held at 13:50 and in the 14:52 pre-open (wake 15:00:05), sent at 15:01; "
      "the entry stays shut", (sends[n_sends:], wake_pre))
op.place_futures_market_order, reconciler._pending_sent = real_pfm, real_ps
op.snapshot_caught_up, reconciler._president_nets, _pfm.book_months = real_cu, real_pn, real_bm
oc.place_futures_market_order = real_cpf

# ── 9. the order lib: outside the login window nothing is claimed, marked or logged in ──────
claims = []
real_claim, real_sw = op._claim, president_vault.session_window
op._claim = lambda *a, **k: claims.append(a) or (_ for _ in ()).throw(RuntimeError("past the gate (fake)"))
president_vault.session_window = lambda now=None: None
n_aud = len(audits("order_denied_session"))
samples(0, 0, 0, at=real_time())  # measured: a close reads the window too
for intent, sym in (("reduce", "TMF"), ("entry", "TMF")):
    try:
        op.place_futures_market_order({}, sym, "sell", 1, intent, client_tag="t1")
        check(False, f"{intent} outside the window raises")
    except op.SessionClosed as e:
        check(not claims and not logins and "no login" in str(e),
              f"{intent} outside the window: SessionClosed before _claim and the login", str(e))
check(len(audits("order_denied_session")) == n_aud + 2, "each refusal audited order_denied_session")
no_samples()
try:
    op.place_futures_market_order({}, "TMF", "sell", 1, "reduce")
    check(False, "clock not measured: a close outside the window raises")
except op.SessionClosed:
    check(not claims and len(audits("order_denied_session")) == n_aud + 3,
          "clock not measured: a close is refused on the machine's clock, as the reconciler's hold (Wei)")
claims.clear()
try:
    op.place_futures_market_order({}, "TMF", "buy", 1, "entry")
    check(False, "an entry outside the window raises, measured or not")
except op.SessionClosed:
    check(not claims, "clock not measured: an entry is still refused on the machine's clock")
# which clock the window reads for a close: the corrected one (the reconciler's close hold reads it too)
seen = []
president_vault.session_window = lambda now=None: seen.append(now) or None
samples(1200, 1200, 1200, at=real_time())
try:
    op.place_futures_market_order({}, "TMF", "sell", 1, "reduce")
except op.SessionClosed:
    pass
check(len(seen) == 1 and seen[0] is not None and abs(seen[0].timestamp() - (real_time() - 1200)) < 5,
      "a close reads the window at machine time less the measured skew", seen)
no_samples()
check(isinstance(op.SessionClosed("x"), op.PresidentError), "SessionClosed is a PresidentError (callers' handlers hold)")
president_vault.session_window = lambda now=None: datetime(2026, 11, 4, 8, 30, tzinfo=TPE)
try:
    op.place_futures_market_order({}, "TMF", "sell", 1, "reduce")
except RuntimeError as e:
    check(claims and "past the gate" in str(e), "inside the window the order goes on to _claim", str(e))
president_vault.session_window = real_sw
op._claim = real_claim
president_vault.login = real_login
check(president_vault.session_window(datetime(2026, 11, 4, 14, 0, tzinfo=TPE)) is None
      and president_vault.session_window(datetime(2026, 11, 4, 14, 45, tzinfo=TPE))
      and president_vault.session_window(datetime(2026, 11, 7, 5, 14, tzinfo=TPE))
      and president_vault.session_window(datetime(2026, 11, 7, 5, 15, tzinfo=TPE)) is None
      and president_vault.session_window(datetime(2026, 11, 9, 4, 0, tzinfo=TPE)) is None,
      "vault window: 14:00 out, 14:45 in, Saturday 05:14 in / 05:15 out, Monday 04:00 out")
from lib import president_worker as _pw  # noqa: E402
check(_pw.session_window is president_vault.session_window and _pw.DAY_WINDOW == president_vault.DAY_WINDOW,
      "the worker reads the same window as the order lib")

# 9b. the audit's clock cases (release-0153 Y1), through both close gates: the reconciler's hold and the
# lib's window. Measured: in the session a close goes, after the close it waits. Not measured: the
# machine's clock decides (Wei) — a clock hours off holds it, said by one P1 row
TUE, SAT14 = (2026, 11, 10), (2026, 11, 14)
cases = [("measured +20 min, real 13:40", T(*TUE, 13, 40), 1200, True, True),
         ("measured -20 min, real 15:02", T(*TUE, 15, 2), -1200, True, True),
         ("not measured, +3 h, real 11:10", T(*TUE, 11, 10), 3 * 3600, False, False),
         ("not measured, -3 h, real 09:30", T(*TUE, 9, 30), -3 * 3600, False, False),
         ("not measured, +2 h, real 12:30", T(*TUE, 12, 30), 2 * 3600, False, False),
         ("not measured, 0, real 13:50 (CLOSE_UNVERIFIED_S slack)", T(*TUE, 13, 50), 0, False, True),
         ("not measured, 0, real 11:00", T(*TUE, 11, 0), 0, False, True),
         ("not measured, 0, Saturday 12:00", T(*SAT14, 12, 0), 0, False, False),
         ("measured +20 min, real 13:50 (closed)", T(*TUE, 13, 50), 1200, True, False),
         ("measured 0, real 14:05 (closed)", T(*TUE, 14, 5), 0, True, False),
         ("measured 0, Saturday 12:00", T(*SAT14, 12, 0), 0, True, False),
         # gross samples past SKEW_MAX_S (C5): measured, not trusted — the machine's clock, as unmeasured
         ("gross +3 h, real 11:10 (machine 14:10)", T(*TUE, 11, 10), 3 * 3600, True, False),
         ("gross -3 h, real 09:30 (machine 06:30)", T(*TUE, 9, 30), -3 * 3600, True, False),
         ("gross +2 h, real 12:30 (machine 14:30)", T(*TUE, 12, 30), 2 * 3600, True, False),
         ("gross +3 h, real 07:00 (machine 10:00)", T(*TUE, 7, 0), 3 * 3600, True, True),
         ("gross -3 h, real 18:00 (machine 15:00:30)", T(*TUE, 18, 0, 30), -3 * 3600, True, True),
         # fewer than KEEP samples: not measured
         ("two samples +3 h, real 11:10 (machine 14:10)", T(*TUE, 11, 10), 3 * 3600, 2, False),
         ("two samples +20 min, real 13:30 (machine 13:50)", T(*TUE, 13, 30), 1200, 2, True)]
wrong = []
for label, real_ts, off, measured, goes in cases:
    machine = real_ts + off
    no_samples()
    if measured:
        samples(*([off] * (3 if measured is True else measured)), at=machine)
    at_time(machine)
    reconciler._clock_noted = None
    reconciler._unchecked_noted = False
    held = reconciler._tw_close_held("TMF", "president")
    # the vault window's default is datetime.now() (wall clock): read it at this case's machine time
    _sw = president_vault.session_window
    president_vault.session_window = lambda now=None, _m=machine: _sw(now or datetime.fromtimestamp(_m, TPE))
    lib_open = op._close_window_open()
    president_vault.session_window = _sw
    tw_clock.time.time = real_time
    # the Y1 failure: the hold lets a close through and the lib's window refuses it, silently
    if (not held and lib_open) != goes or (not held and not lib_open):
        wrong.append((label, held, lib_open))
reconciler._clock_noted = None
no_samples()
reconciler._unchecked_noted = False
check(not wrong, "clock cases through both close gates: never hold-passes-lib-refuses; measured → the corrected clock, not measured → the machine's", wrong)

# ── 10. 9876 is a plain refusal ────────────────────────────────────────────────
try:
    await_with("9876")
    check(False, "9876 raises")
except op.PresidentError as e:
    check("9876" in str(e) and "[order_reject:" not in str(e),
          "9876 (FUT0083 該商品交易時間已結束) raises PresidentError, no reduce_only_rejected token", str(e))

# ── 11. close-all after the close: deferred to the reconciler's first round after the open ──────
import ast  # noqa: E402
fsrc = open(os.path.join(ROOT, "manager", "flatten.py"), encoding="utf-8").read()
fns = [n for n in ast.parse(fsrc).body if isinstance(n, ast.FunctionDef) and n.name in ("_defer_tw_close", "_tw_futures_closed")]
recorded = []
fake_guard = types.SimpleNamespace(restart_stopped=lambda: False)
from lib import venue_traits  # noqa: E402
ns = {"logging": __import__("logging"), "_record_order_error": lambda *a: recorded.append(a),
      "guard": fake_guard, "venue_traits": venue_traits}
exec(compile(ast.Module(fns, []), "flatten._defer_tw_close", "exec"), ns)
with_samples(T(*WED, 13, 50))
at_time(T(*WED, 13, 50))
closed_now = (ns["_tw_futures_closed"](venue_traits.PRESIDENT), ns["_tw_futures_closed"](venue_traits.CAPITAL),
              ns["_tw_futures_closed"]("binance"))
at_time(T(*WED, 14, 52))
pre_open_now = ns["_tw_futures_closed"](venue_traits.PRESIDENT)
at_time(T(*WED, 15, 1))
in_session_now = ns["_tw_futures_closed"](venue_traits.PRESIDENT)
tw_clock.time.time = real_time
check(closed_now == (True, True, False) and pre_open_now is True and in_session_now is False,
      "flatten (measured clock) defers 統一 and 群益 only: 13:50 and the 14:52 pre-open shut, 15:01 open",
      (closed_now, pre_open_now, in_session_now))
no_samples()
at_time(T(*WED, 13, 55))
fast_clock = ns["_tw_futures_closed"](venue_traits.PRESIDENT)
at_time(T(*WED, 14, 52))
pre_no_sample = ns["_tw_futures_closed"](venue_traits.PRESIDENT)
tw_clock.time.time = real_time
check(fast_clock is False and pre_no_sample is False,
      "no clock sample: only the broker's closed hours defer (13:55 sent: the clock may be fast)",
      (fast_clock, pre_no_sample))
check(ns["_defer_tw_close"]("binance", "BTCUSDT", op.SessionClosed("x")) is None,
      "a SessionClosed from a non-TW venue is not deferred")
samples(0, 0, 0, at=real_time())
check(ns["_defer_tw_close"]("president", "TMF", None) == "deferred"
      and json.load(open(_pfm._PAPER_TW_CLOSE_PATH))["keys"] == ["TMF"]
      and recorded[-1][3] == {"kind": "market_closed_deferred"} and "台指期休市中" in recorded[-1][2]
      and "開盤後" in recorded[-1][2],
      "close-all at 13:50: 台指期 deferred, the row says it closes after the open", recorded[-1:])
check(ns["_defer_tw_close"]("president", "TXF", op.SessionClosed("x")) == "deferred"
      and json.load(open(_pfm._PAPER_TW_CLOSE_PATH))["keys"] == ["TMF", "TXF"],
      "the lib's SessionClosed defers the same way")
no_samples()
check(ns["_defer_tw_close"]("president", "TXF", None) == "deferred"
      and recorded[-1][3] == {"kind": "market_closed_deferred", "clock": "unmeasured"}
      and "量不到" in recorded[-1][2] and "休市" not in recorded[-1][2] and "開盤後" in recorded[-1][2],
      "clock not measured: the deferred row says the clock is unmeasured, not that the market is closed", recorded[-1:])
samples(3 * 3600, 3 * 3600, 3 * 3600, at=real_time())
check(ns["_defer_tw_close"]("president", "TXF", None) == "deferred"
      and recorded[-1][3] == {"kind": "market_closed_deferred", "clock": "far"}
      and "差超過一小時" in recorded[-1][2] and "量不到" not in recorded[-1][2] and "休市" not in recorded[-1][2],
      "clock past SKEW_MAX_S: the deferred row says over an hour off (clock far), not unmeasured", recorded[-1:])
no_samples()
check(ns["_defer_tw_close"]("president", "TXF", op.PresidentError("統一 rejected the order: statuscode=9876 x")) is None,
      "a broker refusal (9876) is a plain error, not deferred")
held = {"TMF": {"side": "long", "size": 1, "exchange": "president"}, "TXF": {"side": "short", "size": 0}}
check(_pfm._paper_tw_deferred(held, True) == {"TMF"}, "halted: the held 台指期 key is this round's close-all leg")
json.dump([], open("manager/order_errors.json", "w"))  # the file keeps 5 rows: a full one would hide the new row
n_rows = len(errors())
_pfm._paper_tw_deferred(held, False)
new_rows = errors()[n_rows:]
check(len(new_rows) == 1 and new_rows[0].get("exchange") == "president" and "台指期" in new_rows[0].get("error", "")
      and not os.path.exists(_pfm._PAPER_TW_CLOSE_PATH),
      "啟動下單 before the open: the 台指期 deferral is dropped, said on 統一's row", new_rows)
fake_guard.restart_stopped = lambda: True
check(ns["_defer_tw_close"]("president", "TMF", None) == "refused" and "再按一次" in recorded[-1][2]
      and not os.path.exists(_pfm._PAPER_TW_CLOSE_PATH),
      "after a restart stop nothing is deferred: the row says press again in the session")

# ── 12. on-demand sample (r3 Y2): an unmeasured clock asks the api once before a gate holds on it ──
import requests as _rq  # noqa: E402
from email.utils import formatdate  # noqa: E402
calls, real_get = [], _rq.get
REAL_T = T(*WED, 13, 40)          # in session; this machine 20 min fast reads 14:00, past the slack
MACH_T = REAL_T + 1200
ok_get = lambda url, timeout=None, headers=None: calls.append(url) or types.SimpleNamespace(
    headers={"Date": formatdate(REAL_T, usegmt=True)})


def bad_get(url, timeout=None, headers=None):
    calls.append(url)
    raise _rq.ConnectionError("offline (fake)")


def probe_case(get, enabled=True, last_probe=0.0):
    no_samples()
    json.dump([], open("manager/order_errors.json", "w"))
    reconciler._clock_noted, reconciler._unchecked_noted, reconciler._last_said = None, False, (None, 0.0)
    _rq.get, tw_clock.probe_enabled, tw_clock._last_probe = get, enabled, last_probe
    at_time(MACH_T)
    held = reconciler._tw_close_held("TMF", "president")
    again = reconciler._tw_close_held("TMF", "president")
    tw_clock.time.time = real_time
    return held, again, errors()


check(tw_clock.probe_enabled is False, "probe is off on import (tests never reach the network)")
n0 = len(calls)
held, again, rows = probe_case(ok_get)
check(held is False and again is False and len(calls) == n0 + 2 and calls[-1].endswith(tw_clock.PROBE_PATH)
      and [r.get("kind") for r in rows] == ["clock_skew_hold"] and abs(tw_clock.skew(MACH_T) - 1200) < 2,
      "unmeasured, 20 min fast at real 13:40: two requests (a lone reply past 60 s is confirmed), +1200 s measured, the close goes; "
      "the row is the measured one (clock_skew_hold), not tw_clock_unchecked",
      (held, again, calls[n0:], rows))
n0 = len(calls)
held, again, rows = probe_case(bad_get)
check(held is True and again is True and len(calls) == n0 + 1
      and [(r.get("kind"), r.get("clock")) for r in rows] == [("tw_clock_unchecked", "unmeasured")],
      "the request fails: held on the machine's clock, one P1; the second hold makes no second request (PROBE_EVERY_S)",
      (held, again, calls[n0:], rows))
n0 = len(calls)
probe_case(ok_get, last_probe=MACH_T - tw_clock.PROBE_EVERY_S + 5)
probe_case(ok_get, enabled=False)
check(len(calls) == n0, "no request inside PROBE_EVERY_S of the last, nor where probe is not enabled", calls[n0:])
# the entry gate asks too, before sending on an unmeasured clock: 10 min fast measured → held for the clock
n0 = len(calls)
no_samples()
_rq.get, tw_clock.probe_enabled, tw_clock._last_probe = (lambda url, timeout=None, headers=None: calls.append(url) or types.SimpleNamespace(
    headers={"Date": formatdate(T(*WED, 10, 0), usegmt=True)})), True, 0.0
reconciler._clock_noted, reconciler._last_said = None, (None, 0.0)
at_time(T(*WED, 10, 10))
e_held = reconciler._tw_entry_held("TMF", "president")
tw_clock.time.time = real_time
check(e_held is True and len(calls) == n0 + 2 and reconciler._clock_noted == "off",
      "entry on an unmeasured clock: asks first (two replies, the second confirms); 10 min fast measured → held for the clock", (e_held, calls[n0:]))
# r4 Y1 (probe G): this machine 3 h fast, in session, only entry legs, a round every 200 s. The probe
# asks again while the replies agree hours off (up to KEEP), so far is said in the first round, once
for label, pre in (("no sample before", ()), ("one +3 h sample before", (3 * 3600,))):
    no_samples()
    REAL_G = T(*WED, 10, 0)
    if pre:
        samples(*pre, at=REAL_G + 3 * 3600 - 30)
    json.dump([], open("manager/order_errors.json", "w"))
    reconciler._clock_noted, reconciler._unchecked_noted, reconciler._last_said = None, False, (None, 0.0)
    calls_g, rounds = [], []
    _rq.get = lambda url, timeout=None, headers=None: calls_g.append(timeout) or types.SimpleNamespace(
        headers={"Date": formatdate(tw_clock.time.time() - 3 * 3600, usegmt=True)})
    tw_clock.probe_enabled, tw_clock._last_probe = True, 0.0
    for i in range(6):
        at_time(REAL_G + 3 * 3600 + 200 * i)
        reconciler._next_round()
        held_g = reconciler._tw_entry_held("TXF", "president")
        rounds.append((held_g, len(calls_g), [(r.get("kind"), r.get("clock")) for r in errors()]))
        tw_clock.time.time = real_time
    check(rounds[0][2] == [("tw_clock_unchecked", "far")] and all(h for h, _, _ in rounds)
          and rounds[-1][2] == [("tw_clock_unchecked", "far")] and rounds[0][1] <= tw_clock.KEEP
          and rounds[-1][1] == rounds[0][1] and calls_g[0] == (tw_clock.PROBE_CONNECT_S, tw_clock.SAMPLE_MAX_RTT_S - tw_clock.PROBE_CONNECT_S),
          f"probe G, {label}: 3 h fast — entries held every round, far P1 in the first round and only once; "
          f"≤ KEEP requests, none once measured; timeout (3, 7)", rounds)
# r4 P3-1 (probe F, Wei): this machine's clock is right and the one sample on file is a bad Date. The
# lone sample past 60 s does not move closes until confirmed: a gate asks (inside PROBE_EVERY_S too, once
# per lone sample), the replies say 0, and the median of the three is the machine's own clock
for label, real_f, bad, goes in (("14:25, bad -1800", T(*WED, 14, 25), -1800, False),
                                  ("13:50, bad +600", T(*WED, 13, 50), 600, False),
                                  ("05:10, bad +900", T(2026, 11, 5, 5, 10), 900, False),
                                  ("08:50, bad +1800", T(*WED, 8, 50), 1800, True)):
    no_samples()
    samples(bad, at=real_f - 30)
    json.dump([], open("manager/order_errors.json", "w"))
    reconciler._clock_noted, reconciler._unchecked_noted, reconciler._last_said = None, False, (None, 0.0)
    calls_f = []
    _rq.get = lambda url, timeout=None, headers=None: calls_f.append(url) or types.SimpleNamespace(
        headers={"Date": formatdate(tw_clock.time.time(), usegmt=True)})
    tw_clock.probe_enabled, tw_clock._last_probe, tw_clock._confirmed_at = True, real_f - 10, None   # inside PROBE_EVERY_S
    at_time(real_f)
    pre_skew = tw_clock.skew(real_f)
    held_f = reconciler._tw_close_held("TMF", "president")
    _sw = president_vault.session_window
    president_vault.session_window = lambda now=None: _sw(now or datetime.fromtimestamp(real_f, TPE))
    lib_f = op._close_window_open()
    president_vault.session_window = _sw
    again_f = reconciler._tw_close_held("TMF", "president")
    tw_clock.time.time = real_time
    check(pre_skew is None and (not held_f) == goes and (held_f or lib_f) and again_f == held_f   # the lib's window is wider (to 14:00 / 05:15)
          and 1 <= len(calls_f) <= tw_clock.KEEP - 1 and abs(tw_clock.skew(real_f)) < 2
          and not any(r.get("kind") == "clock_skew_hold" for r in errors()),
          f"probe F {label}: the lone bad sample corrects nothing; confirmed inside PROBE_EVERY_S, the machine's "
          f"clock rules — {'goes (a stop in session is not held)' if goes else 'held (not sent while the broker is shut)'}; "
          f"no 「平倉照常」 row", (pre_skew, held_f, lib_f, calls_f, errors()))
# r6 Y1 (Wei A): entries read the raw newest samples — every one off past 60 s the same way holds, even
# when they disagree (not measured, nothing said); mixed signs do not
samples(600, 700, 800, at=T(*WED, 8, 40))
y_same = tw_clock.entry_hold(T(*WED, 8, 40))
y_same_skew = tw_clock.skew(T(*WED, 8, 40))
samples(-600, -1500, -2400, at=T(*WED, 10, 0))
y_neg = tw_clock.entry_hold(T(*WED, 10, 0))
samples(600, -600, at=T(*WED, 10, 0))
y_mixed = tw_clock.entry_hold(T(*WED, 10, 0))
check(y_same and y_same["why"] == "clock" and y_same_skew is None and y_neg and y_neg["why"] == "clock" and y_mixed is None,
      "entries: +600/+700/+800 at 08:40 held (closes not corrected by them), -600/-1500/-2400 held; +600/-600 not held",
      (y_same, y_same_skew, y_neg, y_mixed))
# r6 Y2 (probe S): this machine's clock is right, real 13:50, the three samples on file disagree, the api
# answers — the reconciler's close asks first (as flatten does), measures, and holds the after-close send
for label, on_file in (("mixed +600/0/+1200", (600, 0, 1200)), ("same-sign -600/-1500/-2400", (-600, -1500, -2400))):
    no_samples()
    REAL_S = T(*WED, 13, 50)
    samples(*on_file, at=REAL_S - 30)
    calls_s = []
    _rq.get = lambda url, timeout=None, headers=None: calls_s.append(url) or types.SimpleNamespace(
        headers={"Date": formatdate(tw_clock.time.time(), usegmt=True)})
    tw_clock.probe_enabled, tw_clock._last_probe, tw_clock._confirmed_at = True, 0.0, None
    json.dump([], open("manager/order_errors.json", "w"))
    reconciler._clock_noted, reconciler._unchecked_noted, reconciler._last_said = None, False, (None, 0.0)
    at_time(REAL_S)
    pre_s = tw_clock.skew(REAL_S)
    held_s = reconciler._tw_close_held("TMF", "president")
    sk_s = tw_clock.skew(REAL_S)
    tw_clock.time.time = real_time
    check(pre_s is None and held_s is True and 1 <= len(calls_s) <= tw_clock.KEEP and sk_s is not None and abs(sk_s) < 2,
          f"probe S, {label}: the close asks the api first, measures ~0 and is held at 13:50 (not sent after the close)",
          (pre_s, held_s, calls_s, sk_s))
no_samples()
# r5 (probe K, Wei): a third reply decides only if two of the three agree within SKEW_BLOCK_S
samples(600, 0, 1200, at=T(*WED, 10, 0))
k_none = tw_clock.skew(T(*WED, 10, 0))
samples(0, 30, 1200, at=T(*WED, 10, 0))
k_pair = tw_clock.skew(T(*WED, 10, 0))
check(k_none is None and tw_clock.gross_skew(T(*WED, 10, 0) + 1) == 30 and k_pair == 30,
      "three samples no two of which agree within 60 s: not measured; two that agree: their median", (k_none, k_pair))
for label, replies in (("two disagree, the third request fails", (0, None)), ("three that all disagree", (0, 1200))):
    no_samples()
    REAL_K = T(*WED, 13, 50)
    samples(600, at=REAL_K - 30)
    it = iter(replies)

    def k_get(url, timeout=None, headers=None, _it=it):
        v = next(_it, None)
        if v is None:
            raise _rq.ConnectionError("offline (fake)")
        return types.SimpleNamespace(headers={"Date": formatdate(tw_clock.time.time() - v, usegmt=True)})
    _rq.get, tw_clock.probe_enabled, tw_clock._last_probe, tw_clock._confirmed_at = k_get, True, 0.0, None
    json.dump([], open("manager/order_errors.json", "w"))
    reconciler._clock_noted, reconciler._unchecked_noted, reconciler._last_said = None, False, (None, 0.0)
    at_time(REAL_K)
    held_k = reconciler._tw_close_held("TMF", "president")
    sk_k, rows_k = tw_clock.skew(REAL_K), [(r.get("kind"), r.get("clock")) for r in errors()]
    tw_clock.time.time = real_time
    check(sk_k is None and held_k is False and rows_k == [],
          f"probe K, {label}: not measured — closes read this machine's clock (13:50 is inside the 15-min slack: "
          f"sent, the literal ruling's known limit), no correction off a median that decides nothing", (sk_k, held_k, rows_k))
# probe() is True only when it wrote a sample: a reply without a Date (or too slow) is not one
no_samples()
_rq.get, tw_clock._last_probe, tw_clock._confirmed_at = (lambda url, timeout=None, headers=None: types.SimpleNamespace(headers={})), 0.0, None
hdrs = []
r_nodate = tw_clock.probe()
_rq.get, tw_clock._last_probe = (lambda url, timeout=None, headers=None: hdrs.append(headers) or types.SimpleNamespace(
    headers={"Date": formatdate(tw_clock.time.time(), usegmt=True)})), 0.0
r_ok = tw_clock.probe()
check(r_nodate is False and r_ok is True and hdrs and hdrs[0] == {"Cache-Control": "no-cache"},
      "probe(): False when the reply gave no sample, True when it did; asks with Cache-Control: no-cache", (r_nodate, r_ok, hdrs))
no_samples()
# confirmed once per lone sample: a second gate on the same lone sample, inside PROBE_EVERY_S, asks nothing
no_samples()
samples(600, at=T(*WED, 10, 0))
tw_clock._last_probe, tw_clock._confirmed_at = T(*WED, 10, 0), None
_rq.get = bad_get
calls_c = len(calls)
at_time(T(*WED, 10, 0) + 5)
reconciler._tw_entry_held("TXF", "president")
reconciler._tw_entry_held("TXF", "president")
tw_clock.time.time = real_time
check(len(calls) == calls_c + 1, "the confirming request for one lone sample is made once, not every round", calls[calls_c:])
# close-all asks too before deferring on an unmeasured clock
n0 = len(calls)
no_samples()
_rq.get, tw_clock._last_probe = ok_get, 0.0
at_time(MACH_T)
fl = ns["_tw_futures_closed"](venue_traits.PRESIDENT)
tw_clock.time.time = real_time
check(fl is False and len(calls) == n0 + 2, "close-all on an unmeasured clock: asks (two replies), measured in session → sent", (fl, calls[n0:]))
_rq.get, tw_clock.probe_enabled, tw_clock._last_probe = real_get, False, 0.0
reconciler._clock_noted, reconciler._unchecked_noted, reconciler._last_said = None, False, (None, 0.0)
no_samples()
rsrc = open(os.path.join(ROOT, "manager", "reconciler.py"), encoding="utf-8").read()
fsrc = open(os.path.join(ROOT, "manager", "flatten.py"), encoding="utf-8").read()
_ON = '_twc.probe_enabled = os.environ.get("BLAVE_CLOCK_PROBE") != "0"'
check(fsrc.count(_ON) == 1 and rsrc.count(_ON) == 1 and rsrc.count("probe_enabled =") == 1 and fsrc.count("probe_enabled =") == 1
      and rsrc.index(_ON) > rsrc.index("if __name__ == '__main__':") and fsrc.index(_ON) > fsrc.index('if __name__ == "__main__":')
      and "BLAVE_CLOCK_PROBE" in open(os.path.join(ROOT, "tests", "_run_all.py"), encoding="utf-8").read(),
      "the probe is switched on only by the reconciler's and flatten's __main__, and off for the whole test run")

print("\ncheck_tw_entry_gate: " + ("all ok" if not fails else f"FAILED ({fails})"))
sys.exit(1 if fails else 0)
