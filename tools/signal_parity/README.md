# Signal parity replay

Bar-by-bar comparison of what two versions of `lib/` + `manager/` write to `state.json` when a
strategy's live tick is replayed over the same cached parquet. It exists because the ship gate for
any change to the live tick path (0.1.22 ②: wait_for_bar check + strategy in one interpreter,
`BLAVE_EXPECTED_BAR`) is **zero signal difference**, not a CPU number.

Not shipped: `tools/` is not an official dir (`references/updating.md`, desktop `OFFICIAL_DIRS`),
so changing it needs no `VERSION` bump. Minimal check: `tests/check_signal_parity_tool.py`.

## Usage

```
.venv/bin/python tools/signal_parity/replay.py \
    --strategy examples/btc_sma_cross \
    --cache ~/Desktop/blave/blave-agent/cache/kline3_1h_BTCUSDT \
    --bars 2026-09-29T00:00..2026-09-30T23:00 \
    [--old-ref origin/main] [--new-lib /path/to/checkout] [--every 4] [--out DIR]
```

- `--strategy DIR` — any strategy dir (`strategy.py` inside); `--sample KIND` generates one of
  `samples.py`'s matrix strategies instead (`--sample-arg k=v` to set symbol / interval / start / …).
  `STRATEGY_NAME` and `INTERVAL` are read as text and must be string literals.
- `--cache SRC[=NAME]` — a cache dataset (monthly dir or single parquet) copied into each side's
  workspace as `cache/NAME`; repeat for every dataset the strategy's `fetch_data` reads. `=NAME`
  maps an old-namespace dataset into the name the current lib reads (e.g.
  `twfutures_1m_TXF=twfutures3_1m_TXF`).
- `--bars FROM..TO` — naive UTC bar labels (open time, what wait_for_bar calls `expected`),
  inclusive. Default: only labels present in **every** `--cache` dataset (the ticks wait_for_bar
  would run — its probe waits for all of them); `--all-slots` replays every interval slot instead
  (how the not-ready path gets exercised once the runner has the gate) and is refused when the
  cached labels sit off the interval grid (TXF 1d 16:00 / 60m :45 labels — the gate side would
  never be ready). `--every N` / `--max N` thin the list; without `--bars` the last 20 cached bars.
- old side = `git archive <--old-ref>` of `lib/` + `manager/` (or `--old-lib DIR`); new side =
  this checkout (or `--new-lib DIR`). Both are labelled in the output header.
- Keep `--out` outside the checkout: the replay workspaces' `dotenv_values()` walks up and would
  find the repo's `.env` (the tool warns).

Output under `--out` (a kept temp dir by default): `parity.tsv` (one row per bar: both exit codes,
both values, equal, seconds, note), `diffs.tsv`, `logs/<side>/<bar>.log` (tick stdout+stderr), and
the two workspaces (`old/`, `new/`) with their `strategies/<name>/state.json`, `strategy.log`, `cache/`.

Exit codes: 0 every compared bar identical · 1 a bar differs, a side exited 0 without writing
`state.json`, or no bar could be compared at all · 2 a tick crashed / timed out on either side ·
3 setup or usage error.

## What a replayed tick is

Per bar and per side, one interpreter runs `strategies/<name>/strategy.py` as `__main__` (via
`_tick.py`) with `BLAVE_MODE=live`, `BLAVE_EXPECTED_BAR=<label>`, `BLAVE_AGENT_HOME` and
`BLAVE_AGENT_BASE` pointing into the workspace (no Telegram config, no runtime events channel —
on an agent machine the defaults would be the real ones) and every other `BLAVE*` / `TZ` stripped
(the listener's env shape). Before the strategy imports anything:

- network is blocked (`requests` and raw sockets) — a cache miss fails the tick loudly, it never
  fetches;
- `lib.data._extend_cache_monthly` / `_extend_cache_single` get an empty fetcher and their result
  is cut to `index <= label` — the frame a live fetch returned once that bar had closed (the forming
  bar gone, later bars not yet in existence). The runner's own `closed_bars_only()` then drops
  nothing more, so the path through the runner is the real one. The batch fetchers
  (`_fetch_batch_cached`, Taiwan `*_batch`) extend each cached id through the same two functions,
  so a strategy whose ids are all cached replays offline (its log shows the batch prefetch hitting
  the network block, harmless); an uncached id needs the network and fails the tick with
  `BatchIncomplete`;
- Telegram / web-chat sends are no-ops.

`state.json` carries from bar to bar on each side (the first tick seeds it from the signal, as the
runner does on a fresh deployment; `--seed-state FILE` starts both sides from a given state).

Compared surface — Type A: `position` plus the `close=` the runner logged for that tick
(`signal=… close=…` in `strategy.log`), so the same position computed on a different bar is a
difference; Type C: `weights` and `bar_at` (exact dict equality). Floats are compared exactly
(NaN equals NaN) — a 1e-16 drift in a vol-scaled position is an order-size difference and should
show up. A side that exits 0 without a `state.json` is never "identical".

Not-ready (exit 75, the runner's gate once it exists): both sides → the bar is skipped; one side →
noted as "<side> not ready (not a signal difference)" and counted in the summary, **unless** that
side's state moved while it claimed not-ready — then it is a difference. The old lib has no gate, so
a one-sided 75 is the tool seeing the gate, not the signal.

Limits (fidelity, not comparison): data lateness is not replayed (an alpha feed that published late
live has all its rows in the cache — both sides see the same frame); the wall clock is not pinned
(`updated_at`, `_drop_forming_bar`'s `now`); the cut applies to every DatetimeIndex frame that
passes the extenders, including future-dated tables (dividend calendars) live would see; the TXF
1m store mixes minute-start and minute-end labels by day (`lib/data.py` `_fetch_twfutures_via_export`
notes), so on minute-end days live saw one more bar than the cut — identical on both sides, but not
the live frame. Live-vs-replay (design §3 B `data_bar`) is what closes those gaps.

## Matrix (what `samples.py` + `examples/` cover, and what still needs data)

| cell | strategy | data needed |
|---|---|---|
| A crypto 1h | `examples/btc_sma_cross`, `--sample a_sma` | `kline3_1h_BTCUSDT` |
| A crypto 1d | `--sample a_sma --sample-arg interval=1d` | `kline3_1d_BTCUSDT` |
| A crypto 5min | `examples/btc_ti_5min` (needs the alpha too), `a_sma interval=5min` | `kline3_5min_BTCUSDT` (+ `taker_intensity_5min_BTCUSDT_24h`) |
| A crypto 1m | `a_sma interval=1m` | `kline3_1m_BTCUSDT` |
| A TXF 1m (night session across Taipei midnight, settlement day) | `examples/txf_ma_1m` | `twfutures3_1m_TXF` |
| A TXF 1d | `--sample a_sma_txf --sample-arg schema=1d` | `twfutures3_1d_TXF` |
| C crypto 1h / 1d | `--sample c_mom --sample-arg symbols=BTCUSDT,ETHUSDT` | `kline3_<interval>_{BTCUSDT,ETHUSDT}` |
| C 1m / 5min | `c_mom interval=1m|5min` | minute klines for ≥ 2 symbols |
| C Taiwan, batch path | `--sample c_tw_mom` (20 cached large caps), `examples/twstock_momentum` | `twstock_price_<id>.parquet` for every id in the universe |
| C Taiwan with a flow feed (`examples/tw100_foreign_zscore`) | — | `twstock_inst_<id>.parquet` for all 100 ids (locally only 2330) |
| top-level `import pandas` | `--sample a_pandas_top` | as A crypto |
| no `run()` (legacy own `__main__`) | `--sample a_legacy_norun` | as A crypto |

`a_sma_txf` sizes its windows to the schema (1m: SMA 5 700 / 22 800 bars, vol 34 200) — open the
bar window at least 30 trading days after `START`.
