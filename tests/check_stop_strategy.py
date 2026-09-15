"""Minimal check for manager/stop_strategy.py + manager/close_symbol.py — no network,
never touches the real crontab, processes or exchange (all stubbed below).

Covers the uid 30979 incident (2026-09): the agent hand-wrote a close script whose
key lookup fell back to the generic BingX key, and grep -v'd crontab leaving a
strategies/<name>/position_monitor.py line and two registry entries behind.

Asserts: schedule/process matching (monitor lines, --also names, siblings, comments,
argv[0] python/bash only); explicit key names refuse without fallback or values,
strip every other credential and demo flag; conflict detection (named key literal,
generic key needs the venue named, non-.py files scanned, running process = live,
portfolio member, exclude); -SWAP normalization; the close flow on fake venue libs
(size from the post-cancel re-read, hedge refusal, no position = no cancel + exit 3,
named key never writes orders.jsonl/ledger, unlistable or surviving conditional
orders = exit 1); stop() refusals, exit 3 when nothing matches, kill + PermissionError,
flatten crash still unregisters and exits 1.

Run: cd blaveclaw-config && python3 tests/check_stop_strategy.py
"""
import json
import os
import subprocess
import sys
import tempfile
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "manager"))

import close_symbol as cs  # noqa: E402
import stop_strategy as ss  # noqa: E402
import lib.portfolio as portfolio  # noqa: E402
from lib import guard  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


def captured(fn, *a, **kw):
    import contextlib, io
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = fn(*a, **kw)
    return code, buf.getvalue()


def refused(fn, *a, **kw):
    try:
        fn(*a, **kw)
    except cs.Refused as e:
        return str(e)
    return None


def _no_subprocess(*a, **kw):
    raise AssertionError(f"real subprocess call attempted: {a[:1]}")


subprocess.run = _no_subprocess  # every module's subprocess.run is this object
ss.time.sleep = lambda s: None
ss.WAIT_S = 0

# ── lib/guard scoped halt ───────────────────────────────────────────────────
os.chdir(tempfile.mkdtemp(prefix="scopedhalt-"))
check(not guard.halted_for("poi") and guard.halt_info_for("poi") is None, "no halt → halted_for False")
guard.trip_halt_for("poi", "dd stop", "poi_monitor")
check(guard.halt_path_for("poi") == "state/HALT_poi" and os.path.exists("state/HALT_poi"),
      "trip_halt_for writes state/HALT_<strategy>")
check(guard.halted_for("poi") and not guard.halted_for("other") and not guard.halted(),
      "scoped halt stops only that strategy, never the global HALT")
check(guard.halt_info_for("poi")["source"] == "poi_monitor", "halt_info_for returns attribution")
with open("state/HALT_other", "w") as f:
    f.write("{not json")
check(guard.halted_for("other") and "unreadable" in guard.halt_info_for("other")["reason"],
      "unreadable scoped file still halts")
guard.trip_halt("user", "user")
check(guard.halted_for("third") and guard.halt_info_for("poi")["source"] == "user",
      "global HALT → halted_for True for every strategy, global info wins")
guard.clear_halt("user")
guard.clear_halt_for("poi", "user")
check(not guard.halted_for("poi") and guard.halted_for("other"), "clear_halt_for removes only its own file")
with open("state/audit.jsonl") as f:
    ev = [json.loads(l) for l in f]
check(any(e["event"] == "halt_tripped" and e.get("scope") == "poi" for e in ev), "scoped trip audited with scope")

# ── schedule matching ───────────────────────────────────────────────────────
CRON = "\n".join([
    "*/30 * * * * cd /w && python3 manager/healthcheck.py",
    "0 * * * * cd /w && bash manager/run_strategy.sh xrp_5x_v2 >> /tmp/x.log 2>&1",
    "* * * * * cd /w && python3 manager/wait_for_bar.py xrp_5x_v2",
    "* * * * * cd /w && python3 strategies/xrp_5x_v2/position_monitor.py",
    "0 * * * * cd /w && bash manager/run_strategy.sh xrp_5x_v2_old",
    "# 0 * * * * bash manager/run_strategy.sh xrp_5x_v2",
    "* * * * * cd /w && python3 strategies/xrp_5x_v2.py",
    "* * * * * cd /w && python3 strategies/other_mon/run.py",
])
kept, dropped = ss.drop_schedule_lines(CRON, ["xrp_5x_v2"])
check(len(dropped) == 4, f"drops the 4 lines that run xrp_5x_v2 (got {len(dropped)})")
check("xrp_5x_v2_old" in kept and "healthcheck.py" in kept, "keeps sibling + unrelated lines")
check("# 0 * * * * bash manager/run_strategy.sh xrp_5x_v2" in kept, "leaves comments alone")
check(len(ss.drop_schedule_lines(CRON, ["xrp_5x_v2", "other_mon"])[1]) == 5, "--also names matched too")

PS = "\n".join([
    f"{os.getpid()} python3 strategies/xrp_5x_v2/position_monitor.py",
    "101 /usr/bin/python3 strategies/xrp_5x_v2/position_monitor.py",
    "102 bash manager/run_strategy.sh xrp_5x_v2",
    "103 vim strategies/xrp_5x_v2/strategy.py",
    "104 grep strategies/xrp_5x_v2/",
    "105 /bin/sh -c cd /w && python3 strategies/xrp_5x_v2/position_monitor.py",
    "106 python3.11 manager/wait_for_bar.py xrp_5x_v2_old",
])
check(cs.running_pids("xrp_5x_v2", PS) == [101, 102],
      f"only python/bash argv[0], never self/editor/grep/sh (got {cs.running_pids('xrp_5x_v2', PS)})")

# ── key resolution ──────────────────────────────────────────────────────────
ENV = {"BINGX_API_KEY": "GENERIC_K", "BINGX_SECRET_KEY": "GENERIC_S", "BINGX_DEMO": "true",
       "BINGX_API_KEY_XRP_V2": "SUB_K", "BINGX_SECRET_KEY_XRP_V2": "SUB_S",
       "BINGX_DEMO_XRP_V2": "true", "BLAVE_API_KEY": "b"}
msg = refused(cs.resolve_keys, ENV, "bingx", "BINGX_API_KEY_ETH", "BINGX_SECRET_KEY_ETH")
check(msg is not None and "BINGX_API_KEY_XRP_V2" in msg, "missing name refuses and lists names present")
check(msg is not None and not any(v in msg for v in ("GENERIC", "SUB_")), "refusal never prints a value")
check(refused(cs.resolve_keys, ENV, "bingx") is not None, "no key names → refused (no implicit generic)")
scoped, name, generic = cs.resolve_keys(ENV, "bingx", "BINGX_API_KEY_XRP_V2", "BINGX_SECRET_KEY_XRP_V2")  # gitleaks:allow (env var names, not secrets)
check(scoped["BINGX_API_KEY"] == "SUB_K" and scoped["BINGX_SECRET_KEY"] == "SUB_S" and not generic,
      "named key mapped onto the lib's names, not generic")
check("GENERIC_K" not in scoped.values() and "BINGX_API_KEY_XRP_V2" not in scoped
      and scoped["BINGX_DEMO"] == "false", "other creds stripped; no --demo-name → demo false")
scoped, _, _ = cs.resolve_keys(ENV, "bingx", "BINGX_API_KEY_XRP_V2", "BINGX_SECRET_KEY_XRP_V2",  # gitleaks:allow
                               demo_name="BINGX_DEMO_XRP_V2")
check(scoped["BINGX_DEMO"] == "true", "--demo-name is the only demo source")
check(cs.resolve_keys(ENV, "bingx", "BINGX_API_KEY", "BINGX_SECRET_KEY")[2], "generic name → generic")
check(refused(cs.resolve_keys, {"OKX_API_KEY": "k", "OKX_SECRET_KEY": "s"}, "okx",
              "OKX_API_KEY", "OKX_SECRET_KEY") is not None, "OKX without --passphrase-name refuses")
scoped, _, _ = cs.resolve_keys({"GATE_API_KEY": "g", "GATEIO_API_KEY_A": "a", "GATEIO_SECRET_KEY_A": "s"},
                               "gateio", "GATEIO_API_KEY_A", "GATEIO_SECRET_KEY_A")
check("GATE_API_KEY" not in scoped and scoped["GATE_DEMO"] == "false", "gateio: both spellings stripped")
os.environ["BINGX_DEMO"] = "true"
cs._scrub_process_demo("bingx")
check("BINGX_DEMO" not in os.environ, "process-env demo flag scrubbed")

# ── conflict detection ──────────────────────────────────────────────────────
ws = tempfile.mkdtemp(prefix="stopstrat-")
os.chdir(ws)
files = {
    "xrp_5x_v2/strategy.py": 'K = env.get("BINGX_API_KEY_XRP_V2") or env.get("BINGX_API_KEY")\nS="XRP-USDT"',
    "xrp_other_key/strategy.py": 'K = env["BINGX_API_KEY_OTHER"]\nSYMBOL="XRPUSDT"  # bingx',
    "xrp_generic/strategy.py": 'from lib.order_bingx import close_position\nSYMBOL = "XRP/USDT"',
    "xrp_okx/strategy.py": 'from lib.order_okx import close_position\nSYMBOL = "XRPUSDT"',
    "xrp_params/strategy.py": 'from lib import order_bingx\nP = load("params.json")',
    "xrp_params/params.json": '{"symbol": "XRP_USDT"}',
    "xrp_daemon/monitor.py": 'import lib.order_bingx\nSYMBOL = "XRPUSDT"',
    "xrp_unscheduled/strategy.py": 'import lib.order_bingx\nSYMBOL = "XRPUSDT"',
    "xrp_member/strategy.py": 'SYMBOL = "XRPUSDT"',
    "xrpl_lookalike/strategy.py": 'import lib.order_bingx\nSYMBOL = "XRPLUSDT"',
    "xrp_logs_only/strategy.py": 'import lib.order_bingx\nSYMBOL = "DOGEUSDT"',
    "xrp_logs_only/fills.csv": 'XRPUSDT,1,2',
    "xrp_logs_only/run.log": 'XRPUSDT filled',
}
for rel, src in files.items():
    os.makedirs(os.path.dirname(f"strategies/{rel}"), exist_ok=True)
    with open(f"strategies/{rel}", "w") as f:
        f.write(src)
sched = "\n".join(f"* * * * * bash manager/run_strategy.sh {n}" for n in
                  ("xrp_5x_v2", "xrp_other_key", "xrp_generic", "xrp_okx", "xrp_params", "xrpl_lookalike",
                   "xrp_logs_only"))
ps = "900 python3 strategies/xrp_daemon/monitor.py"
members = {"xrp_member": "bingx"}
c, scanned = cs.find_conflicts("strategies", sched, ps, members, "bingx", "BINGX_API_KEY_XRP_V2",
                               "XRPUSDT", False)
check(c == ["xrp_5x_v2"], f"named key: only the live strategy naming that key (got {c})")
check(len(scanned) == len({r.split('/')[0] for r in files}), "every strategy dir is listed as scanned")
c, _ = cs.find_conflicts("strategies", sched, ps, members, "bingx", "BINGX_API_KEY", "XRPUSDT", True)
check(sorted(c) == ["xrp_5x_v2", "xrp_daemon", "xrp_generic", "xrp_member", "xrp_params"],
      f"generic: fallback, running daemon, params.json, member; not other key/okx/unscheduled/XRPL/csv+log (got {c})")
c, _ = cs.find_conflicts("strategies", sched, "", {"xrp_member": "okx"}, "bingx", "BINGX_API_KEY",
                         "XRPUSDT", True, exclude=("xrp_5x_v2",))
check(sorted(c) == ["xrp_generic", "xrp_params"], f"member on another venue, dead daemon, excluded skipped (got {c})")

# ── refusals ────────────────────────────────────────────────────────────────
os.makedirs("lib")
for f in ("account_bingx.py", "order_bingx.py"):
    open(f"lib/{f}", "w").close()
for args, why in ((("bingx", "XRPUSDT@spot", "long"), "@spot"),
                  (("capital", "TX00", "long"), "non-perp venue"),
                  (("okx", "XRPUSDT", "long"), "venue without libs"),
                  (("bingx", "XRPUSDT", "both"), "bad side")):
    check(refused(cs.validate, *args) is not None, f"refuses {why}")
check(cs.validate("bingx", "xrp-usdt-swap", "short") == "XRPUSDT", "validate strips -SWAP and dashes")

# ── close flow on fake venue libs ───────────────────────────────────────────
calls = []
portfolio._append_reconciler_log = lambda o: calls.append(("log", o["symbol"]))
portfolio.zero_ledger_symbols = lambda s: calls.append(("zero", sorted(s)))
portfolio._record_order_error = lambda *a: calls.append(("err",))
cs.wait_inflight = lambda sym: calls.append(("inflight", sym))


def fake_venue(mod_name, positions, regular=(), algo=(), cancel_all=True, algo_lister=True,
               size_after_cancel=None, algo_survives=False):
    acct = types.ModuleType("lib.account_x")
    order = types.ModuleType(mod_name)
    st = {"pos": [dict(p) for p in positions], "reg": list(regular), "algo": list(algo)}
    acct.get_equity = lambda env: {"equity": 100.0}
    acct.get_positions = lambda env: [dict(p) for p in st["pos"]]
    order.get_open_orders = lambda env, sym: list(st["reg"])
    if algo_lister:
        order.get_open_algo_orders = lambda env, sym, **kw: list(st["algo"])

    def _cancelled():
        calls.append(("cancel",))
        st["reg"] = []
        if not algo_survives:
            st["algo"] = []
        if size_after_cancel is not None:
            st["pos"][0]["size"] = size_after_cancel
    if cancel_all:
        order.cancel_all_orders = lambda env, sym: _cancelled()
    else:
        order.cancel_order = lambda env, sym, oid: _cancelled()
    order.format_qty = lambda env, sym, q: str(q)

    def close(env, sym, side, qty, client_order_id=None):
        calls.append(("close", side, qty))
        st["pos"] = [p for p in st["pos"] if p["side"] != side]
        return {"avg_price": 0.5, "executed_qty": qty}
    order.close_position_partial = close
    return acct, order


def ctx_for(acct, order, generic=True, side="long"):
    return cs.Ctx(venue="bingx", sym="XRPUSDT", side=side, env={}, key="K", generic=generic,
                  acct=acct, order=order)


LONG = [{"symbol": "XRP-USDT", "side": "long", "size": 5.0, "mark_price": 0.5}]
calls.clear()
a, o = fake_venue("lib.order_bingx", LONG, regular=[{"order_id": "1"}], size_after_cancel=4.0)
code = cs.run_close(ctx_for(a, o))
check(code == cs.OK and ("close", "long", 4.0) in calls, f"closes the post-cancel size (code {code})")
check(calls.index(("cancel",)) < calls.index(("close", "long", 4.0)), "cancel before close")
check(("log", "XRPUSDT") in calls and ("zero", ["XRPUSDT"]) in calls, "generic key → orders.jsonl + ledger zeroed")
check(("inflight", "XRPUSDT") in calls, "waits for in-flight executions on the symbol")

calls.clear()
a, o = fake_venue("lib.order_bingx", LONG)
check(cs.run_close(ctx_for(a, o, generic=False)) == cs.OK and not any(c[0] in ("log", "zero") for c in calls),
      "named key → no orders.jsonl / ledger writes")

calls.clear()
a, o = fake_venue("lib.order_bingx", LONG + [{"symbol": "XRPUSDT", "side": "short", "size": 1, "mark_price": 0.5}])
check(refused(cs.run_close, ctx_for(a, o)) is not None and not any(c[0] in ("cancel", "close") for c in calls),
      "hedge (both sides) → refused, nothing cancelled or closed")

calls.clear()
a, o = fake_venue("lib.order_bingx", [], regular=[{"order_id": "9"}])
out = captured(cs.run_close, ctx_for(a, o))
check(out[0] == cs.NO_POSITION and ("cancel",) not in calls and "WARNING" in out[1] and "9" in out[1],
      "no position → exit 4, leftover orders listed, not cancelled")

calls.clear()
a, o = fake_venue("lib.order_someagentlib", LONG, cancel_all=False, algo_lister=False)
check(cs.run_close(ctx_for(a, o)) == cs.FAILED and ("close", "long", 5.0) in calls,
      "lib that cannot list conditional orders → closes but exit 1")

calls.clear()
a, o = fake_venue("lib.order_bybit", LONG, algo=[{"order_id": "tp"}], algo_survives=True)
check(cs.run_close(ctx_for(a, o)) == cs.FAILED, "conditional order still listed after the cancel → exit 1")

calls.clear()
a, o = fake_venue("lib.order_bingx", LONG)
check(cs.run_close(ctx_for(a, o), dry_run=True) == cs.OK and not any(c[0] in ("cancel", "close") for c in calls),
      "dry run sends nothing")

calls.clear()
a, o = fake_venue("lib.order_okx", LONG, regular=[{"ordId": "r1"}, {"ordId": "r2"}],
                  algo=[{"algoId": "a1", "ordType": "conditional"}, {"algoId": "a2", "ordType": "move_order_stop"}],
                  cancel_all=False)
o.CLOSE_ALGO_ORD_TYPES = ("conditional", "oco", "trigger", "move_order_stop")
o.get_open_algo_orders = lambda env, sym, ord_types=("conditional",): (
    calls.append(("algo_types", tuple(ord_types))) or ([] if ("cancel",) in calls else
                                                      [{"algoId": "a1"}, {"algoId": "a2"}]))
o.cancel_order = lambda env, sym, oid: calls.append(("cancel_order", oid))
o.cancel_algo_order = lambda env, sym, aid: calls.append(("cancel_algo", aid)) or calls.append(("cancel",))
o.get_open_orders = lambda env, sym: [] if ("cancel",) in calls else [{"ordId": "r1"}, {"ordId": "r2"}]
code = cs.run_close(ctx_for(a, o))
check(("algo_types", o.CLOSE_ALGO_ORD_TYPES) in calls, "OKX lists all four algo types")
check([c[1] for c in calls if c[0] == "cancel_order"] == ["r1", "r2"]
      and [c[1] for c in calls if c[0] == "cancel_algo"] == ["a1", "a2"] and code == cs.OK,
      f"OKX cancels each regular and each algo row (code {code})")

# failures after the cancel: never silent, never exit 0
calls.clear()
a, o = fake_venue("lib.order_bingx", LONG)
reads = {"n": 0}
real_positions = a.get_positions


def flaky_positions(env):
    reads["n"] += 1
    if reads["n"] == 2:  # the re-read right after the cancel
        raise ConnectionError("timeout")
    return real_positions(env)


a.get_positions = flaky_positions
code, out = captured(cs.run_close, ctx_for(a, o))
check(code == cs.FAILED and ("close", "long", 5.0) in calls,
      f"re-read fails after cancel → closes the pre-cancel size, exit 1 (code {code})")

calls.clear()
a, o = fake_venue("lib.order_bingx", LONG)
o.close_position_partial = lambda *a_, **k: (_ for _ in ()).throw(RuntimeError("rejected"))
code, out = captured(cs.run_close, ctx_for(a, o))
check(code == cs.FAILED and "UNPROTECTED" in out, "close fails after cancel → UNPROTECTED warning, exit 1")

calls.clear()
a, o = fake_venue("lib.order_bingx", LONG)
a.get_positions = lambda env: (_ for _ in ()).throw(ConnectionError("down"))
msg = refused(cs.run_close, ctx_for(a, o))
check(msg is not None and "nothing changed" in msg and ("cancel",) not in calls,
      "exchange read fails before any change → refused (exit 2), nothing cancelled")
cs.read_env = lambda path: {"BINGX_API_KEY": "k", "BINGX_SECRET_KEY": "s"}
cs.read_schedules = lambda: ""
cs.load_members = lambda: (_ for _ in ()).throw(OSError("disk"))
msg = refused(cs.prepare, "bingx", "XRPUSDT", "long", "BINGX_API_KEY", "BINGX_SECRET_KEY")
check(msg is not None and "nothing changed" in msg, "unexpected prepare error → refused (exit 2)")

# ── stop() ──────────────────────────────────────────────────────────────────
os.makedirs("state")
REG = {"xrp_5x_v2": {"type": "cron"}, "xrp_v2_monitor": {"type": "daemon"}, "keep": {}}
with open("state/deployments.json", "w") as f:
    json.dump(REG, f)
box = {"cron": CRON, "ps": "\n".join(PS.splitlines()[1:]), "killed": []}
ss.crontab = lambda: box["cron"]
ss.write_crontab = lambda t: box.update(cron=t)
cs.read_processes = lambda: box["ps"]
cs.load_members = lambda: {"btc_ti_long": "okx"}


def fake_kill(pid, sig):
    box["killed"].append((pid, sig))
    box["ps"] = "\n".join(l for l in box["ps"].splitlines() if not l.startswith(f"{pid} "))


ss.os.kill = fake_kill
check("下單設定" in (refused(ss.stop, "btc_ti_long") or ""), "portfolio member refused")
check(refused(ss.stop, "xrp_5x_v2", also=["btc_ti_long"]) is not None, "--also portfolio member refused")
check(ss.stop("nope_strategy") == ss.NOT_MATCHED and box["cron"] == CRON, "nothing matched → exit 3, crontab untouched")

code = ss.stop("xrp_5x_v2", also=["xrp_v2_monitor"])
with open("state/deployments.json") as f:
    left = json.load(f)
check(code == cs.OK, f"full stop verifies clean (code {code})")
check("xrp_5x_v2 " not in box["cron"] and "position_monitor" not in box["cron"]
      and "xrp_5x_v2_old" in box["cron"], "monitor + run lines removed, sibling kept")
check(sorted(p for p, _ in box["killed"]) == [101, 102], "only matching python/bash processes killed")
check(list(left) == ["keep"], "both registry names unregistered")
with open("state/HALT_xrp_5x_v2") as f:
    h = json.load(f)
check(h["source"] == "stop_strategy" and "stop_strategy" in h["reason"]
      and not os.path.exists("state/HALT_xrp_v2_monitor") and not os.path.exists("state/HALT"),
      "stop writes the scoped halt for <name> only — not --also, not global")

# scoped halt names beyond the dir name; existing halts kept; crontab write failure
os.makedirs("strategies/poi_live_05", exist_ok=True)
with open("strategies/poi_live_05/strategy.py", "w") as f:
    f.write('STRATEGY_SLUG = "POI_Live_05"\n')
with open("strategies/poi_live_05/position_monitor.py", "w") as f:
    f.write('from lib.guard import trip_halt_for, halted_for\nif halted_for("POI_Live_05"): pass\n'
            'trip_halt_for( "POI_DD" , "dd", "mon")\nhalted_for(slug_var)\n')
check(ss.halt_scopes("poi_live_05", ["POI_Extra"]) == ["poi_live_05", "POI_Live_05", "POI_DD", "POI_Extra"],
      f"halt scopes: dir + STRATEGY_SLUG + literal *_for args + --halt-scope (got {ss.halt_scopes('poi_live_05', ['POI_Extra'])})")
check(refused(ss.stop, "poi_live_05", halt_scope=["../x"]) is not None, "bad --halt-scope refused")

guard.trip_halt_for("POI_Live_05", "DD breaker 12%", "poi_monitor")
POI_CRON = "* * * * * cd /w && python3 strategies/poi_live_05/position_monitor.py"
box.update(cron=POI_CRON, ps="")


def failing_write(text):
    raise subprocess.CalledProcessError(1, ["crontab", "-"])


ss.write_crontab = failing_write
code, out = captured(ss.stop, "poi_live_05", halt_scope=["POI_Extra"])
with open("state/HALT_POI_Live_05") as f:
    kept = json.load(f)
check(code == cs.FAILED and box["cron"] == POI_CRON and "NOT removed" in out and "verify" in out,
      f"crontab write fails → halts written, schedules kept, verify printed, exit 1 (code {code})")
check(kept["reason"] == "DD breaker 12%" and "already set, kept" in out,
      "an existing scoped halt is not overwritten")
check(all(os.path.exists(f"state/HALT_{x}") for x in ("poi_live_05", "POI_DD", "POI_Extra")),
      "every scope written")
ss.write_crontab = lambda t: box.update(cron=t)

with open("state/deployments.json", "w") as f:
    json.dump(REG, f)
box.update(cron=CRON, ps="101 python3 strategies/xrp_5x_v2/position_monitor.py", killed=[])


def deny_kill(pid, sig):
    raise PermissionError


ss.os.kill = deny_kill
check(ss.stop("xrp_5x_v2") == cs.FAILED, "PermissionError on kill → exit 1")

ss.os.kill = fake_kill
with open("state/deployments.json", "w") as f:
    json.dump(REG, f)
box.update(cron=CRON, ps="")
a, o = fake_venue("lib.order_bingx", LONG)
cs.prepare = lambda *args, **kw: ctx_for(a, o)
cs.run_close = lambda ctx: (_ for _ in ()).throw(RuntimeError("venue down"))
code = ss.stop("xrp_5x_v2", flatten={"venue": "bingx", "symbol": "XRPUSDT", "side": "long"})
with open("state/deployments.json") as f:
    left = json.load(f)
check(code == cs.FAILED and "xrp_5x_v2" not in left, "flatten crash → still unregistered, exit 1")

with open("state/deployments.json", "w") as f:
    json.dump(REG, f)
box.update(cron=CRON)
a, o = fake_venue("lib.order_bingx", LONG + [{"symbol": "XRPUSDT", "side": "short", "size": 1, "mark_price": 1}])
cs.prepare = lambda *args, **kw: ctx_for(a, o)
check(refused(ss.stop, "xrp_5x_v2", flatten={"venue": "bingx", "symbol": "XRPUSDT", "side": "long"})
      is not None and box["cron"] == CRON, "hedge found in preflight → refused before any schedule change")

a, o = fake_venue("lib.order_bingx", LONG)
a.get_positions = lambda env: (_ for _ in ()).throw(ConnectionError("down"))
cs.prepare = lambda *args, **kw: ctx_for(a, o)
check(refused(ss.stop, "xrp_5x_v2", flatten={"venue": "bingx", "symbol": "XRPUSDT", "side": "long"})
      is not None and box["cron"] == CRON, "preflight exchange read fails → refused, crontab untouched")

print("\nall ok" if not fails else f"\n{fails} FAILED")
sys.exit(1 if fails else 0)
