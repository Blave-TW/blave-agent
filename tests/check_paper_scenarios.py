"""Every scenario a live strategy can go through, on the PAPER venue — one test
case per scenario ID of .claude/output/specs/paper-scenario-matrix-2026-09-23.md
(monorepo root), and the matrix and this file must list the same IDs.

Each scenario runs in its own child process on its own scratch workspace: a
copy of lib/ and manager/*.py from --src (default: this repo), so a mutation
run can point --src at a mutated copy. The real code does everything:
  - reconciler rounds = manager/reconciler.py's own loop gates (restart record,
    no-venue idle, HALT sync) + lib.portfolio.reconcile with the reconciler's
    _get_positions_guarded / place_order / _symbol_threshold;
  - orders = lib.execute → lib.venue_wiring → lib.order_paper (TWAP / chase
    threads included, their clocks shortened);
  - commands = runtime/command_listener.dispatch (resume, resume_wait, halt,
    close_all → a real manager/flatten.py subprocess, credentials,
    credentials_remove, amounts, execution, delete_strategy, restart_reconciler);
  - the report fields = runtime/portfolio_reporter's own helpers.
What is stubbed: the OS process layer only (systemd / tmux / NSSM start/stop is a
fake supervisor, crontab sync is a no-op), the exchange's lot size where a
scenario says so, and TWAP/chase clocks. Prices are deterministic: each symbol's
price strategy reads state/marks.json in its fetch_data — the channel paper
fills really use (lib/paper_data). Manual positions are written straight into
state/paper_ledger.json. No network: every child refuses socket connects and
DNS, and never opens the repo .env or ~/.config/blave.

A few scenarios run the real `manager/reconciler.py` __main__ as a subprocess
(kill mid-TWAP → restart). The rest simulate a reconciler restart by loading a
fresh reconciler module and resetting lib/portfolio's per-process state.

A scenario that fails because of a real bug asserts the intended behaviour and
is listed in KNOWN_BUGS: it is reported "xfail", and starts failing the run the
day it passes (take it off the list and the matrix note together).

Run:     cd blave-agent && .venv/bin/python tests/check_paper_scenarios.py
         … --only SL-01,SL-05   … --src /path/to/copy   … -j 1
"""
import argparse
import concurrent.futures
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
MATRIX = os.path.join(os.path.dirname(ROOT), ".claude", "output", "specs",
                      "paper-scenario-matrix-2026-09-23.md")
CHILD_TIMEOUT_S = 150

SCEN = {}
# Scenarios that fail today because of a real bug (reported, not fixed here).
# A known bug that starts passing fails the run: take it off this list and the
# matrix's "KNOWN BUG" note in the same change.
KNOWN_BUGS = {
}


def scenario(sid):
    def deco(fn):
        assert sid not in SCEN, sid
        SCEN[sid] = fn
        return fn
    return deco


# ── child-side world ─────────────────────────────────────────────────────────

MARKS = {"BTCUSDT": 50000.0, "ETHUSDT": 2000.0, "SOLUSDT": 100.0, "DOGEUSDT": 0.2,
         "TMF": 20000.0}

TRADE_SRC = '''STRATEGY_NAME = {name!r}
SYMBOL = {symbol!r}
MARKET = {market!r}
{interval}
'''

PRICE_SRC = '''STRATEGY_NAME = {name!r}
SYMBOL = {symbol!r}
INTERVAL = "1h"


def fetch_data(hdrs):
    import json
    import pandas as pd
    px = float(json.load(open("state/marks.json"))[{symbol!r}])
    end = pd.Timestamp.now(tz="UTC").tz_localize(None).floor("min")
    idx = pd.date_range(end=end, periods=3, freq="min")
    return pd.DataFrame({{"Open": px, "High": px, "Low": px, "Close": px, "Volume": 1.0}}, index=idx)
'''


class Fail(Exception):
    """A scenario step that could not complete (not an assertion)."""


class World:
    """One scratch workspace, the real modules loaded from it."""

    def __init__(self, ws, src):
        self.ws, self.src = ws, src
        self.fails = 0
        os.chdir(ws)
        sys.path.insert(0, ws)
        sys.path.append(os.path.join(src, "runtime"))
        import logging
        logging.getLogger().setLevel(logging.CRITICAL)
        from lib import (account_paper, execute, guard, notify, order_paper, paper_data,
                         portfolio, venue_wiring)
        for m in (portfolio, venue_wiring, execute, order_paper, guard):
            assert os.path.realpath(m.__file__).startswith(os.path.realpath(ws)), m.__file__
        self.pf, self.vw, self.ex, self.op = portfolio, venue_wiring, execute, order_paper
        self.pd, self.guard, self.ap = paper_data, guard, account_paper
        self.tg = []
        notify.make_sender = lambda photo=False: self.tg.append
        notify.send_text = self.tg.append
        portfolio._notify_best_effort = self.tg.append
        execute._notify_fn = self.tg.append
        import command_listener as cl
        import portfolio_reporter as pr
        assert os.path.realpath(cl.WORKSPACE) == os.path.realpath(ws), cl.WORKSPACE
        for m in (cl, pr):
            assert os.path.realpath(m.__file__).startswith(os.path.realpath(src)), m.__file__
        self.cl, self.pr = cl, pr
        self.sup = {"running": False, "starts": 0, "stops": 0, "stop_ok": True}
        cl._restart_reconciler = self._sup_start
        cl._stop_reconciler = self._sup_stop
        cl._stray_reconciler_pids = lambda: list(self.strays)
        cl._reconciler_supervised = lambda: self.sup["running"]
        cl._sync_strategy_crons = lambda names: None
        self.strays = []
        # the exchange's lot size where a scenario sets one (paper's own rules are
        # permissive: step 1e-8, no minimum)
        self.lots = {}
        real_rules = order_paper.get_contract_rules

        def rules(env, sym):
            if sym in self.lots:
                lot = self.lots[sym]
                return {"step": repr(lot), "min_qty": lot, "min_notional": 0.0,
                        "contract_value": 1.0, "price_tick": "0.01", "active": True}
            return real_rules(env, sym)
        order_paper.get_contract_rules = rules
        # two reads of a short account "at least one poll apart" — rounds here are
        # back to back; the one scenario about the gap restores it
        portfolio._ACCOUNT_SHORT_MIN_S = 0
        # async executors, on a test clock
        self.twap_slice_s = 0.03
        real_twap = execute.run_twap
        execute.run_twap = lambda sym, side, qty, dur, n, *a, **k: real_twap(
            sym, side, qty, self.twap_slice_s * n / 60.0, n, *a, **k)
        execute._CHASE_TIMEOUT_S, execute._CHASE_POLL_S = 0.6, 0.1
        from lib import data as _data

        def _no_kline(*a, **k):
            raise RuntimeError("paper harness: no network kline")
        _data.fetch_kline = _no_kline
        self.rec = None
        self.marks(**MARKS)
        self._load_reconciler()

    # ── checks ──
    def check(self, cond, msg):
        print(("ok   " if cond else "FAIL ") + msg, flush=True)
        if not cond:
            self.fails += 1
        return cond

    def eq(self, got, want, msg):
        return self.check(got == want, f"{msg} (got {got!r}, want {want!r})")

    # ── prices ──
    def marks(self, **px):
        cur = {}
        try:
            cur = json.load(open("state/marks.json"))
        except (OSError, ValueError):
            pass
        cur.update(px)
        for k in [k for k, v in cur.items() if v is None]:
            del cur[k]
        os.makedirs("state", exist_ok=True)
        json.dump(cur, open("state/marks.json", "w"))
        for sym in cur:
            self._price_strategy(sym)
        self._clear_caches()

    def drop_mark(self, sym):
        cur = json.load(open("state/marks.json"))
        cur.pop(sym, None)
        json.dump(cur, open("state/marks.json", "w"))
        self._clear_caches()

    def _clear_caches(self):
        self.pd._price_cache.clear()
        if self.rec is not None:
            self.rec._min_order_gate.clear()

    def _price_strategy(self, sym):
        d = f"strategies/zz_px_{sym.lower()}"
        if not os.path.exists(f"{d}/strategy.py"):
            os.makedirs(d, exist_ok=True)
            open(f"{d}/strategy.py", "w").write(PRICE_SRC.format(name=f"zz_px_{sym.lower()}",
                                                                 symbol=sym))

    # ── strategies and signals ──
    def strategy(self, name, symbol="BTCUSDT", market="swap", type_b=False, portfolio=False):
        d = f"strategies/{name}"
        os.makedirs(d, exist_ok=True)
        interval = "" if type_b else 'INTERVAL = "1h"'
        src = TRADE_SRC.format(name=name, symbol=symbol, market=market, interval=interval)
        if portfolio:
            src = src.replace(f"SYMBOL = {symbol!r}\n", "")
        open(f"{d}/strategy.py", "w").write(src)
        stats = ({"benchmark_return": 0.0, "total_return": 0.0} if portfolio
                 else {"symbol": symbol, "total_return": 0.0})
        json.dump(stats, open(f"{d}/stats.json", "w"))

    def sig(self, name, position, symbol=None):
        if symbol is None:
            symbol = self._symbol_of(name)
        market = self.pf.strategy_market(name)
        self.ex.save_state(name, {"symbol": symbol, "position": float(position),
                                  "market": market, "updated_at": int(time.time())})

    def weights(self, name, weights, rebalance_at):
        self.ex.save_state(name, {"type": "portfolio", "weights": weights,
                                  "rebalance_at": int(rebalance_at), "bar_at": int(rebalance_at),
                                  "updated_at": int(time.time())})

    def _symbol_of(self, name):
        try:
            return json.load(open(f"strategies/{name}/stats.json"))["symbol"]
        except (OSError, ValueError, KeyError):
            return "BTCUSDT"

    # ── the fake supervisor (systemd / tmux / NSSM) ──
    def _sup_start(self, args=None):
        self.sup["running"] = True
        self.sup["starts"] += 1
        self.restart_process()
        return "reconciler restarted"

    def _sup_stop(self):
        if not self.sup["stop_ok"]:
            return False
        self.sup["running"] = False
        self.sup["stops"] += 1
        self.cl._resume_started_at = None
        return True

    def _load_reconciler(self):
        spec = importlib.util.spec_from_file_location("reconciler", "manager/reconciler.py")
        rec = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(rec)
        rec._raw_send = self.tg.append
        self.rec = rec

    def restart_process(self):
        """A new reconciler process: fresh module state, then its startup sweep
        and dead-execution reap, as its __main__ does."""
        pf = self.pf
        pf._baseline_seen = None
        pf._baseline_wait = None
        pf._pending_seen.clear()
        pf._unconfigured_logged = False
        self.vw._SPOT_LEGACY_SAID.clear()
        self.guard._halt_flag = False
        self._load_reconciler()
        try:
            self.vw.sweep_orphan_orders()
        except Exception:
            pass
        try:
            self.ex.reap_dead_inflight()
        except Exception:
            pass

    # ── commands (the real runtime dispatch) ──
    def cmd(self, _cmd, **args):
        try:
            return self.cl.dispatch({"cmd": _cmd, "args": args})
        except Exception as e:
            return e

    def bind_paper(self, ts=None):
        ts = int(time.time()) if ts is None else ts
        return self.cmd("credentials", env={"PAPER_API_KEY": "paper", "PAPER_SECRET_KEY": "paper",
                                            "PAPER_BOUND_TS": str(ts)})

    def amounts(self, **amts):
        return self.cmd("amounts", amounts=amts)

    def start(self, wait=False, human_delay=True):
        """The user's 啟動下單. A human takes longer than the 15 s 'running
        right now' window between a stop and the next start: with the daemon
        down, its last heartbeat is made that old."""
        if human_delay and not self.sup["running"]:
            self.age_heartbeat(400)
        return self.cmd("resume_wait" if wait else "resume")

    def age_heartbeat(self, seconds):
        hb = os.path.join("state", "heartbeat", "reconciler")
        if os.path.exists(hb):
            t = time.time() - seconds
            os.utime(hb, (t, t))

    def env(self):
        return self.vw.read_env()

    # ── one reconciler round, the daemon's own gates first ──
    def round(self, wait=True):
        rec = self.rec
        if not self.sup["running"]:
            return "down"
        rec.HEARTBEAT_PATH.parent.mkdir(parents=True, exist_ok=True)
        rec.HEARTBEAT_PATH.touch()
        rec.GATED_MARKER_PATH.touch()
        if rec.RESTART_STOP_PATH.exists():
            return "restart_stopped"
        if not rec._venue_bound():
            rec._reset_outage()
            return "idle"
        mt = rec._active_state_mtimes()
        rec._sync_halt_flag(mt.get("__halt__", 0))
        self._clear_caches()
        out = "ok"
        try:
            rec.reconcile(get_positions_fn=rec._get_positions_guarded,
                          place_order_fn=rec.place_order,
                          threshold=rec._symbol_threshold,
                          send_telegram_fn=self.tg.append)
        except rec.ReadSkipped as e:
            out = f"skipped: {e}"
        except Exception as e:
            out = f"error: {type(e).__name__}: {e}"
        if wait:
            self.wait_async()
        return out

    def wait_async(self, timeout=30):
        deadline = time.time() + timeout
        while self.ex.list_inflight() and time.time() < deadline:
            time.sleep(0.02)

    def settle(self, max_rounds=6):
        """Rounds until one fills nothing (the daemon's force_next loop).
        Returns every paper fill placed on the way."""
        placed = []
        for _ in range(max_rounds):
            n = len(self.paper_fills())
            out = self.round()
            if out == "down" or out.startswith("error"):
                # "nothing traded" must never be a crashed or absent reconciler
                self.check(False, f"settle: the round did not run ({out})")
                break
            new = self.paper_fills()[n:]
            placed += new
            if not new:
                break
        return placed

    # ── observations ──
    def ledger(self):
        try:
            return json.load(open("state/paper_ledger.json"))
        except (OSError, ValueError):
            return {}

    def paper_fills(self):
        led = self.ledger()
        out = []
        for f in led.get("fills") or []:
            o = (led.get("orders") or {}).get(f["order_id"]) or {}
            key = f["symbol"] + ("@spot" if f.get("market") == "spot" else "")
            out.append((key, f["side"], round(float(f["qty"]), 8), bool(o.get("reduce_only"))))
        return out

    def paper_pos(self, sym=None):
        led = self.ledger()
        pos = {s: round(float(p["qty"]), 8) for s, p in (led.get("positions") or {}).items()}
        spot = {a + "USDT@spot": round(float(v), 8) for a, v in (led.get("spot") or {}).items()}
        pos.update(spot)
        return pos if sym is None else pos.get(sym, 0.0)

    def book(self, digits=8, venue="paper"):
        return {k: (round(v["qty"], digits), round(v["cost"], 2)) + (("legacy",) if v["legacy"] else ())
                for k, v in self.pf.ledger_book(venue).items()}

    def seed(self):
        try:
            return json.load(open("manager/ledger_seed.json"))
        except (OSError, ValueError):
            return None

    def snap(self):
        try:
            return json.load(open("manager/last_reconcile.json"))
        except (OSError, ValueError):
            return {}

    def order_errors(self):
        try:
            return json.load(open("manager/order_errors.json"))
        except (OSError, ValueError):
            return []

    def orders_log(self):
        try:
            return [json.loads(l) for l in open("manager/orders.jsonl") if l.strip()]
        except OSError:
            return []

    def audit(self, event=None):
        try:
            rows = [json.loads(l) for l in open("state/audit.jsonl") if l.strip()]
        except OSError:
            return []
        return [r for r in rows if event is None or r.get("event") == event]

    def events(self, kind=None):
        try:
            rows = [json.loads(l) for l in open("state/events.jsonl") if l.strip()]
        except OSError:
            return []
        return [r for r in rows if kind is None or r.get("type") == kind]

    def halted(self):
        return os.path.exists("state/HALT")

    def halt_info(self):
        try:
            return json.load(open("state/HALT"))
        except (OSError, ValueError):
            return None

    def report(self):
        pr = self.pr
        cfg_path = os.path.join(self.ws, "manager", "portfolio_config.json")
        cfg = pr._read_json(cfg_path) if os.path.exists(cfg_path) else {}
        hb = pr._mtime(os.path.join(self.ws, "state", "heartbeat", "reconciler"))
        last = pr._read_json(os.path.join(self.ws, "manager", "last_reconcile.json"))
        stopped = pr.restart_stop(hb, cfg if isinstance(cfg, dict) else {}, pr.venues())
        return {"self_ledger": pr.own_positions_only(cfg, hb, last),
                "portfolio_configured": pr.portfolio_configured(cfg_path, hb, last),
                "halt": pr.halt_state(), "stopped": stopped, "account_guard": pr.account_guard(),
                "alive": pr._fresh(hb) and stopped is None,
                "last": last or {}, "order_errors": self.order_errors(),
                "states": pr.strategy_states(), "can_wait_start": pr._workspace_has_signal_gate(),
                "can_trade_portfolio": pr.can_trade_portfolio()}

    # ── the user's own trades (never through Blave) ──
    def manual(self, sym, qty, entry=None):
        """Add a manual position straight into the paper ledger: swap `qty` base
        units (signed), or a spot key "BTCUSDT@spot" (base units bought)."""
        env = self.env()
        with self.op._txn(env) as led:
            if sym.endswith("@spot"):
                base = sym[:-5].replace("USDT", "")
                led["spot"][base] = led["spot"].get(base, 0.0) + qty
                if led["spot"][base] <= 0:
                    led["spot"].pop(base)
                return
            pos = led["positions"].get(sym, {"qty": 0.0, "entry": 0.0})
            q1 = float(pos["qty"]) + qty
            if abs(q1) < 1e-12:
                led["positions"].pop(sym, None)
            else:
                led["positions"][sym] = {"qty": q1,
                                         "entry": entry or json.load(open("state/marks.json"))[sym]}

    def wait_flatten(self, n=1, timeout=60):
        """manager/flatten.py runs detached (close_all): wait for its n-th end line."""
        ends = ("flatten done", "nothing closed", "this one exits")
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                log = open("state/flatten.log").read()
            except OSError:
                log = ""
            if sum(log.count(e) for e in ends) >= n:
                time.sleep(0.1)
                return log
            time.sleep(0.05)
        raise Fail(f"flatten did not finish within {timeout}s: {log[-600:]}")

    def shift_time(self, seconds):
        """lib/portfolio's clock (the baseline fallback timer) moves forward."""
        import types
        off = getattr(self, "_pf_off", 0.0) + seconds
        self._pf_off = off
        real = time.time
        self.pf.time = types.SimpleNamespace(time=lambda: real() + off, sleep=time.sleep)

    def old_machine(self, strategies=(("a1", "BTCUSDT"),), amounts=None, cfg_extra=None,
                    seed=None):
        """A machine from before the own-positions rule: config saved without the
        self_ledger key (no UI mirror yet), no baseline the rule trusts. Paper is
        bound; positions are injected by the scenario, then the daemon starts."""
        for spec in strategies:
            self.strategy(spec[0], spec[1], spec[2] if len(spec) > 2 else "swap")
        self.bind_paper()
        amounts = amounts if amounts is not None else {spec[0]: 1000 for spec in strategies}
        cfg = {"amounts": amounts, "exchanges": {n: "paper" for n in amounts},
               "asset_specs": {}}
        cfg.update(cfg_extra or {})
        json.dump(cfg, open("manager/portfolio_config.json", "w"))
        if seed is not None:
            json.dump(seed, open("manager/ledger_seed.json", "w"))

    def boot(self):
        """The daemon is running (as if started earlier)."""
        self.sup["running"] = True
        self.restart_process()

    # ── common setups ──
    def fresh(self, strategies=(("a1", "BTCUSDT"),), amounts=None, signals=None, start=True):
        """A fresh machine: paper bound, strategies written, amounts saved (the
        first save writes self_ledger + a zero baseline), signals, start."""
        for spec in strategies:
            name, sym = spec[0], spec[1]
            market = spec[2] if len(spec) > 2 else "swap"
            self.strategy(name, sym, market)
        self.bind_paper()
        amounts = amounts if amounts is not None else {spec[0]: 1000 for spec in strategies}
        self.amounts(**amounts)
        for name, pos in (signals or {}).items():
            self.sig(name, pos)
        if start:
            self.start()


def run_child(sid, ws, src):
    w = World(ws, src)
    try:
        SCEN[sid](w)
    except Exception:
        traceback.print_exc()
        print(f"FAIL {sid} raised")
        return 1
    return 1 if w.fails else 0


# ── scenarios ────────────────────────────────────────────────────────────────
# BTC 50,000 · ETH 2,000 · SOL 100 · DOGE 0.2 unless a scenario moves them.
# Fill tuples: (key, side, base qty, reduce_only). Book tuples: (qty, cost[, "legacy"]).

B = "BTCUSDT"


@scenario("SL-01")
def sl01(w):
    w.fresh(signals={"a1": 1})
    w.eq(w.round(), "ok", "round runs")
    w.eq(w.paper_fills(), [(B, "buy", 0.02, False)], "flat→long buys amount ÷ mark")
    w.eq(w.book(), {B: (0.02, 1000.0)}, "book = the bot's own fill")
    w.eq(w.snap()["ledger"], {}, "the snapshot is written BEFORE placing: ledger still empty")
    w.eq(w.settle(), [], "converged: the next round places nothing")
    s = w.snap()
    w.eq(s["target"][B]["size"], 1000.0, "snapshot target")
    w.eq((s["ledger"][B]["qty"], s["ledger"][B]["size"]), (0.02, 1000.0), "snapshot ledger")
    w.eq(s["actual"][B]["size"], 1000.0, "snapshot actual = paper position at mark")
    w.check(s.get("own_only") is True and "needs_baseline" not in s, "own_only, baseline ready")
    leg = w.orders_log()[-1]["legs"][0]
    w.eq((leg["exchange"], leg["signed_qty"]), ("paper", 0.02), "orders.jsonl leg")
    r = w.report()
    w.check(r["self_ledger"] is True and r["portfolio_configured"] is True and r["alive"],
            "report: self_ledger true, configured, alive")


def _long(w, pos=1, **kw):
    """fresh machine, a1 $1000 on BTC holding `pos` (filled)."""
    w.fresh(signals={"a1": pos}, **kw)
    w.settle()


@scenario("SL-02")
def sl02(w):
    _long(w)
    w.sig("a1", 1.5)
    w.eq(w.settle(), [(B, "buy", 0.01, False)], "increase 1→1.5 buys the $500 gap")
    w.eq(w.book(), {B: (0.03, 1500.0)}, "book grows qty and cost together")


@scenario("SL-03")
def sl03(w):
    _long(w, 1.5)
    w.sig("a1", 0.5)
    w.eq(w.settle(), [(B, "sell", 0.02, True)], "decrease 1.5→0.5 sells 0.02 reduce-only")
    w.eq(w.book(), {B: (0.01, 500.0)}, "book shrinks by the share sold")


@scenario("SL-04")
def sl04(w):
    _long(w)
    w.sig("a1", 0)
    w.eq(w.settle(), [(B, "sell", 0.02, True)], "long→flat closes exactly the bot's 0.02")
    w.eq(w.book(), {}, "book flat")
    w.eq(w.paper_pos(), {}, "paper flat")


@scenario("SL-05")
def sl05(w):
    _long(w)
    w.sig("a1", -1)
    w.eq(w.settle(), [(B, "sell", 0.02, True), (B, "sell", 0.02, False)],
         "flip = reduce-only close leg, then the opening leg")
    w.eq(w.book(), {B: (-0.02, -1000.0)}, "book short")
    e = [x for x in w.orders_log() if len(x["legs"]) == 2]
    w.check(len(e) == 1 and not e[0].get("failed"), "one orders.jsonl entry with both legs")


@scenario("SL-06")
def sl06(w):
    w.fresh(signals={"a1": -1})
    w.eq(w.settle(), [(B, "sell", 0.02, False)], "flat→short sells 0.02")
    w.sig("a1", 0)
    w.eq(w.settle(), [(B, "buy", 0.02, True)], "short→flat buys back 0.02 reduce-only")
    w.eq((w.book(), w.paper_pos()), ({}, {}), "flat")


@scenario("SL-07")
def sl07(w):
    _long(w)
    for px in (60000.0, 40000.0):
        w.marks(BTCUSDT=px)
        w.eq(w.settle(), [], f"signal unchanged, mark {px:.0f}: nothing trades (book is cost)")
    w.marks(BTCUSDT=60000.0)
    w.sig("a1", 0)
    w.eq(w.settle(), [(B, "sell", 0.02, True)], "the close at 60,000 sells what was bought, 0.02")
    w.eq(w.book(), {}, "book flat, no phantom")


@scenario("SL-08")
def sl08(w):
    _long(w)
    w.restart_process()
    w.eq(w.round(), "ok", "a new reconciler process runs its first round (account guard due)")
    w.eq(w.settle(), [], "signal unchanged across the restart: nothing trades")
    w.eq(w.book(), {B: (0.02, 1000.0)}, "the book lives in files, not memory")
    w.check(not w.halted(), "no guard trip")


@scenario("SL-09")
def sl09(w):
    w.fresh(signals={"a1": 0.5})
    w.eq(w.settle(), [(B, "buy", 0.01, False)], "fractional 0.5 → $500")
    w.sig("a1", 0.52)
    w.eq(w.settle(), [(B, "buy", 0.0004, False)], "0.5→0.52 is $20 > the $10 gate: trades")
    w.sig("a1", 0.525)
    w.eq(w.settle(), [], "0.52→0.525 is $5 < the $10 gate: nothing")


@scenario("SL-10")
def sl10(w):
    w.strategy("b1", B, type_b=True)
    w.bind_paper()
    w.amounts(b1=1000)
    w.sig("b1", 1)
    w.start()
    w.eq(w.settle(), [(B, "buy", 0.02, False)], "a Type B strategy's state.json trades like Type A")
    w.eq(w.book(), {B: (0.02, 1000.0)}, "…into the same book")


@scenario("SL-11")
def sl11(w):
    w.strategy("b1", B, type_b=True)
    w.fresh(signals={}, amounts={})
    # a Type B strategy that calls the order lib itself instead of writing a signal
    w.op.place_market_order(w.env(), B, "long", 0.01, client_order_id="typeb-1")
    w.eq(w.paper_pos(B), 0.01, "the direct order filled on paper")
    w.eq(w.book(), {}, "…and is not in the bot's book (no orders.jsonl line)")
    w.eq(w.settle(), [], "the reconciler leaves it alone")
    w.cmd("close_all")
    w.wait_flatten()
    w.eq(w.paper_pos(B), 0.01, "close_all does not close it either (it reads as the user's)")


@scenario("SL-12")
def sl12(w):
    w.fresh(signals={})
    w.sig("a1", 1, symbol="BTC-USDT")
    w.eq(w.settle(), [(B, "buy", 0.02, False)], "a dashed symbol trades on the canonical key")
    w.eq(list(w.snap()["target"]), [B], "target key canonical")


# ── multiple strategies on one symbol ─────────────────────────────────────────

@scenario("MS-01")
def ms01(w):
    w.fresh(strategies=(("a1", B), ("a2", B)), amounts={"a1": 1000, "a2": 600},
            signals={"a1": 1, "a2": 1})
    w.eq(w.settle(), [(B, "buy", 0.032, False)], "two longs net into one $1,600 order")
    c = w.orders_log()[-1]["contributors"]
    w.eq(sorted(x["strategy"] for x in c), ["a1", "a2"], "both contributors on the order")
    w.eq(w.book(), {B: (0.032, 1600.0)}, "one book row per symbol")


@scenario("MS-02")
def ms02(w):
    w.fresh(strategies=(("a1", B), ("a2", B)), amounts={"a1": 1000, "a2": 600},
            signals={"a1": 1, "a2": 1})
    w.settle()
    w.sig("a1", 0)
    w.eq(w.settle(), [(B, "sell", 0.02, True)], "one exits while the other holds: sell its $1,000")
    w.eq(w.book(), {B: (0.012, 600.0)}, "the holder's share stays")


@scenario("MS-03")
def ms03(w):
    w.fresh(strategies=(("a1", B), ("a2", B)), amounts={"a1": 1000, "a2": 600},
            signals={"a1": 1, "a2": -1})
    w.eq(w.settle(), [(B, "buy", 0.008, False)], "opposite signals net: +1000 −600 = buy $400")
    w.eq(w.snap()["target"][B]["size"], 400.0, "target is the net")


@scenario("MS-04")
def ms04(w):
    w.fresh(strategies=(("a1", B), ("a2", B)), amounts={"a1": 1000, "a2": 1000},
            signals={"a1": 1, "a2": 0})
    w.settle()
    w.sig("a2", -1)
    w.eq(w.settle(), [(B, "sell", 0.02, True)], "an equal opposite signal nets to flat: close")
    w.eq((w.book(), w.paper_pos()), ({}, {}), "flat")


@scenario("MS-05")
def ms05(w):
    w.fresh(strategies=(("a1", B), ("s1", B, "spot")), amounts={"a1": 1000, "s1": 500},
            signals={"a1": 1, "s1": 1})
    got = sorted(w.settle())
    w.eq(got, [(B, "buy", 0.02, False), (B + "@spot", "buy", 0.01, False)],
         "swap and spot on the same coin never net: two orders")
    w.eq(w.book(), {B: (0.02, 1000.0), B + "@spot": (0.01, 500.0)}, "two book rows")


@scenario("MS-06")
def ms06(w):
    w.fresh(strategies=(("a1", B), ("a2", B)), amounts={"a1": 1000, "a2": 600},
            signals={"a1": 1, "a2": 1}, start=False)
    w.cmd("halt", reason="test")
    w.start(wait=True)
    w.eq(w.settle(), [], "both gated at start: no catch-up")
    w.sig("a2", 0)
    w.eq(w.settle(), [], "a2's gate lifts, a1 still gated → the whole symbol waits")
    w.eq(json.load(open("state/signal_gate.json")), {"a1": 1.0}, "a2 lifted, a1 kept")
    w.sig("a1", -1)
    w.eq(w.settle(), [(B, "sell", 0.02, False)], "a1 changes too → trades the net −$1,000")


# ── amounts ───────────────────────────────────────────────────────────────────

@scenario("AM-01")
def am01(w):
    w.strategy("a1", B)
    w.bind_paper()
    w.check(not os.path.exists("manager/portfolio_config.json"), "no config before the first save")
    w.amounts(a1=1000)
    cfg = json.load(open("manager/portfolio_config.json"))
    w.eq((cfg.get("self_ledger"), cfg["amounts"], cfg["exchanges"]),
         (True, {"a1": 1000.0}, {"a1": "paper"}), "first save: self_ledger on, routed to paper")
    seed = w.seed()
    w.check(bool(seed and seed.get("seeded_at")) and seed.get("symbols") == {},
            "a zero baseline is written before the config")
    w.check(w.pf.book_ready(), "book ready (self_ledger: true)")
    w.check(os.path.exists("manager/amounts.ui.json"), "UI mirror written")
    w.sig("a1", 1)
    w.start()
    w.eq(w.settle(), [(B, "buy", 0.02, False)], "trades from zero")


@scenario("AM-02")
def am02(w):
    _long(w)
    w.amounts(a1=1500)
    w.eq(w.settle(), [(B, "buy", 0.01, False)], "raise $1,000→$1,500 buys $500")


@scenario("AM-03")
def am03(w):
    _long(w)
    w.amounts(a1=400)
    w.eq(w.settle(), [(B, "sell", 0.012, True)], "lower $1,000→$400 sells $600 reduce-only")
    w.eq(w.book(), {B: (0.008, 400.0)}, "book")


@scenario("AM-04")
def am04(w):
    _long(w)
    w.amounts(a1=0)
    w.eq(w.settle(), [(B, "sell", 0.02, True)], "amount 0 closes the bot's share")
    w.eq(json.load(open("manager/portfolio_config.json"))["exchanges"], {"a1": "paper"},
         "routing kept at amount 0")


@scenario("AM-05")
def am05(w):
    _long(w)
    w.amounts()
    w.eq(w.settle(), [(B, "sell", 0.02, True)], "unpicked (removed from the config): close-on-removal")
    cfg = json.load(open("manager/portfolio_config.json"))
    w.eq((cfg["amounts"], cfg["exchanges"]), ({}, {}), "membership gone")
    w.eq(w.book(), {}, "book flat")


@scenario("AM-06")
def am06(w):
    _long(w)
    r = w.cmd("delete_strategy", name="a1")
    w.check(isinstance(r, Exception) and "portfolio" in str(r), f"delete refused while a member ({r})")
    w.amounts()
    w.settle()
    r = w.cmd("delete_strategy", name="a1")
    w.check(not isinstance(r, Exception) and not os.path.exists("strategies/a1"),
            f"after unpicking: deleted ({r})")
    w.eq((w.book(), w.paper_pos()), ({}, {}), "its position was closed by the unpick")


@scenario("AM-07")
def am07(w):
    """The folder deleted by hand while still funded (not through the page)."""
    _long(w)
    shutil.rmtree("strategies/a1")
    w.eq(w.settle(), [(B, "sell", 0.02, True)], "the leftover in the book closes (Wei: still flattened)")
    w.eq(w.book(), {}, "book flat")


@scenario("AM-08")
def am08(w):
    w.fresh(signals={"a1": 1}, start=False)
    w.cmd("halt", reason="t")
    w.start(wait=True)
    w.eq(json.load(open("state/signal_gate.json")), {"a1": 1.0}, "gate recorded")
    w.amounts(a1=0)
    w.eq(json.load(open("state/signal_gate.json")), {}, "a save at 0 drops the stale gate")
    w.amounts(a1=1000)
    w.eq(w.settle(), [(B, "buy", 0.02, False)], "re-funded: no stale gate, it catches up")


@scenario("AM-09")
def am09(w):
    w.fresh(signals={})
    w.eq(w.settle(), [], "funded but no state.json yet: nothing")
    w.check(B not in w.snap().get("target", {}), "no target row")
    w.check("needs_baseline" not in w.snap(), "not a baseline wait either")


# ── trading control ───────────────────────────────────────────────────────────

E = "ETHUSDT"
PAPER_KEYS = ["PAPER_API_KEY", "PAPER_SECRET_KEY", "PAPER_BOUND_TS"]


@scenario("TC-01")
def tc01(w):
    w.fresh(signals={}, start=False)
    w.cmd("halt", reason="user")
    w.sig("a1", 1)
    json.dump({"a1": 1.0}, open("state/signal_gate.json", "w"))
    r = w.start()
    w.check("resumed" in str(r) and w.sup["starts"] == 1, f"resume: HALT cleared, daemon started ({r})")
    w.check(not w.halted() and not os.path.exists("state/signal_gate.json"),
            "no HALT; a stale wait gate is removed (catch-up means catch-up)")
    w.eq(w.settle(), [(B, "buy", 0.02, False)], "start with catch-up buys the current target")


@scenario("TC-02")
def tc02(w):
    w.fresh(signals={}, start=False)
    w.cmd("halt", reason="user")
    w.sig("a1", 1)
    r = w.start(wait=True)
    w.check("resumed_wait" in str(r), f"resume_wait ({r})")
    w.eq(json.load(open("state/signal_gate.json")), {"a1": 1.0}, "the current signal is recorded")
    w.eq(w.settle(), [], "start-and-wait: no catch-up order")
    w.check(w.snap()["target"][B]["gated"] is True, "snapshot keeps the gated target, flagged")


@scenario("TC-03")
def tc03(w):
    w.fresh(signals={}, start=False)
    w.cmd("halt", reason="user")
    w.sig("a1", 1)
    w.start(wait=True)
    w.settle()
    w.sig("a1", -1)
    w.eq(w.settle(), [(B, "sell", 0.02, False)], "direction change lifts the gate: trades")
    w.eq(json.load(open("state/signal_gate.json")), {}, "lifted for good")
    w.sig("a1", 0)
    w.eq(w.settle(), [(B, "buy", 0.02, True)], "…and keeps trading normally")


@scenario("TC-04")
def tc04(w):
    w.fresh(signals={}, start=False)
    w.cmd("halt", reason="user")
    w.sig("a1", 1)
    w.start(wait=True)
    w.sig("a1", 0.5)
    w.eq(w.settle(), [], "same-direction resize (1→0.5) is not a new signal: still gated")
    w.eq(json.load(open("state/signal_gate.json")), {"a1": 1.0}, "gate kept")


@scenario("TC-05")
def tc05(w):
    _long(w)
    w.cmd("halt", reason="user")
    w.sig("a1", 2)
    w.eq(w.settle(), [], "halted: the add is denied")
    w.start(wait=True)
    w.eq(w.settle(), [], "start-and-wait with a held position: neither the add nor anything else")
    w.sig("a1", 0)
    w.eq(w.settle(), [(B, "sell", 0.02, True)], "exit signal lifts it: closes the bot's share")


@scenario("TC-06")
def tc06(w):
    _long(w)
    w.cmd("halt", reason="user")
    w.sig("a1", 2)
    w.eq(w.settle(), [], "HALT: entry legs denied")
    w.check(len(w.audit("order_denied_halt")) >= 1, "…audited as order_denied_halt")
    w.check((w.report()["halt"].get("blocked") or 0) >= 1, "report halt.blocked counts it")
    w.sig("a1", 0)
    w.eq(w.settle(), [(B, "sell", 0.02, True)], "HALT: the close still goes out")


@scenario("TC-07")
def tc07(w):
    _long(w)
    w.cmd("halt", reason="user")
    w.sig("a1", -1)
    w.eq(w.settle(), [(B, "sell", 0.02, True)], "HALT × flip: close leg fills, opening leg denied")
    last = w.orders_log()[-1]
    w.check(last.get("failed") is True and len(last["legs"]) == 1, "logged failed:true with the close leg")
    w.eq((w.book(), w.paper_pos()), ({}, {}), "flat, not short")


@scenario("TC-08")
def tc08(w):
    _long(w)
    w.manual(B, 0.03)
    w.manual(E, 1.0)
    r = w.cmd("close_all")
    w.eq(r, "close_all=started", "close_all launches flatten")
    w.wait_flatten()
    w.eq(w.paper_pos(), {B: 0.03, E: 1.0}, "only the bot's 0.02 BTC closed; manual BTC and ETH kept")
    w.eq(w.book(), {}, "book zeroed")
    h = w.halt_info() or {}
    w.eq(h.get("source"), "web", "HALT tripped by the command (source web)")
    last = w.orders_log()[-1]
    w.eq((last["symbol"], last["legs"][0].get("executed_qty")), (B, 0.02), "orders.jsonl close row")
    w.eq(w.settle(), [], "the strategy still says long: the entry is denied (halted)")


@scenario("TC-09")
def tc09(w):
    """暫停 first, then 暫停並關閉部位 (the desktop sends close_all)."""
    _long(w)
    w.cmd("halt", reason="desktop ui")
    w.eq(w.settle(), [], "paused: positions untouched")
    w.eq(w.cmd("close_all"), "close_all=started", "close_all while already halted")
    w.wait_flatten()
    w.eq((w.book(), w.paper_pos()), ({}, {}), "closed")
    w.check(w.halted(), "still halted")


@scenario("TC-10")
def tc10(w):
    w.old_machine()
    w.sig("a1", 1)
    w.manual(B, 0.02)
    w.boot()
    w.eq(w.cmd("close_all"), "close_all=started", "close_all before the first round wrote a baseline")
    w.wait_flatten()
    w.eq(w.paper_pos(), {B: 0.02}, "nothing closed: the bot's share can't be told from the user's")
    w.check(any("no ledger baseline" in e.get("error", "") for e in w.order_errors()),
            "order_errors says why")


@scenario("TC-11")
def tc11(w):
    w.fresh(signals={})
    w.cmd("execution", execution={"a1": {"type": "twap", "duration_min": 30}})
    w.twap_slice_s = 0.3
    w.sig("a1", 1)
    w.round(wait=False)
    time.sleep(0.8)
    w.check(bool(w.ex.list_inflight()), "TWAP in flight")
    w.eq(w.cmd("close_all"), "close_all=started", "close_all during the TWAP")
    w.wait_flatten()
    w.wait_async()
    w.eq(w.paper_pos(), {}, "the TWAP stopped on HALT; flatten waited for it and closed its fills")
    w.eq(w.book(), {}, "book flat")
    tw = [x for x in w.orders_log() if str(x.get("execution", "")).startswith("twap")]
    w.check(len(tw) == 1 and tw[0].get("failed") is True, "the partial TWAP is logged failed:true")


@scenario("TC-12")
def tc12(w):
    _long(w)
    seed0 = w.seed()
    r = w.cmd("credentials_remove", env=PAPER_KEYS)
    w.check("credentials_remove" in str(r), f"unbind ({r})")
    h = w.halt_info() or {}
    w.check("unbound" in h.get("reason", ""), f"HALT: {h.get('reason')}")
    w.eq(w.sup["running"], False, "daemon stopped")
    cfg = json.load(open("manager/portfolio_config.json"))
    w.eq((cfg["amounts"], cfg["exchanges"]), ({}, {}), "membership cleared")
    seed = w.seed()
    w.check(seed.get("seeded_at") == seed0.get("seeded_at") and not seed.get("venue_reset"),
            "the book is kept: it is per venue (a rebind decides — TC-13)")
    w.eq(w.book(), {B: (0.02, 1000.0)}, "the bot's 0.02 is still in paper's book")
    w.check((seed.get("venue_account") or {}).get("paper", {}).get("id"),
            "…and the account it was built on stays recorded (the exchange's id, not the key)")
    w.eq(w.paper_pos(B), 0.02, "…and still on the paper ledger file")
    w.eq(json.load(open("manager/credentials.ui.json"))["ids"], [], "manifest empty")
    w.eq(w.round(), "down", "no reconciler runs")


@scenario("TC-13")
def tc13(w):
    _long(w)
    w.cmd("credentials_remove", env=PAPER_KEYS)
    w.bind_paper(ts=int(time.time()) + 5)
    w.eq(w.ap.get_positions(w.env()), [], "rebind = a fresh paper account (ledger re-seeded)")
    w.amounts(a1=1000)
    r = w.start()
    w.check(w.sup["running"] and not w.halted(), f"start after rebind ({r})")
    w.eq(w.settle(), [(B, "buy", 0.02, False)], "trades from an empty book")


@scenario("TC-14")
def tc14(w):
    _long(w)
    w.sup["stop_ok"] = False
    w.cmd("credentials_remove", env=PAPER_KEYS)
    cfg = json.load(open("manager/portfolio_config.json"))
    w.eq(cfg["amounts"], {"a1": 1000.0}, "stop not confirmed: membership kept")
    w.check(w.halted(), "HALT")
    w.eq(w.round(), "idle", "the surviving daemon idles (no venue in the manifest)")
    w.eq(w.paper_pos(B), 0.02, "nothing closed")


@scenario("TC-15")
def tc15(w):
    _long(w)
    r = w.cmd("credentials", env={"OKX_API_KEY": "k", "OKX_SECRET_KEY": "s", "OKX_PASSPHRASE": "p"})
    w.check(isinstance(r, dict), f"bind okx over paper ({r})")
    h = w.halt_info() or {}
    w.check("paper" in h.get("reason", "") and "evicted" in h.get("reason", ""),
            f"eviction halts: {h.get('reason')}")
    w.eq(json.load(open("manager/portfolio_config.json"))["exchanges"], {"a1": ""},
         "routing to the evicted venue cleared")
    w.eq(w.book(venue="paper"), {B: (0.02, 1000.0)}, "paper's book untouched (books are per venue)")
    w.eq(w.book(venue="okx"), {}, "okx's book starts empty")


@scenario("TC-16")
def tc16(w):
    _long(w)
    cl = w.cl
    with open(cl.BOOT_RECORD, "w") as f:
        f.write("boot-1")
    cl._boot_marker = lambda: "boot-2"
    cl._downtime_write_stamp(time.time() - 5)
    info = cl._machine_restart_check()
    w.check(bool(info) and os.path.exists(cl.RESTART_STOP_PATH), "reboot while trading: record written")
    w.eq(w.sup["running"], False, "reconciler stopped")
    w.check(not w.halted(), "no HALT")
    w.eq([e.get("type") for e in w.events()][-1:], ["machine_restart_stopped"], "one event")
    w.sup["running"] = True  # a survivor the kill did not reach
    w.sig("a1", 0)
    w.eq(w.round(), "restart_stopped", "a surviving reconciler runs no round")
    w.eq(w.paper_fills()[1:], [], "no order, closes included")
    # the record landing mid-round: place_order itself sends none of the legs
    w.rec.reconcile(get_positions_fn=w.rec._get_positions_guarded, place_order_fn=w.rec.place_order,
                    threshold=w.rec._symbol_threshold, send_telegram_fn=w.tg.append)
    w.eq((w.paper_fills()[1:], w.audit("order_denied_restart")), ([], []),
         "a round already running when the record lands: place_order holds every leg itself")
    try:
        w.op.place_market_order(w.env(), B, "long", 0.02, reduce_only=True)
        refused = False
    except w.guard.Halted:
        refused = True
    w.check(refused, "the order lib refuses a direct close too")
    r = w.report()
    w.check(r["stopped"] and r["stopped"]["reason"] == "machine_restart" and not r["alive"],
            f"report: stopped={r['stopped']}, alive=False")


def _rebooted(w):
    _long(w)
    cl = w.cl
    open(cl.BOOT_RECORD, "w").write("boot-1")
    cl._boot_marker = lambda: "boot-2"
    cl._downtime_write_stamp(time.time() - 5)
    cl._machine_restart_check()


@scenario("TC-17")
def tc17(w):
    _rebooted(w)
    w.sig("a1", 0)
    r = w.start()
    w.check(not os.path.exists(w.cl.RESTART_STOP_PATH) and w.sup["running"],
            f"啟動下單 lifts the stop and starts the daemon ({r})")
    w.eq(w.settle(), [(B, "sell", 0.02, True)], "catch-up: the exit that came during the stop")


@scenario("TC-18")
def tc18(w):
    _rebooted(w)
    w.sig("a1", 0)
    w.start(wait=True)
    w.eq(w.settle(), [], "start-and-wait after a reboot: the stale exit is not chased")
    w.sig("a1", -1)
    w.eq(w.settle(), [(B, "sell", 0.02, True), (B, "sell", 0.02, False)], "next signal change trades")


@scenario("TC-19")
def tc19(w):
    _rebooted(w)
    r = w.cmd("close_all")
    w.eq(r, "close_all=restart_stopped:started", "close_all during a restart stop")
    w.wait_flatten()
    w.eq((w.book(), w.paper_pos()), ({}, {}), "the flatten's one-time pass closed the bot's share")
    w.check(not w.halted() and os.path.exists(w.cl.RESTART_STOP_PATH),
            "no HALT added; the machine stays stopped")
    w.check(len(w.audit("close_all_pass_claimed")) == 1, "pass claimed once")


@scenario("TC-20")
def tc20(w):
    _rebooted(w)
    r = w.cmd("restart_reconciler")
    w.check(isinstance(r, Exception) and "restarted" in str(r), f"restart_reconciler refused ({r})")
    w.eq(w.sup["starts"], 1, "not started")


@scenario("TC-21")
def tc21(w):
    """The real daemon, killed while its TWAP is between slices, then restarted."""
    w.fresh(signals={}, start=False)
    w.cmd("execution", execution={"a1": {"type": "twap", "duration_min": 2}})
    w.sig("a1", 1)
    logf = open("state/reconciler.log", "w")

    def daemon():
        return subprocess.Popen([sys.executable, "manager/reconciler.py"], cwd=w.ws,
                                env=dict(os.environ), stdout=logf, stderr=logf)
    p = daemon()
    deadline = time.time() + 40
    while not w.paper_fills() and time.time() < deadline:
        time.sleep(0.1)
    time.sleep(0.3)
    inflight = w.ex.list_inflight()
    p.kill()
    p.wait()
    w.eq(w.paper_fills(), [(B, "buy", 0.01, False)], "first TWAP slice filled, then SIGKILL")
    w.check(len(inflight) == 1, "its in-flight marker was on disk")
    w.eq(w.book(), {}, "the slice never reached orders.jsonl (the book is short 0.01)")
    p = daemon()
    deadline = time.time() + 30
    while not w.halted() and time.time() < deadline:
        time.sleep(0.1)
    time.sleep(6)
    p.kill()
    p.wait()
    h = w.halt_info() or {}
    w.eq(h.get("source"), "execute", "restart: reap_dead_inflight trips HALT")
    w.check(not w.ex.list_inflight(), "marker removed after the HALT landed")
    w.check(any(e.get("type") == "execution_interrupted" for e in w.events()), "P1 event")
    w.eq(len(w.paper_fills()), 1, "nothing re-bought while halted")
    # the documented cost: resuming without fixing the book re-buys on top
    w.sup["running"] = True
    w.restart_process()
    w.start()
    w.settle()
    w.eq(w.paper_pos(B), 0.03, "after resume the full target is bought on top (known cost)")


@scenario("TC-22")
def tc22(w):
    """Killed between a market fill and its orders.jsonl line."""
    w.fresh(signals={})
    real = w.pf._append_reconciler_log

    def killed(entry):
        raise SystemExit("reconciler killed")
    w.pf._append_reconciler_log = killed
    w.sig("a1", 1)
    try:
        w.round()
    except SystemExit:
        pass
    w.pf._append_reconciler_log = real
    w.eq(w.paper_pos(B), 0.02, "the market order filled")
    w.eq(w.book(), {}, "…and the book never heard of it")
    w.restart_process()
    w.settle()
    w.check(w.paper_pos(B) == 0.02 or w.halted(),
            f"the restart neither buys it again nor trades on without a HALT "
            f"(paper {w.paper_pos(B)}, halted {w.halted()})")


@scenario("TC-24")
def tc24(w):
    _long(w)
    w.cmd("halt", reason="user")
    r = w.start(human_delay=False)
    w.check("already running" in str(r) and w.sup["starts"] == 1,
            f"resume beside a live daemon: not restarted ({r})")
    r = w.cmd("restart_reconciler")
    w.check("already started" in str(r) and w.sup["starts"] == 1,
            f"the web's follow-up restart is swallowed once ({r})")


@scenario("TC-25")
def tc25(w):
    _long(w)
    w.cmd("halt", reason="user")
    w.sup["running"] = False
    w.age_heartbeat(400)
    r = w.start(human_delay=False)
    w.check(w.sup["starts"] == 2 and w.sup["running"], f"dead daemon (heartbeat 400 s old): started ({r})")


@scenario("TC-26")
def tc26(w):
    _long(w)
    w.cmd("halt", reason="user")
    w.sup["running"] = False
    w.strays = [4242]
    r = w.start()
    w.check(w.cl.STRAY_RESULT in str(r) and w.sup["starts"] == 1,
            f"a reconciler outside the supervisor: not started beside it ({r})")
    r = w.cmd("restart_reconciler")
    w.check("already started" in str(r), f"the web's follow-up after that start is swallowed ({r})")
    r = w.cmd("restart_reconciler")
    w.check(isinstance(r, Exception) and "4242" in str(r), f"a later restart is refused ({r})")


@scenario("TC-28")
def tc28(w):
    """Unbind, rebind and 啟動下單 within the 15 s 'running right now' window."""
    _long(w)
    w.cmd("credentials_remove", env=PAPER_KEYS)
    w.bind_paper(ts=int(time.time()) + 5)
    w.amounts(a1=1000)
    r = w.start(human_delay=False)
    w.check(w.sup["running"], f"the stopped daemon is started again ({r})")


@scenario("TC-36")
def tc36(w):
    """Another account bound OVER the bound one, no unbind first (audit Delta 5 #1)."""
    _long(w)
    r = w.bind_paper(ts=int(time.time()) + 5)  # paper account 2: a fresh ledger
    w.check(isinstance(r, dict), f"overwrite bind ({r})")
    w.manual(B, 0.05)  # the user's own long on account 2
    w.sig("a1", 0)
    w.settle()
    w.settle()
    w.eq(w.paper_pos(B), 0.05, "the user's 0.05 on the new account is never sold")
    w.eq(w.book(), {}, "the paper book was reset when the new account's id was read")
    w.check("paper" in (w.seed().get("venue_reset") or {}), "…recorded as a per-venue reset")
    w.check(not w.halted(), "paper: no account HALT (a paper rebind is the user's own act)")


@scenario("TC-37")
def tc37(w):
    """Unbind → bind another venue → the first venue again with another account (Delta 5 #1)."""
    _long(w)
    w.cmd("credentials_remove", env=PAPER_KEYS)
    okx = {"OKX_API_KEY": "k", "OKX_SECRET_KEY": "s", "OKX_PASSPHRASE": "p"}
    r = w.cmd("credentials", env=okx)
    w.check(isinstance(r, dict), f"bind okx ({r})")
    w.cmd("credentials_remove", env=list(okx))
    w.bind_paper(ts=int(time.time()) + 5)
    w.manual(B, 0.05)
    w.amounts(a1=1000)
    w.sig("a1", 0)
    r = w.start()
    w.check(w.sup["running"], f"start ({r})")
    w.settle()
    w.settle()
    w.eq(w.paper_pos(B), 0.05, "the user's 0.05 on the new paper account is never sold")
    w.eq(w.book(), {}, "the old account's 0.02 is not this account's book")


# ── manual positions ──────────────────────────────────────────────────────────

@scenario("MP-01")
def mp01(w):
    w.fresh(signals={"a1": 0})
    w.manual(E, 1.0)
    w.eq(w.settle(), [], "manual ETH, no strategy on it: nothing")
    s = w.snap()
    w.check(E in s["actual"] and E not in s["target"] and E not in (s.get("ledger") or {}),
            "in actual (the account read), not in target, not in the book")


@scenario("MP-02")
def mp02(w):
    w.fresh(signals={"a1": 1}, amounts={"a1": 0})
    w.manual(B, 0.05)
    w.eq(w.settle(), [], "manual BTC beside a strategy at amount 0: nothing (Wei's BTC case)")
    w.eq(w.paper_pos(B), 0.05, "kept")


@scenario("MP-03")
def mp03(w):
    w.fresh(signals={"a1": 0})
    w.manual(B, 0.05)
    w.sig("a1", 1)
    w.eq(w.settle(), [(B, "buy", 0.02, False)], "funded strategy buys its target on top")
    w.sig("a1", 0)
    w.eq(w.settle(), [(B, "sell", 0.02, True)], "exit sells only the bot's 0.02")
    w.eq(w.paper_pos(B), 0.05, "manual 0.05 intact")


@scenario("MP-04")
def mp04(w):
    w.fresh(signals={"a1": 0})
    w.manual(B, -0.05)
    w.sig("a1", 1)
    w.eq(w.settle(), [(B, "buy", 0.02, False)], "a manual short: the bot buys its long target")
    w.eq(w.paper_pos(B), -0.03, "one-way account: the buy nets into the user's short")
    w.sig("a1", 0)
    w.eq(w.settle(), [], "one read of 'netted' is not believed: nothing sent yet")
    w.settle()
    w.eq(w.paper_pos(B), -0.05, "exit restores the user's short to −0.05")
    w.eq(w.book(), {}, "…and the book is flat")


@scenario("MP-04b")
def mp04b(w):
    """The user closes the bot's long by hand and opens their own short (ZZ-01)."""
    w.fresh(signals={"a1": 0})
    w.sig("a1", 1)
    w.eq(w.settle(), [(B, "buy", 0.02, False)], "the bot buys 0.02 on a flat account (nothing netted)")
    w.manual(B, -0.07)  # sells the bot's 0.02 and opens the user's own −0.05
    w.sig("a1", 0)
    w.settle()
    w.settle()
    w.eq(w.paper_pos(B), -0.05, "no netted amount was recorded: the user's short is never enlarged")


@scenario("MP-04c")
def mp04c(w):
    """Close-all restores a netted share, under HALT (ZZ-02)."""
    w.fresh(signals={"a1": 0})
    w.manual(B, -0.05)
    w.sig("a1", 1)
    w.settle()
    w.eq(w.paper_pos(B), -0.03, "the bot's 0.02 netted into the user's short")
    r = w.cmd("close_all")
    w.check("started" in str(r), f"close_all ({r})")
    w.wait_flatten()
    w.eq(w.paper_pos(B), -0.05, "close-all gives the user their −0.05 back (the one pass HALT allows)")
    w.eq(w.book(), {}, "…and the book is flat")
    w.check(w.halted(), "HALT stays")


@scenario("MP-04d")
def mp04d(w):
    """MP-04 through the chase (limit) execution style (audit Delta 5 #5)."""
    w.fresh(signals={"a1": 0})
    w.cmd("execution", execution={"a1": {"type": "chase"}})
    w.manual(B, -0.05)
    w.sig("a1", 1)
    w.settle()
    w.eq(w.paper_pos(B), -0.03, "the bot's chase buy of 0.02 nets the user's short to −0.03")
    w.sig("a1", 0)
    w.settle()
    w.settle()
    w.eq(w.paper_pos(B), -0.05, "the netted share was recorded: the exit gives the user their −0.05 back")
    w.eq(w.book(), {}, "…and the book is flat")


@scenario("MP-05")
def mp05(w):
    _long(w)
    w.manual(B, 0.03)
    w.sig("a1", 0.5)
    w.eq(w.settle(), [(B, "sell", 0.01, True)], "partly bot / partly manual: shrink sells the bot's")
    w.sig("a1", 0)
    w.eq(w.settle(), [(B, "sell", 0.01, True)], "close sells the rest of the bot's")
    w.eq(w.paper_pos(B), 0.03, "manual 0.03 intact")


@scenario("MP-06")
def mp06(w):
    _long(w)
    w.manual(B, -0.02)  # the user closes the bot's position by hand
    w.sig("a1", 0)
    w.round()
    w.eq(w.book(), {B: (0.02, 1000.0)}, "one short read is not believed")
    w.round()
    w.eq(w.book(), {}, "the second read confirms: book written off")
    w.eq(w.paper_fills()[1:], [], "no order was placed for it")
    w.check(any(a.get("reason") == "account holds none of it" for a in w.audit("ledger_writeoff")),
            "audit ledger_writeoff")


@scenario("MP-07")
def mp07(w):
    w.pf._ACCOUNT_SHORT_MIN_S = 5
    _long(w)
    w.manual(B, -0.02)
    w.sig("a1", 0)
    w.round()
    w.round()
    w.eq(w.book(), {B: (0.02, 1000.0)}, "two reads back to back (<5 s): still not believed")
    time.sleep(5.2)
    w.round()
    w.eq(w.book(), {}, "a read ≥5 s later confirms")


@scenario("MP-08")
def mp08(w):
    _long(w)
    w.manual(B, -0.02)  # account now empty; the bot's book still says 0.02
    w.restart_process()  # a fresh daemon: the account guard is due
    out = w.round()
    w.check(out.startswith("skipped") and "account guard" in out, f"empty read at a guard point: {out}")
    h = w.halt_info() or {}
    w.eq(h.get("source"), "reconciler", "HALT by the account guard")
    w.eq((w.report()["account_guard"] or {}).get("pending"), True, "report: account_guard.pending")
    w.start()
    w.eq(w.round(), "ok", "the user's start confirms the account")
    w.eq(w.paper_fills()[1:], [], "nothing is re-bought (the book still says held)")


@scenario("MP-09")
def mp09(w):
    w.fresh(strategies=(("s1", B, "spot"),), amounts={"s1": 500}, signals={"s1": 0})
    w.manual(B + "@spot", 0.1)
    w.sig("s1", 1)
    w.eq(w.settle(), [(B + "@spot", "buy", 0.01, False)], "spot strategy buys $500 beside 0.1 manual coins")
    w.sig("s1", 0)
    w.eq(w.settle(), [(B + "@spot", "sell", 0.01, False)], "exit sells min(book, wallet) = 0.01")
    w.eq(w.paper_pos(B + "@spot"), 0.1, "the user's 0.1 coins kept")


@scenario("MP-10")
def mp10(w):
    w.fresh(strategies=(("s1", B, "spot"),), amounts={"s1": 500}, signals={"s1": 1})
    w.settle()
    w.manual("ETHUSDT@spot", 1.0)
    w.eq(w.settle(), [], "manual ETH coins, no strategy on ETH")
    w.check("ETHUSDT@spot" not in w.snap()["actual"], "never enters the spot scope")
    w.cmd("close_all")
    w.wait_flatten()
    w.eq(w.paper_pos(), {"ETHUSDT@spot": 1.0}, "close_all sold the bot's BTC coins only")


# ── migration (a machine from before the own-positions rule) ──────────────────

def _migrate(w, rounds=2):
    """confirming round(s), then the baseline round."""
    outs = [w.round() for _ in range(rounds)]
    return outs


@scenario("MG-01")
def mg01(w):
    w.old_machine()
    w.sig("a1", 1)
    w.manual(B, 0.024)
    w.boot()
    w.round()
    s = w.snap()
    w.eq(s.get("needs_baseline"), {"reason": "confirming", "symbols": []}, "round 1: read-only, confirming")
    w.eq(w.report()["last"].get("needs_baseline", {}).get("reason"), "confirming",
         "report.last_reconcile.needs_baseline carries it")
    w.round()
    w.eq(w.paper_fills(), [], "migration never trades by itself")
    w.eq(w.book(), {B: (0.024, 1000.0)}, "≤1.5× the target: the whole 0.024 is the bot's, cost = target")
    seed = w.seed()
    w.check(seed.get("own_only_basis") == 1 and "paper|" + B in seed["symbols"], "baseline marked, per venue")
    w.check(bool(w.audit("ledger_baseline")), "audit ledger_baseline")
    w.check("needs_baseline" not in w.snap(), "needs_baseline gone")
    w.sig("a1", 0)
    w.eq(w.settle(), [(B, "sell", 0.024, True)], "exit closes the whole adopted position")


@scenario("MG-02")
def mg02(w):
    w.old_machine()
    w.lots[B] = 0.001
    w.sig("a1", 1)
    w.manual(B, 0.05)
    w.boot()
    _migrate(w)
    w.eq(w.paper_fills(), [], "no order")
    w.eq(w.book(), {B: (0.02, 1000.0)}, ">1.5×: the target's share (0.02), floored to the lot")
    w.sig("a1", 0)
    w.eq(w.settle(), [(B, "sell", 0.02, True)], "exit sells only the adopted 0.02")
    w.eq(w.paper_pos(B), 0.03, "the user's 0.03 stays")


@scenario("MG-03")
def mg03(w):
    w.old_machine(amounts={"a1": 120})
    w.lots[B] = 0.001
    w.sig("a1", 1)
    w.manual(B, 0.005)
    w.boot()
    _migrate(w)
    w.eq(w.book(), {B: (0.002, 100.0)}, "spec example: 0.005 ($250) vs $120 → 0.0024 → floor 0.002")
    w.eq(w.settle(), [], "the $20 left is under one lot's entry gate: nothing bought")
    g = w.snap()["gates"][B]
    w.eq(round(g["entry_usd"], 2), 52.5, "snapshot gates explain it (entry gate 1.05 lots)")


@scenario("MG-04")
def mg04(w):
    w.old_machine()
    w.sig("a1", 1)
    w.manual(B, 0.01)
    w.boot()
    w.round()
    w.round()
    w.eq(w.paper_fills(), [(B, "buy", 0.01, False)], "smaller than the target: adopt all, buy the rest")
    w.eq(w.book(), {B: (0.02, 1000.0)}, "book = adopted 0.01 + bought 0.01")


@scenario("MG-05")
def mg05(w):
    w.old_machine()
    w.sig("a1", 1)
    w.manual(B, -0.03)
    w.boot()
    w.round()
    w.round()
    w.eq(w.paper_fills(), [(B, "buy", 0.02, False)], "opposite side: adopt nothing, buy the target")
    w.eq(w.book(), {B: (0.02, 1000.0)}, "book = what the bot bought")
    w.eq(w.paper_pos(B), -0.01, "one-way netting on the account")


@scenario("MG-06")
def mg06(w):
    w.old_machine()
    w.sig("a1", 1)
    w.manual(B, 0.02)
    w.manual(E, 1.0)
    w.boot()
    _migrate(w)
    w.eq(w.book(), {B: (0.02, 1000.0)}, "only the strategy's symbol is adopted")
    w.check(not any(k.endswith(E) for k in w.seed()["symbols"]), "manual ETH is the user's")
    w.sig("a1", 0)
    w.settle()
    w.eq(w.paper_pos(), {E: 1.0}, "exit leaves the ETH")


@scenario("MG-07")
def mg07(w):
    w.old_machine()
    w.sig("a1", 0)
    w.manual(B, 0.02)
    w.boot()
    _migrate(w)
    w.eq(w.book(), {}, "flat signal at migration: the bot owns none of it")
    w.sig("a1", 1)
    w.eq(w.settle(), [(B, "buy", 0.02, False)], "next entry buys on top (known cost)")
    w.eq(w.paper_pos(B), 0.04, "")


@scenario("MG-08")
def mg08(w):
    """Never configured, but it traded on a real venue before (orders.jsonl)."""
    w.strategy("a1", B)
    w.bind_paper()
    w.sig("a1", 1)
    w.manual(B, 0.02)
    with open("manager/orders.jsonl", "w") as f:
        f.write(json.dumps({"ts": "2026-09-01T00:00:00", "symbol": B, "exchange": "binance",
                            "legs": [{"signed_diff": 1000, "executed_qty": 0.02}]}) + "\n")
    w.boot()
    w.round()
    s = w.snap()
    w.eq((s.get("needs_baseline") or {}).get("reason"), "unconfigured", "no config: waits (unconfigured)")
    w.check(s.get("read_only") is True, "read-only snapshot")
    w.eq(w.report()["portfolio_configured"], False, "report: portfolio_configured false")
    w.amounts(a1=1000)
    w.check("self_ledger" not in json.load(open("manager/portfolio_config.json")),
            "first save on a machine that traded: no fresh baseline, the lib migrates")
    w.round()
    w.round()
    w.eq((w.paper_fills(), w.book()), ([], {B: (0.02, 1000.0)}), "adopted, nothing re-bought")


@scenario("MG-09")
def mg09(w):
    """Never configured, only paper fills in its history."""
    w.strategy("a1", B)
    w.bind_paper()
    w.sig("a1", 1)
    w.manual(B, 0.02)
    with open("manager/orders.jsonl", "w") as f:
        f.write(json.dumps({"ts": "2026-09-01T00:00:00", "symbol": B, "exchange": "paper",
                            "legs": [{"signed_diff": 1000, "executed_qty": 0.02}]}) + "\n")
    w.boot()
    w.amounts(a1=1000)
    w.check(json.load(open("manager/portfolio_config.json")).get("self_ledger") is not True,
            "paper is the venue bound: its paper fills count as traded — no fresh zero baseline")
    w.settle()
    w.eq(w.paper_pos(B), 0.02, "the logged paper position is the bot's: not bought again on top")


@scenario("MG-10")
def mg10(w):
    w.old_machine(strategies=(("a1", B), ("a2", E)))
    w.sig("a2", 1)
    open("strategies/a1/state.json", "w").write("{")  # half-written
    w.manual(B, 0.02)
    w.manual(E, 0.5)
    w.boot()
    _migrate(w)
    w.eq(w.seed().get("pending"), {"paper|" + B: {"strategy": "a1", "since": w.seed()["seeded_at"]}},
         "only a1's symbol waits (known from stats.json)")
    w.eq(w.book(), {E: (0.5, 1000.0)}, "ETH decided and adopted")
    w.round()
    w.eq(w.snap().get("baseline_pending"), [B], "snapshot: baseline_pending")
    w.eq(w.paper_fills(), [], "no order on either")
    w.sig("a1", 1)
    w.round()
    w.round()
    w.eq(w.book(), {B: (0.02, 1000.0), E: (0.5, 1000.0)}, "a1 readable again: its position adopted, not re-bought")
    w.eq(w.paper_fills(), [], "still no order")
    w.check(not w.seed().get("pending"), "pending cleared")


@scenario("MG-10b")
def mg10b(w):
    """A readable strategy shares the symbol the baseline leaves waiting."""
    w.old_machine(strategies=(("a1", B), ("a3", B)), amounts={"a1": 1000, "a3": 600})
    w.sig("a3", 1)
    open("strategies/a1/state.json", "w").write("{")
    w.manual(B, 0.02)
    w.boot()
    _migrate(w)
    w.check(bool(w.seed().get("pending")), "BTC waits on a1")
    w.eq(w.paper_fills(), [], "a waiting symbol is neither bought nor sold — the baseline round included")


@scenario("MG-11")
def mg11(w):
    w.old_machine(strategies=(("a1", B), ("a2", E)))
    open("strategies/a1/strategy.py", "w").write('STRATEGY_NAME = "a1"\nINTERVAL = "1h"\n')
    json.dump({}, open("strategies/a1/stats.json", "w"))
    open("strategies/a1/state.json", "w").write("{")
    w.sig("a2", 1)
    w.manual(B, 0.02)
    w.manual(E, 0.5)
    w.boot()
    outs = [w.round() for _ in range(4)]
    s = w.snap()
    w.eq(s.get("needs_baseline"), {"reason": "state_unreadable", "symbols": ["a1"]},
         "symbol unknown: the whole machine waits")
    w.eq(w.book(), {}, "3 rounds but < 10 min: still waiting")
    w.shift_time(601)
    w.round()
    w.eq(w.book(), {E: (0.5, 1000.0)}, "after 3 rounds AND 10 min: decide what is readable")
    fb = [a for a in w.audit("ledger_baseline") if a.get("fallback")]
    w.check(fb and fb[-1].get("symbol_unknown") == ["a1"], "audit: fallback, a1 unknown")
    w.check(any("could not read" in e.get("error", "") for e in w.order_errors()), "order_errors says so")
    w.eq(w.paper_pos(B), 0.02, "the unknown strategy's BTC is left to the user")


@scenario("MG-12")
def mg12(w):
    w.old_machine()
    w.sig("a1", 1)
    w.manual(B, 0.02)
    w.boot()
    os.makedirs("state/execution/inflight", exist_ok=True)
    json.dump({"key": B, "style": "twap:30m", "signed_diff": 500.0,
               "started_ts": "2026-09-23T00:00:00+00:00"},
              open("state/execution/inflight/BTCUSDT.json", "w"))
    w.round(wait=False)
    w.eq((w.snap().get("needs_baseline") or {}).get("reason"), "inflight", "an execution in flight: wait")
    os.remove("state/execution/inflight/BTCUSDT.json")
    _migrate(w)
    w.eq(w.book(), {B: (0.02, 1000.0)}, "then adopt")


@scenario("MG-13")
def mg13(w):
    now = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
    w.old_machine(seed={"seeded_at": now, "own_only_basis": 1,
                        "symbols": {B: {"size": 1000.0, "qty": 0.02, "ts": now}}})
    w.sig("a1", 1)
    w.manual(B, 0.02)
    w.boot()
    w.round()
    w.check("paper|" + B in w.seed()["symbols"] and B not in w.seed()["symbols"],
            "a venue-less row is claimed for the one bound venue")
    w.eq((w.book(), w.paper_fills()), ({B: (0.02, 1000.0)}, []), "book intact, nothing traded")


def _two_venues(w, fills):
    now = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
    w.old_machine(seed={"seeded_at": now, "own_only_basis": 1,
                        "symbols": {B: {"size": 1000.0, "qty": 0.02, "ts": now}}})
    env = open(".env").read() + "OKX_API_KEY=k\nOKX_SECRET_KEY=s\nOKX_PASSPHRASE=p\n"
    open(".env", "w").write(env)
    json.dump({"ids": ["okx", "paper"]}, open("manager/credentials.ui.json", "w"))
    with open("manager/orders.jsonl", "w") as f:
        for v in fills:
            f.write(json.dumps({"ts": "2026-09-01T00:00:00", "symbol": B, "exchange": v,
                                "legs": [{"signed_diff": 500, "executed_qty": 0.01}]}) + "\n")
    w.sig("a1", 1)
    w.manual(B, 0.02)
    w.boot()


@scenario("MG-14")
def mg14(w):
    _two_venues(w, ["paper", "paper"])
    w.round()
    w.check("paper|" + B in w.seed()["symbols"], "two venues bound, every fill names paper: claimed by paper")
    w.eq(w.paper_fills(), [], "nothing traded")


@scenario("MG-15")
def mg15(w):
    _two_venues(w, ["paper", "okx"])
    w.settle()
    w.check("?|" + B in w.seed()["symbols"], "fills on two venues: parked as '?'")
    w.check(any("doesn't say which exchange" in e.get("error", "") for e in w.order_errors()),
            "said once in order_errors")
    w.eq(w.paper_pos(B), 0.04, "no venue's book reads it: the target is bought on paper on top")


@scenario("MG-16")
def mg16(w):
    w.old_machine(seed={"seeded_at": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()), "symbols": {}})
    w.sig("a1", 1)
    w.manual(B, 0.02)
    w.boot()
    w.round()
    w.eq((w.snap().get("needs_baseline") or {}).get("reason"), "confirming",
         "a bare seeded_at (no own_only_basis) is not a baseline: migrate")
    w.round()
    w.eq((w.book(), w.paper_fills()), ({B: (0.02, 1000.0)}, []), "adopted, not re-bought")


@scenario("MG-17")
def mg17(w):
    w.old_machine(cfg_extra={"self_ledger": False})
    w.sig("a1", 1)
    w.manual(E, 1.0)
    w.manual(B, 0.02)
    w.boot()
    got = w.settle()
    w.eq(got, [(E, "sell", 1.0, True)], "explicit opt-out: the account is the bot's — manual ETH is closed")
    w.eq(w.report()["self_ledger"], False, "report: self_ledger false (the pages warn)")


@scenario("MG-18")
def mg18(w):
    w.old_machine(strategies=(("s1", B, "spot"),), amounts={"s1": 500})
    w.sig("s1", 1)
    w.manual(B + "@spot", 0.02)
    w.boot()
    _migrate(w)
    w.eq(w.book(), {B + "@spot": (0.01, 500.0)}, "spot: wallet 2× the target → the target's share of coins")
    w.sig("s1", 0)
    w.eq(w.settle(), [(B + "@spot", "sell", 0.01, False)], "exit sells 0.01")
    w.eq(w.paper_pos(B + "@spot"), 0.01, "the user's coins stay")


@scenario("MG-19")
def mg19(w):
    now = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
    w.old_machine(strategies=(("s1", B, "spot"),), amounts={"s1": 500},
                  seed={"seeded_at": now, "own_only_basis": 1,
                        "symbols": {"paper|" + B + "@spot": {"size": 500.0, "ts": now,
                                                             "venue": "paper"}}})
    w.sig("s1", 1)
    w.manual(B + "@spot", 0.01)
    w.boot()
    got = w.settle()
    w.eq(got, [(B + "@spot", "buy", 0.01, False)], "a spot row without qty is written off, the strategy buys from zero")
    errs = [e for e in w.order_errors() if "no recorded" in e.get("error", "")]
    w.eq(len(errs), 1, "said once")
    w.settle()
    w.eq(len([e for e in w.order_errors() if "no recorded" in e.get("error", "")]), 1, "not every round")


@scenario("MG-20")
def mg20(w):
    w.old_machine()
    w.sig("a1", 1)
    w.boot()
    w.round()
    w.manual(B, 0.02)
    w.round()
    w.eq((w.snap().get("needs_baseline") or {}).get("reason"), "confirming",
         "the account read changed between rounds: confirm again")
    w.round()
    w.eq((w.book(), w.paper_fills()), ({B: (0.02, 1000.0)}, []), "third round adopts")


@scenario("MG-21")
def mg21(w):
    w.old_machine()
    w.sig("a1", 1)
    w.manual(B, 0.03)
    w.boot()
    _migrate(w)
    w.eq(w.book(), {B: (0.03, 1000.0)}, "exactly 1.5×: whole")


@scenario("MG-22")
def mg22(w):
    w.old_machine()
    w.sig("a1", -1)
    w.manual(B, -0.03)
    w.boot()
    _migrate(w)
    w.eq(w.book(), {B: (-0.03, -1000.0)}, "short, same side: whole, signed")
    w.sig("a1", 0)
    w.eq(w.settle(), [(B, "buy", 0.03, True)], "exit buys back 0.03")


@scenario("MG-23")
def mg23(w):
    w.old_machine(strategies=(("a1", B), ("a2", B)), amounts={"a1": 1000, "a2": 600})
    w.lots[B] = 0.001
    w.sig("a1", 1)
    w.sig("a2", 1)
    w.manual(B, 0.05)
    w.boot()
    _migrate(w)
    w.eq(w.book(), {B: (0.032, 1600.0)}, "two strategies: 0.05 ($2,500) vs net $1,600 (1.56×) → 0.032")


@scenario("MG-24")
def mg24(w):
    w.old_machine()
    w.sig("a1", 1)
    w.manual(B, 0.02)
    w.boot()
    _migrate(w)
    p = subprocess.run([sys.executable, "manager/seed_ledger.py"], cwd=w.ws, env=dict(os.environ),
                       capture_output=True, text=True, timeout=60)
    w.check(p.returncode == 0, f"seed_ledger.py (fresh start) ran: {p.stdout[-200:]}{p.stderr[-300:]}")
    w.eq(w.book(), {}, "the user's reseed: everything on the account is theirs")
    w.eq(w.settle(), [(B, "buy", 0.02, False)], "the strategy buys its target again (the documented cost)")


# ── edge cases ────────────────────────────────────────────────────────────────

@scenario("ED-01")
def ed01(w):
    w.lots[B] = 0.001
    w.fresh(amounts={"a1": 30}, signals={"a1": 1})
    w.eq(w.settle(), [], "$30 < one 0.001 lot ($50 × 1.05 entry gate): nothing")
    g = w.snap()["gates"][B]
    w.eq((round(g["entry_usd"], 2), g["diff"]), (52.5, 30.0), "snapshot gates: the number and the diff")


@scenario("ED-02")
def ed02(w):
    w.lots[B] = 0.001
    w.fresh(amounts={"a1": 55}, signals={"a1": 1})
    w.eq(w.settle(), [(B, "buy", 0.001, False)], "$55 > the gate: rounds to exactly one lot")
    w.sig("a1", 0)
    w.eq(w.settle(), [(B, "sell", 0.001, True)], "a one-lot position closes (whole close = flat $10 gate)")
    w.eq(w.book(), {}, "flat")


@scenario("ED-03")
def ed03(w):
    w.lots[B] = 0.0005
    w.fresh(amounts={"a1": 75}, signals={"a1": 1})
    w.eq(w.settle(), [(B, "buy", 0.0015, False)], "three 0.0005 lots")
    w.lots[B] = 0.001  # the venue coarsens its step
    w.sig("a1", 0)
    w.eq(w.settle(), [(B, "sell", 0.001, True)], "close sells what one new lot allows")
    w.eq(w.book(), {}, "the remainder under one lot is written off")
    w.check(any(a.get("reason") == "remainder below one lot" for a in w.audit("ledger_writeoff")),
            "audit ledger_writeoff 'remainder below one lot'")
    w.eq(w.paper_pos(B), 0.0005, "…and left on the account")


@scenario("ED-04")
def ed04(w):
    w.fresh(amounts={"a1": 2_000_000}, signals={"a1": 1})
    w.eq(w.settle(), [], "10× paper equity cap: the entry is refused")
    e = w.order_errors()
    w.check(e and "exceeds 10× paper equity" in e[-1]["error"], f"order_errors: {e[-1:]}")
    w.check(any("Order failed" in m for m in w.tg), "a notice")
    w.eq((w.book(), w.orders_log()), ({}, []), "nothing booked")
    w.round()
    w.eq(len([x for x in w.order_errors() if "exceeds" in x["error"]]), 2,
         "retried next round (not stuck silently)")


@scenario("ED-05")
def ed05(w):
    _long(w)
    w.manual(B, 19.975)  # the user's own position fills the leverage cap
    w.amounts(a1=2000)
    w.eq(w.settle(), [], "the add is refused (gross notional over 10×)")
    w.sig("a1", 0)
    w.eq(w.settle(), [(B, "sell", 0.02, True)], "a reduce is never refused by the cap")


@scenario("ED-06")
def ed06(w):
    w.fresh(strategies=(("s1", B, "spot"),), amounts={"s1": 500}, signals={"s1": 1})
    w.eq(w.settle(), [(B + "@spot", "buy", 0.01, False)], "spot buy is sized in quote ($500)")
    w.sig("s1", -1)
    got = w.settle()
    w.eq(got, [(B + "@spot", "sell", 0.01, False)], "a short spot signal is clamped to flat: sells the book only")
    w.eq(w.snap()["target"][B + "@spot"]["size"], 0.0, "target clamped to 0")


@scenario("ED-07")
def ed07(w):
    w.fresh(strategies=(("a1", B), ("s1", E, "spot")), amounts={"a1": 1000, "s1": 500},
            signals={"a1": 1, "s1": 1})
    w.settle()
    led = w.ledger()
    w.eq(round(led["cash"], 4), round(100000 - 1000 * 0.0005 - 500 - 500 * 0.001, 4),
         "fees from cash: swap taker 0.05%, spot 0.1% (plus the spot purchase)")
    w.eq(w.book(), {B: (0.02, 1000.0), E + "@spot": (0.25, 500.0)}, "fees never change the book's qty")
    w.marks(BTCUSDT=55000.0)
    w.sig("a1", 0)
    w.settle()
    realized = w.ledger()["fills"][-1]["realized"]
    w.eq(round(realized, 2), 100.0, "close realizes qty × Δprice")


@scenario("ED-08")
def ed08(w):
    w.fresh(signals={})
    w.cmd("execution", execution={"a1": {"type": "twap", "duration_min": 30}})
    w.twap_slice_s = 0.2
    w.sig("a1", 1)
    w.round(wait=False)
    time.sleep(0.25)
    w.check(bool(w.ex.list_inflight()), "TWAP in flight (marker on disk)")
    w.round(wait=False)
    w.check(len(w.ex.list_inflight()) == 1, "a second round defers the leg (one execution per symbol)")
    w.wait_async()
    tw = [x for x in w.orders_log() if str(x.get("execution", "")).startswith("twap")]
    w.check(len(tw) == 1 and abs(tw[0]["legs"][0]["executed_qty"] - 0.02) < 1e-6,
            f"one orders.jsonl entry, 0.02 filled (each slice rounds to paper's 1e-8 step)")
    w.eq(w.book(6), {B: (0.02, 1000.0)}, "book")
    w.eq(w.settle(), [], "converged")


@scenario("ED-09")
def ed09(w):
    w.fresh(signals={})
    w.cmd("execution", execution={"a1": {"type": "twap", "duration_min": 30}})
    w.twap_slice_s = 0.3
    w.sig("a1", 1)
    w.round(wait=False)
    time.sleep(0.5)
    w.sig("a1", -1)
    w.round(wait=False)
    w.wait_async()
    w.twap_slice_s = 0.01
    w.settle()
    w.eq(w.book(6), {B: (-0.02, -1000.0)}, "a flip mid-TWAP stops it; the residual re-diffs to the new target")
    w.eq(round(w.paper_pos(B), 6), -0.02, "account agrees")


@scenario("ED-10")
def ed10(w):
    w.fresh(signals={})
    w.cmd("execution", execution={"a1": {"type": "chase"}})
    w.sig("a1", 1)
    w.round()
    ch = [x for x in w.orders_log() if x.get("execution") == "chase"]
    w.check(len(ch) == 1, "chase logged once")
    w.eq(w.book(), {B: (0.02, 1000.0)}, "paper has no spread: post-only never rests, the window ends at market")


@scenario("ED-11")
def ed11(w):
    w.fresh(signals={})
    w.drop_mark(B)
    w.sig("a1", 1)
    w.eq(w.settle(), [], "no price: the entry is not opened at a made-up price")
    e = w.order_errors()
    w.check(e and B == e[-1]["symbol"], f"order_errors: {e[-1:]}")


@scenario("ED-12")
def ed12(w):
    _long(w)
    w.drop_mark(B)
    w.sig("a1", 0)
    w.eq(w.settle(), [(B, "sell", 0.02, True)], "a close never waits on a price (paper: entry-price fallback)")


@scenario("ED-12b")
def ed12b(w):
    _long(w)
    w.drop_mark(B)
    w.cmd("close_all")
    w.wait_flatten()
    w.eq((w.paper_pos(), w.book()), ({}, {}), "close_all closes it at the entry-price fallback")


@scenario("ED-17")
def ed17(w):
    w.strategy("f1", "TMF")
    w.bind_paper()
    w.amounts(f1=2)
    spec = json.load(open("manager/portfolio_config.json"))["asset_specs"]["f1"]
    w.eq((spec["type"], spec["contract_value"]), ("futures_contracts", 10), "TMF spec written on first funding")
    w.sig("f1", 1)
    w.start()
    w.eq(w.settle(), [("TMF", "buy", 2.0, False)], "futures_contracts: 2 lots, not $2")
    w.eq(w.book(), {"TMF": (2.0, 2.0)}, "book in lots")
    w.amounts(f1=0)
    w.eq(w.settle(), [("TMF", "sell", 2.0, True)], "amount 0 closes 2 lots")


@scenario("ED-18")
def ed18(w):
    _long(w)
    good = open("state/paper_ledger.json").read()
    open("state/paper_ledger.json", "w").write("{")
    outs = [w.round() for _ in range(3)]
    w.check(all(o.startswith("error") for o in outs), f"unreadable account: each round fails ({outs[0][:60]})")
    h = w.halt_info() or {}
    w.eq(h.get("source"), "reconciler", "3 unclassified read failures → auto-HALT")
    open("state/paper_ledger.json", "w").write(good)
    w.start()
    w.sig("a1", 0)
    w.eq(w.settle(), [(B, "sell", 0.02, True)], "fixed + 啟動下單: trades again")


@scenario("ED-19")
def ed19(w):
    w.fresh(signals={})
    open("manager/orders.jsonl", "w").close()
    os.chmod("manager/orders.jsonl", 0o444)  # the append fails, reads work (a full disk, measured)
    w.sig("a1", 1)
    w.round()
    w.eq(w.paper_fills(), [(B, "buy", 0.02, False)], "the fill happened")
    h = w.halt_info() or {}
    w.eq(h.get("source"), "portfolio", "the book missed it: HALT")
    w.check(any("寫入失敗" in m for m in w.tg), "and the user is told")
    w.round()
    w.eq(len(w.paper_fills()), 1, "not bought again")


@scenario("ED-20")
def ed20(w):
    _long(w)
    w.sig("a1", 1.005)
    w.eq(w.settle(), [], "a $5 gap is under the $10 gate")


@scenario("ED-21")
def ed21(w):
    w.fresh(strategies=(("a1", B), ("a2", E)), signals={})
    w.drop_mark(E)
    w.sig("a1", 1)
    w.sig("a2", 1)
    w.eq(w.settle(), [(B, "buy", 0.02, False)], "one symbol failing does not stop the others")
    w.check(any(x["symbol"] == E for x in w.order_errors()), "ETH's failure recorded")


# ── Type C (portfolio weights; lib/runner.typec_live_state) ───────────────────

SOL = "SOLUSDT"
T1, T2 = 1790000000, 1790604800


def _basket(w, weights, amount=1000, market="swap", start=True, rebalance=T1):
    w.strategy("basket", B, market, portfolio=True)
    w.bind_paper()
    r = w.amounts(basket=amount)
    w.check(not isinstance(r, Exception), f"a portfolio can be funded ({r})")
    w.weights("basket", weights, rebalance)
    if start:
        w.start()


@scenario("C-01")
def c01(w):
    _basket(w, {B: 0.4, E: 0.3, SOL: 0.3})
    w.eq(sorted(w.settle()), sorted([(B, "buy", 0.008, False), (E, "buy", 0.15, False),
                                     (SOL, "buy", 3.0, False)]), "three assets, amount × weight each")
    st = w.report()["states"].get("basket") or {}
    w.eq((st.get("type"), st.get("weights")), ("portfolio", {B: 0.4, E: 0.3, SOL: 0.3}),
         "report forwards the weights")
    w.manual(SOL, 5.0)
    w.marks(BTCUSDT=60000.0)
    w.weights("basket", {B: 0.4, E: 0.3, SOL: 0.3}, T1)  # the next tick, same rebalance
    w.eq(w.settle(), [], "between rebalances: no trade, even with the mark moving")
    w.marks(BTCUSDT=50000.0)
    w.weights("basket", {B: 0.5, E: 0.5}, T2)
    w.eq(sorted(w.settle()), sorted([(B, "buy", 0.002, False), (E, "buy", 0.1, False),
                                     (SOL, "sell", 3.0, True)]),
         "rebalance: SOL dropped out → only the bot's 3 SOL sold")
    w.eq(w.paper_pos(SOL), 5.0, "the manual 5 SOL stays")
    w.eq(w.book(), {B: (0.01, 500.0), E: (0.25, 500.0)}, "book per asset")


@scenario("C-02")
def c02(w):
    w.strategy("a1", B)
    _basket(w, {B: 0.5}, start=False)
    w.amounts(basket=1000, a1=1000)
    w.sig("a1", -1)
    w.start()
    w.eq(w.settle(), [(B, "sell", 0.01, False)], "Type C +$500 and Type A −$1,000 net to −$500")


@scenario("C-03")
def c03(w):
    _basket(w, {B: -0.5, E: 0.5}, market="spot")
    w.eq(w.settle(), [(E + "@spot", "buy", 0.25, False)], "spot: a negative weight is 0, ETH buys $500")
    w.eq(w.snap()["target"][B + "@spot"]["size"], 0.0, "BTC spot target 0")


@scenario("C-04")
def c04(w):
    _basket(w, {}, start=False)
    w.ex.save_state("basket", {"position": 0, "updated_at": int(time.time())})
    w.start()
    w.eq(w.settle(), [], "an old Type C state (no weights, no symbol): no live target yet")
    w.eq(w.snap()["target"], {}, "no target row — not flat, not an error")


@scenario("C-05")
def c05(w):
    w.old_machine(amounts={"a1": 1000, "basket": 1000})
    w.strategy("basket", B, portfolio=True)
    w.ex.save_state("basket", {"position": 0, "updated_at": int(time.time())})
    w.sig("a1", 1)
    w.manual(B, 0.02)
    w.boot()
    _migrate(w)
    w.eq((w.book(), w.paper_fills()), ({B: (0.02, 1000.0)}, []),
         "migration is not held by a Type C state without a symbol")


@scenario("C-06")
def c06(w):
    _basket(w, {B: 0.4, E: 0.3, SOL: 0.3}, start=False)
    w.cmd("halt", reason="user")
    w.start(wait=True)
    w.eq(json.load(open("state/signal_gate.json")), {"basket": float(T1)}, "the gate records the rebalance bar")
    w.eq(w.settle(), [], "every asset waits")
    w.weights("basket", {B: 0.4, E: 0.3, SOL: 0.3}, T1)
    w.eq(w.settle(), [], "same rebalance: still waiting")
    w.weights("basket", {B: 0.5, E: 0.5}, T2)
    w.eq(sorted(w.settle()), sorted([(B, "buy", 0.01, False), (E, "buy", 0.25, False)]),
         "the next rebalance lifts it")


@scenario("C-07")
def c07(w):
    w.old_machine(strategies=(), amounts={"basket": 1000})
    w.strategy("basket", B, portfolio=True)
    w.weights("basket", {B: 0.5, E: 0.5}, T1)
    w.manual(B, 0.01)
    w.manual(E, 0.5)
    w.boot()
    _migrate(w)
    w.eq(w.book(), {B: (0.01, 500.0), E: (0.25, 500.0)},
         "per asset: BTC = target (whole), ETH 2× target (the target's share)")
    w.eq(w.paper_fills(), [], "no order")


@scenario("C-08")
def c08(w):
    _basket(w, {B: 0.4, E: 0.3, SOL: 0.3})
    w.settle()
    w.amounts(basket=0)
    w.eq(sorted(w.settle()), sorted([(B, "sell", 0.008, True), (E, "sell", 0.15, True),
                                     (SOL, "sell", 3.0, True)]), "amount 0: every asset closed")


@scenario("C-09")
def c09(w):
    _basket(w, {B: 0.4, E: 0.6})
    w.settle()
    w.amounts()
    w.eq(sorted(w.settle()), sorted([(B, "sell", 0.008, True), (E, "sell", 0.3, True)]),
         "unpicked: every asset's book closed")


@scenario("C-10")
def c10(w):
    _basket(w, {B: 0.4}, start=False)
    cfg = json.load(open("manager/portfolio_config.json"))
    cfg["asset_specs"]["basket"] = {"type": "futures_contracts", "contract_value": 10}
    json.dump(cfg, open("manager/portfolio_config.json", "w"))
    w.start()
    w.eq(w.settle(), [], "a portfolio sized in lots is not traded (skipped, logged)")
    w.eq(w.snap()["target"], {}, "no target")


# ── reports ───────────────────────────────────────────────────────────────────

@scenario("RP-01")
def rp01(w):
    w.old_machine()
    w.sig("a1", 1)
    w.boot()
    _migrate(w)
    w.eq(w.report()["self_ledger"], True, "no key, reconciler running: its snapshot's own_only")
    w.age_heartbeat(400)
    w.eq(w.report()["self_ledger"], True, "no key, not running: the lib on disk decides (has the rule)")
    src = open("lib/portfolio.py").read()
    open("lib/portfolio.py", "w").write(src.replace("def own_positions_only(", "def _old_rule("))
    w.eq(w.report()["self_ledger"], False, "no key, not running, an older lib on disk: false (the pages warn)")
    open("lib/portfolio.py", "w").write(src)
    for flag in (False, True):
        cfg = json.load(open("manager/portfolio_config.json"))
        cfg["self_ledger"] = flag
        json.dump(cfg, open("manager/portfolio_config.json", "w"))
        w.eq(w.report()["self_ledger"], flag, f"an explicit {flag}: reported as is")


@scenario("RP-02")
def rp02(w):
    w.strategy("a1", B)
    w.bind_paper()
    w.sig("a1", 1)
    w.manual(B, 0.02)
    w.boot()
    w.round()
    r = w.report()
    w.eq((r["portfolio_configured"], r["last"].get("read_only")), (False, True),
         "never configured: portfolio_configured false, the running reconciler says read_only")
    w.eq((r["last"].get("needs_baseline") or {}).get("reason"), "unconfigured", "needs_baseline says why")
    w.eq(w.paper_fills(), [], "nothing traded, the manual BTC included")


@scenario("RP-03")
def rp03(w):
    _long(w)
    w.manual(B, 0.03)
    w.manual(E, 1.0)
    w.settle()
    w.round()
    last = w.report()["last"]
    w.eq({k: v["size"] for k, v in last["target"].items()}, {B: 1000.0}, "target")
    w.eq({k: (v["qty"], v["size"]) for k, v in last["ledger"].items()}, {B: (0.02, 1000.0)},
         "ledger = the bot's share (the desktop's 實際 column)")
    w.eq({k: v["size"] for k, v in last["actual"].items()}, {B: 2500.0, E: 2000.0},
         "actual = the whole account (the desktop lists ETH as 不歸 Blave 管)")
    w.eq(last.get("own_only"), True, "own_only")


@scenario("MP-11")
def mp11(w):
    w.fresh(strategies=(("s1", B, "spot"),), amounts={"s1": 500}, signals={"s1": 1})
    w.settle()
    w.manual(B + "@spot", 0.1)
    w.manual(B + "@spot", -0.01)  # the user sells "the bot's" 0.01 by hand, keeps 0.1
    w.sig("s1", 0)
    w.eq(w.settle(), [(B + "@spot", "sell", 0.01, False)],
         "one wallet pool: the exit still sells 0.01 (the coins can't be told apart)")
    w.eq(w.paper_pos(B + "@spot"), 0.09, "so the user ends with 0.09, not 0.1 (spot's known limit)")


@scenario("ED-23")
def ed23(w):
    _long(w)
    w.op.reset_account(w.env())  # the user's explicit paper reset
    w.eq(w.ap.get_positions(w.env()), [], "paper account wiped")
    w.eq(w.settle(), [], "the book still says long: nothing re-bought")
    w.eq(w.book(), {B: (0.02, 1000.0)}, "the book is not told")
    w.sig("a1", 0)
    w.round()
    w.round()
    w.eq(w.book(), {}, "the next exit writes it off on the second read (account holds none of it)")
    w.sig("a1", 1)
    w.eq(w.settle(), [(B, "buy", 0.02, False)], "from there it trades normally")


@scenario("ED-24")
def ed24(w):
    _long(w)
    w.cmd("execution", execution={"a1": {"type": "twap", "duration_min": 30}})
    w.marks(BTCUSDT=60000.0)
    w.sig("a1", 0)
    w.settle()
    w.eq((round(w.paper_pos(B), 8), w.book()), (0.0, {}),
         "a TWAP close 20% above entry sells the bot's whole 0.02 (progress counted at the book's rate)")


@scenario("ED-25")
def ed25(w):
    w.strategy("f1", "TMF")
    w.bind_paper()
    w.amounts(f1=2)
    w.sig("f1", 1)
    w.start()
    w.settle()
    w.eq(w.paper_pos("TMF"), 2.0, "2 TMF lots held")
    w.eq(w.cmd("close_all"), "close_all=started", "close_all")
    log = w.wait_flatten()
    w.eq((w.paper_pos(), w.book()), ({}, {}), "close_all closes the lots")
    w.check(not any("TMF" == e.get("symbol") for e in w.order_errors()), f"no close error ({log[-300:]})")


@scenario("ED-26")
def ed26(w):
    w.strategy("f1", "TMF")
    w.bind_paper()
    w.amounts(f1=2)
    w.sig("f1", 1)
    w.start()
    w.settle()
    w.amounts()
    w.eq(w.settle(), [("TMF", "sell", 2.0, True)], "unpicked: close-on-removal in lots (no spec left)")


@scenario("TC-29")
def tc29(w):
    _long(w)
    w.cl._resume_started_at = None  # later than the follow-up window of the last start
    r = w.cmd("restart_reconciler")
    w.check(w.sup["starts"] == 2 and "restarted" in str(r), f"settings 重啟: a new daemon process ({r})")
    w.eq(w.settle(), [], "signal unchanged: nothing trades after the restart")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--child")
    ap.add_argument("--ws")
    ap.add_argument("--src", default=ROOT)
    ap.add_argument("--only")
    ap.add_argument("-j", "--jobs", type=int, default=4)
    ap.add_argument("--keep", action="store_true")
    a = ap.parse_args()
    if a.child:
        sys.exit(run_child(a.child, a.ws, os.path.abspath(a.src)))
    sys.exit(parent(a))


# ── parent: enumerate, fan out ───────────────────────────────────────────────

SITECUSTOMIZE = r'''
import os, sys
_BLOCK = [os.path.realpath(p) for p in os.environ.get("PAPER_HARNESS_BLOCK", "").split(os.pathsep) if p]
def _paper_harness_hook(event, args):
    if event in ("socket.connect", "socket.getaddrinfo", "socket.gethostbyname"):
        raise PermissionError("paper harness: network is blocked (%s)" % event)
    if event == "open" and args and isinstance(args[0], (str, bytes)) and _BLOCK:
        p = os.path.realpath(os.fsdecode(args[0]))
        for b in _BLOCK:
            if p == b or p.startswith(b + os.sep):
                raise PermissionError("paper harness: %s must never be read" % p)
sys.addaudithook(_paper_harness_hook)
'''

HARNESS_RE = re.compile(r"^- \*\*Harness:\*\*\s*(.+)$")
HEAD_RE = re.compile(r"^### ([A-Z]{1,2}-\d{2}[a-z]?)\b")


def read_matrix():
    """{id: harness text} from the matrix's `### ID …` sections."""
    rows, cur = {}, None
    with open(MATRIX, encoding="utf-8") as f:
        for line in f:
            m = HEAD_RE.match(line)
            if m:
                cur = m.group(1)
                if cur in rows:
                    rows[cur] = "DUPLICATE"
                else:
                    rows[cur] = None
                continue
            m = HARNESS_RE.match(line.strip())
            if m and cur and rows.get(cur) is None:
                rows[cur] = m.group(1).strip()
    return rows


def enumerate_check(src):
    """Every matrix ID has a test here or says why not; every test here is in
    the matrix."""
    bad = []
    if not os.path.exists(MATRIX):
        return [f"matrix not found: {MATRIX}"], {}
    rows = read_matrix()
    for sid, h in sorted(rows.items()):
        if h is None:
            bad.append(f"{sid}: no '- **Harness:**' line")
        elif h == "DUPLICATE":
            bad.append(f"{sid}: listed twice")
        elif h.startswith("paper"):
            if sid not in SCEN:
                bad.append(f"{sid}: matrix says paper, no test case")
            if ("KNOWN BUG" in h) != (sid in KNOWN_BUGS):
                bad.append(f"{sid}: 'KNOWN BUG' in the matrix and KNOWN_BUGS here disagree")
        elif h.startswith("existing"):
            files = re.findall(r"tests/[\w./-]+\.(?:py|js)", h)
            if not files:
                bad.append(f"{sid}: 'existing' names no test file")
            for p in files:
                if not os.path.exists(os.path.join(src, p)):
                    bad.append(f"{sid}: cited {p} does not exist")
        elif h.startswith(("needs testnet", "needs UI", "pending Type C live")):
            if not re.search(r"[—:-]\s*\S.{10,}", h):
                bad.append(f"{sid}: '{h}' gives no reason")
            if sid in SCEN:
                bad.append(f"{sid}: has a test case but the matrix says '{h}'")
        else:
            bad.append(f"{sid}: unknown harness kind '{h}'")
    for sid in SCEN:
        if sid not in rows:
            bad.append(f"{sid}: test case not in the matrix")
    return bad, rows


def _child_env(tmp, src):
    env = dict(os.environ)
    env.pop("BLAVE_AGENT_LOCAL", None)
    venv_bin = os.path.dirname(sys.executable)
    env["PATH"] = venv_bin + os.pathsep + env.get("PATH", "")
    env["PYTHONPATH"] = tmp
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["PAPER_HARNESS_BLOCK"] = os.pathsep.join(
        [os.path.join(ROOT, ".env"), os.path.join(src, ".env"),
         os.path.expanduser("~/.config/blave")])
    env["MPLBACKEND"] = "Agg"
    return env


def make_ws(src, base):
    ws = tempfile.mkdtemp(prefix="ws-", dir=base)
    shutil.copytree(os.path.join(src, "lib"), os.path.join(ws, "lib"),
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    os.makedirs(os.path.join(ws, "manager"))
    for n in os.listdir(os.path.join(src, "manager")):
        if n.endswith(".py"):
            shutil.copy(os.path.join(src, "manager", n), os.path.join(ws, "manager", n))
    for d in ("state", "strategies"):
        os.makedirs(os.path.join(ws, d))
    os.symlink(os.path.join(src, "runtime"), os.path.join(ws, "current"))
    return ws


def run_one(sid, src, base, keep):
    ws = make_ws(src, base)
    env = _child_env(base, src)
    env["BLAVE_AGENT_WORKSPACE"] = ws
    env["BLAVE_AGENT_HOME"] = env["BLAVECLAW_HOME"] = env["BLAVE_AGENT_BASE"] = ws
    t0 = time.time()
    try:
        p = subprocess.run([sys.executable, os.path.abspath(__file__), "--child", sid,
                            "--ws", ws, "--src", src],
                           cwd=ws, env=env, capture_output=True, text=True,
                           timeout=CHILD_TIMEOUT_S)
        rc, out = p.returncode, p.stdout + (("\n" + p.stderr) if p.returncode else "")
    except subprocess.TimeoutExpired as e:
        rc, out = 1, f"TIMEOUT after {CHILD_TIMEOUT_S}s\n{e.stdout or ''}"
    if rc == 0 and not keep:
        shutil.rmtree(ws, ignore_errors=True)
    return sid, rc, out, time.time() - t0, ws


def parent(a):
    src = os.path.abspath(a.src)
    bad, rows = enumerate_check(src)
    print("== enumeration: matrix ↔ test cases")
    for b in bad:
        print("FAIL " + b)
    kinds = {}
    for h in rows.values():
        k = (h or "?").split()[0]
        kinds[k] = kinds.get(k, 0) + 1
    print(f"ok   matrix: {len(rows)} scenarios {kinds}; test cases here: {len(SCEN)}"
          if not bad else f"     {len(bad)} enumeration problem(s)")
    ids = sorted(SCEN) if not a.only else [s.strip() for s in a.only.split(",") if s.strip()]
    unknown = [s for s in ids if s not in SCEN]
    if unknown:
        print(f"FAIL unknown scenario ids {unknown}")
        return 1
    base = tempfile.mkdtemp(prefix="paper-scen-")
    with open(os.path.join(base, "sitecustomize.py"), "w") as f:
        f.write(SITECUSTOMIZE)
    failed, xfail = [], []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, a.jobs)) as pool:
        futs = [pool.submit(run_one, sid, src, base, a.keep) for sid in ids]
        for fut in concurrent.futures.as_completed(futs):
            sid, rc, out, dt, ws = fut.result()
            known = sid in KNOWN_BUGS
            verdict = ("xfail (known bug)" if rc and known else "XPASS: known bug no longer "
                       "reproduces" if known else "pass" if rc == 0 else "FAIL")
            print(f"== {sid}  {verdict}  ({dt:.1f}s)"
                  + ("" if rc == 0 and not a.keep else f"  ws={ws}"))
            if rc or known or os.environ.get("PAPER_HARNESS_VERBOSE"):
                if known:
                    print(f"   known bug: {KNOWN_BUGS[sid]}")
                print("   " + out.strip().replace("\n", "\n   "))
            if rc and known:
                xfail.append(sid)
            elif rc or known:
                failed.append(sid)
    if not failed and not a.keep:
        shutil.rmtree(base, ignore_errors=True)
    print()
    print(f"{len(ids) - len(failed) - len(xfail)}/{len(ids)} scenarios pass"
          + (f"; known bugs reproduced: {','.join(sorted(xfail))}" if xfail else "")
          + (f"; FAILED: {','.join(sorted(failed))}" if failed else ""))
    if bad:
        print(f"enumeration: {len(bad)} problem(s)")
    return 1 if failed or bad else 0


if __name__ == "__main__":
    main()
