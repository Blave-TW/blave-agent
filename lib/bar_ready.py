"""When a scheduled Type A/C tick computes the bar it is waiting for — one copy of the rule.

manager/wait_for_bar.py ticks on it (its module docstring: Type A/C readiness, Priming), and
lib/runner's Type C preview asks the same question of a backtest's data at the moment it is
written (computes_now): a preview is only the live row if a tick would have computed that row.
Standard library + pandas only — wait_for_bar loads this before any strategy code.
"""
import re
from datetime import datetime, timedelta

PRIME_GRACE_SECONDS = 300   # see Priming in wait_for_bar's module docstring
# A Type C member this far behind the frame's newest member is not waited for: it is no longer
# trading (a delisted coin, a symbol its source dropped). Counted against the newest member, not
# the expected bar, so a whole-frame lag is never "dead". The 30-day floor clears every gap a
# live member shows: a weekend (TXF 55 bars behind BTC on 1h), Lunar New Year (TWSE ~12 days);
# 20 bars widens it for weekly bars. Taiwan stocks are known sooner, by the CDN (`inactive`).
DEAD_AFTER_BARS = 20
DEAD_AFTER_FLOOR = timedelta(days=30)

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


def dead_members(latest, inactive=(), td=None):
    """Members of `latest` ({member: its newest bar}) whose next bar is not coming, sorted: named
    in `inactive` (Taiwan: lib.data.tw_not_trading) or behind the newest member by more than
    DEAD_AFTER_BARS bars of `td` / DEAD_AFTER_FLOOR. The newest member is never one."""
    newest = max(latest.values())
    limit = max(DEAD_AFTER_FLOOR, DEAD_AFTER_BARS * td) if td else DEAD_AFTER_FLOOR
    return sorted(k for k, v in latest.items() if v < newest and (k in inactive or newest - v > limit))


def judge(data, expected, inactive=(), td=None):
    """fetch_data()'s result against `expected` → (observed_ts, ready, straggler, latest); the
    fields are documented on wait_for_bar._check_freshness. Type C: dead_members are left out
    of ready, straggler and observed_ts, kept in latest."""
    if isinstance(data, tuple):
        close_df = data[0]
        if close_df.empty:
            return None, False, None, None
        last_valid = close_df.apply(lambda col: col.last_valid_index())
        if last_valid.isna().any():
            # at least one symbol has literally never had a data point
            return None, False, last_valid[last_valid.isna()].index[0], None
        latest = {str(k): naive_utc(v) for k, v in last_valid.items()}
        dead = set(dead_members(latest, inactive, td))
        live = {k: v for k, v in latest.items() if k not in dead}
        straggler_symbol = min(live, key=live.get)
        return live[straggler_symbol], all(v >= expected for v in live.values()), straggler_symbol, latest
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


def computes_now(data, interval, now, inactive=()):
    """Would a tick at `now` (naive UTC) compute on `data`: the expected bar is in for every
    member, or it is not but priming would run (every member has data, none inside its grace).
    Not covered here, each handled by its caller: an align_feed row not yet published (the
    tick waits), a TAIFEX contract outside its session (wait_for_bar._tw_futures_closed: the
    prime runs at the next session on the same data), the once-per-data prime dedupe."""
    td = interval_to_timedelta(interval)
    expected = expected_closed_bar_open(interval, now)
    _, ready, _, latest = judge(data, expected, inactive, td)
    return ready or (latest is not None and not member_in_grace(latest, expected, now, td))
