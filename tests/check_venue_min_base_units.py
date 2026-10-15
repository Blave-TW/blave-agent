"""Minimal check: the entry gate prices a venue's min qty as BASE units — no network.

OKX (min_sz × ct_val) and Gate.io (min contracts × multiplier) already return
min_qty in base units; lib/execute._venue_sizes_usd multiplied by contract_value
a second time, so OKX DOGE (ct_val 1000) gated entries at $836 instead of $10 and
a smaller allocation never opened. Runs the real order_okx / order_gateio
get_contract_rules with only their HTTP read stubbed, so a lib changing its unit
fails here too. Instrument rows are the venues' public specs as read 2026-10-15,
plus two synthetic ones whose true minimum sits above the $10 floor (one per
side of ct_val = 1) so the floor cannot hide the arithmetic.

Run: cd blave-agent && python3 tests/check_venue_min_base_units.py
"""
import os, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(tempfile.mkdtemp(prefix="venuemin-"))

from lib import execute, order_gateio, order_okx, venue_wiring  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


FLOOR = 10.0
OKX = {  # instId: (ctVal, minSz, lotSz, mark)
    "BTC-USDT-SWAP": ("0.01", "0.01", "0.01", 80833.1),
    "DOGE-USDT-SWAP": ("1000", "0.01", "0.01", 0.0796),
    "XRP-USDT-SWAP": ("100", "0.01", "0.01", 1.3021),
    "BIGCT-USDT-SWAP": ("1000", "1", "1", 0.08),      # synthetic: 1000 base, $80
    "SMALLCT-USDT-SWAP": ("0.01", "1", "1", 80000.0),  # synthetic: 0.01 base, $800
}
GATE = {  # contract: (quanto_multiplier, order_size_min, mark)
    "BTC_USDT": ("0.0001", 1, 80848.7),
    "ADA_USDT": ("10", 1, 0.2199),
}


def okx_send(method, path, env, params=None, **kw):
    ct, mn, lot, _ = OKX[params["instId"]]
    return [{"ctVal": ct, "minSz": mn, "lotSz": lot, "tickSz": "0.0001", "state": "live"}]


def gate_send(method, path, env, *a, **kw):
    mult, mn, _ = GATE[path.rsplit("/", 1)[1]]
    return {"quanto_multiplier": mult, "order_size_min": mn, "order_price_round": "0.0001"}


order_okx._send = okx_send
order_okx.get_mark_price = lambda env, sym: OKX[order_okx._swap_inst(sym)][3]
order_gateio._send = gate_send
order_gateio.get_mark_price = lambda env, sym: GATE[order_gateio._contract(sym)][2]
venue_wiring.read_env = lambda: {}
_venue = {"id": None}
venue_wiring.detect_venue = lambda env: _venue["id"]


def sizes(vid, symbol):
    _venue["id"] = vid
    return execute._venue_sizes_usd(symbol, FLOOR)


def expect(vid, symbol, base_min, mark, lot_base):
    entry, lot = sizes(vid, symbol)
    want = max(FLOOR, base_min * mark * 1.05)
    check(abs(entry - want) < 1e-6, f"{vid} {symbol}: entry gate {entry:.2f} = max($10, "
          f"{base_min:g} base × {mark:g} × 1.05) = {want:.2f}")
    check(abs(lot - lot_base * mark) < 1e-9, f"{vid} {symbol}: lot ${lot:.4f} unchanged "
          f"(step × contract_value × mark)")


expect("okx", "BTCUSDT", 0.0001, 80833.1, 0.0001)
expect("okx", "DOGEUSDT", 10.0, 0.0796, 10.0)
expect("okx", "XRPUSDT", 1.0, 1.3021, 1.0)
expect("okx", "BIGCTUSDT", 1000.0, 0.08, 1000.0)      # $84, not $84,000
expect("okx", "SMALLCTUSDT", 0.01, 80000.0, 0.01)     # $840, not the $10 floor
expect("gateio", "BTCUSDT", 0.0001, 80848.7, 0.0001)
expect("gateio", "ADAUSDT", 10.0, 0.2199, 10.0)
check(sizes("okx", "DOGEUSDT")[0] == FLOOR, "OKX DOGE (ct_val 1000) gates at the $10 floor, not $836")
check(sizes(None, "DOGEUSDT") == (FLOOR, 0.0), "no venue bound: the floor, no lot")

print("\nall ok" if not fails else f"\n{fails} FAILED")
sys.exit(1 if fails else 0)
