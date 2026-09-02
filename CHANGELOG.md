# Runtime changelog

Queued-for-release state lives HERE, not in anyone's memory: any commit that
changes `runtime/` adds a line under **Unreleased** in the same commit. At
publish time, bump `VERSION`, move the Unreleased lines under the new version
heading, and ship — the file sits next to `VERSION` so the publisher cannot
miss it. (Channel rules: `.claude/docs/blave-agent-update-channels.md`.)

## Unreleased

(none)

## 1.1.58 — 2026-09-03

- `agent_turn._SUGGEST_RULE` 優化選項: no more "scan the parameters" suggestion once the
  strategy folder has a `scan.json` or the turn is the adopt-and-rebacktest of scanned
  params; the MCPT line no longer suggests running MCPT (automatic in every Type A
  backtest, p-value in `stats.json`) — instead p-value > 0.05 → suggest a filter or a
  different signal, not parameter tuning.

## 1.1.57 — 2026-09-03

- Watchboard (`.claude/docs/watchboard.md` §4): `report_uploader` also sweeps
  `workspace/watch/` — `ops/*.json` POSTed to `/openclaw/agent/watch/ops` in file-name
  order (200 → `ops/sent/`, 4xx other than 408/429 → `ops/failed/`, else backoff) and
  `data/<widget_id>.json` PUT to `/watch/data/<id>` with overwrite semantics (the file
  stays in place; the mtime+size last shipped is kept in `state/watch_uploads.json`, so
  only a rewritten file is re-sent; ≤64 KB; image sidecar `data/<id>.files/` with the
  report's three-way failure rule, except a 507 on the sole block → failed). Errors go
  to `watch/upload_errors.log`; the quiet-window wait covers both trees.
  `blave-agent-reports.path` watches `watch/ops` + `watch/data` (Windows:
  `file_watcher` gets the same two dirs). `report_runner` accepts `job.json`
  `"kind": "watch"` (`prompt` optional): the run is `ok` only when
  `watch/data/<id>.json` was rewritten, `skipped` (with a stderr line) otherwise, no
  report ids; `strategy_reporter.report_schedules` leaves watch jobs out of the
  定期報告 list. Check: tests/check_agent_watch.py.

## 1.1.56 — 2026-09-02

- performance_report retired: Blave Agent ships **no built-in report** — every
  report is a job the user registered under `workspace/report_jobs/`
  (`.claude/docs/report-schedules.md`) or asked for in chat. The hourly equity
  sampling into `workspace/state/equity_history.jsonl` goes with it (nothing else
  read that file; the platform keeps `agent_equity_snapshot`).
  `blave-agent-perfreport.{service,timer}` and the Windows `blave-agent-perfreport`
  task leave `jobs.json` + `blave_agent/systemd/`. **Fleet mechanism — read before
  assuming the timer is gone:** the manifest has no remove semantics.
  `control/updater.py apply_jobs` only installs listed units and `enable --now`s the
  `enable: true` ones; `_apply_windows_tasks` only registers listed tasks. A dropped
  entry (and equally `"enable": false`) leaves the unit enabled / the task
  registered on every machine that took 1.1.52–1.1.54, and control/ cannot update
  itself. So `performance_report.py` stays as a tombstone that exits 0: those
  machines keep an hourly fire that reads nothing, writes nothing and uploads
  nothing, instead of an hourly `failed` unit. Actually removing it is a
  per-machine hand step (`systemctl disable --now blave-agent-perfreport.timer`,
  rm the two unit files, `daemon-reload` / `Unregister-ScheduledTask
  blave-agent-perfreport`), after which the tombstone can be deleted. Existing
  `daily-*` / `wk-*` / `mo-*` reports and `state/equity_history.jsonl`,
  `state/performance_report.json` are left in place. tests/check_report_pipeline.py
  shrinks to the uploader half (the fixtures stand in for the generator's docs).

## 1.1.55 — 2026-09-02

- strategy_reporter: `strategies/<name>/scan.json` (blaveclaw-config
  `lib/param_scan.write_scan`, the 穩健參數 grid) is reported as the strategy's
  top-level `scan`, sibling of `backtest`; absent / unparseable → key absent, never
  fatal. `signature()` gains a fourth column (scan.json mtime+size, no live
  exemption — only an explicit scan writes it) so a finished scan reaches the open
  workspace mid-turn. Shape validation is the api's (`agent_strategies._clean_scan`,
  drops the key alone). Check: tests/check_strategy_scan.py.

## 1.1.54 — 2026-09-02

- report crontab lines address the runner through `<BASE>/current/`, not the resolved
  `releases/<version>/` path `__file__` gives on a machine (29026 e2e) — a line is only
  rewritten when it changes, so a pinned path would keep every job on the release it was
  installed under.
- Scheduled reports (`.claude/docs/report-schedules.md`): the agent registers a
  job by writing `workspace/report_jobs/<id>/{job.json,run.py}`; this runtime
  owns everything after that. New `report_runner.py <id>` runs the script
  (cwd=workspace, system python, `BLAVE_*` stripped, 600 s), classifies the run
  `ok` / `skipped` (exit 0, no `reports/*.json` with mtime ≥ start) / `failed`,
  appends to `runs.jsonl` (last 50 kept, stems `[A-Za-z0-9_-]{1,64}` only, ≤50),
  overwrites `run.log`, holds `report_jobs/<id>/.lock` for the run (a second
  runner exits 3 without recording), and on `failed` calls
  `manager/alert_failure.py` best-effort. Stdlib-only, no runtime imports. `command_listener._sync_report_crons`
  installs one `# blave-report:<id>` crontab line (Linux) / `blave-web-report-<id>`
  scheduled task (Windows, cron subset only) per enabled job, under `_cron_lock`,
  every scheduler tick and after each `report_*` command; the crontab is only
  rewritten when the tagged set differs. Five new commands: `report_pause`,
  `report_resume`, `report_run_now`, `report_delete`, `report_edit_pending`
  (args `{id}`; the last also takes `prompt` / `schedule_human`). `strategy_reporter`
  adds `report_schedules` to the cache payload (registration + last run +
  `next_run_at` from a built-in 5-field cron evaluator; `{id, error}` for a job
  it will not install: bad file, cron field outside ASCII `[0-9*,/-]` or a
  timestamp outside 0–2100, past the 20 valid-job cap, Windows-inexpressible
  cron) — omitted, not emptied, if the scan itself fails.

## 1.1.53 — 2026-09-02

- performance_report: the daily report gains a 運行狀況 section after the
  existing blocks — one `table` row per strategy known to either
  `strategies/*/state.json` or `state/deployments.json` (排程 = the registry's
  `type`, 最後成功執行 = `state/heartbeat/<name>` mtime as 「3 小時前」, 逾期 =
  heartbeat older than 2 × `expect_every_minutes`, 目前部位 = state.json
  position; `type == "daemon"` registry entries — the reconciler — are NOT
  strategies and are left out, the service-heartbeat callout covers them),
  plus `callout` blocks (tone warning) that appear ONLY when there is something
  to say. The daily is per-day and idempotent, so the HALT callout is
  REPORT-DAY based, not 「now」 based: it reads `state/audit.jsonl` (lib/guard.py's
  append-only `halt_tripped` / `halt_cleared` lines, last 1 MB) and fires when a
  `halt_tripped` falls inside the report day (lists the day's tripped / cleared
  times + reason + source, `%m/%d %H:%M` UTC like every other timestamp) OR
  `state/HALT` still exists (adds a 「目前仍在 HALT」 line with the file's ts /
  reason / source; title 「HALT：新倉下單已暫停」 vs 「…曾暫停新倉下單（已解除）」).
  A halt tripped and cleared within the day is therefore reported even though
  the file is gone by the time the daily is produced. The other callouts:
  entries in `manager/order_errors.json` dated the report's day — titled
  「下單失敗（最近 N 筆）」 because the writer (`lib/portfolio._record_order_error`)
  keeps only the last 5, so the day's true count is unknowable; lines in
  `reports/upload_errors.log` dated that day (≤5); and a `reconciler` /
  `command_listener` heartbeat that exists and is older than 300 s — this one
  is a LIVE condition (heartbeats have only an mtime, no history), so its
  title and first line say 「產報告時」 with the generation time. Nothing wrong
  = no callout; silence is the normal state. The columns are untagged
  (`text`): the position carries a sign but is a direction, not a P&L, so the
  contract's colour gate must stay neutral. The service-heartbeat callout only
  fires when the heartbeat FILE exists — a machine that never configured
  auto-trading has none, and a daily 「reconciler dead」 for it would be noise.
  Every input is optional: a missing file drops that row/callout, never the
  report. Existing daily/weekly blocks are byte-identical to before.
- performance_report: new monthly report, `mo-YYYY-MM` (`type=performance`,
  `report_type=績效月報`, period = first..last day of the last FINISHED UTC
  month, same catch-up semantics as the weekly). Blocks: kpi_row (帳戶權益 /
  本月報酬 / 本月最大回撤 / 年化波動 / 交易日數 / 策略數), line_chart 本月權益
  (with `y_unit`), drawdown over the month window, the monthly-returns calendar
  heatmap (same ≥2-month gate as the weekly), metric_table 風險指標 = the
  weekly set computed on the month's daily closes (the first day's base is the
  previous month's last close, matching `monthly_returns`) plus Sortino,
  Calmar, 勝率(日), 獲利因子(日), 最佳日 / 最差日 — undefined ratios (no losing
  day, no downside, no drawdown) render as 「—」 rather than 0 or inf — and the
  分策略 table. **No 「分策略貢獻」 bar_chart**: nothing on disk is a real
  per-strategy P&L — `orders.jsonl` `contributors` are each strategy's TARGET
  notional at reconcile time and `stats.json` `daily_returns` are backtests —
  so the block is omitted rather than invented. `due()` now returns a third
  element (the month) and `main()` runs a third `("monthly", …)` tuple, so
  idempotence / state / rollback come from the same loop.
- performance_report: `strategy_rows()` and `exposure_rows()` are computed
  ONCE per tick in `main()` and passed into all three builders (lazily — a
  tick where every report is already done still scans nothing), instead of
  each build re-walking `strategies/` (stats.json can be several MB) inside
  the shared `_BUDGET_S`. Standalone calls still compute their own.
- tests/check_report_pipeline.py: builds daily + monthly from fixture files
  (deployments / heartbeats / HALT / audit.jsonl / order + upload errors)
  through the real `validate_report`, asserts the 運行狀況 roster (daemon
  excluded), the overdue rule at a point where 1× vs 2× flips (90-min-old
  heartbeat on a 60-min cadence), a future-mtime heartbeat (age 0, not
  overdue), per-day filtering, the four HALT cases (tripped on the day and
  still halted / tripped-and-cleared within the day with the file gone /
  standing halt from an earlier day / events on other days only → no callout),
  zero callouts on a healthy machine with AND without service heartbeat files,
  an all-up month rendering Sortino / 獲利因子 / Calmar as 「—」 with no nan /
  inf string anywhere, `due()` across the year boundary and a leap February,
  and proves the check is wired to the validator by over-filling one metric
  cell (must 400).

## 1.1.52 — 2026-09-01

- telegram_bridge: `download_tg_file` scrubs the bot token out of exception text
  before logging — the download URL embeds the token, and exceptions like
  `http.client.InvalidURL` echo the whole URL; with blaveagent now in the
  systemd-journal group, stderr is readable by user-side code on the machine.
- report_uploader: new — the machine's only path from a report JSON to
  `PUT /openclaw/agent/report/<id>`, and the owner of the drop-dir contract
  (`workspace/reports/<id>.json`, written atomically, id = file stem). Runs a
  deliberately looser-than-api contract check before spending a request and
  writes every refusal — local or the api's own 400 — to
  `workspace/reports/upload_errors.log` so the machine's agent can read what it
  got wrong. Uploaded reports move to `reports/sent/`, permanently refused ones
  to `reports/failed/`; transient failures back off (60s→1h) and retry
  indefinitely. No Telegram here — the summary push is platform-side
  (`agent_reports._notify_stored`), so sending from the machine too would
  double every alert. This file's existence is also what flips
  `strategy_reporter._can_report()` true fleet-wide.
- report_uploader: report figures now ride along in a sidecar directory,
  `workspace/reports/<id>.files/` — an `image` block carries `{"file":
  "equity.png"}` and this process uploads the bytes (same strategy_image
  channel, now via the public `strategy_reporter.put_image`) and rewrites the
  field into `sha256`. Producers need no token, which is the point:
  `command_listener._strategy_subprocess_env()` strips every `BLAVE_*`, so a
  scheduled script could not PUT an image at all — and scheduled research
  figures are what the block exists for. Failure semantics split three ways:
  a producer mistake (missing file, non-image extension, 0/>2MB) refuses the
  whole report, anything transient defers it intact, and only a 507 image
  quota drops the block and ships the rest (logged, plus the quota marker the
  agent raises in chat). Sidecars move with their report into `sent/` /
  `failed/`; orphaned ones are swept after a day. Contract:
  `.claude/docs/report-blocks.md` §2.5.
- report_uploader: the exit code speaks only to service-level failure (no
  `BLAVE_PROXY_TOKEN`, drop dir uncreatable). A round that ran to completion is
  `rc=0` no matter what it processed — deferrals are a normal state (api
  briefly down, figure still being written, tick budget spent) and a permanent
  refusal is the producer's broken report being correctly archived, so exiting
  1 on either left `blave-agent-reports.service` sitting in `failed` and buried
  real faults in false ones (seen on 29026). Nothing is lost: the counts line
  reaches the journal on Linux and `logs\tasks.log` on Windows regardless of
  rc, and refusals/backoffs keep their durable records in
  `upload_errors.log` + `failed/` and `state/report_uploads.json`.
- performance_report: new — deterministic, zero-LLM daily/weekly performance
  reports. Hourly: samples account equity into
  `workspace/state/equity_history.jsonl` (same cadence and per-venue rules as
  the platform's `agent_equity_snapshot`) and drops `daily-YYYY-MM-DD` /
  `wk-YYYY-MM-DD` in the drop dir when the period they cover has ended. Reads
  disk products only (`manager/account.json`, `manager/last_reconcile.json`,
  `strategies/*/{state,stats}.json`) — never `workspace/lib/`, which may be
  arbitrarily old. Missing inputs cost blocks, not the report; mixed-currency
  accounts degrade rather than invent an fx rate.
- performance_report: the weekly risk grid now tags each metric with the
  contract's `metric_table.items[].format` — untagged items render neutral, so
  without it the signed ones (年化報酬, 最大回撤) lose their up/down colour.
  Needs an api that accepts the field (same release train as the rest of this
  section); an older api refuses the whole report with 400.
- report_uploader: a deeply nested report JSON is now refused into `failed/`
  instead of killing the run. `json.loads` raises `RecursionError` on it, which
  is a `RuntimeError` subclass and NOT a `ValueError`, so it went straight
  through `upload_one` → `run_once` → `main()` with `_save_state` never
  reached — and since `pending()` orders by mtime, oldest first, the poison file
  sorts first on every subsequent path/timer run, so one such file meant that
  machine never shipped another report until somebody SSH'd in and deleted it.
  Same widening on `_read_json` (the backoff state file) and on `_serialize`.
- report_uploader: a report file is size-checked before it is read. Anything
  past 4× `REPORT_MAX_BYTES` cannot serialize under the 2 MB ceiling anyway, and
  reading a multi-GB file out of the drop dir just to find that out would OOM
  the machine; it is refused into `failed/` unread.
- performance_report: non-finite numbers are gated everywhere they enter, not
  just type-checked. `_read_json` uses a bare `json.load`, which ACCEPTS the
  non-standard `NaN` / `Infinity` literals, so a venue reporting a broken equity
  reached `append_sample`'s `json.dumps(allow_nan=False)` and raised a
  `ValueError` that the surrounding `except OSError` did not catch — `main()`
  died in the sampling step and the daily/weekly reports were never produced at
  all. The same gate keeps a NaN backtest Sharpe out of the per-strategy table,
  where `f"{nan:.2f}"` had been rendering the string `nan` as if it were a
  number.
- performance_report: the daily and weekly builds now share ONE deadline,
  computed at the start of `main()`. Each used to anchor its own
  `time.time() + _BUDGET_S` at call time, so a Monday run could spend 60s + 60s
  plus sampling and blow through the unit's `TimeoutStartSec=120` — SIGKILL,
  state unsaved, the whole thing repeated the next hour.
- performance_report: a venue that reports no currency at all now degrades the
  equity series the same way a genuinely mixed-currency account does. It used to
  be dropped from the currency set and silently summed in with the known ones,
  which is exactly the invented fx rate this module refuses to produce. A
  machine where NO venue reports a currency still gets its chart, unlabelled.
- file_watcher: watches the reports drop dir (Windows stand-in for the new
  `blave-agent-reports.path`).
- report_uploader: a run woken by the drop-dir trigger now waits out the
  half-written-file quiet window (≤3s, on the same tick budget) and rescans
  once, instead of exiting empty-handed. The trigger fires milliseconds after
  the write, so every report was inside `QUIET_S` when the run started and
  systemd never re-triggers for events during a run — measured 148s from
  landing to upload, i.e. the path unit was a no-op for normal writes. The
  guard itself is untouched: a file still being written when the wait ends
  falls to the 2-minute timer as before, and a run with nothing new never
  sleeps. Same fix on Windows, where `file_watcher` runs the same script. A
  run that ships nothing now says what it saw ("inside the quiet window" /
  "half-written .tmp" / "backing off") — those were indistinguishable silent
  runs in the journal.
- performance_report: the daily/weekly equity `line_chart` now carries the
  account currency as the contract's `line_chart.y_unit` — apart from
  `drawdown` (the one chart whose unit the contract pins), the web cannot tell
  a % series from a USDT equity series, so omitting it printed the axis as bare
  numbers even though the same report's `kpi_row` was already labelling the
  equity "USDT" (seen on 29026). Only when the currency is known and fits the
  contract's 8-char limit: a longer string is dropped rather than truncated (a
  truncated ticker is a wrong unit, which is worse than none), and mixed
  currencies already drop the whole series upstream, so a chart that exists has
  exactly one currency or none at all. No other chart block gains a unit:
  `drawdown` is pinned by the contract and `heatmap` has no such field.
- jobs.json: `blave-agent-reports` (uploader, 2 min + path/dir trigger) and
  `blave-agent-perfreport` (hourly) on both Linux and Windows.

## 1.1.51

- strategy_reporter: the change watcher's live-strategy exemption now also
  covers strategies in the deployment registry (state/deployments.json,
  wait_for_bar/cron) — web-deployed strategies run with BLAVE_MODE=live and
  keep MODE="backtest" in the file, so per-bar stats.json rewrites were
  firing a ~0.5MB strategies chunk every bar, around the clock (uid=32321,
  116MB replay buffer). Registry read is fail-open.
- portfolio_reporter: strategy figures now carry `ran_at` (stats.json mtime).
  The workspace page uses it to judge "would a re-run help" — backtests run
  within 24h are never flagged stale, making holiday closures a non-issue
  (web fallback until this ships: weekday-lag rule, immune to weekends only).

## 1.1.50

- web_bridge: strategy change watcher — polls strategy_reporter.signature()
  every 3s so BYO-agent backtests reach the workspace in seconds instead of
  the 2-min reporter timer. (Recorded retroactively — shipped without a
  changelog entry; its draft-strategy blind spot is fixed in 1.1.51.)

## 1.1.49

- strategy_reporter: side-rail breathing dot now covers Type A/C in-process
  scheduler runs (previously only crontab entries were scanned).
