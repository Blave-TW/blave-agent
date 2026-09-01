# Runtime changelog

Queued-for-release state lives HERE, not in anyone's memory: any commit that
changes `runtime/` adds a line under **Unreleased** in the same commit. At
publish time, bump `VERSION`, move the Unreleased lines under the new version
heading, and ship — the file sits next to `VERSION` so the publisher cannot
miss it. (Channel rules: `.claude/docs/blave-agent-update-channels.md`.)

## Unreleased

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
