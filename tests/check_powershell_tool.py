"""Windows without Git for Windows: the Claude Code CLI has no Bash tool and gives PowerShell instead
(win-e2e-0.1.39 F2 — 1.1.149's chat_tools whitelist left PowerShell out, so those machines had no shell at all).

  ① chat_tools: PowerShell on win32 (next to Bash), never elsewhere; the scheduled turn still blocks it
  ② every hook whose matcher covers Bash covers PowerShell too — enumerated twice: every _add_hook call in
     agent_turn.py's source, and every matcher actually mounted on a desktop and a cloud turn (≥ 4 shell guards)
  ③ each shell guard denies the PowerShell form of what it denies in Bash, and lets reads through
     (backtick escapes removed first; aliases like `ri` only where a PowerShell command starts — as bare words they
     are grep flags); copy / archive verbs on credentials/, .NET and download writes, `-EncodedCommand`; quoted
     interpreter paths and the py launcher for the backtest-timeout guard; Write-Output / Select-String text passes
  ③b the Bash tool keeps 82f71b37's decision on a fixed set of everyday commands (one intended change, listed)
  ④ the status-line / touched-strategy classifiers read a PowerShell command like a Bash one
  ⑤ git_bash_path finds Git Bash the way the bundled CLI does (the CLAUDE_CODE_USE_POWERSHELL_TOOL pin)
KNOWN_GAPS pins what still passes (Start-Process detach, Start-Job, names assembled at run time, folder globs).

Run: cd blave-agent && .venv/bin/python tests/check_powershell_tool.py
"""
import ast, asyncio, atexit, dataclasses, os, re, shutil, sys, tempfile, types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))
WS = tempfile.mkdtemp(prefix="check-powershell-tool-")
atexit.register(shutil.rmtree, WS, True)
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.setdefault("BLAVE_AGENT_DB", os.path.join(WS, "session.db"))
os.environ.setdefault("BLAVE_AGENT_STATE", os.path.join(WS, "state"))
sdk = types.ModuleType("claude_agent_sdk")
sdk.HookMatcher = lambda matcher=None, hooks=None: {"matcher": matcher, "hooks": hooks}
sys.modules["claude_agent_sdk"] = sdk
import agent_turn as at  # noqa: E402

fails = []


def t(name, ok, got=None):
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok or got is None else f"  → {got!r}"))
    if not ok:
        fails.append(name)


def covers(matcher, tool):
    """The CLI reads a hook matcher as a regex over the tool name; None / "" / "*" = every tool."""
    return matcher in (None, "", "*") or re.fullmatch(matcher, tool) is not None


class _Win32:
    def __init__(self, on):
        self.on = on

    def __enter__(self):
        self.real = at._win32
        at._win32 = lambda: self.on

    def __exit__(self, *_):
        at._win32 = self.real


# ── ① tools= ──
for on in (True, False):
    with _Win32(on):
        lists = {k: at.chat_tools(*k) for k in ((None, False), (None, True), ("on", True), ("off", False))}
    if on:
        t("① win32: every chat tools= list has PowerShell next to Bash",
          all("PowerShell" in v and "Bash" in v for v in lists.values()), lists)
    else:
        t("① not win32: no chat tools= list has PowerShell", all("PowerShell" not in v for v in lists.values()), lists)
t("① the scheduled turn still blocks PowerShell", "PowerShell" in at.SCHED_BLOCKED_TOOLS)

# ── ② enumerate: every hook that sees Bash sees PowerShell ──
src_path = os.path.join(ROOT, "runtime", "agent_turn.py")
tree = ast.parse(open(src_path, encoding="utf-8").read())
calls = []
for node in ast.walk(tree):
    if isinstance(node, ast.Call) and getattr(node.func, "id", None) == "_add_hook" and len(node.args) >= 3:
        m = node.args[2]
        if isinstance(m, ast.Constant):
            val = m.value
        elif isinstance(m, ast.Name):
            val = getattr(at, m.id, "<unresolved %s>" % m.id)
        else:
            val = "<expr line %d>" % node.lineno
        calls.append((node.lineno, val))
shell_calls = [(ln, v) for ln, v in calls if covers(v, "Bash") and v is not None]
t("② source: _add_hook calls found (≥ 4 Bash guards + the matcher-less ones)", len(shell_calls) >= 4, calls)
t("② source: every _add_hook matcher that covers Bash covers PowerShell",
  all(covers(v, "PowerShell") for _, v in calls if isinstance(v, str) and covers(v, "Bash")),
  [(ln, v) for ln, v in calls if isinstance(v, str) and covers(v, "Bash") and not covers(v, "PowerShell")])
t("② source: no matcher left unresolved", all(not (isinstance(v, str) and v.startswith("<")) for _, v in calls), calls)


@dataclasses.dataclass
class _Options:
    hooks: object = None
    env: object = None


class _Remote:
    pass


def mounted(sink):
    o = _Options()
    at._mount_turn_hooks(o, sink, "hi", None)
    return [(ev, m["matcher"], m["hooks"][0]) for ev, ms in (o.hooks or {}).items() for m in ms]


with _Win32(True):
    local = mounted(at.LocalSink.__new__(at.LocalSink))
    remote = mounted(_Remote())
names = lambda hs: {fn.__qualname__.split(".")[0] for _, m, fn in hs if m is not None and covers(m, "Bash")}  # noqa: E731
GUARDS = {"_bg_guard_hooks", "_cred_bash_guard_hooks", "_secret_code_bash_guard_hooks", "_sched_guard_hooks"}
t("② desktop turn mounts the four shell guards", names(local) == GUARDS, names(local))
t("② cloud turn mounts the three every-turn shell guards", names(remote) == GUARDS - {"_sched_guard_hooks"}, names(remote))
t("② mounted: every hook that covers Bash covers PowerShell",
  all(covers(m, "PowerShell") for _, m, _ in local + remote if covers(m, "Bash")),
  [(ev, m, fn.__qualname__) for ev, m, fn in local + remote if covers(m, "Bash") and not covers(m, "PowerShell")])
t("② the shell matcher does not swallow other tools", not any(covers(at.SHELL_TOOL_MATCHER, n) for n in (
    "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "BashOutput", "mcp__x__Bash")))

# ── ③ the guards read PowerShell commands ──
guards = {fn.__qualname__.split(".")[0]: fn for _, m, fn in local if m is not None and covers(m, "PowerShell")}
at._ENGINE["cli_version"] = "2.1.281"


def decide(guard, tool_input, tool="PowerShell"):
    if isinstance(tool_input, str):
        tool_input = {"command": tool_input, "timeout": 120000}
    out = asyncio.run(guards[guard]({"tool_name": tool, "tool_input": tool_input}, "t", None))
    hs = out.get("hookSpecificOutput") or {}
    return (hs.get("permissionDecision") or "-") + (":rewrite" if "updatedInput" in hs else "")


CRED, SECRET, SCHED, BG = "_cred_bash_guard_hooks", "_secret_code_bash_guard_hooks", "_sched_guard_hooks", "_bg_guard_hooks"
DENY = {
    CRED: [r"Get-Content ..\credentials\capital_vault.json", r"type ..\credentials\*", r"type ..\credentials\[c]apital_vault.jso[n]",
           r"Copy-Item ..\credentials\president.pfx tmp\x.pfx", r"type ..\CREDEN~1\capital_vault.json", r"type ..\credentials\CAPITA~1.JSO", r"Get-Content ..\CREDEN~1\PRESID~1.PFX", r"Get-Content ..\CREDEN~1\*",
           # P2-4: the folder after a copy / archive verb
           r"Copy-Item -Recurse ..\credentials tmp\c", r"Compress-Archive -Path ..\credentials -DestinationPath tmp\c.zip",
           r"robocopy ..\credentials tmp\c /E", r"xcopy ..\credentials tmp\c /E /I", "tar -czf tmp/c.tgz ../credentials",
           r"cpi -Recurse ..\CREDEN~1 tmp\c", r"Copy-Item ..\credentials\rdp_password.txt tmp\x.txt"],
    SECRET: [r"Set-Content lib\capital_vault.py 'x'", r"Remove-Item lib\order_capital.py", r"'x' | Out-File lib\capital_worker.py",
             r"ri lib\capital_vault.py", r"sc lib\president_vault.py 'x'", r"$x = ni lib\order_president.py",
             r"Get-Date; rni lib\account_capital.py x.py", r"& mi lib\capital_vault.py tmp\x.py",
             r"[IO.File]::WriteAllText('lib\capital_vault.py', 'x')", r"Set-Content manager\amounts.ui.json '{}'",
             # P2-3: opening for write, writer objects, instance methods, -Path: forms, downloads
             r"[IO.File]::Open('lib\capital_vault.py', 'Create')", r"[IO.File]::OpenWrite('lib\capital_vault.py')",
             r"[IO.File]::Create('lib\capital_vault.py')", r"$w = New-Object IO.StreamWriter 'lib\capital_vault.py'",
             r"$w = New-Object -TypeName System.IO.FileStream lib\capital_vault.py, Create",
             r"[IO.StreamWriter]::new('lib\capital_vault.py')", r"(Get-Item lib\capital_vault.py).Delete()",
             r"(Get-Item tmp\x.py).CopyTo('lib\capital_vault.py', $true)", r"Set-Content -Path:capital_vault.py x",
             r"Set-Content -LiteralPath lib\capital_vault.py -Value x", r"Invoke-WebRequest https://x/y -OutFile lib\capital_vault.py",
             r"iwr https://x/y -OutFile manager\amounts.ui.json", r"curl.exe -sSLo lib\capital_vault.py https://x/y",
             # P3: backtick escapes, an encoded command
             r"R`emove-Item lib\capital_vault.py", "Set-`Content lib\\capital_vault.py x",
             "powershell -enc SQBFAFgA", "pwsh.exe -NoProfile -EncodedCommand SQBF", "powershell.exe -e SQBF", "powershell -ec SQBF"],
    SCHED: ["schtasks /create /tn x /tr y /sc daily", r"C:\Windows\System32\schtasks.exe /query",
            "Register-ScheduledTask -TaskName x -Action $a -Trigger $t",
            "$a = New-ScheduledTaskAction -Execute python; Register-ScheduledTask x -Action $a",
            "Unregister-ScheduledTask -TaskName x -Confirm:$false",
            # P2-1: a captured result, the call operator on a quoted name, Start-Process / cmd /c / powershell in between
            "$t = Register-ScheduledTask -TaskName x -Action $a", '& "schtasks.exe" /create /tn x',
            r"& 'C:\Windows\System32\schtasks.exe' /query", 'Start-Process schtasks -ArgumentList "/create /tn x"',
            'Start-Process -FilePath "schtasks.exe" -ArgumentList x -Verb RunAs', "saps schtasks /create",
            "cmd /c schtasks /create /tn x", 'cmd.exe /d /c "schtasks /create"', "powershell -Command Register-ScheduledTask x",
            "pwsh -NoProfile -c Register-ScheduledTask x",
            # P3: backtick escape
            "R`egister-ScheduledTask x", "sch`tasks /create /tn x"],
}
ALLOW = {
    CRED: [r"Get-Content ..\credentials\rdp_password.txt",
           # the bare English word after a copy verb is not a credentials path (P2-4 narrowed)
           'git commit -m "move credentials check"', "rsync -a --exclude credentials ./ blaveagent@1.2.3.4:/opt/x/",
           'cp README.md tmp/credentials-notes.md', r"Copy-Item tmp\x.txt ..\credentials\notes.txt", "cat ~/credentials/README", r"python lib\president_worker.py --once", r"Get-ChildItem ..\credentials",
           r"Test-Path ..\credentials\capital_probe.json"],
    SECRET: [r"Get-Content lib\capital_vault.py", r"python lib\capital_vault.py", r"python strategies\x\strategy.py > tmp\x.log 2>&1",
             # reads with flags, two-letter search terms (P1-1)
             r"Select-String -Path lib\capital_vault.py -Pattern 'ni'", r"Get-Content lib\capital_vault.py | Select-String -Pattern sc",
             r"Get-Content -TotalCount 40 lib\order_capital.py", r"Get-Content lib\capital_worker.py -Tail 20",
             r"Select-String -SimpleMatch -Pattern ac manager\amounts.ui.json", r"grep -ni login lib\capital_vault.py",
             r"grep -rni password lib\president_vault.py", r"Get-Content manager\amounts.ui.json | ConvertFrom-Json",
             r"[IO.File]::Open('lib\capital_vault.py', 'Open', 'Read')", r"[IO.File]::ReadAllText('lib\capital_vault.py')",
             "powershell -ExecutionPolicy Bypass -File tmp\\x.ps1", "pwsh -Command Get-Date",
             r"Invoke-WebRequest https://x/y -OutFile tmp\y.json"],
    SCHED: [r"Get-Content references\deployment.md | Select-String schtasks", "python lib/data.py",
            'Write-Output "schtasks /create is how it is done"', "Select-String -Pattern 'Register-ScheduledTask' references\\deployment.md",
            "echo 'crontab'", "python x.py 'crontab'"],
}
for g, cmds in DENY.items():
    bad = [c for c in cmds if decide(g, c) != "deny"]
    t(f"③ {g}: PowerShell forms denied", not bad, bad)
for g, cmds in ALLOW.items():
    bad = [c for c in cmds if decide(g, c) != "-"]
    t(f"③ {g}: PowerShell reads / runs pass", not bad, bad)
t("③ _bg_guard_hooks: run_in_background on PowerShell denied",
  decide(BG, {"command": r"python strategies\x\strategy.py", "run_in_background": True}) == "deny")
for c in (r"& .\venv\Scripts\python.exe strategies\x\strategy.py",
          # P2-2: a quoted interpreter path (a user name with a space), the py launcher
          r'& "C:\Users\a b\Blave\venv\Scripts\python.exe" strategies\x\strategy.py',
          r"& 'C:\Users\a b\Blave\venv\Scripts\python.exe' -u strategies\x\strategy.py",
          r"py -3 strategies\x\strategy.py", r"py strategies\x\strategy.py", r"py.exe -3.12 strategies\x\strategy.py"):
    t(f"③ _bg_guard_hooks: short-timeout backtest launch rewritten: {c}", decide(BG, c) == "allow:rewrite", decide(BG, c))
for c in ("cp a.py strategies/x/strategy.py", "cat x.py strategies/x/strategy.py", "copy.py strategies/x/strategy.py"):
    t(f"③ _bg_guard_hooks: not a launch: {c}", decide(BG, c, "Bash") == "-", decide(BG, c, "Bash"))
t("③ PowerShell short aliases count only for the PowerShell tool", decide(SECRET, r"ri lib/capital_vault.py", "Bash") == "-")
t("③ an encoded PowerShell command is refused from Bash too", decide(SECRET, "powershell.exe -enc SQBF", "Bash") == "deny")

# ── ③b Bash outside Windows: the same decision as 82f71b37 for everyday commands ──
# Expected values were read off 82f71b37 (scratch parity run); the one intended change is listed in BASH_CHANGED.
BASH_SAME = {
    ".venv/bin/python strategies/btc/strategy.py": {BG: "allow:rewrite"},
    "cat ../credentials/capital_vault.json": {CRED: "deny"},
    "cp lib/capital_vault.py tmp/": {SECRET: "deny"}, "cp tmp/a.json manager/amounts.ui.json": {SECRET: "deny"},
    "cp tmp/x.py lib/capital_vault.py": {SECRET: "deny"}, "crontab -l": {SCHED: "deny"},
    "echo '{}' > manager/amounts.ui.json": {SECRET: "deny"}, "echo x > lib/capital_vault.py": {SECRET: "deny"},
    "launchctl list": {SCHED: "deny"}, "ls ../credentials/*": {CRED: "deny"}, "mv lib/order_capital.py tmp/": {SECRET: "deny"},
    "python3 -c \"open('lib/capital_vault.py','w').write('x')\"": {SECRET: "deny"},
    "python3 -m lib.param_scan strategies/btc": {BG: "allow:rewrite"}, "python3 strategies/btc/strategy.py": {BG: "allow:rewrite"},
    "rm lib/president_worker.py": {SECRET: "deny"}, "sed -i '' 's/a/b/' lib/capital_vault.py": {SECRET: "deny"},
}
for c in ("cat lib/capital_vault.py", 'grep -n "def " lib/capital_vault.py', "grep -ni login lib/capital_vault.py",
          "grep -ri vault lib/", 'grep -rni "password" lib/president_vault.py', "grep -ac x lib/order_capital.py",
          "grep -n sc lib/capital_worker.py", "grep -c ni manager/reconciler.py", 'grep -E "ri|mi" manager/flatten.py',
          "rg -ni login lib/capital_vault.py", "head -50 lib/order_president.py", "sed -n 1,80p lib/account_capital.py",
          "python3 lib/capital_vault.py --check", 'python3 -c "import lib.capital_vault as v; print(v.__doc__)"',
          "python3 -c \"print(open('lib/capital_vault.py').read()[:200])\"", "wc -l lib/*.py", "ls -la lib/",
          "git diff lib/capital_vault.py", "git log -3 -- lib/capital_vault.py", "git status", "cat manager/amounts.ui.json",
          "grep -ni btc manager/amounts.ui.json", "python3 -c \"import json; print(json.load(open('manager/amounts.ui.json')))\"",
          "jq . manager/amounts.ui.json", "nohup python3 strategies/btc/scan.py > tmp/btc_scan.log 2>&1 &",
          "python3 -c \"import time; time.sleep(150); print(open('tmp/x.log').read()[-300:])\"",
          "cp a.py strategies/btc/strategy.py", "cat strategies/btc/strategy.py", "ls ../credentials",
          "cat ../credentials/rdp_password.txt", "python3 lib/president_worker.py --once", "grep crontab references/deployment.md",
          'echo "crontab -l lists jobs"', "ssh blaveagent@1.2.3.4 'crontab -l'", "curl -s https://api.blave.org/kline -o tmp/k.json",
          "curl -sSLo tmp/x.py https://example.com/x.py", "wget -q https://example.com/data.csv -O tmp/data.csv",
          "tar czf tmp/backup.tgz strategies", "zip -r tmp/s.zip strategies", "rsync -a strategies/ tmp/s/", "python3 lib/data.py",
          "pip list", 'find . -name "*.py" -newer VERSION'):
    BASH_SAME[c] = {}
BASH_CHANGED = {"cp ../credentials/rdp_password.txt tmp/": {CRED: "deny"}}   # P2-4: anything copied out of credentials/
for table, label in ((BASH_SAME, "same as 82f71b37"), (BASH_CHANGED, "intended change")):
    bad = {}
    for c, want in table.items():
        got = {g: d for g in (BG, CRED, SCHED, SECRET) if (d := decide(g, c, "Bash")) != "-"}
        if got != want:
            bad[c] = got
    t(f"③b Bash, everyday commands: {label} ({len(table)})", not bad, bad)

# ── ④ classifiers ──
ps = {"command": r"python strategies\btc_cross\strategy.py"}
t("④ _tool_kind: a PowerShell backtest is a backtest", at._tool_kind("PowerShell", {"command": "python strategies/btc_cross/strategy.py"},
                                                                     WS, set())[0] == "backtest")
t("④ _touched_strategies: PowerShell counts like Bash", at._touched_strategies("PowerShell", ps)
  == at._touched_strategies("Bash", ps) == {"btc_cross"})
t("④ ToolPrep streams PowerShell as code", "PowerShell" in at.ToolPrep.CODE_TOOLS)

# ── ⑤ where the CLI finds Git Bash (P2-5; the turn_env pin itself: tests/check_sched_bash_guard.py ⑤) ──
has = lambda *paths: (lambda p: p in paths)  # noqa: E731
GB = r"C:\Program Files\Git\bin\bash.exe"
t("⑤ Program Files Git Bash", at.git_bash_path({}, has(GB), cwd=r"C:\w") == GB)
t("⑤ Program Files (x86) Git Bash", at.git_bash_path({}, has(r"C:\Program Files (x86)\Git\bin\bash.exe"), cwd="C:\\")
  == r"C:\Program Files (x86)\Git\bin\bash.exe")
t("⑤ CLAUDE_CODE_GIT_BASH_PATH naming an existing bash wins",
  at.git_bash_path({"CLAUDE_CODE_GIT_BASH_PATH": r"E:\x\bash.exe"}, has(r"E:\x\bash.exe", GB), cwd="C:\\") == r"E:\x\bash.exe")
t("⑤ CLAUDE_CODE_GIT_BASH_PATH naming something else is skipped",
  at.git_bash_path({"CLAUDE_CODE_GIT_BASH_PATH": r"E:\x\zsh.exe"}, has(r"E:\x\zsh.exe"), cwd="C:\\") is None)
t("⑤ git on PATH → ..\\..\\bin\\bash.exe joined onto git.exe (the CLI's join)",
  at.git_bash_path({"PATH": r"C:\w;D:\Git\cmd"}, has(r"D:\Git\cmd\git.exe", r"D:\Git\bin\bash.exe"), cwd=r"C:\w")
  == r"D:\Git\bin\bash.exe")
t("⑤ the first git on PATH decides; its bash missing → none",
  at.git_bash_path({"PATH": r"D:\Git\cmd;E:\Git\cmd"}, has(r"D:\Git\cmd\git.exe", r"E:\Git\cmd\git.exe", r"E:\Git\bin\bash.exe"),
                   cwd="C:\\") is None)
t("⑤ a git in the cwd or on a UNC path is skipped",
  at.git_bash_path({"PATH": r"C:\w;\\srv\Git\cmd"}, has(r"C:\w\git.exe", r"C:\bin\bash.exe", r"\\srv\Git\cmd\git.exe",
                                                       r"\\srv\Git\bin\bash.exe"), cwd=r"C:\w") is None)
t("⑤ nothing → none", at.git_bash_path({"PATH": r"C:\Windows\System32"}, has(), cwd="C:\\") is None)
t("⑤ the pin: no Git Bash → 1", at.powershell_tool_env({}, has(), cwd="C:\\") == "1")
t("⑤ the pin: Git Bash → not set (never 0: if the CLI disagreed it would have no shell at all)",
  at.powershell_tool_env({}, has(GB), cwd="C:\\") is None)


def _boom(_p):
    raise OSError("unreadable")


t("⑤ the pin: cannot tell → not set", at.powershell_tool_env({}, _boom, cwd="C:\\") is None)

# ── KNOWN_GAPS (pinned so a fix shows up here) ──
KNOWN_GAPS = {
    "Start-Process detaching a backtest is not read as detached":
        lambda: not at._DETACHED_RE.search(r"Start-Process python -ArgumentList 'strategies\x\strategy.py'"),
    "Start-Job launching a backtest is read as a foreground launch (timeout rewritten), not refused; the job dies with the turn":
        lambda: decide(BG, r"Start-Job { python strategies\x\strategy.py }") == "allow:rewrite",
    "a name assembled at run time is not caught (secret code)":
        lambda: decide(SECRET, r"Set-Content ('lib\capital_' + 'vault.py') x") == "-",
    "a name assembled at run time is not caught (scheduler)":
        lambda: decide(SCHED, r"& ('Register-' + 'ScheduledTask') x") == "-",
    "a name assembled at run time is not caught (credentials)":
        lambda: decide(CRED, r"Get-Content ('..\cred' + 'entials\capital_' + 'vault.json')") == "-",
    "a folder glob instead of the name (creden*) is not a credentials path":
        lambda: decide(CRED, r"Copy-Item -Recurse ..\creden* tmp\c") == "-",
    "a whole base folder copied without naming credentials/ is not caught":
        lambda: decide(CRED, r"Compress-Archive -Path $env:USERPROFILE\Blave -DestinationPath tmp\all.zip") == "-",
}
for name, still in KNOWN_GAPS.items():
    t(f"KNOWN_GAP still open: {name}", still())

if fails:
    sys.exit(f"{len(fails)} failed: {fails}")
print("all passed")
