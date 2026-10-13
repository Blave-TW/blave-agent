"""A signal is always computed on the newest data there is (Wei 2026-10-13).

manager/wait_for_bar.py primes: while the expected bar is not in, a strategy whose newest closed
bar in the data is newer than the one it last computed on runs at once on that data — new pick
or long-running alike. Asserted here:

  1. real tick, Type A and Type C, data three bars behind, nothing computed yet → the strategy
     runs once; last_processed_bar stays unset, pending_since is set (the expected bar is
     still waited for and alerted on as before).
  2. the next tick, same newest bar: not run again.
  3. a held lock (another tick in flight) → no run; released → run.
  4. the expected bar lands → the normal run, last_processed_bar set.
  5. no process of a prime imports any venue module (enumerated from disk) or opens a
     socket — with no venue bound and with one bound and funded alike.
  6. the state.json it writes is what the reconciler's aggregate already reads.
  7. rules, in-process: a long-running strategy (state.json, old last_processed_bar) is
     computed on newer data; the same data is never computed twice; a Type C bar a prime
     already computed is not run again when the lagging member lands (one target per bar);
     grace / no data / unpublished feed / TAIFEX off-session → no run; a failed prime backs
     off and is not retried on the same bar; the stall throttle lets each new bar through
     once (bars of 15 min and up), and on a fixed clock; the stale alert says the signal
     was computed.

Run: cd blave-agent && .venv/bin/python tests/check_prime_signal.py
"""
import glob
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import date, datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = tempfile.mkdtemp(prefix="prime-signal-")
WS = os.path.join(BASE, "workspace")
shutil.copytree(os.path.join(ROOT, "lib"), os.path.join(WS, "lib"),
                ignore=shutil.ignore_patterns("__pycache__"))
os.makedirs(os.path.join(WS, "manager"))
for f in ("wait_for_bar.py", "alert_failure.py"):
    shutil.copy(os.path.join(ROOT, "manager", f), os.path.join(WS, "manager"))

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


MONEY = sorted("lib." + os.path.basename(p)[:-3]
               for pat in ("order_*.py", "account_*.py", "*_worker.py", "*_vault.py",
                           "president_quote.py")
               for p in glob.glob(os.path.join(ROOT, "lib", pat))) + ["lib.venue_wiring"]

HEAD = ("import os, sys\nfrom pathlib import Path\n"
        "sys.path.insert(0, str(Path(__file__).parent.parent.parent))\n"
        "import numpy as np, pandas as pd\n"
        "def _ran():  # compute only: the probe path imports this file to call fetch_data\n"
        "    open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'runs'), 'a').write('x')\n"
        "LAG = int(os.environ.get('PRIME_LAG', '3'))\n"
        "def _idx():\n"
        "    end = pd.Timestamp.now('UTC').tz_localize(None).floor('h') - pd.Timedelta(hours=LAG)\n"
        "    return pd.date_range(end=end, periods=300, freq='h')\n")
STRATEGY_A = HEAD + '''
STRATEGY_NAME = "pa"
SYMBOL = "BTCUSDT"
INTERVAL = "1h"
START = "2024-01-01"
FEE = 0.0005
MCPT = False
def fetch_data(headers=None):
    c = pd.Series(100.0, index=_idx())
    return pd.DataFrame({"Open": c, "High": c, "Low": c, "Close": c, "Volume": 1.0})
def compute_signals(df):
    _ran()
    return pd.Series(1.0, index=df.index)
if __name__ == "__main__":
    from lib.runner import run
    run(locals(), fetch_data, compute_signals, send_telegram_fn=None)
'''
STRATEGY_C = HEAD + '''
STRATEGY_NAME = "pc"
INTERVAL = "1h"
START = "2024-01-01"
FEE = 0.001
def fetch_data(headers=None):
    i = _idx()
    return pd.DataFrame({"AAAUSDT": 100.0, "BBBUSDT": 50.0}, index=i), None
def compute_signals(data):
    _ran()
    c = data[0]
    w = np.zeros(c.shape)
    w[:, 0] = 0.5
    return w, pd.concat({"close": c, "open": c}, axis=1)
if __name__ == "__main__":
    from lib.runner import run
    run(locals(), fetch_data, compute_signals, send_telegram_fn=None)
'''
for name, src in (("pa", STRATEGY_A), ("pc", STRATEGY_C)):
    os.makedirs(os.path.join(WS, "strategies", name))
    open(os.path.join(WS, "strategies", name, "strategy.py"), "w").write(src)

shim = os.path.join(BASE, "shim")
os.makedirs(shim)
TRACE = os.path.join(BASE, "trace.jsonl")
open(os.path.join(shim, "sitecustomize.py"), "w").write(
    "import atexit, json, os, socket, sys\n"
    "_net = []\n"
    "def _refuse(self, *a, **k):\n"
    "    _net.append(repr(a[:1]))\n"
    "    raise OSError('no network in this test')\n"
    "socket.socket.connect = socket.socket.connect_ex = _refuse\n"
    "def _dump():\n"
    "    with open(os.environ['PS_TRACE'], 'a') as f:\n"
    "        f.write(json.dumps({'argv': sys.argv, 'net': _net,\n"
    "                            'mods': sorted(m for m in sys.modules if m.startswith('lib.'))}) + '\\n')\n"
    "atexit.register(_dump)\n")


def tick(name, lag=3):
    env = {k: v for k, v in os.environ.items() if not k.startswith("BLAVE_")}
    env.update(BLAVE_MODE="live", PRIME_LAG=str(lag), PYTHONPATH=shim, PS_TRACE=TRACE,
               MPLBACKEND="Agg")
    return subprocess.run([sys.executable, os.path.join("manager", "wait_for_bar.py"), name],
                          cwd=WS, env=env, capture_output=True, text=True, timeout=300)


def state(name):
    try:
        return json.load(open(os.path.join(WS, "strategies", name, "state.json")))
    except (OSError, ValueError):
        return None


def bar_wait(name):
    try:
        return json.load(open(os.path.join(WS, "state", "bar_wait", name + ".json")))
    except (OSError, ValueError):
        return {}


def runs(name):
    try:
        return len(open(os.path.join(WS, "strategies", name, "runs")).read())
    except OSError:
        return 0


def traced():
    rows = [json.loads(l) for l in open(TRACE)] if os.path.exists(TRACE) else []
    open(TRACE, "w").close()
    return rows


def bind(bound):
    with open(os.path.join(WS, ".env"), "w") as f:
        f.write("blave_api_key=not-a-real-key\nblave_secret_key=not-a-real-key\n")
        if bound:
            f.write("BINANCE_API_KEY=not-a-real-key\nBINANCE_SECRET_KEY=not-a-real-secret\n")
    amounts = {"pa": 1000, "pc": 2000} if bound else {"pa": 0, "pc": 0}
    ex = {"pa": "binance" if bound else "", "pc": "binance" if bound else ""}
    json.dump({"amounts": amounts, "exchanges": ex},
              open(os.path.join(WS, "manager", "portfolio_config.json"), "w"))


try:
    # ── 1. no state.json, data three bars behind: primed by the real tick ──────
    bind(False)
    for n in ("pa", "pc"):
        r = tick(n)
        check(r.returncode == 0 and "uncaught" not in r.stdout, f"{n}: tick exits cleanly → {r.stdout[-300:]}{r.stderr[-300:]}")
    sa, sc = state("pa"), state("pc")
    check(isinstance(sa, dict) and sa.get("position") == 1.0 and sa.get("symbol") == "BTCUSDT",
          f"Type A primed: state.json carries the signal → {sa}")
    check(isinstance(sc, dict) and (sc.get("weights") or {}).get("AAAUSDT") == 0.5,
          f"Type C primed: state.json carries the weights → {sc}")
    bw = bar_wait("pa")
    check(bw.get("last_processed_bar") is None and bw.get("pending_since")
          and bw.get("computed_fp"),
          f"…the expected bar is still pending, the prime is recorded → {bw}")
    check(runs("pa") == 1 and runs("pc") == 1, f"…each strategy ran exactly once → {runs('pa')} {runs('pc')}")
    rows = traced()
    loaded = sorted({m for r in rows for m in r["mods"] if m in MONEY})
    check(len(MONEY) >= 15 and len(rows) >= 4 and not loaded and not any(r["net"] for r in rows),
          f"no venue bound: none of the {len(MONEY)} venue modules loaded, no socket ({len(rows)} processes) → {loaded}")

    # ── 2. same newest bar again ──────────────────────────────────────────────
    tick("pa")
    check(runs("pa") == 1, "second tick, same newest bar: not run again")
    traced()

    # ── 3. a held lock blocks the prime; released, it runs ─────────────────────
    shutil.rmtree(os.path.join(WS, "state", "bar_wait"))
    os.remove(os.path.join(WS, "strategies", "pa", "state.json"))
    holder = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    os.makedirs(os.path.join(WS, "state", "bar_wait"))
    lock = os.path.join(WS, "state", "bar_wait", "pa.lock")
    open(lock, "w").write(str(holder.pid))
    try:
        tick("pa")
        check(runs("pa") == 1 and state("pa") is None, "lock held by a live tick: no prime, no state.json")
    finally:
        holder.kill()
        holder.wait()
    os.remove(lock)
    tick("pa")
    check(runs("pa") == 2 and state("pa") is not None, "lock released: primed")

    # ── 4. the expected bar lands: the normal run ───────────────────────────────
    tick("pa", lag=1)
    bw = bar_wait("pa")
    check(runs("pa") == 3 and bw.get("last_processed_bar") and bw.get("pending_since") is None,
          f"expected bar in: normal run, last_processed_bar set → {bw}")
    traced()

    # ── 5. bound and funded: the prime still loads no venue module ─────────────
    bind(True)
    for n in ("pa", "pc"):
        os.remove(os.path.join(WS, "strategies", n, "state.json"))
    shutil.rmtree(os.path.join(WS, "state", "bar_wait"))
    for n in ("pa", "pc"):
        tick(n)
    rows = traced()
    loaded = sorted({m for r in rows for m in r["mods"] if m in MONEY})
    check(state("pa") and state("pc") and len(rows) >= 4 and not loaded and not any(r["net"] for r in rows),
          f"venue bound, funded: primed, no venue module, no socket → {loaded}")

    # ── 6. the reconciler's aggregate reads the primed file like any state.json ─
    cwd = os.getcwd()
    os.chdir(WS)
    sys.path.insert(0, WS)
    try:
        import lib.portfolio as lp
        agg = lp.aggregate_portfolio()
        check(abs(agg.get("BTCUSDT", {}).get("size", 0) - 1000) < 1e-9
              and abs(agg.get("AAAUSDT", {}).get("size", 0) - 1000) < 1e-9
              and agg["BTCUSDT"]["side"] == "long",
              f"funded + routed: target = amount × primed signal, like any tick → "
              f"{ {k: (v['side'], v['size']) for k, v in agg.items()} }")
        bind(False)
        check(lp.aggregate_portfolio() == {}, "unrouted (no venue): the primed state targets nothing")
    finally:
        os.chdir(cwd)
        sys.path.remove(WS)

    # ── 7. rules, in-process ───────────────────────────────────────────────────
    spec = importlib.util.spec_from_file_location("wfb_prime", os.path.join(WS, "manager", "wait_for_bar.py"))
    wfb = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(wfb)
    os.chdir(WS)
    try:
        calls, ok = [], {"v": True}
        wfb._run_strategy_protected = lambda n: calls.append(n) or ok["v"]
        wfb._tw_holiday = lambda day: day == date(2026, 10, 20)   # a made-up Tuesday holiday
        td = timedelta(hours=1)
        U = lambda d, h, m=0: datetime(2026, 10, d, h, m)   # naive UTC; Taipei = +8
        exp = U(13, 8)

        def mp(st, now, latest, e=exp, who=None, n="pa"):
            """_maybe_prime the way _tick calls it; latest = {member: naive UTC datetime}."""
            wfb._maybe_prime(n, st, now, e, td, latest, who)

        A7 = {"": U(13, 7)}
        st = wfb._default_state()
        mp(st, U(13, 9, 3), A7)
        check(not calls, "one bar behind, inside the grace: not run (the bar is about to land)")
        mp(st, U(13, 9, 6), A7)
        check(calls == ["pa"] and st["computed_bar"] == "2026-10-13T07:00:00", "…past the grace: run on the newest bar")
        mp(st, U(13, 9, 7), A7)
        mp(st, U(13, 10, 7), A7, exp + td)
        check(calls == ["pa"], "…same data, later ticks and a later expected bar: never computed twice")

        # a long-running strategy from before priming: state.json, last_processed_bar weeks old
        del calls[:]
        open(os.path.join(WS, "strategies", "pa", "state.json"), "w").write('{"position": 1.0}')
        mp({**wfb._default_state(), "last_processed_bar": "2026-09-20T08:00:00"}, U(13, 9, 6), A7)
        check(calls == ["pa"], "long-running strategy (state.json, old last_processed_bar): computed on the newest data")
        del calls[:]
        mp({**wfb._default_state(), "last_processed_bar": "2026-10-13T07:00:00"}, U(13, 9, 6), A7)
        check(not calls, "…its last run already covered this data: not run")

        # Type C fingerprint: any member moving forward recomputes
        del calls[:]
        st = wfb._default_state()
        stuck = {"AAA": U(10, 8), "BBB": U(13, 7)}
        mp(st, U(13, 9, 6), stuck)
        mp(st, U(13, 9, 7), stuck)
        check(calls == ["pa"], "Type C, one member stuck for days: computed once on every member's own newest bar")
        mp(st, U(13, 10, 7), {"AAA": U(10, 8), "BBB": U(13, 8)}, exp + td)
        check(calls == ["pa", "pa"], "…another member moves: computed again")

        del calls[:]
        st = wfb._default_state()
        mp(st, U(14, 0), None)
        check(not calls, "no data at all: not run")
        try:  # tick-winpid's _FeedWait takes (source, due_at)
            fw = wfb._FeedWait("feed", exp)
        except TypeError:
            fw = wfb._FeedWait(type("E", (), {"source": "feed", "due_at": exp})())
        mp(st, U(14, 0), A7, who=fw)
        check(not calls, "align_feed row unpublished: not run (the live run would refuse it)")

        st = wfb._default_state()
        ok["v"] = False
        mp(st, U(14, 0), A7)
        check(calls == ["pa"] and st.get("last_attempt_failed_at") and st.get("computed_fp") is None,
              "failed: backs off like a failed run")
        ok["v"] = True
        mp(st, U(14, 1), A7)
        check(calls == ["pa"], "…not retried on the same data")
        mp(st, U(14, 2), {"": U(13, 8)})
        check(calls == ["pa", "pa"], "…newer data is run")

        # TAIFEX contract strategies: nothing computed outside the session
        tx_dir = os.path.join(WS, "strategies", "tx")
        os.makedirs(tx_dir, exist_ok=True)
        open(os.path.join(tx_dir, "strategy.py"), "w").write(
            'SYMBOL = "TXF"\nINTERVAL = "1h"\nfrom lib.data import fetch_twfutures_ohlcv\n')
        os.makedirs(os.path.join(WS, "strategies", "sf"), exist_ok=True)
        open(os.path.join(WS, "strategies", "sf", "strategy.py"), "w").write('SYMBOL = "2330F"\nINTERVAL = "1h"\n')
        json.dump({"amounts": {"sf": 1}, "exchanges": {"sf": ""},
                   "asset_specs": {"sf": {"type": "futures_contracts", "contract_value": 2000}}},
                  open(os.path.join(WS, "manager", "portfolio_config.json"), "w"))
        cases = [("tx", U(17, 2), True, "TXF, Saturday 10:00 TWN"),
                 ("tx", U(16, 19), False, "TXF, Saturday 03:00 TWN (Friday's night session)"),
                 ("tx", U(11, 19), True, "TXF, Monday 03:00 TWN (no Sunday night session)"),
                 ("tx", U(13, 2), False, "TXF, Tuesday 10:00 TWN (day session)"),
                 ("tx", U(13, 6), True, "TXF, Tuesday 14:00 TWN (between sessions)"),
                 ("tx", U(13, 8), False, "TXF, Tuesday 16:00 TWN (night session)"),
                 ("tx", U(20, 2), True, "TXF, holiday Tuesday 10:00 TWN (on the TWSE table)"),
                 ("tx", U(20, 19), True, "TXF, Wednesday 03:00 TWN: the night part of the holiday's session"),
                 ("tx", U(21, 2), False, "TXF, the day after the holiday, 10:00 TWN"),
                 ("sf", U(13, 8), True, "stock futures (sized in lots), Tuesday 16:00 TWN: day session only"),
                 ("sf", U(13, 2), False, "stock futures, Tuesday 10:00 TWN"),
                 ("pa", U(17, 2), False, "crypto, Saturday: never closed")]
        for n, t, want, label in cases:
            check(wfb._tw_futures_closed(n, t) is want, f"{label}: closed={want}")
        del calls[:]
        st = wfb._default_state()
        txl = {"": U(16, 20)}
        mp(st, U(17, 2, 10), txl, U(17, 1), n="tx")
        check(not calls and st["prime_tried_fp"] is None, "TXF on Saturday: not run, not counted as tried")
        mp(st, U(19, 1, 10), txl, U(19, 0), n="tx")
        check(calls == ["tx"], "…the same data is run once inside the session (Monday 09:10 TWN)")

        # the real _tick on a fixed clock
        class _Clock(datetime):
            at = U(13, 10, 7)

            @classmethod
            def now(cls, tz=None):
                return cls.at.replace(tzinfo=tz) if tz else cls.at
        wfb.datetime = _Clock
        os.makedirs(os.path.join(WS, "state", "bar_wait"), exist_ok=True)
        seen = []
        verdict = {"v": (None, False, None, None)}
        wfb._check_freshness = lambda mod, e: seen.append(e) or verdict["v"]
        stale_msgs = []
        wfb._alert_stale = lambda *a, computed=False: stale_msgs.append(computed)

        def tick_at(at, latest=None, ready=False, **st_):
            _Clock.at = at
            if st_:
                wfb._save_state("pa", {**wfb._default_state(), **st_})
            if latest is not None:
                lag = min(latest, key=latest.get)
                verdict["v"] = (latest[lag], ready, lag if len(latest) > 1 else None, latest)
            del seen[:]
            wfb._tick("pa")
            return bool(seen)

        stalled = {"stall_alert_at": time.time(), "last_seen_bar": "2026-10-13T06:00:00",
                   "pending_since": "2026-10-13T07:05:00"}
        check(not tick_at(U(13, 10, 7), **stalled), "stalled: the 15-minute throttle holds off the mark")
        check(tick_at(U(13, 10, 15)), "…and checks on the mark")
        check(tick_at(U(13, 10, 20)), "…and right after the priming grace (:05 of the quarter)")

        # a member a minute late (inside the grace): one run, on complete data
        del calls[:]
        full9 = {"AAA": U(13, 9), "BBB": U(13, 9)}
        wfb._save_state("pa", wfb._default_state())
        tick_at(U(13, 10, 0, ), {"AAA": U(13, 9), "BBB": U(13, 8)})
        tick_at(U(13, 10, 1), full9, ready=True)
        st = wfb._load_state("pa")
        check(calls == ["pa"] and st["computed_fp"] == wfb._fingerprint(full9)[0],
              "Type C member a minute late: waited for, the bar runs once on complete data")

        # a member later than the grace: computed without it, then again when it lands
        del calls[:]
        tick_at(U(13, 11, 0), {"AAA": U(13, 10), "BBB": U(13, 9)})
        tick_at(U(13, 11, 6), {"AAA": U(13, 10), "BBB": U(13, 9)})
        st = wfb._load_state("pa")
        check(calls == ["pa"] and st["last_processed_bar"] == "2026-10-13T09:00:00",
              "…a member past the grace: computed on what is there, expected bar still pending")
        tick_at(U(13, 11, 9), {"AAA": U(13, 10), "BBB": U(13, 10)}, ready=True)
        st = wfb._load_state("pa")
        check(calls == ["pa", "pa"] and st["last_processed_bar"] == "2026-10-13T10:00:00",
              "…it lands: the bar runs again with its data")

        # a normal run updates the fingerprint: the same data is not primed again afterwards
        del calls[:]
        tick_at(U(13, 12, 7, ), {"AAA": U(13, 10), "BBB": U(13, 10)})
        check(not calls, "after a normal run, the same data past the grace: not run again (computed_fp updated)")

        # a member stuck for days, the others landing in two batches: the bar is computed once
        del calls[:]
        dead = U(1, 8)
        wfb._save_state("pa", {**wfb._default_state(), "last_processed_bar": "2026-10-01T08:00:00"})
        tick_at(U(13, 14, 1), {"DEAD": dead, "AAA": U(13, 13), "BBB": U(13, 12)})
        tick_at(U(13, 14, 3), {"DEAD": dead, "AAA": U(13, 13), "BBB": U(13, 12)})
        check(not calls, "stuck member + one still inside its grace: waited for (the stuck one decides nothing)")
        tick_at(U(13, 14, 4), {"DEAD": dead, "AAA": U(13, 13), "BBB": U(13, 13)})
        tick_at(U(13, 14, 6), {"DEAD": dead, "AAA": U(13, 13), "BBB": U(13, 13)})
        tick_at(U(13, 14, 9), {"DEAD": dead, "AAA": U(13, 13), "BBB": U(13, 13)})
        check(calls == ["pa"], "…the second batch completes the rest: computed once for the bar, not per batch")
        del calls[:]
        wfb._save_state("pa", {**wfb._default_state(), "last_processed_bar": "2026-10-01T08:00:00"})
        tick_at(U(13, 14, 1), {"DEAD": dead, "AAA": U(13, 13), "BBB": U(13, 13)})
        check(calls == ["pa"], "stuck member, every other one in: computed at once (no wait on the stuck one)")

        # stall alert text, a member stuck for days
        del calls[:]
        stale_msgs.clear()
        stuck_c = {"AAA": U(10, 8), "BBB": U(13, 12)}
        tick_at(U(13, 13, 15), stuck_c, stall_alert_at=time.time() - 25 * 3600,
                last_seen_bar="2026-10-10T08:00:00", pending_since="2026-10-10T09:05:00")
        check(calls == ["pa"] and stale_msgs == [True],
              "stuck member: computed on the others' newest, the stale alert says so")

        # normal runs never skip a bar (END-labelled data: label already the next slot)
        del calls[:]
        wfb._save_state("pa", wfb._default_state())
        tick_at(U(13, 11, 2), {"": U(13, 11)}, ready=True)
        tick_at(U(13, 12, 1), {"": U(13, 11)}, ready=True)
        tick_at(U(13, 13, 1), {"": U(13, 12)}, ready=True)
        check(calls == ["pa", "pa", "pa"], "normal runs: every expected bar runs, never every other one")
    finally:
        os.chdir(ROOT)
finally:
    os.chdir(ROOT)
    shutil.rmtree(BASE, ignore_errors=True)

print("\ncheck_prime_signal: " + ("PASS" if not fails else f"FAILED ({fails})"))
sys.exit(1 if fails else 0)
