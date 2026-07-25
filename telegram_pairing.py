"""
Telegram pairing poller: fetches this machine's bot token from the backend
(GET /openclaw/agent/telegram/config, auth = proxy token) and writes it into
config/telegram.json so telegram_bridge (which re-reads config each loop) can
start polling — no restart needed. Runs on a timer; the user connects TG via
the website form rarely, so a periodic check is enough.

The chat_id isn't set here — telegram_bridge auto-adopts it from the user's
first message. This poller only delivers the bot token.
"""
import json
import os
import subprocess
import sys
import urllib.request

BASE = "/opt/blave-agent"
CONFIG_PATH = os.environ.get("BLAVE_AGENT_TG_CONFIG", f"{BASE}/config/telegram.json")
API_URL = os.environ.get(
    "BLAVE_TG_CONFIG_URL", "https://api.blave.org/openclaw/agent/telegram/config"
)
PROXY_TOKEN = os.environ.get("BLAVE_PROXY_TOKEN", "")
PYTHON_BIN = os.environ.get("BLAVE_AGENT_PYTHON", f"{BASE}/venv/bin/python3")
SYNC_SCRIPT = os.environ.get("BLAVE_SYNC_NOTIFY", f"{BASE}/sync_notify_compat.py")


def fetch_token():
    req = urllib.request.Request(API_URL, headers={"x-api-key": f"proxy-{PROXY_TOKEN}"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read()).get("bot_token")


def load_config():
    try:
        with open(CONFIG_PATH) as f:
            return json.load(f)
    except (FileNotFoundError, ValueError):
        return {}


def save_config(config):
    os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
    # bot token is a secret — owner-only, never briefly world-readable
    fd = os.open(CONFIG_PATH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(config, f, indent=2)
    os.chmod(CONFIG_PATH, 0o600)


def main():
    if not PROXY_TOKEN:
        print("[telegram_pairing] BLAVE_PROXY_TOKEN not set; exiting", file=sys.stderr)
        sys.exit(1)

    # Check locally FIRST: once we have a bot token (paired), stop polling the
    # backend entirely — the timer keeps firing but this is just a file check,
    # no network. Only an unpaired machine actually hits the config endpoint.
    # (Trade-off: a later re-pair to a different bot isn't auto-picked-up; rare,
    # handle separately if ever needed.)
    config = load_config()
    if config.get("bot_token"):
        return

    try:
        token = fetch_token()
    except Exception as e:
        print(f"[telegram_pairing] fetch failed: {e}", file=sys.stderr)
        sys.exit(1)

    if not token:
        return  # not connected yet — nothing to do

    config["bot_token"] = token
    # a new/changed bot means a fresh pairing — drop the old chat_id so the
    # bridge re-adopts it from the first incoming message on the new bot.
    config.pop("allowed_chat_id", None)
    save_config(config)
    print("[telegram_pairing] wrote new bot token to config", file=sys.stderr)

    # keep lib/notify.py's compat files (openclaw.json botToken) in sync
    try:
        subprocess.run([PYTHON_BIN, SYNC_SCRIPT], check=False, timeout=30)
    except Exception as e:
        print(f"[telegram_pairing] sync_notify_compat failed: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
