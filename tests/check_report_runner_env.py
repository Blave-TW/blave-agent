"""Minimal check: report_runner._subprocess_env on the desktop (BLAVE_AGENT_LOCAL=1) passes what
a desktop strategy gets (command_listener._LOCAL_ENV_PASS — BLAVE_KLINE_SOURCE=binance among it,
so a scheduled crypto report reads Binance klines as a chat turn does) plus BLAVE_AGENT_LOCAL=1 and
the BLAVE_SCHEDULED_RUN=1 mark, and no other BLAVE_* (never the token, never the per-turn
BLAVE_DATA_ACCESS); a cloud machine (no flag) gets exactly what it got before. Both the
Linux/mac allowlist and the Windows denylist branch.

Run: cd blave-agent && .venv/bin/python tests/check_report_runner_env.py
"""
import ast
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))

import report_runner as R

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


def listener_pass():
    tree = ast.parse(open(os.path.join(ROOT, "runtime", "command_listener.py"), encoding="utf-8").read())
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(getattr(t, "id", "") == "_LOCAL_ENV_PASS" for t in node.targets):
            return ast.literal_eval(node.value)


check(R._LOCAL_ENV_PASS == listener_pass(), "runner's allowlist copy equals command_listener._LOCAL_ENV_PASS")

os.environ.update(BLAVE_PROXY_TOKEN="secret", BLAVE_DATA_ACCESS="1", BLAVE_KLINE_SOURCE="binance",
                  BLAVE_SCHEDULED_RUN="1", TZ="Asia/Taipei", PATH=os.environ.get("PATH", ""))
for system in ("Linux", "Darwin", "Windows"):
    R.platform.system = lambda s=system: s
    os.environ.pop("BLAVE_AGENT_LOCAL", None)
    env = R._subprocess_env()
    check(env.get("BLAVE_MODE") == "live" and not any(k.startswith("BLAVE_") and k != "BLAVE_MODE" for k in env)
          and "TZ" not in env,
          f"{system} cloud: only BLAVE_MODE — a stray BLAVE_SCHEDULED_RUN or BLAVE_KLINE_SOURCE never passes")
    os.environ["BLAVE_AGENT_LOCAL"] = "1"
    env = R._subprocess_env()
    blave = {k for k in env if k.startswith("BLAVE_")}
    check(env.get("BLAVE_AGENT_LOCAL") == "1" and env.get("BLAVE_SCHEDULED_RUN") == "1"
          and env.get("BLAVE_KLINE_SOURCE") == "binance" and blave <= set(R._LOCAL_ENV_PASS) | {
              "BLAVE_MODE", "BLAVE_AGENT_LOCAL", "BLAVE_SCHEDULED_RUN"} and "TZ" not in env,
          f"{system} desktop: BLAVE_AGENT_LOCAL, BLAVE_SCHEDULED_RUN, BLAVE_KLINE_SOURCE pass; token and "
          f"BLAVE_DATA_ACCESS do not ({sorted(blave)})")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
