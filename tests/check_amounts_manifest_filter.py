"""Saving amounts inherits a routing venue only from what the UI bound (command_listener._cmd_amounts,
P2-4): a credential pair an agent hand-wrote into .env never becomes a routing target when the bind
manifest (manager/credentials.ui.json) exists — lib/venue_wiring would not route to it, so the
saved config would look deployed and never trade. No manifest = every pair in .env counts (fail-open,
same as lib/venue_wiring).

Run: cd blave-agent && .venv/bin/python tests/check_amounts_manifest_filter.py
"""
import json
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = tempfile.mkdtemp(prefix="amounts-manifest-")
WS = os.path.join(BASE, "workspace")
for d in ("manager", "state", "strategies/btc_sma", "strategies/eth_sma"):
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
MANIFEST = os.path.join(WS, "manager", "credentials.ui.json")
STRAT = 'STRATEGY_NAME = "{n}"\nINTERVAL = "1h"\n'


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


for n in ("btc_sma", "eth_sma"):
    with open(os.path.join(WS, "strategies", n, "strategy.py"), "w") as f:
        f.write(STRAT.format(n=n))
with open(os.path.join(WS, "manager", "wait_for_bar.py"), "w") as f:
    f.write("# present\n")
# BINANCE bound through the UI; OKX hand-written into .env by an agent
with open(os.path.join(WS, ".env"), "w") as f:
    f.write("BINANCE_API_KEY=a\nBINANCE_SECRET_KEY=b\nOKX_API_KEY=c\nOKX_SECRET_KEY=d\nOKX_PASSPHRASE=e\n")
cl._sync_strategy_crons = lambda names: None


def save(prev_exchanges, amounts, manifest):
    for p in (CONFIG, MIRROR):
        with open(p, "w") as f:
            json.dump({"amounts": {k: 0 for k in prev_exchanges}, "exchanges": prev_exchanges}, f)
    if manifest is None:
        if os.path.exists(MANIFEST):
            os.remove(MANIFEST)
    else:
        with open(MANIFEST, "w") as f:
            json.dump({"ids": manifest}, f)
    cl._cmd_amounts({"amounts": amounts})
    return json.load(open(CONFIG))["exchanges"]


ex = save({}, {"btc_sma": 100}, ["binance"])
check(ex == {"btc_sma": "binance"}, f"manifest lists binance only: a fresh strategy routes to binance, not the hand-written okx ({ex})")
ex = save({"btc_sma": "okx"}, {"btc_sma": 100, "eth_sma": 50}, ["binance"])
check(ex == {"btc_sma": "binance", "eth_sma": "binance"},
      f"an old route to the hand-written okx is not inherited: both go to the one UI-bound venue ({ex})")
ex = save({"btc_sma": "okx"}, {"btc_sma": 100}, [])
check(ex == {"btc_sma": ""}, f"an empty manifest (every UI venue unbound) is not \"no manifest\": nothing in .env routes ({ex})")
ex = save({"btc_sma": "okx"}, {"btc_sma": 100}, None)
check(ex == {"btc_sma": "okx"}, f"no manifest (fail-open): every pair in .env counts, the okx route is kept ({ex})")
ex = save({}, {"btc_sma": 100}, None)
check(ex == {"btc_sma": ""}, f"no manifest and two bound venues: no default venue to pick ({ex})")

print(f"\n{'ALL PASS' if not fails else f'{fails} FAIL'}")
sys.exit(1 if fails else 0)
