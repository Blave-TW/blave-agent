"""The portfolio report carries the runtime and workspace VERSION, so the api can count
fleet adoption after a runtime promote (api `python -m openclaw.fleet_versions`).
Every sender (timer main(), web_bridge, telegram_bridge) goes through build_report(),
so the fields are there on every report, not only the timer's.

Run: cd blave-agent && .venv/bin/python tests/check_report_versions.py
"""
import os
import shutil
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = tempfile.mkdtemp(prefix="report-versions-")
WS = os.path.join(BASE, "workspace")
os.makedirs(os.path.join(WS, "manager"))
os.environ["BLAVE_AGENT_BASE"] = BASE
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.pop("BLAVE_AGENT_LOCAL", None)
sys.path.insert(0, os.path.join(ROOT, "runtime"))

import portfolio_reporter  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


try:
    with open(os.path.join(ROOT, "runtime", "VERSION"), encoding="utf-8") as f:
        runtime_v = f.read().strip()

    r = portfolio_reporter.build_report()
    check(r.get("runtime_version") == runtime_v, f"runtime_version == runtime/VERSION ({r.get('runtime_version')!r})")
    check("workspace_version" in r and r["workspace_version"] is None, "no workspace VERSION: workspace_version is None")

    with open(os.path.join(WS, "VERSION"), "w", encoding="utf-8") as f:
        f.write("2026-10-27-a\n")
    r = portfolio_reporter.build_report()
    check(r.get("workspace_version") == "2026-10-27-a", "workspace_version read from disk each report")

    os.remove(os.path.join(WS, "VERSION"))
    os.makedirs(os.path.join(WS, "VERSION"))
    r = portfolio_reporter.build_report()
    check(r.get("workspace_version") is None, "unreadable VERSION: None, report still built")
finally:
    shutil.rmtree(BASE, ignore_errors=True)

print("PASS" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
