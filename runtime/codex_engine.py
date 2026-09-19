"""
Codex engine for the desktop shell: run one `codex exec --json` turn and feed its JSONL
events into the same sink the Claude path uses. Only reached via
`agent_turn.py --engine codex`; the fleet never imports this module's code path.

Event shapes are taken from the Codex source, not from observation alone
(codex-rs/exec/src/exec_events.rs + event_processor_with_jsonl_output.rs, checked against
codex-cli 0.155.0-alpha.9). Three things there are easy to get wrong:
  - a top-level `error` event is NOT terminal — Codex keeps running after it (retry /
    reconnect notices take this path). Only `turn.failed` ends the turn; `error` is kept as
    the message to raise with if the process then dies without one.
  - an item of type `error` is a warning (config warning, deprecation, model rerouted).
  - `exec --json` has no text deltas: an agent_message arrives whole at item.completed.

Multi-turn: every turn is `--ephemeral` and context comes from our own session store via
build_prompt — never `exec resume <thread_id>`. Using both would feed the history twice;
ours is the one kept because it is the same mechanism as the Claude path (same compaction,
same fault receipts written for the next turn, and a user can switch engines mid-session
without losing the conversation), and resume would also fill the user's own Codex session
list with one entry per chat message.
"""
import asyncio
import json
import os
import re
import shlex
import sys
from types import SimpleNamespace

# Same ceiling as the Claude path's max_buffer_size: one JSONL line carries a command's
# whole aggregated_output, and asyncio's default 64 KB line limit would kill the turn.
_LINE_LIMIT = 16 * 1024 * 1024
# Codex reads cwd's AGENTS.md natively but silently truncates at project_doc_max_bytes
# (default 32 KiB). Ours is 39 KB (2026-09-19), so the tail rules would vanish unannounced.
_PROJECT_DOC_MAX_BYTES = 262144
_SHELL_WRAPPERS = ("sh", "bash", "zsh")


class CodexTurnFailed(RuntimeError):
    """`api_error_status` is the attribute agent_turn._fault_code already reads."""

    def __init__(self, message, api_error_status=None):
        super().__init__(message)
        self.api_error_status = api_error_status


def build_args(codex_bin, cwd):
    return [
        codex_bin, "exec", "--json", "--ephemeral", "--skip-git-repo-check",
        # exec's default sandbox is read-only, and workspace-write has the network OFF by
        # default — the agent writes strategy files and every lib/ data fetch needs the net.
        "-s", "workspace-write",
        "-c", "sandbox_workspace_write.network_access=true",
        "-c", f"project_doc_max_bytes={_PROJECT_DOC_MAX_BYTES}",
        "-C", cwd,
        # Prompt on stdin, not argv: it carries the conversation history (argv is
        # world-readable in `ps`, and Windows caps a command line at 32,767 chars — the
        # same wall _write_system_prompt_file exists for). Closing stdin after the write
        # is also what stops exec from waiting on "Reading additional input from stdin".
        "-",
    ]


def _unwrap_shell(command):
    """`/bin/zsh -lc 'python3 lib/x.py'` → `python3 lib/x.py`, so the receipt summary and
    touched-strategy detection see the command the model wrote, not Codex's wrapper."""
    try:
        tokens = shlex.split(command)
    except ValueError:
        return command
    if len(tokens) == 3 and os.path.basename(tokens[0]) in _SHELL_WRAPPERS \
            and tokens[1] in ("-lc", "-c"):
        return tokens[2]
    return command


# Codex's own wording (codex-rs/protocol/src/error.rs): "unexpected status 503 Service
# Unavailable: …", "exceeded retry limit, last status: 429 Too Many Requests, …".
_STATUS_RE = re.compile(r"status:? (\d{3})\b")
# Upstream failures that carry no status code, same file.
_UPSTREAM_MARKERS = (
    "stream disconnected before completion", "rate limit exceeded", "request timed out",
    "experiencing high demand", "model is at capacity",
)


def _upstream_status(message):
    """The HTTP status agent_turn._fault_code should classify on, or None. Status-less
    upstream failures report 503 so they read as "the model service did not answer";
    anything unrecognised stays None → the neutral not_started, which is the safe side."""
    text = message or ""
    m = _STATUS_RE.search(text)
    if m:
        return int(m.group(1))
    return 503 if any(marker in text for marker in _UPSTREAM_MARKERS) else None


class CodexTranslator:
    """Codex JSONL events → sink calls. Tool names are the Claude ones (Bash / Edit /
    Write / WebSearch / Agent) so every surface's existing label map and
    agent_turn._tool_summary work unchanged; an MCP call shows its own tool name."""

    def __init__(self, sink, on_tool_start=None, on_tool_done=None):
        self.sink = sink
        self.on_tool_start = on_tool_start
        self.on_tool_done = on_tool_done
        self.thread_id = None
        self.usage = None
        self.completed = False
        self.failure = None      # turn.failed message — terminal
        self.last_error = None   # latest `error` event — terminal only if the turn dies
        self._open = {}          # item id -> tool-use ids announced and not yet closed
        self._after_message = False

    def feed(self, event):
        kind = event.get("type")
        if kind == "thread.started":
            self.thread_id = event.get("thread_id")
        elif kind == "turn.completed":
            self.usage = event.get("usage")
            self.completed = True
        elif kind == "turn.failed":
            self.failure = (event.get("error") or {}).get("message") or "turn failed"
        elif kind == "error":
            self.last_error = event.get("message") or ""
            print(f"[codex] error event: {self.last_error}", file=sys.stderr)
        elif kind in ("item.started", "item.completed"):
            self._item(event.get("item") or {}, done=kind == "item.completed")
        # turn.started / item.updated (todo_list progress) carry nothing a sink shows

    def _item(self, item, done):
        kind = item.get("type")
        if kind == "agent_message":
            text = item.get("text") or ""
            if done and text:
                # Two messages back to back have no separator of their own; the sink only
                # inserts a paragraph break after a tool call.
                self.sink.on_text(("\n\n" if self._after_message else "") + text)
                self._after_message = True
            return
        if kind == "reasoning":
            if done and item.get("text"):
                self.sink.on_thinking(SimpleNamespace(thinking=item["text"]))
            return
        if kind == "error":
            print(f"[codex] warning: {item.get('message')}", file=sys.stderr)
            return
        calls = self._tool_calls(item)
        if not calls:
            return  # todo_list, or an item type this build does not know
        self._after_message = False
        item_id = item.get("id") or ""
        if item_id not in self._open:
            # Some items only ever arrive as item.completed (no item.started) — announce
            # them here so the receipt row exists before its result closes it.
            self._open[item_id] = []
            for i, (name, params) in enumerate(calls):
                use_id = f"{item_id}:{i}"
                self._open[item_id].append(use_id)
                if self.on_tool_start:
                    self.on_tool_start(name, params)
                self.sink.on_tool(SimpleNamespace(id=use_id, name=name, input=params))
        if not done:
            return
        failed = item.get("status") in ("failed", "declined") \
            or item.get("exit_code") not in (None, 0) or bool(item.get("error"))
        on_result = getattr(self.sink, "on_tool_result", None)
        for use_id in self._open.pop(item_id):
            if on_result:
                on_result(SimpleNamespace(tool_use_id=use_id, is_error=failed))
        if self.on_tool_done:
            self.on_tool_done()

    @staticmethod
    def _tool_calls(item):
        """[(tool name, input dict)] — one entry per receipt row."""
        kind = item.get("type")
        if kind == "command_execution":
            return [("Bash", {"command": _unwrap_shell(item.get("command") or "")})]
        if kind == "file_change":
            # One row per file, like Claude's one Edit per file.
            return [("Write" if change.get("kind") == "add" else "Edit",
                     {"file_path": change.get("path") or ""})
                    for change in item.get("changes") or [] if isinstance(change, dict)]
        if kind == "mcp_tool_call":
            return [(item.get("tool") or "MCP", {})]
        if kind == "web_search":
            return [("WebSearch", {"query": item.get("query") or ""})]
        if kind == "collab_tool_call":
            return [("Agent", {})]
        return []


async def run(codex_bin, prompt, cwd, env, sink, on_tool_start=None, on_tool_done=None):
    """One Codex turn. Returns the translator (usage, thread_id); raises CodexTurnFailed
    when the turn did not complete, so the caller's existing fault path classifies it."""
    if not codex_bin:
        raise CodexTurnFailed("--engine codex needs --codex-bin")
    translator = CodexTranslator(sink, on_tool_start, on_tool_done)
    proc = await asyncio.create_subprocess_exec(
        *build_args(codex_bin, cwd),
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=None,  # Codex's own log goes straight to this process's stderr
        cwd=cwd, env=env, limit=_LINE_LIMIT,
    )
    try:
        proc.stdin.write(prompt.encode("utf-8"))
        await proc.stdin.drain()
        proc.stdin.close()
        async for raw in proc.stdout:
            line = raw.decode("utf-8", errors="replace").strip()
            if not line.startswith("{"):
                continue
            try:
                event = json.loads(line)
            except ValueError:
                print(f"[codex] unparseable line: {line[:200]}", file=sys.stderr)
                continue
            translator.feed(event)
            if getattr(sink, "interrupted", False):
                break
        if getattr(sink, "interrupted", False):
            return translator
        code = await proc.wait()
    finally:
        if proc.returncode is None:
            proc.kill()
            await proc.wait()
    if translator.failure or not translator.completed:
        message = translator.failure or translator.last_error \
            or f"codex exited with code {code} before completing the turn"
        raise CodexTurnFailed(message, _upstream_status(message))
    print(f"[codex] usage={translator.usage}", file=sys.stderr)
    return translator
