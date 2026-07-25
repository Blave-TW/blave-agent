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


def build_prompt(summary, recent, message, viewing_strategy=None, viewing_tab=None):
    parts = []
    if summary:
        parts.append(f"[過去對話摘要]\n{summary}\n")
    if recent:
        parts.append("[近期對話]")
        for role, content in recent:
            parts.append(f"{role}: {content}")
        parts.append("")
    # Ephemeral UI context (web workspace only) — the strategy the user is
    # looking at right now. Placed next to their message so "這支/this one"
    # resolves. NOT persisted to session (it's the state at send time, not part
    # of the conversation). The code itself isn't passed — the agent reads the
    # file from strategies/ if it needs it.
    if viewing_strategy:
        # which tab is open decides what "這個 / 這裡 / 這結果" points at.
        if viewing_tab == "data":
            focus = "的回測數據(績效指標與權益曲線)"
        elif viewing_tab == "code":
            focus = "的程式碼"
        else:
            focus = ""
        parts.append(
            f"[工作頁狀態:使用者目前在中間欄看著策略「{viewing_strategy}」{focus}。"
            f"他說「這支 / 這個策略 / 這裡 / 這結果」通常就是指這支;需要看內容就自己讀 "
            f"strategies/ 底下對應的檔(程式碼在 strategy.py、回測結果在 stats.json / pnl.png)。]"
        )
    parts.append(f"user: {message}")
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
TELEGRAM_FORMATTING_RULE = (
    "\n\n---\n\n"
    "## Telegram 輸出格式（本 runtime 專屬規則）\n"
    "回覆會用 Telegram 的 legacy Markdown 解析送出，語法跟一般 Markdown不同：\n"
    "- 粗體用單星號 *文字*（不是 **文字**）\n"
    "- 斜體用底線 _文字_\n"
    "- 代碼用反引號 `文字`\n"
    "- 不支援標題（#）、不支援表格（|）—表格一律改成清單（- 開頭）或分行條列\n"
    "段落之間適時空行，不要擠成一大塊。\n\n"
    "**每個文字段落之間會各自變成一則獨立 Telegram 訊息**（工具呼叫前後會分開送）。"
    + _NO_NARRATION
)

# Web renders standard Markdown in the browser — tables, headings, and
# double-asterisk bold all work, so no legacy-syntax constraints.
WEB_FORMATTING_RULE = (
    "\n\n---\n\n"
    "## 網頁輸出格式（本 runtime 專屬規則）\n"
    "回覆會在網頁上以標準 Markdown 顯示，可正常使用 **粗體**、清單、"
    "`程式碼`、程式碼區塊、表格、標題。段落之間適時空行。\n\n"
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
        self.pending_new_bubble = True

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
        self.chunk_text = convert_markdown_tables_to_list(self.chunk_text)
        self.streamer.finish(self.chunk_text)
        self.segments.append(self.chunk_text)
        return "\n\n".join(s for s in self.segments if s)


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
        self.full_text += delta
        self._send({"type": "text", "text": delta})

    def on_tool(self, block):
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
        # allowed_tools is the actual allowlist that restricts the agent; `tools=`
        # (also a valid kwarg) is for *defining* custom/MCP tools and silently
        # leaves the built-in set unrestricted (WebFetch/WebSearch/etc. would stay
        # on). Keep the agent to Bash/Read/Write/Edit/Glob/Grep only.
        allowed_tools=ALLOWED_TOOLS,
        # Keep Claude Code's own default system prompt (tool-use guidance
        # etc.) and append AGENTS.md + this surface's formatting rule on top.
        system_prompt={
            "type": "preset",
            "preset": "claude_code",
            "append": agents_md + model_catalog_rule(session_id) + sink.formatting_rule,
        } if agents_md else None,
        # Trading/coding tasks legitimately need several tool round-trips
        # (read a few files, run a check, write, verify). Bounded so a
        # genuinely runaway loop still stops, not so tight that ordinary
        # multi-step work errors out.
        max_turns=20,
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
                had_tool = False
                for block in msg.content:
                    if isinstance(block, sdk.TextBlock):
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
