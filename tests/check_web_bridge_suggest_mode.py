"""工作頁的 suggest_mode 通道(spec suggest-next-step-v2 §2.3):瀏覽器 context.suggest_mode → api 原樣轉 →
web_bridge 收進佇列 entry → run_agent_turn 只在 reduced / off 時帶 --suggest-mode=…,normal 與怪值都不帶
(agent_turn.py 的 argparse 有 choices,怪值帶過去整輪 exit 2)。
Run: cd blave-agent && .venv/bin/python tests/check_web_bridge_suggest_mode.py
"""
import os
import shutil
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))

_tmp = tempfile.mkdtemp(prefix="check-wb-suggest-")
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


check("context.suggest_mode 收進佇列 entry", ingest("m1", {"suggest_mode": "reduced"}).get("suggest_mode") == "reduced")
check("舊版 web 沒送 → entry 是 None", ingest("m2", {}).get("suggest_mode") is None)


class FakeProc:
    returncode = 0

    def poll(self):
        return 0


cmds = {}
real = wb.subprocess.Popen
try:
    for mode in ("reduced", "off", "normal", None, "off --help", 3):
        wb.subprocess.Popen = lambda cmd, *a, _m=mode, **kw: (cmds.__setitem__(_m, cmd), FakeProc())[1]
        wb.run_agent_turn("s1", "hi", suggest_mode=mode)
finally:
    wb.subprocess.Popen = real


def flags(m):
    return [a for a in cmds[m] if a.startswith("--suggest-mode")]


check("reduced → --suggest-mode=reduced(單一 argv、在 -- 之前)",
      flags("reduced") == ["--suggest-mode=reduced"] and cmds["reduced"].index("--suggest-mode=reduced") < cmds["reduced"].index("--"))
check("off → --suggest-mode=off", flags("off") == ["--suggest-mode=off"])
check("normal、沒送、怪值都不帶", all(flags(m) == [] for m in ("normal", None, "off --help", 3)), cmds)

src = open(os.path.join(ROOT, "runtime", "web_bridge.py"), encoding="utf-8").read()
check("_worker 把 entry 的 suggest_mode 交給 run_agent_turn", 'suggest_mode=entry.get("suggest_mode")' in src)

shutil.rmtree(_tmp, ignore_errors=True)
if failures:
    sys.exit(f"{len(failures)} failed")
print("all passed")
