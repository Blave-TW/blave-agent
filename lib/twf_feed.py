"""The broker-agnostic half of the TW-futures live quote feed: the cache
convention a broker's 1-minute bars are converted to before lib/data reads them
(state/<broker>_bars_TXF_1m.json), shared by lib/president_quote (polled 1K
history) and lib/capital_quote (SKQuote push). Pure functions, stdlib plus
president_contracts only — no SDK, no vault, no credentials.

Convention (references/twfutures.md; measured on 統一 10-08): rows are
[ts_end_utc, o, h, l, c, v] labelled by the minute's END; the closing-match bar
(day start 13:45, night start 05:00) and, on the contract's own settlement day,
everything from 13:30 have no room in the cache; a contract contributes only the
bars of its own series span (president_contracts.series_roll_at); a bar whose END
is still ahead of the clock is not closed yet.
"""
import json
import os
from datetime import time as dtime, timedelta

if __package__ == "lib":  # never a same-named file elsewhere on sys.path
    from lib import president_contracts as pc
else:  # run as a script: lib/ is sys.path[0]
    import president_contracts as pc
try:
    if __package__ == "lib":
        from lib.winreplace import atomic_replace
    else:
        from winreplace import atomic_replace
except ImportError:  # half-updated workspace (lib/winreplace.py not landed): plain replace
    atomic_replace = os.replace
try:
    if __package__ == "lib":
        from lib.winreplace import load_json
    else:
        from winreplace import load_json
except ImportError:  # half-updated workspace (lib/winreplace.py without load_json): no read retry
    def load_json(path, **open_kw):
        with open(path, **open_kw) as f:
            return json.load(f)

TAIPEI = pc.TAIPEI
KEEP_DAYS = 2                 # rolling window, calendar days

DAY_CUT = (13, 45)            # closing match starts here; the cache's last day label is 13:45
SETTLE_CUT = (13, 30)         # settlement day: the expiring month's last series bar
NIGHT_OPEN = (15, 0)
NIGHT_CUT = (5, 0)
DAY_OPEN = (8, 45)
SESSIONS = (                  # feed windows (Taipei); a few minutes around each session
    (dtime(8, 40), dtime(13, 50)),
    (dtime(14, 55), dtime(23, 59, 59, 999999)),
    (dtime(0, 0), dtime(5, 5)),
)


def in_session(now):
    """True inside a feed window: weekday day / night sessions and the early
    hours that end a weekday's night session (Saturday 00:00–05:05 included,
    Monday's not). Holidays are not known here."""
    now = now.astimezone(TAIPEI)
    t, wd = now.time(), now.weekday()
    for i, (start, end) in enumerate(SESSIONS):
        if start <= t <= end:
            return wd < 5 if i < 2 else 1 <= wd <= 5
    return False


def in_gap(start, settle_day):
    """True for a bar (by its START minute) the cache has no room for."""
    hm = (start.hour, start.minute)
    if NIGHT_CUT <= hm < DAY_OPEN:
        return True
    cut = SETTLE_CUT if start.date() == settle_day else DAY_CUT
    return cut <= hm < NIGHT_OPEN


def series_span(productid):
    """[from, to): the aware Taipei span in which `productid` is the series contract."""
    y, m = pc.month_of(productid)
    py, pm = (y - 1, 12) if m == 1 else (y, m - 1)
    return pc.series_roll_at(py, pm), pc.series_roll_at(y, m)


def cache_rows(bars, productid, now, label_offset_min):
    """(start, o, h, l, c, v) items — `start` an aware datetime of the minute the
    broker's label points at — → sorted cache rows: END label = start +
    label_offset_min, the gap bars, anything outside the series span and a bar not
    closed by `now` dropped. Later items win on the same label."""
    settle_day = pc.settlement_at(*pc.month_of(productid)).date()
    span_from, span_to = series_span(productid)
    rows = {}
    for item in bars or []:
        try:
            start, o, h, l, c, v = item
        except (TypeError, ValueError):
            continue
        if start is None or not (span_from <= start < span_to) or in_gap(start.astimezone(TAIPEI), settle_day):
            continue
        end = start + timedelta(minutes=label_offset_min)
        if end > now:
            continue
        ts = int(end.timestamp())
        try:
            rows[ts] = [ts, float(o), float(h), float(l), float(c), int(v or 0)]
        except (TypeError, ValueError):
            continue
    return [rows[k] for k in sorted(rows)]


def merge_rows(old, new, now_epoch):
    """Union by timestamp (new wins), trimmed to the last KEEP_DAYS."""
    floor = now_epoch - KEEP_DAYS * 86400
    by_ts = {}
    for r in list(old or []) + list(new or []):
        if isinstance(r, list) and len(r) == 6 and isinstance(r[0], (int, float)) and r[0] >= floor:
            by_ts[int(r[0])] = [int(r[0])] + [float(x) for x in r[1:5]] + [int(r[5])]
    return [by_ts[k] for k in sorted(by_ts)]


def atomic_write(path, payload):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    atomic_replace(path + ".tmp", path)


def read_json(path):
    try:
        snap = load_json(path, encoding="utf-8")
    except (OSError, ValueError):
        return None
    return snap if isinstance(snap, dict) else None
