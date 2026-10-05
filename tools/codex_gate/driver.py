"""One desktop Codex turn through the real runtime, with the raw Codex events kept.

Spawned by gate.py once per run, with the env the desktop shell gives agent_turn.py
(shell/main.js runTurn + childEnv) already set. Goes through agent_turn.run_turn with
engine="codex" and a LocalSink, so the prompt prefix (_codex_prompt), turn_env and argv
(codex_engine.build_args) are the shipped ones; only the Claude SDK is stubbed, because the
Codex path never calls it.

Usage: python driver.py <runtime_dir> <out_dir> <codex_bin>   (message on stdin)
Writes into out_dir: argv.json, prompt.txt, events.jsonl, chunks.jsonl, reply.txt, result.json.
"""
import asyncio
import contextlib
import io
import json
import os
import sys
import traceback
import types


def _stub_sdk():
    sdk = types.ModuleType("claude_agent_sdk")

    class _Obj:
        def __init__(self, **kw):
            self.__dict__.update(kw)

    for name in ("ClaudeAgentOptions", "AssistantMessage", "TextBlock", "ToolUseBlock",
                 "ThinkingBlock", "ResultMessage", "HookMatcher"):
        setattr(sdk, name, type(name, (_Obj,), {}))

    async def _no_query(prompt, options):
        raise RuntimeError("codex gate: the Claude SDK path must not run")
        yield  # pragma: no cover

    sdk.query = _no_query
    sys.modules["claude_agent_sdk"] = sdk


def main():
    runtime_dir, out_dir, codex_bin = sys.argv[1:4]
    message = sys.stdin.buffer.read().decode("utf-8")
    sys.path.insert(0, runtime_dir)
    _stub_sdk()

    import codex_engine  # agent_turn's lazy `import codex_engine` gets this same module object

    events = open(os.path.join(out_dir, "events.jsonl"), "w", encoding="utf-8")
    feed, build_args = codex_engine.CodexTranslator.feed, codex_engine.build_args

    def tee_feed(self, event):
        events.write(json.dumps(event, ensure_ascii=False) + "\n")
        events.flush()
        return feed(self, event)

    def record_args(*a, **kw):
        argv = build_args(*a, **kw)
        with open(os.path.join(out_dir, "argv.json"), "w", encoding="utf-8") as f:
            json.dump(argv, f, ensure_ascii=False, indent=1)
        fake = os.environ.get("CODEX_GATE_FAKE_SCRIPT")
        # Windows cannot exec a .py or .cmd directly, so the stand-in rides on this interpreter.
        return [sys.executable, fake, *argv[1:]] if fake else argv

    run = codex_engine.run

    async def save_prompt(codex_bin, prompt, *a, **kw):
        with open(os.path.join(out_dir, "prompt.txt"), "w", encoding="utf-8") as f:
            f.write(prompt)
        return await run(codex_bin, prompt, *a, **kw)

    codex_engine.run = save_prompt
    codex_engine.CodexTranslator.feed = tee_feed
    codex_engine.build_args = record_args

    import agent_turn as at

    result = {"ok": False}
    stdout = io.StringIO()
    try:
        with contextlib.redirect_stdout(stdout):
            reply = asyncio.run(at.run_turn("codex-gate", message, None, at.LocalSink("codex-gate"),
                                            engine="codex", codex_bin=codex_bin))
        result["ok"] = True
    except BaseException:  # the turn's own fault path normally catches; this is for crashes
        reply = ""
        result["error"] = traceback.format_exc()
    finally:
        events.close()
    with open(os.path.join(out_dir, "reply.txt"), "w", encoding="utf-8") as f:
        f.write(reply or "")
    with open(os.path.join(out_dir, "chunks.jsonl"), "w", encoding="utf-8") as f:
        for line in stdout.getvalue().splitlines():
            if line.startswith("@@BLAVE@@"):
                f.write(line[len("@@BLAVE@@"):] + "\n")
    with open(os.path.join(out_dir, "result.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
