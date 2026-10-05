import ast
import contextlib
import hashlib
import json
import os
import shutil
import threading
import time
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
RESTORE_STASHED = ('stats.json', 'scan.json', 'wf.json', 'pnl.png')
PRE_RESTORE_KEEP = 3   # versions/pre-restore.py (newest), pre-restore.1.py, pre-restore.2.py
_lock_held = threading.local()


def versions_dir(name):
    """strategies/<name>/versions/ — index.json + v<N>.json + drift.json live here."""
    return _REPO_ROOT / 'strategies' / str(name) / 'versions'


def code_hash(src_bytes):
    """An index entry's `code_hash`: sha256 of the strategy file's raw bytes, first 16
    hex chars. Truncated because the whole entry is budgeted at ~200 bytes (canon §9)
    and 64 bits is far more than "is this file still what v<N> stored" needs."""
    return hashlib.sha256(src_bytes).hexdigest()[:16]


def load_index(name):
    """versions/index.json as a dict, or None when absent / unreadable / not an object.
    Fail-soft on purpose: both callers (the runner minting the next version, the live
    tick's drift check) must treat a missing or half-written index as "no versions yet"
    rather than fail the run."""
    try:
        with open(versions_dir(name) / 'index.json', encoding='utf-8') as f:
            idx = json.load(f)
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
        with open(path, encoding='utf-8') as f:
            idx = json.load(f)
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
      - v's code is written back byte for byte (tmp + os.replace — an amount-0 strategy
        still in the order settings imports this file on its next bar).
      - the written bytes hash to v's code_hash → current = v, last_note = v's VERSION_NOTE
        (otherwise the next edit that forgets to update the note stores v's old line as its
        summary), drift.json removed. They don't (a non-UTF-8 original, decoded with
        'replace' when minted) → current untouched, inplace=False, and the re-run mints a
        new version as it always did.
      - stats.json / scan.json / wf.json / pnl.png move to versions/pre-restore/: they came
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
            with open(vdir / f'v{v}.json', encoding='utf-8') as f:
                blob = json.load(f)
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
        idx   = load_index(name) or {}
        items = [i for i in (idx.get('items') or []) if isinstance(i, dict)]
        entry = next((i for i in items if i.get('n') == v), None)
        if entry is None:
            raise _coded(FileNotFoundError(
                f"{name} v{v} is no longer in the version list — only the last "
                f"{VERSIONS_KEEP} versions are kept"), 'NO_VERSION')
        before = path.read_bytes()
        backed_up = code_hash(before) not in {i.get('code_hash') for i in items}
        if backed_up:
            _save_unversioned(vdir, before)
        want = code.encode('utf-8')
        try:
            if before != want:
                _replace_bytes(path, want)
            stored = blob.get('code_hash') or entry.get('code_hash')
            inplace = code_hash(path.read_bytes()) == stored
            if inplace:
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
