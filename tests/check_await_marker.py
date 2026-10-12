"""<await/> — the "waiting for the user" marker (runtime/agent_turn.py extract_await; _SUGGEST_RULE tail).

The model writes `<await/>` at the end of a reply that needs the user's answer to continue; the
runtime strips it and puts `awaiting` on the `done` chunk. The marker must never reach a user:
this test ENUMERATES every sink (every class in runtime/ with a `finalize`), drives each one with
text carrying the marker and asserts nothing it emits or returns still has it — removing the strip
from any one sink turns this red; a new sink without a case here turns it red too.
Contract: references/turn-events.md. Run: cd blave-agent && python3 tests/check_await_marker.py
"""
import glob, inspect, io, json, os, re, sys, tempfile, types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))
WS = tempfile.mkdtemp(prefix="check-await-ws-")
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.setdefault("BLAVE_AGENT_DB", os.path.join(WS, "session.db"))
sys.modules["claude_agent_sdk"] = types.ModuleType("claude_agent_sdk")
import agent_turn as at  # noqa: E402

fails = []


def ok(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + ("" if cond or not detail else f"  → {detail}"))
    if not cond:
        fails.append(name)


MARK = "<await"
BODY = "我需要你先選一個：\n1. 4h 均線交叉\n2. 1h RSI\n"
REPLY = BODY + "<await/>\n<suggest>\n掃一下參數\n</suggest>"

# ── 1. extract_await ──
for name, raw, want_text, want_flag in [
    ("自成一行在尾端", BODY + "<await/>", BODY.rstrip(), True),
    ("帶空白的寫法 <await />", BODY + "<await />", BODY.rstrip(), True),
    ("成對寫法 <await></await>", BODY + "<await></await>", BODY.rstrip(), True),
    ("夾在中間也剝(前後空白一起,同 <suggest>)", "前段 <await/> 後段", "前段後段", True),
    ("沒有標記一字不動、flag 假", "回測跑完了。", "回測跑完了。", False),
    ("談到 await 這個字不算", "await 是 Python 關鍵字", "await 是 Python 關鍵字", False),
    ("空字串", "", "", False),
]:
    got = at.extract_await(raw)
    ok(f"extract_await:{name}", got == (want_text, want_flag), got)

# ── 2. 規則在 prompt 最尾端的那一節(_SUGGEST_RULE),web 與電腦版都帶 ──
ok("規則併在 _SUGGEST_RULE 裡", "<await/>" in at._SUGGEST_RULE)
for rule_name in ("WEB_FORMATTING_RULE", "LOCAL_FORMATTING_RULE"):
    rule = getattr(at, rule_name)
    ok(f"{rule_name} 以 _SUGGEST_RULE 收尾(標記規則仍在 prompt 最尾端)", rule.endswith(at._SUGGEST_RULE))

# ── 3. 列舉每個 sink:runtime/ 裡所有有 finalize 的類別都要在這裡被餵過標記 ──
src_sinks = {}
for path in glob.glob(os.path.join(ROOT, "runtime", "*.py")):
    text = open(path, encoding="utf-8").read()
    cls = None
    for line in text.splitlines():
        m = re.match(r"class (\w+)", line)
        if m:
            cls = m.group(1)
        if re.match(r"\s+def finalize\(", line) and cls:
            src_sinks.setdefault(os.path.basename(path), []).append(cls)
ok("有 finalize 的類別只在 agent_turn.py(別的模組長出 sink 要加到這支測試)",
   set(src_sinks) == {"agent_turn.py"}, src_sinks)
mod_sinks = {n for n, c in vars(at).items() if inspect.isclass(c) and c.__module__ == at.__name__
             and callable(getattr(c, "finalize", None))}
ok("agent_turn 裡有 finalize 的類別(含繼承)都列到", mod_sinks >= set(src_sinks.get("agent_turn.py", ())), mod_sinks)

captured = []  # 每個 sink 對外送出的所有文字(泡泡、chunk、stdout)


class FakeStreamer:
    def __init__(self, token, chat_id):
        pass

    def update(self, text):
        captured.append(("tg_update", text))

    def finish(self, text):
        captured.append(("tg_finish", text))

    def discard(self):
        pass


at.TelegramStreamer = FakeStreamer
chunks = []
at._post_report = lambda url, token, chunk, timeout=15: chunks.append(chunk)


def drive(cls):
    """建一個 sink、餵帶標記的回覆、finalize;回傳 (回傳值, 這個 sink 送出去的東西)。"""
    captured.clear()
    chunks.clear()
    if cls is at.TelegramSink:
        sink = cls("tok", "chat")
    else:
        sink = cls("http://x/report", "t", "s1") if cls is at.WebSink else cls("s1")
    out = io.StringIO()
    real_stdout, sys.stdout = sys.stdout, out
    try:
        sink.on_text(REPLY)
        reply = sink.finalize()
    finally:
        sys.stdout = real_stdout
    # 電腦版 sink 把 chunk 寫到 stdout(一行一個 JSON):讀回來當 chunk 看
    for line in out.getvalue().splitlines():
        if line.startswith("@@BLAVE@@"):
            chunks.append(json.loads(line[len("@@BLAVE@@"):]))
        else:
            captured.append(("stdout", line))
    emitted = list(captured) + [(c.get("type"), c) for c in chunks]
    return reply, emitted, sink


covered = set()
for cls_name in sorted(mod_sinks):
    cls = getattr(at, cls_name)
    reply, emitted, sink = drive(cls)
    covered.add(cls_name)
    # 串流途中(web 的 text delta、TG 的 update 編輯)標記會短暫露出,跟 <suggest> 一樣,定稿時換掉:
    # web 靠 text_replace、TG 靠 finish 再編輯一次。這裡只看定稿後的輸出。
    leaked = [e for e in emitted if MARK in (e[1] if isinstance(e[1], str) else str(e[1]))
              and not (isinstance(e[1], dict) and e[1].get("type") == "text") and e[0] != "tg_update"]
    ok(f"{cls_name}: finalize 回傳值(進 session 存檔／stdout)沒有標記", MARK not in (reply or ""), reply)
    ok(f"{cls_name}: 定稿送出去的泡泡／chunk／stdout 沒有標記", not leaked, leaked[:2])
    if cls is at.TelegramSink:
        fin = [e[1] for e in emitted if e[0] == "tg_finish"]
        ok(f"{cls_name}: 最後編輯進泡泡的那份(finish)是乾淨的", fin and all(MARK not in t for t in fin), fin)
    if isinstance(sink, at.WebSink):
        done = [c for c in chunks if c.get("type") == "done"]
        if cls is at.ReportSink:
            ok(f"{cls_name}: 無人值守回合不送 chunk", not chunks and not done)
        else:
            rep = [c for c in chunks if c.get("type") == "text_replace"]
            ok(f"{cls_name}: 串流出去的那段被 text_replace 換成乾淨版", rep and MARK not in rep[-1]["text"], rep)
            ok(f"{cls_name}: done 帶 awaiting=True 與 kinds 計數", done and done[-1].get("awaiting") is True
               and isinstance(done[-1].get("kinds"), dict), done)
            sug = [c for c in chunks if c.get("type") == "suggestions"]
            ok(f"{cls_name}: 建議列照常剝出", sug and sug[-1]["items"] == ["掃一下參數"], sug)
ok("列舉完整:每個 sink 類別都被餵過", covered == mod_sinks, mod_sinks - covered)

# ── 4. done 契約:沒標記 → awaiting False;被 Stop 截斷 → False;kinds 是這一輪的分類計數 ──
chunks.clear()
s = at.WebSink("http://x/report", "t", "s2")
s.on_tool(types.SimpleNamespace(id="u1", name="Bash", input={"command": "echo hi"}))
s.on_tool(types.SimpleNamespace(id="u2", name="Read", input={"file_path": os.path.join(WS, "tmp", "a.log")}))
s.on_tool(types.SimpleNamespace(id="u3", name="Bash", input={"command": "ls strategies/"}))
s.on_text("回測跑完了。")
s.finalize()
done = [c for c in chunks if c.get("type") == "done"][-1]
ok("沒有標記 → awaiting False", done.get("awaiting") is False, done)
ok("kinds = 這一輪每種分類的步數(只有計數,沒有指令或路徑)",
   done.get("kinds") == {"unknown": 1, "file_read": 1, "files": 1}, done.get("kinds"))
ok("done chunk 只有 type / session_id / awaiting / kinds", set(done) == {"type", "session_id", "awaiting", "kinds"}, done)

chunks.clear()
s = at.WebSink("http://x/report", "t", "s3")
s.on_text(REPLY)
s.interrupted = True
s.finalize()
done = [c for c in chunks if c.get("type") == "done"][-1]
ok("被 Stop 截斷:標記照剝、awaiting False", done.get("awaiting") is False and MARK not in s.full_text, done)

chunks.clear()
s = at.WebSink("http://x/report", "t", "s4")
s.on_text(REPLY)
s.set_error("boom", code="partial")
s.finalize()
ok("出錯的回合不送 done(契約不變:error chunk 收尾)", not any(c.get("type") == "done" for c in chunks), chunks)

print()
print("ALL PASS" if not fails else f"{len(fails)} FAILED: {fails}")
sys.exit(1 if fails else 0)
