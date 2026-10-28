"""Windows: reading a state file while another process's os.replace swaps it (or Defender scans it)
raises PermissionError Errno 13 at open() (third interpreter round: lib/execute.load_state on
strategies/<name>/state.json, a bare json.load(open(path))). The reconciler, reporters and workers
read files other processes replace; those reads now wait the window out with the writer's delays
(lib/winreplace.load_json / read_retry; runtime/atomic_file's copy). POSIX keeps one read.

Simulates the PermissionError by patching builtins.open, so it runs on macOS/Linux too:
  ① lib/winreplace.load_json + read_retry: one PermissionError then the doc; every attempt →
    raises after len(delays)+1; FileNotFoundError / other errors at once; POSIX config → one try
  ② runtime/atomic_file.load_json + read_retry + read_bytes: the same contract
  ③ end to end through the readers that lost data or decisions (old code raised or fell back):
    load_state, list_inflight, halt_info, load_all_states, load_portfolio_config, the 統一
    duplicate-order guard, read_env, wait_for_bar's record, the reporter's _read_json, and two
    read-modify-writes that wiped the file (deployments.json, venue_account.json)
  ③b the read-modify-writes (venue_account ×2, deployments ×4, order_errors ×2): retries used up
    or a broken file → the file is left as it was (order_errors: a broken file is set aside as
    .corrupt and the new row lands)
  ③c money paths fail closed: 統一 tag book unreadable → send refused and today's tags kept;
    群益 login block unreadable → blocked; last-order marker unreadable → "an order just now"
    (broken → its mtime); relogin backoff read through the retry and re-read when still locked
  ③d the version mint: index.json still locked → the mint raises (the backtest fails, can be
    re-run); broken → set aside as .corrupt and rebuilt from the v<N>.json blobs, counter
    continuing from the highest N — never v1 written over a stored version
  ③e runtime capital_connect: an unreadable block counts as a 300 block (pw_wrong); re-entering
    the credentials sets a broken one aside
  ④ every read-mode open() / .read_text() / .read_bytes() in lib/ manager/ runtime/ either goes through the helper or is in
    EXEMPT, one row per read point with a category and a reason (a new bare read turns it red,
    so does a stale row)
  ⑤ half-updated workspace (no lib/winreplace.py, or one without load_json): every importer
    loads and still reads
  ⑥ the winreplace a lib module loads is lib/winreplace.py — never a same-named file earlier on
    sys.path (package import when imported as lib.<module>, lib/ as sys.path[0] as a script)
  ⑦ every function calling atomic_file / load_json / read_retry has it in scope (a lazily
    imported atomic_file once broke refresh_capacity.read_cost)

Run: cd blave-agent && python3 tests/check_state_read_retry.py
"""
import ast
import builtins
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = tempfile.mkdtemp(prefix="check-state-read-")
WS = os.path.join(BASE, "workspace")
for d in ("lib", "manager", "state/bar_wait", "state/execution/inflight", "strategies/s1"):
    os.makedirs(os.path.join(WS, d))
os.environ["BLAVE_AGENT_BASE"] = BASE
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = BASE
os.environ.pop("BLAVE_AGENT_LOCAL", None)
sys.path.insert(0, os.path.join(ROOT, "runtime"))
sys.path.insert(0, ROOT)
os.chdir(WS)

import atomic_file  # noqa: E402
import command_listener as cl  # noqa: E402
import portfolio_reporter as pr  # noqa: E402
from lib import capital_vault, execute, guard, order_president, portfolio, president_worker, venue_wiring, winreplace  # noqa: E402
from manager import wait_for_bar as wfb  # noqa: E402

EXEMPT_CATEGORIES = {
    "helper": "the retry helper's own open (called through read_retry / load_json) or the half-updated fallback",
    "code": "strategy / lib / manager source, docs, VERSION: text nobody swaps under a reader mid-round",
    "vault": "credentials / certificates: PermissionError there means this identity may not read it (ACL)",
    "env": ".env read by command_listener, its only replacer, or a read that fails loudly and is retried",
    "proc": "/proc pseudo-files (Linux only)",
    "append": "append-only logs (jsonl / text): never replaced, no swap window",
    "inplace": "written in place by one process, never replaced",
    "own": "written and read by the same process only",
    "worker": "a reader that already treats OSError as 'try again next tick'",
    "cache": "a cache or marker: a failed read only recomputes",
    "setting": "a text setting: a failed read uses the default for that one call, nothing is written back",
    "agent": "agent-time tooling: the error reaches the agent, who retries",
    "cloud": "cloud-only (Linux) paths: no Windows replace window",
    "failclosed": "a failed read already refuses / skips the round, and the next read retries",
}
# (file, function, the open's path argument, category, why) — one row per read point
EXEMPT = [
    ('lib/account_bitget.py', 'load_json', 'path',
     'helper', "the half-updated-workspace fallback (lib/winreplace.py without load_json)"),
    ('lib/account_bitget.py', '_read_lines', 'path',
     'helper', "the open read_retry wraps (state/audit.jsonl, _our_stop_legs)"),
    ('lib/account_capital.py', 'load_json', 'path',
     'helper', "the retry helper's own open, or the half-updated-workspace fallback"),
    ('lib/account_president.py', 'load_json', 'path',
     'helper', "the retry helper's own open, or the half-updated-workspace fallback"),
    ('lib/allocator.py', 'uses_window', 'path', 'code', 'allocator module source'),
    ('lib/capital_vault.py', '_read_text', 'path',
     'helper', "the retry helper's own open, or the half-updated-workspace fallback"),
    ('lib/capital_vault.py', 'load_json', 'path',
     'helper', "the retry helper's own open, or the half-updated-workspace fallback"),
    ('lib/capital_vault.py', 'resolve', 'VAULT',
     'vault', 'credential / cert: PermissionError means ACL and must surface at once'),
    ('lib/capital_worker.py', '_fail_and_exit', 'BACKOFF_PATH',
     'own', "the worker's own backoff counter, one worker"),
    ('lib/capital_worker.py', '_parse_env', 'os.path.join(WORKSPACE, ".env")',
     'failclosed', '.env at worker start (replaced by command_listener): a failed read writes an '
     'ok:false snapshot and exits, NSSM restarts it — one false disconnect, nothing traded'),
    ('lib/execute.py', 'load_json', 'path',
     'helper', "the retry helper's own open, or the half-updated-workspace fallback"),
    ('lib/execute.py', 'load_twap_log', 'log_path', 'append', 'append-only log, never replaced'),
    ('lib/guard.py', 'claim_close_all_pass', 'claimed',
     'own', 'renamed to a per-pid name first: no other process touches it'),
    ('lib/guard.py', 'load_json', 'path',
     'helper', "the retry helper's own open, or the half-updated-workspace fallback"),
    ('lib/costs.py', 'fee_of', 'path',
     'code', 'code / doc / VERSION text, not a state file'),
    ('lib/lint_export.py', '_load', 'os.path.join(DATA_DIR, name)',
     'agent', 'lint export data, agent-time tool'),
    ('lib/lint_export.py', 'main', 'argv[3]', 'agent', 'path from argv, agent-time tool'),
    ('lib/lint_export.py', 'selftest', 'os.path.join(folder, f)', 'agent', 'selftest fixtures'),
    ('lib/lint_export.py', 'write_meta', 'os.path.join(strat_dir, "strategy.py")',
     'code', 'code / doc / VERSION text, not a state file'),
    ('lib/notify.py', '_load_config', '_ALLOW_FROM_PATH',
     'cloud', 'OpenClaw config / Telegram allowFrom: cloud (Linux) only, no Windows replace window'),
    ('lib/notify.py', '_load_config', '_CONFIG_PATH',
     'cloud', 'OpenClaw config / Telegram allowFrom: cloud (Linux) only, no Windows replace window'),
    ('lib/notify.py', 'make_sender._send_photo', 'path', 'agent', 'an image file the caller made'),
    ('lib/notify.py', 'report_photo_web', 'path', 'agent', 'an image file the caller made'),
    ('lib/order_capital.py', 'load_json', 'path',
     'helper', "the retry helper's own open, or the half-updated-workspace fallback"),
    ('lib/order_paper.py', 'load_json', 'path',
     'helper', "the retry helper's own open, or the half-updated-workspace fallback"),
    ('lib/order_president.py', 'load_json', 'path',
     'helper', "the retry helper's own open, or the half-updated-workspace fallback"),
    ('lib/paper_data.py', '_read_text', 'path',
     'helper', "_cached's open, run inside read_retry (strategy.py and state.json)"),
    ('lib/paper_data.py', '_strategy_symbol', 'f"strategies/{name}/strategy.py"',
     'code', 'code / doc / VERSION text, not a state file'),
    ('lib/paper_data.py', 'legacy_tw_price', 'os.path.join(os.path.dirname(path), "strategy.py")',
     'code', 'code / doc / VERSION text, not a state file'),
    ('lib/paper_data.py', 'load_json', 'path',
     'helper', "the retry helper's own open, or the half-updated-workspace fallback"),
    ('lib/pnl.py', 'load_json', 'path',
     'helper', "the retry helper's own open, or the half-updated-workspace fallback"),
    ('lib/portfolio.py', '_fill_venues', '_ORDERS_LOG_PATH', 'append', 'append-only log, never replaced'),
    ('lib/portfolio.py', '_ledger_walk', '_ORDERS_LOG_PATH', 'append', 'append-only log, never replaced'),
    ('lib/portfolio.py', '_strategy_source', "f'strategies/{name}/strategy.py'",
     'code', 'code / doc / VERSION text, not a state file'),
    ('lib/portfolio.py', '_ui_event_due', '_UI_EVENT_STAMP_PATH',
     'inplace', 'state/ui_amounts_event, written in place'),
    ('lib/portfolio.py', 'load_json', 'path',
     'helper', "the retry helper's own open, or the half-updated-workspace fallback"),
    ('lib/president_quote.py', 'load_json', 'path',
     'helper', "the retry helper's own open, or the half-updated-workspace fallback"),
    ('lib/president_vault.py', '_pfx_readable', 'ca_path',
     'vault', 'credential / cert: PermissionError means ACL and must surface at once'),
    ('lib/president_vault.py', 'live', 'VAULT',
     'vault', 'credential / cert: PermissionError means ACL and must surface at once'),
    ('lib/president_vault.py', 'read_env', 'path or ENV_PATH',
     'failclosed', '.env (replaced by command_listener): OSError reaches the caller, which refuses'),
    ('lib/president_vault.py', 'resolve', 'VAULT',
     'vault', 'credential / cert: PermissionError means ACL and must surface at once'),
    ('lib/president_vault.py', 'stopped', 'STOP',
     'failclosed', 'login-stop record the worker replaces: unreadable reads as "UNKNOWN", the '
     'reconciler skips 統一 that round and reads it again the next'),
    ('lib/president_worker.py', '_backoff_state', 'BACKOFF_PATH',
     'own', "the worker's own backoff counter; a failed read is (0, 0, None): the worker keeps "
     "retrying with the shortest wait and does not stop on no-account strikes"),
    ('lib/president_worker.py', 'install', 'OUT_PATH',
     'worker', 'polls for the first snapshot; a failed read is `continue` until the deadline'),
    ('lib/president_worker.py', 'load_json', 'path',
     'helper', "the retry helper's own open, or the half-updated-workspace fallback"),
    ('lib/report.py', '_last_error', 'ERROR_LOG', 'append', 'append-only log, never replaced'),
    ('lib/report.py', '_ledger', 'LEDGER', 'append', 'append-only log, never replaced'),
    ('lib/report.py', '_machine_timezone', 'TIMEZONE_PATH',
     'setting', "state/timezone text; a miss is the caller's error message, agent-time"),
    ('lib/report.py', '_note_written', 'LEDGER', 'append', 'append-only log, never replaced'),
    ('lib/report.py', 'edit_report', 'os.path.join(home, report_id + ".json")',
     'agent', 'the report being edited / its source file, agent-time; errors reach the agent'),
    ('lib/report.py', 'edit_report', 'src',
     'agent', 'the report being edited / its source file, agent-time; errors reach the agent'),
    ('lib/report.py', 'list_schedules', 'os.path.join(d, "runs.jsonl")',
     'append', 'append-only log, never replaced'),
    ('lib/report.py', 'load_json', 'path',
     'helper', "the retry helper's own open, or the half-updated-workspace fallback"),
    ('lib/report.py', 'scheduled_agent_available', 'os.path.join(state, "turn_limits.json")',
     'cloud', 'returns before the read on the desktop; cloud is Linux'),
    ('lib/report_bricks.py', '_cached_pack', 'path', 'cache', 'pack cache, a miss rebuilds'),
    ('lib/report_templates.py', 'load_pack', 'path',
     'agent', 'kept pack, agent-time; the error tells the agent to rebuild'),
    ('lib/report_templates.py', 'load_recipe', 'os.path.join(os.path.dirname(os.path.abspath(run_py)), "recipe.json")',
     'agent', "the job's recipe.json, written once by the agent"),
    ('lib/runner.py', '_chart_refresh_due', 'path',
     'cache', 'chart manifest throttle, a miss rebuilds the chart'),
    ('lib/runner.py', '_drift_flag', 'path', 'cache', 'skip-rewrite check, a miss rewrites the same flag'),
    ('lib/runner.py', '_hold_backtest_lock', 'out_dir / BACKTEST_HOLDER',
     'own', 'holder note read only for the refusal message'),
    ('lib/runner.py', '_write_preview', 'path', 'cache', 'preview hash check, a miss drops the preview'),
    ('lib/runner.py', 'load_json', 'path',
     'helper', "the retry helper's own open, or the half-updated-workspace fallback"),
    ('lib/strategy.py', 'load_json', 'path',
     'helper', "the retry helper's own open, or the half-updated-workspace fallback"),
    ('lib/validation.py', 'load_json', 'path',
     'helper', "the retry helper's own open, or the half-updated-workspace fallback"),
    ('lib/venue.py', '_bound_ids', 'os.path.join(cl.WORKSPACE, ".env")',
     'env', '.env read by its only replacer, or a loud failure'),
    ('lib/venue_wiring.py', '_read_lines', 'path',
     'helper', "the retry helper's own open, or the half-updated-workspace fallback"),
    ('lib/venue_wiring.py', 'load_json', 'path',
     'helper', "the retry helper's own open, or the half-updated-workspace fallback"),
    ('lib/winreplace.py', '_load_json', 'path',
     'helper', "the retry helper's own open, or the half-updated-workspace fallback"),
    ('manager/alert_failure.py', 'alert', 'state_path',
     'own', 'per-strategy alert cooldown, written by this script'),
    ('manager/close_symbol.py', '_read_text', 'path', 'code', 'strategy source bytes'),
    ('manager/close_symbol.py', 'load_json', 'path',
     'helper', "the retry helper's own open, or the half-updated-workspace fallback"),
    ('manager/healthcheck.py', '_expect_minutes_from_strategy', 'f"strategies/{name}/strategy.py"',
     'code', 'code / doc / VERSION text, not a state file'),
    ('manager/healthcheck.py', 'load_json', 'path',
     'helper', "the retry helper's own open, or the half-updated-workspace fallback"),
    ('manager/manager.py', 'load_json', 'path',
     'helper', "the retry helper's own open, or the half-updated-workspace fallback"),
    ('manager/reconciler.py', '_load_outage', 'OUTAGE_PATH', 'own', "the reconciler's own outage record"),
    ('manager/reconciler.py', 'load_json', 'path',
     'helper', "the retry helper's own open, or the half-updated-workspace fallback"),
    ('manager/stop_strategy.py', 'halt_scopes', 'p', 'code', 'strategy sources scanned for scope names'),
    ('manager/stop_strategy.py', 'load_json', 'path',
     'helper', "the retry helper's own open, or the half-updated-workspace fallback"),
    ('manager/update_workspace.py', '_run', 'os.path.join(workspace, "manager", "reconciler.py")',
     'code', 'code / doc / VERSION text, not a state file'),
    ('manager/update_workspace.py', 'blob_sha', 'path',
     'code', 'workspace files hashed by the updater itself'),
    ('manager/update_workspace.py', 'read_version', 'path', 'code', 'VERSION file'),
    ('manager/update_workspace.py', 'same', 'a', 'code', 'file compare inside the updater'),
    ('manager/update_workspace.py', 'same', 'b', 'code', 'file compare inside the updater'),
    ('manager/wait_for_bar.py', '_lock_pids', 'lock_path', 'own', 'lock file pid list, best-effort'),
    ('manager/wait_for_bar.py', '_tw_futures_kind', 'f"strategies/{name}/strategy.py"',
     'code', 'code / doc / VERSION text, not a state file'),
    ('manager/wait_for_bar.py', '_tw_stock_minute', 'f"strategies/{name}/strategy.py"',
     'code', 'code / doc / VERSION text, not a state file'),
    ('manager/wait_for_bar.py', '_tw_fut_data', 'f"strategies/{name}/strategy.py"',
     'code', 'code / doc / VERSION text, not a state file'),
    ('manager/wait_for_bar.py', '_tw_stock_daily', 'f"strategies/{name}/strategy.py"',
     'code', 'code / doc / VERSION text, not a state file'),
    ('manager/wait_for_bar.py', '_us_stock_daily', 'f"strategies/{name}/strategy.py"',
     'code', 'code / doc / VERSION text, not a state file'),
    ('manager/wait_for_bar.py', 'load_json', 'path',
     'helper', "the retry helper's own open, or the half-updated-workspace fallback"),
    ('runtime/account_reader.py', '_read_env', 'path',
     'env', '.env, raises loudly; the reader retries next cycle'),
    ('runtime/agent_turn.py', '_bash_kind', 'os.path.join(workspace, path)',
     'code', 'a script the agent is about to run'),
    ('runtime/agent_turn.py', '_order_state', 'os.path.join(workspace, "lib", "guard.py")',
     'code', 'code / doc / VERSION text, not a state file'),
    ('runtime/agent_turn.py', '_portfolio_steps_block', 'path', 'code', 'reference doc text'),
    ('runtime/agent_turn.py', '_read_export', 'full', 'agent', 'an exported file the agent asked for'),
    ('runtime/agent_turn.py', 'load_agents_md', 'path', 'code', 'AGENTS.md'),
    ('runtime/agent_turn.py', 'preferences_rule', 'PREFERENCES_PATH',
     'setting', 'preferences.md text; a miss = no preferences line this turn, nothing written back'),
    ('runtime/agent_turn.py', 'version_restore_note', 'VERSION_EVENTS_PATH',
     'append', 'state/version_events.jsonl, append-only'),
    ('runtime/atomic_file.py', '_load_json', 'path',
     'helper', "the retry helper's own open, or the half-updated-workspace fallback"),
    ('runtime/atomic_file.py', '_read_bytes', 'path',
     'helper', "the retry helper's own open, or the half-updated-workspace fallback"),
    ('runtime/atomic_file.py', '_read_head', 'path',
     'helper', "the retry helper's own open, or the half-updated-workspace fallback"),
    ('runtime/capital_connect.py', '_cred_fp', '_paths()["env"]',
     'env', '.env read by its only replacer, or a loud failure'),
    ('runtime/capital_connect.py', '_env_has', '_paths()["env"]',
     'env', '.env read by its only replacer, or a loud failure'),
    ('runtime/capital_connect.py', '_write_vault', 'p["vault"]',
     'vault', 'credential / cert: PermissionError means ACL and must surface at once'),
    ('runtime/capital_connect.py', 'admin_password', 'os.path.join(WORKSPACE, ".env")',
     'env', '.env read by its only replacer, or a loud failure'),
    ('runtime/capital_connect.py', 'admin_password', 'p["admin_pw"]',
     'vault', 'credential / cert: PermissionError means ACL and must surface at once'),
    ('runtime/capital_connect.py', 'lib_supports_vault', 'os.path.join(lib, name)',
     'code', 'workspace lib source probe'),
    ('runtime/capital_connect.py', 'open_envelope', 'path', 'vault', 'credential envelope'),
    ('runtime/capital_connect.py', 'vehicle_import', 'os.path.join(stage, "meta.json")',
     'worker', 'vehicle stage meta written before the vehicle starts'),
    ('runtime/capital_connect.py', 'vehicle_import', 'pw_path',
     'vault', 'credential / cert: PermissionError means ACL and must surface at once'),
    ('runtime/capital_local.py', '_ensure_skcom', 'dst', 'code', 'SKCOM binaries / zip'),
    ('runtime/capital_local.py', '_ensure_skcom', 'z', 'code', 'SKCOM binaries / zip'),
    ('runtime/capital_local.py', '_env_values', '_paths()["env"]',
     'env', '.env read by its only replacer, or a loud failure'),
    ('runtime/capital_local.py', 'reap_orphan', 'p["pid"]', 'own', "pid file of this process's child"),
    ('runtime/codex_engine.py', '_mcp_name_taken', 'path', 'code', 'Codex config read once per spawn'),
    ('runtime/command_listener.py', '_boot_marker', '"/proc/sys/kernel/random/boot_id"',
     'proc', '/proc pseudo-file (Linux)'),
    ('runtime/command_listener.py', '_bound_venue', 'os.path.join(WORKSPACE, ".env")',
     'env', '.env read by its only replacer, or a loud failure'),
    ('runtime/command_listener.py', '_capital_admin_password', 'env_path',
     'vault', 'admin password file / .env for it'),
    ('runtime/command_listener.py', '_capital_admin_password', 'pw_path',
     'vault', 'credential / cert: PermissionError means ACL and must surface at once'),
    ('runtime/command_listener.py', '_cmd_close_all', 'flatten_path',
     'code', 'manager/flatten.py source probe'),
    ('runtime/command_listener.py', '_cmd_credentials', 'path',
     'env', 'the .env / manifest command_listener itself replaces (only writer)'),
    ('runtime/command_listener.py', '_cmd_credentials_remove', 'apath',
     'env', 'the .env / credentials.ui.json command_listener itself replaces (only writer)'),
    ('runtime/command_listener.py', '_cmd_credentials_remove', 'path',
     'env', 'the .env / credentials.ui.json command_listener itself replaces (only writer)'),
    ('runtime/command_listener.py', '_cmd_delete_strategy', 'os.path.join(WORKSPACE, ".env")',
     'env', '.env read by its only replacer, or a loud failure'),
    ('runtime/command_listener.py', '_cmd_delete_strategy', 'path', 'code', 'strategy source'),
    ('runtime/command_listener.py', '_downtime_read_stamp', 'DOWNTIME_WATCH',
     'own', "heartbeat/downtime_watch, this process's own stamp"),
    ('runtime/command_listener.py', '_env_flags', 'os.path.join(WORKSPACE, ".env")',
     'env', '.env read by its only replacer, or a loud failure'),
    ('runtime/command_listener.py', '_execution_engine_ready', 'os.path.join(WORKSPACE, "lib", "execute.py")',
     'code', 'code / doc / VERSION text, not a state file'),
    ('runtime/command_listener.py', '_file_is_version', 'os.path.join(WORKSPACE, script)',
     'code', 'a workspace script'),
    ('runtime/command_listener.py', '_log_tail', 'path', 'append', 'log tail'),
    ('runtime/command_listener.py', '_pid_cmdline', 'f"/proc/{pid}/cmdline"',
     'proc', '/proc pseudo-file (Linux)'),
    ('runtime/command_listener.py', '_read_boot_record', 'BOOT_RECORD',
     'own', "state/boot_id, this process's own record"),
    ('runtime/command_listener.py', '_read_text', 'path', 'helper', 'called through atomic_file.read_retry'),
    ('runtime/command_listener.py', '_reconciler_gated', 'os.path.join(WORKSPACE, "manager", "reconciler.py")',
     'code', 'code / doc / VERSION text, not a state file'),
    ('runtime/command_listener.py', '_record_version_event', 'VERSION_EVENTS_PATH',
     'append', 'state/version_events.jsonl, append-only'),
    ('runtime/command_listener.py', '_refresh_plan', 'os.path.join(WORKSPACE, "strategies", name, "strategy.py")',
     'code', 'code / doc / VERSION text, not a state file'),
    ('runtime/command_listener.py', '_require_manage_scripts', 'os.path.join(WORKSPACE, "manager", script)',
     'code', 'code / doc / VERSION text, not a state file'),
    ('runtime/command_listener.py', '_restart_reconciler', 'os.path.join(WORKSPACE, ".env")',
     'env', '.env read by its only replacer, or a loud failure'),
    ('runtime/command_listener.py', '_strategy_cadence', 'os.path.join(WORKSPACE, "strategies", name, "strategy.py")',
     'code', 'code / doc / VERSION text, not a state file'),
    ('runtime/command_listener.py', '_strategy_market_of', 'path', 'code', 'strategy source'),
    ('runtime/command_listener.py', '_strategy_source', 'os.path.join(WORKSPACE, "strategies", name, "strategy.py")',
     'code', 'code / doc / VERSION text, not a state file'),
    ('runtime/command_listener.py', '_strategy_source', 'path', 'code', 'strategy source'),
    ('runtime/command_listener.py', '_traded_on_a_real_venue', 'os.path.join(WORKSPACE, ".env")',
     'env', '.env read by its only replacer, or a loud failure'),
    ('runtime/command_listener.py', '_traded_on_a_real_venue', 'path',
     'append', 'manager/orders.jsonl, append-only'),
    ('runtime/command_listener.py', '_uptime_s', '"/proc/uptime"', 'proc', '/proc pseudo-file (Linux)'),
    ('runtime/command_listener.py', '_win_cadence', 'os.path.join(WORKSPACE, "strategies", name, "strategy.py")',
     'code', 'code / doc / VERSION text, not a state file'),
    ('runtime/command_listener.py', '_ws_lib_resets_by_account', 'os.path.join(WORKSPACE, "lib", "portfolio.py")',
     'code', 'code / doc / VERSION text, not a state file'),
    ('runtime/events.py', '_last_id', 'EVENTS_PATH',
     'append', 'events.jsonl: emitters append; rotate runs in the process that reads it'),
    ('runtime/events.py', 'load_acked', 'ACKED_PATH', 'own', 'events.acked, written by the same uploader'),
    ('runtime/events.py', 'rotate', 'EVENTS_PATH', 'append', 'events.jsonl, see _last_id'),
    ('runtime/events.py', 'unsent', 'EVENTS_PATH', 'append', 'events.jsonl, see _last_id'),
    ('runtime/kline_cache_heal.py', 'lib_generation', 'os.path.join(workspace, "lib", "data.py")',
     'code', 'code / doc / VERSION text, not a state file'),
    ('runtime/local_daemon.py', '__init__', 'os.path.join(os.path.dirname(os.path.abspath(__file__)), "VERSION")',
     'code', 'code / doc / VERSION text, not a state file'),
    ('runtime/local_daemon.py', '_orphan_pid', 'self._pid_path', 'own', 'pid file of this daemon'),
    ('runtime/local_daemon.py', 'strategy_kinds', 'src_path',
     'code', 'code / doc / VERSION text, not a state file'),
    ('runtime/model_prefs.py', 'get', 'PATH',
     'setting', 'model_prefs.json: one writer (set), a miss = default model for one spawn'),
    ('runtime/model_prefs.py', 'set', 'PATH',
     'setting', 'model_prefs.json read-modify-write by its only writer (an explicit switch); a '
     'broken file restarts from {} and drops other sessions\' model choices — low stakes'),
    ('runtime/portfolio_reporter.py', '_ac_interval', 'os.path.join(WORKSPACE, "strategies", name, "strategy.py")',
     'code', 'code / doc / VERSION text, not a state file'),
    ('runtime/portfolio_reporter.py', '_halt_denials', 'path', 'append', 'state/audit.jsonl, append-only'),
    ('runtime/portfolio_reporter.py', '_memory', '"/proc/meminfo"', 'proc', '/proc pseudo-file (Linux)'),
    ('runtime/portfolio_reporter.py', '_module_literals', 'path', 'code', 'workspace module source'),
    ('runtime/portfolio_reporter.py', '_read_lines', 'path',
     'helper', "the retry helper's own open, or the half-updated-workspace fallback"),
    ('runtime/portfolio_reporter.py', '_strategy_market', 'os.path.join(WORKSPACE, "strategies", name, "strategy.py")',
     'code', 'code / doc / VERSION text, not a state file'),
    ('runtime/portfolio_reporter.py', '_tw_stock_daily', 'os.path.join(WORKSPACE, "strategies", name, "strategy.py")',
     'code', 'code / doc / VERSION text, not a state file'),
    ('runtime/portfolio_reporter.py', '_uses_window', 'path', 'code', 'strategy source'),
    ('runtime/portfolio_reporter.py', '_workspace_has_downtime_pause', 'os.path.join(WORKSPACE, "lib", "portfolio.py")',
     'code', 'code / doc / VERSION text, not a state file'),
    ('runtime/portfolio_reporter.py', '_workspace_has_signal_gate', 'os.path.join(WORKSPACE, "lib", "portfolio.py")',
     'code', 'code / doc / VERSION text, not a state file'),
    ('runtime/portfolio_reporter.py', '_workspace_manages', 'os.path.join(WORKSPACE, "manager", script)',
     'code', 'code / doc / VERSION text, not a state file'),
    ('runtime/portfolio_reporter.py', '_ws_lib_contract_override', 'os.path.join(WORKSPACE, "lib", "paper_data.py")',
     'code', 'code / doc / VERSION text, not a state file'),
    ('runtime/portfolio_reporter.py', '_ws_lib_contract_override', 'os.path.join(WORKSPACE, "lib", "portfolio.py")',
     'code', 'code / doc / VERSION text, not a state file'),
    ('runtime/portfolio_reporter.py', '_ws_lib_halt_freeze', 'os.path.join(WORKSPACE, "lib", "guard.py")',
     'code', 'code / doc / VERSION text, not a state file'),
    ('runtime/portfolio_reporter.py', '_ws_lib_own_only', 'os.path.join(WORKSPACE, "lib", "portfolio.py")',
     'code', 'code / doc / VERSION text, not a state file'),
    ('runtime/portfolio_reporter.py', '_ws_lib_read_only_guard', 'os.path.join(WORKSPACE, "lib", "portfolio.py")',
     'code', 'code / doc / VERSION text, not a state file'),
    ('runtime/portfolio_reporter.py', '_ws_lib_rollover_halt_freeze', 'os.path.join(WORKSPACE, "lib", "portfolio.py")',
     'code', 'code / doc / VERSION text, not a state file'),
    ('runtime/portfolio_reporter.py', 'backtest_previews', 'os.path.join(d, "strategy.py")',
     'code', 'code / doc / VERSION text, not a state file'),
    ('runtime/portfolio_reporter.py', 'can_paper_twstock', 'os.path.join(WORKSPACE, "lib", "paper_data.py")',
     'code', 'code / doc / VERSION text, not a state file'),
    ('runtime/portfolio_reporter.py', 'can_paper_twstock', 'os.path.join(WORKSPACE, "lib", "portfolio.py")',
     'code', 'code / doc / VERSION text, not a state file'),
    ('runtime/portfolio_reporter.py', 'can_trade_portfolio', 'os.path.join(WORKSPACE, "lib", "portfolio.py")',
     'code', 'code / doc / VERSION text, not a state file'),
    ('runtime/portfolio_reporter.py', 'can_trade_portfolio', 'os.path.join(WORKSPACE, "lib", "runner.py")',
     'code', 'code / doc / VERSION text, not a state file'),
    ('runtime/portfolio_reporter.py', 'recent_orders', 'path', 'append', 'manager/orders.jsonl, append-only'),
    ('runtime/portfolio_reporter.py', 'script_knows_builtins', 'os.path.join(WORKSPACE, "manager", script)',
     'code', 'code / doc / VERSION text, not a state file'),
    ('runtime/portfolio_reporter.py', 'strategy_quote_ccy', 'path', 'code', 'strategy source'),
    ('runtime/portfolio_reporter.py', 'typec_previews', 'os.path.join(d, "strategy.py")',
     'code', 'code / doc / VERSION text, not a state file'),
    ('runtime/president_connect.py', '_env_urls_ok', 'os.path.join(WORKSPACE, ".env")',
     'env', '.env read by its only replacer, or a loud failure'),
    ('runtime/president_connect.py', '_local_cert', 'b["src"]', 'vault', 'certificate file'),
    ('runtime/president_connect.py', '_pick_local', 'path', 'vault', 'PSCCA certificate candidates'),
    ('runtime/president_connect.py', '_read_vault', '_paths()["vault"]',
     'vault', 'credential / cert: PermissionError means ACL and must surface at once'),
    ('runtime/president_connect.py', 'lib_supports_vault', 'path', 'code', 'workspace lib source probe'),
    ('runtime/president_connect.py', 'reap_orphan', 'self._pid_path()',
     'own', "pid file of this process's child"),
    ('runtime/reconciler_presence.py', '_proc_supervised', 'os.path.join(proc, str(pid), "cgroup")',
     'proc', '/proc pseudo-file (Linux)'),
    ('runtime/reconciler_presence.py', '_proc_supervised', 'os.path.join(proc, str(pid), "cmdline")',
     'proc', '/proc pseudo-file (Linux)'),
    ('runtime/reconciler_presence.py', '_proc_supervised', 'os.path.join(proc, str(pid), "stat")',
     'proc', '/proc pseudo-file (Linux)'),
    ('runtime/reconciler_presence.py', 'unsupervised_reconciler_pids', 'os.path.join(proc, d, "cmdline")',
     'proc', '/proc pseudo-file (Linux)'),
    ('runtime/refresh_capacity.py', 'available_memory_mb', '"/proc/meminfo"',
     'proc', '/proc pseudo-file (Linux)'),
    ('runtime/refresh_capacity.py', 'rss_mb', 'f"/proc/{proc.pid}/status"',
     'proc', '/proc pseudo-file (Linux)'),
    ('runtime/report_runner.py', '_append_run', 'path', 'append', 'runs.jsonl'),
    ('runtime/report_runner.py', '_is_close_job', 'os.path.join(jd, "run.py")',
     'code', 'code / doc / VERSION text, not a state file'),
    ('runtime/report_runner.py', '_last_line', 'path', 'append', 'log tail'),
    ('runtime/sched_pack.py', 'pack_call', 'os.path.join(jd, "run.py")',
     'code', 'code / doc / VERSION text, not a state file'),
    ('runtime/report_runner.py', '_published', 'marker', 'own', 'publish marker written by this runner'),
    ('runtime/report_runner.py', '_runs', 'os.path.join(jd, "runs.jsonl")',
     'append', 'append-only log, never replaced'),
    ('runtime/report_runner.py', 'check_upgrade', 'AVAIL_STATE_PATH',
     'own', "sched_agent_available, this runner's own state"),
    ('runtime/report_uploader.py', '_resolve_images', 'os.path.join(d, name)',
     'worker', 'report images; OSError already = skip this tick'),
    ('runtime/report_uploader.py', 'log_error', 'log_path', 'append', 'append-only log, never replaced'),
    ('runtime/report_uploader.py', 'upload_one', 'path',
     'worker', 'report file; OSError already = skip this tick'),
    ('runtime/sdk_pin.py', '_read_attr', 'path', 'code', 'SDK install files'),
    ('runtime/sdk_pin.py', 'add_dir', 'os.path.join(d, pth)', 'code', 'SDK .pth files'),
    ('runtime/sdk_pin.py', 'read_pin', 'path', 'code', 'SDK_VERSION pin'),
    ('runtime/sdk_sync.py', '_load_state', 'path',
     'own', 'sdk_sync.json, one writer and reader (the sdk job); module imports nothing else'),
    ('runtime/skill_sync.py', 'main', 'os.path.join(SKILL_DIR, "SKILL.md")',
     'code', 'code / doc / VERSION text, not a state file'),
    ('runtime/strategy_reporter.py', '_extract', 'path', 'code', 'strategy source'),
    ('runtime/strategy_reporter.py', '_preferences', 'PREFERENCES_PATH',
     'setting', 'preferences.md text, a miss = none this push'),
    ('runtime/strategy_reporter.py', '_read_source_id', 'path',
     'agent', 'agent-written source.json, any error = no file'),
    ('runtime/strategy_reporter.py', 'attach_images', '_IMG_SIG_PATH',
     'cache', 'image signature cache / image files, a miss re-uploads'),
    ('runtime/strategy_reporter.py', 'attach_images', 'p',
     'cache', 'image signature cache / image files, a miss re-uploads'),
    ('runtime/strategy_reporter.py', 'lib_restore_in_place', 'path', 'code', 'workspace lib source probe'),
    ('runtime/strategy_reporter.py', 'read_reply_lang_setting', 'REPLY_LANG_PATH',
     'setting', 'reply_lang text, a miss = default language for one call'),
    ('runtime/strategy_reporter.py', 'read_reply_lang_setting', 'REPLY_LANG_PATH',
     'setting', 'reply_lang text, a miss = default language for one call'),
    ('runtime/strategy_reporter.py', 'read_timezone', 'TIMEZONE_PATH',
     'setting', 'timezone text, a miss = default for one call'),
    ('runtime/strategy_reporter.py', 'sync_versions', 'path',
     'worker', 'version blob; OSError already = re-read next tick'),
    ('runtime/telegram_bridge.py', 'load_offset', 'OFFSET_PATH',
     'cloud', 'Telegram offset, cloud bridge only'),
    ('runtime/telegram_bridge.py', 'main', 'f"{_THIS_DIR}/VERSION"',
     'code', 'code / doc / VERSION text, not a state file'),
    ('runtime/telegram_pairing.py', '_drop_foreign_offset', 'OFFSET_PATH',
     'cloud', 'Telegram offset, cloud only'),
    ('runtime/telegram_pairing.py', '_read_once', 'path', 'cloud', 'pairing file, cloud only'),
    ('runtime/telegram_pairing.py', 'clear_notify_compat', 'OPENCLAW_JSON_PATH',
     'cloud', 'OpenClaw config, cloud only'),
    ('runtime/turn_stop.py', '_marker_stamps', 'os.path.join(MONEY_PID_DIR, str(pid))',
     'failclosed', 'money-process pid marker, written once in place by that process (lib/guard), '
     'never replaced; unreadable → no stamp → counted as a live money process, the turn stays held'),
    ('lib/quality_check.py', '_parse_for_runner', 'Path(filepath).read_text',
     'code', 'strategy source read as code, not a state file'),
    ('lib/quality_check.py', 'check', 'Path(filepath).read_text',
     'code', 'strategy source read as code, not a state file'),
    ('lib/runner.py', '_drift_flag', "Path(config['__file__']).read_bytes",
     'code', 'strategy source read as code, not a state file'),
    ('lib/runner.py', '_lookahead_source_hints', 'Path(path).read_text',
     'code', 'strategy source read as code, not a state file'),
    ('lib/runner.py', '_mint_version', 'Path(src_path).read_bytes',
     'code', 'strategy source read as code, not a state file'),
    ('lib/runner.py', '_run', "Path(config['__file__']).read_bytes",
     'code', 'strategy source read as code, not a state file'),
    ('lib/runner.py', '_superseded', "Path(config['__file__']).read_bytes",
     'code', 'strategy source read as code, not a state file'),
    ('lib/security_check.py', 'check', 'Path(filepath).read_text',
     'code', 'strategy source read as code, not a state file'),
    ('lib/strategy.py', 'restore', 'path.read_bytes',
     'code', 'strategy source read as code, not a state file'),
    ('lib/strategy.py', 'restore', 'path.read_bytes',
     'code', 'strategy source read as code, not a state file'),
    ('lib/portfolio.py', '_booked_park_ids', '_ORDERS_LOG_PATH',
     'append', 'manager/orders.jsonl: which parked orders the book already holds (append-only)'),
    ('lib/portfolio.py', '_machine_lang', "'state/reply_lang'",
     'setting', 'the reply language for the order-unconfirmed notice: a failed read keeps Chinese'),
    ('manager/flatten.py', '_flatten', 'os.path.join(_INFLIGHT_DIR, f)',
     'failclosed', 'inflight markers at the end of 全部平倉: an unreadable one is skipped, the run already warned per key'),
    ('lib/portfolio.py', '_filled_since', '_ORDERS_LOG_PATH',
     'append', 'manager/orders.jsonl: did a 全部平倉 row\'s in-flight order fill (append-only)'),
    ('lib/unconfirmed.py', 'load_json', 'path',
     'helper', "the half-updated-workspace fallback (lib/winreplace.py without load_json)"),
]

WIN = (0.05, 0.1, 0.2, 0.4, 0.5)
real_open, real_sleep = builtins.open, time.sleep
fails = []


def check(name, ok, got=None):
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok or got is None else f"  → {got!r}"))
    if not ok:
        fails.append(name)


class FlakyOpen:
    """builtins.open stand-in: read-mode opens of `target` raise `exc` the first `n` times."""

    def __init__(self, target, n, exc=PermissionError):
        self.target, self.n, self.exc, self.hits = os.path.realpath(target), n, exc, 0

    def __call__(self, file, mode="r", *a, **k):
        if (isinstance(file, (str, os.PathLike)) and not any(c in mode for c in "wax+")
                and os.path.realpath(file) == self.target):
            self.hits += 1
            if self.hits <= self.n:
                raise self.exc(13, "Permission denied", str(file))
        return real_open(file, mode, *a, **k)


LAST = {"hits": 0}


def check3(name, ok, got=None):
    """An end-to-end case counts only if the fault was injected and the read went again."""
    check(name, ok and LAST["hits"] >= 2, (got, f"opens of the target: {LAST['hits']}"))


def run(target, n, fn, delays=WIN, exc=PermissionError):
    """fn() with `target` flaky; (result, error, open attempts, sleeps)."""
    sleeps, flaky = [], FlakyOpen(target, n, exc)
    winreplace.REPLACE_RETRY_DELAYS = atomic_file.REPLACE_RETRY_DELAYS = delays
    builtins.open, time.sleep = flaky, sleeps.append
    out = err = None
    try:
        out = fn()
    except Exception as e:  # noqa: BLE001 — the error is the result under test
        err = e
    finally:
        builtins.open, time.sleep = real_open, real_sleep
    LAST["hits"] = flaky.hits
    return out, err, flaky.hits, sleeps


def _txt(path):
    try:
        with real_open(path, encoding="utf-8") as f:
            return f.read()
    except OSError:
        return None


def _js(path):
    try:
        return json.loads(_txt(path))
    except (TypeError, ValueError):
        return None


def put(rel, doc):
    path = os.path.join(WS, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with real_open(path, "w", encoding="utf-8") as f:
        f.write(doc if isinstance(doc, str) else json.dumps(doc))
    return path


try:
    # ── ① / ② the helpers' contract, both copies ──
    doc = put("state/x.json", {"a": 1})
    for label, mod in (("① lib/winreplace", winreplace), ("② runtime/atomic_file", atomic_file)):
        out, err, n, sl = run(doc, 1, lambda: mod.load_json(doc))
        check(f"{label}: one PermissionError → one wait, the doc", out == {"a": 1} and n == 2 and sl == [0.05],
              (out, err, n, sl))
        out, err, n, sl = run(doc, 99, lambda: mod.load_json(doc))
        check(f"{label}: never readable → PermissionError after len(delays)+1 tries, ~1.25 s",
              isinstance(err, PermissionError) and n == len(WIN) + 1 and abs(sum(sl) - 1.25) < 1e-9,
              (err, n, sl))
        out, err, n, sl = run(doc, 99, lambda: mod.load_json(doc), exc=FileNotFoundError)
        check(f"{label}: FileNotFoundError raises at once, no wait",
              isinstance(err, FileNotFoundError) and n == 1 and sl == [], (err, n, sl))
        out, err, n, sl = run(doc, 1, lambda: mod.load_json(doc), delays=())
        check(f"{label}: POSIX (no delays) → one attempt, error as before",
              isinstance(err, PermissionError) and n == 1 and sl == [], (err, n, sl))
        out, err, n, sl = run(doc, 1, lambda: mod.read_retry(lambda: real_open(doc).read()))
        check(f"{label}: read_retry retries the callable", out == '{"a": 1}' and len(sl) == 0,
              (out, err, sl))
    out, err, n, sl = run(doc, 1, lambda: atomic_file.read_bytes(doc))
    check("② atomic_file.read_bytes: one PermissionError → the bytes", out == b'{"a": 1}' and n == 2, (out, err))

    # ── ③ end to end ──
    st = put("strategies/s1/state.json", {"symbol": "BTCUSDT", "position": 0.5})
    out, err, n, sl = run(st, 1, lambda: execute.load_state("s1"))
    check3("③ execute.load_state survives a replace in flight", out == {"symbol": "BTCUSDT", "position": 0.5},
          (out, err))
    out, err, n, sl = run(st, 1, portfolio.load_all_states)
    check3("③ portfolio.load_all_states keeps the strategy (it would drop out of the round)",
          isinstance(out, dict) and out.get("s1", {}).get("position") == 0.5, (out, err))

    mk = put("state/execution/inflight/BTCUSDT.json", {"key": "BTCUSDT", "style": "twap"})
    out, err, n, sl = run(mk, 1, execute.list_inflight)
    check3("③ list_inflight still sees the running execution", out == [{"key": "BTCUSDT", "style": "twap"}],
          (out, err))

    halt = put("state/HALT", {"reason": "user stop", "source": "web"})
    out, err, n, sl = run(halt, 1, guard.halt_info)
    check3("③ guard.halt_info reads the real reason, not 'unreadable'",
          isinstance(out, dict) and out.get("reason") == "user stop", (out, err))

    cfg = put("manager/portfolio_config.json", {"account_value": 0, "amounts": {"s1": 100}, "weights": {},
                                                "exchanges": {"s1": "paper"}, "asset_specs": {}})
    out, err, n, sl = run(cfg, 1, portfolio.load_portfolio_config)
    check3("③ load_portfolio_config: the config, not a PermissionError out of the reconciler",
          isinstance(out, dict) and out.get("amounts") == {"s1": 100}, (type(out), err))

    today = order_president.datetime.now(order_president.TAIPEI).strftime("%Y-%m-%d")
    tags = put("state/president_order_tags.json", {"date": today, "tags": ["T1"]})
    order_president._TAGS_PATH = tags
    out, err, n, sl = run(tags, 1, order_president._tags_today)
    check3("③ 統一 duplicate guard still sees today's tags (empty = the guard is off)",
          out == (today, ["T1"], False), (out, err))

    env = put(".env", "OKX_API_KEY=k\nOKX_SECRET_KEY=s\n")
    out, err, n, sl = run(env, 1, lambda: venue_wiring.read_env(env))
    check3("③ venue_wiring.read_env: the keys, not {} (venue looks unbound)",
          out == {"OKX_API_KEY": "k", "OKX_SECRET_KEY": "s"}, (out, err))

    bw = put("state/bar_wait/s1.json", {"consecutive_failures": 3})
    out, err, n, sl = run(bw, 1, lambda: wfb._load_state("s1"))
    check3("③ wait_for_bar keeps its failure count (not reset to the default record)",
          isinstance(out, dict) and out.get("consecutive_failures") == 3, (out, err))

    out, err, n, sl = run(st, 1, lambda: pr._read_json(st))
    check3("③ portfolio_reporter._read_json: the state, not the default", out == {"symbol": "BTCUSDT", "position": 0.5},
          (out, err))

    deps = put("state/deployments.json", {"reconciler": {"cmd": "x"}, "capital_worker": {"cmd": "y"}})
    president_worker.DEPLOYMENTS_PATH = deps
    out, err, n, sl = run(deps, 1, lambda: president_worker._deployments(lambda d: d.setdefault("president_worker", {})))
    with real_open(deps) as f:
        after = json.load(f)
    check3("③ president_worker._deployments: a read in flight no longer wipes the other entries",
          set(after) == {"reconciler", "capital_worker", "president_worker"}, (after, err))

    blk = put("state/capital_block.json", {"fp": capital_vault.fingerprint("id", "pw"), "code": "602"})
    capital_vault.BLOCK = blk
    out, err, n, sl = run(blk, 1, lambda: capital_vault._read_block("id", "pw"))
    check3("③ 群益 login block still read (None = logins allowed again)",
           isinstance(out, dict) and out.get("code") == "602", (out, err))

    guard_path = put("state/venue_account.json", {"okx": {"account": "A1"}, "bind_reset": {"venue": "okx"}})
    cl._ACCOUNT_GUARD_PATH = guard_path
    out, err, n, sl = run(guard_path, 1, lambda: cl._mark_book_hold("okx", "book differs"))
    with real_open(guard_path) as f:
        after = json.load(f)
    check3("③ command_listener._mark_book_hold keeps the account-guard state it rewrites",
          after.get("okx") == {"account": "A1"} and after.get("bind_reset") == {"venue": "okx"}
          and after.get("book_hold", {}).get("venue") == "okx", (after, err))

    # ── ③b read-modify-writes: retries used up, or a broken file → nothing written back ──
    import capital_connect as cc  # noqa: E402
    put("strategies/s1/strategy.py", 'STRATEGY_NAME = "s1"\nINTERVAL = "1h"\n')
    deps_doc = {"reconciler": {"type": "daemon"}, "capital_worker": {"type": "daemon"}, "b1": {"type": "cron"}}
    vacct_doc = {"okx": {"account": "A1"}, "pending": {"okx": 1}, "bind_reset": {"venue": "bybit"}}
    real_trip = guard.trip_halt
    guard.trip_halt = lambda *a, **k: None
    cl._ACCOUNT_GUARD_PATH = os.path.join(WS, "state", "venue_account.json")
    RMW = (
        ("command_listener._mark_book_hold", "state/venue_account.json", vacct_doc,
         lambda: cl._mark_book_hold("okx", "book differs")),
        ("command_listener._mark_bind_account_change", "state/venue_account.json", vacct_doc,
         lambda: cl._mark_bind_account_change("okx", "account changed")),
        ("command_listener._sync_deployment_registry", "state/deployments.json", deps_doc,
         lambda: cl._sync_deployment_registry({"s1": 60})),
        ("command_listener._register_reconciler_deployment", "state/deployments.json",
         {k: v for k, v in deps_doc.items() if k != "reconciler"}, cl._register_reconciler_deployment),
        ("capital_connect._register_worker_deployment", "state/deployments.json",
         {k: v for k, v in deps_doc.items() if k != "capital_worker"}, cc._register_worker_deployment),
        ("president_worker._deployments", "state/deployments.json", deps_doc,
         lambda: president_worker._deployments(lambda d: d.setdefault("president_worker", {}))),
    )
    president_worker.DEPLOYMENTS_PATH = os.path.join(WS, "state", "deployments.json")
    for label, rel, doc0, fn in RMW:
        for case, content, n in (("retries used up", json.dumps(doc0), 99), ("broken JSON", '{"reconciler": {', 0)):
            path = put(rel, content)
            if os.path.exists(path + ".corrupt"):
                os.remove(path + ".corrupt")
            out, err, hits, sl = run(path, n, fn)
            with real_open(path, encoding="utf-8") as f:
                after = f.read()
            if case == "broken JSON" and rel == "state/deployments.json":
                # a broken registry would block every later registration: set aside, start over
                kept = real_open(path + ".corrupt").read() if os.path.exists(path + ".corrupt") else None
                try:
                    now_doc = json.loads(after)
                except ValueError:
                    now_doc = None
                check(f"③b {label}, broken JSON: set aside as .corrupt and written fresh",
                      kept == content and isinstance(now_doc, dict) and now_doc, (kept, after[:120], err))
                continue
            check(f"③b {label}, {case}: the file is left exactly as it was ({type(err).__name__ if err else 'no raise'})",
                  after == content, (after[:120], err))
    guard.trip_halt = real_trip
    for label, fn in (("portfolio._record_order_error", lambda: portfolio._record_order_error("BTCUSDT", "okx", "boom")),
                      ("command_listener._record_manual_close_row", lambda: cl._record_manual_close_row(["TX"]))):
        rows0 = json.dumps([{"ts": "t", "symbol": "ETHUSDT", "error": "old"}])
        path = put("manager/order_errors.json", rows0)
        out, err, hits, sl = run(path, 99, fn)
        with real_open(path) as f:
            after = f.read()
        check(f"③b {label}, retries used up: the five rows are not written away", after == rows0, (after, err))
        path = put("manager/order_errors.json", "[{broken")
        if os.path.exists(path + ".corrupt"):
            os.remove(path + ".corrupt")
        out, err, hits, sl = run(path, 0, fn)
        try:
            with real_open(path) as f:
                now_rows = json.load(f)
        except ValueError:
            now_rows = None
        kept = real_open(path + ".corrupt").read() if os.path.exists(path + ".corrupt") else None
        check(f"③b {label}, broken JSON: set aside as .corrupt, the new row still lands",
              kept == "[{broken" and isinstance(now_rows, list) and len(now_rows) == 1, (kept, now_rows, err))

    # ── ③c money paths fail closed when the read cannot be done ──
    today = order_president.datetime.now(order_president.TAIPEI).strftime("%Y-%m-%d")
    tags_path = order_president._TAGS_PATH
    put("state/president_order_tags.json", {"date": today, "tags": ["T1"]})
    out, err, hits, sl = run(tags_path, 99, order_president._tags_today)
    check("③c 統一 tag book locked: the send is refused with a plain-language reason (next round retries)",
          isinstance(err, order_president.PresidentError) and "下一輪" in str(err) and "next round" in str(err),
          (out, err))

    def guarded(tag, intent):
        def go():
            with order_president._tag_guard(tag, intent) as record:
                record()
        return go
    put("state/president_order_tags.json", '{"date": ')
    os.utime(tags_path, (time.time() - 2 * 86400,) * 2)
    if os.path.exists(tags_path + ".corrupt"):
        os.remove(tags_path + ".corrupt")
    out, err, hits, sl = run(tags_path, 0, guarded("E1", "entry"))
    book = _js(tags_path) or {}
    check("③c broken book written before today: set aside, today's entry goes out and is recorded",
          err is None and book.get("tags") == ["E1"] and _txt(tags_path + ".corrupt") == '{"date": ',
          (book, err))
    put("state/president_order_tags.json", '{"date": ')
    os.remove(tags_path + ".corrupt")
    out, err, hits, sl = run(tags_path, 0, guarded("E2", "entry"))
    book = _js(tags_path) or {}
    check("③c broken book written today: set aside, sealed for the day, the entry refused (plain-language reason)",
          isinstance(err, order_president.PresidentError) and "今天" in str(err) and "midnight" in str(err)
          and book == {"date": today, "tags": [], "sealed": True}
          and _txt(tags_path + ".corrupt") == '{"date": ', (err, book))
    out, err, hits, sl = run(tags_path, 0, guarded("E3", "entry"))
    check("③c sealed book: later entries that day are refused too (the earlier entry tags are gone)",
          isinstance(err, order_president.PresidentError) and "midnight" in str(err), (err,))
    out, err, hits, sl = run(tags_path, 0, guarded("C1", "reduce"))
    book = _js(tags_path) or {}
    check("③c sealed book: a close goes out and is recorded, the seal kept",
          err is None and book == {"date": today, "tags": ["C1"], "sealed": True}, (err, book))
    out, err, hits, sl = run(tags_path, 0, guarded("C1", "reduce"))
    check("③c sealed book: the same close tag again is refused as a duplicate",
          isinstance(err, order_president.DuplicateOrder), (err,))
    put("state/president_order_tags.json", {"date": "2000-01-01", "tags": [], "sealed": True})
    out, err, hits, sl = run(tags_path, 0, guarded("E4", "entry"))
    book = _js(tags_path) or {}
    check("③c a seal from an earlier day is gone: entries go out again",
          err is None and book == {"date": today, "tags": ["E4"]}, (err, book))

    # the seal must be on disk before the broken book is gone: a failed or interrupted seal
    # write leaves the broken book in place, so the next entry still meets the seal
    real_write_tags, real_copy = order_president._write_tags, order_president.shutil.copyfile

    class Killed(BaseException):
        pass

    def fail_write(_book):
        raise PermissionError(13, "tmp held by a scanner")

    def killed_write(_book):
        raise Killed()

    for case, stub, exc in (("the seal write fails", fail_write, order_president.PresidentError),
                            ("the process dies between the copy and the seal write", killed_write, Killed)):
        put("state/president_order_tags.json", '{"date": ')
        if os.path.exists(tags_path + ".corrupt"):
            os.remove(tags_path + ".corrupt")
        order_president._write_tags = stub
        try:
            guarded("S1", "entry")()
            err = None
        except BaseException as e:  # noqa: B902 — Killed stands in for the process dying
            err = e
        order_president._write_tags = real_write_tags
        check(f"③c {case}: the entry is not sent and the broken book is still in place",
              isinstance(err, exc) and _txt(tags_path) == '{"date": ', (err, _txt(tags_path)))
        out, err, hits, sl = run(tags_path, 0, guarded("S2", "entry"))
        book = _js(tags_path) or {}
        check(f"③c …{case}, the next entry that day: still refused by the seal, which now lands",
              isinstance(err, order_president.PresidentError) and "midnight" in str(err)
              and book == {"date": today, "tags": [], "sealed": True}, (err, book))

    put("state/president_order_tags.json", '{"date": ')
    order_president.shutil.copyfile = lambda *a, **k: fail_write(None)
    out, err, hits, sl = run(tags_path, 0, guarded("S3", "entry"))
    order_president.shutil.copyfile = real_copy
    check("③c the copy aside fails: refused as busy (next round), the broken book untouched",
          isinstance(err, order_president.PresidentError) and "next round" in str(err)
          and _txt(tags_path) == '{"date": ', (err, _txt(tags_path)))

    # record() runs after the broker took the order: nothing may raise out of it
    put("state/president_order_tags.json", {"date": today, "tags": ["R0"]})
    real_tt = order_president._tags_today
    err = None
    try:
        with order_president._tag_guard("R1", "entry") as record:
            order_president._tags_today = lambda: (_ for _ in ()).throw(PermissionError(13, "x"))
            record()
    except BaseException as e:  # noqa: B902
        err = e
    order_president._tags_today = real_tt
    book = _js(tags_path) or {}
    check("③c record() when the re-read raises a raw OSError: no exception, the tag is added to the ones read at the check",
          err is None and book.get("tags") == ["R0", "R1"], (err, book))
    err = None
    try:
        with order_president._tag_guard("R2", "entry") as record:
            order_president._write_tags = fail_write
            record()
    except BaseException as e:  # noqa: B902
        err = e
    order_president._write_tags = real_write_tags
    check("③c record() when the write fails: logged, no exception (the order is already out)",
          err is None and (_js(tags_path) or {}).get("tags") == ["R0", "R1"], (err, _js(tags_path)))
    put("state/president_order_tags.json", {"date": today, "tags": ["T1"]})

    def send_t2():
        with order_president._tag_guard("T2", "entry") as record:
            record()
    out, err, hits, sl = run(order_president._TAGS_PATH, 99, send_t2)
    book = _js(order_president._TAGS_PATH) or {}
    check("③c a send while the tag book is unreadable is refused and leaves today's tags as they were",
          isinstance(err, order_president.PresidentError) and book.get("tags") == ["T1"], (book, err))
    out, err, hits, sl = run(order_president._TAGS_PATH, 0, send_t2)
    book = _js(order_president._TAGS_PATH) or {}
    check("③c a readable book: the new tag is added after the earlier ones", book.get("tags") == ["T1", "T2"], (book, err))

    capital_vault.BLOCK = os.path.join(WS, "state", "capital_block.json")
    for case, content, n in (("retries used up", json.dumps({"fp": "other", "code": 300}), 99), ("broken JSON", "{", 0)):
        put("state/capital_block.json", content)
        out, err, hits, sl = run(capital_vault.BLOCK, n, lambda: capital_vault.login_blocked("id", "pw"))
        check(f"③c 群益 login block {case}: counts as a 300 block (the probe page reads 「重新輸入交易密碼」)",
              out == 300, (out, err))
    os.remove(capital_vault.BLOCK)
    out, err, hits, sl = run(capital_vault.BLOCK, 0, lambda: capital_vault.login_blocked("id", "pw"))
    check("③c 群益 login block absent: not blocked", out is None and err is None, (out, err))

    capital_vault.LAST_ORDER_PATH = os.path.join(WS, "state", "capital_last_order_at")
    capital_vault._last_order_mem = 0.0
    put("state/capital_last_order_at", "1000.0")
    t0 = time.time()
    out, err, hits, sl = run(capital_vault.LAST_ORDER_PATH, 99, capital_vault.last_order_at)
    check("③c 群益 last-order marker unreadable: treated as an order just now (the round waits), not 0",
          isinstance(out, float) and out >= t0 - 1, (out, err))
    put("state/capital_last_order_at", "not a number")
    os.utime(capital_vault.LAST_ORDER_PATH, (5000.0, 5000.0))
    out, err, hits, sl = run(capital_vault.LAST_ORDER_PATH, 0, capital_vault.last_order_at)
    check("③c 群益 last-order marker broken: its write time bounds the order (expires, never 0)", out == 5000.0, (out, err))
    os.remove(capital_vault.LAST_ORDER_PATH)
    out, err, hits, sl = run(capital_vault.LAST_ORDER_PATH, 0, capital_vault.last_order_at)
    check("③c 群益 last-order marker absent: 0", out == 0.0, (out, err))

    # P2-1: still locked past MARKER_UNREADABLE_MAX_S → a visible error, not a silent skip forever
    put("state/capital_last_order_at", "1000.0")
    capital_vault._marker_unreadable_since = None
    run(capital_vault.LAST_ORDER_PATH, 99, capital_vault.last_order_at)
    if hasattr(capital_vault, "_marker_unreadable_since") and capital_vault._marker_unreadable_since:
        capital_vault._marker_unreadable_since -= getattr(capital_vault, "MARKER_UNREADABLE_MAX_S", 300) + 1
    out, err, hits, sl = run(capital_vault.LAST_ORDER_PATH, 99, capital_vault.last_order_at)
    check("③c 群益 last-order marker locked for longer than the limit: raises (counted as a failed read), not 'now' forever",
          err is not None and "群益" in str(err), (out, err))
    out, err, hits, sl = run(capital_vault.LAST_ORDER_PATH, 0, capital_vault.last_order_at)
    check("③c …readable again: back to the marker's time", out == 1000.0 and err is None, (out, err))

    # P2-2: 統一 send markers
    from lib import president_vault  # noqa: E402
    order_president.LAST_ORDER_PATH = lo = os.path.join(WS, "state", "president_last_order_at.json")
    order_president._marker_unreadable_since = None
    lo_doc = json.dumps({"MXFK6": 1000.0, "TXFL6": 2000.0})
    put("state/president_last_order_at.json", lo_doc)
    t0 = time.time()
    out, err, hits, sl = run(lo, 99, lambda: order_president.last_order_at("MXFK6"))
    check("③c 統一 send markers locked: every contract counts as just sent (never 'caught up' blind)",
          isinstance(out, float) and out >= t0 - 1, (out, err))
    out, err, hits, sl = run(lo, 99, lambda: order_president._mark_order_sent("MXFK6"))
    check("③c 統一 _mark_order_sent with the markers locked: refuses the send, writes nothing",
          isinstance(err, order_president.PresidentError) and _txt(lo) == lo_doc, (err, _txt(lo)))
    put("state/president_last_order_at.json", "{")
    os.utime(lo, (5000.0, 5000.0))
    out, err, hits, sl = run(lo, 0, lambda: order_president.last_order_at("MXFK6"))
    check("③c 統一 send markers broken: their write time bounds every contract", out == 5000.0, (out, err))
    put("state/president_last_order_at.json", "{")
    out, err, hits, sl = run(lo, 0, lambda: order_president._mark_order_sent("MXFK6"))
    check("③c 統一 markers broken just now (inside a settle window): the send is refused, file untouched",
          isinstance(err, order_president.PresidentError) and _txt(lo) == "{", (err, _txt(lo)))
    os.utime(lo, (time.time() - 3600,) * 2)
    out, err, hits, sl = run(lo, 0, lambda: order_president._mark_order_sent("MXFK6"))
    after = _js(lo)
    check("③c 統一 markers broken long ago: every send they held has settled, started over with this one",
          err is None and isinstance(after, dict) and set(after) == {"MXFK6"}, (after, err))
    put("state/president_last_order_at.json", lo_doc)
    order_president._marker_unreadable_since = None
    run(lo, 99, order_president._last_orders)
    if getattr(order_president, "_marker_unreadable_since", None):
        order_president._marker_unreadable_since -= getattr(order_president, "MARKER_UNREADABLE_MAX_S", 300) + 1
    out, err, hits, sl = run(lo, 99, order_president.last_order_at)
    check("③c 統一 send markers locked for longer than the limit: raises, not 'just sent' forever",
          isinstance(err, order_president.PresidentError), (out, err))
    order_president._marker_unreadable_since = None

    # P2-6: spot scope
    sp = put("manager/spot_scope.json", ["OLDUSDT"])
    real_ss = portfolio.spot_symbols
    portfolio.spot_symbols = lambda: {"BTCUSDT"}
    out, err, hits, sl = run(sp, 99, lambda: portfolio.spot_scope(lambda s: 100.0))
    check("③c spot scope locked: the read fails (round skipped), not the old symbols dropped",
          isinstance(err, PermissionError) and _js(sp) == ["OLDUSDT"], (out, err))
    out, err, hits, sl = run(sp, 1, lambda: portfolio.spot_scope(lambda s: 100.0))
    check("③c spot scope read through a replace in flight keeps the previously managed symbol",
          isinstance(out, dict) and set(out) == {"BTCUSDT", "OLDUSDT"}, (out, err))
    put("manager/spot_scope.json", "[bro")
    out, err, hits, sl = run(sp, 0, lambda: portfolio.spot_scope(lambda s: 100.0))
    check("③c spot scope broken: set aside as .corrupt (not overwritten in place), targets kept",
          isinstance(out, dict) and set(out) == {"BTCUSDT"}
          and os.path.exists(sp + ".corrupt") and _txt(sp + ".corrupt") == "[bro", (out, err))
    portfolio.spot_symbols = real_ss
    psrc = real_open(os.path.join(ROOT, "lib", "portfolio.py"), encoding="utf-8").read()
    check("③c spot scope is written by replace, not truncated in place", "open(_SPOT_SCOPE_PATH, 'w')" not in psrc)

    from lib import order_capital as oc  # noqa: E402
    oc._RELOGIN_PATH = os.path.join(WS, "state", "capital_relogin.json")
    oc._shared_backoff = lambda: True
    until = time.time() + 120
    put("state/capital_relogin.json", {"n": 2, "until": until})
    oc._relogin.update(n=0, until=0.0, loaded=False)
    out, err, hits, sl = run(oc._RELOGIN_PATH, 1, oc._load_relogin)
    check3("③c 群益 relogin backoff (shared across order processes) read through a replace in flight",
           oc._relogin["n"] == 2 and abs(oc._relogin["until"] - until) < 1e-6, (dict(oc._relogin), err))
    oc._relogin.update(n=0, until=0.0, loaded=False)
    out, err, hits, sl = run(oc._RELOGIN_PATH, 99, oc._load_relogin)
    check("③c 群益 relogin backoff still unreadable: read again next time (not 'no backoff' for the process)",
          oc._relogin["loaded"] is False, dict(oc._relogin))

    # ── ③d version mint: an index it cannot read never restarts the counter over stored versions ──
    from pathlib import Path  # noqa: E402
    from lib import runner, strategy as lstrategy  # noqa: E402
    lstrategy._REPO_ROOT = Path(WS)
    vdir = os.path.join(WS, "strategies", "vs", "versions")
    os.makedirs(vdir)
    blobs = {}
    for n in (1, 2):
        blob = {"v": 1, "strategy": "vs", "n": n, "at": 100 * n, "note": f"n{n}", "code_hash": f"h{n}",
                "code": f"# v{n}\n", "daily_dates": [], "daily_returns": []}
        blobs[n] = put(f"strategies/vs/versions/v{n}.json", blob)
    blob_bytes = {n: real_open(p, "rb").read() for n, p in blobs.items()}
    index0 = json.dumps({"v": 1, "counter": 2, "current": 2,
                         "items": [{"n": 1, "code_hash": "h1"}, {"n": 2, "code_hash": "h2"}]})
    ipath = put("strategies/vs/versions/index.json", index0)
    cfg_vs = {"STRATEGY_NAME": "vs", "VERSION_NOTE": "third"}
    out, err, hits, sl = run(ipath, 99, lambda: runner._mint_version(cfg_vs, {}, "backtest", b"# v3\n"))
    check("③d index.json still locked: the mint raises (the backtest fails, can be run again) and writes nothing",
          isinstance(err, getattr(runner, "VersionIndexUnreadable", ())) and real_open(ipath).read() == index0
          and not os.path.exists(os.path.join(vdir, "v3.json")), (err, sorted(os.listdir(vdir))))
    put("strategies/vs/versions/index.json", "{broken")
    out, err, hits, sl = run(ipath, 0, lambda: runner._mint_version(cfg_vs, {}, "backtest", b"# v3\n"))
    idx = json.loads(real_open(ipath).read()) if os.path.exists(ipath) else {}
    corrupt = os.path.join(vdir, "index.json.corrupt")
    check("③d index.json broken: set aside, rebuilt from v1/v2, the new version is v3 (not v1 over the old one)",
          out == 3 and os.path.exists(corrupt) and real_open(corrupt).read() == "{broken"
          and [i.get("n") for i in idx.get("items", [])] == [1, 2, 3] and idx.get("counter") == 3
          and all(real_open(blobs[n], "rb").read() == blob_bytes[n] for n in blobs), (out, err, idx))
    src = real_open(os.path.join(ROOT, "lib", "runner.py"), encoding="utf-8").read()
    check("③d both backtest call sites let VersionIndexUnreadable through (every other mint error is only logged)",
          src.count("except VersionIndexUnreadable:\n                    raise") == 2)
    put("strategies/vs/versions/index.json", index0)
    out, err, hits, sl = run(ipath, 99, lambda: runner._index_readable_or_raise("vs"))
    check("③d index locked: checked before stats.json is written (the backtest writes nothing)",
          isinstance(err, getattr(runner, "VersionIndexUnreadable", ())), (out, err))
    check("③d both call sites run that check before _write_stats",
          src.count("_index_readable_or_raise(strategy_name)\n            _write_stats(out_dir, stats)") == 2)

    # ── ③e runtime capital_connect: an unreadable block is a block, shown as re-enter password ──
    cc_block = cc._paths()["block"]
    for case, content, n in (("retries used up", json.dumps({"fp": "x", "code": 307}), 99), ("broken JSON", "{", 0)):
        put(os.path.relpath(cc_block, WS), content)
        out, err, hits, sl = run(cc_block, n, cc.pw_blocked)
        check(f"③e capital_connect block {case}: blocked as 300 (pw_wrong, re-enter the password)",
              out == 300 and cc.CODE_STATES.get(out) == "pw_wrong", (out, err))
    os.remove(cc_block)
    out, err, hits, sl = run(cc_block, 0, cc.pw_blocked)
    check("③e capital_connect block absent: not blocked", out is None and err is None, (out, err))
    put(os.path.relpath(cc_block, WS), "{")
    out, err, hits, sl = run(cc_block, 0, lambda: cc.divert_credentials({"capital_api_key": "A", "capital_password": "p"}))
    check("③e re-entering the credentials sets a broken block aside (the next probe may log in once)",
          not os.path.exists(cc_block) and real_open(cc_block + ".corrupt").read() == "{" if os.path.exists(cc_block + ".corrupt")
          else False, (err, os.path.exists(cc_block)))

    # ── ④ every read-mode open in lib/ manager/ runtime/ goes through the helper or is exempted here ──
    from collections import Counter
    found = Counter()
    for d in ("lib", "manager", "runtime"):
        for dp, _, fs in os.walk(os.path.join(ROOT, d)):
            for fn_ in sorted(fs):
                if not fn_.endswith(".py"):
                    continue
                rel = os.path.relpath(os.path.join(dp, fn_), ROOT).replace(os.sep, "/")
                src = real_open(os.path.join(ROOT, rel), encoding="utf-8").read()

                def walk(node, func, src=src, rel=rel):
                    for ch in ast.iter_child_nodes(node):
                        f2 = func
                        if isinstance(ch, (ast.FunctionDef, ast.AsyncFunctionDef)):
                            f2 = ch.name if func == "<module>" else f"{func}.{ch.name}"
                        if (isinstance(ch, ast.Call) and isinstance(ch.func, ast.Name) and ch.func.id == "open"
                                and ch.args):
                            mode = ch.args[1].value if len(ch.args) > 1 and isinstance(ch.args[1], ast.Constant) else None
                            for k in ch.keywords:
                                if k.arg == "mode" and isinstance(k.value, ast.Constant):
                                    mode = k.value.value
                            if not (isinstance(mode, str) and any(c in mode for c in "wax+")):
                                found[(rel, f2, " ".join(ast.get_source_segment(src, ch.args[0]).split()))] += 1
                        if (isinstance(ch, ast.Call) and isinstance(ch.func, ast.Attribute)
                                and ch.func.attr in ("read_text", "read_bytes")
                                and not (isinstance(ch.func.value, ast.Name) and ch.func.value.id == "atomic_file")):
                            found[(rel, f2, " ".join(ast.get_source_segment(src, ch.func).split()))] += 1
                        walk(ch, f2)
                import warnings
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    walk(ast.parse(src), "<module>")
    exempt = Counter((f, fn_, a) for f, fn_, a, _c, _w in EXEMPT)
    unlisted = sorted(found - exempt)
    stale = sorted(exempt - found)
    check("④ no read-mode open outside the helper that is not exempted with a reason", not unlisted, unlisted)
    check("④ no stale exemption (each row is a read point that still exists)", not stale, stale)
    check("④ every exemption names a category and a reason",
          all(c in EXEMPT_CATEGORIES and w for *_x, c, w in EXEMPT), [r for r in EXEMPT if r[3] not in EXEMPT_CATEGORIES])

    # ── ⑤ half-updated workspace ──
    IMPORTERS = ("lib.execute", "lib.guard", "lib.portfolio", "lib.paper_data", "lib.order_paper",
                 "lib.order_president", "lib.account_president", "lib.account_capital", "lib.president_quote",
                 "lib.capital_vault", "lib.order_capital", "lib.strategy", "lib.report",
                 "lib.president_worker", "lib.runner", "lib.validation", "lib.pnl", "lib.venue_wiring",
                 "manager.reconciler", "manager.wait_for_bar", "manager.close_symbol",
                 "manager.healthcheck", "manager.stop_strategy")
    probe = (
        "import importlib, json, os, sys\n"
        "sys.path.insert(0, os.getcwd())\n"
        "bad = []\n"
        f"for m in {IMPORTERS!r}:\n"
        "    try:\n"
        "        importlib.import_module(m)\n"
        "    except Exception as e:\n"
        "        bad.append(f'{m}: {type(e).__name__}: {e}')\n"
        "os.makedirs('strategies/s1', exist_ok=True)\n"
        "json.dump({'position': 1}, open('strategies/s1/state.json', 'w'))\n"
        "from lib import execute\n"
        "if execute.load_state('s1') != {'position': 1}:\n"
        "    bad.append('load_state')\n"
        "print('BAD', bad)\n")
    for label, stub in (("no lib/winreplace.py", None),
                        ("lib/winreplace.py without load_json",
                         "import os\nREPLACE_RETRY_DELAYS = ()\n\n\ndef atomic_replace(src, dst):\n"
                         "    os.replace(src, dst)\n")):
        hw = os.path.join(BASE, "half-" + str(stub is None))
        for sub in ("lib", "manager"):
            shutil.copytree(os.path.join(ROOT, sub), os.path.join(hw, sub),
                            ignore=shutil.ignore_patterns("__pycache__"))
        os.remove(os.path.join(hw, "lib", "winreplace.py"))
        if stub:
            with real_open(os.path.join(hw, "lib", "winreplace.py"), "w") as f:
                f.write(stub)
        r = subprocess.run([sys.executable, "-c", probe], cwd=hw, capture_output=True, text=True, timeout=300)
        check(f"⑤ {label}: every importer loads, load_state still reads",
              r.returncode == 0 and "BAD []" in r.stdout, (r.returncode, r.stdout[-400:], r.stderr[-600:]))
    # ── ⑦ every function that calls the helper can see it (module-level or its own import) ──
    HELPER_NAMES = {"atomic_file", "load_json", "read_retry"}
    unbound = []
    for d in ("lib", "manager", "runtime"):
        for dp, _, fs in os.walk(os.path.join(ROOT, d)):
            for fn_ in sorted(fs):
                if not fn_.endswith(".py"):
                    continue
                rel = os.path.relpath(os.path.join(dp, fn_), ROOT).replace(os.sep, "/")
                import warnings
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    tree = ast.parse(real_open(os.path.join(ROOT, rel), encoding="utf-8").read())
                top = set()

                def collect(body, top=top):
                    for n in body:
                        if isinstance(n, (ast.Import, ast.ImportFrom)):
                            top.update((a.asname or a.name).split(".")[0] for a in n.names)
                        elif isinstance(n, (ast.FunctionDef, ast.ClassDef)):
                            top.add(n.name)
                        elif isinstance(n, (ast.Try, ast.If)):
                            collect(n.body)
                            collect(n.orelse)
                            for h in getattr(n, "handlers", []):
                                collect(h.body)
                collect(tree.body)
                for fnode in ast.walk(tree):
                    if not isinstance(fnode, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        continue
                    local = {(a.asname or a.name).split(".")[0] for n in ast.walk(fnode)
                             if isinstance(n, (ast.Import, ast.ImportFrom)) for a in n.names}
                    local |= {a.arg for a in fnode.args.args}
                    used = {n.id for n in ast.walk(fnode) if isinstance(n, ast.Name)
                            and isinstance(n.ctx, ast.Load) and n.id in HELPER_NAMES}
                    unbound += [f"{rel}:{fnode.name}:{u}" for u in sorted(used - top - local)]
    check("⑦ no function calls atomic_file / load_json / read_retry without it in scope", not unbound, unbound)

    # ── ⑥ which winreplace gets loaded: never a same-named file elsewhere on sys.path ──
    plant = os.path.join(BASE, "plant")
    os.makedirs(plant)
    with real_open(os.path.join(plant, "winreplace.py"), "w") as f:
        f.write("REPLACE_RETRY_DELAYS = ()\nPLANTED = True\n\n\ndef atomic_replace(s, d):\n    raise SystemExit('planted')\n\n\n"
                "def load_json(p, **k):\n    raise SystemExit('planted')\n\n\ndef read_retry(r, *a, **k):\n"
                "    raise SystemExit('planted')\n")
    MODS = ("capital_vault", "president_quote", "president_worker", "capital_worker", "president_vault",
            "account_president", "account_capital")
    probe = (
        "import importlib, sys\n"
        f"sys.path[:0] = [{plant!r}, {ROOT!r}]\n"
        "bad = []\n"
        f"for m in {MODS!r}:\n"
        "    mod = importlib.import_module('lib.' + m)\n"
        "    for name in ('atomic_replace', 'load_json', 'read_retry'):\n"
        "        fn = getattr(mod, name, None)\n"
        "        if fn is not None and getattr(fn, '__module__', '') == 'winreplace':\n"
        "            bad.append(f'{m}.{name}')\n"
        "print('BAD', bad, 'winreplace' in sys.modules)\n")
    r = subprocess.run([sys.executable, "-c", probe], cwd=plant, capture_output=True, text=True, timeout=300)
    check("⑥ imported as lib.<module>: lib/winreplace.py is used, a winreplace.py elsewhere on sys.path is not",
          r.returncode == 0 and "BAD [] False" in r.stdout, (r.returncode, r.stdout[-300:], r.stderr[-400:]))
    probe2 = (
        "import importlib, os, sys\n"
        f"sys.path[:0] = [{os.path.join(ROOT, 'lib')!r}, {plant!r}]\n"
        "import capital_vault, winreplace\n"
        f"print('FILE', os.path.realpath(winreplace.__file__) == os.path.realpath({os.path.join(ROOT, 'lib', 'winreplace.py')!r}))\n")
    r = subprocess.run([sys.executable, "-c", probe2], cwd=plant, capture_output=True, text=True, timeout=300)
    check("⑥ run as a script (lib/ is sys.path[0]): the winreplace loaded is lib/winreplace.py",
          r.returncode == 0 and "FILE True" in r.stdout, (r.returncode, r.stdout[-300:], r.stderr[-400:]))
finally:
    builtins.open, time.sleep = real_open, real_sleep
    os.chdir(ROOT)
    shutil.rmtree(BASE, ignore_errors=True)

print()
print("ALL PASS" if not fails else f"{len(fails)} FAILED: {fails}")
sys.exit(1 if fails else 0)
