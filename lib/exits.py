"""Exits layered on top of a strategy's own signal: stop-loss, take-profit, trailing stop,
time stop, breakeven move, re-entry cooldown, a stop / take-profit at the strategy's own price
level — and the spot long-only clamp.
Tests: tests/check_exits.py, tests/check_exit_levels.py.

Why a lib function and not a recipe: a hand-written exit loop that exits and then re-checks
the entry *state* on the same bar re-enters at once, and the stop silently does nothing
(2026-09-23, e2e_0923_ma: 0 of 8,770 bars changed).
"""
import logging
import warnings

import numpy as np
import pandas as pd

# exit names already warned about: one RuntimeWarning per process, a scan calls apply_exits hundreds of times
_unarmed_warned = set()
_level_warned = set()


def _warn_level_once(key, msg, stacklevel=3):
    if key not in _level_warned:
        _level_warned.add(key)
        warnings.warn(msg, RuntimeWarning, stacklevel=stacklevel)


def _sides(name, v):
    # one value for both sides, or a (long, short) tuple — None switches that side off
    if isinstance(v, tuple):
        if len(v) != 2:
            raise ValueError(f"{name}: a tuple must be (long, short), got {v!r}")
        return v
    return v, v


def _distance(name, v, df, n):
    if v is None:
        return None
    if isinstance(v, (int, float, np.integer, np.floating)) and not isinstance(v, bool):
        if not (np.isfinite(v) and v > 0):
            raise ValueError(f"{name} must be a positive price distance, got {v!r}")
        return np.full(n, float(v))
    if isinstance(v, pd.Series) and not v.index.equals(df.index):
        raise ValueError(f"{name} must have df's index (build it from df's own columns)")
    arr = np.asarray(v, dtype=float)
    if arr.shape != (n,):
        raise ValueError(f"{name} must be one price distance per bar of df ({n}), got shape {arr.shape}")
    return arr


def _level(name, v, df, n, nonpos):
    if v is None:
        return None
    if not isinstance(v, (pd.Series, np.ndarray)):
        raise ValueError(f"{name} must be a price Series on df's index (NaN = no level on that bar), got {v!r}")
    if isinstance(v, pd.Series) and not v.index.equals(df.index):
        raise ValueError(f"{name} must have df's index (build it from df's own columns)")
    arr = np.asarray(v, dtype=float)
    if arr.shape != (n,):
        raise ValueError(f"{name} must be one price per bar of df ({n}), got shape {arr.shape}")
    arr = np.where(np.isfinite(arr), arr, np.nan)
    # Low - k*ATR can dip below zero on a crash bar that only exists live: raising there would
    # stop every tick with the position left as it is, so that bar just has no level
    bad = arr <= 0
    if bad.any():
        arr = np.where(bad, np.nan, arr)
        nonpos.append((name, int(bad.sum())))
    return arr


def apply_exits(signal, df, stop_pct=None, tp_pct=None, trail_pct=None, max_bars=None, trigger="close", *,
                stop_dist=None, tp_dist=None, trail_dist=None,
                breakeven_at=None, breakeven_dist=None, cooldown_bars=None,
                stop_level=None, tp_level=None):
    """Position Series = `signal` with the given exits applied. Give at least one exit.

    stop_pct  : exit once the trade is down this fraction from its fill   (0.03 = 3%)
    tp_pct    : exit once the trade is up this fraction from its fill
    trail_pct : exit once the trade gives back this fraction from its best price
    max_bars  : exit after holding this many valid bars (1 = hold one bar)
    trigger   : "close"    — a level counts only when a bar CLOSES beyond it;
                "intrabar" — it counts when the bar's Low / High touches it (needs High and Low).

    Keyword-only:
    stop_dist / tp_dist / trail_dist : the same three exits with the distance given in PRICE
                units instead of a fraction — a Series on df's index (`2 * atr`, `Close - prior
                low`) or one number (50 = 50 points). The lib never computes an indicator; the
                strategy passes the distance. Give `*_pct` or `*_dist` for one exit, not both.
    breakeven_at / breakeven_dist : once the trade has been up this fraction / price distance,
                a stop sits at the fill price (reason "breakeven").
    cooldown_bars : after an exit (any reason), if the base signal is still on that side, enter
                again once the position has been flat this many valid bars (>= 1). Not given:
                flat until the base signal changes side, as below.
    stop_level / tp_level : the strategy's own absolute PRICE level, a Series on df's index, NaN =
                no level on that bar — a stop that moves to the latest signal bar's low, set per
                trade: `df['Low'].where(entry | event).ffill().where(on)` (the entry bar is an
                event, NaN while flat — a plain `where(event).ffill()` carries the previous
                trade's low into the next), a take-profit at a signal bar's high. Only while a
                trade is open: a long exits when its Low (Close in "close") reaches stop_level or
                its High reaches tp_level; a short the other way round. Reasons "stop_level" /
                "tp_level". stop_level is the trade's whole stop: with stop_pct, stop_dist,
                breakeven_at or breakeven_dist it raises, and so does tp_level with tp_pct /
                tp_dist; trail_* and max_bars combine with it as with stop_pct. With
                cooldown_bars: a cooldown that ends with the Close at or past the level that would
                apply (a long's Close <= stop_level or >= tp_level) does not re-enter until that
                level takes another non-NaN value or the base signal changes side.
    Long and short may differ: every exit above (not `trigger`, not `cooldown_bars`) also takes
    a `(long, short)` tuple; `None` in it switches that side off — `stop_pct=(0.03, 0.05)`,
    `tp_dist=(3 * atr, None)`.

    Distances — which bar's value is used (never one the trade could not have known):
    - stop_dist / tp_dist / breakeven_dist are read ONCE per trade, on the signal bar (the last
      valid bar before the fill), divided by the fill price, and held as that trade's own
      fraction from then on. The indicator moving afterwards does not move the level, and a
      roll re-bases it exactly like a `*_pct` level. The level is fill ∓ distance: when the fill
      Open gaps away from the signal bar's Close, a structural level (the prior low) shifts by
      that gap.
    - trail_dist is read every bar (chandelier): bar t is tested with the value on the last
      valid bar before t; a NaN / <= 0 reading keeps the trade's previous one.
    - A distance that is NaN or <= 0 on the signal bar (or puts the level at or below zero)
      leaves that exit OFF for that trade (trailing: off until its first valid reading) — the
      other exits still run. Each such trade is a row in `result.attrs["exits_unarmed"]`
      (time = its fill bar, exit, dist) on every call; a RuntimeWarning says so once per
      process and exit. The usual cause is an entry inside the indicator's warm-up.
    - stop_level / tp_level are read every bar like trail_dist: bar t is tested with the value
      on the last valid bar before t — do not shift the Series yourself. NaN there = no level
      on bar t (ffill the Series to keep one), never "unarmed"; a level <= 0 counts as NaN
      (RuntimeWarning once). A trade with NaN on more than half its bars (a one-bar trade
      included) is a row in `result.attrs["exits_level_gaps"]` (time = its fill bar, exit,
      bars, nan_bars) + a RuntimeWarning once. The level is a price, not a distance: a gap does
      not shift it, a fill already beyond it (gap through, a level set on the wrong side, or a
      previous trade's level) exits at once — at the fill bar's Open in "intrabar" — and is a
      row in `result.attrs["exits_at_fill"]` (time, exit, level, fill) + a RuntimeWarning
      once. Both attrs exist only when a level is given. With an `instrument_id` column the
      roll bar tests no level (the value is the old contract's price); a level ffilled across
      a roll stays the old contract's — ffill per contract, which leaves the new contract
      with no level until its next event.

    Breakeven: the move is armed by a bar that reaches the threshold (its High / Low in
    "intrabar", its Close in "close") and is in force from the NEXT bar — like trailing below,
    no high-then-low inside one bar is assumed. On the arming bar the original stop still
    applies, and a bar that reaches the threshold and also the stop is a stop. Once armed it
    replaces the stop: back at the fill price exits, the order price is the fill price (or the
    Open when the bar gapped through it).

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
    several exits fire on one bar: breakeven (armed), stop / stop_level, trailing, time,
    take-profit / tp_level. The position series is the same whichever fired; only
    `attrs["exits"]` says which. Trailing
    ("intrabar"): the bar's adverse extreme is tested against the best price BEFORE this bar,
    then the best is raised by this bar's favourable extreme — no same-bar high-then-low is
    assumed.

    Always:
    - Levels are measured from the fill (the next valid bar's Open; the last valid Close when
      that Open is NaN or <= 0).
    - After any exit the position stays flat until the base signal changes side (leaves that
      side and takes it again, or flips) or `cooldown_bars` have passed — never a same-bar
      re-entry. A re-entry is a new trade: new fill, distances read again.
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
    stop_p, tp_p, trail_p, be_p = (_sides(n, v) for n, v in (
        ("stop_pct", stop_pct), ("tp_pct", tp_pct), ("trail_pct", trail_pct), ("breakeven_at", breakeven_at)))
    for name, pair in (("stop_pct", stop_p), ("tp_pct", tp_p), ("trail_pct", trail_p), ("breakeven_at", be_p)):
        for v in pair:
            if v is not None and not (isinstance(v, (int, float)) and 0 < v < 10):
                raise ValueError(f"{name} must be a positive fraction (0.03 = 3%), got {v!r}")
    bars_max = _sides("max_bars", max_bars)
    for v in bars_max:
        if v is not None and not (isinstance(v, (int, np.integer)) and v >= 1):
            raise ValueError(f"max_bars must be a whole number of bars >= 1, got {v!r}")
    # 0 would re-enter on the exit bar itself — the 2026-09-23 no-op stop
    if cooldown_bars is not None and not (isinstance(cooldown_bars, (int, np.integer))
                                          and not isinstance(cooldown_bars, bool) and cooldown_bars >= 1):
        raise ValueError(f"cooldown_bars must be a whole number of bars >= 1, got {cooldown_bars!r}")
    stop_d, tp_d, trail_d, be_d = (_sides(n, v) for n, v in (
        ("stop_dist", stop_dist), ("tp_dist", tp_dist), ("trail_dist", trail_dist), ("breakeven_dist", breakeven_dist)))
    for a, b, pp, dd in (("stop_pct", "stop_dist", stop_p, stop_d), ("tp_pct", "tp_dist", tp_p, tp_d),
                         ("trail_pct", "trail_dist", trail_p, trail_d),
                         ("breakeven_at", "breakeven_dist", be_p, be_d)):
        if any(v is not None for v in pp) and any(v is not None for v in dd):
            raise ValueError(f"give {a} or {b}, not both")
    stop_l, tp_l = _sides("stop_level", stop_level), _sides("tp_level", tp_level)
    for name, lv, others, what in (("stop_level", stop_l, (stop_p, stop_d, be_p, be_d),
                                    "stop_pct / stop_dist / breakeven_at / breakeven_dist"),
                                   ("tp_level", tp_l, (tp_p, tp_d), "tp_pct / tp_dist")):
        if any(v is not None for v in lv) and any(v is not None for pair in others for v in pair):
            raise ValueError(f"give {name} or {what}, not both")
    if all(v is None for pair in (stop_p, tp_p, trail_p, be_p, bars_max, stop_d, tp_d, trail_d, be_d,
                                  stop_l, tp_l) for v in pair):
        raise ValueError("apply_exits needs at least one of stop_pct / tp_pct / trail_pct / max_bars "
                         "/ stop_dist / tp_dist / trail_dist / breakeven_at / breakeven_dist "
                         "/ stop_level / tp_level")
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
    n = len(base)
    stop_d, tp_d, trail_d, be_d = (tuple(_distance(name, v, df, n) for v in pair) for name, pair in (
        ("stop_dist", stop_d), ("tp_dist", tp_d), ("trail_dist", trail_d), ("breakeven_dist", be_d)))
    nonpos = []
    stop_l, tp_l = (tuple(_level(name, v, df, n, nonpos) for v in pair) for name, pair in (
        ("stop_level", stop_l), ("tp_level", tp_l)))
    for name, k in nonpos:
        _warn_level_once(name + "<=0", f"apply_exits: {name} was <= 0 on {k} bar(s) — no {name} on "
                                       f"those bars (treated as NaN).")
    has_lv = any(v is not None for v in (*stop_l, *tp_l))

    def ok(x):
        return np.isfinite(x) and x > 0

    out = np.zeros(n)
    exits, unarmed, at_fill, lv_gaps = [], [], [], []
    held, stopped, pending, last = 0.0, False, False, None
    entry = acc = best = np.nan
    bars = 0
    t_stop = t_tp = t_trail = t_be = t_bars = t_trail_d = None     # this trade's own levels
    trail_now, armed, wait = np.nan, False, None
    t_sl = t_tl = None
    ex_side, blk = 0.0, None                # side of the last exit; the level(s) a re-entry waits past
    tr_time, tr_bars, tr_nan = None, 0, [0, 0]

    def end_trade():
        # a trade that had no level on most of its bars: the strategy almost surely forgot ffill()
        nonlocal tr_time
        if tr_time is not None and tr_bars:
            for name, lv, k in (("stop_level", t_sl, 0), ("tp_level", t_tl, 1)):
                if lv is not None and 2 * tr_nan[k] > tr_bars:
                    lv_gaps.append({"time": tr_time, "exit": name, "bars": tr_bars, "nan_bars": tr_nan[k]})
        tr_time = None

    for t in range(n):
        if not ok(close[t]):
            out[t] = held
            continue
        fill = opn[t] if ok(opn[t]) else close[last if last is not None else t]
        side = np.sign(held)
        if pending:
            entry, acc, best, bars, pending = fill, 1.0, 1.0, 0, False
            i = 0 if side > 0 else 1

            def frozen(name, pct, dist, toward_zero):
                # the signal bar's distance → this trade's own fraction of its fill
                if dist is None:
                    return pct
                d = dist[last]
                if ok(d) and (d < fill or not toward_zero):
                    return d / fill
                unarmed.append({"time": index[t], "exit": name, "dist": float(d)})
                return None

            t_stop = frozen("stop", stop_p[i], stop_d[i], side > 0)
            t_tp = frozen("tp", tp_p[i], tp_d[i], side < 0)
            t_be = frozen("breakeven", be_p[i], be_d[i], side < 0)
            t_trail, t_trail_d, t_bars = trail_p[i], trail_d[i], bars_max[i]
            t_sl, t_tl = stop_l[i], tp_l[i]
            trail_now, armed = np.nan, False
            if t_trail_d is not None and not ok(t_trail_d[last]):
                unarmed.append({"time": index[t], "exit": "trail", "dist": float(t_trail_d[last])})
            if has_lv:
                tr_time, tr_bars, tr_nan = index[t], 0, [0, 0]
        elif side and inst is not None and inst[t] != inst[last]:
            acc, entry = acc * close[last] / entry, fill
        if stopped and wait is not None:          # bars after the exit bar: `wait` is set below it
            wait -= 1
            if wait <= 0 and not has_lv:
                stopped = False
            elif wait <= 0:
                # re-entering with the price already past the same level exits at the fill, waits the
                # cooldown, re-enters… (2026-10-29 probe: 3,962 trades, 2,750 out on their own fill
                # bar) — so wait for a new level (another non-NaN value) or the base signal changing side
                s = np.sign(base[t])
                j = 0 if s > 0 else 1
                cur = (stop_l[j][t] if stop_l[j] is not None else np.nan,
                       tp_l[j][t] if tp_l[j] is not None else np.nan)
                if blk is None or any(v == v and v != b for v, b in zip(cur, blk)):
                    wrong = s == ex_side and ((cur[0] == cur[0] and (close[t] - cur[0]) * s <= 0)
                                              or (cur[1] == cur[1] and (close[t] - cur[1]) * s >= 0))
                    blk = cur if wrong else None
                    stopped = wrong
        if side and not stopped:
            k = acc / entry                         # price → trade ratio since the fill, roll-adjusted
            hi = high[t] if ok(high[t]) else close[t]
            lo = low[t] if ok(low[t]) else close[t]
            adverse, favour = (lo, hi) if side > 0 else (hi, lo)
            bars += 1
            if t_trail_d is not None and ok(t_trail_d[last]):
                trail_now = t_trail_d[last]

            def hit_at(pct):                        # price of a level `pct` from the fill (+ = favourable)
                return (1 + pct * side) / k

            def beyond(price, pct):                 # price at or past that level
                return ((price * k - 1) * side - pct) * np.sign(pct) >= 0

            reason = level = sl = tl = None
            if has_lv and (inst is None or inst[t] == inst[last]):
                tr_bars += 1
                if t_sl is not None and t_sl[last] == t_sl[last]:
                    sl = t_sl[last]
                elif t_sl is not None:
                    tr_nan[0] += 1
                if t_tl is not None and t_tl[last] == t_tl[last]:
                    tl = t_tl[last]
                elif t_tl is not None:
                    tr_nan[1] += 1
            o = fill if bars == 1 else (opn[t] if ok(opn[t]) else close[t])   # a gap fills here
            if intrabar:
                if armed and (o * k - 1) * side <= 0:
                    reason, level = "breakeven", o
                elif t_stop is not None and beyond(o, -t_stop):
                    reason, level = "stop", o
                elif sl is not None and (o - sl) * side <= 0:
                    reason, level = "stop_level", o
                elif t_tp is not None and beyond(o, t_tp):
                    reason, level = "tp", o
                elif tl is not None and (o - tl) * side >= 0:
                    reason, level = "tp_level", o
            if reason is None and armed and (adverse * k - 1) * side <= 0:
                reason, level = "breakeven", 1 / k
            if reason is None and t_stop is not None and beyond(adverse, -t_stop):
                reason, level = "stop", hit_at(-t_stop)
            if reason is None and sl is not None and (adverse - sl) * side <= 0:
                reason, level = "stop_level", sl
            if reason is None and (t_trail is not None or ok(trail_now)):
                ref = adverse if intrabar else close[t]
                b = best if intrabar else (max(best, close[t] * k) if side > 0 else min(best, close[t] * k))
                if t_trail is not None:
                    fired, at = (ref * k / b - 1) * side <= -t_trail, b * (1 - t_trail * side) / k
                else:
                    fired, at = (ref * k - b) * side <= -trail_now * k, b / k - trail_now * side
                if fired:
                    reason, level = "trail", at
                    if (o - level) * side < 0:
                        level = o
            if reason is None and t_bars is not None and bars >= t_bars:
                reason, level = "time", None
            if reason is None and t_tp is not None and beyond(favour, t_tp):
                reason, level = "tp", hit_at(t_tp)
            if reason is None and tl is not None and (favour - tl) * side >= 0:
                reason, level = "tp_level", tl
            best = max(best, favour * k) if side > 0 else min(best, favour * k)
            if t_be is not None and not armed and beyond(favour, t_be):
                armed = True
            if reason is not None:
                stopped, wait = True, cooldown_bars
                exits.append({"time": index[t], "reason": reason,
                              "order_price": float(level) if (intrabar and level is not None) else None})
                if has_lv:
                    ex_side, blk = side, None
                    # exited on its own fill bar with the fill already past the level
                    if bars == 1 and ((reason == "stop_level" and (fill - sl) * side <= 0)
                                      or (reason == "tp_level" and (fill - tl) * side >= 0)):
                        at_fill.append({"time": index[t], "exit": reason, "fill": float(fill),
                                        "level": float(sl if reason == "stop_level" else tl)})
        if stopped and np.sign(base[t]) != np.sign(base[last]):
            stopped = False
        want = 0.0 if stopped else base[t]
        if np.sign(want) != side:
            pending = bool(want)
            if has_lv and side:
                end_trade()
        out[t], held, last = want, want, t
    if has_lv:
        end_trade()
    res = pd.Series(out, index=index)
    # a DataFrame, not a list: pandas deep-copies attrs on every operation on the Series
    res.attrs["exits"] = pd.DataFrame(exits, columns=["time", "reason", "order_price"])
    res.attrs["exits_unarmed"] = pd.DataFrame(unarmed, columns=["time", "exit", "dist"])
    if has_lv:
        res.attrs["exits_at_fill"] = pd.DataFrame(at_fill, columns=["time", "exit", "level", "fill"])
        res.attrs["exits_level_gaps"] = pd.DataFrame(lv_gaps, columns=["time", "exit", "bars", "nan_bars"])
        for name in sorted({r["exit"] for r in at_fill}):
            _warn_level_once("fill:" + name, f"apply_exits: {name} was already crossed at the fill of at least one "
                             f"trade, so it exited at once (rows in result.attrs['exits_at_fill']). Usual cause: "
                             f"the level still holds the previous trade's value — set it on the entry bar too and "
                             f"NaN while flat (references/strategy-code.md). A real gap through it is right as is.")
        for name in sorted({r["exit"] for r in lv_gaps}):
            _warn_level_once("gaps:" + name, f"apply_exits: {name} was NaN on more than half the bars of at least "
                             f"one trade — no {name} on those bars (rows in result.attrs['exits_level_gaps']). "
                             f"Usual cause: the level Series is not ffill()ed.")
    if isinstance(signal, pd.Series) and "ladder" in signal.attrs:   # keeps the runner's ladder sizing line
        res.attrs["ladder"] = signal.attrs["ladder"]
    for name in sorted({u["exit"] for u in unarmed} - _unarmed_warned):
        _unarmed_warned.add(name)
        warnings.warn(f"apply_exits: {name}_dist was NaN, <= 0 or past zero on the signal bar of at least "
                      f"one trade — that trade started WITHOUT its {name} exit (rows in "
                      f"result.attrs['exits_unarmed']). Usual cause: the entry is inside the indicator's "
                      f"warm-up.", RuntimeWarning, stacklevel=2)
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
