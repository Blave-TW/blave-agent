# Billing — what costs what

The single answer sheet for 「這樣會不會扣錢」/「扣什麼錢」questions. Everything below was read
from the platform code, not remembered — sources are named per section. If a question is not
covered here, say you are not sure and point the user to the usage page; never invent a number.

Sources (api repo): `account/credit.py` (`PRICING`, `LLM_PRICING`, `WEB_SEARCH_PRICING_TWD`,
`deduct_credit`, `deduct_blave_api_credit`, `deduct_server_credit`), `openclaw/lightsail.py`
(`SERVER_TIERS`, `WINDOWS_SERVER_TIERS`), `openclaw/proxy.py` (`_deepseek_peak_multiplier`,
`deduct_llm_credit` call sites), `snapshot/cron_deduct_server_credit.py`, `account/agent_trial.py`,
`decorators.py` (`api_plan_required`); plan billing: `account/agent_plan_config.py`, `account/agent_plan.py`.

## Two billing schemes — find out which one this account is on first

Blave Agent is moving from **hourly billing** (the server, and Blave data for accounts without a
machine, charged from the wallet every clock hour) to **plan billing** (a cloud plan paid per
period). Each account moves on a switch date the platform emails to that user; until then
everything under *Hourly billing* below is what really happens, and nothing under *Plan billing*
applies yet.

- **How to tell:** Settings › 帳號與方案 (en: Account & plan) in the desktop app, or the plan
  page on the web (`/agent/<lang>/usage#plan`). A plan with a billing cycle and a next payment
  date = plan billing. A per-hour price, or usage-page rows like `Server hourly (<tier>, …): 1h`
  = hourly billing.
- **Cannot tell** (no access to those pages from where you are): say both briefly — "billed by
  the hour until your account switches to a plan; after that, a monthly or annual plan" — and
  point to Settings › 帳號與方案. Never present plan-billing facts as current for an account you
  have not seen switched.

## Plan billing (accounts already switched)

- **A plan is the access, a machine is optional.** Tiers are Linux or Windows, Starter / Premium
  / Max, at the monthly prices in the table under *Meter 1* (same figure per tier; there is no
  hourly price on a plan). Every plan includes Blave data — in the desktop app, and on the cloud
  machine if the account runs one. The desktop app starts a plan without a machine (Linux
  Starter price); a cloud machine is started on the website, under the same plan.
- **Only keys Blave Agent issues are covered** — the cloud machine's own key and the desktop
  app's sign-in key. A key the user created themselves (API page; their own scripts, an external
  agent) needs an **API plan**, even with a Blave Agent plan or during the trial; without one it
  gets `403 ERR007` pointing to the API plan. Never tell someone their Agent plan covers a key
  they made themselves.
- **There is no desktop-only data plan and no hourly data purchase.** Someone who only uses the
  desktop app and wants Blave data needs a cloud plan or an API plan. During the card trial the
  desktop gets the data anyway. Without any of these, exchange klines and the key-free public
  fetchers still work.
- **Two cycles:** monthly (a 30-day period) or annual (a one-year period priced below twelve
  months). Quote the annual figure the plan page or Settings › 帳號與方案 shows; never work it
  out yourself.
- **Paid up front, wallet first.** Each period — the first and every renewal — comes from the
  wallet if the balance covers the whole period; otherwise the bound card is charged for the
  whole period and the wallet is left alone. No card and not enough balance = the payment fails.
- **Payment fails → the machine stops and Blave data pauses.** It is retried daily, and a top-up
  or a new card triggers a retry at once ("pay again" on the plan page does too). If it stays
  unpaid, the machine is deleted after a grace period, with the strategies, data and keys on it
  — the plan page shows the date. A successful payment restarts the machine and starts a new
  period from then.
- **Cancel = runs to the end of the period, no refund**; after that the machine is deleted on
  the same grace rule. Deleting the machine on the web also cancels the plan. A cancelled plan
  can be resumed on the plan page — after the period has ended, resuming charges a new period
  at once (and starts a deleted machine again).
- **Upgrade (same OS, to a bigger tier) applies at once** and charges only the difference for
  the time left in the period; the period end does not move. The plan page shows the exact
  amount before confirming. Not during the free trial, and not on a cancelled plan.
- **Switching monthly ↔ annual applies from the next period.** A smaller tier or the other OS is
  not supported on a cloud plan; say so and point to the plan page rather than promising a date.
- **Stopped or running makes no difference** to the plan: the period is already paid and it
  still renews. Only cancelling ends it.
- **Card trial (Linux Starter):** no plan charge during the trial; the first period of the
  chosen cycle is charged when it ends. Cancelling before then charges nothing.
- **The wallet** still holds the AI credit (Blave AI turns, *Meter 3*) and pays plan periods.
  Auto top-up adds a fixed amount when the balance drops below a threshold — the usage page
  shows both; do not quote the hourly-billing figures below for a plan account.

## Hourly billing (accounts not yet switched)

Everything from here to *Meter 3* describes hourly billing. On a plan account, *Meter 1*'s table
still gives the monthly price per tier, and the rest of those two sections does not apply.

## Desktop app — read this first when the question comes from the desktop

`BLAVE_AGENT_LOCAL=1`. The rest of this file was written from the cloud machine's side; on the
desktop the same three meters exist, but which ones apply depends on two things the user chose.

- **The app itself is free.** No licence, no subscription, no fee for backtests, scans, paper or
  live trading on this computer.
- **LLM — depends on the engine.** On the user's own Claude Code / Codex, Blave charges nothing
  for AI: that usage is on the user's own plan with that provider. With the engine set to
  **Blave AI**, every turn is billed from the Blave balance exactly as Meter 3 describes. Never
  say LLM is billed "only on a cloud machine".
- **Data — depends on the account, not on the app.** Exchange klines and Taiwan daily bars from
  TWSE / TPEx need no Blave key and cost nothing. Blave data (indicators, Taiwan-market
  datasets) through the key the app received at sign-in is free while the card trial runs, or
  when the account has a cloud machine or an API plan; otherwise it is Meter 2 — charged per
  clock hour in which any call was made, never per call. Never say the data fee is only for
  people calling the API with their own key.
- **Server — only if the user opens a cloud machine.** Meter 1, table below: quote the monthly
  figure of the tier asked about (Linux Starter when they name none) and say data is included.
- **Where the user sees their own numbers:** Settings › 帳號與方案 (en: Account & plan)
  shows the monthly price of their machine and whether data is included for them; the web usage
  page lists every deduction. Point there for anything this file does not state, instead of
  answering that there is no number.

## The wallet

- One prepaid credit balance in TWD. Top-up sizes: 300 / 800 / 1500 / 3000 TWD. With a card bound,
  auto top-up adds 300 TWD when the balance drops below 100 TWD.
- Three meters draw from it, and only three: **server** (`usage_vm`), **LLM** (`usage_llm`),
  **data** (`usage_blave`). Marketplace purchases are a fourth line item but not a meter.
- Itemised list: web usage page `/agent/<lang>/usage` (every deduction with its description).

## Meter 1 — server hourly (`usage_vm`) — includes Blave data

A flat hourly rate for the machine, charged once per hour by a platform cron
(`cron_deduct_server_credit.py`). Description on the usage page reads
`Server hourly (<tier>, data included): 1h`.

**Lead with the month, not the hour** — `month = hour x 720` (30 days). Answer "what does this
machine cost?" with the monthly figure and give the hourly rate beside it as the mechanism.
Billing itself is unchanged: still one deduction per clock hour.
**Use the hourly figure instead** when explaining a specific deduction row, the usage page, or a
stop/start question — the month is only for "what does this cost" questions.
**This rule is the server fee only.** Never multiply the 2 TWD data fee (Meter 2) by 720: it is
charged per *active* hour, so a monthly figure for it would be fiction.
Amounts here are TWD, which is what the wallet holds and what every deduction is in; the English,
Japanese, Vietnamese, Spanish and Portuguese site faces display USD at 30 TWD/USD
(48 / 144 / 276 per month on Linux, 132 / 204 / 396 on Windows).

| OS | Tier | vCPU / RAM | TWD per month (30 d) | TWD per hour |
|---|---|---|---|---|
| Linux | Starter (default) | 2 / 4 GB | 1,440 | 2.0 |
| Linux | Premium | 4 / 16 GB | 4,320 | 6.0 |
| Linux | Max | 8 / 32 GB | 8,280 | 11.5 |
| Windows | Starter (default) | 2 / 8 GB | 3,960 | 5.5 |
| Windows | Premium | 4 / 16 GB | 6,120 | 8.5 |
| Windows | Max | 8 / 32 GB | 11,880 | 16.5 |

- **The monthly figure is exact, not an estimate** — the meter runs whether the machine is
  running or stopped (see next bullet), so a machine that exists for a full 30 days costs exactly
  that. Say "per 30 days" rather than "about"; a 31-day calendar month is 24 hours more.
  **Exceptions that make a month short of full** — check before quoting a month to someone who
  just signed up: the 14-day card-bound free trial waives the server fee entirely (last bullet of
  this section, Linux Starter only, so a new user's first 30 days is 768 TWD not 1,440); a machine
  still `installing` is not yet metered; and a balance under 50 TWD stops the machine (a balance
  of 0 deletes it, with the strategies, data and keys on it).

- **Billed while the machine exists — running OR stopped.** The cron selects
  `status IN ('running', 'stopped')`. Stopping the machine does not stop the meter; only deleting
  it does.
- **Blave data is bundled.** An account that owns a machine (running or stopped) is never charged
  `usage_blave` (`deduct_blave_api_credit` short-circuits on `has_machine`). Every `lib/data.py`
  fetch, backtest, param scan, cron-scheduled strategy and scheduled report is
  covered by the hour already paid.
- Free trial (card-bound, 14 days, Linux Starter only): the server hour is not charged and no
  transaction row is written for it.

## Meter 2 — data fee (`usage_blave`) — machine owners never pay it

For an account with no cloud machine and no API plan, whichever key makes the call — the user's
own API key or the data key the desktop app received at sign-in. The desktop key has one more
free case: while the card trial runs, or while a machine is still being set up. Rule in
`deduct_blave_api_credit` (rate: `PRICING["blave_api_per_hour"]`):

- Exempt outright: API-plan subscribers; any account with a Blave Agent machine (running or stopped).
- Everyone else: **2 TWD per UTC clock hour in which at least one Blave data call was made** — a
  Redis key `blave:api_hourly:<uid>:<YYYY-MM-DD-HH>` is set on the first call and short-circuits
  the rest of that hour. It is **never per call**: 1 call and 1,000 calls in the same hour cost the
  same 2 TWD, and an hour with no calls costs nothing.
- Applies to every endpoint behind `@api_plan_required` / `token_or_api_plan_required` — i.e. the
  data endpoints `lib/data.py` talks to. Nothing else is metered as data.
- History: before the data fee was bundled into the server hour, machine owners did see a
  separate data line item once per active hour (3 TWD at the time). Users who remember "being
  charged every hour for the API" are describing that old regime; it no longer applies to them.

## Meter 3 — LLM (`usage_llm`) — every chat turn

Charged per proxy request (`openclaw/proxy.py`), i.e. every model call inside a turn — a turn that
uses several tools is several model calls, each billed on its own token counts (input, cache
write, cache read, output). Prices are TWD per 1M tokens (`LLM_PRICING`):

| Model | input | cache write | cache read | output |
|---|---|---|---|---|
| Haiku 4.5 | 40 | 50 | 4 | 200 |
| Sonnet 5.5 / Sonnet 5 (default Claude) | 80 | 100 | 8 | 400 |
| Opus 5.5 | 160 | 200 | 8 | 800 |
| Fable 5.1 | 400 | 500 | 10 | 2000 |
| Opus 4.8 (legacy) | 200 | 250 | 20 | 1000 |
| Fable 5 (legacy) | 400 | 500 | 40 | 2000 |
| deepseek-v4-flash | 5.5 | 5.5 | 0.11 | 22 |
| deepseek-v4-pro | 24.75 | 24.75 | 0.825 | 74.25 |

- Claude prices = list price USD × 1.25 × 32 TWD/USD; DeepSeek = list price RMB × 4.4 × 1.25.
- **DeepSeek peak surcharge: ×2 on weekdays (Mon–Fri) during Beijing 09:00–12:00 and 14:00–18:00**
  (the proxy doubles the token counts before deducting). Weekends and Chinese public holidays have no surcharge. No surcharge on
  Claude models.
- **Web search: 0.4 TWD per search, Claude models only** (Anthropic server-side tool). DeepSeek
  paths never bill it.
- Model match order (`_get_llm_pricing`): `deepseek-v4-pro` → any other `deepseek` (flash) →
  `haiku` → `opus-5-5` → any other `opus` (legacy price) → `fable-5-1` → any other `fable`
  (legacy price) → otherwise Sonnet. Legacy ids still work at their own (older) price. Switching is per session and applies from the
  next message (`references/models.md`).
- Free trial: LLM usage draws from a separate 100 TWD allowance instead of the balance; when the
  allowance is used up the proxy refuses further model calls until the trial ends.
- Long conversations cost more per turn (the whole context is input every call); cache reads are
  10× cheaper than fresh input, so the runtime's prompt caching is what keeps that in check.

## What does NOT call an LLM (Blave Agent runtime)

None of these add anything beyond the server hour already paid:

- A backtest, param scan or MCPT run — CPU on the machine. (The chat turn that launches it and
  reads its output is billed as LLM tokens like any other turn.)
- A deployed strategy on the system cron / Scheduled Task (`wait_for_bar.py`, `run_strategy.sh`).
- A scheduled report's data-only fallback (`report_jobs/<id>/run.py`). On a cloud machine, a job the user agreed to (`agent_consent`) also runs a scheduled **agent turn** that narrates it, billed as LLM tokens like a chat turn on whatever model they use at the time — about 12–18 TWD per run on Claude (web search included), about 1 on DeepSeek, capped at 1.0 USD (~40 TWD) per run (`lib.report.scheduled_cost()`). Not on the desktop in this version.
- Any `lib/data.py` fetch, cached or not — data is bundled.
- Telegram / web notifications sent by scripts.

On the **old OpenClaw runtime** only, an *agent cron* is a real chat turn and burns LLM tokens on
every wake-up — that is why `references/deployment.md` forbids per-tick agent crons.

## Answering the common questions

- 「在這邊聊天會消耗 token 嗎？」— Yes. Every message, on Telegram or the web workspace, is
  billed as LLM tokens at the current model's rate. Nothing else on the machine is. (Desktop
  app: only when the engine is Blave AI — see *Desktop app*.)
- 「電腦版要錢嗎？雲端主機一個月多少？」— The app is free; a cloud machine is the monthly figure
  in Meter 1 (Linux Starter 1,440 TWD per 30 days, data included) — billed hourly while it
  exists under hourly billing, or paid per period on a plan (annual also available; quote the
  plan page). Give the number — it is in this file.
- 「自己寫程式／用別的 agent，拿自己建的 key 打 Blave API 要什麼方案？」— Plan billing: an API plan,
  always — a Blave Agent plan covers only the cloud machine's key and the desktop app's key.
  Hourly billing (not yet switched): an API plan, owning a Blave Agent machine, or the hourly data
  fee (Meter 2).
- 「只用電腦版，要 Blave 資料怎麼辦？」— Hourly billing: free during the card trial, then per
  active clock hour (Meter 2). Plan billing: a cloud plan (any tier, data in the desktop app
  too) or an API plan; there is no desktop-only data plan.
- 「扣款失敗／餘額不夠會怎樣？」— Hourly billing: a balance under 50 TWD stops the machine and a
  balance of 0 deletes it. Plan billing: the machine stops and data pauses, it is retried daily,
  and it is deleted after the grace period the plan page shows.
- 「每小時都被收 API 使用費，把 cron 排在同一小時省錢？」— A machine owner is not charged the data
  fee at all; data is inside the server hour. Spacing or bunching crons changes nothing on the
  bill. (Even under the old per-hour data fee, bunching only mattered because the fee was
  per-active-hour, never per call.) Schedule crons on what the strategy needs, not on billing.
- 「聊天用 Flash、寫 code 才換 Pro 省錢嗎？」— Yes, that is a real saving: flash costs about a quarter
  of pro on input and under a third on output (5.5 vs 24.75 and 22 vs 74.25 TWD per million tokens), and the switch is per session with no restart. Mention the DeepSeek weekday peak-hour
  ×2 and that Claude models cost more but have no surcharge.
- 「停機會不會扣錢？」— Hourly billing: yes, a stopped machine is still billed the server hour; only
  deleting it stops the meter. Plan billing: stopping does not change the plan — it still
  renews; only cancelling ends it, at the end of the period, with no refund.
- 「回測／掃參數／定期報告會扣錢嗎？」— Nothing beyond the server hour (or the plan); the only
  extra is the LLM tokens of the chat turn you are in.
- 「Web search 會扣錢嗎？」— 0.4 TWD per search on Claude models; not billed on DeepSeek.
