"""排程報告回合的兩支報告工具(mcp__blave_report__build / publish;稽核 10-26 R1 §3.4、§3.6)。

鎖:
  ③ build 形狀不對(extra 4 個、巢狀 dict、超過 4KB、帶 job id 想換 job)→ 錯誤、沒有子行程、沒有 pack;
     未知積木、symbol 帶 / 或 ; → 回真的 lib.report_bricks.check_extra 的原文、沒有 pack;
  ④ list 參數 ["relative_perf", {"symbols": ["BTC", "ETH"]}] 過得了形狀與 check_extra,原樣送到 build;
  ⑤ 模板 run.py 用 ast 解析:常值參數支援;__import__('os').system(...)、變數、函式呼叫、**kw、extra → no_template,
     而且 runtime 沒有執行 run.py(標記檔);runtime 與 lib.report 的判定對同一組 run.py 一致;
  ⑥ 敘事裡的 `"); import os; os.system(...)#`、{{ }}、${} 原樣到 publish,標記檔不存在;
  ⑦ publish 成功一次後拒絕;失敗 3 次後拒絕;build 最多 2 次;續跑(第二次 sdk.query)計數不歸零;
  ⑧ 子行程 env 是 allowlist(Windows 另加系統變數);build 沒有 BLAVE_PROXY_TOKEN、publish 有(api 驗證要它);
     build 與 publish 的 BLAVE_TURN_ID 相同;api 退件 → 退件原文回到工具結果、不寫報告也不寫 .published;
  ⑨ 自訂 run.py → _try_agent 回 agent_skipped == "no_template"、不起回合;register_schedule 帶 consent 時印提醒。

跑法:cd blave-agent && .venv/bin/python tests/check_sched_report_tools.py
"""
import asyncio, atexit, contextlib, dataclasses, io, json, os, shutil, sys, tempfile, types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))
TMP = tempfile.mkdtemp(prefix="check-sched-tools-")
atexit.register(shutil.rmtree, TMP, True)
WS = os.path.join(TMP, "workspace")
os.makedirs(os.path.join(WS, "lib"))
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ["BLAVE_AGENT_DB"] = os.path.join(TMP, "session.db")
os.environ["BLAVE_AGENT_STATE"] = os.path.join(TMP, "state")
os.environ["BLAVE_AGENT_HOME"] = TMP
os.environ["BLAVE_AGENT_MODEL_PREFS"] = os.path.join(TMP, "state", "model_prefs.json")
os.environ["BLAVE_PROXY_TOKEN"] = "machine-secret-token"
os.environ["BLAVE_PYTHON"] = sys.executable
os.environ.pop("BLAVE_AGENT_LOCAL", None)
open(os.path.join(WS, "AGENTS.md"), "w").write("# agents\n")

# 假的 workspace lib:記下收到的東西(含 env),不碰網路
open(os.path.join(WS, "lib", "__init__.py"), "w").write("")
open(os.path.join(WS, "lib", "report_templates.py"), "w").write(r'''
import json, os
LOG = os.path.join(os.getcwd(), "calls.jsonl")
def _log(**d):
    d["env"] = dict(os.environ)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps(d, ensure_ascii=False) + "\n")
class Pack:
    def __init__(self, rid, skip=None):
        self.report_id, self.skip = rid, skip
    def describe(self):
        return f"[{self.report_id}] 收盤 1,234 點"
def check_extra(extra):
    for name, _p in extra or []:
        if name not in ("relative_perf", "coin_snapshot"):
            raise ValueError(f"extra: unknown brick {name!r}")
    return extra
def load_recipe(run_py):
    with open(os.path.join(os.path.dirname(run_py), "recipe.json"), encoding="utf-8") as f:
        return json.load(f)
def build(recipe, extra=None):
    check_extra(extra)
    _log(op="build", recipe=recipe, extra=extra)
    return Pack(recipe["id"] + "-20261026")
def _tpl(name):
    def f(*args, extra=None, **kw):
        check_extra(extra)
        _log(op="build", fn=name, args=list(args), kwargs=kw, extra=extra)
        return Pack(name + "-20261026")
    return f
tw_market_brief, tw_close_brief, crypto_market_brief, symbol_brief, research_pack = (
    _tpl(n) for n in ("tw_market_brief", "tw_close_brief", "crypto_market_brief", "symbol_brief", "research_pack"))
def publish(pack, narrative=None, title=None, lang="zh"):
    _log(op="publish", pack=pack, narrative=narrative, title=title, lang=lang)
    if "API" in title:
        from lib.report import write_report
        return write_report(pack, title, [{"type": "text", "markdown": narrative.get("summary", "")}], type="morning")
    if "FAIL" in title:
        raise ValueError("1. narrative['lead'] is 900 chars, cap 600")
    if "SKIP" in title:
        print(f"[{pack}] not published: 休市")
        return None
    os.makedirs("reports", exist_ok=True)
    path = os.path.join("reports", pack + ".json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(narrative, f, ensure_ascii=False)
    print("[report] Reply with this: done")
    return path
''')

for _f in ("report.py", "winreplace.py"):   # 真的 write_report(含 api 驗證)
    shutil.copy(os.path.join(ROOT, "lib", _f), os.path.join(WS, "lib", _f))

sdk = types.ModuleType("claude_agent_sdk")


class _Obj:
    def __init__(self, **kw):
        self.__dict__.update(kw)


for _n in ("AssistantMessage", "TextBlock", "ToolUseBlock", "ThinkingBlock", "ResultMessage", "UserMessage",
           "ToolResultBlock", "SystemMessage", "StreamEvent"):
    setattr(sdk, _n, type(_n, (_Obj,), {}))


@dataclasses.dataclass
class _Options:
    model: object = None
    env: object = None
    cwd: object = None
    tools: object = None
    allowed_tools: object = None
    disallowed_tools: object = None
    system_prompt: object = None
    max_turns: object = None
    max_budget_usd: object = None
    max_buffer_size: object = None
    permission_mode: object = None
    hooks: object = None
    setting_sources: object = None
    strict_mcp_config: object = False
    mcp_servers: object = None
    extra_args: object = None


sdk.ClaudeAgentOptions = _Options
sdk.HookMatcher = lambda matcher=None, hooks=None: {"matcher": matcher, "hooks": hooks}
sdk.tool = lambda name, desc, schema: (lambda fn: {"name": name, "handler": fn})
sdk.create_sdk_mcp_server = lambda name, version="1.0.0", tools=None: {"type": "sdk", "name": name, "tools": tools}
sdk.query = None   # set per test
sys.modules["claude_agent_sdk"] = sdk
import agent_turn as at  # noqa: E402
import report_runner as rr  # noqa: E402
import sched_pack as sp  # noqa: E402

fails = []


def t(name, ok, got=None):
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok or got is None else f"  → {got!r}"[:500]))
    if not ok:
        fails.append(name)


JOB = "tools-job"
JD = os.path.join(WS, "report_jobs", JOB)
os.makedirs(JD)
MARK = os.path.join(TMP, "pwned")
open(os.path.join(JD, "run.py"), "w").write(
    "import os, sys\nsys.path.insert(0, os.getcwd())\n"
    "from lib.report_templates import crypto_market_brief, publish\n"
    "publish(crypto_market_brief(symbols=('BTC', 'ETH'), lookback_days=30))\n")
LOG = os.path.join(WS, "calls.jsonl")


def calls():
    try:
        with open(LOG, encoding="utf-8") as f:
            return [json.loads(ln) for ln in f]
    except OSError:
        return []


def reset_log():
    try:
        os.remove(LOG)
    except OSError:
        pass


def state(job=JOB):
    return at.sched_report_state(job, "turn-abc123", WS, "Asia/Taipei", "zh")


def run(coro):
    return asyncio.run(coro)


def text(res):
    return res["content"][0]["text"]


# ── ③ build shape refusals: no subprocess, no pack ──
st = state()
for name, args in (("4 bricks", {"extra": [["coin_snapshot", {"symbol": "A"}]] * 4}),
                   ("nested dict", {"extra": [["coin_snapshot", {"symbol": {"x": 1}}]]}),
                   ("nested list", {"extra": [["coin_snapshot", {"symbols": [["BTC"]]}]]}),
                   ("over 4KB", {"extra": [["coin_snapshot", {"symbol": "A" * 5000}]]}),
                   ("a job id to switch job", {"extra": [], "job": "other-job"}),
                   ("a job_id to switch job", {"job_id": "other-job"}),
                   ("not a brick", {"extra": ["coin_snapshot"]}),
                   ("bad JSON string", {"extra": "[[\"coin_snapshot\""})):
    reset_log()
    res = run(at.sched_build(st, args))
    t(f"③ build refuses {name}, nothing spawned", res.get("is_error") and calls() == [] and st["builds"] == 0, res)

# ③ brick-level errors come from the real check_extra, original text, and no pack is kept
REAL_STATE = os.path.join(TMP, "real-state")
real_ws_ctx = {"BLAVE_AGENT_STATE": REAL_STATE, "BLAVE_AGENT_WORKSPACE": ROOT}
saved_ws = at.WORKSPACE
at.WORKSPACE = ROOT
_env_backup = {k: os.environ.get(k) for k in real_ws_ctx}
os.environ.update(real_ws_ctx)
try:
    sys.path.insert(0, ROOT)
    from lib import report_bricks as RB   # noqa: E402  (the real lib, for the expected text)
    for bad in (["no_such_brick", {}], ["coin_snapshot", {"symbol": "BTC/../x"}], ["coin_snapshot", {"symbol": "BTC;rm"}]):
        try:
            RB.check_extra([bad])
            want = None
        except ValueError as e:
            want = str(e)
        s2 = at.sched_report_state(JOB, "turn-real", ROOT, None, "zh")
        s2["call"] = {"fn": "crypto_market_brief", "args": [], "kwargs": {}}
        res = run(at.sched_build(s2, {"extra": [bad]}))
        t(f"③ {bad}: the real check_extra's own text comes back", want is not None and res.get("is_error")
          and text(res) == want, (want, res))
        t(f"③ {bad}: no pack kept", not os.path.isdir(os.path.join(REAL_STATE, "report_packs"))
          or os.listdir(os.path.join(REAL_STATE, "report_packs")) == [])
    # ④ list parameter passes the real check_extra
    try:
        ok_extra = RB.check_extra([["relative_perf", {"symbols": ["BTC", "ETH"]}]])
    except ValueError as e:
        ok_extra = e
    t("④ the real check_extra accepts relative_perf with a symbols list",
      ok_extra == [["relative_perf", {"symbols": ["BTC", "ETH"]}]], ok_extra)
finally:
    at.WORKSPACE = saved_ws
    for k, v in _env_backup.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v

# ④ and it reaches build intact; ⑤ the call is the literal one from run.py, run.py never ran
reset_log()
st = state()
res = run(at.sched_build(st, {"extra": [["relative_perf", {"symbols": ["BTC", "ETH"]}]]}))
c = calls()
t("④ list parameter builds", not res.get("is_error") and text(res) == "[crypto_market_brief-20261026] 收盤 1,234 點"
  and len(c) == 1 and c[0]["extra"] == [["relative_perf", {"symbols": ["BTC", "ETH"]}]], (res, c))
t("⑤ build got run.py's literal arguments (tuple → list), not run.py's text",
  c and c[0]["fn"] == "crypto_market_brief" and c[0]["args"] == [] and c[0]["kwargs"] == {"symbols": ["BTC", "ETH"],
                                                                                           "lookback_days": 30}, c)
t("⑤ run.py itself never ran (marker absent)", not os.path.exists(MARK))
t("③ weak-model string extra is decoded once", not run(at.sched_build(state(), {"extra": "[]"})).get("is_error"))

# ⑤ ast rules, runtime and lib side by side
from lib import report as LR  # noqa: E402
CASES = [
    ("from lib.report_templates import tw_market_brief, publish\npublish(tw_market_brief())",
     {"fn": "tw_market_brief", "args": [], "kwargs": {}}),
    ("from lib.report_templates import tw_market_brief, publish\npack = tw_market_brief()\npublish(pack)",
     {"fn": "tw_market_brief", "args": [], "kwargs": {}}),
    ("from lib.report_templates import crypto_market_brief as c\nc()", None),
    ("from lib import report_templates as R\nR.publish(R.tw_close_brief())", {"fn": "tw_close_brief", "args": [], "kwargs": {}}),
    ("import lib.report_templates\nlib.report_templates.symbol_brief('BTC')", {"fn": "symbol_brief", "args": ["BTC"], "kwargs": {}}),
    ("from lib.report_templates import tw_market_brief\nif __name__ == '__main__':\n    tw_market_brief()",
     {"fn": "tw_market_brief", "args": [], "kwargs": {}}),
    # 現行的合法寫法(references/reports.md §1b／§8 的形狀、各測試的 run.py)
    ("import os, sys\nsys.path.insert(0, os.getcwd())\nfrom lib.report_templates import crypto_market_brief, publish\n"
     "publish(crypto_market_brief(symbols=('BTC', 'ETH')))\n", {"fn": "crypto_market_brief", "args": [],
                                                              "kwargs": {"symbols": ["BTC", "ETH"]}}),
    ('"""台股晨報"""\nimport os, sys\nsys.path.insert(0, os.getcwd())\nfrom lib.report_templates import tw_close_brief, publish\n'
     "pack = tw_close_brief()\npublish(pack)\n", {"fn": "tw_close_brief", "args": [], "kwargs": {}}),
    ("import os, sys\nsys.path.insert(0, os.getcwd())\nfrom lib.report_templates import symbol_brief, publish\n"
     "if __name__ == '__main__':\n    publish(symbol_brief('2330'))\n", {"fn": "symbol_brief", "args": ["2330"], "kwargs": {}}),
    # references/reports.md §1b 的形狀(用戶機上現有 job 多半照它寫):pack = 模板,可接 print(pack.describe()),可接 publish(pack)
    ("import os, sys\nsys.path.insert(0, os.getcwd())\nfrom lib.report_templates import tw_market_brief, publish, headers_from_env\npack = tw_market_brief()\nprint(pack.describe())\npublish(pack)\n", {"fn": "tw_market_brief", "args": [], "kwargs": {}}),
    ("import os, sys\nsys.path.insert(0, os.getcwd())\nfrom lib.report_templates import tw_market_brief, publish, headers_from_env\npack = tw_market_brief()\nprint(pack.describe())\n", {"fn": "tw_market_brief", "args": [], "kwargs": {}}),
    ("import os, sys\nsys.path.insert(0, os.getcwd())\nfrom lib.report_templates import tw_market_brief, publish, headers_from_env\npack = tw_market_brief()\n", {"fn": "tw_market_brief", "args": [], "kwargs": {}}),
    ("import os, sys\nsys.path.insert(0, os.getcwd())\nfrom lib.report_templates import tw_market_brief, publish, headers_from_env\nif __name__ == '__main__':\n    pack = tw_market_brief()\n    print(pack.describe())\n    publish(pack)\n",
     {"fn": "tw_market_brief", "args": [], "kwargs": {}}),
    ("from lib.report_templates import tw_market_brief, publish, headers_from_env\npack = tw_market_brief(headers=headers_from_env(), lookback_days=30)\npublish(pack)",
     {"fn": "tw_market_brief", "args": [], "kwargs": {"lookback_days": 30}}),
    ("import os, sys\nsys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))\n"
     "from lib.report_templates import tw_market_brief, publish, headers_from_env\npublish(tw_market_brief())", {"fn": "tw_market_brief", "args": [], "kwargs": {}}),
    ("import os, sys\nsys.path.append(os.getcwd())\nfrom lib.report_templates import tw_market_brief, publish, headers_from_env\npublish(tw_market_brief())", {"fn": "tw_market_brief", "args": [], "kwargs": {}}),
    ("from lib.report_templates import tw_market_brief, publish, headers_from_env\npack = tw_market_brief()\nprint(other.describe())\npublish(pack)", None),
    ("from lib.report_templates import tw_market_brief, publish, headers_from_env\npack = tw_market_brief()\nprint(pack.describe(), 1)\npublish(pack)", None),
    ("from lib.report_templates import tw_market_brief, publish, headers_from_env\npack = tw_market_brief()\nprint(pack.describe(x))\npublish(pack)", None),
    ("from lib.report_templates import tw_market_brief, publish, headers_from_env\npack = tw_market_brief()\nprint(pack)\npublish(pack)", None),
    ("from lib.report_templates import tw_market_brief, publish, headers_from_env\npack = tw_market_brief()\nprint(pack.describe())\nprint(pack.describe())\npublish(pack)", None),
    ("from lib.report_templates import tw_market_brief, publish, headers_from_env\npack = tw_market_brief()\npublish(pack)\nprint(pack.describe())", None),
    ("from lib.report_templates import tw_market_brief, publish, headers_from_env\npack = tw_market_brief()\nprint(pack.describe(), file=f)\npublish(pack)", None),
    ("from lib.report_templates import tw_market_brief, publish, print\npack = tw_market_brief()\nprint(pack.describe())", None),
    ("import os\nos = tw_market_brief()", None),
    ("from lib.report_templates import tw_market_brief, publish, headers_from_env\ntw_market_brief = tw_market_brief()\npublish(tw_market_brief)", None),
    ("from lib.report_templates import tw_market_brief, publish, headers_from_env\npack = tw_market_brief(headers=evil())\npublish(pack)", None),
    ("from lib.report_templates import tw_market_brief, publish, headers_from_env\npack = tw_market_brief(headers=headers_from_env(1))\npublish(pack)", None),
    ("import os, sys\nsys.path.insert(0, os.system('x'))\nfrom lib.report_templates import tw_market_brief, publish, headers_from_env\npublish(tw_market_brief())", None),
    ("import os, sys\nsys.path.insert(1, os.getcwd())\nfrom lib.report_templates import tw_market_brief, publish, headers_from_env\npublish(tw_market_brief())", None),
    ("import sys\nsys.path.insert(0, os.getcwd())\nfrom lib.report_templates import tw_market_brief, publish, headers_from_env\npublish(tw_market_brief())", None),
    # 第三輪複核:裸字串路徑不收,'.'／'..' 只准當 os.path.join 的後段
    ("import os, sys\nsys.path.insert(0, '/tmp/evil')\nfrom lib.report_templates import tw_market_brief, publish, headers_from_env\npublish(tw_market_brief())", None),
    ("import os, sys\nsys.path.insert(0, 'tmp')\nfrom lib.report_templates import tw_market_brief, publish, headers_from_env\npublish(tw_market_brief())", None),
    ("import os, sys\nsys.path.append('.')\nfrom lib.report_templates import tw_market_brief, publish, headers_from_env\npublish(tw_market_brief())", None),
    ("import os, sys\nsys.path.insert(0, os.path.join('/tmp', os.getcwd()))\nfrom lib.report_templates import tw_market_brief, publish, headers_from_env\npublish(tw_market_brief())", None),
    ("import os, sys\nsys.path.insert(0, os.path.join(os.getcwd(), 'evil'))\nfrom lib.report_templates import tw_market_brief, publish, headers_from_env\npublish(tw_market_brief())", None),
    ("import os, sys\nsys.path.insert(0, os.path.dirname(os.getcwd(), 'x'))\nfrom lib.report_templates import tw_market_brief, publish, headers_from_env\npublish(tw_market_brief())", None),
    ("import os, sys\nsys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))\nfrom lib.report_templates import tw_market_brief, publish, headers_from_env\npublish(tw_market_brief())",
     {"fn": "tw_market_brief", "args": [], "kwargs": {}}),
    ("import os, sys\nsys.path.insert(0, os.path.dirname(evil))\nfrom lib.report_templates import tw_market_brief, publish, headers_from_env\npublish(tw_market_brief())", None),
    # 複審第二輪:白名單以外的任何語句都不算(實際跑的可能不是那個模板,或根本跑不到)
    ("from lib.report_templates import tw_market_brief\nfor tw_market_brief in [evil]: pass\ntw_market_brief()", None),
    ("from lib.report_templates import tw_market_brief\nwith x as tw_market_brief: pass\ntw_market_brief()", None),
    ("from lib.report_templates import tw_market_brief\ntry:\n    pass\nexcept E as tw_market_brief:\n    pass\ntw_market_brief()", None),
    ("from lib.report_templates import tw_market_brief\nwhile False: tw_market_brief = 1\ntw_market_brief()", None),
    ("from lib.report_templates import tw_market_brief\nif True:\n    def tw_market_brief(): pass\ntw_market_brief()", None),
    ("from lib.report_templates import tw_market_brief\ntry:\n    from evil import tw_market_brief\nexcept ImportError:\n    pass\n"
     "tw_market_brief()", None),
    ("from lib.report_templates import tw_market_brief\n(tw_market_brief := evil)\ntw_market_brief()", None),
    ("from lib.report_templates import tw_market_brief\nglobals()['tw_market_brief'] = evil\ntw_market_brief()", None),
    ("from lib.report_templates import tw_market_brief\ndel tw_market_brief\ntw_market_brief()", None),
    ("import lib.report_templates as T\nsetattr(T, 'tw_market_brief', evil)\nT.tw_market_brief()", None),
    ("import sys\nsys.modules['lib.report_templates'] = evil\nfrom lib.report_templates import tw_market_brief\ntw_market_brief()", None),
    ("import evil\nfrom lib.report_templates import tw_market_brief\ntw_market_brief()", None),
    ("from evil import x\nfrom lib.report_templates import tw_market_brief, publish\npublish(tw_market_brief())", None),
    ("import sys\nfrom lib.report_templates import tw_market_brief\nsys.exit(0)\ntw_market_brief()", None),
    ("from lib.report_templates import tw_market_brief\nraise SystemExit\ntw_market_brief()", None),
    ("from lib.report_templates import tw_market_brief\nif __name__ != '__main__':\n    tw_market_brief()", None),
    ("from lib.report_templates import tw_market_brief\nif __name__ == 'x':\n    tw_market_brief()", None),
    ("from lib.report_templates import tw_market_brief\nif '__main__' == __name__:\n    tw_market_brief()", None),
    ("from lib.report_templates import tw_market_brief\nif __name__ == '__main__':\n    tw_market_brief()\nelse:\n    pass", None),
    ("from lib.report_templates import tw_market_brief\nif __name__ == '__main__':\n    x = 1\n    tw_market_brief()", None),
    ("from lib.report_templates import tw_market_brief, publish\npublish(tw_market_brief())\npublish(tw_market_brief())", None),
    ("from lib.report_templates import tw_market_brief, publish\nprint('x')\npublish(tw_market_brief())", None),
    ("from lib.report_templates import tw_market_brief, publish\npublish(tw_market_brief(), narrative={'lead': 'x'})", None),
    ("from lib.report_templates import tw_market_brief, publish\npack = tw_market_brief()\npublish(other)", None),
    ("import os as sys\nsys.path.insert(0, os.getcwd())\nfrom lib.report_templates import tw_market_brief\ntw_market_brief()", None),
    ("from .lib.report_templates import tw_market_brief\ntw_market_brief()", None),
    ("from lib.report_templates import *\ntw_market_brief()", None),
    # 複審第一輪:不是 run.py 實際會跑的那個模板,一律不算
    ("publish(tw_market_brief())", None),
    ("import evil\nevil.crypto_market_brief(symbols=('BTC',))", None),
    ("from evil import crypto_market_brief\ncrypto_market_brief()", None),
    ("from lib.report_templates import tw_market_brief\nif False:\n    tw_market_brief()", None),
    ("from lib.report_templates import tw_market_brief\ndef main():\n    tw_market_brief()\nmain()", None),
    ("from lib.report_templates import crypto_market_brief\ndef crypto_market_brief(**k): pass\ncrypto_market_brief()", None),
    ("from lib.report_templates import crypto_market_brief\ncrypto_market_brief = evil\ncrypto_market_brief()", None),
    ("from lib.report_templates import tw_market_brief\nx = tw_market_brief() if False else None", None),
    ("from lib.report_templates import tw_market_brief\nx = (lambda: tw_market_brief())", None),
    ("from lib.report_templates import symbol_brief, publish\npublish(symbol_brief('2330', lookback_days=60))",
     {"fn": "symbol_brief", "args": ["2330"], "kwargs": {"lookback_days": 60}}),
    ("from lib.report_templates import symbol_brief\npublish(symbol_brief('2330'))", None),   # publish 沒有匯入
    ("import lib.report_templates as T\nT.publish(T.research_pack(\n    'BTC',\n    topics=['funding', 'oi'],\n))",
     {"fn": "research_pack", "args": ["BTC"], "kwargs": {"topics": ["funding", "oi"]}}),
    (f"from lib.report_templates import tw_market_brief, symbol_brief, crypto_market_brief, publish\npublish(tw_market_brief(__import__('os').system('touch {MARK}')))", None),
    ("from lib.report_templates import symbol_brief, publish\ns = 'BTC'\npublish(symbol_brief(s))", None),
    ("from lib.report_templates import tw_market_brief, symbol_brief, crypto_market_brief, publish\npublish(symbol_brief(pick()))", None),
    ("from lib.report_templates import tw_market_brief, symbol_brief, crypto_market_brief, publish\npublish(crypto_market_brief(**opts))", None),
    ("from lib.report_templates import tw_market_brief, symbol_brief, crypto_market_brief, publish\npublish(crypto_market_brief(*xs))", None),
    ("from lib.report_templates import tw_market_brief, symbol_brief, crypto_market_brief, publish\npublish(crypto_market_brief(extra=[['coin_snapshot', {'symbol': 'XRP'}]]))", None),
    ("from lib.report_templates import tw_market_brief, symbol_brief, crypto_market_brief, publish\npublish(symbol_brief({1, 2}))", None),
    ("from lib.report_templates import tw_market_brief, symbol_brief, crypto_market_brief, publish\npublish(symbol_brief(b'x'))", None),
    ("import pandas\nprint(1)", None),
    ("def f(:\n", None),
]
for src, want in CASES:
    got_rt, got_lib = sp.template_call(src), LR.agent_template_call(src)
    t(f"⑤ {src[:60]!r} → {want}", got_rt == want and got_lib == want, (got_rt, got_lib))
t("⑤ the __import__ argument was never evaluated (marker absent)", not os.path.exists(MARK))
t("⑤ runtime and lib list the same five templates", tuple(sp.TEMPLATE_FNS) == tuple(LR._AGENT_TEMPLATES))

# recipe job: build(load_recipe("report_jobs/<id>/run.py"))
RJ = "tools-recipe"
os.makedirs(os.path.join(WS, "report_jobs", RJ))
open(os.path.join(WS, "report_jobs", RJ, "recipe.json"), "w").write('{"id": "my-recipe"}')
open(os.path.join(WS, "report_jobs", RJ, "run.py"), "w").write(f"open({MARK!r}, 'w')\n")
reset_log()
res = run(at.sched_build(state(RJ), {"extra": []}))
c = calls()
t("⑤ recipe job: builds the recipe next to run.py", not res.get("is_error") and c and c[0]["recipe"] == {"id": "my-recipe"}
  and not os.path.exists(MARK), (res, c))

# ── ⑥ narrative is data ──
reset_log()
st = state()
run(at.sched_build(st, {"extra": []}))
EVIL = {"lead": f"\"); import os; os.system(\"touch {MARK}\")#", "read": "{{ config }} ${HOME} $(id) `id`",
        "summary": "'''\"\"\"\\n\x00 收盤", "watch": [["a", "b", "c"]],
        "news": [{"title": "x", "sources": [["鉅亨", "https://news.cnyes.com/x"]]}]}
res = run(at.sched_publish(st, {"narrative": EVIL, "title": "今日結論 {{x}} $(id)"}))
pub = [x for x in calls() if x["op"] == "publish"]
t("⑥ publish got the narrative and title byte for byte", not res.get("is_error") and pub and pub[0]["narrative"] == EVIL
  and pub[0]["title"] == "今日結論 {{x}} $(id)" and pub[0]["pack"] == "crypto_market_brief-20261026" and pub[0]["lang"] == "zh",
  (res, pub))
t("⑥ the written report holds the original strings",
  json.load(open(os.path.join(WS, "reports", "crypto_market_brief-20261026.json"), encoding="utf-8")) == EVIL)
t("⑥ nothing in the narrative ran (marker absent)", not os.path.exists(MARK))
t("⑥ publish's own printed lines come back to the model", "Reply with this" in text(res), res)

# ── ⑦ counts ──
res2 = run(at.sched_publish(st, {"narrative": {"summary": "x"}, "title": "again"}))
t("⑦ after one success publish refuses, without spawning", res2.get("is_error") and len([x for x in calls() if x["op"] == "publish"]) == 1,
  res2)
st = state()
run(at.sched_build(st, {}))
for i in range(3):
    r = run(at.sched_publish(st, {"narrative": {"summary": "x"}, "title": "FAIL"}))
    t(f"⑦ failure {i + 1}: publish's own problem text comes back", r.get("is_error") and "cap 600" in text(r), r)
reset_log()
r = run(at.sched_publish(st, {"narrative": {"summary": "x"}, "title": "ok now"}))
t("⑦ after 3 failures publish refuses, without spawning", r.get("is_error") and calls() == [], r)
st = state()
run(at.sched_build(st, {}))
run(at.sched_build(st, {}))
reset_log()
r = run(at.sched_build(st, {}))
t("⑦ build at most twice", r.get("is_error") and calls() == [] and st["builds"] == 2, r)
st = state()
t("⑦ publish before any build is refused", run(at.sched_publish(st, {"narrative": {}, "title": "x"})).get("is_error"))
run(at.sched_build(st, {}))
for bad, why in (({"narrative": {"images": []}, "title": "x"}, "images key"),
                 ({"narrative": {"summary": "x" * 40000}, "title": "x"}, "over 32KB"),
                 ({"narrative": {"summary": "x"}, "title": "x" * 121}, "title over 120"),
                 ({"narrative": {"summary": "x"}, "title": "x", "report_id": "other-20261026"}, "a report id it did not build"),
                 ({"narrative": "not json", "title": "x"}, "narrative not JSON"),
                 ({"narrative": {"summary": "x"}, "title": "x", "replace": True}, "replace")):
    reset_log()
    r = run(at.sched_publish(st, bad))
    t(f"⑦ publish refuses {why}, without spawning or counting", r.get("is_error") and calls() == [] and st["publishes"] == 0, r)
r = run(at.sched_publish(st, {"narrative": "{\"summary\": \"x\"}", "title": "SKIP"}))
t("⑦ a pack that will not publish today is not a success", r.get("is_error") and not st["published"] and "休市" in text(r), r)

# ⑦ resume: the second sdk.query of the same run_turn keeps the counts
at._apply_scheduled_limits()
os.environ["BLAVE_SCHEDULED_JOB"] = JOB
attempts = []


async def resume_query(prompt, options):
    tools = {x["name"]: x["handler"] for x in options.mcp_servers["blave_report"]["tools"]}
    attempts.append(options.mcp_servers["blave_report"])
    if len(attempts) == 1:
        await tools["build"]({"extra": []})
        r1 = await tools["publish"]({"narrative": {"summary": "x"}, "title": "first"})
        attempts.append(("first", r1))
        if False:
            yield None
        return
    r2 = await tools["publish"]({"narrative": {"summary": "y"}, "title": "second"})
    attempts.append(("second", r2))
    yield sdk.AssistantMessage(content=[sdk.TextBlock(text="done")])


sdk.query = resume_query
reset_log()
with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
    asyncio.run(at.run_turn(f"sched-{JOB}", "報告", "deepseek/deepseek-v4-pro", at.ReportSink(f"sched-{JOB}")))
servers = [a for a in attempts if isinstance(a, dict)]
results = dict(a for a in attempts if isinstance(a, tuple))
t("⑦ the empty first attempt was resumed with the same report server", len(servers) == 2 and servers[0] is servers[1],
  attempts)
t("⑦ after resuming, the publish that succeeded before is still counted", not results.get("first", {}).get("is_error")
  and results.get("second", {}).get("is_error") and "already published" in text(results["second"]), results)
t("⑦ only one report was published", len([x for x in calls() if x["op"] == "publish"]) == 1)

# ── ⑧ env ──
c = calls()
blds, pubs = [x for x in c if x["op"] == "build"], [x for x in c if x["op"] == "publish"]
t("⑧ build's env has no BLAVE_PROXY_TOKEN; nothing ANTHROPIC_* in either",
  blds and all("BLAVE_PROXY_TOKEN" not in x["env"] for x in blds)
  and all(not any(k.startswith("ANTHROPIC_") for k in x["env"]) for x in c), blds[:1])
t("⑧ publish's env carries the machine token (the api validates the report with it)",
  pubs and all(x["env"].get("BLAVE_PROXY_TOKEN") == "machine-secret-token" for x in pubs), pubs[:1])
ids = {x["env"].get("BLAVE_TURN_ID") for x in c}
t("⑧ build and publish ran with the same BLAVE_TURN_ID, and it is the turn's", len(ids) == 1 and None not in ids, ids)
t("⑧ BLAVE_SCHEDULED_JOB and PYTHONPATH are set", all(x["env"].get("BLAVE_SCHEDULED_JOB") == JOB
                                                       and x["env"].get("PYTHONPATH", "").split(os.pathsep)[0] == WS for x in c))
base = {"PATH": "/usr/bin", "HOME": "/h", "BLAVE_PROXY_TOKEN": "s", "BLAVE_TELEGRAM_TOKEN": "s", "AWS_SECRET_ACCESS_KEY": "s",
        "OPENAI_API_KEY": "s", "CLAUDE_CODE_OAUTH_TOKEN": "s", "SystemRoot": "C:\\Windows", "TEMP": "C:\\t",
        "BLAVE_AGENT_STATE": "/st", "BLAVE_DATA_ACCESS": "1", "ANTHROPIC_API_KEY": "s", "BLAVE_API_BASE": "https://test.x",
        "BLAVE_REPORT_URL": "https://test.x/r"}
SECRETS = ("BLAVE_TELEGRAM_TOKEN", "AWS_SECRET_ACCESS_KEY", "OPENAI_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY")
for system in ("Linux", "Windows"):
    b_env = at.sched_tool_env(state(), "build", base=base, system=system)
    p_env = at.sched_tool_env(state(), "publish", base=base, system=system)
    t(f"⑧ {system}: allowlist — no secret but the publish token, source overrides kept",
      not any(k in b_env or k in p_env for k in SECRETS) and "BLAVE_PROXY_TOKEN" not in b_env
      and p_env.get("BLAVE_PROXY_TOKEN") == "s" and b_env["BLAVE_AGENT_STATE"] == "/st" and b_env["BLAVE_DATA_ACCESS"] == "1"
      and b_env["BLAVE_API_BASE"] == "https://test.x" and p_env["BLAVE_REPORT_URL"] == "https://test.x/r"
      and b_env["TZ"] == "Asia/Taipei" and b_env["BLAVE_TURN_ID"] == "turn-abc123", (b_env, p_env))
    t(f"⑧ {system}: Windows system variables only on Windows",
      ("SystemRoot" in b_env and "TEMP" in b_env) == (system == "Windows"), b_env)

# ⑧ the api refuses the report → its text comes back, nothing is written, no .published (runner falls back to data)
import http.server, threading  # noqa: E401,E402
api = {"code": 400, "seen": []}


class _Api(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        self.rfile.read(int(self.headers.get("content-length") or 0))
        api["seen"].append((self.path, self.headers.get("x-api-key")))
        body = json.dumps({"error": "blocks[0]: text over 4000 chars"}).encode() if api["code"] != 200 else b"{}"
        self.send_response(api["code"])
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(body)


srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Api)
threading.Thread(target=srv.serve_forever, daemon=True).start()
os.environ["BLAVE_REPORT_URL"] = f"http://127.0.0.1:{srv.server_address[1]}/openclaw/agent/report"
PUBLISHED = os.path.join(JD, ".published")
for f_ in (PUBLISHED,):
    if os.path.exists(f_):
        os.remove(f_)
st = state()
run(at.sched_build(st, {}))
r = run(at.sched_publish(st, {"narrative": {"summary": "x"}, "title": "API refused"}))
t("⑧ api refusal: the tool result is the api's own text, the run is not marked published",
  r.get("is_error") and "HTTP 400" in text(r) and "text over 4000 chars" in text(r) and not st["published"], r)
t("⑧ api refusal: the api got the machine token", api["seen"] and api["seen"][-1][1] == "proxy-machine-secret-token"
  and "/crypto_market_brief-20261026" in api["seen"][-1][0] and api["seen"][-1][0].endswith("/validate"), api["seen"])
t("⑧ api refusal: no report file, no .published — the runner falls back to the data-only report",
  not os.path.exists(PUBLISHED) and not os.path.exists(os.path.join(WS, "reports", "crypto_market_brief-20261026-2.json"))
  and rr._published(PUBLISHED) == [])
api["code"] = 200
r = run(at.sched_publish(st, {"narrative": {"summary": "fixed"}, "title": "API ok"}))
t("⑧ the fixed narrative passes the api: written, .published records it",
  not r.get("is_error") and st["published"] and rr._published(PUBLISHED) != [], (r, rr._published(PUBLISHED)))
srv.shutdown()
os.environ.pop("BLAVE_REPORT_URL", None)

# ── ⑨ no_template ──
CJ = "tools-custom"
os.makedirs(os.path.join(WS, "report_jobs", CJ))
custom = "import os, sys\nsys.path.insert(0, os.getcwd())\nfrom lib.report import write_report\nwrite_report('x', 't', [])\n"
open(os.path.join(WS, "report_jobs", CJ, "run.py"), "w").write(custom)
rr._agent_turn_cloud = lambda *a, **k: (_ for _ in ()).throw(AssertionError("no turn for a custom run.py"))
rr.single_slot = lambda: False
res = rr._try_agent({"id": CJ, "agent_consent": True, "schedule": {"tz": "Asia/Taipei"}}, os.path.join(WS, "report_jobs", CJ),
                    0, None, None)
t("⑨ custom run.py → agent_skipped no_template, no turn", res == {"mode": "data", "agent_skipped": "no_template", "out": ""},
  res)
t("⑨ a template job is not skipped as no_template", rr.pack_call({"id": JOB}) is not None and rr.pack_call({"id": RJ}) == {"recipe": True})
os.makedirs(os.environ["BLAVE_AGENT_STATE"], exist_ok=True)
open(os.path.join(os.environ["BLAVE_AGENT_STATE"], "turn_limits.json"), "w").write('{"max_turns": 2, "trial": false}')
LR.JOBS_DIR = os.path.join(WS, "report_jobs")
for script, consent, want in ((custom, True, True), ("from lib.report_templates import tw_market_brief, publish\n"
                                                    "publish(tw_market_brief())\n", True, False), (custom, None, False)):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        LR.register_schedule("reg-x", "t", "p", "30 8 * * *", "每天 08:30", script, tz="Asia/Taipei", agent_consent=consent)
    t(f"⑨ register_schedule consent={consent} {script[:24]!r}: reminder {'printed' if want else 'not printed'}",
      (LR.NO_AGENT_NOTE in buf.getvalue()) == want, buf.getvalue())
    if consent is True:
        LR.register_schedule("reg-x", "t", "p", "30 8 * * *", "每天 08:30", script, tz="Asia/Taipei", agent_consent=False)

# ── 分類 dry-run(tools/sched_job_classify.py):唯讀,數得出「帶 consent 卻會變 no_template」的 job ──
import hashlib, subprocess  # noqa: E401,E402
CW = os.path.join(TMP, "classify-ws")
def _job(jid, run_py, consent, recipe=False, kind=None):
    d = os.path.join(CW, "report_jobs", jid)
    os.makedirs(d)
    doc = {"id": jid}
    if consent:
        doc["agent_consent"] = True
    if kind:
        doc["kind"] = kind
    open(os.path.join(d, "job.json"), "w").write(json.dumps(doc))
    open(os.path.join(d, "run.py"), "w").write(run_py)
    if recipe:
        open(os.path.join(d, "recipe.json"), "w").write("{}")
_job("c-tpl", "from lib.report_templates import tw_market_brief, publish\npack = tw_market_brief()\n"
              "print(pack.describe())\npublish(pack)\n", True)
_job("c-custom", f"open({MARK!r}, 'w')\n", True)
_job("c-recipe", "x", True, recipe=True)
_job("n-custom", "print(1)\n", False)
_job("w-old", "", True, kind="watch")
os.makedirs(os.path.join(CW, "report_jobs", "c-bad"))
open(os.path.join(CW, "report_jobs", "c-bad", "job.json"), "w").write("{")
def _snapshot():
    h = {}
    for root, _d, files in os.walk(CW):
        for f in files:
            pth = os.path.join(root, f)
            h[pth] = (os.path.getmtime(pth), hashlib.sha1(open(pth, "rb").read()).hexdigest())
    return h
before = _snapshot()
TOOLD = os.path.join(TMP, "classify-tool")   # 照 docstring:兩個檔複製到 workspace 外的新目錄,-I -B 跑
os.makedirs(TOOLD)
shutil.copy(os.path.join(ROOT, "tools", "sched_job_classify.py"), TOOLD)
shutil.copy(os.path.join(ROOT, "runtime", "sched_pack.py"), TOOLD)
for _m in ("json.py", "ast.py"):   # 被種在旁邊、跟標準庫同名的模組不能被 import
    open(os.path.join(TOOLD, _m), "w").write(f"open({MARK!r}, 'w')\n")
r = subprocess.run([sys.executable, "-I", "-B", os.path.join(TOOLD, "sched_job_classify.py"), "--workspace", CW],
                   capture_output=True, text=True, timeout=60, cwd=TOOLD)
lines = [json.loads(x) for x in r.stdout.splitlines()]
got = {x["job"]: (x["agent_consent"], x["class"]) for x in lines if "job" in x}
t("classify: one line per job, the runtime's own classes", r.returncode == 0 and got == {
    "c-tpl": (True, "template"), "c-custom": (True, "no_template"), "c-recipe": (True, "recipe"),
    "n-custom": (False, "no_template"), "c-bad": (False, "bad_job")}, (r.returncode, got, r.stderr[-300:]))
t("classify: summary counts the consented jobs that would lose the AI commentary",
  lines and lines[-1] == {"summary": True, "jobs": 5, "with_consent": 3, "consent_no_template": 1}, lines[-1:])
t("classify: read-only — no file changed or added, no run.py ran, no run.py text printed",
  _snapshot() == before and not os.path.exists(MARK) and "open(" not in r.stdout)
t("classify: -I -B from its own directory writes nothing there and imports no planted module",
  sorted(os.listdir(TOOLD)) == ["ast.py", "json.py", "sched_job_classify.py", "sched_pack.py"] and not os.path.exists(MARK),
  os.listdir(TOOLD))

if fails:
    sys.exit(f"{len(fails)} failed: {fails}")
print("all passed")
