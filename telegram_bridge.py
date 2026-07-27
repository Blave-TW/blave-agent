"""
Telegram bridge, spec item 2: minimal stateless long-polling listener.
Spawns one agent_turn.py subprocess per incoming message. Processing is
sequential (poll -> handle -> reply -> poll again), which for a POC also
gives "one turn per chat at a time" for free. A production version would
want to dispatch turns without blocking the poll loop (e.g. one worker
thread per chat) rather than serializing every user behind each other.

Delivery to Telegram (including streaming updates) happens inside
agent_turn.py itself, not here — only that process has the incremental
content as it's generated. This bridge only sends a fallback message if the
subprocess fails before agent_turn.py could deliver anything on its own
(e.g. it never even started).

Pairing is simulated for this POC: bot token + allowed chat id are dropped
directly into config/telegram.json rather than delivered via the (not yet
built) website form.
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

import model_prefs

BASE = "/opt/blave-agent"
# agent_turn.py is resolved relative to THIS file, not a fixed /opt/blave-agent
# path — that's what makes "each spawn picks up whatever version is currently
# symlinked" work: this process itself runs from /opt/blave-agent/current/,
# so its sibling agent_turn.py is automatically the matching version.
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.environ.get("BLAVE_AGENT_TG_CONFIG", f"{BASE}/config/telegram.json")
HEARTBEAT_PATH = os.environ.get("BLAVE_AGENT_HEARTBEAT", f"{BASE}/state/heartbeat")
AGENT_TURN_SCRIPT = os.environ.get("BLAVE_AGENT_TURN_SCRIPT", f"{_THIS_DIR}/agent_turn.py")
PYTHON_BIN = os.environ.get("BLAVE_AGENT_PYTHON", f"{BASE}/venv/bin/python3")
SYNC_SCRIPT = os.environ.get("BLAVE_SYNC_NOTIFY", f"{BASE}/sync_notify_compat.py")
# The offset marks "already-seen" updates to Telegram. Keeping it in memory
# only means every restart (crash, health-check restart, a version deploy —
# see updater.py) forgets it, so Telegram redelivers whatever was in flight
# and the same message gets reprocessed. Persisting it to disk fixes that —
# traded for the rarer failure mode of losing a turn if the process crashes
# mid-processing (before ever replying), which is far less confusing than
# reprocessing the same message on every restart.
OFFSET_PATH = os.environ.get("BLAVE_AGENT_TG_OFFSET", f"{BASE}/state/tg_offset")


def load_offset():
    try:
        with open(OFFSET_PATH) as f:
            return int(f.read().strip())
    except (FileNotFoundError, ValueError):
        return None


def save_offset(offset):
    os.makedirs(os.path.dirname(OFFSET_PATH), exist_ok=True)
    with open(OFFSET_PATH, "w") as f:
        f.write(str(offset))


def load_config():
    """Returns {} when unpaired (no file yet) instead of crashing — a fresh
    machine has no telegram.json until the pairing poller writes one."""
    try:
        with open(CONFIG_PATH) as f:
            return json.load(f)
    except (FileNotFoundError, ValueError):
        return {}


def save_config(config):
    os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
    with open(CONFIG_PATH, "w") as f:
        json.dump(config, f, indent=2)


def tg_api(token, method, params=None, timeout=35):
    url = f"https://api.telegram.org/bot{token}/{method}"
    data = json.dumps(params).encode() if params else None
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def send_message(token, chat_id, text):
    tg_api(token, "sendMessage", {"chat_id": chat_id, "text": text})


def run_agent_turn(token, chat_id, session_id, message):
    """Runs agent_turn.py, which delivers (and streams) its own reply to
    Telegram directly. Returns True if the subprocess ran to completion
    (regardless of whether the turn itself succeeded — agent_turn.py
    handles its own error messaging), False if it never got that far.

    Deliberately does NOT capture_output — inheriting the parent's stdout/
    stderr means agent_turn.py's logging (including its own diagnostics)
    streams straight into journalctl in real time. capture_output swallows
    everything into a string that only gets printed on failure, which made
    every successful turn's logging invisible — a real observability gap,
    not just an inconvenience during debugging."""
    model = model_prefs.get(session_id)
    try:
        result = subprocess.run(
            [
                PYTHON_BIN, AGENT_TURN_SCRIPT,
                f"--model={model}",
                f"--telegram-chat-id={chat_id}",
                # `--` so a message starting with '-' (or '--help') is the positional
                # arg, not parsed as a flag.
                "--", session_id, message,
            ],
            # bot token via env, not argv (argv is visible in `ps`).
            env={**os.environ, "BLAVE_TELEGRAM_TOKEN": token},
            timeout=600,
        )
    except subprocess.TimeoutExpired:
        print("[telegram_bridge] agent_turn timed out", file=sys.stderr)
        return False

    if result.returncode != 0:
        print(f"[telegram_bridge] agent_turn failed (exit {result.returncode}) — see its own output above", file=sys.stderr)
        return False
    return True


def touch_heartbeat():
    os.makedirs(os.path.dirname(HEARTBEAT_PATH), exist_ok=True)
    with open(HEARTBEAT_PATH, "w") as f:
        f.write(str(time.time()))


def main():
    offset = load_offset()

    version = "unknown"
    try:
        with open(f"{_THIS_DIR}/VERSION") as f:
            version = f.read().strip()
    except FileNotFoundError:
        pass
    print(f"[telegram_bridge] starting poll loop (version={version})", file=sys.stderr)

    idle_logged = False
    drained_backlog = False
    while True:
        touch_heartbeat()

        # Re-read config every loop so a token written post-boot by the pairing
        # poller (telegram_pairing.py) is picked up without a restart, and a
        # re-pair with a new token takes effect on the next iteration.
        config = load_config()
        token = config.get("bot_token")
        allowed_chat_id = config.get("allowed_chat_id")

        if not token:
            # Unpaired: sit quietly (don't crash-loop, don't hammer Telegram)
            # until the user connects a bot token via the website.
            if not idle_logged:
                print("[telegram_bridge] no bot token yet — idle, waiting for pairing", file=sys.stderr)
                idle_logged = True
            time.sleep(10)
            continue
        idle_logged = False

        # First time we hold a token while still UNPAIRED: drop the bot's STALE
        # backlog (older than 2 min) so auto-pair can't bind to a stranger —
        # getUpdates replays ~24h, so a pre-existing / group bot would otherwise
        # pair to whoever spoke before the user did. RECENT messages are kept:
        # the linking user's own first message routinely arrives BEFORE the token
        # does (pairing poller lag ≤15s), and a blanket drain kept eating it,
        # forcing a confusing re-send. Old = stranger risk; recent = almost
        # certainly the user who just linked.
        if allowed_chat_id is None and not drained_backlog:
            try:
                cutoff = time.time() - 120
                for _ in range(10):  # backlog paginates ~100/call
                    params = {"timeout": 0}
                    if offset is not None:
                        params["offset"] = offset
                    batch = tg_api(token, "getUpdates", params, timeout=15).get("result", [])
                    if not batch:
                        break
                    hit_recent = False
                    for u in batch:
                        # non-message updates have no date → count as stale
                        if (u.get("message") or {}).get("date", 0) >= cutoff:
                            hit_recent = True
                            break
                        offset = u["update_id"] + 1
                    if hit_recent:
                        break
                if offset is not None:
                    save_offset(offset)
                print("[telegram_bridge] dropped stale pre-pair backlog", file=sys.stderr)
            except Exception as e:
                print(f"[telegram_bridge] backlog drain failed: {e}", file=sys.stderr)
            drained_backlog = True

        try:
            params = {"timeout": 30}
            if offset is not None:
                params["offset"] = offset
            resp = tg_api(token, "getUpdates", params, timeout=35)
        except Exception as e:
            print(f"[telegram_bridge] poll error: {e}", file=sys.stderr)
            time.sleep(5)
            continue

        for update in resp.get("result", []):
            offset = update["update_id"] + 1
            save_offset(offset)
            msg = update.get("message")
            if not msg or "text" not in msg:
                continue
            chat_id = msg["chat"]["id"]
            # Auto-pair: the first chat to message this bot becomes the allowed
            # one (same convention as openclaw — the user just sends a message
            # to their bot). Persist it so it survives restarts.
            if allowed_chat_id is None:
                allowed_chat_id = chat_id
                config["allowed_chat_id"] = chat_id
                save_config(config)
                print(f"[telegram_bridge] auto-paired chat_id={chat_id}", file=sys.stderr)
                # let lib/notify.py's compat allowFrom pick up the new chat_id
                # (so strategy scripts can send Telegram notifications)
                try:
                    subprocess.run([PYTHON_BIN, SYNC_SCRIPT], check=False, timeout=30)
                except Exception as e:
                    print(f"[telegram_bridge] sync_notify_compat failed: {e}", file=sys.stderr)
            if chat_id != allowed_chat_id:
                print(f"[telegram_bridge] ignoring unpaired chat_id={chat_id}", file=sys.stderr)
                continue
            delivered = run_agent_turn(token, chat_id, str(chat_id), msg["text"])
            if not delivered:
                send_message(token, chat_id, "（agent 出錯，稍後再試）")


if __name__ == "__main__":
    main()
