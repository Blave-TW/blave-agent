"""Paper fills at the market's latest price, not the strategy's own data (lib/paper_data).

Each market reads its own feed — crypto Binance's last trade, TAIFEX the 1m near-month
series, US stocks Yahoo's unadjusted close — even when a strategy trading the symbol
would hand back another price; a feed that cannot answer means no fill.

Run: cd blave-agent && .venv/bin/python tests/check_paper_market_price.py
"""
import json, os, sys, tempfile, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(tempfile.mkdtemp(prefix="paper-market-"))
os.makedirs("state", exist_ok=True)


def _no_network(event, args):
    if event in ("socket.connect", "socket.getaddrinfo"):
        raise PermissionError(f"no network in this test ({event})")


sys.addaudithook(_no_network)

import pandas as pd  # noqa: E402
import requests  # noqa: E402
from requests.models import Response  # noqa: E402
from lib import data, order_paper, paper_data  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


OWNER_PX = 1.0  # what every strategy's own fetch_data says — never the paper price here


def strategy(name, symbol, extra=""):
    os.makedirs(f"strategies/{name}", exist_ok=True)
    open(f"strategies/{name}/strategy.py", "w").write(f'''SYMBOL = {symbol!r}
INTERVAL = "4h"
{extra}

def fetch_data(hdrs):
    import pandas as pd
    return pd.DataFrame({{"Close": [{OWNER_PX}]}}, index=[pd.Timestamp("2026-01-01")])
''')


strategy("btc", "BTCUSDT")
strategy("nvda", "NVDAUSDT")
strategy("okxonly", "OKXONLYUSDT")
strategy("tmf", "TMF")
strategy("cl", "CLFUT")
strategy("aapl", "AAPL", "from lib.data import fetch_usstock_price")

hits, BINANCE, TAIFEX = [], {}, {}  # symbol → price (None = not listed / empty series)
BINANCE_DOWN = [False]


def answer(req, status, body):
    r = Response()
    r.status_code, r._content = status, json.dumps(body).encode()
    r.url, r.request = req.url, req
    return r


def send(adapter, req, **kw):
    from urllib.parse import parse_qs, urlsplit
    u = urlsplit(req.url)
    hits.append((u.netloc, u.path))
    if u.netloc == "fapi.binance.com" and u.path == "/fapi/v1/ticker/price":
        if BINANCE_DOWN[0]:
            raise requests.exceptions.ConnectionError("[canned] Binance unreachable")
        sym = parse_qs(u.query)["symbol"][0]
        if BINANCE.get(sym) is None:
            return answer(req, 400, {"code": -1121, "msg": "Invalid symbol."})
        return answer(req, 200, {"symbol": sym, "price": str(BINANCE[sym]), "time": 0})
    if u.path.startswith("/studio/market/twfutures/ohlcv/"):
        code, schema = u.path.split("/")[-2:]
        px = TAIFEX.get((code, schema))
        rows = [] if px is None else [{"ts": "2026-10-20T05:00:00Z", "open": px, "high": px, "low": px,
                                       "close": px, "volume": 1}]
        return answer(req, 200, {"data": rows})
    raise AssertionError(f"unexpected request {req.url}")


requests.adapters.HTTPAdapter.send = send
kline_calls = []
data.fetch_kline = lambda sym, *a, **k: kline_calls.append(sym) or pd.DataFrame(
    {"Close": [77.0]}, index=[pd.Timestamp.now().floor("min")])


KEY = {"blave_api_key": "k", "blave_secret_key": "s"}


def price(sym, env=KEY):
    paper_data._price_cache.clear()
    del hits[:]
    try:
        return paper_data.current_price(sym, env)
    except paper_data.PaperNoPrice as e:
        return e


print("== crypto: Binance USDT-M last trade, not the strategy's 4h close")
BINANCE.update(BTCUSDT=81882.7, NVDAUSDT=218.1)
check(price("BTCUSDT") == (81882.7, None), "BTCUSDT fills at Binance's last trade")
check(hits == [("fapi.binance.com", "/fapi/v1/ticker/price")], f"one ticker request ({hits})")
check(price("NVDAUSDT") == (218.1, None), "a stock perp is crypto: Binance's last trade")
check(price("btc_usdt")[0] == 81882.7, "a venue spelling is normalised before asking")
import logging  # noqa: E402
last_resort = []
paper_data.log.addHandler(type("H", (logging.Handler,), {"emit": lambda self, r: last_resort.append(r.getMessage())})())
r = price("NEWUSDT")
check(isinstance(r, paper_data.PaperNoPrice) and not kline_calls,
      f"not on Binance (-1121), no strategy trades it: no price, Blave not asked ({r!r}, {kline_calls})")
del last_resort[:]
check(price("OKXONLYUSDT") == (OWNER_PX, "okxonly") and not kline_calls,
      "an OKX/BingX-only coin: its strategy's own close, Blave not asked (it only carries Binance)")
check(any("OKXONLYUSDT" in m and "own latest close" in m for m in last_resort),
      f"…and the last resort says so in the log ({last_resort})")
BINANCE_DOWN[0] = True
check(price("BTCUSDT") == (77.0, None) and kline_calls == ["BTCUSDT"],
      "Binance unreachable: the same market's latest 1m bar via Blave")
check(price("NVDAUSDT") == (77.0, None) and not hits,
      f"…and the next symbol does not wait on Binance again ({hits})")
del kline_calls[:]
check(price("BTCUSDT", {}) == (OWNER_PX, "btc") and not kline_calls,
      "Binance blocked and no Blave key (desktop): the strategy's own close, Blave not asked")
data.fetch_kline = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("blave down"))
check(price("BTCUSDT") == (OWNER_PX, "btc"), "Binance and Blave both down: the strategy's own close")
r = price("SOLUSDT")
check(isinstance(r, paper_data.PaperNoPrice), f"…no strategy trades it either: no price ({r!r})")
BINANCE_DOWN[0] = False
paper_data._binance_down_at[0] = 0.0

print("== TAIFEX: the 1m near-month series, not the strategy's bar")
TAIFEX[("TXF", "1m")] = 23456.0
for sym in ("TXF", "TMF", "MXFR1"):
    check(price(sym) == (23456.0, None), f"{sym} fills at the TXF series' latest minute")
check(hits[-1] == ("api.blave.org", "/studio/market/twfutures/ohlcv/TXF/1m"), f"asked TXF 1m ({hits})")
TAIFEX[("CDF", "1d")] = 1100.0
check(price("CDF") == (1100.0, None), "a stock future without a minute series: its latest daily close")
del TAIFEX[("TXF", "1m")]
r = price("TXF")
check(isinstance(r, paper_data.PaperNoPrice) and len(hits) == len(paper_data._TAIFEX_WINDOWS_D),
      f"an empty series over every window: no price, never the strategy's ({r!r}, {len(hits)} asks)")
os.environ["BLAVE_DATA_ACCESS"] = "0"
public = []
data.tw_market_public_allowed = lambda: True
data.fetch_txf_daily_public = lambda start, end, symbol: public.append(symbol) or pd.DataFrame(
    {"Close": [23000.0]}, index=[pd.Timestamp("2026-10-19", tz="Asia/Taipei")])
check(price("TMF") == (23000.0, None) and public == ["TMF"],
      "no Blave data access on the desktop: TAIFEX's own daily close")
r = price("CDF")
check(isinstance(r, paper_data.PaperNoPrice), f"…a stock future has no such fallback ({r!r})")
del os.environ["BLAVE_DATA_ACCESS"]

print("== US stocks: Yahoo's unadjusted close, only for a symbol a US strategy reads")
us_calls = []
real_us_daily = data._usstock_daily
data._usstock_daily = lambda sym, end: us_calls.append(sym) or pd.DataFrame(
    {"Close": [250.0], "AdjClose": [240.0]}, index=[pd.Timestamp("2026-10-19")])
check(price("AAPL") == (250.0, None), "AAPL fills at the unadjusted close (250), not AdjClose (240)")
r = price("MSFT")
check(isinstance(r, paper_data.PaperNoPrice) and us_calls == ["AAPL"],
      f"a ticker no US strategy reads is not asked from Yahoo ({r!r})")
data._usstock_daily = real_us_daily
os.environ.update(BLAVE_AGENT_LOCAL="1", BLAVE_MODE="live")
r = price("AAPL")
check(isinstance(r, paper_data.PaperNoPrice) and "go live" in str(r),
      f"a live tick: lib.data refuses Yahoo, so no price and no request ({r!r})")
del os.environ["BLAVE_AGENT_LOCAL"], os.environ["BLAVE_MODE"]

print("== anything else: the owning strategy's own series")
check(price("CLFUT") == (OWNER_PX, "cl"), "a CME future the strategy reads via fetch_db_kline")
check(isinstance(price("ZZZ"), paper_data.PaperNoPrice), "no market, no owner: no price")

print("== no price: no fill")
ENV = {"PAPER_API_KEY": "paper", "PAPER_SECRET_KEY": "paper", "PAPER_BOUND_TS": "1",
       "PAPER_INITIAL_EQUITY": "100000"}
paper_data._price_cache.clear()
before = order_paper.snapshot(ENV)
try:
    order_paper.place_market_order(ENV, "NEWUSDT", "long", 1.0)
    refused = False
except order_paper.PaperError:
    refused = True
after = order_paper.snapshot(ENV)
check(refused and after["positions"] == before["positions"] and after["cash"] == before["cash"],
      "an entry on an unpriceable symbol is refused and books nothing")
paper_data._price_cache.clear()
order_paper.place_market_order(ENV, "BTCUSDT", "long", 0.1)
row = json.load(open(order_paper.LEDGER_PATH))["positions"]["BTCUSDT"]
check(row["entry"] == 81882.7, f"the fill books the Binance price ({row['entry']})")

print()
print("PASS" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
