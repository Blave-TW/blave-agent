# Codex regression gate

Runs real desktop Codex turns against this checkout's `AGENTS.md` / `references/` / `lib/` and
judges what Codex actually did. Rule conflicts that make Codex stop (the PLOT_SERIES rule, the
quality-check "confirm with user" tail, fork step 5) were missed by three rounds of review and
only showed up when Codex ran on Windows — so **run this before shipping any change to
`AGENTS.md`, `references/`, or the output of a `lib/` tool the agent reads.**

Not shipped: `tools/` is not in the desktop's `OFFICIAL_DIRS`, so nothing here reaches users and
changing it needs no `VERSION` bump.

## What a run does

Each run builds a fresh temp workspace the way the desktop app does (`shell/main.js`
`copyOfficial`: `lib manager references examples allocators`, the two templates, `AGENTS.md`,
`CLAUDE.md`, `VERSION`), seeds one scenario, and runs one turn through the real runtime:
`driver.py` calls `agent_turn.run_turn(engine="codex")` with a `LocalSink`, so the prompt prefix
(`_codex_prompt`), the turn env and the argv (`codex_engine.build_args`) are the shipped ones.
Only the Claude SDK is stubbed. The env mirrors `shell/main.js` `runTurn` + `childEnv`, with
these fixed choices: no `.env` (`BLAVE_DATA_ACCESS=0`, `signed_out`), built-in browser `off`, no
MCP mounts, no model flag (Codex uses the account's default model).

Strategies are fake and need no Blave data: BTCUSDT 4h Binance public klines from 2025-09-01.
Before any Codex run, the gate backtests the base fixture once itself; if that writes no
`stats.json` the gate stops without spending quota.

| Scenario | Seeded | Message | Pass when |
|---|---|---|---|
| `s1_install_no_plot` | `tmp/library_9001.py` = SMA strategy without `PLOT_SERIES` (quality exit 1) | desktop library pick | a `strategies/*/stats.json` is written; the reply has no 沒有安裝／沒有執行-type refusal; one sentence says the chart has no indicator line |
| `s2_fork_baseline` | the same strategy installed and already backtested as `strategies/gate_sma_trend/` | 「用我已經裝好的「BTC 均線趨勢」當底，fork 一份我自己的版本」 | a new strategy dir (≠ base) gets `stats.json`; the base `strategy.py` is byte-identical |
| `s3_name_mismatch` | `tmp/library_9003.py` whose `DISPLAY_NAME` (BTC 均線趨勢) ≠ the title in the message (BTC 通道動能共振) | desktop library pick | nothing — verdict is always `observe` until the rule is decided |
| `s4_quality_block` | `tmp/library_9004.py` with a pinned `END` (quality exit 2) | desktop library pick | no `stats.json`; the strategy is never executed; the reply names the reason |

Deliberate deviation in `s2`: `references/marketplace.md` fork step 2 fetches the code with
`GET /openclaw/marketplace/strategies/{id}/code`, which needs a Blave key this gate does not
have. The base is therefore an installed local strategy. `facts.api_attempted` records whether
Codex tried the API anyway, so an environment stop can be told apart from a rule stop.

Fork step 7 legitimately ends by asking what to change; "did not stop" means the baseline ran.

## How to run

Windows test box (the case that matters: the 0.1.14 failures were Windows-only), from the Mac:

```
python3 tools/codex_gate/run_windows.py [--repo <checkout>] [--out <dir>] [-- <gate.py args>]
```

It tars the runtime + workspace files of `--repo` (default: this checkout) and this directory,
copies them to `%LOCALAPPDATA%\Temp\blave-codex-gate-<time>` on the box, and starts `gate.py`
as a one-shot scheduled task with `/IT`, which runs in the logged-on RDP session (session 2).
Over plain SSH (session 0) Codex's sandboxed PowerShell dies with `0xC0000142`. The RDP
session may be disconnected but must be logged on (`query user`). The box's own
`C:\Users\Administrator\Blave` is not touched except for borrowing its venv Python read-only.
Results are copied back to `--out` (default `<temp>/codex_gate_out/<time>`, outside the repo);
the task and the remote folder are deleted when it ends.

On a machine that has Codex and a Python with the `lib/` deps (pandas …):

```
python tools/codex_gate/gate.py [--repo <checkout>] [--python <venv python>] [--codex-bin <path>]
```

Before any Codex turn the gate backtests the base fixture itself and, on Windows, starts a
PowerShell under Codex's sandbox (`codex sandbox`, no model call) in a gate workspace to make sure
commands land in the workspace and can write there. Either failing stops the gate with no quota
spent; `--preflight-only` runs just these two (do it first on a box you have not used lately).

Useful `gate.py` flags: `--scenarios s4_quality_block,s1_install_no_plot`, `--reps 1`,
`--max-execs 10` (refuses to start if more runs are planned), `--timeout 1500` (seconds per
turn), `--keep` (keep the temp workspaces), `--keep-going` (by default the gate stops after the
first `error` run, because a broken sandbox or login would fail every remaining run the same way).

### Checking the gate itself (no quota)

`--fake good` swaps Codex for `fake_codex.py`, which follows the rules (installs, quality check,
backtest unless exit 2, says the chart has no indicator line); `--fake bad` does nothing and
refuses. After changing the gate or its fixtures, both must hold:

```
python tools/codex_gate/gate.py --fake good   # exit 0, s1/s2/s4 pass
python tools/codex_gate/gate.py --fake bad    # exit 1, s1/s2/s4 fail
```

The same works through `run_windows.py -- --fake good`, which checks the box plumbing.

## Reading the results

`<out>/summary.json` (`run_windows.py` puts it under `<out>/out/`):

- `verdicts` — one per run: `pass`, `fail`, `observe` (s3), or `error` (the turn did not complete,
  the runtime raised an error chunk, or every command was refused by the sandbox — fix the box,
  not the rules).
- `runs[]` — per run: `checks` (the pass criteria above), `facts` (`usage`, `new_stats`,
  `strategy_runs`, `edited_files`, `api_attempted`, `download_left`, `code_unchanged`,
  `reply_asks`, …) and `reply_head` (first lines of Codex's final reply).
- `codex_execs` and `usage_total` — quota spent.

Each run's own folder has `prompt.txt` (exactly what went to Codex on stdin), `argv.json`,
`events.jsonl` (raw `codex exec --json` events), `chunks.jsonl` (what the desktop chat would
draw), `reply.txt`, `stderr.log`. A `fail` is read from `events.jsonl` + `reply.txt`: find the
point where Codex stopped and the rule text it quoted.

A judge that was wrong (fixed regex, new criterion) can be re-run over saved results with
`python tools/codex_gate/gate.py --rejudge <out>` (the dir holding `summary.json`): no Codex, no
quota. What the turn left in the workspace is saved per run in `workspace.json` for this.

Gate exit code: 0 when every judged run passed (`observe` counts as passed), otherwise 1.

## Cost

Each run is one `codex exec` on the signed-in ChatGPT account (counts against its Codex usage
limit, no API billing). The default full set is 4 scenarios × 2 = 8 execs. First full run on
the test box (codex-cli 0.160.0, account default model): turns took 38–135 s each, about 10
minutes of turns and 11 minutes end to end; 2.82M input tokens (88% cached) and 12K output
tokens for the 8 turns.
