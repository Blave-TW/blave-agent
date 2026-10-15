# Blave Agent

## Quant Workspace for AI Agents

Build, backtest and trade strategies live with Claude Code or Codex. Free and open source.

**English** | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [Español](README.es.md) | [Português](README.pt.md) | [Tiếng Việt](README.vi.md)

![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-lightgrey) ![Platform: macOS | Windows](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey)

https://github.com/user-attachments/assets/7b33edb7-9c65-4e19-854a-40295c6e8b74

[Download for macOS](https://github.com/Blave-TW/blave-agent/releases/latest) · [Download for Windows](https://download.blave.org/desktop/win/Blave-Setup.exe) · [Quick start (from source)](#quick-start) · [Run it with your computer off](https://blave.org/agent/en)

Star the repo if this is useful — and Watch › Releases to get notified of new versions.

## What Makes It Different

### Backtests That Check for Overfitting and Use Real Fees

Overfitting: parameters that just happen to fit past data.

![A BTC breakout backtest: it trailed buy-and-hold and its MCPT p-value of 0.088 missed the 0.05 cutoff, and the agent says so](docs/readme-backtest.png)

- **MCPT p-value** on every Type A backtest (`lib/validation.py`): could shuffled data have done as well?
- **Parameter scan** for a plateau, not the single best cell (`lib/param_scan.py`); **walk-forward** for out-of-sample results (`lib/walk_forward.py`).
- **Real fees:** a fee of 0 gets a warning (`lib/quality_check.py`).
- **One idea, one backtest:** a poor result is reported as it is, not quietly re-tuned (*Iteration Brakes* in [`AGENTS.md`](AGENTS.md)).

### See Whether Live Runs the Code You Backtested

A backtest pins a version of the strategy. If the live code no longer matches it, the web workspace shows "Live · file changed" instead of "Live". The strategy keeps running; the flag is there so you notice (Type A and C, versioned strategies only).

### Reports That Read the News First

Morning briefs, market-close reports, single-symbol briefs and research write-ups. The agent reads at least three news sites first, every chart comes from the actual data, and each report ends with one condition that would prove it wrong.

### A Browser You Can Watch

![The agent searching a dozen sites for BTC and ETH strategy ideas in the built-in browser](docs/readme-browser.png)

The agent reads the web in the app's built-in browser, on your screen. Exchange account pages and private-network addresses are blocked, and an unfamiliar URL with long parameters waits for your OK.

<a id="quick-start"></a>

## Quick Start (From Source)

You need macOS 13+ or Windows 10/11 (x64), Node.js 22.12+, Python 3 on your `PATH`, and one of: Claude Code or Codex signed in, a DeepSeek API key, or a Blave account.

```
git clone https://github.com/Blave-TW/blave-agent.git
cd blave-agent/shell
npm install
npm start
```

On Windows, run `npm.cmd install` and `npm.cmd start` in PowerShell.

On first launch you choose what powers the agent:

- **Your own Claude Code or Codex.** No Blave account needed; Blave charges nothing for the AI.
- **Your own DeepSeek key.** DeepSeek bills you directly. The key stays in this computer's keychain and never reaches the agent.
- **Blave AI.** Sign in with a Blave account; billed by usage.

Then describe an idea:

- "Backtest BTCUSDT on the 4h chart: long when the 20-period SMA crosses above the 60-period SMA, flat when it crosses back below. Use a 0.05% fee per side."
- "Scan both SMA lengths on that strategy and show me where the plateau is."

The agent sorts every idea into one of three types before writing code:

| Type | What it is | Backtest |
|---|---|---|
| A | One fixed symbol on a fixed interval; one position (long / short / flat) | Required |
| C | A portfolio: N symbols and a weight vector that sums to at most 1, rebalanced on a schedule | Required |
| B | Everything else: screeners, grids, arbitrage, alerts, one-off execution | None |

<details>
<summary>Platform notes</summary>

- The packaged macOS app is a universal build (Apple Silicon and Intel). Windows: the versions Electron 44 supports; ARM not tested. The Windows installer is not code-signed yet, so SmartScreen warns on first install: choose More info › Run anyway.
- Node.js version: `shell/package.json` › `engines`. The packaged app bundles its own Python 3.12; running from source uses your system Python (`python3`, or `python` on Windows) to create the venv.
- Codex comes inside the ChatGPT app — Microsoft Store “ChatGPT” on Windows (`winget install --id 9PLM9XGG6VKS -s msstore`), ChatGPT.app on Mac. On Windows, avoid the npm `@openai/codex` 0.161–0.162.1 builds for now (their sandbox is broken).
- With your own Claude Code or Codex, the app only launches the CLI; your credentials stay with it. A DeepSeek key is stored encrypted on Windows, and the app relays the agent's requests locally.
- `npm.cmd` runs even when PowerShell's execution policy blocks the `npm` script.
- The interface follows the system language (English or Traditional Chinese). To override: `BLAVE_LANG=en npm start` (PowerShell: `$env:BLAVE_LANG="en"; npm.cmd start`).

</details>

## News

What changed in each version: [Releases](https://github.com/Blave-TW/blave-agent/releases).

## Venues and Data

**Venues with a tested order library** (`lib/account_*.py` + `lib/order_*.py`, verified on real accounts):

- Binance, BingX, OKX, Gate.io, Bybit — futures and spot
- Capital Futures (群益期貨) — Taiwan index futures (TXF, MXF and TMF); Windows cloud machine only (its API is a Windows COM component, see `references/capital-broker.md`) — the desktop app cannot connect it on any OS, a Windows PC included. You upload your certificate in the app and the agent completes the setup on the cloud machine — no remote desktop needed.
- President Futures (統一期貨) — TXF, MXF and TMF; Windows only, because its certificate tool runs only on Windows 10 or later (see `references/president-broker.md`). On the Windows desktop app you upload the certificate and sign in inside the app. On a Windows cloud machine you apply for or export the certificate on your own Windows PC, upload it on the web workspace's Auto trading page and confirm the sign-in there — no remote desktop.

How a venue gets connected depends on where the agent runs:

- **Desktop app:** Binance, OKX, BingX, Gate.io and Bybit are connected in the app under Auto trading › Connect an exchange, which checks the key with the exchange first. A key pasted in chat is rejected — use Connect an exchange instead. Anything pasted stays in your chat history, so rotate a key you pasted by mistake. Type C strategies (one strategy holding several symbols by a weight vector — not the Portfolio page, which sets an amount for each of your strategies) can be auto-traded from the desktop app; if the workspace's lib is too old to trade them, they show as locked in Pick strategies until it is updated. A Type C strategy sized in contracts or shares places no orders, and Type C cannot be routed to President Futures or Capital Futures — saving an amount for it there is rejected.
- **Cloud machine:** bind a venue on the web workspace's Auto trading page, or paste a Binance, BingX, OKX, Gate.io or Bybit key in chat and the agent binds it with `lib.venue.bind`.

For any other exchange or broker with an API, the agent can write a helper from `lib/account_TEMPLATE.py` and `lib/order_TEMPLATE.py`. That code has not been tested by Blave.

**Paper trading** needs no keys. It ships as `lib/account_paper.py` + `lib/order_paper.py` and fills at the latest close from the strategy's own data source (`lib/paper_data.py`).

**Data.**

- Desktop app, no account needed: crypto klines from Binance (USDT-M perpetuals, all intervals, back to listing) and BingX public endpoints; Taiwan stock daily bars straight from TWSE and TPEx with the exchanges' own ex-dividend adjustment (listed from 2010, OTC from the 1990s); Taiwan index futures daily bars from TAIFEX public data (since 1998); market-wide institutional net buying from TWSE (foreign investors since 2004); US stock and ETF daily bars from Yahoo Finance (backtest only, no auto trading); the Crypto Fear & Greed index from alternative.me (since 2018). Blave's indicators, Taiwan intraday and per-stock flow data, futures intraday bars and the rest of the futures data, and the macro calendar need a Blave account with data access.
- Cloud machine: market data comes from the Blave API through `lib/data.py` — crypto klines and indicators, Taiwan stocks, futures.

## Safety and Limits

- **Keys:** give read and trade permission only. A key with withdrawal permission is refused when you connect it (Binance, OKX, BingX, Bybit); Gate.io does not report that flag, so check it yourself. Keys live in the workspace `.env` on your computer (`~/Blave/workspace/.env`, `%USERPROFILE%\Blave\workspace\.env` on Windows) or on your own cloud machine, or encrypted by Blave when bound on the web page. The agent can read that `.env`; its rules forbid printing key values (`references/exchange-connect.md`).
- **You fund and resume trading,** in the desktop app's Auto trading page or the web workspace. The agent refuses to, even when asked; the one thing it may always do by itself is trip the kill switch.
- **Desktop orders only go out while Blave is running.** After you quit and reopen it, trading stays paused until you press Start trading.
- **Verified before reported:** an order is queried back from the exchange before the agent says it was placed, and every attempt is logged to `state/audit.jsonl`.
- A backtest describes the past. MCPT and parameter scans lower the odds that you are looking at luck; they do not remove them. Nothing here is investment advice, and trading can lose all of your money.

## Run It in the Cloud (Paid)

To keep a strategy running with your computer off, Blave Agent runs the same workspace on a dedicated cloud machine: talk to it from the web workspace or Telegram (SSH too), schedule reports, or connect your own Claude Code, Codex or other MCP agent ([guide](https://blave.org/docs/en/connect)). Plans and prices: [blave.org/agent/en](https://blave.org/agent/en).

## Just Reading the Code

1. [`AGENTS.md`](AGENTS.md) — how the agent is expected to behave
2. [`examples/README.md`](examples/README.md) — eight complete strategies, each showing one pattern
3. [`references/lib.md`](references/lib.md) and [`references/strategy-code.md`](references/strategy-code.md) — library signatures and strategy code rules
4. [`strategies/TEMPLATE_A.py`](strategies/TEMPLATE_A.py) and [`strategies/TEMPLATE_C.py`](strategies/TEMPLATE_C.py)

<details>
<summary>Repository layout, what goes where when running from source, tests</summary>

| Path | What is in it |
|---|---|
| `AGENTS.md` | The agent's rules: verify before reporting, iteration limits, data sources, deployment redlines. Start here. |
| `lib/` | Shared library: data, backtest runner, MCPT, parameter scan, walk-forward, reports, charts, exchange account and order helpers (`account_*.py`, `order_*.py`), kill switch (`guard.py`) |
| `strategies/` | Strategy templates. Your own strategies live here too and are git-ignored. |
| `examples/` | Complete reference strategies (crypto, crude oil, Taiwan stocks, Taiwan index futures) and export templates — see [`examples/README.md`](examples/README.md) |
| `references/` | What the agent reads before acting: library signatures, strategy code rules, deployment, broker guides, report contract |
| `manager/` | Portfolio manager, reconciler, health check, stop / flatten tools |
| `allocators/` | Template for a custom portfolio weighting method |
| `runtime/` | The agent loop, web and Telegram bridges, reporters and job runner that ship to every cloud machine, plus the desktop app's local order daemon |
| `shell/` | The desktop app (Electron) |
| `tests/` | Small checks, one file per contract |

Versions: the workspace is [`VERSION`](VERSION) (date-based); the runtime is `runtime/VERSION`, history in [`runtime/CHANGELOG.md`](runtime/CHANGELOG.md); the desktop app is `shell/package.json`.

About the `openclaw` name: it is the name of an earlier framework. Config files (`openclaw.json`), API paths (`/openclaw/...`) and SSH host names still carry it because those locations really are called that. The runtime in `runtime/` has been first-party since 2026-07-25 and is unrelated to that product.

### Running from source: what goes where

The first time you connect, the app prepares `~/Blave/` (`%USERPROFILE%\Blave\` on Windows):

- `~/Blave/workspace/` — `lib/`, `manager/`, `references/`, `examples/`, `allocators/`, the strategy templates, `AGENTS.md`, `CLAUDE.md` and `VERSION`, copied from this checkout
- `~/Blave/venv/` — created with `python3 -m venv` (`python -m venv` on Windows), then `claude-agent-sdk`, cryptography, pandas, numpy, matplotlib, pyarrow, requests, python-dotenv and scipy are installed with pip
- `~/Blave/state/` — chat sessions, chat images and trading state

Your strategies end up in `~/Blave/workspace/strategies/<name>/`. When running from source, the official files are copied again on every launch, so edit `lib/` in the checkout, not in `~/Blave/workspace/`. Your strategies, `.env` and state are never overwritten.

### Tests

Each file in `tests/` states how to run it in its header, for example `python tests/check_param_scan.py` or `node tests/check_shell_strings.js`.

</details>

## Contributing

Issues and pull requests are welcome. Before a PR:

- run the checks in `tests/` that cover what you changed;
- activate secret scanning once per clone: `pip install pre-commit && pre-commit install`;
- leave the backtest-chain files (`lib/runner.py`, `param_scan.py`, `walk_forward.py`, `validation.py`, `analysis.py`) alone unless the change is about them — the web workspace reads their output files by contract.

## Code Signing Policy

The Windows build is not code-signed yet: we have applied to the [SignPath Foundation](https://signpath.org) open-source program, and until it is approved the Windows installer is unsigned. Once approved: free code signing on Windows provided by [SignPath.io](https://signpath.io), certificate by SignPath Foundation. Releases are built by the public GitHub Actions workflow in this repository from a tagged commit; each signing request is approved by the repository owner. Roles: Authors and Reviewers — the maintainers with write access; Approver — the repository owner. This program will not transfer any information to third parties except as described in the [privacy policy](https://blave.org/disclaimer/en/privacy_policy). The macOS build is signed and notarized with Blave's own Apple identity.

## License

**Apache-2.0** — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE). You may use, modify and redistribute it, commercially too; a patent grant is included. "Blave" and the Blave logo are trademarks: rename your fork.

**The strategies you write are yours.** Anything under `strategies/` is not part of this project and the license does not reach it. The paid parts — cloud machines, market data and Blave's LLM proxy — are blave.org services and not in this repo.

Claude Code and Codex are products of their respective owners. Blave Agent is not affiliated with or endorsed by them.

## Links

- Website: [blave.org](https://blave.org) · Blave Agent: [blave.org/agent/en](https://blave.org/agent/en)
- Docs: [blave.org/docs/en](https://blave.org/docs/en) — [quick start](https://blave.org/docs/en/quickstart), [MCPT](https://blave.org/docs/en/mcpt), [walk-forward](https://blave.org/docs/en/walk_forward), [avoiding overfitting](https://blave.org/docs/en/avoid_overfitting)
- Strategy Library: [blave.org/agent/en/library](https://blave.org/agent/en/library)

---

---

## For maintainers and existing machines

<details>
<summary>Releasing the runtime and updating an existing workspace</summary>

### Releasing the runtime

```
cd blave-agent
export BLAVE_S3_KEY=... BLAVE_S3_SECRET=... BLAVE_S3_REGION=... BLAVE_S3_BUCKET=...
python publish.py            # dry-run, no credentials needed
python publish.py publish    # real upload; the fleet picks it up within ~6 minutes
```

Before publishing, bump `runtime/VERSION` and move the Unreleased lines in `runtime/CHANGELOG.md` under the new version. Packaging takes the unit files declared in `jobs.json` from `../api/blave_agent/systemd/`, so **the api checkout must sit next to this repo**; if it is missing, the run fails on the spot with the full path.

The history of `runtime/` was merged in from the api repo as a subtree on 2026-09-18 (165 commits). Because it was a merge and not a rename, `git log -- runtime/` shows only that merge; for the full history use `git log HEAD^2` (files are at root paths on that line, e.g. `agent_turn.py`).

Fresh installs are handled automatically by the provisioning script — no manual steps needed.

**Bump `VERSION` (date, `YYYY-MM-DD`, add `-b`/`-c` for same-day repushes) in the same commit as any change machines should pick up** — the platform compares each machine's reported VERSION against this repo's to light the web "update available" indicator; an unbumped push is invisible to users.

### Updating an existing workspace

This section is an operating contract: `references/updating.md` sends agents here, and the desktop app copies the same file list. Keep the heading and the list intact.

Tell your agent:

> Clone https://github.com/Blave-TW/blave-agent to /tmp/oc-config and use it as **reference** to update this machine's live workspace — `$BLAVE_AGENT_HOME/workspace`, i.e. the workspace you are running in (`/root/.openclaw/workspace` on old BlaveClaw machines, `/opt/blave-agent/workspace` on Blave Agent machines; resolution per `references/deployment.md`). For each file below, compare the repo version with the local version. Nothing is merged: an official file (its exact path is in the clone) that differs is replaced wholesale by the clone's version, after a backup of the local copy into `.official-backup/<old VERSION>-<UTC time>/` (relative path kept; older backups never overwritten). If the local copy matches no past official version of that file (`git hash-object` vs `git log --raw` on a `--filter=blob:none` clone), it was changed on this machine: ask the user before replacing it; if they keep it, leave it and do not copy `VERSION`. Replace atomically (`cp` to a temp name, then `mv`). A file whose path is not in the clone is never touched.
>
> - `AGENTS.md`, `CLAUDE.md` — replace wholesale (these are config, not user-edited)
> - `references/` — replace each differing file wholesale (with the `.official-backup/` copy); copy in any that are missing
> - `strategies/TEMPLATE_A.py`, `strategies/TEMPLATE_C.py` — replace wholesale
> - `lib/` — add any canonical files that are missing locally (`venue_errors.py` always); every canonical file that differs — the backtest-chain files (`runner.py`, `param_scan.py`, `walk_forward.py`, `validation.py`, `analysis.py`), `data.py`, the official broker libs and the rest — is replaced wholesale (with the `.official-backup/` copy), never merged. For `lib/order_*.py` / `lib/account_*.py`, the name alone doesn't tell you if it's user-created: if that exact filename exists in the reference clone (e.g. `order_bingx.py`, `order_sinopac.py`, `account_bingx.py`, `account_TEMPLATE.py`), it is official and replaced like the rest; **never touch** one that does not exist in the reference clone — that's the user's own exchange integration
> - `manager/` — replace wholesale (user edits live in `portfolio_config.json`, not in the scripts)
> - `examples/` — replace wholesale
> - `allocators/` — replace wholesale (only files that exist in the clone; the user's own allocators are never touched)
> - `VERSION` — copy verbatim, always last and only if every step above succeeded (it declares the workspace up to date; drives the web "update available" indicator)
>
> When done, remove /tmp/oc-config.

</details>
