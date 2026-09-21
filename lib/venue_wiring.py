"""
Auto-wiring: routes the reconciler through the machine's OFFICIAL venue libs.

Why this exists (measured 2026-08-04/05 on the onboarding test machine): the
reconciler template shipped with NotImplementedError stubs and relied on the
agent hand-wiring them per venue. Three failure modes followed — a venue whose
official libs were all present still crash-looped on the stubs ("page says
ready, reconciler is a shell"); rebinding to another exchange left the old
hand-wiring pointed at a venue whose keys were gone (auto-halt storms); and
every hand-wiring re-implemented the same USD-diff mapping with fresh bugs.
This module IS that mapping, written once, with every harvested fix baked in.

Scope: venues whose BOTH lib/account_{id}.py AND lib/order_{id}.py ship
officially (see references/exchange-connect.md rule 2). Venues without
official libs still need a hand-wired reconciler — the template's stubs say
how. Taiwan brokers (sinopac signed-diff contract) are NOT routed here.

Key contract (lib/portfolio): plain "BTCUSDT" keys = perp/swap,
"BTCUSDT@spot" = spot inventory (market_key/split_key); spot actuals come
from spot_scope() so removing a spot strategy sells its inventory down and
personal coins never enter.
"""
import importlib
import json
import logging
import math
import os
import re
import time
from datetime import datetime

from lib.portfolio import load_portfolio_config, market_key, split_key, spot_scope

_ENV_KEY_RE = re.compile(r"^\s*([A-Za-z0-9_]+)_API_KEY\s*=", re.IGNORECASE)
_RESERVED_PREFIXES = {"BLAVE"}
_NON_AUTO = {"sinopac", "president", "capital"}  # TW brokers: signed-diff contract


def read_env(path=".env"):
    """Minimal .env parse — the dict shape every lib takes."""
    env = {}
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip("'\"")
    except OSError:
        pass
    return env


# Deployment redline L2 (spec §3.2): manager/credentials.ui.json is written by
# the platform runtime on every bind — a web bind, or the chat bind through
# lib.venue.bind (AGENTS.md › Exchange API Keys) — the venue ids (paper
# included) whose credential pair went through that writer. When it exists,
# only those ids can route; keys an agent hand-writes into .env never become a
# live venue. Missing/corrupt manifest = fail-open (pre-manifest machines
# unchanged). Warn-once set is process-lifetime — official_venues runs every
# reconcile round and must not spam the log; the USER notify (spec §3.2, a
# filtered venue means "looks bound, will not trade" and staying silent hides
# it) has its own 24h stamp-file cooldown, same pattern as lib/portfolio's
# _ui_override_alert.
_CRED_MANIFEST_PATH = "manager/credentials.ui.json"
_MANIFEST_ALERT_STAMP_PATH = "state/ui_credentials_alert"
_MANIFEST_ALERT_COOLDOWN_S = 24 * 3600
_MANIFEST_ALERT_MSG = ("機器上的交易所金鑰與投資組合頁的綁定不一致,"
                       "以投資組合頁為準——請在投資組合頁重新連接交易所")
_manifest_filtered_warned = set()


def _ui_bound_ids():
    """Lowercased venue ids from the UI bind manifest, or None when
    absent/invalid (fail-open — see comment above)."""
    try:
        with open(_CRED_MANIFEST_PATH) as f:
            ids = json.load(f).get("ids")
        if not isinstance(ids, list):
            return None
        return {str(i).lower() for i in ids}
    except (OSError, ValueError, AttributeError):
        return None


def _manifest_filtered_alert(vid):
    """A vid with keys+libs got filtered by the manifest: log once per
    process, and tell the user once per 24h (stamp written BEFORE sending so
    a slow send can't spam; failed stamp still sends — same trade-off as
    lib/portfolio._ui_override_alert)."""
    if vid not in _manifest_filtered_warned:
        _manifest_filtered_warned.add(vid)
        logging.warning(
            f"[venue_wiring] {vid} has keys+libs but is not in the web bind "
            f"manifest ({_CRED_MANIFEST_PATH}) — not routed; bind it from the "
            f"投資組合 page")
    # 事件在 24h stamp 之前落檔:那個 stamp 是給 Telegram 那一半的,平台自己去重。
    try:
        from lib.events import emit
        emit("venue_unbound", venue=vid)
    except Exception:
        pass
    try:
        if os.path.exists(_MANIFEST_ALERT_STAMP_PATH) and \
                time.time() - os.path.getmtime(_MANIFEST_ALERT_STAMP_PATH) \
                < _MANIFEST_ALERT_COOLDOWN_S:
            return
        os.makedirs(os.path.dirname(_MANIFEST_ALERT_STAMP_PATH), exist_ok=True)
        with open(_MANIFEST_ALERT_STAMP_PATH, "w") as f:
            f.write(datetime.utcnow().isoformat())
    except OSError as e:
        logging.warning(f"[venue_wiring] manifest alert stamp failed: {e}")
    try:
        from lib.notify import send_text
        send_text(_MANIFEST_ALERT_MSG)
    except Exception as e:
        logging.error(f"[notify-unavailable] ({e}) {_MANIFEST_ALERT_MSG}")


def official_venues(env):
    """Venue ids with keys in .env AND both official libs on disk — and, when
    the UI bind manifest exists, listed in it (see _ui_bound_ids)."""
    allowed = _ui_bound_ids()
    out = []
    for k in env:
        m = _ENV_KEY_RE.match(k + "=")
        if not m:
            continue
        vid = m.group(1).lower()
        if m.group(1).upper() in _RESERVED_PREFIXES or vid in _NON_AUTO:
            continue
        if os.path.isfile(f"lib/account_{vid}.py") and os.path.isfile(f"lib/order_{vid}.py"):
            if allowed is not None and vid not in allowed:
                _manifest_filtered_alert(vid)
                continue
            out.append(vid)
    return sorted(set(out))


def detect_venue(env):
    """The venue this machine trades on, or None. One bound venue is the
    designed case (one portfolio, one account); with several, prefer the one
    portfolio_config routes strategies to, loudly."""
    vids = official_venues(env)
    if not vids:
        return None
    if len(vids) == 1:
        return vids[0]
    routed = [v for v in (load_portfolio_config().get("exchanges") or {}).values()
              if v in vids]
    pick = max(set(routed), key=routed.count) if routed else vids[0]
    logging.warning(f"[venue_wiring] multiple official venues bound {vids} — using {pick}")
    return pick


_SPOT_QUOTES = ("USDT", "USDC")


def _spot_base(sym):
    """Base asset of a spot pair. Unknown quote RAISES (audit H1): silently
    valuing it 0 makes actual read 0 forever while the buy path still trades —
    reconcile then re-buys the full target every round until the wallet is
    empty. A loud failure lands in the get_positions error contract and the
    auto-halt wrapper instead."""
    for q in _SPOT_QUOTES:
        if sym.endswith(q) and len(sym) > len(q):
            return sym[: -len(q)]
    raise RuntimeError(
        f"unsupported spot quote on {sym} (supported: {'/'.join(_SPOT_QUOTES)}) — "
        f"refusing to trade what cannot be inventory-read"
    )


def _no_venue():
    raise RuntimeError(
        "no officially-supported venue bound (keys + lib/account_*.py + "
        "lib/order_*.py) — for other venues, hand-wire manager/reconciler.py "
        "per references/exchange-connect.md"
    )


def _cid():
    from datetime import timezone
    return "rc" + datetime.now(timezone.utc).strftime("%y%m%d%H%M%S%f")


def auto_get_positions():
    """Reconciler get_positions: swap positions (plain keys, USD value) +
    spot inventory for spot-scoped symbols ("SYMBOL@spot" keys) when the
    venue's order lib ships a spot layer. Errors PROPAGATE — the template's
    error contract (an empty dict would read as flat and re-buy the whole
    target on link recovery)."""
    env = read_env()
    vid = detect_venue(env)
    if vid is None:
        _no_venue()
    acct = importlib.import_module(f"lib.account_{vid}")
    order = importlib.import_module(f"lib.order_{vid}")

    # net same-symbol rows (audit M3): hedge-mode accounts can report a long
    # AND a short row for one symbol — clobbering keeps only the last and the
    # reconciler then trades against a wrong actual. The reconciler's own
    # orders never create dual-side positions, but user-opened ones exist.
    net = {}
    positions = acct.get_positions(env)
    rows = (positions.items() if isinstance(positions, dict)
            else ((p["symbol"], p) for p in positions))
    for sym, p in rows:
        p = p or {}
        usd = p.get("size", 0) if isinstance(positions, dict) \
            else p["size"] * p["mark_price"]
        signed = usd if p.get("side") == "long" else -usd if p.get("side") == "short" else 0
        net[str(sym)] = net.get(str(sym), 0) + signed
    out = {}
    for sym, v in net.items():
        out[sym] = {"side": "long" if v > 0 else ("short" if v < 0 else None),
                    "size": abs(v)}

    if hasattr(order, "get_spot_balances"):
        balances = None

        def _inv_value(sym):
            nonlocal balances
            base = _spot_base(sym)  # unknown quote raises — see _spot_base
            if balances is None:
                balances = order.get_spot_balances(env)
            amt = balances.get(base, 0.0)
            return amt * order.get_spot_price(env, sym) if amt else 0.0

        for sym, size in spot_scope(_inv_value).items():
            out[market_key(sym, "spot")] = {"side": "long" if size else None, "size": size}
    return out


def _lot_base(order, env, sym, rules=None):
    """One qty step in BASE units, across both rules dialects: new libs return
    'step' (+contract_value); the older bingx lib returns qty_precision
    (decimal places, contract_value 1). `rules` skips the read when the caller
    already holds them."""
    r = rules if rules is not None else order.get_contract_rules(env, sym)
    step = r.get("step")
    if step is None and "qty_precision" in r:
        step = 10 ** -int(r["qty_precision"])
    return float(step or 0) * float(r.get("contract_value") or 1)


def _reduce_qty(env, vid, order, sym, direction, qty):
    """Reduce legs CEIL to a whole lot and cap at the actual position — the
    USD diff was computed at the snapshot's mark, so a full close converts to
    fractionally under the position's lot count and flooring strands one lot
    below the reconcile threshold forever (measured: closing 0.04 ct became
    0.03 ct, $6.4 residual). Ceiling is only safe WITH the cap, so when the
    position can't be read the qty is returned un-ceiled (floor path — dust
    possible, oversell impossible).

    self_ledger EXCEPTION (measured live 2026-08-20 on uid 29026): with
    portfolio_config["self_ledger"] on, the account position is NOT all the
    bot's — the cap includes the user's own manual holding in the same symbol
    and direction, so ceiling eats one lot step out of the MANUAL position
    (closing the bot's 0.017 ETH ceiled to 0.018, selling $2.25 of the user's
    coins — the exact touch self_ledger exists to prevent). Reduce legs FLOOR
    in that mode.

    Under self_ledger this function now only sizes LEGACY rows (a book with no
    quantity — lib.portfolio.ledger_book); everything else goes through
    _book_reduce_qty. Flooring never made "cannot sell what it doesn't own"
    true: `qty` here is USD ÷ the CURRENT mark, so a close below the entry
    price asks for more than was bought and the cap is the whole account
    (measured 2026-09-21 on paper: bought 0.01, sold 0.012 out of a 0.03
    account). A legacy row keeps that exposure until it is first flat."""
    try:
        acct = importlib.import_module(f"lib.account_{vid}")
        positions = acct.get_positions(env)
        held = 0.0
        if isinstance(positions, list):  # list contract: size is BASE units.
            # dict contract carries USD — no base cap possible, held stays 0.
            # SUM matching rows (audit M3): hedge accounts can split a side.
            for p in positions:
                if p["symbol"] == sym and p.get("side") == direction:
                    held += p["size"]
        lot = _lot_base(order, env, sym)
        if held and lot > 0:
            from lib.portfolio import load_portfolio_config
            if load_portfolio_config().get("self_ledger"):
                return min(math.floor(qty / lot + 1e-9) * lot, held)
            return min(math.ceil(qty / lot - 1e-9) * lot, held)
    except Exception as e:
        logging.warning(f"[venue_wiring] reduce ceil/cap skipped ({e}) — floor path")
    return qty


def _held_base(env, vid, sym, direction):
    """Base units the ACCOUNT holds on that side of `sym`, or None when that
    cannot be known (failed read, or the dict contract, which carries USD)."""
    try:
        acct = importlib.import_module(f"lib.account_{vid}")
        positions = acct.get_positions(env)
        if not isinstance(positions, list):
            return None
        return float(sum(p["size"] for p in positions
                         if p["symbol"] == sym and p.get("side") == direction))
    except Exception as e:
        logging.warning(f"[venue_wiring] {sym}: account position unreadable ({e})")
        return None


def _book_row(symbol, signed_diff):
    """self_ledger only: what the bot's own book says about the position a
    REDUCE leg of `signed_diff` is closing — None when self_ledger is off (the
    caller then sizes exactly as it always has). Read here rather than threaded
    down from reconcile: a TWAP slice or a chase re-post is sized long after
    reconcile returned, and manager/reconciler.py is a file users hand-edit —
    a new argument through it would silently not arrive on those machines.

    {'owned': base units the bot holds on the side being closed (0 = none),
     'unit_cost': USD of cost per base unit — the rate a reduce leg's USD
         converts at. NOT the mark: that conversion is what stranded or
         oversold every close away from the entry price. A proportional
         reduce leaves it unchanged, so every slice of one execution converts
         at the same rate even though the book is only written at the end,
     'full': this leg takes the book to flat,
     'legacy': the row has no usable quantity — size it the old way}"""
    try:
        if not load_portfolio_config().get("self_ledger"):
            return None
        # files reach a machine one at a time: a lib.portfolio from before the
        # quantity book has no ledger_book, and its book is sized the old way
        from lib.portfolio import ledger_book
    except Exception as e:
        logging.warning(f"[venue_wiring] {symbol}: book unavailable ({e}) — sized at the mark")
        return None
    r = ledger_book().get(symbol)
    # a reduce leg closes the side OPPOSITE to its own sign
    if not r or r["cost"] * signed_diff >= 0:
        return {"owned": 0.0, "unit_cost": None, "full": True, "legacy": False}
    full = abs(signed_diff) >= abs(r["cost"]) * (1 - 1e-9)
    if r["legacy"]:
        return {"owned": None, "unit_cost": None, "full": full, "legacy": True}
    return {"owned": abs(r["qty"]), "unit_cost": abs(r["cost"]) / abs(r["qty"]),
            "full": full, "legacy": False}


def _account_short(symbol, short):
    """lib.portfolio.note_account_short: True only once a read showing the
    account short of the book is CONFIRMED by a second one. Anything less
    (incl. a lib.portfolio without it) is "not known" — the leg is then sized
    and sent as if the read had not happened, never written off."""
    try:
        from lib.portfolio import note_account_short
        return note_account_short(symbol, short)
    except Exception as e:
        logging.warning(f"[venue_wiring] {symbol}: short-read bookkeeping failed ({e})")
        return False


def _book_reduce_qty(env, vid, order, sym, direction, usd, row, sold=0.0, key=None):
    """(qty, held, lot, confirmed) for a self_ledger reduce leg on a quantity row.

    The share of the book this leg closes, in the bot's own units: usd ÷
    unit_cost, the whole `owned` on a full close. ROUNDED to the nearest lot
    (flooring leaves a 0.5–1 lot remainder that passes the half-lot reduce
    gate and then floors to nothing, every round) and capped at
    min(owned, account) floored to a lot: never more than the bot bought, and
    never more than is there. `sold` = base already closed by earlier slices
    of the same execution, which the book does not show until it finishes.

    An account read SHORT of the book is only believed once confirmed
    (`confirmed`, _account_short). Until then an empty read is treated like a
    failed one — the reduce-only order goes out at the book's quantity and the
    venue, which knows, fills or refuses it (what _reduce_qty has always done
    with a position it could not find). A non-empty short read still caps the
    order: selling less than asked is safe whichever side is wrong."""
    owned = max(0.0, row["owned"] - sold)
    qty = owned if row["full"] else min(abs(usd) / row["unit_cost"], owned)
    lot = 0.0
    try:
        lot = _lot_base(order, env, sym)
    except Exception as e:
        logging.warning(f"[venue_wiring] {sym}: lot size unavailable ({e}) — unrounded")
    if lot > 0 and math.floor(qty / lot + 0.5) == 0 and not row["full"]:
        return 0.0, None, lot, False  # rounds to nothing: no account read to learn that
    held = _held_base(env, vid, sym, direction)
    confirmed = False
    if held is not None and owned > 0:
        confirmed = _account_short(key or sym, held < owned * (1 - 1e-9))
        if held <= 0 and not confirmed:
            held = None
    cap = owned if held is None else min(owned, held)
    if lot > 0:
        qty = min(math.floor(qty / lot + 0.5), math.floor(cap / lot + 1e-9)) * lot
    else:
        qty = min(qty, cap)
    return qty, held, lot, confirmed


def _book_writeoff(row, qty, held, lot, executed, sold=0.0, confirmed=False):
    """Why the book should be zeroed after this close, or None. Only on a full
    close, and only for a remainder that can never be sold — a partial fill
    leaves a real position behind and must be retried, not forgotten. The two
    reasons that rest on an account read need it `confirmed` (_account_short)."""
    if not row["full"]:
        return None
    owned = max(0.0, row["owned"] - sold)
    rest = owned - executed
    if rest <= max(1e-12, 1e-9 * owned):
        return None
    if confirmed and held is not None and held <= 0:
        return "account holds none of it"
    if executed < qty * (1 - 1e-9):
        return None if qty > 0 else "below one lot"
    if lot > 0 and rest < lot * (1 - 1e-9):
        return "remainder below one lot"
    if confirmed and held is not None and held < owned:
        return "account held less than the book"
    return None


def auto_position_qty():
    """{symbol: signed BASE quantity} of the account's swap positions, netted
    per symbol — the quantity twin of auto_get_positions (which answers in
    USD at the mark). For seed_ledger --absorb, and for comparing the account
    with lib.portfolio.ledger_positions()[sym]['qty'] without a price in
    between. None when the venue's account lib answers in the dict (USD)
    contract: there is no quantity to read."""
    env = read_env()
    vid = detect_venue(env)
    if vid is None:
        _no_venue()
    positions = importlib.import_module(f"lib.account_{vid}").get_positions(env)
    if not isinstance(positions, list):
        return None
    out = {}
    for p in positions:
        sign = 1 if p.get("side") == "long" else -1 if p.get("side") == "short" else 0
        sym = str(p["symbol"]).replace("-", "").upper()
        out[sym] = out.get(sym, 0.0) + sign * float(p["size"])
    return out


def _entry_qty(order, env, sym, qty):
    """Entry legs ROUND to the nearest whole lot — the mirror of _reduce_qty's
    ceil on the close side.

    Flooring (what every order lib's format_qty does) strands the sub-lot
    remainder forever whenever an allocation is only a few lots wide. Measured
    live 2026-09-08 (uid 32321): $289 on BTC perps is 3.7 lots of ~$78, so a
    $227 target floored to 0.002 BTC ($157) and left a $70 residual — above
    reconcile's $10 THRESHOLD, below the venue's min qty. Every round
    re-dispatched an order the venue could never accept, and the gap could not
    shrink: the next fillable size is a whole $78 lot away. Rounding lands the
    position on the NEAREST grid point instead, so the leftover is at most half
    a lot — which is NOT inside a flat THRESHOLD of 10 on its own (half a BTC
    lot is ~$39: left there, the next round sells a whole lot back and the one
    after that buys it again). What converges it is the per-symbol ENTRY gate:
    manager/reconciler._symbol_threshold gates entries at the venue's own
    minimum, so a leftover under one lot is not bought back; and the REDUCE
    gate at half a lot, so an over-target under that is not ceil-sold either
    (never a whole lot — a close must never be gated out).

    math.floor(x + 0.5), not round() — Python rounds a .5 tie to even. Same
    round-half-up reconciler._capital_place_order has always used for capital
    lots; this brings crypto in line. A failed rules read returns qty untouched
    (the order lib then floors as before — understate, never overshoot)."""
    try:
        lot = _lot_base(order, env, sym)
        if lot > 0:
            return math.floor(qty / lot + 0.5) * lot
    except Exception as e:
        logging.warning(f"[venue_wiring] entry lot rounding skipped ({e}) — floor path")
    return qty


_TERMINAL_FILLED = {"filled"}
# every venue's own terminal-dead states must be here — a missing one makes the
# chase loop treat a dead order as open and idle out its whole window
# (expired_in_match = Binance STP, failed = BingX, mmp_canceled = OKX)
_TERMINAL_GONE = {"canceled", "cancelled", "rejected", "expired",
                  "expired_in_match", "failed", "mmp_canceled"}


def _norm_status(raw):
    s = str(raw or "").lower()
    if s in _TERMINAL_FILLED:
        return "filled"
    if s in _TERMINAL_GONE:
        return "canceled"
    if s == "post_only_rejected":
        return "post_only_rejected"
    return "open"


def auto_limit_toolkit(symbol, reduce_only=False):
    """Limit-layer toolkit for the chase executor (lib.execute), or None when
    the bound venue does not ship the limit layer — the caller then falls back
    to a market order, loudly.

    All quantities are the reconciler's USD terms; conversion to base qty
    happens here at the caller-supplied limit price. Returned callables:
      bbo()                    -> (bid, ask) floats
      place(usd, price, cid)   -> {'order_id', ...} | {'status':'post_only_rejected'}
                                  | False (below venue minimum). Always post-only.
      status(order_id)         -> {'status': open|filled|canceled|post_only_rejected,
                                   'orig_qty','executed_qty','avg_price'} (base qty)
      cancel(order_id)         -> best-effort; "already filled/gone" must not raise
    `usd` is UNSIGNED — direction is fixed at toolkit build time from the leg's
    signed_diff sign (chase never flips a leg mid-flight; a flipped target stops
    the execution instead).
    """
    env = read_env()
    vid = detect_venue(env)
    if vid is None:
        _no_venue()
    order = importlib.import_module(f"lib.order_{vid}")
    sym, market = split_key(symbol)

    if market == "spot":
        need = ("place_spot_limit_order", "cancel_spot_order",
                "get_spot_order", "get_spot_bbo", "get_spot_balances")
        if not all(hasattr(order, n) for n in need):
            return None

        def _place(usd, price, cid, _buy, sold=0.0):
            base_qty = abs(usd) / price
            if not _buy:
                held = order.get_spot_balances(env).get(_spot_base(sym), 0.0)
                base_qty = min(base_qty, held)
                row = _book_row(symbol, -abs(usd))
                if row is not None and not row["legacy"]:
                    # self_ledger: same sizing as auto_place_order's spot sell
                    owned = max(0.0, row["owned"] - sold)
                    base_qty = min(owned if row["full"] else abs(usd) / row["unit_cost"],
                                   owned, held)
                    if base_qty <= 0:
                        return False
            return order.place_spot_limit_order(
                env, sym, "buy" if _buy else "sell", base_qty, price,
                client_order_id=cid or _cid(), post_only=True)

        def _spot_bbo():
            b = order.get_spot_bbo(env, sym)
            return float(b["bid"]), float(b["ask"])

        def _spot_unit_cost(_buy):
            row = None if _buy else _book_row(symbol, -1.0)
            return (row or {}).get("unit_cost")

        return {
            "venue": vid,
            "bbo": _spot_bbo,
            "unit_cost": _spot_unit_cost,
            "place": _place,
            "status": lambda oid: _norm_order(order.get_spot_order(env, sym, oid)),
            "cancel": lambda oid: order.cancel_spot_order(env, sym, oid),
        }

    need = ("place_limit_order", "cancel_order", "get_order", "get_bbo")
    if not all(hasattr(order, n) for n in need):
        return None

    def _place(usd, price, cid, _buy, sold=0.0):
        qty = abs(usd) / price
        row = _book_row(symbol, usd if _buy else -usd) if reduce_only else None
        direction = "long" if not _buy else "short"  # closing that side
        if row is not None and not row["legacy"]:
            # self_ledger: `usd` is the book's USD (see auto_place_order)
            qty = _book_reduce_qty(env, vid, order, sym, direction, usd, row, sold,
                                   key=symbol)[0]
            if qty <= 0:
                return False
        elif reduce_only:
            qty = _reduce_qty(env, vid, order, sym, direction, qty)
        else:
            direction = "long" if _buy else "short"
            qty = _entry_qty(order, env, sym, qty)
        return order.place_limit_order(
            env, sym, direction, qty, price, client_order_id=cid or _cid(),
            reduce_only=reduce_only, post_only=True)

    def _swap_bbo():
        b = order.get_bbo(env, sym)
        return float(b["bid"]), float(b["ask"])

    def _unit_cost(_buy):
        # self_ledger reduce: the rate the chase counts its fills at — _book_row
        row = _book_row(symbol, 1.0 if _buy else -1.0) if reduce_only else None
        return (row or {}).get("unit_cost")

    return {
        "venue": vid,
        "bbo": _swap_bbo,
        "unit_cost": _unit_cost,
        "place": _place,
        "status": lambda oid: _norm_order(order.get_order(env, sym, oid)),
        "cancel": lambda oid: order.cancel_order(env, sym, order_id=oid),
    }


def _norm_order(row):
    row = dict(row or {})
    return {
        "status": _norm_status(row.get("status")),
        "orig_qty": float(row.get("orig_qty") or 0),
        "executed_qty": float(row.get("executed_qty") or 0),
        "avg_price": float(row.get("avg_price") or 0),
    }


# Our resting-order fingerprint: _cid() mints "rc" + a UTC microsecond
# timestamp. A user's own manual order will not carry it, so the sweep can
# cancel on match without touching anything the user placed themselves.
_RC_CID_RE = re.compile(r"rc\d{12,}")


def sweep_orphan_orders():
    """Cancel resting limit orders a dead reconciler left behind (chase posts
    them; a crash mid-chase strands one on the venue). Called once at
    reconciler startup — best-effort, never blocks the loop. Returns the count
    cancelled."""
    env = read_env()
    vid = detect_venue(env)
    if vid is None:
        return 0
    order = importlib.import_module(f"lib.order_{vid}")
    lanes = []
    if hasattr(order, "get_open_orders") and hasattr(order, "cancel_order"):
        lanes.append((order.get_open_orders,
                      lambda s, oid: order.cancel_order(env, s, order_id=oid)))
    if hasattr(order, "get_spot_open_orders") and hasattr(order, "cancel_spot_order"):
        lanes.append((order.get_spot_open_orders,
                      lambda s, oid: order.cancel_spot_order(env, s, oid)))
    n = 0
    for fetch, cancel in lanes:
        try:
            rows = fetch(env) or []
        except Exception as e:
            logging.warning(f"[venue_wiring] orphan sweep read failed: {e}")
            continue
        for row in rows:
            if not _RC_CID_RE.search(str(row.get("client_order_id") or "")):
                continue
            sym, oid = row.get("symbol"), row.get("order_id")
            if not sym or not oid:
                continue
            try:
                cancel(sym, oid)
                n += 1
                logging.info(f"[venue_wiring] cancelled orphaned order {oid} on {sym}")
            except Exception as e:
                logging.warning(f"[venue_wiring] orphan cancel {oid} failed: {e}")
    return n


def auto_place_order(symbol, signed_diff, asset_spec=None, reduce_only=False,
                     exchange=None, sold=0.0):
    """Reconciler place_order: routes on the key's market. Spot buys are sized
    in QUOTE currency directly; spot sells in base qty capped at the wallet's
    inventory; swap converts USD at the live mark (get_mark_price contract).
    Below exchange minimum -> False (intentional skip).

    `exchange` is the target's routing from portfolio_config (passed through
    by reconcile when the wiring accepts it). Audit H3: if it names a
    DIFFERENT venue that is itself bound+official, this machine has two live
    venues and silently trading on the detected one is real money on the
    wrong exchange — loud-skip instead. A stale label (previous venue, keys
    gone — the normal state right after a rebind, fixed by the next amounts
    save) only warns and routes to the detected venue.

    self_ledger: a swap REDUCE leg is sized from the bot's own book, not the
    mark (_book_row / _book_reduce_qty); `sold` is the base an async execution
    already closed in earlier slices. The returned dict then also carries
    'unit_cost' (so a slicing caller counts progress in the book's USD, the
    unit signed_diff is in) and, when what is left of a full close can never
    be sold, 'writeoff': reason — with 'executed_qty': 0.0 and no order sent
    when there was nothing to send at all. Off, nothing here changes."""
    env = read_env()
    vid = detect_venue(env)
    if vid is None:
        _no_venue()
    if exchange and exchange != vid:
        if exchange in official_venues(env):
            msg = (f"target routed to {exchange} but this wiring is on {vid} — "
                   f"refusing to trade it on the wrong venue (re-save 下單設定 "
                   f"to re-route)")
            logging.error(f"[venue_wiring] {symbol}: {msg}")
            try:
                from lib.portfolio import _record_order_error
                _record_order_error(symbol, exchange, msg)
            except Exception:
                pass
            return False
        logging.warning(f"[venue_wiring] {symbol}: routing label {exchange!r} is "
                        f"not a bound official venue — using {vid} (label goes "
                        f"stale after a rebind; the next amounts save fixes it)")
    order = importlib.import_module(f"lib.order_{vid}")
    sym, market = split_key(symbol)
    cid = _cid()

    if market == "spot":
        if not hasattr(order, "place_spot_market_order"):
            raise RuntimeError(f"{vid} has no official spot layer — "
                               f"spot strategy cannot trade on it")
        base = _spot_base(sym)  # unknown quote raises — never trade blind (H1)
        if signed_diff > 0:
            result = order.place_spot_market_order(
                env, sym, "buy", quote_qty=abs(signed_diff), client_order_id=cid)
        else:
            price = order.get_spot_price(env, sym)
            held = order.get_spot_balances(env).get(base, 0.0)
            qty = min(abs(signed_diff) / price, held)
            row = _book_row(symbol, signed_diff)
            if row is not None and not row["legacy"]:
                # self_ledger: the bot's own coins at the book's rate, never
                # the wallet's (the wallet is the user's too) — see _book_row.
                # No lot rounding: the spot lib floors to its own precision.
                owned = max(0.0, row["owned"] - sold)
                want = owned if row["full"] else min(abs(signed_diff) / row["unit_cost"], owned)
                qty = min(want, held)
                # a wallet short of the book: believed on the second read only
                # (_account_short). Spot has no reduce-only order to let the
                # venue decide, so the first read sells what is there and waits.
                confirmed = owned > 0 and _account_short(symbol, held < owned * (1 - 1e-9))
                result = (order.place_spot_market_order(
                    env, sym, "sell", base_qty=qty, client_order_id=cid)
                    if qty > 0 else False)
                if result is False:
                    if not (row["full"] and owned > 0) or (held <= 0 and not confirmed):
                        return False
                    return {"executed_qty": 0.0, "exchange": vid,
                            "writeoff": "account holds none of it" if held <= 0
                            else "below the venue minimum"}
                placed = dict(result)
                placed["exchange"] = vid
                placed["unit_cost"] = row["unit_cost"]
                why = _book_writeoff(row, qty, held, 0.0,
                                     float(placed.get("executed_qty") or 0), sold, confirmed)
                if why:
                    placed["writeoff"] = why
                return placed
            result = order.place_spot_market_order(
                env, sym, "sell", base_qty=qty, client_order_id=cid)
    else:
        mark = order.get_mark_price(env, sym)
        qty = abs(signed_diff) / mark
        row = _book_row(symbol, signed_diff) if reduce_only else None
        if row is not None:
            direction = "long" if signed_diff < 0 else "short"
            confirmed = short_read = False
            if row["legacy"]:
                held = lot = None
                if row["full"]:
                    seen = _held_base(env, vid, sym, direction)
                    if seen is not None and _account_short(symbol, seen == 0):
                        return {"executed_qty": 0.0, "exchange": vid,
                                "writeoff": "account holds none of it"}
                qty = _reduce_qty(env, vid, order, sym, direction, qty)
            else:
                qty, held, lot, confirmed = _book_reduce_qty(
                    env, vid, order, sym, direction, signed_diff, row, sold, key=symbol)
                # an empty read not yet confirmed comes back as held=None
                short_read = held is None
                if qty <= 0:
                    why = _book_writeoff(row, qty, held, lot, 0.0, sold, confirmed)
                    return ({"executed_qty": 0.0, "exchange": vid, "writeoff": why}
                            if why else False)
        elif reduce_only:
            direction = "long" if signed_diff < 0 else "short"
            qty = _reduce_qty(env, vid, order, sym, direction, qty)
        else:
            direction = "long" if signed_diff > 0 else "short"
            qty = _entry_qty(order, env, sym, qty)
        try:
            result = order.place_market_order(env, sym, direction, qty,
                                              client_order_id=cid,
                                              reduce_only=reduce_only)
        except ValueError as e:
            # the older bingx lib RAISES below-min (predates the False-skip
            # contract). WHITELIST the min-size wording (audit M2): the same
            # type also carries real faults (missing keys, underivable
            # symbol) that must surface, not become a silent "skip".
            if "below" in str(e) or "floors to" in str(e):
                result = False
            else:
                raise
        if row is not None and not row["legacy"]:
            if result is False:
                # the venue will not take it, and on a full close never will —
                # said only with the account in view: without a believed read
                # (failed, or empty and unconfirmed) "nothing to reduce" and
                # "too small" look the same from here
                return ({"executed_qty": 0.0, "exchange": vid,
                         "writeoff": "below the venue minimum"}
                        if row["full"] and held is not None else False)
            placed = dict(result)
            placed["exchange"] = vid
            placed["unit_cost"] = row["unit_cost"]
            executed = float(placed.get("executed_qty") or 0)
            if short_read and executed > 0:
                # the venue filled what the read said was not there
                _account_short(symbol, False)
            why = _book_writeoff(row, qty, held, lot, executed, sold, confirmed)
            if why:
                placed["writeoff"] = why
            return placed
    if result is False:
        return False
    placed = dict(result)
    placed["exchange"] = vid
    return placed
