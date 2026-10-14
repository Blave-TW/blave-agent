"""A 下單設定 save lands whole or not at all (Windows e2e 10-14 C4: the config write failed with
WinError 5 after the mirror had landed; the reconciler, which takes amounts from the mirror,
bought the new amount while the page said the save failed).

  1. config write fails → SAVE_FAILED, mirror / config / rollover record exactly as before, and
     the reconciler's own read (lib/portfolio) still sees the old amount: no order.
  2. mirror write fails → the config already written is rolled back (and a first save's config
     removed — with no mirror the config alone would trade).
  3. the rollover record a contract switch wrote is restored when the save fails.
  4. while the writes run, state/execution/hold (the reconciler's no-round hold) is on; it is
     gone afterwards, and someone else's hold is left alone.
  5. refresh_capacity.tree_pids: the launcher and its descendants (Windows venv python.exe).

Run: cd blave-agent && .venv/bin/python tests/check_amounts_save_atomic.py
"""
import json
import os
import shutil
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = tempfile.mkdtemp(prefix="amounts-atomic-")
WS = os.path.join(BASE, "workspace")
for d in ("manager", "state", "strategies/btc_a", "strategies/txf_a", "lib"):
    os.makedirs(os.path.join(WS, d))
os.environ["BLAVE_AGENT_BASE"] = BASE
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.pop("BLAVE_AGENT_LOCAL", None)
sys.path.insert(0, os.path.join(ROOT, "runtime"))
sys.path.insert(0, ROOT)
os.chdir(WS)
import atomic_file  # noqa: E402
import command_listener as cl  # noqa: E402
import refresh_capacity as rc  # noqa: E402
from lib import portfolio  # noqa: E402

fails = 0
CONFIG = os.path.join(WS, "manager", "portfolio_config.json")
MIRROR = os.path.join(WS, "manager", "amounts.ui.json")
ROLL = os.path.join(WS, "state", "contract_rollover.json")
HOLD = os.path.join(WS, "state", "execution", "hold.amounts")
UPD_HOLD = os.path.join(WS, "state", "execution", "hold")
EVENTS = os.path.join(WS, "state", "events.jsonl")
HALTF = os.path.join(WS, "state", "HALT")


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


for n, sym in (("btc_a", "BTCUSDT"), ("txf_a", "TXF")):
    json.dump({"symbol": sym}, open(os.path.join(WS, "strategies", n, "stats.json"), "w"))
    json.dump({"symbol": sym, "position": 1}, open(os.path.join(WS, "strategies", n, "state.json"), "w"))
    open(os.path.join(WS, "strategies", n, "strategy.py"), "w").write(f'SYMBOL = "{sym}"\nINTERVAL = "1h"\n')
open(os.path.join(WS, "manager", "wait_for_bar.py"), "w").write("# present\n")
open(os.path.join(WS, ".env"), "w").write("PAPER_API_KEY=paper\nPAPER_SECRET_KEY=paper\nPAPER_BOUND_TS=1\n")
cl._sync_strategy_crons = lambda names: None
# the workspace lib on disk honours contracts (refresh_capacity / contract checks read it)
for f in ("portfolio.py", "paper_data.py"):
    shutil.copy(os.path.join(ROOT, "lib", f), os.path.join(WS, "lib", f))
cl.reconciler_presence.unsupervised_reconciler_pids = lambda proc="/proc", all_=False, workspace=None: []
cl._unsupervised_reconciler_pids = lambda proc="/proc", all_=False: []

real_replacing = atomic_file.replacing
FAIL_ON = {"path": None}
SEEN_HOLD = []


def flaky_replacing(path, *a, **k):
    SEEN_HOLD.append((os.path.basename(path), os.path.exists(HOLD)))
    if FAIL_ON["path"] and os.path.abspath(path) == os.path.abspath(FAIL_ON["path"]):
        raise PermissionError(13, "[WinError 5] Access is denied", path)
    return real_replacing(path, *a, **k)


cl.atomic_file.replacing = flaky_replacing


def files():
    return tuple(open(p).read() if os.path.exists(p) else None for p in (CONFIG, MIRROR, ROLL))


def save(amounts, contracts=None, fail=None):
    FAIL_ON["path"] = fail
    args = {"amounts": amounts}
    if contracts is not None:
        args["contracts"] = contracts
    try:
        cl._cmd_amounts(args)
        return None
    except (ValueError, RuntimeError) as e:
        return str(e)
    finally:
        FAIL_ON["path"] = None


def target_of(key):
    t = portfolio.aggregate_portfolio().get(key) or {}
    return t.get("size") if t.get("side") == "long" else -t.get("size", 0) if t.get("side") == "short" else 0


# ── 2a. first save, mirror fails: no config is left behind ──
err = save({"btc_a": 66000}, fail=MIRROR)
check((err or "").startswith("SAVE_FAILED:") and files() == (None, None, None),
      f"2 first save, mirror write fails → SAVE_FAILED, no config left to trade alone ({err})")
check(save({"btc_a": 66000}) is None and target_of("BTCUSDT") == 66000, "…a clean save then lands (target 66,000)")

# ── 1. config fails ──
before = files()
err = save({"btc_a": 67000}, fail=CONFIG)
check((err or "").startswith("SAVE_FAILED:") and "WinError" not in err and files() == before,
      f"1 config write fails → SAVE_FAILED, mirror and config untouched ({err})")
check(target_of("BTCUSDT") == 66000, "1 …the reconciler's own read still sizes 66,000: no buy of 1,000")

# ── 2b. mirror fails after the config landed ──
err = save({"btc_a": 67000}, fail=MIRROR)
check((err or "").startswith("SAVE_FAILED:") and files() == before and target_of("BTCUSDT") == 66000,
      f"2 mirror write fails → the config is rolled back too, nothing changed ({err})")

# ── 3. rollover record restored ──
check(save({"btc_a": 66000, "txf_a": 1}) is None, "(txf_a funded on TXF)")
import portfolio_reporter  # noqa: E402
portfolio_reporter.can_switch_contract = lambda hb=None, last=None: True
before = files()
err = save({"btc_a": 66000, "txf_a": 20}, {"txf_a": "TMF"}, fail=CONFIG)
check((err or "").startswith("SAVE_FAILED:") and files() == before and not (before[2] or "").strip("{} \n"),
      f"3 a contract switch whose config write fails leaves no rollover record behind ({err})")
check(target_of("TXF") == 1 and not target_of("TMF"), "3 …and still trades 1 TXF, nothing on TMF")
err = save({"btc_a": 66000, "txf_a": 20}, {"txf_a": "TMF"})
check(err is None and json.load(open(ROLL))["txf_a"]["to"] == "TMF", f"3 …the same save, clean, records the rollover ({err})")

# ── 4. the hold ──
del SEEN_HOLD[:]
save({"btc_a": 66001, "txf_a": 20}, {"txf_a": "TMF"})
check(SEEN_HOLD and all(h for _, h in SEEN_HOLD), f"4 the reconciler's hold is on during every write ({SEEN_HOLD})")
check(not os.path.exists(HOLD), "4 …and gone afterwards")
os.makedirs(os.path.dirname(UPD_HOLD), exist_ok=True)
open(UPD_HOLD, "w").write("12345 1")
save({"btc_a": 66002, "txf_a": 20}, {"txf_a": "TMF"})
check(os.path.exists(UPD_HOLD) and open(UPD_HOLD).read() == "12345 1" and not os.path.exists(HOLD),
      "4 the save uses its own hold file; the workspace update's hold is never touched")
os.remove(UPD_HOLD)

# ── 6. a rollback that cannot be done is an alarm ──
def events_of():
    try:
        return [json.loads(l)["type"] for l in open(EVENTS) if l.strip()]
    except OSError:
        return []


real_remove = os.remove


def stuck_remove(path, *a, **k):
    if os.path.abspath(path) == os.path.abspath(CONFIG):
        raise PermissionError(13, "[WinError 32] in use", path)
    return real_remove(path, *a, **k)


for p in (CONFIG, MIRROR, ROLL, EVENTS):
    if os.path.exists(p):
        real_remove(p)
cl.os.remove = stuck_remove
err = save({"btc_a": 66000}, fail=MIRROR)   # first save: config written, mirror fails, config cannot be removed
cl.os.remove = real_remove
check((err or "").startswith("SAVE_FAILED:") and os.path.exists(HALTF) and events_of() == ["settings_unsafe"],
      f"6 first save, the leftover config cannot be removed: HALT + one P1 event settings_unsafe ({events_of()})")
real_remove(HALTF)
real_remove(CONFIG)
real_remove(EVENTS)
check(save({"btc_a": 66000}) is None, "(a clean save)")
real_restore = cl._file_restore


def stuck_restore(path, data):
    raise PermissionError(13, "[WinError 32] in use", path)


cl._file_restore = stuck_restore
err = save({"btc_a": 67000}, fail=MIRROR)   # the old mirror stays in charge
cl._file_restore = real_restore
check((err or "").startswith("SAVE_FAILED:") and not os.path.exists(HALTF) and events_of() == ["settings_rollback_failed"]
      and target_of("BTCUSDT") == 66000,
      f"6 a later save's config cannot be restored: no HALT, one P2 event, the old mirror still trades 66,000 ({events_of()})")

# the rollback's own compare-read blocked: counted as a failed rollback, never skipped
for p in (CONFIG, MIRROR, ROLL, EVENTS, HALTF):
    if os.path.exists(p):
        real_remove(p)
real_snap = cl._file_snapshot
reads = {"n": 0}


def blocked_snapshot(path):
    if os.path.abspath(path) == os.path.abspath(CONFIG):
        reads["n"] += 1
        if reads["n"] > 1:   # the first read is the pre-save snapshot; the rollback's is blocked
            raise PermissionError(13, "[WinError 32] in use", path)
    return real_snap(path)


cl._file_snapshot = blocked_snapshot
err = save({"btc_a": 66000}, fail=MIRROR)
cl._file_snapshot = real_snap
check((err or "").startswith("SAVE_FAILED:") and os.path.exists(HALTF) and events_of() == ["settings_unsafe"],
      f"6 the rollback cannot even read the config back: an alarm (first save → HALT + P1), not a silent skip ({events_of()})")
for p in (CONFIG, MIRROR, ROLL, EVENTS, HALTF):
    if os.path.exists(p):
        real_remove(p)

# retries before giving up (Windows sharing violation)
calls = {"n": 0}


def flaky_remove(path, *a, **k):
    if os.path.abspath(path) == os.path.abspath(CONFIG) and calls["n"] < 2:
        calls["n"] += 1
        raise PermissionError(13, "[WinError 32] in use", path)
    return real_remove(path, *a, **k)


cl.atomic_file.REPLACE_RETRY_DELAYS = (0.01, 0.01, 0.01)
open(CONFIG, "w").write("{}")
cl.os.remove = flaky_remove
cl._file_restore(CONFIG, None)
cl.os.remove = real_remove
check(not os.path.exists(CONFIG) and calls["n"] == 2, "6 removing the leftover config retries through transient sharing violations")

# ── 5. Windows tree ──
rows = [(10, 1), (11, 10), (12, 11), (13, 10), (20, 1), (21, 20)]
check(sorted(rc.tree_pids(10, rows)) == [10, 11, 12, 13], f"5 launcher + its python child + grandchildren ({rc.tree_pids(10, rows)})")
check(rc.tree_pids(99, rows) == [99], "5 no children → just the process")

shutil.rmtree(BASE, ignore_errors=True)
print(f"\n{'ALL PASS' if not fails else f'{fails} FAIL'}")
sys.exit(1 if fails else 0)
