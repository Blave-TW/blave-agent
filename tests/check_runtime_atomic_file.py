"""runtime/atomic_file.py and the runtime writes that use it: a symlink the agent parks in a
directory the runtime writes must not carry the write out of it (audit 2026-10-02 N1, runtime side).

Same shape as the audit's PoC: plant a symlink at the name about to be written, run the real code,
check nothing appeared outside. Then an enumeration: every os.replace in runtime/*.py either sits
inside atomic_file.py or is on the reviewed list below — a new fixed-name tmp+replace turns this red.
Known limits (accepted, audit S5): only the last path component is protected for fixed-name
writes — an agent that swaps a whole directory (manager/, reports/) for a symlink makes those
fixed names land outside; reports/ moves and deletes go through SafeDir, but the rmtree in
_cmd_report_delete / _cmd_delete_strategy (user presses delete) does not. BASE/state is outside
the desktop Codex sandbox (writable roots = the workspace + temp dirs), so its writers are
reviewed, not converted.
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

# ── open_append / touch ──
import subprocess  # noqa: E402
if POSIX:
    ws, out = fresh()
    lg = os.path.join(ws, "flatten.log")
    os.symlink(os.path.join(out, "planted"), lg)
    try:
        A.open_append(lg).close()
        err = None
    except OSError as e:
        err = e
    check(err is not None and os.listdir(out) == [], "open_append: path is a symlink → OSError, nothing created outside")
    kick = os.path.join(ws, "kick")
    os.symlink(os.path.join(out, "kick-planted"), kick)
    try:
        A.touch(kick)
        err = None
    except OSError as e:
        err = e
    check(err is not None and os.listdir(out) == [], "touch: path is a symlink → OSError, nothing created outside")
ws, _ = fresh()
lg = os.path.join(ws, "child.log")
with A.open_append(lg) as logf:
    subprocess.run([sys.executable, "-c", "print('from child')"], stdout=logf, stderr=logf, check=True)
with A.open_append(lg) as logf:
    logf.write(b"tail\n")
check(open(lg, "rb").read().replace(b"\r\n", b"\n") == b"from child\ntail\n", "open_append: a Popen can log into it; appends, never truncates")
k = os.path.join(ws, "kick")
A.touch(k)
os.utime(k, (1, 1))
A.touch(k)
check(os.path.isfile(k) and os.stat(k).st_mtime > 1000, "touch: creates the file, then bumps its mtime")

# ── Windows newline rule: same bytes as open(); O_BINARY in every flag set ──
ws, _ = fresh()
text = "blave_api_key=bk\nPAPER_API_KEY=paper\n一行\n"
with open(os.path.join(ws, "via_open"), "w", encoding="utf-8") as fh:
    fh.write(text)
with A.replacing(os.path.join(ws, "via_replacing"), encoding="utf-8") as fh:
    fh.write(text)
A.append_line(os.path.join(ws, "via_append"), text)
with open(os.path.join(ws, "via_open_a"), "a", encoding="utf-8") as fh:
    fh.write(text)
rb = lambda nm: open(os.path.join(ws, nm), "rb").read()  # noqa: E731
check(rb("via_replacing") == rb("via_open") and rb("via_append") == rb("via_open_a"),
      f"newline: replacing / append_line write the same bytes as open() on this platform ({rb('via_open')[:20]!r})")
asrc = open(os.path.join(RUNTIME, "atomic_file.py"), encoding="utf-8").read()
_flag_src = [asrc.split("_FLAGS = ", 1)[1].split("\n", 1)[0], asrc.split("_APPEND = (", 1)[1].split("\n\n", 1)[0],
             asrc.split("def open_truncate(", 1)[1].split("try:", 1)[0]]
check(all('getattr(os, "O_BINARY", 0)' in x for x in _flag_src) and (not hasattr(os, "O_BINARY") or (A._FLAGS & os.O_BINARY and A._APPEND & os.O_BINARY)),
      "newline: O_BINARY in all three flag sets (replacing, append, truncate) (without it the Windows CRT translates \\n a second time under TextIOWrapper)")

# ── report_uploader: moves and deletes inside reports/ never go through a symlinked directory ──
if POSIX:
    ru_spec = importlib.util.spec_from_file_location("report_uploader_sd", os.path.join(RUNTIME, "report_uploader.py"))
    RU = importlib.util.module_from_spec(ru_spec)
    ru_spec.loader.exec_module(RU)

    def tree():
        n[0] += 1
        w = os.path.join(BASE, f"t{n[0]}", "ws")
        out = os.path.join(BASE, f"t{n[0]}", "outside")
        os.makedirs(os.path.join(w, "reports"))
        os.makedirs(out)
        RU.REPORTS_DIR = os.path.join(w, "reports")
        RU.SENT_DIR, RU.FAILED_DIR = os.path.join(RU.REPORTS_DIR, "sent"), os.path.join(RU.REPORTS_DIR, "failed")
        return w, out

    def put(d, name, body="x", age=0):
        p = os.path.join(d, name)
        with open(p, "w") as fh:
            fh.write(body)
        if age:
            os.utime(p, (time_now - age, time_now - age))
        return p

    import time as _t  # noqa: E402
    time_now = _t.time()
    OLD = RU._ORPHAN_FILES_MAX_AGE_S + 3600

    def run_safe_dir_cases(label):
        w, out = tree()
        for i in range(30):
            put(out, f"doc{i}.txt", age=i + 1)
        os.symlink(out, RU.SENT_DIR)
        RU._prune_sent(RU.SENT_DIR)
        check(len(os.listdir(out)) == 30, f"{label}_prune_sent: sent/ is a symlink to a dir of 30 files → none deleted ({len(os.listdir(out))})")
        rep = put(RU.REPORTS_DIR, "settings.json", "{}")
        try:
            RU._retire(rep, RU.SENT_DIR)
            err = None
        except OSError as e:
            err = e
        check(err is not None and os.path.isfile(rep) and not os.path.exists(os.path.join(out, "settings.json")),
              f"{label}_retire: sent/ symlinked → refuses, report stays, nothing lands outside")
        put(out, "victim.json")
        os.symlink(out, RU.FAILED_DIR)
        RU._clear_failed("victim", RU.FAILED_DIR)
        check(os.path.isfile(os.path.join(out, "victim.json")), f"{label}_clear_failed: failed/ symlinked → the outside victim.json survives")

        w, out = tree()
        shutil.rmtree(RU.REPORTS_DIR)
        os.makedirs(os.path.join(out, "old.files"))
        put(os.path.join(out, "old.files"), "keep.png")
        os.utime(os.path.join(out, "old.files"), (time_now - OLD, time_now - OLD))
        os.symlink(out, RU.REPORTS_DIR)
        RU._sweep_orphan_files()
        check(os.path.isfile(os.path.join(out, "old.files", "keep.png")), f"{label}_sweep_orphan_files: reports/ symlinked → the outside *.files dir survives")
        rep = put(RU.REPORTS_DIR, "r.json", "{}")
        try:
            RU._retire(rep, RU.SENT_DIR)
        except OSError:
            pass
        check(not os.path.exists(os.path.join(out, "sent")), f"{label}_retire: reports/ symlinked → no sent/ is created outside")

        w, out = tree()
        os.makedirs(RU.SENT_DIR)
        for i in range(30):
            put(RU.SENT_DIR, f"r{i}.json", age=i + 1)
            os.makedirs(os.path.join(RU.SENT_DIR, f"r{i}.files"))
        os.symlink(out, os.path.join(RU.SENT_DIR, "r29.files-link.json"))
        RU._prune_sent(RU.SENT_DIR)
        left = sorted(x for x in os.listdir(RU.SENT_DIR) if x.endswith(".json") and not os.path.islink(os.path.join(RU.SENT_DIR, x)))
        check(len(left) == RU.SENT_KEEP and "r0.json" in left and not os.path.exists(os.path.join(RU.SENT_DIR, "r29.files"))
              and os.path.exists(os.path.join(RU.SENT_DIR, "r0.files")),
              f"{label}_prune_sent: real sent/ keeps the newest {RU.SENT_KEEP} and their .files, drops the rest ({len(left)})")
        rep = put(RU.REPORTS_DIR, "a.json", "{}")
        os.makedirs(os.path.join(RU.REPORTS_DIR, "a.files"))
        put(os.path.join(RU.REPORTS_DIR, "a.files"), "new.png")
        os.makedirs(os.path.join(RU.SENT_DIR, "a.files"))
        put(os.path.join(RU.SENT_DIR, "a.files"), "stale.png")
        RU._retire(rep, RU.SENT_DIR)
        check(os.path.isfile(os.path.join(RU.SENT_DIR, "a.json")) and os.listdir(os.path.join(RU.SENT_DIR, "a.files")) == ["new.png"]
              and not os.path.exists(rep), f"{label}_retire: real sent/ → report and its .files move, an older .files there is replaced")
        RU._retire(put(RU.REPORTS_DIR, "b.json", "{}"), RU.FAILED_DIR)
        check(os.path.isfile(os.path.join(RU.FAILED_DIR, "b.json")), f"{label}_retire: creates failed/ when missing")
        os.makedirs(os.path.join(RU.FAILED_DIR, "b.files"))
        RU._clear_failed("b", RU.FAILED_DIR)
        check(not os.path.exists(os.path.join(RU.FAILED_DIR, "b.json")) and not os.path.exists(os.path.join(RU.FAILED_DIR, "b.files")),
              f"{label}_clear_failed: real failed/ → copy and .files removed")
        for nm, age, with_json in (("old", OLD, False), ("young", 10, False), ("kept", OLD, True)):
            d = os.path.join(RU.REPORTS_DIR, nm + ".files")
            os.makedirs(d)
            put(d, "x.png")
            if with_json:
                put(RU.REPORTS_DIR, nm + ".json", "{}")
            os.utime(d, (time_now - age, time_now - age))
        RU._sweep_orphan_files()
        check(not os.path.exists(os.path.join(RU.REPORTS_DIR, "old.files")) and os.path.isdir(os.path.join(RU.REPORTS_DIR, "young.files"))
              and os.path.isdir(os.path.join(RU.REPORTS_DIR, "kept.files")),
              f"{label}_sweep_orphan_files: real reports/ → only the day-old orphan goes")

    run_safe_dir_cases("report_uploader.")

    # swap AFTER the directory was opened (an agent loop racing the uploader): the operations must stay on
    # the directory that was opened, not on whatever the path names now
    class SwapAfterOpen(A.SafeDir):
        swap = None

        def __init__(self, root, path, create=False):
            super().__init__(root, path, create=create)
            if SwapAfterOpen.swap and os.path.abspath(path) == SwapAfterOpen.swap[0]:
                target, outside = SwapAfterOpen.swap
                SwapAfterOpen.swap = None
                os.rename(target, target + ".real")
                os.symlink(outside, target)

    real_sd = RU.atomic_file.SafeDir
    RU.atomic_file.SafeDir = SwapAfterOpen
    try:
        w, out = tree()
        os.makedirs(RU.SENT_DIR)
        for i in range(30):
            put(RU.SENT_DIR, f"r{i}.json", age=i + 1)
            put(out, f"r{i}.json", age=i + 1)
            os.makedirs(os.path.join(out, f"r{i}.files"))
        SwapAfterOpen.swap = (os.path.abspath(RU.SENT_DIR), out)
        RU._prune_sent(RU.SENT_DIR)
        check(len(os.listdir(out)) == 60 and len(os.listdir(RU.SENT_DIR + ".real")) == RU.SENT_KEEP,
              f"_prune_sent: sent/ swapped for a symlink after it was opened → the outside dir is untouched, the real one pruned ({len(os.listdir(out))})")
        w, out = tree()
        os.makedirs(RU.FAILED_DIR)
        put(RU.FAILED_DIR, "v.json")
        put(out, "v.json")
        os.makedirs(os.path.join(out, "v.files"))
        SwapAfterOpen.swap = (os.path.abspath(RU.FAILED_DIR), out)
        RU._clear_failed("v", RU.FAILED_DIR)
        check(os.path.isfile(os.path.join(out, "v.json")) and os.path.isdir(os.path.join(out, "v.files"))
              and not os.path.exists(os.path.join(RU.FAILED_DIR + ".real", "v.json")),
              "_clear_failed: failed/ swapped after open → the outside v.json / v.files survive")
        w, out = tree()
        d = os.path.join(RU.REPORTS_DIR, "old.files")
        os.makedirs(d)
        os.makedirs(os.path.join(out, "old.files"))
        put(os.path.join(out, "old.files"), "keep.png")
        os.utime(os.path.join(out, "old.files"), (time_now - OLD, time_now - OLD))
        os.utime(d, (time_now - OLD, time_now - OLD))
        SwapAfterOpen.swap = (os.path.abspath(RU.REPORTS_DIR), out)
        RU._sweep_orphan_files()
        check(os.path.isfile(os.path.join(out, "old.files", "keep.png")), "_sweep_orphan_files: reports/ swapped after open → the outside *.files survives")
    finally:
        RU.atomic_file.SafeDir = real_sd

    w, out = tree()
    put(out, "precious.txt")
    os.makedirs(RU.SENT_DIR)
    d = os.path.join(RU.SENT_DIR, "z.files")
    os.makedirs(d)
    os.symlink(out, os.path.join(d, "link-to-outside"))
    with A.SafeDir(w, RU.SENT_DIR) as sd:
        sd.rmtree("z.files")
    check(not os.path.exists(d) and os.path.isfile(os.path.join(out, "precious.txt")),
          "SafeDir.rmtree: a symlink inside the tree is unlinked, never followed")
    saved = os.supports_dir_fd
    os.supports_dir_fd = set()  # the Windows branch: no dir_fd, realpath must stay under the root
    try:
        run_safe_dir_cases("[no dir_fd] report_uploader.")
    finally:
        os.supports_dir_fd = saved

# ── command_listener append / touch sites ──
if POSIX:
    st = os.path.join(WS, "state")
    os.makedirs(os.path.join(st, "execution"), exist_ok=True)
    out = os.path.join(BASE, "outside-append")
    os.makedirs(out)
    for nm in ("audit.jsonl", os.path.join("execution", "kick")):
        p = os.path.join(st, nm)
        if os.path.lexists(p):
            os.remove(p)
        os.symlink(os.path.join(out, os.path.basename(nm) + "-planted"), p)
    cl.WORKSPACE_STATE = st
    cl._kick_reconciler()
    cl._downtime_unprotected(1, 2)
    ev_spec = importlib.util.spec_from_file_location("events_sd", os.path.join(RUNTIME, "events.py"))
    EV = importlib.util.module_from_spec(ev_spec)
    ev_spec.loader.exec_module(EV)
    if os.path.lexists(EV.EVENTS_PATH):
        os.remove(EV.EVENTS_PATH)
    os.symlink(os.path.join(out, "events-planted"), EV.EVENTS_PATH)
    EV.append("probe", {"k": 1})
    check(os.listdir(out) == [], "command_listener kick / audit.jsonl and events.append through planted symlinks → nothing outside")

# ── open_truncate (a log a child streams into) ──
if POSIX:
    ws, out = fresh()
    lg = os.path.join(ws, "mgmt_backtest.log")
    with open(os.path.join(out, "victim"), "w") as fh:
        fh.write("KEEP\n")
    os.symlink(os.path.join(out, "victim"), lg)
    try:
        A.open_truncate(lg).close()
        err = None
    except OSError as e:
        err = e
    check(err is not None and open(os.path.join(out, "victim")).read() == "KEEP\n", "open_truncate: path is a symlink → OSError, the file it points at is not truncated")
ws, _ = fresh()
lg = os.path.join(ws, "run.log")
with open(lg, "w") as fh:
    fh.write("old run\n")
with A.open_truncate(lg) as logf:
    subprocess.run([sys.executable, "-c", "print('new run')"], stdout=logf, stderr=logf, check=True)
check(open(lg, "rb").read().replace(b"\r\n", b"\n") == b"new run\n", "open_truncate: truncates like open('wb'), a Popen can stream into it")

# ── direct writers that used open(path, "w") in workspace (audit M1) ──
if POSIX:
    victim = os.path.join(BASE, "victim_rc")
    with open(victim, "w") as fh:
        fh.write("IMPORTANT USER DATA\n")
    hb = cl.HEARTBEAT
    os.makedirs(os.path.dirname(hb), exist_ok=True)
    if os.path.lexists(hb):
        os.remove(hb)
    os.symlink(victim, hb)
    cl._beat()
    check(open(victim).read() == "IMPORTANT USER DATA\n" and not os.path.islink(hb) and open(hb).read().strip().isdigit(),
          "command_listener._beat: heartbeat symlinked to a user file → the file is untouched, the heartbeat is replaced")
    oe = os.path.join(WS, "manager", "order_errors.json")
    with open(oe, "w") as fh:
        json.dump([{"kind": "agent-written"}], fh)
    victim2 = os.path.join(BASE, "victim_oe")
    os.rename(oe, victim2)
    os.symlink(victim2, oe)
    cl._record_manual_close_row(["TXF"])
    check(json.load(open(victim2)) == [{"kind": "agent-written"}] and not os.path.islink(oe) and json.load(open(oe))[-1]["kind"] == "manual_close_required",
          "command_listener._record_manual_close_row: order_errors.json symlinked → the outside file keeps its content")
    rr_spec = importlib.util.spec_from_file_location("report_runner_sd", os.path.join(RUNTIME, "report_runner.py"))
    RR = importlib.util.module_from_spec(rr_spec)
    rr_spec.loader.exec_module(RR)
    jd = os.path.join(WS, "report_jobs", "j1")
    os.makedirs(jd, exist_ok=True)
    victim3 = os.path.join(BASE, "victim_run")
    with open(victim3, "w") as fh:
        fh.write("KEEP\n")
    os.symlink(victim3, os.path.join(jd, "run.log"))
    RR._write_log(jd, "agent output\n")
    check(open(victim3).read() == "KEEP\n" and open(os.path.join(jd, "run.log")).read() == "agent output\n",
          "report_runner._write_log: run.log symlinked → the outside file keeps its content")
    os.symlink(victim3, os.path.join(jd, ".lock"))
    fh_ = None
    try:
        fh_ = RR._acquire_lock(jd)
        err = None
    except OSError as e:
        err = e
    finally:
        if fh_:
            fh_.close()
    check(err is not None and open(victim3).read() == "KEEP\n", "report_runner._acquire_lock: .lock symlinked → refuses instead of truncating the target")

# ── SafeDir: Windows branch reports a missing dir like POSIX; concurrent mkdir is fine ──
if POSIX:
    w = os.path.join(BASE, "sd-missing")
    os.makedirs(w)
    for label, forced in (("POSIX", False), ("no dir_fd", True)):
        saved = os.supports_dir_fd
        if forced:
            os.supports_dir_fd = set()
        try:
            try:
                A.SafeDir(w, os.path.join(w, "reports", "failed"))
                err = None
            except Exception as e:
                err = e
            check(isinstance(err, FileNotFoundError), f"SafeDir [{label}]: missing dir → FileNotFoundError ({type(err).__name__})")
            real_mkdir = os.mkdir

            def racing_mkdir(p, *a, **k):
                real_mkdir(p, *a, **k)
                raise FileExistsError(p)

            os.mkdir = racing_mkdir
            try:
                tgt = os.path.join(w, f"race-{label.replace(' ', '')}", "sent")
                with A.SafeDir(w, tgt, create=True):
                    pass
                err = None
            except Exception as e:
                err = e
            finally:
                os.mkdir = real_mkdir
            check(err is None and os.path.isdir(tgt), f"SafeDir [{label}] create: another writer made the dir first → still opens ({err!r})")
        finally:
            os.supports_dir_fd = saved
    import io, contextlib as _cl  # noqa: E401,E402
    buf = io.StringIO()
    saved = os.supports_dir_fd
    os.supports_dir_fd = set()
    RU.REPORTS_DIR = os.path.join(w, "reports")
    try:
        with _cl.redirect_stderr(buf):
            RU._clear_failed("nope", os.path.join(w, "reports", "failed"))
    finally:
        os.supports_dir_fd = saved
    check(buf.getvalue() == "", f"_clear_failed [no dir_fd]: failed/ never created → silent, no false error line ({buf.getvalue().strip()[:80]})")

# ── stale temps (a writer killed between write and replace) ──
ws, _ = fresh()
mk = lambda nm, age: (open(os.path.join(ws, nm), "w").close(), os.utime(os.path.join(ws, nm), (time_now - age, time_now - age)))  # noqa: E731
import time as _tt  # noqa: E402
time_now = _tt.time()
mk(".account.json.0123456789ab.tmp", 3600)
mk(".account.json.0123456789ac.tmp", 5)
mk("report.json.tmp", 3600)
mk(".notes.0123456789ab", 3600)
mk("..env.0123456789ab", 3600)
if POSIX:
    os.symlink(os.path.join(BASE, "nowhere"), os.path.join(ws, ".x.json.0123456789ab.tmp"))
A.sweep_stale(ws)
left = sorted(os.listdir(ws))
check(".account.json.0123456789ab.tmp" not in left and ".account.json.0123456789ac.tmp" in left and "report.json.tmp" in left
      and ".notes.0123456789ab" in left and "..env.0123456789ab" in left and (not POSIX or ".x.json.0123456789ab.tmp" in left),
      f"sweep_stale: only an old regular file in replacing()'s naming goes ({left})")
A.sweep_stale(ws, only=".env")
check("..env.0123456789ab" not in os.listdir(ws) and ".notes.0123456789ab" in os.listdir(ws), "sweep_stale(only='.env'): the shell's suffix-less .env temp goes too, other dotfiles stay")
if POSIX:
    for nm in ("..env.aaaaaaaaaaaa.tmp", "..env.bbbbbbbbbbbb"):
        with open(os.path.join(WS, nm), "w") as fh:
            fh.write("BINANCE_API_KEY=plaintext\n")
        os.utime(os.path.join(WS, nm), (time_now - 120, time_now - 120))
    cl._in_workspace(cl._cmd_credentials, {"env": {"PAPER_API_KEY": "paper", "PAPER_SECRET_KEY": "paper"}})
    cl._in_workspace(cl._cmd_credentials_remove, {"env": ["PAPER_API_KEY", "PAPER_SECRET_KEY"]})
    check(not [x for x in os.listdir(WS) if x.startswith("..env.")], "credentials / credentials_remove: a crashed writer's plaintext .env temp is gone afterwards")
    rd = os.path.join(BASE, "pend-ws", "reports")
    os.makedirs(rd)
    RU.REPORTS_DIR = rd
    open(os.path.join(rd, ".upload_errors.log.0123456789ab.tmp"), "w").close()
    open(os.path.join(rd, "half.json.tmp"), "w").close()
    st_ = RU.pending_status(state={}, now=time_now)
    check(st_.get("tmp") == 1, f"pending_status: a producer's half-written .tmp counts, the runtime's own temp does not ({st_})")
    ws2 = os.path.join(BASE, "boot-ws")
    os.makedirs(os.path.join(ws2, "manager"))
    for nm in ("..env.cccccccccccc.tmp", "..env.dddddddddddd", os.path.join("manager", ".account.json.eeeeeeeeeeee.tmp")):
        open(os.path.join(ws2, nm), "w").close()
        os.utime(os.path.join(ws2, nm), (time_now - 3600, time_now - 3600))
    A.sweep_runtime_temps(ws2, os.path.join(BASE, "boot-state"))
    check(not [x for x in os.listdir(ws2) if x.startswith("..env.")] and os.listdir(os.path.join(ws2, "manager")) == [],
          "sweep_runtime_temps at start: .env temps (both namings) and manager/ temps from a crash are cleared")
src_ld = open(os.path.join(RUNTIME, "local_daemon.py"), encoding="utf-8").read()
src_cl = open(os.path.join(RUNTIME, "command_listener.py"), encoding="utf-8").read()
check("atomic_file.sweep_runtime_temps(ws," in src_ld and "atomic_file.sweep_runtime_temps(WORKSPACE," in src_cl.split("def run(", 1)[1],
      "wiring: local_daemon main and command_listener.run sweep at start")

# ── enumeration: every os.replace / os.rename in runtime/ is reviewed ──
# (file, enclosing function) → why it is not a write-then-replace that needs atomic_file
REVIEWED = {
    ("capital_connect.py", "_write_vault"): "already a random temp name (secrets.token_hex), its own ACL steps",
    ("local_daemon.py", "_link_current"): "os.symlink(tmp) never follows an existing name (EEXIST)",
    ("local_daemon.py", "_spawn_locked"): "reconciler.log rotation: renames the log, writes nothing",
    ("web_bridge.py", "_load_queue"): "moves a corrupt queue aside, writes nothing",
    ("skill_sync.py", "main"): "directory swap of the skill clone",
    ("telegram_pairing.py", "replace_retry"): "the replace callable atomic_file.replacing is handed",
    ("sdk_pin.py", "_mark_bad"): ".ready → .bad inside $BASE/sdk/<pin> (rename of our own marker); $BASE/sdk and $BASE/state: cloud-only job (jobs.json blave-agent-sdk; the desktop has no $BASE/sdk and no sdk_sync), runtime = agent user there; desktop $BASE is outside the Codex sandbox anyway",
    ("sdk_sync.py", "_rename"): "<pin>.tmp → <pin> directory swap; $BASE/sdk and $BASE/state: cloud-only job (jobs.json blave-agent-sdk; the desktop has no $BASE/sdk and no sdk_sync), runtime = agent user there; desktop $BASE is outside the Codex sandbox anyway",
    ("sdk_sync.py", "_save_state"): "$BASE/sdk and $BASE/state: cloud-only job (jobs.json blave-agent-sdk; the desktop has no $BASE/sdk and no sdk_sync), runtime = agent user there; desktop $BASE is outside the Codex sandbox anyway",
    ("sdk_sync.py", "run"): "$BASE/sdk and $BASE/state: cloud-only job (jobs.json blave-agent-sdk; the desktop has no $BASE/sdk and no sdk_sync), runtime = agent user there; desktop $BASE is outside the Codex sandbox anyway",
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
# appends and in-place creates: open(..., "a…"), os.O_APPEND, os.open(O_CREAT) without O_EXCL / O_NOFOLLOW
APPEND_REVIEWED = {
    ("events.py", "append"): "inlined O_NOFOLLOW append (strategy processes load events.py by path, no atomic_file)",
    ("command_listener.py", "_flatten_already_running"): '"a+" lock probe on an existing flatten.lock, writes nothing',
}
CREATE_REVIEWED = {
    ("telegram_pairing.py", "write_json_600"): "config/ is root:root 755 on Linux (agent can't place a symlink), explicit ACL on Windows, BASE/config is outside the desktop sandbox",
    ("command_listener.py", "_env_lock"): ".env.lock: flock target, never written; worst case an empty file",
    ("command_listener.py", "_env_lock_nt"): ".env.lock: msvcrt lock target, never written",
    ("local_daemon.py", "_take_reconciler_lock"): "lock file, never written",
    ("local_daemon.py", "acquire"): "lock file, never written",
    ("local_daemon.py", "_try_lock"): "lock file, never written",
    ("session_store.py", "_conn"): "session.db lives in BASE/state (outside the workspace); created empty 0600",
}
# plain writes: open / os.fdopen with "w" / "x" / "+" (not "a": the list above), write_text / write_bytes
WRITE_REVIEWED = {
    ("agent_turn.py", "_image_quota_line"): "BASE/state (strategy_reporter.STATE_DIR): outside the desktop Codex sandbox; cloud runtime = agent user",
    ("agent_turn.py", "_write_system_prompt_file"): "fd from tempfile.mkstemp (O_EXCL, random name) in BASE/state",
    ("capital_connect.py", "_write_vault"): "random temp name, its own ACL steps (cloud Windows, SYSTEM)",
    ("capital_connect.py", "import_via_vehicle"): "BASE/credentials stage dir (cloud Windows, SYSTEM-only ACL)",
    ("file_watcher.py", "main"): "BASE/state heartbeat; cloud only",
    ("local_daemon.py", "_reject"): "fd from os.open(O_EXCL)",
    ("model_prefs.py", "set"): "BASE/state (BLAVE_AGENT_MODEL_PREFS); cloud only",
    ("report_runner.py", "_agent_turn_cloud"): "stop flag in BASE/state/turn_stop; cloud only",
    ("strategy_reporter.py", "record_image_quota"): "BASE/state: outside the desktop Codex sandbox; cloud runtime = agent user",
    ("telegram_bridge.py", "touch_heartbeat"): "BASE/state heartbeat; cloud only",
    ("telegram_pairing.py", "write_json_600"): "config/ root:root 755 on Linux, explicit ACL on Windows; desktop has no Telegram bridge",
    ("telegram_pairing.py", "_mark_checked"): "BASE/state; cloud only",
    ("turn_slots.py", "acquire"): "fd from os.open(O_EXCL)",
    ("web_bridge.py", "touch_heartbeat"): "BASE/state heartbeat; cloud only",
    ("web_bridge.py", "_stop_running"): "stop flag in BASE/state/turn_stop; cloud only",
    ("sdk_sync.py", "_save_state"): "$BASE/sdk and $BASE/state: cloud-only job (jobs.json blave-agent-sdk; the desktop has no $BASE/sdk and no sdk_sync), runtime = agent user there; desktop $BASE is outside the Codex sandbox anyway",
    ("sdk_sync.py", "run"): ".ready marker in $BASE/sdk/<pin>; $BASE/sdk and $BASE/state: cloud-only job (jobs.json blave-agent-sdk; the desktop has no $BASE/sdk and no sdk_sync), runtime = agent user there; desktop $BASE is outside the Codex sandbox anyway",
}
app_found, create_found, write_found = set(), set(), set()
for name in sorted(os.listdir(RUNTIME)):
    if not name.endswith(".py") or name == "atomic_file.py":
        continue
    tree_ = ast.parse(open(os.path.join(RUNTIME, name), encoding="utf-8").read())
    for fn in [x for x in ast.walk(tree_) if isinstance(x, (ast.FunctionDef, ast.AsyncFunctionDef))]:
        for node in ast.walk(fn):
            is_open = isinstance(node, ast.Call) and (isinstance(node.func, ast.Name) and node.func.id == "open" or (
                isinstance(node.func, ast.Attribute) and node.func.attr == "fdopen" and isinstance(node.func.value, ast.Name) and node.func.value.id == "os"))
            if is_open:
                mode = node.args[1] if len(node.args) > 1 else next((k.value for k in node.keywords if k.arg == "mode"), None)
                if isinstance(mode, ast.Constant) and isinstance(mode.value, str) and "a" in mode.value:
                    app_found.add((name, fn.name))
                elif isinstance(mode, ast.Constant) and isinstance(mode.value, str) and any(c in mode.value for c in "wx+"):
                    write_found.add((name, fn.name))
                elif mode is not None and not isinstance(mode, ast.Constant):
                    write_found.add((name, fn.name))  # a computed mode is reviewed like a write
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in ("write_text", "write_bytes"):
                write_found.add((name, fn.name))
            if isinstance(node, ast.Attribute) and node.attr == "O_APPEND":
                app_found.add((name, fn.name))
            if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "open"
                    and isinstance(node.func.value, ast.Name) and node.func.value.id == "os"):
                flags = ast.dump(node.args[1]) if len(node.args) > 1 else ""
                if "O_CREAT" in flags and "O_EXCL" not in flags and "O_NOFOLLOW" not in flags and "_APPEND" not in flags:
                    create_found.add((name, fn.name))
check(not sorted(app_found - set(APPEND_REVIEWED)), f"every append in runtime/ goes through atomic_file or is reviewed (unreviewed: {sorted(app_found - set(APPEND_REVIEWED))})")
check(not sorted(set(APPEND_REVIEWED) - app_found), f"no stale entries on the append list ({sorted(set(APPEND_REVIEWED) - app_found)})")
check(not sorted(write_found - set(WRITE_REVIEWED)), f"every plain write in runtime/ goes through atomic_file or is reviewed (unreviewed: {sorted(write_found - set(WRITE_REVIEWED))})")
check(not sorted(set(WRITE_REVIEWED) - write_found), f"no stale entries on the write list ({sorted(set(WRITE_REVIEWED) - write_found)})")
check(not sorted(create_found - set(CREATE_REVIEWED)), f"every os.open(O_CREAT) without O_EXCL/O_NOFOLLOW is reviewed (unreviewed: {sorted(create_found - set(CREATE_REVIEWED))})")
check(not sorted(set(CREATE_REVIEWED) - create_found), f"no stale entries on the create list ({sorted(set(CREATE_REVIEWED) - create_found)})")
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
