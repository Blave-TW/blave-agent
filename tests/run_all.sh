#!/bin/bash
# 跑 tests/ 底下的 check_*.py 與 check_*.js,不起 Electron(BLAVE_TEST_WINDOW 會被清掉)。
#
# 整次執行共用一個全新的 TMPDIR,結束(含 Ctrl-C)時整個刪掉。很多測試用
# tempfile / os.tmpdir() 建了目錄沒收;在這一層收,比逐支補 finally 可靠,新測試也自動涵蓋。
# 自己組 env、沒帶 TMPDIR 給子行程的測試,子行程會落到 /tmp,這層收不到。
#
# 跑法(任何目錄):
#   tests/run_all.sh                 # 全部
#   tests/run_all.sh shell_ report   # 檔名含任一片段的
#   PYTHON=/path/to/python tests/run_all.sh   # 預設 repo 的 .venv,沒有就 python3
set -u
REPO=$(cd "$(dirname "$0")/.." && pwd)
PY=${PYTHON:-$REPO/.venv/bin/python}
[ -x "$PY" ] || PY=python3
TIMEOUT=600

RUN_TMP=$(mktemp -d "${TMPDIR:-/tmp}/blave-tests.XXXXXX") || exit 1
# 相對路徑的 TMPDIR 在下面 cd 之後會指到別處:先轉成絕對路徑再掛 trap
RUN_TMP=$(cd "$RUN_TMP" && pwd -P) || exit 1
trap 'rm -rf "$RUN_TMP"' EXIT
trap 'exit 130' INT TERM
export TMPDIR=$RUN_TMP
unset BLAVE_TEST_WINDOW

cd "$REPO" || exit 1
shopt -s nullglob
pass=0
failed=()
for f in tests/check_*.py tests/check_*.js; do
  n=$(basename "$f")
  if [ $# -gt 0 ]; then
    hit=0
    for w in "$@"; do case "$n" in *"$w"*) hit=1 ;; esac; done
    [ $hit = 1 ] || continue
  fi
  case "$n" in
    *.py) cmd=("$PY" "$f") ;;
    *) cmd=(node "$f") ;;
  esac
  # 寫檔而不是 $(...):測試留下的背景子行程若還握著 stdout,管線會等到它結束
  if perl -e 'alarm shift; exec @ARGV' "$TIMEOUT" "${cmd[@]}" > "$RUN_TMP/.out" 2>&1; then
    echo "PASS $n"
    pass=$((pass + 1))
  else
    echo "FAIL $n"
    tail -25 "$RUN_TMP/.out" | sed 's/^/    /'
    failed+=("$n")
  fi
done

echo
echo "$pass 綠 / ${#failed[@]} 紅"
[ ${#failed[@]} -eq 0 ] || { echo "紅:${failed[*]}"; exit 1; }
