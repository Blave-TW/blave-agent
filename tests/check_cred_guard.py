"""<base>/credentials 的 agent 守門:群益／統一的 vault、憑證、上傳金鑰、群益暫存憑證、統一 SDK log。

  ① 每個回合的 disallowed 規則含 Read 與 Edit 這幾組檔名,錨在 `//<base>/credentials`(單斜線會錨到
     workspace);Windows 路徑換成 `/c/…`;rdp_password.txt(references/capital-broker.md 叫 agent 讀它)不在裡面
  ② Bash:cat / type / Get-Content / copy / python open / glob 進 credentials 一律 deny,理由回給模型;
     不碰這些檔的日常指令(含 lib/president_worker.py --unblock、讀 rdp_password.txt、列目錄)放行
  ③ 每個回合都掛(雲端、電腦版、排程與否)
這是減速帶不是邊界:拆字、執行時組出檔名、列目錄再接讀取的寫法列在 KNOWN_GAPS,釘住「現在擋不到」。

跑法:cd blave-agent && python3 tests/check_cred_guard.py
"""
import asyncio, atexit, dataclasses, fnmatch, os, shutil, sys, tempfile, types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))
BASE = tempfile.mkdtemp(prefix="check-cred-guard-")
atexit.register(shutil.rmtree, BASE, True)
WS = os.path.join(BASE, "workspace")
os.makedirs(WS)
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


# ── ① 規則 ──
anchor = "/" + os.path.abspath(os.path.join(BASE, "credentials"))
rules = list(at.PROTECTED_EDIT_RULES)
want = [f"{tool}({anchor}/{g})" for tool in ("Read", "Edit")
        for g in ("*vault*", "*pfx*", "capital_stage/**", "president_logs/**")]
t("① 每個回合的 disallowed 規則含 credentials 的 Read + Edit 八條,錨在 //<base>/credentials", all(r in rules for r in want),
  [r for r in want if r not in rules])
t("① 錨是 //(絕對),不是單斜線(那會錨到 workspace)", anchor.startswith("//") and not any(
    r.startswith(("Read(/credentials", "Edit(/credentials")) for r in rules))
_real_abspath = at.os.path.abspath
at.os.path.abspath = lambda p: p
try:
    win = at._abs_rule_path("C:\\blave-agent\\credentials")
finally:
    at.os.path.abspath = _real_abspath
t("① C:\\blave-agent\\credentials → //c/blave-agent/credentials", win == "//c/blave-agent/credentials", win)
t("① rdp_password.txt 不在規則裡(群益 NSSM／schtasks 要讀)", not any("rdp" in r for r in rules)
  and not any(r.endswith("credentials/**)") for r in rules))
for name in ("capital_vault.json", "president_vault.json", ".president_vault.json.0123456789ab.tmp", "president.pfx",
             "president_pfx_key.json", "capital_pfx_key.json"):
    t(f"① 檔名 {name} 落在其中一組", any(fnmatch.fnmatch(name, g) for g in at.CREDENTIAL_SECRET_GLOBS[:2]))
t("① rdp_password.txt / telegram allowFrom 不落在任何一組", not any(
    fnmatch.fnmatch(n, g) for n in ("rdp_password.txt", "telegram-default-allowFrom.json")
    for g in at.CREDENTIAL_SECRET_GLOBS[:2]))

# ── ② Bash ──
BLOCK = [
    r"cat ../credentials/president_vault.json", r"type C:\blave-agent\credentials\capital_vault.json",
    r"Get-Content C:\blave-agent\credentials\president_vault.json", r"copy C:\blave-agent\credentials\president.pfx C:\tmp",
    r"python -c \"print(open(r'C:\blave-agent\credentials\capital_vault.json').read())\"",
    r"type C:\blave-agent\credentials\*", r"cat ../credentials/*.json", r"Get-Content ..\credentials\*vault*",
    r"cp /opt/blave-agent/credentials/president.pfx /tmp/x.pfx", r"type ..\credentials\cert.pfx",
    r"cat ../credentials/president_pfx_key.json", r"dir C:\blave-agent\credentials\capital_stage",
    r"Get-ChildItem -Recurse C:\blave-agent\credentials\president_logs", r"cat state/president_logs/logs/x.txt",
    r"Set-Content C:\blave-agent\credentials\president_vault.json '{\"live\": true}'",
    r"CAT ../Credentials/President_Vault.json",
]
ALLOW = [
    r"python lib/president_worker.py --unblock", r"python lib/president_worker.py --once",
    r"type C:\blave-agent\credentials\rdp_password.txt", r"dir C:\blave-agent\credentials",
    r"python3 -c \"from lib import president_vault; print(president_vault.in_login_maintenance())\"",
    r"cat state/president_account.json", r"python3 -m lib.report_templates", r"grep -r vault references/",
    r"python3 strategies/x/strategy.py --credentials-check",
]
KNOWN_GAPS = [
    r"type (Get-ChildItem C:\blave-agent\credentials | Select -First 1).FullName",
    r"python -c \"import os; print(open(os.path.join('..','credentials','capital_'+'vault.json')).read())\"",
]
t(f"② 擋:{len(BLOCK)} 條讀／抄／改都認得", not [c for c in BLOCK if not at.cred_bash_denied(c)],
  [c for c in BLOCK if not at.cred_bash_denied(c)])
t(f"② 放行:{len(ALLOW)} 條日常指令不誤擋", not [c for c in ALLOW if at.cred_bash_denied(c)],
  [c for c in ALLOW if at.cred_bash_denied(c)])
t("② KNOWN_GAPS 現在確實擋不到(擋到了就把它搬進 BLOCK)", not [c for c in KNOWN_GAPS if at.cred_bash_denied(c)])


@dataclasses.dataclass
class _Options:
    hooks: object = None


o = _Options()
t("② 掛得上", at._cred_bash_guard_hooks(o) is True)
h = o.hooks["PreToolUse"][0]
run = lambda cmd: asyncio.run(h["hooks"][0]({"tool_name": "Bash", "tool_input": {"command": cmd}}, "t1", None))  # noqa: E731
hs = run(BLOCK[0]).get("hookSpecificOutput") or {}
t("② deny + 理由(不換方法重試、改看 lib 的狀態)", h["matcher"] == "Bash" and hs.get("permissionDecision") == "deny"
  and hs.get("permissionDecisionReason") == at.CRED_BASH_DENY_REASON and "Do not retry" in at.CRED_BASH_DENY_REASON, hs)
t("② 放行回空;沒有 command 也回空", run(ALLOW[0]) == {} and asyncio.run(h["hooks"][0]({"tool_input": {}}, "t", None)) == {})


# ── ③ 每個回合都掛 ──
class _Remote:
    pass


def mounted(sink, scheduled):
    o = _Options()
    at._mount_turn_hooks(o, sink, scheduled, "hi", None)
    return [x["hooks"][0].__qualname__ for x in (o.hooks or {}).get("PreToolUse") or []]


local = at.LocalSink.__new__(at.LocalSink)
CRED = "_cred_bash_guard_hooks.<locals>.guard"
t("③ 雲端／電腦版 × 排程與否,四種回合都掛", all(CRED in mounted(s, sc) for s in (_Remote(), local) for sc in (False, True)))

if fails:
    sys.exit(f"{len(fails)} failed: {fails}")
print("all passed")
