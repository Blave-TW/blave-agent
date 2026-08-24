"""
Agent loop, spec item 1: one process per turn ("每輪 spawn"), no persistent
agent process.

Delivery is pluggable: the same SDK loop drives either a Telegram sink
(edit-one-bubble, legacy Markdown) or a Web sink (discrete chunks POSTed to
the web-chat transport /report endpoint). Add a new surface = add a sink.

Usage:
  python3 agent_turn.py <session_id> <message> --delivery=telegram \\
      --telegram-token=... --telegram-chat-id=...
  python3 agent_turn.py <session_id> <message> --delivery=web \\
      --report-url=... --report-token=...
Prints the assistant's reply text to stdout; everything else goes to stderr.
"""
import argparse
import asyncio
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

import claude_agent_sdk as sdk
import model_prefs
import session_store as ss
import strategy_reporter

_THIS_DIR = os.path.dirname(os.path.abspath(__file__))

WORKSPACE = os.environ.get("BLAVE_AGENT_WORKSPACE", "/opt/blave-agent/workspace")

# lib/notify.py (config-layer code, unmodified) resolves pairing state from
# $BLAVECLAW_HOME/credentials/telegram-default-allowFrom.json — an openclaw
# convention. Our own pairing lives in config/telegram.json instead, so this
# runtime must keep a compat shim in sync at that path (see sync step below)
# and point BLAVECLAW_HOME there for every agent turn / Bash tool call.
BLAVECLAW_HOME = os.environ.get("BLAVECLAW_HOME", "/opt/blave-agent")

# Every model routes through the real Blave proxy (api/openclaw/proxy.py)
# instead of holding raw upstream provider keys on this machine. The proxy
# picks Anthropic vs DeepSeek based on "deepseek" appearing in the model id,
# strips the provider/ prefix itself, and does real usage logging + credit
# deduction — this is the actual billing integration, not a POC shortcut.
# Auth is a single per-machine token (BLAVE_PROXY_TOKEN, matches this
# instance's openclaw_instances.ttyd_password), sent as "proxy-{token}".
PROXY_BASE_URL = "https://api.blave.org/openclaw/proxy"
PROXY_ENV = {
    "ANTHROPIC_BASE_URL": PROXY_BASE_URL,
    "ANTHROPIC_API_KEY": f"proxy-{os.environ.get('BLAVE_PROXY_TOKEN', '')}",
}

# Restrict to what a headless trading agent actually needs — the SDK's full
# default toolset burned 22k+ tokens on a single trivial turn in testing.
ALLOWED_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep"]


# 模型(尤其較弱的 instruction-following)看到 prompt 裡的逐字稿格式,會在寫完
# 回覆後「順著格式續寫下一個 user 回合」——實測 deepseek-v4-pro 捏造了一整則
# 使用者訊息(「幫我把參數更新到 scan 找到的最佳解」)。那段若存進歷史,下一輪
# agent 可能真的去執行使用者從沒下過的指令(對交易 agent 是實質風險)。
# SDK 沒有 stop_sequences,所以在輸出端硬攔:一出現我們自己產生的標記就截斷。
# 這些字串全是本檔產生的,正常回覆不會出現。pattern 本身放 session_store
# (單一來源——它存 summary 前也要用同一組標記做清洗)。
_SCAFFOLD_RE = ss.SCAFFOLD_RE


def strip_hallucinated_turn(text):
    """截掉模型續寫出來的假對話回合。回傳 (清理後文字, 是否有截斷)。"""
    if not text:
        return text, False
    m = _SCAFFOLD_RE.search(text)
    if not m:
        return text, False
    return text[: m.start()].rstrip(), True


# ── 建議下一步(suggested next actions)────────────────────────────────────
# 模型依 WEB_FORMATTING_RULE 在回覆末尾輸出 <suggest> 區塊(一行一句);
# WebSink.finalize 把它剝離成 {"type": "suggestions", "items": [...]} chunk,
# 前端渲染成輸入框上緣的可點建議列(點了=替用戶送出那句話)。
# TG 面沒有這條規則,但 TelegramSink 仍防禦性剝除,raw 標記絕不給用戶看到。
_SUGGEST_BLOCK_RE = re.compile(r"[ \t]*<suggest>(.*?)</suggest>[ \t]*", re.S)
# 回覆被截斷(interrupt/max_turns)時可能只剩未閉合的開頭——也要剝乾淨。
_SUGGEST_OPEN_TAIL_RE = re.compile(r"[ \t]*<suggest>(?:(?!</suggest>).)*$", re.S)
_SUGGEST_MAX_ITEMS = 3
_SUGGEST_MAX_CHARS = 80


def extract_suggestions(text):
    """回傳 (清理後文字, 建議清單)。剝掉所有 <suggest> 區塊(含未閉合尾段),
    items 取最後一個完整區塊;格式不符的行直接丟——fail-silent,絕不影響正文。"""
    if not text or "<suggest>" not in text:
        return text, []
    items = []
    blocks = _SUGGEST_BLOCK_RE.findall(text)
    if blocks:
        for line in blocks[-1].strip().splitlines():
            line = line.strip().lstrip("-•*").strip()
            if line and len(line) <= _SUGGEST_MAX_CHARS:
                items.append(line)
            if len(items) >= _SUGGEST_MAX_ITEMS:
                break
    cleaned = _SUGGEST_BLOCK_RE.sub("", text)
    cleaned = _SUGGEST_OPEN_TAIL_RE.sub("", cleaned)
    return cleaned.rstrip(), items


def _deploy_state_line():
    """部署現況的一行機器事實(建議規則配套,web 專屬)。2026-08-24 實測:
    supertrend_sol 已在模擬盤跑兩天,agent 仍建議「上模擬盤」——prompt 要求
    模型自查 deployments.json 靠不住,deterministic 餵進來才穩(phase 2 狀態機
    的第一塊)。fail-silent:讀不到就回空字串,絕不影響回合。"""
    try:
        deployed = []
        try:
            with open(os.path.join(WORKSPACE, "state", "deployments.json"),
                      encoding="utf-8") as f:
                reg = json.load(f)
            if isinstance(reg, dict):
                deployed = [k for k in reg if k != "reconciler"][:15]
        except (OSError, ValueError):
            pass
        names = []
        sdir = os.path.join(WORKSPACE, "strategies")
        if os.path.isdir(sdir):
            for e in sorted(os.listdir(sdir)):
                if e.startswith((".", "TEMPLATE")) or e == "__pycache__":
                    continue
                full = os.path.join(sdir, e)
                if os.path.isdir(full) and os.path.isfile(os.path.join(full, "strategy.py")):
                    names.append(e)
                elif os.path.isfile(full) and e.endswith(".py"):
                    names.append(e[:-3])
        undeployed = [n for n in names if n not in deployed][:15]
        paper = os.path.isfile(os.path.join(WORKSPACE, "state", "paper_ledger.json"))
        parts = ["已部署運行中:" + ("、".join(deployed) if deployed else "無")]
        if undeployed:
            parts.append("未部署:" + "、".join(undeployed))
        parts.append("模擬盤帳戶:" + ("已綁定" if paper else "未綁定"))
        return ("[部署現況(機器事實,提議前先對照——已在跑的策略不要再建議部署/上模擬盤):"
                + ";".join(parts) + "]")
    except Exception:
        return ""


def _lang_directive(message):
    """Deterministic per-turn language pin. Han-character ratio decides what the
    user wrote in; the directive names ONE target language explicitly — a generic
    bilingual "follow the user" line loses to a Chinese-heavy context."""
    han = sum(1 for ch in message if "一" <= ch <= "鿿")
    letters = sum(1 for ch in message if ch.isascii() and ch.isalpha())
    # 漢字要「壓過」英文字母才算中文訊息——「what is 台積電 price」是英文句帶
    # 個股名,不是中文句
    if han >= 3 and han > letters * 0.5:
        return "[用中文回覆這則訊息]"
    if letters >= 2:
        return (
            "[The user wrote in English — reply ENTIRELY in English. "
            "No Chinese anywhere in this reply, including headers and closing remarks.]"
        )
    return "[Reply in the language of the user message above]"


def build_prompt(summary, recent, message, viewing_strategy=None, viewing_tab=None,
                 suggest_directive=False):
    parts = []
    if summary:
        parts.append(f"[過去對話摘要]\n{summary}\n")
    if recent:
        # 「user: / assistant:」這種逐字稿排版會誘使模型續寫下一輪(見
        # strip_hallucinated_turn)。改用不像對話腳本的標籤 + 明講界線。
        parts.append("[近期對話紀錄(僅供參考,不要複述也不要續寫)]")
        for role, content in recent:
            who = "使用者" if role == "user" else "你"
            parts.append(f"<{who}> {content}")
        parts.append("[紀錄結束]")
        parts.append("")
    # Ephemeral UI context (web workspace only) — the strategy the user is
    # looking at right now. Placed next to their message so "這支/this one"
    # resolves. NOT persisted to session (it's the state at send time, not part
    # of the conversation). The code itself isn't passed — the agent reads the
    # file from strategies/ if it needs it.
    # Deliberately weak: this is ambient UI state, and the open tab is often
    # stale (user browses another strategy while chatting about a new one).
    # It only binds on explicit deixis — an unnamed command in an ongoing
    # conversation must follow the conversation, not the tab (2026-07-28: a
    # bare「掃描參數」right after building BTC momentum got applied to the
    # twstock strategy whose tab happened to be open).
    if viewing_strategy:
        # which tab is open decides what "這個 / 這裡 / 這結果" points at.
        if viewing_tab == "data":
            focus = "的回測數據(績效指標與權益曲線)"
        elif viewing_tab == "code":
            focus = "的程式碼"
        else:
            focus = ""
        parts.append(
            f"[工作頁狀態(僅供釐清指代,不是工作指令):使用者畫面上開著策略"
            f"「{viewing_strategy}」{focus}。訊息裡有「這支 / 這個策略 / 這裡 / 這結果」"
            f"這類指示詞時,指的通常是它。訊息沒指名策略、而對話正在處理另一支時,"
            f"以對話脈絡為準,不要因為分頁開著就對它動手;兩邊衝突拿不準,"
            f"先用一句話確認要動哪一支再動。需要看內容就自己讀 strategies/ 底下對應的檔"
            f"(程式碼在 strategy.py、回測結果在 stats.json / pnl.png)。]"
        )
    parts.append("[使用者這次的訊息]")
    parts.append(message)
    # 語言錨放最尾端(recency 權重最大)且由 code 偵測、給「針對性」指令:
    # 系統規則是中文寫的+歷史多為中文,籠統的「跟著使用者語言」擋不住
    # 英文訊息被回成中文/中英混雜(實測兩輪)。
    parts.append(_lang_directive(message))
    # 紅線逐輪錨——**兩個 sink 都掛**,獨立於 suggest_directive:TG 是主介面之一,
    # 只放 AGENTS.md/系統尾端會輸給 in-context 慣性(deepseek 教訓,同
    # _lang_directive 的機制);建議句規則(下面那段)維持 web 專屬。
    parts.append(
        "[紅線:部署/金額/綁定/恢復交易一律指引用戶到投資組合頁操作,不代做;"
        "急停(HALT)例外可做。]"
    )
    if suggest_directive:
        state_line = _deploy_state_line()
        if state_line:
            parts.append(state_line)
        # 建議規則的逐輪錨(web 專屬)。系統提示尾端的版本擋不住 in-context 慣性:
        # session 歷史累積「市場問答→問句收尾」先例後,deepseek 對探索層連續三輪
        # 不服從(2026-08-24 e2e:ETH/BTC vs ETH/SOL 三輪全數問句收尾、零區塊);
        # _lang_directive 已證明「貼著訊息的逐輪指令」對弱模型有效,同機制照搬。
        parts.append(
            "[結尾規則:要提議下一步(再拉圖、補籌碼面、跑回測、上模擬盤等)就放進"
            " <suggest> 區塊(一行一句、用戶口吻、最多 3),不要在正文用問句提議;"
            "提到策略用它的名稱、不用底線代號。"
            "命中里程碑(剛完成回測等)必附區塊;純寒暄或單一報價則什麼都不附。]"
        )
    return "\n".join(parts)


# references/models.md (shared blaveclaw-config content, not ours to edit)
# points at get-api-key.py, which only exists on real openclaw machines — on
# this runtime it doesn't exist, so the model has no way to answer "which
# models do you support" correctly without this note. The proxy token it
# needs is already sitting in its own ANTHROPIC_API_KEY env var (that's what
# authenticates every model call this runtime makes), so no new credential
# exposure — just telling it where to look instead of guessing or asking the
# user for a key that already exists in its own environment.
def model_catalog_rule(session_id):
    """Per-turn (not module-level) because the switch command embeds this
    turn's own session_id — set_model.py needs it to know whose preference
    to write."""
    return (
        "\n\n---\n\n"
        "## 查詢 / 切換模型（本 runtime 專屬規則）\n"
        "如果被問到「支援哪些模型 / 計價」，不要找 references/models.md 提到的\n"
        "get-api-key.py（那是舊 openclaw 機器才有的腳本，這裡沒有），也不要用\n"
        "workspace .env 裡的 Blave API key（那組是另一套帳號認證，查不到這個）。\n"
        "改用 Bash 工具直接查真實清單：\n"
        "```\n"
        f'curl -s {PROXY_BASE_URL}/v1/models -H "x-api-key: $ANTHROPIC_API_KEY"\n'
        "```\n"
        "`$ANTHROPIC_API_KEY` 已經在你的環境變數裡（本 runtime 的 proxy token），\n"
        "不需要另外要金鑰，直接呼叫就有正確、即時的清單跟計價。\n\n"
        "如果使用者要求切換模型：先用上面的指令確認完整 model id"
        "（例如 `anthropic/claude-sonnet-5`），然後執行：\n"
        "```\n"
        f"python3 {_THIS_DIR}/set_model.py {session_id} <model_id>\n"
        "```\n"
        "**這個切換從下一則訊息才會生效**（每輪都是全新 process，這一輪已經在用"
        "原本的模型跑了，改不了這輪）——回覆使用者時要講清楚這點，不要說「已經切換」。"
    )


# ── 用戶常駐偏好 ──────────────────────────────────────────────────────────
# 對話裡表達的常駐偏好(「以後每個策略都要停損」)存 workspace/state/
# preferences.md,每輪整份注入(跟 AGENTS.md 同路徑)。滾動摘要的 schema 沒有
# 「用戶偏好」這個段落,偏好掉出近期對話視窗就會被 compaction 洗掉——這個檔
# 就是為了補這個洞。量的控制在寫入端(下面的規則要求 agent 保持 ≤10 條、寫入
# 時修剪);這裡只設兩道保險,而且都要出聲——無聲截斷會讓後面的偏好靜默失效,
# 對交易 agent 是實質風險:
#   - 超過 SOFT cap:全文照注,但附一行指令要 agent 本輪先整理再繼續。
#   - 超過 HARD cap(失控寫爆):截斷保護 context,並在注入文字裡明講已截斷。
PREFERENCES_PATH = os.path.join(WORKSPACE, "state", "preferences.md")
PREFS_SOFT_CAP_CHARS = 4000
PREFS_HARD_CAP_CHARS = 16000

_PREFS_HOWTO = (
    "\n\n---\n\n"
    "## 用戶常駐偏好（本 runtime 專屬規則）\n"
    "使用者表達**常駐**偏好時（「以後都…」「記住…」「每次建策略都…」），"
    f"把它改寫成一條明確、可執行的規則，寫進 `{PREFERENCES_PATH}`"
    "（Markdown 條列，每條一句、一行），並回覆確認你記住了什麼。規則：\n"
    "- 上限 10 條、總量 4000 字以內（精簡措辭）。每次寫入時順手整理：合併重複、"
    "刪除被新偏好取代或已過期的條目。\n"
    "- 只收使用者明確表達的常駐偏好。一次性指示不算；任務進度歸 state/notes/，"
    "不要寫進來。\n"
    "- 偏好是**預設值，不是鐵律**：位階低於本 system prompt 的其他規則"
    "（安全與煞車規則絕不因偏好放寬）。與當下策略邏輯衝突時"
    "（例如組合型策略沒有單筆停損可做），明講衝突並問使用者——不要硬套，"
    "也不要無聲忽略。\n"
    "- 使用者問「你記了哪些偏好」就照檔案內容唸；要求修改或刪除就直接改檔。\n"
)


def preferences_rule():
    """每輪重讀:偏好的寫入規則(常駐,讓 agent 知道要記)+ 目前偏好內容。"""
    try:
        # encoding 明寫:這個檔是 agent 在對話中寫入的 UTF-8 中文,Windows 機
        # 的 locale 預設(cp950)會 UnicodeDecodeError,而那不是 OSError。
        with open(PREFERENCES_PATH, encoding="utf-8") as f:
            # 有界讀取:hard cap 防的就是失控寫爆,先整份 read() 會在 cap 檢查
            # 之前把巨檔吞進記憶體(4GB 機、有 OOM 前科)。多讀 1 字元足以判定
            # 超限,MemoryError 也就不可能發生。
            content = f.read(PREFS_HARD_CAP_CHARS + 1).strip()
    except FileNotFoundError:
        content = ""
    except (OSError, UnicodeDecodeError) as e:
        # 讀壞掉(權限/IO)不能讓整輪死,但也不能裝作沒有偏好——明講讀不到。
        print(f"[agent_turn] WARNING: preferences unreadable: {e}", file=sys.stderr)
        return _PREFS_HOWTO + "\n[偏好檔目前讀取失敗，本輪先不套用，並向使用者說明。]\n"
    over_hard = len(content) > PREFS_HARD_CAP_CHARS
    # 跟 session_store._sanitize_summary 同一道防線:這段內容進的是 system
    # prompt,夾帶鷹架標記的行會偽造假對話區塊(agent 照唸偏好時也會被
    # strip_hallucinated_turn 砍斷回覆)。逐行剝掉,不截斷。
    content = "\n".join(
        line for line in content.splitlines()
        if not ss.SCAFFOLD_RE.match(line) and not line.startswith("<<<")
    ).strip()
    if not content:
        return _PREFS_HOWTO + "\n（目前沒有任何常駐偏好。）\n"
    parts = [_PREFS_HOWTO, "\n[目前的常駐偏好——建策略/下單/回測時都要套用或明講衝突]\n"]
    if over_hard:
        parts.append(content[:PREFS_HARD_CAP_CHARS])
        parts.append(
            "\n\n[警告：偏好檔大小失控，以上內容已被截斷。本輪先把 "
            "preferences.md 整理回 10 條、總量 4000 字以內（向使用者確認要留哪些），"
            "再處理訊息。]\n"
        )
        try:
            size = os.path.getsize(PREFERENCES_PATH)
        except OSError:
            size = -1
        print(
            f"[agent_turn] WARNING: preferences.md over hard cap "
            f"({size} bytes on disk), truncated",
            file=sys.stderr,
        )
    elif len(content) > PREFS_SOFT_CAP_CHARS:
        parts.append(content)
        parts.append(
            "\n\n[注意：偏好檔已超過建議大小。本輪先把 preferences.md 整理回 "
            "10 條、總量 4000 字以內（精簡措辭、合併重複、刪過期；拿不準就問"
            "使用者），再處理訊息。]\n"
        )
    else:
        parts.append(content)
        parts.append("\n")
    return "".join(parts)


# Shared across all surfaces: the model tends to narrate its own process as
# user-facing text ("Let me check...", "Now I will...") — that's internal
# reasoning, not something the user needs to read. Kept out of AGENTS.md
# because it's a property of THIS runtime's chat surfaces, not a universal
# quant rule.
_NO_NARRATION = (
    "不要寫「Let me check...」「Now I will...」這類自言自語的執行過程當作正式內容——"
    "那些是內部推理，不是要給用戶看的話。只留使用者真正需要看到的內容"
    "（結果、發現、決定、簡短的下一步提示），跳過「我正在做什麼」的旁白。"
)

# Telegram uses LEGACY Markdown (single-asterisk bold) and cannot render
# tables at all; each text segment becomes its own message bubble.
# 兩個 sink 共用的回覆風格(語法各自另訂)。長度紀律一定要兩邊都掛——
# 只掛 web 的結果就是 TG 上問一句「台積電多少」回 15 行全套報價(實測)。
_STYLE_RULES = (
    "回覆風格：\n"
    "- 語言跟著使用者**最新一則訊息**的語言走——對方寫英文就整則用英文回,"
    "不要被本規則的中文或對話歷史帶偏。"
    "(IMPORTANT: reply in the language of the user's LATEST message. "
    "If they write in English, answer entirely in English — these rules being "
    "written in Chinese does NOT make Chinese the default.)\n"
    "- 預設精簡、先講結論：日常問答 1–5 行(問價格就報價格,不用附整套盤面)、"
    "一般回覆 3–8 行；使用者要細節或分析再展開。\n"
    "- 程式碼一律寫進檔案,不貼在對話裡;片段以 10 行為上限。\n"
    "- 回測結果只報關鍵數字(報酬、Sharpe、最大回撤、勝率這類挑 3–4 個)。\n"
    "- 不要向使用者敘述內部探索過程或背景任務狀態。\n"
    "- 使用者看不到檔案系統,別對他列目錄或路徑;指涉用「左側策略頁」「回測分頁」。\n"
)

TELEGRAM_FORMATTING_RULE = (
    "\n\n---\n\n"
    "## Telegram 輸出格式（本 runtime 專屬規則）\n"
    "回覆會用 Telegram 的 legacy Markdown 解析送出，語法跟一般 Markdown不同：\n"
    "- 粗體用單星號 *文字*（不是 **文字**）\n"
    "- 斜體用底線 _文字_\n"
    "- 代碼用反引號 `文字`\n"
    "- 不支援標題（#）、不支援表格（|）—表格一律改成清單（- 開頭）或分行條列\n"
    "段落之間適時空行，不要擠成一大塊。\n\n"
    "**每個文字段落之間會各自變成一則獨立 Telegram 訊息**（工具呼叫前後會分開送）。\n\n"
    + _STYLE_RULES
    + _NO_NARRATION
)

# 建議下一步(web 專屬;extract_suggestions 在 finalize 剝離)。放在 system prompt
# append 的最尾端——實測 deepseek-v4-pro 對埋在中段的這條規則不服從(2026-08-24
# 29026 e2e:回測完成沒附區塊、用問句收尾),弱模型對 prompt 尾端的服從度最高;
# 「禁止問句提議收尾」是把模型自己的競爭習慣堵掉,不是風格潔癖。
_SUGGEST_RULE = (
    "\n\n---\n\n"
    "## 建議下一步（每輪回覆前必檢查）\n"
    "寫完回覆後，檢查這一輪是否命中里程碑：\n"
    "- 剛建立/修改策略、還沒回測 → 建議跑回測\n"
    "- 剛完成回測且結果可用 → 建議上模擬盤（paper）\n"
    "- 正在討論某支已有可用回測、還沒部署的策略（問它表現、值不值得用）"
    "→ 也可建議把該策略上模擬盤；但用戶明顯還在迭代改進中就先不提\n"
    "- 模擬盤已穩定跑一段時間且執行無異常 → 建議小額實盤\n"
    "- 用戶想實際跑但還沒綁任何交易所 → 建議先綁模擬盤\n"
    "命中時，回覆**必須以 <suggest> 區塊結尾**（其後不得再有任何文字），格式：\n"
    "<suggest>\n帶我看怎麼把〈策略名〉上模擬盤\n</suggest>\n"
    "一行一個建議、最多 3 個（通常 1 個就好）；句子＝用戶口吻的短指令"
    "（動詞＋對象＋必要參數），點了會替用戶原句送出。"
    "部署類建議（上模擬盤、小額實盤、綁定——含 paper）是**導航句**：固定以"
    "「帶我看怎麼」起手，點了你回操作步驟、不代做（部署由用戶親手在投資組合頁操作）；"
    "分析／回測類維持一般執行句。"
    "提到策略時用它的名稱（strategy.py 檔頭 # Strategy: 那行，或用戶慣稱），"
    "不要用底線目錄代號（寫「把 BTC 4h 均線交叉上模擬盤」，"
    "不寫「把 btc_ma_cross_4h 上模擬盤」）。"
    "**下一步的提議只能放在 <suggest> 區塊——禁止在正文結尾用問句提議"
    "（「要不要我幫你…？」「需要我再…嗎？」這類收尾不要寫，改放 <suggest>）。**\n"
    "沒命中里程碑、但你想在結尾提議下一步（「要不要我再拉 4h？」「需要補籌碼面嗎？」"
    "這類話）——**一律把那個提議改寫成 <suggest> 區塊**（1–2 個、用戶口吻），"
    "正文不留問句；優先挑往策略／回測方向推進的提議。"
    "純寒暄或一句話問答（打招呼、問單一價格）連提議都不用、直接收尾。\n"
    "區塊內禁止：形容詞副詞（最強、輕鬆、高勝率）、收益承諾（開始獲利、躺賺）、"
    "催促（立即、馬上、別錯過）、emoji；策略名與數字必須真實存在。"
    "同一建議被用戶拒絕或忽略後，同一階段不要重提。\n"
)

# Web renders standard Markdown in the browser — tables, headings, and
# double-asterisk bold all work, so no legacy-syntax constraints.
WEB_FORMATTING_RULE = (
    "\n\n---\n\n"
    "## 網頁輸出格式（本 runtime 專屬規則）\n"
    "回覆顯示在工作區的聊天欄（窄欄、旁邊就是程式碼/回測分頁），語法規則：\n"
    "- 不要用 # 標題（聊天泡泡裡太重），要分段就用**粗體行**；"
    "可用 **粗體**、清單、`行內程式碼`；表格僅限小型。\n"
    "- 建立/修改策略後說一句「程式碼在左側策略頁」即可；"
    "回測細節請使用者看回測分頁。\n\n"
    + _STYLE_RULES
    + _NO_NARRATION
    + _SUGGEST_RULE
)


# Prompting alone doesn't reliably stop the model from emitting Markdown
# tables (observed in practice — the instruction was in the system prompt
# and it still happened). Telegram genuinely cannot render tables no matter
# what, so this is enforced in code instead of relying on the model to obey.
def _is_table_row(line):
    s = line.strip()
    return s.startswith("|") and s.endswith("|") and s.count("|") >= 2


def _is_table_separator(line):
    s = line.strip()
    if not (s.startswith("|") and s.endswith("|")):
        return False
    cells = s.strip("|").split("|")
    return bool(cells) and all(re.fullmatch(r"\s*:?-+:?\s*", c) for c in cells)


def _parse_row(line):
    return [c.strip() for c in line.strip().strip("|").split("|")]


def convert_markdown_tables_to_list(text):
    lines = text.split("\n")
    out = []
    i = 0
    while i < len(lines):
        if _is_table_row(lines[i]) and i + 1 < len(lines) and _is_table_separator(lines[i + 1]):
            headers = _parse_row(lines[i])
            i += 2
            while i < len(lines) and _is_table_row(lines[i]):
                cells = _parse_row(lines[i])
                if len(headers) == 2:
                    # "指標 | 數值" style tables read better as "項目: 值"
                    # than repeating the column header on every row.
                    out.append(f"- {cells[0]}: {cells[1]}" if len(cells) >= 2 else "- " + cells[0])
                else:
                    parts = [f"{h}: {c}" if h else c for h, c in zip(headers, cells)]
                    out.append("- " + "，".join(parts))
                i += 1
        else:
            out.append(lines[i])
            i += 1
    return "\n".join(out)


def tg_api(token, method, params, timeout=15):
    url = f"https://api.telegram.org/bot{token}/{method}"
    data = json.dumps(params).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


class TelegramStreamer:
    """Sends the reply as it accumulates: the FIRST call with real text does
    a plain sendMessage (no empty placeholder bubble — the typing indicator
    already covers the "something is happening" gap before any text exists);
    every subsequent call edits that same message in place. Debounced (min
    interval between edits) to stay under Telegram's edit rate limit. Falls
    back to plain text if Markdown parsing fails, rather than losing the
    update entirely."""

    MIN_EDIT_INTERVAL = 2.5

    def __init__(self, token, chat_id):
        self.token = token
        self.chat_id = chat_id
        self.message_id = None
        self.last_edit_at = 0
        self.last_sent_text = None

    def discard(self):
        """收回這則串流中的訊息(內容被判定為旁白)。已送出就刪掉,還沒送出就無事。"""
        if self.message_id is None:
            return
        try:
            tg_api(self.token, "deleteMessage",
                   {"chat_id": self.chat_id, "message_id": self.message_id})
        except Exception as e:
            print(f"[telegram] discard failed: {e}", file=sys.stderr)
        self.message_id = None
        self.last_sent_text = None

    def _send_with_fallback(self, method, text, extra):
        try:
            return tg_api(self.token, method, {**extra, "text": text, "parse_mode": "Markdown"})
        except urllib.error.HTTPError as e:
            if e.code == 400:
                # Model's Markdown didn't parse cleanly — better a plain
                # message than a dropped update.
                return tg_api(self.token, method, {**extra, "text": text})
            raise

    def update(self, text, force=False):
        if not self.token or not self.chat_id or not text or text == self.last_sent_text:
            return
        now = time.time()
        if self.message_id and not force and (now - self.last_edit_at) < self.MIN_EDIT_INTERVAL:
            return
        try:
            if self.message_id is None:
                resp = self._send_with_fallback("sendMessage", text, {"chat_id": self.chat_id})
                self.message_id = resp["result"]["message_id"]
            else:
                self._send_with_fallback(
                    "editMessageText", text,
                    {"chat_id": self.chat_id, "message_id": self.message_id},
                )
            self.last_edit_at = now
            self.last_sent_text = text
        except Exception as e:
            print(f"[agent_turn] telegram send/edit failed: {e}", file=sys.stderr)

    def finish(self, text):
        self.update(text, force=True)


async def _typing_loop(token, chat_id):
    # Telegram's typing indicator only lasts ~5s — refresh every 4s for the
    # whole turn (independent of the message-bubble/segment logic above; it
    # covers gaps too, e.g. while a tool call is running and no text bubble
    # is being edited). Best-effort: a failed sendChatAction shouldn't kill
    # the turn.
    if not token or not chat_id:
        return
    while True:
        try:
            tg_api(token, "sendChatAction", {"chat_id": chat_id, "action": "typing"})
        except Exception as e:
            print(f"[agent_turn] typing indicator failed: {e}", file=sys.stderr)
        await asyncio.sleep(4)


class TelegramSink:
    """Delivery sink for Telegram. Encapsulates the edit-one-bubble streaming,
    the table-to-list conversion, and the "start a new bubble after each tool
    call" segmentation (so our own bubbles interleave in true chronological
    order with any side-channel photo sends lib/notify does mid-turn)."""

    formatting_rule = TELEGRAM_FORMATTING_RULE

    def __init__(self, token, chat_id):
        self.token = token
        self.chat_id = chat_id
        self.segments = []
        self.chunk_text = ""
        self.streamer = TelegramStreamer(token, chat_id)
        self.pending_new_bubble = False
        self._last_status = ""
        self.typing_task = None

    async def start(self):
        self.typing_task = asyncio.create_task(_typing_loop(self.token, self.chat_id))

    def on_text(self, delta):
        if self.pending_new_bubble:
            self.streamer.finish(convert_markdown_tables_to_list(self.chunk_text))
            self.segments.append(self.chunk_text)
            self.chunk_text = ""
            self.streamer = TelegramStreamer(self.token, self.chat_id)
            self.pending_new_bubble = False
        self.chunk_text += delta
        self.streamer.update(convert_markdown_tables_to_list(self.chunk_text))

    def on_tool(self, block):
        # 同 WebSink:後面還有工具呼叫的文字段是旁白。TG 是邊打邊編輯同一則訊息,
        # 所以要把已經送出的那則刪掉,否則旁白會變成一堆零碎訊息。
        if self.chunk_text.strip():
            self.streamer.discard()
            self._last_status = self.chunk_text
            self.chunk_text = ""
            self.streamer = TelegramStreamer(self.token, self.chat_id)
            self.pending_new_bubble = False
            return
        self.pending_new_bubble = True

    def on_status(self, text):
        # 過場旁白(帶工具呼叫的訊息裡的文字)——TG 沒有狀態列,直接不送,
        # 免得旁白變成一堆零碎訊息。留著當空回覆時的備援。
        self._last_status = text

    def on_thinking(self, block):
        # Telegram has no "thinking" surface — reasoning is ignored here (it's
        # already kept out of the reply text by the no-narration system prompt).
        pass

    def set_error(self, text):
        # Replace the in-progress chunk with the error message.
        self.chunk_text = text

    async def stop(self):
        if self.typing_task:
            self.typing_task.cancel()

    def finalize(self):
        cleaned, cut = strip_hallucinated_turn(self.chunk_text)
        if cut:
            print("[agent_turn] 截掉模型續寫的假對話回合", file=sys.stderr)
        # TG 面沒有建議列規則,但防禦性剝除(模型偶發混淆時 raw 標記不能露出)。
        cleaned, _ = extract_suggestions(cleaned)
        self.chunk_text = cleaned
        self.chunk_text = convert_markdown_tables_to_list(self.chunk_text)
        self.streamer.finish(self.chunk_text)
        self.segments.append(self.chunk_text)
        reply = "\n\n".join(s for s in self.segments if s)
        if not reply and getattr(self, "_last_status", ""):
            # 極端情況:模型把話全講在帶工具的訊息裡、最後一則沒有純文字——
            # 用最後一句旁白當回覆,別讓用戶收到空氣。
            reply = convert_markdown_tables_to_list(self._last_status)
            self.streamer.finish(reply)
        return reply


def _post_report(report_url, token, chunk, timeout=15):
    """POST one chunk to the web-chat transport (api/openclaw/webchat.py
    /report). Best-effort: a failed report shouldn't crash the turn."""
    data = json.dumps(chunk).encode()
    req = urllib.request.Request(
        report_url, data=data,
        headers={"Content-Type": "application/json", "x-api-key": f"proxy-{token}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except Exception as e:
        print(f"[agent_turn] web report failed: {e}", file=sys.stderr)
        return None


class WebSink:
    """Delivery sink for the website chat. Each text delta / tool call / end
    is a discrete chunk POSTed to /report, which the browser reads over SSE.
    Text is sent as deltas (the browser appends); the transport adds seq +
    timestamp and buffers for reconnect replay, so we just push raw deltas."""

    formatting_rule = WEB_FORMATTING_RULE

    def __init__(self, report_url, report_token, session_id):
        self.report_url = report_url
        self.report_token = report_token
        self.session_id = session_id
        self.full_text = ""
        self.error_text = None
        # Set when the user hits Stop: /report piggybacks `interrupt: true` on its
        # response (that's the only channel that reaches this VM mid-turn), and
        # run_turn breaks at the next step boundary.
        self.interrupted = False
        # Text resuming after a tool call gets a paragraph break — without it the
        # inter-tool narration fragments glue into one wall when history replays.
        self._break_before_text = False
        self._last_status = ""
        # 目前這段文字在 full_text 裡的起點。SDK 每個 block 各自一則訊息,所以
        # 「同訊息裡有沒有 tool_use」判不出旁白;真正的訊號是「這段文字後面還有沒有
        # 工具呼叫」——有就是旁白(丟去活動列),最後那段才是回覆。
        self._seg_start = 0

    def _send(self, chunk):
        chunk.setdefault("session_id", self.session_id)
        resp = _post_report(self.report_url, self.report_token, chunk)
        if resp and resp.get("interrupt"):
            self.interrupted = True

    async def start(self):
        pass

    def on_text(self, delta):
        if not delta:
            return
        if self._break_before_text:
            self._break_before_text = False
            if self.full_text and not self.full_text.endswith("\n") and not delta.startswith("\n"):
                delta = "\n\n" + delta
        self.full_text += delta
        self._send({"type": "text", "text": delta})

    def on_status(self, text):
        # 過場旁白——走 thinking 通道進「思考/活動」指示器,不進泡泡、不進歷史。
        # 用戶看得到 agent 在做什麼,但對話裡只留最後的真回覆。
        if not text:
            return
        self._last_status = text
        self._send({"type": "thinking", "text": text})

    def on_tool(self, block):
        # 這段文字後面接了工具呼叫 → 是過場旁白:移出回覆本文(不進歷史),
        # 改送活動列。前端收到 tool chunk 也會把對應的文字區塊從泡泡移除。
        seg = self.full_text[self._seg_start:]
        if seg.strip():
            self.full_text = self.full_text[:self._seg_start]
            self._last_status = seg
            self._send({"type": "thinking", "text": seg})
        self._seg_start = len(self.full_text)
        self._break_before_text = True
        # Surface which tool is running so the UI can show a status line
        # (e.g. "跑回測中"); the frontend maps tool name -> label.
        self._send({"type": "tool", "tool": getattr(block, "name", ""), "status": "running"})

    def on_thinking(self, block):
        # The model's reasoning (SDK ThinkingBlock) — feeds the workspace's
        # "thinking" indicator, which shows only the latest step, not the whole
        # trace. Not part of the reply text (full_text) or persisted history.
        text = getattr(block, "thinking", None) or getattr(block, "text", "") or ""
        if text:
            self._send({"type": "thinking", "text": text})

    def set_error(self, text):
        self.error_text = text

    async def stop(self):
        pass

    def finalize(self):
        if self.error_text:
            self._send({"type": "error", "message": self.error_text})
            return self.error_text
        if not self.full_text and getattr(self, "_last_status", ""):
            # 模型把話全講在帶工具的訊息裡——用最後一句旁白補位,別回空氣
            self.on_text(self._last_status)
        # 假對話一定長在最後一段(續寫發生在回覆結尾),所以只需清這一段,
        # 並叫前端把已經串流出去的那段換成乾淨版。<suggest> 區塊同理(規則要求
        # 放在回覆最末尾),一起在這段剝離——歷史(finalize 回傳值)因此也是乾淨的。
        seg = self.full_text[self._seg_start:]
        cleaned, cut = strip_hallucinated_turn(seg)
        if cut:
            print("[agent_turn] 截掉模型續寫的假對話回合", file=sys.stderr)
        cleaned, suggestions = extract_suggestions(cleaned)
        if cleaned != seg:
            self.full_text = self.full_text[: self._seg_start] + cleaned
            self._send({"type": "text_replace", "text": cleaned})
        # 被 Stop 截斷的回合不給建議——半途的里程碑判定不可信。
        if suggestions and not self.interrupted:
            self._send({"type": "suggestions", "items": suggestions})
        self._send({"type": "done"})
        return self.full_text


def load_agents_md():
    # AGENTS.md is the persona/rules layer (quant assistant behavior, Type
    # A/B classification, broker attribution, etc.) — it must be present on
    # every turn, not just when the model happens to go read it itself.
    path = os.path.join(WORKSPACE, "AGENTS.md")
    try:
        with open(path) as f:
            return f.read()
    except FileNotFoundError:
        print(f"[agent_turn] WARNING: AGENTS.md not found at {path}", file=sys.stderr)
        return ""


def _strategies_signature(strategies):
    # Cheap fingerprint of the inventory (name + status + has-backtest) so we only push
    # a fresh list when it actually changed, not on every tool step.
    return json.dumps(
        sorted([s.get("name"), s.get("status"), bool(s.get("backtest"))] for s in strategies)
    )


def _maybe_push_strategies(sink, last_sig):
    """Mid-turn: the moment the agent's tools change the strategy inventory (a new
    strategy file, a finished backtest), push the fresh list so the workspace updates
    right away instead of waiting for the whole turn to end. Live SSE chunk only (size-
    trimmed to the /report cap) — the full cache is refreshed by web_bridge at turn end."""
    try:
        strategies = strategy_reporter.scan()
    except Exception as e:
        print(f"[agent_turn] mid-turn strategy scan failed: {e}", file=sys.stderr)
        return last_sig
    sig = _strategies_signature(strategies)
    if sig != last_sig:
        sink._send(strategy_reporter.live_chunk(strategies))
    return sig


async def run_turn(session_id, message, model, sink, viewing_strategy=None, viewing_tab=None):
    summary, recent = ss.get_context(session_id)
    prompt = build_prompt(summary, recent, message,
                          viewing_strategy=viewing_strategy, viewing_tab=viewing_tab,
                          suggest_directive=isinstance(sink, WebSink))
    agents_md = load_agents_md()

    # Persist the user's message BEFORE calling the SDK — if the turn later
    # crashes (e.g. hits max_turns), the message must not vanish. Losing the
    # user's own words is worse than a slightly-early write.
    ss.append_turn(session_id, "user", message)

    # BLAVE_AGENT_DB:AGENTS.md 教 agent 用 sqlite 唯讀查自己的逐字稿;Linux 的
    # provisioning 沒設這個 env,在這裡帶最終解析值,兩個 OS 都保證看得到。
    turn_env = {**PROXY_ENV, "BLAVECLAW_HOME": BLAVECLAW_HOME, "BLAVE_AGENT_DB": ss.DB_PATH}
    # Claude Code's Bash tool auto-backgrounds any command still running at 600s
    # (CLAUDE_CODE_AUTO_BACKGROUND_TIMEOUT_MS) and caps the per-call `timeout`
    # at BASH_MAX_TIMEOUT_MS (600s). A large-universe Type C backtest (300 台股,
    # cold cache, throttled Windows box) takes longer than that: uid=1 2026-08-22
    # the run got backgrounded at 600s, the agent ended the turn "waiting", and the
    # turn's exit killed the backtest — $0.71 for no stats.json. 30 min keeps a
    # long backtest in the foreground so the agent actually sees it finish; the
    # turn's own max_turns / max_budget_usd brakes still bound the damage.
    # The auto-background threshold is min(requested timeout, AUTO_BACKGROUND), so
    # only runs the agent explicitly gives a long `timeout` stay in the foreground;
    # BASH_DEFAULT_TIMEOUT_MS is deliberately left at its 120s default so a
    # command that hangs with no timeout still gets backgrounded fast.
    # MUST stay strictly below the bridges' turn timeouts (telegram_bridge 2000s,
    # web_bridge TURN_TIMEOUT 2100s) or a rule-abiding long backtest gets the
    # whole turn killed instead. Names verified inside claude 2.1.239.
    turn_env.update({
        "CLAUDE_CODE_AUTO_BACKGROUND_TIMEOUT_MS": "1800000",
        "BASH_MAX_TIMEOUT_MS": "1800000",
        # The Windows native claude.exe self-updates unless told not to; set it on both
        # OSes (the Linux CLI bundled in the SDK wheel is not documented to, but this
        # costs nothing). Keep every machine on the CLI its image shipped — no 330MB
        # download mid-turn on a throttled box, no silent CLI/SDK drift. Name verified
        # inside claude 2.1.239.
        "DISABLE_AUTOUPDATER": "1",
    })
    if isinstance(sink, WebSink):
        # So lib/notify.report_photo_web can mirror backtest/param-scan charts into the
        # web chat (the agent's Bash-run strategy code inherits this env).
        turn_env["BLAVE_WEB_REPORT_URL"] = sink.report_url
        turn_env["BLAVE_WEB_REPORT_TOKEN"] = sink.report_token
        turn_env["BLAVE_WEB_SESSION"] = sink.session_id

    options = sdk.ClaudeAgentOptions(
        model=model,
        env=turn_env,
        cwd=WORKSPACE,
        # allowed_tools is an AUTO-APPROVE list, not a hard restriction — the
        # subagent tool (Task/Agent) ran fine outside it (07-28 實測,DeepSeek
        # 自己 spawn 了 explore 子代理)。Subagents interleave a second stream
        # into the same sink and wreck the「最後一段無工具文字=回覆」判定
        # (正式回覆被子代理尾隨的 tool chunk 收回成旁白,子代理的英文報告
        # 反而變成回覆),所以用 disallowed_tools 硬禁。`tools=` (also a valid
        # kwarg) is for *defining* custom/MCP tools — not this either.
        allowed_tools=ALLOWED_TOOLS,
        disallowed_tools=["Task", "Agent"],
        # Keep Claude Code's own default system prompt (tool-use guidance
        # etc.) and append AGENTS.md + this surface's formatting rule on top.
        system_prompt={
            "type": "preset",
            "preset": "claude_code",
            "append": agents_md + model_catalog_rule(session_id)
            + preferences_rule() + sink.formatting_rule,
        } if agents_md else None,
        # 實測「建策略+回測+調參」正常就要 20+ 步(BTC RSI 那輪 21 步被砍在半路,
        # $1.46 白燒)。步數放寬到 50,真正的煞車改用預算——失控迴圈燒錢才是
        # 原本要防的事,用錢設限比步數合理。
        max_turns=50,
        max_budget_usd=10,
        # SDK 的 stdio transport 預設單條 JSON 訊息上限 1MB——agent 一個 Bash 印出
        # 大量輸出(K 線資料、回測明細)就整輪炸掉(實測:「建立 MACD 策略」第一輪
        # 就中)。放寬到 16MB;這是單條訊息的解析上限,不是常駐記憶體。
        max_buffer_size=16 * 1024 * 1024,
        permission_mode="bypassPermissions",
    )

    await sink.start()
    try:
        query_iter = sdk.query(prompt=prompt, options=options)
        is_web = isinstance(sink, WebSink)
        strat_sig = None
        async for msg in query_iter:
            if isinstance(msg, sdk.AssistantMessage):
                # 第二層防線(第一層是 disallowed_tools):子代理的訊息帶
                # parent_tool_use_id,它的文字一律進活動列、不進回覆/歷史——
                # 兩條 stream 混流時,回覆的結構判定(見下)會被子代理打亂。
                if getattr(msg, "parent_tool_use_id", None):
                    for block in msg.content:
                        if isinstance(block, sdk.TextBlock) and block.text.strip():
                            sink.on_status(block.text)
                    continue
                # 結構性旁白判定:同一則訊息裡帶 ToolUseBlock,其中的文字就是
                # 「我來查一下…」式的過場話——只給狀態指示器,不進回覆/歷史。
                # 真正的回覆是最後那則(沒有工具呼叫)的文字。用 prompt 禁止旁白
                # 屢戰屢敗(preset 本來就鼓勵邊做邊講),這裡用結構切,100% 生效。
                has_tool_use = any(isinstance(b, sdk.ToolUseBlock) for b in msg.content)
                had_tool = False
                for block in msg.content:
                    if isinstance(block, sdk.TextBlock):
                        if has_tool_use:
                            sink.on_status(block.text)
                        else:
                            sink.on_text(block.text)
                    elif isinstance(block, sdk.ThinkingBlock):
                        sink.on_thinking(block)
                    elif isinstance(block, sdk.ToolUseBlock):
                        sink.on_tool(block)
                        had_tool = True
                    # A Stop arrives via the /report response inside on_*; break
                    # at the next block boundary rather than mid-message.
                    if getattr(sink, "interrupted", False):
                        break
                # A tool may have just created a strategy or finished a backtest —
                # push the fresh list now (web only) rather than waiting for turn end.
                if is_web and had_tool and not getattr(sink, "interrupted", False):
                    strat_sig = _maybe_push_strategies(sink, strat_sig)
            elif isinstance(msg, sdk.ResultMessage):
                print(f"[agent_turn] cost=${msg.total_cost_usd} turns={msg.num_turns}", file=sys.stderr)
            if getattr(sink, "interrupted", False):
                print("[agent_turn] interrupted by user — stopping turn", file=sys.stderr)
                aclose = getattr(query_iter, "aclose", None)
                if aclose:
                    await aclose()  # let the SDK tear down the subprocess/session cleanly
                break
    except Exception as e:
        # A crash here must never silently drop the turn — always leave a
        # record (so future turns have context) and always give the user
        # something back.
        print(f"[agent_turn] turn failed: {e}", file=sys.stderr)
        if "maximum number of turns" in str(e).lower():
            sink.set_error("這個任務需要的步驟比較多，處理到一半被中斷了。可以換個更小/更具體的問題再試一次。")
        else:
            sink.set_error("處理這則訊息時發生錯誤，稍後再試一次。")
    finally:
        await sink.stop()

    reply_text = sink.finalize()
    ss.append_turn(session_id, "assistant", reply_text)
    ss.maybe_compact(session_id)

    return reply_text


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("session_id")
    parser.add_argument("message")
    parser.add_argument("--model", default=model_prefs.DEFAULT_MODEL)
    parser.add_argument("--delivery", default="telegram", choices=["telegram", "web"])
    parser.add_argument("--telegram-chat-id", default=None)
    parser.add_argument("--report-url", default=None)
    parser.add_argument("--viewing-strategy", default=None)
    parser.add_argument("--viewing-tab", default=None, choices=[None, "code", "data"])
    args = parser.parse_args()

    # Secrets come from env, never argv — argv is world-visible in `ps`. The web
    # report token IS the machine's proxy token; the Telegram bot token is passed
    # by telegram_bridge in the subprocess env.
    report_token = os.environ.get("BLAVE_PROXY_TOKEN", "")
    telegram_token = os.environ.get("BLAVE_TELEGRAM_TOKEN")

    if args.delivery == "web":
        sink = WebSink(args.report_url, report_token, args.session_id)
    else:
        sink = TelegramSink(telegram_token, args.telegram_chat_id)

    reply = asyncio.run(run_turn(
        args.session_id, args.message, args.model, sink,
        viewing_strategy=args.viewing_strategy, viewing_tab=args.viewing_tab,
    ))
    print(reply)


if __name__ == "__main__":
    main()
