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
  A4  the user closes 1 of the bot's 2, the signal halves (target 1): the user's close already
      did the reduce — nothing is sent, the book comes down to 1 on the confirmed read (it
      used to sell the last lot, leave the book at 1 over an empty account, and never notice);
      the exit then sells exactly that 1 lot.
  A5  the user closes 1 of the bot's 3, the signal goes to 1/3 (target 1): sells 1, not 2,
      and the book ends at what the account holds.
  A6  the bot holds 3 in this month; two reads in a row show this root only in the NEXT month
      (1 lot — a month the venue lib misjudged, a snapshot behind), signal 1/3. Right: that is
      not a manual close — nothing sent, the book stays 3, one order_error asks for a human;
      once the read shows the real 3 again the reduce of 2 goes out. Before the cross-check
      the book was rebased to 0 on the second read and the bot re-entered on top of its own
      3 lots.
  F   a plain flip +2 -> -2 with nothing manual, the entry leg reading a snapshot from
      before its own close: the entry waits a round, no order error (統一 used to re-split
      the entry against that stale snapshot, try a second close and log a P1).
  M   the user holds 1 lot in the bot's own month (same side): the bot's exits sell only
      its own 2 lots, every time.
  M2  same, but the user's lot is on the OTHER side: the bot's entry nets into it at the
      broker, and today nothing records that (futures have no netted_qty), so the exit
      does not hand it back (known gap).
  R1  the user holds the next month on the other side while the bot holds this month:
      the bot's read is its own month only (群益 used to net the months to 0 and write the
      bot's lot off), and its exit sells its own month.
  R2  the user holds the next month (same side); this month settles, the next month
      becomes the front month: it stays the user's (the book did not record it) — the bot
      re-enters beside it and later sells only its own lot.
  H1  2026-02: settlement postponed from 02-18 to 02-23 (Lunar New Year). Past 02-18
      13:30 the February contract still trades: kept, nothing re-entered; once it
      settles on 02-23 the book drops it and re-enters in March.
  H2  the same for 2023-01 (01-18 -> 01-30).

President (統一) runs the same scenarios when lib/order_president.py exists
(another branch); on main they are skipped. Every contract-calendar "now" is
frozen (freeze_clock); the 5 s sleeps are real (note_account_short's spacing).

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
    "capital:M2": "futures netting is not recorded (no netted_qty): an entry that nets into the user's "
                  "opposite lot in the same month is not handed back on exit",
    "president:M2": "futures netting is not recorded (no netted_qty): an entry that nets into the user's "
                    "opposite lot in the same month is not handed back on exit",
}


# ── child: one scenario in a scratch workspace ──────────────────────────────

class World:
    """The fake venue + the strategy's files. Rows are {contract: signed lots}."""

    def __init__(self, venue, tmp):
        self.venue, self.tmp = venue, tmp
        self.rows, self.near, self.listed, self.sent = {}, None, None, []
        self.stale = False
        self.lag = False  # True: the snapshot's read started before this round's sends
        self.fake = None  # rows the snapshot reports instead of the real ones (a wrong read)

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
                   "query_started_at": now - 1 if w.lag else now + 30,
                   "positions": [{"symbol": k, "side": "buy" if v > 0 else "sell", "lots": abs(v)}
                                 for k, v in (w.rows if w.fake is None else w.fake).items()]},
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
                   "query_started_at": now - 1 if w.lag else now + 30, "account_fp": "fp1", "equity": 1e6,
                   "listed": w.listed,
                   "positions": [{"root": k[:3], "productid": k, "net": v}
                                 for k, v in (w.rows if w.fake is None else w.fake).items()]},
                  open(ap._SNAPSHOT, "w"))
    w.write_snapshot = write_snapshot
    w.listed = {"TXF": ["TXFJ6", "TXFK6", "TXFL6"]}
    return w


def freeze_clock(w):
    """Every contract-calendar "now" (settlement times, the entry roll, the
    book's settlement check) goes through lib.president_contracts._now."""
    from datetime import datetime
    from lib import president_contracts as pc
    w.clock = datetime(2026, 10, 8, 10, 0, tzinfo=pc.TAIPEI)
    real_now = pc._now
    pc._now = lambda now: real_now(now or w.clock)


def child(venue, sid, tmp):
    os.chdir(tmp)
    sys.path.insert(0, SRC)
    os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = tmp
    w = {"capital": capital_world, "president": president_world}[venue](tmp)
    freeze_clock(w)
    w.setup(1 if sid[0] in "BRH" else 3 if sid in ("A5", "A6") else 2)
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

    def code(y, m):
        if venue == "capital":
            return f"TX{y % 100:02d}{m:02d}"
        from lib.president_contracts import prod_id
        return prod_id("TXF", y, m)

    def at(y, mo, d, h=10, mi=0):
        w.clock = w.clock.replace(year=y, month=mo, day=d, hour=h, minute=mi)

    def months_listed(*ym):
        """the broker's state for these months: 群益's alias goes to the first, 統一 lists them"""
        if venue == "capital":
            w.near = code(*ym[0])
        else:
            w.listed = {"TXF": [code(y, m) for y, m in ym]}

    def audits(kind):
        try:
            lines = [json.loads(x) for x in open("state/audit.jsonl")]
        except OSError:
            return []
        return [a for a in lines if a.get("event") == kind]

    def errors():
        try:
            return json.load(open("manager/order_errors.json"))
        except (OSError, ValueError):
            return []

    log = []
    boot()
    w.signal(1)
    if sid[0] in "BR":
        at(2026, 10, 20)
    if sid == "H1":
        at(2026, 2, 10)
        months_listed((2026, 2), (2026, 3), (2026, 4))
    if sid == "H2":
        at(2023, 1, 10)
        months_listed((2023, 1), (2023, 2), (2023, 3))
    if sid in ("R1", "R2"):
        w.rows[code(2026, 11)] = -1 if sid == "R1" else 1  # the user's own, opened in the app
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
    elif sid in ("A4", "A5"):
        w.rows = {k: v - 1 for k, v in w.rows.items()}
        w.signal(0.5 if sid == "A4" else 1 / 3)
        round_("user closed 1 by hand, signal cut to 1 lot")
        time.sleep(5.5)
        round_("next round, >=5 s later")
        mid = round_("converged")
        sent_mid = [o["lots"] for r in log[2:] for o in r["sent"]]
        held_mid, book_mid = w.net(), ledger_txf(mid)
        w.signal(0)
        last = round_("signal -> 0")
        ok = (sent_mid == ([] if sid == "A4" else [1]) and held_mid == 1 and book_mid == 1
              and [o["lots"] for o in last["sent"]] == [1] and w.net() == 0 and ledger_txf(last) == 0
              and not errors() and not last["halt"])
        why = (f"after closing 1 by hand and a partial reduce: sent={sent_mid}, broker net={held_mid}, "
               f"book TXF={book_mid}; then signal 0 sent={last['sent']}, broker={w.rows}, "
               f"book TXF={ledger_txf(last)}")
    elif sid == "A6":
        w.fake = {code(2026, 11): 1}
        w.signal(1 / 3)
        round_("read shows the root only in November, signal cut to 1 lot")
        time.sleep(5.5)
        r2 = round_("next round, >=5 s later: still only November")
        r3 = round_("one more round")
        held_mid, book_mid = w.net(), ledger_txf(r3)
        errs_mid = [e for e in errors() if "月份對不上" in e.get("error", "")]
        w.fake = None
        r4 = round_("read shows the real 3 again")
        last = round_("converged")
        sent_wrong = [o for r in log[2:5] for o in r["sent"]]
        ok = (not sent_wrong and held_mid == 3 and book_mid == 3 and len(errs_mid) == 1
              and not audits("ledger_writeoff") and len(audits("ledger_month_mismatch")) == 1
              and [o["lots"] for o in r4["sent"] + last["sent"]] == [2]
              and w.net() == 1 and ledger_txf(last) == 1 and not last["halt"])
        why = (f"two reads in the wrong month: sent={sent_wrong}, broker net={held_mid}, "
               f"book TXF={book_mid}, mismatch errors={len(errs_mid)}, "
               f"writeoffs={len(audits('ledger_writeoff'))}; then real read: sent={r4['sent'] + last['sent']}, "
               f"broker={w.rows}, book TXF={ledger_txf(last)}")
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
    elif sid == "F":
        w.signal(-1)
        if venue == "president":
            # the worker caught up with the entry long ago; this round's snapshot is
            # read before the flip's own close, as it always is live
            from lib import order_president as op
            json.dump({k: v - 100 for k, v in op._last_orders().items()}, open(op.LAST_ORDER_PATH, "w"))
            w.lag = True
        round_("signal flips to -1")
        w.lag = False
        time.sleep(5.5)
        round_("next round")
        last = round_("converged")
        nets = [sum(r["broker"].values()) for r in log]
        ok = (w.net() == -2 and ledger_txf(last) == -2 and min(nets) >= -2 and not errors()
              and not last["halt"])
        why = f"plain flip: broker nets per round={nets}, book TXF={ledger_txf(last)}, order_errors={errors()}"
    elif sid == "M":
        month = next(iter(w.rows))
        w.rows[month] += 1  # the user adds a lot of their own in the bot's month
        w.signal(0)
        round_("user holds +1 in the bot's month, signal -> 0")
        w.signal(1)
        round_("signal -> 1")
        round_("converged")
        w.signal(0)
        last = round_("signal -> 0 again")
        sold = [o["lots"] for r in log[2:] for o in r["sent"] if o["side"] == "sell"]
        ok = w.rows == {month: 1} and ledger_txf(last) == 0 and sold == [2, 2] and not errors()
        why = f"user's lot beside the bot's: sells={sold}, broker={w.rows}, book TXF={ledger_txf(last)}"
    elif sid == "M2":
        month = next(iter(w.rows))
        w.signal(0)
        round_("signal -> 0")
        w.rows[month] = w.rows.get(month, 0) - 1  # the user goes short 1 in the same month
        w.signal(1)
        round_("signal -> 1 beside the user's -1")
        round_("converged")
        w.signal(0)
        round_("signal -> 0")
        time.sleep(5.5)
        last = round_("next round")
        ok = w.rows.get(month) == -1 and ledger_txf(last) == 0
        why = f"after the bot's round trip beside the user's -1: broker={w.rows}, book TXF={ledger_txf(last)}"
    elif sid == "Z":
        # the strategy is unpicked (amount 0): no target row, no asset_spec —
        # the book alone says 2 lots are the bot's, and they must be closed
        cfg = json.load(open("manager/portfolio_config.json"))
        cfg["amounts"][STRAT] = 0
        json.dump(cfg, open("manager/portfolio_config.json", "w"))
        r1 = round_("amount -> 0 (unpicked)")
        time.sleep(5.5)
        last = round_("next round, >=5 s later")
        sent_after = [o for r in log[2:] for o in r["sent"]]
        closes = [o for o in sent_after if o["side"] == "sell" and o["lots"] == 2
                  and (o.get("intent") == "reduce" if venue == "capital" else o.get("opencloseflag") == "1")]
        ok = (len(sent_after) == 1 and len(closes) == 1 and w.net() == 0 and ledger_txf(last) == 0
              and not errors() and not last["halt"])
        why = (f"close-on-removal: sent={sent_after}, broker={w.rows}, book TXF={ledger_txf(last)}, "
               f"order_errors={errors()}")
    elif sid == "R1":
        r1 = round_("signal unchanged")
        time.sleep(5.5)
        r2 = round_("next round, >=5 s later")
        w.signal(0)
        last = round_("signal -> 0")
        ok = (w.rows == {code(2026, 11): -1} and ledger_txf(last) == 0
              and not r1["sent"] and not r2["sent"] and ledger_txf(r2) == 1)
        why = (f"user short the next month beside the bot's month: book held at {ledger_txf(r2)}, "
               f"broker={w.rows}, book TXF={ledger_txf(last)}")
    elif sid == "R2":
        at(2026, 10, 21, 13, 31)
        if venue == "capital":
            w.rows.pop(code(2026, 10), None)
        months_listed((2026, 11), (2026, 12), (2027, 1))
        round_("October settled; the user's November is now the front month")
        time.sleep(5.5)
        round_("next round")
        round_("converged")
        w.signal(0)
        last = round_("signal -> 0")
        nov = w.rows.get(code(2026, 11))
        ok = nov == 1 and ledger_txf(last) == 0 and not last["halt"]
        why = (f"after settlement beside the user's November: November={nov}, broker={w.rows}, "
               f"book TXF={ledger_txf(last)}")
    elif sid in ("H1", "H2"):
        y, m, d_late = (2026, 2, 23) if sid == "H1" else (2023, 1, 30)
        d_third = 18
        at(y, m, d_third, 13, 31)  # the calendar's settlement time: postponed, still trading
        r1 = round_("past the third Wednesday 13:30, still listed / held")
        time.sleep(5.5)
        r2 = round_("next round")
        held_ok = (not r1["sent"] and not r2["sent"] and ledger_txf(r2) == 1 and not r2["halt"])
        at(y, m, d_late, 13, 31)  # the postponed settlement
        if venue == "capital":
            w.rows.pop(code(y, m), None)
        months_listed((y, m + 1), (y, m + 2), (y, m + 3))
        round_("postponed settlement passed")
        time.sleep(5.5)
        last = round_("next round")
        nxt = w.rows.get(code(y, m + 1))
        ok = held_ok and nxt == 1 and ledger_txf(last) == 1 and not last["halt"]
        why = (f"postponed {y}-{m:02d}: held through the third Wednesday={held_ok}, "
               f"then next month={nxt}, broker={w.rows}, book TXF={ledger_txf(last)}")
    else:
        # 2026-10-21 13:30 Taipei: the October contract cash-settles
        w.clock = w.clock.replace(day=21, hour=13, minute=31)
        if venue == "capital":
            w.rows, w.near = {}, "TX2611"
        else:
            w.listed = {"TXF": ["TXFK6", "TXFL6", "TXFA7"]}
        if sid == "B1":
            round_("settled, signal unchanged")
            time.sleep(5.5)
            last = round_("next round")
            ok = (w.rows.get("TX2611" if venue == "capital" else "TXFK6") == 1 and not last["halt"]
                  and ledger_txf(last) == 1 and audits("ledger_settled")
                  and not audits("ledger_writeoff")
                  and not [m for m in tg if "Bought" not in m])  # an expected roll: no notice
            why = (f"broker={w.rows}, book TXF={ledger_txf(last)}, halt={last['halt']}, "
                   f"settled audits={len(audits('ledger_settled'))}, "
                   f"writeoffs={len(audits('ledger_writeoff'))}, telegram={tg}")
        elif sid == "B2":
            if venue == "capital":
                w.stale = True
                round_("worker snapshot stale (one failed read)")
                w.stale = False
            else:
                w.rows, w.listed = {"TXFJ6": 1}, None  # residue still listed by the worker, list unread
                round_("contract list unread past 13:30 (ListUnknown)")
                w.rows, w.listed = {"TXFJ6": 1}, {"TXF": ["TXFK6", "TXFL6", "TXFA7"]}
            first = round_("next good read: settled")
            time.sleep(5.5)
            last = round_("next round")
            ok = not first["halt"] and not last["halt"] and ledger_txf(last) == 1 and last["sent"]
            why = (f"halt={first['halt'] or last['halt']} reason={first['halt_reason']!r} "
                   f"outcome={first['outcome']!r}, then sent={last['sent']}")
        elif sid == "B2R":
            boot()  # fresh reconciler module: what a restart / reboot loads
            first = round_("first round after restart, settled")
            time.sleep(5.5)
            last = round_("next round")
            ok = not first["halt"] and not last["halt"] and ledger_txf(last) == 1 and last["sent"]
            why = (f"halt={first['halt'] or last['halt']} reason={first['halt_reason']!r} "
                   f"outcome={first['outcome']!r}, then sent={last['sent']}")
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
        for sid in ("A", "A2", "A3", "A4", "A5", "A6", "F", "M", "M2", "Z", "R1", "R2", "B1", "B2", "B2R", "B3", "H1", "H2"):
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
