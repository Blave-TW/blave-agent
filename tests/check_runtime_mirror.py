"""Drift guard for api/openclaw/agent_pure.py.

`strategy_consts` and `parse_cron` are needed on both sides of the release
boundary — the runtime ships to machines as a tarball and cannot import api
code; api cannot import the runtime once they live in separate repos. So api
keeps a verbatim mirror in `openclaw/agent_pure.py`, and this test is what makes
"verbatim" true: it goes red the moment either copy is edited alone.

Owner of the originals: this repo's runtime/; the mirror lives in the api checkout.
Run: cd blave-agent && .venv/bin/python tests/check_runtime_mirror.py
"""
import ast
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNTIME_DIR = os.path.join(ROOT, "runtime")  # 擁有者在本地
MIRROR = os.path.join(ROOT, "..", "api", "openclaw", "agent_pure.py")
if not os.path.isfile(MIRROR):
    sys.exit("needs the monorepo layout (../api/openclaw/agent_pure.py)")

# name -> source file that owns it
OWNED = {
    "strategy_consts": "strategy_reporter.py",
    "parse_cron": "report_runner.py",
    # module-level constants the two functions read; a silent edit to one of
    # these changes behaviour without touching a function body
    "FIELDS": "strategy_reporter.py",
    "_FALLBACK_RE": "strategy_reporter.py",
    "_FIELD_RANGES": "report_runner.py",
    "_CRON_FIELD_RE": "report_runner.py",
}


def segments(path):
    """{name: normalised source} for every top-level def/assign in `path`."""
    src = open(path, encoding="utf-8").read()
    tree = ast.parse(src)
    out = {}
    for node in tree.body:
        names = []
        if isinstance(node, ast.FunctionDef):
            names = [node.name]
        elif isinstance(node, ast.Assign):
            names = [t.id for t in node.targets if isinstance(t, ast.Name)]
        for n in names:
            # ast.unparse drops comments and normalises formatting, so a
            # re-wrapped line is not a false alarm but a changed expression is
            out[n] = ast.unparse(node)
    return out


mirror = segments(MIRROR)
fails = 0
for name, owner_file in OWNED.items():
    owner = segments(os.path.join(RUNTIME_DIR, owner_file))
    if name not in owner:
        print(f"FAIL  {name} 不在 runtime/{owner_file} 裡了 — 鏡像失去來源")
        fails += 1
        continue
    if name not in mirror:
        print(f"FAIL  {name} 不在 api/openclaw/agent_pure.py 裡")
        fails += 1
        continue
    if owner[name] != mirror[name]:
        print(f"FAIL  {name} 兩邊不一致(runtime/{owner_file} vs api/openclaw/agent_pure.py)")
        fails += 1
    else:
        print(f"ok    {name} 與 runtime/{owner_file} 一致")

sys.exit("check_runtime_mirror: FAIL" if fails else print("all ok"))
