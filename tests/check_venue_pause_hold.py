"""A contract the bound venue pauses (BingX status 25) is held on both sides, not ordered and not a
failure: no place_order call, listed under market_closed in manager/last_reconcile.json. Control:
the same round with the venue open places the order. No network.
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


def run(held):
    placed = []
    target = {"STXXUSDT": {"side": "long", "size": 100.0, "exchange": None, "asset_spec": None,
                           "contributors": []},
              "BTCUSDT": {"side": "long", "size": 100.0, "exchange": None, "asset_spec": None,
                          "contributors": []}}
    portfolio.aggregate_portfolio = lambda: target
    portfolio.reconcile(get_positions_fn=lambda: held,
                        place_order_fn=lambda symbol, signed_diff, spec, **kw: placed.append(symbol) or
                        {"executed_qty": 1, "avg_price": 50.0},
                        threshold=10, send_telegram_fn=lambda text: None)
    snap = json.load(open("manager/last_reconcile.json"))
    return placed, snap.get("market_closed") or []


placed, closed = run({})
check("STXXUSDT" not in placed and "BTCUSDT" in placed, f"paused entry not sent, the open one is ({placed})")
check(closed == ["STXXUSDT"], f"listed under market_closed ({closed})")
placed, closed = run({"STXXUSDT": {"side": "long", "size": 300.0}})
check("STXXUSDT" not in placed, f"paused reduce not sent either ({placed})")
_FakeBingX.paused = set()
placed, closed = run({})
check("STXXUSDT" in placed and closed == [], f"control: open again → ordered ({placed}, {closed})")

print(f"\n{fails} failed")
sys.exit(1 if fails else 0)
