"""Sample strategies for the parity matrix that examples/ does not cover. Each kind is the
smallest strategy that exercises one code path of the live tick; the signal logic is an SMA
cross (or a momentum rank for Type C) so positions actually flip inside a short bar window.

    python samples.py <kind> <out_dir> [--symbol S] [--symbols A,B] [--interval I] [--start D]
                      [--schema S] [--fast N] [--slow N] [--rebalance W|D|bar]

kinds
  a_sma          Type A crypto, fetch_kline (BTCUSDT 1m/5min/1h/1d — interval is a parameter)
  a_sma_txf      Type A 台指期, fetch_twfutures_ohlcv + txf_settlement_mask + vol scaling, like
                 examples/txf_ma_1m but with the windows scaled to the schema
  c_mom          Type C crypto, N symbols via fetch_kline, momentum top-1 weight ≤ 1
  c_tw_mom       Type C 台股, fetch_twstock_price_adj_batch (the _fetch_batch_cached path), same signal
  a_pandas_top   a_sma with `import pandas / numpy` at module top level (the user-written shape
                 wait_for_bar's fast path pays for on every minute)
  a_legacy_norun Type A that never calls lib.runner.run(): its own __main__ fetches, computes and
                 writes state.json through lib.execute — the "old strategy" wait_for_bar must
                 keep on the probe-then-run path
"""
import argparse
import os
import re

_HEADER = '''# Strategy: {title}
# Type:     {type_line}
# Symbol:   {symbol}
# Interval: {interval}
# Logic:    signal_parity sample — {logic}

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))
'''

_A_SMA = _HEADER + '''{top_imports}
STRATEGY_NAME = "{name}"
SYMBOL        = "{symbol}"
INTERVAL      = "{interval}"
START         = "{start}"
END           = None
FEE           = 0.0005
MARKET        = "swap"

SMA_FAST = {fast}
SMA_SLOW = {slow}
WARMUP   = SMA_SLOW
{top_extra}

def _add_indicators(df, fast=SMA_FAST, slow=SMA_SLOW):
    df = df.copy()
    df['SMA_F'] = df['Close'].rolling(fast).mean()
    df['SMA_S'] = df['Close'].rolling(slow).mean()
    return df


def fetch_data(hdrs):
    from lib.data import fetch_kline
    return _add_indicators(fetch_kline(SYMBOL, INTERVAL, START, END, hdrs))


def compute_signals(df, fast=SMA_FAST, slow=SMA_SLOW):
    import pandas as pd, numpy as np
    df     = _add_indicators(df, fast, slow)
    signal = pd.Series(np.nan, index=df.index)
    signal[df['SMA_F'] > df['SMA_S']] = 1.0
    signal[df['SMA_F'] < df['SMA_S']] = 0.0
    return signal


if __name__ == '__main__':
    from lib.runner import run
    from lib.notify import make_sender
    run(locals(), fetch_data, compute_signals, make_sender())
'''

_A_LEGACY_MAIN = '''
if __name__ == '__main__':
    # No lib.runner.run(): the shape of an agent-written strategy from before the runner
    # existed — fetch, compute, write the last signal to state.json by hand.
    from dotenv import dotenv_values
    from lib.execute import load_state, update_state, save_state
    env  = dotenv_values()
    hdrs = {'api-key': env.get('blave_api_key', ''), 'secret-key': env.get('blave_secret_key', '')}
    df     = fetch_data(hdrs).iloc[WARMUP:]
    signal = compute_signals(df).ffill().fillna(0)
    t, r   = df.index[-1], df.iloc[-1]
    candle = {'time': int(t.timestamp()), 'close': float(r['Close']), 'open': float(r['Open']),
              'high': float(r['High']), 'low': float(r['Low'])}
    state  = load_state(STRATEGY_NAME) or {'position': float(signal.iloc[-1])}
    update_state(candle, float(signal.iloc[-1]), state, 'live', symbol=SYMBOL)
    save_state(STRATEGY_NAME, state)
'''

_A_TXF = _HEADER + '''
STRATEGY_NAME = "{name}"
SYMBOL        = "{symbol}"
INTERVAL      = "{interval}"
START         = "{start}"
END           = None
FEE           = 0.00005

SMA_FAST   = {fast}
SMA_SLOW   = {slow}
VOL_WINDOW = {vol_window}
WARMUP     = max(SMA_SLOW, VOL_WINDOW)


def _add_indicators(df, fast=SMA_FAST, slow=SMA_SLOW):
    df = df.copy()
    df['SMA_F'] = df['Close'].rolling(fast).mean()
    df['SMA_S'] = df['Close'].rolling(slow).mean()
    return df


def fetch_data(hdrs):
    from lib.data import fetch_twfutures_ohlcv
    from lib.strategy import add_realized_vol
    df = fetch_twfutures_ohlcv(SYMBOL, '{schema}', START, END, hdrs)
    add_realized_vol(df, lookback=VOL_WINDOW, periods_per_year={periods_per_year})
    return _add_indicators(df)


def compute_signals(df, fast=SMA_FAST, slow=SMA_SLOW):
    import pandas as pd, numpy as np
    from lib.data import txf_settlement_mask
    from lib.strategy import apply_vol_scaling
    df     = _add_indicators(df, fast, slow)
    signal = pd.Series(np.nan, index=df.index)
    signal[df['SMA_F'] > df['SMA_S']] = 1.0
    signal[df['SMA_F'] < df['SMA_S']] = 0.0
    settle = txf_settlement_mask(df.index)
    signal[settle] = 0.0
    signal = apply_vol_scaling(signal, df)
    return signal, settle


if __name__ == '__main__':
    from lib.runner import run
    from lib.notify import make_sender
    run(locals(), fetch_data, compute_signals, make_sender())
'''

_C_MOM = _HEADER + '''
STRATEGY_NAME = "{name}"
INTERVAL      = "{interval}"
START         = "{start}"
END           = None
FEE           = {fee}
MARKET        = "{market}"

UNIVERSE       = {symbols!r}
MOM_WINDOW     = {fast}
REBALANCE_FREQ = "{rebalance}"   # 'W' / 'D' / 'bar' (every bar)
WARMUP         = MOM_WINDOW

{fetch_block}


def _rebalance_mask(idx, freq):
    import numpy as np, pandas as pd
    if freq == 'bar':
        return np.ones(len(idx), dtype=bool)
    s = pd.Series(idx.to_period(freq), index=idx)
    return (s != s.shift(1)).to_numpy()


def compute_signals(data, window=MOM_WINDOW):
    import numpy as np, pandas as pd
    close_df, open_df = data
    mom  = close_df.pct_change(window, fill_method=None)
    rank = mom.rank(axis=1, ascending=False, method='first', na_option='bottom')
    w = pd.DataFrame(np.where((rank <= 1) & mom.notna(), 1.0, 0.0), index=mom.index, columns=mom.columns)
    w[~_rebalance_mask(close_df.index, REBALANCE_FREQ)] = np.nan
    w = w.ffill().fillna(0.0)
    return w.values, pd.concat({{'close': close_df, 'open': open_df}}, axis=1)


if __name__ == '__main__':
    from lib.runner import run
    from lib.notify import make_sender
    run(locals(), fetch_data, compute_signals, make_sender())
'''

_C_FETCH_CRYPTO = '''
def fetch_data(hdrs):
    import pandas as pd
    from lib.data import fetch_kline
    closes, opens = {}, {}
    for s in UNIVERSE:
        df = fetch_kline(s, INTERVAL, START, END, hdrs)
        closes[s], opens[s] = df['Close'], df['Open']
    close_df = pd.DataFrame(closes).sort_index().dropna(how='all')
    return close_df, pd.DataFrame(opens).reindex(close_df.index)
'''

# the batch path (_fetch_batch_cached): cached ids are served from the cut cache, uncached ones
# would need the network and fail the tick with BatchIncomplete
_C_FETCH_TW = '''
def fetch_data(hdrs):
    import pandas as pd
    from lib.data import fetch_twstock_price_adj_batch
    price_all = fetch_twstock_price_adj_batch(UNIVERSE, START, END, hdrs)
    closes = {s: p['Close'] for s, p in price_all.items() if p is not None and not p.empty}
    close_df = pd.DataFrame(closes).sort_index().dropna(how='all')
    opens = {s: price_all[s]['Open'] for s in closes}
    return close_df, pd.DataFrame(opens).reindex(close_df.index)
'''

# minute bars per TXF trading day (05:00 session + 15:00 session ≈ 300 + 840) — vol window and
# annualisation follow the schema the way examples/txf_ma_1m does for 1m
_TXF_BARS_PER_DAY = {'1m': 1140, '5m': 228, '15m': 76, '30m': 38, '60m': 19, '1d': 1}

# twenty large caps from examples/twstock_momentum's universe (all in the local cache)
_TW_UNIVERSE = ['2330', '2317', '2454', '2308', '2382', '2881', '2882', '1301', '1303', '2002',
                '2412', '2603', '1216', '2891', '3711', '2357', '2303', '2886', '2884', '5880']

KINDS = ('a_sma', 'a_sma_txf', 'c_mom', 'c_tw_mom', 'a_pandas_top', 'a_legacy_norun')


def make(kind, out_dir, symbol=None, symbols=None, interval=None, start=None, schema=None,
         fast=None, slow=None, rebalance='W', name=None):
    if kind not in KINDS:
        raise ValueError(f"unknown sample kind {kind!r}; one of {KINDS}")
    if kind in ('a_sma', 'a_pandas_top', 'a_legacy_norun'):
        symbol, interval = symbol or 'BTCUSDT', interval or '1h'
        name = name or f"sp_{kind}_{symbol.lower()}_{interval}"
        fast, slow = fast or 10, slow or 30
        top_imports, top_extra, main = '', '', None
        if kind == 'a_pandas_top':
            top_imports = '\nimport pandas as pd\nimport numpy as np\n'
            top_extra = "\nPARAMS = pd.Series({'fast': SMA_FAST, 'slow': SMA_SLOW})   # module-level pandas use\n"
        src = _A_SMA.format(title=name, type_line='A (single symbol, signal-based)', symbol=symbol,
                            interval=interval, logic='SMA cross', top_imports=top_imports,
                            top_extra=top_extra, name=name, start=start or '2024-01-01',
                            fast=fast, slow=slow)
        if kind == 'a_legacy_norun':
            src = src[:src.index("if __name__ == '__main__':")] + _A_LEGACY_MAIN.lstrip('\n')
    elif kind == 'a_sma_txf':
        symbol, schema = symbol or 'TXF', schema or interval or '1m'
        interval = interval or schema
        name = name or f"sp_a_sma_txf_{schema}"
        per_day = _TXF_BARS_PER_DAY.get(schema, 1)
        fast, slow = fast or 5 * per_day, slow or 20 * per_day
        src = _A_TXF.format(title=name, type_line='A (single symbol, signal-based)', symbol=symbol,
                            interval=interval, logic='SMA cross + settlement flat + vol scaling',
                            name=name, start=start or '2024-01-01', fast=fast, slow=slow,
                            vol_window=30 * per_day, schema=schema,
                            periods_per_year=252 * per_day)
    else:  # c_mom / c_tw_mom
        tw = kind == 'c_tw_mom'
        symbols = symbols or (_TW_UNIVERSE if tw else ['BTCUSDT', 'ETHUSDT'])
        interval = interval or '1d'
        name = name or f"sp_{kind}_{interval}"
        src = _C_MOM.format(title=name, type_line='C (multi-asset, weight-based)',
                            symbol=','.join(symbols), interval=interval,
                            logic='momentum top-1, weight 1.0', name=name,
                            start=start or '2024-01-01', symbols=list(symbols),
                            fee=0.003 if tw else 0.0005, market='twstock' if tw else 'swap',
                            fetch_block=(_C_FETCH_TW if tw else _C_FETCH_CRYPTO).strip('\n'),
                            fast=fast or 20, rebalance=rebalance)
    d = os.path.join(out_dir, name)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, 'strategy.py'), 'w', encoding='utf-8') as f:
        f.write(src)
    return d


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('kind', choices=KINDS)
    ap.add_argument('out_dir')
    ap.add_argument('--symbol')
    ap.add_argument('--symbols', help='comma-separated, c_mom / c_tw_mom only')
    ap.add_argument('--interval')
    ap.add_argument('--start')
    ap.add_argument('--schema', help='a_sma_txf: 1m/5m/15m/30m/60m/1d (defaults to --interval)')
    ap.add_argument('--fast', type=int)
    ap.add_argument('--slow', type=int)
    ap.add_argument('--rebalance', default='W')
    ap.add_argument('--name')
    a = ap.parse_args()
    d = make(a.kind, a.out_dir, symbol=a.symbol, interval=a.interval, start=a.start, schema=a.schema,
             fast=a.fast, slow=a.slow, rebalance=a.rebalance, name=a.name,
             symbols=[s for s in re.split(r'[,\s]+', a.symbols) if s] if a.symbols else None)
    print(d)


if __name__ == '__main__':
    main()
