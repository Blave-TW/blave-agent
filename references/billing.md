# Billing — what costs what

The single answer sheet for 「這樣會不會扣錢」/「扣什麼錢」questions. Everything below was read
from the platform code, not remembered — sources are named per section. If a question is not
covered here, say you are not sure and point the user to the usage page; never invent a number.

Gist: chat on Blave's models costs tokens; Blave data and a cloud server come with a Blave Agent
plan; letting code run costs nothing extra. Prices changed over time, so check which pricing the
account is on (*Which pricing applies*, below). Itemised: `/agent/<lang>/usage`.

Sources (api repo): `account/credit.py` (`PRICING`, `LLM_PRICING`, `WEB_SEARCH_PRICING_TWD`,
`deduct_credit`, `deduct_blave_api_credit`, `deduct_server_credit`), `openclaw/lightsail.py`
(`SERVER_TIERS`, `WINDOWS_SERVER_TIERS`), `openclaw/proxy.py` (`_deepseek_peak_multiplier`,
`deduct_llm_credit` call sites), `snapshot/cron_deduct_server_credit.py`, `account/agent_trial.py`,
`decorators.py` (`api_plan_required`); plan billing: `account/agent_plan_config.py`
(`TIERS`, `V3_ADDON_MONTHLY_TWD`, `V3_FROM`), `account/agent_plan.py`, `account/agent_ai_credit.py`.

## Which pricing applies — find out first

Three generations of pricing exist. Each account is on exactly one at a time:

1. **Agent plan pricing** — from the switch date, 2026-11-20 12:00 Taipei time
   (04:00 UTC). The plan is 888 TWD per 30 days and does not include a server; a cloud server is an
   add-on. *Agent plan*, below.
2. **Earlier plan pricing** — from 2026-10-12 until that switch date. A plan was a server tier
   (Linux Starter 1,440 TWD per 30 days, data included). A period that started before the switch
   is still charged at the price it started with; the next period uses Agent plan pricing.
   *Earlier plan pricing*, below.
3. **Hourly billing** — before 2026-10-12, and accounts that still have an old machine without a
   plan. *Hourly billing*, below.

- **How to tell:** Settings › 帳號與方案 (en: Account & plan) in the desktop app, or the plan
  page on the web (`/agent/<lang>/usage#plan`). An AI credit line ("this period" with a figure
  out of 300) = Agent plan pricing. A plan named after a server tier with no AI credit line =
  earlier plan pricing. A per-hour price, or usage-page rows like `Server hourly (<tier>, …): 1h`
  = hourly billing.
- **Cannot tell** (no access to those pages from where you are): before the switch date, treat earlier
  plan pricing as the default and say the price is changing to the Agent plan; from the switch
  date on, Agent plan pricing is the default for new plans and for every period that starts after
  it. Either way, point to Settings › 帳號與方案 for what this account pays, and never quote 1,440
  as "the plan price" without saying it includes a Linux server.

## Agent plan (from the switch date)

- **The plan: 888 TWD per 30 days** (annual: 8,880 TWD per 365 days, ten months' price). It
  includes Blave data on the desktop app and on a cloud server, **300 TWD of AI credit each
  period**, and Data Studio Pro. **It does not include a cloud server.**
- **AI credit resets each period.** Unused credit does not carry over; it follows the plan's
  30-day period, not the calendar month. Annual plans get 300 every 30 days (the last slot of
  the year is 50). Blave AI turns use the period's credit first, then the 30 TWD sign-in credit,
  then the wallet. All models can use the credit.
- **A cloud server is an add-on** on top of the plan, each tier priced on its own (per 30 days;
  annual add-ons are twelve months' price, no discount). Quote the add-on, not a total, unless
  the user asks what the first payment will be:

| Server | vCPU / RAM | Add-on per 30 days | Plan + server per 30 days |
|---|---|---|---|
| Linux Basic (default) | 2 / 4 GB | +552 | 1,440 |
| Linux Advanced | 4 / 16 GB | +3,400 | 4,288 |
| Linux Top | 8 / 32 GB | +7,400 | 8,288 |
| Windows Basic | 2 / 8 GB | +3,100 | 3,988 |
| Windows Advanced | 4 / 16 GB | +5,200 | 6,088 |
| Windows Top | 8 / 32 GB | +11,000 | 11,888 |

  Basic / Advanced / Top are the user-facing names; code and older pages say Starter / Premium /
  Max. Windows is only needed for brokers whose API runs on Windows (Capital).
- **What a renewal charges:** on the renewal day, if the account has a server (running *or*
  stopped), the plan plus that server's add-on; with no server, 888. **A stopped server still
  pays its add-on** — only terminating it stops that.
- **Opening a server mid-period** charges the difference for the days left; restarting a tier
  already paid for this period is free. Terminating a server does not cancel the plan and is not
  refunded (an annual plan loses the rest of the year's add-on; the website's terminate box shows
  the amount). Terminating is done on the website.
- **From the desktop app:** the plan box (data wall, Settings, the sidebar) and the server box
  (cloud view) pay without leaving the app — a card already on file is charged in the box, a new
  card goes through the payment page in the browser. Paid server starts from the desktop are
  limited to 5 per day (Taipei time); upgrading a running server is done on the website.
- **Card trial: 14 days, 150 TWD of AI credit, no server.** Adding a card starts it (a 10 TWD
  card check goes into the wallet) and means agreeing to the first period, 888 TWD, when the
  trial ends; cancelling before then charges nothing. Opening a server during the trial ends the
  trial at once and starts the first period (plan + add-on), with 300 TWD of credit for it.
  A trial that started before the switch keeps its old terms during the trial (100 TWD credit,
  Linux Starter included); if it ends after the switch, the first period is charged at Agent plan
  pricing: 888 TWD with no server, 1,440 TWD (888 + 552) with its Linux Starter server.
- **Paid up front, wallet first.** Each payment comes from the wallet if the balance covers the
  whole amount; otherwise the card is charged for the whole amount. No card and not enough
  balance = the payment fails: the server stops and Blave data pauses, it is retried daily, and
  after the grace period the plan page shows, the server is deleted with the strategies, data and
  keys on it.
- **Cancel = runs to the end of the period, no refund.**
- **Only keys Blave Agent issues are covered** — the cloud server's key and the desktop app's
  sign-in key. A key the user created themselves (API page; their own scripts, an external agent)
  needs an **API plan** (`403 ERR007` points to it). The Agent plan does not include an API plan.
- **Already paying for Pro?** The Agent plan includes Pro; a separate Pro subscription keeps
  renewing until the user cancels it where they bought it (website, App Store, Google Play).

## Earlier plan pricing (2026-10-12 until the switch)

- **A plan was a server tier** — Linux or Windows, Starter / Premium / Max, at the monthly
  figures in the table under *Meter 1* (same figure per tier, no hourly price). Every plan
  included Blave data, on the desktop app too. The desktop app started a plan without a machine
  at the Linux Starter price; the machine was started on the website.
- **Card trial (Linux Starter):** no plan charge during the trial; the first period of the chosen
  cycle is charged when it ends. LLM use during the trial draws from a 100 TWD allowance.
- **Annual:** a one-year period priced below twelve months; quote the plan page.
- **Upgrade (same OS, bigger tier)** applies at once for the difference over the days left;
  monthly ↔ annual switches from the next period.
- Payment order, failure, cancel and API-plan rules are the same as under *Agent plan*.
- **There was no AI credit per period** — Blave AI turns were paid from the wallet.

## Desktop app — read this first when the question comes from the desktop

`BLAVE_AGENT_LOCAL=1`. Much of this file was written from the cloud machine's side; on the
desktop the same meters exist, but which ones apply depends on two things the user chose.

- **The app itself is free.** No licence, no subscription, no fee for backtests, scans, paper or
  live trading on this computer.
- **LLM — depends on the engine.** On the user's own Claude Code / Codex, Blave charges nothing
  for AI: that usage is on the user's own plan with that provider. With the engine set to
  **Blave AI**, every turn is billed as Meter 3 describes — from the period's AI credit first on
  an Agent plan, otherwise from the 30 TWD sign-in credit and then the wallet. Never say LLM is
  billed "only on a cloud machine".
- **Data — depends on the account, not on the app.** Exchange klines and Taiwan daily bars from
  TWSE / TPEx need no Blave key and cost nothing. Blave data through the key the app received at
  sign-in comes with the card trial, a Blave Agent plan (no server needed under Agent plan
  pricing) or an API plan. Under plan pricing there is no hourly data purchase; under hourly
  billing it is Meter 2. Never say the data fee is only for people calling the API with their
  own key.
- **Server — only if the user opens a cloud server.** Under Agent plan pricing quote the add-on
  from the table above; otherwise the Meter 1 figure.
- **Where the user sees their own numbers:** Settings › 帳號與方案 (en: Account & plan)
  shows the plan, the AI credit left this period and any overage, and the wallet; the web usage
  page lists every deduction. Point there for anything this file does not state, instead of
  answering that there is no number.

## The wallet and auto top-up

- One prepaid credit balance in TWD. Top-up sizes: 300 / 800 / 1500 / 3000 TWD.
- **Auto top-up** (card required): since 2026-10-12, when the balance drops below 50 TWD the card
  is charged 300 TWD into the wallet (below 100 TWD under hourly billing). Under Agent plan pricing
  it only pays for AI use beyond the period's credit and is separate from the plan: switching it
  off does not stop plan renewals. It is on once a card is added. The app tells the user after a
  top-up happened; if they ask how to change it, point to the usage page.
- What draws from it: AI beyond the credit (`usage_llm`), plan periods when the balance covers a
  whole period, marketplace purchases, and under hourly billing the server (`usage_vm`) and data
  (`usage_blave`).
- Itemised list: web usage page `/agent/<lang>/usage` (every deduction with its description).

## Hourly billing (before 2026-10-12, and old machines without a plan)

Everything from here to *Meter 3* describes hourly billing. On a plan account, *Meter 1*'s table
still gives the monthly price per tier under earlier plan pricing, and the rest of those two
sections does not apply.

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
- Free trial: LLM usage draws from the trial's own allowance instead of the balance (150 TWD for a
  trial started under Agent plan pricing, 100 TWD before). When it runs out, usage comes from any
  30 TWD sign-in credit left and then the wallet; Blave AI stops only when all of them are empty.
- Agent plan: each period's 300 TWD of AI credit is used first; beyond it, the 30 TWD sign-in
  credit, then the wallet. Blave AI stops only when all three are empty.
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
  billed as LLM tokens at the current model's rate — from the period's AI credit first on an
  Agent plan. Nothing else on the machine is. (Desktop app: only when the engine is Blave AI —
  see *Desktop app*.)
- 「電腦版要錢嗎？雲端主機一個月多少？」— The app is free. Agent plan pricing: the plan is 888 TWD
  per 30 days (data, 300 TWD of AI credit each period, Pro), and a cloud server is an add-on from
  +552 TWD (Linux Basic) — give the figure from the table. Earlier plan pricing: the Meter 1
  figure (Linux Starter 1,440 TWD per 30 days, data included). Hourly billing: the same monthly
  figure, billed hourly while the machine exists.
- 「自己寫程式／用別的 agent，拿自己建的 key 打 Blave API 要什麼方案？」— Plan pricing: an API plan,
  always — a Blave Agent plan covers only the cloud machine's key and the desktop app's key.
  Hourly billing: an API plan, owning a Blave Agent machine, or the hourly data fee (Meter 2).
- 「只用電腦版，要 Blave 資料怎麼辦？」— Agent plan pricing: the Blave Agent plan (888, no server
  needed) or an API plan; the card trial includes it too. Earlier plan pricing: a plan (any tier)
  or an API plan. Hourly billing: free during the card trial, then per active clock hour
  (Meter 2).
- 「AI 額度用完會怎樣？」— Agent plan: the turn keeps running, paid from the 30 TWD sign-in credit
  and then the wallet; auto top-up refills the wallet if a card is on file. The credit comes back
  at the start of the next 30-day slot.
- 「扣款失敗／餘額不夠會怎樣？」— Plan pricing: the server stops and data pauses, it is retried
  daily, and it is deleted after the grace period the plan page shows. Hourly billing: a balance
  under 50 TWD stops the machine and a balance of 0 deletes it.
- 「每小時都被收 API 使用費，把 cron 排在同一小時省錢？」— A machine owner is not charged the data
  fee at all; data is inside the server hour or the plan. Spacing or bunching crons changes
  nothing on the bill. (Even under the old per-hour data fee, bunching only mattered because the
  fee was per-active-hour, never per call.) Schedule crons on what the strategy needs, not on
  billing.
- 「聊天用 Flash、寫 code 才換 Pro 省錢嗎？」— Yes, that is a real saving: flash costs about a quarter
  of pro on input and under a third on output (5.5 vs 24.75 and 22 vs 74.25 TWD per million
  tokens), and the switch is per session with no restart. Mention the DeepSeek weekday peak-hour
  ×2 and that Claude models cost more but have no surcharge.
- 「停機會不會扣錢？」— Agent plan pricing: the plan renews as usual and a stopped server still pays
  its add-on; terminating the server (on the website) is what stops the add-on, from the next
  period. Earlier plan pricing: stopping does not change the plan — it still renews; only
  cancelling ends it, at the end of the period, with no refund. Hourly billing: yes, a stopped
  machine is still billed the server hour; only deleting it stops the meter.
- 「回測／掃參數／定期報告會扣錢嗎？」— Nothing beyond the plan (or the server hour); the only
  extra is the LLM tokens of the chat turn you are in.
- 「Web search 會扣錢嗎？」— 0.4 TWD per search on Claude models; not billed on DeepSeek.
