<!-- TODO: logo light/dark — <picture> with prefers-color-scheme, width 64–80px. The repo has no light/dark logo files yet (only shell/build/icon.icns). -->

# Blave Agent

**The quant workspace for your AI agent**

See if it's an edge or a coin flip before it goes live.

Works inside Claude Code or Codex. No LLM places your orders. macOS, beta.

**English** | [繁體中文](README.zh-TW.md)

![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-lightgrey) ![Platform: macOS](https://img.shields.io/badge/platform-macOS-lightgrey)

<!-- TODO: 30s demo GIF (1600w, shown at 800w, dark, ≤8MB): one sentence → backtest with p-value → live -->

[Download the macOS app](https://github.com/Blave-TW/blave-agent/releases/latest) · [Quick start (from source)](#quick-start) · [Run it 24/7 in the cloud](https://blave.org/agent/en)

Star the repo if this is useful — and Watch › Releases to get notified of new versions.

## What Makes It Different

### Backtests That Check Whether It Was Luck

- Every Type A backtest runs a Monte Carlo permutation test by default (MCPT, `lib/validation.py`) and records a p-value: could shuffled data have done as well?
- A parameter scan (`lib/param_scan.py`) looks for a plateau of parameters that all work, not the single best cell.
- Rolling walk-forward (`lib/walk_forward.py`) measures out-of-sample performance.
- The fee has to match the real market. A fee of 0 is flagged by `lib/quality_check.py` and treated as a bug.
- One idea gets one backtest by default. A poor result is reported as it is; the agent does not quietly re-tune the parameters until the numbers look good (see *Iteration Brakes* in [`AGENTS.md`](AGENTS.md)).

### See Whether Live Runs the Code You Backtested

A backtest pins a version of the strategy. If the code running live no longer matches that version, the strategy is flagged — the web workspace shows "Live · file changed" instead of a clean "Live". The flag does not stop the strategy from running. It applies only to strategy types that are backtested (Type A and C), and only to strategies that have been versioned.

### No LLM in the Order Loop

The agent does the research and writes the code. Scheduled runs are deterministic code on a scheduler; `manager/reconciler.py` moves the account toward the target positions. A kill switch (`state/HALT`) blocks new exposure at the order-library level, while closes and stops still go through.

<a id="quick-start"></a>

## Quick Start (From Source)

You need:

- macOS 13 or later. The packaged app is a universal build: Apple Silicon and Intel, one download.
- Node.js 22.12 or later, with npm (`shell/package.json` › `engines`)
- `python3` on your `PATH`. The packaged app bundles its own Python 3.12; running from source uses your system `python3` to create the venv. <!-- TODO: minimum Python version from source (the pinned dependencies were verified on 3.12) -->
- Claude Code or Codex installed and signed in, or a Blave account

```
git clone https://github.com/Blave-TW/blave-agent.git
cd blave-agent/shell
npm install
npm start
```

On first launch you choose what powers the agent:

- **Your own Claude Code or Codex.** No Blave account needed, and Blave charges nothing for the AI. The app only launches the CLI; your Claude Code or Codex credentials stay with it.
- **Blave's AI.** Sign in with a Blave account; billed by usage.

Then describe an idea. For example:

- "Backtest BTCUSDT on the 4h chart: long when the 20-period SMA crosses above the 60-period SMA, flat when it crosses back below. Use a 0.05% fee per side."
- "Build a portfolio of BTC, ETH and SOL with equal weights, rebalanced weekly, and backtest it."
- "Scan both SMA lengths on that strategy and show me where the plateau is."

The agent sorts every idea into one of three types before writing code:

| Type | What it is | Backtest |
|---|---|---|
| A | One fixed symbol on a fixed interval; one position (long / short / flat) | Required |
| C | A portfolio: N symbols and a weight vector that sums to at most 1, rebalanced on a schedule | Required |
| B | Everything else: screeners, grids, arbitrage, alerts, one-off execution | None |

The interface follows the system language (English or Traditional Chinese). To override: `BLAVE_LANG=en npm start`.

## News

- **2026-09-24** — Desktop 0.1.1: first public release, universal build (Apple Silicon and Intel), on GitHub Releases. Taiwan stock daily bars and the Crypto Fear & Greed index now come from free public sources on the desktop.
- **2026-09-23** — Desktop 0.0.4, signed and notarized, on the test track.
- **2026-09-21** — The desktop app can connect a real Binance account and trade from your Mac.
- **2026-09-19** — Licensed under Apache-2.0.

## Venues and Data

**Venues with a tested order library** (`lib/account_*.py` + `lib/order_*.py`, verified on real accounts):

- Binance, BingX, OKX, Gate.io, Bybit — futures and spot
- Capital Futures (群益期貨) — Taiwan index futures and Taiwan stocks; Windows workspace only (its API is a Windows COM component, see `references/capital-broker.md`)

How a venue gets connected depends on where the agent runs:

- **Desktop app:** Binance, OKX, BingX, Gate.io and Bybit are connected in the app under Auto trading › Connect an exchange, which checks the key with the exchange first. A key pasted in chat is rejected — use Connect an exchange instead. Anything pasted stays in your chat history, so rotate a key you pasted by mistake. Portfolio (Type C) strategies cannot be auto-traded from the desktop app yet.
- **Cloud machine:** bind a venue on the web workspace's Auto trading page, or paste a Binance, BingX, OKX, Gate.io or Bybit key in chat and the agent binds it with `lib.venue.bind`.

For any other exchange or broker with an API, the agent can write a helper from `lib/account_TEMPLATE.py` and `lib/order_TEMPLATE.py`. That code has not been tested by Blave.

**Paper trading** needs no keys. It ships as `lib/account_paper.py` + `lib/order_paper.py` and fills at the latest close from the strategy's own data source (`lib/paper_data.py`).

**Data.**

- Desktop app, no account needed: crypto klines from Binance (USDT-M perpetuals, all intervals, back to listing) and BingX public endpoints; Taiwan stock daily bars straight from TWSE and TPEx with the exchanges' own ex-dividend adjustment (listed from 2010, OTC from the 1990s); the Crypto Fear & Greed index from alternative.me (since 2018). Blave's indicators, Taiwan intraday and flow data, futures and the macro calendar need a Blave account with data access.
- Cloud machine: market data comes from the Blave API through `lib/data.py` — crypto klines and indicators, Taiwan stocks, futures.

## Safety and Limits

- **Where exchange keys live depends on the surface.** Desktop app: in the workspace `.env` on your Mac (`~/Blave/workspace/.env`). Cloud machine: in the workspace `.env` on your own dedicated machine. A venue bound on the web page: stored encrypted by Blave. The agent can read the workspace `.env`; its rules forbid printing key values (`references/exchange-connect.md`). Use trade-only keys with withdrawal disabled.
- Funding amounts and resuming trading are done by you — in the desktop app's Auto trading page, or on the web workspace for a cloud machine. The agent refuses to do them for you, even when asked. The one thing it may always do by itself is trip the kill switch.
- On the desktop app, orders only go out while Blave is running; after you quit and reopen it, trading stays paused until you press Start trading.
- The agent verifies before it reports: it re-reads a file after editing it, and queries an order back from the exchange before saying it was placed. Every order attempt is logged to `state/audit.jsonl`.
- A backtest describes the past. It does not predict or guarantee future results. MCPT and parameter scans lower the odds that you are looking at luck; they do not remove them.
- Nothing here is investment advice. Trading can lose money, including all of it.

## Run It in the Cloud (Paid)

If a strategy should keep running around the clock, with your computer off, Blave Agent runs the same workspace on a dedicated cloud machine. You talk to the agent from the web workspace or Telegram; SSH is there if you want it. You can also connect your own Claude Code, Codex or another MCP-capable agent to that machine — setup is in the web workspace under Settings › Connect, guide at [blave.org/docs/en/connect](https://blave.org/docs/en/connect). Plans and prices: [blave.org/agent/en](https://blave.org/agent/en).

## Running From Source: What Goes Where

The first time you connect, the app prepares `~/Blave/`:

- `~/Blave/workspace/` — `lib/`, `manager/`, `references/`, `examples/`, `allocators/`, the strategy templates, `AGENTS.md`, `CLAUDE.md` and `VERSION`, copied from this checkout
- `~/Blave/venv/` — created with `python3 -m venv`, then `claude-agent-sdk`, cryptography, pandas, numpy, matplotlib, pyarrow, requests, python-dotenv and scipy are installed with pip
- `~/Blave/state/` — chat sessions, chat images and trading state

Your strategies end up in `~/Blave/workspace/strategies/<name>/`. When running from source, the official files are copied again on every launch, so edit `lib/` in the checkout, not in `~/Blave/workspace/`. Your strategies, `.env` and state are never overwritten.

## Layout

| Path | What is in it |
|---|---|
| `AGENTS.md` | The agent's rules: verify before reporting, iteration limits, data sources, deployment redlines. Start here. |
| `lib/` | Shared library: data, backtest runner, MCPT, parameter scan, walk-forward, reports, charts, watchboard, exchange account and order helpers (`account_*.py`, `order_*.py`), kill switch (`guard.py`) |
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

## Just Reading the Code

1. [`AGENTS.md`](AGENTS.md) — how the agent is expected to behave
2. [`examples/README.md`](examples/README.md) — eight complete strategies, each showing one pattern
3. [`references/lib.md`](references/lib.md) and [`references/strategy-code.md`](references/strategy-code.md) — library signatures and strategy code rules
4. [`strategies/TEMPLATE_A.py`](strategies/TEMPLATE_A.py) and [`strategies/TEMPLATE_C.py`](strategies/TEMPLATE_C.py)

Each file in `tests/` states how to run it in its header, for example `python tests/check_param_scan.py` or `node tests/check_shell_strings.js`.

## Contributing

Issues and pull requests are welcome. Before a PR:

- run the checks in `tests/` that cover what you changed;
- activate secret scanning once per clone: `pip install pre-commit && pre-commit install`;
- leave the backtest-chain files (`lib/runner.py`, `param_scan.py`, `walk_forward.py`, `validation.py`, `analysis.py`) alone unless the change is about them — the web workspace reads their output files by contract.

## License

**Apache-2.0** — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE). You may use, modify and redistribute it, commercially too; a patent grant is included. "Blave" and the Blave logo are trademarks: rename your fork.

**The strategies you write are yours.** Anything you (or the agent on your behalf) write under `strategies/` is not part of this project and the license does not reach it.

The paid parts are not in this repo: cloud machines, market data and Blave's LLM proxy are services of blave.org. This code runs on your own computer at no charge, with your own AI subscription and your own data sources.

Claude Code and Codex are products of their respective owners. Blave Agent is not affiliated with or endorsed by them.

## Links

- Website: [blave.org](https://blave.org) · Blave Agent: [blave.org/agent/en](https://blave.org/agent/en)
- Docs: [blave.org/docs/en](https://blave.org/docs/en) — [quick start](https://blave.org/docs/en/quickstart), [MCPT](https://blave.org/docs/en/mcpt), [walk-forward](https://blave.org/docs/en/walk_forward), [avoiding overfitting](https://blave.org/docs/en/avoid_overfitting)
- Strategy Library: [blave.org/agent/en/library](https://blave.org/agent/en/library)

---

## For maintainers and existing machines

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
