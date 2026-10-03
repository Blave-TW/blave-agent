"""一支策略同時只跑一個回測(2026-10-03:agent 在前一輪 nohup 了回測,回合結束後忘了它還在跑)。

鎖:
  ① 另一個程序握著鎖時第二個回測拒絕,訊息帶持有者的 PID 與開始時間;
  ② 持有者死掉(OS 鎖跟著放)後,留下的 .backtest.json 不擋下一次;
  ③ chart 的暫存目錄每個寫入者一個,掃除只收舊的。

跑法:cd blave-agent && python3 tests/check_backtest_run_lock.py
"""
import os, shutil, subprocess, sys, tempfile, time
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from lib import runner  # noqa: E402

fails = []


def t(name, ok, got=None):
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok or got is None else f"  → {got!r}"))
    if not ok:
        fails.append(name)


d = Path(tempfile.mkdtemp(prefix="check-run-lock-"))
try:
    holder = subprocess.Popen(
        [sys.executable, "-c",
         "import sys, time; from pathlib import Path; sys.path.insert(0, sys.argv[1]); from lib import runner; "
         "runner._hold_backtest_lock('s', Path(sys.argv[2])); print('held', flush=True); time.sleep(60)",
         ROOT, str(d)], stdout=subprocess.PIPE, text=True)
    t("holder took the lock", holder.stdout.readline().strip() == "held")
    try:
        runner._hold_backtest_lock("s", d)
        t("① second backtest refused", False)
    except SystemExit as e:
        msg = str(e)
        t("① second backtest refused, naming the holder's PID and start time",
          f"PID {holder.pid}" in msg and "started 20" in msg, msg)
    holder.kill()
    holder.wait()
    t("② leftover holder note is still there", (d / runner.BACKTEST_HOLDER).exists())
    try:
        runner._hold_backtest_lock("s", d)
        t("② lock acquired once the holder is gone", "s" in runner._held_backtest_locks)
    except SystemExit as e:
        t("② lock acquired once the holder is gone", False, str(e))

    q = d / "q"
    os.makedirs(q)
    holder = subprocess.Popen(
        [sys.executable, "-c",
         "import sys, time; from pathlib import Path; sys.path.insert(0, sys.argv[1]); from lib import runner; "
         "runner._hold_backtest_lock('q', Path(sys.argv[2])); print('held', flush=True); time.sleep(3)",
         ROOT, str(q)], stdout=subprocess.PIPE, text=True)
    holder.stdout.readline()
    t0 = time.monotonic()
    try:
        runner._hold_backtest_lock("q", q, wait_s=30)
        t("① a restore's quiet re-run waits for the running backtest, then runs", time.monotonic() - t0 >= 1)
    except SystemExit as e:
        t("① a restore's quiet re-run waits for the running backtest, then runs", False, str(e))
    holder.wait()

    old = time.time() - runner._CHART_LEFTOVER_STALE_S - 60
    for name in ("chart.tmp", "chart.old", "chart.tmp-1"):
        os.makedirs(d / name)
        os.utime(d / name, (old, old))
    os.makedirs(d / "chart.tmp-2")
    os.makedirs(d / "chart")
    runner._sweep_chart_leftovers(d)
    left = sorted(p.name for p in d.iterdir() if p.is_dir() and p.name != "q")
    t("③ sweep removes stale build dirs only", left == ["chart", "chart.tmp-2"], left)
finally:
    shutil.rmtree(d, ignore_errors=True)

if fails:
    print(f"\n{len(fails)} FAILED")
    sys.exit(1)
print("\nall pass")
