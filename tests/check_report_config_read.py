"""The report's `config` must tell "no portfolio_config.json" ({}) apart from "there but
unreadable" (None). A client that saves the whole amounts map from the report would
otherwise read a failed parse as "no amounts yet" and overwrite every key on the machine.

Run: cd blave-agent && .venv/bin/python tests/check_report_config_read.py
"""
import json
import os
import shutil
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = tempfile.mkdtemp(prefix="report-config-")
WS = os.path.join(BASE, "workspace")
os.makedirs(os.path.join(WS, "manager"))
os.environ["BLAVE_AGENT_BASE"] = BASE
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.pop("BLAVE_AGENT_LOCAL", None)
sys.path.insert(0, os.path.join(ROOT, "runtime"))

import portfolio_reporter  # noqa: E402

CFG = os.path.join(WS, "manager", "portfolio_config.json")
fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


try:
    check(portfolio_reporter.build_report()["config"] == {}, "no file: config == {}")

    with open(CFG, "w", encoding="utf-8") as f:
        f.write('{"amounts": {"a": 1')
    check(portfolio_reporter.build_report()["config"] is None, "truncated JSON: config is None")

    with open(CFG, "w", encoding="utf-8") as f:
        f.write("[]")
    check(portfolio_reporter.build_report()["config"] is None, "non-object JSON: config is None")

    good = {"amounts": {"a": 100, "b": 0}, "self_ledger": True}
    with open(CFG, "w", encoding="utf-8") as f:
        json.dump(good, f)
    r = portfolio_reporter.build_report()
    check(r["config"] == good and r["self_ledger"] is True, "readable file: config verbatim")
finally:
    shutil.rmtree(BASE, ignore_errors=True)

print("PASS" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
