"""The `blave` MCP approval flag must take effect in a REAL `codex exec`, not just sit in argv.

A misspelled `-c` key parses fine and is silently ignored (checked: `default_tool_approval_mode`),
so an argv-only assertion cannot catch the failure this guards against. This drives the exact
argv from codex_engine.build_args through the installed Codex binary, against a local fake model
(Responses API) that calls the tool and a local fake MCP server shaped like
api/mcp_byoa/server.py (no tool annotations). No OpenAI login, no network beyond 127.0.0.1.

  1. build_args argv as shipped → the call reaches the MCP server (`tools/call`) and completes.
  2. same argv minus the approval flag → denied before sending (the 2026-09-23 bug).
  3. another MCP server in the same turn → still denied: the approval is scoped to `blave`.

Skips (exit 0, prints SKIP) when no codex binary is found; set CODEX_BIN to point at one.
Run: cd blave-agent && python3 tests/check_codex_mcp_live.py
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))
import codex_engine  # noqa: E402

APPROVE = 'mcp_servers.blave.default_tools_approval_mode="approve"'
codex = os.environ.get("CODEX_BIN") or shutil.which("codex") \
    or "/Applications/ChatGPT.app/Contents/Resources/codex"
if not os.access(codex, os.X_OK):
    print("SKIP  no codex binary (set CODEX_BIN)")
    sys.exit(0)

calls = []            # MCP methods the fake server received
target = {"ns": ""}   # namespace the fake model calls the tool in


class Model(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)))
        answered = any(i.get("type") == "function_call_output"
                       for i in body.get("input") or [] if isinstance(i, dict))
        # Codex exposes MCP tools as a `namespace` tool (mcp__<server>) holding plain functions.
        item = ({"type": "message", "id": "m", "role": "assistant",
                 "content": [{"type": "output_text", "text": "done"}]} if answered else
                {"type": "function_call", "id": "f", "call_id": "c1", "name": "get_ssh_access",
                 "namespace": target["ns"], "arguments": "{}"})
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        usage = {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2,
                 "input_tokens_details": {"cached_tokens": 0},
                 "output_tokens_details": {"reasoning_tokens": 0}}
        for ev in ({"type": "response.created", "response": {"id": "r"}},
                   {"type": "response.output_item.done", "item": item},
                   {"type": "response.completed", "response": {"id": "r", "usage": usage}}):
            self.wfile.write(("event: %s\ndata: %s\n\n" % (ev["type"], json.dumps(ev))).encode())


class Mcp(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        self.send_response(405)
        self.end_headers()

    def do_POST(self):
        msg = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)))
        calls.append(msg.get("method"))
        if "id" not in msg:
            self.send_response(202)
            self.end_headers()
            return
        result = {
            "initialize": {"protocolVersion": (msg.get("params") or {}).get("protocolVersion"),
                           "capabilities": {"tools": {}}, "serverInfo": {"name": "f", "version": "0"}},
            "tools/list": {"tools": [{"name": "get_ssh_access", "description": "ssh cert",
                                      "inputSchema": {"type": "object", "properties": {}}}]},
            "tools/call": {"content": [{"type": "text", "text": "ok"}], "isError": False},
        }.get(msg.get("method"), {})
        data = json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": result}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def serve(handler):
    srv = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv.server_address[1]


model_port, mcp_port = serve(Model), serve(Mcp)
mcp_url = "http://127.0.0.1:%d/mcp" % mcp_port
tmp = tempfile.mkdtemp(prefix="check-codex-mcp-")
os.makedirs(os.path.join(tmp, "ws"))
os.makedirs(os.path.join(tmp, "home"))
PROVIDER = ["-c", 'model_provider="fake"', "-c", 'model_providers.fake.name="fake"',
            "-c", 'model_providers.fake.base_url="http://127.0.0.1:%d/v1"' % model_port,
            "-c", 'model_providers.fake.wire_api="responses"']


def turn(ns, drop_approval=False, extra=()):
    """One real codex turn → (status of the mcp_tool_call item, MCP methods received)."""
    del calls[:]
    target["ns"] = ns
    argv = codex_engine.build_args(codex, os.path.join(tmp, "ws"), model="fake-model",
                                   mcp_url=mcp_url)
    if drop_approval:
        i = argv.index(APPROVE)
        argv = argv[:i - 1] + argv[i + 1:]
    argv = argv[:5] + PROVIDER + list(extra) + argv[5:]
    env = {"PATH": os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", ""),
           "CODEX_HOME": os.path.join(tmp, "home"), codex_engine.MCP_TOKEN_ENV: "blv_fake"}
    out = subprocess.run(argv, input="go", capture_output=True, text=True, env=env,
                         timeout=180).stdout
    status = None
    for line in out.splitlines():
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        item = ev.get("item") or {}
        if ev.get("type") == "item.completed" and item.get("type") == "mcp_tool_call":
            status = (item.get("status"), (item.get("error") or {}).get("message"))
    return status, list(calls)


red = 0
# 「被擋」要是因為核准才算數:別的原因(server 掛了、工具名錯)讓呼叫失敗,②③ 也會過,證明不了核准的範圍
_DENIED = ("requires approval", "user cancelled mcp tool call")


def denied(s):
    return bool(s) and s[0] == "failed" and any(k in (s[1] or "").lower() for k in _DENIED)


def t(name, ok, detail):
    global red
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok else "  → %r" % (detail,)))
    red += 0 if ok else 1


assert APPROVE in codex_engine.build_args(codex, "/ws", mcp_url=mcp_url)
print("codex:", subprocess.run([codex, "--version"], capture_output=True, text=True).stdout.strip())
s, c = turn("mcp__blave")
t("as shipped: the blave tool call reaches the server and completes",
  s and s[0] == "completed" and "tools/call" in c, (s, c))
s, c = turn("mcp__blave", drop_approval=True)
t("without the approval flag: denied before sending (the bug this fixes)",
  denied(s) and "tools/call" not in c, (s, c))
s, c = turn("mcp__other", extra=["-c", 'mcp_servers.other.url="%s"' % mcp_url])
t("another MCP server in the same turn is still denied (approval scoped to blave)",
  denied(s) and "tools/call" not in c, (s, c))
shutil.rmtree(tmp)
print("ALL PASS" if not red else "%d 紅" % red)
sys.exit(1 if red else 0)
