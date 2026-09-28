"""Footnote ids are unique in every report lib writes, and in every report sent to the api.

The api refuses a footnote block whose item ids repeat (openclaw/report_blocks_validate
`_v_footnote`), on a cloud upload and on a public link alike. Checked here:
  1. the rule itself, on one table of cases run through its three copies — lib/report.py,
     runtime/report_uploader.py, shell/reportshare.js — which must give the same answer;
  2. every template, with and without extra bricks, and custom recipes that mix Taiwan and
     crypto bricks: ids unique, every `[^id]` resolves, the joined source line punctuated;
  3. the api's own validator on what was written (BLAVE_API_DIR or ../api; skipped without).
No network. Run: cd blave-agent && .venv/bin/python tests/check_report_footnotes.py
"""
import importlib.util, json, os, re, shutil, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# The fake data of check_report_bricks.py (everything above its first check), not a second copy.
src = open(os.path.join(ROOT, "tests", "check_report_bricks.py"), encoding="utf-8").read()
cut = src.index("\nfails = 0\n")
exec(compile(src[:cut], "check_report_bricks.py[fakes]", "exec"))
os.environ["BLAVE_AGENT_LOCAL"] = "1"
tdays = pd.bdate_range("2026-05-01", "2026-09-02", tz="Asia/Taipei")
d.fetch_twstock_ohlcv = lambda sid, iv, h, start=None, end=None: pd.DataFrame(
    {"Open": 100.0, "High": 101.0, "Low": 99.0, "Close": 100.5, "Volume": 10_000.0}, index=tdays)
d.fetch_twstock_institutional = lambda sid, start, end, h: pd.DataFrame({"foreign_net": 1_000_000.0}, index=tdays)
d.fetch_twstock_list = lambda h, **k: pd.DataFrame({"name": ["台積電"]}, index=pd.Index(["2330"], name="stock_id"))
sys.path.insert(0, os.path.join(ROOT, "runtime"))
import report_uploader as U

fails = 0
def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg); fails += (not cond)

API = os.environ.get("BLAVE_API_DIR") or os.path.join(os.path.dirname(ROOT), "api")
V = None
vp = os.path.join(API, "openclaw", "report_blocks_validate.py")
if os.path.isfile(vp):
    spec = importlib.util.spec_from_file_location("report_blocks_validate", vp)
    V = importlib.util.module_from_spec(spec); spec.loader.exec_module(V)
else:
    print("SKIP  the api validator (no openclaw/report_blocks_validate.py; set BLAVE_API_DIR)")

def api_says(block):
    if V is None:
        return None
    try:
        V.validate_block(block, "blocks[n]")
    except Exception as e:
        return str(e)
    return None

FNREF = re.compile(r"\[\^([A-Za-z0-9_-]{1,32})\]")
PUNCT_END = re.compile(r"[。．.!?！？；;][)）」』】》”’\"']*$")

# ── 1. the rule, three copies ──
LONG = "長" * 600
CASES = [
    ("Wei 0928 實測那一份的形狀",
     [{"id": "inst", "text": "外資買賣超 = 外資買進 − 賣出。"}, {"id": "src", "text": "日 K 為 TWSE 未還原價"},
      {"id": "src", "text": "指數、成交值:TWSE 日資料,經 Blave API。"}, {"id": "news", "text": "新聞為 agent 於 12:58 蒐集整理。"}],
     [{"id": "inst", "text": "外資買賣超 = 外資買進 − 賣出。"},
      {"id": "src", "text": "日 K 為 TWSE 未還原價。指數、成交值:TWSE 日資料,經 Blave API。"},
      {"id": "news", "text": "新聞為 agent 於 12:58 蒐集整理。"}]),
    ("同一句出現兩次只留一次",
     [{"id": "a", "text": "同一句。"}, {"id": "a", "text": "同一句。"}], [{"id": "a", "text": "同一句。"}]),
    ("以分號結尾的片段是接著講,不補句號;英文補英文句點",
     [{"id": "a", "text": "市場方向為 z-score;"}, {"id": "a", "text": "曝險為原始值。"},
      {"id": "b", "text": "Prices: Binance"}, {"id": "b", "text": "Funding in %."}],
     [{"id": "a", "text": "市場方向為 z-score;曝險為原始值。"}, {"id": "b", "text": "Prices: Binance.Funding in %."}]),
    ("括號收尾的片段照樣補句號",
     [{"id": "a", "text": "日 K(未還原)"}, {"id": "a", "text": "量為張。"}], [{"id": "a", "text": "日 K(未還原)。量為張。"}]),
    ("連結不同併不了:後者改名,已有的 -2 讓開",
     [{"id": "s", "text": "甲。", "url": "https://a.example/1"}, {"id": "s", "text": "乙。", "url": "https://b.example/2"},
      {"id": "s-2", "text": "丙。"}],
     [{"id": "s", "text": "甲。", "url": "https://a.example/1"}, {"id": "s-3", "text": "乙。", "url": "https://b.example/2"},
      {"id": "s-2", "text": "丙。"}]),
    ("併完超過 1000 字:後者改名", [{"id": "s", "text": LONG + "。"}, {"id": "s", "text": "二" + LONG + "。"}],
     [{"id": "s", "text": LONG + "。"}, {"id": "s-2", "text": "二" + LONG + "。"}]),
    ("32 字的 id 改名後仍在 32 字內", [{"id": "x" * 32, "text": "甲。", "url": "https://a.example/1"}, {"id": "x" * 32, "text": "乙。"}],
     [{"id": "x" * 32, "text": "甲。", "url": "https://a.example/1"}, {"id": "x" * 28 + "-2", "text": "乙。"}]),
    ("沒有重複的原樣", [{"id": "a", "text": "甲"}, {"id": "b", "text": "乙"}], [{"id": "a", "text": "甲"}, {"id": "b", "text": "乙"}]),
]
node = shutil.which("node")
js = None
if node:
    script = ("const RS=require(%s);let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{"
              "console.log(JSON.stringify(JSON.parse(s).map(items=>RS.uniqueFootnotes({blocks:[{type:'meta'},{type:'footnote',items}]}).blocks[1].items)))})"
              % json.dumps(os.path.join(ROOT, "shell", "reportshare.js")))
    r = subprocess.run([node, "-e", script], input=json.dumps([c[1] for c in CASES]), capture_output=True, text=True, timeout=60)
    check(r.returncode == 0, "shell/reportshare.js uniqueFootnotes 跑得起來" + ("" if r.returncode == 0 else " — " + r.stderr[-300:]))
    js = json.loads(r.stdout) if r.returncode == 0 else None
else:
    print("SKIP  shell/reportshare.js 的那一份(找不到 node)")
for i, (name, given, want) in enumerate(CASES):
    before = json.dumps(given, ensure_ascii=False)
    blocks = [{"type": "meta"}, {"type": "footnote", "items": given}]
    got_lib, rep = R.unique_footnotes(blocks)
    got_rt, _ = U.unique_footnotes(blocks)
    ok = got_lib[1]["items"] == want and got_rt[1]["items"] == want and (js is None or js[i] == want)
    check(ok, f"{name}:lib / runtime / shell 三份同一個答案" + ("" if ok else
          f" — lib {got_lib[1]['items']} runtime {got_rt[1]['items']} shell {js[i] if js else None}"))
    check(json.dumps(given, ensure_ascii=False) == before, f"{name}:不改傳進來的那一份")
    ids = [x["id"] for x in want]
    check(len(set(ids)) == len(ids) and api_says({"type": "footnote", "items": got_lib[1]["items"]}) is None,
          f"{name}:結果 id 不重複,api 的驗證器收")
    check(given[0]["id"] == got_lib[1]["items"][0]["id"], f"{name}:第一列的 id 不變([^id] 照樣對得到)")
if V is not None:
    check("unique" in (api_says({"type": "footnote", "items": CASES[0][1]}) or ""),
          "對照:沒併之前 api 的驗證器拒收(footnote ids must be unique)")

# ── 2. every template and mixed recipes ──
TW_X = [["price_chart", {"symbol": "2330"}]]
CR_X = [["coin_snapshot", {"symbol": "BTC"}], ["funding", {"symbol": "BTC"}]]
MIX = {"id": "my-mix", "title": "台股與加密", "kpi": ["price_chart"],
       "bricks": [["price_chart", {"symbol": "TAIEX"}], ["tw_institutional", {}], ["price_chart", {"symbol": "2330"}],
                  ["price_chart", {"symbol": "BTC"}], ["funding", {"symbol": "BTC"}], ["liquidation", {"hours": 24}],
                  ["blave_indicators", {"names": ["市場方向", "資金稀缺", "頂尖交易員曝險"]}]]}
MIX2 = {"id": "my-mix2", "title": "加密在前", "kpi": ["quote_table"],
        "bricks": [["quote_table", {"top_mcap": 3}], ["movers", {"market": "crypto", "n": 5}], ["price_chart", {"symbol": "TAIEX"}],
                   ["tw_margin", {}]]}
D1, D0 = "2026-09-02", "2026-09-01"
PACKS = [
    ("tw_market_brief", lambda: T.tw_market_brief(D1, H, fresh=True)),
    ("tw_market_brief + 個股 K", lambda: T.tw_market_brief(D1, H, fresh=True, extra=TW_X)),
    ("tw_market_brief + 加密積木", lambda: T.tw_market_brief(D1, H, fresh=True, extra=CR_X)),
    ("tw_close_brief", lambda: T.tw_close_brief(D0, H, fresh=True)),
    ("tw_close_brief + 個股 K", lambda: T.tw_close_brief(D0, H, fresh=True, extra=TW_X)),
    ("tw_close_brief + 加密積木", lambda: T.tw_close_brief(D0, H, fresh=True, extra=CR_X)),
    ("crypto_market_brief", lambda: T.crypto_market_brief(D1, H, fresh=True)),
    ("crypto_market_brief + 台股積木", lambda: T.crypto_market_brief(D1, H, fresh=True, extra=[["price_chart", {"symbol": "TAIEX"}]] + TW_X)),
    ("symbol_brief BTC", lambda: T.symbol_brief("BTC", D1, H, fresh=True)),
    ("symbol_brief 2330", lambda: T.symbol_brief("2330", D1, H, fresh=True)),
    ("symbol_brief 2330 + 大盤", lambda: T.symbol_brief("2330", D1, H, fresh=True, extra=[["price_chart", {"symbol": "TAIEX"}]])),
    ("symbol_brief BTC + 大盤", lambda: T.symbol_brief("BTC", D1, H, fresh=True, extra=[["price_chart", {"symbol": "TAIEX"}]])),
    ("自訂配方:台股 + 加密混用", lambda: T.build(T.check_recipe(MIX), D1, H, fresh=True)),
    ("自訂配方:加密在前、台股在後", lambda: T.build(T.check_recipe(MIX2), D1, H, fresh=True)),
]
two_src = 0
for k, (name, make) in enumerate(PACKS):   # 不叫 n:假資料的 lambda 讀全域的 n
    pack = make()
    if pack.skip:
        check(False, f"{name}:假資料下產得出來 — {pack.skip}")
        continue
    foot = pack.blocks[-1]
    ids = [i["id"] for i in foot["items"]]
    check(foot["type"] == "footnote" and len(set(ids)) == len(ids), f"{name}:pack 的尾註 id 不重複 {ids}")
    srcs = [i["text"] for i in foot["items"] if i["id"] == "src"]
    two_src += bool(srcs) and "指數、成交值" in srcs[0] and not srcs[0].startswith("指數、成交值")
    check(bool(srcs) and PUNCT_END.search(srcs[0]) is not None and "未還原價價格" not in srcs[0] and "未還原價指數" not in srcs[0]
          and not re.search(r"[。.;；][,,、。]", srcs[0])
          and not re.search(r"[^。.;；](價格[:：]|指數、成交值|資金費率|日 K 為|漲跌幅[:：]|成交量為張|前 20 日高/低|市場方向 /|爆倉 /|日頻指標)", srcs[0]),
          f"{name}:來源句的片段之間有句末標點 — {srcs[0][:90] if srcs else '沒有 src'}")
    path = T.publish(pack, report_id=f"fn-{k}")
    blocks = json.load(open(path, encoding="utf-8"))["blocks"]
    foot = blocks[-1]
    ids = [i["id"] for i in foot["items"]]
    refs = {r for b in blocks if b["type"] == "text" for r in FNREF.findall(b.get("markdown", ""))}
    check(len(set(ids)) == len(ids) and refs <= set(ids), f"{name}:寫出來的報告 id 不重複、[^id] 都對得到")
    err = api_says(foot)
    check(err is None, f"{name}:api 的驗證器收這份尾註" + ("" if err is None else f" — {err}"))
    check(U.check_report(json.load(open(path, encoding="utf-8")), f"fn-{k}") is None, f"{name}:runtime 的本地預檢收")
check(two_src >= 8, f"列舉裡有 {two_src} 份是「積木的來源句 + 台股大盤收尾的來源句」併成一列(0.1.7 會寫出兩條 src 的那種)")

# narrative 引用 [^src]:併過之後照樣對得到
pk = T.tw_close_brief(D0, H, fresh=True, extra=TW_X)
p = pub(pk, {"lead": "外資轉賣、指數收高[^src],融資續增[^margin]。", "no_extra": "測試", "few_sources": "測試", "news": []}, report_id="fn-ref")
b = json.load(open(p, encoding="utf-8"))["blocks"]
ids = [i["id"] for i in b[-1]["items"]]
check({"src", "margin"} <= set(ids) and len(set(ids)) == len(ids) and "[^src]" in b[1]["markdown"],
      f"敘事引用 [^src] / [^margin]:各對到唯一的一列 {ids}")

# ── 3. write_report / edit_report: a hand-written repeat is put right on the way in ──
HAND = [{"type": "text", "markdown": "結論[^src]。"},
        {"type": "footnote", "items": [{"id": "src", "text": "價格:Binance"}, {"id": "src", "text": "資金費率:Binance。"}]}]
given = json.dumps(HAND, ensure_ascii=False)
p = R.write_report("fn-hand", "手寫", HAND)
b = json.load(open(p, encoding="utf-8"))["blocks"]
check(b[-1]["items"] == [{"id": "src", "text": "價格:Binance。資金費率:Binance。"}] and json.dumps(HAND, ensure_ascii=False) == given,
      "write_report:手寫的重複 id 寫入時併成一列,呼叫端的 list 不動")
check(api_says(b[-1]) is None and U.check_report(json.load(open(p, encoding="utf-8")), "fn-hand") is None, "write_report:寫出來的 api 與 runtime 都收")
BROKEN = {"schema_version": "1.1", "id": "fn-old", "type": "research", "title": "舊報告", "created_at": 1790000000,
          "blocks": [{"type": "meta", "title": "舊報告", "report_type": "research", "generated_at": 1790000000}] + HAND}
with open(os.path.join(R.REPORTS_DIR, "fn-old.json"), "w", encoding="utf-8") as f:
    json.dump(BROKEN, f, ensure_ascii=False)
p = R.edit_report("fn-old", title="舊報告(改標題)")
b = json.load(open(p, encoding="utf-8"))["blocks"]
check([i["id"] for i in b[-1]["items"]] == ["src"] and api_says(b[-1]) is None, "edit_report:已經寫壞的報告改一次就修好")


# ── 4. the uploader sends the repaired body (a report an older lib wrote), the file as it was ──
U.REPORTS_DIR, U.SENT_DIR, U.FAILED_DIR = R.REPORTS_DIR, os.path.join(R.REPORTS_DIR, "sent"), os.path.join(R.REPORTS_DIR, "failed")
U.ERROR_LOG, U.QUIET_S = os.path.join(R.REPORTS_DIR, "upload_errors.log"), 0
put = []
U._put = lambda body, rid, token: put.append(json.loads(body)) or {"ok": True}
old = os.path.join(R.REPORTS_DIR, "fn-up.json")
with open(old, "w", encoding="utf-8") as f:
    json.dump(dict(BROKEN, id="fn-up"), f, ensure_ascii=False)
os.utime(old, (1, 1))
got = U.upload_one("fn-up", old, {}, "tok")
check(got == "sent" and len(put) == 1 and [i["id"] for i in put[0]["blocks"][-1]["items"]] == ["src"]
      and api_says(put[0]["blocks"][-1]) is None, f"runtime 上傳:舊 lib 寫的重複 id 在送出前併好({got})")

print("\nFAILED" if fails else "\nALL PASS", f"({fails} failed)" if fails else "")
sys.exit(1 if fails else 0)
