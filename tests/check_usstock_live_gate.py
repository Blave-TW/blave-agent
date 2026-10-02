"""A strategy that reads US stock data cannot be put on the 自動下單 page: the save is refused
up front (command_listener._cmd_amounts), not left to fail on every live tick. lib.data
fetch_usstock_price runs only in desktop chat turns and backtests; no live tick — desktop or
cloud — can fetch it (references/lib.md › US stocks / ETFs).

  - picked at any amount (0 included — picked = scheduled) → ValueError with the sentence the
    page shows; config, UI mirror and schedules untouched; same on the desktop and a cloud box
  - a mix with a crypto strategy is refused whole; the crypto strategy alone saves as before
  - every refusal is `CODE: 「<folder name>」<sentence>` and the app's parser (trade.js
    TR_REJECT_CODE_RE) reads the code and the name out of it (the app shows its own sentence)
  - the match is a US-stock fetcher (public or private) or yfinance named in CODE in any .py of the
    strategy folder — comments and strings stripped; never an import of workspace code

Run: cd blave-agent && .venv/bin/python tests/check_usstock_live_gate.py
"""
import json
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = tempfile.mkdtemp(prefix="usstock-live-gate-")
WS = os.path.join(BASE, "workspace")
for d in ("manager", "state", "strategies/us_spy_sma", "strategies/btc_sma"):
    os.makedirs(os.path.join(WS, d))
os.environ["BLAVE_AGENT_BASE"] = BASE
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
sys.path.insert(0, os.path.join(ROOT, "runtime"))
sys.path.insert(0, ROOT)
os.chdir(WS)
import command_listener as cl  # noqa: E402

fails = 0
CONFIG = os.path.join(WS, "manager", "portfolio_config.json")
MIRROR = os.path.join(WS, "manager", "amounts.ui.json")
STRAT = ('# Type:     A\nSTRATEGY_NAME = "{n}"\nINTERVAL = "1d"\n'
         'from lib.data import {f}\n\ndef fetch_data(headers):\n    return {f}({s!r}, "2020-01-01", None{h})\n')


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


def write(rel, text):
    with open(os.path.join(WS, rel), "w") as f:
        f.write(text)


write("strategies/us_spy_sma/strategy.py", STRAT.format(n="us_spy_sma", f="fetch_usstock_price", s="SPY", h=""))
write("strategies/btc_sma/strategy.py", STRAT.format(n="btc_sma", f="fetch_kline", s="BTCUSDT", h=", headers"))
write("manager/wait_for_bar.py", "# present: Type A/C run in-process\n")
crons = []
cl._sync_strategy_crons = lambda names: crons.append(sorted(names))


def reset():
    crons.clear()
    for p in (CONFIG, MIRROR):
        with open(p, "w") as f:
            json.dump({"amounts": {}, "exchanges": {}}, f)


def files():
    return tuple(open(p).read() for p in (CONFIG, MIRROR))


def save(amounts):
    try:
        cl._cmd_amounts({"amounts": amounts})
        return None
    except ValueError as e:
        return str(e)


for mode in ("1", None):
    if mode:
        os.environ["BLAVE_AGENT_LOCAL"] = mode
    else:
        os.environ.pop("BLAVE_AGENT_LOCAL", None)
    where = "desktop" if mode else "cloud"
    for amounts, label in (({"us_spy_sma": 100}, "funded"), ({"us_spy_sma": 0}, "picked at 0"),
                           ({"btc_sma": 100, "us_spy_sma": 0}, "next to a crypto strategy")):
        reset()
        before = files()
        msg = save(amounts)
        check(bool(msg) and msg.startswith("MARKET_US: 「us_spy_sma」") and "美股目前只能回測" in msg and "取消勾選" in msg,
              f"{where}: a US strategy {label} is refused with the sentence the page shows")
        check(files() == before and not crons, f"{where}: {label} — config, mirror and schedules untouched")
    reset()
    check(save({"btc_sma": 100}) is None and json.load(open(CONFIG))["amounts"] == {"btc_sma": 100.0}
          and crons == [["btc_sma"]], f"{where}: a crypto strategy alone saves as before")

check(cl._strategy_uses_us_stock("btc_sma") is None and cl._strategy_uses_us_stock("missing") is None
      and cl._strategy_uses_us_stock("us_spy_sma") == "us", "the match reads strategy.py's text; a missing folder is not a match")

CRYPTO = STRAT.format(n="x", f="fetch_kline", s="BTCUSDT", h=", headers")
for name, fs, blocked in (
        ("comment_only", {"strategy.py": "# like fetch_usstock_price but for BTC\n" + CRYPTO}, False),
        ("string_only", {"strategy.py": CRYPTO + 'NOTE = "not fetch_usstock_price, not yfinance"\n'}, False),
        ("docstring_only", {"strategy.py": '"""Filter idea from fetch_usstock_price(SPY)."""\n' + CRYPTO}, False),
        ("helper_module", {"strategy.py": CRYPTO + "from strategies.helper_module.feed import spy\n",
                           "feed.py": "from lib.data import fetch_usstock_price as f\nspy = f\n"}, True),
        ("private_fetcher", {"strategy.py": CRYPTO + "import lib.data as d\nx = d._fetch_usstock_yahoo_raw\n"}, True),
        ("private_daily", {"strategy.py": CRYPTO + "import lib.data as d\nx = d._usstock_daily\n"}, True),
        ("own_yfinance", {"strategy.py": CRYPTO + "import yfinance\n"}, True),
        ("yahoo_session", {"strategy.py": CRYPTO + "import lib.data as d\nr = d._yahoo_session().get\n"}, True),
        ("yahoo_global", {"strategy.py": CRYPTO + "import lib.data as d\nr = d._YAHOO_SESSION\n"}, True),
        ("broken_syntax", {"strategy.py": "def f(:\n    fetch_usstock_price('SPY')\n"}, True)):
    os.makedirs(os.path.join(WS, "strategies", name), exist_ok=True)
    for fn, text in fs.items():
        write(f"strategies/{name}/{fn}", text)
    check(bool(cl._strategy_uses_us_stock(name)) is blocked,
          f"{name}: {'refused' if blocked else 'not refused'} (comments and strings do not count; every .py in the folder does)")

for name, text in (("flag_env", CRYPTO + "import os\nos.environ['BLAVE_AGENT_LOCAL'] = '1'\n"),
                   ("flag_comment", "# BLAVE_AGENT_LOCAL is the desktop marker\n" + CRYPTO),
                   ("flag_concat", CRYPTO + "import os\nos.environ['BLAVE_AGENT' + '_LOCAL'] = '1'\n")):
    os.makedirs(os.path.join(WS, "strategies", name), exist_ok=True)
    write(f"strategies/{name}/strategy.py", text)
os.environ["BLAVE_AGENT_LOCAL"] = "1"
reset()
before = files()
msg = save({"flag_env": 100})
check(cl._strategy_uses_us_stock("flag_env") == "flag" and cl._strategy_uses_us_stock("flag_comment") == "flag"
      and bool(msg) and msg.startswith("MARKET_FLAG: 「flag_env」") and "BLAVE_AGENT_LOCAL" in msg and "不能上線" in msg
      and files() == before and not crons,
      "BLAVE_AGENT_LOCAL anywhere in the strategy's files (code, string or comment) → refused with its own sentence, nothing written")
check(cl._strategy_uses_us_stock("flag_concat") is None,
      "known limit: a flag name assembled at run time is not seen (lib.data still refuses on a live tick: no request leaves)")

# The desktop app (and the web workspace) read the refusal's code and folder name, then show their own
# sentence: the shape `CODE: 「name」…` is the contract — the app's own regex must read every refusal.
import re
trade = open(os.path.join(ROOT, "shell", "renderer", "trade.js"), encoding="utf-8").read()
js = re.search(r"const TR_REJECT_CODE_RE = /(.+?)/;", trade).group(1)
py = re.compile(js.replace("\\u300c", "「").replace("\\u300d", "」"))
os.makedirs(os.path.join(WS, "strategies", "grid_bot"), exist_ok=True)
write("strategies/grid_bot/strategy.py", "# Type:     B (grid, no backtest)\nSTRATEGY_NAME = 'grid_bot'\n")
os.environ["BLAVE_AGENT_LOCAL"] = "1"
reset()
got = [(py.match("ValueError: " + save({n: 0})) or None) for n in ("us_spy_sma", "grid_bot", "flag_env")]
check(all(got) and [(m.group(1), m.group(2)) for m in got]
      == [("MARKET_US", "us_spy_sma"), ("TYPE_B", "grid_bot"), ("MARKET_FLAG", "flag_env")],
      "the app's TR_REJECT_CODE_RE reads the code and the folder name of every refusal (MARKET_US, TYPE_B, MARKET_FLAG)")

print(f"\n{'ALL PASS' if not fails else f'{fails} FAIL'}")
sys.exit(1 if fails else 0)
