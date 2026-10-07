"""runtime/local_daemon.strategy_kinds: what the desktop daemon writes into
state/local_status.json for the app's strategy telemetry (shell/telemetry.js strat_*).
No network, no daemon process.

  type / market   strategy_reporter's rule (header; no header + Type C backtest → C)
  bt              stats.json exists
  funded          folder or STRATEGY_NAME has a finite amount > 0 (legacy weights fallback)
  None            config unreadable or strategies dir unreadable — never a wrong {}
  cache           unchanged files are not re-read

Run: cd blave-agent && .venv/bin/python tests/check_local_strategy_kinds.py
"""
import json
import os
import shutil
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = tempfile.mkdtemp(prefix="strat-kinds-")
WS = os.path.join(BASE, "workspace")
SD = os.path.join(WS, "strategies")
os.makedirs(SD)
os.environ["BLAVE_AGENT_BASE"] = BASE
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
sys.path.insert(0, os.path.join(ROOT, "runtime"))
import local_daemon as ld  # noqa: E402

fails = 0


def check(cond, msg, detail=""):
    global fails
    print(("ok   " if cond else "FAIL ") + msg + ("" if cond else f"  {detail}"))
    fails += 0 if cond else 1


def put(folder, src, stats=None):
    d = os.path.join(SD, folder)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "strategy.py"), "w", encoding="utf-8") as f:
        f.write(src)
    if stats is not None:
        with open(os.path.join(d, "stats.json"), "w", encoding="utf-8") as f:
            json.dump(stats, f)


try:
    put("btc_trend", '# Type: A\nSTRATEGY_NAME = "btc_trend"\nfrom lib.data import fetch_kline\n',
        {"symbol": "BTCUSDT"})
    put("txf_daily", '# Type: A\nSTRATEGY_NAME = "txf_daily"\nSYMBOL = "TXF"\n'
        'from lib.data import fetch_twfutures_ohlcv\n')
    put("folder_x", 'STRATEGY_NAME = "renamed_pf"\nfrom lib.data import fetch_kline, fetch_twstock_price\n',
        {"benchmark_sharpe": 0.1})
    put("own_data", '# notes only\nimport pandas\n')
    put("_scratch", '# Type: B\n')
    os.makedirs(os.path.join(SD, "out_only"))                    # backtest output dir, no strategy.py
    with open(os.path.join(SD, "flat.py"), "w") as f:            # flat layout: the app does not list it
        f.write("# Type: B\n")

    cache = {}
    cfg = {"amounts": {"btc_trend": 1000, "renamed_pf": "250", "txf_daily": 0, "ghost": 5}}
    got = ld.strategy_kinds(SD, cfg, cache)
    check(sorted(got) == ["btc_trend", "folder_x", "own_data", "txf_daily"],
          "lists strategies/<folder>/strategy.py only, skips _/. folders, output dirs and flat files", got)
    check(got["btc_trend"] == {"type": "A", "market": "crypto", "bt": True, "funded": True},
          "header type, crypto fetcher, stats → bt, amount > 0 → funded", got["btc_trend"])
    check(got["txf_daily"] == {"type": "A", "market": "tw_index_futures", "bt": False, "funded": False},
          "TXF futures → tw_index_futures; amount 0 is paused, not funded", got["txf_daily"])
    check(got["folder_x"] == {"type": "C", "market": "mixed", "bt": True, "funded": True},
          "no header + Type C backtest → C; two markets → mixed; funded by STRATEGY_NAME", got["folder_x"])
    check(got["own_data"] == {"type": None, "market": None, "bt": False, "funded": False},
          "undecidable → None (the app sends unk)", got["own_data"])

    check(ld.strategy_kinds(SD, {"weights": {"txf_daily": 0.3, "btc_trend": True}}, {})["txf_daily"]["funded"] is True
          and ld.strategy_kinds(SD, {"weights": {"btc_trend": True}}, {})["btc_trend"]["funded"] is False,
          "legacy weights fallback; a bool is not an amount")
    check(ld.strategy_kinds(SD, {"amounts": {"btc_trend": "nan"}}, {})["btc_trend"]["funded"] is False
          and ld.strategy_kinds(SD, {"amounts": {"btc_trend": "inf"}}, {})["btc_trend"]["funded"] is False,
          "non-finite amounts are not funded")
    check(ld.strategy_kinds(SD, {}, {})["btc_trend"]["funded"] is False, "never configured ({}) → nothing funded")
    check(ld.strategy_kinds(SD, None, {}) is None, "config unreadable (None) → None, not a list")
    check(ld.strategy_kinds(os.path.join(BASE, "nope"), {}, {}) == {}, "no strategies dir yet → {}")
    blocker = os.path.join(BASE, "afile")
    open(blocker, "w").close()
    check(ld.strategy_kinds(blocker, {}, {}) is None, "strategies path unreadable as a dir → None")

    # cache: unchanged files are not re-read; an edit is
    reads = []
    real_open = open

    def counting_open(path, *a, **kw):
        reads.append(os.path.basename(os.path.dirname(path)) + "/" + os.path.basename(path))
        return real_open(path, *a, **kw)

    ld.open = counting_open
    try:
        ld.strategy_kinds(SD, cfg, cache)
        check(reads == [], "second round with nothing changed reads no file", reads)
        put("btc_trend", '# Type: B\nSTRATEGY_NAME = "btc_trend"\nfrom lib.data import fetch_usstock_price\n'
            + "# padding so the size changes\n")
        again = ld.strategy_kinds(SD, cfg, cache)
        check(reads == ["btc_trend/strategy.py"] and again["btc_trend"]["type"] == "B"
              and again["btc_trend"]["market"] == "us_stock",
              "an edited strategy is re-read (headered: stats.json not parsed)", reads)
    finally:
        del ld.open
    shutil.rmtree(os.path.join(SD, "own_data"))
    ld.strategy_kinds(SD, cfg, cache)
    check("own_data" not in cache, "a deleted strategy leaves the cache")

    # wired into the status file, failures contained
    src = real_open(os.path.join(ROOT, "runtime", "local_daemon.py"), encoding="utf-8").read()
    check('doc["strategy_kinds"] = strategy_kinds(\n                    os.path.join(self.ws, "strategies"), doc.get("config"), self._kinds_cache)' in src
          and 'doc["strategy_kinds"] = None' in src,
          "write_status adds strategy_kinds from the report's config; an exception writes None")
finally:
    shutil.rmtree(BASE, ignore_errors=True)

print()
print("ALL PASS" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
