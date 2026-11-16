"""Strategy SYMBOL (dashless, BTCUSDT) → OKX instId — the one mapping lib/order_okx orders with
and lib/data.fetch_okx_kline reads bars with, so both name the same contract.

Its own module because importing lib/order_okx marks the process as a money process
(lib/guard.mark_money_process); a backtest that only reads bars must not be one.
"""
try:
    from lib import reject_token
except ImportError:  # half-updated workspace: the reason still reads, untagged
    from types import SimpleNamespace as _NS
    reject_token = _NS(tag=lambda kind, msg: str(msg), SYMBOL_UNAVAILABLE="symbol_unavailable")


def swap_inst(sym):
    """Canonical dashless (BTCUSDT) → OKX swap instId (BTC-USDT-SWAP)."""
    sym = (sym or "").replace("-", "").upper()
    if sym.endswith("USDT"):
        return f"{sym[:-4]}-USDT-SWAP"
    if sym.endswith("USDC"):
        return f"{sym[:-4]}-USDC-SWAP"
    raise ValueError(reject_token.tag(reject_token.SYMBOL_UNAVAILABLE, f"cannot derive OKX swap instId from {sym!r}"))


def spot_inst(sym):
    """Canonical dashless (BTCUSDT) → OKX spot instId (BTC-USDT)."""
    sym = (sym or "").replace("-", "").upper()
    if sym.endswith("USDT"):
        return f"{sym[:-4]}-USDT"
    if sym.endswith("USDC"):
        return f"{sym[:-4]}-USDC"
    raise ValueError(reject_token.tag(reject_token.SYMBOL_UNAVAILABLE, f"cannot derive OKX spot instId from {sym!r}"))
