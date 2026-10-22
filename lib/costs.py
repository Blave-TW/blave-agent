"""Default per-side trading cost by market — the one table the backtest and paper read.

Each rate is ONE side (the engine charges |Δw| × FEE on every position change) and already
includes commission, tax and slippage: a conservative default, not a venue quote
(references/trading-costs.md). A strategy's own `FEE` overrides it in both places —
lib/runner reads `FEE` first, paper reads it through lib/paper_data.strategy_fee.
A market not in the table (US stocks, CME, TAIFEX stock futures) has no default: None.
"""
import re

DEFAULT_FEES = {
    "tw_stock": 0.005,             # TWSE / TPEx shares, day trades included
    "tw_etf": 0.003,               # ETF / ETN / REIT codes (is_tw_etf), bond ETFs included
    "crypto_perp": 0.001,          # USDT / USDC perps, stock perps included
    "crypto_spot": 0.0015,
    "tw_index_futures": 0.0001,    # TXF / MXF / TMF
}

_TW_CODE = re.compile(r"^\d{4,6}[A-Z]?(?:\.TWO?)?$")
_TAIFEX_INDEX = ("TXF", "MXF", "TMF")
_CRYPTO_QUOTES = ("USDT", "USDC")


def _norm(symbol):
    return str(symbol or "").split("@")[0].replace("-", "").replace("_", "").upper()


def is_tw_etf(symbol):
    """ETF 00…, REIT 01…T and ETN 02… codes (0050, 00679B, 01001T, 020000). Ordinary shares
    never start with 0."""
    return _norm(symbol).split(".")[0].startswith(("00", "01", "02"))


def market_of(symbol, market=None):
    """DEFAULT_FEES key for `symbol` (market = the strategy's MARKET, "spot" | "swap";
    only crypto tells the two apart), or None for a market the table does not cover."""
    s = _norm(symbol)
    if (s[:-2] if s.endswith(("R1", "R2")) else s) in _TAIFEX_INDEX:
        return "tw_index_futures"
    if _TW_CODE.match(s):
        return "tw_etf" if is_tw_etf(s) else "tw_stock"
    if s.endswith(_CRYPTO_QUOTES) and len(s) > 4:
        return "crypto_spot" if str(market or "").lower() == "spot" else "crypto_perp"
    return None


def default_fee(symbol=None, market=None, universe=None, fees=None):
    """Default per-side FEE for one symbol, or for a Type C `universe` (the highest member
    rate, so a mixed stock / ETF universe pays the stock rate). `fees` replaces table rows
    for one call — e.g. {"tw_stock": 0.003} — without touching DEFAULT_FEES. None when no
    symbol is in a covered market."""
    table = {**DEFAULT_FEES, **(fees or {})}
    keys = [market_of(s, market) for s in (universe if universe else [symbol])]
    rates = [table[k] for k in keys if k]
    return max(rates) if rates else None
