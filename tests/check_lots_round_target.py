"""Lot rows: the netted target is rounded to whole lots BEFORE the diff.

What it protects (Wei 2026-10-13): lot rows have no diff gate and the order
fns round the DIFF half-up, so a 0.5-lot target bought 1 lot, read -0.5 the
next round and sold it back — a round trip and two fees every round. Rounding
the summed target (sign·floor(|t|+0.5), never banker's round()) makes every
lot diff a whole number.

Asserts: the churn is gone through the real aggregate_portfolio → reconcile
path; 0.49/0.5/-0.5/1.5/-1.5/2.5 round half-up away from zero; two strategies
of 0.3 on one key net to 1 lot (summed, then rounded — not 0 + 0) and
2.3 − 0.8 (a float 1.4999…) to 2; a NaN / inf position holds its key without
an order while the other keys trade (only a contract rollover's new key waits on it); a crypto
(notional) row and a contributor's own contribution keep their raw values.

Run: cd blave-agent && python3 tests/check_lots_round_target.py
"""
import json, os, shutil, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(tempfile.mkdtemp(prefix="lotsround-"))

from lib import portfolio  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


LOTS = {"type": "futures_contracts", "contract_value": 200, "currency": "TWD", "lot_size": 1}


def setup(strategies):
    """strategies: {name: (symbol, position, amount, exchange, asset_spec)}"""
    for d in ("manager", "strategies", "state"):
        shutil.rmtree(d, ignore_errors=True)
    os.makedirs("manager")
    cfg = {"self_ledger": False, "amounts": {}, "exchanges": {}, "asset_specs": {}}
    for name, (sym, pos, amount, ex, spec) in strategies.items():
        os.makedirs(f"strategies/{name}")
        with open(f"strategies/{name}/state.json", "w") as f:
            json.dump({"symbol": sym, "position": pos}, f)
        cfg["amounts"][name] = amount
        cfg["exchanges"][name] = ex
        if spec:
            cfg["asset_specs"][name] = spec
    with open("manager/portfolio_config.json", "w") as f:
        json.dump(cfg, f)


def signed(row):
    return row["size"] if row["side"] == "long" else -row["size"] if row["side"] == "short" else 0


# ── the churn, end to end ────────────────────────────────────────────────────
for venue in ("capital", "paper"):
    setup({"txf": ("TXF", 0.5, 1, venue, LOTS)})
    held = {"lots": 0}
    sent = []

    def get_positions():
        n = held["lots"]
        if not n:
            return {}
        row = {"side": "long" if n > 0 else "short", "size": abs(n)}
        if venue == "paper":
            row["unit"] = "contracts"
        return {"TXF": row}

    def place(symbol, signed_diff, spec, reduce_only=False):
        # what _capital_place_order / _paper_contract_order do with the diff
        import math
        lots = math.floor(abs(signed_diff) + 0.5)
        if lots < 1:
            return False
        lots = lots if signed_diff > 0 else -lots
        sent.append(lots)
        held["lots"] += lots
        return {"executed_qty": abs(lots), "avg_price": 20000.0, "exchange": venue}

    for _ in range(4):
        portfolio.reconcile(get_positions, place)
    check(sent == [1], f"{venue}: target 0.5 buys 1 lot once and holds (orders {sent})")

# ── rounding direction ──────────────────────────────────────────────────────
for pos, want in ((0.49, 0), (0.5, 1), (-0.5, -1), (1.5, 2), (-1.5, -2), (2.5, 3), (2.0, 2)):
    setup({"txf": ("TXF", pos, 1, "capital", LOTS)})
    got = signed(portfolio.aggregate_portfolio()["TXF"])
    check(got == want, f"target {pos:+g} lots → {want:+d} (got {got:+g})")

setup({"mxf": ("MXF", 0.5, 1, "president", None)})
got = signed(portfolio.aggregate_portfolio()["MXF"])
check(got == 1, f"president row without an asset_spec rounds by venue trait (got {got:+g})")

# ── summed, then rounded ────────────────────────────────────────────────────
setup({"a": ("TXF", 0.3, 1, "capital", LOTS), "b": ("TXF", 0.3, 1, "capital", LOTS)})
row = portfolio.aggregate_portfolio()["TXF"]
check(signed(row) == 1, f"0.3 + 0.3 lots net to 1 lot, not 0 + 0 (got {signed(row):+g})")
check(sorted(c["contribution"] for c in row["contributors"]) == [0.3, 0.3],
      "contributors keep their raw contribution")

setup({"a": ("TXF", 2.3, 1, "capital", LOTS), "b": ("TXF", -0.8, 1, "capital", LOTS)})
got = signed(portfolio.aggregate_portfolio()["TXF"])
check(got == 2, f"2.3 − 0.8 (float 1.4999999999999998) → 2 lots (got {got:+g})")

setup({"a": ("TXF", 1.0, 1, "capital", LOTS), "b": ("TXF", -0.6, 1, "capital", LOTS)})
got = signed(portfolio.aggregate_portfolio()["TXF"])
check(got == 0, f"1 − 0.6 = 0.4 lots nets flat (got {got:+g})")

# ── a non-finite position holds its key, the rest of the round trades ─────
for bad in (float("nan"), float("inf")):
    setup({"txf": ("TXF", bad, 1, "capital", LOTS), "mxf": ("MXF", 1.0, 1, "capital", LOTS)})
    sent = []

    def place_any(symbol, signed_diff, spec, reduce_only=False):
        sent.append((symbol, signed_diff))
        return {"executed_qty": abs(signed_diff), "avg_price": 20000.0, "exchange": "capital"}

    try:
        portfolio.reconcile(lambda: {"TXF": {"side": "long", "size": 1}}, place_any)
        raised = None
    except Exception as e:
        raised = e
    check(raised is None and sent == [("MXF", 1.0)],
          f"position {bad}: TXF held (no close), MXF still buys 1 (sent {sent}, raised {raised!r})")

# …unless that key is the OLD contract of a rollover in progress: the new one waits
setup({"txf": ("TXF", float("nan"), 1, "capital", LOTS), "mxf": ("MXF", 1.0, 1, "capital", LOTS)})
os.makedirs("state", exist_ok=True)
with open("state/contract_rollover.json", "w") as f:
    json.dump({"mxf": {"from": "TXF", "to": "MXF", "at": "t0"}}, f)
sent = []
portfolio.reconcile(lambda: {"TXF": {"side": "long", "size": 1}},
                    lambda symbol, signed_diff, spec, reduce_only=False: sent.append((symbol, signed_diff))
                    or {"executed_qty": abs(signed_diff), "avg_price": 20000.0})
check(sent == [], f"position nan on a rollover's old contract: MXF (the new one) waits (sent {sent})")
os.remove("state/contract_rollover.json")

# ── crypto untouched ────────────────────────────────────────────────────────
setup({"btc": ("BTCUSDT", 0.505, 100, "binance", None),
       "txf": ("TXF", 0.5, 1, "capital", LOTS)})
target = portfolio.aggregate_portfolio()
check(abs(signed(target["BTCUSDT"]) - 50.5) < 1e-9,
      f"notional row stays 50.5 (got {signed(target['BTCUSDT'])})")
check(signed(target["TXF"]) == 1, "lot row beside it still rounds")

print(f"\n{'all ok' if not fails else f'{fails} FAILED'}")
sys.exit(1 if fails else 0)
