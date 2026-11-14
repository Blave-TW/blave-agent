"""回覆只能寫在最後一個工具呼叫之後(runtime 1.1.163)。

事故:上網找策略,三個點子只在思考裡、旁白後接四個 browser_close,最後回覆只剩「上面已列出」。
工具呼叫前的字兩個 sink 都收掉(WebSink 收去活動列、TelegramSink 刪訊息),歷史也只存最後那段。
這裡釘:(1) 規則在三份格式規則裡、Claude 與 Codex 兩條引擎的 prompt 都帶到;
(2) Telegram 段不再說「工具呼叫前後會分開送」;(3) 短回覆指向「上面」的兜底 log 觸發與不觸發。

Run: cd blave-agent && .venv/bin/python tests/check_reply_after_tools.py
"""
import contextlib, io, os, re, shutil, sys, tempfile, types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))
WS = tempfile.mkdtemp(prefix="check-reply-after-tools-")
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.setdefault("BLAVE_AGENT_DB", os.path.join(WS, "session.db"))
sys.modules["claude_agent_sdk"] = types.ModuleType("claude_agent_sdk")
import agent_turn as at  # noqa: E402

fails = []


def t(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        fails.append(name)


RULE = "Only the text after your last tool call stays in the chat"

# ── 1. 規則掛在哪 ─────────────────────────────────────────────────────────────
t("規則在 _NO_NARRATION", RULE in at._NO_NARRATION and "上面已列出" in at._NO_NARRATION
  and "listed above" in at._NO_NARRATION)
for name in ("WEB_FORMATTING_RULE", "LOCAL_FORMATTING_RULE", "TELEGRAM_FORMATTING_RULE"):
    t(f"{name} 帶這條", RULE in getattr(at, name))
t("Telegram 段不再說工具呼叫前後會分開送(TelegramSink.on_tool 其實會刪掉前段)",
  "分開送" not in at.TELEGRAM_FORMATTING_RULE)

sinks = {"web": at.WebSink("u", "tok", "s1"), "local": at.LocalSink("s1"),
         "telegram": at.TelegramSink("tok", "1")}
for label, sink in sinks.items():
    t(f"Codex 引擎的 prompt 帶這條({label})", RULE in at._codex_prompt("hi", sink, False))
    t(f"Claude 引擎的 system prompt 吃的格式規則帶這條({label})", RULE in at._formatting_rule_for(sink))
src = open(os.path.join(ROOT, "runtime", "agent_turn.py"), encoding="utf-8").read()
t("Claude 引擎的 system prompt 確實接 _formatting_rule_for(sink)",
  re.search(r"_write_system_prompt_file\(.*?\+ _formatting_rule_for\(sink\)\n    \)", src, re.S) is not None)

# ── 2. 兜底 log 的判定 ────────────────────────────────────────────────────────
hit = at.dangling_reference
t("事故那句:有工具、短、上面已列出 → 命中", hit("我找到三個可回測的點子，上面已列出，挑一個我幫你回測。", True))
t("英文 listed above → 命中", hit("I found three testable ideas, listed above.", True))
t("如上 → 命中", hit("結果如上。", True))
t("沒工具呼叫 → 不命中", hit("我找到三個點子，上面已列出。", False) is None)
t("長回覆 → 不命中", hit("上面已列出的三個點子：" + "動能突破、均值回歸、資金費率反轉。" * 20, True) is None)
for s in ("BTC 收在 20 日均線 above 之上,趨勢偏多。", "Price closes above the 20-day MA.",
          "報酬 20% 以上、回撤 15% 以下。", "價格站上 MA20,上面還有前高壓力。",
          "BTC was above the 20-day MA all week.", "例如上漲 5% 就出場。", "比如上週的資金費率。"):
    t(f"一般量化句不命中:{s}", hit(s, True) is None)
t("只有標記、剝完是空的 → 不命中", hit("<await/>", True) is None)

# ── 3. sink 收尾真的會記(log 只帶長度與字樣,不帶內容) ─────────────────────
def finalize_err(sink, steps):
    err = io.StringIO()
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(err):
        for kind, arg in steps:
            getattr(sink, kind)(arg)
        sink.finalize()
    return err.getvalue()


tool = types.SimpleNamespace(id="t1", name="browser_close", input={})
log = finalize_err(at.LocalSink("s1"), [("on_text", "點子一、二、三"), ("on_tool", tool),
                                        ("on_text", "我找到三個點子，上面已列出。")])
t("LocalSink:工具後只剩「上面已列出」→ 記一行", "dangling_reference" in log and "點子一" not in log)
log = finalize_err(at.LocalSink("s1"), [("on_text", "我找到三個點子，上面已列出。")])
t("LocalSink:沒工具呼叫 → 不記", "dangling_reference" not in log)
log = finalize_err(at.LocalSink("s1"), [("on_tool", tool), ("on_text", "三個點子:動能突破、均值回歸、資金費率反轉。")])
t("LocalSink:工具後寫完整清單 → 不記", "dangling_reference" not in log)


class _FakeStreamer:
    def __init__(self, *a):
        pass

    def update(self, text):
        pass

    def finish(self, text):
        pass

    def discard(self):
        pass


at.TelegramStreamer = _FakeStreamer
log = finalize_err(at.TelegramSink("tok", "1"), [("on_tool", tool), ("on_text", "結果如上。")])
t("TelegramSink:工具後只剩「如上」→ 記一行", "dangling_reference" in log)
log = finalize_err(at.TelegramSink("tok", "1"), [("on_text", "結果如上。")])
t("TelegramSink:沒工具呼叫 → 不記", "dangling_reference" not in log)

shutil.rmtree(WS, ignore_errors=True)
print(f"\n{'FAIL' if fails else 'OK'}: {len(fails)} failed")
sys.exit(1 if fails else 0)
