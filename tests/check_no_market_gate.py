"""The 0.1.12 market ↔ exchange check was dropped before release (Wei): saving amounts no longer
looks at what market a strategy's data came from. Known cost, accepted: a US-stock strategy can be
picked and funded — its live ticks fail (lib.data fetch_usstock_price only runs in desktop chat
turns and backtests).

  - a US strategy saves at any amount, alone or next to a crypto one, on the desktop and on a cloud
    box; config, UI mirror and schedules are written as for any other strategy
  - strategy code that mentions BLAVE_AGENT_LOCAL saves too (no MARKET_FLAG)
  - a stale state/market_hold.json left by a 0.1.12 dev build changes nothing: the reconciler no
    longer reads it, the report no longer writes it
  - TYPE_B stays: a Type B is still refused on the desktop, and the app's TR_REJECT_CODE_RE reads
    its code and folder name

Run: cd blave-agent && .venv/bin/python tests/check_no_market_gate.py
"""
import json
import os
import re
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = tempfile.mkdtemp(prefix="no-market-gate-")
WS = os.path.join(BASE, "workspace")
for d in ("manager", "state", "strategies/us_spy_sma", "strategies/btc_sma", "strategies/flag_env", "strategies/grid_bot"):
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
write("strategies/flag_env/strategy.py", STRAT.format(n="flag_env", f="fetch_kline", s="BTCUSDT", h=", headers")
      + "import os\nos.environ['BLAVE_AGENT_LOCAL'] = '1'\n")
write("strategies/grid_bot/strategy.py", "# Type:     B (grid, no backtest)\nSTRATEGY_NAME = 'grid_bot'\n")
write("manager/wait_for_bar.py", "# present: Type A/C run in-process\n")
# what a 0.1.12 dev build left behind: inert now
write("state/market_hold.json", json.dumps({"us_spy_sma": {"venue": "binance", "reason": "us"}}))
crons = []
cl._sync_strategy_crons = lambda names: crons.append(sorted(names))


def reset():
    crons.clear()
    for p in (CONFIG, MIRROR):
        with open(p, "w") as f:
            json.dump({"amounts": {}, "exchanges": {}}, f)


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
                           ({"btc_sma": 100, "us_spy_sma": 0}, "next to a crypto strategy"),
                           ({"flag_env": 50}, "mentioning BLAVE_AGENT_LOCAL")):
        reset()
        msg = save(amounts)
        got = json.load(open(CONFIG))["amounts"]
        check(msg is None and got == {k: float(v) for k, v in amounts.items()} and crons == [sorted(amounts)],
              f"{where}: {label} saves — config and schedules written ({msg!r}, {got}, {crons})")

check(not hasattr(cl, "_strategy_uses_us_stock") and not hasattr(cl, "_resume_gate") and "market_gate" not in open(
      os.path.join(ROOT, "runtime", "command_listener.py"), encoding="utf-8").read(),
      "command_listener has no market check left (no _strategy_uses_us_stock / _resume_gate / market_gate)")
src_pf = open(os.path.join(ROOT, "lib", "portfolio.py"), encoding="utf-8").read()
src_rp = open(os.path.join(ROOT, "runtime", "portfolio_reporter.py"), encoding="utf-8").read()
check(not re.search(r"market_hold|judge_symbol|market_check", src_pf) and not re.search(r"market_gate|market_hold|market_check_off", src_rp),
      "the reconciler reads no market_hold.json / judges nothing before an order; the report carries no market_gate")
check(not os.path.exists(os.path.join(ROOT, "runtime", "market_gate.py"))
      and not os.path.exists(os.path.join(ROOT, "runtime", "market_contracts.py")),
      "runtime ships no market_gate.py / market_contracts.py")

# TYPE_B is not a market check: still refused on the desktop, code readable by the app
trade = open(os.path.join(ROOT, "shell", "renderer", "trade.js"), encoding="utf-8").read()
js = re.search(r"const TR_REJECT_CODE_RE = /(.+?)/;", trade).group(1)
py = re.compile(js.replace("\\u300c", "「").replace("\\u300d", "」"))
os.environ["BLAVE_AGENT_LOCAL"] = "1"
reset()
msg = save({"grid_bot": 0})
m = py.match("ValueError: " + (msg or ""))
check(bool(m) and (m.group(1), m.group(2)) == ("TYPE_B", "grid_bot") and not crons,
      f"desktop: a Type B is still refused as TYPE_B and the app's TR_REJECT_CODE_RE reads it ({msg!r})")

print(f"\n{'ALL PASS' if not fails else f'{fails} FAIL'}")
sys.exit(1 if fails else 0)
