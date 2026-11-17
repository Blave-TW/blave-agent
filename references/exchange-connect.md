# Exchange Connect (web-initiated)

When the user connects an exchange from the web workspace's order-settings page, the
platform writes the API keys into the workspace `.env` directly (command channel — on
that path the keys never pass through you), then a chat message asks you to finish the
integration. A key pasted in chat and bound with `lib.venue.bind` (AGENTS.md › Exchange
API Keys) lands in the same `.env` through the same writer — continue here from rule 2
just like a web handoff.
This file is that procedure. The goal: `lib/account_{id}.py` + `lib/order_{id}.py`
exist and `manager/reconciler.py` is wired through them.

**Taiwan brokers (`sinopac`/`president`/`capital`) are NOT covered by this file, even
though their web handoff message matches the trigger above** — see AGENTS.md's Broker
Onboarding section and go straight to that broker's own reference doc instead. This
matters most for `capital`: its libs ship pre-built (not agent-written), so rule 2's
"files already exist → skip to rule 5" fast path below matches on the first message,
runs `get_equity()` before the user has done ANY of the certificate/RDP/agreement
onboarding, and rule 5's crypto-flavored "auth / permission / IP whitelist" framing
would misreport that as a bad key — Capital has no IP whitelist concept at all, and the
actual fix is `capital-broker.md`'s guided RDP flow, not "check your key."

`{id}` is the lowercase env-key prefix — the keys arrive as `{ID}_API_KEY` /
`{ID}_SECRET_KEY` (and sometimes `{ID}_PASSPHRASE`). Read the exact names from `.env`;
do not assume casing or invent names.

## Rules

1. **Never echo a key.** Read credentials with `dotenv_values()` inside code only. Key
   values must never appear in chat, logs, Telegram, error messages, or committed files.
   Recommend a key with read + trade permission only: withdrawal permission is not
   needed for anything Blave does, so suggest the user leaves it off.

2. **Check what already ships before writing anything.** BingX
   (`lib/account_bingx.py` + `lib/order_bingx.py`), Binance
   (`lib/account_binance.py` + `lib/order_binance.py`), OKX
   (`lib/account_okx.py` + `lib/order_okx.py`), Gate.io
   (`lib/account_gateio.py` + `lib/order_gateio.py`), Bybit
   (`lib/account_bybit.py` + `lib/order_bybit.py` — UTA accounts only), StockCoin
   (`lib/account_stockcoin.py` + `lib/order_stockcoin.py` — FUTURES-type key; market,
   limit / chase / TWAP and SL/TP layers; no spot, no fund-flow history), Bitget
   (`lib/account_bitget.py` + `lib/order_bitget.py` — classic and unified (UTA) accounts;
   USDT-M perps incl. US stock perps; market, limit / chase / TWAP
   and SL/TP layers; no spot), Paper trading
   (`lib/account_paper.py` + `lib/order_paper.py` — simulated venue, no keys;
   the web handoff for it needs only rule 5 plus one sentence on how fills
   are priced, see `references/lib.md`) and SinoPac
   (`lib/order_sinopac.py`) are implemented — extend, never rewrite. For everything else, work from
   `lib/account_TEMPLATE.py` and the patterns in `lib/order_bingx.py`
   (see `references/lib.md`, `references/manager.md` § Account library).
   **If both files already ship for this venue, skip straight to rule 5, and once
   it passes go directly to rule 8** (rules 6–7 are for venues whose order lib
   doesn't exist yet — don't rewrite what already ships) — a stored
   key is not a working key (wrong permissions, missing IP whitelist, capital sitting
   in an account the lib doesn't read); validate read-only and report. A shipped lib
   is a starting point, not a fence: when the user wants different behaviour (e.g.
   count spot balance into equity), modify it in place — keep the contract, never
   rewrite from scratch. **Every path passes through the rule-5 validation gate**;
   writing or changing account code just comes before it.

3. **Find the API docs in this order:**
   - ① `skills/blave-quant/references/{id}-skill.md` / `{id}-api-reference.md` — if a
     skill reference exists for this exchange, it is the source of truth (endpoints,
     auth/signing, broker attribution).
   - ② No skill reference → the exchange's official API docs on the web. Verify every
     response shape against a second independent source (official SDK code beats doc
     tables) before parsing it — doc tables are frequently wrong.

4. **`lib/account_{id}.py`** — implement `get_equity(env)` and `get_positions(env)`
   (reconciler shape: `{symbol: {'side': 'long'|'short', 'size': <account currency>}}`).
   **Symbol keys MUST be canonical: dashless uppercase (`BTCUSDT`), never the venue's
   own format (`BTC-USDT`, `BTC-USDT-SWAP`)** — the reconciler keys target and actual
   on this format; a venue-format key splits one instrument into two rows and churns
   buy/close orders against itself every round.
   Platform readers discover it by its exact filename — keep the naming convention.
   **Multi-account venues (spot / futures / funding / unified): `equity` means the
   equity of the account orders are placed on** — it is the position-sizing base, so
   summing across accounts would overstate what the strategies can actually trade
   with. Also return an optional `'accounts': {name: float}` breakdown (lowercase
   names like `trading` / `swap` / `spot` / `fund` / `funding`, USDT-denominated,
   best-effort per wallet) — the web shows it so money parked outside the trading
   account doesn't look like it vanished. **Include EVERY wallet the venue has**:
   wallet-split venues list each wallet (BingX: fund/spot/swap —
   `lib/account_bingx.py`); unified-account venues list the unified account as
   `trading` plus the separate `funding` wallet (OKX — `lib/account_okx.py` on a
   machine that has it). Once the file exists, the
   platform's account reader starts polling it automatically (every ~2 min, written
   to `manager/account.json`) — failures show on the web as `error`, so raise with
   readable messages (env key NAMES are fine, values never).
   **The auth-failure path is part of the contract, not an afterthought**: a bad /
   revoked / IP-blocked key MUST raise with the exchange's own error code and
   message. Never swallow an auth error into zeros (a user with a typo'd key then
   sees "equity $0" and thinks their money vanished), and never let the error
   response crash the parser (`'str' object has no attribute 'get'` tells the user
   nothing). Test the module against a deliberately broken signature before calling
   it done — the error string is what the web shows the user.

5. **Read-only validation gate — BEFORE any order code.** Run `get_equity()` and
   `get_positions()` now. **If the read fails (auth / permission / IP whitelist),
   STOP HERE**: report the readable error and wait for the user to fix the key —
   do not write `lib/order_{id}.py`, do not touch the reconciler. A wrong key must
   cost one small module, not a whole integration (measured 2026-08-04: an agent
   wrote a 15KB order lib against a dead key — minutes of work validating nothing).
   On success: report the numbers (every wallet, when the venue splits them), ask
   the user to check them against the exchange app, and **continue straight into
   rules 6–7 without waiting for the answer** — the integration finishes in ONE
   pass (measured 2026-08-04: stopping here read as "the agent said done but the
   page still says incomplete"). The gate's job is catching a dead key cheaply,
   not pausing on a live one; a number mismatch reported later is fixed in the
   account lib without touching the order code. Place NO order — live trading
   starts later via the reconciler, not as an integration test. Never clear a halt
   as part of this flow. **Do not tell the user to move funds to any particular
   wallet** — spot strategies trade the spot wallet, perp strategies the futures
   wallet, and which applies is unknown until a strategy is deployed; presenting
   the balances without a transfer instruction is the correct ending. Transfer
   advice belongs at deployment time, matched to the strategy actually deployed.

6. **`lib/order_{id}.py`** — copy `lib/order_TEMPLATE.py` (perp venues; Taiwan brokers
   follow `lib/order_president.py` instead) and follow `lib/order_bingx.py`'s contract:
   confirmed orders (poll to terminal state; report exchange-reported fills, never the
   intent), unique client-order-id for idempotency, `lib/guard` halt + audit
   integration, and the exchange's broker attribution header/field (in the skill
   reference; without it the order still fills, so the omission is silent — include it
   from the first order). The reconciler calls FOUR fixed names —
   `get_contract_rules` / `format_qty` / `place_market_order` /
   `close_position_partial` — missing any of them crashes at reconcile time
   (mid-trade), not at integration time. Never rename or omit them.

   **Limit layer (execution styles need it — see `references/lib.md` › Execution
   styles).** The chase-limit executor calls FIVE more fixed names; a venue missing
   any of them silently degrades every chase order to market (loud Telegram fallback),
   so ship the full set with any new integration:
   - `place_limit_order(env, symbol, direction, qty, price, client_order_id=None,
     reduce_only=False, time_in_force="GTC", post_only=False)` — MUST return a dict
     containing `order_id` (the venue's own id: every later cancel/status call is by
     order_id, never by client id — client-id lookup is not portable across venues).
     `post_only=True` maps to the venue's own dialect (Binance `timeInForce=GTX`,
     OKX `ordType=post_only`, Gate.io `tif=poc`, …); a post-only rejection (the
     order would have crossed) RETURNS `{'status': 'post_only_rejected'}` instead
     of raising — the chase executor re-reads the book and re-posts on it. The lib
     formats `price` to the instrument's tick itself (callers pass a raw float).
   - `cancel_order(env, symbol, order_id)` — cancel by order_id; idempotent-safe:
     "already filled / not found" returns a status instead of raising, the caller
     always re-reads fills afterwards. Return `'canceled'` only when the response itself
     is the order's final state; a venue whose cancel is asynchronous (Bybit) returns
     another status (`'cancel_accepted'`) so the chase confirms it through `get_order`.
   - `get_order(env, symbol, order_id)` — MUST include `orig_qty` alongside
     `executed_qty` / `avg_price` / `status` (partial-fill accounting needs the
     original size, not just the filled part).
   - `get_bbo(env, symbol)` → `{'bid': float, 'ask': float}` — real top-of-book,
     never mark/last price (several venues' tickers already carry bid/ask fields —
     read them; do not substitute `get_mark_price`).
   - `get_open_orders(env, symbol=None)` — open resting orders; each row MUST
     carry `symbol` (canonical dashless-uppercase), `order_id` and
     `client_order_id` — the reconciler's startup sweep matches the
     `rc<timestamp>` client-id fingerprint and cancels by (symbol, order_id).
   Spot-capable venues ship the spot twins (`place_spot_limit_order`,
   `cancel_spot_order`, `get_spot_order` with `orig_qty`, `get_spot_bbo`,
   `get_spot_open_orders`). New mutating endpoints (cancel, limit place) must be
   registered in the lib's `_MUTATING_PATHS`/guard classification — the existing
   `_order_intent` logic keys off reduce semantics, not order type, so limit orders
   classify correctly without guard changes.

7. **Reconciler wiring is AUTOMATIC for official venues** — the template's
   `get_positions`/`place_order` route through `lib/venue_wiring.py`, which
   detects the bound venue and maps the USD-diff contract (swap + spot) for
   you; do not touch `manager/reconciler.py` for Binance/BingX/OKX, and a
   rebind to another official venue needs no reconciler change. For a venue
   WITHOUT official libs, replace the two function bodies in the same session
   as the order lib (order library → reconciler is one atomic task —
   AGENTS.md); their docstrings carry the contract.
   For a strategy on Binance bars (`fetch_kline`) the wiring refuses an ENTRY
   into a venue's stock swap when Binance lists the same ticker as a coin —
   OKX `BB-USDT-SWAP` / `ON-USDT-SWAP` / `QNT-USDT-SWAP` and Bybit `ONUSDT`
   are stocks. The mirror case is refused too: Binance has the ticker as a US
   stock, the venue as a coin. On OKX, which names its class (`instCategory`
   1 crypto / 3 stocks / 4 commodities), any two of coin / stock / commodity
   that differ are refused (`XAUUSDT` passes: a commodity on both); on
   Gate.io, Bybit and Bitget, whose lists name only a stock reliably, a stock
   is also refused where Binance has a commodity. The order
   error says so in Chinese, naming both sides; tell the user that venue's
   contract under this ticker is not what the strategy was backtested on,
   and never place it by hand. A strategy whose every file reads only the
   bound venue's own bars (`fetch_okx_kline` on OKX) is not compared — it was
   backtested on that very contract; a mix, a helper on Binance bars or an
   unreadable file is compared as before (any other `fetch_*`, a Blave alpha
   included, counts as Binance, and so does anything that could read bars
   another way: a network or dynamic import, a URL, an import from outside
   the strategy's folder that is not the standard library, an installed
   package or a strategy-side `lib` module (`data`, `runner`, `strategy`,
   `exits`, `costs`, `param_scan`, `validation`, `notify`, `walk_forward`,
   `analysis`; from `guard` only `halted` / `halted_for` / `halt_info` /
   `halt_info_for` / `halt_path_for` / `Halted`, from `execute` only
   `load_state` / `save_state` / `update_state`), `lib.data` through `getattr` or a `_private` name; the
   template's own `def fetch_data` is not a fetcher; a link in a docstring or
   as the whole value of `DESCRIPTION` / `LOGIC` / `VERSION_NOTE` /
   `DISPLAY_NAME` is not a read, unless a file of the folder reads that name,
   spells it in a string or uses `getattr` / `globals` / `vars` / `dir` /
   `__dict__` / `locals()` other than the template's `run(locals(), …)`).
   Keep shared helpers as
   `.py` files in the strategy's own folder. On OKX a strategy on
   Binance bars whose `SYMBOL` Binance does not list is refused too
   (`PEPEUSDT`: Binance has only `1000PEPEUSDT`, a different multiple) — move
   it to `fetch_okx_kline`. Moving means every `.py` in the strategy's
   folder: `scan.py`, `wf.py`, `validate.py` switch too (re-scan the
   parameters on the new bars) or are deleted — one leftover `fetch_kline`
   keeps the whole folder on Binance bars and the entry refused every round.
   The `[venue_wiring] strategy bars taken as binance` warning names the
   file and the fetcher or import that kept it there.
   The check reads code, it does not run it, so these reads of Binance data
   are NOT caught and the entry would go through unchecked — never use
   them in a strategy that orders on OKX or BingX: a local file of saved
   bars (`pd.read_csv('tmp/…')`), `lib.data.BASE` in a hand-built URL,
   `fetch_okx_kline.__globals__[…]`, `sys.modules['lib.data']…`,
   `runpy.run_path` or `importlib.util.spec_from_file_location` on a file
   outside the folder.
   A ticker the venue does not list (`1000PEPEUSDT` on OKX) fails at the
   order lib before anything is sent.
   Which bars to write in the first place: `references/lib.md` › *Which
   exchange's bars*. Closes are never refused. On Bitget a stock contract is
   a v3 instrument row with `symbolType` or `instrumentType` `stock` (or
   `instrumentType` `etf`), not `isRwa` (which also flags gold and FX): metal
   (`PAXGUSDT`, `XAUTUSDT`), energy and FX rows enter normally.
   US stock perps (`fetch_kline("NVDAUSDT")`, Binance `underlyingType`
   EQUITY) trade under the venue's own name where it differs — BingX
   `NCSKNVDA2USD-USDT`, Bybit `AMDSTOCKUSDT` — mapped from each venue's public
   contract list by `lib/stock_perps.py`, positions read back under the
   strategy's name. Keep using `NVDAUSDT` everywhere; never type the venue
   name. No listing on the bound venue → `symbol_unavailable` ("BingX 沒有這檔
   股票永續"). A strategy may also take its signal from the stock's own US
   daily bars (`fetch_usstock_price('NVDA')`) and trade `NVDAUSDT` — desktop
   or cloud, one ticker matching `SYMBOL`; saving it on a venue without that
   perp is refused (`US_VENUE`). Rules: `references/lib.md` › *US stocks / ETFs*. `[order_reject:stock_agreement]` (Binance -4411, Bybit 110126)
   means the account has not signed the venue's stock-perp agreement. Binance:
   neither its app nor its website has a place to sign — ask the user whether
   to sign it; only after they say yes call
   `order_binance.sign_stock_agreement(env, user_consented=True)` (never on
   your own, never as an automatic retry; without that argument it raises;
   strategy code never calls it — the install scan refuses any that does),
   then let the next round re-send. Bybit: the user signs it
   on the Bybit website or app with the MAIN account by opening that contract's
   trade page (sub-accounts cannot sign; the API route needs a transfer or
   withdrawal permission Blave keys don't have).
   All five venues trade stock perps 24/7 (weekends included). BingX status 25
   forbids OPENING only: entries and adds on it wait (shown under
   `market_closed` in `manager/last_reconcile.json`), reduces and closes still
   go out, and a flip only closes.
   The stock names need Binance's public exchangeInfo (the strategy's data
   source). A machine that never read it falls back to the plain name
   (`NVDA-USDT`, `AMDUSDT`), which today exists on neither venue, so the order
   is refused; were a venue ever to list a coin under that plain name, the
   order would buy the coin — if stock orders on BingX / Bybit say
   `symbol_unavailable` while Binance is unreachable, fix the network first.
   A stock position whose name cannot be read back (empty contract list,
   Binance unreadable, two venue rows on one ticker) makes the position read
   fail for that round instead of showing it as flat.

8. **Done = the two files exist and rule 5 passed.** The machine's portfolio
   reporter detects the files and the web page flips the venue to ready on its
   own — no extra reporting step.
