"""群益 login waits briefly for the reply link, then sends anyway — no Windows, no broker.

A fresh login sent its first order about 1 s after SKReplyLib_ConnectByID returned 0 (10-27
win-test-5) and no fill report ever came. _new_session now pumps up to REPLY_READY_S for
OnComplete and only logs when it does not arrive (log-only until a live run shows it always
fires). Runs the REAL _new_session against fake SKCOM objects with a virtual clock.

Run: cd blave-agent && python3 tests/check_capital_reply_ready.py
"""
import logging
import os
import sys
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import lib.order_capital as oc  # noqa: E402

fails = 0


def check(cond, msg, detail=None):
    global fails
    print(("ok   " if cond else "FAIL ") + msg + ("" if cond or detail is None else f"  ({detail})"))
    fails += 0 if cond else 1


clk = types.SimpleNamespace(t=0.0)
oc.time = types.SimpleNamespace(time=lambda: clk.t, sleep=lambda s: setattr(clk, "t", clk.t + s))
plan = {}
sinks = []
due = []  # (at, callback)


class Pump:
    @staticmethod
    def PumpWaitingMessages():
        for d in list(due):
            if d[0] <= clk.t:
                due.remove(d)
                d[1]()


class Center:
    def SKCenterLib_Login(self, *_a):
        return 0

    def SKCenterLib_GetReturnCodeMessage(self, c):
        return str(c)


class Order:
    def SKOrderLib_Initialize(self):
        return 0

    def ReadCertByID(self, _i):
        return 0

    def GetUserAccount(self):
        for s in sinks:
            due.append((clk.t + 0.1, lambda s=s: s.OnAccount("A1", "TF,B,x,123")))
        return 0


class Reply:
    def SKReplyLib_ConnectByID(self, _i):
        if plan.get("connect_at") is not None:
            due.append((clk.t + plan["connect_at"], lambda: sinks[0].OnConnect("A1", 0)))
        if plan.get("complete_at") is not None:
            due.append((clk.t + plan["complete_at"], lambda: sinks[0].OnComplete("A1")))
        return 0

    def SKReplyLib_IsConnectedByID(self, _i):
        if plan.get("is_connected_raises"):
            raise OSError("COM call failed (fake)")
        return 0


def create(cls, interface=None):
    return cls()


def get_events(_obj, sink):
    if sink not in sinks:
        sinks.append(sink)
    return object()


oc._init_com = lambda: None
oc.pythoncom = Pump
oc.sk = types.SimpleNamespace(SKCenterLib=Center, ISKCenterLib=None, SKReplyLib=Reply, ISKReplyLib=None,
                              SKOrderLib=Order, ISKOrderLib=None)
oc.comtypes = types.SimpleNamespace(client=types.SimpleNamespace(CreateObject=create, GetEvents=get_events))
oc.capital_vault = types.SimpleNamespace(resolve=lambda env: ("A1", "pw"), login_blocked=lambda *a: None,
                                         set_log_path=lambda c: None, record_login=lambda *a: None)

records = []


class Grab(logging.Handler):
    def emit(self, r):
        records.append(r.getMessage())


logging.getLogger().addHandler(Grab())
logging.getLogger().setLevel(logging.INFO)


def login(**p):
    plan.clear(); plan.update(p); sinks.clear(); due.clear(); records.clear(); clk.t = 0.0
    s = oc._new_session({})
    return s, clk.t


check(isinstance(getattr(oc, "REPLY_READY_S", None), (int, float)) and 0 < oc.REPLY_READY_S <= 10,
      f"REPLY_READY_S is defined and ≤ 10 s (flatten logs in too): {getattr(oc, 'REPLY_READY_S', None)}")
for name, argc in (("OnConnect", 2), ("OnDisconnect", 2), ("OnComplete", 1)):
    fn = getattr(oc._Events, name, None)
    check(fn is not None and fn.__code__.co_argcount == argc + 1,
          f"_Events.{name} takes the typelib's {argc} argument(s)")

s, el = login(connect_at=0.3, complete_at=1.0)
check(s.events.reply_complete and s.events.reply_code == 0 and any("reply ready" in m for m in records),
      f"OnComplete at 1 s: logged ready, session returned ({el:.1f} s)")
check(el < 5, f"…without waiting the full window ({el:.1f} s)")

s, el = login(connect_at=0.3)
check(s is not None and abs(el - 2.1 - oc.REPLY_READY_S) < 1.0
      and any("not complete" in m and "sending anyway" in m for m in records),
      f"no OnComplete: waits REPLY_READY_S, logs, and still returns a session ({el:.1f} s)", records)

try:
    s, _ = login(is_connected_raises=True)
    ok = s is not None and any("IsConnectedByID=OSError" in m for m in records)
except Exception as e:
    ok = False
    records.append(repr(e))
check(ok, "IsConnectedByID raising is logged, never fails the login", records)

ev = oc._Events()
ev.OnComplete("A1")
ev.OnConnect("A1", 3002)
ev.OnDisconnect("A1", 3002)
check(ev.reply_code is None and ev.reply_complete is False, "OnDisconnect resets the link state")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
