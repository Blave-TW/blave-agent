#!/bin/bash
# Watchdog wrapper — restarts reconciler.py on crash and sends Telegram alert.
# Usage: cd $BLAVE_AGENT_HOME/workspace && bash manager/start_reconciler.sh
# (when unset, $BLAVE_AGENT_HOME's default is runtime-dependent — /root/.openclaw on old
# BlaveClaw machines, /opt/blave-agent on Blave Agent machines; resolve it per
# references/deployment.md. The script itself locates the workspace from its own path,
# so only the caller's cd needs the resolved value.)

# A resident process is never part of an agent turn: drop the turn's variables a tmux / nohup start from
# inside a turn would hand it, or lib/guard would hold the turn order lock for its whole life (and refuse
# its own orders while another turn holds it).
# The test hang switch (manager/reconciler.py TEST_HANG_ENV) never comes from inside a turn.
if [ -n "${BLAVE_TURN_INTERRUPT_FILE}${BLAVE_TURN_PID}" ]; then unset BLAVE_TEST_HANG_BEFORE_SEND; fi
unset BLAVE_TURN_INTERRUPT_FILE BLAVE_TURN_PID
WORKSPACE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$WORKSPACE"

notify() {
    python3 - "$1" <<'EOF'
import sys, json, os
sys.path.insert(0, '.')
from lib.notify import make_sender
from lib.portfolio import load_portfolio_config
cfg  = load_portfolio_config()
msgs = cfg.get('messages', {})
text = sys.argv[1]
send = make_sender()
send(text)
EOF
}

get_msg() {
    # get_msg <key> <default> [format_args...]
    python3 - "$1" "$2" "$3" <<'EOF'
import sys, json
sys.path.insert(0, '.')
from lib.portfolio import load_portfolio_config
cfg  = load_portfolio_config()
msgs = cfg.get('messages', {})
key, default, arg = sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else ''
tpl  = msgs.get(key, default)
print(tpl.format(code=arg) if arg else tpl)
EOF
}

# The runtime's hang watch (runtime/hang_watch.py) killed it and wrote this record first: the
# next reconciler sends the one notice for that, so no "System restarted" on top. A record older
# than 15 minutes (= manager/reconciler HANG_RECORD_FRESH_S) is a failed respawn's: alert as usual.
hang_kill_recent() {
    python3 - <<'EOF'
import json, sys, time
try:
    with open('state/execution/hang_kill.json') as f:
        at = json.load(f).get('at')
except Exception:
    sys.exit(1)
sys.exit(0 if isinstance(at, (int, float)) and 0 <= time.time() - at <= 900 else 1)
EOF
}

notify "$(get_msg watchdog_started '✅ Auto-trading started')"

while true; do
    python3 manager/reconciler.py
    EXIT_CODE=$?
    if [ "$EXIT_CODE" -eq 75 ]; then
        # reconciler.py DUPLICATE_EXIT: another reconciler already runs here
        echo "another reconciler is running — retrying in 10s"
        sleep 10
        continue
    fi
    MSG="$(get_msg watchdog_restart '⚠️ System restarted (code {code}), resuming in 10s' "$EXIT_CODE")"
    echo "$MSG"
    if hang_kill_recent; then
        echo "killed by the hang watch — the next reconciler sends the notice"
    else
        notify "$MSG"
    fi
    sleep 10
done
