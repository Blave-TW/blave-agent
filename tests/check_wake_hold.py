"""After the computer sleeps (desktop 0.1.58 甲, spec §3, acceptance 30–38).

For WAKE_HOLD_MAX_S after a wake, a funded Type A/C strategy that has not recomputed since has its
share held from growing — lib/portfolio's stale-share hold, so entries and adds wait while reduces
and closes go; the other members on the key trade. A recompute lets it go next round; the window's
end lets it go as computed. The names ride the hold apart from stale ones (anchor `wake`): no
target_stale for them, and the stale release rule never takes them over (33a); a strategy that was
stale before stays stale (33b). One machine_woke per long gap with real money at stake; nothing on
a cloud machine. lib/portfolio._recomputed_since_one = runtime portfolio_reporter._recomputed_since
on one fixture set (two update channels, two copies).

Run: cd blave-agent && .venv/bin/python tests/check_wake_hold.py
"""
import json
import os
import shutil
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = tempfile.mkdtemp(prefix="wake-hold-")
os.chdir(TMP)
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = TMP
os.environ["BLAVE_AGENT_WORKSPACE"] = TMP
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "runtime"))

from lib import events, portfolio  # noqa: E402

fails = 0
H = 3600


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


emitted = []
events._appender = lambda t, p: emitted.append((t, p))
stale_events = []
events.emit_target_stale = lambda *a: stale_events.append(a)


def bar_iso(t):
    return datetime.fromtimestamp(t, timezone.utc).replace(tzinfo=None).isoformat()


def closed_bar(down_to, td=H):
    return (down_to // td) * td - td


def setup(members, exchange="paper"):
    """members: {name: (state, recomputed: bool, state_age_s, failed_ago_s|None)}"""
    for d in ("manager", "strategies", "state"):
        shutil.rmtree(d, ignore_errors=True)
    os.makedirs("manager")
    os.makedirs("state/bar_wait")
    cfg = {"self_ledger": False, "amounts": {}, "exchanges": {}}
    for name, (state, fresh, age, failed_ago) in members.items():
        os.makedirs(f"strategies/{name}")
        open(f"strategies/{name}/strategy.py", "w").write('INTERVAL = "1h"\n')
        put(name, state, fresh, age, failed_ago)
        cfg["amounts"][name] = 100
        cfg["exchanges"][name] = exchange
    json.dump(cfg, open("manager/portfolio_config.json", "w"))
    portfolio.drift_band = lambda symbol: portfolio._DRIFT_BAND_FLOOR


WOKE = time.time() - 20


def put(name, state, fresh, age, failed_ago):
    path = f"strategies/{name}/state.json"
    json.dump(state, open(path, "w"))
    os.utime(path, (time.time() - age, time.time() - age))
    bar = closed_bar(WOKE) if fresh else closed_bar(WOKE) - 3 * H
    bw = f"state/bar_wait/{name}.json"
    json.dump({"last_processed_bar": bar_iso(bar), "last_seen_bar": bar_iso(bar),
               "last_attempt_failed_at": None if failed_ago is None else time.time() - failed_ago}, open(bw, "w"))
    t = WOKE - 600   # checked before the sleep
    os.utime(bw, (t, t))


class Venue:
    def __init__(self, held):
        self.held, self.calls = dict(held), []

    def positions(self):
        return {k: {"side": "long" if v > 0 else "short", "size": abs(v)} for k, v in self.held.items() if v}

    def place(self, symbol, signed_diff, asset_spec, reduce_only=False):
        self.calls.append((symbol, signed_diff, reduce_only))
        self.held[symbol] = self.held.get(symbol, 0) + signed_diff
        return {"executed_qty": abs(signed_diff), "avg_price": 1.0}


def run(held, v=None):
    v = v or Venue(held)
    portfolio.reconcile(v.positions, v.place)
    return v


def audits(event):
    try:
        return [json.loads(x) for x in open("state/audit.jsonl") if f'"{event}"' in x]
    except OSError:
        return []


LONG, FLAT = {"symbol": "BTCUSDT", "position": 1}, {"symbol": "BTCUSDT", "position": 0}
HALF = {"symbol": "BTCUSDT", "position": 0.5}

# ── 30: entries and adds wait, reduces and closes go, the other member trades ───────────────
portfolio.set_wake_hold(WOKE, WOKE + 180)
setup({"a": (LONG, False, 2 * H, None)})
v = run({"BTCUSDT": 40})
check(v.calls == [], f"30 A not recomputed since the wake: its add (40 → 100) waits ({v.calls})")
rows = audits("wake_hold")
check(len(rows) == 1 and rows[0].get("strategy") == "a" and rows[0].get("keys") == ["BTCUSDT"],
      f"33 the hold is one audit row wake_hold ({rows})")
setup({"a": (HALF, False, 2 * H, None)})
v = run({"BTCUSDT": 100})
check(v.calls == [("BTCUSDT", -50, True)], f"30 A's reduce goes at once ({v.calls})")
setup({"a": (FLAT, False, 2 * H, None)})
v = run({"BTCUSDT": 100})
check(v.calls == [("BTCUSDT", -100, True)], f"30 A's close goes at once ({v.calls})")
setup({"a": (LONG, False, 2 * H, None), "b": (LONG, True, 60, None)})
v = run({})
check(v.calls == [("BTCUSDT", 100, False)], f"30 same key: B (recomputed) buys its 100, A's waits ({v.calls})")
check(stale_events == [] and not audits("target_stale") and not [e for e in emitted if e[0] == "target_stale"],
      "33 no target_stale for a wake hold")

# ── 31: A recomputes → its add goes next round ────────────────────────────────────────────────
setup({"a": (LONG, False, 2 * H, None)})
v = run({"BTCUSDT": 40})
put("a", LONG, True, 10, None)
v = run(None, v)
check(v.calls == [("BTCUSDT", 60, False)], f"31 A recomputed: the add goes ({v.calls})")
check("BTCUSDT" not in json.load(open("state/stale_share.json")), "31 the hold row is gone")

# ── 32: the window ends → A trades its last target ────────────────────────────────────────────
setup({"a": (LONG, False, 2 * H, None)})
v = run({"BTCUSDT": 40})
portfolio.clear_wake_hold()
v = run(None, v)
check(v.calls == [("BTCUSDT", 60, False)], f"32 180 s are up: A's add goes on its old target ({v.calls})")
portfolio.set_wake_hold(WOKE, time.time() - 1)
setup({"a": (LONG, False, 2 * H, None)})
v = run({"BTCUSDT": 40})
check(v.calls == [("BTCUSDT", 60, False)], f"32 a window already past holds nothing ({v.calls})")

# ── 33a: failed once before the sleep, not stale yet: released at the end, never target_stale ──
portfolio.set_wake_hold(WOKE, WOKE + 180)
setup({"a": (LONG, False, 1.5 * H, 3000)})
check(portfolio._stale_target_age("a") is None, "33a (setup) A is not stale on its own")
v = run({"BTCUSDT": 40})
check(v.calls == [] and "a" not in portfolio._stale_held_names(),
      f"33a held by the wake, and not counted as a stale hold ({v.calls}, {portfolio._stale_held_names()})")
portfolio.clear_wake_hold()
v = run(None, v)
book = json.load(open("state/stale_share.json"))
check(v.calls == [("BTCUSDT", 60, False)] and "BTCUSDT" not in book and "a" not in portfolio._stale_held_names()
      and stale_events == [], f"33a window over: released, row cleared, no target_stale ({v.calls}, {book})")

# ── 33b: stale before the sleep: still held after the window, as before ───────────────────────
stale_events.clear()
portfolio.set_wake_hold(WOKE, WOKE + 180)
setup({"a": (LONG, False, 3 * H, 60)})
v = run({"BTCUSDT": 40})
portfolio.clear_wake_hold()
v = run(None, v)
check(v.calls == [] and "a" in portfolio._stale_held_names() and len(stale_events) == 1,
      f"33b stale before the sleep: held after the window too, its own target_stale ({v.calls}, {stale_events})")

# ── 35–37: the reconciler's side ──────────────────────────────────────────────────────────────
from manager import reconciler as rec  # noqa: E402

os.environ["BLAVE_AGENT_LOCAL"] = "1"
rec._venue_bound = lambda: True   # the bind manifest is not what these cases are about


def wake(gap_s, exchange, positions=None):
    setup({"a": (LONG, False, 2 * H, None)}, exchange=exchange)
    json.dump({"target": {}, "actual": positions or {}}, open("manager/last_reconcile.json", "w"))
    rec._loop_clock = None
    del emitted[:]
    rec._wake_check(wall=WOKE - gap_s, mono=50.0)
    gap = rec._wake_check(wall=WOKE, mono=55.0)
    if gap:
        rec._on_wake(*gap)
    portfolio.clear_wake_hold()
    return gap, [e for e in emitted if e[0] == "machine_woke"]


gap, sent = wake(300, "binance")
check(gap == (WOKE - 300, WOKE) and sent == [], f"35 5 min asleep: held, no notice ({sent})")
gap, sent = wake(2 * H, "binance")
check(sent == [("machine_woke", {"minutes": 120, "held": True})], f"35 2 h asleep, real-money strategy: one notice ({sent})")
check(json.load(open(rec.WAKE_PATH)) == {"from": int(WOKE - 2 * H), "to": int(WOKE)},
      "35 wake.json records the gap")
again = rec._wake_check(wall=WOKE + 5, mono=60.0)
check(again is None, "35 the next loop top: same gap, nothing again")
gap, sent = wake(2 * H, "paper")
check(sent == [], f"35 paper only: no notice ({sent})")
gap, sent = wake(2 * H, "paper", {"BTCUSDT": {"side": "long", "size": 5}})
real_ids = rec._env_venue_ids
rec._env_venue_ids = lambda: {"binance"}
gap, sent2 = wake(2 * H, "paper", {"ETHUSDT": {"side": "long", "size": 5}})
rec._env_venue_ids = real_ids
check(sent == [] and len(sent2) == 1, f"35 a position counts only on a real venue ({sent}, {sent2})")
gap, sent = wake(2 * H, "binance")
put("a", LONG, True, 10, None)
rec._loop_clock = None
del emitted[:]
rec._wake_check(wall=WOKE - 2 * H, mono=50.0)
rec._on_wake(*rec._wake_check(wall=WOKE, mono=55.0))
portfolio.clear_wake_hold()
check(emitted == [("machine_woke", {"minutes": 120, "held": False})], f"35 every strategy current: held false ({emitted})")
# S3: not trading when the computer wakes (paused, stopped after a reboot, nothing bound) → no
# "trading resumed" notice; the hold is still set
from lib import guard  # noqa: E402
for why, on, off in (
        ("paused (HALT)", lambda: guard.trip_halt("user request", "web"),
         lambda: (os.remove(guard.HALT_PATH), guard.release_memory_halt())),
        ("stopped after a reboot", lambda: open(guard.RESTART_STOP_PATH, "w").write("{}"),
         lambda: os.remove(guard.RESTART_STOP_PATH)),
        ("no venue bound", lambda: setattr(rec, "_venue_bound", lambda: False),
         lambda: setattr(rec, "_venue_bound", lambda: True))):
    setup({"a": (LONG, False, 2 * H, None)}, exchange="binance")
    on()
    try:
        rec._loop_clock = None
        del emitted[:]
        rec._wake_check(wall=WOKE - 2 * H, mono=50.0)
        rec._on_wake(*rec._wake_check(wall=WOKE, mono=55.0))
        held = portfolio._wake_hold is not None
        portfolio.clear_wake_hold()
    finally:
        off()
    check(emitted == [] and held, f"S3 woke while {why}: entries still held, no 'trading resumed' notice ({emitted})")

os.environ.pop("BLAVE_AGENT_LOCAL")
rec._loop_clock = None
rec._wake_check(wall=1000.0, mono=50.0)
check(rec._wake_check(wall=1000.0 + 2 * H, mono=55.0) is None, "36 cloud: a 2 h clock jump is no wake")
real_time = rec.time
import types  # noqa: E402
clock = iter([1000.0, 1000.0 + 2 * H])
rec.time = types.SimpleNamespace(time=lambda: next(clock), sleep=lambda s: None)
try:
    rec._poll_sleep()
finally:
    rec.time = real_time
check(rec._poll_gap is None, "36 cloud: a late poll sleep records no wake")
os.environ["BLAVE_AGENT_LOCAL"] = "1"
rec._loop_clock = None
rec._wake_check(wall=1000.0, mono=50.0)
check(rec._wake_check(wall=1000.0 + 2 * H, mono=50.0 + 40) == (1000.0, 1000.0 + 2 * H),
      "37 asleep inside a round (wall +2 h, monotonic +40 s): caught at the next loop top")
clock = iter([5000.0, 5000.0 + 3 * H])
rec.time = types.SimpleNamespace(time=lambda: next(clock), sleep=lambda s: None)
try:
    rec._poll_sleep()
finally:
    rec.time = real_time
rec._loop_clock = (4990.0, time.monotonic())
check(rec._wake_check(wall=4995.0, mono=rec._loop_clock[1] + 5) == (5000.0, 5000.0 + 3 * H),
      "37 a late poll sleep (Windows, where monotonic may run on in sleep) is the gap")
check(rec._wake_expired(now=0) is False, "no window open: nothing expires")
rec._wake_until = 10.0
check(rec._wake_expired(now=11.0) is True and rec._wake_until is None and portfolio._wake_hold is None,
      "32 the window ends once: the reconciler sets force_next")

# ── 38: one rule in two copies ────────────────────────────────────────────────────────────────
import portfolio_reporter as pr  # noqa: E402
open("manager/wait_for_bar.py", "w").write("# present\n")
D = 1_794_000_000 + 1800
NEED = closed_bar(D)


def fixture(name, interval, processed, seen, mtime, failed=None, src=""):
    os.makedirs(f"strategies/{name}", exist_ok=True)
    open(f"strategies/{name}/strategy.py", "w").write((f'INTERVAL = "{interval}"\n' if interval else "") + src)
    bw = f"state/bar_wait/{name}.json"
    if processed is None and seen is None:
        if os.path.exists(bw):
            os.remove(bw)
        return
    json.dump({"last_processed_bar": processed and bar_iso(processed), "last_seen_bar": seen and bar_iso(seen),
               "last_attempt_failed_at": failed}, open(bw, "w"))
    os.utime(bw, (mtime, mtime))


TW = "from lib.data import fetch_twstock_price\n\ndef compute_signals():\n    return fetch_twstock_price('2330')\n"
monday = datetime(2026, 11, 16, 2, 0, tzinfo=timezone.utc).timestamp()   # 10:00 Taipei, a Monday
friday_bar = datetime(2026, 11, 13, tzinfo=timezone.utc).timestamp()
cases = [
    ("current", "1h", NEED, NEED, D - 100, None, "", D),
    ("checked_after_nothing_new", "1h", NEED - H, NEED - H, D + 100, None, "", D),
    ("checked_after_failed", "1h", NEED - H, NEED - H, D + 100, D + 50, "", D),
    ("old", "1h", NEED - 2 * H, NEED - 2 * H, D - 100, None, "", D),
    ("no_file", "1h", None, None, 0, None, "", D),
    ("tw_daily_weekend", "1d", friday_bar, friday_bar, monday - 100, None, TW, monday),
    ("type_b", None, None, None, 0, None, "", D),
]
os.makedirs("state/bar_wait", exist_ok=True)
for name, interval, processed, seen, mtime, failed, src, down in cases:
    shutil.rmtree(f"strategies/{name}", ignore_errors=True)
    fixture(name, interval, processed, seen, mtime, failed, src)
    cfg = {"amounts": {name: 100}, "exchanges": {name: "binance"}}
    lib_says = portfolio._recomputed_since_one(name, down, cfg)
    rt_says = pr._recomputed_since(down, cfg, {"binance": {"pair": True}})
    check(lib_says == rt_says, f"38 {name}: lib {lib_says} = runtime {rt_says}")
check([portfolio._recomputed_since_one(c[0], c[7], {}) for c in cases]
      == [True, True, False, False, False, True, True], "38 the fixtures cover both answers")

shutil.rmtree(TMP, ignore_errors=True)
print("PASS" if not fails else f"FAILED ({fails})")
sys.exit(1 if fails else 0)
