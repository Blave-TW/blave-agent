"""wait_for_bar 的 state/bar_wait/<name>.lock 不再靠 LOCK_STALE_SECONDS(1800)等死鎖(2026-10-11
測試機:listener 重啟殺掉跑中的 tick,接下來 30 分鐘每個 tick 靜默跳過)。

  ① 鎖裡的 pid 已死 → 下一 tick 立刻接管(不管 mtime 多新);
  ② 鎖裡的 pid 活著 → 照跳過;持有者死後再接管;
  ③ 鎖裡沒有 pid(空檔/壞字)→ 只剩 mtime 判準,行為同舊版;
  ④ (非 Windows)tick 跑到一半收到 SIGTERM → 鎖被清掉、退出碼 143;
  ⑤ 持有者死、但它的 strategy.py 子行程(鎖第二行)還活 → 不接管;兩個都死才接管;
  ⑥ _run_strategy_protected 把子 pid 寫進鎖第二行;
  ⑦ _release_lock 只刪自己的鎖(被接管後原持有者的 finally 不會刪掉接管者的鎖);
  ⑧ 多個 tick 同時判死同一把鎖,只有一個接管成功(os.replace 原子搬走)。

跑法:cd blave-agent && .venv/bin/python tests/check_bar_wait_lock_pid.py
"""
import importlib.util
import os
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WFB = os.path.join(ROOT, "manager", "wait_for_bar.py")

spec = importlib.util.spec_from_file_location("wfb", WFB)
wfb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wfb)

tmp = tempfile.mkdtemp(prefix="check-bar-wait-lock-")
wfb.STATE_DIR = os.path.join(tmp, "bar_wait")
LOCK = os.path.join(wfb.STATE_DIR, "s.lock")
fails = []


def t(name, ok, got=None):
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok or got is None else f"  → {got!r}"))
    if not ok:
        fails.append(name)


def leave_lock(content):
    os.makedirs(wfb.STATE_DIR, exist_ok=True)
    with open(LOCK, "w") as f:
        f.write(content)


def read_lock():
    with open(LOCK) as f:
        return f.read()


# ① dead pid, fresh mtime
dead = subprocess.Popen([sys.executable, "-c", "pass"])
dead.wait()
leave_lock(str(dead.pid))
got = wfb._acquire_lock("s")
t("① lock with a dead pid is taken over at once", got == LOCK and read_lock() == str(os.getpid()), got)
wfb._release_lock(got)
t("① release removes the lock", not os.path.exists(LOCK))

# ② live pid
holder = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
try:
    leave_lock(str(holder.pid))
    got = wfb._acquire_lock("s")
    t("② lock with a live pid still skips the tick", got is None and read_lock() == str(holder.pid), got)
finally:
    holder.kill()
    holder.wait()
got = wfb._acquire_lock("s")
t("② same lock after the holder died is taken over", got == LOCK, got)
wfb._release_lock(got)

# ③ no pid recorded → mtime only
for label, content in (("empty", ""), ("garbage", "not-a-pid")):
    leave_lock(content)
    got = wfb._acquire_lock("s")
    t(f"③ {label} lock, fresh mtime → skip (age fallback unchanged)", got is None, got)
    old = time.time() - wfb.LOCK_STALE_SECONDS - 5
    os.utime(LOCK, (old, old))
    got = wfb._acquire_lock("s")
    t(f"③ {label} lock, past LOCK_STALE_SECONDS → taken over", got == LOCK, got)
    wfb._release_lock(got)

# ④ SIGTERM mid-tick releases the lock (the strategy child goes with subprocess.run's own kill)
if os.name != "nt":
    child_src = f"""
import importlib.util, os, sys, time, types
spec = importlib.util.spec_from_file_location("wfb", {WFB!r})
wfb = importlib.util.module_from_spec(spec); spec.loader.exec_module(wfb)
wfb.STATE_DIR = {wfb.STATE_DIR!r}
wfb._load_strategy_module = lambda name: types.SimpleNamespace(INTERVAL="1h")
def slow(mod, expected):
    print("in-tick", flush=True)
    time.sleep(60)
wfb._check_freshness = slow
wfb._alert_wrapper_error = lambda name, e: None
sys.argv = ["wait_for_bar.py", "s"]
wfb.main()
"""
    proc = subprocess.Popen([sys.executable, "-c", child_src], stdout=subprocess.PIPE, text=True)
    line = proc.stdout.readline().strip()
    t("④ tick acquired the lock before SIGTERM", line == "in-tick" and read_lock() == str(proc.pid), line)
    proc.terminate()
    rc = proc.wait(timeout=10)
    t("④ SIGTERM → exit 143 and the lock is gone", rc == 143 and not os.path.exists(LOCK), (rc, os.path.exists(LOCK)))
else:
    print("SKIP  ④ SIGTERM path (not delivered on Windows; pid probe covers it)")

# ⑤ holder dead, its strategy.py child (line 2) alive → the orphan keeps the lock
orphan = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
try:
    leave_lock(f"{dead.pid}\n{orphan.pid}")
    got = wfb._acquire_lock("s")
    t("⑤ dead holder + live strategy child → not taken over", got is None, got)
finally:
    orphan.kill()
    orphan.wait()
got = wfb._acquire_lock("s")
t("⑤ both dead → taken over", got == LOCK, got)
wfb._release_lock(got)

# ⑥ the child pid lands in the lock while strategy.py runs
ws = os.path.join(tmp, "ws")
os.makedirs(os.path.join(ws, "strategies", "s"))
with open(os.path.join(ws, "strategies", "s", "strategy.py"), "w") as f:
    f.write("import os, shutil, sys\n"
            "shutil.copy(os.environ['LOCKFIX_LOCK'], os.environ['LOCKFIX_LOCK'] + '.seen')\n"
            "open(os.environ['LOCKFIX_LOCK'] + '.pid', 'w').write(str(os.getpid()))\n")
cwd = os.getcwd()
os.chdir(ws)
os.environ["LOCKFIX_LOCK"] = LOCK
wfb._alert_failure = lambda: (_ for _ in ()).throw(AssertionError("strategy failed"))
try:
    lock = wfb._acquire_lock("s")
    ok = wfb._run_strategy_protected("s")
    seen = open(LOCK + ".seen").read().split()
    child = open(LOCK + ".pid").read().strip()
    t("⑥ lock during the run = holder pid + strategy child pid",
      ok and seen == [str(os.getpid()), child], seen)
    wfb._release_lock(lock)
    t("⑥ release after the run removes the two-line lock", not os.path.exists(LOCK))
finally:
    os.chdir(cwd)

# ⑦ release is ownership-checked
leave_lock(str(holder.pid))
wfb._release_lock(LOCK)
t("⑦ _release_lock leaves a lock that is not ours", os.path.exists(LOCK) and read_lock() == str(holder.pid))
os.remove(LOCK)

# ⑧ N ticks race on one dead lock → exactly one wins
leave_lock(str(dead.pid))
go = os.path.join(tmp, "go")
racer = f"""
import importlib.util, os, sys, time
spec = importlib.util.spec_from_file_location("wfb", {WFB!r})
wfb = importlib.util.module_from_spec(spec); spec.loader.exec_module(wfb)
wfb.STATE_DIR = {wfb.STATE_DIR!r}
while not os.path.exists({go!r}):
    time.sleep(0.005)
print("WIN" if wfb._acquire_lock("s") else "SKIP", flush=True)
time.sleep(1)
"""
racers = [subprocess.Popen([sys.executable, "-c", racer], stdout=subprocess.PIPE, text=True) for _ in range(8)]
time.sleep(1.0)  # let all eight reach the spin
open(go, "w").close()
results = [r.communicate(timeout=30)[0].strip() for r in racers]
t("⑧ eight simultaneous takeovers → exactly one WIN", results.count("WIN") == 1, results)
t("⑧ lock left behind belongs to one of the racers",
  read_lock().strip() in {str(r.pid) for r in racers} and not os.path.exists(LOCK + ".stale"), read_lock())
os.remove(LOCK)

print("ALL PASS" if not fails else f"{len(fails)} FAIL")
sys.exit(1 if fails else 0)
