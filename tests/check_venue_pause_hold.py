"""A contract the bound venue forbids opening (BingX status 25, FORBIDDEN_TO_OPEN): an entry or an
add is held — no place_order call, listed under market_closed in manager/last_reconcile.json — while
a reduce goes out and a flip only closes. Control: the venue open again places the entry. No network.
Run: cd blave-agent && .venv/bin/python tests/check_venue_pause_hold.py
"""
import json, os, sys, tempfile
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(tempfile.mkdtemp(prefix="pausehold-"))
os.makedirs("manager", exist_ok=True)
open("manager/portfolio_config.json", "w").write(json.dumps({"self_ledger": False}))
from lib import portfolio, venue_wiring  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


class _FakeBingX:
    paused = {"STXXUSDT"}

    def get_contract_rules(self, env, sym):
        return {"step": 0.01, "min_qty": 0.01, "min_notional": 2.0, "contract_value": 1}

    def get_mark_price(self, env, sym):
        return 50.0

    def session_open(self, env, sym):
        return sym not in self.paused


sys.modules["lib.order_bingx"] = _FakeBingX()
venue_wiring.read_env = lambda path=".env": {"BINGX_API_KEY": "k"}
venue_wiring.detect_venue = lambda env: "bingx"
venue_wiring.hand_wired_venue = lambda: None
portfolio._record_order_error = lambda *a, **k: None


def run(held, side="long"):
    placed = []
    target = {"STXXUSDT": {"side": side, "size": 100.0, "exchange": None, "asset_spec": None,
                           "contributors": []},
              "BTCUSDT": {"side": "long", "size": 100.0, "exchange": None, "asset_spec": None,
                          "contributors": []}}
    portfolio.aggregate_portfolio = lambda: target
    portfolio.reconcile(get_positions_fn=lambda: held,
                        place_order_fn=lambda symbol, signed_diff, spec, **kw: placed.append((symbol, signed_diff)) or
                        {"executed_qty": 1, "avg_price": 50.0},
                        threshold=10, send_telegram_fn=lambda text: None)
    snap = json.load(open("manager/last_reconcile.json"))
    return placed, snap.get("market_closed") or []


def stxx(placed):
    return [round(d) for s, d in placed if s == "STXXUSDT"]


placed, closed = run({})
check(stxx(placed) == [] and any(s == "BTCUSDT" for s, _ in placed),
      f"paused entry not sent, the open one is ({placed})")
check(closed == ["STXXUSDT"], f"listed under market_closed ({closed})")
placed, closed = run({"STXXUSDT": {"side": "long", "size": 50.0}})
check(stxx(placed) == [] and closed == ["STXXUSDT"], f"paused add not sent ({placed}, {closed})")
placed, closed = run({"STXXUSDT": {"side": "long", "size": 300.0}})
check(stxx(placed) == [-200] and closed == [], f"paused reduce goes out ({placed}, {closed})")
placed, closed = run({"STXXUSDT": {"side": "long", "size": 300.0}}, side="short")
check(stxx(placed) == [-300] and closed == [], f"paused flip only closes the long ({placed}, {closed})")
_FakeBingX.paused = set()
placed, closed = run({})
check(stxx(placed) == [100] and closed == [], f"control: open again → ordered ({placed}, {closed})")

print(f"\n{fails} failed")
sys.exit(1 if fails else 0)
