"""Command listener: deterministic web → machine operations, no LLM turn.

Runs as its own thread inside web_bridge so that nothing it does waits on
anything else. That isolation is the whole point, not an optimisation: the
bridge's main loop runs an agent turn synchronously, and a turn can take
minutes — the exact window in which a user is most likely to hit 停止交易.
A stop that queues behind a turn is not a kill switch.

Every command here is a data write with no judgment in it, which is why it does
not go through the agent (see AGENTS.md "No LLM in the execution loop" — the
same reasoning, applied to the web side). Anything needing judgment (write me a
strategy, why did this die) stays in the chat.

`amounts` (per-strategy sizing) IS here: the web confirms the exact numbers
with the user before sending, and the reconciler—not this command—decides if
any order actually fires. Sending orders directly stays out.

Secrets: `credentials` carries an exchange key to the workspace .env. It is
never printed, never echoed, and never included in an error message.
"""
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

WORKSPACE = os.environ.get("BLAVE_AGENT_WORKSPACE", "/opt/blave-agent/workspace")
WORKSPACE_STATE = os.path.join(WORKSPACE, "state")
API_BASE = os.environ.get(
    "BLAVE_COMMAND_URL", "https://api.blave.org/openclaw/agent/command"
)
PROXY_TOKEN = os.environ.get("BLAVE_PROXY_TOKEN", "")

POLL_TIMEOUT = 40  # server holds ~25s; leave room before the socket gives up
BACKOFF_S = 5      # after a transport error, before re-polling
HEARTBEAT = os.path.join(WORKSPACE_STATE, "heartbeat", "command_listener")


def _log(msg):
    """Never takes a payload — a command body may hold an exchange key."""
    print(f"[command_listener] {msg}", file=sys.stderr)


def _beat():
    """So the portfolio report can say whether the stop button will work at all.
    A listener that died silently leaves a button that looks fine and does
    nothing, which is worse than a button that is visibly disabled."""
    try:
        os.makedirs(os.path.dirname(HEARTBEAT), exist_ok=True)
        with open(HEARTBEAT, "w") as f:
            f.write(str(int(time.time())))
    except OSError:
        pass


def _in_workspace(fn, *a, **kw):
    """lib/guard.py resolves state/HALT relative to the cwd, and this thread has
    no business changing the process-wide cwd out from under the bridge — so the
    workspace goes on sys.path and the call is made with cwd swapped only for
    the duration, then restored."""
    cwd = os.getcwd()
    try:
        os.chdir(WORKSPACE)
        if WORKSPACE not in sys.path:
            sys.path.insert(0, WORKSPACE)
        return fn(*a, **kw)
    finally:
        try:
            os.chdir(cwd)
        except OSError:
            pass


# ── handlers ─────────────────────────────────────────────────────────────────

def _cmd_halt(args):
    from lib.guard import trip_halt

    trip_halt(args.get("reason") or "user request", "web")
    return "halted"


def _cmd_resume(args):
    from lib.guard import clear_halt

    clear_halt("web")
    return "resumed"


def _cmd_credentials(args):
    """Write exchange keys into the workspace .env.

    Merge, never replace: .env also holds the Blave data-API keys injected at
    first boot, and clobbering those would take the machine's market data down
    with it.
    """
    env = args.get("env")
    if not isinstance(env, dict) or not env:
        raise ValueError("credentials needs an env mapping")
    for k in env:
        if not isinstance(k, str) or not k.replace("_", "").isalnum():
            raise ValueError("bad env key")

    path = os.path.join(WORKSPACE, ".env")
    lines = []
    try:
        with open(path) as f:
            lines = f.read().splitlines()
    except OSError:
        pass
    keys = set(env)
    kept = [l for l in lines if l.split("=", 1)[0].strip() not in keys]
    kept += [f"{k}={env[k]}" for k in env]
    with open(path, "w") as f:
        f.write("\n".join(kept) + "\n")
    os.chmod(path, 0o600)
    # rebind restores the signal schedules the unbind cleared (audit: without
    # this, 解除→重綁→啟動下單 trades real money on signals frozen at unbind
    # time — the exact quiet failure scheduled_strategies() exists to surface)
    try:
        with open(os.path.join(WORKSPACE, "manager", "portfolio_config.json"),
                  encoding="utf-8") as f:
            amounts = json.load(f).get("amounts") or {}
        if amounts:
            _sync_strategy_crons(set(amounts))
    except (OSError, ValueError):
        pass
    return f"credentials={len(env)}"  # count only — never the keys or values


# ── strategy signal-refresh crons(選到就跑,2026-08-03 拍板)─────────────────
# Picked into the 下單設定 table = its signal must stay fresh (the 目標部位
# column is live data), funded or not. Signal runs are read-only — orders are
# the reconciler's alone — so scheduling early is free.

_CRON_TAG = "# blave-web"  # marks the lines this handler owns
_INTERVAL_RE = re.compile(r'^\s*INTERVAL\s*=\s*["\']([^"\']+)["\']', re.M)


def _strategy_cadence(name):
    """Cron cadence from the strategy's declared INTERVAL (default 1h).
    Sub-hour intervals poll at their own pace (capped at 30m); ≥1h all poll
    hourly at :05 — re-running an unchanged signal is idempotent and cheap."""
    try:
        # utf-8 explicit: Windows opens with the locale codepage and agent
        # strategies carry Chinese comments — a UnicodeDecodeError here is not
        # OSError and would poison the whole sync (audit)
        with open(os.path.join(WORKSPACE, "strategies", name, "strategy.py"),
                  encoding="utf-8", errors="replace") as f:
            m = _INTERVAL_RE.search(f.read())
        iv = (m.group(1) if m else "1h").lower()
    except OSError:
        iv = "1h"
    mm = re.match(r"(\d+)\s*m", iv)
    if mm:
        return f"*/{max(1, min(30, int(mm.group(1))))} * * * *"
    return "5 * * * *"


_WIN_TASK_PREFIX = "blave-web-strategy-"
_NAME_OK_RE = re.compile(r"^[A-Za-z0-9_-]+$")


def _win_cadence(name):
    """schtasks schedule flags from the strategy's INTERVAL — mirrors
    _strategy_cadence (sub-hour at its own pace capped 30m; ≥1h hourly)."""
    try:
        with open(os.path.join(WORKSPACE, "strategies", name, "strategy.py"),
                  encoding="utf-8", errors="replace") as f:
            m = _INTERVAL_RE.search(f.read())
        iv = (m.group(1) if m else "1h").lower()
    except OSError:
        iv = "1h"
    mm = re.match(r"(\d+)\s*m", iv)
    if mm:
        return ["/sc", "minute", "/mo", str(max(1, min(30, int(mm.group(1)))))]
    return ["/sc", "hourly", "/mo", "1", "/st", "00:05"]


def _sync_strategy_tasks_windows(names):
    """schtasks twin of the tagged cron lines — the task-name prefix is the
    ownership marker (only our own tasks are created/deleted; agent-made
    blaveclaw-strategy-* tasks are none of our business). Runs as SYSTEM like
    every provision task; output appends to the strategy's own log so a crash
    is at least findable (Windows has no run_strategy.sh alert wrapper yet)."""
    try:
        out = subprocess.run(["schtasks", "/query", "/fo", "csv", "/nh"],
                             capture_output=True, text=True, errors="replace",
                             timeout=30)
        existing = set()
        for line in (out.stdout or "").splitlines():
            tn = line.split('","')[0].strip('"').lstrip("\\")
            if tn.startswith(_WIN_TASK_PREFIX):
                existing.add(tn[len(_WIN_TASK_PREFIX):])
        wanted = {n for n in names if _NAME_OK_RE.fullmatch(n)}
        for n in sorted(set(names) - wanted):
            _log(f"task sync: skipping unsafe strategy name {n!r}")
        for n in sorted(existing - wanted):
            r = subprocess.run(["schtasks", "/delete", "/tn", _WIN_TASK_PREFIX + n, "/f"],
                               capture_output=True, text=True, errors="replace",
                               timeout=30)
            if r.returncode != 0:  # a survivor keeps refreshing signals unseen
                _log(f"task sync: delete {n} failed: "
                     f"{(r.stderr or r.stdout or '').strip()[:120]}")
        for n in sorted(wanted):
            tr = (f'cmd /c cd /d "{WORKSPACE}" && set BLAVE_MODE=live&& '
                  f"python strategies\\{n}\\strategy.py >> strategies\\{n}\\strategy.log 2>&1")
            cadence = _win_cadence(n)
            r = subprocess.run(["schtasks", "/create", "/tn", _WIN_TASK_PREFIX + n,
                                "/tr", tr, "/ru", "SYSTEM", "/f"] + cadence,
                               capture_output=True, text=True, errors="replace",
                               timeout=30)
            if r.returncode != 0:
                _log(f"task sync: create {n} failed: "
                     f"{(r.stderr or r.stdout or '').strip()[:120]}")
            elif n not in existing and cadence[1] == "hourly":
                # first run NOW — hourly tasks (/st 00:05) otherwise wait up to
                # an hour for their first signal while the web's optimistic
                # light gives up after 5 min. Minute-cadence tasks fire on
                # their own within ≤30m AND may fire immediately on create —
                # kicking those too can race two writers into state.json,
                # which lib/execute writes non-atomically (audit B1)
                subprocess.run(["schtasks", "/run", "/tn", _WIN_TASK_PREFIX + n],
                               capture_output=True, timeout=30)
        _log(f"task sync: {len(wanted)} strategy task(s)")
    except Exception as e:
        _log(f"task sync failed: {type(e).__name__}: {e}")


def _sync_strategy_crons(names):
    """One tagged cron line per picked strategy; drop tagged lines for
    strategies no longer picked. Only lines carrying _CRON_TAG are touched —
    agent-/user-made entries are none of our business. BLAVE_MODE=live makes
    the runner refresh signals even while the file's MODE says backtest.
    Best-effort: a cron failure must not fail the amounts write. Windows uses
    the schtasks twin (audit L6 — before it, web-picked strategies simply
    never ran on Windows machines)."""
    if platform.system() == "Windows":
        _sync_strategy_tasks_windows(set(names))
        return
    try:
        out = subprocess.run(["crontab", "-l"], capture_output=True, text=True, timeout=10)
        lines = out.stdout.splitlines() if out.returncode == 0 else []
        kept = [l for l in lines if _CRON_TAG not in l]
        for n in sorted(names):
            kept.append(
                f"{_strategy_cadence(n)} cd {WORKSPACE} && "
                f"BLAVE_MODE=live bash manager/run_strategy.sh {n} {_CRON_TAG}"
            )
        subprocess.run(["crontab", "-"], input="\n".join(kept) + "\n",
                       text=True, timeout=10, check=True)
        _log(f"cron sync: {len(names)} strategy line(s)")
    except Exception as e:
        _log(f"cron sync failed: {type(e).__name__}: {e}")


def _cmd_amounts(args):
    """策略下單金額 — the 下單設定 page's save button.

    `amounts` is canonical: {strategy: dollars at position=1}; the reconciler
    sizes targets as amount × position (lib/portfolio.strategy_amounts) —
    what the user typed is what trades, and it never drifts with equity.
    Doubles as membership: an amount > 0 puts the strategy in the portfolio
    and routes it; the venue is inherited from existing members (one
    portfolio, one account — membership never silently splits across venues).
    """
    amounts = args.get("amounts")
    # empty dict is legal: "the portfolio is empty" (every strategy unpicked)
    if not isinstance(amounts, dict):
        raise ValueError("amounts needs a {strategy: dollars} mapping")
    prev = set()
    try:
        with open(os.path.join(WORKSPACE, "manager", "portfolio_config.json")) as f:
            prev = set((json.load(f).get("amounts") or {}))
    except (OSError, ValueError, AttributeError):
        pass  # kickoff detection only — the main read below fail-closes properly
    clean = {}
    for k, v in amounts.items():
        # Names are interpolated into crontab lines and workspace paths —
        # anything outside this set is not a strategy dir name, it is an
        # injection attempt (the enqueue API passes args through unvalidated).
        if not isinstance(k, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", k):
            raise ValueError("bad strategy name")
        try:
            f = float(v)
        except (TypeError, ValueError):
            raise ValueError("amounts must be numbers")
        if not (0 <= f < 1e12):  # rejects NaN, negatives, inf
            raise ValueError("amounts must be finite and >= 0")
        clean[k] = round(f, 2)

    path = os.path.join(WORKSPACE, "manager", "portfolio_config.json")
    try:
        with open(path) as f:
            cfg = json.load(f)
    except FileNotFoundError:
        cfg = {}  # fresh machine — first write creates the file
    except (OSError, ValueError) as e:
        # fail-closed like _cmd_execution: unreadable can mean manager.py
        # mid-write — rebuilding from {} here would wipe keys this command
        # doesn't own (execution, asset_specs). A retry costs nothing.
        raise RuntimeError(
            f"portfolio config unreadable ({type(e).__name__}) — try again"
        )
    if not isinstance(cfg, dict):
        raise RuntimeError("portfolio config unreadable (not a dict) — try again")
    cfg["amounts"] = clean
    old = cfg.get("exchanges") or {}
    # Only inherit venues that are STILL BOUND (keys in .env) — after 解除綁定
    # +重連別家, the old routing would otherwise zombie back in (positions
    # live on the account, not in this dict).
    bound = set()
    try:
        with open(os.path.join(WORKSPACE, ".env")) as f:
            for line in f:
                m = re.match(r"\s*([A-Za-z0-9_]+)_API_KEY\s*=", line, re.IGNORECASE)
                if m and m.group(1).upper() != "BLAVE":
                    bound.add(m.group(1).lower())
    except OSError:
        pass
    old = {k: (v if v in bound else "") for k, v in old.items()}
    venues = {v for v in old.values() if v}
    default_venue = venues.pop() if len(venues) == 1 else ""
    if not default_venue and len(bound) == 1:
        # No routed member to inherit from (fresh portfolio, membership emptied,
        # or old venue unbound): fall back to the machine's one bound exchange.
        default_venue = next(iter(bound))
    cfg["exchanges"] = {
        n: (old.get(n) or default_venue) for n, amt in clean.items() if amt > 0
    }
    cfg.setdefault("asset_specs", {})
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(cfg, f, indent=2)
    os.replace(tmp, path)  # atomic: the reconciler mtime-watches + json-loads this
    _sync_strategy_crons(set(clean))  # 選到就跑:picked = scheduled,不看金額
    # 勾好=在跑:新選入的立刻背景跑一次,不等下一個 cron 整點——訊號一分鐘
    # 內就新鮮,sidebar 的點跟著亮。detached + DEVNULL:跑多久、成敗都不能
    # 拖住指令迴圈,結果由 state.json/回報說話。
    if platform.system() != "Windows":
        for n in sorted(set(clean) - prev):
            try:
                subprocess.Popen(
                    ["bash", "manager/run_strategy.sh", n],
                    cwd=WORKSPACE,
                    # minimal env — the bridge's BLAVE_PROXY_TOKEN etc. have no
                    # business inside agent/user strategy code (cron runs give
                    # strategies a bare env too, so this also matches prod)
                    env={k: v for k, v in os.environ.items()
                         if k in ("PATH", "HOME", "LANG", "USER", "SHELL")} | {"BLAVE_MODE": "live"},
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    start_new_session=True,
                )
            except OSError as e:
                _log(f"kickoff run failed for {n}: {type(e).__name__}")
    return f"amounts={len(clean)}"


_EXEC_MODULE_RE = re.compile(r"^[a-z0-9_]{1,64}$")


def _cmd_execution(args):
    """每策略下單方式 — the 下單設定 page's execution-style setting.

    Whole-map replace, like `amounts`: the web sends the complete non-market
    list on every save, so an empty dict is legal ("everyone back to market")
    and is written as {} rather than dropping the key — one shape, no
    absent-vs-empty ambiguity downstream. Validation is all-or-nothing: one
    bad spec rejects the whole payload, never a partial write. Whether a
    custom module actually exists (manager/executors/<module>.py) is the
    executor's problem at run time, not this write's.
    """
    execution = args.get("execution")
    if not isinstance(execution, dict):
        raise ValueError("execution needs a {strategy: spec} mapping")
    if len(execution) > 200:
        raise ValueError("too many execution entries")
    clean = {}
    for k, spec in execution.items():
        # Same name rule as _cmd_amounts — these are strategy dir names, and
        # the enqueue API passes args through unvalidated.
        if not isinstance(k, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", k):
            raise ValueError("bad strategy name")
        if not isinstance(spec, dict):
            raise ValueError("execution spec must be an object")
        typ = spec.get("type")
        if typ == "market":
            clean[k] = {"type": "market"}
        elif typ == "twap":
            dur = spec.get("duration_min")
            # Mirror the machine-side consumer (lib/execute.py: int() + clamp to
            # 1..1440) — an agent-hand-written config with 2000 or "30" must
            # survive the web's whole-map re-save, not get silently dropped by a
            # stricter gate here. bool is an int subclass — True would int() to 1.
            if isinstance(dur, bool):
                raise ValueError("twap duration_min must be a number")
            try:
                dur = int(dur)
            except (TypeError, ValueError):
                raise ValueError("twap duration_min must be a number")
            clean[k] = {"type": "twap", "duration_min": min(max(dur, 1), 1440)}
        elif typ == "custom":
            module = spec.get("module")
            if not isinstance(module, str) or not _EXEC_MODULE_RE.fullmatch(module):
                raise ValueError("bad custom executor module name")
            clean[k] = {"type": "custom", "module": module}
        elif typ == "chase":
            clean[k] = {"type": "chase"}
        else:
            raise ValueError("execution type must be market/twap/custom/chase")

    path = os.path.join(WORKSPACE, "manager", "portfolio_config.json")
    try:
        with open(path) as f:
            cfg = json.load(f)
    except FileNotFoundError:
        cfg = {}  # fresh machine — first write creates the file
    except (OSError, ValueError) as e:
        # fail-closed like _cmd_delete_strategy: manager.py writes this file
        # non-atomically, so unreadable can mean mid-write — falling back to {}
        # here would clobber amounts/exchanges, and this command owns only the
        # `execution` key. A retry costs nothing.
        raise RuntimeError(
            f"portfolio config unreadable ({type(e).__name__}) — try again"
        )
    if not isinstance(cfg, dict):
        raise RuntimeError("portfolio config unreadable (not a dict) — try again")
    cfg["execution"] = clean
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(cfg, f, indent=2)
    os.replace(tmp, path)  # atomic: the reconciler mtime-watches + json-loads this
    return f"execution={len(clean)}"


def _stop_reconciler():
    """True only when no reconciler daemon can still be watching the workspace
    (confirmed stopped, or provably never running). The full-unbind path gates
    the membership clear on this — see the WHY there. Same stop mechanics as
    _cmd_restart_reconciler's first half."""
    try:
        if platform.system() == "Windows":
            st = subprocess.run(["nssm", "status", "blaveclaw-reconciler"],
                                capture_output=True, timeout=30)
            if st.returncode != 0:
                return True  # service never installed — nothing watching
            r = subprocess.run(["nssm", "stop", "blaveclaw-reconciler"],
                               capture_output=True, timeout=60)
            return r.returncode == 0
        r = subprocess.run(["tmux", "kill-session", "-t", "reconciler"],
                           capture_output=True, text=True, timeout=20)
        if r.returncode == 0:
            return True
        err = (r.stderr or "").lower()
        # no such session / no tmux server at all = no daemon = nothing watching
        return ("find session" in err or "no server" in err
                or "failed to connect" in err)
    except Exception as e:  # TimeoutExpired, FileNotFoundError, …
        _log(f"reconciler stop failed: {type(e).__name__}: {e}")
        return False


def _cmd_credentials_remove(args):
    """Unbind: drop exchange keys from the workspace .env.

    The platform's own blave_* data-API credentials are never removed, no
    matter what the caller lists — losing those takes the machine's market
    data down with it.
    """
    names = args.get("env")
    if (
        not isinstance(names, list)
        or not names
        or not all(isinstance(n, str) and n.replace("_", "").isalnum() for n in names)
    ):
        raise ValueError("credentials_remove needs a list of env names")
    drop = {n for n in names if not n.upper().startswith("BLAVE_")}

    path = os.path.join(WORKSPACE, ".env")
    try:
        with open(path) as f:
            lines = f.read().splitlines()
    except OSError:
        return "credentials_remove=0"
    kept = [l for l in lines if l.split("=", 1)[0].strip() not in drop]
    removed = len(lines) - len(kept)
    with open(path, "w") as f:
        f.write("\n".join(kept) + "\n")
    os.chmod(path, 0o600)

    # Prune the unbound venues from account.json right away — the account
    # reader only rewrites it every 2 min, and until then the web would keep
    # showing a live-looking equity for an account that no longer has a key.
    dropped_ids = {
        n[: -len("_API_KEY")].lower() for n in drop if n.upper().endswith("_API_KEY")
    }
    if dropped_ids:
        apath = os.path.join(WORKSPACE, "manager", "account.json")
        try:
            with open(apath) as f:
                acct = json.load(f)
            for vid in dropped_ids:
                (acct.get("venues") or {}).pop(vid, None)
            with open(apath + ".tmp", "w") as f:
                json.dump(acct, f)
            os.replace(apath + ".tmp", apath)  # atomic: a path unit watches this
        except (OSError, ValueError):
            pass  # no account.json yet, or unreadable — the reader will converge it

    # Unbinding PAUSES trading immediately (Wei 2026-08-05): the reconciler's
    # wiring points at the venue whose keys just vanished — without this it
    # fails reads for up to 15 min before auto-halt trips, and any strategy
    # still routed here looks "running" the whole time. Conservative on
    # multi-venue machines (halts everything); resuming is the user's explicit
    # 啟動下單 press, same as every other halt.
    if dropped_ids:
        try:
            from lib.guard import trip_halt
            trip_halt(f"exchange unbound ({'/'.join(sorted(dropped_ids))})", "web")
        except Exception as e:
            # guard genuinely unavailable (pre-guard workspace) — auto-halt
            # still covers it, but say so instead of hiding it (audit H2)
            print(f"[credentials_remove] unbind-halt failed: {e}", file=sys.stderr)
        # NO venue left → stop the signal-refresh schedules too (Wei
        # 2026-08-05: halt keeps signals breathing, unbind kills them — an
        # unbound machine updating targets reads as "still trading"). The next
        # amounts save after a rebind re-syncs the crons, so resume costs
        # nothing; partial unbind on a multi-venue machine keeps them.
        if not any(l.split("=", 1)[0].strip().upper().endswith("_API_KEY")
                   and not l.split("=", 1)[0].strip().upper().startswith("BLAVE")
                   for l in kept):
            _sync_strategy_crons(set())
            # …and zero the 下單設定 itself (Wei 2026-08-06): users don't
            # bounce between venues, and members lingering with no venue bound
            # block 刪除策略 and friends — a rebind starts from a clean sheet.
            # STOP THE DAEMON FIRST, THEN CLEAR — the halt above is NOT a
            # defense here. state/HALT only blocks is_entry legs
            # (lib/portfolio.py), never reduce legs; clearing membership zeroes
            # every target, so a live daemon's next mtime-triggered reconcile
            # (≤5s) would market-flatten every actual position as "reduce".
            # Nor does deleting the keys save sinopac/capital: their order
            # libs are module singletons with a cached login session
            # (lib/order_sinopac.py _get_api) that keeps reading positions
            # after .env is wiped — only auto-wired venues re-read env per
            # call and fail closed. With no venue bound there is nothing to
            # reconcile, so a stopped daemon is the right state; after a
            # rebind the user's 啟動下單 press restarts it
            # (_cmd_restart_reconciler), same as every resume. If the stop
            # cannot be confirmed, keep the membership — a stale-but-consistent
            # config is the safe direction — and still let the unbind succeed.
            # What's cleared is membership only (amounts/exchanges emptied,
            # legacy weights dropped — asset_specs and the rest survive).
            # Partial unbind on a multi-venue machine keeps daemon and
            # portfolio as-is.
            if _stop_reconciler():
                cpath = os.path.join(WORKSPACE, "manager", "portfolio_config.json")
                try:
                    with open(cpath) as f:
                        cfg = json.load(f)
                    if isinstance(cfg, dict):
                        cfg["amounts"] = {}
                        cfg["exchanges"] = {}
                        cfg.pop("weights", None)
                        with open(cpath + ".tmp", "w") as f:
                            json.dump(cfg, f, indent=2)
                        # atomic: the reconciler mtime-watches + json-loads this
                        os.replace(cpath + ".tmp", cpath)
                except FileNotFoundError:
                    pass  # no portfolio was ever written — nothing to clear
                except (OSError, ValueError) as e:
                    _log(f"membership clear failed: {type(e).__name__}: {e}")
            else:
                _log("reconciler not confirmed stopped — membership kept")

    return f"credentials_remove={removed}"  # count only — never the names' values


def _purge_strategy_schedules(entries):
    """Drop the schedules that ran the just-deleted entries. Without this, an
    agent-deployed cron (untagged `bash manager/run_strategy.sh <entry>`, see
    references/deployment.md) keeps firing forever: run_strategy.sh mkdir -p's
    the ghost dir back and Telegrams a failure alert every tick. Tag or no tag
    doesn't matter here — the tag guards LIVE schedules from the web's sync,
    but with the strategy files gone every line running this entry is only
    alarm garbage. Keyed by the filesystem ENTRY name, not the reported
    STRATEGY_NAME — the schedule references the path, and the two can differ.
    Best-effort like _sync_strategy_crons: a purge failure must not fail the
    delete that already happened."""
    if not entries:
        return
    try:
        if platform.system() == "Windows":
            out = subprocess.run(["schtasks", "/query", "/fo", "csv", "/nh"],
                                 capture_output=True, text=True, errors="replace",
                                 timeout=30)
            existing = set()
            for line in (out.stdout or "").splitlines():
                existing.add(line.split('","')[0].strip('"').lstrip("\\"))
            for e in sorted(entries):
                # both owners: the agent's blaveclaw-strategy-* and our own
                for tn in (f"blaveclaw-strategy-{e}", _WIN_TASK_PREFIX + e):
                    if tn not in existing:
                        continue
                    r = subprocess.run(["schtasks", "/delete", "/tn", tn, "/f"],
                                       capture_output=True, text=True,
                                       errors="replace", timeout=30)
                    if r.returncode != 0:  # a survivor keeps alerting unseen
                        _log(f"schedule purge: delete {tn} failed: "
                             f"{(r.stderr or r.stdout or '').strip()[:120]}")
            return
        out = subprocess.run(["crontab", "-l"], capture_output=True, text=True, timeout=10)
        if out.returncode != 0:
            return  # no crontab at all — nothing scheduled
        pats = []
        for e in entries:
            # run_strategy.sh <entry> (agent + web lines) and the direct
            # strategies/<entry>/strategy.py form deployment.md forbids but
            # agents have written anyway
            pats.append(re.compile(r"run_strategy\.sh\s+%s(\s|$)" % re.escape(e)))
            pats.append(re.compile(r"strategies[/\\]%s[/\\]strategy\.py" % re.escape(e)))
        lines = out.stdout.splitlines()
        kept = [l for l in lines if not any(p.search(l) for p in pats)]
        if len(kept) != len(lines):
            subprocess.run(["crontab", "-"], input="\n".join(kept) + "\n",
                           text=True, timeout=10, check=True)
            _log(f"schedule purge: dropped {len(lines) - len(kept)} cron line(s)")
    except Exception as e:
        _log(f"schedule purge failed: {type(e).__name__}: {e}")


def _cmd_delete_strategy(args):
    """Remove a strategy's files from the workspace — the strategy list's 刪除
    button. Pure file removal, no judgment, hence a command and not a chat turn.

    The web sends the reported STRATEGY_NAME, which is a constant inside the
    file and need not match the dir/file name — so matching walks the same two
    layouts strategy_reporter.scan() reports from and compares by consts, or a
    rename inside the file would make the button delete nothing (or worse, the
    wrong entry).

    A strategy still in the portfolio is refused outright: the reconciler
    routes live money by that name, and deleting the files under it would leave
    a portfolio member whose target can never refresh — the exact frozen-signal
    failure the cron sync exists to prevent. Membership is 選到就跑: keyed at
    all counts, the amount is irrelevant.
    """
    name = args.get("name")
    if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", name):
        raise ValueError("bad strategy name")
    try:
        with open(os.path.join(WORKSPACE, "manager", "portfolio_config.json")) as f:
            cfg = json.load(f)
    except FileNotFoundError:
        cfg = {}  # fresh machine — no portfolio was ever written, nothing to guard
    except (OSError, ValueError) as e:
        # fail-closed: manager.py writes this file non-atomically, so unreadable
        # can mean mid-write — treating that as "empty portfolio" would wave
        # through deleting a strategy that IS routing real money. A delete can
        # wait; a flattened live position can't be undone.
        raise RuntimeError(
            f"portfolio config unreadable ({type(e).__name__}) — try again"
        )
    if not isinstance(cfg, dict):
        raise RuntimeError("portfolio config unreadable (not a dict) — try again")
    # Membership is the key union the reconciler itself reads (lib/portfolio.py):
    # `amounts` is canonical, but pre-2026-08-03 configs have none — they still
    # trade off `weights` + `exchanges` (strategy_amounts' fallback keeps them
    # "trading identically"). Checking `amounts` alone waves those members
    # through, and the reconciler flattens the live position the moment its
    # target vanishes.
    members = set()
    for key in ("amounts", "weights", "exchanges"):
        val = cfg.get(key)
        if isinstance(val, dict):
            members |= set(val)
    if name in members:
        raise RuntimeError(
            "strategy is in the 下單設定 portfolio — remove it there first"
        )

    import strategy_reporter  # same runtime dir; resolves consts the way scan() does

    sdir = os.path.join(WORKSPACE, "strategies")
    doomed = []
    if os.path.isdir(sdir):
        for entry in sorted(os.listdir(sdir)):
            if entry.startswith(".") or entry == "__pycache__" or entry.startswith("TEMPLATE"):
                continue
            full = os.path.join(sdir, entry)
            if os.path.isfile(full) and entry.endswith(".py"):
                path, fallback = full, entry[:-3]
            elif os.path.isdir(full) and os.path.isfile(os.path.join(full, "strategy.py")):
                path, fallback = os.path.join(full, "strategy.py"), entry
            else:
                continue
            try:
                # utf-8 explicit for the same Windows-codepage reason as
                # _strategy_cadence — a decode error must not abort the delete
                with open(path, encoding="utf-8", errors="replace") as f:
                    src = f.read()
            except OSError:
                continue
            consts = strategy_reporter.strategy_consts(src)
            if (consts.get("STRATEGY_NAME") or fallback) == name:
                doomed.append(full)
    # Single-file layout writes its backtest output to strategies/<name>/
    # (stats.json / pnl.png, no strategy.py) — take it too, or the deleted
    # strategy's stats and charts linger as a ghost the next scan re-reports.
    out_dir = os.path.join(sdir, name)
    if os.path.isdir(out_dir) and not os.path.isfile(os.path.join(out_dir, "strategy.py")):
        doomed.append(out_dir)

    if not doomed:
        # idempotent: a retry after a half-seen success is a no-op, not an error
        return "delete_strategy=absent"
    entries = set()
    for p in doomed:
        base = os.path.basename(p)
        if os.path.isdir(p):
            shutil.rmtree(p)
            entries.add(base)
        else:
            os.remove(p)
            entries.add(base[:-3] if base.endswith(".py") else base)
    _purge_strategy_schedules(entries)
    return f"delete_strategy={len(doomed)}"


def _cmd_retest_accounts(args):
    """Run the account reader NOW with the stored keys (Wei 2026-08-05: the
    connect-failed page's button must actively re-test on press, not wait for
    the 60s timer). Detached — the reader can take up to its per-venue alarm,
    and blocking here would delay a queued halt. Its account.json write fires
    the path unit / file_watcher, which pushes the fresh report the web is
    burst-polling for."""
    base = os.path.dirname(WORKSPACE)
    reader = os.path.join(base, "current", "account_reader.py")
    sys_py = "python" if platform.system() == "Windows" else "/usr/bin/python3"
    subprocess.Popen([sys_py, reader], cwd=WORKSPACE,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return "retesting"


def _cmd_restart_reconciler(args):
    """Start the order daemon through its watchdog wrapper, never directly —
    the wrapper restarts on crash and alerts on each exit (references/manager.md)."""
    if platform.system() == "Windows":
        # Self-bootstrap like the Linux tmux path: a machine where the agent
        # never set up auto-trading has no service yet — install it here
        # (references/manager.md sequence) instead of failing the button.
        st = subprocess.run(["nssm", "status", "blaveclaw-reconciler"],
                            capture_output=True, timeout=30)
        if st.returncode != 0:
            ps1 = os.path.join(WORKSPACE, "manager",
                               "start_reconciler_windows.ps1")
            # nssm install doesn't validate the target — installing against a
            # missing ps1 yields a service that flaps silently forever
            if not os.path.isfile(ps1):
                raise RuntimeError("start_reconciler_windows.ps1 missing — "
                                   "workspace too old, run 更新 blave agent first")
            # Capital's SKCOM.dll binds its cert to the Administrator identity;
            # a LocalSystem service fails login with error 602 and the button
            # would hand back a machine that auto-halts with no visible cause
            # (references/manager.md broker exception). The agent-led install
            # flow handles the ObjectName step; this button doesn't.
            try:
                with open(os.path.join(WORKSPACE, "manager",
                                       "portfolio_config.json")) as f:
                    routed = set((json.load(f).get("exchanges") or {}).values())
            except (OSError, ValueError):
                routed = set()
            if "capital" in routed:
                raise RuntimeError("capital routing needs the agent-led service "
                                   "install (Administrator identity) — ask the "
                                   "agent to start auto-trading")
            for step in (
                ["install", "blaveclaw-reconciler", "powershell.exe",
                 "-ExecutionPolicy", "Bypass", "-File", ps1],
                ["set", "blaveclaw-reconciler", "AppDirectory", WORKSPACE],
                ["set", "blaveclaw-reconciler", "Start", "SERVICE_AUTO_START"],
            ):
                out = subprocess.run(["nssm"] + step, capture_output=True,
                                     text=True, timeout=15)
                if out.returncode != 0:
                    raise RuntimeError(
                        (out.stderr or out.stdout or "").strip()[:200])
            # register for health monitoring (references/manager.md) — a
            # bootstrap machine has no agent-written deployments.json, so the
            # freshly installed daemon would otherwise die unseen
            dep_path = os.path.join(WORKSPACE, "state", "deployments.json")
            try:
                try:
                    with open(dep_path) as f:
                        deps = json.load(f)
                except (OSError, ValueError):
                    deps = {}
                deps.setdefault("reconciler", {
                    "type": "daemon", "expect_every_minutes": 5,
                    "registered_at": time.strftime("%Y-%m-%dT%H:%M:%S",
                                                   time.gmtime()),
                })
                os.makedirs(os.path.dirname(dep_path), exist_ok=True)
                with open(dep_path, "w") as f:
                    json.dump(deps, f, indent=2)
            except OSError as e:
                _log(f"deployments.json registration failed: {e}")
        else:
            # stop is best-effort: nssm returns 0 on an already-stopped
            # service, but a HUNG one can outlast the timeout — that must not
            # kill the restart (start is what decides)
            try:
                subprocess.run(["nssm", "stop", "blaveclaw-reconciler"],
                               capture_output=True, timeout=60)
            except subprocess.TimeoutExpired:
                pass
        cmd = ["nssm", "start", "blaveclaw-reconciler"]
    else:
        # kill any existing session first: a crash-looping one would otherwise
        # keep its name and this would silently no-op
        subprocess.run(["tmux", "kill-session", "-t", "reconciler"],
                       capture_output=True, timeout=20)
        cmd = ["tmux", "new-session", "-d", "-s", "reconciler",
               f"cd {WORKSPACE} && bash manager/start_reconciler.sh"]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if out.returncode != 0:
        raise RuntimeError((out.stderr or out.stdout or "").strip()[:200])
    return "reconciler restarted"


def _cmd_close_all(args):
    """Panic: trip HALT synchronously, then flatten every venue position in a
    detached process (fills can take a while — the command loop must not wait;
    results surface through orders.jsonl → the report, like everything else)."""
    from lib.guard import trip_halt

    trip_halt("close all positions", "web")
    if not os.path.isfile(os.path.join(WORKSPACE, "manager", "flatten.py")):
        # workspace 還沒更新到有平倉層——誠實回報只掛了 halt(reporter 的
        # can_flatten 同一判準,前端本來就不會給這顆選項;這裡是最後防線)
        return "close_all=halted_only"
    # log 進檔案不進 DEVNULL:detached 程序的失敗路徑(沒 order lib、平倉炸)
    # 除了 order_errors.json 外,還要有完整紀錄可查
    log_path = os.path.join(WORKSPACE, "state", "flatten.log")
    os.makedirs(os.path.dirname(log_path), exist_ok=True)
    # 環境走 denylist 不走 allowlist:Windows 的 python 少了 SystemRoot 等
    # 系統變數會直接起不來;要擋的只有 bridge 的 BLAVE_* 秘密
    child_env = {k: v for k, v in os.environ.items() if not k.startswith("BLAVE_")}
    child_env["BLAVE_AGENT_WORKSPACE"] = WORKSPACE
    if platform.system() == "Windows":
        # 脫離 NSSM 的 process tree:bridge 重啟時 NSSM 會殺整棵樹,平倉做一半
        # 被砍=HALT 掛著、倉平一半。經由一個立刻退場的 powershell 中轉
        # (Start-Process 的子程序在 powershell 死後變孤兒,樹掃描摸不到)。
        ps_cmd = (
            f"Start-Process -WindowStyle Hidden -FilePath python "
            f"-ArgumentList 'manager/flatten.py' -WorkingDirectory '{WORKSPACE}' "
            f"-RedirectStandardOutput '{log_path}.out' "
            f"-RedirectStandardError '{log_path}.err'"
        )
        subprocess.Popen(["powershell", "-NoProfile", "-Command", ps_cmd],
                         cwd=WORKSPACE, env=child_env,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return "close_all=started"
    # Linux:bridge unit 是 KillMode=process(見 systemd/blave-agent-web.service)
    # ——重啟只殺 bridge 本體,flatten 活到收工
    with open(log_path, "ab") as logf:
        subprocess.Popen(
            ["python3", "manager/flatten.py"],
            cwd=WORKSPACE, env=child_env,
            stdout=logf, stderr=logf, start_new_session=True,
        )
    return "close_all=started"


HANDLERS = {
    "halt": _cmd_halt,
    "resume": _cmd_resume,
    "close_all": _cmd_close_all,
    "amounts": _cmd_amounts,
    "execution": _cmd_execution,
    "credentials": _cmd_credentials,
    "credentials_remove": _cmd_credentials_remove,
    "retest_accounts": _cmd_retest_accounts,
    "restart_reconciler": _cmd_restart_reconciler,
    "delete_strategy": _cmd_delete_strategy,
}


def dispatch(command):
    """Run one command. Returns a short label for the log; raises on failure."""
    cmd = command.get("cmd")
    fn = HANDLERS.get(cmd)
    if not fn:
        raise ValueError(f"unknown command {cmd!r}")
    args = command.get("args") if isinstance(command.get("args"), dict) else {}
    # close_all imports lib.guard AND writes state/HALT — both resolve relative
    # to the workspace. Outside _in_workspace a fresh listener ImportErrors
    # (panic button dead) or writes HALT into the bridge's cwd (halt silently
    # ineffective) — measured in audit, P0. credentials_remove is in the list
    # for its unbind-halt (audit H2: outside it, that halt was inert — either
    # a swallowed ImportError or a HALT file in the wrong cwd).
    if cmd in ("halt", "resume", "close_all", "credentials_remove"):
        return _in_workspace(fn, args)
    return fn(args)


def poll_once():
    req = urllib.request.Request(
        API_BASE + "/poll", headers={"x-api-key": f"proxy-{PROXY_TOKEN}"}
    )
    with urllib.request.urlopen(req, timeout=POLL_TIMEOUT) as resp:
        return (json.loads(resp.read().decode()) or {}).get("command")


def run(on_applied=None):
    """Poll-execute-report forever. `on_applied` pushes a fresh portfolio report
    so the page confirms from real machine state rather than from its own POST
    having returned 200."""
    if not PROXY_TOKEN:
        _log("BLAVE_PROXY_TOKEN not set; command listener disabled")
        return
    _log("started")

    # Reporting is several HTTP POSTs (15s timeout each) plus a full workspace
    # scan — a degraded network stacks that to ~45s. This loop is the panic path
    # (halt → close_all), and a stop that queues behind a report is not a stop:
    # the whole push, delayed repush included, runs off-loop on its own daemon
    # thread. Single-flight (only this loop thread touches the flag): on_applied
    # reads live state, so the in-flight push's 8s repush already carries the
    # newer command's effects — a second thread would only race the same POSTs.
    report_inflight = threading.Event()

    def _report():
        try:
            try:
                on_applied()
            except Exception as e:
                _log(f"post-command report failed: {type(e).__name__}")
            # 二次回報:指令的下游效果(reconcile 快照、account 讀數)要幾秒才
            # 落地,只推一次會讓頁面等到 2 分鐘 timer 才看到「實際」更新
            time.sleep(8)
            try:
                on_applied()
            except Exception as e2:
                _log(f"delayed report failed: {type(e2).__name__}")
        finally:
            report_inflight.clear()

    while True:
        _beat()
        try:
            command = poll_once()
        except Exception as e:
            _log(f"poll failed: {type(e).__name__}")
            time.sleep(BACKOFF_S)
            continue
        if not command:
            continue
        cid = command.get("id", "?")
        try:
            result = dispatch(command)
            _log(f"{command.get('cmd')} {cid} ok: {result}")
        except Exception as e:
            # The message may quote user input but never a payload value —
            # handlers raise with shapes, not contents.
            _log(f"{command.get('cmd')} {cid} FAILED: {type(e).__name__}: {e}")
        if on_applied:
            if report_inflight.is_set():
                _log("post-command report still in flight — skipped (its repush covers this)")
            else:
                report_inflight.set()
                threading.Thread(target=_report, daemon=True,
                                 name="command-report").start()
