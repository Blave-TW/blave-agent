"""
Paper price resolver — the fill/mark price for the simulated `paper` venue.

The rule (Wei 2026-10-20): a paper order fills at the latest price actually
quoted on the market, never a dividend/split-adjusted one. It replaces the
08-21 rule (the trading strategy's own fetch_data), under which a 4h strategy
filled at a close up to four hours old and an adjusted series filled at a
level nobody ever quoted.
  * crypto (…USDT / …USDC — stock perps like NVDAUSDT included): Binance USDT-M
    `/fapi/v1/ticker/price`, the last trade. Keyless, one weight per call, and
    the market lib.data's klines come from (fetch_kline is fapi), so a backtest
    and its paper fills read one market. Spot rows price off the perp too (a
    few bp of basis). Binance unreachable (a blocked region, an outage) → the
    latest closed 1m bar of the same market via Blave /kline (with a key). Last
    resort — a coin Binance does not list (OKX/BingX-only), a key-less desktop
    where Binance is blocked — the owning strategy's own latest close (logged).
  * TAIFEX futures (TXF/MXF/TMF, stock futures CDF…): the latest 1m Close of
    the continuous near-month series (Blave, uncached: the latest minute the
    server has). That series is what the strategies read,
    so the roll is the one they see: settlement day is the expiring month all
    day, the next month from the 15:00 session. MXF/TMF price off TXF (one
    index). A closed market answers its last minute. No Blave data access on
    the desktop → TAIFEX's own daily close (TXF family only).
  * TW stocks (Wei 2026-10-18): the UNADJUSTED daily close (a TW stock has no
    live price paper could trade on) — the price a broker app shows and the one
    the portfolio page turns TWD into shares with (lib/runner.tw_fetch_closes),
    so the shares on the page are the shares the paper account buys. A symbol
    an intraday Type A trades takes its latest unadjusted bar (_tw_stock_price).
  * US stocks (a symbol a strategy fetches with fetch_usstock_price): Yahoo's
    latest final unadjusted daily close — a hand-placed paper order fills at
    it; lib.data refuses Yahoo on every live tick, so an automatic US paper
    order is refused (PaperNoPrice).
  * anything else (fetch_db_kline CME/ICE futures): the owning strategy's
    fetch_data, latest Close — that series is the front contract's own price.
Nothing priced → PaperNoPrice: an entry is refused, a close falls back to the
row's entry (order_paper._pos_mark) so a position never becomes unflattenable.

Dividends are not booked: on an ex-date the unadjusted close drops and the
paper equity drops with it, never paid back (no cash dividend credited, no
stock-dividend shares added), so paper trails a dividend-adjusted backtest by
the yield (TW and US alike). The own-positions book diffs fill-time cost, not
the mark, so an ex-date drop sends no order.

One USD account, any asset (product decision B). A NOTIONAL position needs no
FX: the reconciler sizes qty = USD ÷ price, so PnL = USD_notional × (mark/entry
− 1), a unitless return. A CONTRACT position (lots × contract_value, TXF family
and later TW shares) is NOT unitless — lots × point value × Δindex is TWD — so
its money (PnL, fee, margin) goes through usd_rate() before it touches the USD
account. quote_ccy() says which currency a symbol's contract money is in.

Fills are immediate at this price (no wait for the next bar — the live-paper
convention every serious system uses, e.g. Freqtrade dry-run; paper deliberately
diverges a little from the next-bar-open backtest, which is normal and even
useful as a look-ahead detector). No bid/ask and no separate slippage — beginner-tier
fidelity (Webull/TradingView do the same). The fee is the realism kept, and it is
the backtest's (strategy_fee): the FEE of the 下單設定 strategy trading the symbol
on that market, else lib.costs' per-market default, which already includes slippage.
"""
import ast
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
try:
    from lib.winreplace import load_json
except ImportError:  # half-updated workspace (lib/winreplace.py without load_json): no read retry
    def load_json(path, **open_kw):
        with open(path, **open_kw) as f:
            return json.load(f)
try:
    from lib.winreplace import read_retry
except ImportError:  # half-updated workspace (lib/winreplace.py not landed): no read retry
    def read_retry(read, *args, **kwargs):
        return read(*args, **kwargs)

log = logging.getLogger("paper_data")

_SYMBOL_RE = re.compile(r'^\s*SYMBOL\s*=\s*["\']([^"\']+)["\']', re.M)
# module cache: path -> (mtime, loaded module). Strategy files rarely change;
# reloading on every fill/mark would re-exec module-level code needlessly.
_mod_cache = {}

# Price cache: the account reader marks every position and calls get_equity/
# get_positions/get_holdings each minute (3× snapshot→settle→equity), and a
# fill's leverage check re-prices every held symbol — without a cache that is
# dozens of requests a minute per venue (and a full-history pull for an owner
# fetch_data), which blows account_reader's 60s/venue SIGALRM budget. A short
# process-level TTL collapses it to one read per symbol per window; paper never
# claims tick precision.
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


def _txf_family(sym):
    """TXF / MXF / TMF for any month alias (R1 or R2) — who owns a fill, what it costs.
    Pricing keeps _txf_root: R2 is another month's series there."""
    s = sym or ""
    return _txf_root(s[:-2] if s.endswith("R2") else s)


def _strategy_symbol(name):
    """The symbol a strategy trades — state.json first (what it actually set at
    runtime), else the SYMBOL constant parsed from strategy.py."""
    try:
        s = load_json(f"strategies/{name}/state.json").get("symbol")
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


_CONSTS = ("FEE", "SYMBOL", "MARKET", "UNIVERSE")
_file_cache = {}  # (path, parse) -> ((mtime_ns, size), parsed) — strategy files and state.json, read inside the ledger lock


def _cached(path, parse):
    """parse(file text), kept until the file's (mtime_ns, size) changes. A file that does
    not parse is None (logged) — a fee lookup never fails the fill."""
    try:
        st = os.stat(path)
    except OSError:
        return None
    key = (st.st_mtime_ns, st.st_size)
    hit = _file_cache.get((path, parse))
    if hit and hit[0] == key:
        return hit[1]
    try:
        val = parse(read_retry(_read_text, path))
    except Exception as e:
        log.warning(f"[paper_data] {path} unreadable for the paper fee, using the default: "
                    f"{type(e).__name__}: {e}")
        val = None
    _file_cache[(path, parse)] = (key, val)
    return val


def _read_text(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def _consts(src):
    """Module-level FEE / SYMBOL / MARKET / UNIVERSE as Python ends up with them: the LAST
    assignment of each (plain or annotated), parsed, never executed. A computed last value
    is unknown (absent), not an earlier literal."""
    out = {}
    for node in ast.parse(src).body:
        if isinstance(node, ast.Assign):
            targets = node.targets
        elif isinstance(node, ast.AnnAssign) and node.value is not None:
            targets = [node.target]
        else:
            continue
        for t in targets:
            if isinstance(t, ast.Name) and t.id in _CONSTS:
                try:
                    out[t.id] = ast.literal_eval(node.value)
                except (ValueError, TypeError):  # computed, or an unhashable literal
                    out.pop(t.id, None)
    return out


def _owner_fee(name, want, spot):
    """The FEE strategy `name` is backtested with, when it trades `want` on this market
    (spot vs perp — a TW code is held as shares whatever MARKET says): its own FEE, else
    its market default (a Type C: the highest over its universe). None = not an owner."""
    from lib.costs import default_fee, reads_usstock
    path = f"strategies/{name}/strategy.py"
    c = _cached(path, _consts) or {}
    state = _cached(f"strategies/{name}/state.json", json.loads)
    state = state if isinstance(state, dict) else {}
    weights = state.get("weights") if isinstance(state.get("weights"), dict) else {}
    sym = _norm(state.get("symbol") or c.get("SYMBOL"))
    if not (sym == want or (_txf_family(want) and _txf_family(sym))
            or want in {_norm(k) for k in weights}):
        return None
    market = str(state.get("market") or c.get("MARKET") or "swap").lower()
    if not is_tw_stock(want) and (market == "spot") != spot:
        return None
    fee = c.get("FEE")
    if isinstance(fee, (int, float)) and not isinstance(fee, bool):
        return float(fee)
    universe = c.get("UNIVERSE") if isinstance(c.get("UNIVERSE"), (list, tuple)) else list(weights)
    return default_fee(c.get("SYMBOL") or sym, market, universe or None,
                       bool(_cached(path, reads_usstock)))


def strategy_fee(symbol, spot=False):
    """Per-side FEE a paper fill of `symbol` pays: the one its backtest charges, taken from
    the strategies in the 下單設定 (lib.portfolio.strategy_amounts — the same membership
    as runner._picked_for_trading) that trade it on this market; drafts and copies outside
    it never count. The order does not say which strategy sized it: several owners → the
    highest. None = no owner — the caller uses lib.costs' default."""
    try:
        from lib.portfolio import strategy_amounts
        picked = sorted(strategy_amounts())
    except Exception as e:
        log.warning(f"[paper_data] order settings unreadable, paper fee uses the market default: {e}")
        return None
    want = _norm(symbol)
    fees = [f for f in (_owner_fee(n, want, spot) for n in picked) if f is not None]
    return max(fees) if fees else None


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
        raise PaperNoPrice("the price source returned no rows")
    row = df.iloc[-1]
    for col in ("Close", "close", "Open", "open"):
        if col in df.columns:
            return float(row[col])
    raise PaperNoPrice(f"no Close/Open column in fetch_data output: {list(df.columns)}")


class PaperNoPrice(Exception):
    """No price could be sourced for a symbol — the paper fill/mark cannot
    proceed and must fail loud (a silent 0 would book fake PnL)."""


def current_price(symbol, env, max_age=_PRICE_TTL_S):
    """Latest market price for `symbol` (module docstring: which market, which
    feed), served from a short process-level cache (see _price_cache). Returns
    (price, strategy_name) — the name only when an owner's fetch_data priced
    it. RAISES PaperNoPrice rather than guessing, so a paper fill never books
    against a made-up price. `max_age=0` forces a fresh read."""
    hit = _price_cache.get(symbol)
    if hit and max_age and (time.time() - hit[0]) < max_age:
        return hit[1], hit[2]
    price, name = _resolve_price(symbol, env)
    _price_cache[symbol] = (time.time(), price, name)
    return price, name


_CRYPTO_QUOTES = ("USDT", "USDC")


def _resolve_price(symbol, env):
    hdrs = _hdrs(env)
    sym = _norm(symbol)
    if is_tw_stock(sym):
        return _tw_stock_price(symbol, hdrs), None
    if _txf_root(sym):
        return _taifex_last(sym, hdrs), None
    if sym.endswith(_CRYPTO_QUOTES):
        return _crypto_last(sym, hdrs)
    # before the TAIFEX pattern: XLF/IWF/GEF/KOF fit it too
    if _us_owned(sym):
        return _us_last(symbol), None
    if _TAIFEX_RE.match(sym):
        return _taifex_last(sym, hdrs), None
    return _owner_price(symbol, hdrs)


def _owner_price(symbol, hdrs):
    """The 08-21 rule: the latest Close of the strategy trading `symbol`."""
    name = _resolve_strategy(symbol)
    if not name:
        raise PaperNoPrice(f"no market feed answered and no strategy trades {symbol}")
    try:
        return _last_close(_load_strategy(name).fetch_data(hdrs)), name
    except PaperNoPrice:
        raise
    except Exception as e:
        raise PaperNoPrice(f"{name}.fetch_data failed for {symbol}: {type(e).__name__}: {e}")


_BINANCE_PRICE = "https://fapi.binance.com/fapi/v1/ticker/price"


class _NotListed(Exception):
    pass


def _binance_last(sym):
    """Binance USDT-M last trade. Two tries and no long Retry-After wait: a
    blocked region must not eat the account reader's 60s budget."""
    import requests
    from lib.data import _binance_get
    try:
        r = _binance_get(_BINANCE_PRICE, {"symbol": sym}, max_retries=2, timeout=10, max_wait=5)
    except requests.HTTPError as e:
        if '"code":-1121' in str(e).replace(" ", ""):
            raise _NotListed(sym)
        raise
    px = float(r.json()["price"])
    if not (math.isfinite(px) and px > 0):
        raise ValueError(f"Binance price {px!r}")
    return px


# Binance unreachable once → the rest of this process skips it for a while: a timing-out
# host times every held symbol out in turn, past the account reader's budget
_BINANCE_SKIP_S = 60
_binance_down_at = [0.0]


def _crypto_last(sym, hdrs):
    """(price, owner name or None). Binance → Blave 1m (with a key) → the owning
    strategy's own close, the last resort for a coin Binance does not list
    (OKX/BingX-only) and a key-less desktop where Binance is blocked."""
    tried = []
    if time.time() - _binance_down_at[0] < _BINANCE_SKIP_S:
        tried.append("Binance skipped: unreachable moments ago")
    else:
        try:
            px = _binance_last(sym)
        except _NotListed:
            tried.append("not listed on Binance USDT-M")
        except Exception as e:
            tried.append(f"Binance {type(e).__name__}: {e}")
            _binance_down_at[0] = time.time()
        else:
            return _unless_collision(sym, px, hdrs, "Binance")
    # Blave /kline is Binance's own bars: nothing there for a coin Binance does not list
    if hdrs.get("api-key") and not tried[0].startswith("not listed"):
        try:
            from datetime import datetime, timedelta, timezone
            from lib.data import fetch_kline
            start = (datetime.now(timezone.utc) - timedelta(days=2)).strftime("%Y-%m-%d")
            px = _last_close(fetch_kline(sym, "1m", start, None, hdrs, max_retries=2))
        except Exception as e:
            tried.append(f"Blave 1m kline {type(e).__name__}: {e}")
        else:
            # the same Binance instrument's bars: a collision there is one here too
            return _unless_collision(sym, px, hdrs, "Blave 1m kline")
    try:
        px, name = _owner_price(sym, hdrs)
    except PaperNoPrice as e:
        raise PaperNoPrice(f"no market price for {sym}: {'; '.join(tried)}; {e}")
    log.warning(f"[paper_data] {sym}: {'; '.join(tried)} — priced at strategy {name}'s own latest close")
    return px, name


# Binance's own price off its owner's close by more than this factor is another
# instrument under the same ticker (CATUSDT there is Caterpillar, not the CAT memecoin)
_COLLISION_X = 10.0
# One verdict per (symbol, owner) per UTC day on disk: the account reader is a fresh
# process every minute and must not run every owner's fetch_data to compare. An owner
# close that cannot be read is asked again after _COLLISION_RETRY_S, Binance meanwhile.
COLLISION_PATH = "state/paper_crypto_collision.json"
_COLLISION_RETRY_S = 600


def _collision_table(day):
    try:
        d = load_json(COLLISION_PATH)
        if d.get("date") == day and isinstance(d.get("verdicts"), dict):
            return d["verdicts"]
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    return {}


def _collision_save(day, key, verdict):
    table = _collision_table(day)
    table[key] = {"collision": verdict, "at": int(time.time())}
    try:
        os.makedirs(os.path.dirname(COLLISION_PATH), exist_ok=True)
        tmp = COLLISION_PATH + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"date": day, "verdicts": table}, f)
        atomic_replace(tmp, COLLISION_PATH)
    except OSError as e:
        log.warning(f"[paper_data] collision cache write failed: {e}")


def _collision_hit(table, key):
    """(verdict, at) of a well-formed cache entry, else None (a hand-edited file is no cache)."""
    hit = table.get(key)
    if not isinstance(hit, dict):
        return None
    verdict, at = hit.get("collision"), hit.get("at")
    if verdict not in (True, False, None) or isinstance(at, bool) or not isinstance(at, (int, float)):
        return None
    return verdict, at


def _unless_collision(sym, px, hdrs, src):
    """(price, owner or None) for a Binance-market price `px` read from `src`. Not
    judged yet and the owner's close unreadable → px; judged a collision today →
    the owner's close or PaperNoPrice, never px (that is the other instrument)."""
    name = _resolve_strategy(sym)
    if not name:
        return px, None
    from datetime import datetime, timezone
    day, key = datetime.now(timezone.utc).date().isoformat(), f"{sym}|{name}"
    verdict, at = _collision_hit(_collision_table(day), key) or (None, None)
    if verdict is False:
        return px, None
    if verdict is None and at is not None and time.time() - at < _COLLISION_RETRY_S:
        return px, None
    try:
        own, name = _owner_price(sym, hdrs)
        if not (math.isfinite(own) and own > 0):
            raise PaperNoPrice(f"strategy {name}'s own close for {sym} is {own!r}")
    except PaperNoPrice as e:
        if verdict:
            raise PaperNoPrice(f"{sym}: {src} carries another instrument under this ticker and "
                               f"the strategy's own close is unreadable: {e}")
        _collision_save(day, key, None)
        return px, None
    if verdict is None:
        verdict = not (1 / _COLLISION_X <= px / own <= _COLLISION_X)
        _collision_save(day, key, verdict)
        if verdict:
            log.warning(f"[paper_data] {sym}: {src} {px} vs strategy {name}'s own close {own} — "
                        f"a different instrument under the same ticker; priced at the strategy's "
                        f"own close for the rest of the UTC day")
    return (own, name) if verdict else (px, None)


# Widening windows so a closed market (weekend, Lunar New Year) still answers its last minute
_TAIFEX_WINDOWS_D = (1, 4, 14)


def _taifex_last(sym, hdrs):
    """Latest 1m Close of a TAIFEX code's continuous near-month series (the
    uncached server read: a mark must not wait on the monthly cache's tail)."""
    from datetime import datetime, timedelta, timezone
    from lib import data
    # R1 is the near-month alias; R2 (next month) is not this series and is asked as is (400 → no price)
    code = sym[:-2] if sym.endswith("R1") and len(sym) > 2 else sym
    root = _txf_root(code)
    series = "TXF" if root else code
    for days in _TAIFEX_WINDOWS_D:
        start = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d")
        try:
            df = data._fetch_twfutures_raw(series, "1m", start, None, hdrs)
        except data.DataAccessError:
            if root and data.tw_market_public_allowed():
                return _taifex_public_last(sym, root)
            raise PaperNoPrice(f"no TAIFEX price for {sym}: no Blave data access")
        except Exception as e:
            raise PaperNoPrice(f"no TAIFEX price for {sym}: {type(e).__name__}: {e}")
        if df is not None and len(df):
            return _last_close(df)
    raise PaperNoPrice(f"no TAIFEX price for {sym} in {_TAIFEX_WINDOWS_D[-1]} days")


def _taifex_public_last(sym, root):
    """TAIFEX's own daily close (key-less desktop). Outside _taifex_last's try: an
    error raised from its except block would escape as is and brick the account read."""
    from datetime import datetime, timedelta, timezone
    from lib import data
    start = (datetime.now(timezone.utc) - timedelta(days=_TAIFEX_WINDOWS_D[-1])).strftime("%Y-%m-%d")
    try:
        return _last_close(data.fetch_txf_daily_public(start, None, root))
    except PaperNoPrice:
        raise
    except Exception as e:
        raise PaperNoPrice(f"no TAIFEX daily close for {sym}: {type(e).__name__}: {e}")


def _us_owned(sym):
    """A strategy reads `sym` with fetch_usstock_price (its SYMBOL, or a Type C
    weight). The ticker alone is not enough: 'BTC' is also a US ETF."""
    for path in sorted(glob.glob("strategies/*/strategy.py")):
        try:
            with open(path) as f:
                src = f.read()
        except OSError:
            continue
        if "fetch_usstock_price" not in src:
            continue
        name = os.path.basename(os.path.dirname(path))
        if _strategy_symbol(name) == sym:
            return True
        try:
            w = load_json(os.path.join(os.path.dirname(path), "state.json")).get("weights")
        except (OSError, ValueError, AttributeError):
            continue
        if isinstance(w, dict) and sym in {_norm(k) for k in w}:
            return True
    return False


def _us_last(symbol):
    """Yahoo's latest final UNADJUSTED daily close (fetch_usstock_price's Close is the
    adjusted one). lib.data refuses every live tick → PaperNoPrice."""
    from lib import data
    try:
        return _last_close(data._usstock_daily(data._us_symbol(symbol), None))
    except PaperNoPrice:
        raise
    except Exception as e:
        raise PaperNoPrice(f"no US close for {symbol}: {type(e).__name__}: {e}")


# ── TW stocks: price, session ────────────────────────────────────────────────

# A stock suspended past the short window has no bar in it: its last close (up to the long
# window back) still prices the close-out — without one every order on it, closes included,
# is refused.
_TW_PRICE_WINDOWS_D = (14, 400)


_TW_SCHEMAS_MIN = ((60, "60m"), (30, "30m"), (15, "15m"), (5, "5m"), (1, "1m"))
_tw_price_note = {}  # code -> why the last price is not what its owner trades on


def tw_intraday_schema(interval):
    """The fetch_twstock_ohlcv schema an intraday INTERVAL's bar closes on (the longest
    one dividing it: 1h/4h → 60m, 15m → 15m); None for a daily or longer interval."""
    m = re.match(r"^(\d+)(min|m|h)$", str(interval or ""))
    if not m:
        return None
    mins = int(m.group(1)) * (60 if m.group(2) == "h" else 1)
    return next((sch for n, sch in _TW_SCHEMAS_MIN if mins % n == 0), None) if mins < 1440 else None


def tw_intraday_close(code, schema, hdrs):
    """[Taipei date, Close] of the latest unadjusted `schema` bar of a TW stock — the paper
    fill and mark of an intraday Type A, and the close the portfolio page sizes its shares
    with (lib/runner child), so both read the same bar. Needs Blave data (no CDN)."""
    from datetime import datetime, timedelta, timezone
    from lib import data
    start = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%d")
    df = data.fetch_twstock_ohlcv(code, schema, hdrs, start=start, adjust=False)
    px = _last_close(df)
    t = df.index[-1]
    t = (t.tz_localize("UTC") if t.tzinfo is None else t).tz_convert("Asia/Taipei")
    return [t.strftime("%Y-%m-%d"), px]


def tw_price_note(symbol):
    """Why a TW stock's paper price is the previous daily close rather than its intraday
    owner's latest bar (that bar could not be read); None when it is what the owner trades."""
    return _tw_price_note.get(re.sub(r"\.TWO?$", "", _norm(symbol)))


def _tw_owner_schema(symbol):
    name = _resolve_strategy(symbol)
    mod = _load_strategy(name) if name else None
    # lib/runner's default when a strategy sets no INTERVAL
    return tw_intraday_schema(getattr(mod, "INTERVAL", "1h")) if mod else None


def _tw_stock_price(symbol, hdrs):
    """Latest unadjusted Close of a TW stock. Daily: fetch_twstock_price, under
    the code the page's fetch_twstock_price_batch asks with (runner strips
    .TW/.TWO). Both are Blave-CDN first and read the same per-stock CDN file
    (lib.data _fetch_twstock_daily_cdn); only while the CDN is behind the
    latest final do they differ in where the missing days come from — this
    one the single Blave endpoint (desktop without access: the exchange), the
    page the Blave batch endpoint — same exchange numbers, separate caches.
    A symbol an intraday Type A
    trades takes that strategy's latest bar instead (tw_intraday_close, the bar
    the page sizes with) — the daily close would fill a 10:00 signal at the
    day before's close. That bar unreadable → the daily close, noted
    (tw_price_note). A Type C fetch_data is never run for it: a whole TW
    universe takes minutes, far past the account reader's 60s budget."""
    from datetime import datetime, timedelta, timezone
    from lib import data
    code = re.sub(r"\.TWO?$", "", _norm(symbol))
    schema = _tw_owner_schema(symbol)
    _tw_price_note.pop(code, None)
    if schema:
        try:
            return tw_intraday_close(code, schema, hdrs)[1]
        except Exception as e:
            log.warning(f"[paper_data] {code} {schema} bar unavailable ({type(e).__name__}: {e}) "
                        f"— the previous daily close")
            _tw_price_note[code] = f"previous daily close: the {schema} bar could not be read"
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
            w = load_json(path).get("weights")
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
        d = load_json(TW_DAY_PATH)
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
    if _txf_root(s) or _TW_STOCK_RE.match(s):
        return "TWD"
    if _TAIFEX_RE.match(s) and not _us_owned(s):
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
        d = load_json(FX_PATH)
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
