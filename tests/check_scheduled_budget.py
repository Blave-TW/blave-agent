"""The scheduled report turn's USD cap reaches the SDK (audit 0.1.7 P2-1: the old check read the
constant only — deleting the line that applies it stayed green). Runs run_turn with a stub SDK and
reads the options it was handed. Run: cd blave-agent && .venv/bin/python tests/check_scheduled_budget.py
"""
import asyncio, contextlib, dataclasses, io, os, sys, tempfile, types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))
WS = tempfile.mkdtemp(prefix="sched-budget-")
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ["BLAVE_AGENT_DB"] = os.path.join(WS, "session.db")
os.environ["BLAVE_AGENT_STATE"] = os.path.join(WS, "state")
os.environ["BLAVE_AGENT_HOME"] = WS
os.environ["BLAVE_AGENT_MODEL_PREFS"] = os.path.join(WS, "state", "model_prefs.json")
open(os.path.join(WS, "AGENTS.md"), "w").write("# agents\n")

sdk = types.ModuleType("claude_agent_sdk")
class _Obj:
    def __init__(self, **kw): self.__dict__.update(kw)
for _n in ("AssistantMessage", "TextBlock", "ToolUseBlock", "ThinkingBlock", "ResultMessage", "UserMessage",
           "ToolResultBlock", "SystemMessage", "StreamEvent"):
    setattr(sdk, _n, type(_n, (_Obj,), {}))

@dataclasses.dataclass
class _Options:
    model: object = None
    env: object = None
    cwd: object = None
    allowed_tools: object = None
    disallowed_tools: object = None
    system_prompt: object = None
    max_turns: object = None
    max_budget_usd: object = None
    max_buffer_size: object = None
    permission_mode: object = None
    hooks: object = None

sdk.ClaudeAgentOptions = _Options
sdk.HookMatcher = lambda matcher=None, hooks=None: {"matcher": matcher, "hooks": hooks}
seen = {}

async def fake_query(prompt, options):
    seen["options"] = options
    yield sdk.AssistantMessage(content=[sdk.TextBlock(text="好")])

sdk.query = fake_query
sys.modules["claude_agent_sdk"] = sdk
import agent_turn as at  # noqa: E402

fails = []
def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f"  {detail!r}"[:300]))
    if not ok:
        fails.append(name)

def turn(model="sonnet"):
    seen.clear()
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        asyncio.run(at.run_turn("sched-x", "報告", model, at.ReportSink("sched-x")))
    return seen["options"]

chat = turn()
check("chat turn: the normal budget (10 USD, 100 steps — browser-UI tasks measured ~60 clean; Wei 09-27)",
      chat.max_budget_usd == 10 and chat.max_turns == 100, (chat.max_budget_usd, chat.max_turns))
dchat = turn("deepseek/deepseek-v4-pro")
check("chat DeepSeek turn: no USD cap either (audit A-P1-2 — the CLI's Claude-priced fake budget cut it at ~86 "
      "of the 100 steps); the brakes are 100 steps + the wall clock / bridge timeout",
      dchat.max_budget_usd is None and dchat.max_turns == 100, (dchat.max_budget_usd, dchat.max_turns))
# 走真正的入口:agent_turn.main() 帶 --scheduled(report_runner 起回合的那條命令列)。
# 直接呼叫 _apply_scheduled_limits() 測不到 main 有沒有真的套用——複審:拿掉 main 裡那一行照樣綠。
job = "budget-x"
os.makedirs(os.path.join(WS, "report_jobs", job), exist_ok=True)
os.environ["BLAVE_SCHEDULED_JOB"] = job
sys.argv = ["agent_turn.py", "--delivery=report", "--scheduled", "--model=sonnet", "--", f"sched-{job}", "報告"]
seen.clear()
with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
    at.main()
o = seen["options"]
cap = at.SCHEDULED_MAX_BUDGET_USD
check("scheduled turn (main --scheduled): the SDK gets the cap minus one step's margin, never more than Wei's 1.0 USD",
      cap == 1.0 and 0 < o.max_budget_usd == round(cap - at.SCHEDULED_STEP_MARGIN_USD, 6) < cap, o.max_budget_usd)
check("the margin covers the largest measured warm Sonnet step (0.158 USD, 09-26)", at.SCHEDULED_STEP_MARGIN_USD >= 0.158,
      at.SCHEDULED_STEP_MARGIN_USD)
sys.argv = ["agent_turn.py", "--delivery=report", "--scheduled", "--model=deepseek/deepseek-v4-pro", "--", "sched-budget-x", "報告"]
seen.clear()
with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
    at.main()
dso = seen["options"]
check("scheduled DeepSeek turn: no USD cap for the SDK (the CLI prices it off Claude's tables — "
      "29026 hit 1.045 in 9 steps); the brakes are 25 steps + the runner's 10 minutes",
      dso.max_budget_usd is None and dso.max_turns == 25, dso.max_budget_usd)
check("the trust rule itself: deepseek untrusted, claude family trusted",
      not at._cli_cost_trusted("deepseek/deepseek-v4-pro") and at._cli_cost_trusted("sonnet")
      and at._cli_cost_trusted("anthropic/claude-sonnet-5") and not at._cli_cost_trusted(None))
# Edit(...) 規則同時擋 Write(1.1.104 起 SCHEDULED_EDIT_RULES 只列 Edit,見 agent_turn 的註解)
check("scheduled turn: 25 steps and Edit/Write kept out of strategies/ control/",
      o.max_turns == 25 and "Edit(/strategies/**)" in o.disallowed_tools and "Edit(/control/**)" in o.disallowed_tools,
      (o.max_turns, o.disallowed_tools))

# 電腦版牆鐘(稽核 A-P1-2:LocalSink 沒有 bridge 逾時):超過 _TURN_WALL_CLOCK_SEC 就收掉回合、不續跑
async def endless_query(prompt, options):
    seen["options"] = options
    for i in range(400):
        yield sdk.AssistantMessage(content=[sdk.ToolUseBlock(id=f"t{i}", name="Bash", input={"command": "x"})])
    yield sdk.AssistantMessage(content=[sdk.TextBlock(text="never reached")])

sdk.query = endless_query
at._TURN_WALL_CLOCK_SEC = -1          # 立即到期:第一個訊息之後就該停
buf = io.StringIO()
with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(buf):
    out = asyncio.run(at.run_turn("local-x", "做策略", "deepseek/deepseek-v4-pro", at.LocalSink("local-x")))
check("desktop wall clock: an over-time LocalSink turn is stopped (no resume) and the user gets the partial-fault line",
      buf.getvalue().count("wall clock") == 1 and "只做完一部分" in out, out[:120])
seen.clear()
with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
    rout = asyncio.run(at.run_turn("sched-y", "報告", "deepseek/deepseek-v4-pro", at.ReportSink("sched-y")))
check("the wall clock is desktop-only: a cloud/report sink turn runs to its own end (the bridge/runner owns its timeout)",
      "never reached" in rout, rout[:120])
at._TURN_WALL_CLOCK_SEC = 2100
check("wall clock value: 35 minutes, the web bridge's level", at._TURN_WALL_CLOCK_SEC == 2100)

print("OK check_scheduled_budget" if not fails else f"FAILED: {len(fails)}")
sys.exit(1 if fails else 0)
