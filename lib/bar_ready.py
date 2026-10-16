"""When a scheduled Type A/C tick computes the bar it is waiting for — one copy of the rule.

manager/wait_for_bar.py ticks on it (its module docstring: Type A/C readiness, Priming), and
lib/runner's Type C preview asks the same question of a backtest's data at the moment it is
written (computes_now): a preview is only the live row if a tick would have computed that row.
Standard library + pandas only — wait_for_bar loads this before any strategy code.
"""
import re
from datetime import datetime, timedelta

PRIME_GRACE_SECONDS = 300   # see Priming in wait_for_bar's module docstring

# Unit spellings actually in use across strategies/examples: '1h', '5min',
# '1d', but also the bare-'m' form ('60m', '1m') — both must resolve to the
# SAME meaning here as in manager/healthcheck.py's copy of this table; if one
# changes, change both or the two scripts silently disagree on cadence.
_INTERVAL_RE = re.compile(r"^(\d+)(min|m|h|d|w)$")
_UNIT_TO_KW = {"min": "minutes", "m": "minutes", "h": "hours", "d": "days", "w": "weeks"}


def interval_to_timedelta(interval):
    m = _INTERVAL_RE.match(interval)
    if not m:
        raise ValueError(f"unrecognized INTERVAL format: {interval!r}")
    n, unit = int(m.group(1)), m.group(2)
    return timedelta(**{_UNIT_TO_KW[unit]: n})


def expected_closed_bar_open(interval, now):
    """Open-time label of the most recently closed bar, epoch-aligned (matches
    how the underlying kline sources bucket bars — UTC midnight / top-of-hour)."""
    td = interval_to_timedelta(interval)
    epoch = datetime(1970, 1, 1)
    since_epoch = now - epoch
    floored = epoch + (since_epoch // td) * td
    return floored - td


def naive_utc(ts):
    """Bar timestamp → naive UTC datetime, the frame `expected` lives in. A tz-aware label
    (Taiwan data is Asia/Taipei) is converted first; dropping its tz as-is would read
    Taipei wall-clock as UTC and call a bar 8h early "landed". Naive labels are taken as
    UTC, as before."""
    import pandas as pd
    ts = pd.Timestamp(ts)
    if ts.tzinfo is not None:
        ts = ts.tz_convert("UTC").tz_localize(None)
    return ts.to_pydatetime()


def judge(data, expected):
    """fetch_data()'s result against `expected` → (observed_ts, ready, straggler, latest); the
    fields are documented on wait_for_bar._check_freshness."""
    if isinstance(data, tuple):
        close_df = data[0]
        if close_df.empty:
            return None, False, None, None
        last_valid = close_df.apply(lambda col: col.last_valid_index())
        if last_valid.isna().any():
            # at least one symbol has literally never had a data point
            return None, False, last_valid[last_valid.isna()].index[0], None
        straggler_symbol = last_valid.idxmin()
        straggler_ts = naive_utc(last_valid[straggler_symbol])
        ready = all(naive_utc(ts) >= expected for ts in last_valid)
        return straggler_ts, ready, straggler_symbol, {str(k): naive_utc(v) for k, v in last_valid.items()}
    else:
        if data.empty:
            return None, False, None, None
        last_ts = naive_utc(data.index[-1])
        return last_ts, last_ts >= expected, None, {"": last_ts}


def member_in_grace(latest, expected, now, td):
    """A member's next bar is due at its bar + 2·td. Any member still behind but inside the grace
    is waited for, so the bar is computed once on complete data; one stuck for days is long
    past its grace and holds nothing up — but it must not let the others in batch by batch."""
    grace = timedelta(seconds=PRIME_GRACE_SECONDS)
    return any(m < expected and now < m + 2 * td + grace for m in latest.values())


def computes_now(data, interval, now):
    """Would a tick at `now` (naive UTC) compute on `data`: the expected bar is in for every
    member, or it is not but priming would run (every member has data, none inside its grace).
    Not covered here, each handled by its caller: an align_feed row not yet published (the
    tick waits), a TAIFEX contract outside its session (wait_for_bar._tw_futures_closed: the
    prime runs at the next session on the same data), the once-per-data prime dedupe."""
    td = interval_to_timedelta(interval)
    expected = expected_closed_bar_open(interval, now)
    _, ready, _, latest = judge(data, expected)
    return ready or (latest is not None and not member_in_grace(latest, expected, now, td))
