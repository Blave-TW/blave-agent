import hashlib, json, logging, math, os, shutil, time
from pathlib import Path
import numpy as np
import pandas as pd
from dotenv import dotenv_values
from lib.execute import update_state, load_state, save_state
from lib.analysis import plot_pnl, plot_pnl_portfolio, precise_pnl, compute_stats

_REPO_ROOT = Path(__file__).parent.parent

# Per-event trade log cap for a single backtest — mirrors api/openclaw/agent_strategies.py's
# TRADES_MAX_COUNT. Bounding it here too (source) rather than only on the api side means a
# live-mode strategy that rewrites its full trades history every scheduler tick can't grow
# past what the api will accept anyway, and it stops one dense strategy's (pre-truncation)
# trades array from blowing the api's overall report body-size check for everyone else.
TRADES_MAX_COUNT = 10000

# Caps for the PLOT_SERIES → stats.json `panes` output — mirrored server-side in
# api/openclaw/agent_strategies.py. Bounded at the source for the same reason as
# TRADES_MAX_COUNT above: live mode rewrites stats.json every tick, so an unbounded
# declaration would inflate every report, not just one backtest.
PANES_MAX_SERIES = 4
PANES_MAX_POINTS = 20000
PANES_NAME_MAX   = 64
PANES_PANE_MAX   = 32  # pane group id length cap
PANES_MAX_LEVELS = 4   # horizontal threshold lines per series
PANES_LEVEL_LABEL_MAX = 16

# Cap for the stats.json `candles` output (Type A backtest OHLCV) — mirrored server-side
# in api/openclaw/agent_strategies.py. Same per-series budget as PANES_MAX_POINTS: daily
# bars = full history, 5min ≈ ten weeks — coordinated with the trades 10,000 tail window.
CANDLES_MAX_COUNT = 20000

# Full-history chart export (strategies/<name>/chart/, Type A backtest only) — the
# stats.json tails above are the first-paint payload; this is the complete version the
# workspace pulls chunk-by-chunk (api/openclaw/agent_chart_data.py). Caps mirrored there.
CHART_CHUNK_BARS = 20000
CHART_MAX_CHUNKS = 50
CHART_LIVE_REFRESH_MIN_AGE = 86400  # live-tick rebuild throttle: at most once a day per strategy



# MCPT (Monte Carlo Permutation Test) fields in stats.json — written automatically by every
# Type A backtest (see _auto_mcpt) and by lib.validation.write_mcpt_to_stats after a manual
# run. Mirrors lib.validation.MCPT_*_KEY.
MCPT_KEYS = ('MCPT p-value', 'MCPT Permutations', 'MCPT Distribution')
# Default permutation count for the automatic backtest MCPT; a strategy overrides it with
# `MCPT_N = <int>` or disables the test with `MCPT = False`. Measured 2026-09 on lib.validation
# .mcpt (pure numpy, one rolling std + n permutations of a 1D array), Apple M5, 40k bars 1h:
# n=500 0.2 s / 1000 0.3 s / 2000 0.7 s; 200k bars (5min, 2 years) n=2000 3.5 s. A 2-vCPU
# fleet VM is roughly 3–6× slower, so 2000 stays well inside the 30 s budget for a backtest
# — and matches the n the manual flow has always used, so p-values stay comparable.
MCPT_N_DEFAULT = 2000
# Runtime budget for the automatic MCPT, in bars × permutations: 200k bars × n=2000 (the
# 5min / 2-year case above, 3.5 s on M5, ≈ 10–20 s on the fleet). Fleet measurement: 1min
# bars over two years (1.05M bars) at n=2000 took 55–110 s — over the 30 s budget — so n is
# scaled down to budget // bars (never below MCPT_N_MIN, never above MCPT_N_MAX whatever
# MCPT_N says) and a warning names the original and effective n.
MCPT_BUDGET = 4e8
# MCPT_N_MIN must stay >= the library listing gate in api/openclaw/marketplace.py — whose
# own MCPT_N_MIN is the opposite thing (the minimum n a listing is ACCEPTED with), so the
# two move together despite living in different repos. With a lower floor here, every
# backtest past MCPT_BUDGET / gate bars (400k at 4e8 / 1000) silently gets an n that the
# MCPT itself is fine with but the listing rejects, and nothing in the UI says why. Cost of
# the floor is backtest time on long 1-min histories: 1.05M bars at n=1000 measured 7.6 s on
# M5 → ≈ 23–46 s on a 3–6× slower fleet VM (the n=2000 fleet figure above independently
# implies 28–55 s) — at or just over the 30 s budget for a 1-min 2-year strategy, and
# unnoticeable for anything shorter.
MCPT_N_MIN  = 1000
MCPT_N_MAX  = 20000
# Fixed seed for the automatic MCPT's permutations: the same backtest gives the same
# p-value on every run (a live tick carries it over, a re-run must not silently move it).
# Passed as a private RNG to mcpt() so the global numpy seed is untouched.
MCPT_SEED = 42
# Flat epoch-seconds key stamping when the stats were produced by an explicit backtest.
# The web compares scan.json's generated_at against it: a scan older than the last
# backtest means the parameters may have moved, so scan.current is shown as unknown.
GENERATED_AT_KEY = 'Generated At'


def _carry_over(out_dir, mode):
    """Keys to carry from the existing stats.json into the one about to be rewritten.

    A live / cron tick (mode != 'backtest') rewrites stats.json every bar with the SAME
    code and parameters, so the MCPT fields computed on them are still valid, and the
    last explicit backtest's 'Generated At' still marks when the parameters last changed
    — both are read off the existing file and kept. An explicit backtest returns {} so
    the old MCPT keys are DROPPED (parameters may have changed) — the backtest then runs
    MCPT afresh itself (_auto_mcpt) and 'Generated At' is stamped fresh by the caller. A
    missing / unreadable / keyless old file is simply "nothing to carry" — never fatal, a
    tick must not die on it.
    """
    if mode == 'backtest':
        return {}
    try:
        with open(Path(out_dir) / 'stats.json', encoding='utf-8') as f:
            old = json.load(f)
        return {k: old[k] for k in MCPT_KEYS + (GENERATED_AT_KEY,) if k in old}
    except Exception as e:  # absent on first tick, or a half-written file — carry nothing
        logging.debug("stats.json carry-over skipped: %s", e)
        return {}


def _write_json_atomic(path, obj, indent=2):
    """JSON via tmp + os.replace (same pattern as lib.param_scan.write_scan): these files
    are rewritten while the reporter reads them — stats.json every bar in live mode, the
    versions index while a backtest mints into it — and a reader landing mid-write would
    otherwise see a truncated file and drop keys for good (MCPT / Generated At carry-over,
    or the whole version list)."""
    path = Path(path)
    tmp  = path.with_name(path.name + '.tmp')
    try:
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(obj, f, indent=indent)
        os.replace(tmp, path)
    except Exception:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def _write_stats(out_dir, stats):
    return _write_json_atomic(Path(out_dir) / 'stats.json', stats)


def _mcpt_n_effective(n_perm, bars):
    """Permutation count actually run: MCPT_N (or the default) scaled down to fit
    MCPT_BUDGET bars × permutations, capped at MCPT_N_MAX. MCPT_N_MIN floors the budget
    term only, so a result below MCPT_N_MIN can only have come from MCPT_N itself."""
    n_eff = min(int(n_perm), MCPT_N_MAX, max(MCPT_N_MIN, int(MCPT_BUDGET // max(int(bars), 1))))
    if n_eff < n_perm:
        # No action asked for: the floor keeps n_eff listable, so the only thing the reader
        # needs is why their p-value was computed on fewer permutations than they asked for.
        logging.warning("MCPT permutations reduced %d → %d: %d bars × n must stay under "
                        "%.0e to keep the backtest inside its runtime budget. The p-value "
                        "is still valid and n never drops below %d, the library listing "
                        "minimum — nothing to fix.",
                        n_perm, n_eff, bars, MCPT_BUDGET, MCPT_N_MIN)
    if n_eff < MCPT_N_MIN:
        # Unreachable from the budget term (that one is floored at MCPT_N_MIN), so this is
        # MCPT_N deliberately set below the listing gate. Kept as asked — raising an author's
        # own number silently would be worse than an n that cannot be listed — but said out
        # loud now rather than at submission time, which is the only place it used to surface.
        # warning, not info: info survives only while run()'s basicConfig actually took effect
        # (it is a no-op once root carries any handler, and root defaults to WARNING), and of
        # the two lines here this is the one with something to act on.
        logging.warning("MCPT n=%d is below %d, the minimum the strategy library accepts for "
                        "a listing. Kept as set: MCPT_N is the strategy's own choice and the "
                        "p-value is valid to read on its own. To make it listable, set "
                        "MCPT_N to %d or more and re-run — and if this strategy is not for "
                        "the library, leaving it is fine.",
                        n_eff, MCPT_N_MIN, MCPT_N_MIN)
    return n_eff


def _auto_mcpt(config, close_v, pos, index, fee, n_trades):
    """Type A backtest: run lib.validation.mcpt on the backtest's own close / position and
    return the three MCPT stats.json fields (see lib.validation.mcpt_stats_fields), or {}.

    `MCPT = False` in the strategy skips it; `MCPT_N` overrides the permutation count
    (default MCPT_N_DEFAULT, scaled to the runtime budget — see _mcpt_n_effective).
    periods_per_year comes from the data's real date span (same figure compute_stats
    annualizes with), fee from FEE, vol_window = one month of bars (ppy / 12, at least 20:
    1h crypto → 730 ≈ the lib default 720, daily → 21); max_lev / target_vol stay at the
    lib defaults. Permutations use a private RNG seeded with MCPT_SEED (reproducible,
    global seed untouched). Never raises: a strategy that never traded, too-short data, a
    stale lib/validation.py or any other failure logs a warning and the backtest ships
    every other stat as before — MCPT is an extra, not a gate. A sound p-value whose
    histogram came out unusable (edges collapsed) is written without the Distribution.

    Type C (portfolio) does NOT get an automatic MCPT: mcpt() permutes ONE forward-return
    series against ONE position series, and a portfolio has k of each. Collapsing the
    portfolio into a single return series and permuting that would be a bootstrap of the
    strategy's own realized returns — exactly the substitute AGENTS.md forbids, because it
    answers a different question. Until mcpt() grows a multi-asset variant, Type C stays
    manual/unavailable rather than faked.
    """
    if config.get('MCPT', True) is False:
        logging.info("MCPT skipped: strategy sets MCPT = False")
        return {}
    if n_trades == 0:
        logging.warning("MCPT skipped: 0 trades — no position to test")
        return {}
    try:
        from lib.validation import mcpt, mcpt_stats_fields, MCPT_P_KEY, MCPT_N_KEY
        from lib.analysis import periods_per_year
    except ImportError as e:  # stale lib on this workspace — fail open, keep the backtest
        logging.warning("MCPT skipped: lib is stale (%s)", e)
        return {}
    try:
        n_perm = int(config.get('MCPT_N', MCPT_N_DEFAULT))
        if n_perm <= 0:
            raise ValueError(f"MCPT_N must be a positive int, got {n_perm}")
        n_eff = _mcpt_n_effective(n_perm, len(close_v))
        ppy = periods_per_year(index, len(close_v))
        vol_window = max(20, int(round(ppy / 12)))
        actual, p_value, dist = mcpt(close_v, pos, n=n_eff, fee=fee, periods_per_year=ppy,
                                     vol_window=vol_window, rng=np.random.default_rng(MCPT_SEED))
    except Exception as e:
        logging.warning("MCPT failed (backtest stats still written without it): %s", e)
        return {}
    try:
        return mcpt_stats_fields(actual, p_value, dist)
    except Exception as e:
        # The histogram is a picture; the p-value is the result. When only the picture is
        # unusable (edges collapsed after rounding) keep p + n, same shape as a manual
        # write_mcpt_to_stats without dist. A non-finite actual / p / dist means the test
        # itself is unusable → no key at all (the api ingests with allow_nan=False).
        dist_arr = np.asarray(dist, dtype=float).ravel()
        try:
            p_ok = np.isfinite(float(actual)) and np.isfinite(float(p_value)) and 0.0 <= float(p_value) <= 1.0
        except (TypeError, ValueError):
            p_ok = False
        if p_ok and dist_arr.size and np.isfinite(dist_arr).all():
            logging.warning("MCPT Distribution dropped (%s); p-value still written", e)
            return {MCPT_P_KEY: round(float(p_value), 4), MCPT_N_KEY: int(dist_arr.size)}
        logging.warning("MCPT failed (backtest stats still written without it): %s", e)
        return {}


def _build_levels(raw):
    """opts["levels"] → stats.json panes[].levels (horizontal threshold lines).

    Accepts {label: value} or [value, ...]. Non-finite / non-numeric values are
    skipped (not the whole declaration), labels are truncated, first 4 kept. A
    sentinel "disabled" threshold (e.g. -1e9) is the author's to leave out — the
    runner does not guess which values are off-scale.
    """
    if isinstance(raw, dict):
        items = [(k, v) for k, v in raw.items()]
    elif isinstance(raw, (list, tuple)):
        items = [(None, v) for v in raw]
    else:
        return []
    levels = []
    for label, v in items:
        if len(levels) >= PANES_MAX_LEVELS:
            break
        if isinstance(v, bool):
            continue
        try:
            fv = float(v)
        except (TypeError, ValueError):
            continue
        if not math.isfinite(fv):
            continue
        lvl = {'value': round(fv, 6)}
        if isinstance(label, str) and label.strip():
            lvl['label'] = label[:PANES_LEVEL_LABEL_MAX]
        levels.append(lvl)
    return levels


def _build_panes(plot_series, df, max_points=PANES_MAX_POINTS):
    """PLOT_SERIES declaration → stats.json `panes` (workspace indicator overlay).

    plot_series is a dict of display name → spec, where spec is one of:
      "col"                              — column of the backtest df (sub-pane)
      pd.Series                          — reindexed to the df (sub-pane)
      ("col" | pd.Series, {"overlay": True})  — drawn on the price chart instead
      ("col" | pd.Series, {"pane": "<group>"}) — series sharing a group id render in
                                          one sub-pane (e.g. MACD + its signal line)
      ("col" | pd.Series, {"levels": {...} | [...]}) — horizontal threshold lines
                                          in that series' pane (see _build_levels)

    Timestamps use the same basis as trades[].ts (df.index[t].timestamp()) so the
    frontend aligns both against one axis. Non-finite points are skipped rather
    than zero-filled — a gap is honest, a fake 0 draws a misleading spike.
    """
    if not isinstance(plot_series, dict):
        return []
    panes = []
    for name, spec in plot_series.items():
        if len(panes) >= PANES_MAX_SERIES:
            break
        opts = {}
        if isinstance(spec, tuple) and spec:
            opts = spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}
            spec = spec[0]
        if isinstance(spec, str):
            if spec not in df.columns:
                continue
            series = df[spec]
        elif isinstance(spec, pd.Series):
            series = spec.reindex(df.index)
        else:
            continue
        values = series.to_numpy()
        # Capped: walk back from the end and stop at the cap instead of formatting years
        # of 1m bars only to keep the tail. Per-element float() because values may be object.
        if max_points:
            rows = zip(values[::-1], df.index[::-1])
        else:
            rows = zip(values, df.index)
        points = []
        for v, t in rows:
            try:
                fv = float(v)
            except (TypeError, ValueError):
                continue
            if not math.isfinite(fv):
                continue
            points.append([int(t.timestamp()), round(fv, 6)])
            if max_points and len(points) == max_points:
                break
        if not points:
            continue
        if max_points:
            points.reverse()  # tail — same convention as trades
        entry = {
            'name':    str(name)[:PANES_NAME_MAX],
            'overlay': bool(opts.get('overlay', False)),
            'points':  points,
        }
        pane = opts.get('pane')
        if isinstance(pane, str) and pane.strip() and len(pane) <= PANES_PANE_MAX:
            entry['pane'] = pane
        levels = _build_levels(opts.get('levels'))
        if levels:  # optional field — absent (not empty) when nothing is declared/valid
            entry['levels'] = levels
        panes.append(entry)
    return panes


def _build_candles(df, max_count=CANDLES_MAX_COUNT):
    """Backtest df → stats.json `candles`: [[ts, open, high, low, close, volume], ...].

    The exact bars the backtest computed on (post-warmup, post-filter slice — the same
    df trades/panes are built from), so the frontend chart draws what the stats actually
    saw instead of re-fetching a kline endpoint that can diverge (adjusted stock prices,
    stitched futures contracts, warmup slicing). Same ts basis as trades[].ts and
    panes[].points. Bars with a non-finite/non-positive OHLC value are skipped — a gap
    is honest, a fake bar isn't. Volume is null when the df has no Volume column;
    a non-finite volume on an otherwise good bar also drops the bar.
    """
    cols = ('Open', 'High', 'Low', 'Close')
    if not all(c in df.columns for c in cols):
        return []
    try:
        o, h, l, c = (df[col].to_numpy(dtype=float) for col in cols)
        vol = df['Volume'].to_numpy(dtype=float) if 'Volume' in df.columns else None
    except (TypeError, ValueError):
        return []  # non-numeric column — no candles rather than a crashed run
    if max_count:  # tail — same convention as trades/panes; select it before formatting
        good = np.isfinite(o) & (o > 0) & np.isfinite(h) & (h > 0) \
            & np.isfinite(l) & (l > 0) & np.isfinite(c) & (c > 0)
        if vol is not None:
            good &= np.isfinite(vol)
        keep = np.flatnonzero(good)[-max_count:]
        return [[int(t.timestamp()),
                 round(float(o[i]), 6), round(float(h[i]), 6),
                 round(float(l[i]), 6), round(float(c[i]), 6),
                 None if vol is None else float(vol[i])]
                for i, t in zip(keep, df.index[keep])]
    candles = []
    for i, t in enumerate(df.index):
        bar = (float(o[i]), float(h[i]), float(l[i]), float(c[i]))
        if not all(math.isfinite(x) and x > 0 for x in bar):
            continue
        if vol is None:
            v = None
        else:
            v = float(vol[i])
            if not math.isfinite(v):
                continue
        candles.append([int(t.timestamp()),
                        round(bar[0], 6), round(bar[1], 6), round(bar[2], 6), round(bar[3], 6),
                        v])
    if max_count and len(candles) > max_count:
        candles = candles[-max_count:]  # tail — same convention as trades/panes
    return candles


def _slice_ts(rows, t0, t1, key):
    """rows sorted ascending by key(row) → the contiguous sub-list with t0 <= ts <= t1."""
    lo, hi = 0, len(rows)
    while lo < hi:
        mid = (lo + hi) // 2
        if key(rows[mid]) < t0: lo = mid + 1
        else: hi = mid
    start = lo
    hi = len(rows)
    while lo < hi:
        mid = (lo + hi) // 2
        if key(rows[mid]) <= t1: lo = mid + 1
        else: hi = mid
    return rows[start:lo]


def _write_chart_dir(out_dir, df, candles, panes, trades, symbol, interval):
    """Full-history chart export → strategies/<name>/chart/{manifest.json, chunk-<id>.json}.

    Same element schemas as stats.json's candles / panes[].points / trades, but untruncated
    and split into CHART_CHUNK_BARS-bar chunks (by df.index position, so a pane point or
    trade on a bar whose candle was skipped still lands in exactly one chunk). More than
    CHART_MAX_CHUNKS → keep the newest and flag manifest.truncated. Built in chart.tmp/
    and swapped in whole (the reporter never sees a half-written set; per-chunk sha1 in
    the manifest lets it detect a swap that raced its read). Hash = the chunk content, so
    re-running an identical backtest is a no-op for the uploader.
    """
    chart_dir = out_dir / 'chart'
    if not candles:
        shutil.rmtree(chart_dir, ignore_errors=True)  # no stale chart from a previous run
        return None
    n = len(df)
    n_chunks = -(-n // CHART_CHUNK_BARS)
    first = max(0, n_chunks - CHART_MAX_CHUNKS)
    truncated = first > 0
    tmp_dir = out_dir / 'chart.tmp'
    shutil.rmtree(tmp_dir, ignore_errors=True)
    os.makedirs(tmp_dir)
    pane_pts = [p['points'] for p in panes]
    chunks, hasher = [], hashlib.sha1()
    for cid, ci in enumerate(range(first, n_chunks)):
        lo, hi = ci * CHART_CHUNK_BARS, min((ci + 1) * CHART_CHUNK_BARS, n)
        t0, t1 = int(df.index[lo].timestamp()), int(df.index[hi - 1].timestamp())
        c_rows = _slice_ts(candles, t0, t1, lambda r: r[0])
        body = {
            'candles': c_rows,
            'panes':   [{**p, 'points': _slice_ts(pts, t0, t1, lambda r: r[0])}
                        for p, pts in zip(panes, pane_pts)],
            'trades':  _slice_ts(trades, t0, t1, lambda r: r['ts']),
        }
        raw = json.dumps(body, separators=(',', ':')).encode()
        sha = hashlib.sha1(raw).hexdigest()
        hasher.update(sha.encode())
        with open(tmp_dir / f'chunk-{cid}.json', 'wb') as f:
            f.write(raw)
        chunks.append({'id': cid, 't0': t0, 't1': t1, 'bars': len(c_rows),
                       'sha1': sha, 'bytes': len(raw)})
    manifest = {
        'v': 1, 'hash': hasher.hexdigest(),
        'symbol': symbol, 'interval': interval,
        'start': df.index[first * CHART_CHUNK_BARS].strftime('%Y-%m-%d'),
        'end':   df.index[-1].strftime('%Y-%m-%d'),
        'chunk_bars': CHART_CHUNK_BARS, 'truncated': truncated, 'chunks': chunks,
    }
    with open(tmp_dir / 'manifest.json', 'w') as f:
        json.dump(manifest, f)
    _swap_chart_dir(tmp_dir, chart_dir)
    return manifest


def _swap_chart_dir(tmp_dir, chart_dir, attempts=5):
    """chart.tmp → chart, via chart → chart.old first, so the live set is never half-deleted:
    on Windows a rename fails while the reporter has a chunk open or Defender is scanning
    the fresh files, and a plain rmtree+rename would leave a gutted chart/ behind. Retries
    briefly; if it still fails the old set is put back and the error propagates."""
    old_dir = chart_dir.with_name(chart_dir.name + '.old')
    for attempt in range(attempts):
        try:
            if chart_dir.exists():
                shutil.rmtree(old_dir, ignore_errors=True)
                os.rename(chart_dir, old_dir)
            os.rename(tmp_dir, chart_dir)
            break
        except OSError:
            if attempt == attempts - 1:
                if old_dir.exists() and not chart_dir.exists():
                    try: os.rename(old_dir, chart_dir)
                    except OSError: pass
                raise
            time.sleep(0.5)
    shutil.rmtree(old_dir, ignore_errors=True)


def _chart_refresh_due(out_dir, tail_first_ts, tail_last_ts):
    """Live tick: should chart/ be rebuilt? stats.json's candle tail keeps advancing while
    chart/ stays frozen at backtest time; once the tail's first bar has moved past the last
    chunk's t1 minus half the tail window, the two would soon stop overlapping and the
    workspace would show a gap scrolling left. Rebuild then (or when no usable manifest),
    throttled by the manifest's mtime so a short-window strategy can't rebuild every tick.
    """
    path = out_dir / 'chart' / 'manifest.json'
    try:
        with open(path) as f:
            last_t1 = json.load(f)['chunks'][-1]['t1']
        mtime = os.path.getmtime(path)
    except (OSError, ValueError, KeyError, IndexError, TypeError):
        return True
    if tail_first_ts <= last_t1 - (tail_last_ts - tail_first_ts) / 2:
        return False
    return time.time() - mtime >= CHART_LIVE_REFRESH_MIN_AGE


def _version_fields(stats):
    """The six numbers plus the backtest window a version carries, read straight off the
    stats.json just written — canon §4 is explicit that nothing here is recomputed. A key
    the branch never writes (MCPT on Type C) stays null, never 0: the UI shows
    "—" for missing, and a 0 Sortino is a claim about the strategy."""
    return {
        'ret':     stats.get('Total Return [%]'),
        'sharpe':  stats.get('Sharpe Ratio'),
        'sortino': stats.get('Sortino Ratio'),
        'mdd':     stats.get('Max Drawdown [%]'),
        'trades':  stats.get('Trades'),
        'mcpt_p':  stats.get(MCPT_KEYS[0]),
        'start':   stats.get('start'),
        'end':     stats.get('end'),
    }


def _mint_version(config, stats, mode):
    """Freeze this backtest as strategies/<name>/versions/v<N>.json and refresh index.json
    (.claude/docs/strategy-versions.md). Returns the version number, or None.

    BACKTEST ONLY. run() is also the live/cron tick, which rewrites stats.json every bar
    with the same code — minting there would give a deployed 1h strategy 24 versions a day
    and push every real one out of the 20-version window within a day.

    The blob is written before the index: the reporter walks the index to find what to
    upload, so a blob can never be listed before it exists. Version numbers come off a
    counter that only ever increases — pruning the oldest never frees its number (canon §3:
    restoring v5 produces v8, not v5 again)."""
    if mode != 'backtest':
        return None
    src_path = config.get('__file__')
    if not src_path:
        logging.warning("version not minted: no __file__ in config — call run(locals(), …)")
        return None
    from lib.strategy import VERSIONS_KEEP, code_hash, load_index, versions_dir
    name = config['STRATEGY_NAME']
    src  = Path(src_path).read_bytes()
    vdir = versions_dir(name)
    os.makedirs(vdir, exist_ok=True)

    idx   = load_index(name) or {}
    items = [i for i in (idx.get('items') or []) if isinstance(i, dict)]
    n     = int(idx.get('counter') or 0) + 1
    note  = config.get('VERSION_NOTE')
    note  = note.strip() if isinstance(note, str) else ''
    # Unchanged note = the agent edited the code and forgot the note; store nothing rather
    # than a sentence describing the PREVIOUS change (canon §4, no restore exemption).
    # Compared against the last mint's RAW note, not the stored one — comparing against the
    # stored one makes an unchanged note reappear every other version (A → "" → A).
    entry_note = '' if note and note == idx.get('last_note') else note
    at     = int(stats.get(GENERATED_AT_KEY) or time.time())
    digest = code_hash(src)
    entry  = {'n': n, 'at': at, 'note': entry_note, 'code_hash': digest, **_version_fields(stats)}

    # Compact (indent=None): the daily curve is thousands of numbers and this blob is
    # uploaded as-is.
    _write_json_atomic(vdir / f'v{n}.json',
                       {'v': 1, 'strategy': name, **entry,
                        'code':          src.decode('utf-8', 'replace'),
                        'daily_dates':   stats.get('daily_dates') or [],
                        'daily_returns': stats.get('daily_returns') or []},
                       indent=None)

    items.append(entry)
    for old in items[:-VERSIONS_KEEP]:  # canon §8: keep 20; the api sweeps its own copy
        try:
            os.remove(vdir / f"v{old.get('n')}.json")
        except OSError:
            pass
    _write_json_atomic(vdir / 'index.json',
                       {'v': 1, 'counter': n, 'current': n, 'last_note': note,
                        'items': items[-VERSIONS_KEEP:]})
    # strategy.py is now exactly what v<n> stored, so any drift flag is stale.
    try:
        os.remove(vdir / 'drift.json')
    except OSError:
        pass
    return n


def _drift_flag(config, mode):
    """Live/cron tick: does strategy.py still match the code the current version stored?

    Mismatch writes versions/drift.json for the reporter to carry to the web (canon §6/§7:
    the badge reads 「上線中 · 檔案已改」 instead of a clean 「上線中」); a match removes it.
    A FLAG, never a refusal — refusing to run would leave state.json frozen on a stale
    signal, so the reconciler holds a position it can neither add to nor exit, and it would
    misfire on the two legitimate ways a file diverges (an older config on the machine, a
    user or BYO agent editing by hand). Backtests are not checked at all: fork-and-switch
    backtests the funded original side by side with its fork, and a gate there breaks it."""
    if mode == 'backtest' or not config.get('__file__'):
        return
    from lib.strategy import code_hash, load_index, versions_dir
    name  = config['STRATEGY_NAME']
    items = (load_index(name) or {}).get('items') or []
    if not items:
        return  # never versioned on this machine (older config) — nothing to compare against
    current = items[-1]
    digest  = code_hash(Path(config['__file__']).read_bytes())
    path    = versions_dir(name) / 'drift.json'
    if digest == current.get('code_hash'):
        try:
            os.remove(path)
        except OSError:
            pass
        return
    try:  # only rewrite when the state actually changed — a 1m strategy ticks 1,440×/day
        with open(path, encoding='utf-8') as f:
            if json.load(f).get('code_hash') == digest:
                return
    except (OSError, ValueError):
        pass
    _write_json_atomic(path, {'code_hash': digest, 'version': current.get('n'),
                              'at': int(time.time())})


def _picked_for_trading(name):
    """Is this strategy in the 下單設定 — i.e. would the platform be scheduling it live?

    Membership is the KEY in lib.portfolio.strategy_amounts(), not amount > 0: the web's
    picker schedules on pick (「選到就跑」, runtime/command_listener._cmd_amounts), so an
    amount of 0 is still a strategy whose signals feed the table. Same source as the
    restore() gate in lib/strategy.py:164-177, which is why the read stays CWD-relative
    (that gate detects a divergent cwd through it — do not make the path absolute): from
    anywhere but the workspace root the amounts read empty and this returns False, which is
    the fail-open direction — a hand-run becomes a backtest, never a live tick.

    .claude/docs/watchboard.md §3.3a widens the scheduled set to "in the 下單設定 OR on the
    watchboard"; once that lands, amounts alone no longer equal "scheduled" and this check
    has to read the watch markers too."""
    try:
        from lib.portfolio import strategy_amounts   # lazy: heavy module; only a run WITHOUT BLAVE_MODE gets here
        return name in strategy_amounts()
    except Exception as e:
        logging.warning("mode inference fell back to backtest: %s", e)
        return False


def _send_best_effort(send_fn, arg):
    """Everything this run produced is already on disk when it notifies, so a
    rejected send (Telegram 429 / "chat not found") must not fail the run: a
    live tick that raised here never saved its state and re-fired the same
    signal every tick. Printed as well as logged — the log goes to
    strategy.log, and the agent must not report a chart it never delivered."""
    try:
        send_fn(arg)
    except Exception as e:
        logging.warning(f"[runner] notification dropped ({e})")
        print(f"⚠️ Telegram send failed, nothing was delivered: {e}")


# ── Look-ahead (truncation-invariance) check — every backtest ─────────────────
# A causal strategy gives the same position at bar t whether or not bars after t exist.
# MCPT cannot see a look-ahead (it permutes returns under a fixed position), so this is the
# only automatic guard. The check re-runs fetch_data + compute_signals with the tail cut
# off at a few points and compares every bar the two runs share. fetch_data is re-run on
# REPLAYED lib.data results (recorded during the real fetch, truncated per cut, network
# blocked), so indicators built in _add_indicators inside fetch_data are covered too at no
# extra fetch cost. What it cannot see: a feed whose own timestamps overstate when it was
# published — truncating keeps that value, the lag lives in the source (R2 territory).
LOOKAHEAD_CUTS     = 5         # truncation points, one of them "drop the last bar"
LOOKAHEAD_SEED     = MCPT_SEED
LOOKAHEAD_BUDGET_S = 30.0      # stop adding cuts past this; the verdict says how many ran
LOOKAHEAD_RTOL     = 1e-6
LOOKAHEAD_ATOL     = 1e-9
_LOOKAHEAD_PATTERNS = (
    ('shift(-',             'negative shift reads a later bar'),
    ('bfill',               'backward fill copies a later value onto earlier bars'),
    ("method='bfill'",      'backward fill copies a later value onto earlier bars'),
    ('center=True',         'a centred window reads later bars'),
    ("label='left'",        "resample(label='left') stamps a bucket's final value on its first bar"),
    ("direction='forward'", "merge_asof(direction='forward') attaches a later row"),
    ("direction='nearest'", "merge_asof(direction='nearest') can attach a later row"),
)


class _ReplayMiss(Exception):
    """The replayed fetch_data asked for something the real run never fetched through
    lib.data (or tried the network) — replay cannot stand in for it."""


def _cut_for(idx, cut, ref):
    """cut (a timestamp of the signal index `ref`) expressed on idx's axis. Same awareness:
    as is. Otherwise a naive axis is either UTC (lib.data's convention) or wall-clock in the
    signal's zone (a Taipei feed) — pick the reading under which idx lines up with the signal
    bars; if it lines up with neither (a daily feed under hourly bars), take the LATER
    candidate: cutting a frame late can only hide a leak, cutting it early invents one."""
    if (idx.tz is None) == (cut.tz is None):
        return cut
    try:
        if idx.tz is None:        # naive frame, aware signal
            cands = [(cut.tz_convert('UTC').tz_localize(None), ref.tz_convert('UTC').tz_localize(None)),
                     (cut.tz_localize(None), ref.tz_localize(None))]
        else:                     # aware frame, naive signal
            cands = [(cut.tz_localize('UTC'), ref.tz_localize('UTC'))]
            try:
                cands.append((cut.tz_localize(idx.tz), ref.tz_localize(idx.tz)))
            except Exception:     # DST-ambiguous wall clock: that reading is not usable
                pass
    except Exception:
        return None
    hits = [int(idx.isin(mapped).sum()) for _, mapped in cands]
    if max(hits) > 0:
        return cands[hits.index(max(hits))][0]
    return max(c for c, _ in cands)


def _cut_by_availability(obj, cut, source):
    """A recorded lib.data feed (a FEED_TIMING source) cut to the rows PUBLISHED by `cut`
    rather than the rows STAMPED before it: a row stamped D 00:00 but published D 20:00 did
    not exist at a D 10:00 cut, so a strategy that let a D 09:00 bar read it shows up as a
    look-ahead. `cut` is the first removed bar's label = the last kept bar's close; a naive
    cut takes the later of its UTC / feed-tz readings (cutting late hides, never invents).
    None when the frame's times cannot be computed — the caller falls back to stamps."""
    try:
        from lib.data import FEED_TIMING, feed_available_at
        avail = feed_available_at(obj, source)
        if cut.tz is None:
            at = max(cut.tz_localize('UTC'), cut.tz_localize(FEED_TIMING[source]['tz']))
        else:
            at = cut
        return obj.loc[np.asarray(avail <= at)].copy()
    except Exception:
        return None


def _truncate(obj, cut, ref=None, source=None):
    """Copy of obj with every time-indexed pandas object cut to index < cut (cut=None:
    plain copy); `ref` is the signal index the cut came from (see _cut_for). A frame whose
    axis cannot be related to the cut is left whole — hides, never invents. `source` (a
    FEED_TIMING key) cuts by publication time instead, see _cut_by_availability."""
    if cut is not None and source is not None and isinstance(obj, (pd.DataFrame, pd.Series)):
        cut_obj = _cut_by_availability(obj, cut, source)
        if cut_obj is not None:
            return cut_obj
    if isinstance(obj, (pd.DataFrame, pd.Series)):
        idx = obj.index
        if cut is not None and isinstance(idx, pd.DatetimeIndex):
            c = _cut_for(idx, cut, ref) if ref is not None else (
                cut if (idx.tz is None) == (cut.tz is None) else None)
            if c is not None:
                return obj.loc[idx < c].copy()
        return obj.copy()
    if isinstance(obj, dict):
        return {k: _truncate(v, cut, ref, source) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_truncate(v, cut, ref, source) for v in obj]
    if type(obj) is tuple:
        return tuple(_truncate(v, cut, ref, source) for v in obj)
    return obj


def _feed_source(fetcher_name):
    """lib.data fetcher name → its FEED_TIMING key, or None for price / snapshot fetchers."""
    try:
        from lib.data import FEED_TIMING
    except ImportError:
        return None
    key = fetcher_name[len('fetch_'):] if fetcher_name.startswith('fetch_') else fetcher_name
    return key if key in FEED_TIMING else None


class _Raised:
    """A recorded fetcher call that raised in the real run."""
    def __init__(self, exc):
        self.exc = exc


class _FetchRecorder:
    """Wraps every lib.data fetch_* for the duration of one fetch_data call — and the
    strategy module's own global of the same function, for a top-level
    `from lib.data import fetch_kline`. Records (call → copy of result) on the real run;
    replays truncated copies during the look-ahead check. Top-level calls only: a fetcher
    calling another fetcher is recorded once, as the outer call."""

    def __init__(self, config):
        import threading
        self.config  = config
        self.records = {}
        self.usable  = True
        self._depth  = threading.local()

    @staticmethod
    def _key(name, args, kwargs):
        return repr((name, args, sorted(kwargs.items())))

    def _patched(self, make):
        import contextlib
        import lib.data as D
        recorder = self

        @contextlib.contextmanager
        def cm():
            originals = {n: f for n, f in vars(D).items() if n.startswith('fetch_') and callable(f)}
            in_cfg = [n for n, f in originals.items() if recorder.config.get(n) is f]
            try:
                for n, f in originals.items():
                    setattr(D, n, make(n, f))
                for n in in_cfg:
                    recorder.config[n] = getattr(D, n)
                yield
            finally:
                for n, f in originals.items():
                    setattr(D, n, f)
                for n in in_cfg:
                    recorder.config[n] = originals[n]
        return cm()

    def recording(self):
        def make(name, fn):
            def wrapper(*args, **kwargs):
                depth = getattr(self._depth, 'n', 0)
                self._depth.n = depth + 1
                try:
                    out = fn(*args, **kwargs)
                except Exception as e:
                    # a symbol the real run skipped on error must be skipped the same way
                    if depth == 0:
                        self.records[self._key(name, args, kwargs)] = _Raised(e)
                    raise
                finally:
                    self._depth.n = depth
                if depth == 0:
                    try:
                        self.records[self._key(name, args, kwargs)] = _truncate(out, None)
                    except Exception:
                        self.usable = False
                return out
            return wrapper
        return self._patched(make)

    def replaying(self, cut, ref=None):
        import contextlib
        import requests

        def make(name, fn):
            def wrapper(*args, **kwargs):
                key = self._key(name, args, kwargs)
                if key not in self.records:
                    self.missed = f"{name}() was called with arguments the real run did not use"
                    raise _ReplayMiss(self.missed)
                rec = self.records[key]
                if isinstance(rec, _Raised):
                    raise rec.exc
                return _truncate(rec, cut, ref, _feed_source(name))
            return wrapper

        def no_network(*_a, **_k):
            self.missed = "fetch_data reads data outside lib.data (network call)"
            raise _ReplayMiss(self.missed)

        @contextlib.contextmanager
        def cm():
            self.missed = None
            orig = requests.Session.request
            requests.Session.request = no_network
            try:
                with self._patched(make):
                    yield
            finally:
                requests.Session.request = orig
        return cm()


def _lookahead_positions(result, warmup):
    """compute_fn output → what the backtest actually trades on, post-WARMUP:
    Type A → float Series (ffill + fillna(0), NaN = hold, as run() does);
    Type C → DataFrame of weights with the asset columns of price_df['close'];
    None when the shape is not one run() understands."""
    if isinstance(result, tuple) and result and isinstance(result[0], pd.Series):
        result = result[0]
    if isinstance(result, pd.Series):
        return result.iloc[warmup:].astype(float).ffill().fillna(0.0)
    if isinstance(result, tuple) and len(result) >= 2 and isinstance(result[0], np.ndarray):
        w, price_df = result[0], result[1]
        try:
            cols = list(price_df['close'].columns)
        except Exception:
            cols = list(range(w.shape[1]))
        if w.ndim != 2 or len(cols) != w.shape[1] or len(price_df.index) != w.shape[0]:
            return None
        return pd.DataFrame(w.astype(float), index=price_df.index, columns=cols).iloc[warmup:]
    return None


def _lookahead_diff(full, part, cut):
    """First bar before `cut` where the truncated run disagrees with the full one, as
    (timestamp, column or None, full value, truncated value) — or None if they agree."""
    shared = full.index[full.index < cut]
    if isinstance(full, pd.Series):
        a = full.loc[shared].to_numpy()
        b = part.reindex(shared).to_numpy()
        bad = ~np.isclose(a, b, rtol=LOOKAHEAD_RTOL, atol=LOOKAHEAD_ATOL, equal_nan=True)
        if bad.any():
            i = int(np.flatnonzero(bad)[0])
            return shared[i], None, a[i], b[i]
        return None
    f = full.loc[shared]
    a = f.to_numpy(dtype=float)
    b = part.reindex(index=shared, columns=f.columns).to_numpy(dtype=float, copy=True)
    # an asset the truncated run never saw counts as flat there — it must not have held
    # weight before the cut in the full run either
    unseen = ~np.asarray(f.columns.isin(part.columns))
    b[:, unseen] = np.nan_to_num(b[:, unseen], nan=0.0)
    bad = ~np.isclose(np.nan_to_num(a, nan=0.0), np.nan_to_num(b, nan=0.0),
                      rtol=LOOKAHEAD_RTOL, atol=LOOKAHEAD_ATOL) | (np.isnan(a) != np.isnan(b))
    if bad.any():
        i, j = (int(x[0]) for x in np.nonzero(bad))
        return shared[i], f.columns[j], a[i, j], b[i, j]
    return None


def _lookahead_skip_mask(result, data, index):
    """Bars that must not be the LAST bar of a truncated run: settlement bars. Both
    settlement helpers mark the bar before a roll only once the roll is visible
    (settlement_signals_from_db needs the next bar's instrument_id; txf_settlement_mask
    stops at index.max()), so cutting right after one would read as a look-ahead. That
    dependence is a real live gap of its own, tracked separately — not this check's call."""
    n    = len(index)
    skip = np.zeros(n, dtype=bool)
    ea   = None
    if isinstance(result, tuple) and len(result) >= 2 and isinstance(result[0], pd.Series):
        ea = result[1]
    elif isinstance(result, tuple) and len(result) >= 3 and isinstance(result[0], np.ndarray):
        ea = result[2]
    if ea is not None:
        try:
            if hasattr(ea, 'reindex'):
                skip |= ea.reindex(index).fillna(False).to_numpy(dtype=bool)
            else:
                arr = np.asarray(ea, dtype=bool)
                if len(arr) == n:
                    skip |= arr
        except Exception:
            pass
    if isinstance(data, pd.DataFrame) and 'instrument_id' in data.columns:
        inst = data['instrument_id'].reindex(index)
        skip |= (inst != inst.shift(-1)).fillna(False).to_numpy(dtype=bool)
    return skip


def _lookahead_source_hints(config):
    """Lines of the strategy file that match a known look-ahead pattern — attached to a
    refusal only (never a finding on their own: `shift(-1)` in a comment is harmless)."""
    path = config.get('__file__')
    if not path:
        return []
    try:
        lines = Path(path).read_text(encoding='utf-8').splitlines()
    except OSError:
        return []
    hints = []
    for no, line in enumerate(lines, 1):
        code = line.split('#', 1)[0]
        for pat, why in _LOOKAHEAD_PATTERNS:
            if pat in code:
                hints.append(f"line {no}: {line.strip()[:120]}  ← {why}")
                break
    return hints[:8]


def _lookahead_check(config, fetch_data_fn, compute_fn, hdrs, data, result, recorder, compute_s=0.0):
    """Truncation-invariance verdict for this backtest:
      ('pass', detail) | ('skip', reason) | ('leak', (cut, ts, col, full_v, part_v, how)).

    Two replay modes, best first: 'fetch' re-runs fetch_data on recorded lib.data results
    (covers _add_indicators), 'compute' re-runs compute_signals on the truncated fetch_data
    output. A mode is used only if its untruncated replay reproduces the real result
    exactly — that control is what separates a look-ahead from a nondeterministic strategy
    or a fetch_data the replay cannot stand in for. Checker trouble never refuses a
    backtest ('skip'); only a reproduced, cut-dependent difference does ('leak')."""
    import contextlib, io
    if compute_s > 2 * LOOKAHEAD_BUDGET_S:
        return 'skip', (f'compute_signals took {compute_s:.0f}s — the check re-runs it at least '
                        f'twice, over the {LOOKAHEAD_BUDGET_S:.0f}s budget')
    warmup = int(config.get('WARMUP', 0) or 0)
    full   = _lookahead_positions(result, warmup)
    if full is None or len(full) == 0:
        return 'skip', 'compute_signals output is not a shape the check understands'
    if isinstance(result, pd.Series):
        index = result.index
    elif isinstance(result[0], pd.Series):
        index = result[0].index
    else:
        index = result[1].index
    if not isinstance(index, pd.DatetimeIndex) or not index.is_monotonic_increasing:
        return 'skip', 'the bar index is not a sorted DatetimeIndex'

    def via_fetch(cut):
        with recorder.replaying(cut, index):
            out = compute_fn(fetch_data_fn(hdrs))
        if recorder.missed:
            raise _ReplayMiss(recorder.missed)
        return out

    def via_compute(cut):
        return compute_fn(_truncate(data, cut, index))

    def quiet(fn, cut):
        with contextlib.redirect_stdout(io.StringIO()):
            return _lookahead_positions(fn(cut), warmup)

    started, why_not = time.monotonic(), []
    modes = ([('fetch', via_fetch)] if recorder is not None and recorder.usable and recorder.records
             else []) + [('compute', via_compute)]
    for how, fn in modes:
        try:
            same = quiet(fn, None)
        except (Exception, SystemExit) as e:
            why_not.append(f"{how}: {e}"[:160])
            continue
        if same is None or _lookahead_diff(full, same, index[-1] + pd.Timedelta(days=36500)) is not None:
            why_not.append(f"{how}: re-running on identical data gave a different result "
                           f"(nondeterministic strategy?)")
            continue
        n    = len(index)
        lo   = max(warmup + 20, n // 3)
        if n - 1 <= lo:
            return 'skip', f'only {n} bars (WARMUP {warmup}) — too short to test'
        skip = _lookahead_skip_mask(result, data, index)
        rng  = np.random.default_rng(LOOKAHEAD_SEED)
        pool = [n - 1] + list(rng.permutation(np.arange(lo, n - 1)))
        cuts = [k for k in pool if not skip[k - 1]][:LOOKAHEAD_CUTS]
        if not cuts:
            return 'skip', 'every candidate cut sits on a settlement bar'
        ran, errors = 0, []
        for k in cuts:
            if ran and time.monotonic() - started > LOOKAHEAD_BUDGET_S:
                break
            cut = index[k]
            try:
                part = quiet(fn, cut)
            except (Exception, SystemExit) as e:
                errors.append(str(e)[:120])
                continue
            if part is None:
                errors.append('truncated run returned an unexpected shape')
                continue
            if len(part) >= len(full):  # the replay did not actually lose the tail
                errors.append('truncation did not shorten the data')
                continue
            ran += 1
            d = _lookahead_diff(full, part, cut)
            if d is not None:
                return 'leak', (cut,) + d + (how,)
        if ran == 0:
            why_not.append(f"{how}: every truncated run failed ({'; '.join(errors[:2])})")
            continue
        scope = 'fetch_data + compute_signals' if how == 'fetch' else 'compute_signals only'
        return 'pass', f"{ran} truncation point(s), {scope}"
    return 'skip', '; '.join(why_not) or 'no replay mode available'


def _enforce_lookahead(config, fetch_data_fn, compute_fn, hdrs, data, result, recorder, compute_s=0.0):
    """Backtest gate. A reproduced look-ahead refuses the backtest (SystemExit before any
    stats.json / version / chart is written — same shape as the settlement-mask guard): the
    numbers of a strategy that reads the future are fiction, and a version frozen from them
    would be the one that gets deployed. Anything short of a proven difference only warns."""
    try:
        verdict, info = _lookahead_check(config, fetch_data_fn, compute_fn, hdrs, data,
                                         result, recorder, compute_s)
    except Exception as e:  # the checker itself broke — never take the backtest down with it
        verdict, info = 'skip', f'checker error: {e}'
    if verdict == 'pass':
        logging.info("look-ahead check passed: %s", info)
        print(f"  Look-ahead check: passed ({info})")
        return
    if verdict == 'skip':
        logging.warning("look-ahead check skipped: %s", info)
        print(f"  ⚠️ Look-ahead check skipped — this backtest is NOT verified free of look-ahead: {info}")
        return
    cut, ts, col, full_v, part_v, how = info
    where = f"{ts}" + (f" [{col}]" if col is not None else "")
    scope = ('fetch_data (incl. _add_indicators) + compute_signals' if how == 'fetch'
             else 'compute_signals')
    lines = [
        "❌ 偷看未來 (look-ahead): a bar's position changed when LATER bars were removed.",
        f"❌ Removed every bar from {cut} on and re-ran {scope}: at {where} the full data "
        f"gives {full_v:g}, the data that existed at that time gives {part_v:g}.",
        "❌ A causal strategy gives the same value at bar t whether or not bars after t exist. "
        "Usual causes: shift(-n), bfill, rolling(center=True), a mean/std/min/max/percentile/rank "
        "over the WHOLE series (use rolling/expanding), resample(label='left') joined back onto "
        "shorter bars (use label='right', closed='left'), merge_asof(direction='forward'), an "
        "external feed (三大法人, 融資, PCR, alpha…) join/ffilled onto bars that close before it "
        "is published (attach it with lib.data.align_feed). "
        "Type C: the old _rebalance_mask `(s != s.shift(-1)).fillna(True)` does this — use "
        "`(s != s.shift(1)).to_numpy()` (first bar of each period).",
    ]
    lines += [f"❌ {h}" for h in _lookahead_source_hints(config)]
    lines.append("❌ Backtest refused — fix it so every bar uses only data up to its own close, then re-run.")
    msg = '\n'.join(lines)
    logging.error(msg)
    raise SystemExit(msg)


def _weight_row_warnings(weights, index):
    """Type C weight rows the backtest will silently mis-book: gross above 1 (tied ranks
    under rank()'s default method='average' give 1.5 for a top-2 of [3,3,3,1]) and
    non-finite entries (NaN turns the whole equity curve NaN). Warn, not refuse — a
    deliberately levered portfolio is legal, it just has to be said out loud."""
    out = []
    w = np.asarray(weights, dtype=float)
    if w.ndim != 2 or not len(w):
        return out
    bad = ~np.isfinite(w).all(axis=1)
    if bad.any():
        out.append(f"{int(bad.sum())} weight row(s) contain NaN/inf (first {index[int(np.flatnonzero(bad)[0])]}) "
                   f"— fill them (0.0 = flat) or the equity curve turns NaN")
    gross = np.nansum(np.abs(w), axis=1)
    over = gross > 1 + 1e-6
    if over.any():
        i = int(np.flatnonzero(over)[0])
        out.append(f"{int(over.sum())} weight row(s) sum above 1 in absolute value (max {gross.max():.3f}, "
                   f"first {index[i]}) — that is leverage. Tied ranks do this: use "
                   f"rank(method='first'), or divide each row by max(1, its gross).")
    return out


def typec_live_state(weights, price_df, now=None, market='swap'):
    """The state.json a Type C live tick writes (lib.portfolio.aggregate_portfolio
    reads it): {'type': 'portfolio', 'weights': {SYMBOL: w}, 'rebalance_at',
    'bar_at', 'updated_at'}.

    weights = the LAST row of the weight matrix — the backtest holds row t
    during bar t+1, so the row the live tick computes at bar t's close is the
    target from now on (Type A takes its last signal the same way). NaN = 0.
    Symbols are price_df['close']'s columns, dashless upper like single-symbol
    states. rebalance_at = the first bar of the trailing run of identical rows:
    with the template's rebalance mask it is the period's rebalance bar and
    stays put until the next one — the "new signal" marker (resume_wait)."""
    w = np.nan_to_num(np.asarray(weights, dtype=float), nan=0.0)
    close = price_df['close']
    idx = close.index
    last = w[-1]
    i = len(w) - 1
    while i > 0 and np.allclose(w[i - 1], last, rtol=0, atol=1e-12):
        i -= 1
    syms = [str(c).replace('-', '').upper() for c in close.columns]
    total = float(np.abs(last).sum())
    if total > 1 + 1e-9:
        logging.warning(f"Type C weights sum to {total:.4f} > 1 — traded as computed "
                        f"(the backtest does the same)")
    return {'type': 'portfolio', 'market': market,
            'weights': {s: round(float(x), 10) for s, x in zip(syms, last)},
            'rebalance_at': int(pd.Timestamp(idx[i]).timestamp()),
            'bar_at': int(pd.Timestamp(idx[-1]).timestamp()),
            'updated_at': int(now if now is not None else time.time())}


def _fill_invalid_cells(close_v, open_v):
    """Type C price arrays (n, k) with invalid cells repaired per asset — the portfolio
    cannot drop a bar for one asset the way Type A drops it. Left alone, an Open-0 cell books
    overnight -100% on that asset and a Close-0 cell intraday -100%.
      Close NaN / <= 0 → Open and Close = the asset's last valid Close (a no-move bar; the
                         next valid bar's overnight leg spans the gap)
      Open  NaN / <= 0, Close valid → Open = the last valid Close (overnight 0, the bar's
                         real move lands in its intraday leg)
    Cells before the asset's first valid Close stay NaN (0 return, as before). open_v None =
    no Open column, Close is used for both."""
    close = np.asarray(close_v, dtype=float)
    opn   = close if open_v is None else np.asarray(open_v, dtype=float)
    with np.errstate(invalid='ignore'):
        c_ok = np.isfinite(close) & (close > 0)
        o_ok = np.isfinite(opn) & (opn > 0)
    if (c_ok & o_ok).all():
        return close, opn
    last_valid = pd.DataFrame(np.where(c_ok, close, np.nan)).ffill().to_numpy()
    prev_valid = np.vstack([np.full((1, close.shape[1]), np.nan), last_valid[:-1]])
    new_close = np.where(c_ok, close, last_valid)
    new_open  = np.where(c_ok & o_ok, opn, np.where(c_ok, prev_valid, last_valid))
    return new_close, new_open


def run(config, fetch_data_fn, compute_fn, send_telegram_fn=None):
    """
    Unified runner for Type A and Type C strategies.

    compute_fn(data) → pd.Series | (pd.Series, exec_at_close) | (weights, price_df[, exec_at_close])

      Type A:
        pd.Series of signals  — positive=long, negative=short, 0=flat, nan=hold
        optional tuple (signals, exec_at_close) where exec_at_close is a bool Series/array

      Type C:
        (weights_mat, price_df[, exec_at_close])
        price_df: MultiIndex DataFrame with 'close' and optionally 'open' as top-level keys
        exec_at_close: optional bool array (n,) in original space
    """
    # The file's MODE constant is not read: the platform's schedulers set
    # BLAVE_MODE=live, and a run without it is live exactly when the strategy is
    # in the 下單設定 (see _picked_for_trading) — so a hand-run of a deployed
    # strategy cannot mint a version, re-run MCPT or announce 「回測完成」 over
    # the live one. BLAVE_MODE=backtest is the escape hatch when the user wants
    # that backtest anyway. A live run is also QUIET: no chart re-render, no
    # chart/report pushed into the chat or Telegram — an hourly pnl.png would
    # spam the conversation and re-upload images every report; the tick's job
    # is the signal, nothing else.
    _env_mode      = os.environ.get('BLAVE_MODE') or None   # '' counts as unset
    _inferred_live = not _env_mode and _picked_for_trading(config['STRATEGY_NAME'])
    mode           = _env_mode or ('live' if _inferred_live else 'backtest')
    quiet          = (_env_mode not in (None, 'backtest')) or _inferred_live
    strategy_name  = config['STRATEGY_NAME']
    fee           = config.get('FEE', 0.0005)
    interval      = config.get('INTERVAL', '1h')

    # TAIFEX settlement-mask enforcement — an unmasked backtest on the unadjusted
    # continuous series books roll gaps as fake PnL, so refuse to produce stats at
    # all rather than deliver silently-wrong numbers (AGENTS.md › Backtest Output;
    # detection lives in lib/quality_check.py). Checked before the data fetch so a
    # doomed run costs nothing. Live/cron runs are NOT blocked here: stopping an
    # already-deployed strategy's signal feed is a fleet-ops decision, not this
    # guard's call.
    if mode == 'backtest' and config.get('__file__'):
        # Defensive import: a workspace whose lib/quality_check.py predates this
        # guard (partial/stale sync) must not crash every backtest — fail open.
        try:
            from lib.quality_check import txf_settlement_findings
        except ImportError:
            logging.warning("lib/quality_check.py is stale — settlement-mask guard skipped")
            txf_settlement_findings = None
        problems = txf_settlement_findings(config['__file__']) if txf_settlement_findings else []
        if problems:
            raise SystemExit(
                '\n'.join(f"❌ Line {p['line']}: {p['msg']}" for p in problems)
                + '\n❌ Backtest refused — apply txf_settlement_mask, then re-run.'
            )

        # Pinned-END enforcement — nothing on the live path overrides END, so a
        # fixed date freezes a deployed strategy's signals at that date forever.
        # Refusing the backtest closes the deployment funnel (the deploy ritual
        # starts with one); live/cron runs are NOT blocked, same fleet-ops
        # reasoning as above.
        try:
            from lib.quality_check import end_pinned_findings
        except ImportError:
            logging.warning("lib/quality_check.py is stale — pinned-END guard skipped")
            end_pinned_findings = None
        problems = end_pinned_findings(config['__file__']) if end_pinned_findings else []
        if problems:
            raise SystemExit(
                '\n'.join(f"❌ Line {p['line']}: {p['msg']}" for p in problems)
                + '\n❌ Backtest refused — set END = None, then re-run.'
            )

    env  = dotenv_values()
    hdrs = {'api-key': env.get('blave_api_key', ''), 'secret-key': env.get('blave_secret_key', '')}

    out_dir = _REPO_ROOT / 'strategies' / strategy_name
    os.makedirs(out_dir, exist_ok=True)
    # Without Telegram, make_sender() (evaluated before run()) logs a warning first, which
    # implicitly installs a bare stderr StreamHandler and would make basicConfig a no-op.
    # Drop only that one (not force=True) so handlers other code attached stay in place.
    root = logging.getLogger()
    for h in root.handlers[:]:
        if type(h) is logging.StreamHandler:
            root.removeHandler(h)
            h.close()
    logging.basicConfig(
        filename=str(out_dir / 'strategy.log'),
        level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s'
    )

    try:  # visibility only — never blocks the tick (see _drift_flag)
        _drift_flag(config, mode)
    except Exception as e:
        logging.warning("version drift check skipped: %s", e)

    import contextlib
    try:  # a still-forming crypto bar must not become the live tick's iloc[-1]
        from lib.data import closed_bars_only
    except ImportError:
        closed_bars_only = contextlib.nullcontext
    try:  # live: align_feed refuses a bar whose external row has not been published yet
        from lib.data import live_feeds
    except ImportError:
        live_feeds = contextlib.nullcontext
    recorder = _FetchRecorder(config) if mode == 'backtest' else None
    with closed_bars_only(), (live_feeds() if mode != 'backtest' else contextlib.nullcontext()), \
            (recorder.recording() if recorder else contextlib.nullcontext()):
        data = fetch_data_fn(hdrs)
    compute_t0 = time.monotonic()
    result = compute_fn(data)
    if mode == 'backtest':
        _enforce_lookahead(config, fetch_data_fn, compute_fn, hdrs, data, result, recorder,
                           time.monotonic() - compute_t0)

    # Unpack optional exec_at_close for Type A: (signals, exec_at_close) → signals
    exec_at_close_orig = None
    if isinstance(result, tuple) and isinstance(result[0], pd.Series):
        signals_raw, *_rest = result
        exec_at_close_orig  = _rest[0] if _rest else None
        result              = signals_raw

    # ── Type A: signal strategy ───────────────────────────────────────────────
    if isinstance(result, pd.Series):
        df      = data
        signals = result
        if mode == 'backtest':  # live clamps the NET spot target in lib/portfolio (after netting strategies)
            from lib.exits import clamp_spot
            signals = clamp_spot(signals, config.get('MARKET'))

        # ── Full PnL computation (always) ──────────────────────────────────────
        warmup = config.get('WARMUP', 0)
        if warmup > 0:
            df      = df.iloc[warmup:]
            signals = signals.iloc[warmup:]

        # Drop bars with invalid prices (e.g. futures overnight gaps). Open counts too: a
        # valid Close on an Open-0 bar would book overnight = 0/close[t-1] - 1 = -100%.
        # Dropping loses nothing — the next bar's overnight leg spans the gap.
        valid = (df['Close'].notna() & (df['Close'] > 0)
                 & df['Open'].notna() & (df['Open'] > 0))
        if not valid.all():
            df      = df[valid]
            signals = signals.reindex(df.index).ffill()

        n   = len(df)
        pos = signals.ffill().fillna(0).values  # shape (n,)

        # 2-lag weight arrays
        w_curr      = np.empty(n)
        w_curr[0]   = 0.0
        w_curr[1:]  = pos[:-1]
        w_prev      = np.zeros(n)
        if n >= 2:
            w_prev[2:] = pos[:-2]

        # exec_at_close mask (original space → shift +1 to align with w_curr/w_prev)
        if exec_at_close_orig is not None:
            if hasattr(exec_at_close_orig, 'reindex'):
                ea = exec_at_close_orig.reindex(df.index).fillna(False).values.astype(bool)
            else:
                ea = np.asarray(exec_at_close_orig, dtype=bool)[-n:]
        elif 'instrument_id' in df.columns:
            ea = (df['instrument_id'] != df['instrument_id'].shift(-1)).fillna(False).values.astype(bool)
        else:
            ea = np.zeros(n, dtype=bool)

        exec_shifted      = np.zeros(n, dtype=bool)
        exec_shifted[1:]  = ea[:-1]

        close_v = df['Close'].values
        open_v  = df['Open'].values

        pf_ret, overnight, delta_w, tc_daily = precise_pnl(
            close_v, open_v, w_curr, w_prev, exec_shifted, fee
        )

        pf_series = pd.Series(pf_ret, index=df.index)
        sharpe, sortino, omega, mdd_raw, _ = compute_stats(pf_ret, df.index)

        total_ret  = float(np.prod(1 + np.nan_to_num(pf_ret)) - 1) * 100
        mdd        = -abs(mdd_raw) * 100  # drawdown is a loss from peak → always ≤ 0
        bench_ret  = (close_v[-1] / close_v[0] - 1) * 100
        total_fees = float(tc_daily.sum()) * 100
        n_trades   = int(np.count_nonzero(np.nan_to_num(delta_w)))

        def _v(x):
            if x is None: return None
            if isinstance(x, float) and (math.isnan(x) or math.isinf(x)): return None
            return round(float(x), 4)

        # Per-event trade log for the workspace overlay. One row per nonzero delta_w[t],
        # each carrying `position` = the post-event position (w_curr[t]) — authoritative
        # for the frontend's flat/flip/open classification. Cumsum-rebuilding from the
        # 4dp-rounded deltas is NOT equivalent: the quantization residual (~1e-4 per
        # event) dwarfs any zero-epsilon, so vol-scaled continuous-weight strategies
        # never read as flat, and any event dropped below makes the rebuilt curve
        # drift permanently. Price alignment MUST mirror precise_pnl's own exec_shifted
        # logic (same t index, same close_v[t-1]/open_v[t] choice) or the overlay marks
        # won't land on the bar precise_pnl actually priced the trade at.
        #
        # delta_w_clean (nan_to_num'd) is only used to locate nonzero indices — the values
        # actually written per event come from the raw (un-cleaned) arrays and go through
        # _v() below, so a genuine nan/inf delta/price is dropped instead of silently
        # surviving as a large-but-finite number that math.isinf() can no longer catch.
        delta_w_clean = np.nan_to_num(delta_w)
        trades = []
        # Pre-event position (w_prev[t], the same chain precise_pnl differenced) per
        # retained event — kept parallel to `trades` so tail-truncation below can
        # anchor the surviving events for frontends still on the legacy cumsum
        # fallback (data produced before per-event `position` existed).
        pre_positions = []
        for t in np.flatnonzero(delta_w_clean):
            dw_raw = float(delta_w[t])
            dw     = _v(dw_raw)
            if dw is None:
                continue  # nan/inf delta — drop the event rather than write a bad value

            price_raw = close_v[t - 1] if exec_shifted[t] else open_v[t]
            price     = _v(price_raw)
            if price is None or price <= 0:
                continue  # nan/inf/non-positive price (e.g. futures overnight gap) — drop the event

            position = _v(w_curr[t])
            if position is None:
                continue  # nan/inf post-event position — drop the event, same as delta/price above

            trades.append({
                # epoch seconds, not isoformat() — matches the live-mode candles payload
                # below; isoformat() is tz-naive for crypto but tz-aware for TXF/twstock,
                # which JS `new Date()` parses inconsistently (local time vs. UTC offset).
                'ts':        int(df.index[t].timestamp()),
                'price':     price,
                'direction': 'buy' if dw_raw > 0 else 'sell',
                'delta':     dw,
                'position':  position,
            })
            pre_positions.append(float(w_prev[t]))
        trades_full = trades
        if len(trades) > TRADES_MAX_COUNT:
            trades        = trades[-TRADES_MAX_COUNT:]  # tail — most recent trades matter first
            pre_positions = pre_positions[-TRADES_MAX_COUNT:]
        # Position before the first retained event: start + Σ(retained deltas) walks the
        # same values w_curr held. Always written so the frontend needn't special-case
        # truncation; null (nan/inf via _v) means "no anchor — fall back".
        trades_start_position = _v(pre_positions[0]) if pre_positions else 0.0

        print(f"  Total Return: {total_ret:.2f}%  Sharpe: {sharpe:.2f}  MDD: {mdd:.2f}%")
        print(f"  Fee Rate: {fee*100:.4f}%  Total Fees: {total_fees:.2f}%  Trades: {n_trades}")
        if n_trades == 0:
            print("  ⚠️ WARNING: 0 trades — the entry condition never fired; "
                  "all stats are meaningless. Check thresholds against the data's actual range.")
        # Non-blocking, unlike the settlement guard: a missing PLOT_SERIES only costs
        # the workspace its indicator pane, so hint in the output the agent reads
        # after every backtest rather than refuse the run.
        if mode == 'backtest' and config.get('__file__'):
            try:
                from lib.quality_check import plot_series_findings
            except ImportError:  # stale lib/quality_check.py on this workspace
                logging.warning("lib/quality_check.py is stale — PLOT_SERIES hint skipped")
                plot_series_findings = None
            for p in (plot_series_findings(config['__file__']) if plot_series_findings else []):
                logging.warning(p['msg'])
                print(f"  ⚠️ WARNING: {p['msg']}")

        # Hand-written exit loop → WARNING line only, never blocks (lib/quality_check.py).
        if mode == 'backtest' and config.get('__file__'):
            try:
                from lib.quality_check import exit_loop_findings
                for p in exit_loop_findings(config['__file__']):
                    logging.warning(p['msg'])
                    print(f"  ⚠️ WARNING: {p['msg']}")
            except Exception as e:  # stale quality_check / parse trouble: skip the hint, keep the run
                logging.warning("exit-loop hint skipped: %s", e)

        equity   = np.cumprod(1 + np.nan_to_num(pf_ret))
        result_d = {
            'strat_ret':    pf_ret,
            'position':     w_curr,
            'realized_vol': df['realized_vol'].values if 'realized_vol' in df.columns
                            else np.full(n, np.nan),
            'cum':          equity / equity[0],
        }

        from lib.pnl import daily_returns_typeA
        d_dates, d_rets = daily_returns_typeA(pf_series)

        stats = {'strategy': strategy_name, 'symbol': config.get('SYMBOL'), 'interval': interval,
                 'start': config.get('START'), 'end': df.index[-1].strftime('%Y-%m-%d'),
                 'fee [%]': round(fee * 100, 4),
                 'Total Return [%]':     _v(total_ret),
                 'Benchmark Return [%]': _v(bench_ret),
                 'Max Drawdown [%]':     _v(mdd),
                 'Sharpe Ratio':         _v(sharpe),
                 'Sortino Ratio':        _v(sortino),
                 'Omega Ratio':          _v(omega),
                 'Total Fees Paid [%]':  round(total_fees, 4),
                 'Trades':               n_trades,
                 'daily_dates': d_dates, 'daily_returns': d_rets,
                 'trades': trades,
                 'trades_start_position': trades_start_position,
                 }
        panes = _build_panes(config.get('PLOT_SERIES'), df)
        if panes:  # optional field — absent (not empty) when nothing is declared/valid
            stats['panes'] = panes
        candles = _build_candles(df)
        if candles:  # optional field — same absent-not-empty convention as panes
            stats['candles'] = candles
        if mode == 'backtest':  # automatic MCPT — backtest only; a live tick carries it over below
            mcpt_fields = _auto_mcpt(config, close_v, pos, df.index, fee, n_trades)
            if mcpt_fields:
                stats.update(mcpt_fields)
                print(f"  MCPT p-value: {mcpt_fields[MCPT_KEYS[0]]:.4f}  "
                      f"(n={mcpt_fields[MCPT_KEYS[1]]}, "
                      f"{'significant edge' if mcpt_fields[MCPT_KEYS[0]] < 0.05 else 'no significant edge'} at 95%)")
                if mcpt_fields[MCPT_KEYS[1]] < MCPT_N_MIN:
                    # Its own line, never folded into the one above: that f-string's shape is
                    # parsed downstream, an extra line is not. _mcpt_n_effective says the same
                    # thing to strategy.log, which the agent does not read on a normal run, and
                    # a listing gate the author only meets at submission time is the gap this
                    # whole branch exists to close — so it has to reach the one channel that
                    # surfaces on every backtest.
                    print(f"  n={mcpt_fields[MCPT_KEYS[1]]} is below the strategy library's "
                          f"listing minimum of {MCPT_N_MIN} — raise MCPT_N to {MCPT_N_MIN} or "
                          f"more and re-run to make it listable, or leave it as is if this "
                          f"strategy is not for the library.")
        stats.update(_carry_over(out_dir, mode))  # live tick keeps MCPT + Generated At; backtest drops/restamps
        stats.setdefault(GENERATED_AT_KEY, int(time.time()))
        _write_stats(out_dir, stats)
        try:  # a version is a record of the run, not part of it — never fail the backtest
            _mint_version(config, stats, mode)
        except Exception as e:
            logging.warning("version mint failed: %s", e)

        # Full chart export on every user-run backtest; a live/cron tick rewrites stats.json
        # every few minutes and re-serializing years of bars each time would burn the VM for
        # nothing (the uploader is content-hashed, but the build isn't free) — so live only
        # rebuilds when the stats tail is about to outrun chart/ (see _chart_refresh_due).
        if mode == 'backtest' or (candles and _chart_refresh_due(
                out_dir, candles[0][0], int(df.index[-1].timestamp()))):
            try:
                _write_chart_dir(out_dir, df, _build_candles(df, max_count=None),
                                 _build_panes(config.get('PLOT_SERIES'), df, max_points=None),
                                 trades_full, config.get('SYMBOL'), interval)
            except Exception as e:  # the chart is an extra; stats/pnl/notify still ship
                logging.warning("chart export failed: %s", e)

        if not quiet:
            plot_pnl(df, result_d, title=strategy_name,
                     output_path=str(out_dir / 'pnl.png'))
            # Mirror the chart into the web workspace chat (no-op off web); separate
            # from the Telegram gate below so it shows regardless of send_telegram_fn.
            from lib.notify import report_photo_web
            report_photo_web(str(out_dir / 'pnl.png'))

        if mode == 'backtest':
            if send_telegram_fn:
                from lib.notify import send_photo
                _send_best_effort(send_photo, str(out_dir / 'pnl.png'))
                _send_best_effort(send_telegram_fn,
                    f"回測完成：{strategy_name}\n"
                    f"Return {total_ret:.1f}%  "
                    f"Sharpe {sharpe:.2f}  "
                    f"MDD {mdd:.1f}%  "
                    f"Trades {n_trades}"
                    + ("\n⚠️ 0 筆交易——進場條件從未觸發，數字無意義" if n_trades == 0 else "")
                )
            return

        # ── Live mode ──────────────────────────────────────────────────────────
        t, r = df.index[-1], df.iloc[-1]
        candle = {'time': int(t.timestamp()), 'close': float(r['Close']),
                  'open': float(r['Open']), 'high': float(r['High']), 'low': float(r['Low'])}

        state  = load_state(strategy_name) or {
            'position': float(signals.ffill().fillna(0).iloc[-1]),
        }
        # Same ffill as the backtest's pos: a tick that skipped bars (slow tick, fetch backoff)
        # would otherwise lose any entry/exit on them for good; this way the next tick converges.
        signal = float(signals.ffill().fillna(0).iloc[-1])
        logging.info(f"signal={signal:.4f} close={candle['close']}")

        update_state(candle, signal, state, mode,
                     symbol=config.get('SYMBOL', ''),
                     send_telegram_fn=(lambda m: _send_best_effort(send_telegram_fn, m))
                     if send_telegram_fn else None)
        save_state(strategy_name, state)


    # ── Type C: portfolio strategy ────────────────────────────────────────────
    elif isinstance(result, tuple) and isinstance(result[0], np.ndarray):
        weights_orig, price_df, *_opt = result
        exec_at_close_orig_c = np.asarray(_opt[0], dtype=bool) if _opt else None

        warmup = config.get('WARMUP', 0)
        if warmup > 0:
            weights_orig         = weights_orig[warmup:]
            price_df             = price_df.iloc[warmup:]
            if exec_at_close_orig_c is not None:
                exec_at_close_orig_c = exec_at_close_orig_c[warmup:]

        if mode == 'backtest':
            for msg in _weight_row_warnings(weights_orig, price_df.index):
                logging.warning(msg)
                print(f"  ⚠️ WARNING: {msg}")

        close_df = price_df['close']
        open_df  = price_df['open'] if 'open' in price_df.columns.get_level_values(0) else None

        n, k = weights_orig.shape

        # 2-lag weight arrays
        w_curr = np.vstack([np.zeros((1, k)), weights_orig[:-1]])   # shift 1: w_curr[t] = orig[t-1]
        w_prev = np.vstack([np.zeros((2, k)), weights_orig[:-2]])   # shift 2: w_prev[t] = orig[t-2]

        # exec_at_close mask (original space → shift +1)
        if exec_at_close_orig_c is not None:
            exec_shifted_c      = np.zeros(n, dtype=bool)
            exec_shifted_c[1:]  = exec_at_close_orig_c[:-1]
        else:
            exec_shifted_c = np.zeros(n, dtype=bool)

        close_v, open_v = _fill_invalid_cells(
            close_df.values, open_df.values if open_df is not None else None)

        pf_ret, overnight, delta_w, tc_daily = precise_pnl(
            close_v, open_v, w_curr, w_prev, exec_shifted_c, fee
        )

        bench_stats = {}

        pf_equity = np.cumprod(1 + pf_ret)
        pf_series = pd.Series(pf_ret, index=close_df.index)
        total_ret = pf_equity[-1] - 1
        sharpe, sortino, omega, mdd, ann_ret = compute_stats(pf_ret, close_df.index)

        n_trades = int(np.count_nonzero(np.nan_to_num(delta_w)))

        print(f"  Total Return:  {total_ret:.1%}")
        print(f"  Ann. Return:   {ann_ret:.1%}")
        print(f"  Sharpe Ratio:  {sharpe:.2f}")
        print(f"  Max Drawdown:  {mdd:.1%}")
        print(f"  Fee Rate:      {fee*100:.4f}%  Total Fees: {tc_daily.sum()*100:.2f}%  Trades: {n_trades}")
        if n_trades == 0:
            print("  ⚠️ WARNING: 0 trades — the weight vector never changed; "
                  "all stats are meaningless. Check thresholds against the data's actual range.")

        from lib.analysis import random_bh_benchmark
        bench_stats, bench_pct = random_bh_benchmark(close_df, total_ret * 100, sharpe)

        def _v(x):
            if x is None: return None
            if isinstance(x, float) and (math.isnan(x) or math.isinf(x)): return None
            return round(float(x), 4)

        from lib.pnl import daily_returns_typeC
        d_dates, d_rets = daily_returns_typeC(pf_series)

        # No automatic MCPT for Type C — see _auto_mcpt's docstring (mcpt() is single-series).
        carried = _carry_over(out_dir, mode)  # live tick keeps MCPT + Generated At; backtest drops/restamps
        carried.setdefault(GENERATED_AT_KEY, int(time.time()))
        stats = {'strategy': strategy_name, 'interval': interval,
                 'start': close_df.index[0].strftime('%Y-%m-%d'),
                 'end':   close_df.index[-1].strftime('%Y-%m-%d'),
                 'fee': fee,                        # pre-existing key, kept for older readers
                 'fee [%]': round(fee * 100, 4),    # the key the workspace report reads (as Type A)
                 'Total Return [%]':    _v(total_ret * 100),
                 'Ann. Return [%]':     _v(ann_ret   * 100),
                 'Sharpe Ratio':        _v(sharpe),
                 'Sortino Ratio':       _v(sortino),
                 'Omega Ratio':         _v(omega),
                 'Max Drawdown [%]':    _v(mdd       * 100),
                 'Total Fees Paid [%]': round(float(tc_daily.sum()) * 100, 4),
                 'Trades':              n_trades,
                 **bench_stats,
                 'daily_dates': d_dates, 'daily_returns': d_rets,
                 **carried,
                 }
        _write_stats(out_dir, stats)
        try:  # same as Type A: the record must not be able to fail the run
            _mint_version(config, stats, mode)
        except Exception as e:
            logging.warning("version mint failed: %s", e)

        if not quiet:
            plot_pnl_portfolio(pf_series, close_df, title=strategy_name,
                               output_path=str(out_dir / 'pnl.png'),
                               bench_pct=bench_pct)
            # Mirror into the web workspace chat (no-op off web), regardless of the
            # Telegram gate below.
            from lib.notify import report_photo_web
            report_photo_web(str(out_dir / 'pnl.png'))

        if mode != 'backtest':
            # the live target (lib.portfolio.aggregate_portfolio): per-asset
            # weights of the last computed row, and the rebalance bar they began on
            live = typec_live_state(weights_orig, price_df, market=config.get('MARKET', 'swap'))
            prev = load_state(strategy_name) or {}
            if prev.get('rebalance_at') != live['rebalance_at']:
                logging.info(f"Type C rebalance at {live['rebalance_at']}: {live['weights']}")
            save_state(strategy_name, live)

        if send_telegram_fn and not quiet:
            from lib.notify import send_photo
            _send_best_effort(send_photo, str(out_dir / 'pnl.png'))
            _send_best_effort(send_telegram_fn,
                f"回測完成：{strategy_name}\n"
                f"總報酬 {total_ret:.1%}  年化 {ann_ret:.1%}\n"
                f"Sharpe {sharpe:.2f}  MDD {mdd:.1%}  Trades {n_trades}"
                + ("\n⚠️ 0 筆交易——權重從未變動，數字無意義" if n_trades == 0 else "")
            )

    else:
        raise TypeError(f"compute_fn must return pd.Series (Type A) or tuple (Type C), got {type(result)}")
