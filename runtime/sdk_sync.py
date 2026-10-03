"""Install the release's SDK pin into $BASE/sdk/<pin>/ (release job).

Linux: blave-agent-sdk.timer as blaveagent; Windows: the blave-agent-sdk
scheduled task (jobs.json windows_tasks, via run_task.ps1). Each run:

  1. pin = runtime/SDK_VERSION (bad format → nothing)
  2. pin dir already `.ready`, or the venv already at/above the pin → done
     (never downgrade: a venv upgraded by hand stays on its own SDK)
  3. lock, free-space check (MIN_FREE_BYTES), then pip into sdk/<pin>.tmp
  4. self-check in a child process: claude_agent_sdk imports FROM .tmp, its
     __version__ is the pin, and the bundled CLI binary runs and reports
     __cli_version__ — an install without _bundled/ would otherwise let the
     SDK fall back silently to an older claude on PATH
  5. rename .tmp → sdk/<pin>, then write `.ready` (sdk_pin.py only trusts that)
  6. keep the current and the previous pin, delete the rest

State in $BASE/state/sdk_sync.json; portfolio_reporter carries sdk_pin.status().
Importing this module does nothing — the updater's health check imports every
release module.
"""
import json
import os
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
# longer than any run can last (unit TimeoutStartSec 1200, Windows task limit 30 min)
LOCK_STALE_S = 3600
PIP_TIMEOUT_S = 900


def _load_state(path):
    try:
        with open(path, encoding="utf-8") as f:
            st = json.load(f)
        return st if isinstance(st, dict) else {}
    except (OSError, ValueError):
        return {}


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


def pip_install(pin, target):
    cmd = [sys.executable, "-m", "pip", "install", "--isolated", "--disable-pip-version-check",
           "--no-input", "--only-binary=:all:", "--no-cache-dir", "--quiet",
           "--target", target, f"claude-agent-sdk=={pin}"]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=PIP_TIMEOUT_S)
    if r.returncode != 0:
        raise RuntimeError(f"pip rc={r.returncode}: {(r.stderr or r.stdout).strip()[-300:]}")


_PROBE = (
    "import json, sys; sys.path.insert(0, sys.argv[1]); import claude_agent_sdk as s; "
    "from claude_agent_sdk._cli_version import __cli_version__ as c; "
    "print(json.dumps([s.__version__, c, s.__file__]))"
)


def verify(d, pin):
    """Returns the bundled CLI version; raises ValueError on anything off."""
    r = subprocess.run([sys.executable, "-c", _PROBE, d], capture_output=True, text=True,
                       timeout=120, cwd=d)
    if r.returncode != 0:
        raise ValueError(f"import failed: {r.stderr.strip()[-300:]}")
    sdk, cli, init = json.loads(r.stdout.strip().splitlines()[-1])
    pkg = os.path.join(os.path.abspath(d), "claude_agent_sdk") + os.sep
    if not os.path.normcase(os.path.abspath(init)).startswith(os.path.normcase(pkg)):
        raise ValueError(f"imported {init}, not the new install")
    if sdk != pin:
        raise ValueError(f"__version__ {sdk} != pin {pin}")
    exe = os.path.join(d, "claude_agent_sdk", "_bundled", sdk_pin.CLI_NAME)
    r = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=120)
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
        free=lambda p: shutil.disk_usage(p).free):
    """One sync pass; returns the record it saved, or None when there was nothing to do."""
    pin = sdk_pin.read_pin(pin_file)
    if not pin:
        return None
    st = _load_state(state_path)

    def record(**kw):
        rec = {"pin": pin, "active": st.get("active"), "prev": st.get("prev"),
               "at": int(time.time()), **kw}
        _save_state(state_path, rec)
        return rec

    venv_sdk, _ = venv()
    if venv_sdk and sdk_pin.PIN_RE.fullmatch(venv_sdk) and sdk_pin.vkey(venv_sdk) >= sdk_pin.vkey(pin):
        # never downgrade; and a pin dir left over would shadow the newer venv
        if os.path.isdir(root) and os.listdir(root):
            prune(root, set())
        if st.get("pin") != pin or st.get("skip") != "venv_at_or_above_pin":
            return record(skip="venv_at_or_above_pin", venv=venv_sdk)
        return None
    if sdk_pin.ready_dir(pin, root):
        return None
    fails = int(st.get("fails") or 0) if st.get("pin") == pin else 0
    if fails >= MAX_FAILS:
        return None
    if not _lock(lock_path):
        return None
    try:
        os.makedirs(root, exist_ok=True)
        final, tmp = os.path.join(root, pin), os.path.join(root, pin + ".tmp")
        # present without `.ready` = not trusted, whatever is in it
        if os.path.exists(final) and not _rmtree(final):
            return None
        if os.path.exists(tmp) and not _rmtree(tmp):
            return None
        if free(root) < MIN_FREE_BYTES:
            return record(error="disk", fails=fails)
        try:
            install(pin, tmp)
            cli = check(tmp, pin)
            _rename(tmp, final)
            with open(os.path.join(final, ".ready"), "w", encoding="utf-8") as f:
                f.write(f"{pin} {cli}\n")
        except Exception as e:
            _rmtree(tmp)
            return record(error=str(e)[:300], fails=fails + 1)
        prev = st.get("active") if st.get("active") != pin else st.get("prev")
        prune(root, {pin, prev})
        st.update(active=pin, prev=prev)
        return record(ok=True, cli=cli, fails=0)
    finally:
        try:
            os.remove(lock_path)
        except OSError:
            pass


def report(state_path=STATE_PATH):
    """sdk_pin.status() plus why the pin is not active yet, if a run said so."""
    out = sdk_pin.status()
    st = _load_state(state_path)
    if st.get("pin") == out["pin"]:
        out.update({k: st[k] for k in ("error", "fails", "skip") if st.get(k)})
    return out


def main():
    rec = run()
    if rec:
        print(f"[sdk_sync] {json.dumps(rec)}", file=sys.stderr)


if __name__ == "__main__":
    main()
