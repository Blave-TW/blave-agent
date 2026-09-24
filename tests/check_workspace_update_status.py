"""Workspace update without questions: the safe-moment gate and the status line.

What it protects:
  1. trading_busy(): an execution in flight (state/execution/inflight/*.json)
     or a fresh reconciler round marker (state/execution/round) is busy; a clean
     workspace or a stale marker (a crashed round) is not; the marker paths are
     the same strings lib/execute.py and manager/reconciler.py use;
  2. the reconciler writes the round marker around reconcile() and removes it
     in a finally and at startup;
  3. state/workspace_update.json: `applying` is on disk before the first check,
     the final `done` / `failed` after — with from / to / restarted /
     replaced_changed / backup_dir / ts; a run that stops still ends `failed`;
  4. apply --restart-ok while busy: the files land, nothing is restarted,
     "restart": "busy" with the reason, the restart is owed (pending record),
     VERSION stays old, the status says restarted: false + reason; the next run
     on a quiet workspace restarts and writes VERSION;
  5. --wait-busy polls: a marker that clears within the window → restarted;
     one that stays → busy after the window;
  6. runtime/portfolio_reporter forwards the file as `workspace_update` while it
     is under 24 h old and drops it after; an `applying` older than 20 min (a
     killed run) is forwarded as failed / error / "applying timed out";
  7. a refused lib/ or manager/ file: no restart on a part-new, part-old tree
     ("restart": "refused", outcome restart_deferred, owed); the next run
     writes the rest and restarts;
  8. state/execution/hold: apply places it before the copy and drops it however
     the run ends; the reconciler starts no round while a fresh one exists and
     removes one older than 15 min;
  with a mutation of the rule behind 1, 3 and 4.

Run: cd blave-agent && .venv/bin/python tests/check_workspace_update_status.py
"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT_SRC = os.path.join(ROOT, "manager", "update_workspace.py")
TMP = tempfile.mkdtemp(prefix="ws-update-status-")
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


def make_official(script=None):
    """Two commits (v1, v2) with `script` as the clone's own update_workspace.py."""
    repo = tempfile.mkdtemp(prefix="official-", dir=TMP)
    subprocess.run(["git", "init", "-q", repo], env=GIT_ENV, check=True)
    write(os.path.join(repo, "lib/data.py"), "v = 1\n")
    write(os.path.join(repo, "manager/reconciler.py"), GATED)
    write(os.path.join(repo, "AGENTS.md"), "agents v1\n")
    write(os.path.join(repo, "CLAUDE.md"), "claude\n")
    write(os.path.join(repo, "VERSION"), "2026-09-01-a\n")
    write(os.path.join(repo, "manager/update_workspace.py"), script or read(SCRIPT_SRC))
    g(repo, "add", "-A")
    g(repo, "commit", "-qm", "v1")
    v1 = g(repo, "rev-parse", "HEAD")
    write(os.path.join(repo, "lib/data.py"), "v = 2\n")
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
    os.remove(os.path.join(ws, "manager/update_workspace.py"))
    write(os.path.join(ws, "AGENTS.md"), "agents — edited on this machine\n")  # changed here
    os.makedirs(os.path.join(ws, "state"))
    return ws


BIN = os.path.join(TMP, "bin")
os.makedirs(BIN)
STATE_F = os.path.join(TMP, "unit_state")
SUDO_LOG = os.path.join(TMP, "sudo.log")
write(os.path.join(BIN, "systemctl"), f'#!/bin/sh\ncat "{STATE_F}"\n')
write(os.path.join(BIN, "sudo"), f'#!/bin/sh\necho "$@" >> "{SUDO_LOG}"\nexit 0\n')
write(os.path.join(BIN, "tmux"), "#!/bin/sh\nexit 1\n")
for n in ("systemctl", "sudo", "tmux"):
    os.chmod(os.path.join(BIN, n), 0o755)
ENV = dict(os.environ, PATH=BIN + os.pathsep + os.environ.get("PATH", ""))
write(STATE_F, "active\n")


def sudo_calls():
    return read(SUDO_LOG).splitlines() if os.path.exists(SUDO_LOG) else []


def clear_sudo():
    if os.path.exists(SUDO_LOG):
        os.remove(SUDO_LOG)


def run(repo, ws, mode, head, *extra):
    r = subprocess.run([sys.executable, os.path.join(repo, "manager/update_workspace.py"), mode,
                        "--clone", repo, "--workspace", ws, "--expect-head", head, *extra],
                       env=ENV, capture_output=True, text=True, timeout=120)
    try:
        return json.loads(r.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return {"outcome": "crash", "stderr": r.stderr[-400:]}


def status(ws):
    p = os.path.join(ws, "state", "workspace_update.json")
    return json.load(open(p)) if os.path.exists(p) else None


def load_script(repo):
    spec = importlib.util.spec_from_file_location("uw_" + os.path.basename(repo),
                                                  os.path.join(repo, "manager/update_workspace.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


INFLIGHT = "state/execution/inflight"
ROUND = "state/execution/round"


def mark_inflight(ws, key="BTCUSDT"):
    write(os.path.join(ws, INFLIGHT, key + ".json"), json.dumps({"key": key, "style": "twap:30m"}))


def unmark_inflight(ws, key="BTCUSDT"):
    os.remove(os.path.join(ws, INFLIGHT, key + ".json"))


try:
    SRC = read(SCRIPT_SRC)
    repo, v1, head = make_official()
    uw = load_script(repo)

    # ── 1. trading_busy()
    ws = make_workspace(repo, v1)
    check(uw.trading_busy(ws) is None, "trading_busy: clean workspace → None")
    mark_inflight(ws)
    check((uw.trading_busy(ws) or "").startswith("execution in flight: BTCUSDT"),
          "trading_busy: an in-flight execution marker → busy, with the key")
    unmark_inflight(ws)
    write(os.path.join(ws, ROUND), "123")
    check(uw.trading_busy(ws) == "reconciler mid-round", "trading_busy: a fresh round marker → busy")
    old = time.time() - uw.ROUND_STALE_S - 60
    os.utime(os.path.join(ws, ROUND), (old, old))
    check(uw.trading_busy(ws) is None, "trading_busy: a stale round marker (crashed round) → not busy")
    os.remove(os.path.join(ws, ROUND))
    write(os.path.join(ws, INFLIGHT, "note.txt"), "x")  # only *.json markers count
    check(uw.trading_busy(ws) is None, "trading_busy: a non-marker file in the folder is not busy")
    sys.path.insert(0, ROOT)
    from lib import execute  # noqa: E402
    check(execute._INFLIGHT_DIR == uw.INFLIGHT_DIR,
          "the in-flight folder is lib/execute's own string (the script never imports the workspace)")
    rec_src = read(os.path.join(ROOT, "manager", "reconciler.py"))
    check(f"ROUND_MARKER_PATH = Path('{uw.ROUND_MARKER}')" in rec_src,
          "the round marker path is manager/reconciler's own string")

    # ── 2. the reconciler's round marker
    cwd0 = os.getcwd()
    recws = tempfile.mkdtemp(prefix="rec-", dir=TMP)
    os.chdir(recws)
    os.makedirs("manager", exist_ok=True)
    write("manager/portfolio_config.json", '{"self_ledger": false}')
    try:
        from manager import reconciler as rec  # noqa: E402
        rec._round_marker(True)
        on = os.path.isfile(ROUND) and read(ROUND) == str(os.getpid())
        rec._round_marker(False)
        off = not os.path.exists(ROUND)
        rec._round_marker(False)  # already gone: not an error
        check(on and off, "reconciler._round_marker writes the pid and removes the file; removing twice is fine")
    finally:
        os.chdir(cwd0)
    loop = rec_src[rec_src.index("if __name__ == '__main__':"):]
    i_start, i_call = loop.find("_round_marker(False)"), loop.find("orders = reconcile(")
    i_on = loop.find("_round_marker(True)")
    i_fin = loop.find("finally:\n                _round_marker(False)")
    check(0 <= i_start < i_on < i_call < i_fin,
          "the loop clears a stale marker at startup, sets it right before reconcile() and clears it in a finally")

    # ── 3. the status file
    ws3 = make_workspace(repo, v1)
    seen = {}
    real_run = uw._run

    def peek(*a):
        seen["mid"] = status(ws3)
        raise uw.Stop("peek")
    uw._run = peek
    os.environ["PATH"] = ENV["PATH"]
    try:
        res = uw.main(["apply", "--clone", repo, "--workspace", ws3, "--expect-head", head])
    finally:
        uw._run = real_run
    mid = seen.get("mid") or {}
    check(mid.get("state") == "applying" and mid.get("from") == "2026-09-01-a"
          and mid.get("to") == "2026-09-23-b" and isinstance(mid.get("ts"), int),
          f"apply writes `applying` (from → to) before its first check ({mid})")
    fin = status(ws3) or {}
    check(res["outcome"] == "stopped" and fin.get("state") == "failed" and fin.get("outcome") == "stopped"
          and fin.get("reason") == "peek" and fin.get("restarted") is False
          and fin.get("from") == "2026-09-01-a" and fin.get("to") == "2026-09-23-b",
          f"a run that stops ends the status as `failed` with the reason, from and to kept ({fin})")
    p3 = uw.main(["plan", "--clone", repo, "--workspace", ws3, "--expect-head", head])
    check(p3["outcome"] == "plan" and status(ws3) == fin and p3.get("busy") is None,
          "plan never touches the status file, and reports busy: null on a quiet workspace")

    clear_sudo()
    r = run(repo, ws3, "apply", head, "--restart-ok", "--allow", "AGENTS.md")
    fin = status(ws3) or {}
    check(r["outcome"] == "updated" and fin.get("state") == "done" and fin.get("outcome") == "updated"
          and fin.get("from") == "2026-09-01-a" and fin.get("to") == "2026-09-23-b"
          and fin.get("restarted") is True and fin.get("reason") is None
          and fin.get("replaced_changed") == ["AGENTS.md"] and fin.get("backup_dir") == r["backup"]
          and fin.get("version_written") is True and fin.get("restart_stopped") is False
          and abs(fin.get("ts", 0) - time.time()) < 60,
          f"a full update ends `done`: restarted, the changed file listed, the backup folder, ts ({fin})")

    # ── 4. busy: files land, no restart, the restart is owed
    ws4 = make_workspace(repo, v1)
    mark_inflight(ws4, "ETHUSDT")
    clear_sudo()
    p4 = run(repo, ws4, "plan", head)
    r4 = run(repo, ws4, "apply", head, "--restart-ok", "--allow", "AGENTS.md")
    st4 = status(ws4) or {}
    pend = os.path.join(ws4, "state", "update_restart_pending.json")
    check(p4.get("busy", "").startswith("execution in flight"), f"plan reports why it is busy ({p4.get('busy')})")
    check(r4["outcome"] == "restart_deferred" and r4["restart"] == "busy"
          and r4["busy"].startswith("execution in flight: ETHUSDT") and not sudo_calls()
          and read(os.path.join(ws4, "lib/data.py")) == "v = 2\n"
          and read(os.path.join(ws4, "VERSION")).strip() == "2026-09-01-a"
          and r4["version_written"] is False and os.path.exists(pend),
          f"apply --restart-ok while busy: files on disk, NO restart, VERSION old, restart owed ({r4})")
    check(st4.get("state") == "done" and st4.get("outcome") == "restart_deferred"
          and st4.get("restarted") is False and st4.get("reason", "").startswith("execution in flight")
          and st4.get("version_written") is False,
          f"…status: done, restarted: false with the reason ({st4})")
    unmark_inflight(ws4, "ETHUSDT")
    r4b = run(repo, ws4, "apply", head, "--restart-ok")
    check(r4b["outcome"] == "updated" and r4b["restart"] == "ok" and sudo_calls()
          and read(os.path.join(ws4, "VERSION")).strip() == "2026-09-23-b" and not os.path.exists(pend),
          f"the next run on a quiet workspace restarts, clears the record, writes VERSION ({r4b})")
    clear_sudo()

    # ── 5. --wait-busy
    ws5 = make_workspace(repo, v1)
    mark_inflight(ws5)
    threading.Timer(1.5, unmark_inflight, args=(ws5,)).start()
    t0 = time.time()
    r5 = run(repo, ws5, "apply", head, "--restart-ok", "--allow", "AGENTS.md", "--wait-busy", "20")
    check(r5["outcome"] == "updated" and r5["restart"] == "ok" and 1 <= time.time() - t0 < 20,
          f"--wait-busy: a marker that clears inside the window → restarted after the wait ({r5['restart']})")
    clear_sudo()
    ws5b = make_workspace(repo, v1)
    mark_inflight(ws5b)
    t0 = time.time()
    r5b = run(repo, ws5b, "apply", head, "--restart-ok", "--allow", "AGENTS.md", "--wait-busy", "2")
    check(r5b["outcome"] == "restart_deferred" and time.time() - t0 >= 2 and not sudo_calls(),
          f"--wait-busy: a marker that stays → busy once the window is over ({r5b['restart']})")

    # ── 7. a refused lib/ file: the tree is part new, part old → no restart, owed
    ws7 = make_workspace(repo, v1)
    os.chmod(os.path.join(ws7, "lib"), 0o555)  # the backup copy reads fine; write_atomic's temp file is refused
    clear_sudo()
    try:
        r7 = run(repo, ws7, "apply", head, "--restart-ok", "--allow", "AGENTS.md")
    finally:
        os.chmod(os.path.join(ws7, "lib"), 0o755)
    st7 = status(ws7) or {}
    check(r7["outcome"] == "restart_deferred" and r7["restart"] == "refused"
          and [x["path"] for x in r7["refused"]] == ["lib/data.py"] and not sudo_calls()
          and read(os.path.join(ws7, "lib/data.py")) == "v = 1\n" and "AGENTS.md" in r7["replaced"]
          and read(os.path.join(ws7, "VERSION")).strip() == "2026-09-01-a"
          and os.path.exists(os.path.join(ws7, "state", "update_restart_pending.json"))
          and st7.get("state") == "done" and st7.get("outcome") == "restart_deferred"
          and st7.get("restarted") is False and "lib/data.py" in (st7.get("reason") or ""),
          f"a refused lib/ file: NO restart, owed, VERSION old, the status names the file "
          f"({r7.get('restart')}; {st7.get('reason')})")
    time.sleep(1.1)  # the backup folder is named to the second
    clear_sudo()
    r7b = run(repo, ws7, "apply", head, "--restart-ok")
    check(r7b["outcome"] == "updated" and r7b["restart"] == "ok" and sudo_calls()
          and read(os.path.join(ws7, "lib/data.py")) == "v = 2\n"
          and read(os.path.join(ws7, "VERSION")).strip() == "2026-09-23-b",
          f"the next run writes the rest and restarts ({r7b['outcome']}, {r7b['restart']})")

    # ── 8. the update hold: on disk from before the copy until after the restart, gone however the run ends
    check(uw.UPDATE_HOLD == "state/execution/hold"
          and f"UPDATE_HOLD_PATH = Path('{uw.UPDATE_HOLD}')" in rec_src,
          "the hold path is manager/reconciler's own string")
    ws8 = make_workspace(repo, v1)
    uw8 = load_script(repo)
    hold8 = os.path.join(ws8, uw8.UPDATE_HOLD)
    seen8 = {}

    def restart_ok():
        seen8["ok"] = os.path.exists(hold8) and read(os.path.join(ws8, "lib/data.py")) == "v = 2\n"
        return True
    uw8.restart_reconciler = restart_ok
    r8 = uw8.main(["apply", "--clone", repo, "--workspace", ws8, "--expect-head", head,
                   "--restart-ok", "--allow", "AGENTS.md"])
    check(r8["restart"] == "ok" and seen8.get("ok") is True and not os.path.exists(hold8),
          "apply: the hold is on disk when the restart runs (files already copied) and gone after it")
    ws8b = make_workspace(repo, v1)
    uw8b = load_script(repo)
    hold8b = os.path.join(ws8b, uw8b.UPDATE_HOLD)

    def restart_dies():
        seen8["dies"] = os.path.exists(hold8b)
        raise RuntimeError("boom")
    uw8b.restart_reconciler = restart_dies
    r8b = uw8b.main(["apply", "--clone", repo, "--workspace", ws8b, "--expect-head", head,
                     "--restart-ok", "--allow", "AGENTS.md"])
    check(r8b["outcome"] == "error" and seen8.get("dies") is True and not os.path.exists(hold8b),
          "apply: a run that dies after placing the hold still drops it")
    ws8c = make_workspace(repo, v1)
    uw8.main(["plan", "--clone", repo, "--workspace", ws8c, "--expect-head", head])
    check(not os.path.exists(os.path.join(ws8c, uw8.UPDATE_HOLD)), "plan never places the hold")
    os.chdir(recws)
    try:
        hold = rec.UPDATE_HOLD_PATH
        check(rec._update_hold() is False, "reconciler: no hold → the round runs")
        hold.parent.mkdir(parents=True, exist_ok=True)
        hold.write_text("1 1")
        check(rec._update_hold() is True and hold.exists(),
              "reconciler: a fresh hold → this round is skipped, the file is left for the script")
        old = time.time() - rec.UPDATE_HOLD_STALE_S - 60
        os.utime(hold, (old, old))
        check(rec._update_hold() is False and not hold.exists(),
              "reconciler: a hold older than 15 min is a dead script → ignored and removed")
    finally:
        os.chdir(cwd0)
    i_hold = loop.find("if _update_hold():")
    check(0 <= i_hold < i_on, "the loop asks for the hold before it starts a round")

    # ── mutations: each rule, once
    def mutant(old, new, label):
        src = SRC.replace(old, new, 1)
        check(src != SRC and SRC.count(old) == 1, f"mutation is real: {label}")
        return src

    mrepo, mv1, mhead = make_official(mutant("elif busy:", "elif False:", "the busy branch dropped"))
    mws = make_workspace(mrepo, mv1)
    mark_inflight(mws)
    clear_sudo()
    mr = run(mrepo, mws, "apply", mhead, "--restart-ok", "--allow", "AGENTS.md")
    check(mr.get("restart") == "ok" and sudo_calls(),
          f"mutation goes red: without the busy branch a live execution is cut by the restart ({mr.get('restart')})")
    clear_sudo()

    mrepo, mv1, mhead = make_official(mutant('if restarted in ("failed", "busy", "refused"):\n        set_pending',
                                             'if restarted == "failed":\n        set_pending',
                                             "a deferred restart is not owed"))
    mws = make_workspace(mrepo, mv1)
    mark_inflight(mws)
    run(mrepo, mws, "apply", mhead, "--restart-ok", "--allow", "AGENTS.md")
    check(not os.path.exists(os.path.join(mws, "state", "update_restart_pending.json")),
          "mutation goes red: a deferred restart leaves no record, so the next run would not restart")

    mrepo, mv1, mhead = make_official(mutant('    if a.mode == "apply":\n        write_status(workspace, {"state": "applying"',
                                             '    if False:\n        write_status(workspace, {"state": "applying"',
                                             "the applying write dropped"))
    mws = make_workspace(mrepo, mv1)
    muw = load_script(mrepo)
    seen_m = {}

    def peek_m(*a):
        seen_m["mid"] = status(mws)
        raise muw.Stop("peek")
    muw._run = peek_m
    muw.main(["apply", "--clone", mrepo, "--workspace", mws, "--expect-head", mhead])
    check(seen_m.get("mid") is None and (status(mws) or {}).get("state") == "failed",
          "mutation goes red: with the applying write dropped nothing is on disk during the run "
          "(the desktop would never see 更新中…)")

    # ── 6. the reporter forwards it, and drops it after 24 h
    base = tempfile.mkdtemp(prefix="rep-", dir=TMP)
    ws6 = os.path.join(base, "workspace")
    os.makedirs(os.path.join(ws6, "state", "heartbeat"))
    os.makedirs(os.path.join(ws6, "manager"))
    os.environ["BLAVE_AGENT_BASE"] = base
    os.environ["BLAVE_AGENT_WORKSPACE"] = ws6
    os.environ.pop("BLAVE_AGENT_LOCAL", None)
    cwd0 = os.getcwd()
    os.chdir(ws6)
    sys.path.insert(0, os.path.join(ROOT, "runtime"))
    try:
        import portfolio_reporter  # noqa: E402
        check("workspace_update" not in portfolio_reporter.build_report(),
              "reporter: no status file → no workspace_update key")
        doc = {"state": "applying", "from": "2026-09-01-a", "to": "2026-09-23-b", "ts": int(time.time())}
        sp = os.path.join(ws6, "state", "workspace_update.json")
        write(sp, json.dumps(doc))
        check(portfolio_reporter.build_report().get("workspace_update") == doc,
              "reporter: the file is forwarded verbatim as workspace_update")
        old = time.time() - 24 * 3600 - 5
        os.utime(sp, (old, old))
        check("workspace_update" not in portfolio_reporter.build_report(),
              "reporter: a file older than 24 h is dropped")
        write(sp, "{not json")
        check("workspace_update" not in portfolio_reporter.build_report(),
              "reporter: an unreadable file is absent, never an error")
        # a run killed mid-way leaves `applying` behind: 19 min old is still a
        # run, 21 min old is a dead one reported as failed in status_doc's shape
        write(sp, json.dumps(doc))
        t19 = time.time() - 19 * 60
        os.utime(sp, (t19, t19))
        check(portfolio_reporter.build_report().get("workspace_update") == doc,
              "reporter: `applying` 19 min old is forwarded as it is")
        t21 = time.time() - 21 * 60
        os.utime(sp, (t21, t21))
        timed_out = portfolio_reporter.build_report().get("workspace_update") or {}
        check(timed_out.get("state") == "failed" and timed_out.get("outcome") == "error"
              and timed_out.get("reason") == "applying timed out"
              and timed_out.get("restarted") is False and timed_out.get("from") == doc["from"]
              and timed_out.get("to") == doc["to"] and timed_out.get("replaced_changed") == []
              and timed_out.get("backup_dir") is None,
              f"reporter: `applying` 21 min old → failed / error / 'applying timed out' ({timed_out})")
        done_doc = dict(doc, state="done", outcome="updated")
        write(sp, json.dumps(done_doc))
        os.utime(sp, (t21, t21))
        check(portfolio_reporter.build_report().get("workspace_update") == done_doc,
              "reporter: a `done` 21 min old keeps the 24 h rule (forwarded as it is)")
        real_ttl = portfolio_reporter.WORKSPACE_UPDATE_TTL_S
        write(sp, json.dumps(done_doc))  # a `done` line: `applying` has its own 20 min limit
        os.utime(sp, (old, old))
        portfolio_reporter.WORKSPACE_UPDATE_TTL_S = 10 ** 9
        try:
            leaked = portfolio_reporter.build_report().get("workspace_update") == done_doc
        finally:
            portfolio_reporter.WORKSPACE_UPDATE_TTL_S = real_ttl
        check(leaked, "mutation goes red: without the 24 h limit a day-old line comes back in every report")
    finally:
        os.chdir(cwd0)
finally:
    shutil.rmtree(TMP, ignore_errors=True)

print("\nFAILED" if fails else "\nall ok")
sys.exit(1 if fails else 0)
