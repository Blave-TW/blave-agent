"""Minimal check: 群益 OnNewData fill rows are matched to the order by the seq's VALUE, not by a
fixed column. 10-27/10-28 desktop runs (SKCOM 2.13.59) got no fill report for orders that did
fill; the 8/14-8/17 passes were on 2.13.58, where the seq was pinned at idx45. The 2.13.59 manual
puts SeqNo at idx47 (Timefff appended after it). Feeds raw rows of both layouts through the REAL
_Events.OnNewData and one full place_futures_market_order — no Windows, no COM, no network.

Run: cd blave-agent && python3 tests/check_capital_report_rows.py
"""
import os
import sys
import tempfile
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(tempfile.mkdtemp(prefix="capital-rows-", dir=os.environ.get("SCRATCHPAD") or None))
os.makedirs("state", exist_ok=True)

import lib.order_capital as oc
oc.capital_vault.LAST_ORDER_PATH = os.path.abspath("state/capital_last_order_at")  # not the repo's state/

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


def row(n, seq_at, seq, typ="D", market="TF", qty="1", msg_no="2120000001", key0=""):
    f = [""] * n
    f[0], f[1], f[2], f[3] = key0, market, typ, "N"
    f[8], f[11], f[20], f[30], f[38] = "TM2611", "23456.0000", qty, msg_no, "E0001"
    if seq_at is not None:
        f[seq_at] = seq
    return ",".join(f)


SEQ = "2315619889322"

ev = oc._Events()
ev.OnNewData("u", row(47, 45, SEQ))
check(len(ev.fills.get(SEQ, [])) == 1, "2.13.58 layout (47 fields, seq at idx45): fill found")

ev = oc._Events()
ev.OnNewData("u", row(50, 47, SEQ))
check(len(ev.fills.get(SEQ, [])) == 1 and ev.fills[SEQ][0]["symbol"] == "TM2611",
      "2.13.59 manual layout (50 fields, idx45 empty, seq at idx47): fill found")

ev = oc._Events()
ev.OnNewData("u", row(47, 45, SEQ, market="TS", key0=SEQ))
check(len(ev.fills.get(SEQ, [])) == 1, "stock row carrying the seq at idx0 and idx45: one fill, not two")

ev = oc._Events()
ev.OnNewData("u", row(50, 47, SEQ))
ev.OnNewData("u", row(50, 47, SEQ))
check(len(ev.fills[SEQ]) == 1, "the same row twice (replay / duplicated TS): counted once")
ev.OnNewData("u", row(50, 47, SEQ, msg_no="2120000002"))
check(len(ev.fills[SEQ]) == 2, "a second fill row of the same order (other exchange seq): counted")

ev = oc._Events()
ev.OnNewData("u", row(50, None, SEQ))
ev.OnNewData("u", row(50, 47, SEQ, typ="N"))
ev.OnNewData("u", row(40, 39, SEQ))
check(not ev.fills and ev.d_no_seq == 1 and ev.short_rows == 1 and ev.rows == 3,
      f"no 13-digit seq / order row / short row: nothing booked, each counted ({ev.diag()})")

ev = oc._Events()
bad = row(50, 47, SEQ).split(",")
bad[8] = "F0200001234567"
ev.OnNewData("u", ",".join(bad))
ev.OnNewData("u", row(50, 47, SEQ, qty="", msg_no="2120000003"))
check(not ev.fills and ev.d_unfit == 2,
      "TF fill row whose contract column is not a contract, or with no qty: not booked (left for the park)")

ev = oc._Events()
ev.OnSolaceReplyConnection("u", 0)
ev.OnSolaceReplyDisconnect("u", 3021)
check("solace=disconnect:3021" in ev.diag(), "a dropped reply link shows in the 'sent' log")
ev = oc._Events()
ev.OnComplete("u")
ev.OnSolaceReplyDisconnect("u", 3021)
check("complete=False" in ev.diag(), "a link that dropped after OnComplete is not shown as complete")

# full order path on the 2.13.59 layout: the real _Events behind a fake SKCOM
clk = types.SimpleNamespace(t=0.0)
oc.time = types.SimpleNamespace(time=lambda: clk.t, sleep=lambda s: setattr(clk, "t", clk.t + s))
pending = []


class Pump:
    @staticmethod
    def PumpWaitingMessages():
        for at, data in list(pending):
            if at <= clk.t:
                Sess.events.OnNewData("u", data)
                pending.remove((at, data))


class Sess:
    futures_account = "F0"
    login_id = "A1"
    events = oc._Events()

    class order:
        @staticmethod
        def SendFutureOrderCLR(_login, _async, p):
            pending.append((clk.t + 20, row(50, 47, SEQ)))
            return SEQ, 0


oc.pythoncom = Pump
oc.sk = types.SimpleNamespace(FUTUREORDER=type("O", (), {}))
oc._get_session = lambda env: Sess
oc._request_snapshot_refresh = lambda: None
r = oc.place_futures_market_order({}, "TM0000", "buy", 1, intent="entry")
check(r["status"] == "filled" and r["fill_qty"] == 1 and r["symbol"] == "TM2611",
      f"place_futures_market_order with a 2.13.59 row at 20 s: filled TM2611 x1 ({r['status']}, {r['fill_qty']})")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
