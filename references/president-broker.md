# President Futures (統一期貨) Broker — Agent Reference

Use this document when a user asks to connect a President Futures (統一期貨) account. The
integration uses the broker's official **Unitrade API** (`pip install unitrade`).

Package docs: https://pfcec.github.io/unitrade/ · PyPI: https://pypi.org/project/unitrade/

**Status: open on the Windows desktop app since 0.1.18; cloud machines are not open yet.** The
shipped libs (`lib/order_president.py`, `lib/account_president.py`, `lib/president_worker.py`,
`lib/president_vault.py`) have placed and closed a live order on a real account (2026-10-02) and
run the broker's test host. The reconciler has a `president` block (`manager/reconciler.py`,
hand-wired like 群益), but it only trades a venue the desktop onboarding wrote (the connect
menu's 統一 entry); on a cloud machine the venue is not listed and `president_*` commands stay
unexposed. A `.env` written by hand (Step 4) is enough for the probe and test orders, not for
the reconciler; do not work around that. Everything marked *unverified* needs a live account.

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
  On a Windows cloud machine the certificate gets there one of two ways, both through the web
  自動下單 page: the user uploads a `.pfx` they already have, or — when they have none — the user
  connects to the machine over RDP themselves and applies with 憑證e總管 there (see Step 2).
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
other host until production is switched on (Step 4).

---

## Step 2 — The certificate (.pfx)

Ask the user:
> 你之前有沒有在這台電腦用過統一期貨的下單軟體、或申請過電腦憑證？

- **Yes:** it is usually at `C:\Users\<name>\PSCCA\PSC_<ID>_<expiry>.pfx`. The file name contains
  the user's national ID — never print, log or echo it; refer to it as "the certificate file".
- **No:** the user runs 憑證e總管 on this Windows machine (after the phone call in Step 1; it sends
  an SMS, so the user must be present).
- **Windows cloud machine with no certificate:** the user connects over RDP (logged in as
  Administrator), installs 憑證e總管 from https://pki.pscnet.com.tw/ and applies themselves; the
  tool saves the file under `C:\Users\Administrator\PSCCA\`. Back on the 自動下單 page they pick the
  applied-on-the-machine option and enter only the certificate password. The platform command
  `president_pfx_local` then **copies** the newest file in that folder that the password opens and
  that has not expired to `<base>\credentials\president.pfx` (the original stays for next year's
  renewal and for the user's own trading software) and logs in once read-only. Errors:
  `PFX_NONE_FOUND` (no `.pfx` in that folder), `PFX_PASSWORD`, `PFX_EXPIRED`, `PFX_INVALID`.
- **On a cloud machine you never touch this path.** Do not run, install, click through or log in to 憑證e總管, do
  not apply or renew for the user, do not read, list or copy anything under `PSCCA\`, and do not
  run `president_pfx_local` yourself. The user does the application over RDP; only the platform
  command copies the file. If the user asks you to do any of it, send them to the page.
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

**On a Windows cloud machine the user binds 統一期貨 on the web 自動下單 page, not through you.**
The platform's connect steps (`runtime/president_connect.py`) take the account and trading password
from the form, the `.pfx` and its password as an encrypted upload (or, for a certificate the user
applied for on the machine over RDP, only its password — Step 2), install `unitrade`, log in once
read-only and install the worker. Afterwards `.env` holds only sentinels (`president_password=vault:…`,
`president_ca_password=vault:ca`), `president_ca_path` points at `<base>\credentials\president.pfx`,
both hosts are written (`president_url` and `president_test_url`) and the secrets sit in the vault. Never rewrite those lines, never write the vault or the `.pfx`, never
run the steps by hand; if the user asks you to bind it, send them to the page. Unbinding (or binding
another venue) removes all seven lines, the vault, the `.pfx` and the worker service. The `.env` block
above is for a machine set up by hand (development / test host).

**Test environment first (cloud binding).** 統一 opens production API access only after the user
has placed one order on the **test host** with the test account their broker rep mailed (same
trading password, same certificate) and reported it to the rep. So a newly bound account starts in
the test environment (`"live": false` in the vault); the connect page then walks:
`president_host {"url": <the address from the mail>}` (the platform turns `test167.pfctrade.com`
into `https://test167.testpfctrade.com`) → login on the test host → `president_test_order` (one
TMF near-month market IOC buy; the test host answers `0000` and never fills; if a fill ever
arrives, one close-only IOC sell follows) → the page shows the order time and order number for the
user to read to the rep → when the rep says production is open, `president_host {"env": "live"}`
→ login on `viploginm` → `president_finish`. No certificate re-upload at the switch. While in the
test environment the worker service is removed and its snapshot deleted, so no strategy trades;
the worker is installed only after a login passed on the production host. A rebind of the same
account keeps its environment; a new account starts in test. Only two hosts are accepted by this
flow: `test167(.test)pfctrade.com` and `viploginm.pfctrade.com`.

A failed login on the test host stops logins exactly like one on production (one stop per machine).
Whether 統一 itself counts test-host failures toward the account's three wrong logins is
unconfirmed — treat it as if it does.

Production, only after the broker's production mail AND the user's explicit go-ahead, is switched
on by the platform's 統一期貨 connect flow (`president_host {"env": "live"}`) — it writes
`"live": true` into `<base>/credentials/president_vault.json`. **You cannot switch it on:** never
write that file, never run `runtime/president_test_order.py` or the connect steps yourself, and a
`PRESIDENT_LIVE` line in `.env` is refused (the libs raise rather than log in). The production host
in `.env`:

```
president_url=https://viploginm.pfctrade.com
```

Once production is on, only the two production login hosts are accepted —
`https://viploginm.pfctrade.com` and `https://viploginb.pfctrade.com` (both verified to log in with
a matching TLS certificate, 2026-10-02). The broker's production mail for this account says
**「本申請僅開放內外期 API 下單權限」** — futures order permission only (no stock trading through it).
Until then the libs only accept a `*.testpfctrade.com` host, and a login whose server reports it
is not a test server is refused. The libs read `.env` themselves (one parser: BOM tolerated, one
pair of surrounding quotes removed, nothing else interpreted) — a mapping passed by a caller is
ignored.

**A failed login stops — nothing retries by itself.** 統一 locks an account after three wrong
logins. ANY failed login (password, certificate, a refusal the libs can't classify, a timeout or no
connection) writes `state/president_login_stop.json` with its class; from then on every login on
this machine — worker, orders, a flatten — is refused locally as `STOPPED` without contacting the
broker, the worker exits and is not restarted, and the reconciler skips 統一 legs (one log line a
round, no order_error per leg). Only the user's **「確認登入」** on the connect page (the platform's
probe, `lib/president_worker.py --once`) tries again — one real login per press — and a login that
passes removes the stop. Never delete that file, never run `--once` or any login on your own
initiative: every try counts toward 統一's three. If the account is locked, the user asks their
broker rep to unlock it, then presses 「確認登入」. A `.pfx` this identity cannot read is refused as
`CERT` without contacting the broker (the SDK sends the password before it opens the certificate).
Login errors come back as a class only (`PASSWORD`, `CERT`, `CERT_MISMATCH`, `UNKNOWN`, `TIMEOUT`,
`MAINTENANCE`; `STOPPED` for a login refused locally) — for display; every class stops the same
way. The broker's own text for a certificate that is not this account's contains the national id,
so it is never passed on. No login is attempted in 05:30–05:50 (that is not a failure).

---

## Step 5 — Verify (read-only)

Do not hand-write a login script. Run the worker once:

```
python lib/president_worker.py --once
```

It logs in, reads margin and positions once, writes `state/president_probe.json`, logs out and
exits 0 (ok) / 2 (failed, with the error in the file). `equity` is 權益數; `margin_error` is set
when the broker had no margin row.

The long-running form (`python lib/president_worker.py`, no flag) is the machine's one standing
login and writes `state/president_account.json` every 60 s for `lib/account_president.py`. On a
Windows machine `python lib/president_worker.py --install` makes it the NSSM service
`blave-agent-president` (LocalSystem, auto start, log `state/president_worker.log`, registered in
`state/deployments.json` for the health check) and waits for its first snapshot; `--uninstall`
removes it. Run it with the same `python` that `pip install unitrade` went into. It refuses on the
desktop app (`BLAVE_AGENT_LOCAL=1`): there the agent runs as the user, and a LocalSystem service
running agent-writable files would hand it SYSTEM. On a cloud machine the agent's shell already
runs as LocalSystem, so the service adds no privilege.

---

## Step 6 — Orders

Use `lib/order_president.py` (full contract in `references/lib.md`):

```python
from lib import order_president

# the first argument is kept for the interface; credentials come from .env
r = order_president.place_futures_market_order({}, "TMF", "buy", 1, "entry", client_tag="t1")
print(r["status"], r["symbol"], r["fill_qty"], r["ack"])
```

- Market IOC, quantity in 口. Entries send `opencloseflag=""` (the broker decides); closes send
  `"1"` (close only) and are checked against the worker snapshot first — the held row must be on the
  other side and at least as large, and the worker's read must have **started** at least 20 s
  (`president_vault.ORDER_SETTLE_S`; live 10-02 the broker's position showed the fill 12.0 s and
  10.9 s after the send) after that contract's last send — or they are refused without reaching the
  broker. The check and a send marker are taken under one machine-wide OS lock
  (`state/president_send.lock`; released by the OS if its holder dies), so two processes
  (reconciler, 全部平倉, a script) cannot both pass it; the marker is written again right before the
  order goes out, so a slow login (up to 30 s) cannot eat the margin. Expect a close right after another order to be refused for ~20–22 s; retry, never force.
- `status='filled'` only on a real match; `status='sent'` means no fill was seen in time;
  `status='unknown'` means the broker answered a status code the SDK does not define — none of
  them is resubmitted; check the position first. `unknown` is **P3 today** (the lib's
  `order_unknown_status` audit line + a reconciler log warning; it is deliberately not written to
  `manager/order_errors.json`, because the platform turns every row there into a P1 下單失敗 TG +
  email). Raising it to P2 needs, in this order: api routing that `kind` to its own P2 event,
  `notifications.md` ranking it, then the machine writing it. Entries and closes both return the broker's
  `ack` (first status code) and `statuscode` (last).
- Entries are blocked while `state/HALT` is set; reduces always pass.

### Near month

- Contracts settle at **13:30 Taipei on the third Wednesday** of their month. The backtest's
  `TXFR1` series (`fetch_twfutures_ohlcv`) keeps the expiring month through its 13:30 close that
  day — no 13:31–14:59 bars — and its first new-month bar is the 15:00 evening session.
- **Which held rows count** (`lib/president_contracts.py`; the worker records the broker's contract
  list each tick for this):
  - **with a book** (the reconciler, its orders and 全部平倉 pass `book_months` — the contract
    months the self_ledger book recorded from each fill's `resolved_symbol`, see
    `references/manager.md` § Contract months): the bot's months are exactly the months its book
    holds. A held month the book does not record is the user's, whatever the calendar says — a far
    month the user opened becomes the front month after a settlement and is still theirs. With the
    book flat on a root, no row of that root is the bot's;
  - **without a book** (no baseline yet, a platform reader, an agent script calling the lib with
    just a root): the bot's months are the **front month** (next to settle) and the **computed
    entry month** — they differ between the roll (15:00 the day before) and the 13:30 settlement;
  - a month **past its settlement time that the broker's list, read, no longer carries** is
    **settled residue**: treated as not held, never closed (it was cash-settled), only logged;
  - a month of the bot's past its settlement time while the broker's list **could not be read**
    fails the read as a transient (`ListUnknown`): the reconciler skips the round and nothing is
    guessed — guessing "settled" would open the next month beside a holiday-postponed one that
    still trades (a month the book does not hold never fails the read);
  - a month past its settlement time that the broker **still lists** (a holiday-postponed
    settlement, or a list that has not dropped it yet) still counts as held;
  - **any other month** (a far month the user opened in the app) is **left out of every read**
    and logged once: Blave never adds to, closes or sums a month it does not trade, and it does
    not stop the bot's own months — of that root or any other — from being read, traded or closed
    by 全部平倉. It is the user's position; the user closes it in the app.
- **Entry** → if the bot holds a month of that root, the entry is added to **that month** (never two
  months at once). With nothing held: from **15:00 the day before settlement** (the night session that opens the settlement
  day's trading date) new positions go to the next month; before that, to the current one. A
  position opened in the expiring contract inside that window would be cash-settled at 13:30 and
  re-opened by the reconciler in the next month — two extra round trips. The backtest's `TXFR1`
  stays on the expiring contract through its 13:30 close (first new-month bar 15:00); live, new entries differ
  from it only by the calendar spread's move over those ≤22h30m. **Exception:** if the account still
  holds the expiring month of that root inside the window, an entry (an addition) goes to the
  expiring month too, so two months are never held at once; it settles with the rest at 13:30.
  Every entry waits (`EntryDeferred`, not an error — the reconciler books the close of a flip and
  opens next round) until the worker snapshot has caught up with the last order, since the held
  month is read from it. The contract must appear in
  `get_domestic_contracts(root, "F")`; if it does not, the order is refused — never a guess.
- **Reduce / close** → the `productid` of the position row being closed (worker snapshot), never a
  re-derived month: after a roll the near month is no longer the contract that is held. A root open
  in two months is refused; close each by its month code.
- **Close vs entry is decided by the book, never by the broker's net.** `reconcile()` splits a
  flip into a reduce_only close (capped at the account by `hand_wired_reduce_cap`, so a lot
  the user holds in the same month is never closed as the bot's) and an entry; the reconciler's
  統一 block sends a reduce_only leg as a close and anything else as an entry. The entry right
  after a flip's close usually reads a snapshot from before that close → `EntryDeferred`, sent
  next round, no 下單失敗.
- **Settlement is a book event** (`lib/portfolio.settle_expired_months`, every round): a book
  month past its settlement time that the account no longer holds and the list no longer carries,
  read so twice ≥5 s apart, is dropped from the book (audit `ledger_settled`, no notification) and
  the target re-enters in the month trading now. Still listed = postponed, kept; list unread =
  nothing decided that round. The account guard does not count a row whose every month is past
  its settlement time as an empty read, so a settlement never trips the "positions read back
  empty" HALT.
- **Known gap — same-month netting:** a futures account nets one contract. If the user holds the
  opposite side in the month the bot enters, the bot's entry closes the user's lots at the broker
  and nothing records it (futures have no `netted_qty` yet), so the bot's exit does not hand them
  back (`tests/check_capital_ledger_paths.py` M2, known bug). **Say it to the user in plain words**
  before a 統一 futures strategy goes live, and whenever they mention trading the same contract by
  hand: the bot cannot tell its lots from theirs inside one contract month; keep manual positions in
  another month or another root (MXF / TMF), never the opposite side in the month the bot trades.
- **One account, two machines** (cloud + desktop on the same 統一 account): safe only when they
  trade **different roots** (TXF vs MXF vs TMF — separate contracts, separate books). On the same
  root the two books net at the broker: no order ever exceeds what the account holds, but one
  machine's entry silently closes the other's lots, or one book adopts the other's, and both
  strategies sit on positions that do not exist.
- **Unverified on a real settlement day** (the next is 2026-10-21): what `get_domestic_contracts`
  lists between 13:30 and the night session (the worker caches it 5 minutes), and holiday-shifted
  settlements on the live broker (replayed in `tests/check_capital_ledger_paths.py` H1 2026-02 /
  H2 2023-01 with a frozen clock only).

---

## Field-Verified Lessons (test host, 2026-09-30)

1. **Test host URL** — `https://test167.testpfctrade.com`, not the `pfctrade.com` host in the mail.
2. **`get_margin` needs the currency `"NTT"`.** With `""` it answers `查無資料!` — on the test host
   and on the live account alike; `get_margin(actno, "NTT")` returns the data, and `.data` is a
   **single `DMargin` object, not a list** (the libs take both). Fields: `optequity` / `twdoptequity`
   權益數, `ordcexcess` 可動用, `iamt` 原始保證金, `mamt` 維持保證金, `dwamt` 當日出入金,
   `night_session_*` (the night-session versions), `update_date` / `update_time` (`YYYYMMDD` /
   `HHMMSS` on the day session; **unverified whether `update_date` is the calendar day or the
   trading day during the night session 00:00–05:00** — compare the snapshot's `margin_updated`
   string with the machine clock once during a night session and record it here; until then
   `president_worker.margin_epoch` drops a value more than 12 h from the clock). **Live account,
   2026-10-02: `optequity` matched the broker's app** (read layer ① passed). `dwamt` may be the way
   to a `get_flows` someday — unverified until a day with a real deposit/withdrawal.
   `get_accounts()` returns one 7-digit account; `get_position(actno, "", "")` returns one
   row per product + month (`product`, `month` `202610`, `productid` `MXFJ6`, `ot_qty_b` /
   `ot_qty_s`, `current_buy_open_position` / `current_sell_open_position`,
   `open_buy_position_average_cost`, `floating_pnl`, `product_base_number`). The test account comes
   preloaded with 1 long MXF.
3. **The open interest is `current_buy_open_position` / `current_sell_open_position`, not `ot_qty`.**
   Live account, 2026-10-02: an MXFJ6 row read `ot_qty_b=3`, `current_buy_open_position=2`, and the
   broker's app showed **2**. The libs reconcile on `current_*`; `ot_qty` is kept in the snapshot
   as `debug_ot_net` only.
4. **`issend=True` is not acceptance.** `order()` returns `issend` + `seq`; acceptance is the
   `on_reply` for that `seq` with `statuscode == '0000'` (委託成功). Observed: a TMF 1-lot market IOC
   got its 0000 reply at once, `nomatchqty=1`, and never filled (the test host does not match).
   Status codes — source: unitrade 1.0.0.7 `trade/dlogic` (`DLogic.*_CODE`); the official docs
   have no table: 0000 委託成功, 0001 減量成功 (not terminal), 0002 刪單成功, 0003 部份成交,
   **0004 完全成交**, 0006 改價成功; rejections 9999 (SDK error reply), ERR1/2/3/5 (委託傳送失敗 /
   尚未開盤 / 驗章失敗 / 已收盤) and server 99xx (the official dtrade page's example: 9902
   `TTO0002:尚未開始接收委託或者不接受此種委託`). **Live, 10-02: the first reply to a market IOC was
   already 0004** — the order filled before an 0000 was seen — so success is any of
   0000/0001/0003/0004/0006, not 0000 alone. Any other code: not a success, not a rejection —
   `status='unknown'`, audited, never resent.
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
    account, every order — and on a certificate/signing failure the national id and the
    certificate's subject. The libs pin that to `<base>/credentials/president_logs/` (next to the
    vault; removed on unbind — an older lib wrote `state/president_logs/`). **Never read, `cat`,
    grep or upload anything under either**; to diagnose, use the worker's probe file and the lib's
    error classes.
12. **Windows gotchas** — Python on Windows has no time-zone database (`ZoneInfo("Asia/Taipei")`
    raises without the `tzdata` package; the libs use a fixed UTC+8); a `.env` written by
    PowerShell 5 `Set-Content -Encoding UTF8` starts with a BOM, which hides the first key from a
    plain parser (the libs strip it).
13. The SDK's disconnect callback is spelled **`on_disonnected`** — setting `on_disconnected` does
    nothing.
14. **`opencloseflag "1"` (close only) guards nothing on the test host.** A 1-lot MXF sell against
    the preloaded long and a 1-lot TMF buy with **no TMF position** were both answered 0000
    (委託成功, `opencloseflag '1'` echoed back); neither filled, positions unchanged. Whether
    production refuses a close with nothing to close is unverified — the snapshot check in the lib is
    the guard that is known to work.
15. `statuscode 0001` is 減量成功 (a quantity reduction), not a cancel — only 0002 ends an order early.
16. A certificate that is not the account's comes back from the SDK as `":!! " + national id + the
    certificate's subject` — the libs classify it `CERT_MISMATCH` and never pass the text on.

---

## Limits & Gotchas

- **No broker attribution** — 統一 is the broker itself; `note` (≤10 chars) is only a label.
- **No client order id** at the broker — duplicates are blocked locally (`client_tag`, once per day,
  recorded once the broker took the send; a process killed between the send and the record leaves
  the tag reusable).
- **One root in two contract months fails the position read** (a long J6 and a short K6 would add up
  to "flat"); the user closes one month in the 統一 app.
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
3. `python lib/president_worker.py --once` exits 0; the probe lists the positions and equity.
4. One test order through `order_president.place_futures_market_order({}, "TMF", "buy", 1,
   "entry")` returns `ack == '0000'` (the test host will not fill it). The user reports the test to
   the broker rep and waits for the production mail. (On a cloud machine bound through the web page
   the page places this order itself — `president_test_order` — not you.)
5. Production (switched on by the binding flow + `president_url`) only with the user's explicit go-ahead;
   repeat 3–4 there with the smallest order (TMF 1 lot) and confirm equity matches the broker's app.

Status (2026-10-02, live account):
- Read layer: login on both production hosts ✓; equity (`optequity`) matches the app ✓ (①);
  positions match the app on `current_*` ✓.
- **First live round trip, 12:42 Taipei, TMF 1 lot through the shipped lib** (the user's existing
  MXF position untouched): buy TMFJ6 filled at 48716, ack 0004, 6.3 s from the call to the
  confirmed fill; the broker's position showed it **12.0 s** after the send marker; close (sell, `"1"`)
  filled at 48712, 5.2 s; position flat **10.9 s** after the marker; the worker snapshot caught up
  6.0 s after each. (`ORDER_SETTLE_S` raised from 10 to 20 s on these numbers.)

Trading-layer checklist (`venue-onboarding.md` §3):
| item | state |
|---|---|
| confirmed fills reported (not intent), single market IOC buy + close | ✓ live 10-02 |
| close-only (`"1"`) close of a held position, snapshot-checked | ✓ live 10-02 |
| HALT blocks entries, closes pass; restart gate; audit trail | ✓ tests (no live HALT run) |
| unit = 口, canonical TXF/MXF/TMF ↔ month code | ✓ live (TMFJ6) |
| IOC not filled → cancel report | ✗ never observed |
| partial fills | ✗ not seen |
| order recovery after a restart (`query_reply` / `query_match`) | ✗ 0 rows on the test host, untried live |
| settlement day (10-21) and holiday-shifted settlement | ✗ |
| production `"1"` with nothing to close | ✗ untried (test host accepts it) |
| the broker's text for a wrong password | ✗ |
| `dwamt` as a deposit/withdrawal source | ✗ needs a day with a real flow |
| limit layer / execution styles | not shipped (chase falls back to market) |

## Still unverified

Margin fields other than `optequity` against the app; `dwamt` as a flow source; whether production refuses a close-only (`"1"`) order with nothing to close; the broker's text for a
wrong password (so `PASSWORD` is classified from it, not counted as `UNKNOWN`);
partial fills and the IOC-cancel report; order recovery after a restart (`query_reply` /
`query_match`); behaviour on a real settlement day and on holiday-shifted settlements; production
connection/rate limits and IP registration; the worker's behaviour across the daily maintenance
windows and weekends.
