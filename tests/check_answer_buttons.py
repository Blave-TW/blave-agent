"""聊天欄答案鈕(spec designer chat-answer-buttons-2026-11-16 §10):<answers> 區塊 → runtime 剝掉、合格才送 answers chunk;
畫不出鈕的地方(校驗不過、被停、外殼沒宣告、Telegram、歷史)把選項還原成純文字清單,不讓選項憑空消失。
規則只在 --answer-buttons 時掛。四個 sink 的剝除列舉在 tests/check_await_marker.py。
Contract: references/turn-events.md. Run: cd blave-agent && python3 tests/check_answer_buttons.py
"""
import io, json, os, re, sys, tempfile, types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))
WS = tempfile.mkdtemp(prefix="check-answers-ws-")
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.setdefault("BLAVE_AGENT_DB", os.path.join(WS, "session.db"))
for k in ("BLAVE_DATA_ACCESS", "BLAVE_DATA_ACCESS_WHY", "BLAVE_AGENT_LOCAL"):
    os.environ.pop(k, None)
sys.modules["claude_agent_sdk"] = types.ModuleType("claude_agent_sdk")
import agent_turn as at  # noqa: E402

fails = []


def ok(name, fn):
    try:
        cond, detail = fn()
    except Exception as e:  # 改動前整支要逐條紅,不是死在第一個 AttributeError
        cond, detail = False, f"{type(e).__name__}: {e}"
    print(("PASS " if cond else "FAIL ") + name + ("" if cond or not detail else f"  → {detail}"))
    if not cond:
        fails.append(name)


Q = "要用穩健參數重跑嗎？"
BLOCK = "<answers>\n重跑回測\n先不要\n</answers>"
REPLY = Q + "\n" + BLOCK + "\n<await/>"
LIST = "\n\n- 重跑回測\n- 先不要"

# ── 1. extract_answers ──
ok("合法區塊 → 文字乾淨＋兩個選項,沒標 default", lambda: (lambda r: (r == (Q, ["重跑回測", "先不要"], None), r))(
    at.extract_answers(Q + "\n" + BLOCK)))
ok("行首 -•* 與空行丟掉、不截字", lambda: (lambda r: (r[1] == ["重跑回測", "先不要"], r))(
    at.extract_answers(Q + "\n<answers>\n- 重跑回測\n\n• 先不要\n</answers>")))
ok("多個區塊取最後一個、全部剝掉", lambda: (lambda r: (r == (Q, ["甲", "乙"], None), r))(
    at.extract_answers(Q + "\n<answers>\n舊\n</answers>\n<answers>\n甲\n乙\n</answers>")))
ok("未閉合尾段剝掉、沒有選項", lambda: (lambda r: (r == (Q, None, None), r))(at.extract_answers(Q + "\n<answers>\n甲\n乙")))
ok("帶 default 的未閉合尾段也剝掉", lambda: (lambda r: (r == (Q, None, None), r))(at.extract_answers(Q + '\n<answers default="2">\n甲')))
ok("沒有標記一字不動", lambda: (at.extract_answers("answers 這個字\n") == ("answers 這個字\n", None, None), ""))
ok("空字串／None 不炸", lambda: (at.extract_answers("") == ("", None, None) and at.extract_answers(None) == (None, None, None), ""))
ok("default 標建議那一個(1 起算)", lambda: (lambda r: (r == (Q, ["甲", "乙", "丙"], 2), r))(
    at.extract_answers(Q + '\n<answers default="2">\n甲\n乙\n丙\n</answers>')))
ok("default 超出清單 → 當沒標,選項照留", lambda: (lambda r: (r == (Q, ["甲", "乙"], None), r))(
    at.extract_answers(Q + '\n<answers default="3">\n甲\n乙\n</answers>')))
ok("清單不編號;建議那一個標「（建議）」,英文標 (recommended)", lambda: (
    at.answers_as_text(["重跑回測", "先不要"], 1) == "\n\n- 重跑回測（建議）\n- 先不要"
    and at.answers_as_text(["Rerun", "Not now"], 2) == "\n\n- Rerun\n- Not now (recommended)"
    and at.answers_as_text(["甲", "乙"]) == "\n\n- 甲\n- 乙" and at.answers_as_text(None, 1) == "", ""))

# ── 2. 上限(兩端同一份;tests/check_web_desktop_parity.js 比顯示端)──
ok("ANS_MAX_ITEMS = 4、ANS_MAX_CHARS = 32", lambda: ((at.ANS_MAX_ITEMS, at.ANS_MAX_CHARS) == (4, 32), ""))
for name, items, want in [
    ("2 個", ["甲", "乙"], True), ("4 個", list("甲乙丙丁"), True), ("1 個", ["甲"], False), ("5 個", list("甲乙丙丁戊"), False),
    ("32 字", ["甲", "字" * 32], True), ("33 字", ["甲", "字" * 33], False), ("emoji 一個算一字", ["甲", "😀" * 32], True),
    ("重複", ["甲", "甲"], False), ("控制字元", ["甲", "乙\x07"], False),
    ("格式字元 U+202E(雙向覆寫:鈕上看到的跟送出的不一樣)", ["甲", "乙\u202e丙"], False), ("格式字元 U+200B", ["甲", "乙\u200b"], False),
]:
    ok(f"_answers_ok:{name}", lambda items=items, want=want: (at._answers_ok(items) is want, items))

# ── 3. visible_text ──
ok("visible_text 剝掉 <answers>", lambda: (at.visible_text(REPLY) == Q, at.visible_text(REPLY)))
ok("只有標記不算回了話", lambda: (not at._counts_as_reply(BLOCK + "\n<await/>"), ""))

# ── 4. sink ──
chunks = []
at._post_report = lambda url, token, chunk, timeout=15: chunks.append(chunk)


def drive(sink, text=REPLY, interrupted=False, buttons=True):
    chunks.clear()
    sink.answer_buttons = buttons
    out = io.StringIO()
    real, sys.stdout = sys.stdout, out
    try:
        sink.on_text(text)
        sink.interrupted = interrupted
        reply = sink.finalize()
    finally:
        sys.stdout = real
    for line in out.getvalue().splitlines():
        if line.startswith("@@BLAVE@@"):
            chunks.append(json.loads(line[len("@@BLAVE@@"):]))
    return reply


def shown(c):
    return [x["text"] for x in c if x["type"] == "text_replace"][-1:] or [None]


def _web():
    reply = drive(at.WebSink("http://x/report", "t", "s1"), REPLY + "\n<suggest>\n掃參數\n</suggest>")
    order = [c["type"] for c in chunks if c["type"] != "text"]
    ans = [c for c in chunks if c["type"] == "answers"]
    return (order == ["text_replace", "answers", "done"] and shown(chunks) == [Q] and reply == Q + LIST
            and ans[0] == {"type": "answers", "session_id": "s1", "items": ["重跑回測", "先不要"]}
            and [c for c in chunks if c["type"] == "done"][0]["awaiting"] is True), (order, reply, chunks)


ok("WebSink:text_replace 只剩問句 → answers → done;同輪不送 suggestions;歷史接純文字清單", _web)


def _web_default():
    reply = drive(at.WebSink("http://x/report", "t", "s1"), Q + '\n<answers default="1">\n重跑回測\n先不要\n</answers>\n<await/>')
    ans = [c for c in chunks if c["type"] == "answers"]
    return (ans and ans[0]["default"] == 1 and reply == Q + "\n\n- 重跑回測（建議）\n- 先不要"), (reply, chunks)


ok("WebSink:default 進 chunk;歷史清單標出建議那一個", _web_default)


def _local():
    reply = drive(at.LocalSink("s9"))
    return [c["type"] for c in chunks if c["type"] in ("answers", "done")] == ["answers", "done"] and reply == Q + LIST, chunks


ok("LocalSink:同樣送 answers、session.db 存問句＋清單", _local)

for name, kw, text in [
    ("外殼沒宣告(--answer-buttons 沒帶)", {"buttons": False}, REPLY),
    ("被 Stop 截斷", {"interrupted": True}, REPLY),
    ("沒寫 <await/>", {}, Q + "\n" + BLOCK),
    ("同輪有表單", {}, Q + "\n" + BLOCK + '\n<form id="txf_backtest"/>\n<await/>'),
    ("只有 1 個選項", {}, Q + "\n<answers>\n重跑回測\n</answers>\n<await/>"),
    ("超過 32 字", {}, Q + "\n<answers>\n重跑回測\n" + "字" * 33 + "\n</answers>\n<await/>"),
]:
    def _fallback(kw=kw, text=text):
        reply = drive(at.WebSink("http://x/report", "t", "s1"), text, **kw)
        txt = shown(chunks)[0]
        return (not any(c["type"] == "answers" for c in chunks) and txt is not None and txt.startswith(Q)
                and "\n\n- 重跑回測" in txt and "<answers" not in txt and reply == txt), (txt, reply, chunks)

    ok(f"畫不出鈕 → 不送 chunk、選項還原成清單接在正文後:{name}", _fallback)


def _error_turn():
    s = at.WebSink("http://x/report", "t", "s1")
    s.answer_buttons = True
    chunks.clear()
    s.on_text(REPLY)
    s.set_error("boom", code="partial")
    s.finalize()
    return not any(c["type"] == "answers" for c in chunks), chunks


ok("出錯的回合不送 answers", _error_turn)


def _tg():
    sent = []

    class FakeStreamer:
        def __init__(self, *a):
            pass

        def update(self, text):
            pass

        def finish(self, text):
            sent.append(text)

        def discard(self):
            pass

    real = at.TelegramStreamer
    at.TelegramStreamer = FakeStreamer
    try:
        sink = at.TelegramSink("tok", "chat")
        sink.on_text(REPLY)
        reply = sink.finalize()
    finally:
        at.TelegramStreamer = real
    return reply == Q + LIST and all("<answers" not in t for t in sent), (reply, sent)


ok("TelegramSink:剝掉區塊、選項還原成清單", _tg)


# ── 5. prompt 規則與能力旗標 ──
def bp(**kw):
    return at.build_prompt("", [], "這支要怎麼調", suggest_directive=True, **kw)


ok("沒旗標 build_prompt 不含 <answers>", lambda: ("<answers>" not in bp(), ""))
ok("有旗標含 _ANSWERS_RULE,且排在建議錨之前", lambda: (lambda p: (
    at._ANSWERS_RULE in p and p.index(at._ANSWERS_RULE) < p.index(at._SUGGEST_ANCHORS["normal"]), ""))(bp(answer_buttons=True)))
ok("TG(suggest_directive=False)就算有旗標也不掛", lambda: (
    "<answers>" not in at.build_prompt("", [], "這支要怎麼調", answer_buttons=True), ""))
ok("_ANSWERS_RULE:不編號、用 default 標建議(Wei 11-20)、await 前、不附 suggest、動到錢的確認不准用", lambda: (
    all(s in at._ANSWERS_RULE for s in ("不編號", "default 標出你建議的那一個", "`<await/>` 前", "不附 <suggest>", "下單", "綁卡", "扣款", "32 字")),
    at._ANSWERS_RULE))
ok("_ANSWERS_RULE 的範例區塊照抄就解得出合格選項與 default(弱模型會照抄範例)", lambda: (lambda r: (
    r[1] is not None and at._answers_ok(r[1]) and r[2] == 1, r))(at.extract_answers(at._ANSWERS_RULE)))
ok("格式規則尾端不變(_AWAIT_RULE 最後)", lambda: (
    at.WEB_FORMATTING_RULE.endswith(at._SUGGEST_RULE + at._AWAIT_RULE) and "<answers>" not in at.WEB_FORMATTING_RULE, ""))

SRC = open(os.path.join(ROOT, "runtime", "agent_turn.py"), encoding="utf-8").read()
ok("build_prompt 兩個呼叫點(首輪、續跑)都傳 answer_buttons", lambda: (lambda calls: (
    len(calls) == 2 and all("answer_buttons=answer_buttons" in c for c in calls), calls))(
    re.findall(r"prompt = build_prompt\((.*?)\)\n", SRC, re.S)))
ok("argparse 有 --answer-buttons(store_true)且交給 run_turn,run_turn 設到 sink", lambda: (
    re.search(r'add_argument\("--answer-buttons", action="store_true"\)', SRC) is not None
    and "answer_buttons=args.answer_buttons" in SRC and "sink.answer_buttons = " in SRC, ""))

print()
print("ALL PASS" if not fails else f"{len(fails)} FAILED: {fails}")
sys.exit(1 if fails else 0)
