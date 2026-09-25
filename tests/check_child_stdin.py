"""Every subprocess the runtime's daemon-side modules start chooses its stdin —
none inherits ours. In the desktop app our stdin is Electron's overlapped
`--secret-stdin` pipe with the parent-watch thread blocked in read(0) on it, and
a Windows python that inherits it hangs at interpreter start (0.1.3 Lightsail:
wait_for_bar ticks stuck for the full 30-minute timeout, 36 orphans an hour).

  1. Enumerates (AST, not grep) every subprocess.run / Popen / check_output /
     call in command_listener.py, local_daemon.py and portfolio_reporter.py:
     each carries stdin=, input= (a fed pipe), or **_child_kw(...).
  2. _child_kw: DEVNULL by default, a caller's stdin= / input= wins, and in nt
     mode CREATE_NO_WINDOW is OR-ed onto whatever creationflags were given.
  3. The scheduler tick itself (_tick_one) reaches subprocess.run with
     stdin=DEVNULL in local mode — the real call, not the helper in isolation.
Run: cd blave-agent && .venv/bin/python tests/check_child_stdin.py
"""
import ast
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNTIME = os.path.join(ROOT, "runtime")
FILES = ("command_listener.py", "local_daemon.py", "portfolio_reporter.py")
SPAWN = ("run", "Popen", "check_output", "call")

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg, flush=True)
    fails += 0 if cond else 1


def _how(call):
    """How this call settles stdin, or None when it would inherit ours."""
    for k in call.keywords:
        if k.arg in ("stdin", "input"):
            return k.arg + "="
        if k.arg is None and isinstance(k.value, ast.Call):
            f = k.value.func
            name = f.attr if isinstance(f, ast.Attribute) else getattr(f, "id", "")
            if name == "_child_kw":
                return "**_child_kw"
    return None


# ── 1. enumerate ─────────────────────────────────────────────────────────────
sites = 0
for fn in FILES:
    src = open(os.path.join(RUNTIME, fn), encoding="utf-8").read()
    for node in ast.walk(ast.parse(src)):
        if not isinstance(node, ast.Call):
            continue
        f = node.func
        if not (isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name)
                and f.value.id == "subprocess" and f.attr in SPAWN):
            continue
        sites += 1
        how = _how(node)
        check(how is not None, f"[enumerate] {fn}:{node.lineno} subprocess.{f.attr} → {how}")
check(sites >= 55, f"[enumerate] found {sites} spawn sites (a rewrite that hid them would read as 0)")

# ── 2. the helper ────────────────────────────────────────────────────────────
ws = tempfile.mkdtemp(prefix="child-stdin-")
os.environ["BLAVE_AGENT_LOCAL"] = "1"
os.environ["BLAVE_AGENT_WORKSPACE"] = ws
sys.path.insert(0, RUNTIME)
import command_listener as cl  # noqa: E402

kw = cl._child_kw()
check(kw == {"stdin": subprocess.DEVNULL}, f"[helper] posix default is stdin=DEVNULL only: {kw}")
check(cl._child_kw(stdin=subprocess.PIPE)["stdin"] == subprocess.PIPE, "[helper] a caller's stdin= wins")
check("stdin" not in cl._child_kw(input="x"), "[helper] input= gets no stdin= (run() refuses both)")
check(cl._child_kw(timeout=3) == {"timeout": 3, "stdin": subprocess.DEVNULL},
      "[helper] the call's own kwargs pass through")


class _NtOs:
    name = "nt"

    def __getattr__(self, k):
        return getattr(os, k)


NO_WINDOW = 0x08000000
had_flag = hasattr(subprocess, "CREATE_NO_WINDOW")
if not had_flag:
    subprocess.CREATE_NO_WINDOW = NO_WINDOW
cl.os = _NtOs()
try:
    kw = cl._child_kw()
    check(kw["stdin"] == subprocess.DEVNULL and kw["creationflags"] == NO_WINDOW,
          f"[helper nt] DEVNULL + CREATE_NO_WINDOW: {kw}")
    kw = cl._child_kw(creationflags=0x200, stdin=subprocess.PIPE)
    check(kw["creationflags"] == 0x200 | NO_WINDOW and kw["stdin"] == subprocess.PIPE,
          "[helper nt] OR-ed onto existing creationflags (CREATE_NEW_PROCESS_GROUP kept), stdin kept")
finally:
    cl.os = os
    if not had_flag:
        del subprocess.CREATE_NO_WINDOW

# ── 3. the tick ──────────────────────────────────────────────────────────────
seen = []


def fake_run(argv, **kw):
    seen.append((argv, kw))
    return subprocess.CompletedProcess(argv, 0, "", "")


real_run = cl.subprocess.run
cl.subprocess.run = fake_run
try:
    cl._tick_one("demo")
finally:
    cl.subprocess.run = real_run
check(len(seen) == 1 and seen[0][1].get("stdin") == subprocess.DEVNULL
      and seen[0][0][1:] == [os.path.join("manager", "wait_for_bar.py"), "demo"],
      f"[tick] _tick_one runs wait_for_bar.py with stdin=DEVNULL: {seen and seen[0][1].get('stdin')}")

print(("PASS" if not fails else f"FAIL ({fails})") + " check_child_stdin", flush=True)
sys.exit(1 if fails else 0)
