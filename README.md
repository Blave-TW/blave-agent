# Blave Agent

English | [繁體中文](README.zh-TW.md)

**A quant agent workspace.** This is the directory an AI agent works in — Claude Code, Codex, or Blave's own AI — with the libraries, rules and templates it needs to turn a trading idea into a backtested strategy that can go live.

You describe the idea in plain language. Working inside this workspace, the agent fetches the data, writes the strategy, runs the backtest, checks whether the result can be told apart from luck and whether it survives nearby parameters, writes a report, and — after you connect an exchange yourself — runs it on a schedule.

It is for people who have a trading idea and would rather spend their time on the idea than on API plumbing, data cleaning and bot debugging. You do not have to write code. If you do, everything here is plain Python you can read and change.

This one repository is two things:

- the workspace and runtime on every Blave Agent cloud machine ([blave.org](https://blave.org)), and
- the Blave desktop app for macOS (`shell/`), which runs the same workspace on your own computer.

## What the agent does in here

1. **Idea.** The agent classifies the strategy before writing any code (types below).
2. **Data.** Everything goes through `lib/data.py`: crypto klines and indicators, Taiwan stocks and futures, the economic calendar. No hand-rolled fetch scripts.
3. **Strategy.** Written from `strategies/TEMPLATE_A.py` or `strategies/TEMPLATE_C.py`, with a fee that matches the real market. A fee of 0 is treated as a bug.
4. **Backtest.** `lib/runner.py` runs it and writes `stats.json` and a PnL chart under `strategies/<name>/`. One backtest per request by default: a poor result is reported as it is, and the agent does not keep re-tuning on its own.
5. **Checks.**
   - Monte Carlo permutation test (MCPT, `lib/validation.py`) runs with every Type A backtest and records a p-value: could shuffled data have done as well?
   - Parameter scan (`lib/param_scan.py`) looks for a plateau of parameters that all work, not the single best cell.
   - Rolling walk-forward (`lib/walk_forward.py`) measures out-of-sample performance.
6. **Report.** `lib/report.py` writes a structured report (KPIs, charts, tables, prose) you can come back to later.
7. **Live.** Scheduled runs are deterministic code on the system scheduler — there is no LLM in the execution loop. `manager/reconciler.py` moves the account toward the target positions, and a kill switch (`state/HALT`) blocks new exposure at the order-library level while closes and stops still go through.

### Strategy types

| Type | What it is | Backtest |
|---|---|---|
| A | One fixed symbol on a fixed interval; one position (long / short / flat) | Required |
| C | A portfolio: N symbols and a weight vector that sums to at most 1, rebalanced on a schedule | Required |
| B | Everything else: screeners, grids, arbitrage, alerts, one-off execution | None |

### Layout

| Path | What is in it |
|---|---|
| `AGENTS.md` | The agent's rules: verify before reporting, iteration limits, data sources, deployment redlines. Start here. |
| `lib/` | Shared library: data, backtest runner, MCPT, parameter scan, walk-forward, reports, charts, watchboard, exchange account and order helpers (`account_*.py`, `order_*.py`), kill switch (`guard.py`) |
| `strategies/` | Strategy templates. Your own strategies live here too and are git-ignored. |
| `examples/` | Complete reference strategies (crypto, crude oil, Taiwan stocks, Taiwan index futures) and export templates — see [`examples/README.md`](examples/README.md) |
| `references/` | What the agent reads before acting: library signatures, strategy code rules, deployment, broker guides, report contract |
| `manager/` | Portfolio manager, reconciler, health check, stop / flatten tools |
| `allocators/` | Template for a custom portfolio weighting method |
| `runtime/` | The agent loop, web and Telegram bridges, reporters and job runner that ship to every cloud machine |
| `shell/` | The desktop app (Electron) |
| `tests/` | Small checks, one file per contract |

## Three ways to use it

**Cloud — Blave Agent on [blave.org](https://blave.org/agent/en).** A dedicated machine that holds this workspace and keeps your strategies running whether or not you are chatting. You talk to the agent from the web workspace or Telegram; SSH is there if you want it. Plans and prices are on the website, not in this README.

**Desktop — this repo's `shell/`.** The agent runs on your Mac and the workspace lives in `~/Blave/`. You choose what powers it:

- your own Claude Code or Codex, installed and signed in by you — Blave charges nothing for the AI; or
- Blave's AI — sign in with a Blave account, billed by usage.

The app only launches those CLIs. Your Claude Code or Codex credentials stay with the CLI; the app does not read them.

**Bring your own agent.** If you have a cloud machine, you can connect your own Claude Code, Codex or another MCP-capable agent to it: the agent gets a short-lived SSH certificate and works in the same workspace under the same `AGENTS.md`. Setup starts in the web workspace under Settings › Connect; the guide is at [blave.org/docs/en/connect](https://blave.org/docs/en/connect).

Claude Code and Codex are products of their respective owners. Blave Agent is not affiliated with or endorsed by them.

## Quick start

### Desktop app, from source (macOS)

The desktop app is an MVP. It is macOS only and there is no packaged installer yet, so you run it from source.

You need:

- macOS
- Node.js with npm (TODO: minimum version to be confirmed; the app pins Electron 38.2.1)
- `python3` on your `PATH` (TODO: minimum version to be confirmed)
- Claude Code or Codex installed and signed in, or a Blave account

```
git clone https://github.com/Blave-TW/blave-agent.git
cd blave-agent/shell
npm install
npm start
```

The first time you connect, the app prepares `~/Blave/`:

- `~/Blave/workspace/` — `lib/`, `manager/`, `references/`, `examples/`, the strategy templates, `AGENTS.md` and `VERSION`, copied from this checkout
- `~/Blave/venv/` — created with `python3 -m venv`, then `claude-agent-sdk`, pandas, numpy, matplotlib, pyarrow, requests, python-dotenv and scipy are installed with pip
- `~/Blave/state/` — chat sessions and images

Your strategies end up in `~/Blave/workspace/strategies/<name>/`. When running from source, the official files are copied again on every launch, so edit `lib/` in the checkout, not in `~/Blave/workspace/`. Your strategies, `.env` and state are never overwritten.

The interface follows the system language (English or Traditional Chinese). To override: `BLAVE_LANG=en npm start`.

TODO: whether live order execution is available from the desktop app is to be confirmed. The live flow described in this README is the cloud machine's.

### Just reading the code

1. [`AGENTS.md`](AGENTS.md) — how the agent is expected to behave
2. [`examples/README.md`](examples/README.md) — eight complete strategies, each showing one pattern
3. [`references/lib.md`](references/lib.md) and [`references/strategy-code.md`](references/strategy-code.md) — library signatures and strategy code rules
4. [`strategies/TEMPLATE_A.py`](strategies/TEMPLATE_A.py) and [`strategies/TEMPLATE_C.py`](strategies/TEMPLATE_C.py)

Each file in `tests/` states how to run it in its header, for example `python tests/check_param_scan.py` or `node tests/check_shell_strings.js`.

## Data and trading venues

**Data.**

- On a cloud machine, market data comes from the Blave API through `lib/data.py`: crypto klines and indicators, Taiwan stocks, futures. The credentials are in the workspace `.env`.
- On the desktop app, crypto klines come from Binance public endpoints and need no account. Blave's indicators and Taiwan market data need a Blave account with data access.

**Venues with a tested order library** (`lib/account_*.py` + `lib/order_*.py`, verified on real accounts):

- Binance, BingX, OKX, Gate.io, Bybit — futures and spot
- Capital Futures (群益期貨) — Taiwan index futures and Taiwan stocks; Windows workspace only

For any other exchange or broker with an API, the agent can write a helper from `lib/account_TEMPLATE.py` and `lib/order_TEMPLATE.py`. That code has not been tested by Blave.

**Paper trading** needs no keys. It ships as `lib/account_paper.py` + `lib/order_paper.py` and prices fills from Binance public prices.

## Safety, and what this is not

- Exchange keys live in the workspace `.env` on your own machine. It is git-ignored. Use trade-only keys with withdrawal disabled.
- Funding amounts, binding a venue and resuming trading are done by you on the web page. The agent refuses to do them for you, even when asked. The one thing it may always do by itself is trip the kill switch.
- The agent verifies before it reports: it re-reads a file after editing it, and queries an order back from the exchange before saying it was placed. Every order attempt is logged to `state/audit.jsonl`.
- A backtest describes the past. It does not predict or guarantee future results. MCPT and parameter scans lower the odds that you are looking at luck; they do not remove them.
- Nothing here is investment advice. Trading can lose money, including all of it.

## Project status

- Workspace version: see [`VERSION`](VERSION) (date-based). Runtime version: `runtime/VERSION`, history in [`runtime/CHANGELOG.md`](runtime/CHANGELOG.md).
- Cloud: in production. Desktop: MVP, macOS only, run from source.
- About the `openclaw` name: it is the name of an earlier framework. Config files (`openclaw.json`), API paths (`/openclaw/...`) and SSH host names still carry it because those locations really are called that. The runtime in `runtime/` has been first-party since 2026-07-25 and is unrelated to that product.

## Contributing

Issues and pull requests are welcome. Before a PR:

- run the checks in `tests/` that cover what you changed;
- activate secret scanning once per clone: `pip install pre-commit && pre-commit install`;
- leave the backtest-chain files (`lib/runner.py`, `param_scan.py`, `walk_forward.py`, `validation.py`, `analysis.py`) alone unless the change is about them — the web workspace reads their output files by contract.

## License

**Apache-2.0** — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE). You may use, modify and redistribute it, commercially too; a patent grant is included. "Blave" and the Blave logo are trademarks: rename your fork.

**The strategies you write are yours.** Anything you (or the agent on your behalf) write under `strategies/` is not part of this project and the license does not reach it.

The paid parts are not in this repo: cloud machines, market data and Blave's LLM proxy are services of blave.org. This code runs on your own computer at no charge, with your own AI subscription and your own data sources.

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

> Clone https://github.com/Blave-TW/blave-agent to /tmp/oc-config and use it as **reference** to update this machine's live workspace — `$BLAVE_AGENT_HOME/workspace`, i.e. the workspace you are running in (`/root/.openclaw/workspace` on old BlaveClaw machines, `/opt/blave-agent/workspace` on Blave Agent machines; resolution per `references/deployment.md`). For each file below, compare the repo version with the local version and apply only what is missing or outdated — do not blindly overwrite.
>
> - `AGENTS.md`, `CLAUDE.md` — replace wholesale (these are config, not user-edited)
> - `references/` — for each file, check if a local version exists; if it does, read both and patch in anything missing; if it does not, copy it in
> - `strategies/TEMPLATE_A.py`, `strategies/TEMPLATE_C.py` — replace wholesale
> - `lib/` — add any canonical files that are missing locally; the backtest-chain files (`runner.py`, `param_scan.py`, `walk_forward.py`, `validation.py`, `analysis.py`) are copied over wholesale (`cp`), never merged; for any other canonical file you modified, read both versions and manually merge the new changes in. For `lib/order_*.py` / `lib/account_*.py`, the name alone doesn't tell you if it's user-created: if that exact filename exists in the reference clone (e.g. `order_bingx.py`, `order_sinopac.py`, `account_bingx.py`, `account_TEMPLATE.py`), merge it like any other canonical file; **never touch** one that does not exist in the reference clone — that's the user's own exchange integration
> - `manager/` — replace wholesale (user edits live in `portfolio_config.json`, not in the scripts)
> - `examples/` — replace wholesale
> - `VERSION` — copy verbatim, always last (it declares the workspace up to date; drives the web "update available" indicator)
>
> When done, remove /tmp/oc-config.
