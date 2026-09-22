import glob, hashlib, inspect, json, logging, os, re, time
from datetime import datetime

from lib import guard


def _append_reconciler_log(order):
    # Best-effort in account-read mode: a full disk (measured on the fleet)
    # must not abort the reconcile loop mid-round — the order already
    # happened, and there losing the log line is the lesser failure (the next
    # account read self-corrects the position).
    #
    # self_ledger mode is different (audit P1 #2): this file IS the position
    # book — a dropped line means a real fill the bot will never know about,
    # and the next reconcile re-buys it. Trip HALT so nothing compounds the
    # gap (closes still pass; only the user resumes) — same fail-loud posture
    # as every other ledger-integrity failure.
    try:
        os.makedirs('manager', exist_ok=True)
        entry = {'ts': datetime.utcnow().isoformat(), **order}
        with open('manager/orders.jsonl', 'a') as f:
            f.write(json.dumps(entry) + '\n')
    except OSError as e:
        logging.error(f"orders.jsonl append failed: {e}")
        try:
            if load_portfolio_config().get('self_ledger') and not guard.halted():
                # trip_halt sets its in-memory flag FIRST (lib/guard) — even
                # when its own file write also fails (same full disk), this
                # process stops opening exposure on a book missing a fill
                try:
                    guard.trip_halt(
                        f"orders.jsonl write failed ({e}) — the ledger just missed "
                        f"a real fill; verify positions before resuming", "portfolio")
                finally:
                    _notify_best_effort(
                        "🚨 成交紀錄寫入失敗,帳本可能漏了一筆成交——已自動暫停"
                        "下單,請先核對「交易所實際部位」再啟動。")
        except Exception as e2:
            logging.error(f"orders.jsonl fail-loud halt itself failed: {e2}")


def _notify_best_effort(msg):
    """Telegram if paired, else log — never raises (network needs no disk,
    so this can still reach the user when every file write is failing)."""
    try:
        from lib.notify import make_sender
        make_sender()(msg)
    except Exception as e:
        logging.error(f"[notify-unavailable] ({e}) {msg}")


def _write_reconcile_snapshot(target, actual, orders, ledger=None, gates=None):
    """Record what this reconcile actually saw, for anything that needs to show
    live positions without querying the exchange itself.

    Targets are cheap to recompute anywhere (aggregate_portfolio is pure local
    arithmetic); exchange positions are not — they need the user's keys and a
    round-trip. So this is the only place `actual` is ever observed, and without
    persisting it the workspace could only ever show half the picture.

    `ledger` (self_ledger.ledger_positions() output, or None when the feature is
    off) is recorded alongside `actual` so a future workspace view can show
    "bot's own book" vs "exchange's real position" side by side instead of only
    ever seeing whichever one reconcile() happened to diff against.

    `gates` (compute_diff's out-param, {symbol: {usd, diff, entry_usd,
    reduce_usd, close_usd[, side]}}) is the only way the workspace can explain the silent
    case: target 100 / actual 78 / diff 22 with no order and no error, because
    22 is under that instrument's ENTRY gate (or, with side "reduce", an
    over-target under half a lot). `usd` is the side this round actually used;
    the two per-side values are for a reader whose live diff has since crossed
    zero. The numbers are not recomputable off-machine — they are the venue's
    own minimum / lot valued at mark, read with the user's keys.

    Best-effort: a failure here must never stop a reconcile that already placed
    orders.
    """
    try:
        os.makedirs('manager', exist_ok=True)
        doc = {
            'ts':     datetime.utcnow().isoformat(),
            'target': target,
            'actual': actual,
            'orders': orders,
        }
        if ledger is not None:
            doc['ledger'] = ledger
        if gates is not None:
            doc['gates'] = gates
        with open('manager/last_reconcile.json', 'w') as f:
            json.dump(doc, f, indent=2)
    except Exception as e:
        logging.warning(f'failed to write manager/last_reconcile.json: {e}')


def _record_order_error(symbol, exchange, error):
    """Last few order failures, for the workspace page — a reconciler that
    fails silently in a tmux log is indistinguishable from one that never
    tried (measured UX complaint). Best-effort; keeps the newest 5."""
    try:
        path = 'manager/order_errors.json'
        try:
            with open(path) as f:
                rows = json.load(f)
        except (OSError, ValueError):
            rows = []
        rows.append({'ts': datetime.utcnow().isoformat(), 'symbol': symbol,
                     'exchange': exchange, 'error': str(error)[:200]})
        with open(path, 'w') as f:
            json.dump(rows[-5:], f, indent=2)
    except Exception as e:
        logging.warning(f'failed to record order error: {e}')


# ── self-ledger (bot's own tracked position, decoupled from the exchange's
#    raw account read — see portfolio_config.json["self_ledger"]) ──────────
# Root problem: get_positions_fn() reads the ACCOUNT's real position, which on
# a single-account setup includes whatever the user opened by hand — reconcile()
# then reads that manual position as "already have it" and trades against it
# (adds to it, or closes it down to target). self_ledger fixes this not by
# reading the account differently, but by not reading it AT ALL for diffing:
# the bot instead tracks what IT has bought/sold from its own order log
# (manager/orders.jsonl, already written by _append_reconciler_log below) and
# diffs target against that running total. A position opened outside this
# process is invisible to the ledger by construction, so it can never be
# absorbed. Trade-off (see references/manager.md § self_ledger): the ledger can
# drift from the real account (missed fills, manual trades on the same symbol)
# — this only fixes "bot ignores what it doesn't own", not "bot always knows
# the true account state"; margin/liquidation checks still need the real
# get_positions_fn() read, never the ledger.
#
# UNIT OF THE BOOK — two numbers per symbol, never one. `cost` (signed USD:
# what the fills were worth WHEN THEY HAPPENED) answers "should I trade":
# target is diffed against it, so a held position never moves with the mark
# (Wei 2026-09-21: fixed quantity — what was bought is held until the signal
# changes). `qty` (signed base units the bot bought) answers "how much": a
# reduce leg sells qty × |diff| ÷ |cost|, a close sells the whole qty. The
# book used to be `cost` alone, and a close converted it back at the CURRENT
# mark — measured 2026-09-21 on paper: closing 20% above entry stranded 16.7%
# of the position, closing 20% below left a phantom long that re-sent a dead
# reduce leg every round, and with a manual holding in the same symbol it
# sold the USER's coins (the cap was the whole account, not the bot's share).
_LEDGER_SEED_PATH = 'manager/ledger_seed.json'
_ORDERS_LOG_PATH  = 'manager/orders.jsonl'
_LEDGER_ADOPTION_PATH = 'manager/ledger_migration.json'


def _load_ledger_seed():
    """{'seeded_at': iso_str, 'symbols': {symbol: {'size': signed_float,
    'qty': signed_float|None, 'ts': iso_str}}} — 'size' is the signed USD cost
    (the name predates `qty` and stays: a build from before the quantity book
    reads this same file and must keep finding its number there). 'qty' is
    None on a row written by such a build. 'seeded_at' is the whole-account cutoff from
    seed_ledger(): orders.jsonl entries at/before it are excluded for EVERY
    symbol, including symbols with no per-symbol row (a flat account seeds an
    empty symbols map, but its history must still be cut off — measured live
    2026-08-20: without this, a flat-account seed summed the box's prior
    test-trade history into a phantom position). A per-symbol 'ts'
    (zero_ledger_symbols) overrides the global cutoff for that symbol.
    Corrupt/missing file reads as no seed at all: every entry in orders.jsonl
    counts, from the start of the file."""
    empty = {'seeded_at': '', 'symbols': {}}
    try:
        with open(_LEDGER_SEED_PATH) as f:
            raw = json.load(f)
        if not isinstance(raw, dict):
            return empty
        return {
            'seeded_at': str(raw.get('seeded_at') or ''),
            'symbols': {k: {'size': float(v.get('size', 0) or 0),
                            'qty': (float(v['qty']) if v.get('qty') is not None
                                    else None),
                            'ts': str(v.get('ts') or '')}
                        for k, v in (raw.get('symbols') or {}).items()},
        }
    except (OSError, ValueError, AttributeError):
        return empty


def _save_ledger_seed(seed):
    # tmp+replace (same convention as lib/guard.py, manager/reconciler.py's
    # last-order marker): flatten() writes this file while the reconciler's
    # 5s poll may be mid-read — a half-written file parses as "no seed at
    # all", which ledger_positions() degrades into summing the entire
    # orders.jsonl from the top (a much larger phantom ledger), and that
    # mis-read would land exactly during a panic close-all.
    os.makedirs('manager', exist_ok=True)
    tmp = _LEDGER_SEED_PATH + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(seed, f, indent=2)
    os.replace(tmp, _LEDGER_SEED_PATH)


def seed_ledger(get_positions_fn, absorb=False, get_qty_fn=None):
    """One-time baseline for the self-ledger. Two modes — picking the wrong
    one on an account that HOLDS positions trades real money, so the default
    is the one that never touches what the user already owns:

    Default (absorb=False, "fresh start"): everything currently on the
    account belongs to the USER — the bot starts from a zero book and only
    ever manages what it buys from now on. THE mode for the feature's target
    user (has manual positions, wants the bot to leave them alone). Caveat
    the caller must surface: if the BOT also holds live positions at seed
    time, they become the user's — the bot will re-buy its full target on
    top (doubled exposure). Flatten the bot's own positions first.

    absorb=True: the account's current position is 100% BOT-owned as of now.
    Only correct on an account with NO manual positions mixed in (e.g.
    migrating a bot-only machine without closing anything) — on a mixed
    account this adopts the user's manual positions into the bot's book, and
    the bot will later trade them away. get_positions_fn is only called in
    this mode.

    Either mode REPLACES THE WHOLE FILE and forgets every fill recorded
    before now — a deliberate, explicit action, never called automatically by
    reconcile(). To reset only SOME symbols (e.g. after a flatten), use
    zero_ledger_symbols() instead.

    get_qty_fn (absorb only): () -> {symbol: signed base qty}. An absorbed
    row needs the QUANTITY adopted, not just its value today — without it the
    row is a legacy USD-only row (see ledger_book) and closes at the mark
    until it is first flat. lib.venue_wiring.auto_position_qty is the auto-
    wired reader; a lot-based account's `size` already is its quantity.

    Returns the seeded {symbol: signed_size} ({} for fresh start) for the
    caller to show the user.
    """
    now = datetime.utcnow().isoformat()
    symbols = {}
    if absorb:
        qtys = (get_qty_fn() or {}) if get_qty_fn else {}
        for symbol, pos in (get_positions_fn() or {}).items():
            size = float(pos.get('size', 0) or 0)
            side = pos.get('side')
            signed = size if side == 'long' else (-size if side == 'short' else 0.0)
            qty = qtys.get(symbol)
            # a quantity on the other side of the value is not this position
            if qty is not None and float(qty) * signed <= 0:
                qty = None
            symbols[symbol] = {'size': signed,
                               'qty': float(qty) if qty is not None else None,
                               'ts': now}
    # 'seeded_at' cuts off history for EVERY symbol, incl. ones with no row —
    # pre-seed orders.jsonl history must never leak into the ledger
    _save_ledger_seed({'seeded_at': now, 'symbols': symbols})
    return {k: v['size'] for k, v in symbols.items()}


def zero_ledger_symbols(symbols):
    """Reset the self-ledger baseline to flat, timestamped now, for exactly
    these symbols — every OTHER symbol's seed and accumulated history is left
    untouched. Use after closing a real position OUTSIDE the normal target-vs-
    ledger diff (flatten/close-all: manager/flatten.py) — those closes get
    logged to manager/orders.jsonl too, and without this they would be summed
    into ledger_positions() as if they were an ordinary bot trade, driving the
    ledger to a phantom position it never actually held (see
    references/manager.md § self_ledger — the flatten interaction). No-op
    (creates a zeroed entry) for a symbol with no prior seed. Safe to call even
    when self_ledger is currently off — the seed file just sits unused until
    it's turned on, and by then this IS the correct baseline.
    """
    if not symbols:
        return
    seed = _load_ledger_seed()
    now = datetime.utcnow().isoformat()
    for symbol in symbols:
        seed['symbols'][symbol] = {'size': 0.0, 'qty': 0.0, 'ts': now}
    _save_ledger_seed(seed)


def _sign(x):
    return 1 if x > 0 else (-1 if x < 0 else 0)


def _ledger_walk():
    """({symbol: {'qty', 'cost', 'legacy'}}, notes) — the seed baseline plus
    every fill logged after it, replayed in file order. `notes` is what the
    replay had to decide on its own, for the adoption report.

    Two leg formats. One carrying `signed_qty` was written by this build: an
    add grows qty and cost together, a reduce shrinks cost BY THE SHARE OF QTY
    SOLD (average cost — not by what the sale fetched, which is where the old
    book went wrong), so both reach zero together. One without it predates the
    quantity book: cost moves by `signed_diff` exactly as it always did, so the
    book a machine wakes up with after updating is the book it went to sleep
    with and the update itself never trades; its qty is `executed_qty` signed
    like `signed_diff` — the exchange-confirmed fill, a record, not a guess.

    LEGACY row = a position whose quantity cannot be known: a non-zero seed
    row without `qty` (seed_ledger --absorb from an older build), a fill with
    no `executed_qty` (hand-written place_order returning None), or a replay
    whose qty and cost ended up on opposite sides (the old close oversold into
    a manual holding). Never estimated — such a row keeps the old USD
    arithmetic and the wiring keeps sizing it at the mark, until it is next
    flat or reconcile closes it and writes it off; from there it is a quantity
    row like any other.

    Lot-based rows (capital) need no case of their own: signed_diff and
    executed_qty are both LOTS there, so qty == cost and the share sold is the
    lot count.
    """
    seed = _load_ledger_seed()
    book, notes = {}, {}

    def _row(symbol):
        return book.setdefault(symbol, {'qty': 0.0, 'cost': 0.0, 'legacy': False,
                                        'gross': 0.0})

    def _note(symbol, **kw):
        notes.setdefault(symbol, {}).update(kw)

    for symbol, srow in seed['symbols'].items():
        r = _row(symbol)
        r['cost'] = srow['size']
        if srow['qty'] is not None:
            r['qty'] = srow['qty']
            r['gross'] = abs(srow['qty'])
        elif abs(srow['size']) > 1e-9:
            r['legacy'] = True
            _note(symbol, old_format=True, legacy='seed row has no qty')

    def _tol(r):
        return max(1e-12, 1e-9 * r['gross'])

    def _settle(symbol, r):
        """Between fills of THIS build and at the end — never between old-
        format fills, whose running total must stay exactly the old book."""
        if r['legacy']:
            return
        flat_qty = abs(r['qty']) <= _tol(r)
        if flat_qty and abs(r['cost']) > 1e-9:
            # the bot holds none of it, so it cannot have cost anything: the
            # phantom the old close left behind (sold everything, booked less)
            _note(symbol, phantom_cost_dropped=round(r['cost'], 2))
            r['qty'] = r['cost'] = 0.0
        elif flat_qty:
            r['qty'] = r['cost'] = 0.0
        elif r['qty'] * r['cost'] < 0:
            r['legacy'] = True
            _note(symbol, legacy='qty and cost on opposite sides')

    try:
        with open(_ORDERS_LOG_PATH) as f:
            lines = f.readlines()
    except FileNotFoundError:
        lines = []  # brand-new machine: no fills yet, legitimately empty
    except OSError:
        # an EXISTING-but-unreadable book must not silently collapse to the
        # seed baseline — reconcile would re-buy the entire target on top of
        # real positions (2026-08-20 audit #3). Raise; reconcile's error path
        # surfaces it (Telegram + retreat), no orders placed.
        raise

    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        symbol = entry.get('symbol')
        if not symbol:
            continue
        # entries at/before this symbol's cutoff are already inside its
        # baseline. Per-symbol ts (zero_ledger_symbols) wins over the global
        # seeded_at, so zeroing one symbol never discards another symbol's
        # history — and seeded_at covers symbols flat at seed time, whose
        # pre-seed history must be excluded too (measured live 2026-08-20).
        cutoff = seed['symbols'].get(symbol, {}).get('ts') or seed['seeded_at']
        if cutoff and str(entry.get('ts') or '') <= cutoff:
            continue
        for leg in entry.get('legs') or []:
            try:
                d = float(leg.get('signed_diff') or 0)
                sq = leg.get('signed_qty')
                new_fmt = sq is not None
                if new_fmt:
                    sq = float(sq)
                elif leg.get('executed_qty') is not None and d:
                    sq = _sign(d) * abs(float(leg['executed_qty']))
            except (TypeError, ValueError):
                continue
            if not d and not sq:
                continue
            r = _row(symbol)
            if not new_fmt:
                _note(symbol, old_format=True)
                if sq is None and not r['legacy']:
                    r['legacy'] = True
                    _note(symbol, legacy='a fill has no executed_qty')
            else:
                _settle(symbol, r)
            if sq is not None:
                r['gross'] += abs(sq)

            if r['legacy'] or not new_fmt:
                r['cost'] += d
                if sq is not None:
                    r['qty'] += sq
                if abs(r['cost']) < 1e-9:
                    # flat in the old book. Whatever quantity the replay still
                    # shows is what the old close stranded on the account; the
                    # bot stopped counting it as its own then, and adopting it
                    # now would sell coins the user has been looking at as
                    # theirs. Reported, not traded.
                    if not r['legacy'] and abs(r['qty']) > _tol(r):
                        _note(symbol, stranded_qty_not_adopted=r['qty'])
                    r['qty'] = r['cost'] = 0.0
                    r['legacy'] = False
            elif r['qty'] == 0 or r['qty'] * sq > 0:
                r['qty'] += sq
                r['cost'] += d
            elif abs(sq) <= abs(r['qty']) + _tol(r):
                r['cost'] -= r['cost'] * min(1.0, abs(sq) / abs(r['qty']))
                r['qty'] += sq
            else:
                # sold through zero: the excess opens the other side at this
                # fill's own price
                over = sq + r['qty']
                r['cost'] = d * (over / sq)
                r['qty'] = over

    for symbol, r in book.items():
        _settle(symbol, r)
    # 12 significant digits: 0.003 + 0.007 is 0.009999999999999998 in floats,
    # and an order lib flooring THAT to a 0.001 step closes 0.009 of a 0.01
    # position. Far finer than any venue's step, far coarser than the noise.
    return ({k: {'qty': float(f"{r['qty']:.12g}"), 'cost': r['cost'],
                 'legacy': r['legacy']}
             for k, r in book.items()}, notes)


def ledger_book():
    """{symbol: {'qty': signed base, 'cost': signed USD, 'legacy': bool}} for
    every symbol the bot holds — see _ledger_walk. A legacy row's qty is
    whatever could be replayed and must not be sized from."""
    return {k: r for k, r in _ledger_walk()[0].items() if abs(r['cost']) > 1e-9}


def ledger_positions():
    """The bot's OWN tracked position per symbol: each symbol's seed_ledger()/
    zero_ledger_symbols() baseline plus every fill logged for it since
    (manager/orders.jsonl legs) — never the exchange's raw account position.

    A symbol with no seed at all (self_ledger turned on but seed_ledger() never
    run) sums EVERY orders.jsonl entry for it from the start of the file —
    on a flat account that is harmlessly correct, but on an account that
    already holds a live bot position it is WRONG unless every fill really is
    in that file (seed_ledger() MUST run first on an account with an existing
    position, or reconcile() re-buys the whole target on top of what already
    exists — see references/manager.md § self_ledger).

    Returns the shape get_positions_fn() returns, {symbol: {'side', 'size'}},
    where `size` is the COST in USD (what compute_diff works in — see UNIT OF
    THE BOOK above), plus 'qty' (unsigned base units; compare it to the
    account's own base size to see drift, no price involved) and
    'legacy': True on a row whose qty is not known.
    """
    out = {}
    for symbol, r in ledger_book().items():
        out[symbol] = {'side': 'long' if r['cost'] > 0 else 'short',
                       'size': abs(r['cost']), 'qty': abs(r['qty'])}
        if r['legacy']:
            out[symbol]['legacy'] = True
    return out


# "The account no longer holds it" zeroes a book without an order, so one read
# is not enough to act on: a position endpoint that answers successfully but
# wrong (a row dropped, a read one beat behind a fill) would orphan a live
# position. The wiring reports every such read here; only a second one, at
# least one reconciler poll after the first and with no contradicting read in
# between, counts. Same file shape and helpers as state/signal_gate.json.
_ACCOUNT_SHORT_PATH = 'state/ledger_account_short.json'
_ACCOUNT_SHORT_MIN_S = 5      # manager/reconciler.py POLL_INTERVAL: never the same round
_ACCOUNT_SHORT_MAX_S = 900    # unseen for 3 heartbeat rounds = not consecutive any more


def _load_account_short():
    try:
        with open(_ACCOUNT_SHORT_PATH) as f:
            raw = json.load(f)
        return {str(k): {'first': float(v['first']), 'last': float(v['last'])}
                for k, v in (raw or {}).items()}
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        return {}


def _save_account_short(pending):
    try:
        os.makedirs(os.path.dirname(_ACCOUNT_SHORT_PATH), exist_ok=True)
        tmp = _ACCOUNT_SHORT_PATH + '.tmp'
        with open(tmp, 'w') as f:
            json.dump(pending, f, indent=2)
        os.replace(tmp, _ACCOUNT_SHORT_PATH)
    except OSError as e:
        logging.warning(f'ledger_account_short persist failed: {e}')


def note_account_short(symbol, short):
    """One account read for a self_ledger reduce leg: `short` = it showed less
    than the book says the bot holds. Returns True when that is CONFIRMED (see
    above) — until then the caller must not treat the book as wrong. A read
    that is not short clears the symbol."""
    pending = _load_account_short()
    now = time.time()
    seen = pending.get(symbol)
    if not short:
        if seen:
            del pending[symbol]
            _save_account_short(pending)
        return False
    first_read = not seen or now - seen['last'] > _ACCOUNT_SHORT_MAX_S
    if first_read:
        seen = {'first': now, 'last': now}
    seen['last'] = now
    pending[symbol] = seen
    _save_account_short(pending)
    return not first_read and now - seen['first'] >= _ACCOUNT_SHORT_MIN_S


def account_short_pending(symbol):
    """True while a short read of `symbol` is on file and unresolved. A record
    older than _ACCOUNT_SHORT_MAX_S is not pending any more (the same expiry
    note_account_short uses): nobody clears it when the close leg is skipped
    before the account is read, and a stale one would hold the entry back
    every round, silently, for good."""
    seen = _load_account_short().get(symbol)
    try:
        return bool(seen) and time.time() - float(seen['last']) <= _ACCOUNT_SHORT_MAX_S
    except (KeyError, TypeError, ValueError):
        return False


def apply_ledger_writeoff(symbol, reason, **detail):
    """Zero one symbol's book and say so. For what is left after a CLOSE that
    can never be sold: less than one lot, under the venue's minimum, or a
    quantity the account no longer holds (the user closed it by hand, a
    liquidation took it). Carrying it would re-send a reduce leg that cannot
    fill every round — and, worse, read as "already long" at the next entry
    signal, so the strategy would silently sit out. Only ever called when the
    target for that side is flat: bringing the book to what the bot wanted AND
    what the account shows is not a trade and needs nobody's decision.
    Call AFTER the closing fill is in orders.jsonl — the zero row's timestamp
    is the cutoff, and a fill logged after it would be counted on top."""
    try:
        row = ledger_book().get(symbol) or {}
    except Exception:
        row = {}
    zero_ledger_symbols({symbol})
    seen = _load_account_short()
    short = seen.pop(symbol, None)
    if short:
        _save_account_short(seen)
        # what a later notification has to go on: when the account was first
        # and last read short of the book (notifications.md: not yet graded)
        detail['short_first'] = datetime.utcfromtimestamp(short['first']).isoformat()
        detail['short_last'] = datetime.utcfromtimestamp(short['last']).isoformat()
    logging.warning(f"[ledger] {symbol}: wrote off qty={row.get('qty', 0):g} "
                    f"cost={row.get('cost', 0):.2f} ({reason})")
    guard.audit('ledger_writeoff', symbol=symbol, reason=reason,
                qty=row.get('qty', 0), cost=round(row.get('cost', 0) or 0, 2),
                **detail)


def _report_ledger_adoption():
    """Once per machine: what the quantity book made of a book that predates
    it (manager/ledger_migration.json + one audit line). Nothing is rewritten —
    the replay is a pure function of files this build did not change — so this
    is the record of a decision, not a migration step that can half-run."""
    if os.path.exists(_LEDGER_ADOPTION_PATH):
        return
    try:
        book, notes = _ledger_walk()
        old = {k: v for k, v in notes.items() if v.get('old_format')}
        if not old:
            return
        rows = {k: {'cost': round(book[k]['cost'], 2), 'qty': book[k]['qty'],
                    'mode': 'legacy' if book[k]['legacy'] else 'qty',
                    **{n: v for n, v in old[k].items() if n != 'old_format'}}
                for k in old}
        os.makedirs('manager', exist_ok=True)
        tmp = _LEDGER_ADOPTION_PATH + '.tmp'
        with open(tmp, 'w') as f:
            json.dump({'ts': datetime.utcnow().isoformat(), 'symbols': rows}, f, indent=2)
        os.replace(tmp, _LEDGER_ADOPTION_PATH)
        guard.audit('ledger_adopted', symbols=rows)
        logging.warning(f"[ledger] quantity book adopted a pre-quantity ledger: {rows}")
    except Exception as e:
        logging.warning(f"[ledger] adoption report failed: {e}")


# ── signal gate (啟動,等新訊號才進場 — resume_wait) ─────────────────────────
# state/signal_gate.json = {strategy: position_value_recorded_at_resume}.
# Written by the runtime's resume_wait command right before it clears HALT.
# While a funded strategy's CURRENT state.json position equals its recorded
# value, that strategy has "no new signal yet": its symbol is excluded from
# reconciling entirely — no catch-up entry, and no close-on-removal against
# whatever the ledger/book already holds. The moment the position value
# differs, the gate lifts PERMANENTLY (removed from the file) and the strategy
# trades normally from then on. MultiCharts-style: the start button never
# places orders; only a signal change does.
_SIGNAL_GATE_PATH = 'state/signal_gate.json'


def _load_signal_gate():
    try:
        with open(_SIGNAL_GATE_PATH) as f:
            raw = json.load(f)
        return {str(k): float(v) for k, v in (raw or {}).items()}
    except (OSError, ValueError, TypeError, AttributeError):
        return {}


def _save_signal_gate(gate):
    try:
        os.makedirs(os.path.dirname(_SIGNAL_GATE_PATH), exist_ok=True)
        tmp = _SIGNAL_GATE_PATH + '.tmp'
        with open(tmp, 'w') as f:
            json.dump(gate, f, indent=2)
        os.replace(tmp, _SIGNAL_GATE_PATH)
    except OSError as e:
        logging.warning(f'signal_gate persist failed: {e}')


# ── market dimension (spot vs swap) ─────────────────────────────────────────
# A strategy declares MARKET = "spot" in its strategy.py (same constant the
# platform's portfolio_reporter reads); undeclared = "swap" — every pre-2026-08
# fleet strategy is a perp strategy, so the default keeps them unchanged.
# Spot and swap flows through the SAME reconcile pipeline, distinguished by the
# target/actual KEY: swap keys stay the plain canonical symbol ("BTCUSDT",
# backward compatible with every existing snapshot/consumer), spot keys carry
# an "@spot" suffix ("BTCUSDT@spot"). place_order wirings split the key via
# split_key() and route to the venue's spot or perp execution.

_MARKET_RE = re.compile(r'^\s*MARKET\s*=\s*["\']([a-z]+)["\']', re.M)
SPOT_SUFFIX = '@spot'


def strategy_market(name):
    """'spot' | 'swap' from the strategy.py MARKET constant (default swap)."""
    try:
        with open(f'strategies/{name}/strategy.py') as f:
            m = _MARKET_RE.search(f.read())
        return m.group(1) if m else 'swap'
    except OSError:
        return 'swap'


def market_key(symbol, market):
    """Canonical reconcile key: plain symbol for swap, symbol@spot for spot."""
    return symbol + SPOT_SUFFIX if market == 'spot' else symbol


def split_key(key):
    """'BTCUSDT@spot' -> ('BTCUSDT', 'spot'); 'BTCUSDT' -> ('BTCUSDT', 'swap')."""
    key = str(key)
    if key.endswith(SPOT_SUFFIX):
        return key[:-len(SPOT_SUFFIX)], 'spot'
    return key, 'swap'


def spot_symbols():
    """Plain symbols whose SPOT inventory the reconciler must read = symbols of
    funded spot strategies (amount != 0 — position 0 still needs the inventory
    visible, or a target that drops to 0 could never sell down). SCOPING RULE:
    only these ever enter `actual` — personal coins in any other symbol must
    never grow sell orders."""
    config = load_portfolio_config()
    amounts = strategy_amounts(config)
    exchanges = config.get('exchanges', {})
    out = set()
    for name, state in load_all_states().items():
        sym = (state.get('symbol') or '').replace('-', '').upper()
        if sym and exchanges.get(name) and float(amounts.get(name, 0)) != 0 \
                and strategy_market(name) == 'spot':
            out.add(sym)
    return out


_SPOT_SCOPE_PATH = 'manager/spot_scope.json'


# threshold default MUST track manager/reconciler.py THRESHOLD (both 10):
# a scope threshold above the reconcile one strands inventory in scope forever
# (rows below reconcile threshold never sell, never leave scope) — audit L1
def spot_scope(inventory_value_fn, threshold=10):
    """{symbol: usd_value} of every spot inventory the reconciler must treat
    as `actual` — and the rule that makes REMOVING a spot strategy exit its
    position instead of orphaning it (futures parity: strategy leaves →
    position closes).

    Scope = funded spot strategies (spot_symbols) ∪ previously-managed symbols
    persisted in manager/spot_scope.json. A symbol leaves the persisted scope
    only when its inventory value drops below the reconcile threshold — so
    after removal the actual-only row keeps generating sell orders until the
    inventory is gone. Personal coins in symbols no strategy targets never
    enter; but a targeted symbol's spot inventory is ONE pool — coins the
    user holds in the same symbol are co-managed with the strategy's (incl.
    the removal sell-down). Say so when a user asks; it is the accepted
    trade-off of inventory-based reconciling (audit M5).
    inventory_value_fn(symbol) -> USD value; its errors PROPAGATE
    (a failed read silently dropping a symbol from scope would strand
    inventory — same error contract as get_positions)."""
    targeted = spot_symbols()
    try:
        with open(_SPOT_SCOPE_PATH) as f:
            prev = set(json.load(f))
    except (OSError, ValueError):
        prev = set()
    values = {}
    for sym in sorted(targeted | prev):
        values[sym] = float(inventory_value_fn(sym))
    keep = targeted | {s for s, v in values.items() if v >= threshold}
    try:  # best-effort persist — next round recomputes from targets anyway
        os.makedirs('manager', exist_ok=True)
        with open(_SPOT_SCOPE_PATH, 'w') as f:
            json.dump(sorted(keep), f)
    except OSError as e:
        logging.warning(f'spot_scope persist failed: {e}')
    return values


# ── UI-authoritative 下單設定 (deployment redline L2) ───────────────────────
# manager/amounts.ui.json is written by the platform runtime (command_listener)
# after every successful web save of amounts/exchanges — the LAST UI-confirmed
# copy. When it exists, load_portfolio_config() REPLACES the returned dict's
# amounts/exchanges with it — ONE choke point, so every downstream reader
# (aggregate_portfolio, spot_symbols, strategy_amounts, resume_wait, venue
# detection…) gets the override for free instead of each re-implementing it
# (audit P1-1: a guard on a helper nothing calls is a guard on dead code).
# An agent talked into hand-editing the config can no longer change what
# trades. Missing or corrupt file = fail-open, exactly the pre-guard behavior
# (incl. the legacy weights fallback): the guard only tightens after the
# user's first UI save. A mismatch alerts the user once (24h cooldown via a
# state/ stamp-file mtime) so the override is never silent. Every OTHER key
# (execution, asset_specs, self_ledger…) is untouched — order-style etc. stay
# agent-editable.
_UI_MIRROR_PATH = 'manager/amounts.ui.json'
_UI_ALERT_STAMP_PATH = 'state/ui_amounts_alert'
_UI_ALERT_COOLDOWN_S = 24 * 3600
_UI_ALERT_MSG = ('網頁儲存與機器設定不一致,以投資組合頁為準——'
                 '請重存一次下單設定')
# The event half has its own, shorter stamp. lib/events says "cooldown is the
# platform's job", but the platform's 6h P2 cooldown only gates the Telegram
# exit — every event still lands and counts against DAILY_EVENT_QUOTA (500).
# load_portfolio_config runs on every strategy tick, so a 1-min strategy with
# a persistent mismatch is 1,440 events/day: quota gone by 08:20 and that
# user's P1 halt / order_error silently dropped for the rest of the day.
# 1h (not the TG 24h): 24/day per distinct diff stays far under quota, and
# the workspace event list still sees a mismatch that reappears within the
# day. The stamp body is the diff fingerprint, so a NEW mismatch (different
# strategy / amount) is not hidden behind an old one's window.
_UI_EVENT_STAMP_PATH = 'state/ui_amounts_event'
_UI_EVENT_COOLDOWN_S = 3600


def _load_ui_mirror():
    """{'amounts': {name: float}, 'exchanges': {name: str}} from the UI
    mirror, or None when absent/invalid (fail-open — see section comment)."""
    try:
        with open(_UI_MIRROR_PATH) as f:
            raw = json.load(f)
        amounts = raw.get('amounts')
        exchanges = raw.get('exchanges')
        if not isinstance(amounts, dict) or not isinstance(exchanges, dict):
            return None
        return {'amounts': {str(k): float(v) for k, v in amounts.items()},
                'exchanges': {str(k): str(v if v is not None else '')
                              for k, v in exchanges.items()}}
    except (OSError, ValueError, TypeError):
        return None


def _ui_event_due(diff):
    """True unless a ui_override event for this same `diff` landed within
    _UI_EVENT_COOLDOWN_S. Stamps BEFORE the caller emits (same trade-off as
    the Telegram stamp below); any stamp read/write error → True, one extra
    event beats a missed one."""
    try:
        key = hashlib.sha1(json.dumps(diff, sort_keys=True, default=str)
                           .encode()).hexdigest()
    except Exception as e:
        logging.warning(f'ui override event key failed: {e}')
        return True
    try:
        with open(_UI_EVENT_STAMP_PATH) as f:
            same = f.read().strip() == key
        if same and time.time() - os.path.getmtime(_UI_EVENT_STAMP_PATH) < _UI_EVENT_COOLDOWN_S:
            return False
    except OSError:
        pass
    try:
        os.makedirs(os.path.dirname(_UI_EVENT_STAMP_PATH), exist_ok=True)
        with open(_UI_EVENT_STAMP_PATH, 'w') as f:
            f.write(key)
    except OSError as e:
        logging.warning(f'ui override event stamp failed: {e}')
    return True


def _ui_override_alert(diff=None):
    """Tell the user the UI copy overrode the config — Telegram once per 24h,
    event once per 1h per distinct `diff`. Stamps are written BEFORE sending
    so a slow send can't spam; a failed stamp write still sends (a broken disk
    already alerts loudly elsewhere — silence here would hide that the agent's
    change didn't take).
    `diff` = whatever identifies this mismatch (config vs UI amounts/exchanges);
    the event half dedups on it — see _UI_EVENT_STAMP_PATH."""
    try:
        from lib.events import emit
        if _ui_event_due(diff):
            emit("ui_override")
    except Exception:
        pass
    try:
        if os.path.exists(_UI_ALERT_STAMP_PATH) and \
                time.time() - os.path.getmtime(_UI_ALERT_STAMP_PATH) < _UI_ALERT_COOLDOWN_S:
            return
        os.makedirs(os.path.dirname(_UI_ALERT_STAMP_PATH), exist_ok=True)
        with open(_UI_ALERT_STAMP_PATH, 'w') as f:
            f.write(datetime.utcnow().isoformat())
    except OSError as e:
        logging.warning(f'ui override alert stamp failed: {e}')
    try:
        from lib.notify import send_text
        send_text(_UI_ALERT_MSG)
    except Exception as e:
        logging.error(f'[notify-unavailable] ({e}) {_UI_ALERT_MSG}')


def load_portfolio_config():
    """Load portfolio_config.json from manager/ directory.

    Deployment redline (L2): when manager/amounts.ui.json exists, the
    returned dict's `amounts`/`exchanges` come from IT — see the
    UI-authoritative section above. Single choke point for the override."""
    path = 'manager/portfolio_config.json'
    if not os.path.exists(path):
        config = {'account_value': 0, 'weights': {}, 'exchanges': {}, 'asset_specs': {}}
    else:
        with open(path) as f:
            config = json.load(f)
    ui = _load_ui_mirror()
    if ui is not None and isinstance(config, dict):
        if config.get('amounts') != ui['amounts'] \
                or config.get('exchanges') != ui['exchanges']:
            _ui_override_alert((config.get('amounts'), config.get('exchanges'), ui))
        config['amounts'] = ui['amounts']
        config['exchanges'] = ui['exchanges']
    return config


def portfolio_members():
    """Strategy names that belong to the portfolio — the keys of
    portfolio_config["exchanges"].

    There is deliberately no separate membership list. `exchanges` is already
    the hand-maintained record of "this strategy is deployed to trade on X",
    already the thing manager.py never overwrites, and already what decides
    whether a strategy trades. Making it decide weighting too means one list
    instead of two that can disagree.

    Returns None when nothing has been routed yet — "no list has been drawn up"
    rather than "the list is empty". Callers then weight everything, which is
    the behaviour that existed before members did, so a fresh machine still
    works before the user has deployed anything.

    Why it matters: weights sum to 1 across whatever goes into the optimiser.
    A backtest-only experiment left in that pool takes a share of the capital
    purely by existing, and the strategies actually trading get sized down for
    it — silently, since nothing anywhere reports that split.

    Deployment redline (L2): the exchanges dict read here is already the
    UI-authoritative copy — load_portfolio_config applies the override.
    """
    exchanges = load_portfolio_config().get('exchanges') or {}
    return set(exchanges) or None


def load_all_states():
    """Load all strategy state files. Returns {strategy_name: state_dict}."""
    states = {}
    for path in glob.glob('strategies/*/state.json'):
        name = os.path.basename(os.path.dirname(path))
        try:
            with open(path) as f:
                states[name] = json.load(f)
        except Exception as e:
            logging.warning(f"Failed to load state {path}: {e}")
    return states


def strategy_amounts(config=None):
    """{strategy: dollars} — the per-strategy sizing base.

    `amounts` is canonical (2026-08-03: 金額是介面也是儲存 — what the user
    typed is what sizes positions, and it never drifts with equity). Configs
    from before the change have no `amounts`; for those, fall back to the old
    account_value × leverage × weight expression so existing deployments keep
    trading identically until they are re-saved from the web.

    Deployment redline (L2): a config loaded via load_portfolio_config already
    carries the UI-authoritative amounts (mirror override, incl. over this
    legacy fallback — the mirror always has an `amounts` dict).
    """
    config = config if config is not None else load_portfolio_config()
    amounts = config.get('amounts')
    if isinstance(amounts, dict):
        return {k: float(v) for k, v in amounts.items()}
    account_value = float(config.get('account_value', 0))
    leverage      = float(config.get('leverage', 1.0))
    weights       = config.get('weights', {}) or {}
    return {k: account_value * leverage * float(w) for k, w in weights.items()}


def aggregate_portfolio():
    """
    Aggregate all strategy states into net target positions using portfolio config.

    target[symbol] = Σ(amount_i × position_i)  (in account currency)

    amount_i is the strategy's dollar allocation (portfolio_config["amounts"],
    see strategy_amounts) — "what this strategy trades with at position=1";
    position is the strategy's signal and may be a fractional scaling factor
    (vol-scaled strategies emit 0.5, 1.8, …), not just ±1.

    Returns {symbol: {'side': 'long'|'short'|None, 'size': float,
                       'exchange': str, 'asset_spec': dict|None}}

    exchange and asset_spec are taken from portfolio_config — not from state.json.
    asset_spec: None = fractional sizing (qty = abs(signed_diff) / price). Example for futures:
      {"type": "futures_contracts", "contract_value": 200,
       "currency": "TWD", "lot_size": 1}

    Strategies with no amount, missing symbol, or missing exchange in config are skipped.
    """
    config        = load_portfolio_config()
    amounts       = strategy_amounts(config)
    exchanges     = config.get('exchanges', {})
    asset_specs   = config.get('asset_specs', {})
    states        = load_all_states()
    totals        = {}
    gate          = _load_signal_gate()
    lifted        = set()

    for name, state in states.items():
        symbol     = state.get('symbol')
        # canonical symbol key: dashless uppercase (BTCUSDT) — strategies write
        # Binance-style, OKX reports dashed; without one canon the reconciler
        # sees "BTCUSDT target" and "BTC-USDT actual" as two symbols and churns
        symbol     = symbol.replace('-', '').upper() if symbol else symbol
        exchange   = exchanges.get(name)
        position   = float(state.get('position', 0))
        amount     = float(amounts.get(name, 0))
        asset_spec = asset_specs.get(name)

        if not symbol or not exchange or amount == 0:
            continue

        # signal gate (resume_wait): the strategy's signal hasn't changed
        # since the user started with 「等新訊號才進場」 — mark it; the moment
        # the value differs the gate lifts PERMANENTLY. Checked only for
        # funded strategies (the ones that could trade at all).
        gated = False
        if name in gate:
            # "new signal" = the DIRECTION changed (enter, exit, or flip —
            # sign including zero), not any value change: a vol-scaled
            # strategy re-computing 0.5→0.52 same-direction is a sizing
            # adjustment, not a new trading decision, and must not lift the
            # wait (audit #6, Wei 2026-08-20). For ±1/0 strategies this is
            # identical to exact-value comparison.
            def _sign(x):
                return 1 if x > 0 else (-1 if x < 0 else 0)
            if _sign(position) != _sign(gate[name]):
                logging.info(f"[portfolio] signal gate lifted for {name} "
                             f"({gate[name]:g}→{position:g}) — trading normally")
                lifted.add(name)
            else:
                gated = True

        contribution = amount * position

        # spot and swap are different inventories — same symbol, different key,
        # so a spot strategy and a perp strategy on BTCUSDT never net against
        # each other (they'd converge the WRONG account's position)
        market = strategy_market(name)
        key = market_key(symbol, market)

        if key not in totals:
            totals[key] = {'signed': 0.0, 'exchange': exchange,
                           'asset_spec': asset_spec, 'market': market,
                           'contributors': [], 'gated': False}
        totals[key]['signed'] += contribution
        # ANY gated funded contributor gates the whole symbol — with mixed
        # gating, trading the un-gated part would immediately "correct" the
        # gated strategy's absent contribution, defeating the wait
        totals[key]['gated'] = totals[key]['gated'] or gated
        totals[key]['contributors'].append({
            'strategy':          name,
            'position':          position,
            'amount':            amount,
            'contribution': round(contribution, 4),
        })

    result = {}
    for key, data in totals.items():
        s = data['signed']
        if data['market'] == 'spot' and s < 0:
            # spot cannot short — a net-negative spot target is clamped to
            # flat, loudly: the strategy author meant short exposure the venue
            # cannot express, silence would misreport what is being traded
            logging.warning(
                f"[portfolio] {key}: net target {s:.2f} is SHORT on a spot "
                f"market — clamped to 0 (spot cannot short)")
            s = 0.0
        result[key] = {
            'side':         'long' if s > 0 else ('short' if s < 0 else None),
            'size':    abs(s),
            'exchange':     data['exchange'],
            'asset_spec':   data['asset_spec'],
            'market':       data['market'],
            'contributors': data['contributors'],
            'gated':        data['gated'],
        }
    if lifted:
        # merge-on-save (audit #7): re-load the file and remove ONLY the lifted
        # names — dumping our stale in-memory copy would clobber a gate that
        # resume_wait rewrote mid-round (lost update: the fresh gate entry
        # vanishes and that strategy catches up next round against the user's
        # explicit choice).
        fresh = _load_signal_gate()
        changed = False
        for name in lifted:
            if name in fresh:
                del fresh[name]
                changed = True
        if changed:
            _save_signal_gate(fresh)
    return result


def _resolve_threshold(threshold, symbol, reduce_only=False):
    """`threshold` is either a flat number or a callable(symbol, reduce_only).
    manager/reconciler passes the callable so ENTRY legs can be gated at the
    venue's own minimum order size (an entry under one lot rounds UP to a whole
    lot and then gets sold back — real fees, every round) and REDUCE legs at
    half a lot (an over-target under that would ceil-sell a whole lot and get
    bought straight back). A reduce gate must stay under one lot so a one-lot
    position is always closable. The callable owns its own fallback."""
    return threshold(symbol, reduce_only) if callable(threshold) else threshold


def _close_threshold(threshold, symbol):
    """The gate for a leg that takes the WHOLE position off — target flat, or
    the close leg of a flip: the flat threshold, not the half-lot reduce gate.

    Half a lot is there to stop a PARTIAL reduce from ceil-selling a lot that
    gets bought straight back; a full close has no remainder and nothing buys
    it back (target 0 → no entry leg; a flip's entry leg is gated on its own
    side). Under self_ledger the diff is the book's COST while half a lot is
    priced at the mark, so a one-lot position that more than doubled could
    never be closed — the signal said flat and no order went out, every round.
    Account-read mode is untouched by construction: a swap position is whole
    lots, already over half of one. The flat floor stays, so dust under it is
    left alone exactly as before. A callable without `.flat` (hand-written)
    keeps answering for itself."""
    if not callable(threshold):
        return threshold
    flat = getattr(threshold, 'flat', None)
    return threshold(symbol, True) if flat is None else flat


def compute_diff(target, actual, threshold=10, gates=None):
    """
    Compute required position adjustments.
    target:  output of aggregate_portfolio()
    actual:  {symbol: {'side': 'long'|'short'|None, 'size': float}}
    Returns: list of {symbol, signed_diff, exchange, asset_spec}
      signed_diff > 0 → need to buy
      signed_diff < 0 → need to sell/short
      asset_spec → passed through from portfolio_config for place_order to use

    `threshold` is a flat number or a callable(symbol, reduce_only) (see
    _resolve_threshold); it is account-currency scale (crypto notional) and meaningless
    for a symbol whose 'size' is a LOT COUNT (asset_specs[strategy]["type"] ==
    "futures_contracts", e.g. capital/TW futures — see strategy_amounts):
    diffs there are single/low-double-digit lots, so a currency threshold of
    10 would silently swallow every order, including a close-on-removal
    (target absent, asset_spec None — checked via `exchange` too). Those rows
    skip `threshold` entirely; their own place_order_fn applies the real
    minimum (e.g. reconciler.py's _capital_place_order round-half-up gate).

    `gates` is an optional OUT dict (return value unchanged — hand-written
    callers exist): a row with either side above the flat threshold is recorded
    as {symbol: {'usd': gate this round, 'diff': signed_diff,
    'entry_usd': .., 'reduce_usd': .., 'close_usd': ..[, 'side': 'reduce']}}, placed or not, so
    the workspace can show the number instead of leaving "diff 22, no order, no
    error" unexplained. `usd`/`diff`/`side` are the shipped shape and do not
    move; BOTH sides are carried because the live diff a reader colours can
    have flipped sign since this round — with one side only it would colour a
    buy against the reduce gate. Flat-gate rows are left out on both sides —
    there is nothing to explain there.
    """
    orders = []
    all_symbols = set(target) | set(actual)

    for symbol in all_symbols:
        t = target.get(symbol, {'side': None, 'size': 0, 'exchange': None, 'asset_spec': None})
        a = actual.get(symbol, {'side': None, 'size': 0})

        t_signed = (t['size']         if t.get('side') == 'long'  else
                    -t['size']        if t.get('side') == 'short' else 0)
        a_signed = (a.get('size', 0)  if a.get('side') == 'long'  else
                    -a.get('size', 0) if a.get('side') == 'short' else 0)

        diff = t_signed - a_signed
        if diff == 0:
            continue
        asset_spec = t.get('asset_spec')
        is_lot_based = ((asset_spec or {}).get('type') == 'futures_contracts'
                         or t.get('exchange') == 'capital' or a.get('exchange') == 'capital')
        # A row whose |target| is SMALLER than what is held carries a reduce
        # leg (shrink, or a close when the target is gone) — gated on its own
        # side (the reconciler's callable answers half a lot there, never a
        # whole one: that is how a position of exactly one lot becomes
        # impossible to close). A flip is over both legs' gates by
        # construction (|actual| + |target|); its legs are gated per side
        # below.
        reduces = abs(t_signed) < abs(a_signed)
        if not is_lot_based:
            # Resolved once and reused: on the reconciler's callable this is a
            # venue round-trip (cached, but only per symbol per round).
            gate = _resolve_threshold(threshold, symbol, reduces)
            # Target flat, or a flip: the row carries a whole-position close,
            # gated flat (_close_threshold). `usd` below records what was
            # applied; entry_usd / reduce_usd stay the symbol's two side gates.
            close_gate = _close_threshold(threshold, symbol)
            applied = (min(gate, close_gate)
                       if a_signed != 0 and t_signed * a_signed <= 0 else gate)
            # Recorded only when above the flat threshold — the workspace
            # reads absence as "the flat gate, nothing to explain". The
            # reconciler's callable carries its flat value as `.flat`; a bare
            # number is its own, and an older hand-written callable still
            # answers flat on the reduce side (what used to be asked here).
            if gates is not None:
                # The other side too: this snapshot is read against a LIVE
                # diff, which drifts across the gate's own sign — recording one
                # side is what let the page colour a buy-back green against the
                # reduce gate it happened to store last round.
                other = _resolve_threshold(threshold, symbol, not reduces)
                entry_gate, reduce_gate = (other, gate) if reduces else (gate, other)
                flat = getattr(threshold, 'flat', None)
                if flat is None:
                    flat = reduce_gate
                # Either side, not just this round's: a symbol whose reduce gate
                # is flat still needs its entry gate on record for the round the
                # diff flips sign. (Not equivalent to `gate > flat` — that is
                # only this round's side.)
                if entry_gate > flat or reduce_gate > flat:
                    # close_usd: what a reader must colour the LIVE diff against
                    # when it holds a position and the target is flat or on the
                    # other side — min(that side's gate, close_usd), the `applied`
                    # above. With the two side gates alone it paints "won't
                    # trade" on a close that does go out.
                    gates[symbol] = {'usd': applied, 'diff': diff,
                                     'entry_usd': entry_gate,
                                     'reduce_usd': reduce_gate,
                                     'close_usd': close_gate}
                    if reduces:
                        gates[symbol]['side'] = 'reduce'
            if abs(diff) < applied:
                continue

        orders.append({
            'symbol':           symbol,
            'market':           split_key(symbol)[1],
            'signed_diff': diff,
            # Symbols present only in `actual` (closing a strategy that left the
            # portfolio) have no target entry. Auto-wired get_positions does
            # NOT tag rows with a venue, so this is often None there — the
            # order log's legs carry the venue the wiring actually routed to,
            # which is the truthful record anyway.
            'exchange':         t.get('exchange') or a.get('exchange'),
            'asset_spec':       t.get('asset_spec'),
            'contributors':     t.get('contributors', []),
        })

    return orders


def reconcile(get_positions_fn, place_order_fn, threshold=10, send_telegram_fn=None):
    """
    Full reconciliation cycle:
      1. aggregate_portfolio() → target (weighted positions × account value, in account currency)
      2. get_positions_fn()    → actual exchange positions (in account currency)
      3. compute_diff()        → place orders

    place_order_fn(symbol, signed_diff, asset_spec, reduce_only=False):
      signed_diff > 0 → buy  (increase long / reduce short)
      signed_diff < 0 → sell (increase short / reduce long)
      reduce_only=True → close-only leg of a position flip; pass to exchange reduce-only flag.
      asset_spec: dict from portfolio_config["asset_specs"], or None for default (fractional qty, no lot constraint).
        Use it to convert signed_diff → native qty/contracts/lots.

    Position flips (long→short or short→long) are split into two calls:
      1. place_order_fn(symbol, -actual, asset_spec, reduce_only=True)   ← close existing
      2. place_order_fn(symbol, target,  asset_spec, reduce_only=False)  ← open new
    This prevents simultaneous long+short on hedge-mode exchanges (OKX 兩倉模式, etc.).
    If place_order_fn does not accept reduce_only, the kwarg is silently dropped.

    Kill switch: while state/HALT exists, legs that ADD exposure are denied here
    (audited to state/audit.jsonl) before place_order_fn is called. Legs that
    reduce or close a position always go through — see lib/guard.py.

    Returns the orders that got AT LEAST ONE confirmed fill this round — not
    every order attempted. Callers use truthiness to schedule an immediate
    convergence re-run (force_next); returning failed orders too would turn a
    persistent failure (bad key, insufficient margin) into a poll-interval
    retry storm — failures instead wait for the next state change / heartbeat.
    """
    config  = load_portfolio_config()
    msgs    = config.get('messages', {})

    def _msg(key, default, **kw):
        return msgs.get(key, default).format(**kw)

    # A notification is sent only after its order is in orders.jsonl, and a
    # failed one (Telegram 429 / "chat not found", or a bad custom template in
    # messages) is logged and dropped: raising here once lost a real fill from
    # the ledger and skipped every symbol after it in the round.
    def _notify(key, default, **kw):
        if not send_telegram_fn:
            return
        try:
            text = _msg(key, default, **kw)
        except (KeyError, ValueError, IndexError) as e:
            logging.error(f"[reconcile] messages template '{key}' is broken "
                          f"({type(e).__name__}: {e}) — notification not sent for "
                          f"{kw.get('symbol')}")
            return
        try:
            send_telegram_fn(text)
        except Exception as e:
            logging.warning(f"[reconcile] notification dropped ({e}): {key} {kw.get('symbol')}")

    # TOCTOU guard (audit #4): a round that STARTED under HALT must never open
    # exposure, even if the user clears the halt mid-round — this round's gate/
    # target were computed from pre-resume state (e.g. resume_wait writes the
    # signal gate and THEN clears HALT; a round already past its gate read
    # would otherwise place the exact catch-up orders the user opted out of).
    # Clearing HALT changes the reconciler's watched __halt__ mtime, so a
    # clean round follows within one poll tick — the cost is one round's delay.
    halted_at_start = guard.halted()

    target = aggregate_portfolio()
    actual = get_positions_fn()
    # Defense in depth: target keys are canonical (dashless uppercase) since
    # aggregate; an account lib / hand-written get_positions returning venue
    # format ('BTC-USDT') would otherwise split one instrument into two rows —
    # buy leg on one, close leg on the other, churning fees every round (and
    # under HALT the close leg still passes: it would quietly flatten a real
    # position). Normalize here so no wiring mistake can reach compute_diff.
    def _canon_key(k):
        sym, market = split_key(str(k))
        return market_key(sym.replace('-', '').upper(), market)
    actual = {_canon_key(k): v for k, v in (actual or {}).items()}

    # self_ledger (portfolio_config.json): diff — and every flip/reduce-only
    # decision in the loop below — against the bot's OWN tracked position
    # (lib.portfolio.ledger_positions), not the raw exchange read, so a
    # position the user opened by hand is never read as "already have it" and
    # never split into a reduce-only close leg against it. `actual` (the real
    # exchange read) still feeds the snapshot below for drift comparison / a
    # future workspace view — it is only skipped as the DIFFING input here.
    # See references/manager.md § self_ledger.
    ledger = None
    if config.get('self_ledger'):
        # Fail loud without a seed (audit P1-6, mandatory since users enable
        # this themselves): an unseeded ledger silently sums the ENTIRE
        # orders.jsonl history — on any machine with prior trading that is a
        # plausible-looking but wrong book, and the bot would trade to
        # "correct" it. Raising here surfaces as the reconciler's normal
        # error path (Telegram + retreat to heartbeat), no orders placed.
        if not _load_ledger_seed()['seeded_at']:
            raise RuntimeError(
                "self_ledger is on but manager/ledger_seed.json has no baseline — "
                "run `python3 manager/seed_ledger.py` first (see "
                "references/manager.md § self_ledger); refusing to trade on an "
                "unseeded ledger")
        _report_ledger_adoption()
        ledger = {_canon_key(k): v for k, v in (ledger_positions() or {}).items()}
    diff_actual = ledger if ledger is not None else actual

    # signal gate (resume_wait): a gated symbol is excluded from BOTH sides of
    # the diff — no catch-up entry (absent target would be wrong: it exists,
    # it's gated), and no close-on-removal against whatever the book already
    # holds. The gate lifts inside aggregate_portfolio() the moment the
    # strategy's signal changes; from that round on the symbol diffs normally.
    gated_symbols = {k for k, v in target.items() if v.get('gated')}
    full_target = target  # snapshot keeps gated rows (flagged 'gated': True)
    if gated_symbols:
        logging.info(f"[reconcile] signal-gated (waiting for a new signal): "
                     f"{sorted(gated_symbols)}")
        target = {k: v for k, v in target.items() if k not in gated_symbols}
        diff_actual = {k: v for k, v in diff_actual.items() if k not in gated_symbols}

    # per-symbol venue gates, for the snapshot (unrelated to gated_symbols
    # above — that is the SIGNAL gate)
    entry_gates = {}
    orders = compute_diff(target, diff_actual, threshold, gates=entry_gates)

    # Written before placing, so it records the state that WAS acted on. A
    # reconcile that crashes mid-loop still leaves the observation behind.
    # full_target, not the filtered dict (audit #8): a gated strategy's target
    # must stay visible to the workspace view — carrying 'gated': True — not
    # vanish while it waits for its signal.
    _write_reconcile_snapshot(full_target, actual, orders, ledger=ledger,
                              gates=entry_gates)

    # Checked once via signature inspection (not a runtime try/except TypeError) so a
    # TypeError raised *after* place_order_fn already submitted the order — e.g. while
    # processing the exchange response — can't be misread as "no reduce_only support"
    # and trigger a second, duplicate submission.
    try:
        _place_params = inspect.signature(place_order_fn).parameters
        _has_var_kw = any(
            p.kind == inspect.Parameter.VAR_KEYWORD for p in _place_params.values()
        )
        _supports_reduce_only = 'reduce_only' in _place_params or _has_var_kw
        # exchange passthrough lets the wiring refuse a target routed to a
        # DIFFERENT live venue (venue_wiring audit H3) — older hand-wired
        # place_order fns don't take it, same signature-sniff as reduce_only
        _supports_exchange = 'exchange' in _place_params or _has_var_kw
        # contributors passthrough lets lib.execute resolve the per-strategy
        # execution style (市價/TWAP/custom) for this netted order — again
        # optional, so hand-wired place_order fns keep working untouched
        _supports_contributors = 'contributors' in _place_params or _has_var_kw
    except (TypeError, ValueError):
        _supports_reduce_only = False
        _supports_exchange = False
        _supports_contributors = False

    def _call_place(symbol, sub_diff, asset_spec, reduce_only, exchange=None,
                    contributors=None):
        # Returns False if place_order_fn skipped the order (e.g. below exchange minimum).
        # Returns None/truthy on success. Propagates exceptions on failure.
        kw = {}
        if _supports_reduce_only:
            kw['reduce_only'] = reduce_only
        if _supports_exchange:
            kw['exchange'] = exchange
        if _supports_contributors:
            kw['contributors'] = contributors
        if kw:
            return place_order_fn(symbol, sub_diff, asset_spec, **kw)
        return place_order_fn(symbol, sub_diff, asset_spec)

    executed = []  # orders with ≥1 confirmed fill — the return value
    for order in orders:
        symbol     = order['symbol']
        diff       = order['signed_diff']
        asset_spec = order.get('asset_spec')
        # Same lot-based exemption as compute_diff() (account-currency
        # threshold=10 is meaningless for a symbol sized in LOTS, e.g. capital/
        # TW futures) — this is a SECOND, independent threshold gate a few
        # lines below (per sub-order leg), missed when compute_diff() was
        # patched: a 1-lot diff passed compute_diff() only to be silently
        # `continue`d here, so place_order_fn was never even called (measured
        # live 2026-08-14 — "Converged, nothing filled" with zero attempts).
        is_lot_based = ((asset_spec or {}).get('type') == 'futures_contracts'
                         or order.get('exchange') == 'capital')

        # Detect position flip: split into reduce-only close + directional open
        # to avoid simultaneous long+short on hedge-mode exchanges. Must use
        # diff_actual (ledger, when self_ledger is on) — not actual — or a
        # manual position visible only in the real exchange read would get
        # classified as a flip and generate a reduce-only close leg against it,
        # exactly the touch self_ledger exists to prevent.
        a        = diff_actual.get(symbol, {})
        a_signed = (a.get('size', 0)  if a.get('side') == 'long'  else
                    -a.get('size', 0) if a.get('side') == 'short' else 0)
        t_signed = a_signed + diff

        # Third element is is_entry — whether the leg ADDS exposure, which is the
        # only thing state/HALT blocks. A flip's second leg always does; a plain
        # adjustment only when it grows the position (|target| > |actual|), so a
        # halt never traps a position that is being reduced.
        if a_signed != 0 and t_signed != 0 and t_signed * a_signed < 0:
            sub_orders = [(-a_signed, True, False), (t_signed, False, True)]
        else:
            # Same-side shrink (incl. full close) is ALSO reduce-only. On a
            # one-way account a plain opposite-side order nets, so this flag
            # was cosmetic — on a hedge-mode account (OKX 雙向) it is the whole
            # difference between reducing the long and opening a fresh short
            # (measured live: a $44 "reduce" opened $44 of shorts, twice).
            shrink = (a_signed != 0 and abs(t_signed) < abs(a_signed)
                      and t_signed * a_signed >= 0)
            sub_orders = [(diff, shrink, abs(t_signed) > abs(a_signed))]

        failed = False
        legs = []  # per-leg exchange-confirmed fills for orders.jsonl / the web 交易歷史
        notices = []  # (key, default, kwargs), sent after the ledger write below
        logged = [False]

        def _flush_legs():
            # Log whenever ANYTHING filled — a flip whose close leg executed but
            # whose entry leg then failed (or was halted) moved real money; hiding
            # it because the order "failed" would desync the history from the
            # exchange. `failed` marks the partial. Nothing filled + nothing
            # failed = every leg skipped below-min: no phantom entry.
            if not legs:
                return
            entry = {
                'action':      'BUY' if diff > 0 else 'SELL',
                'symbol':      symbol,
                'signed_diff': diff,
                # place_order knows which venue it actually routed to — trust
                # the fill over the config when both exist
                'exchange':    next((l.get('exchange') for l in legs if l.get('exchange')),
                                    order.get('exchange')),
                'asset_spec':  asset_spec,
                'contributors': order.get('contributors', []),
                'legs':        list(legs),
            }
            if failed:
                entry['failed'] = True
            _append_reconciler_log(entry)
            logged[0] = True
            del legs[:]

        for sub_diff, reduce_only, is_entry in sub_orders:
            whole = reduce_only and abs(sub_diff) >= abs(a_signed) - 1e-9
            leg_threshold = (0 if is_lot_based else
                             _close_threshold(threshold, symbol) if whole else
                             _resolve_threshold(threshold, symbol, reduce_only))
            if abs(sub_diff) < leg_threshold:
                continue

            # Kill switch, enforced here rather than only in lib/order_*.py: every
            # reconciler goes through this function, including the hand-written
            # place_order_fn of an exchange that has no official lib/order_* module.
            # Deliberately silent on Telegram — the user tripped the halt, and a
            # denial every poll is the noise they were trying to stop.
            if is_entry and (halted_at_start or guard.halted()):
                guard.audit('order_denied_halt', symbol=symbol, signed_diff=sub_diff,
                            exchange=order.get('exchange'), source='reconcile')
                logging.warning(
                    f"[reconcile] {symbol} entry {sub_diff:+.2f} denied — state/HALT is set "
                    f"({guard.halt_info()})"
                )
                failed = True
                break

            # self_ledger flip: the close leg just read the account short of
            # the book and that is not confirmed yet (note_account_short), so
            # whether the old side is closed is not known. Opening the new side
            # on top of that guess is how a 0.01 long became a net −0.002 with
            # a book saying −0.012; the next round settles it either way.
            if (is_entry and ledger is not None and len(sub_orders) == 2
                    and account_short_pending(symbol)):
                logging.warning(f"[reconcile] {symbol} entry {sub_diff:+.2f} held back — "
                                f"the close leg's account read is unconfirmed")
                failed = True
                break

            try:
                placed = _call_place(symbol, sub_diff, asset_spec, reduce_only,
                                     exchange=order.get('exchange'),
                                     contributors=order.get('contributors'))
            except Exception as e:
                log_msg = f"order error {symbol}: {e}"
                logging.error(log_msg)
                _record_order_error(symbol, order.get('exchange'), e)
                notices.append(('order_error', '⚠️ Order failed {symbol}: {error}',
                                {'symbol': symbol, 'error': e}))
                failed = True
                break

            if placed is False:
                # place_order skipped: qty below exchange minimum, or the leg was
                # handed to / deferred behind an async executor (lib.execute) —
                # either way nothing filled synchronously, nothing to log here
                logging.info(f"[reconcile] {symbol} skipped by place_order — "
                             f"below minimum or async execution in flight")
                continue

            # self_ledger: the wiring closed the bot's whole book on this side
            # and says what is left can never be sold (see
            # apply_ledger_writeoff). Honoured only for a leg that takes the
            # book to flat — the one case where flat is also what was asked for.
            writeoff = None
            if (ledger is not None and reduce_only and isinstance(placed, dict)
                    and abs(sub_diff) >= abs(a_signed) - 1e-9):
                writeoff = placed.get('writeoff')
                if not writeoff and a.get('legacy') and placed.get('executed_qty'):
                    # a legacy row has no quantity to check the close against;
                    # its close is where it ends (references/manager.md)
                    writeoff = 'legacy row closed'
            if (isinstance(placed, dict) and placed.get('writeoff')
                    and not float(placed.get('executed_qty') or 0)):
                # nothing was sent: no fill to log, no "Closed" to announce
                if writeoff:
                    apply_ledger_writeoff(symbol, writeoff)
                continue

            # 進出場價格:order libs return the exchange-confirmed fill — record
            # it per leg (a flip = close leg 出場價 + open leg 進場價). Older
            # place_order_fn returning bare None still logs the leg, just bare.
            leg = {'signed_diff': round(sub_diff, 2), 'reduce_only': reduce_only}
            if isinstance(placed, dict):
                for src, dst in (('avg_price', 'fill_price'),
                                 ('executed_qty', 'executed_qty'),
                                 ('exchange', 'exchange')):
                    if placed.get(src) is not None:
                        leg[dst] = placed[src]
                # self_ledger accounting (2026-08-20 audit P0-2): sub_diff is
                # the PRE-rounding request — capital rounds to a whole lot,
                # crypto floors to a qty step — so it can differ from what
                # actually filled. ledger_positions() sums this field directly,
                # so a signed_diff that doesn't match the real fill drifts the
                # ledger by the rounding gap every round, forever (the next
                # round diffs against the already-wrong ledger, so it never
                # self-corrects). Prefer the exchange-confirmed fill — same
                # convention lib.execute._finish() already uses for the async
                # TWAP/chase/custom path; sub_diff stays the fallback only
                # when executed_qty is unavailable (older/hand-wired
                # place_order_fn implementations).
                # Defensive: the order is ALREADY filled at this point — a bad
                # type from a hand-written place_order_fn must degrade to the
                # sub_diff fallback, never raise and drop the whole leg from
                # orders.jsonl (a filled trade the ledger never hears about).
                try:
                    executed_qty = leg.get('executed_qty')
                    if executed_qty is not None:
                        sign = 1.0 if sub_diff >= 0 else -1.0
                        if is_lot_based:
                            # capital/futures_contracts: executed_qty IS lots,
                            # already the unit compute_diff() worked in
                            filled_signed = sign * abs(float(executed_qty))
                        elif leg.get('fill_price'):
                            # crypto: executed_qty is BASE-currency qty — convert to
                            # account-currency notional to match sub_diff's unit
                            filled_signed = sign * abs(float(executed_qty)) * float(leg['fill_price'])
                        else:
                            filled_signed = None
                        if filled_signed is not None:
                            leg['signed_diff'] = round(filled_signed, 2)
                except (TypeError, ValueError) as e:
                    logging.warning(f"[reconcile] {symbol}: fill-based signed_diff "
                                    f"unavailable ({e}) — recording the requested "
                                    f"amount instead")
                # The quantity half of the book (see UNIT OF THE BOOK). Only
                # from an exchange-confirmed fill: a place_order that reports
                # none leaves the field out, and ledger_book then treats the
                # row as legacy rather than inventing a quantity for it.
                if ledger is not None:
                    try:
                        if leg.get('executed_qty') is not None:
                            leg['signed_qty'] = ((1.0 if sub_diff >= 0 else -1.0)
                                                 * abs(float(leg['executed_qty'])))
                    except (TypeError, ValueError):
                        pass
            legs.append(leg)
            if writeoff:
                # the zero row's timestamp is a cutoff: this close must be in
                # the log before it, and a flip's entry leg after it
                _flush_legs()
                apply_ledger_writeoff(symbol, writeoff)

            # is_lot_based rows (capital/TW futures) are sized in LOTS, not
            # account-currency notional — the $-formatted default badly
            # understates a real index-futures trade (would send "Bought TXF
            # $1.00" for a 1-lot TXF entry). Same flag as compute_diff()'s
            # threshold exemption above.
            unit = '{amount:g} lots' if is_lot_based else '${amount:.2f}'
            if reduce_only:
                key     = 'order_close_long'  if sub_diff < 0 else 'order_close_short'
                default = (f'📉 Closed long {{symbol}} {unit}' if sub_diff < 0 else
                           f'📈 Closed short {{symbol}} {unit}')
            else:
                key     = 'order_buy' if sub_diff > 0 else 'order_sell'
                default = (f'📈 Bought {{symbol}} {unit}' if sub_diff > 0 else
                           f'📉 Sold {{symbol}} {unit}')

            # What filled, not what was asked: leg['signed_diff'] is the
            # exchange-confirmed amount when the order lib reported one (a
            # partial close that sold 0.0003 BTC must not announce the 0.0007
            # it asked for), the rounded request otherwise.
            filled = abs(leg['signed_diff'])
            log_dir = 'BUY' if sub_diff > 0 else 'SELL'
            logging.info(f"{log_dir}{'(reduce)' if reduce_only else ''} {symbol} {filled:.2f}")
            notices.append((key, default, {'symbol': symbol, 'amount': filled}))

        _flush_legs()
        if logged[0]:
            executed.append(order)

        for key, default, kw in notices:
            _notify(key, default, **kw)

    return executed
