"""When a Taiwan futures order may go out: the TAIFEX hours, read on a clock checked against the
Blave api's.

Holes it closes (.claude/output/backend/president-retry-2026-11-04.md, …-post-close-orders-2026-11-10.md):
- A market IOC sent in the pre-open (14:50–15:00, 08:30–08:45) is accepted and queued to the
  open. The reconciler reads "no fill, account unchanged", drops it and sends again, every
  round until the open fills them all (+110 lots simulated from a 5-lot target). So entries go
  only inside the regular session (entry_hold).
- A close after the close (13:45–14:50, 05:00–08:30, weekends) is refused by the broker (統一
  9901 / 9876), sent again every round, each send its own 統一 login — and a failed login stops
  every later order, the next open's stops included. So closes wait for the pre-open
  (close_hold), where the broker takes them and queues them to the open: the market is shut
  meanwhile, so the wait adds no risk. A pre-open close goes, as before.
- A machine clock minutes fast computes and sends in the pre-open believing the market open.
  The skew is measured off every Blave api reply's Date header (lib/data._retry_get); past
  SKEW_BLOCK_S, entries wait and the reconciler says so (P1 order_errors row). Fixed clock,
  entries resume on their own. Closes read the measured skew at any size.

No samples (none for SAMPLE_MAX_AGE_S), or fewer than KEEP that disagree, means not known — a gate about
to act on that first asks once (probe, PROBE_EVERY_S apart); still none: the machine's
own clock is used. Entries then gate on it as is; closes (close_hold, the order lib's window,
close-all's deferral) only once CLOSE_UNVERIFIED_S past each close — a stop near 13:45 on a clock
that may be fast still goes — and a weekend still waits. Not resent every round after hours (each
send a 統一 login, refused 9876); the reconciler says once that it holds closes on an unchecked
clock (Wei).
A skew past SKEW_MAX_S is kept as a sample but not trusted for correction (skew() says not
known): closes as with no samples, entries held for the clock, the P1 row says both (gross_skew).
Holidays are not known here; the broker refuses those.
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
SKEW_MAX_S = 3600     # past this the Date may be wrong, not this clock (one source only): not used to correct
KEEP = 3              # median of the newest 3: once there are 3, one odd reply neither blocks nor resumes
OPEN_MARGIN_S = 5     # the opening auction and a skew estimate good to a second or two
DAY = ((8, 45), (13, 45))
NIGHT = ((15, 0), (5, 0))
PRE_OPEN = ((8, 30), (14, 50))   # the broker takes orders from here (queued to the open)
PRE_OPEN_MARGIN_S = 60  # a send a second early is refused 9902 (P1), and 08:30:00 is the worker's login
CLOSE_UNVERIFIED_S = 15 * 60  # no samples: a close still goes this long past a close (= the 統一 login window)
PROBE_PATH = '/fx_rates'  # public (no key, so a desktop without data access samples too), Redis only
PROBE_EVERY_S = 180       # per process: at most one on-demand round per this
PROBE_CONNECT_S = 3       # of SAMPLE_MAX_RTT_S: the rest is the read

probe_enabled = False     # set by the resident entry points (manager/reconciler, manager/flatten), never by an import
_last_write = 0.0
_last_probe = 0.0
_confirmed_at = None  # the lone sample probe last confirmed (once each, past PROBE_EVERY_S)


def note_reply(resp, t0, t1):
    """One skew sample from a Blave api reply (requests.Response) between t0 and t1 (time.time()).
    Never raises: a missing header or an unwritable file only loses the sample. True = written."""
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
        return True
    except Exception:
        return False


def _samples():
    try:
        rows = load_json(SKEW_PATH).get('samples') or []
        return [[float(a), float(s)] for a, s in rows]
    except Exception:
        return []


def _rows(now):
    return [r for r in _samples() if now - r[0] < SAMPLE_MAX_AGE_S][-KEEP:]


def _median(now):
    """(median of the newest KEEP samples, how many); (None, n) = none, fewer than KEEP that
    disagree past SKEW_BLOCK_S (one may be a bad Date, and their mean an hour off), or KEEP of
    which no two agree within it (the median decides nothing — Wei)."""
    rows = sorted(s for _, s in _rows(now))
    n = len(rows)
    if not rows or (n < KEEP and rows[-1] - rows[0] > SKEW_BLOCK_S):
        return None, n
    if n >= KEEP and all(b - a > SKEW_BLOCK_S for a, b in zip(rows, rows[1:])):
        return None, n
    return (rows[n // 2] if n % 2 else (rows[n // 2 - 1] + rows[n // 2]) / 2), n


def gross_skew(now=None):
    """The median of the newest KEEP samples at any size; None = not measured. Fewer than KEEP
    count when they agree within SKEW_BLOCK_S, except: past SKEW_MAX_S (a Date hours off is more
    likely the Date: said only once KEEP agree), and a lone sample past SKEW_BLOCK_S (it would move
    closes: confirmed first by a second reply, probe — Wei). entry_hold reads _median and holds on
    either; every correction reads skew()."""
    med, n = _median(time.time() if now is None else now)
    if med is None or (n < KEEP and abs(med) > SKEW_MAX_S) or (n == 1 and abs(med) > SKEW_BLOCK_S):
        return None
    return med


def _unconfirmed(now):
    """The time of a lone sample past SKEW_BLOCK_S (the one probe confirms), else None."""
    rows = _rows(now)
    return rows[0][0] if len(rows) == 1 and SKEW_BLOCK_S < abs(rows[0][1]) <= SKEW_MAX_S else None


def probe():
    """On-demand samples, for a gate about to act on an unmeasured clock: GETs of the api's public
    PROBE_PATH through note_reply. At most one round per PROBE_EVERY_S, and only where
    probe_enabled (a test importing this never reaches the network). Within a round it asks again,
    up to KEEP replies, while the samples there are do not measure: replies hours off that agree
    (so far is said this round, not after KEEP rounds), a lone one past SKEW_BLOCK_S (confirmed
    before it moves a close), two that disagree (a third decides, if two of the three agree). A lone
    sample is confirmed once even inside PROBE_EVERY_S. True = a sample was written (a reply too slow
    to be one, or without a Date, is not)."""
    global _last_probe, _last_write, _confirmed_at
    if not probe_enabled:
        return False
    t = time.time()
    lone = _unconfirmed(t)
    if t - _last_probe < PROBE_EVERY_S and (lone is None or lone == _confirmed_at):
        return False
    _last_probe = t
    if lone is not None:
        _confirmed_at = lone
    noted = False
    try:
        import requests
        base = os.environ.get('BLAVE_API_BASE', 'https://api.blave.org')
        for _ in range(KEEP):
            t0 = time.time()
            # connect + read within SAMPLE_MAX_RTT_S: a slower reply is not a sample anyway (DNS not
            # bounded); no-cache: a cache between would hand back the same Date, read as replies that agree
            r = requests.get(base + PROBE_PATH, headers={'Cache-Control': 'no-cache'},
                             timeout=(PROBE_CONNECT_S, SAMPLE_MAX_RTT_S - PROBE_CONNECT_S))
            _last_write = 0.0  # this sample is the point of the request
            if not note_reply(r, t0, time.time()):
                break  # no sample from it: asking again in this round would not differ
            noted = True
            if gross_skew() is not None or not _rows(time.time()):
                break
    except Exception:
        pass
    return noted


def skew(now=None):
    """Seconds this machine's clock is ahead of the api's (negative = behind); None = not known
    (no samples, or past SKEW_MAX_S)."""
    s = gross_skew(now)
    return s if s is not None and abs(s) <= SKEW_MAX_S else None


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


def _accepts_close(ts, slack):
    """`ts` (epoch) between a pre-open (+PRE_OPEN_MARGIN_S) and its session's close (+slack)."""
    if in_session(ts):
        return True
    t = datetime.fromtimestamp(ts, TAIPEI)
    d, wd = t.date(), t.weekday()
    if wd <= 4 and _at(d, PRE_OPEN[0]) + PRE_OPEN_MARGIN_S <= ts < _at(d, DAY[1]) + slack:
        return True
    if wd <= 4 and ts >= _at(d, PRE_OPEN[1]) + PRE_OPEN_MARGIN_S:
        return True
    return 1 <= wd <= 5 and ts < _at(d, NIGHT[1]) + slack


def next_pre_open(ts):
    """The first epoch after `ts` when _accepts_close turns true (holidays not known)."""
    d = datetime.fromtimestamp(ts, TAIPEI).date()
    for i in range(8):
        day = d + timedelta(days=i)
        if day.weekday() > 4:
            continue
        for hm in PRE_OPEN:
            at = _at(day, hm) + PRE_OPEN_MARGIN_S
            if at > ts:
                return at
    return ts + 86400


def close_hold(now=None):
    """None = a TW futures close may go now. Else {'why': 'session', 'until': machine epoch of
    the next pre-open} — the broker takes no order till then. Not measured: the machine's clock,
    CLOSE_UNVERIFIED_S of slack past each close."""
    now = time.time() if now is None else now
    s = skew(now)
    real = now - (s or 0)
    if _accepts_close(real, 0 if s is not None else CLOSE_UNVERIFIED_S):
        return None
    return {'why': 'session', 'until': next_pre_open(real) + (s or 0)}


def entry_hold(now=None):
    """None = a TW futures entry may go now. Else {'why': 'clock', 'skew': s} (the clock is off
    past SKEW_BLOCK_S) or {'why': 'session', 'until': machine epoch of the next open}."""
    now = time.time() if now is None else now
    g = gross_skew(now)
    if g is None:
        # not measured, yet every newest sample (up to KEEP) off past SKEW_BLOCK_S the same way: no
        # entry on it, said nothing (Wei) — a lone or unconfirmed one, 1–2 hours off, three that
        # disagree by more than SKEW_BLOCK_S. Mixed signs: not held
        raw = sorted(x for _, x in _rows(now))
        if raw and (raw[0] > SKEW_BLOCK_S or raw[-1] < -SKEW_BLOCK_S):
            g = raw[len(raw) // 2]
    if g is not None and abs(g) > SKEW_BLOCK_S:
        return {'why': 'clock', 'skew': g}
    s = skew(now)
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
    """快了約 4 分鐘 / 慢了約 90 秒 / 快了約 3 小時 — for the user-facing line."""
    a = abs(s)
    amount = f"{round(a / 3600)} 小時" if a >= 2 * 3600 else f"{round(a / 60)} 分鐘" if a >= 120 else f"{round(a)} 秒"
    return f"{'快' if s > 0 else '慢'}了約 {amount}"
