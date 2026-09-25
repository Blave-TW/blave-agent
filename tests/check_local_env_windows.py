"""runtime/command_listener._local_child_env on Windows (os.name faked — no
Windows box): denylist, not the POSIX allowlist. SystemRoot / USERPROFILE /
APPDATA / LOCALAPPDATA / TEMP / TMP / PATHEXT / COMSPEC must pass (python does
not start without SystemRoot); BLAVE_* / ANTHROPIC_* / OPENAI_* are stripped
except the _LOCAL_ENV_PASS names (PYTHONUTF8, which the shell sets, must
survive — the whole Python tree inherits UTF-8 mode through it); POSIX branch
unchanged. Also _env_lock with fcntl=None + a fake msvcrt: LK_LOCK on byte 0
of WORKSPACE/.env.lock (the byte shell/datasrc.js LOCK_PY takes), retried on
OSError, released (seek 0 + LK_UNLCK) and closed even when the body raises.

Run: cd blave-agent && .venv/bin/python tests/check_local_env_windows.py
"""
import os
import sys
import tempfile
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = tempfile.mkdtemp(prefix="local-env-win-")
WS = os.path.join(BASE, "workspace")
os.makedirs(WS)
os.environ["BLAVE_AGENT_HOME"] = BASE
os.environ["BLAVE_AGENT_BASE"] = BASE
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
sys.path.insert(0, os.path.join(ROOT, "runtime"))
import command_listener as cl  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


MUST = ["SystemRoot", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "PATHEXT", "COMSPEC"]
FAKE = {
    "SystemRoot": r"C:\WINDOWS", "USERPROFILE": r"C:\Users\u", "APPDATA": r"C:\Users\u\AppData\Roaming",
    "LOCALAPPDATA": r"C:\Users\u\AppData\Local", "TEMP": r"C:\t", "TMP": r"C:\t", "PATHEXT": ".COM;.EXE;.BAT;.CMD",
    "COMSPEC": r"C:\WINDOWS\system32\cmd.exe", "Path": r"C:\WINDOWS\system32", "NUMBER_OF_PROCESSORS": "8",
    "HOME": r"C:\Users\u", "BLAVE_AGENT_STATE": os.path.join(BASE, "state"), "BLAVE_KLINE_SOURCE": "binance",
    "BLAVE_PROXY_TOKEN": "proxy-x", "blave_secret": "x", "ANTHROPIC_API_KEY": "sk-ant", "OPENAI_API_KEY": "sk", "anthropic_base_url": "x",
    "PYTHONUTF8": "1",
}

with mock.patch.dict(os.environ, FAKE, clear=True), mock.patch.object(os, "name", "nt"):
    env = cl._local_child_env(EXTRA="1")
check(all(env.get(k) == FAKE[k] for k in MUST), "nt: the eight system variables pass through")
check(all(k not in env for k in ("BLAVE_PROXY_TOKEN", "blave_secret", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "anthropic_base_url")),
      "nt: BLAVE_* / ANTHROPIC_* / OPENAI_* stripped, case-insensitively")
check(env.get("BLAVE_AGENT_STATE") == FAKE["BLAVE_AGENT_STATE"] and env.get("BLAVE_KLINE_SOURCE") == "binance",
      "nt: the allowlisted BLAVE_* names survive the denylist")
check(env.get("BLAVE_AGENT_WORKSPACE") == cl.WORKSPACE and env.get("EXTRA") == "1" and env.get("NUMBER_OF_PROCESSORS") == "8",
      "nt: workspace + extra set, everything else passes")
check(env.get("PYTHONUTF8") == "1" and not any(p.startswith("PYTHON") for p in cl._LOCAL_ENV_DROP),
      "nt: PYTHONUTF8 from the shell reaches the reconciler / strategies (denylist has no PYTHON prefix)")
# mutation: an allowlist would lose SystemRoot — make sure that is what the test detects
check(not all(k in {k2: v for k2, v in FAKE.items() if k2 in cl._LOCAL_ENV_PASS} for k in MUST), "nt: (mutation) the POSIX allowlist alone would drop SystemRoot")

with mock.patch.dict(os.environ, FAKE, clear=True), mock.patch.object(os, "name", "posix"):
    env = cl._local_child_env()
check(sorted(env) == sorted(["HOME", "BLAVE_AGENT_STATE", "BLAVE_KLINE_SOURCE", "BLAVE_AGENT_WORKSPACE"]),
      "posix: allowlist unchanged (only the _LOCAL_ENV_PASS names, no SystemRoot)")


# ── _env_lock on Windows: fcntl gone, msvcrt faked ──
class FakeMsvcrt:
    LK_LOCK, LK_UNLCK = 1, 0

    def __init__(self, refuse_first=0):
        self.calls, self.refuse = [], refuse_first

    def locking(self, fd, mode, n):
        self.calls.append((mode, n, os.lseek(fd, 0, os.SEEK_CUR), os.fstat(fd).st_ino))
        if mode == self.LK_LOCK and self.refuse:
            self.refuse -= 1
            raise OSError(36, "Resource deadlock avoided")


LOCK_INO = lambda: os.stat(os.path.join(WS, ".env.lock")).st_ino  # noqa: E731
real_fcntl, real_msvcrt = cl.fcntl, cl.msvcrt
cl.fcntl, cl.msvcrt = None, FakeMsvcrt(refuse_first=1)
ran = False
with cl._env_lock():
    ran = True
    locks = [c for c in cl.msvcrt.calls if c[0] == FakeMsvcrt.LK_LOCK]
    check(ran and len(locks) == 2 and all(c[1:3] == (1, 0) for c in locks) and locks[-1][3] == LOCK_INO(),
          "nt lock: LK_LOCK retried after OSError, 1 byte at position 0 of WORKSPACE/.env.lock")
    check(not [c for c in cl.msvcrt.calls if c[0] == FakeMsvcrt.LK_UNLCK], "nt lock: not released while the body runs")
unl = [c for c in cl.msvcrt.calls if c[0] == FakeMsvcrt.LK_UNLCK]
check(len(unl) == 1 and unl[0][1:3] == (1, 0) and unl[0][3] == LOCK_INO(), "nt lock: released once (seek 0 + LK_UNLCK 1 byte) on the same file")
cl.msvcrt = FakeMsvcrt()
try:
    with cl._env_lock():
        raise RuntimeError("body failed")
except RuntimeError:
    pass
check([c[0] for c in cl.msvcrt.calls] == [FakeMsvcrt.LK_LOCK, FakeMsvcrt.LK_UNLCK], "nt lock: body raising still unlocks")
before = set(os.listdir("/dev/fd")) if os.path.isdir("/dev/fd") else None
cl.msvcrt = FakeMsvcrt()
with cl._env_lock():
    fd_open = os.listdir("/dev/fd") if before is not None else None
check(before is None or (len(fd_open) == len(before) + 1 and set(os.listdir("/dev/fd")) == before), "nt lock: the lock fd is closed on exit")
# same byte as the shell's LOCK_PY (shell/datasrc.js) — the two writers only exclude each other on one file + one byte
ds = open(os.path.join(ROOT, "shell", "datasrc.js"), encoding="utf-8").read()
check("msvcrt.locking(fd,msvcrt.LK_LOCK,1)" in ds and 'os.open(sys.argv[1],os.O_CREAT|os.O_RDWR,0o600)' in ds
      and 'path.join(WS, ".env.lock")' in open(os.path.join(ROOT, "shell", "main.js"), encoding="utf-8").read(),
      "nt lock: shell/datasrc.js LOCK_PY locks 1 byte at position 0 of WS/.env.lock — the same byte")
cl.fcntl, cl.msvcrt = real_fcntl, real_msvcrt
if real_fcntl is not None:
    with cl._env_lock():
        ran = os.path.exists(os.path.join(WS, ".env.lock"))
    check(ran, "posix: _env_lock still flocks WORKSPACE/.env.lock (branch untouched)")

print("FAILED" if fails else "all ok")
sys.exit(1 if fails else 0)
