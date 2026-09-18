"""Retired: Blave Agent ships no built-in report. Every report is one the user
registered under `workspace/report_jobs/` (`.claude/docs/report-schedules.md`)
or asked for in a conversation.

This file is a tombstone, not a module. Machines that took 1.1.52–1.1.54 still
carry `blave-agent-perfreport.timer` (Linux) / the `blave-agent-perfreport`
scheduled task (Windows) firing this path hourly, and the release channel
cannot take them away: `control/updater.py` only installs and enables what
`jobs.json` lists — a unit that disappears from the manifest stays enabled
on the machine, and control/ does not update itself. Exiting 0 here keeps
those hourly fires silent instead of turning into an hourly `failed` unit.
Delete once the fleet's timer/task has been removed by hand
(`systemctl disable --now blave-agent-perfreport.timer` /
`Unregister-ScheduledTask blave-agent-perfreport`).
"""
if __name__ == "__main__":
    raise SystemExit(0)
