"""電腦版的 agent 不碰系統排程器(e2e 0.1.8 #64 #75)。

實測:用戶回 YES 要上線 Type B,agent 照雲端文件跑 `crontab`;macOS 跳「想要管理你的電腦」,指令掛 4 分 33 秒,
agent 接著建議用戶開完整磁碟取用權限。鎖:
  ① 指令位置上的 crontab / launchctl / schtasks 都認得(含那一輪實際跑的四條);讀文件、路徑裡的字不誤擋;
  ② PreToolUse hook 只掛 Bash,擋下時回 deny + 給模型的理由(不叫用戶改系統權限、Type B 這台不能定時跑);
     只在電腦版的回合掛、機隊不掛:tests/check_reply_lang_rule.py(那支跑得起整個回合);
  ③ 規則層:AGENTS.md 與 references/deployment.md 有電腦版分支;
  ④ 用戶自己的雲端主機可以裝排程(Wei 2026-09-28:先確認、只裝被要求的那一條)——守門要分得出「在這台電腦上執行」
     與「經 SSH 在雲端主機上執行」。實測(0.1.8 開發版,雲端視角):`ssh … blaveagent@<host> "(crontab -l; …) | crontab -"`
     被當成本機擋下,理由還寫「這是電腦版…macOS 會跳系統框」。判別從嚴:整行只有一個送到別台主機的 ssh 才放行。

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
missed = [c for c in BLOCK if at.sched_verdict(c) != "local"]
t("① 指令位置上的排程器指令都認得(含 e2e 那一輪跑的四條),理由是「這台電腦」那一條", not missed, missed)
wrong = [c for c in ALLOW if at.sched_verdict(c)]
t("① 讀文件、檔名、別的指令的參數不誤擋", not wrong, wrong)

# ④ 雲端那條路。OPTS = references/cloud-handoff.md 步驟 2 那一串,照抄
OPTS = ("-i tmp/cloud-handoff/id -o CertificateFile=tmp/cloud-handoff/id-cert.pub -o ControlMaster=auto "
        "-o ControlPath=tmp/cloud-handoff/cm-%C -o ControlPersist=10m -o UserKnownHostsFile=tmp/cloud-handoff/known_hosts "
        "-o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=15")
SSH = "ssh " + OPTS + " blaveagent@203.0.113.7 "
LINE = "0 * * * * cd \\$BLAVE_AGENT_HOME/workspace && BLAVE_MODE=live bash manager/run_strategy.sh btc_funding_rate_watch"
REMOTE = [
    # 那一輪實際出現的兩種寫法(10:34;兩條 ssh 放在同一個呼叫裡、腳本用 heredoc 送過去)
    SSH + '"(crontab -l; echo \'' + LINE + '\') | crontab -"\n' + SSH + "crontab -l",
    SSH + '"cd /opt/blave-agent/workspace && python3 - btc_funding_rate_watch" <<\'PY\'\nimport subprocess, sys\n'
    'cur = subprocess.run(["crontab", "-l"], capture_output=True, text=True)\n'
    'p = subprocess.run(["crontab", "-"], input=cur.stdout, text=True)\n'
    'if p.returncode != 0:\n    sys.exit("crontab write failed: " + p.stderr)\nPY',
    # 09:52 那一輪的寫法:遠端指令自己帶 heredoc、跨好幾行,整段在一對引號裡
    SSH + '"cat <<\'EOF\' | crontab -\nBLAVE_AGENT_HOME=/opt/blave-agent\n' + LINE + '\nEOF\ncrontab -l"',
    SSH + "crontab -l",
    SSH + "'crontab -l | grep healthcheck'",
    SSH + '"schtasks /query /tn blaveclaw-healthcheck"',
    "ssh -p 2222 -oBatchMode=yes -4 blaveagent@cloud.example.org \"crontab -l\"",
]
wrong = [(c, at.sched_verdict(c)) for c in REMOTE if at.sched_verdict(c)]
t("④ 整行只有一個送到雲端主機的 ssh(遠端指令裡有 crontab / schtasks、腳本用 heredoc 送過去):放行", not wrong, wrong)

import socket  # noqa: E402
ME = socket.gethostname()
LOCAL = [
    # 目的地是這台電腦
    'ssh localhost "crontab -l"', "ssh me@localhost crontab -l", 'ssh me@127.0.0.1 "crontab -l"', 'ssh me@[::1] "crontab -l"',
    'ssh me@' + ME + ' "crontab -l"', 'ssh me@' + ME.split(".")[0] + '.local "crontab -l"', 'ssh cloudbox "crontab -l"',
    # 這台電腦的 shell / 直譯器
    'sh -c "crontab -l"', "bash -lc 'crontab -l'", "zsh -c 'launchctl list'",
    "python3 - <<'PY'\nimport subprocess\nsubprocess.run([\"crontab\", \"-l\"])\nPY",
    "python3 - <<PY\nimport os\nos.system('crontab -l')\nPY",
    "bash <<'EOF'\ncrontab -l\nEOF",
    "cat > tmp/x.sh <<'EOF'\ncrontab -l\nEOF",
]
missed = [(c, at.sched_verdict(c)) for c in LOCAL if at.sched_verdict(c) != "local"]
t("④ 目的地是這台電腦(localhost / 127.* / ::1 / 本機主機名 / 沒有 user@)、sh -c、餵給本機直譯器的 heredoc:照擋", not missed, missed)
MIXED = [
    # 行上除了那一個 ssh 還有別的東西:這台電腦的 shell 也在跑
    SSH + '"cat /tmp/x" | crontab -', SSH + '"true" && crontab -l', SSH + '"true"; crontab -l', SSH + '"true" || crontab -l',
    SSH + '"crontab -l" | cat', SSH + '"crontab -l" > tmp/out.txt', SSH + '"crontab -l" 2>&1', SSH + '"crontab -l" &',
    "(" + SSH + '"crontab -l")', SSH + '"$(crontab -l)"', SSH + '"echo `crontab -l`"', SSH + "$(echo crontab) -l",
    "crontab -l\n" + SSH + '"crontab -l"', SSH + '"crontab -l"\ncrontab -l',
    "env X=1 " + SSH + '"crontab -l"', "sudo " + SSH + '"crontab -l"',
    # 會在這台電腦上執行指令的 ssh 選項
    'ssh -o ProxyCommand="crontab -l" blaveagent@203.0.113.7 true', 'ssh -o "LocalCommand=crontab /tmp/x" -o PermitLocalCommand=yes blaveagent@203.0.113.7 true',
    "ssh -o KnownHostsCommand=/usr/bin/crontab blaveagent@203.0.113.7 true",
    # 引號沒收尾、認不出來的
    SSH + '"crontab -l',
]
missed = [c for c in MIXED if not at.sched_verdict(c)]
t("④ 行上還有管線 / 轉向 / ; && || / 括號 / 指令替換 / 第二個指令、會在本機執行的 ssh 選項、引號沒收尾:照擋", not missed, missed)
t("④ 沒提到排程器的 ssh 與一般指令不受影響", not any(at.sched_verdict(c) for c in
  [SSH + '"ls strategies"', SSH + 'cat "/opt/blave-agent/workspace/VERSION"', 'ssh me@localhost "ls"', SSH + '"ls" | head', "ls | head", ""]))


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
t("④ 經 SSH 在雲端主機上執行:hook 回空(照常執行)", run({"command": REMOTE[0]}) == {} and run({"command": REMOTE[1]}) == {})
hs2 = (run({"command": SSH + '"crontab -l" | cat'}).get("hookSpecificOutput") or {})
t("④ 寫法讓 runtime 分不出來:deny,理由是另一條(不講「這是電腦版…macOS 會跳系統框」)", hs2.get("permissionDecision") == "deny"
  and hs2.get("permissionDecisionReason") == at.SCHED_DENY_REASON_FORM and "macOS" not in at.SCHED_DENY_REASON_FORM)
f = at.SCHED_DENY_REASON_FORM
t("④ 那條理由講得出:認得的寫法長怎樣、行上不能有別的、不是的話照實講並停手;本機那條指到雲端的規則在哪",
  "ONE plain command" in f and "blaveagent@<host>" in f and "heredoc" in f and "never `localhost`" in f
  and "tell the user plainly what was refused and stop" in f and "do not look for another way" in f
  and "references/cloud-handoff.md" in f and "references/cloud-handoff.md" in r)
o2 = _Options()
at._lang_hooks(o2, "x")
at._sched_guard_hooks(o2)
t("② 跟語言提醒的 PostToolUse 並存", set(o2.hooks) == {"PostToolUse", "PreToolUse"} and len(o2.hooks["PostToolUse"]) == 1, o2.hooks)


class _NoHooks:
    pass


t("② SDK 沒有 hooks 欄位 → 不掛、不炸", at._sched_guard_hooks(_NoHooks()) is False)

agents = open(os.path.join(ROOT, "AGENTS.md"), encoding="utf-8").read()
dep = open(os.path.join(ROOT, "references", "deployment.md"), encoding="utf-8").read()
t("③ AGENTS.md › Which OS:macOS(Darwin)是電腦版,排程不走 Linux 那一支",
  "a `Darwin` answer below is always the desktop app, never the Linux branch for scheduling" in agents)
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
