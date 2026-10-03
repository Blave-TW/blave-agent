"""Minimal check: every order lib puts [order_reject:<kind>] at the FRONT of a classified
rejection, and the token survives order_errors.json's 200-character cut — the desktop app
and the web page read only that token (spec-0.1.13-order-copy §4.2). No network: each venue
error class is built from a fake reply, and the lib-side size / symbol gates run on stubbed
contract rules.

Run: cd blave-agent && python3 tests/check_reject_token.py
"""
import json
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(tempfile.mkdtemp(prefix="order-reject-", dir=os.environ.get("SCRATCHPAD") or None))

from lib import reject_token as R
import lib.order_binance as bn
import lib.order_okx as okx
import lib.order_gateio as gt
import lib.order_bingx as bx
import lib.order_bybit as by
import lib.order_paper as pp
import lib.portfolio as portfolio

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


def kind(e):
    m = R._TOKEN_RE.match(str(e))
    return m.group(1) if m and m.group(1) in R.KINDS else None


def raises(fn):
    try:
        fn()
    except Exception as e:  # noqa: BLE001 — the message is what is under test
        return e
    return None


check(R.tag("insufficient_margin", "x") == "[order_reject:insufficient_margin] x" and R.tag("nope", "x") == "x"
      and R.tag(None, "x") == "x" and R.tag("below_min_size", R.tag("below_min_size", "x")) == "[order_reject:below_min_size] x",
      "tag: known kind in front, unknown / none untouched, never twice")
check(R.to_front("close_symbol: [order_reject:key_permission] Binance error -2015") == "[order_reject:key_permission] close_symbol: Binance error -2015"
      and R.to_front("plain") == "plain", "to_front: a token behind a caller's prefix moves to the start")
check(R.plain("[order_reject:key_permission] Binance error -2015") == "Binance error -2015" and R.plain("x") == "x"
      and portfolio._reject_plain("[order_reject:insufficient_margin] OKX error 51008") == "OKX error 51008", "plain: notices drop the token")

cases = {
    "Binance futures -2019": (bn.BinanceError("-2019", "Margin is insufficient.", "/fapi/v1/order"), "insufficient_margin"),
    "Binance spot -2010 insufficient balance": (bn.BinanceError(-2010, "Account has insufficient balance for requested action.", "/api/v3/order"), "insufficient_margin"),
    "Binance -2010 other reason": (bn.BinanceError(-2010, "Market is closed.", "/api/v3/order"), None),
    "Binance -2022": (bn.BinanceError(-2022, "ReduceOnly Order is rejected.", "/fapi/v1/order"), "reduce_only_rejected"),
    "Binance -4118": (bn.BinanceError(-4118, "ReduceOnly Order Failed.", "/fapi/v1/order"), "reduce_only_rejected"),
    "Binance -2015 (key)": (bn.BinanceError(-2015, "Invalid API-key, IP, or permissions for action.", "/fapi/v1/order"), "key_permission"),
    "Binance -1000 (unclassified)": (bn.BinanceError(-1000, "Unknown error", "/fapi/v1/order"), None),
    "OKX 51008": (okx.OKXError("51008", "Order failed. Insufficient margin.", "/api/v5/trade/order"), "insufficient_margin"),
    "OKX 51020": (okx.OKXError("51020", "Your order should meet or exceed the minimum order amount.", "/api/v5/trade/order"), "below_min_size"),
    "OKX 50100 (key)": (okx.OKXError("50100", "API frozen", "/api/v5/trade/order"), "key_permission"),
    "OKX account mode keeps its own token": (okx.AccountModeError("51010", "mode", "/api/v5/trade/order"), None),
    "Gate.io BALANCE_NOT_ENOUGH": (gt.GateioError("BALANCE_NOT_ENOUGH", "Not enough balance", "/spot/orders"), "insufficient_margin"),
    "Gate.io INVALID_KEY (key)": (gt.GateioError("INVALID_KEY", "Invalid key", "/futures/usdt/orders"), "key_permission"),
    "BingX 100413 (key)": (bx.BingXError(100413, "Incorrect apiKey", "/openApi/swap/v2/trade/order"), "key_permission"),
    "BingX unverified margin code": (bx.BingXError(101204, "Insufficient margin", "/openApi/swap/v2/trade/order"), None),
    "Bybit 110007": (by.BybitError("bybit /v5/order/create retCode=110007: Available balance is insufficient", code=110007), "insufficient_margin"),
    "Bybit 110017": (by.BybitError("bybit /v5/order/create retCode=110017: orderQty will be truncated to zero", code=110017), "reduce_only_rejected"),
    "Bybit 10003 (key)": (by.BybitError("bybit /v5/order/create retCode=10003: API key is invalid.", code=10003), "key_permission"),
}
for name, (e, want) in cases.items():
    check(kind(e) == want and (want is not None or not str(e).startswith("[order_reject:")), f"{name} → {want} ({str(e)[:70]})")
check(by.BybitError("x", code=110007).code == 110007 and bn.BinanceError("-2019", "m", "p").code == "-2019",
      "the code attributes the reconciler classifies on are unchanged")
check(str(okx.AccountModeError("51010", "m", "p")).find("[okx_account_mode]") >= 0, "OKX account-mode token still there")

# lib-side gates (ValueError / venue error before any request), on stubbed rules
bn.get_contract_rules = lambda env, s: {"active": True, "step": "0.001", "min_qty": 0.01, "min_notional": 5.0}
check(kind(raises(lambda: bn.format_qty({}, "BTCUSDT", 0.001))) == "below_min_size"
      and kind(raises(lambda: bn.format_qty({}, "BTCUSDT", 0.01, price=100))) == "below_min_size", "Binance format_qty below minimum qty / notional")
bn.get_contract_rules = lambda env, s: {"active": False, "step": "0.001", "min_qty": 0.01, "min_notional": 5.0}
check(kind(raises(lambda: bn.format_qty({}, "BTCUSDT", 1))) == "symbol_unavailable", "Binance format_qty on a contract not trading")
okx._instrument = lambda env, i, t: {"active": True, "ct_val": 0.01, "lot_sz": "1", "min_sz": 1, "tick_sz": "0.1"}
check(kind(raises(lambda: okx.format_qty({}, "BTCUSDT", 0.001))) == "below_min_size", "OKX format_qty below minimum")
check(kind(raises(lambda: okx._swap_inst("BTCEUR"))) == "symbol_unavailable", "OKX cannot derive an instId")
gt._futures_rules = lambda env, s: {"active": False, "multiplier": "0.0001", "min_ct": 1, "tick": "0.1"}
check(kind(raises(lambda: gt.format_qty({}, "BTCUSDT", 1))) == "symbol_unavailable", "Gate.io format_qty on a delisting contract")
bx.get_contract_rules = lambda env, s: {"active": True, "qty_precision": 4, "min_qty": 0.001, "min_notional": 2.0}
check(kind(raises(lambda: bx.format_qty({}, "BTC-USDT", 0.0001))) == "below_min_size", "BingX format_qty below minimum")
check(kind(raises(lambda: pp._spot_base("BTCEUR"))) == "symbol_unavailable", "paper spot with a non-USDT quote")
led = {"cash": 10.0, "spot": {}, "positions": {}, "protective": {}}
check(kind(raises(lambda: pp._fill_spot(led, {"symbol": "BTCUSDT", "side": "buy"}, 1.0, 100.0, 0.001))) == "insufficient_margin"
      and kind(raises(lambda: pp._fill_spot(led, {"symbol": "BTCUSDT", "side": "sell"}, 1.0, 100.0, 0.001))) == "insufficient_margin",
      "paper spot: not enough cash to buy / coin to sell")

# enumeration: every code a lib classifies maps to a real kind; every credential code tags as a key rejection
tables = {"binance": bn._REJECT_CODES, "okx": okx._REJECT_CODES, "gateio": gt._REJECT_CODES, "bybit": by._REJECT_CODES}
check(all(k in R.KINDS for t in tables.values() for k in t.values()), "every classified code maps to one of the six kinds")
check(all(R.credential_codes(v) and all(R.from_code(c, {}, R.credential_codes(v)) == R.KEY_PERMISSION for c in R.credential_codes(v))
          for v in ("binance", "okx", "gateio", "bingx", "bybit")), "each venue's account-lib credential codes → key_permission")

# order_errors.json: the 200-char cut keeps the token, even behind a caller's prefix
os.makedirs("manager", exist_ok=True)
long_msg = "x" * 400
portfolio._record_order_error("BTCUSDT", "binance", bn.BinanceError("-2019", long_msg, "/fapi/v1/order"))
portfolio._record_order_error("BTCUSDT", "binance", f"close_symbol: {bn.BinanceError(-2015, long_msg, '/fapi/v1/order')}")
rows = json.load(open("manager/order_errors.json")) if os.path.exists("manager/order_errors.json") else []
check(len(rows) == 2 and rows[0]["error"].startswith("[order_reject:insufficient_margin] Binance error -2019")
      and rows[1]["error"].startswith("[order_reject:key_permission] close_symbol: ") and all(len(r["error"]) <= 200 for r in rows),
      f"recorded errors start with the token and stay ≤ 200 chars ({[r['error'][:50] for r in rows]})")

# half-updated workspace: the order libs landed, lib/reject_token.py did not — orders must still work
import subprocess  # noqa: E402
HALF = r"""
import sys, os, tempfile
sys.path.insert(0, %r); os.chdir(tempfile.mkdtemp())
class _Block:
    def find_spec(self, name, path=None, target=None):
        if name == "lib.reject_token": raise ImportError("not landed")
sys.meta_path.insert(0, _Block())
import lib.order_binance as bn, lib.order_okx as okx, lib.order_gateio as gt, lib.order_bingx as bx, lib.order_bybit as by, lib.order_paper as pp, lib.order_capital as cap
import lib.portfolio as portfolio
e = [bn.BinanceError("-2019", "m", "p"), okx.OKXError("51008", "m", "p"), gt.GateioError("BALANCE_NOT_ENOUGH", "m", "p"), bx.BingXError(100413, "m", "p"), by.BybitError("x", code=110007)]
assert all(not str(x).startswith("[order_reject:") for x in e), [str(x) for x in e]
bn.get_contract_rules = lambda env, s: {"active": True, "step": "0.001", "min_qty": 0.01, "min_notional": 5.0}
try: bn.format_qty({}, "BTCUSDT", 0.001)
except ValueError as v: assert "below exchange minimum" in str(v) and not str(v).startswith("[")
try: cap._alias_for_resolved("XX2610")
except ValueError as v: assert "not a TXF" in str(v)
assert portfolio._reject_front("x") == "x"
print("HALF OK")
""" % ROOT
out = subprocess.run([sys.executable, "-c", HALF], capture_output=True, text=True, cwd=ROOT)
check(out.returncode == 0 and "HALF OK" in out.stdout, "lib/reject_token.py missing (half-updated workspace): every order lib imports, errors build untagged, the size gates still raise ValueError"
      + ("" if out.returncode == 0 else " — " + (out.stderr or out.stdout)[-300:]))

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
