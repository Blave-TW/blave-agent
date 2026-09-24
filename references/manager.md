# Manager & Reconciler

## Files

- `manager/management_backtest.py` — portfolio walk-forward backtest
- `manager/manager.py` — portfolio optimizer
- `manager/reconciler.py` — position reconciler (polling loop)
- `manager/stop_strategy.py` / `manager/close_symbol.py` — stop one strategy / close one coin (see *Stopping one strategy / closing one coin*)
- `manager/portfolio_config.json` — gitignored; written by manager.py; also contains `"exchanges"` dict (see below)
  - **No `portfolio_config.json` at all (amounts never saved) = the reconciler is read-only:** it reads and reports positions and sends no order, closes included (`lib/portfolio.reconcile`). `manager/flatten.py` (the web 暫停並全部平倉 button, and the HALT flatten) is not scoped by it, but it closes only the bot's own book (see *self_ledger*) — never the user's manual positions (spot: min(book quantity, wallet); see the spot-fee caveat there). Setting amounts to 0 closes the bot's own positions — that saves a config.

**CRITICAL — `manager/` holds platform scripts and their own output.** All output (portfolio_config.json, pnl.png, stats.json) is written by the scripts themselves. Never create a `manager/manager/` or any other nested folder — it breaks path resolution in all three scripts. Never delete any file in `manager/` when removing strategies.

What may be added and edited in here is a closed list:

- **`manager/executors/<name>.py`** — a custom execution style, the only new file this directory takes (`references/lib.md` › *Custom executors*; the loader in `lib/execute.py` reads exactly that path).
- **`manager/reconciler.py`** — hand-wired venue plumbing, and only that: `get_positions()` / `place_order()` for a venue without an official lib (see *reconciler.py* below and `references/lib.md`). Official venues are auto-wired — do not touch it for them.
- **`manager/manager.py` and `manager/management_backtest.py` — never.** A new weighting method, including a variant of the built-in optimiser, is a new `allocators/<name>/allocator.py` (`references/allocator-code.md` › *Never edit the built-in*).

## management_backtest.py

Simulates the manager's dynamic allocation day by day (strictly out-of-sample). Compares against random static portfolios as benchmark. Run BEFORE going live to validate combined portfolio performance.

```
python3 manager/management_backtest.py [--lookback 365] [--random-n 1000]
```

When the user asks to backtest the portfolio / combined strategies, use THIS script — not individual strategy backtests.

## manager.py

Reads all `strategies/*/stats.json` (daily_returns) and computes portfolio weights with the chosen method — by default `equal`, every strategy the same share. Writes weights + leverage to `manager/portfolio_config.json` — **only with `--apply`**.

```
python3 manager/manager.py --members a,b,c --allocator equal            # dry-run
python3 manager/manager.py --members a,b,c --allocator equal --apply    # write config
```

`--target-vol`: sets target annual volatility; computes `leverage = target_vol / ann_vol`, where `ann_vol` is realized over the **trailing 90 days only** (`VOL_WINDOW`) — volatility clusters, so a regime from years back must not dilute what leverage is safe today. Sharpe and the walk-forward still use the full history; the proposal reports the days actually used as `vol_window_days`. A weighted strategy whose backtest has no data inside that window looks risk-free, which understates `ann_vol` and overstates the leverage derived from it — the script prints a `WARNING:` naming the strategy and how many days are missing. **Re-run those backtests before sizing anything on that leverage.** **Omit it and the account's own `target_vol_pct` is used** — passing a value overwrites that setting on `--apply`, so only pass one when the user asked to change it.

**Name the method explicitly on `--apply`.** Omitting `--allocator` resolves to the method the live config was applied with (a config with no `allocator`, or a null one, means `slope` — it predates `equal`); only a portfolio that has never been applied falls to the default. That keeps a bare re-run from silently re-weighting live positions, but the command reads clearer when the method is spelled out.

`--allocator <name>`: the weighting method — a built-in (`equal`, the default when the flag is omitted, or `slope`) or `allocators/<name>/allocator.py`. `management_backtest.py` takes the same flag and writes its output to `allocators/<name>/` so each method keeps its own `stats.json` + `pnl.png`. Contract, validation rules, and the create → backtest → dry-run → apply workflow: **`references/allocator-code.md`**. The `--apply` confirmation rule below applies identically to allocator runs.

**Members with different history — the backtest clips, the proposal fills.** The members rarely start and stop together, and the two scripts handle that differently on purpose.

`management_backtest.py` clips its **whole run** — fitting window included — to the **overlap**, the days every member has data. Outside the overlap a "portfolio" is one or two live members plus dead capital in the legs that do not exist yet, so the curve there measures which member is oldest, not the weighting method: 32321's six members spanned 4576 days on the union but only 1306 together, and 78% of that headline was a single strategy, diluted. `stats.json` records `member_spans` (each member's first/last backtest day) and `overlap` (`start`/`end`/`eval_days`, now the same period as `start`/`end`), and the stdout says how many days were dropped and which member set each bound. Nothing is filled, so there is no `absent_fill_annual_pct` / `absent_days` in a backtest result. Two ways it refuses (both exit 3, reason on the last stderr line): the members share **no** day → `no overlapping days: …` (re-run the stale member or drop one; shrinking the window cannot help), or the overlap is not longer than `--lookback` → the usual `insufficient history: N days <= lookback L`, which the page turns into 「改跑 N 天」. The page's own pre-check still bounds by the **union**, deliberately: `blave-agent` updates are user-initiated, so a page that pre-blocked on the overlap would lock out every machine still running the old union backtest. It therefore under-blocks, and the machine's exit 3 supplies the truth.

`manager.py` cannot clip — a member that joined 60 days ago still has to be sized today — so it proposes from the last `lookback` days of the **union**, and a day a strategy had **no data at all** is charged `ABSENT_FILL_ANNUAL` (−2%/yr) *while the method fits*, counted as 0 everywhere the numbers are reported. Filling with 0 on both sides is what produced the old failure: the built-in methods maximise a ratio, an absent leg adds neither return nor variance, so its weight cancels out of the objective and the optimiser allocated to strategies with no history at random, redrawing every day. The charge is proportional to how much of the window is missing, so it decays as a young strategy accumulates days — and, being small, it barely dents a leg that has merely gone stale for a few weeks. The proposal records `absent_fill_annual_pct` and prints the missing days per member. Non-trading days are not absent: every strategy is resampled to calendar days with an explicit 0. Check: `python3 manager/check_absent_fill.py`.

The beats% is a **reference figure, not a verdict**: measured on real data, re-running it on a different sub-period moves it by tens of points, so never present it as a pass/fail bar.

Flags both scripts share (these are what the workspace's 投資組合 page drives; the agent can use them too):

- `--members a,b,c` — restrict to those strategies (directory names under `strategies/`). Unknown name → exit 2, nothing written.
- `--params-json '{"k": v}'` — override an allocator's `PARAMS` for this run (declared keys only). `slope` declares `lookback` (it fits on that window); `equal` declares nothing — it has no window, and the walk-forward treats every day as out of sample for it. `--target-vol` is not a method knob at all: it scales leverage and is no longer offered on the page.
- `manager.py --json PATH` — also write the dry-run proposal as JSON (weights, sharpe, leverage, `history_days`…). `management_backtest.py --progress PATH` — write `{day, total}` during the walk-forward. `stats.json` additionally carries `members`, `params`, `managed_cum`, `member_spans`, `overlap` (`start`/`end`/`eval_days`) and `random_benchmark.band` + `band_start` (per-day p5/p50/p95 cumulative %).
- Exit codes: 2 = bad input (reason is the last stderr line); `management_backtest.py` exits 3 when the members share no day at all, or share fewer days than `--lookback` needs.

The page writes `manager/proposal.json`, `manager/mgmt_job.json`, `manager/mgmt_progress.json` — never edit or delete them by hand.

**manager.py never touches `account_value`.** It only writes `weights` and `leverage`. `account_value` is the live position-sizing base (`contribution = account_value * leverage * weight * position`), so changing capital is a separate, explicit action: edit `portfolio_config.json["account_value"]` by hand. There is intentionally no `--account` flag — updating weights must not be able to resize live positions.

**`--apply` flag — protects live trading.** Default is dry-run: weights are computed and printed but `portfolio_config.json` is untouched, so a research run can never silently change the weights the live reconciler is trading on. The optimiser is seeded (`np.random.seed(42)`), so the `--apply` re-run produces exactly the weights shown in the dry-run (same stats.json inputs).

Required workflow:
1. Run `python3 manager/manager.py` (no `--apply`) and show the user the proposed weights.
2. Ask for explicit confirmation that these weights should go live.
3. Only after the user confirms, re-run the SAME command with `--apply` appended.
4. Never pass `--apply` on the first run, and never assume confirmation from context.

## portfolio_config.json — Exchange Routing

`manager.py` writes `weights` and `leverage`. You must manually add (or update) the `"exchanges"` dict whenever a strategy is deployed or moved to a different exchange:

```json
{
  "account_value": 10000,
  "leverage": 1.2,
  "weights":   { "btc_ti_long": 0.5, "btc_ti_short": 0.5 },
  "exchanges": { "btc_ti_long": "okx", "btc_ti_short": "okx" }
}
```

- Exchange routing is **not** in the strategy file — strategy files have no `EXCHANGE` field.
- Strategies missing from `"exchanges"` are silently skipped by the reconciler.
- The same strategy can be pointed at a different exchange by changing only this file.
- Valid values: any string the `place_order()` implementation in `reconciler.py` recognises (e.g. `"okx"`, `"taifex"`).

## reconciler.py

Polls every 5 seconds; only reconciles when a strategy's `state.json` mtime changes (plus `state/execution/kick`, touched when an async execution completes). `get_positions()` and `place_order()` are exchange-specific stubs to fill in once. `lib/portfolio.py` contains `reconcile()` logic; applies `leverage` from portfolio_config.

**Execution styles:** on auto-wired official venues, `place_order()` routes through `lib.execute.dispatch_order`, which reads `portfolio_config["execution"]` (per-strategy 市價/TWAP/custom — see `references/lib.md` › *Execution styles*). TWAP/custom run in a background thread; while one is in flight for a symbol, further legs for that symbol return `False` (deferred) and the residual gap re-reconciles after completion. Hand-wired venues (TW brokers) bypass this entirely.

**Wiring exchange order libraries (required, not optional):** `get_positions()` and `place_order()` must call into a `lib/order_*.py` helper — never remain as `raise NotImplementedError`. When writing a new order library, immediately update `reconciler.py` to import and call it in the same session.

**Auto-halt on exchange disconnect:** `reconciler.py` wraps `get_positions()` in `_get_positions_guarded()`, which classifies every failed read with the bound venue's `lib/account_<venue>.classify(exc)` (shared floor: `lib/venue_errors.py`) — body error code first, HTTP status as fallback, tables taken from each venue's official error-code docs (never from ccxt's maps, which disagree with the docs):
- **TRANSIENT** — venue busy / down / rate-limited, timeouts, connection errors, HTTP 408/429/502/503/504. The round is skipped (no orders at all) and the failure neither counts toward nor resets the halt counter. After 30 minutes of continuous failure the machine emits one `exchange_unreachable` event (the platform notifies the user); when reads come back after that, `exchange_recovered`. It never halts: a 15-minute OKX `50001`/`50013` spell used to halt a live account until the user noticed, four days later.
- **CREDENTIAL** — key invalid / revoked / expired, IP or permission refused, HTTP 401. HALT at once; only the user can fix a key.
- **UNKNOWN** — everything else, including clock-skew codes, Capital and paper errors. Counted: `DISCONNECT_HALT_AFTER = 3` consecutive → HALT. Each one is logged with venue, exception class and code; grow a venue's table only from a code seen there AND documented by the venue.

A good read resets the counter and the outage clock. `CapitalCacheLagError` (capital's Read-Your-Writes guard, `_capital_check_snapshot_caught_up`) is TRANSIENT, retried on the next poll instead of the 5-minute heartbeat, and neither opens an outage nor re-arms the account guard below. A venue lib without `classify` gets only the agnostic floor (network errors and HTTP status). Never catch-and-return `{}` in `get_positions()` — the classifier can only judge exceptions it sees.

**Account guard** (what "halt on any failure" used to protect): an empty positions read after the key moved to another account makes `reconcile()` re-buy the whole target. So at three moments — reconciler start (the web's start-trading button restarts it), the first good read after any failed read, and any change of the venue credentials in `.env` (compared as an in-memory hash, never stored) — the read must pass before anything trades that round: (a) previous actual (`manager/last_reconcile.json`) non-empty AND current target non-empty AND this read empty → HALT; (b) every crypto venue: the exchange account id differs from the one the bot's book was built on → that venue's book is reset first, then HALT (paper: the reset only — a paper rebind is always the user's own act); an id that cannot be read after a key change, with the bot's book open there → HALT and hold (see *Which account a book belongs to* under self_ledger). A trip is stored as `pending` in `state/venue_account.json` and the reconciler places nothing — reduce legs included — while HALT stands; clearing HALT resumes, and never brings an old account's book back. The reconciler never clears a HALT; only the user resumes.

**Qty precision (most common cause of rejected orders):** before placing any order, the order library must know the symbol's qty step, min qty, and min notional — fetch them from the exchange and cache at startup:

| Exchange | Endpoint | Fields |
|---|---|---|
| Binance futures | `GET /fapi/v1/exchangeInfo` | `LOT_SIZE.stepSize`, `LOT_SIZE.minQty`, `MIN_NOTIONAL` |
| Binance spot | `GET /api/v3/exchangeInfo` | same filter names |
| OKX | `GET /api/v5/public/instruments?instType=SWAP` | `lotSz`, `minSz`, `ctVal` |
| Bybit | `GET /v5/market/instruments-info?category=linear` | `lotSizeFilter.qtyStep`, `lotSizeFilter.minOrderQty` |

Floor the qty to the step with `Decimal` — never float arithmetic:

```python
from decimal import Decimal, ROUND_DOWN
qty = Decimal(str(raw_qty)).quantize(Decimal(step_str), rounding=ROUND_DOWN)
params['quantity'] = format(qty, 'f')   # plain string — never 1e-05 notation
```

After flooring: if qty < min qty or `qty * price` < min notional → `return False` (skip, no phantom-trade notification). Never guess precision from memory — read it from the exchange API or the relevant `skills/blave-quant/references/` file.

**The order lib floors; the auto-wiring decides the lot count.** `lib/venue_wiring.py` sizes every leg to a whole lot BEFORE it reaches `format_qty`, so the floor above is a safety net, not the sizing rule: reduce legs CEIL and cap at the position (`_reduce_qty`), entry legs ROUND half-up (`_entry_qty`). Entries used to inherit the floor, which strands the sub-lot remainder forever whenever an allocation is only a few lots wide — measured 2026-09-08 on uid 32321, `$289` on BTC perps is 3.7 lots of ~`$78`, so a `$227` target floored to `$157` and left a `$70` gap that was over reconcile's `$10` `THRESHOLD` but under one lot: every round re-dispatched an order the venue could never accept, and the gap could not shrink because the next fillable size was a whole lot away. Rounding lands the position on the nearest grid point, so the leftover is at most half a lot — and the leftover is converged by the PER-SYMBOL **entry** gate, not by the flat `THRESHOLD` (half a BTC lot is ~`$39`, well over `10`: on its own the next round would ceil-sell a whole lot back and the one after would buy it again — real fills, real fees, every 300s). `manager/reconciler.py::_symbol_threshold` gates ENTRY legs at `max(THRESHOLD, venue minimum)`, so a leftover under one lot is never bought back; PARTIAL reduce legs (a shrink that leaves some of the position) at `max(THRESHOLD, half a lot)` — the entry gate alone only shut one direction (measured 2026-09-09 on uid 32321, 3 lots vs a `$227` target: a `$10` mark drift over target was ceil-sold as a whole `$79` lot by `_reduce_qty`, the flat gate let it through, and the `$69` gap was bought straight back — 442 real fills). Half a lot converges on its own (after a ceil-sell the gap is `ceil(x) - x`, i.e. < 1 lot < the 1.05-lot entry gate) and is the only safe scale: a reduce gate of ONE lot would make a position of exactly one lot impossible to close or flip (the P0 the flat rule was itself the fix for), so it must never be raised to a lot or given a stale-mark buffer on top. A leg that takes the WHOLE position off — target flat (`0`, or the strategy removed), or the close leg of a flip — is gated at the flat `THRESHOLD` instead (`lib/portfolio.py::_close_threshold`; the reconciler's `.close` lowers it to `THRESHOLD` − half a lot while a lot is under 2×`THRESHOLD`, because an entry rounds half-up to whole lots and so the bot itself can open a position under `THRESHOLD` — one Gate.io / OKX BTC contract, ~`$8.4`, from a `$10` gap — which a flat gate would never let it close; the close still sells only the book's quantity): under `self_ledger` the diff is the book's COST while half a lot is priced at the mark, so a one-lot position that more than doubled (N lots: mark/entry > 2N) was under the gate forever — the signal said flat and no order went out. A full close leaves no ceil remainder and nothing buys it back (no entry leg at target 0; a flip's entry leg keeps the 1.05-lot gate), so the churn above cannot restart; on an account-read book nothing changes, a swap position being whole lots; and dust under `THRESHOLD` is still never sent. The snapshot row's `usd` is the gate that was applied (flat for such a row); `entry_usd` / `reduce_usd` stay the symbol's two side gates. Every recorded row also carries `close_usd` (that flat gate): a reader colouring a LIVE diff uses `min(side gate, close_usd)` when a position is held and the target is flat or on the other side (`act != 0 and (tgt == 0 or tgt * act < 0)`), and the plain side gate otherwise — with `reduce_usd` alone it paints "won't trade" on a close that does go out. A partial reduce after a large move is still judged cost-against-mark — known, and deliberately left on the half-lot gate. Spot / lot-based rows / a failed lookup stay on the flat `THRESHOLD`. The snapshot's `gates` records the reduce side too, with `side: "reduce"` (entry rows carry no `side`), and every recorded row now carries BOTH sides as `entry_usd` / `reduce_usd` — a reader colours a LIVE diff, whose sign can have flipped since that round, so one side alone had it colouring a buy-back against the reduce gate. `usd` (the side that round used) and `diff` are unchanged for the hand-written callers. The trade-off is deliberate: a position can sit under half a lot OVER its target (`$289` allocated, up to ~`$313` held on BTC), the same round-half-up capital lots have always used.

```
bash manager/start_reconciler.sh
```

Run via `start_reconciler.sh` (Linux) / `start_reconciler_windows.ps1` (Windows) — never `reconciler.py` directly — the wrapper restarts on crash and sends a Telegram alert on each exit. Determine the OS first per `AGENTS.md`.

**Before starting the reconciler (or triggering a manual reconcile):** always show the user the pending order summary from `aggregate_portfolio()` + `compute_diff()` and ask for explicit confirmation. Only proceed if the user confirms.

---

## self_ledger — diffing against the bot's own book instead of the exchange

**Problem this solves:** on a single-account setup, `get_positions()` reads the
account's REAL position — which on the same account as the user's own manual
trading includes whatever they opened by hand. `reconcile()` then reads that
manual position as "already have it" and trades against it (scales it up or
sells it down toward target). `self_ledger` fixes this not by reading the
account differently, but by not reading it AT ALL for diffing — the bot tracks
what IT has bought/sold from its own order log (`manager/orders.jsonl`) and
diffs target against that running total instead. A position opened outside
this process never enters the ledger, so it can never be touched.

**Every machine runs on it** (Wei 2026-09-23: the reconciler never touches a
position it did not open). `lib.portfolio.own_positions_only(config)` is true
for every config except one that explicitly says `"self_ledger": false` — an
account-read opt-out nothing in Blave writes; never set it yourself. Ownership
is decided by the book (what the bot actually filled), never by the symbol: a
manual long on a symbol a strategy trades — at amount 0 or more — is not the
bot's. Spot too: the wallet is one pool, and the bot sells only its book's
quantity of it (a spot book row without a quantity is never sold). A removed
strategy's position that IS in the book still closes. The
runtime also writes a fresh-start `manager/ledger_seed.json` when it creates a
machine's first `portfolio_config.json` and the machine has never filled on a
real venue (paper fills don't count).

**Which account a book belongs to.** Each venue's book records the exchange
account it was built on — the exchange's own id (`lib/account_<venue>.
get_account_id`: Binance spot `/api/v3/account` `uid`, OKX `/api/v5/account/
config` `uid`, Bybit `/v5/user/query-api` `userID`, BingX `/openApi/account/
v1/uid`, Gate.io `/api/v4/account/detail` `user_id`, paper the ledger's
`created_ts`), never the key — in the seed's `venue_account`. Every bind
reads it with the keys just written and records it (runtime
`_bind_book_accounts`; paper exempt); an id that cannot be read never refuses
the bind — the key's fingerprint is recorded instead, and a verified id is
never replaced by a fingerprint-only record.
`lib.portfolio.book_account_check` compares it at bind, at the reconciler's
start, on every credentials change, and in close-all before it sells anything:
- same id → the book is kept. A rotated key on the same account keeps it; a
  full unbind keeps it too.
- another id → that venue's book restarts empty at once (seed `venue_reset`),
  before anything reads it — binding over the old account, or unbind → another
  venue → back with another account, alike. On a real venue the machine also
  HALTs (source `reconciler`) with the reason that Blave no longer manages its
  positions on the previous account (`lib.portfolio.account_changed_reason`).
  That HALT is the notice: the platform's `halt` P1 event carries the reason
  to the page, email and Telegram, so no machine Telegram is sent beside it.
  Found at bind, the runtime HALTs at once (reported right after the command)
  and leaves `bind_reset` for the reconciler, which turns it into its own
  pending trip; if the user already pressed 啟動下單 the bind's HALT was the
  notice and nothing more is sent. Nothing is sent to the new account until
  啟動下單; that HALT-clear resumes from the empty book, it confirms nothing
  about the old one.
- the two cannot be matched (the new key's id unreadable, or the book was
  recorded under a key whose id was unreadable) → decided without asking only
  when nothing rides on it: the same key as the last read (one key opens one
  account), or no open row in that venue's book. Otherwise nothing trades on
  that venue — the reconciler HALTs once and holds every round (a
  network-class error holds silently for at most 10 minutes / 3 rounds, then
  asks like an unreadable id); close-all closes nothing there and says why;
  the report's `account_guard.book_hold` {venue, reason, since} asks the user,
  and runtime `book_account_confirm {venue, same}` answers: same → the book is
  kept under the new key; different → it restarts empty (what the bot held
  there is the user's). An answer acts only while that question is being
  asked and the exchange cannot tell the keys apart itself — a stale or
  replayed one returns `nothing_to_confirm` and writes nothing. Neither answer
  trades; both are idempotent and audited; every answer kicks the reconciler
  so a stale question clears within a poll; the HALT stays for 啟動下單, and a
  start pressed while the question is open changes nothing (`held:`).
- while a venue is held (`book_hold`, or an account-changed trip awaiting
  啟動下單) NO Blave order reaches it — entries, closes and protective orders
  are refused at every order lib's gate (`lib.guard.check_account_hold`; paper
  is never held), and a running TWAP / chase stops before its next child
  order, its fills booked.
  That is what the report's `halt.holds_all: true` means. Orders already
  resting on the exchange (SL/TP) are the exchange's.
- capital (群益) reads no id: not checked.

**One-way accounts: netted entries.** On a one-way (net) account an entry
opposite a position already there nets into it. The entry records how much
netted (`netted_qty` on the leg → the book row's `netted`). Exiting such a
share is a PLAIN order of at most that recorded amount — which restores the
user's position — and only when the account shows none of the bot's side and
some of the other, the venue's mode reads one-way (`venue_wiring.
_net_position_mode`; unreadable → never), and two reads agree
(`venue_wiring._netted_exit`). A book row with no recorded netted amount (the
user closed the bot's position by hand and opened their own opposite one) takes
the reduce-only path and, confirmed, the write-off — never an order that grows
the user's position. Close-all restores a netted share the same way under HALT:
`lib.guard.netted_restore` opens a pass for that one order — this thread only,
the named symbol and direction, at most the recorded quantity; each order lib's
`place_market_order` arms it with its own order and the HALT gate spends it
(the restart stop still blocks it). TWAP / custom / chase (limit) entries
record it too; a chase reads the netted room once, before its first fill.

**Partial closes.** A close the venue only partly fills (OKX returns
canceled-with-fill) is not a close: close-all and `close_symbol.py` compare
`executed_qty` with the size asked, keep the unfilled rest in the book, and
report 「未平完」.

**The book is per venue.** Every book row and every fill belongs to one venue
(`orders.jsonl` `exchange`; seed rows keyed `<venue>|<symbol>`); the reconciler
reads and writes the book of the venue it trades on
(`lib.portfolio.book_venue()`), and close-all closes each bound venue's own
share on that venue only. A position on another venue — or on this venue before
a strategy was rerouted here — is never this venue's book: rerouting paper →
Binance starts Binance's book at zero, it does not sell the user's Binance
coins. Seed rows without a venue (an old `--absorb`) are claimed the first time
the new lib reads them: with one venue bound, for it; with several, for the
venue every logged fill of that symbol names — the current route is not
evidence. No fill, or fills on two venues: the row is parked as `?|SYMBOL`, no
venue's book reads it (that position is left alone everywhere), and one order
error says so — reseed to hand it back.

**No baseline yet** (a machine from before the rule, or a lost seed): the
reconciler writes one itself (`lib.portfolio._auto_baseline`, Wei 2026-09-23).
Per symbol, the bot owns `min(|account|, |target|)` when the two are on the
SAME side; the rest is the user's. The bot owns nothing of a symbol no funded
strategy trades (a removed strategy's leftover included), of a flat target,
or of an account on the other side of its target (a short under a long target
is the user's; the bot buys its target from zero — on a one-way account the
exchange nets that buy against the user's short). How much of the quantity:
up to 1.5× the target's notional (`_ADOPT_WHOLE_RATIO`) the WHOLE account
quantity is the bot's (a profitable bot position is worth more than its
target); above that, the target's proportion of it (spot: of the wallet's
coins), FLOORED in base units to the venue step (`venue_wiring._lot_base`;
`format_qty` is only the minimum gate — OKX and Gate.io return contracts), and
the rest is the user's. The adopted cost is never above the target, so nothing
in this rule ever sells.
It waits (read-only round, `needs_baseline: {"reason": …}` in the snapshot)
until its inputs can be trusted: `unconfigured` (no amounts saved yet),
`state_unreadable` (a funded strategy's `state.json` is half-written),
`confirming` (two rounds in a row must see the same positions — an empty or
short read would make the bot's own positions the user's for good), `error` (a
quantity read threw), `inflight` (a TWAP / chase is running). A strategy whose
state has no `symbol` (a Type C portfolio) is skipped, as aggregation skips it.
A strategy whose `state.json` won't parse but whose coin is known
(`stats.json` `symbol`, or `SYMBOL` in `strategy.py`) holds only that coin: the
baseline is written for everything else, the coin sits in the seed's `pending`
(kept out of both sides of the diff; snapshot `baseline_pending`) and is decided
by the same rule once the state reads again — the bot's own position is adopted,
never bought twice. A non-transient wait (`state_unreadable` for a strategy
whose coin is unknown, `error`, `qty_mismatch`) that lasts 3 rounds and 10
minutes stops waiting: what can be read is decided as above, what
can't is left to the user — one audit line (`fallback`, `left_to_user`) and one
order error say which. The baseline is
marked `own_only_basis: 1`; a `seeded_at` without that mark (a newer runtime's
unbind reset beside an older lib, an old hand-run seed) is not a baseline and
the machine migrates. What was adopted is one `ledger_baseline` line in
`state/audit.jsonl` — show it when the user asks what the bot considers its
own. If the user says the split is wrong, reseed by hand (below).

**A spot row without a quantity** (a seed from before quantities, a fill with
no `executed_qty`) is written off the first time the reconciler builds the
book: one order error saying so, one `ledger_writeoff` audit line, the coins
stay in the wallet as the user's, and the strategy trades from zero — it never
blocks the next entry and is never sold.

**Reseeding the baseline by hand (the user says the adopted split is wrong)
— read every step; the wrong seed mode trades the user's own money:**
1. **Close the BOT's own part first** (let the reconciler close it with the
   strategies' amounts at 0, or confirm the bot is already flat). The user's
   own manual positions stay — that is the point. Why required: the
   fresh-start seed below treats everything on the account as the USER's; a
   live bot position at seed time becomes the user's, and the bot then
   re-buys its full target ON TOP of it — doubled exposure.
2. `python3 manager/seed_ledger.py` — ONE TIME, default (fresh-start) mode:
   the bot's book starts at ZERO and everything currently on the account is
   the user's. This is the correct mode for the feature's target user (holds
   manual positions, wants the bot to leave them alone).
   `--absorb` (adopt the account's current positions as bot-owned) is ONLY
   for migrating a bot-only account with no manual positions mixed in — on a
   mixed account it adopts the user's manual positions into the bot's book
   and the bot will later trade them away. **When unsure, never --absorb.**
3. No flag to set and no reconciler restart needed — the next round reads
   the baseline.

**The book is QUANTITY and COST, never one number** (`lib/portfolio.py` —
`ledger_book()`). Per symbol the bot keeps `cost` (signed USD: what its fills
were worth when they happened) and `qty` (signed base units it bought):
- *Whether to trade* compares the target with `cost`. The mark is not in that
  comparison, so a held position never trades because the price moved — **fixed
  quantity: what was bought is held until the signal changes** (account-read
  mode, by contrast, rebalances to a fixed notional — softened only by the
  drift band, see *`asset_specs[strategy]["type"]`* further down).
- *How much* a reduce leg sells is the same SHARE of the coins:
  `qty × |diff| ÷ |cost|`; a close is the whole `qty`. Never `USD ÷ mark` — that
  was the old book (cost only), and measured on paper a close 20% above entry
  stranded 16.7% of the position, a close 20% below left a phantom long that
  re-sent a dead reduce leg every round, and beside a manual holding it sold
  the user's coins.
- Where the cap `min(book qty, what the account holds on that side)` holds —
  never more than the bot bought, never more than is there: swap reduce legs
  sized by `lib/venue_wiring.py` (market, TWAP slices, chase re-posts, custom
  executors), spot sells through the wiring (market, TWAP, chase) and both
  halves of `manager/flatten.py`. A spot book row WITHOUT a quantity (legacy)
  is never sold — the reconciler writes it off once (see *A spot row without a
  quantity*), close-all skips it and says why (the wallet is one pool of the
  bot's and the user's coins, and spot has no reduce-only side to stop at the
  bot's share). Where
  the cap does NOT hold:
  - a legacy SWAP row (below) — `USD ÷ mark`, capped at the whole account side;
  - a hand-wired `place_order` — sized however it was written;
  - `manager/close_symbol.py` — closes the ACCOUNT's whole position on that
    symbol and side, the user's manual part included;
  - a spot buy's fee paid in the coin itself is booked net: the book holds
    what arrived (`lib/venue_wiring.spot_book_qty` — `executed_qty` stays the
    venue's pre-fee fill), so a full close sells exactly the bot's coins. A fee
    paid in BNB / the quote leaves the coin whole, and a fee split across
    assets (BNB ran out mid-order) is taken per fill. Where the order query
    has no fee, the fills are read (Binance `myTrades`; Bybit's order row
    carries `cumExecFee`). BingX has neither: booked 0.2% under the fill and
    flagged (`spot_fee_unknown` in `state/audit.jsonl`) — the bot may leave that
    sliver behind, never the user's. Spot + the book is not verified on a real
    account yet.
  - the `"self_ledger": false` opt-out — the whole account (and the whole
    managed spot inventory) is the bot's.
- An add grows both numbers from the exchange-confirmed fill (`executed_qty`,
  `executed_qty × fill_price`); a reduce shrinks `cost` by the share of `qty`
  sold (average cost), so both reach zero together. A flip closes the whole
  `qty`, then opens the new side.
- Fills carry `signed_qty` in `manager/orders.jsonl` legs (self_ledger on only;
  `signed_diff` stays the fill's notional for the web trade history).
- Sizing lives in `lib/venue_wiring.py` (`_book_row` / `_book_reduce_qty`),
  which reads the book itself — so TWAP slices, chase re-posts and the market
  path all size the same way, and `manager/reconciler.py` needs no change. **A hand-wired `place_order` (a venue without official libs) does
  not get this sizing**: its book stays truthful if it returns `executed_qty`,
  but it converts USD however it was written to.
- Reduce legs ROUND to the nearest lot (entries already do). Flooring left a
  0.5–1 lot remainder that passed the half-lot reduce gate and then floored to
  nothing, every round.

**What is left after a close that can never be sold is written off**
(`lib.portfolio.apply_ledger_writeoff`: the symbol's row is zeroed, one
`ledger_writeoff` line in `state/audit.jsonl` with the quantity and reason, a
WARNING in the log — no order, no notification). Only on a leg that takes the
book to FLAT, and only for: a remainder under one lot; a close the venue
refuses as below its minimum; a quantity the account no longer holds (the user
closed it by hand, a liquidation took it). That last reason rests on an account
read, and ONE read is not believed: a venue can answer successfully and wrong.
The first read short of the book is only noted (`state/ledger_account_short.json`)
and the leg goes out as if the read had failed — an empty read sends the
reduce-only order at the book's quantity and lets the venue fill or refuse it
(a refusal is one ordinary order error); a non-empty short read sells what is
there. A second short read at least 5 s later, with no contradicting read in
between and none missing for 15 min, confirms it and the row is written off
(`short_first` / `short_last` in the audit line). While unconfirmed, a flip
does NOT open its new side — the next round settles it. Not written off: a partial fill —
that is a real position and the next round retries it. Why not keep it: a row
that cannot be sold re-sends a dead reduce leg forever and, worse, reads as
"already in" at the next entry signal, so the strategy silently sits out. A
partial reduce whose share rounds to zero lots is skipped without any venue
call and without touching the book. When the user asks why the book and the
account differ by a fraction of a lot, read `state/audit.jsonl`.

**A book from before the quantity book** needs no migration step and the
update does not trade: nothing is rewritten, the book is a replay of the same
two files. Legs without `signed_qty` move `cost` by `signed_diff` exactly as
they always did (so the book after the update equals the book before it) and
give `qty` from their exchange-confirmed `executed_qty`. What the replay
decides is written ONCE to `manager/ledger_migration.json` (+ a
`ledger_adopted` audit line) — show it to the user when they ask what changed:
- `mode: "qty"` — quantity known; closes are exact from now on.
- `phantom_cost_dropped` — the old book still showed USD for a position whose
  coins were all sold (the phantom long above); dropped.
- `stranded_qty_not_adopted` — the old book was flat but the replay shows coins
  the old close left on the account. NOT adopted: the bot stopped counting
  them then, and selling them now could sell what the user regards as theirs.
  Tell the user the amount; closing it is their call.
- `mode: "legacy"` — the quantity cannot be known (a `seed_ledger.py --absorb`
  row from an older build, a fill with no `executed_qty`, or qty and cost on
  opposite sides because the old close oversold). Never estimated. A legacy
  row keeps the OLD arithmetic and the old `USD ÷ mark` sizing — including its
  exposure to the three bugs above — until it is next flat, or until reconcile
  closes it (any fill on its closing leg, or the account holding none of it,
  writes the row off). After that the symbol is a quantity row. There is no
  safe shortcut to end a legacy row sooner: `manager/close_symbol.py` closes
  the account's WHOLE position on that symbol — if the user holds any of it
  themselves (the usual reason a row went legacy), that sells their coins. Let
  the row close on its own signal, or tell the user what it is and let them
  decide.
`seed_ledger.py --absorb` now records the account's base quantity
(`lib.venue_wiring.auto_position_qty`), and prints a warning for any row it
could not read one for.

**Drift:** `ledger_positions()[sym]["qty"]` and `auto_position_qty()[sym]` are
both base units — compare them directly, no price in between. Nothing does
yet; `manager/last_reconcile.json["ledger"]` now carries `qty` per row.

**Workspace update ⇒ reconciler restart (REQUIRED, audit #3):** the reconciler
imports `lib/portfolio.py` once at process start — updating the workspace
files does NOT reload a running daemon. The runtime's `can_wait_start`
capability probes the file on DISK, so after a workspace update the web can
offer 「等新訊號才進場」 while the in-memory reconciler still runs the old
code with no gate support: the gate gets written, HALT clears, and the old
loop catches up at market against the user's explicit choice. Whenever
`lib/` or `manager/` files are updated on a machine, restart the reconciler
in the same session — if it is running; never start a stopped one — through
its supervisor (*Linux — check for the systemd unit FIRST* / *Windows — NSSM
service* below; `tmux kill-session` does not stop a systemd-supervised daemon)
before telling the user anything is enabled. `references/updating.md` carries
this as a step of every update. Also why a daemon that tripped its own HALT
needs the restart once: builds before `guard.release_memory_halt` keep that
HALT in memory after the web resume removes the file.

**No replay without a baseline:** `reconcile()` never falls back to summing
the whole orders.jsonl history (a plausible-looking but wrong book on any
machine with prior trading) — see *No baseline yet* above.

**What changes, exactly** (`lib/portfolio.py`): `reconcile()` still calls the
real `get_positions_fn()` (kept for the `manager/last_reconcile.json` snapshot,
and `manager/reconciler.py`'s own disconnect/auto-halt wrapper around it is
untouched) — but when `self_ledger` is on, `compute_diff()` and every
downstream flip/reduce-only decision in the per-order loop are computed
against `lib.portfolio.ledger_positions()` instead (its `size` is the book's
COST). `ledger_positions()` replays `ledger_seed.json`'s baseline plus every
`manager/orders.jsonl` entry logged after the seed's timestamp — nothing else. `manager/reconciler.py` itself
needs NO changes; the branch lives entirely in `lib/portfolio.py` and is
config-gated per account.

**What this does NOT solve:** the ledger can drift from the real account
(continued manual trading on the same symbol after the seed) — `self_ledger`
only guarantees the bot never treats someone else's position as its own, not
that the ledger and the real account always agree. There is currently no
drift alert; `manager/last_reconcile.json["ledger"]` vs `["actual"]` is
written every round for a future workspace view to compare, but nothing reads
it yet. Margin/liquidation risk checks (not yet built into `reconcile()`)
must always read the real `get_positions()`/`get_equity()` — never the
ledger, which only knows what the bot itself did.

**Ledger-integrity hardening (2026-08-20, audit P1 batch):** the known ways a
fill could silently go missing from the book now fail loud instead:
- async executions (TWAP/chase/custom) write a durable marker under
  `state/execution/inflight/`; a marker found at reconciler STARTUP means a
  previous process died mid-execution — under `self_ledger` that trips HALT
  with a "verify positions before resuming" message (`lib.execute.
  reap_dead_inflight`, wired in `manager/reconciler.py` startup) instead of
  silently re-buying fills the log never received;
- a failed `manager/orders.jsonl` append under `self_ledger` trips HALT (the
  file IS the book there; in account-read mode it stays best-effort);
- `manager/seed_ledger.py` REFUSES to seed while any execution is in flight
  (seeding mid-execution double-counts its fills);
- `manager/flatten.py` waits up to 30s after tripping HALT for in-flight
  executions to drain before closing, and records a visible order error for
  any that outlive the wait;
- a chase execution that CRASHES now records its real fills from the finally
  block (same pattern as custom executors); a TWAP that crashes mid-run can't
  recover its fill total, so under `self_ledger` it trips HALT instead;
- `lib/guard.trip_halt` sets an in-memory flag before its file write, so a
  FULL DISK (the fleet's measured failure mode — it fails the orders.jsonl
  append and the HALT write together) still halts the reconciler process even
  when `state/HALT` can't land; `reap_dead_inflight` exits the process
  outright when the halt can't persist, keeping its markers for the next boot
  to retry (halt/notify first, marker cleanup last).

**Capital (群益) / lot-based rows:** the book needs no case of its own there —
a capital-routed leg's `signed_diff` and `executed_qty` are both LOTS (see
*`amounts` semantics* below), so `qty` equals `cost`, the share sold IS the lot
count, and the hand-wired capital path places exactly the orders it did before
the quantity book (pinned in `tests/check_self_ledger_qty.py`). Not yet live-tested on a capital account — verify on the first
real capital `self_ledger` deployment.

**Fixed (2026-08-20, audit P0-2):** `reconcile()` used to log the leg's
PRE-rounding `sub_diff`, not what actually filled — on capital this drifted
the ledger by up to half a lot every round, permanently (crypto was thought to
be immune because "its rounding is far below `threshold`" — wrong, and measured
so on 2026-09-08: one BTC perp lot is ~`$78`, nearly 8× the `$10` threshold).
It now prefers the exchange-confirmed `executed_qty`
when `place_order_fn` returns one — lots directly for `futures_contracts`/
capital rows, `executed_qty × fill_price` (base currency → account currency)
otherwise — falling back to `sub_diff` only when `executed_qty` is absent.
Matches the FIX protocol convention (CumQty, not OrderQty, is the field
position-keeping is built on) and what `lib.execute._finish()` already did
for the async TWAP/chase/custom path — the synchronous path was the outlier.
Also matches `web/`'s own preference (`agent/workspace.html`'s 交易歷史
rendering already prefers `Σ legs' executed_qty×fill_price` over `signed_diff`
when available) — this fix makes the field it falls back to more accurate,
it does not change what the frontend computes.

**The flatten (全部平倉) interaction — read this before wiring self_ledger to
anything live.** What `manager/flatten.py` closes depends on `self_ledger`
(matching the 3Commas/Cryptohopper panic semantics the 暫停下單 dialog was
modeled on): on every machine (own positions only — every config without
an explicit `"self_ledger": false`) it closes ONLY the bot's own ledger
positions (`lib.portfolio.ledger_positions`) — a manually-opened position
self_ledger was never told about is untouched even by this button, and each
close is the book's `qty` capped at what the account actually holds on that
side (a legacy swap row still converts its USD at the mark). Spot is
book-scoped the same way: each `SYM@spot` book row sells min(book quantity,
wallet), a spot row without a quantity is not sold (it says why), and the
user's coins of the same kind are left in the wallet. If the ledger is
unreadable, or there is no baseline yet, on the panic path, swap AND spot
closes are skipped loudly rather than silently widening scope to the
whole account — the failure mode must never close the manual positions the
feature exists to protect. With the explicit `"self_ledger": false` opt-out
it closes every open position on the account — under the old alignment logic
the whole account is the bot's world.

Either way `flatten()` logs its closes to `manager/orders.jsonl` the same as
any other order (`_append_reconciler_log`), and without more,
`ledger_positions()` would sum them in as if they were an ordinary bot trade —
driving the ledger to a phantom position (worst on an OFF-mode machine that
later switches ON: closing a 2000 manual long the bot never held reads back as
the bot now being 2000 short). The next `self_ledger` reconcile round would
then try to "correct" that phantom position — right after the user asked to
close everything.

`flatten()` fixes this itself: it tracks every symbol it actually closed
(including sub-minimum dust left behind — still "as flat as it gets") and
calls `lib.portfolio.zero_ledger_symbols(closed_symbols)` once at the end,
resetting exactly those symbols' ledger baseline to flat, timestamped now.
Every other symbol's seed and accumulated history is untouched — this is a
per-symbol operation (`manager/ledger_seed.json` stores a `{'size', 'qty',
'ts'}` row per symbol — `size` is the USD cost, the name predates `qty` — not
one global timestamp), unlike the whole-account
`seed_ledger()`. The call is unconditional (runs even when `self_ledger` is
currently off) — harmless, and correct the moment the account switches it on
later. Same fix pattern as MultiCharts' "Strategy Positions Tab Mismatch"
handling (its own strategy-position-vs-broker-position architecture has the
identical gap after a manual "Flatten Everything") — MultiCharts leaves the
resync as a manual step the trader must remember to run; this is one call
built into `flatten()` itself instead.

## Additional Rules

**Before running `manager/manager.py` for weight optimisation:** strategy files always keep `END = None` (see strategy-code.md › END and WARMUP), so there is nothing to edit — but re-run any member whose backtest is stale first, or the optimiser fits on an outdated tail.

**Deleting a strategy:** delete only its own directory (e.g. `strategies/btc_kd_long/`). Never touch `manager/`.

### Stopping one strategy / closing one coin

When the user asks to stop ONE running strategy (and optionally close its position) — not everything, which is the HALT kill switch — do not hand-write a script or `grep -v` the crontab. Both tools print everything they read and did; relay that output.

```
python3 manager/stop_strategy.py <name> [--also <registry-name> ...] \
    [--flatten --venue <id> --symbol <SYM> --side long|short --key-name <N> --secret-name <N> [--passphrase-name <N>] [--demo-name <N>]]
python3 manager/close_symbol.py --venue <id> --symbol <SYM> --side long|short \
    --key-name <N> --secret-name <N> [--passphrase-name <N>] [--demo-name <N>] [--dry-run]
```

- `stop_strategy.py` removes every schedule line that runs `<name>` or an `--also` name (`run_strategy.sh <name>`, `wait_for_bar.py <name>`, and any line referencing `strategies/<name>/`, monitors included), waits up to ~90s for their python/bash processes to finish, kills survivors, optionally closes the position through `close_symbol`, then removes every name from `state/deployments.json` and verifies nothing is left. Pass `--also` for registry entries under another name (e.g. a daemon `xrp_v2_monitor` for strategy `xrp_5x_v2`) — look in `state/deployments.json` first, otherwise the healthcheck keeps alerting on the leftover. Strategy files and `state.json` are kept; the global HALT is not tripped, but scoped halts `state/HALT_<scope>` are — code that checks `lib.guard.halted_for` stays blocked. Scopes = the directory name + every literal slug the strategy's `.py` files pass to `halted_for` / `trip_halt_for` / `halt_info_for` / `clear_halt_for` or set as `STRATEGY_SLUG` + each `--halt-scope <slug>` (repeatable; use it when the code builds the slug at runtime). `--also` names get none. A scope whose file already exists is kept untouched (its reason/ts may be the strategy's own breaker); each scope is printed. If the crontab write fails, the halts stay written, nothing else is done, and the exit code is 1. To re-enable a stopped strategy (only on the user's explicit request): `ls state/HALT_*`, clear every halt belonging to that strategy with `clear_halt_for('<scope>', 'user')`, then re-deploy per `references/deployment.md`.
- With `--flatten`, every check that can refuse — keys, conflicts, a read-only look at the exchange (hedge mode, key works) — runs BEFORE any schedule is touched. If the close itself then fails, the strategy stays stopped and unregistered and the exit code is 1: tell the user the position is still open. `--flatten` that finds no position still lists any open or conditional orders left on the symbol — tell the user.
- A 下單設定 portfolio member (any type picked on the web, as `<name>` or `--also`) is refused: the user removes it on the web 自動下單 page. Windows machines are refused: remove the scheduled tasks by hand and tell the user.
- `close_symbol.py` is perp only (`@spot` and non-crypto venues are refused; `-SWAP` suffixes are accepted). It waits briefly for in-flight executions on the symbol, prints the key name in use, demo on/off, equity, the position, open and conditional orders; cancels that symbol's orders, re-reads the position, closes it with a reduce-only order of that size, then re-reads and prints what is left. No position on that side → nothing is sent and orders are left alone (they are listed). Once orders are cancelled, any later failure prints `OPEN and UNPROTECTED` — tell the user immediately that the position has no stop left; if the position re-read fails, the pre-cancel size is closed reduce-only. A symbol that also holds an opposite-side position (hedge mode) is refused. Run `--dry-run` first when unsure which account holds the position.
- Keys: pass the `.env` NAMES the strategy trades on — read the strategy's own code to find them (e.g. `--key-name BINGX_API_KEY_XRP_V2 --secret-name BINGX_SECRET_KEY_XRP_V2`; the venue's plain `BINGX_API_KEY` / `BINGX_SECRET_KEY` for the main account). Only those names are used: a missing name refuses and lists the credential names in `.env` (never values), and nothing falls back to another key. The demo flag is also by name (`--demo-name`); without it the close goes to the LIVE endpoints.
- Conflict check (heuristic): refused when another live strategy — a schedule line or a running python/bash process references it, or it is a portfolio member on this venue — has code or config files (`.py`, `.json` such as `params.json`, `.yaml`/`.yml`, `.toml`, `.txt`, `.env`/`.ini`/`.cfg`/`.conf` — not `.csv` or logs) that mention the symbol on the same key. Same key = the key name appears; for the venue's plain key, either the plain name appears, or no other key name of the venue appears but the files name the venue (`order_<venue>` or the venue word). The output lists every strategy it scanned. Tell the user which strategies conflict and stop them first if they agree.
- Exit codes (same for both): 0 done and verified (sub-minimum dust may remain — printed); 1 a step failed or something is left — incl. a cancel/close failure, a venue lib that could not list/cancel its conditional orders, an unverifiable result, or (stop) leftover schedule lines/processes/registry entries; 2 refused or the exchange could not be read before anything changed; 3 (`stop_strategy.py` only) no schedule line, process or registry entry matched any name — nothing changed; if the user still wants the coin closed, run `close_symbol.py` instead; 4 no position on that side — nothing sent (for `stop_strategy.py`: stopped and verified, nothing to close).

**Changing `account_value` (capital):** edit `portfolio_config.json["account_value"]` by hand — the ONLY way, and only when the user explicitly asks to change capital (never as a side effect of a weight update). Procedure: (1) the value is total account equity in the account currency (USD) — use the real figure, never a placeholder like 10000; (2) editing resizes every live position, so show the user the old → new value and get explicit confirmation BEFORE writing, same as `--apply`; (3) no restart needed — the reconciler re-reads the file on its next poll. `manager.py` never writes this field.

**Order-qty UNITS pitfall (measured live 2026-08, sCode 51008):** the order libs'
`place_market_order` / `close_position_partial` take **BASE-currency qty** (ETH, SOL…)
and convert to contracts internally. Never pass `format_qty`'s return onward — it is a
CONTRACT count, and re-converting divides by ctVal twice: invisible on SOL (ctVal=1),
10× oversized on ETH (ctVal=0.1). Use `format_qty` as the min-size gate only. Partial
reduces go through `close_position_partial`, not `close_position` (full close, no qty).

**OKX `get_positions()` pitfall:** OKX positions API returns `ctVal` as `None` for some instrument types. Do NOT compute notional as `pos * markPx * ctVal` — use the `notionalUsd` field directly instead. Zero notional causes the position to be ignored and reconciliation skipped.

**Account library — create `lib/account_{exchange}.py`:** To read equity/positions for an exchange, copy `lib/account_TEMPLATE.py` to `lib/account_{exchange}.py` and implement `get_equity(env)` and `get_positions(env)`. Position symbols follow the canonical dashless-uppercase contract (see `references/lib.md` § Exchange account libraries) — this also applies to a hand-wired reconciler `get_positions()`. Platform readers discover the file by its exact name — keep the naming convention. API keys go in `.env` (e.g. `OKX_API_KEY`, `OKX_SECRET_KEY`, `OKX_PASSPHRASE` — match the casing already used for that exchange's keys elsewhere in `.env`). Before writing, read the relevant skill reference under `skills/blave-quant/references/` for the correct balance and position endpoints.

**BingX is already wired — `lib/account_bingx.py` ships implemented, no template copy needed.** Covers the SWAP (perp/futures) account only, via `/openApi/swap/v3/user/balance` and `/openApi/swap/v2/user/positions`. BingX keeps fund/spot/swap as three separate accounts with no auto-transfer (see `skills/blave-quant/references/bingx-api-reference.md`) — if the user's capital is in the spot or fund account, `get_equity()` will under-report; extend it rather than writing a second file.

**`portfolio_config.json["messages"]`** — Telegram message templates for reconciler and watchdog. Keys: `order_buy`, `order_sell`, `order_close_long`, `order_close_short`, `order_error`, `watchdog_started`, `watchdog_restart`. Placeholders: `{symbol}`, `{amount}`, `{error}`, `{code}`. Edit these to match the user's preferred language when deploying.

**Always start the reconciler via the watchdog wrapper**, not `reconciler.py` directly and never with `nohup &`. `nohup &` background processes are killed when the shell session ends.

**If `state/reconciler_stopped.json` exists, do not start the reconciler at all** — not with `systemctl`, `nssm` or tmux — **and never delete that file yourself.** One exception: the restart after a workspace update (`references/updating.md` §2) still restarts a *running* reconciler, because the updated one reads the file and sends nothing — that restart is what replaces an old program that ignored it. The machine restarted and trading stays stopped until the user presses 啟動下單 (Start trading) on the Auto trading page; while the file exists the reconciler skips every round and every `lib/order_*` call refuses the order with `guard.Halted` (`lib.guard.check_restart_stop`) — entries, closes, SL/TP alike, from the reconciler, TWAP/chase slices, Type B strategies and your own scripts; only cancels, leverage changes and a paper `reset_account` pass. The one exception is the platform's `close_all` command (the page's 暫停並關閉部位, Pause and close positions): it closes positions through a one-time pass handed to `manager/flatten.py`, and the machine stays stopped afterwards — running `flatten.py` yourself closes nothing. The stopped page has no close button: if the user wants to be flat before resuming, tell them to close positions at the exchange (啟動下單 resumes trading, it does not close). Type B runs are skipped by `manager/run_strategy.sh` (logged, exit 0, heartbeat untouched) and the healthcheck treats their stale runs as the pause. Known behaviour: a stop-loss/take-profit is refused too, so if the record lands between an `open_position` entry fill and its SL/TP (a window of seconds right after boot), that position has no stop until 啟動下單 — stops already resting on the exchange are unaffected. Tell the user to press 啟動下單 instead; do not retry or work around the refusal.

**Linux — check for the systemd unit FIRST, tmux only as fallback:**
```
systemctl is-active blave-agent-reconciler.service
```
- If the command reports `active` (or the unit file exists at all — check with
  `systemctl cat blave-agent-reconciler.service`), the reconciler is supervised by
  systemd. Control it ONLY through systemd:
  start/restart: `sudo -n systemctl restart blave-agent-reconciler.service`
  stop: `sudo -n systemctl stop blave-agent-reconciler.service`
  **Never** start a tmux session while the unit is active, and **never** assume
  `tmux kill-session` stopped trading on such a machine — the systemd daemon keeps
  placing orders, and a tmux daemon started alongside it doubles every order.
- Only when the unit file does not exist (older machines) use the tmux session:
```
tmux new-session -d -s reconciler 'cd $BLAVE_AGENT_HOME/workspace && bash manager/start_reconciler.sh'
```
(resolve `$BLAVE_AGENT_HOME` first — same env var as `references/deployment.md`'s cron entries; when unset the default is runtime-dependent — `/root/.openclaw` on old BlaveClaw machines, `/opt/blave-agent` on Blave Agent machines — resolve it per that doc's layout signal, never assume one path)
To check status: `tmux attach -t reconciler`. To stop: `tmux kill-session -t reconciler`.
Note: the systemd unit deliberately has no `[Install]` section — the reconciler must
NOT auto-start on reboot; the user re-enables trading explicitly after a reboot.

**Windows — NSSM service:**
```
nssm install blaveclaw-reconciler powershell.exe "-ExecutionPolicy Bypass -File %BLAVE_AGENT_HOME%\workspace\manager\start_reconciler_windows.ps1"
nssm set blaveclaw-reconciler AppDirectory %BLAVE_AGENT_HOME%\workspace
nssm set blaveclaw-reconciler Start SERVICE_DEMAND_START
nssm start blaveclaw-reconciler
```
(`%BLAVE_AGENT_HOME%` — resolve the actual env var on this machine before running these commands, don't type the literal placeholder; defaults to `C:\openclaw` if unset)
To check status: `nssm status blaveclaw-reconciler`. To stop: `nssm stop blaveclaw-reconciler`.
Note: `SERVICE_DEMAND_START` is required, never `SERVICE_AUTO_START` — same policy as the
Linux unit above: the reconciler must NOT auto-start on reboot; the user re-enables trading
explicitly. Crash recovery while the service is running is NSSM's AppExit restart, which is
independent of the start type.

**Capital (群益) reconciler wiring is hand-wired in `manager/reconciler.py`, not auto-wired.**
`lib.venue_wiring` deliberately excludes `"capital"` (`_NON_AUTO`) because its data shape differs
from every crypto venue — LOTS not account-currency notional, `buy`/`sell` not `long`/`short`, and
the order alias (`TM0000`) differs from the resolved contract code every position/report actually
carries (`TM2608`). `get_positions()`/`place_order()` in `reconciler.py` each contain a capital-only
branch (`_is_capital_routed()` / `exchange == 'capital'`) that:
- reads `lib.account_capital.get_positions()` — already lots, `buy`/`sell` — and translates
  `buy`→`long` / `sell`→`short`, size unchanged (**lots, not TWD notional** — see *`amounts`
  semantics* below)
- round-half-up's the target/actual lot diff to a whole lot (`math.floor(raw_lots + 0.5)`, not
  Python's `round()` — that does banker's rounding, which rounds a `0.5` tie down; a diff below
  0.5 lot rounds to 0 and places nothing. reconcile()'s account-currency gate — per symbol,
  `max(THRESHOLD, that instrument's venue minimum)` on ENTRY legs and `max(THRESHOLD, half a
  lot)` on REDUCE legs, see `_symbol_threshold` — is crypto-notional scale and meaningless at lot count, so `lib.portfolio.compute_diff` skips it
  entirely for `futures_contracts` rows; this round-half-up is the only gate on capital) and calls
  `lib.order_capital.place_futures_market_order()` with the near-month alias
  (`TX00`/`MTX00`/`TM0000`)
- is scoped to `asset_specs[strategy]["type"] == "futures_contracts"` only — a capital strategy
  configured as `"tw_stock"` (securities) raises loudly; that path is not wired yet

Every other machine (crypto exchanges — the overwhelming majority of the fleet) falls straight
through to the existing auto-wire (`auto_get_positions()` / `lib.execute.dispatch_order`),
untouched — the capital branches only activate when `portfolio_config.json["exchanges"]` actually
routes a strategy to `"capital"`.

`contract_value` and the alias↔resolved-contract-prefix mapping (`TX00`→`TX`/200,
`MTX00`→`MTX`/50, `TM0000`→`TM`/10) are a fixed table in `reconciler.py`
(`_CAPITAL_FUTURES_SPEC`), not user config — only the `TM0000`→`TM2608` prefix is live-verified
(2026-08-14); confirm `TX00`/`MTX00` on the first live TXF/MXF order and update the comment.
`contract_value` in that table is no longer read by any code path (see *`amounts` semantics*
below) — kept only as a documentation mirror of `capital-broker.md` Step 8's `asset_specs`.

**`asset_specs[strategy]["type"]` — the unit a symbol is reconciled in.** Three values
(`lib/portfolio.py`: `asset_type` / `native_units`):
- `notional` — the default when the key is absent (every existing crypto config): `amounts` is
  account currency, `actual` is size × mark. The mark moves `actual`, so this path carries the
  drift band below.
- `futures_contracts` — lots (capital TW futures): `amounts` IS a lot count, no price anywhere in
  the chain (state.json `position` × `amounts[strategy]` = target lots; `_capital_get_positions()`
  reads lots; `_capital_place_order()` diffs lots).
- `shares` — a share count (TW whole/odd lots, US equities): `amounts` IS shares, `actual` is
  shares held, diffs are shares. **Type and `compute_diff` routing only for now** — no broker
  order path ships for it; a `shares` row reaching a crypto auto-wire is refused loudly.

The paper venue trades both native types as lots too (`lib/order_paper.place_contract_market_order`
via `lib/venue_wiring._paper_contract_order`): round-half-up to a whole lot, under half a lot
places nothing, reduce legs cap at the held lots, PnL = lots × `contract_value` × Δprice, and the
account row comes back with `unit: "contracts"` and `size` in lots — so a paper TXF position
never drifts with the index, and a removed strategy's close-on-removal is judged in lots in both
account-read and `self_ledger` mode (the book row inherits the venue read's unit). Leverage on
paper counts lots × `margin` (TAIFEX initial margin) separately from notional positions, and at
1× — the margin must be covered by equity, as at a broker (notional keeps its 10×).
`contract_value` and `margin` must be in the spec (the platform writes TXF/MXF/TMF specs with
both); a spec missing either is refused as an order error, never valued at a guess. A notional
paper position opened before the spec existed is closed whole by the first reduce leg.

Principle: **reconcile in the market's native unit; convert money to quantity once, at entry.**
`futures_contracts` and `shares` never see the account-currency gates or the drift band; a new
market gets a native-unit type, never another notional path — the notional path is what
`self_ledger`'s quantity book exists to replace.

`strategy_amounts()` returns `portfolio_config.json["amounts"]` verbatim; the type above is what
the number means.

**Drift band (`notional` rows, `self_ledger` off).** Target is a fixed notional and `actual` is
size × mark, so a held position reads as a gap every heartbeat and the reconciler trades the
unrealised P&L — measured 2026-09-21 (uid 29026, 20,000 paper, signal unchanged): 34 fills in
4h44m, 0 with the book on. `lib/portfolio.compute_diff` therefore also gates a SAME-SIDE
adjustment at `max(5%, min(2 × 30-day daily σ, 20%)) × |target|` (`drift_band`; σ from
`lib/data.fetch_kline` 1d bars with today's forming bar dropped, cached one day in
`state/drift_band.json`, the 5% floor alone when it cannot be had). It never applies to a whole-position close — target flat, strategy
removed, or a flip's close leg — nor to native-unit rows. Two things to tell a user on this
path: the position may sit up to the band away from its target, and a same-side signal change
smaller than the band (a vol-scaled 1.0 → 1.03) is indistinguishable from drift and is also left
alone. The snapshot's `gates` row carries `band_usd` when it applied (`usd` already includes it).
Gate: `tests/check_drift_band.py`.

This was a same-day refactor away from a lots→TWD-notional→lots round trip (aggregate at save
time, convert back at order time) that priced BOTH conversions off `_txf_index_price()` — a ~1min
TXF close fetched fresh each time. Because the state.json snapshot and the reconciler poll happen
at different instants, the two price reads rarely matched, so the round trip introduced spurious
rounding drift with no economic meaning: a strategy with a constant signal (e.g.
`tmf_always_hold`, always emits `position=1`) should store exactly 1 lot forever, but the old path
could round it to 0 or 2 lots depending purely on how much the index moved between save and
execution. Storing/comparing lots directly removes the round trip and the drift with it —
`_txf_index_price()` no longer exists in `reconciler.py`.

**Consequence for `lib.portfolio.compute_diff`:** its `threshold` param (account-currency scale,
default 10) would otherwise swallow every capital order, since lot diffs are single/low-double
digits — `compute_diff` now skips `threshold` for any row where `asset_spec["type"] ==
"futures_contracts"` OR either side's `exchange == "capital"` (the latter covers a close-on-removal
row, which has no `asset_spec` because the strategy no longer appears in `target`).

**Consequence for `web/`:** the workspace's "交易所部位" (`buildPositionsSection` in
`agent/workspace.html`) renders target/actual/diff through `paintVenueMoney()` with a currency
suffix and a hardcoded `Math.abs(d) >= 10` highlight threshold — both currency-scale conventions.
For a capital-routed row this now displays a lot count formatted as money (e.g. "2 TWD" for 2
lots) and the order-eligible highlight no longer lines up with the real 0.5-lot gate. The 下單設定
amounts-input table (`pfClientTargets`, same file, lines ~3199-3339) was already updated same-day
to treat capital amounts as lots — this is the live-positions table's matching update, not yet
done; flagged for frontend-engineer.

**Capital (群益) broker exception:** NSSM services default to running as `LocalSystem`. Capital's
`SKCOM.dll` binds the certificate to the Windows identity that issued it (always `Administrator`
on Blave Agent machines — see `references/capital-broker.md` Step 2), so a service running as
`LocalSystem` fails `SKCenterLib_Login` with error 602 even though the cert is correctly installed.
If any portfolio in `portfolio_config.json["exchanges"]` uses `"capital"`, set the service identity
to Administrator before starting it:
```
nssm set blaveclaw-reconciler ObjectName .\Administrator "<Administrator password>"
```
Read the password from `C:\blave-agent\credentials\rdp_password.txt` on the machine itself
(`C:\openclaw\credentials\rdp_password.txt` on BlaveClaw machines; agent has local read access —
no need to ask the user, they'd only be repeating what's already on their own
「遠端桌面連線」dashboard card). Never change this password — the dashboard serves the
platform-stored copy, so a local reset locks the user out. No certificate export/import needed — this replaces the old
POC guidance about moving the cert to a different account store.

**After starting the reconciler, register it for health monitoring** — add to `state/deployments.json` (create the file if missing):
```json
{"reconciler": {"type": "daemon", "expect_every_minutes": 5,
                "registered_at": "<UTC now, %Y-%m-%dT%H:%M:%S>"}}
```
The reconciler touches `state/heartbeat/reconciler` on every poll loop; `manager/healthcheck.py` alerts the user if the heartbeat goes stale (see `references/deployment.md` › Deployment Healthcheck). Without this registration the healthcheck cannot see the daemon.

**Trace the full calculation chain before flagging an inconsistency.** If `state.json` shows a non-zero position but a field in `portfolio_config.json` (e.g. `weight=0`) seems contradictory, read `lib/portfolio.py` first. `contribution = account_value * leverage * weight * position` — a zero weight zeroes out the contribution by design. Do not report a bug until you have followed every variable through the aggregation logic.
