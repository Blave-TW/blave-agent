"""
Capital (群益) Taiwan order execution library — SKCOM COM API, Windows only.

One login covers BOTH markets (same certificate): TAIFEX index futures
(TX00 / MTX00 / TM0000 market orders) and TWSE/TPEx securities (whole-lot
limit/market + intraday odd-lot limit). Taiwan-broker shape follows
lib/order_sinopac.py, NOT lib/order_TEMPLATE.py's perp contract. Companion
references: references/capital-broker.md (structs, report field tables, error
codes — read it before any Capital work) and references/manager.md § Capital
broker exception (service identity).

EXECUTION IDENTITY CONSTRAINT (error 602) — READ BEFORE RUNNING:
SKCOM binds the certificate to the Windows identity that ISSUED it (always
Administrator on Blave Agent machines) and additionally requires a PASSWORD
LOGON: the same code succeeds under NSSM `ObjectName .\\Administrator <pwd>`
or `schtasks /ru Administrator /rp <pwd>`, and fails with 602 under
LocalSystem or a key-auth SSH session (DPAPI cannot unlock the cert's private
key without password-derived credentials — field-verified, see
capital-broker.md Step 2). NEVER call this module from the agent gateway
shell or SSH; route through the NSSM reconciler service or a one-shot
schtasks vehicle (references/manager.md has the exact commands).

Everything below was live-verified 2026-08-14 (uid=1 real account: TM0000
futures round trip, whole-lot + intraday odd-lot stock fills). Design rules:

1. TESTED PATHS ONLY. Cancel (刪單), modify (改價/改量), stop orders, and
   after-hours odd lot (盤後零股, SendStockOddLotOrder) were NOT live-tested
   and raise NotImplementedError — extend only after a user-approved live
   verification, never from the manual alone.
2. UNITS DIFFER PER MARKET. Futures qty is 口數 (lots); whole-lot stock qty
   is 張 (1 lot = 1000 shares, and fill reports come back in SHARES); odd-lot
   qty is raw shares (1–999). All prices/amounts are TWD.
3. SENT ≠ FILLED. ncode 0 + a 13-digit sequence number means the broker
   ACCEPTED the order. Fill confirmation arrives async via OnNewData `D` rows
   matched on our sequence number by value (its column moved between SKCOM
   2.13.58 and 2.13.59 — idx 0 is empty on futures D rows). Confirmation
   timeout returns status 'sent', not an error: a resting ROD limit order is
   normal, and futures IOC may still have filled — query
   reports before resubmitting.
4. REPORT REPLAY + DUPLICATES. SKReplyLib_ConnectByID replays every report
   of the session day on each connect, and TS rows arrive duplicated —
   every OnNewData row is deduped on (its 13-digit seqs, type idx2, exchange
   seq idx30) before use.
5. ALIAS vs RESOLVED CODE. Orders are sent with the near-month alias
   (TM0000), but every report/position carries the RESOLVED contract
   (e.g. TM2608) — reconcile on the resolved code, never the alias.
6. HALTABLE + AUDITED. Every order checks lib/guard's state/HALT before any
   COM call (audit 'order_denied_halt'; closes only inside the user's explicit
   close — lib/guard close pass). Every
   accepted order audits 'order_sent'; rejections 'order_error'; confirmed
   fills 'order_filled'. sNewClose=2 (auto) cannot express intent, so the
   futures function REQUIRES an explicit intent= argument (fail-closed).
7. NO BROKER ATTRIBUTION — 群益 is the broker itself; there is no header /
   client-order-id prefix / aff code to attach (unlike every exchange lib).

Credentials in .env: capital_api_key (身分證字號) + capital_password —
canonical names, see capital-broker.md Step 4 (legacy capital_id accepted).
On a cloud box .env may hold vault sentinels instead; lib/capital_vault.py
resolves them (readable only as Administrator).
COM runs single-threaded apartment: keep every call on the thread that made
the first one (the hand-wired TW reconciler is single-threaded — fine).
"""

import json
import logging
import math
import os
import re
import threading
import time

from lib import capital_vault, guard
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

guard.mark_money_process()  # Stop in the chat never kills this process (lib/guard)

# Touched after every accepted order/confirmed fill: lib/capital_worker.py's
# sleep loop early-ticks on it so the account snapshot (and through the file
# watcher, the user's dashboard) reflects the trade in seconds instead of at
# the next 60s poll. Derived from __file__ (this module IS lib/order_capital.py
# in the same workspace as capital_worker.py), not the BLAVE_AGENT_WORKSPACE
# env var — see capital_worker.py's REFRESH_FLAG comment (audit P2-2).
_REFRESH_FLAG = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                             "state", "capital_refresh")


def _request_snapshot_refresh():
    try:
        with open(_REFRESH_FLAG, "w"):
            pass
        # the worker times its early tick from the mtime; reopening an existing
        # empty file is not guaranteed to move it on every platform
        os.utime(_REFRESH_FLAG, None)
    except OSError:
        pass  # refresh is best-effort; the 60s poll still covers it

# Near-month aliases — the only futures symbols live-tested; month codes like
# TX03 auto-roll surprisingly (see capital-broker.md) and stay unsupported.
FUTURES_ALIASES = {"TX00", "MTX00", "TM0000"}


# COM is Windows-only; deferred so the module still imports for structure
# checks on non-Windows machines (comtypes fails to import there).
comtypes = None
pythoncom = None
sk = None

_session = None
_lock = threading.Lock()


class CapitalError(Exception):
    """Raised when SKCOM rejects an order/call, with the broker's message."""


def _init_com():
    global comtypes, pythoncom, sk
    if sk is not None:
        return
    import comtypes as _comtypes
    import comtypes.client
    import pythoncom as _pythoncom

    _comtypes.client.GetModule(capital_vault.skcom_dll())
    import comtypes.gen.SKCOMLib as _sk

    comtypes, pythoncom, sk = _comtypes, _pythoncom, _sk


class _Events:
    def __init__(self):
        self.futures_accounts = []
        self.stock_accounts = []
        self.seen = set()   # (13-digit seqs in the row, type idx2, exchange seq idx30)
        self.fills = {}     # seq_no -> [fill dicts]
        self.reply_code = None       # SKReplyLib OnConnect nErrorCode; None = no callback (yet)
        self.reply_complete = False  # SKReplyLib OnComplete seen
        self.login_thread = None
        # what reached OnNewData, for the 'sent' log: no rows at all and rows that carry no
        # 13-digit seq are different faults
        self.rows = self.short_rows = self.d_rows = self.d_no_seq = self.d_unfit = 0
        self.d_shapes = set()   # (field count, indexes holding a 13-digit seq) per D row
        self.solace = None      # last OnSolaceReplyConnection / OnSolaceReplyDisconnect

    # SKReplyLib link state (_ISKReplyLibEvents dispid 1/2/3, read from the SKCOM
    # typelib); _ISKOrderLibEvents has no event of these names, so the shared sink
    # only ever gets them from the reply lib. Logged only: whether a missing fill
    # report lines up with a link that was not up yet is what the next live run measures.
    def OnConnect(self, bstrUserID, nErrorCode):
        self.reply_code = nErrorCode
        logging.info(f"capital reply OnConnect code={nErrorCode}")

    def OnDisconnect(self, bstrUserID, nErrorCode):
        self.reply_code, self.reply_complete = None, False
        logging.warning(f"capital reply OnDisconnect code={nErrorCode}")

    def OnComplete(self, bstrUserID):
        self.reply_complete = True
        logging.info("capital reply OnComplete")

    def OnReplyMessage(self, bstrUserID, bstrMessages):
        return -1  # MUST return -1, registered BEFORE login (else code 2017)

    # manual 4-3-a: from v2.13.48 the reply link reports through these, not OnConnect/OnDisconnect
    def OnSolaceReplyConnection(self, bstrUserID, nErrorCode):
        self.solace = f"connect:{nErrorCode}"
        logging.info(f"capital reply OnSolaceReplyConnection code={nErrorCode}")

    def OnSolaceReplyDisconnect(self, bstrUserID, nErrorCode):
        self.solace = f"disconnect:{nErrorCode}"
        logging.warning(f"capital reply OnSolaceReplyDisconnect code={nErrorCode}")

    def OnAccount(self, bstrLogInID, bstrAccountData):
        f = bstrAccountData.split(",")
        acct = f[1] + f[3]
        if f[0] == "TF":
            self.futures_accounts.append(acct)
        elif f[0] == "TS":
            self.stock_accounts.append(acct)

    def OnNewData(self, bstrUserID, bstrData):
        self.rows += 1
        f = bstrData.split(",")
        if len(f) < 46:
            self.short_rows += 1
            return
        # The seq SendFutureOrderCLR/SendStockOrder returned sits at idx45 in the 2.13.58 rows
        # pinned 8/14, while the manual puts SeqNo at idx47 and 2.13.59 appended Timefff after
        # it — match it by value so a layout change cannot drop every fill report silently.
        at = tuple(i for i, x in enumerate(f) if len(x) == 13 and x.isdigit())
        seqs = tuple(sorted({f[i] for i in at}))
        key = (seqs, f[2], f[30])
        if key in self.seen:  # session-day replay + duplicated TS rows
            return
        self.seen.add(key)
        if f[2] != "D":
            return
        self.d_rows += 1
        self.d_shapes.add((len(f), at))
        if not seqs:
            self.d_no_seq += 1
        # columns 8/11/20 are pinned on 2.13.58 only: a row they do not fit is not booked, the
        # order stays unconfirmed and the reconciler parks it instead of booking a wrong fill
        try:
            price, qty = float(f[11] or 0), float(f[20] or 0)
        except ValueError:
            price = qty = 0.0
        if qty <= 0 or (f[1] == "TF" and not CAPITAL_FUT_RE.match(f[8])):
            self.d_unfit += 1
            logging.warning(f"capital fill row not booked: {f[1]} fields={len(f)} seq_at={list(at)} "
                            "— contract/qty columns do not fit")
            return
        logging.info(f"capital fill row: {f[1]} {f[8]} fields={len(f)} seq_at={list(at)}")
        fill = {
            "market": f[1],                                   # TF / TS / TC
            "symbol": f[8],                                   # RESOLVED contract / ticker
            "price": price,
            "qty": qty,                                       # lots (TF) / SHARES (TS, TC)
            "fill_id": f[38],                                 # 成交編號
        }
        for seq in seqs:
            self.fills.setdefault(seq, []).append(fill)

    def diag(self):
        return (f"rows={self.rows} short={self.short_rows} fill_rows={self.d_rows} "
                f"fill_rows_without_seq={self.d_no_seq} fill_rows_unfit={self.d_unfit} fill_shapes={sorted(self.d_shapes)} "
                f"solace={self.solace} reply_code={self.reply_code} complete={self.reply_complete} "
                f"same_thread={self.login_thread == threading.get_ident()}")


class _Session:
    __slots__ = ("center", "reply", "order", "events", "login_id",
                 "futures_account", "stock_account", "_conns")


def _pump_until(cond, timeout):
    deadline = time.time() + timeout
    while not cond() and time.time() < deadline:
        pythoncom.PumpWaitingMessages()
        time.sleep(0.05)
    return cond()


def _get_session(env):
    """Process-wide singleton: one login + report connection, reused. Fails
    loudly at connect time so the 602 identity trap is hit before any order.
    After a lost login (SESSION_LOST_CODES) a failed re-login backs off."""
    global _session
    with _lock:
        if _session is not None:
            return _session
        _load_relogin()
        wait = _relogin["until"] - time.time()
        if wait > 0:
            raise CapitalError(f"群益 login not retried yet: the connection was lost, next try in {int(wait) + 1}s")
        try:
            s = _new_session(env)
        except Exception:
            if _relogin["n"] or _restart["needed"]:
                _arm_relogin_backoff()
            raise
        _relogin.update(n=0, until=0.0)
        _save_relogin()
        _session = s
        return _session


# Desktop app, after a lost login: while the network is down every round with an order would run a
# full Login (CreateObject + up to 12 s of OnAccount pumping) — wait 30 s, doubling to 2 min,
# between attempts; a good login clears it. The cap is short because a stop waits it out once the
# network is back. Armed only by a lost-login code, so a first login and the wake reset retry at
# once as before.
# No shortcut for reduce / close orders: every attempt is a full Login, and the manual's code 9997
# SK_ERROR_LOGIN_FAIL_LIMIT (登入失敗已達五次，請重啟API) would leave this process unable to send
# anything, stops included, until it restarts — more attempts during an outage only bring that
# closer, to save at most 2 min.
RELOGIN_BACKOFF_S, RELOGIN_BACKOFF_MAX_S = 30, 120
# login waits this long for the reply link (OnComplete) before sending anyway;
# flatten logs in too, so the user's close-all pays it once
REPLY_READY_S = 8
_relogin = {"n": 0, "until": 0.0, "loaded": False}
# The backoff outlives the process on the desktop: after 9997 the reconciler exits for a fresh one
# (restart_needed), and that one must not log in again the moment it starts. Same __file__-derived
# state dir as _REFRESH_FLAG.
_RELOGIN_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                             "state", "capital_relogin.json")


def _desktop():
    return os.environ.get("BLAVE_AGENT_LOCAL") == "1"


# A close the user pressed (manager/flatten.py, manager/close_symbol.py) sets OWN_BACKOFF_ENV in its
# own process: 9997 counts per process, so its login must not wait out the reconciler's backoff, and
# its failures must not stretch it. It keeps an in-memory backoff of its own as before.
OWN_BACKOFF_ENV = "BLAVE_CAPITAL_OWN_BACKOFF"


def _shared_backoff():
    return _desktop() and os.environ.get(OWN_BACKOFF_ENV) != "1"


def _load_relogin():
    if _relogin["loaded"]:
        return
    if not _shared_backoff():
        _relogin["loaded"] = True
        return
    try:
        d = load_json(_RELOGIN_PATH, encoding="utf-8")
    except FileNotFoundError:
        _relogin["loaded"] = True
        return
    except OSError:
        return  # still locked after the retries: read it again next time, not "no backoff" for good
    except ValueError:
        _relogin["loaded"] = True
        return
    _relogin["loaded"] = True
    try:
        n, until = int(d["n"]), float(d["until"])
    except (ValueError, KeyError, TypeError, OverflowError):
        return
    # a broken file (inf / nan) or a clock set back must not hold every order, stops included,
    # for longer than one ordinary wait
    if not math.isfinite(until) or n < 0:
        return
    _relogin["n"], _relogin["until"] = min(n, 16), min(until, time.time() + RELOGIN_BACKOFF_MAX_S)


def _save_relogin():
    if not _shared_backoff():
        return
    try:
        if not _relogin["n"]:
            if os.path.exists(_RELOGIN_PATH):
                os.remove(_RELOGIN_PATH)
            return
        tmp = f"{_RELOGIN_PATH}.{os.getpid()}.tmp"  # every order process writes this file
        os.makedirs(os.path.dirname(_RELOGIN_PATH), exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"n": _relogin["n"], "until": _relogin["until"]}, f)
        atomic_replace(tmp, _RELOGIN_PATH)
    except OSError:
        pass  # the in-memory backoff still holds for this process


def _arm_relogin_backoff():
    _relogin["until"] = time.time() + min(RELOGIN_BACKOFF_S * 2 ** _relogin["n"], RELOGIN_BACKOFF_MAX_S)
    _relogin["n"] += 1
    _save_relogin()


# SKCOM manual V2.13.59: 9997 SK_ERROR_LOGIN_FAIL_LIMIT 登入失敗已達五次，請重啟API — no login in
# this process can succeed any more. Desktop app: flag it; the reconciler exits between rounds and
# the daemon starts a fresh one (a new process's login is the path verified on test-4). Cloud
# boxes keep their old behaviour.
LOGIN_LIMIT_CODE = 9997
_restart = {"needed": False}


def restart_needed():
    return _restart["needed"]


def _new_session(env):
    _init_com()
    login_id, password = capital_vault.resolve(env)
    if not login_id or not password:
        raise ValueError("capital_api_key / capital_password missing from .env")
    if (blocked := capital_vault.login_blocked(login_id, password)):
        raise CapitalError(f"login not attempted: 群益 answered code={blocked} to these "
                           "credentials — re-enter the trading password first")

    center = comtypes.client.CreateObject(sk.SKCenterLib, interface=sk.ISKCenterLib)
    reply = comtypes.client.CreateObject(sk.SKReplyLib, interface=sk.ISKReplyLib)
    order = comtypes.client.CreateObject(sk.SKOrderLib, interface=sk.ISKOrderLib)
    events = _Events()
    events.login_thread = threading.get_ident()  # COM events only reach the thread that pumps
    conns = [comtypes.client.GetEvents(reply, events),
             comtypes.client.GetEvents(order, events)]

    capital_vault.set_log_path(center)
    code = center.SKCenterLib_Login(login_id, password)
    capital_vault.record_login(login_id, password, code)
    if code == LOGIN_LIMIT_CODE and _desktop():
        _restart["needed"] = True
    if code not in (0, 2003):
        msg = center.SKCenterLib_GetReturnCodeMessage(code)
        raise CapitalError(
            f"login failed code={code} {msg}"
            + (" — 602 means this process is NOT under a password-logon Administrator "
               "session (NSSM ObjectName / schtasks); see capital-broker.md Step 2"
               if code == 602 else ""))

    if (rc := order.SKOrderLib_Initialize()) != 0:
        raise CapitalError(f"SKOrderLib_Initialize code={rc}")
    if (rc := order.ReadCertByID(login_id)) != 0:
        raise CapitalError(f"ReadCertByID code={rc} (cert/identity — see 602 notes)")

    if (rc := order.GetUserAccount()) != 0:
        raise CapitalError(f"GetUserAccount code={rc}")
    # One OnAccount per account; pump a grace window after the first so a
    # late TS/TF row isn't dropped for the process lifetime.
    _pump_until(lambda: bool(events.futures_accounts or events.stock_accounts), 10)
    grace = time.time() + 2
    while time.time() < grace:
        pythoncom.PumpWaitingMessages()
        time.sleep(0.05)
    if not events.futures_accounts and not events.stock_accounts:
        raise CapitalError("GetUserAccount returned no TF/TS accounts — declaration "
                           "not signed, or no account of that market exists")

    # Order/fill reports; connect replays the whole session day (deduped
    # in _Events). 0 = success.
    if (rc := reply.SKReplyLib_ConnectByID(login_id)) != 0:
        raise CapitalError(f"SKReplyLib_ConnectByID code={rc}")
    # rc 0 = the request went out, not that the link is up. Wait a little for
    # OnComplete, then send anyway: nothing has shown yet that it always fires,
    # and an order whose report never comes is parked by the reconciler.
    t0 = time.time()
    if _pump_until(lambda: events.reply_complete, REPLY_READY_S):
        logging.info(f"capital reply ready in {time.time() - t0:.1f}s (code={events.reply_code})")
    else:
        try:
            linked = reply.SKReplyLib_IsConnectedByID(login_id)
        except Exception as e:
            linked = f"{type(e).__name__}"
        logging.warning(f"capital reply not complete after {REPLY_READY_S}s (code={events.reply_code}, "
                        f"IsConnectedByID={linked}) — sending anyway")

    s = _Session()
    s.center, s.reply, s.order, s.events = center, reply, order, events
    s.login_id = login_id
    s.futures_account = events.futures_accounts[0] if events.futures_accounts else None
    s.stock_account = events.stock_accounts[0] if events.stock_accounts else None
    s._conns = conns
    logging.info(f"capital login OK: TF={s.futures_account} TS={s.stock_account}")
    return s


def reset_session():
    """Drop the singleton so the next call re-logs-in."""
    global _session
    with _lock:
        _session = None


# Return codes that mean THIS login is gone and only a new one helps — SKCOM manual V2.13.59
# (CapitalAPI_2.13.59.zip) return-code table, by its own wording:
#   1000 SK_ERROR_LOGIN_FIRST          請先由Center 進行登入動作
#   1041 SK_ERROR_SERVER_NOT_CONNECTED 與主機尚未連線
#   1108 SK_ERROR_TELNET_SERVER_FAIL   因網路異常，無法連線
#   1109 SK_ERROR_THERE_IS_NO_TOKEN    因登入未取得時效token，請重新登入
# Left out on purpose: 1020 SK_ERROR_LOGIN_INVALID (the table gives no meaning), the 3xxx
# SK_SUBJECT_CONNECTION_* (connection-event subjects, not order return codes), 5xxx (proxy orders,
# unused here). Desktop app only, same reason as the reconciler's wake reset: the in-process
# re-login has not been run on a cloud machine, which keeps its old behaviour.
SESSION_LOST_CODES = frozenset({1000, 1041, 1108, 1109})


# ── order send + confirmation ────────────────────────────────────────────────

def _send(sess, send_fn, fields):
    """Common send path: ncode check, audit, return the 13-digit seq_no."""
    guard.check_restart_stop(fields["intent"], fields)  # backstop; the place_* check first
    msg, ncode = send_fn()
    if ncode != 0:
        err = sess.center.SKCenterLib_GetReturnCodeMessage(ncode)
        guard.audit("order_error", code=ncode, error=err, **fields)
        # these codes refuse the order on this side (no sequence number), so nothing is in flight:
        # the next order logs in again instead of sending through the dead login every round
        if ncode in SESSION_LOST_CODES and _desktop():
            reset_session()
            with _lock:
                _arm_relogin_backoff()
            logging.info(f"capital session dropped after code={ncode}: logging in again in "
                         f"{int(_relogin['until'] - time.time()) + 1}s")
        raise CapitalError(f"order rejected code={ncode}: {err} (msg={msg!r})")
    seq_no = str(msg).strip()
    guard.audit("order_sent", seq_no=seq_no, **fields)
    _request_snapshot_refresh()
    return seq_no


def _await_fill(sess, seq_no, sent_symbol, timeout):
    """Pump OnNewData for `D` rows carrying our seq_no. Returns 'filled' with
    aggregated exchange-reported qty/price, or 'sent' at timeout — the order
    was ACCEPTED (13-digit seq) and may fill later (resting ROD limit) or may
    already have filled unseen; query reports, never blindly resubmit."""
    deadline = time.time() + timeout
    first_fill_at = None
    while time.time() < deadline:
        pythoncom.PumpWaitingMessages()
        if sess.events.fills.get(seq_no):
            if first_fill_at is None:
                first_fill_at = time.time()
            elif time.time() - first_fill_at >= 1.0:
                break  # 1s grace so multi-row partial fills aggregate
        time.sleep(0.05)

    rows = sess.events.fills.get(seq_no, [])
    if not rows:
        return {"seq_no": seq_no, "status": "sent", "symbol": sent_symbol,
                "fill_qty": 0.0, "avg_fill_price": 0.0, "fill_ids": [], "market": None}
    qty = sum(r["qty"] for r in rows)
    avg = sum(r["price"] * r["qty"] for r in rows) / qty if qty else 0.0
    return {"seq_no": seq_no, "status": "filled",
            "symbol": rows[0]["symbol"],       # resolved contract (TM2608), not the alias
            "fill_qty": qty,                   # lots (futures) / SHARES (stocks, both periods)
            "avg_fill_price": avg,
            "fill_ids": [r["fill_id"] for r in rows],
            "market": rows[0]["market"]}


def _diag(sess):
    try:  # a log line must never fail an order the broker already accepted
        return sess.events.diag()
    except Exception as e:
        return type(e).__name__


def _finish(sess, seq_no, symbol, timeout, fields):
    result = _await_fill(sess, seq_no, symbol, timeout)
    if result["status"] == "filled":
        guard.audit("order_filled", seq_no=seq_no, fill_qty=result["fill_qty"],
                    avg_fill_price=result["avg_fill_price"],
                    resolved_symbol=result["symbol"], **fields)
        _request_snapshot_refresh()  # fill may land after the send-time tick
    logging.info(
        f"capital {fields['action']} {symbol} {fields['qty']} {fields['unit']} → "
        f"{result['status']} filled={result['fill_qty']} avg={result['avg_fill_price']:.2f}"
        + ("" if result["status"] == "filled" else f" — reports {_diag(sess)}"))
    return result


# 8/17 live: futures fill reports arrived 15–30 s after the order (8/14: under a
# second). _await_fill's confirm_timeout (15 s) plus its 1 s grace after the first
# row is shorter than that, so a filled IOC came back 'sent' / short — and under
# self_ledger the book counts only what is reported, so the next round bought the
# same lots again. An order that looks short or unconfirmed gets this much longer.
LATE_REPORT_S = 30.0


def _late_rows(sess, r, want, fields):
    """Keep pumping for `want` lots of fill rows on r's seq_no (IOC is final at
    matching; its rows can trickle in apart and late), up to LATE_REPORT_S, then
    re-aggregate. A COM failure in THIS wait returns what was confirmed so far
    with `error` instead of raising. (A COM failure earlier, inside _await_fill,
    still raises as it always did — rows already received there are not
    returned; that path is unchanged by this fix.)"""
    rows = lambda: sess.events.fills.get(r["seq_no"], [])  # noqa: E731
    deadline = time.time() + LATE_REPORT_S
    try:
        while sum(x["qty"] for x in rows()) < want and time.time() < deadline:
            pythoncom.PumpWaitingMessages()
            time.sleep(0.05)
    except Exception as e:
        r = dict(r, error=f"{type(e).__name__}: {e}")
    got = rows()
    qty = sum(x["qty"] for x in got)
    if qty > r["fill_qty"]:
        r = dict(r, status="filled", symbol=got[0]["symbol"], fill_qty=qty, market=got[0]["market"],
                 avg_fill_price=sum(x["price"] * x["qty"] for x in got) / qty, fill_ids=[x["fill_id"] for x in got])
        guard.audit("order_filled", seq_no=r["seq_no"], fill_qty=qty, avg_fill_price=r["avg_fill_price"],
                    resolved_symbol=r["symbol"], late=True, **fields)
        _request_snapshot_refresh()
    if qty < want:
        logging.warning(f"capital {r['seq_no']}: {qty:g}/{want} confirmed after the late wait — "
                        f"reports {_diag(sess)}")
    return r


def _check_halt(fields):
    if fields["intent"] == "entry" and guard.halted():
        guard.audit("order_denied_halt", **fields)
        raise guard.Halted(
            f"state/HALT is set ({guard.halt_info()}) — entry order for "
            f"{fields['symbol']} refused before reaching the broker. Trading is "
            f"paused. Only the user may clear the halt (guard.clear_halt).")


# ── futures ──────────────────────────────────────────────────────────────────

def place_futures_market_order(env, symbol, action, lots, intent, confirm_timeout=15):
    """One futures market order: IOC + price 'M', sNewClose=2 (auto new/close)
    — the exact combination live-verified 2026-08-14 (TM0000 round trip).

    symbol: near-month alias only ('TX00' 大台 / 'MTX00' 小台 / 'TM0000' 微台).
    action: 'buy'|'sell'. lots: 口數 (int ≥ 1).
    intent: REQUIRED, 'entry'|'reduce' — sNewClose=2 can't tell opening from
    closing, so the caller must declare it: under HALT both are refused, but
    'reduce' passes inside the user's explicit close (lib/guard close pass).
    Declaring a real entry as 'reduce' defeats that — don't.

    Returns _await_fill()'s dict; 'filled' carries the RESOLVED contract
    (e.g. TM2608) in 'symbol' — reconcile against that, not the alias.
    An order that looks short or unconfirmed after confirm_timeout waits up to
    LATE_REPORT_S more for late fill rows (_late_rows); still 'sent' after that
    means accepted but unconfirmed — the reconciler records it for the user."""
    if action not in ("buy", "sell"):
        raise ValueError(f"action must be 'buy' or 'sell', got {action!r}")
    if intent not in ("entry", "reduce"):
        raise ValueError(f"intent must be 'entry' or 'reduce', got {intent!r}")
    symbol = str(symbol).upper()
    if symbol not in FUTURES_ALIASES:
        raise ValueError(f"symbol must be a near-month alias {sorted(FUTURES_ALIASES)}, "
                         f"got {symbol!r} — month-specific codes are untested here")
    lots = int(lots)
    if lots < 1:
        raise ValueError(f"lots must be >= 1, got {lots}")

    fields = {"venue": "capital", "market": "futures", "symbol": symbol,
              "action": action, "qty": lots, "unit": "lots", "intent": intent}
    guard.check_restart_stop(fields["intent"], fields)  # before the SKCOM login
    _check_halt(fields)

    sess = _get_session(env)
    if not sess.futures_account:
        raise CapitalError("no TF futures account on this login")

    p = sk.FUTUREORDER()
    p.bstrFullAccount = sess.futures_account
    p.bstrStockNo = symbol
    p.sBuySell = 0 if action == "buy" else 1
    p.sTradeType = 1        # IOC — 'M' market price is only valid with IOC/FOK
    p.bstrPrice = "M"
    p.nQty = lots
    p.sNewClose = 2         # auto 新倉/平倉 — the live-tested setting
    p.sDayTrade = 0
    p.sReserved = 0

    # The reconciler skips its rounds until a snapshot read STARTED settled after
    # this mark — whoever sent the order (flatten included). Stamped again once
    # the whole fill wait (the late-row wait included) is over, then the refresh
    # flag, so the worker's early tick (flag + settle) lands on a read the guard
    # accepts and that read already carries the late fill.
    capital_vault.mark_order_sent()
    try:
        seq_no = _send(sess, lambda: sess.order.SendFutureOrderCLR(sess.login_id, False, p), fields)
        r = _finish(sess, seq_no, symbol, confirm_timeout, fields)
        if r["status"] != "filled" or r["fill_qty"] < lots:
            r = _late_rows(sess, r, lots, fields)
        return r
    finally:
        capital_vault.mark_order_sent()
        _request_snapshot_refresh()


# ── securities ───────────────────────────────────────────────────────────────

def place_stock_order(env, symbol, action, lots, price=None, confirm_timeout=15):
    """One whole-lot (整股, sPeriod=0) stock order, live-verified 2026-08-14.

    lots: 張數 (1 張 = 1000 shares) — fill reports come back in SHARES.
    price: numeric limit price (nSpecialTradeType=2) or None for market
    (nSpecialTradeType=1, bstrPrice '0'). ROD in both cases; a limit order
    resting unfilled returns status 'sent' at timeout — that is not a failure.
    Buys are entries; sells reduce a long-only cash account (sFlag=0 現股).
    Both are HALT-blocked outside a close pass.

    T+2 settlement is NOT pre-checked by the broker (live-verified): an
    unfunded account's buy still fills — remind the user to fund by T+2."""
    if action not in ("buy", "sell"):
        raise ValueError(f"action must be 'buy' or 'sell', got {action!r}")
    lots = int(lots)
    if lots < 1:
        raise ValueError(f"lots must be >= 1, got {lots}")

    fields = {"venue": "capital", "market": "stock", "symbol": symbol,
              "action": action, "qty": lots, "unit": "lots_1000sh",
              "price": price if price is not None else "market",
              "intent": "entry" if action == "buy" else "reduce"}
    guard.check_restart_stop(fields["intent"], fields)  # before the SKCOM login
    _check_halt(fields)

    sess = _get_session(env)
    if not sess.stock_account:
        raise CapitalError("no TS securities account on this login")

    p = sk.STOCKORDER()
    p.bstrFullAccount = sess.stock_account
    p.bstrStockNo = str(symbol)
    p.sPrime = 0            # 上市上櫃
    p.sPeriod = 0           # 盤中
    p.sFlag = 0             # 現股
    p.sBuySell = 0 if action == "buy" else 1
    p.nQty = lots
    p.nTradeType = 0        # ROD
    if price is None:
        p.nSpecialTradeType = 1   # 市價
        p.bstrPrice = "0"
    else:
        p.nSpecialTradeType = 2   # 限價
        p.bstrPrice = str(price)

    # NOT SendStockOrderCLR — the CLR suffix is futures-only (capital-broker.md).
    seq_no = _send(sess, lambda: sess.order.SendStockOrder(sess.login_id, False, p), fields)
    return _finish(sess, seq_no, str(symbol), confirm_timeout, fields)


def place_odd_lot_order(env, symbol, action, shares, price, confirm_timeout=15):
    """One intraday odd-lot (盤中零股, sPeriod=4) LIMIT order, live-verified
    2026-08-14. shares: 1–999. Odd lots are limit-only, so price is required.

    sPeriod=4 needs the FULL struct — omitting nSpecialTradeType rejects with
    1067 (live-measured); nTradeType=0 ROD + nSpecialTradeType=2 限價.
    Matching runs every 5s from 09:10; unfilled orders do NOT carry over to
    the 盤後零股 window. Reports come back under market type 'TC', not 'TS'.
    Buys are entries, sells reduces; both HALT-blocked outside a close pass."""
    if action not in ("buy", "sell"):
        raise ValueError(f"action must be 'buy' or 'sell', got {action!r}")
    shares = int(shares)
    if not 1 <= shares <= 999:
        raise ValueError(f"odd-lot order must be 1-999 shares, got {shares}")
    if price is None:
        raise ValueError("odd-lot orders are limit-only — price is required")

    fields = {"venue": "capital", "market": "stock_odd_lot", "symbol": symbol,
              "action": action, "qty": shares, "unit": "shares", "price": price,
              "intent": "entry" if action == "buy" else "reduce"}
    guard.check_restart_stop(fields["intent"], fields)  # before the SKCOM login
    _check_halt(fields)

    sess = _get_session(env)
    if not sess.stock_account:
        raise CapitalError("no TS securities account on this login")

    p = sk.STOCKORDER()
    p.bstrFullAccount = sess.stock_account
    p.bstrStockNo = str(symbol)
    p.sPrime = 0
    p.sPeriod = 4           # 盤中零股
    p.sFlag = 0
    p.sBuySell = 0 if action == "buy" else 1
    p.nQty = shares         # raw shares for odd lot
    p.nTradeType = 0        # ROD
    p.nSpecialTradeType = 2  # 限價 — required even for sPeriod=4 (error 1067)
    p.bstrPrice = str(price)

    seq_no = _send(sess, lambda: sess.order.SendStockOrder(sess.login_id, False, p), fields)
    return _finish(sess, seq_no, str(symbol), confirm_timeout, fields)


# ── generic close-all support (manager/flatten.py, order_TEMPLATE.py contract) ──
# flatten() calls format_qty()/close_position_partial() on EVERY venue's order
# lib generically (it doesn't distinguish auto-wired crypto from hand-wired TW
# brokers) — added 2026-08-14 after a real close-all attempt on a live 1-lot
# TM2608 position hit AttributeError on both (live-verified: this is what
# actually blocks 「全部出場」, not a hypothetical). Both are thin wrappers
# around place_futures_market_order — no new COM calls, no new untested paths.

# A resolved futures contract is root + YYMM (e.g. "TM2608"). Anchored, not a
# prefix match: 台指選擇權 share the futures account and start with "TX"
# (TXO22000J6, TX122000A6 — strike + month letter + year digit), and a prefix
# match would read them as 大台 and send a real TX00 order. Shared by
# manager/reconciler.py; manager/flatten.py's _CAPITAL_FUT_RE is the same
# pattern and should be collapsed onto this one.
CAPITAL_FUT_RE = re.compile(r"^(MTX|TX|TM)(\d{2})(0[1-9]|1[0-2])$")
# resolved root -> the near-month alias place_futures_market_order takes.
# Mirrors manager/reconciler.py's _CAPITAL_FUTURES_SPEC resolved_prefix table
# — keep the two in sync if either changes.
_RESOLVED_PREFIX_TO_ALIAS = {"TM": "TM0000", "MTX": "MTX00", "TX": "TX00"}


def _alias_for_resolved(symbol):
    m = CAPITAL_FUT_RE.match(str(symbol).upper())
    if m:
        return _RESOLVED_PREFIX_TO_ALIAS[m.group(1)]
    raise ValueError(f"capital: {symbol!r} is not a TXF/MXF/TMF futures contract "
                     f"(root + YYMM) — options and securities close-all are not wired")


def format_qty(env: dict, symbol: str, qty: float, price: float = None) -> str:
    """Futures lots are always whole numbers — no venue-specific step/tick
    table needed (unlike crypto). Raises ValueError (flatten()'s dust-skip
    signal) for anything below 1 lot; never silently floors to 0."""
    lots = float(qty)
    if lots < 1:
        raise ValueError(f"capital: {qty} lots is below the 1-lot minimum")
    return str(int(round(lots)))


def close_position_partial(env: dict, symbol: str, direction: str, qty: float,
                           client_order_id: str = None):
    """Reduce-only close, order_TEMPLATE.py's contract. `symbol` here is the
    RESOLVED contract account_capital.get_positions() reports (e.g. "TM2608"),
    not the alias — translate before calling place_futures_market_order,
    which only accepts near-month aliases. `direction` is the position being
    closed ('long'/'short'); the closing order is the opposite action."""
    alias = _alias_for_resolved(symbol)
    action = "sell" if direction == "long" else "buy"
    lots = int(round(float(qty)))
    if lots < 1:
        raise ValueError(f"capital: {qty} lots is below the 1-lot minimum")
    result = place_futures_market_order(env, alias, action, lots, intent="reduce")
    return {
        "avg_price": result.get("avg_fill_price") or 0.0,
        "executed_qty": result.get("fill_qty") or 0.0,
        "exchange": "capital",
        "resolved_symbol": result.get("symbol"),
        "status": result.get("status"),
    }


# ── not live-verified — deliberately unimplemented ───────────────────────────

_NOT_VERIFIED = ("not live-verified on Capital — do not guess the COM call from the "
                 "manual; run a user-approved live test first (capital-broker.md "
                 "§ Limits & Gotchas: no confirmed simulation environment), then "
                 "implement from the measured behavior.")


def cancel_order(*_args, **_kwargs):
    """刪單."""
    raise NotImplementedError(f"cancel_order is {_NOT_VERIFIED}")


def modify_order(*_args, **_kwargs):
    """改價/改量."""
    raise NotImplementedError(f"modify_order is {_NOT_VERIFIED}")


def place_stop_order(*_args, **_kwargs):
    """停損/移動停損單."""
    raise NotImplementedError(f"place_stop_order is {_NOT_VERIFIED}")


def place_after_hours_odd_lot_order(*_args, **_kwargs):
    """盤後零股 (13:40–14:30, SendStockOddLotOrder — same signature per the
    manual, but untested)."""
    raise NotImplementedError(f"place_after_hours_odd_lot_order is {_NOT_VERIFIED}")
