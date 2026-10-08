"""統一期貨 1-minute bars for the live tick: the worker's quote thread polls
`get_history_bardata("1K")` on the TXF series contract and writes
state/president_bars_TXF_1m.json — a one-way snapshot (same shape of contract
as president_account.json) that lib/data.fetch_twfutures_ohlcv only reads to
extend the Blave cache past its last bar on a 統一-bound desktop. TXF only:
MXF / TMF strategies read the TXF series like their backtests (lib/data
aliases them), and every root polled is one more HTTP call per round against
an unmeasured server cap shared with the account reads.

Pure functions plus one loop; no login, no credentials (the worker hands over
its logged-in Unitrade). Cache convention it converts to (references/twfutures.md,
measured 10-08 on the live account):
- the broker labels a bar by its START minute, the Blave cache by its END →
  +1 minute (BAR_LABEL_OFFSET_MIN); `date`/`time` are Taipei wall clock, the
  night session's `date` is the calendar day; rows are converted by absolute
  time, never by trading day;
- the broker adds a closing-match bar (day 13:45:00, night 05:00:00) the cache
  has no room for: the cache's day session ends with the 13:45 END label (start
  13:44), the night session with 05:00 — anything starting in [13:45, 15:00) or
  [05:00, 08:45) is dropped; on the contract's own settlement day the series
  ends with the 13:30 bar (no 13:31–14:59), so there [13:30, 15:00) goes too;
- a contract contributes only the bars from the moment it became the series
  month (president_contracts.series_roll_at of the month before: 15:00 on that
  settlement day) — after the roll the new month's own 08:45–13:44 of
  settlement day is never fetched into the series;
- the broker does not return the forming minute (verified); a bar whose END
  label is still ahead of the clock is dropped anyway;
- volume stays as the broker gives it: ~0.6 % above the cache (spread legs,
  presumably) — accepted (口徑 A), documented in references/president-broker.md.

1K answers at most 100 bars and a span of at most 100 minutes per call; a
closed-market span answers ok=False 查無資料, which is an empty page here.
Polls run in the trading sessions only (08:40–13:50, 14:55–05:05 Taipei,
Mon–Fri plus the Friday night's early hours); outside them, and inside the
worker's maintenance windows, the snapshot is re-stamped with `paused` so a
tick reads "market closed", not "feed stale".
"""
import json
import os
import time
from datetime import datetime, time as dtime, timedelta

try:
    import president_contracts as pc  # run as a script: lib/ is sys.path[0]
    import president_vault
except ImportError:
    from lib import president_contracts as pc, president_vault

try:
    from unitrade.core.error import Error as _SdkError
    _MSG_NOT_ENABLED = _SdkError.MSG011  # what every dquote call answers when auth_dquote is off
except Exception:  # noqa: BLE001 — tests / machines without the SDK
    _MSG_NOT_ENABLED = None

WORKSPACE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE = os.path.join(WORKSPACE, "state")
TAIPEI = pc.TAIPEI
ROOTS = ("TXF",)

BAR_LABEL_OFFSET_MIN = 1      # broker START label → cache END label
PAGE_MIN = 100                # unitrade 1.0.0.7: a non-"D" span over 100 minutes is refused
PAGE_COUNT = 100              # and count over 100
KEEP_DAYS = 2                 # rolling window, calendar days
EMPTY_PAGES_STOP = 4          # ~6.7 h of nothing = a weekend / holiday, not a session gap
MAX_PAGES = 40                # hard cap per poll (40 × 100 min > KEEP_DAYS)
POLL_S = 12
PAGE_GAP_S = 0.2
NOT_ENABLED = "QUOTE_NOT_ENABLED"
_NO_DATA = "查無資料"

_DAY_CUT = (13, 45)           # closing match starts here; the cache's last day label is 13:45
_SETTLE_CUT = (13, 30)        # settlement day: the expiring month's last series bar
_NIGHT_OPEN = (15, 0)
_NIGHT_CUT = (5, 0)
_DAY_OPEN = (8, 45)
SESSIONS = (                  # polling windows (Taipei); a few minutes around each session
    (dtime(8, 40), dtime(13, 50)),
    (dtime(14, 55), dtime(23, 59, 59, 999999)),
    (dtime(0, 0), dtime(5, 5)),
)


def _log(msg):
    print(f"[president_quote] {msg}", flush=True)


def _sanitize(text):
    return president_vault.sanitize(str(text))


def snapshot_path(root):
    return os.path.join(STATE, f"president_bars_{root}_1m.json")


def _atomic_write(path, payload):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    os.replace(path + ".tmp", path)


def read_snapshot(root):
    try:
        with open(snapshot_path(root), encoding="utf-8") as f:
            snap = json.load(f)
    except (OSError, ValueError):
        return None
    return snap if isinstance(snap, dict) else None


def in_session(now=None):
    """True inside a polling window: weekday day / night sessions and the early
    hours that end a weekday's night session (Saturday 00:00–05:05 included,
    Monday's not). Holidays are not known here — a closed day only costs empty pages."""
    now = (now or datetime.now(TAIPEI)).astimezone(TAIPEI)
    t, wd = now.time(), now.weekday()
    for i, (start, end) in enumerate(SESSIONS):
        if start <= t <= end:
            return wd < 5 if i < 2 else 1 <= wd <= 5
    return False


def bar_start(bar):
    """A BarData's `date` 'YYYYMMDD' + `time` 'HHMMSS' → aware Taipei datetime
    of the minute it STARTS; None when unreadable."""
    d, t = str(getattr(bar, "date", "") or "").strip(), str(getattr(bar, "time", "") or "").strip()
    if t.isdigit() and len(t) < 6:
        t = t.zfill(6)
    if not (len(d) == 8 and d.isdigit() and len(t) == 6 and t.isdigit()):
        return None
    try:
        return datetime.strptime(d + t, "%Y%m%d%H%M%S").replace(tzinfo=TAIPEI)
    except ValueError:
        return None


def _in_gap(start, settle_day):
    """True for a bar the cache has no room for (module doc)."""
    hm = (start.hour, start.minute)
    if _NIGHT_CUT <= hm < _DAY_OPEN:
        return True
    cut = _SETTLE_CUT if start.date() == settle_day else _DAY_CUT
    return cut <= hm < _NIGHT_OPEN


def series_span(productid):
    """[from, to): the aware Taipei span in which `productid` is the series contract."""
    y, m = pc.month_of(productid)
    py, pm = (y - 1, 12) if m == 1 else (y, m - 1)
    return pc.series_roll_at(py, pm), pc.series_roll_at(y, m)


def to_cache_rows(bars, productid, now=None):
    """BarData list → sorted [ts_epoch_utc, o, h, l, c, v] rows in the cache
    convention (END label, +1 min): the closing-match bars, anything outside the
    contract's series span and a bar not closed by `now` dropped."""
    now = now or datetime.now(TAIPEI)
    settle_day = pc.settlement_at(*pc.month_of(productid)).date()
    span_from, span_to = series_span(productid)
    rows = {}
    for b in bars or []:
        start = bar_start(b)
        if start is None or not (span_from <= start < span_to) or _in_gap(start, settle_day):
            continue
        end = start + timedelta(minutes=BAR_LABEL_OFFSET_MIN)
        if end > now:
            continue
        ts = int(end.timestamp())
        try:
            rows[ts] = [ts, float(b.open), float(b.high), float(b.low), float(b.close), int(b.volume or 0)]
        except (TypeError, ValueError, AttributeError):
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


def quote_enabled(api):
    """auth_dquote of this login; None when the SDK object has no such field."""
    us = getattr(api, "_usersettings", None)
    v = getattr(us, "auth_dquote", None)
    return None if v is None else bool(v)


class QuoteNotEnabled(RuntimeError):
    """The SDK's answer to every dquote call while auth_dquote is off (MSG011)."""


def fetch_pages(api, productid, start, end, log=_log):
    """1K bars for [start, end] (aware datetimes), newest page first, walking
    back 100 minutes at a time; stops early after EMPTY_PAGES_STOP empty pages in
    a row. Returns (bars, paged_back_to, error): error is the first non-empty
    failure (the walk stops there), paged_back_to the earliest page start reached.
    Raises QuoteNotEnabled on the SDK's not-enabled answer."""
    bars, empty_run, pages = [], 0, 0
    page_end, reached, error = end, end, None
    while page_end > start and pages < MAX_PAGES:
        page_start = max(start, page_end - timedelta(minutes=PAGE_MIN))
        r = api.dquote.get_history_bardata("1K", page_start, page_end, "1", productid, PAGE_COUNT)
        pages += 1
        reached = page_start
        if r is None or not getattr(r, "ok", False):
            err = str(getattr(r, "error", "") or "no answer")
            if _MSG_NOT_ENABLED is not None and err == str(_MSG_NOT_ENABLED):
                raise QuoteNotEnabled(err)
            if _NO_DATA not in err:
                error = _sanitize(err)
                break
            data = []
        else:
            data = list(getattr(r, "data", None) or [])
        if data:
            bars.extend(data)
            empty_run = 0
        else:
            empty_run += 1
            if empty_run >= EMPTY_PAGES_STOP:
                break
        page_end = page_start
        if page_end > start:
            time.sleep(PAGE_GAP_S)
    return bars, reached, error


def poll_root(api, root, now=None):
    """One poll of one root → the snapshot dict written to snapshot_path(root).
    Never raises: a failure lands in `ok`/`error` next to whatever rows the last
    good poll left (data.py reads only a fresh `ok` snapshot)."""
    now = now or datetime.now(TAIPEI)
    now_epoch = int(now.timestamp())
    prev = read_snapshot(root) or {}
    snap = {"root": root, "productid": None, "label": "end", "poll_s": POLL_S,
            "written_at": now_epoch, "ok": False, "error": None,
            "earliest": None, "latest": None, "paged_back_to": prev.get("paged_back_to"),
            "rows": merge_rows(prev.get("rows"), [], now_epoch)}
    try:
        pid = pc.series_contract(root, now)
        snap["productid"] = pid
        if quote_enabled(api) is False:
            snap["error"] = NOT_ENABLED
        else:
            # a minute before the span's start: whether the broker's page start is inclusive is
            # unverified (E1), and to_cache_rows drops anything before the span anyway
            since = max(now - timedelta(days=KEEP_DAYS), series_span(pid)[0] - timedelta(minutes=1))
            if snap["rows"] and prev.get("productid") == pid:
                # steady state: re-ask from the last row's START minute (overlap of one bar)
                since = max(since, datetime.fromtimestamp(snap["rows"][-1][0], TAIPEI)
                            - timedelta(minutes=BAR_LABEL_OFFSET_MIN + 1))
            bars, reached, error = fetch_pages(api, pid, since, now)
            snap["rows"] = merge_rows(snap["rows"], to_cache_rows(bars, pid, now), now_epoch)
            if not snap["rows"] or snap.get("paged_back_to") is None or reached.timestamp() < snap["paged_back_to"]:
                snap["paged_back_to"] = int(reached.timestamp())
            snap["ok"] = error is None
            snap["error"] = error
    except QuoteNotEnabled:
        snap["error"] = NOT_ENABLED
    except Exception as e:  # noqa: BLE001 — the quote thread never takes the worker down
        snap["ok"], snap["error"] = False, _sanitize(f"{type(e).__name__}: {e}")
    if snap["rows"]:
        snap["earliest"], snap["latest"] = snap["rows"][0][0], snap["rows"][-1][0]
    snap["written_at"] = int(time.time())
    try:
        _atomic_write(snapshot_path(root), snap)
    except OSError as e:
        _log(f"{root}: snapshot write failed: {type(e).__name__}")
    return snap


def pause_root(root, reason):
    """Market closed / broker maintenance: re-stamp the last snapshot (rows, ok and
    error kept) with `paused` so the reader tells "no session" from "feed stale"."""
    snap = read_snapshot(root) or {"root": root, "productid": None, "ok": False, "error": None,
                                   "earliest": None, "latest": None, "paged_back_to": None, "rows": []}
    snap["paused"] = reason
    snap["written_at"] = int(time.time())
    try:
        _atomic_write(snapshot_path(root), snap)
    except OSError as e:
        _log(f"{root}: snapshot write failed: {type(e).__name__}")
    return snap


def poll_once(api, now=None, roots=ROOTS):
    return {root: poll_root(api, root, now) for root in roots}


def loop(holder, pause=None, stop=None, roots=ROOTS):
    """Thread body: poll every POLL_S while holder["api"] is a logged-in Unitrade
    and a session is on. `pause()` truthy (the worker's maintenance window) or
    no session → pause_root instead; `stop()` truthy ends the loop.
    holder["api"] = None (logged out) just waits."""
    last_said = None
    while not (stop and stop()):
        api = holder.get("api")
        if api is not None:
            try:
                paused = (pause() if pause else None) or (None if in_session() else "closed")
                if paused:
                    for root in roots:
                        pause_root(root, str(paused))
                    said = f"paused ({paused})"
                else:
                    snaps = poll_once(api, roots=roots)
                    errs = {r: s.get("error") for r, s in snaps.items() if not s.get("ok")}
                    said = "poll ok" if not errs else f"poll errors {errs}"
                if said != last_said:
                    _log(said)
                    last_said = said
            except Exception as e:  # noqa: BLE001
                _log(f"poll failed: {_sanitize(f'{type(e).__name__}: {e}')}")
        for _ in range(POLL_S):
            if stop and stop():
                return
            time.sleep(1)
