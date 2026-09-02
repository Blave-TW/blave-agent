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
# 剛出生、還沒回測完的策略:源檔存在但 stats.json 還沒寫出來的頭幾秒。此窗內
# 先不上報,免得 sidebar 早產一個空殼、auto-open 開進沒資料的分頁(回測 stats
# →pnl 實測 7 秒 gap)。只擋『從沒回報過』的新策略——既有策略一律照收,整筆
# omit 會被 report 端當成員減少、workspace 閃一下移除。
_NEWBORN_GRACE_S = 15
# process 內「上輪掃描見過的名字」:mtime 分不出「新生」與「剛被編輯的既有無 stats
# 草稿」——後者被 agent 改一下 code 就消失 15 秒,mid-turn 推送會讓側欄閃移除再閃回。
# 所以只有從沒出現過的名字才允許走 newborn 跳過。長駐 process(web_bridge/agent_turn)
# 因此不會誤跳既有草稿;timer 的 oneshot 每次都是新 process、集合是空的,殘留一個
# 「草稿在 timer 開跑前 15 秒內剛被編輯」的小窗,接受(2 分鐘一班撞 15 秒窗)。
_seen_names = set()
STATE_DIR = os.environ.get("BLAVE_AGENT_STATE", "/opt/blave-agent/state")

# 回測 tab 的附件圖:strategies/<name>/ 內的圖檔(pnl.png、param heatmap…)。
# 上限防single檔爆量;數量取 mtime 最新的 N 張。
# IMG_EXTS / IMG_MAX_BYTES / put_image / record_image_quota 是**公開的**:
# report_uploader 的圖片 sidecar 走同一條 strategy_image 通道,共用這裡的
# 副檔名白名單、大小上限與 507 語意,免得兩支各留一份會漂開的實作。
IMG_EXTS = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
            ".webp": "image/webp", ".gif": "image/gif"}
IMG_MAX_BYTES = 2 * 1024 * 1024
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
# "the api refused an image because this user's S3 storage is full" (HTTP 507 from
# api/openclaw/agent_strategy_images.py). Written here, read by agent_turn, which turns
# it into one line of the turn prompt so the agent can say it in chat — see
# record_image_quota() for why this one failure is worth persisting and
# agent_turn._image_quota_line() for when it is allowed to be mentioned.
IMG_QUOTA_PATH = os.path.join(STATE_DIR, "strategy_image_quota.json")
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
# (15s) must stay under it — stop early, resume next tick. A fresh chart set does read,
# sha1 and gzip every chunk, which on a 2-core box is real CPU, not just waiting on the
# api. What this budget no longer has to absorb is *repeated* work: each chunk is done
# exactly once and skipped on resume, whereas the overview ladder rebuilt itself from the
# whole chunk set every tick until it succeeded or hit its 40-tick deferral cap.
_CHART_TICK_BUDGET_SEC = 45
_CHART_REQUEST_TIMEOUT = 45
# A 409 (manifest not uploaded / chunks missing) means the api lost our staged set —
# e.g. commit hit the total-size cap and swept it — so the persisted progress is a lie:
# start that hash over. Bounded so a 409 that never clears can't loop every tick forever.
_CHART_MAX_RESETS = 3
_CHART_NAME_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")

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


def _read_scan(name):
    """Parameter-scan output (blaveclaw-config lib/param_scan.write_scan) lands in
    strategies/<name>/scan.json — a rows×cols Sharpe grid + neighbourhood means +
    peak/plateau/current markers, feeding the workspace 穩健參數 tab. Same
    fail-soft contract as _read_backtest: None when absent / unreadable / not an
    object. Shape validation is the api's job (agent_strategies._clean_scan)."""
    path = os.path.join(STRATEGIES_DIR, name, "scan.json")
    try:
        with open(path) as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _scan_marker(name):
    """signature() column for strategies/<name>/scan.json: mtime+size or "none".
    No live/deployed exemption unlike _stats_marker — scan.json is only written by
    an explicit parameter scan, never by the per-bar tick, so tracking its mtime
    fires exactly when the user asked for something. Same ValueError note."""
    try:
        st = os.stat(os.path.join(STRATEGIES_DIR, name, "scan.json"))
    except (OSError, ValueError):
        return "none"
    return f"{st.st_mtime_ns}:{st.st_size}"


def _deployed_names():
    """STRATEGY_NAMEs deployed for live trading per state/deployments.json — the
    deployment truth. A web-driven deploy runs the strategy with BLAVE_MODE=live in
    the environment and never edits the file's MODE constant, so file status alone
    ("draft") can't tell a deployed strategy from a real draft. Only `wait_for_bar`
    and `cron` entries count. Stale entries (unbound exchange leaving the checkbox
    on, Type B cron never pruned) over-exempt a non-deployed strategy — cost is an
    update delayed to turn end, accepted. Unreadable / missing / malformed registry
    → empty set (fail-open to current behavior: noisy, not mute); nothing may
    escape — this runs inside every signature() call on the live push path."""
    try:
        with open(os.path.join(WORKSPACE, "state", "deployments.json")) as f:
            reg = json.load(f)
    except (OSError, ValueError):
        return set()
    if not isinstance(reg, dict):
        return set()
    return {
        name for name, entry in reg.items()
        if isinstance(entry, dict) and entry.get("type") in ("wait_for_bar", "cron")
    }


def _stats_marker(name, status, deployed=frozenset()):
    """What signature() tracks for strategies/<name>/stats.json. A string either
    way — the whole signature is an opaque fingerprint, and same-typed elements
    keep sorted() total no matter what the other two columns hold.

    draft → mtime+size: this file belongs to the agent, and a re-run that
    overwrites it in place should reach the open workspace mid-turn.
    live (file MODE) or deployed (registry, `deployed` from _deployed_names) →
    existence only: a deployed strategy's stats.json belongs to the per-bar tick
    thread (command_listener._tick_one → blaveclaw-config lib/runner.py rewrites
    it on every close, unconditionally — the `mode == 'backtest'` gate below that
    write only guards the chart export). Tracking its mtime would fire a full
    scan + a ≤1.5MB chunk + a workspace redraw once a bar, mid-conversation, for
    something the user never asked about — worst on exactly the users with real
    money running. Deployment truth is the REGISTRY, not the file: a web deploy
    sets BLAVE_MODE=live in the env and leaves MODE="backtest" in the file, which
    is exactly the strategy the status=="live" check missed (uid=32321: every 5min
    close pushed a ~0.5MB strategies chunk). Existence is the sensitivity the
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
    if status == "live" or name in deployed:
        return "exists"
    return f"{st.st_mtime_ns}:{st.st_size}"


def signature():
    """Cheap "has the inventory changed" fingerprint: name + status + the stats
    and scan markers above, with no stats.json / scan.json parsed. agent_turn
    calls this after every tool step and only pays for scan() when it differs — a 5min strategy's
    stats.json is ~4.7MB, and parsing three of them on every step (0.30s vs
    0.004s, measured on uid=32321) lagged every chunk behind for nothing.

    Not free, though: _scan_sources() still reads and ast-parses every strategy
    file. That is milliseconds against hundreds, but it is not "one stat" — and
    the deployment registry is read once per call here, not once per strategy."""
    deployed = _deployed_names()
    return json.dumps(sorted(
        [s["name"], s["status"], _stats_marker(s["name"], s["status"], deployed),
         _scan_marker(s["name"])]
        for s in _scan_sources()
    ))


def _is_newborn(name, source_path):
    """True 只在「這檔還沒回測過(無 stats.json)、且源檔剛建立(<15 秒)」。

    兩個條件缺一不可:有 stats.json 就不是新生(已回測、早該顯示);源檔夠老
    也不是新生(存在很久只是沒回測,那是使用者的草稿,得照顯示)。所以既有
    策略——不管有沒有 stats.json——都不會被這個 guard 擋掉。源檔 mtime 取
    single-file 的 <name>.py 或 dir layout 的 strategy.py(呼叫端傳進來的 full)。
    stat 失敗一律回 False:寧可上報也不要誤刪一筆。呼叫端(_scan_sources)另疊
    _seen_names:上輪見過的名字連這個函式都不會進——mtime 分不出新生與剛被編輯的
    既有草稿,只有全新名字才允許走跳過。"""
    stats_path = os.path.join(STRATEGIES_DIR, name, "stats.json")
    if os.path.exists(stats_path):
        return False
    try:
        age = time.time() - os.stat(source_path).st_mtime
    except OSError:
        return False
    # 下界擋未來 mtime / 時鐘回撥:age 為負代表 mtime 不可信,寧可顯示不要藏
    return 0 <= age < _NEWBORN_GRACE_S


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
            src_path = full
            s = _extract(full, entry[:-3])
        elif os.path.isdir(full):
            sp = os.path.join(full, "strategy.py")
            # A dir with no strategy.py is the backtest OUTPUT folder (stats.json /
            # pnl.png that run.py writes to strategies/<name>/), not a strategy. Skip
            # it — otherwise this empty shell dedupe-clobbers the real <name>.py source
            # (both 'draft', dir sorts first), wiping its code + DISPLAY_NAME.
            if not os.path.isfile(sp):
                continue
            src_path = sp
            s = _extract(sp, entry)
        else:
            continue
        if not s:
            continue
        if s["name"] not in _seen_names and _is_newborn(s["name"], src_path):
            continue
        prev = by_name.get(s["name"])
        # keep the live one if a name shows up twice
        if prev is None or (prev["status"] != "live" and s["status"] == "live"):
            by_name[s["name"]] = s
    _seen_names.update(by_name)
    return list(by_name.values())


def scan():
    """The full inventory: sources plus each strategy's parsed backtest and
    parameter scan (both optional, both absent rather than null when missing)."""
    strategies = _scan_sources()
    for s in strategies:
        bt = _read_backtest(s["name"])
        if bt is not None:
            s["backtest"] = bt
        sc = _read_scan(s["name"])
        if sc is not None:
            s["scan"] = sc
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
        mime = IMG_EXTS.get(ext)
        if not mime:
            continue
        p = os.path.join(d, f)
        try:
            st = os.stat(p)
        except OSError:
            continue
        if not os.path.isfile(p) or st.st_size > IMG_MAX_BYTES:
            continue
        out.append((st.st_mtime, f, p, mime))
    out.sort()
    return out[-_IMG_MAX_COUNT:]


def put_image(data, mime, token):
    """Upload one image to S3 via the api. Returns (its {hash} reference, or None so the
    caller falls back to inline base64; whether the api refused on the storage quota).
    Content-addressed: re-sending identical bytes overwrites the same key, so a retry
    after a failed report costs one PUT.

    507 is the only failure separated out, because it is the only one that does not
    clear by itself: every other failure (S3 down, rate limited, socket timeout) means
    the next tick re-sends the same bytes and the picture still arrives, while over
    quota the api drops the image outright — the inline-base64 fallback is refused for
    the same reason on arrival.

    Also the report pipeline's image channel (report_uploader._resolve_images), which
    has no base64 fallback and turns the same two outcomes into "defer the report" vs
    "ship it without that figure" — hence the neutral log prefix."""
    h = hashlib.sha256(data).hexdigest()
    req = urllib.request.Request(
        f"{IMAGE_URL}/{h}", data=data, method="PUT",
        headers={"Content-Type": mime, "x-api-key": f"proxy-{token}"},
    )
    try:
        urllib.request.urlopen(req, timeout=_IMG_UPLOAD_TIMEOUT).read()
    except urllib.error.HTTPError as e:  # subclass of the below; must be caught first
        print(f"[strategy_image] upload failed: {e}", file=sys.stderr)
        return None, e.code == 507
    except Exception as e:
        print(f"[strategy_image] upload failed: {e}", file=sys.stderr)
        return None, False
    return h, False


def record_image_quota(refused, uploaded, complete=True):
    """Persist — or clear — "the api is refusing this machine's images because the
    user's storage is full", for agent_turn to raise in chat.

    Nothing else can tell them. A report whose picture was dropped looks exactly like a
    report that never had one, so the workspace has nothing to render and no way to
    explain the gap; chat is the channel that reaches the user either way, and the agent
    is the only thing that can turn the fact into something they can act on.

    Set ONLY by a real 507 off the wire, never inferred from a missing picture — the
    sentence the agent ends up saying has to be a machine fact, not a deduction.

    Cleared by an upload that succeeded in the same pass: that is the only evidence this
    machine can have that the ceiling is no longer being hit. A pass that uploaded
    nothing at all — the common case, since unchanged signatures skip the upload
    entirely — is evidence of neither and leaves the file exactly as it was.

    Nor does a pass that ran out of its upload budget (`complete=False`): the image it
    never reached could be exactly the one being refused, so the ones that did fit are
    not the evidence this is asking for. Same rule as the paragraph above, applied to
    the images that were never attempted rather than the passes that attempt none.

    A file of its own rather than a field agent_turn edits: that process writes its
    "already mentioned this" marker beside this one, so a per-turn spawn and this timer
    never read-modify-write the same file."""
    if not (refused or (uploaded and complete)):
        return
    try:
        if refused:
            os.makedirs(STATE_DIR, exist_ok=True)
            with open(IMG_QUOTA_PATH, "w") as f:
                json.dump({"at": int(time.time())}, f)
        elif os.path.exists(IMG_QUOTA_PATH):
            os.remove(IMG_QUOTA_PATH)
    except OSError:
        pass


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
    refused = uploaded = skipped = False
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
            if time.monotonic() < deadline:
                h, over_quota = put_image(data, mime, token)
            else:
                # Budget spent: not attempted, so it says nothing either way — and it
                # makes the whole pass silent about whether the ceiling cleared, since
                # this could be the image that would have been refused.
                h, over_quota = None, False
                skipped = True
            refused = refused or over_quota
            uploaded = uploaded or bool(h)
            entry = {"file": f, "mime": mime}
            entry["hash" if h else "b64"] = h or base64.b64encode(data).decode()
            payload.append(entry)
        s["images"] = payload  # [] = 圖被清掉,明確清空
    record_image_quota(refused, uploaded, complete=not skipped)
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


def _upload_chart(name, manifest, entry, token, deadline):
    """Push one strategy's chart set; mutates `entry` and persists it after every
    chunk. Returns when done, out of time budget, or on the first failure — the next
    tick resumes from `entry`. A chunk whose sha1 no longer matches the manifest means
    the runner swapped a new set in mid-upload: stop, the next tick sees the new hash
    and starts over."""
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
        # Entries written by ≤1.1.42 also carry overview_* keys. Nothing reads them any
        # more (only hash / manifest_sent / uploaded / resets / done / failed are), and the
        # next backtest replaces the entry wholesale — no migration needed.
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


def _config_version():
    """workspace 根的 VERSION(config 更新流程會 copy 進來)。讀不到 = None,
    fail-soft:舊機沒這個檔是常態,不值得噪音。"""
    try:
        with open(os.path.join(WORKSPACE, "VERSION")) as f:
            return f.read().strip() or None
    except OSError:
        return None


def _can_report():
    """Is this runtime able to produce agent reports?

    Probes the RUNTIME's own uploader module, not workspace/lib/: lib is a
    convenience layer the user's own agent may have edited, deleted or never
    updated, so its state says nothing about what this machine can actually do.
    The runtime directory is what publish.py ships as one unit.

    Existence, not import: a future uploader may do real work at import time, and
    "shipped with this release" is exactly the question the web's update prompt
    asks. Reads False fleet-wide until the uploader itself ships."""
    return os.path.exists(
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "report_uploader.py")
    )


def _can_watch():
    """Can this runtime ship watchboard ops / data (.claude/docs/watchboard.md §5.3b)?
    Same stance as _can_report: the uploader is one file across releases, so the
    question is whether THIS copy carries the watch sweep — a text probe, not an
    import, for the reason above."""
    try:
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               "report_uploader.py"), encoding="utf-8") as f:
            return "def run_watch_once(" in f.read()
    except OSError:
        return False


def report_schedules():
    """The `report_schedules` list (.claude/docs/report-schedules.md §5): one entry per
    workspace/report_jobs/<id>/ — the registration plus the last runs.jsonl line and
    the next fire time — or `{id, error}` for a job this runtime will not install.
    Not sorted; the web orders it."""
    import importlib
    import platform
    # Sibling in the same runtime dir. Bare name on the machine (one flat dir),
    # package-qualified when the api tests load this module as blave_agent.runtime.*
    report_runner = importlib.import_module(
        (__package__ + "." if __package__ else "") + "report_runner")

    now = int(time.time())
    windows = platform.system() == "Windows"
    out = []
    for job_id, job, err in report_runner.list_jobs():
        if job is None:
            out.append({"id": job_id, "error": err})
            continue
        cron = job["schedule"]["cron"]
        if windows and report_runner.cron_to_schtasks(cron) is None:
            out.append({"id": job_id, "error": "schedule not supported on Windows"})
            continue
        if job.get("kind") == "watch":
            continue  # a watchboard widget's schedule, not a report — the board shows it
        pending = job.get("pending")
        last = report_runner.last_run(job_id)
        entry = {
            "id": job_id,
            "title": job["title"],
            "prompt": job["prompt"],
            "schedule_human": job["schedule"]["human"],
            "enabled": job["enabled"],
            "created_at": job["created_at"],
            "updated_at": job["updated_at"],
            "pending": None,
            "last_run": None,
            "next_run_at": report_runner.cron_next(cron, now) if job["enabled"] else None,
        }
        if pending:
            entry["pending"] = {"since": pending["since"],
                                "stale": now - pending["since"] > report_runner.PENDING_STALE_S}
        if last:
            entry["last_run"] = {"at": last.get("started_at"), "status": last.get("status"),
                                 "report_ids": last.get("report_ids") or []}
            if last.get("status") == "failed":
                entry["last_run"]["error"] = last.get("error") or ""
        out.append(entry)
    return out


def report_cache(strategies, token=None):
    """POST the list to the backend cache (GET /strategies reads this on page
    load / reload). Reused by the timer AND by web_bridge after each turn.
    Piggybacks config_version so the web can flag an outdated workspace config,
    can_report so it can gate the reports feature on this machine, and the
    scheduled-report registry (report_schedules) for the 管理定期報告 modal."""
    token = token or PROXY_TOKEN
    payload = {"strategies": strategies, "can_report": _can_report(),
               "can_watch": _can_watch()}
    version = _config_version()
    if version:
        payload["config_version"] = version
    try:
        payload["report_schedules"] = report_schedules()
    except Exception as e:
        # Omitted, not []: the api reads an absent field as "old runtime, keep what
        # you have" — an empty list would wipe the user's schedule list on a hiccup.
        print(f"[strategy_reporter] report_schedules failed: {type(e).__name__}: {e}",
              file=sys.stderr)
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
