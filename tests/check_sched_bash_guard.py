"""排程報告回合沒有 shell(稽核 10-26 R1;取代 09-29 的 Bash 正規式守門)。

雲端排程報告回合沒人在場、會讀任意新聞頁。鎖(走真正的入口 agent_turn.main --scheduled,stub SDK 收下 options):
  ① options:tools 剛好是白名單(DeepSeek = WebFetch;Claude 系 = WebFetch + WebSearch);setting_sources == []、
     strict_mcp_config、disable-slash-commands、CLAUDE_CODE_DISABLE_AUTO_MEMORY 四項都在;mcp_servers 只有 blave_report;
     disallowed_tools 再列 Bash / Write / Edit / Read…;
  ② PreToolUse deny-all hook(matcher 全部工具):Bash / Write / Read / Skill / mcp__other__x 拒,白名單放行;
     WebFetch 只放 https + 公網主機;
  ③ hook 掛不上(HookMatcher 不在、_add_hook 回 False)、SDK 沒有 tools= / in-process MCP、job 不是模板 → 不起回合、寫 fault;
  ④ --scheduled --engine=codex → 不起回合、寫 fault;
  ⑤ 聊天回合(雲端)不受影響:tools= 是聊天回合那份(有 Bash),沒有 blave_report、不隔離設定;
  ⑥ 電腦版的設定隔離跟排程回合是同一支 _isolate_settings。

跑法:cd blave-agent && .venv/bin/python tests/check_sched_bash_guard.py
"""
import asyncio, atexit, contextlib, dataclasses, io, json, os, shutil, sys, tempfile, types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))
WS = tempfile.mkdtemp(prefix="check-sched-nobash-ws-")
atexit.register(shutil.rmtree, WS, True)
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ["BLAVE_AGENT_DB"] = os.path.join(WS, "session.db")
os.environ["BLAVE_AGENT_STATE"] = os.path.join(WS, "state")
os.environ["BLAVE_AGENT_HOME"] = WS
os.environ["BLAVE_AGENT_MODEL_PREFS"] = os.path.join(WS, "state", "model_prefs.json")
os.environ.pop("BLAVE_AGENT_LOCAL", None)
open(os.path.join(WS, "AGENTS.md"), "w").write("# agents\n")

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
sdk.tool = lambda name, desc, schema: (lambda fn: {"name": name, "handler": fn, "schema": schema})
sdk.create_sdk_mcp_server = lambda name, version="1.0.0", tools=None: {"type": "sdk", "name": name, "tools": tools}
seen = {}


INIT = {"claude_code_version": "2.1.281", "tools": ["WebFetch", "mcp__blave_report__build", "mcp__blave_report__publish"],
        "mcp_servers": [{"name": "blave_report", "status": "connected", "source": "sdk"}]}


async def fake_query(prompt, options):
    seen.setdefault("calls", []).append(options)
    yield sdk.SystemMessage(subtype="init", data=INIT)
    yield sdk.AssistantMessage(content=[sdk.ToolUseBlock(id="t1", name="WebFetch", input={"url": "https://x.com/"})])
    yield sdk.AssistantMessage(content=[sdk.TextBlock(text="好")])


sdk.query = fake_query
sys.modules["claude_agent_sdk"] = sdk
import agent_turn as at  # noqa: E402

fails = []


def t(name, ok, got=None):
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok or got is None else f"  → {got!r}"[:400]))
    if not ok:
        fails.append(name)


JOB = "sched-guard"
JD = os.path.join(WS, "report_jobs", JOB)
os.makedirs(JD, exist_ok=True)
TEMPLATE_RUN_PY = ("from lib.report_templates import crypto_market_brief, publish\n"
                   "publish(crypto_market_brief(symbols=('BTC', 'ETH')))\n")
open(os.path.join(JD, "run.py"), "w").write(TEMPLATE_RUN_PY)
RESULT = os.path.join(JD, ".sched_result.json")


def main_turn(model, engine=None):
    """agent_turn.main --scheduled → (options handed to sdk.query or None, .sched_result.json)."""
    seen.clear()
    at.SCHED_OUTCOME.clear()
    try:
        os.remove(RESULT)
    except OSError:
        pass
    os.environ["BLAVE_SCHEDULED_JOB"] = JOB
    sys.argv = ["agent_turn.py", "--delivery=report", "--scheduled", f"--model={model}"] \
        + ([f"--engine={engine}"] if engine else []) + ["--", f"sched-{JOB}", "報告"]
    err = io.StringIO()
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(err):
        at.main()
    seen["stderr"] = err.getvalue()
    try:
        res = json.load(open(RESULT))
    except (OSError, ValueError):
        res = {}
    calls = seen.get("calls") or []
    return (calls[0] if calls else None), res


BLOCKED = ["Bash", "Write", "Edit", "MultiEdit", "Read", "Glob", "Grep", "NotebookEdit", "Task", "Agent", "Skill",
           "PowerShell"]
REPORT = ["mcp__blave_report__build", "mcp__blave_report__publish"]

for model, want in (("deepseek/deepseek-v4-pro", ["WebFetch"]),
                    ("anthropic/claude-sonnet-4-6", ["WebFetch", "WebSearch"])):
    o, res = main_turn(model)
    t(f"① {model}: the turn starts", o is not None, res)
    if o is None:
        continue
    t(f"① {model}: tools == {want} (the built-in tool list itself)", o.tools == want, o.tools)
    t(f"① {model}: allowed_tools = whitelist + the two report tools", o.allowed_tools == want + REPORT, o.allowed_tools)
    t(f"① {model}: setting_sources == [] / strict_mcp_config / disable-slash-commands / no auto memory",
      o.setting_sources == [] and o.strict_mcp_config is True and "disable-slash-commands" in (o.extra_args or {})
      and (o.env or {}).get("CLAUDE_CODE_DISABLE_AUTO_MEMORY") == "1",
      (o.setting_sources, o.strict_mcp_config, o.extra_args, (o.env or {}).get("CLAUDE_CODE_DISABLE_AUTO_MEMORY")))
    t(f"① {model}: mcp_servers is blave_report only, with build + publish",
      isinstance(o.mcp_servers, dict) and list(o.mcp_servers) == ["blave_report"]
      and [x["name"] for x in o.mcp_servers["blave_report"]["tools"]] == ["build", "publish"], o.mcp_servers)
    t(f"① {model}: disallowed_tools lists every tool that runs or reads/writes",
      all(x in o.disallowed_tools for x in BLOCKED), [x for x in BLOCKED if x not in o.disallowed_tools])
    t(f"① {model}: the system prompt file is still appended", "append-system-prompt-file" in (o.extra_args or {}))
o, _res = main_turn("deepseek/deepseek-v4-pro")
t("① run.log gets the engine's init tool list and the MCP state (what the 29026 canary checks)",
  '[agent_turn] scheduled init: tools=["WebFetch", "mcp__blave_report__build", "mcp__blave_report__publish"] '
  'mcp=["blave_report:connected"]' in seen["stderr"], seen["stderr"])
t("① run.log gets the tools the turn used", '[agent_turn] scheduled tools used: {"WebFetch": 1}' in seen["stderr"],
  seen["stderr"])
t("① the turn's tool split is the prompt's (sched_pack.fetch_only): a runner that passes no model gets the "
  "WebFetch prompt, and agent_turn's default model is a WebFetch-only one",
  at.sched_pack.fetch_only(None) and at.scheduled_tools(at.model_prefs.DEFAULT_MODEL) == ["WebFetch"])

# ② deny-all hook
o, _res = main_turn("deepseek/deepseek-v4-pro")
gates = [h for m in ((o.hooks or {}).get("PreToolUse") or []) if m["matcher"] is None for h in m["hooks"]] if o else []
t("② a PreToolUse hook with no matcher (every tool) is mounted", len(gates) == 1, o and o.hooks)
gate = gates[0] if gates else None


def decide(name, tool_input=None, g=None):
    g = g or gate
    out = asyncio.run(g({"tool_name": name, "tool_input": tool_input or {}}, "t1", None)) if g else {}
    return (out.get("hookSpecificOutput") or {}).get("permissionDecision"), out


for name in ("Bash", "Write", "Read", "Skill", "mcp__other__x", "Edit", "Glob", "Grep", "Task", "Monitor", "WebSearch"):
    d, out = decide(name, {"command": "echo x > lib/runner.py"})
    t(f"② {name} → deny with the runtime's reason (DeepSeek: WebSearch is not on its list either)", d == "deny"
      and (out.get("hookSpecificOutput") or {}).get("permissionDecisionReason") == at.SCHED_TOOL_DENY_REASON, out)
for name in REPORT:
    t(f"② {name} → allowed", decide(name, {"extra": []})[0] is None)
real_defaults = at.webfetch_refusal.__defaults__
at.webfetch_refusal.__defaults__ = (lambda host, *a, **k: [(2, 1, 6, "", ("104.18.1.1", 443))],)
try:
    t("② WebFetch to a public https host → allowed", decide("WebFetch", {"url": "https://news.cnyes.com/x"})[0] is None)
    for url in ("http://news.cnyes.com/x", "https://169.254.169.254/latest/meta-data/", "https://localhost/x",
                "https://metadata.google.internal/x", "https://10.0.0.5/", "https://[::1]/", "https://2130706433/",
                "https://0x7f.1/", "https://news.cnyes.com:8443/x", "file:///etc/passwd", None,
                # 複審 P2:Python 讀成 example.com、CLI(WHATWG)讀成 10.0.0.5
                "https://10.0.0.5\\@example.com/", "https://10.0.0.5\\example.com/", "https://user:pw@example.com/",
                "https://example.com/ x", "https://exa\tmple.com/", "https://example.com/\x00", "https://example.com/\x7f"):
        t(f"② WebFetch {url} → deny", decide("WebFetch", {"url": url})[0] == "deny")
    at.webfetch_refusal.__defaults__ = (lambda host, *a, **k: [(2, 1, 6, "", ("169.254.169.254", 443))],)
    t("② WebFetch to a name that resolves to the metadata address → deny",
      decide("WebFetch", {"url": "https://169.254.169.254.nip.io/"})[0] == "deny")
    at.webfetch_refusal.__defaults__ = (lambda host, *a, **k: [(10, 1, 6, "", ("::ffff:10.0.0.1", 443, 0, 0))],)
    t("② WebFetch to a name that resolves to an IPv4-mapped private address → deny",
      decide("WebFetch", {"url": "https://evil.example/"})[0] == "deny")
    at.webfetch_refusal.__defaults__ = (lambda host, *a, **k: [(10, 1, 6, "", ("64:ff9b::a9fe:a9fe", 443, 0, 0))],)
    t("② WebFetch to a name that resolves to a NAT64 address of 169.254.169.254 → deny",
      decide("WebFetch", {"url": "https://evil.example/"})[0] == "deny")
    at.webfetch_refusal.__defaults__ = (lambda host, *a, **k: [(10, 1, 6, "", ("64:ff9b::6812:101", 443, 0, 0))],)
    t("② a NAT64 address of a public IPv4 is still fetched", decide("WebFetch", {"url": "https://ok.example/"})[0] is None)
finally:
    at.webfetch_refusal.__defaults__ = real_defaults
o_c, _ = main_turn("anthropic/claude-sonnet-4-6")
g_c = [h for m in o_c.hooks["PreToolUse"] if m["matcher"] is None for h in m["hooks"]][0] if o_c else None
t("② Claude model: WebSearch is allowed by the gate", g_c is not None and decide("WebSearch", {"query": "x"}, g_c)[0] is None)

# ③ hook / SDK features missing → not started, fault written
real_hm = at._HOOK_MATCHER
at._HOOK_MATCHER = None
try:
    o, res = main_turn("deepseek/deepseek-v4-pro")
    t("③ no HookMatcher → sdk.query never called, fault in .sched_result.json",
      o is None and res.get("fault") == at.FAULT_SCHED_UNSUPPORTED, (o, res))
finally:
    at._HOOK_MATCHER = real_hm
real_add = at._add_hook
at._add_hook = lambda options, event, matcher, fn: False if matcher is None else real_add(options, event, matcher, fn)
try:
    o, res = main_turn("deepseek/deepseek-v4-pro")
    t("③ the deny-all hook cannot be mounted → not started, fault",
      o is None and res.get("fault") == at.FAULT_SCHED_GUARD, (o, res))
finally:
    at._add_hook = real_add
real_create = sdk.create_sdk_mcp_server
del sdk.create_sdk_mcp_server
try:
    o, res = main_turn("deepseek/deepseek-v4-pro")
    t("③ no in-process MCP in the SDK → not started, fault",
      o is None and res.get("fault") == at.FAULT_SCHED_UNSUPPORTED, (o, res))
finally:
    sdk.create_sdk_mcp_server = real_create
_fields = _Options.__dataclass_fields__
_tools_field = _fields.pop("tools")
try:
    o, res = main_turn("deepseek/deepseek-v4-pro")
    t("③ an SDK without tools= → not started, fault",
      o is None and res.get("fault") == at.FAULT_SCHED_UNSUPPORTED, (o, res))
finally:
    _fields["tools"] = _tools_field
open(os.path.join(JD, "run.py"), "w").write("import os\nos.system('x')\n")
o, res = main_turn("deepseek/deepseek-v4-pro")
t("③ a job that is not a template / recipe → not started, fault",
  o is None and res.get("fault") == at.FAULT_SCHED_JOB, (o, res))
open(os.path.join(JD, "run.py"), "w").write(TEMPLATE_RUN_PY)

# ④ codex
o, res = main_turn("gpt-5", engine="codex")
t("④ --scheduled --engine=codex → not started, fault",
  o is None and res.get("fault") == at.FAULT_SCHED_CODEX, (o, res))
seen.clear()
at.SCHED_OUTCOME.clear()
with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
    out = asyncio.run(at.run_turn(f"sched-{JOB}", "報告", None, at.ReportSink(f"sched-{JOB}"), engine="codex"))
t("④ run_turn itself refuses a scheduled codex turn too (main is not the only gate)",
  not seen.get("calls") and out == "" and at.SCHED_OUTCOME.get("fault") == at.FAULT_SCHED_CODEX, at.SCHED_OUTCOME)

# ⑤ 聊天回合不變(同一個行程:SCHEDULED_TURN 已是 True,暫時關掉)
at.SCHEDULED_TURN = False
seen.clear()
with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
    asyncio.run(at.run_turn("chat-x", "hi", "deepseek/deepseek-v4-pro", at.WebSink(None, None, "chat-x")))
c = (seen.get("calls") or [None])[0]
t("⑤ cloud chat turn: the chat tools= list (not the scheduled one), no report server, settings not isolated, Bash allowed",
  c is not None and c.tools == at.chat_tools(None, False) and "Bash" in c.tools and not c.mcp_servers and c.setting_sources is None and "Bash" in c.allowed_tools
  and "Bash" not in c.disallowed_tools, c)
_ct = {k: at.chat_tools(*k) for k in ((None, False), (None, True), ("on", True), ("off", False))}
t("⑤ chat tools=: ToolSearch (deferred browser tools) and TaskOutput always; web tools only where web_tools_off leaves them",
  all("ToolSearch" in v and "TaskOutput" in v and "Bash" in v for v in _ct.values())
  and {"WebSearch", "WebFetch"} <= set(_ct[(None, False)]) and "WebFetch" not in _ct[(None, True)]
  and "WebSearch" in _ct[(None, True)] and not {"WebSearch", "WebFetch"} & set(_ct[("on", True)] + _ct[("off", False)])
  and not {"CronList", "NotebookEdit", "Skill", "Workflow", "Task", "Agent"} & set(sum(_ct.values(), [])), _ct)
t("⑤ cloud chat turn: no deny-all gate",
  c is not None and not any(m["matcher"] is None for m in (c.hooks or {}).get("PreToolUse") or []))
at.SCHEDULED_TURN = True

# ⑥ 電腦版與排程同一支隔離
src = open(at.__file__, encoding="utf-8").read()
run_turn_src = src[src.index("async def run_turn("):src.index("def main():")]
t("⑥ the desktop branch isolates through _isolate_settings, no second copy of the four settings",
  run_turn_src.count("_isolate_settings(options, turn_env)") == 1 and "setting_sources = []" not in run_turn_src
  and src.count("options.setting_sources = []") == 1)
t("⑥ the dead Bash-regex guard is gone", not any(n in src for n in (
    "sched_bash_denied", "_sched_bash_guard_hooks", "SCHED_BASH_DENY_RE", "_SCHED_FROZEN")))

if fails:
    sys.exit(f"{len(fails)} failed: {fails}")
print("all passed")
