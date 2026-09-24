"""Update a cloud workspace from a verified official clone, in one run.

    python3 /tmp/oc-config/manager/update_workspace.py plan  --clone /tmp/oc-config \
        --workspace /opt/blave-agent/workspace --expect-head <sha>
    python3 /tmp/oc-config/manager/update_workspace.py apply --clone /tmp/oc-config \
        --workspace /opt/blave-agent/workspace --expect-head <sha> \
        [--allow lib/data.py,manager/x.py] [--restart-ok] [--wait-busy 600]

references/updating.md §2 and references/cloud-handoff.md (Updating the cloud
machine) as code, so an update is two commands instead of dozens. It is run
FROM the clone (it refuses to run from anywhere else): the clone is the verified
official content, the workspace is not. It prints one JSON object and never
asks anything.

Rules (the same as the references):
- Official file = a path in the clone under lib/ manager/ references/ examples/
  allocators/, plus AGENTS.md, CLAUDE.md, strategies/TEMPLATE_A.py and
  strategies/TEMPLATE_C.py. Anything else is never touched.
- A differing workspace copy whose git blob appears in the clone's history of
  that path is an older official version: replaced. Otherwise it was changed
  on this machine: replaced only when listed in --allow, else kept (and then
  VERSION is not written).
- Backup first into .official-backup/<old VERSION>-<UTC time>/, verified; a file
  whose backup fails is not replaced. Every write is tmp + os.replace.
- Reconciler: running + lib/ or manager/ among the files this run actually
  writes (or the previous update never finished) → one restart; needs
  --restart-ok. plan does not know --allow yet and answers for the worst case;
  a file the user keeps is never written and never restarts for. Never started
  when it was not running, and a state that cannot be read counts as a failed
  restart, never as "it was stopped". With state/reconciler_stopped.json
  present it is restarted only if the new manager/reconciler.py carries the
  gate (it then sends nothing).
- state/update_restart_pending.json: a restart that came back "failed" leaves
  the new lib/ on disk while the daemon keeps executing the old one, and no
  later file list can show that (they compare disk against the clone, and disk
  is already right). So that run records it, and the next run owes the restart
  whatever the lists say. It holds the clone VERSION and the time for whoever
  reads state/ by hand; the run itself only needs to know it is there. Removed
  by a restart that came back running, and by any run that finds the reconciler
  not running — nothing then holds the old code and the next start reads the
  disk. Not written for "not_running_anymore" (same reason) nor for
  "skipped_not_gated": there the restart is forbidden, not owed, so the record
  could only ask for a consent this script would refuse again every time.
- Safe moment: the restart is refused while trading_busy() — an execution
  in flight (state/execution/inflight/*.json, lib/execute.py) or the reconciler
  inside a round (state/execution/round, manager/reconciler.py). --wait-busy N
  polls up to N seconds for it to clear; still busy → "restart": "busy",
  outcome "restart_deferred", the restart owed like a failed one (the pending
  record), VERSION not written. Nothing is ever asked: the next run restarts.
  The gap between that check and the restart is closed by state/execution/hold:
  written before the copy, removed however the run ends; the reconciler starts
  no round while it exists (and drops one older than 15 min as a dead script).
- A refused lib/ or manager/ file → no restart ("restart": "refused", outcome
  restart_deferred, owed like busy): the tree is part new, part old and a
  process started on it may not come up; the running one still has the old
  set whole.
- state/workspace_update.json (apply only): "applying" before the first check,
  then the final "done" / "failed" with what happened — the runtime forwards it
  in the report for the desktop's 更新中… and the one line after.
- VERSION last, only if everything succeeded.
- Tamper checks: the clone must be at --expect-head with the official origin,
  and every official file (VERSION included) must match that commit's own blob
  — the file list comes from the commit, so a file planted in the working tree
  is not official and is never copied. No symlink among them; every path
  matches the path rule; no destination resolves outside the workspace.
- One JSON object, always: an unexpected failure is "outcome": "error" with
  whatever the run had already done, never a traceback.
"""
import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import time

OFFICIAL_DIRS = ("lib", "manager", "references", "examples", "allocators")
OFFICIAL_FILES = ("AGENTS.md", "CLAUDE.md", "strategies/TEMPLATE_A.py", "strategies/TEMPLATE_C.py")
CODE_DIRS = ("lib", "manager")  # a change here needs the reconciler restarted
# Machine state the runtime and lib write under manager/: never official, even if
# one gets committed by mistake — copying it would hand one machine's config, book
# or errors to every other, and "changed here" on the rest would block VERSION.
NEVER = ("manager/portfolio_config.json", "manager/amounts.ui.json",
         "manager/credentials.ui.json", "manager/account.json", "manager/order_errors.json",
         "manager/orders.jsonl", "manager/last_reconcile.json", "manager/ledger_seed.json",
         "manager/ledger_migration.json", "manager/spot_scope.json", "manager/flow_state.json",
         "manager/venue_ever_ok.json", "manager/proposal.json", "manager/mgmt_progress.json")
# user modules, and data files with no official counterpart (manager/ ships code only)
NEVER_PREFIXES = ("manager/executors/",)
MANAGER_STATE_RE = re.compile(r"^manager/[^/]+\.(json|jsonl|tmp)$")
ORIGIN = "https://github.com/Blave-TW/blave-agent"
PATH_RE = re.compile(r"^[A-Za-z0-9_./-]{1,160}$")
VERSION_RE = re.compile(r"^[A-Za-z0-9._-]{1,40}$")
RECONCILER_UNIT = "blave-agent-reconciler.service"
NSSM_SERVICE = "blaveclaw-reconciler"
IS_WINDOWS = platform.system() == "Windows"
# String twins of lib/execute._INFLIGHT_DIR and manager/reconciler.ROUND_MARKER_PATH:
# this script runs from the clone and never imports the workspace's own code.
INFLIGHT_DIR = "state/execution/inflight"
ROUND_MARKER = "state/execution/round"
ROUND_STALE_S = 900  # a marker older than this is a crashed round, not a live one.
                     # Assumes a round ends inside 15 min: one that runs longer (many
                     # legs on a slow broker API) is taken for crashed and the restart
                     # goes ahead in the middle of it.
UPDATE_HOLD = "state/execution/hold"
BUSY_POLL_S = 5
STATUS_FILE = "state/workspace_update.json"


class Stop(Exception):
    """Nothing was written: the reason goes out as outcome "stopped"."""


def git(clone, *args):
    env = {"PATH": os.environ.get("PATH", "") if IS_WINDOWS else "/usr/bin:/bin",
           "HOME": "/nonexistent", "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
    if IS_WINDOWS:
        env["SYSTEMROOT"] = os.environ.get("SYSTEMROOT", "")
    r = subprocess.run(["git", "-C", clone, *args], env=env, capture_output=True, text=True,
                       timeout=300)
    if r.returncode != 0:
        raise Stop(f"git {args[0]} failed: {(r.stderr or '').strip()[:200]}")
    return r.stdout


def blob_sha(path):
    with open(path, "rb") as f:
        data = f.read()
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def same(a, b):
    try:
        with open(a, "rb") as fa, open(b, "rb") as fb:
            return fa.read() == fb.read()
    except OSError:
        return False


def read_version(path):
    try:
        with open(path) as f:
            v = f.read().strip()
    except OSError:
        return None
    return v if VERSION_RE.match(v) else None


def tree_blobs(clone, head):
    """{path: (mode, blob sha)} of the verified commit itself. -z keeps paths
    raw — core.quotePath could otherwise re-spell a path past PATH_RE."""
    blobs = {}
    for rec in git(clone, "ls-tree", "-r", "-z", "--full-tree", head).split("\0"):
        if not rec:
            continue
        meta, tab, path = rec.partition("\t")
        parts = meta.split()
        if not tab or len(parts) < 3:
            raise Stop("unreadable git ls-tree output")
        if parts[1] == "blob":
            blobs[path] = (parts[0], parts[2])
    return blobs


def is_official(rel):
    if (rel in NEVER or rel.startswith(NEVER_PREFIXES) or MANAGER_STATE_RE.match(rel)
            or rel.endswith(".pyc") or "__pycache__" in rel.split("/")):
        return False
    return rel in OFFICIAL_FILES or rel.split("/")[0] in OFFICIAL_DIRS


def official_paths(clone, blobs):
    """Every official path OF THE VERIFIED COMMIT, each verified byte for byte
    against the commit's own blob — and VERSION with them, since it is copied
    too. The list comes from the commit, not from a directory walk: a file
    planted in the working tree (which .gitignore can hide from `git status`)
    is then not official and is never copied. Any mismatch, symlink or
    rule-breaking path is a tampered clone: Stop, nothing written."""
    out = []
    for rel in sorted(blobs):
        if not (is_official(rel) or rel == "VERSION"):
            continue
        mode, sha = blobs[rel]
        if not PATH_RE.match(rel) or ".." in rel.split("/"):
            raise Stop(f"path outside the rule in the clone: {rel!r}")
        if mode == "120000":
            raise Stop(f"symlink in the clone: {rel}")
        p = os.path.join(clone, rel)
        if os.path.islink(p) or not os.path.isfile(p):
            raise Stop(f"the clone does not hold its own {rel}")
        try:
            if blob_sha(p) != sha:
                raise Stop(f"the clone has been modified: {rel}")
        except OSError:
            raise Stop(f"the clone's {rel} is unreadable") from None
        if rel != "VERSION":  # written last, on its own
            out.append(rel)
    return out


def inside(workspace_real, path):
    real = os.path.realpath(path)
    return real == workspace_real or real.startswith(workspace_real + os.sep)


def history(clone, paths):
    """{path: every blob hash that path ever had} — one git call for all."""
    hashes = {p: set() for p in paths}
    if not paths:
        return hashes
    out = git(clone, "log", "--format=", "--raw", "--no-abbrev", "--no-renames", "--", *paths)
    for line in out.splitlines():
        if not line.startswith(":") or "\t" not in line:
            continue
        meta, path = line.split("\t", 1)
        parts = meta.split()
        if path in hashes and len(parts) >= 4:
            hashes[path].update(parts[2:4])
    return hashes


def nssm_text(out):
    """nssm writes to a _O_U16TEXT stdout, i.e. UTF-16 — decoded with the
    locale codec (text=True) SERVICE_RUNNING comes back as "S\\x00E\\x00R…",
    which .strip() does not clean and no comparison ever matches, so every
    Windows machine that HAS the reconciler service read as "stop"."""
    b = out or b""
    if b"\x00" in b:
        return b.decode("utf-16-le", "replace").strip().lstrip("\ufeff").strip()
    return b.decode("utf-8", "replace").strip()


def reconciler_state():
    """'running' | 'stopped' | ('stop', why)."""
    try:
        if IS_WINDOWS:
            r = subprocess.run(["nssm", "status", NSSM_SERVICE], capture_output=True, timeout=30)
            s = nssm_text(r.stdout)
            if r.returncode != 0:
                return "stopped"  # not installed
            return "running" if s == "SERVICE_RUNNING" else (
                "stopped" if s == "SERVICE_STOPPED" else ("stop", f"nssm status {s!r}"))
        r = subprocess.run(["systemctl", "is-active", RECONCILER_UNIT], capture_output=True,
                           text=True, timeout=30)
        s = (r.stdout or "").strip()
    except (OSError, subprocess.SubprocessError) as e:
        return ("stop", f"reconciler state unreadable: {type(e).__name__}")
    if s == "active":
        return "running"
    if s in ("inactive", "failed", "unknown"):
        try:
            t = subprocess.run(["tmux", "has-session", "-t", "reconciler"], capture_output=True,
                               timeout=20)
            if t.returncode == 0:
                return ("stop", "the reconciler runs in a tmux session, outside its service")
        except (OSError, subprocess.SubprocessError):
            pass
        return "stopped"
    return ("stop", f"systemctl is-active {s!r}")


def restart_reconciler():
    """True once the reconciler reads as running again."""
    try:
        if IS_WINDOWS:
            subprocess.run(["nssm", "restart", NSSM_SERVICE], capture_output=True, timeout=120)
        else:
            r = subprocess.run(["sudo", "-n", "/usr/bin/systemctl", "restart", RECONCILER_UNIT],
                               capture_output=True, timeout=60)
            if r.returncode != 0:
                return False
    except (OSError, subprocess.SubprocessError):
        return False
    for _ in range(10):
        if reconciler_state() == "running":
            return True
        time.sleep(1)
    return False


def trading_busy(workspace):
    """Why a restart would cut an order right now, or None: an async execution
    in flight, or the reconciler inside reconcile() (its synchronous legs)."""
    keys = []
    try:
        names = os.listdir(os.path.join(workspace, INFLIGHT_DIR))
    except OSError:
        names = []
    for name in sorted(names):
        if name.endswith(".json"):
            keys.append(name[:-5])
    if keys:
        return "execution in flight: " + ", ".join(keys[:8])
    try:
        age = time.time() - os.path.getmtime(os.path.join(workspace, ROUND_MARKER))
    except OSError:
        return None
    return "reconciler mid-round" if age < ROUND_STALE_S else None


def wait_not_busy(workspace, seconds):
    """The reason it is still busy after `seconds`, or None once clear."""
    deadline = time.time() + max(0, seconds)
    while True:
        why = trading_busy(workspace)
        if why is None or time.time() >= deadline:
            return why
        time.sleep(min(BUSY_POLL_S, max(0.1, deadline - time.time())))


def set_hold(workspace):
    """state/execution/hold: while it exists manager/reconciler.py starts no
    round, so no round can begin between trading_busy() clearing and the
    restart. Written before the copy, removed by main() however the run ends;
    the reconciler ignores and removes one older than its own limit (15 min),
    so a killed script cannot stop trading for good. Best effort, like the
    status file: without it the restart still happens, with the old window."""
    try:
        p = os.path.join(workspace, UPDATE_HOLD)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            f.write("%d %d" % (os.getpid(), int(time.time())))
    except OSError:
        pass


def drop_hold(workspace):
    try:
        os.remove(os.path.join(workspace, UPDATE_HOLD))
    except OSError:
        pass


def write_status(workspace, doc):
    """state/workspace_update.json, best effort — the status must never change
    what the run does or reports."""
    try:
        p = os.path.join(workspace, STATUS_FILE)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        tmp = p + ".update-tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(dict(doc, ts=int(time.time())), f, ensure_ascii=False)
        os.replace(tmp, p)
    except (OSError, TypeError, ValueError):
        pass


def status_doc(result, v_from=None, v_to=None):
    """What the desktop renders. `done` = the run finished and the files it
    could write are on disk (a deferred or failed restart is `restarted: false`
    with its `reason`, and `version_written` says whether the machine moved);
    `failed` = stopped / error / partial: nothing, or not everything, written."""
    outcome = result.get("outcome")
    restart = result.get("restart")
    reason = None
    if restart == "busy":
        reason = result.get("busy")
    elif restart == "refused":
        reason = "not restarted: %s not written, so lib/ or manager/ is part new, part old" % ", ".join(
            x["path"] for x in result.get("refused") or [] if x["path"].split("/")[0] in CODE_DIRS)
    elif restart in ("failed", "not_running_anymore", "skipped_not_gated"):
        reason = restart
    elif outcome in ("stopped", "error"):
        reason = result.get("reason") or result.get("error")
    elif outcome == "partial":
        reason = "kept: %s; refused: %s" % (result.get("kept") or [],
                                            [x["path"] for x in result.get("refused") or []])
    changed = set(result.get("changed_here") or [])
    return {
        "state": "done" if outcome in ("updated", "up_to_date", "restart_failed", "restart_deferred")
        else "failed",
        "outcome": outcome,
        "from": result.get("version_before", v_from),
        "to": result.get("version_clone", v_to),
        "restarted": restart == "ok",
        "reason": reason,
        "replaced_changed": [r for r in result.get("replaced") or [] if r in changed],
        "backup_dir": result.get("backup"),
        "restart_stopped": bool(result.get("restart_stopped")),
        "version_written": bool(result.get("version_written")),
    }


def pending_path(workspace):
    return os.path.join(workspace, "state", "update_restart_pending.json")


def set_pending(workspace, version):
    p = pending_path(workspace)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".update-tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"version": version, "at": time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())}, f)
    os.replace(tmp, p)


def drop_pending(workspace):
    """Best effort: a record that cannot be removed keeps asking for the
    restart, which is the safe way to be wrong."""
    try:
        os.remove(pending_path(workspace))
    except OSError:
        pass


def write_atomic(src, dst):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    tmp = dst + ".update-tmp"
    shutil.copyfile(src, tmp)
    shutil.copymode(src, tmp)
    os.replace(tmp, dst)
    if not same(src, dst):
        raise OSError("written file does not match the clone")


def plan(clone, workspace, paths):
    ws_real = os.path.realpath(workspace)
    differ, missing = [], []
    for rel in paths:
        dst = os.path.join(workspace, rel)
        if not inside(ws_real, os.path.dirname(dst)) or (os.path.lexists(dst) and not inside(ws_real, dst)):
            raise Stop(f"destination resolves outside the workspace: {rel}")
        if not os.path.lexists(dst):
            missing.append(rel)
        elif not same(os.path.join(clone, rel), dst):
            differ.append(rel)
    hist = history(clone, differ)
    old_official, changed_here = [], []
    for rel in differ:
        dst = os.path.join(workspace, rel)
        try:
            known = os.path.isfile(dst) and blob_sha(dst) in hist[rel]
        except OSError:
            known = False
        (old_official if known else changed_here).append(rel)
    return {"old_official": old_official, "changed_here": changed_here, "missing": missing}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=("plan", "apply"))
    ap.add_argument("--clone", required=True)
    ap.add_argument("--workspace", required=True)
    ap.add_argument("--expect-head", required=True)
    ap.add_argument("--allow", default="")
    ap.add_argument("--restart-ok", action="store_true")
    ap.add_argument("--wait-busy", type=int, default=0, metavar="SECONDS")
    a = ap.parse_args(argv)
    clone, workspace = os.path.realpath(a.clone), os.path.realpath(a.workspace)
    result = {"mode": a.mode, "outcome": None}
    v_from, v_to = (read_version(os.path.join(workspace, "VERSION")),
                    read_version(os.path.join(clone, "VERSION")))
    if a.mode == "apply":
        write_status(workspace, {"state": "applying", "outcome": None, "from": v_from, "to": v_to})
    try:
        _run(a, clone, workspace, result)
    except Stop as e:
        result.update(outcome="stopped", reason=str(e))
    except Exception as e:  # a traceback is not an answer: the caller is an agent
        # Everything reached so far is already in `result` (replaced / added /
        # kept / refused / restart), so the reply can say how far it got.
        result.update(outcome="error", error=f"{type(e).__name__}: {str(e)[:200]}")
        try:
            result["version_after"] = read_version(os.path.join(workspace, "VERSION"))
        except OSError:
            pass
    finally:
        if a.mode == "apply":
            drop_hold(workspace)
    if a.mode == "apply":
        write_status(workspace, status_doc(result, v_from, v_to))
    return result


def _run(a, clone, workspace, result):
    if not os.path.realpath(__file__).startswith(clone + os.sep):
        raise Stop("run this script from the official clone, not from the workspace")
    if not re.fullmatch(r"[0-9a-f]{40}", a.expect_head):
        raise Stop("--expect-head must be the 40-hex commit the anchor verified")
    origin = git(clone, "remote", "get-url", "origin").strip().rstrip("/")
    if (origin[:-4] if origin.endswith(".git") else origin) != ORIGIN:
        raise Stop("the clone's origin is not the official repository")
    head = git(clone, "rev-parse", "HEAD").strip()
    if head != a.expect_head:
        raise Stop(f"clone HEAD {head} is not the verified {a.expect_head}")
    paths = official_paths(clone, tree_blobs(clone, head))  # the tamper check
    result["head"] = head
    v_old = read_version(os.path.join(workspace, "VERSION"))
    v_new = read_version(os.path.join(clone, "VERSION"))
    if v_new is None:
        raise Stop("the clone has no valid VERSION")
    result.update(version_before=v_old, version_clone=v_new)
    state = reconciler_state()
    if isinstance(state, tuple):
        raise Stop(state[1])
    result["reconciler"] = state
    restart_record = os.path.exists(os.path.join(workspace, "state", "reconciler_stopped.json"))
    result["restart_stopped"] = restart_record
    pending = os.path.exists(pending_path(workspace))
    result["restart_pending"] = pending
    p = plan(clone, workspace, paths)
    result.update(p)
    # What will actually be written. plan cannot know --allow yet, so it
    # answers for the case the agent normally runs — every changed-here file
    # replaced. apply knows, and a file the user asked to keep is never
    # written: restarting for it would cut a live order for nothing, on every
    # update, for as long as they keep it (and the outcome stays "partial").
    todo = p["old_official"] + p["changed_here"] + p["missing"]
    allow = set()
    if a.mode == "apply":
        allow = {x for x in a.allow.split(",") if x}
        unknown = allow - set(p["changed_here"])
        if unknown:
            raise Stop(f"--allow names files that are not changed here: {sorted(unknown)}")
        todo = p["old_official"] + [r for r in p["changed_here"] if r in allow] + p["missing"]
    touches_code = any(r.split("/")[0] in CODE_DIRS for r in todo)
    # A VERSION gap on its own is not a reason — a references-only update
    # bumps it too, and a restart cuts whatever the reconciler is placing.
    # It means "the previous update never finished" (U8) only when every
    # official file already equals the clone: someone copied them and never
    # got the restart or the VERSION write done. A restart that failed says
    # so itself, whatever is left to replace alongside it.
    unfinished = pending or (not (p["old_official"] or p["changed_here"] or p["missing"])
                             and v_old != v_new)
    needs_restart = state == "running" and (touches_code or unfinished)
    result["needs_restart"] = needs_restart
    result["busy"] = trading_busy(workspace)
    if a.mode == "plan":
        result["outcome"] = "plan"
        return
    if needs_restart and not a.restart_ok:
        raise Stop("the reconciler is running and the restart was not agreed (--restart-ok)")
    kept = [r for r in p["changed_here"] if r not in allow]
    to_backup = [r for r in todo if os.path.lexists(os.path.join(workspace, r))]
    replaced, added, refused, backup_dir = [], [], [], None
    if to_backup:
        tag = f"{v_old or 'unknown'}-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}"
        root = os.path.join(workspace, ".official-backup")
        os.makedirs(root, exist_ok=True)
        backup_dir = os.path.join(root, tag)
        try:
            os.mkdir(backup_dir)
        except FileExistsError:
            raise Stop(f"backup folder {tag} already exists") from None
        result["backup"] = os.path.relpath(backup_dir, workspace)
    if needs_restart:
        set_hold(workspace)  # main() drops it, whatever the copy or the restart does
    for rel in todo:
        src, dst = os.path.join(clone, rel), os.path.join(workspace, rel)
        existed = os.path.lexists(dst)
        if existed and backup_dir is None:  # appeared between the plan and now
            refused.append({"path": rel, "error": "appeared after the plan: no backup folder"})
            continue
        try:
            if existed:
                bak = os.path.join(backup_dir, rel)
                os.makedirs(os.path.dirname(bak), exist_ok=True)
                shutil.copy2(dst, bak)
                if not same(dst, bak):
                    raise OSError("backup does not match the original")
            write_atomic(src, dst)
            (replaced if existed else added).append(rel)
        except OSError as e:
            refused.append({"path": rel, "error": f"{type(e).__name__}: {str(e)[:120]}"})
    result.update(replaced=replaced, added=added, kept=kept, refused=refused)
    restarted = None
    if needs_restart and any(x["path"].split("/")[0] in CODE_DIRS for x in refused):
        # lib/ or manager/ is now part new, part old: the new files may import
        # what the old ones lack, and a process started on that tree would not
        # come up. The running one still holds the old set whole and keeps
        # trading; the restart is owed like busy, to the run that writes the rest.
        restarted = "refused"
    elif needs_restart:
        gated = os.path.isfile(os.path.join(workspace, "manager", "reconciler.py")) and \
            "RESTART_STOP_PATH" in open(os.path.join(workspace, "manager", "reconciler.py"),
                                        encoding="utf-8", errors="replace").read()
        busy = wait_not_busy(workspace, a.wait_busy)
        result["busy"] = busy
        now = reconciler_state()
        if isinstance(now, tuple):
            # The same value is a Stop at the top of the run. "Unreadable"
            # (activating, a dbus hiccup, a timeout) is not "the user
            # stopped it": the daemon may well still be running the old
            # lib/, so it goes where a failed restart goes — VERSION stays
            # old and the record keeps the restart owed.
            restarted = "failed"
        elif now != "running":
            restarted = "not_running_anymore"  # stopped while files were copied: stays stopped
        elif restart_record and not gated:
            restarted = "skipped_not_gated"
        elif busy:
            # Not a safe moment: a leg is between order and fill. The files
            # are on disk; the record makes the next run restart, nobody asks.
            restarted = "busy"
        else:
            restarted = "ok" if restart_reconciler() else "failed"
    result["restart"] = restarted
    if restarted in ("failed", "busy", "refused"):
        set_pending(workspace, v_new)
    elif restarted in ("ok", "not_running_anymore") or state != "running":
        drop_pending(workspace)
    complete = not kept and not refused and restarted not in ("failed", "busy")
    if complete and v_old != v_new:
        write_atomic(os.path.join(clone, "VERSION"), os.path.join(workspace, "VERSION"))
    result["version_written"] = complete and v_old != v_new
    result["version_after"] = read_version(os.path.join(workspace, "VERSION"))
    result["outcome"] = ("restart_failed" if restarted == "failed" else
                         "restart_deferred" if restarted in ("busy", "refused") else
                         "partial" if not complete else
                         "updated" if (replaced or added or v_old != v_new) else "up_to_date")


if __name__ == "__main__":
    res = main()
    print(json.dumps(res, ensure_ascii=False))
    sys.exit(0 if res.get("outcome") in ("plan", "updated", "up_to_date") else 1)
