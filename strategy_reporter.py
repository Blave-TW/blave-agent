"""
Strategy reporter: scans the agent's workspace/strategies/ and reports the
inventory to the Blave backend (POST /openclaw/agent/strategies), so the
workspace left pane can list this machine's strategies. Runs on a timer —
strategies change rarely, and the web reads a Redis cache, not the VM live.

VM auth = proxy-{ttyd_password} (BLAVE_PROXY_TOKEN), same trust model as the
LLM proxy and the chat transport: the token resolves to this user only.
"""
import json
import os
import re
import sys
import urllib.request

WORKSPACE = os.environ.get("BLAVE_AGENT_WORKSPACE", "/opt/blave-agent/workspace")
STRATEGIES_DIR = os.path.join(WORKSPACE, "strategies")
API_URL = os.environ.get(
    "BLAVE_STRATEGIES_URL", "https://api.blave.org/openclaw/agent/strategies"
)
PROXY_TOKEN = os.environ.get("BLAVE_PROXY_TOKEN", "")

# Strategy files set STRATEGY_NAME / MODE near the top (see references/
# strategy-code.md). MODE="live" = deployed for live trading -> "live";
# anything else (backtest/draft) -> "draft".
_NAME_RE = re.compile(r'^\s*STRATEGY_NAME\s*=\s*["\']([^"\']+)["\']', re.M)
_MODE_RE = re.compile(r'^\s*MODE\s*=\s*["\']([^"\']+)["\']', re.M)
# Human-facing name + one-line blurb the agent sets (references/strategy-code.md
# › Naming & description). STRATEGY_NAME stays the technical id; these drive the
# workspace list/detail so a user isn't reading snake_case ids.
_DISPLAY_RE = re.compile(r'^\s*DISPLAY_NAME\s*=\s*["\']([^"\']+)["\']', re.M)
_DESC_RE = re.compile(r'^\s*DESCRIPTION\s*=\s*["\']([^"\']*)["\']', re.M)


def _extract(path, fallback_name):
    try:
        with open(path) as f:
            src = f.read()
    except OSError:
        return None
    m = _NAME_RE.search(src)
    name = m.group(1) if m else fallback_name
    mode = _MODE_RE.search(src)
    status = "live" if (mode and mode.group(1).lower() == "live") else "draft"
    dm = _DISPLAY_RE.search(src)
    ds = _DESC_RE.search(src)
    # Ship the source too so the workspace can show it on click without a VM
    # round-trip. Files are small (a few KB); keep a sane cap so a runaway one
    # can't bloat the cache/stream. display_name falls back to the technical id
    # when the strategy predates the DISPLAY_NAME convention.
    return {
        "name": name,
        "display_name": dm.group(1) if dm else name,
        "description": ds.group(1) if ds else "",
        "status": status,
        "code": src[:100000],
    }


def _read_backtest(name):
    """Backtest output (lib/runner.py) always lands in strategies/<name>/stats.json
    — metrics + daily equity series, feeding the workspace's 回測數據 tab. Returns
    the parsed dict, or None when the strategy has no backtest yet / it's unreadable.
    The daily arrays make this the heaviest field; it rides the same cache/stream as
    `code`, fine for a handful of strategies — split to an on-demand fetch if a fleet
    of strategies ever bloats the payload."""
    path = os.path.join(STRATEGIES_DIR, name, "stats.json")
    try:
        with open(path) as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def scan():
    """Handles both layouts: strategies/<name>.py (single file) and
    strategies/<name>/strategy.py (Type C portfolio subdir). Skips the
    TEMPLATE_* scaffolding files (not the user's strategies) and dedupes by
    name (a name existing as both a .py and a dir shows once, live winning)."""
    by_name = {}
    if not os.path.isdir(STRATEGIES_DIR):
        return []
    for entry in sorted(os.listdir(STRATEGIES_DIR)):
        if entry.startswith(".") or entry == "__pycache__" or entry.startswith("TEMPLATE"):
            continue
        full = os.path.join(STRATEGIES_DIR, entry)
        if os.path.isfile(full) and entry.endswith(".py"):
            s = _extract(full, entry[:-3])
        elif os.path.isdir(full):
            sp = os.path.join(full, "strategy.py")
            # A dir with no strategy.py is the backtest OUTPUT folder (stats.json /
            # pnl.png that run.py writes to strategies/<name>/), not a strategy. Skip
            # it — otherwise this empty shell dedupe-clobbers the real <name>.py source
            # (both 'draft', dir sorts first), wiping its code + DISPLAY_NAME.
            if not os.path.isfile(sp):
                continue
            s = _extract(sp, entry)
        else:
            continue
        if not s:
            continue
        bt = _read_backtest(s["name"])
        if bt is not None:
            s["backtest"] = bt
        prev = by_name.get(s["name"])
        # keep the live one if a name shows up twice
        if prev is None or (prev["status"] != "live" and s["status"] == "live"):
            by_name[s["name"]] = s
    return list(by_name.values())


def report_cache(strategies, token=None):
    """POST the list to the backend cache (GET /strategies reads this on page
    load / reload). Reused by the timer AND by web_bridge after each turn."""
    token = token or PROXY_TOKEN
    data = json.dumps({"strategies": strategies}).encode()
    req = urllib.request.Request(
        API_URL, data=data,
        headers={"Content-Type": "application/json", "x-api-key": f"proxy-{token}"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.read().decode()


def main():
    """Timer entry point (fallback path): scan + update the cache. The live
    path is web_bridge pushing a strategies chunk on the chat stream after
    each turn — this timer only covers idle / out-of-band changes."""
    if not PROXY_TOKEN:
        print("[strategy_reporter] BLAVE_PROXY_TOKEN not set; exiting", file=sys.stderr)
        sys.exit(1)
    strategies = scan()
    try:
        resp = report_cache(strategies)
        print(f"[strategy_reporter] reported {len(strategies)} strategies: {resp}", file=sys.stderr)
    except Exception as e:
        print(f"[strategy_reporter] report failed: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
