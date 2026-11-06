"""群益期貨 live quote feed (lib/capital_quote → state/capital_bars_TXF_1m.json →
lib/data's broker tail). Offline, no window, no network, no COM:
1. event placement: calendar date + time; a future stamp and a time outside the
   sessions are dropped
2. OnNotifyLiveKLineData replay of a real recording (win-test-6, 2026-11-06 —
   tests/fixtures/capital_quote_events.jsonl, the M0 probe's format trimmed to a few
   windows): nType 1 only, END labels, ÷PRICE_DIV, the 13:45 closing match dropped,
   nType 0 clears memory but not the snapshot's rows
3. ticks → minute bars equal the broker's live K bar for bar on the same recording;
   a minute closes on a later minute's trade or after the grace
4. snapshot: ok only while subscribed and not silent; errors keep the rows
5. data.py seam: a 群益-bound machine (desktop or cloud) reads only its own file;
   a price-scale error on the overlap falls back to Blave
6. mutations: label offset and price divisor

Run: cd blave-agent && .venv/bin/python tests/check_capital_quote.py
"""
import json
import os
import socket
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)


def _no_network(*a, **k):
    raise OSError("no network in this test")


socket.socket.connect = _no_network

import pandas as pd  # noqa: E402
from lib import capital_quote as cq, president_contracts as pc, data as d  # noqa: E402

TMP = tempfile.mkdtemp(prefix="capital-quote-")
cq.STATE = os.path.join(TMP, "state")
d._STATE_DIR = Path(TMP) / "state"
d._CACHE_DIR = Path(TMP) / "cache"
TAIPEI = pc.TAIPEI
fails = []


def check(cond, msg, detail=None):
    print(("PASS  " if cond else "FAIL  ") + msg + ("" if cond or detail is None else f"\n      {detail}"))
    if not cond:
        fails.append(msg)


def T(*a):
    return datetime(*a, tzinfo=TAIPEI)


def utc_epoch(y, mo, da, h, mi):
    return int(datetime(y, mo, da, h, mi, tzinfo=timezone.utc).timestamp())


# ── 1. event placement ──
em = cq.event_minute
check(em(20261105, 2359, T(2026, 11, 6, 9, 20)) == T(2026, 11, 5, 23, 59) and em(20261106, 0, T(2026, 11, 6, 9, 20)) == T(2026, 11, 6, 0, 0)
      and em(20261106, 93519, T(2026, 11, 6, 9, 35, 20), has_seconds=True) == T(2026, 11, 6, 9, 35),
      "1 nDate is the calendar day (measured): 23:59 the evening, 00:00 the next day; ticks floor to their minute")
check(em(20261113, 2300, T(2026, 11, 16, 8, 50)) == T(2026, 11, 13, 23, 0),
      "1 a Monday-morning backfill of Friday night lands on Friday night")
check(em(20261106, 1000, T(2026, 11, 6, 9, 55)) is None and em(20261106, 956, T(2026, 11, 6, 9, 55)) == T(2026, 11, 6, 9, 56),
      "1 more than CLOCK_SLACK_S ahead of the machine clock → None; within the slack it is accepted")
check(em(20261107, 1200, T(2026, 11, 7, 12, 1)) is None and em(20261106, 1400, T(2026, 11, 6, 14, 1)) is None
      and em(20261106, 2560, T(2026, 11, 6, 9, 0)) is None and em("x", 900, T(2026, 11, 6, 9, 1)) is None,
      "1 outside the sessions (Saturday noon, 14:00), an impossible time or an unreadable date → None")

# ── 2. live K: recorded on win-test-6 2026-11-06 (tests/fixtures/capital_quote_events.jsonl) ──
FIX = os.path.join(ROOT, "tests", "fixtures", "capital_quote_events.jsonl")
with open(FIX, encoding="utf-8") as f:
    EVENTS = [json.loads(line) for line in f if line.strip()]
END = T(2026, 11, 6, 9, 36)
krows, trows = cq.replay(EVENTS, now=END)
want = [utc_epoch(2026, 11, 5, 16, 0), utc_epoch(2026, 11, 5, 16, 1), utc_epoch(2026, 11, 5, 20, 59),
        utc_epoch(2026, 11, 5, 21, 0), utc_epoch(2026, 11, 6, 0, 46), utc_epoch(2026, 11, 6, 1, 35)]
check([r[0] for r in krows] == want,
      "2 nType 1 labels are END minutes: 00:00, 00:01, 04:59, 05:00 (the night's last bar kept), 08:46 (the day's first), 09:35; "
      "nType 2 never a row", [r[0] for r in krows])
check(krows[0][1:] == [39703.0, 39750.0, 39609.0, 39665.0, 185] and krows[4][5] == 2058,
      "2 prices ÷ 100, nQty is the bar's own volume (08:46 carries the 08:45:00 opening auction)", krows[:1])
check(cq.replay(EVENTS, now=END, productid="TXFL6")[0] == [], "2 a contract outside its series span contributes nothing")
other = [dict(e, code="TX12", nOpen=1, nHigh=1, nLow=1, nClose=1) for e in EVENTS if e["ev"] == "kline"]
check(cq.replay(EVENTS + other, now=END, code="TX00")[0] == krows, "2 code= keeps one product's bars when several are subscribed")
book = cq.LiveKBook()
book.on_event(1, 20261106, 1345, 4000000, 4000000, 4000000, 4000000, 9, T(2026, 11, 6, 13, 45, 1))
book.on_event(1, 20261106, 1346, 4000000, 4000000, 4000000, 4000000, 9, T(2026, 11, 6, 13, 46, 1))
check([r[0] for r in book.rows("TXFK6", T(2026, 11, 6, 13, 50))] == [utc_epoch(2026, 11, 6, 5, 45)],
      "2 day close: label 13:45 (13:44–13:45) kept, a 13:46 closing-match label dropped")
book.on_event(0, 20261106, 1500, 0, 0, 0, 0, 0, T(2026, 11, 6, 14, 59))
check(book.bars == {} and book.resets == 1, "2 nType 0 (session reset) clears the book")
reset = {"ev": "kline", "at": T(2026, 11, 6, 9, 35, 30).timestamp(), "nType": 0, "nDate": 20261106, "nTimehm": 0,
         "nOpen": 0, "nHigh": 0, "nLow": 0, "nClose": 0, "nQty": 0}
check(cq.replay(EVENTS + [reset], now=END)[0] == krows, "2 replay keeps what the book held at a reset (as the snapshot file does)")

# ── 3. ticks → minute bars ──
check(trows == krows,
      "3 bars built from the recorded trades equal the broker's own live K bar for bar (OHLC and volume; "
      "trial-match ticks ignored, the 08:45:00 auction in the 08:46 bar)", (trows, krows))
tb = cq.TickBook()
tb.on_tick(20261106, 93459, 4000000, 2, 0, T(2026, 11, 6, 9, 35, 0, 400000))
check(tb.rows("TXFK6", T(2026, 11, 6, 9, 35, 2)) == [] and len(tb.rows("TXFK6", T(2026, 11, 6, 9, 35, cq.TICK_GRACE_S))) == 1,
      "3 the newest minute closes only TICK_GRACE_S after its end (a 09:34:59 trade arriving 09:35:00.4 still counts)")
tb.on_tick(20261106, 93500, 4000000, 1, 0, T(2026, 11, 6, 9, 35, 0, 500000))
check(len(tb.rows("TXFK6", T(2026, 11, 6, 9, 35, 1))) == 1, "3 …or as soon as a later minute's trade arrives")
tc = cq.TickBook()
tc.on_tick(20261106, 134459, 4188000, 3, 0, T(2026, 11, 6, 13, 44, 59, 500000))
tc.on_tick(20261106, 134500, 4191500, 17, 0, T(2026, 11, 6, 13, 45, 0, 300000))
check(tc.rows("TXFK6", T(2026, 11, 6, 13, 50)) == [[utc_epoch(2026, 11, 6, 5, 45), 41880.0, 41915.0, 41880.0, 41915.0, 20]],
      "3 the 13:45:00 closing auction folds into the bar ending 13:45 (close and volume, as the Blave cache has it)")
tc = cq.TickBook()
tc.on_tick(20261118, 133000, 4000000, 5, 0, T(2026, 11, 18, 13, 30, 0, 300000))
tc.on_tick(20261106, 133000, 4000000, 5, 0, T(2026, 11, 6, 13, 30, 0, 300000))
check([r[0] for r in tc.rows("TXFK6", T(2026, 11, 18, 14, 0))] == [utc_epoch(2026, 11, 6, 5, 31), utc_epoch(2026, 11, 18, 5, 30)],
      "3 13:30:00 is the closing auction only on settlement day (11-18); any other day it opens the 13:30 minute")

# ── 4. snapshot ──
now = END
s1 = cq.build_snapshot(None, krows, "TXFK6", now, "subscribed", now.timestamp() - 5)
check(s1["ok"] and s1["error"] is None and s1["rows"] == krows and s1["latest"] == krows[-1][0] and s1["broker"] == "capital",
      "4 subscribed, last event 5 s ago → ok with the rows")
s2 = cq.build_snapshot(s1, [], "TXFK6", now, "subscribed", now.timestamp() - cq.SILENT_S - 1)
check(not s2["ok"] and s2["error"] == cq.SILENT and s2["rows"] == krows, "4 no event for SILENT_S → QUOTE_SILENT, rows kept")
s3 = cq.build_snapshot(s1, [], "TXFK6", now, "entering", now.timestamp())
check(not s3["ok"] and s3["error"] == "QUOTE_ENTERING" and s3["rows"] == krows,
      "4 reconnecting (or a reset emptied the book) → not ok, the file keeps the session's rows")
cq.write_snapshot(s1)
p = cq.pause("closed")
check(p["paused"] == "closed" and p["rows"] == krows and json.load(open(cq.snapshot_path(), encoding="utf-8"))["paused"] == "closed",
      "4 pause() re-stamps the last snapshot, rows kept")

# ── 5. data.py seam ──
NOW = int(time.time())
m = NOW - NOW % 60
start = datetime.now(timezone.utc).replace(day=1).strftime("%Y-%m-%d")
first_of_month = int(datetime.now(timezone.utc).replace(day=1, hour=0, minute=0, second=0, microsecond=0).timestamp())
if m - 15 * 60 < first_of_month:
    print("SKIP  5: within 15 minutes of a month boundary; the seam cases need the current month")
else:
    def ts(k):
        return pd.Timestamp(m - k * 60, unit="s")

    SCHEMA = ["1m"]

    def seed_cache(labels):
        cdir = d._monthly_cache_dir(f"twfutures3_{SCHEMA[0]}", {"symbol": "TXF"})
        cdir.mkdir(parents=True, exist_ok=True)
        for f in cdir.glob("*.parquet"):
            f.unlink()
        idx = pd.DatetimeIndex([ts(k) for k in labels], name="time")
        df = pd.DataFrame({"Open": 100.0, "High": 101.0, "Low": 99.0, "Close": 100.0, "Volume": 10.0}, index=idx)
        for ym, grp in df.groupby(df.index.strftime("%Y-%m")):
            d._atomic_to_parquet(grp, cdir / f"{ym}.parquet")

    def write(name, labels, px=100.0):
        rows = [[m - k * 60, px, px + 1, px - 1, px, 10] for k in sorted(labels, reverse=True)]
        os.makedirs(d._STATE_DIR, exist_ok=True)
        with open(d._STATE_DIR / name, "w", encoding="utf-8") as f:
            json.dump({"root": "TXF", "ok": True, "error": None, "written_at": NOW, "rows": rows}, f)

    def source():
        p = d._STATE_DIR / "twfutures_live_source.json"
        return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None

    d._fetch_twfutures_raw_smart = lambda *a, **k: pd.DataFrame()

    def run(env, cache=(10, 9, 8, 7, 6, 5, 4, 3), schema="1m"):
        for k in ("BLAVE_MODE", "BLAVE_AGENT_LOCAL", "BLAVE_SCHEDULED_RUN", "BLAVE_TW_BROKER"):
            os.environ.pop(k, None)
        os.environ.update(env)
        SCHEMA[0] = schema
        seed_cache(list(cache))
        try:
            (d._STATE_DIR / "twfutures_live_source.json").unlink()
        except OSError:
            pass
        df = d.fetch_twfutures_ohlcv("TMF", schema, start, None, {})
        return sorted(int((m - t.value // 10**9) / 60) for t in df.index)

    for f in ("president_bars_TXF_1m.json", "capital_bars_TXF_1m.json"):
        try:
            os.remove(d._STATE_DIR / f)
        except OSError:
            pass
    write("capital_bars_TXF_1m.json", [6, 5, 4, 3, 2, 1])
    write("president_bars_TXF_1m.json", [6, 5, 4, 3, 2, 1, 0])
    got = run({"BLAVE_MODE": "live", "BLAVE_AGENT_LOCAL": "1", "BLAVE_TW_BROKER": "capital"})
    check(got == [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] and source()["source"] == "capital" and source()["added"] == 2
          and source()["broker"] == "capital" and source()["traded"] == "TMF",
          "5 群益-bound desktop live tick: the 群益 file adds the two minutes Blave lacks, never 統一's newer one", (got, source()))
    got = run({"BLAVE_MODE": "live", "BLAVE_TW_BROKER": "capital"})
    check(got == [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] and source()["source"] == "capital",
          "5 a cloud 群益 machine (no BLAVE_AGENT_LOCAL) reads its feed too", source())
    got = run({"BLAVE_MODE": "live", "BLAVE_TW_BROKER": "president"})
    check(got == [3, 4, 5, 6, 7, 8, 9, 10] and source() is None, "5 a cloud 統一 machine still does not (its own decision)")
    got = run({"BLAVE_MODE": "backtest", "BLAVE_AGENT_LOCAL": "1", "BLAVE_TW_BROKER": "capital"})
    check(got == [3, 4, 5, 6, 7, 8, 9, 10] and source() is None, "5 a backtest never reads the feed")
    got = run({"BLAVE_MODE": "live", "BLAVE_AGENT_LOCAL": "1", "BLAVE_TW_BROKER": "okx"})
    check(got == [3, 4, 5, 6, 7, 8, 9, 10] and source() is None, "5 a non-feed venue never reads any file")
    write("capital_bars_TXF_1m.json", [6, 5, 4, 3, 2, 1], px=1.0)
    got = run({"BLAVE_MODE": "live", "BLAVE_AGENT_LOCAL": "1", "BLAVE_TW_BROKER": "capital"})
    check(got == [3, 4, 5, 6, 7, 8, 9, 10] and source()["source"] == "blave" and source()["reason"] == "price_mismatch",
          "5 the overlap is 100× off Blave (divisor error) → Blave alone, reason price_mismatch", source())
    got = run({"BLAVE_MODE": "live", "BLAVE_AGENT_LOCAL": "1", "BLAVE_TW_BROKER": "capital"}, cache=(10, 5), schema="5m")
    check(got == [5, 10] and source()["reason"] == "price_mismatch",
          "5 the same divisor error under a 5m strategy is caught too (level, not label, comparison)", source())
    with open(d._STATE_DIR / "capital_bars_TXF_1m.json", "w", encoding="utf-8") as f:
        json.dump({"ok": False, "error": "QUOTE_SILENT", "paused": "closed", "written_at": NOW,
                   "rows": [[m - 3600, 100.0, 101.0, 99.0, 100.0, 10]]}, f)
    got = run({"BLAVE_MODE": "live", "BLAVE_AGENT_LOCAL": "1", "BLAVE_TW_BROKER": "capital"})
    check(source()["reason"] == "not_ok:QUOTE_SILENT",
          "5 群益 closed with a feed that ended bad → not_ok (the app shows Blave and why), not `paused` (the normal line)", source())
    os.remove(d._STATE_DIR / "capital_bars_TXF_1m.json")
    got = run({"BLAVE_MODE": "live", "BLAVE_AGENT_LOCAL": "1", "BLAVE_TW_BROKER": "capital"})
    check(got == [3, 4, 5, 6, 7, 8, 9, 10] and source()["reason"] == "no_file", "5 no 群益 file yet → Blave, reason no_file")

# ── 7. the worker's quote thread (QuoteFeed on a fake SKQuoteLib) ──
class FakeQ:
    def __init__(self):
        self.calls = []

    def __getattr__(self, name):
        def call(*a):
            self.calls.append((name,) + a)
            return [0, 0] if name == "SKQuoteLib_RequestTicks" else 0
        return call


clk = {"t": 1000.0, "now": T(2026, 11, 6, 10, 0)}
fq = FakeQ()
feed = cq.QuoteFeed(fq, clock=lambda: clk["t"], now=lambda: clk["now"])
LIST = "TX00,台指近,20261118,TXFK600,100000| 1 | ,NTD;TX11,台指11,20261118,TXFK6,100000| 1 | ,NTD"


def adv(sec):
    clk["t"] += sec
    clk["now"] += timedelta(seconds=sec)
    feed.step()


def names():
    return [c[0].replace("SKQuoteLib_", "") for c in fq.calls]


cq.write_snapshot(s1)   # section 5 used the same state dir
feed.step()
check(names() == ["EnterMonitorLONGByMarket"] and fq.calls[0][1:] == (1,) and feed.state == "entering",
      "7 first step: EnterMonitorLONGByMarket(1) (domestic futures only), no login of its own")
snap = json.load(open(cq.snapshot_path(), encoding="utf-8"))
check(not snap["ok"] and snap["error"] == "QUOTE_ENTERING" and snap["rows"] == krows, "7 while connecting the file says so and keeps its rows", {k: v for k, v in snap.items() if k != "rows"})
feed.on_connection(3001, 0)
feed.on_connection(3003, 0)
adv(1)
check(names()[1:] == ["CancelRequestTicks", "RequestStockList", "RequestTicks"] and fq.calls[-1][1:] == (0, "TX00")
      and feed.state == "subscribed", "7 after 3003: cancel (no double subscription), stock list, RequestTicks(TX00)", names())
feed.on_list(LIST)
for e in EVENTS:
    if e["ev"] == "tick" and e["nDate"] == 20261106 and e["nTimehms"] >= 93400:
        feed.on_tick(e["nDate"], e["nTimehms"], e["nClose"], e["nQty"], e["nSimulate"], e.get("nPtr"))
clk["now"] = T(2026, 11, 6, 9, 35, 5)
adv(cq.HEARTBEAT_S)
snap = json.load(open(cq.snapshot_path(), encoding="utf-8"))
check(snap["ok"] and snap["alias_month"] == "TXFK6" and snap["source"] == "ticks"
      and [r for r in snap["rows"] if r[0] == want[-1]] == [krows[-1]],
      "7 subscribed, TX00 = TXFK6 = the series month, fresh trades → ok; the 09:35 bar equals the broker's live K", snap.get("error"))
tb = cq.TickBook()
for _ in range(2):
    tb.on_tick(20261106, 93500, 4000000, 3, 0, T(2026, 11, 6, 9, 35, 1), ptr=77)
check(tb.bars[T(2026, 11, 6, 9, 35)][4] == 3, "7 a replayed trade (same nDate, nPtr, time) is counted once")
n0 = len(fq.calls)
feed.on_connection(3002, 0)
adv(30)
check(feed.state == "down" and len(fq.calls) == n0, "7 a drop: wait for SKCOM's own reconnect first")
adv(cq.REENTER_AFTER_S)
check(names()[n0:] == ["EnterMonitorLONGByMarket"], "7 not healed after REENTER_AFTER_S → one EnterMonitor on the same login", names()[n0:])
feed.on_connection(3003, 0)
adv(1)
check(names()[n0 + 1:] == ["CancelRequestTicks", "RequestStockList", "RequestTicks"] and feed.state == "subscribed",
      "7 back → cancel, re-subscribe (the day's replay is de-duplicated by nPtr)")
check(not [c for c in names() if "Login" in c or "LeaveMonitor" in c],
      "7 never a login, never LeaveMonitor (it would drop the order-reply link too)")
feed.on_connection(3030, 0)
adv(cq.HEARTBEAT_S)
check(json.load(open(cq.snapshot_path(), encoding="utf-8"))["error"] == "QUOTE_CONN_LIMIT", "7 3030 → QUOTE_CONN_LIMIT")
feed.on_connection(3003, 0)
check(not cq.roll_guard(T(2026, 11, 6, 10, 0), "TXFK6") and cq.roll_guard(T(2026, 11, 6, 10, 0), None)
      and cq.roll_guard(T(2026, 11, 6, 10, 0), "TXFL6"),
      "7 roll guard: TX00's month must be known and equal the series month")
check(cq.roll_guard(T(2026, 11, 18, 8, 50), "TXFK6") and cq.roll_guard(T(2026, 11, 18, 16, 0), "TXFL6")
      and cq.roll_guard(T(2026, 11, 19, 4, 59), "TXFL6") and not cq.roll_guard(T(2026, 11, 19, 8, 50), "TXFL6"),
      "7 roll guard: settlement day 11-18 from its first minute to the end of that night session → Blave")
check(cq.roll_guard(T(2026, 11, 17, 15, 0), "TXFK6") and not cq.roll_guard(T(2026, 11, 17, 13, 44), "TXFK6"),
      "7 roll guard: …and from the night session before it (11-17 15:00), when TX00 may already have switched")
fm = cq.QuoteFeed(FakeQ(), clock=lambda: 0.0, now=lambda: T(2026, 11, 6, 10, 0, 30))
fm.month = "TXFL6"
fm.on_tick(20261106, 100000, 4000000, 1, 0, 5)
fm.month = None
fm.on_tick(20261106, 100001, 4000000, 1, 0, 6)
check(fm.book.bars.get(T(2026, 11, 6, 10, 0)) == [40000.0, 40000.0, 40000.0, 40000.0, 1],
      "7 trades are not booked while TX00's month is known and is not the series month (unknown: booked)")
clk["now"] = T(2026, 11, 18, 10, 0)
feed.on_tick(20261118, 95959, 4000000, 1, 0, 9)   # a live trade ends the replay; inside the window it is not booked
check(feed.book.bars.get(T(2026, 11, 18, 9, 59)) is None, "7 settlement window: trades are not folded into bars (TX00 may be the next month already)")
adv(cq.HEARTBEAT_S)
snap = json.load(open(cq.snapshot_path(), encoding="utf-8"))
check(not snap["ok"] and snap["error"] == cq.ROLL_GUARD, "7 on settlement day the file says QUOTE_ROLL_GUARD (the tick reads Blave)",
      {k: v for k, v in snap.items() if k != "rows"})
clk["now"] = T(2026, 11, 7, 12, 0)
adv(cq.HEARTBEAT_S)
check(json.load(open(cq.snapshot_path(), encoding="utf-8")).get("paused") == "closed", "7 outside the sessions → paused")
class RefusingQ(FakeQ):
    def __getattr__(self, name):
        def call(*a):
            self.calls.append((name,) + a)
            return [0, 3027] if name == "SKQuoteLib_RequestTicks" else 0
        return call


rq = RefusingQ()
clk2 = {"t": 0.0}
f2 = cq.QuoteFeed(rq, clock=lambda: clk2["t"], now=lambda: T(2026, 11, 6, 10, 0))
f2.step()
f2.on_connection(3003, 0)
for _ in range(20):
    clk2["t"] += 0.05
    f2.step()
asked = [c for c in rq.calls if c[0] == "SKQuoteLib_RequestTicks"]
clk2["t"] += cq.REENTER_BACKOFF_S[0]
f2.step()
check(len(asked) == 1 and f2.error == "QUOTE_SUBSCRIBE:3027"
      and len([c for c in rq.calls if c[0] == "SKQuoteLib_RequestTicks"]) == 2,
      "7 a refused RequestTicks (3027) is retried on the backoff, not on every pump (each try can eat quota)", len(asked))
class RaisingQ(FakeQ):
    def __getattr__(self, name):
        def call(*a):
            self.calls.append((name,) + a)
            if name == "SKQuoteLib_RequestTicks":
                raise OSError("COM gone")
            return 0
        return call


xq = RaisingQ()
clk4 = {"t": 0.0}
f4 = cq.QuoteFeed(xq, clock=lambda: clk4["t"], now=lambda: T(2026, 11, 6, 10, 0))
f4.step()
f4.on_connection(3003, 0)
for _ in range(40):          # run(): a raising step, then about a second later the next one
    clk4["t"] += 1.05
    try:
        f4.step()
    except OSError:
        pass
check([c[0] for c in xq.calls].count("SKQuoteLib_RequestTicks") <= 3,
      "7 a RequestTicks that raises is retried on the backoff too (set before the call), not every second",
      [c[0] for c in xq.calls].count("SKQuoteLib_RequestTicks"))
sq = FakeQ()
clk3 = {"t": 0.0, "now": T(2026, 11, 6, 10, 0)}
f3 = cq.QuoteFeed(sq, clock=lambda: clk3["t"], now=lambda: clk3["now"])


def adv3(sec):
    clk3["t"] += sec
    clk3["now"] += timedelta(seconds=sec)
    f3.step()


def count3(name):
    return [c[0] for c in sq.calls].count("SKQuoteLib_" + name)


f3.step()
f3.on_connection(3003, 0)
f3.step()
f3.on_tick(20261106, 100000, 4000000, 1, 0, 1)
adv3(2 * cq.SILENT_S + 1)
check(count3("RequestTicks") == 2 and count3("EnterMonitorLONGByMarket") == 1 and f3.state == "subscribed",
      "7 silent 2 × SILENT_S while trading (a dead link with no 3002): first a plain re-subscribe")
adv3(60)
check(count3("RequestTicks") == 2, "7 …and nothing more until the spacing runs out")
adv3(2 * cq.SILENT_S)
adv3(1)
check(count3("EnterMonitorLONGByMarket") == 2 and f3.state == "entering",
      "7 still no live trade 2 × SILENT_S after the re-subscribe → a full EnterMonitor (same login)")
f3.on_connection(3003, 0)
adv3(1)
n_before = count3("RequestTicks") + count3("EnterMonitorLONGByMarket")
for _ in range(int(cq.SILENT_REDO_S[1] / 60) - 1):
    adv3(60)
check(count3("RequestTicks") + count3("EnterMonitorLONGByMarket") == n_before,
      "7 a 3003 does not reset the silence spacing: a holiday (in_session, no trade) is not a reconnect every few minutes")
f3.on_tick(20261106, 103000, 4000000, 1, 0, 2)
check(f3.silent_n == 0, "7 the first live trade resets the silence count")


class DeafQ(FakeQ):   # after the first one, EnterMonitor answers non-0 and no 3003 ever comes (a quiet holiday?)
    def __getattr__(self, name):
        def call(*a):
            self.calls.append((name,) + a)
            if name == "SKQuoteLib_EnterMonitorLONGByMarket":
                return 0 if len(self.calls) == 1 else 1108
            return [0, 0] if name == "SKQuoteLib_RequestTicks" else 0
        return call


dq = DeafQ()
clk5 = {"t": 0.0, "now": T(2026, 11, 6, 10, 0)}
f5 = cq.QuoteFeed(dq, clock=lambda: clk5["t"], now=lambda: clk5["now"])
f5.step()
f5.on_connection(3003, 0)
f5.step()
f5.on_tick(20261106, 100000, 4000000, 1, 0, 1)
for _ in range(4 * 60):     # four quiet hours inside the session, a step a minute
    clk5["t"] += 60
    clk5["now"] += timedelta(minutes=1)
    f5.step()
seq = [c[0].replace("SKQuoteLib_", "") for c in dq.calls if c[0] in ("SKQuoteLib_EnterMonitorLONGByMarket", "SKQuoteLib_RequestTicks")]
check(seq[:3] == ["EnterMonitorLONGByMarket", "RequestTicks", "RequestTicks"] and seq[3] == "EnterMonitorLONGByMarket"
      and seq[4] == "RequestTicks" and len(seq) <= 9,
      "7 a silence EnterMonitor that never gets its 3003 does not fall into the 30 s – 5 min reconnect loop: "
      "re-subscribe and re-enter take turns on the 6 / 15 / 30 / 60 min spacing", seq)
n_enter = [c[0] for c in dq.calls].count("SKQuoteLib_EnterMonitorLONGByMarket")
f5.on_connection(3002, 0)          # inside the silence spacing, SKCOM now reports the drop
for _ in range(2):
    clk5["t"] += 60
    clk5["now"] += timedelta(minutes=1)
    f5.step()
check([c[0] for c in dq.calls].count("SKQuoteLib_EnterMonitorLONGByMarket") == n_enter + 1,
      "7 a reported drop leaves the silence spacing: EnterMonitor after REENTER_AFTER_S, not at the next silence step")
f5.on_connection(3003, 0)
f5.step()
clk5["now"] = T(2026, 11, 6, 15, 30)               # the night session: a trade is due again
f5.on_tick(20261106, 153000, 4000000, 1, 0, 99)   # trading resumes
n_rt = [c[0] for c in dq.calls].count("SKQuoteLib_RequestTicks")
for _ in range(7):
    clk5["t"] += 60
    clk5["now"] += timedelta(minutes=1)
    f5.step()
check([c[0] for c in dq.calls].count("SKQuoteLib_RequestTicks") == n_rt + 1,
      "7 after trading resumed, the next silent link is re-subscribed 2 × SILENT_S later (the old spacing is gone)")
q7 = FakeQ()
clk7 = {"t": 0.0, "now": T(2026, 11, 6, 10, 0)}
f7 = cq.QuoteFeed(q7, clock=lambda: clk7["t"], now=lambda: clk7["now"])


def adv7(sec):
    clk7["t"] += sec
    clk7["now"] += timedelta(seconds=sec)
    f7.step()


f7.step()
f7.on_connection(3003, 0)
f7.step()
f7.on_tick(20261106, 100000, 4000000, 1, 0, 1)
adv7(2 * cq.SILENT_S + 1)            # silence 1: re-subscribe
adv7(2 * cq.SILENT_S + 1)            # silence 2: EnterMonitor, the next step 15 min away
f7.on_connection(3003, 0)
adv7(1)                              # re-subscribed
f7.on_tick(20261106, 101300, 4000000, 1, 0, 2)   # a live trade: the link was fine after all
n7 = [c[0] for c in q7.calls].count("SKQuoteLib_RequestTicks")
adv7(2 * cq.SILENT_S + 1)
check([c[0] for c in q7.calls].count("SKQuoteLib_RequestTicks") == n7 + 1,
      "7 a live trade clears the silence spacing too: the next silent link is re-subscribed after 2 × SILENT_S, not 15–60 min later")
clk3["now"] = T(2026, 11, 6, 13, 49)
f3.live_ref = clk3["t"] - 2 * cq.SILENT_S - 10
n_before = len(sq.calls)
adv3(cq.HEARTBEAT_S)
snap = json.load(open(cq.snapshot_path(), encoding="utf-8"))
check(len(sq.calls) == n_before and snap["error"] != cq.SILENT,
      "7 after the close (13:45–15:00) quiet is normal: no silence action, the snapshot is not QUOTE_SILENT", snap.get("error"))
p = cq.pause("closed")
check(p["ok"] == snap["ok"], "7 pause() keeps the last in-session ok, so the 13:45 bin still reads from 群益 (close tail)")

logs, n = [], {"i": 0}


def stop():
    n["i"] += 1
    return n["i"] > 3


boom = cq.QuoteFeed.step
cq.QuoteFeed.step = lambda self: (_ for _ in ()).throw(RuntimeError("boom"))
cq.time.sleep, real_sleep = (lambda s: None), cq.time.sleep
got = cq.run(FakeQ, lambda q, sink: object(), lambda: None, stop=stop, log=logs.append)
cq.time.sleep = real_sleep
cq.QuoteFeed.step = boom
check(isinstance(got, cq.QuoteFeed) and logs == ["[capital_quote] step failed: RuntimeError: boom"],
      "7 run(): a failing step is logged once and the loop goes on (the worker never sees it)", logs)

# ── 8. a real reconnect, replayed through QuoteFeed (win-test-6 soak 11-06 10:33–10:39: the probe's
#       python.exe cut off 10:34:11–10:36:11, SKCOM 3033, back 10:37:48, the day replayed until 10:38:3x) ──
with open(os.path.join(ROOT, "tests", "fixtures", "capital_quote_reconnect.jsonl"), encoding="utf-8") as f:
    RC = [json.loads(line) for line in f if line.strip()]
RC.sort(key=lambda e: e["at"])
cur = {"t": RC[0]["at"] - 1}
fr = cq.QuoteFeed(FakeQ(), clock=lambda: cur["t"], now=lambda: datetime.fromtimestamp(cur["t"], TAIPEI))
writes, real_write = [], cq.write_snapshot
cq.write_snapshot = lambda snap, root=cq.ROOT: (writes.append((cur["t"], json.loads(json.dumps(snap)))), real_write(snap, root))[1]
cq.write_snapshot(cq.build_snapshot(None, [], "TXFK6", datetime.fromtimestamp(cur["t"], TAIPEI), "idle", None))
fr.step()
fr.on_connection(3003, 0)
fr.on_list(LIST)
nxt = cur["t"]
for e in RC:
    while nxt + 1 <= e["at"]:
        nxt += 1
        cur["t"] = nxt
        fr.step()
    cur["t"] = e["at"]
    if e["ev"] == "conn":
        fr.on_connection(e["nKind"], e["nCode"])
    else:
        fr.on_tick(e["nDate"], e["nTimehms"], e["nClose"], e["nQty"], e["nSimulate"], e["nPtr"], live=not e["hist"])
for _ in range(20):
    nxt += 1
    cur["t"] = nxt
    fr.step()
cq.write_snapshot = real_write
back = min(e["at"] for e in RC if e["ev"] == "conn" and e["nKind"] == 3003)
first_live = min(e["at"] for e in RC if e["ev"] == "tick" and not e["hist"] and e["at"] > back)
final = {r[0]: r for r in fr.book.rows("TXFK6", datetime.fromtimestamp(cur["t"], TAIPEI))}
in_replay = [(t, w["error"]) for t, w in writes if back <= t < first_live]
check(in_replay and all(err == cq.BACKFILL for _, err in in_replay),
      f"8 between the re-subscribe and the first live trade ({first_live - back:.0f} s of replay) no write is ok: QUOTE_BACKFILL",
      in_replay[:3])
torn = [(t, r, final.get(r[0])) for t, w in writes if w["ok"] for r in w["rows"]
        if r[0] in final and r[0] >= utc_epoch(2026, 11, 6, 2, 34) and r != final[r[0]]]
check(not torn, "8 every bar an ok snapshot ever carried equals its final value (no half-replayed minute reaches a tick)", torn[:2])
check(final[utc_epoch(2026, 11, 6, 2, 35)][5] == 612 and all(utc_epoch(2026, 11, 6, 2, m) in final for m in range(34, 39)),
      "8 after the replay the cut minutes are all there (10:35 with its full 612 lots)")
check(any(w["ok"] for t, w in writes if t >= first_live), "8 …and the snapshot is ok again from the first live trade on")

# ── 6. mutations ──
cq.BAR_LABEL_OFFSET_MIN = 1
check(cq.replay(EVENTS, now=END)[0][0][0] == want[0] + 60, "6 mutation: a START-label offset shifts every live K bar a minute (section 2 would fail)")
cq.BAR_LABEL_OFFSET_MIN = 0
cq.PRICE_DIV = 1
check(cq.replay(EVENTS, now=END)[0][0][1] == 3970300.0, "6 mutation: divisor 1 gives raw integers (the seam's scale gate is what catches it)")
cq.PRICE_DIV = 100

print(f"\n{'FAILED: ' + str(fails) if fails else 'all passed'}")
sys.exit(1 if fails else 0)
