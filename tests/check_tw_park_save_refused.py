"""A TW futures send whose park record cannot be saved is never sent a second time — no broker.

The broker took the order, the fill report did not come (or came short), and the save of
state/<venue>_pending_sent.json was refused (full disk, a file another program holds). Before the
fix the OSError left _<venue>_place_order after the send: lib.portfolio.reconcile recorded it as
a failed order (下單失敗, the raw OSError text), booked nothing — not even the lots the broker did
report — and no park row held the root, so the next round sent the same lots again.

Through the daemon's own round (lib.portfolio.reconcile with the reconciler's guarded read and
place_order), a real book, one child process per scenario. 群益 and 統一 use the fake venues of
tests/check_capital_ledger_paths.py; 永豐's gate is flipped in the child (its row ships off).
The order lib is wrapped: the broker fills `w.fill` of the lots, the report says `w.report`.
The save is refused where every park save ends (lib.president_vault.replace_json). A refused row
goes to the park file's side file (<park file>.unsaved), which a restart reads back; in the first
nine scenarios the side file is refused too (a full disk), so the row is only in the process.

  sent     entry of 2, filled at the broker, no fill report, save refused and still refused:
           HALT whose reason is the user's P1 (a full freeze, names the symbol), no order_errors
           row at all (neither 下單失敗 with the OSError nor 結果不明, which says closes go on);
           nothing sent under HALT; after 啟動下單 in the same process the row kept in memory is
           claimed — book 2, account 2, one send in all. Once settled nothing is left in memory,
           and a row another process (flatten) then parks into the file is read.
  partial  entry of 2, the broker fills and reports 1, save refused: the reported lot is booked;
           HALT; after 啟動下單 the unfilled lot (account unchanged) is cleared and sent once
           more — book 2, account 2, never 3.
  recover  entry of 2 the broker took and has not filled, save refused; the file then takes the
           next save: the row is in the file, nothing is left in memory, and the file is what
           is read from then on (another process's row over the same key).
  refused  the same, the file refusing for good: every 啟動下單 is followed by HALT again while the
           row is only in this process — never the row telling the user to reopen Blave (a
           restart forgets the row), no second send.
  reduce   a close of 2 that fills with no report, save refused: HALT, claimed, book 0, account
           0, the close sent once.
  halted   the user's stop lands while the order is at the broker, then the save is refused: the
           HALT's source and reason stay, the row is kept in memory.
  unreadable  a close of 2 the broker took unreported, save refused; the file then exists and
           cannot be read: every 啟動下單 is followed by HALT again, no row telling the user to
           reopen Blave, no second close.
  unreadable_entry  the file exists and cannot be read, nothing held in the process, the signal wants
           2 lots: no entry goes out (whether lots are parked is unknown), no HALT, one tw_entry_hold
           row.
  merge    a parked +2 in the file; a close of 1 beside it fills and the row's new baseline is
           refused by the file: the row read is the process's (baseline 1, the file says 2), so
           the +2 that then fills is booked — book 3, account 3.

The park file refuses, its side file takes the save (a file another program holds). A restart is a
second child process on the same workspace: nothing of the first one's memory is left.

  side_restart  entry of 2, filled at the broker, no fill report: HALT, the row is in the side file
           and not in the process. Restart, 啟動下單 before any round, the park file still refusing:
           the row is claimed from the side file — book 2, account 2, one send in all (4 lots at the
           broker without it). Settled, nothing is held outside the park file any more: the side
           file is removed, and no settled mark is left (the park file never held the row).
  side_queued  entry of 2 the broker took and has not filled. Restart, 啟動下單: the root still waits
           on the row (no second send), and HALT again while the park file refuses it.
  side_reduce  a close of 2 that fills with no report. Restart, 啟動下單: claimed, book 0, account 0,
           the close sent once.
  side_recover  no restart; the park file takes the next save: the row is in it, the side file is
           removed, another process's row is read.
  side_corrupt  the side file is there and does not read after the restart: every 啟動下單 is followed
           by HALT again, nothing is sent (the account holds 2 the book does not know of).
  tomb     a parked +2 in the park file; a close of 1 beside it fills and the new baseline goes to
           the side file; the +2 never fills and the claim clears the row while the park file
           refuses: its stale row is not read again (a settled mark in the side file naming that
           row by its first leg's send time), also after a restart,
           no HALT for an account it cannot explain; the park file writable again → it is emptied
           and the side file removed.
  side_p1  the settled mark of side_tomb is left behind (the park file is emptied, os.remove of the
           side file refused) and a new +3 the broker took unreported is parked under the same key.
           Restart: the old mark names the old row, so the new one is read, claimed when it fills
           and never sent again — account 4, book 4 (7 and 4 when a bare mark hid the key).
  side_p4  the same with a row left behind: the side file's row went into the park file (os.remove
           of the side file refused), filled and was booked; a new +2 is then parked under the same
           key. Restart: the park file's row is the later one, so the side file's old row does not
           replace it — claimed when it fills, account 4, book 4, never sent again.
  stale    the park file takes the save and os.remove of the side file is refused: the row is
           claimed from the park file once (book 2), the side file's copy does not bring it back,
           and the side file is removed the round os.remove works.
  n2 / n2_mem  統一 only (群益 and 永豐 hold a second close back). Short 1; a close of +1 the broker
           did not take is parked in the file; a second close of +1 fills and is reported, the new
           baseline is refused by the file (n2: side file; n2_mem: side file refused too); 16 minutes
           on the claim clears the row and that save is refused as well. The park file's stale row
           (baseline −1) is not booked as a late fill: book 0, account 0 — also after a restart
           (n2) and after the user buys 1 lot by hand: nothing is sent, the lot stays.
  side_claim  the row is in the park file (its save went through); it fills, the claim books it
           and the park file refuses the claim's saves: nothing is written to the side file (the
           park file's row is the current one), the row is settled again each round by its park
           id — booked once — and the third refused round writes the one tw_entry_hold row, as
           before the side file existed.
  side_layers  the three layers, with no broker: two keys refused one after the other are both in
           the side file (the second save does not drop the first); a third with the side file
           refused too is in the process with the other two, and all three are read; the side file
           taking saves again holds all three and the process none; a claim that settles one the
           park file never held drops it with no mark; a side file os.remove refused and another
           process then wrote again is read; a park-file row with no leg cannot be named by a
           mark, so it is read again rather than hidden; a row or a mark left behind beside a row
           the park file took later changes nothing and is not counted as held outside; an entry
           that is neither makes the park unreadable.
  flatten  群益 only: manager/flatten's own reads of the park file see a close row held in the side
           file (the next close waits); a settled mark hides the park file's row it names (the close
           goes) and not a close parked later under the same key (it waits); a side file that does
           not read, or holds anything but rows and marks, holds the close.

Run: cd blave-agent && .venv/bin/python tests/check_tw_park_save_refused.py
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


def sinopac_world(fakes, tmp):
    """永豐 with the gate flipped in this process: the reconciler's block, an account the test
    owns (rows keyed by month code, as the worker snapshot) and an order lib that fills it."""
    sj = types.ModuleType("shioaji")
    sj.__version__ = "1.7.11"
    sys.modules["shioaji"] = sj
    from lib import venue_traits
    venue_traits.TRAITS[venue_traits.SINOPAC].update(hand_wired=True, native_units=True,
                                                     verified_modes=("futures",))
    w = fakes.World(venue_traits.SINOPAC, tmp)
    fakes._pin_session()
    from lib import order_sinopac as osj, sinopac_futures_account as acct_mod, sinopac_vault as vault
    osj.FUTURES_VERIFIED = acct_mod.VERIFIED = True
    vault.LAST_ORDER_PATH = os.path.join(tmp, "state", "sinopac_last_order_at")
    vault.LOGIN_STOPPED_PATH = os.path.join(tmp, "state", "sinopac_login_stopped.json")

    class Acct:
        SnapshotLag = acct_mod.SnapshotLag
        contract_month = staticmethod(acct_mod.contract_month)

        @staticmethod
        def waiting():
            return None

        @staticmethod
        def snapshot_caught_up(snap=None):
            return True, time.time() + 30, 0.0

        @staticmethod
        def position_rows():
            return [{"root": k[:3], "productid": k, "net": v} for k, v in w.rows.items()]

        @classmethod
        def split_position_rows(cls, now=None, book_months=None):
            return cls.position_rows(), [], []

        @classmethod
        def get_positions(cls, env, book_months=None):
            return {r["root"]: {"side": "long" if r["net"] > 0 else "short", "size": float(abs(r["net"])),
                                "productid": r["productid"]} for r in cls.position_rows()}

    def place(env, sym, action, lots, intent, **kw):
        w.sent.append({"contract": "TXFJ6", "side": action, "lots": lots, "intent": intent})
        w.rows["TXFJ6"] = w.rows.get("TXFJ6", 0) + (lots if action == "buy" else -lots)
        w.rows = {k: v for k, v in w.rows.items() if v}
        return {"status": "filled", "symbol": "TXFJ6", "fill_qty": float(lots), "avg_fill_price": 23000.0,
                "ordno": f"O{len(w.sent)}", "broker_status": "Filled"}

    osj.place_futures_market_order = place
    w.acct, w.write_snapshot = Acct, lambda: None
    return w


def child(venue, sid, tmp, phase="1"):
    os.chdir(tmp)
    sys.path.insert(0, SRC)
    sys.path.insert(0, HERE)
    os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = tmp
    import check_capital_ledger_paths as fakes
    real_time = time.time
    time.time = lambda: real_time() + fakes.let_time_pass.skew
    if venue == "sinopac":
        w = sinopac_world(fakes, tmp)
    else:
        w = {"capital": fakes.capital_world, "president": fakes.president_world}[venue](tmp)
    fakes.freeze_clock(w)
    carry = json.load(open("carry.json")) if phase != "1" else None
    if carry:                              # a restart: the workspace's files, none of the process
        os.remove("carry.json")
        w.rows, w.sent, fakes.let_time_pass.skew = carry["rows"], carry["sent"], carry["skew"]
    else:
        w.setup(2)
    from lib import guard, portfolio, president_vault
    from manager import reconciler as rec
    if venue == "sinopac":
        rec = importlib.reload(rec)  # _HAND_WIRED is built at import, from the trait row
        rec._sinopac_acct = lambda: w.acct
    tg = []
    rec.send_telegram = tg.append
    rec._read_env = lambda: {}

    # the broker fills w.fill of the lots; the report that comes back says w.report
    lib = importlib.import_module(f"lib.order_{venue}")
    real_place = lib.place_futures_market_order
    w.fill = w.report = None
    w.stop_during_send = False
    month = {"capital": "TX2610", "president": "TXFJ6", "sinopac": "TXFJ6"}[venue]

    def place(env, sym, action, lots, intent, *a, **kw):
        r = real_place(env, sym, action, lots, intent, *a, **kw)
        if w.stop_during_send:             # the user presses stop while the order is at the broker
            guard.trip_halt("user stop (test)", "user")
        if w.report is None:
            return r
        sign = 1 if action == "buy" else -1
        w.rows[month] = w.rows.get(month, 0) - sign * (lots - w.fill)
        w.rows = {k: v for k, v in w.rows.items() if v}
        r = dict(r, fill_qty=float(w.report), status="filled" if w.report else "sent")
        if venue == "president" and not w.report:
            r["statuscode"] = "0000"
        if venue == "sinopac":
            r["broker_status"] = "Cancelled" if w.report else "Submitted"
        return r
    lib.place_futures_market_order = place

    # "side": the side file is refused with the park file (a full disk); False = it takes the save
    refuse = {"on": False, "side": not sid.startswith(SIDE), "remove": False}
    real_replace = president_vault.replace_json

    def replace_json(path, obj):
        if refuse["on"] and str(path).endswith("_pending_sent.json"):
            raise OSError(28, "No space left on device (fake)")
        if refuse["on"] and refuse["side"] and str(path).endswith(".unsaved"):
            raise OSError(28, "No space left on device (fake)")
        return real_replace(path, obj)
    president_vault.replace_json = replace_json
    real_remove = os.remove

    def remove(path, *a, **kw):
        if refuse["remove"] and str(path).endswith(".unsaved"):
            raise PermissionError(13, "held by another program (fake)")
        return real_remove(path, *a, **kw)
    os.remove = remove

    def errors():
        try:
            return json.load(open("manager/order_errors.json"))
        except (OSError, ValueError):
            return []

    def round_():
        w.write_snapshot()
        before = len(w.sent)
        try:
            portfolio.reconcile(get_positions_fn=rec._get_positions_guarded, place_order_fn=rec.place_order,
                                threshold=rec._symbol_threshold, send_telegram_fn=tg.append)
            outcome = "ok"
        except rec.ReadSkipped as e:
            outcome = f"skipped: {e}"
        except Exception as e:
            outcome = f"error: {type(e).__name__}: {e}"
        led = {k: (1 if v["side"] == "long" else -1) * float(v["size"])
               for k, v in (portfolio.ledger_positions() or {}).items() if float(v["size"])}
        return {"outcome": outcome, "lots": [o["lots"] for o in w.sent[before:]], "broker": w.net(),
                "book": led.get("TXF", 0.0), "halt": guard.halted(),
                "reason": (guard.halt_info() or {}).get("reason") or ""}

    path = {"capital": rec.CAPITAL_PENDING_PATH, "president": rec.PENDING_SENT_PATH,
            "sinopac": rec.SINOPAC_PENDING_PATH}[venue]
    key = "TXFJ6" if venue == "president" else "TXF"
    side = president_vault.park_side(path)
    log, out = (carry["rounds"], carry["out"]) if carry else ([], {})

    def restart():
        """End this process; main() starts the next one on the same workspace."""
        json.dump({"rows": w.rows, "sent": w.sent, "skew": fakes.let_time_pass.skew, "rounds": log, "out": out},
                  open("carry.json", "w"), default=str)
        sys.exit(0)

    def files():
        def load(p):
            try:
                return json.load(open(p))
            except FileNotFoundError:
                return None
            except ValueError:
                return "unreadable"
        return {"park": load(path), "side": load(side)}

    def read():
        try:
            return sorted(rec._pending_sent(path))
        except rec.PendingUnreadable:
            return "unreadable"

    def again(n):
        for _ in range(n):
            guard.clear_halt("test")       # 啟動下單
            rounds(1)
            out.setdefault("again", []).append({"halt": log[-1]["halt"], "reason": log[-1]["reason"],
                                                "on_disk": os.path.exists("state/HALT")})

    def rounds(n, gap=30):
        for _ in range(n):
            fakes.let_time_pass(gap)
            log.append(round_())

    def unsaved():
        return json.loads(json.dumps(rec._park_unsaved, default=str))

    def other_process_writes():
        """flatten (its own process, its own copy of the reconciler) parks a close into the file."""
        row = {"root": "TXF", "lots": -2.0, "reads": [], "months_expected": None, "productid": "TXFJ6",
               "net_expected": 0.0, "from_other_process": True,
               "legs": [{"at": time.time(), "lots": -2.0, "status": "sent", "broker_ack": True, "intent": "reduce"}]}
        json.dump({key: row}, open(path, "w"))
        return bool((rec._pending_sent(path).get(key) or {}).get("from_other_process"))

    if sid in ("sent", "partial"):
        w.signal(1)
        w.fill, w.report = (2, 0) if sid == "sent" else (1, 1)
        refuse["on"] = True
        log.append(round_())               # the send; its park save is refused
        w.report = None
        out["rows_after_send"] = errors()
        out["unsaved_after_send"] = unsaved()
        rounds(2)                          # under HALT
        out["halted"] = dict(log[-1])
        guard.clear_halt("test")           # 啟動下單, the same process
        rounds(3)
        refuse["on"] = False               # the file takes saves again
        rounds(2)
        out["unsaved_at_end"] = unsaved()
        out["sees_other_process_row"] = other_process_writes()
    elif sid == "recover":
        w.signal(1)
        w.fill, w.report = 0, 0            # taken by the broker, not filled yet, no report
        refuse["on"] = True
        log.append(round_())
        w.report = None
        out["unsaved_after_send"] = unsaved()
        refuse["on"] = False               # the file takes saves again, the row still held
        rounds(1)
        out["unsaved_after_save"] = unsaved()
        out["on_disk"] = sorted(json.load(open(path))) if os.path.exists(path) else None
        out["sees_other_process_row"] = other_process_writes()
    elif sid == "refused":
        w.signal(1)
        w.fill, w.report = 0, 0
        refuse["on"] = True
        log.append(round_())
        w.report = None
        rounds(2)
        out["again"] = []
        for _ in range(rec.CLAIM_SAVE_FAILS_MAX + 2):   # 啟動下單 each time, the file still refusing
            guard.clear_halt("test")
            rounds(1)
            out["again"].append({"halt": log[-1]["halt"], "reason": log[-1]["reason"],
                                 "on_disk": os.path.exists("state/HALT")})
        out["unsaved_at_end"] = unsaved()
    elif sid == "reduce":
        w.signal(1)
        log.append(round_())
        rounds(1)
        w.signal(0)
        w.fill, w.report = 2, 0            # the close fills, no report
        refuse["on"] = True
        rounds(1)
        w.report = None
        out["close_round"] = dict(log[-1])
        out["unsaved_after_send"] = unsaved()
        rounds(2)
        guard.clear_halt("test")
        rounds(3)
        refuse["on"] = False
        rounds(2)
        out["unsaved_at_end"] = unsaved()
    elif sid == "halted":
        # the user's stop lands while the order is at the broker; then the save is refused
        w.signal(1)
        w.fill, w.report, w.stop_during_send = 2, 0, True
        refuse["on"] = True
        log.append(round_())
        out["halt_info"] = guard.halt_info()
        out["unsaved_after_send"] = unsaved()
    elif sid == "unreadable":
        w.signal(1)
        log.append(round_())
        rounds(1)
        w.signal(0)
        w.fill, w.report = 0, 0            # the close is taken, not filled yet, no report
        refuse["on"] = True
        rounds(1)
        w.report = None
        out["unsaved_after_send"] = unsaved()
        with open(path, "w") as f:         # the file is there and cannot be read
            f.write("{not json")
        out["again"] = []
        for _ in range(2):
            guard.clear_halt("test")       # 啟動下單
            rounds(1)
            out["again"].append({"halt": log[-1]["halt"], "reason": log[-1]["reason"],
                                 "on_disk": os.path.exists("state/HALT")})
        out["unsaved_at_end"] = unsaved()
    elif sid == "merge":
        # the same key in the file and in the process: the process's row is the newer one
        w.setup(4)
        w.signal(0.5)
        log.append(round_())               # holds 2
        rounds(1)
        w.signal(1)
        w.fill, w.report = 0, 0            # +2 taken by the broker, queued, no report: parked, saved
        rounds(1)
        w.report = None
        w.signal(0.25)
        refuse["on"] = True
        rounds(1)                          # a close of 1 fills: the row's baseline moves, unsaved
        out["read"], out["disk"] = rec._pending_sent(path).get(key), json.load(open(path)).get(key)
        w.rows[month] = w.rows.get(month, 0) + 2   # the queued +2 fills
        rounds(1)
        out["unsaved_at_end"] = unsaved()
    elif sid == "unreadable_entry":
        with open(path, "w") as f:         # the file is there and cannot be read; nothing held in the process
            f.write("{not json")
        w.signal(1)
        log.append(round_())
        rounds(1)
        out["unsaved_at_end"] = unsaved()
    elif sid in ("side_restart", "side_queued", "side_reduce", "side_corrupt"):
        if phase == "1":
            w.signal(1)
            if sid == "side_reduce":
                log.append(round_())
                rounds(1)
                w.signal(0)
            w.fill, w.report = (0, 0) if sid == "side_queued" else (2, 0)
            refuse["on"] = True
            rounds(1)                      # the send; the park file refuses, the side file takes the row
            out["send_round"] = dict(log[-1])
            out["after_send"] = dict(files(), unsaved=unsaved())
            if sid == "side_corrupt":
                with open(side, "w") as f:
                    f.write("{not json")
            restart()
        refuse["on"] = True                # the park file still refuses in the new process
        out["unsaved_after_restart"], out["read_after_restart"] = unsaved(), read()
        if sid in ("side_queued", "side_corrupt"):
            again(2)
        else:
            guard.clear_halt("test")       # 啟動下單 before the new process ran a round
            rounds(3)
            out["refusing"] = dict(log[-1])
            refuse["on"] = False
            rounds(2)
        out["at_end"] = dict(files(), unsaved=unsaved())
    elif sid == "side_recover":
        w.signal(1)
        w.fill, w.report = 0, 0
        refuse["on"] = True
        log.append(round_())
        w.report = None
        out["after_send"] = dict(files(), unsaved=unsaved())
        refuse["on"] = False
        rounds(1)
        out["at_end"] = dict(files(), unsaved=unsaved())
        out["sees_other_process_row"] = other_process_writes()
    elif sid == "side_tomb":
        if phase == "1":
            w.setup(4)
            w.signal(0.5)
            log.append(round_())           # holds 2
            rounds(1)
            w.signal(1)
            w.fill, w.report = 0, 0        # +2 taken by the broker, never filled: parked, saved
            rounds(1)
            w.report = None
            w.signal(0.25)
            refuse["on"] = True
            rounds(1)                      # a close of 1 fills: the row's new baseline goes to the side file
            out["after_close"] = dict(files(), unsaved=unsaved())
            rounds(1, gap=rec.QUEUED_HOLD_S + 60)   # account unchanged past the hold: the claim clears the row
            rounds(2)
            out["cleared"] = dict(files(), read=read(), unsaved=unsaved())
            restart()
        refuse["on"] = True
        rounds(2)
        out["restarted"] = dict(files(), read=read())
        refuse["on"] = False
        rounds(1)
        out["at_end"] = dict(files(), read=read(), unsaved=unsaved())
    elif sid == "side_p1":
        if phase == "1":
            w.setup(4)
            w.signal(0.5)
            log.append(round_())           # holds 2
            rounds(1)
            w.signal(1)
            w.fill, w.report = 0, 0        # +2 taken, never filled: parked, saved
            rounds(1)
            w.report = None
            w.signal(0.25)
            refuse["on"] = True
            rounds(1)                      # a close of 1 fills: the new baseline goes to the side file
            rounds(1, gap=rec.QUEUED_HOLD_S + 60)   # cleared as not filled: a settled mark in the side file
            rounds(2)
            out["cleared"] = dict(files(), read=read())
            refuse["on"], refuse["remove"] = False, True
            rounds(1)                      # the park file is emptied; the side file cannot be removed
            out["flushed"] = dict(files(), read=read())
            guard.clear_halt("test")
            w.signal(1)
            w.fill, w.report = 0, 0        # +3 taken, not filled yet: parked in the park file
            rounds(1)
            w.report = None
            out["parked_new"] = dict(files(), read=read(), round=dict(log[-1]))
            restart()
        w.rows[month] = w.rows.get(month, 0) + 3   # the +3 fills at the broker
        out["restarted"] = dict(files(), read=read())
        guard.clear_halt("test")
        rounds(3)
        out["at_end"] = dict(files(), read=read(), round=dict(log[-1]))
    elif sid == "side_p4":
        if phase == "1":
            w.setup(4)
            w.signal(0.5)
            w.fill, w.report = 0, 0        # +2 taken, not filled yet: the park file refuses, side file
            refuse["on"] = True
            log.append(round_())
            w.report = None
            refuse["on"], refuse["remove"] = False, True
            rounds(1)                      # the park file takes the row; the side file cannot be removed
            guard.clear_halt("test")
            w.rows[month] = w.rows.get(month, 0) + 2   # it fills: booked, the park file emptied
            rounds(2)
            out["booked"] = dict(files(), read=read(), round=dict(log[-1]))
            w.signal(1)
            w.fill, w.report = 0, 0        # a new +2 taken unreported, parked under the same key
            rounds(1)
            w.report = None
            out["parked_new"] = dict(files(), read=read(), round=dict(log[-1]))
            restart()
        w.rows[month] = w.rows.get(month, 0) + 2   # the new +2 fills
        row = rec._pending_sent(path).get(key) or {}
        out["restarted"] = dict(files(), read=read(), read_first_sent=(row.get("legs") or [{}])[0].get("at"))
        guard.clear_halt("test")
        rounds(3)
        out["at_end"] = dict(files(), read=read(), round=dict(log[-1]))
    elif sid == "side_stale":
        w.signal(1)
        w.fill, w.report = 0, 0            # taken, not filled yet
        refuse["on"] = True
        log.append(round_())
        w.report = None
        refuse["on"], refuse["remove"] = False, True
        rounds(1)                          # the park file takes the row; the side file cannot be removed
        out["saved"] = dict(files(), read=read())
        guard.clear_halt("test")
        w.rows[month] = w.rows.get(month, 0) + 2   # the +2 fills
        rounds(3)
        out["claimed"] = dict(files(), read=read(), round=dict(log[-1]))
        refuse["remove"] = False
        rounds(1)
        out["at_end"] = dict(files(), read=read(), unsaved=unsaved())
    elif sid in ("side_n2", "n2_mem"):
        if phase == "1":
            w.signal(-0.5)
            log.append(round_())           # short 1
            rounds(1)
            w.signal(0)
            w.fill, w.report = 0, 0        # the close of +1 is not taken, no report: parked, saved
            rounds(1)
            w.report = None
            out["parked"] = files()
            refuse["on"] = True
            rounds(1)                      # the second close of +1 fills, reported: the baseline moves, refused
            out["second_close"] = dict(files(), unsaved=unsaved(), round=dict(log[-1]))
            rounds(1, gap=rec.QUEUED_HOLD_S + 60)   # the row is cleared as not filled; that save is refused too
            rounds(2)
            out["cleared"] = dict(files(), read=read(), unsaved=unsaved(), round=dict(log[-1]))
            if sid == "side_n2":
                restart()
        refuse["on"] = True
        rounds(2)
        out["later"] = dict(log[-1])
        w.rows[month] = w.rows.get(month, 0) + 1   # the user buys 1 lot of the same month by hand
        n = len(w.sent)
        again(2)
        out["after_hand_buy"] = {"sent": w.sent[n:], "round": dict(log[-1])}
    elif sid == "side_claim":
        w.signal(1)
        w.fill, w.report = 0, 0            # taken, not filled yet: parked, the save goes through
        log.append(round_())
        w.report = None
        w.rows[month] = w.rows.get(month, 0) + 2   # it fills
        refuse["on"] = True
        out["hold_rows"] = []
        for _ in range(rec.CLAIM_SAVE_FAILS_MAX):
            rounds(1)
            out["hold_rows"].append(len([e for e in errors() if "存不進紀錄" in str(e.get("error"))]))
        out["refusing"] = dict(files(), unsaved=unsaved(), round=dict(log[-1]))
        refuse["on"] = False
        rounds(1)
        out["at_end"] = dict(files(), unsaved=unsaved())
    elif sid == "side_layers":
        save = {"capital": rec._save_capital_pending, "president": rec._save_pending_sent,
                "sinopac": rec._save_sinopac_pending}[venue]

        def park(k):
            p = rec._pending_sent(path)
            p[k] = {"root": k[:3], "lots": 1.0, "legs": []}
            return rec._park_saved(save, path, p, k, venue, k)
        refuse["on"] = True
        out["saved"] = [park("A"), park("B")]
        out["two"] = dict(files(), unsaved=unsaved())
        refuse["side"] = True
        park("C")
        out["three"] = dict(files(), unsaved=unsaved(), read=read())
        refuse["side"] = False
        p = rec._pending_sent(path)
        del p["A"]                         # a claim settles A
        rec._save_claimed(p, venue, path=path, save=save)
        out["settled"] = dict(files(), unsaved=unsaved(), read=read())
        refuse["on"], refuse["remove"] = False, True
        save(rec._pending_sent(path))      # the park file takes all; the side file cannot be removed
        out["stale"] = dict(files(), read=read())
        time.sleep(0.01)
        json.dump({"D": {"root": "D", "lots": 1.0, "legs": [], "from_other_process": True}}, open(side, "w"))
        out["rewritten"] = read()
        # a park-file row with no leg has no send time to name it by: settled outside, it gets no mark
        refuse["remove"] = False
        json.dump({"E": {"root": "E", "lots": 1.0, "legs": []}}, open(path, "w"))
        json.dump({"E": {"root": "E", "lots": 1.0, "legs": [], "newer": True}}, open(side, "w"))
        refuse["on"] = True
        p = rec._pending_sent(path)
        del p["E"]
        rec._save_claimed(p, venue, path=path, save=save)
        out["legless"] = dict(files(), read=read())
        # entries a side file left behind may carry, beside a row the park file took later
        def krow(at):
            return {"root": "K", "lots": 1.0, "legs": [{"at": at, "lots": 1.0}]}
        json.dump({"K": krow(200.0)}, open(path, "w"))
        json.dump({"K": krow(100.0)}, open(side, "w"))
        p = rec._pending_sent(path)
        out["left_row"] = {"first_sent": p["K"]["legs"][0]["at"], "held": sorted(p.held)}
        json.dump({"K": {"settled": 100.0}}, open(side, "w"))
        out["left_mark"] = {"read": read(), "outside": sorted(rec._rows_outside(path)),
                            "counts_as_held": rec._unsaved_unreadable(path, venue, "park file unreadable (test)")}
        json.dump({"K": None}, open(side, "w"))
        out["unknown_entry"] = read()
    elif sid == "side_flatten":
        sys.path.insert(0, os.path.join(SRC, "manager"))
        cwd = os.getcwd()
        import flatten                     # chdir's to its own tree at import
        os.chdir(cwd)
        flatten.CAPITAL_PENDING_PATH = path
        leg = {"at": time.time(), "lots": -2.0, "status": "sent", "broker_ack": True, "intent": "reduce"}
        row = {"root": "TXF", "lots": -2.0, "reads": [], "months_expected": {"TX2610": 2.0}, "legs": [leg]}
        os.makedirs("state", exist_ok=True)
        got = {}
        json.dump({key: row}, open(side, "w"))
        got["row_in_side"] = flatten._capital_close_queued(key)
        got["parked_in_side"] = key in flatten._capital_parked()
        json.dump({key: row}, open(path, "w"))
        json.dump({key: president_vault.park_settled(row)}, open(side, "w"))
        got["none_over_park"] = flatten._capital_close_queued(key)
        got["none_parked"] = key in flatten._capital_parked()
        json.dump({key: {"settled": leg["at"] - 500}}, open(side, "w"))   # left behind by an earlier row
        got["old_mark"] = flatten._capital_close_queued(key)
        json.dump({key: None}, open(side, "w"))
        got["unknown_entry"] = flatten._capital_close_queued(key)
        with open(side, "w") as f:
            f.write("{not json")
        got["side_unreadable"] = flatten._capital_close_queued(key)
        os.remove(side)
        got["park_alone"] = flatten._capital_close_queued(key)
        out["flatten"] = got
    out["errors"] = errors()
    json.dump({"rounds": log, "out": out, "path": path, "key": key, "telegram": tg},
              open("result.json", "w"), indent=1, default=str)


FREEZE = "自動下單已全部暫停，平倉與停損也不會送"


def is_mark(v):
    return isinstance(v, dict) and set(v) == {"settled"}


def told(reason):
    return ("TXF" in reason and FREEZE in reason and "「啟動下單」" in reason and "Errno" not in reason
            and "pending_sent" not in reason)


def verdict(sid, r):
    rounds, out, path, key = r["rounds"], r["out"], r["path"], r["key"]
    sent = [n for x in rounds for n in x["lots"]]
    brokers, books = [x["broker"] for x in rounds], [x["book"] for x in rounds]
    held = key in (out.get("unsaved_after_send") or {}).get(path, {})
    why = f"sends={sent}, broker per round={brokers}, book per round={books}"
    if sid in ("sent", "partial"):
        first, halted, last = rounds[0], out["halted"], rounds[-1]
        rows = out["rows_after_send"]
        raw = [e for e in rows if "Errno" in str(e.get("error")) or "No space" in str(e.get("error"))]
        ok = (first["lots"] == [2] and first["halt"] and halted["halt"] and told(first["reason"]) and held
              and not rows and not [n for x in rounds[1:3] for n in x["lots"]]
              and first["book"] == (0 if sid == "sent" else 1)
              and sent == ([2] if sid == "sent" else [2, 1])
              and last["broker"] == 2 and last["book"] == 2 and not last["halt"] and max(brokers) == 2
              and out["unsaved_at_end"] == {} and out["sees_other_process_row"])
        return ok, (f"{why}, halt after the send={first['halt']} reason={first['reason']!r}, order_errors rows "
                    f"after the send={len(rows)} (carrying the OSError: {len(raw)}), held in the process={held}, "
                    f"left in memory at the end={out['unsaved_at_end']}, another process's row read="
                    f"{out['sees_other_process_row']}")
    if sid == "recover":
        ok = (sent == [2] and held and rounds[0]["halt"] and out["unsaved_after_save"] == {}
              and out["on_disk"] == [key] and out["sees_other_process_row"])
        return ok, (f"{why}, held in the process after the send={held}, in memory after the save went through="
                    f"{out['unsaved_after_save']}, on disk={out['on_disk']}, another process's row read="
                    f"{out['sees_other_process_row']}")
    if sid == "refused":
        restart_rows = [e for e in out["errors"] if "重新開啟" in str(e.get("error"))]
        again = out["again"]
        ok = (sent == [2] and max(brokers) == 0 and not restart_rows and not out["errors"]
              and all(a["halt"] and a["on_disk"] and told(a["reason"]) for a in again)
              and key in out["unsaved_at_end"].get(path, {}))
        return ok, (f"{why}, halted again after each 啟動下單={[a['halt'] for a in again]}, rows telling the user "
                    f"to reopen Blave={len(restart_rows)}, order_errors rows={len(out['errors'])}, still held in "
                    f"the process={out['unsaved_at_end']}")
    if sid == "reduce":
        close, last = out["close_round"], rounds[-1]
        ok = (sent == [2, 2] and close["lots"] == [2] and close["halt"] and told(close["reason"]) and held
              and min(brokers) == 0 and last["broker"] == 0 and last["book"] == 0 and not last["halt"]
              and not out["errors"] and out["unsaved_at_end"] == {})
        return ok, (f"{why}, halt after the close={close['halt']} reason={close['reason']!r}, held in the process="
                    f"{held}, order_errors rows={len(out['errors'])}, left in memory={out['unsaved_at_end']}")
    if sid == "unreadable":
        restart_rows = [e for e in out["errors"] if "重新開啟" in str(e.get("error"))]
        again = out["again"]
        ok = (sent == [2, 2] and held and not restart_rows
              and all(a["halt"] and a["on_disk"] and told(a["reason"]) for a in again)
              and key in out["unsaved_at_end"].get(path, {}))
        return ok, (f"{why}, halted again after each 啟動下單={[a['halt'] for a in again]}, rows telling the user "
                    f"to reopen Blave={len(restart_rows)}, held in the process after the close={held}, at the end="
                    f"{sorted(out['unsaved_at_end'].get(path, {}))}")
    if sid == "merge":
        def baseline(row):
            row = row or {}
            return row.get("net_expected") if "net_expected" in row else sum((row.get("months_expected") or {}).values())
        last = rounds[-1]
        ok = (sent == [2, 2, 1] and baseline(out["disk"]) == 2 and baseline(out["read"]) == 1
              and last["broker"] == 3 and last["book"] == 3)
        return ok, (f"{why}, baseline in the file={baseline(out['disk'])}, baseline read={baseline(out['read'])}, "
                    f"left in memory={out['unsaved_at_end']}")
    if sid == "unreadable_entry":
        hold = [e for e in out["errors"] if e.get("kind") == "tw_entry_hold"]
        ok = (sent == [] and not any(x["halt"] for x in rounds) and len(hold) == 1 and max(brokers) == 0
              and out["unsaved_at_end"] == {})
        return ok, f"{why}, halt per round={[x['halt'] for x in rounds]}, tw_entry_hold rows={len(hold)}"
    if sid in ("side_restart", "side_reduce"):
        entry = sid == "side_restart"
        send, a, last, end = out["send_round"], out["after_send"], rounds[-1], out["at_end"]
        ok = (sent == ([2] if entry else [2, 2]) and send["halt"] and told(send["reason"])
              and key in (a["side"] or {}) and key not in (a["park"] or {}) and a["unsaved"] == {}
              and out["unsaved_after_restart"] == {} and out["read_after_restart"] == [key]
              and (max(brokers) == 2 if entry else min(brokers) == 0)
              and out["refusing"]["book"] == (2 if entry else 0) and not out["refusing"]["halt"]
              and last["broker"] == last["book"] == (2 if entry else 0) and not last["halt"]
              and end == {"park": None, "side": None, "unsaved": {}} and not out["errors"])
        return ok, (f"{why}, after the send: side file={sorted(a['side'] or {})} park file={a['park']} in the "
                    f"process={a['unsaved']}; read by the new process={out['read_after_restart']}; at the end "
                    f"{end}, order_errors rows={len(out['errors'])}")
    if sid in ("side_queued", "side_corrupt"):
        a, again = out["after_send"], out["again"]
        restart_rows = [e for e in out["errors"] if "重新開啟" in str(e.get("error"))]
        ok = (sent == [2] and key in (a["side"] or {}) and a["unsaved"] == {}
              and out["read_after_restart"] == ([key] if sid == "side_queued" else "unreadable")
              and all(x["halt"] and x["on_disk"] and told(x["reason"]) for x in again) and len(again) == 2
              and max(brokers) == (0 if sid == "side_queued" else 2) and not restart_rows
              and out["at_end"]["park"] is None)
        return ok, (f"{why}, side file after the send={sorted(a['side'] or {})}, read by the new process="
                    f"{out['read_after_restart']}, halted again after each 啟動下單={[x['halt'] for x in again]}, "
                    f"rows telling the user to reopen Blave={len(restart_rows)}")
    if sid == "side_recover":
        a, end = out["after_send"], out["at_end"]
        ok = (sent == [2] and rounds[0]["halt"] and key in (a["side"] or {}) and a["park"] is None
              and a["unsaved"] == {} and sorted(end["park"] or {}) == [key] and end["side"] is None
              and end["unsaved"] == {} and out["sees_other_process_row"])
        return ok, (f"{why}, after the send: side file={sorted(a['side'] or {})} park file={a['park']}; after the "
                    f"park file took a save: park file={sorted(end['park'] or {})} side file={end['side']}, another "
                    f"process's row read={out['sees_other_process_row']}")
    if sid == "side_tomb":
        c, r, end = out["cleared"], out["restarted"], out["at_end"]
        unexplained = [x for x in rounds if "對不上" in x["reason"] or "explain" in x["reason"]]
        ok = (sent == [2, 2, 1] and key in (out["after_close"]["side"] or {})
              and key in (c["park"] or {}) and list(c["side"] or {}) == [key] and is_mark(c["side"][key])
              and c["side"][key]["settled"] == c["park"][key]["legs"][0]["at"]
              and c["read"] == [] and c["unsaved"] == {}
              and key in (r["park"] or {}) and r["read"] == [] and not unexplained
              and rounds[-1]["broker"] == 1 and rounds[-1]["book"] == 1
              and end == {"park": {}, "side": None, "read": [], "unsaved": {}})
        return ok, (f"{why}, after the claim cleared the row: park file={sorted(c['park'] or {})} (stale) side file="
                    f"{c['side']} read={c['read']}; after the restart read={r['read']}; rounds halted on an "
                    f"unexplained account={len(unexplained)}; at the end {end}")
    if sid == "side_p1":
        c, f, n, r, end = out["cleared"], out["flushed"], out["parked_new"], out["restarted"], out["at_end"]
        ok = (sent == [2, 2, 1, 3] and is_mark((c["side"] or {}).get(key))
              and f["park"] == {} and is_mark((f["side"] or {}).get(key)) and f["read"] == []
              and sorted(n["park"] or {}) == [key] and is_mark((n["side"] or {}).get(key)) and n["read"] == [key]
              and n["round"]["lots"] == [3]
              and r["read"] == [key] and is_mark((r["side"] or {}).get(key))
              and end["round"]["broker"] == 4 and end["round"]["book"] == 4 and max(brokers) == 4
              and end["park"] == {} and end["side"] is None and end["read"] == [])
        return ok, (f"{why}, park file emptied with the mark left behind={f['side']}; the new +3 parked: park file="
                    f"{sorted(n['park'] or {})} read={n['read']}; read by the new process={r['read']} (side file "
                    f"{r['side']}); at the end park file={end['park']} side file={end['side']}")
    if sid == "side_p4":
        b, n, r, end = out["booked"], out["parked_new"], out["restarted"], out["at_end"]
        first = lambda rows: (((rows or {}).get(key) or {}).get("legs") or [{}])[0].get("at")  # noqa: E731
        ok = (sent == [2, 2] and b["park"] == {} and key in (b["side"] or {}) and b["round"]["book"] == 2
              and sorted(n["park"] or {}) == [key] and key in (n["side"] or {}) and n["round"]["lots"] == [2]
              and first(n["park"]) > first(n["side"])
              and r["read"] == [key] and r["read_first_sent"] == first(n["park"])
              and end["round"]["broker"] == 4 and end["round"]["book"] == 4 and max(brokers) == 4
              and end["park"] == {} and end["side"] is None)
        return ok, (f"{why}, the old row booked: park file={b['park']} side file left={sorted(b['side'] or {})}; "
                    f"new row parked: park file first send={first(n['park'])} side file's={first(n['side'])}; the new "
                    f"process reads the row sent at {r['read_first_sent']}; at the end park file={end['park']} side "
                    f"file={end['side']}")
    if sid == "side_stale":
        sv, c, end = out["saved"], out["claimed"], out["at_end"]
        ok = (sent == [2] and sorted(sv["park"] or {}) == [key] and key in (sv["side"] or {}) and sv["read"] == [key]
              and c["park"] == {} and key in (c["side"] or {}) and c["read"] == []
              and c["round"]["book"] == 2 and c["round"]["broker"] == 2 and not c["round"]["halt"]
              and end == {"park": {}, "side": None, "read": [], "unsaved": {}} and max(books) == 2)
        return ok, (f"{why}, park file took the row with the side file left={sorted(sv['side'] or {})}; after the "
                    f"claim: park file={c['park']} side file still there={sorted(c['side'] or {})} read={c['read']}; "
                    f"at the end {end}")
    if sid in ("side_n2", "n2_mem"):
        s2, c, hb = out["second_close"], out["cleared"], out["after_hand_buy"]
        outside = (s2["side"] or {}) if sid == "side_n2" else s2["unsaved"].get(path, {})
        marked = (c["side"] or {}) if sid == "side_n2" else c["unsaved"].get(path, {})
        ok = ([abs(n) for n in sent] == [1, 1, 1] and key in (out["parked"]["park"] or {})
              and (outside.get(key) or {}).get("net_expected") == 0 and s2["round"]["book"] == 0
              and key in (c["park"] or {}) and is_mark(marked.get(key)) and c["read"] == []
              and all(x["book"] == 0 for x in rounds[3:]) and out["later"]["broker"] == 0
              and hb["sent"] == [] and hb["round"]["broker"] == 1 and hb["round"]["book"] == 0)
        return ok, (f"{why}, baseline held outside the park file after the second close="
                    f"{(outside.get(key) or {}).get('net_expected')}, after the claim cleared the row: park file="
                    f"{sorted(c['park'] or {})} (stale) marked settled={is_mark(marked.get(key))} read="
                    f"{c['read']}; after the user's own buy: sent={hb['sent']} account={hb['round']['broker']} book="
                    f"{hb['round']['book']}")
    if sid == "side_claim":
        r, end = out["refusing"], out["at_end"]
        ok = (sent == [2] and out["hold_rows"] == [0] * (len(out["hold_rows"]) - 1) + [1] and len(out["hold_rows"]) == 3
              and r["side"] is None and r["unsaved"] == {} and key in (r["park"] or {})
              and max(books) == 2 and r["round"]["book"] == 2 and not any(x["halt"] for x in rounds)
              and end == {"park": {}, "side": None, "unsaved": {}})
        return ok, (f"{why}, tw_entry_hold rows after each refused round={out['hold_rows']}, while refusing: side file="
                    f"{r['side']} in the process={r['unsaved']} park file={sorted(r['park'] or {})}; at the end {end}")
    if sid == "side_layers":
        two, three, st, stale = out["two"], out["three"], out["settled"], out["stale"]
        ok = (out["saved"] == [False, False] and sorted(two["side"] or {}) == ["A", "B"] and two["park"] is None
              and two["unsaved"] == {} and sorted(three["unsaved"].get(path, {})) == ["A", "B", "C"]
              and three["read"] == ["A", "B", "C"]
              and sorted(st["side"] or {}) == ["B", "C"]
              and st["unsaved"] == {} and st["read"] == ["B", "C"]
              and sorted(stale["park"] or {}) == ["B", "C"] and stale["side"] is not None
              and stale["read"] == ["B", "C"] and out["rewritten"] == ["B", "C", "D"]
              and out["legless"]["side"] is None and out["legless"]["read"] == ["E"]
              and out["left_row"] == {"first_sent": 200.0, "held": []}
              and out["left_mark"] == {"read": ["K"], "outside": [], "counts_as_held": False}
              and out["unknown_entry"] == "unreadable")
        return ok, (f"two refused saves: side file={sorted(two['side'] or {})}; the third with the side file refused: "
                    f"in the process={sorted(three['unsaved'].get(path, {}))} read={three['read']}; A settled, side "
                    f"file taking saves: {sorted(st['side'] or {})} in the "
                    f"process={st['unsaved']} read={st['read']}; park file saved, side file not removed: read="
                    f"{stale['read']}; written again by another process: read={out['rewritten']}")
    if sid == "side_flatten":
        g = out["flatten"]
        ok = (g["row_in_side"][0] is True and g["row_in_side"][1] and g["parked_in_side"] is True
              and g["none_over_park"] == [False, None] and g["none_parked"] is False
              and g["old_mark"][0] is True and g["old_mark"][1] and g["unknown_entry"] == [True, None] and g["side_unreadable"] == [True, None]
              and g["park_alone"][0] is True and g["park_alone"][1])
        return ok, f"flatten's read: {g}"
    info = out["halt_info"] or {}
    ok = (info.get("reason") == "user stop (test)" and info.get("source") == "user" and held and sent == [2])
    return ok, f"{why}, HALT after the refused save={info}, held in the process={held}"


SIDE = "side_"
SCENARIOS = ("sent", "partial", "recover", "refused", "reduce", "halted", "unreadable", "merge",
             "unreadable_entry", "side_restart", "side_queued", "side_reduce", "side_recover", "side_corrupt",
             "side_tomb", "side_p1", "side_p4", "side_stale", "side_claim", "side_layers")
ONLY = {"president": ("side_n2", "n2_mem"), "capital": ("side_flatten",)}


def main():
    failed = []
    for venue in ("capital", "president", "sinopac"):
        for sid in SCENARIOS + ONLY.get(venue, ()):
            tmp = tempfile.mkdtemp(prefix=f"parksave-{venue}-{sid}-")
            try:
                for phase in "12":         # a scenario that restarts leaves carry.json for its second process
                    p = subprocess.run([sys.executable, __file__, "--child", venue, sid, tmp, phase],
                                       capture_output=True, text=True, timeout=180)
                    if not os.path.exists(os.path.join(tmp, "carry.json")):
                        break
                try:
                    ok, why = verdict(sid, json.load(open(os.path.join(tmp, "result.json"))))
                except (OSError, ValueError):
                    ok, why = False, "child crashed:\n" + p.stderr[-3000:]
            finally:
                shutil.rmtree(tmp, ignore_errors=True)
            print(f"{'ok' if ok else 'FAIL':<5} {venue}:{sid}: {why}")
            if not ok:
                failed.append(f"{venue}:{sid}")
    print("all pass" if not failed else f"FAILED: {', '.join(failed)}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--child":
        child(*sys.argv[2:6])
    else:
        main()
