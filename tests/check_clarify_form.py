"""聊天裡的澄清表單(spec agent-clarify-form-2026-10-31 §1):<form id="…"/> 標記 → runtime 剝掉、另送 form chunk。

型錄(題目、選項、預設、年份、資料那一句)固定在 runtime,模型只選用與填用戶講過的值;規則只在
--clarify-form 時掛。四個 sink 的剝除列舉在 tests/check_await_marker.py。
Contract: references/turn-events.md. Run: cd blave-agent && python3 tests/check_clarify_form.py
"""
import io, json, os, re, sys, tempfile, types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))
WS = tempfile.mkdtemp(prefix="check-clarify-ws-")
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


BODY = "可以做。先選幾個設定，不確定就照預設。"
TAG = '<form id="txf_backtest" prod="mxf" tf="m5"/>'
OPTS = {"prod": ["txf", "mxf", "tmf"], "tf": ["d", "m1", "m5", "m15"], "per": ["all", "y3", "y1"],
        "st": ["ma", "ch", "other"]}


def values(chunk):
    return {q["key"]: q["value"] for q in chunk["questions"]}


def q(chunk, key):
    return next(x for x in chunk["questions"] if x["key"] == key)


# ── 1. extract_form ──
def _legal():
    text, c = at.extract_form(BODY + "\n" + TAG, cloud=True, why=None)
    return (text == BODY and c["type"] == "form" and c["id"] == "txf_backtest"
            and [x["key"] for x in c["questions"]] == ["prod", "tf", "per", "st"]
            and all(x["options"] == OPTS[x["key"]] for x in c["questions"])
            and values(c) == {"prod": "mxf", "tf": "m5", "per": "all", "st": "ma"}), (text, c)


ok("合法標記 → 文字乾淨＋chunk;講了的值蓋預設、沒講的用型錄預設", _legal)


def _bad_attr():
    text, c = at.extract_form(BODY + '\n<form id="txf_backtest" prod="btc" tf="m5" zz="x"/>', cloud=True, why=None)
    return text == BODY and values(c) == {"prod": "txf", "tf": "m5", "per": "all", "st": "ma"}, c


ok("屬性值不在 options → 退預設;不認得的屬性忽略", _bad_attr)


def _no_attr():
    text, c = at.extract_form(BODY + '\n<form id="txf_backtest" />', cloud=True, why=None)
    return text == BODY and values(c) == {"prod": "txf", "tf": "d", "per": "all", "st": "ma"}, c


ok("沒屬性 → 全預設", _no_attr)


def _last_wins():
    raw = BODY + '\n<form id="txf_backtest" prod="tmf"/>\n<form id="txf_backtest" prod="mxf"/>'
    text, c = at.extract_form(raw, cloud=True, why=None)
    return text == BODY and values(c)["prod"] == "mxf", (text, c)


ok("多個標記取最後一個合法的、全部剝掉", _last_wins)

for name, raw in [
    ("單獨 </form>", BODY + "\n</form>"),
    ("成對隔行 <form id=\"x\">\\n</form>", BODY + '\n<form id="x">\n</form>'),
    ("少 id", BODY + '\n<form prod="mxf"/>'),
    ("id 不在型錄", BODY + '\n<form id="crypto_bt"/>'),
    ("不是自閉合 <form id=\"txf_backtest\">", BODY + '\n<form id="txf_backtest">'),
]:
    ok(f"只剝不觸發:{name}",
       lambda raw=raw: ((lambda r: (r == (BODY, None), r))(at.extract_form(raw, cloud=True, why=None))))

ok("夾在中間也剝(前後空白一起)", lambda: (lambda r: (r[0] == "前段後段" and r[1] is not None, r))(
    at.extract_form('前段 <form id="txf_backtest"/> 後段', cloud=True, why=None)))
ok("沒有標記一字不動", lambda: (lambda r: (r == ("回測跑完了。\n", None), r))(
    at.extract_form("回測跑完了。\n", cloud=True, why=None)))
ok("談到 form 這個字不算", lambda: (lambda r: (r == ("form 表單 formula", None), r))(
    at.extract_form("form 表單 formula", cloud=True, why=None)))
ok("空字串／None 不炸", lambda: (at.extract_form("", cloud=True, why=None) == ("", None)
                              and at.extract_form(None, cloud=True, why=None) == (None, None), ""))


# ── 2. visible_text ──
ok('visible_text(只有標記) == ""', lambda: (at.visible_text('<form id="txf_backtest"/>') == "", ""))
ok("visible_text(兩句＋標記) 只剩兩句", lambda: (at.visible_text(BODY + "\n" + TAG + "\n<await/>") == BODY,
                                          at.visible_text(BODY + "\n" + TAG)))
ok("只有標記不算回了話(_counts_as_reply)", lambda: (not at._counts_as_reply(TAG + "\n<await/>"), ""))


# ── 3. 年份與 note ──
def yn(cloud, why):
    c = at.extract_form(TAG, cloud=cloud, why=why)[1]
    return q(c, "per").get("years"), q(c, "tf").get("note", "<none>")


ok("雲端 → 三個 2011、無 note", lambda: (yn(True, None) == ({"txf": 2011, "mxf": 2011, "tmf": 2011}, "<none>"),
                                    yn(True, None)))
ok("電腦版有資料(why=None) → 1998／2001／2011、無 note",
   lambda: (yn(False, None) == ({"txf": 1998, "mxf": 2001, "tmf": 2011}, "<none>"), yn(False, None)))
ok("電腦版 why=no_plan → TMF 2024、note=nodata",
   lambda: (yn(False, "no_plan") == ({"txf": 1998, "mxf": 2001, "tmf": 2024}, "nodata"), yn(False, "no_plan")))
ok("why=signed_out → note=nodata_signed_out", lambda: (yn(False, "signed_out")[1] == "nodata_signed_out", ""))
ok("why=garbage → nodata", lambda: (yn(False, "garbage")[1] == "nodata", ""))
ok("note／years 只掛在 tf／per 那兩題",
   lambda: (lambda c: (all("note" not in x for x in c["questions"] if x["key"] != "tf")
                       and all("years" not in x for x in c["questions"] if x["key"] != "per"), c))(
       at.extract_form(TAG, cloud=False, why="no_plan")[1]))


def _why_env():
    saved = {k: os.environ.get(k) for k in ("BLAVE_DATA_ACCESS", "BLAVE_DATA_ACCESS_WHY")}
    out = []
    try:
        for access, why in [(None, None), ("1", "no_plan"), ("0", None), ("0", ""), ("0", "signed_out")]:
            for k, v in (("BLAVE_DATA_ACCESS", access), ("BLAVE_DATA_ACCESS_WHY", why)):
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
            out.append(at._form_why())
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
    return out == [None, None, "unknown", "unknown", "signed_out"], out


ok("_form_why:只有 BLAVE_DATA_ACCESS=0 才非 None,WHY 缺或空當 unknown", _why_env)


# ── 4. sink:chunk 順序、Stop 截斷、TG 不送 ──
chunks = []
at._post_report = lambda url, token, chunk, timeout=15: chunks.append(chunk)
REPLY = BODY + "\n" + TAG + "\n<await/>"


def drive(sink, text=REPLY, interrupted=False):
    chunks.clear()
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


def _web_order():
    reply = drive(at.WebSink("http://x/report", "t", "s1"),
                  BODY + "\n" + TAG + "\n<await/>\n<suggest>\n掃一下參數\n</suggest>")
    order = [c["type"] for c in chunks if c["type"] != "text"]
    form = [c for c in chunks if c["type"] == "form"]
    return (order == ["text_replace", "form", "suggestions", "done"] and reply == BODY
            and form[0]["session_id"] == "s1" and set(form[0]) == {"type", "session_id", "id", "questions"}
            and "note" not in q(form[0], "tf") and q(form[0], "per")["years"]["txf"] == 2011), (order, chunks)


ok("WebSink(雲端):text_replace → form → suggestions → done,form 帶 session_id、雲端年份、無 note", _web_order)


def _web_export_order():
    exp = os.path.join(WS, "strategies", "s", "exports")
    os.makedirs(exp, exist_ok=True)
    open(os.path.join(exp, "xq.xs"), "w", encoding="utf-8").write("x")
    drive(at.WebSink("http://x/report", "t", "s1"),
          BODY + '\n<export target="xq" path="strategies/s/exports/xq.xs" />\n' + TAG)
    order = [c["type"] for c in chunks if c["type"] != "text"]
    return order == ["text_replace", "export", "form", "done"], order


ok("WebSink:export 在 form 之前", _web_export_order)


def _local_nodata():
    os.environ.update({"BLAVE_DATA_ACCESS": "0", "BLAVE_DATA_ACCESS_WHY": "signed_out"})
    try:
        drive(at.LocalSink("s9"))
    finally:
        os.environ.pop("BLAVE_DATA_ACCESS", None)
        os.environ.pop("BLAVE_DATA_ACCESS_WHY", None)
    form = [c for c in chunks if c["type"] == "form"]
    return (form and q(form[0], "tf").get("note") == "nodata_signed_out"
            and q(form[0], "per")["years"] == {"txf": 1998, "mxf": 2001, "tmf": 2024}), chunks


ok("LocalSink(電腦版、沒登入):note=nodata_signed_out、年份 1998／2001／2024", _local_nodata)


def _interrupted():
    drive(at.WebSink("http://x/report", "t", "s1"), interrupted=True)
    final = [c for c in chunks if c["type"] != "text"]  # 串流 delta 本來就短暫帶著標記,由 text_replace 換掉
    return not any(c["type"] == "form" for c in chunks) and all("<form" not in json.dumps(c) for c in final), chunks


ok("被 Stop 截斷:標記照剝、不送 form", _interrupted)


def _error_turn():
    s = at.WebSink("http://x/report", "t", "s1")
    chunks.clear()
    s.on_text(REPLY)
    s.set_error("boom", code="partial")
    s.finalize()
    return not any(c["type"] == "form" for c in chunks), chunks


ok("出錯的回合不送 form", _error_turn)


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
    return reply == BODY and all("<form" not in t for t in sent), (reply, sent)


ok("TelegramSink:只剝、回覆只剩兩句", _tg)


# ── 5. prompt 規則與能力旗標 ──
def bp(**kw):
    return at.build_prompt("", [], "幫我做個台指期策略回測", suggest_directive=True, **kw)


ok("沒旗標 build_prompt 不含 <form id=", lambda: ("<form id=" not in bp(), ""))
ok("有旗標含 _FORM_RULE,且排在建議錨之前", lambda: (lambda p: (
    at._FORM_RULE in p and p.index(at._FORM_RULE) < p.index(at._SUGGEST_ANCHORS["normal"]), ""))(bp(clarify_form=True)))
ok("TG(suggest_directive=False)就算有旗標也不掛", lambda: (
    "<form id=" not in at.build_prompt("", [], "幫我做個台指期策略回測", clarify_form=True), ""))
ok("_FORM_RULE 帶標記寫法、同時寫 <await/>、不附 <suggest>", lambda: (
    all(s in at._FORM_RULE for s in ('<form id="txf_backtest"', "同時寫 `<await/>`", "不附 <suggest>")), at._FORM_RULE))
ok("_FORM_RULE 裡的範例標記照抄就解得出 chunk(弱模型會照抄範例)", lambda: (lambda tags: (
    bool(tags) and all(at.extract_form(t, cloud=True, why=None)[1] is not None for t in tags), tags))(
    re.findall(r"<form [^<>]*/>", at._FORM_RULE)))


def _over_limit():
    real = at._FORM_CATALOG["txf_backtest"]["questions"]
    try:
        at._FORM_CATALOG["txf_backtest"]["questions"] = real + [dict(real[0], key=f"x{i}") for i in range(2)]
        many_q = at.extract_form(TAG, cloud=True, why=None)
        at._FORM_CATALOG["txf_backtest"]["questions"] = [dict(real[0], options=[f"o{i}" for i in range(8)], default="o0")]
        many_o = at.extract_form(TAG, cloud=True, why=None)
    finally:
        at._FORM_CATALOG["txf_backtest"]["questions"] = real
    return many_q == ("", None) and many_o == ("", None), (many_q, many_o)


ok("型錄超過 FORM_MAX_QUESTIONS／FORM_MAX_OPTIONS → 整張丟(標記照剝)", _over_limit)
ok("_AWAIT_RULE 仍是格式規則最尾端", lambda: (
    at.WEB_FORMATTING_RULE.endswith(at._SUGGEST_RULE + at._AWAIT_RULE)
    and at.LOCAL_FORMATTING_RULE.endswith(at._SUGGEST_RULE + at._AWAIT_RULE)
    and "<form" not in at.WEB_FORMATTING_RULE, ""))

SRC = open(os.path.join(ROOT, "runtime", "agent_turn.py"), encoding="utf-8").read()


def _call_sites():
    calls = re.findall(r"prompt = build_prompt\((.*?)\)\n", SRC, re.S)
    return len(calls) == 2 and all("clarify_form=clarify_form" in c for c in calls), calls


ok("build_prompt 兩個呼叫點(首輪、續跑)都傳 clarify_form", _call_sites)
ok("argparse 有 --clarify-form(store_true)且交給 run_turn", lambda: (
    re.search(r'add_argument\("--clarify-form", action="store_true"\)', SRC) is not None
    and "clarify_form=args.clarify_form" in SRC, ""))

print()
print("ALL PASS" if not fails else f"{len(fails)} FAILED: {fails}")
sys.exit(1 if fails else 0)
