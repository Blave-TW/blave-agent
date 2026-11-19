"""拿得到群益／統一密碼的程式檔,agent 改不得(稽核 2026-10-07 S1;Wei 拍板)。

  ① 每個回合的 disallowed 規則含這十一支的 Edit(Edit 規則涵蓋 Write / MultiEdit),錨在 workspace;排程回合也有
  ② Bash:重導向進去、sed -i、cp / mv / rm、python open(...,'w')、PowerShell Set-Content、git checkout 這幾支 → deny;
     讀(cat / grep / import)、照常執行它們(含 `> tmp/log 2>&1`)放行
  ③ 每個回合都掛這道 hook
  ④ manager/amounts.ui.json(最後一次 UI 確認的金額,只有 daemon 寫;稽核 10-21 N2):每個回合的 Edit 規則都有,
     Bash 寫它走同一道 hook、自己的理由;讀放行。portfolio_config.json 與 manager/executors/** 在聊天回合不凍
     (AGENTS.md › Custom executors、manager.py --apply 是合法寫入)。
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
         "manager/reconciler.py", "manager/flatten.py", "lib/winreplace.py"]
t("① 十一支都在每個回合的 Edit 規則裡(錨在 workspace)", all(f"Edit(/{f})" in at.PROTECTED_EDIT_RULES for f in FILES),
  [f for f in FILES if f"Edit(/{f})" not in at.PROTECTED_EDIT_RULES])
t("① 清單含這十一支(整份清單＝匯入圖,由 tests/check_secret_code_graph.py 釘住)", set(FILES) <= set(at.SECRET_CODE_FILES))
t("① 含 lib/winreplace.py(四支 vault 檔都 import 它,改它等於改它們)",
  "lib/winreplace.py" in at.SECRET_CODE_FILES and all(
      "winreplace" in open(os.path.join(ROOT, f), encoding="utf-8").read()
      for f in ("lib/president_vault.py", "lib/president_worker.py", "lib/capital_vault.py", "lib/capital_worker.py")))
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
    "python3 -c \"open('lib/president_vault.py','rb+')\"", "python3 -c \"open('lib/president_vault.py', mode='wb')\"",
    # 匯入圖裡的一般檔名(稽核 2026-11-19 M1):走 lib/… manager/… 路徑才算
    "echo x > lib/data.py", "sed -i 's/a/b/' lib/portfolio.py", "cp x.py lib/president_quote.py",
    "cat evil >> lib/execute.py", "Copy-Item x.py lib\\guard.py", f"cp x.py {WS}/lib/events.py",
    "python3 -c \"open('lib/order_binance.py','w')\"", "rm lib/__init__.py", "echo x > ./lib/notify.py",
    # the same path spelled another literal way (follow-up audit S-2), and the files it found unfrozen (M-2)
    "sed -i s/a/b/ lib//data.py", "sed -i s/a/b/ lib/./data.py", "sed -i s/a/b/ \"$PWD/lib/data.py\"",
    "sed -i s/a/b/ ${PWD}/lib/guard.py", "cp x manager/../lib/portfolio.py", "echo x > LIB/data.py",
    "cp e.py lib/error_report.py", "cp e.py lib/secret_imports.py",
]
ALLOW = [
    "cat lib/president_vault.py", "grep -n live lib/president_vault.py",
    "python lib/president_worker.py --once > tmp/probe.log 2>&1", "python -c \"from lib import order_president\"",
    "python3 manager/flatten.py", "sed -n 1,40p manager/reconciler.py", "cp lib/runner.py tmp/runner_copy.py",
    "echo hi > tmp/notes.txt",
    # open() 不帶寫入 mode 是讀(路徑裡的 a 不是 mode)
    "python3 -c \"print(open('lib/president_vault.py').read())\"", "python3 -c \"open('manager/reconciler.py', encoding='utf-8').read()\"",
    "python3 -c \"print(open('AGENTS.md').read())\"", "python3 -c \"open('lib/account_capital.py').read()\"",
    "python3 -c \"open('lib/president_vault.py', 'rb').read()\"",
    # 策略自己的 data.py、自建的整合檔不在清單
    "echo x > strategies/foo/data.py", "cp a.py strategies/x/guard.py", "echo x > lib/order_myvenue.py",
    "sed -n 1,20p lib/data.py", "python3 -c \"from lib import data\"",
]
bad = [c for c in DENY if not at.secret_code_bash_denied(c)]
t("② 寫入／搬／刪／換掉這幾支 → deny", not bad, bad)
bad = [c for c in ALLOW if at.secret_code_bash_denied(c)]
t("② 讀、照常執行、改別的檔 → 放行", not bad, bad)
# grep 的旗標組與兩個字母的搜尋字是讀(稽核 v039-win-shell-fix P1-1:PowerShell 短別名曾以裸字比對,這些全被擋)
GREP_READS = [
    "grep -ni login lib/capital_vault.py", "grep -ri vault lib/president_vault.py", "grep -rni password lib/order_capital.py",
    "grep -ac x lib/account_capital.py", "grep -n sc lib/capital_worker.py", "grep -c ni manager/reconciler.py",
    "grep -E 'ri|mi' manager/flatten.py", "grep -w cpi lib/winreplace.py", "rg -ni login lib/president_worker.py",
    "grep -ni btc manager/amounts.ui.json", "grep -c ac manager/amounts.ui.json",
]
for ps in (False, True):
    bad = [c for c in GREP_READS if at.secret_code_bash_denied(c, ps) or at.mirror_bash_denied(c, ps)]
    t(f"② grep 讀這幾支(含 -ni／-ri／-rni／-ac、兩個字母的搜尋字)→ 放行({'PowerShell' if ps else 'Bash'})", not bad, bad)
KNOWN_GAPS = ["f=lib/president_vault; echo x > $f.py", "python -c \"open('lib/president_'+'vault.py','w')\"",
              "cd lib && echo x > data.py"]
t("② KNOWN_GAPS:執行時組出來的路徑擋不到(釘住現況)", not any(at.secret_code_bash_denied(c) for c in KNOWN_GAPS))

# ④ amounts.ui.json
MIRROR = "Edit(/manager/amounts.ui.json)"
t("④ 每個回合的 Edit 規則含 amounts.ui.json;portfolio_config.json 與 executors/** 聊天回合不凍",
  MIRROR in before and not any(r in before for r in ("Edit(/manager/**)", "Edit(/manager/portfolio_config.json)",
                                                     "Edit(/manager/executors/**)")))
M_DENY = [
    "echo '{}' > manager/amounts.ui.json", "cat x >> manager/amounts.ui.json", "cp tmp/a.json manager/amounts.ui.json",
    "mv tmp/a.json manager/amounts.ui.json", "rm manager/amounts.ui.json", "sed -i 's/100/900/' manager/amounts.ui.json",
    "tee manager/amounts.ui.json < x", "python3 -c \"import json; json.dump({}, open('manager/amounts.ui.json', 'w'))\"",
    "python3 -c \"open('manager/' + 'amounts.ui.json', 'w')\"",
    "python -c \"import pathlib; pathlib.Path('manager/amounts.ui.json').write_text('{}')\"",
    "python3 -c \"import os; os.replace('tmp/a.json', 'manager/amounts.ui.json')\"", "git checkout manager/amounts.ui.json",
    "powershell -c \"Set-Content manager\\amounts.ui.json '{}'\"", "Copy-Item x.json manager\\amounts.ui.json",
    "cd manager && echo '{}' > amounts.ui.json",
]
M_ALLOW = [
    "cat manager/amounts.ui.json", "python3 -c \"import json; print(json.load(open('manager/amounts.ui.json')))\"",
    "grep BTC manager/amounts.ui.json", "ls -la manager/", "python3 manager/manager.py --apply",
    "cd manager && python3 -c \"open('amounts.ui.json').read()\"",
    "echo x > manager/portfolio_config.json", "cp tmp/x.py manager/executors/x.py", "echo hi > tmp/amounts.json",
]
bad = [c for c in M_DENY if not at.mirror_bash_denied(c)]
t("④ Bash 寫／搬／刪／換掉 amounts.ui.json → deny", not bad, bad)
bad = [c for c in M_ALLOW if at.mirror_bash_denied(c)]
t("④ 讀它、寫 manager/ 其他檔 → 放行", not bad, bad)
M_GAPS = ["f=manager/amounts.ui; echo x > $f.json", "python3 -c \"open('manager/amounts' + '.ui.json', 'w')\""]
t("④ KNOWN_GAPS:組出來的路徑擋不到", not any(at.mirror_bash_denied(c) for c in M_GAPS))

# ⑥ Write / Edit: the frozen files in any case the disk accepts (the Edit rules compare the literal path)
t("⑥ secret_code_path: LIB/Data.py, ./lib/../lib/guard.py → frozen; strategies/x/data.py, lib/order_mine.py → not",
  at.secret_code_path(os.path.join(WS, "lib", "guard.py")) and at.secret_code_path("./lib/../lib/guard.py")
  and at.secret_code_path(os.path.join(WS, "LIB", "Data.py")) == (sys.platform in ("darwin", "win32"))
  and not at.secret_code_path(os.path.join(WS, "strategies", "x", "data.py"))
  and not at.secret_code_path(os.path.join(WS, "lib", "order_mine.py")))
t("⑤ Edit 規則也蓋基底直譯器、runtime 目錄、<base>/current",
  all(f"Edit({at._abs_rule_path(d)}/**)" in at.PROTECTED_EDIT_RULES
      for d in (sys.base_prefix, os.path.join(os.path.dirname(WS), "current"), os.path.join(ROOT, "runtime"))))


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
m_out = asyncio.run(fn({"tool_input": {"command": "echo '{}' > manager/amounts.ui.json"}}, None, None)) if fn else {}
t("④ 同一道 hook:寫 amounts.ui.json deny、理由是它自己的(只有 daemon 寫、網頁改金額)",
  (m_out.get("hookSpecificOutput") or {}).get("permissionDecisionReason") == at.MIRROR_DENY_REASON
  and "only the Blave daemon writes it" in at.MIRROR_DENY_REASON)
# ⑤ site-packages / .pth / sitecustomize(稽核 2026-11-19 M1):每個 Python 行程啟動就載入,含拿密碼的那幾支
venv = os.path.join(os.path.dirname(WS), "venv")
t("⑤ Edit 規則:venv 整棵、user site、任何地方的 .pth／sitecustomize／usercustomize",
  f"Edit({at._abs_rule_path(venv)}/**)" in at.PROTECTED_EDIT_RULES
  and f"Edit({at._abs_rule_path(at.site.getusersitepackages())}/**)" in at.PROTECTED_EDIT_RULES
  and all(f"Edit(//**/{g})" in at.PROTECTED_EDIT_RULES for g in ("*.pth", "sitecustomize.py", "usercustomize.py")))
S_DENY = [
    "cp e.py ../current/events.py", f"cp e.py {os.path.join(sys.base_prefix, 'lib', 'hashlib.py')}",
    f"echo 'import os' > {venv}/lib/python3.12/site-packages/x.pth", "cp evil.pth ../venv/lib/python3.12/site-packages/",
    "python3 -c \"open('/opt/blave-agent/venv/lib/python3.10/site-packages/a.pth','w')\"",
    "tee ~/.local/lib/python3.10/site-packages/sitecustomize.py < x", "echo x >> usercustomize.py",
    "Set-Content C:\\blave-agent\\venv\\Lib\\site-packages\\x.pth 'import os'", "sed -i 's/a/b/' ../venv/pyvenv.cfg",
]
S_ALLOW = [
    f"ls {venv}/lib/python3.12/site-packages > tmp/pkgs.txt", f"{venv}/bin/python strategies/x/run.py > tmp/out.log 2>&1",
    f"{venv}/bin/python -c \"open('strategies/x/out.json','w').write('{{}}')\"", "pip show requests",
    "grep -r version ../venv/lib/python3.12/site-packages/requests/__version__.py",
]
bad = [c for c in S_DENY if not at.site_bash_denied(c, c.startswith("Set-Content"))]
t("⑤ Bash 寫 site-packages／.pth／*customize／pyvenv.cfg → deny", not bad, bad)
bad = [c for c in S_ALLOW if at.site_bash_denied(c)]
t("⑤ 讀它、用絕對路徑跑 venv 的 python 寫別的檔 → 放行", not bad, bad)
S_GAPS = [f"cp evil {venv}/bin/python", "pip install some-package"]
t("⑤ KNOWN_GAPS:蓋掉 venv 的 python 本身(只有 Edit 規則)、pip install(券商文件要用)擋不到", not any(at.site_bash_denied(c) for c in S_GAPS))
s_out = asyncio.run(fn({"tool_input": {"command": "echo x > ../venv/lib/python3.12/site-packages/a.pth"}}, None, None)) if fn else {}
t("⑤ 同一道 hook,理由是它自己的", (s_out.get("hookSpecificOutput") or {}).get("permissionDecisionReason") == at.SITE_DENY_REASON)
src = open(os.path.join(ROOT, "runtime", "agent_turn.py"), encoding="utf-8").read()
mount = src[src.index("def _mount_turn_hooks("):src.index("SCHED_OUTCOME = {}")]
t("③ 每個回合都掛(在 sink / scheduled 分支之前)", mount.index("_secret_code_bash_guard_hooks(options)") < mount.index("if isinstance(sink, LocalSink)"))

print("\n" + (f"{len(fails)} FAIL" if fails else "ALL PASS"))
sys.exit(1 if fails else 0)
