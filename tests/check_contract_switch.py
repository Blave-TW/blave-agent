"""TXF / MXF / TMF contract switch, workspace side (lib/portfolio, lib/paper_data).

portfolio_config["contracts"] = {strategy: root} moves a TXF-family strategy to
another contract without touching the strategy. What must hold:

  K  the book key is the contract it trades (aggregate_portfolio, _strategy_key);
     a non-family symbol or a bad value is ignored; the UI mirror's copy wins
     when it carries the key, and a mirror WITHOUT the key keeps the config's
     (an old runtime's mirror must not turn 20 TMF into 20 TXF).
  S  the close of the contract switched away from is valued with that contract
     (cv 200 for TXF), not the strategy's new spec — paper refuses a fill whose
     contract_value differs from the held one.
  R  rollover through reconcile(): the old root's close goes first and the new
     root's entry waits until no other family root is above target — so a close
     that raises, fills nothing (IOC not taken) or is skipped (False) never
     leaves both contracts open, and under HALT the rollover is frozen whole
     (no close-only half, H); a filled close lets the entry go the next
     round; an entry that then fails leaves the account flat and is retried.
     Unrelated (crypto) entries are never held. Two strategies sharing TXF:
     switching one reduces TXF to the other's share (no close), and a long/short
     pair that netted to 0 enters both sides at once (nothing to reduce).
  P  paper prices a switched contract off any family strategy (exact match first).
  C  the snapshot says the running code honours overrides (caps).

Run: cd blave-agent && .venv/bin/python tests/check_contract_switch.py
"""
import json
import math
import os
import shutil
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(tempfile.mkdtemp(prefix="contract-switch-"))

from lib import guard, paper_data, portfolio  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


def spec(root):
    return {"type": "futures_contracts", "contract_value": portfolio.TXF_FAMILY_CONTRACT_VALUE[root],
            "currency": "TWD", "lot_size": 1, "margin": 1}


def setup(strategies, contracts=None, mirror=None, roll=None):
    """strategies: {name: (symbol, position, amount, asset_spec_root|None, exchange)}"""
    for d in ("manager", "strategies", "state"):
        shutil.rmtree(d, ignore_errors=True)
    os.makedirs("manager")
    os.makedirs("state")
    cfg = {"self_ledger": False, "amounts": {}, "exchanges": {}, "asset_specs": {}}
    if contracts is not None:
        cfg["contracts"] = contracts
    for name, (sym, pos, amount, root, ex) in strategies.items():
        os.makedirs(f"strategies/{name}")
        with open(f"strategies/{name}/state.json", "w") as f:
            json.dump({"symbol": sym, "position": pos}, f)
        with open(f"strategies/{name}/stats.json", "w") as f:
            json.dump({"symbol": sym}, f)
        cfg["amounts"][name] = amount
        cfg["exchanges"][name] = ex
        if root:
            cfg["asset_specs"][name] = spec(root)
    with open("manager/portfolio_config.json", "w") as f:
        json.dump(cfg, f)
    if roll:
        # what runtime _cmd_amounts records at the save: {strategy: (from, to)}
        with open(portfolio._ROLLOVER_PATH, "w") as f:
            json.dump({n: {"from": a, "to": b, "at": "t0"} for n, (a, b) in roll.items()}, f)
    if os.path.exists(portfolio._ROLLOVER_DONE_PATH):
        os.remove(portfolio._ROLLOVER_DONE_PATH)
    if mirror is not None:
        with open("manager/amounts.ui.json", "w") as f:
            json.dump(dict({"amounts": cfg["amounts"], "exchanges": cfg["exchanges"]}, **mirror), f)


def signed(row):
    return row["size"] if row["side"] == "long" else -row["size"] if row["side"] == "short" else 0


# ── K: book key ─────────────────────────────────────────────────────────────
check(portfolio.execution_symbol("a", "TXF", {"contracts": {"a": "TMF"}}) == "TMF", "TXF → TMF override")
check(portfolio.execution_symbol("a", "TXFR1", {"contracts": {"a": "MXF"}}) == "MXF", "R1 suffix is family")
check(portfolio.execution_symbol("a", "BTCUSDT", {"contracts": {"a": "TMF"}}) == "BTCUSDT",
      "non-family symbol ignores an override")
check(portfolio.execution_symbol("a", "TXF", {"contracts": {"a": "2330"}}) == "TXF", "bad value ignored")
check(portfolio.execution_symbol("a", "TXF", {}) == "TXF", "no contracts = SYMBOL")

setup({"s1": ("TXF", 1, 20, "TMF", "capital")}, contracts={"s1": "TMF"})
t = portfolio.aggregate_portfolio()
check(set(t) == {"TMF"} and signed(t["TMF"]) == 20, f"target keyed by the contract: {t and {k: signed(v) for k, v in t.items()}}")
check(t["TMF"]["asset_spec"]["contract_value"] == 10, "target carries the TMF spec")
check(portfolio._strategy_key("s1") == "TMF", "_strategy_key follows the override")

setup({"s1": ("TXF", 1, 1, "TXF", "capital")}, contracts={"s1": "TMF"}, mirror={"contracts": {}})
check(set(portfolio.aggregate_portfolio()) == {"TXF"}, "mirror contracts {} overrides the config's")
setup({"s1": ("TXF", 1, 20, "TMF", "capital")}, contracts={"s1": "TMF"}, mirror={})
check(set(portfolio.aggregate_portfolio()) == {"TMF"}, "mirror without the key keeps the config's (never read as {})")
setup({"s1": ("TXF", 1, 20, "TMF", "capital")}, contracts={}, mirror={"contracts": {"s1": "TMF"}})
check(set(portfolio.aggregate_portfolio()) == {"TMF"}, "mirror's override wins over a config without it")

# ── S: the switched-away contract's close spec ──────────────────────────────
setup({"s1": ("TXF", 1, 20, "TMF", "paper")}, contracts={"s1": "TMF"})
cfg = portfolio.load_portfolio_config()
rs = portfolio.removed_asset_specs(cfg, portfolio.aggregate_portfolio())
check(rs.get("TXF", {}).get("contract_value") == 200, f"TXF close valued at 200, got {rs.get('TXF')}")
check(rs.get("MXF", {}).get("contract_value") == 50, "MXF at 50")
check("TMF" not in rs, "the traded contract is not a removed row")
setup({"s1": ("TXF", 1, 1, "TXF", "paper")})  # switched back: spec says TXF again
rs = portfolio.removed_asset_specs(portfolio.load_portfolio_config(), portfolio.aggregate_portfolio())
check(rs.get("TMF", {}).get("contract_value") == 10, f"switch back: TMF close valued at 10, got {rs.get('TMF')}")
setup({"b": ("BTCUSDT", 1, 100, None, "binance")})
check(portfolio.removed_asset_specs(portfolio.load_portfolio_config(), {}) == {},
      "no family strategy = no synthesized spec")


# ── R: rollover through reconcile() ─────────────────────────────────────────
class Venue:
    """Account in lots (crypto in USD), the order fn records every call."""

    def __init__(self, held, close=None, entry=None):
        self.held = dict(held)
        self.calls = []
        self.close, self.entry = close, entry  # None = fill; 'raise' / 'none' / 'skip'

    def positions(self):
        return {k: {"side": "long" if v > 0 else "short", "size": abs(v)}
                for k, v in self.held.items() if v}

    def place(self, symbol, signed_diff, asset_spec, reduce_only=False):
        self.calls.append((symbol, signed_diff, reduce_only))
        mode = self.close if reduce_only else self.entry
        if mode == "raise":
            raise RuntimeError(f"{symbol}: broker refused")
        if mode == "skip":
            return False
        lots = math.floor(abs(signed_diff) + 0.5) if symbol in portfolio.TXF_FAMILY else abs(signed_diff)
        if mode == "none":
            return {"executed_qty": 0.0, "avg_price": 20000.0}
        self.held[symbol] = self.held.get(symbol, 0) + math.copysign(lots, signed_diff)
        return {"executed_qty": lots, "avg_price": 20000.0}

    def round(self):
        del self.calls[:]
        portfolio.reconcile(self.positions, self.place)
        return list(self.calls)


def switched(held=None, **kw):
    setup({"s1": ("TXF", 1, 20, "TMF", "capital")}, contracts={"s1": "TMF"}, roll={"s1": ("TXF", "TMF")})
    return Venue(held if held is not None else {"TXF": 1}, **kw)


v = switched()
r1 = v.round()
check(r1 == [("TXF", -1, True)], f"R1 round 1: only the TXF close goes, got {r1}")
r2 = v.round()
check(r2 == [("TMF", 20, False)], f"R1 round 2: TMF entry after the close filled, got {r2}")
check(v.held == {"TXF": 0, "TMF": 20}, f"R1 ends on 20 TMF, got {v.held}")
check(v.round() == [], "R1 round 3: converged")

for mode, label in (("raise", "close raises"), ("none", "close fills nothing (IOC not taken)"),
                    ("skip", "close skipped (False)")):
    v = switched(close=mode)
    rounds = [v.round() for _ in range(3)]
    check(all(r == [("TXF", -1, True)] for r in rounds) and v.held.get("TMF", 0) == 0,
          f"R2 {label}: TMF never opens on top of TXF ({rounds})")

v = switched(entry="raise")
v.round()
r2 = v.round()
check(r2 == [("TMF", 20, False)] and v.held.get("TXF") == 0 and not v.held.get("TMF"),
      f"R3 entry fails after the close: flat, nothing doubled ({r2}, {v.held})")
v.entry = None
check(v.round() == [("TMF", 20, False)] and v.held["TMF"] == 20, "R3 next round retries the entry")

v = switched(held={"TXF": 2})  # partial: close 2, broker fills 1
calls = []


def place_partial(symbol, signed_diff, asset_spec, reduce_only=False):
    calls.append((symbol, signed_diff, reduce_only))
    if reduce_only:
        v.held[symbol] -= 1
        return {"executed_qty": 1.0, "avg_price": 20000.0}
    v.held[symbol] = v.held.get(symbol, 0) + signed_diff
    return {"executed_qty": abs(signed_diff), "avg_price": 20000.0}


portfolio.reconcile(v.positions, place_partial)
portfolio.reconcile(v.positions, place_partial)
check(calls == [("TXF", -2, True), ("TXF", -1, True)] and not v.held.get("TMF"),
      f"R4 partial close: entry waits until the old root is flat ({calls})")
portfolio.reconcile(v.positions, place_partial)
check(calls[-1] == ("TMF", 20, False), "R4 then the entry goes")

setup({"s1": ("TXF", 1, 20, "TMF", "capital"), "b": ("BTCUSDT", 1, 100, None, "capital")},
      contracts={"s1": "TMF"}, roll={"s1": ("TXF", "TMF")})
v = Venue({"TXF": 1}, close="raise")
r1 = v.round()
check(("BTCUSDT", 100, False) in r1 and not any(c[0] == "TMF" for c in r1),
      f"R5 a failing TXF close holds TMF only, crypto still trades ({r1})")
check(r1[0][0] == "TXF", f"R5 reduces go before entries ({r1})")

guard.trip_halt("test", "test")
v = switched()
r = [v.round(), v.round()]
check(r == [[], []] and v.held == {"TXF": 1},
      f"R6 HALT: the rollover is frozen whole — no close, no open ({r})")
guard.clear_halt("test")
guard._halt_flag = False

setup({"a": ("TXF", 1, 1, "TXF", "capital"), "b": ("TXF", 1, 20, "TMF", "capital")},
      contracts={"b": "TMF"}, roll={"b": ("TXF", "TMF")})
v = Venue({"TXF": 2})
r1, r2 = v.round(), v.round()
check(r1 == [("TXF", -1, True)] and r2 == [("TMF", 20, False)] and v.held == {"TXF": 1, "TMF": 20},
      f"R7 shared TXF (2 held), switch one: TXF reduces to the other's 1, then TMF ({r1}, {r2})")

setup({"a": ("TXF", 1, 1, "TXF", "capital"), "b": ("TXF", -1, 20, "TMF", "capital")},
      contracts={"b": "TMF"}, roll={"b": ("TXF", "TMF")})
v = Venue({})
r1 = sorted(v.round())
check(r1 == [("TMF", -20, False), ("TXF", 1, False)],
      f"R8 long/short pair netted to 0: both sides open at once, nothing to reduce ({r1})")

setup({"s1": ("TXF", 1, 1, "TXF", "capital")}, roll={"s1": ("TMF", "TXF")})  # switched back from TMF
v = Venue({"TMF": 20})
r1, r2 = v.round(), v.round()
check(r1 == [("TMF", -20, True)] and r2 == [("TXF", 1, False)], f"R9 switch back TMF → TXF ({r1}, {r2})")

# ── R10–R12 (audit P0-1 / P0-2), self_ledger off and on ─────────────────────
_real = {n: getattr(portfolio, n) for n in ("own_positions_only", "book_ready", "claim_unvenued_rows",
                                            "resolve_pending", "_report_ledger_adoption",
                                            "settle_expired_months", "ledger_positions", "book_venue")}


def ledger_mode(v):
    """self_ledger on: the book IS this venue's holdings (what orders.jsonl would sum to)."""
    portfolio.own_positions_only = lambda cfg: True
    portfolio.book_ready = lambda cfg=None: True
    portfolio.claim_unvenued_rows = lambda venue=None: None
    portfolio.resolve_pending = lambda t, a, c: set()
    portfolio._report_ledger_adoption = lambda: None
    portfolio.settle_expired_months = lambda actual, venue=None, now=None: None
    portfolio.book_venue = lambda: "paper"
    portfolio.ledger_positions = lambda venue=None: {k: dict(r) for k, r in v.positions().items()}


def account_mode():
    for n, f in _real.items():
        setattr(portfolio, n, f)


def gate(**names):
    with open("state/signal_gate.json", "w") as f:
        json.dump(names, f)


for mode in ("account", "ledger"):
    tag = f"[{mode}]"
    # P0-1: a long/short pair on TXF, the long one moves to TMF: TXF's book +1
    # must flip to −1 — the same size on the other side is still a close to make
    setup({"a": ("TXF", 1, 40, "TMF", "capital"), "b": ("TXF", -1, 1, "TXF", "capital")},
          contracts={"a": "TMF"}, roll={"a": ("TXF", "TMF")})
    v = Venue({"TXF": 1}, close="raise")
    ledger_mode(v) if mode == "ledger" else account_mode()
    rounds = [v.round() for _ in range(2)]
    check(all(not any(c[0] == "TMF" for c in r) for r in rounds) and not v.held.get("TMF"),
          f"R10 {tag} old contract flips (+1 → −1), its close fails: TMF never opens ({rounds})")
    v.close = None
    r = [v.round(), v.round()]
    check(v.held == {"TXF": -1, "TMF": 40}, f"R10 {tag} once the flip filled, TMF opens ({r}, {v.held})")

    setup({"a": ("TXF", 1, 40, "TMF", "capital"), "b": ("TXF", -2, 1, "TXF", "capital")},
          contracts={"a": "TMF"}, roll={"a": ("TXF", "TMF")})
    v = Venue({"TXF": 1}, close="raise")
    ledger_mode(v) if mode == "ledger" else account_mode()
    r1 = v.round()
    check(not any(c[0] == "TMF" for c in r1), f"R11 {tag} book +1 under target −2 (other side, smaller): TMF held ({r1})")

    # P0-2: the other TXF strategy starts waiting for a new signal after the save
    setup({"a": ("TXF", 1, 20, "TMF", "capital"), "b": ("TXF", 1, 1, "TXF", "capital")},
          contracts={"a": "TMF"}, roll={"a": ("TXF", "TMF")})
    v = Venue({"TXF": 2})
    ledger_mode(v) if mode == "ledger" else account_mode()
    gate(b=1.0)
    rounds = [v.round() for _ in range(2)]
    check(all(not any(c[0] == "TMF" for c in r) for r in rounds) and v.held == {"TXF": 2},
          f"R12 {tag} TXF gated mid-rollover with 2 held over its 1: TMF waits ({rounds}, {v.held})")
    os.remove("state/signal_gate.json")
    r = [v.round(), v.round()]
    check(v.held == {"TXF": 1, "TMF": 20}, f"R12 {tag} gate gone: close then TMF ({r}, {v.held})")
account_mode()

setup({"s1": ("TXFR1", 1, 1, "TXF", "capital")}, roll={"s1": ("TMF", "TXF")})  # back from TMF onto R1
v = Venue({"TMF": 20}, close="raise")
r1 = v.round()
check(portfolio.is_txf_family_key("TXFR1") and not any(c[0] == "TXFR1" for c in r1),
      f"R13 TXFR1 is in the family: its entry waits on TMF's close ({r1})")

setup({"s1": ("TXF", 1, 20, "TMF", "paper")}, contracts={"s1": "TMF"})
cfg = portfolio.load_portfolio_config()
cfg["asset_specs"]["s1"]["capital_symbol"] = "TM0000"
rs = portfolio.removed_asset_specs(cfg, portfolio.aggregate_portfolio())
check("capital_symbol" not in rs["TXF"] and set(rs["TXF"]) == {"type", "currency", "lot_size", "contract_value"},
      f"S the switched-away row copies unit fields only ({rs['TXF']})")

# ── X: only the rollover's new contract waits (re-audit P1) ─────────────────
def rolls_file():
    """the OPEN records: the runtime's file minus what the lib marked done"""
    return portfolio._load_rollovers()


v = switched()
v.round()
check(rolls_file() == {"s1": {"from": "TXF", "to": "TMF", "at": "t0"}}, "X1 record kept while TXF still to close")
snap = json.load(open("manager/last_reconcile.json"))
check(snap.get("rollovers") == [{"strategy": "s1", "from": "TXF", "to": "TMF", "since": "t0", "state": "closing"}],
      f"X1 snapshot shows the rollover as closing ({snap.get('rollovers')})")
v.round()
check(rolls_file() == {} and v.held.get("TMF") == 20, f"X1 old contract flat: record cleared, TMF opened ({rolls_file()})")
check("rollovers" not in json.load(open("manager/last_reconcile.json")), "X1 snapshot carries no rollover once done")

# the audit repro, no switch anywhere: b waits on TXF (same direction 1.0 → 0.5, 2 held over 1)
setup({"b": ("TXF", 0.5, 2, "TXF", "capital"), "c": ("MXF", 1, 1, "MXF", "capital")})
gate(b=1.0)
v = Venue({"TXF": 2})
r = v.round()
check(r == [("MXF", 1.0, False)], f"X2 no rollover: a waiting TXF never holds another strategy's MXF entry ({r})")
os.remove("state/signal_gate.json")

# a rollover TXF → TMF does not hold an unrelated MXF entry
setup({"s1": ("TXF", 1, 20, "TMF", "capital"), "c": ("MXF", 1, 1, "MXF", "capital")},
      contracts={"s1": "TMF"}, roll={"s1": ("TXF", "TMF")})
v = Venue({"TXF": 1}, close="raise")
r = v.round()
check(("MXF", 1.0, False) in r and not any(c[0] == "TMF" for c in r),
      f"X3 rollover TXF→TMF holds TMF only, MXF trades ({r})")

setup({"a": ("TXF", 1, 20, "TMF", "capital"), "b": ("TXF", 1, 1, "TXF", "capital")},
      contracts={"a": "TMF"}, roll={"a": ("TXF", "TMF")})
gate(b=1.0)
Venue({"TXF": 2}).round()
rows = json.load(open("manager/last_reconcile.json")).get("rollovers") or []
check([r.get("state") for r in rows] == ["waiting_gate"], f"X4 snapshot: old contract held by a waiting strategy ({rows})")
os.remove("state/signal_gate.json")

setup({"s1": ("TXF", 1, 20, "TMF", "capital"), "c": ("MXF", 1, 1, "MXF", "capital")}, contracts={"s1": "TMF"})
with open(portfolio._ROLLOVER_PATH, "w") as f:
    f.write("{broken")
r = Venue({"TXF": 1}, close="raise").round()
check(not any(c[0] in ("TMF", "MXF") for c in r), f"X5 record unreadable: every family entry waits on TXF ({r})")

setup({"s1": ("TXF", 1, 20, "TMF", "capital")}, contracts={"s1": "TMF"}, roll={"s1": ("TXF", "TMF")})
r = Venue({}).round()
check(r == [("TMF", 20.0, False)] and rolls_file() == {},
      f"X6 nothing held on the old contract: record cleared, entry goes the same round ({r})")

# P0-3: the save lands while a round still runs on the OLD config — that round
# must not finish the record off a book that matches the old target
setup({"a": ("TXF", 1, 1, "TXF", "capital")}, roll={"a": ("TXF", "TMF")})
v = Venue({"TXF": 1})
v.round()
check(set(rolls_file() or {}) == {"a"}, f"X7 old-config round leaves the record open ({rolls_file()})")
# the save's config lands now — state/ (record, done-marks) is left as the round left it
cfg = json.load(open("manager/portfolio_config.json"))
cfg.update(amounts={"a": 20}, contracts={"a": "TMF"}, asset_specs={"a": spec("TMF")})
json.dump(cfg, open("manager/portfolio_config.json", "w"))
v.close = "raise"
rounds = [v.round(), v.round()]
check(all(not any(c[0] == "TMF" for c in r) for r in rounds) and v.held == {"TXF": 1},
      f"X7 …then the new config with a failing close: TMF never opens ({rounds}, {v.held})")

# M1: a round waiting on its baseline (book not trusted) finishes nothing
setup({"s1": ("TXF", 1, 20, "TMF", "capital")}, contracts={"s1": "TMF"}, roll={"s1": ("TXF", "TMF")})
saved = {n: getattr(portfolio, n) for n in ("own_positions_only", "book_ready", "_auto_baseline",
                                            "_baseline_stuck", "_pending_symbols")}
portfolio.own_positions_only = lambda cfg: True
portfolio.book_ready = lambda cfg=None: False
portfolio._auto_baseline = lambda *a, **k: {"reason": "confirming", "symbols": []}
portfolio._baseline_stuck = lambda w: False
portfolio._pending_symbols = lambda venue: set()
Venue({}).round()
for n, f in saved.items():
    setattr(portfolio, n, f)
check(set(rolls_file() or {}) == {"s1"}, f"X8 baseline wait: the empty book does not finish the record ({rolls_file()})")

# M2: a done-mark for an older `at` does not finish a record the runtime rewrote since
setup({"s1": ("TXF", 1, 20, "TMF", "capital")}, contracts={"s1": "TMF"}, roll={"s1": ("TXF", "TMF")})
json.dump({"s1": "older"}, open(portfolio._ROLLOVER_DONE_PATH, "w"))
r = Venue({"TXF": 1}, close="raise").round()
check(set(rolls_file() or {}) == {"s1"} and not any(c[0] == "TMF" for c in r),
      f"X9 done-mark of another `at`: record still open, TMF held ({r})")
json.dump({"s1": "t0"}, open(portfolio._ROLLOVER_DONE_PATH, "w"))
check(rolls_file() == {}, "X9 …a done-mark with the record's own `at` closes it")
with open(portfolio._ROLLOVER_PATH, "w") as f:  # the runtime's records carry a per-write id
    json.dump({"s1": {"from": "TXF", "to": "TMF", "at": "t0", "id": "i2"}}, f)
check(set(rolls_file() or {}) == {"s1"}, "X9 …with an id, a done-mark of the `at` alone does not close it")
json.dump({"s1": "i2"}, open(portfolio._ROLLOVER_DONE_PATH, "w"))
check(rolls_file() == {}, "X9 …the id does")
os.remove(portfolio._ROLLOVER_DONE_PATH)

# P1-C: the old contract is waiting on a baseline decision (seed pending) — not finished
setup({"s1": ("TXF", 1, 20, "TMF", "capital")}, contracts={"s1": "TMF"}, roll={"s1": ("TXF", "TMF")})
rows, hold = portfolio._rollovers_this_round({}, {}, True, portfolio.load_portfolio_config(),
                                             waiting_keys={"TXF"})
check(hold == {"TMF": ["TXF"]} and set(rolls_file() or {}) == {"s1"},
      f"X10 old contract in the seed's pending: TMF held, record open ({hold})")
rows, hold = portfolio._rollovers_this_round({}, {}, True, portfolio.load_portfolio_config())
check(hold == {} and rolls_file() == {}, "X10 …once decided (flat), the record finishes")

# unpicked while the old contract still closes: `to` null holds nothing, finishes once flat
setup({"c": ("MXF", 1, 1, "MXF", "capital")}, roll={"s1": ("TMF", None)})
with open(portfolio._ROLLOVER_PATH, "w") as f:
    json.dump({"s1": {"from": "TMF", "to": None, "at": "t0"}}, f)
v = Venue({"TMF": 20}, close="raise")
r = v.round()
check(("MXF", 1.0, False) in r and set(rolls_file() or {}) == {"s1"}, f"X11 unpicked rollover holds nothing, stays open ({r})")
v.close = None
v.round()
check(set(rolls_file() or {}) == {"s1"}, "X11 …the closing round still started with TMF held: open")
v.round()
check(rolls_file() == {}, f"X11 …finished once TMF is flat ({rolls_file()})")

# ── H: HALT freezes a rollover whole (Wei 10-14) ────────────────────────────
v = switched()
guard.trip_halt("test", "test")
r = [v.round(), v.round()]
snap = json.load(open("manager/last_reconcile.json"))
check(r == [[], []] and v.held == {"TXF": 1},
      f"H1 HALT: the old contract is NOT closed either (no half rollover) ({r}, {v.held})")
check([x.get("state") for x in snap.get("rollovers", [])] == ["halted"] and set(rolls_file() or {}) == {"s1"},
      f"H1 snapshot says halted, record open ({snap.get('rollovers')})")
check("rollover_halt_freeze" in snap.get("caps", []) and "halt_freeze" in snap.get("caps", []),
      "H1 caps say the running code freezes")
guard.clear_halt("test")
guard._halt_flag = False
r = [v.round(), v.round()]
check(r == [[("TXF", -1, True)], [("TMF", 20.0, False)]] and v.held == {"TXF": 0, "TMF": 20},
      f"H2 after 啟動下單 (HALT lifted): close first, then open ({r})")

# a restart that keeps HALT (restart_reconciler, boot): a fresh process, halted at its start
v = switched()
open("state/HALT", "w").write("{}")
r = v.round()
check(r == [] and v.held == {"TXF": 1}, f"H3 restart under HALT: nothing sent, no close-only half ({r})")
os.remove("state/HALT")
guard._halt_flag = False

# an unpicked rollover (nothing to open) is a plain close: HALT holds it like any close
setup({"c": ("MXF", 1, 1, "MXF", "capital")})
with open(portfolio._ROLLOVER_PATH, "w") as f:
    json.dump({"s1": {"from": "TMF", "to": None, "at": "t0"}}, f)
guard.trip_halt("test", "test")
v = Venue({"TMF": 20, "MXF": 3})
r = v.round()
check(r == [] and v.held == {"TMF": 20, "MXF": 3},
      f"H4 HALT: an unpicked rollover's close and an unrelated reduce wait too ({r})")
guard.clear_halt("test")
guard._halt_flag = False
r = v.round()
check(("TMF", -20, True) in r and ("MXF", -2, True) in r,
      f"H4 …after 啟動下單 both closes go ({r})")

setup({"s1": ("TXF", 1, 20, "TMF", "capital"), "c": ("MXF", 0, 1, "MXF", "capital")}, contracts={"s1": "TMF"})
with open(portfolio._ROLLOVER_PATH, "w") as f:
    f.write("{broken")
guard.trip_halt("test", "test")
r = Venue({"TXF": 1, "MXF": 1}).round()
check(r == [], f"H5 HALT + record unreadable: no family leg at all ({r})")
rows = json.load(open("manager/last_reconcile.json")).get("rollovers")
check([x.get("state") for x in rows or []] == ["record_unreadable"], f"H5 the page is told why ({rows})")
guard.clear_halt("test")
guard._halt_flag = False


def halted_rounds(v, n=2):
    guard.trip_halt("test", "test")
    r = [v.round() for _ in range(n)]
    guard.clear_halt("test")
    guard._halt_flag = False
    return r


# only the rolling strategy's share is held: another strategy on the OLD contract exits
setup({"a": ("TXF", 1, 20, "TMF", "capital"), "b": ("TXF", 0, 1, "TXF", "capital")},
      contracts={"a": "TMF"}, roll={"a": ("TXF", "TMF")})
v = Venue({"TXF": 2})
r = halted_rounds(v)
check(r == [[], []] and v.held == {"TXF": 2},
      f"H6 HALT: nothing goes — not b's exit on TXF, not a's rollover ({r}, {v.held})")
r = [v.round(), v.round()]
check(v.held == {"TXF": 0, "TMF": 20}, f"H6 …after 啟動下單: close a's lot, then TMF ({r}, {v.held})")

# the rolling strategy's own signal goes flat while halted: its exit goes
setup({"a": ("TXF", 0, 20, "TMF", "capital")}, contracts={"a": "TMF"}, roll={"a": ("TXF", "TMF")})
v = Venue({"TXF": 1})
r = halted_rounds(v)
check(r == [[], []] and v.held.get("TXF") == 1,
      f"H7 HALT: the rolling strategy's own exit to flat waits too ({r}, {v.held})")
r = [v.round(), v.round()]
check(v.held.get("TXF") == 0 and not v.held.get("TMF"),
      f"H7 …after 啟動下單 the exit goes, nothing opens ({r}, {v.held})")

# a strategy on the NEW contract that never switched exits while halted
setup({"a": ("TXF", 1, 20, "TMF", "capital"), "c": ("TMF", 0, 5, "TMF", "capital")},
      contracts={"a": "TMF"}, roll={"a": ("TXF", "TMF")})
v = Venue({"TXF": 1, "TMF": 5})
r = halted_rounds(v)
check(r == [[], []] and v.held == {"TXF": 1, "TMF": 5},
      f"H8 HALT: c's exit on TMF waits, the old TXF lot stays ({r}, {v.held})")
r = [v.round(), v.round(), v.round()]
check(v.held == {"TXF": 0, "TMF": 20},
      f"H8 …after 啟動下單: c exits, a rolls close-first ({r}, {v.held})")

# a small switch: the share on the old contract would round to 0 (1 TXF → 9 TMF = 0.45 TXF)
for lots in (9, 1):
    setup({"a": ("TXF", 1, lots, "TMF", "capital")}, contracts={"a": "TMF"}, roll={"a": ("TXF", "TMF")})
    v = Venue({"TXF": 1})
    r = halted_rounds(v)
    check(r == [[], []] and v.held == {"TXF": 1},
          f"H10 1 TXF → {lots} TMF under HALT: at least 1 lot held on TXF, no close-only half ({r}, {v.held})")
    r = [v.round(), v.round()]
    check(v.held == {"TXF": 0, "TMF": lots}, f"H10 …after 啟動下單: close, then {lots} TMF ({r}, {v.held})")

# the hold never reaches past the book
rolls = [{"strategy": "a", "from": "TXF", "to": "TMF"}]
tgt = {"TMF": {"side": "long", "size": 20, "contributors": [{"strategy": "a", "contribution": 20.0}]},
       "TXF": {"side": "long", "size": 1, "contributors": [{"strategy": "b", "contribution": 1.0}]}}
h = portfolio._halt_rollover_targets(rolls, tgt, {"TXF": {"side": "long", "size": 1}})
check(h.get("TXF") == 1 and h.get("TMF") == 0,
      f"H11 b holds 1 TXF, a's lot already closed: the hold stays at the book's 1, not 2 ({h})")
h = portfolio._halt_rollover_targets(rolls, {"TMF": tgt["TMF"]}, {})
check(h.get("TXF") == 0, f"H11 nothing held on TXF: no 1-lot hold to buy ({h})")
h = portfolio._halt_rollover_targets(rolls, {"TMF": tgt["TMF"]}, {"TXF": {"side": "long", "size": 3}})
check(h.get("TXF") == 1, f"H11 3 held, a's share 1: holds 1, the rest closes ({h})")

# HALT lands mid-round (after the round's start): the old contract's close is held too
v = switched()
real_positions = v.positions


def positions_then_halt():
    guard.trip_halt("test", "test")  # the user pressed stop while this round read the account
    return real_positions()


v.positions = positions_then_halt
r = v.round()
v.positions = real_positions
guard.clear_halt("test")
guard._halt_flag = False
check(r == [] and v.held == {"TXF": 1}, f"H9 halted mid-round: no close-only half ({r}, {v.held})")

# ── P: paper prices the switched contract ───────────────────────────────────
for d in ("strategies",):
    shutil.rmtree(d, ignore_errors=True)
for name, sym in (("txf_a", "TXF"), ("eth_a", "ETHUSDT")):
    os.makedirs(f"strategies/{name}")
    with open(f"strategies/{name}/strategy.py", "w") as f:
        f.write(f'SYMBOL = "{sym}"\nINTERVAL = "1h"\n\ndef fetch_data(h):\n    return None\n')
check(paper_data._resolve_strategy("TMF") == "txf_a", "P paper: TMF priced by the TXF strategy")
check(paper_data._resolve_strategy("BTCUSDT") is None, "P paper: no cross-symbol match outside the family")
os.makedirs("strategies/tmf_a")
with open("strategies/tmf_a/strategy.py", "w") as f:
    f.write('SYMBOL = "TMF"\nINTERVAL = "1h"\n\ndef fetch_data(h):\n    return None\n')
check(paper_data._resolve_strategy("TMF") == "tmf_a", "P paper: an exact SYMBOL match comes first")

# ── C: caps in the snapshot ─────────────────────────────────────────────────
setup({"s1": ("TXF", 1, 20, "TMF", "capital")}, contracts={"s1": "TMF"})
Venue({}).round()
with open("manager/last_reconcile.json") as f:
    snap = json.load(f)
check("contract_override" in snap.get("caps", []), f"C snapshot caps: {snap.get('caps')}")

print(f"\n{fails} FAILED" if fails else "\nall ok")
sys.exit(1 if fails else 0)
