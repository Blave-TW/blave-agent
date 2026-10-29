"""雲端交接子資料夾名(`tmp/cloud-handoff/<turn>/`)兩端同一組規則:runtime `handoff_folder` 收的,api `get_ssh_access(handoff_dir)`
也要收,反之亦然——只改一邊的話 agent 照提示帶的名字會被 api 擋掉,或 runtime 退回共用的 "turn"。
api 在 monorepo 旁邊(../api)或 BLAVE_API_DIR;都找不到就 SKIP(同 check_sdk_pin 的做法)。
跑法:python3 tests/check_handoff_dir_parity.py
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))
api_dir = os.environ.get("BLAVE_API_DIR") or os.path.join(os.path.dirname(ROOT), "api")
api_file = os.path.join(api_dir, "mcp_byoa", "server.py")
if not os.path.exists(api_file):
    print("SKIP  api 不在旁邊(設 BLAVE_API_DIR 指到 api checkout)")
    sys.exit(0)
src = open(api_file, encoding="utf-8").read()
m = re.search(r'_HANDOFF_DIR_RE = re\.compile\(r"([^"]+)"\)', src)
red = 0


def t(name, ok, d=None):
    global red
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok or d is None else "  " + str(d)))
    red += 0 if ok else 1


t("api 有 _HANDOFF_DIR_RE", bool(m))
api_re = re.compile(m.group(1)) if m else None
rt = open(os.path.join(ROOT, "runtime", "agent_turn.py"), encoding="utf-8").read()
r = re.search(r'def handoff_folder\(session_id\):[\s\S]*?re\.fullmatch\(r"([^"]+)", session_id\)', rt)
t("runtime handoff_folder 的規則找得到", bool(r))
if api_re and r:
    t("兩邊的字元集與上限字面相同", m.group(1) == r.group(1), (m.group(1), r.group(1)))
    import ast
    fn = next(n for n in ast.parse(rt).body if isinstance(n, ast.FunctionDef) and n.name == "handoff_folder")
    ns = {"re": re}
    exec(compile(ast.Module(body=[fn], type_ignores=[]), "agent_turn_slice", "exec"), ns)
    handoff_folder = ns["handoff_folder"]
    for v in ["desktop-ab12cd34", "d" * 64, "d" * 65, "a_b-C9", "", "../x", "a b", "é"]:
        rt_ok = handoff_folder(v) == v
        api_ok = bool(api_re.fullmatch(v))
        t(f"同一個值兩邊判斷一致:{v[:20]!r}", rt_ok == api_ok, (rt_ok, api_ok))
print(("\n%d 紅" % red) if red else "\nALL PASS")
sys.exit(1 if red else 0)
