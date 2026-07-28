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
# 這些字串全是本檔產生的,正常回覆不會出現。
_SCAFFOLD_RE = re.compile(
    r"^(?:user:\s|assistant:\s"
    r"|\[工作頁狀態[:：]"
    r"|\[使用者這次的訊息\]"
    r"|\[用中文回覆這則訊息\]"
    r"|\[The user wrote in English"
    r"|\[Reply in the language of the user message"
    r"|\[近期對話"
    r"|\[過去對話摘要\])",
    re.M,
)


def strip_hallucinated_turn(text):
    """截掉模型續寫出來的假對話回合。回傳 (清理後文字, 是否有截斷)。"""
    if not text:
        return text, False
    m = _SCAFFOLD_RE.search(text)
    if not m:
        return text, False
    return text[: m.start()].rstrip(), True


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


def build_prompt(summary, recent, message, viewing_strategy=None, viewing_tab=None):
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
        # 並叫前端把已經串流出去的那段換成乾淨版。
        seg = self.full_text[self._seg_start:]
        cleaned, cut = strip_hallucinated_turn(seg)
        if cut:
            print("[agent_turn] 截掉模型續寫的假對話回合", file=sys.stderr)
            self.full_text = self.full_text[: self._seg_start] + cleaned
            self._send({"type": "text_replace", "text": cleaned})
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
    right away instead of waiting for the whole turn to end. Live SSE chunk only — the
    cache is refreshed by web_bridge at turn end."""
    try:
        strategies = strategy_reporter.scan()
    except Exception as e:
        print(f"[agent_turn] mid-turn strategy scan failed: {e}", file=sys.stderr)
        return last_sig
    sig = _strategies_signature(strategies)
    if sig != last_sig:
        sink._send({"type": "strategies", "strategies": strategies})
    return sig


async def run_turn(session_id, message, model, sink, viewing_strategy=None, viewing_tab=None):
    summary, recent = ss.get_context(session_id)
    prompt = build_prompt(summary, recent, message,
                          viewing_strategy=viewing_strategy, viewing_tab=viewing_tab)
    agents_md = load_agents_md()

    # Persist the user's message BEFORE calling the SDK — if the turn later
    # crashes (e.g. hits max_turns), the message must not vanish. Losing the
    # user's own words is worse than a slightly-early write.
    ss.append_turn(session_id, "user", message)

    turn_env = {**PROXY_ENV, "BLAVECLAW_HOME": BLAVECLAW_HOME}
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
            "append": agents_md + model_catalog_rule(session_id) + sink.formatting_rule,
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
