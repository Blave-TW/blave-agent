"""Unbind empties that venue's book (Wei 2026-11-06, desktop 0.1.48).

A venue whose keys really leave .env — credentials_remove (〔自己處理並解除〕,
close_then_unbind's own finish) or a bind that evicts it — gets
lib.portfolio.reset_venue_book: seed `venue_reset`, its `venue_account` and
migration `pending` dropped, its parked unconfirmed orders released, 統一/群益
pending_sent files deleted; then the snapshot goes (and the account-guard state:
whole on a full unbind, only what names the venue on a partial one). Nothing is
parked any more. Other venues, `seeded_at` and `own_only_basis` never change, and
ledger_seed.json is edited, never rewritten fresh. A key rotation is not an unbind.
A workspace lib without reset_venue_book keeps today's behaviour.

Runtime + a workspace copy of lib, no network, no supervisor. Keys are
not-a-real-* strings.

Run: cd blave-agent && .venv/bin/python tests/check_unbind_clears_book.py
"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = tempfile.mkdtemp(prefix="unbind-clears-")
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = BASE
WS = os.path.join(BASE, "workspace")
shutil.copytree(os.path.join(ROOT, "lib"), os.path.join(WS, "lib"),
                ignore=shutil.ignore_patterns("__pycache__"))
os.makedirs(os.path.join(WS, "state", "heartbeat"))
os.makedirs(os.path.join(WS, "manager"))
os.environ["BLAVE_AGENT_BASE"] = BASE
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.pop("BLAVE_AGENT_LOCAL", None)
os.chdir(WS)
sys.path.insert(0, os.path.join(ROOT, "runtime"))

import command_listener as cl  # noqa: E402

sys.path.insert(0, WS)
import lib.account_okx as _okx  # noqa: E402
import lib.account_binance as _binance  # noqa: E402
from lib import portfolio  # noqa: E402


def _no_account_id(env):
    raise RuntimeError("no network in this test")


_okx.get_account_id = _binance.get_account_id = _no_account_id
cl._binance_bind_check = lambda env: None
cl._stop_reconciler = lambda: True
cl._stray_reconciler_pids = lambda: []
cl._reconciler_supervised = lambda: False
cl._sync_strategy_crons = lambda names: None

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


ENV = os.path.join(WS, ".env")
SEED = os.path.join(WS, "manager", "ledger_seed.json")
ORDERS = os.path.join(WS, "manager", "orders.jsonl")
SNAP = os.path.join(WS, "manager", "last_reconcile.json")
GUARD = os.path.join(WS, "state", "venue_account.json")
PARK = os.path.join(WS, "state", "order_unconfirmed.json")
PRES_SENT = os.path.join(WS, "state", "president_pending_sent.json")
TODO = os.path.join(WS, "state", "venue_reset_todo.json")
BIN = {"BINANCE_API_KEY": "not-a-real-binance-key", "BINANCE_SECRET_KEY": "not-a-real-binance-secret"}
OKX = {"OKX_API_KEY": "not-a-real-okx-key", "OKX_SECRET_KEY": "not-a-real-okx-secret",
       "OKX_PASSPHRASE": "not-a-real-okx-pass"}
OKX2 = dict(OKX, OKX_API_KEY="not-a-real-okx-key-2")
SEEDED_AT = "2026-09-01T00:00:00"


def env_file(*envs):
    lines = ["BLAVE_API_KEY=not-a-real-blave"] + [f"{k}={v}" for e in envs for k, v in e.items()]
    open(ENV, "w").write("\n".join(lines) + "\n")


def fill(ts, symbol, venue, qty):
    return json.dumps({"ts": ts, "symbol": symbol, "exchange": venue,
                       "legs": [{"signed_diff": qty * 100000, "signed_qty": qty}]})


def machine(*venues):
    """A machine that has traded on these venues: seed rows, fills, parked orders,
    snapshot, account-guard state."""
    for p in (SNAP, GUARD, PARK, PRES_SENT, TODO, cl.PARKED_ACCOUNT_STATE, cl.RECONCILER_STOP_MARK,
              os.path.join(WS, "state", "HALT")):
        if os.path.exists(p):
            os.remove(p)
    seed = {"seeded_at": SEEDED_AT, "own_only_basis": 1, "symbols": {}, "pending": {},
            "venue_account": {}}
    fills, parked = [], {}
    for v in venues:
        seed["symbols"][f"{v}|BTCUSDT"] = {"size": 1000.0, "qty": 0.01, "ts": "2026-09-02T00:00:00", "venue": v}
        seed["pending"][f"{v}|ETHUSDT"] = {"strategy": "a1", "since": "2026-09-02T00:00:00"}
        seed["venue_account"][v] = {"id": f"{v}-acct", "fp": "x", "at": "2026-09-02T00:00:00"}
        fills.append(fill("2026-09-03T00:00:00", "BTCUSDT", v, 0.01))
        parked[f"park-{v}"] = {"key": "SOLUSDT", "venue": v, "sign": 1, "signed_diff": 50.0,
                               "parked_at": 0, "reads": 0, "manual": False}
    json.dump(seed, open(SEED, "w"))
    open(ORDERS, "w").write("\n".join(fills) + "\n")
    json.dump(parked, open(PARK, "w"))
    json.dump({"ts": "2026-09-03T00:00:00", "target": {}, "actual": {"BTCUSDT": {"side": "long", "size": 2000}}},
              open(SNAP, "w"))
    json.dump({"venue": venues[0], "account_id": "acct", "book_hold": {"venue": venues[0], "ask": True},
               "pending": {"venue": venues[-1], "reason": "r"}}, open(GUARD, "w"))
    json.dump({"amounts": {"a1": 1000}, "exchanges": {"a1": venues[0]}},
              open(os.path.join(WS, "manager", "portfolio_config.json"), "w"))
    return open(SEED).read()


def qty(venue):
    return portfolio.ledger_positions(venue).get("BTCUSDT", {}).get("qty")


def seed():
    return json.load(open(SEED))


def parked_ids():
    return set(json.load(open(PARK))) if os.path.exists(PARK) else set()


def unbind(env, clear=True):
    """clear=True: the page told the user (desktop ≥0.1.48 / web, `clear_book: true`)."""
    args = {"env": list(env), **({"clear_book": True} if clear else {})}
    return cl.dispatch({"cmd": "credentials_remove", "args": args})


try:
    # ── 1. partial unbind on a two-venue machine: only binance is emptied ─────
    machine("binance", "okx")
    env_file(BIN, OKX)
    check(qty("binance") == 0.02 and qty("okx") == 0.02, "setup: both books hold the seed row plus a fill")
    unbind(BIN)
    s = seed()
    check(qty("binance") is None, "binance unbound: its book reads empty (rows and fills before the reset excluded)")
    check(qty("okx") == 0.02 and "okx|BTCUSDT" in s["symbols"] and "okx" in s["venue_account"]
          and list(s["pending"]) == ["okx|ETHUSDT"],
          "…okx's rows, fills, account and pending migration untouched")
    check(s["seeded_at"] == SEEDED_AT and s["own_only_basis"] == 1 and "binance" in s["venue_reset"],
          "…seeded_at and own_only_basis unchanged (book_ready stays true), venue_reset written for binance only")
    check("binance" not in s["venue_account"], "…binance's recorded account dropped")
    check(parked_ids() == {"park-okx"}, f"…binance's parked order released, okx's kept ({parked_ids()})")
    g = json.load(open(GUARD))
    check(not os.path.exists(SNAP) and "book_hold" not in g and g.get("pending", {}).get("venue") == "okx"
          and "venue" not in g and "account_id" not in g,
          f"…snapshot deleted; guard state keeps only okx's entries ({g})")
    check(not os.path.exists(cl.PARKED_ACCOUNT_STATE), "…nothing parked")
    check(portfolio.book_ready({}), "…book_ready() still true: no auto-baseline on the next start")

    # ── 2. full unbind → same keys back: clean start, nothing restored ───────
    machine("binance")
    env_file(BIN)
    unbind(BIN)
    s = seed()
    check(qty("binance") is None and s["own_only_basis"] == 1 and s["seeded_at"] == SEEDED_AT,
          "full unbind: binance book empty, seed basis kept")
    check(not os.path.exists(SNAP) and not os.path.exists(GUARD) and not os.path.exists(cl.PARKED_ACCOUNT_STATE),
          "…snapshot and guard state deleted, nothing parked")
    check(os.path.exists(cl.RECONCILER_STOP_MARK) and os.path.exists(os.path.join(WS, "state", "HALT")),
          "…stop mark and HALT as before")
    cl.dispatch({"cmd": "credentials", "args": {"env": dict(BIN)}})
    check(not os.path.exists(SNAP) and not os.path.exists(cl.PARKED_ACCOUNT_STATE),
          "same keys back: no snapshot comes back")
    v = portfolio.book_account_check(dict(BIN), "binance", account=("binance-acct", None, False))
    check(v[0] == "ok" and qty("binance") is None, f"…book_account_check ok, the book stays empty {v}")
    spec = importlib.util.spec_from_file_location("_rec", os.path.join(ROOT, "manager", "reconciler.py"))
    rec = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(rec)
    target = {"BTCUSDT": {"side": "long", "size": 1000}}
    _, reason, _ = rec.account_guard_decide({}, "binance", "binance-acct", rec._last_actual(), target, {}, False)
    check(rec._last_actual() == {} and reason is None,
          f"…first round reads no previous actual: the empty-read guard does not trip ({reason})")

    # ── 3. 統一: its sent-but-unclaimed orders go with the book ──────────────
    PRES = {"president_account": "not-a-real-acct", "president_password": "not-a-real-pw"}
    machine("president")
    env_file(PRES)
    json.dump({"o1": {"symbol": "TXF", "qty": 1}}, open(PRES_SENT, "w"))
    cl.president_connect.drop_vault = lambda *a, **k: None
    unbind(PRES)
    check(not os.path.exists(PRES_SENT) and qty("president") is None,
          "統一 unbound: president_pending_sent.json deleted (a rebind has nothing to claim), book empty")

    # ── 4. a bind never empties the venue it evicts (Wei 11-06): a clear_book sent with it is ignored ──
    machine("binance")
    env_file(BIN)
    cl.dispatch({"cmd": "credentials", "args": {"env": dict(OKX), "clear_book": True}})
    check(qty("binance") == 0.02 and "binance" not in seed().get("venue_reset", {}) and parked_ids() == {"park-binance"},
          "bind okx over binance with clear_book: ignored — binance's book and parked order kept")

    # ── 5. key rotation (same venue rewritten) is not an unbind ──────────────
    before = machine("okx")
    env_file(OKX)
    cl.dispatch({"cmd": "credentials", "args": {"env": dict(OKX2)}})
    s = seed()
    check("okx" not in s.get("venue_reset", {}) and qty("okx") == 0.02 and "okx|BTCUSDT" in s["symbols"]
          and parked_ids() == {"park-okx"} and os.path.exists(SNAP),
          "key rotation on okx: book, parked order and snapshot untouched")

    # ── 6. close_then_unbind still closing: refused, nothing cleared ─────────
    before = machine("okx")
    env_file(OKX)
    json.dump({"env": list(OKX), "venues": ["okx"]}, open(cl.UNBIND_AFTER_CLOSE_PATH, "w"))
    try:
        unbind(OKX)
        refused = False
    except RuntimeError:
        refused = True
    check(refused and open(SEED).read() == before and os.path.exists(SNAP) and parked_ids() == {"park-okx"},
          "close_then_unbind closing: the unbind is refused and book, snapshot, parked order stay")
    json.dump({"env": list(OKX), "venues": ["okx"], "held": True}, open(cl.UNBIND_AFTER_CLOSE_PATH, "w"))
    unbind(OKX)
    check(qty("okx") is None and not os.path.exists(cl.UNBIND_AFTER_CLOSE_PATH),
          "…held, then 自己處理並解除: unbound and emptied, the waiting request dropped")

    # ── 7. a stale second unbind (keys already gone) empties nothing ─────────
    machine("okx")
    env_file()
    before = open(SEED).read()
    unbind(OKX)
    check(open(SEED).read() == before and parked_ids() == {"park-okx"}
          and not os.path.exists(cl.PARKED_ACCOUNT_STATE),
          "unbind of a venue with no keys here: no book touched, nothing parked")

    # ── 8. corrupt seed: nothing written, other venues not wiped ─────────────
    machine("binance", "okx")
    env_file(BIN, OKX)
    open(SEED, "w").write("{not json")
    unbind(BIN)
    check(open(SEED).read() == "{not json" and os.path.exists(SNAP),
          "unreadable seed: reset_venue_book raises, the file is left as it was, and the snapshot stays with it")

    # ── 8b. a writer holding the seed lock: the reset waits, neither change is lost ──
    machine("binance", "okx")
    env_file(BIN, OKX)
    child = subprocess.Popen([sys.executable, "-c", (
        "import sys, time; sys.path.insert(0, '.'); from lib import portfolio as p\n"
        "with p._seed_lock():\n"
        "    s = p._load_ledger_seed()\n"
        "    print('locked', flush=True)\n"
        "    time.sleep(1.5)\n"
        "    s['symbols']['okx|BTCUSDT'] = dict(s['symbols']['okx|BTCUSDT'], size=0.0, qty=0.0, ts='2026-09-04T00:00:00')\n"
        "    p._save_ledger_seed(s)\n")], cwd=WS, stdout=subprocess.PIPE, text=True)
    child.stdout.readline()
    t0 = time.time()
    unbind(BIN)
    waited = time.time() - t0
    child.wait(timeout=30)
    s = seed()
    check(waited >= 1.0 and "binance" in s.get("venue_reset", {}) and s["symbols"]["okx|BTCUSDT"]["qty"] == 0.0,
          f"concurrent seed writer (reconciler): the unbind waits for its lock ({waited:.1f}s) — "
          "binance's reset and okx's zeroed row both survive")

    # ── 8c. a Windows file lock on pending_sent: committed, the cleanup owed and retried ──
    machine("president")
    env_file(PRES)
    os.makedirs(PRES_SENT)  # os.remove fails on it, as a held file does on Windows
    unbind(PRES)
    todo = json.load(open(TODO)) if os.path.exists(TODO) else {}
    check("president" in seed()["venue_reset"] and not os.path.exists(SNAP) and not os.path.exists(cl.PARKED_ACCOUNT_STATE)
          and "president" in todo,
          "pending_sent cannot be deleted: the reset still commits (snapshot gone, nothing parked), the cleanup stays owed")
    check(qty("president") is None and os.path.exists(TODO),
          "…the president book still reads (empty) while the cleanup is owed — no HALT loop")
    os.rmdir(PRES_SENT)
    json.dump({"o1": {"symbol": "TXF", "qty": 1}}, open(PRES_SENT, "w"))
    check(qty("president") is None and not os.path.exists(PRES_SENT) and not os.path.exists(TODO),
          "…next read finishes it: pending_sent deleted, todo cleared, book empty")

    # ── 8d. an unreadable park file: committed, released once it reads ───────
    machine("binance", "okx")
    env_file(BIN, OKX)
    good = open(PARK).read()
    open(PARK, "w").write("{not json")
    unbind(BIN)
    check("binance" in seed()["venue_reset"] and "binance" in json.load(open(TODO)),
          "park file unreadable: the reset commits, the release stays owed")
    open(PARK, "w").write(good)
    check(qty("binance") is None and parked_ids() == {"park-okx"} and not os.path.exists(TODO),
          "…readable again: the next binance read releases binance's park, okx's stays")

    # ── 8f. a reconcile round's own booking paths run before any book read ──
    # (_settle_parked, then the 統一／群益 claim's book_late_fill): what was sent before the
    # reset is never booked, whether or not the unbind's cleanup got to delete its record
    machine("binance", "okx")
    env_file(BIN, OKX)
    good = open(PARK).read()
    open(PARK, "w").write("{not json")
    unbind(BIN)
    open(PARK, "w").write(good)
    portfolio._settle_parked(query=lambda e: (0.5, 100.0), cancel=lambda e: False)
    check(qty("binance") is None and "SOLUSDT" not in portfolio.ledger_positions("binance"),
          "round order, park file back: _settle_parked drops binance's pre-reset park unbooked — book stays empty")
    check("SOLUSDT" in portfolio.ledger_positions("okx"),
          "…okx's park (never reset) is booked as before")
    machine("president")
    env_file(PRES)
    os.makedirs(PRES_SENT)
    sent_at = time.time() - 60
    unbind(PRES)
    r = portfolio.book_late_fill("TXF", "president", "TXF202611", 1, park_id=f"TXF202611@{sent_at}")
    check(r is None and qty("president") is None and portfolio.ledger_positions("president").get("TXF") is None,
          "round order, pending_sent still undeletable: the claim's late fill sent before the reset is not booked, no raise")
    os.rmdir(PRES_SENT)
    r = portfolio.book_late_fill("TXF", "president", "TXF202611", 1, park_id=f"TXF202611@{time.time() + 5}")
    check(r is True and (portfolio.ledger_positions("president").get("TXF") or {}).get("qty") == 1.0,
          "…a late fill sent after the reset (the rebound account's own) is booked")
    machine("president")
    env_file(PRES)
    os.makedirs(PRES_SENT)
    unbind(PRES)
    os.rmdir(PRES_SENT)
    good_seed = open(SEED).read()
    open(SEED, "w").write("{torn")
    try:
        portfolio.ledger_positions("president")
    except Exception:
        pass
    open(SEED, "w").write(good_seed)
    check(os.path.exists(TODO) and "president" in json.load(open(TODO)),
          "seed torn while the owed cleanup is checked: the todo is kept, not dropped")

    # ── 8e. a todo entry whose reset never landed is dropped, nothing cleaned ──
    machine("okx")
    env_file(OKX)
    json.dump({"okx": "2999-01-01T00:00:00"}, open(TODO, "w"))
    check(qty("okx") == 0.02 and parked_ids() == {"park-okx"} and not os.path.exists(TODO),
          "todo newer than the seed's venue_reset (the reset never committed): dropped, the park kept")

    # ── 10. the page decides (Wei 2026-11-06): no clear_book = an old page, the book is kept ──
    before = machine("okx")
    env_file(OKX)
    unbind(OKX, clear=False)
    check(open(SEED).read() == before and qty("okx") == 0.02 and parked_ids() == {"park-okx"}
          and os.path.exists(cl.PARKED_ACCOUNT_STATE) and not os.path.exists(TODO),
          "old page (no clear_book), full unbind: book and parked order kept, snapshot parked as before")
    cl.dispatch({"cmd": "credentials", "args": {"env": dict(OKX)}})
    check(os.path.exists(SNAP) and qty("okx") == 0.02,
          "…same keys back: the snapshot returns with the book (≤0.1.47 behaviour)")
    before = machine("binance", "okx")
    env_file(BIN, OKX)
    unbind(BIN, clear=False)
    check(open(SEED).read() == before and os.path.exists(SNAP) and parked_ids() == {"park-binance", "park-okx"},
          "old page, partial unbind: nothing cleared")
    before = machine("binance")
    env_file(BIN)
    cl.dispatch({"cmd": "credentials", "args": {"env": dict(OKX)}})
    check("binance" not in seed().get("venue_reset", {}) and qty("binance") == 0.02,
          f"binding okx over binance without clear_book (every page's bind, Wei 11-06): binance's book kept ({qty('binance')})")
    unbind(OKX)
    check("okx" in seed().get("venue_reset", {}) and qty("okx") is None,
          "…while unbinding okx afterwards (the unbind box, with clear_book) empties okx's book")
    machine("binance", "okx")
    env_file(BIN, OKX)
    unbind(BIN, clear=False)
    unbind(OKX, clear=True)
    s = seed()
    check("okx" in s.get("venue_reset", {}) and "binance" not in s.get("venue_reset", {})
          and qty("binance") == 0.02 and qty("okx") is None,
          "mixed: binance unbound by an old page (kept), okx by a new one (emptied) — each as its page said")
    for bad in (False, "true", 1):
        before = machine("okx")
        env_file(OKX)
        cl.dispatch({"cmd": "credentials_remove", "args": {"env": list(OKX), "clear_book": bad}})
        check(open(SEED).read() == before, f"clear_book={bad!r} is not true: the book is kept")

    # ── 11. the claim records a late fill dropped after an unbind as such, never as adopted ──
    seen = []
    real = {n: getattr(rec, n) for n in ("_pending_sent", "_president_nets", "_save_claimed", "_book_late_fill_or_halt")}
    real_audit = rec.guard.audit
    row = {"root": "TMF", "lots": 1, "net_expected": 0, "legs": [{"at": 1.0}]}
    try:
        rec._pending_sent = lambda *a, **k: {"TMFJ6": dict(row)}
        rec._president_nets = lambda: {"TMFJ6": 1.0}
        rec._save_claimed = lambda *a, **k: None
        rec.guard.audit = lambda ev, **f: seen.append(ev)
        for ret, want in ((None, "late_fill_dropped_after_reset"), (True, "late_fill_adopted")):
            del seen[:]
            rec._book_late_fill_or_halt = lambda *a, **k: ret
            rec._president_claim_pending(0.0)
            check(seen == [want], f"president claim, book_late_fill → {ret!r}: audit {want} ({seen})")
    finally:
        for n, f in real.items():
            setattr(rec, n, f)
        rec.guard.audit = real_audit

    # ── 9. workspace lib without reset_venue_book: today's behaviour ─────────
    real = portfolio.reset_venue_book
    del portfolio.reset_venue_book
    try:
        before = machine("okx")
        env_file(OKX)
        unbind(OKX)
        check(open(SEED).read() == before and qty("okx") == 0.02,
              "old lib: the book is kept, no raise")
        check(os.path.exists(cl.PARKED_ACCOUNT_STATE) and not os.path.exists(SNAP),
              "…full unbind parks the snapshot as before")
        cl.dispatch({"cmd": "credentials", "args": {"env": dict(OKX)}})
        check(os.path.exists(SNAP) and not os.path.exists(cl.PARKED_ACCOUNT_STATE),
              "…and the same keys back restore it (also how a pre-0.1.48 park is handled)")
    finally:
        portfolio.reset_venue_book = real
finally:
    os.chdir(ROOT)
    shutil.rmtree(BASE, ignore_errors=True)

print("\nFAILED" if fails else "\nall ok")
sys.exit(1 if fails else 0)
