"""回合來源(spec mobile-agent-chat-mvp §2.8):api 寫的 context.origin → web_bridge 只認 web／app(其他、缺值當 web)→
佇列 entry → turn_slots.acquire(sid, origin)＋BLAVE_TURN_ORIGIN 交給 agent_turn;agent_turn 只寫進 log,
不加 argv 旗標(電腦版包舊 runtime 時新旗標會讓 argparse exit 2)、不進提示詞。
Run: cd blave-agent && .venv/bin/python tests/check_web_bridge_turn_origin.py
"""
import os
import re
import shutil
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))

_tmp = tempfile.mkdtemp(prefix="check-wb-origin-")
STATE = os.path.join(_tmp, "state")
os.makedirs(STATE)
os.environ.update({
    "BLAVE_AGENT_BASE": _tmp,
    "BLAVE_AGENT_STATE": STATE,
    "BLAVE_AGENT_WORKSPACE": os.path.join(_tmp, "ws"),
    "BLAVE_AGENT_MODEL_PREFS": os.path.join(STATE, "model_prefs.json"),
    "BLAVE_AGENT_WEB_QUEUE": os.path.join(STATE, "web_queue.json"),
})
os.environ.pop("BLAVE_PROXY_TOKEN", None)
os.environ.pop("BLAVE_TURN_ORIGIN", None)

import web_bridge as wb  # noqa: E402

failures = []


def check(label, ok, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else f"  {detail!r}"))
    if not ok:
        failures.append(label)


wb.ack_message = lambda mid: None
wb._post_chunk = lambda chunk, log=False: None


def ingest(mid, ctx):
    wb._queues.clear()
    wb._seen.clear()
    wb._ingest({"type": "user_message", "message_id": mid, "session_id": "s1", "content": "hi", "context": ctx})
    return (wb._queues.get("s1") or [None])[-1]


check("context.origin app → entry origin app", ingest("m1", {"origin": "app"}).get("origin") == "app")
check("context.origin web → web", ingest("m2", {"origin": "web"}).get("origin") == "web")
check("舊 api 沒送 → web", ingest("m3", {}).get("origin") == "web")
check("怪值(tg、App、數字、物件)→ web", all(ingest(f"m4{i}", {"origin": v}).get("origin") == "web"
                                      for i, v in enumerate(["tg", "App", 3, {"x": 1}, "app "])))


class FakeProc:
    returncode = 0

    def poll(self):
        return 0


seen = {}
real = wb.subprocess.Popen
try:
    for origin in ("app", "web", "evil", None):
        wb.subprocess.Popen = lambda cmd, *a, _o=origin, **kw: (seen.__setitem__(_o, (cmd, kw.get("env"))), FakeProc())[1]
        wb.run_agent_turn("s1", "hi", origin=origin, stop_file=os.path.join(_tmp, "stop") if origin == "app" else None)
finally:
    wb.subprocess.Popen = real

check("app → 環境變數 BLAVE_TURN_ORIGIN=app,停止檔照帶", seen["app"][1].get("BLAVE_TURN_ORIGIN") == "app"
      and seen["app"][1].get(wb.turn_stop.ENV) == os.path.join(_tmp, "stop"))
check("web、怪值、沒給 → web", all(seen[o][1].get("BLAVE_TURN_ORIGIN") == "web" for o in ("web", "evil", None)))
check("不加 argv 旗標", not any(a.startswith("--") and "origin" in a for o in seen for a in seen[o][0]))

src = open(os.path.join(ROOT, "runtime", "web_bridge.py"), encoding="utf-8").read()
check("_dispatch 拿排在最前那句的 origin 取槽(不再寫死 web)", 'turn_slots.acquire(sid, turn_origin(_queues[sid][0].get("origin")))' in src
      and 'turn_slots.acquire(sid, "web")' not in src)
check("_worker 把 entry 的 origin 交給 run_agent_turn", 'origin=turn_origin(entry.get("origin"))' in src)

at = open(os.path.join(ROOT, "runtime", "agent_turn.py"), encoding="utf-8").read()
uses = [l for l in at.splitlines() if "BLAVE_TURN_ORIGIN" in l and not l.strip().startswith("#")]
check("agent_turn 只讀一次 BLAVE_TURN_ORIGIN(寫 log),不進提示詞或規則", len(uses) == 1 and re.search(r'origin = os\.environ\.get\("BLAVE_TURN_ORIGIN"\)', uses[0]) is not None
      and 'print(f"[agent_turn] turn origin={origin}", file=sys.stderr)' in at, uses)

shutil.rmtree(_tmp, ignore_errors=True)
if failures:
    sys.exit(f"{len(failures)} failed")
print("all passed")
