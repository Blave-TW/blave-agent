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
  computed_fp / computed_bar : fingerprint of the data a run last computed on (every
                         member's own newest bar) and the newest of those bars
  prime_tried_fp      : fingerprint of the last prime attempt, success or failure — the
                         same data is primed at most once
  tw_bar_map          : TWSE stock daily strategies only: [calendar bar, trading day it maps to]
                         for the last closed day found on the holiday table (_tw_skip_holidays)

Priming (Wei: a signal is always computed on the newest data there is): while the expected bar
is not in, a strategy whose data moved since it last computed — any member's newest closed bar
(Type A: the series'; Type C: each column's own) differs from the last run's — runs at once on
that data: new pick or long-running, state.json or not, stalled or not. Lagging Type C columns
go in with their own last bar. Same lock and launcher as a normal run (strategy.py, no
expected-bar gate). last_processed_bar is not touched and the expected bar always runs when it
lands, so a member that was primed around is computed again with its own new bar. Grace: no
prime until the furthest-behind member's next bar is PRIME_GRACE_SECONDS overdue (one bar
behind: the expected bar's close + grace) and no member is still inside its own grace — a
member a minute late is waited for and the bar is computed once, on complete data; a member
stuck for days does not let the others in batch by batch. A column that never had any data blocks priming. Not primed: no data, an unpublished
align_feed row (the live run would refuse it), a TAIFEX contract strategy outside its session
(_tw_futures_closed — weekends, the gap between sessions and TWSE holidays; typhoon closures
and a night session before a holiday are not known, and a prime there is computed once, its
orders then refused every reconcile round until the open). A failed prime backs off like any
failed run and is not retried on the same data.

Market-closed handling: a fixed-interval instrument like TXF doesn't trade
nights/weekends, but `_expected_closed_bar_open` doesn't know a trading
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

TWSE/TPEx stock daily strategies (only fetch_twstock_price* prices, _tw_stock_daily) do use the calendar:
their bars exist on trading days only, so the expected bar is the latest weekday not on the
TWSE holiday table. Otherwise every Sunday, Monday morning and day after a holiday waited on a
bar that never comes, alerted, and ran Monday's bar twice (once for "Sunday", once for itself).

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
import ast
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


# ── Fallback copy of lib/bar_ready ───────────────────────────────────────────
# The readiness and priming rule lives in lib/bar_ready (lib/runner's Type C preview asks it too).
# update_workspace writes file by file, so a workspace can hold this manager beside a lib that
# has no bar_ready yet; without a copy here every Type A/C tick would die at import, before
# main() could alert. Used only then. tests/check_bar_ready_fallback.py keeps both copies giving
# the same answers — change them together.
_FB_PRIME_GRACE_SECONDS = 300
_FB_INTERVAL_RE = re.compile(r"^(\d+)(min|m|h|d|w)$")
_FB_UNIT_TO_KW = {"min": "minutes", "m": "minutes", "h": "hours", "d": "days", "w": "weeks"}


def _fb_interval_to_timedelta(interval):
    m = _FB_INTERVAL_RE.match(interval)
    if not m:
        raise ValueError(f"unrecognized INTERVAL format: {interval!r}")
    n, unit = int(m.group(1)), m.group(2)
    return timedelta(**{_FB_UNIT_TO_KW[unit]: n})


def _fb_expected_closed_bar_open(interval, now):
    td = _fb_interval_to_timedelta(interval)
    epoch = datetime(1970, 1, 1)
    floored = epoch + ((now - epoch) // td) * td
    return floored - td


def _fb_naive_utc(ts):
    import pandas as pd
    ts = pd.Timestamp(ts)
    if ts.tzinfo is not None:
        ts = ts.tz_convert("UTC").tz_localize(None)
    return ts.to_pydatetime()


def _fb_judge(data, expected):
    if isinstance(data, tuple):
        close_df = data[0]
        if close_df.empty:
            return None, False, None, None
        last_valid = close_df.apply(lambda col: col.last_valid_index())
        if last_valid.isna().any():
            return None, False, last_valid[last_valid.isna()].index[0], None
        straggler_symbol = last_valid.idxmin()
        straggler_ts = _fb_naive_utc(last_valid[straggler_symbol])
        ready = all(_fb_naive_utc(ts) >= expected for ts in last_valid)
        return straggler_ts, ready, straggler_symbol, {str(k): _fb_naive_utc(v) for k, v in last_valid.items()}
    if data.empty:
        return None, False, None, None
    last_ts = _fb_naive_utc(data.index[-1])
    return last_ts, last_ts >= expected, None, {"": last_ts}


def _fb_member_in_grace(latest, expected, now, td):
    grace = timedelta(seconds=_FB_PRIME_GRACE_SECONDS)
    return any(m < expected and now < m + 2 * td + grace for m in latest.values())


try:
    from lib.bar_ready import (PRIME_GRACE_SECONDS, expected_closed_bar_open as _expected_closed_bar_open,  # noqa: E402
                               interval_to_timedelta as _interval_to_timedelta, judge as _judge,
                               member_in_grace, naive_utc as _naive_utc)
except ImportError:   # half-updated workspace: lib without bar_ready
    PRIME_GRACE_SECONDS = _FB_PRIME_GRACE_SECONDS
    _expected_closed_bar_open, _interval_to_timedelta = _fb_expected_closed_bar_open, _fb_interval_to_timedelta
    _judge, member_in_grace, _naive_utc = _fb_judge, _fb_member_in_grace, _fb_naive_utc

STALE_TIMEOUT_MINUTES = 15
STALL_POLL_MINUTES = 15            # once a stall is confirmed (alerted, data still hasn't moved),
                                    # only re-check this often instead of every minute
STALL_REALERT_SECONDS = 24 * 3600  # repeat the stale-data alert at most this often while the
                                    # SAME last_seen_bar persists — without this, a permanently
                                    # stuck symbol (delisted) gets exactly one alert ever, then
                                    # silence, even though the strategy never runs again
STATE_DIR = "state/bar_wait"
RUN_TIMEOUT_SECONDS = 1200         # kill a strategy subprocess that hangs (e.g. a stuck order API call).
                                    # A whole-market Type C run (~1,700 TW stocks) took 6 min on an M-series
                                    # Mac; at 600 a slower box was killed every attempt and never computed.
TICK_BUDGET_SECONDS = 1800         # = runtime command_listener.SCHEDULER_TICK_TIMEOUT_SECONDS: the scheduler
                                    # SIGKILLs this whole process past it (no finally, no state write, the
                                    # strategy child orphaned), so the run gets what the probe left of it
TICK_MARGIN_SECONDS = 60           # time kept back for this process to record the run and exit
_STARTED = time.monotonic()
# The lock also has to outlive _check_freshness, which is NOT subprocess-timeout-bounded —
# it runs fetch_data() in-process and can legitimately take several minutes across multiple
# retried HTTP sources (e.g. txf_composite_60m pulls 60m/1d/TAIEX/dividend series). Generous
# on purpose: the lock's job is cleaning up a genuinely-dead process, not a tight SLA — being
# too short risks two ticks racing on the same bucket, which too-long doesn't. This age is
# only the fallback: a lock whose recorded pid is gone is taken over at once (_acquire_lock),
# so a listener restart that kills a mid-flight tick doesn't silence the next 30 ticks.
LOCK_STALE_SECONDS = 1800
TAKEOVER_STALE_SECONDS = 60     # a takeover holds its marker for milliseconds
RETRY_BACKOFF_SECONDS = 300        # after a failed run OR a fetch_data() error, don't re-attempt every single minute
WRAPPER_ERROR_COOLDOWN_SECONDS = 6 * 3600         # this script's own crashes, not the strategy's


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


def _default_state():
    return {
        "last_processed_bar": None,
        "pending_since": None,
        "last_seen_bar": None,
        "stall_alert_at": None,
        "last_attempt_failed_at": None,
        "wrapper_error_alerted_at": None,
        "computed_fp": None,
        "computed_bar": None,
        "prime_tried_fp": None,
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
    try:
        from lib.winreplace import atomic_replace
    except ImportError:  # half-updated workspace: plain replace
        atomic_replace = os.replace
    os.makedirs(STATE_DIR, exist_ok=True)
    path = f"{STATE_DIR}/{name}.json"
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    atomic_replace(tmp, path)


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


def _lock_stale(path, max_age):
    try:
        age = time.time() - os.path.getmtime(path)
    except OSError:
        age = 0
    return age > max_age or _lock_holder_dead(path)


def _acquire_lock(name, _retried=False):
    """Atomic-create lock file, cross-platform (no fcntl/msvcrt — those differ
    by OS). A lock whose recorded holder pid is gone, or that is older than
    LOCK_STALE_SECONDS, is assumed abandoned by a crashed/killed process and
    is taken over once (_take_over), then retried."""
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
        judged = _lock_pids(lock_path)  # before the verdict: what _take_over re-checks against
        if _lock_stale(lock_path, LOCK_STALE_SECONDS):
            return _take_over(name, lock_path, judged)
        return None  # another run is genuinely still in flight — skip this tick


def _take_over(name, lock_path, judged):
    """Several ticks can judge the same lock dead at once. Moving or deleting it unguarded lets a
    slower one remove the lock a faster one has just re-created (both then run strategy.py for the
    same bar). So takeovers are serialized by an O_EXCL marker, and under it the lock is removed
    only if it still holds the pids that were judged dead and is still stale; the live holder's
    lock is never touched, so lock_path is never missing while someone holds it."""
    marker = lock_path + ".takeover"
    try:
        fd = os.open(marker, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        # a taker killed between create and remove would block every later takeover
        if _lock_stale(marker, TAKEOVER_STALE_SECONDS):
            try:
                os.remove(marker)
            except OSError:
                pass
        return None
    try:
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
        if _lock_pids(lock_path) != judged or not _lock_stale(lock_path, LOCK_STALE_SECONDS):
            return None
        try:
            os.remove(lock_path)
        except OSError:
            return None
        return _acquire_lock(name, _retried=True)
    finally:
        try:
            os.remove(marker)
        except OSError:
            pass


def _release_lock(lock_path):
    pids = _lock_pids(lock_path)
    if pids and pids[0] != os.getpid():
        return  # taken over while we were (wrongly) judged dead — the lock is theirs now
    try:
        os.remove(lock_path)
    except OSError:
        pass


class _FeedWait(str):
    """Straggler marker for "bars landed, an align_feed row has not been published"."""
    def __new__(cls, exc):
        obj = super().__new__(cls, str(getattr(exc, "source", "feed")))
        obj.due_at = exc.due_at
        return obj


def _is_feed_wait(exc):
    try:
        from lib.data import FeedNotPublished
    except ImportError:
        return False
    return isinstance(exc, FeedNotPublished)


def _check_freshness(mod, expected):
    """Calls the strategy's own fetch_data() and returns (observed_ts, ready, straggler, latest):
      observed_ts : the latest bar timestamp actually seen (None if there's
                    no data at all yet) — Type C uses the STRAGGLER symbol's
                    last_valid_index, i.e. whichever symbol is furthest
                    behind, since that's what determines whether the universe
                    made any forward progress at all.
      ready       : True if that's enough to run — Type A: observed_ts is
                    at/after `expected`. Type C: EVERY universe column has a
                    valid observation at/after `expected` (wait for ALL
                    symbols — see module docstring caveat about symbols with
                    no data going forward at all).
      straggler   : Type A: always None (no per-symbol concept). Type C: the
                    column name furthest behind — named explicitly so an alert
                    can point at the actual symbol to investigate, not just a
                    bucket timestamp.

      latest      : {member: its newest bar} — Type C every column, Type A {"": observed_ts};
                    None without data. Priming's fingerprint (_fingerprint).

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
    return _judge(data, expected)


def _fingerprint(latest):
    """(fingerprint, newest ISO) of _check_freshness's `latest`, or (None, None)."""
    if not latest:
        return None, None
    import hashlib
    body = json.dumps(sorted((k, v.isoformat()) for k, v in latest.items()))
    return hashlib.sha1(body.encode()).hexdigest(), max(latest.values()).isoformat()


_fetched_since = None   # naive UTC: when this tick's _check_freshness began fetching


def _run_strategy_protected(name):
    """Cross-platform equivalent of manager/run_strategy.sh's crash-safety
    contract — launches strategy.py with the SAME interpreter running this
    script (sys.executable, so it's whatever venv/python cron is already
    using, no hardcoded 'python3'/'bash'), catches a hang with a timeout,
    logs + Telegram-alerts on failure, touches the heartbeat on success.

    Returns True on success, False otherwise.
    """
    strategy_dir = f"strategies/{name}"
    os.makedirs(strategy_dir, exist_ok=True)
    script_path = f"{strategy_dir}/strategy.py"

    timeout = int(min(RUN_TIMEOUT_SECONDS, TICK_BUDGET_SECONDS - TICK_MARGIN_SECONDS
                      - (time.monotonic() - _STARTED)))
    if timeout < TICK_MARGIN_SECONDS:
        output = (f"[wait_for_bar] not started: the freshness check took "
                  f"{int(time.monotonic() - _STARTED)}s of the {TICK_BUDGET_SECONDS}s tick budget")
        _alert_failure().alert(name, "timeout", output)
        return False

    # Popen rather than subprocess.run: the child pid goes into the lock (_lock_holder_dead)
    # before the run, and the except/kill mirrors run()'s own so a SIGTERM→SystemExit still
    # takes the child down with us.
    env = None
    if _fetched_since is not None:
        # this tick's freshness check just fetched the same data: the run reads it from the
        # cache instead of asking the api again (lib/data.py › _fresh_since)
        env = {**os.environ, "BLAVE_FETCH_FRESH_SINCE": _fetched_since.strftime("%Y-%m-%dT%H:%M:%S")}
    with subprocess.Popen([sys.executable, script_path], stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, text=True, env=env) as proc:
        _lock_note_child(name, proc.pid)
        try:
            out, err = proc.communicate(timeout=timeout)
            output, returncode = (out or "") + (err or ""), proc.returncode
        except subprocess.TimeoutExpired:
            proc.kill()
            out, _ = proc.communicate()
            output = (out or "") + \
                f"\n[wait_for_bar] killed after exceeding {timeout}s timeout"
            returncode = -1
        except BaseException:
            proc.kill()
            raise

    if returncode != 0:
        try:
            with open(f"{strategy_dir}/strategy.log", "a") as f:
                f.write(output)
        except OSError:
            pass
        _alert_failure().alert(name, returncode, output)
        return False

    os.makedirs("state/heartbeat", exist_ok=True)
    Path(f"state/heartbeat/{name}").touch()
    return True


def _alert_stale(name, expected, minutes_waited, straggler_symbol, computed=False):
    # 事件落檔與 Telegram 並行(dual-write)——見 lib/events。冷卻交給平台。
    try:
        from lib.events import emit
        emit("bar_stale", strategy=name, symbol=straggler_symbol,
             minutes=minutes_waited)
    except Exception:
        pass
    who = f"（卡住的是 {straggler_symbol}，若已下市/長期停牌請從 UNIVERSE 移除）" if straggler_symbol is not None else ""
    if isinstance(straggler_symbol, _FeedWait):
        due = straggler_symbol.due_at.strftime('%m-%d %H:%M')
        if straggler_symbol == "twstock_price":   # the bars themselves are late (Blave CDN behind)
            who = f"（等的是台股日 K 本身：應在 {due} 前發布，還沒進來）"
        else:
            who = f"（K 棒已到，等的是外部資料 {straggler_symbol}：應在 {due} 前發布，還沒進來）"
    try:
        from lib.notify import send_text
        send_text(
            f"⚠️ {name}：{expected.strftime('%Y-%m-%d %H:%M')} 那根 K 棒等了 "
            f"{minutes_waited} 分鐘還沒到位{who}，仍在重試，"
            + ("訊號已先用現有最新資料算出，那檔沿用最後一筆。" if computed else "訊號會晚發。")
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


def _tick(name):
    global _fetched_since
    mod = _load_strategy_module(name)
    interval = getattr(mod, "INTERVAL", None)
    if not interval:
        print(f"[wait_for_bar] {name}: no INTERVAL in strategy.py — Type B strategies "
              f"don't use wait_for_bar.py, check references/deployment.md")
        return

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    expected = _expected_closed_bar_open(interval, now)
    tw_stock = interval == "1d" and _tw_stock_daily(name)
    if tw_stock:
        expected = _tw_skip_weekend(expected)
    expected_iso = expected.isoformat()

    state = _load_state(name)

    # Fast path: this bar's already been run — stay quiet, no fetch, no log, no lock.
    if state.get("last_processed_bar") == expected_iso:
        if tw_stock and (state.get("pending_since") or state.get("stall_alert_at")):
            _clear_wait(name, state)   # a wait left by an older wait_for_bar on a closed day
        return

    # Backoff: don't hammer a run (or a fetch_data() that itself keeps raising)
    # every single minute right after it just failed.
    last_failed = state.get("last_attempt_failed_at")
    if last_failed and time.time() - last_failed < RETRY_BACKOFF_SECONDS:
        return

    # Stall throttle: once we've confirmed a stall (alerted at least once this
    # episode — see stall_alert_at), stop polling every minute — this is what a
    # TXF weekend close looks like. Resumes full speed the moment data moves.
    # Also polled right after the priming grace (:05 of each quarter): with a member stuck the
    # bar is primed then, on everything that landed by the grace, not 15 minutes later.
    if state.get("stall_alert_at") is not None:
        if now.minute % STALL_POLL_MINUTES not in (0, PRIME_GRACE_SECONDS // 60):
            return

    # After the fast path and the throttle: the holiday table is a request, and this runs every minute.
    if tw_stock:
        mapped = _tw_skip_holidays(expected, state)
        if mapped != expected:
            expected, expected_iso = mapped, mapped.isoformat()
            if state.get("last_processed_bar") == expected_iso:
                _clear_wait(name, state)
                return

    lock_path = _acquire_lock(name)
    if lock_path is None:
        return  # a previous tick's run is still in flight — skip, don't overlap
    try:
        try:
            _fetched_since = datetime.now(timezone.utc).replace(tzinfo=None)
            observed_ts, ready, straggler_symbol, latest = _check_freshness(mod, expected)
        except Exception as e:
            if not _is_feed_wait(e):
                # fetch_data() itself raised — network error, or a strategy's own
                # deliberate fail-loud guard (e.g. txf_composite_60m's degraded-
                # dividend check). This is NOT a wait_for_bar.py bug, so route it
                # through the normal failed-run alert (its own 24h cooldown) —
                # not main()'s "wrapper itself is broken" alert — and back off
                # like any other failed attempt instead of retrying every minute.
                output = f"fetch_data() raised while checking freshness: {e}\n" + traceback.format_exc()
                _alert_failure().alert(name, "fetch_error", output)
                state["last_attempt_failed_at"] = time.time()
                _save_state(name, state)
                return
            # Bars are in, an align_feed row they need is not published yet: "not ready",
            # not a failed run — no fetch_error alert, no backoff.
            observed_ts, ready, straggler_symbol, latest = _naive_utc(e.last_bar), False, _FeedWait(e), None

        observed_iso = observed_ts.isoformat() if observed_ts is not None else None
        fp, newest_iso = _fingerprint(latest)

        if ready:
            if _run_strategy_protected(name):
                state["last_processed_bar"] = expected_iso
                state["pending_since"] = None
                state["last_seen_bar"] = observed_iso
                state["stall_alert_at"] = None
                state["last_attempt_failed_at"] = None
                state["computed_fp"], state["computed_bar"] = fp, newest_iso
            else:
                state["last_attempt_failed_at"] = time.time()
            _save_state(name, state)
            return

        _maybe_prime(name, state, now, expected, _interval_to_timedelta(interval), latest,
                     straggler_symbol)

        # Not ready yet. Data moved forward (even if still not enough) since the
        # last check → this is fresh lag, not a stall; clear stall_alert_at so a
        # NEW stall (if this stalls again at the new position) alerts fresh.
        # observed_iso is None whenever the strategy has NEVER returned any data
        # at all (empty fetch, or a Type C column with zero valid rows) — that
        # must NOT be read as "no progress, still None" and skipped here; it's
        # handled correctly below purely because stall_alert_at (not this block)
        # is what decides "already alerted", so a permanently-None observed_iso
        # still gets exactly one alert then a 24h repeat, never zero.
        if observed_iso is not None and observed_iso != state.get("last_seen_bar"):
            state["last_seen_bar"] = observed_iso
            state["stall_alert_at"] = None

        if isinstance(straggler_symbol, _FeedWait):
            # count lateness from when the row was DUE, not from the first poll: a daily
            # feed due at 20:00 polled from 15:00 on must not alert at 15:15
            due = _naive_utc(straggler_symbol.due_at)
            if state.get("pending_since") is None or datetime.fromisoformat(state["pending_since"]) < due:
                state["pending_since"] = due.isoformat()

        if state.get("pending_since") is None:
            state["pending_since"] = now.isoformat()
            _save_state(name, state)
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
                computed = bool(state.get("computed_bar") and observed_iso
                                and state["computed_bar"] > observed_iso)
                _alert_stale(name, expected, int(waited.total_seconds() // 60), straggler_symbol,
                             computed=computed)
                state["stall_alert_at"] = time.time()
        _save_state(name, state)
    finally:
        _release_lock(lock_path)


# Same detection as tick-winpid's _tw_index_futures_strategy (keep one copy when it merges).
_TW_FUT_SYMBOL_RE = re.compile(r'^SYMBOL\s*=\s*["\'](?:TXF|MXF|TMF)(?:R1)?["\']', re.M)
_TW_FUT_FETCH = "fetch_twfutures_ohlcv"
_TPE = timedelta(hours=8)


def _tw_futures_kind(name):
    """'index' (TXF/MXF/TMF read off TAIFEX data), 'lots' (any other strategy the 下單設定 sizes
    in contracts — stock futures: day session only), or None. Text and config only: this
    process must not import a venue module (tests/check_signals_without_venue)."""
    try:
        with open(f"strategies/{name}/strategy.py", encoding="utf-8", errors="replace") as f:
            text = f.read()
    except OSError:
        text = ""
    if _TW_FUT_FETCH in text and _TW_FUT_SYMBOL_RE.search(text):
        return "index"
    return "lots" if _sized_in_lots(name) else None


def _sized_in_lots(name):
    try:
        with open("manager/portfolio_config.json", encoding="utf-8") as f:
            spec = (json.load(f).get("asset_specs") or {}).get(name)
    except (OSError, ValueError, AttributeError):
        spec = None
    return isinstance(spec, dict) and spec.get("type") == "futures_contracts"


def _tw_holiday(day):
    """True when `day` (a date) is on the TWSE annual holiday table (TAIFEX closes with it).
    Table unreachable or unpublished → False: the weekday rules still hold."""
    try:
        from dotenv import dotenv_values
        from lib.data import fetch_twstock_holidays
        env = dotenv_values()
        table = fetch_twstock_holidays({"api-key": env.get("blave_api_key", ""),
                                        "secret-key": env.get("blave_secret_key", "")}, day.year)
    except Exception:
        return False
    if table is None or table.empty:
        return False
    return any(d.date() == day for d in table["date"])


def _tw_futures_closed(name, now):
    """A TAIFEX contract strategy and `now` (naive UTC) outside its session: day 08:45–13:45
    Mon–Fri; night (index futures only) 15:00–05:00, opening Mon–Fri; and a day on the TWSE
    holiday table (the night part after midnight belongs to the day before). Not known:
    typhoon closures, and a night session skipped before a holiday. The full slot table is
    tick-winpid's _tw_fut_slot."""
    kind = _tw_futures_kind(name)
    if kind is None:
        return False
    t = now + _TPE
    hm, wd = t.hour * 60 + t.minute, t.weekday()
    if wd <= 4 and 8 * 60 + 45 <= hm < 13 * 60 + 45:
        session_day = t.date()
    elif kind == "index" and wd <= 4 and hm >= 15 * 60:
        session_day = t.date()
    elif kind == "index" and 1 <= wd <= 5 and hm < 5 * 60:
        session_day = t.date() - timedelta(days=1)
    else:
        return True
    return _tw_holiday(session_day)


# runtime/strategy_reporter._PRICE_FETCHERS' names (this process cannot import runtime;
# tests/check_tw_stock_bar_calendar pins the copies equal).
_PRICE_FETCHERS = frozenset((
    "fetch_kline", "fetch_kline_batch", "fetch_bingx_kline",
    "fetch_twstock_price", "fetch_twstock_price_adj", "fetch_twstock_price_batch",
    "fetch_twstock_price_adj_batch", "fetch_twstock_ohlcv",
    "fetch_twfutures_ohlcv", "fetch_twfutures_ohlcv_batch", "fetch_txf_daily_public",
    "fetch_stock_futures_batch_daily",
    "fetch_usstock_price", "fetch_db_kline"))
# UTC-midnight trading-date labels. fetch_twstock_ohlcv is labelled at Taipei midnight and
# stays on the calendar floor.
_TW_STOCK_DAILY_FETCHERS = frozenset((
    "fetch_twstock_price", "fetch_twstock_price_adj", "fetch_twstock_price_batch",
    "fetch_twstock_price_adj_batch"))


def _price_fetchers(src):
    """The lib.data price fetchers `src` refers to — runtime/strategy_reporter._referenced_fetchers'
    rule: ast, so comments and strings never count (TEMPLATE_C names fetch_twstock_price in a
    comment); comment-stripped regex when the file does not parse."""
    try:
        tree = ast.parse(src)
    except (SyntaxError, ValueError):
        code = "\n".join(line.split("#", 1)[0] for line in src.splitlines())
        return set(re.findall(r"\bfetch_[a-z0-9_]+\b", code)) & _PRICE_FETCHERS
    found = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            found.add(node.id)
        elif isinstance(node, ast.Attribute):
            found.add(node.attr)
        elif isinstance(node, ast.ImportFrom):
            found.update(a.name for a in node.names)
    return found & _PRICE_FETCHERS


def _tw_stock_daily(name):
    """Every price the strategy reads is a TWSE/TPEx stock daily bar (Type A or a Type C
    universe), and it is not sized in contracts. Any other price fetcher beside them (mixed)
    keeps the calendar floor: a Taiwan strategy that also reads BTC as a feature then gets the
    old weekend alert back — wrong in the noisy direction, never a crypto bar silently skipped.
    Text and config only, like _tw_futures_kind."""
    try:
        with open(f"strategies/{name}/strategy.py", encoding="utf-8", errors="replace") as f:
            fetchers = _price_fetchers(f.read())
    except OSError:
        return False
    return bool(fetchers) and fetchers <= _TW_STOCK_DAILY_FETCHERS and not _sized_in_lots(name)


def _clear_wait(name, state):
    """Nothing is pending on a closed day: a wait or alert left from before (holiday table
    down, an older wait_for_bar) must not date or mute the next real stall."""
    state["pending_since"] = state["stall_alert_at"] = None
    _save_state(name, state)


def _tw_skip_weekend(day):
    while day.weekday() >= 5:
        day -= timedelta(days=1)
    return day


def _tw_skip_holidays(expected, state):
    """`expected` (a weekday) → the latest TWSE trading day at or before it, stopping at
    last_processed_bar. A day found closed is kept in state["tw_bar_map"] so the table is
    asked once per closed day, not every minute; an unknown table counts as open (the stall
    alert then fires as before)."""
    memo = state.get("tw_bar_map")
    if memo and memo[0] == expected.isoformat():
        return datetime.fromisoformat(memo[1])
    day = expected
    for _ in range(31):   # bounded: a bad table must not spin the tick
        if day.isoformat() == state.get("last_processed_bar") or not _tw_holiday(day.date()):
            break
        day = _tw_skip_weekend(day - timedelta(days=1))
    if day != expected:
        state["tw_bar_map"] = [expected.isoformat(), day.isoformat()]
    return day


def _maybe_prime(name, state, now, expected, td, latest, straggler_symbol):
    """Priming (module docstring). Caller holds the lock and has found `expected` not in."""
    fp, newest_iso = _fingerprint(latest)
    if fp is None or isinstance(straggler_symbol, _FeedWait):
        return
    if state.get("computed_fp") is not None:
        if fp == state["computed_fp"]:
            return  # already computed on exactly this data
    elif state.get("last_processed_bar") and \
            datetime.fromisoformat(newest_iso) <= datetime.fromisoformat(state["last_processed_bar"]):
        return  # state from before priming: its last run covered this data
    if state.get("prime_tried_fp") == fp:
        return
    if member_in_grace(latest, expected, now, td):
        return
    if _tw_futures_closed(name, now):
        return  # re-checked on later ticks; the first inside the session computes
    state["prime_tried_fp"] = fp
    if _run_strategy_protected(name):
        state["computed_fp"], state["computed_bar"] = fp, newest_iso
        print(f"[wait_for_bar] {name}: computed on data up to {newest_iso} "
              f"(expected {expected.isoformat()} not in yet)")
    else:
        state["last_attempt_failed_at"] = time.time()


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
