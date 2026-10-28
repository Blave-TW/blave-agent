"""A feed that keeps moving but stays one bar short alerts once (manager/wait_for_bar.py, _track_lag).

43eafaa3 restarts pending_since whenever the data moves, so on INTERVAL under 15m a 1m bar that
always lands after the :35 retry is never ready, never primed (inside its grace) and never
alerted: 0 signals all session, no word. Asserted here, the real _tick on a fake clock (ticks at
:05, :20 and :35 like the runtime), freshness probe stubbed by a per-member feed with a delay:

  L  crypto 1m, every bar 40s past its minute: one lag alert 15 minutes in, no bar_stale,
     nothing more inside 24h, again after; TWSE 1m the same mid-session; a Type C member two
     bars behind and moving: one alert naming it.
  Q  TWSE 1m quiet: prompt bars over the close, a weekend and a holiday on the table → no
     alert of either kind; Monday's open one bar short with Friday 13:30 the last run → no
     alert by 09:10; no lunch break: a feed stopping at 12:00 still sends bar_stale at 12:15,
     once, and no lag alert beside it.
  N  no lag alert when nothing is wrong or bar_stale already speaks: crypto 1m prompt for
     3 hours; back from a 30-minute outage, the first bar in only by the :35 retry; a real stall (bar_stale once, no lag alert);
     30m with a stuck and a late feed (lag alert never, lag_since never written).

Run: cd blave-agent && .venv/bin/python tests/check_bar_wait_lag.py
     BAR_WAIT_UNDER_TEST=<path to another wait_for_bar.py> runs the same checks against that copy.
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

BASE = tempfile.mkdtemp(prefix="bar-wait-lag-")
stub_bin = os.path.join(BASE, "bin")
os.makedirs(stub_bin)
with open(os.path.join(stub_bin, "crontab"), "w") as f:
    f.write("#!/bin/sh\nexit 0\n")
os.chmod(os.path.join(stub_bin, "crontab"), 0o755)
os.environ["PATH"] = stub_bin + os.pathsep + os.environ.get("PATH", "")

spec = importlib.util.spec_from_file_location(
    "wfb_lag", os.environ.get("BAR_WAIT_UNDER_TEST") or os.path.join(ROOT, "manager", "wait_for_bar.py"))
wfb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wfb)

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


TPE = timedelta(hours=8)
M1 = timedelta(minutes=1)
HOLIDAYS = set()


def T(mo, d, h, mi=0):
    """Taipei wall time (2026) → naive UTC."""
    return datetime(2026, mo, d, h, mi) - TPE


WS = os.path.join(BASE, "ws")
TW = ('SYMBOL = "2330"\nINTERVAL = "{iv}"\nfrom lib.data import fetch_twstock_ohlcv\n'
      'def fetch_data(h):\n    return fetch_twstock_ohlcv(SYMBOL, "{iv}", h)\n')
BTC = ('SYMBOL = "BTCUSDT"\nINTERVAL = "{iv}"\nfrom lib.data import fetch_kline\n'
       'def fetch_data(h):\n    return fetch_kline(SYMBOL, "{iv}", "2026-01-01", None, h)\n')
for n, src in (("tw1", TW.format(iv="1m")), ("btc1", BTC.format(iv="1m")),
               ("btc30", BTC.format(iv="30m")), ("c1", BTC.format(iv="1m"))):
    os.makedirs(os.path.join(WS, "strategies", n))
    open(os.path.join(WS, "strategies", n, "strategy.py"), "w").write(src)
os.makedirs(os.path.join(WS, "manager"))
json.dump({}, open(os.path.join(WS, "manager", "portfolio_config.json"), "w"))
os.makedirs(os.path.join(WS, "state", "bar_wait"))
cwd = os.getcwd()
os.chdir(WS)
wfb._tw_holiday = lambda d, unknown=False: d in HOLIDAYS
try:
    class _Clock(datetime):
        at = T(10, 27, 10)

        @classmethod
        def now(cls, tz=None):
            return cls.at.replace(tzinfo=tz) if tz else cls.at
    wfb.datetime = _Clock
    clock_skew = {"s": 0.0}   # seconds added to time.time(): jumps a day without driving it
    wfb.time = types.SimpleNamespace(
        time=lambda: (_Clock.at - datetime(1970, 1, 1)).total_seconds() + clock_skew["s"],
        monotonic=lambda: 0.0, sleep=lambda s: None)
    mods, load = {}, wfb._load_strategy_module
    wfb._load_strategy_module = lambda n: mods.get(n) or mods.setdefault(n, load(n))

    # feed: {member: (labels, td, delay, stop)} — label x is served from x + td + delay on,
    # never from `stop` on. One member = Type A.
    feed = {}
    stale, lags, runs = [], [], []

    def freshness(mod, expected):
        now = _Clock.at
        latest = {}
        for k, (labels, td, delay, stop) in feed.items():
            seen = [x for x in labels if x + td + delay <= now and (stop is None or x < stop)]
            if seen:
                latest[k] = max(seen)
        if not latest:
            return None, False, None, None
        if len(feed) == 1:
            last = next(iter(latest.values()))
            return last, last >= expected, None, {"": last}
        who = min(latest, key=latest.get)
        return latest[who], all(v >= expected for v in latest.values()), who, latest
    wfb._check_freshness = freshness
    wfb._alert_stale = lambda name, expected, minutes, who, computed=False: stale.append((_Clock.at, minutes, who))
    wfb._alert_lag = lambda name, minutes, who: lags.append((_Clock.at, minutes, who))
    wfb._run_strategy_protected = lambda name: runs.append(_Clock.at) or True

    def bars(start, end, td=M1, tw=False):
        out, x = [], start
        while x < end:
            if not tw or wfb._tw_stock_bar_exists(x, td, lambda d: d in HOLIDAYS):
                out.append(x)
            x += td
        return out

    def drive(name, start, end, state=None, offsets=(5, 20, 35), keep=False):
        if not keep:
            wfb._save_state(name, {**wfb._default_state(), **(state or {})})
        del stale[:], lags[:], runs[:]
        t, seen_states = start, []
        while t < end:
            for s in offsets:
                _Clock.at = t + timedelta(seconds=s)
                wfb._tick(name)
            seen_states.append(wfb._load_state(name))
            t += M1
        return seen_states

    def tpe(xs):
        return [(x + TPE).strftime("%m-%d %H:%M") for x in xs]

    def one(td_, delay, start, end, stop=None, tw=False, member="", extra=None):
        feed.clear()
        feed[member] = (bars(start, end, td_, tw), td_, delay, stop)
        feed.update(extra or {})

    late = timedelta(seconds=40)

    # ── L ──────────────────────────────────────────────────────────────────────
    s0, s1 = T(10, 27, 10, 0), T(10, 27, 13, 0)   # Tuesday 10:00–13:00 Taipei
    one(M1, late, s0 - timedelta(hours=1), s1 + timedelta(hours=2))
    caught_up = {"last_processed_bar": (s0 - 2 * M1).isoformat(), "last_seen_bar": (s0 - 2 * M1).isoformat()}
    drive("btc1", s0, s1, caught_up)
    check(len(lags) == 1 and not stale and s0 + 14 * M1 <= lags[0][0] <= s0 + 17 * M1,
          f"crypto 1m one bar short all along: one lag alert ~15 min in, no bar_stale → "
          f"lag={tpe(a for a, _, _ in lags)} stale={tpe(a for a, _, _ in stale)}")
    check(not runs, f"…and it really computed nothing (runs={len(runs)})")
    drive("btc1", s1, s1 + timedelta(hours=1), keep=True)
    check(not lags and not stale, f"…another hour inside 24h: nothing more ({len(lags)}, {len(stale)})")
    clock_skew["s"] = 25 * 3600
    drive("btc1", s1 + timedelta(hours=1), s1 + timedelta(hours=1, minutes=5), keep=True)
    clock_skew["s"] = 0.0
    check(len(lags) == 1, f"…repeated after 24h ({len(lags)})")

    one(M1, late, T(10, 27, 9, 0), T(10, 27, 13, 31), tw=True)
    drive("tw1", T(10, 27, 10, 0), T(10, 27, 11, 0),
          {"last_processed_bar": T(10, 27, 9, 58).isoformat(), "last_seen_bar": T(10, 27, 9, 58).isoformat()})
    check(len(lags) == 1 and not stale, f"TWSE 1m one bar short mid-session: one lag alert, no bar_stale → "
                                        f"lag={tpe(a for a, _, _ in lags)} stale={len(stale)}")

    one(M1, timedelta(seconds=0), s0 - timedelta(hours=1), s1, member="AAA",
        extra={"BBB": (bars(s0 - timedelta(hours=1), s1), M1, timedelta(minutes=1, seconds=40), None)})
    drive("c1", s0, s0 + timedelta(minutes=40), caught_up)
    check(len(lags) == 1 and lags[0][2] == "BBB" and not stale,
          f"Type C, BBB two bars behind and moving (inside the priming grace): one lag alert naming it → "
          f"{[(tpe([a])[0], m, w) for a, m, w in lags]} stale={len(stale)}")

    # ── Q ──────────────────────────────────────────────────────────────────────
    prompt = timedelta(seconds=2)
    one(M1, prompt, T(10, 22, 9, 0), T(10, 28, 13, 31), tw=True)
    drive("tw1", T(10, 23, 13, 0), T(10, 26, 9, 30))
    first = [r for r in runs if r > T(10, 26, 8)][:1]
    check(not lags and not stale and tpe(first) == ["10-26 09:01"],
          f"TWSE 1m prompt over Friday's close and the weekend: no alert, Monday 09:00 runs at 09:01 → "
          f"lag={len(lags)} stale={len(stale)} {tpe(first)}")

    HOLIDAYS.add(date(2026, 10, 28))
    one(M1, prompt, T(10, 26, 9, 0), T(10, 29, 13, 31), tw=True)
    drive("tw1", T(10, 27, 13, 0), T(10, 29, 9, 30))
    first = [r for r in runs if r > T(10, 29, 8)][:1]
    check(not lags and not stale and tpe(first) == ["10-29 09:01"],
          f"TWSE 1m over the 10-28 holiday: no alert, 10-29 09:00 runs at 09:01 → "
          f"lag={len(lags)} stale={len(stale)} {tpe(first)}")
    HOLIDAYS.clear()

    one(M1, late, T(10, 22, 9, 0), T(10, 26, 13, 31), tw=True)
    drive("tw1", T(10, 26, 9, 0), T(10, 26, 9, 10),
          {"last_processed_bar": T(10, 23, 13, 30).isoformat(), "last_seen_bar": T(10, 23, 13, 30).isoformat()})
    check(not lags and not stale, f"TWSE 1m Monday open one bar short, last run Friday 13:30: no alert by 09:10 → "
                                  f"lag={tpe(a for a, _, _ in lags)} stale={len(stale)}")

    one(M1, prompt, T(10, 27, 9, 0), T(10, 27, 13, 31), stop=T(10, 27, 12, 0), tw=True)
    drive("tw1", T(10, 27, 11, 50), T(10, 27, 12, 40),
          {"last_processed_bar": T(10, 27, 11, 48).isoformat(), "last_seen_bar": T(10, 27, 11, 48).isoformat()})
    check(len(stale) == 1 and tpe([stale[0][0]])[0] in ("10-27 12:15", "10-27 12:16") and not lags,
          f"TWSE 1m, no lunch break: feed stops at 12:00 → bar_stale once by 12:16, no lag alert → "
          f"stale={tpe(a for a, _, _ in stale)} lag={len(lags)}")

    # ── N ──────────────────────────────────────────────────────────────────────
    one(M1, prompt, s0 - timedelta(hours=1), s0 + timedelta(hours=3))
    drive("btc1", s0, s0 + timedelta(hours=3), caught_up)
    check(not lags and not stale and len(runs) == 180, f"crypto 1m prompt 3 hours: no alert, 180 runs ({len(runs)})")

    one(M1, timedelta(seconds=30), s0 - timedelta(hours=1), s0 + timedelta(hours=3))
    drive("btc1", s0 + timedelta(minutes=30), s0 + timedelta(minutes=50), caught_up)
    check(not lags and not stale and len(runs) == 20,
          f"crypto 1m back from a 30-minute outage, each bar short at :05 and in by :35: no alert, "
          f"every bar runs (lag={len(lags)} stale={len(stale)}, runs={len(runs)})")

    one(M1, prompt, s0 - timedelta(hours=1), s1, stop=s0)
    drive("btc1", s0, s0 + timedelta(minutes=40), caught_up)
    check(len(stale) == 1 and not lags, f"crypto 1m real stall: bar_stale once, no lag alert "
                                        f"(stale={len(stale)} lag={len(lags)})")

    td30 = timedelta(minutes=30)
    for label, delay, stop in (("stuck", prompt, s0), ("late 40 min", timedelta(minutes=40), None)):
        one(td30, delay, s0 - timedelta(hours=6), s0 + timedelta(hours=6), stop=stop)
        sts = drive("btc30", s0, s0 + timedelta(hours=3),
                    {"last_processed_bar": (s0 - td30).isoformat(), "last_seen_bar": (s0 - td30).isoformat()})
        check(not lags and all(not s.get("lag_since") for s in sts),
              f"30m {label}: no lag alert, lag_since never written (bar_stale={len(stale)})")
finally:
    os.chdir(cwd)
    shutil.rmtree(BASE, ignore_errors=True)

print("\ncheck_bar_wait_lag: " + ("PASS" if not fails else f"FAILED ({fails})"))
sys.exit(1 if fails else 0)
