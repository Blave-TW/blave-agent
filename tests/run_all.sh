#!/bin/bash
# 跑 tests/ 底下的 check_*.py 與 check_*.js,不起 Electron。排程與彙總在 tests/_run_all.py。
#
# 跑法(任何目錄):
#   tests/run_all.sh                 # 全部,4 條並行
#   tests/run_all.sh -P 8            # 8 條(機器空的時候);-P 1 = 一支接一支
#   tests/run_all.sh shell_ report   # 檔名含任一片段的
#   PYTHON=/path/to/python tests/run_all.sh   # 預設 repo 的 .venv,沒有就 python3
#   BLAVE_TEST_JOBS=8 tests/run_all.sh        # 同 -P
#   BLAVE_TEST_TIMEOUT=900 tests/run_all.sh   # 每支的逾時秒數,預設 600
set -u
REPO=$(cd "$(dirname "$0")/.." && pwd)
PY=${PYTHON:-$REPO/.venv/bin/python}
[ -x "$PY" ] || PY=python3
echo "直譯器:$PY($("$PY" -c 'import sys; print(sys.executable)'))"
exec "$PY" "$REPO/tests/_run_all.py" "$@"
