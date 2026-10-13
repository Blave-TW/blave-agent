"""Has the bar a live tick expects landed in the data it fetched?

Pure functions, shared by lib/runner.py (the BLAVE_EXPECTED_BAR gate: fetch once, judge, exit
75 when the bar is not in yet) and manager/wait_for_bar.py (its probe-then-run path for
strategies that do not go through run()). Everything is compared in naive UTC, the frame
wait_for_bar's `expected` lives in. lib/ never imports manager/.
"""
from collections import namedtuple
from datetime import datetime, timezone

Verdict = namedtuple('Verdict', 'observed_ts ready straggler')
# observed_ts: naive UTC datetime of the latest bar actually seen (Type C: the straggler
#              column's last valid observation), None when there is no data at all yet
# ready:       Type A: observed_ts >= expected; Type C: EVERY column's last valid >= expected
# straggler:   Type C: the column furthest behind (or the first one with no data at all);
#              Type A: None


def naive_utc(ts):
    """Bar timestamp → naive UTC datetime. A tz-aware label (Taiwan data is Asia/Taipei) is
    converted first; dropping its tz as-is would read Taipei wall clock as UTC and call a bar
    8h early "landed". Naive labels are taken as UTC."""
    import pandas as pd
    ts = pd.Timestamp(ts)
    if ts.tzinfo is not None:
        ts = ts.tz_convert('UTC').tz_localize(None)
    return ts.to_pydatetime()


def judge(data, expected):
    """fetch_data()'s return value (DataFrame, or a Type C tuple whose [0] is close_df) against
    the expected bar's naive-UTC open label."""
    if isinstance(data, tuple):
        close_df = data[0]
        if close_df.empty:
            return Verdict(None, False, None)
        last_valid = close_df.apply(lambda col: col.last_valid_index())
        if last_valid.isna().any():
            # at least one symbol has literally never had a data point
            return Verdict(None, False, last_valid[last_valid.isna()].index[0])
        straggler = last_valid.idxmin()
        ready = all(naive_utc(ts) >= expected for ts in last_valid)
        return Verdict(naive_utc(last_valid[straggler]), ready, straggler)
    if data.empty:
        return Verdict(None, False, None)
    last_ts = naive_utc(data.index[-1])
    return Verdict(last_ts, last_ts >= expected, None)


def _iso(ts):
    try:
        return naive_utc(ts).isoformat()
    except Exception:
        return str(ts)


def feed_wait(exc):
    """lib.data.FeedNotPublished → the four fields wait_for_bar needs (ISO strings), or None
    for any other exception."""
    if not all(hasattr(exc, a) for a in ('source', 'need', 'due_at', 'last_bar')):
        return None
    return {'source': str(exc.source), 'need': _iso(exc.need),
            'due_at': _iso(exc.due_at), 'last_bar': _iso(exc.last_bar)}


def parse_expected(value):
    """BLAVE_EXPECTED_BAR → naive UTC datetime; anything unparseable → None (gate stays off)."""
    if not value or not isinstance(value, str):
        return None
    try:
        dt = datetime.fromisoformat(value.strip())
    except ValueError:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt
