import glob, hashlib, inspect, json, logging, math, os, re, time
from datetime import datetime, timedelta, timezone

from lib import guard, venue_traits
try:
    from lib.execute import RECONCILE_THRESHOLD
except ImportError:  # half-updated workspace (lib/execute.py not landed yet): the value it carries
    RECONCILE_THRESHOLD = 10
try:
    from lib.winreplace import atomic_replace
except ImportError:  # half-updated workspace (lib/winreplace.py not landed): plain replace
    atomic_replace = os.replace
try:
    from lib.winreplace import load_json
except ImportError:  # half-updated workspace (lib/winreplace.py without load_json): no read retry
    def load_json(path, **open_kw):
        with open(path, **open_kw) as f:
            return json.load(f)


def _append_reconciler_log(order):
    guard.mark_money_process()  # writes the ledger: Stop in the chat never kills this process (lib/guard)
    # Best-effort in account-read mode: a full disk (measured on the fleet)
    # must not abort the reconcile loop mid-round — the order already
    # happened, and there losing the log line is the lesser failure (the next
    # account read self-corrects the position).
    #
    # self_ledger mode is different (audit P1 #2): this file IS the position
    # book — a dropped line means a real fill the bot will never know about,
    # and the next reconcile re-buys it. Trip HALT so nothing compounds the
    # gap (nothing is sent while halted; only the user resumes) — same fail-loud posture
    # as every other ledger-integrity failure.
    try:
        os.makedirs('manager', exist_ok=True)
        entry = {'ts': datetime.utcnow().isoformat(), **order}
        with open('manager/orders.jsonl', 'a') as f:
            f.write(json.dumps(entry) + '\n')
    except OSError as e:
        logging.error(f"orders.jsonl append failed: {e}")
        try:
            if own_positions_only(load_portfolio_config()) and not guard.halted():
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


RECONCILE_CAPS = ('contract_override', 'rollover_halt_freeze', 'halt_freeze', 'first_signal_wait')


def _write_reconcile_snapshot(target, actual, orders, ledger=None, gates=None, read_only=False,
                              own_only=False, needs_baseline=None, baseline_pending=None,
                              rollovers=None, market_closed=None):
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
            # what the RUNNING code honours (runtime portfolio_reporter.can_switch_contract):
            # the lib on disk says nothing about a reconciler that has not restarted yet
            'caps':   list(RECONCILE_CAPS),
        }
        if ledger is not None:
            doc['ledger'] = ledger
        if gates is not None:
            doc['gates'] = gates
        if read_only:
            # The RUNNING reconciler's own word that it is the never-configured
            # read-only version (the flag alone lives in the workspace lib, the
            # report in the runtime — two update channels: a file on disk says
            # nothing about the code the live process loaded).
            doc['read_only'] = True
        if own_only:
            # same reason as read_only: the running code's own word that it
            # never touches a position outside its book (the runtime reports it)
            doc['own_only'] = True
        if needs_baseline is not None:
            doc['needs_baseline'] = needs_baseline
        if baseline_pending:
            doc['baseline_pending'] = baseline_pending
        if rollovers:
            doc['rollovers'] = rollovers
        if market_closed:
            doc['market_closed'] = market_closed
        with open('manager/last_reconcile.json', 'w') as f:
            json.dump(doc, f, indent=2)
    except Exception as e:
        logging.warning(f'failed to write manager/last_reconcile.json: {e}')


def _reject_front(error):
    """An order lib's [order_reject:<kind>] token goes first, even when a caller wrapped the
    message ("close_symbol: {e}") — the 200-char cut must not take it (lib/reject_token)."""
    try:
        from lib import reject_token
    except ImportError:  # half-updated workspace: record as before
        return str(error)
    return reject_token.to_front(error)


# A rejection that will not clear by itself (paper cash short, margin, min size) comes back
# every round: one notice per symbol, leg (entry / reduce) and reason per cooldown (paper e2e
# 10-18: five "Order failed" in 2m16s). The numbers in the text move with the mark, so they
# are not the reason. A repeat inside the cooldown does not add an order_errors.json row: it
# bumps the row it repeats (last_at, count), leaving ts and the text alone — the platform turns
# every new row into a P1 (api openclaw/agent_overview._error_events keys on ts + text), and
# the pages read the newest row per symbol as "failing now".
ORDER_ERROR_NOTIFY_COOLDOWN_S = 3600
_order_error_notified = {}  # (symbol, leg) -> (reason, notified_at); process-level, like the reconciler's own


def _order_error_reason(error):
    return re.sub(r'\d[\d.,]*', '#', _reject_plain(error))


def _order_error_fresh(symbol, error, leg='entry', now=None):
    """True = notify this failure; a repeat of the same symbol + leg + reason inside the cooldown
    is False. An exit failing for the text an entry already failed with is still news."""
    now = time.time() if now is None else now
    reason = _order_error_reason(error)
    hit = _order_error_notified.get((symbol, leg))
    if hit and hit[0] == reason and now - hit[1] < ORDER_ERROR_NOTIFY_COOLDOWN_S:
        return False
    _order_error_notified[(symbol, leg)] = (reason, now)
    return True


def _reject_plain(error):
    """The message without its [order_reject:<kind>] token — for notices read by people (TG, desktop)."""
    try:
        from lib import reject_token
    except ImportError:
        return str(error)
    return reject_token.plain(error)


def _record_order_error(symbol, exchange, error, extra=None, repeat=False):
    """Last few order failures, for the workspace page — a reconciler that
    fails silently in a tmux log is indistinguishable from one that never
    tried (measured UX complaint). Best-effort; keeps the newest 5.
    `extra` adds fields (e.g. kind/symbols for the platform to route on).
    repeat=True (a throttled repeat, _order_error_fresh): the newest row of this
    symbol + exchange + reason gets last_at and count instead of a new row; none → a new row."""
    try:
        path = 'manager/order_errors.json'
        rows = _order_errors_for_update(path)
        if rows is None:
            return
        now = datetime.utcnow().isoformat()
        text = _reject_front(error)[:200]
        same = [r for r in rows if isinstance(r, dict) and r.get('symbol') == symbol
                and r.get('exchange') == exchange
                and _order_error_reason(r.get('error', '')) == _order_error_reason(text)] if repeat else []
        if same:
            same[-1]['last_at'] = now
            same[-1]['count'] = int(same[-1].get('count') or 1) + 1
        else:
            rows.append({**(extra or {}), 'ts': now, 'symbol': symbol, 'exchange': exchange, 'error': text})
        tmp = f'{path}.{os.getpid()}.tmp'
        with open(tmp, 'w') as f:
            json.dump(rows[-5:], f, indent=2)
        atomic_replace(tmp, path)
    except Exception as e:
        logging.warning(f'failed to record order error: {e}')


def _order_errors_for_update(path):
    """The rows to append to; None = there but unreadable, write nothing (the platform diffs
    this file for its P1 notice). Not JSON / not a list: set aside as <path>.corrupt, start
    over — skipping would silence every later failure."""
    try:
        rows = load_json(path)
    except FileNotFoundError:
        return []
    except ValueError:
        rows = None
    except OSError as e:
        logging.warning(f'order error not recorded: {path} unreadable ({type(e).__name__})')
        return None
    if isinstance(rows, list):
        return rows
    atomic_replace(path, path + '.corrupt')
    return []


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
    counts, from the start of the file.

    Rows are per VENUE (2026-09-23): key "<venue>|<symbol>" with a 'venue'
    field. A key without a venue is a row from before that and applies to every
    venue. `own_only_basis` = this baseline was written for the own-positions
    rule (by this lib, never by the runtime or an older lib) — see book_ready()."""
    empty = {'seeded_at': '', 'own_only_basis': None, 'symbols': {}, 'pending': {},
             'venue_reset': {}, 'venue_account': {}}
    try:
        raw = load_json(_LEDGER_SEED_PATH)
        if not isinstance(raw, dict):
            return empty
        rows = {}
        for k, v in (raw.get('symbols') or {}).items():
            venue = v.get('venue') or None
            rows[k] = {'size': float(v.get('size', 0) or 0),
                       'qty': (float(v['qty']) if v.get('qty') is not None else None),
                       'ts': str(v.get('ts') or ''),
                       'venue': venue,
                       'symbol': k.split('|', 1)[1] if venue and '|' in k else k}
            if isinstance(v.get('months'), dict):
                # contract month -> signed lots (TW futures, see _ledger_walk)
                rows[k]['months'] = {str(m): float(q) for m, q in v['months'].items()}
        pending = raw.get('pending')
        resets = raw.get('venue_reset')
        accounts = raw.get('venue_account')
        return {'seeded_at': str(raw.get('seeded_at') or ''),
                'own_only_basis': raw.get('own_only_basis'),
                'symbols': rows,
                'pending': pending if isinstance(pending, dict) else {},
                # {venue: ts}: that venue's book restarts at ts (another account
                # bound there, or the user reset it) — earlier rows and fills are gone
                'venue_reset': ({str(k): str(v) for k, v in resets.items()}
                                if isinstance(resets, dict) else {}),
                # {venue: {'id', 'fp', 'at'}}: the account the book was built on
                # (book_account_check)
                'venue_account': ({str(k): v for k, v in accounts.items() if isinstance(v, dict)}
                                  if isinstance(accounts, dict) else {})}
    except (OSError, ValueError, AttributeError):
        return empty


def _seed_key(symbol, venue):
    return f"{venue}|{symbol}" if venue else symbol


_CURRENT = object()  # "the venue this machine trades on" — see book_venue()


def _paper_tw_market(exchange, sym, market):
    """A TW stock on paper is held as cash shares whatever the strategy's
    MARKET says (Wei 10-17): spot pays the full price from cash, no leverage,
    no short — what a real 現股 account can do."""
    return 'spot' if exchange == 'paper' and _tw_stock(sym) else market


def _tw_stock(sym):
    try:
        from lib.paper_data import is_tw_stock
    except ImportError:
        return False
    return is_tw_stock(sym)


_PAPER_TW_CLOSE_PATH = 'state/paper_tw_close.json'


def defer_paper_tw_close(keys):
    """manager/flatten: close-all reached paper TW stock keys while the TWSE
    session was shut. The reconciler closes them in its first round after the
    open (they are dropped from the target while HALT holds, and their close
    legs — the only legs a halted round sends — go out inside
    guard.halt_close_pass). Pressing 啟動下單 before that cancels it: the
    strategies' targets rule again. A machine restart in between stamps the
    file `restart_at` (runtime command_listener._stop_after_restart), so the
    cancel says the start came after a restart."""
    keys = sorted(set(keys))
    if not keys:
        return
    try:
        have = load_json(_PAPER_TW_CLOSE_PATH).get('keys') or []
    except (OSError, ValueError, AttributeError):
        have = []
    os.makedirs(os.path.dirname(_PAPER_TW_CLOSE_PATH), exist_ok=True)
    tmp = _PAPER_TW_CLOSE_PATH + '.tmp'
    with open(tmp, 'w') as f:
        json.dump({'keys': sorted(set(have) | set(keys)), 'ts': int(time.time())}, f)
    atomic_replace(tmp, _PAPER_TW_CLOSE_PATH)


_PAPER_TW_CANCEL = 'close-all: 開盤前已按啟動下單,延後的台股平倉取消,改照策略目標下單'
_PAPER_TW_CANCEL_RESTART = ('close-all: 機器重開後按了啟動下單(重開後要按它才會恢復下單),'
                            '延後的台股平倉一併取消,改照策略目標下單')


def _paper_tw_deferred(diff_actual, halted):
    """Keys flatten deferred (defer_paper_tw_close) that are still held. Not
    halted any more = the user resumed: the deferral is dropped."""
    try:
        rec = load_json(_PAPER_TW_CLOSE_PATH)
        keys = set(rec.get('keys') or [])
    except FileNotFoundError:
        return set()
    except (OSError, ValueError, AttributeError):
        rec, keys = {}, set()
    held = {k for k in keys if float((diff_actual.get(k) or {}).get('size') or 0) > 0}
    if held and not halted:
        _record_order_error(','.join(sorted(held)), 'paper',
                            _PAPER_TW_CANCEL_RESTART if rec.get('restart_at') else _PAPER_TW_CANCEL)
    if not halted or not held:
        try:
            os.remove(_PAPER_TW_CLOSE_PATH)
        except OSError:
            pass
        return set()
    if held != keys:
        tmp = _PAPER_TW_CLOSE_PATH + '.tmp'
        with open(tmp, 'w') as f:
            json.dump({**rec, 'keys': sorted(held), 'ts': int(time.time())}, f)
        atomic_replace(tmp, _PAPER_TW_CLOSE_PATH)
    return held


def _paper_tw_closed_keys(target, diff_actual):
    """Keys of TW stocks traded on paper while the TWSE session is shut
    (lib.paper_data.tw_session_open): held as is on BOTH sides, like a gated
    symbol — no entry and no close until 09:00, the way the exchange would
    hold them. A daily strategy's after-close signal so fills the next session
    at the latest close. Empty on an older lib/paper_data."""
    try:
        from lib.paper_data import is_tw_stock, tw_session_open
    except ImportError:
        return set()
    keys = set()
    for k in set(target) | set(diff_actual):
        if not is_tw_stock(split_key(k)[0]):
            continue
        venue = (target.get(k) or {}).get('exchange') or (diff_actual.get(k) or {}).get('exchange')
        if (venue or book_venue()) == 'paper':
            keys.add(k)
    if not keys:
        return set()
    try:
        from lib.venue_wiring import read_env
        env = read_env()
    except Exception:
        env = {}
    return set() if tw_session_open(env) else keys


def _venue_paused_keys(target, diff_actual):
    """Keys on the auto-wired venue that it pauses right now (lib.venue_wiring.paused_symbols):
    held on both sides like a closed TW session — an order would only come back refused
    every round. Paper, TW brokers and an older lib: none."""
    try:
        from lib.venue_wiring import hand_wired_venue, paused_symbols
        if hand_wired_venue():
            return set()
        keys = {k for k in set(target) | set(diff_actual)
                if ((target.get(k) or {}).get('exchange') or (diff_actual.get(k) or {}).get('exchange')
                    or book_venue()) != 'paper'}
        return paused_symbols(keys) if keys else set()
    except Exception as e:
        logging.warning(f"[reconcile] venue pause check skipped ({e})")
        return set()


def _signed_size(row):
    if not row:
        return 0.0
    size = float(row.get('size') or 0)
    return -size if row.get('side') == 'short' else size


def _paused_split(paused, target, diff_actual):
    """BingX status 25 forbids OPENING only (FORBIDDEN_TO_OPEN): a reduce or a close of a paused
    key goes out as usual (a venue refusal is reported as any refusal); an entry or an add is
    held; a flip keeps only its close leg. Returns (keys held as is, keys that only close)."""
    hold, close_only = set(), set()
    for k in paused:
        t, a = _signed_size(target.get(k)), _signed_size(diff_actual.get(k))
        if t == 0 or (a != 0 and (t > 0) == (a > 0) and abs(t) <= abs(a)):
            continue
        if a != 0 and (t > 0) != (a > 0):
            close_only.add(k)
        else:
            hold.add(k)
    return hold, close_only


def book_venue():
    """The venue the bot's book is read and written for: the one the reconciler
    trades on (the bound TW broker, else the auto-wired venue). None when no
    venue can be told — the book is then read across venues, as before books
    were per venue."""
    try:
        from lib.venue_wiring import detect_venue, hand_wired_venue, read_env
        hand_wired = hand_wired_venue()
        if hand_wired:
            return hand_wired
        return detect_venue(read_env())
    except Exception:
        return None


def _resolve_venue(venue):
    return book_venue() if venue is _CURRENT else venue


def _creds_fp(env, venue):
    """Digest of this venue's credential values (.env `<VENUE>_*`, the prefix
    flatten/_venues and the account reader discover venues by) — only ever
    compared to itself: it tells "the same key as the last id read" (so an
    unreadable id changes nothing), never which account the book is (that is
    the exchange's id)."""
    h = hashlib.sha256()
    prefix = f"{venue.upper()}_"
    for k in sorted(env or {}):
        ku = str(k).upper()
        if not ku.startswith(prefix):
            continue
        if ku.endswith(('_API_KEY', '_SECRET_KEY', '_API_SECRET', '_PASSPHRASE', '_PASSWORD',
                        '_BOUND_TS')):
            h.update(f"{ku}={env[k]}\n".encode())
    return h.hexdigest()


def _read_account_id(venue, env):
    """(id, error, transient). id None + error None = no account lib, or one
    without get_account_id (capital) — nothing to compare."""
    import importlib
    try:
        mod = importlib.import_module(f"lib.account_{venue}")
    except ImportError:
        return None, None, False
    fn = getattr(mod, 'get_account_id', None)
    if fn is None:
        return None, None, False
    try:
        uid = fn(env)
    except Exception as e:
        from lib import venue_errors
        try:
            kind = (getattr(mod, 'classify', None) or venue_errors.classify)(e) \
                or venue_errors.classify(e)
        except Exception:
            kind = venue_errors.UNKNOWN
        code = getattr(e, 'code', None) or venue_errors.http_status(e)
        # class and code only: an exception message can carry a signed URL
        return None, f"{type(e).__name__} code={code}", kind == venue_errors.TRANSIENT
    if not uid:
        return None, "no id returned", False
    return str(uid), None, False


def _venue_book_open(venue):
    return any(float(r.get('size') or 0) or float(r.get('qty') or 0)
               for r in (ledger_positions(venue) or {}).values())


def book_account_check(env=None, venue=_CURRENT, account=_CURRENT):
    """Is the bot's book on `venue` the book of the account these credentials
    open? Run before anything trades out of the book after a credentials write
    (the bind, manager/reconciler at start and on every key change, flatten.py).
    Identity is the exchange's own account id
    (lib.account_<venue>.get_account_id), kept per venue in the seed's
    `venue_account` — never the key, so a key rotation keeps the book:
      same id        → 'ok';
      another id     → 'reset': that venue's book restarts now (`venue_reset`)
                       and the new id is recorded, before the caller reads the
                       book and whatever any HALT or its clearing says later;
      no record      → 'ok', id recorded (a book from before ids were kept is
                       taken as this account's);
      id unreadable  → 'ok' only when nothing rides on it: the same credentials
                       as the last read (one key opens one account), no open
                       row in this venue's book, or no record at all (the first
                       check after this lib lands — taken as this key's, as a
                       readable id would be). Else 'unreadable' ('transient'
                       for a network-class error): the caller must not trade
                       this venue's book until the id reads, or until the user
                       answers whether it is the same account
                       (book_account_confirm, runtime `book_account_confirm`).
    'unsupported' = the venue's account lib has no get_account_id (capital).
    `account` = an id the caller already read ((id, error, transient) tuple),
    so the reconciler's guard and this check share one request.
    Returns (verdict, detail)."""
    venue = _resolve_venue(venue)
    if not venue:
        return 'unsupported', 'no venue'
    if env is None:
        from lib.venue_wiring import read_env
        env = read_env()
    uid, err, transient = _read_account_id(venue, env) if account is _CURRENT else account
    if uid is None and err is None:
        return 'unsupported', f"lib.account_{venue} has no get_account_id"
    fp = _creds_fp(env, venue)
    seed = _load_ledger_seed()
    accounts = dict(seed.get('venue_account') or {})
    rec = accounts.get(venue)
    now = datetime.utcnow().isoformat()
    verdict, detail = 'ok', None
    if uid is not None:
        if rec is not None and rec.get('id') and str(rec['id']) != uid:
            verdict = 'reset'
            detail = f"another {venue} account is bound — that venue's book was reset"
        elif rec is not None and not rec.get('id') and rec.get('fp') != fp \
                and _venue_book_open(venue):
            verdict = 'unreadable'
            detail = (f"{venue}: Blave's positions there were recorded under a key whose "
                      f"account id could not be read, and the key has changed — confirm "
                      f"whether the new key is the same {venue} account")
        if verdict != 'unreadable':
            new = {'id': uid, 'fp': fp, 'at': now}
            if verdict == 'reset':
                seed['venue_reset'] = {**(seed.get('venue_reset') or {}), venue: now}
                # a symbol still waiting to be migrated would adopt the NEW account's holding
                seed['pending'] = {k: v for k, v in (seed.get('pending') or {}).items()
                                   if not str(k).startswith(f"{venue}|")}
                guard.audit("book_reset", venue=venue, reason="account_changed")
            if verdict == 'reset' or rec is None or rec.get('id') != uid or rec.get('fp') != fp:
                accounts[venue] = new
                seed['venue_account'] = accounts
                _save_ledger_seed(seed)
        return verdict, detail
    if rec is not None and rec.get('fp') == fp:
        return 'ok', f"{venue} account id unreadable ({err}); credentials unchanged"
    if rec is None or not _venue_book_open(venue):
        # nothing recorded yet (a book from before ids were kept is taken as this
        # key's, as with a readable id), or nothing to protect: remember the key.
        # A verified id stays: an unreadable read is no evidence against it, and
        # a later key of another account must still be told apart by the exchange
        accounts[venue] = {'id': (rec or {}).get('id'), 'fp': fp, 'at': now}
        seed['venue_account'] = accounts
        _save_ledger_seed(seed)
        return 'ok', f"{venue} account id unreadable ({err}); recorded against this key"
    return ('transient' if transient else 'unreadable',
            f"{venue}: the new key's account id could not be read ({err}), so Blave "
            f"cannot tell whether its {venue} positions are on this account — confirm "
            f"whether the new key is the same {venue} account")


def account_changed_reason(venue):
    """The HALT reason (and notice) when another exchange account is found on
    `venue` — at bind (runtime) or by the reconciler; one sentence for both."""
    return (f"another {venue} account is bound — Blave's {venue} book was reset and Blave no "
            f"longer manages the positions it opened on the previous account (close them "
            f"there yourself if needed). Press 啟動下單 to trade this account from an empty book")


def _account_guard_state():
    try:
        state = load_json(guard.ACCOUNT_GUARD_PATH)
    except (OSError, ValueError):
        return {}
    return state if isinstance(state, dict) else {}


def book_hold_asking(venue):
    """Is the report asking the user about `venue` right now
    (account_guard.book_hold with `ask`)?"""
    hold = _account_guard_state().get('book_hold')
    return isinstance(hold, dict) and bool(hold.get('ask')) and hold.get('venue') == venue


def book_account_confirm(venue, same, env=None):
    """The user's answer to a book hold (book_account_check → 'unreadable'):
    is the key now bound on `venue` the same exchange account the bot's book
    there was built on? Never places an order.
      same=True  → the book is kept; the current key (and its id, else the one
                   recorded) becomes the book's account.
      same=False → that venue's book restarts now (`venue_reset`): what the bot
                   held there is the user's; the current key becomes the book's
                   account.
    Idempotent: the answer is stored with the key it was given for, and the
    same answer again changes nothing ('unchanged'). It acts only while the
    report is asking about this venue right now (book_hold_asking) and the
    exchange cannot decide itself; otherwise it changes nothing
    ('nothing_to_confirm'), so a stale or replayed answer can never empty — or
    keep — a book.
    A 'same' after a 'different' for the same key is refused: the reset cannot
    be undone. Audited. Returns the outcome string."""
    venue = str(venue or "").lower()
    if env is None:
        from lib.venue_wiring import read_env
        env = read_env()
    fp = _creds_fp(env, venue)
    seed = _load_ledger_seed()
    accounts = dict(seed.get('venue_account') or {})
    rec = accounts.get(venue)
    answer = 'same' if same else 'different'

    def _refuse(why):
        guard.audit("book_account_confirm", venue=venue, same=bool(same), outcome="refused")
        raise ValueError(why)

    uid = None
    answered = rec is not None and rec.get('fp') == fp and rec.get('answer')
    if answered == answer:
        outcome = 'unchanged'
    elif answered == 'different' and same:
        _refuse(f"{venue}: already answered 'different account' for this key — "
                f"the book was reset and cannot be restored")
    elif not book_hold_asking(venue):
        # only the question being asked right now can be answered: a stale or
        # replayed answer (another device, an old dialog) must never touch a book
        outcome = 'nothing_to_confirm'
    elif rec is None or not _venue_book_open(venue):
        outcome = 'nothing_to_confirm'
    else:
        uid = _read_account_id(venue, env)[0]
        # both ids readable: the exchange decides (book_account_check), not the user
        outcome = 'nothing_to_confirm' if uid is not None and rec.get('id') else None
    if outcome:
        guard.audit("book_account_confirm", venue=venue, same=bool(same), outcome=outcome)
        return outcome
    if uid is None:
        uid = _read_account_id(venue, env)[0]
    now = datetime.utcnow().isoformat()
    if same:
        if uid is not None and rec and rec.get('id') and str(rec['id']) != uid:
            _refuse(f"{venue}: the exchange reports another account for this key — "
                    f"not the same account")
        accounts[venue] = {'id': uid or (rec or {}).get('id'), 'fp': fp, 'at': now,
                           'answer': answer}
        outcome = 'kept'
    else:
        seed['venue_reset'] = {**(seed.get('venue_reset') or {}), venue: now}
        seed['pending'] = {k: v for k, v in (seed.get('pending') or {}).items()
                           if not str(k).startswith(f"{venue}|")}
        accounts[venue] = {'id': uid, 'fp': fp, 'at': now, 'answer': answer}
        outcome = 'reset'
    seed['venue_account'] = accounts
    _save_ledger_seed(seed)
    guard.audit("book_account_confirm", venue=venue, same=bool(same), outcome=outcome)
    return outcome


def book_ready(config=None):
    """The book has a baseline the own-positions rule can trust: written by this
    lib (`own_only_basis`), or a machine that was already on the book
    (`"self_ledger": true`, whose seed the runtime or seed_ledger.py wrote).
    A bare `seeded_at` is not enough: a newer runtime writes one on a full
    unbind beside an older lib that keeps trading the whole account, and those
    fills are not the bot's book."""
    seed = _load_ledger_seed()
    if not seed['seeded_at']:
        return False
    cfg = load_portfolio_config() if config is None else config
    return seed.get('own_only_basis') == 1 or (cfg or {}).get('self_ledger') is True


def _save_ledger_seed(seed):
    guard.mark_money_process()  # writes the ledger: Stop in the chat never kills this process (lib/guard)
    # tmp+replace (same convention as lib/guard.py, manager/reconciler.py's
    # last-order marker): flatten() writes this file while the reconciler's
    # 5s poll may be mid-read — a half-written file parses as "no seed at
    # all", which ledger_positions() degrades into summing the entire
    # orders.jsonl from the top (a much larger phantom ledger), and that
    # mis-read would land exactly during a panic close-all.
    os.makedirs('manager', exist_ok=True)
    out = {'seeded_at': seed.get('seeded_at') or '',
           'symbols': {k: {n: v for n, v in r.items() if n != 'symbol' and (n != 'venue' or v)}
                       for k, r in (seed.get('symbols') or {}).items()}}
    if seed.get('own_only_basis') is not None:
        out['own_only_basis'] = seed['own_only_basis']
    if seed.get('pending'):
        out['pending'] = seed['pending']
    if seed.get('venue_reset'):
        out['venue_reset'] = seed['venue_reset']
    if seed.get('venue_account'):
        out['venue_account'] = seed['venue_account']
    tmp = _LEDGER_SEED_PATH + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(out, f, indent=2)
    atomic_replace(tmp, _LEDGER_SEED_PATH)


def claim_unvenued_rows(venue=_CURRENT):
    """Rows written before books were per venue (seed_ledger --absorb, older
    zero rows) carry no venue and would read as the bot's on EVERY bound venue
    — close-all would then close the same quantity on a second venue, out of
    the user's position there. Each is claimed, once, for the venue it belongs
    to:
      - one venue bound: that venue (the row was written for the only one);
      - several: the venue every logged fill of that symbol names
        (orders.jsonl `exchange`). The current route is not evidence — it may
        have moved since. No fill, or fills on two venues: the row is parked
        as "?" — no venue's book reads it (the bot's old share there is left
        alone, never sold on the wrong venue) — and said once.
    A newer row of the same symbol on the claimed venue wins."""
    venue = _resolve_venue(venue)
    if not venue:
        return
    seed = _load_ledger_seed()
    rows = seed['symbols']
    old = [k for k, r in rows.items() if r['venue'] is None]
    if not old:
        return
    bound = _bound_venues(venue)
    fills = _fill_venues() if len(bound) > 1 else None
    parked = []
    for k in old:
        r = rows.pop(k)
        if fills is None:
            v = venue
        else:
            seen = fills.get(r['symbol'], set())
            v = next(iter(seen)) if len(seen) == 1 and next(iter(seen)) in bound else None
        if v is None:
            rows[_seed_key(r['symbol'], '?')] = {**r, 'venue': '?'}
            parked.append(r['symbol'])
            continue
        key = _seed_key(r['symbol'], v)
        if key in rows and rows[key]['ts'] >= r['ts']:
            continue
        rows[key] = {**r, 'venue': v}
    _save_ledger_seed(seed)
    logging.info(f"[ledger] rows without a venue claimed: {sorted(old)}; parked: {parked}")
    if parked:
        guard.audit('ledger_row_parked', symbols=parked, bound=sorted(bound))
        _record_order_error(','.join(sorted(parked)), '*', "ledger: an old book row doesn't say "
                            "which exchange it is on, and the fills don't either — Blave leaves "
                            "that position alone on every exchange; reseed the book to hand it back")


def _bound_venues(venue):
    """The venues this machine has bound — the one it trades on included."""
    try:
        from lib.venue_wiring import official_venues, read_env
        return set(official_venues(read_env())) | {venue}
    except Exception:
        return {venue}


def _fill_venues():
    """{symbol: {exchange, …}} over every fill logged in orders.jsonl."""
    out = {}
    try:
        with open(_ORDERS_LOG_PATH) as f:
            for line in f:
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                if e.get('symbol') and e.get('exchange'):
                    out.setdefault(e['symbol'], set()).add(e['exchange'])
    except OSError:
        pass
    return out


def seed_ledger(get_positions_fn, absorb=False, get_qty_fn=None, venue=_CURRENT):
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
    guard.mark_money_process()  # writes the ledger: Stop in the chat never kills this process (lib/guard)
    now = datetime.utcnow().isoformat()
    venue = _resolve_venue(venue)
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
            symbols[_seed_key(symbol, venue)] = {
                'size': signed, 'qty': float(qty) if qty is not None else None,
                'ts': now, 'venue': venue, 'symbol': symbol}
    # 'seeded_at' cuts off history for EVERY symbol, incl. ones with no row —
    # pre-seed orders.jsonl history must never leak into the ledger
    # which account each venue's book belongs to outlives a re-seed: fills from
    # here on are still that account's (book_account_check)
    _save_ledger_seed({'seeded_at': now, 'own_only_basis': 1, 'symbols': symbols,
                       'venue_account': _load_ledger_seed()['venue_account']})
    return {v['symbol']: v['size'] for v in symbols.values()}


def zero_ledger_symbols(symbols, venue=_CURRENT):
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
    guard.mark_money_process()  # writes the ledger: Stop in the chat never kills this process (lib/guard)
    if not symbols:
        return
    venue = _resolve_venue(venue)
    seed = _load_ledger_seed()
    now = datetime.utcnow().isoformat()
    for symbol in symbols:
        seed['symbols'][_seed_key(symbol, venue)] = {'size': 0.0, 'qty': 0.0, 'ts': now,
                                                     'venue': venue, 'symbol': symbol}
    _save_ledger_seed(seed)


def _row_signed(row):
    row = row or {}
    size = float(row.get('size') or 0)
    side = row.get('side')
    return size if side in ('long', 'buy') else (-size if side in ('short', 'sell') else 0.0)


def _spot_holding(sym):
    """Base units of `sym`'s coin in the bound venue's spot wallet. Raises when
    it can't be read — the baseline then waits a round (a spot row without a
    quantity can never be sold, lib.venue_wiring._spot_legacy_refused)."""
    import importlib
    from lib.venue_wiring import _spot_base, detect_venue, read_env
    env = read_env()
    order = importlib.import_module(f"lib.order_{detect_venue(env)}")
    return float(order.get_spot_balances(env).get(_spot_base(sym), 0.0))


def _row_signed(row):
    row = row or {}
    size = float(row.get('size') or 0)
    side = row.get('side')
    return size if side in ('long', 'buy') else (-size if side in ('short', 'sell') else 0.0)


def _funded_states_unreadable(config):
    """Funded strategies whose state.json is on disk but can't be parsed this
    round (half-written, corrupt): aggregate_portfolio skips them, so the target
    silently lacks their position. Not counted: a strategy that never ran (no
    file), and a parsed state with no `symbol` — aggregate_portfolio skips that
    one by design every round (a Type C portfolio strategy writes no
    single-symbol state; lib/runner's Type C live branch only writes stats), so
    it is never a position of a single symbol here and waiting on it would
    never end."""
    exchanges = (config or {}).get('exchanges') or {}
    bad = []
    for name, amt in strategy_amounts(config).items():
        if not amt or not exchanges.get(name):
            continue
        path = f'strategies/{name}/state.json'
        if not os.path.exists(path):
            continue
        try:
            st = load_json(path)
            if not isinstance(st, dict):
                bad.append(name)
        except (OSError, ValueError):
            bad.append(name)
    return sorted(bad)


def _venue_quantize(venue, key, qty, lots):
    """Floor an unsigned BASE quantity to what the venue can trade; below its
    minimum → 0. Lot-based rows → whole lots.

    Swap: floored to lib.venue_wiring._lot_base (one step in BASE units, the
    contract value already applied — the unit every official lib's sizing uses),
    then format_qty only as the minimum gate. Its return value is never used:
    OKX and Gate.io return CONTRACTS there (0.035 BTC comes back as "3.5" /
    "350"), and each lib's docstring says the same. Spot: format_spot_qty floors
    to the spot step and returns BASE units on every official lib."""
    import importlib
    import math
    if lots:
        return float(math.floor(qty + 1e-9))
    from lib.venue_wiring import _lot_base, read_env
    env = read_env()
    order = importlib.import_module(f"lib.order_{venue}")
    sym, market = split_key(key)
    if market == 'spot':
        try:
            out = order.format_spot_qty(env, sym, qty)
        except ValueError:
            return 0.0
        return float(out) if out else 0.0
    lot = _lot_base(order, env, sym)
    if not lot > 0:
        raise ValueError(f"{sym}: no lot size from lib.order_{venue}")
    q = float(f"{math.floor(qty / lot + 1e-9) * lot:.12g}")
    if q <= 0:
        return 0.0
    try:
        ok = order.format_qty(env, sym, q)
    except ValueError:
        return 0.0
    return q if ok else 0.0


_baseline_seen = None  # the held set the previous round saw, for the two-read confirmation


# a wait that no amount of waiting ends by itself (confirming / inflight / unconfigured do)
_STUCK_REASONS = ('state_unreadable', 'error', 'qty_mismatch', 'no_venue')
_BASELINE_FALLBACK_ROUNDS = 3
_BASELINE_FALLBACK_S = 600
_baseline_wait = None  # {'reason', 'since', 'rounds'} of the current stuck wait


def _baseline_stuck(waiting):
    """True once the baseline has waited on the same non-transient reason for
    _BASELINE_FALLBACK_ROUNDS rounds AND _BASELINE_FALLBACK_S seconds."""
    global _baseline_wait
    reason = (waiting or {}).get('reason')
    if reason not in _STUCK_REASONS:
        _baseline_wait = None
        return False
    now = time.time()
    if not _baseline_wait or _baseline_wait['reason'] != reason:
        _baseline_wait = {'reason': reason, 'since': now, 'rounds': 0}
    _baseline_wait['rounds'] += 1
    stuck = (_baseline_wait['rounds'] >= _BASELINE_FALLBACK_ROUNDS
             and now - _baseline_wait['since'] >= _BASELINE_FALLBACK_S)
    if stuck:
        _baseline_wait = None
    return stuck


class _BaselineWait(Exception):
    def __init__(self, reason, symbol):
        super().__init__(reason)
        self.reason, self.symbol = reason, symbol


# account notional up to this × the target notional (same side) is adopted whole
_ADOPT_WHOLE_RATIO = 1.5


def _auto_baseline(target, actual, config, fallback=False):
    """Write the book's baseline on the first round of the own-positions rule
    (a machine from before it, or a lost seed). None = written, reconcile
    normally; otherwise {'reason', 'symbols'} for the snapshot's
    `needs_baseline`, and this round stays read-only.

    Such a machine has been reading the WHOLE account as its own, so its bot
    and manual positions are mixed. The bot's share of each symbol is taken as
    min(|account|, |target|) when the two are on the SAME side (Wei 2026-09-23)
    — the most a strategy can own of what is there — and the rest is the
    user's. Everything else is the user's: a symbol no funded strategy trades
    (a removed strategy's leftover included), a flat target, and an account on
    the other side of its target (a short under a long target: the bot owns 0
    and buys its target from there). Nothing in this rule ever sells: the
    adopted cost is never above the target.

    How much of the quantity (Wei 2026-09-23): up to _ADOPT_WHOLE_RATIO × the
    target's notional, the WHOLE account quantity is the bot's (a profitable
    bot position is worth more than its target; splitting it would leave the
    bot's own last lot to the user). Above that, the target's share, floored to
    the venue step in base units (_venue_quantize); the rest is the user's. A
    venue that reports no quantity (a dict-contract lib) gets a legacy row.

    The decision is permanent, so it waits for inputs it can trust: the
    portfolio is configured, every funded strategy's state is readable, every
    quantity read succeeds, and two rounds in a row saw the same positions (an
    empty or short answer from the venue would make the bot's own positions the
    user's for good). TWAP / chase in flight waits too — seeding now would
    double-count their fills.

    fallback=True (reconcile, after _baseline_stuck): a wait that would never
    end is not waited out — a read-only machine sends no exit either. Every
    symbol whose inputs are fine is decided as above; a symbol whose quantity
    can't be read, and an unreadable strategy's position, are left to the user
    (never guessed as the bot's), recorded in the audit line and one order
    error."""
    global _baseline_seen

    def wait(reason, symbols=(), **kw):
        return {'reason': reason, 'symbols': list(symbols), **kw}

    try:
        from lib.execute import list_inflight
        if list_inflight():
            return wait('inflight')
    except Exception as e:
        return wait('error', error=str(e)[:200])
    if not portfolio_configured():
        return wait('unconfigured')
    held = {k: _row_signed(a) for k, a in (actual or {}).items() if _row_signed(a)}
    seen = sorted((k, _sign(v)) for k, v in held.items())
    if seen != _baseline_seen:
        _baseline_seen = seen
        return wait('confirming')
    bad = _funded_states_unreadable(config)
    # a broken strategy's own symbol waits alone (known from stats.json /
    # strategy.py); only a strategy whose symbol can't be found holds everything
    pending, unknown = {}, []
    for name in bad:
        key = _strategy_key(name)
        if key:
            pending[key] = name
        else:
            unknown.append(name)
    if unknown and not fallback:
        return wait('state_unreadable', unknown)
    venue = book_venue()
    now = datetime.utcnow().isoformat()
    rows, left = {}, {}
    qty_of = _qty_reader()
    try:
        for k, a_s in held.items():
            if k in pending:
                continue
            try:
                row = _adopt_row(k, a_s, (target or {}).get(k), actual[k], venue, now, qty_of)
            except Exception as e:
                if not fallback:
                    raise
                left[k] = (e.reason if isinstance(e, _BaselineWait) else f"{type(e).__name__}: {e}")[:120]
                continue
            if row:
                rows[_seed_key(k, venue)] = row
        doc = {'seeded_at': now, 'own_only_basis': 1, 'symbols': rows}
        if pending:
            doc['pending'] = {_seed_key(k, venue): {'strategy': n, 'since': now}
                              for k, n in pending.items()}
        _save_ledger_seed(doc)
    except _BaselineWait as e:
        return wait(e.reason, [e.symbol])
    except Exception as e:
        return wait('error', error=f"{type(e).__name__}: {e}"[:200])
    _baseline_seen = None
    adopted = {v['symbol']: {'size': round(v['size'], 2), 'qty': v['qty']} for v in rows.values()}
    guard.audit('ledger_baseline', venue=venue, adopted=adopted, held=sorted(held),
                **({'pending': sorted(pending)} if pending else {}),
                **({'fallback': True, 'left_to_user': left, 'symbol_unknown': unknown}
                   if fallback else {}))
    logging.warning(f"[ledger] baseline written for {venue}: the bot owns {adopted or 'nothing'}; "
                    f"waiting on {sorted(pending) or 'nothing'}; everything else on the account "
                    f"({sorted(held)}) is the user's and is never traded")
    if fallback:
        _record_order_error('*', venue, "ledger: Blave waited and could not read "
                            f"{sorted(left) + sorted(unknown)} (for a strategy: nor tell which coin "
                            "it trades) — those positions are left to you (never traded by Blave); "
                            "everything else trades normally again")
    return None


def _sign(x):
    return 1 if x > 0 else (-1 if x < 0 else 0)


def _qty_reader():
    """One auto_position_qty read per decision, lazily: (sym) -> signed base
    qty, 0.0 when not held, None when the venue reports no quantity."""
    cache = []

    def qty_of(sym):
        if not cache:
            from lib.venue_wiring import auto_position_qty
            cache.append(auto_position_qty())
        return None if cache[0] is None else (cache[0].get(sym) or 0.0)
    return qty_of


def _adopt_row(k, a_s, t, actual_row, venue, now, qty_of):
    """The bot's share of one held symbol under the migration rule
    (_auto_baseline), as a seed row — or None when it owns none of it.
    Raises _BaselineWait / the read's own error when it can't be decided."""
    t = t or {}
    t_s = _row_signed(t)
    if a_s * t_s <= 0:
        return None
    lots = native_units(t.get('asset_spec'), t.get('exchange'),
                        (actual_row or {}).get('exchange'), actual=actual_row)
    sym, market = split_key(k)
    q = a_s if lots else _spot_holding(sym) if market == 'spot' else qty_of(sym)
    if q is not None and float(q) * a_s <= 0:
        raise _BaselineWait('qty_mismatch', k)  # the quantity read disagrees with the position read
    if q is not None and venue is None and not lots:
        raise _BaselineWait('no_venue', k)
    # cost is never above the target: the round after never sells what was adopted
    size = _sign(a_s) * min(abs(a_s), abs(t_s))
    if q is None:  # a venue that reports no quantity: legacy row, as before
        return {'size': size, 'qty': None, 'ts': now, 'venue': venue, 'symbol': k}
    if abs(a_s) <= _ADOPT_WHOLE_RATIO * abs(t_s):
        # close to the target: the whole position is the bot's (Wei 2026-09-23) —
        # a profitable bot position is worth more than its target, and splitting
        # it would leave the bot's own last lot to the user. Already whole lots.
        qq = abs(float(q))
    else:
        # 12 significant digits first: 0.0014 × 50/70 is 0.000999…, and a
        # step floor would take a whole lot off it (same reason as _ledger_walk)
        raw = float(f"{abs(float(q)) * abs(t_s) / abs(a_s):.12g}")
        qq = _venue_quantize(venue, k, raw, lots)
        if qq <= 0:
            return None
        size = a_s * qq / abs(float(q))
    return {'size': size, 'qty': _sign(a_s) * qq, 'ts': now, 'venue': venue, 'symbol': k}


def _strategy_key(name):
    """The book key ("SYM" / "SYM@spot") a strategy trades, without its
    state.json: stats.json (written on every run), else strategy.py's SYMBOL
    constant. None when neither says."""
    sym = None
    try:
        sym = (load_json(f'strategies/{name}/stats.json') or {}).get('symbol')
    except (OSError, ValueError, AttributeError):
        pass
    if not sym:
        try:
            m = _SYMBOL_RE.search(_strategy_source(name))
            sym = m.group(1) if m else None
        except (OSError, ValueError):
            sym = None
    if not sym or not isinstance(sym, str):
        return None
    config = load_portfolio_config()
    sym = execution_symbol(name, sym.replace('-', '').upper(), config)
    return market_key(sym, _paper_tw_market((config.get('exchanges') or {}).get(name), sym,
                                            strategy_market(name)))


def _pending_symbols(venue):
    """Symbols waiting in the seed's `pending` — this venue's (None: every venue's)."""
    out = set()
    for pk in (_load_ledger_seed().get('pending') or {}):
        v, sym = pk.split('|', 1) if '|' in pk else (None, pk)
        if venue is None or v == venue:
            out.add(sym)
    return out


_SYMBOL_RE = re.compile(r'^\s*SYMBOL\s*=\s*["\']([^"\']+)["\']', re.M)
_pending_seen = {}  # pending key -> the side seen last round (two reads before deciding)


def resolve_pending(target, actual, config):
    """Symbols the baseline left waiting on a strategy whose state was
    unreadable (seed `pending`). Each is decided by the migration rule once its
    strategy reads again and two rounds saw the same side — the strategy's own
    position is then adopted, not bought a second time. Returns the keys of
    this venue still waiting: reconcile keeps them out of both sides of the
    diff, like a signal-gated symbol."""
    venue = book_venue()
    seed = _load_ledger_seed()
    mine = {pk: info for pk, info in (seed.get('pending') or {}).items()
            if (pk.split('|', 1)[0] if '|' in pk else None) == venue}
    if not mine:
        return set()
    unread = set(_funded_states_unreadable(config))
    still, done = set(), {}
    now = datetime.utcnow().isoformat()
    qty_of = _qty_reader()
    for pk, info in mine.items():
        sym = pk.split('|', 1)[1] if '|' in pk else pk
        if (info or {}).get('strategy') in unread:
            still.add(sym)
            continue
        a_s = _row_signed((actual or {}).get(sym))
        if _pending_seen.get(pk) != _sign(a_s):
            _pending_seen[pk] = _sign(a_s)
            still.add(sym)
            continue
        try:
            row = _adopt_row(sym, a_s, (target or {}).get(sym), (actual or {}).get(sym),
                             venue, now, qty_of) if a_s else None
        except Exception as e:
            logging.warning(f"[ledger] {sym}: pending baseline not decided yet ({e})")
            still.add(sym)
            continue
        done[pk] = row or {'size': 0.0, 'qty': 0.0, 'ts': now, 'venue': venue, 'symbol': sym}
    if done:
        for pk, row in done.items():
            seed['pending'].pop(pk, None)
            _pending_seen.pop(pk, None)
            seed['symbols'][pk] = row
        _save_ledger_seed(seed)
        decided = {r['symbol']: {'size': round(r['size'], 2), 'qty': r['qty']} for r in done.values()}
        guard.audit('ledger_baseline_pending', venue=venue, decided=decided)
        logging.warning(f"[ledger] waited-on symbols decided for {venue}: {decided}")
    return still


def _ledger_walk(venue=_CURRENT):
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
    month_fns = {}

    def _row(symbol):
        return book.setdefault(symbol, {'qty': 0.0, 'cost': 0.0, 'legacy': False,
                                        'gross': 0.0, 'netted': 0.0})

    def _month_fn(exchange):
        if exchange not in month_fns:
            month_fns[exchange] = _contract_month_fn(exchange)
        return month_fns[exchange]

    def _note(symbol, **kw):
        notes.setdefault(symbol, {}).update(kw)

    # one venue's book: its own rows and fills, plus rows from before books were
    # per venue (no venue at all). The latest row of a symbol is its baseline.
    venue = _resolve_venue(venue)
    reset_at = seed.get('venue_reset', {}).get(venue, '') if venue else ''
    base = {}
    for srow in seed['symbols'].values():
        if venue is not None and srow['venue'] not in (None, venue):
            continue
        if reset_at and srow['ts'] <= reset_at:
            continue  # written for the account that was bound here before
        prev = base.get(srow['symbol'])
        if prev is None or srow['ts'] >= prev['ts']:
            base[srow['symbol']] = srow

    for symbol, srow in base.items():
        r = _row(symbol)
        r['cost'] = srow['size']
        if srow['qty'] is not None:
            r['qty'] = srow['qty']
            r['gross'] = abs(srow['qty'])
        elif abs(srow['size']) > 1e-9:
            r['legacy'] = True
            _note(symbol, old_format=True, legacy='seed row has no qty')
        if _month_fn(srow['venue'] or venue):
            _months_seed(r, srow)

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
        if flat_qty:
            r['netted'] = 0.0
            if 'months' in r:
                r['months'], r['guess'] = {}, False
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
        if venue is not None and entry.get('exchange') not in (None, venue):
            continue  # another venue's fill: never this venue's position
        if reset_at and str(entry.get('ts') or '') <= reset_at:
            continue  # the previous account's fill on this venue
        cutoff = base.get(symbol, {}).get('ts') or seed['seeded_at']
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
            before = r['qty']
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
                # the part of this entry that netted into the user's opposite
                # position on a one-way account (lib.venue_wiring._netted_room)
                try:
                    r['netted'] += min(abs(sq), abs(float(leg.get('netted_qty') or 0)))
                except (TypeError, ValueError):
                    pass
            elif abs(sq) <= abs(r['qty']) + _tol(r):
                r['cost'] -= r['cost'] * min(1.0, abs(sq) / abs(r['qty']))
                r['qty'] += sq
                if leg.get('netted_exit'):
                    r['netted'] = max(0.0, r['netted'] - abs(sq))
                r['netted'] = min(r['netted'], abs(r['qty']))
            else:
                # sold through zero: the excess opens the other side at this
                # fill's own price
                over = sq + r['qty']
                r['cost'] = d * (over / sq)
                r['qty'] = over
                r['netted'] = 0.0
            fn = _month_fn(entry.get('exchange') or venue)
            if fn:
                _months_step(r, before, sq, fn(leg.get('resolved_symbol')), entry.get('ts'))

    for symbol, r in book.items():
        _settle(symbol, r)
    # 12 significant digits: 0.003 + 0.007 is 0.009999999999999998 in floats,
    # and an order lib flooring THAT to a 0.001 step closes 0.009 of a 0.01
    # position. Far finer than any venue's step, far coarser than the noise.
    out = {}
    for k, r in book.items():
        out[k] = {'qty': float(f"{r['qty']:.12g}"), 'cost': r['cost'],
                  'legacy': r['legacy'], 'netted': float(f"{r['netted']:.12g}")}
        if 'months' in r:
            out[k]['months'] = {m: float(f"{q:.12g}") for m, q in r['months'].items()}
            out[k]['guess'] = r['guess']
    return out, notes


# ── contract months (TW futures) ─────────────────────────────────────────────
# A futures book row also says which contract month its lots are in, so the bot
# closes and counts only its own month (the user's other months are theirs) and
# a cash settlement can be booked (settle_expired_months). The month comes from
# each fill's `resolved_symbol` (群益 TX2610, 統一 TXFJ6) through the venue
# account lib's contract_month(); a venue without one (crypto) has no months
# and its rows are exactly what they were. A lot with no recorded month (a fill
# from before resolved_symbol, a seed row) is put in the front month at its
# timestamp and the row marked `guess`: a guessed month is never used to call
# another month the user's (book_months_of answers None for it), only to see a
# settlement that left the account holding nothing of that root.

def _contract_month_fn(venue):
    if not venue_traits.has(venue, 'hand_wired'):
        return None
    import importlib
    try:
        return getattr(importlib.import_module(f"lib.account_{venue}"), 'contract_month', None)
    except ImportError:
        return None


def _front_ym_at(ts):
    from lib import president_contracts as tw
    try:
        at = datetime.fromisoformat(str(ts)).replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        at = None
    return tw.front_ym(at)


def _months_seed(r, srow):
    r['months'], r['guess'] = {}, False
    if abs(r['qty']) <= 1e-9 or r['legacy']:
        r['guess'] = bool(r['legacy'])
        return
    months = srow.get('months') or {}
    if months and abs(sum(months.values()) - r['qty']) <= 1e-9:
        r['months'] = dict(months)
    else:
        r['months'], r['guess'] = {_front_ym_at(srow['ts']): r['qty']}, True


def _months_step(r, before, q, month, ts):
    """Move one fill of `q` lots (month = the contract it filled in, None if not
    recorded) into r['months'], after r['qty'] went from `before` to its value."""
    tol = 1e-9
    after = r['qty']
    months = r.setdefault('months', {})
    r.setdefault('guess', False)
    if r['legacy'] or q is None:
        r['months'], r['guess'] = {}, True  # a quantity that cannot be known has no month
        return
    if abs(after) <= tol:
        r['months'], r['guess'] = {}, False
        return
    guessed = month is None
    if abs(before) <= tol or before * after < 0:  # opened, or sold through zero
        r['months'], r['guess'] = {month or _front_ym_at(ts): after}, guessed
        return
    if before * q > 0:
        month = month or _front_ym_at(ts)
        months[month] = months.get(month, 0.0) + q
        r['guess'] = r['guess'] or guessed
    else:
        # a close takes from the month it was sent to, then from the others
        take = abs(q)
        for m in ([month] if month in months else []) + sorted(k for k in months if k != month):
            t = min(take, abs(months[m]))
            months[m] -= t if months[m] > 0 else -t
            take -= t
            if take <= tol:
                break
    gap = after - sum(months.values())
    if abs(gap) > tol:
        m = max(months, key=lambda k: abs(months[k])) if months else _front_ym_at(ts)
        months[m] = months.get(m, 0.0) + gap
        r['guess'] = True
    r['months'] = {m: v for m, v in months.items() if abs(v) > tol}


def book_months_of(rows):
    """{symbol: {'YYYY-MM', …} | None} from ledger_positions() rows that carry
    months (TW futures) — what lib.president_contracts.bot_rows and the 群益
    read take as `book_months`. None for a row whose month was guessed, and
    for a row with no months at all (a book replayed with no venue to ask,
    book_venue() None): the calendar keeps deciding that root, as before
    months were recorded. Leaving such a row out would read as "the book
    holds none of this root" and turn the bot's own lots into manual ones."""
    out = {}
    for symbol, row in (rows or {}).items():
        if 'months' not in row or row.get('months_guess'):
            out[symbol] = None
            continue
        out[symbol] = set(row['months'])
    return out


def book_months(venue=_CURRENT, config=None):
    """book_months_of(ledger_positions(venue)), or None when there is no book to
    ask (the account-read mode, no baseline yet, an unreadable book)."""
    try:
        config = load_portfolio_config() if config is None else config
        if not (own_positions_only(config) and book_ready(config)):
            return None
        return book_months_of(ledger_positions(venue))
    except Exception as e:
        logging.warning(f"[ledger] book months unreadable ({type(e).__name__}: {e}) — "
                        f"the calendar decides which contract months are the bot's")
        return None


def past_settlement(row, now=None):
    """True when every contract month an account row carries (`months`, TW
    futures) has passed its settlement time — such a row can vanish from the
    account without anything being wrong (cash settlement)."""
    months = (row or {}).get('months') if isinstance(row, dict) else None
    if not months:
        return False
    from lib import president_contracts as tw
    return all(tw.settled_by_time(m, now) for m in months)


def ledger_book(venue=_CURRENT):
    """{symbol: {'qty': signed base, 'cost': signed USD, 'legacy': bool}} for
    every symbol the bot holds — see _ledger_walk. A legacy row's qty is
    whatever could be replayed and must not be sized from."""
    return {k: r for k, r in _ledger_walk(venue)[0].items() if abs(r['cost']) > 1e-9}


def ledger_positions(venue=_CURRENT):
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
    for symbol, r in ledger_book(venue).items():
        out[symbol] = {'side': 'long' if r['cost'] > 0 else 'short',
                       'size': abs(r['cost']), 'qty': abs(r['qty']),
                       'netted': r.get('netted', 0.0)}
        if r['legacy']:
            out[symbol]['legacy'] = True
        if 'months' in r:
            # signed lots per contract month ('2026-10'); months_guess = some of
            # it has no recorded month (see _ledger_walk)
            out[symbol]['months'] = dict(r['months'])
            if r['guess']:
                out[symbol]['months_guess'] = True
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
        raw = load_json(_ACCOUNT_SHORT_PATH)
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
        atomic_replace(tmp, _ACCOUNT_SHORT_PATH)
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


def apply_ledger_writeoff(symbol, reason, venue=_CURRENT, **detail):
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
    guard.mark_money_process()  # writes the ledger: Stop in the chat never kills this process (lib/guard)
    try:
        row = ledger_book(venue).get(symbol) or {}
    except Exception:
        row = {}
    zero_ledger_symbols({symbol}, venue)
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


def settle_expired_months(actual, venue=_CURRENT, now=None):
    """Book a TW futures cash settlement: a contract month the book holds whose
    settlement time (third Wednesday 13:30 Taipei) has passed and that the
    account no longer holds is dropped from the book — audit `ledger_settled`,
    no notification (an expected roll, not a mismatch) — and the next diff
    re-enters the target in the month trading now. Every round, not only on a
    close: with the signal unchanged nothing else would ever notice.

    Still held past its settlement time = a holiday-postponed settlement (or a
    residue the venue lib already left out of `actual`): kept. 統一 lists its
    contracts (account_president.listed_months): a month it still lists is
    kept, an unread list decides nothing this round. 群益 has no list, so an
    absent row is the evidence. Either way two reads ≥ _ACCOUNT_SHORT_MIN_S
    apart (note_account_short) — one row dropped from one answer must not book
    a live position away. A guessed month (no resolved_symbol on its fill)
    counts only when the account holds nothing of that root at all.
    Returns the symbols whose book changed."""
    venue = _resolve_venue(venue)
    if not _contract_month_fn(venue):
        return set()
    import importlib
    from lib import president_contracts as tw
    try:
        listed_fn = getattr(importlib.import_module(f"lib.account_{venue}"), 'listed_months', None)
    except ImportError:
        listed_fn = None
    changed = set()
    for symbol, r in _ledger_walk(venue)[0].items():
        months = r.get('months') or {}
        held_row = (actual or {}).get(symbol) or {}
        held = held_row.get('months') or {}
        gone = []
        for m in months:
            if not tw.settled_by_time(m, now) or m in held:
                continue
            if r.get('guess') and float(held_row.get('size') or 0):
                continue
            if listed_fn:
                try:
                    listed = listed_fn(symbol)
                except Exception:
                    listed = None
                if listed is None or m in listed:
                    continue
            gone.append(m)
        key = f"{symbol}#settled"
        if not note_account_short(key, bool(gone)):
            continue
        note_account_short(key, False)
        keep = {m: q for m, q in months.items() if m not in gone}
        _rebase_ledger_symbol(symbol, venue, keep)
        pending = _load_account_short()
        if pending.pop(symbol, None):
            _save_account_short(pending)  # that short read was the settlement
        lots = sum(q for m, q in months.items() if m in gone)
        logging.warning(f"[ledger] {symbol}: {lots:+g} lots in {', '.join(sorted(gone))} "
                        f"cash-settled — off the book; the target re-enters in the month trading now")
        guard.audit('ledger_settled', symbol=symbol, venue=venue, months=sorted(gone), qty=lots,
                    guessed=bool(r.get('guess')))
        changed.add(symbol)
    return changed


def book_late_fill(symbol, venue, contract, lots):
    """One orders.jsonl line for `lots` (signed) of `symbol` in `contract` that
    the venue confirmed only after the order call had returned without the fill
    (統一 'sent' / 'unknown' — manager/reconciler._president_claim_pending). The
    usual replay (_ledger_walk) books it and takes its month from `contract`, so
    the trade history and the book stay one source; a guess row stays a guess.
    No fill price: none was reported. _append_reconciler_log's write failure
    trips HALT — a late fill left out is exactly the fill the next diff re-sends."""
    venue = _resolve_venue(venue)
    lots = float(lots)
    held = (ledger_book(venue).get(symbol) or {}).get('qty') or 0.0
    _append_reconciler_log({'action': 'BUY' if lots > 0 else 'SELL', 'symbol': symbol,
                            'signed_diff': lots, 'exchange': venue, 'late_fill': True,
                            'contributors': [],
                            'legs': [{'signed_diff': lots, 'reduce_only': held * lots < 0,
                                      'signed_qty': lots, 'executed_qty': abs(lots),
                                      'resolved_symbol': contract}]})


def _rebase_ledger_symbol(symbol, venue, months, qty=None):
    """One symbol's book restarts now at `months` ({} = flat) — a lots row,
    so its cost is its quantity. With `qty` and months=None the lots have no
    known month (the seed row is then read as a guessed front month)."""
    guard.mark_money_process()  # writes the ledger: Stop in the chat never kills this process (lib/guard)
    seed = _load_ledger_seed()
    qty = float(sum(months.values())) if qty is None else float(qty)
    row = {'size': qty, 'qty': qty, 'ts': datetime.utcnow().isoformat(), 'venue': venue,
           'symbol': symbol}
    if months is not None:
        row['months'] = dict(months)
    seed['symbols'][_seed_key(symbol, venue)] = row
    _save_ledger_seed(seed)


def hand_wired_reduce_cap(symbol, sub_diff, book_signed, account_row, venue=_CURRENT,
                          book_row=None):
    """(signed lots to send, writeoff reason | None) for a self_ledger reduce
    leg on a hand-wired venue (lib.venue_traits: 群益, 統一). Neither refuses a
    close larger than what is held the way a crypto reduce-only order is
    refused: 群益 sends sNewClose=2 (auto new/close), so the rest OPENS the
    other side; 統一 refuses it locally, every round, and the book is never
    corrected. So, on the round's own account read (lots): never more than
    the account holds, and an unconfirmed empty read sends nothing.

    This rule has split from the crypto one on purpose — do not "align" them.
    lib.venue_wiring._book_reduce_qty still sends min(book, account), does not
    count a manual close as part of the reduce, and never rebases the book on
    a partial reduce (the venue's reduce-only refusal is its safety net).
    Here the lots the account is short of the book (the user closed them by
    hand) already did that much of the reduce, so only the rest is sent: book
    3, account 2, target 1 sends 1, not 2. On a confirmed short read
    (note_account_short) a full close writes the rest of the book off after
    its fill (the reason returned); a partial one brings the book down to what
    the account holds right here, before the send — otherwise the gap is never
    reconciled until the next flat and every later add stacks on a book that
    is wrong.

    What that rebase trusts: two short reads ≥ _ACCOUNT_SHORT_MIN_S apart AND
    the contract months lining up — the account's months of this root (the
    read row's, plus the months the venue read left out as the user's,
    note_manual_read) must meet the book's. An account that holds this root
    only in months the book does not hold is not a manual close, it is a read
    the book cannot be corrected from (a month the venue lib misjudged, a
    snapshot behind): nothing is sent, nothing rebased, one order_error asks
    for a human (audit `ledger_month_mismatch`). A read that is simply wrong
    in the SAME month (fewer lots than are really there) cannot be told from
    a manual close and is rebased to — the reconciler's snapshot_caught_up
    gate keeps a post-order snapshot out of here. Lives here, not in the
    reconciler's blocks, so a hand-edited reconciler still gets it."""
    owned, want = abs(book_signed), abs(sub_diff)
    row = account_row or {}
    side = 'long' if book_signed > 0 else 'short'
    held = float(row.get('size') or 0) if row.get('side') == side else 0.0
    short = held < owned - 1e-9
    confirmed = note_account_short(symbol, short)
    send = max(0.0, min(want - max(0.0, owned - held), held))
    reason = None
    if short and want < owned - 1e-9:
        venue = _resolve_venue(venue)
        mismatch = _months_mismatch(symbol, venue, book_row, row)
        if mismatch:
            if confirmed:
                _note_months_mismatch(symbol, venue, book_signed, held, *mismatch)
            return 0.0, None
        if confirmed:
            _rebase_to_account(symbol, venue, book_signed, held, row,
                               'account short of the book on a partial reduce')
    elif confirmed and short:
        reason = 'account holds none of it' if held <= 0 else 'account held less than the book'
    return (send if sub_diff > 0 else -send), reason


# {venue: {root: {'YYYY-MM': signed lots}}} — the contract months the venue read
# left out of `actual` as the user's (the reconciler's manual rows), per read
_MANUAL_READ = {}
_mismatch_noted = set()


def note_manual_read(venue, by_root):
    """The venue read's manual months this round (see hand_wired_reduce_cap):
    replaces the venue's previous read, {} = none left out."""
    _MANUAL_READ[venue] = {str(k): dict(v or {}) for k, v in (by_root or {}).items()}


def _months_mismatch(symbol, venue, book_row, row):
    """(book months, account months) when the two do not meet, else None.
    No check without a book row that carries months, or on a guessed book."""
    book = book_row or {}
    if not book.get('months') or book.get('months_guess'):
        return None
    acct = set(row.get('months') or {}) | set(_MANUAL_READ.get(venue, {}).get(symbol, {}))
    if not acct or acct & set(book['months']):
        return None
    return sorted(book['months']), sorted(acct)


def _note_months_mismatch(symbol, venue, book_signed, held, book_months, acct_months):
    key = (venue, symbol, tuple(book_months), tuple(acct_months))
    if key in _mismatch_noted:
        return
    _mismatch_noted.add(key)
    logging.error(f"[ledger] {symbol}: book {book_signed:+g} lots in {', '.join(book_months)}, "
                  f"the account holds this root only in {', '.join(acct_months)} — not a manual "
                  f"close: nothing sent, book not corrected, needs a human")
    guard.audit('ledger_month_mismatch', symbol=symbol, venue=venue, book=book_signed, held=held,
                book_months=book_months, account_months=acct_months)
    _record_order_error(symbol, venue, f"帳本與帳戶月份對不上,待人工核對:帳本 {book_signed:+g} 口在 "
                                       f"{'、'.join(book_months)},帳戶只有 {'、'.join(acct_months)}"
                                       f"——本輪不減倉、帳本不動")


def _rebase_to_account(symbol, venue, book_signed, held, row, reason):
    signed = held if book_signed > 0 else -held
    months = row.get('months') if row.get('side') == ('long' if book_signed > 0 else 'short') else {}
    if not isinstance(months, dict) or abs(sum(months.values()) - signed) > 1e-9:
        months = None  # a month split that does not add up is not trusted: guessed front month
    _rebase_ledger_symbol(symbol, venue, months, qty=signed)
    seen = _load_account_short()
    short = seen.pop(symbol, None)
    if short:
        _save_account_short(seen)
    logging.warning(f"[ledger] {symbol}: book {book_signed:+g} lots, the account holds {signed:+g} "
                    f"— book brought down to the account ({reason})")
    guard.audit('ledger_writeoff', symbol=symbol, reason=reason, partial=True, venue=venue,
                qty=book_signed - signed, cost=book_signed - signed,
                short_first=datetime.utcfromtimestamp(short['first']).isoformat() if short else None)


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
        atomic_replace(tmp, _LEDGER_ADOPTION_PATH)
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
        raw = load_json(_SIGNAL_GATE_PATH)
        return {str(k): float(v) for k, v in (raw or {}).items()}
    except (OSError, ValueError, TypeError, AttributeError):
        return {}


def _save_signal_gate(gate):
    try:
        os.makedirs(os.path.dirname(_SIGNAL_GATE_PATH), exist_ok=True)
        tmp = _SIGNAL_GATE_PATH + '.tmp'
        with open(tmp, 'w') as f:
            json.dump(gate, f, indent=2)
        atomic_replace(tmp, _SIGNAL_GATE_PATH)
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


def _strategy_source(name):
    """strategy.py as text for the constant regexes. Decoded as Python would (a PEP 263 coding
    line, else UTF-8); a file in neither (a Big5 save) is read with replacement characters
    rather than raising — the constants are ASCII, and a decode error here used to take the
    whole reconcile round down with it. OSError is the caller's."""
    import tokenize
    try:
        with tokenize.open(f'strategies/{name}/strategy.py') as f:
            return f.read()
    except (SyntaxError, ValueError):
        with open(f'strategies/{name}/strategy.py', 'rb') as f:
            return f.read().decode('utf-8', 'replace')


def strategy_market(name):
    """'spot' | 'swap' from the strategy.py MARKET constant (default swap)."""
    try:
        m = _MARKET_RE.search(_strategy_source(name))
        return m.group(1) if m else 'swap'
    except (OSError, ValueError):
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


# ── execution contract (TXF / MXF / TMF) ────────────────────────────────────
# The three index futures run on one series (lib.data.fetch_twfutures_ohlcv maps
# MXF/TMF to TXF), so a strategy's SYMBOL only picks the contract it trades.
# portfolio_config["contracts"] = {strategy: root} swaps that contract without
# touching the strategy — a deployment setting written by the UI save
# (runtime _cmd_amounts, UI-authoritative like `amounts`). The book key IS the
# root, so every strategy→key mapping goes through execution_symbol.
TXF_FAMILY = ('TXF', 'MXF', 'TMF')
# TWD per index point: 1 TXF = 4 MXF = 20 TMF. A close of a contract no strategy
# trades any more (the one switched away from) is valued with the KEY's own
# number — the strategy's spec already says the new contract.
TXF_FAMILY_CONTRACT_VALUE = {'TXF': 200, 'MXF': 50, 'TMF': 10}


def txf_root(symbol):
    """'TXF' / 'MXF' / 'TMF' for a family symbol (Shioaji 'R1' suffix accepted), else None."""
    s = str(symbol or '').replace('-', '').upper()
    if s.endswith('R1') and len(s) > 2:
        s = s[:-2]
    return s if s in TXF_FAMILY else None


def execution_symbol(name, signal_symbol, config):
    """The symbol strategy `name` trades: its contracts override when the signal
    symbol is a TXF-family root and the override is one too, else the symbol."""
    if not txf_root(signal_symbol):
        return signal_symbol
    want = ((config or {}).get('contracts') or {}).get(name)
    return want if isinstance(want, str) and want in TXF_FAMILY else signal_symbol


def is_txf_family_key(key):
    sym, market = split_key(key)
    return market != 'spot' and txf_root(sym) is not None


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
                and _paper_tw_market(exchanges.get(name), sym, strategy_market(name)) == 'spot':
            out.add(sym)
    return out


_SPOT_SCOPE_PATH = 'manager/spot_scope.json'


# threshold default is manager/reconciler.py THRESHOLD (both lib.execute.RECONCILE_THRESHOLD):
# a scope threshold above the reconcile one strands inventory in scope forever
# (rows below reconcile threshold never sell, never leave scope) — audit L1
def spot_scope(inventory_value_fn, threshold=RECONCILE_THRESHOLD):
    """{symbol: usd_value} of every spot inventory the reconciler must treat
    as `actual` — and the rule that makes REMOVING a spot strategy exit its
    position instead of orphaning it (futures parity: strategy leaves →
    position closes).

    Scope = funded spot strategies (spot_symbols) ∪ previously-managed symbols
    persisted in manager/spot_scope.json. A symbol leaves the persisted scope
    only when its inventory value drops below the reconcile threshold — so
    after removal the actual-only row keeps generating sell orders until the
    inventory is gone. Personal coins in symbols no strategy targets never
    enter. A targeted symbol's wallet is one pool of the bot's and the user's
    coins, so what the bot may sell is never read from it: under
    own_positions_only the diff is against the book and a spot sell is capped
    at min(book quantity, wallet) — a book row without a quantity is not sold
    at all (lib.venue_wiring._spot_legacy_refused). Only the explicit
    `"self_ledger": false` opt-out still trades the whole pool (audit M5).
    inventory_value_fn(symbol) -> USD value; its errors PROPAGATE
    (a failed read silently dropping a symbol from scope would strand
    inventory — same error contract as get_positions)."""
    targeted = spot_symbols()
    try:
        prev = set(load_json(_SPOT_SCOPE_PATH))
    except FileNotFoundError:
        prev = set()
    except (ValueError, TypeError):
        # not a list of symbols (a crash mid-write before atomic writes): what it held is gone
        # either way; set aside so it is not lost for good, start from the targets
        logging.error(f'{_SPOT_SCOPE_PATH} unreadable — set aside as .corrupt; previously '
                      f'managed spot symbols outside the targets are no longer in scope')
        atomic_replace(_SPOT_SCOPE_PATH, _SPOT_SCOPE_PATH + '.corrupt')
        prev = set()
    # any other OSError (still locked after the retries) propagates: a scope read without the
    # persisted symbols would drop them and strand their inventory (the contract above)
    values = {}
    for sym in sorted(targeted | prev):
        values[sym] = float(inventory_value_fn(sym))
    keep = targeted | {s for s, v in values.items() if v >= threshold}
    try:  # best-effort persist — next round recomputes from targets anyway
        os.makedirs('manager', exist_ok=True)
        tmp = f'{_SPOT_SCOPE_PATH}.{os.getpid()}.tmp'  # the reconciler and flatten both write it
        with open(tmp, 'w') as f:
            json.dump(sorted(keep), f)
        atomic_replace(tmp, _SPOT_SCOPE_PATH)
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
    """{'amounts': {name: float}, 'exchanges': {name: str}[, 'contracts':
    {name: root}]} from the UI mirror, or None when absent/invalid (fail-open —
    see section comment). `contracts` only when the mirror carries the key: a
    mirror written by a runtime that predates it must not clear the config's
    overrides (that would trade the saved TMF lots as TXF lots)."""
    try:
        raw = load_json(_UI_MIRROR_PATH)
        amounts = raw.get('amounts')
        exchanges = raw.get('exchanges')
        if not isinstance(amounts, dict) or not isinstance(exchanges, dict):
            return None
        out = {'amounts': {str(k): float(v) for k, v in amounts.items()},
               'exchanges': {str(k): str(v if v is not None else '')
                             for k, v in exchanges.items()}}
        if 'contracts' in raw:
            contracts = raw.get('contracts')
            if not isinstance(contracts, dict):
                return None
            out['contracts'] = {str(k): str(v) for k, v in contracts.items() if v in TXF_FAMILY}
        return out
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


_PORTFOLIO_CONFIG_PATH = 'manager/portfolio_config.json'
_unconfigured_logged = False


def portfolio_configured():
    """True once the user has saved amounts at least once: portfolio_config.json
    (or the UI mirror the platform writes just before it) exists. A MISSING file
    is "never configured", not "every amount is 0" — see reconcile()."""
    return os.path.exists(_PORTFOLIO_CONFIG_PATH) or os.path.exists(_UI_MIRROR_PATH)


def own_positions_only(config):
    """True = the bot diffs, sizes and closes against its OWN book (the
    self-ledger), never the account's whole position — a position the bot did
    not open is never touched (Wei 2026-09-23). Every machine, whatever its
    config says, except one whose config explicitly carries
    `"self_ledger": false` (account-read mode kept as an explicit opt-out;
    nothing in Blave writes that value). A missing key used to mean
    account-read, which read a user's manual positions as the bot's and closed
    them whenever no strategy targeted them."""
    return (config or {}).get('self_ledger') is not False


def load_portfolio_config():
    """Load portfolio_config.json from manager/ directory.

    Deployment redline (L2): when manager/amounts.ui.json exists, the
    returned dict's `amounts`/`exchanges` come from IT — see the
    UI-authoritative section above. Single choke point for the override."""
    path = 'manager/portfolio_config.json'
    if not os.path.exists(path):
        config = {'account_value': 0, 'weights': {}, 'exchanges': {}, 'asset_specs': {}}
    else:
        config = load_json(path)
    ui = _load_ui_mirror()
    if ui is not None and isinstance(config, dict):
        if config.get('amounts') != ui['amounts'] \
                or config.get('exchanges') != ui['exchanges'] \
                or ('contracts' in ui and (config.get('contracts') or {}) != ui['contracts']):
            _ui_override_alert((config.get('amounts'), config.get('exchanges'), ui))
        config['amounts'] = ui['amounts']
        config['exchanges'] = ui['exchanges']
        if 'contracts' in ui:
            config['contracts'] = ui['contracts']
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
            states[name] = load_json(path)
        except Exception as e:
            logging.warning(f"Failed to load state {path}: {e}")
    return states


def removed_asset_specs(config, target):
    """{key: asset_spec} for the strategies aggregate_portfolio left out (amount
    0, unpicked) whose spec is still in the config — keyed like their target
    row would be, so a close-on-removal row finds the spec its entry used."""
    out = {}
    specs = config.get('asset_specs')
    if not isinstance(specs, dict) or not specs:
        return out
    states = load_all_states()
    for name, spec in specs.items():
        sym = (states.get(name) or {}).get('symbol')
        if not isinstance(spec, dict) or not sym:
            continue
        sym = execution_symbol(name, str(sym).replace('-', '').upper(), config)
        key = market_key(sym, strategy_market(name))
        if key not in target:
            out.setdefault(key, spec)
    for name, spec in specs.items():
        # the contract a strategy was switched away from: its spec now says the
        # new contract, so the old key's close is valued with the key's own
        # contract_value (paper refuses a fill whose value differs from the held)
        root = txf_root((states.get(name) or {}).get('symbol'))
        if not root or not isinstance(spec, dict) or spec.get('type') != 'futures_contracts':
            continue
        for k in TXF_FAMILY:
            if k in target:
                continue
            have = out.get(k)
            if have is None or have.get('contract_value') != TXF_FAMILY_CONTRACT_VALUE[k]:
                # only the unit fields: anything venue-specific in the strategy's
                # spec (a hand-written capital_symbol) names the NEW contract
                out[k] = {f: spec[f] for f in ('type', 'currency', 'lot_size') if f in spec}
                out[k]['contract_value'] = TXF_FAMILY_CONTRACT_VALUE[k]
    return out


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


def _unrouted_member_keys(amounts, exchanges, states, config, book=None):
    """[(name, key)] for every `amounts` member whose routing is blank: the keys its state
    trades (Type C: every weight; else its symbol, routed by its contract), or, with no
    readable state, the key stats.json / SYMBOL name. A member whose key cannot be told at all
    is left out (logged) — it has never traded anything to protect.

    A TW stock key outside spot also holds its `@spot` twin: routed to paper it was
    bought as cash shares (_paper_tw_market), and a blank route no longer says whether
    it was paper — holding only `2330` let the reconciler sell the `2330@spot` it owns.
    `book` (the own-positions book's keys) narrows that to a twin the book really holds,
    so a strategy that never bought on paper does not freeze another one's entry on
    `2330@spot`; None (account-read mode, or the book unreadable) holds the twin."""
    out = []
    for name in amounts:
        if (exchanges or {}).get(name):
            continue
        state = states.get(name) or {}
        market = strategy_market(name)
        keys = []
        if isinstance(state.get('weights'), dict):
            keys = [market_key(str(sym).replace('-', '').upper(), market) for sym in state['weights']]
        elif state.get('symbol'):
            sym = execution_symbol(name, str(state['symbol']).replace('-', '').upper(), config)
            keys = [market_key(sym, market)]
        else:
            k = _strategy_key(name)
            if k:
                keys = [k]
            else:
                logging.warning(f"[portfolio] {name}: no exchange routed and no symbol to hold")
        twins = [market_key(split_key(k)[0], 'spot') for k in keys
                 if split_key(k)[1] != 'spot' and _tw_stock(split_key(k)[0])]
        twins = [t for t in twins if book is None or t in book]
        out.extend((name, k) for k in dict.fromkeys(keys + twins))
    return out


# A funded member that has not written its first state.json yet (just joined — runtime
# _retire_prejoin_signals moved an old one away — or never computed) leaves what it replaces on
# the book until it does. Without it, swapping a strategy for a new version on the same coin closed
# the position one round (the newcomer contributes nothing yet) and bought it back the next.
# What it replaces is fixed at its first trusted round from the previous round's snapshot: the
# shares of the members that no longer contribute (left `amounts`, set to 0, waiting again), each
# bounded by what the book holds beyond the others' share — a target that never reached the book
# (HALT, a rejected order, a hand close, a signal gate) is nothing to keep. In account-read mode the
# book also moves by hand and with the mark: each round the hold shrinks (never grows) to what the
# book has beyond the others' share as of the previous round, so a neighbour's stop after a hand
# close is not absorbed by a hold the book no longer has. Inside the window the key's target is the
# others' target now plus that hold, clamped into [book now, others now] and into [book now, this
# same round's target without the wait] — the second bound is the guarantee: no round sends more
# than, or the other way from, what it would send without the wait. Two newcomers on one key swap
# together (the first to compute waits for the other) only where that bound allows. A newcomer
# routed to another exchange than the book's / the leavers' holds nothing: the old position is on an
# account the newcomer's exits never reach. A member that has had a share of the key is never a
# newcomer: waiting again it is a departure whose own next signal trades. One bar of the newcomer's
# INTERVAL at most, never longer than FIRST_SIGNAL_WAIT_MAX_S: past that it is reconciled as before
# (no state = no contribution), so a member that never computes can never park an exit.
FIRST_SIGNAL_WAIT_MAX_S = 7200
_FIRST_SIGNAL_WAIT_PATH = 'state/first_signal_wait.json'
_FIRST_SIGNAL_CLOCK_SKEW_S = 300
_INTERVAL_RE = re.compile(r'^\s*INTERVAL\s*=\s*["\']([^"\']+)["\']', re.M)
# same rule as the shell's trUniverse (# comments stripped first): what the save dialog can see
# is what is held
_UNIVERSE_RE = re.compile(r'^UNIVERSE\s*=\s*\[([^\]]*)\]', re.M)
# the book a failed write could not persist: newer than the file, so the next round reads it —
# a full disk must not restart every window each round
_first_signal_unsaved = None
_first_signal_errors = set()


def _strip_py_comments(src):
    """src without its # comments; a # inside a '…' / "…" literal on that line is kept."""
    out = []
    for line in src.split('\n'):
        quote, esc, cut = None, False, len(line)
        for i, ch in enumerate(line):
            if esc:
                esc = False
            elif quote:
                if ch == '\\':
                    esc = True
                elif ch == quote:
                    quote = None
            elif ch in '"\'':
                quote = ch
            elif ch == '#':
                cut = i
                break
        out.append(line[:cut])
    return '\n'.join(out)


def _bar_seconds(name):
    """The strategy's INTERVAL in seconds, None without a readable one (Type B)."""
    try:
        m = _INTERVAL_RE.search(_strategy_source(name))
        from lib.bar_ready import interval_to_timedelta
        bar = interval_to_timedelta(m.group(1)).total_seconds() if m else None
    except (OSError, ValueError, OverflowError):
        bar = None
    return bar if bar and bar > 0 else None


def _first_signal_window_s(name):
    bar = _bar_seconds(name)
    return min(bar, FIRST_SIGNAL_WAIT_MAX_S) if bar else FIRST_SIGNAL_WAIT_MAX_S


# A scheduled Type A/C tick that keeps failing leaves state.json at its last good target, and the
# reconciler would keep trading toward it (a US strategy hand-run once, then refused every tick).
# Stale = wait_for_bar's last failure is newer than state.json AND recent (a failing strategy
# fails again every few minutes: 300s backoff, a 15-min stall throttle, a 20-min run timeout — so
# TARGET_STALE_RECENT_S covers the slowest repeat) AND state.json is older than TARGET_STALE_BARS
# bars, at least TARGET_STALE_FLOOR_S, plus TARGET_STALE_WEEKEND_S for daily-and-longer bars of
# a market that closes on weekends (not a crypto-only strategy).
# Recency matters because only a successful run clears the failure: one transient error at the
# start of a data gap (a TAIFEX night-to-day gap, a weekend, a holiday) would otherwise read as
# stale for the whole gap. Left by design: a single failure while the next bar has not landed, on
# a target already past the age limit (after a long holiday), holds for at most
# TARGET_STALE_RECENT_S. Type B (no INTERVAL, no bar_wait contract) is not judged.
# What it holds: only the stale member's own share of the key, and only from growing — see
# _stale_share_targets. The other members on the key trade normally.
TARGET_STALE_BARS = 2
TARGET_STALE_FLOOR_S = 1800
TARGET_STALE_RECENT_S = 2700
TARGET_STALE_WEEKEND_S = 2 * 86400
_stale_targets_logged = set()


_CRYPTO_FETCHERS = frozenset(('fetch_kline', 'fetch_kline_batch', 'fetch_bingx_kline'))
_FETCHER_RE = re.compile(r'\bfetch_[a-z0-9_]+\b')


def _crypto_only(name):
    """Every lib.data fetcher the strategy names is a crypto kline (trades 7 days a week)."""
    try:
        found = set(_FETCHER_RE.findall(_strip_py_comments(_strategy_source(name))))
    except (OSError, ValueError):
        return False
    return bool(found) and found <= _CRYPTO_FETCHERS


def _stale_target_age(name, now=None):
    """Seconds since `name`'s state.json was written when that target is stale, else None."""
    bar = _bar_seconds(name)
    if not bar:
        return None
    try:
        failed = load_json(f'state/bar_wait/{name}.json').get('last_attempt_failed_at')
        written = os.path.getmtime(f'strategies/{name}/state.json')
    except (OSError, ValueError, AttributeError):
        return None
    now = time.time() if now is None else now
    if not _finite(failed) or failed < written or now - failed > TARGET_STALE_RECENT_S:
        return None
    limit = (max(TARGET_STALE_BARS * bar, TARGET_STALE_FLOOR_S)
             + (TARGET_STALE_WEEKEND_S if bar >= 86400 and not _crypto_only(name) else 0))
    age = now - written
    return age if age > limit else None


_STALE_SHARE_PATH = 'state/stale_share.json'
_stale_share_unsaved = None
_stale_share_last = {}  # the last book this process read or wrote: stands in for a corrupt file


def _stale_share_book():
    """{key: {'names': [...], 'share': signed}} — the share each key's stale members hold."""
    global _stale_share_last
    if _stale_share_unsaved is not None:
        return json.loads(json.dumps(_stale_share_unsaved))
    try:
        book = load_json(_STALE_SHARE_PATH)
    except OSError:
        return {}
    except ValueError:
        logging.warning(f"[reconcile] {_STALE_SHARE_PATH} unreadable — last known shares kept")
        return json.loads(json.dumps(_stale_share_last))
    book = {k: v for k, v in book.items() if isinstance(v, dict) and _finite(v.get('share'))
            and isinstance(v.get('names'), list)} if isinstance(book, dict) else {}
    _stale_share_last = book
    return json.loads(json.dumps(book))


def _stale_share_save(book):
    global _stale_share_unsaved, _stale_share_last
    try:
        os.makedirs(os.path.dirname(_STALE_SHARE_PATH), exist_ok=True)
        tmp = _STALE_SHARE_PATH + '.tmp'
        with open(tmp, 'w') as f:
            json.dump(book, f, indent=2)
        atomic_replace(tmp, _STALE_SHARE_PATH)
        _stale_share_unsaved = None
        _stale_share_last = book
    except OSError as e:
        _stale_share_unsaved = book
        logging.warning(f'stale_share persist failed (kept in memory): {e}')


def _toward_zero(x, bound):
    """x moved toward 0 so it never passes `bound` and never sits on the other side of it."""
    return min(max(x, min(0.0, bound)), max(0.0, bound))


def _stale_share_targets(target, book, skip_roots=(), stale_keys=None):
    """target with each key's stale members held to the share they had when they went stale.
    The share is fixed in the first stale round from the book and the OTHER members' targets of
    the previous round (what the book held for them — this round's may not be bought yet), kept
    on disk, and from then on only shrinks: toward the stale members' own target, and toward the
    whole key's book when that is smaller (a hand close, a partial fill, a mark drop). The other
    members trade their target as computed. Cleared once no member on the key is stale. A
    contract rollover in progress (skip_roots) is left as computed: the user's own switch moves
    the share to the new contract, and holding it there would close it. stale_keys = every key
    still stale this round, including those another hold takes out of `target`: their share
    stays as recorded."""
    anchors = _stale_share_book()
    if stale_keys is None:
        stale_keys = {k for k, v in target.items() if v.get('stale_target')}
    prev = None
    out, changed = dict(target), False
    for key, row in target.items():
        names = sorted(set(row.get('stale_target') or ()))
        if not names or row.get('gated') or row.get('awaiting'):
            continue
        sym, market = split_key(key)
        if market != 'spot' and txf_root(sym) in skip_roots:
            continue
        contribs = [c for c in row.get('contributors') or [] if isinstance(c, dict)]
        stale = sum(float(c.get('contribution') or 0) for c in contribs if c.get('strategy') in names)
        others = sum(float(c.get('contribution') or 0) for c in contribs if c.get('strategy') not in names)
        held_book = _row_signed(book.get(key))
        rec = anchors.get(key)
        if rec is None or rec['names'] != names:
            if prev is None:
                prev = _last_snapshot_target() or {}
            prow = prev.get(key)
            before = (sum(v for n, v in _contribs(prow).items() if n not in names)
                      if isinstance(prow, dict) else others)
            share = _toward_zero(stale, held_book - before)
            if rec is not None:
                # the members that joined bring their own previous share, the ones that left take
                # theirs: a residual on the book (a failed exit) never becomes the stale share
                pc = _contribs(prow) if isinstance(prow, dict) else {}
                joined = sum(pc.get(n, 0.0) for n in names if n not in rec['names'])
                left = sum(pc.get(n, 0.0) for n in rec['names'] if n not in names)
                share = _toward_zero(share, float(rec['share']) + joined - left)
            guard.audit('stale_share_held', symbol=key, strategies=names, wants=round(stale, 4),
                        held=round(share, 4), first=True)
        else:
            share = _toward_zero(_toward_zero(float(rec['share']), stale), held_book)
            if abs(share - rec['share']) > 1e-9:
                guard.audit('stale_share_held', symbol=key, strategies=names,
                            wants=round(stale, 4), held=round(share, 4))
        if rec is None or rec['names'] != names or abs(share - rec['share']) > 1e-9:
            logging.warning(f"[reconcile] {key}: {', '.join(names)} not refreshed — its share held "
                            f"at {share:g} (wants {stale:g}); the others trade")
            anchors[key] = {'names': names, 'share': share}
            changed = True
        signed = others + share
        if native_units(row.get('asset_spec'), row.get('exchange'), actual=book.get(key)):
            signed = math.copysign(math.floor(abs(signed) + 0.5 + 1e-9), signed) if signed else 0.0
        if market == 'spot' and signed < 0:
            signed = 0.0
        out[key] = dict(_signed_target_row(row, signed), stale_held=round(share, 4))
    for key in [k for k in anchors if k not in stale_keys]:
        del anchors[key]
        changed = True
    if changed:
        _stale_share_save(anchors)
    return out


def _first_signal_keys(name):
    """Book keys a not-yet-computed member will trade: its SYMBOL (_strategy_key), else a
    portfolio's literal UNIVERSE, else its last backtest preview's assets. [] = cannot tell."""
    k = _strategy_key(name)
    if k:
        return [k]
    config = load_portfolio_config()
    exchange, market = (config.get('exchanges') or {}).get(name), strategy_market(name)
    key = lambda s: market_key(s, _paper_tw_market(exchange, s, market))
    syms = []
    try:
        m = _UNIVERSE_RE.search(_strip_py_comments(_strategy_source(name)))
        syms = [x[1:-1] for x in re.findall(r'["\'][^"\']{1,32}["\']', m.group(1))] if m else []
    except (OSError, ValueError):
        pass
    if not syms:
        pv = _read_json_state(f'strategies/{name}/backtest_state.json') or {}
        if isinstance(pv.get('weights'), dict):
            syms = list(pv['weights'])
        elif isinstance(pv.get('symbol'), str) and pv['symbol']:
            return [key(execution_symbol(name, pv['symbol'].replace('-', '').upper(), config))]
    return sorted({key(str(s).replace('-', '').upper()) for s in syms if s})


def _finite(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _first_signal_book():
    """{'members': {name: {since[, expired]}}, 'anchors': {key: {frozen, seen, departed, cohort}}}."""
    if _first_signal_unsaved is not None:
        return json.loads(json.dumps(_first_signal_unsaved))
    try:
        book = load_json(_FIRST_SIGNAL_WAIT_PATH)
    except (OSError, ValueError):
        book = {}
    book = book if isinstance(book, dict) else {}
    return {part: book[part] if isinstance(book.get(part), dict) else {}
            for part in ('members', 'anchors')}


def _first_signal_save(book):
    global _first_signal_unsaved
    try:
        os.makedirs(os.path.dirname(_FIRST_SIGNAL_WAIT_PATH), exist_ok=True)
        tmp = _FIRST_SIGNAL_WAIT_PATH + '.tmp'
        with open(tmp, 'w') as f:
            json.dump(book, f, indent=2)
        atomic_replace(tmp, _FIRST_SIGNAL_WAIT_PATH)
        _first_signal_unsaved = None
    except OSError as e:
        _first_signal_unsaved = book
        logging.warning(f'first_signal_wait persist failed (kept in memory): {e}')


def _first_signal_holds(amounts, exchanges, now=None):
    """{name: (keys, until)} for the members waiting this round. A member's window starts at the
    first round that saw it funded and routed without a state (a re-save does not restart it);
    it leaves the record once it has a state.json or is no longer funded and routed. A start
    that is not a finite time at or before now (a corrupt file, a clock set back) counts from
    now — still one window at most."""
    now = time.time() if now is None else now
    book = _first_signal_book()
    members = book['members']
    want = [n for n, a in amounts.items()
            if a and (exchanges or {}).get(n) and not os.path.exists(f'strategies/{n}/state.json')]
    out, changed = {}, False
    for name in [n for n in members if n not in want]:
        del members[name]
        changed = True
    for name in want:
        rec = members.get(name)
        if not (isinstance(rec, dict) and _finite(rec.get('since'))
                and rec['since'] <= now + _FIRST_SIGNAL_CLOCK_SKEW_S):
            if isinstance(rec, dict):
                logging.warning(f"[portfolio] {name}: first-signal wait start {rec.get('since')!r} "
                                f"is unusable — counted from now")
            keys = _first_signal_keys(name)
            rec = members[name] = {'since': now}
            changed = True
            if keys:
                guard.audit('first_signal_wait', strategy=name, keys=keys,
                            until=round(now + _first_signal_window_s(name)))
            else:
                rec['expired'] = True
                guard.audit('first_signal_wait_no_keys', strategy=name)
                logging.warning(f"[portfolio] {name}: no state.json yet and no SYMBOL / UNIVERSE / "
                                f"preview to tell its keys — nothing held for it")
        if rec.get('expired'):
            continue
        until = rec['since'] + _first_signal_window_s(name)
        keys = _first_signal_keys(name)
        if now >= until or not keys:
            rec['expired'] = True
            changed = True
            guard.audit('first_signal_wait_expired', strategy=name, keys=keys,
                        waited_s=round(now - rec['since']))
            logging.warning(f"[portfolio] {name}: still no state.json after "
                            f"{round(now - rec['since'])}s — {keys} reconciled without it")
            continue
        out[name] = (keys, until)
    held = {k for keys, _ in out.values() for k in keys}
    for key in [k for k in book['anchors'] if k not in held]:
        del book['anchors'][key]
        changed = True
    if changed:
        _first_signal_save(book)
    return out


def _first_signal_anchor_ok(a):
    return (isinstance(a, dict) and _finite(a.get('frozen'))
            and all(isinstance(a.get(p), dict) and all(_finite(v) for v in a[p].values())
                    for p in ('seen', 'departed'))
            and isinstance(a.get('cohort', []), list) and isinstance(a.get('venues', []), list)
            and all(isinstance(x, str) for x in a.get('venues', [])))


def _last_snapshot_target():
    """The previous round's snapshot target (reconcile writes this round's after the diff)."""
    try:
        tg = load_json('manager/last_reconcile.json').get('target')
    except (OSError, ValueError, AttributeError):
        return None
    return tg if isinstance(tg, dict) else None


def _contribs(row):
    out = {}
    for c in (row or {}).get('contributors') or []:
        if isinstance(c, dict) and c.get('strategy') is not None:
            v = c.get('contribution')
            out[str(c['strategy'])] = float(v) if _finite(v) else 0.0
    return out


def _book_signed(row):
    try:
        v = _signed_row(row if isinstance(row, dict) else None)
    except (TypeError, ValueError):
        return 0.0
    return v if math.isfinite(v) else 0.0


def _within(v, room):
    """The part of v the book can still be holding: same sign as room and no larger, else 0."""
    if v * room <= 0:
        return 0.0
    return v if abs(v) <= abs(room) else room


def _settled(row, s):
    if row.get('market') == 'spot' and s < 0:
        s = 0.0
    if native_units(row.get('asset_spec'), row.get('exchange')):
        s = math.copysign(math.floor(abs(s) + 0.5 + 1e-9), s) if s else 0.0
    return s


def _first_signal_targets(target, trusted, funded, skip=(), book=None, account=False, exchanges=None):
    """reconcile's half of the first-signal wait (see the comment above FIRST_SIGNAL_WAIT_MAX_S).
    Every key a waiting member trades is anchored on its first trusted round, even one another
    gate holds that round — the snapshot it anchors on is the save round's only then. Only a key
    aggregate_portfolio flagged first_signal_hold (held for a first signal and by nothing else)
    gets its window target. `book` is what this round diffs against. While the book cannot be
    trusted (a baseline wait) or the key waits on a pending baseline, nothing is anchored: the
    baseline decides from this round's target what is the bot's. `account` = the book is the
    account read (not self_ledger); `exchanges` = the config's routing."""
    rows = [k for k, v in target.items() if v.get('awaiting')]
    if not rows:
        return target
    target, flagged, book = dict(target), set(), book or {}
    for k in rows:
        if target[k].get('first_signal_hold'):
            flagged.add(k)
            target[k] = {f: v for f, v in target[k].items() if f != 'first_signal_hold'}
    funded = set(funded)
    data = _first_signal_book()
    anchors, changed, last = data['anchors'], False, None
    for k in rows:
        row = target[k]
        if not trusted or k in skip:
            continue
        cur = _contribs(row)
        waiting = set(row.get('awaiting') or {})
        a = anchors.get(k)
        if not _first_signal_anchor_ok(a):
            if a is not None:
                logging.warning(f"[portfolio] {k}: first-signal anchor {a!r} is unusable — re-anchored")
            if last is None:
                last = _last_snapshot_target() or {}
            prev = last.get(k) if isinstance(last.get(k), dict) else {}
            fresh = set(prev.get('awaiting') if isinstance(prev.get('awaiting'), dict) else ())
            fresh |= {str(n) for n in prev.get('cohort') or [] if isinstance(prev.get('cohort'), list)}
            nb = {n: v for n, v in _contribs(prev).items() if n not in fresh}
            gated = {str(c.get('strategy')) for c in prev.get('contributors') or []
                     if isinstance(c, dict) and c.get('gated')}
            removed = [n for n in nb if n not in cur and n not in funded and n not in waiting]
            back = sorted(n for n in nb if n in waiting)
            room = _book_signed(book.get(k)) - sum(v for n, v in nb.items()
                                                   if n not in removed and n not in back)
            # the key was already in a window whose anchor is lost
            prior = prev['frozen'] if prev.get('awaiting') and _finite(prev.get('frozen')) else 0.0
            frozen = _within(prior + sum(nb[n] for n in removed if n not in gated), room)
            room -= frozen
            departed = {}
            for n in [n for n in back if n not in gated]:
                departed[n] = _within(nb[n], room)
                room -= departed[n]
            for n in sorted(n for n in removed + back if n in gated):
                if n in back:
                    departed[n] = room
                else:
                    frozen += room
                room = 0.0
            cohort = sorted((waiting - set(nb)) | {n for n in cur if n in fresh})
            seen = {n: v for n, v in cur.items() if n not in cohort}
            venues = sorted({str(x) for x in (prev.get('exchange'), (book.get(k) or {}).get('exchange'))
                             if x})
            a = anchors[k] = {'frozen': frozen, 'seen': seen, 'departed': departed, 'cohort': cohort,
                              'venues': venues}
            changed = True
        else:
            if account:
                room = _book_signed(book.get(k)) - sum(a['seen'].values())
                frozen = _within(a['frozen'], room)
                room -= frozen
                departed = {}
                for n, c in sorted(a['departed'].items()):
                    departed[n] = _within(c, room)
                    room -= departed[n]
                if frozen != a['frozen'] or departed != a['departed']:
                    a = anchors[k] = dict(a, frozen=frozen, departed=departed)
                    changed = True
            # a neighbour waiting again is a departure, not a newcomer: its next signal trades
            cohort = sorted(set(a.get('cohort') or []) | (waiting - set(a['seen']) - set(a['departed'])))
            seen = {n: v for n, v in cur.items() if n not in cohort}
            departed = dict(a['departed'])
            room = (_book_signed(book.get(k)) - sum(a['seen'].values()) - a['frozen']
                    - sum(departed.values()))
            for n, c in sorted(a['seen'].items()):
                if n not in seen and (n not in funded or n in waiting):
                    room += c
                    departed[n] = _within(c, room)
                    room -= departed[n]
            departed = {n: c for n, c in departed.items() if n not in seen}
            if departed != a['departed'] or seen != a['seen'] or cohort != a.get('cohort'):
                a = anchors[k] = dict(a, seen=seen, departed=departed, cohort=cohort)
                changed = True
        here = (book.get(k) or {}).get('exchange')
        venues = set(a.get('venues') or []) | ({str(here)} if here else set())
        routes = {str((exchanges or {}).get(n)) for n in waiting if (exchanges or {}).get(n)}
        if venues and routes and venues != routes:
            row = {f: v for f, v in target[k].items() if f not in ('awaiting', 'cohort', 'frozen')}
            if k in flagged and not row.get('contributors'):
                del target[k]
            else:
                target[k] = dict(row, gated=False) if k in flagged else row
            continue
        hold = a['frozen'] + sum(a['departed'].values())
        if k in flagged:
            others = _settled(row, sum(a['seen'].values()))
            held = _book_signed(book.get(k))
            s = _settled(row, sum(a['seen'].values()) + hold)
            s = min(max(s, min(others, held)), max(others, held))
            full = _signed_row(row)
            s = min(max(s, min(full, held)), max(full, held))
            target[k] = dict(_signed_target_row(row, s), gated=False)
            if not row.get('contributors') and abs(hold) < 1e-9:
                # nothing held and nobody else on it: the round without the wait has no row
                # here, so its close-on-removal decides, not a target of 0 (reconcile drops it
                # from the diff; the snapshot keeps it for the page)
                target[k]['diff_absent'] = True
        target[k] = dict(target[k], frozen=round(hold, 8))
        done = [n for n in a['cohort'] if n in cur]
        if done:
            target[k]['cohort'] = done
    if changed:
        _first_signal_save(data)
    return target


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

    def _add(key, market, exchange, asset_spec, contribution, contributor, gated):
        if key not in totals:
            totals[key] = {'signed': 0.0, 'exchange': exchange,
                           'asset_spec': asset_spec, 'market': market,
                           'contributors': [], 'gated': False}
        totals[key]['signed'] += contribution
        totals[key]['gated'] = totals[key]['gated'] or gated
        totals[key]['contributors'].append(contributor)

    for name, state in states.items():
        if isinstance(state.get('weights'), dict):
            # Type C (lib/runner.typec_live_state): {SYMBOL: weight} held from the
            # rebalance bar `rebalance_at` on. Each asset nets with every other
            # strategy on its key exactly like a single-symbol contribution.
            exchange = exchanges.get(name)
            amount = float(amounts.get(name, 0))
            asset_spec = asset_specs.get(name)
            if not exchange or amount == 0:
                continue
            if asset_type(asset_spec) in NATIVE_UNIT_TYPES:
                # amount × weight is account currency; a lots/shares row would take it as a count
                logging.warning(f"[portfolio] {name}: a portfolio (Type C) sized in "
                                f"{asset_type(asset_spec)} is not traded — skipped")
                continue
            gated = False
            if name in gate:
                # the portfolio's "new signal" is its next rebalance
                if float(state.get('rebalance_at') or 0) != gate[name]:
                    logging.info(f"[portfolio] signal gate lifted for {name} (rebalanced) "
                                 f"— trading normally")
                    lifted.add(name)
                else:
                    gated = True
            market = strategy_market(name)
            for sym, w in state['weights'].items():
                try:
                    w = float(w)
                except (TypeError, ValueError):
                    continue
                if w != w:  # NaN
                    w = 0.0
                m = _paper_tw_market(exchange, sym, market)
                if w < 0 and (m == 'spot' or (exchange == 'paper' and _tw_stock(sym))):
                    # this strategy's own short intent must not cancel another
                    # strategy's long on the same coin — spot cannot short, nor
                    # can a TW stock on paper (Wei 10-17: a short is a close)
                    w = 0.0
                key = market_key(str(sym).replace('-', '').upper(), m)
                _add(key, m, exchange, asset_spec, amount * w,
                     {'strategy': name, 'position': w, 'amount': amount,
                      'contribution': round(amount * w, 4), 'portfolio': True,
                      **({'gated': True} if gated else {})}, gated)
            continue

        symbol     = state.get('symbol')
        # canonical symbol key: dashless uppercase (BTCUSDT) — strategies write
        # Binance-style, OKX reports dashed; without one canon the reconciler
        # sees "BTCUSDT target" and "BTC-USDT actual" as two symbols and churns
        symbol     = symbol.replace('-', '').upper() if symbol else symbol
        symbol     = execution_symbol(name, symbol, config) if symbol else symbol
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
        if not math.isfinite(position):
            # A Type B state.json can carry NaN / Infinity (json round-trips
            # them). Held like a gated symbol: no order either way on this key,
            # the rest of the round trades — read as 0 it would silently close
            # the position, left in it would raise for the whole machine.
            logging.warning(f"[portfolio] {name}: position {position} is not a number — "
                            f"{symbol} held as is, no orders until the strategy writes a valid one")
            position, gated = 0.0, True
        elif name in gate:
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
        if contribution < 0 and exchange == 'paper' and _tw_stock(symbol):
            # Wei 10-17: paper never shorts a TW stock — a short signal is flat,
            # and does not cancel another strategy's long on the same stock
            contribution = 0.0

        # spot and swap are different inventories — same symbol, different key,
        # so a spot strategy and a perp strategy on BTCUSDT never net against
        # each other (they'd converge the WRONG account's position)
        market = _paper_tw_market(exchange, symbol, strategy_market(name))
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
            # only when set: a gated key places no order, so orders.jsonl rows never carry it
            **({'gated': True} if gated else {}),
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
        if native_units(data['asset_spec'], data['exchange']):
            # Whole lots, summed first (Wei 2026-10-13): lot rows have no diff
            # gate and the order fns round the DIFF half-up, so a 0.5 target
            # bought 1, read -0.5 and sold it back every round. Half-up away
            # from zero like those fns (never round(): a .5 tie goes to even);
            # 1e-9 keeps a float-summed 0.49999… tie on the same side.
            s = math.copysign(math.floor(abs(s) + 0.5 + 1e-9), s) if s else 0.0
        result[key] = {
            'side':         'long' if s > 0 else ('short' if s < 0 else None),
            'size':    abs(s),
            'exchange':     data['exchange'],
            'asset_spec':   data['asset_spec'],
            'market':       data['market'],
            'contributors': data['contributors'],
            'gated':        data['gated'],
        }
    stale = {}
    for name in {c['strategy'] for row in result.values() for c in row['contributors']}:
        try:
            age = _stale_target_age(name)
        except Exception as e:  # never a reason to skip this round's exits
            logging.error(f"[portfolio] {name}: stale-target check failed ({e}) — not held")
            age = None
        if age is not None:
            stale[name] = age
    for key, row in result.items():
        names = sorted(c['strategy'] for c in row['contributors'] if c['strategy'] in stale)
        if names:
            row['stale_target'] = names
    for name in set(stale) - _stale_targets_logged:
        keys = sorted(k for k, row in result.items() if name in row.get('stale_target', ()))
        logging.warning(f"[portfolio] {name}: target not refreshed for {round(stale[name])}s while "
                        f"its scheduled run keeps failing — its share of {keys} can only shrink")
        guard.audit('target_stale', strategy=name, keys=keys, age_s=round(stale[name]))
        try:
            from lib.events import emit_target_stale
            emit_target_stale(name, keys, stale[name])
        except Exception as e:  # a half-updated workspace's lib/events has no helper yet
            logging.warning(f"[portfolio] target_stale event not written ({e})")
    traded = {c['strategy'] for row in result.values() for c in row['contributors']}
    for name in _stale_targets_logged - set(stale):
        why = 'refreshed' if name in traded else 'no longer traded'
        logging.info(f"[portfolio] {name}: target {why} — its share is no longer held")
        guard.audit('target_fresh', strategy=name, why=why)
    _stale_targets_logged.clear()
    _stale_targets_logged.update(stale)
    # A member with no venue (still a key of `amounts`, its routing blank — an unbind keeps the
    # portfolio, Wei 10-14) is "no exchange for now", not "removed": the keys it trades are held
    # as they are on the account (flagged gated + unrouted, so reconcile leaves both sides alone
    # and the snapshot shows why) — no close-on-removal, no entry. A name not in `amounts` is
    # removed and closes as ever.
    held_unrouted = {}
    book = None
    if any(not (exchanges or {}).get(n) for n in amounts) and own_positions_only(config):
        try:
            book = set(ledger_book())
        except Exception:
            book = None
    for name, key in _unrouted_member_keys(amounts, exchanges, states, config, book):
        row = result.get(key)
        if row is None:
            row = result[key] = {'side': None, 'size': 0.0, 'exchange': '', 'asset_spec': asset_specs.get(name),
                                 'market': split_key(key)[1], 'contributors': [], 'gated': True}
        row['gated'] = True
        row['unrouted'] = sorted(set(row.get('unrouted') or []) | {name})
        held_unrouted.setdefault(name, []).append(key)
    for name, keys in held_unrouted.items():
        # both twins held: the line names the one the book actually has
        named = [k for k in keys if k in (book or ())] or keys
        logging.info(f"[portfolio] {name}: no exchange routed — {', '.join(named)} held as is (save 下單設定 to route)")
    # only an optimisation against a close-and-buy-back: no bug in it may stop this round's exits
    try:
        holds = _first_signal_holds(amounts, exchanges)
    except Exception as e:
        holds = {}
        err = f'{type(e).__name__}: {e}'[:200]
        logging.error(f"[portfolio] first-signal wait failed ({err}) — nothing held for it this round")
        if err not in _first_signal_errors:
            _first_signal_errors.add(err)
            guard.audit('first_signal_wait_error', error=err)
    for name, (keys, until) in holds.items():
        for key in keys:
            row = result.get(key)
            if row is None:
                row = result[key] = {'side': None, 'size': 0.0, 'exchange': exchanges.get(name),
                                     'asset_spec': asset_specs.get(name), 'market': split_key(key)[1],
                                     'contributors': [], 'gated': False}
            if not row['gated'] or row.get('first_signal_hold'):
                # reconcile turns it into the window target (_first_signal_targets); any other
                # gate on the key keeps it held as is
                row['gated'] = row['first_signal_hold'] = True
            row['awaiting'] = dict(row.get('awaiting') or {}, **{name: round(until)})
        logging.info(f"[portfolio] {name}: no first signal yet — what it replaces on {keys} is "
                     f"held (at most {round(until - time.time())}s more)")
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


# ── asset_spec.type: the unit a symbol is reconciled in ─────────────────────
# references/manager.md § asset_spec. `notional` (the default when the key is
# absent — every pre-existing crypto config) diffs target and actual in account
# currency, so the mark moves `actual` and a held position reads as a gap; the
# drift band below exists for that path alone. `futures_contracts` (lots) and
# `shares` (share count) diff in the market's native unit: no currency gate,
# no band, exactly what a quantity book already gives self_ledger.
ASSET_TYPE_NOTIONAL = 'notional'
NATIVE_UNIT_TYPES = frozenset({'futures_contracts', 'shares'})


def asset_type(asset_spec):
    return (asset_spec or {}).get('type') or ASSET_TYPE_NOTIONAL


def native_units(asset_spec, *exchanges, actual=None):
    """True for a row diffed in lots / shares rather than account currency. A
    close-on-removal row has no asset_spec (the strategy left `target`), so
    the capital exchange label — or the account row's own unit ("contracts",
    which the paper venue reports) — stands in for it there."""
    return (asset_type(asset_spec) in NATIVE_UNIT_TYPES
            or any(venue_traits.has(e, 'native_units') for e in exchanges)
            or (actual or {}).get('unit') == 'contracts')


# ── drift band (account-read mode only) ────────────────────────────────────
# Without self_ledger, target is a fixed notional and actual is size × mark,
# so their difference is the unrealised P&L, not a position gap — measured
# 2026-09-21 on uid 29026: a 20,000 paper position with an unchanged signal
# produced 34 fills in 4h44m (0 with the book on). The band leaves a SAME-SIDE
# adjustment alone while |diff| is under max(5%, 2 × 30-day daily σ) of the
# target. It never touches a whole-position close or a flip's close leg
# (target flat / opposite side): "the signal said flat and no order went out"
# is the P0 _close_threshold exists to prevent. Known cost, deliberate: a
# same-side SIGNAL change smaller than the band (a vol-scaled 1.0 → 1.03) is
# indistinguishable from drift here and is also left alone — the quantity
# book has no such ambiguity, which is why new machines ship with it on.
_DRIFT_BAND_FLOOR = 0.05
_DRIFT_BAND_CAP = 0.20  # a σ-scaled band never lets a position sit further off target than this
_DRIFT_SIGMA_MULT = 2.0
_DRIFT_SIGMA_DAYS = 30
_DRIFT_SIGMA_RETRIES = 2  # kline attempts per lookup — see _daily_sigma
_DRIFT_BAND_PATH = 'state/drift_band.json'  # {symbol: {'sigma': float|None, 'at': epoch}}
_DRIFT_BAND_TTL_S = 24 * 3600  # one kline fetch per symbol per day, never per round


def _daily_sigma(symbol):
    """Std-dev of the last _DRIFT_SIGMA_DAYS daily close-to-close returns from
    lib/data.fetch_kline (Blave /kline, Binance USDT-M perps — the one kline
    path every lib already uses). None when it cannot be had: no Blave key in
    .env (nothing to call with, and no network round-trip from a bare
    workspace), a symbol the feed does not carry, too few bars."""
    from dotenv import dotenv_values
    from lib import data
    env = dotenv_values()
    hdrs = {'api-key': env.get('blave_api_key', ''),
            'secret-key': env.get('blave_secret_key', '')}
    if not hdrs['api-key'] and data._kline_source() != 'binance':
        return None
    start = (datetime.utcnow() - timedelta(days=_DRIFT_SIGMA_DAYS + 15)).strftime('%Y-%m-%d')
    # This runs inside a reconcile round: the default 6 retries back off for
    # ~2 min on a 429/5xx, past the 300s heartbeat the web reads as "dead".
    # Two attempts, then the floor for a day (_drift_sigma caches the miss).
    df = data.fetch_kline(symbol, '1d', start, None, hdrs, max_retries=_DRIFT_SIGMA_RETRIES)
    # the last bar is today's, still forming: a half-day move is not a daily return
    rets = df['Close'].iloc[:-1].pct_change().dropna().tail(_DRIFT_SIGMA_DAYS)
    if len(rets) < _DRIFT_SIGMA_DAYS // 2:
        return None
    return float(rets.std())


def _drift_sigma(symbol):
    """Cached _daily_sigma: one lookup per symbol per _DRIFT_BAND_TTL_S,
    failures cached too (a feed that has no bars today has none in 300s)."""
    try:
        cache = load_json(_DRIFT_BAND_PATH) or {}
    except (OSError, ValueError):
        cache = {}
    now = time.time()
    row = cache.get(symbol) if isinstance(cache, dict) else None
    try:
        if row and now - float(row['at']) < _DRIFT_BAND_TTL_S:
            return row['sigma']
    except (KeyError, TypeError, ValueError):
        pass
    sigma = None
    try:
        sigma = _daily_sigma(symbol)
    except Exception as e:
        logging.warning(f"[drift band] {symbol}: daily σ unavailable ({e}) — "
                        f"floor {_DRIFT_BAND_FLOOR:.0%} applies")
    if not isinstance(cache, dict):
        cache = {}
    cache[symbol] = {'sigma': sigma, 'at': now}
    try:
        os.makedirs(os.path.dirname(_DRIFT_BAND_PATH), exist_ok=True)
        tmp = _DRIFT_BAND_PATH + '.tmp'
        with open(tmp, 'w') as f:
            json.dump(cache, f, indent=2)
        atomic_replace(tmp, _DRIFT_BAND_PATH)
    except OSError as e:
        logging.warning(f'drift_band cache persist failed: {e}')
    return sigma


def drift_band(symbol):
    """Relative tolerance for one symbol's same-side notional adjustment:
    max(_DRIFT_BAND_FLOOR, min(_DRIFT_SIGMA_MULT × 30-day daily σ, _DRIFT_BAND_CAP)),
    the floor alone when σ cannot be had. `symbol` may carry a market suffix."""
    sigma = _drift_sigma(split_key(symbol)[0])
    if not sigma or sigma <= 0:
        return _DRIFT_BAND_FLOOR
    return max(_DRIFT_BAND_FLOOR, min(_DRIFT_SIGMA_MULT * float(sigma), _DRIFT_BAND_CAP))


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
    left alone exactly as before — except that the reconciler's `.close` lowers
    it by half a lot on a coarse instrument, where a position the bot opened
    can itself cost less than the floor (manager/reconciler._symbol_threshold).
    A callable without
    `.flat` (hand-written) keeps answering for itself."""
    if not callable(threshold):
        return threshold
    close = getattr(threshold, 'close', None)
    if callable(close):
        return close(symbol)
    flat = getattr(threshold, 'flat', None)
    return threshold(symbol, True) if flat is None else flat


def compute_diff(target, actual, threshold=RECONCILE_THRESHOLD, gates=None, drift_band=None):
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
    for a symbol whose 'size' is a native-unit count (asset_specs[strategy]["type"]
    == "futures_contracts" — lots, e.g. capital/TW futures — or "shares"; see
    native_units / strategy_amounts): diffs there are single/low-double-digit
    lots, so a currency threshold of 10 would silently swallow every order,
    including a close-on-removal (target absent, asset_spec None — checked via
    `exchange` too). Those rows skip `threshold` entirely; their own
    place_order_fn applies the real minimum (e.g. reconciler.py's
    _capital_place_order round-half-up gate).

    `drift_band` is an optional callable(symbol) -> fraction (module-level
    drift_band; reconcile passes it in account-read mode only). A same-side
    notional row is then also gated at that fraction of |target|: the mark
    moving `actual` is not a position gap. Never applied to a row whose target
    is flat or on the other side (a whole-position close), nor to a
    native-unit row. None = today's gates alone (hand-written callers).

    `gates` is an optional OUT dict (return value unchanged — hand-written
    callers exist): a row with either side above the flat threshold is recorded
    as {symbol: {'usd': gate this round, 'diff': signed_diff,
    'entry_usd': .., 'reduce_usd': .., 'close_usd': ..[, 'side': 'reduce'][, 'band_usd': ..]}},
    placed or not, so
    the workspace can show the number instead of leaving "diff 22, no order, no
    error" unexplained. `usd`/`diff`/`side` are the shipped shape and do not
    move; BOTH sides are carried because the live diff a reader colours can
    have flipped sign since this round — with one side only it would colour a
    buy against the reduce gate. `band_usd` (the drift band valued at the
    target) is present only on a row it applied to; `usd` already includes it.
    Flat-gate rows are left out on both sides — there is nothing to explain there.
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
        asset_spec = t.get('asset_spec') or a.get('asset_spec')
        is_lot_based = native_units(asset_spec, t.get('exchange'), a.get('exchange'), actual=a)
        # A row whose |target| is SMALLER than what is held carries a reduce
        # leg (shrink, or a close when the target is gone) — gated on its own
        # side (the reconciler's callable answers half a lot there, never a
        # whole one: that is how a position of exactly one lot becomes
        # impossible to close). A flip is over both legs' gates by
        # construction (|actual| + |target|); its legs are gated per side
        # below.
        reduces = abs(t_signed) < abs(a_signed)
        band_usd = 0.0
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
            # Same side, both held: the drift band (see its section) is a
            # second floor under this adjustment. The `<= 0` branch above —
            # every whole-position close — is disjoint from it by construction.
            if drift_band is not None and a_signed != 0 and t_signed * a_signed > 0:
                band_usd = float(drift_band(symbol)) * abs(t_signed)
                applied = max(applied, band_usd)
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
                if entry_gate > flat or reduce_gate > flat or band_usd > flat:
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
                    if band_usd:
                        gates[symbol]['band_usd'] = band_usd
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
            'asset_spec':       t.get('asset_spec') or a.get('asset_spec'),
            'contributors':     t.get('contributors', []),
        })

    return orders


def _signed_row(row):
    row = row or {}
    size = float(row.get('size') or 0)
    return size if row.get('side') == 'long' else -size if row.get('side') == 'short' else 0.0


def _rollover_reduces(target, book):
    """TXF-family keys still holding something to close: more than the target,
    or any of it on the other side of the target (a flip's close leg)."""
    out = set()
    for k in set(target) | set(book):
        if not is_txf_family_key(k):
            continue
        b, t = _signed_row(book.get(k)), _signed_row(target.get(k))
        if abs(b) > 1e-9 and (b * t <= 0 or abs(b) > abs(t) + 1e-9):
            out.add(k)
    return out


_ROLLOVER_PATH = 'state/contract_rollover.json'
# One writer per file, so neither can lose the other's update: the runtime alone
# writes the records (at the save), this lib alone writes which of them it saw
# finished ({strategy: the record's `id`}); a record whose `id` matches is done.
_ROLLOVER_DONE_PATH = 'state/contract_rollover_done.json'


def _read_json_state(path):
    """dict, {} when absent, None when there but unreadable."""
    try:
        raw = load_json(path)
    except FileNotFoundError:
        return {}
    except (OSError, ValueError):
        return None
    return raw if isinstance(raw, dict) else None


def _rollover_token(rec):
    """What a done-mark matches: the runtime's per-write `id` (`at` for a record without one)."""
    return rec.get('id', rec.get('at'))


def _load_rollovers():
    """Open rollovers {strategy: {'from', 'to', 'at'}} (`to` None = unpicked:
    nothing to open, the old contract still closing); None = a file is there but
    unreadable (every family entry then waits)."""
    raw = _read_json_state(_ROLLOVER_PATH)
    done = _read_json_state(_ROLLOVER_DONE_PATH)
    if raw is None or done is None:
        return None
    out = {}
    for n, r in raw.items():
        if not isinstance(r, dict) or r.get('from') not in TXF_FAMILY:
            continue
        if r.get('to') is not None and (r['to'] not in TXF_FAMILY or r['to'] == r['from']):
            continue
        if done.get(n) is not None and done.get(n) == _rollover_token(r):
            continue
        out[str(n)] = r
    return out


def _mark_rollovers_done(finished):
    """Record {strategy: at} as finished; entries for records the runtime has
    since rewritten or dropped are pruned here (this file has no other writer)."""
    raw = _read_json_state(_ROLLOVER_PATH) or {}
    done = _read_json_state(_ROLLOVER_DONE_PATH) or {}
    keep = {n: a for n, a in done.items() if isinstance(raw.get(n), dict) and _rollover_token(raw[n]) == a}
    keep.update(finished)
    try:
        from lib.president_vault import replace_json  # O_EXCL temp named like runtime/atomic_file
        replace_json(_ROLLOVER_DONE_PATH, keep)
    except (OSError, ImportError) as e:
        logging.warning(f"[reconcile] contract rollover done-mark not written ({e}) — next round retries")
        return
    for n in finished:
        guard.audit('contract_rollover_done', strategy=n)


def _rollover_strategy_moved(name, rec, config):
    """This round's config already trades `name` where the record says (or, with
    `to` None, no longer has it as a member). A round that read the config
    before the save still targets the old contract — its book matching that
    target says nothing about the switch, so it must not finish the record."""
    amounts = (config or {}).get('amounts')
    member = isinstance(amounts, dict) and name in amounts
    if rec.get('to') is None:
        return not member
    if not member:
        return False
    sym = None
    for fname in ('state.json', 'stats.json'):
        try:
            sym = (load_json(f'strategies/{name}/{fname}') or {}).get('symbol')
        except (OSError, ValueError, AttributeError):
            continue
        if sym:
            break
    return txf_root(execution_symbol(name, str(sym or '').upper(), config)) == rec['to']


def _rollovers_this_round(target, book, trusted, config, waiting_keys=()):
    """(snapshot rows, {new root: [old roots]}) for rollovers still open. Done =
    this round's config already moved the strategy (_rollover_strategy_moved),
    and the old contract has nothing left to close (_rollover_reduces: book
    above target or on the other side of it) and is not waiting on a baseline
    decision (`waiting_keys`: the seed's pending symbols — their lots are not in
    the book yet). `trusted` = the book is a real read (no baseline wait)."""
    recs = _load_rollovers()
    open_roots = {txf_root(split_key(k)[0]) for k in _rollover_reduces(target, book)}
    open_roots |= {txf_root(split_key(k)[0]) for k in waiting_keys} - {None}
    if recs is None:
        logging.warning(f"[reconcile] {_ROLLOVER_PATH} unreadable — every TXF-family entry waits "
                        f"while any family contract has something to close")
        return [], {r: sorted(open_roots - {r}) for r in TXF_FAMILY if open_roots - {r}}
    rows, hold, finished = [], {}, {}
    for name, r in sorted(recs.items()):
        if (trusted and r['from'] not in open_roots
                and _rollover_strategy_moved(name, r, config)):
            finished[name] = _rollover_token(r)
            continue
        rows.append({'strategy': name, 'from': r['from'], 'to': r.get('to'), 'since': r.get('at')})
        if r.get('to'):
            hold.setdefault(r['to'], []).append(r['from'])
    if finished:
        _mark_rollovers_done(finished)
    return rows, {k: sorted(set(v)) for k, v in hold.items()}


def _halt_rollover_targets(rolls, target, book):
    """{key: signed lots} for HALT: every open rollover's strategy is counted on
    its OLD contract, not the new one — amount × position in the new contract's
    lots, valued over to the old one (cv_to / cv_from). Per strategy, a non-zero
    share is at least 1 lot on the old contract (same sign): 1 TXF switched to
    9 TMF is 0.45 TXF, which would round away and close the lot with nothing
    bought. Then each touched key is its contributions summed, whole lots
    half-up. An old contract's target is kept between its normal target and its
    book: the hold only stops a close, it never reaches past what is held.
    Held there, the old contract keeps the rolling strategy's lots while halted
    and the new contract reads what the others on it want. A halted round sends
    nothing (HALT is a full freeze), so this only keeps the snapshot honest: it
    lists the orders 啟動下單 would send, close first."""
    sums, olds, news = {}, set(), set()
    for row in rolls:
        frm, to, name = row.get('from'), row.get('to'), row.get('strategy')
        if not to:
            continue
        for k in target:
            if split_key(k)[1] == 'spot' or txf_root(split_key(k)[0]) != to:
                continue
            for c in target[k].get('contributors') or []:
                if c.get('strategy') != name:
                    continue
                share = float(c.get('contribution') or 0)
                if not share:
                    continue
                on_old = share * TXF_FAMILY_CONTRACT_VALUE[to] / TXF_FAMILY_CONTRACT_VALUE[frm]
                if abs(on_old) < 1:
                    on_old = math.copysign(1.0, on_old)
                from_key = next((x for x in list(target) + list(book) if split_key(x)[1] != 'spot'
                                 and txf_root(split_key(x)[0]) == frm), frm)
                sums[k] = sums.get(k, 0.0) - share
                sums[from_key] = sums.get(from_key, 0.0) + on_old
                news.add(k)
                olds.add(from_key)

    def whole(t):
        return math.copysign(math.floor(abs(t) + 0.5 + 1e-9), t) if abs(t) > 1e-9 else 0.0

    out = {}
    for k in olds | news:
        base = sum(float(c.get('contribution') or 0)
                   for c in ((target.get(k) or {}).get('contributors') or []))
        t = whole(base + sums.get(k, 0.0))
        if k in olds:
            normal, held = whole(base), _signed_row(book.get(k))
            t = min(max(t, min(normal, held)), max(normal, held))
        out[k] = t
    return out


def _signed_target_row(row, signed):
    row = dict(row)
    row.update(side='long' if signed > 0 else ('short' if signed < 0 else None), size=abs(signed))
    return row


def _order_phase(order, book):
    """0 = shrinks a held position only, 1 = a flip (close leg first), 2 = adds."""
    a = _signed_row(book.get(order['symbol']))
    t = a + order['signed_diff']
    if a and t * a < 0:
        return 1
    return 0 if abs(t) < abs(a) else 2


def reconcile(get_positions_fn, place_order_fn, threshold=RECONCILE_THRESHOLD, send_telegram_fn=None):
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

    Kill switch: while state/HALT exists, every leg is denied here — entries,
    reduces, closes, a flip's close leg — (audited to state/audit.jsonl) before
    place_order_fn is called. The one exception is a close-all leg flatten
    deferred to this reconciler (paper TW stocks after hours) — see lib/guard.py.

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
    # once trading resumes the close leg would quietly flatten a real
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
    needs_baseline = None
    pending_keys = set()
    own_only = own_positions_only(config)
    if own_only and not book_ready(config):
        # Never replay an unseeded book (audit P1-6: the ENTIRE orders.jsonl
        # history is a plausible-looking but wrong book). Write the baseline
        # from the account read; read-only only while it can't be written.
        needs_baseline = _auto_baseline(target, actual, config)
        if _baseline_stuck(needs_baseline):
            # the same non-transient wait for too long: a read-only machine sends
            # no exit either. Adopt what is certain; what could not be read is
            # left to the user, and said so (never guessed as the bot's).
            needs_baseline = _auto_baseline(target, actual, config, fallback=True)
        if needs_baseline is None:
            # the coins this baseline just left waiting stay out of THIS round too —
            # another, readable strategy on the same coin must not trade it now
            pending_keys = _pending_symbols(book_venue())
    elif own_only:
        claim_unvenued_rows()
        try:
            pending_keys = resolve_pending(target, actual, config)
        except Exception as e:
            # can't tell what is still waiting: keep every waited-on symbol out
            logging.warning(f"[ledger] pending baseline read failed ({e})")
            pending_keys = _pending_symbols(None)
    if own_only and needs_baseline is None:
        _report_ledger_adoption()
        settle_expired_months(actual)
        ledger = {_canon_key(k): v for k, v in (ledger_positions() or {}).items()}
        # A spot row without a quantity can never be sold (the wallet is one pool
        # of the bot's and the user's coins) and would read as "already bought"
        # at every entry. Written off once, said once: the coins stay in the
        # wallet as the user's, and the strategy trades from zero again.
        for k in [k for k, row in ledger.items() if k.endswith('@spot') and row.get('legacy')]:
            _record_order_error(k, book_venue(), "spot: the bot's share of this coin had no recorded "
                                "quantity and can't be told from yours — it is left to you; the "
                                "strategy trades from zero")
            apply_ledger_writeoff(k, 'spot row without a quantity')
            del ledger[k]
        # A book row has no unit of its own; the venue read's does (paper
        # reports lots as unit "contracts"). Without it a removed contract
        # strategy's close-on-removal — no target, no asset_spec — is judged
        # by the currency gate and 2 lots < 10 never closes. A hand-wired
        # venue (群益, 統一) reports no unit either: its rows are lots by
        # trait, so the book's venue stands in (native_units reads `exchange`).
        book = book_venue()
        lots_venue = book if venue_traits.has(book, 'native_units') else None
        for k, row in ledger.items():
            unit = (actual.get(k) or {}).get('unit')
            if unit:
                row['unit'] = unit
            if lots_venue:
                row['exchange'] = lots_venue
    # no baseline = no book to diff against; the round is read-only anyway,
    # and the account read must not stand in for the book
    diff_actual = ledger if ledger is not None else ({} if own_only else actual)
    # A close-on-removal row (held, no target) carries the spec its entry was
    # sized with — the strategy's, still in the config — so the order log and
    # the app read the leg in lots, not as money.
    removed = [k for k, a in diff_actual.items() if k not in target and not a.get('asset_spec')]
    if removed:
        specs = removed_asset_specs(config, target)
        for k in removed:
            if k in specs:
                diff_actual[k]['asset_spec'] = specs[k]

    # Contract rollovers in progress (runtime _cmd_amounts records them at the
    # save): judged BEFORE the gate / pending filters below — an old contract
    # held as is (another strategy on it waits, a NaN signal) still holds what it
    # holds, and its rollover's new contract waits with it. Only that one.
    diff_actual_full = diff_actual
    rolls, hold_roots = _rollovers_this_round(
        target, diff_actual, trusted=needs_baseline is None and portfolio_configured(),
        config=config, waiting_keys=pending_keys)
    halt_targets = _halt_rollover_targets(rolls, target, diff_actual)
    try:
        target = _first_signal_targets(target, trusted=needs_baseline is None,
                                       skip=pending_keys, book=diff_actual,
                                       funded={n for n, a in strategy_amounts(config).items() if a},
                                       account=not own_only, exchanges=config.get('exchanges'))
    except Exception as e:
        # never a reason to hold more: the flagged keys reconcile as if nobody waited
        logging.error(f"[reconcile] first-signal window target failed ({type(e).__name__}: {e}) "
                      f"— those keys reconcile without it this round")
        target = {k: (dict({f: x for f, x in v.items() if f != 'first_signal_hold'}, gated=False)
                      if v.get('first_signal_hold') else v) for k, v in target.items()}

    # signal gate (resume_wait): a gated symbol is excluded from BOTH sides of
    # the diff — no catch-up entry (absent target would be wrong: it exists,
    # it's gated), and no close-on-removal against whatever the book already
    # holds. The gate lifts inside aggregate_portfolio() the moment the
    # strategy's signal changes; from that round on the symbol diffs normally.
    # close-all deferred to the TW session (defer_paper_tw_close): judged on the
    # unfiltered book and exempt from the gate / pending holds below — the
    # user's explicit close outranks a wait for a new signal
    deferred = _paper_tw_deferred(diff_actual_full, halted_at_start)
    if deferred:
        logging.info(f"[reconcile] close-all deferred to the TW session: {sorted(deferred)}")
        target = {k: v for k, v in target.items() if k not in deferred}
    gated_symbols = {k for k, v in target.items() if v.get('gated')}
    full_target = target  # snapshot keeps gated rows (flagged 'gated': True)
    absent = [k for k, v in target.items() if v.get('diff_absent')]
    if absent:
        target = {k: v for k, v in target.items() if k not in absent}
        # the spec backfill above ran while these keys were still targets: a close-on-removal
        # leg needs the same spec the round without the wait gives it
        late = [k for k in absent if k in diff_actual and not diff_actual[k].get('asset_spec')]
        if late:
            specs = removed_asset_specs(config, target)
            for k in late:
                if k in specs:
                    diff_actual[k]['asset_spec'] = specs[k]
    if gated_symbols:
        logging.info(f"[reconcile] signal-gated (waiting for a new signal): "
                     f"{sorted(gated_symbols)}")
        target = {k: v for k, v in target.items() if k not in gated_symbols}
        diff_actual = {k: v for k, v in diff_actual.items() if k not in gated_symbols}
    if pending_keys:
        # a symbol whose strategy's state was unreadable when the baseline was
        # written: neither bought nor sold until resolve_pending decides it
        logging.info(f"[reconcile] waiting on an unreadable strategy's state: {sorted(pending_keys)}")
        hold = set(pending_keys) - deferred
        target = {k: v for k, v in target.items() if k not in hold}
        diff_actual = {k: v for k, v in diff_actual.items() if k not in hold}
    closed_keys = _paper_tw_closed_keys(target, diff_actual)
    if closed_keys:
        logging.info(f"[reconcile] TW market closed — paper holds {sorted(closed_keys)} until the session")
    paused = _venue_paused_keys(target, diff_actual)
    if paused:
        hold, close_only = _paused_split(paused, target, diff_actual)
        if hold:
            logging.info(f"[reconcile] venue forbids opening — holds {sorted(hold)} until it reopens")
            closed_keys |= hold
        for k in close_only:
            logging.info(f"[reconcile] venue forbids opening — {k} only closes (no new side)")
            target[k] = {**target[k], 'size': 0.0}
    if closed_keys:
        target = {k: v for k, v in target.items() if k not in closed_keys}
        diff_actual = {k: v for k, v in diff_actual.items() if k not in closed_keys}

    # per-symbol venue gates, for the snapshot (unrelated to gated_symbols
    # above — that is the SIGNAL gate). The drift band only when the diff is
    # against the account read: a book's cost does not move with the mark.
    if halted_at_start:
        # HALT holds a rollover's lots on its old contract (_halt_rollover_targets)
        for k, signed in halt_targets.items():
            if k in gated_symbols or k in pending_keys:
                continue  # held as is anyway
            if (full_target.get(k) or {}).get('awaiting'):
                # a first-signal window target leaves the rolling strategy's lots out: held as is
                target = {x: v for x, v in target.items() if x != k}
                diff_actual = {x: v for x, v in diff_actual.items() if x != k}
                continue
            base = target.get(k) or {'exchange': (diff_actual.get(k) or {}).get('exchange'),
                                     'asset_spec': (diff_actual.get(k) or {}).get('asset_spec'),
                                     'market': 'swap', 'contributors': [], 'gated': False}
            target = dict(target)
            target[k] = _signed_target_row(base, signed)
    if (any(v.get('stale_target') for v in full_target.values()) or os.path.exists(_STALE_SHARE_PATH)
            or _stale_share_unsaved is not None):
        skip = ({r.get(e) for r in rolls for e in ('from', 'to')}
                | set(hold_roots) | {x for v in hold_roots.values() for x in v}) - {None}
        try:
            target = _stale_share_targets(target, diff_actual, skip,
                                          {k for k, v in full_target.items() if v.get('stale_target')})
        except Exception as e:  # never a reason to skip this round's exits
            logging.error(f"[reconcile] stale-share hold failed ({type(e).__name__}: {e}) "
                          f"— those keys reconcile as computed this round")
        else:
            full_target = dict(full_target, **{k: v for k, v in target.items()
                                               if v.get('stale_held') is not None})
    entry_gates = {}
    orders = compute_diff(target, diff_actual, threshold, gates=entry_gates,
                          drift_band=None if own_only else drift_band)

    # Never configured = read-only (Wei 2026-09-23). With no config the target
    # is empty and every position on the account — the user's own manual ones
    # included, without self_ledger — reads as "close it". Setting amounts to 0
    # to flatten still works: that SAVES a config. Here, not in the reconciler
    # loop: every caller of reconcile() (the daemon, a hand-run script) passes
    # through it, and the lib order gates cannot know the caller's intent (Type
    # B strategies trade without any portfolio config). Positions are still
    # read and snapshotted, so the page shows them.
    global _unconfigured_logged
    read_only = not portfolio_configured()
    if read_only:
        if not _unconfigured_logged:
            logging.info("[reconcile] no manager/portfolio_config.json — amounts were never "
                         "saved: read-only, no orders (closes included) until they are")
            _unconfigured_logged = True
        orders = []
    elif _unconfigured_logged:
        logging.info("[reconcile] portfolio config saved — reconciling normally")
        _unconfigured_logged = False
    if needs_baseline is not None:
        orders = []

    # Reduces before entries (stable: set order means nothing): a contract
    # rollover's close leaves first, and the snapshot lists them as they go.
    orders.sort(key=lambda o: _order_phase(o, diff_actual))

    # Written before placing, so it records the state that WAS acted on. A
    # reconcile that crashes mid-loop still leaves the observation behind.
    # full_target, not the filtered dict (audit #8): a gated strategy's target
    # must stay visible to the workspace view — carrying 'gated': True — not
    # vanish while it waits for its signal.
    # unreadable record under HALT: which contracts roll is unknown, so the whole
    # family holds (no close-only half); said on the page, no new send point
    roll_roots = set(TXF_FAMILY) if _load_rollovers() is None else set()
    halted_now = halted_at_start or guard.halted()
    if roll_roots:
        rolls = [{'strategy': None, 'from': None, 'to': None, 'since': None,
                  'state': 'record_unreadable'}]
    for row in rolls:
        if row.get('state') == 'record_unreadable':
            continue
        # what the page shows: closing the old contract, or waiting because the
        # old contract is held as is (a waiting / unreadable strategy on it)
        olds = [k for k in set(full_target) | set(diff_actual_full)
                if txf_root(split_key(k)[0]) == row['from'] and split_key(k)[1] != 'spot']
        row['state'] = ('halted' if halted_now and row.get('to') else
                        'waiting_gate' if any(k in gated_symbols for k in olds) else
                        'waiting_pending' if any(k in pending_keys for k in olds) else 'closing')
    _write_reconcile_snapshot(full_target, actual, orders, ledger=ledger,
                              gates=entry_gates, read_only=read_only,
                              own_only=own_only, needs_baseline=needs_baseline,
                              baseline_pending=sorted(pending_keys), rollovers=rolls,
                              market_closed=sorted(closed_keys))

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

    ledger_venue = book_venue() if ledger is not None else None
    executed = []  # orders with ≥1 confirmed fill — the return value
    try:  # a lib.execute from before market markers: no marker, as before
        from lib.execute import (_remove_inflight_marker as unmark_inflight,
                                 _write_inflight_marker as mark_inflight)
    except ImportError:
        mark_inflight = unmark_inflight = None
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
        a        = diff_actual.get(symbol, {})
        is_lot_based = native_units(asset_spec, order.get('exchange'), actual=a)
        symbol_root = txf_root(split_key(symbol)[0]) if split_key(symbol)[1] != 'spot' else None

        # Detect position flip: split into reduce-only close + directional open
        # to avoid simultaneous long+short on hedge-mode exchanges. Must use
        # diff_actual (ledger, when self_ledger is on) — not actual — or a
        # manual position visible only in the real exchange read would get
        # classified as a flip and generate a reduce-only close leg against it,
        # exactly the touch self_ledger exists to prevent.
        a_signed = (a.get('size', 0)  if a.get('side') == 'long'  else
                    -a.get('size', 0) if a.get('side') == 'short' else 0)
        if symbol in halt_targets and not halted_at_start and guard.halted():
            # halted mid-round: this order was sized off the un-held target
            diff = halt_targets[symbol] - a_signed
            if abs(diff) < 1e-9:
                guard.audit('rollover_halted', symbol=symbol)
                continue
        t_signed = a_signed + diff

        # Third element is is_entry — whether the leg ADDS exposure. A flip's
        # second leg always does; a plain adjustment only when it grows the
        # position (|target| > |actual|).
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
        marked = False
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

            # HALT and a rollover (Wei 10-14): neither contract trades until
            # 啟動下單 lifts HALT, then close first, open next. The freeze below
            # denies the legs anyway; this keeps the rollover's own audit line
            # and the unreadable-record case (no way to tell which contracts
            # roll, so no family leg at all).
            if symbol_root in roll_roots and (halted_at_start or guard.halted()):
                guard.audit('rollover_halted', symbol=symbol, signed_diff=sub_diff)
                logging.info(f"[reconcile] {symbol} {sub_diff:+g} held — contract rollover "
                             f"waits for 啟動下單 (HALT)")
                failed = True
                break

            # Contract rollover: the NEW contract of a rollover in progress gets no
            # entry while the old one still has something to close. Read off the
            # book at the round's start, so a close that failed, filled in part,
            # parked (統一 IOC) or waits on a confirmed short read all keep the
            # entry out; a close that filled lets it go next round (force_next).
            if is_entry and txf_root(split_key(symbol)[0]) in hold_roots \
                    and split_key(symbol)[1] != 'spot':
                waiting = hold_roots[txf_root(split_key(symbol)[0])]
                guard.audit('entry_held_rollover', symbol=symbol, signed_diff=sub_diff,
                            waiting_on=waiting)
                logging.warning(f"[reconcile] {symbol} entry {sub_diff:+g} held — contract "
                                f"rollover, {waiting} not closed yet")
                failed = True
                break

            # Kill switch (a full freeze, Wei 10-17), enforced here rather than
            # only in lib/order_*.py: every reconciler goes through this function,
            # including the hand-written place_order_fn of an exchange that has no
            # official lib/order_* module. Deliberately silent on Telegram — a
            # denial every poll is the noise a pause exists to stop.
            halted_leg = halted_at_start or guard.halted()
            close_all_leg = halted_leg and reduce_only and symbol in deferred
            if halted_leg and not close_all_leg:
                guard.audit('order_denied_halt', symbol=symbol, signed_diff=sub_diff,
                            exchange=order.get('exchange'), source='reconcile',
                            intent='entry' if is_entry else 'reduce')
                logging.warning(
                    f"[reconcile] {symbol} {'entry' if is_entry else 'reduce'} {sub_diff:+.2f} "
                    f"denied — state/HALT is set ({guard.halt_info()})"
                )
                failed = True
                break

            cap_writeoff = None
            if (reduce_only and ledger is not None
                    and venue_traits.has(order.get('exchange') or ledger_venue, 'hand_wired')):
                capped, cap_writeoff = hand_wired_reduce_cap(
                    symbol, sub_diff, a_signed, actual.get(symbol),
                    venue=order.get('exchange') or ledger_venue, book_row=a)
                if abs(capped) < 0.5:  # the hand-wired place_order's half-lot gate
                    if cap_writeoff:
                        apply_ledger_writeoff(symbol, cap_writeoff)
                    elif account_short_pending(symbol):
                        logging.warning(f"[reconcile] {symbol} close {sub_diff:+g} lots not sent — "
                                        f"the account holds less than the book; waiting for "
                                        f"a second read to confirm")
                    continue
                if abs(capped) < abs(sub_diff):
                    logging.warning(f"[reconcile] {symbol} close {sub_diff:+g} lots capped to "
                                    f"{capped:+g} — the account holds less than the book")
                    sub_diff = capped

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

            # A market fill is only in the book once its orders.jsonl line is: a
            # process killed in between would leave the fill out and buy it again
            # after the restart. The marker (the one TWAP / chase write) outlives
            # such a kill, and the next start's reap_dead_inflight HALTs on it.
            if mark_inflight and not marked:
                mark_inflight(f"{symbol}#market", "market", sub_diff)
                marked = True
            try:
                if close_all_leg:
                    with guard.halt_close_pass(symbol, 'close_all_deferred'):
                        placed = _call_place(symbol, sub_diff, asset_spec, reduce_only,
                                             exchange=order.get('exchange'),
                                             contributors=order.get('contributors'))
                else:
                    placed = _call_place(symbol, sub_diff, asset_spec, reduce_only,
                                         exchange=order.get('exchange'),
                                         contributors=order.get('contributors'))
            except Exception as e:
                fresh = _order_error_fresh(symbol, e, 'reduce' if reduce_only else 'entry')
                _record_order_error(symbol, order.get('exchange'), e, repeat=not fresh)
                if fresh:
                    logging.error(f"order error {symbol}: {e}")
                    notices.append(('order_error', '⚠️ Order failed {symbol}: {error}',
                                    {'symbol': symbol, 'error': _reject_plain(e)}))
                else:
                    logging.debug(f"order error {symbol}: same reason again, already notified")
                failed = True
                break

            if placed is False:
                # place_order skipped: qty below exchange minimum, or the leg was
                # handed to / deferred behind an async executor (lib.execute) —
                # either way nothing filled synchronously, nothing to log here
                logging.info(f"[reconcile] {symbol} skipped by place_order — "
                             f"below minimum or async execution in flight")
                continue
            _order_error_notified.pop((symbol, 'reduce' if reduce_only else 'entry'), None)   # it went through: a later failure is news again

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
            if (cap_writeoff and not writeoff and isinstance(placed, dict)
                    and float(placed.get('executed_qty') or 0) >= abs(sub_diff) - 1e-9):
                writeoff = cap_writeoff
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
                                 ('exchange', 'exchange'),
                                 # one-way netting (lib.venue_wiring._netted_room / _netted_exit)
                                 ('netted_qty', 'netted_qty'),
                                 ('netted_exit', 'netted_exit'),
                                 # 群益: the month contract that filled (TX2610) — the order row's
                                 # symbol is the book key (TXF); the pages show 「大台（TX2610）」
                                 ('resolved_symbol', 'resolved_symbol')):
                    if placed.get(src) is not None:
                        leg[dst] = placed[src]
                if not float(placed.get('executed_qty') or 0):
                    # nothing filled: 群益 hands back the alias it sent (TM0000), not a month contract
                    leg.pop('resolved_symbol', None)
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
                # A spot fill's coins moved = book_qty (lib.venue_wiring.spot_book_qty:
                # a buy's fee comes out of the coin bought) — executed_qty stays the
                # venue's pre-fee fill for the trade history.
                if ledger is not None:
                    try:
                        moved = placed.get('book_qty') if isinstance(placed, dict) else None
                        if moved is None:
                            moved = leg.get('executed_qty')
                        if moved is not None:
                            leg['signed_qty'] = ((1.0 if sub_diff >= 0 else -1.0)
                                                 * abs(float(moved)))
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
            # A paper TW stock row is booked in TWD (the strategy's amount currency), not USD.
            unit = ('{amount:g} shares' if asset_type(asset_spec) == 'shares' else
                    '{amount:g} lots' if is_lot_based else
                    '{amount:,.0f} TWD' if _tw_stock(split_key(symbol)[0]) else '${amount:.2f}')
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
        if marked:
            unmark_inflight(f"{symbol}#market")
        if logged[0]:
            executed.append(order)

        for key, default, kw in notices:
            _notify(key, default, **kw)

    return executed
