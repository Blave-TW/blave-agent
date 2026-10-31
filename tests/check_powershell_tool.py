"""Windows without Git for Windows: the Claude Code CLI has no Bash tool and gives PowerShell instead
(win-e2e-0.1.39 F2 — 1.1.149's chat_tools whitelist left PowerShell out, so those machines had no shell at all).

  ① chat_tools: PowerShell on win32 (next to Bash), never elsewhere; the scheduled turn still blocks it
  ② every hook whose matcher covers Bash covers PowerShell too — enumerated twice: every _add_hook call in
     agent_turn.py's source, and every matcher actually mounted on a desktop and a cloud turn (≥ 4 shell guards)
  ③ each shell guard denies the PowerShell form of what it denies in Bash, and lets reads through
  ④ the status-line / touched-strategy classifiers read a PowerShell command like a Bash one
KNOWN_GAPS pins what still passes: `Start-Process` detaching a backtest is not recognised as detached.

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


def decide(guard, tool_input):
    out = asyncio.run(guards[guard]({"tool_name": "PowerShell", "tool_input": tool_input}, "t", None))
    return (out.get("hookSpecificOutput") or {}).get("permissionDecision")


DENY = {
    "_cred_bash_guard_hooks": [r"Get-Content ..\credentials\capital_vault.json", r"type ..\credentials\*",
                               r"Copy-Item ..\credentials\president.pfx tmp\x.pfx"],
    "_secret_code_bash_guard_hooks": [r"Set-Content lib\capital_vault.py 'x'", r"Remove-Item lib\order_capital.py",
                                      r"'x' | Out-File lib\capital_worker.py", r"ri lib\capital_vault.py",
                                      r"sc lib\president_vault.py 'x'",
                                      r"[IO.File]::WriteAllText('lib\capital_vault.py', 'x')",
                                      r"Set-Content manager\amounts.ui.json '{}'"],
    "_sched_guard_hooks": ["schtasks /create /tn x /tr y /sc daily", r"C:\Windows\System32\schtasks.exe /query",
                           "Register-ScheduledTask -TaskName x -Action $a -Trigger $t",
                           "$a = New-ScheduledTaskAction -Execute python; Register-ScheduledTask x -Action $a",
                           "Unregister-ScheduledTask -TaskName x -Confirm:$false"],
}
ALLOW = {
    "_cred_bash_guard_hooks": [r"Get-Content ..\credentials\rdp_password.txt", r"python lib\president_worker.py --once"],
    "_secret_code_bash_guard_hooks": [r"Get-Content lib\capital_vault.py", r"python lib\capital_vault.py",
                                      r"python strategies\x\strategy.py > tmp\x.log 2>&1"],
    "_sched_guard_hooks": [r"Get-Content references\deployment.md | Select-String schtasks", "python lib/data.py"],
}
for g, cmds in DENY.items():
    bad = [c for c in cmds if decide(g, {"command": c}) != "deny"]
    t(f"③ {g}: PowerShell forms denied", not bad, bad)
for g, cmds in ALLOW.items():
    bad = [c for c in cmds if decide(g, {"command": c}) is not None]
    t(f"③ {g}: PowerShell reads / runs pass", not bad, bad)
at._ENGINE["cli_version"] = "2.1.281"
t("③ _bg_guard_hooks: run_in_background on PowerShell denied",
  decide("_bg_guard_hooks", {"command": r"python strategies\x\strategy.py", "run_in_background": True}) == "deny")
out = asyncio.run(guards["_bg_guard_hooks"]({"tool_name": "PowerShell", "tool_input": {
    "command": r"& .\venv\Scripts\python.exe strategies\x\strategy.py", "timeout": 120000}}, "t", None))
t("③ _bg_guard_hooks: a short-timeout PowerShell backtest gets its timeout rewritten",
  (out.get("hookSpecificOutput") or {}).get("updatedInput", {}).get("timeout", 0) > 120000, out)

# ── ④ classifiers ──
ps = {"command": r"python strategies\btc_cross\strategy.py"}
t("④ _tool_kind: a PowerShell backtest is a backtest", at._tool_kind("PowerShell", {"command": "python strategies/btc_cross/strategy.py"},
                                                                     WS, set())[0] == "backtest")
t("④ _touched_strategies: PowerShell counts like Bash", at._touched_strategies("PowerShell", ps)
  == at._touched_strategies("Bash", ps) == {"btc_cross"})
t("④ ToolPrep streams PowerShell as code", "PowerShell" in at.ToolPrep.CODE_TOOLS)

# ── KNOWN_GAPS (pinned so a fix shows up here) ──
KNOWN_GAPS = [r"Start-Process python -ArgumentList 'strategies\x\strategy.py'"]
for c in KNOWN_GAPS:
    t(f"KNOWN_GAP still not read as detached: {c}", not at._DETACHED_RE.search(c))

if fails:
    sys.exit(f"{len(fails)} failed: {fails}")
print("all passed")
