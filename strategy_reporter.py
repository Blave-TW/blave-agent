"""
Strategy reporter: scans the agent's workspace/strategies/ and reports the
inventory to the Blave backend (POST /openclaw/agent/strategies), so the
workspace left pane can list this machine's strategies. Runs on a timer —
strategies change rarely, and the web reads a Redis cache, not the VM live.

VM auth = proxy-{ttyd_password} (BLAVE_PROXY_TOKEN), same trust model as the
LLM proxy and the chat transport: the token resolves to this user only.
"""
import ast
import base64
import json
import os
import re
import sys
import urllib.request

WORKSPACE = os.environ.get("BLAVE_AGENT_WORKSPACE", "/opt/blave-agent/workspace")
STRATEGIES_DIR = os.path.join(WORKSPACE, "strategies")
STATE_DIR = os.environ.get("BLAVE_AGENT_STATE", "/opt/blave-agent/state")

# 回測 tab 的附件圖:strategies/<name>/ 內的圖檔(pnl.png、param heatmap…)。
# 上限防single檔爆量;數量取 mtime 最新的 N 張。
_IMG_EXTS = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
             ".webp": "image/webp", ".gif": "image/gif"}
_IMG_MAX_BYTES = 2 * 1024 * 1024
_IMG_MAX_COUNT = 8
_IMG_SIG_PATH = os.path.join(STATE_DIR, "strategy_images_sig.json")
API_URL = os.environ.get(
    "BLAVE_STRATEGIES_URL", "https://api.blave.org/openclaw/agent/strategies"
)
PROXY_TOKEN = os.environ.get("BLAVE_PROXY_TOKEN", "")

# Strategy files set these near the top (see references/strategy-code.md).
# STRATEGY_NAME is the technical id; DISPLAY_NAME / DESCRIPTION are the
# human-facing name + one-line blurb driving the workspace list/detail, so a
# user isn't reading snake_case ids. MODE="live" = deployed for live trading ->
# "live"; anything else (backtest/draft) -> "draft".
FIELDS = ("STRATEGY_NAME", "DISPLAY_NAME", "DESCRIPTION", "MODE")
# Fallback only — see strategy_consts(). A quote inside the value ends the match
# early here ("Bob's BTC trend" -> "Bob"), which is why ast is the primary path.
_FALLBACK_RE = {
    field: re.compile(r'^\s*%s\s*=\s*["\']([^"\']*)["\']' % field, re.M)
    for field in FIELDS
}


def strategy_consts(src):
    """The module-level string constants above, as a dict (missing keys absent).

    Parsed with `ast`, not regex: a name or blurb containing an ASCII quote —
    `DISPLAY_NAME = "Bob's BTC trend"` — used to be silently truncated at that
    quote, which reads as a half-written name rather than an obvious failure.
    Falls back to the regexes when the file doesn't parse: a strategy with a
    syntax error still has to show up in the workspace list.
    """
    out = {}
    try:
        tree = ast.parse(src)
    except (SyntaxError, ValueError):
        for field, pattern in _FALLBACK_RE.items():
            m = pattern.search(src)
            if m:
                out[field] = m.group(1)
        return out
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign):
            continue
        if not isinstance(node.value, ast.Constant) or not isinstance(node.value.value, str):
            continue
        for target in node.targets:
            # first assignment wins, matching the regexes this replaced
            if isinstance(target, ast.Name) and target.id in FIELDS and target.id not in out:
                out[target.id] = node.value.value
    return out


def _extract(path, fallback_name):
    try:
        # utf-8 explicit: Windows opens with the locale codepage and strategies
        # carry Chinese comments — a UnicodeDecodeError is not OSError and would
        # kill the whole scan. errors="replace" also keeps name resolution
        # identical to the delete path's read (command_listener).
        with open(path, encoding="utf-8", errors="replace") as f:
            src = f.read()
    except OSError:
        return None
    consts = strategy_consts(src)
    name = consts.get("STRATEGY_NAME") or fallback_name
    status = "live" if consts.get("MODE", "").lower() == "live" else "draft"
    # Ship the source too so the workspace can show it on click without a VM
    # round-trip. Files are small (a few KB); keep a sane cap so a runaway one
    # can't bloat the cache/stream. display_name falls back to the technical id
    # when the strategy predates the DISPLAY_NAME convention.
    return {
        "name": name,
        "display_name": consts.get("DISPLAY_NAME") or name,
        "description": consts.get("DESCRIPTION") or "",
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


def _list_images(name):
    """(mtime, file, path, mime) for the newest ≤N image files under
    strategies/<name>/, oldest→newest so the tab reads left→right in time order."""
    d = os.path.join(STRATEGIES_DIR, name)
    out = []
    try:
        entries = os.listdir(d)
    except OSError:
        return out
    for f in entries:
        ext = os.path.splitext(f)[1].lower()
        mime = _IMG_EXTS.get(ext)
        if not mime:
            continue
        p = os.path.join(d, f)
        try:
            st = os.stat(p)
        except OSError:
            continue
        if not os.path.isfile(p) or st.st_size > _IMG_MAX_BYTES:
            continue
        out.append((st.st_mtime, f, p, mime))
    out.sort()
    return out[-_IMG_MAX_COUNT:]


def attach_images(strategies):
    """TIMER-PATH ONLY: base64 the strategy dirs' chart images into the report.
    Deliberately NOT part of scan() — the mid-turn live push rides the 2MB-capped
    webchat /report and images would blow it; the api carries images over when a
    report omits them, so the web still shows them. A signature file skips
    re-uploading unchanged sets every 2 minutes. Returns the new signature dict
    for the caller to persist AFTER a successful POST."""
    old_sigs = {}
    try:
        with open(_IMG_SIG_PATH) as f:
            old_sigs = json.load(f)
    except (OSError, ValueError):
        pass
    new_sigs = {}
    for s in strategies:
        imgs = _list_images(s["name"])
        sig = [[f, int(m)] for (m, f, _p, _mime) in imgs]
        new_sigs[s["name"]] = sig
        if old_sigs.get(s["name"]) == sig:
            continue  # unchanged → omit key; the api keeps the previous set
        payload = []
        for (_m, f, p, mime) in imgs:
            try:
                with open(p, "rb") as fh:
                    payload.append({"file": f, "mime": mime,
                                    "b64": base64.b64encode(fh.read()).decode()})
            except OSError:
                continue
        s["images"] = payload  # [] = 圖被清掉,明確清空
    return new_sigs


def save_image_sigs(sigs):
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(_IMG_SIG_PATH, "w") as f:
            json.dump(sigs, f)
    except OSError:
        pass


def _config_version():
    """workspace 根的 VERSION(config 更新流程會 copy 進來)。讀不到 = None,
    fail-soft:舊機沒這個檔是常態,不值得噪音。"""
    try:
        with open(os.path.join(WORKSPACE, "VERSION")) as f:
            return f.read().strip() or None
    except OSError:
        return None


def report_cache(strategies, token=None):
    """POST the list to the backend cache (GET /strategies reads this on page
    load / reload). Reused by the timer AND by web_bridge after each turn.
    Piggybacks config_version so the web can flag an outdated workspace config."""
    token = token or PROXY_TOKEN
    payload = {"strategies": strategies}
    version = _config_version()
    if version:
        payload["config_version"] = version
    data = json.dumps(payload).encode()
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
    sigs = attach_images(strategies)
    try:
        resp = report_cache(strategies)
        save_image_sigs(sigs)  # 成功送達才記,失敗下輪重送
        print(f"[strategy_reporter] reported {len(strategies)} strategies: {resp}", file=sys.stderr)
    except Exception as e:
        print(f"[strategy_reporter] report failed: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
