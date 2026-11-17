# SinoPac (永豐金) Broker — Agent Reference

Use this document when a user asks to connect their SinoPac account to Blave Agent.

- **Blave never places TW stock orders — not automatically, not on request (Step 5).** Never
  hand-write Shioaji stock order calls either.
- **SinoPac futures (TXF / MXF / TMF) are not available yet.** The lib is written but not
  live-verified: every futures call raises `SinopacError` with `code == "unverified"` and sends
  nothing. Tell the user it is not available yet; never work around it with raw Shioaji calls.
- **Credentials never pass through the chat** (Step 3). Never ask for, accept or write the API key,
  the secret, the national ID, the certificate password or the `.pfx`.
- **Never log in to SinoPac yourself** — no `sj.Shioaji().login(...)` in a script, not even in
  simulation mode. Every login uses one of the person's 5 connections (Limits), and Shioaji prints
  the national ID while it logs in (lesson 10).

---

## Supported Products

| Product | Symbol | Notes |
|---------|--------|-------|
| 台指期 TXF / 小台 MXF / 微台 TMF | `TXF` / `MXF` / `TMF` | 1 口 = 200 / 50 / 10 × index points (TWD). Not live-verified — refused by the lib. |
| 台灣股票 Stocks | `2330` | Never ordered by Blave (Step 5). `lib/` has no SinoPac stock path. |

---

## Field-Verified Lessons

### Live stock account, 2026-07, Shioaji 1.5.4

The odd-lot stock path these came from was removed from `lib/` (2026-11-17); lessons 1–3, 5 and 7
apply to any Shioaji order.

The first live Taiwan-stock deployment lost **three rounds of orders to silent rejections** —
Shioaji's `place_order` does not raise on rejection; a dead order just sits with status `Failed`
or never leaves `PendingSubmit`. Each lesson below cost a real debugging round:

1. **`SINOPAC_LIVE=true` must be set in `.env`, or nothing is real.** Without it the connection
   runs in simulation mode against a fake account whose holdings have nothing to do with the
   user's real account (the simulation account showed 24 fake positions worth $24.4M while the
   real account was empty; sell orders bounced with 「集保賣出餘股數不足」 against holdings that
   didn't exist). Never diagnose position mismatches before confirming which mode you're in.
2. **The CA certificate is activated AFTER `login()`.** Live orders before activation fail with
   `CA not activated for: <person_id>`. The libs activate it at connect time and fail loudly, so
   this surfaces before the first order, not as a rejected order.
3. **Enums, never strings.** An order built with the bare string `"MKT"` was silently rejected — it
   never entered the broker's system and sat unnoticed for 13 hours. Use the `sj.StockPriceType`,
   `sj.StockOrderLot`, `sj.FuturesPriceType`, `sj.FuturesOCType` and `sj.TimeInForce` enums.
4. **Share counts under 1000 MUST be odd-lot orders.** A Common-lot (整股) order's `quantity` is
   in 張 (1000-share board lots); submitting a share count (e.g. 66 shares of 2303) as a
   Common-lot order silently vanishes (`order_lot=sj.StockOrderLot.Odd`).
5. **Always confirm against order status, never trust `place_order`'s return.** Poll until the
   order is acknowledged (`Submitted`/`Filled`); `Failed`/`Cancelled`/`Inactive` means rejected —
   read `status.msg`. All three incidents above would have been caught by this check.
6. **Warning-flagged stocks (警示股)** may require pre-funded settlement (「警示股預收條件」) —
   surface the status message to the user instead of retrying.
7. **Orders placed outside market hours rest as `PendingSubmit`/`PreSubmitted` until the next
   session.** That is not a rejection — report it honestly rather than resubmitting.

### Real futures account, 2026-11-15, Shioaji 1.7.11 (Linux x86_64, macOS arm64, Windows Server 2022 x64)

A read-only run on a real futures account (login, certificate, account reads, logout — no order):

8. **`login()` has no `fetch_contract` any more.** The signature is
   `login(api_key, secret_key, subscribe_trade=True, receive_window=30000, force_refresh=False)`.
   Old code passing `fetch_contract=True` breaks. Contracts load by themselves after login
   (lesson 17).
9. **The `.pfx` downloaded from the API key page activates directly** with
   `activate_ca(ca_path, ca_passwd, person_id)` on all three platforms (the desktop app's bundled
   Python 3.12 on macOS and Windows) — no SinoPac desktop software is needed. The certificate
   password was the national ID.
10. **Shioaji prints the national ID itself** — its session log line ("Session Property
    modification ok … /PYAPI/<ID>/") goes to stdout. Never paste raw Shioaji output into the chat or
    a report.
11. Account shapes: the login's futures account has `account_type` `F` and `signed=True` once the
    signing and simulation test passed (Step 2); `api.futopt_account` is the same account.
    `margin(account)` carries `equity`, `available_margin`, `risk_indicator`;
    `list_positions(account)` works; `get_ca_expiretime(person_id)` returns a datetime (the
    certificate's expiry); `usage()` returns `connections` / `bytes` / `limit_bytes` (one login =
    one connection).
12. **The Windows console is not UTF-8**: printing Chinese raised `UnicodeEncodeError`.
13. **A process that exits without `api.logout()` never exits** — Shioaji's session threads keep it
    alive. Log out in a `finally`, on signals and at shutdown.
14. Not measured on 11-15: any order (see lessons 15–16).

### Real futures orders, measured 2026-11-16 (M0-b, Linux x86_64, Shioaji 1.7.11, day session)

One TMF lot bought and closed with market IOC orders on a real account, run by the account owner:

15. **TAIFEX takes `MKT` + `IOC`.** `TMFK6` 1 lot market IOC buy → `OrderStatus.Filled`, deal 1;
    the market IOC sell that closed it → `Filled`, deal 1. The `MKP` + `IOC` fallback after a
    rejected `MKT` was not exercised.
16. **The position read lags the fill.** `list_positions` right after the buy was `Filled` still
    returned `[]`. Never read an empty position right after an order as flat: a fill is the order's
    deals, and a position read counts only once it started `ORDER_SETTLE_S` after the last send
    (`lib/sinopac_vault`; borrowed from 統一's measured 12 s, SinoPac's own lag is not timed yet —
    the gate-flip live run must time it). The `[]` after the close was confirmed flat in the SinoPac
    app.
17. **Contracts load in the background after `login()`.** Calling `fetch_contracts()` then raised
    `ShioajiTimeoutError: exclusive access lost (concurrent API call started)` (twice; not caused by
    `subscribe_trade=True`). Never call it.
18. **Contracts v2.** `api.Contracts` and `api.Contracts.Futures.TMF` are deprecated, and
    `Contracts.status` does not exist at runtime although the type stubs list it. Use
    `api.contracts.futures("TMF")`: base objects with `code` and `delivery_date`. It raises until the
    background load is done, so poll it with a bounded wait. `api.contracts.info(base)` only when a
    base has no `delivery_date`.
19. **Month codes are root + month letter + last digit of the year** (`A` = January). The TMF list on
    11-16: `TMFK6` (delivers 11-18), `TMFL6`, `TMFA7`, `TMFC7`, `TMFF7`, `TMFI7`. `TMFR1` / `TMFR2` are
    continuous contracts and cannot be ordered.
20. **`sj.Order()` is deprecated: futures orders are `sj.FuturesOrder(action, price, quantity,
    price_type, time_in_force, octype, custom_field, account)`** (the keyword set read from the
    installed 1.7.11).
21. **`shioaji.log` appears in the working directory** and may carry the national ID (it was not
    read; the SDK's own session line on stdout does carry it). Never read or paste it. Importing `shioaji` alone creates it (reproduced on macOS
    11-16). `SJ_LOG_PATH` is the file the SDK opens instead: the null device leaves no file
    (macOS, import only — Linux, Windows and a logged-in session with it set are not measured), and
    a path it cannot open falls back to stdout.

How the libs answer these (tested with a faked SDK): `lib/order_sinopac.py` never logs in and never
imports `shioaji`; `lib/sinopac_worker.py` runs on 1.7.11 only (any other
version is refused before a login), logs in with `subscribe_trade=True` (the SDK default, passed
explicitly; order status is read by `update_status` polling, no order callback; `False` is not
measured), waits up to 60 s for the contract list
(a list still loading fails reads, not the login), orders through `sj.FuturesOrder` on a contracts v2
base, writes the last-order marker before every send and holds its own position reads until
`ORDER_SETTLE_S` after it, routes fds 1/2 through an ID mask (`sinopac_worker.quiet_sdk`), forces
`SJ_LOG_PATH` to the null device before every `shioaji` import, writes the console as UTF-8, and logs
out on exit, `SIGTERM` and `SIGBREAK`.

---

## Step 0 — Which account

- Futures account (期貨) → what Blave will trade once SinoPac futures are verified.
- Stock account (證券) → Blave never orders TW stocks (Step 5).
- Most users have both under one login; the API key decides which accounts it reaches (Step 1).

---

## Step 1 — API key and certificate (the user, on SinoPac's site)

All on one page: **https://www.sinotrade.com.tw/newweb/PythonAPIKey/** (SinoPac's website login).

1. Create an API key. Tick the **futures account** and **all four permissions**: 行情／資料, 帳務,
   交易, 正式環境. The Secret Key is shown only once — the user keeps it until the connect page asks
   for it.
2. No IP restriction on a desktop (a home IP changes, and the key then stops working). On a cloud
   machine only with a fixed IP.
3. On the same page, download the certificate (`.pfx`). Its password defaults to the national ID.

The old e-MANAGER developer center (`eservice.sinotrade.com.tw`) is not where keys are made any
more — never send the user there.

---

## Step 2 — Signing and the simulation test (once per person)

SinoPac lets an API key trade only after both:

1. **Signing**: the user signs the API terms at SinoPac's sign center — **futures are signed
   separately from stocks**. Signing must come before the test, or the test does not count.
2. **A simulation test report**: one login and one order in simulation mode, futures tested
   separately from stocks. Accepted **Mon–Fri 08:00–20:00 Taipei; 18:00–20:00 only from a Taiwan
   IP** (a cloud machine is outside Taiwan: 08:00–18:00 only). Review takes about 5 minutes; then
   the account reads `signed=True` (lesson 11).

The user signs; the platform's connect flow will run the simulation test for them. Never run it
yourself from the chat. `signed=False` means "not signed yet or still in review", never a wrong
password.

---

## Step 3 — Credentials reach the machine through the platform only

- The key, secret, certificate, certificate password and national ID go through the platform's
  encrypted connect page, never through the chat. A key pasted into the chat is refused
  (`lib/venue.py`).
- The connect page for SinoPac futures is not available yet. Until it is, tell the user SinoPac
  futures are not available yet — never write `.env` lines for them.
- Never read, print or echo these values, and never open the `.pfx`.
- **These `.env` names are locked** (already-bound machines resolve them): `sinopac_api_key`,
  `sinopac_secret_key`, `sinopac_ca_path`, `sinopac_ca_passwd`, `sinopac_person_id` (optional,
  defaults to the certificate password), `SINOPAC_LIVE`.

---

## Step 4 — Install

The platform installs the SDK, pinned: `pip install shioaji==1.7.11`. Never upgrade or reinstall it
yourself: the futures worker runs on 1.7.11 only.

---

## Step 5 — Wire into Portfolio

**TW stocks are never traded automatically and never ordered by you — on SinoPac or any other
broker.** Blave places orders only through strategies, and the reconciler does not take TW stocks:
never route a stock strategy to `"sinopac"`, and never write a script that places Shioaji stock
orders (the odd-lot path that once did is gone from `lib/`). A stock strategy going to a real
account: point the user to 策略組合 to see the strategy's holdings and place those orders themselves
in their broker's app.

**Futures are not routable yet:** do not route a futures strategy to `"sinopac"` until this
document says SinoPac futures are available.

---

## Trading Hours

| Market | Hours (Taipei) |
|--------|----------------|
| 台灣股票 | 09:00 – 13:30 (Mon–Fri) |
| 台指期 day session | 08:45 – 13:45 (Mon–Fri) |
| 台指期 night session | 15:00 – 05:00 (Mon–Fri) |

---

## Order Placement

### Stocks — not placed by the agent

See Step 5. `lib/order_sinopac.py` has no stock functions.

### Futures — through the lib, NOT live-verified

`place_futures_market_order(env, root, 'buy'|'sell', lots, intent)` and `close_position_partial`
in `lib/order_sinopac.py` (full API in `references/lib.md`) refuse with `code == "unverified"` and
send nothing until a real-account order run passes. Once verified:

- Orders do not log in: they are request files for `lib/sinopac_worker.py`, the machine's one
  Shioaji login. **Never start the worker yourself** — each start is a real login.
- Market `IOC`, sent to a specific month (the held month for an add or a close, else the near
  month), never to `TXFR1`. `book_months=` (the months the bot's book holds; the reconciler and
  the close-all both send it) limits that to the bot's own months: a month the user opened in the SinoPac
  app is never closed, added to or opened into, and an entry is refused while the user holds the
  near month itself. A `MKT` order the broker rejects with no fill is sent once more as
  `MKP` + `IOC`; nothing else is retried.
- An order inside `ORDER_SETTLE_S` of the previous send, with too little time left to wait it out,
  raises `SnapshotNotSettled` and sends nothing (lesson 16) — try again next round, never resend
  in a loop.
- Nothing goes out while the machine is paused (`state/HALT`) or stopped after a restart, except
  the user's own close. Entries wait outside the regular session and while this machine's clock is
  off (`lib/tw_clock`); closes are not held by that gate.
- A worker login that got no answer (timeout, connection, SinoPac maintenance, 451) is retried by
  itself and never stops: 1, 2, 4, 8 and 10 minutes apart, then every 30 minutes, at least 10
  minutes after a 451; trading on SinoPac skips those rounds, and the user is told 25 minutes in and
  every 2 hours after. Any other failed login (key, certificate, not signed, no futures account)
  stops SinoPac only — no HALT — and the user is told once; only the user's
  confirmed login on the platform restarts it.
- No broker-side stop or take-profit: Shioaji's touch-price order runs in the client process, so
  `place_stop_order` refuses. No limit layer: a chase setting degrades to market, loudly.
- Outcomes: `'filled'` (book `fill_qty`, never a later position read), `'sent'` (no fill seen in
  time — never resend), `OrderNotConfirmed` (may have filled — never resend; from
  `close_position_partial` it comes back as status `'unknown'`). The reconciler parks `'sent'` and
  unknown sends and settles them from a later position read; you never do this by hand.
- SinoPac documents no "market closed" code. A refusal SinoPac itself gave to an order that was
  sent, while the weekly session table says the market is shut, raises `SessionClosed` with
  `from_broker` True (its message is SinoPac's own text); the close-all page shows it as closed
  market.
  The worker's own refusals (nothing to close, expired, paused) are never read that way, and read
  "not sent by Blave", never "SinoPac refused".

---

## Account reads

`lib/sinopac_futures_account.py` reads the worker's snapshot (`state/sinopac_account.json`) and
never logs in: equity (`margin().equity`, TWD), positions in lots per root with their month, the
broker's listed months. There is **no `get_flows`**: Shioaji has no deposit / withdrawal history
query (`margin()` carries only the day's total), so the platform flags an equity jump as 資金異動,
as for 群益 and 統一. Position reads raise `SnapshotLag` while the snapshot's read started less than
`ORDER_SETTLE_S` after this machine's last send (lesson 16): the position is unknown, not flat. Like
the order functions, every read refuses until futures are verified.

---

## Limits (shared by every connection of one national ID)

| Item | Limit |
|------|-------|
| Connections | 5 — every `login()` is one |
| Logins | 1000 per day |
| Subscriptions | 200 |
| Market data queries (snapshots / ticks / kbars …) | 50 per 10 s; intraday at most 10 `ticks` and 270 `kbars` |
| Account queries (`margin`, `list_positions` …) | 25 per 5 s |
| Order calls (`place_order`, `update_status`, `cancel_order` …) | 250 per 10 s |
| Daily traffic (futures) | 500 MB with no API fill in 30 days; 2 GB for 1–1000 TXF or 4000 MXF lots; 10 GB above; resets 08:00 on trading days |
| Over a limit | traffic: market queries return empty; rate: blocked for one minute; repeated or under load: the IP and the ID may be suspended — retrying `login()` meanwhile does not lift it and may extend it |
| Clock | `login(receive_window=30000)`: a clock off by more than 30 s fails the login |

Sources: https://sinotrade.github.io/tutor/limit/ and https://sinotrade.github.io/zh/tutor/limit/

**Notes:**
- A failed login is never retried in a loop (the suspension above): the worker retries only a login
  that got no answer, spaced out to every 30 minutes (Order Placement); anything else stops it.
- `TXFR1` always points to the near month; Shioaji flips it to the next month at 13:31 on
  settlement day, while the backtest series (`fetch_twfutures_ohlcv`) stays on the expiring month
  until the 15:00 session.
- System clock must be accurate — NTP sync fixes login timeouts.

---

## Verification Checklist for Agent

There is nothing to verify by logging in yourself. Once SinoPac futures are available and the user
has connected on the platform:
1. Read the account through `lib/sinopac_futures_account.py` (equity, positions) — no login.
2. A read error saying the login is being retried: it retries by itself — wait, never start the
   worker. Not running, stale or stopped: tell the user to confirm the login on
   the platform. Never start the worker.
3. TW stock orders are never placed by Blave (Step 5).
