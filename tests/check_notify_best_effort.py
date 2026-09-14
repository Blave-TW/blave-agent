"""Minimal check: a Telegram rejection never loses a fill, skips a symbol, stops
a TWAP, crashes the reconciler or a live tick — and an agent's direct send
still raises. No network: requests.post answers like Telegram does.

What it protects: lib/notify._check_response raises on any non-OK answer (on
purpose — uid 31755's digest got HTTP 400 and the script said "Sent!"), and
infrastructure called the same sender. Measured: uid 8232's run died on a 429;
a legacy machine's live strategy aborted every tick for 24h on "chat not found".

Asserts: the raw sender raises on 400 and 429 (the strict path is unchanged);
reconcile() with two symbols writes both fills to orders.jsonl and places the
second symbol while every send is rejected, and an order error on the first
still records order_errors.json and places the second; a flip whose close leg
fills and entry leg fails is in orders.jsonl with failed: true; a broken
custom messages template neither raises nor loses the fill; the reconciler's
send_telegram and _halt never raise and HALT still lands; a failed account-id
read is recorded without the exception message; run_twap keeps slicing when
the start notify is rejected and a rejected per-slice notify is not a slice
error; a live Type A tick saves state.json when the signal notify is rejected.

Run: cd blaveclaw-config && python3 tests/check_notify_best_effort.py
"""
import json, os, sys, tempfile
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
WS = Path(tempfile.mkdtemp(prefix="notify-be-"))
HOME = WS / "home"
(HOME / "credentials").mkdir(parents=True)
(HOME / "openclaw.json").write_text(json.dumps({"channels": {"telegram": {"botToken": "t"}}}))
(HOME / "credentials" / "telegram-default-allowFrom.json").write_text(
    json.dumps({"allowFrom": [111]}))
os.environ["BLAVECLAW_HOME"] = str(HOME)
os.chdir(WS)
os.makedirs("manager", exist_ok=True)
open("manager/portfolio_config.json", "w").write("{}")

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import requests  # noqa: E402

TG = {"status": 429, "body": {"ok": False, "error_code": 429,
                              "description": "Too Many Requests: retry after 30"}}
tg_calls = []


def _fake_post(url, **kw):
    tg_calls.append(url)
    r = requests.Response()
    r.status_code = TG["status"]
    r._content = json.dumps(TG["body"]).encode()
    return r


requests.post = _fake_post

from lib import execute, guard, notify, portfolio  # noqa: E402
import lib.runner as runner  # noqa: E402
from manager import reconciler as rec  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


def raises(fn):
    try:
        fn()
    except Exception as e:
        return e
    return None


# ── 1. strict path unchanged ────────────────────────────────────────────────
e = raises(lambda: notify.make_sender()("digest"))
check(isinstance(e, RuntimeError) and "HTTP 429" in str(e), f"raw sender raises on 429 ({e})")
TG.update(status=400, body={"ok": False, "description": "Bad Request: chat not found"})
e = raises(lambda: notify.make_sender()("digest"))
check(isinstance(e, RuntimeError) and "chat not found" in str(e), "raw sender raises on 400")
_safe = getattr(notify, "safe", None)
check(_safe is not None and _safe(notify.make_sender())("x") is False,
      "notify.safe swallows and reports False")

# ── 2. reconcile: ledger first, every symbol processed ─────────────────────
TARGET = {s: {"side": "long", "size": 100.0, "exchange": None, "asset_spec": None,
              "contributors": []} for s in ("AAAUSDT", "BBBUSDT")}
portfolio.aggregate_portfolio = lambda: TARGET
placed = []


def place_ok(symbol, signed_diff, spec, **kw):
    placed.append(symbol)
    return {"avg_price": 1.0, "executed_qty": signed_diff}


def ledger():
    try:
        with open("manager/orders.jsonl") as f:
            return [json.loads(line)["symbol"] for line in f]
    except OSError:
        return []


sender = notify.make_sender()
e = raises(lambda: portfolio.reconcile(lambda: {}, place_ok, threshold=10,
                                       send_telegram_fn=sender))
check(e is None, f"no exception escapes reconcile ({e})")
check(sorted(placed) == ["AAAUSDT", "BBBUSDT"], f"second symbol still placed ({placed})")
check(ledger() == placed, f"both fills in orders.jsonl ({ledger()})")
check(len(tg_calls) >= 2, "the sends were attempted (and rejected)")

FIRST, SECOND = placed if len(placed) == 2 else sorted(TARGET)  # round order is not fixed
if os.path.exists("manager/orders.jsonl"):
    os.remove("manager/orders.jsonl")
del placed[:]


def place_first_fails(symbol, signed_diff, spec, **kw):
    if symbol == FIRST:
        raise RuntimeError("venue rejected")
    return place_ok(symbol, signed_diff, spec)


e = raises(lambda: portfolio.reconcile(lambda: {}, place_first_fails, threshold=10,
                                       send_telegram_fn=sender))
errs = (json.load(open("manager/order_errors.json"))
        if os.path.exists("manager/order_errors.json") else [])
check(e is None and placed == [SECOND], "order error + rejected notify: next symbol placed")
check(errs and errs[-1]["symbol"] == FIRST, "order_errors.json recorded independently of TG")
check(ledger() == [SECOND], "the fill after it is in orders.jsonl")


def ledger_rows():
    try:
        with open("manager/orders.jsonl") as f:
            return [json.loads(line) for line in f]
    except OSError:
        return []


# partial flip: long 100 held, target short 100 → close leg fills, entry leg fails
if os.path.exists("manager/orders.jsonl"):
    os.remove("manager/orders.jsonl")
portfolio.aggregate_portfolio = lambda: {"AAAUSDT": {
    "side": "short", "size": 100.0, "exchange": None, "asset_spec": None, "contributors": []}}


def place_flip(symbol, signed_diff, spec, reduce_only=False, **kw):
    if not reduce_only:
        raise RuntimeError("insufficient margin")
    return {"avg_price": 1.0, "executed_qty": abs(signed_diff)}


e = raises(lambda: portfolio.reconcile(lambda: {"AAAUSDT": {"side": "long", "size": 100.0}},
                                       place_flip, threshold=10, send_telegram_fn=sender))
rows = ledger_rows()
check(e is None and len(rows) == 1 and rows[0].get("failed") is True
      and len(rows[0].get("legs", [])) == 1,
      f"partial flip + rejected notifies: close leg in orders.jsonl with failed=True ({rows})")

# broken custom template: KeyError from .format must not raise or drop the fill
if os.path.exists("manager/orders.jsonl"):
    os.remove("manager/orders.jsonl")
json.dump({"messages": {"order_buy": "Bought {sym} {oops}"}},
          open("manager/portfolio_config.json", "w"))
portfolio.aggregate_portfolio = lambda: {"AAAUSDT": TARGET["AAAUSDT"]}
e = raises(lambda: portfolio.reconcile(lambda: {}, place_ok, threshold=10,
                                       send_telegram_fn=lambda m: None))
check(e is None and [r["symbol"] for r in ledger_rows()] == ["AAAUSDT"],
      f"broken messages template: no exception, fill still in orders.jsonl ({e})")
open("manager/portfolio_config.json", "w").write("{}")

# ── 3. reconciler: sender and HALT never raise ─────────────────────────────
check(raises(lambda: rec.send_telegram("⚠️ round failed")) is None,
      "reconciler.send_telegram swallows the rejection (main-loop error handler)")
guard.clear_halt("test")
r = raises(lambda: rec._halt("test reason", "🚨 HALT engaged"))
check(r is None and guard.halted() and os.path.exists(guard.HALT_PATH),
      "_halt trips HALT and does not raise when the notify is rejected")
guard.clear_halt("test")


class _AcctLib:
    @staticmethod
    def get_account_id(env):
        raise RuntimeError("403 for url https://venue.test/x?signature=SECRETSIG")


sys.modules["lib.account_fakevenue"] = _AcctLib
check(rec._read_account_id("fakevenue", {}) is None, "account-id read stays fail-soft")
doc = (json.load(open(rec.ACCOUNT_ID_READ_PATH))
       if os.path.exists(rec.ACCOUNT_ID_READ_PATH) else {})
check(doc.get("venue") == "fakevenue" and doc.get("supported") is True
      and (doc.get("error") or "").startswith("RuntimeError")
      and "SECRETSIG" not in json.dumps(doc), f"read failure recorded, no message ({doc})")
e = raises(lambda: rec._read_account_id("novenuelib", {}))
doc = (json.load(open(rec.ACCOUNT_ID_READ_PATH))
       if os.path.exists(rec.ACCOUNT_ID_READ_PATH) else {})
check(e is None and doc.get("venue") == "novenuelib" and doc.get("supported") is False
      and doc.get("error") is None, f"missing account lib recorded as unsupported ({doc})")

# ── 4. run_twap ────────────────────────────────────────────────────────────
slices = []


def slice_ok(symbol, side, qty):
    slices.append(qty)
    return {"fill_price": 10.0, "fill_qty": qty}


out = {}
e = raises(lambda: out.update(execute.run_twap(
    "BTCUSDT", "buy", 3.0, 0, 3, slice_ok, "btcusdt_long",
    send_telegram_fn=sender, notify_slices=True)))
try:
    rows = [json.loads(line) for line in open("manager/twap/btcusdt_long.jsonl")]
except OSError:
    rows = []
slice_rows = [r for r in rows if r["type"] == "slice"]
check(e is None and len(slices) == 3 and out.get("n_filled") == 3 and not out.get("aborted"),
      f"rejected start + slice notifies: all slices ran ({out.get('n_filled')}/3, {e})")
check(len(slice_rows) == 3 and not any("error" in r for r in slice_rows),
      f"a rejected slice notify is not recorded as a slice error ({len(slice_rows)} rows)")

# ── 5. live Type A tick saves its state ────────────────────────────────────
NAME = "notifytick"
runner._REPO_ROOT = WS
STATE = WS / "strategies" / NAME / "state.json"
STATE.parent.mkdir(parents=True)
STATE.write_text(json.dumps({"position": 0.0}))
idx = pd.date_range("2024-01-01", periods=120, freq="h")
close = pd.Series(100 + np.cumsum(np.sin(np.arange(120) / 7.0)), index=idx)
DF = pd.DataFrame({"Open": close, "High": close, "Low": close, "Close": close,
                   "Volume": 1.0}, index=idx)
sig = pd.Series(np.nan, index=idx)
sig.iloc[-1] = 1.0
os.environ["BLAVE_MODE"] = "live"
e = raises(lambda: runner.run({"MODE": "backtest", "STRATEGY_NAME": NAME, "SYMBOL": "BTCUSDT",
                               "INTERVAL": "1h", "FEE": 0.0005, "MCPT": False},
                              lambda h: DF, lambda d: sig, send_telegram_fn=sender))
os.environ.pop("BLAVE_MODE", None)
check(e is None and json.loads(STATE.read_text())["position"] == 1.0,
      f"live tick with a rejected signal notify saves state.json ({e})")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
