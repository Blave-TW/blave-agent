"""Stop reaches a turn that is busy in a tool (runtime/turn_stop.py + run_turn wiring).

What it protects:
  1. Which processes a Stop may kill: the engine, the tool shells it starts in their own
     session (Claude Code runs every Bash tool under setsid) and whatever runs inside
     them — but not a process a tool deliberately detached (start_new_session), which
     must outlive the turn.
  2. Claude path, real processes: a stub SDK spawns an "engine" whose tool shell runs a
     60s job plus a detached child. Creating the flag file ends the turn in < 2s, the
     engine and the job are dead, the detached child is alive, the sink sends `done`
     and no `error`, and the turn is written to history. Every fake engine carries the
     real CLI's `--disallowedTools` (it names lib/president_worker.py): the engine's own
     command line must not make it a money process.
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
  8. Windows (Toolhelp / TerminateProcess swapped for POSIX stand-ins): under Codex a marked
     money script holds Codex until it is done; markers are checked against the table, never
     with os.kill(pid, 0) (TerminateProcess there); no money script = Codex killed at once.
     Fail-closed: an unreadable table (Windows or ps) holds Codex; a marker that appears while
     the handles are opened cancels the kill; a dead pid's marker is cleared.
  9. agent_turn and the runtime modules it imports spawn nothing but the engine and its
     probes (static): kill_tree does not match a direct child's argv.

claude_agent_sdk is stubbed. POSIX only (the Windows path runs with Toolhelp / TerminateProcess stubbed).
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


def cli_argv(options):
    """The flags the SDK puts on the real CLI's command line (subprocess_cli: --disallowedTools
    joined by commas). They name lib/president_worker.py etc., so a fake engine without them
    hid that Stop spared the CLI and every tool under it."""
    return ["--disallowedTools", ",".join(options.disallowed_tools)]


async def engine_query(prompt, options):
    """Stands in for sdk.query: the CLI is our child in our session; its stdout ends when it dies."""
    yield sdk.AssistantMessage(content=[sdk.ToolUseBlock(id="t1", name="Bash",
                                                         input={"command": "python lib/runner.py x"})])
    procs["argv"] = cli_argv(options)
    proc = await asyncio.create_subprocess_exec(sys.executable, "-c", ENGINE, *procs["argv"],
                                                stdout=asyncio.subprocess.PIPE)
    line = (await proc.stdout.readline()).decode().split()
    procs.update(engine=proc.pid, shell=int(line[0]), job=int(line[1]), detached=int(line[2]))
    await proc.stdout.read()  # EOF when the engine dies
    code = await proc.wait()
    raise RuntimeError(f"Command failed with exit code {code}")  # what the SDK raises


sdk.query = engine_query
reply, elapsed, chunks, err = run_turn_with_stop(at.LocalSink("s1"), 1.5)
types_sent = [c["type"] for c in chunks]
check("Claude: the engine's argv carries the protected-file rules (MONEY_ARGV matches it)",
      bool(turn_stop.money_label(" ".join(procs.get("argv", [])))), procs.get("argv"))
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
wb._turn_state = lambda sid, st, **kw: states.append((sid, st))
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
_sh.copy(os.path.join(ROOT, "lib", "winreplace.py"), os.path.join(WS, "lib", "winreplace.py"))
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
open(os.path.join(WS, "lib", "president_worker.py"), "w").write(CLOSE.format(mark=""))
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
        """), *cli_argv(options), stdout=asyncio.subprocess.PIPE, env={**os.environ, "FAKE_TOOL": os.path.join(WS, script)})
        procs["engine"], procs["script"] = engine.pid, int((await engine.stdout.readline()).decode())
        await engine.stdout.read()
        raise RuntimeError(f"Command failed with exit code {await engine.wait()}")
    return q


for script, label in (("manager/close_symbol.py", "close_symbol"), ("lib/president_worker.py", "president_worker"),
                      ("tmp/adhoc.py", "下單腳本")):
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
    """), *cli_argv(options), stdout=asyncio.subprocess.PIPE,
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
    """), *cli_argv(options), stdout=asyncio.subprocess.PIPE, env={**os.environ, "FAKE_TOOL": os.path.join(WS, "tmp", "adhoc.py")})
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

# ── 8. Windows: Codex is held for a money script too (nt_plan) ──────────────
# Toolhelp has no command lines: only the lib/guard markers count, checked against the table
# (os.kill(pid, 0) is TerminateProcess there). Engine 201 → shell 202 → script 203; 301 elsewhere.
WPAIRS = [(201, 200), (202, 201), (203, 202), (301, 1)]
check("Windows + Codex: a marked script under the engine → nothing killed, labelled",
      turn_stop.nt_plan(WPAIRS, 200, {203}, True) == ([], ["order script"]))
check("Windows + Codex: a marker outside this turn (or left by a dead pid) does not hold",
      turn_stop.nt_plan(WPAIRS, 200, {301, 999}, True) == ([201], []))
check("Windows + Claude: the engine goes even with a marked tool (its tools write to files)",
      turn_stop.nt_plan(WPAIRS, 200, {203}, False) == ([201], []))

_NT_NAMES = ("_NT", "_windows_pairs", "_taskkill", "_nt_open", "_nt_terminate", "_nt_close", "_money_pids")
_real = {n: getattr(turn_stop, n, None) for n in _NT_NAMES}
_terminated = []
turn_stop._NT = True
turn_stop._windows_pairs = lambda: turn_stop._posix_table()[0]
# TerminateProcess on one pid, never the tree (/T); _taskkill is what the older code called
def _sigkill(pid):
    _terminated.append(pid)
    with contextlib.suppress(OSError):
        os.kill(pid, signal.SIGKILL)
    return True


turn_stop._taskkill = _sigkill
turn_stop._nt_open = lambda pid: pid
turn_stop._nt_terminate = _sigkill
turn_stop._nt_close = lambda h: None


def _no_kill0():
    raise AssertionError("_money_pids (os.kill(pid, 0)) called on Windows")


turn_stop._money_pids = _no_kill0
led_w = os.path.join(_tmp, "ledger-win")
fake_codex_w = os.path.join(_tmp, "codex-win")
with open(fake_codex_w, "w") as f:
    f.write(f"#!{sys.executable}\n" + textwrap.dedent(f"""
        import json, subprocess, sys
        sys.stdin.read()
        print(json.dumps({{"type": "item.started", "item": {{"id": "i1", "type": "command_execution",
              "command": "python tmp/adhoc.py", "status": "in_progress"}}}}), flush=True)
        p = subprocess.Popen([sys.executable, {os.path.join(WS, "tmp", "adhoc.py")!r}, {led_w!r}],
                             stdout=subprocess.PIPE, text=True)
        for line in p.stdout:
            print(json.dumps({{"type": "item.updated", "item": {{"id": "i1", "type": "command_execution",
                  "aggregated_output": line, "status": "in_progress"}}}}), flush=True)
        p.wait()
        import time; time.sleep(60)
    """))
os.chmod(fake_codex_w, 0o755)
_codex_w_src = open(fake_codex_w).read()
flag = os.path.join(_tmp, f"stop-{time.monotonic_ns()}")
os.environ[turn_stop.ENV] = flag
def stopper_w():
    while not os.path.exists(led_w):
        time.sleep(0.02)
    open(flag, "w").close()
threading.Thread(target=stopper_w, daemon=True).start()
out, err = io.StringIO(), io.StringIO()
t0 = time.monotonic()
with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
    asyncio.run(at.run_turn("s8", "把 XRP 平掉", "sonnet", at.LocalSink("s8"), engine="codex", codex_bin=fake_codex_w, ui_lang="zh"))
took = time.monotonic() - t0
chunks = [json.loads(l[len("@@BLAVE@@"):]) for l in out.getvalue().splitlines() if l.startswith("@@BLAVE@@")]
check("Windows + Codex + marked script: stopped after 'cancelled', it still closes and writes the ledger",
      ledger_wait(led_w, ["cancelled", "closed", "ledger"], 1), open(led_w).read())
check(f"Windows + Codex: the turn ends once the script is done, not 60s later ({took:.1f}s)", took < 6, took)
check("Windows + Codex: pings while holding", any(c["type"] == "ping" for c in chunks))
check("Windows: os.kill(pid, 0) never used", "_money_pids (os.kill" not in err.getvalue(), err.getvalue()[-300:])

codex_pid.clear()
codex_engine.asyncio.create_subprocess_exec = spy_exec
reply, elapsed, chunks, err = run_turn_with_stop(at.LocalSink("s9"), 1.5, engine="codex", codex_bin=fake_codex)
codex_engine.asyncio.create_subprocess_exec = real_popen
check("Windows + Codex, no money script: Codex is killed and the turn ends < 2s", elapsed < 2.0
      and codex_pid.get("codex") and not alive(codex_pid["codex"]), (elapsed, codex_pid))
with contextlib.suppress(OSError, TypeError):
    os.kill(codex_pid.get("tool"), signal.SIGKILL)   # Windows leaves the tools to finish; by pid

# Fail-closed (re-audit c30009c B1): an unreadable process table under Codex holds, never frees
def _no_table():
    raise OSError("CreateToolhelp32Snapshot failed")


_terminated.clear()
turn_stop._windows_pairs = _no_table
check("Windows + Codex, table unreadable: nothing killed, held like a money script",
      turn_stop.kill_tree(200, True) == ([], ["order script"]) and not _terminated, _terminated)
turn_stop._windows_pairs = lambda: []
check("Windows + Codex, empty table: held", turn_stop.kill_tree(200, True) == ([], ["order script"]) and not _terminated)
check("Windows + Claude, table unreadable: nothing to hold for", turn_stop.kill_tree(200, False) == ([], []))
turn_stop._NT = False
_real_ps = turn_stop._posix_table
turn_stop._posix_table = _no_table
check("POSIX + Codex, ps failed: held", turn_stop.kill_tree(None, True) == ([], ["order script"]))
turn_stop._posix_table = lambda: ([], {})
check("POSIX + Codex, ps gave nothing: held", turn_stop.kill_tree(None, True) == ([], ["order script"]))
turn_stop._posix_table = _real_ps
turn_stop._NT = True

# …end to end: Codex pipes a marked script's output and the table never reads — it still finishes
turn_stop._windows_pairs = _no_table
turn_stop.HOLD_MAX_S = 10
led_w2 = os.path.join(_tmp, "ledger-win-blind")
fake_codex_w2 = os.path.join(_tmp, "codex-win-blind")
with open(fake_codex_w2, "w") as f:
    f.write(_codex_w_src.replace(repr(led_w), repr(led_w2)))
os.chmod(fake_codex_w2, 0o755)
flag = os.path.join(_tmp, f"stop-{time.monotonic_ns()}")
os.environ[turn_stop.ENV] = flag
def stopper_w2():
    while not os.path.exists(led_w2):
        time.sleep(0.02)
    open(flag, "w").close()
threading.Thread(target=stopper_w2, daemon=True).start()
with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
    asyncio.run(at.run_turn("s10", "把 XRP 平掉", "sonnet", at.LocalSink("s10"), engine="codex", codex_bin=fake_codex_w2, ui_lang="zh"))
check("Windows + Codex, table unreadable: stopped after 'cancelled', the script still closes and writes the ledger",
      ledger_wait(led_w2, ["cancelled", "closed", "ledger"], 1), open(led_w2).read())
turn_stop.HOLD_MAX_S = 120

# From here the pids are made up: record, never signal (201 may be a real process on this box)
turn_stop._nt_terminate = lambda h: _terminated.append(h) or True
turn_stop._taskkill = lambda pid: _terminated.append(pid)

# Marker written between the snapshot and the kill (B2): the handles are opened, the table and the
# markers read again, and nothing is terminated. Engine 201 → shell 202 → script 203.
_marks = set()
turn_stop._windows_pairs = lambda: [(201, 200), (202, 201), (203, 202)]
turn_stop._marker_pids, _real_marker = (lambda: set(_marks)), turn_stop._marker_pids
turn_stop._nt_open = lambda pid: _marks.add(203) or pid     # the script imports lib/order_* right now
_terminated.clear()
got = turn_stop.kill_tree(200, True)
check("Windows + Codex: a marker that appears just before the kill → Codex is not killed",
      got == ([], ["order script"]) and not _terminated, (got, _terminated))
_marks.clear()
turn_stop._nt_open = lambda pid: pid
check("…and with no marker the engine is terminated, by handle", turn_stop.kill_tree(200, True) == ([201], [])
      and _terminated == [201], _terminated)
turn_stop._marker_pids = _real_marker

# Leftover markers on Windows (B3): one whose pid is not in a readable table goes; a live one stays;
# an unreadable table removes nothing.
os.makedirs(turn_stop.MONEY_PID_DIR, exist_ok=True)
for _p in ("203", "999991"):
    open(os.path.join(turn_stop.MONEY_PID_DIR, _p), "w").close()
turn_stop._windows_pairs = _no_table
turn_stop.kill_tree(200, False)
check("Windows: an unreadable table removes no marker",
      {"203", "999991"} <= set(os.listdir(turn_stop.MONEY_PID_DIR)))
turn_stop._windows_pairs = lambda: [(201, 200), (202, 201), (203, 202)]
turn_stop.kill_tree(200, False)
_left = set(os.listdir(turn_stop.MONEY_PID_DIR))
check("Windows: a dead pid's marker is removed, a live one kept", "999991" not in _left and "203" in _left, _left)
with contextlib.suppress(OSError):
    os.remove(os.path.join(turn_stop.MONEY_PID_DIR, "203"))

for _n, _v in _real.items():
    if _v is not None:
        setattr(turn_stop, _n, _v)

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

# ── 9. agent_turn spawns nothing in-process but the engine ──────────────────
# kill_tree treats every direct child of agent_turn as the engine and does not match its argv
# (the CLI's --disallowedTools names president_worker). A money script started straight from
# agent_turn — or any runtime module it imports — would be spared by nothing. Known spawns:
# codex_engine (codex exec and its --version / features probes), turn_stop (ps).
# A new one fails here: check it is the engine or a short probe, then update the count.
import ast as _ast
_RT = os.path.join(ROOT, "runtime")
_local = {f[:-3] for f in os.listdir(_RT) if f.endswith(".py")}
_SPAWN_MODS = {"subprocess", "multiprocessing", "pty", "concurrent.futures"}
_seen, _todo, _spawns = set(), ["agent_turn"], {}
while _todo:
    _m = _todo.pop()
    if _m in _seen:
        continue
    _seen.add(_m)
    for _n in _ast.walk(_ast.parse(open(os.path.join(_RT, _m + ".py"), encoding="utf-8").read())):
        if isinstance(_n, _ast.Import):
            _todo += [a.name for a in _n.names if a.name in _local]
            _spawns.setdefault(_m, []).extend("import " + a.name for a in _n.names
                                              if a.name in _SPAWN_MODS - {"subprocess"})
        elif isinstance(_n, _ast.ImportFrom):
            if _n.module in _local:
                _todo.append(_n.module)
            if _n.module in _SPAWN_MODS:
                _spawns.setdefault(_m, []).append("from " + _n.module)
        elif isinstance(_n, _ast.Call) and isinstance(_n.func, _ast.Attribute):
            _b, _a = _n.func.value, _n.func.attr
            _o = _b.id if isinstance(_b, _ast.Name) else getattr(_b, "attr", None)
            if (_o == "subprocess" or _a.startswith("create_subprocess") or (_o == "os" and (
                    _a in ("system", "popen", "fork", "forkpty", "posix_spawn", "posix_spawnp", "startfile")
                    or _a.startswith(("spawn", "exec"))))):
                _spawns.setdefault(_m, []).append(f"{_o}.{_a}:{_n.lineno}")
_counts = {m: len(v) for m, v in _spawns.items() if v}
check("agent_turn's in-process modules spawn only the engine and its probes (codex_engine 3, turn_stop 1: ps)",
      _counts == {"codex_engine": 3, "turn_stop": 1} and "agent_turn" in _seen and "turn_stop" in _seen,
      {m: v for m, v in _spawns.items() if v})

print("\n" + ("ALL PASS" if not fails else f"{len(fails)} FAILED: {fails}"))
sys.exit(1 if fails else 0)
