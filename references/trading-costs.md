# Trading costs — what to put in `FEE`

`FEE` is the cost of ONE side: the engine charges `|Δw| × FEE` on every position change, so a round trip pays it twice (`references/strategy-code.md` › *FEE is PER SIDE*). Holding costs (perp funding, borrow) are not in `FEE`.

## Defaults

One rate per market, per side, **already including commission, tax and slippage — a conservative estimate, not a venue quote.** The table lives in `lib/costs.DEFAULT_FEES`; this page only explains it.

| Market | Default per-side `FEE` | Covers |
|---|---|---|
| Taiwan stocks (TWSE / TPEx, day trades included) and warrants (TWSE `030001`–`089999` and `03001P`…`08999Y`; TPEx six characters `70…`–`73…`) | `0.005` (0.5%) | list commission 0.1425% + sell tax 0.3% ÷ 2 + spread, with room for a thin book. Warrants: a lower tax (0.1%) but wider spreads, so they take the stock rate as the conservative default; a thin warrant can still cost more — set `FEE` from its own spread then |
| Taiwan ETFs / ETNs / REITs (`lib.costs.is_tw_etf`: codes `00…`, `01…`, `02…`; bond ETFs included) | `0.003` (0.3%) | list commission + ETF sell tax 0.1% ÷ 2 + spread |
| Crypto perps (USDT / USDC, stock perps such as `NVDAUSDT` included) | `0.001` (0.1%) | taker 0.05–0.06% + spread on smaller coins |
| Crypto spot | `0.0015` (0.15%) | taker ~0.1% + spread |
| TAIFEX index futures TXF / MXF / TMF | `0.0001` (0.01%) | futures tax 0.002% + commission + slippage (≈ 4.6 index points at 46,293) |
| US stocks / ETFs (a strategy that prices with `fetch_usstock_price`) | `0.001` (0.1%) | Blave trades US stocks live as a venue's stock perp (`AAPLUSDT`-style), so they take the crypto perp rate — taker + spread. A user backtesting for their own broker (複委託 ≈ 0.12–0.15% a side, a zero-commission US broker ≈ 0.02%) should set `FEE` to that |

**The default is a starting point: adjust it to the user's own broker rate or the instrument's liquidity, and say which you used.**
- Lower it only with a real reason: the user's broker commission discount (e.g. 2.8折 → commission ≈ 0.04%), a confirmed VIP tier, a strategy that truly fills by resting limits, BTC/ETH on a top venue (taker 0.05% + almost no spread).
- Raise it for thin markets: small-cap TW stocks, coins outside the top 200, large orders (market impact), the TMF night session.
- In code: `from lib.costs import default_fee, fee_of`. `default_fee("2330")` → `0.005`; `default_fee("BTCUSDT", "spot")` → `0.0015`; a Type C `default_fee(universe=UNIVERSE)` → the highest member rate (a mixed stock / ETF universe pays the stock rate); a market the table does not cover → `None`. `fee_of(s)` → the strategy's `FEE`, else its market default.

Write the number into `FEE` as a plain constant with what it is in the comment, e.g. `FEE = 0.005  # per side: Blave TW stock default, incl. slippage` — `lib/quality_check.py` warns on a computed `FEE`, and paper reads only a plain number (the last `FEE =` in the file).

## Where the rate is used

- **Backtest, scans, walk-forward, MCPT**: `lib.costs.fee_of(s)` — the strategy's `FEE`, else the default for its `SYMBOL` / `MARKET` / `UNIVERSE`; a market not in the table (or a Type C whose universe is built inside `fetch_data`) gets `0.0005` with a warning — set `FEE` there. `run()` calls it itself; `scan_grid`, `run_walk_forward` and a manual `mcpt` take `fee=fee_of(s)` and refuse a missing `fee`.
- **Paper trading** (`lib/order_paper.py`): every fill — market, crossing limit, resting limit, SL/TP — pays one per-side rate, the one the backtest charged: from the strategies **in the 下單設定** that trade that symbol (its `SYMBOL`, the TXF family, or a Type C weight) **on that market** (spot vs perp; a TW code is shares either way) — their `FEE`, else their market default (a Type C: the highest over its universe). Drafts and copies outside the 下單設定 never count; several owners → the highest; none → the market default. A US ticker no owner covers but some strategy prices with `fetch_usstock_price` pays the US default. A market the table does not cover and no owner covers keeps paper's fixed rates (taker 0.05%, maker 0.02%, spot 0.10%). Changing `FEE` changes the next paper fill; past fills stay as booked.

## Markets without a default

| Market | Per-side `FEE` | How |
|---|---|---|
| CME / NYMEX and other futures | verify with the broker | commission + exchange fee + 1 tick per side as a fraction of notional (`examples/cl_sma` uses `0.0003`) |
| TAIFEX stock futures (CDF…) | verify with the broker | not modelled |
