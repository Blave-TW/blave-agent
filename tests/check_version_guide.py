"""Minimal check for the version guide (.claude/docs/strategy-versions.md §4 › 導讀) — no network.

Drives the real lib/runner.run() in a temp workspace:

  - write_guide() refuses before there is a version, an item over the cap, an item covering
    no changed line, and a 7th item
  - the next backtest stores `base` and `guide` in the version blob, never in index.json, and
    consumes the pending guide
  - a guide written before a further edit is dropped at mint (bound to the file it was written for)
  - `base` is the version the edit started from: restore v1, edit → base 1, not n-1
  - bad line ranges and bidi / zero-width characters in the text are refused / dropped
  - a re-run without an edit consumes the pending guide; a broken pending file (hand-edited
    items, not JSON, deep nesting, over 64KB, a symlink to /dev/zero) never stops the mint
  - line-level claim: two items inside one difflib opcode split it; a deletion with no
    `old_lines` follows the one item owning that opcode's added lines; a VERSION_NOTE edit is
    never unexplained

Run: cd blave-agent && .venv/bin/python tests/check_version_guide.py
"""
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import numpy as np
import pandas as pd

import lib.runner as runner
import lib.strategy as strategy

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


def raises(fn, *a):
    try:
        fn(*a)
    except ValueError as e:
        return str(e)
    return None


NAME = "gcheck"
WS = Path(tempfile.mkdtemp(prefix="guide-"))
os.chdir(WS)
runner._REPO_ROOT = WS
strategy._REPO_ROOT = WS
SRC = WS / "strategies" / NAME / "strategy.py"
SRC.parent.mkdir(parents=True)
(WS / "manager").mkdir()
(WS / "manager" / "portfolio_config.json").write_text('{"amounts": {}}')
VDIR = WS / "strategies" / NAME / "versions"
PENDING = VDIR / strategy.GUIDE_PENDING

n = 400
idx = pd.date_range("2024-01-01", periods=n, freq="h")
close = pd.Series(100 + np.cumsum(np.sin(np.arange(n) / 7.0)), index=idx)
DF = pd.DataFrame({"Open": close, "High": close * 1.001, "Low": close * 0.999,
                   "Close": close, "Volume": 1.0}, index=idx)
SIGNALS = pd.Series(np.where(np.arange(n) % 40 < 20, 1.0, 0.0), index=idx)

V1 = 'VERSION_NOTE = ""\nATR_PERIOD = 10\nATR_MULT = 3.0\nSTOP_PCT = 0.02\n\ndef f():\n    return 1\n'
V2 = ('VERSION_NOTE = "atr, volume, stop"\nATR_PERIOD = 14\nATR_MULT = 3.0\nVOL_MA = 20\n'
      'STOP_ATR = 2.0\n\ndef f():\n    return 1\n')


def backtest():
    config = {"STRATEGY_NAME": NAME, "SYMBOL": "BTCUSDT", "INTERVAL": "1h", "START": "2024-01-01",
              "FEE": 0.0005, "MCPT": False, "VERSION_NOTE": "", "__file__": str(SRC)}
    os.environ["BLAVE_MODE"] = "backtest"
    try:
        runner.run(config, lambda hdrs: DF, lambda d: SIGNALS)
    finally:
        os.environ.pop("BLAVE_MODE", None)


def blob(v):
    return json.loads((VDIR / f"v{v}.json").read_text(encoding="utf-8"))


SRC.write_text(V1, encoding="utf-8")
check(raises(strategy.write_guide, NAME, [{"title": "x", "body": "", "lines": [[1, 1]]}]) is not None,
      "write_guide before any version raises (v1 needs no guide)")
backtest()
check("base" not in blob(1) and "guide" not in blob(1), "v1 has no base and no guide")

SRC.write_text(V2, encoding="utf-8")
ch = strategy.version_changes(NAME)
check(ch["base"] == 1 and all(j != 1 for c in ch["changes"] for j, _ in c["add"]),
      f"version_changes: base 1, the VERSION_NOTE line left out (got {ch})")
# V1 → V2 opcodes: line 2 replaced; lines 4 (STOP_PCT) → 4–5 (VOL_MA, STOP_ATR) replaced
ATR = {"title": "ATR 週期 10 改 14", "body": "看更長的波動，轉向變少。", "lines": [[2, 2]]}
VOL = {"title": "加上成交量濾網", "body": "量縮不進場。", "lines": [[4, 4]]}
STOP = {"title": "停損改 ATR 倍數", "body": "波動大時放寬。", "lines": [[5, 5]], "old_lines": [[4, 4]]}
check(raises(strategy.write_guide, NAME, [dict(ATR, title="x" * 61)]) is not None, "a 61-char title raises")
check(raises(strategy.write_guide, NAME, [ATR, {"title": "y", "body": "", "lines": [[7, 7]]}]) is not None,
      "an item covering only unchanged lines raises")
check(raises(strategy.write_guide, NAME, [ATR] * 7) is not None, "a 7th item raises")
check(raises(strategy.write_guide, NAME, [dict(ATR, lines=[[True, 2]])]) is not None, "a bool line number raises")

TOP = len(V2.splitlines())
for bad in ([[0, 1]], [[-1, 2]], [[1, TOP + 1]], [2, 2], 2, [[3, 2]]):
    check(raises(strategy.write_guide, NAME, [dict(ATR, lines=bad)]) is not None, f"lines={bad!r} raises")
strategy.write_guide(NAME, [dict(ATR, title="ATR\u202e 週期\u200b 改", body="a\u200d\nb")])
p = json.loads(PENDING.read_text(encoding="utf-8"))["items"][0]
check(p["title"] == "ATR 週期 改" and p["body"] == "a b",
      f"bidi override / zero-width characters dropped, whitespace collapsed (got {p['title']!r}, {p['body']!r})")

res = strategy.write_guide(NAME, [ATR, VOL])
check(res["unexplained"] == {"del": [4], "add": [5]},
      f"STOP_PCT→STOP_ATR unexplained when two items share its opcode (got {res['unexplained']})")
res = strategy.write_guide(NAME, [ATR, VOL, STOP])
check(res["unexplained"] == {"del": [], "add": []} and res["base"] == 1,
      f"old_lines claims the deletion; nothing unexplained (got {res})")
check(PENDING.exists(), "write_guide leaves the pending file")
backtest()
b2 = blob(2)
check(b2.get("base") == 1 and [g["title"] for g in b2.get("guide") or []] == [ATR["title"], VOL["title"], STOP["title"]],
      f"v2 blob carries base 1 and the three items in order (got base={b2.get('base')})")
idx2 = json.loads((VDIR / "index.json").read_text())
check(all("guide" not in i and "base" not in i for i in idx2["items"]), "index.json carries neither base nor guide")
check(not PENDING.exists(), "the mint consumed the pending guide")

# implicit deletion: one item owning the opcode's added lines takes its deleted line too
V3 = V2.replace("STOP_ATR = 2.0", "STOP_ATR = 2.5")
SRC.write_text(V3, encoding="utf-8")
res = strategy.write_guide(NAME, [{"title": "停損倍數 2 改 2.5", "body": "", "lines": [[5, 5]]}])
check(res["unexplained"] == {"del": [], "add": []}, f"the deletion follows the single owner (got {res})")
SRC.write_text(V3.replace("ATR_MULT = 3.0", "ATR_MULT = 2.5"), encoding="utf-8")   # edit after the guide
backtest()
check("guide" not in blob(3) and blob(3).get("base") == 2 and not PENDING.exists(),
      "a guide written before a further edit is not stored, and is consumed")

# base follows current, not n-1
strategy.restore(NAME, 1)
backtest()   # restore's re-run: same code as v1, mints nothing
check(json.loads((VDIR / "index.json").read_text())["current"] == 1, "restore + re-run stays on v1")
SRC.write_text(V1.replace("ATR_PERIOD = 10", "ATR_PERIOD = 12"), encoding="utf-8")
strategy.write_guide(NAME, [{"title": "ATR 週期 10 改 12", "body": "", "lines": [[2, 2]]}])
backtest()
b4 = blob(4)
check(b4.get("base") == 1 and len(b4.get("guide") or []) == 1, f"edit after restoring v1 → base 1 (got {b4.get('base')})")

# same code as the current version: nothing minted, the pending guide consumed anyway
cur_code = SRC.read_bytes()
PENDING.write_text(json.dumps({"v": 1, "base": 4, "code_hash": strategy.code_hash(cur_code),
                               "items": [ATR]}), encoding="utf-8")
before = json.loads((VDIR / "index.json").read_text())["counter"]
backtest()
check(json.loads((VDIR / "index.json").read_text())["counter"] == before and not PENDING.exists(),
      "a re-run without an edit mints nothing and deletes the pending guide")


def mint_with_pending(label, make):
    """Edit the file, plant a pending guide with `make`, backtest: a version must still be minted,
    without a guide, and the pending file must be gone."""
    global EDIT
    EDIT += 1
    SRC.write_text(V1.replace("ATR_PERIOD = 10", f"ATR_PERIOD = {20 + EDIT}"), encoding="utf-8")
    cur = json.loads((VDIR / "index.json").read_text())["current"]
    make(cur, strategy.code_hash(SRC.read_bytes()))
    c0 = json.loads((VDIR / "index.json").read_text())["counter"]
    try:
        backtest()
    except Exception as e:
        check(False, f"{label}: the backtest raised {type(e).__name__}")
        return
    idx_now = json.loads((VDIR / "index.json").read_text())
    n_new = idx_now["counter"]
    check(n_new == c0 + 1 and "guide" not in blob(n_new) and not os.path.lexists(PENDING),
          f"{label}: version minted without a guide, pending gone")


EDIT = 0
mint_with_pending("hand-edited items (hash and base right)", lambda cur, h: PENDING.write_text(
    json.dumps({"v": 1, "base": cur, "code_hash": h, "items": [{"title": "x", "lines": "all"}]}), encoding="utf-8"))
mint_with_pending("not JSON", lambda cur, h: PENDING.write_text("{not json", encoding="utf-8"))
mint_with_pending("nested 30k deep, under the size cap", lambda cur, h: PENDING.write_text("[" * 30000 + "]" * 30000, encoding="utf-8"))
mint_with_pending("over 64KB", lambda cur, h: PENDING.write_text(
    json.dumps({"v": 1, "base": cur, "code_hash": h, "items": [ATR], "pad": "x" * 70000}), encoding="utf-8"))
_real_load = strategy.load_json


def _deep(*a, **k):
    raise RecursionError("maximum recursion depth exceeded")   # what an older json parser does


def plant_recursing(cur, h):
    PENDING.write_text("[]", encoding="utf-8")
    strategy.load_json = _deep


try:
    mint_with_pending("a parser RecursionError", plant_recursing)
finally:
    strategy.load_json = _real_load
if os.path.exists("/dev/zero"):
    mint_with_pending("a symlink to /dev/zero", lambda cur, h: os.symlink("/dev/zero", PENDING))

# a VERSION_NOTE-only edit has nothing to explain
SRC.write_text(SRC.read_text(encoding="utf-8").replace('VERSION_NOTE = ""', 'VERSION_NOTE = "x"'), encoding="utf-8")
check(strategy.version_changes(NAME)["changes"] == [], "a VERSION_NOTE-only edit lists no change")

# rebuilt index (corrupt index.json) keeps base/guide out of the summary
(VDIR / "index.json").write_text("{not json")
SRC.write_text(V2, encoding="utf-8")
backtest()
idx5 = json.loads((VDIR / "index.json").read_text())
check(all("guide" not in i and "base" not in i for i in idx5["items"]),
      "an index rebuilt from the blobs carries neither base nor guide")

print("ALL PASS" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
