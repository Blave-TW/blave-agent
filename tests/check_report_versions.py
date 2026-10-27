"""The portfolio report carries the runtime and workspace VERSION, so the api can count
fleet adoption after a runtime promote (api `python -m openclaw.fleet_versions`).
Every sender (timer main(), web_bridge, telegram_bridge) goes through build_report(),
so the fields are there on every report, and each says which sender it is (`reporter`):
the bridges are long-lived and write the same api key as the timer.

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

    with open(os.path.join(WS, "VERSION"), "w", encoding="utf-8-sig") as f:
        f.write("2026-10-27-b\n")
    r = portfolio_reporter.build_report()
    check(r.get("workspace_version") == "2026-10-27-b", "BOM in VERSION: dropped, not sent as part of the version")
    import strategy_reporter
    check(strategy_reporter._config_version() == "2026-10-27-b", "strategy_reporter config_version: same reader, BOM dropped")

    check("reporter" not in portfolio_reporter.build_report(), "no reporter given (desktop daemon): no reporter key")
    check(portfolio_reporter.build_report(reporter="web_bridge").get("reporter") == "web_bridge", "reporter passed through")
    srcs = {n: open(os.path.join(ROOT, "runtime", n), encoding="utf-8").read()
            for n in ("portfolio_reporter.py", "web_bridge.py", "telegram_bridge.py")}
    check('build_report(reporter="timer")' in srcs["portfolio_reporter.py"], "timer main() says timer")
    check('build_report(reporter="web_bridge")' in srcs["web_bridge.py"], "web_bridge says web_bridge")
    check('build_report(reporter="telegram_bridge")' in srcs["telegram_bridge.py"], "telegram_bridge says telegram_bridge")
    check(all(s.count("build_report()") == 0 for n, s in srcs.items() if n != "portfolio_reporter.py"),
          "no bridge sends a report without saying who it is")

    import atomic_file
    import builtins
    sizes, real_open = [], builtins.open

    class _Spy:
        def __init__(self, f):
            self.f = f

        def __enter__(self):
            return self

        def __exit__(self, *a):
            self.f.close()

        def read(self, n=-1):
            sizes.append(n)
            return self.f.read(n)

    with open(os.path.join(WS, "VERSION"), "w", encoding="utf-8") as f:
        f.write("1.2.3" + " " * 100000)
    builtins.open = lambda *a, **k: _Spy(real_open(*a, **k))
    try:
        v = atomic_file.read_version(os.path.join(WS, "VERSION"))
    finally:
        builtins.open = real_open
    check(v == "1.2.3" and sizes and all(0 <= n <= 64 for n in sizes),
          f"only the first 64 bytes of VERSION are read (reads {sizes})")

    os.remove(os.path.join(WS, "VERSION"))
    os.makedirs(os.path.join(WS, "VERSION"))
    r = portfolio_reporter.build_report()
    check(r.get("workspace_version") is None, "unreadable VERSION: None, report still built")
finally:
    shutil.rmtree(BASE, ignore_errors=True)

print("PASS" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
