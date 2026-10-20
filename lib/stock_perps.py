"""Binance's US stock perps under the names BingX and Bybit give them.

fetch_kline's candles are Binance USDⓈ-M, so a strategy on NVDAUSDT was backtested on
Binance's NVDA stock perp (exchangeInfo underlyingType EQUITY). Most venues list that
stock under the same name; two do not:
  BingX — NCSKNVDA2USD-USDT, and a few under a rename (NCSKCISCO2USD = CSCO; the
          displayName carries the ticker, except where a coin owns it: AMDUS-USDT).
  Bybit — AMDSTOCKUSDT, NOKIAUSDT … where a coin owns the bare name; underlyingTicker
          carries the ticker.
Only names read from the venues' own public lists are used — never a guessed spelling:
a near-name is a different instrument (BingX NCSKSKHYNIX2USD is a KRW listing at 7×
the price of SKHY). Anything other than EQUITY keeps the plain mapping it had before.

venue_name() is the forward map (orders); canonical() is the inverse (positions and
open orders). The inverse is the half that costs money: a position read back as
NCSKNVDA2USDUSDT looks flat to the reconciler, which buys again every round.
"""
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
_LABELS = {"bingx": "BingX", "bybit": "Bybit"}


def binance_rows():
    now = time.time()
    c = _binance
    if (c["rows"] is None or now - c["at"] > INFO_TTL_S) and now - c["failed_at"] > INFO_RETRY_S:
        try:
            r = requests.get(BINANCE_INFO, timeout=10)
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


def _bingx_match(base, rows):
    stocks = [r for r in rows if str(r.get("symbol", "")).startswith(_BINGX_STOCK)]
    exact = [r["symbol"] for r in stocks if r.get("asset") in (f"NCSK{base}2USD", f"NCSI{base}2USD")]
    if exact:
        return exact
    for name in (f"{base}-USDT", f"{base}US-USDT"):
        hit = [r["symbol"] for r in stocks if r.get("displayName") == name]
        if hit:
            return hit
    return []


def _bybit_match(sym, base, rows):
    stocks = [r for r in rows if r.get("symbolType") in ("stock", "ETF")]
    hit = [r["symbol"] for r in stocks
           if r.get("underlyingTicker") == base and r.get("marketRegion") == "US"]
    if len(hit) > 1 and sym in hit:
        return [sym]
    if hit:
        return hit
    return [r["symbol"] for r in stocks if r["symbol"] == sym and not r.get("underlyingTicker")]


def _match(vid, sym, base, rows):
    return _bingx_match(base, rows) if vid == "bingx" else _bybit_match(sym, base, rows)


def venue_name(vid, sym, rows):
    """The venue's name for a Binance US stock perp; None = not one (or Binance unreadable):
    the caller keeps its plain mapping. A stock with no single match on the venue raises
    symbol_unavailable rather than falling back to a same-name coin."""
    t = (binance_rows() or {}).get(sym)
    if not t or t[0] != STOCK or not sym.endswith("USDT"):
        return None  # SPCXUSD1 is USD1-margined; these venues list the USDT one only
    hit = _match(vid, sym, t[1] or sym, rows)
    if len(hit) == 1:
        return hit[0]
    label = _LABELS.get(vid, vid)
    why = "沒有這檔股票永續" if not hit else f"有 {len(hit)} 檔對得上、無法確定是哪一檔"
    raise ValueError(reject_token.tag(reject_token.SYMBOL_UNAVAILABLE,
                                      f"{label} {why}（{sym}）"))


def canonical(vid, venue_sym, rows):
    """The strategy's name for a position / order row the venue reported as `venue_sym`
    (BingX already dashless: NCSKNVDA2USDUSDT). Unchanged when it is not a renamed stock.
    A renamed-looking row with Binance unreadable raises ConnectionError — reading it as
    some other symbol would show the strategy's holding as flat."""
    key = venue_sym.replace("-", "").upper()
    renamed = {r["symbol"].replace("-", "").upper() for r in rows
               if (vid == "bingx" and str(r.get("symbol", "")).startswith(_BINGX_STOCK))
               or (vid == "bybit" and r.get("symbolType") in ("stock", "ETF"))}
    if key not in renamed:
        return key
    b = binance_rows()
    if b is None:
        if vid == "bybit" and key in {f"{r.get('underlyingTicker')}USDT" for r in rows
                                      if r["symbol"] == key}:
            return key
        raise requests.exceptions.ConnectionError(
            f"Binance exchangeInfo unreadable — cannot name {_LABELS.get(vid, vid)} position {venue_sym}")
    inv = {}
    for s, (t, base) in b.items():
        if t == STOCK and s.endswith("USDT"):
            hit = _match(vid, s, base or s, rows)
            if len(hit) == 1:
                inv.setdefault(hit[0].replace("-", "").upper(), s)
    return inv.get(key, key)
