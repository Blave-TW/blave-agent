"""
Paper venue — simulated trading, no exchange, no keys.

Binding "paper" writes PAPER_API_KEY/PAPER_SECRET_KEY (fixed markers, not
secrets) + PAPER_BOUND_TS; this lib pair (order_paper + account_paper) then
makes the machine behave like any official venue — the reconciler, dispatch,
flatten, the web portfolio page and the equity curve run unchanged, only the
fills are simulated. Same surface as the other order libs (four reconciler
names + limit/spot/protective helpers, lib/guard built in).

PRICE (the whole model, Wei 2026-08-21):
  Fills use the price the STRATEGY sees, from the STRATEGY's own data source —
  resolved via lib/paper_data.current_price (see that module for why: adjusted
  vs raw prices, per-strategy endpoints). NOT an independent public feed.
  * one price per symbol (latest bar Close) — NO bid/ask, NO spread, NO
    slippage. Beginner-tier fidelity (Webull/TradingView do the same); fees are
    the one realism kept.
  * fills are IMMEDIATE at that price — no wait for the next bar (the live-paper
    convention, e.g. Freqtrade dry-run). Paper therefore diverges a little from
    the next-bar-open backtest; that is normal and a useful look-ahead check.
  * ONE USD account, any asset (product decision B). NOTIONAL positions need
    no FX: the reconciler sizes qty = USD ÷ price, so PnL = USD_notional ×
    (mark/entry − 1), a unitless return.
  * CONTRACT positions (Wei 2026-09-22): a strategy whose asset_spec.type is
    futures_contracts / shares is reconciled in whole lots, never notional —
    place_contract_market_order books `qty` as a LOT COUNT with the spec's
    contract_value (TXF 200 / MXF 50 / TMF 10; shares 1), PnL = lots ×
    contract_value × Δprice, and the position row carries unit "contracts" so
    the wiring reports lots back. One symbol holds one unit: a contract fill
    on a notional position (or the reverse) is refused. Notional positions
    have no leverage cap (Wei 2026-10-03: no hard limit, the UI only warns —
    there is no liquidation model either, so paper results can look better
    than a real account at high leverage). Contract positions are checked on
    lots × the spec's `margin` (TAIFEX initial margin, written with the spec by
    the platform) against equity itself (1×, as a broker would).
  * CONTRACT money is in the contract's currency (TXF: lots × 200 × Δindex is
    TWD), so it is converted at the fill: realized PnL and fee ÷ the USD rate
    (lib/paper_data.usd_rate) before they reach cash; open-position PnL and
    margin ÷ the current rate whenever equity is computed. The row keeps
    quote_ccy, the native-unit entry/margin, and `fx` = the last rate it used.
    A TWD entry with no rate is refused; a reduce falls back to the row's own
    `fx`. Rows opened before this existed (no quote_ccy) are stamped on the
    first read that has a rate; cash already booked unconverted stays as is.
  * TW STOCKS (0.1.27) are TWD-priced: the amount is TWD, so a notional qty is
    shares and its PnL / fee — and a spot row's cost / proceeds (`2330@spot`
    is inventory of the code itself) — go through the same rate. Like the
    exchange (Wei 10-17): every TW stock order — closes, SL/TP and close-all
    included — waits for the TWSE session (paper_data.tw_session_open;
    PaperMarketClosed), quantities are whole shares floored (0 → no order;
    a full close takes a legacy fractional row whole), and nothing goes
    short: a sell past the long closes it, a short from flat is refused.

Contract rules are permissive (fetch_data gives OHLC, not an instrument spec):
no min-qty / min-notional / step gating — the reconciler's own slice threshold
is the floor. Positions are tracked as base-qty + entry (qty is USD÷price, a
notional-derived number; never floored to a crypto step).

Ledger: state/paper_ledger.json (atomic writes, flock on POSIX / msvcrt on
Windows). Seeded with PAPER_INITIAL_EQUITY (.env, default 100,000 USDT); a ledger
older than PAPER_BOUND_TS is re-seeded, so unbind→rebind is a fresh start.
reset_account(env) wipes and re-seeds — agent runs it on explicit user request
only. Reduce/close legs are NEVER refused by the equity/margin checks.
"""
import json
import logging
import math
import os
import threading
import time

from lib import guard
try:
    from lib.winreplace import atomic_replace
except ImportError:  # half-updated workspace (lib/winreplace.py not landed): plain replace
    atomic_replace = os.replace
try:
    from lib import reject_token
except ImportError:  # half-updated workspace (lib/reject_token.py not landed): orders work, messages go out untagged
    from types import SimpleNamespace as _NS
    reject_token = _NS(tag=lambda kind, msg: str(msg), from_code=lambda *a, **k: None, credential_codes=lambda v: frozenset(),
                       **{k: k.lower() for k in ("INSUFFICIENT_MARGIN", "BELOW_MIN_SIZE", "SYMBOL_UNAVAILABLE",
                                                 "KEY_PERMISSION", "REDUCE_ONLY_REJECTED", "PAPER_MARGIN")})

guard.mark_money_process()  # Stop in the chat never kills this process (lib/guard)
from lib.paper_data import current_price, PaperNoPrice
try:
    from lib.paper_data import PaperNoFx, quote_ccy, usd_rate
except ImportError:  # half-updated workspace (lib/paper_data.py without FX): contract money unconverted, as before
    class PaperNoFx(PaperNoPrice):
        pass

    def quote_ccy(symbol, declared=None):
        return "USD"

    def usd_rate(ccy, env, max_age=None):
        if str(ccy or "USD").upper() in ("USD", "USDT", "USDC"):
            return 1.0
        raise PaperNoFx(f"lib/paper_data.py has no FX — update the workspace")

try:
    from lib.paper_data import is_tw_stock, tw_session_open
except ImportError:  # half-updated workspace (lib/paper_data.py without TW stocks): no session rule
    def is_tw_stock(symbol):
        return False

    def tw_session_open(env=None, now=None):
        return True

try:
    import fcntl
except ImportError:  # Windows
    fcntl = None
try:
    import msvcrt
except ImportError:  # POSIX
    msvcrt = None

VENUE = "paper"
LEDGER_PATH = "state/paper_ledger.json"
LOCK_PATH = "state/paper_ledger.lock"
DEFAULT_CASH = 100_000.0  # new ledgers only — an existing ledger keeps its initial_cash
TAKER_FEE = 0.0005   # market / crossing-limit / protective-trigger
MAKER_FEE = 0.0002   # resting-limit fill
SPOT_FEE = 0.001     # spot both sides
MAX_FILLS = 500
MAX_CLOSED_ORDERS = 1000

log = logging.getLogger("order_paper")


class PaperError(Exception):
    """Simulated-venue refusal with a readable reason."""


# ── price (from the strategy's own data source) ──────────────────────────────

def _price(env, symbol, cache=None):
    """Current price for symbol via lib/paper_data (the strategy's fetch_data).
    Optional per-operation cache dict avoids re-fetching one symbol twice in a
    single fill/mark. Raises PaperError (not a silent 0) when unpriceable."""
    if cache is not None and symbol in cache:
        return cache[symbol]
    try:
        px, _ = current_price(symbol, env)
    except PaperNoPrice as e:
        raise PaperError(str(e))
    px = float(px)
    if not (px > 0):
        raise PaperError(f"non-positive price for {symbol}: {px}")
    if cache is not None:
        cache[symbol] = px
    return px


def get_mark_price(env, symbol):
    """Cross-venue wiring contract: current price for USD→qty conversion."""
    return _price(env, symbol)


def get_spot_price(env, symbol):
    return _price(env, symbol)


def get_bbo(env, symbol):
    """No real book — bid == ask == mark (paper has no spread). Kept so the
    chase/limit layer has a uniform interface."""
    p = _price(env, symbol)
    return {"bid": p, "ask": p}


def get_spot_bbo(env, symbol):
    p = _price(env, symbol)
    return {"bid": p, "ask": p}


# Permissive rules — fetch_data is OHLC only, there is no instrument spec, and
# a notional-derived qty must never be floored to a crypto step. The
# reconciler's own USD slice threshold is the real floor.
_OPEN_RULES = {"step": "0.00000001", "min_qty": 0.0, "min_notional": 0.0,
               "contract_value": 1.0, "price_tick": "0.00000001", "active": True}


def get_contract_rules(env, symbol):
    return dict(_OPEN_RULES)


def get_spot_rules(env, symbol):
    return dict(_OPEN_RULES)


def format_qty(env, symbol, qty, price=None):
    """No min gate (permissive rules) — return the qty string. Non-positive →
    empty (the caller's min-size skip contract)."""
    q = float(qty)
    return repr(q) if q > 0 else ""


def format_spot_qty(env, symbol, qty):
    q = float(qty)
    return repr(q) if q > 0 else ""


def _spot_base(sym):
    if is_tw_stock(sym):
        return sym  # a TW share is its own inventory, quoted in TWD (quote_ccy)
    for q in ("USDT", "USDC"):
        if sym.endswith(q) and len(sym) > len(q):
            return sym[: -len(q)]
    raise PaperError(reject_token.tag(reject_token.SYMBOL_UNAVAILABLE, f"paper spot supports USDT/USDC quotes and TW stocks only, got {sym}"))


class PaperMarketClosed(PaperError):
    """A TW stock order outside the TWSE session — closes included, as at the
    exchange. manager/flatten defers such a close to the first round after
    the open (lib.portfolio.defer_paper_tw_close); the reconciler holds the
    rows quietly (lib.portfolio._paper_tw_closed_keys)."""


def _check_session(env, sym):
    if is_tw_stock(sym) and not tw_session_open(env):
        raise PaperMarketClosed(f"{sym}: 台股休市中(交易時段 09:00–13:30)— paper order refused "
                                f"outside the TWSE session")


def _tw_signed(led, sym, signed):
    """A TW stock fill in whole shares, floored, never short: a sell past the
    long is cut to closing it, a short from flat (or adding to a legacy short)
    is refused. A fill that flattens the row exactly keeps its fraction, so a
    row booked before whole shares can still be closed. 0 = nothing to send."""
    if not signed or not is_tw_stock(sym):
        return signed
    q0 = float(led["positions"].get(sym, {}).get("qty", 0))
    if q0 + signed < -1e-9:
        if q0 <= 1e-12:
            raise PaperError(f"{sym}: 台股不能放空 — paper refuses a TW stock short")
        signed = -q0
    if abs(q0 + signed) < 1e-9:
        return signed
    return math.copysign(math.floor(abs(signed) + 1e-9), signed)


# ── ledger ───────────────────────────────────────────────────────────────────

_plock = threading.RLock()


def _initial_cash(env):
    try:
        v = float((env or {}).get("PAPER_INITIAL_EQUITY") or DEFAULT_CASH)
    except (TypeError, ValueError):
        v = DEFAULT_CASH
    return v if v > 0 else DEFAULT_CASH


def _new_ledger(env):
    cash = _initial_cash(env)
    return {"version": 2, "created_ts": int(time.time()), "initial_cash": cash,
            "cash": cash, "positions": {}, "spot": {}, "orders": {},
            "protective": {}, "fills": [], "seq": 0}


def _bound_ts(env):
    try:
        return int(float((env or {}).get("PAPER_BOUND_TS") or 0))
    except (TypeError, ValueError):
        return 0


def _load(env):
    bound_ts = _bound_ts(env)
    try:
        with open(LEDGER_PATH) as f:
            led = json.load(f)
        if isinstance(led, dict) and "cash" in led:
            for k in ("positions", "spot", "orders", "protective"):
                led.setdefault(k, {})
            led.setdefault("fills", [])
            led.setdefault("seq", 0)
            if bound_ts <= int(led.get("created_ts") or 0):
                return led
            log.info("paper ledger predates the current bind — re-seeding")
            guard.audit("paper_reseed", venue=VENUE, reason="rebind",
                        old_created_ts=led.get("created_ts"), bound_ts=bound_ts)
        else:
            log.error("paper ledger malformed — re-seeding")
    except FileNotFoundError:
        pass
    except (OSError, ValueError) as e:
        raise PaperError(f"paper ledger unreadable ({type(e).__name__}: {e})")
    fresh = _new_ledger(env)
    fresh["created_ts"] = max(fresh["created_ts"], bound_ts)  # clock-skew guard
    return fresh


def _save(led):
    os.makedirs(os.path.dirname(LEDGER_PATH), exist_ok=True)
    tmp = LEDGER_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(led, f, indent=1)
    atomic_replace(tmp, LEDGER_PATH)


class _txn:
    """Exclusive read-modify-write on the ledger; nothing persists if the block
    raises (a refused order leaves no trace beyond the audit log)."""

    def __init__(self, env):
        self.env = env
        self.fh = None

    def __enter__(self):
        _plock.acquire()
        try:
            if fcntl is not None or msvcrt is not None:
                os.makedirs(os.path.dirname(LOCK_PATH), exist_ok=True)
                self.fh = open(LOCK_PATH, "a+")
                if fcntl is not None:
                    fcntl.flock(self.fh, fcntl.LOCK_EX)
                else:
                    deadline = time.time() + 60
                    while True:
                        try:
                            msvcrt.locking(self.fh.fileno(), msvcrt.LK_LOCK, 1)
                            break
                        except OSError:
                            if time.time() > deadline:
                                raise PaperError("paper ledger lock timeout (60s)")
            self.led = _load(self.env)
            return self.led
        except Exception:
            self._release()
            raise

    def __exit__(self, et, ev, tb):
        # audits queued inside the block describe ledger changes — written only
        # once those changes are saved, so a refused order can't log them twice
        pending = self.led.pop("_after_save", []) if isinstance(getattr(self, "led", None), dict) else []
        try:
            if et is None:
                _save(self.led)
                for event, fields in pending:
                    guard.audit(event, **fields)
        finally:
            self._release()

    def _release(self):
        try:
            if self.fh is not None:
                if fcntl is not None:
                    fcntl.flock(self.fh, fcntl.LOCK_UN)
                else:
                    try:
                        msvcrt.locking(self.fh.fileno(), msvcrt.LK_UNLCK, 1)
                    except OSError:
                        pass
                self.fh.close()
                self.fh = None
        finally:
            _plock.release()


def _next_id(led):
    led["seq"] = int(led.get("seq", 0)) + 1
    return f"P{led['seq']:08d}"


def _find_order(led, order_id=None, client_order_id=None):
    if order_id and str(order_id) in led["orders"]:
        return led["orders"][str(order_id)]
    if client_order_id:
        for o in led["orders"].values():
            if o.get("client_order_id") == client_order_id:
                return o
    return None


def _prune(led):
    closed = [o for o in led["orders"].values() if o["status"] != "open"]
    if len(closed) > MAX_CLOSED_ORDERS:
        closed.sort(key=lambda o: o.get("ts", 0))
        for o in closed[: len(closed) - MAX_CLOSED_ORDERS]:
            led["orders"].pop(o["order_id"], None)


def _record_fill(led, o, qty, price, fee, realized=0.0, kind=None):
    o["executed_qty"] = float(o.get("executed_qty") or 0) + qty
    o["avg_price"] = price
    o["commission"] = float(o.get("commission") or 0) + fee
    o["status"] = "filled"
    o["fill_ts"] = int(time.time())
    led["fills"].append({"ts": o["fill_ts"], "order_id": o["order_id"],
                         "symbol": o["symbol"], "market": o["market"],
                         "side": o["side"], "qty": qty, "price": price, "fee": fee,
                         "realized": realized, "kind": kind or o["type"]})
    if o.get("quote_ccy") and o["quote_ccy"] != "USD":  # realized/fee above are USD
        led["fills"][-1].update(ccy=o["quote_ccy"], fx=o.get("fx"))
    del led["fills"][:-MAX_FILLS]


def _new_order(led, sym, market, side, typ, price, qty, cid, reduce_only=False,
               direction=None, post_only=False):
    oid = _next_id(led)
    o = {"order_id": oid, "client_order_id": cid or "", "symbol": sym, "market": market,
         "side": side, "direction": direction, "type": typ, "price": price,
         "orig_qty": qty, "executed_qty": 0.0, "avg_price": 0.0, "commission": 0.0,
         "status": "open", "reduce_only": bool(reduce_only), "post_only": bool(post_only),
         "ts": int(time.time())}
    led["orders"][oid] = o
    return o


# ── position math (base qty + entry; PnL = qty × Δprice = notional × return) ──

def _cv(pos):
    return float((pos or {}).get("contract_value") or 1.0)


def _row_ccy(sym, pos):
    return (pos or {}).get("quote_ccy") or quote_ccy(sym)


def _row_fx(env, sym, pos):
    """USD rate for a held row's money — a contract row, or a notional row on
    a TWD-priced symbol (a TW stock: qty is shares, so qty × Δprice is TWD).
    No live/disk rate → the row's own last `fx`; a pre-FX row that has never
    had one → 1.0, the old unconverted behaviour, kept only until the first
    rate arrives."""
    ccy = _row_ccy(sym, pos)
    if ccy == "USD":
        return 1.0
    try:
        return usd_rate(ccy, env)
    except PaperNoFx:
        fx = (pos or {}).get("fx")
        if fx:
            return float(fx)
        log.warning(f"paper {sym}: no USD rate yet — valued unconverted")
        return 1.0


def _fill_fx(env, led, sym, currency, adding):
    """(ccy, rate) for a contract fill. The held row's currency wins over the
    caller's; an exposure-adding fill without a rate is refused (PaperError),
    a reduce takes _row_fx's fallbacks."""
    pos = led["positions"].get(sym)
    if pos and float(pos.get("qty") or 0) != 0:
        ccy = _row_ccy(sym, pos)
        # a reduce takes the row's own currency, so a mislabelled row can still be closed
        if adding and currency and quote_ccy(sym, currency) != ccy:
            raise PaperError(f"{sym}: position is held in {ccy} — a "
                             f"{quote_ccy(sym, currency)} fill cannot be netted into it")
    else:
        pos, ccy = None, quote_ccy(sym, currency)
    if ccy == "USD":
        return ccy, 1.0
    if not adding and pos is not None:
        return ccy, _row_fx(env, sym, pos)
    try:
        return ccy, usd_rate(ccy, env)
    except PaperNoFx as e:
        raise PaperError(str(e))


def _adds(led, sym, signed):
    q0 = float(led["positions"].get(sym, {}).get("qty", 0))
    return abs(q0 + signed) > abs(q0) + 1e-12


def _cap_reduce(led, sym, signed):
    q0 = float(led["positions"].get(sym, {}).get("qty", 0))
    if q0 == 0 or (q0 > 0) == (signed > 0):
        return 0.0
    return -q0 if abs(signed) > abs(q0) else signed


def _pos_mark(env, led, sym, marks):
    """Mark price for a HELD position, tolerant of a symbol that lost its price
    source (e.g. its strategy was deleted → resolver can't price it). Falls
    back to the last fill price (entry) so one un-priceable position can never
    take the whole account read down (audit P1-2) — nor block flattening it.
    Returns (mark, priced) where priced=False means the entry fallback was used
    (unrealized PnL for that leg is then 0)."""
    try:
        return _price(env, sym, marks), True
    except PaperError:
        return float(led["positions"].get(sym, {}).get("entry") or 0.0), False


def _equity(env, led, marks):
    """cash + unrealized swap PnL + spot inventory at mark. marks caches
    per-symbol prices for this operation."""
    upnl = 0.0
    for sym, p in led["positions"].items():
        mark, _ = _pos_mark(env, led, sym, marks)
        upnl += (mark - p["entry"]) * p["qty"] * _cv(p) / _row_fx(env, sym, p)
    spot_value = 0.0
    prices = {}
    for asset, amt in led["spot"].items():
        if amt <= 0:
            continue
        try:
            px = _price(env, _spot_pair(asset), marks)
            rate = _spot_fx(env, asset, fallback=led.get("spot_fx", {}).get(asset))
        except PaperError:
            px = rate = None  # unpriceable — listed by holdings, valued None
        prices[asset] = (px, rate)
        if px:
            spot_value += amt * px / rate
    return led["cash"] + upnl + spot_value, upnl, spot_value, prices


def _spot_pair(asset):
    return asset if is_tw_stock(asset) else asset + "USDT"


def _spot_fx(env, asset, fallback=None):
    """USD rate for a spot asset's quote: 1.0 for a USDT pair, the TWD rate for
    a TW share. No rate → `fallback` (a sell's own last rate) or PaperError."""
    if not is_tw_stock(asset):
        return 1.0
    try:
        return usd_rate("TWD", env)
    except PaperNoFx as e:
        if fallback:
            return float(fallback)
        raise PaperError(str(e))


def _apply_swap_fill(env, led, sym, signed_qty, price, fee, marks, contract_value=None,
                     margin=None, fx=None):
    """Net one-way position update; returns realized PnL. Only exposure-adding
    fills are checked against equity and contract margin (computed on the
    would-be state, committed only if it passes). Reduce/close never refused — no liquidation
    model, so a blown account must still be flatten-able.

    contract_value: set for a CONTRACT fill (signed_qty is lots; see module
    docstring) — the position then carries it and unit "contracts". None = a
    notional fill (qty in base units, value 1). The two never mix on one
    symbol: the held position's unit decides, and a fill in the other unit is
    refused rather than summed lots with coins. `margin` (per lot) rides
    with contract_value and is what the leverage check counts for the row.
    fx=(ccy, rate) from _fill_fx on a contract fill: realized is booked ÷ rate
    (the caller's `fee` is already USD); None = USD."""
    pos = led["positions"].get(sym, {"qty": 0.0, "entry": 0.0})
    held_cv = _cv(pos) if pos.get("unit") == "contracts" else None
    if float(pos["qty"]) != 0 and (held_cv is None) != (contract_value is None):
        raise PaperError(f"{sym}: position is held in "
                         f"{'contracts' if held_cv else 'notional'} — a "
                         f"{'notional' if held_cv else 'contract'} fill cannot be netted into it")
    if held_cv is not None and contract_value is not None and held_cv != float(contract_value):
        raise PaperError(f"{sym}: contract_value {contract_value} differs from the held "
                         f"position's {held_cv}")
    cv = float(contract_value) if contract_value is not None else 1.0
    q0, e0 = float(pos["qty"]), float(pos["entry"])
    q1 = q0 + signed_qty
    realized = 0.0
    if q0 == 0 or (q0 > 0) == (signed_qty > 0):
        entry = (abs(q0) * e0 + abs(signed_qty) * price) / abs(q1)
    else:
        closed = min(abs(q0), abs(signed_qty))
        realized = (price - e0) * closed * cv * (1 if q0 > 0 else -1)
        entry = price if abs(signed_qty) > abs(q0) else e0
    if fx is None:
        fx = _fill_fx(env, led, sym, None, abs(q1) > abs(q0))
    ccy, rate = fx or ("USD", 1.0)
    realized /= rate
    new_cash = led["cash"] + realized - fee
    new_positions = dict(led["positions"])
    if abs(q1) < 1e-12:
        new_positions.pop(sym, None)
    else:
        new_positions[sym] = {"qty": q1, "entry": entry}
        if contract_value is None and ccy != "USD":
            new_positions[sym].update(quote_ccy=ccy, fx=rate)
        if contract_value is not None:
            new_positions[sym].update(unit="contracts", contract_value=cv,
                                      margin=float(margin or pos.get("margin") or 0),
                                      quote_ccy=ccy, fx=rate)
    if abs(q1) > abs(q0) + 1e-12:
        marks.setdefault(sym, price)
        trial = dict(led, cash=new_cash, positions=new_positions)
        equity, _, _, _ = _equity(env, trial, marks)
        if equity <= 0:
            raise PaperError("paper account equity would be <= 0 — refused "
                             "(reset_account to start over)")
        # contract lots are margin-checked; notional has no cap (see docstring)
        margin_used = sum(abs(p["qty"]) * float(p.get("margin") or 0) / _row_fx(env, s, p)
                          for s, p in new_positions.items() if p.get("unit") == "contracts")
        if margin_used > equity + 1e-9:  # 1×: margin must be covered, as at a broker
            raise PaperError(reject_token.tag(reject_token.PAPER_MARGIN, f"contract margin {margin_used:.0f} exceeds paper equity "
                             f"{equity:.0f} — refused"))
    led["cash"] = new_cash
    led["positions"] = new_positions
    if sym not in new_positions:
        led["protective"].pop(sym, None)
    return realized


def _fill_spot(led, o, base_qty, price, fee_rate, env=None):
    """Cost, proceeds and fee ÷ the quote's USD rate before they touch the USD
    cash (a TW share's are TWD); the fill records them in USD."""
    base = _spot_base(o["symbol"])
    rate = _spot_fx(env, base, fallback=None if o["side"] == "buy" else led.get("spot_fx", {}).get(base))
    if rate != 1.0:
        o.update(quote_ccy="TWD", fx=rate)
        led.setdefault("spot_fx", {})[base] = rate
    if o["side"] == "buy":
        cost = base_qty * price / rate
        fee = cost * fee_rate
        if led["cash"] < cost + fee:
            raise PaperError(reject_token.tag(reject_token.INSUFFICIENT_MARGIN, f"insufficient paper cash for {o['symbol']} buy "
                             f"({led['cash']:.2f} < {cost + fee:.2f})"))
        led["cash"] -= cost + fee
        led["spot"][base] = led["spot"].get(base, 0.0) + base_qty
    else:
        held = led["spot"].get(base, 0.0)
        if base_qty > held + 1e-12:
            raise PaperError(reject_token.tag(reject_token.INSUFFICIENT_MARGIN, f"insufficient {base} to sell ({held} < {base_qty})"))
        proceeds = base_qty * price / rate
        fee = proceeds * fee_rate
        led["cash"] += proceeds - fee
        left = held - base_qty
        if left <= 1e-12:
            led["spot"].pop(base, None)
            led.get("spot_fx", {}).pop(base, None)
        else:
            led["spot"][base] = left
    _record_fill(led, o, base_qty, price, fee)
    return fee


# ── lazy settlement (resting limits + protective triggers) ───────────────────

_TERMINAL_FILLED = {"filled"}
_TERMINAL_GONE = {"canceled", "cancelled", "rejected", "expired"}


def _norm_status(raw):
    s = str(raw or "").lower()
    if s in _TERMINAL_FILLED:
        return "filled"
    if s in _TERMINAL_GONE:
        return "canceled"
    if s == "post_only_rejected":
        return "post_only_rejected"
    return "open"


def _stamp_pre_fx_rows(env, led, marks):
    """A contract row opened before contract money was converted, or a TW
    stock row opened while paper booked it unconverted, has no quote_ccy, and
    its open PnL was being added to the USD account in TWD.
    Stamp it the first time a rate is available — from here on it is valued
    ÷ rate, which moves equity once by upnl × (1 − 1/rate); that move is
    audited (paper_fx_cutover). Cash already booked is not restated."""
    for sym, p in led["positions"].items():
        if p.get("quote_ccy"):
            continue
        contracts = p.get("unit") == "contracts"
        ccy = quote_ccy(sym)
        if ccy == "USD":
            if contracts:
                p.update(quote_ccy=ccy, fx=1.0)
            continue
        try:
            rate = usd_rate(ccy, env)
        except PaperNoFx:
            continue
        mark, priced = _pos_mark(env, led, sym, marks)
        upnl = (mark - p["entry"]) * p["qty"] * _cv(p) if priced else 0.0
        p.update(quote_ccy=ccy, fx=rate)
        led.setdefault("_after_save", []).append(("paper_fx_cutover", dict(
            venue=VENUE, symbol=sym, ccy=ccy, fx=rate, lots=p["qty"],
            upnl_native=round(upnl, 2), equity_change_usd=round(upnl / rate - upnl, 2))))


def _settle(env, led):
    """Fill resting limits the mark has reached; fire protective triggers the
    mark has crossed. Called at the top of every ledger transaction, so a read
    is the matching cadence."""
    _prune(led)
    marks = {}
    _stamp_pre_fx_rows(env, led, marks)
    for o in list(led["orders"].values()):
        if o["status"] != "open":
            continue
        sym = o["symbol"]
        if is_tw_stock(sym) and not tw_session_open(env):
            continue  # the exchange matches nothing outside the session
        try:
            mark = _price(env, sym, marks)
        except PaperError:
            continue  # can't price this tick — leave the order resting
        px = float(o["price"])
        touched = (mark <= px) if o["side"] == "buy" else (mark >= px)
        if not touched:
            continue
        qty = float(o["orig_qty"])
        # A RESTING (maker) order fills at its own limit price, not the mark:
        # the mark has just crossed through px, so filling at the more-favourable
        # mark would hand the trader a better price than they asked for (audit
        # P2). You get the price you posted.
        fill_px = px
        if o["market"] == "spot":
            try:
                _fill_spot(led, o, qty, fill_px, SPOT_FEE, env=env)
            except PaperError as e:
                o["status"] = "canceled"
                o["reason"] = str(e)
            continue
        signed = qty if o["side"] == "buy" else -qty
        if o.get("reduce_only"):
            signed = _cap_reduce(led, sym, signed)
            if signed == 0:
                o["status"] = "canceled"
                o["reason"] = "nothing left to reduce"
                continue
        try:
            signed = _tw_signed(led, sym, signed)
            if signed == 0:
                o["status"] = "canceled"
                o["reason"] = "under one share"
                continue
            fx = _fill_fx(env, led, sym, None, _adds(led, sym, signed))
            fee = abs(signed) * fill_px * MAKER_FEE / fx[1]
            realized = _apply_swap_fill(env, led, sym, signed, fill_px, fee, marks, fx=fx)
        except PaperError as e:
            o["status"] = "canceled"
            o["reason"] = str(e)
            continue
        _record_fill(led, o, abs(signed), fill_px, fee, realized)
    for sym, trig in list(led["protective"].items()):
        pos = led["positions"].get(sym)
        if not pos:
            led["protective"].pop(sym, None)
            continue
        if is_tw_stock(sym) and not tw_session_open(env):
            continue  # a stop on a TW stock triggers in the session, as at the exchange
        try:
            mark = _price(env, sym, marks)
        except PaperError:
            continue
        long = pos["qty"] > 0
        sl, tp = trig.get("sl"), trig.get("tp")
        hit = None
        if sl and ((long and mark <= sl) or (not long and mark >= sl)):
            hit = "sl"
        elif tp and ((long and mark >= tp) or (not long and mark <= tp)):
            hit = "tp"
        if not hit:
            continue
        signed = -pos["qty"]
        cv = _cv(pos) if pos.get("unit") == "contracts" else None
        fx = _fill_fx(env, led, sym, None, False)
        fee = abs(signed) * mark * (cv or 1.0) * TAKER_FEE / fx[1]
        o = _new_order(led, sym, "swap", "sell" if long else "buy", "market", mark,
                       abs(signed), None, reduce_only=True,
                       direction="long" if long else "short")
        if cv is not None:
            o.update(unit="contracts", contract_value=cv)
        if cv is not None or fx[0] != "USD":
            o.update(quote_ccy=fx[0], fx=fx[1])
        realized = _apply_swap_fill(env, led, sym, signed, mark, fee, marks, contract_value=cv,
                                    fx=fx)
        _record_fill(led, o, abs(signed), mark, fee, realized, kind=hit)
        led["protective"].pop(sym, None)
        guard.audit("order_ok", venue=VENUE, symbol=sym, intent="protective",
                    kind=hit, qty=abs(signed), price=mark, order_id=o["order_id"])


# ── guard gate ───────────────────────────────────────────────────────────────

def _gate(intent, **fields):
    fields["venue"] = VENUE
    fields["intent"] = intent
    guard.check_restart_stop(intent, fields)
    guard.check_account_hold("paper", intent, fields)
    if intent == "entry" and guard.entry_blocked():
        guard.audit("order_denied_halt", **fields)
        raise guard.Halted(
            f"state/HALT is set ({guard.halt_info()}) — paper entry order for "
            f"{fields.get('symbol')} refused. Closes, SL/TP and cancels still work. "
            f"Only the user may clear the halt (guard.clear_halt).")
    guard.audit("order_attempt", **fields)
    return fields


def _order_view(o):
    return {"order_id": o["order_id"], "status": o["status"],
            "avg_price": float(o.get("avg_price") or 0),
            "orig_qty": float(o.get("orig_qty") or 0),
            "executed_qty": float(o.get("executed_qty") or 0),
            "quote_qty": (float(o.get("executed_qty") or 0) * float(o.get("avg_price") or 0)
                          * float(o.get("contract_value") or 1)),
            "commission": float(o.get("commission") or 0), "commission_asset": "USDT",
            "client_order_id": o.get("client_order_id") or "", "raw": dict(o)}


def _fill_view(o):
    v = _order_view(o)
    v["exchange"] = VENUE
    return v


# ── swap layer (reconciler contract) ─────────────────────────────────────────

def place_market_order(env, symbol, direction, qty, client_order_id=None,
                       reduce_only=False):
    """Confirmed simulated market order: whole qty at the current price (no
    spread). Same client_order_id → the earlier fill (idempotent)."""
    guard.arm_restore(symbol, direction, qty, reduce_only)  # HALT's one netted-restore pass
    sym = str(symbol).upper()
    if direction not in ("long", "short"):
        raise ValueError(f"direction must be long|short, got {direction!r}")
    if float(qty) <= 0:
        return False
    buy = (direction == "long") != bool(reduce_only)
    side = "buy" if buy else "sell"
    fields = _gate("reduce" if reduce_only else "entry", symbol=sym, side=side,
                   qty=float(qty), client_order_id=client_order_id or "")
    try:
        with _txn(env) as led:
            _settle(env, led)
            prev = _find_order(led, client_order_id=client_order_id) if client_order_id else None
            if prev is not None:
                return _fill_view(prev) if prev["status"] == "filled" else False
            marks = {}
            # An entry must fail loud if the symbol can't be priced (never open
            # at a made-up price); a reduce/close must ALWAYS go through — even
            # if the price source vanished (deleted strategy) — so it falls back
            # to the position's entry (audit P1-2: a position must never become
            # un-flattenable).
            if reduce_only:
                price = _pos_mark(env, led, sym, marks)[0]
                if not price:
                    price = _price(env, sym, marks)  # no position/entry → surface the real error
            else:
                price = _price(env, sym, marks)
            signed = float(qty) if buy else -float(qty)
            if reduce_only:
                signed = _cap_reduce(led, sym, signed)
                if signed == 0:
                    guard.audit("order_ok", order_id="", note="nothing to reduce", **fields)
                    return False
            _check_session(env, sym)
            signed = _tw_signed(led, sym, signed)
            if signed == 0:
                guard.audit("order_ok", order_id="", note="under one share", **fields)
                return False
            fx = _fill_fx(env, led, sym, None, _adds(led, sym, signed))
            fee = abs(signed) * price * TAKER_FEE / fx[1]
            o = _new_order(led, sym, "swap", side, "market", price, abs(signed),
                           client_order_id, reduce_only=reduce_only, direction=direction)
            if fx[0] != "USD":
                o.update(quote_ccy=fx[0], fx=fx[1])
            realized = _apply_swap_fill(env, led, sym, signed, price, fee, marks, fx=fx)
            _record_fill(led, o, abs(signed), price, fee, realized)
            guard.audit("order_ok", order_id=o["order_id"], price=price, **fields)
            return _fill_view(o)
    except guard.Halted:
        raise
    except Exception as e:
        guard.audit("order_error", error=str(e), **fields)
        raise


def place_contract_market_order(env, symbol, direction, lots, contract_value,
                                client_order_id=None, reduce_only=False, margin=None,
                                currency=None):
    """Simulated market order in WHOLE LOTS (asset_spec.type futures_contracts /
    shares — see module docstring). `lots` is a positive integer count; a
    reduce leg is capped at the held lots (never flips through zero). Fee is
    taker on lots × price × contract_value. `margin` (initial margin per lot,
    required on an entry — the leverage check counts it; a reduce leg needs
    none). `currency` = the spec's currency of that money (None → inferred,
    paper_data.quote_ccy; a held row's own wins). Same idempotency as
    place_market_order. Returns the fill view with executed_qty in lots."""
    sym = str(symbol).upper()
    if direction not in ("long", "short"):
        raise ValueError(f"direction must be long|short, got {direction!r}")
    lots = int(lots)
    if lots <= 0:
        return False
    cv = float(contract_value or 0)
    if not cv > 0:
        raise ValueError(f"{sym}: contract_value must be positive, got {contract_value!r}")
    mg = float(margin or 0)
    if not reduce_only and not mg > 0:
        raise ValueError(f"{sym}: margin (initial margin per lot) must be positive on an "
                         f"entry, got {margin!r}")
    buy = (direction == "long") != bool(reduce_only)
    side = "buy" if buy else "sell"
    fields = _gate("reduce" if reduce_only else "entry", symbol=sym, side=side,
                   qty=float(lots), unit="contracts", contract_value=cv,
                   client_order_id=client_order_id or "")
    try:
        with _txn(env) as led:
            _settle(env, led)
            prev = _find_order(led, client_order_id=client_order_id) if client_order_id else None
            if prev is not None:
                return _fill_view(prev) if prev["status"] == "filled" else False
            marks = {}
            if reduce_only:
                price = _pos_mark(env, led, sym, marks)[0]
                if not price:
                    price = _price(env, sym, marks)
            else:
                price = _price(env, sym, marks)
            signed = float(lots) if buy else -float(lots)
            if reduce_only:
                signed = _cap_reduce(led, sym, signed)
                if signed == 0:
                    guard.audit("order_ok", order_id="", note="nothing to reduce", **fields)
                    return False
            q0 = float(led["positions"].get(sym, {}).get("qty") or 0)
            _check_session(env, sym)
            signed = _tw_signed(led, sym, signed)
            if signed == 0:
                guard.audit("order_ok", order_id="", note="under one share", **fields)
                return False
            refused_open = 0.0
            try:
                fx = _fill_fx(env, led, sym, currency, abs(q0 + signed) > abs(q0))
            except PaperError:
                if not (q0 and (q0 > 0) != (signed > 0) and abs(signed) > abs(q0)):
                    raise
                # flip with no rate for the new leg: close what is held (the
                # row's own fx), refuse only the opening part
                refused_open, signed = abs(signed) - abs(q0), -q0
                fx = _fill_fx(env, led, sym, currency, False)
            fee = abs(signed) * price * cv * TAKER_FEE / fx[1]
            o = _new_order(led, sym, "swap", side, "market", price, abs(signed),
                           client_order_id, reduce_only=reduce_only, direction=direction)
            o.update(unit="contracts", contract_value=cv, quote_ccy=fx[0], fx=fx[1])
            realized = _apply_swap_fill(env, led, sym, signed, price, fee, marks,
                                        contract_value=cv, margin=mg or None, fx=fx)
            _record_fill(led, o, abs(signed), price, fee, realized)
            guard.audit("order_ok", order_id=o["order_id"], price=price, **fields)
            if refused_open:
                guard.audit("order_error", error=f"opening {refused_open:g} lot(s) refused: "
                            f"no USD rate for {fx[0]}", **fields)
            return _fill_view(o)
    except guard.Halted:
        raise
    except Exception as e:
        guard.audit("order_error", error=str(e), **fields)
        raise


def close_position_partial(env, symbol, direction, qty, client_order_id=None):
    return place_market_order(env, symbol, direction, qty,
                              client_order_id=client_order_id, reduce_only=True)


def place_limit_order(env, symbol, direction, qty, price, client_order_id=None,
                      reduce_only=False, time_in_force="GTC", post_only=False):
    """Resting simulated limit (chase contract). With a single price and no
    book, 'crossing' means the limit is already through the mark (buy px≥mark /
    sell px≤mark): post_only rejects that, otherwise it fills now as a taker;
    a resting order fills the first tick the mark reaches its price."""
    sym = str(symbol).upper()
    if direction not in ("long", "short"):
        raise ValueError(f"direction must be long|short, got {direction!r}")
    if float(qty) <= 0:
        return False
    px = float(price)
    buy = (direction == "long") != bool(reduce_only)
    side = "buy" if buy else "sell"
    fields = _gate("reduce" if reduce_only else "entry", symbol=sym, side=side,
                   qty=float(qty), price=px, client_order_id=client_order_id or "",
                   post_only=post_only)
    try:
        with _txn(env) as led:
            _settle(env, led)
            prev = _find_order(led, client_order_id=client_order_id) if client_order_id else None
            if prev is not None:
                return {"order_id": prev["order_id"], "status": prev["status"],
                        "client_order_id": prev.get("client_order_id") or ""}
            _check_session(env, sym)
            if is_tw_stock(sym):
                q0 = float(led["positions"].get(sym, {}).get("qty", 0))
                if not buy and not reduce_only and q0 <= 1e-12:
                    raise PaperError(f"{sym}: 台股不能放空 — paper refuses a TW stock short")
                if not (reduce_only and abs(float(qty) - abs(q0)) < 1e-9):
                    qty = math.floor(float(qty) + 1e-9)
                if qty <= 0:
                    guard.audit("order_ok", order_id="", note="under one share", **fields)
                    return False
            marks = {}
            mark = _price(env, sym, marks)
            crosses = (px >= mark) if buy else (px <= mark)
            o = _new_order(led, sym, "swap", side, "limit", px, float(qty), client_order_id,
                           reduce_only=reduce_only, direction=direction, post_only=post_only)
            if crosses and post_only:
                o["status"] = "canceled"
                o["reason"] = "post_only would take liquidity"
                guard.audit("order_ok", order_id=o["order_id"], note="post_only_rejected", **fields)
                return {"status": "post_only_rejected", "order_id": o["order_id"]}
            if crosses:
                signed = float(qty) if buy else -float(qty)
                if reduce_only:
                    signed = _cap_reduce(led, sym, signed)
                    if signed == 0:
                        o["status"] = "canceled"
                        o["reason"] = "nothing left to reduce"
                        return {"order_id": o["order_id"], "status": "canceled"}
                signed = _tw_signed(led, sym, signed)
                if signed == 0:
                    o["status"] = "canceled"
                    o["reason"] = "under one share"
                    return {"order_id": o["order_id"], "status": "canceled"}
                fx = _fill_fx(env, led, sym, None, _adds(led, sym, signed))
                fee = abs(signed) * mark * TAKER_FEE / fx[1]
                if fx[0] != "USD":
                    o.update(quote_ccy=fx[0], fx=fx[1])
                realized = _apply_swap_fill(env, led, sym, signed, mark, fee, marks, fx=fx)
                _record_fill(led, o, abs(signed), mark, fee, realized)
            guard.audit("order_ok", order_id=o["order_id"], **fields)
            return {"order_id": o["order_id"], "status": o["status"],
                    "client_order_id": client_order_id or ""}
    except guard.Halted:
        raise
    except Exception as e:
        guard.audit("order_error", error=str(e), **fields)
        raise


def get_order(env, symbol, order_id):
    with _txn(env) as led:
        _settle(env, led)
        o = _find_order(led, order_id=order_id)
        if o is None:
            raise PaperError(f"order {order_id} unknown to the paper ledger")
        return _order_view(o)


def cancel_order(env, symbol, order_id=None, client_order_id=None):
    """Idempotent-safe: open→canceled; filled/canceled/unknown→already_gone."""
    with _txn(env) as led:
        _settle(env, led)
        o = _find_order(led, order_id=order_id, client_order_id=client_order_id)
        if o is None or o["status"] != "open":
            return {"status": "already_gone", "order_id": str(order_id or client_order_id or "")}
        o["status"] = "canceled"
        o["reason"] = "canceled by caller"
        guard.audit("order_ok", venue=VENUE, intent="cancel", symbol=o["symbol"],
                    order_id=o["order_id"])
        return {"status": "canceled", "order_id": o["order_id"]}


def _open_rows(led, market, symbol=None):
    sym = str(symbol).upper() if symbol else None
    return [{"symbol": o["symbol"], "order_id": o["order_id"],
             "client_order_id": o.get("client_order_id") or "", "side": o["side"],
             "price": o["price"], "orig_qty": o["orig_qty"], "reduce_only": o.get("reduce_only"),
             "ts": o["ts"]}
            for o in led["orders"].values()
            if o["status"] == "open" and o["market"] == market and (not sym or o["symbol"] == sym)]


def get_open_orders(env, symbol=None):
    with _txn(env) as led:
        _settle(env, led)
        return _open_rows(led, "swap", symbol)


# ── protective (SL/TP) ───────────────────────────────────────────────────────

def place_protective_orders(env, symbol, direction, qty=None, sl_price=None,
                            tp_price=None, verify=True):
    """Arm SL and/or TP on the whole position (qty accepted for parity,
    ignored). Replaces any previous triggers on the symbol."""
    sym = str(symbol).upper()
    if not sl_price and not tp_price:
        raise ValueError("sl_price or tp_price required")
    fields = _gate("protective", symbol=sym, sl=sl_price, tp=tp_price)
    with _txn(env) as led:
        _settle(env, led)
        if sym not in led["positions"]:
            raise PaperError(f"no open paper position on {sym} to protect")
        led["protective"][sym] = {"sl": float(sl_price) if sl_price else None,
                                  "tp": float(tp_price) if tp_price else None,
                                  "ts": int(time.time())}
        guard.audit("order_ok", order_id=f"prot-{sym}", **fields)
        return {"symbol": sym, "sl_price": led["protective"][sym]["sl"],
                "tp_price": led["protective"][sym]["tp"], "status": "armed"}


def get_open_algo_orders(env, symbol=None):
    """Armed SL/TP as rows — paper keeps one arm per symbol."""
    sym = str(symbol).upper() if symbol else None
    with _txn(env) as led:
        _settle(env, led)
        return [{"symbol": s, "algo_id": f"prot-{s}", "sl": a.get("sl"), "tp": a.get("tp")}
                for s, a in led["protective"].items() if not sym or s == sym]


def cancel_protective_orders(env, symbol):
    sym = str(symbol).upper()
    with _txn(env) as led:
        return {"removed": led["protective"].pop(sym, None) is not None}


def open_position(env, symbol, direction, qty, sl_price=None, tp_price=None,
                  client_order_id=None):
    fill = place_market_order(env, symbol, direction, qty, client_order_id=client_order_id)
    if fill is False:
        return False
    if sl_price or tp_price:
        fill["protective"] = place_protective_orders(env, symbol, direction,
                                                     sl_price=sl_price, tp_price=tp_price)
    return fill


# ── spot layer ───────────────────────────────────────────────────────────────

def place_spot_market_order(env, symbol, side, base_qty=None, quote_qty=None,
                            client_order_id=None):
    """Confirmed simulated spot market — BUY sized in quote (USDT; TWD for a TW
    share), SELL in base, at the current price. Below zero → False."""
    sym = str(symbol).upper()
    side = str(side).lower()
    if side not in ("buy", "sell"):
        raise ValueError(f"side must be buy|sell, got {side!r}")
    fields = _gate("entry" if side == "buy" else "reduce", symbol=sym, side=side,
                   market="spot", client_order_id=client_order_id or "")
    try:
        with _txn(env) as led:
            _settle(env, led)
            prev = _find_order(led, client_order_id=client_order_id) if client_order_id else None
            if prev is not None:
                return _fill_view(prev) if prev["status"] == "filled" else False
            price = _price(env, sym, {})
            base = _spot_base(sym)
            _check_session(env, sym)
            if side == "buy":
                if quote_qty is None:
                    raise ValueError("spot buys are sized in quote currency — pass quote_qty")
                q = float(quote_qty) / price
            else:
                if base_qty is None:
                    raise ValueError("spot sells are sized in base currency — pass base_qty")
                q = min(float(base_qty), led["spot"].get(base, 0.0))
            if is_tw_stock(sym) and not (side == "sell" and abs(q - led["spot"].get(base, 0.0)) < 1e-9):
                q = math.floor(q + 1e-9)  # whole shares; selling all takes a legacy fraction too
            if q <= 0:
                guard.audit("order_ok", order_id="", note="zero/again", **fields)
                return False
            o = _new_order(led, sym, "spot", side, "market", price, q, client_order_id)
            _fill_spot(led, o, q, price, SPOT_FEE, env=env)
            guard.audit("order_ok", order_id=o["order_id"], price=price, **fields)
            return _fill_view(o)
    except guard.Halted:
        raise
    except Exception as e:
        guard.audit("order_error", error=str(e), **fields)
        raise


def place_spot_limit_order(env, symbol, side, base_qty, price, client_order_id=None,
                           post_only=False):
    sym = str(symbol).upper()
    side = str(side).lower()
    if side not in ("buy", "sell"):
        raise ValueError(f"side must be buy|sell, got {side!r}")
    if float(base_qty) <= 0:
        return False
    px = float(price)
    fields = _gate("entry" if side == "buy" else "reduce", symbol=sym, side=side,
                   price=px, market="spot", client_order_id=client_order_id or "",
                   post_only=post_only)
    try:
        with _txn(env) as led:
            _settle(env, led)
            prev = _find_order(led, client_order_id=client_order_id) if client_order_id else None
            if prev is not None:
                return {"order_id": prev["order_id"], "status": prev["status"],
                        "client_order_id": prev.get("client_order_id") or ""}
            mark = _price(env, sym, {})
            base = _spot_base(sym)
            _check_session(env, sym)
            if is_tw_stock(sym):
                base_qty = math.floor(float(base_qty) + 1e-9)
                if base_qty <= 0:
                    guard.audit("order_ok", order_id="", note="under one share", **fields)
                    return False
            if side == "buy" and led["cash"] < float(base_qty) * px * (1 + SPOT_FEE) / _spot_fx(env, base):
                raise PaperError(reject_token.tag(reject_token.INSUFFICIENT_MARGIN, f"insufficient paper cash to rest a {sym} buy"))
            if side == "sell" and led["spot"].get(base, 0.0) + 1e-12 < float(base_qty):
                raise PaperError(reject_token.tag(reject_token.INSUFFICIENT_MARGIN, f"insufficient {base} to rest a sell"))
            crosses = (px >= mark) if side == "buy" else (px <= mark)
            o = _new_order(led, sym, "spot", side, "limit", px, float(base_qty),
                           client_order_id, post_only=post_only)
            if crosses and post_only:
                o["status"] = "canceled"
                o["reason"] = "post_only would take liquidity"
                guard.audit("order_ok", order_id=o["order_id"], note="post_only_rejected", **fields)
                return {"status": "post_only_rejected", "order_id": o["order_id"]}
            if crosses:
                _fill_spot(led, o, float(base_qty), mark, SPOT_FEE, env=env)
            guard.audit("order_ok", order_id=o["order_id"], **fields)
            return {"order_id": o["order_id"], "status": o["status"],
                    "client_order_id": client_order_id or ""}
    except guard.Halted:
        raise
    except Exception as e:
        guard.audit("order_error", error=str(e), **fields)
        raise


def get_spot_order(env, symbol, order_id):
    return get_order(env, symbol, order_id)


def cancel_spot_order(env, symbol, order_id=None, client_order_id=None):
    return cancel_order(env, symbol, order_id=order_id, client_order_id=client_order_id)


def get_spot_open_orders(env, symbol=None):
    with _txn(env) as led:
        _settle(env, led)
        return _open_rows(led, "spot", symbol)


def get_spot_balances(env):
    """{asset: amount} — simulated spot inventory plus the USDT cash pool."""
    with _txn(env) as led:
        _settle(env, led)
        out = {a: float(v) for a, v in led["spot"].items() if v > 0}
        out["USDT"] = float(led["cash"])
        return out


# ── account view (lib/account_paper.py reads through here) ───────────────────

def snapshot(env):
    """Settled, marked-to-market view for account_paper."""
    with _txn(env) as led:
        _settle(env, led)
        marks = {}
        equity, upnl, spot_value, prices = _equity(env, led, marks)
        positions = []
        for sym, p in led["positions"].items():
            # _pos_mark falls back to entry for an unpriceable symbol, so
            # mark_price is ALWAYS a real number (never None) — account_paper /
            # venue_wiring float() it and size×mark_price it (audit P1-2 follow-up).
            mk, priced = _pos_mark(env, led, sym, marks)
            row = {"symbol": sym, "side": "long" if p["qty"] > 0 else "short",
                   "size": abs(p["qty"]), "entry_price": p["entry"], "mark_price": mk,
                   "priced": priced}
            if p.get("unit") == "contracts":  # size is LOTS — the wiring must not × mark
                row.update(unit="contracts", contract_value=_cv(p),
                           margin=float(p.get("margin") or 0), quote_ccy=_row_ccy(sym, p))
            elif _row_ccy(sym, p) != "USD":
                row["quote_ccy"] = _row_ccy(sym, p)
            positions.append(row)
        return {"equity": equity, "cash": led["cash"], "unrealized": upnl,
                "spot_value": spot_value, "positions": positions,
                "spot": {a: _spot_view(v, *(prices.get(a) or (None, None)))
                         for a, v in led["spot"].items() if v > 0},
                "created_ts": led["created_ts"], "initial_cash": led["initial_cash"],
                "fills": list(led["fills"][-50:])}


def _spot_view(amount, px, rate):
    """price = the quote's own (TWD for a TW share); usd_value = amount at
    market in the account's USD, None when unpriceable."""
    return {"amount": amount, "price": px,
            "usd_value": amount * px / rate if px and rate else None}


def reset_account(env, cash=None):
    """Wipe positions/orders/fills and re-seed cash. Explicit user request only."""
    fields = _gate("reset", symbol="*", note="reset_account")
    with _txn(env) as led:
        fresh = _new_ledger(env)
        # created_ts must not trail PAPER_BOUND_TS, or a machine clock behind the
        # (browser-set) bind stamp makes the next _load judge this fresh ledger
        # "older than the bind" and re-seed again — silently undoing the reset
        # (audit P2; same clock-skew guard _load uses).
        fresh["created_ts"] = max(fresh["created_ts"], _bound_ts(env))
        if cash:
            fresh["cash"] = fresh["initial_cash"] = float(cash)
        led.clear()
        led.update(fresh)
        guard.audit("order_ok", order_id="reset", **fields)
        return {"equity": led["cash"], "currency": "USDT"}
