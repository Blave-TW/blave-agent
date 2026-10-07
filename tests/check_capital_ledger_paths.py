"""TW-futures book vs account, through the reconciler's whole round — no broker.

The 10-07 position-source audit read two real-money gaps out of the code; this
reproduces them through what the daemon actually calls each round:
lib.portfolio.reconcile(get_positions_fn=reconciler._get_positions_guarded,
place_order_fn=reconciler.place_order, threshold=reconciler._symbol_threshold),
with a real strategy state.json, portfolio_config.json and ledger_seed.json, the
book built by the round's own fill recording, and the REAL lib/account_capital +
lib/order_capital (only the SKCOM session and the worker's snapshot file are
faked; the fake venue applies sNewClose=2 as "net += lots in the month the alias
resolves to", which is what auto new/close does).

Scenarios (each in its own child process and scratch dir):
  A   bot holds +2, the user closes it in the broker's app, the signal goes to 0.
      Right: nothing is sent (a reduce never exceeds what is held), the book is
      written off once the short read is confirmed (≥5 s apart). Before the fix
      (lib/portfolio.hand_wired_reduce_cap) a sell of 2 went out on sNewClose=2 and
      opened a short of 2 the book did not know about.
  B1  bot holds +1 of the expiring month, it cash-settles (row gone, alias now
      the next month), signal unchanged. Right: the book drops the settled lots
      and re-enters 1 lot in the next month.
  B2  same, but the read just before the settled read failed. Right: no HALT.
  B2R same, but the reconciler restarts right after settlement. Right: no HALT.
  B3  same as B1, then the signal goes to 0. Right: nothing is sent.
  A2  the user closes 1 of the bot's 2, signal 0: sell 1 only, book written off to 0.
  A3  manual close, then the signal flips to -1 (2 lots): the short entry waits for the
      confirmed read, never sells more than 2 in total.

President (統一) runs the same scenarios when lib/order_president.py exists
(another branch); on main they are skipped.

A scenario that fails because of a real bug asserts the intended behaviour and is
listed in KNOWN_BUGS: reported "xfail", and fails the run the day it passes
(take it off the list in the same change) — tests/check_paper_scenarios.py's rule.

Run: cd blave-agent && .venv/bin/python tests/check_capital_ledger_paths.py
"""
import importlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import types

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.dirname(HERE)
STRAT = "txf_trend"

KNOWN_BUGS = {
    "capital:B1": "settlement is not a book event: the book keeps the settled lots and the strategy "
                  "never re-enters (audit 10-07 #2)",
    "capital:B2": "the settled read after a failed read trips the empty-account guard HALT (audit 10-07 #2)",
    "capital:B2R": "the first read after a restart past settlement trips the empty-account guard HALT",
    "president:B1": "settlement is not a book event: the book keeps the settled lots, no re-entry",
    "president:B2": "ListUnknown past 13:30 re-arms the account guard; the next read HALTs",
    "president:B2R": "the first read after a restart past settlement trips the empty-account guard HALT",
}


# ── child: one scenario in a scratch workspace ──────────────────────────────

class World:
    """The fake venue + the strategy's files. Rows are {contract: signed lots}."""

    def __init__(self, venue, tmp):
        self.venue, self.tmp = venue, tmp
        self.rows, self.near, self.listed, self.sent = {}, None, None, []
        self.stale = False

    def setup(self, lots):
        os.makedirs("manager", exist_ok=True)
        os.makedirs("state", exist_ok=True)
        os.makedirs(f"strategies/{STRAT}", exist_ok=True)
        json.dump({"self_ledger": True, "exchanges": {STRAT: self.venue},
                   "amounts": {STRAT: lots},
                   "asset_specs": {STRAT: {"type": "futures_contracts"}}},
                  open("manager/portfolio_config.json", "w"))
        json.dump({"seeded_at": "2026-01-01T00:00:00", "own_only_basis": 1, "symbols": {}},
                  open("manager/ledger_seed.json", "w"))
        self.signal(0)

    def signal(self, pos):
        json.dump({"symbol": "TXF", "position": pos}, open(f"strategies/{STRAT}/state.json", "w"))

    def net(self):
        return sum(self.rows.values())


def capital_world(tmp):
    w = World("capital", tmp)
    from lib import account_capital as ac, order_capital as oc
    ac._SNAPSHOT = os.path.join(tmp, "state", "capital_account.json")
    oc._REFRESH_FLAG = os.path.join(tmp, "state", "capital_refresh")

    clk = types.SimpleNamespace(t=0.0)
    oc.time = types.SimpleNamespace(time=lambda: clk.t,
                                    sleep=lambda s: setattr(clk, "t", clk.t + s))
    fills, pending = {}, []

    class Pump:
        @staticmethod
        def PumpWaitingMessages():
            while pending:
                seq, row = pending.pop(0)
                fills.setdefault(seq, []).append(row)

    class Sess:
        futures_account, login_id = "F0", "A1"
        events = types.SimpleNamespace(fills=fills)

        class order:
            @staticmethod
            def SendFutureOrderCLR(_login, _async, p):
                side = "buy" if p.sBuySell == 0 else "sell"
                w.sent[-1].update(alias=p.bstrStockNo, side=side, lots=p.nQty,
                                  sNewClose=p.sNewClose, month=w.near)
                w.rows[w.near] = w.rows.get(w.near, 0) + (p.nQty if side == "buy" else -p.nQty)
                w.rows = {k: v for k, v in w.rows.items() if v}
                seq = f"{len(w.sent):013d}"
                pending.append((seq, {"qty": float(p.nQty), "price": 23000.0, "symbol": w.near,
                                      "fill_id": seq, "market": "TF"}))
                return seq, 0

    oc.pythoncom = Pump
    oc.sk = types.SimpleNamespace(FUTUREORDER=type("FUTUREORDER", (), {}))
    oc._get_session = lambda env: Sess
    real_place = oc.place_futures_market_order

    def recording_place(env, symbol, action, lots, intent, confirm_timeout=15):
        w.sent.append({"intent": intent})
        return real_place(env, symbol, action, lots, intent, confirm_timeout)
    oc.place_futures_market_order = recording_place

    def write_snapshot():
        now = time.time()
        json.dump({"ok": True, "read_at": now - 1000 if w.stale else now + 1,
                   "query_started_at": now + 30,
                   "positions": [{"symbol": k, "side": "buy" if v > 0 else "sell", "lots": abs(v)}
                                 for k, v in w.rows.items()]},
                  open(ac._SNAPSHOT, "w"))
    w.write_snapshot = write_snapshot
    w.near = "TX2610"
    return w


def president_world(tmp):
    w = World("president", tmp)
    from datetime import datetime
    ut, utu = types.ModuleType("unitrade"), types.ModuleType("unitrade.unitrade")
    utu.DOrderObject = type("DOrderObject", (), {})
    sys.modules["unitrade"], sys.modules["unitrade.unitrade"] = ut, utu
    from lib import account_president as ap, order_president as op, president_contracts as pc
    from lib import president_vault as pv
    ap._SNAPSHOT = os.path.join(tmp, "state", "president_account.json")
    for name in ("_REFRESH_FLAG", "_TAGS_PATH", "LAST_ORDER_PATH", "SEND_LOCK_PATH", "SDK_LOG_DIR"):
        setattr(op, name, os.path.join(tmp, "state", os.path.basename(getattr(op, name))))
    w.clock = datetime(2026, 10, 8, 10, 0, tzinfo=pc.TAIPEI)
    real_now = pc._now
    pc._now = lambda now: real_now(now or w.clock)

    class R:
        def __init__(self, **kw):
            self.__dict__.update(kw)

    class Api:
        def __init__(self):
            self.dtrade = types.SimpleNamespace(order=self._order, on_reply=None, on_match=None)

        def get_domestic_contracts(self, root, kind):
            return R(ok=True, error="", data=[R(prod_id=p) for p in (w.listed or {}).get(root, [])])

        def get_accounts(self):
            return ["A1"]

        def _order(self, o):
            qty = int(o.orderqty)
            w.sent.append({"contract": o.productid, "side": "buy" if o.bs == "B" else "sell",
                           "lots": qty, "opencloseflag": o.opencloseflag})
            w.rows[o.productid] = w.rows.get(o.productid, 0) + (qty if o.bs == "B" else -qty)
            w.rows = {k: v for k, v in w.rows.items() if v}
            seq = f"S{len(w.sent)}"
            self.dtrade.on_reply(R(seq=seq, orderno=f"O{len(w.sent)}", statuscode="0000",
                                   orderstatus="", matchqty=qty, nomatchqty=0, productid=o.productid))
            self.dtrade.on_match(R(orderno=f"O{len(w.sent)}", matchseq="1", matchqty=qty,
                                   matchprice=23000.0))
            return R(issend=True, errorcode="", errormsg="", seq=seq)

        def logout(self):
            pass

    pv.login = lambda *a, **k: Api()
    pv.resolve = lambda *a, **k: {}

    def write_snapshot():
        now = time.time()
        json.dump({"ok": True, "read_at": now - 1000 if w.stale else now + 1,
                   "query_started_at": now + 30, "account_fp": "fp1", "equity": 1e6,
                   "listed": w.listed,
                   "positions": [{"root": k[:3], "productid": k, "net": v} for k, v in w.rows.items()]},
                  open(ap._SNAPSHOT, "w"))
    w.write_snapshot = write_snapshot
    w.listed = {"TXF": ["TXFJ6", "TXFK6", "TXFL6"]}
    return w


def child(venue, sid, tmp):
    os.chdir(tmp)
    sys.path.insert(0, SRC)
    os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = tmp
    w = {"capital": capital_world, "president": president_world}[venue](tmp)
    w.setup(1 if sid.startswith("B") else 2)
    from lib import guard, portfolio
    state = {"rec": None}
    tg = []

    def boot():
        from manager import reconciler
        rec = importlib.reload(reconciler) if state["rec"] else reconciler
        rec.send_telegram = tg.append
        rec._read_env = lambda: {}
        state["rec"] = rec

    def round_(label):
        rec = state["rec"]
        w.write_snapshot()
        before = len(w.sent)
        try:
            portfolio.reconcile(get_positions_fn=rec._get_positions_guarded,
                                place_order_fn=rec.place_order,
                                threshold=rec._symbol_threshold, send_telegram_fn=tg.append)
            outcome = "ok"
        except rec.ReadSkipped as e:
            outcome = f"skipped: {e}"
        except Exception as e:
            outcome = f"error: {type(e).__name__}: {e}"
        led = {k: (1 if v["side"] == "long" else -1) * float(v["size"])
               for k, v in (portfolio.ledger_positions() or {}).items() if float(v["size"])}
        r = {"label": label, "outcome": outcome, "sent": w.sent[before:],
             "broker": dict(w.rows), "ledger": led, "halt": guard.halted(),
             "halt_reason": (guard.halt_info() or {}).get("reason") if guard.halted() else None}
        log.append(r)
        return r

    def ledger_txf(r):
        return r["ledger"].get("TXF", 0.0)

    log = []
    boot()
    w.signal(1)
    if venue == "president" and sid.startswith("B"):
        from datetime import datetime
        w.clock = w.clock.replace(month=10, day=20, hour=10)
    round_("entry")
    round_("converged")
    ok, why = True, ""

    if sid == "A":
        w.rows = {}
        round_("user closed it in the app, signal unchanged")
        w.signal(0)
        round_("signal -> 0")
        time.sleep(5.5)
        last = round_("next round, >=5 s later")
        sent_after = [o for r in log[2:] for o in r["sent"]]
        ok = not sent_after and w.net() == 0 and ledger_txf(last) == 0
        why = f"after the manual close: sent={sent_after}, broker={w.rows}, book TXF={ledger_txf(last)}"
    elif sid == "A2":
        w.rows = {k: v - 1 for k, v in w.rows.items()}
        w.signal(0)
        round_("user closed 1 of 2, signal -> 0")
        time.sleep(5.5)
        last = round_("next round, >=5 s later")
        sent_after = [o for r in log[2:] for o in r["sent"]]
        ok = [o["lots"] for o in sent_after] == [1] and w.net() == 0 and ledger_txf(last) == 0
        why = f"after closing 1 by hand: sent={sent_after}, broker={w.rows}, book TXF={ledger_txf(last)}"
    elif sid == "A3":
        w.rows = {}
        w.signal(-1)
        r1 = round_("user closed it in the app, signal flips to -1")
        time.sleep(5.5)
        round_("next round, >=5 s later")
        last = round_("converged")
        nets = [sum(r["broker"].values()) for r in log]
        ok = w.net() == -2 and ledger_txf(last) == -2 and min(nets) >= -2 and not r1["sent"]
        why = (f"flip after the manual close: first round sent={r1['sent']}, broker nets per round={nets}, "
               f"book TXF={ledger_txf(last)}")
    else:
        # 2026-10-21 13:30 Taipei: the October contract cash-settles
        if venue == "capital":
            w.rows, w.near = {}, "TX2611"
        else:
            w.clock = w.clock.replace(day=21, hour=13, minute=31)
            w.listed = {"TXF": ["TXFK6", "TXFL6", "TXFA7"]}
        if sid == "B1":
            round_("settled, signal unchanged")
            time.sleep(5.5)
            last = round_("next round")
            ok = w.rows.get("TX2611" if venue == "capital" else "TXFK6") == 1 and not last["halt"]
            why = f"broker={w.rows}, book TXF={ledger_txf(last)}, halt={last['halt']}"
        elif sid == "B2":
            if venue == "capital":
                w.stale = True
                round_("worker snapshot stale (one failed read)")
                w.stale = False
            else:
                w.rows, w.listed = {"TXFJ6": 1}, None  # residue still listed by the worker, list unread
                round_("contract list unread past 13:30 (ListUnknown)")
                w.rows, w.listed = {"TXFJ6": 1}, {"TXF": ["TXFK6", "TXFL6", "TXFA7"]}
            last = round_("next good read: settled")
            ok = not last["halt"]
            why = f"halt={last['halt']} reason={last['halt_reason']!r} outcome={last['outcome']!r}"
        elif sid == "B2R":
            boot()  # fresh reconciler module: what a restart / reboot loads
            last = round_("first round after restart, settled")
            ok = not last["halt"]
            why = f"halt={last['halt']} reason={last['halt_reason']!r} outcome={last['outcome']!r}"
        elif sid == "B3":
            round_("settled, signal unchanged")
            w.signal(0)
            round_("signal -> 0")
            time.sleep(5.5)
            last = round_("next round")
            sent_after = [o for r in log[2:] for o in r["sent"]]
            ok = not sent_after
            why = f"after settlement: sent={sent_after}, broker={w.rows}, book TXF={ledger_txf(last)}"
    json.dump({"ok": ok, "why": why, "rounds": log, "telegram": tg}, open("result.json", "w"),
              indent=1, default=str)


# ── parent ──────────────────────────────────────────────────────────────────

def main():
    venues = ["capital"]
    if os.path.exists(os.path.join(SRC, "lib", "order_president.py")):
        venues.append("president")
    verbose = "-v" in sys.argv
    failed, xfail = [], []
    for venue in venues:
        for sid in ("A", "A2", "A3", "B1", "B2", "B2R", "B3"):
            cid = f"{venue}:{sid}"
            tmp = tempfile.mkdtemp(prefix=f"ledgerpaths-{venue}-{sid}-")
            try:
                p = subprocess.run([sys.executable, __file__, "--child", venue, sid, tmp],
                                   capture_output=True, text=True, timeout=180)
                try:
                    res = json.load(open(os.path.join(tmp, "result.json")))
                except (OSError, ValueError):
                    res = {"ok": False, "why": "child crashed:\n" + p.stderr[-3000:], "rounds": []}
            finally:
                shutil.rmtree(tmp, ignore_errors=True)
            known = cid in KNOWN_BUGS
            if res["ok"]:
                verdict = "XPASS: known bug no longer reproduces — take it off KNOWN_BUGS" if known else "ok"
                if known:
                    failed.append(cid)
            else:
                verdict = "xfail (known bug)" if known else "FAIL"
                (xfail if known else failed).append(cid)
            print(f"{verdict:<18} {cid}: {res['why']}")
            if known and not res["ok"]:
                print(f"   known bug: {KNOWN_BUGS[cid]}")
            if verbose or verdict == "FAIL":
                for r in res["rounds"]:
                    print(f"     - {r['label']}: {r['outcome']} sent={r['sent']} broker={r['broker']} "
                          f"book={r['ledger']} halt={r['halt_reason']!r}")
    print(("all pass" if not failed else f"FAILED: {', '.join(failed)}")
          + (f"; known bugs reproduced: {', '.join(xfail)}" if xfail else ""))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--child":
        child(*sys.argv[2:5])
    else:
        main()
