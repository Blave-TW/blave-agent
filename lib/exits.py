"""Exits layered on top of a strategy's own signal: stop-loss, take-profit, trailing stop,
time stop — and the spot long-only clamp. Tests: tests/check_exits.py.

Why a lib function and not a recipe: a hand-written exit loop that exits and then re-checks
the entry *state* on the same bar re-enters at once, and the stop silently does nothing
(2026-09-23, e2e_0923_ma: 0 of 8,770 bars changed).
"""
import logging

import numpy as np
import pandas as pd


def apply_exits(signal, df, stop_pct=None, tp_pct=None, trail_pct=None, max_bars=None, trigger="close"):
    """Position Series = `signal` with the given exits applied. Give at least one exit.

    stop_pct  : exit once the trade is down this fraction from its fill   (0.03 = 3%)
    tp_pct    : exit once the trade is up this fraction from its fill
    trail_pct : exit once the trade gives back this fraction from its best price
    max_bars  : exit after holding this many valid bars (1 = hold one bar)
    trigger   : "close"    — a level counts only when a bar CLOSES beyond it;
                "intrabar" — it counts when the bar's Low / High touches it (needs High and Low).

    Fill — the runner has two fill points, the next bar's Open and (exec_at_close) this bar's
    Close; it cannot fill at a stop price. So in BOTH modes the exit is the position going flat
    at the next bar's Open. In "intrabar" mode that is the honest approximation of a stop order:
    the trigger bar is held to its close and the exit fills at the next Open, which can be better
    or worse than the level. This is also what live does — a tick reads the finished bar, sees
    its Low, and exits at the next bar; no resting stop order is placed. Where a real order would
    have filled (the level, or the Open when the bar gapped through it) is recorded per exit in
    `result.attrs["exits"]` (a DataFrame: time, reason, order_price) so the difference can be
    reported, never passed off as the fill.

    One bar touching both the stop and the take-profit ("intrabar"): if the bar OPENED beyond
    one of them, that one fired first at the Open; otherwise the stop is assumed to have fired
    first (the order inside a bar is unknown, so the losing side is assumed). Priority when
    several exits fire on one bar: stop, trailing, time, take-profit. The position series is
    the same whichever fired; only `attrs["exits"]` says which. Trailing ("intrabar"): the
    bar's adverse extreme is tested against the best price BEFORE this bar, then the best is
    raised by this bar's favourable extreme — no same-bar high-then-low is assumed.

    Always:
    - Levels are measured from the fill (the next valid bar's Open; the last valid Close when
      that Open is NaN or <= 0).
    - After any exit the position stays flat until the base signal changes side (leaves that
      side and takes it again, or flips) — never a same-bar re-entry.
    - A bar the runner drops (Close NaN or <= 0) changes nothing and is not counted. A NaN or
      <= 0 High / Low on a valid bar falls back to that bar's Close.
    - With an `instrument_id` column, a contract roll mid-trade keeps the old contract's move
      and re-bases on the new contract's first Open — the gap between contracts is treated
      as roll spread, not as gain or loss. A continuous series with no `instrument_id` sees a
      roll as an ordinary price move.
    - A size change on the same side (vol scaling) is the same trade: fill, best and the bar
      count carry on. Shorts are measured with the sign flipped.
    Output has no NaN: 0.0 while flat, the base value while holding.
    """
    for name, v in (("stop_pct", stop_pct), ("tp_pct", tp_pct), ("trail_pct", trail_pct)):
        if v is not None and not (isinstance(v, (int, float)) and 0 < v < 10):
            raise ValueError(f"{name} must be a positive fraction (0.03 = 3%), got {v!r}")
    if max_bars is not None and not (isinstance(max_bars, (int, np.integer)) and max_bars >= 1):
        raise ValueError(f"max_bars must be a whole number of bars >= 1, got {max_bars!r}")
    if stop_pct is None and tp_pct is None and trail_pct is None and max_bars is None:
        raise ValueError("apply_exits needs at least one of stop_pct / tp_pct / trail_pct / max_bars")
    if trigger not in ("close", "intrabar"):
        raise ValueError(f'trigger must be "close" or "intrabar", got {trigger!r}')
    intrabar = trigger == "intrabar"
    if intrabar and not {'High', 'Low'} <= set(df.columns):
        raise ValueError('trigger="intrabar" needs High and Low columns in df')

    base = pd.Series(signal, dtype=float).ffill().fillna(0.0).to_numpy()
    opn = df['Open'].to_numpy(dtype=float)
    close = df['Close'].to_numpy(dtype=float)
    high = df['High'].to_numpy(dtype=float) if intrabar else close
    low = df['Low'].to_numpy(dtype=float) if intrabar else close
    inst = df['instrument_id'].to_numpy() if 'instrument_id' in df.columns else None
    index = getattr(signal, 'index', df.index)
    if not (len(base) == len(opn)):
        raise ValueError(f"signal has {len(base)} bars, df has {len(opn)}")

    def ok(x):
        return np.isfinite(x) and x > 0

    out = np.zeros(len(base))
    exits = []
    held, stopped, pending, last = 0.0, False, False, None
    entry = acc = best = np.nan
    bars = 0
    for t in range(len(base)):
        if not ok(close[t]):
            out[t] = held
            continue
        fill = opn[t] if ok(opn[t]) else close[last if last is not None else t]
        side = np.sign(held)
        if pending:
            entry, acc, best, bars, pending = fill, 1.0, 1.0, 0, False
        elif side and inst is not None and inst[t] != inst[last]:
            acc, entry = acc * close[last] / entry, fill
        if side and not stopped:
            k = acc / entry                         # price → trade ratio since the fill, roll-adjusted
            hi = high[t] if ok(high[t]) else close[t]
            lo = low[t] if ok(low[t]) else close[t]
            adverse, favour = (lo, hi) if side > 0 else (hi, lo)
            bars += 1

            def hit_at(pct):                        # price of a level `pct` from the fill (+ = favourable)
                return (1 + pct * side) / k

            def beyond(price, pct):                 # price at or past that level
                return ((price * k - 1) * side - pct) * np.sign(pct) >= 0

            reason = level = None
            o = fill if bars == 1 else (opn[t] if ok(opn[t]) else close[t])   # a gap fills here
            if intrabar:
                if stop_pct is not None and beyond(o, -stop_pct):
                    reason, level = "stop", o
                elif tp_pct is not None and beyond(o, tp_pct):
                    reason, level = "tp", o
            if reason is None and stop_pct is not None and beyond(adverse, -stop_pct):
                reason, level = "stop", hit_at(-stop_pct)
            if reason is None and trail_pct is not None:
                ref = adverse if intrabar else close[t]
                b = best if intrabar else (max(best, close[t] * k) if side > 0 else min(best, close[t] * k))
                if (ref * k / b - 1) * side <= -trail_pct:
                    reason, level = "trail", b * (1 - trail_pct * side) / k
                    if (o - level) * side < 0:
                        level = o
            if reason is None and max_bars is not None and bars >= max_bars:
                reason, level = "time", None
            if reason is None and tp_pct is not None and beyond(favour, tp_pct):
                reason, level = "tp", hit_at(tp_pct)
            best = max(best, favour * k) if side > 0 else min(best, favour * k)
            if reason is not None:
                stopped = True
                exits.append({"time": index[t], "reason": reason,
                              "order_price": float(level) if (intrabar and level is not None) else None})
        if stopped and np.sign(base[t]) != np.sign(base[last]):
            stopped = False
        want = 0.0 if stopped else base[t]
        if np.sign(want) != side:
            pending = bool(want)
        out[t], held, last = want, want, t
    res = pd.Series(out, index=index)
    # a DataFrame, not a list: pandas deep-copies attrs on every operation on the Series
    res.attrs["exits"] = pd.DataFrame(exits, columns=["time", "reason", "order_price"])
    return res


def clamp_spot(signal, market):
    """Spot cannot short: negative values → 0.0 when `market` is "spot"; anything else is returned
    unchanged. Live already does this at the portfolio (lib/portfolio.py, spot net target < 0 →
    flat, loudly), so the backtest must too or it books short profits that can never be traded."""
    if market != 'spot':
        return signal
    neg = signal < 0
    n = int(np.count_nonzero(np.asarray(neg, dtype=bool)))
    if not n:
        return signal
    msg = (f"MARKET is spot but compute_signals returned {n} short bar(s) — clamped to flat "
           f"(spot cannot short). Make compute_signals long-only: signal.clip(lower=0.0).")
    logging.warning(msg)
    print(f"  ⚠️  {msg}")
    return signal.where(~neg, 0.0)
