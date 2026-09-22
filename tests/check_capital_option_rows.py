"""群益 option rows must never be read as 大台 (TXF) — no network, no Windows.

TAIFEX options sit in the same futures account and their codes start with TX
(TXO22000J6, TX122000A6). A prefix match made them an actual TXF position in
the reconciler (→ a real TX00 order to "fix" the diff) and a TX00 close in
close-all. Asserts: _alias_for_resolved maps only root+YYMM futures and raises
on option codes; _capital_get_positions keeps TM/MTX/TX futures, drops option
rows, and FAILS the read on a TX/MTX/TM row it can't classify (it may be a
futures position in an unseen format — reading it as flat re-enters on top);
capital_worker keeps TF rows, skips other markets, and fails the query on a
futures code under a non-TF market; the three copies of the futures pattern
(order_capital, capital_worker, flatten) stay identical.

Run: cd blave-agent && python3 tests/check_capital_option_rows.py
"""
import ast, os, sys, tempfile, types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(tempfile.mkdtemp(prefix="capopt-"))
os.makedirs("manager", exist_ok=True)
open("manager/portfolio_config.json", "w").write("{}")

from lib import capital_worker, order_capital  # noqa: E402
from manager import reconciler  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


OPTIONS = ["TXO22000J6", "TX122000A6", "TX422000V6", "TX522000X7", "TF2610", "CDF2610",
           "TXU22000J6", "TXV22000M6", "TXX22000A7", "TXY22000L6", "TXZ22000X6"]
UNKNOWN = ["TXO22000", "TX2613", "TX10", "MTX2610W1", "TM08"]


def _flatten_pattern():
    src = open(os.path.join(ROOT, "manager", "flatten.py"), encoding="utf-8").read()
    for node in ast.walk(ast.parse(src)):
        if isinstance(node, ast.Assign) and getattr(node.targets[0], "id", "") == "_CAPITAL_FUT_RE":
            return node.value.args[0].value
    return None


check(order_capital.CAPITAL_FUT_RE.pattern == _flatten_pattern(), "pattern == flatten's")
check(order_capital.CAPITAL_FUT_RE.pattern == capital_worker._CAPITAL_FUT_RE.pattern,
      "pattern == capital_worker's")

for sym, alias in (("TM2608", "TM0000"), ("TX2610", "TX00"), ("MTX2610", "MTX00")):
    check(order_capital._alias_for_resolved(sym) == alias, f"alias {sym} -> {alias}")
for sym in OPTIONS + UNKNOWN:
    try:
        order_capital._alias_for_resolved(sym)
        check(False, f"alias {sym} raises")
    except ValueError:
        check(True, f"alias {sym} raises")

acct = types.ModuleType("lib.account_capital")
acct.get_snapshot_read_at = lambda: 1e12
RAW = {s: {"side": "long", "size": 3.0} for s in OPTIONS}
RAW.update({"TM2608": {"side": "short", "size": 1.0}, "MTX2610": {"side": "long", "size": 2.0}})
acct.get_positions = lambda env: RAW
sys.modules["lib.account_capital"] = acct
got = reconciler._capital_get_positions()
check(set(got) == {"TMF", "MXF"}, f"positions keep futures only: {sorted(got)}")
check(got.get("TMF", {}).get("side") == "short" and got.get("MXF", {}).get("size") == 2.0,
      "futures rows unchanged")
RAW["TX2610"] = {"side": "long", "size": 1.0}
check(reconciler._capital_get_positions().get("TXF", {}).get("size") == 1.0, "TX2610 -> TXF")
RAW["TX2610 "] = RAW.pop("TX2610")
check(reconciler._capital_get_positions().get("TXF", {}).get("size") == 1.0, "padded TX2610 -> TXF")
for sym in UNKNOWN:
    RAW[sym] = {"side": "long", "size": 1.0}
    try:
        reconciler._capital_get_positions()
        check(False, f"unknown {sym!r} fails the read")
    except RuntimeError:
        check(True, f"unknown {sym!r} fails the read")
    del RAW[sym]


class _FakeOrder:
    def GetOpenInterest(self, login_id, acct):
        capital_worker.Events.oi_rows = [
            "TF,acct,TM2608 ,B,1,0,46138.0000,10,,,ID",
            "OF,acct,CN2610,S,2,0,1.0000,1,,,ID",
        ] + EXTRA
        capital_worker.Events.oi_done = True
        return 0


capital_worker._log = lambda msg: None
EXTRA = []
rows = capital_worker.query_open_interest(_FakeOrder(), "id", "acct")
check([r["symbol"] for r in rows] == ["TM2608"], f"worker keeps TF rows only: {rows}")
for row in ("TO,acct,TX2610,B,1,0,22000.0000,200,,,ID", " TF ,acct,MTX2610,S,1,0,1.0,50,,,ID"):
    EXTRA = [row]
    try:
        rows = capital_worker.query_open_interest(_FakeOrder(), "id", "acct")
        ok = row.startswith(" TF") and [r["symbol"] for r in rows] == ["TM2608", "MTX2610"]
        check(ok, f"worker row {row[:18]!r}: {[r['symbol'] for r in rows]}")
    except RuntimeError:
        check(row.startswith("TO"), f"worker futures code under non-TF market raises: {row[:18]!r}")

print("PASS" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
