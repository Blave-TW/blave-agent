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
  - state/heartbeat/reconciler     is the auto-trader alive
  - allocators/<n>/                available weighting methods + their walk-forward
                                   results, for the 配置方法 comparison
  - manager/stats.json             same, for the built-in method

Targets are computed here rather than in the browser: the sizing formula
(account_value × leverage × weight × position) decides real position sizes, and
a second implementation elsewhere is a second thing that can drift. We import
the workspace's own lib/portfolio.py so there is exactly one.

VM auth = proxy-{ttyd_password} (BLAVE_PROXY_TOKEN), same trust model as the
chat transport and strategy_reporter: the token resolves to this user only.
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.request

WORKSPACE = os.environ.get("BLAVE_AGENT_WORKSPACE", "/opt/blave-agent/workspace")
STATE_DIR = os.environ.get("BLAVE_AGENT_STATE", "/opt/blave-agent/state")
API_URL = os.environ.get(
    "BLAVE_PORTFOLIO_URL", "https://api.blave.org/openclaw/agent/portfolio"
)
PROXY_TOKEN = os.environ.get("BLAVE_PROXY_TOKEN", "")

ORDERS_TAIL = 20  # 最近下單只給一屏的量,orders.jsonl 會一直長
HEARTBEAT_STALE_S = 300  # reconciler 每 5 秒 touch 一次;超過這個就當它死了

# Allocator metadata, same top-of-file-constant convention as strategies. Parsed
# rather than imported: the reporter must never execute user code.
_DISPLAY_RE = re.compile(r'^\s*DISPLAY_NAME\s*=\s*["\']([^"\']+)["\']', re.M)
_DESC_RE = re.compile(r'^\s*DESCRIPTION\s*=\s*["\']([^"\']*)["\']', re.M)
_PARAMS_RE = re.compile(r"^\s*PARAMS\s*=\s*(\{[^}]*\})", re.M)


def _read_json(path, default=None):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def _read_backtest(path):
    """management_backtest.py output, minus `weights_history`.

    That field is a full strategies × OOS-days matrix — by far the biggest thing
    in the file, and it only feeds the stacked-area panel of pnl.png, which the
    web does not draw. `managed_returns` (one float per day) is what the
    comparison chart needs, and it stays.
    """
    data = _read_json(path)
    if isinstance(data, dict):
        data.pop("weights_history", None)
    return data


def _mtime(path):
    try:
        return int(os.path.getmtime(path))
    except OSError:
        return None


def scheduled_strategies():
    """Names that have a run_strategy.sh entry in the agent's crontab.

    A weighted strategy with no schedule is the quiet failure this whole view
    exists to surface: state.json never updates, so the reconciler keeps sizing
    a real position from a signal that stopped moving days ago. Returns None
    (not an empty set) when crontab can't be read, so the UI can say "unknown"
    instead of accusing every strategy of being unscheduled.
    """
    try:
        out = subprocess.run(
            ["crontab", "-l"], capture_output=True, text=True, timeout=10
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        return set() if "no crontab" in (out.stderr or "").lower() else None
    return set(re.findall(r"run_strategy\.sh\s+(\S+)", out.stdout))


def strategy_states():
    """{name: {symbol, position, updated_at}} from every strategies/*/state.json."""
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
            "updated_at": _mtime(path),
        }
    return states


def targets():
    """Per-symbol target exposure, computed by the workspace's own aggregator.

    Returns None if it can't run — the view then shows weights without dollar
    targets rather than showing numbers this file invented.
    """
    try:
        cwd = os.getcwd()
    except OSError:
        cwd = None
    try:
        os.chdir(WORKSPACE)  # lib/portfolio.py resolves every path relative to it
        sys.path.insert(0, WORKSPACE)
        from lib.portfolio import aggregate_portfolio

        return aggregate_portfolio()
    except Exception as e:
        print(f"[portfolio_reporter] aggregate_portfolio failed: {e}", file=sys.stderr)
        return None
    finally:
        if WORKSPACE in sys.path:
            sys.path.remove(WORKSPACE)
        # Best-effort restore. Under the systemd unit the original cwd is always
        # readable, but this also gets run ad-hoc (`python3 -c "import
        # portfolio_reporter"`) from wherever the caller happened to be — and a
        # cwd the agent user can't chdir back into would otherwise raise out of
        # `finally` and throw away a report that was already built.
        if cwd:
            try:
                os.chdir(cwd)
            except OSError:
                pass


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


def allocators():
    """Weighting methods available on this machine, plus each one's walk-forward
    result. The built-in optimiser is not a file, so it is reported separately
    (see build_report) from manager/stats.json."""
    root = os.path.join(WORKSPACE, "allocators")
    out = []
    try:
        entries = sorted(os.listdir(root))
    except OSError:
        return out
    for name in entries:
        src_path = os.path.join(root, name, "allocator.py")
        if not os.path.isfile(src_path):
            continue  # TEMPLATE.py and stray files are not allocators
        try:
            with open(src_path) as f:
                src = f.read()
        except OSError:
            continue
        dm, ds, pm = (
            _DISPLAY_RE.search(src),
            _DESC_RE.search(src),
            _PARAMS_RE.search(src),
        )
        out.append({
            "name": name,
            "display_name": dm.group(1) if dm else name,
            "description": ds.group(1) if ds else "",
            # Raw source, not eval'd — the web renders the declared knobs, and
            # executing a user file to read a dict is not worth the blast radius.
            "params_src": pm.group(1) if pm else "",
            "backtest": _read_backtest(os.path.join(root, name, "stats.json")),
        })
    return out


def build_report():
    cfg = _read_json(os.path.join(WORKSPACE, "manager", "portfolio_config.json"), {})
    hb = _mtime(os.path.join(STATE_DIR, "heartbeat", "reconciler"))
    last = _read_json(os.path.join(WORKSPACE, "manager", "last_reconcile.json"))
    sched = scheduled_strategies()

    return {
        "config": cfg,
        "states": strategy_states(),
        # None = couldn't tell (no crontab access), [] = genuinely nothing scheduled
        "scheduled": None if sched is None else sorted(sched),
        "targets": targets(),
        "last_reconcile": last,
        "orders": recent_orders(),
        "reconciler": {
            "heartbeat_at": hb,
            "alive": bool(hb and (time.time() - hb) < HEARTBEAT_STALE_S),
        },
        "allocators": allocators(),
        # The built-in method's own walk-forward, so it can sit in the same
        # comparison table as the user's allocators.
        "builtin_backtest": _read_backtest(
            os.path.join(WORKSPACE, "manager", "stats.json")
        ),
        "reported_at": int(time.time()),
    }


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
