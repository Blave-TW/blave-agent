"""A venue whose login is blocked pauses only its own strategies (manager/reconciler
_sync_venue_pauses + place_order + the read guard; lib/president_vault.login_paused) —
no network, no broker. Wei 2026-10-07: 統一 blocked → its strategies stop, no HALT,
other venues keep trading; once a login passes they resume by themselves.

  1. blocked: a 統一 leg is not sent (place_order False, the order lib never called);
     a crypto leg on the same round still goes out; no HALT
  2. one venue_login_blocked (cause: venue) per block, however many ticks; the state
     file says paused_blocked (what the report carries)
  3. a failed 統一 position read while paused skips the round without counting
     (no three-strikes HALT)
  4. the login passes (the lib clears the block) → one venue_login_restored, the next
     round is forced, 統一 legs go out again
  5. the lib side: login_paused() is read-only (never takes the released try), only
     for the credentials in use, and a released block still pauses until a login passes

Run: cd blave-agent && python3 tests/check_venue_login_pause.py
"""
import json, os, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(tempfile.mkdtemp(prefix="vpause-"))
os.makedirs("manager", exist_ok=True)
os.makedirs("state", exist_ok=True)
open("manager/portfolio_config.json", "w").write(json.dumps(
    {"self_ledger": False, "exchanges": {"txf_trend": "president", "btc_trend": "binance"}}))

from lib import guard, president_vault  # noqa: E402
from manager import reconciler as rec  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


evs, sent = [], []
rec.events.emit = lambda t, **p: evs.append((t, p))
state = {"kind": "PASSWORD"}
president_vault.login_paused = lambda: state["kind"]
rec._HAND_WIRED[rec.venue_traits.PRESIDENT] = (lambda: {}, lambda *a, **k: sent.append(("president", a)) or {"executed_qty": 1})
import lib.execute  # noqa: E402
lib.execute.dispatch_order = lambda symbol, diff, **k: sent.append((k.get("exchange"), symbol)) or {"executed_qty": 1}
halts = []
real_trip = guard.trip_halt
guard.trip_halt = lambda *a, **k: halts.append(a)

# 1 / 2
for _ in range(3):
    rec._sync_venue_pauses(now=1000)
check(evs == [("venue_login_blocked", {"venue": "president", "kind": "PASSWORD"})], f"2 one venue_login_blocked per block ({evs})")
doc = json.load(open(rec.VENUE_PAUSE_PATH))
check(doc.get("president", {}).get("state") == "paused_blocked" and "binance" not in doc, f"2 state file: 統一 paused_blocked, binance not ({doc})")
r1 = rec.place_order("TXF", 1, exchange="president")
r2 = rec.place_order("BTCUSDT", 100, exchange="binance")
check(r1 is False and ("president", ("TXF", 1)) not in sent, "1 a 統一 leg is not sent while its login is blocked")
check(("binance", "BTCUSDT") in sent and r2, "1 a crypto leg on the same machine still goes out")
check(not halts and not os.path.exists("state/HALT"), "1 no HALT")

# 3
rec._HAND_WIRED[rec.venue_traits.PRESIDENT] = (lambda: (_ for _ in ()).throw(RuntimeError("president: no snapshot")),
                                               rec._HAND_WIRED[rec.venue_traits.PRESIDENT][1])
rec._current_venue = lambda: "president"
rec._hand_wired_routed = lambda: "president"
before = rec._consecutive_failures
skipped = 0
for _ in range(5):
    try:
        rec._get_positions_guarded(now=1000)
    except rec.ReadSkipped:
        skipped += 1
check(skipped == 5 and rec._consecutive_failures == before and not halts,
      "3 a failed 統一 read while paused skips the round, never counts toward the three-strikes HALT")

# 4
state["kind"] = None
restored = rec._sync_venue_pauses(now=1000 + 600)
check(restored is True and evs[-1] == ("venue_login_restored", {"venue": "president", "minutes": 10}),
      f"4 login passed: one venue_login_restored, the next round forced ({evs[-1]})")
check(rec._sync_venue_pauses(now=1700) is False and len(evs) == 2, "4 …once")
sent.clear()
rec.place_order("TXF", 1, exchange="president")
check(("president", ("TXF", 1)) in sent, "4 統一 legs go out again")
check(json.load(open(rec.VENUE_PAUSE_PATH)) == {}, "4 state file cleared")

# 5 lib side (the real login_paused)
import importlib  # noqa: E402
pv = importlib.reload(president_vault)
creds = {"account": "70000011234", "password": "pw", "ca_path": "/nope.pfx", "ca_password": ""}
pv.resolve = lambda _i=None: dict(creds, url="https://test167.testpfctrade.com", live=False)
pv.BLOCK = os.path.abspath("state/president_login_block.json")
check(pv.login_paused() is None, "5 nothing blocked → None")
pv._record(creds, "PASSWORD")
check(pv.login_paused() == "PASSWORD", "5 a PASSWORD block for the credentials in use → paused")
pv.unblock()
b = json.load(open(pv.BLOCK))
check(pv.login_paused() == "PASSWORD" and b.get("allow_once") is True and not os.path.exists(pv.BLOCK + ".claim"),
      "5 a released block still pauses, and asking never takes the released try")
pv.resolve = lambda _i=None: dict(creds, password="other", url="x", live=False)
check(pv.login_paused() is None, "5 a block for other credentials is not ours")
pv.resolve = lambda _i=None: dict(creds, url="x", live=False)
pv._clear()
check(pv.login_paused() is None, "5 a login that passed (the lib's _clear) lifts it")

guard.trip_halt = real_trip
print(f"\n{'FAILED: ' + str(fails) if fails else 'all ok'}")
sys.exit(1 if fails else 0)
