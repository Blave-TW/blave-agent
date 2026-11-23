"""Desktop 策略庫 picks get their source.json from the app, not from the agent remembering it.

shell/main.js libraryDownload records sha256(code) → listing id in state/library_picks.json;
lib/runner.py _claim_library_pick writes strategies/<name>/source.json on that code's first
backtest (after the version mint). Without it a desktop install the agent forgot to label is
treated as the user's own strategy (auto-iterate adopted a parameter plateau over a library pick).

  1. the record main.js's libPickRecord writes (run under node; SKIP without node) is the one the
     runner claims: fresh install → source.json {"marketplace_id": id}, record used up
  2. a re-install over the user's own strategy of the same name (an older version with other code)
     → no source.json, record used up
  3. a fork (other bytes) → no source.json, record left alone
  4. a source.json already there is not touched; a stale record (> 24 h) labels nothing
  5. one record labels one strategy: the same code run again under another name gets nothing

Run: python tests/check_library_pick_claim.py
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)
from lib import runner as R  # noqa: E402
from lib import strategy as S  # noqa: E402

red = []


def ok(name, cond, detail=""):
    print(("PASS  " if cond else "FAIL  ") + name + ("" if cond else "  " + str(detail)))
    if not cond:
        red.append(name)


WS = Path(tempfile.mkdtemp(prefix="libpick-"))
(WS / "state").mkdir()
R.LIBRARY_PICKS = WS / "state" / "library_picks.json"
S._REPO_ROOT = WS


def code(name, body="x = 1"):
    return f'STRATEGY_NAME = "{name}"\nDISPLAY_NAME = "美股類股輪動"\n{body}\n'.encode()


def picks():
    try:
        return json.loads(R.LIBRARY_PICKS.read_text())
    except FileNotFoundError:
        return {}


def record(src, sid, at=None):
    m = picks()
    m[hashlib.sha256(src).hexdigest()] = {"id": sid, "at": int((at or time.time()) * 1000)}
    R.LIBRARY_PICKS.write_text(json.dumps(m))


def backtest(name, src):
    """The runner's write tail for a backtest: mint the version, then claim."""
    d = WS / "strategies" / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "strategy.py").write_bytes(src)
    R._mint_version({"STRATEGY_NAME": name}, {}, "backtest", src)
    R._claim_library_pick(name, d, src)
    p = d / "source.json"
    return json.loads(p.read_text()) if p.exists() else None


def node_record(src, sid):
    """main.js's libPickRecord, cut out of the source and run with WS = the temp workspace."""
    node = shutil.which("node")
    if not node:
        return False
    js = Path(REPO, "shell", "main.js").read_text(encoding="utf-8")
    i = js.index("const LIB_PICKS_FILE")
    body = js[i:js.index("\n}\n", js.index("function libPickRecord", i)) + 3]
    prog = ("const fs=require('fs'),path=require('path'),crypto=require('crypto');"
            f"const wsfile=require({json.dumps(str(Path(REPO, 'shell', 'wsfile.js')))});"
            f"const WS={json.dumps(str(WS))};{body}"
            "libPickRecord(fs.readFileSync(0,'utf8'), Number(process.argv[1]));")
    subprocess.run([node, "-e", prog, str(sid)], input=src, check=True)
    return True


# 1
lib_src = code("us_sector_rotation")
if node_record(lib_src, 153):
    ok("1 main.js writes the file the runner reads", R.LIBRARY_PICKS.name == "library_picks.json"
       and hashlib.sha256(lib_src).hexdigest() in picks(), picks())
else:
    print("SKIP  1 main.js half (no node): recording from Python")
    record(lib_src, 153)
ok("1 fresh desktop install → source.json with the listing id",
   backtest("us_sector_rotation", lib_src) == {"marketplace_id": 153})
ok("1 …record used up", hashlib.sha256(lib_src).hexdigest() not in picks(), picks())
ok("1 a re-run (v2 not minted, same code) keeps it", backtest("us_sector_rotation", lib_src) == {"marketplace_id": 153})

# 2
mine = code("my_rotation", "x = 2")
backtest("my_rotation", mine)
lib2 = code("my_rotation", "x = 3")
record(lib2, 77)
ok("2 re-install over the user's own strategy of the same name → no source.json", backtest("my_rotation", lib2) is None)
ok("2 …record used up (cannot label it later)", hashlib.sha256(lib2).hexdigest() not in picks(), picks())

# 3
base = code("rsi_bb_reversal", "x = 4")
record(base, 101)
fork = code("rsi_bb_mine", "x = 4")
ok("3 a fork (own STRATEGY_NAME) → no source.json", backtest("rsi_bb_mine", fork) is None)
ok("3 …the pick's record is left for the pick", hashlib.sha256(base).hexdigest() in picks(), picks())

# 4
have = code("already", "x = 5")
(WS / "strategies" / "already").mkdir(parents=True)
(WS / "strategies" / "already" / "source.json").write_text('{"marketplace_id": 9}')
record(have, 10)
ok("4 source.json already written by the agent is not touched", backtest("already", have) == {"marketplace_id": 9})
old = code("old_pick", "x = 6")
record(old, 11, at=time.time() - 25 * 3600)
ok("4 a record older than 24 h labels nothing", backtest("old_pick", old) is None)

# 5
again = code("twice", "x = 7")
record(again, 12)
ok("5 first strategy with the code is labelled", backtest("twice", again) == {"marketplace_id": 12})
shutil.copytree(WS / "strategies" / "twice", WS / "strategies" / "twice_copy")
os.remove(WS / "strategies" / "twice_copy" / "source.json")
shutil.rmtree(WS / "strategies" / "twice_copy" / "versions")
ok("5 the same code again → nothing (record used up)", backtest("twice_copy", again) is None)

shutil.rmtree(WS, ignore_errors=True)
print(f"\n{len(red)} FAIL" if red else "\nALL PASS")
sys.exit(1 if red else 0)
