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
  tw_fut_holiday      : TAIFEX intraday strategies only: {date: [on the holiday table, asked at]},
                         the last 25 days, each answer reused 6 hours (_tw_fut_holiday_memo)
  tw_fut_night_bar    : stock futures (sized in lots) only: the newest 17:25–05:00 night-session bar
                         this strategy observed; its night session counts as trading for
                         TW_FUT_NIGHT_KEEP_DAYS after it (_tw_fut_lots_night)
  not_waited / dead_noticed : Type C members readiness does not wait for (lib.bar_ready.dead_members),
                         and those of them already notified as long dead (_note_dead)

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

TAIFEX intraday strategies (_tw_futures_kind, INTERVAL under 1d) do use the calendar for alerting:
while the expected bar is one Blave never publishes (_tw_fut_bar_exists: off-session, weekend,
holiday table) and every bar before it that does exist is in, nothing is late — no bar_stale,
pending_since is cleared (the next real bar is timed from its own close), and polling runs at the
stall throttle's minutes instead of every minute. Without this every session close alerted once
15 minutes later (07:15 and 15:15 Taipei for a 1h TXF strategy) and again daily over weekends.
A bar that does exist and is missing (13:44 never came, the night's 05:00 never came) alerts as
before. A bar observed where the model says none exists (the table is wrong, a stock future's
night session nobody told us about) turns the quiet off for that tick — see _tw_fut_quiet.

TWSE/TPEx stock daily strategies (only fetch_twstock_price* prices, _tw_stock_daily) do use the calendar:
their bars exist on trading days only, so the expected bar is the latest weekday not on the
TWSE holiday table. Otherwise every Sunday, Monday morning and day after a holiday waited on a
bar that never comes, alerted, and ran Monday's bar twice (once for "Sunday", once for itself).

Repeat alerting during a stall: the FIRST alert for a given `last_seen_bar`
fires at STALE_TIMEOUT_MINUTES; after that, as long as it's still the SAME
`last_seen_bar` (no progress at all), a repeat fires every
STALL_REALERT_SECONDS instead of never again — a feed stuck for good would
otherwise get exactly one alert, then silence. The straggler's identity (Type C:
which column; Type A: n/a) is named in the alert text so it is actionable.

Cost note: the freshness check is NOT free — it calls the strategy's real
fetch_data(), the same call the actual run makes (multiple HTTP/cache-backed
sources for a strategy like txf_composite_60m). While a bar is pending and
not yet in a detected stall this runs once a minute; see Market-closed
handling above for what happens once one is detected.

Type A strategies (fetch_data → single DataFrame): ready when its last row's
timestamp reaches the expected bar.
Type C strategies (fetch_data → (close_df, open_df[, ...])): ready when
every column in close_df that is still trading has a valid (non-NaN)
observation at/after the expected bar — wait for the whole universe, not just
the first symbol to update. Not waited for (lib.bar_ready.dead_members): a
Taiwan stock the CDN manifest says did not trade on its last day, and any
member more than DEAD_AFTER_BARS bars / 30 days behind the newest member
(delisted, halted indefinitely) — only ever a minority: when half the universe
or more looks dead, its shared source stopped and the strategy waits as before. Waiting on those held last_processed_bar
empty forever: every signal then came from a prime, which is tried once per
data, so one failed prime lost that day's rebalance, and bar_stale re-fired
daily. A long-dead member is notified once (_note_dead) so it can be taken
out of UNIVERSE. A column that never had any data still blocks.

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
try:
    from lib.winreplace import load_json  # noqa: E402
except ImportError:  # half-updated workspace (lib/winreplace.py without load_json): no read retry
    def load_json(path, **open_kw):
        with open(path, **open_kw) as f:
            return json.load(f)


# ── Fallback copy of lib/bar_ready ───────────────────────────────────────────
# The readiness and priming rule lives in lib/bar_ready (lib/runner's Type C preview asks it too).
# update_workspace writes file by file, so a workspace can hold this manager beside a lib that
# has no bar_ready yet; without a copy here every Type A/C tick would die at import, before
# main() could alert. Used only then. tests/check_bar_ready_fallback.py keeps both copies giving
# the same answers — change them together.
_FB_PRIME_GRACE_SECONDS = 300
_FB_DEAD_AFTER_BARS = 20
_FB_DEAD_AFTER_FLOOR = timedelta(days=30)
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


def _fb_dead_members(latest, inactive=(), td=None, expected=None):
    anchor = max(latest.values())
    if expected is not None:
        anchor = min(anchor, expected)
    limit = max(_FB_DEAD_AFTER_FLOOR, _FB_DEAD_AFTER_BARS * td) if td else _FB_DEAD_AFTER_FLOOR
    dead = sorted(k for k, v in latest.items() if v < anchor and (k in inactive or anchor - v > limit))
    return dead if 2 * len(dead) < len(latest) else []


def _fb_judge(data, expected, inactive=(), td=None):
    if isinstance(data, tuple):
        close_df = data[0]
        if close_df.empty:
            return None, False, None, None
        last_valid = close_df.apply(lambda col: col.last_valid_index())
        if last_valid.isna().any():
            return None, False, last_valid[last_valid.isna()].index[0], None
        latest = {str(k): _fb_naive_utc(v) for k, v in last_valid.items()}
        dead = set(_fb_dead_members(latest, inactive, td, expected))
        live = {k: v for k, v in latest.items() if k not in dead}
        straggler_symbol = min(live, key=live.get)
        return live[straggler_symbol], all(v >= expected for v in live.values()), straggler_symbol, latest
    if data.empty:
        return None, False, None, None
    last_ts = _fb_naive_utc(data.index[-1])
    return last_ts, last_ts >= expected, None, {"": last_ts}


def _fb_member_in_grace(latest, expected, now, td):
    grace = timedelta(seconds=_FB_PRIME_GRACE_SECONDS)
    return any(m < expected and now < m + 2 * td + grace for m in latest.values())


try:
    from lib.bar_ready import (PRIME_GRACE_SECONDS, dead_members as _dead_members,  # noqa: E402
                               expected_closed_bar_open as _expected_closed_bar_open,
                               interval_to_timedelta as _interval_to_timedelta, judge as _judge,
                               member_in_grace, naive_utc as _naive_utc)
except ImportError:   # half-updated workspace: lib without bar_ready (or an older one)
    PRIME_GRACE_SECONDS = _FB_PRIME_GRACE_SECONDS
    _expected_closed_bar_open, _interval_to_timedelta = _fb_expected_closed_bar_open, _fb_interval_to_timedelta
    _judge, member_in_grace, _naive_utc = _fb_judge, _fb_member_in_grace, _fb_naive_utc
    _dead_members = _fb_dead_members

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
        "not_waited": [],
        "dead_noticed": [],
    }


def _load_state(name):
    path = f"{STATE_DIR}/{name}.json"
    if os.path.exists(path):
        try:
            return {**_default_state(), **load_json(path)}
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
                    at/after `expected`. Type C: every column still trading has a
                    valid observation at/after `expected` (lib.bar_ready.dead_members
                    are not waited for: a Taiwan stock the CDN manifest says did not
                    trade on its last day, any member far behind the newest one).
      straggler   : Type A: always None (no per-symbol concept). Type C: the
                    column still trading that is furthest behind — named so an alert
                    can point at the actual symbol to investigate.

      latest      : {member: its newest bar} — Type C every column, Type A {"": observed_ts};
                    None without data. Priming's fingerprint (_fingerprint).

    Raises whatever fetch_data() raises (network errors, or a strategy's own
    deliberate fail-loud guard like txf_composite_60m's degraded-dividend
    check) — the caller is responsible for treating that as a failed attempt,
    not a "not ready yet".
    """
    global _dead
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
    try:  # and the US-stock gate reads which strategy is fetching
        from lib.data import us_live_strategy
    except ImportError:
        from contextlib import nullcontext
        us_live_strategy = lambda *a: nullcontext()
    with closed_bars_only(), live_feeds(), \
            us_live_strategy(_name_of(mod), getattr(mod, "SYMBOL", None)):
        data = mod.fetch_data(hdrs)
    inactive = set()
    if isinstance(data, tuple):
        try:
            from lib.data import tw_not_trading
            inactive = tw_not_trading(data[0].columns, expected.strftime("%Y-%m-%d"))
        except ImportError:
            pass
    try:
        td = _interval_to_timedelta(getattr(mod, "INTERVAL", ""))
    except ValueError:
        td = None
    verdict = _judge(data, expected, inactive, td)
    if verdict[3] and len(verdict[3]) > 1:
        _dead = (_dead_members(verdict[3], inactive, td, expected),
                 _dead_members(verdict[3], (), td, expected))
    return verdict


def _name_of(mod):
    """The strategy folder _load_strategy_module loaded `mod` from — the key the 下單設定 routes."""
    n = getattr(mod, "__name__", "")
    return n[len("strategy_wait_"):] if n.startswith("strategy_wait_") else getattr(mod, "STRATEGY_NAME", None)


def _fingerprint(latest):
    """(fingerprint, newest ISO) of _check_freshness's `latest`, or (None, None)."""
    if not latest:
        return None, None
    import hashlib
    body = json.dumps(sorted((k, v.isoformat()) for k, v in latest.items()))
    return hashlib.sha1(body.encode()).hexdigest(), max(latest.values()).isoformat()


_fetched_since = None   # naive UTC: when this tick's _check_freshness began fetching
_dead = None            # _check_freshness: (members not waited for, those of them long dead); None = not judged


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
             minutes=minutes_waited, computed=bool(computed))
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


def _note_dead(name, state, dead, long_dead, latest=None):
    """Members readiness stopped waiting for: logged when the set changes; one long dead
    (delisted, most likely) is notified once — again only if it trades and stops once more.
    latest: {member: its newest bar}, for the event's last_trade."""
    if dead != state.get("not_waited", []):
        print(f"[wait_for_bar] {name}: not waiting for {', '.join(dead) or 'none'} "
              f"(no bar coming: not trading, or far behind the rest)")
    new = [m for m in long_dead if m not in state.get("dead_noticed", [])]
    state["not_waited"], state["dead_noticed"] = dead, long_dead
    if not new:
        return
    try:
        from lib.events import emit
        last = [latest[m] for m in new if latest and latest.get(m) is not None]
        # Capped here, not left to the platform: a payload over its 4KB limit is dropped whole
        emit("dead_members", strategy=name, symbols=[str(m)[:40] for m in new[:50]],
             last_trade=max(last).date().isoformat() if last else None)
    except Exception:
        pass
    shown = "、".join(new[:10]) + (f" 等 {len(new)} 檔" if len(new) > 10 else "")
    try:
        from lib.notify import send_text
        send_text(f"ℹ️ {name}：{shown} 已經一個月以上沒有新資料（多半是已下市），排程不再等它，"
                  f"訊號照其他標的準時算。若已下市，請從 UNIVERSE 移除，以免策略還配權重給它。")
    except Exception as e:  # best-effort, like _alert_stale
        logging.warning(f"[wait_for_bar] dead-member notification dropped ({e})")


def _alert_wrapper_error(name, exc):
    """wait_for_bar.py's OWN failure (bad INTERVAL, fetch_data raising, import
    error, etc.) — this happens BEFORE run_strategy's protection ever
    engages, so without this the failure would be entirely silent (cron
    swallows the traceback, no Telegram, nothing)."""
    state_path = f"{STATE_DIR}/{name}.json"
    now = time.time()
    try:
        state = load_json(state_path) if os.path.exists(state_path) else {}
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
    global _fetched_since, _dead
    mod = _load_strategy_module(name)
    interval = getattr(mod, "INTERVAL", None)
    if not interval:
        print(f"[wait_for_bar] {name}: no INTERVAL in strategy.py — Type B strategies "
              f"don't use wait_for_bar.py, check references/deployment.md")
        return

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    expected = _expected_closed_bar_open(interval, now)
    tw_stock = interval == "1d" and _tw_stock_daily(name)
    us_stock = interval == "1d" and not tw_stock and _us_stock_daily(name)
    if tw_stock:
        expected = _tw_skip_weekend(expected)
    elif us_stock:
        expected = _us_expected(now)
    expected_iso = expected.isoformat()

    state = _load_state(name)

    # Fast path: this bar's already been run — stay quiet, no fetch, no log, no lock.
    if state.get("last_processed_bar") == expected_iso:
        if (tw_stock or us_stock) and (state.get("pending_since") or state.get("stall_alert_at")):
            _clear_wait(name, state)   # a wait left by an older wait_for_bar on a closed day
        return

    # Backoff: don't hammer a run (or a fetch_data() that itself keeps raising)
    # every single minute right after it just failed.
    last_failed = state.get("last_attempt_failed_at")
    if last_failed and time.time() - last_failed < RETRY_BACKOFF_SECONDS:
        return

    # A TAIFEX intraday strategy between sessions: quiet (module docstring, _tw_fut_quiet).
    fut_kind = fut_td = holiday_fn = None
    if not (tw_stock or us_stock):
        try:
            fut_td = _interval_to_timedelta(interval)
        except ValueError:
            fut_td = None
        if fut_td is not None and fut_td < timedelta(days=1):
            fut_kind = _tw_futures_kind(name)
        if fut_kind and not _tw_fut_data(name):
            fut_kind = None   # sized in contracts, priced off something else: its own hours
    if fut_kind:
        holiday_fn = _tw_fut_holiday_memo(state)
        lots_night = _tw_fut_lots_night(state, now)
        quiet = _tw_fut_quiet(fut_kind, expected, fut_td, state.get("last_seen_bar"), holiday_fn,
                              lots_night)
    else:
        quiet = False

    # Stall throttle: once we've confirmed a stall (alerted at least once this
    # episode — see stall_alert_at), stop polling every minute — this is what a
    # TXF weekend close looks like. Resumes full speed the moment data moves.
    # Also polled right after the priming grace (:05 of each quarter): with a member stuck the
    # bar is primed then, on everything that landed by the grace, not 15 minutes later.
    # A quiet TAIFEX close polls on the same minutes: a bar the calendar got wrong still lands
    # within 10 minutes.
    if state.get("stall_alert_at") is not None or quiet:
        if now.minute % STALL_POLL_MINUTES not in (0, PRIME_GRACE_SECONDS // 60):
            return   # no state write outside the lock: the memo is kept by the next polled tick

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
            _dead = None
            observed_ts, ready, straggler_symbol, latest = _check_freshness(mod, expected)
            if _dead is not None:   # a frame without data says nothing about who is dead
                _note_dead(name, state, *_dead, latest=latest)
        except Exception as e:
            if not _is_feed_wait(e):
                # fetch_data() itself raised — network error, or a strategy's own
                # deliberate fail-loud guard (e.g. txf_composite_60m's degraded-
                # dividend check). This is NOT a wait_for_bar.py bug, so route it
                # through the normal failed-run alert (its own 24h cooldown) —
                # not main()'s "wrapper itself is broken" alert — and back off
                # like any other failed attempt instead of retrying every minute.
                output = f"fetch_data() raised while checking freshness: {e}\n" + traceback.format_exc()
                transient = _is_us_unavailable(e)
                if transient:   # last: alert() keeps the tail of the output
                    output += "\n美股日線這輪抓不到,沒有算訊號,部位維持原樣不動,稍後自動重試。"
                _alert_failure().alert(name, "fetch_error", output, transient=transient)
                state["last_attempt_failed_at"] = time.time()
                _save_state(name, state)
                return
            # Bars are in, an align_feed row they need is not published yet: "not ready",
            # not a failed run — no fetch_error alert, no backoff.
            observed_ts, ready, straggler_symbol, latest = _naive_utc(e.last_bar), False, _FeedWait(e), None

        observed_iso = observed_ts.isoformat() if observed_ts is not None else None
        fp, newest_iso = _fingerprint(latest)

        if fut_kind == "lots" and observed_ts is not None and _tw_fut_night_label(observed_ts, fut_td):
            state["tw_fut_night_bar"] = observed_iso   # on the ready path too: a prompt feed is never pending

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

        if fut_kind and not isinstance(straggler_symbol, _FeedWait) and \
                _tw_fut_quiet(fut_kind, expected, fut_td, observed_iso, holiday_fn,
                              _tw_fut_lots_night(state, now)):
            state["pending_since"] = None   # stall_alert_at stays: it may be a real stall's
            _save_state(name, state)
            return

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
# TAIFEX sessions, Taipei minutes of the day, [open, close): day Mon–Fri; night opens Mon–Fri and
# runs past midnight. Index futures open the night at 15:00, the stock futures that have one
# (TSMC, UMC… — not all) at 17:25. Shared by _tw_futures_closed and _tw_fut_bar_exists.
_TW_FUT_DAY_OPEN, _TW_FUT_DAY_CLOSE = 8 * 60 + 45, 13 * 60 + 45
_TW_FUT_NIGHT_OPEN, _TW_FUT_LOTS_NIGHT_OPEN, _TW_FUT_NIGHT_CLOSE = 15 * 60, 17 * 60 + 25, 5 * 60


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
        cfg = load_json("manager/portfolio_config.json", encoding="utf-8")
        spec = (cfg.get("asset_specs") or {}).get(name)
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
    if wd <= 4 and _TW_FUT_DAY_OPEN <= hm < _TW_FUT_DAY_CLOSE:
        session_day = t.date()
    elif kind == "index" and wd <= 4 and hm >= _TW_FUT_NIGHT_OPEN:
        session_day = t.date()
    elif kind == "index" and 1 <= wd <= 5 and hm < _TW_FUT_NIGHT_CLOSE:
        session_day = t.date() - timedelta(days=1)
    else:
        return True
    return _tw_holiday(session_day)


def _tw_fut_sessions(kind, day, lots_night):
    """[open, close) as naive Taipei datetimes of the sessions opening on `day` (a weekday)."""
    d = datetime(day.year, day.month, day.day)
    out = [(d + timedelta(minutes=_TW_FUT_DAY_OPEN), d + timedelta(minutes=_TW_FUT_DAY_CLOSE))]
    night = _TW_FUT_NIGHT_OPEN if kind == "index" else _TW_FUT_LOTS_NIGHT_OPEN if lots_night else None
    if night is not None:
        out.append((d + timedelta(minutes=night), d + timedelta(days=1, minutes=_TW_FUT_NIGHT_CLOSE)))
    return out


def _tw_fut_bar_exists(kind, bar_open, td, holiday_fn, lots_night=False):
    """Blave publishes a TAIFEX bar that ends a wait for `bar_open` (naive UTC, as
    _expected_closed_bar_open gives it; INTERVAL under 1d). A different question from
    _tw_futures_closed ("is `now` inside a session"), and the answers differ in the closing
    minute: 13:45 and 05:00 are closed, yet the bar holding their last trade exists.

    Blave's labels (twfutures3 cache, TXF / CDF / DHF, 2026-09-21..10-23 — pinned by
    tests/check_tw_futures_quiet.py): 1m bars are labelled by their CLOSE minute — the day
    session is 08:46..13:45, the night 15:01..05:00, no 08:45 and no 15:00. Longer bars bucket
    those 1m labels on their own grid, labelled at the bucket start: 5m 08:45 (holds 08:46–08:49)
    .. 13:45 (holds only the 13:45 one), 15m 08:45..13:45, 30m 08:30..13:30, 60m 08:00..13:00 and
    15:00..05:00 — so the night's last trade makes its own 60m 05:00 bar and there is no 14:00 or
    06:00 bar. Put as one rule: a wait for bar_open ends when some trading minute (open-time
    minute inside a session) falls in [bar_open − 1m, bar_open + td) — the −1m being the 1m
    label that already satisfies the wait's `>=` (the 08:46 label ends the wait for 08:45).

    A session counts when it opens on a weekday that is not on the holiday table (the night
    part after midnight belongs to the day before); holiday_fn(date) is asked at most once per
    session day and only when the bar overlaps that day's sessions. Stock futures' night is
    counted only with lots_night (most have none). Not known, so counted as existing: typhoon
    closures, a night session skipped before a holiday, and the settlement day's early close
    (third Wednesday, the expiring contract stops at 13:30: 1m 13:31–13:45 and 5m/15m 13:45 do
    not exist that afternoon — a short-bar strategy alerts there once, as before)."""
    lo = bar_open + _TPE - timedelta(minutes=1)
    hi = bar_open + _TPE + td
    day = lo.date() - timedelta(days=1)
    while day <= hi.date():
        if day.weekday() <= 4 and any(lo < b and a < hi for a, b in _tw_fut_sessions(kind, day, lots_night)) \
                and not holiday_fn(day):
            return True
        day += timedelta(days=1)
    return False


def _tw_fut_last_bar_before(kind, bar_open, td, holiday_fn, lots_night=False, days=21):
    """The newest bar on bar_open's grid before it that _tw_fut_bar_exists; None within `days`
    (21: the Lunar New Year closure runs 9–12 calendar days with its weekends).
    Session by session, newest first: in a session [a, b) the last such bar is the grid floor of
    min(bar_open − td, b), if it still reaches past a − td."""
    epoch = datetime(1970, 1, 1)
    day = (bar_open + _TPE).date()
    for _ in range(days + 2):
        if day.weekday() <= 4:
            for a, b in reversed(_tw_fut_sessions(kind, day, lots_night)):
                cap = min(bar_open - td, b - _TPE)
                last = epoch + ((cap - epoch) // td) * td
                if last + _TPE > a - td and last >= bar_open - timedelta(days=days) \
                        and not holiday_fn(day):
                    return last
        day -= timedelta(days=1)
    return None


def _tw_fut_holiday_memo(state):
    """_tw_holiday kept in state (tw_fut_holiday) so the minute ticks do not ask the table every
    minute. A False may only mean the table was unreachable: that errs
    toward "the bar exists", the old alerting, and is asked again after 6 hours."""
    memo = state.get("tw_fut_holiday") or {}
    today = datetime.now(timezone.utc).date()
    memo = {k: v for k, v in memo.items() if (today - datetime.fromisoformat(k).date()).days <= 25}
    state["tw_fut_holiday"] = memo

    def closed(day):
        hit = memo.get(day.isoformat())
        if hit and time.time() - hit[1] < 6 * 3600:
            return hit[0]
        memo[day.isoformat()] = [bool(_tw_holiday(day)), time.time()]
        return memo[day.isoformat()][0]
    return closed


def _tw_fut_quiet(kind, expected, td, seen_iso, holiday_fn, lots_night=False):
    """Nothing is late: the expected bar is one Blave never publishes, and `seen_iso` (the newest
    bar observed) has reached the last one before it that it does. Not quiet when the seen bar is
    itself one the model says does not exist — the calendar is wrong for this series (a holiday
    that traded, an unknown night session), so it is waited on and alerted as before."""
    try:
        seen = datetime.fromisoformat(seen_iso)
    except (TypeError, ValueError):   # None (no data yet) or a state file from elsewhere
        return False
    if _tw_fut_bar_exists(kind, expected, td, holiday_fn, lots_night) or \
            not _tw_fut_bar_exists(kind, seen, td, holiday_fn, lots_night):
        return False
    last = _tw_fut_last_bar_before(kind, expected, td, holiday_fn, lots_night)
    return last is not None and seen >= last


TW_FUT_NIGHT_KEEP_DAYS = 14   # > the longest closure (Lunar New Year, ~12 days); a strategy moved to
                              # a day-only contract stops expecting a night within two weeks


def _tw_fut_night_label(bar_open, td):
    """A bar only a stock future's 17:25–05:00 night session explains — not a day bar, and not a
    stray label between 13:45 and 17:25 that no session explains."""
    never = lambda d: False
    return _tw_fut_bar_exists("lots", bar_open, td, never, True) and \
        not _tw_fut_bar_exists("lots", bar_open, td, never, False)


def _tw_fut_lots_night(state, now):
    """The stock future's night session counts as trading: a night bar was observed within
    TW_FUT_NIGHT_KEEP_DAYS."""
    try:
        seen = datetime.fromisoformat(state.get("tw_fut_night_bar"))
    except (TypeError, ValueError):
        return False
    return now - seen <= timedelta(days=TW_FUT_NIGHT_KEEP_DAYS)


def _tw_fut_data(name):
    """Every price fetcher the strategy calls is a TAIFEX one (lib.data._price_fetcher_scan, read
    as code); unreadable source or an older lib → False, the old alerting."""
    try:
        from lib.data import _PRICE_FETCHERS, _price_fetcher_scan
        with open(f"strategies/{name}/strategy.py", encoding="utf-8", errors="replace") as f:
            names, _ = _price_fetcher_scan(f.read())
    except Exception:
        return False
    return bool(names) and all(_PRICE_FETCHERS.get(n) == "twfutures" for n in names)


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


def _us_stock_daily(name):
    """Every price the strategy reads is a US daily bar (fetch_usstock_price): bars exist on NYSE
    trading days only. Text only, like _tw_stock_daily."""
    try:
        with open(f"strategies/{name}/strategy.py", encoding="utf-8", errors="replace") as f:
            fetchers = _price_fetchers(f.read())
    except OSError:
        return False
    return fetchers == {"fetch_usstock_price"}


_US_FINAL_HOUR = 17   # New York; = lib.data FEED_TIMING['usstock_price'] (tests/check_usstock_live pins it)


def _us_expected(now):
    """`now` (naive UTC) → the latest NYSE session whose bar is final, as a naive midnight — the
    label fetch_usstock_price gives it. The bar is final at 17:00 New York, so the signal runs
    then, not at the next UTC midnight the plain floor would wait for."""
    import pandas as pd
    ny = pd.Timestamp(now).tz_localize("UTC").tz_convert("America/New_York")
    day = datetime(ny.year, ny.month, ny.day)
    if ny.hour < _US_FINAL_HOUR:
        day -= timedelta(days=1)
    return _us_last_session(day)


def _us_last_session(day):
    """`day` (naive midnight) → the latest NYSE trading day at or before it (lib.data
    us_market_closed; weekends only when that lib is older). A holiday is skipped, never waited
    on: its bar does not exist, the position stays as the last session left it."""
    try:
        from lib.data import us_market_closed
    except ImportError:
        us_market_closed = lambda d: d.weekday() >= 5
    for _ in range(10):   # bounded: no NYSE closure runs this long
        if not us_market_closed(day):
            break
        day -= timedelta(days=1)
    return day


def _is_us_unavailable(exc):
    """Yahoo / yfinance did not answer this round — retrying can succeed. UsStockNotHere (a
    routing refusal) subclasses it but repeats every run until the setup changes."""
    try:
        from lib.data import UsStockNotHere, UsStockUnavailable
    except ImportError:
        return False
    return isinstance(exc, UsStockUnavailable) and not isinstance(exc, UsStockNotHere)


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
