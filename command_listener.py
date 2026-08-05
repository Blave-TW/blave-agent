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
        with open(os.path.join(WORKSPACE, "strategies", name, "strategy.py")) as f:
            m = _INTERVAL_RE.search(f.read())
        iv = (m.group(1) if m else "1h").lower()
    except OSError:
        iv = "1h"
    mm = re.match(r"(\d+)\s*m", iv)
    if mm:
        return f"*/{max(1, min(30, int(mm.group(1))))} * * * *"
    return "5 * * * *"


def _sync_strategy_crons(names):
    """One tagged cron line per picked strategy; drop tagged lines for
    strategies no longer picked. Only lines carrying _CRON_TAG are touched —
    agent-/user-made entries are none of our business. BLAVE_MODE=live makes
    the runner refresh signals even while the file's MODE says backtest.
    Best-effort: a cron failure must not fail the amounts write. Windows is
    pending the scheduled-task work (jobs manifest)."""
    if platform.system() == "Windows":
        _log("cron sync skipped on Windows (scheduled-task support pending)")
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
    except (OSError, ValueError):
        pass
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
    except (OSError, ValueError):
        cfg = {}
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

    return f"credentials_remove={removed}"  # count only — never the names' values


def _cmd_restart_reconciler(args):
    """Start the order daemon through its watchdog wrapper, never directly —
    the wrapper restarts on crash and alerts on each exit (references/manager.md)."""
    if platform.system() == "Windows":
        cmd = ["nssm", "restart", "blaveclaw-reconciler"]
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
    "credentials": _cmd_credentials,
    "credentials_remove": _cmd_credentials_remove,
    "restart_reconciler": _cmd_restart_reconciler,
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
            try:
                on_applied()
            except Exception as e:
                _log(f"post-command report failed: {type(e).__name__}")
            # 二次回報:指令的下游效果(reconcile 快照、account 讀數)要幾秒才
            # 落地,只推一次會讓頁面等到 2 分鐘 timer 才看到「實際」更新
            def _repush():
                time.sleep(8)
                try:
                    on_applied()
                except Exception as e2:
                    _log(f"delayed report failed: {type(e2).__name__}")
            threading.Thread(target=_repush, daemon=True).start()
