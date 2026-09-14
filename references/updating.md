# Updating the Workspace

Trigger: user says 更新 blaveclaw / 更新 blave agent / 更新系統 / 更新 config / update blaveclaw / update blave agent / update workspace — no link required.

## 1. Skill

Nothing to install — the platform re-clones the blave-quant skill into `skills/blave-quant` once a day (a systemd timer / scheduled task on Blave Agent machines, a crontab entry on older openclaw boxes). Just check that `skills/blave-quant/SKILL.md` is there; if it is missing, say so in the report and stop — a hand-install would put it somewhere the daily job then overwrites.

## 2. Config

Clone https://github.com/Blave-TW/blaveclaw-config to `/tmp/oc-config` as **reference only** — never as the live workspace. Run the clone in the foreground with an explicit long timeout (e.g. 300000ms) — never `run_in_background`: on a slow/throttled machine the clone can exceed the 120s default and auto-background, and the runtime kills backgrounded processes at turn end with no completion notification, silently dying instead of finishing. Then follow the "Updating an existing workspace" section of its `README.md` exactly: compare file by file, apply only what's missing or outdated.

**Backtest-chain files are replaced, never merged:** `lib/runner.py`, `lib/param_scan.py`, `lib/walk_forward.py`, `lib/validation.py`, `lib/analysis.py` — copy the reference clone's version over the local one (`cp`); a local edit to one of these is drift the web cannot read, and the resident runtime refuses the edit tools on them anyway.

**Hard rule, no exceptions:** never blindly overwrite the rest of `lib/` wholesale. For `lib/order_*.py` / `lib/account_*.py` (and `lib/capital_worker.py`), the filename alone doesn't tell you if it's user-created — check whether that exact filename exists in the reference clone: if it does (e.g. `order_bingx.py`, `order_binance.py`, `order_okx.py`, `order_gateio.py`, `order_bybit.py`, `order_sinopac.py`, `order_capital.py`, `account_bingx.py`, `account_binance.py`, `account_okx.py`, `account_gateio.py`, `account_bybit.py`, `account_capital.py`, `order_paper.py`, `account_paper.py`, `capital_worker.py`, `account_TEMPLATE.py`, `order_TEMPLATE.py` — official broker libs shipped in the repo), merge it like any other `lib/` file (same as `lib/data.py`: preserve local edits, pull in upstream fixes). Only skip a file entirely — never touch it — if it does **not** exist in the reference clone at all; that's the user's own exchange integration. **`lib/venue_errors.py` must always be copied when it is missing locally** — the official `account_*.py` libs and `manager/reconciler.py` import it (the account libs degrade without it; the reconciler cannot start).

After the merge, copy the reference clone's `VERSION` file to the workspace root verbatim — the machine reports it to the platform and it drives the web workspace's "update available" indicator. An update that skips this step keeps telling the user an update is available.

**Restart the reconciler when the update touched `lib/` or `manager/` — REQUIRED, same session, before telling the user anything is enabled** (why: `references/manager.md` › *Workspace update ⇒ reconciler restart*). A running reconciler keeps executing the code it started with — including its in-memory HALT state — until it restarts; skipping this step leaves every fix in the update inactive on the one process that places orders.
- **Restart only a reconciler that is already running.** `systemctl restart` and `nssm start` also START a stopped one, and a stopped reconciler means the user has not started trading (or deliberately stopped it) — starting it for them crosses the deployment redline in `AGENTS.md`. Not running → leave it stopped and say so in the report.
- **How:** follow `references/manager.md` › *Linux — check for the systemd unit FIRST, tmux only as fallback* / *Windows — NSSM service*. In short: Linux with the unit `active` → `sudo -n systemctl restart blave-agent-reconciler.service`; Linux without the unit file and `tmux has-session -t reconciler` succeeding → kill that session and start it again exactly as manager.md shows; Windows with `nssm status blaveclaw-reconciler` reporting `SERVICE_RUNNING` → `nssm restart blaveclaw-reconciler`. Never start a tmux session on a machine where the systemd unit is active.
- **Verify** it is running again (`systemctl is-active …` / `tmux has-session …` / `nssm status …`) before reporting. If the restart failed, report exactly that — the update is on disk but the old code is still trading — never "updated and active".

Remove `/tmp/oc-config` when done.

Report exactly what changed (or that everything was already up to date) — don't claim "updated" without checking.
