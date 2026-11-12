"""Runs strategies/<name>/strategy.py for manager/run_strategy.sh with the two guards a bare cron
entry lacks: one run of a strategy at a time, and a hard timeout. A Type B run that outlived its
cadence used to get a second copy started next to it (both reading the same state, both able to
order), and a hung one piled up forever with nothing reported.

Usage (cwd = workspace): python3 manager/run_locked.py <strategy_name>
Exit codes: the strategy's own; EXIT_BUSY when another run of the same strategy still holds the
lock (nothing started); EXIT_TIMEOUT when the run was killed at the timeout (coreutils timeout's
code). A strategy that itself exits EXIT_BUSY is reported as 1, so it can never read as a skip.

The lock is an OS lock (flock / msvcrt), so a crashed or killed holder never leaves a stale one
(same reasoning as lib/runner.py's backtest lock). The child does not inherit it: a strategy that
starts a background process would otherwise lock every later run out. A lock file that cannot be
opened (left behind by a root run) is logged and the run goes ahead unguarded, as before this
wrapper existed, instead of failing every tick. On POSIX the strategy gets its own process group
and a timed-out run is stopped as a group, SIGTERM first and SIGKILL after TERM_GRACE_S: a hung
grandchild (a stuck curl) would otherwise hold the output pipe open and keep this process, and
the lock, alive forever.

Timeout: INTERVAL "<N>m" → N minutes (capped at 30, the cadence runtime/command_listener.py
_strategy_cadence schedules it at) plus MARGIN_S. Anything else gets WIDE_TIMEOUT_S: such a
script runs hourly when the runtime scheduled it, but whatever cadence the agent agreed with the
user when it wrote the cron line itself (references/deployment.md, Type B step 4) — often daily,
with a cold fetch that can take over an hour — and neither the tag on the runtime's line nor the
agreed cadence reaches this process. The wide cap only bounds a hang; where healthcheck.py is
scheduled, its stale-run alarm reports one sooner. BLAVE_RUN_TIMEOUT_S (seconds) overrides both.
"""
import os
import re
import signal
import subprocess
import sys
import time

EXIT_BUSY = 75
EXIT_TIMEOUT = 124
MARGIN_S = 300
WIDE_TIMEOUT_S = 6 * 3600
TERM_GRACE_S = 30
DRAIN_S = 10
LOCK_DIR = "state/locks"
_INTERVAL_RE = re.compile(r'^\s*INTERVAL\s*=\s*["\']([^"\']+)["\']', re.M)


def timeout_seconds(script):
    override = os.environ.get("BLAVE_RUN_TIMEOUT_S", "")
    if override.isdigit() and int(override) > 0:
        return int(override)
    try:
        with open(script, encoding="utf-8", errors="replace") as f:
            m = _INTERVAL_RE.search(f.read())
    except OSError:
        m = None
    mm = re.match(r"(\d+)\s*m", m.group(1).lower()) if m else None
    if not mm:
        return WIDE_TIMEOUT_S
    return max(1, min(30, int(mm.group(1)))) * 60 + MARGIN_S


def _try_lock(fd):
    try:
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except BlockingIOError:
        return False
    except OSError:
        if os.name == "nt":  # msvcrt reports a held lock as a plain OSError
            return False
        raise


def _kill(proc, sig=None):
    try:
        if os.name == "nt":
            proc.kill()
        else:
            os.killpg(proc.pid, sig or signal.SIGKILL)
    except OSError:
        pass


def _stop(proc, partial):
    """Timed-out run: SIGTERM the group, so a strategy that handles SIGTERM gets TERM_GRACE_S to
    wind down, then SIGKILL whatever is left. Windows has no group signal here: kill at once."""
    out = None
    try:
        if os.name != "nt":
            _kill(proc, signal.SIGTERM)
            try:
                out, _ = proc.communicate(timeout=TERM_GRACE_S)
            except subprocess.TimeoutExpired:
                pass
    finally:
        # also reaches a grandchild that ignored SIGTERM after the child itself exited
        _kill(proc)
    if out is None:
        try:
            out, _ = proc.communicate(timeout=DRAIN_S)
        except subprocess.TimeoutExpired:  # something outside the group still holds the pipe
            out = partial
    return out


def _log(name, msg):
    try:
        with open(f"strategies/{name}/strategy.log", "a", encoding="utf-8") as f:
            f.write(time.strftime("%Y-%m-%dT%H:%M:%SZ ", time.gmtime()) + msg + "\n")
    except OSError:
        pass


def main(name):
    script = f"strategies/{name}/strategy.py"
    try:
        os.makedirs(LOCK_DIR, exist_ok=True)
        fd = os.open(f"{LOCK_DIR}/{name}.lock", os.O_CREAT | os.O_RDWR, 0o600)
        locked = _try_lock(fd)
    except OSError as e:
        _log(name, f"lock unavailable ({type(e).__name__}: {e}): running without the "
                   f"one-run-at-a-time guard")
        locked = True
    if not locked:
        return EXIT_BUSY
    timeout = timeout_seconds(script)
    # cron / stop_strategy SIGTERM: go through the except below so the child dies with us
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    with subprocess.Popen([sys.executable, script], stdout=subprocess.PIPE,
                          stderr=subprocess.STDOUT, start_new_session=os.name != "nt") as proc:
        try:
            out, _ = proc.communicate(timeout=timeout)
            code = proc.returncode
        except subprocess.TimeoutExpired as e:
            out = _stop(proc, e.output)
            out = (out or b"") + (f"\n[run_strategy] killed after exceeding {timeout}s "
                                  f"timeout\n").encode()
            code = EXIT_TIMEOUT
        except BaseException:
            _kill(proc)
            raise
    sys.stdout.buffer.write(out or b"")
    sys.stdout.flush()
    if code < 0:
        return 128 - code  # killed by a signal: the shell's 128+N, as the old direct run reported
    return 1 if code == EXIT_BUSY else code


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: run_locked.py <strategy_name>")
    sys.exit(main(sys.argv[1]))
