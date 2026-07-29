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

Deliberately NOT here: applying weights and sending orders. Those move real
money and need the "you saw this exact proposal" handshake first; adding them
without it would turn a reviewed action into a one-click one.

Secrets: `credentials` carries an exchange key to the workspace .env. It is
never printed, never echoed, and never included in an error message.
"""
import json
import os
import platform
import subprocess
import sys
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


def _cmd_members(args):
    """Portfolio membership = the keys of portfolio_config["exchanges"].

    Membership and routing are separate facts sharing one dict: a key present
    means "this strategy is in the portfolio" (manager.py weights it), a
    non-empty value means "and it trades here". A member added before an
    exchange is connected keeps an empty value — weighted, never routed, so
    aggregate_portfolio skips it and nothing can trade by accident.
    """
    names = args.get("names")
    if not isinstance(names, list) or not all(isinstance(n, str) and n for n in names):
        raise ValueError("members needs a list of strategy names")

    path = os.path.join(WORKSPACE, "manager", "portfolio_config.json")
    try:
        with open(path) as f:
            cfg = json.load(f)
    except (OSError, ValueError):
        cfg = {}
    old = cfg.get("exchanges") or {}
    # One portfolio, one account: a new member inherits whatever venue the
    # existing ones use, so membership never silently splits across venues.
    venues = {v for v in old.values() if v}
    default_venue = venues.pop() if len(venues) == 1 else ""
    cfg["exchanges"] = {n: old.get(n, default_venue) for n in names}
    cfg.setdefault("account_value", 0)
    cfg.setdefault("asset_specs", {})

    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(cfg, f, indent=2)
    return f"members={len(names)}"


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


HANDLERS = {
    "halt": _cmd_halt,
    "resume": _cmd_resume,
    "members": _cmd_members,
    "credentials": _cmd_credentials,
    "restart_reconciler": _cmd_restart_reconciler,
}


def dispatch(command):
    """Run one command. Returns a short label for the log; raises on failure."""
    cmd = command.get("cmd")
    fn = HANDLERS.get(cmd)
    if not fn:
        raise ValueError(f"unknown command {cmd!r}")
    args = command.get("args") if isinstance(command.get("args"), dict) else {}
    if cmd in ("halt", "resume"):
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
