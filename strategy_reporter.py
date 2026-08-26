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
import gzip
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
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
# Socket timeout per image, and a wall-clock ceiling on the uploads of one call.
# The budget is the load-bearing one: uploads are sequential, so an api that hangs
# (rather than answering) costs timeout × every image. Measured on 29026 with the
# endpoint unreachable: 5 images = 150s, and blave-agent-strategies.service is
# killed at TimeoutStartSec=120, so the report that the fallback exists to save
# never got sent. The same call also runs at turn end (web_bridge.sync_strategies),
# ahead of the live chunk the open workspace is waiting for. Past the budget the
# remaining images just take the inline-base64 path — which is what they did before
# S3 existed, so nothing is lost by giving up early.
_IMG_UPLOAD_TIMEOUT = 15
_IMG_UPLOAD_BUDGET_SEC = 30
API_URL = os.environ.get(
    "BLAVE_STRATEGIES_URL", "https://api.blave.org/openclaw/agent/strategies"
)
# Image bytes go here (PUT /{sha256}), not into the report — see attach_images().
IMAGE_URL = os.environ.get(
    "BLAVE_STRATEGY_IMAGE_URL", "https://api.blave.org/openclaw/agent/strategy_image"
)
PROXY_TOKEN = os.environ.get("BLAVE_PROXY_TOKEN", "")

# Full-history chart export (lib/runner.py writes strategies/<name>/chart/) → S3 via
# /openclaw/agent/chart_data, chunk by chunk, OUTSIDE the strategies report above (that
# channel is 16MB-capped and carries stats.json tails for first paint). Progress is
# persisted per chunk so a failed tick resumes instead of re-sending; the manifest hash
# is the content hash, so an identical re-backtest uploads nothing.
CHART_URL = os.environ.get(
    "BLAVE_CHART_URL", "https://api.blave.org/openclaw/agent/chart_data"
)
_CHART_STATE_PATH = os.path.join(STATE_DIR, "strategy_chart_sync.json")
_CHART_CHUNK_GZ_MAX = 4 * 1024 * 1024  # mirrored in api/openclaw/agent_chart_data.py
# systemd TimeoutStartSec=120: budget + one in-flight request (45s) + the report POST
# (15s) must stay under it — stop early, resume next tick
_CHART_TICK_BUDGET_SEC = 45
_CHART_REQUEST_TIMEOUT = 45
# A 409 (manifest not uploaded / chunks missing) means the api lost our staged set —
# e.g. commit hit the total-size cap and swept it — so the persisted progress is a lie:
# start that hash over. Bounded so a 409 that never clears can't loop every tick forever.
_CHART_MAX_RESETS = 3
_CHART_NAME_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")

# Coarse-bucket overview stored next to the chunks (PUT .../overview): a two-year 1min set
# is ~1M bars the web cannot draw zoomed out, so one ≤ ~20,000-bar OHLCV / pane / trade
# summary is built here from the local chunk files once they're all up. Pure Python —
# the reporter runs on the VM without pandas. Contract: overview-contract (batch 2).
# Intermediate levels (PUT .../overview/<bucket>, ≤ 80,000 bars, no trades) fill the gap
# between the coarsest bucket and raw chunks; the coarsest lists them in `levels`.
_OVERVIEW_TARGET_BARS = 20000
_OVERVIEW_LEVEL_MAX_BARS = 80000
_OVERVIEW_BUCKETS = (300, 900, 1800, 3600, 14400, 86400)
_OVERVIEW_MAX_TRADES = 50000
_CHART_LEVEL_GZ_MAX = 8 * 1024 * 1024  # api OVERVIEW_LEVEL_GZ_MAX_BYTES
# Build + PUT retried across ticks (timeout, 5xx); bounded so a box that can never parse
# 50 chunks inside the budget stops burning CPU every 2 minutes.
_OVERVIEW_MAX_ATTEMPTS = 5  # real failures (5xx / 429 on PUT)
_OVERVIEW_MAX_DEFERRED = 40  # build timeouts / chunk swaps / transient file errors (~80 min)
_INTERVAL_RE = re.compile(r"(\d+)\s*([a-z]+)")
_INTERVAL_UNIT_SEC = {
    "m": 60, "min": 60, "mins": 60, "minute": 60, "minutes": 60, "t": 60,
    "h": 3600, "hr": 3600, "hour": 3600, "hours": 3600,
    "d": 86400, "day": 86400, "days": 86400,
    "w": 604800, "week": 604800, "weeks": 604800,
}

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


def is_portfolio_stats(stats):
    """True only when this stats.json POSITIVELY identifies a Type C portfolio
    backtest. Basis (blaveclaw-config lib/runner.py): the Type C branch writes
    the random_bh_benchmark `benchmark_*` fields and no `symbol` key at all,
    while the Type A branch always writes `symbol` and never calls
    random_bh_benchmark. Both signals must agree — an old Type A stats.json
    that predates the symbol field has no benchmark_* keys either, so it stays
    False. Anything ambiguous (no stats, unknown shape) is False: this feeds
    fund-blocking (command_listener._cmd_amounts) and the web picker's grey-out,
    where wrongly blocking a real Type A strands its config; a missed Type C
    merely keeps today's behavior. Single classification source — the
    command_listener guard imports this rather than re-deriving it."""
    if not isinstance(stats, dict):
        return False
    sym = stats.get("symbol")
    if isinstance(sym, str) and sym.strip():
        return False
    return any(isinstance(k, str) and k.startswith("benchmark_") for k in stats)


def _read_backtest(name):
    """Backtest output (lib/runner.py) always lands in strategies/<name>/stats.json
    — metrics + daily equity series + candles/panes/trades tails (≈1.7MB per 5min
    strategy), feeding the workspace's 回測數據 / 進出場紀錄 tabs. Returns the parsed
    dict, or None when the strategy has no backtest yet / it's unreadable. Carried in
    full only by report_cache (16MB endpoint); live chunks go through live_chunk()."""
    path = os.path.join(STRATEGIES_DIR, name, "stats.json")
    try:
        with open(path) as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _stats_marker(name, status):
    """What signature() tracks for strategies/<name>/stats.json. A string either
    way — the whole signature is an opaque fingerprint, and same-typed elements
    keep sorted() total no matter what the other two columns hold.

    draft → mtime+size: this file belongs to the agent, and a re-run that
    overwrites it in place should reach the open workspace mid-turn.
    live → existence only: a deployed strategy's stats.json belongs to the
    per-bar tick thread (command_listener._tick_one → blaveclaw-config
    lib/runner.py rewrites it on every close, unconditionally — the `mode ==
    'backtest'` gate below that write only guards the chart export). Tracking its
    mtime would fire a full scan + a ≤1.5MB chunk + a workspace redraw once a
    bar, mid-conversation, for something the user never asked about — worst on
    exactly the users with real money running. Existence is the sensitivity the
    bool(backtest) fingerprint had, and the unconditional turn-end sync in
    web_bridge still carries anything the agent really changed.

    ValueError as well as OSError: `name` is the strategy file's STRATEGY_NAME
    constant, i.e. any string ast can parse — an embedded NUL or a lone surrogate
    makes os.stat raise ValueError, and letting that escape would take the whole
    turn's live push down with it. Matches _read_backtest's except clause."""
    try:
        st = os.stat(os.path.join(STRATEGIES_DIR, name, "stats.json"))
    except (OSError, ValueError):
        return "none"
    if status == "live":
        return "exists"
    return f"{st.st_mtime_ns}:{st.st_size}"


def signature():
    """Cheap "has the inventory changed" fingerprint: name + status + the stats
    marker above, with no stats.json parsed. agent_turn calls this after every
    tool step and only pays for scan() when it differs — a 5min strategy's
    stats.json is ~4.7MB, and parsing three of them on every step (0.30s vs
    0.004s, measured on uid=32321) lagged every chunk behind for nothing.

    Not free, though: _scan_sources() still reads and ast-parses every strategy
    file. That is milliseconds against hundreds, but it is not "one stat"."""
    return json.dumps(sorted(
        [s["name"], s["status"], _stats_marker(s["name"], s["status"])]
        for s in _scan_sources()
    ))


def _scan_sources():
    """Enumeration + source parse, WITHOUT reading stats.json. Shared by scan()
    and signature() so the layout rules live in exactly one place.

    Handles both layouts: strategies/<name>.py (single file) and
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
        prev = by_name.get(s["name"])
        # keep the live one if a name shows up twice
        if prev is None or (prev["status"] != "live" and s["status"] == "live"):
            by_name[s["name"]] = s
    return list(by_name.values())


def scan():
    """The full inventory: sources plus each strategy's parsed backtest."""
    strategies = _scan_sources()
    for s in strategies:
        bt = _read_backtest(s["name"])
        if bt is not None:
            s["backtest"] = bt
        # Web-side hint so the 下單設定 picker can grey the checkbox out; the
        # authoritative block is _cmd_amounts' save-time guard (a stale cache
        # here must not be the only defense). False when unknown — fail open,
        # see is_portfolio_stats.
        s["is_portfolio"] = is_portfolio_stats(bt)
    return strategies


# Live `strategies` chunks ride the webchat /report channel, capped at REPORT_BODY_MAX
# (2MB, api/openclaw/webchat.py) — unlike report_cache's 16MB endpoint. Headroom for the
# chunk wrapper + session_id.
_LIVE_CHUNK_BUDGET = int(1.5 * 1024 * 1024)
# Stripped tier by tier until the chunk fits. The web redraws the open strategy from
# every live chunk: tier 1 loses the 進出場紀錄 K 線/trades (back after the turn-end
# cache refetch), tier 2 also the equity curve — the list/status/metrics always arrive.
_LIVE_STRIP_TIERS = (("candles", "panes", "trades"), ("daily_dates", "daily_returns"))


def live_chunk(strategies):
    """The `strategies` chunk for the chat stream (agent_turn mid-turn, web_bridge at
    turn end / after a command). Never images; the heavy backtest arrays only while the
    whole chunk stays under the /report cap — 7 strategies × 20k-candle tails = 413 and
    the workspace stopped updating (29026, 2026-08-21). Does not mutate `strategies`."""
    out = [{k: v for k, v in s.items() if k != "images"} for s in strategies]
    chunk = {"type": "strategies", "strategies": out}
    for tier in _LIVE_STRIP_TIERS:
        if len(json.dumps(chunk)) <= _LIVE_CHUNK_BUDGET:
            break
        for s in out:
            bt = s.get("backtest")
            if isinstance(bt, dict):
                s["backtest"] = {k: v for k, v in bt.items() if k not in tier}
    return chunk


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


def _put_image(data, mime, token):
    """Upload one image to S3 via the api and return its {hash} reference, or None so
    the caller falls back to inline base64. Content-addressed: re-sending identical
    bytes overwrites the same key, so a retry after a failed report costs one PUT."""
    h = hashlib.sha256(data).hexdigest()
    req = urllib.request.Request(
        f"{IMAGE_URL}/{h}", data=data, method="PUT",
        headers={"Content-Type": mime, "x-api-key": f"proxy-{token}"},
    )
    try:
        urllib.request.urlopen(req, timeout=_IMG_UPLOAD_TIMEOUT).read()
    except Exception as e:
        print(f"[strategy_reporter] image upload failed: {e}", file=sys.stderr)
        return None
    return h


def attach_images(strategies, token=None):
    """TIMER-PATH ONLY: attach the strategy dirs' chart images to the report.
    Deliberately NOT part of scan() — the mid-turn live push rides the 2MB-capped
    webchat /report and images would blow it; the api carries images over when a
    report omits them, so the web still shows them. A signature file skips
    re-sending unchanged sets every 2 minutes. Returns the new signature dict
    for the caller to persist AFTER a successful POST.

    The bytes go to S3 (PUT /openclaw/agent/strategy_image/{hash}) and the report
    carries only {file, mime, hash} — the strategies cache is one 16MB-capped Redis
    key for the user's whole inventory, and base64 images were what filled it. An
    upload that fails falls back to inline base64: the api converts it on arrival,
    so the picture still reaches the workspace either way."""
    token = token or PROXY_TOKEN
    deadline = time.monotonic() + _IMG_UPLOAD_BUDGET_SEC
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
                    data = fh.read()
            except OSError:
                continue
            h = _put_image(data, mime, token) if time.monotonic() < deadline else None
            entry = {"file": f, "mime": mime}
            entry["hash" if h else "b64"] = h or base64.b64encode(data).decode()
            payload.append(entry)
        s["images"] = payload  # [] = 圖被清掉,明確清空
    return new_sigs


def save_image_sigs(sigs):
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(_IMG_SIG_PATH, "w") as f:
            json.dump(sigs, f)
    except OSError:
        pass


class _ChartHTTPError(Exception):
    """HTTP 4xx/5xx from the chart api, with the status and a body excerpt for logs."""

    def __init__(self, code, body):
        super().__init__(f"HTTP {code}: {body}")
        self.code = code

    @property
    def permanent(self):
        """Retrying the same bytes can't fix it (except 429 = rate limited, and 409 =
        staged set gone, which the caller handles by starting over)."""
        return 400 <= self.code < 500 and self.code not in (409, 429)


def _chart_request(method, url, body, token, content_encoding=None):
    headers = {"x-api-key": f"proxy-{token}", "Content-Type": "application/json"}
    if content_encoding:
        headers["Content-Encoding"] = content_encoding
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=_CHART_REQUEST_TIMEOUT) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        try:
            excerpt = e.read(200).decode("utf-8", "replace").strip()
        except Exception:
            excerpt = ""
        raise _ChartHTTPError(e.code, excerpt) from None


def _load_chart_state():
    try:
        with open(_CHART_STATE_PATH) as f:
            state = json.load(f)
        return state if isinstance(state, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_chart_state(state):
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        tmp = _CHART_STATE_PATH + ".tmp"
        with open(tmp, "w") as f:
            json.dump(state, f)
        os.replace(tmp, _CHART_STATE_PATH)
    except OSError:
        pass


def _save_chart_state_entry(name, entry):
    state = _load_chart_state()
    state[name] = entry
    _save_chart_state(state)


def _read_chart_manifest(name):
    path = os.path.join(STRATEGIES_DIR, name, "chart", "manifest.json")
    try:
        with open(path) as f:
            m = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(m, dict) or not isinstance(m.get("hash"), str):
        return None
    if not isinstance(m.get("chunks"), list):
        return None
    return m


def _read_chunk(name, c):
    """Raw bytes of strategies/<name>/chart/chunk-<id>.json, or None when its sha1 no
    longer matches the manifest — the runner swapped a new set in under us."""
    path = os.path.join(STRATEGIES_DIR, name, "chart", f"chunk-{c.get('id')}.json")
    with open(path, "rb") as f:
        raw = f.read()
    return raw if hashlib.sha1(raw).hexdigest() == c.get("sha1") else None


def _interval_sec(interval):
    """manifest.interval ("1m" / "5min" / "1h" / "1d" …) → seconds, or None."""
    if not isinstance(interval, str):
        return None
    m = _INTERVAL_RE.fullmatch(interval.strip().lower())
    if not m:
        return None
    unit = _INTERVAL_UNIT_SEC.get(m.group(2))
    return int(m.group(1)) * unit if unit and int(m.group(1)) > 0 else None


def _median_step(ts_list):
    diffs = sorted(b - a for a, b in zip(ts_list, ts_list[1:]) if b > a)
    return diffs[len(diffs) // 2] if diffs else None


def _pick_bucket(span_sec, base_sec):
    """Smallest contract bucket wider than a raw bar that keeps the overview ≤ target
    bars; the widest one regardless when even that overflows (api tolerates 25,000).
    None when no bucket is wider than the raw bar (daily+ data never needs one)."""
    wider = [b for b in _OVERVIEW_BUCKETS if b > base_sec]
    for b in wider:
        if span_sec // b + 1 <= _OVERVIEW_TARGET_BARS:
            return b
    return wider[-1] if wider else None


def _pick_levels(coarsest, span_sec, base_sec):
    """Intermediate buckets, coarse→fine: from the coarsest, repeatedly the largest
    ladder bucket ≤ a quarter of the current one that is wider than a raw bar and keeps
    the level ≤ 80,000 bars. 1min/2y → [900]; 5min/7y → [3600]; 15min/2y → []."""
    levels = []
    cur = coarsest
    while True:
        fits = [b for b in _OVERVIEW_BUCKETS
                if base_sec < b <= cur // 4 and span_sec // b + 1 <= _OVERVIEW_LEVEL_MAX_BARS]
        if not fits:
            return levels
        cur = fits[-1]
        levels.append(cur)


class _OverviewAgg:
    """Streaming bucket aggregation over chunks fed in time order (manifest chunks are
    ascending and disjoint): candles o=first h=max l=min c=last v=sum (null if any raw
    v is null); panes = last raw value per bucket, series metadata from the first chunk;
    trades = union keyed by ts (coarsest only — levels leave trades to it)."""

    def __init__(self, bucket, with_trades=True):
        self.bucket = bucket
        self.with_trades = with_trades
        self.candles = {}
        self.panes = None
        self.trades = {}

    def add(self, body):
        b = self.bucket
        candles = self.candles
        for row in body.get("candles") or []:
            ts, o, h, l, c = row[:5]
            v = row[5] if len(row) > 5 else None
            bts = ts // b * b
            cur = candles.get(bts)
            if cur is None:
                candles[bts] = [bts, o, h, l, c, v]
                continue
            if h > cur[2]:
                cur[2] = h
            if l < cur[3]:
                cur[3] = l
            cur[4] = c
            cur[5] = None if v is None or cur[5] is None else cur[5] + v
        panes = body.get("panes") or []
        if self.panes is None:
            self.panes = [{**{k: v for k, v in p.items() if k != "points"}, "points": {}}
                          for p in panes]
        for agg, p in zip(self.panes, panes):
            pts = agg["points"]
            for ts, v in p.get("points") or []:
                pts[ts // b * b] = v
        if not self.with_trades:
            return
        for t in body.get("trades") or []:
            self.trades[t["ts"]] = t
        # Chunks arrive oldest-first, so pruning the oldest keys once we hold 2× the cap
        # keeps memory bounded on bar-by-bar strategies (hundreds of thousands of trades
        # over two years of 1min) without changing result(): it keeps the newest anyway.
        if len(self.trades) > 2 * _OVERVIEW_MAX_TRADES:
            for k in sorted(self.trades)[: len(self.trades) - _OVERVIEW_MAX_TRADES]:
                del self.trades[k]
            self.trades_pruned = True

    def result(self):
        candles = [self.candles[k] for k in sorted(self.candles)]
        panes = [{**p, "points": [[k, p["points"][k]] for k in sorted(p["points"])]}
                 for p in self.panes or []]
        trades = [self.trades[k] for k in sorted(self.trades)]
        truncated = len(trades) > _OVERVIEW_MAX_TRADES or getattr(self, "trades_pruned", False)
        if truncated:
            trades = trades[-_OVERVIEW_MAX_TRADES:]
        return candles, panes, trades, truncated


class _ChartChanged(Exception):
    """A chunk's sha1 stopped matching the manifest mid-read (runner swapped the set)."""


class _ChartTimeout(Exception):
    """Tick deadline hit; the caller retries on a later tick."""


def _overview_plan(name, manifest):
    """(base_sec, coarsest bucket, [level buckets]) for this manifest, or None when the
    set is ≤ target bars / has no bucket wider than a raw bar. Manifest-only unless the
    interval is unparseable (then chunk 0's median step). Raises _ChartChanged."""
    chunks = manifest["chunks"]
    if not chunks or sum(int(c.get("bars") or 0) for c in chunks) <= _OVERVIEW_TARGET_BARS:
        return None
    base_sec = _interval_sec(manifest.get("interval"))
    if base_sec is None:
        raw = _read_chunk(name, chunks[0])
        if raw is None:
            raise _ChartChanged(name)
        base_sec = _median_step([r[0] for r in json.loads(raw).get("candles") or []])
        del raw
    if not base_sec:
        return None
    span = int(chunks[-1]["t1"]) - int(chunks[0]["t0"])
    bucket = _pick_bucket(span, base_sec)
    if bucket is None:
        return None
    return base_sec, bucket, _pick_levels(bucket, span, base_sec)


def _build_overview(name, manifest, deadline, base_sec, bucket, with_trades=True):
    """One pass over the chunk files → one overview object (no `levels` key; the caller
    adds it on the coarsest), or None when there are no candles. One object per pass so
    a 2-core box can spread the coarsest and each level over ticks (the caller records
    the pass time to decide). Raises _ChartChanged / _ChartTimeout."""
    agg = _OverviewAgg(bucket, with_trades)
    for c in manifest["chunks"]:
        if time.monotonic() > deadline:
            raise _ChartTimeout(name)
        raw = _read_chunk(name, c)
        if raw is None:
            raise _ChartChanged(name)
        agg.add(json.loads(raw))
        del raw
    candles, panes, trades, truncated = agg.result()
    if not candles:
        return None
    return {
        "v": 1,
        "hash": manifest["hash"],
        "base_sec": base_sec,
        "bucket": bucket,
        "t0": candles[0][0],
        "t1": int(manifest["chunks"][-1]["t1"]),
        "candles": candles,
        "panes": panes,
        "trades": trades,
        "trades_truncated": truncated,
    }


def _timed_pass(name, manifest, entry, deadline, base_sec, bucket, with_trades=True):
    """_build_overview, remembering how long a pass takes on this box so the next one
    only starts when the tick still has room for it (see _pass_fits)."""
    t = time.monotonic()
    obj = _build_overview(name, manifest, deadline, base_sec, bucket, with_trades)
    entry["overview_pass_sec"] = round(time.monotonic() - t, 1)
    return obj


def _pass_fits(entry, deadline):
    """Room for another chunk pass this tick? Unknown speed → try (a timeout is
    counted as a deferral); otherwise 1.5× the last measured pass."""
    last = entry.get("overview_pass_sec")
    return last is None or deadline - time.monotonic() >= 1.5 * float(last)


def _put_overview_object(name, manifest, token, path, obj, gz_cap):
    """gzip + PUT one overview object. None on success; a skip reason ("too large" /
    "http 4xx") when this object can never go up as-is. 404/405 (the api predates the
    endpoint) and 409 / 429 / 5xx propagate as _ChartHTTPError for the caller's
    counters."""
    gz = gzip.compress(json.dumps(obj, separators=(",", ":")).encode(), compresslevel=6)
    if len(gz) > gz_cap:
        print(f"[strategy_reporter] chart {name} {path} too large ({len(gz)}B)", file=sys.stderr)
        return "too large"
    try:
        _chart_request("PUT", f"{CHART_URL}/{name}/{manifest['hash']}/{path}", gz, token,
                       content_encoding="gzip")
    except _ChartHTTPError as e:
        if not e.permanent or e.code in (404, 405):
            raise
        print(f"[strategy_reporter] chart {name} {path} rejected: {e}", file=sys.stderr)
        return f"http {e.code}"
    return None


def _send_overview(name, manifest, entry, token, deadline):
    """Build + PUT the overview set for an uploaded chart, resumable across ticks:
    1. coarsest (as 1.1.35) → overview_sent, planned levels → overview_levels_pending;
    2. each pending level, one chunk pass + PUT per level, only when the tick still
       has room for a pass; a level that can never go up (too large / permanent 4xx)
       is dropped, the rest carry on;
    3. once no level is pending, the coarsest is re-PUT listing the levels that made
       it → overview_levels (also [] straight away when none were planned).
    A 1.1.35 entry (sent, no overview_levels key) enters at step 2 from the manifest
    alone. Marks overview_skipped (not needed / unbuildable / rejected coarsest —
    nothing left to try for this hash). Silent on timeout and swapped chunks: a later
    tick retries. Raises _ChartHTTPError for 409 / 429 / 5xx like the chunk path."""
    # Two counters: real failures (bad data / 5xx) are capped at _OVERVIEW_MAX_ATTEMPTS;
    # build timeouts / swapped chunks / transient file errors (Defender scanning a fresh
    # chunk on Windows, the chart.tmp→chart swap window) are "deferred" and get their own,
    # looser cap so a slow machine can still finish a big set across ticks without the
    # tick budget being burned forever. Leaving a pass for the next tick is neither.
    attempts = int(entry.get("overview_attempts") or 0)
    deferred = int(entry.get("overview_deferred") or 0)
    if attempts >= _OVERVIEW_MAX_ATTEMPTS or deferred >= _OVERVIEW_MAX_DEFERRED:
        print(f"[strategy_reporter] chart {name} overview: giving up "
              f"({attempts} failures, {deferred} deferrals)", file=sys.stderr)
        _skip_overview(entry, "gave up")
        return
    try:
        plan = _overview_plan(name, manifest)
        if plan is None:
            _skip_overview(entry, "not needed")
            return
        base_sec, coarsest, levels = plan
        if not entry.get("overview_sent"):
            obj = _timed_pass(name, manifest, entry, deadline, base_sec, coarsest)
            if obj is None:
                _skip_overview(entry, "not needed")
                return
            obj["levels"] = []
            reason = _put_overview_object(name, manifest, token, "overview", obj, _CHART_CHUNK_GZ_MAX)
            del obj
            if reason:
                _skip_overview(entry, reason)
                return
            entry["overview_sent"] = True
            entry["overview_levels_pending"] = levels
            entry["overview_levels_done"] = []
            _save_chart_state_entry(name, entry)
        elif "overview_levels_pending" not in entry:
            entry["overview_levels_pending"] = levels
            entry["overview_levels_done"] = []
        pending, done = entry["overview_levels_pending"], entry["overview_levels_done"]
        while pending:
            if not _pass_fits(entry, deadline):
                return
            b = pending[0]
            obj = _timed_pass(name, manifest, entry, deadline, base_sec, b, with_trades=False)
            reason = _put_overview_object(name, manifest, token, f"overview/{b}", obj,
                                          _CHART_LEVEL_GZ_MAX) if obj else "empty"
            del obj
            if reason:
                print(f"[strategy_reporter] chart {name} overview/{b} dropped ({reason})",
                      file=sys.stderr)
            else:
                done.append(b)
            pending.pop(0)
            _save_chart_state_entry(name, entry)
        if done:
            if not _pass_fits(entry, deadline):
                return
            obj = _timed_pass(name, manifest, entry, deadline, base_sec, coarsest)
            if obj is None:
                raise _ChartChanged(name)  # had candles at step 1: the set moved under us
            obj["levels"] = list(done)
            reason = _put_overview_object(name, manifest, token, "overview", obj, _CHART_CHUNK_GZ_MAX)
            del obj
            if reason:
                _skip_overview(entry, reason)
                return
    except (_ChartChanged, _ChartTimeout, OSError) as e:
        entry["overview_deferred"] = deferred + 1
        print(f"[strategy_reporter] chart {name} overview deferred ({type(e).__name__}); "
              f"retry next tick", file=sys.stderr)
        return
    except (ValueError, TypeError, KeyError, IndexError) as e:
        print(f"[strategy_reporter] chart {name} overview unbuildable: {e!r}; skipping",
              file=sys.stderr)
        _skip_overview(entry, "unbuildable")
        return
    except _ChartHTTPError as e:
        if not e.permanent:
            entry["overview_attempts"] = attempts + 1
            raise
        # 404/405: the api in front of us predates the endpoint (runtime rolls out within
        # 5 minutes, the api deploy may land later): defer, don't give up — 29026 hit
        # exactly this window on 2026-08-25 and got stuck on `skipped`.
        entry["overview_deferred"] = deferred + 1
        print(f"[strategy_reporter] chart {name} overview: api has no endpoint yet ({e.code}); "
              f"retry next tick", file=sys.stderr)
        return
    entry["overview_levels"] = list(done)
    entry.pop("overview_levels_pending", None)
    entry.pop("overview_levels_done", None)


def _skip_overview(entry, reason):
    entry["overview_skipped"] = True
    entry["overview_reason"] = reason


def _overview_pending(entry):
    """Not skipped for a recorded reason, and either not sent or sent without a final
    `overview_levels` key — levels still pending, or a 1.1.35 entry (coarsest only),
    which _send_overview finishes from the manifest. A `skipped` without a reason was
    written by runtime 1.1.34, which also skipped on the pre-deploy api's 404 — treat
    those as pending once more so the fleet heals without touching machines (a real
    skip re-marks itself with a reason on the next attempt)."""
    if entry.get("overview_skipped") and entry.get("overview_reason"):
        return False
    if entry.get("overview_sent"):
        return "overview_levels" not in entry
    return True


def _upload_chart(name, manifest, entry, token, deadline):
    """Push one strategy's chart set; mutates `entry` and persists it after every
    chunk. Returns when done, out of time budget, or on the first failure — the next
    tick resumes from `entry`. A chunk whose sha1 no longer matches the manifest means
    the runner swapped a new set in mid-upload: stop, the next tick sees the new hash
    and starts over. The overview goes up between the last chunk and commit, but never
    holds commit back — a miss there is backfilled by sync_charts on a later tick."""
    base = f"{CHART_URL}/{name}/{manifest['hash']}"
    if not entry.get("manifest_sent"):
        _chart_request("PUT", f"{base}/manifest", json.dumps(manifest).encode(), token)
        entry["manifest_sent"] = True
        _save_chart_state_entry(name, entry)
    uploaded = set(entry.get("uploaded") or [])
    for c in manifest["chunks"]:
        cid = c.get("id")
        if cid in uploaded:
            continue
        if time.monotonic() > deadline:
            return False
        raw = _read_chunk(name, c)
        if raw is None:
            print(f"[strategy_reporter] chart {name} chunk {cid} changed under us; retry next tick",
                  file=sys.stderr)
            return False
        gz = gzip.compress(raw, compresslevel=6)
        if len(gz) > _CHART_CHUNK_GZ_MAX:
            print(f"[strategy_reporter] chart {name} chunk {cid} too large ({len(gz)}B); giving up",
                  file=sys.stderr)
            entry["failed"] = True
            return False
        _chart_request("PUT", f"{base}/chunk/{cid}", gz, token, content_encoding="gzip")
        uploaded.add(cid)
        entry["uploaded"] = sorted(uploaded)
        _save_chart_state_entry(name, entry)
    if _overview_pending(entry):
        try:
            _send_overview(name, manifest, entry, token, deadline)
        except _ChartHTTPError as e:
            if e.code == 409:
                raise  # staged set is gone: commit would 409 too — let the caller reset
            print(f"[strategy_reporter] chart {name} overview failed: {e}; committing without it",
                  file=sys.stderr)
        except Exception as e:
            print(f"[strategy_reporter] chart {name} overview failed: {e!r}; committing without it",
                  file=sys.stderr)
        _save_chart_state_entry(name, entry)
    _chart_request("POST", f"{base}/commit", b"{}", token)
    entry["done"] = True
    return True


def _fresh_entry(h, resets=0):
    return {"hash": h, "manifest_sent": False, "uploaded": [], "resets": resets}


def sync_charts(strategies, token=None):
    """TIMER-PATH ONLY (not the mid-turn web_bridge push — uploads can take a while).
    For each reported strategy: a chart/manifest.json whose hash differs from what we
    last finished → upload it; a strategy that vanished from the workspace → ask the
    api to drop its stored chart. Failures are logged and retried next tick."""
    token = token or PROXY_TOKEN
    state = _load_chart_state()
    names = [s["name"] for s in strategies if _CHART_NAME_RE.fullmatch(s.get("name") or "")]
    deadline = time.monotonic() + _CHART_TICK_BUDGET_SEC
    for gone in [n for n in state if n not in names]:
        if time.monotonic() > deadline:
            return
        try:
            _chart_request("DELETE", f"{CHART_URL}/{gone}", None, token)
        except _ChartHTTPError as e:
            print(f"[strategy_reporter] chart delete {gone} failed: {e}", file=sys.stderr)
            if not e.permanent:
                continue  # 429/5xx: retry next tick; a permanent 4xx just drops the entry
        except Exception as e:
            print(f"[strategy_reporter] chart delete {gone} failed: {e}", file=sys.stderr)
            continue
        state.pop(gone, None)
        _save_chart_state(state)
    for name in names:
        manifest = _read_chart_manifest(name)
        if manifest is None:
            continue
        entry = state.get(name) or {}
        if entry.get("hash") != manifest["hash"]:
            entry = _fresh_entry(manifest["hash"])  # new set: a `failed` older hash unlocks here
            _save_chart_state_entry(name, entry)
        if entry.get("done") or entry.get("failed"):
            continue
        if time.monotonic() > deadline:
            break
        try:
            _upload_chart(name, manifest, entry, token, deadline)
        except _ChartHTTPError as e:
            resets = int(entry.get("resets") or 0)
            if e.code == 409 and resets < _CHART_MAX_RESETS:
                print(f"[strategy_reporter] chart upload {name}: {e}; restarting hash "
                      f"({resets + 1}/{_CHART_MAX_RESETS})", file=sys.stderr)
                entry = _fresh_entry(manifest["hash"], resets + 1)
            elif e.code == 409 or e.permanent:
                # Re-sending the same bytes can't fix a 400/413/…: stop hammering the api
                # every 2 minutes; only a new hash (re-backtest) clears `failed`.
                print(f"[strategy_reporter] chart upload {name} rejected, giving up until the "
                      f"chart changes: {e}", file=sys.stderr)
                entry["failed"] = True
            else:
                print(f"[strategy_reporter] chart upload {name} failed: {e}; retry next tick",
                      file=sys.stderr)
        except Exception as e:
            print(f"[strategy_reporter] chart upload {name} failed: {e}", file=sys.stderr)
        _save_chart_state_entry(name, entry)
    # Backfill last, with whatever budget the uploads left: a live set that missed its
    # overview or its levels (timeout, 5xx, or committed by an older runtime) gets
    # one without a second commit — the hash is already live.
    state = _load_chart_state()  # the loop above persisted entries the local dict never saw
    for name in names:
        entry = state.get(name) or {}
        if not entry.get("done") or not _overview_pending(entry):
            continue
        manifest = _read_chart_manifest(name)
        if manifest is None or manifest["hash"] != entry.get("hash"):
            continue
        if time.monotonic() > deadline:
            break
        try:
            _send_overview(name, manifest, entry, token, deadline)
        except Exception as e:
            print(f"[strategy_reporter] chart {name} overview backfill failed: {e!r}",
                  file=sys.stderr)
        _save_chart_state_entry(name, entry)


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
    # Gzipped on the wire. This body is mostly the backtests' first-paint tails —
    # long runs of numeric JSON that compress ~4× — and the timer re-sends the whole
    # thing every two minutes whether anything changed or not, so an unpacked report
    # was uploading tens of MB an hour from a machine on a metered link. The api
    # expands it (agent_strategies._report_body) and stores it still compressed;
    # 4× applies to the 16MB ceiling as well, which is what stops the cache freezing
    # once a user has more than a handful of strategies.
    raw = json.dumps(payload).encode()
    headers = {"Content-Type": "application/json", "x-api-key": f"proxy-{token}"}
    try:
        req = urllib.request.Request(
            API_URL, data=gzip.compress(raw, 6),
            headers={**headers, "Content-Encoding": "gzip"},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.read().decode()
    except urllib.error.HTTPError as e:
        # An api that predates gzip bodies reads the compressed bytes as JSON, gets
        # nothing, and answers 400 with this exact message. Publishing the runtime
        # before deploying the api would otherwise silently freeze every machine's
        # cache, so pay one retry uncompressed rather than depend on deploy order.
        #
        # Matched on the message, not just the status: a 400 the api reached by
        # actually READING our report (a nan in the stats, say) is a permanent
        # failure, and re-sending it uncompressed every two minutes forever would
        # double the cost of a condition that never clears. Delete this whole
        # branch once the fleet is past this release.
        if e.code != 400 or b"must be a list" not in (e.read() or b""):
            raise
        print("[strategy_reporter] api predates gzip reports; retrying uncompressed",
              file=sys.stderr)
    req = urllib.request.Request(API_URL, data=raw, headers=headers)
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
    sync_charts(strategies)


if __name__ == "__main__":
    main()
