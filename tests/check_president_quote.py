"""統一期貨 live quote feed (lib/president_quote → state/president_bars_<ROOT>_1m.json →
lib/data.fetch_twfutures_ohlcv's live tail). Offline, no window, no network:
1. series_contract: settlement day is the expiring month until 15:00, then the next month
2. BarData → cache rows: START label +1 min, Taipei → UTC epoch, night bars by calendar
   day, the closing-match bars (day 13:45, night 05:00, settlement day 13:30) dropped
3. paging: ≤100 minutes per call, 查無資料 = empty page, stop after N empty pages, other
   errors stop the walk and are reported
4. poll_root: fresh backfill, steady-state delta, rolling window, auth_dquote False,
   exceptions kept out of the worker
5. data.py seam — Blave first, 統一 only adds what Blave lacks:
   fresh + overlapping → president; stale / not ok / not enabled / no file → blave;
   bound days after the backtest with a shallow feed → blave no_overlap; a hole inside
   Blave that the feed covers is filled, one it does not cover stays; overlap values are
   Blave's; a backtest (not live), a scheduled run, another venue never read the snapshot
6. the thread loop stops on stop(); --once never starts it; a mutation check on the label

Run: cd blave-agent && .venv/bin/python tests/check_president_quote.py
"""
import json
import os
import socket
import sys
import tempfile
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)


def _no_network(*a, **k):
    raise OSError("no network in this test")


socket.socket.connect = _no_network

import pandas as pd  # noqa: E402
from lib import president_quote as pq, president_contracts as pc, data as d  # noqa: E402

TMP = tempfile.mkdtemp(prefix="president-quote-")
pq.STATE = os.path.join(TMP, "state")
pq.PAGE_GAP_S = 0
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


class Bar:
    def __init__(self, date, time_, o=100.0, h=101.0, l=99.0, c=100.5, v=10):
        self.date, self.time, self.open, self.high, self.low, self.close, self.volume = date, time_, o, h, l, c, v


class Resp:
    def __init__(self, ok=True, error="", data=None):
        self.ok, self.error, self.data = ok, error, data


def utc_epoch(y, mo, da, h, mi):
    return int(datetime(y, mo, da, h, mi, tzinfo=timezone.utc).timestamp())


# ── 1. series contract ──
check(pc.series_contract("TXF", T(2026, 10, 21, 13, 29)) == "TXFJ6"
      and pc.series_contract("TXF", T(2026, 10, 21, 13, 31)) == "TXFJ6"
      and pc.series_contract("TXF", T(2026, 10, 21, 14, 59)) == "TXFJ6",
      "1 settlement day (2026-10-21) stays on the expiring month through 14:59")
check(pc.series_contract("TXF", T(2026, 10, 21, 15, 0)) == "TXFK6" and pc.series_contract("MXF", T(2026, 10, 22, 9, 0)) == "MXFK6",
      "1 …and is on the next month from 15:00")
check(pc.series_contract("TMF", T(2026, 12, 16, 15, 0)) == "TMFA7", "1 December rolls to next year's A")
check(pc.front_month("TXF", T(2026, 10, 21, 13, 31)) == "TXFK6" and pc.computed_near("TXF", T(2026, 10, 20, 15, 0)) == "TXFK6",
      "1 front_month (13:30) and computed_near (15:00 the day before) are untouched and differ from it")

# ── 2. conversion ──
N2 = T(2026, 12, 1)   # a clock after every bar below (a bar not closed by `now` is dropped — tested at the end)
rows = pq.to_cache_rows([Bar("20261008", "084500")], "TXFJ6", N2)
check(rows == [[utc_epoch(2026, 10, 8, 0, 46), 100.0, 101.0, 99.0, 100.5, 10]],
      "2 day-session first bar 08:45 START → 08:46 END label, 00:46 UTC", rows)
rows = pq.to_cache_rows([Bar("20261009", "004500")], "TXFJ6", N2)
check(rows == [[utc_epoch(2026, 10, 8, 16, 46), 100.0, 101.0, 99.0, 100.5, 10]],
      "2 night bar after midnight: calendar-day date → absolute time (10-08 16:46 UTC)", rows)
labels = [r[0] for r in pq.to_cache_rows(
    [Bar("20261008", "134400"), Bar("20261008", "134500"), Bar("20261008", "134600"),
     Bar("20261008", "045900"), Bar("20261008", "050000"), Bar("20261008", "050100"),
     Bar("20261008", "133000"), Bar("20261008", "150000")], "TXFJ6", N2)]
check(labels == sorted([utc_epoch(2026, 10, 8, 5, 45), utc_epoch(2026, 10, 7, 21, 0),
                        utc_epoch(2026, 10, 8, 5, 31), utc_epoch(2026, 10, 8, 7, 1)]),
      "2 closing-match bars dropped (start 13:45 / 05:00 and later); 13:44 → 13:45 and 04:59 → 05:00 kept, "
      "13:30 on an ordinary day kept, 15:00 → 15:01 kept", labels)
labels = [r[0] for r in pq.to_cache_rows(
    [Bar("20261021", "132900"), Bar("20261021", "133000"), Bar("20261021", "134400"), Bar("20261021", "150000")], "TXFJ6", N2)]
check(labels == [utc_epoch(2026, 10, 21, 5, 30)],
      "2 settlement day of the contract's own month: the series ends with the 13:30 label (13:30+ and the 15:00 night dropped)", labels)
labels = [r[0] for r in pq.to_cache_rows([Bar("20261021", "090000"), Bar("20261021", "133000"), Bar("20261021", "134400"),
                                          Bar("20261021", "150000"), Bar("20261020", "150000")], "TXFK6", N2)]
check(labels == [utc_epoch(2026, 10, 21, 7, 1)],
      "2 the next month's contract contributes nothing before it became the series month (10-21 15:00): its own "
      "settlement-day 09:00 / 13:30 / 13:44 and the day before are out, 15:00 → 15:01 is its first bar", labels)
check(pq.series_span("TXFK6") == (T(2026, 10, 21, 15, 0), T(2026, 11, 18, 15, 0)) and pq.series_span("TXFA7") == (T(2026, 12, 16, 15, 0), T(2027, 1, 20, 15, 0)),
      "2 series_span: from the previous month's settlement-day 15:00 to its own (December → January crosses the year)")
rows = pq.to_cache_rows([Bar("20261008", "084500"), Bar("20261008", "084600"), Bar("20261008", "084700")], "TXFJ6", T(2026, 10, 8, 8, 47, 20))
check([r[0] for r in rows] == [utc_epoch(2026, 10, 8, 0, 46), utc_epoch(2026, 10, 8, 0, 47)],
      "2 a bar whose END label is still ahead of the clock (08:47 start at 08:47:20) is the forming minute: dropped; END == now kept", rows)
rows = pq.to_cache_rows([Bar("2026108", "084500"), Bar("20261008", "8460"), Bar("20261008", "084700", o="x"),
                         Bar("20261008", "084700"), Bar("20261008", "084700", c=200.0)], "TXFJ6", N2)
check([r[0] for r in rows] == [utc_epoch(2026, 10, 8, 0, 48)] and rows[0][4] == 200.0,
      "2 unreadable date / time / price rows skipped; duplicates: the later one wins", rows)
check(pq.bar_start(Bar("20261008", "93015")) == T(2026, 10, 8, 9, 30, 15), "2 a time without its leading zero is read")


# ── 3. paging ──
class FakeQuote:
    def __init__(self, pages=None, enabled=True):
        self.calls, self.pages, self.script = [], pages or {}, []

    def get_history_bardata(self, interval, start, end, kind, pid, count):
        self.calls.append((interval, start, end, kind, pid, count))
        if self.script:
            nxt = self.script.pop(0)
            if isinstance(nxt, Exception):
                raise nxt
            return nxt
        bars = [b for b in self.pages.get(pid, []) if start < pq.bar_start(b) <= end]
        return Resp(True, "", bars) if bars else Resp(False, "查無資料", None)


class FakeApi:
    def __init__(self, dquote, enabled=True):
        self.dquote = dquote
        self._usersettings = type("US", (), {"auth_dquote": enabled})()


def bars_between(start, end, pid="TXFJ6", base=100):
    """One bar per minute with its START label from `start` to `end` (Taipei), day/night sessions only."""
    out, t = [], start
    while t <= end:
        hm = (t.hour, t.minute)
        if (8, 45) <= hm < (13, 45) or hm >= (15, 0) or hm < (5, 0):
            out.append(Bar(t.strftime("%Y%m%d"), t.strftime("%H%M%S"), c=base + t.minute))
        t += timedelta(minutes=1)
    return out


now = T(2026, 10, 8, 21, 30)
dq = FakeQuote({"TXFJ6": bars_between(T(2026, 10, 7, 15, 0), T(2026, 10, 8, 21, 29))})
bars, reached, err = pq.fetch_pages(FakeApi(dq), "TXFJ6", now - timedelta(days=2), now, log=lambda m: None)
spans = [(c[2] - c[1]).total_seconds() / 60 for c in dq.calls]
check(all(s <= 100 for s in spans) and all(c[5] == 100 and c[0] == "1K" and c[3] == "1" for c in dq.calls)
      and all(c[1].tzinfo is not None and c[2].tzinfo is not None for c in dq.calls),
      "3 every call: 1K, product kind 1, count 100, span ≤ 100 min, tz-aware", spans[:3])
check(err is None and len(bars) == len(dq.pages["TXFJ6"]), "3 walks back through the day/night gaps (查無資料 = empty page)", (err, len(bars)))
first_empty_after = next(i for i, c in enumerate(dq.calls) if c[1] < T(2026, 10, 7, 15, 0))
check(len(dq.calls) - first_empty_after <= pq.EMPTY_PAGES_STOP + 1 and reached < T(2026, 10, 7, 15, 0),
      "3 stops after EMPTY_PAGES_STOP empty pages in a row; the earliest page start reached is reported",
      (len(dq.calls), first_empty_after, reached))
dq2 = FakeQuote()
dq2.script = [Resp(True, "", bars_between(T(2026, 10, 8, 20, 0), T(2026, 10, 8, 21, 29))), Resp(False, "Timeout", None)]
bars, reached, err = pq.fetch_pages(FakeApi(dq2), "TXFJ6", now - timedelta(days=2), now, log=lambda m: None)
check(err == "Timeout" and len(bars) == 90 and len(dq2.calls) == 2, "3 any other failure stops the walk and comes back as the error", (err, len(bars)))

# ── 4. poll_root ──
dq = FakeQuote({"TXFJ6": bars_between(T(2026, 10, 7, 15, 0), T(2026, 10, 8, 21, 29))})
api = FakeApi(dq)
snap = pq.poll_root(api, "TXF", now)
on_disk = json.load(open(pq.snapshot_path("TXF"), encoding="utf-8"))
check(on_disk == snap and snap["ok"] and snap["error"] is None and snap["productid"] == "TXFJ6" and snap["root"] == "TXF"
      and snap["label"] == "end" and isinstance(snap["written_at"], int),
      "4 fresh poll writes state/president_bars_TXF_1m.json: ok, productid, label end", {k: v for k, v in snap.items() if k != "rows"})
check(snap["rows"][-1][0] == utc_epoch(2026, 10, 8, 13, 30) and snap["latest"] == snap["rows"][-1][0]
      and snap["earliest"] == snap["rows"][0][0] == utc_epoch(2026, 10, 7, 7, 1)
      and all(len(r) == 6 for r in snap["rows"]) and snap["paged_back_to"] <= snap["earliest"],
      "4 rows are [ts,o,h,l,c,v] END labels, newest 21:29 start → 21:30 end; earliest / latest / paged_back_to set",
      (snap["earliest"], snap["latest"], snap["paged_back_to"]))
n_calls = len(dq.calls)
dq.pages["TXFJ6"] += bars_between(T(2026, 10, 8, 21, 30), T(2026, 10, 8, 21, 31))
snap2 = pq.poll_root(api, "TXF", now + timedelta(minutes=2))
check(len(dq.calls) == n_calls + 1 and (dq.calls[-1][2] - dq.calls[-1][1]) < timedelta(minutes=5)
      and snap2["rows"][-1][0] == utc_epoch(2026, 10, 8, 13, 32) and len(snap2["rows"]) == len(snap["rows"]) + 2
      and snap2["paged_back_to"] == snap["paged_back_to"],
      "4 steady state: one short page from the last row, rows merged, paged_back_to kept", (len(dq.calls) - n_calls, snap2["latest"]))
late = now + timedelta(days=2, hours=1)
dq.pages["TXFJ6"] += bars_between(late - timedelta(minutes=3), late - timedelta(minutes=1))
snap3 = pq.poll_root(api, "TXF", late)
floor = int((late - timedelta(days=pq.KEEP_DAYS)).timestamp())
check(snap3["rows"] and snap3["rows"][0][0] >= floor and snap3["rows"][-1][0] == int((late - timedelta(minutes=1)).timestamp()) + 60,
      "4 rolling window: rows older than KEEP_DAYS calendar days are trimmed", (snap3["earliest"], floor))
dq_off = FakeQuote()
snap4 = pq.poll_root(FakeApi(dq_off, enabled=False), "TXF", now)
check(snap4["ok"] is False and snap4["error"] == pq.NOT_ENABLED and dq_off.calls == [] and snap4["productid"] == "TXFJ6",
      "4 auth_dquote False: QUOTE_NOT_ENABLED in the snapshot, no HTTP call, the worker goes on", snap4["error"])
dq_boom = FakeQuote()
dq_boom.script = [RuntimeError("socket closed A123456789")]
snap5 = pq.poll_root(FakeApi(dq_boom), "TXF", late)
check(snap5["ok"] is False and "RuntimeError" in snap5["error"] and "A123456789" not in snap5["error"]
      and snap5["rows"] == snap3["rows"], "4 an exception: ok False + sanitized error, the last good rows kept, nothing raised", snap5["error"])
check(pq.ROOTS == ("TXF",) and not os.path.exists(pq.snapshot_path("MXF")) and not os.path.exists(pq.snapshot_path("TMF")),
      "4 TXF only: one HTTP call per round, no MXF / TMF snapshots (lib/data reads the TXF one for every root)")
pq._MSG_NOT_ENABLED = "MSG011-text"
dq_m = FakeQuote()
dq_m.script = [Resp(False, "MSG011-text", None)]
api_m = FakeApi(dq_m)
del api_m._usersettings   # an SDK object without the field: quote_enabled() is None, the HTTP answer decides
snap6 = pq.poll_root(api_m, "TXF", late)
check(snap6["ok"] is False and snap6["error"] == pq.NOT_ENABLED and len(dq_m.calls) == 1 and pq.quote_enabled(api_m) is None,
      "4 auth unknown + the SDK's not-enabled answer (MSG011) → QUOTE_NOT_ENABLED, not not_ok", snap6["error"])
pq._MSG_NOT_ENABLED = None
# settlement day 2026-10-21: 14:00 poll on the expiring month, 15:05 poll on the next — no 13:31–14:59 labels,
# the morning's closes stay the expiring month's, 15:01 is the next month's first bar
os.remove(pq.snapshot_path("TXF"))
dq_s = FakeQuote({"TXFJ6": bars_between(T(2026, 10, 20, 15, 0), T(2026, 10, 21, 13, 44), "TXFJ6", 100),
                  "TXFK6": bars_between(T(2026, 10, 20, 15, 0), T(2026, 10, 21, 15, 4), "TXFK6", 500)})
s1 = pq.poll_root(FakeApi(dq_s), "TXF", T(2026, 10, 21, 14, 0))
s2 = pq.poll_root(FakeApi(dq_s), "TXF", T(2026, 10, 21, 15, 5))
lab = lambda sn: [datetime.fromtimestamp(r[0], TAIPEI).strftime("%d %H:%M") for r in sn["rows"]]
close_at = lambda sn, ts: next(r[4] for r in sn["rows"] if r[0] == ts)
check(s1["productid"] == "TXFJ6" and lab(s1)[-1] == "21 13:30" and close_at(s1, utc_epoch(2026, 10, 21, 1, 0)) == 159.0,
      "4 settlement day 14:00: expiring month, last label 13:30, 09:00 close is its own", (s1["productid"], lab(s1)[-3:]))
mid = [x for x in lab(s2) if "21 13:30" < x < "21 15:01"]
check(s2["productid"] == "TXFK6" and not mid and lab(s2)[-1] == "21 15:05" and "21 15:01" in lab(s2)
      and close_at(s2, utc_epoch(2026, 10, 21, 1, 0)) == 159.0 and close_at(s2, utc_epoch(2026, 10, 21, 7, 1)) == 500.0
      and close_at(s2, utc_epoch(2026, 10, 21, 5, 30)) == 129.0,
      "4 settlement day 15:05: next month, no label between 13:30 and 15:01, the morning and the 13:30 bar keep the expiring "
      "month's closes, 15:01 is TXFK6's first", (s2["productid"], mid, lab(s2)[-6:]))
check(pq.in_session(T(2026, 10, 7, 9, 0)) and not pq.in_session(T(2026, 10, 7, 13, 55)) and pq.in_session(T(2026, 10, 7, 14, 56))
      and pq.in_session(T(2026, 10, 7, 23, 59)) and pq.in_session(T(2026, 10, 10, 3, 0)) and not pq.in_session(T(2026, 10, 10, 15, 0))
      and not pq.in_session(T(2026, 10, 11, 10, 0)) and not pq.in_session(T(2026, 10, 12, 3, 0)) and pq.in_session(T(2026, 10, 12, 8, 40)),
      "4 in_session: weekday 08:40–13:50 / 14:55–24:00, 00:00–05:05 after a weekday night (Saturday yes, Monday no), weekend no")
ps = pq.pause_root("TXF", "closed")
check(ps["paused"] == "closed" and ps["rows"] == s2["rows"] and ps["productid"] == "TXFK6" and ps["written_at"] >= int(time.time()) - 2
      and json.load(open(pq.snapshot_path("TXF"), encoding="utf-8"))["paused"] == "closed",
      "4 pause_root re-stamps the last snapshot with `paused`, rows and productid kept")
os.remove(pq.snapshot_path("TXF"))
ps = pq.pause_root("TXF", "maintenance")
check(ps["paused"] == "maintenance" and ps["rows"] == [] and ps["ok"] is False, "4 pause_root with no snapshot yet writes a bare paused one")

# ── 5. data.py seam ──
NOW = int(time.time())
m = NOW - NOW % 60  # the current minute boundary, epoch


def ts(k):  # END label k minutes before now
    return pd.Timestamp(m - k * 60, unit="s")


def frame(labels, close=None):
    idx = pd.DatetimeIndex([ts(k) for k in labels], name="time")
    close = close or {}
    return pd.DataFrame({"Open": 100.0, "High": 101.0, "Low": 99.0,
                         "Close": [float(close.get(k, 100.0)) for k in labels], "Volume": 10.0}, index=idx)


def seed_cache(labels, close=None, schema="1m"):
    cdir = d._monthly_cache_dir(f"twfutures3_{schema}", {"symbol": "TXF"})
    cdir.mkdir(parents=True, exist_ok=True)
    for f in cdir.glob("*.parquet"):
        f.unlink()
    df = frame(labels, close)
    for ym, grp in df.groupby(df.index.strftime("%Y-%m")):
        d._atomic_to_parquet(grp, cdir / f"{ym}.parquet")
    return cdir


def write_snap(labels, ok=True, error=None, age=0, close=None, paused=None, written_at=None):
    rows = [[m - k * 60, 100.0, 101.0, 99.0, float((close or {}).get(k, 100.0)), 10] for k in sorted(labels, reverse=True)]
    os.makedirs(pq.STATE, exist_ok=True)
    snap = {"root": "TXF", "productid": "TXFJ6", "label": "end", "ok": ok, "error": error,
            "written_at": NOW - age if written_at is None else written_at, "earliest": rows[0][0] if rows else None,
            "latest": rows[-1][0] if rows else None, "rows": rows}
    if paused:
        snap["paused"] = paused
    with open(pq.snapshot_path("TXF"), "w", encoding="utf-8") as f:
        json.dump(snap, f)


def source():
    p = d._STATE_DIR / "twfutures_live_source.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


raw_calls = []
delta = {"df": pd.DataFrame()}


def fake_raw(symbol, schema, s, e, headers):
    raw_calls.append((symbol, schema, s, e))
    return delta["df"]


d._fetch_twfutures_raw_smart = fake_raw
start = datetime.now(timezone.utc).replace(day=1).strftime("%Y-%m-%d")
# the current month's cache file must hold the current month: labels ≥ a few minutes back
# always do unless the test runs in the first minutes of a month — move them inside then
first_of_month = int(datetime.now(timezone.utc).replace(day=1, hour=0, minute=0, second=0, microsecond=0).timestamp())
if m - 15 * 60 < first_of_month:
    print("SKIP  5: within 15 minutes of a month boundary; the seam cases need the current month")
    sys.exit(1 if fails else 0)


def live(env=None, venue="president"):
    for k in ("BLAVE_MODE", "BLAVE_AGENT_LOCAL", "BLAVE_SCHEDULED_RUN", "BLAVE_TW_BROKER"):
        os.environ.pop(k, None)
    os.environ.update({"BLAVE_MODE": "live", "BLAVE_AGENT_LOCAL": "1"} if env is None else env)
    if venue:
        os.environ["BLAVE_TW_BROKER"] = venue


def run(labels_cache, snap_labels=None, schema="1m", **snapkw):
    raw_calls.clear()
    seed_cache(labels_cache, schema=schema, close=snapkw.pop("cache_close", None))
    try:
        (d._STATE_DIR / "twfutures_live_source.json").unlink()
    except OSError:
        pass
    if snap_labels is None:
        try:
            os.remove(pq.snapshot_path("TXF"))
        except OSError:
            pass
    else:
        write_snap(snap_labels, **snapkw)
    return d.fetch_twfutures_ohlcv("TXF", schema, start, None, {})


def labels_of(df):
    return sorted(int((m - x.timestamp()) // 60) for x in df.index)


live()
df = run([10, 9, 8, 7, 6, 5, 4, 3], [6, 5, 4, 3, 2, 1])
src = source()
check(labels_of(df) == [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] and src["source"] == "president" and src["reason"] is None and src["added"] == 2
      and src["root"] == "TXF" and src["traded"] == "TXF" and src["schema"] == "1m",
      "5 fresh snapshot overlapping Blave's last bar → 統一 adds the two missing minutes, source president", (labels_of(df), src))
check(len(raw_calls) == 1, "5 …Blave's delta fetch still ran first (not frozen)", raw_calls)
cached = pd.read_parquet(next(d._monthly_cache_dir("twfutures3_1m", {"symbol": "TXF"}).glob("*.parquet")))
check(labels_of(cached) == [3, 4, 5, 6, 7, 8, 9, 10], "5 …the broker's bars never enter the parquet cache", labels_of(cached))
delta["df"] = frame([2]).rename(columns=str)
df = run([10, 9, 8, 7, 6, 5, 4, 3], [6, 5, 4, 3, 2, 1], close={2: 555.0})
delta["df"] = pd.DataFrame()
check(labels_of(df) == [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] and df.loc[ts(2), "Close"] == 100.0 and source()["added"] == 1,
      "5 a minute Blave's delta brought this tick is Blave's; 統一 adds only what is still missing", (df.loc[ts(2), "Close"], source()))

df = run([10, 9, 8, 7, 6, 5, 4, 3], [6, 5, 4, 3, 2, 1], age=200)
check(labels_of(df) == [3, 4, 5, 6, 7, 8, 9, 10] and source()["source"] == "blave" and source()["reason"] == "stale",
      "5 snapshot older than 90 s → Blave alone, reason stale", source())
df = run([10, 9, 8, 7, 6, 5, 4, 3], [6, 5, 4, 3, 2, 1], ok=False, error="RuntimeError: boom")
check(labels_of(df) == [3, 4, 5, 6, 7, 8, 9, 10] and source()["reason"] == "not_ok:RuntimeError: boom", "5 snapshot ok=false → Blave, reason not_ok:<error>", source())
df = run([10, 9, 8, 7, 6, 5, 4, 3], [], ok=False, error=pq.NOT_ENABLED)
check(labels_of(df) == [3, 4, 5, 6, 7, 8, 9, 10] and source()["reason"] == "not_enabled", "5 auth_dquote False (worker wrote QUOTE_NOT_ENABLED) → Blave, reason not_enabled", source())
df = run([10, 9, 8, 7, 6, 5, 4, 3], None)
check(labels_of(df) == [3, 4, 5, 6, 7, 8, 9, 10] and source()["reason"] == "no_file", "5 no snapshot (worker never logged in) → Blave, reason no_file", source())
import logging  # noqa: E402
warned = []
logging.getLogger().addHandler(type("H", (logging.Handler,), {"emit": lambda self, rec: warned.append(rec.getMessage())})())
df = run([10, 9, 8, 7, 6, 5, 4, 3], [6, 5, 4, 3, 2, 1], paused="closed", age=3000)
check(labels_of(df) == [3, 4, 5, 6, 7, 8, 9, 10] and source()["source"] == "blave" and source()["reason"] == "paused" and not warned,
      "5 paused snapshot (no session / maintenance, however old) → Blave, reason paused, no stale warning", (source(), warned))
df = run([10, 9, 8, 7, 6, 5, 4, 3], [6, 5, 4, 3, 2, 1], written_at="x")
check(labels_of(df) == [3, 4, 5, 6, 7, 8, 9, 10] and source()["reason"] == "error:ValueError" and len(raw_calls) == 1,
      "5 a broken snapshot (written_at \"x\") never fails the tick: Blave alone, reason error:<Type>", source())
df = run([10, 9, 8, 7, 6, 5, 4, 3], [2, 1])
check(labels_of(df) == [3, 4, 5, 6, 7, 8, 9, 10] and source()["reason"] == "no_overlap",
      "5 snapshot starts after Blave's last bar (a minute missing in between) → Blave, reason no_overlap", source())
days = 3 * 1440
df = run([days + 2, days + 1, days], [6, 5, 4, 3, 2, 1])
check(labels_of(df) == [days, days + 1, days + 2] and source()["reason"] == "no_overlap",
      "5 ① bound 3 days after the backtest, the feed only 6 minutes deep → Blave alone, no_overlap (Blave's delta is what catches up)", source())
df = run([10, 9, 7, 6, 4, 3], [6, 5, 4, 3, 2, 1])
check(labels_of(df) == [1, 2, 3, 4, 5, 6, 7, 9, 10] and source()["source"] == "president" and source()["added"] == 3,
      "5 ② a hole inside Blave the feed covers (−5) is filled; one it does not (−8) stays as before", (labels_of(df), source()))
df = run([10, 9, 8, 7, 6, 5, 4, 3], [6, 5, 4, 3, 2, 1], close={3: 100.9, 4: 100.9, 1: 100.1}, cache_close={3: 100.0})
check(df.loc[ts(3), "Close"] == 100.0 and df.loc[ts(4), "Close"] == 100.0 and df.loc[ts(1), "Close"] == 100.1,
      "5 ④ where both have the minute Blave's values win; the tail is the feed's", (df.loc[ts(3), "Close"], df.loc[ts(1), "Close"]))
df = run([10, 9, 8, 7, 6, 5, 4, 3], [6, 5, 4, 3])
check(labels_of(df) == [3, 4, 5, 6, 7, 8, 9, 10] and source()["source"] == "president" and source()["added"] == 0,
      "5 feed fresh but nothing newer than Blave: source president, added 0", source())

reads = []
real_read = d._read_president_bars
d._read_president_bars = lambda *a: (reads.append(a), real_read(*a))[1]
live({})
df = run([10, 9, 8, 7, 6, 5, 4, 3], [6, 5, 4, 3, 2, 1])
check(labels_of(df) == [3, 4, 5, 6, 7, 8, 9, 10] and source() is None and reads == [] and len(raw_calls) == 1,
      "5 ⑤ not live (a backtest / a chat turn): the snapshot is never read, no source file, the old path byte for byte")
live({"BLAVE_MODE": "live", "BLAVE_AGENT_LOCAL": "1", "BLAVE_SCHEDULED_RUN": "1"})
df = run([10, 9, 8, 7, 6, 5, 4, 3], [6, 5, 4, 3, 2, 1])
check(labels_of(df) == [3, 4, 5, 6, 7, 8, 9, 10] and source() is None and reads == [], "5 a scheduled report run (BLAVE_SCHEDULED_RUN=1) is not a live tick")
live({"BLAVE_MODE": "live"})
df = run([10, 9, 8, 7, 6, 5, 4, 3], [6, 5, 4, 3, 2, 1])
check(labels_of(df) == [3, 4, 5, 6, 7, 8, 9, 10] and source() is None and reads == [], "5 a cloud machine (no BLAVE_AGENT_LOCAL) never reads it")
live(venue="capital")
df = run([10, 9, 8, 7, 6, 5, 4, 3], [6, 5, 4, 3, 2, 1])
check(labels_of(df) == [3, 4, 5, 6, 7, 8, 9, 10] and source() is None and reads == [], "5 a 群益-bound desktop never reads it")
live(venue=None)
df = run([10, 9, 8, 7, 6, 5, 4, 3], [6, 5, 4, 3, 2, 1])
check(labels_of(df) == [3, 4, 5, 6, 7, 8, 9, 10] and source() is None and reads == [], "5 no TW broker bound (no BLAVE_TW_BROKER) never reads it")
live()
df = run([10, 9, 8, 7, 6, 5, 4, 3], [6, 5, 4, 3, 2, 1])
check(len(reads) == 1 and source()["source"] == "president", "5 …back on a 統一-bound desktop live tick it is read")
d._read_president_bars = real_read
df = d.fetch_twfutures_ohlcv("MXF", "1m", start, None, {})
check(source()["traded"] == "MXF" and source()["root"] == "TXF" and labels_of(df) == [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      "5 an MXF / TMF strategy reads the TXF series + the TXF snapshot (same alias as the backtest), traded recorded", source())

# 5m: the feed's 1m rows are resampled the server's way, complete bins only
one = pd.DataFrame({"Open": 1.0, "High": 2.0, "Low": 0.5, "Close": 1.5, "Volume": 1.0},
                   index=pd.DatetimeIndex([pd.Timestamp("2026-10-08 01:06") + pd.Timedelta(minutes=i) for i in range(11)], name="time"))
r5 = d._resample_president(one, "5min", pd.Timestamp("2026-10-08 01:16:30").timestamp())
check(list(r5.index) == [pd.Timestamp("2026-10-08 01:10")] and r5.iloc[0]["Volume"] == 5,
      "5 5m: bin 01:10 (5 rows) is whole; 01:05 is dropped (rows start at 01:06, neither its first label nor a session opener); "
      "01:15 (01:19 missing, not past) is not", list(r5.index))
r5 = d._resample_president(one, "5min", pd.Timestamp("2026-10-08 01:20:00").timestamp())
check(list(r5.index)[-1] == pd.Timestamp("2026-10-08 01:15") and r5.iloc[-1]["Volume"] == 2,
      "5 5m: once the snapshot's written_at is past the bin's end a short bin (a session end) is whole", list(r5.index))
r5 = d._resample_president(one, "5min", pd.Timestamp("2026-10-08 01:19:30").timestamp())
check(list(r5.index)[-1] == pd.Timestamp("2026-10-08 01:10"),
      "5 5m: the clock is the snapshot's written_at, not the wall clock — a feed a minute behind (01:19 missing, written 01:19:30) keeps 01:15 short")
opener = one.copy(); opener.index = opener.index + (pd.Timestamp("2026-10-08 00:46") - pd.Timestamp("2026-10-08 01:06"))
r5 = d._resample_president(opener, "5min", pd.Timestamp("2026-10-08 01:00:00").timestamp())
check(list(r5.index)[0] == pd.Timestamp("2026-10-08 00:45") and r5.iloc[0]["Volume"] == 4,
      "5 5m: rows starting on the 08:46 Taipei opener keep their first (naturally short) bin", list(r5.index))
m5 = (m % 300) // 60   # minutes back to the last 5-minute boundary → the labels below are aligned
seed_cache([m5 + 20, m5 + 15, m5 + 10], schema="5m")
write_snap(list(range(m5 + 1, m5 + 15)))
raw_calls.clear()
df = d.fetch_twfutures_ohlcv("TXF", "5m", start, None, {})
src = source()
check(src["source"] == "president" and src["schema"] == "5m" and src["added"] == 1 and labels_of(df) == [m5 + 5, m5 + 10, m5 + 15, m5 + 20]
      and df.loc[ts(m5 + 5), "Volume"] == 50 and df.loc[ts(m5 + 10), "Volume"] == 10,
      "5 5m live tick: the feed's minutes become the whole 5m bin after Blave's last; Blave's own bin stays Blave's", (src, labels_of(df)))

# ── 6. thread loop, --once, mutation ──
holder = {"api": FakeApi(FakeQuote({"TXFJ6": bars_between(T(2026, 10, 8, 21, 0), T(2026, 10, 8, 21, 29))})), "stop": False}
pq.POLL_S = 1
pq.in_session = lambda now=None: True
polls, gate = [], {"pause": None, "raise": False}
real_poll = pq.poll_once


def fake_poll(api, now=None, roots=pq.ROOTS):
    polls.append(api)
    if gate["raise"]:
        raise RuntimeError("boom")
    return real_poll(api, now, roots)


pq.poll_once = fake_poll
th = threading.Thread(target=pq.loop, args=(holder,), kwargs={"pause": lambda: gate["pause"], "stop": lambda: holder["stop"]}, daemon=True)
th.start()
time.sleep(0.5)
n1 = len(polls)
gate["pause"] = "maintenance"
time.sleep(1.5)
n2, paused_snap = len(polls), json.load(open(pq.snapshot_path("TXF"), encoding="utf-8"))
gate["pause"], gate["raise"] = None, True
time.sleep(1.5)
n3, alive_after_raise = len(polls), th.is_alive()
holder["api"] = None
time.sleep(1.5)
n4 = len(polls)
holder["stop"] = True
th.join(3)
check(n1 >= 1 and n2 == n1 and paused_snap.get("paused") == "maintenance" and n3 > n2 and alive_after_raise and n4 == n3 and not th.is_alive(),
      "6 the loop polls while an api is held, re-stamps `paused` instead inside pause(), survives a raising poll, idles at None, ends on stop()",
      (n1, n2, n3, n4, paused_snap.get("paused"), alive_after_raise, th.is_alive()))
pq.in_session = lambda now=None: False
gate["raise"] = False
holder = {"api": FakeApi(FakeQuote()), "stop": False}
th = threading.Thread(target=pq.loop, args=(holder,), kwargs={"pause": lambda: None, "stop": lambda: holder["stop"]}, daemon=True)
th.start()
time.sleep(0.5)
holder["stop"] = True
th.join(3)
check(json.load(open(pq.snapshot_path("TXF"), encoding="utf-8")).get("paused") == "closed" and len(polls) == n4,
      "6 outside a session the loop only re-stamps `paused: closed`, no HTTP")
pq.poll_once = real_poll
src_w = open(os.path.join(ROOT, "lib", "president_worker.py"), encoding="utf-8").read()
once = src_w[src_w.index("def run_once("):src_w.index("def main(")]
import re  # noqa: E402
check("_quote_api" not in once and "president_quote" not in once and len(re.findall(r"^\s+_quote_api\(api\)$", src_w, re.M)) == 2,
      "6 --once (the user's 確認登入) never starts the quote thread; main hands every login to it")
check('daemon=True, name="president-quote"' in src_w and "_QUOTE[\"stop\"] = True" in src_w,
      "6 daemon thread, told to stop in main's finally")
# the daemon is what tells lib/data which TW broker is bound (BLAVE_TW_BROKER on a live tick only)
from unittest import mock  # noqa: E402
os.environ.setdefault("BLAVE_AGENT_HOME", TMP)
os.environ.setdefault("BLAVE_AGENT_BASE", TMP)
os.environ.setdefault("BLAVE_AGENT_WORKSPACE", os.path.join(TMP, "workspace"))
os.makedirs(os.environ["BLAVE_AGENT_WORKSPACE"], exist_ok=True)
sys.path.insert(0, os.path.join(ROOT, "runtime"))
import command_listener as cl  # noqa: E402
import importlib  # noqa: E402
bound = {"v": "president"}
WSREAL = os.path.realpath(cl.WORKSPACE)


class FakeVW:
    # hand_wired_venue reads two files by relative path: it must run with cwd = WORKSPACE, not only be imported there
    @staticmethod
    def hand_wired_venue():
        return bound["v"] if os.path.realpath(os.getcwd()) == WSREAL else "WRONG_CWD"


real_import = importlib.import_module
cwd0 = os.getcwd()
os.chdir(TMP)   # ≠ WORKSPACE
with mock.patch.dict(os.environ, {"BLAVE_AGENT_LOCAL": "1", "HOME": "/h"}, clear=True), mock.patch.object(os, "name", "posix"), \
        mock.patch.object(importlib, "import_module", lambda name, *a, **k: FakeVW if name == "lib.venue_wiring" else real_import(name, *a, **k)):
    tick, bt = cl._strategy_subprocess_env(), cl._strategy_subprocess_env("backtest")
    bound["v"] = None
    unbound = cl._strategy_subprocess_env()
    with mock.patch.object(importlib, "import_module", lambda name, *a, **k: (_ for _ in ()).throw(RuntimeError("no venue_wiring"))):
        broken = cl._strategy_subprocess_env()
os.chdir(cwd0)
check(tick.get("BLAVE_TW_BROKER") == "president" and tick.get("BLAVE_MODE") == "live" and "BLAVE_TW_BROKER" not in bt
      and "BLAVE_TW_BROKER" not in unbound and "BLAVE_TW_BROKER" not in broken and broken.get("BLAVE_MODE") == "live" and os.getcwd() == cwd0,
      "6 the desktop daemon's live tick env carries BLAVE_TW_BROKER=<hand-wired venue> read with cwd = WORKSPACE (daemon cwd elsewhere); "
      "a backtest, an unbound machine or a failed read carry none", (tick, bt))
check("venue_wiring" not in open(os.path.join(ROOT, "lib", "data.py"), encoding="utf-8").read().split("def _president_feed_live")[0]
      and "from lib import venue_wiring" not in open(os.path.join(ROOT, "lib", "data.py"), encoding="utf-8").read(),
      "6 lib/data never imports lib/venue_wiring (the scheduled-run guard's money-module closure)")
pq.BAR_LABEL_OFFSET_MIN = 0
mutated = pq.to_cache_rows([Bar("20261008", "084500")], "TXFJ6", N2)[0][0]
pq.BAR_LABEL_OFFSET_MIN = 1
check(mutated == utc_epoch(2026, 10, 8, 0, 45) != utc_epoch(2026, 10, 8, 0, 46), "6 mutation: with the label offset gone, section 2 would fail")

print(f"\n{'FAILED: ' + str(fails) if fails else 'all passed'}")
sys.exit(1 if fails else 0)
