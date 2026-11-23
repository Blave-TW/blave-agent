"""
Auto-iterate: the per-turn counters and brakes behind AGENTS.md › Iteration Brakes
(spec agent-auto-iterate-2026-11-16 + its 2026-11-18 rulings; audit M1–M2, S1–S6, S11, S12).

The agent does not call anything to start counting: lib/runner.py, lib/walk_forward.py and
lib/param_scan.write_scan call in here. Inside an agent turn (BLAVE_TURN_ID, set by
runtime/agent_turn.py) every successful backtest whose code differs from the strategy's
current version is a counted run; the first one in a turn opens a session (round 0, the
baseline), the rest are rounds. The tier and limits come from the turn ledger the runtime
writes at turn start (state/iterate/<turn>.json):

  basic  only the pre-card free credit (account free_only), or status unreadable: 1 round
         (the adopted robust parameters), 3 when the user asked to optimise this turn
  full   card bound, a plan, own engine, cloud: up to 10 rounds, new rounds refused after
         30 minutes into the turn

Strength differs by engine (audit M1): on Claude turns the ledger and iterate.json are
protected by the runtime's Edit deny rules and Bash guard; Codex runs workspace-write and
a BYO agent has no turn at all, so there this prevents misuse, not a determined bypass.

Outside an agent turn (manual runs, the daemon's restore / 更新績效 reruns, BYO over SSH)
nothing is counted or refused; scans still add to params_evaluated.
"""
import ast
import json
import logging
import math
import os
import re
import subprocess
import sys
import time
from pathlib import Path

import lib.strategy as S
from lib.winreplace import atomic_replace, load_json

MAX_ROUNDS = {"basic": 1, "full": 10}
BASIC_ASKED_ROUNDS = 3          # 用戶自己說「幫我優化」:照現行 3 次 (Wei 11-18)
FULL_SESSION_S = 30 * 60        # turn-relative; the runtime's 35-min wall clock leaves the close its 5 minutes
MIN_TRADES = 30                 # fewer trades never becomes the best round
GOOD_P = 0.05
MIXED_GOOD_PCT = 80             # mixed Type C: beat ≥ 80% of random portfolios on Sharpe
BOOT_N = 500
BOOT_SEED = 7
STALE_S = 40 * 60               # an open session from another turn older than this is dead whatever its pid says
QUIET_RERUN_TIMEOUT_S = 15 * 60
STOPS = ("good", "cap", "time", "steps", "credit", "user", "fault", "done")
_TURN_RE = re.compile(r"[0-9a-f]{16}")
# Sizing and the MCPT switch are fixed inside a session (ruling on audit S1): beating the benchmark by
# raising exposure moves return, not the edge, and MCPT = False removes the p-value the stop rule needs.
_LOCKED_RE = re.compile(r"^(MCPT|MCPT_N|SIZE|LEVERAGE\w*|\w+_LEVERAGE|POSITION_SIZE\w*|\w+_SIZE|VOL_TARGET|"
                        r"TARGET_VOL|VOL_CAP|MAX_WEIGHT\w*|GROSS\w*)$")

_prev_hash = {}   # strategy → code hash of its current version when this process's backtest started


class IterateRefused(SystemExit):
    """A refused run: exits like the runner's other refusals (message on stderr, status 1)."""


def _root():
    return Path(S._REPO_ROOT)


def _ledger_path(tid):
    return _root() / "state" / "iterate" / f"{tid}.json"


def _state_path(name):
    return _root() / "strategies" / str(name) / "iterate.json"


def _read(path):
    try:   # the runtime, the backtest and the agent's scripts read these while another process replaces them
        v = load_json(path, encoding="utf-8")
        return v if isinstance(v, dict) else None
    except (OSError, ValueError):
        return None


def _write(path, obj):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".{os.getpid()}.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    atomic_replace(tmp, path)


def turn():
    """This process's agent turn: the ledger dict, or None outside a turn. A turn id with no
    readable ledger (forged, or an older runtime) is a basic turn — fail closed (ruling S6)."""
    tid = os.environ.get("BLAVE_TURN_ID") or ""
    if not tid:
        return None
    led = _read(_ledger_path(tid)) if _TURN_RE.fullmatch(tid) else None
    if not led or led.get("tier") not in MAX_ROUNDS:
        return {"turn": tid, "tier": "basic", "max_rounds": MAX_ROUNDS["basic"], "deadline": None, "unread": True}
    return led


def _load(name):
    st = _read(_state_path(name)) or {}
    for k in ("rounds_total", "params_evaluated", "sessions"):
        st[k] = st[k] if isinstance(st.get(k), int) and st[k] >= 0 else 0
    if not isinstance(st.get("open"), dict):
        st["open"] = None
    return st


def _current_version(name):
    idx = S.load_index(name) or {}
    cur = idx.get("current")
    for item in idx.get("items") or []:
        if isinstance(item, dict) and item.get("n") == cur:
            return cur, item.get("code_hash")
    return None, None


def _locked(src):
    """Module-level sizing / MCPT constants as source text (compared, never evaluated)."""
    out = {}
    try:
        tree = ast.parse(src.decode("utf-8", "replace") if isinstance(src, bytes) else src)
    except SyntaxError:
        return out
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name) and _LOCKED_RE.match(t.id):
                    out[t.id] = ast.dump(node.value)
    return out


def _alive(op):
    if time.time() - (op.get("started") or 0) > STALE_S:
        return False
    pid_s, _, stamp = str(op.get("pid") or "").partition(":")
    if not pid_s.isdigit():
        return True
    from lib.guard import _proc_started
    now = _proc_started(int(pid_s))
    return now is None or not stamp or now == stamp


def _close_as_is(name, st, stop="fault"):
    """Closed as it stands, no revert and no rerun: a session whose turn ended without the runtime's close (killed
    by the bridge; this runs inside a backtest that holds the strategy's lock), or a turn the user stopped."""
    op = st["open"]
    st["last"] = _summary(op, stop, st)
    st["open"] = None
    _write(_state_path(name), st)


def _summary(op, stop, st):
    return {"turn": op.get("turn"), "tier": op.get("tier"), "rounds": max(len(op.get("rounds") or []) - 1, 0),
            "best": op.get("best"), "stop": stop if stop in STOPS else "done",
            "params_evaluated": st.get("params_evaluated", 0), "closed": int(time.time())}


def _refuse(msg):
    raise IterateRefused("❌ " + msg)


def before_backtest(name, src):
    """lib/runner calls this with the backtest lock held, before any data is fetched. Same code as the
    current version → always allowed and never counted (a rerun after an error, the exec-test rerun)."""
    t = turn()
    if t is None or src is None:
        return
    try:
        _, cur_hash = _current_version(name)
        _prev_hash[name] = cur_hash
        if cur_hash and S.hash_matches(src, cur_hash):
            return
        st = _load(name)
        op = st["open"]
        if op and op.get("turn") != t["turn"]:
            if _alive(op):
                _refuse(f"Another conversation is iterating {name} right now. Nothing was run. Wait for it to "
                        "finish, then run this again.")
            _close_as_is(name, st)
            op = None
        if op is None:
            last = st.get("last") or {}
            if last.get("turn") == t["turn"]:   # audit 0.1.59 B-2: a second session would start the round count over
                _refuse(f"{name} was already finished this turn ({last.get('rounds', 0)} round(s), stop={last.get('stop')}). "
                        "Nothing was run. Report the finished version; changing it again is for the next turn.")
            return
        used = len(op.get("rounds") or []) - 1
        if used >= op.get("max_rounds", MAX_ROUNDS["basic"]):
            _refuse(f"Round limit reached for {name} this turn ({used}/{op.get('max_rounds')}, {op.get('tier')} "
                    "tier). Nothing was run. Call lib.iterate.finish('" + str(name) + "') and report.")
        if op.get("deadline") and time.time() > op["deadline"]:
            _refuse(f"This turn's iteration time is used up. Nothing was run. Call "
                    f"lib.iterate.finish('{name}') and report how many rounds were done.")
        moved = sorted(k for k in set(op.get("locked") or {}) | set(_locked(src))
                       if (op.get("locked") or {}).get(k) != _locked(src).get(k))
        if moved:
            _refuse(f"{', '.join(moved)} changed during iteration of {name}. Position size, leverage and the MCPT "
                    "settings stay as they were at the start of this session. Put them back; nothing was run.")
    except IterateRefused:
        raise
    except Exception as e:   # bookkeeping must never be the reason a backtest fails
        logging.warning("iterate: before_backtest skipped: %s", e)


def _sharpe(r):
    n = len(r)
    if n < 2:
        return 0.0
    m = sum(r) / n
    sd = math.sqrt(sum((x - m) ** 2 for x in r) / (n - 1))
    return m / sd * math.sqrt(365) if sd > 0 else 0.0


def _daily(name, n):
    blob = _read(S.versions_dir(name) / f"v{n}.json") or {}
    return dict(zip(blob.get("daily_dates") or [], blob.get("daily_returns") or []))


def improved(name, new_n, best_n):
    """Ruling on audit S2: paired bootstrap over the two versions' common days; the Sharpe difference
    has to exceed one bootstrap standard error. Returns (bool, diff, se)."""
    import numpy as np
    a, b = _daily(name, new_n), _daily(name, best_n)
    days = sorted(set(a) & set(b))
    if len(days) < 30:
        return False, None, None
    x = np.array([a[d] for d in days], dtype=float)
    y = np.array([b[d] for d in days], dtype=float)
    diff = _sharpe(x.tolist()) - _sharpe(y.tolist())
    rng = np.random.default_rng(BOOT_SEED)
    idx = rng.integers(0, len(days), size=(BOOT_N, len(days)))

    def sh(m):
        sd = m.std(axis=1, ddof=1)
        return np.where(sd > 0, m.mean(axis=1) / np.where(sd > 0, sd, 1) * math.sqrt(365), 0.0)

    se = float(np.std(sh(x[idx]) - sh(y[idx]), ddof=1))
    return bool(diff > 0 and diff > se), round(diff, 4), round(se, 4)


def good_enough(stats):
    """Ruling on audit S1, internal stop rule only (never a verdict to the user). Type A: Sharpe beats the
    same symbol's buy-and-hold Sharpe and MCPT p < 0.05 (no p-value = not good). Type C: beats the
    buy-and-hold benchmark's Sharpe; mixed Type C: Sharpe beats ≥ 80% of random portfolios."""
    sharpe = stats.get("Sharpe Ratio")
    if not isinstance(sharpe, (int, float)):
        return False
    if "benchmark_strategy_sharpe_pct" in stats:
        pct = stats.get("benchmark_strategy_sharpe_pct")
        return isinstance(pct, (int, float)) and pct >= MIXED_GOOD_PCT
    bh = stats.get("benchmark_bh")
    if isinstance(bh, dict):
        b = bh.get("sharpe_ratio")
        return isinstance(b, (int, float)) and sharpe > b
    b, p = stats.get("Benchmark Sharpe Ratio"), stats.get("MCPT p-value")
    return isinstance(b, (int, float)) and isinstance(p, (int, float)) and sharpe > b and p < GOOD_P


def _exposure(weights):
    """Peak gross exposure of the run's weights (1-D: one symbol; 2-D: summed across symbols per bar).
    None when there is nothing finite to measure — then exposure is not compared."""
    if weights is None:
        return None
    import numpy as np
    a = np.abs(np.asarray(weights, dtype=float))
    if a.ndim > 1:
        a = np.nansum(a, axis=-1)
    a = a[np.isfinite(a)]
    return float(a.max()) if a.size else None


def _finite(x):
    return isinstance(x, (int, float)) and math.isfinite(x)


def after_backtest(name, src, stats, version, weights=None):
    """lib/runner calls this after stats.json is written and the version minted, still under the lock.
    `weights` is the run's position / weight array; its exposure is measured here so a bad array cannot fail
    the backtest (audit 0.1.59 B-7)."""
    t = turn()
    if t is None or src is None:
        return
    try:
        exposure = _exposure(weights)
        prev = _prev_hash.pop(name, None)
        if prev and S.hash_matches(src, prev):
            return
        st = _load(name)
        op = st["open"]
        if op is None or op.get("turn") != t["turn"]:
            op = {"turn": t["turn"], "tier": t["tier"], "max_rounds": t.get("max_rounds", MAX_ROUNDS["basic"]),
                  "deadline": t.get("deadline"), "started": time.time(), "pid": os.environ.get("BLAVE_TURN_PID"),
                  "locked": _locked(src), "exposure0": exposure, "best": None, "rounds": []}
            st["sessions"] += 1
        trades = stats.get("Trades") if isinstance(stats.get("Trades"), int) else 0
        e0 = op.get("exposure0")
        eligible = trades >= MIN_TRADES and (not _finite(exposure) or not _finite(e0) or exposure <= e0 * (1 + 1e-6) + 1e-12)
        rnd = {"n": version, "trades": trades, "sharpe": stats.get("Sharpe Ratio"), "good": good_enough(stats),
               "eligible": eligible, "kept": False}
        if eligible and version is not None:
            if op.get("best") is None:
                rnd["kept"] = True
            else:
                rnd["kept"], rnd["diff"], rnd["se"] = improved(name, version, op["best"])
            if rnd["kept"]:
                op["best"] = version
        op["rounds"].append(rnd)
        k = len(op["rounds"]) - 1
        if k:
            st["rounds_total"] += 1
        st["params_evaluated"] += 1
        st["open"] = op
        _write(_state_path(name), st)
        _ledger_add(t, name)
        best = next((r for r in op["rounds"] if r["n"] == op.get("best")), None)
        print(f"  Iteration: round {k}/{op['max_rounds']} ({op['tier']}) — "
              + ("baseline" if not k else "kept as best" if rnd["kept"] else
                 "not better than the best round beyond noise" if eligible else
                 f"not eligible ({'fewer than ' + str(MIN_TRADES) + ' trades' if trades < MIN_TRADES else 'exposure went up'})")
              + f"; best so far v{op.get('best')}, good enough: {'yes' if best and best['good'] else 'no'}; "
              f"parameter sets evaluated on this strategy: {st['params_evaluated']}")
    except Exception as e:
        logging.warning("iterate: after_backtest skipped: %s", e)


def _ledger_add(t, name):
    if t.get("unread"):
        return
    path = _ledger_path(t["turn"])
    led = _read(path)
    if led is None:
        return
    names = led.get("strategies") if isinstance(led.get("strategies"), list) else []
    if name not in names:
        led["strategies"] = names + [name]
        _write(path, led)


def _running(op):
    """The flow is running on this session: a round past the baseline, or a parameter scan. A baseline alone is
    what every changed-code backtest opens (an Adopt prompt, a library install as is, "just backtest it"):
    no flow, so the turn's close drops it without a rerun or a telemetry line (audit 0.1.59 B-4)."""
    return len(op.get("rounds") or []) > 1 or bool(op.get("scanned"))


def before_walk_forward(name):
    """Out-of-sample validation does not pick rounds (spec §5): refused while this turn's full-tier flow is
    running. finish() closes it; the walk-forward then runs once on the final version."""
    t = turn()
    if t is None:
        return
    op = _load(name)["open"]
    if op and op.get("turn") == t["turn"] and op.get("tier") == "full" and _running(op):
        _refuse(f"{name} is still being iterated. Out-of-sample validation runs once, after "
                f"lib.iterate.finish('{name}'). Nothing was run.")


def note_params(name, n):
    """lib/param_scan.write_scan: every scanned cell counts toward params_evaluated (ruling on audit S3)."""
    try:
        if not name or not isinstance(n, int) or n <= 0 or not (_root() / "strategies" / str(name)).is_dir():
            return
        st = _load(name)
        st["params_evaluated"] += n
        t, op = turn(), st["open"]
        if t and op and op.get("turn") == t["turn"]:
            op["scanned"] = True
        _write(_state_path(name), st)
    except Exception as e:
        logging.warning("iterate: params count skipped: %s", e)


def _python():
    return sys.executable


def _quiet_rerun(name):
    """The background-style rerun a restore uses: full backtest, mints nothing on the same code, fills the
    成交測試 block (lib/runner _exec_test_wanted), pushes nothing into the chat."""
    env = {**os.environ, "BLAVE_QUIET": "1", "BLAVE_MODE": "backtest", "PYTHONPATH": str(_root())}
    env.pop("BLAVE_EXEC_TEST", None)
    r = subprocess.run([_python(), str(Path("strategies") / str(name) / "strategy.py")], cwd=str(_root()),
                       env=env, capture_output=True, text=True, timeout=QUIET_RERUN_TIMEOUT_S)
    if r.returncode != 0:
        raise RuntimeError(f"rerun of {name} failed: {(r.stderr or r.stdout)[-400:]}")


def revert_to(name, n):
    """Audit S4: version n's code back into strategy.py (lib.strategy.restore: refuses a funded strategy,
    keeps the display name, current → n) and a quiet rerun so stats.json, the chart and the exec test are
    v<n>'s. Not a round, mints nothing. scan.json is kept: it was scanned on this session's code."""
    vdir = S.versions_dir(name)
    out = S.restore(name, n)
    stashed = vdir / "pre-restore" / "scan.json"
    target = _root() / "strategies" / str(name) / "scan.json"
    if stashed.is_file() and not target.exists():
        os.replace(stashed, target)
    _quiet_rerun(name)
    return out


def _source(name):
    p = _root() / "strategies" / str(name) / "strategy.py"
    return p.read_bytes() if p.is_file() else b""


def _exec_test_done(name):
    """stats.json already carries the 成交測試 block computed on the code in the file: the rerun would add nothing."""
    ex = (_read(_root() / "strategies" / str(name) / "stats.json") or {}).get("exec_test")
    return isinstance(ex, dict) and S.hash_matches(_source(name), ex.get("code_hash"))


def finish(name, stop=None):
    """End of the flow for `name`: full tier puts the best round back (revert_to) when the file holds
    another; otherwise an edit made after the last backtest is put back to the current version. Both tiers
    end on one quiet rerun so the final version carries its exec test (skipped when stats.json already has
    it for this code); the session closes and walk-forward is allowed again. `stop` is one of STOPS; None
    infers good / cap / done."""
    st = _load(name)
    op = st["open"]
    t = turn()
    if op and t is not None and op.get("turn") != t["turn"] and _alive(op):
        _refuse(f"Another conversation is iterating {name}; it closes its own session.")
    best = op.get("best") if op else None
    if stop not in STOPS:
        rounds = (op or {}).get("rounds") or []
        best_r = next((r for r in rounds if r["n"] == best), None)
        stop = ("good" if best_r and best_r.get("good") else
                "cap" if op and len(rounds) - 1 >= op.get("max_rounds", 1) else "done")
    cur, cur_hash = _current_version(name)
    if op and op.get("tier") == "full" and best is not None and best != cur:
        revert_to(name, best)
    else:
        if cur is not None and not S.hash_matches(_source(name), cur_hash):
            S.restore(name, cur)   # an edit nobody backtested is not the final version (audit 0.1.59 B-3); restore keeps a copy
        if not _exec_test_done(name):
            _quiet_rerun(name)
    if op:
        st = _load(name)
        st["last"] = _summary(op, stop, st)
        st["open"] = None
        _write(_state_path(name), st)
    last = st.get("last") or {}
    print(f"  Iteration finished for {name}: {last.get('rounds', 0)} round(s), final version v{best or cur}, "
          f"stop={stop}; parameter sets evaluated on this strategy so far: {st['params_evaluated']}. "
          "Out-of-sample validation may run now, once.")
    return last


def plan(name):
    """What the auto flow may do to `name` this turn (spec §3.1; ruling S9 for library installs)."""
    t = turn()
    tier = t["tier"] if t else "full"
    sdir = _root() / "strategies" / str(name)
    src = (sdir / "strategy.py").read_bytes() if (sdir / "strategy.py").is_file() else b""
    m = re.search(rb"^#\s*Type:\s*([ABC])", src, re.M)
    typ = m.group(1).decode() if m else None
    why = None
    try:
        from lib.portfolio import strategy_amounts
        if (strategy_amounts() or {}).get(name, 0) > 0:
            why = "live"
    except Exception:
        why = "live_unknown"
    if why is None and (sdir / "source.json").is_file():
        idx = S.load_index(name) or {}
        v1 = next((i for i in idx.get("items") or [] if isinstance(i, dict) and i.get("n") == 1), None)
        if v1 and S.hash_matches(src, v1.get("code_hash")):
            why = "library"
    if typ == "B":
        why = "type_b"
    op = _load(name)["open"]
    used = len(op["rounds"]) - 1 if op and t and op.get("turn") == t["turn"] else 0
    max_r = t.get("max_rounds", MAX_ROUNDS[tier]) if t else MAX_ROUNDS["full"]
    left = None
    if t and t.get("deadline"):
        left = max(int(t["deadline"] - time.time()), 0)
    return {"tier": tier, "type": typ, "checks_only": why, "adopt": why is None,
            "change_logic": why is None and tier == "full", "rounds_used": max(used, 0), "max_rounds": max_r,
            "seconds_left": left}


def close_turn(tid, stop):
    """runtime/agent_turn calls this (as `python -m lib.iterate close-turn`) when a turn ends however it ends
    (audit M2): every session that turn left open is finished with `stop` — a stopped turn's closed as it
    stands, a baseline-only one dropped (_running). Prints one JSON line: this turn's sessions as
    [{"tier", "stop", "rounds"}] for the auto_iter_* telemetry."""
    os.environ["BLAVE_TURN_ID"] = tid
    led = _read(_ledger_path(tid)) or {}
    out = []
    for name in led.get("strategies") or []:
        st = _load(name)
        op = st["open"]
        try:
            if op and op.get("turn") == tid and not _running(op):
                st["open"] = None
                _write(_state_path(name), st)
            elif op and op.get("turn") == tid and stop == "user":
                _close_as_is(name, st, "user")   # audit 0.1.59 M1: Stop means stop — no revert, no rerun (the shell kills a silent runtime)
            elif op and op.get("turn") == tid:
                finish(name, stop)
        except Exception as e:   # the close must not stop the others; the session closes either way
            logging.warning("iterate: close of %s failed: %s", name, e)
            st = _load(name)
            if st["open"] and st["open"].get("turn") == tid:
                st["last"] = _summary(st["open"], "fault", st)
                st["open"] = None
                _write(_state_path(name), st)
        last = _load(name).get("last") or {}
        if last.get("turn") == tid:
            out.append({"tier": last.get("tier"), "stop": last.get("stop"), "rounds": last.get("rounds", 0)})
    print(json.dumps(out))
    return out


def _main(argv):
    if len(argv) >= 2 and argv[0] == "plan":
        print(json.dumps(plan(argv[1])))
    elif len(argv) >= 2 and argv[0] == "finish":
        finish(argv[1], argv[2] if len(argv) > 2 else None)
    elif len(argv) == 3 and argv[0] == "revert":
        revert_to(argv[1], int(argv[2]))
    elif len(argv) == 3 and argv[0] == "close-turn" and _TURN_RE.fullmatch(argv[1]):
        close_turn(argv[1], argv[2])
    else:
        print("usage: python -m lib.iterate plan NAME | finish NAME [stop] | revert NAME N | close-turn TURN STOP",
              file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
