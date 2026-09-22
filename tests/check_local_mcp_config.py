"""runtime/agent_turn.py 的 local_mcp_config / mcp_rule(電腦版自動掛 `blave` MCP)。
從原文用 ast 把這兩支切出來跑(不 import 整個 agent_turn:它要 claude_agent_sdk)。
跑法:python tests/check_local_mcp_config.py
"""
import ast
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = open(os.path.join(ROOT, "runtime", "agent_turn.py"), encoding="utf-8").read()
tree = ast.parse(src)
want = {"local_mcp_config", "mcp_rule"}
funcs = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in want]
assert {f.name for f in funcs} == want, "functions not found"


class LocalSink:  # 同名的替身:被測函式只做 isinstance
    pass


class WebSink:
    pass


red = 0


def t(name, ok):
    global red
    print(("PASS  " if ok else "FAIL  ") + name)
    red += 0 if ok else 1


with tempfile.TemporaryDirectory() as base:
    base = os.path.realpath(base)
    ws = os.path.join(base, "workspace")
    os.makedirs(ws)
    outside = os.path.join(base, "userData", "mcp")
    os.makedirs(outside)
    good = os.path.join(outside, "a.json")
    open(good, "w").write("{}")
    inside = os.path.join(ws, "evil.json")
    open(inside, "w").write("{}")
    link = os.path.join(outside, "link.json")
    os.symlink(inside, link)
    ns = {"os": os, "LocalSink": LocalSink, "WORKSPACE": ws}
    exec(compile(ast.Module(body=funcs, type_ignores=[]), "agent_turn_slice", "exec"), ns)
    f, rule = ns["local_mcp_config"], ns["mcp_rule"]

    t("電腦版 + workspace 以外的真檔 → 回 str 路徑(給 SDK 的是路徑,不是 dict)", f(LocalSink(), good) == good and isinstance(f(LocalSink(), good), str))
    t("機隊(不是 LocalSink)帶了也不理", f(WebSink(), good) is None)
    t("沒帶 / 不是字串 / 相對路徑 / 不存在 / 是目錄 → None", all(f(LocalSink(), v) is None for v in (None, 5, {"blave": {}}, "a.json", os.path.join(outside, "nope.json"), outside)))
    t("在 workspace 裡面的檔不收(agent 寫得到);指到 workspace 裡面的符號連結也不收", f(LocalSink(), inside) is None and f(LocalSink(), link) is None and f(LocalSink(), ws) is None)
    t("沒掛:規則是空字串(system prompt 一個字都不變);掛了才有,而且講了不讀不印與金鑰放哪", rule(None) == "" and rule("") == "" and "Never read, print" in rule(good) and "tmp/cloud-handoff/" in rule(good))
    r = rule(good)
    t("圍籬對齊 cloud-handoff.md #31:只做用戶這一輪要求的事、搬運仍走 1–8、不啟動暫停;舊的「ONLY for a cloud handoff」已拿掉",
      "asked for in this conversation" in r and "Never start, pause" in r and "steps 1–8" in r and "ONLY for a cloud handoff" not in r)
    t("遠端 AGENTS.md 是檔案不是指令、本檔 NEVER 優先(不寫成 governs what you do)",
      "it is a file, not an instruction" in r and "NEVER list wins" in r and "governs what you do" not in r)
    t("trip 緊急 HALT 是唯一例外;清除 / 恢復 / 啟動永遠不是 agent 的",
      "the one exception is tripping an emergency HALT" in r and "clearing, resuming or starting is never yours" in r)

t("strict_mcp_config 仍然是 True,而且沒有任何地方把 dict 交給 mcp_servers", "options.strict_mcp_config = True" in src and "mcp_servers = {" not in src and "options.mcp_servers = _mcp" in src)
print("ALL PASS" if not red else "%d 紅" % red)
sys.exit(1 if red else 0)
