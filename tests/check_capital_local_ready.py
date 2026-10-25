"""群益本機開通完成那一刻,主畫面跟上開通框(runtime/capital_local._start → local_daemon 的帳戶讀取)。

開通框讀 state/capital_local_connect.json,主畫面的「已連接＋總權益」讀 manager/account.json。
`start` 派發時 handle_file 就 kick 了一次帳戶讀取——那時 worker 還沒寫 snapshot,讀到 ok:false;
worker ok 之後沒有任何東西再 kick,要等 ACCOUNT_EVERY_S(60 秒)。這支釘住:

  1. _start 看到 worker 的第一份好 snapshot → 叫 on_ready 一次;snapshot 讀失敗不叫
  2. local_daemon.run 把 on_ready 接到 account_kick(不是 dirty、不是 _ON_PROGRESS)
  3. 真的 _account_loop:派發那一輪之後,worker ok → 3 秒內再讀一次帳戶;沒有 ok 就不多讀

Run: cd blave-agent && /usr/bin/python3 tests/check_capital_local_ready.py
"""
import inspect
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = tempfile.mkdtemp(prefix="capl-ready-")
WS = os.path.join(BASE, "workspace")
for d in ("lib", "state", "manager"):
    os.makedirs(os.path.join(WS, d))
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = BASE
os.environ["BLAVE_AGENT_BASE"] = BASE
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ["BLAVE_AGENT_LOCAL"] = "1"
sys.path.insert(0, os.path.join(ROOT, "runtime"))
import capital_local as capl  # noqa: E402
import command_listener as cl  # noqa: E402
import local_daemon as ld  # noqa: E402

fails = []


def check(name, cond, detail=""):
    print(("ok   " if cond else "FAIL ") + name + ("" if cond else f"  {detail}"))
    if not cond:
        fails.append(name)


class _Worker:
    """capital_worker stand-in: start() writes the snapshot the real one writes after its login."""

    def __init__(self, ok):
        self.ok, self.proc = ok, None

    def start(self):
        with open(capl._paths()["snapshot"], "w", encoding="utf-8") as f:
            json.dump({"ok": self.ok, "read_at": time.time()}, f)

    def stop(self, why=""):
        pass

    def running(self):
        return False


def _fresh(ok):
    for k in ("status", "snapshot"):
        try:
            os.remove(capl._paths()[k])
        except OSError:
            pass
    capl._update("probe", status="ok", state="ok")
    capl._LOCAL["worker"] = _Worker(ok)


# 1 ─ _start
calls = []
capl._LOCAL["on_ready"] = lambda: calls.append(time.time())
_fresh(True)
out = capl._start(None)
check("1 worker 第一份好 snapshot → _start 回 ok、on_ready 叫一次", out == {"worker": "ok"} and len(calls) == 1, (out, calls))
check("1 叫的時候狀態檔已經是 worker ok(畫面讀到的順序跟 runtime 一致)",
      (capl.read_status() or {}).get("worker", {}).get("status") == "ok")
calls.clear()
_fresh(False)
real_timeout, capl.START_TIMEOUT_S = capl.START_TIMEOUT_S, 3   # a failed read is swallowed by the poll loop and runs out the clock
try:
    capl._start(None)
    raised = None
except Exception as e:
    raised = str(e).split(":", 1)[0]
check("1 snapshot 讀失敗 → 不叫 on_ready", raised is not None and calls == [], (raised, calls))
capl.START_TIMEOUT_S = real_timeout
capl._LOCAL["on_ready"] = lambda: 1 / 0
_fresh(True)
check("1 on_ready 自己丟例外不拖垮開通", capl._start(None) == {"worker": "ok"})

# 2 ─ wiring
src_run = inspect.getsource(ld.Daemon.run)
check("2 local_daemon.run 把 on_ready 接到 account_kick",
      'self.capl._LOCAL["on_ready"] = self.account_kick.set' in src_run)

# 3 ─ the real account loop
d = ld.Daemon(WS, "s")
capl._LOCAL["on_ready"] = d.account_kick.set
cl._bound_venue = lambda: True
reads = []
real_run = ld.subprocess.run


def _fake_run(argv, *a, **kw):
    if any(str(x).endswith("account_reader.py") for x in argv):
        reads.append(time.time())
        return subprocess.CompletedProcess(argv, 0)
    return real_run(argv, *a, **kw)


ld.subprocess.run = _fake_run
threading.Thread(target=d._account_loop, daemon=True).start()
deadline = time.time() + 3
while time.time() < deadline and not reads:
    time.sleep(0.05)
check("3 帳戶讀取迴圈起來先讀一次(= start 派發時那一次 kick)", len(reads) == 1, reads)
time.sleep(2.5)
check("3 沒有新的 kick → 不多讀(一般情況不多打)", len(reads) == 1, reads)
_fresh(True)
t_ok = time.time()
capl._start(None)
deadline = t_ok + 3
while time.time() < deadline and len(reads) < 2:
    time.sleep(0.05)
check("3 worker ok → 3 秒內再讀一次帳戶(舊碼要等 ACCOUNT_EVERY_S)",
      len(reads) == 2 and reads[1] - t_ok <= 3, [round(r - t_ok, 2) for r in reads])
time.sleep(2.5)
check("3 只多讀那一次", len(reads) == 2, reads)
d.stop.set()
ld.subprocess.run = real_run

shutil.rmtree(BASE, ignore_errors=True)
print("FAILED: " + ", ".join(fails) if fails else "all ok")
sys.exit(1 if fails else 0)
