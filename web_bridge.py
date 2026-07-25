"""
Web bridge: the website-chat counterpart to telegram_bridge.py. Long-polls the
Blave web-chat transport (api/openclaw/webchat.py) for messages the website
queued for this machine, and spawns one agent_turn.py per message with web
delivery (chunks POSTed back to /report, browser reads them over SSE).

Same trust model as the LLM proxy: this machine authenticates with its own
proxy-{ttyd_password} (BLAVE_PROXY_TOKEN), which the transport resolves to this
user's id — so /poll only ever yields this user's messages.

agent_turn.py is resolved relative to THIS file so a version deploy (symlink
swap, see updater.py) picks up the matching agent_turn.py on the next spawn.
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

import model_prefs
import strategy_reporter

BASE = "/opt/blave-agent"
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))

API_BASE = os.environ.get("BLAVE_CHAT_API_BASE", "https://api.blave.org/openclaw/chat")
POLL_URL = f"{API_BASE}/poll"
REPORT_URL = f"{API_BASE}/report"
PROXY_TOKEN = os.environ.get("BLAVE_PROXY_TOKEN", "")

AGENT_TURN_SCRIPT = os.environ.get("BLAVE_AGENT_TURN_SCRIPT", f"{_THIS_DIR}/agent_turn.py")
PYTHON_BIN = os.environ.get("BLAVE_AGENT_PYTHON", f"{BASE}/venv/bin/python3")
HEARTBEAT_PATH = os.environ.get("BLAVE_AGENT_WEB_HEARTBEAT", f"{BASE}/state/web_heartbeat")


def poll_once():
    """One long-poll (blocks up to ~25s server-side). Returns the message list."""
    req = urllib.request.Request(POLL_URL, headers={"x-api-key": f"proxy-{PROXY_TOKEN}"})
    with urllib.request.urlopen(req, timeout=35) as resp:
        return json.loads(resp.read()).get("messages", [])


def sync_strategies():
    """Right after a turn (which is when the agent may have created/deployed a
    strategy), push the fresh list two ways: a live chunk on the chat stream so
    the open workspace updates the left rail instantly, and the cache so a page
    reload is fresh too. The timer (strategy_reporter) is only a slow fallback."""
    try:
        strategies = strategy_reporter.scan()
    except Exception as e:
        print(f"[web_bridge] strategy scan failed: {e}", file=sys.stderr)
        return
    # live: goes through the SSE stream the browser already has open
    chunk = json.dumps({"type": "strategies", "strategies": strategies}).encode()
    req = urllib.request.Request(
        REPORT_URL, data=chunk,
        headers={"Content-Type": "application/json", "x-api-key": f"proxy-{PROXY_TOKEN}"},
    )
    try:
        urllib.request.urlopen(req, timeout=15).read()
    except Exception as e:
        print(f"[web_bridge] strategies chunk push failed: {e}", file=sys.stderr)
    # cache: for the next page load / reload
    try:
        strategy_reporter.report_cache(strategies, token=PROXY_TOKEN)
    except Exception as e:
        print(f"[web_bridge] strategies cache update failed: {e}", file=sys.stderr)


def run_agent_turn(session_id, message, viewing_strategy=None, viewing_tab=None):
    model = model_prefs.get(session_id)
    cmd = [
        PYTHON_BIN, AGENT_TURN_SCRIPT,
        f"--model={model}",
        "--delivery=web",
        f"--report-url={REPORT_URL}",
        # report token (== proxy token) is read from the inherited BLAVE_PROXY_TOKEN
        # env, not passed on argv (argv is visible in `ps`).
    ]
    if viewing_strategy:
        cmd.append(f"--viewing-strategy={viewing_strategy}")
    if viewing_tab in ("code", "data"):
        cmd.append(f"--viewing-tab={viewing_tab}")
    # `--` terminates options so a message starting with '-' (or literally '--help')
    # is taken as the positional arg, not parsed as a flag (which would silently
    # print help + exit 0 and the user would get nothing back).
    cmd += ["--", session_id, message]
    try:
        result = subprocess.run(cmd, timeout=600)
    except subprocess.TimeoutExpired:
        print("[web_bridge] agent_turn timed out", file=sys.stderr)
        return False
    if result.returncode != 0:
        print(f"[web_bridge] agent_turn failed (exit {result.returncode})", file=sys.stderr)
        return False
    return True


def touch_heartbeat():
    os.makedirs(os.path.dirname(HEARTBEAT_PATH), exist_ok=True)
    with open(HEARTBEAT_PATH, "w") as f:
        f.write(str(time.time()))


def main():
    if not PROXY_TOKEN:
        print("[web_bridge] BLAVE_PROXY_TOKEN not set; exiting", file=sys.stderr)
        sys.exit(1)
    print("[web_bridge] starting poll loop", file=sys.stderr)
    while True:
        touch_heartbeat()
        try:
            messages = poll_once()
        except Exception as e:
            print(f"[web_bridge] poll error: {e}", file=sys.stderr)
            time.sleep(5)
            continue
        for m in messages:
            if m.get("type") != "user_message":
                continue
            session_id = m.get("session_id") or ""
            content = m.get("content") or ""
            if not session_id or not content:
                continue
            ctx = m.get("context") if isinstance(m.get("context"), dict) else {}
            viewing_strategy = ctx.get("viewing_strategy")
            viewing_tab = ctx.get("viewing_tab")
            run_agent_turn(session_id, content, viewing_strategy=viewing_strategy,
                           viewing_tab=viewing_tab)
            # A turn may have created/deployed/removed a strategy — push the
            # fresh list live (and refresh the cache) right away.
            sync_strategies()


if __name__ == "__main__":
    main()
