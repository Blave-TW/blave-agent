"""A reply whose last message is only markers is no reply (e2e029 找點子第一次追問, 10-23).

The agent put the whole answer in text next to a tool call (narration → the activity line) and
ended with a message holding nothing but a marker (`<await/>`, a `<suggest>` block, or a
scaffold-prefixed echo). finalize stripped that to "", and the narration floor never fired because
it looked at `not self.full_text` — the marker was still in it. The desktop got `text_replace ""`,
the bubble stayed empty and session.db stored "" for the turn.
Red on the old code: the narration floor and has_reply() both judged the raw text.
Run: cd blave-agent && .venv/bin/python tests/check_marker_only_reply.py
"""
import asyncio, contextlib, dataclasses, io, json, os, sqlite3, sys, tempfile, types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))
WS = tempfile.mkdtemp(prefix="check-marker-only-")
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ["BLAVE_AGENT_DB"] = os.path.join(WS, "session.db")
os.environ["BLAVE_AGENT_STATE"] = os.path.join(WS, "state")
os.environ["BLAVE_AGENT_HOME"] = WS
os.environ["BLAVE_AGENT_MODEL_PREFS"] = os.path.join(WS, "state", "model_prefs.json")
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
sys.modules["claude_agent_sdk"] = sdk
import agent_turn as at  # noqa: E402

fails = []


def ok(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  → {detail!r}"[:400]))
    if not cond:
        fails.append(name)


NARR = "ETH 布林帶突破趨勢的完整規則:收在上軌之外做多、下軌之外做空,回到中軌出場。"
TOOL = types.SimpleNamespace(id="t1", name="mcp__blave_browser__browser_open", input={"url": "https://example.com"})
MARKERS = ("<await", "<suggest", "</suggest", "[用中文回覆")


def drive_local(final, narration=NARR):
    s = at.LocalSink("desktop-x")
    out = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
        if narration:
            s.on_text(narration)
        s.on_tool(TOOL)
        s.on_text(final)
        before = s.has_reply()
        reply = s.finalize()
    chunks = [json.loads(l[9:]) for l in out.getvalue().splitlines() if l.startswith("@@BLAVE@@")]
    return before, reply, chunks


# ── 1. sink 層:最後一則只有標記 → 旁白補位,標記照剝、建議／等回覆照送 ──
for label, final, want_sug, want_await in [
    ("只有 <await/>", "<await/>", None, True),
    ("只有 <suggest> 區塊", "<suggest>\n掃一下參數\n</suggest>", ["掃一下參數"], False),
    ("前後空行＋<suggest>", "\n\n<suggest>\n看回測\n</suggest>\n", ["看回測"], False),
    ("開頭就是 prompt 骨架(假對話截斷)", "[用中文回覆這則訊息]\nuser: 好", None, False),
]:
    before, reply, chunks = drive_local(final)
    rep = [c for c in chunks if c["type"] == "text_replace"]
    done = [c for c in chunks if c["type"] == "done"]
    sug = [c for c in chunks if c["type"] == "suggestions"]
    ok(f"{label}:has_reply() 不把標記當回覆", before is False, before)
    ok(f"{label}:finalize 回傳(進 session.db)= 旁白,不是空字串", reply == NARR, reply)
    ok(f"{label}:text_replace 換成旁白、沒有標記", rep and rep[-1]["text"] == NARR
       and not any(m in rep[-1]["text"] for m in MARKERS), rep)
    ok(f"{label}:建議照送", [c["items"] for c in sug] == ([want_sug] if want_sug else []), sug)
    ok(f"{label}:done.awaiting 照標記", done and done[-1]["awaiting"] is want_await, done)

# ── 2. 沒被影響的路 ──
before, reply, chunks = drive_local("回測跑完了。\n<suggest>\n掃一下參數\n</suggest>")
ok("正常回覆+建議:回覆是正文,不換成旁白", before is True and reply == "回測跑完了。", (before, reply))
before, reply, _ = drive_local("<await/>", narration=None)
ok("只有標記、也沒有旁白:has_reply() False(交給 run_turn 的空回合續跑/錯誤句)", before is False, before)
s = at.LocalSink("desktop-y")
with contextlib.redirect_stdout(io.StringIO()):
    s.on_text('<export target="pine" path="strategies/a/exports/pine.pine" />')
ok("只有合法 <export/>:算回了話(轉出卡就是交付物,不觸發續跑重轉)", s.has_reply() is True)


# ── 3. Telegram:同一個判準 ──
class FakeStreamer:
    def __init__(self, *a):
        self.done = []

    def update(self, text):
        pass

    def finish(self, text):
        self.done.append(text)


at.TelegramStreamer = FakeStreamer
tg = at.TelegramSink("tok", "chat")
tg.on_status(NARR + "<await/>")
tg.chunk_text = "<await/>"
ok("TG:只有標記 has_reply() False", tg.has_reply() is False)
r = tg.finalize()
ok("TG:旁白補位、補位那句也剝乾淨", r == NARR, r)

# ── 4. 整輪(stub SDK,e2e029 那一輪的形狀):旁白+工具 → 只有 <await/> ──
calls = []


def shaped(narration):
    async def q(prompt, options):
        calls.append(prompt)
        first = [sdk.TextBlock(text=narration)] if narration else []
        yield sdk.AssistantMessage(content=first + [sdk.ToolUseBlock(id=f"t{len(calls)}", name="Bash",
                                                                      input={"command": "echo"})])
        yield sdk.AssistantMessage(content=[sdk.TextBlock(text="<await/>")])
    return q


def run(sid, narration):
    calls.clear()
    sdk.query = shaped(narration)
    out = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
        reply = asyncio.run(at.run_turn(sid, "第一個的完整進出場規則", "sonnet", at.LocalSink(sid)))
    chunks = [json.loads(l[9:]) for l in out.getvalue().splitlines() if l.startswith("@@BLAVE@@")]
    db = sqlite3.connect(os.environ["BLAVE_AGENT_DB"])
    stored = db.execute("SELECT content FROM turns WHERE session_id=? AND role='assistant'", (sid,)).fetchall()
    db.close()
    return reply, chunks, stored


reply, chunks, stored = run("desktop-e2e029", NARR)
ok("整輪:回覆是旁白", reply == NARR, reply)
ok("整輪:session.db 存的不是空字串", stored == [(NARR,)], stored)
ok("整輪:空回合判定照既有設計續跑一次(標記-only 跟沒有文字同一條路)", len(calls) == 2, len(calls))
reply, chunks, stored = run("desktop-nonarr", None)
errs = [c for c in chunks if c["type"] == "error"]
ok("整輪、沒有旁白:走錯誤句(不是無聲的空 done)", errs and reply and "<await" not in reply, (reply, errs))

print()
print("ALL PASS" if not fails else f"{len(fails)} FAILED: {fails}")
sys.exit(1 if fails else 0)
