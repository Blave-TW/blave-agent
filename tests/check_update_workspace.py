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


def snapshot(ws):
    out = {}
    for dp, _dn, fn in os.walk(ws):
        for n in fn:
            p = os.path.join(dp, n)
            rel = os.path.relpath(p, ws)
            if rel != STATUS:
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
    uw.subprocess.run = real_run
    uw.IS_WINDOWS = False

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
