"""The reconciler never touches a position it did not open (Wei 2026-09-23).

Ownership is the bot's own book (baseline + its own fills), kept PER VENUE,
never the symbol: a manual position — on a symbol no strategy trades, on one a
strategy trades at amount 0 or more, or on another bound venue — is never
diffed, reduced or closed. Every config without an explicit
`"self_ledger": false` runs this way.

The order path is the real one: lib.venue_wiring sizes every order and
lib.order_binance quantizes it (format_qty / format_spot_qty / _floor_to_step);
only the network calls (rules, mark, positions, the order itself) are stubbed.
Every number is made up.

  (A) manual longs + an empty portfolio → zero orders;
  (B) a strategy on the same symbol at amount 0 → zero orders;
  (C) a funded strategy beside a manual long buys on top, sells only its own;
  (D) a deleted strategy's leftover that IS in the book closes — only that;
  (E) migration adopts min(|account|, |target|) same side, FLOORED to the
      venue step through the order lib (larger / smaller / opposite / flat /
      short / spot), and a flat signal then closes it to exactly zero;
  (F) paper follows the same rule;
  (G) explicit `"self_ledger": false` is the account-read opt-out;
  (M) migration waits for trustworthy input: configured, readable states,
      quantity reads, two identical account reads, nothing in flight;
  (N) the gate is the lib's own marker, not a bare seeded_at;
  (V) the book is per venue: a reroute never sells the new venue's manual
      position, close-all closes each venue's own share only;
  (S) spot: close-all and the reconciler sell only min(book, wallet); a spot
      row without a quantity is written off once and never blocks an entry;
  (H) close-all with no baseline closes nothing; after one, only the share;
  (I) runtime: unbind reset, marker, report.

Run: cd blave-agent && .venv/bin/python tests/check_own_positions_only.py
"""
import json
import os
import sys
import tempfile
import time
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WS = tempfile.mkdtemp(prefix="ownonly-")
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = WS
os.environ["BLAVE_AGENT_BASE"] = WS
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.pop("BLAVE_AGENT_LOCAL", None)
for d in ("manager", "state", "strategies/btc_trend", "lib"):
    os.makedirs(os.path.join(WS, d), exist_ok=True)
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "runtime"))


def _no_real_env(event, args):
    if event == "open" and os.path.abspath(str(args[0])) == os.path.join(ROOT, ".env"):
        raise PermissionError("the repo .env must never be read by a test")


sys.addaudithook(_no_real_env)
os.chdir(WS)

from lib import portfolio, venue_wiring  # noqa: E402
import lib.order_binance as ob  # noqa: E402
import lib.account_binance as ab  # noqa: E402

portfolio._notify_best_effort = lambda msg: None
ERRS = []
portfolio._record_order_error = lambda *a, **k: ERRS.append(a)

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


# ── the venue: real quantization and sizing, network stubbed ────────────────
MARK = {"BTCUSDT": 50000.0, "DOGEUSDT": 0.2, "ETHUSDT": 2000.0}
STEP = {"BTCUSDT": "0.001", "DOGEUSDT": "1", "ETHUSDT": "0.01"}
POS = []           # account_binance.get_positions rows (base units)
WALLET = {}        # spot wallet, base units
SENT = []          # (symbol, side, base qty, reduce_only) that reached the order lib — on a
                   # reduce-only leg `side` is the position side being closed
VENUE = ["binance"]
venue_wiring.read_env = lambda path=".env": {"BINANCE_API_KEY": "k", "BINANCE_SECRET_KEY": "k"}
venue_wiring.detect_venue = lambda env: VENUE[0]
ob.get_position_mode = lambda env: "hedge"  # netting is tests/check_net_mode.py's; no network here
ob.get_contract_rules = lambda env, sym: {"step": STEP[sym], "min_qty": float(STEP[sym]),
                                          "min_notional": 1.0, "contract_value": 1,
                                          "price_tick": "0.1", "active": True}
ob.get_spot_rules = lambda env, sym: {"step": STEP[sym], "min_qty": float(STEP[sym]),
                                      "min_notional": 1.0, "price_tick": "0.1", "active": True}
ob.get_mark_price = lambda env, sym: MARK[sym]
ob.get_spot_price = lambda env, sym: MARK[sym]
ob.get_spot_balances = lambda env: dict(WALLET)


def _fill(sym, side, qty, reduce_only):
    SENT.append((sym, side, round(float(qty), 8), reduce_only))
    return {"executed_qty": float(qty), "avg_price": MARK[sym], "status": "filled"}


ob.place_market_order = lambda env, sym, direction, qty, client_order_id=None, reduce_only=False: \
    _fill(sym, direction, qty, reduce_only)


def _spot(env, sym, side, base_qty=None, quote_qty=None, client_order_id=None):
    qty = base_qty if base_qty is not None else quote_qty / MARK[sym]
    SENT.append((sym + "@spot", side, round(float(qty), 8), False))
    return {"executed_qty": float(qty), "avg_price": MARK[sym], "quote_qty": float(qty) * MARK[sym]}


ob.place_spot_market_order = _spot
ab.get_positions = lambda env: [dict(r) for r in POS]


def hold(**rows):
    """Swap positions in base units: hold(BTCUSDT=0.0014, DOGEUSDT=-150)."""
    POS[:] = [{"symbol": s, "side": "long" if q > 0 else "short", "size": abs(q),
               "mark_price": MARK[s]} for s, q in rows.items() if q]


CFG = "manager/portfolio_config.json"
SEED = "manager/ledger_seed.json"
ORDERS = "manager/orders.jsonl"
SNAP = "manager/last_reconcile.json"
MARKED = {"seeded_at": "2026-09-01T00:00:00", "own_only_basis": 1, "symbols": {}}


def state(name, symbol, position, market="swap"):
    os.makedirs(f"strategies/{name}", exist_ok=True)
    open(f"strategies/{name}/strategy.py", "w").write(f'MARKET = "{market}"\n')
    json.dump({"symbol": symbol, "position": position, "market": market,
               "updated_at": int(time.time())}, open(f"strategies/{name}/state.json", "w"))


def reset(config, seed=None, position=1.0):
    for p in (SEED, ORDERS, SNAP):
        if os.path.exists(p):
            os.remove(p)
    for n in os.listdir("strategies"):
        for f in ("state.json", "strategy.py"):
            if os.path.exists(f"strategies/{n}/{f}"):
                os.remove(f"strategies/{n}/{f}")
    portfolio._baseline_seen = None
    del SENT[:], ERRS[:]
    WALLET.clear()
    json.dump(config, open(CFG, "w"))
    if seed is not None:
        json.dump(seed, open(SEED, "w"))
    state("btc_trend", "BTCUSDT", position)


def rnd():
    """One real reconcile round → the USD diffs that reached the wiring."""
    usd = []

    def place(symbol, diff, spec=None, **kw):
        usd.append((symbol, round(diff, 2)))
        kw.pop("contributors", None)  # lib.execute's dispatcher takes it; the wiring doesn't
        return venue_wiring.auto_place_order(symbol, diff, spec, **kw)

    portfolio.reconcile(get_positions_fn=venue_wiring.auto_get_positions,
                        place_order_fn=place, threshold=10)
    snap = json.load(open(SNAP)) if os.path.exists(SNAP) else {}
    return usd, snap


def migrate():
    """Migration believes the account on the second identical read."""
    first, snap = rnd()
    assert first == [] and (snap.get("needs_baseline") or {}).get("reason") == "confirming", (first, snap)
    return rnd()


def seed_rows():
    return json.load(open(SEED))["symbols"] if os.path.exists(SEED) else {}


def book(venue="binance"):
    return portfolio.ledger_positions(venue)


real_qty = venue_wiring.auto_position_qty
FUND = lambda amt, ex="binance": {"amounts": {"btc_trend": amt}, "exchanges": {"btc_trend": ex}}  # noqa: E731

# (A) ─────────────────────────────────────────────────────────────────────────
print("== (A) manual longs + an empty portfolio")
reset({"amounts": {}, "exchanges": {}, "asset_specs": {}},
      seed={"seeded_at": "", "symbols": {"BTCUSDT": {"size": 0.0, "qty": 0.0,
                                                      "ts": "2026-09-01T00:00:00"}}})
hold(BTCUSDT=0.0014, DOGEUSDT=150)
usd, snap = migrate()
check(usd == [] and SENT == [], f"no order at all — the manual longs are not closed ({usd})")
seed = json.load(open(SEED))
check(bool(seed.get("seeded_at")) and seed.get("own_only_basis") == 1 and seed.get("symbols") == {},
      "a baseline is written, marked, and owns nothing")
check(snap.get("own_only") is True and "needs_baseline" not in snap and snap.get("ledger") == {},
      "snapshot: own_only, empty book, nothing pending")
usd, _ = rnd()
check(usd == [], "next round: still nothing")

# (B) ─────────────────────────────────────────────────────────────────────────
print("== (B) a strategy on the same symbol at amount 0")
reset(FUND(0), seed=MARKED)
usd, snap = rnd()
check(usd == [] and not (snap.get("target") or {}),
      f"amount 0 = no target, and the manual BTC long is not touched ({usd})")

# (C) ─────────────────────────────────────────────────────────────────────────
print("== (C) a funded strategy beside a manual long")
reset(FUND(50), seed=MARKED)
hold(BTCUSDT=0.0014)
usd, _ = rnd()
check(usd == [("BTCUSDT", 50.0)] and SENT == [("BTCUSDT", "long", 0.001, False)],
      f"buys its full target ON TOP of the manual long, no reduce leg ({usd}, {SENT})")
hold(BTCUSDT=0.0024)
usd, _ = rnd()
check(usd == [], f"at target: the account's extra 0.0014 is not a gap ({usd})")
state("btc_trend", "BTCUSDT", 0.0)
del SENT[:]
usd, _ = rnd()
check(SENT == [("BTCUSDT", "long", 0.001, True)],
      f"signal flat: sells its own 0.001, not the account's 0.0024 ({SENT})")

# (D) ─────────────────────────────────────────────────────────────────────────
print("== (D) a deleted strategy's leftover in the book")
reset(FUND(50), seed=MARKED)
hold(BTCUSDT=0.0014, DOGEUSDT=150)
rnd()  # the bot buys its 0.001
hold(BTCUSDT=0.0024, DOGEUSDT=150)
json.dump({"amounts": {}, "exchanges": {}}, open(CFG, "w"))
del SENT[:]
rnd()
check(SENT == [("BTCUSDT", "long", 0.001, True)],
      f"strategy removed: its own 0.001 closes, the manual BTC and DOGE stay ({SENT})")

# (E) ─────────────────────────────────────────────────────────────────────────
print("== (E) migration: whole when within 1.5× of the target, else the target's share floored")


def no_writeoff():
    return not os.path.exists("state/audit.jsonl") or not any(
        "ledger_writeoff" in l for l in open("state/audit.jsonl"))


if os.path.exists("state/audit.jsonl"):
    os.remove("state/audit.jsonl")
reset(FUND(40))
hold(BTCUSDT=0.001)  # a profitable one-lot bot position: $50 against a $40 target
usd, _ = migrate()
row = seed_rows().get("binance|BTCUSDT") or {}
check(usd == [] and row.get("qty") == 0.001 and abs(row.get("size", 0) - 40.0) < 1e-9,
      f"1.25× the target: the whole lot is the bot's, cost capped at the target so nothing trades ({row})")
state("btc_trend", "BTCUSDT", 0.0)
del SENT[:]
rnd()
check(SENT == [("BTCUSDT", "long", 0.001, True)] and book() == {} and no_writeoff(),
      f"…signal flat: that lot closes, the book is empty, nothing written off ({SENT})")

reset(FUND(120))
hold(BTCUSDT=0.005, DOGEUSDT=150)  # $250 of BTC under a $120 target: clearly more than the bot's
usd, _ = migrate()
rows = seed_rows()
row = rows.get("binance|BTCUSDT") or {}
check(not [x for x in SENT if x[3]] and all(d > 0 for _, d in usd) and row.get("qty") == 0.002
      and abs(row.get("size", 0) - 100.0) < 1e-9 and not any("DOGE" in k for k in rows),
      f"2.08× the target: the target's share 0.0024 floors to 0.002 ($100); the other 0.003 and DOGE are "
      f"the user's; nothing is sold (only the floored-off part may be bought back) ({rows}, {usd})")
state("btc_trend", "BTCUSDT", 0.0)
del SENT[:]
rnd()
check(SENT == [("BTCUSDT", "long", 0.002, True)] and book() == {} and no_writeoff(),
      f"…signal flat: exactly the adopted 0.002 closes, nothing stranded ({SENT})")

reset(FUND(100))
hold(BTCUSDT=0.003)  # $150 = exactly 1.5×
migrate()
whole = seed_rows().get("binance|BTCUSDT", {}).get("qty")
reset(FUND(99))
hold(BTCUSDT=0.003)  # $150 = 1.52×
migrate()
split = seed_rows().get("binance|BTCUSDT", {}).get("qty")
check(portfolio._ADOPT_WHOLE_RATIO == 1.5 and whole == 0.003 and split == 0.001,
      f"the line is _ADOPT_WHOLE_RATIO = 1.5: at 1.5× whole ({whole}), just above it split ({split})")

reset(FUND(80))
hold(BTCUSDT=0.001)  # $50 held under $80
usd, _ = migrate()
check(seed_rows().get("binance|BTCUSDT", {}).get("qty") == 0.001 and usd == [("BTCUSDT", 30.0)],
      f"smaller than the target: all of it is the bot's, the rest is bought ({usd})")

reset(FUND(50))
hold(BTCUSDT=-0.002)  # the user's own short, two lots, under a long target
usd, _ = migrate()
check(usd == [("BTCUSDT", 50.0)] and seed_rows() == {} and SENT == [("BTCUSDT", "long", 0.001, False)],
      f"opposite side, ≥ one lot: the bot owns 0 — its entry only, no reduce-only leg against the "
      f"user's short ({SENT})")

reset(FUND(50), position=0.0)
hold(BTCUSDT=0.0014)
usd, _ = migrate()
check(usd == [] and seed_rows() == {}, f"flat signal: nothing adopted or sold ({usd})")

reset(FUND(120), position=-1.0)
hold(BTCUSDT=-0.005)
usd, _ = migrate()
row = seed_rows().get("binance|BTCUSDT") or {}
check(row.get("qty") == -0.002 and abs(row.get("size", 0) + 100.0) < 1e-9 and not [x for x in SENT if x[3]],
      f"short, split: quantity and cost negative, floored ({row})")
state("btc_trend", "BTCUSDT", 0.0)
del SENT[:]
rnd()
check(SENT == [("BTCUSDT", "short", 0.002, True)] and book() == {},
      f"…signal flat: buys back exactly 0.002, reduce-only ({SENT})")
reset(FUND(40), position=-1.0)
hold(BTCUSDT=-0.001)
migrate()
row = seed_rows().get("binance|BTCUSDT") or {}
check(row.get("qty") == -0.001 and abs(row.get("size", 0) + 40.0) < 1e-9,
      f"short, whole: the one lot, negative ({row})")

reset({"amounts": {"eth_spot": 40}, "exchanges": {"eth_spot": "binance"}})
state("eth_spot", "ETHUSDT", 1.0, market="spot")
WALLET.update(ETH=0.05)  # $100 of coins under a $40 target
hold(ETHUSDT=0.02)        # a manual ETH perp next to it
usd, _ = migrate()
rows = seed_rows()
check(usd == [] and rows.get("binance|ETHUSDT@spot", {}).get("qty") == 0.02 and "binance|ETHUSDT" not in rows,
      f"spot, 2.5×: 0.02 of the wallet's 0.05 ETH is the bot's (from the wallet, floored); the perp is "
      f"the user's ({rows})")

# (Q) ─────────────────────────────────────────────────────────────────────────
print("== (Q) quantization per venue: base units through each lib's own rules")
import lib.order_okx as ox  # noqa: E402
import lib.order_gateio as gx  # noqa: E402
import lib.order_bybit as bx  # noqa: E402
import lib.order_bingx as ngx  # noqa: E402
# the network leaf only — format_qty, get_contract_rules and _floor_to_step are the libs' own
ox._instrument = lambda env, inst, kind: {"lot_sz": "0.01", "min_sz": 0.01, "ct_val": 0.01,
                                          "tick_sz": "0.1", "active": True}
gx._futures_rules = lambda env, sym: {"multiplier": "0.0001", "min_ct": 1, "tick": "0.1", "active": True}
bx.get_contract_rules = lambda env, sym: {"step": "0.001", "min_qty": 0.001, "min_notional": 0.0,
                                          "contract_value": 1.0, "tick": "0.1"}
ngx.get_contract_rules = lambda env, sym: {"qty_precision": 3, "price_precision": 1, "min_qty": 0.001,
                                           "min_notional": 0.0, "active": True}
Q = portfolio._venue_quantize
got = {v: Q(v, "BTCUSDT", 0.03547, False) for v in ("binance", "okx", "gateio", "bybit", "bingx", "paper")}
check(got == {"binance": 0.035, "okx": 0.0354, "gateio": 0.0354, "bybit": 0.035, "bingx": 0.035,
              "paper": 0.03547},
      f"0.03547 BTC → coins on every venue: OKX (0.01 ct × 0.01) / Gate.io (0.0001 multiplier) floor to "
      f"0.0354 BTC, never their contract counts 3.54 / 354 ({got})")
small = {v: Q(v, "BTCUSDT", 0.00005, False) for v in ("binance", "okx", "gateio", "bybit", "bingx")}
check(set(small.values()) == {0.0}, f"below each venue's minimum → 0 (Bybit's \"\" included) ({small})")
check(Q("capital", "TMF", 2.7, True) == 2.0 and Q("capital", "TMF", 0.9, True) == 0.0,
      "群益 (lots): whole lots, floored")
for vid in ("okx", "gateio"):
    VENUE[0] = vid
    venue_wiring.auto_position_qty = lambda: {"BTCUSDT": 0.05}
    reset(FUND(1000, vid))
    held = {"BTCUSDT": {"side": "long", "size": 2500.0}}  # 0.05 BTC, 2.5× the target
    calls = []
    for _ in range(2):
        portfolio.reconcile(get_positions_fn=lambda: dict(held),
                            place_order_fn=lambda *a, **k: calls.append(a), threshold=10)
    row = seed_rows().get(f"{vid}|BTCUSDT") or {}
    check(row.get("qty") == 0.02 and abs(row.get("size", 0) - 1000.0) < 1e-6 and calls == [],
          f"{vid}: migration adopts 0.02 BTC ($1,000), not 0.02 ÷ ct_val contracts — and sends nothing "
          f"({row}, {calls})")
venue_wiring.auto_position_qty = real_qty
VENUE[0] = "binance"

# (F) ─────────────────────────────────────────────────────────────────────────
print("== (F) paper follows the same rule")
VENUE[0] = "paper"
real_qty = venue_wiring.auto_position_qty
venue_wiring.auto_position_qty = lambda: {"BTCUSDT": 0.0016}
reset(FUND(50, "paper"))
portfolio.reconcile(get_positions_fn=lambda: {"BTCUSDT": {"side": "long", "size": 80.0}},
                    place_order_fn=lambda *a, **k: SENT.append(a), threshold=10)
portfolio.reconcile(get_positions_fn=lambda: {"BTCUSDT": {"side": "long", "size": 80.0}},
                    place_order_fn=lambda *a, **k: SENT.append(a), threshold=10)
row = seed_rows().get("paper|BTCUSDT") or {}
check(SENT == [] and abs(row.get("size", 0) - 50.0) < 1e-9 and abs(row.get("qty", 0) - 0.001) < 1e-12,
      f"paper: 50 of 80 adopted, keyed to paper, no order ({row})")
venue_wiring.auto_position_qty = real_qty
VENUE[0] = "binance"

# (G) ─────────────────────────────────────────────────────────────────────────
print("== (G) explicit opt-out")
reset({"amounts": {}, "exchanges": {}, "self_ledger": False})
hold(BTCUSDT=0.0014, DOGEUSDT=150)
usd, snap = rnd()
check(sorted(usd) == [("BTCUSDT", -70.0), ("DOGEUSDT", -30.0)] and "own_only" not in snap,
      f'"self_ledger": false reads the whole account as the bot\'s — the opt-out ({usd})')

# (M) ─────────────────────────────────────────────────────────────────────────
print("== (M) migration waits for inputs it can trust")
reset(FUND(50))
os.remove(CFG)
hold(BTCUSDT=0.0014)
rnd()
usd, snap = rnd()
check(usd == [] and not os.path.exists(SEED)
      and (snap.get("needs_baseline") or {}).get("reason") == "unconfigured",
      f"no config: no baseline written — an empty target would make the bot's own position the "
      f"user's for good ({snap.get('needs_baseline')})")
json.dump(FUND(50), open(CFG, "w"))
usd, _ = rnd()
usd, _ = rnd()
check(usd == [] and seed_rows().get("binance|BTCUSDT", {}).get("qty") == 0.0014,
      f"…once amounts are saved, it adopts the 0.0014 (1.4× the target: whole) instead of buying on "
      f"top ({usd})")

reset(FUND(50))
open("strategies/btc_trend/state.json", "w").write('{"symbol": "BTCUS')  # half-written
hold(BTCUSDT=0.0014)
rnd()
usd, snap = rnd()
check(usd == [] and not os.path.exists(SEED)
      and snap.get("needs_baseline") == {"reason": "state_unreadable", "symbols": ["btc_trend"]},
      f"a funded strategy's state unreadable: waits ({snap.get('needs_baseline')})")

# stuck: a strategy's state stays unreadable AND nothing says which coin it trades (no stats.json,
# no SYMBOL in strategy.py) — after N rounds and T seconds the certain part is decided
reset({"amounts": {"btc_trend": 50, "doge_trend": 30}, "exchanges": {"btc_trend": "binance", "doge_trend": "binance"}})
open("strategies/btc_trend/state.json", "w").write('{"symbol": "BTCUS')
state("doge_trend", "DOGEUSDT", 1.0)
hold(BTCUSDT=0.0014, DOGEUSDT=150)  # DOGE: $30 under a $30 target
reasons = []
for _ in range(2 + portfolio._BASELINE_FALLBACK_ROUNDS):
    usd, snap = rnd()
    reasons.append((snap.get("needs_baseline") or {}).get("reason"))
check(reasons[1:] == ["state_unreadable"] * (1 + portfolio._BASELINE_FALLBACK_ROUNDS) and not os.path.exists(SEED),
      f"{portfolio._BASELINE_FALLBACK_ROUNDS}+ rounds but not {portfolio._BASELINE_FALLBACK_S} s yet: still "
      f"waiting — a few quick state changes are not 'stuck' ({reasons})")
portfolio._BASELINE_FALLBACK_S = 0
usd, snap = rnd()
reasons.append((snap.get("needs_baseline") or {}).get("reason"))
rows = seed_rows() if os.path.exists(SEED) else {}
check(reasons[-1] is None
      and rows.get("binance|DOGEUSDT", {}).get("qty") == 150.0 and "binance|BTCUSDT" not in rows,
      f"…past the time floor too: the readable part is decided (DOGE is the bot's), BTC is left to the "
      f"user ({reasons}, {rows})")
check(any("left to you" in str(e) for e in ERRS), "…and it says so (one order error)")
state("doge_trend", "DOGEUSDT", 0.0)
del SENT[:]
rnd()
check(SENT == [("DOGEUSDT", "long", 150.0, True)],
      f"…exits work again: DOGE's flat signal closes the bot's 150 ({SENT})")
portfolio._BASELINE_FALLBACK_S = 600
os.remove("strategies/doge_trend/state.json")
os.remove("strategies/doge_trend/strategy.py")

# a funded strategy whose state has no `symbol` (a Type C portfolio writes none): aggregate skips it
# every round by design — it must not hold the migration
reset({"amounts": {"btc_trend": 50, "basket": 200}, "exchanges": {"btc_trend": "binance", "basket": "binance"}})
os.makedirs("strategies/basket", exist_ok=True)
json.dump({"weights": {"BTCUSDT": 0.5, "ETHUSDT": 0.5}, "updated_at": int(time.time())},
          open("strategies/basket/state.json", "w"))
hold(BTCUSDT=0.0014)
usd, snap = migrate()
check("needs_baseline" not in snap and seed_rows().get("binance|BTCUSDT", {}).get("qty") == 0.0014,
      f"a funded Type C (state without a symbol) doesn't hold the migration ({snap.get('needs_baseline')})")
os.remove("strategies/basket/state.json")

reset(FUND(50))
hold()  # the venue answers with no rows
usd, snap = rnd()
hold(BTCUSDT=0.0014)  # …and with the position the next round
usd2, snap2 = rnd()
check(usd == [] and usd2 == [] and not os.path.exists(SEED)
      and (snap2.get("needs_baseline") or {}).get("reason") == "confirming",
      "an empty read is not believed: the round after it disagrees, still nothing written")
usd3, _ = rnd()
check(usd3 == [] and seed_rows().get("binance|BTCUSDT", {}).get("qty") == 0.0014,
      f"…two identical reads: the bot's 0.0014 is adopted, not re-bought ({usd3})")

reset(FUND(50))
hold(BTCUSDT=0.0014)


def _boom():
    raise RuntimeError("positionRisk timed out")


venue_wiring.auto_position_qty = _boom
rnd()
usd, snap = rnd()
check(usd == [] and not os.path.exists(SEED) and (snap.get("needs_baseline") or {}).get("reason") == "error",
      f"a quantity read throws: waits, never a row without a quantity ({snap.get('needs_baseline')})")
venue_wiring.auto_position_qty = real_qty

reset({"amounts": {"eth_spot": 40}, "exchanges": {"eth_spot": "binance"}})
state("eth_spot", "ETHUSDT", 1.0, market="spot")
WALLET.update(ETH=0.05)
real_bal = ob.get_spot_balances
calls = [0]


def _flaky(env):
    calls[0] += 1
    if calls[0] > 2:  # the account read passes, the quantity read fails
        raise RuntimeError("wallet read failed")
    return dict(WALLET)


ob.get_spot_balances = _flaky
rnd()
usd, snap = rnd()
check(not os.path.exists(SEED) and (snap.get("needs_baseline") or {}).get("reason") == "error",
      f"the wallet read for the spot share throws: waits ({snap.get('needs_baseline')})")
ob.get_spot_balances = real_bal

import lib.execute as _ex  # noqa: E402
reset(FUND(50))
hold(BTCUSDT=0.0014)
real_inflight = _ex.list_inflight
_ex.list_inflight = lambda: [{"key": "BTCUSDT", "style": "twap"}]
usd, snap = rnd()
check(usd == [] and (snap.get("needs_baseline") or {}).get("reason") == "inflight" and not os.path.exists(SEED),
      "a TWAP / chase in flight: waits (it would double-count)")
_ex.list_inflight = real_inflight

# (N) ─────────────────────────────────────────────────────────────────────────
print("== (N) the gate is the lib's own marker")
reset(FUND(50), seed={"seeded_at": "2026-09-01T00:00:00", "symbols": {}})  # a runtime-written reset
hold(BTCUSDT=0.0014)  # the bot's own position, bought under the old account-read lib
usd, _ = migrate()
check(usd == [] and seed_rows().get("binance|BTCUSDT", {}).get("qty") == 0.0014,
      f"a seeded_at without the marker is not a baseline: the bot's 0.0014 is adopted, not bought "
      f"again ({usd})")
reset({**FUND(50), "self_ledger": True}, seed={"seeded_at": "2026-09-01T00:00:00", "symbols": {}})
hold(BTCUSDT=0.0014)
usd, snap = rnd()
check(usd == [("BTCUSDT", 50.0)] and "needs_baseline" not in snap,
      f'a machine already on the book ("self_ledger": true) keeps its seed ({usd})')

reset({**FUND(50), "self_ledger": True},
      seed={"seeded_at": "2026-09-01T00:00:00", "symbols": {"BTCUSDT": {"size": 50.0, "qty": 0.001,
                                                                          "ts": "2026-09-01T00:00:00"}}})
hold(BTCUSDT=0.001)
usd, _ = rnd()
check(usd == [] and list(seed_rows()) == ["binance|BTCUSDT"] and book("paper") == {},
      f"the reconciler claims a row without a venue for its venue: Binance's book, not paper's too "
      f"({list(seed_rows())})")

reset({**FUND(50), "self_ledger": True},
      seed={"seeded_at": "2026-09-01T00:00:00", "symbols": {
          "BTCUSDT": {"size": 50.0, "qty": 0.001, "ts": "2026-09-01T00:00:00"},
          "binance|BTCUSDT": {"size": 0.0, "qty": 0.0, "ts": "2026-09-05T00:00:00", "venue": "binance"}}})
hold(BTCUSDT=0.001)
rnd()
row = seed_rows().get("binance|BTCUSDT") or {}
check(list(seed_rows()) == ["binance|BTCUSDT"] and row.get("qty") == 0.0 and row.get("ts") == "2026-09-05T00:00:00",
      f"claiming never lets an old row overwrite a newer one of the same venue ({seed_rows()})")

# a strategy's state is broken at migration but its coin is known (stats.json): only that coin waits,
# and when the state reads again the bot's own position is adopted — never bought a second time
reset({"amounts": {"btc_trend": 100, "doge_trend": 30},
       "exchanges": {"btc_trend": "binance", "doge_trend": "binance"}})
json.dump({"symbol": "BTCUSDT"}, open("strategies/btc_trend/stats.json", "w"))
open("strategies/btc_trend/state.json", "w").write('{"symbol": "BTCUS')
state("doge_trend", "DOGEUSDT", 1.0)
hold(BTCUSDT=0.002, DOGEUSDT=150)  # the bot's own $100 of BTC and $30 of DOGE
snaps = [rnd()[1] for _ in range(3)]
rows = seed_rows()
check(snaps[1].get("needs_baseline") is None and rows.get("binance|DOGEUSDT", {}).get("qty") == 150.0
      and "binance|BTCUSDT" not in rows and snaps[2].get("baseline_pending") == ["BTCUSDT"],
      f"the broken strategy's BTC waits alone; DOGE is decided at once ({rows}, "
      f"{snaps[2].get('baseline_pending')})")
state("btc_trend", "BTCUSDT", 1.0)  # the next run writes a good state
for _ in range(3):
    rnd()
rows = seed_rows()
check(SENT == [] and rows.get("binance|BTCUSDT", {}).get("qty") == 0.002
      and not json.load(open(SEED)).get("pending"),
      f"state readable again: BTC's 0.002 is adopted as the bot's — no second buy ({SENT}, {rows})")
check(not any("left to you" in str(e) for e in ERRS), "…and nothing was left to the user")
os.remove("strategies/btc_trend/stats.json")
os.remove("strategies/doge_trend/state.json")
os.remove("strategies/doge_trend/strategy.py")

# (V) ─────────────────────────────────────────────────────────────────────────
print("== (V) the book is per venue")
reset(FUND(400), seed=MARKED)
open(ORDERS, "w").write(json.dumps({"ts": "2026-09-02T00:00:00", "symbol": "BTCUSDT", "exchange": "paper",
                                    "legs": [{"signed_diff": 400.0, "executed_qty": 0.008,
                                              "signed_qty": 0.008}]}) + "\n")
hold(BTCUSDT=0.01)  # the user's own 0.01 on Binance; the strategy now routes here
usd, _ = rnd()
check(SENT == [("BTCUSDT", "long", 0.008, False)] and book("paper").get("BTCUSDT"),
      f"rerouted paper → Binance: Binance's book is empty, so it buys its 0.008 there ({SENT})")
hold(BTCUSDT=0.018)
state("btc_trend", "BTCUSDT", 0.0)
del SENT[:]
rnd()
check(SENT == [("BTCUSDT", "long", 0.008, True)],
      f"…signal flat: sells only what it bought on Binance; the user's 0.01 stays ({SENT})")

# (S) ─────────────────────────────────────────────────────────────────────────
print("== (S) spot: only the book's coins")
reset({"amounts": {"eth_spot": 40}, "exchanges": {"eth_spot": "binance"}},
      seed={**MARKED, "symbols": {"binance|ETHUSDT@spot": {"size": 40.0, "qty": 0.02, "venue": "binance",
                                                            "ts": "2026-09-01T00:00:00"}}})
state("eth_spot", "ETHUSDT", 0.0, market="spot")
WALLET.update(ETH=0.05)
rnd()
check(SENT == [("ETHUSDT@spot", "sell", 0.02, False)],
      f"reconciler: a spot close sells the book's 0.02, not the wallet's 0.05 ({SENT})")
reset({"amounts": {"eth_spot": 40}, "exchanges": {"eth_spot": "binance"}},
      seed={**MARKED, "symbols": {"binance|ETHUSDT@spot": {"size": 40.0, "qty": None, "venue": "binance",
                                                            "ts": "2026-09-01T00:00:00"}}})
state("eth_spot", "ETHUSDT", 1.0, market="spot")
WALLET.update(ETH=0.05)
rnd()
said = [e for e in ERRS if "no recorded quantity" in str(e)]
check(len(said) == 1 and SENT and SENT[-1][:2] == ("ETHUSDT@spot", "buy")
      and not [s for s in SENT if s[1] == "sell"],
      f"a spot row without a quantity: written off and said once, nothing sold, and the entry is "
      f"not blocked ({SENT}, {len(said)})")
rnd()
check(len([e for e in ERRS if "no recorded quantity" in str(e)]) == 1, "…and not said again next round")

# (H) ─────────────────────────────────────────────────────────────────────────
print("== (H) close-all")
from manager import flatten  # noqa: E402  (chdirs to the repo root on import)
os.chdir(WS)
FL = {}   # vid -> account rows
CLOSED = []
FERR = []
saved_modules = {k: sys.modules.get(k) for k in ("lib.account_binance", "lib.order_binance",
                                                  "lib.account_paper", "lib.order_paper")}
for vid in ("binance", "paper"):
    acct = types.ModuleType(f"lib.account_{vid}")
    acct.get_positions = (lambda v: lambda env: [dict(r) for r in FL.get(v, [])])(vid)
    order = types.ModuleType(f"lib.order_{vid}")
    order.format_qty = lambda env, sym, size: str(size)
    order.close_position_partial = (lambda v: lambda env, sym, side, size, client_order_id=None:
                                    CLOSED.append((v, sym, round(size, 8))) or {})(vid)
    order.get_spot_balances = lambda env: dict(WALLET)
    order.get_spot_price = lambda env, sym: MARK[sym]
    order.place_spot_market_order = (lambda v: lambda env, sym, side, base_qty=None, quote_qty=None,
                                     client_order_id=None: CLOSED.append((v, sym + "@spot", base_qty))
                                     or {"avg_price": MARK[sym], "executed_qty": base_qty})(vid)
    sys.modules[f"lib.account_{vid}"], sys.modules[f"lib.order_{vid}"] = acct, order
    for p in (f"lib/account_{vid}.py", f"lib/order_{vid}.py"):
        open(p, "w").close()
ENVS = {"BINANCE_API_KEY": "x", "BINANCE_SECRET_KEY": "x"}
flatten._read_env = lambda path=".env": dict(ENVS)
flatten._record_order_error = lambda *a, **k: FERR.append(a)
flatten._wait_for_inflight = lambda *a, **k: []
flatten.guard = types.SimpleNamespace(halted=lambda: True, trip_halt=lambda *a: None,
                                      restart_stopped=lambda: False)


def close_all():
    del CLOSED[:], FERR[:]
    flatten._LOCK = None
    flatten.flatten()
    return sorted(CLOSED)


reset({"amounts": {}}, seed={"seeded_at": "", "symbols": {}})
FL.update(binance=[{"symbol": "BTCUSDT", "side": "long", "size": 0.0014, "mark_price": 50000.0}])
check(close_all() == [] and any("no ledger baseline" in str(e) for e in FERR),
      "no baseline: closes nothing and says why")

reset(FUND(50), seed={**MARKED, "symbols": {"binance|BTCUSDT": {"size": 50.0, "qty": 0.001, "venue": "binance",
                                                              "ts": "2026-09-01T00:00:00"}}})
check(close_all() == [("binance", "BTCUSDT", 0.001)], f"only the book's 0.001 of the account's 0.0014 ({CLOSED})")

# close-all checks the exchange account before it sells out of the book
_fa = sys.modules["lib.account_binance"]
ROW = {"binance|BTCUSDT": {"size": 50.0, "qty": 0.001, "venue": "binance", "ts": "2026-09-01T00:00:00"}}
_fa.get_account_id = lambda env: "U1"
reset(FUND(50), seed={**MARKED, "symbols": ROW})
check(close_all() == [("binance", "BTCUSDT", 0.001)]
      and json.load(open(SEED))["venue_account"]["binance"]["id"] == "U1",
      f"close-all reads the account id; the same account closes as before ({CLOSED})")
reset(FUND(50), seed={**MARKED, "symbols": ROW,
                      "venue_account": {"binance": {"id": "U1", "fp": "an-older-key"}}})
_fa.get_account_id = lambda env: "U2"
check(close_all() == [] and "binance" in json.load(open(SEED))["venue_reset"],
      f"another account bound over the old one: its 0.0014 is the user's — nothing sold ({CLOSED})")


def _no_id(env):
    raise RuntimeError("uid endpoint 403")


_fa.get_account_id = _no_id
reset(FUND(50), seed={**MARKED, "symbols": ROW,
                      "venue_account": {"binance": {"id": "U1", "fp": "an-older-key"}}})
check(close_all() == [] and any("could not be read" in str(e) for e in FERR),
      f"id unreadable after a key change: nothing sold, and it says why ({CLOSED}, {FERR})")
del _fa.get_account_id

ENVS.update(PAPER_API_KEY="x", PAPER_SECRET_KEY="x")
reset(FUND(50, "paper"), seed=MARKED)
open(ORDERS, "w").write(json.dumps({"ts": "2026-09-02T00:00:00", "symbol": "BTCUSDT", "exchange": "paper",
                                    "legs": [{"signed_diff": 500.0, "executed_qty": 0.01,
                                              "signed_qty": 0.01}]}) + "\n")
FL.update(paper=[{"symbol": "BTCUSDT", "side": "long", "size": 0.01, "mark_price": 50000.0}],
          binance=[{"symbol": "BTCUSDT", "side": "long", "size": 0.05, "mark_price": 50000.0}])
check(close_all() == [("paper", "BTCUSDT", 0.01)],
      f"two venues bound: closes the bot's 0.01 on paper only; Binance's 0.05 is the user's ({CLOSED})")
seed = json.load(open(SEED))["symbols"]
check("paper|BTCUSDT" in seed and "binance|BTCUSDT" not in seed and "BTCUSDT" not in seed,
      f"…and zeroes paper's book only ({sorted(seed)})")

# an --absorb row from before books were per venue: no venue at all. Two venues bound, and the
# route (paper) is not evidence of where the row was written — the fills are.
VENUE[0] = "paper"
OLD = {"seeded_at": "2026-09-01T00:00:00", "symbols": {"BTCUSDT": {"size": 500.0, "qty": 0.01,
                                                                   "ts": "2026-09-01T00:00:00"}}}
FL.update(paper=[{"symbol": "BTCUSDT", "side": "long", "size": 0.01, "mark_price": 50000.0}],
          binance=[{"symbol": "BTCUSDT", "side": "long", "size": 0.05, "mark_price": 50000.0}])
reset({**FUND(500, "paper"), "self_ledger": True}, seed=OLD)
open(ORDERS, "w").write(json.dumps({"ts": "2026-08-30T00:00:00", "symbol": "BTCUSDT", "exchange": "binance",
                                    "legs": [{"signed_diff": 500.0, "executed_qty": 0.01}]}) + "\n")
check(close_all() == [("binance", "BTCUSDT", 0.01)] and "binance|BTCUSDT" in json.load(open(SEED))["symbols"],
      f"the fills say Binance: the row is Binance's (0.01 of its 0.05 closes there), though the route "
      f"is now paper — paper's 0.01 is not touched ({CLOSED})")
reset({**FUND(500, "paper"), "self_ledger": True}, seed=OLD)
check(close_all() == [] and "?|BTCUSDT" in json.load(open(SEED))["symbols"]
      and any("doesn't say which exchange" in str(e) for e in ERRS + FERR),
      f"no fill says where: the row is parked — nothing closed on either venue, and it says so ({CLOSED})")
VENUE[0] = "binance"

reset({"amounts": {"eth_spot": 40}, "exchanges": {"eth_spot": "paper"}},
      seed={**MARKED, "symbols": {"paper|ETHUSDT@spot": {"size": 40.0, "qty": 0.02, "venue": "paper",
                                                          "ts": "2026-09-01T00:00:00"}}})
FL.clear()
WALLET.update(ETH=1.0)
check(close_all() == [("paper", "ETHUSDT@spot", 0.02)],
      f"spot: sells the book's 0.02 on the book's venue only, not the wallet's 1.0 ({CLOSED})")
reset({"amounts": {"eth_spot": 40}, "exchanges": {"eth_spot": "paper"}},
      seed={**MARKED, "symbols": {"paper|ETHUSDT@spot": {"size": 40.0, "qty": None, "venue": "paper",
                                                          "ts": "2026-09-01T00:00:00"}}})
WALLET.update(ETH=1.0)
check(close_all() == [] and any("no recorded quantity" in str(e) for e in FERR),
      f"spot row without a quantity: not sold, says why ({CLOSED})")
for k, v in saved_modules.items():
    if v is None:
        sys.modules.pop(k, None)
    else:
        sys.modules[k] = v

# (I) ─────────────────────────────────────────────────────────────────────────
print("== (I) runtime")
import command_listener as cl  # noqa: E402
import portfolio_reporter as pr  # noqa: E402
cl._sync_strategy_crons = lambda *a, **k: None
cl._stop_reconciler = lambda: True
# The book is per venue AND per exchange account — the exchange's own id, never the
# key: a full unbind keeps it; the same account back (a rotated key included) keeps
# the bot's positions its own; another account starts that venue's book empty, the
# moment its id is read — no HALT clear involved.
open(os.path.join(WS, "lib", "portfolio.py"), "w").write("def book_account_check(env):\n")
UID = {"id": "U1"}


def _uid(env):
    if isinstance(UID["id"], Exception):
        raise UID["id"]
    return UID["id"]


_real_uid = ab.get_account_id
ab.get_account_id = _uid


def raises(fn):
    try:
        fn()
    except Exception as e:
        return e
    return None


def bind(key):
    open(os.path.join(WS, ".env"), "w").write(f"BINANCE_API_KEY={key}\nBINANCE_SECRET_KEY=s-{key}\n")
    return {"BINANCE_API_KEY": key, "BINANCE_SECRET_KEY": f"s-{key}"}


def one_fill():
    json.dump({**MARKED, "symbols": {}}, open(SEED, "w"))
    open(ORDERS, "w").write(json.dumps({"ts": "2026-09-02T00:00:00", "symbol": "BTCUSDT", "exchange": "binance",
                                        "legs": [{"signed_diff": 50.0, "signed_qty": 0.001}]}) + "\n")


qty = lambda: book("binance").get("BTCUSDT", {}).get("qty")  # noqa: E731
one_fill()
UID["id"] = "U1"
check(portfolio.book_account_check(bind("key-a"), "binance")[0] == "ok" and qty() == 0.001
      and json.load(open(SEED))["venue_account"]["binance"]["id"] == "U1",
      "first read: the book's account is recorded (U1)")
json.dump(FUND(50), open(CFG, "w"))
cl._cmd_credentials_remove({"env": ["BINANCE_API_KEY", "BINANCE_SECRET_KEY"]})
check(qty() == 0.001 and json.load(open(SEED)).get("venue_account", {}).get("binance"),
      "full unbind: the book and the account it belongs to are kept")
v = portfolio.book_account_check(bind("key-a2"), "binance")
check(v[0] == "ok" and qty() == 0.001, f"a new key on the SAME account (U1): the book is kept {v}")
UID["id"] = "U2"
v = portfolio.book_account_check(bind("key-b"), "binance")
check(v[0] == "reset" and qty() is None and "binance" in json.load(open(SEED))["venue_reset"],
      f"another account (U2): the binance book starts empty at once {v}")
UID["id"] = "U1"
v = portfolio.book_account_check(bind("key-a"), "binance")
check(v[0] == "reset" and qty() is None, f"…and U1 back does not resurrect the old book {v}")
_sd = json.load(open(SEED))
_sd["pending"] = {"binance|ETHUSDT": {"since": "2026-09-01T00:00:00"},
                  "okx|ETHUSDT": {"since": "2026-09-01T00:00:00"}}
json.dump(_sd, open(SEED, "w"))
UID["id"] = "U4"
portfolio.book_account_check(bind("key-d"), "binance")
check(list(json.load(open(SEED)).get("pending", {})) == ["okx|ETHUSDT"],
      "a reset drops that venue's symbols still waiting to be migrated (they would adopt the new "
      "account's holding); another venue's stay")

# unbind → another venue → the first venue again with ANOTHER account (the variant path)
one_fill()
portfolio.book_account_check(bind("key-a"), "binance")
cl._cmd_credentials_remove({"env": ["BINANCE_API_KEY", "BINANCE_SECRET_KEY"]})
open(os.path.join(WS, ".env"), "w").write("OKX_API_KEY=o\nOKX_SECRET_KEY=o\nOKX_PASSPHRASE=p\n")
cl._cmd_credentials_remove({"env": ["OKX_API_KEY", "OKX_SECRET_KEY", "OKX_PASSPHRASE"]})
UID["id"] = "U3"
v = portfolio.book_account_check(bind("key-c"), "binance")
check(v[0] == "reset" and qty() is None,
      f"unbind → other venue → binance with another account: binance book empty {v}")

# the id cannot be read after a key change, with the bot's book open: never guess
one_fill()
UID["id"] = "U1"
portfolio.book_account_check(bind("key-a"), "binance")
UID["id"] = RuntimeError("uid endpoint 403")
v = portfolio.book_account_check(bind("key-z"), "binance")
check(v[0] == "unreadable" and qty() == 0.001 and "same binance account" in v[1],
      f"unreadable id + new key + open book → 'unreadable', book untouched {v}")
check(portfolio.book_account_check(bind("key-a"), "binance")[0] == "ok",
      "…the key it was verified with: one key opens one account, nothing to decide")

# the user's answer (book_account_confirm) — never an order, idempotent, audited
ORDER_CALLS = []
_real_order_fns = {n: getattr(ob, n) for n in ("place_market_order", "place_limit_order",
                                               "close_position_partial", "cancel_order")
                   if hasattr(ob, n)}
for _n in _real_order_fns:
    setattr(ob, _n, (lambda n: lambda *a, **k: ORDER_CALLS.append(n))(_n))


def audits(event):
    try:
        return [json.loads(l) for l in open("state/audit.jsonl") if f'"{event}"' in l]
    except OSError:
        return []


HOLD_FILE = os.path.join(WS, "state", "venue_account.json")


def ask(venue="binance"):
    """The report asks about `venue` (what the reconciler / bind writes)."""
    json.dump({"book_hold": {"venue": venue, "reason": "?", "since": 1, "ask": True}},
              open(HOLD_FILE, "w"))


def answered():
    """What runtime _cmd_book_account_confirm does after an acting answer."""
    if os.path.exists(HOLD_FILE):
        os.remove(HOLD_FILE)


seed_before = open(SEED).read()
check(portfolio.book_account_confirm("binance", False, env=bind("key-z")) == "nothing_to_confirm"
      and open(SEED).read() == seed_before and qty() == 0.001,
      "an answer while nothing is being asked (stale / replayed) writes nothing — 'different' included")
ask()
check(portfolio.book_account_confirm("binance", True, env=bind("key-z")) == "kept"
      and qty() == 0.001 and portfolio.book_account_check(bind("key-z"), "binance")[0] == "ok",
      "answer 'same' to the question being asked: the book is kept, the new key is its account")
answered()
seed_before = open(SEED).read()
check(portfolio.book_account_confirm("binance", True, env=bind("key-z")) == "unchanged"
      and open(SEED).read() == seed_before, "…the same answer again changes nothing")
check(portfolio.book_account_confirm("binance", False, env=bind("key-z")) == "nothing_to_confirm"
      and open(SEED).read() == seed_before and qty() == 0.001,
      "…a later 'different' from another device's stale dialog never empties the kept book (D6 #1)")
UID["id"] = "U1"
portfolio.book_account_check(bind("key-z"), "binance")  # the exchange now confirms U1
ask()
check(portfolio.book_account_confirm("binance", False, env=bind("key-z")) == "nothing_to_confirm"
      and qty() == 0.001, "…nor while the exchange itself reads the book's own id")
answered()
UID["id"] = RuntimeError("uid endpoint 403")
portfolio.book_account_check(bind("key-w"), "binance")
ask()
check(portfolio.book_account_confirm("binance", False, env=bind("key-w")) == "reset" and qty() is None,
      "a real question answered 'different': the book starts empty")
seed_before = open(SEED).read()
check(portfolio.book_account_confirm("binance", False, env=bind("key-w")) == "unchanged"
      and open(SEED).read() == seed_before and qty() is None,
      "…'different' again: no second reset (fills since the first stay)")
check(raises(lambda: portfolio.book_account_confirm("binance", True, env=bind("key-w"))) is not None,
      "…'same' after 'different' is refused: the reset cannot be undone")
answered()
v = portfolio.book_account_check(bind("key-w"), "binance")
check(v[0] == "ok" and qty() is None, f"…after which the unreadable id holds nothing {v}")
open(ORDERS, "a").write(json.dumps({"ts": "2099-01-01T00:00:00", "symbol": "BTCUSDT",
                                    "exchange": "binance",
                                    "legs": [{"signed_diff": 20.0, "signed_qty": 0.0004}]}) + "\n")
check(portfolio.book_account_check(bind("key-w"), "binance")[0] == "ok" and qty() == 0.0004,
      "…and a book rebuilt on that same key stays usable while the id is unreadable")
v = portfolio.book_account_check(bind("key-y"), "binance")
check(v[0] == "unreadable", f"…until the key changes again {v}")
UID["id"] = "U9"
v = portfolio.book_account_check(bind("key-y"), "binance")
check(v[0] == "unreadable" and qty() == 0.0004,
      f"a book built while the id was unknown is not handed to whatever id reads next {v}")
ask()
check(portfolio.book_account_confirm("binance", True, env=bind("key-y")) == "kept"
      and qty() == 0.0004 and json.load(open(SEED))["venue_account"]["binance"]["id"] == "U9"
      and portfolio.book_account_check(bind("key-y"), "binance")[0] == "ok",
      "answer 'same' with a readable id: the id is recorded, later keys are decided by it")
answered()
UID["id"] = "U1"
ask()
check(portfolio.book_account_confirm("binance", False, env=bind("key-a")) == "nothing_to_confirm"
      and qty() == 0.0004,
      "a stale 'different' with no open question on this key never empties the book")
answered()
check(not ORDER_CALLS and len(audits("book_account_confirm")) >= 10,
      f"no answer placed, closed or cancelled anything; every answer is audited ({ORDER_CALLS})")
# an unreadable read over an EMPTY book never drops a verified id (D6 #4)
json.dump({**MARKED, "symbols": {}}, open(SEED, "w"))
open(ORDERS, "w").write("")
UID["id"] = "U1"
portfolio.book_account_check(bind("key-p1"), "binance")
UID["id"] = RuntimeError("uid endpoint 403")
v = portfolio.book_account_check(bind("key-p2"), "binance")
check(v[0] == "ok" and json.load(open(SEED))["venue_account"]["binance"]["id"] == "U1",
      f"same account's new key, id unreadable, book empty: ok, and the verified id U1 stays {v}")
open(ORDERS, "w").write(json.dumps({"ts": "2026-09-02T00:00:00", "symbol": "BTCUSDT",
                                    "exchange": "binance",
                                    "legs": [{"signed_diff": 50.0, "signed_qty": 0.001}]}) + "\n")
UID["id"] = "U5"
v = portfolio.book_account_check(bind("key-p3"), "binance")
check(v[0] == "reset" and qty() is None,
      f"…so another account's key later is still told apart by the exchange: reset, not a question {v}")
for _n, _f in _real_order_fns.items():
    setattr(ob, _n, _f)
ab.get_account_id = _real_uid
json.dump({"venue": "binance", "book_hold": {"venue": "binance", "reason": "binance: cannot tell",
                                             "since": 1790000000, "ask": True, "halted": True}},
          open(os.path.join(pr.WORKSPACE_STATE, "venue_account.json"), "w"))
got = pr.account_guard()
check(got and got["book_hold"] == {"venue": "binance", "reason": "binance: cannot tell",
                                   "since": 1790000000},
      f"report: a hold that asks is forwarded, so the page can ask ({got})")
json.dump({"book_hold": {"venue": "binance", "reason": "network", "since": 1, "ask": False}},
          open(os.path.join(pr.WORKSPACE_STATE, "venue_account.json"), "w"))
check(pr.account_guard()["book_hold"] is None, "report: a network-only hold asks nothing")
os.remove(os.path.join(pr.WORKSPACE_STATE, "venue_account.json"))

cfg = {"amounts": {}}
now = time.time()
open(os.path.join(WS, "lib", "portfolio.py"), "w").write("# old lib\n")
check(pr.own_positions_only(cfg, now, {}) is False,
      "report: reconciler running without own_only in its snapshot (old lib) → false")
check(pr.own_positions_only(cfg, now, {"own_only": True}) is True,
      "report: the running reconciler's own snapshot says own_only → true")
check(pr.own_positions_only(cfg, None, {}) is False, "report: stopped, old lib on disk → false")
open(os.path.join(WS, "lib", "portfolio.py"), "w").write("def own_positions_only(config):\n    pass\n")
check(pr.own_positions_only(cfg, None, {}) is True, "report: stopped, the lib on disk has the rule → true")
check(pr.own_positions_only({"self_ledger": False}, now, {"own_only": True}) is False
      and pr.own_positions_only({"self_ledger": True}, None, {}) is True,
      "report: a written flag is taken as is")
with open(os.path.join(ROOT, "lib", "portfolio.py"), encoding="utf-8") as f:
    src = f.read()
check("def own_positions_only(" in src and "def book_ready(" in src,
      "the real lib/portfolio.py defines the names the runtime greps for")

print("\n" + ("all ok" if not fails else f"{fails} FAILED"))
sys.exit(1 if fails else 0)
