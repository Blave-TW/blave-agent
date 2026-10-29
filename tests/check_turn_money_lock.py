"""lib/guard 的回合級下單鎖(0.1.37 多條對話並行;稽核 s1 第 3 點、s2 P2-1／P2-2／P3-2):
只在 agent 回合裡(有 BLAVE_TURN_INTERRUPT_FILE)拿一把機器級的鎖,拿到就留到行程結束——
  - 平倉／執行入口(flatten、close_symbol、stop_strategy、run_twap)在讀部位之前 hold_turn_money(),只有這裡會等;
  - 每支 lib/order_* 送單前的 check_restart_stop 也拿,但不等:忙就馬上 TurnMoneyBusy(腳本早就讀過部位,等完再送是照舊資料下單);
  - import order lib(研究、查價腳本)什麼都不拿;cancel／leverage 這類 _RESTART_PASS 意圖不拿;
  - 同一輪(父腳本與它的子行程)共用;持有者寫不進 owner 檔就當成沒拿到;持有者結束時清掉 owner 檔;
  - 等待上限要明顯低於 agent Bash 的預設逾時(120 秒),不然等到一半被轉到背景,agent 看不到「什麼都沒送」。
用真的子行程互搶(flock / Windows msvcrt 同一套判斷)。跑法:python3 tests/check_turn_money_lock.py
"""
import json
import os
import re
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


# mode: hold = hold_turn_money() / gate = check_restart_stop("entry") / cancel = check_restart_stop("cancel") /
#       import = mark_money_process() only (what importing an order lib does)
CHILD = r'''
import json, os, sys, time
sys.path.insert(0, {root!r})
from lib import guard
guard.TURN_MONEY_LOCK = sys.argv[4] if len(sys.argv) > 4 else {lock!r}
guard.MONEY_PID_DIR = {pids!r}
guard.TURN_MONEY_WAIT_S = float(sys.argv[2])
guard.restart_stopped = lambda: False
guard._check_halt_freeze = lambda *a, **k: None
mode = sys.argv[3]
t0 = time.time()
try:
    if mode == "hold":
        guard.hold_turn_money()
    elif mode == "gate":
        guard.check_restart_stop("entry", {{}})
    elif mode == "cancel":
        guard.check_restart_stop("cancel", {{}})
    else:
        guard.mark_money_process()
    out = {{"got": time.time(), "t0": t0, "held": guard._turn_money_fd is not None}}
except guard.TurnMoneyBusy as e:
    out = {{"busy": str(e), "t0": t0, "at": time.time()}}
print(json.dumps(out), flush=True)
time.sleep(float(sys.argv[1]))
'''.format(root=ROOT, lock=LOCK, pids=os.path.join(TMP, "pids"))


def run(turn, hold, mode="hold", wait=5, lock=None, env_extra=None):
    env = {k: v for k, v in os.environ.items() if k not in ("BLAVE_TURN_INTERRUPT_FILE", "BLAVE_TURN_PID")}
    if turn:
        env["BLAVE_TURN_INTERRUPT_FILE"] = turn
    env.update(env_extra or {})
    argv = [sys.executable, "-c", CHILD, str(hold), str(wait), mode] + ([lock] if lock else [])
    return subprocess.Popen(argv, env=env, stdout=subprocess.PIPE, text=True)


def first(p):
    return json.loads(p.stdout.readline())


a = run("/t/turn-A", 1.5)
ra = first(a)
b = run("/t/turn-B", 0)
rb = first(b)
t("兩條回合:B 的平倉入口(hold)等 A 那個行程結束才拿到", "got" in rb and rb["got"] - ra["got"] >= 1.3, (ra, rb))
a.wait(); b.wait()
t("A、B 結束時清掉 owner 檔(之後那一輪的腳本不會以為自己還拿著)", not os.path.exists(LOCK + ".owner"))

a = run("/t/turn-A", 3)
first(a)
child = run("/t/turn-A", 0, mode="gate")
rc = first(child)
t("同一輪(父腳本開著、它叫的子行程送單):共用,不等", "got" in rc and rc["got"] - rc["t0"] < 0.8, rc)
d = run(None, 0, mode="gate")
rd = first(d)
t("對帳器／常駐程式(沒有 BLAVE_TURN_INTERRUPT_FILE):送單也不拿鎖,不等", "got" in rd and not rd["held"] and rd["got"] - rd["t0"] < 0.8, rd)
e = run("/t/turn-C", 0, wait=0.6)
re_ = first(e)
t("平倉入口等滿上限:拋 TurnMoneyBusy,講清楚是別的對話在下單、等了多久、什麼都沒送、要重讀部位",
  "busy" in re_ and "Another conversation" in re_["busy"] and "waited 0.6 s" in re_["busy"] and "Nothing was sent" in re_["busy"]
  and "re-read the position" in re_["busy"] and re_["at"] - re_["t0"] < 2, re_)
g = run("/t/turn-D", 0, mode="gate", wait=5)
rg = first(g)
t("送單閘門(check_restart_stop)忙就馬上拋,不等(腳本早讀過部位,等完再送是照舊資料下單)",
  "busy" in rg and "Nothing was sent" in rg["busy"] and "waited" not in rg["busy"] and rg["at"] - rg["t0"] < 0.8, rg)
k = run("/t/turn-D", 0, mode="cancel", wait=5)
rk = first(k)
t("回合裡撤單(cancel／cancel_all／槓桿)也走閘門拿鎖、不等:別條拿著就馬上拋,「先撤再掛」第一步就停、真的什麼都沒送(複稽核 R-P2-1)",
  "busy" in rk and "Nothing was sent" in rk["busy"] and rk["at"] - rk["t0"] < 0.8, rk)
dead = subprocess.Popen([sys.executable, "-c", "pass"]); dead.wait()
z = run("/t/turn-G", 0, mode="gate", wait=5, env_extra={"BLAVE_TURN_PID": str(dead.pid)})
rz = first(z)
t("回合留下的常駐行程(BLAVE_TURN_PID 那個 agent_turn 已經不在):不算回合裡,送單不拿鎖、別條拿著也照送(複稽核 R-P2-2)",
  "got" in rz and not rz["held"] and rz["got"] - rz["t0"] < 0.8, rz)
y = run("/t/turn-G", 0, mode="gate", wait=5, env_extra={"BLAVE_TURN_PID": str(os.getpid())})
ry = first(y)
t("對照:BLAVE_TURN_PID 那個行程還在 → 照樣是回合裡,別條拿著就拋", "busy" in ry, ry)
im = run("/t/turn-E", 0, mode="import", wait=5)
ri = first(im)
t("只 import order lib(mark_money_process)不拿鎖:研究／查價腳本不擋人", "got" in ri and not ri["held"] and ri["got"] - ri["t0"] < 0.8, ri)
for p in (a, child, d, e, g, k, im, z, y):
    p.wait()

# 持有者寫不進 owner 檔:當成沒拿到(owner 還寫著上一個持有者的話,那一輪的腳本會以為自己拿著)
bad = os.path.join(TMP, "bad", "turn_money.lock")
os.makedirs(bad + ".owner")
w = run("/t/turn-F", 0, mode="hold", wait=0.3, lock=bad)
rw = first(w)
w.wait()
t("owner 檔寫不進去:不算拿到鎖,拋 TurnMoneyBusy、什麼都沒送", "busy" in rw and "Nothing was sent" in rw["busy"], rw)

src = open(os.path.join(ROOT, "lib", "guard.py"), encoding="utf-8").read()
wait_s = float(re.search(r"^TURN_MONEY_WAIT_S = (\d+(?:\.\d+)?)$", src, re.M).group(1))
at_src = open(os.path.join(ROOT, "runtime", "agent_turn.py"), encoding="utf-8").read()
t("等待上限 + 15 秒餘裕(python 啟動、import)< agent Bash 預設逾時 120 秒;agent_turn 那邊確實沒改預設",
  wait_s * 1000 + 15000 < 120000 and "BASH_DEFAULT_TIMEOUT_MS is deliberately left at its 120s default" in at_src
  and "BASH_DEFAULT_TIMEOUT_MS\"]" not in at_src, wait_s)
t("parallel_rule 寫明:下單／平倉腳本帶 ≥180000 ms 的 timeout、回來時還在跑就等、不重跑、不迴圈重試",
  "command timeout of at least 180000 ms" in at_src and "never start it a second time" in at_src and "do not retry in a loop" in at_src)
gate = src[src.index("def check_restart_stop("):src.index("# ── HALT close pass")]
t("閘門:_RESTART_PASS 早退之前就拿(撤單也算,不等)", gate.index("_turn_money_lock(0)") < gate.index("if intent in _RESTART_PASS:"))
mark = src[src.index("def mark_money_process("):src.index("def _own_created(")]
t("mark_money_process 不再拿鎖", "_turn_money_lock" not in mark)


def body(path, start, end):
    s = open(os.path.join(ROOT, path), encoding="utf-8").read()
    i = s.index(start)
    return s[i:s.index(end, i)]


fl = body("manager/flatten.py", "def flatten():", "\ndef _flatten():")
t("flatten:singleflight 之前就 hold_turn_money(等鎖時不佔 flatten.lock);忙就一列錯誤、這一支什麼都不平(複稽核 R-P1)",
  fl.index("guard.hold_turn_money()") < fl.index("_singleflight()") < fl.index("return _flatten()")
  and bool(re.search(r"except guard\.TurnMoneyBusy as e:\n\s*logging\.error\([^\n]*\n\s*_record_order_error\(\"\*\", \"\*\", f\"close-all: \{e\}\"\)\n\s*return False", fl)))
fl2 = body("manager/flatten.py", "def _flatten():", "\nif __name__")
t("flatten:每家的 order lib 載入包在 try,壞一家只記那一家、照平下一家",
  bool(re.search(r"try:\n\s*order = importlib\.import_module\(f\"lib\.order_\{vid\}\"\) if has_order else None\n\s*except Exception as e:", fl2))
  and fl2.index("acct.get_positions(env") < fl2.index("order = importlib.import_module"))
cs = body("manager/close_symbol.py", "def close_symbol(", "\ndef add_key_args(")
t("close_symbol:prepare(讀任何東西)之前 hold_turn_money,忙 = Refused(exit 2,什麼都沒動)",
  cs.index("guard.hold_turn_money()") < cs.index("ctx = prepare(") and "raise Refused(str(e))" in cs)
ss = body("manager/stop_strategy.py", "def stop(", "\ndef main(")
t("stop_strategy:驗完名字、動任何東西之前 hold_turn_money", ss.index("guard.hold_turn_money()") < ss.index("members = cs.load_members()"))
tw = body("lib/execute.py", "def run_twap(", "\n    def _notify(")
t("run_twap:第一片之前 hold_turn_money", "guard.hold_turn_money()" in tw)
# R-P1 行為:回合 B 的 flatten 在等回合鎖(A 拿著);這段時間用戶按〔全部平倉〕(daemon 的 flatten,沒有回合變數)照平,
# 不被 ALREADY_RUNNING 吞掉。_flatten 換成只回報「平了」,flatten.lock 放在暫存目錄
FLAT = r'''
import json, os, sys, time
sys.path.insert(0, {root!r}); sys.path.insert(0, os.path.join({root!r}, "manager"))
import flatten
from lib import guard
guard.TURN_MONEY_LOCK = {lock!r}
guard.MONEY_PID_DIR = {pids!r}
guard.TURN_MONEY_WAIT_S = float(sys.argv[1])
flatten.LOCK_PATH = {flock!r}
import lib.portfolio as _pf
_pf._unconfirmed = None
flatten._record_order_error = lambda *a, **k: None
flatten._flatten = lambda: (print(json.dumps({{"closed": time.time()}}), flush=True), True)[1]
t0 = time.time()
r = flatten.flatten()
print(json.dumps({{"result": r if isinstance(r, (bool, str)) else str(r), "t0": t0, "at": time.time()}}), flush=True)
'''.format(root=ROOT, lock=LOCK, pids=os.path.join(TMP, "pids"), flock=os.path.join(TMP, "flatten.lock"))


def flat(turn, wait):
    env = {k: v for k, v in os.environ.items() if k not in ("BLAVE_TURN_INTERRUPT_FILE", "BLAVE_TURN_PID")}
    if turn:
        env["BLAVE_TURN_INTERRUPT_FILE"] = turn
    return subprocess.Popen([sys.executable, "-c", FLAT, str(wait)], env=env, stdout=subprocess.PIPE, text=True, cwd=ROOT)


holder = run("/t/turn-A", 4)
first(holder)
bt = flat("/t/turn-B", 2.5)
time.sleep(1.0)   # B 已經在等回合鎖
dm = flat(None, 1)
dout = [json.loads(x) for x in dm.communicate(timeout=60)[0].splitlines() if x.startswith("{")]
bout = [json.loads(x) for x in bt.communicate(timeout=60)[0].splitlines() if x.startswith("{")]
holder.wait()
t("回合 flatten 等鎖期間,daemon 的〔全部平倉〕照平(拿得到 flatten.lock,不是 ALREADY_RUNNING)",
  any("closed" in x for x in dout) and any(x.get("result") is True for x in dout), dout)
t("…等鎖那支逾時:這一支什麼都不平、回 False", not any("closed" in x for x in bout) and any(x.get("result") is False for x in bout), bout)
rc = open(os.path.join(ROOT, "manager", "reconciler.py"), encoding="utf-8").read()
main_blk = rc[rc.index("if __name__ == '__main__':"):]
t("常駐入口一開頭清掉回合變數:reconciler __main__、start_reconciler.sh／.ps1、run_strategy.sh",
  main_blk.index('os.environ.pop("BLAVE_TURN_INTERRUPT_FILE", None)') < main_blk.index("_hold_singleton()") and 'os.environ.pop("BLAVE_TURN_PID", None)' in main_blk
  and "unset BLAVE_TURN_INTERRUPT_FILE BLAVE_TURN_PID" in open(os.path.join(ROOT, "manager", "start_reconciler.sh"), encoding="utf-8").read()
  and "unset BLAVE_TURN_INTERRUPT_FILE BLAVE_TURN_PID" in open(os.path.join(ROOT, "manager", "run_strategy.sh"), encoding="utf-8").read()
  and "Remove-Item Env:BLAVE_TURN_INTERRUPT_FILE" in open(os.path.join(ROOT, "manager", "start_reconciler_windows.ps1"), encoding="utf-8").read())
t("agent_turn 帶回合變數時把自己的 pid 放進 BLAVE_TURN_PID(子行程繼承)", 'os.environ["BLAVE_TURN_PID"] = str(os.getpid())' in at_src)
print(("\n%d 紅" % red) if red else "\nALL PASS")
sys.exit(1 if red else 0)
