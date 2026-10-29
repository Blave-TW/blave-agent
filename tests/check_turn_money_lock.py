"""lib/guard.mark_money_process 的回合級下單鎖(0.1.37 電腦版多條對話並行;稽核 s1 第 3 點):
只在回合裡(有 BLAVE_TURN_INTERRUPT_FILE)拿一把機器級的鎖、行程結束才放——兩條回合的手動下單／平倉自動排隊;
同一輪(父腳本與它的子行程)共用;對帳器、常駐程式(沒有那個變數)完全不碰;等太久回講得清楚的錯誤,不死等。
用真的子行程互搶(flock / Windows msvcrt 同一套判斷)。跑法:python3 tests/check_turn_money_lock.py
"""
import json
import os
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = tempfile.mkdtemp(prefix="turn-money-")
LOCK = os.path.join(TMP, "turn_money.lock")
red = 0


def t(name, ok, detail=None):
    global red
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok or detail is None else "  " + str(detail)))
    red += 0 if ok else 1


CHILD = r'''
import json, os, sys, time
sys.path.insert(0, {root!r})
from lib import guard
guard.TURN_MONEY_LOCK = {lock!r}
guard.MONEY_PID_DIR = {pids!r}
guard.TURN_MONEY_WAIT_S = float(sys.argv[2])
t0 = time.time()
try:
    guard.mark_money_process()
    out = {{"got": time.time(), "t0": t0}}
except guard.TurnMoneyBusy as e:
    out = {{"busy": str(e), "t0": t0, "at": time.time()}}
print(json.dumps(out), flush=True)
time.sleep(float(sys.argv[1]))
'''.format(root=ROOT, lock=LOCK, pids=os.path.join(TMP, "pids"))


def run(turn, hold, wait=5, env_extra=None):
    env = {k: v for k, v in os.environ.items() if k != "BLAVE_TURN_INTERRUPT_FILE"}
    if turn:
        env["BLAVE_TURN_INTERRUPT_FILE"] = turn
    env.update(env_extra or {})
    return subprocess.Popen([sys.executable, "-c", CHILD, str(hold), str(wait)], env=env, stdout=subprocess.PIPE, text=True)


def first(p):
    return json.loads(p.stdout.readline())


a = run("/t/turn-A", 1.5)
ra = first(a)
b = run("/t/turn-B", 0)
rb = first(b)
t("兩條回合:B 的下單腳本等 A 那個行程結束才拿到", "got" in rb and rb["got"] - ra["got"] >= 1.3, (ra, rb))
a.wait(); b.wait()

a = run("/t/turn-A", 3)
first(a)
child = run("/t/turn-A", 0)
rc = first(child)
t("同一輪(父腳本開著、它叫的子行程):共用,不等", "got" in rc and rc["got"] - rc["t0"] < 0.8, rc)
d = run(None, 0)
rd = first(d)
t("對帳器／常駐程式(沒有 BLAVE_TURN_INTERRUPT_FILE):不拿鎖,不等", "got" in rd and rd["got"] - rd["t0"] < 0.8, rd)
e = run("/t/turn-C", 0, wait=0.6)
re_ = first(e)
t("等滿上限:拋 TurnMoneyBusy,講清楚是別的對話在下單、什麼都沒送、要重讀部位", "busy" in re_ and "Another conversation" in re_["busy"] and "Nothing was sent" in re_["busy"]
  and "re-read the position" in re_["busy"] and re_["at"] - re_["t0"] < 2, re_)
for p in (a, child, d, e):
    p.wait()
src = open(os.path.join(ROOT, "lib", "guard.py"), encoding="utf-8").read()
t("先拿鎖才記成下單行程(放棄等待的行程,停止照樣收得掉)", src.index("_turn_money_lock()   # before marking") < src.index("_money_marked = True\n    path = os.path.join(MONEY_PID_DIR"))
print(("\n%d 紅" % red) if red else "\nALL PASS")
sys.exit(1 if red else 0)
