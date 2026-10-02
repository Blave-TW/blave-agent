"""lib/quality_check.py › blave_data_need — does a strategy need the Blave data key on the desktop.
No network. The api stores the answer per library listing (scripts/marketplace_admin.py publish);
the desktop library groups "usable without a card" on it.

  1. Every public def in lib/data.py is in exactly one of _DESKTOP_PUBLIC_DATA / _BLAVE_DATA, and
     neither set names anything data.py no longer has.
  2. The split is the one data.py's own code implies: a def that reaches a `BASE` URL (through any
     private helper, `_retry_get` excluded — it only compares against BASE) is Blave, unless it
     branches on the desktop's public source first (`_kline_source` / `_twstock_daily`).
  3. Classifier cases: plain / aliased / module-attribute / getattr reach into lib.data, direct
     api.blave.org URLs, and every "can't tell" shape → None; True wins over None.
  4. Shipped templates and examples classify as their fetchers say.
Run: cd blave-agent && .venv/bin/python tests/check_blave_data_need.py
"""
import ast
import glob
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from lib import quality_check as qc

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


# ── 1 + 2. the two sets against data.py ─────────────────────────────────────
tree = ast.parse(open(os.path.join(ROOT, "lib", "data.py"), encoding="utf-8").read())
funcs = {n.name: n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}
public = {k for k in funcs if not k.startswith("_")}
pub, blave = qc._DESKTOP_PUBLIC_DATA, qc._BLAVE_DATA

check(not pub & blave, f"no name in both sets: {sorted(pub & blave)}")
check(public <= pub | blave, f"every public data.py def is classified — missing: {sorted(public - pub - blave)}")
check(pub | blave <= public, f"no stale names in the sets: {sorted((pub | blave) - public)}")


def refs(node):
    out = set()
    for x in ast.walk(node):
        if isinstance(x, ast.Name):
            out.add(x.id)
        elif isinstance(x, ast.Attribute):
            out.add(x.attr)
    return out


DESKTOP_BRANCH = {"_kline_source", "_twstock_daily"}
direct = {k: "BASE" in refs(v) and k != "_retry_get" for k, v in funcs.items()}
calls = {k: (refs(v) & set(funcs)) - {k} for k, v in funcs.items()}


def reaches_base(k, seen=()):
    return direct[k] or any(reaches_base(c, seen + (k,)) for c in calls[k] if c not in seen)


implied_blave = {k for k in public if reaches_base(k) and not refs(funcs[k]) & DESKTOP_BRANCH}
check(implied_blave == blave & public,
      f"_BLAVE_DATA matches what data.py reaches — should add {sorted(implied_blave - blave)}, "
      f"should drop {sorted((blave & public) - implied_blave)}")
check(len(blave) > 50 and len(pub) > 15, f"the sets are not empty shells ({len(blave)} / {len(pub)})")

# ── 3. classifier cases ─────────────────────────────────────────────────────
need = qc.blave_data_need
HEAD = 'STRATEGY_NAME = "x"\n'
CASES = [
    ("kline only", "def fetch_data(h):\n    from lib.data import fetch_kline\n    return fetch_kline('BTCUSDT','1h','2020-01-01',None,h)\n", False),
    ("kline + public helpers + runner", "from lib.data import fetch_kline, txf_settlement_mask, FEED_TIMING\nfrom lib.runner import run\nfrom lib.strategy import add_realized_vol\n", False),
    ("single-ticker tw daily", "from lib.data import fetch_twstock_price_adj\n", False),
    ("whale", "from lib.data import fetch_kline, fetch_whale_hunter\n", True),
    ("aliased import", "from lib.data import fetch_holder_concentration as hc\nhc('DOGEUSDT')\n", True),
    ("module alias attr", "from lib import data as d\nd.fetch_taker_intensity('BTCUSDT')\n", True),
    ("from lib import data", "from lib import data\ndata.fetch_funding_rate('BTCUSDT')\n", True),
    ("import lib.data as", "import lib.data as D\nD.fetch_twfutures_ohlcv('TXF')\n", True),
    ("import lib.data dotted", "import lib.data\nlib.data.fetch_twmarket_index()\n", True),
    ("module attr public only", "from lib import data\ndata.fetch_kline('BTCUSDT','1h','2020',None,{})\n", False),
    ("getattr const blave", "from lib import data\ngetattr(data, 'fetch_whale_hunter')()\n", True),
    ("getattr const public", "from lib import data\ngetattr(data, 'fetch_kline')()\n", False),
    ("getattr computed", "from lib import data\nname = 'fetch_' + 'x'\ngetattr(data, name)()\n", None),
    ("getattr on something else", "from lib.data import fetch_kline\ngetattr(obj, name)\n", False),
    ("star import", "from lib.data import *\n", None),
    ("unknown lib.data fetcher", "from lib.data import fetch_brand_new_feed\n", None),
    ("unknown fetcher via alias", "from lib import data\ndata.fetch_brand_new_feed()\n", None),
    ("custom lib module", "from lib.data import fetch_kline\nfrom lib.orders_kraken import place_order\n", None),
    ("custom lib via from lib", "from lib import my_feed\n", None),
    ("custom lib dotted import", "import lib.my_feed\n", None),
    ("relative import", "from .helpers import signal\n", None),
    ("strategies helper", "from strategies.shared.util import x\n", None),
    ("dynamic import", "import importlib\nm = importlib.import_module('lib.data')\n", None),
    ("exec", "exec(open('x').read())\n", None),
    ("syntax error", "def broken(:\n", None),
    ("direct api URL", "import requests\nrequests.get('https://api.blave.org/whale_hunter/get_alpha')\n", True),
    ("direct api URL in f-string", "import requests\nsym='BTC'\nrequests.get(f'https://api.blave.org/x/{sym}')\n", True),
    ("api URL only in a docstring", '"""Mirrors https://api.blave.org/kline but via Binance."""\nfrom lib.data import fetch_kline\n', False),
    ("ccxt fetch_* is not lib.data", "import ccxt\nfrom lib.data import fetch_kline\nccxt.binance().fetch_funding_rate('BTC/USDT')\n", False),
    ("own fetch_* helper", "import requests\ndef fetch_news():\n    return requests.get('https://example.com').json()\n", False),
    ("True wins over None", "from lib.data import *\nfrom lib.data import fetch_whale_hunter\n", True),
    ("bundle: one part needs data", "# ===== STRATEGY 1: A =====\nfrom lib.data import fetch_kline\n# ===== STRATEGY 2: B =====\nfrom lib.data import fetch_cvd_coin\n", True),
]
for label, src, want in CASES:
    got = need(HEAD + src)
    check(got is want, f"{label}: {want} (got {got})")

# ── 4. shipped templates and examples ───────────────────────────────────────
EXPECT = {
    "strategies/TEMPLATE_A.py": False, "strategies/TEMPLATE_C.py": False,
    "examples/btc_sma_cross/strategy.py": False,      # fetch_kline
    "examples/tsmc_ma/strategy.py": False,            # single-ticker fetch_twstock_price_adj
    "examples/twstock_momentum/strategy.py": False,   # per-ticker fetch_twstock_price_adj loop
    "examples/btc_ti_5min/strategy.py": True,         # fetch_taker_intensity
    "examples/cl_sma/strategy.py": True,              # fetch_db_kline
    "examples/tw100_foreign_zscore/strategy.py": True,
    "examples/tw2317_broker_zscore/strategy.py": True,
    "examples/txf_ma_1m/strategy.py": True,           # fetch_twfutures_ohlcv
}
for rel, want in EXPECT.items():
    got = need(open(os.path.join(ROOT, rel), encoding="utf-8").read())
    check(got is want, f"{rel}: {want} (got {got})")
unlisted = {os.path.relpath(p, ROOT) for p in glob.glob(os.path.join(ROOT, "examples", "*", "strategy.py"))} - set(EXPECT)
check(not unlisted, f"every shipped example has an expectation here — add: {sorted(unlisted)}")

print("all ok" if not fails else "FAILED")
sys.exit(1 if fails else 0)
