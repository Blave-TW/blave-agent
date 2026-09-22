"""portfolio._ui_override_alert must not emit one `ui_override` event per tick.

What it protects: load_portfolio_config runs on every strategy tick, and the
platform's 6h P2 cooldown only gates Telegram — every event still lands and
counts against the user's DAILY_EVENT_QUOTA (500). A 1-min strategy with a
persistent config/UI mismatch was 1,440 events/day, after which that user's
P1 halt / order_error were silently dropped.

Asserts: same diff twice inside the window → ONE emit; window elapsed → emits
again; a different diff inside the window → emits (new fact, not a repeat);
unreadable / unwritable stamp → still emits (fail-open); the Telegram half's
24h stamp is untouched by all of this; and the event stamp lives next to the
existing Telegram stamp under state/.

Run: cd blave-agent && .venv/bin/python tests/check_ui_override_event_cooldown.py
"""
import os, shutil, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from lib import portfolio as pf  # noqa: E402
import lib.events as ev  # noqa: E402
import lib.notify as notify  # noqa: E402

WS = tempfile.mkdtemp(prefix="ui-override-cd-")
os.chdir(WS)

emitted = []
ev._appender = lambda t, p: (emitted.append(t), 1)[1]
notify.send_text = lambda *a, **k: None  # the Telegram half is not under test

fails = 0
def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1

DIFF_A = ({"s1": 100.0}, {"s1": "okx"}, {"amounts": {"s1": 50.0}, "exchanges": {"s1": "okx"}})
DIFF_B = ({"s2": 10.0}, {"s2": "binance"}, {"amounts": {}, "exchanges": {}})

# ── 1. same diff twice in the window → one event ──────────────────────────
pf._ui_override_alert(DIFF_A)
pf._ui_override_alert(DIFF_A)
check(emitted == ["ui_override"], f"same diff twice → one emit ({emitted})")
check(os.path.dirname(pf._UI_EVENT_STAMP_PATH) == os.path.dirname(pf._UI_ALERT_STAMP_PATH),
      "event stamp sits next to the Telegram stamp")
check(os.path.exists(pf._UI_EVENT_STAMP_PATH), "event stamp written")
check(os.path.exists(pf._UI_ALERT_STAMP_PATH), "Telegram 24h stamp still written")

# ── 2. a different diff inside the window is a new fact → emits ──────────
pf._ui_override_alert(DIFF_B)
check(len(emitted) == 2, f"different diff in window → emits ({emitted})")
pf._ui_override_alert(DIFF_B)
check(len(emitted) == 2, f"…and the new diff is then deduped too ({emitted})")

# ── 3. window elapsed → emits again ───────────────────────────────────────
old = pf.time.time() - pf._UI_EVENT_COOLDOWN_S - 1
os.utime(pf._UI_EVENT_STAMP_PATH, (old, old))
pf._ui_override_alert(DIFF_B)
check(len(emitted) == 3, f"window elapsed → emits again ({emitted})")

# ── 4. stamp unreadable / unwritable → fail-open, still emits ─────────────
shutil.rmtree(os.path.dirname(pf._UI_EVENT_STAMP_PATH))
open(os.path.dirname(pf._UI_EVENT_STAMP_PATH), "w").close()  # `state` is now a FILE
pf._ui_override_alert(DIFF_A)
pf._ui_override_alert(DIFF_A)
check(len(emitted) == 5, f"stamp dir unusable → every call emits, none raises ({emitted})")
os.remove(os.path.dirname(pf._UI_EVENT_STAMP_PATH))
# key computation itself blowing up (a diff json.dumps cannot walk) → still emits
class _Loop(dict):
    pass
loop = _Loop()
loop["me"] = loop
pf._ui_override_alert(loop)
check(len(emitted) == 6, f"unhashable diff → key error swallowed, still emits ({emitted})")

# ── 5. the wired caller passes the mismatch through load_portfolio_config ─
import json  # noqa: E402
emitted.clear()
os.makedirs("manager")
with open("manager/portfolio_config.json", "w") as f:
    json.dump({"amounts": {"s1": 100}, "exchanges": {"s1": "okx"}}, f)
with open("manager/amounts.ui.json", "w") as f:
    json.dump({"amounts": {"s1": 50}, "exchanges": {"s1": "okx"}}, f)
for _ in range(3):
    cfg = pf.load_portfolio_config()
check(cfg["amounts"] == {"s1": 50.0}, "UI copy still overrides the config")
check(emitted == ["ui_override"], f"three ticks with one mismatch → one event ({emitted})")
# a NEW mismatch inside the window is a new fact — catches the caller forgetting to pass diff
with open("manager/amounts.ui.json", "w") as f:
    json.dump({"amounts": {"s1": 20}, "exchanges": {"s1": "okx"}}, f)
pf.load_portfolio_config()
check(len(emitted) == 2, f"UI re-saved to a different value → second event ({emitted})")

os.chdir(ROOT)
shutil.rmtree(WS)
print("FAILED" if fails else "all ok")
sys.exit(1 if fails else 0)
