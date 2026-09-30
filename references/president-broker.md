# President Futures (統一期貨) Broker — Agent Reference

Use this document when a user asks to connect a President Futures (統一期貨) account. The
integration uses the broker's official **Unitrade API** (`pip install unitrade`).

Package docs: https://pfcec.github.io/unitrade/ · PyPI: https://pypi.org/project/unitrade/

**Status: test host only.** The shipped libs (`lib/order_president.py`, `lib/account_president.py`,
`lib/president_worker.py`, `lib/president_vault.py`) have run against the broker's test host; no
live account has placed an order through them, and **the reconciler is not wired for `president`
yet** — do not route a strategy to `president` in `portfolio_config.json` and do not hand-wire the
reconciler for it. Everything marked *unverified* below needs a live account to close.

---

## Supported Products

| Canonical symbol | Product | Point value (TWD) | Broker contract code |
|---|---|---|---|
| `TXF` | 台指期 大台 | 200 | `TXF` + month letter + year digit, e.g. `TXFJ6` = Oct 2026 |
| `MXF` | 小台 | 50 | `MXFJ6` |
| `TMF` | 微台 | 10 | `TMFJ6` |

Month letters are A–L for January–December; the digit is the last digit of the year. There is no
rolling alias like SinoPac's `TXFR1` or Capital's `TM0000` — see *Near month* below.

This covers the **domestic futures account** only. Unitrade also has overseas futures
(`api.ftrade` / `api.faccount`) and a stock quote feed; none of it is used here.

---

## Platform — v1 supports Windows only

- `unitrade` 1.0.0.7 ships wheels for Linux x86_64, macOS universal2 and Windows, **CPython 3.7 to
  3.14**. No Linux ARM wheel. Dependencies:
  `bitarray`, `requests`, `cryptography`, `numpy`.
- **v1 is Windows-only anyway, because of the certificate.** The `.pfx` is issued by 憑證e總管
  (https://pki.pscnet.com.tw/), which only runs on Windows 10 (Traditional Chinese) or later — no
  web or Mac version was found. A **new** certificate also needs the account holder to phone their
  broker rep or customer service ((02) 8172-4668) to have the application permission opened first.
  The certificate is used on the machine it was issued on; there is no upload flow in v1.
- Certificates expire after one year and are renewed with the same Windows tool.
- There is **no certificate-free simulation mode** — the test host needs the real certificate too.

---

## Step 1 — Ask the broker rep (one call, three things)

1. Open **API trading permission** on the futures account.
2. Open the **certificate application permission** (only if there is no `.pfx` yet).
3. Apply for an **API test account**. Also ask: the production URL, connection and order-rate
   limits, and whether production needs the machine's IP registered.

**Test host URL gotcha:** the activation mail writes the host as `test167.pfctrade.com`, but the
test hosts' TLS certificate only covers `*.testpfctrade.com`. The working URL is
**`https://test167.testpfctrade.com`** (substitute the number from the mail). The libs refuse any
other host unless `PRESIDENT_LIVE=true`.

---

## Step 2 — The certificate (.pfx)

Ask the user:
> 你之前有沒有在這台電腦用過統一期貨的下單軟體、或申請過電腦憑證？

- **Yes:** it is usually at `C:\Users\<name>\PSCCA\PSC_<ID>_<expiry>.pfx`. The file name contains
  the user's national ID — never print, log or echo it; refer to it as "the certificate file".
- **No:** the user runs 憑證e總管 on this Windows machine (after the phone call in Step 1; it sends
  an SMS, so the user must be present).
- The **certificate password is separate from the trading password** (set at issuance; may be empty).

---

## Step 3 — Install

```
pip install unitrade python-dotenv
```

---

## Step 4 — `.env`

Ask the user (one message) for the 11-digit trading account (company code included), the trading
password, and the certificate password. Write `.env` yourself; never ask the user to edit it, never
echo values back. **These key names are locked** (bound machines resolve them) — do not rename:

```
president_account=<11-digit account incl. company code>
president_password=<trading password>
president_test_url=https://test167.testpfctrade.com
president_ca_path=<absolute path to the .pfx on this machine>
president_ca_password=<certificate password, may be empty>
```

Production, only after the broker's production mail AND the user's explicit go-ahead:

```
PRESIDENT_LIVE=true
president_url=<production URL from the broker>
```

Without `PRESIDENT_LIVE=true` the libs only accept a `*.testpfctrade.com` host, and a login whose
server reports it is not a test server is refused.

---

## Step 5 — Verify (read-only)

Do not hand-write a login script. Run the worker once:

```
python lib/president_worker.py --once
```

It logs in, reads margin and positions once, writes `state/president_probe.json`, logs out and
exits 0 (ok) / 2 (failed, with the error in the file). On the test host `equity` is empty and
`margin_error` says `查無資料!` — normal for an unfunded test account, not a failure.

The long-running form (`python lib/president_worker.py`, no flag) is the machine's one standing
login and writes `state/president_account.json` every 60 s for `lib/account_president.py`. No
service installer ships for it yet — it is not something to set up on a user's machine until the
broker is on the connect menu.

---

## Step 6 — Orders

Use `lib/order_president.py` (full contract in `references/lib.md`):

```python
from dotenv import dotenv_values
from lib import order_president

env = dotenv_values(".env")
r = order_president.place_futures_market_order(env, "TMF", "buy", 1, "entry", client_tag="t1")
print(r["status"], r["symbol"], r["fill_qty"], r["ack"])
```

- Market IOC, `opencloseflag=""` (the broker decides open/close), quantity in 口.
- `status='filled'` only on a real match; `status='sent'` means no fill was seen in time — never
  resubmit on it; check the position first.
- Entries are blocked while `state/HALT` is set; reduces always pass.

### Near month

- **Entry** → the first contract whose settlement (third Wednesday of its month, **13:30 Taipei**)
  is still ahead. That is the same instant the backtest's `TXFR1` continuous series changes contract
  (its first new-month bar is 13:31). The computed contract must appear in
  `get_domestic_contracts(root, "F")`; if it does not, the order is refused — never a guess.
- **Reduce / close** → the `productid` of the position row being closed (worker snapshot), never a
  re-derived month: after a roll the near month is no longer the contract that is held. A root open
  in two months is refused; close each by its month code.
- **Unverified on a real settlement day** (the next is 2026-10-21): what `get_domestic_contracts`
  lists between 13:30 and the night session, and holiday-shifted settlements (the rule assumes the
  third Wednesday).

---

## Field-Verified Lessons (test host, 2026-09-30)

1. **Test host URL** — `https://test167.testpfctrade.com`, not the `pfctrade.com` host in the mail.
2. **Login, accounts, positions work on the test host; margin does not.** `get_accounts()` returns
   one 7-digit account; `get_margin` answers `查無資料!`; `get_position(actno, "", "")` returns one
   row per product + month (`product`, `month` `202610`, `productid` `MXFJ6`, `ot_qty_b` /
   `ot_qty_s`, `current_buy_open_position` / `current_sell_open_position`,
   `open_buy_position_average_cost`, `floating_pnl`, `product_base_number`). The test account comes
   preloaded with 1 long MXF.
3. **Which quantity is the open interest is not pinned down.** On the one preloaded row
   `ot_qty_b` and `current_buy_open_position` both said 1. The snapshot keeps both; a read where they
   disagree fails rather than guess. Settle it on the first live fill.
4. **`issend=True` is not acceptance.** `order()` returns `issend` + `seq`; acceptance is the
   `on_reply` for that `seq` with `statuscode == '0000'` (委託成功). Observed: a TMF 1-lot market IOC
   got its 0000 reply at once, `nomatchqty=1`, and never filled (the test host does not match).
   Status codes (from the SDK): 0000 accepted, 0003 part filled, 0004 filled, 0002 cancelled,
   0001 reduced, 9999 / ERR1–ERR5 rejected.
5. **Fills come from `on_match`, which carries no `seq`.** Correlate through the `orderno` of the
   `on_reply` for your `seq`. `on_reply` hands over the SAME object on every update — copy fields in
   the callback.
6. **An unfilled IOC's cancel report has never been observed.** The lib treats "no fill within the
   timeout" as unfilled (`status='sent'`) and never resends.
7. **Recovering orders after a restart does not work on the test host.** `query_reply` and
   `query_match` returned 0 rows for all five parameter shapes tried (empty, network-id range,
   9-digit and 6-digit time ranges, both), even right after an accepted order. Do not build on
   them until a live account shows rows. `count` must be an int — `""` is an HTTP 400.
8. **`get_unliquidation` fails on the test host** (connection error). The libs do not use it.
9. **A process that skips `logout()` never exits** — the SDK starts non-daemon threads at login,
   failed logins included (measured: no logout → hung until killed; logout → exits in 0.5 s). Every
   login path is `try/finally: logout()`, and the login has a 30 s hard timeout.
10. **Two concurrent logins on one account both stay up** (worker + order session measured side by
    side for 50 s). Production limits are unknown — ask the rep.
11. **The SDK writes its own logs to `<cwd>/logs/<date>/*.txt`** with the login URL, login id,
    account and every order. The libs pin that to `state/president_logs/`; treat the folder as
    secret and never paste from it.
12. **Windows gotchas** — Python on Windows has no time-zone database (`ZoneInfo("Asia/Taipei")`
    raises without the `tzdata` package; the libs use a fixed UTC+8); a `.env` written by
    PowerShell 5 `Set-Content -Encoding UTF8` starts with a BOM, which hides the first key from a
    plain parser (the libs strip it).
13. The SDK's disconnect callback is spelled **`on_disonnected`** — setting `on_disconnected` does
    nothing.

---

## Limits & Gotchas

- **No broker attribution** — 統一 is the broker itself; `note` (≤10 chars) is only a label.
- **No client order id** at the broker — duplicates are blocked locally (`client_tag`, once per day).
- **No native stop / take-profit** — order types are L / M / P only; `place_stop_order` raises.
- **No deposit / withdrawal query** — the platform flags equity jumps as 資金異動 (same as 群益).
- **Per-minute query/order caps** come from the server at login (`dtrade_limit_counts`,
  `daccount_limit_counts`); over the cap the SDK answers `超過每分鐘限制!` without a network call.
  The worker skips that tick and keeps the last snapshot.
- **Maintenance (Taipei):** login 05:30–05:50; account queries 06:00–07:30; domestic futures
  trading 07:00–07:27. The worker does not query inside these windows and does not report them as
  a disconnect.
- **Trading hours:** day 08:45–13:45, night 15:00–05:00 (Mon–Fri).

---

## Verification Checklist for Agent

1. Windows machine; `pip install unitrade python-dotenv` succeeded.
2. `.env` has the five locked keys; `president_test_url` is `https://testNNN.testpfctrade.com`.
3. `python lib/president_worker.py --once` exits 0; the probe lists the positions (test host:
   equity empty with `查無資料!` is normal).
4. One test order through `order_president.place_futures_market_order(env, "TMF", "buy", 1,
   "entry")` returns `ack == '0000'` (the test host will not fill it). The user reports the test to
   the broker rep and waits for the production mail.
5. Production (`PRESIDENT_LIVE=true` + `president_url`) only with the user's explicit go-ahead;
   repeat 3–4 there with the smallest order (TMF 1 lot) and confirm equity matches the broker's app.

## Unverified until a live account

Equity and margin fields against the broker's app; which position quantity is the open interest;
fills, partial fills and the IOC-cancel report; order recovery after a restart (`query_reply` /
`query_match`); behaviour on a real settlement day and on holiday-shifted settlements; production
connection/rate limits and IP registration; the worker's behaviour across the daily maintenance
windows and weekends.
