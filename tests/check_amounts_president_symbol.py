"""統一期貨 trades TW index futures only: a strategy routed to it whose SYMBOL is not
TXF / MXF / TMF is refused when the amounts are SAVED (command_listener._cmd_amounts,
`NOT_TXF: 「name」…` — the code/name shape the desktop shell turns into a sentence),
not in the reconciler's first round (0.1.18 Bug 2). Nothing is written on a refusal.
A symbol that cannot be read is not judged (same fail-open as the Type C check); the
same strategy routed anywhere else is untouched.

Run: cd blave-agent && .venv/bin/python tests/check_amounts_president_symbol.py
"""
import json
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = tempfile.mkdtemp(prefix="amounts-president-")
WS = os.path.join(BASE, "workspace")
for d in ("manager", "state", "strategies/txf_sma", "strategies/mxf_sma", "strategies/btc_sma", "strategies/nosym"):
    os.makedirs(os.path.join(WS, d))
os.environ["BLAVE_AGENT_BASE"] = BASE
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.pop("BLAVE_AGENT_LOCAL", None)
sys.path.insert(0, os.path.join(ROOT, "runtime"))
sys.path.insert(0, ROOT)
os.chdir(WS)
import command_listener as cl  # noqa: E402

fails = 0
CONFIG = os.path.join(WS, "manager", "portfolio_config.json")
MIRROR = os.path.join(WS, "manager", "amounts.ui.json")


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


for n, sym in (("txf_sma", "TXF"), ("mxf_sma", "MXF"), ("btc_sma", "BTCUSDT")):
    with open(os.path.join(WS, "strategies", n, "stats.json"), "w") as f:
        json.dump({"symbol": sym, "trades": 3}, f)
for n in ("txf_sma", "mxf_sma", "btc_sma", "nosym"):
    with open(os.path.join(WS, "strategies", n, "strategy.py"), "w") as f:
        f.write(f'STRATEGY_NAME = "{n}"\nINTERVAL = "1h"\n')
with open(os.path.join(WS, "manager", "wait_for_bar.py"), "w") as f:
    f.write("# present\n")
cl._sync_strategy_crons = lambda names: None


def bind(venue_lines):
    with open(os.path.join(WS, ".env"), "w") as f:
        f.write(venue_lines)
    for p in (CONFIG, MIRROR):
        if os.path.exists(p):
            os.remove(p)


def save(amounts):
    try:
        cl._cmd_amounts({"amounts": amounts})
    except ValueError as e:
        return str(e)
    return None


PRESIDENT = "PRESIDENT_ACCOUNT=70000011234\nPRESIDENT_PASSWORD=vault:abc\n"

bind(PRESIDENT)
err = save({"txf_sma": 2, "mxf_sma": 1})
cfg = json.load(open(CONFIG))
check(err is None and cfg["exchanges"] == {"txf_sma": "president", "mxf_sma": "president"}
      and cfg["asset_specs"]["txf_sma"]["contract_value"] == 200 and cfg["asset_specs"]["mxf_sma"]["contract_value"] == 50,
      f"統一: TXF / MXF members save, routed to president, specs written ({err})")
before = open(CONFIG).read()
err = save({"txf_sma": 2, "btc_sma": 100})
check(err is not None and err.startswith("NOT_TXF: 「btc_sma」") and "BTCUSDT" in err,
      f"統一: a BTCUSDT member is refused at save, code NOT_TXF naming the strategy: {err}")
check(open(CONFIG).read() == before and "btc_sma" not in json.load(open(MIRROR)).get("amounts", {}),
      "…nothing written on the refusal (config and mirror as before)")
err = save({"txf_sma": 2, "btc_sma": 0})
check(err is not None and err.startswith("NOT_TXF: 「btc_sma」"),
      f"…membership at 0 is refused too (there is nothing on 統一 for it to converge to): {err}")
err = save({"txf_sma": 2, "nosym": 1})
check(err is None and json.load(open(CONFIG))["exchanges"].get("nosym") == "president",
      f"統一: a strategy whose symbol cannot be read is not judged (fail-open, like the Type C check) ({err})")

# asset_specs follow the strategy's CURRENT symbol: a spec of another contract is
# rewritten on a funded save; a manual edit on the right contract is kept
with open(os.path.join(WS, "strategies", "mxf_sma", "stats.json"), "w") as f:
    json.dump({"symbol": "TMF", "trades": 3}, f)
cfg = json.load(open(CONFIG))
cfg["asset_specs"]["txf_sma"]["margin"] = 650000
json.dump(cfg, open(CONFIG, "w"))
err = save({"txf_sma": 2, "mxf_sma": 0})
check(err is None and json.load(open(CONFIG))["asset_specs"]["mxf_sma"]["contract_value"] == 50,
      f"統一: a save at amount 0 does not touch a stale spec ({err})")
err = save({"txf_sma": 2, "mxf_sma": 1})
specs = json.load(open(CONFIG))["asset_specs"]
check(err is None and specs["mxf_sma"] == cl._TXF_ASSET_SPECS["TMF"],
      f"…a strategy whose SYMBOL moved MXF -> TMF gets the TMF spec on the next funded save ({specs.get('mxf_sma')})")
check(specs["txf_sma"]["contract_value"] == 200 and specs["txf_sma"]["margin"] == 650000,
      "…a hand-edited margin on the unchanged TXF spec is kept")

bind("BINANCE_API_KEY=a\nBINANCE_SECRET_KEY=b\n")
err = save({"btc_sma": 100, "txf_sma": 1})
check(err is None and json.load(open(CONFIG))["exchanges"] == {"btc_sma": "binance", "txf_sma": "binance"},
      f"another venue: the same BTCUSDT strategy saves as before ({err})")

print(f"\n{'ALL PASS' if not fails else f'{fails} FAIL'}")
sys.exit(1 if fails else 0)
