"""Live StockCoin verification — a REAL account, run by hand. Not part of tests/run_all.sh.

What it measures is everything lib/order_stockcoin.py and lib/account_stockcoin.py
take on faith from the venue document (venue-onboarding.md §3). Read-only by
default; the order steps need BOTH --trade and --confirm <today's date, UTC,
YYYY-MM-DD>, and only run after Wei says so in the conversation.

    .venv/bin/python tests/live_stockcoin_verify.py --env /path/to/stockcoin.env
    .venv/bin/python tests/live_stockcoin_verify.py --env ... --trade --confirm 2026-10-16 [--only T1,T2]
    .venv/bin/python tests/live_stockcoin_verify.py --env ... --trade --confirm 2026-10-16 --probe-all [--only R2]
        [--symbols BTCUSDT,HYUNDAIUSDT]

The env file holds STOCKCOIN_API_KEY / STOCKCOIN_SECRET_KEY (FUTURES key, withdrawal
off) and must be mode 0600. Runs in a scratch directory (guard's state/ and audit
land there, never in a workspace); every request is checked before it is sent —
only api.stockcoin.ai is reachable. Key values never reach the console.

READ steps (no money moves)
  R1  clock: serverTime vs ours
  R2  balance: raw reply + get_equity (compare with the app's futures equity)
  R3  positions: raw + get_positions
  R4  commissionRate / accountLeverage / riskLimit on BTC and NVDA
  R5  open LIMIT + STOP orders, last orders (accountId field), last trades
  R6  get_account_id
  R7  multiplier cross-check + USDT notional of one contract, every listed contract (public)
  R8  bad-secret and bad-key replies: code, HTTP status, classify() (a bad secret is -1022)
  R9  DELETE of a nonexistent order: proves the DELETE signature before cancel_order is trusted
  R10 (--noop-write) set BTC leverage to its current value: proves the form-body POST
      path before any order is sent
ORDER steps (each one contract, ≈$0.02–$8; everything is closed at the end)
  T1  BTC: open 1 contract long through place_market_order → raw reply
      (contractMultiplier, status of a market order, avgPrice), fee from trades
  T2  resend T1's clientOrderId raw: is a FILLED id rejected (-1141) or filled again?
  T3  over-close raw: SELL_CLOSE 2 contracts while holding 1 → -1149, partial, or what
  T4  close through close_position_partial → flat
  T5  NVDA, XAU, SAMSUNG, OPENAI: open + close 1 contract each (multiplier per class)
  T6  a 36-character clientOrderId on NVDA: accepted or rejected, then closed
  T7  limit layer facts on NVDA (nothing fills unless LIMIT_MAKER is ignored): a resting GTC
      buy 10% under the bid → open list → cancel_order → status → cancel again; a price with
      7 decimals (tick?); timeInForce=LIMIT_MAKER far from the book (post-only dialect?); if
      accepted, a crossing LIMIT_MAKER (rejected, auto-cancelled, or filled — then closed)
  T8  STOP + equity with a position on NVDA: open 1 long → balance raw / get_equity /
      positions; STOP SELL_CLOSE trigger 20% under (stop-loss) and 20% over (does a
      take-profit rest or fire at once?) → open STOP list → cancel both (orderType=STOP) →
      list again → close
  T9  the real executors on NVDA, one contract each leg, through lib.execute in a scratch
      workspace (.env written 0600 there, removed at the end; residual gate lowered to
      $0.001 for this one-contract run — production keeps $10): chase open → chase close
      (post-only at the touch for 45 s, then the rest at market) → TWAP open → TWAP close,
      one 1-contract slice each (a slice under one contract rounds up to one — the
      reconciler's slice floor keeps that out of production, this harness has no floor).
      Prints each orders.jsonl row and the manager/twap summary.
  T11 audit round (NVDA): a short leg open → SL/TP → close through the lib (want stops_cancel
      and an empty STOP list); 100 contracts (≈ $2 notional, ≈ $0.22 margin at 10×) held up to
      90 s, balance / get_equity / uPnL printed every 15 s to compare with the app, then a
      partial close of 50; a stop-loss 0.05% under the price and a take-profit 20% over —
      waits up to 180 s for the venue to fire the stop-loss (else closes with a raw order the
      lib does not see, the same blind spot), then sweep_orphan_stops must cancel the orphan
      take-profit; one order sized at 5× the account's margin, expected refused (measured -1131 or
      other) to read the margin-refusal wording.
  T10 a position's STOP when the position goes away: open 1 → place_protective_orders SL →
      close → STOP list 3 s later (does the venue drop it?) → cancel what is left → [].
  CLEANUP  every open LIMIT / STOP order and every leg touched above is cancelled / closed
           (runs even after a failure)
PROBE (--probe-all, replaces T1–T6; R steps still run, narrow them with --only)
  P0  refuses unless the account is flat with no open LIMIT / STOP order (so every leg
      found at the end is ours), prints the cost bound, waits for "y" on the terminal
  P1  every contract getContracts lists: open 1 contract long through the lib, close it
      at once; -1157 = the contract is closed to the API, any other per-contract error
      is recorded and the next contract tried; a global error (key, signature,
      clock, rate limit, balance wording, unreadable state, a non-venue exception) stops
  CLEANUP  closes any leg it opened, then reads every contract: no leg, no open order
  --symbols narrows P1 to those canonical symbols; one not listed refuses before any order.
  Writes a table to the console and JSON (--out, default the scratch dir).
If a contract's real multiplier is not the table's, place_market_order raises AFTER the
fill (contractMultiplier mismatch — fail-loud by design); CLEANUP still closes that leg.
Run order: read steps (+ --noop-write) first, compare R2 with the app, then --trade.
Not covered yet: a resting limit killed with its process and swept at restart, the full
web → reconciler round, user-data WebSocket.
"""
import argparse
import json
import os
import stat
import sys
import tempfile
import time
import uuid
from datetime import datetime, timezone
from urllib.parse import urlsplit

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

ALLOWED_HOST = "api.stockcoin.ai"

# research note stockcoin-venue-research-2026-10-09 §1; a contract listed since is 未分類
CATEGORIES = {
    "加密": "BTC ETH SOL XRP",
    "美股": "TSLA NVDA AAPL MSFT GOOGL META AMZN COIN MSTR HOOD PLTR INTC MU SNDK CRCL BABA V CBRS",
    "ETF": "SOXL QQQ KORU",
    "韓股": "SAMSUNG SKHYNIX SKHY HYUNDAI",
    "商品": "XAU XAG CL COPPER",
    "私募": "OPENAI ANTHROPIC SPCX",
}
CATEGORY_OF = {b: c for c, bases in CATEGORIES.items() for b in bases.split()}

API_CLOSED = "-1157"
# every later order would fail the same way, or the account state is no longer known.
# -1149 CREATE_ORDER_FAILED is not here: it can be one contract's position limit, and
# a balance failure still stops on its message words
GLOBAL_CODES = {"-1002", "-1005", "-1022", "-1021", "-1003",
                "-1000", "-1001", "-1006", "-1007"}
GLOBAL_WORDS = ("insufficient", "balance", "margin not enough")
PROBE_GAP_S = 1.0


class ProbeStop(Exception):
    pass


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
    if not env.get("STOCKCOIN_API_KEY") or not env.get("STOCKCOIN_SECRET_KEY"):
        sys.exit("STOCKCOIN_API_KEY / STOCKCOIN_SECRET_KEY missing from the env file")
    return env


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--env", required=True)
    ap.add_argument("--trade", action="store_true")
    ap.add_argument("--confirm", default="")
    ap.add_argument("--only", default="")
    ap.add_argument("--noop-write", action="store_true")
    ap.add_argument("--probe-all", action="store_true")
    ap.add_argument("--out", default="")
    ap.add_argument("--symbols", default="")
    a = ap.parse_args()
    env = load_env(os.path.abspath(a.env))
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    if a.trade and a.confirm != today:
        sys.exit(f"--trade needs --confirm {today} (today, UTC) — and Wei's go-ahead in the conversation")
    if a.probe_all and not a.trade:
        sys.exit(f"--probe-all places orders: it needs --trade --confirm {today}")
    symbols = {s.strip().upper() for s in a.symbols.split(",") if s.strip()}
    if symbols and not a.probe_all:
        sys.exit("--symbols only narrows --probe-all")
    out_path = os.path.abspath(a.out) if a.out else ""
    only = {s.strip().upper() for s in a.only.split(",") if s.strip()}
    secrets = (env["STOCKCOIN_API_KEY"], env["STOCKCOIN_SECRET_KEY"])

    def redact(x):
        s = x if isinstance(x, str) else json.dumps(x, ensure_ascii=False, default=str)
        for v in secrets:
            s = s.replace(v, "***")
        return s

    def say(tag, x):
        print(f"[{tag}] {redact(x)}", flush=True)

    os.chdir(tempfile.mkdtemp(prefix="stockcoin-live-"))
    out_path = out_path or os.path.abspath(
        f"stockcoin-probe-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json")
    import requests
    real_send = requests.adapters.HTTPAdapter.send

    def guarded_send(self, req, **kw):
        host = urlsplit(req.url).hostname
        if host != ALLOWED_HOST:
            raise RuntimeError(f"refused: request to {host}")
        return real_send(self, req, **kw)

    requests.adapters.HTTPAdapter.send = guarded_send
    from lib import account_stockcoin as acct, order_stockcoin as order

    def raw(method, path, params=None):
        try:
            return order._send(method, path, env, params or {}, retries=1)
        except Exception as e:
            return {"error": str(e), "code": getattr(e, "code", None),
                    "http_status": getattr(e, "http_status", None)}

    def want(step):
        return not only or step in only

    if want("R1"):
        t0 = time.time()
        srv = requests.get(f"https://{ALLOWED_HOST}/openapi/v1/time", timeout=10).json()["serverTime"]
        say("R1", {"server_ms": srv, "ours_ms": int(t0 * 1000), "skew_ms": srv - int(t0 * 1000)})
    if want("R2"):
        say("R2 raw", raw("GET", "/futures/balance"))
        say("R2 get_equity", acct.get_equity(env))
    if want("R3"):
        say("R3 raw", raw("GET", "/futures/positions"))
        say("R3 get_positions", acct.get_positions(env))
    if want("R4"):
        for vs in ("BTC-PERP-USDT", "NVDA-PERP-USDT"):
            for p in ("/futures/commissionRate", "/futures/accountLeverage", "/futures/riskLimit"):
                say(f"R4 {vs} {p}", raw("GET", p, {"symbol": vs}))
    if want("R5"):
        for t in ("LIMIT", "STOP"):
            say(f"R5 open {t}", raw("GET", "/futures/orders/open", {"orderType": t}))
        say("R5 history", raw("GET", "/futures/orders/history", {"limit": 5}))
        say("R5 trades", raw("GET", "/futures/trades", {"limit": 5}))
    if want("R6"):
        try:
            say("R6 get_account_id", acct.get_account_id(env))
        except Exception as e:
            say("R6 get_account_id raised", str(e))
    if want("R7"):
        rows = requests.get(f"https://{ALLOWED_HOST}/openapi/v1/getContracts", timeout=10).json()
        for r in rows:
            sym = order.canonical_symbol(r["symbol"])
            order._rules_cache.pop(r["symbol"], None)
            try:
                cv = order.get_contract_rules(env, sym)["contract_value"]
                px = float(r.get("lastPrice") or 0) or order.get_mark_price(env, sym)
                say("R7", {sym: cv, "usdt_per_contract": round(cv * px, 6)})
            except Exception as e:
                say("R7 REFUSED", {sym: str(e)})
    if want("R8"):
        for label, bad in (("bad secret", {**env, "STOCKCOIN_SECRET_KEY": "x" * 32}),
                           ("bad key", {**env, "STOCKCOIN_API_KEY": "x" * 32})):
            try:
                acct.get_equity(bad)
                # measured 2026-10-16: the venue checks no signature, so a bad secret lands here
                say(f"R8 {label}", "accepted — the venue did not reject it")
            except Exception as e:
                say(f"R8 {label}", {"error": str(e), "code": getattr(e, "code", None),
                                    "http_status": getattr(e, "http_status", None),
                                    "classify": acct.classify(e)})

    if want("R9"):
        say("R9 DELETE a nonexistent order (want -2013/-1122; -1022 = DELETE params belong in the body)",
            raw("DELETE", "/futures/order", {"symbol": "BTC-PERP-USDT", "orderId": "1"}))
    if a.noop_write and want("R10"):
        cur = raw("GET", "/futures/accountLeverage", {"symbol": "BTC-PERP-USDT"})
        say("R10 leverage now", cur)
        lev = cur[0].get("leverage") if isinstance(cur, list) and cur else None
        if lev:
            say("R10 POST leverage = same value (form-body POST path; the venue checks no signature)",
                raw("POST", "/futures/leverage", {"symbol": "BTC-PERP-USDT", "leverage": lev}))

    if not a.trade:
        print("read steps done; order steps not run (no --trade)")
        return

    touched = set()
    one = lambda sym: float(acct.multiplier(order.venue_symbol(sym)))  # one contract in base units

    def legs(sym=None):
        rows = raw("GET", "/futures/positions", {"symbol": order.venue_symbol(sym)} if sym else {})
        if not isinstance(rows, list):
            # an unreadable position must never read as flat
            raise RuntimeError(f"positions for {sym or 'the account'} UNKNOWN — check the app: {redact(rows)}")
        return [p for p in rows if float(p.get("position") or 0) != 0]

    if a.probe_all:
        sys.exit(probe_all(env, order, acct, requests, say, legs, one, out_path, symbols))

    try:
        if want("T1") or want("T2") or want("T3") or want("T4"):
            touched.add("BTCUSDT")
            cid = "rc" + datetime.now(timezone.utc).strftime("%y%m%d%H%M%S%f")
            if want("T1"):
                say("T1 place_market_order", order.place_market_order(env, "BTCUSDT", "long", one("BTCUSDT"),
                                                                       client_order_id=cid))
                say("T1 raw order", raw("GET", "/futures/order", {"symbol": "BTC-PERP-USDT", "clientOrderId": cid}))
                say("T1 legs", legs("BTCUSDT"))
            if want("T2"):
                say("T2 resend filled cid", raw("POST", "/futures/order", {
                    "symbol": "BTC-PERP-USDT", "side": "BUY_OPEN", "orderType": "LIMIT", "priceType": "MARKET",
                    "price": "0", "quantity": "1", "clientOrderId": cid}))
                time.sleep(2)
                say("T2 legs (2 contracts = a filled id is NOT deduplicated)", legs("BTCUSDT"))
            if want("T3"):
                held = sum(float(p.get("position") or 0) for p in legs("BTCUSDT") if p.get("side") == "LONG")
                say("T3 over-close", raw("POST", "/futures/order", {
                    "symbol": "BTC-PERP-USDT", "side": "SELL_CLOSE", "orderType": "LIMIT", "priceType": "MARKET",
                    "price": "0", "quantity": str(int(held) + 1), "clientOrderId": "rc" + uuid.uuid4().hex[:16]}))
                time.sleep(2)
                say("T3 legs", legs("BTCUSDT"))
            if want("T4"):
                for p in legs("BTCUSDT"):
                    d = "long" if p["side"] == "LONG" else "short"
                    say("T4 close", order.close_position_partial(env, "BTCUSDT", d,
                                                                 float(p["position"]) * one("BTCUSDT")))
                say("T4 legs (want [])", legs("BTCUSDT"))
        if want("T5"):
            for sym in ("NVDAUSDT", "XAUUSDT", "SAMSUNGUSDT", "OPENAIUSDT"):
                touched.add(sym)
                say(f"T5 {sym} open", order.place_market_order(env, sym, "long", one(sym)))
                say(f"T5 {sym} raw last order", raw("GET", "/futures/orders/history",
                                                    {"symbol": order.venue_symbol(sym), "limit": 1}))
                say(f"T5 {sym} close", order.close_position_partial(env, sym, "long", one(sym)))
        if want("T7"):
            touched.add("NVDAUSDT")
            vs = "NVDA-PERP-USDT"
            t = requests.get(f"https://{ALLOWED_HOST}/openapi/quote/v1/contract/ticker/24hr",
                             params={"symbol": vs}, timeout=10).json()
            t = t[0] if isinstance(t, list) else t
            bid, ask = float(t["bestBidPrice"]), float(t["bestAskPrice"])
            say("T7 book", {"bid": bid, "ask": ask, "last": t.get("lastPrice")})

            def limit(tag, price, tif="GTC"):
                r = raw("POST", "/futures/order", {
                    "symbol": vs, "side": "BUY_OPEN", "orderType": "LIMIT", "priceType": "INPUT",
                    "price": price, "quantity": "1", "timeInForce": tif,
                    "clientOrderId": "rc" + uuid.uuid4().hex[:16]})
                say(f"T7 {tag} place", r)
                return r.get("orderId") if isinstance(r, dict) else None

            oid = limit("a GTC 10% under bid", f"{bid * 0.9:.2f}")
            say("T7 a open LIMIT", raw("GET", "/futures/orders/open", {"symbol": vs, "orderType": "LIMIT"}))
            if oid:
                say("T7 a cancel_order", order.cancel_order(env, "NVDAUSDT", oid))
                say("T7 a status after cancel", raw("GET", "/futures/order", {"symbol": vs, "orderId": oid}))
                say("T7 a cancel again (gone code?)", raw("DELETE", "/futures/order", {"symbol": vs, "orderId": oid}))
            oid = limit("b 7 decimals", f"{bid * 0.9:.7f}")
            if oid:
                say("T7 b cancel", raw("DELETE", "/futures/order", {"symbol": vs, "orderId": oid}))
            oid = limit("c LIMIT_MAKER far", f"{bid * 0.9:.2f}", "LIMIT_MAKER")
            if oid:
                say("T7 c cancel", raw("DELETE", "/futures/order", {"symbol": vs, "orderId": oid}))
                oid = limit("d LIMIT_MAKER crossing", f"{ask * 1.02:.2f}", "LIMIT_MAKER")
                time.sleep(2)
                if oid:
                    say("T7 d status", raw("GET", "/futures/order", {"symbol": vs, "orderId": oid}))
                say("T7 d legs (a leg = LIMIT_MAKER is not post-only)", legs("NVDAUSDT"))
        if want("T8"):
            touched.add("NVDAUSDT")
            vs = "NVDA-PERP-USDT"
            say("T8 open", order.place_market_order(env, "NVDAUSDT", "long", one("NVDAUSDT")))
            say("T8 balance raw (with a position)", raw("GET", "/futures/balance"))
            say("T8 get_equity", acct.get_equity(env))
            say("T8 positions raw", raw("GET", "/futures/positions", {"symbol": vs}))
            say("T8 get_positions", acct.get_positions(env))
            last = order.get_mark_price(env, "NVDAUSDT")
            for tag, trig in (("SL 20% under", last * 0.8), ("TP 20% over", last * 1.2)):
                say(f"T8 STOP {tag}", raw("POST", "/futures/order", {
                    "symbol": vs, "side": "SELL_CLOSE", "orderType": "STOP", "priceType": "MARKET",
                    "price": "0", "triggerPrice": f"{trig:.2f}", "quantity": "1",
                    "clientOrderId": "rc" + uuid.uuid4().hex[:16]}))
                time.sleep(2)
                say(f"T8 legs after {tag} (gone = it fired)", legs("NVDAUSDT"))
            stops = raw("GET", "/futures/orders/open", {"symbol": vs, "orderType": "STOP"})
            say("T8 open STOP", stops)
            say("T8 get_open_algo_orders", order.get_open_algo_orders(env, "NVDAUSDT"))
            for o in stops if isinstance(stops, list) else []:
                say("T8 cancel STOP", raw("DELETE", "/futures/order",
                                          {"symbol": vs, "orderId": o.get("orderId"), "orderType": "STOP"}))
            say("T8 open STOP after cancel (want [])",
                raw("GET", "/futures/orders/open", {"symbol": vs, "orderType": "STOP"}))
        if want("T9"):
            touched.add("NVDAUSDT")
            import threading
            from lib import execute as ex, venue_wiring as vw
            ws_lib = os.path.join(ROOT, "lib")
            if not os.path.exists("lib"):
                os.symlink(ws_lib, "lib")  # venue discovery checks lib/account_<id>.py under cwd
            fd = os.open(".env", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as fh:
                fh.write(f"STOCKCOIN_API_KEY={env['STOCKCOIN_API_KEY']}\n"
                         f"STOCKCOIN_SECRET_KEY={env['STOCKCOIN_SECRET_KEY']}\n")
            ex._RESIDUAL_USD = 0.001
            ex._own_only = vw._own_only = lambda: False
            ex._notify_fn = lambda m: say("T9 notify", m)
            say("T9 venue", vw.detect_venue(vw.read_env()))
            usd = one("NVDAUSDT") * order.get_mark_price(env, "NVDAUSDT")

            def jsonl_tail(path):
                try:
                    return open(path).read().splitlines()[-1]
                except (OSError, IndexError):
                    return None

            for tag, signed, reduce_only in (("chase open", usd, False), ("chase close", -usd, True)):
                ex._chase_thread("NVDAUSDT", signed, None, reduce_only, "stockcoin", [],
                                 vw.auto_limit_toolkit("NVDAUSDT", reduce_only), threading.Event())
                say(f"T9 {tag} orders.jsonl", jsonl_tail("manager/orders.jsonl"))
                say(f"T9 {tag} legs", legs("NVDAUSDT"))
                say(f"T9 {tag} open LIMIT (want [])", order.get_open_orders(env, "NVDAUSDT"))
            for tag, signed, reduce_only, n in (("twap open", usd, False, 1), ("twap close", -usd, True, 1)):
                ex._twap_thread("NVDAUSDT", signed, None, reduce_only, "stockcoin", [], 1, n, threading.Event())
                say(f"T9 {tag} orders.jsonl", jsonl_tail("manager/orders.jsonl"))
                twap = sorted(os.listdir("manager/twap")) if os.path.isdir("manager/twap") else []
                say(f"T9 {tag} twap summary", [jsonl_tail(os.path.join("manager/twap", f)) for f in twap])
                say(f"T9 {tag} legs", legs("NVDAUSDT"))
        if want("T10"):
            touched.add("NVDAUSDT")
            say("T10 open", order.place_market_order(env, "NVDAUSDT", "long", one("NVDAUSDT")))
            last = order.get_mark_price(env, "NVDAUSDT")
            say("T10 SL 20% under", order.place_protective_orders(env, "NVDAUSDT", "long", sl_price=last * 0.8))
            say("T10 STOP list with the position", order.get_open_algo_orders(env, "NVDAUSDT"))
            say("T10 close", order.close_position_partial(env, "NVDAUSDT", "long", one("NVDAUSDT")))
            time.sleep(3)
            left = order.get_open_algo_orders(env, "NVDAUSDT")
            say("T10 STOP list 3 s after the close ([] = the venue drops it)", left)
            if left:
                say("T10 cancel_protective_orders", order.cancel_protective_orders(env, "NVDAUSDT"))
            say("T10 STOP list at the end (want [])", order.get_open_algo_orders(env, "NVDAUSDT"))
        if want("T11"):
            touched.add("NVDAUSDT")
            vs = "NVDA-PERP-USDT"
            one_c = one("NVDAUSDT")
            stops = lambda: order.get_open_algo_orders(env, "NVDAUSDT")
            say("T11a short open", order.place_market_order(env, "NVDAUSDT", "short", one_c))
            say("T11a short leg", legs("NVDAUSDT"))
            last = order.get_mark_price(env, "NVDAUSDT")
            say("T11a short SL +20% / TP -20%", order.place_protective_orders(
                env, "NVDAUSDT", "short", sl_price=last * 1.2, tp_price=last * 0.8))
            say("T11a STOP list (want two BUY_CLOSE)", stops())
            res = order.close_position_partial(env, "NVDAUSDT", "short", one_c)
            say("T11a short close (want stops_cancel with two canceled)", res)
            say("T11a STOP list after the close (want [])", stops())
            say("T11a legs (want [])", legs("NVDAUSDT"))

            say("T11b open 100 contracts", order.place_market_order(env, "NVDAUSDT", "long", 100 * one_c))
            say("T11b raw last order", raw("GET", "/futures/orders/history", {"symbol": vs, "limit": 1}))
            for i in range(7):
                if i:
                    time.sleep(15)
                pos = raw("GET", "/futures/positions", {"symbol": vs})
                upnl = [p.get("unrealizedPnL") for p in pos] if isinstance(pos, list) else pos
                say(f"T11b {datetime.now(timezone.utc).strftime('%H:%M:%S')} UTC compare with the app",
                    {"get_equity": acct.get_equity(env)["equity"], "uPnL": upnl,
                     "balance_raw": raw("GET", "/futures/balance")})
            say("T11b partial close 50", order.close_position_partial(env, "NVDAUSDT", "long", 50 * one_c))
            say("T11b legs (want 50)", legs("NVDAUSDT"))
            say("T11b close the other 50", order.close_position_partial(env, "NVDAUSDT", "long", 50 * one_c))
            say("T11b legs (want [])", legs("NVDAUSDT"))

            say("T11c open 1", order.place_market_order(env, "NVDAUSDT", "long", one_c))
            last = order.get_mark_price(env, "NVDAUSDT")
            say("T11c SL 0.05% under / TP 20% over", order.place_protective_orders(
                env, "NVDAUSDT", "long", sl_price=last * 0.9995, tp_price=last * 1.2))
            fired = False
            for _ in range(36):
                time.sleep(5)
                if not legs("NVDAUSDT"):
                    fired = True
                    break
            if not fired:
                say("T11c SL did not fire in 180 s — closing with a raw order the lib does not see",
                    raw("POST", "/futures/order", {
                        "symbol": vs, "side": "SELL_CLOSE", "orderType": "LIMIT", "priceType": "MARKET",
                        "price": "0", "quantity": "1", "clientOrderId": "rc" + uuid.uuid4().hex[:16]}))
                time.sleep(2)
            say("T11c fired on the venue" if fired else "T11c simulated", {"legs": legs("NVDAUSDT")})
            say("T11c STOP list before the sweep (want the orphan TP)", stops())
            say("T11c sweep_orphan_stops", order.sweep_orphan_stops(env, acct.get_positions(env)))
            say("T11c STOP list after the sweep (want [])", stops())

            bal = acct.get_equity(env)["equity"]
            lev = raw("GET", "/futures/accountLeverage", {"symbol": vs})
            lev = float((lev[0] if isinstance(lev, list) and lev else {}).get("leverage") or 0) or 10.0
            px = order.get_mark_price(env, "NVDAUSDT")
            n_big = int(5 * bal * lev / (px * one_c)) + 1
            say("T11d order sized at 5x the margin", {"equity": bal, "leverage": lev, "contracts": n_big,
                                                       "notional_usdt": round(n_big * one_c * px, 2)})
            say("T11d reply (want an error)", raw("POST", "/futures/order", {
                "symbol": vs, "side": "BUY_OPEN", "orderType": "LIMIT", "priceType": "MARKET",
                "price": "0", "quantity": str(n_big), "clientOrderId": "rc" + uuid.uuid4().hex[:16]}))
            time.sleep(2)
            say("T11d legs (want [])", legs("NVDAUSDT"))
        if want("T6"):
            touched.add("NVDAUSDT")
            long_cid = "rc" + uuid.uuid4().hex + "ab"  # 36 characters
            say("T6 36-char cid", raw("POST", "/futures/order", {
                "symbol": "NVDA-PERP-USDT", "side": "BUY_OPEN", "orderType": "LIMIT", "priceType": "MARKET",
                "price": "0", "quantity": "1", "clientOrderId": long_cid}))
    finally:
        unclean = []
        for sym in sorted(touched):
            try:
                for ot in ("LIMIT", "STOP"):
                    rows = raw("GET", "/futures/orders/open", {"symbol": order.venue_symbol(sym), "orderType": ot})
                    for o in rows if isinstance(rows, list) else []:
                        say(f"CLEANUP {sym} cancel {ot}", raw("DELETE", "/futures/order", {
                            "symbol": order.venue_symbol(sym), "orderId": o.get("orderId"), "orderType": ot}))
                for p in legs(sym):
                    d = "long" if p["side"] == "LONG" else "short"
                    say(f"CLEANUP {sym} {d}", order.close_position_partial(
                        env, sym, d, float(p["position"]) * one(sym)))
                left = legs(sym)
                say(f"CLEANUP {sym} legs (want [])", left)
                if left:
                    unclean.append(sym)
            except Exception as e:
                say(f"CLEANUP {sym} FAILED — check and close it in the app", str(e))
                unclean.append(sym)
        if os.path.exists(".env"):
            os.remove(".env")
        say("audit", open("state/audit.jsonl").read() if os.path.exists("state/audit.jsonl") else "none")
        if unclean:
            print(f"NOT FLAT: {', '.join(unclean)} — close in the StockCoin app now", flush=True)
            sys.exit(2)


def _f(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _fee_rate(order, env, vsym):
    r = order._send("GET", "/futures/commissionRate", env, {"symbol": vsym}, retries=1)
    r = r[0] if isinstance(r, list) and r else r
    rate = _f(r.get("openTakerFee")) + _f(r.get("closeTakerFee")) if isinstance(r, dict) else 0.0
    if rate <= 0:
        raise ValueError(f"no taker fee in {str(r)[:120]}")
    return rate


def _is_global(e, order):
    if isinstance(e, ProbeStop):
        return True
    if not isinstance(e, order.StockcoinError):
        return True
    return e.code in GLOBAL_CODES or any(w in str(e).lower() for w in GLOBAL_WORDS)


def probe_all(env, order, acct, requests, say, legs, one, out_path, symbols=frozenset()):
    """--probe-all. Returns the exit code: 0 clean, 1 refused before any order,
    2 not flat / open orders left at the end."""
    open_legs = legs()
    resting = order.get_open_orders(env) + order.get_open_algo_orders(env)
    if open_legs or resting:
        say("P0 REFUSED — the account must be flat with no open order first",
            {"legs": open_legs, "open_orders": resting})
        return 1

    rows = requests.get(f"https://{ALLOWED_HOST}/openapi/v1/getContracts", timeout=10).json()
    if symbols:
        rows = [r for r in rows if order.canonical_symbol(r["symbol"]) in symbols]
        missing = symbols - {order.canonical_symbol(r["symbol"]) for r in rows}
        if missing:
            say("P0 REFUSED — not listed by getContracts", sorted(missing))
            return 1
    plan, rates = [], {}
    for r in rows:
        vsym = r["symbol"]
        sym = order.canonical_symbol(vsym)
        px = _f(r.get("lastPrice"))
        if px <= 0:
            try:
                px = order.get_mark_price(env, sym)
            except Exception:
                px = 0.0
        cv = float(acct.multiplier(vsym))
        try:
            rates[vsym] = _fee_rate(order, env, vsym)
        except Exception as e:
            say(f"P0 {sym} fee rate unreadable", str(e))
        time.sleep(0.2)
        plan.append({"symbol": sym, "venue_symbol": vsym, "category": CATEGORY_OF.get(r.get("baseToken")
                     or vsym.split("-")[0], "未分類"), "price": px, "notional": cv * px,
                     "spread": max(_f(r.get("ask")) - _f(r.get("bid")), 0.0) * cv})
    fallback = max(rates.values()) if rates else None
    fee_cost = spread_cost = 0.0
    for p in plan:
        rate = rates.get(p["venue_symbol"], fallback)
        p["fee_rate_round_trip"] = rate
        fee_cost += p["notional"] * (rate or 0.0)
        spread_cost += p["spread"]
    say("P0 plan", [{k: p[k] for k in ("symbol", "category", "notional", "fee_rate_round_trip")} for p in plan])
    print(f"\n{len(plan)} contracts, one at a time. Largest one-contract notional "
          f"{max((p['notional'] for p in plan), default=0):.4f} USDT (margin held at any moment).")
    if fallback is None:
        print("NO fee rate was readable — the fee bound below is 0 and NOT a bound; answer n.")
    elif len(rates) < len(plan):
        print(f"{len(plan) - len(rates)} contracts had no readable fee rate; the highest one read is used for them.")
    print(f"Fees (one contract × round-trip taker rate, summed): <= {fee_cost:.4f} USDT")
    print(f"Spread crossed (ask - bid, one contract, summed):    <= {spread_cost:.4f} USDT")
    print(f"Estimated total cost upper bound:                    <= {fee_cost + spread_cost:.4f} USDT "
          f"(price moves inside each ~2 s round trip not included)")
    try:
        ans = input("Type y to place these orders: ").strip()
    except EOFError:
        ans = ""
    if ans != "y":
        print("not confirmed — no order placed")
        return 1

    results, touched, stop = [], set(), None
    try:
        for i, p in enumerate(plan):
            if i:
                time.sleep(PROBE_GAP_S)
            sym = p["symbol"]
            res = {**p, "result": None, "code": None, "msg": None, "open": None, "close": None}
            results.append(res)
            try:
                if p["price"] <= 0:
                    res.update(result="error", msg="no price on the public ticker — not ordered")
                    continue
                order._rules_cache.pop(p["venue_symbol"], None)
                touched.add(sym)
                res["open"] = order.place_market_order(env, sym, "long", one(sym))
                res["result"] = "tradable"
                res["close"] = order.close_position_partial(env, sym, "long", one(sym))
            except Exception as e:
                code = getattr(e, "code", None)
                res.update(code=code, msg=str(e))
                if res["result"] == "tradable":
                    res["msg"] = f"opened, close failed: {e}"
                elif code == API_CLOSED:
                    res["result"] = "api_closed"
                else:
                    res["result"] = "error"
                if isinstance(e, order.OrderNotConfirmed):
                    time.sleep(3)
                elif res["result"] != "api_closed" and _is_global(e, order):
                    stop = e
            finally:
                say(f"P1 {sym}", {k: res[k] for k in ("result", "code", "msg", "open", "close")})
                if sym in touched:
                    try:
                        for leg in legs(sym):
                            d = "long" if leg["side"] == "LONG" else "short"
                            say(f"P1 {sym} closing leftover {d}", order.close_position_partial(
                                env, sym, d, float(leg["position"]) * one(sym)))
                        if legs(sym):
                            stop = stop or ProbeStop(f"{sym} still holds a leg after closing")
                    except Exception as e:
                        stop = stop or e
            if stop is not None:
                say("P1 STOPPED — global error, no further contract tried", str(stop))
                break
    finally:
        code = 0
        try:
            for leg in legs():
                sym = order.canonical_symbol(leg.get("symbol"))
                if sym in touched:
                    d = "long" if leg["side"] == "LONG" else "short"
                    say(f"CLEANUP {sym} {d}", order.close_position_partial(
                        env, sym, d, float(leg["position"]) * one(sym)))
            left = legs()
            resting = order.get_open_orders(env) + order.get_open_algo_orders(env)
            say("CLEANUP every contract: legs (want [])", left)
            say("CLEANUP every contract: open LIMIT + STOP orders (want [])", resting)
            if left or resting:
                code = 2
        except Exception as e:
            say("CLEANUP FAILED — check every contract in the app", str(e))
            code = 2
        _report(results, out_path, stop)
        if code:
            print("NOT FLAT or orders open — close / cancel in the StockCoin app now", flush=True)
    return code


def _report(results, out_path, stop):
    label = {"tradable": "可交易", "api_closed": "不開放 API", "error": "其他錯誤"}
    print(f"\n{'合約':<16}{'類別':<6}{'結果':<10}{'開／平成交價':<24}{'手續費':<12}訊息")
    for r in results:
        o, c = r.get("open") or {}, r.get("close") or {}
        px = f"{o.get('avg_price', '')}/{c.get('avg_price', '')}" if o else ""
        fees = [x.get("commission") for x in (o, c) if x]
        fee = "" if not fees else ("?" if None in fees else f"{sum(fees):.6f}")
        msg = "" if r["result"] == "tradable" and not r.get("msg") else (r.get("msg") or "")
        print(f"{r['symbol']:<16}{r['category']:<6}{label.get(r['result'], '中斷'):<10}"
              f"{px:<24}{fee:<12}{msg[:100]}")
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump({"at": datetime.now(timezone.utc).isoformat(), "stopped": str(stop) if stop else None,
                   "results": results}, fh, ensure_ascii=False, indent=1, default=str)
    print(f"\nJSON: {out_path}", flush=True)


if __name__ == "__main__":
    main()
