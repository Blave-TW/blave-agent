"""統一期貨 test environment (runtime/president_connect.py president_host /
president_test_order, runtime/president_test_order.py) — no network, no broker.

  1. normalize_host: what the user pastes from the broker's mail maps to the
     test or the production host; anything else (other hosts, look-alikes,
     paths, ports, user parts, viploginb) → HOST_NOT_ALLOWED
  2. president_host dispatch: args shapes, a host outside the list refused before
     the lock, NOT_BOUND / CERT_MISSING, a binding without the test URL → REBIND
  3. switch to test: the vault off production, the worker asked to go, its
     snapshot removed (the account lib then refuses — no strategy trades), the
     probe runs and records env "test"
  4. president_test_order gates: refused in production (LIVE_ENV, nothing
     started), refused before a passed TEST probe; the result mapping (time in
     Taipei, order number, contract, code only — never broker text; login classes;
     a stale file; a timeout)
  5. runtime/president_test_order.py against a stand-in SDK with the shipped
     lib: production refused without a login; TMF near month, 1 lot, market IOC
     buy; 0000 → accepted with the order number; a 99xx → rejected; a fill → one
     close-only IOC sell; a wrong password → a login class only
  6. switch to production ("營業員說開好了"): no certificate re-upload, the
     vault on production, the probe on viploginm, the test order record kept for
     the report screen, finish allowed only now

Run: cd blave-agent && /usr/bin/python3 tests/check_president_testhost.py
"""
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import time
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = tempfile.mkdtemp(prefix="prestest-")
WS = os.path.join(TMP, "workspace")
for d in ("lib", "state", "manager"):
    os.makedirs(os.path.join(WS, d))
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = TMP
os.environ.pop("BLAVE_AGENT_LOCAL", None)
sys.path.insert(0, os.path.join(ROOT, "runtime"))

import capital_connect as cc  # noqa: E402
import president_connect as pc  # noqa: E402

fails = []


def check(name, cond, detail=""):
    print(("ok   " if cond else "FAIL ") + name + ("" if cond else f"  {detail}"))
    if not cond:
        fails.append(name)


def refused(fn, code):
    try:
        fn()
    except ValueError as e:
        return str(e).split(":", 1)[0] == code or str(e)
    return "no refusal"


class D:
    def __init__(self, fn, cleanup=None):
        self.fn, self.cleanup = fn, cleanup


def run_cmd(cmd, args):
    d = pc.dispatch(cmd, args, D)
    try:
        return d.fn()
    finally:
        d.cleanup()


P = pc._paths()
pc.IS_WINDOWS = cc.IS_WINDOWS = True
cc._kw = lambda **kw: kw
cc._icacls = lambda *a: None
cc._python_for_worker = lambda: "py"
popen = []
pc.subprocess.Popen = lambda argv, **kw: popen.append(argv)
for name in ("president_vault.py", "president_worker.py", "president_contracts.py", "account_president.py",
             "venue_errors.py"):
    shutil.copy(os.path.join(ROOT, "lib", name), os.path.join(WS, "lib"))
open(P["worker"], "a").close()
BIND = {"president_account": "70000011234", "president_password": "trade-pw"}


def write_env(out):
    with open(os.path.join(WS, ".env"), "w") as f:
        f.write("".join(f"{k}={v}\n" for k, v in out.items()))


# ── 1. normalize_host ──
for raw, env in (("test167.pfctrade.com", "test"), ("https://test167.pfctrade.com", "test"),
                 ("  HTTPS://Test167.PFCTrade.com/ ", "test"), ("http://test167.pfctrade.com", "test"),
                 ("test167.testpfctrade.com", "test"), ("https://test167.testpfctrade.com/", "test"),
                 ("viploginm.pfctrade.com", "live"), ("https://viploginm.pfctrade.com", "live")):
    got = None
    try:
        got = pc.normalize_host(raw)
    except ValueError as e:
        got = str(e)
    check(f"1 {raw!r} → {env}", got == env, got)
for raw in ("", "   ", "evil.example", "test167.pfctrade.com.evil.example", "evil.example/test167.pfctrade.com",
            "https://test167.pfctrade.com/login", "https://test167.pfctrade.com:8443", "https://u:p@test167.pfctrade.com",
            "https://test167.pfctrade.com?x=1", "https://test167.pfctrade.com#x", "ftp://test167.pfctrade.com",
            "viploginb.pfctrade.com", "test168.testpfctrade.com", "x" * 300, "https://[::1]"):
    check(f"1 {raw[:40]!r} → HOST_NOT_ALLOWED", refused(lambda: pc.normalize_host(raw), "HOST_NOT_ALLOWED") is True)

# ── 2. president_host dispatch ──
check("2 before the bind → NOT_BOUND", refused(lambda: pc.dispatch("president_host", {"env": "test"}, D), "NOT_BOUND") is True)
write_env(pc.divert_credentials(dict(BIND)))
for args in ({}, {"env": "prod"}, {"env": "test", "url": "test167.pfctrade.com"}, {"url": 1}, {"host": "test"}, None):
    check(f"2 args {args!r} → BAD_ARGS", refused(lambda: pc.dispatch("president_host", args, D), "BAD_ARGS") is True)
check("2 a host outside the list → HOST_NOT_ALLOWED, refused before the lock (nothing busy)",
      refused(lambda: pc.dispatch("president_host", {"url": "https://evil.example"}, D), "HOST_NOT_ALLOWED") is True
      and pc.read_status()["busy"] is None)
check("2 before the certificate → CERT_MISSING (never a login without it)",
      refused(lambda: pc.dispatch("president_host", {"env": "test"}, D), "CERT_MISSING") is True)
open(P["pfx"], "wb").write(b"PFX")
pc._write_vault(dict(json.load(open(P["vault"])), president_ca_password="ca-pw"))


class _R:
    def __init__(self, rc):
        self.returncode = rc


runs = []
ANS = {}


def fake_run(argv, timeout, what):
    runs.append([os.path.basename(a) for a in argv[1:2]] + argv[2:])
    script = os.path.basename(argv[1])
    if script == "president_worker.py" and argv[2] == "--once" and ANS.get("probe") is not None:
        json.dump(dict(ANS["probe"], read_at=time.time() + 5), open(P["probe"], "w"))
    if script == "president_test_order.py" and ANS.get("order") is not None:
        json.dump(dict(ANS["order"], read_at=ANS.get("order_read_at", time.time() + 5)), open(P["test_order"], "w"))
    if script == "president_test_order.py" and ANS.get("order_timeout"):
        raise RuntimeError("test order timed out")
    return _R(ANS.get(script, 0))


cc._run_quiet = fake_run
env_text = open(os.path.join(WS, ".env")).read()
write_env({k: v for k, v in (l.split("=", 1) for l in env_text.splitlines()) if k != "president_test_url"})
runs.clear()
check("2 a binding written before the test environment existed (no president_test_url) → REBIND, no login",
      refused(lambda: run_cmd("president_host", {"env": "test"}), "REBIND") is True and not runs)
write_env(dict(l.split("=", 1) for l in env_text.splitlines()))

# ── 3. switch to test ──
pc._write_vault(dict(json.load(open(P["vault"])), live=True))
pc._update(env="live")
json.dump({"ok": True, "read_at": time.time(), "query_started_at": time.time(), "positions": []}, open(P["snapshot"], "w"))
pc._update("worker", status="ok")
popen.clear()
runs.clear()
ANS = {"probe": {"ok": True, "equity": 1.0, "test_mode": True}}
r = run_cmd("president_host", {"url": "test167.pfctrade.com"})
st = pc.read_status()
check("3 the mail's address → the test host: vault off production, status env test",
      json.load(open(P["vault"]))["live"] is False and st["env"] == "test" and r["env"] == "test"
      and r["url"] == "https://test167.testpfctrade.com", r)
check("3 …the worker service asked to go, its status idle, its account snapshot removed",
      popen == [["py", P["worker"], "--uninstall"]] and st["worker"]["status"] == "idle"
      and not os.path.exists(P["snapshot"]), popen)
spec = importlib.util.spec_from_file_location("ap_ws", os.path.join(WS, "lib", "account_president.py"))
ap = importlib.util.module_from_spec(spec)
sys.path.insert(0, os.path.join(WS, "lib"))
spec.loader.exec_module(ap)
try:
    ap.bot_position_rows()
    ap_refused = False
except RuntimeError as e:
    ap_refused = "snapshot missing" in str(e)
check("3 …so the account lib refuses (the order lib's checks read it first: no strategy order reaches the test host)",
      ap_refused)
check("3 …then the probe on the test host, recorded as env test",
      runs == [["president_worker.py", "--once"]] and r["probe"] == {"state": "ok", "equity_read": True,
                                                                     "test_mode": True, "env": "test"}
      and st["probe"]["env"] == "test" and st["probe"]["state"] == "ok", (runs, r))
check("3 finish on the test host → TEST_ENV", refused(lambda: run_cmd("president_finish", {}), "TEST_ENV") is True)
pc._write_vault(dict(json.load(open(P["vault"])), live=True))
check("3 vault on production but the passed probe was the test host's → PROBE_NOT_OK",
      refused(lambda: run_cmd("president_finish", {}), "PROBE_NOT_OK") is True)
pc._write_vault(dict(json.load(open(P["vault"])), live=False))

# ── 4. test order gates + mapping ──
pc._write_vault(dict(json.load(open(P["vault"])), live=True))
runs.clear()
check("4 in production → LIVE_ENV, nothing started",
      refused(lambda: pc.dispatch("president_test_order", {}, D), "LIVE_ENV") is True and not runs
      and pc.read_status()["busy"] is None)
pc._write_vault(dict(json.load(open(P["vault"])), live=False))
check("4 args → BAD_ARGS", refused(lambda: pc.dispatch("president_test_order", {"x": 1}, D), "BAD_ARGS") is True)
pc._update("probe", state="password", env="test")
check("4 before a passed test probe → PROBE_NOT_OK",
      refused(lambda: pc.dispatch("president_test_order", {}, D), "PROBE_NOT_OK") is True)
pc._update("probe", state="ok", env="live")
check("4 a probe that passed in production does not count → PROBE_NOT_OK",
      refused(lambda: pc.dispatch("president_test_order", {}, D), "PROBE_NOT_OK") is True)
pc._update("probe", state="ok", env="test")
SENT = 1791421925.4  # 2026-10-08 09:12:05.4 Taipei = 01:12:05 UTC
ANS = {"order": {"result": "accepted", "sent_at": SENT, "productid": "TMFJ6", "orderno": "A0001",
                 "statuscode": "0000", "filled": False, "orderstatus": "A123456789 委託成功"}}
runs.clear()
r = run_cmd("president_test_order", {})
check("4 accepted: Taipei time, epoch, contract, order number, code; no broker text",
      r == {"state": "accepted", "at": "2026-10-08T09:12:05+08:00", "at_ts": 1791421925, "productid": "TMFJ6",
            "orderno": "A0001", "statuscode": "0000", "filled": False}
      and runs == [["president_test_order.py", WS]], (r, runs))
st = pc.read_status()
check("4 …in the status for the report screen, nothing else carried",
      st["test_order"]["status"] == "ok" and st["test_order"]["orderno"] == "A0001"
      and "A123456789" not in json.dumps(st) and "委託成功" not in json.dumps(st), st["test_order"])
for order, want in (({"result": "rejected", "sent_at": SENT, "productid": "TMFJ6", "orderno": "",
                      "statuscode": "9902"}, {"state": "rejected", "statuscode": "9902"}),
                    ({"result": "accepted", "filled": True, "closed": True, "sent_at": SENT},
                     {"state": "accepted", "filled": True, "closed": True}),
                    ({"error": "統一期貨 login failed: PASSWORD"}, {"state": "password"}),
                    ({"error": "統一期貨 login failed: BLOCKED"}, {"state": "blocked"}),
                    ({"result": "live_refused"}, {"state": "live_refused"}),
                    ({"error": "KeyError"}, {"state": "unknown"})):
    ANS = {"order": order}
    r = run_cmd("president_test_order", {})
    check(f"4 {order.get('result') or order.get('error')} → {want}",
          all(r.get(k) == v for k, v in want.items()) and (pc.read_status()["test_order"]["status"] == "failed")
          == (want["state"] != "accepted"), r)
ANS = {"order": {"result": "accepted", "sent_at": SENT}, "order_read_at": time.time() - 3600}
check("4 a result file older than this run → unknown", run_cmd("president_test_order", {})["state"] == "unknown")
ANS = {"order_timeout": True}
os.remove(P["test_order"])
check("4 the script timed out → timeout", run_cmd("president_test_order", {})["state"] == "timeout")

# ── 5. the script, with the shipped lib and a stand-in SDK ──
import president_test_order as pto  # noqa: E402

pv = importlib.import_module("president_vault")  # the workspace copy (WS/lib is on sys.path)
pcon = importlib.import_module("president_contracts")
check("5 the lib loaded is the workspace copy", os.path.dirname(pv.__file__) == os.path.join(WS, "lib"))
pv.in_login_maintenance = lambda now=None: False
pto.FILL_GRACE_S = 0
pto.REPLY_WAIT_S = 0.5
SDK = {"login_ok": True, "login_error": "", "test_mode": True, "reply": "0000", "fill": 0, "logins": 0}
orders = []


class _Obj:
    def __init__(self, **kw):
        self.__dict__.update(kw)


class FakeDtrade:
    on_reply = on_match = None

    def order(self, o):
        orders.append(dict(o.__dict__))
        seq = str(len(orders))
        if SDK["reply"] is not None:
            code = SDK["reply"] if o.opencloseflag == "" else "0004"
            self.on_reply(_Obj(seq=seq, orderno=f"N{seq}", statuscode=code, matchqty=None))
            if SDK["fill"] and o.opencloseflag == "":
                self.on_match(_Obj(orderno=f"N{seq}", matchseq="1", matchqty=SDK["fill"], matchprice=1.0))
        return _Obj(issend=True, seq=seq, errorcode="", errormsg="")


class FakeUnitrade:
    def __init__(self):
        self.test_mode = SDK["test_mode"]
        self.dtrade = FakeDtrade()

    def login(self, url, account, password, ca_path, ca_password):
        SDK["logins"] += 1
        SDK["url"] = url
        return _Obj(ok=SDK["login_ok"], error=SDK["login_error"])

    def logout(self):
        SDK["logouts"] = SDK.get("logouts", 0) + 1

    def get_domestic_contracts(self, root, kind):
        near = pcon.computed_near(root)
        return _Obj(ok=True, data=[_Obj(prod_id=near)], error="")

    def get_accounts(self):
        return ["F0001"]


ut = types.ModuleType("unitrade")
utu = types.ModuleType("unitrade.unitrade")
utu.Unitrade = FakeUnitrade
utu.DOrderObject = type("DOrderObject", (), {})
sys.modules["unitrade"], sys.modules["unitrade.unitrade"] = ut, utu


def script():
    for path in (P["test_order"], os.path.join(P["cred"], "president_login_block.json")):
        if os.path.exists(path):
            os.remove(path)
    rc = pto.main(["president_test_order.py", WS])
    return rc, json.load(open(P["test_order"]))


pc._write_vault(dict(json.load(open(P["vault"])), live=True))
orders.clear()
rc, out = script()
check("5 production vault → live_refused, no login, no order",
      out["result"] == "live_refused" and SDK["logins"] == 0 and not orders and rc == 2, out)
pc._write_vault(dict(json.load(open(P["vault"])), live=False))
rc, out = script()
near = pcon.computed_near("TMF")
o = orders[0] if orders else {}
check("5 test vault: logs in to the test host (as the lib resolves it)", SDK["url"] == "https://test167.testpfctrade.com")
check("5 one order: TMF near month, 1 lot, market IOC buy, no open/close flag, never a close",
      len(orders) == 1 and o["productid"] == near and o["orderqty"] == 1 and o["ordertype"] == "M"
      and o["ordercondition"] == "I" and o["bs"] == "B" and o["opencloseflag"] == "" and o["price"] == 0, orders)
check("5 0000 → accepted with the order number, the contract and the send time; logged out",
      rc == 0 and out["result"] == "accepted" and out["orderno"] == "N1" and out["statuscode"] == "0000"
      and out["productid"] == near and out["filled"] is False and abs(out["sent_at"] - time.time()) < 60
      and SDK["logouts"] >= 1, out)
orders.clear()
SDK["reply"] = "9902"
rc, out = script()
check("5 a 99xx reply → rejected, code only", rc == 2 and out["result"] == "rejected" and out["statuscode"] == "9902"
      and len(orders) == 1, out)
orders.clear()
SDK["reply"], SDK["fill"] = "0000", 1
rc, out = script()
check("5 a fill (the test host is not expected to) → one close-only IOC sell for the filled lot",
      out["result"] == "accepted" and out["filled"] is True and out["closed"] is True and len(orders) == 2
      and orders[1]["bs"] == "S" and orders[1]["opencloseflag"] == "1" and orders[1]["ordercondition"] == "I"
      and orders[1]["productid"] == near and orders[1]["orderqty"] == 1, (out, orders))
orders.clear()
SDK["fill"], SDK["test_mode"] = 0, False
rc, out = script()
check("5 a server that is not a test server → refused at login, no order",
      not orders and "NON_TEST_SERVER" in out.get("error", ""), out)
SDK["test_mode"], SDK["login_ok"], SDK["login_error"] = True, False, "使用者密碼錯誤"
rc, out = script()
check("5 a wrong password → the login class only, no order, no broker text",
      not orders and out == {"error": "統一期貨 login failed: PASSWORD", "read_at": out["read_at"]}, out)
check("5 …and it is the shared login block (the same one production logins check)",
      json.load(open(os.path.join(P["cred"], "president_login_block.json"))).get("kind") == "PASSWORD")
SDK["login_ok"], SDK["login_error"] = True, ""
check("5 the script imports nothing but the stdlib at module level (the runtime health check imports it)",
      all(not l.startswith(("import president", "from president", "import unitrade", "from unitrade", "from lib",
                            "import lib"))
          for l in open(os.path.join(ROOT, "runtime", "president_test_order.py"), encoding="utf-8").read().splitlines()))

# ── 6. switch to production ──
pc._update("test_order", status="ok", orderno="A0001", at="2026-10-08T09:12:05+08:00")
pfx_before = open(P["pfx"], "rb").read()
popen.clear()
runs.clear()
ANS = {"probe": {"ok": True, "equity": 1.0, "test_mode": False}}
r = run_cmd("president_host", {"env": "live"})
st = pc.read_status()
check("6 營業員說開好了 → production: vault on, probe on viploginm recorded env live, no re-upload, worker untouched;"
      " right after a passed test-host login that probe carries --first-live (audit B6)",
      json.load(open(P["vault"]))["live"] is True and r["env"] == "live" and r["url"] == "https://viploginm.pfctrade.com"
      and r["probe"]["env"] == "live" and st["env"] == "live" and open(P["pfx"], "rb").read() == pfx_before
      and not popen and runs == [["president_worker.py", "--once", "--first-live"]], (r, popen, runs))
check("6 the test order record stays (the report screen reads its time and number)",
      st["test_order"]["orderno"] == "A0001")
check("6 a test order now → LIVE_ENV", refused(lambda: pc.dispatch("president_test_order", {}, D), "LIVE_ENV") is True)
ANS = {}
check("6 finish allowed only now", run_cmd("president_finish", {}) == {"worker": "ok"})

shutil.rmtree(TMP, ignore_errors=True)
print("PASS" if not fails else f"FAIL {len(fails)}")
sys.exit(1 if fails else 0)
