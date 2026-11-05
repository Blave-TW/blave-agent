"""When a Taiwan futures entry may go out: the TAIFEX regular session, read on a clock checked
against the Blave api's.

Two holes it closes (.claude/output/backend/president-retry-2026-11-04.md):
- A market IOC sent in the pre-open (14:50–15:00, 08:30–08:45) is accepted and queued to the
  open. The reconciler reads "no fill, account unchanged", drops it and sends again, every
  round until the open fills them all (+110 lots simulated from a 5-lot target). So entries go
  only inside the regular session; closes are not gated (a stop must work, the broker caps an
  over-close with 9868).
- A machine clock minutes fast computes and sends in the pre-open believing the market open.
  The skew is measured off every Blave api reply's Date header (lib/data._retry_get); past
  SKEW_BLOCK_S, entries wait and the reconciler says so (P1 order_errors row). Fixed clock,
  entries resume on their own.

No samples (no Blave data access, or none for SAMPLE_MAX_AGE_S) means not known: the machine's
own clock is used and nothing is blocked. Holidays are not known here; the broker refuses those.
"""
import json
import os
import time
from datetime import datetime, timedelta, timezone

try:
    from lib.winreplace import load_json
except ImportError:  # half-updated workspace (lib/winreplace.py without load_json): no read retry
    def load_json(path, **open_kw):
        with open(path, **open_kw) as f:
            return json.load(f)

TAIPEI = timezone(timedelta(hours=8))
SKEW_PATH = 'state/clock_skew.json'  # every reader and writer runs with cwd = the workspace (lib/guard)
SKEW_BLOCK_S = 60     # past this a 1m strategy stops computing anyway (simulated 60–90 s)
SAMPLE_EVERY_S = 30   # per process: one write per this, not one per request
SAMPLE_MAX_AGE_S = 6 * 3600
SAMPLE_MAX_RTT_S = 10
SKEW_MAX_S = 3600     # past this the Date is wrong, not this clock (one source only, no cross-check): dropped
KEEP = 3              # median of the newest 3: once there are 3, one odd reply neither blocks nor resumes
OPEN_MARGIN_S = 5     # the opening auction and a skew estimate good to a second or two
DAY = ((8, 45), (13, 45))
NIGHT = ((15, 0), (5, 0))

_last_write = 0.0


def note_reply(resp, t0, t1):
    """One skew sample from a Blave api reply (requests.Response) between t0 and t1 (time.time()).
    Never raises: a missing header or an unwritable file only loses the sample."""
    global _last_write
    try:
        if t1 - t0 > SAMPLE_MAX_RTT_S or t1 - _last_write < SAMPLE_EVERY_S:
            return
        from email.utils import parsedate_to_datetime
        date = (getattr(resp, 'headers', None) or {}).get('Date')
        if not date or not os.path.isdir(os.path.dirname(SKEW_PATH)):
            return  # no header, or not run from a workspace
        server = parsedate_to_datetime(date).timestamp() + 0.5   # whole seconds, floored
        try:
            server += float(resp.headers.get('Age') or 0)
        except (TypeError, ValueError):
            pass
        sample = round((t0 + t1) / 2 - server, 1)
        if abs(sample) > SKEW_MAX_S:
            return
        _last_write = t1
        rows = [r for r in _samples() if t1 - r[0] < SAMPLE_MAX_AGE_S]
        rows.append([round(t1, 3), sample])
        tmp = f'{SKEW_PATH}.{os.getpid()}.tmp'
        with open(tmp, 'w') as f:
            json.dump({'samples': rows[-KEEP:]}, f)
        try:
            from lib.winreplace import atomic_replace
        except ImportError:
            atomic_replace = os.replace
        atomic_replace(tmp, SKEW_PATH)
    except Exception:
        pass


def _samples():
    try:
        rows = load_json(SKEW_PATH).get('samples') or []
        return [[float(a), float(s)] for a, s in rows]
    except Exception:
        return []


def skew(now=None):
    """Seconds this machine's clock is ahead of the api's (negative = behind); None = not known."""
    now = time.time() if now is None else now
    rows = [s for a, s in _samples() if now - a < SAMPLE_MAX_AGE_S][-KEEP:]
    if not rows:
        return None
    rows.sort()
    n = len(rows)
    return rows[n // 2] if n % 2 else (rows[n // 2 - 1] + rows[n // 2]) / 2


def corrected(now=None):
    """time.time() less the measured skew (the machine's own when not known)."""
    now = time.time() if now is None else now
    s = skew(now)
    return now - s if s is not None else now


def _at(d, hm):
    return datetime(d.year, d.month, d.day, hm[0], hm[1], tzinfo=TAIPEI).timestamp()


def in_session(ts):
    """`ts` (epoch, already corrected) inside the TAIFEX index-futures regular session, past the
    open by OPEN_MARGIN_S: day 08:45–13:45 Mon–Fri, night 15:00–05:00 opening Mon–Fri."""
    t = datetime.fromtimestamp(ts, TAIPEI)
    d, wd = t.date(), t.weekday()
    if wd <= 4 and _at(d, DAY[0]) + OPEN_MARGIN_S <= ts < _at(d, DAY[1]):
        return True
    if wd <= 4 and ts >= _at(d, NIGHT[0]) + OPEN_MARGIN_S:
        return True
    return 1 <= wd <= 5 and ts < _at(d, NIGHT[1])


def next_open(ts):
    """The first epoch after `ts` when in_session turns true (holidays not known)."""
    d = datetime.fromtimestamp(ts, TAIPEI).date()
    for i in range(8):
        day = d + timedelta(days=i)
        if day.weekday() > 4:
            continue
        for hm in (DAY[0], NIGHT[0]):
            at = _at(day, hm) + OPEN_MARGIN_S
            if at > ts:
                return at
    return ts + 86400


def entry_hold(now=None):
    """None = a TW futures entry may go now. Else {'why': 'clock', 'skew': s} (the clock is off
    past SKEW_BLOCK_S) or {'why': 'session', 'until': machine epoch of the next open}."""
    now = time.time() if now is None else now
    s = skew(now)
    if s is not None and abs(s) > SKEW_BLOCK_S:
        return {'why': 'clock', 'skew': s}
    real = now - (s or 0)
    if in_session(real):
        return None
    return {'why': 'session', 'until': next_open(real) + (s or 0)}


def queued_until(now=None):
    """An order sent now outside the regular session (corrected clock) may sit queued at the
    broker to the open: the machine epoch of that open. None when in session."""
    now = time.time() if now is None else now
    s = skew(now) or 0
    real = now - s
    return None if in_session(real) else next_open(real) + s


def skew_words(s):
    """快了約 4 分鐘 / 慢了約 90 秒 — for the user-facing line."""
    a = abs(s)
    amount = f"{round(a / 60)} 分鐘" if a >= 120 else f"{round(a)} 秒"
    return f"{'快' if s > 0 else '慢'}了約 {amount}"
