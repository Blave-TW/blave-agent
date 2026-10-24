"""stats.json is written one top-level key per line with compact values (lib.runner._write_stats):
json.dump(indent=2) runs the pure-Python encoder and cost ~2.35 s on a 4.7 MB 1h backtest
(Python 3.10); compact json.dumps hits the C encoder. Pins: same parsed content as the old
indent=2 file, one line per key (grep '"Benchmark Return' returns one line, not megabytes), and
the tmp + replace guarantee (a failed write leaves the old file and no tmp behind).

Run: cd blave-agent && .venv/bin/python tests/check_stats_json_write.py
"""
import json
import math
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("MPLBACKEND", "Agg")
import lib.runner as R

fails = []


def ok(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + ("" if cond or not detail else f"  → {detail}"))
    if not cond:
        fails.append(name)


def canon(obj):
    # NaN != NaN, so compare the re-serialised form (key order kept)
    return json.dumps(obj, allow_nan=True)


stats = {
    "Start": "2022-01-01 00:00:00",
    "Return [%]": 123.456789,
    "Benchmark Return [%]": -12.5,
    "Sharpe Ratio": float("nan"),
    "Profit Factor": float("inf"),
    "Worst": float("-inf"),
    "# Trades": 42,
    "Name": "台指期 超級趨勢 \"quoted\" \\ back",
    "Equity Curve": [[1640995200000, 1.0], [1641002400000, 1.0123], [1641009600000, None]],
    "Trades": [{"entry": 1, "pnl": -0.5, "tag": "多"}, {"entry": 2, "pnl": 1e-12, "tag": "空"}],
    "Nested": {"a": {"b": [1, 2.5, [3, "x"]]}, "empty": {}, "emptyl": []},
    "Bool": True,
    "Null": None,
    "MCPT p": 0.012,
    "Generated At": 1761264000,
}

tmp = tempfile.mkdtemp(prefix="stats-json-write-")
old_dir = os.path.join(tmp, "old"); new_dir = os.path.join(tmp, "new")
os.makedirs(old_dir); os.makedirs(new_dir)
R._write_json_atomic(os.path.join(old_dir, "stats.json"), stats, indent=2)
R._write_stats(new_dir, stats)
new_path = os.path.join(new_dir, "stats.json")
old_text = open(os.path.join(old_dir, "stats.json"), encoding="utf-8").read()
new_text = open(new_path, encoding="utf-8").read()

old_obj, new_obj = json.loads(old_text), json.loads(new_text)
ok("新舊 json.loads 完全相等(含 NaN/±inf、中文、巢狀、key 順序)",
   canon(old_obj) == canon(new_obj) and list(old_obj) == list(new_obj) == list(stats))
ok("NaN / inf 照舊寫成 NaN / Infinity", math.isnan(new_obj["Sharpe Ratio"]) and new_obj["Profit Factor"] == math.inf)
ok("ensure_ascii 維持預設(中文跟舊檔一樣轉 \\u)", "\\u53f0" in new_text and "台" not in new_text)

lines = new_text.split("\n")
ok("第一行 {、最後一行 }、結尾換行", lines[0] == "{" and lines[-2] == "}" and lines[-1] == "")
body = lines[1:-2]
ok("每個頂層 key 一行", len(body) == len(stats)
   and all(json.loads("{" + ln.rstrip(",") + "}").keys() == {k} for ln, k in zip(body, stats)),
   f"{len(body)} 行 vs {len(stats)} key")
ok("grep '\"Benchmark Return' 只回一行", sum('"Benchmark Return' in ln for ln in lines) == 1)

empty_dir = os.path.join(tmp, "empty"); os.makedirs(empty_dir)
R._write_stats(empty_dir, {})
ok("空 dict 也是合法 JSON", json.load(open(os.path.join(empty_dir, "stats.json"))) == {})

before = open(new_path, encoding="utf-8").read()
orig_replace = R.atomic_replace
def boom(src, dst):
    raise OSError("simulated replace failure")
R.atomic_replace = boom
try:
    raised = False
    try:
        R._write_stats(new_dir, {"Return [%]": 1.0})
    except OSError:
        raised = True
finally:
    R.atomic_replace = orig_replace
ok("replace 失敗 → 例外往上拋、tmp 刪掉、原檔不動",
   raised and not os.path.exists(new_path + ".tmp") and open(new_path, encoding="utf-8").read() == before)

raised = False
try:
    R._write_stats(new_dir, {"bad": object()})
except TypeError:
    raised = True
ok("無法序列化的值 → TypeError、原檔不動、沒留 tmp",
   raised and not os.path.exists(new_path + ".tmp") and open(new_path, encoding="utf-8").read() == before)

if fails:
    print(f"\n{len(fails)} FAIL")
    sys.exit(1)
print("\nall PASS")
