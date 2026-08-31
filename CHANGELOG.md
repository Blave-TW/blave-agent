# Runtime changelog

Queued-for-release state lives HERE, not in anyone's memory: any commit that
changes `runtime/` adds a line under **Unreleased** in the same commit. At
publish time, bump `VERSION`, move the Unreleased lines under the new version
heading, and ship — the file sits next to `VERSION` so the publisher cannot
miss it. (Channel rules: `.claude/docs/blave-agent-update-channels.md`.)

## Unreleased

- portfolio_reporter: strategy figures now carry `ran_at` (stats.json mtime).
  The workspace page uses it to judge "would a re-run help" — backtests run
  within 24h are never flagged stale, making holiday closures a non-issue
  (web fallback until this ships: weekday-lag rule, immune to weekends only).

## 1.1.49

- strategy_reporter: side-rail breathing dot now covers Type A/C in-process
  scheduler runs (previously only crontab entries were scanned).
