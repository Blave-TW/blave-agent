"""Stop reaches a turn that is busy in a tool (runtime/turn_stop.py + run_turn wiring).

What it protects:
  1. Which processes a Stop may kill: the engine, the tool shells it starts in their own
     session (Claude Code runs every Bash tool under setsid) and whatever runs inside
     them — but not a process a tool deliberately detached (start_new_session), which
     must outlive the turn.
  2. Claude path, real processes: a stub SDK spawns an "engine" whose tool shell runs a
     60s job plus a detached child. Creating the flag file ends the turn in < 2s, the
     engine and the job are dead, the detached child is alive, the sink sends `done`
     and no `error`, and the turn is written to history.
  3. A stream that never ends even with its engine gone: the cancel fallback still ends
     the turn in < 2s, as a stop and not a fault.
  4. Codex path: the real codex_engine.run against a fake `codex` that sits in a tool.
  5. No flag path in the environment = no watcher (Telegram, older launchers).
  6. web_bridge: the inbox `interrupt` for a running session creates that turn's flag
     file (a queued one is still withdrawn), and agent_turn gets the path via env.
  7. Money scripts are never killed. A fake close_symbol stopped between "cancelled the
     stop-loss" and "closed" still closes and writes the ledger — under Claude (engine
     killed at once, the script writes to a file) and under Codex (the script writes into
     Codex's pipe, so Codex is held until the script exits). A hand-written script is
     kept by the marker lib/order_* writes at import; every lib/order_*.py writes it.
     The reply and the history say what was left running; the history keeps the receipts.

claude_agent_sdk is stubbed. POSIX only (the Windows kill path is taskkill /T).
Run: cd blave-agent && python3 tests/check_turn_stop.py
"""
import asyncio, contextlib, io, json, os, re, signal, subprocess, sys, tempfile, textwrap, threading, time, types

if os.name == "nt":
    sys.exit("check_turn_stop: POSIX only")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))

_tmp = tempfile.mkdtemp(prefix="check-turn-stop-")
os.makedirs(os.path.join(_tmp, "ws"))
os.environ.update({
    "BLAVE_AGENT_WORKSPACE": os.path.join(_tmp, "ws"),
    "BLAVE_AGENT_STATE": os.path.join(_tmp, "state"),
    "BLAVE_AGENT_DB": os.path.join(_tmp, "session.db"),
})
os.environ.pop("BLAVE_PROXY_TOKEN", None)

sdk = types.ModuleType("claude_agent_sdk")


class _Obj:
    def __init__(self, **kw):
        self.__dict__.update(kw)


for _name in ("ClaudeAgentOptions", "AssistantMessage", "TextBlock", "ToolUseBlock",
              "ThinkingBlock", "ResultMessage"):
    setattr(sdk, _name, type(_name, (_Obj,), {}))
sys.modules["claude_agent_sdk"] = sdk

import agent_turn as at  # noqa: E402
import turn_stop  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f"  {detail}"))
    if not ok:
        fails.append(name)


def alive(pid):
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    try:  # a zombie still answers kill(0); it is dead for our purposes
        st = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout
        return bool(st.strip()) and not st.strip().startswith("Z")
    except OSError:
        return True


# ── 1. who gets killed ──────────────────────────────────────────────────────
# turn 100 (sid 1) → engine 101 (sid 1) → tool shell 102 (setsid) → job 103 (sid 102)
#                                                                  → flatten 104 (setsid) → 105
#               → helper 106 (sid 1)
PAIRS = [(100, 1), (101, 100), (102, 101), (103, 102), (104, 102), (105, 104), (106, 100)]
SIDS = {100: 1, 101: 1, 102: 102, 103: 102, 104: 104, 105: 104, 106: 1}
got = turn_stop.posix_targets(PAIRS, 100, SIDS.get)
check("kills engine, tool shell, job, helper — never the turn itself",
      sorted(got) == [101, 102, 103, 106], got)
check("a process a tool detached (new session under a tool) survives, with its children",
      104 not in got and 105 not in got, got)
check("descendants() is the whole subtree (Windows reports it)",
      sorted(turn_stop.descendants(PAIRS, 100)) == [101, 102, 103, 104, 105, 106])

# ── 1b. money processes are kept ────────────────────────────────────────────
TREE = [101, 102, 103, 106]   # engine → tool shell → script; helper
PAR = [(101, 100), (102, 101), (103, 102), (106, 100)]
money = {102, 103}.__contains__   # the shell's command line names close_symbol too
kill, keep = turn_stop.split_tree(TREE, PAR, money, hold_engine=False)
check("Claude: money script + its shell kept, engine and helper killed", sorted(kill) == [101, 106] and keep == {102, 103}, (kill, keep))
kill, keep = turn_stop.split_tree(TREE, PAR, {103}.__contains__, hold_engine=True)
check("Codex (hold): while a money process runs nothing in the tree is killed (engine, shell, a `| tail` sibling, helper)",
      kill == [] and keep == set(TREE), (kill, keep))
# `python3 x.py | tail` under Codex: tail is a sibling in the SAME session as the engine (no setsid)
kill, keep = turn_stop.split_tree([101, 102, 103, 104], [(101, 100), (102, 101), (103, 102), (104, 102)],
                                  {103}.__contains__, True, {101: 1, 102: 1, 103: 1, 104: 1}.get, 1)
check("Codex (hold) + `x.py | tail` in the engine's own session: tail kept", kill == [] and 104 in keep, (kill, keep))
kill, keep = turn_stop.split_tree(TREE, PAR, lambda p: False, hold_engine=True)
check("no money process: everything goes, hold or not", sorted(kill) == TREE and not keep)
# `python3 tmp/x.py | tail`: shell 102 (setsid, sid 102) → python 103 (marked) + tail 104, same session
TREE2, PAR2 = [101, 102, 103, 104, 106], [(101, 100), (102, 101), (103, 102), (104, 102), (106, 100)]
SID2 = {101: 1, 102: 102, 103: 102, 104: 102, 106: 1}
kill, keep = turn_stop.split_tree(TREE2, PAR2, {103}.__contains__, False, SID2.get, 1)
check("a money process keeps its whole tool session: the `| tail` its stdout goes to survives",
      sorted(kill) == [101, 106] and keep == {102, 103, 104}, (kill, keep))
kill, keep = turn_stop.split_tree([101, 106], [(101, 100), (106, 100)], {106}.__contains__, False, {101: 1, 106: 1}.get, 1)
check("…but never the turn's own session (that would keep the engine)", kill == [101] and keep == {106}, (kill, keep))
LBL = {"python manager/close_symbol.py XRPUSDT": "close_symbol", "python3 manager/stop_strategy.py rsi --close": "stop_strategy",
       "python -c 'from lib.order_binance import place_order'": "lib/order", "python3 manager/update_workspace.py apply": "update_workspace",
       "python lib/runner.py strategies/a/strategy.py": None, "python -c 'x.flatten()'": None, "python3 -c 'import time; time.sleep(60)'": None,
       "python3 -c 'from lib import venue; venue.bind(\"okx\", e)'": "from lib import venue",
       "python3 -c 'from lib.portfolio import zero_ledger_symbols'": "lib/portfolio",
       "python3 -c 'from lib import data, portfolio'": "from lib import data, portfolio"}
check("money rule on the command line (one place: turn_stop.MONEY_ARGV)", all(turn_stop.money_label(c) == v for c, v in LBL.items()),
      {c: turn_stop.money_label(c) for c in LBL})
import glob as _glob, re as _re
_missing = [f for f in _glob.glob(os.path.join(ROOT, "lib", "order_*.py")) if not f.endswith("TEMPLATE.py")
            and not _re.search(r"^guard\.mark_money_process\(\)", open(f, encoding="utf-8").read(), _re.M)]
check("every lib/order_*.py marks its process at import (guard.mark_money_process)", not _missing, _missing)

# ── helpers for the real-process cases ──────────────────────────────────────
ENGINE = textwrap.dedent("""
    import os, subprocess, sys, time
    # the tool shell: its own session, like Claude Code's Bash tool
    shell = subprocess.Popen([sys.executable, "-c", '''
    import subprocess, sys, time
    job = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    det = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], start_new_session=True)
    print(job.pid, det.pid, flush=True)
    job.wait()
    '''], start_new_session=True, stdout=subprocess.PIPE, text=True)
    print(shell.pid, shell.stdout.readline().strip(), flush=True)
    shell.wait()
""")


def run_turn_with_stop(sink, stop_after, **kw):
    flag = os.path.join(_tmp, f"stop-{time.monotonic_ns()}")
    os.environ[turn_stop.ENV] = flag
    timer = threading.Timer(stop_after, lambda: open(flag, "w").close())
    out, err = io.StringIO(), io.StringIO()
    timer.start()
    t0 = time.monotonic()
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            reply = asyncio.run(at.run_turn("s1", "run the long backtest", "sonnet", sink, **kw))
    finally:
        timer.cancel()
    elapsed = time.monotonic() - t0 - stop_after
    chunks = [json.loads(line[len("@@BLAVE@@"):]) for line in out.getvalue().splitlines()
              if line.startswith("@@BLAVE@@")]
    return reply, elapsed, chunks, err.getvalue()


# ── 2. Claude path ──────────────────────────────────────────────────────────
procs = {}


async def engine_query(prompt, options):
    """Stands in for sdk.query: the CLI is our child in our session; its stdout ends when it dies."""
    yield sdk.AssistantMessage(content=[sdk.ToolUseBlock(id="t1", name="Bash",
                                                         input={"command": "python lib/runner.py x"})])
    proc = await asyncio.create_subprocess_exec(sys.executable, "-c", ENGINE,
                                                stdout=asyncio.subprocess.PIPE)
    line = (await proc.stdout.readline()).decode().split()
    procs.update(engine=proc.pid, shell=int(line[0]), job=int(line[1]), detached=int(line[2]))
    await proc.stdout.read()  # EOF when the engine dies
    code = await proc.wait()
    raise RuntimeError(f"Command failed with exit code {code}")  # what the SDK raises


sdk.query = engine_query
reply, elapsed, chunks, err = run_turn_with_stop(at.LocalSink("s1"), 1.5)
types_sent = [c["type"] for c in chunks]
check("Claude: turn ends < 2s after the flag", elapsed < 2.0, f"{elapsed:.2f}s")
check("Claude: engine, tool shell and job are dead",
      procs and not any(alive(procs[k]) for k in ("engine", "shell", "job")), procs)
check("Claude: the detached child is left alone", procs and alive(procs["detached"]), procs)
check("Claude: ends with done, no error chunk", types_sent[-1:] == ["done"] and "error" not in types_sent, types_sent)
_, recent = at.ss.get_context("s1")
check("Claude: the turn is in history (user line kept)", recent and recent[-2][0] == "user", recent[-2:])
check("Claude: the variable is not left for the tools to inherit", turn_stop.ENV not in os.environ)
if procs.get("detached"):
    with contextlib.suppress(OSError):
        os.kill(procs["detached"], signal.SIGKILL)


# ── 3. stream that ignores its engine dying → cancel fallback ───────────────
async def stuck_query(prompt, options):
    yield sdk.AssistantMessage(content=[sdk.ThinkingBlock(thinking="thinking…")])
    await asyncio.sleep(60)


sdk.query = stuck_query
reply, elapsed, chunks, err = run_turn_with_stop(at.LocalSink("s1"), 0.5)
types_sent = [c["type"] for c in chunks]
check("stuck stream: cancel fallback ends the turn < 2s", elapsed < 2.0, f"{elapsed:.2f}s")
check("stuck stream: a stop, not a fault", types_sent[-1:] == ["done"] and "error" not in types_sent, types_sent)

# ── 4. Codex path (real codex_engine.run, fake binary) ──────────────────────
fake_codex = os.path.join(_tmp, "codex")
with open(fake_codex, "w") as f:
    f.write(f"#!{sys.executable}\n" + textwrap.dedent("""
        import json, subprocess, sys, time
        sys.stdin.read()
        print(json.dumps({"type": "thread.started", "thread_id": "t"}), flush=True)
        print(json.dumps({"type": "item.started", "item": {"id": "i1", "type": "command_execution",
              "command": "python lib/runner.py x", "status": "in_progress"}}), flush=True)
        tool = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], start_new_session=True)
        print(json.dumps({"type": "_pid", "pid": tool.pid}), file=sys.stderr, flush=True)
        tool.wait()
    """))
os.chmod(fake_codex, 0o755)
import codex_engine  # noqa: E402

real_popen = asyncio.create_subprocess_exec
codex_pid = {}


async def spy_exec(*args, **kw):
    kw["stderr"] = asyncio.subprocess.PIPE
    proc = await real_popen(*args, **kw)
    codex_pid["codex"] = proc.pid

    async def grab():
        line = await proc.stderr.readline()
        with contextlib.suppress(ValueError):
            codex_pid["tool"] = json.loads(line.decode())["pid"]
    asyncio.ensure_future(grab())
    return proc


codex_engine.asyncio.create_subprocess_exec = spy_exec
reply, elapsed, chunks, err = run_turn_with_stop(at.LocalSink("s1"), 1.5, engine="codex", codex_bin=fake_codex)
codex_engine.asyncio.create_subprocess_exec = real_popen
types_sent = [c["type"] for c in chunks]
check("Codex: turn ends < 2s after the flag", elapsed < 2.0, f"{elapsed:.2f}s")
check("Codex: codex and its tool are dead",
      codex_pid.get("tool") and not alive(codex_pid["codex"]) and not alive(codex_pid["tool"]), codex_pid)
check("Codex: ends with done, no error chunk", types_sent[-1:] == ["done"] and "error" not in types_sent, types_sent)


# ── 5. no flag path → no watcher ────────────────────────────────────────────
async def quick_query(prompt, options):
    yield sdk.AssistantMessage(content=[sdk.TextBlock(text="hi")])


sdk.query = quick_query
os.environ.pop(turn_stop.ENV, None)
started = []
real_start = turn_stop.start
turn_stop.start = lambda sink, **kw: started.append(real_start(sink, **kw)) or started[-1]
with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
    asyncio.run(at.run_turn("s2", "hi", "sonnet", at.LocalSink("s2")))
turn_stop.start = real_start
check("no BLAVE_TURN_INTERRUPT_FILE → no watcher", started == [None], started)

# ── 6. web_bridge: inbox `interrupt` for a running session writes that turn's flag ──
os.environ["BLAVE_AGENT_BASE"] = _tmp
import web_bridge as wb  # noqa: E402

wb.ack_message = lambda mid: None
wb._post_chunk = lambda chunk, log=False: None
wb._running.clear()
wb._running["sA"] = {"slot": None, "since": 0, "message_id": "m1",
                     "stop_file": os.path.join(wb.STOP_DIR, "a")}
wb._running["sB"] = {"slot": None, "since": 0, "message_id": "m2",
                     "stop_file": os.path.join(wb.STOP_DIR, "b")}
wb._ingest({"type": "interrupt", "message_id": "x", "session_id": "sA"})
check("bridge: Stop on a running session creates its flag file",
      os.path.exists(os.path.join(wb.STOP_DIR, "a")))
check("bridge: …and only that session's", not os.path.exists(os.path.join(wb.STOP_DIR, "b")))
wb._running.clear()
wb._queues["sC"] = [{"message_id": "m3", "session_id": "sC", "content": "hi"}]
states = []
wb._turn_state = lambda sid, st: states.append((sid, st))
wb._persist_queue = lambda: None
wb._ingest({"type": "interrupt", "message_id": "y", "session_id": "sC"})
check("bridge: Stop on a queued message still withdraws it", states == [("sC", "cancelled")]
      and "sC" not in wb._queues, states)
spawned = {}
real_popen_sync = wb.subprocess.Popen


class _Done:
    returncode = 0

    def __init__(self, cmd, env=None):
        spawned["env"] = env

    def poll(self):
        return 0


wb.subprocess.Popen = _Done
wb.run_agent_turn("sD", "hi", stop_file="/x/flag")
wb.subprocess.Popen = real_popen_sync
check("bridge: agent_turn gets the flag path in its environment",
      (spawned.get("env") or {}).get(turn_stop.ENV) == "/x/flag", spawned)

# ── 7. money scripts finish ─────────────────────────────────────────────────
WS = os.environ["BLAVE_AGENT_WORKSPACE"]
os.makedirs(os.path.join(WS, "manager"), exist_ok=True)
os.makedirs(os.path.join(WS, "lib"), exist_ok=True)
os.makedirs(os.path.join(WS, "tmp"), exist_ok=True)
import shutil as _sh
_sh.copy(os.path.join(ROOT, "lib", "guard.py"), os.path.join(WS, "lib", "guard.py"))
open(os.path.join(WS, "lib", "__init__.py"), "w").close()
# cancel the SL/TP → (Stop lands here) → close → ledger. Prints between steps, like the real one.
CLOSE = textwrap.dedent("""
    import sys, time
    {mark}
    L = sys.argv[1]
    def step(s):
        open(L, "a").write(s + "\\n"); print(s, flush=True)
    step("cancelled")
    for _ in range(12):
        time.sleep(0.2); print("waiting for the close", flush=True)
    step("closed")
    step("ledger")
""")
open(os.path.join(WS, "manager", "close_symbol.py"), "w").write(CLOSE.format(mark=""))
open(os.path.join(WS, "tmp", "adhoc.py"), "w").write(
    CLOSE.format(mark="sys.path.insert(0, %r); from lib import guard; guard.mark_money_process()" % WS))


def ledger_wait(path, want, secs):
    end = time.monotonic() + secs
    while time.monotonic() < end:
        if os.path.exists(path) and open(path).read().split() == want:
            return True
        time.sleep(0.1)
    return os.path.exists(path) and open(path).read().split() == want


def claude_money_query(script):
    async def q(prompt, options):
        yield sdk.AssistantMessage(content=[sdk.ToolUseBlock(id="t9", name="Bash", input={"command": "python " + script})])
        ledger = os.path.join(_tmp, f"ledger-{time.monotonic_ns()}")
        procs["ledger"] = ledger
        out = open(os.path.join(_tmp, "tool.out"), "w")   # Claude Code's Bash tool writes to a file
        # the real CLI's argv never carries the tool's command, so the fake takes it from env
        engine = await asyncio.create_subprocess_exec(sys.executable, "-c", textwrap.dedent(f"""
            import os, subprocess, sys
            p = subprocess.Popen([sys.executable, os.environ["FAKE_TOOL"], {ledger!r}],
                                 start_new_session=True, stdout=open({out.name!r}, "w"), stdin=subprocess.DEVNULL)
            print(p.pid, flush=True); p.wait()
        """), stdout=asyncio.subprocess.PIPE, env={**os.environ, "FAKE_TOOL": os.path.join(WS, script)})
        procs["engine"], procs["script"] = engine.pid, int((await engine.stdout.readline()).decode())
        await engine.stdout.read()
        raise RuntimeError(f"Command failed with exit code {await engine.wait()}")
    return q


for script, label in (("manager/close_symbol.py", "close_symbol"), ("tmp/adhoc.py", "下單腳本")):
    procs.clear()
    sdk.query = claude_money_query(script)
    # Stop right after "cancelled" is on disk
    flag = os.path.join(_tmp, f"stop-{time.monotonic_ns()}")
    os.environ[turn_stop.ENV] = flag

    def stopper():
        while not (procs.get("ledger") and os.path.exists(procs["ledger"])):
            time.sleep(0.02)
        open(flag, "w").close()
    threading.Thread(target=stopper, daemon=True).start()
    out = io.StringIO()
    t0 = time.monotonic()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
        asyncio.run(at.run_turn("s3", "把 XRP 平掉", "sonnet", at.LocalSink("s3"), ui_lang="zh"))
    took = time.monotonic() - t0
    chunks = [json.loads(l[len("@@BLAVE@@"):]) for l in out.getvalue().splitlines() if l.startswith("@@BLAVE@@")]
    text = "".join(c.get("text", "") for c in chunks if c["type"] == "text")
    check(f"Claude + {script}: the turn still ends promptly ({took:.1f}s)", took < 2.5, took)
    check(f"Claude + {script}: engine killed", not alive(procs["engine"]), procs)
    check(f"Claude + {script}: stopped after 'cancelled', it still closes and writes the ledger",
          ledger_wait(procs["ledger"], ["cancelled", "closed", "ledger"], 5), open(procs["ledger"]).read())
    check(f"Claude + {script}: the reply says it is finishing in the background", label in text and "背景" in text, text)
    _, recent = at.ss.get_context("s3")
    check(f"Claude + {script}: history keeps the note and the receipts", label in recent[-1][1] and "[中斷前已執行" in recent[-1][1], recent[-1])

# Codex: the script's stdout is a pipe into codex
fake_codex2 = os.path.join(_tmp, "codex2")
with open(fake_codex2, "w") as f:
    f.write(f"#!{sys.executable}\n" + textwrap.dedent(f"""
        import json, subprocess, sys
        sys.stdin.read()
        print(json.dumps({{"type": "item.started", "item": {{"id": "i1", "type": "command_execution",
              "command": "python manager/close_symbol.py", "status": "in_progress"}}}}), flush=True)
        led = {os.path.join(_tmp, "ledger-codex")!r}
        p = subprocess.Popen([sys.executable, {os.path.join(WS, "manager", "close_symbol.py")!r}, led],
                             stdout=subprocess.PIPE, text=True, start_new_session=True)
        for line in p.stdout:   # codex relays the command's output as events
            print(json.dumps({{"type": "item.updated", "item": {{"id": "i1", "type": "command_execution",
                  "aggregated_output": line, "status": "in_progress"}}}}), flush=True)
        p.wait()
        import time; time.sleep(60)
    """))
os.chmod(fake_codex2, 0o755)
led = os.path.join(_tmp, "ledger-codex")
flag = os.path.join(_tmp, f"stop-{time.monotonic_ns()}")
os.environ[turn_stop.ENV] = flag
def stopper2():
    while not os.path.exists(led):
        time.sleep(0.02)
    open(flag, "w").close()
threading.Thread(target=stopper2, daemon=True).start()
out = io.StringIO()
t0 = time.monotonic()
with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
    asyncio.run(at.run_turn("s4", "把 XRP 平掉", "sonnet", at.LocalSink("s4"), engine="codex", codex_bin=fake_codex2, ui_lang="zh"))
took = time.monotonic() - t0
chunks = [json.loads(l[len("@@BLAVE@@"):]) for l in out.getvalue().splitlines() if l.startswith("@@BLAVE@@")]
check("Codex + close_symbol: stopped after 'cancelled', it still closes and writes the ledger (no broken pipe)",
      ledger_wait(led, ["cancelled", "closed", "ledger"], 1), open(led).read())
check(f"Codex + close_symbol: the turn ends once the script is done, not 60s later ({took:.1f}s)", took < 6, took)
check("Codex + close_symbol: pings while holding (the shell's fallback waits for silence)", any(c["type"] == "ping" for c in chunks))
check("Codex + close_symbol: done, no error", chunks[-1]["type"] == "done" and not any(c["type"] == "error" for c in chunks), [c["type"] for c in chunks])

# `python3 tmp/adhoc.py | tail -3` under Claude: tail shares the tool session and must live
procs.clear()
led_tail = os.path.join(_tmp, "ledger-tail")
async def tail_query(prompt, options):
    engine = await asyncio.create_subprocess_exec(sys.executable, "-c", textwrap.dedent(f"""
        import os, subprocess, sys
        p = subprocess.Popen(["/bin/sh", "-c", os.environ["FAKE_CMD"]], start_new_session=True,
                             stdout=open({os.path.join(_tmp, "tail.out")!r}, "w"), stdin=subprocess.DEVNULL)
        print(p.pid, flush=True); p.wait()
    """), stdout=asyncio.subprocess.PIPE,
        env={**os.environ, "FAKE_CMD": f"{sys.executable} {os.path.join(WS, 'tmp', 'adhoc.py')} {led_tail} | tail -3"})
    procs["engine"] = engine.pid
    await engine.stdout.readline()
    yield sdk.AssistantMessage(content=[sdk.ToolUseBlock(id="t8", name="Bash", input={"command": "python3 tmp/adhoc.py | tail -3"})])
    await engine.stdout.read()
    raise RuntimeError("Command failed with exit code -9")
sdk.query = tail_query
flag = os.path.join(_tmp, f"stop-{time.monotonic_ns()}")
os.environ[turn_stop.ENV] = flag
def stopper3():
    while not os.path.exists(led_tail):
        time.sleep(0.02)
    open(flag, "w").close()
threading.Thread(target=stopper3, daemon=True).start()
with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
    asyncio.run(at.run_turn("s5", "平掉", "sonnet", at.LocalSink("s5"), ui_lang="zh"))
check("Claude + `adhoc.py | tail`: stopped mid-close, it still closes and writes the ledger (tail kept)",
      ledger_wait(led_tail, ["cancelled", "closed", "ledger"], 5), open(led_tail).read())
check("Claude + `adhoc.py | tail`: engine killed", not alive(procs["engine"]))

# /report piggyback (web): the loop breaks at the block boundary, maybe before the watcher's
# first sweep — the final sweep still kills the CLI and a plain tool, and spares the money one
procs.clear()
led_pb = os.path.join(_tmp, "ledger-pb")
class PiggySink(at.WebSink):
    def __init__(self):
        super().__init__("http://x/report", "t", "s6"); self.sent = []
    def _send(self, chunk):
        self.sent.append(dict(chunk))
        if chunk["type"] == "tool":
            self.interrupted = True   # what /report's `interrupt: true` does
async def piggy_query(prompt, options):
    engine = await asyncio.create_subprocess_exec(sys.executable, "-c", textwrap.dedent(f"""
        import os, subprocess, sys
        job = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], start_new_session=True)
        m = subprocess.Popen([sys.executable, os.environ["FAKE_TOOL"], {led_pb!r}], start_new_session=True,
                             stdout=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
        print(job.pid, flush=True); m.wait(); job.wait()
    """), stdout=asyncio.subprocess.PIPE, env={**os.environ, "FAKE_TOOL": os.path.join(WS, "tmp", "adhoc.py")})
    procs["engine"], procs["job"] = engine.pid, int((await engine.stdout.readline()).decode())
    while not os.path.exists(led_pb):
        await asyncio.sleep(0.02)
    yield sdk.AssistantMessage(content=[sdk.ToolUseBlock(id="t7", name="Bash", input={"command": "python3 tmp/adhoc.py"})])
    await asyncio.sleep(60)
sdk.query = piggy_query
os.environ[turn_stop.ENV] = os.path.join(_tmp, "never-created")
with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
    asyncio.run(at.run_turn("s6", "平掉", "sonnet", PiggySink(), ui_lang="zh"))
check("piggyback stop: CLI and the plain tool are dead when the turn returns",
      not alive(procs["engine"]) and not alive(procs["job"]), procs)
check("piggyback stop: the money script still finishes", ledger_wait(led_pb, ["cancelled", "closed", "ledger"], 5), open(led_pb).read())

# Codex hold is capped: a money script that outlives HOLD_MAX_S no longer holds the turn
turn_stop.HOLD_MAX_S = 1.0
long_codex = os.path.join(_tmp, "codex3")
long_pid = os.path.join(_tmp, "codex3.pid")
with open(long_codex, "w") as f:
    f.write(f"#!{sys.executable}\n" + textwrap.dedent(f"""
        import json, subprocess, sys, time
        sys.stdin.read()
        p = subprocess.Popen([sys.executable, "-c", "import time\\nwhile True: print('tick', flush=True); time.sleep(0.2)",
                              "manager/reconciler.py"], stdout=subprocess.PIPE, text=True, start_new_session=True)
        open({long_pid!r}, "w").write(str(p.pid))
        print(json.dumps({{"type": "item.started", "item": {{"id": "i1", "type": "command_execution",
              "command": "python manager/reconciler.py", "status": "in_progress"}}}}), flush=True)
        for line in p.stdout:
            print(json.dumps({{"type": "item.updated", "item": {{"id": "i1", "type": "command_execution",
                  "aggregated_output": line, "status": "in_progress"}}}}), flush=True)
    """))
os.chmod(long_codex, 0o755)
flag = os.path.join(_tmp, f"stop-{time.monotonic_ns()}")
os.environ[turn_stop.ENV] = flag
threading.Timer(0.8, lambda: open(flag, "w").close()).start()
out = io.StringIO()
t0 = time.monotonic()
with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
    asyncio.run(at.run_turn("s7", "跑對帳", "sonnet", at.LocalSink("s7"), engine="codex", codex_bin=long_codex, ui_lang="zh"))
took = time.monotonic() - t0 - 0.8
text = "".join(json.loads(l[9:]).get("text", "") for l in out.getvalue().splitlines() if l.startswith("@@BLAVE@@"))
check(f"Codex hold is capped: the turn ends shortly after HOLD_MAX_S ({took:.1f}s)", took < 3.5, took)
check("…and the reply says it was no longer waited on", "不再等它" in text and "reconciler.py" in text, text)
# By pid, never by name: `pkill -f manager/reconciler.py` reaches every reconciler on the
# machine — a desktop app trading next to this test run lost its order daemon each time.
with contextlib.suppress(OSError, ValueError):
    os.kill(int(open(long_pid).read()), signal.SIGKILL)
_by_name = [n for n in sorted(os.listdir(os.path.join(ROOT, "tests"))) if n.endswith((".py", ".js"))
            and re.search(r"""["'](?:pkill|killall)["']""", open(os.path.join(ROOT, "tests", n), encoding="utf-8").read())]
check("no test ends processes by name", _by_name == [], _by_name)
turn_stop.HOLD_MAX_S = 120

print("\n" + ("ALL PASS" if not fails else f"{len(fails)} FAILED: {fails}"))
sys.exit(1 if fails else 0)
