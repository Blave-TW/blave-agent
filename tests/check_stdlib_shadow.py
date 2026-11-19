"""No agent-writable file loads in a process handed the broker passwords except the frozen lib/ code (audit
2026-11-19 M1, and the follow-up audit's bypasses). Before the fix lib/ (the workers' sys.path[0]), manager/ (the
reconciler's and flatten's) and the workspace root sat on sys.path, so an agent-written lib/hashlib.py, a
manager/simplejson.py (an optional requests dependency nobody installed), a sourceless .pyc or a moved-in package
ran inside them. Now no workspace folder is on sys.path there at all: lib/secret_imports.py answers `lib` /
`lib.<name>` (and the workers' bare lib/ siblings) from source, nothing else.

  ① a temp workspace planted with marker-writing modules: stdlib names (which then load the real module, so the
     process carries on), names nothing else provides (which then raise ImportError, like the real absence), as
     .py, as a sourceless .pyc and as a package, in lib/, manager/ and the root, plus a crafted
     lib/__pycache__/events.*.pyc that validates against the real source: the President, Capital and SinoPac
     workers, the reconciler run the cloud way and the desktop way (local_daemon.py --run-reconciler), and flatten —
     every one gets past its imports and no marker is written
  ② control: the same scripts with the header block cut out DO load them, so ① cannot pass vacuously
  ③ the finder itself: exact case, .py only, no subpackages, no __pycache__; lib/ and runtime/ copies are one file;
     local_daemon / command_listener / account_reader / president_test_order install it
  ④ agent_turn: Write / Edit and Bash that create a stdlib-named .py in the root, lib/ or manager/ → deny;
     elsewhere, other names, reads → allowed; both hooks are mounted on every turn

Run: cd blave-agent && .venv/bin/python tests/check_stdlib_shadow.py
"""
import asyncio
import dataclasses
import importlib.util
import os
import py_compile
import re
import shutil
import subprocess
import sys
import tempfile
import time
import types
from importlib import _bootstrap_external

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNTIME = os.path.join(ROOT, "runtime")
BASE = os.path.realpath(tempfile.mkdtemp(prefix="stdlib-shadow-"))
fails = []


def t(name, ok, got=None):
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok or got is None else f"  → {got!r}"), flush=True)
    if not ok:
        fails.append(name)


# names the stdlib and site-packages do not provide here: whatever the workspace offers is the only candidate
UNPROVIDED = [n for n in ("simplejson", "chardet", "brotli", "socks", "winreg", "msvcrt", "_winapi", "zstandard")
              if importlib.util.find_spec(n) is None]
SHADOWS = {"lib": ["hashlib", "json", "threading"], "manager": ["hashlib", "json"], "": ["ssl", "decimal", "uuid", "csv"]}
REAL_SRC = '''import os as _o, sys as _s, importlib.machinery as _m, importlib.util as _u
_here = _o.path.dirname(_o.path.abspath(__file__))
open(_o.path.join(%r, __name__ + "@" + (_o.path.basename(_here) or "root")), "w").close()
_spec = _m.PathFinder.find_spec(__name__, [p for p in _s.path if _o.path.abspath(p or ".") != _here])
_mod = _u.module_from_spec(_spec)
_s.modules[__name__] = _mod
_spec.loader.exec_module(_mod)
'''
ABSENT_SRC = '''import os as _o
open(_o.path.join(%r, __name__ + "@" + (_o.path.basename(_o.path.dirname(_o.path.abspath(__file__))) or "root")), "w").close()
raise ImportError(__name__)
'''
BLOCK_RE = re.compile(r'if __name__ == "__main__" and not __package__:\n(?:    .*\n)+')
SCRIPTS = ("lib/president_worker.py", "lib/capital_worker.py", "lib/sinopac_worker.py",
           "manager/reconciler.py", "manager/flatten.py")


def plant(ws, mark):
    for d, names in SHADOWS.items():
        for n in names:
            with open(os.path.join(ws, d, n + ".py"), "w") as f:
                f.write(REAL_SRC % mark)
    for i, n in enumerate(UNPROVIDED):
        for d in ("lib", "manager", ""):
            kind = (i + len(d)) % 3  # each name as .py, as a sourceless .pyc and as a package, spread over the folders
            if kind == 0:
                with open(os.path.join(ws, d, n + ".py"), "w") as f:
                    f.write(ABSENT_SRC % mark)
            elif kind == 1:
                src = os.path.join(BASE, f"{n}-{len(d)}-{os.path.basename(os.path.dirname(ws))}.py")
                with open(src, "w") as f:
                    f.write(ABSENT_SRC % mark)
                py_compile.compile(src, cfile=os.path.join(ws, d, n + ".pyc"), doraise=True)
            else:
                os.makedirs(os.path.join(ws, d, n))
                with open(os.path.join(ws, d, n, "__init__.py"), "w") as f:
                    f.write(ABSENT_SRC % mark)
    # a bytecode cache that validates against the real lib/events.py but runs a marker first
    real = os.path.join(ws, "lib", "events.py")
    st = os.stat(real)
    code = compile((REAL_SRC.split("_spec =")[0] % mark) + open(real, encoding="utf-8").read(), real, "exec")
    cache = importlib.util.cache_from_source(real)
    os.makedirs(os.path.dirname(cache), exist_ok=True)
    with open(cache, "wb") as f:
        f.write(_bootstrap_external._code_to_timestamp_pyc(code, st.st_mtime, st.st_size))


def make_ws(name, strip_block):
    ws = os.path.join(BASE, name, "workspace")
    mark = os.path.join(BASE, name, "mark")
    os.makedirs(mark)
    for d in ("lib", "manager"):
        shutil.copytree(os.path.join(ROOT, d), os.path.join(ws, d),
                        ignore=shutil.ignore_patterns("__pycache__", "*.json", "*.jsonl", "executors"))
    os.makedirs(os.path.join(ws, "state"))
    if strip_block:
        for rel in SCRIPTS:
            p = os.path.join(ws, rel)
            src = open(p, encoding="utf-8").read()
            assert BLOCK_RE.search(src), rel
            open(p, "w", encoding="utf-8").write(BLOCK_RE.sub("", src, count=1))
    plant(ws, mark)
    return ws, mark


def env_for(ws):
    keep = ("PATH", "SystemRoot", "TEMP", "TMP", "TMPDIR", "USERPROFILE", "APPDATA", "LOCALAPPDATA")
    env = {k: v for k, v in os.environ.items() if k in keep}
    env.update(HOME=os.path.dirname(ws), BLAVE_AGENT_WORKSPACE=ws, BLAVE_AGENT_LOCAL="1", BLAVE_AGENT_BASE=os.path.dirname(ws),
               BLAVE_AGENT_HOME=os.path.dirname(ws), PYTHONUNBUFFERED="1")
    return env


def run_once(ws, argv):
    p = subprocess.run([sys.executable] + argv, cwd=ws, env=env_for(ws), input=b"", capture_output=True, timeout=120)
    return (p.stdout + p.stderr).decode("utf-8", "replace")


def run_until(ws, argv, want, keep_stdin=False, seconds=60):
    """A long-running one: started, read until `want` shows (or `seconds`), then stopped — stdin EOF first (how
    local_daemon's reconciler is told to leave), then terminate on our own PID."""
    log = os.path.join(os.path.dirname(ws), "run-%d.log" % time.monotonic_ns())
    with open(log, "wb") as lf:
        p = subprocess.Popen([sys.executable] + argv, cwd=ws, env=env_for(ws), stdout=lf, stderr=subprocess.STDOUT,
                             stdin=subprocess.PIPE if keep_stdin else subprocess.DEVNULL)
    end = time.time() + seconds
    out = ""
    while time.time() < end and p.poll() is None:
        out = open(log, encoding="utf-8", errors="replace").read()
        if want in out:
            break
        time.sleep(0.2)
    if keep_stdin:
        p.stdin.close()
    try:
        p.wait(20)
    except subprocess.TimeoutExpired:
        p.terminate()
        p.wait(20)
    return open(log, encoding="utf-8", errors="replace").read()


# (label, how to run it, what proves it got past its imports)
RUNS = [
    ("president_worker", lambda ws: run_once(ws, ["lib/president_worker.py", "--once"]), "[president_worker]"),
    ("sinopac_worker", lambda ws: run_once(ws, ["lib/sinopac_worker.py", "--once"]), "[sinopac_worker]"),
    ("reconciler (cloud)", lambda ws: run_until(ws, ["manager/reconciler.py"], "Reconciler started"),
     "Reconciler started"),
    ("flatten", lambda ws: run_once(ws, ["manager/flatten.py"]), "flatten done"),
]
if os.name != "nt":  # on Windows --once is a real SKCOM login attempt
    RUNS.insert(1, ("capital_worker", lambda ws: run_once(ws, ["lib/capital_worker.py", "--once"]), "comtypes"))
DAEMON_RUN = ("reconciler (local_daemon)",
              lambda ws: run_until(ws, [os.path.join(RUNTIME, "local_daemon.py"), "--run-reconciler",
                                        os.path.join("manager", "reconciler.py")], "Reconciler started",
                                   keep_stdin=True),
              "Reconciler started")

# ① fixed
ws, mark = make_ws("fixed", strip_block=False)
for label, run, reached in RUNS + [DAEMON_RUN]:
    for f in os.listdir(mark):
        os.remove(os.path.join(mark, f))
    out = run(ws)
    t(f"① {label}: got past its imports", reached in out, out[-600:])
    t(f"① {label}: no workspace shadow loaded", not os.listdir(mark), sorted(os.listdir(mark)))

# ② control: the block cut out
ws_c, mark_c = make_ws("control", strip_block=True)
for label, run, reached in RUNS:
    for f in os.listdir(mark_c):
        os.remove(os.path.join(mark_c, f))
    run(ws_c)
    got = sorted(os.listdir(mark_c))
    t(f"② control {label}: without the block a shadow IS loaded", bool(got), got)
    if label.startswith("reconciler"):
        t(f"② control {label}: …including a name nothing else provides (the follow-up audit's bypass)",
          any(g.split("@")[0] in UNPROVIDED for g in got), got)

# ③ the finder itself, and who installs it
t("③ lib/secret_imports.py and runtime/secret_imports.py are one file",
  open(os.path.join(ROOT, "lib", "secret_imports.py"), "rb").read()
  == open(os.path.join(RUNTIME, "secret_imports.py"), "rb").read())
t("③ the planted set is not empty (names nothing else provides here)", len(UNPROVIDED) >= 4, UNPROVIDED)
fws = os.path.join(BASE, "finder", "workspace")
os.makedirs(os.path.join(fws, "lib", "pkg"))
for rel, body in (("lib/__init__.py", ""), ("lib/real.py", "X = 1\n"), ("lib/Upper.py", "X = 2\n"),
                  ("lib/pkg/__init__.py", "X = 3\n"), ("lib/sib.py", "X = 4\n"), ("simplejson.py", "X = 5\n")):
    with open(os.path.join(fws, rel), "w") as f:
        f.write(body)
py_compile.compile(os.path.join(fws, "lib", "real.py"), cfile=os.path.join(fws, "lib", "bc.pyc"), doraise=True)
saved_path, saved_meta = list(sys.path), list(sys.meta_path)
saved_mods = {n: m for n, m in sys.modules.items() if n == "lib" or n.startswith("lib.") or n in ("sib", "simplejson")}
for n in saved_mods:
    del sys.modules[n]
sys.path[:0] = [fws, os.path.join(fws, "lib")]
si = __import__("runpy").run_path(os.path.join(ROOT, "lib", "secret_imports.py"))
si["install"](fws, ("sib",))


def importable(name):
    try:
        __import__(name)
        return True
    except ImportError:
        return False


t("③ install takes the workspace folders off sys.path", fws not in sys.path and os.path.join(fws, "lib") not in sys.path)
t("③ lib and lib.<name> load from <ws>/lib", importable("lib.real") and sys.modules["lib.real"].X == 1)
t("③ a listed bare sibling loads; an unlisted top-level name in the workspace never does",
  importable("sib") and not importable("simplejson"))
t("③ exact case only: lib.upper is not lib/Upper.py", not importable("lib.upper"))
t("③ .py only: a bare lib/bc.pyc is not lib.bc", not importable("lib.bc"))
t("③ no subpackages: lib/pkg/ is not lib.pkg", not importable("lib.pkg"))
real_py = os.path.join(fws, "lib", "real2.py")
with open(real_py, "w") as f:
    f.write("X = 'source'\n")
st = os.stat(real_py)
cache = importlib.util.cache_from_source(real_py)
os.makedirs(os.path.dirname(cache), exist_ok=True)
with open(cache, "wb") as f:
    f.write(_bootstrap_external._code_to_timestamp_pyc(compile("X = 'cache'\n", real_py, "exec"), st.st_mtime, st.st_size))
t("③ compiled from source: a valid __pycache__ entry is never used", importable("lib.real2")
  and sys.modules["lib.real2"].X == "source")
sys.path[:], sys.meta_path[:] = saved_path, saved_meta
for n in [n for n in sys.modules if n == "lib" or n.startswith("lib.") or n in ("sib", "simplejson")]:
    del sys.modules[n]
sys.modules.update(saved_mods)
for rel, needle in (("runtime/local_daemon.py", "secret_imports.install(ws)"),
                    ("runtime/web_bridge.py", "secret_imports.install(WORKSPACE)"),
                    ("runtime/account_reader.py", "secret_imports.install(WORKSPACE)"),
                    ("runtime/president_test_order.py", "secret_imports.install(workspace,")):
    src = open(os.path.join(ROOT, rel), encoding="utf-8").read()
    t(f"③ {rel}: installs the finder, never puts the workspace on sys.path",
      needle in src and not re.search(r"sys\.path\.(insert|append)\((0, )?(WORKSPACE|ws|os\.path\.join\(workspace)", src))
cl_src = open(os.path.join(RUNTIME, "command_listener.py"), encoding="utf-8").read()
body = cl_src[cl_src.index("def _in_workspace("):cl_src.index("# ── handlers")]
t("③ command_listener._in_workspace: the workspace goes on sys.path only where no finder is installed",
  body.index('type(f).__name__ == "WorkspaceLibFinder"') < body.index("sys.path.append(WORKSPACE)"))
os.environ["BLAVE_AGENT_WORKSPACE"] = ws
os.environ.setdefault("BLAVE_AGENT_DB", os.path.join(BASE, "session.db"))
sys.path.insert(0, RUNTIME)

# ④ agent_turn guard
sdk = types.ModuleType("claude_agent_sdk")
sdk.HookMatcher = lambda matcher=None, hooks=None: {"matcher": matcher, "hooks": hooks}
sys.modules["claude_agent_sdk"] = sdk
import agent_turn as at  # noqa: E402

W = at.WORKSPACE
DENY_PATHS = [os.path.join(W, "json.py"), os.path.join(W, "lib", "hashlib.py"), os.path.join(W, "manager", "ssl.py"),
              os.path.join(W, "lib", "json", "__init__.py"), "lib/threading.py", "random.py"]
ALLOW_PATHS = [os.path.join(W, "strategies", "x", "json.py"), os.path.join(BASE, "json.py"),
               os.path.join(W, "lib", "data.py"), os.path.join(W, "lib", "json_utils.py"), os.path.join(W, "test.py"),
               os.path.join(W, "lib", "json", "util.py"), os.path.join(W, "notes.md"), None, ""]
bad = [p for p in DENY_PATHS if not at.stdlib_shadow(p)]
t("④ stdlib_shadow: root / lib / manager .py or package named like a stdlib module", not bad, bad)
bad = [p for p in ALLOW_PATHS if at.stdlib_shadow(p)]
t("④ stdlib_shadow: other folders, other names, test.py → None", not bad, bad)
B_DENY = ["cat > json.py <<'EOF'", "echo x > lib/hashlib.py", "cp a.py manager/ssl.py", "tee ./lib/threading.py < x",
          "python3 -c \"open('lib/json.py', 'w').write('')\"", "touch lib/json.py", "printf x >> \"random.py\"",
          f"cp x {W}/lib/json.py", "mkdir -p lib/json && cp a lib/json/__init__.py",
          "Set-Content lib\\json.py 'x'", "mv tmp/x.py logging.py"]
B_ALLOW = ["cat lib/json.py", "python3 strategies/x/run.py > out.json", "cp a strategies/foo/json.py",
           "echo > /tmp/json.py", "grep json lib/data.py", "cat > test.py <<'EOF'", "cp a lib/json_utils.py",
           "python3 -c \"import json, hashlib\"", "echo x > lib/report.py", "python3 manager/reconciler.py > tmp/log 2>&1"]
bad = [c for c in B_DENY if not at.stdlib_shadow_bash_denied(c, c.startswith("Set-Content"))]
t("④ Bash creating one → deny", not bad, bad)
bad = [c for c in B_ALLOW if at.stdlib_shadow_bash_denied(c)]
t("④ Bash elsewhere / other names / reads → allowed", not bad, bad)


@dataclasses.dataclass
class _Options:
    hooks: object = None


opts = _Options()
at._stdlib_shadow_edit_hooks(opts)
hooks = (opts.hooks or {}).get("PreToolUse") or []
fn = hooks[-1]["hooks"][0] if hooks else None
out = asyncio.run(fn({"tool_name": "Write", "tool_input": {"file_path": os.path.join(W, "lib", "json.py")}}, None, None)) if fn else {}
ok = asyncio.run(fn({"tool_name": "Write", "tool_input": {"file_path": os.path.join(W, "lib", "x.py")}}, None, None)) if fn else None
t("④ Write/Edit hook: deny with the reason; other files → {}",
  hooks and hooks[-1]["matcher"] == "Write|Edit"
  and (out.get("hookSpecificOutput") or {}).get("permissionDecisionReason") == at.STDLIB_SHADOW_DENY_REASON and ok == {})
sec = asyncio.run(fn({"tool_name": "Write", "tool_input": {"file_path": os.path.join(W, "LIB", "guard.py")}}, None, None)) if fn else {}
t("④ Write/Edit hook: a frozen file in another case → the secret-code reason (mac / Windows)",
  sys.platform not in ("darwin", "win32")
  or (sec.get("hookSpecificOutput") or {}).get("permissionDecisionReason") == at.SECRET_CODE_DENY_REASON)
opts = _Options()
at._secret_code_bash_guard_hooks(opts)
fn = opts.hooks["PreToolUse"][-1]["hooks"][0]
out = asyncio.run(fn({"tool_name": "Bash", "tool_input": {"command": "echo x > lib/hashlib.py"}}, None, None))
t("④ shell hook: the same reason", (out.get("hookSpecificOutput") or {}).get("permissionDecisionReason")
  == at.STDLIB_SHADOW_DENY_REASON)
src = open(os.path.join(RUNTIME, "agent_turn.py"), encoding="utf-8").read()
mount = src[src.index("def _mount_turn_hooks("):]
mount = mount[:mount.index("\ndef ")]
t("④ every turn mounts the Write/Edit hook (before the sink branch)",
  0 <= mount.find("_stdlib_shadow_edit_hooks(options)") < mount.index("if isinstance(sink, LocalSink)"))

shutil.rmtree(BASE, ignore_errors=True)
print("\n" + (f"{len(fails)} FAIL" if fails else "ALL PASS"))
sys.exit(1 if fails else 0)
