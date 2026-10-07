"""背景回測+假承諾回報(2026-10-03 事故;09-28 同一條路)。

回合結束時引擎追蹤的程序全被殺、沒有東西會再叫醒 agent。鎖:
  ① 稍後送達的引擎工具(Monitor / CronCreate / ScheduleWakeup / PushNotification / RemoteTrigger)在 disallowed_tools;
  ② run_in_background 一律拒絕;
  ③ 前景啟動回測/掃參、timeout 不到 min(這一輪 Bash 上限, 這一輪還剩的時間) 的拒絕;只有 nohup / setsid 開頭、
     結尾單一 & 的脫離放行(`& wait`、引號裡的 & 不算);python -X utf8 也認得;輪詢、讀檔、grep 不誤擋;
  ④ 上限在呼叫當下從 options.env 讀(續跑時整個 dict 換掉、上限變小),已用掉的時間要扣;
  ⑤ 拒絕理由只指向 python time.sleep 輪詢(單一指令,不串 `;`——AGENTS.md 的規矩);
  ⑥ ③ 的 timeout 不足:引擎夠新(init 的 claude_code_version ≥ 2.0.10)且 need_ms ≥ 300000 時改寫成 need_ms 放行
     (updatedInput 帶整個 input);引擎版本未知/太舊、need_ms 太小、run_in_background 照舊拒絕;
     排程回合的 _sched_bash_guard_hooks 同時掛著時它的 deny 不受影響。

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


def reason(tool_input, need_ms):
    return at.bg_guard_check(tool_input, need_ms)[1]


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
    t(f"③ launch, no timeout → deny: {cmd[:50]!r}", reason({"command": cmd}, CAP) is not None)
    t(f"③ launch, timeout 600000 → deny: {cmd[:50]!r}", reason({"command": cmd, "timeout": 600000}, CAP) is not None)
    t(f"③ launch, timeout = ceiling → allow: {cmd[:50]!r}", reason({"command": cmd, "timeout": CAP}, CAP) is None)
t("③ timeout as a string is read", reason({"command": LAUNCH[0], "timeout": str(CAP)}, CAP) is None)

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
    t(f"③ not a guarded launch → allow: {cmd[:50]!r}", reason({"command": cmd}, CAP) is None)
t("③ `&&` / `2>&1` are not detaching", reason({"command": ALLOW[-1]}, CAP) is not None)

for v in (True, "true"):
    t(f"② run_in_background={v!r} → deny, even for a plain command",
      reason({"command": "ls", "run_in_background": v}, CAP) is not None)
t("② run_in_background=False → allow", reason({"command": "ls", "run_in_background": False}, CAP) is None)

r = reason({"command": LAUNCH[0], "timeout": 600000}, CAP) + reason({"run_in_background": True}, CAP)
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

# ⑥ 改寫放行:引擎版本從 init 訊息來,hook 掛好之後才知道;版本未知就是上面那些 deny
t("⑥ engine version unknown at mount → still deny", at._ENGINE["cli_version"] is None
  and (run({"command": LAUNCH[0], "timeout": 600000}).get("hookSpecificOutput") or {}).get("permissionDecision") == "deny")
t("⑥ version floor is 2.0.10 (CHANGELOG: PreToolUse hooks can now modify tool inputs)",
  at.cli_supports_updated_input("2.0.10") and at.cli_supports_updated_input("2.1.281")
  and at.cli_supports_updated_input("2.1.281 (Claude Code)") and not at.cli_supports_updated_input("2.0.9")
  and not at.cli_supports_updated_input("1.0.120") and not at.cli_supports_updated_input(None)
  and not at.cli_supports_updated_input("garbage"))
t("⑥ rewrite floor is the resume floor (_RESUME_MIN_TOOL_SEC)", at._BG_REWRITE_MIN_MS == at._RESUME_MIN_TOOL_SEC * 1000)
at._ENGINE["cli_version"] = "2.1.281"
inp = {"command": LAUNCH[0], "timeout": 600000, "description": "run backtest"}
out = run(inp)
hs = out.get("hookSpecificOutput") or {}
t("⑥ timeout short, need_ms enough, engine new → allow + updatedInput with timeout = need_ms, whole input kept",
  hs.get("hookEventName") == "PreToolUse" and hs.get("permissionDecision") == "allow"
  and hs.get("updatedInput") == {**inp, "timeout": CAP} and "permissionDecisionReason" not in hs, out)
t("⑥ the original input is not mutated", inp["timeout"] == 600000)
hs = run({"command": LAUNCH[0]}).get("hookSpecificOutput") or {}
t("⑥ no timeout at all → rewritten too", hs.get("permissionDecision") == "allow"
  and (hs.get("updatedInput") or {}).get("timeout") == CAP, hs)
t("⑥ timeout already enough → untouched", run({"command": LAUNCH[0], "timeout": CAP}) == {})
t("⑥ not a launch → untouched", run({"command": "ls strategies/", "timeout": 60000}) == {})
for v in (True, "true"):
    hs = run({"command": LAUNCH[0], "run_in_background": v, "timeout": 600000}).get("hookSpecificOutput") or {}
    t(f"⑥ run_in_background={v!r} → still deny, never rewritten", hs.get("permissionDecision") == "deny"
      and "updatedInput" not in hs, hs)
o.env = {**o.env, "BASH_MAX_TIMEOUT_MS": "900000"}
hs = run({"command": LAUNCH[0], "timeout": 600000}).get("hookSpecificOutput") or {}
t("⑥ rewrite uses the ceiling read at call time (resume lowered it)", hs.get("permissionDecision") == "allow"
  and (hs.get("updatedInput") or {}).get("timeout") == 900000, hs)
o.env = {"BASH_MAX_TIMEOUT_MS": str(CAP)}
at.time.monotonic = lambda: real() + 1560      # 剩 2000 − 150 − 1560 = 290 s < 300 s 下限
try:
    hs = run({"command": LAUNCH[0], "timeout": 60000}).get("hookSpecificOutput") or {}
    rs = hs.get("permissionDecisionReason", "")
    t("⑥ need_ms below the floor → deny, no rewrite, told not to start this turn, no resendable timeout figure",
      hs.get("permissionDecision") == "deny" and "updatedInput" not in hs and "Do not start it in this turn" in rs
      and "When the job does not finish in the turn" in rs and not re.search(r"\d{4,}", rs), hs)
    t("⑥ …same text when the engine is too old to rewrite (the floor refusal does not depend on the version)",
      at.bg_guard_check({"command": LAUNCH[0], "timeout": 60000}, 290000)[1] == rs)
finally:
    at.time.monotonic = real
at.time.monotonic = lambda: real() + 1540      # 剩 310 s ≥ 300 s:改寫成剩下的
try:
    hs = run({"command": LAUNCH[0], "timeout": 60000}).get("hookSpecificOutput") or {}
    t("⑥ need_ms just above the floor → rewritten to what is left", hs.get("permissionDecision") == "allow"
      and 305000 <= (hs.get("updatedInput") or {}).get("timeout", 0) <= 310000, hs)
finally:
    at.time.monotonic = real
for v in ("2.0.9", "1.0.120", None, ""):
    at._ENGINE["cli_version"] = v
    hs = run({"command": LAUNCH[0], "timeout": 600000}).get("hookSpecificOutput") or {}
    t(f"⑥ engine {v!r} → deny, no rewrite", hs.get("permissionDecision") == "deny" and "updatedInput" not in hs, hs)
at._ENGINE["cli_version"] = "2.1.281"

# ⑥ 排程回合:兩道 hook 都掛在 PreToolUse/Bash;一條回測啟動指令同時碰到排程守門(lib/execute)時,
# 這道改寫放行、那道照 deny——引擎端 deny 贏,這裡只驗兩道各自的輸出沒被對方影響
o2 = _Options(env={"BASH_MAX_TIMEOUT_MS": str(CAP)})
at._mount_turn_hooks(o2, object(), True)
bash_hooks = [h for m in o2.hooks["PreToolUse"] if m["matcher"] == "Bash" for h in m["hooks"]]
t("⑥ scheduled turn mounts both Bash guards", len(bash_hooks) == 2, o2.hooks)
sched_cmd = "python3 strategies/x/strategy.py --with lib/execute.py"
outs = [asyncio.run(h({"tool_name": "Bash", "tool_input": {"command": sched_cmd, "timeout": 600000}}, "t2", None))
        for h in bash_hooks]
decisions = sorted((o_.get("hookSpecificOutput") or {}).get("permissionDecision") for o_ in outs)
t("⑥ one hook rewrites (allow), the scheduled guard still denies", decisions == ["allow", "deny"]
  and any(at.SCHED_BASH_DENY_REASON == (o_.get("hookSpecificOutput") or {}).get("permissionDecisionReason") for o_ in outs),
  outs)

# ⑥ init 訊息把引擎版本記進 _ENGINE(run_turn 的訊息迴圈;這裡只驗型別別名有掛上、欄位名對)
t("⑥ run_turn reads claude_code_version from the init SystemMessage",
  at._SYSTEM_MESSAGE is None   # stub SDK 沒有這個型別:程式必須用 getattr 容忍
  and 'getattr(msg, "data", None) or {}).get("claude_code_version")' in open(at.__file__, encoding="utf-8").read())

if fails:
    print(f"\n{len(fails)} FAILED")
    sys.exit(1)
print("\nall pass")
