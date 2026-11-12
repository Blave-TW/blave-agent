"""Type B 的 manager/run_strategy.sh 不再讓同一支策略疊著跑、也不再讓卡住的那輪永遠掛著(稽核 X2)。

  ① 同一支同時啟兩次:第二次立刻 exit 0、不跑策略、記一行 skipped、不碰 heartbeat;
  ② 第一次照常跑完 → exit 0、heartbeat 有了;鎖跟著行程走,下一輪照常跑;
  ③ 超時:策略被殺(子行程真的不在了)、回 124、走 alert_failure、strategy.log 有原因;
     策略開的孫行程卡住、握著輸出管也一樣,整組殺掉、鎖放開;
  ④ 策略自己 exit 75 不會被當成「上一輪還在跑」;
  ⑤ timeout:5m → 600、45m → 30m 封頂;沒 INTERVAL／非分鐘 INTERVAL → 6 小時(agent 自排的每天一次也跑得完);
  ⑥ 沒 INTERVAL、跑得比緊的那種上限久的長任務照常跑完(把寬上限縮成幾秒來模擬);
  ⑦ 超時先送 SIGTERM(策略能收尾),不理 SIGTERM 的(含孫行程)寬限後 SIGKILL;
  ⑧ 鎖檔開不了(root 留下的檔、state/locks 被佔成檔案):記一行、照跑、heartbeat 照更新。
(reconciler_stopped 照跳過由 check_restart_stop_order_gate.py part 4 守。)

跑法:cd blave-agent && .venv/bin/python tests/check_typeb_run_lock.py
"""
import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
fails = []


def t(name, ok, got=None):
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok or got is None else f"  → {got!r}"))
    if not ok:
        fails.append(name)


tmp = tempfile.mkdtemp(prefix="check-typeb-lock-")
ws = os.path.join(tmp, "ws")
shutil.copytree(os.path.join(ROOT, "manager"), os.path.join(ws, "manager"))
RL_WS = os.path.join(ws, "manager", "run_locked.py")
RL_SRC = open(RL_WS).read()


def patch_rl(**consts):
    """the ws copy of run_locked.py with module constants shrunk to test-sized seconds"""
    src = RL_SRC
    for k, v in consts.items():
        line = next((l for l in src.splitlines() if l.startswith(k + " = ")), None)
        assert line, k
        src = src.replace(line, f"{k} = {v}", 1)
    with open(RL_WS, "w") as f:
        f.write(src)


patch_rl(TERM_GRACE_S=2)
sdir = os.path.join(ws, "strategies", "tb")
os.makedirs(sdir)
ENV = {k: v for k, v in os.environ.items() if k != "BLAVE_RUN_TIMEOUT_S"}


def write_strategy(body):
    with open(os.path.join(sdir, "strategy.py"), "w") as f:
        f.write(body)


def run(env=None, wait=True):
    p = subprocess.Popen(["bash", "manager/run_strategy.sh", "tb"], cwd=ws, env=env or ENV,
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if not wait:
        return p
    out, _ = p.communicate(timeout=120)
    return p.returncode, out


def log():
    p = os.path.join(sdir, "strategy.log")
    return open(p).read() if os.path.exists(p) else ""


heartbeat = os.path.join(ws, "state", "heartbeat", "tb")

# ① ②
# the first run holds until the test releases it, so a slow second launch still finds it running
write_strategy("import os, time\nopen('runs', 'a').write('x')\nopen('started', 'w').write('1')\n"
               "end = time.time() + 60\n"
               "while not os.path.exists('release') and time.time() < end:\n    time.sleep(0.05)\n")
first = run(wait=False)
deadline = time.time() + 30
while not os.path.exists(os.path.join(ws, "started")) and time.time() < deadline:
    time.sleep(0.05)
t0 = time.monotonic()
code2, out2 = run()
took = time.monotonic() - t0
t("① 第二次立刻 exit 0", code2 == 0 and took < 3, (code2, round(took, 2), out2))
t("① 第二次沒跑策略", open(os.path.join(ws, "runs")).read() == "x")
t("① 記一行 skipped", log().count("skipped: previous run still running") == 1, log())
t("① 第二次不碰 heartbeat", not os.path.exists(heartbeat))
open(os.path.join(ws, "release"), "w").close()
out1, _ = first.communicate(timeout=60)
t("② 第一次照常跑完 exit 0、heartbeat 有了", first.returncode == 0 and os.path.exists(heartbeat),
  (first.returncode, out1))
code3, _ = run()
t("② 鎖已放,下一輪照常跑", code3 == 0 and open(os.path.join(ws, "runs")).read() == "xx", code3)

# ③
write_strategy("import os, time\nopen('child_pid', 'w').write(str(os.getpid()))\n"
               "print('working', flush=True)\ntime.sleep(60)\n")
t0 = time.monotonic()
code, out = run(env={**ENV, "BLAVE_RUN_TIMEOUT_S": "2"})
took = time.monotonic() - t0
child = int(open(os.path.join(ws, "child_pid")).read())
try:
    os.kill(child, 0)
    child_alive = True
except ProcessLookupError:
    child_alive = False
t("③ 超時被殺、回 124", code == 124 and took < 20, (code, round(took, 2), out))
t("③ 策略子行程真的不在了", not child_alive, child)
t("③ strategy.log 有輸出和原因", "working" in log() and "killed after exceeding 2s timeout" in log(), log())
t("③ 走了 alert_failure(落地冷卻檔)", os.path.exists(os.path.join(sdir, "failure_alert_state.json")))

# ③b 策略開的孫行程卡住、握著輸出管:整組一起殺,不會因為管子沒關而永遠握著鎖
write_strategy("import os, subprocess, time\n"
               "p = subprocess.Popen(['sleep', '60'])\nopen('grandchild_pid', 'w').write(str(p.pid))\n"
               "time.sleep(60)\n")
t0 = time.monotonic()
code, out = run(env={**ENV, "BLAVE_RUN_TIMEOUT_S": "2"})
took = time.monotonic() - t0
gc = int(open(os.path.join(ws, "grandchild_pid")).read())
time.sleep(0.2)
try:
    os.kill(gc, 0)
    gc_alive = True
except ProcessLookupError:
    gc_alive = False
t("③b 孫行程握著管子也照樣 124、不卡", code == 124 and took < 20, (code, round(took, 2), out))
t("③b 孫行程一起殺掉", not gc_alive, gc)
code_next, _ = run(env={**ENV, "BLAVE_RUN_TIMEOUT_S": "2"})
t("③b 鎖有放:下一輪不是 skipped", code_next == 124 and log().count("skipped:") == 1, code_next)

# ④
write_strategy("raise SystemExit(75)\n")
code, out = run()
t("④ 策略自己 exit 75 → 回 1、不是 skipped", code == 1 and log().count("skipped:") == 1, (code, log()))

# ⑤
spec = importlib.util.spec_from_file_location("rl", os.path.join(ROOT, "manager", "run_locked.py"))
rl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rl)
os.environ.pop("BLAVE_RUN_TIMEOUT_S", None)
probe = os.path.join(tmp, "probe.py")
for body, want in (('INTERVAL = "5m"\n', 600), ("INTERVAL = '45m'\n", 2100),
                   ('INTERVAL = "4h"\n', 21600), ("x = 1\n", 21600)):
    with open(probe, "w") as f:
        f.write(body)
    t(f"⑤ timeout {body.strip()!r} → {want}", rl.timeout_seconds(probe) == want, rl.timeout_seconds(probe))
t("⑤ 檔案不在 → 寬上限", rl.timeout_seconds(os.path.join(tmp, "nope.py")) == 21600)
with open(probe, "w") as f:
    f.write("x = 1\n")
t("⑤ 沒 INTERVAL:每天一次、冷抓 70 分鐘的那種跑得完", rl.timeout_seconds(probe) > 70 * 60 + rl.MARGIN_S)
t("⑤ 寬限 30 秒才 SIGKILL", rl.TERM_GRACE_S == 30)

# ⑥ 寬上限縮成 6 秒、MARGIN_S 縮到舊算法(每小時+MARGIN)只剩 2 秒:沒 INTERVAL、跑 3 秒的照常跑完;寬上限縮成 1 秒則被殺
LONG = ("import time\ntime.sleep(3)\nopen('long_done', 'w').write('1')\n")
write_strategy(LONG)
patch_rl(TERM_GRACE_S=2, WIDE_TIMEOUT_S=6, MARGIN_S=-3598)
if os.path.exists(heartbeat):
    os.remove(heartbeat)
code, out = run()
t("⑥ 沒 INTERVAL 的長任務跑完、exit 0、heartbeat 有了",
  code == 0 and os.path.exists(os.path.join(ws, "long_done")) and os.path.exists(heartbeat), (code, out))
os.remove(os.path.join(ws, "long_done"))
patch_rl(TERM_GRACE_S=2, WIDE_TIMEOUT_S=1)
code, out = run()
t("⑥ 寬上限仍是上限:縮到 1 秒就 124", code == 124 and not os.path.exists(os.path.join(ws, "long_done")),
  (code, out))
patch_rl(TERM_GRACE_S=2)

# ⑦ SIGTERM 先到:策略收到 SIGTERM 還能收尾
write_strategy("import signal, sys, time\n"
               "def h(*_):\n    open('got_term', 'w').write('1')\n    sys.exit(0)\n"
               "signal.signal(signal.SIGTERM, h)\ntime.sleep(60)\n")
t0 = time.monotonic()
code, out = run(env={**ENV, "BLAVE_RUN_TIMEOUT_S": "2"})
took = time.monotonic() - t0
t("⑦ 超時先送 SIGTERM:策略收得到、能收尾;照樣回 124",
  code == 124 and os.path.exists(os.path.join(ws, "got_term")) and took < 20, (code, round(took, 2), out))

# ⑦b 不理 SIGTERM:寬限(縮成 2 秒)後 SIGKILL
write_strategy("import os, signal, time\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
               "open('child_pid', 'w').write(str(os.getpid()))\ntime.sleep(60)\n")
t0 = time.monotonic()
code, out = run(env={**ENV, "BLAVE_RUN_TIMEOUT_S": "2"})
took = time.monotonic() - t0
child = int(open(os.path.join(ws, "child_pid")).read())
try:
    os.kill(child, 0)
    child_alive = True
except ProcessLookupError:
    child_alive = False
t("⑦b 不理 SIGTERM:等完寬限才 SIGKILL、回 124", code == 124 and 3.5 <= took < 20 and not child_alive,
  (code, round(took, 2), child_alive))

# ⑦c 策略自己收到 SIGTERM 就走,但它開的孫行程不理 SIGTERM、握著管子:寬限後整組 SIGKILL
write_strategy("import os, signal, subprocess, time\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
               "p = subprocess.Popen(['sleep', '60'])\nopen('grandchild_pid', 'w').write(str(p.pid))\n"
               "signal.signal(signal.SIGTERM, signal.SIG_DFL)\ntime.sleep(60)\n")
t0 = time.monotonic()
code, out = run(env={**ENV, "BLAVE_RUN_TIMEOUT_S": "2"})
took = time.monotonic() - t0
gc = int(open(os.path.join(ws, "grandchild_pid")).read())
time.sleep(0.2)
try:
    os.kill(gc, 0)
    gc_alive = True
except ProcessLookupError:
    gc_alive = False
t("⑦c 不理 SIGTERM 的孫行程寬限後一起殺、回 124", code == 124 and took < 20 and not gc_alive,
  (code, round(took, 2), gc_alive))

# ⑦d 孫行程不理 SIGTERM、沒握管子:策略一收到 SIGTERM 就走,只有寬限後那發整組 SIGKILL 收得到它
write_strategy("import os, signal, subprocess, time\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
               "p = subprocess.Popen(['sleep', '60'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\n"
               "open('grandchild_pid', 'w').write(str(p.pid))\n"
               "signal.signal(signal.SIGTERM, signal.SIG_DFL)\ntime.sleep(60)\n")
code, out = run(env={**ENV, "BLAVE_RUN_TIMEOUT_S": "2"})
gc = int(open(os.path.join(ws, "grandchild_pid")).read())
time.sleep(0.2)
try:
    os.kill(gc, 0)
    gc_alive = True
except ProcessLookupError:
    gc_alive = False
t("⑦d 沒握管子、不理 SIGTERM 的孫行程也一起殺", code == 124 and not gc_alive, (code, gc_alive))

# ⑧ 鎖檔開不了:照跑、記一行
write_strategy("open('ran', 'a').write('x')\n")
lockdir = os.path.join(ws, "state", "locks")
lockfile = os.path.join(lockdir, "tb.lock")
if os.geteuid() == 0:
    print("SKIP  ⑧ 以 root 跑,權限擋不住")
else:
    os.chmod(lockfile, 0)
    if os.path.exists(heartbeat):
        os.remove(heartbeat)
    code, out = run()
    os.chmod(lockfile, 0o600)
    t("⑧ 鎖檔無權限:照跑、exit 0、heartbeat 有了",
      code == 0 and open(os.path.join(ws, "ran")).read() == "x" and os.path.exists(heartbeat), (code, out))
    t("⑧ strategy.log 記一行 lock unavailable (PermissionError",
      log().count("lock unavailable (PermissionError") == 1, log())
shutil.rmtree(lockdir)
open(lockdir, "w").close()
ran0 = open(os.path.join(ws, "ran")).read() if os.path.exists(os.path.join(ws, "ran")) else ""
n0 = log().count("lock unavailable (")
code, out = run()
t("⑧ state/locks 被佔成一般檔案:照跑、記一行", code == 0 and open(os.path.join(ws, "ran")).read() == ran0 + "x"
  and log().count("lock unavailable (") == n0 + 1, (code, log()))
os.remove(lockdir)

shutil.rmtree(tmp, ignore_errors=True)
print(f"\n{len(fails)} failed" if fails else "\nall passed")
sys.exit(1 if fails else 0)
