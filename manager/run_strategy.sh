#!/bin/bash
# Wraps a strategy's cron run so a crash — including an import-time crash,
# before strategy.py ever reaches lib/runner.py — always reaches the user via
# Telegram. Cron alone silently swallows non-zero exits; this is the only
# layer that can catch a failure the Python side never got a chance to.
#
# Usage (in crontab): cd $BLAVE_AGENT_HOME/workspace && bash manager/run_strategy.sh <strategy_name>
# (when unset, $BLAVE_AGENT_HOME's default is runtime-dependent — /root/.openclaw on old
# BlaveClaw machines, /opt/blave-agent on Blave Agent machines; resolve it per
# references/deployment.md. The script itself locates the workspace from its own path,
# so only the cron entry's cd needs the resolved value.)
set -uo pipefail

STRATEGY_NAME="${1:?usage: run_strategy.sh <strategy_name>}"
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

mkdir -p "strategies/$STRATEGY_NAME"

# Machine restarted and the user has not pressed 啟動下單 (lib/guard.RESTART_STOP_PATH):
# every order would be refused anyway, and a run that dies on the refusal would
# page the user as "strategy crashed". Skip quietly; the heartbeat is NOT
# touched (it means "ran successfully") — manager/healthcheck.py holds its
# stale-run alarm while the file exists instead.
if [ -f state/reconciler_stopped.json ]; then
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) skipped: machine restarted — auto-trading stays stopped until 啟動下單" \
        >> "strategies/$STRATEGY_NAME/strategy.log"
    exit 0
fi

OUTPUT=$(python3 "strategies/$STRATEGY_NAME/strategy.py" 2>&1)
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
    echo "$OUTPUT" >> "strategies/$STRATEGY_NAME/strategy.log"
    python3 manager/alert_failure.py "$STRATEGY_NAME" "$EXIT_CODE" "$OUTPUT"
else
    # heartbeat for manager/healthcheck.py — "no fresh heartbeat" means the
    # schedule itself stopped firing (crashes are alert_failure.py's job)
    mkdir -p state/heartbeat
    touch "state/heartbeat/$STRATEGY_NAME"
fi

exit $EXIT_CODE
