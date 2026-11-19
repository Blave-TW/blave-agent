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
The save is refused where every park save ends (lib.president_vault.replace_json).

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


def child(venue, sid, tmp):
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

    refuse = {"on": False}
    real_replace = president_vault.replace_json

    def replace_json(path, obj):
        if refuse["on"] and str(path).endswith("_pending_sent.json"):
            raise OSError(28, "No space left on device (fake)")
        return real_replace(path, obj)
    president_vault.replace_json = replace_json

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
    log, out = [], {}

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
    out["errors"] = errors()
    json.dump({"rounds": log, "out": out, "path": path, "key": key, "telegram": tg},
              open("result.json", "w"), indent=1, default=str)


FREEZE = "自動下單已全部暫停，平倉與停損也不會送"


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
    info = out["halt_info"] or {}
    ok = (info.get("reason") == "user stop (test)" and info.get("source") == "user" and held and sent == [2])
    return ok, f"{why}, HALT after the refused save={info}, held in the process={held}"


SCENARIOS = ("sent", "partial", "recover", "refused", "reduce", "halted", "unreadable", "merge",
             "unreadable_entry")


def main():
    failed = []
    for venue in ("capital", "president", "sinopac"):
        for sid in SCENARIOS:
            tmp = tempfile.mkdtemp(prefix=f"parksave-{venue}-{sid}-")
            try:
                p = subprocess.run([sys.executable, __file__, "--child", venue, sid, tmp],
                                   capture_output=True, text=True, timeout=180)
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
        child(*sys.argv[2:5])
    else:
        main()
