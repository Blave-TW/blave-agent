"""
Telegram pairing poller: keeps config/telegram.json converged with the backend
(GET /openclaw/agent/telegram/config, auth = proxy token → {bot_token, pair_gen})
so telegram_bridge (which re-reads config each loop) follows it without a restart.
Runs on a timer (Linux systemd 15s; Windows a PS loop re-execs it every 15s).

The chat_id isn't set here — telegram_bridge auto-adopts it from the user's
first message. This poller only delivers the bot token and the pairing generation.

`pair_gen` changes on every web link / unlink (the api mints it). Comparing the
token alone can't see "same token pasted back to pair another Telegram account",
so the generation is what decides "new pairing". Two paths reach the machine:
  - the `telegram_reset` command (command_listener → reset()): instant, but only
    while the machine is up;
  - this poller: every tick while unpaired, every PAIRED_CHECK_S while paired —
    and a machine that was stopped longer than that checks on its first tick after
    boot, so a change made while it was off converges on its own.
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

BASE = os.environ.get("BLAVE_AGENT_BASE") or (
    r"C:\blave-agent" if os.name == "nt" else "/opt/blave-agent"
)
BLAVECLAW_HOME = os.environ.get("BLAVECLAW_HOME", BASE)
CONFIG_PATH = os.environ.get("BLAVE_AGENT_TG_CONFIG", f"{BASE}/config/telegram.json")
API_URL = os.environ.get(
    "BLAVE_TG_CONFIG_URL", "https://api.blave.org/openclaw/agent/telegram/config"
)
PROXY_TOKEN = os.environ.get("BLAVE_PROXY_TOKEN", "")
PYTHON_BIN = os.environ.get("BLAVE_AGENT_PYTHON") or (
    rf"{BASE}\venv\Scripts\python.exe" if os.name == "nt"
    else f"{BASE}/venv/bin/python3"
)
SYNC_SCRIPT = os.environ.get("BLAVE_SYNC_NOTIFY", f"{BASE}/sync_notify_compat.py")
OFFSET_PATH = os.environ.get("BLAVE_AGENT_TG_OFFSET", f"{BASE}/state/tg_offset")
CHECKED_PATH = f"{BASE}/state/tg_pair_checked"
ALLOW_FROM_PATH = os.path.join(BLAVECLAW_HOME, "credentials", "telegram-default-allowFrom.json")
OPENCLAW_JSON_PATH = os.path.join(BLAVECLAW_HOME, "openclaw.json")

PAIRED_CHECK_S = 300


def fetch_config():
    """(bot_token, pair_gen, pair_at) from the backend; any may be None. pair_gen is
    None on an api that predates it or when it has no generation for this machine —
    then only the token is compared. pair_at = api time of the last web link/unlink."""
    req = urllib.request.Request(API_URL, headers={"x-api-key": f"proxy-{PROXY_TOKEN}"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        body = json.loads(resp.read()) or {}
    gen, at = body.get("pair_gen"), body.get("pair_at")
    return (body.get("bot_token") or None,
            gen if isinstance(gen, str) and gen else None,
            at if isinstance(at, int) and not isinstance(at, bool) else None)


REREAD_S = 0.3
# A non-empty file that still doesn't parse is "mid-write" only if someone wrote it
# just now; older than this it is simply corrupt, and skipping forever would leave the
# machine unable to ever link.
MID_WRITE_S = 10
_EMPTY, _BAD = object(), object()


def _read_once(path):
    try:
        # utf-8-sig: a hand-written / PowerShell-written file may carry a BOM
        with open(path, encoding="utf-8-sig") as f:
            raw = f.read()
    except FileNotFoundError:
        return {}
    if not raw.strip():
        return _EMPTY
    try:
        data = json.loads(raw)
    except ValueError:
        return _BAD
    return data if isinstance(data, dict) else _BAD


def read_config(path):
    """telegram.json as a dict, {} = unpaired, None = mid-write (caller skips the round
    / keeps its last good copy).

    Empty is the normal state of a machine that never linked — provision / first-boot
    pre-create a 0-byte file (1.1.70 read it as mid-write and never fetched a token).
    But on Windows the file is rewritten in place (O_TRUNC), so a read can also land on
    that instant's 0 bytes; taking it as {} there would re-deliver the token and wipe
    the pairing. Hence one re-read after REREAD_S for both empty and unparsable: still
    empty = really empty; still unparsable and freshly written = mid-write; unparsable
    and old = corrupt → {} (rewritten by the next converge)."""
    data = _read_once(path)
    if data is _EMPTY or data is _BAD:
        time.sleep(REREAD_S)
        data = _read_once(path)
    if data is _EMPTY:
        return {}
    if data is _BAD:
        try:
            fresh = time.time() - os.path.getmtime(path) < MID_WRITE_S
        except OSError:
            fresh = False
        return None if fresh else {}
    return data


def load_config():
    """See read_config. Callers skip the round on None: reading a mid-write file as {}
    would "deliver" the token again and wipe the pairing, and the bridge would then
    pair whoever speaks next."""
    return read_config(CONFIG_PATH)


def replace_retry(tmp, path):
    """os.replace, retried: on Windows it loses with PermissionError to another process
    holding the target open — the same transient command_listener._finish_mgmt_job
    retries. (Used for state/tg_offset; telegram.json is rewritten in place on Windows.)"""
    for attempt in range(5):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            if attempt == 4:
                raise
            time.sleep(0.3)


def write_json_600(path, data):
    """Bot token is a secret — owner-only, never briefly world-readable. POSIX:
    tmp+replace, since telegram.json has three writers (this poller, reset(), the
    bridge's auto-pair) and the bridge re-reads it every loop. Windows: rewritten IN
    PLACE — provision.ps1 gives telegram.json an explicit ACL (inheritance removed,
    Administrators/SYSTEM only) and a replaced file would inherit config\\'s instead;
    a torn read there costs the bridge one idle loop."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.name == "nt":
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
        return
    # unique temp name: with three writers a shared one gets clobbered mid-write, or
    # moved away under another writer's os.replace
    tmp = f"{path}.{os.getpid()}.{time.monotonic_ns()}.tmp"
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
        os.chmod(tmp, 0o600)
        replace_retry(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)  # it holds the bot token
        except OSError:
            pass
        raise


def save_config(config):
    write_json_600(CONFIG_PATH, config)


def run_sync_notify():
    """Keep lib/notify.py's compat files (openclaw.json botToken, allowFrom) in sync."""
    try:
        subprocess.run([PYTHON_BIN, SYNC_SCRIPT], check=False, timeout=30)
    except Exception as e:
        print(f"[telegram_pairing] sync_notify_compat failed: {e}", file=sys.stderr)


def clear_notify_compat():
    """Drop the pairing from lib/notify's compat files. sync_notify_compat.py only ever
    writes them and lives in control/ (no release channel reaches it), so the clearing
    half has to live here. Permission errors propagate: a half-cleared state (config
    unlinked, lib/notify still sending) is worse than an honest failure."""
    try:
        os.remove(ALLOW_FROM_PATH)
    except FileNotFoundError:
        pass
    try:
        with open(OPENCLAW_JSON_PATH) as f:
            data = json.load(f)
    except FileNotFoundError:
        return
    except ValueError:
        data = None
    tg = ((data or {}).get("channels") or {}).get("telegram") if isinstance(data, dict) else None
    if isinstance(tg, dict) and "botToken" in tg:
        del tg["botToken"]
        write_json_600(OPENCLAW_JSON_PATH, data)


def _drop_foreign_offset(token):
    """Drop state/tg_offset unless it is keyed to this same bot. A same-bot offset is
    the record of updates the bridge already handled but Telegram hasn't confirmed —
    deleting it replays them (the message just answered runs again and can win the new
    pairing). Another bot's offset, or the pre-1.1.70 bare int whose bot is unknown,
    would skip the new bot's updates, so those go."""
    try:
        with open(OFFSET_PATH) as f:
            data = json.load(f)
    except FileNotFoundError:
        return
    except ValueError:
        data = None
    if token and isinstance(data, dict) and data.get("bot") == str(token).split(":", 1)[0]:
        return
    try:
        os.remove(OFFSET_PATH)
    except FileNotFoundError:
        pass


def _apply(token, gen, at=None, offset_token=None):
    """A fresh pairing (or none): chat id and compat files dropped (offset only when
    it isn't this bot's — `offset_token` names the bot to keep it for when no token is
    written yet); the token (if any), generation and link time written. The bridge sees
    a new (bot id, pair_gen) identity and starts over — first chat to message the bot
    after `pair_at` pairs."""
    clear_notify_compat()
    _drop_foreign_offset(token or offset_token)
    config = {}
    if gen:
        config["pair_gen"] = gen
    if at:
        config["pair_at"] = at
    if token:
        config["bot_token"] = token
    save_config(config)
    if token:
        run_sync_notify()


def converge(config, token, gen, at=None):
    """Bring the local pairing in line with the backend's. Returns what changed, or
    None. Unpairing needs the backend to state a generation too: an api that predates
    pair_gen (or a row caught mid-resume behind a cached auth) answers a null token for
    a machine that is still paired, and a lost generation must never unpair anyone."""
    local_token = config.get("bot_token")
    if not token:
        if gen is None:
            return None
        if local_token:
            _apply(None, gen, at)
            return "unlinked"
        if config.get("pair_gen") != gen:
            # nothing to unpair, but the generation is what the report echoes back —
            # without it the web's pending_apply would never clear
            save_config({**config, "pair_gen": gen})
            return "gen-synced"
        return None
    if not local_token:
        _apply(token, gen, at)
        return "linked"
    # replacing a token also needs a stated generation: the pre-pair_gen /config read
    # "some running row of this user" and could hand over another row's token
    if gen is not None and (local_token != token or config.get("pair_gen") != gen):
        _apply(token, gen, at)
        return "re-linked"
    return None


def reset(gen):
    """Command `telegram_reset` (web link / unlink, machine up). Always a fresh
    pairing. If the backend can't be reached the pairing is still dropped now — an
    unlink must not wait on a retry — and the poller delivers the token next tick."""
    try:
        token, backend_gen, at = fetch_config()
    except Exception as e:
        print(f"[telegram_pairing] reset: fetch failed ({type(e).__name__}); "
              f"poller will deliver the token", file=sys.stderr)
        # the token may well come back unchanged (same-bot re-link): keep that bot's offset
        local = load_config() or {}
        _apply(None, gen, offset_token=local.get("bot_token"))
        return {"bot_token": False}
    _apply(token, backend_gen or gen, at)
    return {"bot_token": bool(token)}


def _paired_check_due():
    try:
        return time.time() - os.path.getmtime(CHECKED_PATH) >= PAIRED_CHECK_S
    except OSError:
        return True


def _mark_checked():
    os.makedirs(os.path.dirname(CHECKED_PATH), exist_ok=True)
    with open(CHECKED_PATH, "w") as f:
        f.write(str(int(time.time())))


def main():
    if not PROXY_TOKEN:
        print("[telegram_pairing] BLAVE_PROXY_TOKEN not set; exiting", file=sys.stderr)
        sys.exit(1)

    # Paired machines ask the backend only every PAIRED_CHECK_S (the command channel
    # covers the live case); the rest of the ticks are a local file check, no network.
    config = load_config()
    if config is None:
        print("[telegram_pairing] telegram.json unreadable (mid-write?) — skipping this round",
              file=sys.stderr)
        return
    if config.get("bot_token") and not _paired_check_due():
        return

    try:
        token, gen, at = fetch_config()
    except Exception as e:
        print(f"[telegram_pairing] fetch failed: {type(e).__name__}", file=sys.stderr)
        sys.exit(1)
    _mark_checked()

    changed = converge(config, token, gen, at)
    if changed:
        print(f"[telegram_pairing] pairing {changed}", file=sys.stderr)


if __name__ == "__main__":
    main()
