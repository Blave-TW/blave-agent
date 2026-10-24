"""TAIFEX intraday strategies are quiet between sessions (manager/wait_for_bar.py, _tw_fut_quiet).

A 1h TXF strategy used to send bar_stale at 07:15 and 15:15 Taipei every trading day and again
daily over weekends: the expected bar is wall-clock, and after a close it is a bar that never
comes. Asserted here:

  1. _tw_fut_bar_exists against Blave's real labels: tests/fixtures/twfutures_bar_labels.json is
     every twfutures3 label lib.data.fetch_twfutures_ohlcv returned for TXF (index), CDF (a stock
     future with a night session) and DHF (day only), 1m/5m/15m/30m/60m, 2026-09-21..10-23 05:00
     Taipei (Blave had nothing later on 10-24), per Taipei date as run-length "HH:MM-HH:MM" on the
     schema's step. No observed bar is ever judged missing; for TXF the judged set is the observed
     one (sporadic untraded night minutes and the settlement day's 13:30 close aside).
  2. the known rows (60m 08:00 / 05:00 exist, 14:00 not; 1m label 08:46 first; weekends;
     holidays; the "Not known" cases), and a version that looks only at the bar's opening
     minute fails the 60m 08:00 row.
  3. _tw_futures_closed (priming, "is now in a session") and _tw_fut_bar_exists differ only in
     each session's closing minute.
  4. the real _tick on a fake clock: closed with every bar in → quiet; 13:44 missing → alerts;
     a weekend → no alert, fetches only on the throttle minutes; the first bar after the open
     is timed from its own close; the night's 05:00 bar missing → 06:15 alert; the holiday table
     wrong (bars land) → back to every bar; a stock future learns its night session.
  5. 29026's txf_supertrend_1h (1h, index), 10-14..10-23 on the fixture's bars: with the quiet
     switched off the alerts are 07:15 and 15:15 every trading day plus the weekend repeats;
     with it, none.
  6. a crypto strategy never reaches the new code (no table asked, no new state key).

Run: cd blave-agent && .venv/bin/python tests/check_tw_futures_quiet.py
"""
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import types
from datetime import date, datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import dotenv
dotenv.dotenv_values = lambda *a, **k: {}   # never read the workspace .env

BASE = tempfile.mkdtemp(prefix="tw-fut-quiet-")
stub_bin = os.path.join(BASE, "bin")
os.makedirs(stub_bin)
with open(os.path.join(stub_bin, "crontab"), "w") as f:
    f.write("#!/bin/sh\nexit 0\n")
os.chmod(os.path.join(stub_bin, "crontab"), 0o755)
os.environ["PATH"] = stub_bin + os.pathsep + os.environ.get("PATH", "")

spec = importlib.util.spec_from_file_location("wfb", os.path.join(ROOT, "manager", "wait_for_bar.py"))
wfb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wfb)

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


TPE = timedelta(hours=8)
M1 = timedelta(minutes=1)
H1 = timedelta(hours=1)
HOLIDAYS = {date(2026, 9, 25), date(2026, 9, 28), date(2026, 10, 9), date(2026, 10, 10)}
asked = []


def hol(d):
    asked.append(d)
    return d in HOLIDAYS


def T(mo, d, h, mi=0):
    """Taipei wall time → naive UTC (what the module works in)."""
    return datetime(2026, mo, d, h, mi) - TPE


def exists(kind, mo, d, h, mi, td_min, lots_night=False, fn=None):
    return (fn or wfb._tw_fut_bar_exists)(kind, T(mo, d, h, mi), timedelta(minutes=td_min), hol, lots_night)


# ── 1. against the cache's real labels ─────────────────────────────────────────
FIX = json.load(open(os.path.join(ROOT, "tests", "fixtures", "twfutures_bar_labels.json")))
STEP = {"1m": 1, "5m": 5, "15m": 15, "30m": 30, "60m": 60}
SETTLEMENT = {date(2026, 9, 16), date(2026, 10, 21)}   # third Wednesdays: day session to 13:30
START, END = datetime(2026, 9, 21), datetime(2026, 10, 23, 5, 1)   # Taipei; Blave stops at 10-23 05:00


def observed(sym, sch):
    out, step = set(), STEP[sch]
    for d, runs in FIX["series"][sym][sch].items():
        base = datetime.fromisoformat(d)
        for run in runs.split(","):
            a, _, b = run.partition("-")
            ha, ma = map(int, a.split(":"))
            hb, mb = map(int, (b or a).split(":"))
            for m in range(ha * 60 + ma, hb * 60 + mb + 1, step):
                out.add(base + timedelta(minutes=m))
    return out


def judged(kind, sch, lots_night):
    """Taipei labels Blave should publish. ≥5m: bar_exists(L). 1m: Blave stamps the close minute,
    and bar_exists(L) also holds for the open minute L whose bar is labelled L+1m — the label L is
    real when both L and L−1m hold (sessions are contiguous)."""
    td = timedelta(minutes=STEP[sch])
    out, t = set(), START
    while t < END:
        u = t - TPE
        if wfb._tw_fut_bar_exists(kind, u, td, hol, lots_night) and (
                sch != "1m" or wfb._tw_fut_bar_exists(kind, u - M1, td, hol, lots_night)):
            out.add(t)
        t += td
    return out


def session_edges(labels):
    """{(date, part): (first, last)} — 'day' for 08:00–13:59 labels, else the night by its
    opening date."""
    edges = {}
    for x in sorted(labels):
        if 8 <= x.hour < 14:
            key = (x.date(), "day")
        else:
            key = ((x - timedelta(hours=8)).date() if x.hour < 8 else x.date(), "night")
        lo, hi = edges.get(key, (x, x))
        edges[key] = (min(lo, x), max(hi, x))
    return edges


for sym, kind, night in (("TXF", "index", False), ("CDF", "lots", True), ("DHF", "lots", False)):
    for sch in STEP:
        obs = {x for x in observed(sym, sch) if START <= x < END}
        first = datetime.fromisoformat(min(FIX["series"][sym][sch]))   # DHF's series starts 10-05
        pred = {x for x in judged(kind, sch, night) if x >= first}
        missed = sorted(obs - pred)
        check(not missed, f"{sym} {sch}: every observed label judged existing ({len(obs)} labels)"
                          + (f" — missed {[str(x) for x in missed[:5]]}" if missed else ""))
        eo, ep = session_edges(obs), session_edges(pred)
        bad = []
        for key, (lo, hi) in ep.items():
            got = eo.get(key)
            if key[0] in SETTLEMENT and key[1] == "day" and got and got[0] == lo:
                continue   # the expiring contract stops at 13:30 — the documented "Not known"
            if got != (lo, hi) and (sym == "TXF" or key[1] == "day"):
                bad.append((str(key), got and (str(got[0]), str(got[1])), (str(lo), str(hi))))
        check(not bad and set(eo) <= set(ep),
              f"{sym} {sch}: each session's first and last label as judged ({len(ep)} sessions)"
              + (f" — {bad[:3]}" if bad else ""))
        if sym == "TXF":
            extra = sorted(x for x in pred - obs if x.date() not in SETTLEMENT)
            if sch == "1m":
                check(all(not 8 <= x.hour < 14 for x in extra),
                      f"TXF 1m: judged-but-absent labels are only untraded night minutes ({len(extra)})")
            else:
                check(not extra, f"TXF {sch}: nothing judged existing that Blave did not publish"
                                 + (f" — {[str(x) for x in extra[:5]]}" if extra else ""))
check(all(8 <= x.hour < 14 for x in observed("DHF", "1m")), "DHF publishes no night session")
cdf_night = {x for x in observed("CDF", "1m") if not 8 <= x.hour < 14}
check(cdf_night and not any(wfb._tw_fut_bar_exists("lots", x - TPE - M1, M1, hol, False) for x in cdf_night),
      "CDF's night labels, night session not learned: judged absent (the escape hatch's case)")
check(min(x.hour * 60 + x.minute for x in cdf_night if x.hour >= 14) == 17 * 60 + 26,
      "CDF's night opens 17:25 (first 1m label 17:26)")

# ── 2. the known rows ─────────────────────────────────────────────────────────
KNOWN = [  # kind, Taipei (mo, d, h, mi), td minutes, lots_night, want, label — 10-20 Tue
    ("index", (10, 20, 8, 0), 60, False, True, "60m 08:00 (holds 08:45–09:00)"),
    ("index", (10, 20, 5, 0), 60, False, True, "60m 05:00 (the night's last trade; 29026 state)"),
    ("index", (10, 20, 14, 0), 60, False, False, "60m 14:00"),
    ("index", (10, 20, 6, 0), 60, False, False, "60m 06:00"),
    ("index", (10, 20, 7, 0), 60, False, False, "60m 07:00"),
    ("index", (10, 20, 13, 0), 60, False, True, "60m 13:00 (holds 13:45)"),
    ("index", (10, 20, 15, 0), 60, False, True, "60m 15:00"),
    ("index", (10, 20, 8, 30), 30, False, True, "30m 08:30 (1h/30m labels on the hour/half hour)"),
    ("index", (10, 20, 13, 30), 30, False, True, "30m 13:30 (holds 13:45)"),
    ("index", (10, 20, 14, 0), 30, False, False, "30m 14:00"),
    ("index", (10, 20, 13, 45), 15, False, True, "15m 13:45 (the 13:45 label alone)"),
    ("index", (10, 20, 8, 44), 1, False, False, "1m wait for 08:44"),
    ("index", (10, 20, 8, 45), 1, False, True, "1m wait for 08:45 (ended by the 08:46 label)"),
    ("index", (10, 20, 13, 45), 1, False, True, "1m wait for 13:45 (the 13:45 label)"),
    ("index", (10, 20, 13, 46), 1, False, False, "1m wait for 13:46"),
    ("index", (10, 21, 5, 0), 1, False, True, "1m wait for 05:00 (the 05:00 label)"),
    ("index", (10, 21, 5, 1), 1, False, False, "1m wait for 05:01"),
    ("index", (10, 20, 14, 59), 1, False, False, "1m wait for 14:59"),
    ("index", (10, 20, 15, 0), 1, False, True, "1m wait for 15:00 (ended by 15:01)"),
    ("index", (10, 20, 8, 40), 5, False, False, "5m 08:40"),
    ("index", (10, 20, 8, 45), 5, False, True, "5m 08:45"),
    ("lots", (10, 20, 15, 0), 60, False, False, "lots 60m 15:00"),
    ("lots", (10, 20, 15, 0), 5, False, False, "lots 5m 15:00"),
    ("lots", (10, 20, 8, 0), 60, False, True, "lots 60m 08:00"),
    ("lots", (10, 20, 13, 45), 5, False, True, "lots 5m 13:45"),
    ("lots", (10, 21, 5, 0), 60, False, False, "lots 60m 05:00, no night session"),
    ("lots", (10, 21, 5, 0), 60, True, True, "lots 60m 05:00, night session learned"),
    ("lots", (10, 20, 17, 0), 60, True, True, "lots 60m 17:00, night learned (holds 17:26–)"),
    ("lots", (10, 20, 17, 20), 5, True, False, "lots 5m 17:20, night learned"),
    ("index", (10, 17, 5, 0), 60, False, True, "Friday's night → Saturday 05:00 exists"),
    ("index", (10, 17, 6, 0), 60, False, False, "Saturday 06:00"),
    ("index", (10, 17, 15, 0), 60, False, False, "Saturday 15:00"),
    ("index", (10, 18, 3, 0), 60, False, False, "Sunday 03:00"),
    ("index", (10, 19, 3, 0), 60, False, False, "Monday 03:00 (no Sunday night)"),
    ("index", (10, 19, 8, 0), 60, False, True, "Monday 08:00"),
    ("index", (10, 19, 8, 44), 1, False, False, "Monday 1m 08:44"),
    ("index", (10, 9, 10, 0), 60, False, False, "holiday 10-09: day session"),
    ("index", (10, 9, 16, 0), 60, False, False, "holiday 10-09: its night session"),
    ("index", (10, 10, 3, 0), 60, False, False, "holiday 10-09: its night after midnight"),
    ("index", (10, 9, 3, 0), 60, False, True, "holiday 10-09: the night before, past midnight (Thursday's)"),
    ("index", (10, 8, 20, 0), 60, False, True, "the evening before a holiday trades"),
    ("index", (10, 21, 13, 40), 5, False, True, "Not known: settlement day 13:40 counted (stops 13:30)"),
    ("index", (10, 20, 10, 0), 60, False, True, "Not known: a typhoon day (off the table) counted"),
]


def known_failures(fn):
    return [label for kind, (mo, d, h, mi), tdm, night, want, label in KNOWN
            if exists(kind, mo, d, h, mi, tdm, night, fn) is not want]


bad = known_failures(None)
check(not bad, f"known rows ({len(KNOWN)}) hold" + (f" — {bad}" if bad else ""))


def opening_minute_only(kind, bar_open, td, holiday_fn, lots_night=False):
    """The wrong rule: a bar exists when its own first minute is inside a session."""
    t = bar_open + TPE
    return any(a <= t < b for d in (t.date(), t.date() - timedelta(days=1))
               if d.weekday() <= 4 and not holiday_fn(d)
               for a, b in wfb._tw_fut_sessions(kind, d, lots_night))


wrong = known_failures(opening_minute_only)
check("60m 08:00 (holds 08:45–09:00)" in wrong,
      f"the opening-minute-only rule fails the 60m 08:00 row (it fails {len(wrong)} rows)")

# ── 3.–6. on a workspace ──────────────────────────────────────────────────────
WS = os.path.join(BASE, "ws")
TXF_SRC = ('SYMBOL = "TXF"\nINTERVAL = "{iv}"\n'
           'def fetch_data(h):\n    return fetch_twfutures_ohlcv("TXF", "60m", "2026-01-01", None, h)\n')
for n, src in (("tx", TXF_SRC.format(iv="1h")), ("tx1", TXF_SRC.format(iv="1m")),
               ("tx5", TXF_SRC.format(iv="5m")),
               ("sf", 'SYMBOL = "CDF"\nINTERVAL = "5m"\nfrom lib.data import fetch_twfutures_ohlcv\n'
                      'def fetch_data(h):\n    return fetch_twfutures_ohlcv(SYMBOL, "5m", "2026-01-01", None, h)\n'),
               ("sfx", 'SYMBOL = "CDF"\nINTERVAL = "5m"\nfrom lib.data import fetch_kline\n'
                       'def fetch_data(h):\n    return fetch_kline("TSMUSDT", "5m", "2026-01-01", None, h)\n'),
               ("sfmix", 'INTERVAL = "5m"\nfrom lib.data import fetch_kline, fetch_twfutures_ohlcv\n'
                         'def fetch_data(h):\n    return fetch_twfutures_ohlcv("CDF", "5m", "2026-01-01", None, h), '
                         'fetch_kline("BTCUSDT", "5m", "2026-01-01", None, h)\n'),
               ("sfnote", 'INTERVAL = "5m"\n# priced like fetch_twfutures_ohlcv("CDF") would be\n'
                          'def fetch_data(h):\n    return None\n'),
               ("btc", 'SYMBOL = "BTCUSDT"\nINTERVAL = "1h"\ndef fetch_data(h):\n    return None\n')):
    os.makedirs(os.path.join(WS, "strategies", n))
    open(os.path.join(WS, "strategies", n, "strategy.py"), "w").write(src)
os.makedirs(os.path.join(WS, "manager"))
LOTS = ("sf", "sfx", "sfmix", "sfnote", "sfgone")
json.dump({"amounts": {n: 1 for n in LOTS}, "exchanges": {n: "" for n in LOTS},
           "asset_specs": {n: {"type": "futures_contracts", "contract_value": 2000} for n in LOTS}},
          open(os.path.join(WS, "manager", "portfolio_config.json"), "w"))
os.makedirs(os.path.join(WS, "state", "bar_wait"))
os.chdir(WS)
wfb._tw_holiday = hol
try:
    # ── 3. parity with _tw_futures_closed ─────────────────────────────────────
    # 5 day sessions (10-09 the holiday) and, for index, 4 nights (Thursday's runs into 10-09)
    for name, kind, closes, n in (("tx", "index", {"13:45", "05:00"}, 9), ("sf", "lots", {"13:45"}, 5)):
        diff, t = set(), T(10, 5, 0)
        while t < T(10, 13, 0):   # Mon 10-05 .. Mon 10-12: a weekend and the 10-09 holiday
            if wfb._tw_futures_closed(name, t) is wfb._tw_fut_bar_exists(kind, t, M1, hol):
                diff.add(t)
            t += M1
        hm = {(x + TPE).strftime("%H:%M") for x in diff}
        check(hm == closes and len(diff) == n,
              f"{kind}: _tw_futures_closed and _tw_fut_bar_exists(1m) differ only at {sorted(closes)}, "
              f"{n} sessions → {sorted(str(x + TPE) for x in diff)}")

    # ── 4. the real _tick on a fake clock ─────────────────────────────────────
    class _Clock(datetime):
        at = T(10, 20, 10)

        @classmethod
        def now(cls, tz=None):
            return cls.at.replace(tzinfo=tz) if tz else cls.at
    wfb.datetime = _Clock
    wfb.time = types.SimpleNamespace(time=lambda: (_Clock.at - datetime(1970, 1, 1)).total_seconds(),
                                     monotonic=lambda: 0.0, sleep=lambda s: None)
    mods, load = {}, wfb._load_strategy_module
    wfb._load_strategy_module = lambda n: mods.get(n) or mods.setdefault(n, load(n))
    feed = {"labels": [], "td": H1}
    fetches, alerts, runs = [], [], []

    def freshness(mod, expected):
        now = _Clock.at
        fetches.append(now)
        seen = [x for x in feed["labels"] if x + feed["td"] <= now]
        last = max(seen) if seen else None
        return last, last is not None and last >= expected, None, ({"": last} if last else None)
    wfb._check_freshness = freshness
    wfb._alert_stale = lambda name, expected, minutes, who, computed=False: alerts.append((_Clock.at, minutes))
    wfb._run_strategy_protected = lambda name: runs.append(_Clock.at) or True

    def labels_for(sym, sch):
        return sorted(x - TPE for x in observed(sym, sch))

    def drive(name, start, end, reset=True):
        if reset:
            wfb._save_state(name, wfb._default_state())
        del fetches[:], alerts[:], runs[:]
        t = start
        while t < end:
            _Clock.at = t + timedelta(seconds=10)
            wfb._tick(name)
            t += M1
        return wfb._load_state(name)

    def tpe(xs):
        return [(x + TPE).strftime("%m-%d %H:%M") for x in xs]

    # a day close, every bar in: 60m TXF, Tue 10-20 13:30 → 16:30
    feed.update(labels=labels_for("TXF", "60m"), td=H1)
    st = drive("tx", T(10, 20, 13, 30), T(10, 20, 16, 30))
    check(not alerts and st["pending_since"] is None and st["last_processed_bar"] == T(10, 20, 15).isoformat(),
          f"60m day close, bars in: no alert, pending_since None, the 15:00 bar run → {tpe(a for a, _ in alerts)}")
    quiet_fetches = [x for x in fetches if T(10, 20, 14, 1) <= x < T(10, 20, 16)]
    check(quiet_fetches and all((x + TPE).minute % 15 in (0, 5) for x in quiet_fetches),
          f"…between sessions it fetches only on the throttle minutes → {tpe(quiet_fetches)}")
    check(tpe(runs[1:]) == ["10-20 14:00", "10-20 16:00"],
          f"…(after the 12:00 bar at the start) 13:00 bar run at 14:00, 15:00 bar at 16:00 → {tpe(runs)}")

    # 13:44 never came (1m): a real lateness — alerts 15 minutes after the first poll that missed it
    feed.update(labels=[x for x in labels_for("TXF", "1m") if x < T(10, 20, 13, 44)], td=M1)
    drive("tx1", T(10, 20, 13, 30), T(10, 20, 14, 30))
    check(tpe([a for a, _ in alerts][:1]) == ["10-20 14:00"],
          f"1m, the 13:44 label missing after the close: alerts 14:00 (pending from 13:45) → "
          f"{tpe(a for a, _ in alerts)}")

    # a whole weekend (60m and 1m): no alert, fetches only on the throttle minutes
    for name, sch, td in (("tx", "60m", H1), ("tx1", "1m", M1)):
        feed.update(labels=labels_for("TXF", sch), td=td)
        drive(name, T(10, 16, 14, 0), T(10, 17, 5, 30))   # Friday's night into Saturday
        drive(name, T(10, 17, 5, 30), T(10, 19, 8, 0), reset=False)
        off = [x for x in fetches if (x + TPE).minute % 15 not in (0, 5)]
        check(not alerts and not off and fetches,
              f"{sch} weekend Sat 05:30 → Mon 08:00: no alert, {len(fetches)} fetches, all on the throttle "
              f"minutes → {tpe(a for a, _ in alerts)} {tpe(off[:3])}")

    # the first bar after the open
    feed.update(labels=labels_for("TXF", "1m"), td=M1)
    drive("tx1", T(10, 16, 4, 50), T(10, 19, 9, 0))
    first = [r for r in runs if r > T(10, 19, 8, 0)][:1]
    check(not alerts and tpe(first) == ["10-19 08:47"],
          f"1m Monday open: first run 08:47 (the 08:46 label lands 08:47 here), no alert → {tpe(first)}")

    # the open's first bar does not come: timed from its own close, not from Saturday 05:00
    feed.update(labels=[x for x in labels_for("TXF", "60m") if x < T(10, 19, 8)], td=H1)
    drive("tx", T(10, 17, 4, 0), T(10, 19, 10, 0))
    check([(a, m) for a, m in zip(tpe(a for a, _ in alerts), (m for _, m in alerts))] == [("10-19 09:15", 15)],
          f"60m Monday 08:00 bar missing: one alert 09:15, waited 15 → {list(zip(tpe(a for a, _ in alerts), [m for _, m in alerts]))}")

    # the night's 05:00 bar never comes: 06:15 as before
    feed.update(labels=[x for x in labels_for("TXF", "60m") if x < T(10, 21, 5)], td=H1)
    drive("tx", T(10, 21, 3, 30), T(10, 21, 7, 0))
    check(tpe(a for a, _ in alerts) == ["10-21 06:15"], f"60m 05:00 bar missing: alerts 06:15 → {tpe(a for a, _ in alerts)}")

    # the holiday table wrong (10-20 on it, the market traded): bars still run, back to every bar
    HOLIDAYS.add(date(2026, 10, 20))
    feed.update(labels=labels_for("TXF", "5m"), td=timedelta(minutes=5))
    drive("tx5", T(10, 20, 8, 0), T(10, 20, 10, 0))
    gaps = [b - a for a, b in zip(runs, runs[1:])]
    check(runs and runs[0] <= T(10, 20, 9, 0) and gaps and max(gaps) <= timedelta(minutes=5),
          f"table says closed but bars land: first run {tpe(runs[:1])} (bar due 08:50), then every bar "
          f"(max gap {max(gaps) if gaps else None})")
    HOLIDAYS.discard(date(2026, 10, 20))

    # a stock future with a night session: learned from the first night bar it sees
    feed.update(labels=labels_for("CDF", "5m"), td=timedelta(minutes=5))
    st = drive("sf", T(10, 20, 13, 30), T(10, 20, 19, 0))
    night_runs = [r for r in runs if r > T(10, 20, 17)]
    check(st.get("tw_fut_night_bar") and night_runs and not alerts,
          f"CDF 5m: night session learned ({st.get('tw_fut_night_bar')}), night bars run, no alert; "
          f"first night run {tpe(night_runs[:1])} (10-20's first 5m bar is 17:30, due 17:35)")
    drive("sf", T(10, 22, 13, 30), T(10, 22, 19, 0), reset=False)
    first_night = [r for r in runs if r > T(10, 22, 17)][:1]
    check(tpe(first_night) == ["10-22 17:30"],
          f"…next evening, learned: the 17:25 bar runs as it lands → {tpe(first_night)}")
    feed.update(labels=labels_for("DHF", "5m"), td=timedelta(minutes=5))
    drive("sf", T(10, 16, 13, 0), T(10, 19, 9, 0))
    check(not alerts, f"DHF 5m (day only) Friday close → Monday open: no alert → {tpe(a for a, _ in alerts)}")

    # night learning: on the ready path too (a feed that is never late), only 17:25–05:00 labels,
    # and it lapses
    full = [x for x in (T(10, 20, 13) + timedelta(minutes=5 * i) for i in range(12 * 20))
            if wfb._tw_fut_bar_exists("lots", x, timedelta(minutes=5), hol, True)]
    feed.update(labels=full, td=timedelta(minutes=5))
    st = drive("sf", T(10, 20, 13, 0), T(10, 20, 17, 31))
    check(st.get("tw_fut_night_bar") == T(10, 20, 17, 25).isoformat(),
          f"…learned from the first night bar, which was ready on its first poll → {st.get('tw_fut_night_bar')}")
    st = drive("sf", T(10, 20, 17, 31), T(10, 21, 9, 0), reset=False)
    check(st.get("tw_fut_night_bar") and not alerts,
          f"CDF 5m feed never late (every bar ready on its first poll): night learned on the ready "
          f"path, no alert through 05:00 and after → {st.get('tw_fut_night_bar')} {tpe(a for a, _ in alerts)}")
    stray = [x for x in labels_for("DHF", "5m") if x < T(10, 20, 14)] + [T(10, 20, 15, 30)]
    feed.update(labels=sorted(stray), td=timedelta(minutes=5))
    st = drive("sf", T(10, 20, 13, 0), T(10, 20, 17, 0))
    check(not st.get("tw_fut_night_bar") and not wfb._tw_fut_night_label(T(10, 20, 15, 30), timedelta(minutes=5))
          and not wfb._tw_fut_night_label(T(10, 20, 10, 0), H1) and wfb._tw_fut_night_label(T(10, 20, 17, 0), H1)
          and wfb._tw_fut_night_label(T(10, 17, 4, 0), H1) and not wfb._tw_fut_night_label(T(10, 17, 10, 0), H1),
          "a stray 15:30 label is not a night bar (only 17:25–05:00 is), nor a day or weekend one")
    keep = wfb.TW_FUT_NIGHT_KEEP_DAYS
    st = {"tw_fut_night_bar": T(10, 1, 2).isoformat()}
    check(wfb._tw_fut_lots_night(st, T(10, 1, 2) + timedelta(days=keep) - M1)
          and not wfb._tw_fut_lots_night(st, T(10, 1, 2) + timedelta(days=keep) + M1)
          and not wfb._tw_fut_lots_night({}, T(10, 1, 2)) and not wfb._tw_fut_lots_night({"tw_fut_night_bar": "x"}, T(10, 1, 2)),
          f"a learned night lapses {keep} days after the last night bar seen")

    # sized in lots but not priced off TAIFEX: no quiet, the old alerting
    check(wfb._tw_fut_data("sf") and wfb._tw_fut_data("tx") and not wfb._tw_fut_data("sfx")
          and not wfb._tw_fut_data("sfmix") and not wfb._tw_fut_data("sfnote") and not wfb._tw_fut_data("sfgone"),
          "TAIFEX data gate: twfutures fetchers only (a crypto feed, a mix, a comment, no source → no)")
    feed.update(labels=labels_for("DHF", "5m"), td=timedelta(minutes=5))
    drive("sfx", T(10, 16, 13, 0), T(10, 17, 9, 0))
    check(alerts, f"lots strategy priced off a crypto feed: alerts as before → {tpe(a for a, _ in alerts)[:3]}")

    # a Lunar New Year closure (2026: 02-12 .. 02-22 with the weekends), 60m index
    lny = {date(2026, 2, 12), date(2026, 2, 13)} | {date(2026, 2, d) for d in range(15, 21)}
    HOLIDAYS.update(lny)
    feed.update(labels=[x for x in (T(2, 9, 0) + H1 * i for i in range(24 * 16))
                        if wfb._tw_fut_bar_exists("index", x, H1, hol)], td=H1)
    drive("tx", T(2, 11, 12, 0), T(2, 23, 10, 0))
    first = [r for r in runs if r > T(2, 13, 0)][:1]
    check(not alerts and tpe(first) == ["02-23 09:00"],
          f"Lunar New Year, 11 days closed: 0 alerts, the reopening 08:00 bar runs 09:00 → "
          f"{tpe(a for a, _ in alerts)[:3]} {tpe(first)}")
    lookback = wfb._tw_fut_last_bar_before
    wfb._tw_fut_last_bar_before = lambda *a, **k: lookback(*a, **{**k, "days": 7})
    drive("tx", T(2, 11, 12, 0), T(2, 23, 10, 0))
    check(alerts, f"…with the old 7-day lookback the closure alerts again → {tpe(a for a, _ in alerts)[:3]}")
    wfb._tw_fut_last_bar_before = lookback
    HOLIDAYS.difference_update(lny)

    # ── 5. 29026 txf_supertrend_1h: 1h index, 10-14 → 10-23 07:30 Taipei ─────
    feed.update(labels=labels_for("TXF", "60m"), td=H1)
    real_quiet = wfb._tw_fut_quiet
    wfb._tw_fut_quiet = lambda *a, **k: False   # the old code: no quiet anywhere
    drive("tx", T(10, 14, 0), T(10, 23, 7, 30))
    old = [a + TPE for a, _ in alerts]
    wfb._tw_fut_quiet = real_quiet
    drive("tx", T(10, 14, 0), T(10, 23, 7, 30))
    new = list(alerts)
    weekday = [a for a in old if a.weekday() <= 4 and a.date() != date(2026, 10, 19) or a.hour >= 8]
    check(weekday and {a.strftime("%H:%M") for a in weekday} == {"07:15", "15:15"},
          f"old code: every trading-day alert at 07:15 or 15:15 → {[a.strftime('%m-%d %H:%M') for a in old]}")
    wkend = [a.strftime("%m-%d %H:%M") for a in old if a.date() in (date(2026, 10, 18), date(2026, 10, 19)) and a.hour < 8]
    check("10-17 07:15" in [a.strftime("%m-%d %H:%M") for a in old] and len(wkend) == 2,
          f"old code: Saturday 07:15 and its daily repeats Sunday and Monday → {wkend}")
    check(not new, f"new code: 0 alerts over the same clock → {tpe(a for a, _ in new)}")

    # ── 6. crypto never reaches it ────────────────────────────────────────────
    calls = []
    for f in ("_tw_fut_quiet", "_tw_fut_holiday_memo"):
        setattr(wfb, f, (lambda o: lambda *a, **k: calls.append(o.__name__) or o(*a, **k))(getattr(wfb, f)))
    del asked[:]
    feed.update(labels=[T(10, 17, 0) + timedelta(hours=i) for i in range(-48, 30)], td=H1)
    st = drive("btc", T(10, 17, 0), T(10, 18, 6, 0))
    check(not calls and not asked and not any(k.startswith("tw_fut") for k in st),
          f"crypto: the TAIFEX code never runs, no table asked, no new state key → {calls[:3]} {sorted(st)}")
finally:
    os.chdir(ROOT)
    shutil.rmtree(BASE, ignore_errors=True)

print("\ncheck_tw_futures_quiet: " + ("PASS" if not fails else f"FAILED ({fails})"))
sys.exit(1 if fails else 0)
