import os
import io
import csv
import json
import shutil
import numbers
import time
import threading
import logging
import requests
import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
from datetime import datetime, timedelta, timezone, date as _date
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
try:
    from lib.progress import Progress
except ImportError:  # half-updated workspace (lib/progress.py not copied yet) — fail open, no progress lines
    class Progress:
        def __init__(self, *a, **k): pass
        def tick(self, n=1): pass


class _RateLimiter:
    """Token bucket: allows max_calls requests per period seconds."""
    def __init__(self, max_calls, period):
        self._max   = max_calls
        self._period = period
        self._calls  = []
        self._lock   = threading.Lock()

    def acquire(self):
        with self._lock:
            now = time.time()
            self._calls = [t for t in self._calls if now - t < self._period]
            if len(self._calls) >= self._max:
                wait = self._period - (now - self._calls[0])
                if wait > 0:
                    time.sleep(wait)
                    now = time.time()
                    self._calls = [t for t in self._calls if now - t < self._period]
            self._calls.append(time.time())

# Overridable so the desktop build (free software, user's own machine) can point
# the whole lib somewhere else. Unset on every fleet machine → unchanged.
BASE      = os.environ.get('BLAVE_API_BASE', 'https://api.blave.org')
_CACHE_DIR = Path(__file__).parent.parent / 'cache'


def _kline_source():
    """'blave' (default) or 'binance' — where fetch_kline gets its bars.

    Read per call rather than at import so a shell that exports it after this
    module is loaded still takes effect. Opt-in by design: an unset variable is
    the fleet's behaviour, byte for byte.
    """
    return os.environ.get('BLAVE_KLINE_SOURCE', 'blave').strip().lower()


class DataAccessError(RuntimeError):
    """No Blave data access this turn (BLAVE_DATA_ACCESS=0, or a scheduled desktop run whose `.env`
    holds no working key). Its own type so a caller with a
    public fallback (the report templates) can tell it from a fetch that failed."""


def _check_data_access(headers=None):
    """Desktop shell sets BLAVE_DATA_ACCESS=0 when it withheld the Blave key this turn
    (no balance for the hourly fee / not signed in). Failing here, before any request,
    is what stops the agent from hunting for credentials after a low-level error —
    a KeyError or 403 reads as a bug to fix, this reads as a fact. Unset or 1: no-op, except
    that a scheduled desktop run with no key in `headers` fails the same way (_check_desktop_key)."""
    if os.environ.get('BLAVE_DATA_ACCESS') == '0':
        raise DataAccessError(_NO_ACCESS_MSG)
    if headers is not None:
        _check_desktop_key(headers)


_NO_ACCESS_MSG = ('Blave data is not reachable on this desktop this turn (no balance for the '
                  'hourly fee / not signed in); stop here, do not look for credentials in .env, '
                  'the environment or elsewhere, and answer the user with what public klines allow.')


def _daemon_on_desktop():
    """A scheduled report job on the desktop: report_runner marks it BLAVE_SCHEDULED_RUN=1 next
    to BLAVE_AGENT_LOCAL=1. Not inferred from BLAVE_DATA_ACCESS being absent — the shell leaves
    that unset on a chat turn too when the user put their own key in `.env`."""
    return os.environ.get('BLAVE_AGENT_LOCAL') == '1' and os.environ.get('BLAVE_SCHEDULED_RUN') == '1'


def _check_desktop_key(headers):
    """On the desktop the shell keeps workspace `.env` in step with the account — the Blave
    key is there only while the account has data access — so an empty key is that state
    file saying "no access", not a bug to chase. Scheduled runs have no per-turn flag and
    read it here; nothing is sent."""
    if _daemon_on_desktop() and not (headers or {}).get('api-key'):
        raise DataAccessError(_NO_ACCESS_MSG)


def _desktop_denied(r):
    """Scheduled run on the desktop: the key in `.env` stopped working since the shell last
    synced it (hour fee not chargeable ERR007, key revoked ERR005, 401). Same meaning as an
    empty key. A chat turn keeps the raw 403 — its body carries what the user must be told."""
    if not _daemon_on_desktop():
        return
    if r.status_code == 401 or (r.status_code == 403 and any(c in r.text for c in ('ERR007', 'ERR005'))):
        raise DataAccessError(_NO_ACCESS_MSG)


def _retry_get(url, max_retries=6, **kwargs):
    """GET with exponential backoff on transient failures (2, 4, 8, 16, 32, 64 s).

    Retries 429 (Blave per-IP rate limit, 500/5min), 5xx (incl. 503, which the
    API returns when upstream FinMind itself rate-limits), and connection/read
    timeouts (a slow batch endpoint under load — e.g. a big multi-symbol crypto
    kline request — reads exactly like this; previously an unlucky timeout just
    silently dropped that whole chunk's symbols with no retry). 403 is NOT
    retried — the API returns it only for a missing/invalid api-key, a permanent
    error that backing off would just delay surfacing.

    A non-retried 4xx raises requests.HTTPError with the response body appended
    (truncated to 200 chars) — the 4xx bodies carry the only explanation there is.
    """
    blave = url.startswith(BASE)   # BingX klines share this helper and stay public
    if blave:
        _check_data_access(kwargs.get('headers') or {})
    for attempt in range(max_retries):
        try:
            r = requests.get(url, **kwargs)
        except (requests.exceptions.Timeout, requests.exceptions.ConnectionError) as e:
            if attempt == max_retries - 1:
                raise
            wait = 2 ** (attempt + 1)
            print(f"  {type(e).__name__} transient — retrying in {wait}s ({url.split('/')[-2]}/{url.split('/')[-1]})")
            time.sleep(wait)
            continue
        if r.status_code != 429 and r.status_code < 500:
            if blave:
                _desktop_denied(r)
            try:
                r.raise_for_status()
            except requests.HTTPError as exc:
                # raise_for_status()'s message is status + URL only. The API puts the
                # reason in the body ("start must not be after end", "Invalid start
                # date, expected YYYY-MM-DD"), and a strategy author who never sees it
                # cannot tell a bad argument from a broken endpoint. Same type and
                # .response as before so the callers switching on status still work.
                raise requests.HTTPError(f'{exc} — {r.text[:200]}', response=r) from exc
            return r
        wait = 2 ** (attempt + 1)
        print(f"  {r.status_code} transient — retrying in {wait}s ({url.split('/')[-2]}/{url.split('/')[-1]})")
        time.sleep(wait)
    r.raise_for_status()
    return r


def _monthly_cache_dir(prefix, params):
    """cache/{prefix}_{param_str}/  — parent dir for monthly parquet files."""
    param_str = '_'.join(str(v) for _, v in sorted(params.items()))
    return _CACHE_DIR / f'{prefix}_{param_str}'


def _next_month(ym):
    """'2022-01' → '2022-02', '2022-12' → '2023-01'"""
    y, m = int(ym[:4]), int(ym[5:7])
    return f'{y+1}-01' if m == 12 else f'{y}-{m+1:02d}'


def _iter_months(start_str, end_str):
    """Yield 'YYYY-MM' strings from start month to end month (inclusive)."""
    ym, end_ym = start_str[:7], end_str[:7]
    while ym <= end_ym:
        yield ym
        ym = _next_month(ym)


def _contiguous_spans(months):
    """Group a sorted list of 'YYYY-MM' into runs of consecutive months.
    ['2022-01','2022-02','2022-05'] → [['2022-01','2022-02'], ['2022-05']]."""
    spans, cur = [], []
    for ym in months:
        if cur and _next_month(cur[-1]) == ym:
            cur.append(ym)
        else:
            if cur:
                spans.append(cur)
            cur = [ym]
    if cur:
        spans.append(cur)
    return spans


def _normalise_index(df):
    """Convert tz-aware index to tz-naive UTC in-place-safe copy."""
    if df.index.tz is not None:
        df = df.copy()
        df.index = df.index.tz_convert('UTC').tz_localize(None)
    return df


def _month_end_utc(ym):
    """Naive-UTC datetime of the first instant AFTER month `ym` ('YYYY-MM')."""
    nxt = _next_month(ym)
    return datetime(int(nxt[:4]), int(nxt[5:7]), 1)


def _written_before_month_end(path, ym):
    """True if `path` was last written before month `ym` was over (UTC).

    A past-month file written while that month was still the current month may
    be missing its tail (the delta-update path stops running once the month
    rolls over), so it needs one completing re-fetch. After that re-fetch the
    file's mtime is later than the month end and this never triggers again.
    An unstatable file counts as incomplete → re-fetch.
    """
    try:
        return datetime.utcfromtimestamp(path.stat().st_mtime) < _month_end_utc(ym)
    except Exception:
        return True


_HEAD_VERIFIED_META = {b'blave_head_verified': b'1'}
_HEAD_TOLERANCE = timedelta(hours=1)


def _head_short_unverified(path, ym):
    """True if past month `path` starts more than _HEAD_TOLERANCE after the month
    begins and has never been re-fetched to confirm that — one completing
    re-fetch, then the footer flag _HEAD_VERIFIED_META stops it recurring.

    Why: an earlier lib clamped sub-5min fetch ranges to a 45-day floor, so a
    month straddling that floor was cached from the clamp date onward (real
    incident: 2026-07 stored as 07-10 → 07-31, nine days missing) — and the
    mtime rule above then treats it as complete forever, so a later two-year
    backtest inherits the hole. A listing month is legitimately head-short;
    it re-fetches once, gets the flag, and is never re-fetched again.
    Footer-only schema read first (cheap), index read only when unflagged.
    """
    try:
        schema = pq.read_schema(path)
        if not schema.names or (schema.metadata or {}).get(b'blave_head_verified'):
            return False                  # empty marker, or already verified
        idx = pd.to_datetime(pd.read_parquet(path, columns=[]).index)
        if getattr(idx, 'tz', None) is not None:
            idx = idx.tz_convert('UTC').tz_localize(None)
        month_start = datetime(int(ym[:4]), int(ym[5:7]), 1)
        return idx.min() > pd.Timestamp(month_start) + _HEAD_TOLERANCE
    except Exception:
        return True


def _stale_incomplete_month(path, ttl_hours, ym, edge_days=15):
    """True if `path` is an empty or implausibly-partial past month older than
    `ttl_hours` — used by sources whose history is backfilled progressively
    server-side, where a month fetched mid-backfill caches a permanent hole.

    Only called when a TTL is set. mtime is checked first (cheap stat) so files
    younger than the TTL are never opened. Past the age gate only the index is
    read; the month counts as stale when it has 0 rows, or its first bar starts
    more than `edge_days` after the month begins, or its last bar ends more than
    `edge_days` before the month ends (15 days clears the longest TAIFEX Lunar
    New Year closure, ~11 calendar days). A month that passes gets its mtime
    refreshed so it is re-examined at most once per TTL window. An unreadable
    file counts as stale → re-fetch.

    Known blind spots (heuristic limits, accepted): a hole of <= `edge_days` at
    either month edge, and any hole strictly inside the month, pass the check and
    are never re-fetched. Also note the flip side: a month that can never be
    complete (source history starts mid-month, delisting, pre-history empty
    months inside the requested range) re-fetches once per TTL window forever —
    clamp the requested start to the source's known history start where possible.
    """
    try:
        if time.time() - path.stat().st_mtime <= ttl_hours * 3600:
            return False
        idx = pd.read_parquet(path, columns=[]).index   # index only, no data pages
        if len(idx) == 0:
            return True
        month_start = datetime(int(ym[:4]), int(ym[5:7]), 1)
        month_end   = _month_end_utc(ym)
        idx = pd.to_datetime(idx)
        if getattr(idx, 'tz', None) is not None:
            idx = idx.tz_convert('UTC').tz_localize(None)
        margin = timedelta(days=edge_days)
        if idx.min() > pd.Timestamp(month_start) + margin:
            return True
        if idx.max() < pd.Timestamp(month_end) - margin:
            return True
        try:
            os.utime(path)   # passed — skip the index read until the TTL expires again
        except OSError:
            pass             # can't refresh mtime — worst case we re-check next call
        return False
    except Exception:
        return True


def _atomic_to_parquet(df, path, footer_meta=None):
    """Write `df` to `path` via same-directory tmp file + os.replace.
    `footer_meta` (bytes→bytes) is merged into the parquet schema metadata.

    Readers (and concurrent writers racing on the same month) never see a
    half-written parquet: a crash/kill mid-write leaves only a *.tmp file,
    and os.replace on the same filesystem is atomic.
    """
    tmp = path.with_name(f'{path.name}.{os.getpid()}.tmp')
    try:
        if footer_meta:
            table = pa.Table.from_pandas(df)
            table = table.replace_schema_metadata({**(table.schema.metadata or {}), **footer_meta})
            pq.write_table(table, tmp)
        else:
            df.to_parquet(tmp)
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def _extend_cache_monthly(prefix, params, fetch_raw_fn, start, end,
                          empty_marker_ttl_hours=None):
    """Monthly-partitioned cache.

    Past months (before current month) are stored immutably — fetched once, never re-fetched,
    with one exception: a past-month file last written BEFORE that month ended
    (i.e. cached while it was still the current month, so its tail may be
    missing) gets one completing re-fetch, merged with what is already cached.
    Current month is delta-updated: load cached, fetch from last bar to now, merge.

    empty_marker_ttl_hours (opt-in): by default (None) an empty past month is
    marked once and never re-fetched — correct for sources whose history is
    truly immutable. Sources that backfill history progressively server-side
    (e.g. twstock minute lines, Taiwan futures) pass a TTL: a past month that
    is empty or implausibly partial (first/last bar far from the month edges —
    the backfill-frontier month) and whose mtime is older than the TTL is
    treated as a cache miss and re-fetched, merged with the existing rows. If
    the re-fetch adds nothing the file is rewritten (mtime refreshed), so the
    source is hit at most once per TTL window per incomplete span.

    Directory: cache/{prefix}_{params}/
    Files:     YYYY-MM.parquet  (one per month)

    Daily-frequency prefixes listed in _SINGLE_FILE_PREFIXES are routed to the
    one-file-per-id layout (_extend_cache_single) — same contract, same return.
    """
    if prefix in _SINGLE_FILE_PREFIXES:
        if empty_marker_ttl_hours is not None:
            raise ValueError(f'{prefix}: empty_marker_ttl_hours is monthly-layout only')
        return _extend_cache_single(prefix, params, fetch_raw_fn, start, end)
    cache_dir = _monthly_cache_dir(prefix, params)
    cache_dir.mkdir(parents=True, exist_ok=True)

    now = datetime.utcnow()
    end_str   = end or now.strftime('%Y-%m-%d')
    current_ym = now.strftime('%Y-%m')
    tomorrow   = (now + timedelta(days=1)).strftime('%Y-%m-%d')

    all_months    = list(_iter_months(start, end_str))
    past_months   = [ym for ym in all_months if ym < current_ym]
    present_months = [ym for ym in all_months if ym >= current_ym]   # current (+ any future)

    # ── Backfill missing/incomplete PAST months in contiguous spans ───────────
    # Past months are immutable once complete. Fetch each contiguous run of missing
    # months with a SINGLE ranged call — raw_fn chunks it concurrently internally —
    # instead of one slow sequential call per month, then split the result into
    # per-month parquets. A month re-fetched here is MERGED with any existing rows,
    # never blindly overwritten, so a thin/partial re-fetch cannot shrink the cache.
    # Empty months still get a marker file so they are never re-fetched — unless
    # empty_marker_ttl_hours is set, in which case an expired empty or implausibly-
    # partial month is treated as missing and re-fetched (see docstring).
    # Sub-5min klines get a one-shot month-head check (see _head_short_unverified);
    # every past month written below carries the verified flag so it never recurs.
    try:
        head_check = prefix == 'kline2' and _is_sub_5min(params.get('period', '1d'))
    except Exception:
        head_check = False
    footer_meta = _HEAD_VERIFIED_META if head_check else None

    def _needs_fetch(ym):
        path = cache_dir / f'{ym}.parquet'
        if not path.exists():
            return True
        if _written_before_month_end(path, ym):
            return True   # cached mid-month, tail may be missing — complete it once
        if head_check and _head_short_unverified(path, ym):
            return True   # cached from a clamped start, head may be missing — complete it once
        return (empty_marker_ttl_hours is not None
                and _stale_incomplete_month(path, empty_marker_ttl_hours, ym))
    missing = [ym for ym in past_months if _needs_fetch(ym)]
    for span in _contiguous_spans(missing):
        span_start = f'{span[0]}-01'
        span_end   = f'{_next_month(span[-1])}-01'   # exclusive upper bound
        df = fetch_raw_fn(span_start, span_end)
        if not df.empty:
            df = _normalise_index(df)
            df = df[~df.index.duplicated(keep='last')].sort_index()
            by_month = {ym: grp for ym, grp in df.groupby(df.index.strftime('%Y-%m'))}
        else:
            by_month = {}
        for ym in span:
            grp  = by_month.get(ym)
            path = cache_dir / f'{ym}.parquet'
            if path.exists():
                try:
                    existing = _normalise_index(pd.read_parquet(path))
                except Exception:
                    existing = pd.DataFrame()
                if not existing.empty:
                    grp = existing if grp is None else pd.concat([existing, grp])
                    grp = grp[~grp.index.duplicated(keep='last')].sort_index()
            _atomic_to_parquet(grp if grp is not None else pd.DataFrame(), path, footer_meta)

    # One batched read for all past months instead of one read_parquet call per month
    # file — with hundreds of ids x ~140 month files each, the per-file open/parse
    # overhead is what makes warm multi-stock backtests slow (2026-08: 151s of a
    # tw_low_pe run was this loop). Caveat: a multi-file read takes the FIRST file's
    # schema — an empty-month marker (no columns) first in the list would silently
    # blank the whole id, and a month with a divergent schema would silently lose
    # columns. So filter markers out with a footer-only schema read (~50x cheaper
    # than a full read) and only batch when every schema matches; otherwise fall
    # back to the per-file loop, whose concat unions columns.
    frames = []
    non_empty, names0, uniform = [], None, True
    for ym in past_months:
        path = cache_dir / f'{ym}.parquet'
        names = pq.read_schema(path).names
        if not names:
            continue                      # empty-month marker
        if names0 is None:
            names0 = names
        elif names != names0:
            uniform = False
        non_empty.append(path)
    if non_empty and uniform:
        try:
            cached = pd.read_parquet(non_empty)
            if not cached.empty:
                frames.append(cached)
        except Exception:                 # e.g. same names, clashing dtypes
            uniform = False
    if non_empty and not uniform:
        for path in non_empty:
            cached = pd.read_parquet(path)
            if not cached.empty:
                frames.append(cached)

    # ── Current month (and any future month in range) — delta update ──────────
    for ym in present_months:
        path     = cache_dir / f'{ym}.parquet'
        ym_start = f'{ym}-01'
        if path.exists():
            cached = _normalise_index(pd.read_parquet(path))
            last_ts = cached.index[-1].strftime('%Y-%m-%d')
            delta = fetch_raw_fn(last_ts, tomorrow)
            if not delta.empty:
                delta  = _normalise_index(delta)
                merged = pd.concat([cached, delta])
                merged = merged[~merged.index.duplicated(keep='last')].sort_index()
                _atomic_to_parquet(merged, path)
                frames.append(merged)
            else:
                frames.append(cached)
        else:
            df = fetch_raw_fn(ym_start, tomorrow)
            if df.empty:
                continue
            df = _normalise_index(df)
            df = df[~df.index.duplicated(keep='last')].sort_index()
            _atomic_to_parquet(df, path)
            frames.append(df)

    if not frames:
        return pd.DataFrame()

    result = pd.concat(frames)
    result = _normalise_index(result)
    result = result[~result.index.duplicated(keep='last')].sort_index()

    start_ts = pd.Timestamp(start)
    end_ts   = pd.Timestamp(end_str) + pd.Timedelta(days=1)
    return result[(result.index >= start_ts) & (result.index < end_ts)]


def _save_monthly(prefix, params, df):
    """Split df by month and save each month's slice to its own parquet file.
    Used by batch fetchers to populate the monthly cache after a bulk API call.
    """
    cache_dir = _monthly_cache_dir(prefix, params)
    cache_dir.mkdir(parents=True, exist_ok=True)
    df = _normalise_index(df)
    df = df[~df.index.duplicated(keep='last')].sort_index()
    for ym, grp in df.groupby(df.index.strftime('%Y-%m')):
        path = cache_dir / f'{ym}.parquet'
        if path.exists():
            existing = _normalise_index(pd.read_parquet(path))
            grp = pd.concat([existing, grp])
            grp = grp[~grp.index.duplicated(keep='last')].sort_index()
        grp.to_parquet(path, compression='snappy')


# ── Single-file cache layout (daily datasets) ─────────────────────────────────
#
# Monthly partitioning is right for minute bars (hundreds of thousands of rows,
# only the current month ever changes) but wrong for daily series: a 台股 daily
# dataset is ~20 rows / 7KB per month, so a 300-stock universe is 41,400 tiny
# parquets and the per-file open/parse/write overhead dominates everything.
# Measured on a real Windows customer box (2026-08-22, 300 stocks, 723k rows):
# cold write 41,400 monthly files ≈ 13 min vs 300 single files ≈ 2.3 s; warm
# read 32.0 s vs 1.1 s; the same 300-stock Type C backtest went 14.5 min cold /
# 57 s warm → 45 s cold / 15 s warm. So daily datasets keep ONE parquet per
# (prefix, id) whose parquet footer metadata carries what the monthly layout
# encoded in file names and mtimes: which months are covered (one contiguous
# range — fetch spans always fill the whole requested range, empty months
# included, so no empty-month markers are needed) and when the tail was last
# fetched (a month is complete iff it was fetched after it ended; the current
# month is delta-updated on every call, exactly as before). Meta lives INSIDE
# the parquet (schema metadata key b'blave_cache_meta'), so frame and coverage
# are always written together in one atomic replace — no sidecar that could
# describe somebody else's frame under concurrent writers.
#
# File: cache/{prefix}_{params}.parquet   all rows, tz-naive UTC index, sorted;
#       footer meta {"from": "YYYY-MM", "to": "YYYY-MM",
#                    "tail_fetched_at": "YYYY-MM-DDTHH:MM:SS"}
# An existing monthly directory for the same (prefix, params) is consolidated
# into the single file on first touch and removed — machines already in the
# field migrate lazily, no manual step.
_SINGLE_FILE_PREFIXES = frozenset({
    'twstock_price', 'twstock_price_nonadj', 'twstock_inst', 'twstock_shareholding',
    'twstock_per', 'twstock_foreign_sh',
    'twmarket_index', 'twmarket_turnover', 'twmarket_institutional', 'twmarket_margin',
    'twfutures_institutional',
})
_META_TS_FMT = '%Y-%m-%dT%H:%M:%S'
_META_KEY = b'blave_cache_meta'


def _single_path(prefix, params):
    return Path(f'{_monthly_cache_dir(prefix, params)}.parquet')   # same stem as the old directory


def _write_single(prefix, params, df, meta):
    """One atomic write: frame + coverage meta in the parquet footer."""
    path = _single_path(prefix, params)
    path.parent.mkdir(parents=True, exist_ok=True)
    if not df.empty:
        df = _normalise_index(df)
        df = df[~df.index.duplicated(keep='last')].sort_index()
    table = pa.Table.from_pandas(df, preserve_index=True)
    table = table.replace_schema_metadata({**(table.schema.metadata or {}),
                                           _META_KEY: json.dumps(meta).encode()})
    tmp = path.with_name(f'{path.name}.{os.getpid()}.tmp')
    try:
        pq.write_table(table, tmp)
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def _read_single_meta(prefix, params):
    """Footer-only read of the coverage meta (no data pages). None if absent/unreadable."""
    path = _single_path(prefix, params)
    try:
        raw = (pq.read_schema(path).metadata or {}).get(_META_KEY)
        meta = json.loads(raw) if raw else None
        if meta and all(k in meta for k in ('from', 'to', 'tail_fetched_at')):
            return meta
    except Exception:
        pass
    return None


def _read_monthly_dir_all(cache_dir):
    """Read every month file in a monthly cache dir. Returns (frame, months_ok,
    months_bad): markers count as ok (fetched, empty); unreadable files are
    reported in months_bad so the caller can keep them OUT of the claimed
    coverage. Same schema-uniform batch read / per-file fallback as
    _extend_cache_monthly."""
    paths, names0, uniform, ok, bad = [], None, True, [], []
    for path in sorted(cache_dir.glob('*.parquet')):
        ym = path.stem
        if not (len(ym) == 7 and ym[4] == '-'):
            continue                      # not a month file (e.g. a stray tmp)
        try:
            names = pq.read_schema(path).names
        except Exception:
            bad.append(ym)
            continue
        ok.append(ym)
        if not names:
            continue                      # empty-month marker
        if names0 is None:
            names0 = names
        elif names != names0:
            uniform = False
        paths.append(path)
    if not paths:
        return pd.DataFrame(), ok, bad
    df = None
    if uniform:
        try:
            df = pd.read_parquet(paths)
        except Exception:
            df = None
    if df is None:
        frames = []
        for p in paths:
            try:
                f = pd.read_parquet(p)
            except Exception:
                bad.append(p.stem); ok.remove(p.stem)
                continue
            if not f.empty:
                frames.append(f)
        df = pd.concat(frames) if frames else pd.DataFrame()
    return df, ok, bad


def _migrate_monthly_to_single(prefix, params):
    """Consolidate an old monthly directory into the single-file layout and
    remove it. Claimed coverage = the LAST contiguous run of readable month
    files (a directory can legitimately hold disjoint ranges — a 2021 backtest
    then a 2025 live run — and claiming the gap would freeze a hole forever;
    rows outside the claimed range are kept and simply get overlaid when an
    earlier start is requested). tail_fetched_at = mtime of the LAST month's
    file, which is exactly what the monthly layout used to judge that month's
    completeness (only the last month can ever be incomplete). The directory
    is renamed first so a concurrent caller never globs a half-deleted dir:
    the loser of the rename sees no cache and takes the cold path, which merges
    on write (_merge_single). Returns (frame, meta) or (None, None)."""
    cache_dir = _monthly_cache_dir(prefix, params)
    work = cache_dir.with_name(f'{cache_dir.name}.migrating.{os.getpid()}')
    try:
        os.rename(cache_dir, work)
    except OSError:
        return None, None                 # someone else is migrating it, or it's gone
    try:
        df, ok, _bad = _read_monthly_dir_all(work)
        spans = _contiguous_spans(sorted(set(ok)))
        if not spans:
            shutil.rmtree(work, ignore_errors=True)   # nothing readable in it
            return None, None
        last = spans[-1]
        try:
            newest = (work / f'{last[-1]}.parquet').stat().st_mtime
        except Exception:
            newest = 0                    # unstatable → treated as never complete → re-fetched
        meta = {'from': last[0], 'to': last[-1],
                'tail_fetched_at': datetime.utcfromtimestamp(newest).strftime(_META_TS_FMT)}
        _write_single(prefix, params, df, meta)
    except Exception:
        # Keep the history: put the directory back so the next call retries the
        # migration instead of paying a full cold fetch for 41k files' worth of data.
        try:
            os.rename(work, cache_dir)
        except OSError:
            pass
        raise
    shutil.rmtree(work, ignore_errors=True)       # only after the single file landed
    return (_normalise_index(df) if not df.empty else df), meta


def _read_single(prefix, params):
    """→ (frame, meta) or (None, None) when nothing is cached. Migrates a
    monthly directory on first touch."""
    path = _single_path(prefix, params)
    if path.exists():
        meta = _read_single_meta(prefix, params)
        if meta is not None:
            try:
                df = pd.read_parquet(path)
            except Exception:
                df = None                 # unreadable: fall through, treat as uncached
            if df is not None:
                # A monthly dir (rename lost a race / an earlier cold write beat the
                # migration) or an orphan .migrating.* would otherwise sit forever.
                stale = _monthly_cache_dir(prefix, params)
                for d in [stale] + list(stale.parent.glob(f'{stale.name}.migrating.*')):
                    if d.is_dir():
                        shutil.rmtree(d, ignore_errors=True)
                return (_normalise_index(df) if not df.empty else df), meta
    cache_dir = _monthly_cache_dir(prefix, params)
    if cache_dir.is_dir():
        return _migrate_monthly_to_single(prefix, params)
    return None, None


def _has_single_cache(prefix, params):
    if _single_path(prefix, params).exists():
        return True
    cache_dir = _monthly_cache_dir(prefix, params)
    return cache_dir.is_dir() and any(cache_dir.glob('*.parquet'))


def _tail_needs_completion(meta, ym):
    """True if month `ym` (<= meta['to']) may be missing its tail: it was last
    fetched before it ended — the single-file twin of _written_before_month_end."""
    try:
        fetched = datetime.strptime(meta['tail_fetched_at'], _META_TS_FMT)
    except Exception:
        return True
    return fetched < _month_end_utc(ym)


def _merge_frames(a, b):
    parts = [x for x in (a, b) if x is not None and not x.empty]
    if not parts:
        return pd.DataFrame()
    out = pd.concat([_normalise_index(x) for x in parts])
    return out[~out.index.duplicated(keep='last')].sort_index()


def _extend_cache_single(prefix, params, fetch_raw_fn, start, end):
    """One-file-per-id twin of _extend_cache_monthly. Fetch windows are month-
    aligned like the monthly layout's spans, so the batch prefetch in
    _fetch_batch_cached serves the same spans:
      - no cache:        fetch [from-01, upper)
      - earlier start:   fetch [req_from-01, from-01) and prepend
      - tail:            fetch [max(last cached bar, to-01), upper) when the
                         last covered month is the current one or was fetched
                         before it ended; or [next_month(to)-01, upper) when
                         the request reaches past a complete `to`
    upper = tomorrow when the request touches the current month, else the first
    day after the requested end month. Returns rows in [start, end]."""
    now        = datetime.utcnow()
    end_str    = end or now.strftime('%Y-%m-%d')
    current_ym = now.strftime('%Y-%m')
    tomorrow   = (now + timedelta(days=1)).strftime('%Y-%m-%d')
    req_from, req_to = start[:7], end_str[:7]
    cap_to = min(req_to, current_ym)       # never claim coverage of a future month
    upper  = tomorrow if req_to >= current_ym else f'{_next_month(req_to)}-01'
    stamp  = now.strftime(_META_TS_FMT)

    # When the caller left `end` to us and the requested start is past even tomorrow,
    # the window simply has not happened yet (a forward settlement date, a scheduled
    # backfill span) and the honest answer is "no rows yet". The API cannot tell that
    # from a reversed range — it sees start > end and returns 400 — so decide it here
    # and skip the pointless call. "Tomorrow" is Taipei's, not the machine's: this is
    # a Taiwan dataset and the boxes run UTC. UTC being 8 h behind happens to make the
    # naive compare safe (tomorrow_utc >= Taipei today), but that is an accident of
    # sign holding up a silently-empty answer, so it is pinned instead. Two cases
    # deliberately still reach the API: an explicit `end` (a caller who wrote the
    # order backwards made a typo and should read the message) and a malformed
    # `start` (nothing to compare; the 400 names the expected format).
    if end is None:
        tpe_tomorrow = (datetime.now(_TPE) + timedelta(days=1)).strftime('%Y-%m-%d')
        if tpe_tomorrow < start:
            try:
                datetime.strptime(start, '%Y-%m-%d')
                return pd.DataFrame()
            except ValueError:
                pass

    df, meta = _read_single(prefix, params)
    changed = False
    if df is None:
        fetched = fetch_raw_fn(f'{req_from}-01', upper)
        df = _merge_frames(fetched, None)
        meta = {'from': req_from, 'to': cap_to, 'tail_fetched_at': stamp}
        # Merge rather than write: a concurrent migration may have landed a
        # wider file between our read and now (we'd be the rename-race loser).
        _merge_single(prefix, params, df, meta)
        df, meta2 = _read_single(prefix, params)
        if df is None:                    # vanishingly unlikely; keep the fetched frame
            df = _merge_frames(fetched, None)
        else:
            meta = meta2
        changed = False
    else:
        if req_from < meta['from']:
            early = fetch_raw_fn(f'{req_from}-01', f"{meta['from']}-01")
            df = _merge_frames(early, df)
            meta['from'] = req_from
            changed = True
        delta_start = None
        if meta['to'] >= current_ym or _tail_needs_completion(meta, meta['to']):
            floor = f"{meta['to']}-01"
            if not df.empty:
                floor = max(floor, df.index[-1].strftime('%Y-%m-%d'))
            delta_start = floor
        elif req_to > meta['to']:
            delta_start = f"{_next_month(meta['to'])}-01"
        if delta_start is not None and delta_start < upper:
            delta = fetch_raw_fn(delta_start, upper)
            df = _merge_frames(df, delta)
            meta['to'] = max(meta['to'], cap_to)
            meta['tail_fetched_at'] = stamp
            changed = True
    if changed:
        _write_single(prefix, params, df, meta)
    if df.empty:
        return pd.DataFrame()
    start_ts = pd.Timestamp(start)
    end_ts   = pd.Timestamp(end_str) + pd.Timedelta(days=1)
    return df[(df.index >= start_ts) & (df.index < end_ts)]


def _merge_meta(old, new):
    """Coverage union ONLY when the two ranges overlap or touch — a gap between
    them was never fetched and must not be claimed (it would freeze a hole).
    Disjoint: keep the segment with the larger `to` (same rule as migration;
    the other segment's rows stay in the file as harmless extras and get
    overlaid by the next early fetch). tail_fetched_at follows the segment
    that owns `to`; when both end in the same month, the fresher stamp wins."""
    a, b = (old, new) if old['to'] <= new['to'] else (new, old)   # a ends first
    if _next_month(a['to']) >= b['from'] and _next_month(b['to']) >= a['from']:
        if a['to'] == b['to']:
            tail = max(a['tail_fetched_at'], b['tail_fetched_at'])
        else:
            tail = b['tail_fetched_at']
        return {'from': min(a['from'], b['from']), 'to': b['to'], 'tail_fetched_at': tail}
    return dict(b)


def _merge_single(prefix, params, df, meta):
    """Write `df`+`meta` merged with whatever is already cached — never narrows
    or blanks an existing file. Used by the phase-2 batch save and by the cold
    path of _extend_cache_single (a concurrent migration may have landed a wider
    file in between)."""
    existing, old_meta = _read_single(prefix, params)
    if existing is None:
        _write_single(prefix, params, df if df is not None else pd.DataFrame(), meta)
        return
    if df is None or df.empty:
        return                            # never blank a cache that has something
    _write_single(prefix, params, _merge_frames(existing, df), _merge_meta(old_meta, meta))


def _save_single(prefix, params, df, start, end):
    """Phase-2 twin of _save_monthly + _mark_empty_months: a full-range batch
    fetch covered every month in [start, end] (empty ones included). Merges with
    whatever is already cached (an id can reach phase 2 after a phase-1 demotion
    in a rate-limit storm, and a wider older cache must survive that); an empty
    result only creates a file when none exists (same rule as _mark_empty_months).
    tail_fetched_at = min(now, end+1d): "freshness = how far the fetch reached",
    so a past mid-month `end` leaves that month marked incomplete and the next
    call completes it instead of freezing a hole."""
    now = datetime.utcnow()
    end_str = end or now.strftime('%Y-%m-%d')
    reached = min(now, datetime.strptime(end_str, '%Y-%m-%d') + timedelta(days=1))
    meta = {'from': start[:7], 'to': min(end_str[:7], now.strftime('%Y-%m')),
            'tail_fetched_at': reached.strftime(_META_TS_FMT)}
    _merge_single(prefix, params, df, meta)


# ── Kline ─────────────────────────────────────────────────────────────────────

def _sanity_check_ohlc(df, label):
    """Drop bars with impossible OHLC values (high<low, non-positive or NaN price).

    Corrupt upstream/exchange data would otherwise silently propagate into every
    indicator and signal computed on top of it — not a hypothetical, this is the
    failure mode a strategy author can't see just by eyeballing a chart.

    Called at READ time (on the assembled result, after the cache), never before
    writing the cache: the cache must keep the raw upstream bars, so a transient
    upstream glitch doesn't become a permanent hole in an immutable monthly
    parquet, and bars already cached before this check existed are covered too.

    Dropping leaves a gap in the bar series (shift/pct_change will span it) —
    same as an exchange outage. The dropped timestamps are printed so the gap
    is diagnosable; corrupt bars are strictly worse than a visible gap.
    """
    if df.empty or not all(c in df.columns for c in ('Open', 'High', 'Low', 'Close')):
        return df
    ohlc = df[['Open', 'High', 'Low', 'Close']]
    bad = (df['High'] < df['Low']) | (ohlc <= 0).any(axis=1) | ohlc.isna().any(axis=1)
    if bad.any():
        ts = ', '.join(str(t) for t in df.index[bad][:5])
        more = '' if int(bad.sum()) <= 5 else f' (+{int(bad.sum()) - 5} more)'
        print(f"  ⚠️  {label}: dropped {int(bad.sum())} bar(s) with invalid OHLC "
              f"(high<low, non-positive or NaN price) at: {ts}{more}")
        df = df[~bad]
    return df


_closed_bars_only = 0   # >0 while a strategy's fetch_data runs under closed_bars_only()


class closed_bars_only:
    """Scope in which the crypto kline fetchers drop the bar that has not closed yet.

    The runner and wait_for_bar wrap a strategy's fetch_data in it: every 24/7 crypto
    source hands the forming bar back — Blave /kline resamples closed 1m/5m base bars into
    the requested period without dropping the partial last bucket (at 10:32 the "10:00 1h
    bar" holds 32 minutes), Binance / BingX klines always include the open candle — and the
    live tick reads iloc[-1], so the signal would come from a half bar the backtest never
    sees. Outside the scope nothing changes: paper fills, reports and the drift-band sigma
    read the current price / trim the forming bar themselves.
    """
    def __enter__(self):
        global _closed_bars_only
        _closed_bars_only += 1
        return self

    def __exit__(self, *exc):
        global _closed_bars_only
        _closed_bars_only -= 1
        return False


def _drop_forming_bar(df, interval, now=None, force=False):
    """Rows with label + interval <= now (label = bar open time, crypto/UTC/continuous).
    No-op outside closed_bars_only() unless force; a weekly-or-longer or unparseable
    interval passes through untouched — its label convention is not open-time."""
    if not (force or _closed_bars_only):
        return df
    try:
        td = pd.Timedelta(interval)
    except (ValueError, TypeError):
        return df
    if df.empty or not isinstance(df.index, pd.DatetimeIndex) or td >= pd.Timedelta(days=7):
        return df
    now = pd.Timestamp.now(tz='UTC') if now is None else pd.Timestamp(now)
    if df.index.tz is None:
        now = (now.tz_convert('UTC') if now.tz is not None else now).tz_localize(None)
    elif now.tz is None:
        now = now.tz_localize('UTC')
    return df[df.index + td <= now]


def _is_sub_5min(interval):
    return pd.Timedelta(interval) < pd.Timedelta('5min')


def _fetch_kline_raw(symbol, interval, start, end, headers, max_retries=6):
    from concurrent.futures import ThreadPoolExecutor, as_completed
    sub_5min = _is_sub_5min(interval)
    s = datetime.strptime(start, '%Y-%m-%d')
    e = datetime.utcnow() if not end else datetime.strptime(end, '%Y-%m-%d')
    chunks, cursor = [], s
    chunk_days = 30 if sub_5min else 365
    while cursor < e:
        chunk_end = min(cursor + timedelta(days=chunk_days), e)
        chunks.append((cursor.strftime('%Y-%m-%d'), chunk_end.strftime('%Y-%m-%d')))
        cursor = chunk_end

    def _fetch_one(cs, ce):
        # Sub-5min cold fetches hit Binance fapi server-side and can take minutes;
        # _retry_get also covers transient 429/5xx/timeouts a bare requests.get dropped.
        try:
            r = _retry_get(f'{BASE}/kline', headers=headers, max_retries=max_retries, params={
                'symbol': symbol, 'period': interval,
                'start_date': cs, 'end_date': ce,
            }, timeout=300 if sub_5min else 60)
        except requests.HTTPError as exc:
            resp = exc.response
            raise RuntimeError(
                f'/kline {symbol} {interval} HTTP {resp.status_code}: {resp.text[:200]}'
            ) from exc
        return r.json()

    rows = []
    progress = Progress(f'fetch {symbol} {interval}', len(chunks), 'chunks')  # cold deep history → ETA lines
    with ThreadPoolExecutor(max_workers=10) as pool:
        futures = {pool.submit(_fetch_one, cs, ce): (cs, ce) for cs, ce in chunks}
        for future in as_completed(futures):
            rows.extend(future.result())
            progress.tick()

    if not rows:
        return pd.DataFrame(columns=['Open', 'High', 'Low', 'Close', 'Volume'])
    df = pd.DataFrame(rows)
    df['time'] = pd.to_datetime(df['time'], unit='s', utc=True)
    df = df.set_index('time').sort_index()
    df = df[~df.index.duplicated(keep='first')]
    df = df.rename(columns={'open': 'Open', 'high': 'High', 'low': 'Low',
                            'close': 'Close', 'volume': 'Volume'})
    if 'Volume' not in df.columns:
        df['Volume'] = 0
    return df[['Open', 'High', 'Low', 'Close', 'Volume']].astype(float)


def normalize_symbol(symbol):
    """Any venue/ccxt symbol form → platform canonical dashless uppercase
    ('BTC/USDT', 'BTC-USDT', 'BTC_USDT', 'btcusdt' → 'BTCUSDT').

    THE single normalization recipe (the get_positions() symbol contract in
    references/lib.md quotes it) — a new venue whose symbol format introduces a
    separator not covered here must extend this function, not a local copy.
    """
    return symbol.replace('/', '').replace('-', '').replace('_', '').upper()


def fetch_kline(symbol, interval, start, end, headers, max_retries=6):
    """Fetch OHLCV kline data from Blave API with date chunking and local cache.

    All intervals reach back to the symbol's Binance um-futures listing date
    (sub-5min included — the API backfills old months from Binance's official
    archive). A window before listing returns empty, not an error. Sub-5min
    requests are chunked 30 days each server-side, so deep 1min backtests pull
    history month-by-month on first run. Cache namespace is kline2 — the old
    kline cache has Volume hard-zeroed and must not be mixed with real volume.

    With BLAVE_KLINE_SOURCE=binance (the desktop build's BYO data) the bars come
    straight from Binance's public endpoint instead, `headers` unused. Same
    market (USDT-M perps), same columns, same kline2 cache. Not literally the
    same bars: measured 2026-09-19, 8 of 41,335 1h BTCUSDT bars come back from
    /kline as placeholders (O=H=L=C, Volume 0) where Binance has the real bar,
    so a cache dir fed by both sources is a mixed one.

    `max_retries` is _retry_get's (default 6, ~2 min of backoff on 429/5xx):
    a caller inside a latency budget passes fewer (the reconciler's σ lookup).
    """
    # Venue forms like 'BTC/USDT' → Binance 'BTCUSDT'; the API 400s on
    # separator forms and the separator would leak into the cache dir name.
    symbol = normalize_symbol(symbol)
    if _kline_source() == 'binance':
        fetch_raw = lambda s, e: _fetch_binance_kline_raw(symbol, interval, s, e)
    else:
        fetch_raw = lambda s, e: _fetch_kline_raw(symbol, interval, s, e, headers, max_retries)
    df = _extend_cache_monthly(
        'kline2', {'symbol': symbol, 'period': interval},
        fetch_raw, start, end,
    )
    return _drop_forming_bar(_sanity_check_ohlc(df, f'{symbol} {interval} kline'), interval)


def fetch_kline_batch(symbols, interval, start, end, headers):
    """Batch fetch OHLCV kline for many symbols via /kline/batch (chunk_size=20).
    Returns dict {symbol: DataFrame(Open, High, Low, Close, Volume)} — keys are
    the NORMALIZED canonical symbols (see normalize_symbol), not the caller's
    original strings: index the result with 'BTCUSDT' even if you passed 'BTC/USDT'.

    Uses the same monthly cache dir naming as fetch_kline ('kline2_{interval}_{symbol}')
    so single-symbol and batch calls share cache — a symbol already cached via
    fetch_kline is a warm hit here too, and vice versa. Warm ids are extended through
    the batch endpoint too (not one call per symbol) — see _fetch_batch_cached.

    Under BLAVE_KLINE_SOURCE=binance there is no batch endpoint to call, so this
    fans out to fetch_kline per symbol — otherwise a desktop Type C backtest
    would quietly keep pulling its prices from api.blave.org."""
    symbols = [normalize_symbol(s) for s in symbols]
    if _kline_source() == 'binance':
        return {sid: fetch_kline(sid, interval, start, end, headers) for sid in symbols}
    def _parse(records):
        df = pd.DataFrame(records)
        df['time'] = pd.to_datetime(df['time'], unit='s', utc=True)
        df = df.set_index('time').sort_index()
        df = df[~df.index.duplicated(keep='first')]
        df = df.rename(columns={'open': 'Open', 'high': 'High', 'low': 'Low',
                                'close': 'Close', 'volume': 'Volume'})
        if 'Volume' not in df.columns:
            df['Volume'] = 0
        return df[['Open', 'High', 'Low', 'Close', 'Volume']].astype(float)

    results = _fetch_batch_cached(
        f'kline2_{interval}', f'{BASE}/kline/batch?period={interval}', 'symbols',
        lambda sid, s, e, hdrs: _fetch_kline_raw(sid, interval, s, e, hdrs),
        _parse, symbols, start, end, headers,
        chunk_size=20, start_param='start_date', end_param='end_date',
        date_chunk_days=30 if _is_sub_5min(interval) else 365,
    )
    return {sid: _drop_forming_bar(_sanity_check_ohlc(df, f'{sid} {interval} kline'), interval)
            for sid, df in results.items()}


# ── Exchange-native kline ─────────────────────────────────────────────────────
# Blave's own /kline serves Binance USDT-M perps only. A contract listed on the
# exchange the user actually trades — BingX's gold perp GOLD(XAU)-USDT, say — is
# simply not in it, and substituting a same-ish Binance symbol silently backtests
# a different instrument than the one the orders go to (that is a real incident,
# not a hypothetical). Fetch those straight from the exchange instead.

_BINGX_BASE = 'https://open-api.bingx.com'

# lib interval string → BingX interval. Blave's /kline periods spell minutes
# 'min'; BingX spells them 'm'.
_BINGX_INTERVALS = {
    '1min': '1m', '3min': '3m', '5min': '5m', '15min': '15m', '30min': '30m',
    '1h': '1h', '2h': '2h', '4h': '4h', '6h': '6h', '8h': '8h', '12h': '12h',
    '1d': '1d', '3d': '3d', '1w': '1w',
}

# Measured against the live endpoint: a response is capped at 1000 bars (not the
# documented limit=1440) and keeps the NEWEST end of the requested window, so
# paging walks backwards from endTime.
_BINGX_PAGE = 1000
_EPOCH = datetime(1970, 1, 1)


def _fetch_bingx_kline_raw(symbol, interval, start, end):
    bx_interval = _BINGX_INTERVALS.get(interval)
    if bx_interval is None:
        raise ValueError(f"fetch_bingx_kline: unsupported interval {interval!r} "
                         f"(supported: {', '.join(_BINGX_INTERVALS)})")

    to_ms = lambda s: int((datetime.strptime(s, '%Y-%m-%d') - _EPOCH).total_seconds() * 1000)
    start_ms = to_ms(start)
    end_ms   = to_ms(end) if end else int((datetime.utcnow() - _EPOCH).total_seconds() * 1000)

    rows, cursor_ms, prev_oldest = [], end_ms, None
    while cursor_ms > start_ms:
        r = _retry_get(f'{_BINGX_BASE}/openApi/swap/v3/quote/klines', params={
            'symbol': symbol, 'interval': bx_interval,
            'startTime': start_ms, 'endTime': cursor_ms, 'limit': _BINGX_PAGE,
        }, timeout=30)
        body = r.json()
        # BingX signals errors in the body with HTTP 200, so raise_for_status
        # inside _retry_get sees nothing. Fail loud rather than return a short
        # series that looks like "the contract just has no history there".
        if body.get('code') != 0:
            raise RuntimeError(f"BingX kline {symbol} {bx_interval}: "
                               f"code={body.get('code')} {body.get('msg')}")
        page = body.get('data') or []
        if not page:
            break
        rows.extend(page)
        oldest = min(int(bar['time']) for bar in page)
        if prev_oldest is not None and oldest >= prev_oldest:
            break            # no progress — stop instead of spinning forever
        prev_oldest = oldest
        cursor_ms = oldest - 1

    cols = ['Open', 'High', 'Low', 'Close', 'Volume']
    if not rows:
        return pd.DataFrame(columns=cols)
    df = pd.DataFrame(rows)
    df['time'] = pd.to_datetime(df['time'].astype('int64'), unit='ms', utc=True)
    df = df.set_index('time').sort_index()
    df = df[~df.index.duplicated(keep='first')]
    df = df.rename(columns={'open': 'Open', 'high': 'High', 'low': 'Low',
                            'close': 'Close', 'volume': 'Volume'})
    return df[cols].astype(float)


def fetch_bingx_kline(symbol, interval, start, end):
    """OHLCV for a BingX perpetual, straight from BingX's public API — no key needed.

    `symbol` is the BingX API symbol, NOT the display name shown on the chart:
    GOLD(XAU)-USDT is `NCCOGOLD2USD-USDT`. Look it up in
    `GET /openApi/swap/v3/quote/contracts` (the `symbol` / `displayName` pair).
    Whatever you pass here must be the same symbol the orders use.
    """
    df = _extend_cache_monthly(
        'bingx_kline', {'symbol': symbol, 'period': interval},
        lambda s, e: _fetch_bingx_kline_raw(symbol, interval, s, e),
        start, end,
    )
    return _drop_forming_bar(_sanity_check_ohlc(df, f'{symbol} {interval} bingx_kline'), interval)


# ── BYO kline source: Binance fapi, no key ────────────────────────────────────
# The desktop build is free software running on the user's own machine, so its
# market data is BYO: with BLAVE_KLINE_SOURCE=binance, fetch_kline pages the
# public Binance endpoint directly instead of api.blave.org. Off unless that
# variable is set, so the fleet never reaches this code.

# USDT-M perpetuals, deliberately — that is the market /kline serves and the
# collector stores. Pointing this at spot (api.binance.com/api/v3/klines) would
# make the same strategy backtest differently on the desktop than in the cloud,
# because basis and funding live in the perp price and not in the spot price.
_BINANCE_KLINES = 'https://fapi.binance.com/fapi/v1/klines'
_BINANCE_PAGE   = 1000          # server cap per response, not a preference

# fapi's own exchangeInfo reports 2400 request-weight per minute and a 1000-bar
# kline page costs 5 (measured off the x-mbx-used-weight-1m header, not the
# docs). 400 pages/min = 2000 weight, leaving headroom for whatever else the box
# is doing; the 429 handling below is the backstop, not the throttle.
_BINANCE_LIMITER = _RateLimiter(400, 60)

# Binance and BingX spell intervals identically, so the lib's own '1min' family
# maps onto both. Binance spellings map to themselves: lib/paper_data calls
# fetch_kline with '1m'.
_BINANCE_INTERVALS = {**_BINGX_INTERVALS, **{v: v for v in _BINGX_INTERVALS.values()}}


def _binance_get(url, params, max_retries=6, timeout=30, max_wait=None):
    """GET a public Binance endpoint, honouring Retry-After on 429/418.

    Deliberately not _retry_get: that one is the fleet's path to our own API and
    its fixed 2/4/8… backoff is tuned for it. Binance answers a rate-limit with
    the exact number of seconds to wait and escalates an ignored 429 into a 418
    IP ban, so guessing the wait here is the wrong move.
    """
    for attempt in range(max_retries):
        _BINANCE_LIMITER.acquire()
        try:
            r = requests.get(url, params=params, timeout=timeout)
        except (requests.exceptions.Timeout, requests.exceptions.ConnectionError) as e:
            if attempt == max_retries - 1:
                raise
            wait = 2 ** (attempt + 1)
            print(f'  {type(e).__name__} transient — retrying in {wait}s (binance klines)')
            time.sleep(wait)
            continue
        if r.status_code in (429, 418) or r.status_code >= 500:
            if attempt == max_retries - 1:
                break
            try:
                wait = int(r.headers.get('Retry-After', ''))
            except ValueError:
                wait = 2 ** (attempt + 1)
            print(f'  {r.status_code} from Binance — retrying in {wait}s')
            if max_wait is not None and wait > max_wait:
                break   # a caller that cannot wait (a report brick) gives up instead
            time.sleep(min(wait, 300 if max_wait is None else max_wait))
            continue
        try:
            r.raise_for_status()
        except requests.HTTPError as exc:
            # Binance puts the reason in the body ({"code":-1121,"msg":"Invalid
            # symbol."}); raise_for_status() alone would say only "400".
            raise requests.HTTPError(f'{exc} — {r.text[:200]}', response=r) from exc
        return r
    r.raise_for_status()
    return r


def _binance_klines_to_df(rows):
    """Binance's array-of-arrays → the five-column frame every lib consumer eats.

    Index 0 is the bar's open time in ms, 1-4 OHLC, 5 the base-asset volume;
    everything after (close time, quote volume, taker splits) is dropped.
    """
    cols = ['Open', 'High', 'Low', 'Close', 'Volume']
    if not rows:
        return pd.DataFrame(columns=cols)
    df = pd.DataFrame([row[:6] for row in rows], columns=['time'] + cols)
    df['time'] = pd.to_datetime(df['time'].astype('int64'), unit='ms', utc=True)
    df = df.set_index('time').sort_index()
    df = df[~df.index.duplicated(keep='first')]
    return df[cols].astype(float)


def _fetch_binance_kline_raw(symbol, interval, start, end):
    """_fetch_kline_raw's twin against Binance. Same 30/365-day chunking, so the
    monthly cache sees the same spans either way; inside a chunk we page forward
    on startTime because one response is capped at 1000 bars — a 30-day 1min
    chunk is 43,200 of them.
    """
    bn_interval = _BINANCE_INTERVALS.get(interval)
    if bn_interval is None:
        raise ValueError(f"fetch_kline (binance source): unsupported interval {interval!r} "
                         f"(supported: {', '.join(sorted(_BINANCE_INTERVALS))})")
    s = datetime.strptime(start, '%Y-%m-%d')
    e = datetime.utcnow() if not end else datetime.strptime(end, '%Y-%m-%d')
    chunks, cursor = [], s
    chunk_days = 30 if _is_sub_5min(interval) else 365
    while cursor < e:
        chunk_end = min(cursor + timedelta(days=chunk_days), e)
        chunks.append((cursor, chunk_end))
        cursor = chunk_end

    to_ms = lambda d: int((d - _EPOCH).total_seconds() * 1000)

    def _fetch_one(cs, ce):
        rows, cursor_ms, end_ms = [], to_ms(cs), to_ms(ce)
        while cursor_ms <= end_ms:
            page = _binance_get(_BINANCE_KLINES, {
                'symbol': symbol, 'interval': bn_interval,
                'startTime': cursor_ms, 'endTime': end_ms, 'limit': _BINANCE_PAGE,
            }).json()
            if not page:
                break
            rows.extend(page)
            nxt = int(page[-1][0]) + 1
            if nxt <= cursor_ms:
                break                      # no progress — stop instead of spinning forever
            cursor_ms = nxt
            if len(page) < _BINANCE_PAGE:
                break                      # short page = this window is exhausted
        return rows

    rows = []
    progress = Progress(f'fetch {symbol} {interval} (binance)', len(chunks), 'chunks')
    with ThreadPoolExecutor(max_workers=10) as pool:
        futures = [pool.submit(_fetch_one, cs, ce) for cs, ce in chunks]
        for future in as_completed(futures):
            rows.extend(future.result())
            progress.tick()
    return _binance_klines_to_df(rows)


# ── Alpha data ────────────────────────────────────────────────────────────────

def _fetch_alpha_raw(endpoint, params, headers, start, end):
    from concurrent.futures import ThreadPoolExecutor, as_completed
    s = datetime.strptime(start, '%Y-%m-%d')
    e = datetime.utcnow() if not end else datetime.strptime(end, '%Y-%m-%d')
    chunks, cursor = [], s
    while cursor < e:
        chunk_end = min(cursor + timedelta(days=365), e)
        chunks.append((cursor.strftime('%Y-%m-%d'), chunk_end.strftime('%Y-%m-%d')))
        cursor = chunk_end

    def _fetch_one(cs, ce):
        # 3 not the default 6: worst case ~3 min instead of ~8, which would swallow a 1m/5m strategy's cycle
        r = _retry_get(f'{BASE}/{endpoint}', max_retries=3, headers=headers, params={
            **params, 'start_date': cs, 'end_date': ce,
        }, timeout=60)
        data = r.json().get('data', {})
        return data.get('timestamp', []), data.get('alpha', [])

    ts_list, alpha_list = [], []
    progress = Progress(f'fetch {endpoint}', len(chunks), 'chunks')
    with ThreadPoolExecutor(max_workers=10) as pool:
        futures = {pool.submit(_fetch_one, cs, ce): (cs, ce) for cs, ce in chunks}
        for future in as_completed(futures):
            ts, alpha = future.result()
            ts_list.extend(ts)
            alpha_list.extend(alpha)
            progress.tick()

    df = pd.DataFrame({
        'time':  pd.to_datetime(ts_list, unit='s', utc=True),
        'alpha': pd.to_numeric(alpha_list, errors='coerce'),
    }).set_index('time').sort_index()
    return df[~df.index.duplicated(keep='first')]


def _fetch_alpha(endpoint, params, headers, start, end):
    slug = endpoint.split('/')[0]
    return _extend_cache_monthly(
        slug, params,
        lambda s, e: _fetch_alpha_raw(endpoint, params, headers, s, e),
        start, end,
    )


def fetch_holder_concentration(symbol, interval, start, end, headers):
    """籌碼集中度 Holder Concentration. Returns DataFrame with 'alpha' column."""
    return _fetch_alpha('holder_concentration/get_alpha',
                        {'symbol': symbol, 'period': interval}, headers, start, end)


def fetch_funding_rate(symbol, interval, start, end, headers, exchange='binance'):
    """資金費率 Funding Rate. Returns DataFrame with 'alpha' column (alpha = funding rate × 100).
    exchange: 'binance' (default) / 'okx' / 'bingx' / 'bybit' — the perp whose funding is read;
    close price is always the Binance perp."""
    params = {'symbol': symbol, 'period': interval}
    # default omitted so the cache dir of every existing Binance fetch stays valid
    if exchange != 'binance':
        params['exchange'] = exchange
    return _fetch_alpha('funding_rate/get_alpha', params, headers, start, end)


def fetch_taker_intensity(symbol, interval, start, end, headers, timeframe='24h'):
    """多空力道 Taker Intensity. Returns DataFrame with 'alpha' column."""
    return _fetch_alpha('taker_intensity/get_alpha',
                        {'symbol': symbol, 'period': interval, 'timeframe': timeframe},
                        headers, start, end)


def fetch_whale_hunter(symbol, interval, start, end, headers, timeframe='24h', score_type='score_oi'):
    """巨鯨警報 Whale Hunter. Returns DataFrame with 'alpha' column."""
    return _fetch_alpha('whale_hunter/get_alpha',
                        {'symbol': symbol, 'period': interval,
                         'timeframe': timeframe, 'score_type': score_type},
                        headers, start, end)


def fetch_unusual_movement(symbol, interval, start, end, headers, timeframe='24h'):
    """異常漲跌 Unusual Movement. Returns DataFrame with 'alpha' column."""
    return _fetch_alpha('unusual_movement/get_alpha',
                        {'symbol': symbol, 'period': interval, 'timeframe': timeframe},
                        headers, start, end)


def fetch_squeeze_momentum(symbol, start, end, headers):
    """擠壓動能 Squeeze Momentum (period fixed to 1d). Returns DataFrame with 'alpha' column."""
    return _fetch_alpha('squeeze_momentum/get_alpha',
                        {'symbol': symbol, 'period': '1d'}, headers, start, end)


def fetch_liquidation(symbol, interval, start, end, headers, timeframe='24h'):
    """爆倉指標 Liquidation. Returns DataFrame with 'alpha' column."""
    return _fetch_alpha('liquidation/get_alpha',
                        {'symbol': symbol, 'period': interval, 'timeframe': timeframe},
                        headers, start, end)


def fetch_liquidation_coin(symbol, headers):
    """每幣爆倉 Liquidation by coin — one coin's forced liquidations across the exchange
    feeds Blave collects (binance / bybit / gate / okx / htx / bitfinex), as USD notional.
    Returns a dict — NOT a DataFrame, since it is a point-in-time snapshot with no date
    range to index on:
      windows{'1'|'4'|'12'|'24'}: rolling window ending at the latest 5-minute bucket —
        total_liq_usd / long_liq_usd / short_liq_usd, long_pct / short_pct (None when the
        window is 0), covered_hours, by_exchange{name: {total/long/short_liq_usd}} (an
        exchange with no event in the window has no key)
      series: bucket_seconds=3600, points = 24 hourly {ts, long_liq_usd, short_liq_usd},
        old → new on clock hours, the last one = the current hour so far (zeros, never gaps)
      exchanges[]: exchange, listed (True / False / None = unknown), last_event_at,
        price_basis, coverage, time_basis — every feed, including ones with no event
      rank (1–50 by 24 h total across exchanges, else None), detail_complete (False when
        the coin may have been cut from a full bucket → windows can under-count),
        updated_at
    `windows['24']` is the same rolling frame as the exchange matrix (same number for the
    same coin); `series` is clock hours, so Σ points ≠ windows['24'] by design — read
    totals from windows, timing from points.
    `symbol` accepts BTC / BTCUSDT / btc. Returns None for a symbol no feed lists (the
    API's 404). A 503 (upstream feed not answering) propagates as requests.HTTPError after
    _retry_get's backoff. No local cache — the server holds a 5-minute cache; every call
    means "now"."""
    try:
        r = _retry_get(f'{BASE}/liquidation/get_coin', headers=headers,
                       params={'symbol': symbol}, timeout=30)
    except requests.exceptions.HTTPError as e:
        if e.response is not None and e.response.status_code == 404:
            return None
        raise
    return r.json().get('data', {})


def _raw_snapshot(endpoint, headers, params=None, allow_404=False):
    """Shared GET for the raw cross-exchange snapshot endpoints (long/short ratio, open
    interest, CVD, liquidation matrix). No local cache — the server holds the snapshot;
    every call means "now". A 503 (the scheduled job has no fresh result / a feed is
    silent) propagates as requests.HTTPError after _retry_get's backoff: an empty table
    would read as "nothing is happening", which is a different claim from "unknown".
    allow_404 → None for a coin no source collects (an answer, not an error)."""
    try:
        r = _retry_get(f'{BASE}/{endpoint}', headers=headers, params=params, timeout=30)
    except requests.exceptions.HTTPError as e:
        if allow_404 and e.response is not None and e.response.status_code == 404:
            return None
        raise
    return r.json().get('data', {})


def fetch_long_short_ratio_table(headers):
    """多空比總表 Long/short ratio (GET /long_short_ratio/get_table), every coin × every source, latest cross-section.
    Returns a dict — a point-in-time snapshot, not a time series:
      coins[]: token, token_id, and one ratio per source key (null when that exchange has
        no such feed for the coin). Ordered by Binance open-interest notional
      sources[]: the 10 feeds — exchange, key, type ('account' / 'top_account' /
        'top_position'), last_at, stale. Binance / OKX / Gate publish all three types,
        Bybit only 'account'. **Read `sources[]`, never a hard-coded key list.**
      summary{binance_long_majority, binance_tokens}, tokens_shown / tokens_total, full,
        updated_at
    The ratio is longs ÷ shorts; long share = r / (1 + r), computed by the caller.
    **"Top trader" means something different at each exchange** — Binance = the top 20 %
    of users by margin balance, OKX = the top 5 % of traders by open-position value, Gate
    has never published its rule. So `binance_top_account` and `okx_top_account` are not
    comparable as levels; compare each source against its own history instead.
    Only coins that resolve to a CoinMarketCap crypto are listed. An API key sees every
    row (`full: true`); anonymous callers get 30."""
    return _raw_snapshot('long_short_ratio/get_table', headers)


def fetch_long_short_ratio_coin(symbol, headers):
    """一檔幣的多空比 — one coin's long/short ratio per source (GET /long_short_ratio/get_coin). Returns a dict:
      latest{<source key>: {ts, value}}: newest 5-minute sample of each source
      series: bucket_seconds=3600, days=7, timestamp[] (epoch seconds, 168 slots,
        old → new), one array per source key (last sample of each hour, null for an hour
        with no sample), price[] (Binance perp close on the same frame, null when the coin
        has no Binance perp) with price_symbol / price_multiplier, and provisional_from
        (first slot that can still change)
      sources[]: the full roster — exchange, key, type, listed (False = that exchange has
        no such feed for this coin, its array is all null), last_at, stale
      symbol, token_id, updated_at (the newest source; it says nothing about the others —
        judge a single source by its own `last_at` / `stale`)
    `symbol` accepts BTC / BTCUSDT / btc. Returns None for a coin no source collects (the
    API's 404); 503 (a listed source unreadable) propagates as requests.HTTPError."""
    return _raw_snapshot('long_short_ratio/get_coin', headers,
                         {'symbol': symbol}, allow_404=True)


def fetch_open_interest_table(headers):
    """未平倉量總表 Open interest (GET /oi_imbalance/get_table — the path still carries the
    old "imbalance" name; this is the RAW table, not that indicator, see below), every coin
    × 5 exchanges, in USD notional.
    Basis: USDT-margined perpetuals only, USD notional, one-sided — an exchange that
    reports both sides is halved (`exchanges[].side_factor`, Gate = 0.5). Returns a dict:
      coins[]: token, token_id, oi_total (USD, summed across exchanges), chg_1h / chg_4h /
        chg_24h (decimal fractions, null when no exchange has a baseline at that window's
        start), market_cap, oi_mcap (= oi_total ÷ market cap), by_exchange{name: {oi,
        chg_1h, chg_4h, chg_24h}}
      exchanges[]: binance / okx / bingx / bybit / gate — whole-market oi, side_factor,
        since + full_7d (False = that feed started less than 7 days ago), last_at, stale
      total{oi, chg_*, n_exchanges, n_full_7d}, summary{oi_mcap_leader,
        oi_mcap_leader_value}, tokens_shown / tokens_total, full, updated_at
    Each exchange's value is already USD notional, so 1000PEPE-style multiplied contracts
    add up across exchanges without rescaling.
    **`oi_total` / `oi_mcap` here are NOT the "OI 失衡" indicator** (`/oi_imbalance/
    get_overview_data`, Binance + OKX + BingX only) — two different numbers; a threshold
    tuned on one does not carry over to the other.
    Built by a scheduled job, so this is not a per-second feed; a stale result is a 503,
    never a table of zeros. API key sees every row; anonymous callers get 30."""
    return _raw_snapshot('oi_imbalance/get_table', headers)


def fetch_open_interest_coin(symbol, headers):
    """一檔幣的未平倉量 — one coin's open interest per exchange (GET /oi_imbalance/get_coin;
    same basis as fetch_open_interest_table). Returns a dict:
      exchanges[]: the full roster — key, oi (USD), share, chg_1h / chg_4h / chg_24h /
        chg_7d, side_factor, listed (False = not listed there, values null), since /
        full_7d, last_at, stale
      oi_total, market_cap, oi_mcap, oi_mcap_rank / tokens_total (from the table job's last
        round; null when it has no fresh result)
      windows{'1h','4h','24h','7d'}: chg, chg_usd, and `exchanges` = which exchanges were
        counted in that window (only those with a baseline at its start — numerator and
        denominator over the same set, so 24h and 7d can count fewer exchanges than 1h)
      series: bucket_seconds=3600, days=7, timestamp[] (epoch seconds, 168 slots),
        total[] (only the `total_exchanges` — the feeds with a full 7 days — are in this
        line), total_exchanges[], price[] + price_symbol / price_multiplier,
        provisional_from
      symbol, token_id, updated_at
    `symbol` accepts BTC / BTCUSDT / btc. 404 → None; 503 propagates."""
    return _raw_snapshot('oi_imbalance/get_coin', headers,
                         {'symbol': symbol}, allow_404=True)


def fetch_cvd_table(headers):
    """主動買賣淨額總表 CVD (cumulative volume delta; GET /taker_intensity/get_cvd_table), every coin × 3 exchanges, USD.
    Basis: each exchange's own reported taker turnover, never volume × a borrowed price —
    Binance = the 5-minute kline's taker-buy quote volume (sell = the bar's total minus
    it), OKX = its USD taker volume, Gate = taker contracts × the same row's multiplier
    and mark price. Perpetuals only: **no spot, and not trade-by-trade**. Returns a dict:
      coins[]: token, token_id, buy_24h / sell_24h, net_1h / net_4h / net_24h (USD;
        net = buy − sell), by_exchange{name: {buy_24h, sell_24h, net_1h, net_4h, net_24h}}
      exchanges[]: binance / okx / gate — whole-market buy_24h / sell_24h / net_24h,
        last_at, stale. A feed more than an hour behind answers null windows and
        `stale: true` rather than a sum that quietly covers less than the window; the
        totals then add only the fresh exchanges
      total{buy_24h, sell_24h, net_24h}, tokens_shown / tokens_total, full, updated_at
    Windows are rolling, ending at the last closed bar. Built by a scheduled job; a stale
    result is a 503, never zeros. API key sees every row; anonymous callers get 30."""
    return _raw_snapshot('taker_intensity/get_cvd_table', headers)


def fetch_cvd_coin(symbol, headers):
    """一檔幣的主動買賣淨額 — one coin's CVD per exchange (GET /taker_intensity/get_cvd_coin;
    same basis as fetch_cvd_table). Returns a dict:
      windows{'1h','4h','24h','7d'}: buy / sell / net in USD, summed over the fresh
        exchanges
      exchanges[]: the full roster — key, listed, windows{...} per exchange, since /
        full_7d (False = fewer than 7 days of history here; its 7d window is null and it
        is left out of the 7d total and of the series), last_at, stale
      series: bucket_seconds=3600, days=7, timestamp[] (epoch seconds, 168 slots), net[]
        (clock-hour sums), cvd[] (running total, cvd[0] = 0), exchanges[] (who is in the
        line), price[] + price_symbol / price_multiplier, provisional_from
      symbol, token_id, updated_at
    `symbol` accepts BTC / BTCUSDT / btc. 404 → None; 503 propagates."""
    return _raw_snapshot('taker_intensity/get_cvd_coin', headers,
                         {'symbol': symbol}, allow_404=True)


def fetch_liquidation_exchanges(headers, hours=24, top_n=10):
    """爆倉矩陣 (GET /liquidation/get_exchanges) — forced liquidations aggregated across exchanges for the whole market,
    as the coin × exchange matrix behind fetch_liquidation_coin. USD notional is converted
    at collection time, so exchanges can be added up. Returns a dict:
      exchanges[]: binance / bybit / gate / okx / htx / bitfinex — total / long /
        short_liq_usd, long_pct / short_pct, events, last_event_at, and the two basis
        columns (price_basis, coverage, time_basis) that say how comparable a row is
      coins[]: the top `top_n` by cross-exchange total — token, token_id, total / long /
        short_liq_usd, by_exchange{name: {total/long/short_liq_usd}}
      others{total/long/short_liq_usd, by_exchange, coin_count}: everything the top_n cut
        off, so coins[] + others adds back up to each exchange's total
      total{total/long/short_liq_usd, long_pct, short_pct}, covered_hours, buckets,
        window_hours / window_start / window_end, updated_at
    `long_liq_usd` = long positions liquidated (price fell), `short_liq_usd` = shorts.
    The window is rolling, aligned to 5-minute buckets — the same frame as
    fetch_liquidation_coin's `windows`, so a coin's 24 h total matches on both.
    `hours` 1–168 and `top_n` 1–50; outside that the API answers 400 (it does not clamp).
    No local cache — the server caches 5 minutes."""
    return _raw_snapshot('liquidation/get_exchanges', headers,
                         {'hours': hours, 'top_n': top_n})


def fetch_market_direction(interval, start, end, headers):
    """市場方向 Market Direction (market-wide, no symbol). Returns DataFrame with 'alpha' column."""
    return _fetch_alpha('market_direction/get_alpha',
                        {'period': interval}, headers, start, end)


def fetch_capital_shortage(interval, start, end, headers):
    """資金稀缺 Capital Shortage (market-wide, no symbol). Returns DataFrame with 'alpha' column."""
    return _fetch_alpha('capital_shortage/get_alpha',
                        {'period': interval}, headers, start, end)


def fetch_market_sentiment(symbol, interval, start, end, headers):
    """市場情緒 Market Sentiment. Returns DataFrame with 'alpha' column."""
    return _fetch_alpha('market_sentiment/get_alpha',
                        {'symbol': symbol, 'period': interval}, headers, start, end)


def fetch_top_trader_exposure(interval, start, end, headers):
    """Blave頂尖交易員曝險 Top Trader Exposure (market-wide, no symbol). Returns DataFrame with 'alpha' column."""
    return _fetch_alpha('blave_top_trader/get_exposure',
                        {'period': interval}, headers, start, end)


_ALPHA_FETCHERS = (
    'fetch_holder_concentration', 'fetch_funding_rate', 'fetch_taker_intensity',
    'fetch_whale_hunter', 'fetch_unusual_movement', 'fetch_squeeze_momentum',
    'fetch_liquidation', 'fetch_market_direction', 'fetch_capital_shortage',
    'fetch_market_sentiment', 'fetch_top_trader_exposure',
)


class UnknownFetcher(ImportError):
    """A guessed fetcher name (`fetch_alpha`, `get_alpha`, `fetch_indicator`, a misspelt
    `fetch_<alpha>`): the message lists the real alpha fetchers with their signatures.
    ImportError on purpose — `from lib.data import fetch_alpha` (the agent's usual first
    guess) swallows an AttributeError raised by a module __getattr__ and prints only the
    bare `cannot import name`; an ImportError propagates as is. Cost: hasattr(lib.data,
    'fetch_<missing>') raises instead of answering False — no caller does that."""


def __getattr__(name):
    if name.startswith('__') or not (name.startswith(('fetch_', 'get_'))
                                     or 'alpha' in name or 'indicator' in name):
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    import inspect
    sigs = '; '.join(f'{n}{inspect.signature(globals()[n])}' for n in _ALPHA_FETCHERS)
    raise UnknownFetcher(
        f"lib.data has no {name!r}. There is no generic alpha fetcher — each Blave alpha has "
        f"its own function (all return a DataFrame with an 'alpha' column; 'headers' is the "
        f"api-key/secret-key dict, see references/lib.md > 'Alpha fetchers - quick reference'): "
        f"{sigs}", name=__name__)


# ── CME / NYMEX / ICE futures (via /studio/market/db) ────────────────────────

_DB_CHUNK_DAYS = {'ohlcv-1m': 28, 'ohlcv-1h': 365, 'ohlcv-1d': 3650}


def _fetch_db_raw(dataset, symbol, schema, start, end, headers):
    """Fetch OHLCV — chunks fetched concurrently, chunk size by schema."""
    from concurrent.futures import ThreadPoolExecutor, as_completed

    _check_data_access(headers)
    s    = datetime.strptime(start, '%Y-%m-%d')
    e    = datetime.utcnow() if not end else datetime.strptime(end, '%Y-%m-%d')
    days = _DB_CHUNK_DAYS.get(schema, 30)

    chunks, cursor = [], s
    while cursor < e:
        chunk_end = min(cursor + timedelta(days=days), e)
        chunks.append((cursor.strftime('%Y-%m-%d'), chunk_end.strftime('%Y-%m-%d')))
        cursor = chunk_end

    def _fetch_one(cs, ce):
        import time as _time
        for attempt in range(3):
            try:
                r = requests.get(
                    f'{BASE}/studio/market/db/ohlcv/{dataset}/{symbol}/{schema}',
                    headers=headers,
                    params={'start': cs, 'end': ce},
                    timeout=120,
                )
                r.raise_for_status()
                return r.json().get('data', [])
            except Exception:
                if attempt == 2:
                    raise
                _time.sleep(2 ** attempt)

    rows = []
    with ThreadPoolExecutor(max_workers=5) as pool:
        futures = {pool.submit(_fetch_one, cs, ce): (cs, ce) for cs, ce in chunks}
        for future in as_completed(futures):
            rows.extend(future.result())

    df = pd.DataFrame(rows)
    if df.empty:
        return df
    df['time'] = pd.to_datetime(df['ts'], utc=True)
    df = df.set_index('time').sort_index()
    df = df[~df.index.duplicated(keep='first')]
    df = df.rename(columns={'open': 'Open', 'high': 'High', 'low': 'Low',
                             'close': 'Close', 'volume': 'Volume'})
    ohlcv = df[['Open', 'High', 'Low', 'Close', 'Volume']].astype(float)
    if 'instrument_id' in df.columns:
        ohlcv['instrument_id'] = df['instrument_id'].values
    return ohlcv


def settlement_signals_from_db(df, signal):
    """Force signal=0.0 on last bar before each instrument_id rollover (contract expiry).

    Returns (signal, exec_at_close) where exec_at_close is a bool Series marking
    settlement bars — those bars execute at this-bar close, not next-bar open.
    If instrument_id column is absent, exec_at_close is all-False.
    """
    import pandas as pd
    exec_at_close = pd.Series(False, index=df.index)
    if 'instrument_id' not in df.columns:
        return signal, exec_at_close
    changes = (df['instrument_id'] != df['instrument_id'].shift(1)).values
    for i, changed in enumerate(changes):
        if changed and i > 0:
            signal.iloc[i - 1]       = 0.0
            exec_at_close.iloc[i - 1] = True
    return signal, exec_at_close


def fetch_db_kline(dataset, symbol, schema, start, end, headers):
    """Fetch CME/NYMEX/ICE OHLCV with local cache."""
    slug = schema.replace('-', '')
    df = _extend_cache_monthly(
        f'db_{slug}', {'dataset': dataset.replace('.', ''), 'symbol': symbol},
        lambda s, e: _fetch_db_raw(dataset, symbol, schema, s, e, headers),
        start, end,
    )
    return _sanity_check_ohlc(df, f'{symbol} {schema} db_kline')


# ── Taiwan stock data ─────────────────────────────────────────────────────────

# ── Daily bars straight from the exchanges (free, no key) ─────────────────────
# 資料來源:臺灣證券交易所、證券櫃檯買賣中心(政府資料開放授權)
# The daily bar travels source → this machine only, never through a Blave server: Blave
# ships the code (as the twstock package does), the user fetches public data for their own
# use. Both sites' terms exempt their open-data sets and ask that the source be named —
# _TW_PUBLIC_SOURCE_ZH is the line a report must carry. One request answers one stock-
# month, which is the monthly cache's own unit; neither site documents a rate limit, so
# everything here (FinMind included) goes through one shared 1 request/s throttle.
_TWSE_STOCK_DAY      = 'https://www.twse.com.tw/exchangeReport/STOCK_DAY'
_TWSE_STOCK_DAY_ALL  = 'https://www.twse.com.tw/exchangeReport/STOCK_DAY_ALL'
_TWSE_EXRIGHT        = 'https://www.twse.com.tw/rwd/zh/exRight/TWT49U'
_TPEX_TRADING_STOCK  = 'https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock'
_TPEX_MAINBOARD      = 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes'
_TPEX_EXRIGHT        = 'https://www.tpex.org.tw/www/zh-tw/bulletin/exDailyQ'
_FINMIND_DATA        = 'https://api.finmindtrade.com/api/v4/data'
_TWSE_STOCK_DAY_FROM = '2010-01'      # STOCK_DAY: 「查詢日期小於99年1月4日」 before this
_TW_PUBLIC_SOURCE_ZH = '資料來源:臺灣證券交易所、證券櫃檯買賣中心(政府資料開放授權)'
_TW_PUBLIC_SOURCE_EN = 'Source: Taiwan Stock Exchange, Taipei Exchange (Open Government Data License)'
_TW_PUBLIC_HEADERS   = {'User-Agent': 'Mozilla/5.0 (compatible; blave-agent; +https://blave.org)'}
_TW_PUBLIC_LIMITER   = _RateLimiter(1, 1.0)
# twse.com.tw on its own, slower bucket: it blocks an IP at roughly one request a second (no
# published number), and the IP it blocks is the user's home connection.
_TWSE_LIMITER        = _RateLimiter(1, 3.0)
_TW_PUBLIC_SESSION   = None
_TW_DAILY_COLS       = ['Open', 'High', 'Low', 'Close', 'Volume']
_TW_EXRIGHT_COLS     = ['stock_id', 'prev_close', 'ref_price']


class TwPublicUnavailable(RuntimeError):
    """The key-free path could not serve this request (site down, layout changed, blocked,
    or the id is on neither exchange) — the caller moves on to the next source."""


def _twstock_daily_source():
    """'public' (exchange → FinMind free → Blave) or 'blave' (the Blave endpoint only).

    The free sources run only on the user's own computer: the desktop build marks itself
    with BLAVE_AGENT_LOCAL=1 (shell/daemon.js, runtime/agent_turn.py — the same flag
    lib/venue.py reads), and there the chain is the default; a cloud fleet machine (flag
    absent) stays on Blave exactly as before, so no Blave server ever hits twse.com.tw,
    tpex.org.tw or FinMind. BLAVE_TWSTOCK_DAILY_SOURCE=public|blave overrides either way."""
    forced = os.environ.get('BLAVE_TWSTOCK_DAILY_SOURCE', '').strip().lower()
    if forced in ('public', 'blave'):
        return forced
    return 'public' if os.environ.get('BLAVE_AGENT_LOCAL') == '1' else 'blave'


def _tw_public_session():
    global _TW_PUBLIC_SESSION
    if _TW_PUBLIC_SESSION is None:
        _TW_PUBLIC_SESSION = requests.Session()
    return _TW_PUBLIC_SESSION


def _tw_public_get(url, params, tries=3):
    """One throttled GET at an exchange site or FinMind. Timeouts, connection errors, 429
    and 5xx are retried twice with a short backoff; anything else raises — there is no
    per-user quota worth waiting on, and the caller has further sources to try."""
    limiter = _TWSE_LIMITER if '.twse.com.tw/' in url else _TW_PUBLIC_LIMITER
    for attempt in range(tries):
        limiter.acquire()
        try:
            r = _tw_public_session().get(url, params=params, headers=_TW_PUBLIC_HEADERS, timeout=30)
        except (requests.exceptions.Timeout, requests.exceptions.ConnectionError):
            if attempt == tries - 1:
                raise
            time.sleep(2 ** (attempt + 1))
            continue
        if (r.status_code == 429 or r.status_code >= 500) and attempt < tries - 1:
            time.sleep(2 ** (attempt + 1))
            continue
        r.raise_for_status()
        return r


def _roc_date(s):
    """民國 date '113/01/02' or '112年03月16日' → Timestamp 2024-01-02 / 2023-03-16."""
    parts = [p for p in s.replace('年', '/').replace('月', '/').replace('日', '').split('/') if p.strip()]
    y, m, d = (int(p) for p in parts[:3])
    return pd.Timestamp(year=y + 1911, month=m, day=d)


def _tw_num(s):
    """'27,997,826' → 27997826.0, '+3.00' → 3.0; '--' (no trade), blank or 全形空白 → NaN."""
    try:
        return float(str(s).replace(',', '').replace('　', '').strip())
    except ValueError:
        return float('nan')


def _tw_daily_frame(rows):
    """rows (date, open, high, low, close, shares) → the fetch_twstock_price frame: naive
    Taipei dates, floats, zero/blank prices forward-filled exactly as the Blave path does."""
    if not rows:
        return pd.DataFrame(columns=_TW_DAILY_COLS)
    df = pd.DataFrame(rows, columns=['date'] + _TW_DAILY_COLS).set_index('date').sort_index()
    return df.astype(float).replace(0, float('nan')).ffill()


def _twse_stock_day(stock_id, ym):
    """One TWSE stock-month (STOCK_DAY, date=YYYYMM01). Empty when the month has no rows
    for the id; any other non-OK answer raises so it can never be cached as an empty month."""
    r = _tw_public_get(_TWSE_STOCK_DAY, {'response': 'json', 'date': f'{ym[:4]}{ym[5:7]}01',
                                         'stockNo': stock_id})
    j = r.json()
    stat = str(j.get('stat', ''))
    if stat != 'OK':
        if '沒有符合條件' in stat:
            return _tw_daily_frame([])
        raise TwPublicUnavailable(f'TWSE STOCK_DAY {stock_id} {ym}: {stat[:60]}')
    # 日期, 成交股數, 成交金額, 開盤價, 最高價, 最低價, 收盤價, …
    return _tw_daily_frame([(_roc_date(x[0]), _tw_num(x[3]), _tw_num(x[4]), _tw_num(x[5]),
                             _tw_num(x[6]), _tw_num(x[1])) for x in j.get('data', [])])


def _tpex_trading_stock(stock_id, ym):
    """One TPEx stock-month (tradingStock, date=YYYY/MM/01). 成交仟股 → shares (×1,000, so
    volume is rounded to the thousand — TWSE and FinMind carry exact shares)."""
    r = _tw_public_get(_TPEX_TRADING_STOCK, {'code': stock_id, 'date': f'{ym[:4]}/{ym[5:7]}/01',
                                             'response': 'json'})
    tables = r.json().get('tables') or []
    if not tables:
        raise TwPublicUnavailable(f'TPEx tradingStock {stock_id} {ym}: no tables in the answer')
    # 日 期, 成交仟股, 成交仟元, 開盤, 最高, 最低, 收盤, …
    return _tw_daily_frame([(_roc_date(x[0]), _tw_num(x[3]), _tw_num(x[4]), _tw_num(x[5]),
                             _tw_num(x[6]), _tw_num(x[1]) * 1000) for x in tables[0].get('data', [])])


def _tw_public_months(start, end):
    """The 'YYYY-MM' months whose first day is in [start, end) — `end` exclusive, as
    _extend_cache_monthly passes it — and not past the current Taipei month."""
    last = datetime.now(_TPE).strftime('%Y-%m')
    return [ym for ym in _iter_months(start, end) if f'{ym}-01' < end and ym <= last]


def _fetch_twstock_daily_public_raw(stock_id, market, start, end):
    fetch = _twse_stock_day if market == 'twse' else _tpex_trading_stock
    frames = [f for f in (fetch(stock_id, ym) for ym in _tw_public_months(start, end)) if not f.empty]
    return pd.concat(frames) if frames else _tw_daily_frame([])


def _tw_market_file():
    return _CACHE_DIR / 'twstock_public_market.json'


def _twse_all_codes():
    r = _tw_public_get(_TWSE_STOCK_DAY_ALL, {'response': 'open_data'})
    rows = list(csv.reader(io.StringIO(r.content.decode('utf-8-sig'))))
    if not rows or '證券代號' not in rows[0]:
        raise TwPublicUnavailable('TWSE STOCK_DAY_ALL: unexpected layout')
    col = rows[0].index('證券代號')
    return sorted({row[col].strip() for row in rows[1:] if len(row) > col})


def _tpex_all_codes():
    r = _tw_public_get(_TPEX_MAINBOARD, {})
    codes = {str(x.get('SecuritiesCompanyCode', '')).strip() for x in r.json()} - {''}
    if not codes:
        raise TwPublicUnavailable('TPEx mainboard quotes: no rows')
    return sorted(codes)


def _tw_public_market(stock_id):
    """'twse' / 'tpex' from the exchanges' latest full-market files (TWSE STOCK_DAY_ALL open
    data, TPEx mainboard quotes — the two daily sets registered on data.gov.tw), or the
    market an earlier probe settled on; None when the id is in neither (delisted or
    unknown). A hit in a stale file still counts — listing status does not flip overnight —
    so the two files are re-fetched only on a miss, at most once a day."""
    path = _tw_market_file()
    try:
        data = json.loads(path.read_text())
    except Exception:
        data = {}

    def _lookup():
        for m in ('twse', 'tpex'):
            if stock_id in data.get(m, ()):
                return m
        return data.get('resolved', {}).get(stock_id)

    market = _lookup()
    day_ago = (datetime.utcnow() - timedelta(days=1)).strftime(_META_TS_FMT)
    if market is None and data.get('fetched_at', '') < day_ago:
        data.update(twse=_twse_all_codes(), tpex=_tpex_all_codes(),
                    fetched_at=datetime.utcnow().strftime(_META_TS_FMT))
        _write_market_file(data)
        market = _lookup()
    return market


def _write_market_file(data):
    path = _tw_market_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f'{path.name}.{os.getpid()}.tmp')
    tmp.write_text(json.dumps(data, ensure_ascii=False))
    os.replace(tmp, path)


def _tw_public_probe_market(stock_id, ym):
    """Neither exchange lists the id today (delisted?): ask each for the first requested
    month, and the one with rows is the market — remembered so this runs once per id."""
    for market, fetch in (('twse', _twse_stock_day), ('tpex', _tpex_trading_stock)):
        if market == 'twse' and ym < _TWSE_STOCK_DAY_FROM:
            continue
        if not fetch(stock_id, ym).empty:
            try:
                data = json.loads(_tw_market_file().read_text())
            except Exception:
                data = {}
            data.setdefault('resolved', {})[stock_id] = market
            _write_market_file(data)
            return market
    raise TwPublicUnavailable(f'{stock_id}: no rows on TWSE or TPEx for {ym}')


def _twse_exright_rows(year, end_day):
    r = _tw_public_get(_TWSE_EXRIGHT, {'response': 'json', 'startDate': f'{year}0101',
                                       'endDate': end_day.replace('-', '')})
    j = r.json()
    stat = str(j.get('stat', ''))
    if stat != 'OK':
        if '沒有符合條件' in stat:
            return []
        raise TwPublicUnavailable(f'TWSE TWT49U {year}: {stat[:60]}')
    # 資料日期, 股票代號, 股票名稱, 除權息前收盤價, 除權息參考價, …
    return [(_roc_date(x[0]), x[1].strip(), _tw_num(x[3]), _tw_num(x[4])) for x in j.get('data', [])]


def _tpex_exright_rows(year, end_day):
    r = _tw_public_get(_TPEX_EXRIGHT, {'startDate': f'{year}/01/01', 'endDate': end_day.replace('-', '/'),
                                       'response': 'json'})
    tables = r.json().get('tables') or []
    if not tables:
        raise TwPublicUnavailable(f'TPEx exDailyQ {year}: no tables in the answer')
    # 除權息日期, 代號, 名稱, 除權息前收盤價, 除權息參考價, …
    return [(_roc_date(x[0]), x[1].strip(), _tw_num(x[3]), _tw_num(x[4])) for x in tables[0].get('data', [])]


def _tw_exright_events(market, start, end):
    """The exchange's whole-market 除權息計算結果表 (TWSE TWT49U / TPEx exDailyQ) rows with
    ex-dates in [start, end]: index = ex-date, columns stock_id / prev_close / ref_price.
    One parquet per month under cache/twstock_exright_{market}/: a past month is fetched
    once (completed once if written before the month ended, like every monthly cache), the
    current month re-fetched when older than an hour. Both sites answer a whole year per
    request, so a missing month costs one request and fills the year's other months too."""
    cache_dir = _CACHE_DIR / f'twstock_exright_{market}'
    cache_dir.mkdir(parents=True, exist_ok=True)
    today = datetime.now(_TPE)
    current_ym = today.strftime('%Y-%m')
    end_str = end or today.strftime('%Y-%m-%d')
    months = [ym for ym in _iter_months(start, end_str) if ym <= current_ym]

    def _needs(ym):
        path = cache_dir / f'{ym}.parquet'
        if not path.exists():
            return True
        if ym < current_ym:
            return _written_before_month_end(path, ym)
        return time.time() - path.stat().st_mtime > 3600

    rows_of = _twse_exright_rows if market == 'twse' else _tpex_exright_rows
    for year in sorted({ym[:4] for ym in months if _needs(ym)}):
        rows = rows_of(year, min(f'{year}-12-31', today.strftime('%Y-%m-%d')))
        df = pd.DataFrame(rows, columns=['date'] + _TW_EXRIGHT_COLS)
        df = df.astype({'stock_id': str, 'prev_close': float, 'ref_price': float})
        df.index = pd.DatetimeIndex(df.pop('date'), name='date')
        for ym in _iter_months(f'{year}-01', min(f'{year}-12', current_ym)):
            _atomic_to_parquet(df[df.index.strftime('%Y-%m') == ym], cache_dir / f'{ym}.parquet')
    frames = [pd.read_parquet(cache_dir / f'{ym}.parquet') for ym in months]
    out = pd.concat(frames) if frames else pd.DataFrame(columns=_TW_EXRIGHT_COLS)
    return out[(out.index >= pd.Timestamp(start)) & (out.index <= pd.Timestamp(end_str))]


def _tw_exright_for(stock_id, market, start, end):
    markets = (market,) if market else ('twse', 'tpex')
    events = pd.concat([_tw_exright_events(m, start, end) for m in markets])
    return events[events['stock_id'] == stock_id]


def _tw_forward_adjust(df, events):
    """後復權 by the api's forward_adjust rule (api/tw/twstock/adjuster.py): rows before an
    ex-date keep their price, rows from the ex-date on are multiplied by 除權息前收盤價 ÷
    除權息參考價. For cash and stock dividends that is prev_close × (1 + stock_ratio) ÷
    (prev_close − cash), the Blave factor; the exchange tables also carry other ex-rights
    events (現金增資 and the like) that Blave's adjustment leaves out, so from such a date
    the two series differ by that event's factor. An event with no bar before it in the
    frame is skipped and OHLC is rounded to 2, both as there."""
    factor = pd.Series(1.0, index=df.index)
    for ex_date, prev_close, ref in events[['prev_close', 'ref_price']].sort_index().itertuples():
        if not (prev_close > 0 and ref > 0) or ex_date <= df.index[0]:
            continue
        factor[df.index >= ex_date] *= prev_close / ref
    out = df.copy()
    cols = [c for c in ('Open', 'High', 'Low', 'Close') if c in out.columns]
    out[cols] = out[cols].mul(factor, axis=0).round(2)
    return out


def _fetch_twstock_daily_public(stock_id, start, end, adjust=False):
    """Daily OHLCV for one stock from its own exchange — TWSE STOCK_DAY (listed, 2010-01-04
    on) or TPEx tradingStock (OTC) — month by month through the monthly cache: a past month
    is fetched once, the current month re-fetched per call. adjust=True forward-adjusts with
    the exchange's 除權息計算結果表 (_tw_forward_adjust). Raises TwPublicUnavailable / a
    requests error when the exchange cannot serve it; the caller falls back."""
    # A window that has not happened yet (end left to us, start past Taipei tomorrow) is an
    # empty answer, not a request — the same rule as _extend_cache_single.
    if end is None and (datetime.now(_TPE) + timedelta(days=1)).strftime('%Y-%m-%d') < start:
        df = _tw_daily_frame([])
        df.attrs['source'] = 'TWSE/TPEx'
        return df
    market = _tw_public_market(stock_id) or _tw_public_probe_market(stock_id, start[:7])
    if market == 'twse' and start[:7] < _TWSE_STOCK_DAY_FROM:
        raise TwPublicUnavailable(f'TWSE STOCK_DAY has no data before 2010-01-04 (asked from {start})')
    df = _extend_cache_monthly(
        'twstock_daily', {'id': stock_id, 'src': market},
        lambda s, e: _fetch_twstock_daily_public_raw(stock_id, market, s, e), start, end,
        # TWSE says 「沒有符合條件」 for a month the id had no rows — and, unverified, maybe
        # when it throttles too; an empty month is re-asked once a day, never cached for good
        empty_marker_ttl_hours=24)
    if adjust and not df.empty:
        df = _tw_forward_adjust(df, _tw_exright_for(stock_id, market, start, end))
    df.attrs['source'] = 'TWSE' if market == 'twse' else 'TPEx'
    return df


def _fetch_twstock_daily_finmind_raw(stock_id, start, end):
    """FinMind free tier, raw TaiwanStockPrice: no token, 300 requests/hour, the whole range
    in one answer, numbers identical to the exchanges'. It has no adjusted series (that is
    the Sponsor tier), so factors still come from the exchanges' tables."""
    r = _tw_public_get(_FINMIND_DATA, {'dataset': 'TaiwanStockPrice', 'data_id': stock_id,
                                       'start_date': start, 'end_date': end})
    j = r.json()
    if j.get('status') != 200:
        raise TwPublicUnavailable(f"FinMind TaiwanStockPrice {stock_id}: {str(j.get('msg'))[:80]}")
    return _tw_daily_frame([(pd.Timestamp(x['date']), x['open'], x['max'], x['min'], x['close'],
                             x['Trading_Volume']) for x in j.get('data', [])])


def _fetch_twstock_daily_free(stock_id, start, end, adjust=False):
    """The two key-free sources in order (exchange, then FinMind free); → frame with
    attrs['source'], or raises when both fail so the caller can try Blave."""
    try:
        return _fetch_twstock_daily_public(stock_id, start, end, adjust)
    except Exception as e:
        print(f"  ⚠️  {stock_id} daily bars: exchange path failed ({type(e).__name__}: "
              f"{str(e)[:120]}) — trying FinMind free")
    df = _extend_cache_monthly(
        'twstock_daily', {'id': stock_id, 'src': 'finmind'},
        lambda s, e: _fetch_twstock_daily_finmind_raw(stock_id, s, e), start, end)
    if adjust and not df.empty:
        df = _tw_forward_adjust(df, _tw_exright_for(stock_id, _tw_public_market(stock_id), start, end))
    df.attrs['source'] = 'FinMind'
    return df


def _twstock_daily(stock_id, start, end, headers, adjust, blave_fn):
    """Source chain for the two daily entries: exchange → FinMind free → Blave (`blave_fn`),
    logging which one served; BLAVE_TWSTOCK_DAILY_SOURCE=blave skips the free ones, and so
    does a malformed `start` — the Blave 400 names the expected format."""
    try:
        datetime.strptime(start, '%Y-%m-%d')
        well_formed = True
    except (TypeError, ValueError):
        well_formed = False
    free_err = None
    if well_formed and _twstock_daily_source() != 'blave':
        try:
            df = _fetch_twstock_daily_free(stock_id, start, end, adjust)
            logging.info('%s daily bars served by %s', stock_id, df.attrs['source'])
            return df
        except Exception as e:
            free_err = e
            print(f"  ⚠️  {stock_id} daily bars: free sources failed ({type(e).__name__}: "
                  f"{str(e)[:120]}) — trying Blave")
    try:
        df = blave_fn()
    except DataAccessError as e:
        # Keep the free chain's failure on the gate error: without it a caller reads "no Blave
        # access" where the true cause is the exchange / FinMind being down.
        if free_err is not None:
            raise e from free_err
        raise
    df.attrs['source'] = 'Blave'
    logging.info('%s daily bars served by Blave', stock_id)
    return df


def _fetch_twstock_price_raw(stock_id, start, end, headers):
    end_str = end or datetime.utcnow().strftime('%Y-%m-%d')
    r = _retry_get(f'{BASE}/studio/market/twstock/price_adj/{stock_id}',
                   headers=headers, params={'start': start, 'end': end_str}, timeout=60)
    data = r.json().get('data', [])
    if not data:
        return pd.DataFrame(columns=['Open', 'Close'])
    df = pd.DataFrame(data)
    df['date'] = pd.to_datetime(df['date'])
    df = df.set_index('date').sort_index()[['open', 'close']].rename(
        columns={'open': 'Open', 'close': 'Close'}).astype(float)
    return df.replace(0, float('nan')).ffill()


def fetch_twstock_price_adj(stock_id, start, end, headers):
    """台股向後調整日K（除權息還原價）. Returns DataFrame with Open/Close columns.
    Use for backtesting — prices are dividend-adjusted so returns are comparable across time.

    Served without a key from the stock's own exchange (TWSE / TPEx, adjusted with their
    除權息計算結果表), then FinMind's free tier, then the Blave endpoint — see
    _fetch_twstock_daily_public; df.attrs['source'] names the one that answered."""
    def _blave():
        return _extend_cache_monthly(
            'twstock_price', {'id': stock_id},
            lambda s, e: _fetch_twstock_price_raw(stock_id, s, e, headers),
            start, end,
        )
    df = _twstock_daily(stock_id, start, end, headers, True, _blave)
    return df[['Open', 'Close']] if {'Open', 'Close'} <= set(df.columns) else df


def _fetch_twstock_price_nonadj_raw(stock_id, start, end, headers):
    end_str = end or datetime.utcnow().strftime('%Y-%m-%d')
    r = _retry_get(f'{BASE}/studio/market/twstock/price/{stock_id}',
                   headers=headers, params={'start': start, 'end': end_str}, timeout=60)
    data = r.json().get('data', [])
    if not data:
        return pd.DataFrame(columns=['Open', 'High', 'Low', 'Close', 'Volume'])
    df = pd.DataFrame(data)
    df['date'] = pd.to_datetime(df['date'])
    cols = [c for c in ['open', 'high', 'low', 'close', 'volume'] if c in df.columns]
    df = df.set_index('date').sort_index()[cols].rename(
        columns={'open': 'Open', 'high': 'High', 'low': 'Low', 'close': 'Close', 'volume': 'Volume'}).astype(float)
    return df.replace(0, float('nan')).ffill()


def fetch_twstock_price(stock_id, start, end, headers):
    """台股原始日K（未除權息）. Returns DataFrame with Open/High/Low/Close/Volume columns.
    Use for visualization/charting — matches prices users see on broker apps.
    Do NOT use for backtesting (dividends cause artificial price drops that distort signals).

    Served without a key from the stock's own exchange (TWSE STOCK_DAY / TPEx tradingStock;
    Volume in shares, TPEx rounded to the thousand), then FinMind's free tier, then the Blave
    endpoint — see _fetch_twstock_daily_public; df.attrs['source'] names the one that
    answered."""
    def _blave():
        return _extend_cache_monthly(
            'twstock_price_nonadj', {'id': stock_id},
            lambda s, e: _fetch_twstock_price_nonadj_raw(stock_id, s, e, headers),
            start, end,
        )
    df = _twstock_daily(stock_id, start, end, headers, False, _blave)
    return _sanity_check_ohlc(df, f'{stock_id} twstock price')


def fetch_twstock_quote(stock_id, headers):
    """台股即時報價快照（約 10 秒更新）. Returns a flat dict — NOT a DataFrame, since a quote
    is a single point-in-time observation with no date range to index on. Keys: open/high/low/close
    (today so far), change_price, change_rate, average_price, volume (latest tick), total_volume
    (day cumulative), amount, total_amount, yesterday_volume, buy_price/buy_volume (best bid),
    sell_price/sell_volume (best ask), volume_ratio, quote_time (full timestamp), stock_id,
    tick_type (0=indeterminate/1=sell-initiated/2=buy-initiated).
    No local cache — the server enforces a 10s Redis TTL; every call means "right now"."""
    r = _retry_get(f'{BASE}/studio/market/twstock/quote/{stock_id}', headers=headers, timeout=30)
    return r.json().get('data', {})


def fetch_twstock_quote_batch(stock_ids, headers):
    """Batch 即時報價（最多 50 檔）. Returns dict {stock_id: quote_dict}, same fields as
    fetch_twstock_quote per entry. No local cache, same as the single-stock version."""
    r = _retry_get(f'{BASE}/studio/market/twstock/quote', headers=headers,
                    params={'stock_ids': ','.join(stock_ids)}, timeout=30)
    return r.json().get('data', {})


# ── Taiwan stock minute-line OHLCV ────────────────────────────────────────────

_TWSTOCK_MINUTE_CHUNK_DAYS = {'1d': 3650, '1m': 28, '5m': 28, '15m': 28, '30m': 28, '60m': 28}
# Server-side per-request range caps — also used as the default lookback window
# when start is omitted, matching the endpoint's own default.
_TWSTOCK_MINUTE_MAX_DAYS = {'1d': 3650, '1m': 31, '5m': 62, '15m': 93, '30m': 186, '60m': 365}


def _fetch_twstock_minute_raw(stock_id, schema, start, end, headers, adjust=False):
    s = datetime.strptime(start, '%Y-%m-%d')
    e = datetime.utcnow() if not end else datetime.strptime(end, '%Y-%m-%d')
    chunk_days = _TWSTOCK_MINUTE_CHUNK_DAYS.get(schema, 28)

    chunks, cursor = [], s
    while cursor < e:
        chunk_end = min(cursor + timedelta(days=chunk_days), e)
        chunks.append((cursor.strftime('%Y-%m-%d'), chunk_end.strftime('%Y-%m-%d')))
        cursor = chunk_end

    def _fetch_one(cs, ce):
        r = _retry_get(
            f'{BASE}/studio/market/twstock/minute/ohlcv/{stock_id}/{schema}',
            headers=headers,
            params={'start': cs, 'end': ce, 'adjust': '1' if adjust else '0'},
            timeout=60,
        )
        return r.json().get('data', [])

    rows = []
    with ThreadPoolExecutor(max_workers=5) as pool:
        futures = {pool.submit(_fetch_one, cs, ce): (cs, ce) for cs, ce in chunks}
        for future in as_completed(futures):
            rows.extend(future.result())

    df = pd.DataFrame(rows)
    if df.empty:
        return df
    df['time'] = pd.to_datetime(df['ts'], utc=True)
    df = df.set_index('time').sort_index()
    df = df[~df.index.duplicated(keep='first')]
    df = df.rename(columns={'open': 'Open', 'high': 'High', 'low': 'Low',
                             'close': 'Close', 'volume': 'Volume'})
    return df[['Open', 'High', 'Low', 'Close', 'Volume']].astype(float)


def fetch_twstock_ohlcv(stock_id, schema, headers, start=None, end=None, adjust=False):
    """台股現股分線 OHLCV. Returns DataFrame with Open/High/Low/Close/Volume columns.

    stock_id: any listed TWSE/TPEx security (e.g. '2330')
    schema: '1d' | '1m' | '5m' | '15m' | '30m' | '60m'
    Volume is in lots (張), NOT shares. Bars carry minute-START labels (UTC
    index); the 13:30 Taipei bar is the closing auction. start/end optional
    (YYYY-MM-DD): omitted end = today, omitted start = end minus the server's
    max window for the schema (1m→31d, 5m→62d, 15m→93d, 30m→186d, 60m→365d,
    1d→3650d).

    adjust=True returns forward-adjusted (後復權) OHLC — use for backtests
    spanning ex-dividend dates; same factor pipeline as fetch_twstock_price_adj
    so the numbers match the Studio daily adjusted series exactly. Volume is
    unchanged. If the factor source is unavailable the server fails loud (503,
    retried then raised here) instead of silently returning raw prices.
    Raw and adjusted bars are cached in separate monthly cache dirs.

    History starts at 2019-01-01 (FinMind TaiwanStockKBar data origin); an
    earlier start is silently clamped to 2019-01-01 so pre-2019 months are
    never queried or cached.

    Server-side, the whole market's history is already backfilled from
    2019-01; only very newly listed stocks are demand-driven — seeded on
    their first-ever query and queued for deep backfill, so that query may
    return only recent data, with full history usually landing by the next
    day. Locally,
    an empty past month is cached with a 24-hour TTL (not permanently): once
    the server has the data, the next query after the TTL re-fetches and
    self-heals the cache.

    For 1d: index is Asia/Taipei tz so df.index[-1].date() returns the correct trading date.
    """
    end_str = end or datetime.utcnow().strftime('%Y-%m-%d')
    if not start:
        lookback = _TWSTOCK_MINUTE_MAX_DAYS.get(schema, 31)
        start = (datetime.strptime(end_str, '%Y-%m-%d')
                 - timedelta(days=lookback)).strftime('%Y-%m-%d')
    if start < '2019-01-01':
        start = '2019-01-01'
    df = _extend_cache_monthly(
        f'twstock_minute_{schema}', {'id': stock_id, 'adj': int(adjust)},
        lambda s, e: _fetch_twstock_minute_raw(stock_id, schema, s, e, headers, adjust=adjust),
        start, end,
        empty_marker_ttl_hours=24,
    )
    df = _sanity_check_ohlc(df, f'{stock_id} {schema} twstock minute')
    if schema == '1d' and not df.empty:
        # Cache stores naive UTC (midnight TWN = prev-day 16:00 UTC). Convert to Asia/Taipei
        # so the index date matches the actual trading date.
        df = df.copy()
        df.index = pd.to_datetime(df.index, utc=True).tz_convert('Asia/Taipei')
    return df


def fetch_twstock_ohlcv_symbols(headers):
    """Stocks that currently have minute-line data server-side — the covered set
    for fetch_twstock_ohlcv. Returns a plain list of stock_id strings.

    Unlike the stock-futures variant, absence here is not a hard 400: any listed
    TWSE/TPEx stock_id can still be queried, and the first query seeds recent
    data + enrolls the stock for ongoing collection. Call this first anyway to
    know whether deep history is already backfilled before running a backtest.
    """
    r = _retry_get(f'{BASE}/studio/market/twstock/minute/ohlcv/symbols',
                   headers=headers, timeout=30)
    return r.json().get('data', [])


def _fetch_twstock_inst_raw(stock_id, start, end, headers):
    end_str = end or datetime.utcnow().strftime('%Y-%m-%d')
    r = _retry_get(f'{BASE}/studio/market/twstock/institutional/{stock_id}',
                   headers=headers, params={'start': start, 'end': end_str}, timeout=60)
    data = r.json().get('data', [])
    if not data:
        return pd.DataFrame()
    df = pd.DataFrame(data)
    df['date'] = pd.to_datetime(df['date'])
    df = df.set_index('date').sort_index()
    df['foreign_net'] = df['foreign_buy'] - df['foreign_sell']
    return df.fillna(0)


def fetch_twstock_institutional(stock_id, start, end, headers):
    """台股三大法人每日買賣超. Returns DataFrame with foreign_net and raw columns."""
    return _extend_cache_monthly(
        'twstock_inst', {'id': stock_id},
        lambda s, e: _fetch_twstock_inst_raw(stock_id, s, e, headers),
        start, end,
    )


def _fetch_twstock_shareholding_raw(stock_id, start, end, headers):
    end_str = end or datetime.utcnow().strftime('%Y-%m-%d')
    r = _retry_get(f'{BASE}/studio/market/twstock/shareholding/{stock_id}',
                   headers=headers, params={'start': start, 'end': end_str}, timeout=60)
    data = r.json().get('data', [])
    if not data:
        return pd.DataFrame(columns=['shareholders'])
    df = pd.DataFrame(data)
    df['date'] = pd.to_datetime(df['date'])
    total = df[df['level'] == 'total'].set_index('date').sort_index()
    result = total[['people']].rename(columns={'people': 'shareholders'}).astype(float)
    return result[~result.index.duplicated(keep='last')]


def fetch_twstock_shareholding(stock_id, start, end, headers):
    """台股週頻股東人數（持股分級表 total）. Returns DataFrame with 'shareholders' column."""
    return _extend_cache_monthly(
        'twstock_shareholding', {'id': stock_id},
        lambda s, e: _fetch_twstock_shareholding_raw(stock_id, s, e, headers),
        start, end,
    )


def _fetch_twstock_per_raw(stock_id, start, end, headers):
    end_str = end or datetime.utcnow().strftime('%Y-%m-%d')
    r = _retry_get(f'{BASE}/studio/market/twstock/per/{stock_id}',
                   headers=headers, params={'start': start, 'end': end_str}, timeout=60)
    data = r.json().get('data', [])
    if not data:
        return pd.DataFrame()
    df = pd.DataFrame(data)
    df['date'] = pd.to_datetime(df['date'])
    return df.set_index('date').sort_index()


def fetch_twstock_per(stock_id, start, end, headers):
    """台股每日本益比 / 股價淨值比 / 殖利率. Columns: dividend_yield, PER, PBR. Data from 2005-10-01."""
    return _extend_cache_monthly(
        'twstock_per', {'id': stock_id},
        lambda s, e: _fetch_twstock_per_raw(stock_id, s, e, headers),
        start, end,
    )


_DIVIDEND_COLUMNS = ['record_date', 'period', 'announce_date', 'cash_ex_date',
                     'stock_ex_date', 'pay_date', 'cash', 'stock', 'stock_ratio']


def _dividend_slice(df, start, end):
    """Range-filter on the API's three-tier effective date (cash_ex_date, else
    stock_ex_date, else record_date) — same ladder the server applies, so a
    locally-sliced full-history cache matches a server-side ranged query.
    Announced-but-undated rows fall through to record_date and stay visible."""
    if df.empty or (not start and not end):
        return df
    eff = df['cash_ex_date'].where(df['cash_ex_date'] != '', df['stock_ex_date'])
    eff = eff.where(eff != '', df['record_date'])
    mask = pd.Series(True, index=df.index)
    if start:
        mask &= eff >= start
    if end:
        mask &= eff <= end
    return df[mask]


def fetch_twstock_dividend(stock_id, start, end, headers):
    """台股股利事件 (one row per announcement row; cash + stock dividends).
    Columns: record_date, period, announce_date, cash_ex_date, stock_ex_date,
    pay_date, cash, stock, stock_ratio. Empty dates are '' (never NaN); `period`
    is an OPAQUE label ('114年第3季', '不適用', …) — never parse it as a year.
    Zero-value rows (cash==0 and stock==0) are announced no-distribution
    decisions and are kept. Returns an empty DataFrame for unknown ids / no
    dividend history (the API's 404). Full history is cached per stock with a
    1-day TTL (new announcements land daily) and sliced locally, so repeated
    calls with different ranges cost one API hit per stock per day."""
    path = _fundamental_cache_path('twstock_dividend', stock_id)
    df = _load_fundamental_cache(path, max_age_days=1)
    if df is None:
        try:
            r = _retry_get(f'{BASE}/studio/market/twstock/dividend/{stock_id}',
                           headers=headers, timeout=30)
        except requests.exceptions.HTTPError as e:
            if e.response is not None and e.response.status_code == 404:
                return pd.DataFrame(columns=_DIVIDEND_COLUMNS)
            raise
        df = pd.DataFrame(r.json().get('data', []))
        if not df.empty:
            _save_fundamental_cache(path, df)
    return _dividend_slice(df, start, end).reset_index(drop=True)


def fetch_twstock_dividend_batch(stock_ids, start, end, headers):
    """Batch 台股股利事件. Returns dict {stock_id: DataFrame} (same columns as
    fetch_twstock_dividend). Ids with no dividend history are silently absent
    (the batch API's contract); ids in the API's `failed` list are reported and
    absent — re-call for those. Cache-first per stock (1-day TTL, full history),
    uncached ids fetched in chunks of 50; ranges sliced locally."""
    results, uncached = {}, []
    for sid in stock_ids:
        path = _fundamental_cache_path('twstock_dividend', sid)
        df = _load_fundamental_cache(path, max_age_days=1)
        if df is not None:
            results[sid] = _dividend_slice(df, start, end).reset_index(drop=True)
        else:
            uncached.append(sid)

    for i in range(0, len(uncached), 50):
        chunk = uncached[i:i + 50]
        try:
            r = _retry_get(f'{BASE}/studio/market/twstock/batch/dividend',
                           headers=headers,
                           params={'stock_ids': ','.join(chunk)}, timeout=120)
            payload = r.json()
            failed = payload.get('failed', [])
            if failed:
                print(f'  [batch] dividend server-side fetch failed for {failed} — '
                      f'absent from results, re-call for those ids')
            for sid, records in payload.get('data', {}).items():
                if not records:
                    continue
                df = pd.DataFrame(records)
                _save_fundamental_cache(
                    _fundamental_cache_path('twstock_dividend', sid), df)
                results[sid] = _dividend_slice(df, start, end).reset_index(drop=True)
        except Exception as e:
            print(f'  [batch] dividend chunk {i//50 + 1} error: {e}')

    return results


def _broker_day_cache_path(stock_id, date_str):
    """cache/twstock_broker_stock_<stock_id>/<date>.parquet"""
    d = _CACHE_DIR / f'twstock_broker_stock_{stock_id}'
    d.mkdir(parents=True, exist_ok=True)
    return d / f'{date_str}.parquet'


# An empty answer for a day this recent may just be "not published yet" (21:30 Taipei)
# or a server-side outage, so it is not cached; older empty days (holidays, gaps) are.
_BROKER_RECENT_EMPTY_DAYS = 3


def _make_date_chunks(dates, chunk_days=90):
    """Split a sorted date list into chunks, each spanning ≤ chunk_days calendar days."""
    if not dates:
        return []
    chunks = []
    start = dates[0]
    for i, d in enumerate(dates):
        if i == len(dates) - 1 or (dates[i + 1] - start).days >= chunk_days:
            chunks.append((start, d))
            if i < len(dates) - 1:
                start = dates[i + 1]
    return chunks


def _populate_broker_day_cache(stock_id, weekdays, headers,
                               chunk_days=90, rate_limit=270, period=300,
                               max_retries=5):
    """Ensure all weekdays have cached broker data. Uses 90-day range API chunks."""
    EMPTY_COLS = ['date', 'stock_id', 'broker_id', 'broker_name', 'price', 'buy', 'sell']
    missing = [d for d in weekdays if not _broker_day_cache_path(stock_id, d.isoformat()).exists()]
    if not missing:
        return
    _check_data_access(headers)  # before the loop: its except Exception would swallow the raise

    chunks  = _make_date_chunks(missing, chunk_days)
    limiter = _RateLimiter(rate_limit, period)
    total   = len(chunks)

    for idx, (cs, ce) in enumerate(chunks):
        chunk_missing = [d for d in missing if cs <= d <= ce]
        for attempt in range(max_retries):
            try:
                limiter.acquire()
                r = requests.get(
                    f'{BASE}/studio/market/twstock/broker/stock/{stock_id}',
                    headers=headers,
                    params={'start': cs.isoformat(), 'end': ce.isoformat()},
                    timeout=120,
                )
                if r.status_code == 429:
                    time.sleep(2 ** (attempt + 1))
                    continue
                if r.status_code >= 500:
                    time.sleep(2 ** (attempt + 1))
                    continue
                r.raise_for_status()
                data    = r.json().get('data', [])
                df_all  = pd.DataFrame(data) if data else pd.DataFrame(columns=EMPTY_COLS)
                by_date = {}
                if not df_all.empty and 'date' in df_all.columns:
                    for date_str, grp in df_all.groupby('date'):
                        by_date[date_str] = grp
                today = datetime.now(_TPE).date()
                for d in chunk_missing:
                    date_str = d.isoformat()
                    if date_str not in by_date and (today - d).days <= _BROKER_RECENT_EMPTY_DAYS:
                        continue
                    df_day   = by_date.get(date_str, pd.DataFrame(columns=EMPTY_COLS)).copy()
                    df_day['date'] = date_str
                    df_day.to_parquet(_broker_day_cache_path(stock_id, date_str),
                                      index=False, compression='snappy')
                print(f"  [broker_cache {stock_id}] chunk {idx+1}/{total} "
                      f"({cs.isoformat()}~{ce.isoformat()})", flush=True)
                break
            except requests.exceptions.Timeout:
                time.sleep(2 ** (attempt + 1))
            except Exception as e:
                print(f"  [broker_cache {stock_id}] error chunk {cs}~{ce}: {e}")
                break


def _populate_trader_day_cache(trader_id, weekdays, headers,
                               chunk_days=90, rate_limit=270, period=300,
                               max_retries=5):
    """Ensure all weekdays have cached trader data. Uses 90-day range API chunks."""
    EMPTY_COLS = ['date', 'broker_id', 'broker_name', 'stock_id', 'price', 'buy', 'sell']
    missing = [d for d in weekdays if not _trader_day_cache_path(trader_id, d.isoformat()).exists()]
    if not missing:
        return
    _check_data_access(headers)  # before the loop: its except Exception would swallow the raise

    chunks  = _make_date_chunks(missing, chunk_days)
    limiter = _RateLimiter(rate_limit, period)
    total   = len(chunks)

    for idx, (cs, ce) in enumerate(chunks):
        chunk_missing = [d for d in missing if cs <= d <= ce]
        for attempt in range(max_retries):
            try:
                limiter.acquire()
                r = requests.get(
                    f'{BASE}/studio/market/twstock/broker/trader/{trader_id}',
                    headers=headers,
                    params={'start': cs.isoformat(), 'end': ce.isoformat()},
                    timeout=120,
                )
                if r.status_code == 429:
                    time.sleep(2 ** (attempt + 1))
                    continue
                if r.status_code >= 500:
                    time.sleep(2 ** (attempt + 1))
                    continue
                r.raise_for_status()
                data    = r.json().get('data', [])
                df_all  = pd.DataFrame(data) if data else pd.DataFrame(columns=EMPTY_COLS)
                by_date = {}
                if not df_all.empty and 'date' in df_all.columns:
                    for date_str, grp in df_all.groupby('date'):
                        by_date[date_str] = grp
                today = datetime.now(_TPE).date()
                for d in chunk_missing:
                    date_str = d.isoformat()
                    if date_str not in by_date and (today - d).days <= _BROKER_RECENT_EMPTY_DAYS:
                        continue
                    df_day   = by_date.get(date_str, pd.DataFrame(columns=EMPTY_COLS)).copy()
                    df_day['date'] = date_str
                    df_day.to_parquet(_trader_day_cache_path(trader_id, date_str),
                                      index=False, compression='snappy')
                print(f"  [trader_cache {trader_id}] chunk {idx+1}/{total} "
                      f"({cs.isoformat()}~{ce.isoformat()})", flush=True)
                break
            except requests.exceptions.Timeout:
                time.sleep(2 ** (attempt + 1))
            except Exception as e:
                print(f"  [trader_cache {trader_id}] error chunk {cs}~{ce}: {e}")
                break


def fetch_twstock_broker_net(stock_id, broker_id, start, end, headers,
                             max_workers=10, rate_limit=270, period=300,
                             max_retries=5):
    """台股特定分點每日淨買賣超 (buy - sell 股數).

    broker_id: securities_trader_id, e.g. '9217' for 凱基-松山.
    Local cache: cache/twstock_broker_stock_<stock_id>/<YYYY-MM-DD>.parquet
    每天存全部分點完整資料，任何 broker_id 都可直接從 local cache 過濾，無需重抓。
    只 fetch 尚未 cache 的日期；concurrent requests + token bucket rate limit。
    """
    from datetime import date as _date

    end_dt   = _date.fromisoformat(end)   if end   else _date.today()
    start_dt = _date.fromisoformat(start)

    weekdays = [start_dt + timedelta(days=i)
                for i in range((end_dt - start_dt).days + 1)
                if (start_dt + timedelta(days=i)).weekday() < 5]

    _populate_broker_day_cache(stock_id, weekdays, headers,
                               rate_limit=rate_limit, period=period, max_retries=max_retries)

    frames = []
    for d in weekdays:
        path = _broker_day_cache_path(stock_id, d.isoformat())
        if not path.exists():
            continue
        df_day = pd.read_parquet(path)
        row = df_day[df_day['broker_id'] == broker_id]
        if not row.empty:
            net = float(row['buy'].sum() - row['sell'].sum())
            frames.append({'date': d.isoformat(), 'net': net})

    if not frames:
        return pd.DataFrame(columns=['net'])
    result = pd.DataFrame(frames)
    result['date'] = pd.to_datetime(result['date'])
    return result.set_index('date').sort_index()


def fetch_twstock_all_broker_net(stock_id, start, end, headers,
                                  max_workers=10, rate_limit=270, period=300,
                                  max_retries=5):
    """台股每日全市場所有分點合計淨買賣超 (sum of buy - sell across ALL broker branches).

    Shares the same per-day parquet cache as fetch_twstock_broker_net.
    Returns pd.Series indexed by date (trading days only).
    """
    from datetime import date as _date

    end_dt   = _date.fromisoformat(end)   if end   else _date.today()
    start_dt = _date.fromisoformat(start)

    weekdays = [start_dt + timedelta(days=i)
                for i in range((end_dt - start_dt).days + 1)
                if (start_dt + timedelta(days=i)).weekday() < 5]

    _populate_broker_day_cache(stock_id, weekdays, headers,
                               rate_limit=rate_limit, period=period, max_retries=max_retries)

    frames = []
    for d in weekdays:
        path = _broker_day_cache_path(stock_id, d.isoformat())
        if not path.exists():
            continue
        df_day = pd.read_parquet(path)
        net = float(df_day['buy'].sum() - df_day['sell'].sum()) if not df_day.empty else 0.0
        frames.append({'date': d.isoformat(), 'net': net})

    if not frames:
        return pd.Series(dtype=float, name='net')
    result = pd.DataFrame(frames)
    result['date'] = pd.to_datetime(result['date'])
    return result.set_index('date')['net'].sort_index()


def fetch_twstock_branch_daily_net(stock_id, start, end, headers,
                                    max_workers=10, rate_limit=270, period=300,
                                    max_retries=5):
    """台股每日各分點淨買賣超明細.

    Returns DataFrame shape (dates, broker_ids): each cell = daily net (buy - sell)
    for that branch on that date. Missing branch-day pairs are 0.
    Shares the same per-day parquet cache as fetch_twstock_broker_net.
    """
    from datetime import date as _date

    end_dt   = _date.fromisoformat(end)   if end   else _date.today()
    start_dt = _date.fromisoformat(start)

    weekdays = [start_dt + timedelta(days=i)
                for i in range((end_dt - start_dt).days + 1)
                if (start_dt + timedelta(days=i)).weekday() < 5]

    _populate_broker_day_cache(stock_id, weekdays, headers,
                               rate_limit=rate_limit, period=period, max_retries=max_retries)

    frames = []
    for d in weekdays:
        path = _broker_day_cache_path(stock_id, d.isoformat())
        if not path.exists():
            continue
        df_day = pd.read_parquet(path)
        if df_day.empty:
            frames.append(pd.Series(dtype=float, name=d.isoformat()))
            continue
        df_day['_net'] = df_day['buy'] - df_day['sell']
        net_per_branch = df_day.groupby('broker_id')['_net'].sum()
        net_per_branch.name = d.isoformat()
        frames.append(net_per_branch)

    if not frames:
        return pd.DataFrame()
    result = pd.DataFrame(frames)   # shape: (dates × branches)
    result.index = pd.to_datetime(result.index)
    return result.sort_index().fillna(0.0)


# ── Taiwan fundamental data (quarterly / monthly) ────────────────────────────

def _fundamental_cache_path(prefix, stock_id):
    return _CACHE_DIR / f'{prefix}_{stock_id}.parquet'


def _load_fundamental_cache(path, max_age_days=30, prefix=None):
    if not path.exists():
        return None
    if (time.time() - path.stat().st_mtime) / 86400 > max_age_days:
        return None
    if prefix and _filing_due_since(prefix, path.stat().st_mtime):
        return None
    return pd.read_parquet(path)


def _filing_due_since(prefix, written_epoch):
    """Has a filing become servable (FEED_TIMING's time for it) since this cache file was
    written? Then the 30-day cache would hide it — a live tick would keep trading on the
    previous quarter / month for weeks."""
    rules = {'twstock_rev':  ('MS', (_revenue_available, _revenue_available_insurance)),
             'twstock_fin':  ('QS', (_quarterly_report_available, _quarterly_report_available_finance)),
             'twstock_bs':   ('QS', (_quarterly_report_available, _quarterly_report_available_finance))}
    if prefix not in rules:
        return False
    freq, fns = rules[prefix]
    now = pd.Timestamp.now(tz='Asia/Taipei')
    written = pd.Timestamp(written_epoch, unit='s', tz='UTC').tz_convert('Asia/Taipei')
    stamps = pd.date_range((written - pd.Timedelta(days=400)).normalize().tz_localize(None),
                           now.normalize().tz_localize(None), freq=freq).tz_localize('Asia/Taipei')
    return any(((fn(stamps) > written) & (fn(stamps) <= now)).any() for fn in fns)


def _save_fundamental_cache(path, df):
    path.parent.mkdir(exist_ok=True)
    df.to_parquet(path, compression='snappy')


def _fetch_twstock_fundamental_raw(endpoint, stock_id, headers):
    r = _retry_get(f'{BASE}/studio/market/twstock/{endpoint}/{stock_id}',
                   headers=headers, timeout=60)
    data = r.json().get('data', [])
    if not data:
        return pd.DataFrame()
    df = pd.DataFrame(data)
    df['date'] = pd.to_datetime(df['date'])
    return df.set_index('date').sort_index()


def _fetch_fundamental(prefix, endpoint, stock_id, headers):
    path = _fundamental_cache_path(prefix, stock_id)
    df = _load_fundamental_cache(path, prefix=prefix)
    if df is not None:
        return df
    df = _fetch_twstock_fundamental_raw(endpoint, stock_id, headers)
    if not df.empty:
        _save_fundamental_cache(path, df)
    return df


def fetch_twstock_financials(stock_id, headers):
    """台股季頻綜合損益表 (long format). index=date, columns: type, value, origin_name.
    Key types: Revenue, GrossProfit, OperatingIncome, IncomeAfterTaxes, EPS.
    Pivot: df.pivot_table(index='date', columns='type', values='value', aggfunc='last')"""
    return _fetch_fundamental('twstock_fin', 'financials', stock_id, headers)


def fetch_twstock_balance_sheet(stock_id, headers):
    """台股季頻資產負債表 (long format). index=date, columns: type, value, origin_name.
    Key types: TotalAssets, Equity. ROE = IncomeAfterTaxes / Equity."""
    return _fetch_fundamental('twstock_bs', 'balance_sheet', stock_id, headers)


def fetch_twstock_monthly_revenue(stock_id, headers):
    """台股月營收. index=date, columns: revenue (NTD 元, full amount not thousands), revenue_month, revenue_year.
    YoY = (rev - rev_same_month_last_year) / abs(rev_same_month_last_year)."""
    return _fetch_fundamental('twstock_rev', 'monthly_revenue', stock_id, headers)


def _twstock_list_cache_path():
    return _CACHE_DIR / 'twstock_list.parquet'


def fetch_twstock_list(headers):
    """全市場股票清單（上市+上櫃，含 ETF）。DataFrame indexed by stock_id, columns:
    name, close, industry_code, listing_date (YYYY-MM-DD). Basic company data, not a
    time series — refreshed once a day: single-file cache like fundamentals (see
    references/cache.md), just 1-day TTL instead of 30-day.
    ETFs and other non-company securities have industry_code/listing_date = None/NaN
    (use .notna() to filter, not `is not None` — parquet round-trips None as NaN).
    industry_code is TWSE/TPEx's raw numeric 產業別 code (e.g. '24'=半導體業), not a
    decoded name — group/filter by it; twstock_industry_name(code) gives the name."""
    path = _twstock_list_cache_path()
    df = _load_fundamental_cache(path, max_age_days=1)
    if df is not None:
        return df
    r = _retry_get(f'{BASE}/studio/market/twstock/list', headers=headers, timeout=60)
    data = r.json().get('data', [])
    if not data:
        return pd.DataFrame()
    df = pd.DataFrame(data).set_index('stock_id')
    _save_fundamental_cache(path, df)
    return df


def fetch_twstock_info(stock_id, headers):
    """單支股票基本資料: {stock_id, name, close, industry_code, listing_date}, or None
    if not currently listed. Looks up within fetch_twstock_list's cached universe
    (same 1-day-fresh data) instead of a separate network call."""
    df = fetch_twstock_list(headers)
    if df.empty or stock_id not in df.index:
        return None
    return {'stock_id': stock_id, **df.loc[stock_id].to_dict()}


# 上市、上櫃共用同一套代碼、同碼同名(TWSE/TPEx 公司基本資料 × ISIN 公告逐檔 join,零衝突)。
# 07/13/19/34 目前沒有任何公司;32、33 只有上櫃,01/08/09/11/12/18/91 只有上市。
TWSE_INDUSTRY_NAMES = {
    '01': '水泥工業', '02': '食品工業', '03': '塑膠工業', '04': '紡織纖維', '05': '電機機械',
    '06': '電器電纜', '08': '玻璃陶瓷', '09': '造紙工業', '10': '鋼鐵工業', '11': '橡膠工業',
    '12': '汽車工業', '14': '建材營造業', '15': '航運業', '16': '觀光餐旅', '17': '金融保險業',
    '18': '貿易百貨業', '20': '其他業', '21': '化學工業', '22': '生技醫療業', '23': '油電燃氣業',
    '24': '半導體業', '25': '電腦及週邊設備業', '26': '光電業', '27': '通信網路業',
    '28': '電子零組件業', '29': '電子通路業', '30': '資訊服務業', '31': '其他電子業',
    '32': '文化創意業', '33': '農業科技業', '35': '綠能環保', '36': '數位雲端', '37': '運動休閒',
    '38': '居家生活',
    # ISIN 公告的產業別欄對 91 是空白;成員全是 -DR,名稱是我們依成員定的,不是官方標籤。
    '91': '存託憑證',
}


def twstock_industry_name(code):
    """TWSE/TPEx 產業別代碼 → 名稱 ('24' → '半導體業'). Accepts '24', 24 or '5'; None/NaN
    (ETFs) → None; a code not in TWSE_INDUSTRY_NAMES comes back unchanged, never guessed."""
    if code is None or (isinstance(code, float) and code != code):
        return None
    s = str(code).strip()
    if not s:
        return None
    key = s.zfill(2) if s.isdigit() else s
    return TWSE_INDUSTRY_NAMES.get(key, s)


def fetch_twstock_market_value_all(headers, top=None):
    """全市場市值排名快照 (whole-market market-cap ranking). 上市 + 上櫃 + ETF
    (興櫃 excluded, ETNs have no data) — about 2,400 rows. DataFrame with columns
    rank (1-based, market_value desc), stock_id, name, market_value (NTD 元,
    integer), market ('TWSE' 上市 / 'TPEx' 上櫃), is_etf (bool); the as-of
    publication date and the 上市 ex-ETF market-cap total ride along in
    `df.attrs['date']` ('YYYY-MM-DD') and `df.attrs['twse_ex_etf_market_value']`
    (NTD 元, int). Updated once a day after the close; server caches 30 min.

    `top` (int 1–3000) keeps the first N ranks, None = all. This is the first-layer
    screening filter for anything market-cap based (top-N pool, top-10 權值股) —
    never rebuild it from per-stock shares × price across the market.

    ETFs are in the ranking (0050 is rank 6) — filter them with the `is_etf`
    column: `df[~df['is_etf']]`. Never by stock_id prefix ('00' is a market
    convention rather than a contract, and it misses REITs like '01010T') and never
    by fetching a classification yourself — is_etf IS that classification (FinMind
    industry_category), and it is the same criterion the denominator uses, so the
    two can never disagree. is_etf False means 'not in the ETF set', NOT 'confirmed
    not an ETF': a security FinMind publishes no category for (REIT '01010T') is
    False and stays inside the denominator. `market` is a listing-board tag, not an
    ETF flag.

    `attrs['twse_ex_etf_market_value']` is the index-weight (權值比重) denominator:
    the sum of the market == 'TWSE' rows that are not ETFs on the same as-of day,
    whole-market regardless of `top` (REITs and preferred shares are NOT excluded
    from it). So market_value / twse_ex_etf_market_value is a weight only
    for a row whose market is 'TWSE' and which is not an ETF — over a TPEx or ETF
    row it is not a weight. `rank` is on a different universe — still 上市 + 上櫃
    including ETFs — so never present the ratio and the rank as one ranking.

    Single-file cache like fetch_twmarket_dividend_points: the FULL ranking is
    fetched once (one call, ~2.4k rows) and kept 1 hour, `top` is sliced locally,
    so repeat calls with different `top` are free within the hour. Whether attrs
    survive the parquet round-trip is pandas-version dependent, so it is NOT
    relied on: a cache hit that came back without the new column or without either
    attr is discarded and refetched. The returned frame therefore always carries
    both attrs, whatever the machine's pandas version."""
    if top is not None and (not isinstance(top, numbers.Integral)
                            or isinstance(top, bool) or not 1 <= top <= 3000):
        raise ValueError(f'top must be an int in 1–3000 or None, got {top!r}')
    path = _CACHE_DIR / 'twstock_market_value_all.parquet'
    df = _load_fundamental_cache(path, max_age_days=1 / 24)
    # Old cache file, or a pandas whose parquet writer drops DataFrame.attrs: either way
    # a field would silently go missing and callers would filter on a column that is not
    # there. Every field this function promises is checked. `not in` rather than a falsy
    # test — a genuine null denominator must not refetch on every call.
    if df is not None and ('market' not in df.columns or 'is_etf' not in df.columns
                           or 'date' not in df.attrs
                           or 'twse_ex_etf_market_value' not in df.attrs):
        df = None
    if df is None:
        r = _retry_get(f'{BASE}/studio/market/twstock/market_value/all',
                       headers=headers, timeout=60)
        payload = r.json()
        data = payload.get('data', [])
        if not data:
            out = pd.DataFrame(
                columns=['rank', 'stock_id', 'name', 'market_value', 'market', 'is_etf'])
            out.attrs['date'] = payload.get('date')
            out.attrs['twse_ex_etf_market_value'] = payload.get('twse_ex_etf_market_value')
            return out
        df = pd.DataFrame(data)[['rank', 'stock_id', 'name', 'market_value', 'market',
                                 'is_etf']]
        df = df.sort_values('rank').reset_index(drop=True)
        df.attrs['date'] = payload.get('date')
        df.attrs['twse_ex_etf_market_value'] = payload.get('twse_ex_etf_market_value')
        _save_fundamental_cache(path, df)
    out = df if top is None else df.head(top).copy()
    out.attrs = dict(df.attrs)   # slicing must not drop the as-of date / denominator
    return out


def _fetch_fundamental_batch(prefix, endpoint, stock_ids, headers):
    """Batch fetch fundamental data. Returns dict {stock_id: DataFrame}.
    Uses cache first; fetches uncached stocks in chunks of 50 via batch API."""
    results = {}
    uncached = []

    for sid in stock_ids:
        path = _fundamental_cache_path(prefix, sid)
        df = _load_fundamental_cache(path, prefix=prefix)
        if df is not None:
            results[sid] = df
        else:
            uncached.append(sid)

    for i in range(0, len(uncached), 50):
        chunk = uncached[i:i + 50]
        try:
            r = _retry_get(f'{BASE}/studio/market/twstock/batch/{endpoint}',
                           headers=headers,
                           params={'stock_ids': ','.join(chunk)},
                           timeout=120)
            batch_data = r.json().get('data', {})
            for sid, records in batch_data.items():
                if not records:
                    continue
                df = pd.DataFrame(records)
                df['date'] = pd.to_datetime(df['date'])
                df = df.set_index('date').sort_index()
                _save_fundamental_cache(_fundamental_cache_path(prefix, sid), df)
                results[sid] = df
        except Exception as e:
            print(f'  [batch] {endpoint} chunk {i//50 + 1} error: {e}')

    return results


def fetch_twstock_financials_batch(stock_ids, headers):
    """Batch fetch 台股季頻綜合損益表. Returns dict {stock_id: DataFrame}."""
    return _fetch_fundamental_batch('twstock_fin', 'financials', stock_ids, headers)


def fetch_twstock_balance_sheet_batch(stock_ids, headers):
    """Batch fetch 台股季頻資產負債表. Returns dict {stock_id: DataFrame}."""
    return _fetch_fundamental_batch('twstock_bs', 'balance_sheet', stock_ids, headers)


def fetch_twstock_monthly_revenue_batch(stock_ids, headers):
    """Batch fetch 台股月營收. Returns dict {stock_id: DataFrame}."""
    return _fetch_fundamental_batch('twstock_rev', 'monthly_revenue', stock_ids, headers)


def _mark_empty_months(prefix, sid, start, end):
    """Write empty-marker parquets for every PAST month in [start, end] that has
    no cached file.

    The /batch endpoint only returns months that have data, so the empty early
    months (e.g. institutional before the dataset existed) never get a file from
    _save_monthly — and the next run's extend path would re-fetch every one of
    them. Marking them here keeps a cold batch fetch a true cache hit on re-run.
    """
    cache_dir = _monthly_cache_dir(prefix, {'id': sid})
    cache_dir.mkdir(parents=True, exist_ok=True)
    current_ym = datetime.utcnow().strftime('%Y-%m')
    end_str = end or datetime.utcnow().strftime('%Y-%m-%d')
    for ym in _iter_months(start, end_str):
        if ym >= current_ym:        # never freeze the current (still-growing) month
            continue
        path = cache_dir / f'{ym}.parquet'
        if not path.exists():
            pd.DataFrame().to_parquet(path)


def _fetch_batch_cached(prefix, batch_url, id_param_name, raw_fn, parse_fn, ids, start, end, headers,
                         chunk_size=50, mark_empty_months=True, start_param='start', end_param='end',
                         date_chunk_days=None):
    """Shared batch fetcher for monthly-cached datasets (Taiwan stocks and stock futures).

    Phase 1: ids that already have a local cache are extended (current-month delta).
             The delta itself is fetched through batch_url in chunk_size-id chunks — NOT
             one request per id — then handed to _extend_cache_monthly for the merge/write.
             (Previously this phase called raw_fn per id individually: on a warm run with
             ids in the hundreds that meant that many single-id HTTP calls, each paying
             api_plan_required's full auth cost — bcrypt check + 2 uncached MySQL lookups
             + 2 Redis rate-limit hits — independently, which is what actually made warm
             runs slow, not the local parquet reads. See twstock_momentum backtest timeout,
             2026-07.)
    Phase 2: ids with no local cache yet are fetched the same way, chunk_size ids per
             request, full requested range.

    raw_fn(id, start, end, headers) -> DataFrame   single-id fallback (missing past months)
    parse_fn(records) -> DataFrame                 one id's batch records -> cached frame
    """
    results, uncached = {}, []

    single = prefix in _SINGLE_FILE_PREFIXES
    to_extend = []
    for _id in ids:
        if single:
            cached = _has_single_cache(prefix, {'id': _id})
        else:
            cache_dir = _monthly_cache_dir(prefix, {'id': _id})
            cached = cache_dir.exists() and bool(list(cache_dir.glob('*.parquet')))
        (to_extend if cached else uncached).append(_id)

    def _date_spans(range_start, range_end):
        """Split [range_start, range_end] into <= date_chunk_days pieces. Some batch
        endpoints (crypto /kline*) silently clamp an over-long single request to their
        own max window instead of erroring — chunking client-side is the only way to
        actually get the full requested range back."""
        if not date_chunk_days:
            return [(range_start, range_end)]
        s = datetime.strptime(range_start, '%Y-%m-%d')
        e = datetime.utcnow() if not range_end else datetime.strptime(range_end, '%Y-%m-%d')
        spans, cursor = [], s
        while cursor <= e:
            span_end = min(cursor + timedelta(days=date_chunk_days), e)
            spans.append((cursor.strftime('%Y-%m-%d'), span_end.strftime('%Y-%m-%d')))
            cursor = span_end + timedelta(days=1)
        return spans

    def _fetch_batch_range(id_list, range_start, range_end):
        """chunk_size ids per request x date_chunk_days-sized date spans, all issued
        concurrently. Returns ({id: DataFrame}, failed_ids): frames merged across spans,
        missing/empty ids simply absent (caller treats absence as 'no data') — EXCEPT
        ids in failed_ids, whose chunk errored or was server-side rate-limited; for
        those, absence is unknown, not 'empty', and must never be cached as empty."""
        out, failed_ids = {}, set()
        id_chunks = [id_list[i:i + chunk_size] for i in range(0, len(id_list), chunk_size)]
        date_spans = _date_spans(range_start, range_end)
        jobs = [(idx, chunk, span) for idx, chunk in enumerate(id_chunks) for span in date_spans]

        def _fetch_chunk(idx, chunk, span):
            span_start, span_end = span
            partial = {}
            try:
                params = {id_param_name: ','.join(chunk), start_param: span_start, end_param: span_end}
                r = _retry_get(batch_url, headers=headers, params=params, timeout=120)
                body = r.json()
                failed = body.get('failed', [])
                if failed:
                    print(f'  [batch] {batch_url} server-side fetch failed (rate limit or upstream error), dropped: {failed}')
                    failed_ids.update(failed)
                for _id, records in body.get('data', {}).items():
                    if records:
                        partial[_id] = _normalise_index(parse_fn(records))
            except Exception as e:
                print(f'  [batch] {batch_url} chunk {idx + 1} {span}: error: {e}')
                failed_ids.update(chunk)
            return partial

        with ThreadPoolExecutor(max_workers=8) as pool:
            futures = [pool.submit(_fetch_chunk, idx, chunk, span) for idx, chunk, span in jobs]
            for future in as_completed(futures):
                for _id, df in future.result().items():
                    out[_id] = pd.concat([out[_id], df]) if _id in out else df

        for _id, df in out.items():
            out[_id] = df[~df.index.duplicated(keep='last')].sort_index()
        return out, failed_ids

    # Pre-fetch the delta for every to_extend id in one batched pass instead of
    # per-id inside _extend_one below. _extend_cache_monthly asks for
    # (last_cached_ts, tomorrow) which falls inside the current month, so a
    # current-month-start..tomorrow batch fetch covers the common case. After a
    # month rollover it ALSO asks each id to complete the previous month (its file
    # was last written mid-month — see _written_before_month_end); when any id
    # needs that, widen the batch window to the previous month's start so those
    # spans are served from the same batched pass — otherwise every warm id would
    # fall back to one single-id HTTP call each (the twstock_momentum-timeout
    # storm, once per month across the whole warm cache). Extra days before each
    # id's own last_ts are harmless, _extend_cache_monthly dedupes by index.
    prefetch_batch, prefetch_failed, prefetch_start = {}, set(), None
    if to_extend:
        now = datetime.utcnow()
        current_ym = now.strftime('%Y-%m')
        prev_ym = (now.replace(day=1) - timedelta(days=1)).strftime('%Y-%m')
        tomorrow = (now + timedelta(days=1)).strftime('%Y-%m-%d')

        def _prev_month_needs_completion(_id):
            if single:
                meta = _read_single_meta(prefix, {'id': _id})   # footer only, no data pages
                # unknown / older coverage → treat as needing the wider window
                return meta is None or meta['to'] < prev_ym or _tail_needs_completion(meta, prev_ym)
            path = _monthly_cache_dir(prefix, {'id': _id}) / f'{prev_ym}.parquet'
            return not path.exists() or _written_before_month_end(path, prev_ym)

        widen = (prev_ym >= start[:7]
                 and any(_prev_month_needs_completion(_id) for _id in to_extend))
        prefetch_start = f'{prev_ym}-01' if widen else f'{current_ym}-01'
        prefetch_batch, prefetch_failed = _fetch_batch_range(to_extend, prefetch_start, tomorrow)

    def _make_fetch_fn(_id):
        def _fetch(s, e):
            # Any span inside the pre-fetched window (current-month delta, and the
            # previous-month completion after a rollover): serve from the batch.
            if prefetch_start is not None and s >= prefetch_start:
                if _id in prefetch_failed:
                    # Absence is unknown, not 'no data' — serving an empty frame here
                    # would let the previous-month completion path rewrite the month
                    # file (mtime past month end = complete) and freeze the hole.
                    # Raising demotes this id to the phase-2 full-range batch refetch.
                    raise RuntimeError(f'batch prefetch failed for {_id}')
                df = prefetch_batch.get(_id)
                if df is None:
                    return pd.DataFrame()
                return df[(df.index >= s) & (df.index < e)]
            # Deeper past-month holes (rare — a partially-cached id) fall back to
            # the single-id fetch; not worth batching for an edge case.
            return raw_fn(_id, s, e, headers)
        return _fetch

    def _extend_one(_id):
        return _extend_cache_monthly(
            prefix, {'id': _id},
            _make_fetch_fn(_id),
            start, end,
        )

    with ThreadPoolExecutor(max_workers=10) as pool:
        futures = {pool.submit(_extend_one, _id): _id for _id in to_extend}
        for future in as_completed(futures):
            _id = futures[future]
            try:
                results[_id] = future.result()
            except Exception:
                uncached.append(_id)

    # Month-aligned start for the single-file layout, like _extend_cache_monthly's
    # spans: the cache claims the whole start month, so it must hold the whole month
    # (a later request from the 1st would otherwise find a permanent hole).
    # (Single layout only: the monthly batch path keeps its exact `start` — sub-5min
    # kline batches are validated against the server's earliest date and a month-
    # aligned start before it is a hard 400, not a clamp.)
    fetched, failed_ids = _fetch_batch_range(uncached, f'{start[:7]}-01' if (single and start) else start, end)
    end_str = end or datetime.utcnow().strftime('%Y-%m-%d')
    start_ts = pd.Timestamp(start)
    end_ts = pd.Timestamp(end_str) + pd.Timedelta(days=1)
    for _id, df in fetched.items():
        if single:
            _save_single(prefix, {'id': _id}, df, start, end)
        else:
            _save_monthly(prefix, {'id': _id}, df)
        # match _extend_cache_monthly's own [start, end] clamp so both phases return
        # the same range regardless of how much extra the raw fetch pulled back
        results[_id] = df[(df.index >= start_ts) & (df.index < end_ts)]
    # Mark every in-range past month with no data as an empty parquet, so the next
    # run is a cache hit instead of re-fetching the empty months. Ids with any
    # failed chunk are skipped for the whole range: a transient fetch failure is
    # not evidence of an empty month, and a wrongly-frozen empty parquet would
    # hide that id's history on every future warm run. (Single-file layout: an
    # id that came back with no rows at all gets an empty frame whose footer meta
    # covers the range — same "fetched, empty" meaning; never overwrites a file
    # that already has rows.)
    if start and mark_empty_months:
        for _id in uncached:
            if _id in failed_ids:
                continue
            if single:
                if _id not in fetched:
                    _save_single(prefix, {'id': _id}, pd.DataFrame(), start, end)
            else:
                _mark_empty_months(prefix, _id, start, end)

    return results


def _fetch_twstock_cached_batch(prefix, endpoint, raw_fn, parse_fn, stock_ids, start, end, headers):
    """Shared batch fetcher for monthly-cached 台股 datasets. Thin wrapper over
    _fetch_batch_cached — kept for existing callers (stock_ids param name, 50/chunk)."""
    return _fetch_batch_cached(
        prefix, f'{BASE}/studio/market/twstock/batch/{endpoint}', 'stock_ids',
        raw_fn, parse_fn, stock_ids, start, end, headers, chunk_size=50)


def fetch_twstock_shareholding_batch(stock_ids, start, end, headers):
    """Batch fetch 台股週頻股東人數. Returns dict {stock_id: DataFrame(shareholders)}."""
    def _parse(records):
        df = pd.DataFrame(records)
        df['date'] = pd.to_datetime(df['date'])
        df = df.set_index('date').sort_index()
        total = df[df['level'] == 'total'][['people']].rename(columns={'people': 'shareholders'}).astype(float)
        return total[~total.index.duplicated(keep='last')]
    return _fetch_twstock_cached_batch(
        'twstock_shareholding', 'shareholding', _fetch_twstock_shareholding_raw, _parse,
        stock_ids, start, end, headers)


def fetch_twstock_price_adj_batch(stock_ids, start, end, headers):
    """Batch fetch 台股向後調整日K. Returns dict {stock_id: DataFrame(Open, Close)}."""
    def _parse(records):
        df = pd.DataFrame(records)
        df['date'] = pd.to_datetime(df['date'])
        df = df.set_index('date').sort_index()[['open', 'close']].rename(
            columns={'open': 'Open', 'close': 'Close'}).astype(float)
        return df.replace(0, float('nan')).ffill()
    return _fetch_twstock_cached_batch(
        'twstock_price', 'price_adj', _fetch_twstock_price_raw, _parse,
        stock_ids, start, end, headers)


def fetch_twstock_price_batch(stock_ids, start, end, headers):
    """Batch fetch 台股原始日K OHLCV（未除權息）. Returns dict {stock_id: DataFrame(Open,
    High, Low, Close, Volume)}. Same data and cache as fetch_twstock_price — use for
    High/Low-based screens (KD, breakout, range) across many stocks; do NOT use for
    backtesting across ex-dividend dates (use fetch_twstock_price_adj_batch)."""
    def _parse(records):
        df = pd.DataFrame(records)
        df['date'] = pd.to_datetime(df['date'])
        cols = [c for c in ['open', 'high', 'low', 'close', 'volume'] if c in df.columns]
        df = df.set_index('date').sort_index()[cols].rename(
            columns={'open': 'Open', 'high': 'High', 'low': 'Low',
                     'close': 'Close', 'volume': 'Volume'}).astype(float)
        return df.replace(0, float('nan')).ffill()
    results = _fetch_twstock_cached_batch(
        'twstock_price_nonadj', 'price', _fetch_twstock_price_nonadj_raw, _parse,
        stock_ids, start, end, headers)
    return {sid: _sanity_check_ohlc(df, f'{sid} twstock price')
            for sid, df in results.items()}


def fetch_twstock_per_batch(stock_ids, start, end, headers):
    """Batch fetch 台股每日本益比/股價淨值比/殖利率. Returns dict {stock_id:
    DataFrame(dividend_yield, PER, PBR)}. Same data and cache as fetch_twstock_per —
    use for value screens (殖利率 > x%, PER < y) across many stocks."""
    def _parse(records):
        df = pd.DataFrame(records)
        df['date'] = pd.to_datetime(df['date'])
        return df.set_index('date').sort_index()
    return _fetch_twstock_cached_batch(
        'twstock_per', 'per', _fetch_twstock_per_raw, _parse,
        stock_ids, start, end, headers)


def fetch_twstock_institutional_batch(stock_ids, start, end, headers):
    """Batch fetch 台股三大法人. Returns dict {stock_id: DataFrame(foreign_net, ...)}."""
    def _parse(records):
        df = pd.DataFrame(records)
        df['date'] = pd.to_datetime(df['date'])
        df = df.set_index('date').sort_index()
        df['foreign_net'] = df['foreign_buy'] - df['foreign_sell']
        return df.fillna(0)
    return _fetch_twstock_cached_batch(
        'twstock_inst', 'institutional', _fetch_twstock_inst_raw, _parse,
        stock_ids, start, end, headers)


def _fetch_twstock_foreign_shareholding_raw(stock_id, start, end, headers):
    end_str = end or datetime.utcnow().strftime('%Y-%m-%d')
    r = _retry_get(f'{BASE}/studio/market/twstock/foreign_shareholding/{stock_id}',
                   headers=headers, params={'start': start, 'end': end_str}, timeout=60)
    data = r.json().get('data', [])
    if not data:
        return pd.DataFrame()
    df = pd.DataFrame(data)
    df['date'] = pd.to_datetime(df['date'])
    return df.set_index('date').sort_index()


def fetch_twstock_foreign_shareholding_batch(stock_ids, start, end, headers):
    """Batch fetch 台股外資持股表. Returns dict {stock_id: DataFrame}.
    Key columns: ForeignInvestmentSharesRatio (持股比率%), ForeignInvestmentShares (持股股數),
    ForeignInvestmentRemainRatio (剩餘可投資比率%), NumberOfSharesIssued (已發行股數)."""
    def _parse(records):
        df = pd.DataFrame(records)
        df['date'] = pd.to_datetime(df['date'])
        return df.set_index('date').sort_index()
    return _fetch_twstock_cached_batch(
        'twstock_foreign_sh', 'foreign_shareholding', _fetch_twstock_foreign_shareholding_raw, _parse,
        stock_ids, start, end, headers)


# ── Taiwan market-wide data (大盤) ────────────────────────────────────────────
# 全市場層級,沒有 stock_id 維度。個股層級的同名資料請用上面的 fetch_twstock_* 系列。

def _fetch_twmarket_index_raw(index_id, start, end, headers):
    end_str = end or datetime.utcnow().strftime('%Y-%m-%d')
    r = _retry_get(f'{BASE}/studio/market/twmarket/index/{index_id}',
                   headers=headers, params={'start': start, 'end': end_str}, timeout=60)
    data = r.json().get('data', [])
    if not data:
        return pd.DataFrame(columns=['Open', 'High', 'Low', 'Close'])
    df = pd.DataFrame(data)
    df['date'] = pd.to_datetime(df['date'])
    return df.set_index('date').sort_index()[['open', 'high', 'low', 'close']].rename(
        columns={'open': 'Open', 'high': 'High', 'low': 'Low', 'close': 'Close'}).astype(float)


def fetch_twmarket_index(start, end, headers, index_id='TAIEX'):
    """大盤加權指數日K（發行量加權股價指數）. Returns DataFrame with Open/High/Low/Close.
    1999-01-05 起;`TAIEX` 是目前唯一支援的 index_id（其他值 API 回 400）。
    指數本身沒有成交量欄位——大盤成交量/成交金額請用 fetch_twmarket_turnover。"""
    df = _extend_cache_monthly(
        'twmarket_index', {'id': index_id},
        lambda s, e: _fetch_twmarket_index_raw(index_id, s, e, headers),
        start, end,
    )
    return _sanity_check_ohlc(df, f'{index_id} twmarket index')


def _fetch_twmarket_raw(endpoint, columns, start, end, headers):
    """Shared raw fetch for the market-wide (no stock_id) twmarket endpoints."""
    end_str = end or datetime.utcnow().strftime('%Y-%m-%d')
    r = _retry_get(f'{BASE}/studio/market/twmarket/{endpoint}',
                   headers=headers, params={'start': start, 'end': end_str}, timeout=60)
    data = r.json().get('data', [])
    if not data:
        return pd.DataFrame(columns=columns)
    df = pd.DataFrame(data)
    df['date'] = pd.to_datetime(df['date'])
    df = df.set_index('date').sort_index()
    cols = [c for c in columns if c in df.columns]
    return df[cols].astype(float)


_TWMARKET_TURNOVER_COLUMNS = ['volume', 'value', 'trades']
_TWMARKET_INST_COLUMNS = ['foreign', 'investment_trust', 'dealer', 'total']
_TWMARKET_MARGIN_COLUMNS = ['margin_balance', 'margin_balance_prev', 'margin_balance_value',
                            'short_balance', 'short_balance_prev']


def fetch_twmarket_turnover(start, end, headers):
    """全市場每日成交量值（TWSE 集中市場）. Returns DataFrame with columns:
    volume（成交股數,股）、value（成交金額,元）、trades（成交筆數）. 1990-01-04 起。"""
    return _extend_cache_monthly(
        'twmarket_turnover', {'id': 'TWSE'},
        lambda s, e: _fetch_twmarket_raw('turnover', _TWMARKET_TURNOVER_COLUMNS, s, e, headers),
        start, end,
    )


def fetch_twmarket_institutional(start, end, headers):
    """全市場三大法人每日買賣超. Returns DataFrame with columns:
    foreign / investment_trust / dealer / total,皆為淨買賣超金額（元,買 - 賣）。
    2004-04-07 起。外資自營商計入 dealer,不計入 foreign。
    個股層級請改用 fetch_twstock_institutional。"""
    return _extend_cache_monthly(
        'twmarket_institutional', {'id': 'TWSE'},
        lambda s, e: _fetch_twmarket_raw('institutional', _TWMARKET_INST_COLUMNS, s, e, headers),
        start, end,
    )


def fetch_twmarket_margin(start, end, headers):
    """全市場融資融券餘額. Returns DataFrame with columns:
    margin_balance / margin_balance_prev（融資餘額與前日餘額,張）、
    margin_balance_value（融資金額,元）、
    short_balance / short_balance_prev（融券餘額與前日餘額,張）. 2001-01-03 起。"""
    return _extend_cache_monthly(
        'twmarket_margin', {'id': 'TWSE'},
        lambda s, e: _fetch_twmarket_raw('margin', _TWMARKET_MARGIN_COLUMNS, s, e, headers),
        start, end,
    )


def fetch_twmarket_dividend_points(start, end, headers):
    """加權指數每日除息點數 (TAIEX daily index dividend points) — the correction
    term for 正逆價差 fair-basis math. DatetimeIndex, columns: points (index
    points), estimated (bool: False = realized, TR-index derived, from 2003;
    True = forecast — announced dividends + last-year template, zero-filled on
    event-less future weekdays, horizon today+120).

    Deliberately NOT month-file cached (unlike the other twmarket series): the
    estimated leg is recomputed server-side every day and the realized/estimated
    boundary sweeps through the current month, so month files would freeze stale
    forecasts as if they were history. Instead the FULL series (one API call)
    sits in a single-file cache with a 1-hour TTL — realized history rides along
    for free, forecasts are never older than an hour, and cost is capped at 24
    calls/day. Slice locally. Realized leg updates ~17:00 Taipei daily.

    The API's `meta` (estimated_coverage / degraded) rides along in the
    returned frame's `df.attrs['meta']` — pandas attrs survive the parquet
    cache round-trip, so cache hits carry the meta of the fetch that filled
    the cache (same ≤1h freshness as the data itself). Callers whose math
    depends on the estimated leg (e.g. mispricing D(t)) MUST check
    `attrs['meta'].get('degraded')` and refuse to compute on a lower-bound
    estimate; the print below is a courtesy for ad-hoc use, not the guard."""
    path = _CACHE_DIR / 'twmarket_dividend_points.parquet'
    df = _load_fundamental_cache(path, max_age_days=1 / 24)
    if df is None:
        r = _retry_get(f'{BASE}/studio/market/twmarket/dividend_points',
                       headers=headers, timeout=60)
        payload = r.json()
        meta = payload.get('meta') or {}
        if meta.get('degraded'):
            print(f"  [dividend_points] WARNING degraded estimate — synthesis "
                  f"coverage {meta.get('estimated_coverage')}; treat the "
                  f"estimated leg as a lower bound")
        data = payload.get('data', [])
        if not data:
            out = pd.DataFrame(columns=['points', 'estimated'])
            out.attrs['meta'] = meta
            return out
        df = pd.DataFrame(data)
        df['date'] = pd.to_datetime(df['date'])
        df = df.set_index('date').sort_index()
        df.attrs['meta'] = meta
        _save_fundamental_cache(path, df)
    out = df
    if start:
        out = out[out.index >= pd.Timestamp(start)]
    if end:
        out = out[out.index <= pd.Timestamp(end)]
    out.attrs = dict(df.attrs)   # slicing must not drop the meta
    return out


# ── Taiwan market calendar ────────────────────────────────────────────────────

_HOLIDAY_MEMO = {}
_HOLIDAY_MEMO_TTL = 3600
_TPE = timezone(timedelta(hours=8))


def _taipei_date(value):
    """'YYYY-MM-DD' (zero padding optional: '2026-9-1' is fine), date, datetime or
    Timestamp → the Taipei calendar date. A tz-aware value is converted to Taipei first;
    a naive one is taken as Taipei already. Anything else raises instead of being guessed."""
    if isinstance(value, str):
        try:
            return datetime.strptime(value.strip(), '%Y-%m-%d').date()
        except ValueError:
            raise ValueError(f"date must be 'YYYY-MM-DD' (Taipei), got {value!r}") from None
    if isinstance(value, datetime):   # pd.Timestamp included
        return (value.astimezone(_TPE) if value.tzinfo else value).date()
    if isinstance(value, _date):
        return value
    raise TypeError(f"date must be 'YYYY-MM-DD', a date or a datetime, got {type(value).__name__}")


def fetch_twstock_holidays(headers, year=None):
    """TWSE 年度休市表 (annual market holiday schedule) for `year` (default: this Taipei year).

    DataFrame, one row per listed day: date (Timestamp), name, type, note. type is
    'holiday' or 'settlement_only' (市場無交易,僅辦理結算交割 — nothing trades that day either);
    the table's 「…開始/最後交易日」 marker rows are already removed server-side. Weekend
    dates may appear. **Ad-hoc closures (typhoon days) are never in it.**

    df.attrs: year, source / source_zh (the licence attribution — copy one verbatim into
    any report or reply that cites the table), note, stale (True = TWSE was unreachable
    and this is the last stored copy).

    Returns None — and prints why — when the endpoint is unreachable or TWSE has not
    published that year (published:false). None means "unknown", never "no holidays"."""
    if year is None:
        year = datetime.now(_TPE).year
    year = int(year)
    hit = _HOLIDAY_MEMO.get(year)
    if hit and time.time() - hit[0] < _HOLIDAY_MEMO_TTL:
        return hit[1]
    try:
        # 5xx 預設退避約兩分鐘;休市表只是判斷用,拿不到就回 None,不值得讓報告卡那麼久。
        r = _retry_get(f'{BASE}/studio/market/twmarket/holidays', headers=headers,
                       params={'year': year}, timeout=20, max_retries=2)
        payload = r.json()
    except (requests.exceptions.RequestException, ValueError) as e:
        print(f"  [holidays] {year}: holiday table unavailable ({type(e).__name__}) — trading-day status unknown")
        return None
    if not isinstance(payload, dict) or not payload.get('published') or not payload.get('data'):
        reason = payload.get('reason') if isinstance(payload, dict) else None
        what = ("the source no longer serves this year's table" if reason == 'not_available_from_source'
                else "TWSE has not published this year's table")
        print(f"  [holidays] {year}: {what} ({reason or 'published:false'}) "
              f"— trading-day status unknown, not 'no holidays'")
        return None
    df = pd.DataFrame(payload['data'])
    for col in ('name', 'type', 'note'):
        if col not in df.columns:
            df[col] = None
    df['date'] = pd.to_datetime(df['date'])
    df = df[['date', 'name', 'type', 'note']].sort_values('date').reset_index(drop=True)
    df.attrs = {k: payload.get(k) for k in ('year', 'source', 'source_zh', 'note', 'stale')}
    if payload.get('stale'):
        print(f"  [holidays] {year}: WARNING TWSE unreachable, this is the last stored copy of the table")
    _HOLIDAY_MEMO[year] = (time.time(), df)
    return df


def is_tw_trading_day(date, headers):
    """Is `date` a TWSE trading day? 'YYYY-MM-DD', date, datetime or Timestamp; a tz-aware
    value is converted to Taipei first, a naive one is taken as a Taipei date. True / False,
    or None when unknown (holiday table unavailable or that year not published).
    Saturday/Sunday → False without any fetch; a 'holiday' or 'settlement_only' row → False.
    True only means "not in the official table": a typhoon closure is not in it."""
    d = _taipei_date(date)
    if d.weekday() >= 5:
        return False
    table = fetch_twstock_holidays(headers, d.year)
    if table is None:
        return None
    closed = table[table['type'].isin(['holiday', 'settlement_only'])]['date'].dt.date
    return d not in set(closed)


# ── Taiwan futures data ───────────────────────────────────────────────────────

_TW_FUTURES_CHUNK_DAYS = {'1d': 3650, '1m': 28, '5m': 28, '15m': 28, '30m': 28, '60m': 28}


def _fetch_twfutures_raw(symbol, schema, start, end, headers):
    _check_data_access(headers)
    s = datetime.strptime(start, '%Y-%m-%d')
    e = datetime.utcnow() if not end else datetime.strptime(end, '%Y-%m-%d')
    chunk_days = _TW_FUTURES_CHUNK_DAYS.get(schema, 28)

    chunks, cursor = [], s
    while cursor < e:
        chunk_end = min(cursor + timedelta(days=chunk_days), e)
        chunks.append((cursor.strftime('%Y-%m-%d'), chunk_end.strftime('%Y-%m-%d')))
        cursor = chunk_end

    def _fetch_one(cs, ce):
        r = requests.get(
            f'{BASE}/studio/market/twfutures/ohlcv/{symbol}/{schema}',
            headers=headers,
            params={'start': cs, 'end': ce},
            timeout=60,
        )
        r.raise_for_status()
        return r.json().get('data', [])

    rows = []
    with ThreadPoolExecutor(max_workers=5) as pool:
        futures = {pool.submit(_fetch_one, cs, ce): (cs, ce) for cs, ce in chunks}
        for future in as_completed(futures):
            rows.extend(future.result())

    df = pd.DataFrame(rows)
    if df.empty:
        return df
    df['time'] = pd.to_datetime(df['ts'], utc=True)
    df = df.set_index('time').sort_index()
    df = df[~df.index.duplicated(keep='first')]
    df = df.rename(columns={'open': 'Open', 'high': 'High', 'low': 'Low',
                             'close': 'Close', 'volume': 'Volume'})
    return df[['Open', 'High', 'Low', 'Close', 'Volume']].astype(float)


class _ExportUnavailable(Exception):
    """Bulk-export endpoint not deployed / symbol not served — fall back to chunked JSON."""


_TW_FUTURES_RESAMPLE_RULES = {'5m': '5min', '15m': '15min', '30m': '30min', '60m': '60min'}


def _fetch_twfutures_via_export(symbol, schema, start, end, headers):
    """Fetch intraday OHLCV via the 1m-parquet bulk export endpoint
    (GET /studio/market/twfutures/ohlcv/<symbol>/export/<year>) and resample locally.

    One request per calendar year, zero server-side computation — the server just
    streams its own year parquet. Resample semantics replicate the server's
    (resample(rule).agg(first/max/min/last/sum), dropna on open), so the output is
    interchangeable with _fetch_twfutures_raw's. Processes one year at a time to
    keep peak memory at ~one year of 1m bars (~20MB), not the full span.

    Raises _ExportUnavailable when the endpoint isn't deployed yet (or rejects the
    symbol) so the caller can fall back to the chunked JSON path.
    """
    import io
    s = datetime.strptime(start, '%Y-%m-%d')
    e = datetime.utcnow() if not end else datetime.strptime(end, '%Y-%m-%d')
    rule = _TW_FUTURES_RESAMPLE_RULES.get(schema)  # None for '1m' — no resample

    frames = []
    for year in range(s.year, e.year + 1):
        try:
            # _retry_get backs off on 429/5xx — matters when downloading many
            # year files in a row (100 symbols × 8 years brushes the rate limit)
            r = _retry_get(
                f'{BASE}/studio/market/twfutures/ohlcv/{symbol}/export/{year}',
                headers=headers, timeout=120,
            )
        except requests.HTTPError as exc:
            resp = exc.response
            if resp is not None and resp.status_code == 404:
                try:
                    if resp.json().get('error') == 'no_data':
                        continue  # valid year, just no data (e.g. before backfill start)
                except ValueError:
                    pass
                raise _ExportUnavailable(f'export route missing for {symbol}/{year}')
            raise _ExportUnavailable(f'export {symbol}/{year} -> '
                                     f'{resp.status_code if resp is not None else exc}')

        raw = pd.read_parquet(io.BytesIO(r.content))
        if raw.empty:
            continue
        raw.index = pd.to_datetime(raw['ts'], utc=True)
        data = raw[['open', 'high', 'low', 'close', 'volume']].sort_index()
        data = data[~data.index.duplicated(keep='first')]
        if rule:
            data = data.resample(rule).agg(
                open=('open', 'first'), high=('high', 'max'), low=('low', 'min'),
                close=('close', 'last'), volume=('volume', 'sum'),
            ).dropna(subset=['open'])
        frames.append(data)

    if not frames:
        return pd.DataFrame()
    df = pd.concat(frames).sort_index()
    df = df[(df.index >= pd.Timestamp(start, tz='UTC')) &
            (df.index < pd.Timestamp(e.strftime('%Y-%m-%d'), tz='UTC') + pd.Timedelta(days=1))]
    df = df.rename(columns={'open': 'Open', 'high': 'High', 'low': 'Low',
                             'close': 'Close', 'volume': 'Volume'})
    df.index.name = 'time'
    return df[['Open', 'High', 'Low', 'Close', 'Volume']].astype(float)


def _fetch_twfutures_raw_smart(symbol, schema, start, end, headers):
    """Long intraday spans → try the bulk-export path first (zero server CPU, one
    request per year); short spans, '1d', or export-unavailable → chunked JSON API."""
    if schema != '1d':
        s = datetime.strptime(start, '%Y-%m-%d')
        e = datetime.utcnow() if not end else datetime.strptime(end, '%Y-%m-%d')
        if (e - s).days > 62:
            try:
                return _fetch_twfutures_via_export(symbol, schema, start, end, headers)
            except _ExportUnavailable as exc:
                print(f'  [twfutures] export unavailable ({exc}); falling back to chunked fetch')
    return _fetch_twfutures_raw(symbol, schema, start, end, headers)


def fetch_twfutures_ohlcv(symbol, schema, start, end, headers):
    """台灣期貨 OHLCV. Returns DataFrame with Open/High/Low/Close/Volume/Amount columns.

    symbol: 'TXF' ('MXF'/'TMF' accepted as aliases — see below)
    schema: '1d' | '1m' | '5m' | '15m' | '30m' | '60m'
    Volume is in contracts (口數).

    A Shioaji-style 'R1' suffix (TXFR1, MXFR1, CDFR1…) is accepted and mapped to
    the endpoint's own name (TXF…): the underlying series IS the R1 continuous
    near-month, only the naming differs. 'R2' (next-month continuous) is NOT this
    data and is deliberately not mapped — it still 400s server-side.

    'MXF' / 'TMF' are EXECUTION-INSTRUMENT aliases for the TXF series: a
    strategy's SYMBOL declares the contract it actually trades (大台/小台/微台),
    but signals and backtests always run on TXF data — arbitrage pins all three
    to the same price, TXF minute history is the deepest, and the server has no
    TMF minute data at all. Both map to 'TXF' here (shared cache dir), so
    SYMBOL='TMF' fetches TXF bars while the order layer trades TM0000.

    For 1d: index is Asia/Taipei tz so df.index[-1].date() returns the correct trading date.
    """
    symbol = symbol.upper()
    if symbol.endswith('R1') and len(symbol) > 2:
        symbol = symbol[:-2]
    if symbol in ('MXF', 'TMF'):
        symbol = 'TXF'
    df = _extend_cache_monthly(
        f'twfutures_{schema}', {'symbol': symbol},
        lambda s, e: _fetch_twfutures_raw_smart(symbol, schema, s, e, headers),
        start, end,
        empty_marker_ttl_hours=24,   # history is backfilled progressively server-side
    )
    df = _sanity_check_ohlc(df, f'{symbol} {schema} twfutures')
    if schema == '1d' and not df.empty:
        # Cache stores naive UTC (midnight TWN = prev-day 16:00 UTC). Convert to Asia/Taipei
        # so the index date matches the actual trading date.
        df = df.copy()
        df.index = pd.to_datetime(df.index, utc=True).tz_convert('Asia/Taipei')
    return df


def fetch_twfutures_ohlcv_batch(symbols, schema, start, end, headers, max_workers=8):
    """Batch fetch_twfutures_ohlcv across many symbols, concurrently.

    Same per-symbol semantics (monthly cache, export-first for long intraday
    spans, chunked fallback) — this just runs the symbols through a thread pool
    so the per-request fixed overhead (auth round-trips) is amortised instead
    of paid serially. Safe to parallelise: each symbol has its own cache dir.

    Returns dict {symbol: DataFrame} for symbols that succeeded; failures are
    dropped with a printed warning (mirrors fetch_stock_futures_batch_daily).
    """
    results = {}
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {
            pool.submit(fetch_twfutures_ohlcv, sym, schema, start, end, headers): sym
            for sym in symbols
        }
        for future in as_completed(futures):
            sym = futures[future]
            try:
                results[sym] = future.result()
            except Exception as e:
                print(f"  [twfutures batch] skip {sym}: {e}")
    return results


def _fetch_twfutures_bid_ask_vol_raw(start, end, headers):
    """Fetch raw bid/ask vol for a date range (≤31 days per chunk)."""
    _check_data_access(headers)
    s = datetime.strptime(start, '%Y-%m-%d')
    e = datetime.utcnow() if not end else datetime.strptime(end, '%Y-%m-%d') + timedelta(days=1)
    chunk_days = 28

    chunks, cursor = [], s
    while cursor < e:
        chunk_end = min(cursor + timedelta(days=chunk_days), e)
        chunks.append((cursor.strftime('%Y-%m-%d'), chunk_end.strftime('%Y-%m-%d')))
        cursor = chunk_end

    def _fetch_one(cs, ce):
        r = requests.get(
            f'{BASE}/studio/market/twfutures/bid_ask_vol/TXF',
            headers=headers,
            params={'start': cs, 'end': ce},
            timeout=60,
        )
        r.raise_for_status()
        return r.json().get('data', [])

    rows = []
    with ThreadPoolExecutor(max_workers=5) as pool:
        futures = {pool.submit(_fetch_one, cs, ce): (cs, ce) for cs, ce in chunks}
        for future in as_completed(futures):
            rows.extend(future.result())

    df = pd.DataFrame(rows)
    if df.empty:
        return df
    df['time'] = pd.to_datetime(df['ts'], utc=True)
    df = df.set_index('time').sort_index()
    df = df[~df.index.duplicated(keep='first')]
    return df[['bid_vol', 'ask_vol', 'total_vol']].astype(int)


def fetch_twfutures_pcr(start, end, headers):
    """台指選擇權買賣權未平倉量比率（日）. Returns DataFrame with 'pcr' column.

    Source: TAIFEX (台灣期貨交易所). (History range: see the blave-quant skill / Notion API doc.)
    index: date (daily, trading days only)
    pcr: 買賣權未平倉量比率%
    """
    end_str = end or datetime.utcnow().strftime('%Y-%m-%d')
    r = _retry_get(f'{BASE}/studio/market/twfutures/option/pcr',
                   headers=headers, params={'start': start, 'end': end_str}, timeout=60)
    data = r.json().get('data', [])
    if not data:
        return pd.DataFrame(columns=['pcr'])
    df = pd.DataFrame(data)
    df['date'] = pd.to_datetime(df['date'])
    return df.set_index('date').sort_index()[['pcr']].astype(float)


_TWFUT_INST_INVESTORS = (('foreign', '外資'), ('investment_trust', '投信'), ('dealer', '自營商'))
_TWFUT_INST_COLUMNS = [f'{k}_{m}' for k, _ in _TWFUT_INST_INVESTORS
                       for m in ('net_oi', 'long_oi', 'short_oi', 'net_deal')]
# 用戶會拿執行商品名(TXF/MXF)來問法人籌碼,但 TAIFEX 的法人統計按商品代號分:
# TX=台指期、MTX=小台。微台的代號就是 TMF,有自己的一套法人統計(與 MTX 數字不同),直通。
_TWFUT_INST_ALIASES = {'TXF': 'TX', 'MXF': 'MTX'}


def _fetch_twfutures_institutional_raw(futures_id, start, end, headers):
    """Raw fetch → one row per date, 12 float columns (see _TWFUT_INST_COLUMNS).
    The endpoint returns 3 rows per day (外資/投信/自營商); pivoted here so the
    cache layer sees a plain date-indexed frame like the twmarket_* series."""
    end_str = end or datetime.utcnow().strftime('%Y-%m-%d')
    r = _retry_get(f'{BASE}/studio/market/twfutures/institutional/{futures_id}',
                   headers=headers, params={'start': start, 'end': end_str}, timeout=60)
    data = r.json().get('data', [])
    if not data:
        return pd.DataFrame(columns=_TWFUT_INST_COLUMNS)
    df = pd.DataFrame(data)
    df['date'] = pd.to_datetime(df['date'])
    out = {}
    for key, label in _TWFUT_INST_INVESTORS:
        sub = df[df['institutional_investors'] == label].set_index('date').sort_index()
        sub = sub[~sub.index.duplicated(keep='last')]
        long_oi = sub['long_open_interest_balance_volume'].astype(float)
        short_oi = sub['short_open_interest_balance_volume'].astype(float)
        out[f'{key}_net_oi'] = long_oi - short_oi
        out[f'{key}_long_oi'] = long_oi
        out[f'{key}_short_oi'] = short_oi
        out[f'{key}_net_deal'] = (sub['long_deal_volume'].astype(float)
                                  - sub['short_deal_volume'].astype(float))
    return pd.DataFrame(out).sort_index()


def fetch_twfutures_institutional(futures_id, start, end, headers):
    """期貨三大法人未平倉與交易口數(日). Returns a date-indexed DataFrame with
    12 float columns, 口數:
      {foreign|investment_trust|dealer}_net_oi   未平倉淨口數(多 − 空)——「外資期貨淨多單」就是 foreign_net_oi
      {…}_long_oi / {…}_short_oi                  未平倉多方 / 空方口數
      {…}_net_deal                                當日交易淨口數(買 − 賣)

    futures_id: 'TX'(台指期)、'MTX'(小台)、'TMF'(微台,有自己的統計);'TE'/'TF' 端點接受但
    未實測。執行商品名 'TXF'→'TX'、'MXF'→'MTX' 自動對應。
    個股期貨沒有法人統計(伺服器回 404)。資料來源 TAIFEX,盤後約 15:00 後才有當日。
    Cached like the twmarket_* daily series (one parquet per id, delta-updated).
    Raw 3-rows-per-day layout: see references/twfutures.md.
    """
    futures_id = _TWFUT_INST_ALIASES.get(futures_id.upper(), futures_id.upper())
    return _extend_cache_monthly(
        'twfutures_institutional', {'id': futures_id},
        lambda s, e: _fetch_twfutures_institutional_raw(futures_id, s, e, headers),
        start, end,
    )


# ── Market-wide series straight from TWSE / TAIFEX (free, no key) ────────────
# The key-free twin of fetch_twmarket_* and fetch_twfutures_institutional, for the two TAIEX
# report templates when this turn has no Blave data access. Same columns and units as the
# Blave series. Runs only on the user's own computer (BLAVE_AGENT_LOCAL=1, the flag
# _twstock_daily_source reads): a cloud machine never calls twse.com.tw / taifex.com.tw.
_TWSE_INDEX_HIST = 'https://www.twse.com.tw/indicesReport/MI_5MINS_HIST'
_TWSE_FMTQIK     = 'https://www.twse.com.tw/exchangeReport/FMTQIK'
_TWSE_BFI82U     = 'https://www.twse.com.tw/fund/BFI82U'
_TWSE_MI_MARGN   = 'https://www.twse.com.tw/exchangeReport/MI_MARGN'
_TAIFEX_FUT_INST = 'https://www.taifex.com.tw/cht/3/futContractsDateDown'
# Not "開放授權": BFI82U (三大法人) is not in the TWSE open-data set, so the line names the site
# the four series are read from and claims no licence.
_TWSE_SOURCE_ZH   = '資料來源:臺灣證券交易所網站'
_TWSE_SOURCE_EN   = 'Source: Taiwan Stock Exchange website'
_TAIFEX_SOURCE_ZH = '資料來源:臺灣期貨交易所(政府資料開放授權)'
_TAIFEX_SOURCE_EN = 'Source: Taiwan Futures Exchange (Open Government Data License)'
# zh attribution line → its en twin, for a report published with lang="en".
_TWSE_OPENDATA_SOURCE_ZH = '資料來源:臺灣證券交易所(政府資料開放授權)'
_TWSE_OPENDATA_SOURCE_EN = 'Source: Taiwan Stock Exchange (Open Government Data License)'
PUBLIC_SOURCE_EN = {_TW_PUBLIC_SOURCE_ZH: _TW_PUBLIC_SOURCE_EN, _TWSE_SOURCE_ZH: _TWSE_SOURCE_EN,
                    _TWSE_OPENDATA_SOURCE_ZH: _TWSE_OPENDATA_SOURCE_EN, _TAIFEX_SOURCE_ZH: _TAIFEX_SOURCE_EN}
# TWSE answers 200 + stat for everything: these mean "no rows for that date", anything
# else non-OK (throttle, layout change) raises and is never cached as an empty day.
_TWSE_NO_DATA = ('很抱歉', '沒有符合條件', '查詢日期大於', '查詢日期小於')
_BFI82U_BUCKET = {'外資及陸資(不含外資自營商)': 'foreign', '外資自營商': 'dealer', '投信': 'investment_trust',
                  '自營商(自行買賣)': 'dealer', '自營商(避險)': 'dealer', '合計': 'total'}
_TAIFEX_INST_COMMODITY = {'TX': 'TXF', 'MTX': 'MXF', 'TMF': 'TMF'}
_TAIFEX_INVESTOR = {'外資及陸資': 'foreign', '外資': 'foreign', '投信': 'investment_trust', '自營商': 'dealer'}


def tw_market_public_allowed():
    """True only on the desktop build (BLAVE_AGENT_LOCAL=1) — canon: key-free sources are
    fetched on the user's own computer, never from a Blave-hosted machine."""
    return os.environ.get('BLAVE_AGENT_LOCAL') == '1'


def _tw_market_public_gate():
    if not tw_market_public_allowed():
        raise TwPublicUnavailable('key-free market data runs only on the desktop build (BLAVE_AGENT_LOCAL=1)')


def _twse_json(url, params, label):
    """TWSE JSON with stat OK → payload; a no-data stat → None; anything else raises."""
    j = _tw_public_get(url, dict(params, response='json')).json()
    stat = str(j.get('stat', ''))
    if stat == 'OK':
        return j
    if any(m in stat for m in _TWSE_NO_DATA):
        return None
    raise TwPublicUnavailable(f'TWSE {label}: {stat[:60]}')


def _in_window(df, s, e):
    return df[(df.index >= pd.Timestamp(s)) & (df.index < pd.Timestamp(e))] if len(df) else df


def _twse_monthly_raw(url, label, cols, parse, s, e):
    rows = []
    for ym in _tw_public_months(s, e):
        j = _twse_json(url, {'date': f'{ym[:4]}{ym[5:7]}01'}, f'{label} {ym}')
        for x in (j or {}).get('data') or []:
            d = _roc_date(x[0])
            if d.strftime('%Y-%m') == ym:   # TWSE sometimes pads a month with a neighbour's rows
                rows.append((d, *parse(x)))
    df = pd.DataFrame(rows, columns=['date'] + cols).set_index('date').sort_index()
    return _in_window(df.astype(float), s, e)


def _twse_daily_raw(url, label, params, cols, parse, s, e):
    """One request per TWSE trading day in [s, e) — the days come from the public index
    series, so holidays cost nothing. A no-data answer for an older trading day raises (it
    would otherwise be cached as a hole for good); for today it means not published yet, and
    so it does for yesterday within this month (MI_MARGN comes out in the evening and runs
    past midnight on heavy days — the frame then ends a day earlier instead of failing)."""
    now = datetime.now(_TPE)
    today = now.strftime('%Y-%m-%d')
    yesterday = (now - timedelta(days=1)).strftime('%Y-%m-%d')
    days = fetch_twmarket_index_public(s, (pd.Timestamp(e) - timedelta(days=1)).strftime('%Y-%m-%d')).index
    rows = []
    for d in days:
        day = d.strftime('%Y-%m-%d')
        j = _twse_json(url, params(day.replace('-', '')), f'{label} {day}')
        if j is None:
            if day < today and not (day >= yesterday and day[:7] == today[:7]):
                raise TwPublicUnavailable(f'TWSE {label} {day}: no data for a trading day')
            continue
        rows.append((d, *parse(j)))
    return pd.DataFrame(rows, columns=['date'] + cols).set_index('date').sort_index().astype(float)


def _bfi82u_row(j):
    net = {}
    for x in j.get('data') or []:
        bucket = _BFI82U_BUCKET.get(str(x[0]).strip())
        if bucket:
            net[bucket] = net.get(bucket, 0.0) + _tw_num(x[3])
    if 'total' not in net:
        raise TwPublicUnavailable('TWSE BFI82U: no 合計 row')
    return tuple(net.get(c, float('nan')) for c in _TWMARKET_INST_COLUMNS)


def _mi_margn_row(j):
    # 信用交易統計: 項目, 買進, 賣出, 現金(券)償還, 前日餘額, 今日餘額 — 交易單位 = 張, 金額 仟元
    tables = [t for t in j.get('tables') or [] if '信用交易統計' in str(t.get('title', ''))]
    rows = {str(x[0]).strip(): x for x in (tables[0].get('data') if tables else [])}
    try:
        m, s, v = rows['融資(交易單位)'], rows['融券(交易單位)'], rows['融資金額(仟元)']
    except KeyError:
        raise TwPublicUnavailable('TWSE MI_MARGN: 信用交易統計 layout changed') from None
    return _tw_num(m[5]), _tw_num(m[4]), _tw_num(v[5]) * 1000, _tw_num(s[5]), _tw_num(s[4])


def _public_series(kind, raw, start, end, source):
    _tw_market_public_gate()
    df = _extend_cache_monthly('twmarket_public', {'kind': kind}, raw, start, end)
    df.attrs['source'] = source
    return df


def fetch_twmarket_index_public(start, end):
    """fetch_twmarket_index('TAIEX') from TWSE MI_5MINS_HIST, one month per request.
    Desktop only (tw_market_public_allowed); attrs['source'] = 'TWSE'."""
    raw = lambda s, e: _twse_monthly_raw(_TWSE_INDEX_HIST, 'MI_5MINS_HIST', ['Open', 'High', 'Low', 'Close'],
                                         lambda x: tuple(_tw_num(v) for v in x[1:5]), s, e)
    return _sanity_check_ohlc(_public_series('index', raw, start, end, 'TWSE'), 'TAIEX twse index')


def fetch_twmarket_turnover_public(start, end):
    """fetch_twmarket_turnover from TWSE FMTQIK (成交股數 / 成交金額 元 / 成交筆數)."""
    raw = lambda s, e: _twse_monthly_raw(_TWSE_FMTQIK, 'FMTQIK', _TWMARKET_TURNOVER_COLUMNS,
                                         lambda x: tuple(_tw_num(v) for v in x[1:4]), s, e)
    return _public_series('turnover', raw, start, end, 'TWSE')


def fetch_twmarket_institutional_public(start, end):
    """fetch_twmarket_institutional from TWSE BFI82U, one trading day per request (net 元;
    外資自營商 counted in dealer, as the Blave series)."""
    raw = lambda s, e: _twse_daily_raw(_TWSE_BFI82U, 'BFI82U', lambda d: {'type': 'day', 'dayDate': d},
                                       _TWMARKET_INST_COLUMNS, _bfi82u_row, s, e)
    return _public_series('institutional', raw, start, end, 'TWSE')


def fetch_twmarket_margin_public(start, end):
    """fetch_twmarket_margin from TWSE MI_MARGN 信用交易統計, one trading day per request
    (balances in 張, margin_balance_value 元 = 融資金額仟元 × 1,000)."""
    raw = lambda s, e: _twse_daily_raw(_TWSE_MI_MARGN, 'MI_MARGN', lambda d: {'date': d, 'selectType': 'MS'},
                                       _TWMARKET_MARGIN_COLUMNS, _mi_margn_row, s, e)
    return _public_series('margin', raw, start, end, 'TWSE')


def _tw_public_post(url, data, tries=3):
    for attempt in range(tries):
        _TW_PUBLIC_LIMITER.acquire()
        try:
            r = _tw_public_session().post(url, data=data, headers=_TW_PUBLIC_HEADERS, timeout=30)
        except (requests.exceptions.Timeout, requests.exceptions.ConnectionError):
            if attempt == tries - 1:
                raise
            time.sleep(2 ** (attempt + 1))
            continue
        if (r.status_code == 429 or r.status_code >= 500) and attempt < tries - 1:
            time.sleep(2 ** (attempt + 1))
            continue
        r.raise_for_status()
        return r


def _taifex_inst_raw(commodity, s, e):
    """TAIFEX 三大法人-區分各期貨契約 CSV (cp950) for [s, e). TAIFEX answers an HTML page when
    queryEndDate is past its last published day, so near today the end steps back a day at a
    time (12 days covers the Lunar New Year closure); an HTML answer for a window that ended
    longer ago than that is an error, not 'no data'."""
    today = datetime.now(_TPE).date()
    first = pd.Timestamp(s).date()
    last = min(pd.Timestamp(e).date() - timedelta(days=1), today)
    while last >= first:
        r = _tw_public_post(_TAIFEX_FUT_INST, {'commodityId': commodity,
                                               'queryStartDate': first.strftime('%Y/%m/%d'),
                                               'queryEndDate': last.strftime('%Y/%m/%d')})
        lines = [ln for ln in r.content.decode('cp950', errors='replace').splitlines() if ln.strip()]
        if lines and '身份別' in lines[0]:
            break
        if (today - last).days >= 12:
            raise TwPublicUnavailable(f'TAIFEX futContractsDateDown {commodity} {first}–{last}: not a CSV answer')
        last -= timedelta(days=1)
    else:
        return pd.DataFrame(columns=_TWFUT_INST_COLUMNS)
    rows = list(csv.reader(lines))
    col = {name.strip(): i for i, name in enumerate(rows[0])}
    need = ('日期', '身份別', '多方交易口數', '空方交易口數', '多方未平倉口數', '空方未平倉口數')
    if any(n not in col for n in need):
        raise TwPublicUnavailable(f'TAIFEX futContractsDateDown: unexpected header {sorted(col)[:6]}')
    out = {}
    for x in rows[1:]:
        who = _TAIFEX_INVESTOR.get(x[col['身份別']].strip())
        if who is None:
            continue
        rec = out.setdefault(pd.Timestamp(x[col['日期']].strip().replace('/', '-')), {})
        lo, so = _tw_num(x[col['多方未平倉口數']]), _tw_num(x[col['空方未平倉口數']])
        rec[f'{who}_net_oi'], rec[f'{who}_long_oi'], rec[f'{who}_short_oi'] = lo - so, lo, so
        rec[f'{who}_net_deal'] = _tw_num(x[col['多方交易口數']]) - _tw_num(x[col['空方交易口數']])
    df = pd.DataFrame.from_dict(out, orient='index').reindex(columns=_TWFUT_INST_COLUMNS).sort_index()
    df.index.name = 'date'
    return df.astype(float)


def fetch_twfutures_institutional_public(futures_id, start, end):
    """fetch_twfutures_institutional from TAIFEX futContractsDateDown (same 12 columns, 口數).
    'TX'/'TXF', 'MTX'/'MXF', 'TMF' only; attrs['source'] = 'TAIFEX'."""
    fid = _TWFUT_INST_ALIASES.get(futures_id.upper(), futures_id.upper())
    commodity = _TAIFEX_INST_COMMODITY.get(fid)
    if commodity is None:
        raise TwPublicUnavailable(f'TAIFEX institutional: {futures_id} not supported on the key-free path')
    return _public_series(f'futinst_{fid}', lambda s, e: _taifex_inst_raw(commodity, s, e), start, end, 'TAIFEX')


def fetch_twfutures_bid_ask_vol(start, end, headers):
    """台指期內外盤成交量（1 分鐘）. Returns DataFrame indexed by UTC time.

    Columns: bid_vol (內盤口數), ask_vol (外盤口數), total_vol (總口數).
    Both day session (08:45-13:45 TWN) and night session included.
    (History range: see the blave-quant skill / Notion API doc.)
    Monthly cache: cache/twfutures_bav_TXF/YYYY-MM.parquet
    """
    result = _extend_cache_monthly(
        'twfutures_bav', {'symbol': 'TXF'},
        lambda s, e: _fetch_twfutures_bid_ask_vol_raw(s, e, headers),
        start, end,
        empty_marker_ttl_hours=24,   # history is backfilled progressively server-side
    )
    if result.empty:
        return result
    for col in ['bid_vol', 'ask_vol', 'total_vol']:
        if col in result.columns:
            result[col] = result[col].astype(int)
    return result


def fetch_stock_futures_batch_daily(futures_ids, start, end, headers):
    """Batch daily OHLCV/OI for individual stock futures (max 250 ids per call,
    server-side parallel fetch + cache). Returns dict {futures_id: DataFrame}
    for ids with data; ids that hit persistent upstream rate-limiting are
    dropped and printed as a warning (a genuinely empty dataset for a valid id
    is not an error, just an empty DataFrame — not omitted).

    Locally cached per (futures_id, start, end) under cache/twfutures_stockfut/ —
    an EXACT-range cache, not the monthly-delta cache the other twstock/twfutures
    fetchers use. This dataset has multiple rows per day per id (every listed
    contract month x trading_session), so the monthly cache's dedup-by-date would
    silently collapse those down to one row per day. An exact-range cache avoids
    that at the cost of not supporting incremental "extend to today" delta fetches —
    with END=None (the standard config, END is never pinned) the resolved end date
    moves daily, so the first run each day re-fetches the full range; later runs the
    same day hit the cache.

    Same fields as fetch_twfutures_daily: date, futures_id, contract_date,
    open, max, min, close, spread, spread_per, volume, settlement_price,
    open_interest, trading_session. futures_ids must be valid stock futures
    ids (股票期貨, e.g. 'CDF') — arbitrary ids are rejected (400).
    """
    end_str = end or datetime.utcnow().strftime('%Y-%m-%d')
    cache_dir = _CACHE_DIR / 'twfutures_stockfut'
    cache_dir.mkdir(parents=True, exist_ok=True)

    results, to_fetch = {}, []
    for fid in futures_ids:
        path = cache_dir / f'{fid}__{start}__{end_str}.parquet'
        if path.exists():
            results[fid] = pd.read_parquet(path)
        else:
            to_fetch.append(fid)

    def _fetch_chunk(chunk):
        r = _retry_get(
            f'{BASE}/studio/market/twfutures/stock_futures/batch/daily',
            headers=headers,
            params={'futures_ids': ','.join(chunk), 'start': start, 'end': end},
            timeout=120,
        )
        body = r.json()
        failed = body.get('failed', [])
        if failed:
            print(f"[fetch_stock_futures_batch_daily] rate-limited after retries, dropped: {failed}")
        for fid, rows in body.get('data', {}).items():
            df = pd.DataFrame(rows)
            df.to_parquet(cache_dir / f'{fid}__{start}__{end_str}.parquet')
            results[fid] = df

    chunks = [to_fetch[i:i + 200] for i in range(0, len(to_fetch), 200)]
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(_fetch_chunk, chunks))

    return results


def fetch_stock_futures_ohlcv_symbols(headers):
    """Currently-allowed symbols for fetch_twfutures_ohlcv (intraday/minute-line
    coverage) — always includes 'TXF' plus whichever individual stock futures
    ids currently have backfilled Shioaji minute-line data (a dynamically-
    growing subset of the 231 total). Returns a plain list of symbol strings.

    Call this before fetch_twfutures_ohlcv on a stock future to check coverage
    up front, instead of trial-and-erroring against the 400 response.

    Entries are suffix-less names ('TXF', 'CDF') — strip a Shioaji-style 'R1'
    suffix before the membership check (fetch_twfutures_ohlcv itself accepts
    'CDFR1' and maps it, but 'CDFR1' will never appear in this list). 'MXF' /
    'TMF' likewise never appear — fetch_twfutures_ohlcv aliases them to 'TXF'.
    """
    r = _retry_get(f'{BASE}/studio/market/twfutures/ohlcv/symbols', headers=headers, timeout=30)
    return r.json().get('data', [])


def txf_settlement_mask(index):
    """Return a boolean Series (same index) that is True on the last bar strictly
    before each TAIFEX monthly settlement (3rd Wednesday, 13:30 TWN).

    Interval-agnostic: 1m data marks the 13:29 bar, 60m data marks the 13:00 bar,
    etc. Applies to every TAIFEX monthly-settled product — TXF and individual
    stock futures share the same settlement calendar — and MUST be applied by any
    strategy on `fetch_twfutures_*` data: the source is Shioaji's R1 continuous
    near-month series, which switches contracts at settlement WITHOUT price
    adjustment, so an unmasked position books the contract-basis gap as fake PnL
    (measured 2018-2026 across 10 stock futures: mean +0.36%/roll, std 3.9%,
    August dividend-season mean -1.9%).

    Usage in compute_signals:
        settle = txf_settlement_mask(df.index)
        signal[settle] = 0.0        # Type A;  Type C: weights.loc[settle] = 0.0
        return signal, settle       # settle doubles as exec_at_close
    """
    import datetime
    from zoneinfo import ZoneInfo   # stdlib — no pytz dependency (pandas 3.x stopped pulling it in;
                                    # a fresh Windows box had no pytz and every 台指期 backtest died here)

    twn = ZoneInfo('Asia/Taipei')   # ZoneInfo handles offsets/DST natively — no pytz localize() needed

    def _third_wed(year, month):
        d, count = datetime.date(year, month, 1), 0
        while True:
            if d.weekday() == 2:
                count += 1
                if count == 3:
                    return d
            d = d + datetime.timedelta(days=1)

    mask  = pd.Series(False, index=index)
    start = index.min()
    end   = index.max()
    # Reach one bar past the last label: on a live tick the pre-settlement bar IS the last
    # bar, and bounding the loop at index.max() never considered the settlement it precedes,
    # so live held through settlement while the backtest (which sees the next bar) was flat.
    # One bar, not one day — a day would mark the 12:00 tick and flatten hours early.
    bar = index.to_series().diff().median() if len(index) > 1 else pd.NaT
    if pd.notna(bar):
        end = end + bar

    year, month = start.year, start.month
    while True:
        wed = _third_wed(year, month)
        ts_settle = pd.Timestamp(
            datetime.datetime(wed.year, wed.month, wed.day, 13, 30, tzinfo=twn)
            .astimezone(datetime.timezone.utc)
        )
        if index.tz is None:
            ts_settle = ts_settle.tz_localize(None)
        if ts_settle > end:
            break
        # last bar with label strictly before the settlement moment; guard
        # against marking a far-away bar when the symbol has a data gap
        pos = index.searchsorted(ts_settle) - 1
        if pos >= 0 and (ts_settle - index[pos]) <= pd.Timedelta(days=1):
            mask.iloc[pos] = True
        month += 1
        if month > 12:
            month, year = 1, year + 1
    return mask


def _trader_day_cache_path(trader_id, date_str):
    """cache/twstock_broker_trader_<trader_id>/<date>.parquet"""
    d = _CACHE_DIR / f'twstock_broker_trader_{trader_id}'
    d.mkdir(parents=True, exist_ok=True)
    return d / f'{date_str}.parquet'


def fetch_twstock_trader_flows(trader_id, start, end, headers,
                               rate_limit=270, period=300, max_retries=5, **_kwargs):
    """分點對所有股票每日淨買賣超 (buy - sell).

    trader_id: securities_trader_id, e.g. '9217' for 凱基-松山.
    Local cache: cache/twstock_broker_trader_<trader_id>/<YYYY-MM-DD>.parquet
    每天存全部股票完整資料，只 fetch 沒有的日期（90-day range chunks）。
    Returns long-format DataFrame indexed by (date, stock_id) with 'net' column.
    """
    from datetime import date as _date

    end_dt   = _date.fromisoformat(end)   if end   else _date.today()
    start_dt = _date.fromisoformat(start)

    weekdays = [start_dt + timedelta(days=i)
                for i in range((end_dt - start_dt).days + 1)
                if (start_dt + timedelta(days=i)).weekday() < 5]

    _populate_trader_day_cache(trader_id, weekdays, headers,
                               rate_limit=rate_limit, period=period, max_retries=max_retries)

    frames = []
    for d in weekdays:
        path = _trader_day_cache_path(trader_id, d.isoformat())
        if not path.exists():
            continue
        df_day = pd.read_parquet(path)
        if df_day.empty or 'stock_id' not in df_day.columns:
            continue
        df_day = df_day.copy()
        df_day['net'] = df_day['buy'].astype(float) - df_day['sell'].astype(float)
        df_day['date'] = pd.to_datetime(d.isoformat())
        frames.append(df_day[['date', 'stock_id', 'net']])

    if not frames:
        return pd.DataFrame(columns=['date', 'stock_id', 'net']).set_index(['date', 'stock_id'])
    result = pd.concat(frames, ignore_index=True)
    return result.groupby(['date', 'stock_id'])['net'].sum().to_frame()


_TWSE_OPENAPI = 'https://openapi.twse.com.tw/v1'


def _twse_openapi(path):
    """One TWSE open-data JSON list (openapi.twse.com.tw). Keys are stripped: the feeds carry
    stray spaces in field names (t187ap04_L's 「主旨 」)."""
    _tw_market_public_gate()
    rows = _tw_public_get(f'{_TWSE_OPENAPI}/{path}', {}).json()
    if not isinstance(rows, list):
        raise TwPublicUnavailable(f'TWSE openapi {path}: not a list')
    return [{str(k).strip(): v for k, v in r.items()} for r in rows if isinstance(r, dict)]


def fetch_tw_announcements_public():
    """上市公司重大訊息 (TWSE open data t187ap04_L) — the latest publication day only, straight
    from TWSE, desktop only (BLAVE_AGENT_LOCAL=1; TwPublicUnavailable elsewhere). DataFrame,
    newest first: time (Taipei, tz-aware), stock_id, name, subject, clause (「第51款」),
    fact_date ('YYYY-MM-DD' or None). The long 說明 text is left out.
    attrs['source'] is the attribution line to keep with anything that shows it."""
    cols = ['time', 'stock_id', 'name', 'subject', 'clause', 'fact_date']
    out = []
    for r in _twse_openapi('opendata/t187ap04_L'):
        try:
            day = _roc_ymd(r.get('發言日期'))
            hms = str(r.get('發言時間') or '0').strip().zfill(6)
            t = day + pd.Timedelta(hours=int(hms[:2]), minutes=int(hms[2:4]), seconds=int(hms[4:6]))
        except (TypeError, ValueError):
            continue
        subject = ' '.join(str(r.get('主旨') or '').split())
        if not subject:
            continue
        try:
            fact = _roc_ymd(r.get('事實發生日')).strftime('%Y-%m-%d')
        except (TypeError, ValueError):
            fact = None
        out.append({'time': t.tz_localize('Asia/Taipei'), 'stock_id': str(r.get('公司代號') or '').strip(),
                    'name': str(r.get('公司名稱') or '').strip(), 'subject': subject,
                    'clause': str(r.get('符合條款') or '').strip(), 'fact_date': fact})
    df = pd.DataFrame(out, columns=cols).sort_values('time', ascending=False).reset_index(drop=True)
    df.attrs['source'] = _TWSE_OPENDATA_SOURCE_ZH
    return df


def fetch_twse_day_all_public():
    """Every TWSE-listed security's last trading day (TWSE open data STOCK_DAY_ALL), desktop
    only. DataFrame indexed by stock_id: name, value (成交金額, NTD), volume (股), close, change
    (points), trades; attrs['date'] ('YYYY-MM-DD'), attrs['source'] (attribution). ETFs and
    other listed securities are in it — the feed has no type column."""
    rows, day = [], None
    for r in _twse_openapi('exchangeReport/STOCK_DAY_ALL'):
        code = str(r.get('Code') or '').strip()
        if not code:
            continue
        day = day or r.get('Date')
        rows.append({'stock_id': code, 'name': str(r.get('Name') or '').strip(),
                     'value': _tw_num(r.get('TradeValue')), 'volume': _tw_num(r.get('TradeVolume')),
                     'close': _tw_num(r.get('ClosingPrice')), 'change': _tw_num(r.get('Change')),
                     'trades': _tw_num(r.get('Transaction'))})
    df = pd.DataFrame(rows, columns=['stock_id', 'name', 'value', 'volume', 'close', 'change', 'trades'])
    df = df.set_index('stock_id')
    df.attrs['date'] = _roc_ymd(day).strftime('%Y-%m-%d') if day else None
    df.attrs['source'] = _TWSE_OPENDATA_SOURCE_ZH
    return df


def _roc_ymd(s):
    """民國 'YYYMMDD' ('1150925') → Timestamp 2026-09-25."""
    s = str(s).strip()
    if not s.isdigit() or len(s) not in (6, 7):
        raise ValueError(f'not a ROC yyyMMdd date: {s!r}')
    return pd.Timestamp(year=int(s[:-4]) + 1911, month=int(s[-4:-2]), day=int(s[-2:]))


_BINANCE_TICKER_24H = 'https://fapi.binance.com/fapi/v1/ticker/24hr'


def fetch_binance_ticker_24h():
    """Binance USDT-M perpetuals, rolling 24 h (public, no key, any machine). DataFrame indexed
    by symbol (BTCUSDT): last, change_pct (percent, +3.2 = +3.2 %), quote_volume (USDT).
    Only symbols ending in USDT; one request."""
    # A report brick, not a backtest: two tries, then the caller drops the table (a blocked region must
    # not stall every brief for minutes of backoff).
    rows = _binance_get(_BINANCE_TICKER_24H, {}, max_retries=2, timeout=15, max_wait=5).json()
    out = [{'symbol': r['symbol'], 'last': float(r['lastPrice']), 'change_pct': float(r['priceChangePercent']),
            'quote_volume': float(r['quoteVolume'])}
           for r in rows if isinstance(r, dict) and str(r.get('symbol', '')).endswith('USDT')]
    return pd.DataFrame(out, columns=['symbol', 'last', 'change_pct', 'quote_volume']).set_index('symbol')


def fetch_news(headers, q=None, since=None, limit=None):
    """鉅亨 B2B news candidates via Blave (licensed; needs Blave data access like the paid
    series — DataAccessError without it). DataFrame newest first: id, title, published_at
    (unix s), source, tags (list), stocks (list). Titles and times only, no article text and
    no link: the licence covers the headline. `q` matches title / tags (whole word for
    Latin: SOL does not match Solidigm), `since` unix seconds. A down upstream is a 503
    (requests.HTTPError after retries), never an empty frame."""
    params = {}
    if q:
        params['q'] = q
    if since is not None:
        params['since'] = int(since)
    if limit is not None:
        params['limit'] = int(limit)
    # A report brick: give up in seconds (two tries, ~6 s of backoff) and let the brief go out
    # without the candidates, rather than hold every brief for two minutes while the source is down.
    r = _retry_get(f'{BASE}/studio/market/anue/news', headers=headers, params=params, timeout=10,
                   max_retries=2)
    data = r.json().get('data') or []
    return pd.DataFrame(data, columns=['id', 'title', 'published_at', 'source', 'tags', 'stocks'])


def fetch_economic_calendar(headers, start=None, end=None, countries=None,
                            max_priority=None, limit=None, lang='zh'):
    """總經事件行事曆（授權資料源）—— 事件時間、市場預期值、前值、實際值。

    **這是總經事件與其數字的唯一來源。** 任何「本週有什麼重要事件」「這個數據預期多少 /
    前值多少」的問題都用這支，不要自己上網搜、更不要憑記憶寫數字：實測 agent 自行搜尋會
    整張抄到內容農場的錯誤表格（把已公布的實際值當成預期值），沒抄到的欄位再用訓練資料
    填空，連「前值」這種唯一解的數字都會寫錯，也會把 A 指標的數字安到 B 指標上。
    查不到的欄位就說查不到，不要填。

    資料只涵蓋前後約五週（滾動窗口，非歷史庫）；超出範圍的區間回空 DataFrame，不是錯誤。

    start / end: 'YYYY-MM-DD' 台北日期，含頭含尾（省略 = 不限）。
    countries:   ISO 兩碼 list，如 ['US', 'CN', 'TW']（省略 = 全部）。
    max_priority: 只回 priority <= 此值。**priority 1 最重要、3 最不重要**（1 是非農、
                 利率決議這種級別）—— 所以「只要最重要的事件」是 max_priority=1，不是 3。
    limit:       筆數上限（依事件時間排序後截斷）。
    lang:        指標與國名的顯示語言，'zh'（預設）或 'en'。伺服器只換掉對照表裡有的
                 名稱，沒收錄的維持原本的中文，所以 'en' 會拿到中英混雜的結果。

    Returns DataFrame sorted by event time, one row per event:
      datetime      台北時間（time 為 null 的事件用當日 00:00）
      date / time   台北日期、'HH:MM'（部分事件沒有公布時間，time 為 None）
      country       ISO 兩碼 / country_name 中文國名
      subject       指標名稱；subject_title 是期別，如 '<7月>'、'<2季>'
      predict       市場預期（consensus）；未提供為 None
      last          前值
      real          實際值；尚未公布為 None
      unit          單位（'%'、'point'、'億USD' …）
      priority      1~3，1 最重要
    """
    params = {'lang': lang}
    if start:
        params['start'] = start
    if end:
        params['end'] = end
    if countries:
        params['country'] = ','.join(countries)
    if max_priority is not None:
        params['max_priority'] = max_priority
    if limit is not None:
        params['limit'] = limit

    r = _retry_get(f'{BASE}/studio/market/anue/economic_calendar',
                   headers=headers, params=params, timeout=60)
    payload = r.json()
    data = payload.get('data', []) if isinstance(payload, dict) else payload
    if not data:
        return pd.DataFrame(columns=['datetime', 'date', 'time', 'country', 'country_name',
                                     'subject_title', 'subject', 'predict', 'last', 'real',
                                     'unit', 'priority'])

    df = pd.DataFrame(data).rename(columns={
        'countryId': 'country', 'countryName': 'country_name', 'subjectTitle': 'subject_title',
    })
    # startDate 是事件當天（台北日期）的 epoch 秒；time 是台北時間的 'HH:MM'
    df['date'] = pd.to_datetime(df['startDate'], unit='s').dt.normalize()
    df['datetime'] = df['date'] + pd.to_timedelta(
        df['time'].fillna('00:00') + ':00'
    )
    # Re-apply the filters locally: this workspace and the API deploy on separate
    # schedules, so an older server silently ignores the query params and hands
    # back all ~1,400 rows. Filtering here keeps the contract true either way.
    if start:
        df = df[df['date'] >= pd.Timestamp(start)]
    if end:
        df = df[df['date'] <= pd.Timestamp(end)]
    if countries:
        wanted = {c.upper() for c in countries}
        df = df[df['country'].str.upper().isin(wanted)]
    if max_priority is not None:
        df = df[df['priority'] <= max_priority]  # 上游 1 最重要、3 最不重要

    cols = ['datetime', 'date', 'time', 'country', 'country_name', 'subject_title',
            'subject', 'predict', 'last', 'real', 'unit', 'priority']
    df = df[[c for c in cols if c in df.columns]].sort_values('datetime').reset_index(drop=True)
    return df.head(limit) if limit else df


# ── Crypto Fear & Greed index (alternative.me, free, no key) ──────────────────
# 資料來源:alternative.me — their API rules (https://alternative.me/crypto/fear-and-greed-index/,
# read 2026-09-24): "You must properly acknowledge the source of the data and prominently
# reference it accordingly. Commercial use is allowed as long as the attribution is given
# right next to the display of the data." A report or reply that shows the number carries
# the line; the frame carries it in attrs['source'].
_FNG_URL   = 'https://api.alternative.me/fng/'
_FNG_START = '2018-02-01'     # first row of the history (timestamp 1517443200)
_FNG_SOURCE = '資料來源:alternative.me (Crypto Fear & Greed Index)'


def _fetch_fear_greed_raw(start, end):
    """Rows from `start` on, in one request: `limit` = the days from start to today (0 = the
    whole history, when start is at or before the first row). Same throttle as the other
    key-free daily sources."""
    days = (datetime.utcnow().date() - datetime.strptime(start, '%Y-%m-%d').date()).days + 2
    limit = 0 if start <= _FNG_START else max(days, 1)
    r = _tw_public_get(_FNG_URL, {'limit': limit, 'format': 'json'})
    j = r.json()
    if (j.get('metadata') or {}).get('error'):
        raise RuntimeError(f"alternative.me fng: {j['metadata']['error']}")
    rows = j.get('data', [])
    if not rows:
        return pd.DataFrame(columns=['value', 'classification'])
    df = pd.DataFrame({
        'value': [float(x['value']) for x in rows],
        'classification': [str(x['value_classification']) for x in rows],
    }, index=pd.to_datetime([int(x['timestamp']) for x in rows], unit='s'))
    df.index.name = 'date'
    return df.sort_index()


def fetch_fear_greed(start=None, end=None):
    """Crypto Fear & Greed index, one row per UTC day (naive UTC midnight index, like
    fetch_kline '1d'): `value` 0–100 (0 = extreme fear) and `classification` (Extreme
    Fear / Fear / Neutral / Greed / Extreme Greed). History from 2018-02-01; start defaults
    to it. No key; monthly cache (past months once, the current month re-fetched).

    The row for day D is the index computed at D 00:00 UTC — the API's own countdown
    (time_until_update) points at the next 00:00 UTC — so it is a snapshot taken at the
    day's open, and align_feed / FEED_TIMING['fear_greed'] make it visible from D 01:00.
    attrs['source'] is the attribution line alternative.me's rules require next to the
    number; keep it in any report or reply that shows the value."""
    start = start or _FNG_START
    df = _extend_cache_monthly('fear_greed', {'src': 'alternative.me'}, _fetch_fear_greed_raw, start, end)
    df.attrs['source'] = _FNG_SOURCE
    return df


# ── Publication-time alignment for non-price feeds ────────────────────────────
# A feed row is stamped with the period it DESCRIBES (三大法人 for trading day D is stamped
# D 00:00; a Blave alpha row is stamped with its bucket's open). What a bar may use is what
# had been PUBLISHED by that bar's close. align_feed() re-stamps each row with its
# availability time from FEED_TIMING and attaches to every bar the latest row available by
# the bar's close (label + interval). Live (inside live_feeds()), a bar whose due row has
# not landed raises FeedNotPublished instead of quietly using the previous value; in a
# backtest those trailing bars are trimmed.
#
# Each time is the LATER of the official publication and the moment Blave serves it: the
# api caches most TW daily endpoints for 5 minutes (REDIS_TTL = 300), and the FinMind
# fundamental endpoints (_get_fundamental: 月營收, 財報, 外資持股) per UTC day — a copy
# fetched before the evening publish is served until the api's UTC date rolls over, 08:00
# Taipei the next day. The one remaining 待確認 per entry is named in its basis; those keep
# a conservative (late) time — never tighten one without a source.

_FINMIND_CHIP = 'https://finmind.github.io/tutor/TaiwanMarket/Chip/'
_FINMIND_FUND = 'https://finmind.github.io/tutor/TaiwanMarket/Fundamental/'
_FINMIND_TECH = 'https://finmind.github.io/tutor/TaiwanMarket/Technical/'
_FINMIND_DERIV = 'https://finmind.github.io/tutor/TaiwanMarket/Derivative/'
_TWSE_ESHOP = 'https://eshop.twse.com.tw/zh/product/detail/'
_FSC_FIN_RULES = 'https://law.fsc.gov.tw/LawContent.aspx?id=GL000593'
_API_CACHE = pd.Timedelta(minutes=5)          # api REDIS_TTL = 300 on the TW daily endpoints


def _same_day_at(hour, minute=0):
    """Daily row stamped with its trading date → that date at HH:MM (feed tz)."""
    return lambda stamps: stamps.normalize() + pd.Timedelta(hours=hour, minutes=minute)


def _next_day_at(hour, minute=0):
    return lambda stamps: stamps.normalize() + pd.Timedelta(days=1, hours=hour, minutes=minute)


def _next_day_start(stamps):
    return stamps.normalize() + pd.Timedelta(days=1)


def _after_own_period(stamps, period):
    return stamps + period


def _weekday_on_or_after(days):
    """Saturday / Sunday → the following Monday (FinMind's fundamental refresh is weekdays)."""
    return days + pd.to_timedelta(np.where(days.dayofweek == 5, 2, np.where(days.dayofweek == 6, 1, 0)),
                                  unit='D')


def _revenue_available(stamps, due_day=10):
    """FinMind TaiwanStockMonthRevenue stamps March revenue 2019-04-01 (the month it is filed
    in). Filed by the `due_day` (證券交易法 §36: the 10th; 保險業 the 15th from FY2026, see
    _revenue_available_insurance) → FinMind refreshes weekdays 18:00 → the api's UTC-day
    cache serves it from 08:00 Taipei the next day."""
    due = stamps.normalize() - pd.to_timedelta(stamps.day - due_day, unit='D')
    return _weekday_on_or_after(due) + pd.Timedelta(days=1, hours=8)


def _revenue_available_insurance(stamps):
    """公開發行公司財務報告及營運情形公告申報特殊適用範圍辦法 §3(5): 保險業 may file monthly
    revenue by the 15th from FY 115 (2026) on — January 2026 revenue is stamped 2026-02-01."""
    from_2026 = stamps.tz_localize(None) >= pd.Timestamp('2026-02-01') if stamps.tz is not None \
        else stamps >= pd.Timestamp('2026-02-01')
    return _revenue_available(stamps, 15).where(from_2026, _revenue_available(stamps, 10))


def _quarterly_report_available(stamps, q2_deadline=(8, 14)):
    """Filing deadlines (證券交易法 §36): Q1/Q3 45 days after quarter end (5/15, 11/14), Q2
    8/14 (金融控股·銀行·證券·期貨·保險 listed issuers: 8/31, see
    _quarterly_report_available_finance), annual 3/31. FinMind then serves it; the api's
    UTC-day cache → 08:00 Taipei the day after the deadline. Keyed on the stamp's quarter,
    so it holds whether the row is stamped at quarter start or end."""
    q, y = stamps.quarter, stamps.year
    month = np.select([q == 1, q == 2, q == 3], [5, q2_deadline[0], 11], 3)
    day = np.select([q == 1, q == 2, q == 3], [15, q2_deadline[1], 14], 31)
    year = np.where(q == 4, y + 1, y)
    deadline = pd.DatetimeIndex(pd.to_datetime({'year': year, 'month': month, 'day': day}))
    return deadline.tz_localize(stamps.tz) + pd.Timedelta(days=1, hours=8)


def _quarterly_report_available_finance(stamps):
    return _quarterly_report_available(stamps, q2_deadline=(8, 31))


def _weekly_shareholding_available(stamps):
    return stamps.normalize() + pd.Timedelta(days=3, hours=8)


def _econ_available(stamps, frame):
    """Event rows: `real` is known at the release time plus the api's 5-minute cache of the
    upstream calendar. An event with no published time (time None, stamped 00:00) is taken
    as known only from the next day."""
    no_time = frame['time'].isna().to_numpy() if 'time' in frame.columns else np.zeros(len(stamps), bool)
    return (stamps + _API_CACHE).where(~no_time, _next_day_start(stamps))


def _alpha():
    return {'tz': 'UTC', 'period': 'infer', 'available': 'after_period', 'calendar': 'bars',
            'fresh': 'raise',
            'basis': "api enterprise/crypto/routes.py passes only_finalized_data=True and "
                     "crypto/basic.py resamples label-left: a bucket's row exists only once its "
                     "last base bar is collected, so it is final at the bucket's close. Arrival lag "
                     "after that is unconfirmed (local cache files: present 5–57 min after close, "
                     "upper bounds only); the live gate waits for the row."}


def _tw_daily(available, basis, fresh='raise'):
    return {'tz': 'Asia/Taipei', 'period': pd.Timedelta(days=1), 'available': available,
            'calendar': 'tw_trading_days', 'fresh': fresh, 'basis': basis}


FEED_TIMING = {
    **{name: _alpha() for name in (
        'holder_concentration', 'funding_rate', 'taker_intensity', 'whale_hunter',
        'unusual_movement', 'squeeze_momentum', 'liquidation', 'market_direction',
        'capital_shortage', 'market_sentiment', 'top_trader_exposure')},
    'twstock_price': _tw_daily(
        _same_day_at(17, 35), f"TWSE 每日收盤行情 is produced 14:00 / 15:30 / 17:30 ({_TWSE_ESHOP}"
        "cfec9a1470e448ec91bfde006db361e8); the STOCK_DAY page, TPEx tradingStock and FinMind all "
        "showed the day's bar at 15:33 (2026-09-24), but whether the 14:00 version is already "
        "final is unconfirmed (盤後定價 trades 14:00–14:30), so the third version + 5 min is kept. "
        "The openapi.twse.com.tw / TPEx OpenAPI mirrors lag the sites (still the previous day at "
        "15:51) and are not a time basis"),
    'twstock_institutional': _tw_daily(
        _same_day_at(20, 5), f"TWSE 三大法人買賣超 final (incl. 鉅額) 20:00 ({_TWSE_ESHOP}"
        f"c4c87ac184e44896a05fcab5a9d544ec); FinMind 20:00 ({_FINMIND_CHIP}); + api cache 5 min"),
    'twstock_per': _tw_daily(
        _same_day_at(18, 5), f"TWSE 個股日本益比 18:00 ({_TWSE_ESHOP}8a82e9e697fc5f620198abeec9830097); "
        f"FinMind TaiwanStockPER 18:00 ({_FINMIND_TECH}); + api cache 5 min. TPEx publishes later — "
        "an OTC stock's row can land after this, which the live gate waits for"),
    'twstock_foreign_shareholding': _tw_daily(
        _next_day_at(8), f"TWSE 外資投資持股統計 final 21:30 ({_TWSE_ESHOP}fc2ca33908244644b066e0f12cb8efe5), "
        f"FinMind 21:00 ({_FINMIND_CHIP}), but the api serves it from the UTC-day cache "
        "(tw/twstock/services.py _get_fundamental) → next day 08:00"),
    'twstock_broker': _tw_daily(
        _next_day_start, f"TWSE 買賣日報表 16:00 ({_TWSE_ESHOP}c862b8472d7d46ccafbecca13c0336b0), FinMind "
        f"21:00 ({_FINMIND_CHIP}); Blave's store is written only by apijob@tw.twstock.broker_daily_update "
        "(21:30, retry 23:30 Taipei; one run observed: 2026-09-23 wrote the day at 21:31) → next "
        "day 00:00 covers the retry"),
    'twstock_broker_sparse': _tw_daily(_next_day_start, "as twstock_broker; one broker has no row "
                                       "on a day it did not trade, so freshness cannot be checked",
                                       fresh=None),
    'twmarket_institutional': _tw_daily(
        _same_day_at(19, 45), f"TWSE 三大法人買賣金額統計表 14:50 without, 約19:40 with 綜合帳戶/鉅額 "
        f"({_TWSE_ESHOP}d31c1b9570ae47058ec83a0bb1ffa419); FinMind 15:00 ({_FINMIND_CHIP}); + api "
        "cache 5 min. Assumes the stored history is the 19:40 version (unconfirmed) — if it is the "
        "14:50 one this is late, never early"),
    'twmarket_margin': _tw_daily(
        _same_day_at(21, 5), f"TWSE 融資融券餘額 約21:00 ({_TWSE_ESHOP}388dd3a09824427d8c01a9d2b21e820b); "
        f"FinMind 21:00 ({_FINMIND_CHIP}); + api cache 5 min"),
    'twmarket_turnover': _tw_daily(
        _next_day_start, "TWSE FMTQIK, fetched on request (+ api cache 5 min). TWSE publishes no time "
        f"for FMTQIK itself (its 每日收盤行情 product runs 14:00 / 15:30 / 17:30, {_TWSE_ESHOP}"
        "cfec9a1470e448ec91bfde006db361e8) — unconfirmed, next day 00:00 kept"),
    'twfutures_institutional': _tw_daily(
        _same_day_at(18, 5), f"FinMind TaiwanFuturesInstitutionalInvestors 18:00 ({_FINMIND_DERIV}); "
        "TAIFEX itself ~15:00 (api tw/twfutures/services.py _DAILY_PUBLISH_HOUR_TWN); + api cache 5 min"),
    'twfutures_pcr': _tw_daily(
        _next_day_start, "TAIFEX pcRatio page, fetched on request (+ api cache 5 min); TAIFEX publishes "
        "no time for it — unconfirmed, next day 00:00 kept"),
    'twstock_shareholding': {'tz': 'Asia/Taipei', 'period': pd.Timedelta(days=7),
                             'available': _weekly_shareholding_available, 'calendar': None,
                             'fresh': 'warn', 'basis': "TDCC weekly 集保戶股權分散表 (data = the week's "
                             "last business day, https://www.tdcc.com.tw/portal/zh/smWeb/qryStock) via "
                             "FinMind TaiwanStockHoldingSharesPer; neither publishes a time — "
                             "unconfirmed, data date + 3 days 08:00 kept"},
    'twstock_monthly_revenue': {'tz': 'Asia/Taipei', 'period': 'month',
                                'available': _revenue_available, 'calendar': None, 'fresh': 'warn',
                                'basis': f"證券交易法 §36 deadline the 10th; FinMind weekdays 18:00 "
                                         f"({_FINMIND_FUND}; stamp 2019-04-01 = March revenue); api "
                                         "UTC-day cache → next day 08:00. FSC may extend a holiday "
                                         f"month ({_FSC_FIN_RULES} §4-1)"},
    'twstock_monthly_revenue_insurance': {
        'tz': 'Asia/Taipei', 'period': 'month', 'available': _revenue_available_insurance,
        'calendar': None, 'fresh': 'warn',
        'basis': f"保險業: the 15th from FY2026 ({_FSC_FIN_RULES} §3(5)), else as twstock_monthly_revenue"},
    'twstock_financials': {'tz': 'Asia/Taipei', 'period': 'quarter',
                           'available': _quarterly_report_available, 'calendar': None,
                           'fresh': 'warn', 'basis': "證券交易法 §36 deadlines (5/15, 8/14, 11/14, 3/31); "
                           "api UTC-day cache → the next day 08:00. FinMind's own ingest time is "
                           "undocumented (待確認) — the live warning surfaces a late one"},
    'twstock_financials_finance': {
        'tz': 'Asia/Taipei', 'period': 'quarter', 'available': _quarterly_report_available_finance,
        'calendar': None, 'fresh': 'warn',
        'basis': f"金融控股·銀行·證券·期貨·保險 listed issuers: Q2 within two months (8/31, "
                 f"{_FSC_FIN_RULES} §3(3)); Q1/Q3/annual as twstock_financials"},
    'twfutures_bid_ask_vol': {'tz': 'UTC', 'period': 'infer', 'available': 'after_period',
                              'delay': pd.Timedelta(seconds=30), 'calendar': 'bars', 'fresh': 'raise',
                              'basis': "api snapshot/run_sinopac_backfill.py _aggregate_ticks floors "
                                       "ticks to the minute (row = minute open); today's minutes are "
                                       "fetched on request and cached 30 s (tw/sinopac/services.py), "
                                       "so a row is final 30 s after its minute closes"},
    'fear_greed': {'tz': 'UTC', 'period': pd.Timedelta(days=1), 'available': _same_day_at(1),
                   'calendar': 'days', 'fresh': 'raise',
                   'basis': "alternative.me publishes one row a day at 00:00 UTC: on 2026-09-24 "
                            "08:16 UTC the API's time_until_update was 56,644 s = exactly 00:00 "
                            "UTC, and the row stamped that day was the one it had just published. "
                            "How long the API takes to actually serve the new row after 00:00 is "
                            "unconfirmed — +1 h kept; the live gate waits for it"},
    'economic_calendar': {'tz': 'Asia/Taipei', 'period': None, 'available': 'econ',
                          'calendar': 'self', 'fresh': 'raise', 'columns': ['real'],
                          'basis': "`real` at the release time + api cache 5 min (market/anue/"
                                   "services.py _CACHE_TTL); how long the upstream (鉅亨) takes to "
                                   "fill `real` is unconfirmed — the live gate waits for it"},
}
# fetcher-name aliases → the timing entry they share
for _alias, _key in (('twstock_price_adj', 'twstock_price'),
                     ('twstock_price_batch', 'twstock_price'),
                     ('twstock_price_adj_batch', 'twstock_price'),
                     ('twstock_institutional_batch', 'twstock_institutional'),
                     ('twstock_per_batch', 'twstock_per'),
                     ('twstock_foreign_shareholding_batch', 'twstock_foreign_shareholding'),
                     ('twstock_all_broker_net', 'twstock_broker'),
                     ('twstock_branch_daily_net', 'twstock_broker'),
                     ('twstock_trader_flows', 'twstock_broker'),
                     ('twstock_broker_net', 'twstock_broker_sparse'),
                     ('twstock_shareholding_batch', 'twstock_shareholding'),
                     ('twstock_monthly_revenue_batch', 'twstock_monthly_revenue'),
                     ('twstock_balance_sheet', 'twstock_financials'),
                     ('twstock_financials_batch', 'twstock_financials'),
                     ('twstock_balance_sheet_batch', 'twstock_financials')):
    FEED_TIMING[_alias] = FEED_TIMING[_key]


class FeedNotPublished(RuntimeError):
    """Live: the feed row this bar needs was due by `due_at` and is not in the data."""

    def __init__(self, source, need, due_at, last_bar):
        self.source, self.need, self.due_at, self.last_bar = source, need, due_at, last_bar
        super().__init__(
            f"❌ {source}: the row for {need} was due by {due_at} and is not in the data yet — "
            f"refusing to compute the signal for bar {last_bar} on the previous value. "
            f"wait_for_bar keeps retrying; if it never lands, the source is late.")


_live_feeds = 0   # >0 while a LIVE tick's fetch_data runs (runner / wait_for_bar)


class live_feeds:
    """Scope marking a live tick: align_feed raises FeedNotPublished instead of trimming."""
    def __enter__(self):
        global _live_feeds
        _live_feeds += 1
        return self

    def __exit__(self, *exc):
        global _live_feeds
        _live_feeds -= 1
        return False


def _utc_ns(idx):
    return idx.tz_convert('UTC').as_unit('ns').asi8


def _latest_by(avail_ns, stamp_ns, at_ns):
    """For each `at`: position (into the inputs) of the row with the greatest stamp among rows
    with avail <= at, or -1."""
    order = np.argsort(avail_ns, kind='stable')
    a, s = avail_ns[order], stamp_ns[order]
    run_max = np.maximum.accumulate(s) if len(s) else s
    best = np.maximum.accumulate(np.where(s == run_max, np.arange(len(s)), 0)) if len(s) else s
    k = np.searchsorted(a, at_ns, side='right') - 1
    out = np.full(len(at_ns), -1)
    has = k >= 0
    out[has] = order[best[k[has]]]
    return out


def _feed_times(frame, source, default_period=None):
    """→ (stamps, available_at, period) for a FEED_TIMING feed frame, both indexes tz-aware
    (naive stamps are read in the entry's tz). Raises ValueError on a frame without a time
    axis (long formats: pivot / unstack first)."""
    spec = FEED_TIMING[source]
    if len(frame) == 0:
        raise ValueError(f"{source}: the feed has no rows at all — the fetch returned nothing, so "
                         f"there is no way to tell which bars it covers")
    if spec['available'] == 'econ':
        stamps = pd.DatetimeIndex(frame['datetime'])
    else:
        stamps = frame.index
    if not isinstance(stamps, pd.DatetimeIndex):
        raise ValueError(f"{source}: needs a DatetimeIndex (long formats: pivot / unstack first)")
    if stamps.tz is None:
        stamps = stamps.tz_localize(spec['tz'])
    period = spec['period']
    if period == 'infer':
        d = pd.Series(stamps.sort_values()).diff().dropna()
        d = d[d > pd.Timedelta(0)]
        period = d.mode().iloc[0] if len(d) else default_period
        if period is None:
            raise ValueError(f"{source}: cannot infer the row period from a single row")
    if spec['available'] == 'after_period':
        avail = _after_own_period(stamps, period) + spec.get('delay', pd.Timedelta(0))
    elif spec['available'] == 'econ':
        avail = _econ_available(stamps, frame)
    else:
        avail = spec['available'](stamps)
    return stamps, avail, period


def feed_available_at(frame, source):
    """Per-row availability time (tz-aware) of a FEED_TIMING feed frame — what align_feed
    attaches by, and what the runner's look-ahead replay truncates a recorded feed by."""
    return _feed_times(frame.to_frame() if isinstance(frame, pd.Series) else frame, source)[1]


def align_feed(bars, feed, source, interval, bar_tz=None, columns=None):
    """Attach `feed` to `bars` by publication time. → DataFrame on the bars' index (trailing
    not-yet-published bars trimmed in a backtest) with the feed's value columns.

    bars:     DataFrame / Series / DatetimeIndex of the strategy's bars (label = bar open).
    feed:     the fetcher's frame, wide (one row per stamp; pivot long formats first). The
              economic calendar goes in as fetch_economic_calendar returned it, filtered to
              ONE indicator (`real` is the value).
    source:   FEED_TIMING key = the fetcher name without `fetch_` ('twstock_institutional').
    interval: the bars' interval ('1h', '60m', '1d', …); a bar may use a row only if the row
              was available by label + interval.
    bar_tz:   required when the bars' index is naive: 'UTC' for fetch_kline / intraday
              fetch_twfutures_ohlcv, 'Asia/Taipei' for fetch_twstock_price* daily bars.

    A bar whose due row is missing while an older one exists (a late source, a hole) gets
    NaN, not the older value. Live (live_feeds()) the LAST bar being in that state raises
    FeedNotPublished. Monthly / quarterly / weekly filings only warn: a late or delinquent
    filer must not halt a strategy, and the previous filing is what was actually known.
    """
    if source not in FEED_TIMING:
        raise ValueError(f"align_feed: unknown source {source!r} — one of {sorted(FEED_TIMING)}")
    spec = FEED_TIMING[source]
    index = bars if isinstance(bars, pd.DatetimeIndex) else bars.index
    if index.tz is None:
        if not bar_tz:
            raise ValueError("align_feed: the bars' index is naive — pass bar_tz ('UTC' for "
                             "fetch_kline and intraday fetch_twfutures_ohlcv, 'Asia/Taipei' for "
                             "fetch_twstock_price* daily bars)")
        index = index.tz_localize(bar_tz)
    bar_close = index + pd.Timedelta(interval)

    frame = feed.to_frame() if isinstance(feed, pd.Series) else feed
    stamps, avail, period = _feed_times(frame, source, default_period=pd.Timedelta(interval))
    if stamps.has_duplicates:
        raise ValueError(f"align_feed: {source} feed has repeated stamps — pivot it to one row per stamp first")
    cols = columns or spec.get('columns') or list(frame.columns)
    values = frame[cols].reset_index(drop=True)

    present = values.notna().any(axis=1).to_numpy()
    close_ns = _utc_ns(bar_close)
    s_ns, a_ns = _utc_ns(stamps), _utc_ns(avail)
    live_rows = np.flatnonzero(present)
    row = _latest_by(a_ns[present], s_ns[present], close_ns)
    row = np.where(row >= 0, live_rows[np.maximum(row, 0)] if len(live_rows) else -1, -1)
    out_index = bars if isinstance(bars, pd.DatetimeIndex) else bars.index
    if len(values):
        out = values.iloc[np.maximum(row, 0)].set_axis(out_index)
    else:
        out = pd.DataFrame(np.nan, index=out_index, columns=cols)
    out.loc[row < 0] = np.nan

    stale = np.zeros(len(index), dtype=bool)
    need_ns = np.full(len(index), -1, dtype=np.int64)
    if spec['fresh'] == 'raise' and spec['calendar']:
        local = index.tz_convert(stamps.tz)
        if spec['calendar'] == 'self':
            cand = stamps
        elif spec['calendar'] == 'tw_trading_days':
            # the dates a TW daily feed can have a row for: weekdays with a DAY-session bar.
            # TXF's night session labels Friday-night bars Saturday 00:00–05:00 (and the night
            # before a holiday, the holiday) — those dates never get a row.
            if pd.Timedelta(interval) < pd.Timedelta(days=1):
                local = local[(local.hour >= 8) & (local.hour < 14)]
            days = pd.DatetimeIndex(local.floor('D').unique())
            cand = days[days.dayofweek < 5]
        else:
            cand = pd.DatetimeIndex(local.floor(period).unique())
        if spec['available'] == 'after_period':
            c_avail = _after_own_period(cand, period) + spec.get('delay', pd.Timedelta(0))
        elif spec['available'] == 'econ':
            c_avail = avail
        else:
            c_avail = spec['available'](cand)
        c_s = _utc_ns(cand)
        req = _latest_by(_utc_ns(c_avail), c_s, close_ns)
        need_ns = np.where(req >= 0, c_s[np.maximum(req, 0)], -1)
        used_ns = np.where(row >= 0, s_ns[np.maximum(row, 0)], -1)
        stale = (need_ns >= 0) & (used_ns < need_ns)
        out.loc[stale] = np.nan
        if len(stale) and stale[-1]:
            k = int(np.flatnonzero(c_s == need_ns[-1])[0])
            need, due = cand[k], c_avail[k]
            if _live_feeds:
                raise FeedNotPublished(source, need, due, index[-1])
            tail = len(stale) - (np.flatnonzero(~stale)[-1] + 1 if (~stale).any() else 0)
            print(f"  ⚠️  {source}: the last {tail} bar(s) are cut — the row for {need} was due by "
                  f"{due} and is not in the data yet (live refuses these bars until it lands)")
            out = out.iloc[:len(out) - tail]
    elif spec['fresh'] == 'warn' and len(stamps) and present.any():
        last = stamps[present].max()
        nxt = (last + pd.DateOffset(months=1) if period == 'month' else
               last + pd.DateOffset(months=3) if period == 'quarter' else last + period)
        nxt_idx = pd.DatetimeIndex([nxt])
        due = spec['available'](nxt_idx)[0]
        if bar_close[-1] >= due:
            msg = (f"{source}: the next filing after {last.date()} was due by {due} and is not in "
                   f"the data — using the {last.date()} one (late filer, or a cached copy)")
            logging.warning(msg)
            print(f"  ⚠️  {msg}")
    return out


# kind → (fetcher name, FEED_TIMING source, needs an id, default column prefix)
TW_FLOWS = {
    'futures_institutional': ('fetch_twfutures_institutional', 'twfutures_institutional', True, 'fut_'),
    'stock_institutional':   ('fetch_twstock_institutional',   'twstock_institutional',   True, 'inst_'),
    'market_institutional':  ('fetch_twmarket_institutional',  'twmarket_institutional',  False, 'mkt_'),
    'margin':                ('fetch_twmarket_margin',         'twmarket_margin',         False, ''),
    'pcr':                   ('fetch_twfutures_pcr',           'twfutures_pcr',           False, ''),
    'per':                   ('fetch_twstock_per',             'twstock_per',             True, ''),
    'broker_total':          ('fetch_twstock_all_broker_net',  'twstock_all_broker_net',  True, 'broker_'),
    'broker_branch':         ('fetch_twstock_branch_daily_net', 'twstock_branch_daily_net', True, 'br_'),
}


def join_tw_flow(df, kind, interval, start, end, headers, id=None, prefix=None):
    """The common case in one call: fetch a Taiwan daily flow feed and attach it to `df`'s
    bars by publication time (align_feed). → `df` cut to the bars whose flow row is
    published, with the flow columns joined (named `prefix + column`).

    kind   id                    columns (before the prefix)
    futures_institutional  'TX' / 'MTX' / 'TMF' (TXF/MXF accepted)   {foreign|investment_trust|dealer}_{net_oi|long_oi|short_oi|net_deal}
    stock_institutional    stock id        foreign_net + the raw buy/sell columns
    market_institutional   —               foreign, investment_trust, dealer, total (元)
    margin                 —               margin_balance(_prev), margin_balance_value, short_balance(_prev)
    pcr                    —               pcr
    per                    stock id        dividend_yield, PER, PBR
    broker_total           stock id        net (all branches summed)
    broker_branch          stock id        one column per branch id

    Bars from any TW price fetcher work as they come: a naive intraday index is UTC
    (fetch_twfutures_ohlcv / fetch_twstock_ohlcv minute bars), a naive daily index is the
    Taipei date (fetch_twstock_price*), an aware index is used as is. Not for crypto bars:
    fetch_kline '1d' is naive UTC and would be read as Taipei dates — use align_feed. A row missing on a
    day it should exist is NaN on the bars it covers — never the previous day's value — and
    live, the tick refuses (FeedNotPublished) until it lands."""
    if kind not in TW_FLOWS:
        raise ValueError(f"join_tw_flow: kind must be one of {sorted(TW_FLOWS)}")
    fetcher, source, needs_id, default_prefix = TW_FLOWS[kind]
    if needs_id and not id:
        raise ValueError(f"join_tw_flow: kind {kind!r} needs id= (see the docstring table)")
    fetch = globals()[fetcher]              # looked up per call so the backtest recorder sees it
    args = (id, start, end, headers) if needs_id else (start, end, headers)
    flow = fetch(*args)
    if isinstance(flow, pd.Series):
        flow = flow.to_frame(flow.name or 'net')
    bar_tz = None
    if df.index.tz is None:
        bar_tz = 'UTC' if pd.Timedelta(interval) < pd.Timedelta(days=1) else 'Asia/Taipei'
    aligned = align_feed(df, flow, source, interval, bar_tz=bar_tz)
    pre = default_prefix if prefix is None else prefix
    return df.loc[aligned.index].join(aligned.add_prefix(pre))
