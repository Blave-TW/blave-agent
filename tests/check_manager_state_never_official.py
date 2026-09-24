"""Machine state under manager/ is never official and never committed (version
matrix V6-03, 2026-09-24).

Enumerates instead of trusting a list: every manager/<file> the runtime, lib
and manager code name as a data file (.json / .jsonl) must be
  - git-ignored (a `git add -A` cannot ship one machine's state), and
  - never official to manager/update_workspace.py (a committed one would be
    copied onto machines that lack it and read as "changed here" — blocking
    VERSION — on every machine that has its own).
And the other side: every file tracked under manager/ is still official, so the
rule cannot silently stop shipping code.

Run: cd blave-agent && .venv/bin/python tests/check_manager_state_never_official.py
"""
import glob
import importlib.util
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


spec = importlib.util.spec_from_file_location("update_workspace",
                                              os.path.join(ROOT, "manager", "update_workspace.py"))
uw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(uw)

NAME = r"[A-Za-z0-9_.]+\.(?:json|jsonl)"
PATTERNS = (re.compile(r"""['"]manager/(%s)['"]""" % NAME),
            re.compile(r"""['"]manager['"],\s*['"](%s)['"]""" % NAME))
found = set()
for pat in ("runtime/*.py", "lib/*.py", "manager/*.py"):
    for path in glob.glob(os.path.join(ROOT, pat)):
        src = open(path, encoding="utf-8", errors="replace").read()
        for rx in PATTERNS:
            found.update("manager/" + m for m in rx.findall(src))
found.add("manager/order_errors.json")  # the file V6-03 found in the working tree
check(len(found) >= 14, f"writers found under manager/: {sorted(found)}")

for rel in sorted(found):
    ignored = subprocess.run(["git", "-C", ROOT, "check-ignore", "-q", rel]).returncode == 0
    check(ignored and not uw.is_official(rel),
          f"{rel}: git-ignored ({ignored}) and never official ({not uw.is_official(rel)})")

for rel in ("manager/foo.json.tmp", "manager/new_state.json", "manager/executors/my_exec.py"):
    check(not uw.is_official(rel), f"{rel}: never official (state pattern / user module)")

tracked = subprocess.run(["git", "-C", ROOT, "ls-files", "manager"], capture_output=True,
                         text=True).stdout.split()
not_official = [t for t in tracked if not uw.is_official(t)]
check(tracked and not not_official,
      f"every tracked manager/ file is still official ({len(tracked)} files)"
      + (f" — dropped: {not_official}" if not_official else ""))
for rel in ("manager/reconciler.py", "manager/start_reconciler.sh", "lib/portfolio.py", "AGENTS.md"):
    check(uw.is_official(rel), f"{rel}: official")

print("\nFAILED" if fails else "\nall ok")
sys.exit(1 if fails else 0)
