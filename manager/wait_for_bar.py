"""
Polls every minute (via cron) for the newly-closed bar a strategy needs, and
only runs the strategy once the data has actually landed.

Why: a plain hourly (or any-interval) cron fires at the bar boundary itself,
but the exchange/Blave API doesn't always have that bar ready that instant —
a fixed "run 5 minutes late" buffer either wastes minutes on fast days or
isn't enough on slow ones. This checks freshness directly instead of guessing
a fixed delay, and stays quiet once the bar for this cycle is processed.

Type A and Type C only. Type B strategies have no INTERVAL/fetch_data
contract to poll — they keep the old fixed-cadence cron straight to
run_strategy.sh (Linux) / strategy.py (Windows), see references/deployment.md.

Cron (replaces the old "N * * * *  bash manager/run_strategy.sh <name>"):
  * * * * * cd $BLAVE_AGENT_HOME/workspace && python3 manager/wait_for_bar.py <name>

Cross-platform by design (Capital/群益 strategies only run on Windows, which
has no bash): the actual strategy subprocess is launched with sys.executable
(whatever interpreter is running this script) directly against strategy.py —
this file does NOT shell out to manager/run_strategy.sh, since that script is
bash-only. It reimplements the same crash-safety contract in Python instead
(capture output, log + Telegram-alert on non-zero exit via
manager/alert_failure.alert(), touch the heartbeat on success) so both
platforms get identical protection.

State: state/bar_wait/<name>.json
  last_processed_bar : ISO timestamp of the bar this strategy already ran on
                        (fast-path exit — no fetch, no log — once this matches
                        the currently-expected bar)
  pending_since       : ISO timestamp of the first poll that found the
                         CURRENTLY-expected bucket not yet ready (reset once
                         it lands)
  last_seen_bar       : ISO timestamp of the latest bar actually observed in
                         fetch_data() on the last check, whether or not it
                         was enough to be "ready" (Type C: the straggler
                         symbol's last_valid_index — see _check_freshness).
                         Used to tell "still landing" apart from "market's
                         closed / data genuinely stuck" — see Market-closed
                         handling below.
  stall_alert_at      : epoch seconds of the last stale-data alert actually
                         sent for the CURRENT episode (None = never alerted
                         this episode yet). This one field is the sole "have
                         we already alerted" sentinel — it also drives the
                         poll throttle below and the STALL_REALERT_SECONDS
                         repeat cadence. Deliberately NOT derived by comparing
                         last_seen_bar against some other stored value: an
                         earlier version compared two independently-nullable
                         fields for equality, which silently NEVER alerted at
                         all for a symbol that had zero data ever (None ==
                         None reads as "already handled") and, separately,
                         could get stuck permanently un-repeating after a
                         state-file upgrade left the two fields already
                         equal. A single monotonic timestamp has neither
                         failure mode.
  last_attempt_failed_at : epoch seconds of the last failed run attempt (a
                            crashed run OR fetch_data() itself raising —
                            e.g. txf_composite_60m's deliberate fail-loud
                            RuntimeError on degraded dividend data), used to
                            back off retries instead of re-running (and
                            re-crashing) every single minute
  wrapper_error_alerted_at : epoch seconds of the last time THIS script (not
                              the strategy) alerted on its own uncaught error
  last_processed_data_bar : ISO timestamp of the bar the last successful run actually
                             computed on (the runner's probe `observed_ts`). Usually equal
                             to last_processed_bar; one bar later when a tick ran past the
                             minute and found the next bar already closed — then that next
                             slot is also done (fast path), nothing is recomputed.
  last_path           : "gate" | "probe" — which of the two paths below the last real
                         tick took (observability for fail-open; never read for control)
  gate_verified_key   : [strategy.py mtime_ns, size, lib/runner.py mtime_ns, size] of the
                         code that proved it walks run() with BLAVE_EXPECTED_BAR (left a
                         .started file); the gate path is only taken while this matches
  gate_unsupported_key / gate_unsupported_at : same key, for a strategy that exited 0
                         WITHOUT .started (never reached run(), or an old runner) — it
                         stays on the probe path until its code or lib/runner.py changes

Two paths (chosen per tick by _choose_path, see there):
  gate  : the strategy subprocess is started at once with BLAVE_EXPECTED_BAR=<expected>;
          lib/runner.run() fetches once, judges the bar itself (lib/freshness.judge) and
          exits 75 having written only state/bar_wait/<name>.probe.json when the bar is not
          in, or runs the normal live path when it is. One interpreter, one fetch per tick.
  probe : the original flow — fetch_data() in THIS process to check freshness, then
          strategy.py as a second interpreter — kept for strategies that do not go through
          run(), for a lib/runner.py without EXPECTED_BAR_GATE, and for the first tick after
          strategy.py or lib/runner.py changed (the gate is only trusted once the strategy
          has left a .started file, so an unsupported strategy never runs unprobed).
Handshake files live in state/bar_wait/ and are cleared before each gate run:
  <name>.started     written by run() on entry — proof it saw BLAVE_EXPECTED_BAR
  <name>.probe.json  written by run() after fetch_data(), before compute:
                     {expected, observed_ts, ready, straggler, feed_wait, pid, at}
  <name>.out         the subprocess's stdout+stderr (fed to alert_failure on a crash)
  <name>.ticks.jsonl one line per successful gate run {at, expected, data_bar, secs, state}
                     — the live record a replay (tools/signal_parity) is compared against;
                     past 2 MB the newest 1 MB is kept

Market-closed handling: TAIFEX index futures (a strategy whose SYMBOL is TXF/MXF/TMF
and fetches fetch_twfutures_ohlcv) have a session table here (_tw_fut_slot, judged on the
bar's [open, close) interval — 60m / 30m labels are whole / half hours): a slot the market
is closed for is neither polled nor waited on and ends the stall episode, an intraday bar
counts as late from its close, the daily bar from TAIFEX's ~15:00 publication, the
settlement day (third Wednesday) closes at 13:30 — so the 13:45→15:00 and 05:00→08:45 gaps
never read as a stall, and the first bars of the next session are polled at full speed.
Holidays are not in the table: one stale alert, a throttle that ends at the next closed slot.
For everything else `_expected_closed_bar_open` doesn't know a trading
calendar — it just floors wall-clock time, so `expected` keeps advancing
hourly straight through a ~55h weekend close with no new bar ever landing.
Without special-casing this, that reads as an ordinary "still waiting" and
would re-alert once per NEW bucket forever (~55 alerts across one weekend).
Fixed by keying the poll throttle and the alert dedup to `last_seen_bar`
(whether the underlying DATA has moved) instead of to `expected` (whether
wall-clock time has moved): once alerted for a given `last_seen_bar`, further
checks throttle down to once every STALL_POLL_MINUTES instead of every
minute — and resume at full speed the moment the data moves. This needs no
trading-calendar knowledge; it reacts to observed data behavior only.

Repeat alerting during a stall: the FIRST alert for a given `last_seen_bar`
fires at STALE_TIMEOUT_MINUTES; after that, as long as it's still the SAME
`last_seen_bar` (no progress at all), a repeat fires every
STALL_REALERT_SECONDS instead of never again. This matters because
`last_seen_bar` for a genuinely delisted/permanently-halted Type C universe
member never changes — without a repeat, the very first alert would be the
LAST one ever sent, and the strategy (the whole universe, not just that one
symbol — Type C only runs once ALL columns are ready) would silently stop
rebalancing forever with no further signal that anything is wrong. The
straggler's identity (Type C: which column; Type A: n/a) is named in the
alert text specifically so this is actionable — "check if this symbol is
delisted and belongs out of UNIVERSE" — not just a timestamp to puzzle over.

Cost note: the freshness check is NOT free — it calls the strategy's real
fetch_data(), the same call the actual run makes (multiple HTTP/cache-backed
sources for a strategy like txf_composite_60m). While a bar is pending and
not yet in a detected stall this runs once a minute; see Market-closed
handling above for what happens once one is detected.

Type A strategies (fetch_data → single DataFrame): ready when its last row's
timestamp reaches the expected bar.
Type C strategies (fetch_data → (close_df, open_df[, ...])): ready when
EVERY column in close_df has a valid (non-NaN) observation at/after the
expected bar — wait for the whole universe, not just the first symbol to
update. Caveat (by design, not a bug to silently work around): a UNIVERSE
that includes a symbol with no data going forward at all (delisted, halted
indefinitely) will never satisfy this — the whole strategy stops rebalancing
until that symbol is removed from UNIVERSE. See "Repeat alerting" above for
why this still gets a periodic nudge instead of going silent.

Timeout: if the bar hasn't landed within STALE_TIMEOUT_MINUTES of when this
script first noticed it pending, send one Telegram alert (not a repeat every
minute) and keep polling — never give up silently.

Concurrency: a stale-safe lock file (state/bar_wait/<name>.lock) guards the
fetch+run section so an overrunning previous tick's subprocess can't overlap
with the next minute's — see _acquire_lock.
"""
import importlib.util
import json
import logging
import os
import re
import signal
import subprocess
import sys
import time
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

STALE_TIMEOUT_MINUTES = 15
STALL_POLL_MINUTES = 15            # once a stall is confirmed (alerted, data still hasn't moved),
                                    # only re-check this often instead of every minute
STALL_REALERT_SECONDS = 24 * 3600  # repeat the stale-data alert at most this often while the
                                    # SAME last_seen_bar persists — without this, a permanently
                                    # stuck symbol (delisted) gets exactly one alert ever, then
                                    # silence, even though the strategy never runs again
STATE_DIR = "state/bar_wait"
RUN_TIMEOUT_SECONDS = 600          # kill a strategy subprocess that hangs (e.g. a stuck order API call)
# The lock also has to outlive _check_freshness, which is NOT subprocess-timeout-bounded —
# it runs fetch_data() in-process and can legitimately take several minutes across multiple
# retried HTTP sources (e.g. txf_composite_60m pulls 60m/1d/TAIEX/dividend series). Generous
# on purpose: the lock's job is cleaning up a genuinely-dead process, not a tight SLA — being
# too short risks two ticks racing on the same bucket, which too-long doesn't. This age is
# only the fallback: a lock whose recorded pid is gone is taken over at once (_acquire_lock),
# so a listener restart that kills a mid-flight tick doesn't silence the next 30 ticks.
LOCK_STALE_SECONDS = 1800
RETRY_BACKOFF_SECONDS = 300        # after a failed run OR a fetch_data() error, don't re-attempt every single minute
WRAPPER_ERROR_COOLDOWN_SECONDS = 6 * 3600         # this script's own crashes, not the strategy's
EXPECTED_BAR_ENV = "BLAVE_EXPECTED_BAR"           # lib/runner.py reads it (EXPECTED_BAR_ENV there)
NOT_READY_EXIT = 75                               # lib/runner.py NOT_READY_EXIT
CHILD_POLL_SECONDS = 0.5
TICKS_MAX_BYTES, TICKS_KEEP_BYTES = 2 << 20, 1 << 20   # <name>.ticks.jsonl rotation (tail kept)
OUTPUT_TAIL_CHARS = 20000                         # of <name>.out handed to alert_failure / strategy.log
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# lib/runner.py's capability flag, read as bytes — this process never imports lib on the
# gate path (that is the point: the fast path and the gate tick load no pandas here)
_GATE_FLAG_RE = re.compile(rb"^EXPECTED_BAR_GATE\s*=\s*1\b", re.M)
_INTERVAL_SRC_RE = re.compile(r'^INTERVAL\s*=\s*["\']([^"\']+)["\']', re.M)
# TAIFEX index futures (TXF and the MXF/TMF execution aliases, all on TXF bars): the only
# instrument with a session table here. Day 08:45–13:45, night 15:00–05:00 next day, Mon–Fri
# (Friday's night session runs into Saturday 05:00); the daily bar is TAIFEX's ~15:00 report.
# No holiday calendar — a holiday behaves as today (one stale alert, then the stall throttle).
_TW_FUT_SYMBOL_RE = re.compile(r'^SYMBOL\s*=\s*["\'](?:TXF|MXF|TMF)(?:R1)?["\']', re.M)
_TW_FUT_FETCH = "fetch_twfutures_ohlcv"
_TPE = timedelta(hours=8)
_TW_FUT_DAILY_POLL_FROM = timedelta(hours=13, minutes=45)  # TWN clock: the day session has closed
_TW_FUT_DAILY_DUE = timedelta(hours=15)                    # TWN clock: TAIFEX publishes the day


def _load_strategy_module(name):
    path = f"strategies/{name}/strategy.py"
    if not os.path.isfile(path):
        raise FileNotFoundError(f"{path} not found")
    spec = importlib.util.spec_from_file_location(f"strategy_wait_{name}", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_alert_failure_mod = None


def _alert_failure():
    """Loads manager/alert_failure.py by file path, NOT `from manager.alert_failure
    import alert` — measured on a real deployment: when this script is invoked the
    documented way (`python3 manager/wait_for_bar.py <name>`, cwd = workspace root),
    Python auto-prepends the SCRIPT'S OWN DIRECTORY (manager/) to sys.path. Since
    manager/manager.py also exists (the Manager & Reconciler CLI), `import manager`
    resolves to that single file instead of the manager/ package directory at the
    workspace root — an `ImportError` masquerading as "wait_for_bar.py itself is
    broken" while it's actually just failing to report a DIFFERENT failure. Loading
    by path sidesteps sys.path resolution entirely, same pattern as
    _load_strategy_module above and lib/allocator.py's load()."""
    global _alert_failure_mod
    if _alert_failure_mod is None:
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "alert_failure.py")
        spec = importlib.util.spec_from_file_location("wait_for_bar_alert_failure", path)
        _alert_failure_mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(_alert_failure_mod)
    return _alert_failure_mod


# Unit spellings actually in use across strategies/examples: '1h', '5min',
# '1d', but also the bare-'m' form ('60m', '1m') — both must resolve to the
# SAME meaning here as in manager/healthcheck.py's copy of this table; if one
# changes, change both or the two scripts silently disagree on cadence.
_INTERVAL_RE = re.compile(r"^(\d+)(min|m|h|d|w)$")
_UNIT_TO_KW = {"min": "minutes", "m": "minutes", "h": "hours", "d": "days", "w": "weeks"}


def _interval_to_timedelta(interval):
    m = _INTERVAL_RE.match(interval)
    if not m:
        raise ValueError(f"unrecognized INTERVAL format: {interval!r}")
    n, unit = int(m.group(1)), m.group(2)
    return timedelta(**{_UNIT_TO_KW[unit]: n})


def _expected_closed_bar_open(interval, now):
    """Open-time label of the most recently closed bar, epoch-aligned (matches
    how the underlying kline sources bucket bars — UTC midnight / top-of-hour)."""
    td = _interval_to_timedelta(interval)
    epoch = datetime(1970, 1, 1)
    since_epoch = now - epoch
    floored = epoch + (since_epoch // td) * td
    return floored - td


def _default_state():
    return {
        "last_processed_bar": None,
        "pending_since": None,
        "last_seen_bar": None,
        "stall_alert_at": None,
        "last_attempt_failed_at": None,
        "wrapper_error_alerted_at": None,
        "last_processed_data_bar": None,
        "last_path": None,
        "gate_verified_key": None,
        "gate_unsupported_key": None,
        "gate_unsupported_at": None,
    }


def _load_state(name):
    path = f"{STATE_DIR}/{name}.json"
    if os.path.exists(path):
        try:
            return {**_default_state(), **json.load(open(path))}
        except Exception as e:
            print(f"[wait_for_bar] {name}: state file corrupt ({e}), resetting")
    return _default_state()


def _save_state(name, state):
    os.makedirs(STATE_DIR, exist_ok=True)
    path = f"{STATE_DIR}/{name}.json"
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, path)


def _pid_alive(pid):
    """False only when the pid is known to be gone; any doubt (no permission to probe,
    pid recycled by something else) counts as alive and leaves the age fallback in charge.
    Windows: os.kill(pid, 0) is TerminateProcess there (runtime/turn_slots.py), so probe with
    OpenProcess + a zero wait like runtime/local_daemon._wait_pid_nt."""
    if os.name == "nt":
        import ctypes
        k = ctypes.WinDLL("kernel32", use_last_error=True)
        k.OpenProcess.restype = ctypes.c_void_p
        k.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
        k.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
        k.CloseHandle.argtypes = [ctypes.c_void_p]
        h = k.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
        if not h:
            return ctypes.get_last_error() != 87  # ERROR_INVALID_PARAMETER: no such pid
        try:
            return k.WaitForSingleObject(h, 0) != 0  # only WAIT_OBJECT_0 = exited; FAILED/ABANDONED = doubt
        finally:
            k.CloseHandle(h)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except OSError:
        return True
    return True


def _lock_pids(lock_path):
    """Line 1 = the wait_for_bar.py holder, line 2 (if any) = its strategy.py child."""
    try:
        with open(lock_path) as f:
            return [int(x) for x in f.read().split()]
    except (OSError, ValueError):
        return []


def _lock_holder_dead(lock_path):
    """Dead only when EVERY recorded pid is gone. A SIGKILLed/OOM-killed holder leaves its
    strategy.py child running as an orphan (up to RUN_TIMEOUT_SECONDS); taking over while it
    still runs would start a second strategy.py for the same bar."""
    pids = _lock_pids(lock_path)
    if not pids:
        return False  # no pid recorded — only the age fallback can decide
    return all(pid > 0 and pid != os.getpid() and not _pid_alive(pid) for pid in pids)


def _lock_note_child(name, pid):
    try:
        with open(f"{STATE_DIR}/{name}.lock", "a") as f:
            f.write(f"\n{pid}")
    except OSError:
        pass


def _acquire_lock(name, _retried=False):
    """Atomic-create lock file, cross-platform (no fcntl/msvcrt — those differ
    by OS). A lock whose recorded holder pid is gone, or that is older than
    LOCK_STALE_SECONDS, is assumed abandoned by a crashed/killed process and
    is cleared once, then retried."""
    os.makedirs(STATE_DIR, exist_ok=True)
    lock_path = f"{STATE_DIR}/{name}.lock"
    try:
        fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
        return lock_path
    except FileExistsError:
        if _retried:
            return None
        try:
            age = time.time() - os.path.getmtime(lock_path)
        except OSError:
            age = 0
        if age > LOCK_STALE_SECONDS or _lock_holder_dead(lock_path):
            # Move, don't remove: two ticks judging the same lock dead would otherwise let the
            # slower one delete the lock the faster one just created. os.replace is atomic, so
            # exactly one mover succeeds; the other's O_EXCL retry then fails as it should.
            stale = lock_path + ".stale"
            try:
                os.replace(lock_path, stale)
                os.remove(stale)
            except OSError:
                pass
            return _acquire_lock(name, _retried=True)
        return None  # another run is genuinely still in flight — skip this tick


def _release_lock(lock_path):
    pids = _lock_pids(lock_path)
    if pids and pids[0] != os.getpid():
        return  # taken over while we were (wrongly) judged dead — the lock is theirs now
    try:
        os.remove(lock_path)
    except OSError:
        pass


def _naive_utc(ts):
    """Bar timestamp → naive UTC datetime (lib.freshness.naive_utc; kept here for the probe
    path's older callers and tests)."""
    import pandas as pd
    ts = pd.Timestamp(ts)
    if ts.tzinfo is not None:
        ts = ts.tz_convert("UTC").tz_localize(None)
    return ts.to_pydatetime()


class _FeedWait(str):
    """Straggler marker for "bars landed, an align_feed row has not been published".
    `due_at` is a naive UTC datetime (the probe file already carries it that way)."""
    def __new__(cls, source, due_at):
        obj = super().__new__(cls, str(source))
        obj.due_at = due_at
        return obj


def _is_feed_wait(exc):
    try:
        from lib.data import FeedNotPublished
    except ImportError:
        return False
    return isinstance(exc, FeedNotPublished)


def _judge_fallback(data, expected):
    """lib.freshness.judge, verbatim, for a workspace whose lib/ predates that module — such a
    lib has no gate either, so this is the only judgement the probe path can run there."""
    if isinstance(data, tuple):
        close_df = data[0]
        if close_df.empty:
            return None, False, None
        last_valid = close_df.apply(lambda col: col.last_valid_index())
        if last_valid.isna().any():
            # at least one symbol has literally never had a data point
            return None, False, last_valid[last_valid.isna()].index[0]
        straggler_symbol = last_valid.idxmin()
        straggler_ts = _naive_utc(last_valid[straggler_symbol])
        ready = all(_naive_utc(ts) >= expected for ts in last_valid)
        return straggler_ts, ready, straggler_symbol
    if data.empty:
        return None, False, None
    last_ts = _naive_utc(data.index[-1])
    return last_ts, last_ts >= expected, None


def _check_freshness(mod, expected):
    """Probe path: calls the strategy's own fetch_data() and returns (observed_ts, ready,
    straggler) — see lib/freshness.py for the three fields.

    Raises whatever fetch_data() raises (network errors, or a strategy's own
    deliberate fail-loud guard like txf_composite_60m's degraded-dividend
    check) — the caller is responsible for treating that as a failed attempt,
    not a "not ready yet".
    """
    from dotenv import dotenv_values
    env = dotenv_values()
    hdrs = {"api-key": env.get("blave_api_key", ""), "secret-key": env.get("blave_secret_key", "")}

    # Same closed-bars-only scope as the runner's tick: a forming crypto bar must not count
    # as the expected bar having landed.
    try:
        from lib.data import closed_bars_only
    except ImportError:
        from contextlib import nullcontext as closed_bars_only
    try:  # this probe IS a live tick's fetch: align_feed raises on an unpublished row
        from lib.data import live_feeds
    except ImportError:
        from contextlib import nullcontext as live_feeds
    with closed_bars_only(), live_feeds():
        data = mod.fetch_data(hdrs)
    try:
        from lib.freshness import judge
    except ImportError:
        judge = _judge_fallback
    return tuple(judge(data, expected))


def _run_strategy_protected(name):
    """Probe path's launcher — cross-platform equivalent of manager/run_strategy.sh's
    crash-safety contract: strategy.py with the SAME interpreter running this script
    (sys.executable, so it's whatever venv/python cron is already using, no hardcoded
    'python3'/'bash'), catches a hang with a timeout, logs + Telegram-alerts on failure,
    touches the heartbeat on success.

    Returns True on success, False otherwise.
    """
    strategy_dir = f"strategies/{name}"
    os.makedirs(strategy_dir, exist_ok=True)
    script_path = f"{strategy_dir}/strategy.py"

    # Popen rather than subprocess.run: the child pid goes into the lock (_lock_holder_dead)
    # before the run, and the except/kill mirrors run()'s own so a SIGTERM→SystemExit still
    # takes the child down with us.
    with subprocess.Popen([sys.executable, script_path], stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, text=True, **_child_kw()) as proc:
        _lock_note_child(name, proc.pid)
        try:
            out, err = proc.communicate(timeout=RUN_TIMEOUT_SECONDS)
            output, returncode = (out or "") + (err or ""), proc.returncode
        except subprocess.TimeoutExpired:
            proc.kill()
            out, _ = proc.communicate()
            output = (out or "") + \
                f"\n[wait_for_bar] killed after exceeding {RUN_TIMEOUT_SECONDS}s timeout"
            returncode = -1
        except BaseException:
            proc.kill()
            raise

    if returncode != 0:
        _record_crash(name, returncode, output)
        return False

    _touch_heartbeat(name)
    return True


def _child_kw():
    """stdin=DEVNULL (a child inheriting the desktop app's secret pipe hangs at interpreter
    start on Windows — runtime/command_listener._child_kw has the history) and no console
    window per tick on Windows."""
    kw = {"stdin": subprocess.DEVNULL}
    if os.name == "nt":
        kw["creationflags"] = subprocess.CREATE_NO_WINDOW
    return kw


def _record_crash(name, returncode, output):
    try:
        with open(f"strategies/{name}/strategy.log", "a", encoding="utf-8", errors="replace") as f:
            f.write(output)
    except OSError:
        pass
    _alert_failure().alert(name, returncode, output)


def _touch_heartbeat(name):
    os.makedirs("state/heartbeat", exist_ok=True)
    Path(f"state/heartbeat/{name}").touch()


# ── gate path ─────────────────────────────────────────────────────────────────

def _handshake_paths(name):
    return (f"{STATE_DIR}/{name}.started", f"{STATE_DIR}/{name}.probe.json", f"{STATE_DIR}/{name}.out")


def _clear_handshake(name):
    for p in _handshake_paths(name):
        try:
            os.remove(p)
        except OSError:
            pass


def _lib_has_gate():
    try:
        with open(os.path.join(ROOT, "lib", "runner.py"), "rb") as f:
            return bool(_GATE_FLAG_RE.search(f.read()))
    except OSError:
        return False


def _gate_key(name):
    """What the gate verdict (verified / unsupported) is pinned to: the strategy file and the
    runner it would run under. Either changing re-opens the question."""
    key = []
    for p in (f"strategies/{name}/strategy.py", os.path.join(ROOT, "lib", "runner.py")):
        try:
            st = os.stat(p)
            key += [st.st_mtime_ns, st.st_size]
        except OSError:
            key += [None, None]
    return key


def _choose_path(name, state):
    """'gate' (start the strategy at once), 'verify' (probe first; if ready, start it with the
    env and see whether it leaves .started) or 'probe' (the original two-interpreter flow)."""
    if not _lib_has_gate():
        return "probe"
    try:
        with open(f"strategies/{name}/strategy.py", encoding="utf-8", errors="replace") as f:
            text = f.read()
    except OSError:
        return "probe"
    if "lib.runner" not in text or "run(" not in text:
        return "probe"  # never calls run(): the gate would be invisible to it — do not even try
    key = _gate_key(name)
    if state.get("gate_unsupported_key") == key:
        return "probe"
    if state.get("gate_verified_key") == key:
        return "gate"
    return "verify"


def _spawn_gate_child(name, expected_iso):
    strategy_dir = f"strategies/{name}"
    os.makedirs(strategy_dir, exist_ok=True)
    out_path = _handshake_paths(name)[2]
    # a file, not a PIPE: this process polls handshake files instead of reading the pipe,
    # and a full pipe would stall the child
    with open(out_path, "w", encoding="utf-8", errors="replace") as out:
        proc = subprocess.Popen([sys.executable, f"{strategy_dir}/strategy.py"],
                                stdout=out, stderr=subprocess.STDOUT,
                                env={**os.environ, EXPECTED_BAR_ENV: expected_iso}, **_child_kw())
    _lock_note_child(name, proc.pid)
    return proc


def _wait_child(proc, name):
    """Returns (rc, started, probe, output). RUN_TIMEOUT_SECONDS counts from the moment
    .probe.json appears: a cold fetch of years of bars may take longer than that, exactly as
    the probe path's in-process fetch always could — only compute + state is bounded."""
    started_p, probe_p, out_p = _handshake_paths(name)
    probe_seen_at = None
    killed = False
    try:
        while True:
            try:
                rc = proc.wait(timeout=CHILD_POLL_SECONDS)
                break
            except subprocess.TimeoutExpired:
                pass
            if probe_seen_at is None and os.path.exists(probe_p):
                probe_seen_at = time.monotonic()
            if probe_seen_at is not None and time.monotonic() - probe_seen_at > RUN_TIMEOUT_SECONDS:
                proc.kill()
                proc.wait()
                rc, killed = -1, True
                break
    except BaseException:
        proc.kill()
        raise
    probe = None
    try:
        with open(probe_p, encoding="utf-8") as f:
            probe = json.load(f)
        if not isinstance(probe, dict):
            probe = None
    except (OSError, ValueError):
        pass
    try:
        with open(out_p, encoding="utf-8", errors="replace") as f:
            output = f.read()[-OUTPUT_TAIL_CHARS:]
    except OSError:
        output = ""
    if killed:
        output += f"\n[wait_for_bar] killed after exceeding {RUN_TIMEOUT_SECONDS}s timeout"
    # .started as the dict run() wrote (pid, at, expected) so _apply can match the probe's pid
    # against the strategy's own pid; an unreadable file still counts as "started"
    started = False
    try:
        with open(started_p, encoding="utf-8") as f:
            started = json.load(f)
        if not isinstance(started, dict):
            started = True
    except ValueError:
        started = True
    except OSError:
        pass
    return rc, started, probe, output


def _state_signal(name):
    """The signal surface of strategies/<name>/state.json for the ticks record."""
    try:
        with open(f"strategies/{name}/state.json", encoding="utf-8") as f:
            st = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(st, dict):
        return None
    return st.get("weights") if st.get("type") == "portfolio" else st.get("position")


def _record_tick(name, expected_iso, data_bar, secs):
    path = f"{STATE_DIR}/{name}.ticks.jsonl"
    line = json.dumps({"at": time.time(), "expected": expected_iso, "data_bar": data_bar,
                       "secs": round(secs, 2), "state": _state_signal(name)})
    tmp = f"{path}.{os.getpid()}.tmp"
    try:
        with open(path, "a", encoding="utf-8") as f:
            f.write(line + "\n")
        if os.path.getsize(path) > TICKS_MAX_BYTES:
            with open(path, "rb") as f:
                f.seek(-TICKS_KEEP_BYTES, os.SEEK_END)
                tail = f.read()
            tail = tail[tail.index(b"\n") + 1:] if b"\n" in tail else tail   # whole lines only
            with open(tmp, "wb") as f:
                f.write(tail)
            os.replace(tmp, path)
    except OSError as e:
        logging.warning(f"[wait_for_bar] ticks record dropped ({e})")
        try:
            os.remove(tmp)
        except OSError:
            pass


def _mark_processed(state, expected_iso, observed_iso, data_bar_iso=None):
    state["last_processed_bar"] = expected_iso
    state["last_processed_data_bar"] = data_bar_iso
    state["pending_since"] = None
    state["last_seen_bar"] = observed_iso
    state["stall_alert_at"] = None
    state["last_attempt_failed_at"] = None


def _is_processed(state, expected, expected_iso, now):
    if state.get("last_processed_bar") == expected_iso:
        return True
    # A slow tick computed on the next bar already (data_bar > expected) — that slot is done
    # too. Bounded by `now`: a frame whose last label sits in the future (a joined calendar)
    # must not switch the strategy off for good.
    data_bar = state.get("last_processed_data_bar")
    if not data_bar:
        return False
    try:
        data_bar = datetime.fromisoformat(data_bar)
    except (TypeError, ValueError):
        return False
    return expected <= data_bar < now


def _note_not_ready(name, state, now, expected, observed_iso, straggler_symbol, due=None):
    """The expected bar is not in (either path): stall bookkeeping + the one stale alert.
    `due`: the earliest the bar can exist (_tw_fut_slot) — lateness counts from there."""
    # Data moved forward (even if still not enough) since the last check → this is fresh
    # lag, not a stall; clear stall_alert_at so a NEW stall (if this stalls again at the new
    # position) alerts fresh. observed_iso is None whenever the strategy has NEVER returned
    # any data at all (empty fetch, or a Type C column with zero valid rows) — that must NOT
    # be read as "no progress, still None" and skipped here; it's handled correctly below
    # purely because stall_alert_at (not this block) is what decides "already alerted", so a
    # permanently-None observed_iso still gets exactly one alert then a 24h repeat, never zero.
    if observed_iso is not None and observed_iso != state.get("last_seen_bar"):
        state["last_seen_bar"] = observed_iso
        state["stall_alert_at"] = None

    if isinstance(straggler_symbol, _FeedWait):
        # count lateness from when the row was DUE, not from the first poll: a daily
        # feed due at 20:00 polled from 15:00 on must not alert at 15:15
        feed_due = straggler_symbol.due_at
        if state.get("pending_since") is None or datetime.fromisoformat(state["pending_since"]) < feed_due:
            state["pending_since"] = feed_due.isoformat()

    if state.get("pending_since") is None:
        # a bar that cannot exist before `due` (TAIFEX daily: 15:00 TWN) is not late before it;
        # once set, pending_since stays until data lands — a slot that advances with the wall
        # clock must not restart the count (that is the stall the alert exists for)
        state["pending_since"] = (due if due and due > now else now).isoformat()
        return

    pending_since = datetime.fromisoformat(state["pending_since"])
    waited = now - pending_since
    if waited >= timedelta(minutes=STALE_TIMEOUT_MINUTES):
        stall_alert_at = state.get("stall_alert_at")
        # stall_alert_at is None ⇒ never alerted for this episode yet (covers
        # both a brand-new stall AND a strategy that has NEVER had a single
        # data point — see comment above, that must not silently never-alert).
        due = stall_alert_at is None or (time.time() - stall_alert_at >= STALL_REALERT_SECONDS)
        if due:
            _alert_stale(name, expected, int(waited.total_seconds() // 60), straggler_symbol)
            state["stall_alert_at"] = time.time()


def _probe_straggler(probe):
    fw = probe.get("feed_wait")
    if isinstance(fw, dict) and fw.get("due_at"):
        try:
            return _FeedWait(fw.get("source", "feed"), datetime.fromisoformat(fw["due_at"]))
        except ValueError:
            pass
    return probe.get("straggler")


def _apply(name, state, rc, started, probe, output, secs, now, expected, expected_iso,
           probed_observed_iso=None, probed=False, due=None, child_pid=None):
    """What the gate child left behind → bar_wait state. `probed`: the verify path ran the
    in-process probe first (and it said ready) — a strategy that then exits 0 without
    .started did exactly what the probe path would have run, so that bar counts as done."""
    # Which pid the strategy sees as its own: the one it wrote into .started. On Windows a
    # venv's python.exe is a launcher that runs the real interpreter as a child, so proc.pid
    # (the launcher) is never the pid run() writes — comparing against it failed every gate
    # tick on the 10-13 test box. Fall back to proc.pid only when .started carries no pid.
    own_pid = started.get("pid") if isinstance(started, dict) else None
    this_pid = own_pid if own_pid is not None else child_pid
    if probe is not None and (probe.get("expected") != expected_iso
                              or (this_pid is not None and probe.get("pid") != this_pid)):
        # a leftover _clear_handshake could not remove (Windows sharing violation) is not
        # this tick's verdict
        raise RuntimeError(f"{name}: .probe.json is not this tick's (expected {probe.get('expected')!r} "
                           f"pid {probe.get('pid')!r} vs {expected_iso} {this_pid})")
    if started:
        state["gate_verified_key"] = _gate_key(name)
    elif probe is not None:
        raise RuntimeError(f"{name}: .probe.json without .started — handshake out of order")
    elif rc == 0:
        state["gate_unsupported_key"] = _gate_key(name)
        state["gate_unsupported_at"] = time.time()
        # P3: the state file + this line are the record; no event type is registered for it
        # on the platform (tests/check_events_dualwrite pins the registry) and no TG
        print(f"[wait_for_bar] {name}: exited 0 without walking lib.runner.run() under "
              f"{EXPECTED_BAR_ENV} — back on the probe path until strategy.py or lib/runner.py changes")
        if probed:  # data_bar unknown: whatever it computed on, the probe did not see it
            _mark_processed(state, expected_iso, probed_observed_iso)
            _touch_heartbeat(name)
        return
    else:  # crashed before run() — a strategy failure, same as a crash after it
        _record_crash(name, rc, output)
        state["last_attempt_failed_at"] = time.time()
        return

    if rc == 0 and probe is not None and not probe.get("ready"):
        # a __main__ that swallows SystemExit (bare except) turned the 75 into a 0; the data
        # still was not in — bookkeeping only, the probe is the verdict
        print(f"[wait_for_bar] {name}: exited 0 although .probe.json says the bar is not in — "
              f"strategy.py swallows SystemExit; treated as not ready")
        _note_not_ready(name, state, now, expected, probe.get("observed_ts"), _probe_straggler(probe), due)
        return
    if rc == 0:
        if not probe:
            raise RuntimeError(f"{name}: exited 0 with .started but no .probe.json")
        observed_iso = probe.get("observed_ts")
        _mark_processed(state, expected_iso, observed_iso, observed_iso)
        _touch_heartbeat(name)
        _record_tick(name, expected_iso, observed_iso, secs)
    elif rc == NOT_READY_EXIT and probe is not None and not probe.get("ready"):
        _note_not_ready(name, state, now, expected, probe.get("observed_ts"), _probe_straggler(probe), due)
    elif probe is None:
        # fetch_data() itself raised — network error, or a strategy's own deliberate fail-loud
        # guard. Not a wait_for_bar bug: the normal failed-run alert (its own 24h cooldown),
        # and back off like any other failed attempt instead of retrying every minute.
        _alert_failure().alert(name, "fetch_error", output)
        state["last_attempt_failed_at"] = time.time()
    else:
        _record_crash(name, rc, output)
        state["last_attempt_failed_at"] = time.time()


def _run_gate(name, state, now, expected, expected_iso, probed_observed_iso=None, probed=False, due=None):
    state["last_path"] = "gate"
    _clear_handshake(name)
    t0 = time.monotonic()
    proc = _spawn_gate_child(name, expected_iso)
    rc, started, probe, output = _wait_child(proc, name)
    _apply(name, state, rc, started, probe, output, time.monotonic() - t0, now, expected,
           expected_iso, probed_observed_iso, probed, due, proc.pid)


def _run_probe(name, mod, state, now, expected, expected_iso, then_gate, due=None):
    """The original flow: fetch_data() here, then the strategy as a second interpreter — or,
    on the verify tick, as the gate child once the probe says ready."""
    state["last_path"] = "probe"
    try:
        observed_ts, ready, straggler_symbol = _check_freshness(mod, expected)
    except Exception as e:
        if not _is_feed_wait(e):
            output = f"fetch_data() raised while checking freshness: {e}\n" + traceback.format_exc()
            _alert_failure().alert(name, "fetch_error", output)
            state["last_attempt_failed_at"] = time.time()
            return
        # Bars are in, an align_feed row they need is not published yet: "not ready",
        # not a failed run — no fetch_error alert, no backoff.
        observed_ts, ready = _naive_utc(e.last_bar), False
        straggler_symbol = _FeedWait(getattr(e, "source", "feed"), _naive_utc(e.due_at))

    observed_iso = observed_ts.isoformat() if observed_ts is not None else None
    if not ready:
        _note_not_ready(name, state, now, expected, observed_iso, straggler_symbol, due)
        return
    if then_gate:
        _run_gate(name, state, now, expected, expected_iso, observed_iso, probed=True, due=due)
        return
    if _run_strategy_protected(name):
        _mark_processed(state, expected_iso, observed_iso)
    else:
        state["last_attempt_failed_at"] = time.time()


def _tw_index_futures_strategy(name):
    try:
        with open(f"strategies/{name}/strategy.py", encoding="utf-8", errors="replace") as f:
            text = f.read()
    except OSError:
        return False
    return _TW_FUT_FETCH in text and _TW_FUT_SYMBOL_RE.search(text) is not None


def _tw_fut_last_day_open(t):
    """Latest minute a day-session bar may OPEN on the Taipei day of `t`: 13:45 (the closing
    auction bin opens at the close), or 13:29 on the monthly settlement day (third Wednesday —
    the expiring month stops at 13:30, no bin opens at 13:30, and the continuous series has no
    bars until the 15:00 night open). Postponed settlements are not known here."""
    if t.weekday() == 2 and 15 <= t.day <= 21:
        return 13 * 60 + 29
    return 13 * 60 + 45


def _tw_fut_session_open(label_utc, td):
    """Does the TAIFEX index-futures bar [label, label + td) (naive UTC) lie in a session?
    Judged on the bar's interval, not its label: TXF 60m / 30m labels are whole hours /
    half hours (the 08:45–09:00 bar is labelled 08:00), 1m / 5m / 15m labels start at 08:45.
    Day: the bar opens no later than the close and ends after 08:45 — the closing bin that
    opens AT 13:45 (the auction) counts. Night: ends after 15:00, or opens before 05:00 (no
    bin opens at the night close). 1m gets one extra minute at each close for the days the
    store labels bars by their END (13:46 / 05:00)."""
    o = label_utc + _TPE
    c = o + td
    tol = 1 if td == timedelta(minutes=1) else 0
    hm_o, hm_c, wd = o.hour * 60 + o.minute, c.hour * 60 + c.minute, o.weekday()
    same_day = c.date() == o.date()
    if wd <= 4 and same_day and 8 * 60 + 45 < hm_c and hm_o <= _tw_fut_last_day_open(o) + tol:
        return True
    if wd <= 4 and hm_o >= 15 * 60:
        return True   # night, evening part (a bar closing at midnight included)
    if 1 <= wd <= 5 and hm_o < 5 * 60 + tol:
        return True   # night, after midnight (Saturday morning = Friday's session)
    return False


def _tw_fut_slot(expected, td):
    """(poll_from, due) in naive UTC for the slot `expected` of a TAIFEX index-futures
    strategy, or None when that slot has no bar at all (market closed): intraday — the bar
    exists once it closes; daily — the trading day is the Taipei date the slot ends on, its
    bar is complete at 13:45 and published ~15:00."""
    if td >= timedelta(days=1):
        day = (expected + td + _TPE).replace(hour=0, minute=0, second=0, microsecond=0)
        if day.weekday() > 4:
            return None
        day -= _TPE   # Taipei midnight as naive UTC
        return day + _TW_FUT_DAILY_POLL_FROM, day + _TW_FUT_DAILY_DUE
    if not _tw_fut_session_open(expected, td):
        return None
    return expected + td, expected + td


def _load_interval(name):
    """(INTERVAL, module-or-None). Read as text first so the fast path and the gate path load
    nothing of the strategy's (no pandas); a strategy that spells INTERVAL any other way is
    imported, as before."""
    path = f"strategies/{name}/strategy.py"
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            m = _INTERVAL_SRC_RE.search(f.read())
    except OSError:
        m = None
    if m:
        return m.group(1), None
    mod = _load_strategy_module(name)
    return getattr(mod, "INTERVAL", None), mod


def _tick(name):
    interval, mod = _load_interval(name)
    if not interval:
        print(f"[wait_for_bar] {name}: no INTERVAL in strategy.py — Type B strategies "
              f"don't use wait_for_bar.py, check references/deployment.md")
        return

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    expected = _expected_closed_bar_open(interval, now)
    expected_iso = expected.isoformat()

    state = _load_state(name)

    # Fast path: this bar's already been run — stay quiet, no fetch, no log, no lock.
    if _is_processed(state, expected, expected_iso, now):
        return

    # Session table (TAIFEX index futures only): a slot the market is closed for, or whose
    # bar cannot exist yet, is not polled and not waited on — the 13:45→15:00 and 05:00→08:45
    # gaps used to read as a stall (one bar_stale a day, then the 15-minute throttle swallowing
    # the first two bars of the next session). The file is still touched now and then so a
    # post-boot report sees a recent check (portfolio_reporter._recomputed_since).
    due = None
    if _tw_index_futures_strategy(name):
        slot = _tw_fut_slot(expected, _interval_to_timedelta(interval))
        if slot is None or now < slot[0]:
            # a closed slot ends the episode: whatever stalled before (a holiday, a late last
            # bar) must not throttle the first bars of the next session
            if state.get("pending_since") is not None or state.get("stall_alert_at") is not None \
                    or now.minute % STALL_POLL_MINUTES == 0:
                state["pending_since"] = None
                state["stall_alert_at"] = None
                _save_state(name, state)
            return
        due = slot[1]

    # Backoff: don't hammer a run (or a fetch_data() that itself keeps raising)
    # every single minute right after it just failed.
    last_failed = state.get("last_attempt_failed_at")
    if last_failed and time.time() - last_failed < RETRY_BACKOFF_SECONDS:
        return

    # Stall throttle: once we've confirmed a stall (alerted at least once this
    # episode — see stall_alert_at), stop polling every minute — this is what a
    # TXF weekend close looks like. Resumes full speed the moment data moves.
    if state.get("stall_alert_at") is not None:
        if now.minute % STALL_POLL_MINUTES != 0:
            return

    lock_path = _acquire_lock(name)
    if lock_path is None:
        return  # a previous tick's run is still in flight — skip, don't overlap
    try:
        path = _choose_path(name, state)
        if path == "gate":
            _run_gate(name, state, now, expected, expected_iso, due=due)
        else:
            # an import error here is this script's own failure (main → _alert_wrapper_error),
            # as it always was
            _run_probe(name, mod or _load_strategy_module(name), state, now, expected,
                       expected_iso, then_gate=(path == "verify"), due=due)
        _save_state(name, state)
    finally:
        _release_lock(lock_path)


def _alert_stale(name, expected, minutes_waited, straggler_symbol):
    # 事件落檔與 Telegram 並行(dual-write)——見 lib/events。冷卻交給平台。
    try:
        from lib.events import emit
        emit("bar_stale", strategy=name, symbol=straggler_symbol,
             minutes=minutes_waited)
    except Exception:
        pass
    who = f"（卡住的是 {straggler_symbol}，若已下市/長期停牌請從 UNIVERSE 移除）" if straggler_symbol is not None else ""
    if isinstance(straggler_symbol, _FeedWait):
        who = (f"（K 棒已到，等的是外部資料 {straggler_symbol}：應在 "
               f"{straggler_symbol.due_at.strftime('%m-%d %H:%M')} 前發布，還沒進來）")
    try:
        from lib.notify import send_text
        send_text(
            f"⚠️ {name}：{expected.strftime('%Y-%m-%d %H:%M')} 那根 K 棒等了 "
            f"{minutes_waited} 分鐘還沒到位{who}，仍在重試，訊號會晚發。"
        )
    except Exception as e:  # best-effort — the alerter itself must never crash the cron job
        logging.warning(f"[wait_for_bar] stale-bar notification dropped ({e})")


def _alert_wrapper_error(name, exc):
    """wait_for_bar.py's OWN failure (bad INTERVAL, fetch_data raising, import
    error, etc.) — this happens BEFORE run_strategy's protection ever
    engages, so without this the failure would be entirely silent (cron
    swallows the traceback, no Telegram, nothing)."""
    state_path = f"{STATE_DIR}/{name}.json"
    now = time.time()
    try:
        state = json.load(open(state_path)) if os.path.exists(state_path) else {}
    except Exception:
        state = {}
    # 事件在冷卻檢查之前落檔:冷卻(6h)是給 Telegram 那一半的,平台自己會去重。
    try:
        from lib.events import emit
        emit("scheduler_error", strategy=name,
             error="".join(traceback.format_exception(
                 type(exc), exc, exc.__traceback__))[-500:])
    except Exception:
        pass

    last = state.get("wrapper_error_alerted_at") or 0
    if now - last < WRAPPER_ERROR_COOLDOWN_SECONDS:
        return
    try:
        from lib.notify import send_text
        tb = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))[-1500:]
        send_text(f"⚠️ wait_for_bar.py 本身出錯（{name}），排程可能完全停擺：\n\n{tb}")
    except Exception as e:
        logging.warning(f"[wait_for_bar] wrapper-error notification dropped ({e})")
    state["wrapper_error_alerted_at"] = now
    try:
        _save_state(name, {**_default_state(), **state})
    except Exception:
        pass


def main():
    if len(sys.argv) < 2:
        print("usage: wait_for_bar.py <strategy_name>")
        return
    name = sys.argv[1]
    # systemctl stop / a listener restart SIGTERMs the whole cgroup: turn it into SystemExit
    # so _tick's finally releases the lock and subprocess.run() kills the strategy child with
    # us. Never delivered on Windows (TerminateProcess) — there the pid probe is the cleanup.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    try:
        _tick(name)
    except Exception as e:
        print(f"[wait_for_bar] {name}: uncaught error: {e}")
        traceback.print_exc()
        _alert_wrapper_error(name, e)


if __name__ == "__main__":
    main()
