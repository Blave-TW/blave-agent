"""群益本機開通完成那一刻,主畫面跟上開通框(runtime/capital_local._start → local_daemon 的帳戶讀取)。

開通框讀 state/capital_local_connect.json,主畫面的「已連接＋總權益」讀 manager/account.json。
`start` 派發時 handle_file 就 kick 了一次帳戶讀取——那時 worker 還沒寫 snapshot,讀到 ok:false;
worker ok 之後沒有任何東西再 kick,要等 ACCOUNT_EVERY_S(60 秒)。這支釘住:

  1. _start 看到 worker 的第一份好 snapshot → 叫 on_ready 一次;snapshot 讀失敗不叫
     worker 寫了明確的錯誤 snapshot → 幾秒內就以 SNAPSHOT_ERROR 結束(舊碼被同一圈的
     except 吞掉,乾等 START_TIMEOUT_S 150 秒才報 SNAPSHOT_TIMEOUT);檔案還沒寫好照舊重試
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

    def __init__(self, ok, proc=None):
        self.ok, self.proc = ok, proc

    def start(self):
        with open(capl._paths()["snapshot"], "w", encoding="utf-8") as f:
            if self.ok is None:
                f.write('{"ok": tr')   # mid-write: not an answer yet
            else:
                json.dump({"ok": self.ok, "error": None if self.ok else "boom", "read_at": time.time()}, f)

    def stop(self, why=""):
        pass

    def running(self):
        return False


def _fresh(ok, proc=None):
    for k in ("status", "snapshot"):
        try:
            os.remove(capl._paths()[k])
        except OSError:
            pass
    capl._update("probe", status="ok", state="ok")
    capl._LOCAL["worker"] = _Worker(ok, proc)


def _start_code():
    t = time.time()
    try:
        capl._start(None)
        return None, time.time() - t
    except Exception as e:
        return str(e).split(":", 1)[0], time.time() - t


class _Exited:
    """Popen stand-in for a worker that has already exited with `rc`."""

    def __init__(self, rc):
        self.rc = rc

    def poll(self):
        return self.rc

    def wait(self, timeout=None):
        return self.rc


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
raised, took = _start_code()
check("1 worker 寫了錯誤 snapshot → 幾秒內以 SNAPSHOT_ERROR 結束(不是等 150 秒的 SNAPSHOT_TIMEOUT)",
      raised == "SNAPSHOT_ERROR" and took < 10, (raised, round(took, 1)))
check("1 …狀態檔記 worker failed / SNAPSHOT_ERROR(畫面對到 cap.err.snapshot)",
      (capl.read_status() or {}).get("worker", {}).get("error") == "SNAPSHOT_ERROR"
      and capl.read_status()["worker"]["status"] == "failed", capl.read_status())
check("1 snapshot 讀失敗 → 不叫 on_ready", calls == [], calls)
_fresh(False, _Exited(capl.LOGIN_STOPPED_EXIT))
raised, took = _start_code()
check("1 錯誤 snapshot 之後 worker 以登入被拒結束 → 照舊報 LOGIN_FAILED", raised == "LOGIN_FAILED" and took < 10,
      (raised, round(took, 1)))
_fresh(None)


def _later_good():
    time.sleep(3)
    with open(capl._paths()["snapshot"], "w", encoding="utf-8") as f:
        json.dump({"ok": True, "read_at": time.time()}, f)


threading.Thread(target=_later_good, daemon=True).start()
raised, took = _start_code()
check("1 snapshot 還沒寫好(JSON 寫一半)→ 照舊重試,等到好的那份才 ok", raised is None and len(calls) == 1,
      (raised, calls))
calls.clear()
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
