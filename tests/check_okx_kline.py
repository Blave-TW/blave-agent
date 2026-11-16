"""lib/data.py › fetch_okx_kline against OKX pages synthesised in the live reply's shape, no network.

  - lib intervals map to OKX bars that open at UTC (1d → 1Dutc), 8h / 3d refused
  - paging walks back with `after` (newest first, 300 per page), stitches, cuts at start
  - Volume is coins: volCcy on a swap, vol on spot
  - a row OKX marks confirm "0" (still forming) is dropped, whatever the local clock says
  - a non-"0" code raises; a pre-listing window is an empty frame
  - every SYMBOL form resolves to the instId lib/order_okx orders (one shared mapping); a
    hand-typed instId is refused on both sides; spot only through market='spot'
  - 1000PEPEUSDT (no OKX contract) is refused by the bars and by the order lib
  - fetch_okx_kline goes through the monthly cache under the resolved instId

Run: cd blave-agent && .venv/bin/python tests/check_okx_kline.py
"""
import os
import sys
import tempfile
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("MPLBACKEND", "Agg")

import pandas as pd

import lib.data as D

D._okx_inst("XAUUSDT")
# importing lib/order_okx marks the process a money process (lib/guard) — the bars path must not
BARS_PATH_LOADED_ORDER_LIB = "lib.order_okx" in sys.modules
from lib import order_okx  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


H = 3600_000
LISTED = int(pd.Timestamp("2026-08-30", tz="UTC").timestamp() * 1000)
NOW = int(pd.Timestamp("2026-10-15", tz="UTC").timestamp() * 1000)


class Resp:
    status_code = 200
    text = ""

    def __init__(self, body):
        self._body = body

    def json(self):
        return self._body

    def raise_for_status(self):
        pass


calls = []
mode = {"code": "0"}
FORMING = [None]   # the ts OKX marks confirm "0" (still forming)


def fake_get(url, params=None, **k):
    if "okx.com" not in url:
        raise AssertionError(f"unexpected request {url}")
    calls.append(dict(params))
    if mode["code"] != "0":
        return Resp({"code": mode["code"], "msg": "Instrument ID doesn't exist.", "data": []})
    after = int(params["after"])
    step = H if params["bar"] == "1H" else 24 * H
    newest = min(after - 1, NOW) // step * step
    page = []
    t = newest
    while t >= LISTED and len(page) < int(params["limit"]):
        # ts, o, h, l, c, vol (contracts), volCcy (coins), volCcyQuote, confirm
        page.append([str(t), "100", "102", "99", "101", "5000", "5", "505",
                     "0" if t == FORMING[0] else "1"])
        t -= step
    return Resp({"code": "0", "msg": "", "data": page})


D.requests.get = fake_get
D.time.sleep = lambda s: None
D._CACHE_DIR = Path(tempfile.mkdtemp())


class Count:
    n = 0

    def acquire(self):
        Count.n += 1


D._OKX_LIMITER = Count()

# ── intervals ──
check(D._OKX_INTERVALS["1d"] == "1Dutc" and D._OKX_INTERVALS["1h"] == "1H"
      and D._OKX_INTERVALS["4h"] == "4H" and D._OKX_INTERVALS["1w"] == "1Wutc",
      "1d → 1Dutc (UTC open, not OKX's UTC+8 1D), hours uppercase")
for iv in ("8h", "3d"):
    try:
        D._fetch_okx_kline_raw("XAU-USDT-SWAP", iv, "2026-09-01", "2026-09-02")
        check(False, f"{iv} refused")
    except ValueError as e:
        check(iv in str(e), f"{iv} refused (no 8-hour bar; 3Dutc starts on other days than Binance's 3d)")

# ── paging ──
calls.clear()
df = D._fetch_okx_kline_raw("XAU-USDT-SWAP", "1h", "2026-09-01", "2026-10-01")
want = pd.date_range("2026-09-01", "2026-09-30 23:00", freq="1h", tz="UTC")
check(len(calls) == 3 and all(c["limit"] == 300 and c["bar"] == "1H" for c in calls),
      f"720 hourly bars take three 300-bar pages ({len(calls)})")
check(calls[0]["after"] == int(pd.Timestamp("2026-10-01", tz="UTC").timestamp() * 1000),
      "first page asks for bars before the exclusive end")
check(all(int(b["after"]) < int(a["after"]) for a, b in zip(calls, calls[1:])),
      "each next page is older (`after` = previous page's oldest ts)")
check(df.index.equals(want), f"stitched, sorted, no gap or duplicate, cut at start ({df.index[0]} … {df.index[-1]})")
check(list(df.columns) == ["Open", "High", "Low", "Close", "Volume"] and (df.dtypes == float).all(),
      "the five float columns every lib consumer reads")
check((df["Volume"] == 5.0).all(), "swap Volume = volCcy (coins), not vol (contracts)")
check(Count.n == len(calls), "every page waits on the OKX limiter")

FORMING[0] = int(pd.Timestamp("2026-09-30 23:00", tz="UTC").timestamp() * 1000)
unconfirmed = D._fetch_okx_kline_raw("XAU-USDT-SWAP", "1h", "2026-09-01", "2026-10-01")
FORMING[0] = None
check(unconfirmed.index.equals(want[:-1]),
      f"a row with confirm \"0\" (forming) is dropped whatever the clock says ({unconfirmed.index[-1]})")

spot = D._fetch_okx_kline_raw("BTC-USDT", "1d", "2026-09-01", "2026-09-03", spot=True)
check(len(spot) == 2 and (spot["Volume"] == 5000.0).all(), "spot Volume = vol (already coins)")

# ── stop conditions ──
calls.clear()
pre = D._fetch_okx_kline_raw("XAU-USDT-SWAP", "1h", "2026-01-01", "2026-02-01")
check(pre.empty and list(pre.columns) == ["Open", "High", "Low", "Close", "Volume"] and len(calls) == 1,
      "a window before listing: one empty page, an empty frame, no error")
mode["code"] = "51001"
try:
    D._fetch_okx_kline_raw("NOPE-USDT-SWAP", "1h", "2026-09-01", "2026-09-02")
    check(False, "a non-\"0\" code raises")
except RuntimeError as e:
    check("51001" in str(e), f"a non-\"0\" code raises with the code ({e})")
mode["code"] = "0"

check(not BARS_PATH_LOADED_ORDER_LIB, "resolving an instId for bars does not import lib/order_okx")

# ── symbol → instId: the bars and the orders resolve every form to the same contract ──
for sym, want in (("BTCUSDT", "BTC-USDT-SWAP"), ("btcusdc", "BTC-USDC-SWAP"),
                  ("XAUUSDT", "XAU-USDT-SWAP"),        # TradFi: Binance COMMODITY, OKX instCategory 4
                  ("QNTUSDT", "QNT-USDT-SWAP"),        # a coin on Binance, a stock on OKX
                  ("NVDAUSDT", "NVDA-USDT-SWAP"),      # a stock on both
                  ("1000PEPEUSDT", "1000PEPE-USDT-SWAP"),  # no such OKX contract: both sides fail on it
                  ("BTC-USDT", "BTC-USDT-SWAP")):      # a dash does not make it spot
    check(D._okx_inst(sym) == order_okx._swap_inst(sym) == want, f"{sym}: bars and orders → {want}")
    check(D._okx_inst(sym, "spot") == order_okx._spot_inst(sym), f"{sym} market='spot': the same spot pair both sides")
for bad in ("XAU-USDT-SWAP", "BTC-USDT-SWAP"):
    try:
        order_okx._swap_inst(bad)
        order_side = None
    except ValueError as e:
        order_side = e
    try:
        D._okx_inst(bad)
        check(False, f"{bad}: refused by the bars side")
    except ValueError as e:
        check(order_side is not None and "dashless" in str(e),
              f"{bad}: refused on both sides, the bars side names the dashless form ({e})")

# ── 1000PEPEUSDT on OKX: refused, never traded as something else ──
mode["code"] = "51001"
try:
    D.fetch_okx_kline("1000PEPEUSDT", "1h", "2026-09-01", "2026-09-02")
    check(False, "1000PEPEUSDT bars: refused")
except RuntimeError as e:
    check("1000PEPE-USDT-SWAP" in str(e), f"1000PEPEUSDT bars: OKX has no such instId, raises ({e})")
mode["code"] = "0"
order_okx._send = lambda *a, **k: []          # /public/instruments answers no row for it
order_okx._rules_cache.clear()
try:
    order_okx.get_contract_rules({}, "1000PEPEUSDT")
    check(False, "1000PEPEUSDT orders: refused")
except order_okx.OKXError as e:
    check("symbol_unavailable" in str(e), f"1000PEPEUSDT orders: no instrument, symbol_unavailable ({e})")

# ── through the cache ──
got = D.fetch_okx_kline("XAUUSDT", "1h", "2026-09-01", "2026-09-03")
check(got.index.equals(pd.date_range("2026-09-01", "2026-09-03 23:00", freq="1h")),
      f"fetch_okx_kline returns the window (end day inclusive), naive UTC ({got.index[0]} … {got.index[-1]})")
check((D._CACHE_DIR / "okx_kline_1h_XAU-USDT-SWAP" / "2026-09.parquet").exists(),
      "cached under the resolved instId")
check(D._settle_delay("okx_kline_1h_XAU-USDT-SWAP") == D._CRYPTO_GRACE, "on the crypto month-settle clock")

sys.exit(1 if fails else 0)
