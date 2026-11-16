"""全部平倉's dust rule: only a confirmed below-minimum quantity counts as dust (audit venue-shared-rules
2026-11-15 A-10). A suspended or delisting contract also raises ValueError from format_qty — booked as
dust it was zeroed in the book and close_then_unbind dropped the keys over an open position.

Drives manager/flatten.flatten() end to end with each venue's REAL format_qty (Binance, OKX, Gate.io,
BingX) on fake contract rules — no network:
  - not open for trading ([order_reject:symbol_unavailable]): not sent, one error row, the book not
    zeroed, last_flatten ok false with the key unclosed (so the unbind holds and keeps the keys);
  - below the minimum ([order_reject:below_min_size]): dust, as before — zeroed, no row, ok true;
  - a ValueError without the below-minimum token (an agent-written lib): a failure, not dust.

Run: cd blave-agent && .venv/bin/python tests/check_flatten_dust.py
"""
import importlib
import json
import os
import sys
import tempfile
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_REPO_ENV = os.path.join(ROOT, ".env")


def _no_repo_env(event, args):
    if event == "open" and args and isinstance(args[0], (str, bytes)):
        if os.path.abspath(os.fsdecode(args[0])) == _REPO_ENV:
            raise RuntimeError("test tried to open the repo .env")


sys.addaudithook(_no_repo_env)
BASE = tempfile.mkdtemp(prefix="flatten-dust-", dir=os.environ.get("SCRATCHPAD") or None)
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = BASE
os.environ.pop("BLAVE_AGENT_LOCAL", None)
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "manager"))
import flatten  # noqa: E402  (chdir's to ROOT — everything that writes is patched below)
import lib.portfolio as lp  # noqa: E402

fails = 0


def check(cond, msg, detail=None):
    global fails
    print(("ok   " if cond else "FAIL ") + msg + ("" if cond or detail is None else f"  -- {detail}"))
    fails += 0 if cond else 1


flatten.LOCK_PATH = os.path.join(BASE, "flatten.lock")
flatten.LAST_PATH = os.path.join(BASE, "last_flatten.json")
lp._SEED_LOCK_PATH = os.path.join(BASE, "ledger_seed.lock")
errors, sends, zeroed = [], [], set()
flatten._record_order_error = lambda sym, vid, err, extra=None: errors.append((sym, vid, err, extra))
flatten._append_reconciler_log = lambda row: None
flatten.zero_ledger_symbols = lambda syms, venue=None: zeroed.update(syms)
flatten._kick_reconciler = lambda: None
flatten._wait_for_inflight = lambda *a, **k: []
CFG = {"self_ledger": True}
LEDGER = {}
flatten.load_portfolio_config = lambda: CFG
flatten.ledger_positions = lambda vid=None: {k: v for k, v in LEDGER.items() if vid is None or v.get("venue") == vid}
flatten._load_ledger_seed = lambda: {"seeded_at": "2026-01-01T00:00:00", "symbols": {}}
lp.book_ready = lambda config=None: True
lp.claim_unvenued_rows = lambda: None
lp.book_account_check = lambda env, vid: ("ok", "")
flatten.guard = types.SimpleNamespace(
    halted=lambda: True, trip_halt=lambda *a: None, restart_stopped=lambda: False,
    grant_halt_closes=lambda *a: None, hold_turn_money=lambda: None,
    TurnMoneyBusy=type("TurnMoneyBusy", (RuntimeError,), {}))
ENV = {}
flatten._read_env = lambda path=".env": dict(ENV)
POS = []

# venue → (its .env key, a function that sets the fake rules: active?, min size)
REAL = {v: importlib.import_module(f"lib.order_{v}") for v in ("binance", "okx", "gateio", "bingx")}


def _rules_binance(active, big_min):
    REAL["binance"].get_contract_rules = lambda env, sym: {"active": active, "step": "0.00100000",
                                                            "min_qty": 1.0 if big_min else 0.001, "min_notional": 5}


def _rules_okx(active, big_min):
    REAL["okx"]._instrument = lambda env, inst, typ: {"active": active, "ct_val": 0.01, "lot_sz": 0.01,
                                                       "min_sz": 1000 if big_min else 0.01}


def _rules_gateio(active, big_min):
    REAL["gateio"]._futures_rules = lambda env, sym: {"active": active, "multiplier": "0.0001",
                                                       "min_ct": 10 ** 6 if big_min else 1}


def _rules_bingx(active, big_min):
    REAL["bingx"].get_contract_rules = lambda env, sym: {"active": active, "qty_precision": 4,
                                                          "min_qty": 1.0 if big_min else 0.0001, "min_notional": 2}


RULES = {"binance": _rules_binance, "okx": _rules_okx, "gateio": _rules_gateio, "bingx": _rules_bingx}


def _stand_in(vid, format_qty):
    acct, order = types.ModuleType(f"lib.account_{vid}"), types.ModuleType(f"lib.order_{vid}")
    acct.get_positions = lambda env, **k: list(POS)
    order.format_qty = format_qty
    order.close_position_partial = (lambda env, sym, side, size, client_order_id=None, **k:
                                    sends.append((vid, sym, size)) or
                                    {"status": "filled", "executed_qty": float(size), "avg_price": 60000.0})
    sys.modules[f"lib.account_{vid}"], sys.modules[f"lib.order_{vid}"] = acct, order


def run(vid):
    for b in (errors, sends):
        b.clear()
    zeroed.clear()
    if os.path.exists(flatten.LAST_PATH):
        os.remove(flatten.LAST_PATH)
    flatten._RUN.update(unconfirmed=set(), why={}, err={}, reply={}, first_err=None, venues=[])
    ENV.clear()
    ENV.update({f"{vid.upper()}_API_KEY": "x", f"{vid.upper()}_SECRET_KEY": "x"})
    POS[:] = [{"symbol": "BTCUSDT", "side": "long", "size": 0.05, "mark_price": 60000}]
    LEDGER.clear()
    LEDGER["BTCUSDT"] = {"side": "long", "size": 3000.0, "qty": 0.05, "venue": vid}
    flatten._LOCK = None
    res = flatten.flatten()
    if flatten._LOCK is not None:
        flatten._LOCK.close()
    last = json.load(open(flatten.LAST_PATH)) if os.path.exists(flatten.LAST_PATH) else {}
    return res, last


def failed(vid, res, last, token):
    mine = [e for e in errors if e[0] == "BTCUSDT" and e[1] == vid]
    return (not sends and res is False and "BTCUSDT" not in zeroed and last.get("ok") is False
            and "BTCUSDT" in [u.get("key") for u in last.get("unclosed", [])]
            and len(mine) == 1 and (token is None or token in mine[0][2]))


for vid, real in REAL.items():
    _stand_in(vid, real.format_qty)
    RULES[vid](False, False)
    res, last = run(vid)
    check(failed(vid, res, last, "[order_reject:symbol_unavailable]"),
          f"{vid}: suspended / delisting (ValueError symbol_unavailable) is a failure — not sent, book kept, "
          f"unclosed (the unbind holds)", (sends, errors, sorted(zeroed), last.get("ok"), last.get("unclosed")))
    RULES[vid](True, True)
    res, last = run(vid)
    check(not sends and not errors and "BTCUSDT" in zeroed and res is True and last.get("ok") is True,
          f"{vid}: below the minimum (below_min_size) is dust — zeroed, no row", (sends, errors, sorted(zeroed)))
    RULES[vid](True, False)
    res, last = run(vid)
    check(sends == [(vid, "BTCUSDT", 0.05)] and "BTCUSDT" in zeroed and res is True,
          f"{vid}: an open contract above the minimum closes", (sends, errors))


def _untagged(env, sym, size):
    raise ValueError(f"{sym} qty {size} is below this venue's minimum")


_stand_in("binance", _untagged)
res, last = run("binance")
check(failed("binance", res, last, None),
      "a ValueError without the below_min_size token (agent-written lib) is a failure, not dust",
      (sends, errors, sorted(zeroed), last.get("unclosed")))

print()
print("check_flatten_dust: " + ("all ok" if not fails else f"{fails} FAILED"))
sys.exit(1 if fails else 0)
