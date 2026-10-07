"""拿得到群益／統一密碼的程式檔,agent 改不得(稽核 2026-10-07 S1;Wei 拍板)。

  ① 每個回合的 disallowed 規則含這十支的 Edit(Edit 規則涵蓋 Write / MultiEdit),錨在 workspace;排程回合也有
  ② Bash:重導向進去、sed -i、cp / mv / rm、python open(...,'w')、PowerShell Set-Content、git checkout 這幾支 → deny;
     讀(cat / grep / import)、照常執行它們(含 `> tmp/log 2>&1`)放行
  ③ 每個回合都掛這道 hook
減速帶不是邊界:執行時組出來的路徑擋不到(KNOWN_GAPS 釘住)。

跑法:cd blave-agent && python3 tests/check_secret_code_guard.py
"""
import asyncio, atexit, dataclasses, os, shutil, sys, tempfile, types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))
BASE = tempfile.mkdtemp(prefix="check-code-guard-")
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


FILES = ["lib/president_vault.py", "lib/president_worker.py", "lib/order_president.py", "lib/account_president.py",
         "lib/capital_vault.py", "lib/capital_worker.py", "lib/order_capital.py", "lib/account_capital.py",
         "manager/reconciler.py", "manager/flatten.py"]
t("① 十支都在每個回合的 Edit 規則裡(錨在 workspace)", all(f"Edit(/{f})" in at.PROTECTED_EDIT_RULES for f in FILES),
  [f for f in FILES if f"Edit(/{f})" not in at.PROTECTED_EDIT_RULES])
t("① 清單本身就是這十支", sorted(at.SECRET_CODE_FILES) == sorted(FILES))
t("① 每支都真的存在(改名就要跟著改這份清單)", all(os.path.isfile(os.path.join(ROOT, f)) for f in FILES),
  [f for f in FILES if not os.path.isfile(os.path.join(ROOT, f))])
before = list(at.PROTECTED_EDIT_RULES)
at._apply_scheduled_limits()
t("① 排程回合照樣有(只會多、不會少)", all(r in at.PROTECTED_EDIT_RULES for r in before))

DENY = [
    "echo x > lib/president_vault.py", "cat evil >> lib/order_president.py", "sed -i 's/a/b/' manager/reconciler.py",
    "perl -pi -e 's/a/b/' lib/president_worker.py", "cp /tmp/x.py lib/capital_vault.py", "mv x lib/account_capital.py",
    "rm manager/flatten.py", "python3 -c \"open('lib/order_capital.py','w').write('')\"",
    "python -c \"import pathlib;pathlib.Path('lib/president_vault.py').write_text('x')\"",
    "powershell -c \"Set-Content lib\\president_vault.py 'x'\"", "git checkout lib/president_worker.py",
    "tee lib/account_president.py < x", "Copy-Item x.py lib\\capital_worker.py",
]
ALLOW = [
    "cat lib/president_vault.py", "grep -n live lib/president_vault.py",
    "python lib/president_worker.py --once > tmp/probe.log 2>&1", "python -c \"from lib import order_president\"",
    "python3 manager/flatten.py", "sed -n 1,40p manager/reconciler.py", "cp lib/runner.py tmp/runner_copy.py",
    "echo hi > tmp/notes.txt",
]
bad = [c for c in DENY if not at.secret_code_bash_denied(c)]
t("② 寫入／搬／刪／換掉這幾支 → deny", not bad, bad)
bad = [c for c in ALLOW if at.secret_code_bash_denied(c)]
t("② 讀、照常執行、改別的檔 → 放行", not bad, bad)
KNOWN_GAPS = ["f=lib/president_vault; echo x > $f.py", "python -c \"open('lib/president_'+'vault.py','w')\""]
t("② KNOWN_GAPS:執行時組出來的路徑擋不到(釘住現況)", not any(at.secret_code_bash_denied(c) for c in KNOWN_GAPS))

# ③ hook
@dataclasses.dataclass
class _Options:
    hooks: object = None


opts = _Options()
at._secret_code_bash_guard_hooks(opts)
hooks = (opts.hooks or {}).get("PreToolUse") or []
fn = hooks[-1]["hooks"][0] if hooks else None
out = asyncio.run(fn({"tool_input": {"command": "echo x > lib/president_vault.py"}}, None, None)) if fn else {}
ok_out = asyncio.run(fn({"tool_input": {"command": "cat lib/president_vault.py"}}, None, None)) if fn else None
t("③ hook:deny 帶理由;放行回 {}", (out.get("hookSpecificOutput") or {}).get("permissionDecision") == "deny"
  and "trading passwords" in out["hookSpecificOutput"]["permissionDecisionReason"] and ok_out == {})
src = open(os.path.join(ROOT, "runtime", "agent_turn.py"), encoding="utf-8").read()
mount = src[src.index("def _mount_turn_hooks("):src.index("SCHED_OUTCOME = {}")]
t("③ 每個回合都掛(在 sink / scheduled 分支之前)", mount.index("_secret_code_bash_guard_hooks(options)") < mount.index("if isinstance(sink, LocalSink)"))

print("\n" + (f"{len(fails)} FAIL" if fails else "ALL PASS"))
sys.exit(1 if fails else 0)
