import ast
import contextlib
import hashlib
import json
import math
import os
import re
import shutil
import threading
import time
import unicodedata
from pathlib import Path

import numpy as np
import pandas as pd

try:
    import fcntl
except ImportError:  # Windows — versions_lock goes through msvcrt instead
    fcntl = None
try:
    import msvcrt
except ImportError:  # POSIX
    msvcrt = None
try:
    from lib.winreplace import load_json
except ImportError:  # half-updated workspace (lib/winreplace.py without load_json): no read retry
    def load_json(path, **open_kw):
        with open(path, **open_kw) as f:
            return json.load(f)

_REPO_ROOT = Path(__file__).parent.parent


def add_realized_vol(df, lookback=720, periods_per_year=8760):
    """Compute rolling realized volatility and add as df['realized_vol'] in-place."""
    log_ret = np.log(df['Close'] / df['Close'].shift(1))
    df['realized_vol'] = log_ret.rolling(lookback).std() * np.sqrt(periods_per_year)


def apply_vol_scaling(signal, df, target_vol=0.30, vol_cap=2.0):
    """Scale signal by vol targeting. signal × (target_vol / realized_vol)."""
    vol = df.get('realized_vol', pd.Series(np.nan, index=df.index))
    scale = (target_vol / vol).clip(upper=vol_cap)
    return signal * scale


def hysteresis(x, enter, exit, side=1):
    """One-sided threshold hysteresis, vectorized (no per-bar loop).

    side=+1 → long (1.0) once x > enter, flat (0.0) once x < exit, position held in
    between; side=-1 → short (-1.0) once x < enter, flat once x > exit. NaN bars hold
    the previous position; bars before the first signal are flat. Bar-for-bar identical
    to threshold_position() with the other side switched off; threshold_position()
    dispatches here itself whenever one side can never trigger, so a per-side scan
    gets the vectorized path without the caller knowing about this function.
    """
    x = pd.Series(x)
    if side >= 0:
        raw = np.where(x > enter, 1.0, np.where(x < exit, 0.0, np.nan))
    else:
        raw = np.where(x < enter, -1.0, np.where(x > exit, 0.0, np.nan))
    return pd.Series(raw, index=x.index).ffill().fillna(0.0)


def threshold_position(x, buy_th, sell_th, cover_th, short_th):
    """Two-sided four-threshold state machine → position Series of 1 / 0 / -1.

    long  when x > buy_th, exits to flat once x < sell_th;
    short when x < short_th, exits to flat once x > cover_th.
    Exit is checked before entry, so a bar that leaves one side's hold band and crosses
    the opposite entry flips in one bar. The flat band is bounded on both sides, which
    makes the position history-dependent — a vectorized where/ffill cannot express it
    (a gap across the band would keep the stale side), hence the loop. NaN holds.

    The loop costs ~0.5 s per 390k bars (5-min since 2023, Lightsail medium) — fine once
    per backtest, not per scan_grid cell. A side whose entry no bar ever reaches (the
    scan idiom: short_th=-1e9 / buy_th=1e9) can never hold a position, so the other side
    is a plain one-sided hysteresis and takes the vectorized path (~5 ms).
    """
    x = pd.Series(x)
    if not (x < short_th).any():         # short can never enter → long-only hysteresis
        return hysteresis(x, buy_th, sell_th, side=1)
    if not (x > buy_th).any():           # long can never enter → short-only hysteresis
        return hysteresis(x, short_th, cover_th, side=-1)
    vals = x.tolist()                    # Python floats: 4-5× faster than np.float64 scalars
    out = np.zeros(len(vals))
    pos = 0
    for i, xi in enumerate(vals):
        if xi != xi:                     # NaN
            out[i] = pos
            continue
        if pos == 1 and xi < sell_th:
            pos = 0
        elif pos == -1 and xi > cover_th:
            pos = 0
        if pos == 0:
            if xi > buy_th:
                pos = 1
            elif xi < short_th:
                pos = -1
        out[i] = pos
    return pd.Series(out, index=x.index)


def ladder_position(entry, df, devs, mult=1.0, tp_pct=0.03, settle=None):
    """Scale-in (DCA) ladder state machine → long position Series in [0, 1].

    A bar where `entry` is True while flat buys the base order; layer k is added once a Close
    is at or below base_fill × (1 − devs[k]) — every rung measured from the base fill, several
    in one bar if price gaps through them. Order k costs mult**k base orders, and the signal is
    cost bought so far ÷ cost of the full ladder, so a full ladder is 1.0. Every order fills at
    the next valid bar's Open, and the average cost is built from those fills; the position
    exits to 0.0 on the first Close ≥ average × (1 + tp_pct). The exit bar never re-checks
    `entry`: a level trigger still true on the next bar re-enters then — pass an edge
    (`cond & ~cond.shift(1, fill_value=False)`) for one cycle per dip. A bar the runner drops
    (Open or Close not finite and > 0) holds and is not looked at.
    A contract roll ends the cycle: a True bar of `settle` (TAIFEX: txf_settlement_mask(df.index),
    whose series has no instrument_id) is flat and the ladder starts over, and so is the first
    bar of a new `instrument_id` (orders signalled on the old contract are dropped). The
    settlement exit already flattens the real position there, so the old fills are gone and
    the spread to the next contract must not read as a dip or a take-profit; only a trigger
    enters again.
    A loop, not vectorizable: the TP level moves with every fill.
    The result's attrs["ladder"] carries devs / mult for the runner's sizing line.
    """
    devs = [float(d) for d in devs]
    if not devs or any(d <= 0 for d in devs) or any(b <= a for a, b in zip(devs, devs[1:])):
        raise ValueError("ladder_position: devs must be positive and strictly increasing")
    if mult <= 0 or tp_pct <= 0:
        raise ValueError("ladder_position: mult and tp_pct must be > 0")
    if isinstance(entry, pd.Series):
        if not entry.index.equals(df.index):
            raise ValueError("ladder_position: entry must be on df's index")
        trig = entry.eq(True).tolist()
    else:
        trig = (np.asarray(entry) == True).tolist()  # noqa: E712 — NaN / None count as False
        if len(trig) != len(df):
            raise ValueError("ladder_position: entry must have one value per df row")
    if settle is None:
        roll = [False] * len(df)
    elif isinstance(settle, pd.Series):
        if not settle.index.equals(df.index):
            raise ValueError("ladder_position: settle must be on df's index")
        roll = settle.eq(True).tolist()
    else:
        roll = (np.asarray(settle) == True).tolist()  # noqa: E712
        if len(roll) != len(df):
            raise ValueError("ladder_position: settle must have one value per df row")
    costs = [mult ** k for k in range(len(devs) + 1)]
    total = sum(costs)
    close, opn = df['Close'].tolist(), df['Open'].tolist()
    inst = df['instrument_id'].tolist() if 'instrument_id' in df.columns else None

    def ok(v):
        return v == v and 0 < v < float("inf")

    out = np.zeros(len(close))
    filled = 0        # orders signalled (base = 1)
    booked = 0        # orders whose fill price is known
    base = cost = qty = 0.0
    contract = None   # instrument_id of the last valid bar
    for t, c in enumerate(close):
        if not (ok(c) and ok(opn[t])):       # same bars lib.runner drops
            if roll[t]:
                filled = booked = 0
            out[t] = sum(costs[:filled]) / total
            continue
        if inst is not None and not pd.isna(inst[t]):
            if contract is not None and inst[t] != contract:
                filled = booked = 0
            contract = inst[t]
        if filled > booked:                  # orders signalled on the last valid bar fill at this Open
            fill = opn[t]
            if booked == 0:
                base, cost, qty = fill, 0.0, 0.0
            for k in range(booked, filled):
                cost += costs[k]
                qty += costs[k] / fill
            booked = filled
        if roll[t]:
            filled = booked = 0
        elif filled == 0:
            if trig[t]:
                filled = 1
        elif c >= cost / qty * (1 + tp_pct):
            filled = booked = 0
        else:
            while filled <= len(devs) and c <= base * (1 - devs[filled - 1]):
                filled += 1
        out[t] = sum(costs[:filled]) / total
    res = pd.Series(out, index=df.index)
    res.attrs["ladder"] = {"devs": devs, "mult": float(mult)}
    return res


def ladder_sizing(amount, devs, mult=1.0, min_order=None, lots=False, lot=None, lot_floor=False):
    """What live actually sends for a ladder_position strategy funded with `amount`.

    Live trades the gap between the cumulative target and what it already holds; a gap under
    the entry gate is not sent and merges into the next rung. Notional (`lots=False`):
    `min_order` is the entry gate in the amount's currency (the reconciler's max($10, venue
    minimum)); `lot`, when the venue has one, is a lot's value — an entry rounds half-up to whole
    lots (lib.venue_wiring._entry_qty), so a rung can land up to half a lot over its target and
    shrink the next gap; `lot_floor=True` floors instead (paper TW stocks: whole shares, floored). Both are valued at the current mark for every rung: an approximation,
    deeper rungs trade lower. Lots (`lots=True`, TAIFEX / shares — the amount is whole units):
    each cumulative target rounds half-up like lib.portfolio.aggregate_portfolio. Sized per
    strategy, before netting with others on the symbol, on the self_ledger book.

    Returns {'orders': planned size per order (base first), 'targets': cumulative target after
    each order, 'trades': what live sends at each rung (0 = nothing), 'skipped': indices whose
    trade is 0, 'base_frac': base order ÷ full ladder, 'min_amount': an amount at which every
    order trades with every gap at least 0.1% over the gate, re-checked 0.5% above (None if not found)}.
    """
    devs = [float(d) for d in devs]
    if not devs or mult <= 0:
        raise ValueError("ladder_sizing: devs must be non-empty and mult > 0")
    if not lots and not (min_order and min_order > 0):
        raise ValueError("ladder_sizing: pass min_order (the venue minimum) for a notional amount")
    lot = float(lot) if lot and lot > 0 and not lots else None
    costs = [mult ** k for k in range(len(devs) + 1)]
    total = sum(costs)
    cum = [sum(costs[:k + 1]) / total for k in range(len(costs))]

    def plan(a, edge=1.0):
        if lots:
            targets = [math.floor(abs(a) * f + 0.5 + 1e-9) for f in cum]
            return targets, [t - p for t, p in zip(targets, [0] + targets[:-1])]
        targets, trades, held = [a * f for f in cum], [], 0.0
        for t in targets:
            gap = t - held
            if gap < min_order * edge:               # lib.portfolio.compute_diff: abs(diff) < gate → skip
                trades.append(0.0)
                continue
            if not lot:
                q = gap
            elif lot_floor:
                q = math.floor(gap / lot + 1e-9) * lot     # lib.order_paper: whole shares, floored
            else:
                q = math.floor(gap / lot + 0.5) * lot      # lib.venue_wiring._entry_qty
            if not q:
                trades.append(0.0)
                continue
            trades.append(q)
            held += q
        return targets, trades

    def every(a):
        # 0.1% over the gate on every rung: lot rounding can squeeze a later gap onto the gate itself
        return all(plan(a, 1.001)[1])

    if lots:
        min_amount = next((a for a in range(1, 10001) if every(a)), None)
    else:
        a = math.ceil(min_order * total / min(costs) * 100) / 100   # no amount below this can pass
        step = max(0.01, (lot or 0) / 100)
        min_amount = None
        for _ in range(100000):
            # 0.5% above passes too: an amount a hair over a merge point is not reported
            if every(a) and every(math.ceil(a * 1.005 * 100) / 100):
                min_amount = a
                break
            a = math.ceil((a + step) * 100) / 100
    targets, trades = plan(amount)
    return {'orders': [amount * c / total for c in costs], 'targets': targets, 'trades': trades,
            'skipped': [k for k, x in enumerate(trades) if not x], 'base_frac': costs[0] / total,
            'min_amount': min_amount}


def twstock_universe_by_sector(stock_list, total=100, seed=42, industries=None):
    """A Taiwan stock universe drawn evenly across industries (references/twstock.md › Universe):
    codes are grouped by industry, so a head slice of the list is a few sectors only.
    `stock_list` is lib.data.fetch_twstock_list(hdrs) — taken, not fetched, so importing
    lib.strategy never makes a strategy need Blave data (quality_check.blave_data_need).
    Common stocks only (ETFs carry no industry_code); `industries` keeps those codes (['24', '25']).
    Equal draw per industry, the shortfall topped up at random from the rest; fewer slots than
    industries → `total` industries drawn, one stock each. Same seed + same list → same ids.
    Returns sorted ids: print them once and paste them into UNIVERSE (frozen at backtest start)."""
    import random

    def code(c):
        c = str(c).strip()
        return c.zfill(2) if c.isdigit() else c

    if stock_list is None or stock_list.empty:
        raise RuntimeError("stock_list is empty — pass fetch_twstock_list(hdrs)")
    codes = stock_list['industry_code'][stock_list['industry_code'].notna()].map(code)
    if industries is not None:
        codes = codes[codes.isin({code(c) for c in industries})]
    groups = {}
    for sid, c in sorted(codes.items(), key=lambda kv: str(kv[0])):
        groups.setdefault(c, []).append(str(sid))
    if not groups:
        raise RuntimeError(f"no common stocks in industries {industries}")
    rng = random.Random(seed)
    keys = sorted(groups)
    if total < len(keys):
        keys, per = sorted(rng.sample(keys, total)), 1
    else:
        per = total // len(keys)
    picked = [s for k in keys for s in rng.sample(groups[k], min(per, len(groups[k])))]
    taken = set(picked)
    rest = [s for k in keys for s in groups[k] if s not in taken]
    rng.shuffle(rest)
    return sorted(picked + rest[:max(0, total - len(picked))])


# ── Strategy versions (.claude/docs/strategy-versions.md) ─────────────────────
# One version = one BACKTEST of one STRATEGY_NAME. lib/runner.py mints them into
# strategies/<name>/versions/; the functions below read them back for the agent
# ("which version had the best Sharpe") and for the workspace's 還原 flow.

VERSIONS_KEEP = 20  # canon §8 — the api sweeps its own copy, the machine sends no DELETE

# Capability flag, read as TEXT by the runtime (strategy_reporter.lib_restore_in_place) — the
# runtime never imports lib. The runtime updates itself; lib only updates when the user asks,
# so a new runtime next to an old lib is a normal, long-lived state, and an old restore()
# neither moves `current` nor keeps the re-run from minting a new version. The runtime refuses
# the workspace's direct restore command unless this line is here. It stands for restore()'s
# in-place semantics and the runner's same-code rule: remove those, remove it.
RESTORE_IN_PLACE = 1

VERSIONS_LOCK_TIMEOUT_S = 30
# Results computed from some other code, moved aside by restore() (canon §5). pnl.png is one of
# them: the workspace shows it on the backtest tab, and the background re-run is the only thing
# that redraws it.
RESTORE_STASHED = ('stats.json', 'scan.json', 'wf.json', 'pnl.png', 'backtest_state.json')
PRE_RESTORE_KEEP = 3   # versions/pre-restore.py (newest), pre-restore.1.py, pre-restore.2.py
_lock_held = threading.local()


def versions_dir(name):
    """strategies/<name>/versions/ — index.json + v<N>.json + drift.json live here."""
    return _REPO_ROOT / 'strategies' / str(name) / 'versions'


# Capability flag, read as TEXT like RESTORE_IN_PLACE (strategy_reporter.lib_renames, shell
# main.js): code_hash ignores the DISPLAY_NAME line, restore() keeps the current name and
# rename() exists. The runtime refuses rename_strategy without it — an older runner would flag
# a renamed live strategy as edited and mint a copy of it on the next backtest.
STRATEGY_RENAME = 1

# Canon strategy-versions §2 改名不算改碼: a column-0 `DISPLAY_NAME = "…"` line, terminator and
# all, is left out of the hash. Only the shape rename() writes (one string literal, optional
# comment): anything else on that line (`; LEVERAGE = 3`, `if … else`) is real code and must
# still move the hash, or a live strategy runs changed code under a "file unchanged" badge. Deleted rather than blanked so adding the line where there was
# none (rename() on a file without one) hashes the same too. Byte-level and spelled the same in
# runtime/strategy_reporter.py and shell/main.js — tests/fixtures/code_hash_name.json pins all three.
_HASH_NAME_LINE_RE = re.compile(
    rb'(?:^|(?<=\n))DISPLAY_NAME[ \t]*=[ \t]*(?:"[^"\\\r\n]*"|\'[^\'\\\r\n]*\')[ \t]*(?:#[^\r\n]*)?(?:\r\n|\n|\r|\Z)')


def raw_code_hash(src_bytes):
    """The pre-rename-era hash (raw bytes). Entries minted before it, and the runtime's and
    shell's stored stamps from an older lib, still carry it — compare with hash_matches()."""
    return hashlib.sha256(src_bytes).hexdigest()[:16]


def code_hash(src_bytes):
    """An index entry's `code_hash`: sha256 of the strategy file's bytes without the
    DISPLAY_NAME line, first 16 hex chars. Truncated because the whole entry is budgeted at
    ~200 bytes (canon §9) and 64 bits is far more than "is this file still what v<N> stored"
    needs."""
    return hashlib.sha256(_HASH_NAME_LINE_RE.sub(b'', src_bytes)).hexdigest()[:16]


def hash_matches(src_bytes, stored):
    """Is `stored` (an index entry's, a preview's, a scan's code_hash) the hash of this code?
    Either form: a stamp written before the name stopped counting is the raw hash."""
    return isinstance(stored, str) and stored in (code_hash(src_bytes), raw_code_hash(src_bytes))


def load_index(name):
    """versions/index.json as a dict, or None when absent / unreadable / not an object.
    Fail-soft on purpose: both callers (the runner minting the next version, the live
    tick's drift check) must treat a missing or half-written index as "no versions yet"
    rather than fail the run."""
    try:
        idx = load_json(versions_dir(name) / 'index.json', encoding='utf-8')
    except (OSError, ValueError):
        return None
    return idx if isinstance(idx, dict) else None


@contextlib.contextmanager
def versions_lock(name, timeout=VERSIONS_LOCK_TIMEOUT_S):
    """Exclusive hold over a strategy's results: versions/index.json's read-modify-write, and
    the runner's whole "file still what I ran → stats.json → version → rerun.json" tail. Two
    writers: the runner, and restore() — and a restore starts a background re-run, which is
    exactly when both are live. A lock FILE, because every write os.replaces index.json's inode.
    Re-entrant within a thread (the runner holds it around _mint_version, which takes it too;
    flock on a second fd of the same process would deadlock). Gives up with TimeoutError
    instead of waiting forever: a wedged holder must not hang every later backtest."""
    held = getattr(_lock_held, 'names', None)
    if held is None:
        held = _lock_held.names = set()
    if str(name) in held:
        yield
        return
    vdir = versions_dir(name)
    os.makedirs(vdir, exist_ok=True)
    fd = os.open(vdir / '.lock', os.O_CREAT | os.O_RDWR, 0o600)
    deadline = time.monotonic() + timeout
    try:
        while True:
            try:
                if fcntl is not None:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                elif msvcrt is not None:
                    msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"{name}: versions/.lock still held after {timeout}s") from None
                time.sleep(0.05)
        held.add(str(name))
        try:
            yield
        finally:
            held.discard(str(name))
    finally:
        if fcntl is None and msvcrt is not None:
            try:
                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            except OSError:
                pass
        os.close(fd)  # POSIX: closing releases the flock


def version_note_of(code):
    """The VERSION_NOTE a piece of stored code declares (last module-level string assignment,
    as exec would leave it), stripped; '' when absent or unparsable. ast, never exec."""
    try:
        tree = ast.parse(code.lstrip('\ufeff'))   # stored code keeps a BOM (the bytes are hashed as-is)
    except (SyntaxError, ValueError):
        return ''
    note = ''
    for node in tree.body:
        if (isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant)
                and isinstance(node.value.value, str)
                and any(isinstance(t, ast.Name) and t.id == 'VERSION_NOTE' for t in node.targets)):
            note = node.value.value.strip()
    return note


def list_versions(name):
    """Every stored version of `name`, oldest first — the summary entries, no code and no
    equity curve (open versions/v<N>.json for those). This is what answers 「這支策略有
    哪些版本 / 哪一版 Sharpe 最好」 from one small file instead of reading 20 blobs.

    The entry index.json's `current` points at carries `current: True` (added here, never
    stored): after a restore the current version is an older number, not the last entry.

    Same shape contract as lib.report.list_schedules: a list of dicts, [] when the
    strategy has no versions, and one {"error": …} entry when the index is unreadable —
    never an exception, never a silent [] for a broken file (that reads as "no versions"
    and the agent would tell the user something false)."""
    path = versions_dir(name) / 'index.json'
    if not path.exists():
        return []
    try:
        idx = load_json(path, encoding='utf-8')
        items = idx['items']
        if not isinstance(items, list):
            raise ValueError('items is not a list')
    except (OSError, ValueError, KeyError, TypeError) as e:
        return [{'error': f'bad index.json: {e}'}]
    cur = idx.get('current')
    return [dict(i, current=True) if i.get('n') == cur else i for i in items if isinstance(i, dict)]


def strategy_source_path(name):
    """The file a strategy's code lives in — strategies/<name>/strategy.py (dir layout)
    or strategies/<name>.py (single file), the two layouts the workspace enumerates —
    or None when neither exists."""
    for p in (_REPO_ROOT / 'strategies' / str(name) / 'strategy.py',
              _REPO_ROOT / 'strategies' / f'{name}.py'):
        if p.is_file():
            return p
    return None


# ── Renaming (spec strategy-rename-2026-11-05 §3/§5) ──────────────────────────
# The rules the sidebar's name box enforces — shell/renderer and web carry the same three, and
# runtime agent_turn._display_name is why: a name it would drop back to the code (_NAME_UNSAFE,
# Unicode line/format characters, a template's [placeholder]) or cut (60) is not offered. `"`
# and `\` because the shell reads the line with a one-line regex and rename writes it in "".
NAME_MAX = 60
_NAME_BAD_RE = re.compile('[、;:；：「」"\\\\\r\n\x0b\x0c\x85\u2028\u2029]')
_EOL_SPLIT_RE = re.compile(r'(\r\n|\r|\n)')   # ast's own line breaks, so lineno indexes this split
_NAME_LITERAL_LINE_RE = re.compile(
    r'DISPLAY_NAME[ \t]*=[ \t]*(?P<lit>"[^"\\\r\n]*"|\'[^\'\\\r\n]*\')[ \t]*(?:#.*)?')
_BOM = b'\xef\xbb\xbf'


def name_problem(value):
    """None when `value` (already stripped) may be a DISPLAY_NAME, else EMPTY / TOO_LONG / CHAR /
    WRAPPED. Counted in code points, like the runtime's v[:60]."""
    if not isinstance(value, str) or not value:
        return 'EMPTY'
    if len(value) > NAME_MAX:
        return 'TOO_LONG'
    if _NAME_BAD_RE.search(value) or any(unicodedata.category(c) in ('Cc', 'Cf', 'Zl', 'Zp')
                                         for c in value):
        return 'CHAR'
    if value.startswith('[') and value.endswith(']'):
        return 'WRAPPED'
    return None


def _name_fold(value):
    return unicodedata.normalize('NFKC', value.strip()).lower()


def _literal_name_line(tree, lines):
    """(line index, match) of the file's one DISPLAY_NAME assignment when it is a plain one-line
    string at column 0, None when there is no assignment at all; raises ValueError when there is
    one rename cannot rewrite (an expression, an annotation, several of them, an f-string)."""
    stores = [n for n in ast.walk(tree)
              if isinstance(n, ast.Name) and n.id == 'DISPLAY_NAME' and isinstance(n.ctx, ast.Store)]
    if not stores:
        return None
    if len(stores) > 1:
        raise ValueError('DISPLAY_NAME is assigned more than once')
    node = next((a for a in tree.body if isinstance(a, ast.Assign) and a.targets == [stores[0]]), None)
    if (node is None or not isinstance(node.value, ast.Constant) or not isinstance(node.value.value, str)
            or node.lineno != node.end_lineno or node.col_offset != 0):
        raise ValueError('DISPLAY_NAME is not a one-line string')
    m = _NAME_LITERAL_LINE_RE.fullmatch(lines[node.lineno - 1])
    if m is None:
        raise ValueError('DISPLAY_NAME is not a plain "…" string')
    return node.lineno - 1, m


def _split_lines(text):
    parts = _EOL_SPLIT_RE.split(text)
    return parts[0::2], parts[1::2] + ['']


def literal_name(text):
    """The name a one-line DISPLAY_NAME assignment holds, or None (none, or not rewritable)."""
    try:
        hit = _literal_name_line(ast.parse(text), _split_lines(text)[0])
    except (SyntaxError, ValueError):
        return None
    return hit[1].group('lit')[1:-1] if hit else None


def set_display_name(text, value):
    """`text` (a strategy file, BOM already stripped) with its DISPLAY_NAME set to `value`; only
    that string changes, a trailing comment stays. Without a DISPLAY_NAME the line goes under
    STRATEGY_NAME, else under the docstring and __future__ imports. ValueError when the file does
    not parse, holds a DISPLAY_NAME rename cannot rewrite, or `value` cannot sit in "…"."""
    if '"' in value or '\\' in value or _EOL_SPLIT_RE.search(value):
        raise ValueError('the name cannot be written as a plain "…" string')
    tree = ast.parse(text)
    lines, eols = _split_lines(text)
    hit = _literal_name_line(tree, lines)
    if hit:
        i, m = hit
        lines[i] = lines[i][:m.start('lit')] + '"' + value + '"' + lines[i][m.end('lit'):]
    else:
        after = 0
        for node in tree.body:
            if (isinstance(node, ast.Assign) and len(node.targets) == 1
                    and isinstance(node.targets[0], ast.Name) and node.targets[0].id == 'STRATEGY_NAME'
                    and node.col_offset == 0 and node.lineno == node.end_lineno):
                after = node.end_lineno
                break
        else:
            for k, node in enumerate(tree.body):
                is_doc = (k == 0 and isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant)
                          and isinstance(node.value.value, str))
                if is_doc or (isinstance(node, ast.ImportFrom) and node.module == '__future__'):
                    after = node.end_lineno
                else:
                    break
        if after and not eols[after - 1]:
            raise ValueError('nowhere to put DISPLAY_NAME without touching another line')
        eol = (eols[after - 1] if after else '') or next((e for e in eols if e), '\n')
        lines.insert(after, 'DISPLAY_NAME = "' + value + '"')
        eols.insert(after, eol)
    return ''.join(a + b for a, b in zip(lines, eols))


def _shown_names(skip):
    """What the sidebar shows for every other strategy: its DISPLAY_NAME, or its code (folder /
    file stem and STRATEGY_NAME — the desktop shows the one, the web the other)."""
    sdir = _REPO_ROOT / 'strategies'
    try:
        entries = sorted(os.listdir(sdir))
    except OSError:
        return
    for entry in entries:
        if entry.startswith('.') or entry == '__pycache__' or entry.startswith('TEMPLATE'):
            continue
        full = sdir / entry
        p = full / 'strategy.py' if full.is_dir() else (full if entry.endswith('.py') else None)
        if p is None or not p.is_file() or p.resolve() == skip:
            continue
        try:
            with open(p, encoding='utf-8-sig', errors='replace') as f:
                src = f.read(65536)
        except OSError:
            continue
        found = {}
        try:
            for node in ast.walk(ast.parse(src)):
                if (isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant)
                        and isinstance(node.value.value, str)):
                    for t in node.targets:
                        if isinstance(t, ast.Name) and t.id in ('DISPLAY_NAME', 'STRATEGY_NAME'):
                            found.setdefault(t.id, node.value.value)
        except (SyntaxError, ValueError):
            pass
        shown = (found.get('DISPLAY_NAME') or '').strip()
        if shown:
            yield shown
        else:
            yield entry[:-3] if p == full else entry
            if found.get('STRATEGY_NAME'):
                yield found['STRATEGY_NAME']


def _rekey_versions(vdir, items, *codes):
    """Entries still holding the raw-bytes hash get the name-blind one, when their code is at
    hand (the given bytes, or the entry's own blob). The stored code is unchanged — only how its
    hash is spelled — and without this a version minted before the rule would read as edited
    the moment its strategy is renamed or restored under another name. True when any changed."""
    known = {raw_code_hash(b): code_hash(b) for b in codes}
    changed = False
    for i in items:
        h = i.get('code_hash')
        if not isinstance(h, str):
            continue
        if h not in known:
            try:
                code = load_json(vdir / f"v{i.get('n')}.json", encoding='utf-8').get('code')
            except (OSError, ValueError, AttributeError):
                code = None
            if isinstance(code, str):
                b = code.encode('utf-8')
                known.setdefault(raw_code_hash(b), code_hash(b))
        if known.get(h, h) != h:
            i['code_hash'] = known[h]
            changed = True
    return changed


def rekey_current(name, src):
    """The live tick's drift check, once per new file content: is the file the `current`
    version's code under another DISPLAY_NAME, with an entry still on the raw-bytes hash (a
    rename made in chat)? Then that entry is re-spelled name-blind and True comes back — no
    drift. Reads one blob, never waits for the lock (the tick must not stall)."""
    vdir = versions_dir(name)
    try:
        with versions_lock(name, timeout=0):
            idx = load_index(name) or {}
            items = [i for i in (idx.get('items') or []) if isinstance(i, dict)]
            cur = next((i for i in items if i.get('n') == idx.get('current')), None)
            if cur is None:
                return False
            code = load_json(vdir / f"v{cur.get('n')}.json", encoding='utf-8').get('code')
            if not isinstance(code, str):
                return False
            b = code.encode('utf-8')
            if code_hash(b) != code_hash(src) or not hash_matches(b, cur.get('code_hash')):
                return False
            if cur.get('code_hash') != code_hash(b):
                cur['code_hash'] = code_hash(b)
                idx['items'] = items
                _write_index(vdir, idx)
            return True
    except (TimeoutError, OSError, ValueError, AttributeError):
        return False


def _write_index(vdir, idx):
    _replace_bytes(vdir / 'index.json', json.dumps(idx, indent=2).encode('utf-8'))


def _backtest_running(name):
    """Does a backtest of `name` hold lib/runner's per-strategy lock (BACKTEST_LOCK) right now —
    the agent's, a scan's, a restore's re-run, 更新績效? Probed, never waited for."""
    p = _REPO_ROOT / 'strategies' / str(name) / '.backtest.lock'
    try:
        fd = os.open(p, os.O_RDWR)
    except OSError:
        return False
    try:
        try:
            if fcntl is not None:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            elif msvcrt is not None:
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        except OSError:
            return True
        if fcntl is None and msvcrt is not None:
            try:
                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            except OSError:
                pass
        return False
    finally:
        os.close(fd)


def rename(name, display_name):
    """Set strategy `name`'s DISPLAY_NAME — the sidebar's 改名, no agent turn. Only that one
    string changes: the folder, STRATEGY_NAME and every version stay as they are, and the code
    hash ignores the line (canon strategy-versions §2), so a live strategy is not flagged as
    edited and the next backtest mints nothing. Returns {"path", "display_name", "changed"}.

    Raises with a code (same attribute as restore()): BAD_NAME (name_problem), DUPLICATE
    (another strategy on this machine already shows that name), NOT_FOUND, JOB_RUNNING (a
    backtest of it is running: the spec locks the menu item then), NOT_LITERAL (the
    file's DISPLAY_NAME is not a line rename can rewrite, the file is not UTF-8 or does not
    parse — the agent can still change it in chat)."""
    value = display_name.strip() if isinstance(display_name, str) else None
    why = name_problem(value)
    if why:
        raise _coded(ValueError(f"bad name ({why})"), 'BAD_NAME')
    path = strategy_source_path(name)
    if path is None:
        raise _coded(FileNotFoundError(f"strategy {name} has no source file"), 'NOT_FOUND')
    if _backtest_running(name):
        raise _coded(RuntimeError(f"a backtest of {name} is running"), 'JOB_RUNNING')
    want = _name_fold(value)
    if any(_name_fold(s) == want for s in _shown_names(path.resolve())):
        raise _coded(ValueError("another strategy already has this name"), 'DUPLICATE')
    vdir = versions_dir(name)
    # versions_lock creates versions/; a never-backtested strategy has no index to rewrite
    lock = versions_lock(name) if vdir.is_dir() else contextlib.nullcontext()
    with lock:
        st0 = path.stat()
        before = path.read_bytes()
        bom = _BOM if before.startswith(_BOM) else b''
        try:
            text = before[len(bom):].decode('utf-8')
            if literal_name(text) == value:
                return {'path': str(path), 'display_name': value, 'changed': False}
            after = bom + set_display_name(text, value).encode('utf-8')
        except (UnicodeDecodeError, SyntaxError, ValueError) as e:
            raise _coded(ValueError(f"cannot rename here: {e}"), 'NOT_LITERAL') from None
        if code_hash(after) != code_hash(before) or literal_name(after[len(bom):].decode('utf-8')) != value:
            raise _coded(ValueError("cannot rename here: the rewrite would change the code"),
                         'NOT_LITERAL')
        idx = load_index(name) if vdir.is_dir() else None
        if idx is not None:
            items = [i for i in (idx.get('items') or []) if isinstance(i, dict)]
            # before the file: a crash in between leaves name-blind entries over the old file,
            # which still match it
            if _rekey_versions(vdir, items, before):
                idx['items'] = items
                _write_index(vdir, idx)
        _replace_bytes(path, after)
        # Wei: a renamed strategy keeps its place. The desktop sorts by "touched last" from this
        # file's mtime; a rename is not touching the code, so the old mtime goes back on
        try:
            os.utime(path, ns=(st0.st_atime_ns, st0.st_mtime_ns))
        except OSError:
            pass
    return {'path': str(path), 'display_name': value, 'changed': True}


def _keep_name(code, current):
    """v's code with the strategy file's current DISPLAY_NAME put back (Wei: a restore keeps the
    name). Unchanged when either side has no rewritable line."""
    cur_text = current[len(_BOM):] if current.startswith(_BOM) else current
    try:
        name = literal_name(cur_text.decode('utf-8'))
    except UnicodeDecodeError:
        return code
    bom = '\ufeff' if code.startswith('\ufeff') else ''
    body = code[len(bom):]
    if name is None or literal_name(body) == name:
        return code
    try:
        return bom + set_display_name(body, name)
    except (SyntaxError, ValueError):
        return code


def _coded(exc, code):
    """Tag a refusal with a stable code for the runtime's direct command (UPDATE_REQUIRED /
    LIVE / NO_VERSION …), keeping the exception type the agent-facing contract names."""
    exc.restore_code = code
    return exc


def _replace_bytes(path, data, attempts=5):
    """tmp + os.replace, retried: on Windows the replace loses to a reader holding the target
    open (a live tick importing strategy.py, the reporter reading stats.json)."""
    path = Path(path)
    tmp = path.with_name(path.name + '.restore.tmp')
    with open(tmp, 'wb') as f:
        f.write(data)
    for i in range(attempts):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            if i == attempts - 1:
                try:
                    os.remove(tmp)
                except OSError:
                    pass
                raise
            time.sleep(0.2)


def _stash_results(name):
    """Move RESTORE_STASHED out of strategies/<name>/ into versions/pre-restore/ (one slot:
    replaced as a whole when there is something to move, left alone when there is not — a
    second restore after a failed re-run must not wipe the first one's copies). Best-effort
    per file: the code is already restored, and the re-run overwrites a straggler anyway."""
    out = _REPO_ROOT / 'strategies' / str(name)
    present = [f for f in RESTORE_STASHED if (out / f).is_file()]
    if not present:
        return []
    slot = versions_dir(name) / 'pre-restore'
    shutil.rmtree(slot, ignore_errors=True)
    slot.mkdir(parents=True, exist_ok=True)
    stuck = []
    for f in present:
        for i in range(5):
            try:
                os.replace(out / f, slot / f)
                break
            except FileNotFoundError:
                break
            except OSError:
                time.sleep(0.2)
        else:
            # could not move it (Windows: a reader holds it open) — delete rather than leave
            # another version's numbers beside the restored code; the re-run rewrites it
            try:
                os.remove(out / f)
            except FileNotFoundError:
                pass
            except OSError:
                stuck.append(f)
    return stuck


def _save_unversioned(vdir, data):
    """The current file before it is overwritten: versions/pre-restore.py is the newest, older
    ones shift to pre-restore.1.py / .2.py (PRE_RESTORE_KEEP in all) — two restores over two
    different unbacktested edits keep both."""
    names = ['pre-restore.py'] + [f'pre-restore.{i}.py' for i in range(1, PRE_RESTORE_KEEP)]
    for i in range(len(names) - 1, 0, -1):
        try:
            os.replace(vdir / names[i - 1], vdir / names[i])
        except FileNotFoundError:
            pass
    _replace_bytes(vdir / names[0], data)


def restore(name, v):
    """Make version v the current one again, in place (canon §3/§5): its code goes back into
    the strategy file and index.json's `current` points at v — no new version number.
    Returns {"path", "version", "inplace", "backed_up", "stuck"} (stuck: result files that
    could neither be moved aside nor deleted — Windows sharing violations; normally []).

    It does not re-run the backtest; the caller must (the workspace's direct command does it
    in the background with BLAVE_QUIET=1; the agent runs BLAVE_MODE=backtest itself —
    references/strategy-code.md › Restoring a version). That run mints nothing: its code
    equals v's, and the runner's same-code rule keeps `current` on v.

    REFUSES, before touching any file, when the strategy is funded: a live strategy
    re-imports strategy.py every bar, so an in-place restore flips a real position with
    no warning (the 2026-08-05 incident's shape). Raises instead of returning a message
    so the refusal cannot be read as success, and reads the amounts through
    lib.portfolio.strategy_amounts() so the UI-authoritative mirror applies here too.
    An unreadable config raises out of here as well — the gate fails closed.

    Then, inside the index lock:
      - the amounts are read again: the first read happened before waiting for the lock.
      - v must be in the index, not only have a blob on disk (a half-pruned version would
        otherwise restore as "not in place" and mint a copy of itself).
      - the file's current code matches no stored version (an edit nobody backtested, a hand
        edit) → saved to versions/pre-restore.py first (older saves shift to .1 / .2),
        backed_up=True. No version holds that code, so overwriting it would lose it for good.
      - v's code is written back byte for byte except its DISPLAY_NAME, which keeps the file's
        current one (Wei: a restore keeps the name; the hash ignores that line) — tmp +
        os.replace, an amount-0 strategy still in the order settings imports this file on its
        next bar.
      - the written bytes hash to v's code_hash → current = v, last_note = v's VERSION_NOTE,
        entries still on the raw-bytes hash re-spelled name-blind (_rekey_versions)
        (otherwise the next edit that forgets to update the note stores v's old line as its
        summary), drift.json removed. They don't (a non-UTF-8 original, decoded with
        'replace' when minted) → current untouched, inplace=False, and the re-run mints a
        new version as it always did.
      - stats.json / scan.json / wf.json / pnl.png / backtest_state.json move to versions/pre-restore/: they came
        from other code, and until the re-run finishes every reader must see "no backtest",
        never v's code beside another version's numbers."""
    from lib.portfolio import strategy_amounts   # lazy: heavy module, only needed here
    # The gate below reads manager/ CWD-RELATIVE (load_portfolio_config, the UI-mirror
    # choke point). Called from anywhere else — an SSH BYO agent sitting in strategies/,
    # exactly the divergence canon §6 names — that read returns the empty default, the
    # gate passes, and a live strategy's file gets overwritten. Refuse instead.
    if Path.cwd().resolve() != _REPO_ROOT.resolve():
        raise _coded(RuntimeError(
            f"restore() must run from the workspace root ({_REPO_ROOT}) — the live-strategy "
            f"gate reads manager/portfolio_config.json relative to the working directory"), 'CWD')
    try:
        amount = float(strategy_amounts().get(name) or 0)
    except Exception as e:
        raise _coded(e, 'CONFIG_UNREADABLE')
    if amount > 0:
        raise _coded(ValueError(
            f"{name} is live (amount {amount:g} > 0) — restoring its code in place would "
            f"flip a real position on the next bar. Build the change as a new strategy "
            f"instead: references/strategy-code.md › Editing a live strategy."), 'LIVE')
    v = int(v)
    vdir = versions_dir(name)
    if not (vdir / f'v{v}.json').is_file():   # checked before the lock creates versions/
        have = [i.get('n') for i in list_versions(name) if 'n' in i]
        raise _coded(FileNotFoundError(
            f"{name} has no v{v} on this machine — only the last {VERSIONS_KEEP} versions "
            f"are kept (have: {have or 'none'})"), 'NO_VERSION')
    path = strategy_source_path(name)
    if path is None:
        raise _coded(FileNotFoundError(f"strategy {name} has no source file to restore into"),
                     'NO_SOURCE')
    with versions_lock(name):
        try:
            blob = load_json(vdir / f'v{v}.json', encoding='utf-8')
            code = blob['code']
            if not isinstance(code, str) or not code:
                raise ValueError('no code stored')
        except FileNotFoundError:   # pruned between the check above and the lock
            raise _coded(FileNotFoundError(
                f"{name} has no v{v} on this machine — only the last {VERSIONS_KEEP} versions "
                f"are kept"), 'NO_VERSION') from None
        except (OSError, ValueError, KeyError, TypeError) as e:
            raise _coded(ValueError(f"{name} v{v} is unreadable: {e}"), 'NO_VERSION') from None
        try:
            amount = float(strategy_amounts().get(name) or 0)
        except Exception as e:
            raise _coded(e, 'CONFIG_UNREADABLE')
        if amount > 0:
            raise _coded(ValueError(
                f"{name} is live (amount {amount:g} > 0) — restoring its code in place would "
                f"flip a real position on the next bar. Build the change as a new strategy "
                f"instead: references/strategy-code.md › Editing a live strategy."), 'LIVE')
        idx   = load_index(name)
        if idx is None and (vdir / 'index.json').exists():
            raise _coded(FileNotFoundError(
                f"{name}: the version list (versions/index.json) cannot be read — run one "
                f"backtest to rebuild it from the stored versions, then restore v{v}"), 'NO_VERSION')
        idx   = idx or {}
        items = [i for i in (idx.get('items') or []) if isinstance(i, dict)]
        entry = next((i for i in items if i.get('n') == v), None)
        if entry is None:
            raise _coded(FileNotFoundError(
                f"{name} v{v} is no longer in the version list — only the last "
                f"{VERSIONS_KEEP} versions are kept"), 'NO_VERSION')
        before = path.read_bytes()
        backed_up = not any(hash_matches(before, i.get('code_hash')) for i in items)
        if backed_up:
            _save_unversioned(vdir, before)
        stored_code = code.encode('utf-8')
        want = _keep_name(code, before).encode('utf-8')
        try:
            if before != want:
                _replace_bytes(path, want)
            stored = blob.get('code_hash') or entry.get('code_hash')
            inplace = (hash_matches(stored_code, stored)
                       and code_hash(path.read_bytes()) == code_hash(stored_code))
            if inplace:
                _rekey_versions(vdir, items, stored_code)
                idx.update({'v': idx.get('v', 1), 'current': v, 'last_note': version_note_of(code),
                            'items': items})
                _replace_bytes(vdir / 'index.json', json.dumps(idx, indent=2).encode('utf-8'))
        except BaseException:
            # the file must not stay on v's code while current still points elsewhere
            # (another version's numbers beside it, a drift flag on the next bar)
            if before != want:
                try:
                    _replace_bytes(path, before)
                except OSError:
                    pass
            raise
        if inplace:
            try:
                os.remove(vdir / 'drift.json')
            except OSError:
                pass
        stuck = _stash_results(name)
    return {'path': str(path), 'version': v, 'inplace': inplace, 'backed_up': backed_up,
            'stuck': stuck}
