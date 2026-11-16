"""instrument_gate: an entry into a stock swap is refused when Binance (the strategy's data)
has the same symbol as a coin — no network. On OKX, which names its class, coin / stock /
commodity are each compared. A strategy on the venue's own bars (kline_venue: fetch_okx_kline
on OKX) is not compared with Binance at all — a templated one too (its own `def fetch_data` is
no fetcher); a mix, a helper on Binance bars, an unknown fetch_*, bars read any other way
(an outside import, a private lib.data name, getattr, a URL) or anything unreadable is.
1000PEPEUSDT (no OKX contract) fails before any order. Gate.io, Bybit and Bitget compare a
stock with Binance's class too; only OKX refuses a ticker Binance does not list.

The libs' real get_contract_rules run with only their HTTP read stubbed, so a lib that stops
reading its venue's class field fails here. Real rows are the venues' public replies as read
2026-10-19 (OKX BB-USDT-SWAP instCategory 3, Bybit ONUSDT symbolType stock, Gate PAXG_USDT
contract_type metals; 2026-10-28 Bitget v3 PAXGUSDT metal/metal while v2 isRwa is YES,
BHPUSDT and MDTUSDT crypto/stock, v3 code 25100 for a symbol it does not list); XYZ / ETFX / USO / SOFTBANK and Bitget BB as a stock are synthetic,
one per branch. The mirror (Binance US stock, venue coin) is refused too. Unreadable on
either side must allow, and a close must always pass — at the gate and through dispatch_order.
Run: cd blave-agent && .venv/bin/python tests/check_instrument_gate.py
"""
import os, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(tempfile.mkdtemp(prefix="instgate-"))

from lib import execute, order_bitget, order_bybit, order_gateio, order_okx, venue_wiring as vw  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


BINANCE = {"BTCUSDT": "COIN", "BBUSDT": "COIN", "ONUSDT": "COIN", "PAXGUSDT": "COIN",
           "XYZUSDT": "COIN", "ETFXUSDT": "COIN", "NVDAUSDT": "EQUITY",
           "USOUSDT": "COMMODITY", "SOFTBANKUSDT": "JP_EQUITY", "MIRRUSDT": "EQUITY",
           "BHPUSDT": "COIN", "MDTUSDT": "EQUITY", "NEWUSDT": "COIN"}
binance_up = [True]


class _Resp:
    def raise_for_status(self):
        pass

    def json(self):
        return {"symbols": [{"symbol": s, "underlyingType": t} for s, t in BINANCE.items()]}


def _get(url, timeout=None):
    if not binance_up[0]:
        raise ConnectionError("stub: Binance down")
    return _Resp()


import requests  # noqa: E402
requests.get = _get

OKX = {"BTC-USDT-SWAP": "1", "BB-USDT-SWAP": "3", "NVDA-USDT-SWAP": "3", "QNT-USDT-SWAP": None,
       "USO-USDT-SWAP": "3", "SOFTBANK-USDT-SWAP": "3", "MIRR-USDT-SWAP": "1",
       # 2026-11-14 public lists: ON stock on OKX / coin on Binance; XAU 4 / COMMODITY on both.
       # GOLDX / COMX are synthetic (commodity vs coin, coin vs commodity)
       "ON-USDT-SWAP": "3", "XAU-USDT-SWAP": "4", "GOLDX-USDT-SWAP": "4", "COMX-USDT-SWAP": "1",
       "PEPE-USDT-SWAP": "1"}   # Binance lists PEPE only as 1000PEPEUSDT
BINANCE.update({"XAUUSDT": "COMMODITY", "GOLDXUSDT": "COIN", "COMXUSDT": "COMMODITY",
                "1000PEPEUSDT": "COIN", "QNTUSDT": "COIN"})
def _okx_send(m, p, env, body=None, params=None, retries=3):
    if params["instId"] not in OKX:   # 1000PEPE-USDT-SWAP: as live, the ticker 51001s, instruments has no row
        if "instruments" in p:
            return []
        raise order_okx.OKXError("51001", "Instrument ID doesn't exist.", p)
    return [dict({"ctVal": "1", "lotSz": "0.01", "minSz": "0.01", "tickSz": "0.01", "state": "live",
                  "last": "8.0"},
                 **({} if OKX[params["instId"]] is None else {"instCategory": OKX[params["instId"]]}))]


order_okx._send = _okx_send
order_bybit._public = lambda env, path, params: {"list": [{
    "lotSizeFilter": {"qtyStep": "0.1", "minOrderQty": "0.1"}, "priceFilter": {"tickSize": "0.0001"},
    "symbolType": {"ONUSDT": "stock", "ETFXUSDT": "ETF", "BTCUSDT": "", "PEPEUSDT": "",
                   "USOUSDT": "stock"}[params["symbol"]]}]}
order_gateio._send = lambda m, p, env, body=None, query="", retries=3: {
    "quanto_multiplier": "0.01", "order_size_min": 1,
    "contract_type": {"/futures/usdt/contracts/PAXG_USDT": "metals",
                      "/futures/usdt/contracts/XYZ_USDT": "stocks",
                      # synthetic: a per-coin PEPE (references/lib.md) and a stock vs Binance's commodity
                      "/futures/usdt/contracts/PEPE_USDT": "",
                      "/futures/usdt/contracts/USO_USDT": "stocks",
                      "/futures/usdt/contracts/GSTK_USDT": "stocks"}[p]}   # a stock Binance does not list

# Bitget: v2 rows carry isRwa (YES on all but BTC, PAXG included); the class is v3's
BITGET_V3 = {"PAXGUSDT": ("metal", "metal"), "NVDAUSDT": ("stock", "stock"),
             "BBUSDT": ("stock", "stock"), "BHPUSDT": ("crypto", "stock"),
             "BTCUSDT": ("crypto", "crypto"), "MDTUSDT": ("crypto", "stock")}
bitget_v3_up = [True]
v3_calls = []


def _bitget_public(path, params=None):
    if path == "/api/v2/mix/market/contracts":
        return [{"symbol": params["symbol"], "isRwa": "NO" if params["symbol"] == "BTCUSDT" else "YES",
                 "symbolType": "perpetual", "symbolStatus": "normal", "sizeMultiplier": "0.001",
                 "minTradeNum": "0.001", "minTradeUSDT": "5", "pricePlace": "2", "priceEndStep": "1"}]
    if path == "/api/v3/market/instruments" and params.get("category") == "USDT-FUTURES":
        v3_calls.append(params.get("symbol"))
        if not bitget_v3_up[0]:
            raise requests.exceptions.ConnectionError("stub: Bitget v3 down")
        rows = [{"symbol": s, "baseCoin": s[:-4], "symbolType": st, "instrumentType": it}
                for s, (st, it) in BITGET_V3.items() if params.get("symbol") in (None, s)]
        if not rows:
            raise order_bitget.BitgetError(f"Trading pair {params['symbol']} does not exist", code="25100")
        return rows
    raise AssertionError(f"unstubbed Bitget call {path} {params}")


order_bitget.acct.public = _bitget_public

venue = ["okx"]
vw.read_env = lambda path=".env": {}
vw.detect_venue = lambda env: venue[0]


def refused(symbol, reduce_only=False, gate=vw.instrument_gate, contributors=None):
    try:
        gate(symbol, reduce_only, contributors)
    except RuntimeError as e:
        return str(e)
    return None


msg = refused("BBUSDT")
check(msg == "交易所上的 BBUSDT（OKX）是股票合約，策略的 K 線（Binance BBUSDT）是加密幣，不是同一種合約，已擋下",
      f"OKX BB-USDT-SWAP (stock) vs Binance BBUSDT (coin): refused, names the bars, no reject token ({msg})")
check(refused("BTCUSDT") is None, "OKX BTC (crypto): allowed")
check(refused("NVDAUSDT") is None, "OKX NVDA stock, Binance NVDAUSDT stock too: allowed")
check(refused("USOUSDT") is not None, "OKX stock vs Binance COMMODITY: refused (OKX names its class)")
check(refused("SOFTBANKUSDT") is None, "OKX stock vs Binance JP_EQUITY (a stock too): allowed")
check(refused("QNTUSDT") is None, "OKX row without instCategory: allowed")
msg = refused("MIRRUSDT")
check(msg == "交易所上的 MIRRUSDT（OKX）是加密幣，策略的 K 線（Binance MIRRUSDT）是股票合約，不是同一種合約，已擋下",
      f"OKX coin vs Binance US stock (the mirror): refused ({msg})")
check(refused("XAUUSDT") is None, "OKX XAU (commodities) vs Binance XAUUSDT (COMMODITY): allowed")
check(refused("GOLDXUSDT") is not None, "OKX commodity vs Binance coin: refused")
check(refused("COMXUSDT") is not None, "OKX coin vs Binance COMMODITY: refused")
check(refused("ONUSDT") is not None, "OKX ON (stock) vs Binance ONUSDT (coin), Binance bars: refused")

# whose bars: the strategies behind the order (kline_venue)
STRATS = {"okx_bars": "from lib.data import fetch_okx_kline\ndf = fetch_okx_kline(SYMBOL, '1h', S, None)\n",
          "bn_bars": "from lib.data import fetch_kline\ndf = fetch_kline(SYMBOL, '1h', S, None, h)\n",
          "bingx_bars": "from lib.data import fetch_bingx_kline\ndf = fetch_bingx_kline(SYMBOL, '1h', S, None)\n",
          "okx_plus_helper": "from lib.data import fetch_okx_kline\n",
          "okx_whale": "from lib.data import fetch_okx_kline, fetch_whale_hunter\n"
                       "df = fetch_okx_kline(SYMBOL, '1h', S, None)\nw = fetch_whale_hunter(SYMBOL, '1h', S, None, h)\n",
          "okx_commented": "from lib.data import fetch_okx_kline\n# was: fetch_kline(SYMBOL, '1h', S, None, h)\n",
          "broken": "def (:\n"}
# the template's shape (examples/btc_sma_cross, its fetcher swapped): `def fetch_data` is the
# strategy's own function, not a lib.data fetcher
TEMPLATE = (open(os.path.join(ROOT, "examples", "btc_sma_cross", "strategy.py"), encoding="utf-8").read()
            .replace("from lib.data import fetch_kline", "from lib.data import {imp}")
            .replace("df = fetch_kline(SYMBOL, INTERVAL, START, END, hdrs)", "{body}"))
assert "def fetch_data(hdrs):" in TEMPLATE and "{body}" in TEMPLATE


def tpl(imp, body):
    return TEMPLATE.replace("{imp}", imp).replace("{body}", body)


STRATS.update({
    "tpl_okx": tpl("fetch_okx_kline", "df = fetch_okx_kline(SYMBOL, INTERVAL, START, END)"),
    "tpl_mixed": tpl("fetch_okx_kline, fetch_kline",
                     "df = fetch_okx_kline(SYMBOL, INTERVAL, START, END)\n"
                     "    ref = fetch_kline('BTCUSDT', INTERVAL, START, END, hdrs)"),
    "tpl_unknown": tpl("fetch_okx_kline, fetch_my_feed",
                       "df = fetch_okx_kline(SYMBOL, INTERVAL, START, END)\n"
                       "    ds = fetch_my_feed(SYMBOL)"),
    "tpl_alias": tpl("fetch_okx_kline, fetch_kline as bars",
                     "df = fetch_okx_kline(SYMBOL, INTERVAL, START, END)\n"
                     "    ref = bars('BTCUSDT', INTERVAL, START, END, hdrs)"),
    "tpl_attr": tpl("fetch_okx_kline\n    from lib import data",
                    "df = fetch_okx_kline(SYMBOL, INTERVAL, START, END)\n"
                    "    ref = data.fetch_kline('BTCUSDT', INTERVAL, START, END, hdrs)"),
    "tpl_getattr": tpl("fetch_okx_kline\n    from lib import data",
                       "df = getattr(data, 'fetch_kline')(SYMBOL, INTERVAL, START, END, hdrs)"),
    "tpl_shadow": tpl("fetch_kline",
                      "df = fetch_okx_kline(SYMBOL)\n    return df\n\n\ndef fetch_okx_kline(sym):\n"
                      "    return fetch_kline(sym, INTERVAL, START, END, {})"),
    "tpl_requests": tpl("fetch_okx_kline\n    import requests",
                        "df = fetch_okx_kline(SYMBOL, INTERVAL, START, END)"),
    # bars read without naming a lib.data fetcher (audit 2026-11-16 B-S1): each must stay binance
    "tpl_outside": tpl("fetch_okx_kline\n    from strategies_shared.bars import ref_bars",
                       "df = fetch_okx_kline(SYMBOL, INTERVAL, START, END)\n"
                       "    ref = ref_bars('BTCUSDT')"),
    "tpl_private": tpl("fetch_okx_kline\n    from lib import data",
                       "df = fetch_okx_kline(SYMBOL, INTERVAL, START, END)\n"
                       "    ref = data._fetch_binance_kline_raw('BTCUSDT', INTERVAL, START, END)"),
    "tpl_private_from": tpl("fetch_okx_kline, _fetch_binance_kline_raw as raw",
                            "df = fetch_okx_kline(SYMBOL, INTERVAL, START, END)\n"
                            "    ref = raw('BTCUSDT', INTERVAL, START, END)"),
    "tpl_private_mod": tpl("fetch_okx_kline\n    import lib.data as d",
                           "df = fetch_okx_kline(SYMBOL, INTERVAL, START, END)\n"
                           "    ref = d._fetch_binance_kline_raw('BTCUSDT', INTERVAL, START, END)"),
    "tpl_getattr_join": tpl("fetch_okx_kline\n    from lib import data",
                            "df = fetch_okx_kline(SYMBOL, INTERVAL, START, END)\n"
                            "    ref = getattr(data, 'fetch_' + 'kline')('BTCUSDT', INTERVAL, START, END, hdrs)"),
    "tpl_read_url": tpl("fetch_okx_kline\n    import pandas as pd",
                        "df = fetch_okx_kline(SYMBOL, INTERVAL, START, END)\n"
                        "    ref = pd.read_json('https://fapi.binance.com/fapi/v1/klines?symbol=ONUSDT')"),
    "tpl_url_var": tpl("fetch_okx_kline\n    import pandas as pd",
                       "df = fetch_okx_kline(SYMBOL, INTERVAL, START, END)\n"
                       "    host = 'fapi.binance.com'\n"
                       "    ref = pd.read_csv(f'https://{host}/klines.csv')"),
    "tpl_paper_px": tpl("fetch_okx_kline\n    from lib.paper_data import current_price",
                        "df = fetch_okx_kline(SYMBOL, INTERVAL, START, END)\n"
                        "    px = current_price('BTCUSDT', {})"),
    "tpl_relative": tpl("fetch_okx_kline\n    from .. import shared_bars",
                        "df = fetch_okx_kline(SYMBOL, INTERVAL, START, END)"),
    # a stdlib / installed name the workspace root or a subfolder shadows (the template puts the
    # workspace first on sys.path), and a lib module's own import passed through
    "tpl_root_shadow": tpl("fetch_okx_kline\n    import signal",
                           "df = fetch_okx_kline(SYMBOL, INTERVAL, START, END)\n"
                           "    ref = signal.ref_bars('BTCUSDT')"),
    "tpl_sub_shadow": tpl("fetch_okx_kline\n    import json",
                          "df = fetch_okx_kline(SYMBOL, INTERVAL, START, END)\n"
                          "    ref = json.ref_bars('BTCUSDT')"),
    "tpl_lib_reexport": tpl("fetch_okx_kline\n    from lib.notify import requests",
                            "df = fetch_okx_kline(SYMBOL, INTERVAL, START, END)\n"
                            "    ref = requests.get(BASE + '/fapi/v1/klines').json()"),
    "tpl_lib_mod_attr": tpl("fetch_okx_kline\n    from lib import runner",
                            "df = fetch_okx_kline(SYMBOL, INTERVAL, START, END)\n"
                            "    ref = runner.pd.read_json(BASE + '/fapi/v1/klines')"),
    # still provably OKX: a sibling file read too, lib.data by public name, a link in a docstring
    "tpl_sibling": tpl("fetch_okx_kline\n    from okx_helper import add_bands",
                       "df = add_bands(fetch_okx_kline(SYMBOL, INTERVAL, START, END))"),
    "tpl_data_attr": '"""Notes: https://www.okx.com/docs-v5/en/"""\n'
                     + tpl("fetch_okx_kline\n    from lib import data",
                           "df = data.fetch_okx_kline(data.normalize_symbol(SYMBOL), INTERVAL, START, END)"),
})
for name, src in STRATS.items():
    os.makedirs(f"strategies/{name}", exist_ok=True)
    with open(f"strategies/{name}/strategy.py", "w", encoding="utf-8") as f:
        f.write(src)
with open("strategies/okx_plus_helper/helper.py", "w", encoding="utf-8") as f:
    f.write("from lib.data import fetch_kline\n")   # a helper on Binance bars: not all OKX
with open("strategies/tpl_sibling/okx_helper.py", "w", encoding="utf-8") as f:
    f.write("import numpy as np\n\n\ndef add_bands(df):\n    return df.assign(mid=np.nan)\n")
with open("signal.py", "w", encoding="utf-8") as f:   # at the workspace root, shadowing the stdlib
    f.write("from lib.data import fetch_kline\nref_bars = lambda s: fetch_kline(s, '1h', '2024-01-01', None, {})\n")
os.makedirs("strategies/tpl_sub_shadow/json", exist_ok=True)
with open("strategies/tpl_sub_shadow/json/__init__.py", "w", encoding="utf-8") as f:
    f.write("from lib.data import fetch_kline\nref_bars = lambda s: fetch_kline(s, '1h', '2024-01-01', None, {})\n")
os.makedirs("strategies_shared", exist_ok=True)   # beside the workspace: never read by kline_venue
for f in ("__init__.py", "bars.py"):
    with open(f"strategies_shared/{f}", "w", encoding="utf-8") as fh:
        fh.write("from lib.data import fetch_kline\nref_bars = lambda s: fetch_kline(s, '1h', '2024-01-01', None, {})\n"
                 if f == "bars.py" else "")
C = lambda *names: [{"strategy": n} for n in names]
check(vw.kline_venue(C("okx_bars")) == "okx" and vw.kline_venue(C("bingx_bars")) == "bingx"
      and vw.kline_venue(C("okx_commented")) == "okx",
      "kline_venue: a strategy on one venue's own bars → that venue (a commented-out fetch_kline aside)")
check(all(vw.kline_venue(c) == "binance" for c in (None, [], C("bn_bars"), C("okx_bars", "bn_bars"),
                                                   C("okx_plus_helper"), C("okx_whale"), C("broken"),
                                                   C("missing"))),
      "kline_venue: none / Binance bars / a mix / a helper on Binance / OKX bars + a Blave alpha / "
      "no fetcher / missing → binance")
check(vw.kline_venue(C("tpl_okx")) == "okx",
      "kline_venue: a templated strategy (def fetch_data calling fetch_okx_kline) → okx")
for name, why in (("tpl_mixed", "OKX bars + fetch_kline"), ("tpl_unknown", "OKX bars + an unknown fetch_*"),
                  ("tpl_alias", "fetch_kline under an alias"), ("tpl_attr", "data.fetch_kline"),
                  ("tpl_getattr", "getattr(data, 'fetch_kline')"),
                  ("tpl_shadow", "its own def fetch_okx_kline over Binance bars"),
                  ("tpl_requests", "a requests import")):
    check(vw.kline_venue(C(name)) == "binance", f"kline_venue: template with {why} → binance")
for name, why in (("tpl_outside", "a helper imported from outside its folder"),
                  ("tpl_private", "data._fetch_binance_kline_raw"),
                  ("tpl_private_from", "from lib.data import _fetch_binance_kline_raw"),
                  ("tpl_private_mod", "import lib.data as d; d._fetch_binance_kline_raw"),
                  ("tpl_getattr_join", "getattr(data, 'fetch_' + 'kline')"),
                  ("tpl_read_url", "pd.read_json(a Binance URL)"),
                  ("tpl_url_var", "an f-string URL"),
                  ("tpl_paper_px", "lib.paper_data prices"),
                  ("tpl_relative", "a relative import"),
                  ("tpl_root_shadow", "a workspace-root signal.py shadowing the stdlib"),
                  ("tpl_sub_shadow", "a json/ package in its folder shadowing the stdlib"),
                  ("tpl_lib_reexport", "from lib.notify import requests"),
                  ("tpl_lib_mod_attr", "runner.pd (lib.runner's own import)")):
    check(vw.kline_venue(C(name)) == "binance", f"kline_venue: OKX bars + {why} → binance (fail safe)")
sys.path.insert(0, os.getcwd())   # the helper importable, as a sys.path.insert in the strategy makes it
check(vw.kline_venue(C("tpl_outside")) == "binance",
      "kline_venue: a helper beside the workspace that resolves on sys.path → still binance")
sys.path.remove(os.getcwd())
check(vw.kline_venue(C("tpl_sibling")) == "okx" and vw.kline_venue(C("tpl_data_attr")) == "okx",
      "kline_venue: a sibling file (read too), data.<public fetcher> and a docstring link → still okx")
check(all(refused("ONUSDT", contributors=C(n)) is not None
          for n in ("tpl_outside", "tpl_private", "tpl_getattr_join", "tpl_read_url")),
      "ON on OKX, OKX bars + Binance bars read another way: compared — refused")
check(vw.kline_venue(C("tpl_okx", "okx_bars")) == "okx", "kline_venue: two strategies on OKX bars → okx")


def folder(name, files):
    os.makedirs(f"strategies/{name}", exist_ok=True)
    for fn, src in files.items():
        with open(f"strategies/{name}/{fn}", "w", encoding="utf-8") as fh:
            fh.write(src)


import logging  # noqa: E402


class _Logs(logging.Handler):
    lines = []

    def emit(self, record):
        self.lines.append(record.getMessage())


logging.getLogger().addHandler(_Logs())
TPL_OKX = STRATS["tpl_okx"]
# audit 2026-11-16 M1: strategy.py moved to OKX bars as the refusal says, the example scan.py
# beside it left on fetch_kline — still Binance bars, and the log names the file
SCAN = open(os.path.join(ROOT, "examples", "btc_sma_cross", "scan.py"), encoding="utf-8").read()
assert "fetch_kline(" in SCAN
folder("m1_scan_left", {"strategy.py": TPL_OKX, "scan.py": SCAN})
_Logs.lines.clear()
check(vw.kline_venue(C("m1_scan_left")) == "binance",
      "kline_venue: OKX strategy.py + the example scan.py still on fetch_kline → binance")
check(any("m1_scan_left/scan.py: fetch_kline" in m and "every .py" in m.lower() for m in _Logs.lines)
      and not any("m1_scan_left/strategy.py" in m for m in _Logs.lines),
      f"kline_venue: the log names scan.py and fetch_kline, not strategy.py ({_Logs.lines})")
msg = refused("PEPEUSDT", contributors=C("m1_scan_left"))
check(msg == "交易所上的 PEPEUSDT（OKX）在 Binance 沒有同名合約，只有 1000PEPEUSDT，已擋下。請 agent 改用 OKX 的 K 線重跑回測",
      f"PEPE on OKX, scan.py left on fetch_kline: refused with the same user sentence ({msg})")
folder("m1_scan_moved", {"strategy.py": TPL_OKX, "scan.py": SCAN.replace("fetch_kline", "fetch_okx_kline")
                         .replace("s.END, hdrs)", "s.END)")})
check(vw.kline_venue(C("m1_scan_moved")) == "okx", "kline_venue: scan.py moved to fetch_okx_kline too → okx")
_Logs.lines.clear()
vw.kline_venue(C("bn_bars"))
check(not _Logs.lines, f"kline_venue: a strategy on Binance bars alone logs nothing ({_Logs.lines})")

# audit 2026-11-16 S1: shapes the references lead to, provably OKX
META_URL = "改寫自 https://www.tradingview.com/script/abc/ 的均線策略"
with_meta = lambda line: TPL_OKX.replace("\nSYMBOL", f"\n{line}\nSYMBOL", 1)
assert with_meta("X = 1") != TPL_OKX
for name, files, why in (
        ("s1_desc_url", {"strategy.py": with_meta(f'DESCRIPTION = "{META_URL}"')}, "a URL in DESCRIPTION"),
        ("s1_logic_url", {"strategy.py": with_meta(f'LOGIC = """進場:均線交叉\n出處:{META_URL}"""')},
         "a URL in LOGIC"),
        ("s1_note_url", {"strategy.py": with_meta(f'VERSION_NOTE = "{META_URL}"')}, "a URL in VERSION_NOTE"),
        ("s1_desc_url_scan", {"strategy.py": with_meta(f'DESCRIPTION = "{META_URL}"'),
                              "scan.py": SCAN.replace("fetch_kline", "fetch_okx_kline").replace("s.END, hdrs)", "s.END)")},
         "a URL in DESCRIPTION, the example scan.py on OKX bars beside it"),
        ("s1_desc_url_validate", {"strategy.py": with_meta(f'DESCRIPTION = "{META_URL}"'),
                                  "validate.py": open(os.path.join(ROOT, "examples", "tw2317_broker_zscore", "validate.py"),
                                                      encoding="utf-8").read()},
         "a URL in DESCRIPTION, the example validate.py beside it"),
        ("s1_analysis", {"strategy.py": TPL_OKX,
                         "validate.py": "import strategy as s\nfrom lib.analysis import precise_pnl, compute_stats\n"},
         "validate.py importing lib.analysis"),
        ("s1_guard", {"strategy.py": TPL_OKX.replace("\nSYMBOL", "\nfrom lib.guard import halted_for\nSYMBOL", 1)},
         "from lib.guard import halted_for"),
        ("s1_execute", {"strategy.py": TPL_OKX.replace("\nSYMBOL", "\nfrom lib.execute import load_state\nSYMBOL", 1)},
         "from lib.execute import load_state")):
    folder(name, files)
    check(vw.kline_venue(C(name)) == "okx", f"kline_venue: OKX bars + {why} → okx")
# ...and each loosening stays fail safe: the metadata read anywhere, introspection, a URL
# elsewhere, other lib.guard / lib.execute names
for name, files, why in (
        ("s1_desc_read", {"strategy.py": with_meta(f'DESCRIPTION = "{META_URL}"')
                          + "\nimport pandas as pd\nref = pd.read_json(DESCRIPTION)\n"}, "pd.read_json(DESCRIPTION)"),
        ("s1_logic_attr", {"strategy.py": with_meta(f'LOGIC = "{META_URL}"'),
                           "scan.py": "import pandas as pd\nimport strategy as s\nref = pd.read_json(s.LOGIC)\n"},
         "scan.py reading s.LOGIC"),
        ("s1_note_import", {"strategy.py": with_meta(f'VERSION_NOTE = "{META_URL}"'),
                            "scan.py": "import pandas as pd\nfrom strategy import VERSION_NOTE as v\nref = pd.read_json(v)\n"},
         "scan.py importing VERSION_NOTE"),
        ("s1_star", {"strategy.py": with_meta(f'DESCRIPTION = "{META_URL}"'),
                     "scan.py": "from strategy import *\n"}, "scan.py star-importing strategy"),
        ("s1_globals", {"strategy.py": with_meta(f'DESCRIPTION = "{META_URL}"')
                        + "\nimport pandas as pd\nref = pd.read_json(globals()['DESCR' + 'IPTION'])\n"},
         "globals()[...]"),
        ("s1_getattr", {"strategy.py": with_meta(f'DESCRIPTION = "{META_URL}"'),
                        "scan.py": "import pandas as pd\nimport strategy as s\nref = pd.read_json(getattr(s, 'DESC' + 'RIPTION'))\n"},
         "getattr on the strategy module"),
        ("s1_own_run", {"strategy.py": with_meta(f'DESCRIPTION = "{META_URL}"').replace(
            "\nSYMBOL", "\nimport pandas as pd\n\n\ndef run(d, *a):\n    return pd.read_json(d['DESCR' + 'IPTION'])\n\n\nSYMBOL", 1)},
         "its own run(locals(), …)"),
        ("s1_dict", {"strategy.py": with_meta(f'DESCRIPTION = "{META_URL}"'),
                     "scan.py": "import strategy as s\nref = s.__dict__\n"}, "the strategy module's __dict__"),
        ("s1_other_url", {"strategy.py": with_meta(f'SOURCE = "{META_URL}"')}, "a URL in a non-metadata constant"),
        ("s1_meta_in_func", {"strategy.py": TPL_OKX + f'\n\ndef f():\n    DESCRIPTION = "{META_URL}"\n    return DESCRIPTION\n'},
         "a URL in a function-local DESCRIPTION"),
        ("s1_meta_expr", {"strategy.py": with_meta(f'DESCRIPTION = "x" + "{META_URL}"')},
         "DESCRIPTION built from a URL expression"),
        ("s1_guard_other", {"strategy.py": TPL_OKX.replace("\nSYMBOL", "\nfrom lib.guard import load_json\nSYMBOL", 1)},
         "from lib.guard import load_json"),
        ("s1_execute_other", {"strategy.py": TPL_OKX.replace("\nSYMBOL", "\nfrom lib.execute import dispatch_order\nSYMBOL", 1)},
         "from lib.execute import dispatch_order"),
        ("s1_execute_mod", {"strategy.py": TPL_OKX.replace("\nSYMBOL", "\nfrom lib import execute\nSYMBOL", 1)
                            + "\nx = execute.dispatch_order\n"}, "execute.dispatch_order")):
    folder(name, files)
    check(vw.kline_venue(C(name)) == "binance", f"kline_venue: OKX bars + {why} → binance (fail safe)")

# KNOWN_LIMITATION (Wei 2026-11-16: the check stays a blacklist): measured shapes that pass
# as OKX's own bars though they read Binance's. Pinned at today's 'okx' so a change shows
# here; listed in references/exchange-connect.md rule 7 and lib/venue_wiring._proves_nothing.
for name, line, why in (
        ("kl_local_file", "import pandas as pd\nref = pd.read_csv('tmp/onusdt_binance.csv')", "a local file"),
        ("kl_base", "import pandas as pd\nfrom lib.data import BASE\nref = pd.read_json(BASE + '/kline?symbol=ONUSDT')",
         "lib.data BASE"),
        ("kl_globals", "from lib.data import fetch_okx_kline as f\n"
                       "ref = f.__globals__['_fetch_binance_kline_raw']('ONUSDT', '1h', START, None)",
         "fetch_okx_kline.__globals__"),
        ("kl_sys_modules", "import sys\nref = sys.modules['lib.data']._fetch_binance_kline_raw('ONUSDT', '1h', START, None)",
         "sys.modules['lib.data']"),
        ("kl_runpy", "import runpy\nref = runpy.run_path('../shared/bars.py')['ref']", "runpy.run_path"),
        ("kl_spec", "import importlib.util\nspec = importlib.util.spec_from_file_location('b', '../shared/bars.py')",
         "importlib.util.spec_from_file_location")):
    folder(name, {"strategy.py": TPL_OKX + "\n" + line + "\n"})
    check(vw.kline_venue(C(name)) == "okx", f"KNOWN_LIMITATION kline_venue: OKX bars + {why} → okx (unchanged)")
for sym in ("ONUSDT", "PEPEUSDT", "BBUSDT"):
    check(refused(sym, contributors=C("tpl_okx")) is None,
          f"{sym} on OKX, a templated strategy on OKX bars: not compared — allowed")
check(refused("ONUSDT", contributors=C("tpl_mixed")) is not None
      and refused("PEPEUSDT", contributors=C("tpl_unknown")) is not None,
      "ON / PEPE on OKX, template mixing OKX bars with Binance bars or an unknown fetcher: compared — refused")
check(refused("ONUSDT", contributors=C("okx_whale")) is not None,
      "ON on OKX, OKX bars + whale hunter (computed from Binance): compared — refused")
check(refused("XAUUSDT", contributors=C("okx_whale")) is None,
      "XAU on OKX, OKX bars + whale hunter: compared, a commodity on both — allowed")
msg = refused("PEPEUSDT")
check(msg == "交易所上的 PEPEUSDT（OKX）在 Binance 沒有同名合約，只有 1000PEPEUSDT，已擋下。請 agent 改用 OKX 的 K 線重跑回測",
      f"PEPEUSDT on OKX, Binance bars (Binance has only 1000PEPEUSDT): refused, says why ({msg})")
OKX["SOLOX-USDT-SWAP"] = "1"   # synthetic: OKX lists it, Binance under no name or multiple
msg = refused("SOLOXUSDT")
check(msg == "交易所上的 SOLOXUSDT（OKX）在 Binance 沒有同名合約，已擋下。請 agent 改用 OKX 的 K 線重跑回測",
      f"SOLOXUSDT on OKX, Binance lists no multiple of it: refused, names no unrelated example ({msg})")
check(refused("PEPEUSDT", contributors=C("okx_bars")) is None,
      "PEPEUSDT on OKX, strategy on OKX's own bars: allowed")
for sym in ("BBUSDT", "ONUSDT", "QNTUSDT", "XAUUSDT", "GOLDXUSDT"):
    check(refused(sym, contributors=C("okx_bars")) is None,
          f"{sym} on OKX, strategy on OKX's own bars: not compared with Binance — allowed")
check(refused("BBUSDT", contributors=C("okx_bars", "bn_bars")) is not None,
      "BB on OKX, one strategy on OKX bars and one on Binance's: compared — refused")
check(refused("BBUSDT", contributors=C("bingx_bars")) is not None,
      "BB on OKX, strategy on BingX bars: compared with Binance as before — refused")
check(refused("BBUSDT", contributors=C("bn_bars")) is not None, "BB on OKX, Binance bars: refused")
check(refused("MIRRUSDT", reduce_only=True) is None, "close of the mirror: allowed")
check(refused("BBUSDT", reduce_only=True) is None, "close of a stock swap: allowed")
check(refused("BBUSDT@spot") is None, "spot key: not gated")

# dispatch_order: the entry is refused before any order goes out, the close goes through
calls = []
real_place = vw.auto_place_order
vw.auto_place_order = lambda *a, **k: calls.append(a) or False
try:
    execute.dispatch_order("BBUSDT", 50.0)
    check(False, "dispatch_order: entry into BB on OKX refused")
except Exception as e:
    check(isinstance(e, RuntimeError) and "股票" in str(e) and not calls,
          f"dispatch_order: entry into BB on OKX refused before auto_place_order ({type(e).__name__})")
try:
    got = execute.dispatch_order("BBUSDT", -50.0, reduce_only=True)
    check(got is False and len(calls) == 1, "dispatch_order: close of BB on OKX goes through")
except Exception as e:
    check(False, f"dispatch_order: close of BB on OKX goes through (raised {type(e).__name__}: {e})")
vw.auto_place_order = real_place

# auto_place_order's own entry gate (TWAP slices, chase fallback, custom executors)
sent = []
real_okx_place = order_okx.place_market_order
order_okx.place_market_order = lambda *a, **k: sent.append(a) or False
try:
    vw.auto_place_order("BBUSDT", 50.0)
    check(False, "auto_place_order: entry into BB on OKX refused")
except Exception as e:
    check(isinstance(e, RuntimeError) and "股票" in str(e) and not sent,
          f"auto_place_order: entry into BB on OKX refused before the order ({type(e).__name__})")
try:
    vw.auto_place_order("BBUSDT", 50.0, contributors=C("okx_bars"))
    check(len(sent) == 1, "auto_place_order: BB on OKX for a strategy on OKX bars reaches the order")
except Exception as e:
    check(False, f"auto_place_order: BB on OKX for a strategy on OKX bars reaches the order ({e})")
# 1000PEPEUSDT: OKX has no such contract — refused, never sent as another one
del sent[:]
try:
    vw.auto_place_order("1000PEPEUSDT", 50.0)
    check(False, "1000PEPEUSDT on OKX: refused")
except Exception as e:
    check(isinstance(e, order_okx.OKXError) and not sent,
          f"1000PEPEUSDT on OKX: no such contract, an OKX error before any order ({str(e)[:80]})")
order_okx.place_market_order = real_okx_place

# dispatch_order carries the contributors to the gate and on to auto_place_order
calls.clear()
vw.auto_place_order = lambda *a, **k: calls.append(k.get("contributors")) or False
got = execute.dispatch_order("BBUSDT", 50.0, contributors=C("okx_bars"))
check(got is False and calls == [C("okx_bars")],
      "dispatch_order: BB on OKX for a strategy on OKX bars passes, contributors handed on")
vw.auto_place_order = real_place

venue[0] = "bybit"
check(refused("ONUSDT", contributors=C("okx_bars")) is not None,
      "Bybit ONUSDT for a strategy on OKX bars (not this venue's): compared with Binance — refused")
check(refused("ONUSDT") is not None, "Bybit ONUSDT (symbolType stock) vs Binance coin: refused")
check(refused("ETFXUSDT") is not None, "Bybit symbolType ETF vs Binance coin: refused")
check(refused("BTCUSDT") is None, "Bybit BTC: allowed")
check(refused("USOUSDT") is not None, "Bybit stock vs Binance COMMODITY: refused (instrument_class stock)")
check(refused("PEPEUSDT") is None,
      "Bybit PEPEUSDT, Binance lists only 1000PEPEUSDT: allowed (binance_name_gate off for Bybit)")

venue[0] = "gateio"
check(refused("XYZUSDT") is not None, "Gate contract_type stocks vs Binance coin: refused")
check(refused("PAXGUSDT") is None, "Gate PAXG (metals, a coin on Binance): allowed")
check(refused("USOUSDT") is not None, "Gate stocks vs Binance COMMODITY: refused (instrument_class stock)")
# binance_name_gate off on Gate.io until it has its own kline (Wei 2026-11-15)
check(refused("PEPEUSDT") is None,
      "Gate PEPE_USDT, Binance only 1000PEPEUSDT: allowed (name gate off — no Gate bars to move to)")
check(refused("GSTKUSDT") is None,
      "Gate stock perp Binance does not list: allowed (name gate off; Binance class unknown)")

venue[0] = "bitget"
check(refused("PAXGUSDT") is None, "Bitget PAXG (isRwa YES, v3 metal) vs Binance coin: allowed")
check(refused("NVDAUSDT") is None, "Bitget NVDA (v3 stock) vs Binance EQUITY: allowed")
msg = refused("BBUSDT")
check(msg == "交易所上的 BBUSDT（Bitget）是股票合約，策略的 K 線（Binance BBUSDT）是加密幣，不是同一種合約，已擋下",
      f"Bitget BB (v3 stock) vs Binance coin: refused ({msg})")
check(refused("BHPUSDT") is not None, "Bitget crypto/stock row (fields disagree) counts as a stock: refused")
check(refused("BTCUSDT") is None, "Bitget BTC (crypto/crypto): allowed")
check(refused("PEPEUSDT") is None,
      "Bitget PEPEUSDT, Binance only 1000PEPEUSDT: allowed (Bitget's naming unverified, name gate off)")
check(refused("MDTUSDT") is None,
      "Bitget MDT (crypto/stock, real) vs Binance EQUITY: allowed (no mirror refusal)")
check(order_bitget.get_contract_rules({}, "NEWUSDT")["equity"] is None,
      "Bitget v3 single read answers 25100 (v2 lists it): equity None")
BITGET_V3["NEWUSDT"] = ("stock", "stock")  # listed after the 6-hour list was read
check(refused("NEWUSDT") is not None and order_bitget.acct._instruments["rows"]
      and "NEWUSDT" not in {r["symbol"] for r in order_bitget.acct._instruments["rows"]},
      "a stock listed after the cached v3 list, Binance coin: refused at once (per-symbol read)")
order_bitget._rules_cache.clear()
bitget_v3_up[0] = False
check(order_bitget.get_contract_rules({}, "BBUSDT")["equity"] is None,
      "Bitget v3 unreadable: equity None (isRwa YES is not read as a stock)")
check(refused("BBUSDT") is None, "Bitget v3 unreadable: allowed and logged (no class given)")
bitget_v3_up[0] = True
del v3_calls[:]
check(refused("BBUSDT") is not None and v3_calls == ["BBUSDT"],
      "after a v3 failure the None was not cached: the next call reads v3 again and refuses")

venue[0] = "binance"
check(refused("NVDAUSDT") is None, "Binance itself: never gated")

venue[0] = "okx"
binance_up[0] = False
from lib import stock_perps  # noqa: E402
stock_perps._binance.update(rows=None, at=0.0, failed_at=0.0)
check(refused("BBUSDT") is None, "Binance exchangeInfo unreadable: allowed (fail open)")
check(refused("PEPEUSDT") is None, "Binance exchangeInfo unreadable: a key it might lack is not refused either")

print("FAILED" if fails else "all ok")
sys.exit(1 if fails else 0)
