"""After a machine restart NO order leaves this machine through lib/order_* —
entries and closes alike, from any caller (reconciler, TWAP/chase, Type B
strategies calling the lib directly, ad-hoc scripts) — until 啟動下單 removes
state/reconciler_stopped.json (Wei 2026-09-22). Cancels and leverage pass.

Part 1 ENUMERATES instead of trusting a list:
  - every lib/order_*.py (TEMPLATE aside) must be registered in CHOKE below with
    the one function all its orders pass through — a new venue lib is red until
    someone names its chokepoint;
  - that chokepoint calls guard.check_restart_stop unconditionally (not under an
    entry-only branch) and before the HALT check;
  - nothing reaches the venue around it: HTTP libs send non-GET requests only
    from _send, and non-GET _send calls only from _request; Capital's Send*Order
    only inside _send(...); Sinopac's api.place_order only after the check;
    paper orders only after _gate (the one exception is named and explained);
  - every public place_/open_/close_ function is printed with the chokepoint it
    reaches through the module's own call graph — unreachable = red;
  - lib/account_*.py send nothing that places an order.
Part 2 CALLS the gates with the record present: entry, reduce and protective
are refused before the transport, cancels pass; Type B-style direct calls
(order_paper.place_market_order / close_position_partial) are refused.

Run: cd blave-agent && .venv/bin/python tests/check_restart_stop_order_gate.py
"""
import ast
import glob
import json
import os
import re
import shutil
import sys
import tempfile
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
# notify config = none from the very first import: lib.notify reads it at import time
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = tempfile.mkdtemp(prefix="notify-none-")
fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


CHOKE = {
    "binance": "_request", "bingx": "_request", "bybit": "_request",
    "gateio": "_request", "okx": "_request",
    "paper": "_gate", "capital": "_send", "sinopac": "place_odd_lot_order",
}
HTTP = {"binance", "bingx", "bybit", "gateio", "okx"}
# non-GET _send calls outside _request, each with the reason it is not an order
SEND_OUTSIDE_REQUEST_OK = {
    ("gateio", "set_leverage"): "leverage change — neither opens nor closes anything",
}
# paper: the ledger's own SL/TP firing = the venue-held stop the spec leaves alone
PAPER_UNGATED_OK = {"_settle"}
ACCOUNT_POST_OK = {("account_binance", "/sapi/v1/asset/get-funding-asset")}  # a read
# non-GET paths with no intent, each not an order
UNCLASSIFIED_OK = {("bingx", "/openApi/swap/v2/trade/getVst"): "demo VST top-up"}


def _tree(path):
    t = ast.parse(open(path, encoding="utf-8").read())
    for node in ast.walk(t):
        for child in ast.iter_child_nodes(node):
            child._parent = node
    return t


def _func_of(node):
    n = getattr(node, "_parent", None)
    while n is not None and not isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
        n = getattr(n, "_parent", None)
    return n


def _is_guard_call(node, name):
    return (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
            and node.func.attr == name and isinstance(node.func.value, ast.Name)
            and node.func.value.id == "guard")


def _call_name(node):
    f = node.func
    return f.id if isinstance(f, ast.Name) else f.attr if isinstance(f, ast.Attribute) else None


# ── part 1: enumeration ──────────────────────────────────────────────────────
libs = sorted(os.path.basename(p)[6:-3] for p in glob.glob(os.path.join(ROOT, "lib", "order_*.py")))
libs = [v for v in libs if v != "TEMPLATE"]
check(set(libs) == set(CHOKE),
      f"every lib/order_*.py has a registered chokepoint (libs {libs}; unregistered "
      f"{sorted(set(libs) - set(CHOKE))}, stale {sorted(set(CHOKE) - set(libs))})")
check("check_restart_stop" in open(os.path.join(ROOT, "lib", "order_TEMPLATE.py")).read(),
      "order_TEMPLATE.py tells the next venue lib to call guard.check_restart_stop")

for v in libs:
    path = os.path.join(ROOT, "lib", f"order_{v}.py")
    t = _tree(path)
    funcs = {f.name: f for f in t.body if isinstance(f, ast.FunctionDef)}
    choke = funcs.get(CHOKE.get(v))
    if choke is None:
        check(False, f"{v}: chokepoint {CHOKE.get(v)} not found")
        continue
    rs = [n for n in ast.walk(choke) if _is_guard_call(n, "check_restart_stop")]
    hs = [n for n in ast.walk(choke) if _is_guard_call(n, "halted")]
    conditional = False
    for r in rs:
        n = r._parent
        while n is not choke:
            if isinstance(n, ast.If):
                src = ast.unparse(n.test)
                if "entry" in src or "halted" in src or "buy" in src:
                    conditional = True
            n = n._parent
    check(rs and not conditional and (not hs or min(r.lineno for r in rs) < min(h.lineno for h in hs)),
          f"{v}: {choke.name}() calls guard.check_restart_stop for every intent, before the HALT check")

    # nothing around the chokepoint
    stray = []
    if v in HTTP:
        for n in ast.walk(t):
            if (isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
                    and isinstance(n.func.value, ast.Name) and n.func.value.id == "requests"
                    and n.func.attr in ("post", "put", "delete", "patch", "request")):
                if getattr(_func_of(n), "name", None) != "_send":
                    stray.append(f"requests.{n.func.attr} in {getattr(_func_of(n), 'name', '<module>')}")
            if isinstance(n, ast.Call) and _call_name(n) == "_send" and isinstance(n.func, ast.Name):
                m = n.args[1] if v == "bybit" and len(n.args) > 1 else (n.args[0] if n.args else None)
                if isinstance(m, ast.Constant) and m.value == "GET":
                    continue
                fn = getattr(_func_of(n), "name", "<module>")
                if fn not in ("_request",) and (v, fn) not in SEND_OUTSIDE_REQUEST_OK:
                    stray.append(f"non-GET _send in {fn}")
    elif v == "capital":
        for n in ast.walk(t):
            if isinstance(n, ast.Attribute) and n.attr.startswith("Send") and "Order" in n.attr:
                p, ok = n, False
                while p is not None:
                    if isinstance(p, ast.Call) and _call_name(p) == "_send":
                        ok = True
                        break
                    p = getattr(p, "_parent", None)
                if not ok:
                    stray.append(f"{n.attr} outside _send")
    elif v == "sinopac":
        for n in ast.walk(t):
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "place_order":
                fn = _func_of(n)
                gates = [c for c in ast.walk(fn) if _is_guard_call(c, "check_restart_stop")]
                if not gates or min(c.lineno for c in gates) > n.lineno:
                    stray.append(f"place_order in {fn.name} without a prior check")
    elif v == "paper":
        for n in ast.walk(t):
            if isinstance(n, ast.Call) and _call_name(n) == "_new_order":
                fn = _func_of(n)
                if fn.name in PAPER_UNGATED_OK:
                    continue
                gates = [c for c in ast.walk(fn) if isinstance(c, ast.Call) and _call_name(c) == "_gate"]
                if not gates or min(c.lineno for c in gates) > n.lineno:
                    stray.append(f"_new_order in {fn.name} without a prior _gate")
    check(not stray, f"{v}: nothing reaches the venue around {choke.name}() {stray or ''}")

    # T3: every non-GET request this lib sends is classified — an unclassified
    # (intent None) path would pass both HALT and the restart gate untouched
    if v in HTTP:
        m_mod = __import__(f"lib.order_{v}", fromlist=["_order_intent"])
        unclassified = []
        for n in ast.walk(t):
            if not (isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "_request"):
                continue
            mi, pi = (1, 2) if v == "bybit" else (0, 1)
            if len(n.args) <= pi or not isinstance(n.args[mi], ast.Constant) or n.args[mi].value == "GET":
                continue
            pnode = n.args[pi]
            if isinstance(pnode, ast.Constant):
                pth = pnode.value
            elif isinstance(pnode, ast.JoinedStr):
                pth = "".join(x.value if isinstance(x, ast.Constant) else "X" for x in pnode.values)
            else:
                unclassified.append(f"non-literal path at line {n.lineno}")
                continue
            if m_mod._order_intent(n.args[mi].value, pth, {}) is None and (v, pth) not in UNCLASSIFIED_OK:
                unclassified.append(f"{n.args[mi].value} {pth}")
        check(not unclassified, f"{v}: every non-GET _request path has an intent {unclassified or ''}")
    # N4: Capital refuses before the SKCOM login, not only inside _send
    if v == "capital":
        late = []
        for name, f in funcs.items():
            logins = [c for c in ast.walk(f) if isinstance(c, ast.Call) and _call_name(c) == "_get_session"]
            if not logins or name.startswith("_"):
                continue
            gates = [c for c in ast.walk(f) if _is_guard_call(c, "check_restart_stop")]
            halts = [c for c in ast.walk(f) if isinstance(c, ast.Call) and _call_name(c) == "_check_halt"]
            first = min(c.lineno for c in logins + halts)
            if not gates or min(c.lineno for c in gates) > first:
                late.append(name)
        check(not late, f"capital: every place_* refuses before _check_halt and the SKCOM login {late or ''}")

    # every public order function reaches the chokepoint (module call graph)
    graph = {name: {_call_name(c) for c in ast.walk(f) if isinstance(c, ast.Call)}
             for name, f in funcs.items()}

    def reaches(name, seen=None):
        seen = seen or set()
        if name == choke.name:
            return True
        seen.add(name)
        return any(c in funcs and c not in seen and reaches(c, seen) for c in graph.get(name, ()))

    public = sorted(n for n in funcs if not n.startswith("_")
                    and n.split("_")[0] in ("place", "open", "close"))
    unreached = [n for n in public if not reaches(n)
                 and not any(isinstance(s, ast.Raise) for s in funcs[n].body)]  # stubs that only raise
    print(f"     {v}: {', '.join(public) or '(none)'} → {choke.name}")
    check(public and not unreached, f"{v}: every public place_/open_/close_ function reaches "
                                    f"{choke.name}() {unreached or ''}")

for path in sorted(glob.glob(os.path.join(ROOT, "lib", "account_*.py"))):
    name = os.path.basename(path)[:-3]
    if name == "account_TEMPLATE":
        continue
    t = _tree(path)
    bad = []
    for n in ast.walk(t):
        if not isinstance(n, ast.Call):
            continue
        cn = _call_name(n) or ""
        if (re.match(r"(place|open|close)_", cn) or cn in ("_gate",)
                or (cn.startswith("Send") and "Order" in cn)):
            bad.append(cn)
        consts = [a.value for a in n.args if isinstance(a, ast.Constant) and isinstance(a.value, str)]
        if any(c in ("POST", "PUT", "DELETE") for c in consts):
            paths = [c for c in consts if c.startswith("/")]
            if not paths or any((name, p) not in ACCOUNT_POST_OK for p in paths):
                bad.append(f"{cn}{tuple(consts)}")
    check(not bad, f"{name}: places no order {bad or ''}")

# ── part 2: the gates, called ────────────────────────────────────────────────
TMP = tempfile.mkdtemp(prefix="restart-order-gate-")
# notify config = none: lib.notify here and in every child falls back to a log line, never a real Telegram
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = TMP
os.makedirs(os.path.join(TMP, "state"))
cwd = os.getcwd()
os.chdir(TMP)  # guard resolves state/ relative to the cwd, like the fleet
RECORD = os.path.join(TMP, "state", "reconciler_stopped.json")
from lib import guard  # noqa: E402

check(guard.RESTART_STOP_PATH == "state/reconciler_stopped.json",
      "guard.RESTART_STOP_PATH is the file the runtime writes")


def record(on):
    if on:
        json.dump({"reason": "machine_restart"}, open(RECORD, "w"))
    elif os.path.exists(RECORD):
        os.remove(RECORD)


CASES = {  # lib: (call builder, {intent: request}) — intents as each lib classifies them
    "binance": (lambda m, meth, path, body: m._request(meth, path, {}, body), {
        "entry": ("POST", "/fapi/v1/order", {"symbol": "BTCUSDT", "side": "BUY", "type": "MARKET"}),
        "reduce": ("POST", "/fapi/v1/order", {"symbol": "BTCUSDT", "side": "SELL", "type": "MARKET",
                                              "reduceOnly": "true"}),
        "protective": ("POST", "/fapi/v1/algoOrder", {"symbol": "BTCUSDT", "side": "SELL",
                                                      "type": "STOP_MARKET", "closePosition": "true"}),
        "cancel": ("DELETE", "/fapi/v1/order", {"symbol": "BTCUSDT", "orderId": 1}),
        "cancel_all": ("DELETE", "/fapi/v1/allOpenOrders", {"symbol": "BTCUSDT"}),
        "leverage": ("POST", "/fapi/v1/leverage", {"symbol": "BTCUSDT", "leverage": 3})}),
    "bingx": (lambda m, meth, path, body: m._request(meth, path, {}, body), {
        "entry": ("POST", "/openApi/swap/v2/trade/order", {"symbol": "BTC-USDT", "side": "BUY",
                                                           "positionSide": "LONG", "type": "MARKET"}),
        "reduce": ("POST", "/openApi/swap/v2/trade/order", {"symbol": "BTC-USDT", "side": "SELL",
                                                            "positionSide": "LONG", "type": "MARKET"}),
        "cancel": ("DELETE", "/openApi/swap/v2/trade/order", {"symbol": "BTC-USDT", "orderId": 1})}),
    "bybit": (lambda m, meth, path, body: m._request({}, meth, path, body=body), {
        "entry": ("POST", "/v5/order/create", {"category": "linear", "symbol": "BTCUSDT", "side": "Buy"}),
        "reduce": ("POST", "/v5/order/create", {"category": "linear", "symbol": "BTCUSDT", "side": "Sell",
                                                "reduceOnly": True}),
        "protective": ("POST", "/v5/position/trading-stop", {"category": "linear", "symbol": "BTCUSDT"}),
        "cancel": ("POST", "/v5/order/cancel", {"category": "linear", "symbol": "BTCUSDT"})}),
    "gateio": (lambda m, meth, path, body: m._request(meth, path, {}, body), {
        "entry": ("POST", "/futures/usdt/orders", {"contract": "BTC_USDT", "size": 1}),
        "reduce": ("POST", "/futures/usdt/orders", {"contract": "BTC_USDT", "size": -1, "reduce_only": True}),
        "cancel": ("DELETE", "/futures/usdt/orders/1", None)}),
    "okx": (lambda m, meth, path, body: m._request(meth, path, {}, body), {
        "entry": ("POST", "/api/v5/trade/order", {"instId": "BTC-USDT-SWAP", "side": "buy"}),
        "reduce": ("POST", "/api/v5/trade/order", {"instId": "BTC-USDT-SWAP", "side": "sell",
                                                   "reduceOnly": "true"}),
        "cancel": ("POST", "/api/v5/trade/cancel-order", {"instId": "BTC-USDT-SWAP", "ordId": "1"})}),
}
import importlib  # noqa: E402

for v, (call, reqs) in CASES.items():
    m = importlib.import_module(f"lib.order_{v}")
    sent = []
    real_send = m._send
    m._send = lambda *a, **k: sent.append(a) or {}
    try:
        record(True)
        refused, passed = [], []
        for intent, (meth, path, body) in reqs.items():
            del sent[:]
            try:
                call(m, meth, path, body)
                passed.append(intent) if sent else None
            except guard.Halted:
                refused.append(intent) if not sent else None
        PASS = {"cancel", "cancel_all", "leverage"}
        want_refused = sorted(i for i in reqs if i not in PASS)
        want_passed = sorted(i for i in reqs if i in PASS)
        check(sorted(refused) == want_refused and sorted(passed) == want_passed,
              f"{v}: record present → {', '.join(want_refused)} refused before the transport, "
              f"{', '.join(want_passed)} pass")
        record(False)
        del sent[:]
        meth, path, body = reqs["reduce"]
        call(m, meth, path, body)
        check(bool(sent), f"{v}: no record → a close reaches the transport again")
    finally:
        m._send = real_send
        record(False)

# Capital: the one Send path
import lib.order_capital as capital  # noqa: E402

sent = []
record(True)
try:
    capital._send(types.SimpleNamespace(), lambda: sent.append(1) or ("1", 0),
                  {"intent": "reduce", "symbol": "TX00", "action": "sell"})
    capital_refused = False
except guard.Halted:
    capital_refused = not sent
record(False)
check(capital_refused, "capital: record present → a close is refused before SendFutureOrderCLR")

# Sinopac (shioaji faked: only the module import needs it)
sys.modules.setdefault("shioaji", types.ModuleType("shioaji"))
import lib.order_sinopac as sinopac  # noqa: E402

opened = []
real_api = sinopac._get_api
sinopac._get_api = lambda env: opened.append(1) or (None, None)
record(True)
try:
    for action in ("buy", "sell"):
        try:
            sinopac.place_odd_lot_order({}, "2330", action, 1)
            ok = False
        except guard.Halted:
            ok = not opened
        check(ok, f"sinopac: record present → {action} refused before the broker session opens")
finally:
    sinopac._get_api = real_api
    record(False)

# Type B style: a strategy calling the lib directly (paper)
import lib.order_paper as paper  # noqa: E402

record(True)
for label, fn in (("entry  place_market_order", lambda: paper.place_market_order({}, "BTCUSDT", "long", 1)),
                  ("close  close_position_partial", lambda: paper.close_position_partial({}, "BTCUSDT", "long", 1)),
                  ("SL/TP  place_protective_orders",
                   lambda: paper.place_protective_orders({}, "BTCUSDT", "long", sl_price=1))):
    try:
        fn()
        ok = False
    except guard.Halted:
        ok = True
    check(ok, f"Type B direct call, record present → {label} refused")
record(False)
audit_lines = [json.loads(line) for line in open(os.path.join(TMP, "state", "audit.jsonl"))]
check(any(a["event"] == "order_denied_restart" for a in audit_lines),
      "every refusal leaves an order_denied_restart line in state/audit.jsonl")

# ── part 3: the user's 全部平倉 (Wei 2026-09-22: closes pass, machine stays stopped)
import subprocess  # noqa: E402
import time  # noqa: E402

callers, writers = [], []
for sub in ("lib", "manager", "runtime", "examples", "allocators"):
    for fp in glob.glob(os.path.join(ROOT, sub, "**", "*.py"), recursive=True):
        src = open(fp, encoding="utf-8").read()
        rel = os.path.relpath(fp, ROOT)
        if "claim_close_all_pass(" in src and rel != "lib/guard.py":
            callers.append(rel)
        if "close_all_pass.json" in src and rel != "lib/guard.py":
            writers.append(rel)
check(callers == ["manager/flatten.py"],
      f"the close-all pass is claimed by manager/flatten.py and nothing else ({callers})")
check(writers == ["runtime/command_listener.py"],
      f"…and written by the command listener's close_all and nothing else ({writers})")

PASS_FILE = os.path.join(TMP, guard.CLOSE_ALL_PASS_PATH)
reduce_req = CASES["binance"][1]["reduce"]
entry_req = CASES["binance"][1]["entry"]
prot_req = CASES["binance"][1]["protective"]
binance = importlib.import_module("lib.order_binance")
sent = []
real_send = binance._send
binance._send = lambda *a, **k: sent.append(a) or {}


def attempt(req):
    del sent[:]
    try:
        binance._request(req[0], req[1], {}, req[2])
    except guard.Halted:
        return "refused"
    return "sent" if sent else "?"


try:
    record(True)
    check(attempt(reduce_req) == "refused", "no pass: a close is refused (strategy / reconciler / script)")
    json.dump({"ts": time.time() - guard.CLOSE_ALL_PASS_TTL_S - 5}, open(PASS_FILE, "w"))
    check(guard.claim_close_all_pass() is False and attempt(reduce_req) == "refused",
          "a stale pass is void")
    json.dump({"ts": time.time() + 600}, open(PASS_FILE, "w"))
    check(guard.claim_close_all_pass() is False and attempt(reduce_req) == "refused",
          "G3: a pass stamped in the future is void too")
    json.dump({"ts": time.time()}, open(PASS_FILE, "w"))
    child = subprocess.run(
        [sys.executable, "-c",
         "import sys; sys.path.insert(0, %r); from lib import guard; "
         "guard.check_restart_stop('reduce', {'symbol': 'X'})" % ROOT],
        cwd=TMP, capture_output=True, text=True)
    check(child.returncode != 0 and "Halted" in child.stderr and os.path.exists(PASS_FILE),
          "another process (a Type B strategy) with the pass on disk but not claimed: still refused")
    check(guard.claim_close_all_pass() is True and not os.path.exists(PASS_FILE),
          "flatten claims the fresh pass — consumed, the file is gone")
    check(attempt(reduce_req) == "sent", "…this process's closes go through")
    check(attempt(entry_req) == "refused" and attempt(prot_req) == "refused",
          "…entries and SL/TP stay refused even with the pass")
    check(guard.claim_close_all_pass() is False, "a pass is one-time: a second claim fails")
    check(os.path.exists(RECORD), "the record stays — the machine is still stopped after the close-all")
finally:
    guard._close_all_granted = False
    binance._send = real_send
    record(False)
    if os.path.exists(PASS_FILE):
        os.remove(PASS_FILE)

# the listener side: no HALT, pass written, honest ack
sys.path.insert(0, os.path.join(ROOT, "runtime"))
os.environ["BLAVE_AGENT_WORKSPACE"] = TMP
os.environ.pop("BLAVE_AGENT_LOCAL", None)
import command_listener as cl  # noqa: E402

os.makedirs(os.path.join(TMP, "manager"), exist_ok=True)
FLATTEN_STUB = os.path.join(TMP, "manager", "flatten.py")
NEW_FLATTEN = "# guard.claim_close_all_pass() — the current flatten\n"
open(FLATTEN_STUB, "w").write(NEW_FLATTEN)
RECON_STUB = os.path.join(TMP, "manager", "reconciler.py")
GATED_SRC = "RESTART_STOP_PATH = Path(guard.RESTART_STOP_PATH)\n"
open(RECON_STUB, "w").write(GATED_SRC)  # a gated workspace, nothing running
HB_F = os.path.join(TMP, "state", "heartbeat", "reconciler")
MARKER_F = os.path.join(TMP, "state", "heartbeat", "reconciler.gated")
os.makedirs(os.path.dirname(HB_F), exist_ok=True)
HALT_F = os.path.join(TMP, "state", "HALT")
launched = []
real_popen, real_cap, real_running = cl.subprocess.Popen, cl._capital_only_unflattenable, cl._flatten_already_running
cl.subprocess.Popen = lambda *a, **k: launched.append((a, os.path.exists(PASS_FILE)))
cl._capital_only_unflattenable = lambda: False
running = {"v": False}
cl._flatten_already_running = lambda: running["v"]


def press():
    del launched[:]
    for f_ in (HALT_F, PASS_FILE):
        if os.path.exists(f_):
            os.remove(f_)
    return cl._in_workspace(cl._cmd_close_all, {})


def reset_state():
    for f_ in (HB_F, MARKER_F):
        if os.path.exists(f_):
            os.remove(f_)
    open(FLATTEN_STUB, "w").write(NEW_FLATTEN)
    open(RECON_STUB, "w").write(GATED_SRC)


try:
    record(True)
    ack = press()
    check(ack == "close_all=restart_stopped:started" and len(launched) == 1 and launched[0][1]
          and not os.path.exists(HALT_F) and os.path.exists(RECORD),
          f"close_all during a restart stop, gated reconciler + current flatten: pass written before "
          f"the flatten launches, no HALT, record kept, ack says so ({ack})")
    open(RECON_STUB, "w").write("# an old reconciler without the restart gate\n")
    ack = press()
    check(ack == "close_all=restart_stopped:started" and launched and launched[0][1]
          and os.path.exists(HALT_F) and os.path.exists(RECORD),
          "…workspace reconciler has NO gate: HALT tripped synchronously too (the flatten still gets its pass)")
    reset_state()
    now = time.time()
    for f_ in (HB_F,):
        open(f_, "w").close()
        os.utime(f_, (now - 2, now - 2))
    ack = press()
    check(os.path.exists(HALT_F),
          "P2: a RUNNING reconciler with no gated marker (an old process, new reconciler.py on disk): HALT")
    open(MARKER_F, "w").close()
    os.utime(MARKER_F, (now - 2, now - 2))
    ack = press()
    check(not os.path.exists(HALT_F) and launched and launched[0][1],
          "…the same running reconciler with a fresh gated marker: proven gated, no HALT")
    os.utime(MARKER_F, (now - 120, now - 120))
    ack = press()
    check(os.path.exists(HALT_F), "…a marker older than the heartbeat proves nothing: HALT")
    os.remove(MARKER_F)
    os.utime(HB_F, (now - 60, now - 60))
    ack = press()
    check(os.path.exists(HALT_F),
          "M2: an old reconciler 60 s into a long round (heartbeat older than 15 s, within 300 s) "
          "is still RUNNING — no marker, so HALT")
    json.dump({"reason": "machine_restart", "down_to": int(now - 30)}, open(RECORD, "w"))
    ack = press()
    check(not os.path.exists(HALT_F),
          "…but a heartbeat from before the stop is the killed process, not a running one: "
          "the gated file on disk decides, no HALT")
    record(True)
    reset_state()
    open(FLATTEN_STUB, "w").write("# an old flatten\n")
    ack = press()
    check(os.path.exists(HALT_F) and launched and not launched[0][1] and not os.path.exists(PASS_FILE),
          "P3: a flatten that does not claim the pass: HALT synchronously, no pass written")
    reset_state()
    running["v"] = True
    ack = press()
    check(ack == "close_all=restart_stopped:already_running" and not launched
          and not os.path.exists(PASS_FILE),
          "C5: a flatten already running — nothing launched, no pass left on disk")
    running["v"] = False
    real_wp = cl._write_close_all_pass
    cl._write_close_all_pass = lambda: False
    try:
        ack = press()
    finally:
        cl._write_close_all_pass = real_wp
    check(ack == "close_all=restart_stopped:nothing_closed" and not launched,
          "pass could not be written: nothing launched, the ack says nothing was closed")

    def _boom(*a, **k):
        raise OSError("fork failed")

    cl.subprocess.Popen = _boom
    try:
        press()
        raised = False
    except OSError:
        raised = True
    cl.subprocess.Popen = lambda *a, **k: launched.append((a, os.path.exists(PASS_FILE)))
    check(raised and not os.path.exists(PASS_FILE),
          "the flatten failed to launch: the command fails and no claimable pass is left behind")
    record(False)
    ack = press()
    check(ack == "close_all=started" and not launched[0][1] and os.path.exists(HALT_F),
          "close_all with no restart record: exactly as before (HALT, no pass)")
finally:
    cl.subprocess.Popen, cl._capital_only_unflattenable, cl._flatten_already_running = \
        real_popen, real_cap, real_running
    for f_ in (HALT_F, PASS_FILE, HB_F, MARKER_F):
        if os.path.exists(f_):
            os.remove(f_)

# flatten itself — in its OWN copied workspace and process: flatten.py chdirs to
# the workspace it lives in and reads that workspace's .env, so it must never
# run from the repo (a repo .env with real keys would be read and closed).
wsF = os.path.join(TMP, "wsF")
for d in ("lib", "manager"):
    shutil.copytree(os.path.join(ROOT, d), os.path.join(wsF, d),
                    ignore=shutil.ignore_patterns("__pycache__", "*.json", ".env"))
os.makedirs(os.path.join(wsF, "state"))
assert not os.path.exists(os.path.join(wsF, ".env"))
json.dump({"reason": "machine_restart"}, open(os.path.join(wsF, "state", "reconciler_stopped.json"), "w"))
FL_PROBE = ("import json, runpy; ns = runpy.run_path('manager/flatten.py'); r = ns['flatten'](); "
            "print(json.dumps({'r': r, 'granted': ns['guard']._close_all_granted}))")


def run_flatten():
    out = subprocess.run([sys.executable, "-c", FL_PROBE], cwd=wsF, capture_output=True, text=True)
    try:
        return json.loads(out.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return {"error": out.stderr[-300:]}


res = run_flatten()
errs = json.load(open(os.path.join(wsF, "manager", "order_errors.json"))) \
    if os.path.exists(os.path.join(wsF, "manager", "order_errors.json")) else []
check(res.get("r") is False and not res.get("granted") and not os.path.exists(os.path.join(wsF, "state", "HALT"))
      and any("close positions at the exchange yourself" in json.dumps(e, ensure_ascii=False) for e in errs)
      and not any("全部平倉" in json.dumps(e, ensure_ascii=False) for e in errs),
      f"flatten run by hand / by the agent during a restart stop (no pass): nothing closed, no HALT, "
      f"the order_errors row sends the user to the exchange, not to a button that does not exist ({res})")
json.dump({"ts": time.time()}, open(os.path.join(wsF, guard.CLOSE_ALL_PASS_PATH), "w"))
res = run_flatten()
check(res.get("granted") is True and not os.path.exists(os.path.join(wsF, "state", "HALT"))
      and os.path.exists(os.path.join(wsF, "state", "reconciler_stopped.json")),
      f"flatten launched by 全部平倉 (pass present): claims it, adds no HALT, record kept ({res})")

# paper reset_account is not an order
record(True)
try:
    paper.reset_account({})
    reset_ok = True
except guard.Halted:
    reset_ok = False
record(False)
check(reset_ok, "paper reset_account during a restart stop: not an order, not refused")

# ── part 4: Type B runner + healthcheck (N1)
shutil.copytree(os.path.join(ROOT, "manager"), os.path.join(TMP, "wsB", "manager"))
wsB = os.path.join(TMP, "wsB")
os.makedirs(os.path.join(wsB, "strategies", "tb"))
os.makedirs(os.path.join(wsB, "state", "heartbeat"))
open(os.path.join(wsB, "strategies", "tb", "strategy.py"), "w").write(
    "open('ran', 'w').write('1'); raise SystemExit(3)\n")
json.dump({"reason": "machine_restart"}, open(os.path.join(wsB, "state", "reconciler_stopped.json"), "w"))
r = subprocess.run(["bash", "manager/run_strategy.sh", "tb"], cwd=wsB, capture_output=True, text=True,
                   env={**os.environ, "PATH": os.environ.get("PATH", "")})
log = open(os.path.join(wsB, "strategies", "tb", "strategy.log")).read() \
    if os.path.exists(os.path.join(wsB, "strategies", "tb", "strategy.log")) else ""
check(r.returncode == 0 and not os.path.exists(os.path.join(wsB, "ran"))
      and "machine restarted" in log and not os.path.exists(os.path.join(wsB, "state", "heartbeat", "tb")),
      "Type B run during a restart stop: strategy not run, exit 0 (no strategy_failed), one log "
      "line, heartbeat NOT touched")
os.remove(os.path.join(wsB, "state", "reconciler_stopped.json"))
r = subprocess.run(["bash", "manager/run_strategy.sh", "tb"], cwd=wsB, capture_output=True, text=True)
check(r.returncode == 3 and os.path.exists(os.path.join(wsB, "ran")),
      "…no record: the strategy runs (and its crash is still a crash)")

hc_src = os.path.join(wsB, "manager", "healthcheck.py")
json.dump({"tb": {"type": "wait_for_bar", "expect_every_minutes": 5,
                  "registered_at": "2020-01-01T00:00:00"},
           "tc": {"type": "cron", "expect_every_minutes": 5,
                  "registered_at": "2020-01-01T00:00:00"}},
          open(os.path.join(wsB, "state", "deployments.json"), "w"))
os.makedirs(os.path.join(wsB, "strategies", "tc"))
open(os.path.join(wsB, "strategies", "tc", "strategy.py"), "w").write("pass\n")
probe = ("import sys, os; os.chdir(%r); sys.path.insert(0, %r); "
         "sys.argv=['x']; import importlib.util as u; "
         "s=u.spec_from_file_location('hc', %r); m=u.module_from_spec(s); s.loader.exec_module(m); "
         "m._read_crontab=lambda: ''; print(repr(m.health_report()[1]))") % (wsB, wsB, hc_src)
json.dump({"reason": "machine_restart"}, open(os.path.join(wsB, "state", "reconciler_stopped.json"), "w"))
paused = subprocess.run([sys.executable, "-c", probe], capture_output=True, text=True).stdout.strip()
os.remove(os.path.join(wsB, "state", "reconciler_stopped.json"))
running = subprocess.run([sys.executable, "-c", probe], capture_output=True, text=True).stdout.strip()
check("tb" not in paused and "tb" in running,
      f"healthcheck: a stale run during a restart stop is the pause, not a problem; "
      f"without the record the same state is reported ({running[:60]})")
check("tc" in paused and "no crontab entry" in paused,
      f"H2: during the pause a STRUCTURAL problem (crontab line gone) is still reported ({paused[:90]})")

os.chdir(cwd)
shutil.rmtree(TMP, ignore_errors=True)
print("\nFAILED" if fails else "\nall ok")
sys.exit(1 if fails else 0)
