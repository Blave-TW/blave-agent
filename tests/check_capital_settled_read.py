"""群益 Read-Your-Writes guard judges a snapshot by when its read STARTED — no network, no Windows.

A worker read that began before an order and was written after it carries a
read_at newer than the order but the old open interest; on sNewClose=2 a second
close on it opens the reverse. Asserts, case by case:
1. _capital_check_snapshot_caught_up: no order → never raises; with an order,
   raises for every query start < order + ORDER_SETTLE_S and passes from there.
2. account_capital.get_query_started_at: the field when present, read_at when a
   pre-field worker wrote the snapshot; stale / error snapshots raise as before.
3. _capital_get_positions on a real snapshot file: a read_at well past the order
   with an early query start is refused; a settled query start returns positions.
4. _capital_place_order stamps the marker again after the call (also when it
   raises) and touches the refresh flag only after that.
5. capital_worker._tick_snapshot stamps query_started_at before its first query;
   main()'s rate-limit branch never writes a snapshot.
6. capital_worker._sleep_until_refresh: no flag → full poll; fresh flag → tick at
   flag + ORDER_SETTLE_S; an old flag → tick at the MIN_TICK_SPACING_S floor.

Run: cd blave-agent && python3 tests/check_capital_settled_read.py
"""
import ast, json, os, sys, tempfile, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
TMP = tempfile.mkdtemp(prefix="capsettle-")
os.chdir(TMP)
os.makedirs("manager", exist_ok=True)
open("manager/portfolio_config.json", "w").write("{}")

from lib import account_capital, capital_vault, capital_worker, order_capital  # noqa: E402
from manager import reconciler  # noqa: E402

S = capital_vault.ORDER_SETTLE_S
fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


def lag(q):
    try:
        reconciler._capital_check_snapshot_caught_up(q)
        return False
    except reconciler.CapitalCacheLagError:
        return True


# 1 — the comparison
check(S >= 20, f"ORDER_SETTLE_S >= 20 (統一's measured 12.0/10.9 s + margin): {S}")
reconciler._capital_last_order_at = 0.0
check(not lag(0.0) and not lag(1e12), "no order pending → never refused")
M = 1_000_000.0
reconciler._capital_last_order_at = M
for q, want in ((M - 5, True), (M, True), (M + S - 0.001, True), (M + S, False), (M + S + 100, False)):
    check(lag(q) is want, f"order at M, query started at M{q - M:+g} → {'refused' if want else 'accepted'}")

# 2 — the account lib
SNAP = os.path.join(TMP, "capital_account.json")
account_capital._SNAPSHOT = SNAP


def write_snap(**kw):
    with open(SNAP, "w") as f:
        json.dump(dict({"ok": True, "error": None, "positions": [], "holdings": []}, **kw), f)


now = time.time()
write_snap(read_at=now, query_started_at=now - 3)
check(account_capital.get_query_started_at() == now - 3, "query_started_at returned when present")
write_snap(read_at=int(now))
check(account_capital.get_query_started_at() == float(int(now)), "pre-field snapshot → read_at")
write_snap(read_at=now - 301, query_started_at=now - 304)
try:
    account_capital.get_query_started_at()
    check(False, "stale snapshot raises")
except RuntimeError as e:
    check("stale" in str(e), "stale snapshot raises the same error as before")
write_snap(read_at=now, ok=False, error="boom")
try:
    account_capital.get_query_started_at()
    check(False, "error snapshot raises")
except RuntimeError as e:
    check("capital worker error" in str(e), "error snapshot raises the same error as before")

# 3 — the reconciler read, end to end on a snapshot file
now = time.time()
reconciler._capital_last_order_at = now - 100
pos = [{"symbol": "TM2610", "side": "buy", "lots": 1.0}]
write_snap(read_at=now, query_started_at=now - 99, positions=pos)
try:
    reconciler._capital_get_positions()
    check(False, "read_at 100 s past the order but query started 1 s after it → refused")
except reconciler.CapitalCacheLagError:
    check(True, "read_at 100 s past the order but query started 1 s after it → refused")
write_snap(read_at=now, query_started_at=now - 100 + S, positions=pos)
got = reconciler._capital_get_positions()
check(got.get("TMF", {}).get("size") == 1.0, f"settled query start → positions returned: {got}")
write_snap(read_at=now - 95, positions=pos)
try:
    reconciler._capital_get_positions()
    check(False, "pre-field snapshot, read_at 5 s after the order → refused (settle applies)")
except reconciler.CapitalCacheLagError:
    check(True, "pre-field snapshot, read_at 5 s after the order → refused (settle applies)")
reconciler._capital_last_order_at = 0.0
write_snap(read_at=now, query_started_at=now - 250, positions=pos)
check(reconciler._capital_get_positions().get("TMF", {}).get("size") == 1.0,
      "no order pending → an old query start is still read (normal rounds unchanged)")

# 4 — the marker around the call
order_capital._REFRESH_FLAG = os.path.join(TMP, "capital_refresh")
seen = {}
real_refresh = order_capital._request_snapshot_refresh


def fake_order(env, symbol, action, lots, intent):
    seen["call_at"] = time.time()
    seen["marker_in_call"] = reconciler._capital_last_order_at
    time.sleep(0.05)
    if seen.get("raise"):
        raise RuntimeError("rejected")
    return {"status": "filled", "fill_qty": lots, "avg_fill_price": 1.0, "symbol": "TM2610"}


def recording_refresh():
    seen["marker_at_flag"] = reconciler._capital_last_order_at
    real_refresh()


order_capital.place_futures_market_order = fake_order
order_capital._request_snapshot_refresh = recording_refresh
for raising in (False, True):
    seen.clear()
    seen["raise"] = raising
    try:
        reconciler._capital_place_order("TMF", 1.0)
    except RuntimeError:
        pass
    m = reconciler._capital_last_order_at
    tag = "raising call" if raising else "filled call"
    check(seen["marker_in_call"] <= seen["call_at"], f"{tag}: marker stamped before the call")
    check(m > seen["call_at"] + 0.04, f"{tag}: marker stamped again after the call returned")
    check(seen.get("marker_at_flag") == m, f"{tag}: refresh flag touched after the final marker")
    check(os.path.getmtime(order_capital._REFRESH_FLAG) >= m - 0.01, f"{tag}: flag mtime >= marker")
    with open("state/capital_last_order_at") as f:
        check(float(f.read()) == m, f"{tag}: marker on disk = final marker")
order_capital._request_snapshot_refresh = real_refresh

# 5 — the worker stamps before querying
calls = {}


def fake_rights(order, login_id, tf):
    calls["rights_at"] = time.time()
    time.sleep(0.02)
    return {"equity": 1.0, "currency": "TWD", "available": 1.0}


capital_worker.query_rights = fake_rights
capital_worker.query_open_interest = lambda order, login_id, tf: []
capital_worker.query_balance = lambda order, login_id, ts: []
snap = capital_worker._tick_snapshot(None, "id", "TF", None)
check(snap["query_started_at"] <= calls["rights_at"], "worker: query_started_at stamped before the first query")
src = open(os.path.join(ROOT, "lib", "capital_worker.py"), encoding="utf-8").read()
main_fn = next(n for n in ast.walk(ast.parse(src)) if isinstance(n, ast.FunctionDef) and n.name == "main")
handlers = [h for n in ast.walk(main_fn) if isinstance(n, ast.Try) for h in n.handlers
            if isinstance(h.type, ast.Name) and h.type.id == "QueryInProgress"]
check(len(handlers) == 1 and not any(isinstance(c, ast.Call) and getattr(c.func, "id", "") == "_write_snapshot"
                                     for c in ast.walk(handlers[0])),
      "worker: a rate-limited tick keeps the last snapshot (its query start stays the old one)")


# 6 — the worker's early tick waits for the settle
class Clock:
    def __init__(self, t):
        self.t = t

    def time(self):
        return self.t

    def sleep(self, s):
        self.t += s


FLAG = os.path.join(TMP, "worker_refresh")
capital_worker.REFRESH_FLAG = FLAG
real_time = capital_worker.time
for label, flag_at, want in (("no flag", None, capital_worker.POLL_S),
                             ("flag touched now", 0, S),
                             ("flag touched 100 s ago", -100, capital_worker.MIN_TICK_SPACING_S)):
    T0 = 2_000_000.0
    clock = Clock(T0)
    if os.path.exists(FLAG):
        os.remove(FLAG)
    if flag_at is not None:
        open(FLAG, "w").close()
        os.utime(FLAG, (T0 + flag_at, T0 + flag_at))
    capital_worker.time = clock
    try:
        capital_worker._sleep_until_refresh()
    finally:
        capital_worker.time = real_time
    waited = clock.t - T0
    check(abs(waited - want) < capital_worker.REFRESH_CHECK_S, f"worker sleep, {label}: ticks after {waited:g}s (want ~{want}s)")
    if flag_at is not None:
        check(not os.path.exists(FLAG), f"worker sleep, {label}: flag consumed")

print(f"\n{'ALL OK' if not fails else f'{fails} FAILED'}")
sys.exit(1 if fails else 0)
