"""
Per-session model preference. Lets the agent switch its own model from
inside a chat by running set_model.py (see MODEL_CATALOG_RULE in
agent_turn.py), instead of hunting for a settings file that doesn't exist in
this runtime (the failure mode this replaces: agent burned its whole
max_turns budget searching for a way to persist "switch to sonnet").

Since every turn is a fresh spawn, a switch decided mid-turn can't change
that turn's already-running model — it's read by telegram_bridge.py before
the NEXT spawn. Single flat JSON file keyed by session_id; low write volume
(only on an explicit switch request), so no locking needed.

The preference is meant to be the user's, not the conversation's: a web
session without its own entry inherits the machine's most recent explicit
choice (LAST_KEY, written by every set), so a new conversation does not
silently fall back to the default model (spec-c §3.4).
"""
import json
import os

PATH = os.environ.get("BLAVE_AGENT_MODEL_PREFS", "/opt/blave-agent/state/model_prefs.json")

DEFAULT_MODEL = "deepseek/deepseek-v4-pro"

VISION_MODEL = "anthropic/claude-sonnet-5"
_IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".gif", ".webp")
LAST_KEY = "_last"  # not a session id (those are web-…/chat ids), so it cannot collide


def get(session_id, default=DEFAULT_MODEL):
    try:
        with open(PATH) as f:
            prefs = json.load(f)
    except (FileNotFoundError, ValueError):
        return default
    return prefs.get(session_id) or prefs.get(LAST_KEY) or default


def resolve(session_id, attachment_name=None):
    """get() 外再加一層單輪覆寫:附件是圖片且目前偏好是 deepseek 系列時,這一輪
    改用 Claude——DeepSeek 的 Anthropic 相容端點官方文件明列不支援 image block,
    圖片會被靜默丟棄,模型根本看不到。只影響這一輪,不改寫偏好;用戶已自選
    anthropic 模型就照舊。"""
    model = get(session_id)
    if (
        attachment_name
        and attachment_name.lower().endswith(_IMAGE_EXTS)
        and model.startswith("deepseek/")
    ):
        return VISION_MODEL
    return model


def set(session_id, model_id):
    try:
        with open(PATH) as f:
            prefs = json.load(f)
    except (FileNotFoundError, ValueError):
        prefs = {}
    prefs[session_id] = model_id
    prefs[LAST_KEY] = model_id
    os.makedirs(os.path.dirname(PATH), exist_ok=True)
    with open(PATH, "w") as f:
        json.dump(prefs, f, indent=2)
