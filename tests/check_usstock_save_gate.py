"""Saving the 下單設定 (command_listener._cmd_amounts) with a strategy whose prices include
fetch_usstock_price: it trades only on the desktop, as a Type A whose SYMBOL is the ticker's
Binance stock perp, and only on an exchange that lists that perp. Each refusal names the
strategy (`CODE: 「name」…`) and writes nothing.

  - desktop, NVDA signal, SYMBOL NVDAUSDT: saves on Binance, on paper, with no venue bound
  - US_CLOUD: any US strategy on a cloud machine, picked at any amount, whatever its SYMBOL
  - US_SYMBOL: bare SYMBOL 'NVDA', no SYMBOL, a ticker that is not the traded stock (SPY beside
    NVDAUSDT), a ticker the code does not spell out, a coin (BTCUSDT), a Type C — paper too
  - US_VENUE: the bound exchange has no such perp (symbol_unavailable), or lists it as a coin
  - fail-open: Binance's list or the exchange's contract list unreadable → saves (the order is
    refused later), as the TW checks do
  - the TW gate is untouched: a TW stock strategy on Binance is still MARKET_VENUE; a crypto
    strategy still saves on the cloud
No network: lib.stock_perps.binance_rows and lib.order_<venue>.get_contract_rules are stubbed.

Run: cd blave-agent && .venv/bin/python tests/check_usstock_save_gate.py
"""
import json
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = tempfile.mkdtemp(prefix="usstock-save-gate-")
WS = os.path.join(BASE, "workspace")
os.makedirs(os.path.join(WS, "manager"))
os.makedirs(os.path.join(WS, "state"))
os.environ["BLAVE_AGENT_BASE"] = BASE
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.pop("BLAVE_AGENT_LOCAL", None)
sys.path.insert(0, os.path.join(ROOT, "runtime"))
sys.path.insert(0, ROOT)
os.chdir(WS)
import command_listener as cl  # noqa: E402
import lib.order_binance as ob  # noqa: E402
import lib.order_bingx as obx  # noqa: E402
import lib.stock_perps as sp  # noqa: E402
import requests  # noqa: E402

fails = 0
CONFIG = os.path.join(WS, "manager", "portfolio_config.json")
MIRROR = os.path.join(WS, "manager", "amounts.ui.json")
ROWS = {"NVDAUSDT": ("EQUITY", "NVDA"), "SPYUSDT": ("EQUITY", "SPY"), "BTCUSDT": ("COIN", "BTC")}
sp.binance_rows = lambda: ROWS
RULES = {"binance": lambda env, sym: {"equity": True}, "bingx": lambda env, sym: {"equity": True}}
ob.get_contract_rules = lambda env, sym: RULES["binance"](env, sym)
obx.get_contract_rules = lambda env, sym: RULES["bingx"](env, sym)


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


def strat(name, body, typ="A", stats=None):
    d = os.path.join(WS, "strategies", name)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "strategy.py"), "w") as f:
        f.write(f'# Type:     {typ}\nSTRATEGY_NAME = "{name}"\nINTERVAL = "1d"\n{body}')
    if stats is not None:
        with open(os.path.join(d, "stats.json"), "w") as f:
            json.dump(stats, f)


US = "from lib.data import fetch_usstock_price\n"
strat("us_nvda", US + "SYMBOL = 'NVDAUSDT'\n\ndef fetch_data(h):\n    return fetch_usstock_price('NVDA', '2020-01-01', None)\n")
strat("us_const", US + "SYMBOL = 'NVDAUSDT'\nTICKER = 'nvda'\n\ndef fetch_data(h):\n    return fetch_usstock_price(TICKER, '2020-01-01', None)\n")
strat("us_bare", US + "SYMBOL = 'NVDA'\n\ndef fetch_data(h):\n    return fetch_usstock_price('NVDA', '2020-01-01', None)\n")
strat("us_nosym", US + "\ndef fetch_data(h):\n    return fetch_usstock_price('NVDA', '2020-01-01', None)\n")
strat("us_filter", US + "SYMBOL = 'NVDAUSDT'\n\ndef fetch_data(h):\n    a = fetch_usstock_price('NVDA', '2020-01-01', None)\n"
      "    b = fetch_usstock_price('SPY', '2020-01-01', None)\n    return a\n")
strat("us_loop", US + "SYMBOL = 'NVDAUSDT'\n\ndef fetch_data(h):\n    for t in ['NVDA']:\n"
      "        return fetch_usstock_price(t, '2020-01-01', None)\n")
strat("us_coin", US + "SYMBOL = 'BTCUSDT'\n\ndef fetch_data(h):\n    return fetch_usstock_price('BTC', '2020-01-01', None)\n")
strat("us_basket", US + "UNIVERSE = ['NVDA', 'SPY']\n", typ="C", stats={"benchmark_return": 1.0})
strat("btc_sma", "from lib.data import fetch_kline\nSYMBOL = 'BTCUSDT'\n")
strat("tw_2330", "from lib.data import fetch_twstock_price_adj\nSYMBOL = '2330'\n")
with open(os.path.join(WS, "manager", "wait_for_bar.py"), "w") as f:
    f.write("# present\n")
cl._sync_strategy_crons = lambda names: None
cl._portfolio_trading_supported = lambda: True


def bind(lines):
    with open(os.path.join(WS, ".env"), "w") as f:
        f.write(lines)
    for p in (CONFIG, MIRROR):
        if os.path.exists(p):
            os.remove(p)


def save(amounts):
    try:
        cl._cmd_amounts({"amounts": amounts})
    except ValueError as e:
        return str(e)
    return None


def refused(code, name, amounts, *words):
    before = open(CONFIG).read() if os.path.exists(CONFIG) else None
    err = save(amounts)
    after = open(CONFIG).read() if os.path.exists(CONFIG) else None
    return (err is not None and err.startswith(f"{code}: 「{name}」") and all(w in err for w in words)
            and after == before), err


BINANCE = "BINANCE_API_KEY=a\nBINANCE_SECRET_KEY=b\n"
BINGX = "BINGX_API_KEY=a\nBINGX_SECRET_KEY=b\n"
PAPER = "PAPER_API_KEY=paper\nPAPER_SECRET_KEY=paper\n"

# ── cloud ──────────────────────────────────────────────────────────────────
bind(BINANCE)
for name in ("us_nvda", "us_bare", "us_basket"):
    for amt in (100, 0):
        ok, err = refused("US_CLOUD", name, {name: amt}, "電腦版")
        check(ok, f"cloud: {name} at {amt} is refused US_CLOUD, nothing written ({err})")
check(save({"btc_sma": 100}) is None, "cloud: a crypto strategy still saves")

# ── desktop ────────────────────────────────────────────────────────────────
os.environ["BLAVE_AGENT_LOCAL"] = "1"
for lines, venue in ((BINANCE, "binance"), (PAPER, "paper"), ("", "")):
    bind(lines)
    err = save({"us_nvda": 100, "us_const": 50})
    cfg = json.load(open(CONFIG)) if os.path.exists(CONFIG) else {}
    check(err is None and cfg.get("amounts") == {"us_nvda": 100.0, "us_const": 50.0}
          and cfg.get("exchanges", {}).get("us_nvda", "") == venue,
          f"desktop, {venue or 'no venue'}: NVDA signal on NVDAUSDT saves (literal and module constant) ({err})")
for lines, venue in ((BINANCE, "binance"), (PAPER, "paper")):
    for name, words in (("us_bare", ("NVDAUSDT",)), ("us_nosym", ("SYMBOL",)), ("us_filter", ("SPY", "NVDAUSDT")),
                        ("us_loop", ("代號",)), ("us_coin", ("BTCUSDT", "不是"))):
        bind(lines)
        ok, err = refused("US_SYMBOL", name, {name: 100}, *words)
        check(ok, f"desktop, {venue}: {name} is refused US_SYMBOL ({err})")
    bind(lines)
    ok, err = refused("US_SYMBOL", "us_basket", {"us_basket": 100}, "Type C")
    check(ok, f"desktop, {venue}: a US Type C is refused US_SYMBOL ({err})")


def unlisted(env, sym):
    raise obx.BingXError("N/A", f"symbol {sym} not found in /quote/contracts", "contracts",
                         kind="symbol_unavailable")


bind(BINGX)
RULES["bingx"] = unlisted
ok, err = refused("US_VENUE", "us_nvda", {"us_nvda": 100}, "NVDAUSDT", "BingX", "股票永續")
check(ok, f"desktop, BingX without the perp: US_VENUE naming the exchange ({err})")
RULES["bingx"] = lambda env, sym: {"equity": False}
bind(BINGX)
ok, err = refused("US_VENUE", "us_nvda", {"us_nvda": 100}, "加密幣")
check(ok, f"desktop, the venue's NVDAUSDT is a coin: US_VENUE ({err})")


def down(env, sym):
    raise requests.exceptions.ConnectionError("contract list unreachable")


RULES["bingx"] = down
bind(BINGX)
check(save({"us_nvda": 100}) is None, "desktop, the exchange's contract list unreadable: not judged, saves")
RULES["bingx"] = lambda env, sym: {"equity": True}
sp.binance_rows = lambda: None
bind(BINANCE)
check(save({"us_nvda": 100}) is None, "desktop, Binance exchangeInfo unreadable: the mapping is not judged, saves")
ok, err = refused("US_SYMBOL", "us_bare", {"us_bare": 100}, "NVDAUSDT")
check(ok, f"…a bare SYMBOL is still refused without Binance (decided on the name) ({err})")
sp.binance_rows = lambda: ROWS

bind(BINANCE)
ok, err = refused("MARKET_VENUE", "tw_2330", {"tw_2330": 1}, "台股")
check(ok, f"the TW gate is unchanged: a TW stock strategy on Binance is MARKET_VENUE ({err})")
check(save({"btc_sma": 100, "us_nvda": 10}) is None, "a crypto strategy and a US one save together on the desktop")

print("FAIL" if fails else "OK", f"({fails} failed)")
sys.exit(1 if fails else 0)
