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
"""
import json
import os

PATH = os.environ.get("BLAVE_AGENT_MODEL_PREFS", "/opt/blave-agent/state/model_prefs.json")

DEFAULT_MODEL = "deepseek/deepseek-v4-pro"


def get(session_id, default=DEFAULT_MODEL):
    try:
        with open(PATH) as f:
            prefs = json.load(f)
    except (FileNotFoundError, ValueError):
        return default
    return prefs.get(session_id, default)


def set(session_id, model_id):
    try:
        with open(PATH) as f:
            prefs = json.load(f)
    except (FileNotFoundError, ValueError):
        prefs = {}
    prefs[session_id] = model_id
    os.makedirs(os.path.dirname(PATH), exist_ok=True)
    with open(PATH, "w") as f:
        json.dump(prefs, f, indent=2)
