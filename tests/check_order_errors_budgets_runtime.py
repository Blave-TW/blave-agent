"""manager/order_errors.json keeps two budgets of 5 (lib/portfolio._keep_order_error_rows): reconcile's
rejection rows (`leg`) and every other row. The runtime's manual-close writer
(command_listener._record_manual_close_row) used to trim by position (rows[-5:]): after a parked row,
a close-all failure and 5 rejection rows, its row pushed the parked and the close-all rows out.
It now keeps the same two budgets through the same function, looked up at call time on the workspace
module as it is on disk (_ws_portfolio): the listener is long-lived, and a workspace update replaces
lib/portfolio.py under it. A workspace without the function keeps its newest 5, as before.

Run: cd blave-agent && .venv/bin/python tests/check_order_errors_budgets_runtime.py
"""
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNTIME = os.path.join(ROOT, "runtime")
BASE = tempfile.mkdtemp(prefix="oe-budgets-", dir=os.environ.get("SCRATCHPAD") or None)
WS = os.path.join(BASE, "workspace")
os.makedirs(os.path.join(WS, "manager"))
with open(os.path.join(WS, "manager", "portfolio_config.json"), "w") as f:
    f.write("{}")
# the workspace's own lib, so an update can replace lib/portfolio.py under the listener
shutil.copytree(os.path.join(ROOT, "lib"), os.path.join(WS, "lib"), ignore=shutil.ignore_patterns("__pycache__"))
PF = os.path.join(WS, "lib", "portfolio.py")
NEW = open(os.path.join(ROOT, "lib", "portfolio.py"), encoding="utf-8").read()
OLD = NEW.replace("def _keep_order_error_rows(", "def _keep_order_error_rows_not_yet(")   # a pre-update lib
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.pop("BLAVE_AGENT_LOCAL", None)
sys.path.insert(0, RUNTIME)
os.chdir(WS)

spec = importlib.util.spec_from_file_location("command_listener", os.path.join(RUNTIME, "command_listener.py"))
cl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cl)

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


OE = os.path.join(WS, "manager", "order_errors.json")
ERR = "[order_reject:insufficient_margin] margin short"


def seed():
    rows = [{"kind": "order_unconfirmed", "park_id": "P1", "ts": "2026-11-20T00:00:00", "symbol": "BTCUSDT",
             "exchange": "okx", "error": "order P1 sent, no answer"},
            {"ts": "2026-11-20T00:00:01", "symbol": "ETHUSDT", "exchange": "okx",
             "error": "close-all: ETHUSDT not closed (reduce-only refused)"}]
    rows += [{"ts": f"2026-11-20T00:00:1{i}", "symbol": f"R{i}USDT", "exchange": "okx", "error": ERR,
              "leg": "entry", "silent": True} for i in range(5)]   # a rejection every round after them
    json.dump(rows, open(OE, "w"))


def syms():
    return [r["symbol"] for r in json.load(open(OE))]


def write_pf(text, mtime):
    with open(PF, "w", encoding="utf-8") as f:
        f.write(text)
    os.utime(PF, (mtime, mtime))


# ── the listener started on a workspace from before the two budgets ─────────
write_pf(OLD, time.time() - 100)
cl._in_workspace(cl._ws_portfolio)   # imported once, as a long-lived listener would have
seed()
try:
    cl._record_manual_close_row(["TXF"])
    raised = None
except Exception as e:  # noqa: BLE001
    raised = e
check(raised is None and syms() == ["R1USDT", "R2USDT", "R3USDT", "R4USDT", "*"],
      f"a workspace without the function: its newest 5, as before, nothing raised ({syms()}, {raised!r})")

# ── an update replaces lib/portfolio.py under the running listener ───────────
write_pf(NEW, time.time())
seed()
cl._record_manual_close_row(["TXF"])
s = syms()
check(json.load(open(OE))[-1].get("kind") == "manual_close_required", f"the manual-close row is written ({s})")
check("BTCUSDT" in s and "ETHUSDT" in s,
      f"after the update, same process: the parked and the close-all rows are still there ({s})")
check([x for x in s if x.startswith("R")] == [f"R{i}USDT" for i in range(5)],
      f"…and so are the 5 rejection rows: each budget keeps its own ({s})")

for i in range(3):
    cl._record_manual_close_row([f"TX{i}"])
other = [r for r in json.load(open(OE)) if not r.get("leg")]
check(len(other) == 5 and len(syms()) == 10 and other[0]["symbol"] == "ETHUSDT",
      f"more manual-close rows: the other budget keeps its newest 5, the rejection rows untouched ({syms()})")

# ── a fresh listener that imported the old lib the normal way (e.g. _capital_open_book_keys, one line
#    before the manual-close write), then the update: _ws_portfolio's first look records the new mtime
#    on the stale module, so the function is not on it — read once more ──────────────────────────────
sys.modules.pop("lib.portfolio", None)
cl._ws_portfolio_mtime.clear()
write_pf(OLD, time.time() - 50)
cl._in_workspace(lambda: __import__("lib.portfolio"))
write_pf(NEW, time.time() + 5)
seed()
cl._record_manual_close_row(["TXF"])
s = syms()
check("BTCUSDT" in s and "ETHUSDT" in s and len([x for x in s if x.startswith("R")]) == 5,
      f"imported the normal way before the update: the parked and the close-all rows are still there ({s})")

shutil.rmtree(BASE, ignore_errors=True)
print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
