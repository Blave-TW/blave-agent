"""First bind routes the 下單設定 saved before it (0.1.28 flow audit P1-1).

Onboarding saves amounts (③) before any account exists (④), so the routing is stored as "".
The machine's first bind makes the save the user would otherwise be sent back to make; every
other blank routing (unbind → rebind, a venue switch that evicts the old one, paper → real)
keeps waiting for the user's own save, as before.

Runtime only, no network, no supervisor (stop / start are stubs). Keys are not-a-real-* strings.

Run: cd blave-agent && .venv/bin/python tests/check_first_bind_routing.py
"""
import json
import os
import shutil
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = tempfile.mkdtemp(prefix="first-bind-")
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = BASE
WS = os.path.join(BASE, "workspace")
shutil.copytree(os.path.join(ROOT, "lib"), os.path.join(WS, "lib"),
                ignore=shutil.ignore_patterns("__pycache__"))
os.environ["BLAVE_AGENT_BASE"] = BASE
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.pop("BLAVE_AGENT_LOCAL", None)
os.makedirs(os.path.join(WS, "state", "heartbeat"))
os.chdir(WS)
sys.path.insert(0, os.path.join(ROOT, "runtime"))

import command_listener as cl  # noqa: E402

sys.path.insert(0, WS)
import lib.account_okx as _okx  # noqa: E402


def _no_account_id(env):
    raise RuntimeError("no network in this test")


_okx.get_account_id = _no_account_id

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


starts = []
cl._stop_reconciler = lambda: True
cl._restart_reconciler = lambda args: starts.append(1) or "reconciler restarted"
cl._stray_reconciler_pids = lambda: []
cl._reconciler_supervised = lambda: False
cl._sync_strategy_crons = lambda names: None
# no /proc on macOS: the process scan fails closed (= not absent); answer "no reconciler" here
cl._unsupervised_reconciler_pids = lambda proc="/proc", all_=False: []
REAL_ABSENT = cl.reconciler_absent

CFG = os.path.join(WS, "manager", "portfolio_config.json")
MIRROR = os.path.join(WS, "manager", "amounts.ui.json")
OKX = {"OKX_API_KEY": "not-a-real-okx-key", "OKX_SECRET_KEY": "not-a-real-okx-secret",
       "OKX_PASSPHRASE": "not-a-real-okx-pass"}
PAPER = {"PAPER_API_KEY": "paper", "PAPER_SECRET_KEY": "paper", "PAPER_BOUND_TS": "100"}
CRYPTO = 'SYMBOL = "BTCUSDT"\nINTERVAL = "1h"\nfrom lib.data import fetch_kline\n'
TWSTOCK = 'SYMBOL = "2330"\nINTERVAL = "1d"\nfrom lib.data import fetch_twstock_price\n'


def fresh(strategies):
    """A never-bound workspace: platform keys only, no manifest / stop mark / parked account."""
    shutil.rmtree(os.path.join(WS, "manager"), ignore_errors=True)
    shutil.rmtree(os.path.join(WS, "strategies"), ignore_errors=True)
    for p in (cl.RECONCILER_STOP_MARK, cl.PARKED_ACCOUNT_STATE, os.path.join(WS, "state", "HALT")):
        if os.path.exists(p):
            os.remove(p)
    os.makedirs(os.path.join(WS, "manager"))
    open(os.path.join(WS, ".env"), "w").write("BLAVE_API_KEY=not-a-real-blave\n")
    for name, src in strategies.items():
        os.makedirs(os.path.join(WS, "strategies", name))
        open(os.path.join(WS, "strategies", name, "strategy.py"), "w").write(src)
    cl.reconciler_absent = REAL_ABSENT


def save(amounts):
    return cl.dispatch({"cmd": "amounts", "args": {"amounts": dict(amounts)}})


def bind(env):
    return cl.dispatch({"cmd": "credentials", "args": {"env": dict(env)}})


def unbind(env):
    return cl.dispatch({"cmd": "credentials_remove", "args": {"env": list(env)}})


def routes():
    return json.load(open(CFG))["exchanges"], json.load(open(MIRROR))["exchanges"]


try:
    # ── onboarding order: ③ save with nothing bound, ④ first bind ───────────────
    fresh({"c1": CRYPTO, "c2": CRYPTO})
    check(REAL_ABSENT(), "harness: no reconciler process for this workspace")
    save({"c1": 300000, "c2": 0})
    check(routes() == ({"c1": "", "c2": ""},) * 2 and cl._routing_block() is None,
          "③ before ④: routing stored blank in config and mirror; nothing bound, nothing to block")
    del starts[:]
    bind(PAPER)
    cfg = json.load(open(CFG))
    check(routes() == ({"c1": "paper", "c2": "paper"},) * 2
          and cfg["amounts"] == {"c1": 300000, "c2": 0},
          "first bind (paper): every member routed to it, amounts kept (金額 0 included)")
    check(cl._routing_block() is None and not starts,
          "…start is no longer refused NEEDS_ROUTING, and the bind itself started nothing")

    # ── unbind → rebind: the unbind's blank waits for the user's save ───────────
    unbind(PAPER)
    check(routes() == ({"c1": "", "c2": ""},) * 2, "full unbind blanks the routing (as before)")
    bind(PAPER)
    check(routes() == ({"c1": "", "c2": ""},) * 2
          and (cl._routing_block() or "").startswith("NEEDS_ROUTING:"),
          "rebind after an unbind: not routed, start refused NEEDS_ROUTING until saved")
    save({"c1": 300000, "c2": 0})
    check(routes() == ({"c1": "paper", "c2": "paper"},) * 2 and cl._routing_block() is None,
          "…the user's save routes it")

    # ── switch: first bind real, then another venue evicts it ───────────────────
    fresh({"c1": CRYPTO})
    save({"c1": 1000})
    bind(OKX)
    check(routes() == ({"c1": "okx"},) * 2, "first bind (OKX, a real account): routed to okx")
    bind(PAPER)
    check(routes() == ({"c1": ""},) * 2 and (cl._routing_block() or "").startswith("NEEDS_ROUTING:"),
          "switch (OKX evicted by paper): blank, start refused until saved — existing protection")

    # ── paper → real ────────────────────────────────────────────────────────────
    fresh({"c1": CRYPTO})
    save({"c1": 1000})
    bind(PAPER)
    check(routes() == ({"c1": "paper"},) * 2, "first bind paper: routed to paper")
    bind(OKX)
    check(routes() == ({"c1": ""},) * 2 and (cl._routing_block() or "").startswith("NEEDS_ROUTING:"),
          "paper → real (paper evicted): blank, start refused until saved")

    # ── a refused save stays a refusal: TW stock strategy on a crypto exchange ──
    fresh({"c1": CRYPTO, "t1": TWSTOCK})
    save({"c1": 1000, "t1": 1000})
    bind(OKX)
    check(routes() == ({"c1": "", "t1": ""},) * 2
          and (cl._routing_block() or "").startswith("NEEDS_ROUTING:"),
          "first bind whose save would be refused (MARKET_VENUE): nothing routed, the page asks for the save")
    try:
        save({"c1": 1000, "t1": 1000})
        refused = None
    except ValueError as e:
        refused = str(e)
    check((refused or "").startswith("MARKET_VENUE:"), f"…and that save says why ({refused})")

    # ── a live reconciler is never handed a routing by a bind ───────────────────
    fresh({"c1": CRYPTO})
    save({"c1": 1000})
    cl.reconciler_absent = lambda: False
    bind(PAPER)
    check(routes() == ({"c1": ""},) * 2, "first bind with a reconciler alive: not routed")

    # ── amounts come from the mirror, not a hand-edited config ──────────────────
    fresh({"c1": CRYPTO})
    save({"c1": 1000})
    cfg = json.load(open(CFG))
    cfg["amounts"] = {"c1": 999999}
    json.dump(cfg, open(CFG, "w"))
    bind(PAPER)
    cfg, mir = json.load(open(CFG)), json.load(open(MIRROR))
    check(cfg["amounts"] == {"c1": 1000} and mir["amounts"] == {"c1": 1000}
          and routes() == ({"c1": "paper"},) * 2,
          "first bind saves the mirror's amounts (UI-confirmed), never the config's")

    # ── not a first bind: an old machine with keys but no manifest; a stop mark ─
    fresh({"c1": CRYPTO})
    save({"c1": 1000})
    open(os.path.join(WS, ".env"), "a").write(
        "".join(f"{k}={v}\n" for k, v in OKX.items()))
    bind(PAPER)
    check(routes() == ({"c1": ""},) * 2, "keys already in .env before the bind: not a first bind")
    fresh({"c1": CRYPTO})
    save({"c1": 1000})
    open(cl.RECONCILER_STOP_MARK, "w").write("1")
    bind(PAPER)
    check(routes() == ({"c1": ""},) * 2, "a stop mark (only an unbind writes one): not a first bind")

    # ── each first-bind guard on its own (no other marker present) ──────────────
    fresh({"c1": CRYPTO})
    save({"c1": 1000})
    json.dump({"ids": [], "saved_at": "x"}, open(os.path.join(WS, "manager", "credentials.ui.json"), "w"))
    bind(PAPER)
    check(routes() == ({"c1": ""},) * 2, "only a manifest (an earlier bind / unbind wrote it): not a first bind")
    fresh({"c1": CRYPTO})
    save({"c1": 1000})
    open(cl.PARKED_ACCOUNT_STATE, "w").write("{}")
    bind(PAPER)
    check(routes() == ({"c1": ""},) * 2, "only a parked account (only an unbind parks one): not a first bind")
    fresh({"c1": CRYPTO})
    save({"c1": 1000})
    open(os.path.join(WS, ".env"), "a").write("PAPER_API_KEY=paper\nPAPER_SECRET_KEY=paper\n")
    bind(PAPER)
    check(routes() == ({"c1": ""},) * 2,
          "the same venue's keys already in .env, no manifest (nothing evicted): not a first bind")
    fresh({"c1": CRYPTO})
    save({"c1": 1000})
    mir = json.load(open(MIRROR))
    mir["exchanges"] = {"c1": "okx"}
    json.dump(mir, open(MIRROR, "w"))
    before = {p: open(p, "rb").read() for p in (CFG, MIRROR)}
    bind(PAPER)
    check({p: open(p, "rb").read() for p in (CFG, MIRROR)} == before,
          "a member already routed in the mirror: the first bind saves nothing")

    # ── a refusal is byte-for-byte nothing ──────────────────────────────────────
    fresh({"c1": CRYPTO, "t1": TWSTOCK})
    save({"c1": 1000, "t1": 1000})
    before = {p: open(p, "rb").read() for p in (CFG, MIRROR)}
    bind(OKX)
    check({p: open(p, "rb").read() for p in (CFG, MIRROR)} == before,
          "MARKET_VENUE on the first bind: config and mirror byte-identical")

    # ── no mirror (no UI save yet): nothing to route ────────────────────────────
    fresh({"c1": CRYPTO})
    json.dump({"amounts": {"c1": 1000}, "exchanges": {"c1": ""}}, open(CFG, "w"))
    bind(PAPER)
    check(json.load(open(CFG))["exchanges"] == {"c1": ""} and not os.path.exists(MIRROR),
          "config without a UI save: the bind writes no first mirror and routes nothing")
finally:
    os.chdir(ROOT)
    shutil.rmtree(BASE, ignore_errors=True)

print("PASS" if not fails else f"FAIL {fails}")
sys.exit(1 if fails else 0)
