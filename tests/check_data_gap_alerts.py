"""Data source gone quiet — the three 0.1.48 guards, one section each.

  G  manager/wait_for_bar._track_gap: a crypto 1h strategy whose bars stop, holding BTCUSDT on the
     last reconcile snapshot → one data_gap_exposed once 2 bars / 30 minutes have gone by, none
     before, none again in the same gap; a new gap after a computed bar alerts again. Flat on the
     snapshot (or only a paper position) → none. A CME 1h strategy (closed hours unknown) → none.
     fetch_data raising counts the same. A gap in polling (asleep, off) restarts the count.
     The runtime's tick gate holding a tick 0–300 s (BLAVE_TICK_SLOT) neither drops a stall-throttle
     poll nor counts as a gap in polling.
  L  _track_lag: a 1m feed always one bar short whose fetch takes 16 minutes still gets its lag
     alert (the gap in polling is timed from the poll's end).
  M  data_missing_at (wait_for_bar not-ready path, 15 minutes overdue) is what lib/portfolio's
     target_stale reads beside last_attempt_failed_at: Blave answering with nothing new holds the
     target, with no failed run. CME never writes it.
  F  lib/data._tw_feed_episode: one tw_feed_fallback per outage of the broker's own feed, only after
     _TW_FEED_NOTICE_AFTER_S; the opening no_overlap minute never pages; a pause before the notice
     forgets the start; the broker reading again ends the outage; no_file / not_enabled never count.

Run: cd blave-agent && .venv/bin/python tests/check_data_gap_alerts.py
"""
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import types
from datetime import datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import dotenv  # noqa: E402
dotenv.dotenv_values = lambda *a, **k: {}   # never read the workspace .env

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


BASE = tempfile.mkdtemp(prefix="data-gap-")
WS = os.path.join(BASE, "ws")
BTC = ('SYMBOL = "BTCUSDT"\nINTERVAL = "1h"\nfrom lib.data import fetch_kline\n'
       'def fetch_data(h):\n    return fetch_kline(SYMBOL, "1h", "2026-01-01", None, h)\n')
CME = ('SYMBOL = "GC"\nINTERVAL = "1h"\nfrom lib.data import fetch_db_kline\n'
       'def fetch_data(h):\n    return fetch_db_kline("x", SYMBOL, "1h", "2026-01-01", None, h)\n')
for n, src in (("btc", BTC), ("cme", CME), ("btc15", BTC.replace('"1h"', '"15m"')),
               ("btc1", BTC.replace('"1h"', '"1m"'))):
    os.makedirs(os.path.join(WS, "strategies", n))
    open(os.path.join(WS, "strategies", n, "strategy.py"), "w").write(src)
os.makedirs(os.path.join(WS, "manager"))
os.makedirs(os.path.join(WS, "state", "bar_wait"))
json.dump({}, open(os.path.join(WS, "manager", "portfolio_config.json"), "w"))
cwd = os.getcwd()
os.chdir(WS)

spec = importlib.util.spec_from_file_location("wfb_gap", os.path.join(ROOT, "manager", "wait_for_bar.py"))
wfb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wfb)
try:
    class _Clock(datetime):
        at = datetime(2026, 11, 6, 2, 0)

        @classmethod
        def now(cls, tz=None):
            return cls.at.replace(tzinfo=tz) if tz else cls.at

        @classmethod
        def utcnow(cls):
            return cls.at
    wfb.datetime = _Clock
    wfb.time = types.SimpleNamespace(time=lambda: (_Clock.at - datetime(1970, 1, 1)).total_seconds(),
                                     monotonic=lambda: 0.0, sleep=lambda s: None)
    mods, load = {}, wfb._load_strategy_module
    wfb._load_strategy_module = lambda n: mods.get(n) or mods.setdefault(n, load(n))
    H = timedelta(hours=1)
    feed = {"last": None, "raise": False, "members": None, "slow": None, "lag": None}

    def freshness(mod, expected):
        if feed["lag"]:   # always one bar short, and the fetch takes this long to say so
            _Clock.at += feed["lag"]
            last = expected - timedelta(minutes=1)
            return last, False, None, {"": last}
        if feed["raise"]:
            if feed["slow"]:
                _Clock.at += feed["slow"]
            raise ConnectionError("exchange down")
        if feed["members"]:   # Type C: {member: (stuck_at or None)} — None = on time, 2 minutes after each close
            now = _Clock.at
            latest = {k: v if v is not None else (now - timedelta(minutes=2)).replace(minute=0, second=0) - H
                      for k, v in feed["members"].items()}
            who = min(latest, key=latest.get)
            return latest[who], all(v >= expected for v in latest.values()), who, latest
        last = feed["last"]
        return last, last is not None and last >= expected, None, {"": last} if last else None
    wfb._check_freshness = freshness
    wfb._alert_stale = lambda *a, **k: None
    lags = []
    wfb._alert_lag = lambda name, minutes, straggler: lags.append((name, minutes))
    wfb._alert_failure = lambda: types.SimpleNamespace(alert=lambda *a, **k: None)
    gaps, runs = [], []
    wfb._alert_gap = lambda name, keys, minutes: gaps.append((name, keys, minutes))
    wfb._run_strategy_protected = lambda name: runs.append(name) or True

    def snapshot(size, exchange="binance", contribution=100.0, name="btc"):
        json.dump({"ts": _Clock.at.isoformat(),
                   "target": {"BTCUSDT": {"exchange": exchange, "side": "long", "size": 100,
                                          "contributors": [{"strategy": name, "contribution": contribution}]}},
                   "actual": {"BTCUSDT": {"side": "long", "size": size}}},
                  open("manager/last_reconcile.json", "w"))

    def drive(name, start, minutes, fresh=True):
        if fresh:
            wfb._save_state(name, {**wfb._default_state(), "last_processed_bar": (start - 2 * H).isoformat(),
                                   "last_seen_bar": (start - 2 * H).isoformat()})
        del gaps[:]
        for i in range(minutes):
            _Clock.at = start + timedelta(minutes=i, seconds=5)
            snapshot(**snap)
            wfb._tick(name)

    # ── G ─────────────────────────────────────────────────────────────────────
    t0 = datetime(2026, 11, 6, 2, 0)
    feed["last"] = t0 - 2 * H          # the 01:00 bar (due 02:00) never comes, nor any after it
    snap = {"size": 100}
    drive("btc", t0, 59)
    check(not gaps, f"G crypto 1h, bars stop: nothing inside the first hour ({gaps})")
    drive("btc", t0 + timedelta(minutes=59), 120, fresh=False)
    check(len(gaps) == 1 and gaps[0][0] == "btc" and gaps[0][1] == ["BTCUSDT"] and gaps[0][2] >= 60,
          f"G …one data_gap_exposed after 2 bars, none again in the same gap ({gaps})")
    st = wfb._load_state("btc")
    check(st["gap_alert_at"] is not None, "G …gap_alert_at kept")
    feed["last"] = t0 + 2 * H          # the data comes back and the strategy computes
    _Clock.at = t0 + 3 * H + timedelta(seconds=5)
    wfb._tick("btc")
    st = wfb._load_state("btc")
    check(st["gap_since"] is None and st["gap_alert_at"] is None and st["data_missing_at"] is None,
          f"G …a computed bar closes the gap ({st['gap_since']}, {st['gap_alert_at']}, {st['data_missing_at']})")
    drive("btc", t0 + 4 * H, 130, fresh=False)
    check(len(gaps) == 1, f"G …a new gap after recovery alerts again ({len(gaps)})")

    for label, s in (("flat", {"size": 0}), ("paper", {"size": 100, "exchange": "paper"}),
                     ("no share", {"size": 100, "contribution": 0.0})):
        snap = s
        drive("btc", t0, 180)
        check(not gaps, f"G {label} on the snapshot: no data_gap_exposed ({gaps})")
    snap = {"size": 100}
    drive("cme", t0, 180)
    st = wfb._load_state("cme")
    check(not gaps and st["data_missing_at"] is None and st["gap_since"] is None,
          f"G/M CME 1h (closed hours unknown): no alert, no data_missing_at ({gaps}, {st['data_missing_at']})")
    feed["raise"] = True
    drive("btc", t0, 180)
    feed["raise"] = False
    check(len(gaps) == 1, f"G fetch_data raising for 3 hours: one data_gap_exposed ({gaps})")
    # asleep: one not-ready poll at 02:00, the lid closes, it wakes at 05:00 and the first fetch fails
    feed["last"] = t0 - 2 * H
    drive("btc", t0, 1)
    feed["raise"] = True
    _Clock.at = t0 + 3 * H + timedelta(seconds=5)
    wfb._tick("btc")
    feed["raise"] = False
    st = wfb._load_state("btc")
    check(not gaps and st["gap_since"] == _Clock.at.isoformat(),
          f"G asleep 3 hours, first fetch after waking fails: no data_gap_exposed, the count restarts ({gaps})")
    # bar_stale already sent (stall throttle on), then fetch_data starts raising: polls every 15
    # minutes with a few seconds' drift (the :05 slot falls inside the retry backoff)
    feed["raise"] = True
    wfb._save_state("btc", {**wfb._default_state(), "last_processed_bar": (t0 - 2 * H).isoformat(),
                            "last_seen_bar": (t0 - 2 * H).isoformat(), "stall_alert_at": wfb.time.time()})
    del gaps[:]
    polled = []
    for i in range(240):
        _Clock.at = t0 + timedelta(minutes=i, seconds=3 if i % 15 == 5 else 8 + (i // 15) % 5)
        before = wfb._load_state("btc").get("gap_seen_at")
        wfb._tick("btc")
        if wfb._load_state("btc").get("gap_seen_at") != before:
            polled.append(i)
    feed["raise"] = False
    check(len(gaps) == 1 and polled[:3] == [0, 15, 30], f"G stalled, then fetch raising, polled every 15 min with drift: "
                                                        f"one data_gap_exposed ({gaps}, polled at {polled[:4]}…)")
    # …and the fetch takes F minutes to raise (a feed that hangs rather than refuses). The backoff
    # runs from the fetch's end, so the next poll lands 30–35 minutes after the last one started.
    # Start-of-tick seconds jitter at random: a period that divides 30 minutes hides this.
    import random
    feed["raise"] = True
    missed = []
    for slow in (5, 20, 26):
        for seed in range(8):
            rng = random.Random(seed)
            wfb._save_state("btc", {**wfb._default_state(), "last_processed_bar": (t0 - 2 * H).isoformat(),
                                    "last_seen_bar": (t0 - 2 * H).isoformat(),
                                    "stall_alert_at": (t0 - datetime(1970, 1, 1)).total_seconds()})
            del gaps[:]
            feed["slow"], busy_until = timedelta(minutes=slow), t0
            for i in range(600):
                _Clock.at = t0 + timedelta(minutes=i, seconds=rng.uniform(2, 6))
                if _Clock.at < busy_until:
                    continue   # the slow tick still holds the lock
                wfb._tick("btc")
                busy_until = _Clock.at
            if len(gaps) != 1:
                missed.append((slow, seed, len(gaps)))
    feed["raise"], feed["slow"] = False, None
    check(not missed, f"G stalled, fetch takes 5 / 20 / 26 min to raise, 8 jitter seeds, 10 hours: "
                      f"one data_gap_exposed each (missed: {missed})")
    # The tick gate (runtime/tick_gate.py) holds a 1h strategy behind shorter ones up to 300 s, and
    # does not queue a name again while it waits or runs. The runtime passes, as BLAVE_TICK_SLOT,
    # the earliest cycle the name was due in since its last launch (command_listener._tick_due):
    # a cycle that comes while it waits is this launch's, one that comes while it runs is the
    # next launch's. Both stall shapes: fetch_data raising (with backoff) and bars simply stopping.
    EPOCH = datetime(1970, 1, 1)

    def stalled(**kw):
        return {**wfb._default_state(), "last_processed_bar": (t0 - 2 * H).isoformat(),
                "last_seen_bar": (t0 - 2 * H).isoformat(), "stall_alert_at": (t0 - EPOCH).total_seconds(), **kw}

    def launch(due, at):
        """One gated tick: due = the slot the runtime passes, at = when it launches."""
        _Clock.at = at
        snapshot(**snap)
        os.environ[wfb.TICK_SLOT_ENV] = f"{(due - EPOCH).total_seconds():.3f}"
        wfb._tick("btc")

    def gated(seed, raising, slow, hours=10):
        rng = random.Random(seed)
        wfb._save_state("btc", stalled())
        del gaps[:]
        feed["raise"], feed["slow"], feed["last"] = raising, timedelta(minutes=slow), t0 - 2 * H
        launched_at = busy_until = t0
        due = None
        for i in range(hours * 60):
            cycle = t0 + timedelta(minutes=i, seconds=rng.uniform(2, 6))
            if cycle < busy_until:
                if cycle >= launched_at and due is None:
                    due = cycle   # skipped while running: the next launch stands for it
                continue
            launched_at = cycle + timedelta(seconds=rng.uniform(0, 300))
            launch(due or cycle, launched_at)
            due, busy_until = None, _Clock.at
        feed["raise"], feed["slow"] = False, None
        return len(gaps)
    try:
        missed = [(r, slow, seed, n) for r, slows in ((True, (0, 20)), (False, (0,))) for slow in slows
                  for seed in range(8) for n in [gated(seed, r, slow)] if n != 1]
        check(not missed, f"G stalled, every launch held 0–300 s by the tick gate, 8 seeds, 10 hours, fetch raising "
                          f"(0 / 20 min) or bars stopped: one data_gap_exposed each (missed: {missed})")
        feed["last"] = t0 - 2 * H
        seen0 = (t0 + timedelta(minutes=5, seconds=10)).isoformat()
        since0 = (t0 - timedelta(minutes=40)).isoformat()
        for late in (56, 70):
            wfb._save_state("btc", stalled(gap_since=since0, gap_seen_at=seen0))
            launch(t0 + timedelta(minutes=15, seconds=5), t0 + timedelta(minutes=15, seconds=5 + late))
            st = wfb._load_state("btc")
            check(st["gap_seen_at"] != seen0 and st["gap_since"] == since0 and wfb.TICK_SLOT_ENV not in os.environ,
                  f"G due :15:05, launched {late} s late: polled, gap_since kept, the slot not passed on to the run "
                  f"({st['gap_seen_at']}, {st['gap_since']})")
        wfb._save_state("btc", stalled(gap_since=since0, gap_seen_at=seen0))
        launch(t0 + timedelta(minutes=14, seconds=5), t0 + timedelta(minutes=18, seconds=55))
        st = wfb._load_state("btc")
        check(st["gap_seen_at"] != seen0 and st["throttle_cell"] == (t0 + timedelta(minutes=15)).isoformat(),
              f"G due :14:05, held to :18:55 (so :15 was never queued): it is the :15 poll ({st['throttle_cell']})")
        seen1 = st["gap_seen_at"]
        launch(t0 + timedelta(minutes=19, seconds=5), t0 + timedelta(minutes=19, seconds=6))
        launch(t0 + timedelta(minutes=15, seconds=5), t0 + timedelta(minutes=19, seconds=30))
        check(wfb._load_state("btc")["gap_seen_at"] == seen1, "G …the :15 minute is not polled a second time")
        wfb._save_state("btc", stalled(gap_since=since0, gap_seen_at=seen0))
        launch(t0 + timedelta(minutes=14, seconds=5), t0 + timedelta(minutes=14, seconds=50))
        check(wfb._load_state("btc")["gap_seen_at"] == seen0, "G due :14:05, launched :14:50: throttled")
        launch(t0 + timedelta(minutes=15, seconds=5), t0 + timedelta(minutes=16, seconds=5))
        check(wfb._load_state("btc")["gap_seen_at"] != seen0,
              "G …still booting at :15:05, so the :16:05 launch carries :15:05: polled")
        seen2 = (t0 + timedelta(minutes=15, seconds=10)).isoformat()
        wfb._save_state("btc", stalled(gap_since=since0, gap_seen_at=seen2))
        launch(t0 + timedelta(minutes=30, seconds=5), t0 + timedelta(minutes=35, seconds=30))
        st = wfb._load_state("btc")
        check(st["gap_seen_at"] != seen2 and st["gap_since"] == since0,
              f"G last poll ended :15:10, due :30:05, held to :35:30 (20:20 later): not a gap in polling ({st['gap_since']})")
        for raw in ("junk", f"{(t0 - EPOCH).total_seconds():.3f}"):   # unreadable / far in the past → the real start
            wfb._save_state("btc", stalled())
            _Clock.at = t0 + 3 * H + timedelta(minutes=16, seconds=5)
            os.environ[wfb.TICK_SLOT_ENV] = raw
            wfb._tick("btc")
            check(wfb._load_state("btc")["gap_seen_at"] is None,
                  f"G slot {raw[:8]}… at 05:16:05: ignored, the real start's minute is throttled as before")
    finally:
        os.environ.pop(wfb.TICK_SLOT_ENV, None)
        feed["raise"], feed["slow"] = False, None
    # asleep with the gap already open: a 15m strategy, bar 2 minutes late at 02:00 and 02:01, the lid
    # closes for 29 minutes, the first fetch after waking fails → the count restarts, no page
    feed["last"] = t0 - timedelta(minutes=30)
    wfb._save_state("btc15", {**wfb._default_state(), "last_processed_bar": (t0 - timedelta(minutes=30)).isoformat(),
                              "last_seen_bar": (t0 - timedelta(minutes=30)).isoformat()})
    del gaps[:]
    _Clock.at = t0
    snapshot(100, name="btc15")
    for at in (t0 + timedelta(seconds=5), t0 + timedelta(minutes=1, seconds=5)):
        _Clock.at = at
        wfb._tick("btc15")
    feed["raise"] = True
    _Clock.at = t0 + timedelta(minutes=30, seconds=5)
    wfb._tick("btc15")
    feed["raise"] = False
    check(not gaps, f"G 15m, gap open 2 min, asleep 29 min, first fetch after waking fails: no data_gap_exposed ({gaps})")
    feed["last"] = t0 - 2 * H
    feed["members"] = {"AAA": t0 - 2 * H, "BBB": None}
    del runs[:]
    drive("btc", t0, 180)
    feed["members"] = None
    check(not gaps and len(runs) >= 2, f"G Type C, one member stuck, the other on time: primed around it every "
                                       f"bar, no data_gap_exposed ({gaps}, {len(runs)} runs)")
    feed["last"] = t0 - 2 * H
    drive("btc", t0, 90)
    feed["last"] = t0 + H
    wfb._run_strategy_protected = lambda name: False
    _Clock.at = t0 + 2 * H + timedelta(seconds=5)
    wfb._tick("btc")
    wfb._run_strategy_protected = lambda name: runs.append(name) or True
    st = wfb._load_state("btc")
    check(st["gap_since"] is None and st["gap_alert_at"] is None,
          f"G the bar lands but the run crashes: not a data gap any more (strategy_failed's) ({st['gap_since']})")

    # ── L ─────────────────────────────────────────────────────────────────────
    # a 1m feed always one bar short (the bar lands after every retry, priming inside its grace),
    # and the fetch takes 16 minutes to come back: one lag alert, not a count restarted every tick
    wfb._save_state("btc1", {**wfb._default_state(), "last_processed_bar": (t0 - 2 * H).isoformat(),
                             "last_seen_bar": (t0 - 2 * H).isoformat()})
    del lags[:]
    feed["lag"], busy_until = timedelta(minutes=16), t0
    for i in range(180):
        _Clock.at = t0 + timedelta(minutes=i, seconds=5)
        if _Clock.at < busy_until:
            continue
        wfb._tick("btc1")
        busy_until = _Clock.at
    feed["lag"] = None
    st = wfb._load_state("btc1")
    check(len(lags) == 1 and lags[0][1] >= 15 and st["stall_alert_at"] is None,
          f"L 1m always one bar short, fetch takes 16 min: one lag alert ({lags}, stall {st['stall_alert_at']})")

    # ── M ─────────────────────────────────────────────────────────────────────
    feed["last"] = t0 - 2 * H
    drive("btc", t0, 30)
    st = wfb._load_state("btc")
    check(st["data_missing_at"] is not None and st["last_attempt_failed_at"] is None,
          f"M bar 15+ min overdue, no run failed: data_missing_at written, last_attempt_failed_at not "
          f"({st['data_missing_at']}, {st['last_attempt_failed_at']})")
    from lib import portfolio
    now = wfb.time.time()
    open("strategies/btc/state.json", "w").write("{}")
    os.utime("strategies/btc/state.json", (now - 3 * 3600, now - 3 * 3600))
    portfolio._stale_held_names = lambda: set()
    age = portfolio._stale_target_age("btc", now=now)
    check(age is not None and age > 2 * 3600, f"M lib/portfolio reads it: target_stale (age {age})")
    st["data_missing_at"] = None
    wfb._save_state("btc", st)
    check(portfolio._stale_target_age("btc", now=now) is None, "M …without it: not stale (as before)")
finally:
    os.chdir(cwd)

# ── F ─────────────────────────────────────────────────────────────────────────
from lib import data, events  # noqa: E402
FEED_DIR = os.path.join(BASE, "feed_state")
os.makedirs(FEED_DIR)
from pathlib import Path  # noqa: E402
data._STATE_DIR = Path(FEED_DIR)
sent = []
events.emit = lambda ev_type, **p: sent.append((ev_type, p)) or 1


def feed_tick(t, source, reason):
    data._tw_feed_episode("president", source, reason, t)


T = 1_800_000_000.0
feed_tick(T, "blave", "no_overlap")
feed_tick(T + 60, "blave", "no_overlap")
feed_tick(T + 120, "president", None)
check(not sent, f"F opening no_overlap for two minutes, then the broker: no notice ({sent})")
for dt in (1000, 1100, 1400, 1500, 1600):
    feed_tick(T + dt, "blave", "stale")
check(len(sent) == 1 and sent[0] == ("tw_feed_fallback", {"venue": "president", "reason": "stale"}),
      f"F stale for 10 minutes: one tw_feed_fallback ({sent})")
feed_tick(T + 2000, "blave", "paused")
feed_tick(T + 30000, "blave", "no_overlap")
check(len(sent) == 1, f"F …still out across a pause: the same outage, no second notice ({len(sent)})")
feed_tick(T + 30100, "president", None)
feed_tick(T + 31000, "blave", "error:ValueError")
feed_tick(T + 31400, "blave", "error:ValueError")
check(len(sent) == 2, f"F back, then out again: a new notice ({len(sent)})")
feed_tick(T + 31500, "president", None)
feed_tick(T + 40000, "blave", "stale")
feed_tick(T + 40100, "blave", "paused")
feed_tick(T + 70000, "blave", "no_overlap")
check(len(sent) == 2, f"F stale 2 minutes before the close, no_overlap at the next open: no notice ({len(sent)})")
for dt in (80000, 80400):
    feed_tick(T + dt, "blave", "no_file")
    feed_tick(T + dt + 1, "blave", "not_enabled")
check(len(sent) == 2, f"F no_file / not_enabled never count ({len(sent)})")

# 群益 (Wei 11-07: same P2 as 統一): its own outage, marker and close-out, never mixed with 統一's
del sent[:]
C = T + 100_000


def cap_tick(t, source, reason):
    data._tw_feed_episode("capital", source, reason, t)


cap_tick(C, "blave", "stale")
feed_tick(C + 10, "president", None)   # 統一 reading fine meanwhile does not end 群益's outage
cap_tick(C + 400, "blave", "stale")
cap_tick(C + 460, "blave", "stale")
check(sent == [("tw_feed_fallback", {"venue": "capital", "reason": "stale"})]
      and os.path.exists(os.path.join(FEED_DIR, "tw_feed_notified_capital"))
      and not os.path.exists(os.path.join(FEED_DIR, "tw_feed_notified_president")),
      f"F 群益 out for over 300 s: one tw_feed_fallback with venue=capital, its own marker ({sent})")
cap_tick(C + 500, "capital", None)
with open(os.path.join(FEED_DIR, "tw_feed_down.json")) as fh:
    book = json.load(fh)
check("capital" not in book and not os.path.exists(os.path.join(FEED_DIR, "tw_feed_notified_capital")),
      f"F 群益 reading again ends the outage: start forgotten, marker removed ({book})")
cap_tick(C + 1000, "blave", "error:ValueError")
cap_tick(C + 1400, "blave", "error:ValueError")
check(len(sent) == 2 and sent[1][1]["venue"] == "capital", f"F 群益 back, then out again: a new notice ({sent})")
cap_tick(C + 1500, "capital", None)
cap_tick(C + 2000, "blave", "paused")
cap_tick(C + 3000, "blave", "no_file")
check(len(sent) == 2, f"F 群益 paused / no_file never count, as for 統一 ({len(sent)})")
# no platform channel (emit refused): the machine's own message names 群益
texts = []
real_emit = events.emit
events.emit = lambda ev_type, **p: 0
import lib.notify as _notify  # noqa: E402
real_send, _notify.send_text = _notify.send_text, lambda text, *a, **k: texts.append(text)
try:
    cap_tick(C + 5000, "blave", "stale")
    cap_tick(C + 5400, "blave", "stale")
finally:
    events.emit, _notify.send_text = real_emit, real_send
check(len(texts) == 1 and texts[0].startswith("⚠️ 群益的台指期即時行情斷了"), f"F 群益 fallback message names 群益 ({texts})")

# the broker's name for venue=capital on every layer that renders tw_feed_fallback
import re  # noqa: E402
from lib import venue_traits  # noqa: E402
names = {"lib venue_traits": venue_traits.get("capital", "label")}
with open(os.path.join(ROOT, "shell", "i18n", "zh.po"), encoding="utf-8") as fh:
    po = fh.read()
with open(os.path.join(ROOT, "shell", "renderer", "trade.js"), encoding="utf-8") as fh:
    tr = fh.read()
m = re.search(r'const TR_BROKER_KEY = \{ capital: "([\w.]+)"', tr)
pm = re.search(r'msgid "%s"\nmsgstr "([^"]*)"' % re.escape(m.group(1)), po) if m else None
names["desktop trade.js"] = pm.group(1) if pm else None
api = os.environ.get("BLAVE_API_DIR") or os.path.join(ROOT, "..", "api")
web = os.environ.get("BLAVE_WEB_DIR") or os.path.join(ROOT, "..", "web")
if os.path.isfile(os.path.join(api, "openclaw", "notify.py")):
    with open(os.path.join(api, "openclaw", "notify.py"), encoding="utf-8") as fh:
        am = re.search(r'"capital": \("([^"]*)", "([^"]*)"\)', fh.read())
    names["api notify"] = am.group(2).strip() if am else None
else:
    print("SKIP  api notify._VENUE_NAMES (set BLAVE_API_DIR)")
wpo = os.path.join(web, "app", "translations", "zh", "LC_MESSAGES", "messages.po")
if os.path.isfile(wpo):
    with open(os.path.join(web, "app", "main", "templates", "agent", "workspace.html"), encoding="utf-8") as fh:
        wh = fh.read()
    with open(wpo, encoding="utf-8") as fh:
        wm = re.search(r'msgid "workspace_ov_broker_capital"\nmsgstr "([^"]*)"', fh.read())
    names["web workspace"] = wm.group(1) if wm and 'data.venue === "capital" ? I18N.ovBrokerCapital' in wh else None
else:
    print("SKIP  web workspace broker name (set BLAVE_WEB_DIR)")
check(set(names.values()) == {"群益"}, f"F venue=capital reads 群益 on every layer ({names})")

shutil.rmtree(BASE, ignore_errors=True)
print("ALL OK" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
