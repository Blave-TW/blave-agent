"""The desktop paper chain end to end, offline: a real local_daemon process on a
temp workspace, every step sent through the command queue (nothing edits a file
behind a handler's back), klines replaced by a strategy whose fetch_data is
fixed data (Close = 100), so no network and an exact expected position.

  credentials(paper) → amounts → execution → restart_reconciler → resume
  → scheduler ticks the strategy → reconciler fills on paper → status shows the
  position and equity → halt blocks a bigger entry → close_all flattens
  → a killed reconciler is restarted → SIGKILL the daemon and the reconciler
  leaves on its own within seconds → a reconciler that outlived its daemon
  anyway is stopped at the next daemon start, a look-alike from another cwd is
  not touched and blocks a second one → SIGTERM takes the reconciler down too.
Also: only paper binds (command and chat-bind path), a replay with its ack
deleted is refused, a FIFO / directory in the queue cannot wedge `halt`, a junk
file cannot overwrite a finished command's ack.
Takes about a minute and a half (reconciler poll 5s, restart delay 10s).
Run: cd blave-agent && .venv/bin/python tests/check_local_daemon_chain.py
"""
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid

import importlib.util

# the daemon runs strategies under sys.executable; without these the strategy dies
# inside the daemon and all that shows here is four timeouts minutes later
_missing = [m for m in ("pandas", "dotenv") if importlib.util.find_spec(m) is None]
if _missing:
    sys.exit(f"wrong interpreter ({sys.executable}): missing {_missing} — run with blave-agent/.venv/bin/python")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNTIME = os.path.join(ROOT, "runtime")
sys.path.insert(0, RUNTIME)
import local_daemon as ld  # noqa: E402

BASE = tempfile.mkdtemp(prefix="local-chain-")
WS = os.path.join(BASE, "workspace")
for d in ("lib", "manager"):
    shutil.copytree(os.path.join(ROOT, d), os.path.join(WS, d),
                    ignore=shutil.ignore_patterns("__pycache__", "*.json", "*.jsonl"))
STRATEGY = '''import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))
MODE = "backtest"
STRATEGY_NAME = "fixed_long"
SYMBOL = "BTCUSDT"
INTERVAL = "1m"
START = "2026-01-01"
END = None
FEE = 0.0005
WARMUP = 1


def fetch_data(hdrs):
    import pandas as pd
    end = pd.Timestamp.now(tz="UTC").tz_localize(None).floor("min")
    idx = pd.date_range(end=end, periods=300, freq="min")
    return pd.DataFrame({"Open": 100.0, "High": 100.0, "Low": 100.0,
                         "Close": 100.0, "Volume": 1.0}, index=idx)


def compute_signals(df):
    import pandas as pd
    return pd.Series(1.0, index=df.index)


if __name__ == "__main__":
    from lib.runner import run
    from lib.notify import make_sender
    run(locals(), fetch_data, compute_signals, make_sender())
'''
os.makedirs(os.path.join(WS, "strategies", "fixed_long"))
open(os.path.join(WS, "strategies", "fixed_long", "strategy.py"), "w").write(STRATEGY)
os.makedirs(os.path.join(WS, "strategies", "typeb"))
open(os.path.join(WS, "strategies", "typeb", "strategy.py"), "w").write("x = 1\n")

SECRET = uuid.uuid4().hex + uuid.uuid4().hex
ENV = {k: v for k, v in os.environ.items() if not k.startswith("BLAVE_")}
ENV.update(BLAVE_AGENT_BASE=BASE, BLAVE_AGENT_WORKSPACE=WS, BLAVE_AGENT_HOME=BASE,
           BLAVE_AGENT_LOCAL="1")
# No network, the real-venue gate included: the daemon's urllib is pointed at a
# proxy nobody listens on, so the permission check fails closed right here on
# this machine instead of reaching Binance. (Not a hook in the product — just the
# proxy variables every urllib honours.)
ENV.update(https_proxy="http://127.0.0.1:9", HTTPS_PROXY="http://127.0.0.1:9", no_proxy="", NO_PROXY="")
IN = os.path.join(WS, "state", "local_cmd", "in")
ACK = os.path.join(WS, "state", "local_cmd", "ack")
fails = 0
spawned = []


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg, flush=True)
    fails += 0 if cond else 1


def start_daemon():
    p = subprocess.Popen([sys.executable, os.path.join(RUNTIME, "local_daemon.py"),
                          "--secret-stdin"], env=ENV, stdin=subprocess.PIPE,
                         stderr=open(os.path.join(BASE, "daemon.log"), "ab"))
    p.stdin.write((SECRET + "\n").encode())
    p.stdin.flush()
    spawned.append(p)
    wait(lambda: os.path.isdir(IN), 20, "daemon up")
    return p


def wait(pred, seconds, what):
    end = time.time() + seconds
    while time.time() < end:
        try:
            v = pred()
        except (OSError, ValueError, KeyError, TypeError):
            v = None
        if v:
            return v
        time.sleep(0.3)
    check(False, f"timed out: {what}")
    return None


sent = {}  # id -> the exact file content, for the replay check


def drop(cid, text):
    tmp = os.path.join(IN, cid + ".json.tmp")
    with open(tmp, "w") as f:
        f.write(text)
    os.replace(tmp, os.path.join(IN, cid + ".json"))


def send(cmd, args=None, signed=True, wait_s=30):
    cid = uuid.uuid4().hex
    body = json.dumps({"id": cid, "cmd": cmd, "args": args or {}, "ts": int(time.time())})
    sent[cid] = json.dumps({"body": body, "mac": ld.sign(SECRET, body) if signed else ""})
    drop(cid, sent[cid])
    ack = wait(lambda: json.load(open(os.path.join(ACK, cid + ".json"))), wait_s, f"ack for {cmd}")
    return ack or {}


def is_ours(pid):
    """Only ever kill what is provably this test's: right cmdline."""
    out = subprocess.run(["ps", "-o", "args=", "-p", str(pid)], capture_output=True, text=True).stdout
    return "reconciler.py" in out


def gone(pid, seconds):
    end = time.time() + seconds
    while time.time() < end and alive(pid):
        time.sleep(0.3)
    return not alive(pid)


def hold_lock_and_spawn(argv, cwd):
    """A process holding the reconciler lock the way a real one does."""
    import fcntl
    fd = os.open(os.path.join(WS, "state", "local_reconciler.lock"), os.O_CREAT | os.O_RDWR, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    p = subprocess.Popen(argv, cwd=cwd, env=ENV, stdin=subprocess.PIPE,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, pass_fds=(fd,))
    os.close(fd)
    with open(os.path.join(WS, "state", "local_reconciler.pid"), "w") as f:
        f.write(str(p.pid))
    spawned.append(p)
    return p


def status():
    return json.load(open(os.path.join(WS, "state", "local_status.json")))


def ledger_qty():
    led = json.load(open(os.path.join(WS, "state", "paper_ledger.json")))
    pos = (led.get("positions") or {}).get("BTCUSDT") or {}
    return float(pos.get("qty") or 0)


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


try:
    daemon = start_daemon()

    a = send("resume", signed=False)
    check(a.get("ok") is False and "signature" in (a.get("error") or ""), "unsigned resume refused")
    a = send("amounts", {"amounts": "all of it"})
    check(a.get("ok") is False and a.get("cmd") == "amounts" and "ValueError" in a["error"]
          and set(a) == {"id", "cmd", "ok", "error", "ts"}, f"bad args → failure ack, api shape: {a}")

    a = send("credentials", {"env": {"PAPER_API_KEY": "paper", "PAPER_SECRET_KEY": "paper",
                                     "PAPER_BOUND_TS": str(int(time.time()))}})
    check(a.get("ok") and a.get("result") == {"credentials": 3, "binance": None}
          and set(a) == {"id", "cmd", "ok", "result", "ts"}, f"credentials(paper) acked: {a}")
    check(json.load(open(os.path.join(WS, "manager", "credentials.ui.json")))["ids"] == ["paper"],
          "bind manifest = [paper]")
    a = send("credentials", {"env": {"BINANCE_API_KEY": "kkkk", "BINANCE_SECRET_KEY": "ssss"}})
    # the daemon's own process opens Binance, so this reaches the permission gate
    # (check_local_real_key_gate.py covers its verdicts with a fake answer). Here
    # nothing answers — see the proxy in ENV — and no answer is "not saved".
    check(a.get("ok") is False and "not saved" in a["error"] and "URLError" in a["error"]
          and "kkkk" not in a["error"]
          and "BINANCE" not in open(os.path.join(WS, ".env")).read(),
          f"signed credentials for a real venue: unverifiable key refused by the gate: {a.get('error', '')[:90]}")
    chat = subprocess.run(
        [sys.executable, "-c",
         "from lib import venue\n"
         "try:\n venue.bind('binance', {'BINANCE_API_KEY': 'k'*20, 'BINANCE_SECRET_KEY': 's'*20})\n"
         "except ValueError as e: print('REFUSED', e)"],
        cwd=WS, env=ENV, capture_output=True, text=True, timeout=60)
    check("REFUSED" in chat.stdout and "連接交易所" in chat.stdout
          and "BINANCE" not in open(os.path.join(WS, ".env")).read(),
          f"chat bind (lib.venue.bind) of a real venue is refused on the desktop: {chat.stdout.strip()[:80]}")
    a = send("amounts", {"amounts": {"typeb": 100}})
    check(a.get("ok") is False and "Type B" in a["error"], "type B refused with a reason")
    a = send("amounts", {"amounts": {"fixed_long": 1000}})
    check(a.get("ok"), f"amounts acked: {a}")
    cfg = json.load(open(os.path.join(WS, "manager", "portfolio_config.json")))
    check(cfg["exchanges"] == {"fixed_long": "paper"}, "routing inherited the one bound venue")
    check(send("execution", {"execution": {}}).get("ok"), "execution acked")
    check(send("halt", {"reason": "before start"}, signed=False).get("ok"), "unsigned halt accepted")

    a = send("restart_reconciler")
    check(a.get("ok"), f"restart_reconciler acked: {a}")
    wait(lambda: status()["daemon"]["reconciler"]["running"], 20, "status shows the reconciler running")
    wait(lambda: os.path.isfile(os.path.join(WS, "strategies", "fixed_long", "state.json")),
         90, "scheduler thread ran the strategy (state.json)")
    time.sleep(7)  # one reconciler poll with HALT still set
    check(not os.path.exists(os.path.join(WS, "state", "paper_ledger.json")) or ledger_qty() == 0,
          "halted: no entry before resume")
    check(send("resume").get("ok"), "resume acked")
    wait(lambda: abs(ledger_qty() - 10) < 0.01, 40, "paper fill: 1000 USD / 100 = 10 BTCUSDT")
    st = wait(lambda: (lambda s: s if ((s.get("account") or {}).get("venues") or {})
                       .get("paper", {}).get("positions") else None)(status()),
              40, "status shows the paper position")
    if st:
        pv = st["account"]["venues"]["paper"]
        pos = pv["positions"].get("BTCUSDT") or {}
        check(pv["ok"] and pos.get("side") == "long" and abs(pos.get("size", 0) - 1000) < 0.01
              and abs(pv["equity"] - 99999.5) < 0.01,
              f"status: {pos}, equity {pv['equity']} (100000 − 0.05% fee)")
        check(st["halt"]["halted"] is False and st["reconciler"]["alive"]
              and st["command_listener"]["alive"] and st["scheduled"] == ["fixed_long"],
              "status: not halted, reconciler + listener alive, strategy scheduled")

    resume_id = [k for k, v in sent.items() if '\\"resume\\"' in v and '"mac": ""' not in v][-1]
    check(send("halt", {"reason": "test"}).get("ok"), "halt acked")
    os.remove(os.path.join(ACK, resume_id + ".json"))  # what an agent could do
    drop(resume_id, sent[resume_id])
    a = wait(lambda: json.load(open(os.path.join(ACK, resume_id + ".json"))), 20, "replay answered")
    check(bool(a) and a["ok"] is False and "duplicate" in a["error"]
          and os.path.exists(os.path.join(WS, "state", "HALT")),
          "replayed resume with its ack deleted: refused from memory, still halted")
    os.mkfifo(os.path.join(IN, "fifo.json"))
    os.makedirs(os.path.join(IN, "dir.json", "x"))
    done_id = [k for k in sent if os.path.exists(os.path.join(ACK, k + ".json"))
               and json.load(open(os.path.join(ACK, k + ".json")))["ok"]][0]
    drop(done_id, "junk")
    check(send("halt", {"reason": "after fifo"}, signed=False, wait_s=10).get("ok")
          and not os.path.exists(os.path.join(IN, "fifo.json")),
          "a FIFO and a directory in the queue do not wedge halt")
    check(json.load(open(os.path.join(ACK, done_id + ".json")))["ok"] is True,
          "a junk file named after a finished command cannot overwrite its ack")
    check(send("amounts", {"amounts": {"fixed_long": 3000}}).get("ok"), "amounts raised while halted")
    time.sleep(12)  # two reconciler polls
    check(abs(ledger_qty() - 10) < 0.01 and status()["halt"]["halted"] is True,
          "halted: the bigger target opens nothing")

    a = send("close_all")
    check(a.get("result") == "close_all=started", f"close_all acked: {a}")
    wait(lambda: abs(ledger_qty()) < 1e-9, 40, "close_all flattened the paper position")
    check(status()["halt"]["halted"] is True, "still halted after close_all")

    pid1 = wait(lambda: status()["daemon"]["reconciler"]["pid"], 20, "reconciler pid in status")
    os.kill(pid1, signal.SIGKILL)
    info = wait(lambda: (lambda r: r if r["running"] and r["pid"] != pid1 else None)(
        status()["daemon"]["reconciler"]), 40, "killed reconciler restarted")
    check(bool(info) and info["restarts"] == 1 and info["last_exit_code"] == -9,
          f"supervisor restarted it once: {info}")

    pid2 = info["pid"] if info else 0
    daemon.kill()  # SIGKILL: no cleanup at all
    daemon.wait(10)
    check(gone(pid2, 10), "daemon SIGKILLed → the reconciler leaves on its own (parent pipe EOF)")

    # one that outlived its daemon anyway (holds stdin open, so it never sees EOF)
    orphan = hold_lock_and_spawn([sys.executable, os.path.join(RUNTIME, "local_daemon.py"),
                                  "--run-reconciler", os.path.join("manager", "reconciler.py")], WS)
    time.sleep(3)
    check(orphan.poll() is None, "stand-in orphan is up and holds the lock")
    daemon = start_daemon()
    # our own child: reap it, or a killed one stays a zombie that kill(pid, 0) still finds
    check(bool(wait(lambda: orphan.poll() is not None, 15, "orphan exit")),
          "new daemon stops the orphan at startup")
    wait(lambda: status()["daemon"]["pid"] == daemon.pid, 20, "new daemon wrote its status")
    r = status()["daemon"]["reconciler"]
    check(r["running"] is False and r["orphan"] is False, "new daemon does not auto-start trading")
    daemon.terminate()
    daemon.wait(40)

    # same cmdline words, different cwd: not ours to kill — and nothing starts beside it
    decoy = hold_lock_and_spawn([sys.executable, "-c", "import time; time.sleep(300)",
                                 "reconciler.py"], BASE)
    daemon = start_daemon()
    wait(lambda: status()["daemon"]["pid"] == daemon.pid, 20, "daemon wrote its status")
    r = status()["daemon"]["reconciler"]
    check(decoy.poll() is None and r["running"] is True and r["orphan"] is True,
          f"lock held by a process we cannot claim: left alone, status says running/orphan: {r}")
    a = send("restart_reconciler", wait_s=60)
    check(a.get("ok") is False and decoy.poll() is None,
          f"restart refuses to start a second one: {a.get('error')}")
    decoy.kill()
    decoy.wait(10)
    a = send("restart_reconciler", wait_s=60)
    pid3 = wait(lambda: status()["daemon"]["reconciler"]["pid"], 20, "new reconciler pid in status")
    check(a.get("ok") and pid3 and alive(pid3), "lock free again → restart works")

    daemon.terminate()
    check(daemon.wait(40) == 0, "SIGTERM → exit 0")
    check(not alive(pid3), "reconciler went down with the daemon")
    # lib/events reaches the runtime through <base>/current — absent on a desktop
    # install until the daemon links it, which left every event silently dropped
    probe = subprocess.run(
        [sys.executable, "-c", "from lib import events; print(events.emit('probe', k=1))"],
        cwd=WS, env=ENV, capture_output=True, text=True, timeout=60)
    ev_path = os.path.join(WS, "state", "events.jsonl")
    check(probe.stdout.strip().isdigit() and '"probe"' in open(ev_path).read(),
          "lib.events writes state/events.jsonl on a desktop layout")
finally:
    for p in spawned:
        if p.poll() is None:
            p.kill()
    leftovers = set()
    try:
        with open(os.path.join(WS, "state", "local_reconciler.pid")) as f:
            leftovers.add(int(f.read()))
    except (OSError, ValueError):
        pass
    for name in ("pid1", "pid2", "pid3"):
        if isinstance(globals().get(name), int):
            leftovers.add(globals()[name])
    for pid in leftovers:
        if pid > 0 and alive(pid) and is_ours(pid):
            os.kill(pid, signal.SIGKILL)
    if fails:
        print(f"--- daemon log ({BASE} kept) ---")
        try:
            print(open(os.path.join(BASE, "daemon.log")).read()[-3000:])
        except OSError:
            pass
    else:
        shutil.rmtree(BASE, ignore_errors=True)
print("FAILED" if fails else "all ok")
sys.exit(1 if fails else 0)
