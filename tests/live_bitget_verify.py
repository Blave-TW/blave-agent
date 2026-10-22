"""Live Bitget verification — a REAL account, run by hand. Not part of tests/run_all.sh.

What it measures is everything lib/order_bitget.py and lib/account_bitget.py take on
faith from Bitget's docs and ccxt's recorded replies (venue-onboarding.md §3). Run on
Wei's MAIN account: it verifies whichever account type that is (R0 says which); the
other type stays unverified (lib/venue_traits verified_modes). Read-only by default; the
order steps need BOTH --trade and --confirm <today's date, UTC, YYYY-MM-DD>, refuse to
start unless the whole account is bare (no position, open order, TP/SL, trigger or
trailing order — exit 3 with the list), print a cost bound and wait for "y" on the
terminal. Every line also goes to the script's own log (--log, default
~/bitget-verify-<UTC time>.log, path printed first): Ctrl-C, a closed window (SIGHUP) or
a kill (SIGTERM) all run the cleanup, which ignores further signals and never stops on
a dead terminal pipe.

MAIN-ACCOUNT SAFETY: every clientOid this process mints starts with PREFIX; every order
over MAX_ORDER_USDT (size × limit price or mark) or without the prefix is refused before
it is signed; every TP/SL cancel (T8, T10, T11, T12, CLEANUP) touches only its own
(prefix, or an id Bitget gave one of its POSTs) — sweep_orphan_stops runs only when every
TP/SL it would cancel is its own; CLEANUP closes legs only on the symbols it traded, in pieces
under the cap; T12 switches the position mode only on a bare account and reads the
original mode back at the end.

    .venv/bin/python tests/live_bitget_verify.py --env ~/bitget-main.env
    .venv/bin/python tests/live_bitget_verify.py --env ... --noop-write          (+ R9 / R10)
    .venv/bin/python tests/live_bitget_verify.py --env ... --trade --confirm 2026-10-21 [--only T1,T5]
    .venv/bin/python tests/live_bitget_verify.py --env ... --watch-switch        (W1, read-only)

The env file holds BITGET_API_KEY / BITGET_SECRET_KEY / BITGET_PASSPHRASE (futures read +
trade only, no withdrawal, no transfer) and must be mode 0600. Runs in a scratch
directory (guard's state/, the mode file and audit land there, never in a workspace);
every request is checked before it is sent — only api.bitget.com, the TWSE quote host
(R7) and Binance's public exchangeInfo (lib/stock_perps) are reachable. Key values never
reach the console.

READ steps (no money moves)
  R0  account mode: the raw v3 settings reply (accountMode, holdMode, uid,
      symbolConfigList) AND the raw v2 futures account list — on a UTA the v2 one must
      answer 40085, on a classic key the v3 one shows the code the lib's probe relies on;
      account_mode(); classic: account info (authorities = the key's permissions, ips) —
      check there is no withdrawal / transfer permission (UTA: in the app's API page)
  R1  clock: serverTime vs ours
  R2  equity: raw account rows + get_equity — compare every row with the app (UTA: the
      USDT asset's equity is the base, usdtEquity also counts other coins; classic: the
      USDT-FUTURES row + all-account-balance)
  R3  positions: raw + get_positions; position mode + margin mode
  R4  holdings: raw rows + get_holdings
  R5  flows: get_flows over 89 days + the raw rows — check amount, fee (does a withdrawal's
      size include it?), time (UTC vs Taipei) and that a wallet-to-wallet transfer is NOT
      listed; an empty account cannot prove the parse
  R6  open orders + open TP/SL; get_account_id
  R7  contract rules for BTC, NVDA, ACN (→ ACNSTOCKUSDT) and the eight Taiwan tokens; the
      minimum order's USDT; each TW token's implied USDTWD = TWSE price ÷ Bitget mark
      (want ≈ the day's rate, 30–35)
  R8  bad secret / bad passphrase / bad key replies: code, HTTP status, classify()
  R9  (--noop-write) cancel a nonexistent order and a nonexistent TP/SL: proves the POST
      signature and measures the "gone" codes (UTA: the lib reads the order back instead)
  R10 (--noop-write, classic only, BTC on cross margin only) set BTC's cross leverage to
      its current value and read it back: a harmless POST
ORDER steps (each the minimum size, ≤ MAX_ORDER_USDT per order; everything is closed at
the end). T1–T4 trade BTC when its minimum + one step fits the cap, else NVDA; run order
T1, T3, T2, T4.
  T1  open the minimum long through place_market_order → raw order detail
  T3  over-close raw (the lib's own side table): close the held size + one step → refused
      (which code), partial, or capped — a reverse leg here means the side table is WRONG: stop
  T2  resend T1's clientOid raw: is a FILLED id rejected (and with which code) or filled again?
  T4  close through close_position_partial (in pieces under the cap) → flat
  T5  NVDA and TWTSM: open + close the minimum through the lib; positions read back under
      the canonical names
  T6  a 33-character and a 50-character clientOid on a resting limit far from the book:
      accepted or refused (the lib allows 32), then cancelled
  T7  limit layer on NVDA: a GTC buy 10% under the bid → open list → get_order →
      cancel_order → get_order → cancel again (gone code); post_only far from the book
      (rests); a crossing post_only (over the ask): refused with a code, or accepted and
      cancelled — if it filled, it is closed
  T8  equity with a position: open NVDA → raw rows / get_equity / positions → TP/SL 20%
      away → raw TP/SL list → cancel_protective_orders → list [] → close
  T9  the real executors on NVDA through lib.execute in a scratch workspace (.env written
      0600 there, removed at the end; residual gate lowered for this run): chase open →
      chase close → TWAP open → TWAP close, one slice each
  T10 a position's TP/SL when the position goes away: open → SL → close → list 3 s later
      ([] = Bitget drops it with the position) → cancel what is left → []
  T11 audit round on NVDA: (a) a short leg with SL/TP, closed through the lib; (b) a
      long (two minimums if they fit the cap) held 90 s, equity / uPnL every 15 s to compare
      with the app, closed in two halves when it can; (c) an SL 0.05% under the mark that
      should fire, then sweep_orphan_stops must cancel the orphan TP; (d) not run on a main
      account (a limit at 5× the margin is far over the cap)
  T12 position mode: only on a bare account, switch one-way ↔ hedge and read it back, open long + open
      short + close both through the lib in the other mode (UTA hedge: closes carry
      reduceOnly yes — a refusal here means flip order_bitget.UTA_HEDGE_REDUCE_ONLY),
      SL/TP on each leg in hedge mode, switch back and read the original mode back (not
      back = "NOT BACK IN THE ORIGINAL MODE", exit 2); --t12-bare-close (UTA, Wei's call)
      also closes the long WITHOUT reduceOnly at exactly its size — the table the lib
      falls back to if Bitget refuses reduceOnly in hedge mode (40774 expected then)
SWITCH step
  W1  (--watch-switch) every 5 s for up to 30 min, print account_mode(), the mode file,
      get_positions() (or its error), session_open('NVDAUSDT') and get_account_id() —
      while a classic account is upgraded to UTA in the app with a small position open.
      Only needed before BOTH account types are verified (with one type verified, a
      switch to the other is refused outright) — not part of the main-account round. Ends with W1 PASS / FAIL / INCONCLUSIVE: FAIL = a positions read without a
      leg held before the switch, session_open True while the hold is open, or a
      changed uid; PASS = the legs read back under UTA, same uid. Read-only step.
  CLEANUP  its own orders and TP/SL on the symbols it traded are cancelled and those
           symbols' legs closed (runs even after a failure); anything not its own is
           listed and left alone; exit 2 if anything of its own is left
Run order: read steps first, compare R2–R5 with the app, then --noop-write, then --trade.
Not covered yet: a resting limit killed with its process and swept at restart, the full
web → reconciler round.
"""
import argparse
import signal
import inspect
import json
import os
import stat
import sys
import tempfile
import time
import traceback
import uuid
from datetime import datetime, timezone
from urllib.parse import urlsplit

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

ALLOWED_HOSTS = {"api.bitget.com", "mis.twse.com.tw", "fapi.binance.com"}
PRODUCT, MARGIN = "USDT-FUTURES", "USDT"
NAMES = ("BITGET_API_KEY", "BITGET_SECRET_KEY", "BITGET_PASSPHRASE")
TW_EXCH = {"3711": "tse", "2303": "tse", "2308": "tse", "2330": "tse", "2408": "tse", "2344": "tse",
           "2327": "tse", "2492": "tse"}
TAKER_FALLBACK = 0.0006


def load_env(path):
    st = os.stat(path)
    if st.st_mode & (stat.S_IRWXG | stat.S_IRWXO):
        sys.exit(f"{path} is readable by others — chmod 600 it first")
    env = {}
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip("'\"")
    missing = [k for k in NAMES if not env.get(k)]
    if missing:
        sys.exit(f"{', '.join(missing)} missing from the env file")
    return env


# ── output that survives a dead pipe ─────────────────────────────────────────
_LOG = {"fh": None}


def open_log(path):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    _LOG["fh"] = os.fdopen(fd, "a", encoding="utf-8")


def emit(line):
    """One line to the script's own log file AND the terminal. Never raises: Ctrl-C under
    `| tee` kills tee first, and a print into the dead pipe must not end the cleanup."""
    fh = _LOG["fh"]
    if fh is not None:
        try:
            fh.write(line + "\n")
            fh.flush()
        except OSError:
            pass
    try:
        print(line, flush=True)
    except OSError:
        pass


def _as_interrupt(signum, frame):
    raise KeyboardInterrupt(f"signal {signum}")


def trap_signals():
    """Closing the terminal (SIGHUP) or a kill (SIGTERM) goes through the same finally as Ctrl-C."""
    for sig in (signal.SIGTERM, getattr(signal, "SIGHUP", None)):
        if sig is not None:
            signal.signal(sig, _as_interrupt)


def shield_signals():
    """First thing in the cleanup: no second Ctrl-C / hang-up / kill may cut it short."""
    for sig in (signal.SIGINT, signal.SIGTERM, getattr(signal, "SIGHUP", None)):
        if sig is not None:
            signal.signal(sig, signal.SIG_IGN)


# ── main-account safety (Wei runs this on his main account, not a sub-account) ──
PREFIX = "bv"  # every clientOid this script's process mints starts with it
MAX_ORDER_USDT = 10.0  # per order, entry or close; a bigger one is refused before it is sent
PLACE_PATHS = ("/api/v2/mix/order/place-order", "/api/v3/trade/place-order")
PLAN_PATHS = ("/api/v2/mix/order/place-tpsl-order", "/api/v3/trade/place-strategy-order")


CLASSIC_PLAN_TYPES = ("normal_plan", "track_plan")  # trigger and trailing orders: their own lists


def classic_plans(env, order, plan_type):
    """Open classic plan orders of one planType (the lib reads only profit_loss)."""
    data = order._send("GET", "/api/v2/mix/order/orders-plan-pending", env,
                       {"productType": "USDT-FUTURES", "planType": plan_type})
    return (data or {}).get("entrustedList") or []


def precheck(env, acct, order):
    """Why the order steps must not start: any position, open order, TP/SL, trigger or
    trailing order on the whole account (Wei's — never touched; a trigger firing mid-run
    would open a leg the cleanup reads as the script's) — or a read that failed (unknown
    is not empty). [] = the account is flat and bare."""
    why = []
    checks = [("position", lambda: [p for p in acct.leg_rows(env) if p["total"] != 0]),
              ("open order", lambda: order.get_open_orders(env)),
              ("open TP/SL", lambda: order.get_open_algo_orders(env))]
    if acct.account_mode(env) == "classic":
        checks += [(f"open {t}", lambda t=t: classic_plans(env, order, t)) for t in CLASSIC_PLAN_TYPES]
    for label, fn in checks:
        try:
            rows = fn()
        except Exception as e:
            why.append(f"{label}s unreadable ({str(e)[:160]}) — cannot prove the account is bare")
            continue
        for r in rows:
            what = r.get("total") or r.get("qty") or r.get("size") or r.get("stop_order_type") or ""
            why.append(f"{label}: {r.get('symbol')} {r.get('side') or ''} {what}".rstrip())
    return why


def own(row, own_ids):
    """An order or TP/SL this script placed: its clientOid carries PREFIX, or Bitget
    answered its POST with this id."""
    return str(row.get("client_order_id") or "").startswith(PREFIX) or str(row.get("order_id")) in own_ids


def prefix_cids(*mods):
    """Every clientOid minted in this process starts with PREFIX (lib/execute's
    fingerprint is a search for rc + digits, so it still matches)."""
    for m in mods:
        mint = m._cid
        if getattr(mint, "_prefixed", False):
            continue
        if inspect.signature(mint).parameters:  # order_bitget._cid(client_order_id=None)
            def wrapped(client_order_id=None, _mint=mint):
                return _mint(client_order_id) if client_order_id else PREFIX + _mint()
        else:
            def wrapped(_mint=mint):
                return PREFIX + _mint()
        wrapped._prefixed = True
        m._cid = wrapped


def install_cap(order, mark_of, own_ids, cap=MAX_ORDER_USDT):
    """Wrap the lib's transport (raw steps go through it too): a place-order whose
    size × price (the limit price, else the mark) is over `cap` USDT is refused before
    it is signed; every order / TP/SL Bitget accepts is remembered as ours."""
    send = order._send
    if getattr(send, "_capped", False):
        return

    def capped(method, path, env, params=None, retries=3):
        body = params or {}
        if method.upper() == "POST" and path in PLACE_PATHS:
            qty = float(body.get("qty") or body.get("size") or 0)
            px = float(body.get("price") or 0) or mark_of(body.get("symbol"))
            if qty * px > cap:
                raise RuntimeError(f"refused by the script: {body.get('symbol')} {qty} × {px} = "
                                   f"{qty * px:.2f} USDT is over the {cap:g} USDT per-order cap")
            if not str(body.get("clientOid") or "").startswith(PREFIX):
                raise RuntimeError(f"refused by the script: clientOid {body.get('clientOid')!r} lacks {PREFIX!r}")
        data = send(method, path, env, params, retries)
        if method.upper() == "POST" and path in PLACE_PATHS + PLAN_PATHS and isinstance(data, dict) \
                and data.get("orderId"):
            own_ids.add(str(data["orderId"]))
        return data

    capped._capped = True
    order._send = capped


def close_chunked(env, order, sym, side, total, step_qty, say, tag, min_qty=0.0):
    """Close `total` of one leg in pieces each under the per-order cap, never leaving a
    tail under the venue minimum (0.08 with pieces of 0.05 and a 0.04 minimum closes as
    0.04 + 0.04). Stops at the first piece the lib does not send. True = all sent."""
    left = total
    while left > 1e-12:
        q = min(left, step_qty)
        if 1e-12 < left - q < min_qty:
            q = left - min_qty if left - min_qty >= min_qty else left
        r = order.close_position_partial(env, sym, side, round(q, 12))
        say(f"{tag} close {side} {q}", r)
        if r is False:
            say(f"{tag} close not sent", f"{side} {q} of {left} left — close it in the app")
            return False
        left -= q
    return True


def cleanup(env, acct, order, touched, own_ids, say, max_qty, min_qty=lambda sym: 0.0):
    """Only what this script made: its own orders / TP/SL (own()) and the legs of the
    symbols it traded — the order steps start only on a bare account (precheck), so
    those legs are its own. Anything else is listed and left alone. Returns the symbols
    not left clean."""
    unclean = []
    for sym in sorted(touched):
        try:
            for o in order.get_open_orders(env, sym):
                if own(o, own_ids):
                    say(f"CLEANUP {sym} cancel order", order.cancel_order(env, sym, order_id=o["order_id"]))
                else:
                    say(f"CLEANUP {sym} NOT OURS, left alone", o)
            for o in order.get_open_algo_orders(env, sym):
                if own(o, own_ids):
                    say(f"CLEANUP {sym} cancel plan",
                        order.cancel_algo_order(env, sym, o["order_id"], o["stop_order_type"]))
                else:
                    say(f"CLEANUP {sym} NOT OURS, left alone", o)
            for p in [p for p in acct.leg_rows(env) if p["total"] != 0
                      and order.canonical_symbol(p["symbol"]) == sym]:
                close_chunked(env, order, sym, p["side"], p["total"], max_qty(sym), say, f"CLEANUP {sym}",
                              min_qty(sym))
            left = [p for p in acct.leg_rows(env) if p["total"] != 0 and order.canonical_symbol(p["symbol"]) == sym]
            mine = [o for o in order.get_open_algo_orders(env, sym) + order.get_open_orders(env, sym)
                    if own(o, own_ids)]
            say(f"CLEANUP {sym} legs (want [])", left)
            if left or mine:
                unclean.append(sym)
        except Exception as e:
            say(f"CLEANUP {sym} FAILED — check and close it in the app", str(e))
            unclean.append(sym)
    return unclean


def cancel_own_plans(env, order, sym, own_ids, say, tag):
    """The script's own TP/SL on `sym`, one by one; anyone else's is listed and kept."""
    for o in order.get_open_algo_orders(env, sym):
        if own(o, own_ids):
            say(f"{tag} cancel own TP/SL", order.cancel_algo_order(env, sym, o["order_id"], o["stop_order_type"]))
        else:
            say(f"{tag} NOT OURS, left alone", o)


def sweep_if_all_own(env, acct, order, own_ids, say, tag):
    """sweep_orphan_stops cancels account-wide: call it only when every TP/SL it would
    touch (a symbol holding nothing) is the script's own."""
    positions = acct.get_positions(env)
    held = {p["symbol"] for p in positions}
    cand = [o for o in order.get_open_algo_orders(env) if o["symbol"] not in held]
    others = [o for o in cand if not own(o, own_ids)]
    if others:
        say(f"{tag} sweep_orphan_stops NOT called — it would cancel TP/SL that are not ours", others)
        return None
    out = order.sweep_orphan_stops(env, positions)
    say(f"{tag} sweep_orphan_stops", out)
    return out


REJECT_HINT = {
    "insufficient_margin": "保證金不足，請先在 App 劃轉 USDT 到 USDT-M 合約帳戶",
    "below_min_size": "低於交易所的最小下單量",
    "symbol_unavailable": "這個幣種現在不能下單（下架、維護或限制 API）",
    "key_permission": "金鑰權限不足或金鑰錯誤（要開合約交易權限）",
}


def failure_line(step, e):
    """One readable line for a step that stopped the run (the venue refused or raised)."""
    msg = str(e)
    kind = next((k for k in REJECT_HINT if f"[order_reject:{k}]" in msg), None)
    code = getattr(e, "code", None)
    why = REJECT_HINT.get(kind) or msg[:200]
    verb = "被拒" if kind or code else "中斷"  # a venue answer vs a dropped connection / local error
    return f"{step or 'order steps'} {verb}：{why}" + (f"（{code}）" if code else "")


def futures_available(env, acct, uta):
    """USDT the trading account can put up as margin now."""
    if uta:
        rows = acct._uta_assets(env).get("assets") or []
        row = next((r for r in rows if r.get("coin") == "USDT"), {})
    else:
        row = acct._futures_row(env) or {}
    return float(row.get("available") or 0)


def restore_mode_after_cleanup(t12_retry, bare, say):
    """T12 left the account in the other position mode (a refused switch back, or its body
    failed with legs open): once the cleanup has made it bare, switch back and read it
    back. True = the original mode is confirmed (or nothing to do)."""
    if not t12_retry:
        return True
    set_mode, read_mode, original = t12_retry
    if read_mode() != original and bare():
        say(f"T12 retry the switch back → {original}", set_mode(original))
    back = read_mode()
    say("T12 mode at the very end (want the original)", {"want": original, "read": back})
    return back == original


def switch_and_restore(set_mode, read_mode, flat, target, say, body):
    """T12: switch the position mode to `target`, read it back, run body(), then switch
    back to the mode read before and read THAT back. Never switches with anything open
    (`flat()`); returns True only when the original mode is confirmed at the end."""
    original = read_mode()
    if original == target:
        say("T12 skipped", f"already in {target}")
        return True
    if not flat():
        say("T12 skipped", "positions, orders or TP/SL are open — the mode only changes on a bare account")
        return True
    say(f"T12 switch {original} → {target}", set_mode(target))
    try:
        now = read_mode()
        say("T12 mode read back", now)
        if now == target:
            body()
        else:
            say("T12 switch did not take", now)
    finally:
        restored = False
        if flat():
            say(f"T12 switch back → {original}", set_mode(original))
            restored = read_mode() == original
            say("T12 mode after switching back (want the original)", {"want": original, "read": read_mode()})
        if not restored:
            say("T12 NOT BACK IN THE ORIGINAL MODE", f"set {original} in the Bitget app by hand")
    return restored


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--env", required=True)
    ap.add_argument("--trade", action="store_true")
    ap.add_argument("--confirm", default="")
    ap.add_argument("--only", default="")
    ap.add_argument("--noop-write", action="store_true")
    ap.add_argument("--watch-switch", action="store_true")
    ap.add_argument("--log", default="", help="the script's own log (default ~/bitget-verify-<UTC time>.log)")
    ap.add_argument("--t12-bare-close", action="store_true",
                    help="T12 hedge: also close one leg WITHOUT reduceOnly (if the side table were wrong this "
                         "opens a reverse leg of the minimum size, closed by CLEANUP)")
    a = ap.parse_args()
    env = load_env(os.path.abspath(a.env))
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    if a.trade and a.confirm != today:
        sys.exit(f"--trade needs --confirm {today} (today, UTC)")
    only = {s.strip().upper() for s in a.only.split(",") if s.strip()}
    secrets = [env[k] for k in NAMES]

    # the JSON-escaped form too: a passphrase with " or \ is written differently inside dumps
    forms = sorted({f for v in secrets for f in (v, json.dumps(v, ensure_ascii=False)[1:-1]) if f},
                   key=len, reverse=True)

    def redact(x):
        s = x if isinstance(x, str) else json.dumps(x, ensure_ascii=False, default=str)
        for f in forms:
            s = s.replace(f, "***")
        return s

    def say(tag, x):
        emit(f"[{tag}] {redact(x)}")

    log_path = os.path.abspath(os.path.expanduser(
        a.log or f"~/bitget-verify-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}.log"))
    open_log(log_path)
    emit(f"log: {log_path} (every line below is also written there)")
    trap_signals()

    os.chdir(tempfile.mkdtemp(prefix="bitget-live-"))
    import requests
    real_send = requests.adapters.HTTPAdapter.send

    def guarded_send(self, req, **kw):
        host = urlsplit(req.url).hostname
        if host not in ALLOWED_HOSTS:
            raise RuntimeError(f"refused: request to {host}")
        return real_send(self, req, **kw)

    requests.adapters.HTTPAdapter.send = guarded_send
    from lib import account_bitget as acct, order_bitget as order, stock_perps
    acct.VERIFIED_MODES = frozenset({"uta", "classic"})  # this script is what verifies it — this process only
    own_ids = set()
    prefix_cids(order)
    install_cap(order, lambda vsym: order.get_mark_price(env, acct.canonical(vsym)), own_ids)

    def raw(method, path, params=None, e=None):
        try:
            return order._send(method, path, e or env, params or {}, retries=1)
        except Exception as ex:
            return {"error": str(ex), "code": getattr(ex, "code", None),
                    "http_status": getattr(ex, "http_status", None)}

    def want(step):
        return not only or step in only

    if want("R0"):
        say("R0 raw v3 settings", raw("GET", "/api/v3/account/settings"))
        say("R0 raw v2 futures accounts (UTA: want 40085)", raw("GET", "/api/v2/mix/account/accounts",
                                                               {"productType": PRODUCT}))
    api = acct.account_mode(env)
    uta = api == "uta"
    say("R0 account_mode", {"mode": api, "mode_file": acct._read_mode()})
    if want("R0") and not uta:
        say("R0 account info (authorities = permissions)", raw("GET", "/api/v2/spot/account/info"))
    if a.watch_switch:
        watch_switch(env, acct, order, say)
        return
    # a scratch state/ is a first read every run: no minimum hold for the R / T steps (W1 keeps it)
    acct.SWITCH_HOLD_S = 0
    acct.get_positions(env)
    if want("R1"):
        t0 = time.time()
        srv = int(requests.get("https://api.bitget.com/api/v2/public/time", timeout=10).json()["data"]["serverTime"])
        say("R1", {"server_ms": srv, "ours_ms": int(t0 * 1000), "skew_ms": srv - int(t0 * 1000)})
    if want("R2"):
        if uta:
            say("R2 raw UTA assets (USDT asset equity = the base)", raw("GET", "/api/v3/account/assets"))
            say("R2 raw UTA funding assets", raw("GET", "/api/v3/account/funding-assets"))
        else:
            say("R2 raw futures accounts", raw("GET", "/api/v2/mix/account/accounts", {"productType": PRODUCT}))
            say("R2 raw all-account-balance", raw("GET", "/api/v2/account/all-account-balance"))
        say("R2 get_equity", acct.get_equity(env))
    if want("R3"):
        if uta:
            say("R3 raw positions", raw("GET", "/api/v3/position/current-position", {"category": PRODUCT}))
        else:
            say("R3 raw positions", raw("GET", "/api/v2/mix/position/all-position",
                                        {"productType": PRODUCT, "marginCoin": MARGIN}))
        say("R3 get_positions", acct.get_positions(env))
        for s in ("BTCUSDT", "NVDAUSDT", "TWTSMUSDT"):
            say(f"R3 {s} modes (api, position mode, margin mode)", order._modes(env, s))
    if want("R4"):
        if uta:
            say("R4 raw UTA assets", raw("GET", "/api/v3/account/assets"))
            say("R4 raw UTA funding assets", raw("GET", "/api/v3/account/funding-assets"))
        else:
            say("R4 raw spot assets", raw("GET", "/api/v2/spot/account/assets"))
            say("R4 raw funding assets", raw("GET", "/api/v2/account/funding-assets"))
        try:
            say("R4 get_holdings", acct.get_holdings(env))
        except Exception as e:
            say("R4 get_holdings raised", str(e))
    if want("R5"):
        now = int(time.time() * 1000)
        span = (29 if uta else 89) * 86400000
        paths = (("/api/v3/account/deposit-records", "/api/v3/account/withdrawal-records") if uta else
                 ("/api/v2/spot/wallet/deposit-records", "/api/v2/spot/wallet/withdrawal-records"))
        for p in paths:
            say(f"R5 raw {p}", raw("GET", p, {"startTime": now - span, "endTime": now, "limit": 20}))
        try:
            say("R5 get_flows (89 days)", acct.get_flows(env, int(time.time()) - 89 * 86400))
        except Exception as e:
            say("R5 get_flows raised", str(e))
    if want("R6"):
        if uta:
            say("R6 open orders", raw("GET", "/api/v3/trade/unfilled-orders", {"category": PRODUCT}))
            say("R6 open TP/SL", raw("GET", "/api/v3/trade/unfilled-strategy-orders",
                                     {"category": PRODUCT, "type": "tpsl"}))
        else:
            say("R6 open orders", raw("GET", "/api/v2/mix/order/orders-pending", {"productType": PRODUCT}))
            say("R6 open TP/SL plans", raw("GET", "/api/v2/mix/order/orders-plan-pending",
                                           {"productType": PRODUCT, "planType": "profit_loss"}))
        try:
            say("R6 get_account_id", acct.get_account_id(env))
        except Exception as e:
            say("R6 get_account_id raised", str(e))
    if want("R7"):
        for s in ["BTCUSDT", "NVDAUSDT", "ACNUSDT"] + sorted(stock_perps.TW_TOKENS.values()):
            try:
                r = order.get_contract_rules(env, s)
                px = order.get_mark_price(env, s)
                say("R7", {s: order.venue_symbol(s), **r, "mark": px,
                           "min_order_usdt": round(max(r["min_qty"] * px, r["min_notional"]), 4)})
            except Exception as e:
                say(f"R7 {s} REFUSED", str(e))
        for code, vs in sorted(stock_perps.TW_TOKENS.items()):
            try:
                q = requests.get("https://mis.twse.com.tw/stock/api/getStockInfo.jsp",
                                 params={"ex_ch": f"{TW_EXCH[code]}_{code}.tw", "json": "1"}, timeout=10).json()
                row = (q.get("msgArray") or [{}])[0]
                twd = float(row.get("z") if row.get("z") not in (None, "-") else row.get("y"))
                mark = order.get_mark_price(env, vs)
                say("R7 TW basis", {"code": code, "name": row.get("n"), "contract": vs, "twd": twd,
                                    "bitget_mark": mark, "implied_usdtwd": round(twd / mark, 3)})
            except Exception as e:
                say(f"R7 TW basis {code} unreadable", str(e))
    if want("R8"):
        for label, k in (("bad secret", "BITGET_SECRET_KEY"), ("bad passphrase", "BITGET_PASSPHRASE"),
                         ("bad key", "BITGET_API_KEY")):
            bad = {**env, k: "x" * 32}
            try:
                acct.get_equity(bad)
                say(f"R8 {label}", "accepted — Bitget did not reject it")
            except Exception as e:
                say(f"R8 {label}", {"error": str(e), "code": getattr(e, "code", None),
                                    "http_status": getattr(e, "http_status", None), "classify": acct.classify(e)})
    if a.noop_write and want("R9") and uta:
        say("R9 UTA cancel a nonexistent order (the 'gone' code; 40009 = POST signature wrong)",
            raw("POST", "/api/v3/trade/cancel-order", {"category": PRODUCT, "orderId": "1"}))
        say("R9 UTA cancel a nonexistent TP/SL", raw("POST", "/api/v3/trade/cancel-strategy-order", {"orderId": "1"}))
        say("R9 UTA order-info of a nonexistent order", raw("GET", "/api/v3/trade/order-info", {"orderId": "1"}))
        say("R9 lib cancel_order on it (want order_not_found)", order.cancel_order(env, "BTCUSDT", order_id="1"))
    if a.noop_write and want("R9") and not uta:
        say("R9 cancel a nonexistent order (want a 'does not exist' code; 40009 = POST signature wrong)",
            raw("POST", "/api/v2/mix/order/cancel-order",
                {"symbol": "BTCUSDT", "productType": PRODUCT, "marginCoin": MARGIN, "orderId": "1"}))
        say("R9 cancel a nonexistent plan order",
            raw("POST", "/api/v2/mix/order/cancel-plan-order",
                {"orderIdList": [{"orderId": "1"}], "symbol": "BTCUSDT", "productType": PRODUCT,
                 "marginCoin": MARGIN, "planType": "pos_loss"}))
    if a.noop_write and want("R10") and not uta:
        cur = raw("GET", "/api/v2/mix/account/account",
                  {"symbol": "BTCUSDT", "productType": PRODUCT, "marginCoin": MARGIN})
        lev = cur.get("crossedMarginLeverage") if isinstance(cur, dict) else None
        if not isinstance(cur, dict) or cur.get("marginMode") != "crossed":
            say("R10 skipped — BTC is not on cross margin (the isolated leverage would change)",
                cur.get("marginMode") if isinstance(cur, dict) else cur)
        elif lev:
            say("R10 POST leverage = same value", raw("POST", "/api/v2/mix/account/set-leverage", {
                "symbol": "BTCUSDT", "productType": PRODUCT, "marginCoin": MARGIN, "leverage": str(lev)}))
            after = raw("GET", "/api/v2/mix/account/account",
                        {"symbol": "BTCUSDT", "productType": PRODUCT, "marginCoin": MARGIN})
            now = after.get("crossedMarginLeverage") if isinstance(after, dict) else after
            say("R10 leverage before / after", {"before": lev, "after": now,
                                                "isolated before": [cur.get("isolatedLongLever"),
                                                                    cur.get("isolatedShortLever")],
                                                "isolated after": [after.get("isolatedLongLever"),
                                                                   after.get("isolatedShortLever")]
                                                if isinstance(after, dict) else None})
            if str(now) != str(lev):
                say("R10 WARNING — the leverage CHANGED; setting it back", raw(
                    "POST", "/api/v2/mix/account/set-leverage",
                    {"symbol": "BTCUSDT", "productType": PRODUCT, "marginCoin": MARGIN, "leverage": str(lev)}))
                back = raw("GET", "/api/v2/mix/account/account",
                           {"symbol": "BTCUSDT", "productType": PRODUCT, "marginCoin": MARGIN})
                back = back.get("crossedMarginLeverage") if isinstance(back, dict) else back
                emit(f"!!! R10: BTC cross leverage was {lev}, read {now} after the POST, {back} after setting it back"
                     f"{'' if str(back) == str(lev) else ' — NOT RESTORED: set it in the Bitget app'} !!!")
        else:
            say("R10 skipped — no cross leverage read", cur)

    if not a.trade:
        emit("read steps done; order steps not run (no --trade)")
        return

    def rc():
        return PREFIX + "rc" + uuid.uuid4().hex[:16]

    def max_qty(sym):
        """The largest qty on the step that stays under the per-order cap."""
        r = order.get_contract_rules(env, sym)
        return float(order._floor_str(MAX_ORDER_USDT * 0.95 / order.get_mark_price(env, sym), r["step"]))

    def min_qty(sym):
        return float(order.get_contract_rules(env, sym)["min_qty"])

    why = precheck(env, acct, order)
    if why:
        emit("\nOrder steps NOT run — this account is not bare (they never touch what is already there):")
        for w in why:
            emit(f"  - {w}")
        emit("Close every futures position and cancel every order, TP/SL, trigger and trailing order in the "
             "Bitget app, then rerun. The read-only and --noop-write steps above are unaffected.")
        sys.exit(3)

    def minimum(sym, k=1.0):
        """The smallest qty that clears both the size and the 5 USDT minimums (× k), on the step."""
        r = order.get_contract_rules(env, sym)
        px = order.get_mark_price(env, sym)
        need = max(r["min_qty"], r["min_notional"] * 1.1 / px) * k
        step = float(r["step"])
        return float(order._floor_str(need + step * 0.999999, r["step"]))

    def legs(sym=None):
        # lib rows ({'symbol','side','total',...}): an unreadable read raises, never reads as flat
        vs = order.venue_symbol(sym) if sym else None
        return [p for p in acct.leg_rows(env) if p["total"] != 0 and (vs is None or p["symbol"] == vs)]

    def held(sym, side):
        return sum(p["total"] for p in legs(sym) if p["side"] == side)

    def mode_of(sym):
        return order._modes(env, order.venue_symbol(sym))

    def raw_order(sym, direction, qty_str, reduce_only=False, order_type="market", price=None, force=None,
                  cid=None):
        """One order sent RAW (no lib checks) with the lib's own body and side table."""
        api_, pm, mm = mode_of(sym)
        body = order._order_body(api_, order.venue_symbol(sym), order.Decimal(qty_str), order_type, cid or rc(),
                                 order._sides(direction, reduce_only, pm, api_), mm, price=price, force=force)
        return raw("POST", "/api/v3/trade/place-order" if api_ == "uta" else "/api/v2/mix/order/place-order", body)

    def raw_detail(sym, **ident):
        if uta:
            return raw("GET", "/api/v3/trade/order-info", ident)
        return raw("GET", "/api/v2/mix/order/detail", {"symbol": order.venue_symbol(sym), "productType": PRODUCT,
                                                      **ident})

    def raw_rows():
        if uta:
            return raw("GET", "/api/v3/account/assets")
        return raw("GET", "/api/v2/mix/account/accounts", {"productType": PRODUCT})

    def raw_plans(sym):
        if uta:
            return raw("GET", "/api/v3/trade/unfilled-strategy-orders", {"category": PRODUCT, "type": "tpsl"})
        return raw("GET", "/api/v2/mix/order/orders-plan-pending",
                   {"productType": PRODUCT, "planType": "profit_loss", "symbol": order.venue_symbol(sym)})

    # cost bound: every round trip the selected steps make, at the taker fee + the spread
    base = None  # T3's over-close (the minimum + one step) must fit under the per-order cap
    for cand in ("BTCUSDT", "NVDAUSDT"):
        if (minimum(cand) + float(order.get_contract_rules(env, cand)["step"])) \
                * order.get_mark_price(env, cand) <= MAX_ORDER_USDT:
            base = cand
            break
    plan = []
    if base and any(want(t) for t in ("T1", "T2", "T3", "T4")):
        plan += [(base, minimum(base), 2)]  # T2 may fill a second time
    if want("T5"):
        plan += [("NVDAUSDT", minimum("NVDAUSDT"), 1), ("TWTSMUSDT", minimum("TWTSMUSDT"), 1)]
    if want("T7"):
        plan += [("NVDAUSDT", minimum("NVDAUSDT"), 1)]  # a crossing post_only that fills
    for t, k, n in (("T8", 1, 1), ("T9", 1, 2), ("T10", 1, 1), ("T11", 1, 3), ("T12", 1, 1)):
        if want(t):
            plan += [("NVDAUSDT", minimum("NVDAUSDT", k), n)]
    fee = spread = peak = 0.0
    for sym, qty, n in plan:
        px = order.get_mark_price(env, sym)
        bbo = order.get_bbo(env, sym)
        fee += qty * px * 2 * TAKER_FALLBACK * n
        spread += qty * (bbo["ask"] - bbo["bid"]) * n
        peak = max(peak, qty * px)
    need = 2 * peak  # T12 holds a long and a short at once
    avail = futures_available(env, acct, uta)
    if avail < need:
        emit(f"\nOrder steps NOT run — the {'unified' if uta else 'USDT-M futures'} account has {avail:.2f} USDT "
             f"available, below {need:.2f} (twice the largest order, {peak:.2f}).")
        emit(f"先在 Bitget App 把至少 {max(20.0, need):.0f} USDT 劃轉到 "
             f"{'統一帳戶' if uta else 'USDT-M 合約帳戶'}，再重跑。金鑰沒有劃轉權限，腳本做不到這一步。")
        sys.exit(3)
    emit(f"\n{sum(n for *_, n in plan)} round trips, one position at a time; largest notional "
          f"{peak:.2f} USDT; every single order is capped at {MAX_ORDER_USDT:g} USDT (refused before it is sent).")
    emit(f"T1–T4 trade {base}." if base else "T1–T4 NOT run: neither BTC's nor NVDA's minimum + one step fits the cap.")
    emit("Do not trade on this Bitget account until the script ends.")
    emit(f"Fees (taker {TAKER_FALLBACK:.2%} each side): <= {fee:.4f} USDT")
    emit(f"Spread crossed:                     <= {spread:.4f} USDT")
    emit(f"Estimated cost upper bound:         <= {fee + spread:.4f} USDT (+ price moves inside each round trip; "
          f"T11c's stop-loss may close a few seconds late)")
    try:
        ans = input("Type y to place these orders: ").strip()
    except EOFError:
        ans = ""
    if ans != "y":
        emit("not confirmed — no order placed")
        return

    touched = set()
    t12_retry = None
    cur = {"step": None}
    failed = None
    not_tradable = {}
    try:
        if any(want(t) for t in ("T1", "T2", "T3", "T4")) and not base:
            say("T1-T4 skipped", "no symbol's minimum + one step fits under the per-order cap")
        if base and any(want(t) for t in ("T1", "T2", "T3", "T4")):
            cur["step"] = "T1–T4"
            touched.add(base)
            q = minimum(base)
            step = float(order.get_contract_rules(env, base)["step"])
            cid = rc()
            if want("T1"):
                cur["step"] = "T1"
                say("T1 place_market_order", order.place_market_order(env, base, "long", q, client_order_id=cid))
                say("T1 raw detail", raw_detail(base, clientOid=cid))
                say("T1 legs", legs(base))
            if want("T3"):  # before T2: the over-close is held + one step, under the cap
                cur["step"] = "T3"
                h = held(base, "long")
                say("T3 modes", mode_of(base))
                say("T3 over-close (held + one step)", raw_order(
                    base, "long", order._floor_str(h + step, order.get_contract_rules(env, base)["step"]),
                    reduce_only=True))
                time.sleep(2)
                say("T3 legs (a short leg = the side table is WRONG — stop and report)", legs(base))
            if want("T2"):
                cur["step"] = "T2"
                say("T2 resend the filled clientOid", raw_order(base, "long", format(q, "f"), cid=cid))
                time.sleep(2)
                say("T2 legs (one more of T1's size = a filled id is NOT deduplicated)", legs(base))
            if want("T4"):
                cur["step"] = "T4"
                for p in legs(base):
                    close_chunked(env, order, base, p["side"], p["total"], max_qty(base), say, "T4", min_qty(base))
                say("T4 legs (want [])", legs(base))
        if want("T5"):
            cur["step"] = "T5"
            for sym in ("NVDAUSDT", "TWTSMUSDT"):
                touched.add(sym)
                q = minimum(sym)
                try:
                    opened = order.place_market_order(env, sym, "long", q)
                except acct.BitgetError as e:
                    if e.code != acct.ELIGIBILITY:
                        raise
                    # Bitget withholds this product from this account (region / eligibility): a
                    # measurement, not a failure — the remaining steps trade NVDA / BTC only
                    not_tradable[sym] = str(e)
                    say(f"T5 {sym} NOT TRADABLE ON THIS ACCOUNT (40092) — skipped", str(e))
                    continue
                say(f"T5 {sym} open {q}", opened)
                say(f"T5 {sym} get_positions (canonical name)", [p for p in acct.get_positions(env)
                                                                if p["symbol"] == sym])
                say(f"T5 {sym} close", order.close_position_partial(env, sym, "long", q))
                say(f"T5 {sym} legs (want [])", legs(sym))
        if want("T6") or want("T7"):
            cur["step"] = "T6/T7"
            touched.add("NVDAUSDT")
            q = minimum("NVDAUSDT")
            bbo = order.get_bbo(env, "NVDAUSDT")
            say("T6/T7 book", bbo)

            def limit(tag, price, force="gtc", cid=None):
                r = raw_order("NVDAUSDT", "long", format(q, "f"), order_type="limit", price=price, force=force,
                              cid=cid)
                say(f"{tag} place", r)
                return r.get("orderId") if isinstance(r, dict) else None

            far = order.format_price(env, "NVDAUSDT", bbo["bid"] * 0.9)
            if want("T6"):
                for n in (33, 50):
                    oid = limit(f"T6 {n}-char clientOid", far, cid=(PREFIX + uuid.uuid4().hex * 2)[:n])
                    if oid:
                        say(f"T6 {n} cancel", order.cancel_order(env, "NVDAUSDT", order_id=oid))
            if want("T7"):
                oid = limit("T7a GTC 10% under the bid", far)
                say("T7a open orders", order.get_open_orders(env, "NVDAUSDT"))
                if oid:
                    say("T7a get_order", order.get_order(env, "NVDAUSDT", order_id=oid))
                    say("T7a cancel_order", order.cancel_order(env, "NVDAUSDT", order_id=oid))
                    time.sleep(1)
                    say("T7a get_order after cancel", order.get_order(env, "NVDAUSDT", order_id=oid))
                    if uta:
                        say("T7a cancel again (gone code?)", raw("POST", "/api/v3/trade/cancel-order",
                                                                 {"category": PRODUCT, "orderId": oid}))
                    else:
                        say("T7a cancel again (gone code?)", raw("POST", "/api/v2/mix/order/cancel-order", {
                            "symbol": "NVDAUSDT", "productType": PRODUCT, "marginCoin": MARGIN, "orderId": oid}))
                oid = limit("T7b post_only far from the book", far, "post_only")
                if oid:
                    say("T7b detail (want live)", raw_detail("NVDAUSDT", orderId=oid))
                    say("T7b cancel", order.cancel_order(env, "NVDAUSDT", order_id=oid))
                cross = order.format_price(env, "NVDAUSDT", bbo["ask"] * 1.01, buy=False)
                oid = limit("T7c post_only crossing (over the ask)", cross, "post_only")
                time.sleep(2)
                if oid:
                    say("T7c detail (state / cancelReason)", raw_detail("NVDAUSDT", orderId=oid))
                say("T7c legs (a leg = post_only took liquidity)", legs("NVDAUSDT"))
                for p in legs("NVDAUSDT"):  # it filled: close now, T8 reads equity on its own leg
                    close_chunked(env, order, "NVDAUSDT", p["side"], p["total"], max_qty("NVDAUSDT"), say, "T7c",
                                  min_qty("NVDAUSDT"))
                say("T7d place_limit_order post_only crossing through the lib (want post_only_rejected)",
                    order.place_limit_order(env, "NVDAUSDT", "long", q, cross, post_only=True))
        if want("T8"):
            cur["step"] = "T8"
            touched.add("NVDAUSDT")
            q = minimum("NVDAUSDT")
            say("T8 open", order.place_market_order(env, "NVDAUSDT", "long", q))
            say("T8 raw account rows (with a position)", raw_rows())
            say("T8 get_equity", acct.get_equity(env))
            say("T8 get_positions", acct.get_positions(env))
            last = order.get_mark_price(env, "NVDAUSDT")
            say("T8 SL -20% / TP +20%", order.place_protective_orders(env, "NVDAUSDT", "long",
                                                                       sl_price=last * 0.8, tp_price=last * 1.2))
            say("T8 raw TP/SL list", raw_plans("NVDAUSDT"))
            cancel_own_plans(env, order, "NVDAUSDT", own_ids, say, "T8")
            say("T8 plan list after cancel (want [])", order.get_open_algo_orders(env, "NVDAUSDT"))
            say("T8 close", order.close_position_partial(env, "NVDAUSDT", "long", q))
        if want("T9"):
            cur["step"] = "T9"
            touched.add("NVDAUSDT")
            import threading
            from lib import execute as ex, venue_wiring as vw
            if not os.path.exists("lib"):
                os.symlink(os.path.join(ROOT, "lib"), "lib")  # venue discovery checks lib/account_<id>.py under cwd
            fd = os.open(".env", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as fh:
                fh.write("".join(f"{k}={env[k]}\n" for k in NAMES))
            try:  # the .env holds the three key values: gone the moment T9 is done
                prefix_cids(vw)  # the executors' clientOids come from lib.venue_wiring._cid
                ex._RESIDUAL_USD = 0.001
                ex._own_only = vw._own_only = lambda: False
                vw._NON_AUTO = vw._NON_AUTO - {"bitget"}  # not auto-wired until verified: this run only
                ex._notify_fn = lambda m: say("T9 notify", m)
                say("T9 venue", vw.detect_venue(vw.read_env()))
                usd = minimum("NVDAUSDT") * order.get_mark_price(env, "NVDAUSDT")

                def jsonl_tail(path):
                    try:
                        return open(path).read().splitlines()[-1]
                    except (OSError, IndexError):
                        return None

                for tag, signed, reduce_only in (("chase open", usd, False), ("chase close", -usd, True)):
                    ex._chase_thread("NVDAUSDT", signed, None, reduce_only, "bitget", [],
                                     vw.auto_limit_toolkit("NVDAUSDT", reduce_only), threading.Event())
                    say(f"T9 {tag} orders.jsonl", jsonl_tail("manager/orders.jsonl"))
                    say(f"T9 {tag} legs", legs("NVDAUSDT"))
                    say(f"T9 {tag} open orders (want [])", order.get_open_orders(env, "NVDAUSDT"))
                for tag, signed, reduce_only in (("twap open", usd, False), ("twap close", -usd, True)):
                    ex._twap_thread("NVDAUSDT", signed, None, reduce_only, "bitget", [], 1, 1, threading.Event())
                    say(f"T9 {tag} orders.jsonl", jsonl_tail("manager/orders.jsonl"))
                    twap = sorted(os.listdir("manager/twap")) if os.path.isdir("manager/twap") else []
                    say(f"T9 {tag} twap summary", [jsonl_tail(os.path.join("manager/twap", f)) for f in twap])
                    say(f"T9 {tag} legs", legs("NVDAUSDT"))
            finally:
                if os.path.exists(".env"):
                    os.remove(".env")
        if want("T10"):
            cur["step"] = "T10"
            touched.add("NVDAUSDT")
            q = minimum("NVDAUSDT")
            say("T10 open", order.place_market_order(env, "NVDAUSDT", "long", q))
            last = order.get_mark_price(env, "NVDAUSDT")
            say("T10 SL -20%", order.place_protective_orders(env, "NVDAUSDT", "long", sl_price=last * 0.8))
            say("T10 plan list with the position", order.get_open_algo_orders(env, "NVDAUSDT"))
            say("T10 close", order.close_position_partial(env, "NVDAUSDT", "long", q))
            time.sleep(3)
            left = order.get_open_algo_orders(env, "NVDAUSDT")
            say("T10 plan list 3 s after the close ([] = Bitget drops it with the position)", left)
            if left:
                cancel_own_plans(env, order, "NVDAUSDT", own_ids, say, "T10")
            say("T10 plan list at the end (want [])", order.get_open_algo_orders(env, "NVDAUSDT"))
        if want("T11"):
            cur["step"] = "T11"
            touched.add("NVDAUSDT")
            q = minimum("NVDAUSDT")
            plans = lambda: order.get_open_algo_orders(env, "NVDAUSDT")
            say("T11a short open", order.place_market_order(env, "NVDAUSDT", "short", q))
            last = order.get_mark_price(env, "NVDAUSDT")
            say("T11a short SL +20% / TP -20%", order.place_protective_orders(
                env, "NVDAUSDT", "short", sl_price=last * 1.2, tp_price=last * 0.8))
            say("T11a plan list (want two)", plans())
            say("T11a short close", order.close_position_partial(env, "NVDAUSDT", "short", q))
            time.sleep(3)
            say("T11a plan list after the close", plans())
            sweep_if_all_own(env, acct, order, own_ids, say, "T11a")
            say("T11a plan list after the sweep (want [])", plans())

            big = minimum("NVDAUSDT", 2)
            if big * order.get_mark_price(env, "NVDAUSDT") > MAX_ORDER_USDT:
                big = minimum("NVDAUSDT")  # two minimums do not fit under the cap: one leg, closed in one go
            say(f"T11b open {big}", order.place_market_order(env, "NVDAUSDT", "long", big))
            for i in range(7):
                if i:
                    time.sleep(15)
                pos = legs("NVDAUSDT")
                say(f"T11b {datetime.now(timezone.utc).strftime('%H:%M:%S')} UTC compare with the app",
                    {"get_equity": acct.get_equity(env)["equity"], "uPnL": [p.get("upnl") for p in pos],
                     "raw_rows": raw_rows()})
            half = float(order._floor_str(big / 2, order.get_contract_rules(env, "NVDAUSDT")["step"]))
            if half >= minimum("NVDAUSDT"):
                say("T11b partial close", order.close_position_partial(env, "NVDAUSDT", "long", half))
                say("T11b legs (want the rest)", legs("NVDAUSDT"))
            say("T11b close the rest", order.close_position_partial(env, "NVDAUSDT", "long", held("NVDAUSDT", "long")))
            say("T11b legs (want [])", legs("NVDAUSDT"))

            say("T11c open", order.place_market_order(env, "NVDAUSDT", "long", q))
            last = order.get_mark_price(env, "NVDAUSDT")
            say("T11c SL 0.05% under / TP +20%", order.place_protective_orders(
                env, "NVDAUSDT", "long", sl_price=last * 0.9995, tp_price=last * 1.2))
            fired = False
            for _ in range(36):
                time.sleep(5)
                if not legs("NVDAUSDT"):
                    fired = True
                    break
            if not fired:
                say("T11c SL did not fire in 180 s — closing with a raw order the lib does not see",
                    raw_order("NVDAUSDT", "long", format(q, "f"), reduce_only=True))
                time.sleep(2)
            say("T11c fired on the venue" if fired else "T11c simulated", {"legs": legs("NVDAUSDT")})
            say("T11c plan list before the sweep (an orphan TP, or [] if Bitget dropped it)", plans())
            sweep_if_all_own(env, acct, order, own_ids, say, "T11c")
            say("T11c plan list after the sweep (want [])", plans())

            say("T11d not run", "a limit sized at 5× the margin is far over the per-order cap on a main account")
        if want("T12"):
            cur["step"] = "T12"
            touched.add("NVDAUSDT")
            names = {"oneway": "one_way_mode", "hedge": "hedge_mode"}

            def set_mode(m):
                if uta:
                    return raw("POST", "/api/v3/account/set-hold-mode", {"holdMode": names[m]})
                return raw("POST", "/api/v2/mix/account/set-position-mode", {"productType": PRODUCT, "posMode": names[m]})

            def t12_body():
                q = minimum("NVDAUSDT")
                say("T12 open long", order.place_market_order(env, "NVDAUSDT", "long", q))
                say("T12 open short", order.place_market_order(env, "NVDAUSDT", "short", q))
                say("T12 legs (hedge: two legs; one-way: flat)", legs("NVDAUSDT"))
                if mode_of("NVDAUSDT")[1] == "hedge":
                    last = order.get_mark_price(env, "NVDAUSDT")
                    for d, sl, tp in (("long", 0.8, 1.2), ("short", 1.2, 0.8)):
                        say(f"T12 hedge {d} SL/TP", order.place_protective_orders(
                            env, "NVDAUSDT", d, sl_price=last * sl, tp_price=last * tp))
                    say("T12 hedge TP/SL list (want four, each on its own leg)", raw_plans("NVDAUSDT"))
                    cancel_own_plans(env, order, "NVDAUSDT", own_ids, say, "T12")
                    if a.t12_bare_close and uta:
                        # the table without the reduceOnly safety (what runs if UTA_HEDGE_REDUCE_ONLY
                        # has to go): close the long, exactly its size
                        order.UTA_HEDGE_REDUCE_ONLY = False
                        try:
                            h = held("NVDAUSDT", "long")
                            say("T12 bare close long (sell + posSide long, no reduceOnly)",
                                raw_order("NVDAUSDT", "long", format(h, "f"), reduce_only=True))
                            time.sleep(2)
                            say("T12 legs after the bare close (want: the short only; a second short or "
                                "a bigger one = the table is WRONG)", legs("NVDAUSDT"))
                        finally:
                            order.UTA_HEDGE_REDUCE_ONLY = True
                for p in legs("NVDAUSDT"):
                    close_chunked(env, order, "NVDAUSDT", p["side"], p["total"], max_qty("NVDAUSDT"), say, "T12",
                                  min_qty("NVDAUSDT"))
                say("T12 legs (want [])", legs("NVDAUSDT"))

            pm = mode_of("NVDAUSDT")[1]
            read_pm = lambda: mode_of("NVDAUSDT")[1]  # noqa: E731
            if a.t12_bare_close and not uta:
                say("T12 note", "--t12-bare-close only applies to a UTA account — ignored here")
            t12_retry = (set_mode, read_pm, pm)  # held until the original mode is read back (the body may raise)
            if switch_and_restore(set_mode, read_pm, lambda: not precheck(env, acct, order),
                                  "hedge" if pm == "oneway" else "oneway", say, t12_body):
                t12_retry = None
    except Exception as e:  # a refused or failed order: clean up, then say why, no traceback
        failed = failure_line(cur["step"], e)
        say("STOPPED", f"{cur['step']}: {traceback.format_exc()}")
    finally:
        shield_signals()
        emit("cleaning up — do not press Ctrl-C again or close this window; wait for the last line")
        # every step below is guarded: an offline Bitget must not skip the .env removal, the
        # audit or the closing warnings
        try:
            unclean = cleanup(env, acct, order, touched, own_ids, say, max_qty, min_qty)
        except Exception as e:
            say("CLEANUP FAILED — check every symbol in the Bitget app", str(e))
            unclean = sorted(touched) or ["cleanup"]
        try:
            restored = restore_mode_after_cleanup(t12_retry, lambda: not precheck(env, acct, order), say)
        except Exception as e:
            say("T12 switch back FAILED", str(e))
            restored = False
        if not restored:
            emit(f"NOT BACK IN THE ORIGINAL POSITION MODE ({(t12_retry or ('', '', '?'))[2]}) — set it in the Bitget app")
            unclean.append("position mode")
        try:
            if os.path.exists(".env"):
                os.remove(".env")
        except OSError as e:
            emit(f"could not remove {os.path.abspath('.env')} ({e}) — delete it by hand, it holds the key")
        try:
            say("audit", open("state/audit.jsonl").read() if os.path.exists("state/audit.jsonl") else "none")
        except OSError as e:
            say("audit unreadable", str(e))
        if not_tradable:
            emit(f"此帳戶不可交易（Bitget 40092，地區或帳戶資格限制）：{', '.join(sorted(not_tradable))}")
        if failed:
            emit(failed)
        if unclean:
            emit(f"NOT FLAT: {', '.join(unclean)} — close in the Bitget app now")
            sys.exit(2)
        if failed:
            sys.exit(4)


def watch_switch(env, acct, order, say, every_s=5, minutes=30):
    """W1: read-only while the account is upgraded in the app. Nothing here sends an order.
    Verdict lines: FAIL when any read returns positions without a leg that was held
    before the switch (the double-buy case), or an entry would be open (session_open)
    while the hold is not released; PASS at the end when every leg read back under UTA
    with the same uid and the hold released."""
    end = time.time() + minutes * 60
    before, uid0, failed, released = None, None, False, False
    while time.time() < end:
        row = {"utc": datetime.now(timezone.utc).strftime("%H:%M:%S")}
        for name, fn in (("mode", lambda: acct.account_mode(env)), ("positions", lambda: acct.get_positions(env)),
                         ("session_open", lambda: order.session_open(env, "NVDAUSDT")),
                         ("uid", lambda: acct.get_account_id(env))):
            try:
                row[name] = fn()
            except Exception as e:
                row[name] = {"error": str(e)[:200], "classify": acct.classify(e)}
        row["mode_file"] = acct._read_mode()
        row["hold_left_s"] = round(acct.switch_hold_left(), 1)
        say("W1", row)
        pos = row["positions"] if isinstance(row["positions"], list) else None
        legs = {(p["symbol"], p["side"]) for p in pos or []}
        if before is None and pos and row["mode"] == "classic":
            before, uid0 = legs, row["uid"]
            say("W1 recorded", {"legs": sorted(before), "uid": uid0, "next": "upgrade this sub-account in the app now"})
        if before is not None and pos is not None and not before <= legs:
            failed = True
            say("W1 FAIL", f"positions read without {sorted(before - legs)} — this round would re-buy them")
        if before is not None and row["mode_file"].get("hold") and row["session_open"] is True:
            failed = True
            say("W1 FAIL", "session_open True while the switch hold is open")
        if before is not None and row["mode"] == "uta" and pos is not None and before <= legs:
            released = True
            if row["uid"] != uid0:
                failed = True
                say("W1 FAIL", f"uid changed {uid0} → {row['uid']} (the reconciler's account check will hold the venue)")
            break
        time.sleep(every_s)
    if before is None:
        say("W1 INCONCLUSIVE", "no classic position read before the end — open the NVDA minimum first")
    elif failed or not released:
        say("W1 FAIL", "see the lines above" if failed else f"the old legs never read back under UTA in {minutes} min")
    else:
        say("W1 PASS", "the old legs read back under UTA, same uid, nothing read as flat on the way")


if __name__ == "__main__":
    main()
