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
import functools
import json
import os
import re
import shlex
import subprocess
import sys
import tomllib
from types import SimpleNamespace

# Same ceiling as the Claude path's max_buffer_size: one JSONL line carries a command's
# whole aggregated_output, and asyncio's default 64 KB line limit would kill the turn.
_LINE_LIMIT = 16 * 1024 * 1024
# Codex reads cwd's AGENTS.md natively but silently truncates at project_doc_max_bytes
# (default 32 KiB). Ours is 39 KB (2026-09-19), so the tail rules would vanish unannounced.
_PROJECT_DOC_MAX_BYTES = 262144
_SHELL_WRAPPERS = ("sh", "bash", "zsh")
# `blave` MCP for the desktop shell. The shell puts the access code in this variable (Codex
# turns only) and the server URL in BLAVE_MCP_URL; Codex reads the token itself from the env
# named by bearer_token_env_var, so the code never appears on argv or in Codex's own logs.
# Codex also hands its whole env to the agent's shell (ignore_default_excludes defaults to true
# in 0.150+, false back in 0.46), so a plain `env` would print the code. build_args strips only
# this one name with `shell_environment_policy.filters` — ignore_default_excludes=false would
# also strip BLAVE_WEB_REPORT_TOKEN, which chat image mirroring needs. filters first shipped in
# rust-v0.146.0 (#34590), hence the floor: an older build lacks the key and would leak.
# Accepted residual: any process of the same uid can read codex's env with `ps -E <pid>` — on
# par with the Claude path, whose 0600 --mcp-config file the same uid can read.
MCP_TOKEN_ENV = "BLAVE_MCP_TOKEN"
_MCP_MIN_VERSION = (0, 146, 0)
# Measured on 0.155.0-alpha.9.2 and 0.155.1: with the stable-on shell_snapshot feature every
# shell_environment_policy lever is a no-op (even inherit="none" still showed the code), because
# the snapshot replays the exports of a login shell spawned with codex's own env. 0.146.0 did
# not leak, but the flag costs nothing there. The ~150 ms per command it adds is the price.
# shell_snapshot_v2 (under development in 0.155, off by default, absent in 0.146) is a separate
# code path a user can switch on; whether it honours the policy is unverified, so it goes too.
_MCP_ENV_FLAGS = ("-c", f'shell_environment_policy.filters.{MCP_TOKEN_ENV}="exclude"',
                  "-c", "features.shell_snapshot=false", "-c", "features.shell_snapshot_v2=false")
# Legacy managed config, loaded ABOVE our `-c` (precedence 40; the MDM copy is 50 — config/src/
# config_layer_source.rs). Windows 0.155 ignores its $CODEX_HOME copy; older builds may not.
_MANAGED_CONFIG_PATH = None if os.name == "nt" else "/etc/codex/managed_config.toml"
_VERSION_RE = re.compile(r"(\d+)\.(\d+)\.(\d+)")


class CodexTurnFailed(RuntimeError):
    """`api_error_status` is the attribute agent_turn._fault_code already reads."""

    def __init__(self, message, api_error_status=None):
        super().__init__(message)
        self.api_error_status = api_error_status


@functools.lru_cache(maxsize=None)
def codex_version(codex_bin):
    """(major, minor, patch) from `codex --version` ("codex-cli 0.155.0-alpha.9.2"), or None.
    One probe per process — a process is one turn."""
    try:
        out = subprocess.run([codex_bin, "--version"], capture_output=True, text=True,
                             timeout=15).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    m = _VERSION_RE.search(out or "")
    return tuple(int(x) for x in m.groups()) if m else None


def _mdm_config_toml():
    """macOS MDM `config_toml_base64` (app id com.openai.codex) decoded to TOML text, read the
    way Codex reads it (CFPreferencesCopyAppValue — config/src/loader/macos.rs). None when there
    is none or it cannot be looked up; raises ValueError when it is there but not base64/UTF-8
    text (Codex then refuses to load its config)."""
    if sys.platform != "darwin":
        return None
    import base64, ctypes, ctypes.util
    utf8 = 0x08000100
    try:
        cf = ctypes.cdll.LoadLibrary(ctypes.util.find_library("CoreFoundation"))
        cf.CFStringCreateWithCString.restype = ctypes.c_void_p
        cf.CFStringCreateWithCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_uint32]
        cf.CFPreferencesCopyAppValue.restype = ctypes.c_void_p
        cf.CFPreferencesCopyAppValue.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        cf.CFGetTypeID.restype = ctypes.c_ulong
        cf.CFGetTypeID.argtypes = [ctypes.c_void_p]
        cf.CFStringGetTypeID.restype = ctypes.c_ulong
        cf.CFStringGetLength.restype = ctypes.c_long
        cf.CFStringGetLength.argtypes = [ctypes.c_void_p]
        cf.CFStringGetCString.restype = ctypes.c_bool
        cf.CFStringGetCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_long,
                                          ctypes.c_uint32]
        cf.CFRelease.argtypes = [ctypes.c_void_p]
        key = cf.CFStringCreateWithCString(None, b"config_toml_base64", utf8)
        app = cf.CFStringCreateWithCString(None, b"com.openai.codex", utf8)
        value = cf.CFPreferencesCopyAppValue(key, app)
        cf.CFRelease(key)
        cf.CFRelease(app)
    except (OSError, AttributeError, TypeError):
        return None
    if not value:
        return None
    try:
        if cf.CFGetTypeID(value) != cf.CFStringGetTypeID():
            raise ValueError("not a string")
        size = cf.CFStringGetLength(value) * 4 + 1
        buf = ctypes.create_string_buffer(size)
        if not cf.CFStringGetCString(value, buf, size, utf8):
            raise ValueError("unreadable string")
        encoded = buf.value.decode("utf-8").strip()
    finally:
        cf.CFRelease(value)
    try:
        return base64.b64decode(encoded, validate=True).decode("utf-8")
    except (ValueError, UnicodeDecodeError) as e:
        raise ValueError(str(e)) from None


def _mcp_name_taken(cwd, env):
    """Why our `-c` flags would clash with a config Codex will load, or None:
      - `mcp_servers.blave` exists: `-c` deep-merges into it, and a stdio entry plus our `url`
        makes Codex refuse to start the whole turn.
      - a layer BELOW `-c` (precedence 30) uses the legacy `exclude` / `include_only` arrays:
        our `filters` key displaces them (config/src/merge.rs displaced_fields), silently
        dropping the user's own env filtering for the turn.
      - a legacy managed layer ABOVE `-c` (/etc/codex/managed_config.toml at 40, macOS MDM
        config_toml_base64 at 50) sets `shell_environment_policy` at all: a legacy array there
        displaces OUR `filters` and the code reaches the agent's shell.
    cwd is the workspace, which the agent can write to. A config that exists but cannot be read
    or parsed counts as a clash — we cannot prove it is free.
    Layers read: user ($CODEX_HOME or ~/.codex), <cwd>/.codex, and the two legacy managed ones.
    Not read: system /etc/codex/config.toml, new-style MDM, the cloud bundle, the profile file,
    and ancestor `.codex/` dirs up to the project root — all BELOW `-c`, so a clash there only
    makes every mounted turn fail to start (dies at config load, no code leaks) or drops a
    legacy array as above. The desktop workspace has no `.git` above it, so the ancestor layers
    collapse to cwd, which is read. A managed requirement pinning shell_snapshot=true is caught
    by _snapshot_disabled, not here."""
    home = env.get("CODEX_HOME") or os.path.join(env.get("HOME") or os.path.expanduser("~"),
                                                 ".codex")
    docs = []  # (managed, parsed)
    for managed, path in ((False, os.path.join(home, "config.toml")),
                          (False, os.path.join(cwd, ".codex", "config.toml")),
                          (True, _MANAGED_CONFIG_PATH or os.path.join(home, "managed_config.toml"))):
        try:
            with open(path, "rb") as f:
                docs.append((managed, tomllib.load(f)))
        except FileNotFoundError:
            continue
        except (OSError, tomllib.TOMLDecodeError):
            return "a config.toml is unreadable"
    try:
        mdm = _mdm_config_toml()
        if mdm is not None:
            docs.append((True, tomllib.loads(mdm)))
    except (ValueError, tomllib.TOMLDecodeError):
        return "the MDM managed config is unreadable"
    for managed, doc in docs:
        servers = doc.get("mcp_servers")
        if isinstance(servers, dict) and "blave" in servers:
            return "mcp_servers.blave already exists in a config.toml"
        policy = doc.get("shell_environment_policy")
        if managed and policy is not None:
            return "a managed config sets shell_environment_policy"
        if isinstance(policy, dict) and ("exclude" in policy or "include_only" in policy):
            return "a config.toml uses legacy shell_environment_policy arrays"
    return None


def _snapshot_disabled(codex_bin, cwd, env):
    """True only when Codex itself reports shell_snapshot off under our flags, and
    shell_snapshot_v2 off or absent (0.146 has no such feature and prints no line for it).
    Managed requirements pin features over `-c` without an error (core/src/config/
    managed_features.rs normalize_candidate), and a renamed key would be ignored — both would
    leave the code in the agent's shell, so anything short of a positive "false" means do not
    attach."""
    try:
        out = subprocess.run([codex_bin, *_MCP_ENV_FLAGS[2:], "features", "list"],
                             capture_output=True, text=True, timeout=15, cwd=cwd,
                             env={k: v for k, v in env.items() if k != MCP_TOKEN_ENV}).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    state = {line.split()[0]: line.split()[-1] for line in (out or "").splitlines()
             if line.split()}
    return state.get("shell_snapshot") == "false" \
        and state.get("shell_snapshot_v2", "false") == "false"


def mcp_server(codex_bin, cwd, env):
    """The `blave` MCP URL to attach this turn, or None (= not attached, turn runs as usual —
    same posture as the Claude path when no code is available)."""
    url = env.get("BLAVE_MCP_URL")
    if not url or not env.get(MCP_TOKEN_ENV) or '"' in url or "\\" in url:
        return None
    version = codex_version(codex_bin)
    if not version or version < _MCP_MIN_VERSION:
        print("[codex] blave MCP not attached: codex "
              + (".".join(map(str, version)) if version else "version unknown")
              + " < " + ".".join(map(str, _MCP_MIN_VERSION)), file=sys.stderr)
        return None
    clash = _mcp_name_taken(cwd, env)
    if clash:
        print("[codex] blave MCP not attached: " + clash, file=sys.stderr)
        return None
    if not _snapshot_disabled(codex_bin, cwd, env):
        print("[codex] blave MCP not attached: shell_snapshot could not be turned off",
              file=sys.stderr)
        return None
    return url


def build_args(codex_bin, cwd, model=None, effort=None, mcp_url=None):
    """model / effort are forwarded only when the user picked them in the shell (which
    guarantees a slug from Codex's own catalog and an effort that model supports); absent,
    Codex uses the user's own defaults and the argv is unchanged. mcp_url comes from
    mcp_server(); the token itself is never an argument."""
    picked = []
    if model:
        picked += ["-m", model]
    if effort:
        picked += ["-c", f"model_reasoning_effort={effort}"]
    if mcp_url:
        # `-c` values are TOML, so strings carry their own quotes (spawn has no shell).
        picked += ["-c", f'mcp_servers.blave.url="{mcp_url}"',
                   "-c", f'mcp_servers.blave.bearer_token_env_var="{MCP_TOKEN_ENV}"',
                   *_MCP_ENV_FLAGS]
    return [
        codex_bin, "exec", "--json", "--ephemeral", "--skip-git-repo-check", *picked,
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
            # Same name shape as the Claude path, which agent_turn._tool_where reads.
            return [(f"mcp__{item['server']}__{item['tool']}"
                     if item.get("server") and item.get("tool") else item.get("tool") or "MCP",
                     {})]
        if kind == "web_search":
            return [("WebSearch", {"query": item.get("query") or ""})]
        if kind == "collab_tool_call":
            return [("Agent", {})]
        return []


async def run(codex_bin, prompt, cwd, env, sink, on_tool_start=None, on_tool_done=None,
              model=None, effort=None, mcp_url=None):
    """One Codex turn. Returns the translator (usage, thread_id); raises CodexTurnFailed
    when the turn did not complete, so the caller's existing fault path classifies it.
    mcp_url is the caller's mcp_server() result — the caller decides once so the prompt's
    MCP rule matches what is attached."""
    if not codex_bin:
        raise CodexTurnFailed("--engine codex needs --codex-bin")
    translator = CodexTranslator(sink, on_tool_start, on_tool_done)
    if not mcp_url:
        # Not attached this turn: the child gets neither the code nor the URL.
        env = {k: v for k, v in env.items() if k not in (MCP_TOKEN_ENV, "BLAVE_MCP_URL")}
    proc = await asyncio.create_subprocess_exec(
        *build_args(codex_bin, cwd, model, effort, mcp_url),
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
