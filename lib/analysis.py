import math
import tempfile
import os
import numpy as np
import pandas as pd
import logging

# Same list as lib/matplotlibrc.
CJK_FONTS = ['Noto Sans CJK TC', 'Microsoft JhengHei', 'Noto Sans CJK SC', 'Microsoft YaHei', 'WenQuanYi Micro Hei', 'Heiti TC', 'Arial Unicode MS', 'DejaVu Sans']


def _plt():
    """pyplot on Agg with CJK fonts, imported on the first chart: a live tick draws none and
    should not pay pyplot's import time and memory every bar."""
    import matplotlib
    matplotlib.use('Agg')
    # only over matplotlib's own default: a font the caller (or lib/matplotlibrc) set stays
    if matplotlib.rcParams['font.family'] == matplotlib.rcParamsDefault['font.family']:
        matplotlib.rcParams['font.family'] = CJK_FONTS
    logging.getLogger('matplotlib.font_manager').setLevel(logging.ERROR)
    import matplotlib.pyplot as plt
    return plt


def __getattr__(name):
    # `from lib.analysis import plt` (a module attribute until the import went lazy) keeps working
    if name == 'plt':
        return _plt()
    if name == 'matplotlib':
        _plt()
        import matplotlib
        return matplotlib
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def precise_pnl(close_v, open_v, w_curr, w_prev, exec_shifted, fee):
    """
    Unified precise PnL for Type A (1-D) and Type C (2-D).

    overnight[t] = (open[t] - close[t-1]) / close[t-1]  — held by w_prev (or w_curr if exec_at_close)
    intraday[t]  = (close[t] - open[t])   / open[t]      — held by w_curr

    exec_shifted[t] = True  → this-bar close execution: overnight uses w_curr
                    = False → next-bar open execution:  overnight uses w_prev

    Returns (pf_ret, overnight, delta_w, tc_daily)
    """
    prev_close     = np.empty_like(close_v)
    prev_close[0]  = close_v[0]
    prev_close[1:] = close_v[:-1]

    with np.errstate(invalid='ignore', divide='ignore'):
        overnight = np.where(prev_close != 0, (open_v - prev_close) / prev_close, 0.0)
        intraday  = np.where(open_v != 0,     (close_v - open_v)    / open_v,     0.0)
    overnight = np.nan_to_num(overnight, nan=0.0)
    intraday  = np.nan_to_num(intraday,  nan=0.0)

    delta_w  = w_curr - w_prev
    if w_curr.ndim > 1:
        tc_daily = np.abs(delta_w).sum(axis=1) * fee
        mask2d   = exec_shifted[:, None]
    else:
        tc_daily = np.abs(delta_w) * fee
        mask2d   = exec_shifted

    w_overnight = np.where(mask2d, w_curr, w_prev)

    if w_curr.ndim > 1:
        pf_ret = (w_overnight * overnight + w_curr * intraday).sum(axis=1) - tc_daily
    else:
        pf_ret = w_overnight * overnight + w_curr * intraday - tc_daily

    return pf_ret, overnight, delta_w, tc_daily


def count_trades(delta_w):
    """Weight changes that count as a trade: |Δw| ≥ 0.00005, i.e. nonzero after
    rounding to 4 dp — the same rounding the runner applies when it writes
    stats['trades'], so 'Trades' equals the trade list the reports show.
    Smaller changes are float noise and vol-scaling micro-adjustments; this is a
    reporting definition, not a claim about live orders (a big enough account
    can still send one). Fees still use every Δw."""
    return int(np.count_nonzero(np.round(np.nan_to_num(np.asarray(delta_w, dtype=float)), 4)))


def periods_per_year(index, n=None):
    """Bars per year derived from the actual date range of `index` (n bars over
    span_days) — works for any market (crypto 24/7, stocks 252d, futures ~250d,
    intraday, weekly, etc.). Falls back to n when the span is < 1 day or the index
    is not indexable. Shared by compute_stats and the runner's automatic MCPT."""
    if n is None:
        n = len(index)
    if n > 1 and hasattr(index, '__getitem__'):
        span_days = (index[-1] - index[0]).days
        return n / (span_days / 365.25) if span_days > 0 else n
    return n


def compute_stats(pf_ret, index):
    """
    Annualized performance stats from per-bar returns.
    Returns (sharpe, sortino, omega, mdd, ann_ret).

    ppy is derived from the actual date range — see periods_per_year().
    """
    r = np.nan_to_num(np.asarray(pf_ret, dtype=float), nan=0.0)
    n = len(r)
    ppy = periods_per_year(index, n)

    mean_r   = r.mean()
    std_r    = r.std(ddof=1) if n > 1 else 0.0
    sharpe   = mean_r / std_r * math.sqrt(ppy) if std_r > 0 else 0.0

    # Downside deviation (Sortino & van der Meer; empyrical.downside_risk): RMS of the
    # shortfall below MAR=0 over ALL bars. Not the std of the losing bars — that is
    # centred on the losers' own mean, shrinks with every flat bar, and is 0 when
    # every loss has the same size.
    dd_down  = math.sqrt(np.mean(np.minimum(r, 0.0) ** 2)) if n > 0 else 0.0
    sortino  = mean_r / dd_down * math.sqrt(ppy) if dd_down > 0 else 0.0

    gains  = r[r > 0].sum()
    losses = (-r[r < 0]).sum()
    omega  = gains / losses if losses > 0 else float('inf')

    equity  = np.cumprod(1 + r)
    mdd     = float(np.min(equity / np.maximum.accumulate(equity)) - 1)
    eq_end  = equity[-1] if n > 0 else 1.0
    ann_ret = float(eq_end ** (ppy / n) - 1) if (n > 0 and eq_end > 0) else float('nan')

    return sharpe, sortino, omega, mdd, ann_ret


def _build_regimes(strat_ret, close, dates, realized_vol, hours_per_year=8760, vol_lookback=720):
    """Compute per-regime stats. Returns [(group_name, [(label, stats_or_None)])]."""
    ma_window  = vol_lookback * 200 // 30
    ma200      = pd.Series(close).rolling(ma_window).mean().values
    valid_ma   = ~np.isnan(ma200)
    vol_median = np.nanmedian(realized_vol)
    valid_vol  = ~np.isnan(realized_vol)
    bull       = close > ma200
    highvol    = realized_vol > vol_median
    n_total    = len(strat_ret[~np.isnan(strat_ret)])

    def _stats(mask):
        r = strat_ret[mask]; r = r[~np.isnan(r)]
        if len(r) < 2: return None
        total_years = len(r) / hours_per_year
        cum_r   = np.prod(1 + r) - 1
        ann_r   = (1 + cum_r) ** (1 / total_years) - 1 if total_years > 0 else np.nan
        ann_vol = r.std() * np.sqrt(hours_per_year)
        sharpe  = (r.mean() / r.std()) * np.sqrt(hours_per_year) if r.std() > 0 else np.nan
        cc = np.cumprod(1 + r); pk = np.maximum.accumulate(cc)
        mdd = ((cc - pk) / pk).min()
        return dict(ann_ret=ann_r, ann_vol=ann_vol, sharpe=sharpe, max_dd=mdd, pct_time=len(r) / n_total)

    return [
        ('By Year',           [(str(yr), _stats(dates.year == yr)) for yr in sorted(dates.year.unique())]),
        ('Trend Regime',      [('Bull (price > MA200)', _stats(bull & valid_ma)),
                                ('Bear (price < MA200)', _stats(~bull & valid_ma))]),
        ('Volatility Regime', [('High Vol (>median)',   _stats(highvol & valid_vol)),
                                ('Low  Vol (≤median)',  _stats(~highvol & valid_vol))]),
    ]


def regime_analysis(df, result, vol_lookback=720, hours_per_year=8760):
    """Print text table of strategy performance by year / bull-bear / high-low vol regime."""
    groups = _build_regimes(
        result['strat_ret'], df['Close'].values, df.index, result['realized_vol'],
        hours_per_year, vol_lookback,
    )
    hdr = f"  {'Regime':<22} {'Ann Ret':>9} {'Ann Vol':>9} {'Sharpe':>8} {'MDD':>8} {'Time%':>7}"
    print(f"\n{'─' * len(hdr)}\n  Regime Analysis\n{'─' * len(hdr)}\n{hdr}\n{'─' * len(hdr)}")
    for i, (_, items) in enumerate(groups):
        if i > 0: print(f"  {'─' * 20}")
        for label, s in items:
            if s is None: continue
            print(f"  {label:<22} {s['ann_ret']*100:>8.1f}% {s['ann_vol']*100:>8.1f}%"
                  f" {s['sharpe']:>8.2f} {s['max_dd']*100:>7.1f}% {s['pct_time']*100:>6.1f}%")
    print('─' * len(hdr))


def plot_regime(df, result, title='Regime Analysis', vol_lookback=720, hours_per_year=8760, output_path=os.path.join(tempfile.gettempdir(), 'regime.png')):
    """Bar chart of ann_ret/sharpe/mdd by year, trend regime, volatility regime."""
    plt = _plt()
    raw_groups = _build_regimes(
        result['strat_ret'], df['Close'].values, df.index, result['realized_vol'],
        hours_per_year, vol_lookback,
    )
    chart_groups = {
        name: [(lbl.replace(' (', '\n(', 1), s) for lbl, s in items if s is not None]
        for name, items in raw_groups
    }

    fig, axes = plt.subplots(1, 3, figsize=(16, 6))
    for ax, (group_name, items) in zip(axes, chart_groups.items()):
        labels  = [lbl for lbl, _ in items]
        ann_ret = [s['ann_ret'] * 100 for _, s in items]
        sharpe  = [s['sharpe']        for _, s in items]
        mdd     = [s['max_dd'] * 100  for _, s in items]
        x = np.arange(len(labels)); w = 0.25
        b1 = ax.bar(x - w, ann_ret, w, label='Ann Ret (%)', color='#3498db', alpha=0.85)
        b2 = ax.bar(x,     sharpe,  w, label='Sharpe',      color='#2ecc71', alpha=0.85)
        b3 = ax.bar(x + w, mdd,     w, label='MDD (%)',     color='#e74c3c', alpha=0.85)
        for bars in [b1, b2, b3]:
            for bar in bars:
                h = bar.get_height()
                ax.text(bar.get_x() + bar.get_width() / 2,
                        h + (0.3 if h >= 0 else -1.5),
                        f'{h:.1f}', ha='center',
                        va='bottom' if h >= 0 else 'top', fontsize=8)
        ax.axhline(0, color='#555', lw=0.8)
        ax.set_title(group_name, fontsize=13, fontweight='bold')
        ax.set_xticks(x); ax.set_xticklabels(labels, fontsize=10)
        ax.set_ylabel('Value', fontsize=10); ax.legend(fontsize=9)
        all_vals = ann_ret + sharpe + mdd
        ax.set_ylim(min(all_vals) - 5, max(all_vals) + 8)

    fig.suptitle(title, fontsize=13, fontweight='bold', y=1.01)
    plt.tight_layout()
    plt.savefig(output_path, dpi=150, bbox_inches='tight')
    plt.close()
    print(f'Chart saved: {output_path}')
    return output_path


def plot_pnl(df, result, title='Strategy PnL', output_path=os.path.join(tempfile.gettempdir(), 'pnl.png'), extra_panels=None):
    """Generic 2-panel PnL chart: price+return / drawdown.
    extra_panels: list of dicts [{'data': array, 'label': str, 'color': str, 'hlines': [(y, color, label)]}]
    """
    plt = _plt()
    close  = df['Close'].values
    dates  = df.index
    cum    = result['cum']
    pos    = result['position']
    peak   = np.maximum.accumulate(cum)
    dd     = (cum - peak) / peak

    n_panels = 2 + (len(extra_panels) if extra_panels else 0)
    height_ratios = [3, 1] + [1] * (n_panels - 2)
    fig, axes = plt.subplots(n_panels, 1, figsize=(14, 4 + 2 * n_panels),
                              sharex=True, gridspec_kw={'height_ratios': height_ratios})
    if n_panels == 1:
        axes = [axes]

    # Panel 1: price + strategy return
    ax1 = axes[0]
    ax2 = ax1.twinx()
    ax1.plot(dates, close, color='#3498db', lw=1, alpha=0.7, label='Price')
    ax1.set_ylabel('Price', fontsize=10, color='#3498db')
    ax1.tick_params(axis='y', labelcolor='#3498db')
    ax1.yaxis.set_major_formatter(plt.FuncFormatter(lambda x, _: f'${x:,.0f}'))

    ax2.plot(dates, (cum - 1) * 100, color='#2ecc71', lw=1.5, label='Strategy Return')
    ax2.axhline(0, color='#888', lw=0.5, ls='--')
    ax2.set_ylabel('Return (%)', fontsize=10, color='#2ecc71')
    ax2.tick_params(axis='y', labelcolor='#2ecc71')
    ax2.yaxis.set_major_formatter(plt.FuncFormatter(lambda x, _: f'{x:.0f}%'))

    prev = False
    for i, (date, inp) in enumerate(zip(dates, pos > 0)):
        if inp and not prev: start = date
        if not inp and prev: ax1.axvspan(start, date, alpha=0.08, color='#2ecc71')
        prev = inp
    if prev: ax1.axvspan(start, dates[-1], alpha=0.08, color='#2ecc71')

    lines1, labels1 = ax1.get_legend_handles_labels()
    lines2, labels2 = ax2.get_legend_handles_labels()
    ax1.legend(lines1 + lines2, labels1 + labels2, fontsize=9, loc='upper left')
    ax1.set_title(title, fontsize=12)

    # Panel 2: drawdown
    axes[1].fill_between(dates, dd * 100, 0, color='#e74c3c', alpha=0.6)
    axes[1].set_ylabel('Drawdown (%)', fontsize=10)
    axes[1].yaxis.set_major_formatter(plt.FuncFormatter(lambda x, _: f'{x:.0f}%'))
    axes[1].axhline(0, color='#888', lw=0.5)

    # Extra panels (strategy-specific indicators)
    for i, panel in enumerate(extra_panels or []):
        ax = axes[2 + i]
        ax.plot(dates, panel['data'], color=panel.get('color', '#9b59b6'), lw=0.8, alpha=0.8, label=panel.get('label', ''))
        for hline in panel.get('hlines', []):
            ax.axhline(hline[0], color=hline[1], lw=1, ls='--', label=hline[2] if len(hline) > 2 else None)
        ax.axhline(0, color='#888', lw=0.5)
        ax.set_ylabel(panel.get('label', ''), fontsize=10)
        ax.legend(fontsize=9, loc='upper right')

    plt.tight_layout()
    plt.savefig(output_path, dpi=150)
    plt.close()
    print(f'Chart saved: {output_path}')
    return output_path


# Portfolios per block: T × 50 floats instead of T × n.
_BENCH_BLOCK = 50
# Keeps α > 0 when the strategy holds one name (N=1 → α=0). numpy's small-α Dirichlet
# stays finite here; measured median 1/Σw² ≈ 1.0 at S=20 and ≈ 1.04 at S=1700.
_BENCH_ALPHA_MIN = 1e-4
BENCH_BAND_PCTS = (5, 25, 50, 75, 95)


def held_count(delta_w, w_held):
    """Median number of names held on a rebalance row — a row where count_trades sees a
    trade (|Δw| nonzero at 4 dp); w_held is the weight row in force from that bar on
    (the runner's w_curr). None when the strategy never rebalanced."""
    dw   = np.round(np.nan_to_num(np.asarray(delta_w, dtype=float)), 4)
    rows = (dw != 0).any(axis=1)
    if not rows.any():
        return None
    held = (np.round(np.nan_to_num(np.asarray(w_held, dtype=float))[rows], 4) > 0).sum(axis=1)
    return float(np.median(held))


def bench_alpha(n_held, S):
    """Symmetric Dirichlet concentration whose expected effective holdings (1/E[Σw²])
    equal n_held out of S names: (Sα+1)/(α+1) = N. Capped at 1 — uniform on the
    simplex, the pre-0.1.26 benchmark — from N ≥ (S+1)/2 on, which is also where the
    formula reaches 1; the cap is checked first because N = S divides by zero."""
    if n_held is None or n_held >= (S + 1) / 2:
        return 1.0
    return max((n_held - 1) / (S - n_held), _BENCH_ALPHA_MIN)


def _bench_band(day_eq):
    """benchmark_band from the (days × n) day-end equity of every random portfolio: each
    day's own percentiles across the n paths, not any one portfolio's path. None when a
    value is non-finite or ≤ 0 — the frontend draws nothing rather than a broken band,
    and a raw NaN would make the api refuse the whole strategy (allow_nan=False)."""
    q = np.round(np.percentile(day_eq, BENCH_BAND_PCTS, axis=1), 4)   # (5, days)
    if not np.isfinite(q).all() or (q <= 0).any():
        return None
    return {f'p{p}': q[i].tolist() for i, p in enumerate(BENCH_BAND_PCTS)}


def random_bh_benchmark(close_df, strat_total_ret, strat_sharpe, n=1000, seed=42, bands=True,
                        n_held=None):
    """
    Compare strategy against n random constant-mix portfolios over the whole universe
    (symmetric Dirichlet weights, rebalanced to them every bar, no fees).

    n_held (held_count): the strategy's typical number of names; sets the Dirichlet
    concentration (bench_alpha) so the random portfolios are about as concentrated as
    the strategy. None → α = 1, the pre-0.1.26 draw, bit for bit.

    Portfolios are worked through a block at a time, which also yields
    stats['benchmark_band'] (day-end equity percentiles, one point per calendar day, the
    same days as lib.pnl.daily_returns_typeC). bands=True additionally builds the full
    T × n matrix for the per-bar p5/p50/p95 that only pnl.png draws (returned as
    bench_pct, else None): 2.8 GB RSS for 5 symbols of 5min bars over a year — past a 4 GB
    machine's headroom for a performance refresh that draws no chart.
    """
    daily_ret = close_df.pct_change().fillna(0).values
    S         = daily_ret.shape[1]
    alpha     = bench_alpha(n_held, S)
    W         = np.random.default_rng(seed).dirichlet(np.full(S, alpha), size=n)  # (n, S)
    method    = 'dirichlet_eff_n' if n_held is not None else 'dirichlet_uniform'
    if not np.isfinite(W).all():   # an older numpy's small-α draw can underflow to 0/0
        alpha, method = 1.0, 'dirichlet_uniform'
        W     = np.random.default_rng(seed).dirichlet(np.ones(S), size=n)

    # compute total return and Sharpe for each portfolio using compute_stats
    all_ret_list    = []
    all_sharpe_list = []

    def _one(col):
        s, _, _, _, _ = compute_stats(col, close_df.index)
        equity = np.cumprod(1 + np.nan_to_num(col))
        all_ret_list.append((equity[-1] - 1) * 100)
        all_sharpe_list.append(s)

    # day-end bar of every calendar day, empty days carrying the previous one — the
    # resample daily_returns_typeC applies, so the band lines up with daily_dates
    day_end = (pd.Series(np.arange(len(close_df)), index=close_df.index)
               .resample('1D').last().ffill().astype(int).values)
    day_eq = []
    for lo in range(0, n, _BENCH_BLOCK):
        block = daily_ret @ W[lo:lo + _BENCH_BLOCK].T  # (T, ≤ _BENCH_BLOCK)
        for k in range(block.shape[1]):
            _one(block[:, k])
        day_eq.append(np.cumprod(1 + np.nan_to_num(block), axis=0)[day_end])
    band = _bench_band(np.hstack(day_eq))

    bench_pct = None
    if bands:
        all_equity = np.cumprod(1 + daily_ret @ W.T, axis=0)  # (T, n)
        bench_pct  = pd.DataFrame({
            'p5':  np.percentile(all_equity, 5,  axis=1),
            'p50': np.percentile(all_equity, 50, axis=1),
            'p95': np.percentile(all_equity, 95, axis=1),
        }, index=close_df.index)
    all_ret    = pd.Series(all_ret_list)
    all_sharpe = pd.Series(all_sharpe_list)

    pct_ret    = float((all_ret    < strat_total_ret).mean() * 100)
    pct_sharpe = float((all_sharpe < strat_sharpe).mean()    * 100)

    print(f"\n── Random portfolio benchmark (n={n}, alpha={alpha:.4g}) ──")
    print(f"  Total Return  median={all_ret.median():.1f}%  "
          f"p5={all_ret.quantile(.05):.1f}%  p95={all_ret.quantile(.95):.1f}%")
    print(f"  Sharpe        median={all_sharpe.median():.2f}  "
          f"p5={all_sharpe.quantile(.05):.2f}  p95={all_sharpe.quantile(.95):.2f}")
    print(f"  Strategy beats {pct_ret:.0f}% on Return, {pct_sharpe:.0f}% on Sharpe")

    stats = {
        'benchmark_n':                   n,
        'benchmark_method':              method,
        'benchmark_eff_n':               None if n_held is None else round(float(n_held), 1),
        'benchmark_median_ret_%':        round(float(all_ret.median()),         2),
        'benchmark_p5_ret_%':            round(float(all_ret.quantile(.05)),    2),
        'benchmark_p95_ret_%':           round(float(all_ret.quantile(.95)),    2),
        'benchmark_median_sharpe':       round(float(all_sharpe.median()),      3),
        'benchmark_strategy_ret_pct':    round(pct_ret,    1),
        'benchmark_strategy_sharpe_pct': round(pct_sharpe, 1),
    }
    if band is not None:
        stats['benchmark_band'] = band
    return stats, bench_pct



def bh_benchmark(bench_close, close_df, kind, symbol, adjusted=True):
    """Buy-and-hold of one benchmark series over the strategy's own bars: bought at the first
    bar's close, held to the last, no fees (the stats say so). bench_close is the benchmark's
    Close — adjusted (dividends) unless `adjusted` says otherwise; it is carried forward onto close_df.index, so a day the benchmark did not
    trade (a split halt) is flat. series is the day-end equity multiple (1.0 at the start) per
    calendar day, the days of lib.pnl.daily_returns_typeC — the benchmark_band contract.
    Returns (stats, per-bar equity Series for pnl.png); (None, None) when the benchmark has no
    price on or before the first bar."""
    s = pd.Series(bench_close, dtype=float)
    s = s[np.isfinite(s) & (s > 0)].sort_index()
    idx = close_df.index
    if idx.tz is not None and s.index.tz is None:
        s.index = s.index.tz_localize(idx.tz)
    if s.empty or s.index[0] > idx[0]:
        return None, None
    px = s.reindex(s.index.union(idx)).ffill().reindex(idx).values
    ret = np.zeros(len(px))
    ret[1:] = px[1:] / px[:-1] - 1
    _, _, _, mdd, ann = compute_stats(ret, idx)
    equity = px / px[0]
    day_end = (pd.Series(np.arange(len(idx)), index=idx)
               .resample('1D').last().ffill().astype(int).values)
    stats = {'kind': kind, 'symbol': symbol, 'adjusted': adjusted, 'fee_pct': 0,
            'ret_pct':  round(float(equity[-1] - 1) * 100, 2),
            'cagr_pct': round(float(ann) * 100, 2) if math.isfinite(ann) else None,
            'mdd_pct':  round(float(mdd) * 100, 2),
            'series':   np.round(equity[day_end], 4).tolist()}
    return stats, pd.Series(equity, index=idx)


def plot_pnl_portfolio(pf_ret, close_df, title='Portfolio PnL', output_path=os.path.join(tempfile.gettempdir(), 'pnl.png'),
                       bench_pct=None, bench_line=None, bench_label=None):
    """2-panel PnL chart for Type C strategies. bench_pct: DataFrame with p5/p50/p95 columns;
    bench_line: a buy-and-hold equity Series over the same bars."""
    plt = _plt()
    pf_equity = np.cumprod(1 + pf_ret.values)
    dd  = pf_equity / np.maximum.accumulate(pf_equity) - 1
    idx = close_df.index

    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(14, 9),
                                    gridspec_kw={'height_ratios': [3, 1]}, sharex=True)

    if bench_pct is not None:
        b = bench_pct.reindex(idx, method='ffill')
        ax1.fill_between(idx, b['p5'], b['p95'], color='#9E9E9E', alpha=0.2, label='Random p5–p95')
        ax1.plot(idx, b['p50'], color='#9E9E9E', linewidth=1, linestyle='--', label='Random median')

    if bench_line is not None:
        ax1.plot(idx, bench_line.reindex(idx).values, color='#9E9E9E', linewidth=1.2,
                 linestyle='--', label=bench_label)
    ax1.plot(idx, pf_equity, color='#2196F3', linewidth=2, label=title)
    ax1.set_ylabel('Portfolio Value')
    ax1.legend(fontsize=9)
    ax1.grid(alpha=0.3)
    ax1.set_title(title)

    ax2.fill_between(idx, dd, 0, color='#2196F3', alpha=0.4)
    ax2.set_ylabel('Drawdown')
    ax2.grid(alpha=0.3)

    plt.tight_layout()
    plt.savefig(output_path, dpi=150)
    plt.close()
    print(f'Chart saved: {output_path}')
    return output_path


def plot_candlestick(df, title='走勢圖', output_path=os.path.join(tempfile.gettempdir(), 'candlestick.png'),
                     n_xticks=10, extra_lines=None):
    """
    Candlestick + volume chart using integer index so all bar widths are in the same unit.

    df must have columns: Open, High, Low, Close, Volume (case-sensitive).
    extra_lines: list of dicts [{'data': array, 'label': str, 'color': str}] — overlaid on price panel.
    """
    plt = _plt()
    xs      = np.arange(len(df))
    opens   = df['Open'].values
    highs   = df['High'].values
    lows    = df['Low'].values
    closes  = df['Close'].values
    volumes = df['Volume'].values if 'Volume' in df.columns else None

    up_mask   = closes >= opens
    up_color  = '#26a69a'
    dn_color  = '#ef5350'

    # minimum visible size = 1.5%/0.8% of full y-range → every candle readable regardless of zoom
    y_range    = float(highs.max() - lows.min()) or 1.0
    min_shadow = y_range * 0.015
    min_body   = y_range * 0.008

    n_panels       = 2 if volumes is not None else 1
    height_ratios  = [3, 1] if n_panels == 2 else [1]
    fig, axes = plt.subplots(n_panels, 1, figsize=(14, 6 + 2 * (n_panels - 1)),
                              sharex=True, gridspec_kw={'height_ratios': height_ratios})
    if n_panels == 1:
        axes = [axes]
    ax_price = axes[0]

    locked = (highs == lows)
    line_h = y_range * 0.002  # 一字線高度

    # shadows: locked → skip; up-day → pin top=high; down-day → pin bottom=low
    raw_shadow     = highs - lows
    shadow_heights = np.maximum(raw_shadow, min_shadow)
    shadow_bottoms = np.where(up_mask, highs - shadow_heights, lows)
    shadow_colors  = np.where(up_mask, up_color, dn_color)
    for i in xs:
        if locked[i]:
            continue
        ax_price.bar(i, shadow_heights[i], bottom=shadow_bottoms[i],
                     width=0.08, color=shadow_colors[i], linewidth=0)

    # bodies: locked → thin 一字線 centered on price; up-day → pin top=close; down-day → pin bottom=close
    raw_body     = np.abs(closes - opens)
    body_heights = np.maximum(raw_body, min_body)
    body_bottoms = np.where(up_mask, closes - body_heights, closes)
    body_colors  = np.where(up_mask, up_color, dn_color)
    for i in xs:
        if locked[i]:
            ax_price.bar(i, line_h, bottom=closes[i] - line_h / 2,
                         width=0.6, color=body_colors[i], linewidth=0)
        else:
            ax_price.bar(i, body_heights[i], bottom=body_bottoms[i],
                         width=0.4, color=body_colors[i], linewidth=0)

    # optional overlay lines (e.g. MA)
    for line in (extra_lines or []):
        ax_price.plot(xs, line['data'], color=line.get('color', '#FF9800'),
                      lw=1, label=line.get('label', ''), alpha=0.85)
    if extra_lines:
        ax_price.legend(fontsize=9, loc='upper left')

    ax_price.set_title(title, fontsize=12)
    ax_price.set_ylabel('Price', fontsize=10)
    ax_price.grid(alpha=0.2)

    # volume panel
    if volumes is not None:
        ax_vol = axes[1]
        vol_colors = np.where(up_mask, up_color, dn_color)
        for i in xs:
            ax_vol.bar(i, volumes[i], width=0.8, color=vol_colors[i], alpha=0.7, linewidth=0)
        ax_vol.set_ylabel('Volume', fontsize=9)
        ax_vol.grid(alpha=0.2)

    # x-axis: replace integer index with HH:MM (or MM/DD) time labels
    tick_step = max(1, len(xs) // n_xticks)
    tick_pos  = xs[::tick_step]
    timestamps = df.index[::tick_step]
    # daily data: all times are midnight → use MM/DD; intraday: use HH:MM
    all_midnight = all(getattr(t, 'hour', 0) == 0 and getattr(t, 'minute', 0) == 0
                       for t in df.index)
    if all_midnight:
        tick_labels = [t.strftime('%m/%d') for t in timestamps]
    else:
        tick_labels = [t.strftime('%H:%M') for t in timestamps]
    axes[-1].set_xticks(tick_pos)
    axes[-1].set_xticklabels(tick_labels, fontsize=8, rotation=30, ha='right')

    plt.tight_layout()
    plt.savefig(output_path, dpi=150, bbox_inches='tight')
    plt.close()
    print(f'Chart saved: {output_path}')
    return output_path
