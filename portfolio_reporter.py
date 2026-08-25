"""
Portfolio reporter: ships the machine's portfolio state to the Blave backend
(POST /openclaw/agent/portfolio) so the workspace's 投資組合 view can render
without a VM round-trip — the same report/read split strategy_reporter.py uses.

What it collects, and why each piece has to come from here:
  - manager/portfolio_config.json  weights / leverage / capital / exchange routing
  - strategies/<n>/state.json      each strategy's live signal + when it last moved
  - crontab                        whether a strategy is actually SCHEDULED; a
                                   weighted strategy with no cron trades on a
                                   frozen signal and nothing else notices
  - manager/last_reconcile.json    the only record of real exchange positions
                                   (written by lib/portfolio.reconcile)
  - manager/orders.jsonl           what was actually sent to the exchange
  - manager/account.json           live equity/positions per venue, written by
                                   account_reader.py — read as JSON, never
                                   executed; a broken account module shows up
                                   as that file's "error" field, not as this
                                   report dying
  - state/heartbeat/reconciler     is the auto-trader alive

VM auth = proxy-{ttyd_password} (BLAVE_PROXY_TOKEN), same trust model as the
chat transport and strategy_reporter: the token resolves to this user only.
"""
import ast
import json
import os
import platform
import re
import statistics
import subprocess
import sys
import time
import urllib.request

WORKSPACE = os.environ.get("BLAVE_AGENT_WORKSPACE", "/opt/blave-agent/workspace")
# The workspace has its own state/ — NOT the runtime's /opt/blave-agent/state.
# reconciler.py touches `state/heartbeat/reconciler` and lib/guard.py writes
# `state/HALT`, both relative to the workspace they run in. Reading the runtime
# dir instead silently reports every machine as "reconciler dead".
WORKSPACE_STATE = os.path.join(WORKSPACE, "state")
API_URL = os.environ.get(
    "BLAVE_PORTFOLIO_URL", "https://api.blave.org/openclaw/agent/portfolio"
)
PROXY_TOKEN = os.environ.get("BLAVE_PROXY_TOKEN", "")

ORDERS_TAIL = 20  # 最近下單只給一屏的量,orders.jsonl 會一直長
HEARTBEAT_STALE_S = 300  # reconciler 每 5 秒 touch 一次;超過這個就當它死了


def _read_json(path, default=None):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def _mtime(path):
    try:
        return int(os.path.getmtime(path))
    except OSError:
        return None


def scheduled_strategies():
    """Names with a live schedule — crontab (Linux) or schtasks (Windows).

    A weighted strategy with no schedule is the quiet failure this whole view
    exists to surface: state.json never updates, so the reconciler keeps sizing
    a real position from a signal that stopped moving days ago. Returns None
    (not an empty set) when the schedule can't be read, so the UI can say
    "unknown" instead of accusing every strategy of being unscheduled.
    """
    if platform.system() == "Windows":
        # deployment.md's task-name convention: blaveclaw-strategy-<name>
        try:
            out = subprocess.run(
                ["schtasks", "/query", "/fo", "csv", "/nh"],
                capture_output=True, text=True, timeout=30,
            )
        except (OSError, subprocess.SubprocessError):
            return None
        if out.returncode != 0:
            return None
        # both task families count as "scheduled": agent-made
        # blaveclaw-strategy-* and the web picker's blave-web-strategy-*
        # (command_listener's schtasks twin of the tagged cron lines)
        return set(re.findall(r"blaveclaw-strategy-([^\",]+)", out.stdout)) | \
            set(re.findall(r"blave-web-strategy-([^\",]+)", out.stdout))
    try:
        out = subprocess.run(
            ["crontab", "-l"], capture_output=True, text=True, timeout=10
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        return set() if "no crontab" in (out.stderr or "").lower() else None
    return set(re.findall(r"run_strategy\.sh\s+(\S+)", out.stdout))


_MARKET_RE = re.compile(r'^\s*MARKET\s*=\s*["\']([a-z]+)["\']', re.M)


def _strategy_market(name):
    """strategy.py 的 MARKET 常數(swap|spot)。沒宣告=swap——與現況一致
    (全機隊實測過的下單路徑只有 USDT 本位合約),UI 要靠它標示錢包。"""
    try:
        with open(os.path.join(WORKSPACE, "strategies", name, "strategy.py"),
                  encoding="utf-8", errors="replace") as f:
            m = _MARKET_RE.search(f.read())
        return m.group(1) if m else "swap"
    except OSError:
        return "swap"


def strategy_states():
    """{name: {symbol, position, market, updated_at}} from strategies/*/state.json."""
    root = os.path.join(WORKSPACE, "strategies")
    states = {}
    try:
        entries = sorted(os.listdir(root))
    except OSError:
        return states
    for name in entries:
        path = os.path.join(root, name, "state.json")
        data = _read_json(path)
        if not isinstance(data, dict):
            continue
        states[name] = {
            "symbol": data.get("symbol"),
            "position": data.get("position", 0),
            "market": _strategy_market(name),
            "updated_at": _mtime(path),
        }
    return states


def recent_orders():
    path = os.path.join(WORKSPACE, "manager", "orders.jsonl")
    try:
        with open(path) as f:
            lines = f.readlines()[-ORDERS_TAIL:]
    except OSError:
        return []
    out = []
    for line in lines:
        try:
            out.append(json.loads(line))
        except ValueError:
            continue
    return out


# Case-insensitive: the web writes uppercase ({ID}_API_KEY), but shipped
# integrations are not consistent — sinopac_api_key is lowercase — and a venue
# the scan misses is invisible to the workspace page (no readiness, no
# finish-the-integration prompt).
# No value requirement and no value capture: an empty `FOO_API_KEY=` still
# counts as a venue (matching command_listener / account_reader — the account
# read then fails VISIBLY instead of the venue silently vanishing), and the
# key's value must never sit in a match group waiting for a debug print.
# PASSWORD/PASSPHRASE joined SECRET_KEY 2026-08-14 to mirror command_listener's
# _venue_cred_ids fix (audit B6): Capital's pair shape is {ID}_API_KEY +
# {ID}_PASSWORD, which this regex used to miss entirely, so venues() always
# reported `pair: false` for a venue the reconciler already treats as bound
# (web papers over that with a manual-venue workaround, see cxSpec below).
# No crypto CX_VENUES entry uses a lone _PASSWORD as its secret field (all use
# _SECRET_KEY / _PASSPHRASE — web/app/main/templates/agent/workspace.html
# CX_VENUES, checked 2026-08-14), so this can't newly mispair any of those.
_ENV_CRED_RE = re.compile(
    r"^\s*([A-Za-z0-9_]+)_(API_KEY|SECRET_KEY|PASSWORD|PASSPHRASE)\s*=", re.IGNORECASE
)
# blave_api_key / blave_secret_key are the platform's own data-API credentials
# (written at first boot), not an exchange — never report "blave" as a venue.
_RESERVED_PREFIXES = {"BLAVE"}


def venues():
    """{venue_id: {credentials, pair, order, account}} discovered from the workspace .env.

    Scanning .env for `{PREFIX}_API_KEY` rather than keeping a fixed venue list
    here mirrors how the credentials get written in the first place: the web
    modal's cxSlug() derives the exact same {SLUG}_API_KEY / _SECRET_KEY /
    _PASSPHRASE names for a free-typed "other exchange", so this picks those up
    too without a second list to keep in sync with CX_VENUES.

    `order`/`account` mirror whether lib/order_{id}.py / lib/account_{id}.py
    ship on this machine — that is what actually lets the venue trade or read
    equity; storing the key is necessary but not sufficient for either.

    `pair` is the bound-venue rule (API_KEY + one of SECRET_KEY / PASSWORD /
    PASSPHRASE under the same ID — command_listener._venue_cred_ids'
    definition): only paired entries count as a bound venue. Single-key
    entries stay reported (pair: false) so a half-entered integration still
    shows up and its account-read failure is visible instead of the venue
    silently vanishing.
    """
    path = os.path.join(WORKSPACE, ".env")
    try:
        with open(path) as f:
            lines = f.readlines()
    except OSError:
        return {}
    lib_root = os.path.join(WORKSPACE, "lib")
    suffixes = {}
    for line in lines:
        m = _ENV_CRED_RE.match(line)
        if m and m.group(1).upper() not in _RESERVED_PREFIXES:
            suffixes.setdefault(m.group(1).lower(), set()).add(m.group(2).upper())
    out = {}
    for venue_id, sfx in suffixes.items():
        if "API_KEY" not in sfx:
            continue  # secret-only orphan: not an entry, same as before
        out[venue_id] = {
            "credentials": True,
            "pair": bool(sfx & {"SECRET_KEY", "PASSWORD", "PASSPHRASE"}),
            "order": os.path.isfile(os.path.join(lib_root, f"order_{venue_id}.py")),
            "account": os.path.isfile(os.path.join(lib_root, f"account_{venue_id}.py")),
        }
    return out


def _fresh(ts, window=HEARTBEAT_STALE_S):
    return bool(ts and (time.time() - ts) < window)


def halt_state():
    """Kill-switch state, read the same way lib/guard.py writes it: the FILE'S
    EXISTENCE is authoritative and unreadable content still counts as halted."""
    path = os.path.join(WORKSPACE_STATE, "HALT")
    if not os.path.exists(path):
        return {"halted": False}
    info = _read_json(path, {}) or {}
    return {
        "halted": True,
        "at": info.get("ts"),
        "reason": info.get("reason"),
        "source": info.get("source"),
        "blocked": _halt_denials(info.get("ts")),
    }


def _halt_denials(since_ts):
    """How many orders the halt has refused since it was tripped.

    state/audit.jsonl is append-only and fsynced per line (lib/guard.py), so a
    tail is enough — the file can grow, and the whole point is a recent count.
    """
    path = os.path.join(WORKSPACE_STATE, "audit.jsonl")
    try:
        with open(path) as f:
            lines = f.readlines()[-500:]
    except OSError:
        return None
    n = 0
    for line in lines:
        try:
            row = json.loads(line)
        except ValueError:
            continue
        # Event name comes from lib/order_*.py, which is what actually refuses
        # the order — guard.py only writes halt_tripped / halt_cleared.
        if row.get("event") != "order_denied_halt":
            continue
        # ISO-8601 UTC on both sides, so string comparison is chronological.
        if not since_ts or str(row.get("ts", "")) >= str(since_ts):
            n += 1
    return n


# ── 策略管理(工作頁 投資組合 › 策略管理)──────────────────────────────────────
# Read side of command_listener's manage_* commands. Every piece is guarded on
# its own: a torn stats.json or a syntax error in a user's allocator must cost
# that one entry, never the report. `can_manage` keys on the workspace scripts
# themselves (see _workspace_manages) — this runtime updates itself from S3 but
# manager/*.py rides blaveclaw-config's manual channel, so a new runtime on an
# old workspace is the normal state, not an edge case.

# The two per-day arrays the walk-forward writes for its own PNG; the page
# charts managed_cum + random_benchmark.band instead, so these only add bytes.
_MGMT_STATS_DROP = ("weights_history", "managed_returns")
_ALLOCATOR_CONSTS = ("DISPLAY_NAME", "DESCRIPTION", "PARAMS")
# {path: (mtime, size, entry|None)} — a stats.json can be several MB (trades +
# candles) and this runs every report; only a changed file is parsed again.
_STRATEGY_FIGURES_CACHE = {}


def _strategy_figures(name, path):
    """One strategy's picker figures, None when the file isn't a backtest
    (same membership rule as lib/pnl.load_all_stats: non-empty
    daily_returns). Annualised return/vol are not in stats.json, so they are
    computed from the daily series (sample std, matching pandas' default)."""
    data = _read_json(path)
    if not isinstance(data, dict) or not data.get("daily_returns"):
        return None
    try:
        rets = [float(v) for v in data["daily_returns"]]
        dates = data.get("daily_dates") or []
        ann_ret = statistics.fmean(rets) * 365 * 100 if rets else None
        ann_vol = statistics.stdev(rets) * 365 ** 0.5 * 100 if len(rets) > 1 else None
        return {
            "name": name,
            "days": len(dates) if dates else len(rets),
            "first_date": dates[0] if dates else None,
            "last_date": dates[-1] if dates else None,
            "ann_return_pct": None if ann_ret is None else round(ann_ret, 2),
            "ann_vol_pct": None if ann_vol is None else round(ann_vol, 2),
            "sharpe": _num(data.get("Sharpe Ratio")),
            "mdd_pct": _num(data.get("Max Drawdown [%]")),
        }
    except (TypeError, ValueError, IndexError):
        return None


def _manager_strategies():
    root = os.path.join(WORKSPACE, "strategies")
    try:
        entries = sorted(os.listdir(root))
    except OSError:
        return []
    out = []
    seen = set()
    for name in entries:
        path = os.path.join(root, name, "stats.json")
        try:
            st = os.stat(path)
        except OSError:
            continue
        seen.add(path)
        cached = _STRATEGY_FIGURES_CACHE.get(path)
        if cached and cached[0] == st.st_mtime and cached[1] == st.st_size:
            entry = cached[2]
        else:
            entry = _strategy_figures(name, path)
            _STRATEGY_FIGURES_CACHE[path] = (st.st_mtime, st.st_size, entry)
        if entry:
            out.append(dict(entry))
    for path in list(_STRATEGY_FIGURES_CACHE):
        if path not in seen:
            _STRATEGY_FIGURES_CACHE.pop(path, None)  # deleted strategy; pop: concurrent reports
    return out


def _num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return round(f, 4) if f == f else None


def _allocators():
    """allocators/<name>/allocator.py consts via ast — the file is user code
    and is never imported here. A dir whose file is missing or doesn't parse
    is skipped; a const that isn't a literal (or is absent) falls back —
    DISPLAY_NAME to the dir name, DESCRIPTION to "", PARAMS to {}."""
    root = os.path.join(WORKSPACE, "allocators")
    try:
        entries = sorted(os.listdir(root))
    except OSError:
        return []
    out = []
    for name in entries:
        if name.startswith(".") or name == "__pycache__":
            continue
        path = os.path.join(root, name, "allocator.py")
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                tree = ast.parse(f.read())
        except (OSError, SyntaxError, ValueError):
            continue
        consts = {}
        for node in tree.body:
            if not isinstance(node, ast.Assign) or len(node.targets) != 1:
                continue
            target = node.targets[0]
            if not isinstance(target, ast.Name) or target.id not in _ALLOCATOR_CONSTS:
                continue
            try:
                consts[target.id] = ast.literal_eval(node.value)
            except (ValueError, TypeError, SyntaxError, MemoryError, RecursionError):
                continue
        params = consts.get("PARAMS")
        if not isinstance(params, dict):
            params = {}
        try:
            json.dumps(params)  # a literal set/bytes/tuple-key would sink the whole report
        except (TypeError, ValueError):
            params = {}
        out.append({
            "name": name,
            "display_name": str(consts.get("DISPLAY_NAME") or name),
            "description": str(consts.get("DESCRIPTION") or ""),
            "params": params,
        })
    return out


def _mgmt_backtest_job():
    """manager/mgmt_job.json + the live progress file, or None."""
    root = os.path.join(WORKSPACE, "manager")
    job = _read_json(os.path.join(root, "mgmt_job.json"))
    if not isinstance(job, dict):
        return None
    job = dict(job)
    job["progress"] = None
    if job.get("status") == "running":  # a finished job's file is just the last tick
        prog = _read_json(os.path.join(root, "mgmt_progress.json"))
        if isinstance(prog, dict):
            job["progress"] = {"day": prog.get("day"), "total": prog.get("total")}
    return job


def _mgmt_backtest_result(job):
    """<output>/stats.json only for a finished job, and only when the file
    is that job's own output: same members (order-free), allocator and
    lookback, and a computed_at no earlier than the job's start. A running run's file is still the
    PREVIOUS result (the script writes it atomically at the end), and an
    agent running the script by hand later would otherwise have its numbers
    shown under the web's job parameters."""
    if not job or job.get("status") != "done":
        return None
    output = job.get("output")
    # The listener writes this as "manager" or "allocators/<name>"; anything
    # else (hand-edited job file) is not followed.
    if (not isinstance(output, str) or not output or os.path.isabs(output)
            or ".." in output.replace("\\", "/").split("/")):
        return None
    stats = _read_json(os.path.join(WORKSPACE, output, "stats.json"))
    if not isinstance(stats, dict):
        return None
    # same rule as command_listener._mgmt_result_matches
    try:
        ours = (sorted(stats.get("members") or []) == sorted(job.get("members") or [])
                and stats.get("allocator") == job.get("allocator")
                and (stats.get("params") or {}).get("lookback")
                == (job.get("params") or {}).get("lookback")
                and float(stats.get("computed_at")) >= float(job.get("started_at") or 0))
    except (TypeError, ValueError, AttributeError):
        return None
    if not ours:
        return None
    return {k: v for k, v in stats.items() if k not in _MGMT_STATS_DROP}


def manager_view():
    view = {"can_manage": _workspace_manages(), "strategies": [], "allocators": [],
            "proposal": None, "backtest_job": None, "backtest": None}
    for key, fn in (("strategies", _manager_strategies),
                    ("allocators", _allocators),
                    ("backtest_job", _mgmt_backtest_job)):
        try:
            view[key] = fn()
        except Exception as e:  # noqa: BLE001 — this block must never sink the report
            print(f"[portfolio_reporter] manager.{key} failed: {type(e).__name__}",
                  file=sys.stderr)
    try:
        view["backtest"] = _mgmt_backtest_result(view["backtest_job"])
    except Exception as e:  # noqa: BLE001
        print(f"[portfolio_reporter] manager.backtest failed: {type(e).__name__}",
              file=sys.stderr)
    proposal = _read_json(os.path.join(WORKSPACE, "manager", "proposal.json"))
    view["proposal"] = proposal if isinstance(proposal, dict) else None
    return view


def build_report():
    cfg = _read_json(os.path.join(WORKSPACE, "manager", "portfolio_config.json"), {})
    hb = _mtime(os.path.join(WORKSPACE_STATE, "heartbeat", "reconciler"))
    last = _read_json(os.path.join(WORKSPACE, "manager", "last_reconcile.json"))
    sched = scheduled_strategies()

    return {
        "config": cfg,
        "states": strategy_states(),
        # None = couldn't tell (no crontab access), [] = genuinely nothing scheduled
        "scheduled": None if sched is None else sorted(sched),
        "last_reconcile": last,
        # account_reader.py's output verbatim (None until its first run).
        # {read_at, venues: {id: {ok, equity, currency, positions, holdings,
        # flows, error}}} — `flows` (external deposit/withdraw rolling window,
        # absent on libs without get_flows) rides along for the platform's
        # dual-track PnL ingest; no reporter change, shipped as-is.
        "account": _read_json(os.path.join(WORKSPACE, "manager", "account.json")),
        # newest-last order failures (lib/portfolio._record_order_error) — the
        # page must show a failed order, not sit silently on an empty 實際欄
        "order_errors": _read_json(os.path.join(WORKSPACE, "manager", "order_errors.json"), []),
        "orders": recent_orders(),
        "reconciler": {
            "heartbeat_at": hb,
            "alive": _fresh(hb),
        },
        # Whether the stop button will work at all. A listener that died leaves
        # a button that looks fine and does nothing — the page disables it
        # instead of letting the user believe they stopped trading.
        "command_listener": {
            "alive": _fresh(
                _mtime(os.path.join(WORKSPACE_STATE, "heartbeat", "command_listener"))
            )
        },
        # Halted and not-running are different facts and must not collapse into
        # one "not trading" line: one the user did on purpose, the other is a
        # fault. `blocked` turns "stopped" from a claim into something visible —
        # it is the count of orders the switch actually refused.
        "halt": halt_state(),
        # id not present in the dict = no key stored for it. Front end reads
        # this as venues[id] (web/.../workspace.html cxSupport()) — id present
        # with order/account both false = key saved, modules not built yet.
        "venues": venues(),
        # capability signals: the web hides controls the machine can't honor —
        # without this the 「暫停並全部平倉」 button halts only and LOOKS
        # successful. can_flatten keys on the actual artifact (flatten.py in
        # the workspace), which is also exactly the listener's own check —
        # true on any OS/generation whose workspace has the close-all layer.
        "platform": platform.system(),
        "can_flatten": os.path.isfile(os.path.join(WORKSPACE, "manager", "flatten.py")),
        # self_ledger: whether this machine diffs against the bot's own book
        # (portfolio_config.json flag) — the web's stop dialog phrases what
        # 「關閉 bot 部位」actually closes from this (bot's book only vs the
        # whole account on a pre-feature machine).
        "self_ledger": bool((_read_json(
            os.path.join(WORKSPACE, "manager", "portfolio_config.json"), {}) or {}
        ).get("self_ledger")),
        # can_wait_start: whether the workspace's reconcile path understands
        # state/signal_gate.json (the 「啟動,等新訊號才進場」 option) — keyed
        # on the actual artifact like can_flatten, so the web never offers a
        # start mode the machine would silently ignore (an old workspace
        # ignoring the gate degrades resume_wait to a full catch-up resume).
        "can_wait_start": _workspace_has_signal_gate(),
        # 策略管理 subtab: member figures, allocators, the last proposal and
        # the walk-forward job/result (see manager_view). can_manage keys the
        # web's 「機器尚未更新」 fallback exactly like can_flatten/can_wait_start.
        "manager": manager_view(),
        "reported_at": int(time.time()),
    }


def _workspace_has_signal_gate():
    # Bytes, not text — same reason as _workspace_manages: the workspace files
    # are UTF-8 with CJK comments and the Windows fleet's default text encoding
    # (cp950) either raises mid-read or mojibakes them, and a DBCS lead byte
    # eating the next ASCII one makes the search silently miss. Do not "tidy"
    # this back into open()/str.
    try:
        with open(os.path.join(WORKSPACE, "lib", "portfolio.py"), "rb") as f:
            return b"signal_gate" in f.read()
    except OSError:
        return False


def _workspace_manages():
    """Whether both manager scripts take the flags the listener sends. One is
    the optimise (manager.py), the other the walk-forward
    (management_backtest.py); on a half-updated workspace one of the two
    buttons would still die on argparse, so either one missing is a no.
    Unreadable counts as a no — offering the control is the costly mistake.
    Read as bytes: these files are UTF-8 with CJK comments and Windows' default
    text encoding would raise on them."""
    for script in ("manager.py", "management_backtest.py"):
        try:
            with open(os.path.join(WORKSPACE, "manager", script), "rb") as f:
                if b"--members" not in f.read():
                    return False
        except OSError:
            return False
    return True


def report(payload, token=None):
    token = token or PROXY_TOKEN
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        API_URL,
        data=data,
        headers={"Content-Type": "application/json", "x-api-key": f"proxy-{token}"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.read().decode()


def main():
    if not PROXY_TOKEN:
        print("[portfolio_reporter] BLAVE_PROXY_TOKEN not set; exiting", file=sys.stderr)
        sys.exit(1)
    payload = build_report()
    try:
        resp = report(payload)
        print(f"[portfolio_reporter] reported: {resp}", file=sys.stderr)
    except Exception as e:
        print(f"[portfolio_reporter] report failed: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
