"""Minimal check: the three event payloads the platform's registry (api openclaw/agent_events.py
SPECS) gained — dead_members, target_stale, bar_stale.computed — land in state/events.jsonl through
the real runtime appender and pass the platform's whitelist untouched.

What it protects: a payload field the platform drops (wrong type, too long, list too long) goes
silently; a value json cannot serialise (a datetime, a numpy bool) makes the runtime appender
return None and the event never exists. Neither raises anywhere anyone would see.

  1. bar_stale: computed is a real bool both ways (also when the caller passes a numpy bool)
  2. dead_members: symbols = only the newly long-dead members, capped at 50; last_trade = the
     newest last bar among them as an ISO date; sent once, not again for the same set
  3. target_stale: keys capped at 20 × 64, age_s a whole number; a bad age_s does not raise
  4. a platform without the new types (before api 252aaa41): bar_stale keeps every field it
     knew, the new types are unknown there — which its ingest acks and drops

Run: cd blave-agent && .venv/bin/python tests/check_new_event_payloads.py
"""
import importlib.util
import json
import math
import os
import sys
import tempfile
import types
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import numpy as np

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


# Mirror of the platform registry rows (api openclaw/agent_events.py SPECS) and its sanitize().
NEW = {
    "bar_stale": {"strategy": 64, "symbol": 40, "minutes": None, "computed": bool},
    "target_stale": {"strategy": 64, "keys": (64, 20), "age_s": None},
    "dead_members": {"strategy": 64, "symbols": (40, 50), "last_trade": 32},
}
OLD = {"bar_stale": {"strategy": 64, "symbol": 40, "minutes": None}}


def sanitize(specs, ev_type, raw):
    fields = specs.get(ev_type)
    if fields is None:
        return None
    out = {}
    for field, cap in fields.items():
        v = raw.get(field)
        if v is None:
            continue
        if cap is bool:
            if isinstance(v, bool):
                out[field] = v
        elif isinstance(cap, tuple):
            if isinstance(v, list):
                out[field] = [x[:cap[0]] for x in v if isinstance(x, str) and x][:cap[1]]
        elif cap is None:
            if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(float(v)):
                out[field] = v
        elif isinstance(v, str):
            out[field] = v[:cap]
    return out


base = tempfile.mkdtemp(prefix="new-events-", dir=os.environ.get("SCRATCHPAD") or None)
os.makedirs(os.path.join(base, "current"))
with open(os.path.join(ROOT, "runtime", "events.py"), encoding="utf-8") as src, \
        open(os.path.join(base, "current", "events.py"), "w", encoding="utf-8") as dst:
    dst.write(src.read())
os.environ["BLAVE_AGENT_BASE"] = base
os.environ["BLAVE_AGENT_WORKSPACE"] = os.path.join(base, "workspace")
EVENTS = os.path.join(base, "workspace", "state", "events.jsonl")

import lib.events as ev  # noqa: E402

ev._appender = None
sent = []
sys.modules["lib.notify"] = types.SimpleNamespace(send_text=lambda t: sent.append(t))
spec = importlib.util.spec_from_file_location("wfb_events", os.path.join(ROOT, "manager", "wait_for_bar.py"))
wfb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wfb)


def landed():
    """Events written since the last call, as the platform would receive them."""
    global _seen
    try:
        lines = open(EVENTS, encoding="utf-8").read().splitlines()
    except OSError:
        lines = []
    new, _seen = lines[_seen:], len(lines)
    return [json.loads(x) for x in new]


_seen = 0


def clean(e):
    """The payload passes the platform whitelist with nothing dropped or cut."""
    return sanitize(NEW, e["type"], e["payload"]) == e["payload"]


# ── 1. bar_stale ────────────────────────────────────────────────────────────
expected = datetime(2026, 10, 20, 8)
wfb._alert_stale("demo", expected, 17, "BTCUSDT", computed=np.bool_(True))
wfb._alert_stale("demo", expected, 17, "BTCUSDT")
got = landed()
check(len(got) == 2 and all(e["type"] == "bar_stale" for e in got), f"(1) two bar_stale events land ({got})")
check([e["payload"].get("computed") for e in got] == [True, False]
      and all(type(e["payload"]["computed"]) is bool for e in got),
      "(1) computed is a real bool, a numpy bool included")
check(all(clean(e) for e in got) and got[0]["payload"]["minutes"] == 17,
      f"(1) the payload passes the whitelist untouched ({got[0]['payload'] if got else None})")

# ── 2. dead_members ─────────────────────────────────────────────────────────
members = [f"S{i:03d}" for i in range(60)]
latest = {m: datetime(2026, 8, 1) for m in members}
latest["S007"] = datetime(2026, 9, 3, 13, 30)
latest["OLD"] = datetime(2027, 1, 1)   # already noticed: must not set last_trade
state = {"dead_noticed": ["OLD"]}
wfb._note_dead("tw_c", state, members + ["OLD"], members + ["OLD"], latest=latest)
got = landed()
p = got[0]["payload"] if got else {}
check(len(got) == 1 and got[0]["type"] == "dead_members", f"(2) one dead_members event ({len(got)})")
check(p.get("symbols") == members[:50] and p.get("strategy") == "tw_c",
      f"(2) symbols = the newly dead only, capped at 50 ({len(p.get('symbols', []))})")
check(p.get("last_trade") == "2026-09-03", f"(2) last_trade = newest last bar among them ({p.get('last_trade')})")
check(got and clean(got[0]) and len(json.dumps(p).encode()) < 4096, "(2) the payload passes the whitelist, under 4KB")
check(len(sent) == 3 and "S000" in sent[-1], "(2) the Telegram notice still goes out")
wfb._note_dead("tw_c", state, members + ["OLD"], members + ["OLD"], latest=latest)
check(landed() == [] and len(sent) == 3, "(2) the same set again: no second event, no second notice")
wfb._note_dead("tw_d", {}, ["X"], ["X"])
got = landed()
check(len(got) == 1 and "last_trade" not in got[0]["payload"] and clean(got[0]),
      f"(2) no latest: sent without last_trade ({got})")

# ── 3. target_stale ─────────────────────────────────────────────────────────
keys = [f"K{i}" + "x" * 70 for i in range(25)]
r = ev.emit_target_stale("s" * 80, keys, 7261.6)
got = landed()
p = got[0]["payload"] if got else {}
check(r is not None and len(got) == 1 and got[0]["type"] == "target_stale", f"(3) one target_stale event ({r})")
check(len(p.get("keys", [])) == 20 and all(len(k) == 64 for k in p["keys"]) and len(p.get("strategy", "")) == 64,
      "(3) keys capped at 20 × 64, strategy at 64")
check(p.get("age_s") == 7262 and type(p["age_s"]) is int, f"(3) age_s a whole number ({p.get('age_s')!r})")
check(got and clean(got[0]), "(3) the payload passes the whitelist untouched")
check(ev.emit_target_stale("s", ["k"], float("nan")) is None and landed() == [],
      "(3) a bad age_s: nothing lands, nothing raises")

# ── 4. a platform without the new types ─────────────────────────────────────
wfb._alert_stale("demo", expected, 17, "BTCUSDT", computed=True)
e = landed()[0]
check(sanitize(OLD, "bar_stale", e["payload"]) == {"strategy": "demo", "symbol": "BTCUSDT", "minutes": 17},
      "(4) old platform: bar_stale keeps every field it knew, computed dropped")
check(sanitize(OLD, "target_stale", {}) is None and sanitize(OLD, "dead_members", {}) is None,
      "(4) old platform: the new types are unknown there (acked and dropped by its ingest)")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
