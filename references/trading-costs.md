# Trading costs — what to put in `FEE`

`FEE` is the cost of ONE side: the engine charges `|Δw| × FEE` on every position change, so a round trip pays it twice (`references/strategy-code.md` › *FEE is PER SIDE*). Holding costs (perp funding, borrow) are not in `FEE`.

## Defaults

One rate per market, per side, **already including commission, tax and slippage — a conservative estimate, not a venue quote.** The table lives in `lib/costs.DEFAULT_FEES`; this page only explains it.

| Market | Default per-side `FEE` | Covers |
|---|---|---|
| Taiwan stocks (TWSE / TPEx, day trades included) | `0.005` (0.5%) | list commission 0.1425% + sell tax 0.3% ÷ 2 + spread, with room for a thin book |
| Taiwan ETFs / ETNs / REITs (`lib.costs.is_tw_etf`: codes `00…`, `01…`, `02…`; bond ETFs included) | `0.003` (0.3%) | list commission + ETF sell tax 0.1% ÷ 2 + spread |
| Crypto perps (USDT / USDC, stock perps such as `NVDAUSDT` included) | `0.001` (0.1%) | taker 0.05–0.06% + spread on smaller coins |
| Crypto spot | `0.0015` (0.15%) | taker ~0.1% + spread |
| TAIFEX index futures TXF / MXF / TMF | `0.0001` (0.01%) | futures tax 0.002% + commission + slippage (≈ 4.6 index points at 46,293) |

**The default is a starting point: adjust it to the user's own broker rate or the instrument's liquidity, and say which you used.**
- Lower it only with a real reason: the user's broker commission discount (e.g. 2.8折 → commission ≈ 0.04%), a confirmed VIP tier, a strategy that truly fills by resting limits, BTC/ETH on a top venue (taker 0.05% + almost no spread).
- Raise it for thin markets: small-cap TW stocks, coins outside the top 200, large orders (market impact), the TMF night session.
- In code: `from lib.costs import default_fee; default_fee("2330")` → `0.005`; `default_fee("BTCUSDT", "spot")` → `0.0015`; a Type C `default_fee(universe=UNIVERSE)` → the highest member rate (a mixed stock / ETF universe pays the stock rate). A market the table does not cover returns `None`.

Write the number into `FEE` as a plain constant with what it is in the comment, e.g. `FEE = 0.005  # per side: Blave TW stock default, incl. slippage` — `lib/quality_check.py` warns on a computed `FEE`, and paper only reads a plain number.

## Where the rate is used

- **Backtest, scans, walk-forward, MCPT**: the strategy's `FEE` (the scans take `fee=s.FEE`). A strategy without `FEE` gets `lib.costs.default_fee` for its `SYMBOL` / `MARKET` / `UNIVERSE`, `0.0005` for a market not in the table.
- **Paper trading** (`lib/order_paper.py`): every fill — market, crossing limit, resting limit, SL/TP — pays one per-side rate, the same one the backtest charged: the `FEE` of the strategy trading that symbol (its `SYMBOL`, the TXF family, or a Type C weight); several strategies on one symbol → the highest; none → the market default above. A market the table does not cover and no strategy covers keeps paper's fixed rates (taker 0.05%, maker 0.02%, spot 0.10%). Changing `FEE` changes the next paper fill; past fills stay as booked.

## Markets without a default

| Market | Per-side `FEE` | How |
|---|---|---|
| US stocks via a Taiwan broker (複委託), e-trading | ≈ `0.0012`–`0.0015` | commission ≈ 0.08–0.25% + a share of the TWD↔USD conversion spread + half spread — estimate, confirm with the user's broker |
| US stocks, zero-commission US broker | ≈ `0.0002` | SEC fee on the sell + FINRA TAF + half spread — estimate |
| CME / NYMEX and other futures | verify with the broker | commission + exchange fee + 1 tick per side as a fraction of notional (`examples/cl_sma` uses `0.0003`) |
| TAIFEX stock futures (CDF…), warrants | verify with the broker | not modelled |
