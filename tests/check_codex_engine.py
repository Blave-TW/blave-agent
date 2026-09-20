"""Minimal check for the desktop shell's Codex engine path (runtime/codex_engine.py +
the `--engine codex` branch in runtime/agent_turn.py).

What it protects:
  1. Fleet zero-impact — a turn run WITHOUT --engine goes through sdk.query exactly as
     before and never even imports codex_engine. The whole cloud fleet runs this file.
  2. Event translation — a recorded `codex exec --json` stream (real capture, codex-cli
     0.155.0-alpha.9) comes out of LocalSink as the chunk sequence the shell renders:
     narration before a tool moves to `thinking`, tools pair running/done by id, the last
     tool-less message is the reply.
  2b. BLAVE_PYTHON (desktop only) — unset: neither engine's instructions change by a
     character; set: both engines carry the same interpreter rule.
  3. Failure goes through the EXISTING fault path (same four codes, same error chunk) —
     and a bare `error` event is not terminal, only `turn.failed` is (Codex source:
     exec/src/event_processor_with_jsonl_output.rs).

claude_agent_sdk is stubbed: this checks our branching, not the SDK.

Run: cd blave-agent && python3 tests/check_codex_engine.py
"""
import asyncio, contextlib, io, json, os, sys, tempfile, types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))

_tmp = tempfile.mkdtemp(prefix="check-codex-")
os.makedirs(os.path.join(_tmp, "ws", "state"))
os.environ.update({
    "BLAVE_AGENT_WORKSPACE": os.path.join(_tmp, "ws"),
    "BLAVE_AGENT_STATE": os.path.join(_tmp, "state"),
    "BLAVE_AGENT_DB": os.path.join(_tmp, "session.db"),
})
os.environ.pop("BLAVE_PROXY_TOKEN", None)

# ── SDK stub ────────────────────────────────────────────────────────────────
sdk = types.ModuleType("claude_agent_sdk")
sdk_calls = []


class _Obj:
    def __init__(self, **kw):
        self.__dict__.update(kw)


for _name in ("ClaudeAgentOptions", "AssistantMessage", "TextBlock", "ToolUseBlock",
              "ThinkingBlock", "ResultMessage"):
    setattr(sdk, _name, type(_name, (_Obj,), {}))


async def _fake_query(prompt, options):
    sdk_calls.append((prompt, options))
    yield sdk.AssistantMessage(content=[sdk.TextBlock(text="claude reply")])
    yield sdk.ResultMessage(total_cost_usd=0.0, num_turns=1, is_error=False)


sdk.query = _fake_query
sys.modules["claude_agent_sdk"] = sdk

import agent_turn as at  # noqa: E402


def run_local_turn(**kw):
    """One run_turn through a LocalSink; returns the @@BLAVE@@ chunks it printed."""
    out = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
        asyncio.run(at.run_turn("s1", "hello", "sonnet", at.LocalSink("s1"), **kw))
    chunks = [json.loads(line[len("@@BLAVE@@"):]) for line in out.getvalue().splitlines()
              if line.startswith("@@BLAVE@@")]
    # 策略清單的即時推送(工具結果之後,兩條引擎共用)不是這裡要釘的東西
    return [c for c in chunks if c["type"] != "strategies"]


def shape(chunks):
    return [(c["type"], c.get("tool"), c.get("status")) if c["type"] == "tool"
            else (c["type"],) for c in chunks]


# ── 1. 不帶 --engine:走 sdk.query,codex_engine 連 import 都不發生 ────────────
def main_args(*extra):
    """What main() hands run_turn for this command line (run_turn itself not executed)."""
    probe = {}
    real = asyncio.run
    asyncio.run = lambda coro: (probe.update(coro.cr_frame.f_locals), coro.close(), "")[2]
    sys.argv = ["agent_turn.py", "s1", "hello", "--delivery", "local", *extra]
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            at.main()
    finally:
        asyncio.run = real
    return probe


probe = main_args()
assert probe["engine"] == "claude" and probe["codex_bin"] is None, probe
assert probe["model"] == at.model_prefs.DEFAULT_MODEL and probe["effort"] is None, probe
assert main_args("--model", "haiku", "--effort", "low")["model"] == "haiku"
# codex:只有明確帶 --model 才算用戶選的;我們的預設(proxy 模型名)絕不可流進 `codex -m`
probe = main_args("--engine", "codex", "--codex-bin", "/x/codex")
assert probe["model"] is None and probe["effort"] is None, probe
probe = main_args("--engine", "codex", "--codex-bin", "/x/codex", "--model", "gpt-5.5",
                  "--effort", "low")
assert (probe["model"], probe["effort"]) == ("gpt-5.5", "low"), probe

chunks = run_local_turn()
assert len(sdk_calls) == 1, "預設引擎必須呼叫 sdk.query 一次"
assert "codex_engine" not in sys.modules, "機隊路徑不該載入 codex_engine"
assert sdk_calls[0][1].model == "sonnet"
assert "[Runtime 規則" not in sdk_calls[0][0], "Codex 的 prompt 前綴漏進 Claude 路徑"
assert shape(chunks) == [("text",), ("done",)], shape(chunks)
# 不帶 --effort:options 上連 effort 這個屬性都沒有;帶了只多這一個
base_options = dict(vars(sdk_calls[0][1]))
assert "effort" not in base_options
run_local_turn(effort="low")
with_effort = dict(vars(sdk_calls[1][1]))
assert with_effort.pop("effort") == "low" and with_effort == base_options
sdk_calls[:] = sdk_calls[:1]

# ── 2. 事件翻譯:真實錄到的 JSONL → chunk 序列 ─────────────────────────────
import codex_engine  # noqa: E402

FIXTURE = [
    {"type": "thread.started", "thread_id": "01a0b90d-0000"},
    {"type": "turn.started"},
    {"type": "item.completed", "item": {"id": "item_0", "type": "agent_message",
                                        "text": "I'll run the requested shell command..."}},
    {"type": "item.started", "item": {"id": "item_1", "type": "command_execution",
                                      "command": "/bin/zsh -lc 'python3 lib/runner.py strategies/rsi/strategy.py'",
                                      "aggregated_output": "", "exit_code": None,
                                      "status": "in_progress"}},
    {"type": "item.completed", "item": {"id": "item_1", "type": "command_execution",
                                        "command": "/bin/zsh -lc 'python3 lib/runner.py strategies/rsi/strategy.py'",
                                        "aggregated_output": "hi\n", "exit_code": 0,
                                        "status": "completed"}},
    {"type": "item.started", "item": {"id": "item_2", "type": "file_change", "changes": [
        {"path": os.path.join(_tmp, "ws", "strategies", "rsi", "strategy.py"),
         "kind": "add"}], "status": "in_progress"}},
    {"type": "item.completed", "item": {"id": "item_2", "type": "file_change", "changes": [
        {"path": os.path.join(_tmp, "ws", "strategies", "rsi", "strategy.py"),
         "kind": "add"}], "status": "completed"}},
    # 非終局:error 事件之後 Codex 還在跑(重連通知走這條)
    {"type": "error", "message": "stream disconnected before completion: retrying 1/5"},
    {"type": "item.completed", "item": {"id": "item_3", "type": "error",
                                        "message": "model rerouted: a -> b"}},
    {"type": "item.completed", "item": {"id": "item_4", "type": "reasoning",
                                        "text": "checking the result"}},
    {"type": "item.completed", "item": {"id": "item_5", "type": "agent_message",
                                        "text": "done"}},
    {"type": "turn.completed", "usage": {"input_tokens": 44882, "cached_input_tokens": 39168,
                                         "output_tokens": 120, "reasoning_output_tokens": 0}},
]


def fake_codex(events, captured):
    async def _run(codex_bin, prompt, cwd, env, sink, on_tool_start=None, on_tool_done=None,
                   model=None, effort=None):
        captured.update(bin=codex_bin, prompt=prompt, cwd=cwd, env=env, model=model,
                        effort=effort)
        tr = codex_engine.CodexTranslator(sink, on_tool_start, on_tool_done)
        for event in events:
            tr.feed(event)
        if tr.failure or not tr.completed:
            msg = tr.failure or tr.last_error or "codex exited"
            raise codex_engine.CodexTurnFailed(msg, codex_engine._upstream_status(msg))
        return tr
    return _run


real_run = codex_engine.run
seen = {}
codex_engine.run = fake_codex(FIXTURE, seen)
sdk_calls.clear()
chunks = run_local_turn(engine="codex", codex_bin="/x/codex")
assert not sdk_calls, "--engine codex 不該碰 Claude SDK"
assert shape(chunks) == [
    ("text",), ("thinking",), ("tool", "Bash", "running"), ("tool", "Bash", "done"),
    ("tool", "Write", "running"), ("tool", "Write", "done"),
    ("thinking",), ("text",), ("done",),
], shape(chunks)
assert chunks[1]["text"].startswith("I'll run"), "工具前的話要收回活動列"
assert chunks[2]["summary"] == "lib/runner.py strategies/rsi/strategy.py", chunks[2]
assert chunks[2]["id"] == chunks[3]["id"] and chunks[3]["error"] is False
assert chunks[4]["summary"] == "strategies/rsi/strategy.py", chunks[4]
assert chunks[7]["text"] == "done"
# 同一份 prompt:Codex 拿到的是 Claude 那份 + 規則前綴;AGENTS.md 不內嵌(Codex 自己讀)。
# 第 1 節那輪已寫進歷史,所以比的是結構而不是全文。
assert seen["prompt"].startswith("[Runtime 規則") and "[使用者這次的訊息]\nhello" in seen["prompt"]
assert at.WEB_FORMATTING_RULE in seen["prompt"]
assert "ANTHROPIC_API_KEY" not in seen["env"] or os.environ.get("ANTHROPIC_API_KEY")
assert seen["env"]["BLAVE_AGENT_DB"] == os.environ["BLAVE_AGENT_DB"]
assert seen["bin"] == "/x/codex" and seen["cwd"] == at.WORKSPACE
# run_turn 原樣轉發它拿到的 model / effort;「沒帶就是 None」由 main() 保證(第 1 節)
assert seen["model"] == "sonnet" and seen["effort"] is None, seen

# 寫回 session 的方式相同:user + assistant 各一列,assistant 是回覆本文
_, recent = at.ss.get_context("s1")
assert recent[-2:] == [("user", "hello"), ("assistant", "done")], recent[-2:]

# ── 3. 失敗走既有兜底 ───────────────────────────────────────────────────────
codex_engine.run = fake_codex(FIXTURE[:2] + [
    {"type": "error", "message": "unexpected status 503 Service Unavailable: x"},
    {"type": "turn.failed", "error": {"message": "unexpected status 503 Service Unavailable: x"}},
], {})
chunks = run_local_turn(engine="codex", codex_bin="/x/codex")
assert chunks[-1]["type"] == "error" and chunks[-1]["code"] == at.FAULT_NOT_STARTED_UPSTREAM, chunks

codex_engine.run = fake_codex(FIXTURE[:5] + [
    {"type": "turn.failed", "error": {"message": "turn failed"}}], {})
chunks = run_local_turn(engine="codex", codex_bin="/x/codex")
assert chunks[-1]["code"] == at.FAULT_PARTIAL, chunks
_, recent = at.ss.get_context("s1")
assert "[中斷前已執行:Bash lib/runner.py" in recent[-1][1], "收據摘要要進歷史"

codex_engine.run = real_run
chunks = run_local_turn(engine="codex", codex_bin=os.path.join(_tmp, "no-such-codex"))
assert chunks[-1]["code"] == at.FAULT_NOT_STARTED, chunks

# ── 4. 命令列:沙盒可寫+有網路、AGENTS.md 不被 32 KiB 截斷、prompt 走 stdin ───
#      沒選 model / effort 時 argv 逐字釘死;選了只多出那兩組
BASE_ARGV = ["/x/codex", "exec", "--json", "--ephemeral", "--skip-git-repo-check",
             "-s", "workspace-write", "-c", "sandbox_workspace_write.network_access=true",
             "-c", "project_doc_max_bytes=262144", "-C", "/ws", "-"]
assert codex_engine.build_args("/x/codex", "/ws") == BASE_ARGV
picked = codex_engine.build_args("/x/codex", "/ws", model="gpt-5.5", effort="low")
assert picked == BASE_ARGV[:5] + ["-m", "gpt-5.5", "-c", "model_reasoning_effort=low"] \
    + BASE_ARGV[5:], picked

# ── 5. BLAVE_PYTHON:沒設 → 兩條路徑一個字都不加;有設 → 兩條路徑都帶同一條規則 ──
with open(os.path.join(at.WORKSPACE, "AGENTS.md"), "w") as f:
    f.write("# rules\n")
sysprompts = []
_real_write = at._write_system_prompt_file
at._write_system_prompt_file = lambda text: (sysprompts.append(text), _real_write(text))[1]
seen = {}
codex_engine.run = fake_codex(FIXTURE, seen)

os.environ.pop("BLAVE_PYTHON", None)
assert at.python_rule() == ""
run_local_turn()
run_local_turn(engine="codex", codex_bin="/x/codex")
assert sysprompts[-1] == "# rules\n" + at.model_catalog_rule("s1") + at.preferences_rule() \
    + at.WEB_FORMATTING_RULE, "沒設 BLAVE_PYTHON 時 system prompt 必須與原本逐字相同"
assert "Python 直譯器" not in seen["prompt"]

os.environ["BLAVE_PYTHON"] = "/v/bin/python"
run_local_turn()
run_local_turn(engine="codex", codex_bin="/x/codex")
rule = at.python_rule()
assert "/v/bin/python strategies/" in rule
assert rule in sysprompts[-1] and rule in seen["prompt"], "兩條引擎都要帶到"
assert sysprompts[-1].endswith(at.WEB_FORMATTING_RULE), "建議規則必須維持在最尾端"
assert len(sysprompts) == 2, "codex 路徑不該寫 system prompt 檔"
os.environ.pop("BLAVE_PYTHON")

# BLAVE_DATA_ACCESS: unset (fleet) = not a byte; "1"/"0" reach both engines and differ.
os.environ.pop("BLAVE_DATA_ACCESS", None)
assert at.data_access_rule() == ""
os.environ["BLAVE_DATA_ACCESS"] = "bogus"
assert at.data_access_rule() == "", "an unknown value must not invent a rule"
rules = {}
for flag in ("1", "0"):
    os.environ["BLAVE_DATA_ACCESS"] = flag
    run_local_turn()
    run_local_turn(engine="codex", codex_bin="/x/codex")
    rules[flag] = at.data_access_rule()
    assert rules[flag] in sysprompts[-1] and rules[flag] in seen["prompt"], "both engines"
    assert sysprompts[-1].endswith(at.WEB_FORMATTING_RULE)
assert "BLAVE_KLINE_SOURCE=binance" in rules["1"] and "403" in rules["1"]
assert "Invalid API key" in rules["1"] and "sign in" in rules["1"]
assert "NO Blave data access" in rules["0"] and "no SSH" in rules["0"]
assert "card trial" in rules["0"] and "cloud machine" in rules["0"] and "ONCE" in rules["0"]
assert "own agent" not in rules["0"] and "TWD" not in rules["0"], "0 also covers signed-in-but-no-data; no prices"
assert "credentials" not in rules["0"].split("Never look")[0], "0 must not claim a key exists"
os.environ.pop("BLAVE_DATA_ACCESS")
at._write_system_prompt_file = _real_write
codex_engine.run = real_run

print("OK check_codex_engine")
