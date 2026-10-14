"""A kept member with no exchange (an unbind keeps the portfolio, Wei 10-14) is "no venue for now",
not "removed": lib/portfolio holds the keys it trades as they are — no close-on-removal, no entry —
in both diff modes; a member not in `amounts` still closes; once the 下單設定 save routes it, it
trades normally. The runtime's NEEDS_ROUTING start gate is in check_unbind_rebind_account_state.py.

Run: cd blave-agent && .venv/bin/python tests/check_unrouted_member_hold.py
"""
import json
import os
import shutil
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(tempfile.mkdtemp(prefix="unrouted-"))

from lib import portfolio  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


LOTS = {"type": "futures_contracts", "contract_value": 200, "currency": "TWD", "lot_size": 1}


def setup(members, exchanges, self_ledger):
    """members: {name: (symbol, position, amount, spec)}"""
    for d in ("manager", "strategies", "state"):
        shutil.rmtree(d, ignore_errors=True)
    os.makedirs("manager")
    os.makedirs("state")
    cfg = {"self_ledger": self_ledger, "amounts": {}, "exchanges": exchanges, "asset_specs": {}}
    for name, (sym, pos, amount, spec) in members.items():
        os.makedirs(f"strategies/{name}")
        json.dump({"symbol": sym, "position": pos}, open(f"strategies/{name}/state.json", "w"))
        cfg["amounts"][name] = amount
        if spec:
            cfg["asset_specs"][name] = spec
    json.dump(cfg, open("manager/portfolio_config.json", "w"))


class Venue:
    def __init__(self, held):
        self.held, self.calls = dict(held), []

    def positions(self):
        return {k: {"side": "long" if v > 0 else "short", "size": abs(v)} for k, v in self.held.items() if v}

    def place(self, symbol, signed_diff, asset_spec, reduce_only=False):
        self.calls.append((symbol, signed_diff, reduce_only))
        self.held[symbol] = self.held.get(symbol, 0) + signed_diff
        return {"executed_qty": abs(signed_diff), "avg_price": 1.0}


_real = {n: getattr(portfolio, n) for n in ("book_ready", "claim_unvenued_rows", "resolve_pending",
                                            "_report_ledger_adoption", "settle_expired_months",
                                            "ledger_positions", "book_venue")}


def ledger_mode(v):
    portfolio.book_ready = lambda cfg=None: True
    portfolio.claim_unvenued_rows = lambda venue=None: None
    portfolio.resolve_pending = lambda t, a, c: set()
    portfolio._report_ledger_adoption = lambda: None
    portfolio.settle_expired_months = lambda actual, venue=None, now=None: None
    portfolio.book_venue = lambda: "capital"
    portfolio.ledger_positions = lambda venue=None: {k: dict(r) for k, r in v.positions().items()}


def account_mode():
    for n, f in _real.items():
        setattr(portfolio, n, f)


MEMBERS = {"txf_a": ("TXF", 1, 1, LOTS), "btc_a": ("BTCUSDT", 1, 100, None), "zero_a": ("ETHUSDT", 1, 0, None)}
for mode, self_ledger in (("account", False), ("ledger", True)):
    tag = f"[{mode}]"
    setup(MEMBERS, {"txf_a": "", "btc_a": "", "zero_a": ""}, self_ledger)
    v = Venue({"TXF": 1, "BTCUSDT": 100, "ETHUSDT": 50})
    ledger_mode(v) if self_ledger else account_mode()
    r = [(portfolio.reconcile(v.positions, v.place), list(v.calls))[1] for _ in range(2)]
    check(v.calls == [] and v.held == {"TXF": 1, "BTCUSDT": 100, "ETHUSDT": 50},
          f"{tag} rebind → start with the members unrouted: nothing of theirs is closed, nothing bought ({v.calls})")
    snap = json.load(open("manager/last_reconcile.json"))
    check(snap["target"].get("TXF", {}).get("unrouted") == ["txf_a"] and snap["target"]["TXF"].get("gated") is True,
          f"{tag} the snapshot says which member holds the key and why ({snap['target'].get('TXF')})")
    # a member no longer in amounts (removed) still closes
    cfg = json.load(open("manager/portfolio_config.json"))
    del cfg["amounts"]["btc_a"]
    del cfg["exchanges"]["btc_a"]
    json.dump(cfg, open("manager/portfolio_config.json", "w"))
    del v.calls[:]
    portfolio.reconcile(v.positions, v.place)
    check(("BTCUSDT", -100, True) in v.calls and not any(c[0] in ("TXF", "ETHUSDT") for c in v.calls),
          f"{tag} a member taken out of amounts closes as before; the unrouted ones stay held ({v.calls})")
    # routed by the save: trades normally
    cfg["exchanges"] = {"txf_a": "capital", "zero_a": "capital"}
    cfg["amounts"]["txf_a"] = 2
    json.dump(cfg, open("manager/portfolio_config.json", "w"))
    del v.calls[:]
    portfolio.reconcile(v.positions, v.place)
    check(("TXF", 1, False) in v.calls and ("ETHUSDT", -50, True) in v.calls,
          f"{tag} once routed: TXF tops up to 2, the 0-amount member's ETH closes ({v.calls})")
    # an unrouted member sharing a key with a routed one: the key is held whole (like a gated one)
    setup({"txf_a": ("TXF", 1, 1, LOTS), "txf_b": ("TXF", 1, 1, LOTS)}, {"txf_a": "capital", "txf_b": ""}, self_ledger)
    v = Venue({"TXF": 2})
    ledger_mode(v) if self_ledger else account_mode()
    portfolio.reconcile(v.positions, v.place)
    check(v.calls == [] and v.held == {"TXF": 2},
          f"{tag} shared key, one member unrouted: its lot is not closed by the routed member's round ({v.calls})")
account_mode()

print(f"\n{fails} FAILED" if fails else "\nall ok")
sys.exit(1 if fails else 0)
