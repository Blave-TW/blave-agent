"""The reply language is a system-level rule, not only the pin at the end of the prompt.

What it protects (Wei, 2026-09-26: desktop, Chinese question, browser read English news —
the reply's first sentence and list labels came back in English):
  1. Claude path: the system prompt file carries "Reply language" naming the user's
     language, says foreign tool output / web pages don't change it, and that foreign
     titles are translated with the original allowed after them (news title / title_orig).
  2. Codex path: the same rule rides in front of the prompt.
  3. Resolution matches the per-message pin: a Chinese question → Chinese; an English
     one → English; a reply-language setting wins over the message.
  4. The per-message pin at the very end of the prompt is still there.

claude_agent_sdk is stubbed. Run: cd blave-agent && python3 tests/check_reply_lang_rule.py
"""
import asyncio, contextlib, io, os, sys, tempfile, types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))
_tmp = tempfile.mkdtemp(prefix="check-reply-lang-")
os.makedirs(os.path.join(_tmp, "ws"))
os.environ.update({
    "BLAVE_AGENT_WORKSPACE": os.path.join(_tmp, "ws"),
    "BLAVE_AGENT_STATE": os.path.join(_tmp, "state"),
    "BLAVE_AGENT_DB": os.path.join(_tmp, "session.db"),
})
os.environ.pop("BLAVE_PROXY_TOKEN", None)
os.environ.pop("BLAVE_TURN_INTERRUPT_FILE", None)
with open(os.path.join(_tmp, "ws", "AGENTS.md"), "w") as f:
    f.write("# AGENTS\n")

sdk = types.ModuleType("claude_agent_sdk")


class _Obj:
    def __init__(self, **kw):
        self.__dict__.update(kw)


for _name in ("AssistantMessage", "TextBlock", "ToolUseBlock", "ThinkingBlock", "ResultMessage"):
    setattr(sdk, _name, type(_name, (_Obj,), {}))
import dataclasses  # noqa: E402


@dataclasses.dataclass
class _Options:  # the real one is a dataclass; _lang_hooks checks for a `hooks` field
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
    path = (getattr(options, "extra_args", None) or {}).get("append-system-prompt-file")
    seen["system"] = open(path, encoding="utf-8").read() if path else ""
    seen["prompt"] = prompt
    seen["hooks"] = getattr(options, "hooks", None)
    yield sdk.AssistantMessage(content=[sdk.TextBlock(text="好")])


sdk.query = fake_query
sys.modules["claude_agent_sdk"] = sdk
import agent_turn as at  # noqa: E402
import codex_engine  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f"  {detail!r}"[:400]))
    if not ok:
        fails.append(name)


def turn(message, **kw):
    seen.clear()
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        asyncio.run(at.run_turn("s1", message, "sonnet", at.LocalSink("s1"), **kw))
    return seen


ZH = "用瀏覽器幫我查今天比特幣的兩則新聞，列出來源就好"
s = turn(ZH)
rule = s["system"][s["system"].find("## Reply language"):]
check("Claude: the system prompt has the reply-language rule", "## Reply language (runtime rule)" in s["system"], s["system"][-600:])
check("…naming Chinese for a Chinese question", "Write everything the user sees in Chinese" in rule, rule)
check("…covering the notes between tool calls (they show in the thought-process strip)", "the short notes you write between tool calls" in rule, rule)
check("…saying foreign pages / tool output don't change it", "Web pages, search results, files and tool output in another language never change this" in rule, rule)
check("…and translating foreign titles, original allowed (title / title_orig)", "title_orig" in rule and "original after it" in rule, rule)
check("Chinese reply: full-width punctuation rule", "full-width punctuation" in rule and "，。：；" in rule, rule)
hooks = (s.get("hooks") or {}).get("PostToolUse") or []
check("desktop: a PostToolUse hook re-states the language after every tool result", len(hooks) == 1 and hooks[0]["matcher"] is None, s.get("hooks"))
if hooks:
    out = asyncio.run(hooks[0]["hooks"][0]({}, "t1", None))
    ctx = out["hookSpecificOutput"]
    check("…as additionalContext naming Chinese, the notes before the next tool, and full-width punctuation",
          ctx["hookEventName"] == "PostToolUse" and "in Chinese" in ctx["additionalContext"]
          and "before your next tool call" in ctx["additionalContext"] and "full-width" in ctx["additionalContext"], ctx)
check("the per-message pin is still the last line of the prompt", s["prompt"].rstrip().endswith("[用中文回覆這則訊息,<suggest> 建議句也用中文]"), s["prompt"][-80:])
pre = (s.get("hooks") or {}).get("PreToolUse") or []
check("desktop: a PreToolUse hook on Bash refuses the OS scheduler (tests/check_desktop_sched_guard.py has the cases)",
      len(pre) == 1 and pre[0]["matcher"] == "Bash"
      and asyncio.run(pre[0]["hooks"][0]({"tool_input": {"command": "crontab -l"}}, "t1", None))["hookSpecificOutput"]["permissionDecision"] == "deny", s.get("hooks"))

s = turn("find me two bitcoin news items today and list the sources")
check("English question → the rule names English", "Write everything the user sees in English" in s["system"], s["system"][-600:])
check("English reply: no full-width rule", "full-width" not in s["system"][s["system"].find("## Reply language"):])

# e2e 0.1.8 #65:中文對話裡回一句「YES」,錨、系統規則、工具後的提醒三處都點名 English,整則回覆變英文
for sid, first, short, want in (("s-yes-zh", ZH, "YES", "Chinese"), ("s-ok-zh", ZH, "ok", "Chinese"),
                                ("s-sym-zh", ZH, "BTCUSDT", "Chinese"),
                                ("s-yes-en", "find me two bitcoin news items today", "YES", "English")):
    for m in (first, short):
        seen.clear()
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            asyncio.run(at.run_turn(sid, m, "sonnet", at.LocalSink(sid)))
    ctx = asyncio.run(seen["hooks"]["PostToolUse"][0]["hooks"][0]({}, "t1", None))["hookSpecificOutput"]["additionalContext"]
    pin = seen["prompt"].rstrip().splitlines()[-1]
    check(f"「{short}」 after a {want} message keeps {want}: system rule, tool reminder and the pin",
          f"Write everything the user sees in {want}" in seen["system"] and f"is in {want}" in ctx
          and (("用中文回覆" in pin) if want == "Chinese" else ("ENTIRELY in English" in pin)), (pin, ctx))
check("a short reply with no earlier message is judged on its own, as before",
      at._lang_basis("YES", []) == "YES" and at._lang_basis("YES", [("assistant", "好的,已建好")]) == "YES")
check("a real sentence is never overridden by history (English question in a Chinese conversation → English)",
      at._lang_basis("what is the funding rate now", [("user", ZH)]) == "what is the funding rate now"
      and at._lang_basis("這支策略怎麼樣", [("user", "hello there, what is this")]) == "這支策略怎麼樣")
check("a short message in another script is evidence by itself (はい / 네 / sí stay with the message)",
      all(at._lang_basis(m, [("user", "find me two bitcoin news items today")]) == m for m in ("はい", "네", "sí", "好")))
check("the basis is the latest earlier USER message that shows a language",
      at._lang_basis("ok", [("user", "show me the chart of it"), ("assistant", "Done."), ("user", ZH), ("assistant", "好"), ("user", "YES")]) == ZH)

check("a reply-language setting wins over the message (English text, zh setting → 繁體中文)",
      "Traditional Chinese (繁體中文)" in at.reply_lang_rule("list the sources", "zh"))

captured = {}


async def fake_run(codex_bin, prompt, cwd, env, sink, on_tool_start=None, on_tool_done=None,
                   model=None, effort=None, mcp_url=None, browser_url=None, web_search_off=False):
    captured["prompt"] = prompt
    tr = codex_engine.CodexTranslator(sink, on_tool_start, on_tool_done)
    tr.feed({"type": "item.completed", "item": {"id": "a", "type": "agent_message", "text": "好"}})
    tr.feed({"type": "turn.completed", "usage": {}})
    return tr


s_web = {}
class _Web(at.WebSink):
    def _send(self, chunk):
        pass
seen.clear()
with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
    asyncio.run(at.run_turn("s9", ZH, "sonnet", _Web("http://x/report", "t", "s9")))
check("fleet (web) turns do not get the hook yet (not verified on a machine)", not seen.get("hooks"), seen.get("hooks"))
codex_engine.run = fake_run
turn(ZH, engine="codex", codex_bin="/x/codex")
check("Codex: the same rule rides in front of the prompt, before the conversation",
      "## Reply language (runtime rule)" in captured.get("prompt", "")
      and captured["prompt"].find("## Reply language") < captured["prompt"].find(ZH), captured.get("prompt", "")[:300])

print("\n" + ("ALL PASS" if not fails else f"{len(fails)} FAILED: {fails}"))
sys.exit(1 if fails else 0)
