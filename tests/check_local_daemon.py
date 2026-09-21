"""runtime/local_daemon.py — the gates, no network, no daemon chain (that one is
check_local_daemon_chain.py).

  1. ALLOWED is the api's ALLOWED, item for item (needs ../api side by side).
  2. parse_command: unknown command / bad id / oversize / unsigned / forged /
     stale / replayed are refused, and no refusal echoes a value from the file;
     `halt` is the only unsigned command.
  3. Single instance: a second daemon on the same workspace exits 3; no
     BLAVE_AGENT_LOCAL=1 from the caller, or a <base>/control next to it (a
     cloud box), and it refuses to start at all.
  4. Cloud unchanged: with BLAVE_AGENT_LOCAL unset the listener still resolves
     `python3`, still uses the bare allowlist env and still talks to crontab —
     whatever the OS says it is; with it set, none of that happens and Type B
     is refused by name.
Run: cd blave-agent && .venv/bin/python tests/check_local_daemon.py
"""
import ast
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNTIME = os.path.join(ROOT, "runtime")
BASE = tempfile.mkdtemp(prefix="local-daemon-")
WS = os.path.join(BASE, "workspace")
os.makedirs(os.path.join(WS, "manager"))
os.makedirs(os.path.join(WS, "strategies", "typea"))
os.makedirs(os.path.join(WS, "strategies", "typeb"))
open(os.path.join(WS, "manager", "wait_for_bar.py"), "w").write("")
open(os.path.join(WS, "strategies", "typea", "strategy.py"), "w").write('INTERVAL = "1h"\n')
open(os.path.join(WS, "strategies", "typeb", "strategy.py"), "w").write("x = 1\n")
os.environ["BLAVE_AGENT_BASE"] = BASE
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.pop("BLAVE_AGENT_LOCAL", None)
sys.path.insert(0, RUNTIME)
import local_daemon as ld  # noqa: E402
import command_listener as cl  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


# ── 1. whitelist sync ────────────────────────────────────────────────────────
API = os.path.join(ROOT, "..", "api", "openclaw", "agent_command.py")
if os.path.isfile(API):
    api_allowed = None
    for node in ast.parse(open(API, encoding="utf-8").read()).body:
        if isinstance(node, ast.Assign) and getattr(node.targets[0], "id", "") == "ALLOWED":
            api_allowed = set(ast.literal_eval(node.value))
    check(api_allowed == set(ld.ALLOWED),
          f"ALLOWED == api's ALLOWED (diff: {sorted(set(ld.ALLOWED) ^ (api_allowed or set()))})")
else:
    print("skip whitelist sync — needs the monorepo layout (../api)")
check(set(ld.ALLOWED) <= set(cl.HANDLERS), "every allowed command has a handler")
check("telegram_reset" not in ld.ALLOWED, "telegram_reset stays out, as in the api")
check(ld.UNSIGNED_OK == {"halt"}, "halt is the only unsigned command")

# ── 2. parse_command ─────────────────────────────────────────────────────────
SECRET = "s" * 40
NOW = 1_800_000_000


def cmd_file(cid, cmd, args=None, ts=NOW, secret=SECRET, **over):
    body = json.dumps({"id": cid, "cmd": cmd, "args": args or {}, "ts": ts})
    doc = {"body": body, "mac": ld.sign(secret, body) if secret else None}
    doc.update(over)
    return json.dumps(doc).encode()


def refused(raw, stem, why, secret=SECRET, seen=lambda c: False, not_before=0):
    try:
        ld.parse_command(raw, stem, secret, NOW, seen, not_before)
    except ld.Rejected as e:
        check("TOPSECRET" not in str(e), f"refused: {why} ({e})")
        return
    check(False, f"refused: {why}")


ok = ld.parse_command(cmd_file("a1", "resume"), "a1", SECRET, NOW, lambda c: False)
check(ok == {"id": "a1", "cmd": "resume", "args": {}}, "signed command parses to {id, cmd, args}")
refused(cmd_file("a1", "TOPSECRET"), "a1", "unknown command")
refused(cmd_file("a1", "telegram_reset"), "a1", "telegram_reset")
refused(cmd_file("../x", "resume"), "../x", "path-shaped id")
refused(cmd_file("a1", "resume"), "a2", "id != file name")
refused(cmd_file("a1", "resume", {"pad": "x" * ld.MAX_BYTES}), "a1", "oversize")
refused(b"{not json", "a1", "not JSON")
refused(cmd_file("a1", "resume", secret=None), "a1", "unsigned resume")
refused(cmd_file("a1", "amounts", {"amounts": {"x": 1}}, secret="w" * 40), "a1", "wrong secret")
refused(cmd_file("a1", "resume"), "a1", "daemon started without a secret", secret="")
forged = json.loads(cmd_file("a1", "halt"))
forged["body"] = forged["body"].replace('"halt"', '"resume"')
refused(json.dumps(forged).encode(), "a1", "body edited after signing")
refused(cmd_file("a1", "resume", ts=NOW - ld.TS_WINDOW_S - 1), "a1", "stale ts")
refused(cmd_file("a1", "resume", ts=True), "a1", "bool ts")
refused(cmd_file("a1", "resume"), "a1", "replayed id", seen=lambda c: c == "a1")
refused(cmd_file("a1", "resume", ts=NOW - 5), "a1", "signed before this daemon started",
        not_before=NOW - 2)
halt = ld.parse_command(cmd_file("h1", "halt", secret=None), "h1", "", NOW, lambda c: False)
check(halt["cmd"] == "halt", "unsigned halt accepted, even by a daemon with no secret")

# ── 3. single instance / where it agrees to run ──────────────────────────────
DAEMON = [sys.executable, os.path.join(RUNTIME, "local_daemon.py")]
ENV = dict(os.environ, BLAVE_AGENT_BASE=BASE, BLAVE_AGENT_WORKSPACE=WS, BLAVE_AGENT_LOCAL="1")
procs = []


def spawn(*args, **kw):
    p = subprocess.Popen(DAEMON + list(args), env=ENV, stderr=subprocess.DEVNULL, **kw)
    procs.append(p)
    return p


try:
    first = spawn(stdin=subprocess.DEVNULL)
    lock = os.path.join(WS, "state", "local_daemon.lock")
    for _ in range(100):
        if os.path.isfile(os.path.join(WS, "state", "local_status.json")):
            break
        time.sleep(0.1)
    second = subprocess.run(DAEMON, env=ENV, stdin=subprocess.DEVNULL, capture_output=True,
                            text=True, timeout=30)
    check(second.returncode == 3, f"second daemon on the same workspace exits 3 (got {second.returncode})")
    check(open(lock).read() == str(first.pid), "lock file names the owner")
    check(os.path.realpath(os.path.join(BASE, "current")) == os.path.realpath(RUNTIME),
          "<base>/current links to the runtime dir")
    status = json.load(open(os.path.join(WS, "state", "local_status.json")))
    check(status["daemon"]["pid"] == first.pid and status["daemon"]["signed"] is False
          and status["daemon"]["reconciler"]["running"] is False,
          "status: daemon block present, reconciler NOT auto-started")
    first.terminate()
    check(first.wait(30) == 0, "SIGTERM → clean exit 0")
    short = subprocess.run(DAEMON + ["--secret-stdin"], env=ENV, input="tooshort\n",
                           capture_output=True, text=True, timeout=30)
    check(short.returncode == 2, "a short secret is refused")
    owned = spawn("--secret-stdin", stdin=subprocess.PIPE)
    owned.stdin.write(b"k" * 40 + b"\n")
    owned.stdin.flush()
    time.sleep(2)
    check(owned.poll() is None, "daemon stays up while the parent holds stdin")
    owned.stdin.close()
    check(owned.wait(30) == 0, "parent gone (stdin EOF) → daemon shuts itself down")
finally:
    for p in procs:
        if p.poll() is None:
            p.kill()
            p.wait(10)


def start_rc(env):
    return subprocess.run(DAEMON, env=env, stdin=subprocess.DEVNULL, capture_output=True,
                          timeout=30).returncode


check(start_rc({k: v for k, v in ENV.items() if not k.startswith("BLAVE_AGENT_BASE")
                and not k.startswith("BLAVE_AGENT_WORKSPACE")}) == 2,
      "no BLAVE_AGENT_BASE/WORKSPACE → refuses to start (no /opt fallback)")
os.remove(os.path.join(BASE, "current"))
check(start_rc({k: v for k, v in ENV.items() if k != "BLAVE_AGENT_LOCAL"}) == 2
      and not os.path.lexists(os.path.join(BASE, "current")),
      "caller did not set BLAVE_AGENT_LOCAL=1 → refuses, <base>/current untouched")
os.makedirs(os.path.join(BASE, "control"))
check(start_rc(ENV) == 2 and not os.path.lexists(os.path.join(BASE, "current")),
      "<base>/control exists (cloud box) → refuses, <base>/current untouched")
os.rmdir(os.path.join(BASE, "control"))

# ── 4. cloud unchanged without the switch; local with it ─────────────────────
calls = []


class _Done:
    returncode, stdout, stderr = 0, "", ""


def _fake_run(argv, *a, **kw):
    calls.append((list(argv), kw))
    return _Done()


real_run, real_system = cl.subprocess.run, cl.platform.system
cl.subprocess.run = _fake_run
os.environ["BLAVE_PROXY_TOKEN_PROBE"] = "x"
os.environ["BLAVE_KLINE_SOURCE"] = "binance"
for os_name in ("Linux", "Darwin"):  # a cloud box is Linux; a dev Mac lands in the same branch
    cl.platform.system = lambda n=os_name: n
    calls.clear()
    cl._tick_one("typea")
    check(calls[0][0][0] == "python3", f"[{os_name}, cloud] tick interpreter is PATH python3")
    env = calls[0][1]["env"]
    check(set(env) <= {"PATH", "HOME", "LANG", "USER", "SHELL", "BLAVE_MODE"},
          f"[{os_name}, cloud] strategy env is the bare allowlist")
    calls.clear()
    cl._sync_strategy_crons({"typeb"})
    check([c[0][:2] for c in calls] == [["crontab", "-l"], ["crontab", "-"]],
          f"[{os_name}, cloud] type B still goes through crontab")
    calls.clear()
    cl._migrate_legacy_ac_crons()
    cl._sweep_legacy_report_schedules()
    check(len(calls) == 2 and all(c[0] == ["crontab", "-l"] for c in calls),
          f"[{os_name}, cloud] both legacy sweeps still read crontab")
    check(cl._manage_argv("manager.py", ["a"], None, {})[0] == "python3",
          f"[{os_name}, cloud] manage argv interpreter is python3")

popens = []


class _P:
    pid = 1


def _fake_popen(argv, *a, **kw):
    popens.append((list(argv), kw))
    return _P()


class _NoHost:
    def __getattr__(self, name):
        raise AssertionError("cloud path consulted the local host")


real_popen = cl.subprocess.Popen
cl.subprocess.Popen = _fake_popen
cl._LOCAL_HOST = _NoHost()
sys.path.insert(0, ROOT)  # lib.guard for close_all's halt
open(os.path.join(WS, "manager", "flatten.py"), "w").write("")
cl.platform.system = lambda: "Linux"
check(cl._in_workspace(cl._cmd_close_all, {}) == "close_all=started"
      and popens[-1][0] == ["python3", "manager/flatten.py"]
      and [k for k in popens[-1][1]["env"] if k.startswith("BLAVE_")] == ["BLAVE_AGENT_WORKSPACE"],
      "[cloud] close_all: python3 + denylist env")
os.remove(os.path.join(WS, "state", "HALT"))
cl._cmd_retest_accounts({})
check(popens[-1][0] == ["/usr/bin/python3", os.path.join(BASE, "current", "account_reader.py")]
      and "env" not in popens[-1][1], "[cloud] retest_accounts: /usr/bin/python3, inherited env")
calls.clear()
check(cl._stop_reconciler() is True and [c[0][:2] for c in calls] ==
      [["tmux", "has-session"], ["tmux", "kill-session"]], "[cloud] stop_reconciler asks tmux/systemd")
calls.clear()
check(cl._cmd_restart_reconciler({}) == "reconciler restarted (tmux fallback)"
      and calls[-1][0][:2] == ["tmux", "new-session"]
      and "bash manager/start_reconciler.sh" in calls[-1][0][-1],
      "[cloud] restart_reconciler starts start_reconciler.sh under tmux")
calls.clear()
cl._purge_strategy_schedules(["typeb"])
check([c[0] for c in calls] == [["crontab", "-l"]], "[cloud] purge still reads crontab")
cl.platform.system = real_system
cl._LOCAL_HOST = None

os.environ["BLAVE_AGENT_LOCAL"] = "1"
cl._in_workspace(cl._cmd_close_all, {})
check(popens[-1][0] == [sys.executable, "manager/flatten.py"]
      and popens[-1][1]["env"].get("BLAVE_AGENT_BASE") == BASE, "[local] close_all: sys.executable + local env")
os.remove(os.path.join(WS, "state", "HALT"))
cl._cmd_retest_accounts({})
check(popens[-1][0][0] == sys.executable, "[local] retest_accounts: sys.executable")
for env_keys, why in (({"BINANCE_API_KEY": "k", "BINANCE_SECRET_KEY": "s"}, "real venue"),
                      ({"OPENAI_API_KEY": "k"}, "lone service key")):
    try:
        cl._cmd_credentials({"env": env_keys})
        check(False, f"[local] credentials refuses a {why}")
    except ValueError as e:
        check("模擬交易" in str(e) and not os.path.exists(os.path.join(WS, ".env")),
              f"[local] credentials refuses a {why}, .env untouched")
check(cl.LOCAL_OPEN_VENUES == {"PAPER"}, "[local] the open-venue switch is paper only")
cl.subprocess.Popen = real_popen
calls.clear()
cl._tick_one("typea")
check(calls[0][0][0] == sys.executable, "[local] tick interpreter is sys.executable")
env = calls[0][1]["env"]
check(env.get("BLAVE_AGENT_BASE") == BASE and env.get("BLAVE_KLINE_SOURCE") == "binance"
      and env.get("BLAVE_MODE") == "live" and "BLAVE_PROXY_TOKEN_PROBE" not in env
      and "BLAVE_AGENT_LOCAL" not in env,
      "[local] child env: paths + kline source pass, other BLAVE_* do not")
calls.clear()
cl._sync_strategy_crons({"typea", "typeb"})
cl._migrate_legacy_ac_crons()
cl._sweep_legacy_report_schedules()
cl._purge_strategy_schedules(["typeb"])
check(calls == [], "[local] the user's crontab is never read or written")
import portfolio_reporter as pr  # noqa: E402
pr.subprocess.run = _fake_run
check(pr.scheduled_strategies() == set() and calls == [], "[local] reporter skips crontab too")
try:
    cl._cmd_amounts({"amounts": {"typea": 100, "typeb": 100}})
    check(False, "[local] type B refused by amounts")
except ValueError as e:
    check("typeb" in str(e) and not os.path.exists(os.path.join(WS, "manager", "portfolio_config.json")),
          "[local] type B refused by amounts, nothing written")
try:
    cl._cmd_restart_reconciler({})
    check(False, "[local] restart without a daemon host raises")
except RuntimeError:
    check(True, "[local] restart without a daemon host raises")
check(cl._stop_reconciler() is False, "[local] stop without a daemon host = not confirmed")
cl.subprocess.run, cl.platform.system = real_run, real_system
pr.subprocess.run = real_run

# — events window slides: nothing acks locally, so without this the status file
#   shows the oldest MAX_SEND events forever and newer ones never surface —
import importlib
ev_mod = importlib.import_module("events")
ld_mod = importlib.import_module("local_daemon")
for p_ in (ev_mod.EVENTS_PATH, ev_mod.ACKED_PATH):
    if os.path.exists(p_):
        os.remove(p_)
ids = [ev_mod.append("order_error", {"symbol": "BTCUSDT", "n": i}) for i in range(ev_mod.MAX_SEND + 30)]
first = ev_mod.unsent()
check(len(first) == ev_mod.MAX_SEND and first[-1]["id"] < ids[-1], "[events] full window = oldest MAX_SEND, newest not visible")
ld_mod._slide_events(ev_mod, first[:10])
check(ev_mod.load_acked() == 0, "[events] window not full → mark untouched")
ld_mod._slide_events(ev_mod, first)
second = ev_mod.unsent()
check(second and second[-1]["id"] == ids[-1], "[events] after sliding, the newest event is in the window")
check(second[0]["id"] == first[len(first) // 2]["id"], "[events] slides by half, nothing skipped")
ld_mod._slide_events(ev_mod, [{"no": "id"}] * ev_mod.MAX_SEND)
check(True, "[events] malformed window does not raise")
# byte cap truncates the window short of MAX_SEND lines: it must still slide
for p_ in (ev_mod.EVENTS_PATH, ev_mod.ACKED_PATH):
    if os.path.exists(p_):
        os.remove(p_)
# (lines stay under 4KB: events._last_id only reads the file's last 4KB)
big = [ev_mod.append("order_error", {"pad": "x" * 3400, "n": i}) for i in range(90)]
cut = ev_mod.unsent()
check(20 <= len(cut) < ev_mod.MAX_SEND and cut[-1]["id"] < big[-1], "[events] byte cap cuts the window short of MAX_SEND")
ld_mod._slide_events(ev_mod, cut)
check(ev_mod.load_acked() == cut[len(cut) // 2 - 1]["id"], "[events] a byte-truncated window slides too")
# a complete window (nothing newer in the file) never slides
tail_ = ev_mod.unsent()
for _ in range(20):
    if tail_[-1]["id"] >= big[-1]:
        break
    ld_mod._slide_events(ev_mod, tail_)
    tail_ = ev_mod.unsent()
check(tail_[-1]["id"] == big[-1], "[events] sliding reaches the newest event")
mark_ = ev_mod.load_acked()
ld_mod._slide_events(ev_mod, tail_)
check(ev_mod.load_acked() == mark_, "[events] complete window (file has nothing newer) → mark untouched")

shutil.rmtree(BASE, ignore_errors=True)
print("FAILED" if fails else "all ok")
sys.exit(1 if fails else 0)
