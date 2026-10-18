"""
Paper price resolver — the fill/mark price for the simulated `paper` venue.

The rule (Wei 2026-08-21): a paper order fills at the price the STRATEGY itself
sees, from the STRATEGY's own data source — never an independent public feed.
Two strategies on the same symbol can pull it from different endpoints and even
different adjustments (crypto `fetch_kline`, futures `fetch_db_kline`). So we resolve the
symbol back to the strategy trading it and call that strategy's `fetch_data`,
taking the latest bar's Close as "the current price".

TW stocks are the exception (Wei 2026-10-18): every TW stock fills and marks at
the UNADJUSTED daily close — the price a broker app shows and the one the
portfolio page turns TWD into shares with (lib/runner.tw_fetch_closes), so the
shares on the page are the shares the paper account buys. A dividend-adjusted
close is anchored at its fetch window's start (2330 on 2026-10-16: 2420 from a
10-day window, 2755.89 from 2020) and sized ~12% fewer shares than the page.
Dividends are not booked: on an ex-date the unadjusted close drops and the
paper equity drops with it, never paid back (no cash dividend credited, no
stock-dividend shares added), so paper trails a dividend-adjusted backtest by
the yield. The own-positions book diffs fill-time cost, not the mark, so an
ex-date drop sends no order.

One USD account, any asset (product decision B). A NOTIONAL position needs no
FX: the reconciler sizes qty = USD ÷ price, so PnL = USD_notional × (mark/entry
− 1), a unitless return. A CONTRACT position (lots × contract_value, TXF family
and later TW shares) is NOT unitless — lots × point value × Δindex is TWD — so
its money (PnL, fee, margin) goes through usd_rate() before it touches the USD
account. quote_ccy() says which currency a symbol's contract money is in.

Fills are immediate at this price (no wait for the next bar — the live-paper
convention every serious system uses, e.g. Freqtrade dry-run; paper deliberately
diverges a little from the next-bar-open backtest, which is normal and even
useful as a look-ahead detector). No bid/ask, no slippage — beginner-tier
fidelity (Webull/TradingView do the same); fees are modelled, that is the one
realism worth keeping.
"""
import glob
import importlib.util
import json
import logging
import os
import re
import math
import time

try:
    from lib.winreplace import atomic_replace
except ImportError:  # half-updated workspace (lib/winreplace.py not landed): plain replace
    atomic_replace = os.replace

log = logging.getLogger("paper_data")

_SYMBOL_RE = re.compile(r'^\s*SYMBOL\s*=\s*["\']([^"\']+)["\']', re.M)
# module cache: path -> (mtime, loaded module). Strategy files rarely change;
# reloading on every fill/mark would re-exec module-level code needlessly.
_mod_cache = {}

# Price cache: fetch_data is a BACKTEST loader — one call can pull full history
# since 2018 plus several auxiliary datasets, just to read the last Close. The
# account reader marks every position and calls get_equity/get_positions/
# get_holdings each minute (3× snapshot→settle→equity), and a fill's leverage
# check re-prices every held symbol — without a cache that is dozens of
# full-history pulls a minute per venue, which blows account_reader's 60s/venue
# SIGALRM budget and hammers data-api. A short process-level TTL collapses all
# of that to one pull per symbol per window. Stale-by-≤TTL is fine: the price
# IS a bar Close (1m+), not a live tick, and paper never claims tick precision.
_PRICE_TTL_S = 30
_price_cache = {}  # symbol -> (fetched_at, price, strategy_name)


def _norm(sym):
    return str(sym or "").replace("-", "").replace("_", "").upper()


def _hdrs(env):
    return {"api-key": (env or {}).get("blave_api_key", ""),
            "secret-key": (env or {}).get("blave_secret_key", "")}


def _txf_root(sym):
    s = sym or ""
    if s.endswith("R1") and len(s) > 2:
        s = s[:-2]
    return s if s in ("TXF", "MXF", "TMF") else None


def _strategy_symbol(name):
    """The symbol a strategy trades — state.json first (what it actually set at
    runtime), else the SYMBOL constant parsed from strategy.py."""
    try:
        with open(f"strategies/{name}/state.json") as f:
            s = json.load(f).get("symbol")
            if s:
                return _norm(s)
    except (OSError, ValueError):
        pass
    try:
        with open(f"strategies/{name}/strategy.py") as f:
            m = _SYMBOL_RE.search(f.read())
            if m:
                return _norm(m.group(1))
    except OSError:
        pass
    return None


def _load_strategy(name):
    """Import strategies/{name}/strategy.py by path WITHOUT running it — run()
    sits under `if __name__ == '__main__'`, so module load only defines
    fetch_data/compute_signals and is side-effect-free. Cached by mtime."""
    path = os.path.abspath(f"strategies/{name}/strategy.py")
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return None
    hit = _mod_cache.get(path)
    if hit and hit[0] == mtime:
        return hit[1]
    spec = importlib.util.spec_from_file_location(f"_paper_strat_{name}", path)
    if not spec or not spec.loader:
        return None
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    except Exception as e:
        log.warning(f"[paper_data] load {name} failed: {type(e).__name__}: {e}")
        return None
    _mod_cache[path] = (mtime, mod)
    return mod


def _resolve_strategy(symbol):
    """Name of a strategy trading `symbol` (normalized match), or None. Prefers
    a strategy that actually has fetch_data (Type A/C); Type B has none.

    When two strategies trade the same symbol from different sources (e.g. one
    adjusted, one raw), the price comes from whichever sorts first — deterministic
    but arbitrary. This is a known limitation of pricing off the strategy rather
    than the order: the order only carries a symbol, not which strategy sized it.
    Same-symbol strategies almost always share a data source, so it rarely bites;
    documented so a future need can thread the strategy through the fill."""
    want = _norm(symbol)
    candidates, family = [], []
    for path in sorted(glob.glob("strategies/*/strategy.py")):
        name = os.path.basename(os.path.dirname(path))
        sym = _strategy_symbol(name)
        if sym == want:
            candidates.append(name)
        elif _txf_root(want) and _txf_root(sym):
            # TXF / MXF / TMF are one index series (lib.data maps all three to TXF
            # bars), and a strategy switched to another contract (portfolio_config
            # `contracts`) still says its own SYMBOL — any family strategy prices it
            family.append(name)
    for name in candidates + family:
        mod = _load_strategy(name)
        if mod and hasattr(mod, "fetch_data"):
            return name
    return None


def _last_close(df):
    """Latest bar Close as a float, tolerant of column casing (backtest uses
    'Close'; be lenient in case a source returns 'close')."""
    if df is None or len(df) == 0:
        raise PaperNoPrice("strategy fetch_data returned no rows")
    row = df.iloc[-1]
    for col in ("Close", "close", "Open", "open"):
        if col in df.columns:
            return float(row[col])
    raise PaperNoPrice(f"no Close/Open column in fetch_data output: {list(df.columns)}")


class PaperNoPrice(Exception):
    """No price could be sourced for a symbol — the paper fill/mark cannot
    proceed and must fail loud (a silent 0 would book fake PnL)."""


def current_price(symbol, env, max_age=_PRICE_TTL_S):
    """Current price for `symbol` from the trading strategy's own data source,
    served from a short process-level cache (see _price_cache). Returns
    (price, strategy_name).

    TW stocks: the unadjusted daily close (module docstring), name None.
    Type A/C: the strategy's fetch_data, latest Close. Fallback when no bar
    strategy claims the symbol (Type B / manual / not-yet-run): a generic
    1m crypto kline via the same Blave API — best-effort, and it RAISES
    (PaperNoPrice) rather than guessing when even that has no data, so a paper
    fill never books against a made-up price. `max_age=0` forces a fresh pull.
    """
    hit = _price_cache.get(symbol)
    if hit and max_age and (time.time() - hit[0]) < max_age:
        return hit[1], hit[2]
    price, name = _resolve_price(symbol, env)
    _price_cache[symbol] = (time.time(), price, name)
    return price, name


def _resolve_price(symbol, env):
    hdrs = _hdrs(env)
    if is_tw_stock(symbol):
        return _tw_stock_price(symbol, hdrs), None
    name = _resolve_strategy(symbol)
    if name:
        mod = _load_strategy(name)
        try:
            df = mod.fetch_data(hdrs)
            return _last_close(df), name
        except PaperNoPrice:
            raise
        except Exception as e:
            raise PaperNoPrice(f"{name}.fetch_data failed for {symbol}: "
                               f"{type(e).__name__}: {e}")
    # No bar strategy owns this symbol (Type B crypto / manual, a Type C
    # component): best-effort generic 1m crypto kline over a short recent
    # window. Anything with no such feed RAISES rather than guessing.
    try:
        from datetime import datetime, timedelta, timezone
        from lib.data import fetch_kline
        start = (datetime.now(timezone.utc) - timedelta(days=2)).strftime("%Y-%m-%d")
        df = fetch_kline(_norm(symbol), "1m", start, None, hdrs)
        return _last_close(df), None
    except Exception as e:
        raise PaperNoPrice(f"no strategy trades {symbol} and generic price "
                           f"lookup failed: {type(e).__name__}: {e}")


# ── TW stocks: price, session ────────────────────────────────────────────────

# A stock suspended past the short window has no bar in it: its last close (up to the long
# window back) still prices the close-out — without one every order on it, closes included,
# is refused.
_TW_PRICE_WINDOWS_D = (14, 400)


def _tw_stock_price(symbol, hdrs):
    """Latest unadjusted daily Close of a TW stock — fetch_twstock_price, the
    same data and cache as the page's fetch_twstock_price_batch, under the same
    code (runner strips .TW/.TWO before its batch call). A Type C fetch_data is
    never run for it: a whole TW universe takes minutes, far past the account
    reader's 60s budget. Desktop: Blave CDN, no key."""
    from datetime import datetime, timedelta, timezone
    from lib import data
    code = re.sub(r"\.TWO?$", "", _norm(symbol))
    for days in _TW_PRICE_WINDOWS_D:
        start = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d")
        try:
            return _last_close(data.fetch_twstock_price(code, start, None, hdrs))
        except PaperNoPrice as e:
            empty = e
        except Exception as e:
            # a failing source is not retried on a longer window (the account reader's budget)
            raise PaperNoPrice(f"no daily close for TW stock {code}: {type(e).__name__}: {e}")
    raise PaperNoPrice(f"no daily close for TW stock {code} in {_TW_PRICE_WINDOWS_D[-1]} days: {empty}")


_START_RE = re.compile(r'^\s*START\s*=\s*["\']([0-9]{4}-[0-9]{2}-[0-9]{2})["\']', re.M)


def legacy_tw_price(symbol, env):
    """The close a TW stock row was valued at before every TW stock moved to the unadjusted
    close — for the one-time rebase of rows booked then (order_paper._rebase_tw_rows). A Type
    A owner: its fetch_data's latest Close (0.1.26 and earlier); a Type C whose live weights
    hold it: the adjusted close from its START (the 0.1.27 test builds before the switch).
    None = no such owner: the row was valued at the unadjusted close or at its entry, nothing
    to rebase. Raises PaperNoPrice when the owner's price cannot be read (retried later).
    Approximate on the desktop: the CDN's adjusted series no longer depends on the window."""
    name = _resolve_strategy(symbol)
    hdrs = _hdrs(env)
    if name:
        try:
            return _last_close(_load_strategy(name).fetch_data(hdrs))
        except PaperNoPrice:
            raise
        except Exception as e:
            raise PaperNoPrice(f"{name}.fetch_data failed for {symbol}: {type(e).__name__}: {e}")
    want = _norm(symbol)
    for path in sorted(glob.glob("strategies/*/state.json")):
        try:
            with open(path) as f:
                w = json.load(f).get("weights")
        except (OSError, ValueError, AttributeError):
            continue
        if not isinstance(w, dict) or want not in {_norm(k) for k in w}:
            continue
        try:
            with open(os.path.join(os.path.dirname(path), "strategy.py")) as f:
                m = _START_RE.search(f.read())
        except OSError:
            m = None
        from lib import data
        code = re.sub(r"\.TWO?$", "", want)
        try:
            return _last_close(data.fetch_twstock_price_adj(code, m.group(1) if m else "2015-01-01", None, hdrs))
        except PaperNoPrice:
            raise
        except Exception as e:
            raise PaperNoPrice(f"no adjusted close for TW stock {code}: {type(e).__name__}: {e}")
    return None


_TW_OPEN_MIN, _TW_CLOSE_MIN = 9 * 60, 13 * 60 + 30
TW_DAY_PATH = "state/paper_tw_day.json"
# The account reader is a fresh process every minute and asks inside the ledger
# lock, so the day's verdict lives on disk: a known verdict holds for the day,
# an unreadable table is retried at most every _TW_DAY_RETRY_S, and one fetch
# is capped at a few seconds (api down: the weekday rule, fast).
_TW_DAY_RETRY_S = 600
_TW_DAY_TIMEOUT_S = 3
_tw_day_cache = {}  # Taipei date -> (checked_at, True/False/None)


def is_tw_stock(symbol):
    """A TWSE/TPEx stock or ETF code (2330, 00878, 6488.TWO) — not a futures code."""
    return bool(_TW_STOCK_RE.match(_norm(symbol)))


def _tw_day_fresh(hit, now):
    return hit is not None and (hit[1] is not None or now - hit[0] < _TW_DAY_RETRY_S)


def _tw_day_verdict(day, env):
    now = time.time()
    hit = _tw_day_cache.get(day)
    if _tw_day_fresh(hit, now):
        return hit[1]
    try:
        with open(TW_DAY_PATH) as f:
            d = json.load(f)
        if d.get("date") == day.isoformat():
            hit = (float(d.get("checked_at") or 0), d.get("verdict"))
            if _tw_day_fresh(hit, now):
                _tw_day_cache[day] = hit
                return hit[1]
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    try:
        from lib.data import is_tw_trading_day
        verdict = is_tw_trading_day(day.isoformat(), _hdrs(env), timeout=_TW_DAY_TIMEOUT_S,
                                    max_retries=1)
    except Exception as e:
        log.info(f"[paper_data] TW holiday table unavailable ({type(e).__name__}) — weekday rule")
        verdict = None
    _tw_day_cache[day] = (now, verdict)
    try:
        os.makedirs(os.path.dirname(TW_DAY_PATH), exist_ok=True)
        tmp = TW_DAY_PATH + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"date": day.isoformat(), "verdict": verdict, "checked_at": int(now)}, f)
        atomic_replace(tmp, TW_DAY_PATH)
    except OSError as e:
        log.warning(f"[paper_data] TW day cache write failed: {e}")
    return verdict


def tw_session_open(env=None, now=None):
    """True inside a TWSE regular session: 09:00–13:30 Taipei on a trading day.
    The holiday table (lib.data.is_tw_trading_day) needs a Blave API plan; when
    it can't be read the weekday alone decides. Typhoon closures are in no
    table, so a paper fill can still happen on one. Outside the hours no
    fetch at all."""
    from datetime import datetime, timedelta, timezone
    t = datetime.fromtimestamp(time.time() if now is None else now, timezone(timedelta(hours=8)))
    if t.weekday() >= 5 or not (_TW_OPEN_MIN <= t.hour * 60 + t.minute < _TW_CLOSE_MIN):
        return False
    return _tw_day_verdict(t.date(), env) is not False


# ── FX for contract money (lots × point value is in the contract's currency) ──

class PaperNoFx(PaperNoPrice):
    """No USD rate for a contract currency — an entry must be refused (booking
    TWD as USD inflates equity ~32×)."""


_USD_LIKE = ("USD", "USDT", "USDC")
_TW_STOCK_RE = re.compile(r"^\d{4,6}[A-Z]?(?:\.TWO?)?$")
# TAIFEX futures codes (stock futures CDF…, sector TEF/TFF, E4F) — three
# characters ending in F, Shioaji 'R1'/'R2' month alias allowed
_TAIFEX_RE = re.compile(r"^[A-Z][A-Z0-9]F(?:R[12])?$")
FX_PATH = "state/paper_fx.json"
# api's own table refreshes hourly from a daily bank rate, so an hour-old copy
# is current; the on-disk copy of any age is still the right fallback (USDTWD
# moves ~0.1%/day — far inside what a stale-by-days paper mark costs).
_FX_TTL_S = 3600
_FX_URL_PATH = "/fx_rates"
_FX_RETRY_S = 60  # with no rate at all, don't re-hit a failing api inside every ledger lock
_fx_cache = {}  # ccy -> (fetched_at, rate)
_fx_failed_at = [0.0]
# same band api common/fx.py guards with: a parse slip (inverted pair, cents) is
# a refused rate, not a 1000× ledger
_FX_SANE = {"TWD": (10.0, 100.0)}


def quote_ccy(symbol, declared=None):
    """Currency a CONTRACT position's money is in: the asset_spec's `currency`
    when given, else TWD for TAIFEX futures codes and TW stock codes, else USD."""
    if isinstance(declared, str) and declared.strip():
        c = declared.strip().upper()
        return "USD" if c in _USD_LIKE else c
    s = _norm(symbol)
    if _txf_root(s) or _TAIFEX_RE.match(s) or _TW_STOCK_RE.match(s):
        return "TWD"
    return "USD"


def _sane(rate, ccy=None):
    try:
        r = float(rate)
    except (TypeError, ValueError):
        return None
    lo, hi = _FX_SANE.get(ccy, (0.0, math.inf))
    return r if math.isfinite(r) and lo < r < hi else None


def _read_fx_file():
    try:
        with open(FX_PATH) as f:
            d = json.load(f)
        return (d.get("rates") or {}), float(d.get("ts") or 0)
    except (OSError, ValueError, TypeError, AttributeError):
        return {}, 0.0


def _write_fx_file(rates):
    try:
        os.makedirs(os.path.dirname(FX_PATH), exist_ok=True)
        tmp = FX_PATH + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"rates": rates, "ts": int(time.time())}, f)
        atomic_replace(tmp, FX_PATH)
    except OSError as e:
        log.warning(f"[paper_data] fx cache write failed: {e}")


def _fetch_fx(env):
    """The platform's own table (api common/fx.get_fx_rates: 1 USD = N ccy) —
    the one the app and web fold TWD with, so the ledger and the screen agree."""
    import requests
    from lib.data import BASE
    r = requests.get(BASE + _FX_URL_PATH, headers=_hdrs(env), timeout=5)
    r.raise_for_status()
    body = r.json()
    rates = body.get("rates", body) if isinstance(body, dict) else {}
    return {str(k).upper(): float(v) for k, v in rates.items() if _sane(v, str(k).upper())}


def usd_rate(ccy, env, max_age=_FX_TTL_S):
    """Units of `ccy` per 1 USD (TWD ≈ 32): usd = amount / rate. 1.0 for USD /
    USDT / USDC. Process cache → fresh state/paper_fx.json → api → that file
    at any age; RAISES PaperNoFx when there has never been a rate — never a
    constant."""
    c = str(ccy or "USD").upper()
    if c in _USD_LIKE:
        return 1.0
    now = time.time()
    hit = _fx_cache.get(c)
    if hit and max_age and now - hit[0] < max_age:
        return hit[1]
    rates, ts = _read_fx_file()
    disk = _sane(rates.get(c), c)
    if disk and max_age and now - ts < max_age:
        _fx_cache[c] = (now, disk)
        return disk
    if disk or now - _fx_failed_at[0] >= _FX_RETRY_S:
        try:
            fresh = _fetch_fx(env)
            if fresh.get(c):
                _write_fx_file(fresh)
                _fx_cache[c] = (now, float(fresh[c]))
                return float(fresh[c])
            log.warning(f"[paper_data] fx table has no {c}")
        except Exception as e:
            log.warning(f"[paper_data] fx fetch failed: {type(e).__name__}: {e}")
        _fx_failed_at[0] = now
    if disk:
        _fx_cache[c] = (now, disk)  # don't re-hit a failing api on every mark this hour
        return disk
    raise PaperNoFx(f"no USD rate for {c} yet — a {c} contract fill cannot be booked "
                    f"in the USD paper account")
