"""runtime side of auto-iterate (spec agent-auto-iterate-2026-11-16 §3.2, §5, §8; 11-18 rulings; audit M1, M2, M4, M5):
tier per turn (desktop flag, fail-closed basic; cloud full; none without lib/iterate.py or on scheduled turns), the ledger,
the per-turn rule in both sinks, the protection (Edit deny + Bash guard), the stop reason, and the turn-end close that
emits auto_iter chunks before `done`.
Run: cd blave-agent && python3 tests/check_iterate_runtime.py
"""
import io, json, os, re, sys, tempfile, types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))
WS = tempfile.mkdtemp(prefix="check-iterate-rt-")
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.setdefault("BLAVE_AGENT_DB", os.path.join(WS, "session.db"))
os.environ.pop("BLAVE_AGENT_LOCAL", None)
sys.modules["claude_agent_sdk"] = types.ModuleType("claude_agent_sdk")
import agent_turn as at  # noqa: E402

fails = []


def ok(name, fn):
    try:
        cond, detail = fn()
    except Exception as e:
        cond, detail = False, f"{type(e).__name__}: {e}"
    print(("PASS " if cond else "FAIL ") + name + ("" if cond or not detail else f"  → {detail}"))
    if not cond:
        fails.append(name)


sys.path.insert(0, ROOT)
import lib.iterate as li  # noqa: E402
ok("constants match lib/iterate.py (rounds, asked, session length, stops)", lambda: (
    at.ITER_MAX_ROUNDS == li.MAX_ROUNDS and at.ITER_BASIC_ASKED == li.BASIC_ASKED_ROUNDS
    and at.ITER_FULL_SESSION_S == li.FULL_SESSION_S and at._ITER_STOPS == li.STOPS, ""))

local, web, rep = at.LocalSink("desktop-aaaa1111"), at.WebSink("http://x/report", "t", "s1"), at.ReportSink("s1")
ok("no lib/iterate.py in the workspace → no tier (old cloud workspace, audit M4)", lambda: (at.iterate_tier(web, None) is None, ""))
os.makedirs(os.path.join(WS, "lib"))
open(os.path.join(WS, "lib", "iterate.py"), "w").close()
ok("desktop: flag full/basic taken; missing or odd → basic (fail-closed)", lambda: (
    [at.iterate_tier(local, f) for f in ("full", "basic", None, "FULL", "x")] == ["full", "basic", "basic", "basic", "basic"], ""))
ok("cloud (web / Telegram) → full; scheduled report turn → none", lambda: (
    at.iterate_tier(web, "basic") == "full" and at.iterate_tier(rep, "full") is None, ""))


def _ledger():
    led = at.write_iterate_ledger("ab" * 8, "basic", "幫我優化這支")
    disk = json.load(open(os.path.join(WS, "state", "iterate", "ab" * 8 + ".json")))
    full = at.write_iterate_ledger("cd" * 8, "full", "做一支 BTC 均線策略")
    return (led == disk and led["max_rounds"] == 3 and led["user_asked"] and led["deadline"] is None
            and full["max_rounds"] == 10 and full["deadline"] - full["started"] == 1800 and not full["user_asked"]), (led, full)


ok("ledger: basic + 「幫我優化」 → 3 rounds; full → 10 rounds and a 30-minute deadline", _ledger)
ok("ledger: basic without asking → 1 round", lambda: (at.write_iterate_ledger("ef" * 8, "basic", "做一支策略")["max_rounds"] == 1, ""))


def bp(**kw):
    return at.build_prompt("", [], "做一支策略", **kw)


ok("rule in both sinks (TG too) only with a ledger; tier and limit in it", lambda: (
    "基本額度" in bp(iterate={"tier": "basic", "max_rounds": 1}) and "完整額度" in bp(suggest_directive=True, iterate={"tier": "full", "max_rounds": 10})
    and "10 輪" in bp(iterate={"tier": "full", "max_rounds": 10}) and "自動迭代" not in bp() and "自動檢查" not in bp(), ""))
SRC = open(os.path.join(ROOT, "runtime", "agent_turn.py"), encoding="utf-8").read()
ok("both build_prompt call sites pass iterate=iter_led", lambda: (lambda calls: (
    len(calls) == 2 and all("iterate=iter_led" in c for c in calls), calls))(re.findall(r"prompt = build_prompt\((.*?)\)\n", SRC, re.S)))
ok("the turn id is the ledger's (one id, written before the prompt)", lambda: (
    'turn_env["BLAVE_TURN_ID"] = turn_id' in SRC and SRC.index("write_iterate_ledger(turn_id") < SRC.index("prompt = build_prompt("), ""))
ok("session length: desktop and web 30 min; Telegram ends early enough for the close before the bridge kill (audit M2)",
   lambda: (at.iterate_session_s(local) == 1800 and at.iterate_session_s(web) == 1800
            and at.iterate_session_s(at.TelegramSink("tok", "chat")) + at.ITER_CLOSE_TIMEOUT_S <= at._BRIDGE_KILL_SEC
            and "iterate_session_s(sink))" in SRC, ""))
ok("argparse --iter-tier reaches run_turn", lambda: (
    'add_argument("--iter-tier", default=None)' in SRC and "iter_tier=args.iter_tier" in SRC, ""))

ok("Edit deny rules cover lib/iterate.py, the ledger and iterate.json", lambda: (
    all(r in at.PROTECTED_EDIT_RULES for r in ("Edit(/lib/iterate.py)", "Edit(/state/iterate/**)", "Edit(/strategies/**/iterate.json)")), ""))
for cmd, want in [
    ("echo '{}' > strategies/x/iterate.json", True), ("rm state/iterate/abc.json", True), ("sed -i s/1/9/ lib/iterate.py", True),
    ("python3 -c \"open('strategies/x/iterate.json','w').write('{}')\"", True),
    ("cat strategies/x/iterate.json", False), ("python3 -m lib.iterate finish x", False), ("python3 strategies/x/strategy.py > tmp/log 2>&1", False),
]:
    ok(f"iterate_bash_denied({cmd!r}) = {want}", lambda cmd=cmd, want=want: (at.iterate_bash_denied(cmd) is want, ""))
ok("the Bash guard hook chains ITERATE_DENY_REASON", lambda: ("else ITERATE_DENY_REASON if iterate_bash_denied(cmd, ps)" in SRC, ""))

for args, want in [((True, None, False), "user"), ((False, None, True), "time"), ((False, at.FAULT_NO_CREDIT, False), "credit"),
                   ((False, at.FAULT_MAX_TURNS, False), "steps"), ((False, at.FAULT_PARTIAL, False), "fault"), ((False, None, False), "done")]:
    ok(f"iterate_stop{args} = {want}", lambda args=args, want=want: (at.iterate_stop(*args) == want, ""))


def _close():
    seen = {}

    class R:
        returncode, stderr = 0, ""
        stdout = "  Iteration finished …\n" + json.dumps([{"tier": "full", "stop": "good", "rounds": 4},
                                                         {"tier": "basic", "stop": "done", "rounds": 1},
                                                         {"tier": "evil", "stop": "done", "rounds": 1}])

    real = at.subprocess.run
    at.subprocess.run = lambda argv, **kw: (seen.update(argv=argv, kw=kw), R)[1]
    out, sent = io.StringIO(), []
    try:
        real_out, sys.stdout = sys.stdout, out
        try:
            got = at.iterate_turn_end(local, "cd" * 8, "user", {"X": "1"})
        finally:
            sys.stdout = real_out
    finally:
        at.subprocess.run = real
    for line in out.getvalue().splitlines():
        if line.startswith("@@BLAVE@@"):
            sent.append(json.loads(line[9:]))
    want = [{"type": "auto_iter", "done": "full.good", "rounds": "4_6"}, {"type": "auto_iter", "done": "basic.done", "rounds": "1"}]
    return (got == want and [{k: v for k, v in c.items() if k != "session_id"} for c in sent] == want
            and seen["argv"][1:] == ["-m", "lib.iterate", "close-turn", "cd" * 8, "user"]
            and seen["kw"]["cwd"] == at.WORKSPACE and seen["kw"]["env"]["BLAVE_TURN_ID"] == "cd" * 8
            and seen["kw"]["timeout"] == at.ITER_CLOSE_TIMEOUT_S), (got, sent, seen)


ok("turn end: lib closes the turn's sessions; one auto_iter chunk each (bucketed, unknown values dropped)", _close)
ok("no ledger → no close, nothing sent", lambda: (at.iterate_turn_end(local, "99" * 8, "done", {}) == [], ""))


def _pings(stop):
    """audit 0.1.59 M1: the shell kills a runtime silent for STOP_KILL_MS (5 s) after Stop; the close runs after
    turn_stop's pings ended, so the runtime pings by itself while it waits (every gap < 2 s, like turn_stop)."""
    import time as _t

    class R:
        returncode, stderr, stdout = 0, "", "[]"

    real, sent = at.subprocess.run, []
    at.subprocess.run = lambda argv, **kw: (_t.sleep(3.2), R)[1]
    sink = at.LocalSink("desktop-bbbb2222")
    sink._send = lambda c: sent.append((_t.monotonic(), c))
    t0 = _t.monotonic()
    try:
        at.iterate_turn_end(sink, "cd" * 8, stop, {})
    finally:
        at.subprocess.run = real
    times = [t0] + [t for t, c in sent if c == {"type": "ping"}]
    return len(times) - 1, max(b - a for a, b in zip(times, times[1:] + [_t.monotonic()]))


ok("stopped turn: pings while the close runs (≥ 2 in 3.2 s, every gap < 2 s against the shell's 5 s)", lambda: (
    lambda n, gap: (n >= 2 and gap < 2.0, (n, gap)))(*_pings("user")))
ok("…a turn that was not stopped sends no ping (the shell kills only after Stop)", lambda: (_pings("done")[0] == 0, ""))
SHELL_MAIN = open(os.path.join(ROOT, "shell", "main.js"), encoding="utf-8").read()
ok("the shell's silence limit is still the 5 s this ping rhythm is built for", lambda: ("const STOP_KILL_MS = 5000;" in SHELL_MAIN, ""))
ok("close runs before finalize (auto_iter before done), whatever ended the turn", lambda: (
    SRC.index("iterate_turn_end(sink, turn_id, iterate_stop(stopped, fault_code, wall_expired)") < SRC.index("reply_text = sink.finalize()"), ""))

MAIN = open(os.path.join(ROOT, "shell", "main.js"), encoding="utf-8").read()
TEL = open(os.path.join(ROOT, "shell", "telemetry.js"), encoding="utf-8").read()
ok("shell: --iter-tier from account_status.iterate_tier (Blave AI), own engine full, unknown basic", lambda: (
    '"--iter-tier", iterTier,' in MAIN and 'const iterTier = !useBlave ? "full" : lastAcct && Date.now() - lastAcct.at <= ACCT_FRESH_MS && lastAcct.body.iterate_tier === "full" ? "full" : "basic";' in MAIN, ""))
ok("shell: auto_iter chunk → auto_iter_done／auto_iter_rounds, not sent to the window", lambda: (
    'if (c && c.type === "auto_iter") { tm().track("auto_iter_done", { r: c.done }); tm().track("auto_iter_rounds", { n: c.rounds }); continue; }' in MAIN, ""))
ok("telemetry.js whitelists exactly the runtime's values", lambda: (lambda m, r: (
    bool(m) and re.findall(r'"([^"]+)"', m.group(1)) == [f"{t}.{x}" for t in at.ITER_TIERS for x in at._ITER_STOPS]
    and bool(r) and re.findall(r'"([^"]+)"', r.group(1)) == ["0", "1", "2_3", "4_6", "7_10"], ""))(
    re.search(r"auto_iter_done: \{ r: \[([^\]]*)\] \}", TEL), re.search(r"auto_iter_rounds: \{ n: \[([^\]]*)\] \}", TEL)))

print()
print("ALL PASS" if not fails else f"{len(fails)} FAILED: {fails}")
sys.exit(1 if fails else 0)
