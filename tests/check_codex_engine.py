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
                   model=None, effort=None, mcp_url=None):
        captured.update(bin=codex_bin, prompt=prompt, cwd=cwd, env=env, model=model,
                        effort=effort, mcp_url=mcp_url)
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
# 釘錯誤碼、不釘句子:那一段的文字歸 check_data_access_lang.py 管(它也擋已經作廢的 DATA_NOT_INCLUDED)
assert "Invalid API key" in rules["1"] and "ERR005" in rules["1"] and "ERR007" in rules["1"]
# 那一段改成「只給約束、不給成品句」之後(check_data_access_lang.py 鎖細節),這裡只確認兩台引擎都拿得到同一段
assert "no Blave data access this turn" in rules["0"] and "no SSH" in rules["0"]
assert "card trial" in rules["0"] and "cloud machine" in rules["0"] and "once per conversation" in rules["0"]
assert at.DATA_ACCESS_CARD == "<blave-card:data-access/>" and at.DATA_ACCESS_CARD in rules["0"]
_prose = rules["0"].replace(at.DATA_ACCESS_CARD, "")
assert "buttons" not in _prose and "a card" not in _prose, "0 must not leak what the app renders"
assert "or any button, card" in _prose, "the only mention is the prohibition itself"
assert "blave-card" not in rules["1"] and "blave.org" not in rules["0"]
_sink = at.LocalSink("s1")
_sent = []
_sink._send = _sent.append
_sink.on_text("No Blave data here.\n" + at.DATA_ACCESS_CARD + "\n<suggest>\nRun it on klines\n</suggest>")
assert _sink.finalize().endswith(at.DATA_ACCESS_CARD), "the sink must carry the marker verbatim"
assert any(c.get("type") == "text_replace" and c["text"].endswith(at.DATA_ACCESS_CARD) for c in _sent)
assert "own agent" not in rules["0"] and "TWD" not in rules["0"], "0 also covers signed-in-but-no-data; no prices"
assert "credentials" not in rules["0"].split("Never look")[0], "0 must not claim a key exists"
os.environ.pop("BLAVE_DATA_ACCESS")
at._write_system_prompt_file = _real_write
codex_engine.run = real_run

# ── 6. `blave` MCP(電腦版 Codex):碼只走環境變數、argv 只有 url 與變數名;撞名 / 舊版 / 沒碼 → 不掛 ──
import shutil, stat  # noqa: E402

MCP_URL = "https://mcp.blave.org/mcp"
CODE = "blv_" + "a" * 40
# 後兩組是 S1:Codex 預設把整份 env 給 agent 的 shell;filters 只拔接入碼,shell_snapshot 不關的話 filters 無效(0.155 實測)
MCP_FLAGS = ["-c", 'mcp_servers.blave.url="%s"' % MCP_URL,
             "-c", 'mcp_servers.blave.bearer_token_env_var="BLAVE_MCP_TOKEN"',
             "-c", 'shell_environment_policy.filters.BLAVE_MCP_TOKEN="exclude"',
             "-c", "features.shell_snapshot=false", "-c", "features.shell_snapshot_v2=false"]
assert codex_engine.MCP_TOKEN_ENV == "BLAVE_MCP_TOKEN"
argv = codex_engine.build_args("/x/codex", "/ws", mcp_url=MCP_URL)
assert argv == BASE_ARGV[:5] + MCP_FLAGS + BASE_ARGV[5:], argv
assert "blv_" not in " ".join(argv)
assert "ignore_default_excludes" not in " ".join(argv), "BLAVE_WEB_REPORT_TOKEN(聊天圖鏡射)要留著"
assert codex_engine.build_args("/x/codex", "/ws") == BASE_ARGV, "沒掛時 argv 逐字不變"


def fake_codex_bin(name, version, pinned=None, has_v2=True):
    """A `codex` that answers --version and `features list` — each snapshot feature reads off
    only when asked via -c, unless `pinned` like a managed requirement; v2 reads on otherwise
    (a user who enabled it); 0.146 prints no v2 line at all (has_v2=False). The probe's env is
    dumped next to the binary. A turn dumps argv + env + stdin to $FAKE_OUT, then completes."""
    p = os.path.join(_tmp, name)

    def line(key):
        if pinned == key:
            return 'echo "%s stable true"' % key
        return ('case " $* " in *" features.%s=false "*) echo "%s stable false";; '
                '*) echo "%s stable true";; esac' % (key, key, key))
    snap = 'env > "$0.probe_env"; ' + line("shell_snapshot") \
        + ("; " + line("shell_snapshot_v2") if has_v2 else "")
    with open(p, "w") as f:
        f.write("#!/bin/sh\n"
                'if [ "$1" = "--version" ]; then echo "codex-cli %s"; exit 0; fi\n'
                'case " $* " in *" features list "*) %s; exit 0;; esac\n'
                'printf "%%s\\n" "$@" > "$FAKE_OUT/argv"\n'
                'env > "$FAKE_OUT/env"\n'
                'cat > "$FAKE_OUT/stdin"\n'
                "echo '{\"type\":\"thread.started\",\"thread_id\":\"t\"}'\n"
                "echo '{\"type\":\"item.completed\",\"item\":{\"id\":\"i\",\"type\":\"agent_message\",\"text\":\"ok\"}}'\n"
                "echo '{\"type\":\"turn.completed\",\"usage\":{}}'\n" % (version, snap))
    os.chmod(p, os.stat(p).st_mode | stat.S_IXUSR)
    return p


new_codex = fake_codex_bin("codex-new", "0.155.0-alpha.9.2")
old_codex = fake_codex_bin("codex-old", "0.145.9")
pinned_codex = fake_codex_bin("codex-pinned", "0.155.1", pinned="shell_snapshot")
assert codex_engine.codex_version(new_codex) == (0, 155, 0)
assert codex_engine.codex_version(old_codex) == (0, 145, 9)
assert codex_engine.codex_version(os.path.join(_tmp, "no-such-codex")) is None

codex_home = os.path.join(_tmp, "codex-home")
os.makedirs(codex_home)
ws_codex_cfg = os.path.join(at.WORKSPACE, ".codex", "config.toml")
home_codex_cfg = os.path.join(codex_home, "config.toml")
os.makedirs(os.path.dirname(ws_codex_cfg))
base_env = {"CODEX_HOME": codex_home, "BLAVE_MCP_URL": MCP_URL, "BLAVE_MCP_TOKEN": CODE}
ms = codex_engine.mcp_server
codex_engine._MANAGED_CONFIG_PATH = os.path.join(_tmp, "managed_config.toml")  # 不讀本機 /etc
_real_mdm = codex_engine._mdm_config_toml
codex_engine._mdm_config_toml = lambda: None
assert ms(new_codex, at.WORKSPACE, base_env) == MCP_URL
assert "BLAVE_MCP_TOKEN" not in open(new_codex + ".probe_env").read(), "features list 探測不帶碼"
assert "CODEX_HOME=" + codex_home in open(new_codex + ".probe_env").read(), "探測拿的是這一輪的 env"
assert ms(old_codex, at.WORKSPACE, base_env) is None, "< 0.146.0(沒有 filters)不掛"
assert ms(fake_codex_bin("codex-146", "0.146.0", has_v2=False), at.WORKSPACE, base_env) == MCP_URL, \
    "0.146.0 是下限;它沒有 shell_snapshot_v2 那一行也要掛"
assert ms(pinned_codex, at.WORKSPACE, base_env) is None, "shell_snapshot 被釘住關不掉 → 不掛"
assert ms(fake_codex_bin("codex-pinned-v2", "0.155.1", pinned="shell_snapshot_v2"), at.WORKSPACE,
          base_env) is None, "shell_snapshot_v2 被釘住 → 不掛"
assert ms(os.path.join(_tmp, "no-such-codex"), at.WORKSPACE, base_env) is None
assert ms(new_codex, at.WORKSPACE, {**base_env, "BLAVE_MCP_TOKEN": ""}) is None, "沒碼不掛"
assert ms(new_codex, at.WORKSPACE, {k: v for k, v in base_env.items() if k != "BLAVE_MCP_URL"}) is None
assert ms(new_codex, at.WORKSPACE, {**base_env, "BLAVE_MCP_URL": 'https://x/"a'}) is None, "TOML 字串不可注入"
# 撞名:用戶全域 config.toml、workspace 的 .codex/config.toml,兩種 TOML 寫法都認;別的名字不算撞
for cfg, body in ((home_codex_cfg, '[mcp_servers.blave]\ncommand = "npx"\n'),
                  (ws_codex_cfg, '[mcp_servers]\nblave = { command = "npx" }\n'),
                  (home_codex_cfg, "this is = not toml [\n"),
                  # 舊寫法陣列會被我們的 filters 整個頂掉(merge.rs displaced_fields)= 用戶自己的過濾無聲失效
                  (home_codex_cfg, '[shell_environment_policy]\nexclude = ["AWS_*"]\n'),
                  (ws_codex_cfg, '[shell_environment_policy]\ninclude_only = ["PATH"]\n')):
    with open(cfg, "w") as f:
        f.write(body)
    assert ms(new_codex, at.WORKSPACE, base_env) is None, cfg
    os.remove(cfg)
with open(home_codex_cfg, "w") as f:
    f.write('[mcp_servers.other]\ncommand = "npx"\n')
assert ms(new_codex, at.WORKSPACE, base_env) == MCP_URL
os.remove(home_codex_cfg)
# 受管層在 -c 之上(managed_config.toml 40、MDM 50):那裡的舊寫法陣列會反過來頂掉我們的 filters → 碼進 shell。
# 所以受管層只要碰 shell_environment_policy 就不掛;讀到但解析不了也不掛。
for body in ('[shell_environment_policy]\ninherit = "all"\n', "not = toml [\n"):
    with open(codex_engine._MANAGED_CONFIG_PATH, "w") as f:
        f.write(body)
    assert ms(new_codex, at.WORKSPACE, base_env) is None, body
with open(codex_engine._MANAGED_CONFIG_PATH, "w") as f:
    f.write('model = "x"\n')
assert ms(new_codex, at.WORKSPACE, base_env) == MCP_URL, "受管層沒碰 policy 照掛"
os.remove(codex_engine._MANAGED_CONFIG_PATH)


def _mdm_bad():
    raise ValueError("not base64")


for mdm in (lambda: '[shell_environment_policy]\nexclude = ["X"]\n', _mdm_bad):
    codex_engine._mdm_config_toml = mdm
    assert ms(new_codex, at.WORKSPACE, base_env) is None, "MDM 碰 policy 或讀到壞值 → 不掛"
codex_engine._mdm_config_toml = lambda: 'model = "x"\n'
assert ms(new_codex, at.WORKSPACE, base_env) == MCP_URL
codex_engine._mdm_config_toml = _real_mdm
assert _real_mdm() is None or isinstance(_real_mdm(), str), "真的 CFPreferences 路徑跑得起來"
codex_engine._mdm_config_toml = lambda: None

# 整條 run():codex 子行程真的拿到那兩個 -c 與環境變數;碼不在 argv。撞名那一輪:argv 沒有 -c、環境也沒有碼。
fake_out = os.path.join(_tmp, "fake-out")
os.makedirs(fake_out)
os.environ.update({**base_env, "FAKE_OUT": fake_out})


def spawned():
    argv = open(os.path.join(fake_out, "argv")).read().splitlines()
    env = dict(line.split("=", 1) for line in open(os.path.join(fake_out, "env")).read().splitlines()
               if "=" in line)
    return argv, env


mcp_cfg_dir = tempfile.mkdtemp()  # workspace 以外(local_mcp_config 的條件)
MCP_CFG = os.path.join(mcp_cfg_dir, "turn.json")
open(MCP_CFG, "w").close()
run_local_turn(engine="codex", codex_bin=new_codex)
argv, env = spawned()
assert not any("mcp_servers" in a for a in argv) and "BLAVE_MCP_TOKEN" not in env, "沒 --mcp-config 不掛"

chunks = run_local_turn(engine="codex", codex_bin=new_codex, mcp_config=MCP_CFG)
assert chunks[-1]["type"] == "done", chunks
argv, env = spawned()
assert argv[:4] == ["exec", "--json", "--ephemeral", "--skip-git-repo-check"] and argv[-1] == "-"
assert all(flag in argv for flag in MCP_FLAGS), argv
assert "blv_" not in "\n".join(argv), "碼絕不進 argv"
assert env.get("BLAVE_MCP_TOKEN") == CODE and env.get("BLAVE_MCP_URL") == MCP_URL
stdin = open(os.path.join(fake_out, "stdin")).read()
assert at.mcp_rule(True).strip() in stdin, "掛了就要帶圍籬規則(沒圍籬的 Codex 不能上雲端機)"
run_local_turn(engine="codex", codex_bin=new_codex, mcp_config=MCP_CFG, viewing_env="cloud")
assert at._viewing_env_segment(True) in open(os.path.join(fake_out, "stdin")).read(), "雲端視角提示段跟著真的掛上"

with open(ws_codex_cfg, "w") as f:
    f.write('[mcp_servers.blave]\ncommand = "npx"\n')
chunks = run_local_turn(engine="codex", codex_bin=new_codex, mcp_config=MCP_CFG)
assert chunks[-1]["type"] == "done", "撞名不擋回合"
argv, env = spawned()
assert not any("mcp_servers" in a for a in argv), argv
assert "BLAVE_MCP_TOKEN" not in env and "BLAVE_MCP_URL" not in env, "不掛就不給子行程碼"
assert "Blave MCP (this turn)" not in open(os.path.join(fake_out, "stdin")).read(), "沒掛不帶規則"
run_local_turn(engine="codex", codex_bin=new_codex, mcp_config=MCP_CFG, viewing_env="cloud")
assert at._viewing_env_segment(False) in open(os.path.join(fake_out, "stdin")).read(), "沒掛就講連不上"
os.remove(ws_codex_cfg)

chunks = run_local_turn(engine="codex", codex_bin=old_codex, mcp_config=MCP_CFG)
assert chunks[-1]["type"] == "done"
argv, env = spawned()
assert not any("mcp_servers" in a for a in argv) and "BLAVE_MCP_TOKEN" not in env, "舊版不掛"
chunks = run_local_turn(engine="codex", codex_bin=pinned_codex, mcp_config=MCP_CFG)
argv, env = spawned()
assert not any("mcp_servers" in a for a in argv) and "BLAVE_MCP_TOKEN" not in env, "snapshot 釘住不掛"
for k in base_env:
    os.environ.pop(k)
os.environ.pop("FAKE_OUT")

# Codex 的 mcp_tool_call 組成 Claude 同形的名字,_tool_where 才分得出雲端那一步(A′ 收據分色)
_mcp_item = {"type": "mcp_tool_call", "server": "blave", "tool": "get_ssh_access", "status": "completed"}
assert codex_engine.CodexTranslator._tool_calls(_mcp_item) == [("mcp__blave__get_ssh_access", {})]
assert at._tool_where("mcp__blave__get_ssh_access", {}) == "cloud"
shutil.rmtree(mcp_cfg_dir)

print("OK check_codex_engine")
