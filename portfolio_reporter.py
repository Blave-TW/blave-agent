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

# The walk-forward's own per-day return series: the page charts managed_cum
# (the cumulative form of the same numbers) and random_benchmark.band, so this
# one only adds bytes. weights_history stays — the page's weight pane draws it.
_MGMT_STATS_DROP = ("managed_returns",)
# Ceiling on weights_history (members x OOS days). stats.json is a file the
# agent can rewrite, and _mgmt_backtest_result is a passthrough — the whole
# report rides one POST with a 4MB hard cap (openclaw/agent_strategies.py
# PORTFOLIO_MAX_BYTES), and a 413 there is TERMINAL: report() raises, main()
# exits 1, and the next timer tick re-sends the identical payload forever
# while the user's whole portfolio view sits on a stale cache. 64 members
# (command_listener._MANAGE_MAX_MEMBERS) x 3000 days at the script's own 4dp
# is ~1.3MB; the same shape with full float repr is ~3.8MB and blows the cap
# on this field alone. So bound it HERE rather than trusting the producer to
# keep rounding. Dropping the field costs nothing: the page's mgWeightSeries
# returns null on a missing/short array and simply omits the pane.
_MGMT_WEIGHTS_MAX_POINTS = 64 * 4000
_ALLOCATOR_CONSTS = ("DISPLAY_NAME", "DESCRIPTION", "PARAMS")
# manager.py's own declarations, read as literals (never imported).
_BUILTIN_CONSTS = ("BUILTIN_METHODS", "DEFAULT_METHOD")
# Mirrors blaveclaw-config lib/allocator.py RESERVED_PARAM_KEYS: target_vol is
# the portfolio's leverage target, set once for the account and never a
# weighting input, so load() refuses a file that declares it. That guard lives
# in an import this process never does — without the same check here the picker
# would show the field and the run would die on selection.
# `lookback` is deliberately NOT in this tuple: a method that fits on a window
# owns that window and declares it like any other knob (built-in slope does),
# and the page offers it. Only a method that declares it gets to receive one.
_RESERVED_PARAM_KEYS = ("target_vol",)
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


def _module_literals(path, names):
    """Module-level `name = <literal>` assignments from a workspace .py, via
    ast — the file is never imported (it is user/agent-editable code, and this
    process must not run any of it). Absent file, syntax error or a value that
    isn't a literal simply doesn't appear in the result. Shared by the
    allocator picker and the built-in method read, which want the same thing
    off two different files.

    None when the file can't be read or parsed at all — distinct from {},
    which means it parsed and declared none of `names`: the allocator picker
    skips an unreadable file but still lists one that simply declares nothing.
    """
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            tree = ast.parse(f.read())
    except (OSError, SyntaxError, ValueError, MemoryError, RecursionError):
        # same tuple as the literal_eval below: deeply nested source can take
        # the parse out too, and workspace_builtin_methods runs OUTSIDE
        # manager_view's per-key guard — an escape from here would cost the
        # whole report, i.e. the machine reads as dead on the web
        return None
    out = {}
    for node in tree.body:
        if not isinstance(node, ast.Assign) or len(node.targets) != 1:
            continue
        target = node.targets[0]
        if not isinstance(target, ast.Name) or target.id not in names:
            continue
        try:
            out[target.id] = ast.literal_eval(node.value)
        except (ValueError, TypeError, SyntaxError, MemoryError, RecursionError):
            continue
    return out


def _json_safe_params(params):
    """A declared PARAMS dict as the report may carry it: a literal set / bytes
    / tuple key would sink the whole payload at json.dumps time."""
    if not isinstance(params, dict):
        return {}
    try:
        json.dumps(params)
    except (TypeError, ValueError):
        return {}
    return params


_NOTICE_STATE = os.path.join(WORKSPACE_STATE, "reporter_notices.json")
_NOTICE_EVERY_S = 86400
_NOTICE_KEEP_S = 7 * _NOTICE_EVERY_S


def _notice_daily(key, msg):
    """Say `msg` at most once a day per `key`.

    An in-process guard would do nothing here: main() is a fresh process every
    two minutes (jobs.json), so a per-round print is ~720 identical lines a day
    in journald for one misnamed directory. A state file is the only place a
    "last said at" survives the process.

    Best-effort both ways — an unreadable state file prints (a repeat beats
    silence), a failed write may repeat next round; neither may cost the
    report. Entries older than a week are dropped so the file can't grow with
    names that no longer exist.

    stderr is the wrong audience — the only person who can act on this is the
    USER, and they never see journald. The wording is written for them anyway:
    the real fix is a report field the page renders, and this is the text it
    should carry.
    """
    now = time.time()
    seen = _read_json(_NOTICE_STATE, {})
    if not isinstance(seen, dict):
        seen = {}
    last = seen.get(key)
    if isinstance(last, (int, float)) and 0 <= now - last < _NOTICE_EVERY_S:
        return
    print(f"[portfolio_reporter] {msg}", file=sys.stderr)
    seen[key] = int(now)
    seen = {k: v for k, v in seen.items()
            if isinstance(v, (int, float)) and now - v < _NOTICE_KEEP_S}
    try:
        os.makedirs(os.path.dirname(_NOTICE_STATE), exist_ok=True)
        tmp = _NOTICE_STATE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(seen, f)
        os.replace(tmp, _NOTICE_STATE)
    except OSError:
        pass


def _uses_window(path):
    """allocate() refers to its second argument somewhere in its body — the
    syntactic tell for "this method looks at history". Mirrors
    lib/allocator.uses_window; pure ast, the file is never imported."""
    try:
        with open(path, "rb") as f:
            tree = ast.parse(f.read())
    except (OSError, SyntaxError, ValueError, MemoryError, RecursionError):
        return False
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == "allocate":
            params = [a.arg for a in node.args.posonlyargs + node.args.args]
            if len(params) < 2:
                return False
            window = params[1]
            return any(isinstance(n, ast.Name) and n.id == window
                       for n in ast.walk(node) if n is not node)
    return False


def _allocators():
    """allocators/<name>/allocator.py consts via ast — the file is user code
    and is never imported here. A dir whose file is missing or doesn't parse
    is skipped; a const that isn't a literal (or is absent) falls back —
    DISPLAY_NAME to the dir name, DESCRIPTION to "", PARAMS to {}.
    Two skips beyond that, both for the same reason — an entry the machine
    would refuse to run must not be offered:
      * a dir named after one of THIS workspace's built-in methods, which
        lib/allocator.load refuses to load (it would also show a second
        「等權」 in the picker). Only on a workspace that HAS built-ins: on an
        older one there is no reserved-name guard at all, so allocators/equal/
        is an ordinary user method — and the name was the obvious one to pick
        back when equal wasn't built in.
      * a file declaring a reserved PARAMS key — see _RESERVED_PARAM_KEYS.
    Both are logged: the file is still on disk and only a rename/edit fixes
    it, which the user can't do if nothing ever says so."""
    root = os.path.join(WORKSPACE, "allocators")
    try:
        entries = sorted(os.listdir(root))
    except OSError:
        return []
    shadowed = builtin_method_params()  # {} on a workspace without built-ins
    out = []
    for name in entries:
        if name.startswith(".") or name == "__pycache__":
            continue
        if name in shadowed:
            _notice_daily(f"shadowed:{name}",
                          f"allocators/{name}/ is shadowed by the built-in method "
                          f"of that name and can no longer run — rename the directory")
            continue
        consts = _module_literals(os.path.join(root, name, "allocator.py"),
                                  _ALLOCATOR_CONSTS)
        if consts is None:
            continue
        declared = consts.get("PARAMS")
        # on the RAW declaration, before _json_safe_params: a reserved key
        # whose value isn't JSON-safe would otherwise be sanitized away into
        # an empty dict and the file would sail through the check that exists
        # to keep it out
        clash = [k for k in _RESERVED_PARAM_KEYS
                 if isinstance(declared, dict) and k in declared]
        if clash:
            _notice_daily(f"reserved_params:{name}",
                          f"allocators/{name}/ declares reserved PARAMS {clash} — "
                          f"lib/allocator.load refuses it, so it is not offered")
            continue
        # Same rule as lib/allocator.load's window guard: a method that reads
        # its window argument must declare PARAMS["lookback"], or the scripts
        # hand it no window and it fits on nothing — or worse, on everything.
        # Offering it would put a method in the picker that dies on selection.
        if (_uses_window(os.path.join(root, name, "allocator.py"))
                and not (isinstance(declared, dict) and "lookback" in declared)):
            _notice_daily(f"undeclared_window:{name}",
                          f"allocators/{name}/ reads its window but declares no literal "
                          f"PARAMS['lookback'] — PARAMS must be a plain dict literal with "
                          f"\"lookback\": <days>; until then it is not offered")
            continue
        # A declared window the page could never send: the listener holds
        # lookback to an integer 10–5000, and the page copies the declared
        # value into the field as-is — so anything outside that would be an
        # entry that dies on every click. Keep it off the page and say why.
        lb = declared.get("lookback") if isinstance(declared, dict) else None
        if "lookback" in (declared or {}) and (
                isinstance(lb, bool) or not isinstance(lb, int) or not 10 <= lb <= 5000):
            _notice_daily(f"bad_window:{name}",
                          f"allocators/{name}/ declares PARAMS['lookback'] = {lb!r}; "
                          f"it must be an integer 10–5000 days — not offered until fixed")
            continue
        out.append({
            "name": name,
            "display_name": str(consts.get("DISPLAY_NAME") or name),
            "description": str(consts.get("DESCRIPTION") or ""),
            "params": _json_safe_params(declared),
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
    shown under the web's job parameters.

    Everything the file carries except managed_returns goes to the page
    as-is — including the top-level `lookback` (0 = the method declares no
    window and every day was out of sample), which the page compares against
    its own selection when it pinned one. Passthrough, not an allow-list: a
    field the scripts add next must not need an edit here to become visible."""
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
    # same rule as command_listener._mgmt_result_matches, including why the
    # lookback compared is the top-level one, and only when the job pinned it
    try:
        job_lookback = (job.get("params") or {}).get("lookback")
        ours = (sorted(stats.get("members") or []) == sorted(job.get("members") or [])
                and stats.get("allocator") == job.get("allocator")
                and (job_lookback is None or stats.get("lookback") == job_lookback)
                and float(stats.get("computed_at")) >= float(job.get("started_at") or 0))
    except (TypeError, ValueError, AttributeError):
        return None
    if not ours:
        return None
    out = {k: v for k, v in stats.items() if k not in _MGMT_STATS_DROP}
    wh = out.get("weights_history")
    if isinstance(wh, dict):
        try:
            points = sum(len(v) for v in wh.values())
        except TypeError:
            points = None  # a member's value isn't sized (hand-edited file)
        if points is None or points > _MGMT_WEIGHTS_MAX_POINTS:
            out.pop("weights_history", None)
        else:
            # Re-round here too: the 4dp lives in the script, which the agent
            # can edit. Non-numeric entries are left alone — the page's
            # all-or-nothing check drops the pane rather than half-drawing it.
            out["weights_history"] = {
                k: [round(x, 4) if isinstance(x, float) else x for x in v]
                for k, v in wh.items()
                if isinstance(v, list)
            }
    elif wh is not None:
        out.pop("weights_history", None)  # not a mapping; nothing can draw it
    return out


def manager_view():
    # builtin_methods / default_method: the built-in weighting methods THIS
    # workspace's manager.py declares, same entry shape as `allocators` (name /
    # display_name / description / params) with the default first, or both None
    # on a workspace that predates them (then the web keeps its single 「內建」
    # option, which the listener still resolves to slope).
    # Deliberately NOT folded into can_manage: 策略管理 works fine without the
    # names, and gating the whole subtab on them would take the feature away
    # from every machine that hasn't pulled blaveclaw-config yet.
    builtin_methods, default_method = workspace_builtin_methods()
    view = {"can_manage": _workspace_manages(),
            "builtin_methods": builtin_methods, "default_method": default_method,
            "strategies": [], "allocators": [],
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


def _declared_builtins():
    """({name: spec}, default_method) exactly as THIS workspace's manager.py
    declares them, or ({}, None) on one that predates them / can't be read.

    manager.py's BUILTIN_METHODS is the fact, read as a literal with ast the
    same way _allocators() reads an allocator file (never imported). Only
    well-formed entries survive: a non-str name or non-dict spec is not a
    method, and dropping them here also keeps the caller's sort from comparing
    a str against whatever that key is."""
    consts = _module_literals(os.path.join(WORKSPACE, "manager", "manager.py"),
                              _BUILTIN_CONSTS) or {}
    methods = consts.get("BUILTIN_METHODS")
    default = consts.get("DEFAULT_METHOD")
    if not isinstance(methods, dict) or not isinstance(default, str):
        return {}, None
    clean = {n: s for n, s in methods.items()
             if isinstance(n, str) and isinstance(s, dict)}
    return (clean, default) if clean else ({}, None)


def builtin_method_params():
    """{method name: the params that method declares} from manager.py — {} on
    a workspace that predates the named built-ins. The listener's source for
    which names are methods at all and which knobs each one admits."""
    methods, _default = _declared_builtins()
    return {n: _json_safe_params(s.get("params")) for n, s in methods.items()}


def allocator_declared_params(name):
    """The PARAMS an allocator FILE declares, or None when the file can't be
    read or parsed. None is "can't tell", not "declares nothing": the listener
    only refuses a knob it can positively see is undeclared, and a file this
    process can't parse isn't in the picker to be chosen from anyway."""
    consts = _module_literals(
        os.path.join(WORKSPACE, "allocators", name, "allocator.py"), ("PARAMS",))
    if consts is None:
        return None
    declared = consts.get("PARAMS")
    return declared if isinstance(declared, dict) else {}


def script_knows_builtins(script):
    """Whether manager/<script> selects a built-in method BY NAME. Per script,
    not per workspace: they update together in principle and separately in
    practice, and the two commands must not be gated on each other — the one
    whose script is current can still name the method it means.
    Byte-grep, because management_backtest.py imports the name rather than
    declaring it (and bytes for the cp950 reason _workspace_manages documents)."""
    try:
        with open(os.path.join(WORKSPACE, "manager", script), "rb") as f:
            return b"BUILTIN_METHODS" in f.read()
    except OSError:
        return False


def workspace_builtin_methods():
    """(methods, default_method) for the PICKER — entries in the same shape as
    _allocators() (name / display_name / description / params), default first,
    or (None, None) unless BOTH manager scripts know the names.

    Both, deliberately: this list is what the page offers, and an option that
    works for the optimise button and dies on the backtest one is worse than
    not offering it. The listener is the half that goes per-script (see
    script_knows_builtins), because there it can still do the right thing for
    the command actually being run.

    `params` is the load-bearing field — it decides which inputs the page
    draws, so a copy kept here would eventually offer a field the script
    doesn't know. display_name/description ride along verbatim for the
    allocator-shaped contract; the page uses its own i18n for built-ins.
    """
    methods, default = _declared_builtins()
    if not methods or not all(script_knows_builtins(s) for s in
                              ("manager.py", "management_backtest.py")):
        return None, None
    out = []
    # default first, the rest alphabetical — the picker's order is this list's
    for name in sorted(methods, key=lambda n: (n != default, n)):
        spec = methods[name]
        out.append({
            "name": name,
            "display_name": str(spec.get("display_name") or name),
            "description": str(spec.get("description") or ""),
            "params": _json_safe_params(spec.get("params")),
        })
    return out, default


def _workspace_manages():
    """Whether both manager scripts take the flags the listener sends. One is
    the optimise (manager.py), the other the walk-forward
    (management_backtest.py); on a half-updated workspace one of the two
    buttons would still die on argparse, so either one missing is a no.
    Unreadable counts as a no — offering the control is the costly mistake.
    Read as bytes: these files are UTF-8 with CJK comments and Windows' default
    text encoding would raise on them.

    Also no when management_backtest.py imports the built-in method table from a
    manager.py that doesn't declare it: that half of an update dies at IMPORT
    time, before argparse, and the user gets a raw traceback. Same "either one
    is a no" rule — it costs the still-working optimise button on such a
    machine, which is the trade this function has always made."""
    for script in ("manager.py", "management_backtest.py"):
        try:
            with open(os.path.join(WORKSPACE, "manager", script), "rb") as f:
                if b"--members" not in f.read():
                    return False
        except OSError:
            return False
    if script_knows_builtins("management_backtest.py") and not builtin_method_params():
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
