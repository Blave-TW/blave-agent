"""Install the release's SDK pin into $BASE/sdk/<pin>/ (release job).

Linux: blave-agent-sdk.timer as blaveagent; Windows: the blave-agent-sdk
scheduled task (jobs.json windows_tasks, via run_task.ps1). Each run:

  1. pin = runtime/SDK_VERSION (bad format → nothing)
  2. venv already at/above the pin → nothing installed, nothing deleted (never
     downgrade: a venv upgraded by hand keeps its own SDK; a ready pin dir
     OLDER than the venv is only taken out of rotation, its `.ready` renamed)
  3. pin dir already `.ready` → only the deferred prune (step 7)
  4. lock, free-space check (MIN_FREE_BYTES), then pip into sdk/<pin>.tmp from
     runtime/sdk-lock-<platform>.txt with --require-hashes — every package of
     the tree pinned to the sha256s publish.py recorded; no lock file for this
     platform → nothing installed, an error recorded
  5. self-check in a child process, through sdk_pin.add_dir like a turn:
     claude_agent_sdk and mcp import FROM .tmp, an in-process MCP server can be
     built, __version__ is the pin, and the bundled CLI runs and reports
     __cli_version__ — an install without _bundled/ would otherwise let the SDK
     fall back silently to an older claude on PATH
  6. rename .tmp → sdk/<pin>, then write `.ready` (sdk_pin.py only trusts that)
  7. prune to the current + previous pin — only after a successful install,
     only when no turn is running (a turn may be on the old dir), and never
     when the state file was missing or unreadable (the previous pin unknown)

A `.bad` (sdk_pin.load fell back to the venv on that dir) counts as a failure
and the pin is reinstalled. MAX_FAILS failures of one pin stop retries for
FAIL_RESET_S. State in $BASE/state/sdk_sync.json; portfolio_reporter carries
report(). Importing this module does nothing — the updater's health check
imports every release module.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time

import sdk_pin

STATE_DIR = os.path.join(sdk_pin.BASE, "state")
STATE_PATH = os.path.join(STATE_DIR, "sdk_sync.json")
LOCK_PATH = os.path.join(STATE_DIR, "sdk_sync.lock")
MIN_FREE_BYTES = 1536 * 1024 * 1024
MAX_FAILS = 6
FAIL_RESET_S = 24 * 3600
# longer than any run can last (unit TimeoutStartSec 1200, Windows task limit 30 min)
LOCK_STALE_S = 3600
# pip 700 + probe 120 + CLI 120 + rename ≤ 12 stays inside TimeoutStartSec=1200
PIP_TIMEOUT_S = 700
CHECK_TIMEOUT_S = 120

BAD_ERROR = "import failed in a turn"

IS_WINDOWS = os.name == "nt"
# the bridges' interpreter and current/ — the same anchor control/updater.py uses
PYTHON_BIN = (os.path.join(sdk_pin.BASE, "venv", "Scripts", "python.exe") if IS_WINDOWS
              else f"{sdk_pin.BASE}/venv/bin/python3")
CURRENT = os.path.join(sdk_pin.BASE, "current")


def _load_state(path):
    """(state, trustworthy). A missing or unreadable file is not trustworthy: the
    previous pin is unknown, so nothing may be pruned on its say-so."""
    try:
        with open(path, encoding="utf-8") as f:
            st = json.load(f)
    except (OSError, ValueError):
        return {}, False
    return (st, True) if isinstance(st, dict) else ({}, False)


def _save_state(path, st):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(st, f)
    os.replace(tmp, path)


def _lock(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    try:
        if time.time() - os.path.getmtime(path) > LOCK_STALE_S:
            os.remove(path)
    except OSError:
        pass
    try:
        os.close(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL))
        return True
    except FileExistsError:
        return False


def turn_in_flight():
    """Copy of control/updater.py turn_in_flight (runtime cannot import the control
    plane): anchored to the bridges' exact spawn command, fails CLOSED — anything
    short of a clean "no turn" counts as a turn."""
    if IS_WINDOWS:
        # needles via the environment so the probe's own command line can't match
        script = ("$p = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | "
                  "Where-Object { $_.CommandLine -and "
                  "$_.CommandLine.Contains($env:BLAVE_MATCH_PY) -and "
                  "$_.CommandLine.Contains($env:BLAVE_MATCH_SCRIPT) }; "
                  "if ($p) { 'YES' } else { 'NO' }")
        try:
            out = subprocess.run(
                ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                capture_output=True, text=True, timeout=30,
                env={**os.environ, "BLAVE_MATCH_PY": PYTHON_BIN,
                     "BLAVE_MATCH_SCRIPT": "agent_turn.py"})
        except (subprocess.TimeoutExpired, OSError):
            return True
        return out.returncode != 0 or out.stdout.strip() != "NO"
    pattern = f"^{re.escape(PYTHON_BIN)} {re.escape(CURRENT)}/agent_turn\\.py( |$)"
    try:
        out = subprocess.run(["pgrep", "-f", pattern], capture_output=True, text=True,
                             timeout=10)
    except (subprocess.TimeoutExpired, OSError):
        return True
    return out.returncode != 1


def pip_install(pin, target, lock):
    cmd = [sys.executable, "-m", "pip", "install", "--isolated", "--disable-pip-version-check",
           "--no-input", "--only-binary=:all:", "--no-cache-dir", "--quiet", "--require-hashes",
           "--target", target, "-r", lock]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=PIP_TIMEOUT_S)
    if r.returncode != 0:
        raise RuntimeError(f"pip rc={r.returncode}: {(r.stderr or r.stdout).strip()[-300:]}")


# What a turn reaches beyond `import claude_agent_sdk`: mcp.server and the
# in-memory transport the SDK's in-process MCP servers run on.
_PROBE = (
    "import json, sys; sys.path.insert(0, sys.argv[2]); import sdk_pin; sdk_pin.add_dir(sys.argv[1]); "
    "import claude_agent_sdk as s, mcp, mcp.server, mcp.shared.memory; "
    "from claude_agent_sdk._cli_version import __cli_version__ as c; "
    "s.create_sdk_mcp_server(name='probe', tools=[]); "
    "print(json.dumps([s.__version__, c, s.__file__, mcp.__file__]))"
)


def verify(d, pin):
    """Returns the bundled CLI version; raises ValueError on anything off."""
    r = subprocess.run([sys.executable, "-c", _PROBE, d, os.path.dirname(sdk_pin.__file__)],
                       capture_output=True, text=True, timeout=CHECK_TIMEOUT_S, cwd=d)
    if r.returncode != 0:
        raise ValueError(f"import failed: {r.stderr.strip()[-300:]}")
    sdk, cli, init, mcp_init = json.loads(r.stdout.strip().splitlines()[-1])
    root = os.path.normcase(os.path.abspath(d)) + os.sep
    for f in (init, mcp_init):
        if not os.path.normcase(os.path.abspath(f)).startswith(root):
            raise ValueError(f"imported {f}, not the new install")
    if sdk != pin:
        raise ValueError(f"__version__ {sdk} != pin {pin}")
    exe = os.path.join(d, "claude_agent_sdk", "_bundled", sdk_pin.CLI_NAME)
    r = subprocess.run([exe, "--version"], capture_output=True, text=True,
                       timeout=CHECK_TIMEOUT_S)
    out = (r.stdout or "").strip()
    if r.returncode != 0 or out.split()[:1] != [cli]:
        raise ValueError(f"bundled CLI --version {out[:80]!r} rc={r.returncode}, want {cli}")
    return cli


def _rmtree(path):
    """True when gone. On Windows a dir with a running claude.exe stays until next run."""
    shutil.rmtree(path, ignore_errors=True)
    return not os.path.exists(path)


def _rename(src, dst):
    # Defender can hold a freshly written exe for a moment on Windows
    for i in range(6):
        try:
            os.rename(src, dst)
            return
        except OSError:
            if i == 5:
                raise
            time.sleep(2)


def prune(root, keep):
    for name in os.listdir(root):
        if name not in keep:
            try:
                os.remove(os.path.join(root, name, ".ready"))
            except OSError:
                pass
            _rmtree(os.path.join(root, name))


def run(pin_file=sdk_pin.PIN_FILE, root=sdk_pin.SDK_ROOT, state_path=STATE_PATH,
        lock_path=LOCK_PATH, venv=sdk_pin.venv_versions, install=pip_install, check=verify,
        free=lambda p: shutil.disk_usage(p).free, busy=turn_in_flight, lock_file=None,
        now=time.time):
    """One sync pass; returns the record it saved, or None when there was nothing to do."""
    pin = sdk_pin.read_pin(pin_file)
    if not pin:
        return None
    st, trusted = _load_state(state_path)

    def record(**kw):
        rec = {"pin": pin, "active": st.get("active"), "prev": st.get("prev"),
               "prune_pending": bool(st.get("prune_pending")), "at": int(now()), **kw}
        _save_state(state_path, rec)
        return rec

    venv_sdk, _ = venv()
    if venv_sdk and sdk_pin.PIN_RE.fullmatch(venv_sdk) and sdk_pin.vkey(venv_sdk) >= sdk_pin.vkey(pin):
        if sdk_pin.vkey(venv_sdk) > sdk_pin.vkey(pin) and sdk_pin.ready_dir(pin, root):
            # a ready pin dir older than the venv would downgrade every turn
            try:
                os.replace(os.path.join(root, pin, ".ready"),
                           os.path.join(root, pin, ".superseded"))
            except OSError:
                pass
        if st.get("pin") != pin or st.get("skip") != "venv_at_or_above_pin":
            return record(skip="venv_at_or_above_pin", venv=venv_sdk)
        return None

    if sdk_pin.ready_dir(pin, root):
        if trusted and st.get("prune_pending") and st.get("active") == pin and not busy():
            prune(root, {pin, st.get("prev")})
            st["prune_pending"] = False
            return record(ok=True, cli=st.get("cli"))
        return None

    fails = int(st.get("fails") or 0) if st.get("pin") == pin else 0
    if fails and now() - float(st.get("at") or 0) > FAIL_RESET_S:
        fails = 0
    if fails >= MAX_FAILS:
        return None
    if not _lock(lock_path):
        return None
    try:
        os.makedirs(root, exist_ok=True)
        final, tmp = os.path.join(root, pin), os.path.join(root, pin + ".tmp")
        bad = os.path.exists(os.path.join(final, ".bad"))
        # present without `.ready` = not trusted, whatever is in it; a dir still held
        # open (Windows) is retried next pass and counted only once it is gone
        if os.path.exists(final) and not _rmtree(final):
            return None
        if bad:
            fails += 1
            if fails >= MAX_FAILS:
                return record(error=BAD_ERROR, fails=fails)
        if os.path.exists(tmp) and not _rmtree(tmp):
            return None
        lock = lock_file or sdk_pin.lock_file()
        if not os.path.isfile(lock):
            return record(error=f"no lock file {os.path.basename(lock)}", fails=fails)
        if free(root) < MIN_FREE_BYTES:
            return record(error="disk", fails=fails)
        try:
            install(pin, tmp, lock)
            cli = check(tmp, pin)
            _rename(tmp, final)
            with open(os.path.join(final, ".ready"), "w", encoding="utf-8") as f:
                f.write(f"{pin} {cli}\n")
        except Exception as e:
            _rmtree(tmp)
            return record(error=str(e)[:300], fails=fails + 1)
        if trusted:
            prev = st.get("active") if st.get("active") != pin else st.get("prev")
            pending = True
        else:
            prev, pending = None, False   # previous pin unknown: prune nothing
        st.update(active=pin, prev=prev, prune_pending=pending)
        if pending and not busy():
            prune(root, {pin, prev})
            st["prune_pending"] = False
        return record(ok=True, cli=cli, fails=0)
    finally:
        try:
            os.remove(lock_path)
        except OSError:
            pass


def report(state_path=STATE_PATH, root=sdk_pin.SDK_ROOT, pin_file=sdk_pin.PIN_FILE):
    """sdk_pin.status() plus why the pin is not active yet, if a run said so."""
    out = sdk_pin.status(pin_file=pin_file, root=root)
    st, _ = _load_state(state_path)
    if st.get("pin") == out["pin"]:
        out.update({k: st[k] for k in ("error", "fails", "skip") if st.get(k)})
    if out["active"] == "venv" and out["pin"] and os.path.exists(
            os.path.join(root, out["pin"], ".bad")):
        out["error"] = BAD_ERROR   # a turn fell back; sync has not reinstalled yet
    return out


def main():
    rec = run()
    if rec:
        print(f"[sdk_sync] {json.dumps(rec)}", file=sys.stderr)


if __name__ == "__main__":
    main()
