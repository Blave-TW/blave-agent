"""AGENTS.md › Data Sources, step ②: the blave-quant skill is a cloud-machine thing, and the
desktop agent is told so instead of being told to look. The desktop workspace has no `skills/`
folder (the app copies only its official dirs; the daily skill_sync job is a cloud timer / task),
so "if installed" made the agent probe it — `ls skills` / a Grep on `workspace/skills` — and the
chat showed a failed step (2026-10-06 welcome-page e2e, both runs). The second half holds the
sentence to the facts: when the desktop starts shipping the skill, this fails and ② is rewritten.
Run: cd blave-agent && .venv/bin/python tests/check_desktop_no_skills_rule.py
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
read = lambda *p: open(os.path.join(ROOT, *p), encoding="utf-8").read()
fails = 0


def check(name, ok):
    global fails
    print(("PASS" if ok else "FAIL") + "  " + name)
    fails += not ok


rule = [l for l in read("AGENTS.md").splitlines() if l.startswith("For ANY market data")]
check("one Data Sources order line", len(rule) == 1)
rule = rule[0] if rule else ""
check("② is for cloud machines, still skipped silently when absent there",
      "② on a cloud machine only, `skills/blave-quant/SKILL.md` (skip silently if absent)" in rule)
check("the desktop app is told there is no skills/ folder and not to look for one",
      "the desktop app (`BLAVE_AGENT_LOCAL=1`) has no `skills/` folder, so skip ② there without looking for it" in rule)
check("nothing left that needs the folder probed", "if installed" not in rule)

main_js = read("shell", "main.js")
dirs = re.search(r"const OFFICIAL_DIRS = \[([^\]]*)\]", main_js)
check("the desktop app's official dirs are found and have no skills/",
      bool(dirs) and "lib" in dirs.group(1) and "skills" not in dirs.group(1))
check("neither the desktop shell nor its daemon runs the skill sync",
      "skill_sync" not in main_js and "skill_sync" not in read("runtime", "local_daemon.py"))

print("all ok" if not fails else "FAILED")
sys.exit(1 if fails else 0)
