"""
Bash-tool entry point: the agent calls this itself to switch its own model
for future turns (see MODEL_CATALOG_RULE in agent_turn.py). Applies from the
NEXT message onward — the current turn already started with its resolved
model and can't retroactively change it.

Usage: python3 set_model.py <session_id> <model_id>
"""
import sys

import model_prefs


def main():
    session_id, model_id = sys.argv[1], sys.argv[2]
    model_prefs.set(session_id, model_id)
    print(f"[set_model] session {session_id} -> {model_id} (applies next message)")


if __name__ == "__main__":
    main()
