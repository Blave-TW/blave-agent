"""A funded Type A/C member whose scheduled tick keeps failing leaves state.json at its last good
target; lib/portfolio holds that key's ENTRIES (no new position, no top-up, no flip's open leg)
and lets every reduce / close through. Stale = state/bar_wait/<name>.json has
last_attempt_failed_at newer than state.json AND state.json is older than
max(TARGET_STALE_BARS × INTERVAL, TARGET_STALE_FLOOR_S). A weekend / holiday never records a
failure in wait_for_bar, so an old daily target with no failure trades; one failure inside the
floor (the 300s retry has not had its chance) trades; Type B (no INTERVAL) is not judged.

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
for self_ledger in (False, True):
    tag = "[ledger]" if self_ledger else "[account]"
    v = run({"s": (LONG, "1h", 3 * H, 60)}, {}, self_ledger)
    check(v.calls == [], f"{tag} 1h target 3h old, last tick failed: no entry ({v.calls})")
    snap = json.load(open("manager/last_reconcile.json"))
    check(snap["target"]["BTCUSDT"].get("stale_target") == ["s"],
          f"{tag} the snapshot names the stale member ({snap['target']['BTCUSDT'].get('stale_target')})")
    v = run({"s": (LONG, "1h", 3 * H, 60)}, {"BTCUSDT": 40}, self_ledger)
    check(v.calls == [], f"{tag} stale: no top-up of a held position ({v.calls})")
    v = run({"s": (FLAT, "1h", 3 * H, 60)}, {"BTCUSDT": 100}, self_ledger)
    check(v.calls == [("BTCUSDT", -100, True)], f"{tag} stale flat target: the close still goes ({v.calls})")
    v = run({"s": (SHORT, "1h", 3 * H, 60)}, {"BTCUSDT": 100}, self_ledger)
    check(v.calls == [("BTCUSDT", -100, True)],
          f"{tag} stale flip: close leg goes, open leg held ({v.calls})")
    v = run({"s": ({"symbol": "BTCUSDT", "position": 0.5}, "1h", 3 * H, 60)}, {"BTCUSDT": 100},
            self_ledger)
    check(v.calls == [("BTCUSDT", -50, True)], f"{tag} stale: a reduce goes ({v.calls})")
    v = run({"s": (LONG, "1h", 30 * 60, None)}, {}, self_ledger)
    check(v.calls == [("BTCUSDT", 100, False)], f"{tag} fresh target, no failure: entry ({v.calls})")
    v = run({"s": (LONG, "1h", 3 * H, None)}, {}, self_ledger)
    check(v.calls == [("BTCUSDT", 100, False)],
          f"{tag} old target but no failure recorded (data stall / closed market): entry ({v.calls})")
    v = run({"s": (LONG, "1h", 3 * H, 4 * H)}, {}, self_ledger)
    check(v.calls == [("BTCUSDT", 100, False)],
          f"{tag} failure older than the target (a later run wrote it): entry ({v.calls})")
    # TW stocks on paper also wait for the session (_paper_tw_closed_keys), so judged on the flag
    tw = {"symbol": "2330", "position": 1}
    for age, failed, want, what in ((3 * D, None, None, "over a weekend (3 days, no failure)"),
                                    (30 * H, 60, None, "one failed day (30h < 2 bars)"),
                                    (3 * D, 60, ["tw"], "failing for 3 days")):
        setup({"tw": (tw, "1d", age, failed)}, self_ledger)
        row = portfolio.aggregate_portfolio().get("2330@spot") or {}
        check(row.get("stale_target") == want, f"{tag} TW daily {what}: stale_target={row.get('stale_target')}")
    v = run({"m": (LONG, "5m", 20 * 60, 60)}, {}, self_ledger)
    check(v.calls == [("BTCUSDT", 100, False)],
          f"{tag} 5m strategy 20 min after one failure: inside the 30-min floor, entry ({v.calls})")
    v = run({"b": (LONG, None, 3 * D, 60)}, {}, self_ledger)
    check(v.calls == [("BTCUSDT", 100, False)], f"{tag} Type B (no INTERVAL) is not judged ({v.calls})")
    tc = {"type": "portfolio", "weights": {"BTCUSDT": 0.5, "ETHUSDT": 0.5}, "rebalance_at": 0}
    v = run({"c": (tc, "1h", 3 * H, 60)}, {"ETHUSDT": 80}, self_ledger)
    check(v.calls == [("ETHUSDT", -30, True)],
          f"{tag} Type C stale: no BTC entry, ETH trims to its weight ({v.calls})")
    v = run({"s": (LONG, "1h", 3 * H, 60), "f": ({"symbol": "BTCUSDT", "position": 0}, "1h", 60, None)},
            {"BTCUSDT": 100}, self_ledger)
    check(v.calls == [], f"{tag} shared key, one member stale: held at what the stale one wants ({v.calls})")
    os.remove("state/bar_wait/s.json") if os.path.exists("state/bar_wait/s.json") else None
setup({}, False)
check(portfolio._stale_target_age("missing") is None, "no state / no bar_wait file: not stale")

print(f"\n{fails} FAILED" if fails else "\nall ok")
sys.exit(1 if fails else 0)
