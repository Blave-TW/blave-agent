"""Live StockCoin verification — a REAL account, run by hand. Not part of tests/run_all.sh.

What it measures is everything lib/order_stockcoin.py and lib/account_stockcoin.py
take on faith from the venue document (venue-onboarding.md §3). Read-only by
default; the order steps need BOTH --trade and --confirm <today's date, UTC,
YYYY-MM-DD>, and only run after Wei says so in the conversation.

    .venv/bin/python tests/live_stockcoin_verify.py --env /path/to/stockcoin.env
    .venv/bin/python tests/live_stockcoin_verify.py --env ... --trade --confirm 2026-10-16 [--only T1,T2]

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
  R7  multiplier cross-check on every listed contract (public)
  R8  bad-secret and bad-key replies: code, HTTP status, classify()
  R9  DELETE of a nonexistent order: proves the DELETE signature before cancel_order is trusted
  R10 (--noop-write) set BTC leverage to its current value: proves the form-body POST
      signature before any order is sent
ORDER steps (each one contract, ≈$0.02–$8; everything is closed at the end)
  T1  BTC: open 1 contract long through place_market_order → raw reply
      (contractMultiplier, status of a market order, avgPrice), fee from trades
  T2  resend T1's clientOrderId raw: is a FILLED id rejected (-1141) or filled again?
  T3  over-close raw: SELL_CLOSE 2 contracts while holding 1 → -1149, partial, or what
  T4  close through close_position_partial → flat
  T5  NVDA, XAU, SAMSUNG, OPENAI: open + close 1 contract each (multiplier per class)
  T6  a 36-character clientOrderId on NVDA: accepted or rejected, then closed
  CLEANUP  every leg touched above is closed through the lib (runs even after a failure)
If a contract's real multiplier is not the table's, place_market_order raises AFTER the
fill (contractMultiplier mismatch — fail-loud by design); CLEANUP still closes that leg.
Run order: read steps (+ --noop-write) first, compare R2 with the app, then --trade.
Not covered yet (later round, needs its own go-ahead): post-only (LIMIT_MAKER), a
resting limit order + cancel + orphan scan, STOP stop-loss / take-profit, chase /
TWAP, the full reconciler round, user-data WebSocket.
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
    a = ap.parse_args()
    env = load_env(os.path.abspath(a.env))
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    if a.trade and a.confirm != today:
        sys.exit(f"--trade needs --confirm {today} (today, UTC) — and Wei's go-ahead in the conversation")
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
                say("R7", {sym: order.get_contract_rules(env, sym)["contract_value"]})
            except Exception as e:
                say("R7 REFUSED", {sym: str(e)})
    if want("R8"):
        for label, bad in (("bad secret", {**env, "STOCKCOIN_SECRET_KEY": "x" * 32}),
                           ("bad key", {**env, "STOCKCOIN_API_KEY": "x" * 32})):
            try:
                acct.get_equity(bad)
                say(f"R8 {label}", "accepted?!")
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
            say("R10 POST leverage = same value (form-body signature; -1022 = body signing is wrong)",
                raw("POST", "/futures/leverage", {"symbol": "BTC-PERP-USDT", "leverage": lev}))

    if not a.trade:
        print("read steps done; order steps not run (no --trade)")
        return

    touched = set()
    one = lambda sym: float(acct.multiplier(order.venue_symbol(sym)))  # one contract in base units

    def legs(sym):
        rows = raw("GET", "/futures/positions", {"symbol": order.venue_symbol(sym)})
        if not isinstance(rows, list):
            # an unreadable position must never read as flat
            raise RuntimeError(f"positions for {sym} UNKNOWN — check the app: {redact(rows)}")
        return [p for p in rows if float(p.get("position") or 0) != 0]

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
        say("audit", open("state/audit.jsonl").read() if os.path.exists("state/audit.jsonl") else "none")
        if unclean:
            print(f"NOT FLAT: {', '.join(unclean)} — close in the StockCoin app now", flush=True)
            sys.exit(2)


if __name__ == "__main__":
    main()
