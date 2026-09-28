# Strategy Deployment

## Confirmation Required
CRITICAL: You MUST NEVER deploy a live strategy or set up a cron job without explicit user confirmation.

- **The question names everything the deployment puts on the machine**, in the user's words: the strategy's own schedule (「每小時整點跑一次」) and, when the machine has none yet, the health check that alerts them if a schedule goes quiet (「另外會加一個每 30 分鐘的健康檢查，排程停了會通知你」). Their YES covers exactly what the question named, nothing more.
- **Do the one thing that was asked.** Anything else you notice is missing or wrong on the machine — no health check, an unset variable, an old file, a package — goes into the reply as a finding with what it would take, and is done only when the user then says so. Never "while I was at it" (「順手補上」).
- **Every route onto the machine asks the same question.** The desktop agent working on the user's cloud machine (`references/cloud-handoff.md`) confirms exactly as the agent on that machine would: a message that already names the schedule (「排程上線，每小時跑一次」) is the request, not the YES.

## Desktop app (`BLAVE_AGENT_LOCAL=1`) — no system scheduler

Everything in this file about cron and Scheduled Tasks is for cloud machines. Check once per session: `python3 -c "print(__import__('os').environ.get('BLAVE_AGENT_LOCAL'))"` prints `1` on the desktop app. There:

- **Never run `crontab`, `launchctl` / launchd, `schtasks` or any other OS scheduler, and never write a plist or a cron file.** macOS answers with a system prompt (「想要管理你的電腦」) the user never asked for and the command hangs on it; the runtime refuses these commands. Do not look for another way in.
- **Never tell the user to change a system permission** (Full Disk Access, 「管理你的電腦」) or to schedule it themselves in a terminal.
- **Type A/C:** the user funds the strategy and presses 「啟動下單」 on the app's 自動下單 page (`references/portfolio-steps.md`); the app runs it on every bar while it is open. None of the schedule steps below apply (Type A step 5, the healthcheck schedule), and there is no "Reply YES and I will schedule it" question — point to the page.
- **Type B:** it cannot run on a schedule on this computer yet. Say so in one plain sentence when you deliver the strategy, and offer the two ways out: send it to the user's cloud machine (the app's 送上雲端 button; `references/cloud-handoff.md` moves it and runs it once there — putting it on a schedule is then asked of the agent on that machine), or run it once by hand now (`python3 strategies/<name>/strategy.py`). Never ask for a YES to deploy it here.

## No LLM in the Execution Loop

Strategy execution MUST be scheduled as a system cron job (Linux) or Scheduled Task (Windows) that runs Python directly through `manager/wait_for_bar.py` (Type A/C) or `manager/run_strategy.sh`/direct `strategy.py` (Type B — see its own section below) — NEVER as an OpenClaw agent cron that wakes the agent to "run the strategy and report the result".

- Every agent wake-up burns the user's LLM credit (a full session trajectory per tick). A `*/5` agent cron costs orders of magnitude more than the identical system cron, for zero added value — the strategy script is deterministic Python and needs no reasoning to run.
- Failure notification is already handled deterministically: `run_strategy.sh` (Type B) and `wait_for_bar.py` (Type A/C) both catch crashes and send the Telegram alert via `manager/alert_failure.py`. An agent cron adds no reliability.
- **Blave Agent runtime (`/opt/blave-agent`): there is no agent cron you can write.** Every scheduled thing is deterministic Python — except, on a cloud machine, a scheduled report job the user agreed to (`agent_consent`), for which the runtime itself starts one unattended agent turn per run to narrate it (`references/reports.md` §8 › Scheduled agent runs), falling back to the job's data-only `run.py`. On the desktop a scheduled report is the data-only `run.py`. Do not script a canned judgement into `run.py`.
- **Old OpenClaw runtime (`/root/.openclaw`) only:** agent crons exist and are reserved for work that genuinely needs reasoning — anomaly triage, reconcile summaries, a report's narration. Frequency: at most a few per day, never per tick.
- If the same strategy has both a system cron AND an agent cron that runs it, that is a bug — remove the agent cron (keep the system one) after telling the user why.
- If the user explicitly asks you to run the strategy on every tick via agent cron, explain the credit cost first and offer the system-cron path; only proceed if they still insist.

## Type A (Signal Strategy) — mandatory flow:
1. Write the strategy and run a backtest — show the results. There is no mode constant to set: a run is a backtest until the strategy is in the 下單設定 (`amounts` in `portfolio_config.json`) or the schedule sets `BLAVE_MODE=live`
2. Ask the user to confirm deployment: "Do you want to deploy this live? Reply YES to confirm."
3. After YES, ask the following **in a single message** before writing any code:
   - **Spot or futures/perpetual?** This determines which order API and position sizing logic to use.
   - **Align positions?** Do you want to reconcile current open positions before the first live run? If YES, fetch current positions from the exchange and align them with what the strategy's initial state expects — place orders for any difference. If NO, the strategy will align naturally over the next few signals.
4. After all three are answered, confirm portfolio_config.json settings with the user:
   - **`amounts`**: per-strategy dollar allocation — "what this strategy trades with at position=1", in account currency (contracts for Capital Taiwan futures). `amounts` is canonical (see `lib/portfolio.py` `strategy_amounts`); ask the user for this strategy's amount directly. Legacy configs without `amounts` fall back to `account_value × leverage × weight` — do not create new deployments on the legacy fields.
   - Show current values from portfolio_config.json if it exists, and ask the user to confirm or update them before proceeding.
5. Only after all confirmations: update portfolio_config.json (the strategy's key in `amounts` is what makes a run live — no file edit), and set up the schedule (cron on Linux, Scheduled Tasks on Windows — see OS check in `AGENTS.md`):
   a. Add the strategy schedule entry (see Cron Job Format / Scheduled Task Format below)
   b. **Add the healthcheck schedule if not already present** and register the deployment — see Deployment Healthcheck below

Never assume the user wants to go live just because they described a strategy or said "let's try it."
Even if the user says "deploy it" or "run it", always confirm with one message before touching the schedule or `portfolio_config.json`.

**Before any deployment (Type A, B or C), check for a scoped halt:** `ls state/HALT_<name>` plus any slug the strategy's code checks (`halted_for("…")`, `STRATEGY_SLUG`). One existing means the strategy was stopped (`manager/stop_strategy.py`) or its own breaker fired — tell the user the file's reason and time, and clear it (`lib.guard.clear_halt_for`) only with their explicit consent; code that checks it will never open a position while it exists.
Once deployed live, send a confirmation message with: strategy name, schedule, amount, and one line noting the healthcheck will alert them if the strategy stops running.

## Editing a FUNDED Strategy (in the 下單組合)

Never in place — ANY change to a funded strategy (parameters and thresholds
included, not just NAME/SYMBOL/MARKET) follows the fork-and-switch flow in
`references/strategy-code.md` › *Editing a live strategy*: build the change
as a new strategy, backtest it, and switch the 下單設定 funding in one save
only after the user confirms. In-place edits reach the live position on the
very next bar; in-place identity changes silently close positions (measured
2026-08-05).

Also: `strategies/<name>/strategy.py` is the only layout the schedule can
run — never `strategies/<name>.py` at the top level (healthcheck flags it).

## Deployment Healthcheck

`manager/healthcheck.py` alerts the user when something that should be running has gone quiet — a lost cron entry, a dead daemon, or a deployment that was registered but never scheduled. It complements `alert_failure.py` (which only fires when a run happened and crashed). Heartbeats are written automatically: `run_strategy.sh` (Type B) and `wait_for_bar.py`'s own launcher (Type A/C — same contract, reimplemented in Python so it works without bash on Windows) both touch `state/heartbeat/<name>` on every successful run, and repo daemons (reconciler) touch their own each loop.

At deployment time:

1. **Add the healthcheck schedule once — as part of what the user confirmed** (*Confirmation Required*: the question named it). Check first with `crontab -l | grep healthcheck` (Linux) or `schtasks /query /tn blaveclaw-healthcheck` (Windows):
```
*/30 * * * * cd $BLAVE_AGENT_HOME/workspace && python3 manager/healthcheck.py
```
```
schtasks /create /tn "blaveclaw-healthcheck" /tr "cmd /c cd /d %BLAVE_AGENT_HOME%\workspace && python manager\healthcheck.py" /sc minute /mo 30 /ru SYSTEM /f
```
(`$BLAVE_AGENT_HOME` / `%BLAVE_AGENT_HOME%` — see the note above "Cron Job Format" below for how to resolve and set this once.)
2. **Register the deployment** in `state/deployments.json` (create the file if missing):
```json
{"<strategy_name>": {"type": "cron", "expect_every_minutes": 60,
                     "registered_at": "<UTC now, %Y-%m-%dT%H:%M:%S>"}}
```
Strategies scheduled through `wait_for_bar.py` (or the older direct `run_strategy.sh`) are also auto-registered by the healthcheck from crontab, so registration is a safety net, not a hard dependency — but daemons (e.g. reconciler, `{"type": "daemon", "expect_every_minutes": 5}`) MUST be registered manually or the healthcheck cannot see them.

Alert behavior: at most one alert per deployment per 6 hours; a one-line recovery message when the heartbeat returns. Weekday-only schedules (day-of-week restricted cron) use a conservative 3-day threshold so weekends never false-alarm.

## Long-running processes — memory discipline

RAM on the machine is limited and shared with the agent runtime itself (check with `free -m`); a process that grows without bound freezes the ENTIRE machine — the bot dies with it and the user is locked out (it has happened: an in-memory trade log grew to 1.9 GB and froze a machine for 24 hours). For any process that runs continuously (live monitors, scanners, paper-trading engines):

- Every in-memory list/dict that grows per tick, per signal, or per trade MUST be bounded — `deque(maxlen=N)` or trim to the last N entries. No exceptions.
- Records that must be kept forever go to disk (append to a `.jsonl` file), NOT into a Python list.
- NEVER attach large snapshots (full feature caches, candle histories, whole DataFrames) to per-trade/per-signal records. Store IDs or the few fields you need.
- Keep only the candles a computation needs (e.g. last 50 bars), not the full history.
- After starting a long-running process, check its memory once (`ps -o rss= -p <pid>`) and tell the user roughly how much it uses; if it grows run over run, treat that as a bug and fix it before leaving it running.
- Every daemon must heartbeat: touch `state/heartbeat/<name>` at the top of each loop iteration, and register the daemon in `state/deployments.json` so `manager/healthcheck.py` alerts the user when it dies (see *Deployment Healthcheck* above). A daemon nobody watches WILL die silently and the user finds out weeks later.

## Long jobs — progress reporting

Real users have asked "are you still running?", "it's been two hours", "did it finish or crash?" during parameter scans and deep-history backtests. The fix is procedure, not code: say what is coming, keep the run observable, report with the elapsed time.

**What the user actually sees while a tool runs** (runtime facts — do not assume otherwise):
- Web workspace: an activity block with a per-second elapsed clock and one receipt row per tool call (running → done). The text you write *before* a tool call goes into that block's collapsible reasoning log, never into the chat bubble or the history.
- Telegram: only the typing indicator. Text you write before a tool call is dropped. The one channel that reaches the user mid-turn is a real message via `lib.notify.send_text`.
- Tool stdout never reaches the user on either surface — you relay it.
- The Bash tool's default timeout is 120 s; an explicit `timeout` goes up to 30 min. That `timeout` is a setting of the tool call (milliseconds), never a `timeout` command in front of the line — macOS has no such command and the call fails with `command not found`. A call that hits its timeout is NOT killed — the runtime moves it to the background and it keeps running (still writing `scan.json` / `stats.json`) until the turn ends. So after a timeout: read that command's output / `tail` its log until the final line appears; never start a second run (two copies would overwrite each other's output, and it breaks the Iteration Brakes). Any backgrounded process is killed when the turn ends.

**Procedure**
1. **Estimate** before running: a scan is cells × one `compute_signals` pass (numbers in `references/strategy-code.md` › *Grid size*); a cold 1-min fetch is 30-day chunks, 10 in parallel. Cannot estimate → treat it as long (step 3b) and let the first `[…] ~N left` line give the number.
2. **Notice — one line, before the run:** the estimate and how you will report, e.g. 「開始掃 15×15=225 格,約 6 分鐘,跑完回報」. Telegram: `python3 -c "from lib.notify import send_text; send_text('開始掃 225 格,約 6 分鐘,跑完回報')"` as its own tool call first. Web: write the line as the narration right before the run's Bash call (it lands in the activity log).
3. **Run:**
   - **a. ≤ 10 min** — foreground, tool `timeout` = 2× the estimate (≤ 30 min). The `[scan]` / `[mcpt]` / `[fetch]` lines come back in the output. If the call still hits its timeout, the run is now in the background and still going: keep reading its output (the tool says where) until the final line — never launch it again.
   - **b. > 10 min or unknown** — background with the output in a log, then poll:
     `nohup python3 strategies/<name>/scan.py > tmp/<name>_scan.log 2>&1 &` (same line on Windows — the Bash tool there is Git Bash), then repeat the single command `python3 -c "import time; time.sleep(150); print(''.join(open('tmp/<name>_scan.log', encoding='utf-8', errors='replace').readlines()[-3:]))"` (Bash tool `timeout` 180000; no `;`/`&&` chaining — it waits, prints the last three lines and exits by itself; the same line on macOS, Linux and Windows). Never `timeout 150 tail -f …` (no `timeout` command on macOS), never a leading `sleep` (the engine refuses it) and never the engine's `Monitor` / cron tools (next section). Jobs past ~30 min: poll every 5 min (`time.sleep(300)`, tool timeout 360000) to keep the turn's step count down. After each poll relay the newest progress line in one short sentence (web: narration; Telegram: `send_text`, at most once per ~10 min or when the ETA changes a lot). Done = the log shows the final line (`Scan written:` / `Heatmap saved:` / the stats block; a Python traceback = crashed). Progress lines land one per 10 % of the work, so the first one only appears once the job is 10 % done (a 2-hour job: ~12 min in) and the expected gap between lines is about a tenth of the whole run — hang = three consecutive polls with no new line once that expected gap has passed (before the first line, on a job whose length you cannot estimate, allow ~15 min of silence). Report a hang with the last line, do not restart on your own.
4. **Final report** = result + elapsed, e.g. 「掃描 15×15,耗時 7 分 40 秒:穩健點 …」. Timeout / crash / user Stop: what happened, the last progress line, and what you propose — the Iteration Brakes apply (no silent re-run, no widening).

### When the job does not finish in the turn

A turn is one process. When it ends, the engine is closed: nothing calls you again, and every process you started — foreground, backgrounded by a timeout, `nohup` — is killed with it. The hard ceilings are 30 min for one Bash call and 35 min for the whole turn. Measured 2026-09-28 (desktop): a five-stock Taiwan backtest from 2015 needed ~35 min of cold fetches; the call was given 10 min, got backgrounded, the agent armed a `Monitor` on `stats.json`, wrote 「回測還在跑，等它完成後我會回報結果」 and ended the turn. The backtest died, the watcher had no one to report to, and the user was left with a strategy card saying 「沒有回測」 and a promise nobody could keep.

- **No promise of a later report.** 「完成後我會回報」, 「稍後通知你」, 「跑完再跟你說」, "I'll let you know when it's done" are all false here. The one exception is something the machine does by itself and that already exists: a registered report schedule, a deployed strategy's own notifications. Name that mechanism when you rely on it.
- **No watcher tools.** `Monitor`, `CronCreate` and any other engine tool that waits for an event or a time deliver to a session that is gone by then; the runtime refuses the first two. Waiting happens inside the turn, with the polling line of step 3b.
- **Before starting**, when the estimate is over ~25 min: say it cannot finish in one go, and offer the version that can — a shorter span or fewer symbols first (the full span afterwards reuses what was fetched), or the fetch in this turn and the backtest in the next.
- **When it was cut anyway**, the reply has four parts, in plain words: (1) what did not finish — 「回測沒有跑完」; (2) why — 「抓資料花的時間超過這一輪的上限」; (3) what is done and kept — which symbols are fully fetched, which one stopped where (count the files in `cache/<dataset>_<id>_<src>/`; months already fetched stay cached, so the next run resumes there); (4) what the user says to continue — 「說『繼續回測』我就接著跑，剩下大約 N 分鐘」. Then stop: no re-run on your own (Iteration Brakes).
- **A strategy left without a backtest is said as such** — 「策略寫好了，但還沒有回測結果」 — never reported as a finished strategy.

**Progress lines lib prints** (stdout, one per 10 % of the work, with elapsed and ETA; silent when the whole job projects under 5 s — 30 s for MCPT, so the automatic backtest MCPT inside the runner's budget adds nothing to the output):
- `[scan] 36/120 cells, 2m10s elapsed, ~5m03s left` / `[scan] 120/120 cells done in 7m40s` — `lib/param_scan.scan_grid` (cells = combos that actually run `compute_signals`)
- `[mcpt] 800/2000 permutations, 12s elapsed, ~18s left` — `lib/validation.mcpt`
- `[fetch BTCUSDT 1min] 12/61 chunks, 1m02s elapsed, ~4m15s left` — `lib/data` cold deep-history kline / alpha fetches
Formatting lives in `lib/progress.py` (`Progress(tag, total, unit)` + `tick()`); reuse it in any new long loop rather than hand-rolling a counter.

## Cron Job Format (Linux)
**The `cd` is mandatory in every cron entry — and doubly so now that there are two possible starting points.** Cron starts in the home directory of the user whose crontab the entry lives in, and that user differs by RUNTIME: on old BlaveClaw machines the agent runs as `root`, so its entries land in root's crontab and cron starts from `/root` (workspace: `/root/.openclaw/workspace`); on Blave Agent machines the agent runs as `blaveagent`, so its entries land in that user's crontab and cron starts from `/opt/blave-agent` (workspace: `/opt/blave-agent/workspace`). Neither start directory is the workspace — both sit above it. All scripts in this repo use relative paths (`manager/`, `strategies/`, `lib/`, `cache/`), so without `cd`, every relative path resolves from whichever home cron happened to start in → `FileNotFoundError` → the script crashes silently before sending any Telegram notification. Never write an entry that leans on the start directory being what you expect: with two fleets in play, a hardcoded assumption is guaranteed wrong on one of them.

**Resolve `$BLAVE_AGENT_HOME` before writing any cron entry** — workspace root is `$BLAVE_AGENT_HOME/workspace`, not a fixed path, and the correct value depends on which RUNTIME this machine is (same distinction `AGENTS.md` already has you determine once per session for OS): old BlaveClaw machines default to `/root/.openclaw`; the newer Blave Agent runtime (layout signal: `/opt/blave-agent/openclaw.json` exists — check the file, not just the directory, or a half-provisioned machine reads as this runtime and fails a different way) defaults to `/opt/blave-agent` instead — `lib/notify.py` resolves this same way, so a cron entry that gets it wrong doesn't error, it just silently drops every Telegram alert (measured live on a Blave Agent machine 2026-08-19: `send_text()` degraded to a no-op log line with `/root/.openclaw`, no error surfaced anywhere). If `BLAVE_AGENT_HOME` is already set in your shell environment, trust that over guessing from the layout. Every cron entry below writes `$BLAVE_AGENT_HOME` literally into the line — set it once at the top of the crontab so all entries (present and future) expand it the same way:
```
BLAVE_AGENT_HOME=/opt/blave-agent    # or /root/.openclaw — whichever this machine's layout resolved to, see above
*/30 * * * * cd $BLAVE_AGENT_HOME/workspace && python3 manager/healthcheck.py
* * * * * cd $BLAVE_AGENT_HOME/workspace && BLAVE_MODE=live python3 manager/wait_for_bar.py <name>
```
(check `crontab -l` first — if a `BLAVE_AGENT_HOME=` line already exists, don't add a second one and don't assume it's wrong; only replace it if you've confirmed the existing value doesn't match this machine's actual layout.)

**Type A/C: always go through `manager/wait_for_bar.py`, never call `strategy.py` or `run_strategy.sh` straight off the cron.** A fixed "N minutes after the boundary" offset either wastes time on days the data lands fast or isn't enough on days it's slow (and users notice — "why does it always wait 5 minutes"). `wait_for_bar.py` polls every minute, checks whether the bar the strategy actually needs (via the strategy's own `fetch_data`) has landed yet, and only then runs it; once that bar is processed it exits immediately with no fetch and no log until the next bar boundary — see the docstring in `manager/wait_for_bar.py` for the exact freshness check (Type C waits for every symbol in the universe, not just the first to update). If the bar still hasn't landed after 15 minutes it sends one Telegram alert (not a repeat per minute) and keeps polling — this is a different signal from a crashed run and from the healthcheck (schedule went quiet entirely); a data source that's actually down can trip more than one of the three, and that overlap is expected, not a bug.

**`wait_for_bar.py` does NOT shell out to `manager/run_strategy.sh`** — that script is bash-only, and Capital(群益)/Taiwan-broker strategies run on Windows, which has no bash. Instead `wait_for_bar.py` launches `strategy.py` directly with `sys.executable` (whatever interpreter cron is already using) and reimplements the same crash-safety contract in pure Python: capture output, log + Telegram-alert via `manager/alert_failure.alert()` on a non-zero exit or a hung run (killed after a timeout), touch the heartbeat on success. This is why it's safe to schedule identically on Linux and Windows — see both cron forms below.

Strategy execution cron (Type A/C):
```
* * * * * cd $BLAVE_AGENT_HOME/workspace && BLAVE_MODE=live python3 manager/wait_for_bar.py <name>
```

Never write `python3 strategies/<name>/strategy.py` or `bash manager/run_strategy.sh <name>` directly in a cron entry for a Type A/C strategy — always go through `manager/wait_for_bar.py <name>`, and the `cd &&` prefix is still not optional. `BLAVE_MODE=live` is part of every schedule entry (Linux and Windows, all types): it is what tells the runner this is a signal tick — no version minted, no MCPT, no chart pushed — independent of what the 下單設定 says at that moment.

## Scheduled Task Format (Windows)
Same entry, via `schtasks`. The `cd /d` is mandatory for the same reason as Linux's `cd &&` — all scripts use relative paths. Resolve `%BLAVE_AGENT_HOME%` the same way as Linux (defaults to `C:\openclaw` if unset) rather than assuming a fixed path.

Strategy execution task, Type A/C (every minute — `wait_for_bar.py` itself decides when the real run fires; note this calls `wait_for_bar.py`, not `strategy.py` directly — the old direct-`strategy.py` form had no crash protection on Windows at all, since `run_strategy.sh` never ran there either):
```
schtasks /create /tn "blaveclaw-strategy-<name>" /tr "cmd /c cd /d %BLAVE_AGENT_HOME%\workspace && set BLAVE_MODE=live&& python manager\wait_for_bar.py <name>" /sc minute /mo 1 /ru SYSTEM /f
```

## Type B (Everything else) — mandatory flow:
Cloud machines only — on the desktop app a Type B strategy is never scheduled (*Desktop app* above).
Type B strategies (screener, grid, arbitrage, one-off execution, alert bot) have no `INTERVAL`/`fetch_data` contract to poll a bar against, so they do NOT go through `wait_for_bar.py` — they keep a plain fixed-cadence schedule, same as before this mechanism existed.
1. Skip backtest entirely
2. Ask the user to confirm before deploying: "Do you want to deploy this live? Reply YES to confirm."
3. After YES, ask **Spot or futures/perpetual?** and **Align positions?** (same as Type A step 3) before writing any code.
4. Only after all confirmations: agree a run cadence with the user (there's no bar to wait for, so this is just "how often"), set up the schedule, and add the healthcheck schedule if not already present and the confirmation question named it (*Confirmation Required*):
```
<M> * * * * cd $BLAVE_AGENT_HOME/workspace && BLAVE_MODE=live bash manager/run_strategy.sh <name>
```
```
schtasks /create /tn "blaveclaw-strategy-<name>" /tr "cmd /c cd /d %BLAVE_AGENT_HOME%\workspace && set BLAVE_MODE=live&& python strategies\<name>\strategy.py" /sc minute /mo <N> /ru SYSTEM /f
```
(Linux still goes through `run_strategy.sh` for the same crash-safety reason as always; Windows Type B has no equivalent wrapper yet — same pre-existing gap this whole mechanism didn't set out to fix — so a Type B crash on Windows is silent. Flag this to the user if they're deploying Type B live on Windows.)

## Live vs Backtest
Live trading uses the SAME script as backtest — only the schedule and the 下單設定 change. The runner never reads a `MODE` constant (new strategies have none; a leftover line in an old file is ignored): a run is live when `BLAVE_MODE=live` is set (every schedule entry sets it) or, without it, when the strategy is a key of `amounts` in `portfolio_config.json` — an amount of 0 still counts. So `python3 strategies/<name>/strategy.py` on a deployed strategy is a quiet live tick, not a backtest; to get the backtest chart anyway, run `BLAVE_MODE=backtest python3 strategies/<name>/strategy.py`. Keep `START` the same long date range as backtest so the website report shows full history. `END` is always `None` (backtest and live alike) — a pinned date caps the data fetch and freezes a deployed strategy's signals at that date, and quality_check flags it as CRITICAL.

## Live Position (Every Tick)
Every live tick sets the position to `signals.ffill().fillna(0).iloc[-1]` — the same position the backtest holds on the last bar — including the first tick, when there is no `state.json` yet. A tick that skipped bars (slow tick, fetch backoff) therefore converges on the next tick instead of losing an entry/exit that landed on a skipped bar. Consequence: if a live strategy's parameters are edited in place, its position follows the new parameters on the very next tick — which is why live edits still go through fork-and-switch (`references/strategy-code.md` › *Editing a live strategy*).
