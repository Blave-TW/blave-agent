"""網頁與電腦版回覆格式的語法規則:預設句子、不用粗體當小標(Wei:這條原本鼓勵粗體行分段加清單,整站 AI 味變重)。

LOCAL 是 WEB 用 replace 衍生的,兩份都要驗。Telegram 吃自己那段語法,不跟著改。
"""
import os, shutil, sys, tempfile, types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))
WS = tempfile.mkdtemp(prefix="check-reply-format-ws-")
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.setdefault("BLAVE_AGENT_DB", os.path.join(WS, "session.db"))
sys.modules["claude_agent_sdk"] = types.ModuleType("claude_agent_sdk")
import agent_turn as at  # noqa: E402

fails = []


def t(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        fails.append(name)


NEW = (
    "- 不要用 # 標題（聊天泡泡裡太重）。預設寫成句子和短段落，要分段就空一行。"
    "不要用粗體當小標，也不要寫「**主題**：內容」或「- **主題**：內容」這種形式。"
    "三件以上同類的事才用清單，清單項目開頭不加粗。不要用破折號（——）。"
    "可用 `行內程式碼`，表格僅限小型。這條只管聊天回覆，報告內文照 references/reports.md。\n"
)
TELEGRAM_OWN = (
    "\n\n---\n\n"
    "## Telegram 輸出格式（本 runtime 專屬規則）\n"
    "回覆會用 Telegram 的 legacy Markdown 解析送出，語法跟一般 Markdown不同：\n"
    "- 粗體用單星號 *文字*（不是 **文字**）\n"
    "- 斜體用底線 _文字_\n"
    "- 代碼用反引號 `文字`\n"
    "- 不支援標題（#）、不支援表格（|）—表格一律改成清單（- 開頭）或分行條列\n"
    "段落之間適時空行，不要擠成一大塊。\n\n"
    "**每個文字段落之間會各自變成一則獨立 Telegram 訊息**（工具呼叫前後會分開送）。\n\n"
)

for name in ("WEB_FORMATTING_RULE", "LOCAL_FORMATTING_RULE"):
    rule = getattr(at, name)
    t(f"{name} 帶新句", NEW in rule)
    t(f"{name} 不再叫模型用粗體行分段", "粗體行" not in rule and "可用 **粗體**" not in rule)

t("LOCAL 的導航段真的換掉了(replace 沒失效)",
  at._NAV_RULE not in at.LOCAL_FORMATTING_RULE and at._NAV_RULE_LOCAL in at.LOCAL_FORMATTING_RULE)
t("LOCAL 與 WEB 只差導航段",
  at.LOCAL_FORMATTING_RULE == at.WEB_FORMATTING_RULE.replace(at._NAV_RULE, at._NAV_RULE_LOCAL))
t("Telegram 語法段一字不變,也沒有新句",
  at.TELEGRAM_FORMATTING_RULE == TELEGRAM_OWN + at._STYLE_RULES + at._NO_NARRATION)
t("策略名稱與交易所名稱那兩條在共用風格段,三份格式規則都帶到",
  "都沒有才用代號" in at._STYLE_RULES and "不寫 id" in at._STYLE_RULES
  and all(at._STYLE_RULES in r for r in (at.WEB_FORMATTING_RULE, at.LOCAL_FORMATTING_RULE, at.TELEGRAM_FORMATTING_RULE)))

shutil.rmtree(WS, ignore_errors=True)
print(f"\n{'FAIL' if fails else 'OK'}: {len(fails)} failed")
sys.exit(1 if fails else 0)
