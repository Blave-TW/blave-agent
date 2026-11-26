"""manager/update_workspace.py — the one-run cloud workspace update.

Builds a real git repo standing in for the official one (origin = the official
URL, two commits), a workspace at the first commit with one changed-here file,
a user's own lib and a portfolio config, and fake systemctl / sudo / tmux on
PATH. Then:
  1. plan classifies old-official / changed-here / missing, reports the
     reconciler and whether a restart is needed — and writes nothing;
  2. apply refuses to write while a running reconciler's restart is not agreed;
  3. apply without --allow: older officials replaced, missing added, the
     changed-here file KEPT, backup made and verified, restart done, VERSION
     NOT written (partial);
  4. apply with --allow: the changed-here file replaced (its copy in the
     backup), VERSION written LAST; the user's own lib and portfolio config
     untouched; a re-run is up_to_date and restarts nothing;
  5. restart rules: never starts a stopped reconciler; restart failure keeps
     VERSION; a restart record + ungated new reconciler → no restart;
  6. tamper: run from outside the clone, wrong --expect-head, dirty clone,
     wrong origin, a committed symlink, a path outside the rule, a workspace
     dir that resolves outside the workspace — each stops with NOTHING written;
  7. a refused write leaves VERSION old;
  8. the machine reports the new VERSION at once;
  9. needs_restart follows the references (U7 / U8): lib/ or manager/ among the
     files to replace, or nothing left to replace and VERSION behind — with a
     mutation of the rule behind every case;
 10. a restart that failed is carried to the next run by
     state/update_restart_pending.json, so the one case the file lists cannot
     see (new lib/ on disk, old lib/ in the running daemon, only a non-code file
     left to replace) still owes the restart — and the record is cleared again.

Run: cd blave-agent && .venv/bin/python tests/check_update_workspace.py
"""
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT_SRC = os.path.join(ROOT, "manager", "update_workspace.py")
TMP = tempfile.mkdtemp(prefix="update-ws-")
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = TMP  # never a real Telegram
fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


GIT_ENV = {"PATH": "/usr/bin:/bin", "HOME": TMP, "GIT_CONFIG_GLOBAL": os.devnull,
           "GIT_CONFIG_NOSYSTEM": "1", "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
           "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}


def g(repo, *args):
    return subprocess.run(["git", "-C", repo, *args], env=GIT_ENV, capture_output=True,
                          text=True, check=True).stdout.strip()


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)


def read(path):
    with open(path) as f:
        return f.read()


GATED = "# reconciler\nRESTART_STOP_PATH = 'state/reconciler_stopped.json'\n"
UNGATED = "# an old reconciler\n"


def make_official(gated=True):
    repo = tempfile.mkdtemp(prefix="official-", dir=TMP)
    subprocess.run(["git", "init", "-q", repo], env=GIT_ENV, check=True)
    write(os.path.join(repo, "lib/data.py"), "v = 1\n")
    write(os.path.join(repo, "lib/guard.py"), "g = 1\n")
    write(os.path.join(repo, "manager/reconciler.py"), GATED if gated else UNGATED)
    write(os.path.join(repo, "references/a.md"), "ref v1\n")
    write(os.path.join(repo, "AGENTS.md"), "agents v1\n")
    write(os.path.join(repo, "CLAUDE.md"), "claude\n")
    write(os.path.join(repo, "strategies/TEMPLATE_A.py"), "tpl\n")
    write(os.path.join(repo, "VERSION"), "2026-09-01-a\n")
    write(os.path.join(repo, "manager/portfolio_config.json"), '{"amounts": {}}')  # a sample that must never land
    shutil.copy(SCRIPT_SRC, os.path.join(repo, "manager/update_workspace.py"))
    g(repo, "add", "-A")
    g(repo, "commit", "-qm", "v1")
    v1 = g(repo, "rev-parse", "HEAD")
    write(os.path.join(repo, "lib/data.py"), "v = 2\n")
    write(os.path.join(repo, "lib/venue_errors.py"), "new\n")
    write(os.path.join(repo, "examples/demo/run.py"), "demo\n")
    write(os.path.join(repo, "references/a.md"), "ref v2\n")
    write(os.path.join(repo, "manager/reconciler.py"), (GATED if gated else UNGATED) + "# v2\n")
    write(os.path.join(repo, "VERSION"), "2026-09-23-b\n")
    g(repo, "add", "-A")
    g(repo, "commit", "-qm", "v2")
    g(repo, "remote", "add", "origin", "https://github.com/Blave-TW/blave-agent")
    return repo, v1, g(repo, "rev-parse", "HEAD")


def make_workspace(repo, v1):
    ws = tempfile.mkdtemp(prefix="ws-", dir=TMP)
    tar = subprocess.run(["git", "-C", repo, "archive", v1], env=GIT_ENV, capture_output=True,
                         check=True).stdout
    subprocess.run(["tar", "-x", "-C", ws], input=tar, check=True)
    os.remove(os.path.join(ws, "manager/update_workspace.py"))  # the script is never run from here
    write(os.path.join(ws, "AGENTS.md"), "agents — edited on this machine\n")  # changed here
    write(os.path.join(ws, "lib/order_mine.py"), "my own venue\n")            # not in the clone
    write(os.path.join(ws, "manager/portfolio_config.json"), '{"amounts": {"s": 1}}')
    os.makedirs(os.path.join(ws, "state"))
    return ws


BIN = os.path.join(TMP, "bin")
os.makedirs(BIN)
STATE_F = os.path.join(TMP, "unit_state")
SUDO_LOG = os.path.join(TMP, "sudo.log")
SUDO_RC = os.path.join(TMP, "sudo_rc")
FLIP_F = os.path.join(TMP, "unit_flip")   # exists = flip after N reads
FLIP_TO = os.path.join(TMP, "unit_flip_to")  # what to flip to (default inactive)
CALLS_F = os.path.join(TMP, "unit_calls")
# reads the state file, unless the test asked it to flip after the Nth read —
# that is how the script's re-read just before the restart is tested
write(os.path.join(BIN, "systemctl"), f'#!/bin/sh\nif [ -f "{FLIP_F}" ]; then\n'
      f'  n=$(cat "{CALLS_F}" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "{CALLS_F}"\n'
      f'  if [ "$n" -gt "$(cat "{FLIP_F}")" ]; then\n'
      f'    cat "{FLIP_TO}" 2>/dev/null || echo inactive\n    exit 0\n  fi\nfi\n'
      f'cat "{STATE_F}"\n')
write(os.path.join(BIN, "sudo"), f'#!/bin/sh\necho "$@" >> "{SUDO_LOG}"\n'
      f'rc=$(cat "{SUDO_RC}" 2>/dev/null || echo 0); exit $rc\n')
write(os.path.join(BIN, "tmux"), "#!/bin/sh\nexit 1\n")
for n in ("systemctl", "sudo", "tmux"):
    os.chmod(os.path.join(BIN, n), 0o755)
ENV = dict(os.environ, PATH=BIN + os.pathsep + os.environ.get("PATH", ""))


def unit(state):
    write(STATE_F, state + "\n")


def run(repo, ws, mode, head, *extra, script=None):
    script = script or os.path.join(repo, "manager/update_workspace.py")
    r = subprocess.run([sys.executable, script, mode, "--clone", repo, "--workspace", ws,
                        "--expect-head", head, *extra], env=ENV, capture_output=True, text=True,
                       timeout=120)
    try:
        return json.loads(r.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return {"outcome": "crash", "stderr": r.stderr[-400:]}


STATUS = "state/workspace_update.json"  # the run's own status line for the desktop — not a workspace write
LOCK = "state/workspace_update.lock"     # the run's own lock (empty file) — not a workspace write either


def snapshot(ws):
    out = {}
    for dp, _dn, fn in os.walk(ws):
        for n in fn:
            p = os.path.join(dp, n)
            rel = os.path.relpath(p, ws)
            if rel not in (STATUS, LOCK):
                out[rel] = read(p) if not os.path.islink(p) else "->"
    return out


def clear_sudo():
    if os.path.exists(SUDO_LOG):
        os.remove(SUDO_LOG)


def sudo_calls():
    return read(SUDO_LOG).splitlines() if os.path.exists(SUDO_LOG) else []


try:
    repo, v1, head = make_official()
    ws = make_workspace(repo, v1)
    unit("active")

    # 1. plan
    before = snapshot(ws)
    p = run(repo, ws, "plan", head)
    check(p.get("outcome") == "plan" and p["old_official"] == ["lib/data.py", "manager/reconciler.py",
                                                               "references/a.md"]
          and p["changed_here"] == ["AGENTS.md"]
          and p["missing"] == ["examples/demo/run.py", "lib/venue_errors.py", "manager/update_workspace.py"]
          and p["reconciler"] == "running" and p["needs_restart"] is True
          and p["version_before"] == "2026-09-01-a" and p["version_clone"] == "2026-09-23-b",
          f"plan: older officials / changed here / missing classified, reconciler running → restart ({p})")
    check(snapshot(ws) == before and not sudo_calls(), "…plan writes nothing and restarts nothing")

    # 2. running reconciler, restart not agreed
    r = run(repo, ws, "apply", head)
    check(r["outcome"] == "stopped" and "restart" in r["reason"] and snapshot(ws) == before,
          "apply while the reconciler runs, without --restart-ok: stopped, nothing written")

    # 3. apply, changed-here kept
    r = run(repo, ws, "apply", head, "--restart-ok")
    bak = os.path.join(ws, r.get("backup") or "missing")
    check(r["outcome"] == "partial" and r["kept"] == ["AGENTS.md"]
          and read(os.path.join(ws, "lib/data.py")) == "v = 2\n"
          and read(os.path.join(ws, "lib/venue_errors.py")) == "new\n"
          and read(os.path.join(ws, "examples/demo/run.py")) == "demo\n"
          and read(os.path.join(ws, "AGENTS.md")).startswith("agents — edited")
          and read(os.path.join(bak, "lib/data.py")) == "v = 1\n"
          and read(os.path.join(ws, "VERSION")).strip() == "2026-09-01-a"
          and r["version_written"] is False and r["restart"] == "ok"
          and any("restart blave-agent-reconciler.service" in c for c in sudo_calls()),
          "apply without --allow: officials replaced + backed up, missing added, changed-here KEPT, "
          "restarted, VERSION not written (partial)")
    check(not os.path.exists(os.path.join(ws, "lib/data.py.update-tmp")),
          "…no temp file left behind (tmp + replace)")

    # 4. apply with the user's yes for the changed file
    clear_sudo()
    time.sleep(1.1)  # the backup folder is per second and never reused
    r = run(repo, ws, "apply", head, "--restart-ok", "--allow", "AGENTS.md")
    bak = os.path.join(ws, r.get("backup") or "missing")
    check(r["outcome"] == "updated" and r["replaced"] == ["AGENTS.md"]
          and read(os.path.join(ws, "AGENTS.md")) == "agents v1\n"
          and read(os.path.join(bak, "AGENTS.md")).startswith("agents — edited")
          and read(os.path.join(ws, "VERSION")).strip() == "2026-09-23-b" and r["version_written"],
          "apply --allow AGENTS.md: replaced (the edited copy is in the backup), VERSION written last")
    check(read(os.path.join(ws, "lib/order_mine.py")) == "my own venue\n"
          and read(os.path.join(ws, "manager/portfolio_config.json")) == '{"amounts": {"s": 1}}',
          "…the user's own lib and the portfolio config are never touched")
    clear_sudo()
    r = run(repo, ws, "apply", head, "--restart-ok")
    check(r["outcome"] == "up_to_date" and r["restart"] is None and not sudo_calls(),
          "re-run: up_to_date, nothing written, no restart")

    # 5. restart rules
    repo2, v1b, head2 = make_official()
    ws2 = make_workspace(repo2, v1b)
    os.remove(os.path.join(ws2, "AGENTS.md"))
    shutil.copy(os.path.join(repo2, "AGENTS.md"), os.path.join(ws2, "AGENTS.md"))
    unit("inactive")
    r = run(repo2, ws2, "apply", head2)
    check(r["outcome"] == "updated" and r["reconciler"] == "stopped" and r["restart"] is None
          and not sudo_calls(), "reconciler not running: files and VERSION updated, never started")

    repo3, v1c, head3 = make_official()
    ws3 = make_workspace(repo3, v1c)
    unit("active")
    write(SUDO_RC, "1")
    r = run(repo3, ws3, "apply", head3, "--restart-ok", "--allow", "AGENTS.md")
    check(r["outcome"] == "restart_failed" and not r["version_written"]
          and read(os.path.join(ws3, "VERSION")).strip() == "2026-09-01-a",
          "restart failed: files are on disk but VERSION stays old (the update is offered again)")
    os.remove(SUDO_RC)
    clear_sudo()

    repo4, v1d, head4 = make_official(gated=False)
    ws4 = make_workspace(repo4, v1d)
    write(os.path.join(ws4, "state/reconciler_stopped.json"), "{}")
    r = run(repo4, ws4, "apply", head4, "--restart-ok", "--allow", "AGENTS.md")
    check(r["restart"] == "skipped_not_gated" and not sudo_calls() and r["outcome"] == "updated"
          and r["restart_stopped"] is True,
          "restart record + a new reconciler WITHOUT the gate: not restarted, not a failure")
    repo5, v1e, head5 = make_official(gated=True)
    ws5 = make_workspace(repo5, v1e)
    write(os.path.join(ws5, "state/reconciler_stopped.json"), "{}")
    r = run(repo5, ws5, "apply", head5, "--restart-ok", "--allow", "AGENTS.md")
    check(r["restart"] == "ok" and sudo_calls(),
          "restart record + gated new reconciler: restarted (it sends nothing while the record exists)")
    clear_sudo()

    # 6. tamper — nothing written in any of these
    repo6, v1f, head6 = make_official()
    ws6 = make_workspace(repo6, v1f)
    base6 = snapshot(ws6)
    shutil.copy(SCRIPT_SRC, os.path.join(ws6, "manager/update_workspace.py"))
    base6 = snapshot(ws6)

    def stopped(label, res, why):
        check(res["outcome"] == "stopped" and why in res.get("reason", "") and snapshot(ws6) == base6,
              f"tamper — {label}: stopped, nothing written ({res.get('reason')})")

    stopped("run from the workspace copy",
            run(repo6, ws6, "apply", head6, "--restart-ok",
                script=os.path.join(ws6, "manager/update_workspace.py")), "official clone")
    stopped("wrong --expect-head", run(repo6, ws6, "apply", v1f, "--restart-ok"), "not the verified")
    write(os.path.join(repo6, "lib/data.py"), "tampered\n")
    stopped("dirty clone", run(repo6, ws6, "apply", head6, "--restart-ok"), "modified")
    g(repo6, "checkout", "--", "lib/data.py")
    g(repo6, "remote", "set-url", "origin", "https://github.com/evil/blave-agent")
    stopped("wrong origin", run(repo6, ws6, "apply", head6, "--restart-ok"), "origin")
    g(repo6, "remote", "set-url", "origin", "https://github.com/Blave-TW/blave-agent")
    os.symlink("/etc/hosts", os.path.join(repo6, "lib/evil.py"))
    g(repo6, "add", "-A")
    g(repo6, "commit", "-qm", "symlink")
    head6s = g(repo6, "rev-parse", "HEAD")
    stopped("a committed symlink in lib/", run(repo6, ws6, "apply", head6s, "--restart-ok"), "symlink")
    g(repo6, "rm", "-q", "lib/evil.py")
    write(os.path.join(repo6, "lib/bad name.py"), "x\n")
    g(repo6, "add", "-A")
    g(repo6, "commit", "-qm", "badname")
    head6b = g(repo6, "rev-parse", "HEAD")
    stopped("a path outside the rule", run(repo6, ws6, "apply", head6b, "--restart-ok"), "rule")
    g(repo6, "rm", "-q", "lib/bad name.py")
    g(repo6, "commit", "-qm", "clean")
    head6c = g(repo6, "rev-parse", "HEAD")
    outside = tempfile.mkdtemp(prefix="outside-", dir=TMP)
    shutil.rmtree(os.path.join(ws6, "examples"), ignore_errors=True)
    os.symlink(outside, os.path.join(ws6, "examples"))
    base6 = snapshot(ws6)
    stopped("a workspace dir that resolves outside the workspace",
            run(repo6, ws6, "apply", head6c, "--restart-ok"), "outside the workspace")
    check(os.listdir(outside) == [], "…and nothing landed outside")

    # 6b. an existing backup folder is never reused
    import datetime as _dt
    repo8, v1h, head8 = make_official()
    ws8 = make_workspace(repo8, v1h)
    unit("inactive")
    now8 = _dt.datetime.utcnow()
    for k in range(0, 6):
        os.makedirs(os.path.join(ws8, ".official-backup",
                                 "2026-09-01-a-" + (now8 + _dt.timedelta(seconds=k)).strftime("%Y%m%dT%H%M%SZ")))
    base8 = snapshot(ws8)
    r = run(repo8, ws8, "apply", head8, "--allow", "AGENTS.md")
    check(r["outcome"] == "stopped" and "already exists" in r.get("reason", "") and snapshot(ws8) == base8,
          "a backup folder with this update's tag already exists: stopped, nothing written, old backups untouched")

    # 7. a refused write keeps VERSION old
    repo7, v1g, head7 = make_official()
    ws7 = make_workspace(repo7, v1g)
    unit("inactive")
    refs = os.path.join(ws7, "references")
    os.chmod(refs, stat.S_IRUSR | stat.S_IXUSR)
    try:
        r = run(repo7, ws7, "apply", head7, "--allow", "AGENTS.md")
    finally:
        os.chmod(refs, stat.S_IRWXU)
    check(r["outcome"] == "partial" and [x["path"] for x in r["refused"]] == ["references/a.md"]
          and read(os.path.join(ws7, "VERSION")).strip() == "2026-09-01-a",
          "a write refused (read-only dir): reported, VERSION not written")
    # 7b. the official list comes from the verified commit, not from the working
    #     tree: a planted file is not copied, and VERSION is verified too
    repo9, v1i, head9 = make_official()
    ws9 = make_workspace(repo9, v1i)
    unit("inactive")
    write(os.path.join(repo9, "lib/planted.py"), "steal()\n")     # untracked
    write(os.path.join(repo9, ".gitignore"), "lib/planted.py\n")  # …and invisible to git status
    r = run(repo9, ws9, "apply", head9, "--allow", "AGENTS.md")
    check(r["outcome"] == "updated" and not os.path.exists(os.path.join(ws9, "lib/planted.py")),
          "a file planted in the clone's working tree (gitignored) is not official: never copied")
    os.remove(os.path.join(repo9, "lib/planted.py"))
    repo10, v1j, head10 = make_official()
    ws10 = make_workspace(repo10, v1j)
    base10 = snapshot(ws10)
    write(os.path.join(repo10, "VERSION"), "9999-99-99-z\n")
    r = run(repo10, ws10, "apply", head10, "--allow", "AGENTS.md")
    check(r["outcome"] == "stopped" and "VERSION" in r.get("reason", "")
          and snapshot(ws10) == base10,
          f"tamper — the clone's VERSION edited: stopped, nothing written ({r.get('reason')})")
    g(repo10, "checkout", "--", "VERSION")

    # 7c. --allow only names files the plan called changed_here
    base10 = snapshot(ws10)
    for bad in ("lib/data.py", "manager/portfolio_config.json", "../outside.py"):
        r = run(repo10, ws10, "apply", head10, "--allow", bad)
        check(r["outcome"] == "stopped" and "not changed here" in r.get("reason", "")
              and snapshot(ws10) == base10,
              f"--allow {bad}: stopped, nothing written (only a changed-here file can be allowed)")

    # 7d. the state is read again immediately before the restart: the user
    #     stopped the reconciler while the files were being copied
    repo11, v1k, head11 = make_official()
    ws11 = make_workspace(repo11, v1k)
    unit("active")
    clear_sudo()
    write(FLIP_F, "1")          # first read active (→ needs_restart), then inactive
    write(CALLS_F, "0")
    try:
        r = run(repo11, ws11, "apply", head11, "--restart-ok", "--allow", "AGENTS.md")
    finally:
        os.remove(FLIP_F)
    check(r["needs_restart"] is True and r["restart"] == "not_running_anymore"
          and not sudo_calls() and read(os.path.join(ws11, "VERSION")).strip() == "2026-09-23-b",
          "stopped while the files were copied: not restarted, left stopped, VERSION written")

    # 7e. Windows: nssm's UTF-16 status, and one JSON object even on a crash
    import importlib.util
    repo12, v1l, head12 = make_official()
    ws12 = make_workspace(repo12, v1l)
    spec = importlib.util.spec_from_file_location(  # from the clone: main() refuses anywhere else
        "uw_under_test", os.path.join(repo12, "manager/update_workspace.py"))
    uw = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(uw)

    class FakeRun:
        def __init__(self, out, rc=0):
            self.stdout, self.returncode = out, rc

    check(uw.nssm_text("SERVICE_RUNNING".encode("utf-16-le")) == "SERVICE_RUNNING"
          and uw.nssm_text("﻿SERVICE_STOPPED\r\n".encode("utf-16-le")) == "SERVICE_STOPPED"
          and uw.nssm_text(b"SERVICE_RUNNING\r\n") == "SERVICE_RUNNING",
          "nssm's UTF-16 status decodes (a locale decode left NULs between the letters)")
    uw.IS_WINDOWS = True
    real_run = uw.subprocess.run
    for raw, want in (("SERVICE_RUNNING".encode("utf-16-le"), "running"),
                      ("SERVICE_PAUSED".encode("utf-16-le"), ("stop", "nssm status 'SERVICE_PAUSED'"))):
        uw.subprocess.run = lambda *a, _o=raw, **k: FakeRun(_o)
        got = uw.reconciler_state()
        check(got == want if isinstance(want, str) else (isinstance(got, tuple) and got[0] == "stop"),
              f"Windows reconciler_state reads {raw.decode('utf-16-le')} as {want!r}")
    calls = []

    def fake_nssm(states):
        def f(argv, *a, **k):
            calls.append(argv[1:])
            return FakeRun(states.pop(0).encode("utf-16-le") if argv[1] == "status" else b"")
        return f
    uw.subprocess.run = fake_nssm(["SERVICE_RUNNING", "SERVICE_RUNNING"])
    ok_restart = uw.restart_capital_worker()
    restarted_calls = list(calls)
    calls.clear()
    uw.subprocess.run = fake_nssm(["SERVICE_STOPPED"])
    stopped = uw.restart_capital_worker()
    check(ok_restart is True and restarted_calls == [["status", "blave-agent-capital"], ["restart", "blave-agent-capital"],
                                                     ["status", "blave-agent-capital"]]
          and stopped is None and calls == [["status", "blave-agent-capital"]],
          "Windows: a running 群益 worker service is restarted (new lib reaches it); a stopped / missing one is left alone")
    uw.subprocess.run = real_run
    uw.IS_WINDOWS = False
    check(uw.restart_capital_worker() is None, "Linux: no 群益 worker service to restart")

    # 7f. the 永豐 worker (29026 11-26: the update landed, blave-agent-sinopac kept the old code)
    import ast
    seen, todo = set(), ["lib/sinopac_worker.py"]
    while todo:
        rel = todo.pop()
        if rel in seen:
            continue
        seen.add(rel)
        for n in ast.walk(ast.parse(read(os.path.join(ROOT, rel)))):
            names = ([f"lib/{a.name}.py" for a in n.names] if isinstance(n, ast.ImportFrom) and n.module == "lib"
                     else [n.module.replace(".", "/") + ".py"] if isinstance(n, ast.ImportFrom)
                     and (n.module or "").startswith("lib.") else [])
            todo += [x for x in names if os.path.exists(os.path.join(ROOT, x))]
    check(seen <= set(uw.SINOPAC_WORKER_FILES) and "lib/secret_imports.py" in uw.SINOPAC_WORKER_FILES,
          f"SINOPAC_WORKER_FILES holds every lib module the real worker imports ({sorted(seen - set(uw.SINOPAC_WORKER_FILES))})")

    real_open_builtin = open
    sp_ws = tempfile.mkdtemp(prefix="sp-ws-", dir=TMP)
    wpath = os.path.realpath(os.path.join(sp_ws, "lib", "sinopac_worker.py"))
    sp_orders = os.path.join(sp_ws, "state", "sinopac_orders")
    os.makedirs(sp_orders)
    sp_pending = os.path.join(sp_ws, "state", "sinopac_restart_pending.json")
    restarts = []
    real_worker, real_restart = uw.sinopac_worker, uw.restart_sinopac_worker
    uw.restart_sinopac_worker = lambda w: restarts.append(w) or "stopped"

    def sp(written=(), refused=(), wait=0, worker={"pid": 42, "started": None}):
        uw.sinopac_worker = (lambda _ws: (_ for _ in ()).throw(worker)) if isinstance(worker, Exception) \
            else (lambda _ws: worker)
        res = {}
        out = uw.restart_sinopac(sp_ws, set(written), set(refused), os.path.exists(sp_pending), wait, res, "v")
        return out, res

    restarts.clear()
    out, res = sp(written={"lib/data.py"})
    check(out is None and not restarts and "sinopac_worker" not in res,
          "永豐: none of its files written, nothing owed, not older than its files → not restarted")
    out, res = sp(written={"lib/sinopac_worker.py"})
    check(out == "stopped" and restarts == [{"pid": 42, "started": None}] and res["sinopac_worker"] == "stopped"
          and not os.path.exists(sp_pending),
          "永豐: a file it imports written → the running worker restarted, nothing owed")
    restarts.clear()
    out, res = sp(written={"lib/guard.py"}, worker=None)
    check(out is None and not restarts and res["sinopac_worker"] is None and not os.path.exists(sp_pending),
          "永豐: no worker running here (not bound / no service) → skipped, no error, nothing owed")

    def order_file(name, expires_in):
        write(os.path.join(sp_orders, name), json.dumps({"expires_at": time.time() + expires_in}))

    order_file("r1.taken", 20)  # being sent right now: no answer yet
    out, res = sp(written={"lib/sinopac_vault.py"})
    check(out == "busy" and not restarts and "r1" in res["sinopac_busy"] and os.path.exists(sp_pending),
          "永豐: an order the worker is sending (.taken, no answer) → not restarted, owed (pending record)")
    st = uw.status_doc(dict(res, outcome="restart_deferred", restart=None))
    check(st["sinopac_worker"] == "busy" and "r1" in (st["reason"] or "") and st["state"] == "done"
          and st["restarted"] is False,
          "…workspace_update.json carries sinopac_worker and the busy reason")
    write(os.path.join(sp_orders, "r1.resp.json"), "{}")
    order_file("r2.req.json", 20)  # waiting to be taken
    out, res = sp()
    check(out == "busy" and "r2" in res["sinopac_busy"] and "r1" not in res["sinopac_busy"] and not restarts,
          "…an answered one no longer counts; one waiting to be taken still does (owed run, nothing written)")
    os.remove(os.path.join(sp_orders, "r2.req.json"))
    order_file("r3.req.json", -3600)  # expired an hour ago: the worker refuses it, the requester gave up
    out, res = sp()
    check(out == "stopped" and restarts and not os.path.exists(sp_pending),
          "…the owed restart is done by the next run with nothing written, past an expired request; record cleared")
    restarts.clear()
    os.remove(os.path.join(sp_orders, "r3.req.json"))
    write(os.path.join(sp_ws, "state/execution/round"), "")
    out, res = sp(written={"lib/tw_clock.py"})
    check(out == "busy" and res["sinopac_busy"] == "reconciler mid-round" and not restarts,
          "…the reconciler mid-round is busy for the 永豐 restart too")
    os.remove(os.path.join(sp_ws, "state/execution/round"))
    threading_timer = __import__("threading").Timer
    order_file("r4.taken", 20)
    threading_timer(0.6, lambda: write(os.path.join(sp_orders, "r4.resp.json"), "{}")).start()
    out, res = sp(wait=10)
    check(out == "stopped" and restarts and os.path.exists(os.path.join(sp_ws, "state/execution/hold")),
          "…--wait-busy waits the order out, then restarts (the hold is up meanwhile; main() drops it)")
    restarts.clear()
    out, res = sp(written={"lib/sinopac_worker.py"}, refused={"lib/sinopac_worker.py"})
    check(out == "refused" and not restarts and os.path.exists(sp_pending),
          "…one of its files refused (part new, part old) → not restarted, owed")
    out, res = sp(worker=uw.Unreadable("x"))
    check(out == "failed" and not restarts and os.path.exists(sp_pending),
          "…its state unreadable while a restart is owed → failed, still owed")
    out, res = sp(worker=None)
    check(out is None and not os.path.exists(sp_pending), "…owed but no worker running any more → record cleared")
    sp_lib = os.path.join(sp_ws, "lib")
    write(os.path.join(sp_lib, "guard.py"), "x\n")
    mt = os.path.getmtime(os.path.join(sp_lib, "guard.py"))
    out, res = sp(worker={"pid": 42, "started": mt - 60})
    check(out == "stopped" and restarts,
          "…a worker started before its files last changed runs old code → restarted with nothing written (29026)")
    restarts.clear()
    out, res = sp(worker={"pid": 42, "started": mt + 1})
    check(out is None and not restarts, "…one started after them → left alone")
    # S1: a debt owed, but the worker's start is known and newer than its files → it is the new code
    write(sp_pending, json.dumps({"version": "x"}))
    restarts.clear()
    out, res = sp(worker={"pid": 42, "started": time.time() + 5})
    check(out is None and not restarts and not os.path.exists(sp_pending),
          "…owed, but the running worker started after its files changed → not killed, record cleared")
    # M1: the worker is read again right before the signal
    old_w, seq = {"pid": 42, "started": mt - 60}, []

    def next_worker(_ws):
        w = seq.pop(0)
        if isinstance(w, Exception):
            raise w
        return w
    uw.sinopac_worker = next_worker
    for later, want_restart, label in (
            ({"pid": 43, "started": time.time() + 5}, False, "replaced meanwhile by a newer worker → done, no signal"),
            (None, False, "gone meanwhile → done, no signal"),
            ({"pid": 42, "started": mt - 60}, True, "the same process (pid and start) → signalled"),
            ({"pid": 42, "started": mt - 30}, True, "pid reused by another old worker → that one is checked as stale")):
        restarts.clear()
        seq[:] = [old_w, later]
        res = {}
        out = uw.restart_sinopac(sp_ws, {"lib/sinopac_worker.py"}, set(), False, 0, res, "v")
        check(bool(restarts) == want_restart and (out is None) != want_restart
              and (not want_restart or restarts[0] == later),
              f"M1: {label} ({out})")
    seq[:] = [old_w, uw.Unreadable("y")]
    restarts.clear()
    res = {}
    out = uw.restart_sinopac(sp_ws, {"lib/sinopac_worker.py"}, set(), False, 0, res, "v")
    check(out == "failed" and not restarts and os.path.exists(sp_pending)
          and json.loads(read(sp_pending)).get("version") == "v",
          "M1: unreadable right before the signal → failed, owed, the record names this run's VERSION (S2)")
    os.remove(sp_pending)
    uw.sinopac_worker, uw.restart_sinopac_worker = real_worker, real_restart
    # low: a request whose expires_at is not finite counts by its file time, capped
    for name, exp, age, want in (("q1.taken", float("inf"), 2000, False), ("q2.taken", float("nan"), 0, True),
                                 ("q3.taken", time.time() + 1e9, 2000, False)):
        fp = os.path.join(sp_orders, name)
        write(fp, json.dumps({"expires_at": exp}))
        os.utime(fp, (time.time() - age, time.time() - age))
        check(bool(uw.sinopac_busy(sp_ws)) == want,
              f"expires_at {exp!r}, file {age}s old → {'busy' if want else 'not busy'} (never past ROUND_STALE_S)")
        os.remove(fp)
    check("lib/__init__.py" in uw.SINOPAC_WORKER_FILES, "lib/__init__.py (run by every `from lib import`) is in the list")
    # S3: MainPID alive, cmdline neither the worker nor its shim → Unreadable; the shim → None
    real_open, real_started = getattr(uw, "open", None), uw.proc_started
    uw.proc_started = lambda pid: 5.0
    for argv, want in (([sys.executable, wpath], {"pid": 77, "started": 5.0}),
                       ([sys.executable, "/opt/blave-agent/current/sinopac_service.py"], None),
                       (["/usr/bin/sleep", "100"], "unreadable")):
        uw.open = lambda path, mode="r", *a, _argv=argv, **k: (
            __import__("io").BytesIO(b"\0".join(x.encode() for x in _argv)) if path == "/proc/77/cmdline"
            else real_open_builtin(path, mode, *a, **k))
        uw.subprocess.run = lambda *a, **k: FakeRun("77\n")
        try:
            got = uw.sinopac_worker(sp_ws)
        except uw.Unreadable:
            got = "unreadable"
        check(got == want, f"S3: MainPID running {os.path.basename(argv[-1]) if argv[-1] != '100' else 'sleep'} → {want!r} ({got!r})")
    del uw.open
    uw.proc_started = real_started
    uw.subprocess.run = real_run

    # M1: the pid already gone when the signal goes → stopped, not failed
    gone = subprocess.Popen([sys.executable, "-c", "pass"])
    gone.wait()
    check(uw.restart_sinopac_worker({"pid": gone.pid, "started": None}) == "stopped",
          "Linux: SIGTERM finds the worker already gone (ProcessLookupError) → stopped, not failed")
    # the Linux stop itself: SIGTERM to the worker's own PID (the agent user has no sudo for its unit)
    child_src = os.path.join(TMP, "fake_sp_worker.py")
    write(child_src, "import signal, sys, time\nif sys.argv[1] == 'ignore': signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
                     "print('up', flush=True)\ntime.sleep(60)\n")
    for mode, want in (("term", "stopped"), ("ignore", "failed")):
        child = subprocess.Popen([sys.executable, child_src, mode], stdout=subprocess.PIPE)
        child.stdout.readline()
        __import__("threading").Thread(target=child.wait, daemon=True).start()  # systemd reaps; here we do
        uw.SINOPAC_STOP_WAIT_S = 1.5
        got = uw.restart_sinopac_worker({"pid": child.pid, "started": None})
        alive = child.poll() is None
        child.kill()
        check(got == want and alive == (mode == "ignore"),
              f"Linux: SIGTERM to the worker → {want} ({'never SIGKILLed' if mode == 'ignore' else 'it ended'})")
    real_systemctl = uw.subprocess.run
    uw.subprocess.run = lambda *a, **k: FakeRun("0\n")
    check(uw.sinopac_worker(sp_ws) is None, "Linux: MainPID 0 (unit not running / not installed) → no worker")
    uw.subprocess.run = lambda *a, **k: FakeRun("active\n")
    try:
        uw.sinopac_worker(sp_ws)
        unread = False
    except uw.Unreadable:
        unread = True
    check(unread, "Linux: a MainPID that is not a number → unreadable, never 'no worker'")
    uw.subprocess.run = real_systemctl
    uw.IS_WINDOWS = True

    def fake_win(ps_out, nssm=("SERVICE_RUNNING", "SERVICE_RUNNING"), ps_rc=0):
        states = list(nssm)

        def f(argv, *a, **k):
            if argv[0] == "powershell":
                calls.append(["powershell"])
                return FakeRun(ps_out, ps_rc)
            calls.append(argv[1:])
            return FakeRun(states.pop(0).encode("utf-16-le") if argv[1] == "status" else b"")
        return f
    procs = [{"pid": 7, "cmd": f'"C:\\py\\python.exe" "{wpath}"', "started": 1000.0},   # the venv launcher
             {"pid": 8, "cmd": f'"C:\\base\\python.exe" "{wpath}"', "started": 1000.4},  # the real python
             {"pid": 9, "cmd": "conhost.exe 0x4", "started": 999.0}]
    calls.clear()
    uw.subprocess.run = fake_win(json.dumps({"service": 6, "procs": procs}))
    w = uw.sinopac_worker(sp_ws)
    got = uw.restart_sinopac_worker(w)
    check(w == {"pid": 7, "started": 1000.0} and got == "ok"
          and calls == [["status", "blave-agent-sinopac"], ["powershell"], ["restart", "blave-agent-sinopac"],
                        ["status", "blave-agent-sinopac"]],
          f"Windows: the worker under NSSM (its child, not nssm.exe) with its start time; the service is restarted ({w})")
    uw.subprocess.run = fake_win(json.dumps({"service": 6, "procs": procs[1]}))
    check(uw.sinopac_worker(sp_ws) == {"pid": 8, "started": 1000.4},
          "Windows: one process (ConvertTo-Json unwraps the list) still reads")
    write(os.path.join(sp_ws, "lib/sinopac_vault.py"), "v\n")
    check(uw.sinopac_stale(sp_ws, uw.sinopac_worker(sp_ws)),
          "Windows: a worker started before its files changed reads as stale (the 11-26 Windows box is reached)")
    uw.subprocess.run = fake_win("not json")
    try:
        uw.sinopac_worker(sp_ws)
        unread = False
    except uw.Unreadable:
        unread = True
    check(unread, "Windows: service processes unreadable → Unreadable, never passed as 'no worker'")
    uw.subprocess.run = fake_win(json.dumps({"service": 6, "procs": [procs[2]]}))
    try:
        uw.sinopac_worker(sp_ws)
        unread = False
    except uw.Unreadable:
        unread = True
    check(unread, "Windows: the service runs something but no lib/sinopac_worker.py → Unreadable")
    uw.subprocess.run = fake_win(json.dumps({"service": 6, "procs": []}))
    check(uw.sinopac_worker(sp_ws) is None, "Windows: NSSM between two runs (no child) → no worker")
    uw.subprocess.run = lambda argv, *a, **k: FakeRun(b"", rc=3)
    check(uw.sinopac_worker(sp_ws) is None, "Windows: no blave-agent-sinopac service → no worker, no error")
    uw.subprocess.run = real_run
    uw.IS_WINDOWS = False

    # the whole run: a 永豐 restart deferred keeps VERSION old, and the next run restarts it without
    # restarting the reconciler again for the VERSION gap that alone leaves
    repoS, v1s, _headS = make_official()
    write(os.path.join(repoS, "lib/sinopac_worker.py"), "w = 2\n")
    write(os.path.join(repoS, "VERSION"), "2026-09-24\n")
    g(repoS, "add", "-A")
    g(repoS, "commit", "-qm", "v3")
    headS = g(repoS, "rev-parse", "HEAD")
    wsS = make_workspace(repoS, v1s)
    specS = importlib.util.spec_from_file_location("uw_sp", os.path.join(repoS, "manager/update_workspace.py"))
    uwS = importlib.util.module_from_spec(specS)
    specS.loader.exec_module(uwS)
    sp_restarts = []
    uwS.sinopac_worker = lambda _ws: {"pid": 42, "started": None}
    uwS.restart_sinopac_worker = lambda w: sp_restarts.append(w) or "stopped"
    write(os.path.join(wsS, "state/sinopac_orders/r9.taken"), json.dumps({"expires_at": time.time() + 600}))
    unit("active")
    clear_sudo()
    real_path = os.environ["PATH"]
    os.environ["PATH"] = ENV["PATH"]
    try:
        r1 = uwS.main(["apply", "--clone", repoS, "--workspace", wsS, "--expect-head", headS,
                       "--restart-ok", "--allow", "AGENTS.md"])
        st1 = json.loads(read(os.path.join(wsS, STATUS)))
        recon1 = [c for c in sudo_calls() if "reconciler" in c]
        sp1, ver1 = list(sp_restarts), read(os.path.join(wsS, "VERSION")).strip()
        clear_sudo()
        os.remove(os.path.join(wsS, "state/sinopac_orders/r9.taken"))
        r2 = uwS.main(["apply", "--clone", repoS, "--workspace", wsS, "--expect-head", headS, "--restart-ok"])
        recon2 = [c for c in sudo_calls() if "reconciler" in c]
    finally:
        os.environ["PATH"] = real_path
    check(r1["outcome"] == "restart_deferred" and r1["restart"] == "ok" and r1["sinopac_worker"] == "busy"
          and recon1 and not sp1 and r1["version_written"] is False
          and ver1 == "2026-09-01-a"
          and st1["sinopac_worker"] == "busy" and st1["outcome"] == "restart_deferred",
          f"apply: reconciler restarted, 永豐 busy → restart_deferred, VERSION old ({r1.get('outcome')}, {r1.get('sinopac_worker')})")
    # S2: a debt recorded for another VERSION does not explain this run's VERSION gap
    write(os.path.join(wsS, "VERSION"), "2026-09-01-a\n")
    write(os.path.join(wsS, "state/sinopac_restart_pending.json"), json.dumps({"version": "2026-09-01-z"}))
    uwS.sinopac_worker = lambda _ws: None
    clear_sudo()
    os.environ["PATH"] = ENV["PATH"]
    try:
        r3 = uwS.main(["apply", "--clone", repoS, "--workspace", wsS, "--expect-head", headS, "--restart-ok"])
    finally:
        os.environ["PATH"] = real_path
    check(r3["restart"] == "ok" and [c for c in sudo_calls() if "reconciler" in c],
          f"S2: an owed 永豐 restart for another VERSION → the gap is the reconciler's: restarted ({r3.get('restart')})")
    clear_sudo()
    check(r2["outcome"] == "updated" and r2["sinopac_worker"] == "stopped" and sp_restarts
          and r2["restart"] is None and not recon2 and r2["version_written"] is True
          and read(os.path.join(wsS, "VERSION")).strip() == "2026-09-24"
          and not os.path.exists(os.path.join(wsS, "state/sinopac_restart_pending.json")),
          f"…next run: the owed 永豐 restart, no second reconciler restart, VERSION written ({r2.get('outcome')}, {r2.get('restart')})")

    unit("inactive")
    real_plan, real_path = uw.plan, os.environ["PATH"]
    uw.plan = lambda *a, **k: (_ for _ in ()).throw(ValueError("boom"))
    os.environ["PATH"] = ENV["PATH"]  # this call runs in-process: it needs the fake systemctl
    try:
        res = uw.main(["apply", "--clone", repo12, "--workspace", ws12, "--expect-head", head12])
    finally:
        uw.plan, os.environ["PATH"] = real_plan, real_path
    check(res["outcome"] == "error" and "ValueError" in res.get("error", "")
          and res.get("version_after") == "2026-09-01-a" and json.dumps(res),
          "an unexpected failure is still one JSON object (outcome: error), never a traceback")

    # 8. the machine reports the new VERSION at once (config_version rides the strategy report)
    jobs = json.load(open(os.path.join(ROOT, "runtime", "jobs.json")))["linux_units"]
    unit_file = os.path.join(os.path.dirname(ROOT), "api", "blave_agent", "systemd", "blave-agent-strategies.path")
    unit_txt = read(unit_file) if os.path.exists(unit_file) else ""
    check(jobs.get("blave-agent-strategies.path") == {"enable": True}
          and "PathModified=/opt/blave-agent/workspace/VERSION" in unit_txt
          and "Unit=blave-agent-strategies.service" in unit_txt,
          "Linux: jobs.json enables blave-agent-strategies.path, which fires the strategy report on "
          "workspace/VERSION")
    fw = read(os.path.join(ROOT, "runtime", "file_watcher.py"))
    check('os.path.join(WORKSPACE, "VERSION"): (STRATEGIES,)' in fw
          and 'STRATEGIES = (VENV_PY, os.path.join(CURRENT, "strategy_reporter.py"))' in fw,
          "Windows: file_watcher runs the strategy report when workspace/VERSION changes")

    # 9. needs_restart — `references/cloud-handoff.md` U7 / `references/updating.md`
    #    §2: only lib/ or manager/ changing, or a previous update that never
    #    finished. A VERSION bump alone must NOT cut a running reconciler.
    SRC = read(SCRIPT_SRC)
    CODE_V2 = {"lib/data.py": "v = 2\n"}
    REFS_V2 = {"references/a.md": "ref v2\n"}

    def make_repo2(script, v2):
        """Two commits — v1, then v2 = {path: text} plus a new VERSION — with
        `script` as the clone's own manager/update_workspace.py (mutated or not;
        it is an official file, so it has to be the committed one)."""
        repo = tempfile.mkdtemp(prefix="nr-", dir=TMP)
        subprocess.run(["git", "init", "-q", repo], env=GIT_ENV, check=True)
        write(os.path.join(repo, "lib/data.py"), "v = 1\n")
        write(os.path.join(repo, "manager/reconciler.py"), GATED)
        write(os.path.join(repo, "references/a.md"), "ref v1\n")
        write(os.path.join(repo, "AGENTS.md"), "agents v1\n")
        write(os.path.join(repo, "CLAUDE.md"), "claude\n")
        write(os.path.join(repo, "VERSION"), "2026-09-01-a\n")
        write(os.path.join(repo, "manager/update_workspace.py"), script)
        g(repo, "add", "-A")
        g(repo, "commit", "-qm", "v1")
        v1 = g(repo, "rev-parse", "HEAD")
        for rel, text in v2.items():
            write(os.path.join(repo, rel), text)
        write(os.path.join(repo, "VERSION"), "2026-09-23-b\n")
        g(repo, "add", "-A")
        g(repo, "commit", "-qm", "v2")
        g(repo, "remote", "add", "origin", "https://github.com/Blave-TW/blave-agent")
        return repo, v1, g(repo, "rev-parse", "HEAD")

    def ws_at(repo, ref, version=None):
        ws = tempfile.mkdtemp(prefix="nr-ws-", dir=TMP)
        tar = subprocess.run(["git", "-C", repo, "archive", ref], env=GIT_ENV, capture_output=True,
                             check=True).stdout
        subprocess.run(["tar", "-x", "-C", ws], input=tar, check=True)
        if version:
            write(os.path.join(ws, "VERSION"), version)
        return ws

    def scenario(script, v2, at_head, state):
        """(plan, repo, workspace) for one needs_restart case."""
        unit(state)
        repo, v1, head = make_repo2(script, v2)
        ws = ws_at(repo, head, "2026-09-01-a\n") if at_head else ws_at(repo, v1)
        return run(repo, ws, "plan", head), repo, ws, head

    # a) lib/ or manager/ among the files to replace → restart
    clear_sudo()
    pA, repoA, wsA, headA = scenario(SRC, CODE_V2, False, "active")
    check(pA.get("needs_restart") is True and pA["old_official"] == ["lib/data.py"],
          f"needs_restart a) a lib/ file to replace, reconciler running → restart ({pA})")

    # b) only references/ → no restart, and VERSION is written all the same,
    #    without --restart-ok (a docs-only update never asks for the restart)
    pB, repoB, wsB, headB = scenario(SRC, REFS_V2, False, "active")
    rB = run(repoB, wsB, "apply", headB)
    check(pB.get("needs_restart") is False and pB["old_official"] == ["references/a.md"]
          and not pB["changed_here"] and not pB["missing"]
          and rB["outcome"] == "updated" and rB["restart"] is None and not sudo_calls()
          and rB["version_written"] is True
          and read(os.path.join(wsB, "VERSION")).strip() == "2026-09-23-b",
          f"needs_restart b) only references/ to replace: no restart, VERSION still written ({rB})")

    # c) nothing left to replace but VERSION behind (U8: the previous update
    #    copied the files and never got its restart) → restart, then VERSION
    pC, repoC, wsC, headC = scenario(SRC, CODE_V2, True, "active")
    rC = run(repoC, wsC, "apply", headC, "--restart-ok")
    check(pC.get("needs_restart") is True
          and not (pC["old_official"] or pC["changed_here"] or pC["missing"])
          and pC["version_before"] == "2026-09-01-a" and pC["version_clone"] == "2026-09-23-b"
          and rC["restart"] == "ok" and rC["version_written"] is True and sudo_calls(),
          f"needs_restart c) nothing to replace, VERSION behind → the unfinished update is "
          f"finished: restart, then VERSION ({rC})")
    clear_sudo()

    # d) the reconciler is not running → never a restart, whatever changed
    pD, repoD, wsD, headD = scenario(SRC, CODE_V2, False, "inactive")
    rD = run(repoD, wsD, "apply", headD)
    check(pD.get("needs_restart") is False and rD["outcome"] == "updated" and rD["restart"] is None
          and not sudo_calls(),
          f"needs_restart d) reconciler stopped: lib/ replaced, never restarted, never started ({rD})")

    # each case against a mutation of the rule: it has to go the other way
    for label, (old, new), case in (
            ("a VERSION gap alone restarts again", ("(touches_code or unfinished)",
                                                    "(touches_code or v_old != v_new)"), "b"),
            ("references/ counted as code", ('("lib", "manager")',
                                             '("lib", "manager", "references")'), "b"),
            ("the unfinished path dropped", ("(touches_code or unfinished)", "touches_code"), "c"),
            ("the code check dropped", ("(touches_code or unfinished)", "unfinished"), "a"),
            ("a stopped reconciler restarted too",
             ('state == "running" and (touches_code or unfinished)',
              "(touches_code or unfinished)"), "d")):
        v2, at_head, state, want = {"a": (CODE_V2, False, "active", True),
                                    "b": (REFS_V2, False, "active", False),
                                    "c": (CODE_V2, True, "active", True),
                                    "d": (CODE_V2, False, "inactive", False)}[case]
        src = SRC.replace(old, new, 1)
        check(src != SRC and SRC.count(old) == 1, f"mutation is real: {label}")
        got = scenario(src, v2, at_head, state)[0].get("needs_restart")
        check(got is (not want), f"mutation goes red: {label} → case {case} reads {got!r}")

    # 10. a failed restart is remembered: new lib/ on disk, old lib/ in the
    #     running daemon — no later file list can show it, so the run records it
    def failed_restart_sequence(script):
        """Run 1 replaces lib/ with a non-code file refused, and its restart
        fails. Then: the next plan, an apply without the restart consent, an
        apply whose restart fails again, and one whose restart works."""
        unit("active")
        repo, v1, head = make_repo2(script, {"lib/data.py": "v = 2\n",
                                             "references/a.md": "ref v2\n"})
        ws = ws_at(repo, v1)
        mark = os.path.join(ws, "state", "update_restart_pending.json")
        refs = os.path.join(ws, "references")
        write(SUDO_RC, "1")
        os.chmod(refs, stat.S_IRUSR | stat.S_IXUSR)
        try:
            out = {"r1": run(repo, ws, "apply", head, "--restart-ok")}
        finally:
            os.chmod(refs, stat.S_IRWXU)
        out["m1"] = os.path.exists(mark)
        out["p2"] = run(repo, ws, "plan", head)
        out["r2"] = run(repo, ws, "apply", head)           # no --restart-ok
        out["v2"] = read(os.path.join(ws, "VERSION")).strip()
        time.sleep(1.1)  # the backup folder is per second and never reused
        out["r3"] = run(repo, ws, "apply", head, "--restart-ok")   # sudo still fails
        out["m3"] = os.path.exists(mark)
        os.remove(SUDO_RC)
        clear_sudo()
        out["r4"] = run(repo, ws, "apply", head, "--restart-ok")
        out["m4"] = os.path.exists(mark)
        out["v4"] = read(os.path.join(ws, "VERSION")).strip()
        return out

    e = failed_restart_sequence(SRC)
    check(e["r1"]["outcome"] == "restart_failed" and e["r1"]["restart"] == "failed"
          and e["r1"]["replaced"] == ["lib/data.py"]
          and [x["path"] for x in e["r1"]["refused"]] == ["references/a.md"] and e["m1"] is True,
          f"a failed restart is recorded (the daemon still runs the old lib/) ({e['r1']})")
    check(e["p2"]["restart_pending"] is True and e["p2"]["needs_restart"] is True
          and e["p2"]["old_official"] == ["references/a.md"]
          and not (e["p2"]["changed_here"] or e["p2"]["missing"])
          and e["r2"]["outcome"] == "stopped" and e["v2"] == "2026-09-01-a",
          f"next run: only a non-code file left to replace, yet the restart is still owed — and "
          f"without --restart-ok nothing is written ({e['p2']})")
    check(e["r3"]["outcome"] == "restart_failed" and e["m3"] is True
          and e["r3"]["version_written"] is False,
          f"a second failed restart keeps the record, VERSION still old ({e['r3']})")
    check(e["r4"]["outcome"] == "updated" and e["r4"]["restart"] == "ok"
          and e["m4"] is False and e["v4"] == "2026-09-23-b",
          f"a restart that came back running clears the record, and only then VERSION ({e['r4']})")

    # a stale record never strands the machine: a run that finds the reconciler
    # stopped clears it — nothing holds the old code, the next start reads disk
    unit("inactive")
    clear_sudo()
    repoG, v1G, headG = make_repo2(SRC, REFS_V2)
    wsG = ws_at(repoG, v1G)
    markG = os.path.join(wsG, "state", "update_restart_pending.json")
    write(markG, '{"version": "2026-09-23-b"}')
    pG = run(repoG, wsG, "plan", headG)
    rG = run(repoG, wsG, "apply", headG)
    check(pG["restart_pending"] is True and pG["needs_restart"] is False
          and rG["outcome"] == "updated" and not os.path.exists(markG) and not sudo_calls(),
          f"a stale record with the reconciler stopped: cleared, no restart demanded ({rG})")

    WRITE = 'if restarted in ("failed", "busy", "refused"):\n        set_pending(workspace, v_new)'
    for label, (old, new), key in (
            ("the record is never written", (WRITE, 'if False:\n        set_pending(workspace, v_new)'), "m1"),
            ("the record is never read", ("unfinished = pending or (", "unfinished = ("), "p2"),
            ("a failed restart clears the record instead",
             (WRITE, 'if restarted in ("failed", "busy", "refused"):\n        drop_pending(workspace)'), "m1")):
        src = SRC.replace(old, new, 1)
        check(src != SRC and SRC.count(old) == 1, f"mutation is real: {label}")
        m = failed_restart_sequence(src)
        got = m["m1"] if key == "m1" else m["p2"].get("needs_restart")
        check(got is False, f"mutation goes red: {label} → {key} reads {got!r}")

    # 11. a state that cannot be read (activating, a dbus hiccup, a timeout) is
    #     not "the user stopped it" — the same value is a Stop at the top of the
    #     run, so here it goes where a failed restart goes
    def unreadable_state_run(script):
        unit("active")
        repo, v1, head = make_repo2(script, CODE_V2)
        ws = ws_at(repo, v1)
        write(FLIP_F, "1")          # 1st read active (→ needs_restart), then:
        write(FLIP_TO, "activating\n")
        write(CALLS_F, "0")
        clear_sudo()
        try:
            r = run(repo, ws, "apply", head, "--restart-ok")
        finally:
            os.remove(FLIP_F)
            os.remove(FLIP_TO)
        return r, os.path.exists(os.path.join(ws, "state", "update_restart_pending.json")), \
            read(os.path.join(ws, "VERSION")).strip()

    rU, mU, vU = unreadable_state_run(SRC)
    check(rU["outcome"] == "restart_failed" and rU["restart"] == "failed" and mU is True
          and rU["version_written"] is False and vU == "2026-09-01-a" and not sudo_calls(),
          f"a reconciler state that cannot be read counts as a failed restart: VERSION stays, "
          f"the record is kept, nothing is reported as updated ({rU})")
    src = SRC.replace('if isinstance(now, tuple):', 'if False:', 1)
    check(src != SRC and SRC.count('if isinstance(now, tuple):') == 1,
          "mutation is real: an unreadable state falls through to not_running_anymore")
    rM, mM, vM = unreadable_state_run(src)
    check(rM["restart"] == "not_running_anymore" and mM is False and vM == "2026-09-23-b",
          f"mutation goes red: an unreadable state read as 'the user stopped it' → "
          f"{rM['outcome']}, record gone, VERSION written ({vM})")

    # 12. a changed-here lib/ file the user keeps is never written, so it never
    #     restarts the order program — plan still asks (it cannot know --allow)
    unit("active")
    clear_sudo()
    repoK, v1K, headK = make_repo2(SRC, CODE_V2)
    wsK = ws_at(repoK, headK)                       # everything already equal…
    write(os.path.join(wsK, "lib/data.py"), "v = 2  # mine\n")   # …but this one
    pK = run(repoK, wsK, "plan", headK)
    rK = run(repoK, wsK, "apply", headK)            # no --allow, no --restart-ok
    check(pK["changed_here"] == ["lib/data.py"] and pK["needs_restart"] is True
          and rK["outcome"] == "partial" and rK["kept"] == ["lib/data.py"]
          and rK["replaced"] == [] and rK["added"] == [] and rK["restart"] is None
          and not sudo_calls() and read(os.path.join(wsK, "lib/data.py")) == "v = 2  # mine\n",
          f"a kept lib/ file: plan asks, apply writes nothing and restarts nothing ({rK})")
    src = SRC.replace('todo = p["old_official"] + [r for r in p["changed_here"] if r in allow] '
                      '+ p["missing"]',
                      'todo = p["old_official"] + p["changed_here"] + p["missing"]', 1)
    check(src != SRC, "mutation is real: apply counts kept files as code again")
    repoK2, v1K2, headK2 = make_repo2(src, CODE_V2)
    wsK2 = ws_at(repoK2, headK2)
    write(os.path.join(wsK2, "lib/data.py"), "v = 2  # mine\n")
    rK2 = run(repoK2, wsK2, "apply", headK2, "--restart-ok")
    check(rK2["restart"] == "ok" and sudo_calls(),
          f"mutation goes red: a kept lib/ file restarts the order program again ({rK2['restart']})")
    clear_sudo()

    # 12b. a 0.1.53 close-all deferred to the TW open, under HALT, with the restart failing: the
    #      old lib keeps running and re-reads state/paper_tw_close.json every round, so the run
    #      drops it before the copy, through the clone's own lib/portfolio (audit 0.1.55 S3)
    REAL_LIB = {os.path.join("lib", n): read(os.path.join(ROOT, "lib", n))
                for n in os.listdir(os.path.join(ROOT, "lib")) if n.endswith(".py")}

    def deferred_run(script, halted):
        unit("active")
        clear_sudo()
        repo, v1, head = make_repo2(script, REAL_LIB)
        ws = ws_at(repo, v1)
        write(os.path.join(ws, "state", "paper_tw_close.json"), '{"keys": ["TXF"], "ts": 1}')
        if halted:
            write(os.path.join(ws, "state", "HALT"), "{}")
        write(SUDO_RC, "1")
        try:
            r = run(repo, ws, "apply", head, "--restart-ok")
        finally:
            os.remove(SUDO_RC)
        try:
            rows = json.loads(read(os.path.join(ws, "manager", "order_errors.json")))
        except (OSError, ValueError):
            rows = []
        return r, os.path.exists(os.path.join(ws, "state", "paper_tw_close.json")), rows

    rD, leftD, rowsD = deferred_run(SRC, True)
    check(rD["outcome"] == "restart_failed" and rD.get("tw_deferred") == {"dropped": True}
          and "tw_deferred_again" not in rD and not leftD
          and [(x["symbol"], x["error"]) for x in rowsD]
          == [("TXF", "close-all: 更新後取消等開盤的平倉，部位可能還在、沒有停損，要自己查")],
          f"HALT + a deferral + a failed restart: the file is gone and one row says so ({rD.get('tw_deferred')}, {rowsD})")
    rN, leftN, rowsN = deferred_run(SRC, False)
    check(leftN and not rowsN and "tw_deferred" not in rN,
          "no HALT: the deferral is left to the old lib (it drops it and sends nothing)")
    src = SRC.replace("tw = drop_tw_deferred(clone, workspace)", "tw = None")
    check(SRC.count("tw = drop_tw_deferred(clone, workspace)") == 2, "mutation is real: the run never drops it")
    rM, leftM, rowsM = deferred_run(src, True)
    check(rM["outcome"] == "restart_failed" and leftM and not rowsM,
          "mutation goes red: without the drop the file outlives the failed restart for the old lib to send")
    clear_sudo()

    # 12c. drop_tw_deferred alone, against a stand-in clone lib: only a helper that truly failed
    #      drops the file without a row (audit 0.1.55 S3-a); undecodable stderr never raises (N7)
    import importlib.util
    spec = importlib.util.spec_from_file_location("uw_under_test", SCRIPT_SRC)
    uw = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(uw)
    uw.TW_DROP_RETRY_DELAYS = (0, 0, 0)

    def stub_drop(body):
        clone = tempfile.mkdtemp(dir=TMP)
        ws = tempfile.mkdtemp(dir=TMP)
        write(os.path.join(clone, "lib", "__init__.py"), "")
        write(os.path.join(clone, "lib", "portfolio.py"),
              "import os, sys\n"
              "def _drop_tw_deferred(keys, halted, book_known=True):\n" + body)
        write(os.path.join(ws, "state", "paper_tw_close.json"), '{"keys": ["TXF"]}')
        write(os.path.join(ws, "state", "HALT"), "{}")
        out = uw.drop_tw_deferred(clone, ws)
        cf = os.path.join(ws, "calls")
        return out, os.path.exists(os.path.join(ws, "state", "paper_tw_close.json")), \
            os.path.exists(os.path.join(ws, "row")), int(read(cf)) if os.path.exists(cf) else 0

    BUSY_ONCE = ("    n = int(open('calls').read()) if os.path.exists('calls') else 0\n"
                 "    open('calls', 'w').write(str(n + 1))\n"
                 "    if n == 0:\n        return\n"
                 "    os.remove('state/paper_tw_close.json')\n    open('row', 'w').write('x')\n")
    o, left, row, calls = stub_drop(BUSY_ONCE)
    check(o == {"dropped": True} and not left and row and calls == 2,
          f"helper ok but the file still there (busy): asked again, row written, not rowless ({o}, {calls})")
    o, left, row, _ = stub_drop("    return\n")
    check(o.get("dropped") is False and "rowless" not in o and left and not row,
          f"helper ok but the file never goes: it stays, no rowless drop, reason returned ({o})")
    o, left, row, _ = stub_drop("    raise RuntimeError('boom')\n")
    check(o.get("rowless") is True and o.get("dropped") is True and not left and not row
          and "boom" in o.get("error", ""),
          f"helper crashed: the file goes without a row ({o})")
    o, left, row, _ = stub_drop("    sys.stderr.buffer.write(b'\\xff\\xfe \\xe4\\xb8\\xad'); sys.exit(1)\n")
    check(o.get("rowless") is True and not left,
          f"undecodable stderr does not raise out of the update ({o})")

    # 14. state/workspace_update.lock (spec cloud-workspace-update-command-0160 §2.3, M2): the
    #     button (runtime/ws_update.py) and a chat update must not overwrite each other's status.
    #     The apply that loses prints locked and writes NOTHING — not even `applying`, which is
    #     how the lock is proven to come before the first status write.
    import fcntl
    repo14, v1n, head14 = make_official()
    ws14 = make_workspace(repo14, v1n)
    unit("inactive")
    write(os.path.join(ws14, STATUS), '{"state": "applying", "outcome": null, "from": "x", "ts": 1}')
    write(os.path.join(ws14, "state/execution/hold"), "999 1")  # the other run's hold
    status_before = read(os.path.join(ws14, STATUS))
    held = open(os.path.join(ws14, "state/workspace_update.lock"), "a+b")
    fcntl.flock(held.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    tree_before = snapshot(ws14)
    r = run(repo14, ws14, "apply", head14, "--restart-ok", "--allow", "AGENTS.md")
    check(r == {"mode": "apply", "outcome": "stopped", "reason": "another update is running on this machine",
                "locked": True},
          f"apply while another update holds the lock: one JSON line with locked ({r})")
    check(read(os.path.join(ws14, STATUS)) == status_before and snapshot(ws14) == tree_before
          and read(os.path.join(ws14, "state/execution/hold")) == "999 1",
          "…the other run's status is byte-for-byte untouched, nothing written, its hold not dropped")
    held.close()
    # audit P3-2: the runtime's probe holds the lock for an instant — a lock that goes away within
    # the retry window is waited out, not answered with locked
    import threading
    held = open(os.path.join(ws14, "state/workspace_update.lock"), "a+b")
    fcntl.flock(held.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    threading.Timer(0.5, held.close).start()
    r = run(repo14, ws14, "apply", head14, "--restart-ok", "--allow", "AGENTS.md")
    st14 = json.loads(read(os.path.join(ws14, STATUS)))
    probe = open(os.path.join(ws14, "state/workspace_update.lock"), "a+b")
    try:
        fcntl.flock(probe.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        released = True
    except OSError:
        released = False
    probe.close()
    check(r["outcome"] == "updated" and "locked" not in r and st14["state"] == "done"
          and st14["outcome"] == "updated" and released,
          f"a lock released 0.5 s later is waited out (P3-2): applying → done as before, and the lock is released when it ends ({r.get('outcome')})")

    # 13. the string probes of production code, against the real files — a
    #     rename turns the whole fleet's behaviour over with every test green
    check("RESTART_STOP_PATH" in read(os.path.join(ROOT, "manager", "reconciler.py")),
          "the real manager/reconciler.py carries RESTART_STOP_PATH (update_workspace's gate probe "
          "and runtime/command_listener's twin both read that name out of the file)")
    unit("inactive")
finally:
    shutil.rmtree(TMP, ignore_errors=True)

print("\nFAILED" if fails else "\nall ok")
sys.exit(1 if fails else 0)
