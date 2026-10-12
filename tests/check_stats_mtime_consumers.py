"""Enumerate every place that reads stats.json's mtime (0.1.21: a live tick no longer rewrites
stats.json, so its mtime now means "last performance update" — a backtest, a restore's re-run or
a stats_refresh — and never "the strategy is alive"). The set of such readers must EQUAL the
allow-list below (prestudy live-tick-cpu-prestudy-2026-10-10.md §1a): a new reader must be
classified here first (is it reading freshness, or liveness?); a vanished one means someone
removed `ran_at` / `perf.at` and the web's 24 h warning or the 更新績效 caption lost its source.
Liveness readers must keep reading state/heartbeat/<name> and state.json, never stats.json.

Run: cd blave-agent && .venv/bin/python tests/check_stats_mtime_consumers.py
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
fails = []


def ok(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + ("" if cond or not detail else f"  → {detail}"))
    if not cond:
        fails.append(name)


STATS_RE = re.compile(r"stats\.json|statsPath|stats_path|_stats_path\(")
STAT_RE = re.compile(r"getmtime|st_mtime|statSync|lstatSync|mtimeMs|os\.stat\(")
WINDOW = 3
DEF_RE = re.compile(r"^(?:def |function |const |let |var )?\s*(\w+)\s*(?:=\s*)?(?:\(|=>|function)")


def enclosing(lines, i):
    for j in range(i, -1, -1):
        line = lines[j]
        m = re.match(r"^def (\w+)\(", line) or re.match(r"^function (\w+)\(", line) \
            or re.match(r"^const (\w+) = ", line)
        if m:
            return m.group(1)
    return "<module>"


def scan_file(path):
    rel = os.path.relpath(path, ROOT).replace(os.sep, "/")
    with open(path, encoding="utf-8", errors="replace") as f:
        lines = f.read().splitlines()
    hits = set()
    for i, line in enumerate(lines):
        if not STATS_RE.search(line):
            continue
        lo, hi = max(0, i - WINDOW), min(len(lines), i + WINDOW + 1)
        if any(STAT_RE.search(lines[j]) for j in range(lo, hi)):
            hits.add(f"{rel}:{enclosing(lines, i)}")
    return hits


def walk(sub, exts):
    base = os.path.join(ROOT, sub)
    for dp, dns, fns in os.walk(base):
        dns[:] = [d for d in dns if d not in ("node_modules", "dist", "__pycache__", ".venv")]
        for fn in fns:
            if fn.endswith(exts):
                yield os.path.join(dp, fn)


found = set()
for sub in ("lib", "manager", "runtime", "tools"):
    for p in walk(sub, (".py",)):
        found |= scan_file(p)
for p in walk("shell", (".js",)):
    found |= scan_file(p)

ALLOWED = {
    # freshness readers — the meaning stats.json's mtime now has
    "runtime/portfolio_reporter.py:_manager_strategies",   # ran_at → web mgIsStale (24 h), manager 數字截至
    "runtime/strategy_reporter.py:_read_perf",             # perf.at → 更新績效 caption (web + desktop)
    "shell/main.js:stratPerf",                             # desktop-local perf.at, same shape as _read_perf
    "shell/main.js:loadStrategy",                          # stratPerf's leading comment (previous-function attribution)
    "runtime/command_listener.py:_stats_sig",             # the refresh.s before/after signature (mtime_ns, size): did the run write it?
    "runtime/command_listener.py:_refresh_live_stats",     # pre-report sweep: skip if refreshed < 1 h ago
    # change-detection caches, draft-only or existence-only for deployed strategies
    "runtime/strategy_reporter.py:_stats_marker",          # draft → mtime; live/deployed → "exists"
    "runtime/local_daemon.py:strategy_kinds",              # (mtime,size) cache key for the Type C verdict
    "shell/main.js:listStrategies",                        # stratCache key; sort order uses Generated At
    # backtest-path only
    "tools/codex_gate/gate.py:workspace_facts",            # did the warm-up backtest write stats.json
    # window false positive: exists() on stats.json, the stat is on the SOURCE file
    "runtime/strategy_reporter.py:_is_newborn",
}
ok("stats.json mtime readers == the allow-list (new reader: classify it here first; vanished: who lost ran_at/perf.at?)",
   found == ALLOWED, f"unexpected {sorted(found - ALLOWED)}  missing {sorted(ALLOWED - found)}")

# ── the semantics each side relies on ──
pr = open(os.path.join(ROOT, "runtime", "portfolio_reporter.py"), encoding="utf-8").read()
ok("ran_at is still stats.json's st_mtime", 'row["ran_at"] = int(st.st_mtime)' in pr)
sr = open(os.path.join(ROOT, "runtime", "strategy_reporter.py"), encoding="utf-8").read()
ok("perf.at is still stats.json's st_mtime", 'os.stat(os.path.join(sdir, "stats.json")).st_mtime' in sr)
for fn in ("manager/healthcheck.py", "manager/wait_for_bar.py"):
    text = open(os.path.join(ROOT, fn), encoding="utf-8").read()
    hb = [l for l in text.splitlines() if "heartbeat" in l and ("os.path.join" in l or "/" in l)]
    ok(f"{fn}: liveness is state/heartbeat/<name>, never stats.json",
       any("heartbeat" in l for l in hb) and not any("stats" in l for l in hb), hb[:3])
rn = open(os.path.join(ROOT, "lib", "runner.py"), encoding="utf-8").read()
ok("lib/runner.py has no live-tick throttle constant (案 A: the tick never writes stats.json)",
   "STATS_LIVE_REFRESH" not in rn and "_stats_refresh_due" not in rn)

print("FAILED" if fails else "ALL PASS")
sys.exit(1 if fails else 0)
