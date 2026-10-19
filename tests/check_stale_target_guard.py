"""A funded Type A/C member whose scheduled tick keeps failing leaves state.json at its last good
target. lib/portfolio holds that member's OWN share of the key: it may shrink toward 0 (reduce,
close, a flip's close half), never grow or open the other side; the other members on the key trade
as computed. Stale = state/bar_wait/<name>.json last_attempt_failed_at newer than state.json and
at most TARGET_STALE_RECENT_S old (a failing strategy fails again every few minutes; one failure
at the start of a data gap must not cover the whole gap), and state.json older than
max(TARGET_STALE_BARS × INTERVAL, TARGET_STALE_FLOOR_S), + TARGET_STALE_WEEKEND_S for daily bars.
Type B (no INTERVAL) is not judged.

Run: cd blave-agent && .venv/bin/python tests/check_stale_target_guard.py
"""
import json
import os
import shutil
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(tempfile.mkdtemp(prefix="stale-target-"))

from lib import portfolio  # noqa: E402

fails = 0
NOW = time.time()
H, D = 3600, 86400


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


def setup(members, self_ledger):
    """members: {name: (state, interval|None, state_age_s, failed_ago_s|None)}"""
    for d in ("manager", "strategies", "state"):
        shutil.rmtree(d, ignore_errors=True)
    os.makedirs("manager")
    os.makedirs("state/bar_wait")
    cfg = {"self_ledger": self_ledger, "amounts": {}, "exchanges": {}, "asset_specs": {}}
    for name, (state, interval, age, failed_ago) in members.items():
        os.makedirs(f"strategies/{name}")
        with open(f"strategies/{name}/strategy.py", "w") as f:
            f.write(f'INTERVAL = "{interval}"\n' if interval else "# Type:     B (screener)\n")
        path = f"strategies/{name}/state.json"
        json.dump(state, open(path, "w"))
        os.utime(path, (NOW - age, NOW - age))
        json.dump({"last_processed_bar": None,
                   "last_attempt_failed_at": None if failed_ago is None else NOW - failed_ago},
                  open(f"state/bar_wait/{name}.json", "w"))
        cfg["amounts"][name] = 100
        cfg["exchanges"][name] = "paper"
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
                                            "ledger_positions", "book_venue", "drift_band")}


def mode(v, self_ledger):
    for n, f in _real.items():
        setattr(portfolio, n, f)
    portfolio.drift_band = lambda symbol: portfolio._DRIFT_BAND_FLOOR  # no kline fetch
    if self_ledger:
        portfolio.book_ready = lambda cfg=None: True
        portfolio.claim_unvenued_rows = lambda venue=None: None
        portfolio.resolve_pending = lambda t, a, c: set()
        portfolio._report_ledger_adoption = lambda: None
        portfolio.settle_expired_months = lambda actual, venue=None, now=None: None
        portfolio.book_venue = lambda: "paper"
        portfolio.ledger_positions = lambda venue=None: {k: dict(r) for k, r in v.positions().items()}


def run(members, held, self_ledger):
    setup(members, self_ledger)
    v = Venue(held)
    mode(v, self_ledger)
    portfolio.reconcile(v.positions, v.place)
    return v


LONG = {"symbol": "BTCUSDT", "position": 1}
FLAT = {"symbol": "BTCUSDT", "position": 0}
SHORT = {"symbol": "BTCUSDT", "position": -1}
ETH = {"symbol": "ETHUSDT", "position": 1}
FAILING = (3 * H, 60)  # a 1h target 3h old, the last tick failed a minute ago


def last_order():
    try:
        return json.loads(open("manager/orders.jsonl").read().strip().splitlines()[-1])
    except (OSError, IndexError, ValueError):
        return None


for self_ledger in (False, True):
    tag = "[ledger]" if self_ledger else "[account]"
    v = run({"s": (LONG, "1h", *FAILING)}, {}, self_ledger)
    check(v.calls == [], f"{tag} stale long, nothing held: its share is not bought ({v.calls})")
    snap = json.load(open("manager/last_reconcile.json"))
    row = snap["target"]["BTCUSDT"]
    check(row.get("stale_target") == ["s"] and row.get("stale_held") == 0 and row.get("size") == 0,
          f"{tag} the snapshot names the stale member and shows what is held ({row})")
    v = run({"s": (LONG, "1h", *FAILING)}, {"BTCUSDT": 40}, self_ledger)
    check(v.calls == [], f"{tag} stale: no top-up of a held position ({v.calls})")
    v = run({"s": (FLAT, "1h", *FAILING)}, {"BTCUSDT": 100}, self_ledger)
    check(v.calls == [("BTCUSDT", -100, True)], f"{tag} stale flat target: the close still goes ({v.calls})")
    v = run({"s": (SHORT, "1h", *FAILING)}, {"BTCUSDT": 100}, self_ledger)
    lo = last_order() or {}
    check(v.calls == [("BTCUSDT", -100, True)] and not lo.get("failed"),
          f"{tag} stale flip: the long closes, no short opens, the close is not logged failed "
          f"({v.calls}, failed={lo.get('failed')})")
    v = run({"s": ({"symbol": "BTCUSDT", "position": 0.5}, "1h", *FAILING)}, {"BTCUSDT": 100}, self_ledger)
    check(v.calls == [("BTCUSDT", -50, True)], f"{tag} stale: a reduce goes ({v.calls})")
    # the other members on the key
    v = run({"s": (FLAT, "1h", *FAILING), "f": (LONG, "1h", 60, None)}, {}, self_ledger)
    check(v.calls == [("BTCUSDT", 100, False)],
          f"{tag} shared key, stale member flat, fresh member long: the fresh entry goes ({v.calls})")
    v = run({"s": (LONG, "1h", *FAILING), "f": (LONG, "1h", 60, None)}, {}, self_ledger)
    check(v.calls == [("BTCUSDT", 100, False)],
          f"{tag} shared key, both long: only the fresh member's 100 is bought, not the stale 100 ({v.calls})")
    v = run({"s": (LONG, "1h", *FAILING), "f": (FLAT, "1h", 60, None)}, {"BTCUSDT": 200}, self_ledger)
    check(v.calls == [("BTCUSDT", -100, True)],
          f"{tag} shared key, book above the stale share: it trims to the stale 100 ({v.calls})")
    v = run({"s": (LONG, "1h", *FAILING), "g": (ETH, "1h", 60, None)}, {}, self_ledger)
    check(v.calls == [("ETHUSDT", 100, False)], f"{tag} another key is untouched ({v.calls})")
    # not stale
    v = run({"s": (LONG, "1h", 30 * 60, None)}, {}, self_ledger)
    check(v.calls == [("BTCUSDT", 100, False)], f"{tag} fresh target, no failure: entry ({v.calls})")
    v = run({"s": (LONG, "1h", 3 * H, None)}, {}, self_ledger)
    check(v.calls == [("BTCUSDT", 100, False)],
          f"{tag} old target, no failure (data stall / closed market): entry ({v.calls})")
    v = run({"s": (LONG, "1h", 3 * H, 4 * H)}, {}, self_ledger)
    check(v.calls == [("BTCUSDT", 100, False)],
          f"{tag} failure older than the target (a later run wrote it): entry ({v.calls})")
    v = run({"s": (LONG, "1h", 10 * H, 9 * H)}, {}, self_ledger)
    check(v.calls == [("BTCUSDT", 100, False)],
          f"{tag} one failure 9h ago, target 10h old (a gap began with one error): entry ({v.calls})")
    v = run({"s": (LONG, "1h", 3 * H, 2 * H)}, {}, self_ledger)
    check(v.calls == [("BTCUSDT", 100, False)],
          f"{tag} TAIFEX night-to-day gap: night bar 3h ago, one error 2h ago: entry ({v.calls})")
    v = run({"s": (LONG, "1h", 3 * H, 50 * 60)}, {}, self_ledger)
    check(v.calls == [("BTCUSDT", 100, False)],
          f"{tag} last failure 50 min ago (past the recency window): entry ({v.calls})")
    v = run({"m": (LONG, "5m", 40 * 60, 44 * 60)}, {}, self_ledger)
    check(v.calls == [("BTCUSDT", 100, False)],
          f"{tag} 5m: a run wrote the target after the last failure: entry ({v.calls})")
    v = run({"m": (LONG, "5m", 40 * 60, 60)}, {}, self_ledger)
    check(v.calls == [], f"{tag} 5m failing for 40 min: its share is held ({v.calls})")
    v = run({"m": (LONG, "5m", 20 * 60, 60)}, {}, self_ledger)
    check(v.calls == [("BTCUSDT", 100, False)],
          f"{tag} 5m strategy 20 min after a failure: inside the 30-min floor, entry ({v.calls})")
    v = run({"b": (LONG, None, 3 * D, 60)}, {}, self_ledger)
    check(v.calls == [("BTCUSDT", 100, False)], f"{tag} Type B (no INTERVAL) is not judged ({v.calls})")
    us = {"symbol": "SPY", "position": 1}
    v = run({"us": (us, "1d", 2.5 * D, 300)}, {}, self_ledger)
    check(v.calls == [("SPY", 100, False)],
          f"{tag} US daily on Monday (Friday's bar, 2.5 days), one error 5 min ago: entry ({v.calls})")
    v = run({"us": (us, "1d", 5 * D, 300)}, {}, self_ledger)
    check(v.calls == [], f"{tag} US daily failing for 5 days: its share is held ({v.calls})")
    tc = {"type": "portfolio", "weights": {"BTCUSDT": 0.5, "ETHUSDT": 0.5}, "rebalance_at": 0}
    v = run({"c": (tc, "1h", *FAILING)}, {"ETHUSDT": 80}, self_ledger)
    check(v.calls == [("ETHUSDT", -30, True)],
          f"{tag} Type C stale: no BTC bought, ETH trims to its weight ({v.calls})")
    # TW stocks on paper also wait for the session (_paper_tw_closed_keys), so judged on the flag
    tw = {"symbol": "2330", "position": 1}
    for age, failed, want, what in ((3 * D, None, None, "over a weekend (3 days, no failure)"),
                                    (30 * H, 60, None, "one failed day (30h < 2 bars)"),
                                    (3 * D, 60, None, "Monday after a weekend, one error a minute ago"),
                                    (5 * D, 60, ["tw"], "failing for 5 days")):
        setup({"tw": (tw, "1d", age, failed)}, self_ledger)
        row = portfolio.aggregate_portfolio().get("2330@spot") or {}
        check(row.get("stale_target") == want, f"{tag} TW daily {what}: stale_target={row.get('stale_target')}")
    # HALT: the fresh member's entry is a HALT denial, not a stale one
    setup({"s": (LONG, "1h", *FAILING), "f": (LONG, "1h", 60, None)}, self_ledger)
    v = Venue({})
    mode(v, self_ledger)
    portfolio.guard.trip_halt("user request", "web")
    portfolio.reconcile(v.positions, v.place)
    audit = [json.loads(x) for x in open("state/audit.jsonl")]
    denied = [x for x in audit if x["event"] == "order_denied_halt"]
    check(v.calls == [] and len(denied) == 1 and denied[0]["signed_diff"] == 100,
          f"{tag} under HALT nothing goes and the fresh entry is counted as a HALT denial ({denied})")
    portfolio.guard.clear_halt("test")
    portfolio.guard._halt_flag = False

# a contract rollover in progress is left as computed (holding the share on the new contract
# would close it)
row = {"side": "long", "size": 1, "exchange": "capital", "asset_spec": None, "market": "swap",
       "gated": False, "stale_target": ["s"],
       "contributors": [{"strategy": "s", "position": 1, "amount": 1, "contribution": 1}]}
check(portfolio._stale_share_targets({"TMF": row}, {}, {"TMF"})["TMF"]["size"] == 1,
      "rollover root: the stale share is not held")
check(portfolio._stale_share_targets({"TMF": row}, {}, set())["TMF"]["size"] == 0,
      "no rollover: the stale share is held at the book (0)")
setup({"x": (LONG, "1h", 3 * H, None)}, False)
open("state/bar_wait/x.json", "w").write("{not json")
check(portfolio._stale_target_age("x") is None, "unreadable bar_wait file: not stale")
check(portfolio._stale_target_age("missing") is None, "no state / no bar_wait file: not stale")

print(f"\n{fails} FAILED" if fails else "\nall ok")
sys.exit(1 if fails else 0)
