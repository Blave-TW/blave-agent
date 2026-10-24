"""用戶時區進每輪附加說明(回覆模式 spec B3)。10-24 實測:模型說「不知道用戶時區」,或照範例猜台北時間。
鎖:有時區 → 一行「用戶時區：<tz>；資料與 log 是 UTC」排在用戶訊息前;沒設 → prompt 逐字不變;
電腦版(本機時鐘就是用戶時區、log 不是 UTC)不帶,續跑重建的 prompt 也帶同一個值。
跑法:python tests/check_turn_user_tz.py [agent_turn.py 路徑](路徑給突變複本用)
"""
import importlib.util
import os
import re
import sys
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "runtime", "agent_turn.py")
sys.path.insert(0, os.path.join(ROOT, "runtime"))
sdk = types.ModuleType("claude_agent_sdk")
sdk.__getattr__ = lambda name: type(name, (), {})  # 機隊外沒有 SDK;被測的都是純函式
sys.modules["claude_agent_sdk"] = sdk
spec = importlib.util.spec_from_file_location("agent_turn", path)
at = importlib.util.module_from_spec(spec)
spec.loader.exec_module(at)

red = 0


def t(name, ok, got=None):
    global red
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok or got is None else f"  → {got!r}"))
    red += 0 if ok else 1


LINE = "[用戶時區：Asia/Taipei；資料與 log 是 UTC]"
on = at.build_prompt("", [], "BTC 現在多少", report_fail_line="", user_tz="Asia/Taipei")
off = at.build_prompt("", [], "BTC 現在多少", report_fail_line="")
t("有時區 → 那一行在用戶訊息之前", LINE in on and on.index(LINE) < on.index("[使用者這次的訊息]"))
t("沒設 / 空字串 → prompt 逐字不變",
  off == at.build_prompt("", [], "BTC 現在多少", report_fail_line="", user_tz="")
  and "用戶時區" not in off)

src = open(path, encoding="utf-8").read()
run_turn = src[src.index("async def run_turn("):]
t("run_turn:電腦版不帶", "prompt_tz = None if _desktop_surface(sink) else user_tz" in run_turn)
t("run_turn:首輪與續跑的 build_prompt 都帶 prompt_tz",
  len(re.findall(r"build_prompt\(", run_turn)) == run_turn.count("user_tz=prompt_tz,") == 2)
t("run_turn:TZ env 用的是同一個讀到的值(只讀一次)",
  run_turn.count("strategy_reporter.read_timezone()") == 1 and 'turn_env["TZ"] = user_tz' in run_turn)

print("ALL PASS" if not red else f"{red} FAIL")
sys.exit(1 if red else 0)
