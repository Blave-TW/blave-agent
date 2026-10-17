"""Queue while busy (runtime/web_bridge.py): withdraw one message, pending counts.

What this pins:
  1. `withdraw` for a queued message drops only that one: the running turn keeps going (no
     stop flag) and the rest of the queue stays in order, on disk too.
  2. `withdraw` for the message that is already running does nothing and answers `running`.
  3. An id the bridge does not hold answers `not_found`.
  4. Withdrawing the last waiting message of a session with no turn running also ends the
     api's `queued` (turn_state cancelled naming that one message).
  5. Every turn_state carries `pending_ids`; a message filed behind a running or queued
     session reports the new count at once, a message into an idle session does not.
  6. The old `interrupt` is unchanged: running → stop flag, queue untouched; not running →
     the whole queue is dropped and `cancelled` now names every dropped id.
Run: cd blave-agent && .venv/bin/python tests/check_web_bridge_withdraw.py
"""
import json
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))

_tmp = tempfile.mkdtemp(prefix="check-withdraw-")
STATE = os.path.join(_tmp, "state")
os.makedirs(STATE)
os.environ.update({
    "BLAVE_AGENT_BASE": _tmp,
    "BLAVE_AGENT_STATE": STATE,
    "BLAVE_AGENT_WORKSPACE": os.path.join(_tmp, "ws"),
    "BLAVE_AGENT_WEB_QUEUE": os.path.join(STATE, "web_queue.json"),
})
os.environ.pop("BLAVE_PROXY_TOKEN", None)

import web_bridge as wb  # noqa: E402

failures = []


def check(label, ok, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else f"  {detail!r}"))
    if not ok:
        failures.append(label)


posted = []
wb._post_chunk = lambda chunk, log=False: posted.append(chunk)
wb.ack_message = lambda mid: None


def entry(mid, sid="s1"):
    return {"message_id": mid, "session_id": sid, "content": mid, "ts": 0}


def reset(running=None, queue=()):
    wb._queues.clear()
    wb._running.clear()
    wb._queued_at.clear()
    wb._seen.clear()
    posted.clear()
    if queue:
        wb._queues["s1"] = [entry(m) for m in queue]
    if running:
        wb._running["s1"] = {"slot": None, "since": 0, "message_id": running,
                             "stop_file": os.path.join(wb.STOP_DIR, "s1-flag")}


def withdraw(target):
    wb._ingest({"type": "withdraw", "message_id": "ctl-" + target, "session_id": "s1",
                "target_id": target})


def of(kind):
    return [c for c in posted if c["type"] == kind]


def on_disk():
    with open(wb.QUEUE_PATH, encoding="utf-8") as f:
        return [e["message_id"] for e in json.load(f)["queues"].get("s1", [])]


flag = os.path.join(wb.STOP_DIR, "s1-flag")

print("1. 撤回排隊那則,跑中的不受影響")
reset(running="m1", queue=("m2", "m3", "m4"))
withdraw("m3")
check("只拿掉 m3、其餘照序", [e["message_id"] for e in wb._queues["s1"]] == ["m2", "m4"],
      wb._queues.get("s1"))
check("落盤同步", on_disk() == ["m2", "m4"], on_disk())
check("跑中的那輪還在、沒有停止旗標", wb._running["s1"]["message_id"] == "m1"
      and not os.path.exists(flag))
check("回 withdraw_result withdrawn + pending_ids", of("withdraw_result") == [{
    "type": "withdraw_result", "session_id": "s1", "message_id": "m3",
    "result": "withdrawn", "pending_ids": ["m2", "m4"]}], posted)
check("還有回合在跑:不送 cancelled", not of("turn_state"), posted)

print("2. 撤回已在跑的那則")
reset(running="m1", queue=("m2",))
withdraw("m1")
check("回 running", [c["result"] for c in of("withdraw_result")] == ["running"], posted)
check("什麼都沒動:沒有旗標、佇列不變", not os.path.exists(flag)
      and [e["message_id"] for e in wb._queues["s1"]] == ["m2"] and "s1" in wb._running)
check("不送 turn_state", not of("turn_state"), posted)

print("3. 不認得的 id")
reset(running="m1", queue=("m2",))
withdraw("zz")
check("回 not_found、佇列不變", [c["result"] for c in of("withdraw_result")] == ["not_found"]
      and len(wb._queues["s1"]) == 1, posted)

print("4. 沒在跑、撤掉最後一則")
reset(queue=("m5",))
withdraw("m5")
check("佇列清空", "s1" not in wb._queues and "s1" not in wb._queued_at)
check("withdraw_result 之後送 cancelled、只點名那則",
      [c["type"] for c in posted] == ["withdraw_result", "turn_state"]
      and of("turn_state")[0]["state"] == "cancelled"
      and of("turn_state")[0]["message_ids"] == ["m5"]
      and of("turn_state")[0]["pending_ids"] == [], posted)
reset(queue=("m5", "m6"))
withdraw("m5")
check("還有排隊的:不送 cancelled", not of("turn_state")
      and of("withdraw_result")[0]["pending_ids"] == ["m6"], posted)

print("5. pending_ids")
reset(running="m1", queue=("m2", "m3"))
wb._turn_state("s1", "running")
check("turn_state 帶目前佇列", posted[-1]["pending_ids"] == ["m2", "m3"], posted)
reset(running="m1")
wb._ingest({"type": "user_message", "message_id": "n1", "session_id": "s1", "content": "a"})
check("排到跑中回合後面:立刻報 running + 新的數", of("turn_state") == [{
    "type": "turn_state", "session_id": "s1", "state": "running", "pending_ids": ["n1"]}],
    posted)
reset(queue=("m2",))
wb._ingest({"type": "user_message", "message_id": "n2", "session_id": "s1", "content": "b"})
check("排到排隊中的後面:立刻報 queued", [(c["state"], c["pending_ids"]) for c in of("turn_state")]
      == [("queued", ["m2", "n2"])] and "s1" in wb._queued_at, posted)
reset()
wb._ingest({"type": "user_message", "message_id": "n3", "session_id": "s1", "content": "c"})
check("閒置的對話:不報(交給 dispatcher)", not posted and wb._queues["s1"][0]["message_id"] == "n3",
      posted)

print("6. 舊 interrupt 不變")
reset(running="m1", queue=("m2",))
wb._ingest({"type": "interrupt", "message_id": "i1", "session_id": "s1"})
check("跑中:建停止旗標、佇列不動、不送 cancelled", os.path.exists(flag)
      and [e["message_id"] for e in wb._queues["s1"]] == ["m2"] and not of("turn_state"))
os.remove(flag)
reset(queue=("m2", "m3"))
wb._ingest({"type": "interrupt", "message_id": "i2", "session_id": "s1"})
check("沒在跑:整條佇列撤回、cancelled 點名全部", "s1" not in wb._queues
      and [(c["state"], c.get("message_ids")) for c in of("turn_state")]
      == [("cancelled", ["m2", "m3"])], posted)

print()
if failures:
    print(f"FAILED ({len(failures)}): " + "; ".join(failures))
    sys.exit(1)
print("ALL PASS")
