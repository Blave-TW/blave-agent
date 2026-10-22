"""Binance's US stock perps under the names BingX and Bybit give them.

fetch_kline's candles are Binance USDⓈ-M, so a strategy on NVDAUSDT was backtested on
Binance's NVDA stock perp (exchangeInfo underlyingType EQUITY). Most venues list that
stock under the same name; two do not:
  BingX — NCSKNVDA2USD-USDT, and a few under a rename (NCSKCISCO2USD = CSCO; the
          displayName carries the ticker, except where a coin owns it: AMDUS-USDT).
  Bybit — AMDSTOCKUSDT, NOKIAUSDT … where a coin owns the bare name; underlyingTicker
          carries the ticker.
  Bitget — isRwa=YES rows; ACNSTOCKUSDT, BBSTOCKUSDT … where a coin owns the bare name
          (baseCoin ACNSTOCK: the ticker is baseCoin without the STOCK suffix).
Only names read from the venues' own public lists are used — never a guessed spelling:
a near-name is a different instrument (BingX NCSKSKHYNIX2USD is a KRW listing at 7×
the price of SKHY). Anything other than EQUITY keeps the plain mapping it had before.

venue_name() is the forward map (orders); canonical() is the inverse (positions and
open orders). The inverse is the half that costs money: a position read back as
NCSKNVDA2USDUSDT looks flat to the reconciler, which buys again every round.
"""
import re
import time

import requests

try:
    from lib import reject_token
except ImportError:  # half-updated workspace: the reason still reads, untagged
    from types import SimpleNamespace as _NS
    reject_token = _NS(tag=lambda kind, msg: str(msg), SYMBOL_UNAVAILABLE="symbol_unavailable")

BINANCE_INFO = "https://fapi.binance.com/fapi/v1/exchangeInfo"
INFO_TTL_S = 6 * 3600
INFO_RETRY_S = 300
# rows: symbol -> (underlyingType, baseAsset). A failed refresh keeps the last good rows.
_binance = {"rows": None, "at": 0.0, "failed_at": 0.0}

STOCK = "EQUITY"
_LABELS = {"bingx": "BingX", "bybit": "Bybit", "bitget": "Bitget"}


def binance_rows():
    now = time.time()
    c = _binance
    if (c["rows"] is None or now - c["at"] > INFO_TTL_S) and now - c["failed_at"] > INFO_RETRY_S:
        try:
            r = requests.get(BINANCE_INFO, timeout=(3, 10))
            r.raise_for_status()
            c["rows"] = {s["symbol"]: (s.get("underlyingType"), s.get("baseAsset"))
                         for s in r.json()["symbols"]}
            c["at"] = now
        except Exception as e:
            c["failed_at"] = now
            import logging
            logging.warning(f"[stock_perps] Binance exchangeInfo unreadable ({e})")
    return c["rows"]


def binance_class(sym):
    """Binance's underlyingType for `sym` (COIN, EQUITY, …); None = unreadable or not listed."""
    return ((binance_rows() or {}).get(sym) or (None, None))[0]


_BINGX_STOCK = ("NCSK", "NCSI")  # BingX files EWJ / EWY (ETFs) as NCSI, indices
_BINGX_ASSET = re.compile(r"^NC(?:SK|SI)(.+)2USD$")


def _is_stock_row(vid, r):
    if vid == "bingx":
        return str(r.get("symbol", "")).startswith(_BINGX_STOCK)
    if vid == "bitget":
        return r.get("isRwa") == "YES"
    return r.get("symbolType") in ("stock", "ETF")


def _tickers(vid, r):
    """The ticker(s) a venue's stock row names — what both directions key on, so a row reads
    back to exactly the strategy symbol that orders it. BingX: the asset NCSK<T>2USD and the
    displayName <T>-USDT (NCSKCISCO2USD shows CSCO-USDT). Bybit: underlyingTicker (US only); a
    row without one is its bare symbol."""
    if vid == "bingx":
        m = _BINGX_ASSET.match(str(r.get("asset") or ""))
        out = {m.group(1)} if m else set()
        d = str(r.get("displayName") or "")
        if d.endswith("-USDT"):
            out.add(d[:-5].strip())
        return out
    if vid == "bitget":
        # isRwa also covers commodities and HK names; only a Binance EQUITY ticker ever
        # looks a row up, so those never match one
        base = str(r.get("baseCoin") or "")
        return {base[:-5]} if base.endswith("STOCK") and len(base) > 5 else ({base} if base else set())
    t = r.get("underlyingTicker")
    if t:
        return {t} if r.get("marketRegion") == "US" else set()
    sym = str(r.get("symbol", ""))
    return {sym[:-4]} if sym.endswith("USDT") else set()


def _hits(vid, base, rows):
    return [r["symbol"] for r in rows if _is_stock_row(vid, r) and base in _tickers(vid, r)]


def _need_rows(vid, rows, what):
    if not rows:  # an empty list is a failed read, never "nothing renamed"
        raise requests.exceptions.ConnectionError(
            f"{_LABELS.get(vid, vid)} contract list empty — cannot name {what}")


def venue_name(vid, sym, rows):
    """The venue's name for a Binance US stock perp; None = not one (or Binance unreadable):
    the caller keeps its plain mapping. A stock with no single match on the venue raises
    symbol_unavailable rather than falling back to a same-name coin."""
    t = (binance_rows() or {}).get(sym)
    if not t or t[0] != STOCK or not sym.endswith("USDT"):
        return None  # SPCXUSD1 is USD1-margined; these venues list the USDT one only
    _need_rows(vid, rows, sym)
    hit = _hits(vid, t[1] or sym[:-4], rows)
    if len(hit) == 1:
        return hit[0]
    label = _LABELS.get(vid, vid)
    why = "沒有這檔股票永續" if not hit else f"有 {len(hit)} 檔對得上、無法確定是哪一檔"
    raise ValueError(reject_token.tag(reject_token.SYMBOL_UNAVAILABLE,
                                      f"{label} {why}（{sym}）"))


_by_base = {"src": None, "map": {}}


def _equity_by_base(b):
    if _by_base["src"] is not b:
        m = {}
        for s, (t, base) in b.items():
            if t == STOCK and s.endswith("USDT"):
                m.setdefault(base or s[:-4], []).append(s)
        _by_base.update(src=b, map=m)
    return _by_base["map"]


def canonical(vid, venue_sym, rows):
    """The strategy's name for a position / order row the venue reported as `venue_sym`
    (BingX already dashless: NCSKNVDA2USDUSDT), read off the row's own ticker. Unchanged when
    the row is not a stock or names no Binance US stock. Raises ConnectionError (transient:
    the round is skipped) when the name cannot be told — empty list, Binance unreadable, a
    ticker naming two Binance symbols, or a second venue row on the same ticker — because
    returning the venue's own name would read the strategy's holding as flat."""
    key = venue_sym.replace("-", "").upper()
    _need_rows(vid, rows, venue_sym)
    row = next((r for r in rows if str(r.get("symbol", "")).replace("-", "").upper() == key), None)
    if row is None or not _is_stock_row(vid, row):
        return key
    tickers = _tickers(vid, row)
    b = binance_rows()
    if b is None:
        if vid in ("bybit", "bitget") and tickers == {key[:-4]}:
            return key
        raise requests.exceptions.ConnectionError(
            f"Binance exchangeInfo unreadable — cannot name {_LABELS.get(vid, vid)} position {venue_sym}")
    eq = _equity_by_base(b)
    named = {s for t in tickers for s in eq.get(t, ())}
    if not named:
        return key
    if len(named) == 1:
        sym = next(iter(named))
        base = (b.get(sym) or (None, None))[1] or sym[:-4]
        if len(_hits(vid, base, rows)) == 1:
            return sym
    raise requests.exceptions.ConnectionError(
        f"{_LABELS.get(vid, vid)} position {venue_sym}: ticker {sorted(tickers)} names "
        f"{sorted(named)} on Binance / more than one {_LABELS.get(vid, vid)} row — not read as flat")


def us_signal_refusal(symbol, tickers):
    """Why a strategy whose signal comes from US daily bars of `tickers` (Yahoo spelling,
    lib.data._us_symbol) cannot trade `symbol` as that stock's perp — a sentence for the user
    — or None. The pairing is by name only, NVDA ↔ NVDAUSDT (BRK-B ↔ BRKBUSDT), and only for
    a symbol Binance lists as EQUITY: a ticker beside it that is not the traded stock is
    refused rather than read as a filter. Raises ConnectionError when Binance exchangeInfo is
    unreadable (the caller decides: a live tick skips the round, a save is not judged)."""
    sym = str(symbol or "").strip().upper()
    tickers = sorted({str(t).strip().upper() for t in tickers or ()})
    if not sym:
        return "沒有 SYMBOL,看不出要在哪一檔股票永續下單(例如 NVDA 的訊號要寫 SYMBOL = 'NVDAUSDT')"
    if not sym.endswith("USDT") or len(sym) <= 4:
        return f"SYMBOL 是 {sym},要寫成 Binance 股票永續的名稱(例如 NVDA → NVDAUSDT)"
    if not tickers:
        return "看不出訊號用的是哪一檔美股(fetch_usstock_price 的代號要直接寫在程式裡)"
    base = sym[:-4]
    off = [t for t in tickers if t.replace("-", "") != base]
    if off:
        return (f"訊號用的美股 {'、'.join(off)} 跟下單標的 {sym} 對不上"
                f"(只能用 {base} 自己的日線出訊號、下 {sym})")
    rows = binance_rows()
    if rows is None:
        raise requests.exceptions.ConnectionError(
            f"Binance exchangeInfo unreadable — cannot tell whether {sym} is a stock perp")
    t = rows.get(sym)
    if not t or t[0] != STOCK:
        return f"{sym} 不是 Binance 的股票永續,美股訊號只能下股票永續"
    if t[1] and t[1].upper() != base:
        return f"{sym} 在 Binance 對應的是 {t[1]},不是 {base}"
    return None


# Bitget's Taiwan stock perps — the only venue listing any (8, since 2026-10-19). Hand-written
# on purpose: the contract names are not TWSE tickers, and a prefix rule would be wrong
# (TWLOUSDT is Twilio, TWSTUSDT Twist Bioscience). 2492 is 華新科, not 1605 華新:
# 364 TWD / 11.18 USDT = 32.55 TWD per USDT on 2026-10-19, the day's USDTWD.
# One contract unit = one share, priced at the TWSE price ÷ USDTWD and settled in USDT (a
# converted price, not a quanto) — so a share count is the order's base qty as is, and its
# USDT value moves with USDTWD as well as the stock.
TW_TOKENS = {
    "2330": "TWTSMUSDT",    # 台積電
    "2308": "TWDELTAUSDT",  # 台達電
    "3711": "TWASXUSDT",    # 日月光投控
    "2303": "TWUMCUSDT",    # 聯電
    "2408": "NANYAUSDT",    # 南亞科
    "2344": "WINBONDUSDT",  # 華邦電
    "2327": "YAGEOUSDT",    # 國巨
    "2492": "WALSINUSDT",   # 華新科
}
_TW_CODES = {v: k for k, v in TW_TOKENS.items()}


def tw_token(code):
    """Bitget's contract for a TWSE stock code ('2330' → 'TWTSMUSDT'); None = no token."""
    return TW_TOKENS.get(str(code or "").strip())


def tw_code(venue_sym):
    """The TWSE code a Bitget contract tracks ('TWTSMUSDT' → '2330'); None = not a TW token."""
    return _TW_CODES.get(str(venue_sym or "").replace("-", "").upper())
