"""Default per-side trading cost by market — the one table the backtest and paper read.

Each rate is ONE side (the engine charges |Δw| × FEE on every position change) and already
includes commission, tax and slippage: a conservative default, not a venue quote
(references/trading-costs.md). A strategy's own `FEE` overrides it everywhere: fee_of() for
the backtest, scans, walk-forward and MCPT; lib/paper_data.strategy_fee for paper fills.
"""
import logging
import re

from lib.paper_data import _TW_STOCK_RE, _norm, _txf_family

DEFAULT_FEES = {
    # TWSE / TPEx shares, day trades included — and warrants (TWSE 030001–089999 and
    # 03001P/U/T/F/Q/C/B/X/Y–08999…, TWSE warrant FAQ; TPEx 70…–73… six characters, TPEx
    # warrant quotes 2026-10-22): their spread is wider than a stock's, so this is conservative
    "tw_stock": 0.005,
    "tw_etf": 0.003,               # ETF / ETN / REIT codes (is_tw_etf), bond ETFs included
    "crypto_perp": 0.001,          # USDT / USDC perps, stock perps included
    "crypto_spot": 0.0015,
    "tw_index_futures": 0.0001,    # TXF / MXF / TMF
    "us_stock": 0.001,             # a fetch_usstock_price strategy: traded live as a venue's stock perp
}
# a market the table does not cover and a strategy without FEE: the engine's old default
UNCOVERED_FEE = 0.0005


_US_TICKER = re.compile(r"^[A-Z]{1,5}(?:\.[A-Z]{1,2})?$")  # AAPL, SPY, BRK.B (BRK-B normalizes to BRKB)


def reads_usstock(src):
    """A strategy source (text) that prices with fetch_usstock_price — what makes its ticker a
    US stock: the symbol alone cannot tell (TMF is a TAIFEX root and a US ETF, BTC an ETF)."""
    return "fetch_usstock_price" in (src or "")


def _code(symbol):
    return _norm(str(symbol or "").split("@")[0])


def is_tw_etf(symbol):
    """ETF 00…, REIT 01…T and ETN 02… codes (0050, 00679B, 01001T, 020000)."""
    return _code(symbol).split(".")[0].startswith(("00", "01", "02"))


def market_of(symbol, market=None, us=False):
    """DEFAULT_FEES key for `symbol` (market = the strategy's MARKET, "spot" | "swap";
    only crypto tells the two apart; us = the strategy reads fetch_usstock_price), or None
    for a market the table does not cover."""
    s = _code(symbol)
    if us and _US_TICKER.match(s):
        return "us_stock"
    if _txf_family(s):
        return "tw_index_futures"
    if _TW_STOCK_RE.match(s):
        return "tw_etf" if is_tw_etf(s) else "tw_stock"
    if s.endswith(("USDT", "USDC")) and len(s) > 4:
        return "crypto_spot" if str(market or "").lower() == "spot" else "crypto_perp"
    return None


def default_fee(symbol=None, market=None, universe=None, us=False):
    """Default per-side FEE for one symbol, or for a Type C `universe` (the highest member
    rate, so a mixed stock / ETF universe pays the stock rate). None when no symbol is in a
    covered market."""
    rates = [DEFAULT_FEES[k] for k in (market_of(s, market, us) for s in (universe or [symbol])) if k]
    return max(rates) if rates else None


def fee_of(strategy):
    """The per-side FEE a strategy (its module, or run()'s config dict) is backtested with:
    its own FEE, else default_fee for its SYMBOL / MARKET / UNIVERSE, else UNCOVERED_FEE
    with a warning. Pass it to scan_grid / run_walk_forward / mcpt: fee=fee_of(s)."""
    get = strategy.get if isinstance(strategy, dict) else (lambda k: getattr(strategy, k, None))
    if get("FEE") is not None:
        return get("FEE")
    sym, universe = get("SYMBOL"), get("UNIVERSE")
    try:
        with open(get("__file__") or "", encoding="utf-8") as f:
            us = reads_usstock(f.read())
    except (OSError, ValueError):
        us = False
    fee = default_fee(sym, get("MARKET"), universe, us)
    if fee is None:
        why = "no SYMBOL or UNIVERSE to tell the market" if not (sym or universe) \
            else f"{sym or 'its UNIVERSE'} is not in lib.costs.DEFAULT_FEES"
        logging.warning(f"[costs] no FEE and no market default ({why}) — using "
                        f"{UNCOVERED_FEE}; set FEE in the strategy (references/trading-costs.md)")
        return UNCOVERED_FEE
    return fee
