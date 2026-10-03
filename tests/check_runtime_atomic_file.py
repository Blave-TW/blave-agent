"""runtime/atomic_file.py and the runtime writes that use it: a symlink the agent parks in a
directory the runtime writes must not carry the write out of it (audit 2026-10-02 N1, runtime side).

Same shape as the audit's PoC: plant a symlink at the name about to be written, run the real code,
check nothing appeared outside. Then an enumeration: every os.replace in runtime/*.py either sits
inside atomic_file.py or is on the reviewed list below — a new fixed-name tmp+replace turns this red.
All in a temp dir; never touches the repo's workspace or ~/Blave.
Run: cd blave-agent && .venv/bin/python tests/check_runtime_atomic_file.py
"""
import ast, importlib.util, json, os, secrets, shutil, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNTIME = os.path.join(ROOT, "runtime")
BASE = tempfile.mkdtemp(prefix="rt-atomic-")
WS = os.path.join(BASE, "workspace")
os.makedirs(os.path.join(WS, "manager"))
with open(os.path.join(WS, "manager", "portfolio_config.json"), "w") as f:
    f.write("{}")
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.pop("BLAVE_AGENT_LOCAL", None)
sys.path.insert(0, ROOT)
sys.path.insert(0, RUNTIME)
os.chdir(WS)
POSIX = os.name != "nt"

import atomic_file as A  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


n = [0]


def fresh():
    n[0] += 1
    d = os.path.join(BASE, f"c{n[0]}")
    ws, out = os.path.join(d, "ws"), os.path.join(d, "outside")
    os.makedirs(ws)
    os.makedirs(out)
    return ws, out


real_hex = secrets.token_hex


def pin_random():
    secrets.token_hex = lambda k=None: "ab" * (k or 6)
    return "ab" * 6


def unpin():
    secrets.token_hex = real_hex


def temps(d, base):
    return [x for x in os.listdir(d) if x.startswith("." + base + ".")]


# ── replacing ──
if POSIX:
    ws, out = fresh()
    f = os.path.join(ws, ".env")
    hx = pin_random()
    os.symlink(os.path.join(out, "planted"), os.path.join(ws, f"..env.{hx}.tmp"))
    try:
        with A.replacing(f) as fh:
            fh.write("AGENT=controlled\n")
        err = None
    except FileExistsError as e:
        err = e
    finally:
        unpin()
    check(err is not None and os.listdir(out) == [] and not os.path.exists(f),
          "replacing: a symlink already at the temp name → FileExistsError, nothing written outside, target untouched")
    check(os.path.islink(os.path.join(ws, f"..env.{hx}.tmp")),
          "replacing: the planted entry is not ours, so it is left alone")

    ws, out = fresh()
    f, victim = os.path.join(ws, ".env"), os.path.join(out, "victim")
    with open(victim, "w") as fh:
        fh.write("ORIGINAL\n")
    os.symlink(victim, f)
    with A.replacing(f) as fh:
        fh.write("NEW\n")
    check(open(victim).read() == "ORIGINAL\n" and not os.path.islink(f) and open(f).read() == "NEW\n",
          "replacing: target itself a symlink → the entry is swapped, the file it pointed at is untouched")

    ws, _ = fresh()
    f = os.path.join(ws, "x.json")
    old = os.umask(0o022)
    try:
        with A.replacing(f) as fh:
            fh.write("{}")
        dflt = os.stat(f).st_mode & 0o777
        os.chmod(f, 0o644)
        with A.replacing(f, perm=0o600) as fh:
            fh.write("{}")
        strict = os.stat(f).st_mode & 0o777
        os.umask(0o277)  # strips owner write too: the old code's os.chmod(tmp, 0o600) still gave exactly 0600
        with A.replacing(f, perm=0o600) as fh:
            fh.write("{}")
        odd = os.stat(f).st_mode & 0o777
    finally:
        os.umask(old)
    check(dflt == 0o644 and strict == 0o600 and odd == 0o600, f"replacing: perm=None → like open() (umask), perm=0o600 → exactly 0600 whatever the umask ({oct(dflt)}, {oct(strict)}, {oct(odd)})")

ws, _ = fresh()
f = os.path.join(ws, "doc.json")
with open(f, "w") as fh:
    fh.write("OLD")
try:
    with A.replacing(f) as fh:
        fh.write("HALF")
        raise RuntimeError("boom")
except RuntimeError:
    pass
check(open(f).read() == "OLD" and temps(ws, "doc.json") == [], "replacing: body raises → target unchanged, no temp left")

seen = []
with A.replacing(f, prepare=lambda t: seen.append((os.path.isfile(t), open(f).read()))) as fh:
    fh.write("NEW")
check(seen == [(True, "OLD")] and open(f).read() == "NEW", "replacing: prepare(tmp) runs on the written temp, before the replace")


def failing_replace(a, b):
    raise PermissionError("held open")


try:
    with A.replacing(f, replace=failing_replace) as fh:
        fh.write("NEWER")
except PermissionError:
    pass
check(open(f).read() == "NEW" and temps(ws, "doc.json") == [], "replacing: replace fails → temp removed, target unchanged")
with A.replacing(f, "wb") as fh:
    fh.write(b"\x00\x01")
check(open(f, "rb").read() == b"\x00\x01", "replacing: binary mode")
with A.replacing(f, encoding="utf-8", newline="\n") as fh:
    fh.write("一\n二\n")
check(open(f, "rb").read() == "一\n二\n".encode(), "replacing: encoding / newline pass through to the file object")

# ── append_line ──
if POSIX:
    ws, out = fresh()
    log = os.path.join(ws, "upload_errors.log")
    os.symlink(os.path.join(out, "planted"), log)
    try:
        A.append_line(log, "x\n")
        err = None
    except OSError as e:
        err = e
    check(err is not None and os.listdir(out) == [], "append_line: path is a symlink → OSError, nothing written outside")
ws, _ = fresh()
log = os.path.join(ws, "l.log")
A.append_line(log, "a\n")
A.append_line(log, "b\n")
check(open(log).read() == "a\nb\n", "append_line: plain file appends")

# ── call sites ──
if POSIX:
    cl_spec = importlib.util.spec_from_file_location("command_listener", os.path.join(RUNTIME, "command_listener.py"))
    cl = importlib.util.module_from_spec(cl_spec)
    cl_spec.loader.exec_module(cl)
    cl._sync_strategy_crons = lambda names: None
    cl._stop_reconciler = lambda: True
    env = os.path.join(WS, ".env")
    with open(env, "w") as fh:
        fh.write("blave_api_key=bk\nAGENT_LINE=controlled\n")
    out = os.path.join(BASE, "outside-env")
    os.makedirs(out)
    hx = pin_random()
    for name in (".env.tmp", f"..env.{hx}.tmp"):
        os.symlink(os.path.join(out, name + "-planted"), os.path.join(WS, name))
    try:
        cl._in_workspace(cl._cmd_credentials, {"env": {"PAPER_API_KEY": "paper", "PAPER_SECRET_KEY": "paper"}})
        err = None
    except Exception as e:
        err = e
    finally:
        unpin()
    check(err is not None and os.listdir(out) == [] and open(env).read() == "blave_api_key=bk\nAGENT_LINE=controlled\n",
          f"command_listener credentials: temp name taken by a symlink → refuses, nothing outside, .env as it was ({type(err).__name__})")
    os.remove(os.path.join(WS, f"..env.{hx}.tmp"))
    cl._in_workspace(cl._cmd_credentials, {"env": {"PAPER_API_KEY": "paper", "PAPER_SECRET_KEY": "paper"}})
    body = open(env).read()
    check("PAPER_API_KEY=paper" in body and "AGENT_LINE=controlled" in body and not os.path.islink(env)
          and os.stat(env).st_mode & 0o777 == 0o600 and os.listdir(out) == [],
          "command_listener credentials: normal bind still writes .env, 0600, the old fixed .env.tmp symlink is never followed")
    cl._in_workspace(cl._cmd_credentials_remove, {"env": ["PAPER_API_KEY", "PAPER_SECRET_KEY"]})
    check("PAPER_API_KEY" not in open(env).read() and os.stat(env).st_mode & 0o777 == 0o600 and os.listdir(out) == [],
          "command_listener credentials_remove: rewrites .env through the same path (0600, nothing outside)")

    ru_spec = importlib.util.spec_from_file_location("report_uploader", os.path.join(RUNTIME, "report_uploader.py"))
    ru = importlib.util.module_from_spec(ru_spec)
    ru_spec.loader.exec_module(ru)
    ws, out = fresh()
    log = os.path.join(ws, "upload_errors.log")
    os.symlink(os.path.join(out, "planted"), log)
    ru.log_error("r1", "agent-shaped text", log_path=log)
    check(os.listdir(out) == [], "report_uploader.log_error: log is a symlink → no append through it")
    ws, out = fresh()
    log = os.path.join(ws, "upload_errors.log")
    with open(log, "w") as fh:
        fh.write("".join(f"2026-10-03T00:00:00Z old-{i}: {'y' * 80}\n" for i in range(ru._ERROR_LOG_KEEP_LINES * 3 + 2000)))
    hx = pin_random()
    os.symlink(os.path.join(out, "planted"), os.path.join(ws, f".upload_errors.log.{hx}.tmp"))
    os.symlink(os.path.join(out, "planted-fixed"), log + ".tmp")
    try:
        ru.log_error("r1", "trim me", log_path=log)
    finally:
        unpin()
    check(os.listdir(out) == [], "report_uploader.log_error trim: temp names taken by symlinks → nothing written outside (the tail is agent-writable text)")
    os.remove(os.path.join(ws, f".upload_errors.log.{hx}.tmp"))
    ru.log_error("r1", "trim me", log_path=log)
    check(os.path.getsize(log) <= ru._ERROR_LOG_MAX_BYTES and open(log).read().rstrip().endswith("r1: trim me") and os.listdir(out) == [],
          "report_uploader.log_error trim: normal trim still works")

# ── enumeration: every os.replace / os.rename in runtime/ is reviewed ──
# (file, enclosing function) → why it is not a write-then-replace that needs atomic_file
REVIEWED = {
    ("capital_connect.py", "_write_vault"): "already a random temp name (secrets.token_hex), its own ACL steps",
    ("local_daemon.py", "_link_current"): "os.symlink(tmp) never follows an existing name (EEXIST)",
    ("local_daemon.py", "_spawn_locked"): "reconciler.log rotation: renames the log, writes nothing",
    ("web_bridge.py", "_load_queue"): "moves a corrupt queue aside, writes nothing",
    ("report_uploader.py", "_retire"): "moves a finished report (and its .files/) into sent/ or failed/",
    ("skill_sync.py", "main"): "directory swap of the skill clone",
    ("telegram_pairing.py", "replace_retry"): "the replace callable atomic_file.replacing is handed",
}
found = []
for name in sorted(os.listdir(RUNTIME)):
    if not name.endswith(".py") or name == "atomic_file.py":
        continue
    tree = ast.parse(open(os.path.join(RUNTIME, name), encoding="utf-8").read())
    scopes = [fn for fn in ast.walk(tree) if isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef))]
    top = ast.Module(body=[x for x in tree.body if not isinstance(x, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))], type_ignores=[])
    top.name = "<module>"
    for fn in scopes + [top]:
        for node in ast.walk(fn):
            if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in ("replace", "rename")
                    and isinstance(node.func.value, ast.Name) and node.func.value.id in ("os", "shutil")):
                found.append((name, fn.name))
found = sorted(set(found))
stray = [x for x in found if x not in REVIEWED]
check(not stray, f"every os.replace / os.rename in runtime/ is atomic_file or reviewed (unreviewed: {stray})")
check(not [x for x in REVIEWED if x not in found], f"no stale entries on the reviewed list ({[x for x in REVIEWED if x not in found]})")
check(len(found) >= 6, f"enumeration found the reviewed sites (found {len(found)}; 0 = the scan broke)")
srcs = {nm: open(os.path.join(RUNTIME, nm), encoding="utf-8").read() for nm in os.listdir(RUNTIME) if nm.endswith(".py")}
check(sum(s.count("atomic_file.replacing(") for s in srcs.values()) >= 40,
      f"call sites use atomic_file.replacing ({sum(s.count('atomic_file.replacing(') for s in srcs.values())})")
missing = [nm for nm, s in srcs.items() if nm != "atomic_file.py" and "atomic_file." in s
           and not any(l.strip().startswith("import atomic_file") for l in s.splitlines())]
check(not missing, f"every module that calls atomic_file.* imports it ({missing})")
check("atomic_file.append_line(log_path, line)" in srcs["report_uploader.py"], "report_uploader appends through append_line")
check("import atomic_file" in srcs["events.py"].split("def _replacing", 1)[1].split("\ndef ", 1)[0]
      and not any(l.startswith("import atomic_file") for l in srcs["events.py"].splitlines()),
      "events.py imports atomic_file lazily (lib/events.py loads it by path without runtime/ on sys.path)")

# events.py the way lib/events.py loads it from a strategy process: by path, runtime/ not on sys.path
import subprocess  # noqa: E402
ev_ws = os.path.join(BASE, "ev-ws")
probe = (
    "import importlib.util, sys\n"
    f"sys.path = [p for p in sys.path if p not in ({RUNTIME!r}, '')]\n"
    "sys.modules.pop('atomic_file', None)\n"
    f"spec = importlib.util.spec_from_file_location('blave_runtime_events', {os.path.join(RUNTIME, 'events.py')!r})\n"
    "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\n"
    "print('ID', m.append('probe', {'k': 1}))\n"
)
r = subprocess.run([sys.executable, "-c", probe], cwd=BASE, capture_output=True, text=True,
                   env={**os.environ, "BLAVE_AGENT_WORKSPACE": ev_ws, "PYTHONPATH": ""})
ev_file = os.path.join(ev_ws, "state", "events.jsonl")
check(r.returncode == 0 and "ID None" not in r.stdout and os.path.isfile(ev_file) and '"probe"' in open(ev_file).read(),
      f"events.py loaded by path without runtime/ on sys.path: append() still writes ({r.stdout.strip()} {r.stderr.strip()[-200:]})")

os.chdir(ROOT)
shutil.rmtree(BASE, ignore_errors=True)
print("ALL PASS" if not fails else f"{fails} FAIL")
sys.exit(1 if fails else 0)
