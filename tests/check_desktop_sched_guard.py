"""電腦版的 agent 不碰系統排程器(e2e 0.1.8 #64 #75)。

實測:用戶回 YES 要上線 Type B,agent 照雲端文件跑 `crontab`;macOS 跳「想要管理你的電腦」,指令掛 4 分 33 秒,
agent 接著建議用戶開完整磁碟取用權限。鎖:
  ① 指令位置上的 crontab / launchctl / schtasks 都認得(含那一輪實際跑的四條);讀文件、路徑裡的字不誤擋;
  ② PreToolUse hook 只掛 Bash,擋下時回 deny + 給模型的理由(不叫用戶改系統權限、Type B 這台不能定時跑);
     只在電腦版的回合掛、機隊不掛:tests/check_reply_lang_rule.py(那支跑得起整個回合);
  ③ 規則層:AGENTS.md 與 references/deployment.md 有電腦版分支。

跑法:cd blave-agent && python3 tests/check_desktop_sched_guard.py
"""
import asyncio, dataclasses, os, sys, tempfile, types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))
WS = tempfile.mkdtemp(prefix="check-sched-guard-ws-")
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


BLOCK = [
    "crontab -l 2>/dev/null",
    "crontab -l 2>&1",
    'TMP=$(mktemp)\ncrontab -l 2>/dev/null > "$TMP"\necho "5 * * * * x" >> "$TMP"\ncrontab "$TMP"',
    'printf "* * * * * echo test\\n" > /tmp/testcron\ntimeout 10 crontab /tmp/testcron\necho "exit:$?"',
    'crontab /tmp/testcron; echo "exit:$?"',
    "cd /tmp && crontab x",
    "(crontab -l; echo '* * * * * x') | crontab -",
    "echo x | crontab -",
    "/usr/bin/crontab -l",
    "sudo crontab -e",
    "FOO=1 crontab -l",
    'bash -c "crontab -l"',
    "launchctl load ~/Library/LaunchAgents/org.blave.x.plist",
    "launchctl bootstrap gui/501 x.plist",
    'schtasks /create /tn "blaveclaw-strategy-x" /tr "cmd /c x" /sc minute /mo 1 /f',
    "schtasks.exe /query",
    "SCHTASKS /query /fo csv",
    "echo $(crontab -l)",
    "echo `crontab -l`",
]
ALLOW = [
    "grep -n crontab references/deployment.md",
    'grep -n "Type B" references/deployment.md | head -40',
    "cat references/deployment.md 2>/dev/null | head -150",
    "ps aux | grep -i crontab | grep -v grep",
    "ls tmp/crontab_notes.txt",
    "python3 strategies/funding_rate_watch/strategy.py",
    "python3 manager/stop_strategy.py funding_rate_watch",
    'echo "this computer has no crontab schedule"',
    "cat strategies/my_crontab/strategy.py",
]
missed = [c for c in BLOCK if not at._SCHED_CMD_RE.search(c)]
t("① 指令位置上的排程器指令都認得(含 e2e 那一輪跑的四條)", not missed, missed)
wrong = [c for c in ALLOW if at._SCHED_CMD_RE.search(c)]
t("① 讀文件、檔名、別的指令的參數不誤擋", not wrong, wrong)


@dataclasses.dataclass
class _Options:
    hooks: object = None


o = _Options()
t("② 掛得上", at._sched_guard_hooks(o) is True)
pre = (o.hooks or {}).get("PreToolUse") or []
t("② PreToolUse、只對 Bash", len(pre) == 1 and pre[0]["matcher"] == "Bash", o.hooks)
guard = pre[0]["hooks"][0]


def run(tool_input):
    return asyncio.run(guard({"tool_name": "Bash", "tool_input": tool_input}, "t1", None))


out = run({"command": "crontab /tmp/testcron"})
hs = out.get("hookSpecificOutput") or {}
t("② 擋:deny + 理由", hs.get("hookEventName") == "PreToolUse" and hs.get("permissionDecision") == "deny"
  and hs.get("permissionDecisionReason") == at.SCHED_DENY_REASON, out)
r = at.SCHED_DENY_REASON
t("② 理由講得出:不改系統權限、不換方法重試、Type A/C 去自動下單頁、Type B 這台不能定時跑+兩個出口",
  "do not tell the user to change any system permission" in r and "Do not retry it another way" in r
  and "自動下單" in r and "cannot run on a schedule on this computer" in r
  and "cloud machine" in r and "run it once by hand" in r, r)
t("② 不擋的指令回空(照常執行)", run({"command": "ls strategies"}) == {} and run({}) == {} and run({"command": None}) == {})
o2 = _Options()
at._lang_hooks(o2, "x")
at._sched_guard_hooks(o2)
t("② 跟語言提醒的 PostToolUse 並存", set(o2.hooks) == {"PostToolUse", "PreToolUse"} and len(o2.hooks["PostToolUse"]) == 1, o2.hooks)


class _NoHooks:
    pass


t("② SDK 沒有 hooks 欄位 → 不掛、不炸", at._sched_guard_hooks(_NoHooks()) is False)

agents = open(os.path.join(ROOT, "AGENTS.md"), encoding="utf-8").read()
dep = open(os.path.join(ROOT, "references", "deployment.md"), encoding="utf-8").read()
t("③ AGENTS.md:電腦版不碰系統排程、不叫用戶改系統權限、指到 deployment.md",
  "BLAVE_AGENT_LOCAL=1" in agents and "crontab" in agents and "launchctl" in agents and "schtasks" in agents
  and "system permission" in agents and "references/deployment.md` › *Desktop app*" in agents)
j = dep.find("## Desktop app")
sec = dep[j:dep.find("\n## ", j + 1)] if j >= 0 else ""
t("③ deployment.md › Desktop app:在 Type A / Type B 流程之前,講清楚兩種類型各怎麼辦",
  0 <= j < dep.find("## Type A (Signal Strategy)") and "啟動下單" in sec and "Type B" in sec
  and "cannot run on a schedule on this computer" in sec and "cloud-handoff.md" in sec
  and "Reply YES" in sec and "Full Disk Access" in sec, sec[:400])

if fails:
    sys.exit(f"{len(fails)} failed: {fails}")
print("all passed")
