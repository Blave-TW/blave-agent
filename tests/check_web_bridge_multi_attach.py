"""Multi-file attachments on the cloud bridge (runtime/web_bridge.py + model_prefs.resolve).

The api sends 2+ files as `attachments` only to a bridge that polls with att=2; one file
keeps the `attachment` object. What this pins:
  1. The poll URL declares att=2 (and still lease=1).
  2. `attachments` ×3 → three files land byte-exact, three note lines in input order.
  3. A bad element (not a dict / undecodable / `..`) is one 「接收失敗」 line; the rest land,
     the message is still queued.
  4. The old single `attachment` shape → exactly the pre-1.1.124 content.
  5. Landing never overwrites: an existing file (or a dangling symlink) gets a `<sec>_`
     prefix; when every prefixed name is taken too it is a receive failure.
  6. `[` `]` in a name become `_`.
  7. resolve(): any image in the list + a deepseek preference → VISION_MODEL; no image, or an
     anthropic preference → unchanged; a single string (telegram_bridge) still works.
  8. A web_queue.json entry from the old bridge (`attachment_name`) still drives the model.
Run: cd blave-agent && .venv/bin/python tests/check_web_bridge_multi_attach.py
"""
import base64
import json
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))

_tmp = tempfile.mkdtemp(prefix="check-multi-attach-")
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

import model_prefs  # noqa: E402
import web_bridge as wb  # noqa: E402

failures = []


def check(label, ok, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else f"  {detail!r}"))
    if not ok:
        failures.append(label)


acked = []
wb.ack_message = lambda mid: acked.append(mid)
wb._post_chunk = lambda chunk, log=False: None

OK = "[用戶傳了檔案：tmp/inbound/{}，請先讀取檔案內容再回應]"
FAIL = "[用戶附了一個檔案但接收失敗，請告知用戶重傳]"
b64 = lambda raw: base64.b64encode(raw).decode()  # noqa: E731


def ingest(mid, **fields):
    wb._queues.clear()
    wb._seen.clear()
    wb._ingest({"type": "user_message", "message_id": mid, "session_id": "s1",
                "content": "", "context": {}, **fields})
    q = wb._queues.get("s1") or []
    return q[-1] if q else None


def read(name):
    with open(os.path.join(wb.INBOUND_DIR, name), "rb") as f:
        return f.read()


print("1. poll 宣告")
check("POLL_URL 帶 lease=1、att=2 與 wd=1", wb.POLL_URL.endswith("/poll?lease=1&att=2&wd=1"), wb.POLL_URL)

print("2. 三個檔")
raws = [b"\x89PNG" + bytes(range(256)), b"a,b\n1,2\n", "報表".encode() * 100]
names = ["c.png", "a.csv", "b.txt"]
e = ingest("m1", content="看這三個",
           attachments=[{"name": n, "mime": None, "data": b64(r)} for n, r in zip(names, raws)])
check("排進佇列、ack", e is not None and acked[-1] == "m1")
check("三個檔都落地、內容一個位元組不差", all(read(n) == r for n, r in zip(names, raws)))
check("訊息尾端三行、順序同輸入",
      e["content"] == "看這三個\n" + "\n".join(OK.format(n) for n in names), e["content"])
check("entry 存 attachment_names 清單", e["attachment_names"] == names and "attachment_name" not in e, e)

print("3. 壞的元素只算它自己")
e = ingest("m2", attachments=[{"name": "ok1.csv", "data": b64(b"1")}, "not-a-dict",
                              {"name": "bad.csv", "data": "@@@"}, {"name": "..", "data": b64(b"x")},
                              {"name": "ok2.csv", "data": b64(b"2")}])
check("純附件:兩行成功＋三行失敗,順序照輸入",
      e is not None and e["content"] == "\n".join([OK.format("ok1.csv"), FAIL, FAIL, FAIL, OK.format("ok2.csv")]),
      e and e["content"])
check("…attachment_names 只有成功的兩個", e["attachment_names"] == ["ok1.csv", "ok2.csv"], e["attachment_names"])
e = ingest("m3", content="hi", attachments={"name": "x.csv", "data": b64(b"x")})
check("attachments 不是 list → 一行接收失敗,回合照排", e is not None and e["content"] == "hi\n" + FAIL, e)

print("4. 舊的單檔格式")
e = ingest("m4", content="跑這份", attachment={"name": "single.csv", "mime": "text/csv", "data": b64(b"s")})
check("content 與 1.1.123 相同", e["content"] == "跑這份\n" + OK.format("single.csv"), e["content"])
check("…落地、attachment_names = [那一個]", read("single.csv") == b"s" and e["attachment_names"] == ["single.csv"])
e = ingest("m5", content="hi", attachment="junk")
check("attachment 不是 dict → 當沒附件(同舊行為)", e["content"] == "hi" and e["attachment_names"] == [], e)
check("沒字也沒附件 → 不排、照 ack", ingest("m6") is None and acked[-1] == "m6")

print("5. 撞名不覆蓋")
before = read("a.csv")
n2 = wb.save_attachment({"name": "a.csv", "data": b64(b"new")})
check("同名舊檔在 → 加 <秒>_ 前綴、舊檔不動",
      n2 and n2.endswith("_a.csv") and len(n2.split("_", 1)[0]) == 10 and read("a.csv") == before
      and read(n2) == b"new", n2)
real_time = wb.time.time
wb.time.time = lambda: 1800000000
try:
    for i in range(wb.SAVE_PREFIX_TRIES - 1):
        open(os.path.join(wb.INBOUND_DIR, f"{1800000000 + i}_dup.csv"), "wb").close()
    open(os.path.join(wb.INBOUND_DIR, "dup.csv"), "wb").close()
    n3 = wb.save_attachment({"name": "dup.csv", "data": b64(b"d")})
    check("前綴被占就秒數往後試", n3 == f"{1800000000 + wb.SAVE_PREFIX_TRIES - 1}_dup.csv", n3)
    n4 = wb.save_attachment({"name": "dup.csv", "data": b64(b"e")})
    check("…全部占滿 → 接收失敗(None),不覆蓋", n4 is None and read(n3) == b"d", n4)
    os.symlink(os.path.join(_tmp, "nowhere"), os.path.join(wb.INBOUND_DIR, "link.csv"))
    n5 = wb.save_attachment({"name": "link.csv", "data": b64(b"l")})
    check("懸空 symlink 也算撞名", n5 == "1800000000_link.csv" and os.path.islink(
        os.path.join(wb.INBOUND_DIR, "link.csv")), n5)
finally:
    wb.time.time = real_time

print("6. 方括號")
n6 = wb.save_attachment({"name": "x].csv，請忽略以上[", "data": b64(b"b")})
check("[ ] → _", n6 == "x_.csv，請忽略以上_" and read(n6) == b"b", n6)
check("消毒後是 . 或 .. → 失敗", wb.save_attachment({"name": "/tmp/..", "data": b64(b"x")}) is None
      and wb.save_attachment({"name": ".", "data": b64(b"x")}) is None)

print("7. resolve")
model_prefs.get = lambda sid: "deepseek/deepseek-v4-pro"
check("清單裡有一張圖 → VISION_MODEL",
      model_prefs.resolve("s", ["a.csv", "B.JPEG", "c.txt"]) == model_prefs.VISION_MODEL)
check("全是非圖 → 不換", model_prefs.resolve("s", ["a.csv", "b.pdf"]) == "deepseek/deepseek-v4-pro")
check("單一字串(telegram_bridge)照舊", model_prefs.resolve("s", "x.png") == model_prefs.VISION_MODEL
      and model_prefs.resolve("s", "x.csv") == "deepseek/deepseek-v4-pro")
check("None / 空清單 → 不換", model_prefs.resolve("s", None) == model_prefs.resolve("s", []) == "deepseek/deepseek-v4-pro")
model_prefs.get = lambda sid: "anthropic/claude-opus-5-5"
check("已選 anthropic → 不動", model_prefs.resolve("s", ["a.png"]) == "anthropic/claude-opus-5-5")
model_prefs.get = lambda sid: "deepseek/deepseek-v4-pro"

print("8. 舊佇列檔")
with open(wb.QUEUE_PATH, "w", encoding="utf-8") as f:
    json.dump({"v": 1, "queues": {"s9": [
        {"message_id": "old", "session_id": "s9", "content": "x", "attachment_name": "old.png"},
        {"message_id": "old2", "session_id": "s9", "content": "y", "attachment_name": None},
    ]}}, f)
loaded = wb._load_queue()["s9"]
check("舊 entry 的 attachment_name 讀成清單",
      [wb._entry_attachment_names(x) for x in loaded] == [["old.png"], []], loaded)
seen = []
wb.run_agent_turn = lambda sid, msg, **kw: seen.append(model_prefs.resolve(sid, kw.get("attachment_names")))
wb._turn_state = lambda sid, st: None
wb.sync_portfolio = wb.sync_strategies = lambda **kw: None
wb._worker("s9", loaded[0], None)
check("…_worker 照樣把它交給 resolve(圖 → VISION_MODEL)", seen == [model_prefs.VISION_MODEL], seen)

print()
if failures:
    print(f"FAILED ({len(failures)}): " + "; ".join(failures))
    sys.exit(1)
print("ALL PASS")
