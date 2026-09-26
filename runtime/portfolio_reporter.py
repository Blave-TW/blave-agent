"""
Portfolio reporter: ships the machine's portfolio state to the Blave backend
(POST /openclaw/agent/portfolio) so the workspace's 投資組合 view can render
without a VM round-trip — the same report/read split strategy_reporter.py uses.

What it collects, and why each piece has to come from here:
  - manager/portfolio_config.json  weights / leverage / capital / exchange routing
  - strategies/<n>/state.json      each strategy's live signal + when it last moved
  - crontab + state/deployments.json
                                   whether a strategy is actually SCHEDULED; a
                                   weighted strategy with no schedule trades on
                                   a frozen signal and nothing else notices.
                                   Two sources because Type A/C strategies get
                                   NO crontab/schtasks entry at all — see
                                   scheduled_strategies()
  - manager/last_reconcile.json    the only record of real exchange positions
                                   (written by lib/portfolio.reconcile)
  - manager/orders.jsonl           what was actually sent to the exchange
  - manager/account.json           live equity/positions per venue, written by
                                   account_reader.py — read as JSON, never
                                   executed; a broken account module shows up
                                   as that file's "error" field, not as this
                                   report dying
  - state/heartbeat/reconciler     is the auto-trader alive
  - state/events.jsonl             機器側 P1／P2 事件(events.py):平台落
                                   agent_event 再依級別 fan-out,回應的
                                   acked_through 是這個檔的水位線
  - 磁碟／記憶體／gateway、配對的 chat id
                                   平台每小時 SSH 進機器巡檢的那支掃描退役後,
                                   這幾件事只剩這條路上來(resources /
                                   tg_chat_ids)

VM auth = proxy-{ttyd_password} (BLAVE_PROXY_TOKEN), same trust model as the
chat transport and strategy_reporter: the token resolves to this user only.
"""
import ast
import ctypes
import json
import math
import os
import platform
import re
import shutil
import statistics
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone

import events

BASE = os.environ.get("BLAVE_AGENT_BASE") or (
    r"C:\blave-agent" if os.name == "nt" else "/opt/blave-agent"
)
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
    """utf-8 explicitly, never the locale default: strategy names reach these
    files from STRATEGY_NAME (may contain spaces/dots/Chinese), and on a cp950
    Windows box a locale-default read raises UnicodeDecodeError — which lands
    in the `except` below (UnicodeDecodeError is a ValueError) as a silent
    `default` — "nothing there" rather than "could not read". No
    errors="replace" (unlike _strategy_market's open() below): mojibake in a
    JSON key is worse than a clean parse failure."""
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def _mtime(path):
    try:
        return int(os.path.getmtime(path))
    except OSError:
        return None


# Type A/C strategies picked in 下單設定 have NO crontab line and NO scheduled
# task — command_listener's in-process scheduler runs them and records them
# here instead (its _sync_deployment_registry / _prune_deployment_registry run
# on every 60s cycle, so this file tracks the currently-picked set live rather
# than being a one-shot registration). Type B entries are typed "cron" and the
# reconciler's is "daemon"; only this type is ours to read.
_AC_DEPLOY_TYPE = "wait_for_bar"


def _in_process_scheduled():
    """Type A/C names the in-process scheduler owns. Empty set (not None) when
    the file is missing — a machine with no Type A/C strategy legitimately has
    none, and the OS schedule scan below is what decides "unknown"."""
    deps = _read_json(os.path.join(WORKSPACE_STATE, "deployments.json"), {})
    if not isinstance(deps, dict):
        return set()
    return {n for n, e in deps.items()
            if isinstance(e, dict) and e.get("type") == _AC_DEPLOY_TYPE}


def scheduled_strategies():
    """Names with a live schedule — the OS scheduler (crontab on Linux,
    schtasks on Windows) UNION the in-process scheduler's registry.

    A weighted strategy with no schedule is the quiet failure this whole view
    exists to surface: state.json never updates, so the reconciler keeps sizing
    a real position from a signal that stopped moving days ago. Returns None
    (not an empty set) when the OS schedule can't be read, so the UI can say
    "unknown" instead of accusing every strategy of being unscheduled — the
    in-process registry can't stand in for that, since it says nothing about
    Type B.

    For Type A/C this reports registration, not a successful tick: "funded"
    implies "registered" because there is no external schedule left to be
    missing. The failure that registration can't see (scheduler thread wedged,
    every tick erroring) is caught by the caller's own state.json freshness and
    by manager/healthcheck.py's heartbeat check, both unchanged.
    """
    in_process = _in_process_scheduled()
    if os.environ.get("BLAVE_AGENT_LOCAL") == "1":
        # local (desktop) mode schedules Type A/C in-process only and never
        # reads the user's own crontab — see command_listener._local_mode
        return in_process
    if platform.system() == "Windows":
        # deployment.md's task-name convention: blaveclaw-strategy-<name>
        try:
            out = subprocess.run(
                ["schtasks", "/query", "/fo", "csv", "/nh"], stdin=subprocess.DEVNULL,
                # errors="replace" like every schtasks/crontab call in
                # command_listener.py: text=True decodes with the locale
                # encoding and STRICT errors, and a UnicodeDecodeError is
                # neither OSError nor SubprocessError — it would escape the
                # except below and kill the whole report over one task name
                # the codepage can't represent. Degrade to a mangled name
                # (that one strategy drops out of the set) instead.
                capture_output=True, text=True, errors="replace", timeout=30,
            )
        except (OSError, subprocess.SubprocessError):
            return None
        if out.returncode != 0:
            return None
        # both task families count as "scheduled": agent-made
        # blaveclaw-strategy-* and the web picker's blave-web-strategy-*
        # (command_listener's schtasks twin of the tagged cron lines)
        return set(re.findall(r"blaveclaw-strategy-([^\",]+)", out.stdout)) | \
            set(re.findall(r"blave-web-strategy-([^\",]+)", out.stdout)) | \
            in_process
    try:
        out = subprocess.run(
            ["crontab", "-l"],  # errors="replace": see the schtasks call above
            stdin=subprocess.DEVNULL, capture_output=True, text=True, errors="replace", timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        if "no crontab" in (out.stderr or "").lower():
            return in_process
        return None
    # Both agent-written forms count (references/deployment.md): run_strategy.sh
    # for Type B, wait_for_bar.py for a Type A/C the agent scheduled by hand.
    # Same pair command_listener._purge_strategy_schedules already matches on.
    return set(re.findall(r"run_strategy\.sh\s+(\S+)", out.stdout)) | \
        set(re.findall(r"wait_for_bar\.py\s+(\S+)", out.stdout)) | \
        in_process


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


# a portfolio (Type C) state's weights, as forwarded: the report is cached by the
# api and has hit 413 before — never an unbounded map
PORTFOLIO_WEIGHTS_MAX = 100
_WEIGHT_SYM_RE = re.compile(r"^[A-Z0-9]{1,30}$")


def _portfolio_weights(raw):
    """{SYMBOL: finite float} from a Type C state's `weights` (lib/runner.
    typec_live_state), or None when there are none. Keys canonical (dashless
    upper), non-finite / non-numeric values and malformed keys dropped; zero
    weights dropped (they target nothing); at most PORTFOLIO_WEIGHTS_MAX
    symbols, the largest |weight| first so a truncated map keeps what trades
    most. The machine's own targets always use the full file — this is display."""
    if not isinstance(raw, dict):
        return None
    out = {}
    for k, v in raw.items():
        sym = str(k).replace("-", "").upper()
        if not _WEIGHT_SYM_RE.match(sym) or isinstance(v, bool):
            continue
        try:
            w = float(v)
        except (TypeError, ValueError):
            continue
        if not math.isfinite(w) or w == 0:
            continue
        out[sym] = round(w, 8)
    top = sorted(out.items(), key=lambda kv: -abs(kv[1]))[:PORTFOLIO_WEIGHTS_MAX]
    return dict(top)


def strategy_states():
    """{name: {symbol, position, market, updated_at}} from strategies/*/state.json;
    a portfolio (Type C) state also carries `type`, `weights` and `rebalance_at`."""
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
        weights = _portfolio_weights(data.get("weights"))
        if weights is not None:
            states[name]["type"] = "portfolio"
            states[name]["weights"] = weights
            try:
                ra = int(data.get("rebalance_at"))
                states[name]["rebalance_at"] = ra if ra > 0 else None
            except (TypeError, ValueError):
                states[name]["rebalance_at"] = None
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
        # DATA_<SOURCE>_* = data-source keys (command_listener._DATA_CRED_PREFIX)
        if (m and m.group(1).upper() not in _RESERVED_PREFIXES
                and not m.group(1).upper().startswith("DATA_")):
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


def _capital_order_identity_ok():
    """Verbatim mirror of manager/flatten.py's check — keep in step. The
    flatten 全部平倉 launches inherits THIS process's identity (the bridge;
    LocalSystem on Windows), so this is the question the button asks. Not
    imported from the workspace: runtime and workspace ship on different
    channels, and importing flatten.py would chdir the bridge. Same known
    false positive (schtasks without /rp → BATCH, still 602). The two bodies
    are pinned equal by tests/check_capital_flatten_identity.py."""
    if os.name != "nt":
        return False
    try:
        import ctypes
        from ctypes import wintypes
        adv = ctypes.windll.advapi32
        buf = ctypes.create_unicode_buffer(257)
        n = wintypes.DWORD(257)
        if not adv.GetUserNameW(buf, ctypes.byref(n)) or buf.value.lower() != "administrator":
            return False
        for sddl in ("S-1-5-4", "S-1-5-3", "S-1-5-6"):  # INTERACTIVE, BATCH, SERVICE
            sid = ctypes.c_void_p()
            if not adv.ConvertStringSidToSidW(sddl, ctypes.byref(sid)):
                return False
            member = wintypes.BOOL()
            try:
                ok = adv.CheckTokenMembership(None, sid, ctypes.byref(member))
            finally:
                ctypes.windll.kernel32.LocalFree(sid)
            if ok and member.value:
                return True
        return False
    except Exception:
        return False


def can_flatten(vens):
    """flatten.py present, and not a machine whose only closable venue is 群益
    under an identity that can't send 群益 orders — there the button would halt
    and close nothing, so the page offers 暫停 only. Mixed venues stay True:
    the crypto leg closes and flatten records the 群益 leg as not closed.
    Closable = flatten.py's own rule (key in .env + account AND order lib)."""
    if not os.path.isfile(os.path.join(WORKSPACE, "manager", "flatten.py")):
        return False
    closable = {vid for vid, v in (vens or {}).items() if v.get("account") and v.get("order")}
    return not (closable == {"capital"} and not _capital_order_identity_ok())


def _fresh(ts, window=HEARTBEAT_STALE_S):
    return bool(ts and (time.time() - ts) < window)


def _gated_marker_fresh(hb):
    """The running reconciler proved it honours the restart record: its
    state/heartbeat/reconciler.gated (touched with the heartbeat each round, by
    the gated version only) is as fresh as the heartbeat. Same test as
    command_listener._reconciler_gated for a running reconciler."""
    marker = _mtime(os.path.join(WORKSPACE_STATE, "heartbeat", "reconciler.gated"))
    return bool(hb and marker and marker >= hb - 10)


# Type A/C = strategy.py declares a valid INTERVAL and the workspace has
# wait_for_bar.py: the same test command_listener._strategy_has_interval uses to
# hand a strategy to the in-process scheduler. Value format and bar alignment
# are wait_for_bar.py's (_INTERVAL_RE / _expected_closed_bar_open).
_AC_INTERVAL_RE = re.compile(r'^\s*INTERVAL\s*=\s*["\']([^"\']+)["\']', re.M)
_AC_INTERVAL_VALUE_RE = re.compile(r"^(\d+)(min|m|h|d|w)$")
_AC_UNIT = {"min": "minutes", "m": "minutes", "h": "hours", "d": "days", "w": "weeks"}


def _ac_interval(name):
    try:
        with open(os.path.join(WORKSPACE, "strategies", name, "strategy.py"),
                  encoding="utf-8", errors="replace") as f:
            m = _AC_INTERVAL_RE.search(f.read())
    except OSError:
        return None
    v = _AC_INTERVAL_VALUE_RE.match(m.group(1)) if m else None
    if not v:
        return None
    try:
        td = timedelta(**{_AC_UNIT[v.group(2)]: int(v.group(1))})
    except OverflowError:
        return None
    return td if td > timedelta(0) else None  # "0m" would divide by zero below


def _naive_utc(iso):
    try:
        t = datetime.fromisoformat(str(iso))
    except (TypeError, ValueError):
        return None
    return t.astimezone(timezone.utc).replace(tzinfo=None) if t.tzinfo else t


def _recomputed_since(down_to, cfg, vens):
    """Every funded Type A/C strategy's signal is current as of the boot: its
    last processed bar is at least the bar that had just closed when the
    machine came back (down_to) — i.e. it has run on everything that existed
    then, before or after the reboot. The literal "processed bar ≥ boot time"
    would wait up to two whole bars (a 1d strategy: two days), because a bar's
    label is its OPEN time and the newest closed bar always opened before now.
    Also current: a post-boot check (bar_wait file written after down_to) that
    found no newer data than it already processed (market closed, data stalled)
    — unless that check FAILED after the boot (fetch/run failure or wrapper
    error: wait_for_bar saves the file without touching last_seen_bar, so a
    failure would otherwise read as "nothing newer").
    No bound venue → True: the scheduler does not run then (the flag would stay
    false for ever) and nothing can trade either; the reconciler idles."""
    if not any(isinstance(v, dict) and v.get("pair") for v in (vens or {}).values()):
        return True
    if not os.path.isfile(os.path.join(WORKSPACE, "manager", "wait_for_bar.py")):
        return True  # no Type A/C scheduling in this workspace at all
    amounts = (cfg or {}).get("amounts") or {}
    exchanges = (cfg or {}).get("exchanges") or {}
    if not isinstance(amounts, dict) or not isinstance(exchanges, dict):
        return False
    boot = datetime(1970, 1, 1) + timedelta(seconds=float(down_to))
    epoch = datetime(1970, 1, 1)
    for name, amt in amounts.items():
        try:
            funded = bool(exchanges.get(name)) and float(amt) != 0
        except (TypeError, ValueError):
            funded = False
        td = _ac_interval(name) if funded else None
        if td is None:
            continue  # unfunded or Type B — the reconciler does not trade its signal
        need = epoch + ((boot - epoch) // td) * td - td
        path = os.path.join(WORKSPACE_STATE, "bar_wait", f"{name}.json")
        st = _read_json(path, {}) or {}
        processed = _naive_utc(st.get("last_processed_bar"))
        if processed is not None and processed >= need:
            continue
        seen = _naive_utc(st.get("last_seen_bar"))
        checked_after_boot = (_mtime(path) or 0) > down_to
        failed_after_boot = any(isinstance(st.get(k), (int, float)) and st[k] > down_to
                                for k in ("last_attempt_failed_at", "wrapper_error_alerted_at"))
        if (checked_after_boot and not failed_after_boot and processed is not None
                and seen is not None and seen <= processed):
            continue
        return False
    return True


def _ws_lib_read_only_guard():
    """The workspace lib/portfolio.py on disk carries the never-configured
    read-only guard. Only good for a reconciler that is NOT running — the next
    start loads this file."""
    try:
        with open(os.path.join(WORKSPACE, "lib", "portfolio.py"),
                  encoding="utf-8", errors="replace") as f:
            return "def portfolio_configured(" in f.read()
    except OSError:
        return False


def portfolio_configured(cfg_path, hb, last):
    """True = amounts were saved. False = never saved AND the code that will
    run next is the read-only one, so releasing a pause closes nothing.
    None = can't tell → the report leaves the key out, and the pages fall back
    to their old, harsher warning (web workspace.html: no key = old runtime).

    The field and the guard ship on DIFFERENT channels — this reporter with the
    runtime (automatic), lib/portfolio.py with the workspace (manual) — so
    reporting `false` off this runtime's own behaviour would tell the user
    "nothing will be closed" on every machine whose workspace is still behind
    (audit 2026-09-23 B2). Evidence per case:
      - reconciler running: only its own word counts — `read_only` in the
        snapshot it wrote (lib/portfolio._write_reconcile_snapshot). A machine
        whose update replaced the files but failed to restart (cloud-handoff U8
        `restart_failed`) still has the OLD reconcile() in memory, and that one
        flattens; a disk check would have called it read-only.
      - reconciler stopped: the file on disk is what its next start loads."""
    if os.path.exists(cfg_path) or os.path.exists(
            os.path.join(WORKSPACE, "manager", "amounts.ui.json")):
        return True
    if _fresh(hb):
        return False if isinstance(last, dict) and last.get("read_only") is True else None
    return False if _ws_lib_read_only_guard() else None


def can_trade_portfolio():
    """The workspace lib trades Type C portfolios live: its runner writes the
    per-asset weights (lib/runner.typec_live_state) and its aggregation reads
    them. Both files ship on the manual channel, so the runtime asks the disk —
    a runtime that allowed funding a portfolio beside an older lib would show
    it as trading while nothing ever does."""
    try:
        with open(os.path.join(WORKSPACE, "lib", "runner.py"), encoding="utf-8",
                  errors="replace") as f:
            runner = "def typec_live_state(" in f.read()
        with open(os.path.join(WORKSPACE, "lib", "portfolio.py"), encoding="utf-8",
                  errors="replace") as f:
            agg = "Type C (lib/runner.typec_live_state)" in f.read()
        return runner and agg
    except OSError:
        return False


def _ws_lib_own_only():
    """The workspace lib/portfolio.py on disk has the own-positions-only rule
    (every config without "self_ledger": false diffs against the book)."""
    try:
        with open(os.path.join(WORKSPACE, "lib", "portfolio.py"),
                  encoding="utf-8", errors="replace") as f:
            return "def own_positions_only(" in f.read()
    except OSError:
        return False


def own_positions_only(cfg, hb, last):
    """Does the code that trades on this machine leave every position it did
    not open alone? The flag says so when it is written; a missing key is the
    lib's call, and the lib ships on the manual channel — so, as with
    portfolio_configured: a running reconciler's own word (`own_only` in its
    snapshot), else the lib on disk its next start loads. Reporting true off
    this runtime alone would tell a user on an old lib that their manual
    positions are safe while it closes them."""
    flag = (cfg or {}).get("self_ledger")
    if flag is not None:
        return bool(flag)
    if _fresh(hb):
        return isinstance(last, dict) and last.get("own_only") is True
    return _ws_lib_own_only()


def restart_stop(hb=None, cfg=None, vens=None):
    """Why trading is off after a machine restart, while
    state/reconciler_stopped.json exists (command_listener._machine_restart_check
    writes it, 啟動下單 removes it), else None:
      {"reason": "machine_restart", "at": last heartbeat before the reboot,
       "gated": bool, "recomputed": bool}
    `recomputed` (see _recomputed_since): every funded Type A/C strategy has
    computed on the bars that existed when the machine came back, so 補齊部位
    would trade current signals; false = at least one still holds a pre-restart
    signal (the pages grey 補齊部位 out; 等新訊號 stays available).
    `alive` stays false the whole time (every consumer reads stopped ⇒ not
    trading). `gated: false` is the one exception to "nothing goes out": a
    reconciler has beaten since the stop (the kill did not land, or something
    restarted it) and has NOT proved it honours the record (no fresh
    state/heartbeat/reconciler.gated — an old process, even with a new
    reconciler.py on disk) — it may be trading. Nothing running since the stop
    is gated: nothing can send."""
    path = os.path.join(WORKSPACE_STATE, "reconciler_stopped.json")
    if not os.path.exists(path):
        return None
    info = _read_json(path, {})
    info = info if isinstance(info, dict) else {}
    since = info.get("stopped_at", info.get("down_to"))
    beating = bool(hb and isinstance(since, (int, float)) and int(hb) > since and _fresh(hb))
    at = info.get("at")
    down_to = info.get("down_to")
    if not isinstance(down_to, (int, float)):
        # an old or hand-made record: the file is written at detection time,
        # right after the boot — its mtime is the next-best "machine came back"
        down_to = _mtime(path)
    try:  # this flag must never cost the report itself
        recomputed = (_recomputed_since(down_to, cfg, vens)
                      if isinstance(down_to, (int, float)) else False)
    except Exception as e:
        print(f"[portfolio_reporter] recomputed check failed: {type(e).__name__}: {e}",
              file=sys.stderr)
        recomputed = False
    return {"reason": "machine_restart", "at": at if isinstance(at, int) else None,
            "gated": not (beating and not _gated_marker_fresh(hb)),
            "recomputed": recomputed}


def halt_state():
    """Kill-switch state, read the same way lib/guard.py writes it: the FILE'S
    EXISTENCE is authoritative and unreadable content still counts as halted."""
    path = os.path.join(WORKSPACE_STATE, "HALT")
    if not os.path.exists(path):
        return {"halted": False}
    info = _read_json(path, {}) or {}
    guard_state = _read_json(os.path.join(WORKSPACE_STATE, "venue_account.json"), {})
    guard_state = guard_state if isinstance(guard_state, dict) else {}
    hold, mark = guard_state.get("book_hold"), guard_state.get("bind_reset")
    return {
        "halted": True,
        "at": info.get("ts"),
        "reason": info.get("reason"),
        "source": info.get("source"),
        "blocked": _halt_denials(info.get("ts")),
        # true = the reconciler skips every round: no Blave order of any kind,
        # closes and exits included (an account-guard trip awaiting confirmation,
        # or a book hold awaiting book_account_confirm). false = a plain HALT:
        # entries refused, closes / exits still go out. Orders resting on the
        # exchange (SL/TP) fire either way — they are the exchange's.
        "holds_all": bool(guard_state.get("pending"))
        or bool(isinstance(mark, dict) and mark.get("venue") and not mark.get("acked"))
        or bool(isinstance(hold, dict) and hold.get("venue")),
    }


def account_guard():
    """The reconciler's account guard (blave-agent manager/reconciler.py):
    whether an exchange account id is seeded, whether a confirmation is
    pending, and why the last id read failed. That read is fail-soft — a
    permission-scoped key just skips the check — so without this a machine
    that never seeds its id looks the same as one that is protected. Never
    the id itself. None = a reconciler that predates the guard."""
    stored = _read_json(os.path.join(WORKSPACE_STATE, "venue_account.json"))
    read = _read_json(os.path.join(WORKSPACE_STATE, "account_id_read.json"))
    stored = stored if isinstance(stored, dict) else None
    read = read if isinstance(read, dict) else None
    if stored is None and read is None:
        return None
    stored, read = stored or {}, read or {}
    venue = read.get("venue") or stored.get("venue")
    error = read.get("error") if read.get("venue") == venue else None
    return {
        "venue": venue,
        "account_id_seeded": bool(stored.get("account_id")) and stored.get("venue") == venue,
        # False = this venue's account lib cannot read an id (only the empty-read
        # check guards it); None = not recorded yet
        "account_id_supported": read.get("supported") if read.get("venue") == venue else None,
        "last_read_error": str(error)[:120] if error else None,
        "last_read_at": read.get("at"),
        "pending": bool(stored.get("pending")),
        # a key change the machine could not match to the account Blave's
        # positions there are on: nothing trades on that venue until the user
        # answers `book_account_confirm {venue, same}` (or the id reads). Only
        # a question worth asking — a network hiccup holds silently.
        "book_hold": _book_hold(stored.get("book_hold")),
    }


def _book_hold(hold):
    if not isinstance(hold, dict) or not hold.get("ask") or not hold.get("venue"):
        return None
    return {"venue": str(hold["venue"]), "reason": str(hold.get("reason") or "")[:300],
            "since": hold.get("since")}


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
        # the order — guard.py only writes halt_tripped / halt_cleared. With a
        # machine-restart record the lib refuses first (order_denied_restart);
        # its entries are ones the halt would have refused too, so they count.
        ev = row.get("event")
        if not (ev == "order_denied_halt"
                or (ev == "order_denied_restart" and row.get("intent") == "entry")):
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
# manager/*.py rides blave-agent's manual channel, so a new runtime on an
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
# Mirrors blave-agent lib/allocator.py RESERVED_PARAM_KEYS: target_vol is
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
            row = dict(entry)
            # 回測上次執行時刻 = stats.json 的 mtime(runner 寫檔即完成)。頁面
            # 拿它判斷「重跑有沒有用」:24h 內跑過就不標落後(連假免疫);從
            # st 取、不進 cache entry,cache hit 時也永遠是當前值。
            row["ran_at"] = int(st.st_mtime)
            out.append(row)
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
        # unique: the timer, web_bridge and telegram_bridge can all build a report at once
        tmp = f"{_NOTICE_STATE}.{os.getpid()}.{time.monotonic_ns()}.tmp"
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
    # from every machine that hasn't pulled blave-agent yet.
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


# ── 主機資源與配對狀態(平台側 SSH 巡檢退役後,這三件事只剩這條路上來)──────────
# 平台原本每小時 SSH 進每台機器收 disk/mem/gateway 與 allowFrom(openclaw/monitor.py
# 的部署掃描)。定期 SSH 進用戶機本來就貼著「用戶機唯讀」紅線,而且那支掃描的六項檢查
# 只剩這三個數字是 payload 蓋不掉的——所以把它們搬進這份回報,整支掃描退役。
# 每一項各自 try:取不到就是 None(平台當「這台不知道」),絕不能拖垮整份回報。
_TG_SERVICE = "blave-agent-telegram"
# nssm 走 chocolatey 裝(provision.ps1),排程任務的 PATH 不保證有它
_NSSM_FALLBACK = r"C:\ProgramData\chocolatey\bin\nssm.exe"
_TG_CHAT_IDS_MAX = 20


def _run(cmd, timeout=10):
    """外部指令的 stdout(失敗/逾時回 None)。errors="replace" 同檔內其餘 subprocess
    呼叫的理由:cp950 的 Windows 上嚴格解碼會丟 UnicodeDecodeError,那不是 OSError
    也不是 SubprocessError,會從 except 逃出去把整份回報帶走。"""
    try:
        out = subprocess.run(cmd, stdin=subprocess.DEVNULL, capture_output=True, text=True,
                             errors="replace", timeout=timeout)
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout


def _disk_pct():
    """根磁碟已用百分比(df 的 Use% 口徑:used /(used+avail),無條件進位)。"""
    try:
        if platform.system() == "Windows":
            usage = shutil.disk_usage(os.path.splitdrive(BASE)[0] + os.sep)
            return int(math.ceil(usage.used * 100.0 / usage.total)) if usage.total else None
        st = os.statvfs("/")
        used = st.f_blocks - st.f_bfree
        denom = used + st.f_bavail
        return int(math.ceil(used * 100.0 / denom)) if denom else None
    except (OSError, ValueError, ZeroDivisionError):
        return None


class _MEMORYSTATUSEX(ctypes.Structure):
    _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong),
                ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong),
                ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]


def _memory():
    """(total_mb, avail_mb, swap_total_mb);任一項取不到就整組 None。

    平台判「快沒記憶體又沒 swap」要三個數字都在(monitor.py 的檢查 7 口徑),所以
    這裡不做半套。Windows 的 swap = 分頁檔總量減去實體記憶體(GlobalMemoryStatusEx
    的 TotalPageFile 含實體),負數視為 0。"""
    try:
        if platform.system() == "Windows":
            stat = _MEMORYSTATUSEX()
            stat.dwLength = ctypes.sizeof(_MEMORYSTATUSEX)
            if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat)):
                return None, None, None
            mb = 1024 * 1024
            swap = max(0, int(stat.ullTotalPageFile) - int(stat.ullTotalPhys))
            return (int(stat.ullTotalPhys) // mb, int(stat.ullAvailPhys) // mb, swap // mb)
        info = {}
        with open("/proc/meminfo", encoding="utf-8", errors="replace") as f:
            for line in f:
                key, _, rest = line.partition(":")
                if key in ("MemTotal", "MemAvailable", "SwapTotal"):
                    info[key] = int(rest.strip().split()[0]) // 1024  # kB → MB
        if len(info) < 3:
            return None, None, None
        return info["MemTotal"], info["MemAvailable"], info["SwapTotal"]
    except (OSError, ValueError, AttributeError, IndexError):
        return None, None, None


def _gateway_state():
    """Telegram bridge 服務的狀態,正常一律正規化成 "active"(Windows 的 NSSM 講
    SERVICE_RUNNING,Linux 的 systemd 講 active——平台只比一個字)。取不到回 None。"""
    if platform.system() == "Windows":
        out = _run(["nssm", "status", _TG_SERVICE])
        if out is None and os.path.isfile(_NSSM_FALLBACK):
            out = _run([_NSSM_FALLBACK, "status", _TG_SERVICE])
        if out is None:
            return None
        state = out.strip().replace("\x00", "").lower()
        return "active" if state == "service_running" else (state or None)
    out = _run(["systemctl", "is-active", _TG_SERVICE])
    return (out.strip() or None) if out is not None else None


def resources():
    mem_total, mem_avail, swap_total = _memory()
    return {
        "disk_pct": _disk_pct(),
        "mem_total_mb": mem_total,
        "mem_avail_mb": mem_avail,
        "swap_total_mb": swap_total,
        "gateway": _gateway_state(),
    }


def tg_chat_ids():
    """這台機器目前配對到的 Telegram chat id。

    平台的 fan-out router 靠 openclaw_instances.tg_chat_ids 判斷「這個人有沒有配對
    TG」,而那個欄位在 blave-agent 機隊唯一的更新來源就是退役掉的那支 SSH 掃描
    (_deploy_sync_chat_ids)——所以它必須跟著這份回報上來,兩件事同進同出。

    來源同掃描讀的那個檔(credentials/telegram-default-allowFrom.json,
    sync_notify_compat.py 從 config/telegram.json 同步過去的 lib/notify 相容檔);
    相容檔還沒同步時退回 config/telegram.json 自己的 allowed_chat_id。
    驗證照 /report-telegram 那道:只收 list、元素只收 int/str、截 20(平台再驗一次)。"""
    ids = None
    data = _read_json(os.path.join(BASE, "credentials",
                                   "telegram-default-allowFrom.json"))
    if isinstance(data, dict) and isinstance(data.get("allowFrom"), list):
        ids = data["allowFrom"]
    if ids is None:
        tg = _read_json(os.path.join(BASE, "config", "telegram.json"))
        chat_id = tg.get("allowed_chat_id") if isinstance(tg, dict) else None
        ids = [chat_id] if isinstance(chat_id, (int, str)) else []
    return [c for c in ids if isinstance(c, (int, str))
            and not isinstance(c, bool)][:_TG_CHAT_IDS_MAX]


def tg_pair_gen():
    """The pairing generation telegram_pairing.reset() stamped into telegram.json
    (None on a machine never reset from the web). The api only accepts tg_chat_ids
    from a report carrying its current generation right after an unlink/re-link —
    otherwise a report built before the reset would write the old chat back."""
    tg = _read_json(os.path.join(BASE, "config", "telegram.json"))
    gen = tg.get("pair_gen") if isinstance(tg, dict) else None
    return gen if isinstance(gen, str) else None


def build_report():
    # generation BEFORE the chat ids: a reset landing between the two reads then pairs
    # an old generation with the cleared chats (refused / harmless), never an old chat
    # with the new generation (which the api would accept and write back)
    pair_gen = tg_pair_gen()
    # {} = never configured (new machine); None = file there but unreadable. A client
    # that saves the whole amounts map from this report must refuse on None, or it
    # overwrites every key it could not see.
    cfg_path = os.path.join(WORKSPACE, "manager", "portfolio_config.json")
    cfg = _read_json(cfg_path) if os.path.exists(cfg_path) else {}
    if not isinstance(cfg, dict):
        cfg = None
    hb = _mtime(os.path.join(WORKSPACE_STATE, "heartbeat", "reconciler"))
    last = _read_json(os.path.join(WORKSPACE, "manager", "last_reconcile.json"))
    sched = scheduled_strategies()
    vens = venues()
    stopped = restart_stop(hb, cfg if isinstance(cfg, dict) else {}, vens)
    configured = portfolio_configured(cfg_path, hb, last)

    report = {
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
            # alive = trading: a reconciler gated by the restart record keeps a
            # fresh heartbeat but sends nothing
            "alive": _fresh(hb) and stopped is None,
            "stopped": stopped,
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
        "account_guard": account_guard(),
        # id not present in the dict = no key stored for it. Front end reads
        # this as venues[id] (web/.../workspace.html cxSupport()) — id present
        # with order/account both false = key saved, modules not built yet.
        "venues": vens,
        # capability signals: the web hides controls the machine can't honor —
        # without this the 「暫停並全部平倉」 button halts only and LOOKS
        # successful. can_flatten keys on the actual artifact (flatten.py in
        # the workspace), which is also exactly the listener's own check —
        # true on any OS/generation whose workspace has the close-all layer —
        # except when 群益 is the only venue it could close and this identity
        # can't log in to SKCOM (see can_flatten()).
        "platform": platform.system(),
        "can_flatten": can_flatten(vens),
        # self_ledger: whether this machine diffs against the bot's own book —
        # the web's stop dialog phrases what 「關閉 bot 部位」actually closes
        # from this (bot's book only vs the whole account), the desktop's
        # start dialog whether manual positions can be touched.
        "self_ledger": own_positions_only(cfg, hb, last),
        # can_trade_portfolio: a Type C strategy may be funded (the pages unlock it)
        "can_trade_portfolio": can_trade_portfolio(),
        # can_wait_start: whether the workspace's reconcile path understands
        # state/signal_gate.json (the 「啟動,等新訊號才進場」 option) — keyed
        # on the actual artifact like can_flatten, so the web never offers a
        # start mode the machine would silently ignore (an old workspace
        # ignoring the gate degrades resume_wait to a full catch-up resume).
        "can_wait_start": _workspace_has_signal_gate(),
        # downtime pause (lib/downtime.py): a stop that crossed a bar close
        # froze every live strategy; the exit is the whole-machine start
        # (resume / resume_wait), which ends every pause. `downtime_pause` is
        # the per-strategy detail of what is frozen; no page renders a
        # per-strategy confirmation card any more.
        "can_downtime_pause": _workspace_has_downtime_pause(),
        "downtime_pause": downtime_pause_view(cfg, last),
        # 策略管理 subtab: member figures, allocators, the last proposal and
        # the walk-forward job/result (see manager_view). can_manage keys the
        # web's 「機器尚未更新」 fallback exactly like can_flatten/can_wait_start.
        "manager": manager_view(),
        # 磁碟／記憶體／gateway 與配對的 chat id:平台側 SSH 巡檢退役後改走這裡
        # (見 resources / tg_chat_ids)
        "resources": resources(),
        "tg_chat_ids": tg_chat_ids(),
        "tg_pair_gen": pair_gen,
        # 機器側 P1／P2 事件(state/events.jsonl 裡水位線以上的那些)。平台照 id
        # 去重、落 agent_event 再 fan-out,回應的 acked_through 由 main() 寫回。
        "events": events.unsent(),
        "reported_at": int(time.time()),
    }
    # False = amounts were never saved AND the reconcile that runs next is the
    # read-only one (places nothing, closes included, until a save). None = the
    # key is left out: see portfolio_configured() — an absent key is the pages'
    # old-machine branch, which warns about closing.
    if configured is not None:
        report["portfolio_configured"] = configured
    upd = workspace_update()
    if upd is not None:
        report["workspace_update"] = upd
    # 群益 cloud connect progress (runtime/capital_connect.py) — the one status
    # the desktop app and the web both render; absent until a step has run
    cap = _read_json(os.path.join(WORKSPACE_STATE, "capital_connect.json"))
    if isinstance(cap, dict):
        report["capital_connect"] = cap
    return report


WORKSPACE_UPDATE_TTL_S = 24 * 3600
# `applying` is written before the run and overwritten only when the run ends;
# a script killed in between (ssh timeout, turn end, reboot) never writes again
# and the desktop would draw 更新中… for the whole day. A healthy run is at most
# --wait-busy 600 plus the copy, so past this the run is dead.
WORKSPACE_UPDATE_APPLYING_TTL_S = 20 * 60


def workspace_update():
    """manager/update_workspace.py's state/workspace_update.json verbatim
    ({state: applying|done|failed, outcome, from, to, restarted, reason,
    replaced_changed, backup_dir, ...}) while it is under a day old — the
    desktop draws 更新中… from `applying` and the one line after from `done`.
    Older, or unreadable: absent — a stale line must not come back every
    report for ever. An `applying` older than WORKSPACE_UPDATE_APPLYING_TTL_S
    is reported as the failure it is, in status_doc's shape."""
    path = os.path.join(WORKSPACE_STATE, "workspace_update.json")
    mt = _mtime(path)
    if not mt or time.time() - mt >= WORKSPACE_UPDATE_TTL_S:
        return None
    doc = _read_json(path)
    if not (isinstance(doc, dict) and doc.get("state")):
        return None
    if doc["state"] == "applying" and time.time() - mt >= WORKSPACE_UPDATE_APPLYING_TTL_S:
        doc = dict(doc, state="failed", outcome="error", restarted=False,
                   reason="applying timed out", replaced_changed=[], backup_dir=None,
                   restart_stopped=False, version_written=False)
    return doc


def downtime_pause_view(cfg, last):
    """state/downtime_pause.json joined per strategy with:
    what the strategy wants now, what the account holds, and where the current
    direction began. None when nothing is paused. Read as JSON only — the
    workspace's own code is never imported here."""
    doc = _read_json(os.path.join(WORKSPACE_STATE, "downtime_pause.json"))
    entries = doc.get("strategies") if isinstance(doc, dict) else None
    if not isinstance(entries, dict) or not entries:
        return None
    # the UI-authoritative amounts, same precedence as lib.portfolio
    mirror = _read_json(os.path.join(WORKSPACE, "manager", "amounts.ui.json"))
    amounts = (mirror or {}).get("amounts") if isinstance(mirror, dict) else None
    if not isinstance(amounts, dict):
        amounts = (cfg or {}).get("amounts") if isinstance(cfg, dict) else None
    amounts = amounts if isinstance(amounts, dict) else {}
    snap_target = (last or {}).get("target") if isinstance(last, dict) else None
    snap_actual = (last or {}).get("actual") if isinstance(last, dict) else None
    rows = []
    for name in sorted(entries):
        entry = entries[name]
        if not isinstance(entry, dict):
            entry = {}  # an entry shape this runtime does not know is still FROZEN — show it
        state = _read_json(os.path.join(WORKSPACE, "strategies", name, "state.json"))
        state = state if isinstance(state, dict) else {}
        symbol = state.get("symbol")
        key = symbol.replace("-", "").upper() if isinstance(symbol, str) and symbol else None
        if key and _strategy_market(name) == "spot":
            key += "@spot"
        try:
            position = float(state.get("position", 0))
            amount = float(amounts.get(name, 0))
        except (TypeError, ValueError):
            position, amount = None, None
        t_row = snap_target.get(key) if isinstance(snap_target, dict) and key else None
        others = sorted(
            c.get("strategy") for c in (t_row or {}).get("contributors") or []
            if isinstance(c, dict) and c.get("paused") and c.get("strategy") != name)
        since = state.get("direction_since")
        rows.append({
            "name": name,
            "status": entry.get("status") if entry.get("status") in ("pending", "hold", "wait") else "pending",
            "interval": entry.get("interval"),
            "missed_bars": entry.get("missed_bars"),
            "decided_at": entry.get("decided_at"),
            "symbol": key,
            # every key frozen on this strategy's account — the one it trades
            # now plus any it traded when paused (a SYMBOL changed mid-pause)
            "frozen_keys": sorted((entry.get("keys") or {}) if isinstance(entry.get("keys"), dict) else {}),
            "position": position,
            "amount": amount,
            "target_usd": None if position is None else round(position * amount, 2),
            # the ACCOUNT's position on that symbol (all strategies netted) —
            # None until a reconcile round has read it
            "actual": snap_actual.get(key) if isinstance(snap_actual, dict) and key else None,
            "symbol_frozen_by": others,
            "direction_since": since if isinstance(since, dict) else None,
            "signal_updated_at": _mtime(os.path.join(WORKSPACE, "strategies", name, "state.json")),
        })
    gaps = [g for g in doc.get("gaps") or [] if isinstance(g, list) and len(g) >= 2
            and all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in g[:2])]
    return {
        "detected_at": doc.get("detected_at"),
        "down_from": min((g[0] for g in gaps), default=None),
        "down_to": max((g[1] for g in gaps), default=None),
        "offline_s": int(sum(g[1] - g[0] for g in gaps)) if gaps else None,
        "sources": sorted({str(g[2]) for g in gaps if len(g) > 2}),
        "strategies": rows,
    }


def _workspace_has_downtime_pause():
    """lib/downtime.py AND a portfolio.py that freezes on it — the workspace
    updates file by file, and lib/downtime.freeze_wired refuses to pause on the
    same condition. Bytes for the reason given below."""
    try:
        with open(os.path.join(WORKSPACE, "lib", "portfolio.py"), "rb") as f:
            wired = b"downtime.frozen()" in f.read()
    except OSError:
        return False
    return wired and os.path.isfile(os.path.join(WORKSPACE, "lib", "downtime.py"))


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


def _handle_ack(resp):
    """回應的 acked_through=平台已收下的最大事件 id。寫回 state/events.acked,
    下一輪只送比它新的,並在水位線以下輪替檔案。

    回應解不出 acked_through(舊版 api、或是被中間層改寫過的 body)就什麼都不做:
    事件留在檔裡下一輪再送,平台照 id 去重,重送的成本只有頻寬。"""
    try:
        acked = json.loads(resp).get("acked_through")
    except (ValueError, TypeError, AttributeError):
        return
    if not isinstance(acked, int) or isinstance(acked, bool) or acked <= 0:
        return
    events.save_acked(acked)
    dropped = events.rotate()
    if dropped:
        print(f"[portfolio_reporter] events rotated: {dropped} acked line(s) dropped",
              file=sys.stderr)


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
    # 回報成功之後才動水位線:回報失敗=平台沒收到,事件必須留著下一輪重送
    _handle_ack(resp)


if __name__ == "__main__":
    main()
