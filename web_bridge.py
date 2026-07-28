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
import signal
import subprocess
import sys
import time
import urllib.request

import model_prefs
import strategy_reporter

BASE = "/opt/blave-agent"
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))

API_BASE = os.environ.get("BLAVE_CHAT_API_BASE", "https://api.blave.org/openclaw/chat")
# lease=1: delivered messages stay recoverable server-side until we ACK at spawn —
# without it, a message claimed right before a release swap killed this process was
# gone forever (user watched「思考中」until the watchdog gave up; 07-28 實踩).
POLL_URL = f"{API_BASE}/poll?lease=1"
ACK_URL = f"{API_BASE}/ack"
REPORT_URL = f"{API_BASE}/report"
PROXY_TOKEN = os.environ.get("BLAVE_PROXY_TOKEN", "")

AGENT_TURN_SCRIPT = os.environ.get("BLAVE_AGENT_TURN_SCRIPT", f"{_THIS_DIR}/agent_turn.py")
PYTHON_BIN = os.environ.get("BLAVE_AGENT_PYTHON", f"{BASE}/venv/bin/python3")
HEARTBEAT_PATH = os.environ.get("BLAVE_AGENT_WEB_HEARTBEAT", f"{BASE}/state/web_heartbeat")

# 目前正在處理的 session(SIGTERM handler 要知道該通知誰)
_current_session = {"id": None}

# 一輪的硬上限。參數掃描是網格搜尋(每組都回測),600s 常常不夠——真正的煞車
# 是 agent_turn 自己的 max_budget_usd/max_turns,這裡只防永久卡死。
TURN_TIMEOUT = 1800
# 掃描期間 agent 跑一條長 bash,中間完全不會有 chunk;前端看門狗會誤判成
# 「機器死了」。每分鐘送一個 ping 讓它知道還活著(前端只用來重置計時,不顯示)。
PING_INTERVAL = 60


def poll_once():
    """One long-poll (blocks up to ~25s server-side). Returns the message list."""
    req = urllib.request.Request(POLL_URL, headers={"x-api-key": f"proxy-{PROXY_TOKEN}"})
    with urllib.request.urlopen(req, timeout=35) as resp:
        return json.loads(resp.read()).get("messages", [])


def ack_message(message_id):
    """Confirm we're processing this message — the server drops its recovery lease.
    Called at spawn time, NOT turn end: a mid-turn death must not replay a half-
    executed message. Best-effort: on failure we process anyway (worst case the
    lease expires and the message redelivers once — visible, unlike a lost one)."""
    if not message_id:
        return
    try:
        req = urllib.request.Request(
            ACK_URL, data=json.dumps({"message_ids": [message_id]}).encode(),
            headers={"Content-Type": "application/json",
                     "x-api-key": f"proxy-{PROXY_TOKEN}"},
        )
        urllib.request.urlopen(req, timeout=10).read()
    except Exception as e:
        print(f"[web_bridge] ack failed for {message_id}: {e}", file=sys.stderr)


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
    # 順序重要:先寫快取(含圖)、再推 live chunk。瀏覽器收到 chunk 後幾秒會
    # refetch 快取補圖——倒過來的話 refetch 會跟快取寫入競速,輸了圖就不出現
    # (實測撲空過)。
    # cache: WITH images(這條走 8000 端點,沒有串流的 2MB 上限)。回合中產生
    # 的圖表因此在回合結束當下就進快取,不用等 2 分鐘的 timer。
    try:
        sigs = strategy_reporter.attach_images(strategies)
        strategy_reporter.report_cache(strategies, token=PROXY_TOKEN)
        strategy_reporter.save_image_sigs(sigs)
    except Exception as e:
        print(f"[web_bridge] strategies cache update failed: {e}", file=sys.stderr)
    # live: goes through the SSE stream the browser already has open.
    # 圖不上串流(2MB 上限)——attach 已就地加了 images,推 chunk 前剝掉。
    chunk_strategies = [{k: v for k, v in s.items() if k != "images"} for s in strategies]
    chunk = json.dumps({"type": "strategies", "strategies": chunk_strategies}).encode()
    req = urllib.request.Request(
        REPORT_URL, data=chunk,
        headers={"Content-Type": "application/json", "x-api-key": f"proxy-{PROXY_TOKEN}"},
    )
    try:
        urllib.request.urlopen(req, timeout=15).read()
    except Exception as e:
        print(f"[web_bridge] strategies chunk push failed: {e}", file=sys.stderr)


def _post_chunk(chunk, log=False):
    """Best-effort POST of one chunk to the web-chat transport."""
    try:
        req = urllib.request.Request(
            REPORT_URL, data=json.dumps(chunk).encode(),
            headers={"Content-Type": "application/json",
                     "x-api-key": f"proxy-{PROXY_TOKEN}"},
        )
        body = urllib.request.urlopen(req, timeout=5).read()
        if log:
            print(f"[web_bridge] chunk {chunk['type']} → {body[:60]}", file=sys.stderr)
    except Exception as e:
        if log:
            print(f"[web_bridge] chunk {chunk['type']} FAILED: {e}", file=sys.stderr)


def report_turn_aborted(session_id, message=None):
    """Tell the browser the in-flight turn died, so the UI stops spinning. Called
    on SIGTERM (systemd stop/restart — e.g. a release swap) and on the turn
    timeout; without it the user just watches 「思考中」forever with no reply
    and no error."""
    _post_chunk({"type": "error", "session_id": session_id,
                 "message": message or "這輪處理被中斷了（機器剛更新或重啟），請再問一次。"},
                log=True)
    _post_chunk({"type": "done", "session_id": session_id}, log=True)


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
    _current_session["id"] = session_id
    proc = subprocess.Popen(cmd)
    deadline = time.time() + TURN_TIMEOUT
    next_ping = time.time() + PING_INTERVAL
    try:
        while proc.poll() is None:
            time.sleep(1)
            now = time.time()
            if now >= next_ping:
                _post_chunk({"type": "ping", "session_id": session_id})
                next_ping = now + PING_INTERVAL
            if now >= deadline:
                print(f"[web_bridge] agent_turn exceeded {TURN_TIMEOUT}s — killing",
                      file=sys.stderr)
                proc.kill()
                proc.wait(timeout=10)
                report_turn_aborted(
                    session_id,
                    "這輪跑太久被中止了（超過 30 分鐘）。可以把任務拆小一點再試，"
                    "例如縮小掃描範圍或減少參數組合。",
                )
                return False
    finally:
        _current_session["id"] = None
    if proc.returncode != 0:
        print(f"[web_bridge] agent_turn failed (exit {proc.returncode})", file=sys.stderr)
        return False
    return True


def touch_heartbeat():
    os.makedirs(os.path.dirname(HEARTBEAT_PATH), exist_ok=True)
    with open(HEARTBEAT_PATH, "w") as f:
        f.write(str(time.time()))


def on_term(signum=None, frame=None):
    """systemd stop/restart (release swap, reboot…) while a turn is running:
    tell the browser before we go, or it spins on 「思考中」forever."""
    sid = _current_session.get("id")
    if sid:
        print(f"[web_bridge] SIGTERM mid-turn ({sid}) — telling the browser",
              file=sys.stderr)
        report_turn_aborted(sid)
    sys.exit(0)


def main():
    if not PROXY_TOKEN:
        print("[web_bridge] BLAVE_PROXY_TOKEN not set; exiting", file=sys.stderr)
        sys.exit(1)

    signal.signal(signal.SIGTERM, on_term)
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
                ack_message(m.get("message_id"))  # discarding — release the lease
                continue
            session_id = m.get("session_id") or ""
            content = m.get("content") or ""
            if not session_id or not content:
                ack_message(m.get("message_id"))  # discarding — release the lease
                continue
            # 開工即確認:從這裡開始的失敗由 mid-turn 機制(SIGTERM 補報)負責,
            # 租約只救「領走但還沒開工」的窗口。
            ack_message(m.get("message_id"))
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
