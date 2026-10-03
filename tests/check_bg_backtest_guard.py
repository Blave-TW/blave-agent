"""背景回測+假承諾回報(2026-10-03 事故;09-28 同一條路)。

回合結束時引擎追蹤的程序全被殺、沒有東西會再叫醒 agent。鎖:
  ① 稍後送達的引擎工具(Monitor / CronCreate / ScheduleWakeup / PushNotification / RemoteTrigger)在 disallowed_tools;
  ② run_in_background 一律拒絕;
  ③ 前景啟動回測/掃參、timeout 不到 min(這一輪 Bash 上限, 這一輪還剩的時間) 的拒絕;只有 nohup / setsid 開頭、
     結尾單一 & 的脫離放行(`& wait`、引號裡的 & 不算);python -X utf8 也認得;輪詢、讀檔、grep 不誤擋;
  ④ 上限在呼叫當下從 options.env 讀(續跑時整個 dict 換掉、上限變小),已用掉的時間要扣;
  ⑤ 拒絕理由只指向 python time.sleep 輪詢(單一指令,不串 `;`——AGENTS.md 的規矩)。

跑法:cd blave-agent && python3 tests/check_bg_backtest_guard.py
"""
import asyncio, atexit, dataclasses, os, re, shutil, sys, tempfile, types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))
WS = tempfile.mkdtemp(prefix="check-bg-guard-ws-")
atexit.register(shutil.rmtree, WS, True)
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.setdefault("BLAVE_AGENT_DB", os.path.join(WS, "session.db"))
sdk = types.ModuleType("claude_agent_sdk")
sdk.HookMatcher = lambda matcher=None, hooks=None: {"matcher": matcher, "hooks": hooks}
sys.modules["claude_agent_sdk"] = sdk
import agent_turn as at  # noqa: E402

fails = []


def t(name, ok, got=None):
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok or got is None else f"  → {got!r}"))
    if not ok:
        fails.append(name)


CAP = 1800000
t("① later-delivery engine tools are disallowed",
  all(n in at.NO_LATER_TOOLS for n in ("Monitor", "CronCreate", "ScheduleWakeup", "PushNotification", "RemoteTrigger")),
  at.NO_LATER_TOOLS)

LAUNCH = [
    "python3 strategies/tw5/strategy.py",
    "BLAVE_MODE=backtest python3 strategies/tw5/strategy.py",
    "python3 strategies/tw5/scan.py 2>&1 | tail -20",
    "python -u strategies/x.py",
    "python3 -m lib.walk_forward x",
    'python3 -c "from lib.param_scan import scan_grid; scan_grid()"',
    'python3 -c "from lib import runner; runner.run()"',
    'python3 - <<\'EOF\'\nfrom lib.validation import mcpt\nEOF',
    "python.exe strategies\\x\\strategy.py",
    "python3 -X utf8 strategies/x/strategy.py",
    "python3 strategies/x/scan.py > tmp/x_scan.log 2>&1 &",
    "python3 strategies/x/strategy.py & wait",
    'python3 strategies/x/strategy.py --note "a&b"',
    "nohup python3 strategies/x/strategy.py & wait",
]
for cmd in LAUNCH:
    t(f"③ launch, no timeout → deny: {cmd[:50]!r}", at.bg_guard_reason({"command": cmd}, CAP) is not None)
    t(f"③ launch, timeout 600000 → deny: {cmd[:50]!r}", at.bg_guard_reason({"command": cmd, "timeout": 600000}, CAP) is not None)
    t(f"③ launch, timeout = ceiling → allow: {cmd[:50]!r}", at.bg_guard_reason({"command": cmd, "timeout": CAP}, CAP) is None)
t("③ timeout as a string is read", at.bg_guard_reason({"command": LAUNCH[0], "timeout": str(CAP)}, CAP) is None)

ALLOW = [
    "nohup python3 strategies/x/scan.py > tmp/x_scan.log 2>&1 &",
    "setsid python3 strategies/x/scan.py > tmp/x_scan.log 2>&1 &",
    "PYTHONUNBUFFERED=1 nohup python3 -X utf8 strategies/x/strategy.py > tmp/x.log 2>&1 &",
    "python3 -c \"import time; time.sleep(150); print(''.join(open('tmp/x_scan.log', encoding='utf-8', errors='replace').readlines()[-3:]))\"",
    "until grep -q 'Scan written' tmp/x_scan.log; do sleep 5; done",
    "grep -n mcpt lib/runner.py",
    "cat strategies/x/strategy.py",
    "python3 -c \"print(open('strategies/x/strategy.py').read())\"",
    "ls strategies/x/",
    "python3 strategies/x/strategy.py 2>&1 >> tmp/x.log && echo ok",
]
for cmd in ALLOW[:-1]:
    t(f"③ not a guarded launch → allow: {cmd[:50]!r}", at.bg_guard_reason({"command": cmd}, CAP) is None)
t("③ `&&` / `2>&1` are not detaching", at.bg_guard_reason({"command": ALLOW[-1]}, CAP) is not None)

for v in (True, "true"):
    t(f"② run_in_background={v!r} → deny, even for a plain command",
      at.bg_guard_reason({"command": "ls", "run_in_background": v}, CAP) is not None)
t("② run_in_background=False → allow", at.bg_guard_reason({"command": "ls", "run_in_background": False}, CAP) is None)

r = at.bg_guard_reason({"command": LAUNCH[0], "timeout": 600000}, CAP) + at.bg_guard_reason({"run_in_background": True}, CAP)
t("⑤ reasons give only the single-command python poll and the number, no chained shell loop",
  "time.sleep(150)" in r and str(CAP) in r and "until <" not in r and "do sleep" not in r and "; done" not in r
  and "Monitor" in r and "ScheduleWakeup" in r and "timeout 150" not in r, r)


@dataclasses.dataclass
class _Options:
    hooks: object = None
    env: object = None


o = _Options(env={"BASH_MAX_TIMEOUT_MS": str(CAP)})
t("④ mounts", at._bg_guard_hooks(o) is True)
guard = o.hooks["PreToolUse"][0]["hooks"][0]


def run(inp):
    return asyncio.run(guard({"tool_name": "Bash", "tool_input": inp}, "t1", None))


hs = run({"command": LAUNCH[0], "timeout": 600000}).get("hookSpecificOutput") or {}
t("④ deny + reason", o.hooks["PreToolUse"][0]["matcher"] == "Bash" and hs.get("permissionDecision") == "deny"
  and "references/deployment.md" in hs.get("permissionDecisionReason", ""), hs)
t("④ allowed → {}", run({"command": LAUNCH[0], "timeout": CAP}) == {} and run({}) == {})
o.env = {**o.env, "BASH_MAX_TIMEOUT_MS": "900000"}   # resume: a new dict, lower ceiling
t("④ ceiling read at call time (resume replaced options.env)", run({"command": LAUNCH[0], "timeout": 900000}) == {}
  and "900000" in ((run({"command": LAUNCH[0], "timeout": 600000}).get("hookSpecificOutput") or {})
                   .get("permissionDecisionReason", "")))
# 回合已用掉 1500 s:剩 2000 − 150 − 1500 = 350 s,要求降到 350000,不再要求整個上限
o.env = {"BASH_MAX_TIMEOUT_MS": str(CAP)}
real = at.time.monotonic
at.time.monotonic = lambda: real() + 1500
try:
    left = run({"command": LAUNCH[0], "timeout": 300000})
    t("④ time already used is subtracted: 350000 left → 300000 refused, naming ~350000, 350000 allowed",
      bool(re.search(r"set to 3(?:49|50)\d{3}\b", left["hookSpecificOutput"]["permissionDecisionReason"])),
      left)
    t("④ …and a timeout covering what is left passes", run({"command": LAUNCH[0], "timeout": 351000}) == {})
finally:
    at.time.monotonic = real

if fails:
    print(f"\n{len(fails)} FAILED")
    sys.exit(1)
print("\nall pass")
