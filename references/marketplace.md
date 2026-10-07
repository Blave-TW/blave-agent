# Strategy Library API

Use Blave API credentials from `.env` for all requests.
Base URL: `https://api.blave.org`
Headers: `api-key: {blave_api_key}`, `secret-key: {blave_secret_key}`

> **「安裝 / install / 載入 / 部署 / deploy 我（買的）策略」= this API.**
> Loading a purchased/shared/official strategy is ALWAYS a plain HTTP call to the endpoints below — the user is identified by the `.env` Blave key, so they never supply an identifier, code, or install command. The verb the user used (安裝/載入/部署/install/load/deploy) does not change the flow: for a purchased strategy, go straight to `GET /openclaw/marketplace/my/purchases`. (Skills are a separate runtime layer, provisioned automatically — never relevant to loading a strategy.)

## Strategy categories

The **Strategy Library** is the umbrella system. Within it, every strategy falls into exactly one of four categories. "**Marketplace**" specifically means the *paid public store* (category 2) — not the whole library.

| Category | Source | Cost | Who can see / download code | List endpoint |
|---|---|---|---|---|
| **Official** | Listed by Blave | Free | All users, no purchase needed | `GET /my/official` |
| **Marketplace (paid)** | Listed for sale by other users | Paid | Anyone can browse; code downloadable only **after purchase** | Browse `GET /strategies`; after buying `GET /my/purchases` |
| **Shared** | Privately shared to specific users | Free | Only the named recipients; not public, not browsable | `GET /my/shared-with-me` |
| **Private** | Uploaded by you | — | Only you (plus anyone you explicitly share with) | `GET /my/private` |

Distinguishing dimensions: **source** (who created it), **cost** (free / paid), **visibility** (public / named recipients / yourself only).

- **"What strategies can I use / load?"** → the first three categories (official + purchases + shared-with-me) are the strategies authored by others that you can load. Merge and dedupe them, then let the user pick. See [My accessible strategies](#my-accessible-strategies).
- **"Which private strategies have I uploaded?"** → the fourth category, via `GET /my/private`. See [Private strategies](#private-strategies).
- A private strategy can be **promoted** to the Marketplace (submit for sale) or **shared** with specific users, but by default it is visible to you alone.

## Browse

List all available strategies:
```
GET /openclaw/marketplace/strategies
```
Response: `[{id, title, description, price, category, created_at}, ...]`

Strategy detail (includes `purchased: true/false`):
```
GET /openclaw/marketplace/strategies/{id}
```

## My accessible strategies

**Flow when user asks what strategies they have, or wants to load any strategy:**
1. Call ALL THREE endpoints in parallel:
   - `GET /openclaw/marketplace/my/purchases` — purchased strategies
   - `GET /openclaw/marketplace/my/shared-with-me` — strategies others shared with you
   - `GET /openclaw/marketplace/my/official` — free official strategies (no purchase needed)
2. Merge and deduplicate by id. Show the combined list to the user
3. User picks one → `GET /openclaw/marketplace/strategies/{id}/code`
4. Save code to `tmp/<filename>.py` (`mkdir -p tmp` first — it is gitignored and absent on a fresh machine)
5. **Check for multi-strategy bundle** — scan the file for lines matching `# ===== STRATEGY \d+:`:
   - If found: split into separate files (see "Deploying a multi-strategy bundle" below), security scan and deploy each one individually
   - If not found: proceed as single strategy
6. **Security scan** — run `python3 lib/security_check.py --context install tmp/<filename>.py`. **Decide on its `RESULT: …` line (printed first), never on the exit code** — on Windows a command wrapped in PowerShell comes back as exit 1 for both 1 and 2. **Output with no `RESULT:` line (an old checker, or the scan itself failed) counts as `RESULT: do-not-run`.** Then do what its `NEXT:` line (second) says. The same holds for every `lib/security_check.py` and `lib/quality_check.py` run in this file; `--context` always goes before the file.
   - `RESULT: clean` → go on to step 7
   - `RESULT: ask-user` (warnings) → show findings to user, ask for confirmation; if confirmed, go on to step 7
   - `RESULT: do-not-run` (critical) → show findings, delete `tmp/<filename>.py`, do NOT run
7. **Quality scan, then move** — still on the download: `python3 lib/quality_check.py --context install tmp/<filename>.py` (Type A and C — a Type B skips the scan and is moved as is), then do what its `NEXT:` line says. **Nothing goes into `strategies/` before this scan has passed:** a refused download then leaves no strategy folder behind, and a re-download over an installed strategy of the same name leaves the user's installed copy untouched.
   - `RESULT: clean` / `RESULT: run-as-is` → move it, then step 8. Say each warning the `NEXT:` line lists in plain words (「回測圖上不會有指標線」) — no constant names, no tool names.
   - `RESULT: do-not-run` → not installed: delete `tmp/<filename>.py` (step 9) and say why in one plain sentence (「這支策略的訊號函式沒有回傳值，跑出來的回測會是錯的，所以沒有裝」). If it already sits in `strategies/` (moved before this scan), delete `strategies/<name>/` only when this install created that folder; a folder that existed before this install is the user's and stays.
   - Move = `mv` (never `cp` — a copy leaves the download behind in `tmp/`) to `strategies/<name>/strategy.py` (`mkdir -p strategies/<name>`; `<name>` = the file's `STRATEGY_NAME`). The layout is always `strategies/<name>/strategy.py`, never a flat `strategies/<name>.py` — the template's `sys.path.insert(0, parent.parent.parent)` and the runner's `stats.json` output both assume that depth; a flat file dies with `No module named 'lib'`
8. **Run it — MANDATORY, never skip** (unless step 6 or 7 said `do-not-run`, or the user said no at step 6's `ask-user`): `python3 strategies/<name>/strategy.py` — or `BLAVE_MODE=backtest python3 strategies/<name>/strategy.py` when `<name>` is already a key of `amounts` in `manager/portfolio_config.json` (a re-install over a picked strategy, amount 0 included), otherwise the run is a quiet live tick with no version and no chart (`references/deployment.md` › *Live vs Backtest*). Every run writes `strategies/<name>/stats.json` (metrics + daily returns); that file is what makes the strategy selectable in the web workspace's 下單設定 › 選擇策略 picker — a downloaded-but-never-run strategy is invisible there and reads as a broken install. Report the resulting stats to the user.
9. **Leave nothing of the download in `tmp/`.** However the flow ended — installed, refused or failed — delete every `tmp/<filename>.py` this install wrote (split bundle files included) before the reply. The same holds for the fork, bundle and shared flows below.

**Listing name vs code.** A library title is the listing name; the code's header comment and `STRATEGY_NAME` may still carry the research name (#101 「BTC 通道動能共振」 ships as `rsi_bb_reversal`, header "RSI + Bollinger Bands"). When the code's `DISPLAY_NAME`, `SYMBOL`, `INTERVAL` and long/short side match what the pick and its listing say, install it — a different header comment or `STRATEGY_NAME` is not a reason to stop. Mention it in one sentence in the reply. When `SYMBOL`, `INTERVAL` or the side does not match, stop before moving it into `strategies/` (step 7) and ask the user. This holds for every install in this file: desktop picks, bundles and shared strategies.

Purchases and shared-with-me are separate lists — checking only purchases will miss shared strategies.

## Desktop-downloaded picks

On the desktop app a library pick arrives as 「策略庫的「{title}」（#{id}）已經下載好了，幫我安裝並跑一次回測看看結果」 / "The library strategy "{title}" (#{id}) is downloaded. Install it and run a backtest to see the results." The app has already fetched that strategy's code — with the user's own access (official, purchased or shared), or with no sign-in at all for an official, free strategy that needs no Blave data — and saved it as `tmp/library_<id>.py`. It is a plain install:

1. **Do not call the Strategy Library API for it** — no `/code`, no lists. This workspace may hold no Blave key this turn (no card, or this hour's data fee not covered), and the code is already here.
2. `tmp/library_<id>.py` missing → say the download did not arrive and ask the user to press the button again; never fetch it some other way.
3. `tmp/library_<id>.security.json` present → the platform's server-side scan of someone else's code. If its `findings` list is not empty, show them to the user and ask before going on, exactly like a `lib/security_check.py` `RESULT: ask-user`.
4. Continue the install flow above from step 5 (bundle check → security scan → quality scan → move → run) with `tmp/library_<id>.py` as the downloaded file. *Listing name vs code* above applies.
5. Step 9 applies: delete `tmp/library_<id>.py` and `tmp/library_<id>.security.json` before the reply.

Whether the backtest needs Blave data changes none of this. A strategy on public klines runs without data access; one that needs Blave data stops at its first Blave call with `DataAccessError`, and only then does the desktop data-access rule apply.

The older 「幫我下載官方策略「{title}」（#{id}）…」 / 「幫我下載已購買的策略…」 picks (the web workspace, the desktop's cloud view, desktop apps before 0.1.13) still mean: fetch the code yourself with the install flow above.

## Forking a strategy (use one as a base for the user's own)

**Fork ≠ install.** When the user wants an existing strategy as a *starting point to modify* — 「用 X 當底」, "fork", "copy it into my own strategy" — do NOT run the install flow above. (A web-workspace library pick shaped like 「幫我下載官方策略「{title}」（#{id}），跑一次回測看看結果」 is a plain install, NOT a fork — run the install flow above with the given id.) Instead:

1. Identify the base strategy: if the message names it (title or #id), use that; otherwise list accessible strategies (official + purchases + shared-with-me, merged) and let the user pick.
2. `GET /openclaw/marketplace/strategies/{id}/code` → save to `tmp/<filename>.py`.
3. **Security scan, then quality scan, both on the download** — `python3 lib/security_check.py --context fork tmp/<filename>.py`, then (Type A/C) `python3 lib/quality_check.py --context fork tmp/<filename>.py` before anything is saved under `strategies/`; decide on each `RESULT:` line as when installing and do what its `NEXT:` line says (`do-not-run` → delete `tmp/<filename>.py`, create no fork).
4. **Rename before anything runs.** Pick a NEW `STRATEGY_NAME` (ask the user or default to `<orig>_custom`), set `DISPLAY_NAME`/`DESCRIPTION` to describe the user's variant (a fork is a draft — it has no schedule or order settings until the user deploys it), and save to `strategies/<new_name>/strategy.py`. Never overwrite or collide with an installed copy of the original — the fork is a separate strategy from day one.
5. **Run the baseline backtest immediately** (Type A/C; unless step 3 stopped it — `do-not-run`, or the user said no to an `ask-user`): `python3 strategies/<new_name>/strategy.py` — a `run-as-is` scan runs it unchanged too (its `NEXT:` line). This baseline run is part of the fork request itself, not an extra iteration under Iteration Brakes. It writes `stats.json`, which also makes the fork selectable in the 下單設定 › 選擇策略 picker — without it the fork is invisible there.
6. **A fork is a draft, not a deployment.** Do not schedule it, do not add it to the 下單組合. From here it is the user's own strategy: follow `references/strategy-code.md`, and backtest again after any change before live use. Iteration Brakes apply as usual after the baseline run. (One exception: a fork built to replace a LIVE strategy is deployed and funded at the end of the fork-and-switch flow in `references/strategy-code.md` › *Editing a live strategy* — that flow's own steps govern when.)
7. Report the baseline stats, tell the user what the base strategy does (from its description/report), and ask what they want to change — do not invent modifications on your own.

## Deploying a multi-strategy bundle

When the downloaded code contains `# ===== STRATEGY N: <name> =====` markers, treat it as a bundle:

1. Split the code at each `# ===== STRATEGY N:` line into N separate strings
2. Save each to `tmp/<name_slug>.py` (derive slug from the strategy name after the colon)
3. Run `python3 lib/security_check.py --context install tmp/<name_slug>.py` on **each** file separately
   - `RESULT: do-not-run` (critical) → delete that file, do NOT run it; continue with the others
   - `RESULT: ask-user` (warnings) → show findings, ask user for confirmation before going on with it
4. Set `STRATEGY_NAME = "<name_slug>"` in each split file still in `tmp/`, then run `python3 lib/quality_check.py --context install tmp/<name_slug>.py` on each Type A/C file (skip only Type B) and follow its `NEXT:` line — a `do-not-run` stops only that file; continue with the others
5. Move approved files to `strategies/<name_slug>/strategy.py` (one directory per strategy) — the directory name MUST equal the file's `STRATEGY_NAME` (the runner writes `stats.json` under `strategies/<STRATEGY_NAME>/`, and the web only sees a backtest whose `stats.json` sits next to its `strategy.py`)
6. Run each moved file (one stopped at step 3 or 4 is not run): `python3 strategies/<name_slug>/strategy.py` (`BLAVE_MODE=backtest python3 …` for any slug already in the order settings — same rule as step 8 of the install flow)

Example: a file containing two strategies marked as `# ===== STRATEGY 1: BTC SMA Cross =====` and `# ===== STRATEGY 2: ETH RSI Fade =====` should produce `strategies/btc_sma_cross/strategy.py` and `strategies/eth_rsi_fade/strategy.py`.

## Load official strategies (free)

List all official Blave strategies — no purchase required:
```
GET /openclaw/marketplace/my/official
```
Response: `[{id, title, description, category, created_at}, ...]`

Code is freely accessible:
```
GET /openclaw/marketplace/strategies/{id}/code
```

## Load purchased strategies

List purchased strategies:
```
GET /openclaw/marketplace/my/purchases
```

Fetch strategy code (requires purchase or is_official):
```
GET /openclaw/marketplace/strategies/{id}/code
```
Response: `{"code": "..."}` — save to `.py` and run with `python3`.

## Load shared strategies

List strategies shared with you:
```
GET /openclaw/marketplace/my/shared-with-me
```
Response: `[{id, title, description, category, shared_at}, ...]`

**Flow when user says a strategy was shared with them, or asks what strategies they have access to:**
1. `GET /openclaw/marketplace/my/shared-with-me` — show the list
2. User picks one → `GET /openclaw/marketplace/strategies/{id}/code`
3. Save code to `tmp/<filename>.py` (NOT strategies/ yet; `mkdir -p tmp` first)
4. **Security scan** — run `python3 lib/security_check.py --context install tmp/<filename>.py`
   - `RESULT: clean` → go on to step 5
   - `RESULT: ask-user` (warnings) → show findings to user, ask for confirmation; if confirmed, go on to step 5
   - `RESULT: do-not-run` (critical) → show findings, delete `tmp/<filename>.py`, do NOT run
5. **Quality scan, then move** (Type A and C — skip only Type B) — run `python3 lib/quality_check.py --context install tmp/<filename>.py` and follow its `NEXT:` line, as in step 7 of the install flow. Then move it (`mv`) to `strategies/<name>/strategy.py` (`<name>` = the file's `STRATEGY_NAME`)
6. **Run it — MANDATORY, never skip** (unless step 4 or 5 said `do-not-run`, or the user said no at step 4's `ask-user`): `python3 strategies/<name>/strategy.py` (`BLAVE_MODE=backtest python3 …` when `<name>` is already in the order settings) — writes `stats.json`, which the 下單設定 › 選擇策略 picker requires (same as step 8 of the install flow above, escape hatch included). Report the stats to the user.

## Strategy report (performance data)

> **Admin only (user_id == 1)** — for ALL strategies, official or community. Sellers cannot submit
> their own report; they send numbers to admin out-of-band.

Get backtest performance for a strategy:
```
GET /openclaw/marketplace/strategies/{id}/report
```
Response: `{total_return, annual_return, sharpe, max_drawdown, pnl_image_url, backtest_start, backtest_end}`

Submit metrics + optional P&L chart image in one call:
```
POST /openclaw/marketplace/strategies/{id}/report
Content-Type: multipart/form-data
Fields: total_return, annual_return, sharpe, max_drawdown, backtest_start, backtest_end (all required)
        symbol, interval (optional)
        image = pnl.png (optional file field)
        gates = JSON string (optional, see below)
```
**Do not include `pnl_curve`** — P&L chart is displayed as an uploaded image, not rendered from data.
Response: `{"status": "ok", "strategy_id": ..., "pnl_image_url": "https://..." | null}`

`gates` = the quality-gate results of **this same backtest**, which drive the library's "Verified" badge:
```json
{
  "mcpt_status": "pass" | "fail" | "not_applicable",
  "mcpt_p": 0.005, "mcpt_n": 2000,
  "robust": {"raw_sharpe": 1.49, "plateau_sharpe": 1.32, "ratio": 0.884},
  "fee": {"rate": 0.0005, "actual": 0.0005, "venue": "binance"}
}
```
- `mcpt_p` / `mcpt_n` are required numbers unless `mcpt_status` is `not_applicable` (Type C portfolios), where they are `null`.
- `robust.ratio` = plateau Sharpe ÷ selected Sharpe (`lib/param_scan.find_plateau`); `fee.rate` = the strategy's `FEE`, `fee.actual` = the venue's per-side taker cost.
- The server computes pass/fail and "Verified" itself — do not send a `verified` key (it is ignored).
- A malformed `gates` rejects the whole call with 400 and nothing is written.
- **A full-metrics refresh without `gates` clears the stored gates and the badge disappears.** Whenever you re-post numbers, re-run the gates (MCPT + parameter scan) on that backtest and send them in the same call.
- Posting only `stats` (curve refresh, no metric fields) leaves gates untouched.

**Admin flow — after running backtest:**
1. `python3 strategies/{name}/strategy.py` → generates `strategies/{name}/pnl.png` + `strategies/{name}/stats.json` (`BLAVE_MODE=backtest python3 …` if `{name}` is in this machine's order settings — a quiet live tick draws no `pnl.png`; `references/deployment.md` › *Live vs Backtest*)
2. Read `stats.json` for metrics. Compute `annual_return` from total return + date range if not present.
3. Re-run the quality gates on this backtest and build the `gates` JSON above.
4. POST metrics + `gates` + `strategies/{name}/pnl.png` together to `POST /strategies/{id}/report` (multipart)

## Admin endpoints (user_id == 1 only)

List pending community submissions:
```
GET /openclaw/marketplace/admin/pending
```

Approve a pending strategy (makes it public):
```
POST /openclaw/marketplace/admin/strategies/{id}/approve
Body (optional): {"category": "Crypto" | "TW Stock" | "US Stock" | "Forex" | "Other"}
```
If the pending strategy's current category is not one of `Crypto` / `TW Stock` / `US Stock` / `Forex` / `Other`, approval is rejected with 400 unless the body sets one (submissions are free-form, so this is where the public category gets fixed).

Reject a strategy (sets status to unlisted):
```
POST /openclaw/marketplace/admin/strategies/{id}/reject
```

Create an official strategy (approved + public + is_official immediately):
```
POST /openclaw/marketplace/admin/strategies/official
Body: {title, description, category, code}
```
`category` must be exactly `Crypto`, `TW Stock`, `US Stock`, `Forex` or `Other` (anything else is rejected with 400). Submissions (`/strategies/submit`) and private uploads (`/strategies/private`) accept any string category up to 100 characters (may be empty or omitted); a non-string or longer value is rejected with 400.

## Description format (required for all uploads)

Description is **plain text only** — 1–2 sentences describing the strategy logic. No parameter values, no markdown sections.

Example: `台股動能輪動：每週從跨產業台股中選出動能最強的前 30 支等權持有，週末調倉，自動跟隨強勢板塊輪動。`

If the strategy uses a **custom lib** (not standard lib), append a brief note:
```
Custom lib: lib/orders_kraken.py — place_order("BUY"|"SELL"|"SHORT"|"COVER"). Requires KRAKEN_API_KEY, KRAKEN_SECRET_KEY.
```

## Submit a strategy for sale

**Before submitting a Type A or C strategy** (skip only for Type B — no backtest, no FEE),
run `python3 lib/quality_check.py --context edit strategies/<name>/strategy.py` — catches a `FEE=0` backtest
(inflates the Sharpe/return you're about to advertise to buyers), an unfilled
`compute_signals()` template, and a TAIFEX futures strategy missing the mandatory
`txf_settlement_mask` (its backtest books fake roll-gap PnL). Do what its `NEXT:` line says
before calling the endpoint below.

```
POST /openclaw/marketplace/strategies/submit
Content-Type: application/json

{
  "title": "Strategy Name",
  "description": "<structured description — see format above>",
  "price": 300,
  "category": "Crypto",
  "code": "...full source code..."
}
```
`category` is free-form here (any string up to 100 characters, may be empty or omitted; a non-string or longer value is rejected with 400). At review Blave assigns the public category — exactly one of `Crypto`, `TW Stock`, `US Stock`, `Forex`, `Other`.

Status starts as `pending`. Blave reviews and publishes it.

Check submission status:
```
GET /openclaw/marketplace/my/submissions
```
Response: `[{id, title, price, status, visibility, created_at}, ...]`
Status values: `pending` | `approved` | `unlisted`

## Submitting a multi-strategy bundle

Pack two or more strategies into a single file using the `# ===== STRATEGY N: <name> =====` delimiter. Submit via the normal endpoint — no new endpoint needed.

**File format:**
```python
# ===== STRATEGY 1: BTC SMA Cross =====
STRATEGY_NAME = "btc_sma_cross"
SYMBOL        = "BTCUSDT"
# ... full strategy 1 code ...

# ===== STRATEGY 2: ETH RSI Fade =====
STRATEGY_NAME = "eth_rsi_fade"
SYMBOL        = "ETHUSDT"
# ... full strategy 2 code ...
```

**Description format** — repeat the structured block once per strategy, separated by `---`:
```
## Strategy logic
[Strategy 1 logic]

## Parameters
- SYMBOL: BTCUSDT, INTERVAL: 1h, ...

## Standard lib used
[...]

---

## Strategy logic
[Strategy 2 logic]

## Parameters
- SYMBOL: ETHUSDT, INTERVAL: 4h, ...

## Standard lib used
[...]
```

**Submit:**
```
POST /openclaw/marketplace/strategies/submit
Content-Type: application/json

{
  "title": "BTC SMA Cross + ETH RSI Fade Bundle",
  "description": "<structured description for both strategies>",
  "price": 500,
  "category": "Crypto",
  "code": "# ===== STRATEGY 1: BTC SMA Cross =====\n...\n\n# ===== STRATEGY 2: ETH RSI Fade =====\n..."
}
```

Status starts as `pending`. Blave reviews and publishes it. Buyer downloads the single file and their agent automatically splits and deploys both strategies.

## Private strategies

Private strategies are your own uploads — only you can see them (plus anyone you explicitly share with). They are free, skip review, and are immediately accessible.

**List your private strategies:**
```
GET /openclaw/marketplace/my/private
```
Response: `{"strategies": [{id, title, description, category, created_at}, ...]}`
This is the only category not covered by the three "accessible strategies" endpoints — use it when the user asks which strategies they have uploaded, or to list their own private strategies.

Upload a private strategy (no review, immediately accessible):
```
POST /openclaw/marketplace/strategies/private
Content-Type: application/json

{
  "title": "My Private Strategy",
  "description": "<structured description — see format above>",
  "category": "trend",
  "code": "...full source code..."
}
```
Response: `{"status": "ok", "strategy_id": 123}`

**Delete a private strategy:**
```
DELETE /openclaw/marketplace/strategies/{id}
```
Response: `{"status": "ok"}`
- Owner only. Private strategies only — public strategies cannot be deleted.
- Also removes all shares associated with the strategy.

**Flow when user wants to share a private strategy with specific users:**
1. If the strategy isn't uploaded yet → `POST /openclaw/marketplace/strategies/private` first
2. `POST /openclaw/marketplace/strategies/{id}/share` with the target user IDs
3. Confirm back to the user which strategy ID was shared with which UIDs
4. Tell the user to inform the recipient: **請對方跟他的 Blave Agent 說「幫我看一下有沒有人分享策略給我」**，agent 會自動去 shared-with-me 撈取並載入。

Share with specific user IDs:
```
POST /openclaw/marketplace/strategies/{id}/share
Content-Type: application/json

{"user_ids": [456, 789]}
```

Remove a user's access:
```
DELETE /openclaw/marketplace/strategies/{id}/share
Content-Type: application/json

{"user_id": 456}
```

View share list (owner only):
```
GET /openclaw/marketplace/strategies/{id}/shares
```
Response: `{"shares": [{"user_id": 456, "shared_at": "..."}]}`

View strategies shared with you:
```
GET /openclaw/marketplace/my/shared-with-me
```

Download code (works for owned, purchased, or shared strategies):
```
GET /openclaw/marketplace/strategies/{id}/code
```
Response: `{"code": "..."}` — save to `strategies/<name>/strategy.py` and run with `python3 strategies/<name>/strategy.py` (`BLAVE_MODE=backtest python3 …` when `<name>` is already in the order settings — step 8 of the install flow).

If execution fails with `ImportError` on a custom lib module, read the strategy's description "Custom lib dependencies" section and create the missing file in `lib/` before re-running.
