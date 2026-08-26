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
import contextlib
import os
import platform
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

try:
    import fcntl
except ImportError:  # Windows — no concurrent .env writer there (first-boot
    fcntl = None     # secret injection is a Linux systemd unit)

WORKSPACE = os.environ.get("BLAVE_AGENT_WORKSPACE", "/opt/blave-agent/workspace")
WORKSPACE_STATE = os.path.join(WORKSPACE, "state")
# Linux reconciler supervision unit (see systemd/blave-agent-reconciler.service).
# Ships to the whole fleet via the release channel's jobs.json (installed —
# the unit has no [Install] section at all, so `enable` is structurally
# impossible). _cmd_restart_reconciler only ever start/restart/stops it —
# NEVER enable, on purpose (Wei 2026-08-20): trading is opt-in, a reboot
# must force it off, the user presses 啟動下單 again to resume. `Restart=`
# inside the unit still covers a mid-session kill (patch restarting
# "gateway" etc.) — that's active-state crash recovery, unrelated to
# boot-time startup.
RECONCILER_UNIT = "blave-agent-reconciler.service"
RECONCILER_UNIT_PATH = f"/etc/systemd/system/{RECONCILER_UNIT}"
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

    # 「啟動並補齊部位」must honor the choice: a signal gate left over from an
    # earlier resume_wait would silently keep excluding those strategies from
    # reconciling — remove it BEFORE clearing HALT (mirror of resume_wait's
    # write-then-clear order). A failed removal propagates: HALT stays, the
    # command errors loudly, the user retries — fail-closed, never a resume
    # that half-honors a stale gate.
    gate_path = os.path.join("state", "signal_gate.json")
    try:
        os.remove(gate_path)
    except FileNotFoundError:
        pass
    clear_halt("web")
    return "resumed"


def _cmd_resume_wait(args):
    """啟動,等新訊號才進場 (Wei 2026-08-20): resume WITHOUT catch-up orders.
    Records every funded strategy's current signal value into
    state/signal_gate.json BEFORE clearing HALT — lib.portfolio's reconcile
    path excludes a gated strategy's symbol from diffing until its signal
    CHANGES from the recorded value (then the gate lifts permanently and it
    trades normally). Write order matters: gate first, then clear_halt — the
    reconciler fires within seconds of the HALT mtime change, and a round
    landing between the two must see the gate already in place.
    An old workspace without gate support ignores the file entirely, which
    degrades to plain resume (catch-up) — the web only offers this option
    when the reporter says the workspace supports it (can_wait_start)."""
    import json as _json

    from lib.guard import clear_halt
    from lib.portfolio import load_portfolio_config, strategy_amounts

    cfg = load_portfolio_config()
    amounts = strategy_amounts(cfg)
    exchanges = cfg.get("exchanges", {})
    gate = {}
    for name, amt in amounts.items():
        if not exchanges.get(name) or float(amt) == 0:
            continue
        state_path = os.path.join("strategies", name, "state.json")
        if not os.path.exists(state_path):
            continue  # no state yet = nothing to gate; it trades on first signal
        try:
            with open(state_path) as f:
                gate[name] = float(_json.load(f).get("position", 0))
        except (ValueError, TypeError, OSError) as e:
            # A CORRUPT/mid-write state.json is not "nothing to gate" — silently
            # skipping would leave this strategy un-gated and it would catch up
            # at market against the user's explicit choice. Fail the whole
            # command loudly: HALT stays set, the user presses start again.
            raise RuntimeError(
                f"resume_wait: could not read {state_path} ({e}) — not resuming; "
                f"press start again in a few seconds") from e
    gate_path = os.path.join("state", "signal_gate.json")
    os.makedirs(os.path.dirname(gate_path), exist_ok=True)
    tmp = gate_path + ".tmp"
    with open(tmp, "w") as f:
        _json.dump(gate, f, indent=2)
    os.replace(tmp, gate_path)
    clear_halt("web")
    return f"resumed_wait gated={len(gate)}"


_CRED_ENV_RE = re.compile(
    r"^([A-Za-z0-9_]+)_(API_KEY|SECRET_KEY|PASSWORD|PASSPHRASE)$", re.IGNORECASE
)
# Only the platform's own data-API keys survive a venue bind. TW brokers are
# in the eviction pool like any exchange — one bound trading venue per
# machine, TW included (2026-08-07 拍板). ADMIN added defensively after the
# B6 PASSWORD-suffix fix made `admin_password` (RDP recovery cred on older
# machines) match _CRED_ENV_RE for the first time: harmless today (no
# admin_api_key sibling exists anywhere), but one future admin_api_key write
# away from being read as a "bound venue" and silently evicted by an unrelated
# rebind — see the RDP Password Incident this fleet already had.
_CRED_KEEP_IDS = {"BLAVE", "ADMIN"}


@contextlib.contextmanager
def _env_lock():
    """Serialize every .env read-modify-write against first-boot.sh, which
    flocks the same .env.lock around its secret injection. Without this the
    injector's write can land inside our read→replace window (or vice versa)
    and either side's lines get eaten — 29026 2026-08-07 lost blave_api_key
    exactly this way. Lock file, not .env itself: our writes os.replace the
    .env inode, and a lock on a replaced inode guards nothing."""
    if fcntl is None:
        yield
        return
    fd = os.open(os.path.join(WORKSPACE, ".env.lock"), os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)  # closing the fd releases the flock


def _venue_cred_ids(lines, skip_ids=frozenset()):
    """IDs holding a complete credential pair ({ID}_API_KEY + one of
    {ID}_SECRET_KEY / {ID}_PASSWORD / {ID}_PASSPHRASE) in these .env lines —
    the pair IS a bound venue, TW brokers same pool; a lone key with no
    secret-shaped sibling is a service key (OPENAI_API_KEY), not a venue.
    Single source for both the eviction sweep and bound/unbound checks.
    Capital's shape is {ID}_API_KEY + {ID}_PASSWORD (canonical env names
    decided 2026-08-14, references/capital-broker.md) — PASSWORD joined the
    accepted secret suffixes for this (fixes audit B6: capital never read as
    bound, so every 下單設定 save wiped its `exchanges` routing)."""
    suffixes = {}
    for l in lines:
        m = _CRED_ENV_RE.match(l.split("=", 1)[0].strip())
        if m and m.group(1).upper() not in _CRED_KEEP_IDS | skip_ids:
            suffixes.setdefault(m.group(1).upper(), set()).add(m.group(2).upper())
    return {
        i for i, s in suffixes.items()
        if "API_KEY" in s and s & {"SECRET_KEY", "PASSWORD", "PASSPHRASE"}
    }


def _write_ui_amounts_mirror(amounts, exchanges, only_if_present=False):
    """manager/amounts.ui.json — the LAST UI-confirmed amounts/exchanges
    (deployment redline L2, spec §3.1). lib/portfolio's load_portfolio_config
    prefers this file over portfolio_config.json when it exists, so an agent
    hand-editing the config can no longer change funding/routing. Called by
    every writer this listener has for those two keys (_cmd_amounts, the
    credential-evict routing clear via _clear_evicted_in_ui_mirror, the
    full-unbind membership clear — the only three writers, audited
    2026-08-24), and always BEFORE the corresponding portfolio_config write
    (audit P2-2): the reconciler mtime-watches the CONFIG, so mirror-first
    means the round the config write triggers already sees the new
    authoritative values — the reverse order left a window that traded old
    values and burned the mismatch alert's 24h cooldown on a false positive.
    only_if_present: the two credential-side writers only UPDATE an existing
    mirror — they must never be the FIRST writer, or a legacy weights-only
    machine would get its amounts frozen to {} before the user ever saved
    下單設定 (the guard is fail-open until that first save). Best-effort but
    loud: a failed mirror leaves the guard reading stale values."""
    path = os.path.join(WORKSPACE, "manager", "amounts.ui.json")
    if only_if_present and not os.path.isfile(path):
        return
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        doc = {"amounts": amounts if isinstance(amounts, dict) else {},
               "exchanges": exchanges if isinstance(exchanges, dict) else {},
               "saved_at": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())}
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(doc, f, indent=2)
        os.replace(tmp, path)  # atomic, same convention as portfolio_config
    except OSError as e:
        _log(f"ui amounts mirror write failed: {type(e).__name__}: {e}")


def _write_ui_cred_manifest(lines):
    """manager/credentials.ui.json — venue ids ({"ids": [...]}) whose
    credential PAIRS the UI just confirmed into .env (deployment redline L2,
    spec §3.2; paper included via the same pair rule). lib/venue_wiring only
    routes ids in this manifest when it exists, so keys an agent hand-writes
    into .env never become a live venue. Best-effort but loud: on failure a
    stale manifest keeps the just-bound venue OUT of routing (fail-closed
    direction — no money moves on an unconfirmed bind)."""
    try:
        ids = sorted(i.lower() for i in _venue_cred_ids(lines))
        path = os.path.join(WORKSPACE, "manager", "credentials.ui.json")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"ids": ids,
                       "saved_at": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())},
                      f, indent=2)
        os.replace(tmp, path)
    except OSError as e:
        _log(f"credentials manifest write failed: {type(e).__name__}: {e}")


def _ui_manifest_ids():
    """Lowercased ids from manager/credentials.ui.json, or None when
    absent/invalid — mirrors lib/venue_wiring's fail-open reader."""
    try:
        with open(os.path.join(WORKSPACE, "manager", "credentials.ui.json")) as f:
            ids = json.load(f).get("ids")
        if not isinstance(ids, list):
            return None
        return {str(i).lower() for i in ids}
    except (OSError, ValueError, AttributeError):
        return None


def _clear_evicted_in_ui_mirror(evicted_ids):
    """Evict-side mirror update (audit P1-3): NEVER sources amounts from
    portfolio_config — that is exactly the file an agent may have tampered
    with, and copying it here would launder the tampered values into the
    authoritative mirror. Reads the EXISTING mirror, keeps its amounts, and
    only blanks exchanges values pointing at the evicted venues. No mirror =
    no first write (guard stays fail-open until the user's first 下單設定
    save); unreadable mirror = leave it alone, loudly."""
    path = os.path.join(WORKSPACE, "manager", "amounts.ui.json")
    try:
        with open(path) as f:
            mirror = json.load(f)
    except FileNotFoundError:
        return
    except (OSError, ValueError) as e:
        _log(f"ui mirror evict update failed: {type(e).__name__}: {e}")
        return
    if not isinstance(mirror, dict) or not isinstance(mirror.get("exchanges"), dict):
        return
    cleared = {k: ("" if v in evicted_ids else v)
               for k, v in mirror["exchanges"].items()}
    if cleared != mirror["exchanges"]:
        _write_ui_amounts_mirror(mirror.get("amounts"), cleared)


def _cmd_credentials(args):
    """Write exchange keys into the workspace .env.

    Merge for everything EXCEPT other venues' credentials: .env also holds
    the Blave data-API keys injected at first boot (clobbering those would
    take the machine's market data down with it), but a single bound trading
    venue per machine is the designed case — TW brokers included. Binding
    venue X evicts every other venue's credentials in the same write, or a
    Binance→BingX switch leaves BINANCE_* behind and puts the machine on
    venue_wiring.detect_venue's multiple-venues warning path. Evicted =
    complete credential PAIRS only ({ID}_API_KEY with an {ID}_SECRET_KEY /
    {ID}_PASSWORD / {ID}_PASSPHRASE sibling) — that shape IS the previously
    bound venue(s); singleton service keys (OPENAI_API_KEY — no secret sibling),
    venue support keys (SINOPAC_CA_PATH), user-added lines and comments all
    survive, deliberately.
    """
    env = args.get("env")
    if not isinstance(env, dict) or not env:
        raise ValueError("credentials needs an env mapping")
    for k, v in env.items():
        # ASCII-only on purpose: a Unicode-alnum key passes isalnum() but never
        # matches _CRED_ENV_RE — keys the eviction sweep can't see
        if not isinstance(k, str) or not re.fullmatch(r"[A-Za-z0-9_]+", k):
            raise ValueError("bad env key")
        # a newline in a value would smuggle extra .env lines past every check
        # here (e.g. a fresh BLAVE_API_KEY= line)
        if not isinstance(v, str) or "\n" in v or "\r" in v:
            raise ValueError("bad env value")
    writing = {m.group(1).upper() for k in env if (m := _CRED_ENV_RE.match(k))}
    # the remove side refuses to drop BLAVE_*; the write side must refuse to
    # overwrite it too, or a custom exchange named "Blave" clobbers the
    # platform keys
    if writing & _CRED_KEEP_IDS:
        raise ValueError("platform credentials are not writable here")

    path = os.path.join(WORKSPACE, ".env")
    with _env_lock():
        lines = []
        try:
            with open(path) as f:
                lines = f.read().splitlines()
        except FileNotFoundError:
            pass  # first bind on a fresh workspace
        except OSError as e:
            # fail-closed like _cmd_amounts: rebuilding from just this payload
            # would silently drop the BLAVE data-API keys. A retry costs nothing.
            raise RuntimeError(f".env unreadable ({type(e).__name__}) — try again")
        # casefold: an agent-hand-written lowercase twin of the same key must be
        # replaced, not left to coexist with the new line
        keys_cf = {k.casefold() for k in env}
        kept = [l for l in lines if l.split("=", 1)[0].strip().casefold() not in keys_cf]
        evicted_ids = set()
        # Bind = the FINAL state pairs up an id this payload touches — judged
        # on kept+payload, not the payload alone, or a two-step single-key
        # write (API_KEY now, SECRET_KEY later) completes a pair without ever
        # tripping eviction (audit B1). A pure service-key write (no pair
        # formed with its own id) still evicts nothing.
        binding = _venue_cred_ids(kept + [k + "=" for k in env]) & writing
        if binding:  # this write binds a trading venue
            evict = _venue_cred_ids(kept, skip_ids=writing)
            if evict:

                def _stale_cred(line):
                    m = _CRED_ENV_RE.match(line.split("=", 1)[0].strip())
                    return bool(m) and m.group(1).upper() in evict

                kept = [l for l in kept if not _stale_cred(l)]
                evicted_ids = {i.lower() for i in evict}
        kept += [f"{k}={env[k]}" for k in env]
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            f.write("\n".join(kept) + "\n")
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)  # atomic — a torn .env would strand the machine keyless
    _write_ui_cred_manifest(kept)  # final lines = the UI-confirmed bound set
    if evicted_ids:
        # eviction == unbind for the old venue: halt like credentials_remove
        # does, or strategies still routed there run blind until auto-halt
        # trips (~15 min)
        try:
            from lib.guard import trip_halt
            trip_halt(f"venue rebind ({'/'.join(sorted(evicted_ids))} evicted)", "web")
        except Exception as e:
            print(f"[credentials] rebind-halt failed: {e}", file=sys.stderr)
        # …and the evicted venue must not linger as a routing target (audit
        # B2): empty those exchanges values, same as _cmd_amounts does for
        # unbound venues. Best-effort like the halt — the keys are already
        # swapped, failing the whole command here helps nobody. Mirror FIRST,
        # then config (P2-2 write order — see _write_ui_amounts_mirror), and
        # the mirror update sources from the mirror itself, never the config
        # (P1-3 — see _clear_evicted_in_ui_mirror).
        _clear_evicted_in_ui_mirror(evicted_ids)
        cpath = os.path.join(WORKSPACE, "manager", "portfolio_config.json")
        try:
            with open(cpath) as f:
                cfg = json.load(f)
            if isinstance(cfg, dict) and isinstance(cfg.get("exchanges"), dict):
                cleared = {k: ("" if v in evicted_ids else v)
                           for k, v in cfg["exchanges"].items()}
                if cleared != cfg["exchanges"]:
                    cfg["exchanges"] = cleared
                    with open(cpath + ".tmp", "w") as f:
                        json.dump(cfg, f, indent=2)
                    os.replace(cpath + ".tmp", cpath)  # atomic, reconciler-watched
        except (OSError, ValueError) as e:
            _log(f"evicted-venue routing clear failed: {type(e).__name__}: {e}")
    # rebind restores the signal schedules the unbind cleared (audit: without
    # this, 解除→重綁→啟動下單 trades real money on signals frozen at unbind
    # time — the exact quiet failure scheduled_strategies() exists to surface).
    # Gated on a venue actually being bound now (pair rule): a service-key
    # write on an unbound machine must not wake the schedules back up.
    try:
        with open(os.path.join(WORKSPACE, "manager", "portfolio_config.json"),
                  encoding="utf-8") as f:
            amounts = json.load(f).get("amounts") or {}
        if amounts and _venue_cred_ids(kept):
            _sync_strategy_crons(set(amounts))
    except (OSError, ValueError, AttributeError):
        pass
    return f"credentials={len(env)}"  # count only — never the keys or values


# ── strategy signal-refresh scheduling(選到就跑,2026-08-03 拍板)────────────
# Picked into the 下單設定 table = its signal must stay fresh (the 目標部位
# column is live data), funded or not. Signal runs are read-only — orders are
# the reconciler's alone — so scheduling early is free.
#
# Type A/C (has INTERVAL/fetch_data — see references/deployment.md) are
# scheduled by the in-process wait_for_bar loop below (_scheduler_loop), not
# crontab/schtasks: this thread is already a long-lived daemon, so there is
# no reason to have it shell out to the OS scheduler to remind itself to wake
# up once a minute — see blaveclaw-config/manager/wait_for_bar.py's own
# docstring for why a fixed "run N minutes after the hour" cron guesses
# wrong. Type B strategies have no INTERVAL/fetch_data contract to poll a bar
# against (references/deployment.md), so they keep the plain fixed-cadence
# crontab/schtasks path unchanged below.

_CRON_TAG = "# blave-web"  # marks the lines this handler owns
# Guards every crontab read-modify-write below (_sync_strategy_crons,
# _purge_strategy_schedules, _migrate_legacy_ac_crons) — `crontab -l` then
# `crontab -` is a classic read/replace race, and with the scheduler thread
# now able to run the migration sweep independently of the dispatch thread's
# own syncs, two writers hitting this in the same window is a real
# possibility (not hypothetical — see _run_scheduler_cycle's transition
# handling), where the second write silently clobbers the first's.
_cron_lock = threading.Lock()
_INTERVAL_RE = re.compile(r'^\s*INTERVAL\s*=\s*["\']([^"\']+)["\']', re.M)
# Value-format validator — byte-for-byte the SAME pattern as
# wait_for_bar.py:185 (`_INTERVAL_RE = re.compile(r"^(\d+)(min|m|h|d|w)$")`)
# and healthcheck.py:105, matched with fullmatch and NO .strip()/.lower()
# relaxation (wait_for_bar.py's own _interval_to_timedelta doesn't relax
# either — it matches the raw INTERVAL attribute as-is). This is deliberately
# stricter than "just non-empty": _strategy_has_interval below used to accept
# any non-empty quoted value as Type A/C, so a strategy with a malformed
# INTERVAL (e.g. "hourly", "5Min", trailing whitespace) got migrated off its
# working Type B crontab and handed to wait_for_bar.py, whose own
# _interval_to_timedelta then raises ValueError on that exact value — caught
# by its top-level except → _alert_wrapper_error (6h cooldown) — and the
# strategy never runs again, with the reconciler silently holding any funded
# position (code-auditor finding, 2026-08-19). An unparseable value is
# therefore never Type A/C — Type B (old crontab) at least still runs.
_INTERVAL_VALUE_RE = re.compile(r"^(\d+)(min|m|h|d|w)$")
# Unit spellings must match blaveclaw-config/manager/wait_for_bar.py's
# _INTERVAL_RE/_UNIT_TO_KW and manager/healthcheck.py's _UNIT_TO_MINUTES —
# three copies now (see those files' own comments on this); change all three
# together or they silently disagree on cadence.
_UNIT_TO_MINUTES = {"min": 1, "m": 1, "h": 60, "d": 1440, "w": 10080}


def _strategy_source(name):
    """strategies/<name>/strategy.py's text, or None — the single file read
    every INTERVAL-sniffing helper below shares (cadence, type split,
    healthcheck registration)."""
    try:
        with open(os.path.join(WORKSPACE, "strategies", name, "strategy.py"),
                  encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return None


def _wait_for_bar_available():
    """True once this workspace has pulled blaveclaw-config's manager/wait_for_bar.py
    (a2ced19+) — NOT every machine has, at any given moment: workspaces update
    independently of this runtime, on their own cadence. Gates the whole A/C
    split below: without this, a runtime update landing before a given
    workspace's own update would classify a strategy as Type A/C, migrate away
    its working Type B crontab line, then every scheduler tick fails with
    FileNotFoundError — silently freezing that strategy's signal fleet-wide
    until the workspace catches up. Until the file exists, EVERY strategy is
    treated as Type B (old crontab/schtasks behavior, unchanged) — never
    partially-migrated."""
    return os.path.isfile(os.path.join(WORKSPACE, "manager", "wait_for_bar.py"))


def _strategy_has_interval(name):
    """True = Type A/C (wait_for_bar-scheduled in-process), False = Type B
    (no INTERVAL/fetch_data contract — stays on crontab/schtasks). Always
    False if this workspace doesn't have wait_for_bar.py yet — see
    _wait_for_bar_available. Also False if INTERVAL is present but its VALUE
    doesn't pass _INTERVAL_VALUE_RE — see that constant's comment for why
    "present" alone is not enough."""
    if not _wait_for_bar_available():
        return False
    src = _strategy_source(name)
    if not src:
        return False
    m = _INTERVAL_RE.search(src)
    return bool(m and _INTERVAL_VALUE_RE.fullmatch(m.group(1)))


def _strategy_interval_minutes(name):
    """Declared INTERVAL in minutes, for state/deployments.json's
    expect_every_minutes (manager/healthcheck.py's staleness threshold).
    1440 (guess long, like healthcheck.py's own fallback) if unparseable —
    a late alert beats a false one. Only ever called for names
    _strategy_has_interval already accepted, so the fullmatch here always
    succeeds in practice — kept as an explicit check anyway rather than
    trusting that invariant silently."""
    src = _strategy_source(name)
    m = _INTERVAL_RE.search(src) if src else None
    if not m:
        return 1440
    mu = _INTERVAL_VALUE_RE.fullmatch(m.group(1))
    if not mu:
        return 1440
    return max(int(mu.group(1)) * _UNIT_TO_MINUTES[mu.group(2)], 1)


def _split_by_type(names):
    """{name} → (type_ac, type_b) — the only place this classification
    happens; every cron/scheduler sync below calls this instead of
    re-deriving it, so the split can't drift between call sites."""
    names = set(names)
    ac = {n for n in names if _strategy_has_interval(n)}
    return ac, names - ac


def _strategy_cadence(name):
    """Cron cadence from the strategy's declared INTERVAL (default 1h).
    Sub-hour intervals poll at their own pace (capped at 30m); ≥1h all poll
    hourly at :05 — re-running an unchanged signal is idempotent and cheap.
    Only ever called for Type B names now — see _split_by_type, the single
    gate that keeps Type A/C off this path entirely."""
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
    is at least findable (Windows has no run_strategy.sh alert wrapper yet).
    _cron_lock-guarded like the crontab twin — _migrate_legacy_ac_crons's own
    Windows branch touches the same _WIN_TASK_PREFIX namespace from the
    scheduler thread, and a query-then-act sequence here is exactly the kind
    of read-modify-write that lock exists to serialize."""
    try:
        with _cron_lock:
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
    """One tagged cron line per picked Type B strategy; drop tagged lines for
    strategies no longer picked. Only lines carrying _CRON_TAG are touched —
    agent-/user-made entries are none of our business. BLAVE_MODE=live makes
    the runner refresh signals even while the file's MODE says backtest.
    Best-effort: a cron failure must not fail the amounts write. Windows uses
    the schtasks twin (audit L6 — before it, web-picked strategies simply
    never ran on Windows machines).

    Type A/C strategies get NO crontab/schtasks entry at all — the
    in-process scheduler (_scheduler_loop) picks them up by re-reading
    portfolio_config.json's `amounts` itself on its own cadence; this
    function only wakes it early so a freshly-picked one doesn't wait for
    the next cycle (mirrors the Type B kickoff Popen in _cmd_amounts)."""
    ac, b = _split_by_type(names)
    if ac:
        _scheduler_wake.set()
    if platform.system() == "Windows":
        _sync_strategy_tasks_windows(b)
        return
    try:
        with _cron_lock:
            out = subprocess.run(["crontab", "-l"], capture_output=True, text=True, timeout=10)
            lines = out.stdout.splitlines() if out.returncode == 0 else []
            kept = [l for l in lines if _CRON_TAG not in l]
            for n in sorted(b):
                kept.append(
                    f"{_strategy_cadence(n)} cd {WORKSPACE} && "
                    f"BLAVE_MODE=live bash manager/run_strategy.sh {n} {_CRON_TAG}"
                )
            subprocess.run(["crontab", "-"], input="\n".join(kept) + "\n",
                           text=True, timeout=10, check=True)
        _log(f"cron sync: {len(b)} type B line(s) (+{len(ac)} type A/C via in-process scheduler)")
    except Exception as e:
        _log(f"cron sync failed: {type(e).__name__}: {e}")


# ── Type A/C in-process scheduler ───────────────────────────────────────────
# Replaces "N * * * * wait_for_bar.py <name>" crontab entries with a plain
# while-loop on this thread: command_listener is already a long-lived daemon
# thread (see module docstring), so there is no reason for it to write itself
# a system-cron reminder instead of just looping — the scheduling/timing logic
# lives here, in-process, exactly per the 定案方案.
#
# What does NOT live here: wait_for_bar.py's own freshness-check code
# (_tick/_check_freshness). Each tick below shells out to the unmodified CLI
# entrypoint (`python3 manager/wait_for_bar.py <name>`, PATH-resolved
# interpreter) instead of importing it — confirmed on a real machine while
# building this: /opt/blave-agent/venv (this runtime's own environment, ships
# via blave_agent/publish.py) carries only the Claude Agent SDK's own
# dependencies, not pandas/pyarrow/numpy/etc — those live in the system
# python strategies already run under (same one run_strategy.sh/cron always
# used). Importing wait_for_bar.py in-process would mean _check_freshness's
# `fetch_data()` call executing INSIDE this runtime's process with none of a
# strategy's actual dependencies available — every real strategy would
# ModuleNotFoundError immediately. This isn't a workaround for that gap: it's
# the same boundary _execution_engine_ready() elsewhere in this file already
# documents for a different command ("String probe, never an import —
# importing runs workspace code inside the listener"), applied consistently
# here too. Subprocess dispatch still gets everything the 定案方案 asked
# for — no crontab writes, no guessed cadence, in-process timing + wake +
# migration, per-strategy parallelism — plus process isolation the in-process
# design would not have had (a broken strategy.py can't take this process
# down with it).

SCHEDULER_INTERVAL_SECONDS = 60  # matches wait_for_bar.py's own cron cadence
# Generous: fetch_data() can legitimately take minutes (wait_for_bar.py's own
# cost-note docstring) on top of the strategy run's own 600s budget inside
# it — 1200 would be tight. Matches wait_for_bar.py's LOCK_STALE_SECONDS, so
# by the time this would actually fire, that file's own stale-lock recovery
# is already the active safety net, not this timeout.
SCHEDULER_TICK_TIMEOUT_SECONDS = 1800

_scheduler_wake = threading.Event()  # lets a fresh 下單設定 save skip the wait
_ac_migration_done = False  # see _run_scheduler_cycle's transition handling


def _strategy_subprocess_env():
    """Minimal env for a strategy/wait_for_bar.py subprocess — the bridge's
    BLAVE_PROXY_TOKEN etc. have no business inside agent/user strategy code.
    Linux: same allowlist the Type B kickoff Popen already uses (see
    _cmd_amounts) — a plain allowlist is fine there because it's Linux-only.
    Windows: _tick_one runs on BOTH platforms (unlike that Linux-only
    kickoff), and an allowlist is wrong here — _cmd_close_all's own comment
    already covers why: "Windows 的 python 少了 SystemRoot 等系統變數會直接
    起不來;要擋的只有 bridge 的 BLAVE_* 秘密". Same denylist pattern as
    that function, so a Windows tick doesn't die at interpreter boot."""
    if platform.system() == "Windows":
        env = {k: v for k, v in os.environ.items() if not k.startswith("BLAVE_")}
        env["BLAVE_MODE"] = "live"
        return env
    return {k: v for k, v in os.environ.items()
            if k in ("PATH", "HOME", "LANG", "USER", "SHELL")} | {"BLAVE_MODE": "live"}


def _bound_venue():
    """True if ANY exchange is bound on this machine right now. Gates the
    whole scheduler cycle: after a full unbind, _cmd_credentials_remove may
    deliberately KEEP `amounts` non-empty while stopping every schedule (Wei
    2026-08-05 — see that function's own comment, "membership kept") because
    the reconciler couldn't be confirmed stopped. A scheduler keyed on
    `amounts` alone would re-animate those signals on an unbound machine —
    exactly the "still looks like it's trading" failure that rule exists to
    prevent. A rebind (_cmd_credentials) or unpick-then-repick naturally
    resumes it — no separate resume path needed."""
    try:
        with open(os.path.join(WORKSPACE, ".env")) as f:
            return bool(_venue_cred_ids(f.read().splitlines()))
    except OSError:
        return False


_AC_DEPLOY_TYPE = "wait_for_bar"


def _sync_deployment_registry(ac_names):
    """Upsert state/deployments.json entries for Type A/C names so
    manager/healthcheck.py keeps monitoring them even though they now have no
    crontab line — that file's own auto-registration only fires from a LIVE
    crontab scan (see its _autoregister), so a Type A/C strategy that's never
    had one would otherwise get zero healthcheck coverage, silently. The
    `type` value is deliberately NOT "cron": _check_entry only applies the
    crontab-presence check to entries typed "cron" — anything else (like the
    existing "daemon" type used for the reconciler) falls straight through to
    the heartbeat-freshness check, which still applies unchanged
    (wait_for_bar.py's own _run_strategy_protected touches
    state/heartbeat/<name> on every success, exactly as before — nothing
    about that changed). Best-effort, skip-on-no-change: called every cycle,
    must not become the bottleneck or race the reconciler's own writes to
    this same file more than the pre-existing multi-writer risk already
    accepted for portfolio_config.json elsewhere in this file."""
    path = os.path.join(WORKSPACE, "state", "deployments.json")
    try:
        with open(path) as f:
            deps = json.load(f)
    except (OSError, ValueError):
        deps = {}
    if not isinstance(deps, dict):
        deps = {}
    changed = False
    now_iso = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
    for n in ac_names:
        cur = deps.get(n)
        expect = _strategy_interval_minutes(n)
        if not (isinstance(cur, dict) and cur.get("type") == _AC_DEPLOY_TYPE
                and cur.get("expect_every_minutes") == expect):
            deps[n] = {
                "type": _AC_DEPLOY_TYPE,
                "expect_every_minutes": expect,
                "registered_at": (cur or {}).get("registered_at") or now_iso,
            }
            changed = True
    if not changed:
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    try:
        with open(tmp, "w") as f:
            json.dump(deps, f, indent=2)
        os.replace(tmp, path)
    except OSError as e:
        _log(f"deployment registry sync failed: {type(e).__name__}: {e}")


def _prune_deployment_registry(ac_names):
    """Drop state/deployments.json entries typed _AC_DEPLOY_TYPE
    ("wait_for_bar") whose name is no longer in `ac_names` — the unpick case,
    distinct from _purge_deployment_registry (deletion, which already knows
    the exact names to drop and doesn't care about type). Without this, a
    strategy unchecked (not deleted) in 下單設定 keeps its registry entry
    forever: heartbeat goes stale, healthcheck.py raises a false "no
    successful run" alert for something the user deliberately turned off
    (code-auditor finding, 2026-08-19). Only ever touches _AC_DEPLOY_TYPE
    entries — Type B's `type: "cron"` (auto-registered by healthcheck.py
    itself, confirmed by the auditor to never be anything else) and the
    reconciler's `type: "daemon"` are untouched either way."""
    path = os.path.join(WORKSPACE, "state", "deployments.json")
    try:
        with open(path) as f:
            deps = json.load(f)
    except (OSError, ValueError):
        return
    if not isinstance(deps, dict):
        return
    stale = [n for n, e in deps.items()
             if isinstance(e, dict) and e.get("type") == _AC_DEPLOY_TYPE and n not in ac_names]
    if not stale:
        return
    for n in stale:
        deps.pop(n, None)
    tmp = path + ".tmp"
    try:
        with open(tmp, "w") as f:
            json.dump(deps, f, indent=2)
        os.replace(tmp, path)
    except OSError as e:
        _log(f"deployment registry prune failed: {type(e).__name__}: {e}")


def _tick_one(name):
    """One strategy's wait_for_bar tick — runs the UNMODIFIED CLI entrypoint
    (`python3 manager/wait_for_bar.py <name>`) as a subprocess, on its own
    daemon thread (see _run_scheduler_cycle for why parallel, not a
    for-loop). See the "Type A/C in-process scheduler" comment above for why
    this is a subprocess and not an in-process call. PATH-resolved
    interpreter name (not sys.executable, which here would resolve to THIS
    runtime's own /opt/blave-agent/venv) — matches run_strategy.sh and the
    Windows schtasks `tr` exactly, so it lands on the same python those
    already use. wait_for_bar.py's own main()/_tick already carries the
    top-level try/except + Telegram wrapper-error alert (unchanged, since
    this is the unmodified CLI) — main() catches everything and exits 0, so
    a NONZERO exit here means the interpreter itself never got that far
    (missing/broken wait_for_bar.py, or — the exact bug this comment exists
    to prevent recurring — a wrong subprocess env the interpreter can't even
    boot under). That failure mode is otherwise silent, so it's logged here,
    not swallowed as a bare last-resort net for "failed to start"."""
    interp = "python" if platform.system() == "Windows" else "python3"
    try:
        r = subprocess.run(
            [interp, os.path.join("manager", "wait_for_bar.py"), name],
            cwd=WORKSPACE, env=_strategy_subprocess_env(),
            capture_output=True, text=True,
            timeout=SCHEDULER_TICK_TIMEOUT_SECONDS,
        )
        if r.returncode != 0:
            _log(f"scheduler tick {name}: wait_for_bar.py exited {r.returncode} "
                 f"(interpreter-level failure, not a strategy crash — that's "
                 f"alerted separately): {(r.stderr or r.stdout or '').strip()[:200]}")
    except subprocess.TimeoutExpired:
        _log(f"scheduler tick {name} exceeded {SCHEDULER_TICK_TIMEOUT_SECONDS}s "
             f"— likely a hung fetch_data(); next cycle retries")
    except OSError as e:
        _log(f"scheduler tick {name} failed to start: {type(e).__name__}: {e}")


def _run_scheduler_cycle():
    """Read portfolio_config.json's `amounts` fresh — the SAME source of
    truth _cmd_amounts writes and _sync_strategy_crons reads, not a
    separately maintained tracked list that could drift from it — and fire
    one tick per Type A/C name in parallel.

    Parallel, not a for-loop: the fleet has already hit this exact starvation
    bug once (uid 21894 — a slow 2-minute job routinely starved a 1-minute
    alert job sharing its tick). fetch_data() can legitimately take minutes
    (wait_for_bar.py's own cost-note docstring), and a strategy stuck there
    must not delay every OTHER strategy's freshness check for the same
    minute — the N-separate-crontab-entries design this replaces never had
    that coupling, and this must not reintroduce it. Threads, not a
    ThreadPoolExecutor: pool workers are non-daemon (joined at interpreter
    exit) and N is small (a user's whole portfolio, not a fleet) — one spawn
    per name per minute is cheap, and per-strategy overlap is already
    prevented by wait_for_bar.py's own file lock (state/bar_wait/<name>.lock),
    not by anything in this loop."""
    if not _bound_venue():
        return  # see _bound_venue — unbound is a deliberate "stay quiet" state
    global _ac_migration_done
    if _wait_for_bar_available() and not _ac_migration_done:
        # Runs once per process, but not necessarily on the FIRST cycle: a
        # workspace can update (git pull bringing in wait_for_bar.py for the
        # first time) any time after this runtime already started — see
        # _wait_for_bar_available. Doing this here, right before that cycle's
        # ticks, is what keeps the transition itself glitch-free: without it,
        # a stale Type-A/C crontab line (bash → strategy.py directly,
        # bypassing wait_for_bar.py's own lock) could fire in the SAME window
        # this scheduler starts ticking the same name.
        _migrate_legacy_ac_crons()
        _ac_migration_done = True
    try:
        with open(os.path.join(WORKSPACE, "manager", "portfolio_config.json")) as f:
            amounts = json.load(f).get("amounts") or {}
    except (OSError, ValueError):
        return  # no portfolio yet, or manager.py mid-write — next cycle retries
    if not isinstance(amounts, dict):
        return
    # Same name validation _cmd_amounts already applies at write time
    # (re.fullmatch(r"[A-Za-z0-9_-]{1,64}", k)) — this file's own writer is
    # trusted, but a name feeds straight into a strategies/<name>/ path and a
    # subprocess argv below, so re-validating on the READ side doesn't
    # implicitly trust portfolio_config.json's content just because nothing
    # else currently writes an invalid key into it (code-auditor finding,
    # 2026-08-19 — defense in depth, not a known exploit path today).
    names = set()
    for k in amounts:
        if isinstance(k, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,64}", k):
            names.add(k)
        else:
            _log(f"scheduler: skipping invalid strategy name in amounts: {k!r}")
    ac_names, _b = _split_by_type(names)
    # Pruning runs even when ac_names is empty — unpicking the LAST Type A/C
    # strategy must still drop its now-stale registry entry, not just every
    # OTHER one (code-auditor finding, 2026-08-19); that's why this sits
    # before the ac_names-empty early return, not after it.
    _prune_deployment_registry(ac_names)
    if not ac_names:
        return
    _sync_deployment_registry(ac_names)
    for name in sorted(ac_names):
        threading.Thread(target=_tick_one, args=(name,),
                         daemon=True, name=f"strategy-tick-{name}").start()


def _migrate_legacy_ac_crons():
    """One-time upgrade sweep, run once before the scheduler's first cycle:
    drop any existing `# blave-web` crontab line (Linux) / blave-web-strategy-*
    task (Windows) for a strategy that's Type A/C. Without this, a machine
    upgrading from the old crontab-per-strategy runtime keeps the stale entry
    firing `run_strategy.sh <name>` forever alongside this loop's own tick()
    — both would run the SAME strategy on their own schedules, and unlike two
    wait_for_bar.py callers (which share state/bar_wait's lock + state file
    and dedupe for free), the old entry runs bash → strategy.py directly,
    bypassing that lock entirely. Best-effort, like every other cron sync
    here — a failed sweep logs and the loop still starts."""
    if platform.system() == "Windows":
        try:
            with _cron_lock:
                out = subprocess.run(["schtasks", "/query", "/fo", "csv", "/nh"],
                                     capture_output=True, text=True, errors="replace",
                                     timeout=30)
                existing = set()
                for line in (out.stdout or "").splitlines():
                    tn = line.split('","')[0].strip('"').lstrip("\\")
                    if tn.startswith(_WIN_TASK_PREFIX):
                        existing.add(tn[len(_WIN_TASK_PREFIX):])
                stale = {n for n in existing if _strategy_has_interval(n)}
                for n in sorted(stale):
                    r = subprocess.run(["schtasks", "/delete", "/tn", _WIN_TASK_PREFIX + n, "/f"],
                                       capture_output=True, text=True, errors="replace", timeout=30)
                    if r.returncode != 0:
                        _log(f"cron migration: delete task {n} failed: "
                             f"{(r.stderr or r.stdout or '').strip()[:120]}")
            if stale:
                _log(f"cron migration: removed {len(stale)} type A/C scheduled task(s)")
        except Exception as e:
            _log(f"cron migration (windows) failed: {type(e).__name__}: {e}")
        return
    try:
        with _cron_lock:
            out = subprocess.run(["crontab", "-l"], capture_output=True, text=True, timeout=10)
            if out.returncode != 0:
                return  # no crontab at all — nothing to migrate
            kept, dropped = [], 0
            for l in out.stdout.splitlines():
                if _CRON_TAG in l:
                    m = re.search(r"run_strategy\.sh\s+(\S+)", l)
                    if m and _strategy_has_interval(m.group(1)):
                        dropped += 1
                        continue
                kept.append(l)
            if dropped:
                subprocess.run(["crontab", "-"], input="\n".join(kept) + "\n",
                               text=True, timeout=10, check=True)
        if dropped:
            _log(f"cron migration: removed {dropped} type A/C crontab line(s)")
    except Exception as e:
        _log(f"cron migration failed: {type(e).__name__}: {e}")


def _scheduler_loop():
    """The migration sweep is NOT called here unconditionally — it runs from
    inside _run_scheduler_cycle, gated on wait_for_bar.py actually being
    present in THIS workspace (see _wait_for_bar_available), because that can
    become true at any point after this runtime already started, not only at
    process startup."""
    while True:
        try:
            _run_scheduler_cycle()
        except Exception as e:
            _log(f"scheduler cycle failed: {type(e).__name__}: {e}")
        _scheduler_wake.wait(timeout=SCHEDULER_INTERVAL_SECONDS)
        _scheduler_wake.clear()


# TW index futures (Capital/群益) asset_specs, keyed by the strategy's SYMBOL
# constant (TXF/MXF/TMF). Mirrors blaveclaw-config/manager/reconciler.py's
# _CAPITAL_FUTURES_SPEC table and the shape documented in
# references/capital-broker.md Step 8 — duplicated, not imported: this file is
# the platform-controlled runtime layer (ships via blave_agent/publish.py) and
# must not depend on the user/agent-editable workspace layer (account_reader.py,
# same layer, already keeps the same boundary). A static SYMBOL->spec lookup,
# no AI judgment involved — TW stock strategies (asset_specs "tw_stock" shape)
# are intentionally NOT covered here.
_TXF_ASSET_SPECS = {
    "TXF": {"type": "futures_contracts", "contract_value": 200, "currency": "TWD", "lot_size": 1},
    "MXF": {"type": "futures_contracts", "contract_value": 50, "currency": "TWD", "lot_size": 1},
    "TMF": {"type": "futures_contracts", "contract_value": 10, "currency": "TWD", "lot_size": 1},
}


def _strategy_futures_symbol(name):
    """The SYMBOL a strategy trades, read straight off disk (no workspace
    import — this runtime never executes strategy/workspace code). Tries
    stats.json first: lib/runner.py writes it on EVERY backtest run (both the
    'backtest' and 'live' branches reach that json.dump before diverging), so
    it exists for any strategy the user could plausibly allocate to — even one
    that has never gone live. Falls back to state.json (written only once a
    strategy has run live at least once — see portfolio_reporter.strategy_states)
    for the rare case stats.json is missing or corrupt but the strategy has
    already traded live."""
    for fname in ("stats.json", "state.json"):
        path = os.path.join(WORKSPACE, "strategies", name, fname)
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            continue
        sym = data.get("symbol") if isinstance(data, dict) else None
        if isinstance(sym, str) and sym.strip():
            return sym.strip().upper()
    return None


def _strategy_is_portfolio(name):
    """True only when strategies/<name>/stats.json positively identifies a
    Type C portfolio strategy — read straight off disk like
    _strategy_futures_symbol (this runtime never executes workspace code).
    Classification contract lives in strategy_reporter.is_portfolio_stats
    (symbol absent AND benchmark_* present, per lib/runner.py's two stats.json
    shapes). Fail-open on missing/corrupt stats: blocking a fundable Type A on
    a stale file would strand a real config, while a missed Type C only keeps
    the pre-guard behavior."""
    import strategy_reporter  # same runtime dir; single classification source

    path = os.path.join(WORKSPACE, "strategies", name, "stats.json")
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return False
    return strategy_reporter.is_portfolio_stats(data)


def _cmd_amounts(args):
    """策略下單金額 — the 下單設定 page's save button.

    `amounts` is canonical: {strategy: dollars at position=1}; the reconciler
    sizes targets as amount × position (lib/portfolio.strategy_amounts) —
    what the user typed is what trades, and it never drifts with equity.
    Doubles as membership: a strategy KEY present in `amounts` (any value,
    including 0 — 0 means "paused, converge to flat") puts it in the
    portfolio and routes it. Flattening mechanics differ by market: futures
    read `actual` from a live exchange position query every round, so amount=0
    closes it out directly; spot has no such blanket query and instead relies
    on `lib/portfolio.spot_scope`'s persisted-scope sell-down (the same
    exit-on-removal path a dropped strategy takes) — it converges to flat over
    one or more rounds, down to dust below the reconcile threshold, provided
    the venue lib ships a spot layer (`order.get_spot_balances`). The venue is
    inherited from existing members
    (one portfolio, one account — membership never silently splits across
    venues). Only a key's ABSENCE (unpicked in the picker) drops routing —
    amount=0 must NOT drop it, or the reconciler (and Capital's
    _is_capital_routed venue-detection, which reads `exchanges` alone) loses
    the venue to even query/flatten the position it's supposed to zero out
    (bug hit 2026-08-14: pausing a strategy at amount=0 wiped `exchanges` and
    stranded the reconciler with no venue to reconcile against).
    """
    amounts = args.get("amounts")
    # empty dict is legal: "the portfolio is empty" (every strategy unpicked)
    if not isinstance(amounts, dict):
        raise ValueError("amounts needs a {strategy: dollars} mapping")
    prev_amounts = {}
    try:
        with open(os.path.join(WORKSPACE, "manager", "portfolio_config.json")) as f:
            a = json.load(f).get("amounts")
            prev_amounts = a if isinstance(a, dict) else {}
    except (OSError, ValueError, AttributeError):
        pass  # kickoff/guard detection only — the main read below fail-closes properly
    prev = set(prev_amounts)
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

    # Type C (portfolio) strategies have no live path: lib/runner.py's Type C
    # branch never writes state.json, so the reconciler's aggregate never sees
    # them — funding one schedules signal runs that can never place an order,
    # with zero alerts, while the user believes it's trading (audit,
    # 2026-08-24). Refuse the save up front. Checked = every UNFUNDED→FUNDED
    # transition: amount >0 now while the stored config has it absent or ≤0.
    # Membership alone was a bypass (pick at 0, save, then raise the amount —
    # the key is "existing" by then); amount ≤0 itself never trades, so picking
    # a Type C at 0 stays legal. Already-funded (>0) keys keep saving back
    # regardless — never lock a stock config out of its own save button — and
    # _strategy_is_portfolio fail-opens on anything ambiguous.
    newly_funded = set()  # unfunded→funded this save — the gate cleanup below reuses it
    for k, amt in clean.items():
        if amt <= 0:
            continue
        try:
            was_funded = float(prev_amounts.get(k, 0)) > 0
        except (TypeError, ValueError):
            was_funded = False  # a garbage stored value is not a funded config
        if was_funded:
            continue
        if _strategy_is_portfolio(k):
            raise ValueError(
                f"「{k}」是投資組合(Type C)策略,暫不支援自動下單——"
                f"請取消勾選這支策略後再儲存"
            )
        newly_funded.add(k)

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
    old_amounts = cfg.get("amounts") if isinstance(cfg.get("amounts"), dict) else {}
    cfg["amounts"] = clean
    old = cfg.get("exchanges") or {}
    # Only inherit venues that are STILL BOUND (keys in .env) — after 解除綁定
    # +重連別家, the old routing would otherwise zombie back in (positions
    # live on the account, not in this dict).
    bound = set()
    try:
        with open(os.path.join(WORKSPACE, ".env")) as f:
            # pair rule (_venue_cred_ids), same as everywhere else: a lone
            # OPENAI_API_KEY must not get inferred as a venue and written
            # into exchanges as a routing target
            bound = {i.lower() for i in _venue_cred_ids(f.read().splitlines())}
    except OSError:
        pass
    # P2-4: when the UI bind manifest exists, only UI-bound venues count as
    # inheritable — keys an agent hand-wrote into .env don't route
    # (lib/venue_wiring filters them), so inheriting one here would save a
    # config that LOOKS deployed but never trades.
    manifest = _ui_manifest_ids()
    if manifest is not None:
        bound &= manifest
    old = {k: (v if v in bound else "") for k, v in old.items()}
    venues = {v for v in old.values() if v}
    default_venue = venues.pop() if len(venues) == 1 else ""
    if not default_venue and len(bound) == 1:
        # No routed member to inherit from (fresh portfolio, membership emptied,
        # or old venue unbound): fall back to the machine's one bound exchange.
        default_venue = next(iter(bound))
    cfg["exchanges"] = {
        n: (old.get(n) or default_venue) for n in clean
    }
    if not isinstance(cfg.get("asset_specs"), dict):
        cfg["asset_specs"] = {}
    # First-allocation TXF/MXF/TMF spec write (mirrors the frontend's own
    # handoff condition in workspace.html's save handler): previous amount
    # was 0/absent, this save makes it positive, and no spec is already
    # recorded (never clobber one already written — by this code, the agent,
    # or a manual edit). contract_value/lot_size are a static, deterministic
    # lookup keyed off the strategy's SYMBOL — no AI turn needed.
    for k, amt in clean.items():
        if amt <= 0:
            continue
        try:
            prev_amt = float(old_amounts.get(k, 0))
        except (TypeError, ValueError):
            prev_amt = 0.0
        if prev_amt > 0 or cfg["asset_specs"].get(k):
            continue
        sym = _strategy_futures_symbol(k)
        spec = _TXF_ASSET_SPECS.get(sym) if sym else None
        if spec:
            cfg["asset_specs"][k] = dict(spec)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    # 紅線 L2:UI 儲存=權威副本。鏡像先寫、config 後寫(P2-2)——reconciler
    # mtime-watch 的是 config,這個順序讓它觸發的那一輪就讀到新權威值。
    _write_ui_amounts_mirror(clean, cfg["exchanges"])
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(cfg, f, indent=2)
    os.replace(tmp, path)  # atomic: the reconciler mtime-watches + json-loads this
    # signal_gate 殘留清理:resume_wait 寫下的 baseline 只有在「訊號變動」時由
    # lib/portfolio 的 lift 路徑清掉,但金額歸 0 / 取消勾選的策略在 aggregate
    # 提前 continue,永遠走不到那條路——之後重新 fund 會拿作廢的 baseline 誤
    # gate(audit,2026-08-24)。所以儲存成功後把「不在新 amounts 或金額 ≤0」
    # 的 entry 剔掉;newly_funded(這次 unfunded→funded)也一律剔——它之前
    # 金額 ≤0/不存在,baseline 定義上必然作廢,不論歸零是不是經過 amounts
    # 儲存(agent 直接改 config 的那條殘留路也被這關掉),也堵住 reconciler
    # merge-on-save 毫秒窗口把被剔 entry 寫回、下次 re-fund 又被留下的競態
    # (audit P2-1)。Delete-only + write only when something was dropped(same
    # lost-update reasoning as lib/portfolio's merge-on-save, audit #7 there:
    # the reconciler may lift an entry concurrently, so never write back a
    # copy that didn't change)。Best-effort:gate 是輔助狀態,清理失敗絕不能
    # 反過來讓 amounts 儲存 fail。
    try:
        gate_path = os.path.join(WORKSPACE_STATE, "signal_gate.json")
        with open(gate_path, encoding="utf-8") as f:
            gate = json.load(f)
        if isinstance(gate, dict):
            kept = {n: v for n, v in gate.items()
                    if clean.get(n, 0) > 0 and n not in newly_funded}
            if kept != gate:
                gtmp = gate_path + ".tmp"
                with open(gtmp, "w") as f:
                    json.dump(kept, f, indent=2)
                os.replace(gtmp, gate_path)  # atomic, same convention as _cmd_resume_wait
    except FileNotFoundError:
        pass  # no gate = nothing to clean
    except (OSError, ValueError, TypeError) as e:
        _log(f"signal_gate cleanup failed: {type(e).__name__}")
    _sync_strategy_crons(set(clean))  # 選到就跑:picked = scheduled,不看金額
    # 勾好=在跑:新選入的立刻背景跑一次,不等下一個 cron 整點——訊號一分鐘
    # 內就新鮮,sidebar 的點跟著亮。detached + DEVNULL:跑多久、成敗都不能
    # 拖住指令迴圈,結果由 state.json/回報說話。Type A/C 不在這裡跑——
    # _sync_strategy_crons 剛剛已經 _scheduler_wake.set() 過,交給常駐迴圈用
    # tick() 跑(有 wait_for_bar.py 自己的 lock/state,這裡再跑一次只會撞鎖）。
    if platform.system() != "Windows":
        for n in sorted(set(clean) - prev):
            if _strategy_has_interval(n):
                continue
            try:
                subprocess.Popen(
                    ["bash", "manager/run_strategy.sh", n],
                    cwd=WORKSPACE,
                    # minimal env — the bridge's BLAVE_PROXY_TOKEN etc. have no
                    # business inside agent/user strategy code (cron runs give
                    # strategies a bare env too, so this also matches prod)
                    env=_strategy_subprocess_env(),
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    start_new_session=True,
                )
            except OSError as e:
                _log(f"kickoff run failed for {n}: {type(e).__name__}")
    return f"amounts={len(clean)}"


_EXEC_MODULE_RE = re.compile(r"^[a-z0-9_]{1,64}$")


def _execution_engine_ready():
    """True when the workspace's lib/execute.py carries the execution-style
    dispatch layer. String probe, never an import — importing runs workspace
    code inside the listener."""
    try:
        with open(os.path.join(WORKSPACE, "lib", "execute.py"), encoding="utf-8") as f:
            return "def dispatch_order" in f.read()
    except OSError:
        return False


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
            except (TypeError, ValueError, OverflowError):  # Overflow: json Infinity
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
    # Old workspaces predate the execution-style dispatch layer: the reconciler
    # there ignores this config key entirely, so a non-market setting would
    # look saved yet trade as market, silently. The setting is still WRITTEN
    # (it activates the moment the workspace updates) — but the user gets told.
    if any(s.get("type") != "market" for s in clean.values()) \
            and not _execution_engine_ready():
        def _notice():
            from lib.notify import send_text
            send_text("此機器的執行引擎尚未更新,下單方式設定暫不會生效"
                      "——請跟 agent 說『更新 workspace』")
        try:
            _in_workspace(_notice)  # lib.notify resolves config relative to cwd
        except Exception as e:
            _log(f"engine-outdated notice failed: {type(e).__name__}")
        return f"execution={len(clean)} engine_outdated"
    return f"execution={len(clean)}"


def _stop_reconciler():
    """True only when no reconciler daemon can still be watching the workspace
    (confirmed stopped, or provably never running). The full-unbind path gates
    the membership clear on this — see the WHY there. Same stop mechanics as
    _cmd_restart_reconciler's first half.

    Linux checks BOTH supervisors, not just one: the fleet is mid-migration
    from tmux to systemd (see _cmd_restart_reconciler), so a live daemon could
    be under either depending on when this machine last pressed 啟動下單."""
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
            tmux_gone = True
        else:
            err = (r.stderr or "").lower()
            # no such session / no tmux server at all = no daemon = nothing watching
            tmux_gone = ("find session" in err or "no server" in err
                        or "failed to connect" in err)
        if not tmux_gone:
            return False

        if not os.path.isfile(RECONCILER_UNIT_PATH):
            return True  # unit never installed on this machine — nothing else to check
        state = subprocess.run(["systemctl", "is-active", RECONCILER_UNIT],
                               capture_output=True, text=True, timeout=15)
        # deactivating counts as RUNNING: stop is in flight but the process
        # can live up to TimeoutStopSec more — returning True here would let
        # the full-unbind path clear membership while the daemon gets one
        # last reconcile round in (the flatten-live-positions incident
        # class). `systemctl stop` on a deactivating unit blocks until it's
        # actually gone, which is exactly the semantics this needs.
        # failed counts as "uncertain, treat as running" too: Restart=always +
        # StartLimitIntervalSec=0 make this state rare (systemd's own
        # documented crash-loop transient), but a unit caught mid-transition
        # can still show failed while a child process from the old attempt
        # hasn't finished exiting yet — the same double-daemon risk
        # `deactivating` guards against, so it's classified the same way.
        if state.stdout.strip() not in ("active", "activating", "reloading",
                                        "deactivating", "failed"):
            return True  # not running — nothing to stop
        stop = subprocess.run(["sudo", "-n", "/usr/bin/systemctl", "stop",
                               RECONCILER_UNIT],
                              capture_output=True, text=True, timeout=30)
        return stop.returncode == 0
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
    # casefold like the write side: a MixedCase line (agent-hand-written
    # Gateio_Api_Key) must still match its unbind name
    drop = {n.casefold() for n in names if not n.upper().startswith("BLAVE_")}

    path = os.path.join(WORKSPACE, ".env")
    with _env_lock():
        try:
            with open(path) as f:
                lines = f.read().splitlines()
        except OSError:
            return "credentials_remove=0"
        kept = [l for l in lines if l.split("=", 1)[0].strip().casefold() not in drop]
        removed = len(lines) - len(kept)
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            f.write("\n".join(kept) + "\n")
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)  # atomic — a torn .env would strand the machine keyless
    # P1-2: unbind must shrink the bind manifest too, or an agent hand-writing
    # the SAME venue's keys back into .env after the unbind would still be in
    # the allowed list and route again without any UI bind.
    _write_ui_cred_manifest(kept)

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
        # unbound machine updating targets reads as "still trading"). A rebind
        # (_cmd_credentials) or the next amounts save re-syncs the crons, so
        # resume costs nothing; partial unbind on a multi-venue machine keeps
        # them. "Venue left" is the pair rule — a lingering service key
        # (OPENAI_API_KEY) must not read as still-bound and keep schedules
        # firing on a machine that can no longer trade.
        if not _venue_cred_ids(kept):
            _sync_strategy_crons(set())  # Type B crontab; Type A/C stops via
            # _bound_venue() in _run_scheduler_cycle reading this same .env —
            # no separate action needed there, see that function's docstring.
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
                # mirror first, config second (P2-2 write order) — and if the
                # config write below then fails, a {}/{} mirror over a stale
                # config fails in the SAFE direction (nothing funded).
                _write_ui_amounts_mirror({}, {}, only_if_present=True)
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


def _purge_deployment_registry(entries):
    """Drop state/deployments.json entries for just-deleted strategies —
    otherwise manager/healthcheck.py keeps alerting "no successful run" for a
    name whose files (and heartbeat) are gone for good. Covers both Type A/C
    (registered by _sync_deployment_registry) and Type B (auto-registered by
    healthcheck.py itself from its old crontab line) — the field is a plain
    name→entry map either way."""
    path = os.path.join(WORKSPACE, "state", "deployments.json")
    try:
        with open(path) as f:
            deps = json.load(f)
    except (OSError, ValueError):
        return
    if not isinstance(deps, dict):
        return
    changed = any(deps.pop(e, None) is not None for e in entries)
    if not changed:
        return
    tmp = path + ".tmp"
    try:
        with open(tmp, "w") as f:
            json.dump(deps, f, indent=2)
        os.replace(tmp, path)
    except OSError as e:
        _log(f"deployment registry purge failed: {type(e).__name__}: {e}")


def _purge_strategy_schedules(entries):
    """Drop the schedules that ran the just-deleted entries. Without this, an
    agent-deployed cron (untagged `bash manager/run_strategy.sh <entry>` or
    `manager/wait_for_bar.py <entry>`, see references/deployment.md) keeps
    firing forever: run_strategy.sh mkdir -p's the ghost dir back and
    Telegrams a failure alert every tick (wait_for_bar.py's own
    _alert_wrapper_error does the same for a missing strategy.py). Tag or no
    tag doesn't matter here — the tag guards LIVE schedules from the web's
    sync, but with the strategy files gone every line running this entry is
    only alarm garbage. Keyed by the filesystem ENTRY name, not the reported
    STRATEGY_NAME — the schedule references the path, and the two can differ.
    Best-effort like _sync_strategy_crons: a purge failure must not fail the
    delete that already happened."""
    if not entries:
        return
    _purge_deployment_registry(entries)
    try:
        with _cron_lock:
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
                # run_strategy.sh <entry> (Type B, agent + web lines),
                # wait_for_bar.py <entry> (Type A/C, agent-deployed per
                # references/deployment.md — this web runtime never writes one
                # itself, but an agent-deployed line for a since-deleted strategy
                # is exactly the ghost this function exists to clean up), and the
                # direct strategies/<entry>/strategy.py form deployment.md
                # forbids but agents have written anyway
                pats.append(re.compile(r"run_strategy\.sh\s+%s(\s|$)" % re.escape(e)))
                pats.append(re.compile(r"wait_for_bar\.py\s+%s(\s|$)" % re.escape(e)))
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


def _capital_admin_password():
    """Administrator RDP password, needed so blaveclaw-reconciler can run as
    Administrator (not LocalSystem) — Capital's SKCOM.dll binds its cert to
    the Administrator identity, and a LocalSystem service fails login with
    error 602 (references/manager.md broker exception). Newest machines keep
    it in credentials/rdp_password.txt, sibling to WORKSPACE (same path
    convention _cmd_retest_accounts uses to reach "current"); oldest
    machines predate that file and keep it in .env as admin_password instead
    (capital-broker.md) — _CRED_KEEP_IDS already special-cases ADMIN because
    that key is real on this fleet. Never put the returned value in a log or
    exception message."""
    pw_path = os.path.join(os.path.dirname(WORKSPACE), "credentials",
                           "rdp_password.txt")
    try:
        with open(pw_path, encoding="utf-8") as f:
            pw = f.read().strip()
        if pw:
            return pw
    except (OSError, ValueError):
        pass
    env_path = os.path.join(WORKSPACE, ".env")
    try:
        with open(env_path, encoding="utf-8") as f:
            for line in f.read().splitlines():
                k, _, v = line.partition("=")
                if k.strip().casefold() == "admin_password" and v.strip():
                    return v.strip()
    except (OSError, ValueError):
        pass
    raise RuntimeError(
        "capital reconciler needs the Administrator RDP password, but "
        f"neither {pw_path} nor .env's admin_password is available")


def _nssm_run(step, timeout=15):
    """Run one `nssm <step>` call with the error handling every caller in
    this function needs. TimeoutExpired's own str() embeds the full argv it
    was given — for the ObjectName step that's the plaintext Administrator
    password — so it must never propagate uncaught up to the command
    dispatch loop's generic `except Exception as e: _log(...)`."""
    try:
        out = subprocess.run(["nssm"] + step, capture_output=True,
                             text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"nssm {' '.join(step[:3])} timed out")
    if out.returncode != 0:
        raise RuntimeError((out.stderr or out.stdout or "").strip()[:200])


def _register_reconciler_deployment(start_type_ok=None):
    """Upsert the reconciler's state/deployments.json entry (references/manager.md
    health monitoring) — a bootstrap machine has no agent-written entry yet, so
    the freshly (re)started daemon would otherwise die unseen. setdefault, not
    overwrite: an existing entry (already-registered machine) keeps its
    original registered_at.

    start_type_ok: Windows-only outcome of this press's SERVICE_DEMAND_START
    correction (_cmd_restart_reconciler) — True once confirmed applied, False
    if the nssm set call itself failed. Recorded so a machine stuck on
    AUTO_START (against the reboot-must-force-off policy, Wei 2026-08-20)
    leaves a trace in the one place healthcheck/ops already look, instead of
    only ever reaching a stderr log nobody's watching. None (Linux, or a
    Windows call this function makes for other reasons) leaves any existing
    value alone rather than erasing a real prior result with "unknown"."""
    dep_path = os.path.join(WORKSPACE, "state", "deployments.json")
    try:
        try:
            with open(dep_path) as f:
                deps = json.load(f)
        except (OSError, ValueError):
            deps = {}
        entry = deps.setdefault("reconciler", {
            "type": "daemon", "expect_every_minutes": 5,
            "registered_at": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()),
        })
        if start_type_ok is not None:
            entry["start_type_corrected"] = start_type_ok
            entry["start_type_checked_at"] = time.strftime(
                "%Y-%m-%dT%H:%M:%S", time.gmtime())
        os.makedirs(os.path.dirname(dep_path), exist_ok=True)
        # atomic: a truncate-write killed mid-way leaves a broken JSON, which
        # the next read turns into deps={} — silently wiping every OTHER
        # strategy's health registration with it
        with open(dep_path + ".tmp", "w") as f:
            json.dump(deps, f, indent=2)
        os.replace(dep_path + ".tmp", dep_path)
    except OSError as e:
        _log(f"deployments.json registration failed: {e}")


def _cmd_restart_reconciler(args):
    """Start the order daemon through its watchdog wrapper, never directly —
    the wrapper restarts on crash and alerts on each exit (references/manager.md)."""
    if platform.system() == "Windows":
        try:
            with open(os.path.join(WORKSPACE, "manager",
                                   "portfolio_config.json")) as f:
                routed = set((json.load(f).get("exchanges") or {}).values())
        except (OSError, ValueError):
            routed = set()
        # Resolved once, up front, so the Administrator-identity fix applies
        # whichever branch below runs — including the ALREADY-INSTALLED case
        # (service set up for some other venue before Capital was routed
        # through this machine), which is plausibly the more common path and
        # was silently skipped by an earlier version of this function.
        admin_pw = _capital_admin_password() if "capital" in routed else None

        # Self-bootstrap: a machine where the agent never set up auto-trading
        # has no service yet — install it here (references/manager.md
        # sequence) instead of failing the button. (Linux's equivalent gap —
        # unit file not on the machine yet — can't self-bootstrap the same
        # way: installing a unit needs root, which blaveagent doesn't have.
        # It's covered by the release channel instead, see below.)
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
            # DEMAND_START, never AUTO_START (Wei 2026-08-20, same policy as
            # the Linux unit's missing [Install]): trading is opt-in and a
            # reboot must force it OFF — the user presses 啟動下單 again to
            # resume. Crash recovery while the service IS running is
            # untouched: that's nssm's AppExit action (default Restart),
            # which respawns the wrapped app independently of the SCM start
            # type — Start only controls boot behavior.
            steps = [
                ["install", "blaveclaw-reconciler", "powershell.exe",
                 "-ExecutionPolicy", "Bypass", "-File", ps1],
                ["set", "blaveclaw-reconciler", "AppDirectory", WORKSPACE],
                ["set", "blaveclaw-reconciler", "Start", "SERVICE_DEMAND_START"],
            ]
            if admin_pw is not None:
                # after AppDirectory, before Start — matches capital-broker.md
                # Step 8's order for the worker service
                steps.insert(2, ["set", "blaveclaw-reconciler", "ObjectName",
                                 ".\\Administrator", admin_pw])
            for step in steps:
                _nssm_run(step)
            # reaching here means every step above, including the
            # Start=SERVICE_DEMAND_START one, returned success
            _register_reconciler_deployment(start_type_ok=True)
        else:
            # stop is best-effort: nssm returns 0 on an already-stopped
            # service, but a HUNG one can outlast the timeout — that must not
            # kill the restart (start is what decides)
            try:
                subprocess.run(["nssm", "stop", "blaveclaw-reconciler"],
                               capture_output=True, timeout=60)
            except subprocess.TimeoutExpired:
                pass
            if admin_pw is not None:
                # service already existed, possibly still LocalSystem from
                # before Capital was routed here — correct it before start
                _nssm_run(["set", "blaveclaw-reconciler", "ObjectName",
                          ".\\Administrator", admin_pw])
            # Existing machines were installed AUTO_START (pre-2026-08-20
            # policy) — lazily correct the start type on every press, same
            # pattern as the ObjectName fix above. Best-effort: a failed
            # correction must not block trading start (the next press
            # retries) — but the outcome goes into deployments.json either
            # way (not just a log line), so a machine stuck on AUTO_START has
            # a durable, queryable trace instead of depending on someone
            # having watched stderr at the exact moment it failed.
            try:
                _nssm_run(["set", "blaveclaw-reconciler", "Start",
                           "SERVICE_DEMAND_START"])
                _register_reconciler_deployment(start_type_ok=True)
            except RuntimeError as e:
                _log(f"start-type correction to DEMAND_START failed: {e} — "
                     "this machine still auto-resumes trading on reboot")
                _register_reconciler_deployment(start_type_ok=False)
        cmd = ["nssm", "start", "blaveclaw-reconciler"]
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        if out.returncode != 0:
            raise RuntimeError((out.stderr or out.stdout or "").strip()[:200])
        return "reconciler restarted"

    # Linux. Two ways this machine isn't ready for the systemd path yet:
    # the unit file hasn't landed (release channel hasn't ticked / is stuck —
    # this fleet has broken-updater history) or the sudoers rollout hasn't
    # reached it. In both cases the button falls back to tmux rather than
    # error — this box may have a tmux-supervised daemon running right now,
    # and a skew-triggered RuntimeError here would be a strict regression
    # (works today via tmux -> breaks on this exact machine once this code
    # ships). ONE deliberate exception, below: if the systemd unit is
    # provably RUNNING but sudo can't control it, the button fails honestly
    # instead — starting tmux on top of a live daemon doubles every order.
    #
    # NEVER `systemctl enable` here (Wei 2026-08-20): trading is opt-in and a
    # reboot must force it off, not resume it unattended — see the unit
    # file's own comment (it has no [Install] section, so enable would fail
    # anyway). `restart` alone both starts a stopped unit and restarts a
    # running one, and is all this button is for.
    def _tmux_fallback(reason):
        _log(f"{reason} — falling back to tmux supervision (loses "
             "Restart=always crash recovery — e.g. a platform patch "
             "restarting \"gateway\" — until this machine gets the systemd "
             "unit + sudoers rollout; reboot behavior is unaffected either "
             "way, neither path auto-resumes trading after one)")
        # kill any existing session first: a crash-looping one would
        # otherwise keep its name and this would silently no-op
        subprocess.run(["tmux", "kill-session", "-t", "reconciler"],
                       capture_output=True, timeout=20)
        cmd = ["tmux", "new-session", "-d", "-s", "reconciler",
               f"cd {WORKSPACE} && bash manager/start_reconciler.sh"]
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        if out.returncode != 0:
            raise RuntimeError((out.stderr or out.stdout or "").strip()[:200])
        _register_reconciler_deployment()
        return "reconciler restarted (tmux fallback)"

    if not os.path.isfile(RECONCILER_UNIT_PATH):
        return _tmux_fallback(f"{RECONCILER_UNIT} not installed on this "
                              "machine yet")

    # kill any existing tmux session first, unconditionally: the fleet is
    # mid-migration from tmux to blave-agent-reconciler.service (2026-08), so
    # a machine that pressed 啟動下單 before this shipped can still have a
    # live tmux-supervised daemon — leaving it running alongside a freshly
    # started systemd one would double-place every order. Best-effort/ignored
    # like every other kill-session call in this file: "no session" is
    # success — including tmux not being installed at all (FileNotFoundError:
    # no binary = no session possible; the systemd path must not require it).
    try:
        subprocess.run(["tmux", "kill-session", "-t", "reconciler"],
                       capture_output=True, timeout=20)
    except FileNotFoundError:
        pass

    # systemctl restart on a system unit needs root; blaveagent has none by
    # default (Linux runs the runtime unprivileged, unlike Windows where
    # everything is already Administrator — see control/updater.py's runuser
    # comment). `sudo -n` needs the narrow NOPASSWD rule provision.sh writes
    # on new/rebuilt machines (restart + stop only — no enable, see above);
    # on an existing machine that hasn't had the one-time sudoers rollout yet
    # this fails fast (no password prompt).
    restart = subprocess.run(
        ["sudo", "-n", "/usr/bin/systemctl", "restart", RECONCILER_UNIT],
        capture_output=True, text=True, timeout=30)
    if restart.returncode != 0:
        # sudo failing does NOT mean the unit isn't running: the sudoers rule
        # may have been removed/broken AFTER an earlier successful start.
        # Blindly starting a tmux daemon on top of a live systemd one would
        # double-place every order — check first (is-active needs no root).
        # Wei 2026-08-20: when the unit IS running but uncontrollable, the
        # button must fail honestly, not silently double the daemons.
        state = subprocess.run(["systemctl", "is-active", RECONCILER_UNIT],
                               capture_output=True, text=True, timeout=15)
        # Kept identical to _stop_reconciler's running-set on purpose — three
        # audit rounds in a row caught a gap in exactly one of these two sets
        # not matching the other, so: deactivating raises too (the dying
        # process can reconcile for up to TimeoutStopSec more; by the user's
        # retry it's inactive and the fallback below fires cleanly), and
        # failed/reloading are both "uncertain, not confirmed stopped" for
        # the same reason — see _stop_reconciler's failed comment.
        if state.stdout.strip() in ("active", "activating", "deactivating",
                                    "failed", "reloading"):
            raise RuntimeError(
                f"{RECONCILER_UNIT} is running but cannot be controlled — "
                f"sudo systemctl restart failed "
                f"({(restart.stderr or '').strip()[:150]}); fix the sudoers "
                "rule (/etc/sudoers.d/blave-agent-reconciler)")
        return _tmux_fallback(
            f"sudo systemctl restart {RECONCILER_UNIT} failed "
            f"({(restart.stderr or '').strip()[:200]}) and the unit is not "
            "running")
    _register_reconciler_deployment()
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


# ── 策略管理(工作頁 投資組合 › 策略管理)──────────────────────────────────────
# Three deterministic wrappers around manager/manager.py (optimise) and
# manager/management_backtest.py (walk-forward vs random). Results never come
# back through the ack: the scripts write manager/proposal.json /
# mgmt_job.json / <output>/stats.json and portfolio_reporter's "manager"
# block ships them with the next report, same read path as everything else.

_MANAGE_MAX_MEMBERS = 64
_MANAGE_MAX_PARAMS = 32
_MANAGE_OPTIMIZE_TIMEOUT_S = 120
_MANAGE_PROGRESS_PUSH_S = 10  # watcher's report cadence while a backtest runs
_MANAGE_ERR_TAIL = 300
_MANAGE_BACKTEST_SCRIPT = "management_backtest.py"
_MANAGE_ALLOCATOR_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
# Strategy dir names are whatever the agent created; only the characters that
# could escape strategies/ or break the comma-joined --members flag are refused.
_MANAGE_MEMBER_BAD_RE = re.compile(r"[/\\,\s\x00-\x1f]")

# From run(): on_applied = the full post-command push (portfolio + strategy
# list); on_progress = portfolio only, what the backtest watcher pushes every
# 10s — the full one rescans every stats.json and repaints the left rail, and
# a 10-minute run would do that 60 times.
_ON_APPLIED = None
_ON_PROGRESS = None
# The live backtest Popen (None when the run was started by an earlier bridge
# process — then identity is the pid's command line, see _mgmt_pid_alive) and
# the lock serialising job.json writes between the watcher and manage_cancel.
_MGMT_PROC = {"proc": None}
_MGMT_LOCK = threading.Lock()
_OPT_LOCK = threading.Lock()  # one manager.py at a time


class Deferred:
    """A handler's way of saying "validated and started; the real answer comes
    later": run() acks a Deferred from a daemon thread when `fn` returns (or
    raises), instead of on the poll loop — so a long synchronous job can't sit
    in front of halt/close_all. `cleanup` runs exactly once, after `fn` or
    when the worker thread could not even start (a lock held by `fn` would
    otherwise leak until restart)."""

    def __init__(self, fn, cleanup=None):
        self.fn = fn
        self._cleanup = cleanup

    def cleanup(self):
        fn, self._cleanup = self._cleanup, None
        if fn:
            fn()


def _require_manage_scripts():
    """Both manager scripts must already take --members before we spawn one.
    This runtime auto-updates from S3, manager/*.py only arrives when the user
    tells the agent to update blaveclaw-config — so an old script meeting a new
    command is routine, and argparse's raw "unrecognized arguments" is what the
    user sees. portfolio_reporter.can_manage hides the controls, but the page's
    payload can be a report behind; this is the check that actually holds."""
    for script in ("manager.py", _MANAGE_BACKTEST_SCRIPT):
        try:
            with open(os.path.join(WORKSPACE, "manager", script), "rb") as f:
                ok = b"--members" in f.read()
        except OSError:
            ok = False
        if not ok:
            raise RuntimeError("workspace scripts are out of date — ask the "
                               "agent to update blaveclaw-config")


def _manage_paths():
    m = os.path.join(WORKSPACE, "manager")
    return {
        "job": os.path.join(m, "mgmt_job.json"),
        "progress": os.path.join(m, "mgmt_progress.json"),
        "proposal": os.path.join(m, "proposal.json"),
        "log": os.path.join(WORKSPACE_STATE, "logs", "mgmt_backtest.log"),
    }


def _remove_retry(path, what):
    """os.remove that tolerates Windows' transient sharing violation (a
    reporter mid-read) the same way _finish_mgmt_job's write does. Absent is
    fine; still there after the retries is an error — the message names the
    file's role, not its path."""
    for attempt in range(5):
        try:
            os.remove(path)
            return
        except FileNotFoundError:
            return
        except OSError as e:
            _log(f"old {what} remove failed ({type(e).__name__}), attempt {attempt + 1}")
            time.sleep(0.3)
    raise RuntimeError(f"could not remove the old {what} — try again")


def _write_json_atomic(path, doc):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(doc, f, indent=2)
    os.replace(tmp, path)


def _validate_manage_args(args):
    """Shared shape check for the manage_* commands. Errors name the field,
    never echo the value. Returns (members, allocator, lookback, target_vol,
    extra_params) with lookback/target_vol split out of params — they are the
    two CLI flags (--lookback on both scripts, --target-vol on manager.py
    only), the rest goes to --params-json."""
    members = args.get("members")
    if not isinstance(members, list) or not members:
        raise ValueError("members must be a non-empty list")
    if len(members) > _MANAGE_MAX_MEMBERS:
        raise ValueError(f"too many members (max {_MANAGE_MAX_MEMBERS})")
    seen = set()
    for name in members:
        if (not isinstance(name, str) or not 1 <= len(name) <= 64
                or name.startswith(".") or ".." in name
                or _MANAGE_MEMBER_BAD_RE.search(name)):
            raise ValueError("bad member name")
        if name in seen:
            raise ValueError("duplicate member")
        seen.add(name)
        if not os.path.isfile(os.path.join(WORKSPACE, "strategies", name, "stats.json")):
            raise ValueError("member has no backtest stats")

    allocator = args.get("allocator")
    if allocator is not None:
        if not isinstance(allocator, str) or not _MANAGE_ALLOCATOR_RE.match(allocator):
            raise ValueError("bad allocator name")
        if not os.path.isfile(os.path.join(WORKSPACE, "allocators", allocator, "allocator.py")):
            raise ValueError("allocator not found")

    params = args.get("params")
    if not isinstance(params, dict):
        raise ValueError("params must be a dict")
    if len(params) > _MANAGE_MAX_PARAMS:
        raise ValueError(f"too many params (max {_MANAGE_MAX_PARAMS})")
    for k, v in params.items():
        if not isinstance(k, str) or not 1 <= len(k) <= 64:
            raise ValueError("bad param key")
        if isinstance(v, bool):
            continue
        if isinstance(v, str):
            if len(v) > 200:
                raise ValueError("param value too long")
        elif isinstance(v, float):
            if v != v or v in (float("inf"), float("-inf")):
                raise ValueError("param value must be finite")
        elif not isinstance(v, int):
            raise ValueError("param value must be int/float/bool/str")
    lookback = params.get("lookback")
    if isinstance(lookback, bool) or not isinstance(lookback, int) or not 10 <= lookback <= 5000:
        raise ValueError("lookback must be an integer 10–5000")
    target_vol = params.get("target_vol")
    if (isinstance(target_vol, bool) or not isinstance(target_vol, (int, float))
            or not 0.01 <= target_vol <= 5):
        raise ValueError("target_vol must be 0.01–5")
    extra = {k: v for k, v in params.items() if k not in ("lookback", "target_vol")}
    if allocator is None and extra:
        raise ValueError("built-in allocator takes no extra params")
    return members, allocator, lookback, target_vol, extra


def _manage_argv(script, members, allocator, extra):
    # Same PATH-resolved interpreter rule as _tick_one — sys.executable would be
    # this runtime's own venv, not the workspace python the scripts import from.
    # `--flag=value` form throughout: a member/allocator name starting with `-`
    # would otherwise be read by argparse as the next option.
    interp = "python" if platform.system() == "Windows" else "python3"
    argv = [interp, os.path.join("manager", script), "--members=" + ",".join(members)]
    if allocator is not None:
        argv.append("--allocator=" + allocator)
        if extra:
            argv.append("--params-json=" + json.dumps(extra))
    return argv


def _tail(text, n=_MANAGE_ERR_TAIL):
    return (text or "").strip()[-n:]


def _log_tail(path, n=_MANAGE_ERR_TAIL):
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - 4 * n))
            return _tail(f.read().decode("utf-8", errors="replace"), n)
    except OSError:
        return ""


def _pid_cmdline(pid):
    """Command line of `pid`, "" when it doesn't exist / can't be read."""
    if platform.system() == "Windows":
        try:
            r = subprocess.run(
                ["powershell", "-NoProfile", "-Command",
                 f"(Get-CimInstance Win32_Process -Filter 'ProcessId={int(pid)}').CommandLine"],
                capture_output=True, text=True, timeout=5)  # runs on the poll loop
        except (OSError, subprocess.SubprocessError, ValueError):
            return ""
        return r.stdout or ""
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            return f.read().replace(b"\0", b" ").decode("utf-8", errors="replace")
    except OSError:
        pass
    try:  # no /proc (dev macOS)
        r = subprocess.run(["ps", "-o", "args=", "-p", str(int(pid))],
                           capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError, ValueError):
        return ""
    return r.stdout or ""


def _mgmt_pid_alive(pid):
    """Alive AND still the backtest. A bare liveness probe is wrong here: after
    a reboot the pid in a stale job.json belongs to whatever got it next —
    the reconciler, say — and cancel would kill that while the page shows a
    progress bar forever. Our own Popen is trusted; anything else must carry
    the script name on its command line."""
    proc = _MGMT_PROC["proc"]
    if proc is not None and proc.pid == pid:
        return proc.poll() is None
    if not isinstance(pid, int) or pid <= 0:
        return False
    return _MANAGE_BACKTEST_SCRIPT in _pid_cmdline(pid)


def _read_mgmt_job():
    try:
        with open(_manage_paths()["job"]) as f:
            job = json.load(f)
    except (OSError, ValueError):
        return None
    return job if isinstance(job, dict) else None


def _mgmt_output_dir(job):
    """<output> from job.json as an absolute path, None unless it is one of the
    two shapes the listener itself writes (a hand-edited file is not followed)."""
    output = job.get("output")
    if (not isinstance(output, str) or not output or os.path.isabs(output)
            or ".." in output.replace("\\", "/").split("/")):
        return None
    return os.path.join(WORKSPACE, output)


def _mgmt_result_fresh(job):
    """True when <output>/stats.json was written by THIS job: the script
    stamps computed_at, and anything at or after started_at is ours. Used
    instead of the exit code wherever there is no exit code (a run adopted
    after a bridge restart, the stale reap) and to refuse a 0-exit that wrote
    nothing."""
    out = _mgmt_output_dir(job)
    if not out:
        return False
    try:
        with open(os.path.join(out, "stats.json")) as f:
            stats = json.load(f)
        return _mgmt_result_matches(stats, job)
    except (OSError, ValueError, TypeError, AttributeError):
        return False


def _mgmt_result_matches(stats, job):
    """The attribution rule, shared in spirit with portfolio_reporter's copy:
    same members (order-free), same allocator, same lookback, and a
    computed_at no earlier than the job's start. Raises on malformed input."""
    return (sorted(stats.get("members") or []) == sorted(job.get("members") or [])
            and stats.get("allocator") == job.get("allocator")
            and (stats.get("params") or {}).get("lookback")
            == (job.get("params") or {}).get("lookback")
            and float(stats.get("computed_at")) >= float(job.get("started_at") or 0))


def _finish_mgmt_job(pid, status, error=None):
    """Terminal write for the job `pid` owns. Under the lock so watcher and
    cancel can't interleave; a job.json that no longer belongs to this pid
    (a newer run replaced it) or is already terminal is left alone — the
    watcher of a cancelled run must not flip it to error when SIGTERM makes
    the exit code non-zero. Retries the write: on Windows os.replace loses to
    a reporter mid-read with PermissionError, and a lost terminal write is a
    progress bar that never ends."""
    with _MGMT_LOCK:
        job = _read_mgmt_job()
        if not job or job.get("pid") != pid or job.get("status") != "running":
            return False
        job["status"] = status
        job["finished_at"] = int(time.time())
        job["error"] = error
        for attempt in range(5):
            try:
                _write_json_atomic(_manage_paths()["job"], job)
                return True
            except OSError as e:
                _log(f"mgmt job write failed ({type(e).__name__}), attempt {attempt + 1}")
                time.sleep(0.3)
        return False


def _settle_mgmt_job(pid, rc=None, log_path=None):
    """Decide done/error once the process is gone. rc=None when nobody
    waited on it (adopted / reaped run) — then the result file's freshness
    is the only evidence."""
    job = _read_mgmt_job()
    if not job or job.get("pid") != pid:
        return
    if rc in (0, None) and _mgmt_result_fresh(job):
        _finish_mgmt_job(pid, "done")
        return
    tail = _log_tail(log_path or _manage_paths()["log"])
    if rc not in (0, None):
        msg = tail or f"backtest exited {rc}"
    elif rc == 0:
        msg = "backtest exited 0 but wrote no result"
    else:
        msg = tail or "backtest process exited without a result"
    _finish_mgmt_job(pid, "error", msg)


def _reap_stale_mgmt_job():
    """A job.json left at `running` by a process that is gone (bridge/NSSM
    restart killed the tree, machine rebooted) would show a progress bar that
    never moves and block every new run. Called at listener start and before
    each backtest/cancel."""
    job = _read_mgmt_job()
    if job and job.get("status") == "running" and not _mgmt_pid_alive(job.get("pid")):
        _settle_mgmt_job(job.get("pid"))


def _push(fn, what):
    if not fn:
        return
    try:
        fn()
    except Exception as e:
        _log(f"{what} push failed: {type(e).__name__}")


def _cmd_manage_optimize(args):
    """Dry-run of manager/manager.py → manager/proposal.json. Validation is
    synchronous (a bad shape acks at once); the script itself runs off-loop
    via Deferred so 120s of optimiser can't delay halt/close_all. The old
    proposal is removed FIRST: on failure the page must not reload into a
    stale proposal wearing the new selection's parameters."""
    _require_manage_scripts()
    members, allocator, lookback, target_vol, extra = _validate_manage_args(args)
    if not _OPT_LOCK.acquire(blocking=False):
        raise RuntimeError("optimize already running")
    try:
        paths = _manage_paths()
        _remove_retry(paths["proposal"], "proposal")
        argv = _manage_argv("manager.py", members, allocator, extra)
        argv += [f"--lookback={lookback}", f"--target-vol={float(target_vol)!r}",
                 "--json=" + os.path.join("manager", "proposal.json")]
    except BaseException:
        _OPT_LOCK.release()
        raise

    def _run():
        try:
            r = subprocess.run(argv, cwd=WORKSPACE, env=_strategy_subprocess_env(),
                               capture_output=True, encoding="utf-8", errors="replace",
                               timeout=_MANAGE_OPTIMIZE_TIMEOUT_S)
        except subprocess.TimeoutExpired:
            raise RuntimeError(f"optimizer timed out after {_MANAGE_OPTIMIZE_TIMEOUT_S}s")
        if r.returncode != 0:
            raise RuntimeError(_tail(r.stderr) or _tail(r.stdout)
                               or f"optimizer exited {r.returncode}")
        if not os.path.isfile(paths["proposal"]):
            raise RuntimeError("optimizer exited 0 but wrote no proposal")
        return "proposal=ok"

    return Deferred(_run, cleanup=_OPT_LOCK.release)


def _cmd_manage_backtest(args):
    """Detached walk-forward run; progress + result ride the portfolio report."""
    _require_manage_scripts()
    # target_vol is validated but unused here: management_backtest.py has no
    # --target-vol (only manager.py does), so recording it would label the run
    # with a number that had no effect on it.
    members, allocator, lookback, _target_vol, extra = _validate_manage_args(args)
    _reap_stale_mgmt_job()
    job = _read_mgmt_job()
    if job and job.get("status") == "running" and _mgmt_pid_alive(job.get("pid")):
        raise RuntimeError("backtest already running")
    paths = _manage_paths()
    _remove_retry(paths["progress"], "progress file")
    argv = _manage_argv(_MANAGE_BACKTEST_SCRIPT, members, allocator, extra)
    argv += [f"--lookback={lookback}",
             "--progress=" + os.path.join("manager", "mgmt_progress.json")]
    os.makedirs(os.path.dirname(paths["log"]), exist_ok=True)
    # Own session / process group so cancel can take the whole tree (killpg)
    # and — Linux, KillMode=process — a bridge restart doesn't kill the run
    # (run() re-adopts it by pid). Windows can't detach from the NSSM tree AND
    # keep a killable pid (see _cmd_close_all's powershell hop, which trades
    # the pid away); the tree kill on restart is what _reap_stale_mgmt_job
    # turns into an error.
    popen_kw = {"start_new_session": True} if platform.system() != "Windows" else {
        "creationflags": getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)}
    # Unbuffered: with both streams in one file, a block-buffered stdout would
    # flush at exit AFTER the stderr error line, and the log tail the job's
    # `error` is cut from would end in report text instead of the reason.
    env = _strategy_subprocess_env() | {"PYTHONUNBUFFERED": "1"}
    with open(paths["log"], "wb") as logf:
        proc = subprocess.Popen(argv, cwd=WORKSPACE, env=env,
                                stdout=logf, stderr=logf, **popen_kw)
    doc = {
        "status": "running", "pid": proc.pid, "members": members,
        "allocator": allocator, "params": {"lookback": lookback, **extra},
        "output": "manager" if allocator is None else f"allocators/{allocator}",
        "started_at": int(time.time()), "finished_at": None, "error": None,
    }
    with _MGMT_LOCK:
        try:
            _write_json_atomic(paths["job"], doc)
        except OSError as e:
            # no job record = nothing can ever report or cancel this run
            proc.kill()
            raise RuntimeError(f"could not record backtest job ({type(e).__name__})")
        _MGMT_PROC["proc"] = proc
    threading.Thread(target=_watch_mgmt_backtest, args=(proc, paths["log"]),
                     daemon=True, name="mgmt-backtest-watch").start()
    return "backtest=started"


def _watch_mgmt_backtest(proc, log_path):
    try:
        while True:
            try:
                rc = proc.wait(timeout=_MANAGE_PROGRESS_PUSH_S)
                break
            except subprocess.TimeoutExpired:
                _push(_ON_PROGRESS, "progress")
        _settle_mgmt_job(proc.pid, rc, log_path)
    except Exception as e:
        _log(f"backtest watcher died: {type(e).__name__}: {e}")
    _push(_ON_APPLIED, "backtest result")


def _adopt_mgmt_backtest(pid):
    """Watcher for a run this process did not start (bridge restarted under
    it): no handle to wait on, so poll liveness — identity-checked, see
    _mgmt_pid_alive — and settle from the result file when it goes."""
    try:
        while _mgmt_pid_alive(pid):
            time.sleep(_MANAGE_PROGRESS_PUSH_S)
            _push(_ON_PROGRESS, "progress")
        _settle_mgmt_job(pid)
    except Exception as e:
        _log(f"adopted backtest watcher died: {type(e).__name__}: {e}")
    _push(_ON_APPLIED, "backtest result")


def _resume_mgmt_watch():
    """At listener start: a run that outlived the previous bridge gets a
    watcher again; a dead one gets settled. Without this the page sees
    `running` until something else touches job.json."""
    job = _read_mgmt_job()
    if not job or job.get("status") != "running":
        return
    pid = job.get("pid")
    if _mgmt_pid_alive(pid):
        _log(f"adopting running backtest pid {pid}")
        threading.Thread(target=_adopt_mgmt_backtest, args=(pid,),
                         daemon=True, name="mgmt-backtest-adopt").start()
    else:
        _settle_mgmt_job(pid)


def _cmd_manage_cancel(args):
    _reap_stale_mgmt_job()
    job = _read_mgmt_job()
    if not job or job.get("status") != "running":
        return "backtest=idle"
    pid = job.get("pid")
    # Status first, kill second: SIGTERM ends the process within the same
    # tick, and a watcher that wins the lock before `cancelled` is written
    # would record the run as an error with the progress text as the reason.
    if not _finish_mgmt_job(pid, "cancelled"):
        job = _read_mgmt_job()
        if not job or job.get("status") != "running":
            return "backtest=idle"  # it ended between the check and the lock
        raise RuntimeError("could not record the cancel — try again")
    if _mgmt_pid_alive(pid):
        try:
            if platform.system() == "Windows":
                subprocess.run(["taskkill", "/T", "/F", "/PID", str(pid)],
                               capture_output=True, timeout=30, check=True)
            else:
                os.killpg(pid, signal.SIGTERM)
        except (OSError, subprocess.SubprocessError) as e:
            if not _mgmt_pid_alive(pid):
                return "backtest=cancelled"  # it ended on its own meanwhile
            # the run is still going — a `cancelled` record over a live
            # process would hide it from the page and from the next start
            _reopen_mgmt_job(pid)
            raise RuntimeError(f"could not stop backtest ({type(e).__name__})")
    return "backtest=cancelled"


def _reopen_mgmt_job(pid):
    with _MGMT_LOCK:
        job = _read_mgmt_job()
        if not job or job.get("pid") != pid:
            return
        job.update({"status": "running", "finished_at": None, "error": None})
        try:
            _write_json_atomic(_manage_paths()["job"], job)
        except OSError as e:
            _log(f"mgmt job reopen failed: {type(e).__name__}")


HANDLERS = {
    "halt": _cmd_halt,
    "resume": _cmd_resume,
    "resume_wait": _cmd_resume_wait,
    "close_all": _cmd_close_all,
    "amounts": _cmd_amounts,
    "execution": _cmd_execution,
    "credentials": _cmd_credentials,
    "credentials_remove": _cmd_credentials_remove,
    "retest_accounts": _cmd_retest_accounts,
    "restart_reconciler": _cmd_restart_reconciler,
    "delete_strategy": _cmd_delete_strategy,
    "manage_optimize": _cmd_manage_optimize,
    "manage_backtest": _cmd_manage_backtest,
    "manage_cancel": _cmd_manage_cancel,
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
    # a swallowed ImportError or a HALT file in the wrong cwd); credentials for
    # the same reason (its rebind-eviction halt).
    if cmd in ("halt", "resume", "resume_wait", "close_all", "credentials",
               "credentials_remove"):
        return _in_workspace(fn, args)
    return fn(args)


def poll_once():
    req = urllib.request.Request(
        API_BASE + "/poll", headers={"x-api-key": f"proxy-{PROXY_TOKEN}"}
    )
    with urllib.request.urlopen(req, timeout=POLL_TIMEOUT) as resp:
        return (json.loads(resp.read().decode()) or {}).get("command")


def _send_ack(cmd_id, cmd, ok, result=None, error=None):
    """Fire this the instant dispatch() returns — a small, independent POST that
    answers "did the machine run this command", seconds before on_applied()'s
    full portfolio report can answer "has real exchange state converged" (that
    one needs exchange calls + a workspace scan). Meant to be called on its own
    daemon thread (see run() below) so a slow/dead network here never blocks the
    poll loop; never queued against report_inflight — that flag protects the
    heavy report, not this.

    ok=True only means dispatch() didn't raise for this id — for close_all this
    is "flatten started", not "positions are flat". Best-effort: a failed ack
    send is logged and dropped, never retried (the caller falls back to the next
    portfolio report either way)."""
    payload = {"id": cmd_id, "cmd": cmd, "ok": ok}
    if ok:
        payload["result"] = result
    else:
        payload["error"] = error
    try:
        req = urllib.request.Request(
            API_BASE + "/ack",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json", "x-api-key": f"proxy-{PROXY_TOKEN}"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            resp.read()
    except Exception as e:
        _log(f"ack send failed: {type(e).__name__}")


def _run_deferred(cid, cmd, deferred):
    try:
        result = deferred.fn()
        _log(f"{cmd} {cid} ok: {result}")
        if cid != "?":
            _send_ack(cid, cmd, True, result, None)
    except Exception as e:
        err_str = f"{type(e).__name__}: {e}"
        _log(f"{cmd} {cid} FAILED: {err_str}")
        if cid != "?":
            _send_ack(cid, cmd, False, None, err_str)
    finally:
        deferred.cleanup()
    # the loop skips its post-command push for a Deferred — this is that
    # push. Portfolio only: the one deferred job (optimize) changes
    # proposal.json and nothing the strategy list shows.
    _push(_ON_PROGRESS, "deferred result")


def run(on_applied=None, on_progress=None):
    """Poll-execute-report forever. `on_applied` pushes a fresh portfolio report
    so the page confirms from real machine state rather than from its own POST
    having returned 200; `on_progress` is the portfolio-only push the
    backtest watcher uses every 10s (see _ON_PROGRESS)."""
    if not PROXY_TOKEN:
        _log("BLAVE_PROXY_TOKEN not set; command listener disabled")
        return
    _log("started")
    global _ON_APPLIED, _ON_PROGRESS
    _ON_APPLIED = on_applied
    _ON_PROGRESS = on_progress
    _resume_mgmt_watch()

    # Type A/C strategy scheduling — its own daemon thread, independent of the
    # poll loop below (see the "Type A/C in-process scheduler" section).
    threading.Thread(target=_scheduler_loop, daemon=True, name="strategy-scheduler").start()

    # Reporting is several HTTP POSTs (15s timeout each) plus a full workspace
    # scan — a degraded network stacks that to ~45s. This loop is the panic path
    # (halt → close_all), and a stop that queues behind a report is not a stop:
    # the whole push, delayed repush included, runs off-loop on its own daemon
    # thread. Single-flight + dirty flag: a command landing mid-push marks
    # report_dirty instead of spawning a racing thread, and the report thread
    # runs another push+repush round before it exits — so no command's effect
    # waits on the 2-minute timer. The loop thread sets inflight/dirty, the
    # report thread clears them; report_lock covers the check-then-set on
    # both sides so a dirty mark can't slip in between the final dirty check
    # and inflight.clear().
    report_inflight = threading.Event()
    report_dirty = threading.Event()
    report_lock = threading.Lock()

    def _report():
        try:
            while True:
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
                with report_lock:
                    if not report_dirty.is_set():
                        report_inflight.clear()
                        return
                    report_dirty.clear()
        except Exception:
            with report_lock:
                report_inflight.clear()
            raise

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
            if isinstance(result, Deferred):
                # validated + started; the ack (and the report push after it)
                # comes from the worker when the job ends — see Deferred
                _log(f"{command.get('cmd')} {cid} deferred")
                try:
                    threading.Thread(target=_run_deferred,
                                     args=(cid, command.get("cmd"), result),
                                     daemon=True, name="command-deferred").start()
                except RuntimeError as e:
                    result.cleanup()
                    _log(f"{command.get('cmd')} {cid} FAILED: worker thread: {e}")
                    if cid != "?":
                        threading.Thread(
                            target=_send_ack, daemon=True, name="command-ack",
                            args=(cid, command.get("cmd"), False, None,
                                  "RuntimeError: could not start worker — try again"),
                        ).start()
                continue
            _log(f"{command.get('cmd')} {cid} ok: {result}")
            if cid != "?":
                threading.Thread(
                    target=_send_ack, args=(cid, command.get("cmd"), True, result, None),
                    daemon=True, name="command-ack",
                ).start()
        except Exception as e:
            # The message may quote user input but never a payload value —
            # handlers raise with shapes, not contents. Same string goes into
            # the ack's error field — no new exposure, it's already in this log.
            err_str = f"{type(e).__name__}: {e}"
            _log(f"{command.get('cmd')} {cid} FAILED: {err_str}")
            if cid != "?":
                threading.Thread(
                    target=_send_ack, args=(cid, command.get("cmd"), False, None, err_str),
                    daemon=True, name="command-ack",
                ).start()
        if on_applied:
            with report_lock:
                if report_inflight.is_set():
                    report_dirty.set()
                    _log("post-command report in flight — marked dirty, will repush")
                    continue
                report_inflight.set()
            try:
                threading.Thread(target=_report, daemon=True,
                                 name="command-report").start()
            except RuntimeError as e:
                # A stuck inflight would turn every later command into a
                # "marked dirty" log that nothing ever pushes, until restart.
                with report_lock:
                    report_inflight.clear()
                    report_dirty.clear()
                _log(f"post-command report thread failed to start: {e}")
