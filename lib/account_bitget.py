"""
Bitget account library — USDT-M futures equity, positions, holdings and external
cash flows, on BOTH account types; also the signed transport lib/order_bitget.py
sends through.

Discovered by filename (lib.account_bitget.get_equity / get_positions).
Credentials: BITGET_API_KEY / BITGET_SECRET_KEY / BITGET_PASSPHRASE in .env
(the names the web form has carried since before Bitget shipped — locked). One
key serves both APIs: an upgraded account's existing key gains UTA access.

TWO ACCOUNT TYPES, picked per key by account_mode():
- classic (v2 API) — real-account run passed (main account, both position modes,
  2026-10-22).
- UTA (Unified Trading Account, v3 API) — real-account run passed (T1–T12;
  T11c's stop-loss re-run on BTCUSDT 2026-10-26); a UTA key answers 40085 on any v2 private
  endpoint. Bitget is moving accounts to it.
Only the types in VERIFIED_MODES (lib/venue_traits' bitget row) are served; a key of
another type is refused on every read.
The mode is re-read every MODE_TTL_S and at once on a 40085. The mode and the legs
last held are recorded in state/bitget_account_mode.json. A first read, a changed
mode (Bitget upgraded the account while it ran, or the user switched it), an
`upgrading` / `switching` account or an unreadable record opens the switch hold:
get_positions raises a TRANSIENT error and lib/order_bitget refuses entries for at
least SWITCH_HOLD_S — a half-migrated account could read as flat and be bought into
twice. After a real switch the legs recorded before it (symbol, side, quantity) must
then all read back the same, with nothing extra: a full match resumes by itself (a P3
event), anything else HALTs at once (MODE_STUCK; the HALT carries the legs that differ
for the pages) and only the user's resume releases it (_check_hold).

Equity base, both modes: the USDT row only (classic: the USDT-FUTURES account's
USDT row; UTA: the unified account's USDT asset `equity` = balance + frozen +
uPnL). Other coins in a UTA count as collateral at Bitget but are holdings here.

Sizes: USDT-futures size is BASE coin on v2 and v3 (the step is only the step),
so no contract conversion exists anywhere in these two libs.
"""

import base64
import hashlib
import hmac
import json
import math
import os
import time
from decimal import Decimal
from urllib.parse import urlencode

import requests

from lib import guard

try:
    from lib import stock_perps
except ImportError:  # half-updated workspace: stock swaps read under Bitget's own names
    stock_perps = None
try:
    from lib.winreplace import atomic_replace
except ImportError:  # half-updated workspace (lib/winreplace.py not landed): plain replace
    atomic_replace = os.replace
try:
    from lib.winreplace import load_json
except ImportError:  # half-updated workspace (lib/winreplace.py without load_json): no read retry
    def load_json(path, **open_kw):
        with open(path, **open_kw) as f:
            return json.load(f)
try:
    from lib import venue_errors
except ImportError:  # a file-by-file update that skipped lib/venue_errors.py must not break reads
    venue_errors = None
try:
    from lib import venue_traits
except ImportError:  # half-updated workspace: no table to say "verified" → closed
    venue_traits = None
try:
    from lib import reject_token
except ImportError:  # half-updated workspace: errors go out untagged
    from types import SimpleNamespace as _NS
    reject_token = _NS(tag=lambda kind, msg: str(msg), from_code=lambda *a, **k: None,
                       **{k: k.lower() for k in ("INSUFFICIENT_MARGIN", "BELOW_MIN_SIZE", "SYMBOL_UNAVAILABLE",
                                                 "KEY_PERMISSION", "REDUCE_ONLY_REJECTED")})

HOST = "https://api.bitget.com"
PRODUCT = "USDT-FUTURES"
CATEGORY = PRODUCT  # v3 calls it category; same value
MARGIN_COIN = "USDT"
# Broker attribution: Bitget's channel header (the UTA strategy-order doc names it for
# broker rebates; ccxt sends its own code in it). Empty = not sent. Wei is still getting Blave's code from Bitget — fill it here;
# this is the only place either lib reads it.
BROKER_HEADER = "X-CHANNEL-API-CODE"
BROKER_CHANNEL_CODE = ""
_time_offset = {"ms": 0}
# THE gate (venue-onboarding §3): the account types whose real-account run passed, read from
# lib/venue_traits' bitget row (verified_modes). Empty = no private call of either lib is
# signed. A key whose account type is not in it is refused by account_mode() — every read,
# order and bind check — with what to do. tests/live_bitget_verify.py widens it for its own
# process only.
VERIFIED_MODES = frozenset(venue_traits.verified_modes("bitget")) if venue_traits else frozenset()
UNVERIFIED = "unverified"

UTA_MODE = "40085"  # a v2 private endpoint on a UTA account
ELIGIBILITY = "40092"  # "unavailable due to applicable regulatory requirements or account eligibility"
# fixed markers the desktop reads instead of this file's Chinese wording (same idea as OKX's
# [okx_account_mode]); kept near the front so manager/order_errors.json's 200-char cut keeps them
ELIGIBILITY_TAG = "[bitget_account_eligibility]"
MODE_TAG = "bitget_account_mode"  # "[bitget_account_mode:uta|classic]"
MODE_SWITCH = "mode_switch"  # ours: the account type changed or is changing — skip this round
MODE_UNSUPPORTED = "mode_unsupported"  # ours: an account type this lib does not trade
TIMESTAMP_CODES = {"40008", "40004", "40005"}
RATE_LIMITED = "429"

MODE_PATH = "state/bitget_account_mode.json"  # cwd = the workspace, as lib/guard's state/
MODE_TTL_S = 60
SWITCH_HOLD_S = 120  # the minimum hold; it ends only when the positions read back too
SWITCH_MAX_S = 1800  # past this a hold stops being TRANSIENT (MODE_STUCK → HALT if it lasts)
MODE_STUCK = "mode_stuck"
# the HALT reason of a switch whose legs did not carry over; the desktop picks its sentence by it
MISMATCH_TAG = "[bitget_account_mode_mismatch]"
_mode = {"mode": None, "at": 0.0}


class BitgetError(Exception):
    """code = Bitget's error code (str), http_status = HTTP status —
    classify() and lib/order_bitget read them."""

    def __init__(self, msg, code=None, http_status=None, kind=None):
        code = None if code is None else str(code)
        kind = kind or reject_token.from_code(code, REJECT_CODES, _CREDENTIAL)
        super().__init__(reject_token.tag(kind, msg))
        self.code = code
        self.http_status = http_status


# lib/reject_token kinds. Official (Bitget's common-error-handling page): 45110 order value
# under the 5 USDT minimum, 45119 symbol restricted or delisted. Replies ccxt's bitget.py
# records (to be confirmed by tests/live_bitget_verify.py): 40762 "The order amount exceeds
# the balance", 43012 "Insufficient balance".
# UTA (official UTA error page; unmeasured): 43027 notional under the minimum, 25102 / 25105
# symbol cannot be opened / delisted / in maintenance, 12001 insufficient balance.
REJECT_CODES = {"45110": reject_token.BELOW_MIN_SIZE, "45119": reject_token.SYMBOL_UNAVAILABLE,
                "40762": reject_token.INSUFFICIENT_MARGIN, "43012": reject_token.INSUFFICIENT_MARGIN,
                "43027": reject_token.BELOW_MIN_SIZE, "25102": reject_token.SYMBOL_UNAVAILABLE,
                "25105": reject_token.SYMBOL_UNAVAILABLE, "12001": reject_token.INSUFFICIENT_MARGIN,
                # measured 2026-10-22 (classic main account, Taiwan, TWTSMUSDT open): Bitget withholds
                # the product from THIS account (region / eligibility). symbol_unavailable, not a new
                # kind: to the user "this symbol cannot be traded here" is the answer either way, and
                # it is the token web and desktop already render
                ELIGIBILITY: reject_token.SYMBOL_UNAVAILABLE,
                # measured 2026-10-22 (classic one-way): "closed positions cannot exceed positions held"
                "40804": reject_token.REDUCE_ONLY_REJECTED,
                # measured 2026-10-23 (UTA hedge): "posSide and reduceOnly do not assign values at
                # the same" — order_bitget no longer sends both; a lib that still does gets this
                "25238": reject_token.REDUCE_ONLY_REJECTED,
                # measured 2026-10-23 (UTA one-way): reduceOnly close over the held size, refused whole
                "25231": reject_token.REDUCE_ONLY_REJECTED}


def _creds(env):
    api_key = env.get("BITGET_API_KEY")
    secret = env.get("BITGET_SECRET_KEY")
    passphrase = env.get("BITGET_PASSPHRASE")
    if not api_key or not secret or not passphrase:
        raise ValueError("BITGET_API_KEY / BITGET_SECRET_KEY / BITGET_PASSPHRASE missing from .env")
    return api_key, secret, passphrase


def _now_ms():
    return int(time.time() * 1000) + _time_offset["ms"]


def sync_time():
    """Offset our clock against Bitget's (public /api/v2/public/time). A failed
    read keeps the old offset."""
    try:
        t0 = time.time()
        r = requests.get(f"{HOST}/api/v2/public/time", timeout=5)
        t1 = time.time()
        _time_offset["ms"] = int(r.json()["data"]["serverTime"]) - int((t0 + t1) / 2 * 1000)
    except Exception:
        pass


def sign(secret, ts, method, request_path, body=""):
    """Base64(HMAC-SHA256(secret, ts + METHOD + requestPath[?query] + body))."""
    msg = f"{ts}{method.upper()}{request_path}{body}"
    return base64.b64encode(hmac.new(secret.encode(), msg.encode(), hashlib.sha256).digest()).decode()


def headers(env, method, request_path, body=""):
    if not VERIFIED_MODES:
        raise BitgetError(f"Bitget 還沒通過真帳驗證，Blave 目前不支援 Bitget：{method.upper()} "
                          f"{request_path.split('?')[0]} 沒有送出", code=UNVERIFIED)
    api_key, secret, passphrase = _creds(env)
    ts = str(_now_ms())
    h = {
        "ACCESS-KEY": api_key,
        "ACCESS-SIGN": sign(secret, ts, method, request_path, body),
        "ACCESS-PASSPHRASE": passphrase,
        "ACCESS-TIMESTAMP": ts,
        "Content-Type": "application/json",
        "locale": "en-US",
    }
    if BROKER_CHANNEL_CODE:
        h[BROKER_HEADER] = BROKER_CHANNEL_CODE
    return h


def _redact(env, msg):
    for k in ("BITGET_API_KEY", "BITGET_PASSPHRASE"):
        v = env.get(k)
        if v and v in msg:
            msg = msg.replace(v, "***")
    return msg


def error_of(env, r, path):
    """BitgetError when the reply is an error, else None. Errors are HTTP 4xx with
    {"code": "<5 digits>", "msg"} — read the body before the status."""
    try:
        body = r.json()
    except ValueError:
        if r.status_code >= 400:
            return BitgetError(f"bitget {path} HTTP {r.status_code}: {r.text[:160]}",
                               http_status=r.status_code)
        return BitgetError(f"bitget {path}: non-JSON reply ({r.text[:120]})", http_status=r.status_code)
    if not isinstance(body, dict):
        return BitgetError(f"bitget {path}: unexpected reply {str(body)[:120]}", http_status=r.status_code)
    code = str(body.get("code")) if body.get("code") is not None else None
    if code == "00000" and r.status_code < 400:
        return None
    msg = _redact(env, str(body.get("msg") or ""))
    if code == UTA_MODE:
        # not the key's fault: the account is (now) a UTA — _get / order_bitget switch over
        return BitgetError(f"bitget {path} code={code}: 這個 Bitget 帳戶是統一帳戶（UTA）（{msg}）",
                           code=code, http_status=r.status_code)
    if code == ELIGIBILITY:
        return BitgetError(f"Bitget 依所在地區或帳戶資格不開放這項交易給這個帳戶 {ELIGIBILITY_TAG}（code={code}），跟策略本身無關："
                           f"換一個能交易的標的，或洽 Bitget 客服確認帳戶資格（{msg[:120]}）",
                           code=code, http_status=r.status_code)
    return BitgetError(f"bitget {path} code={code}: {msg}", code=code, http_status=r.status_code)


def request_path(path, params=None):
    """path?query exactly as signed and sent (params kept in the caller's order)."""
    q = urlencode([(k, str(v)) for k, v in (params or {}).items() if v is not None])
    return f"{path}?{q}" if q else path


def send_get(env, path, params=None, timeout=10):
    """One signed GET, no retry — returns `data`. Orders are lib/order_bitget's own
    transport; nothing here writes."""
    rp = request_path(path, params)
    r = requests.get(f"{HOST}{rp}", headers=headers(env, "GET", rp), timeout=timeout)
    err = error_of(env, r, path)
    if err is not None:
        raise err
    return r.json().get("data")


def _get(env, path, params=None, _resynced=False, switch=True):
    try:
        return send_get(env, path, params)
    except BitgetError as e:
        if e.code in TIMESTAMP_CODES and not _resynced:
            sync_time()
            return _get(env, path, params, _resynced=True, switch=switch)
        if e.code == UTA_MODE and switch:
            raise switched(env, e) from e
        raise


# ── account mode (UTA / classic) ─────────────────────────────────────────────

def _read_mode():
    """The mode file; {} when there is none, {'corrupt': True} when it cannot be read —
    an unreadable record holds (fail-closed), it never reads as "no switch"."""
    try:
        st = load_json(MODE_PATH)  # Windows: another process mid-replace → retry, not "corrupt"
    except FileNotFoundError:
        return {}
    except (OSError, ValueError):
        return {"corrupt": True}
    return st if isinstance(st, dict) else {"corrupt": True}


def _write_mode(st):
    os.makedirs(os.path.dirname(MODE_PATH), exist_ok=True)
    tmp = f"{MODE_PATH}.{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump(st, f)
    atomic_replace(tmp, MODE_PATH)


def _transient(e):
    return venue_errors is not None and classify(e) == venue_errors.TRANSIENT


def _probe(env):
    """('uta' | 'classic' | 'transition', settings or None) from the venue itself.
    UTA first (/api/v3/account/settings answers only there); anything else that is
    not a network-class failure is asked of the classic API. Unreadable → raises:
    an unknown mode is never guessed (a wrong guess reads the wrong API as flat)."""
    try:
        st = _get(env, "/api/v3/account/settings")
    except BitgetError as e:
        if _transient(e) or e.code in TIMESTAMP_CODES or (e.http_status or 0) >= 500:
            raise
        try:
            _get(env, "/api/v2/mix/account/accounts", {"productType": PRODUCT}, switch=False)
        except BitgetError as e2:
            if e2.code != UTA_MODE:
                raise
            _require_verified("uta")  # UTA not open: "tick the read permission" would be wasted effort
            # a UTA whose key cannot read the account settings (where the hold mode lives)
            raise BitgetError(
                f"這組 Bitget 金鑰的帳戶是統一帳戶 [{MODE_TAG}:uta]，但讀不到帳戶設定（{e}）：請在 Bitget 建金鑰時勾選統一帳戶的讀取權限",
                code=MODE_UNSUPPORTED, kind=reject_token.KEY_PERMISSION) from e
        return "classic", None
    am = str((st or {}).get("accountMode") or "")
    if am == "unified":
        return "uta", st
    if am in ("upgrading", "switching"):
        return "transition", st
    # hybrid and anything newer: not measured — refuse in words rather than trade a guess
    raise BitgetError(f"Bitget 帳戶模式是 {am or '（空白）'}，Blave 還沒支援這種模式：請改綁經典帳戶或統一帳戶的金鑰，或改綁其他交易所",
                      code=MODE_UNSUPPORTED, kind=reject_token.KEY_PERMISSION)


def _hold_error(why):
    return BitgetError(f"bitget: {why} — 這一輪只讀帳戶、不下單，下一輪自動重試", code=MODE_SWITCH)


def _legs_of(rows):
    """[[symbol, side, qty]] of every non-zero leg. A mode file from before the quantity was
    recorded holds [symbol, side] pairs: those legs are matched on symbol and side only."""
    return sorted([p["symbol"], p["side"], p["total"]] for p in rows if p["total"] > 0)


def _leg_key(leg):
    return (leg[0], leg[1])


def _leg_qty(leg):
    return leg[2] if len(leg) > 2 else None


def _step(vsym):
    row = next((r for r in contract_rows() if r.get("symbol") == vsym), None)
    if row is None or row.get("sizeMultiplier") in (None, ""):
        raise requests.exceptions.ConnectionError(f"bitget contracts: no sizeMultiplier for {vsym}")
    return Decimal(str(row["sizeMultiplier"]))


def _mismatch(before, now):
    """The legs a switch did not carry over as they were: one missing, one more, or a
    quantity off by a step or more (sizes are whole steps, so less is only the venue's
    rounding; Bitget says a manual upgrade keeps size and average price)."""
    was = {_leg_key(x): _leg_qty(x) for x in before}
    is_ = {_leg_key(x): _leg_qty(x) for x in now}
    out = []
    for key in sorted(set(was) | set(is_)):
        a, b = was.get(key), is_.get(key)
        if key in was and key in is_:
            if a is None or abs(Decimal(str(a)) - Decimal(str(b))) < _step(key[0]):
                continue
        out.append({"symbol": key[0], "side": key[1],
                    "before": a if key in was else None, "now": b if key in is_ else None})
    return out


def _display_symbol(vsym):
    try:
        return canonical(vsym)
    except Exception:
        return vsym


def _halt_on_disk():
    """state/HALT as written (None = absent). Not guard.halted(): its in-memory flag stays
    set in a process that tripped HALT itself, and a cleared file is what a resume is."""
    try:
        info = load_json(guard.HALT_PATH)
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        return {"reason": ""}
    return info if isinstance(info, dict) else {"reason": ""}


def _mismatch_reason(mode, rows):
    def q(x):
        return "none" if x is None else format(Decimal(str(x)).normalize(), "f")
    legs = ", ".join(f"{r['symbol']} {r['side']} {q(r['before'])} -> {q(r['now'])}" for r in rows)
    return (f"{MISMATCH_TAG} Bitget account switched to {_MODE_NAMES_EN.get(mode, mode)}; "
            f"{len(rows)} position(s) differ from before the switch: {legs}")[:200]


def _trip_mismatch_halt(mode, rows):
    """HALT for a switch whose legs do not match, tripped here rather than by the reconciler:
    whichever process reads first (the reconciler, the account reader) must stop trading at
    once, and the hold needs the HALT's own timestamp to tell a resume from no HALT yet.
    source "reconciler": an automatic stop (the platform's halt P1, canon notifications.md)."""
    reason = _mismatch_reason(mode, rows)
    detail = {"kind": "bitget_mode_mismatch", "venue": "bitget", "mode": mode,
              "legs": [{**r, "symbol": _display_symbol(r["symbol"])} for r in rows][:20]}
    try:
        guard.trip_halt(reason, "reconciler", mismatch=detail)
    except TypeError:  # a guard from before trip_halt took extra fields
        guard.trip_halt(reason, "reconciler")
    return (_halt_on_disk() or {}).get("ts")


def _stuck_error(mode, rows):
    return BitgetError(f"bitget: 帳戶換成{_MODE_NAMES.get(mode, mode)}後有 {len(rows)} 個倉位跟換之前對不上，"
                       f"自動下單已暫停：請到 Bitget 核對，再按「啟動下單」", code=MODE_STUCK)


def _release(mode, now_legs, switched_from=None):
    _write_mode({"mode": mode, "legs": [list(x) for x in now_legs], "hold": None})
    if switched_from and switched_from != mode:
        try:
            from lib import events
            events.emit("venue_mode_switched", venue="bitget", mode=mode, legs=len(now_legs))
        except Exception:
            pass


def account_mode(env, refresh=False):
    """'uta' | 'classic' for this key — read off Bitget, cached MODE_TTL_S. Opens the
    switch hold (see get_positions) when the mode is read for the first time, differs
    from the one recorded, follows a transition, or the record is unreadable. An account
    Bitget reports as mid-upgrade raises MODE_SWITCH (TRANSIENT) — MODE_STUCK (UNKNOWN,
    the reconciler HALTs if it lasts) after SWITCH_MAX_S."""
    now = time.time()
    if not refresh and _mode["mode"] and now - _mode["at"] < MODE_TTL_S:
        _require_verified(_mode["mode"])
        return _mode["mode"]
    _mode.update(mode=None, at=0.0)
    mode, _ = _probe(env)
    st = _read_mode()
    prev = None if st.get("corrupt") else st.get("mode")
    legs = [] if st.get("corrupt") else st.get("legs") or []
    hold = None if st.get("corrupt") else st.get("hold")
    if mode == "transition":
        hold = hold or {"since": now, "await": legs, "from": prev}
        _write_mode({"mode": prev, "legs": legs, "hold": hold})
        if now - hold["since"] > SWITCH_MAX_S:
            raise BitgetError(f"bitget: 帳戶已經切換帳戶類型超過 {SWITCH_MAX_S // 60} 分鐘還沒完成，"
                              f"請到 Bitget App 確認（升級統一帳戶或切回經典帳戶）", code=MODE_STUCK)
        raise _hold_error("Bitget 帳戶正在切換帳戶類型（升級統一帳戶或切回經典帳戶）")
    if hold is None and prev != mode:
        # first read, a changed mode or a lost record: hold until the positions recorded
        # before it read back under the new mode (get_positions releases it)
        hold = {"since": now, "await": legs, "from": prev}
    if prev != mode or st.get("corrupt") or hold != st.get("hold"):
        _write_mode({"mode": mode, "legs": legs, "hold": hold})
    _require_verified(mode)
    _mode.update(mode=mode, at=now)
    return mode


_MODE_NAMES = {"uta": "統一帳戶", "classic": "經典帳戶"}
_MODE_NAMES_EN = {"uta": "a unified account (UTA)", "classic": "a classic account"}


def _require_verified(mode):
    """A key whose account type has not been verified on a real account is refused — never
    traded on the other type's measurements. Raised on every read (never cached)."""
    if mode in VERIFIED_MODES:
        return
    ok = "、".join(_MODE_NAMES[m] for m in sorted(VERIFIED_MODES)) or "（還沒有）"
    tag = f" [{MODE_TAG}:{mode}]" if mode in _MODE_NAMES else ""
    # not "switch the account back": an upgraded Bitget sub-account cannot return to classic
    raise BitgetError(f"這組 Bitget 金鑰的帳戶是{_MODE_NAMES.get(mode, mode)}{tag}，Blave 還不支援 Bitget 的"
                      f"{_MODE_NAMES.get(mode, mode)}（目前只支援{ok}）：請改綁{ok}的金鑰，或改綁其他交易所", code=UNVERIFIED,
                      kind=reject_token.KEY_PERMISSION)


def switched(env, cause):
    """A v2 call answered 40085 (or a v3 call failed in a way only a mode change explains):
    re-read the mode, which records the switch, and return the MODE_SWITCH error the
    caller raises — the request that saw it is never re-sent to the other API."""
    was = _mode["mode"]
    _mode.update(mode=None, at=0.0)
    try:
        mode = account_mode(env, refresh=True)
    except BitgetError as e:
        return e
    if mode == was:
        return _hold_error(f"Bitget 回覆跟帳戶類型對不上（{cause}）")
    return _hold_error(f"Bitget 帳戶類型改成了{'統一帳戶' if mode == 'uta' else '經典帳戶'}（{cause}）")


def switch_hold_left():
    """>0 while the switch hold is open (seconds of its minimum left, at least 1 while it
    waits for the old positions to read back); 0 = none. An unreadable record holds."""
    st = _read_mode()
    if st.get("corrupt"):
        return float(SWITCH_HOLD_S)
    hold = st.get("hold")
    if not hold:
        return 0.0
    try:
        return max(1.0, SWITCH_HOLD_S - (time.time() - float(hold.get("since"))))
    except (TypeError, ValueError):
        return float(SWITCH_HOLD_S)


def _check_hold(mode, rows):
    """get_positions' gate. No hold: record the legs held (the evidence a later switch
    waits for). A hold lasts at least SWITCH_HOLD_S. After a real switch (the hold's `from`
    is another mode) it then compares every leg recorded before it with what reads now —
    same symbol, side and quantity within the step, nothing extra — and releases on a full
    match (a P3 event) or HALTs at once on anything else (MODE_STUCK). That HALT is the
    user's to clear: a resume releases the hold on what Bitget holds then. Any other hold
    (a first read, a lost record) releases once every recorded leg reads back non-zero."""
    st = _read_mode()
    now_legs = _legs_of(rows)
    hold = None if st.get("corrupt") else st.get("hold")
    if st.get("corrupt"):
        hold = {"since": time.time(), "await": []}
        _write_mode({"mode": mode, "legs": [], "hold": hold})
    if not hold:
        if [list(x) for x in now_legs] != st.get("legs"):
            _write_mode({**st, "mode": mode, "legs": [list(x) for x in now_legs]})
        return
    stuck = hold.get("stuck")
    if stuck:
        on_disk = _halt_on_disk()
        if on_disk is not None:
            if not stuck.get("halt_ts") and str(on_disk.get("reason") or "").startswith(MISMATCH_TAG):
                _write_mode({**st, "hold": {**hold, "stuck": {**stuck, "halt_ts": on_disk.get("ts")}}})
            return  # HALT stops every order; the positions read as they are
        if stuck.get("halt_ts"):
            _release(mode, now_legs)  # the user pressed 啟動下單 after checking on Bitget
            return
        # someone else's HALT stood when this was found and has been cleared: ours now
        ts = _trip_mismatch_halt(mode, stuck.get("legs") or [])
        _write_mode({**st, "hold": {**hold, "stuck": {**stuck, "halt_ts": ts}}})
        raise _stuck_error(mode, stuck.get("legs") or [])
    elapsed = time.time() - float(hold.get("since") or 0)
    if elapsed < SWITCH_HOLD_S:
        raise _hold_error(f"Bitget 帳戶類型剛{'改成統一帳戶' if mode == 'uta' else '改成經典帳戶'}或第一次讀到，"
                          f"約 {int(SWITCH_HOLD_S - elapsed) + 1} 秒內不對帳")
    if hold.get("from") and hold["from"] != mode:
        bad = _mismatch(hold.get("await") or [], now_legs)
        if not bad:
            _release(mode, now_legs, switched_from=hold["from"])
            return
        on_disk = _halt_on_disk()
        ts = None if on_disk is not None else _trip_mismatch_halt(mode, bad)
        _write_mode({**st, "hold": {**hold, "stuck": {"at": time.time(), "legs": bad, "halt_ts": ts}}})
        raise _stuck_error(mode, bad)
    have = {_leg_key(x) for x in now_legs}
    missing = [_leg_key(x) for x in hold.get("await") or [] if _leg_key(x) not in have]
    if not missing:
        _release(mode, now_legs)
        return
    if elapsed > SWITCH_MAX_S:
        raise BitgetError(f"bitget: 切換帳戶類型後 {SWITCH_MAX_S // 60} 分鐘仍讀不到原本的部位 "
                          f"{', '.join(f'{a} {b}' for a, b in missing)}，請到 Bitget App 確認", code=MODE_STUCK)
    raise _hold_error(f"Bitget 帳戶類型剛{'改成統一帳戶' if mode == 'uta' else '改成經典帳戶'}或第一次讀到，"
                      "還在等原本的部位讀回來（" + "、".join(f"{a} {b}" for a, b in missing) + "）")


def uta_settings(env):
    """/api/v3/account/settings, fresh (hold mode and per-symbol margin mode are read
    before every order, never cached)."""
    st = _get(env, "/api/v3/account/settings")
    if not isinstance(st, dict):
        raise BitgetError(f"bitget settings: unexpected reply {str(st)[:120]}")
    return st


def public(path, params=None):
    r = requests.get(f"{HOST}{request_path(path, params)}", timeout=10)
    err = error_of({}, r, path)
    if err is not None:
        raise err
    return r.json().get("data")


def _num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _opt(v, positive=False):
    """A display-only detail as float or None (never 0 for unknown); never raises."""
    f = _num(v)
    if f is None or (positive and f <= 0):
        return None
    return f


# ── contracts (public) ───────────────────────────────────────────────────────

_contracts = {"rows": None, "at": 0.0}
CONTRACTS_TTL_S = 6 * 3600


def contract_rows():
    """Every USDT-FUTURES contract (one public call, ~850 rows) — the stock names for
    lib/stock_perps, shared with lib/order_bitget. An error or an empty list raises and
    is never cached: an empty list would read every renamed stock position as flat."""
    c = _contracts
    if c["rows"] and time.time() - c["at"] < CONTRACTS_TTL_S:
        return c["rows"]
    rows = public("/api/v2/mix/market/contracts", {"productType": PRODUCT}) or []
    if not rows:
        raise requests.exceptions.ConnectionError("bitget contracts: empty list")
    c.update(rows=rows, at=time.time())
    return rows


def canonical(venue_sym):
    """Bitget's name → the strategy's (ACNSTOCKUSDT → ACNUSDT, lib/stock_perps). A name
    Binance lists as a coin is taken as is without reading the contract list."""
    sym = str(venue_sym or "").upper()
    if stock_perps is None or not sym or stock_perps.binance_class(sym) == "COIN":
        return sym
    return stock_perps.canonical("bitget", sym, contract_rows())


# ── equity / positions ───────────────────────────────────────────────────────

def _futures_row(env):
    rows = _get(env, "/api/v2/mix/account/accounts", {"productType": PRODUCT})
    if not isinstance(rows, list):
        raise BitgetError(f"bitget accounts: expected a list, got {str(rows)[:120]}")
    return next((r for r in rows if isinstance(r, dict) and r.get("marginCoin") == MARGIN_COIN), None)


def _wallets(env):
    """{accountType: USDT value} off /api/v2/account/all-account-balance — display only."""
    rows = _get(env, "/api/v2/account/all-account-balance")
    out = {}
    for r in rows if isinstance(rows, list) else []:
        name, v = str(r.get("accountType") or "").lower(), _num(r.get("usdtBalance"))
        if name and v is not None:
            out[name] = v
    return out


def get_equity(env: dict) -> dict:
    """Equity = the USDT row, in either mode (classic: the USDT-FUTURES account's USDT row
    `accountEquity`; UTA: the unified account's USDT asset `equity`) — balance + frozen +
    unrealized PnL, counted once. No USDT row: equity 0, not an error. `accounts` adds the
    other wallets (display only); when that read fails only the trading wallet is listed
    and `accounts_partial` says so."""
    if account_mode(env) == "uta":
        return _uta_equity(env)
    row = _futures_row(env)
    if row is None:
        equity = 0.0
    else:
        equity = _num(row.get("accountEquity"))
        if equity is None:
            raise BitgetError(f"bitget accounts: USDT row has no accountEquity ({str(row)[:160]})")
    out = {"equity": equity, "currency": "USDT", "accounts": {"futures": round(equity, 8)}}
    try:
        for name, v in _wallets(env).items():
            # the row naming is a live-verify item (R2): either name is this same USDT-M money
            if name not in ("futures", "usdt_futures") and v > 0:
                out["accounts"][name] = round(v, 8)
    except Exception:
        out["accounts_partial"] = True
    return out


def _uta_assets(env):
    data = _get(env, "/api/v3/account/assets")
    if not isinstance(data, dict) or not isinstance(data.get("assets", []), list):
        raise BitgetError(f"bitget UTA assets: unexpected reply {str(data)[:160]}")
    return data


def _uta_funding(env):
    rows = _get(env, "/api/v3/account/funding-assets")
    if rows is not None and not isinstance(rows, list):
        raise BitgetError(f"bitget UTA funding assets: expected a list, got {str(rows)[:120]}")
    return rows or []


def _uta_equity(env):
    """UTA: `equity` of the USDT asset row (Bitget: balance + frozen margin + uPnL of the
    positions settled in USDT). The account-wide usdtEquity also counts every other coin
    at its collateral value — not the base Blave sizes off (Wei 2026-10-20: USDT row only,
    as on every other venue). The funding account cannot trade: breakdown only."""
    data = _uta_assets(env)
    row = next((r for r in data.get("assets") or [] if str(r.get("coin") or "").upper() == "USDT"), None)
    equity = 0.0 if row is None else _num(row.get("equity"))
    if equity is None:
        raise BitgetError(f"bitget UTA assets: USDT row has no equity ({str(row)[:160]})")
    out = {"equity": equity, "currency": "USDT", "accounts": {"unified": round(equity, 8)}}
    try:
        fund = sum(_num(r.get("balance")) or 0.0 for r in _uta_funding(env)
                   if str(r.get("coin") or "").upper() in _STABLE)
        if fund > 0:
            out["accounts"]["funding"] = round(fund, 8)
    except Exception:
        out["accounts_partial"] = True
    return out


def position_rows(env):
    """Classic v2 position rows (raw)."""
    rows = _get(env, "/api/v2/mix/position/all-position",
                {"productType": PRODUCT, "marginCoin": MARGIN_COIN})
    if rows is None:
        return []
    if not isinstance(rows, list):
        raise BitgetError(f"bitget all-position: expected a list, got {str(rows)[:120]}")
    return rows


def uta_position_rows(env, symbol=None):
    """UTA v3 position rows (raw), USDT-FUTURES only."""
    q = {"category": CATEGORY}
    if symbol:
        q["symbol"] = symbol
    data = _get(env, "/api/v3/position/current-position", q)
    # flat is {"list": null} (measured 2026-10-23) or {"list": []}; any other shape
    # (no data, no list key, a non-list) raises — never read as flat
    if not isinstance(data, dict) or "list" not in data:
        raise BitgetError(f"bitget current-position: expected data.list, got {str(data)[:120]}")
    rows = [] if data["list"] is None else data["list"]
    if not isinstance(rows, list):
        raise BitgetError(f"bitget current-position: expected data.list, got {str(data)[:120]}")
    return rows


def leg_rows(env, mode=None):
    """[{'symbol' (Bitget's name), 'side', 'total', 'available', 'mark', 'raw'}] for the
    account's mode — what lib/order_bitget caps reduces with. One row per leg."""
    mode = mode or account_mode(env)
    out = []
    if mode == "uta":
        for p in uta_position_rows(env):
            out.append({"symbol": str(p.get("symbol") or ""), "side": str(p.get("posSide") or "").lower(),
                        "total": abs(_num(p.get("total")) or 0.0), "available": abs(_num(p.get("available")) or 0.0),
                        "mark": _num(p.get("markPrice")) or 0.0, "entry": p.get("avgPrice"),
                        "upnl": p.get("unrealisedPnl"), "margin": p.get("positionBalance"),
                        "leverage": p.get("leverage")})
    else:
        for p in position_rows(env):
            out.append({"symbol": str(p.get("symbol") or ""), "side": str(p.get("holdSide") or "").lower(),
                        "total": abs(_num(p.get("total")) or 0.0), "available": abs(_num(p.get("available")) or 0.0),
                        "mark": _num(p.get("markPrice")) or 0.0, "entry": p.get("openPriceAvg"),
                        "upnl": p.get("unrealizedPL"), "margin": p.get("marginSize"),
                        "leverage": p.get("leverage")})
    return out


def get_positions(env: dict) -> list:
    """Open positions, one row per leg (hedge mode: a symbol can hold a long AND a
    short row — lib.venue_wiring nets them). size is base units (`total`). Raises
    MODE_SWITCH (TRANSIENT) while the switch hold is open (_check_hold): the rounds
    around an account type change read nothing as flat."""
    mode = account_mode(env)
    rows = leg_rows(env, mode)
    _check_hold(mode, rows)
    out = []
    for p in rows:
        if p["total"] == 0:
            continue
        vsym, side = p["symbol"], p["side"]
        if side not in ("long", "short"):
            raise BitgetError(f"bitget position {vsym}: unknown side {side!r}")
        # a non-zero position we cannot value must raise, never be skipped:
        # a dropped row reads as flat and the reconciler re-buys on top of it
        if p["mark"] <= 0:
            raise BitgetError(f"bitget position {vsym}: no markPrice on a non-zero position")
        out.append({
            "symbol": canonical(vsym),
            "side": side,
            "size": p["total"],
            "mark_price": p["mark"],
            "entry_price": _opt(p["entry"], positive=True),
            "unrealized_pnl": _opt(p["upnl"]),
            "margin": _opt(p["margin"], positive=True),
            "leverage": _opt(p["leverage"], positive=True),
        })
    return out


# ── holdings / flows (display + equity-curve netting) ────────────────────────

_STABLE = {"USDT", "USDC"}


def _spot_prices():
    rows = public("/api/v2/spot/market/tickers") or []
    return {str(r.get("symbol") or ""): _num(r.get("lastPr")) for r in rows}


def _holding_rows(env):
    """[(coin, amount, wallet)] — classic: spot + funding; UTA: every unified coin but
    USDT (that row is the equity) + the funding account."""
    raw = []
    if account_mode(env) == "uta":
        for r in _uta_assets(env).get("assets") or []:
            coin = str(r.get("coin") or "").upper()
            amt = _num(r.get("equity"))
            if amt is None:
                amt = _num(r.get("balance")) or 0.0
            if coin != "USDT" and amt > 0:
                raw.append((coin, amt, "unified"))
        for r in _uta_funding(env):
            amt = _num(r.get("balance")) or 0.0
            if amt > 0:
                raw.append((str(r.get("coin") or "").upper(), amt, "funding"))
        return raw
    for path, wallet in (("/api/v2/spot/account/assets", "spot"),
                         ("/api/v2/account/funding-assets", "funding")):
        for r in _get(env, path) or []:
            amt = sum(_num(r.get(k)) or 0.0 for k in ("available", "frozen", "locked"))
            if amt > 0:
                raw.append((str(r.get("coin") or "").upper(), amt, wallet))
    return raw


def get_holdings(env: dict) -> list:
    """Coins outside the trading USDT — DISPLAY ONLY, never positions (classic: spot and
    funding wallets; UTA: the unified account's non-USDT coins and the funding account).
    A coin without a live USDT ticker is still listed, value None."""
    raw = _holding_rows(env)
    prices = None
    out = []
    for coin, amt, wallet in raw:
        if coin in _STABLE:
            value = amt
        else:
            if prices is None:
                try:
                    prices = _spot_prices()
                except Exception:
                    prices = {}
            px = prices.get(f"{coin}USDT")
            value = amt * px if px else None
        if value is not None and value < 0.1:
            continue
        out.append({"asset": coin, "amount": amt, "usdt_value": value, "wallet": wallet})
    out.sort(key=lambda h: -(h["usdt_value"] or 0))
    return out


FLOW_WINDOW_MS = 89 * 86400 * 1000  # classic records endpoints: at most 90 days per query
UTA_FLOW_WINDOW_MS = 29 * 86400 * 1000  # UTA: at most 30 days (ccxt bitget.py)


def _flow_rows(env, path, since_ms, now_ms):
    rows, start = [], since_ms
    while start < now_ms:
        end = min(start + FLOW_WINDOW_MS, now_ms)
        cursor = None
        for _ in range(60):
            params = {"startTime": start, "endTime": end, "limit": 100}
            if cursor:
                params["idLessThan"] = cursor
            page = _get(env, path, params) or []
            rows += page
            if len(page) < 100:
                break
            cursor = min(page, key=lambda r: int(r.get("orderId") or 0)).get("orderId")
        else:
            raise BitgetError(f"bitget {path}: pagination did not finish")
        start = end
    return rows


def _uta_flow_rows(env, path, since_ms, now_ms):
    """v3 records: 30-day windows, `cursor` = the smallest orderId of the last page.
    data is a list (ccxt's recorded replies) or {list, cursor} — both read."""
    rows, start = [], since_ms
    while start < now_ms:
        end = min(start + UTA_FLOW_WINDOW_MS, now_ms)
        cursor = None
        for _ in range(60):
            params = {"startTime": start, "endTime": end, "limit": 100}
            if cursor:
                params["cursor"] = cursor
            data = _get(env, path, params)
            page = data.get("list") if isinstance(data, dict) else data
            if page is None:
                page = []
            if not isinstance(page, list):
                raise BitgetError(f"bitget {path}: unexpected reply {str(data)[:120]}")
            rows += page
            if len(page) < 100:
                break
            cursor = min(page, key=lambda r: int(r.get("orderId") or 0)).get("orderId")
        else:
            raise BitgetError(f"bitget {path}: pagination did not finish")
        start = end
    return rows


def get_flows(env: dict, since: int) -> list:
    """External on-chain deposits / withdrawals since `since` (epoch secs):
    [{ts, direction 'in'|'out', currency, amount (> 0), txid}] ascending. Only
    status success and dest on_chain — dest internal_transfer (Bitget UID to UID)
    and wallet-to-wallet moves are not external money. Withdrawal amount is `size`
    as recorded (whether it includes the fee is a live-verify item). UTA rows carry
    the tx hash as recordId and the time as createdTime."""
    since_ms, now_ms = int(since) * 1000, _now_ms()
    uta = account_mode(env) == "uta"
    if uta:
        paths, fetch = (("/api/v3/account/deposit-records", "in"),
                        ("/api/v3/account/withdrawal-records", "out")), _uta_flow_rows
    else:
        paths, fetch = (("/api/v2/spot/wallet/deposit-records", "in"),
                        ("/api/v2/spot/wallet/withdrawal-records", "out")), _flow_rows
    seen, flows = set(), []
    for path, direction in paths:
        for r in fetch(env, path, since_ms, now_ms):
            rid = (direction, r.get("orderId"))
            if rid in seen:
                continue
            seen.add(rid)
            amt = abs(_num(r.get("size")) or 0.0)
            ts = int(r.get("createdTime") or r.get("cTime") or 0)
            if (str(r.get("status") or "").lower() != "success" or r.get("dest") != "on_chain"
                    or amt <= 0 or ts < since_ms):
                continue
            flows.append({"ts": ts // 1000, "direction": direction,
                          "currency": str(r.get("coin") or "").upper(), "amount": amt,
                          "txid": r.get("tradeId") or r.get("recordId") or str(r.get("orderId") or "")})
    flows.sort(key=lambda f: f["ts"])
    return flows


def account_info(env):
    """/api/v2/spot/account/info (classic): userId, channelCode, authorities (the key's
    permissions), ips — read by get_account_id and the live verify script."""
    info = _get(env, "/api/v2/spot/account/info")
    if not isinstance(info, dict):
        raise BitgetError(f"bitget account info: unexpected reply {str(info)[:120]}")
    return info


def get_account_id(env: dict) -> str:
    """The Bitget UID the key belongs to (a sub-account has its own). UTA: the settings'
    `uid`. An upgrade keeps the UID (a live-verify item: if it did not, the reconciler's
    account check would hold the venue until the user confirms)."""
    if account_mode(env) == "uta":
        uid = uta_settings(env).get("uid")
    else:
        uid = account_info(env).get("userId")
    if not uid:
        raise BitgetError("bitget account info: no uid")
    return str(uid)


# Official (Bitget's common-error-handling page): 40006 invalid access key, 40009 signature,
# 40008 timestamp, 429 rate limit, 40725 / 45001 server-side. Replies ccxt's bitget.py
# records, confirmed or corrected by tests/live_bitget_verify.py R8: 40012 apikey/passphrase
# incorrect, 40037 apikey does not exist, 40014 incorrect permissions, 40018 invalid IP,
# 40015 system abnormal. 40085 (a UTA account on a v2 endpoint) is a mode switch, not a
# key problem: TRANSIENT, the next round reads through v3.
# MODE_UNSUPPORTED is UNKNOWN, not CREDENTIAL: the reconciler HALTs on the first CREDENTIAL,
# and a settings read that blinks mid-upgrade must not stop the machine — a lasting one
# still HALTs after the reconciler's consecutive-failure count, with this message.
_TRANSIENT = {"429", "40725", "45001", "40015", UTA_MODE, MODE_SWITCH}
_CREDENTIAL = {"40006", "40009", "40012", "40014", "40018", "40037"}
_UNKNOWN = TIMESTAMP_CODES | {MODE_UNSUPPORTED, MODE_STUCK, UNVERIFIED}


def classify(exc) -> str:
    """lib.venue_errors TRANSIENT / CREDENTIAL / UNKNOWN for a failed read."""
    if venue_errors is None:
        return None
    return venue_errors.classify(exc, getattr(exc, "code", None), None,
                                 _TRANSIENT, _CREDENTIAL, _UNKNOWN)
