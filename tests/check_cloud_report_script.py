"""references/cloud-handoff.md › Reports asked from the cloud view:那支遠端腳本(從原文切出來跑)。

雲端主機的 lib/ 可能比這台電腦舊(沒有 load_pack、publish 不收 shareable / lang、沒有 news 槽)。
腳本要偵測能力後降級:舊機少的選項與槽列進 `dropped`,不准讓 TypeError / unknown slot 丟到用戶面前;
新機要重用 R3 那一包(load_pack),把 shareable 帶進 publish。兩種 lib 用最小替身模擬(形狀照
9aa8a7b = 2026-09-24-b 與現行 lib/report_templates.py 的簽名),不打網路。

跑法:python3 tests/check_cloud_report_script.py
"""
import atexit, json, os, re, shutil, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
doc = open(os.path.join(ROOT, "references", "cloud-handoff.md"), encoding="utf-8").read()
sec = doc[doc.index("## Reports asked from the cloud view"):doc.index("## Updating the cloud machine")]
# 0.1.37:主機上的請求檔帶這一輪的資料夾名(references 裡寫 <turn>,agent 照提示換成對話 id)
TURN = "desktop-report01"
SCRIPT = re.search(r"```py\n(.*?\n)```\n", sec, re.S).group(1).replace("<turn>", TURN)

COMMON = '''
import json
class Pack:
    def __init__(self, slots):
        self.report_id = "crypto-market-x"; self.slots = dict.fromkeys(slots, 0); self.skip = None
    def describe(self):
        return "[crypto-market-x] figures"
def _record(**kw):
    json.dump(kw, open("published.json", "w"))
    return "/w/reports/crypto-market-x.json"
'''
OLD = COMMON + '''
def crypto_market_brief(date=None, headers=None, symbols=("BTC",), lookback_days=30):
    return Pack(["lead", "read", "watch", "risk"])
def publish(pack, narrative=None, report_id=None, title=None, origin=None):
    unknown = set(narrative or {}) - set(pack.slots)
    if unknown:
        raise ValueError(f"unknown narrative slot(s): {sorted(unknown)}")
    return _record(narrative=narrative, title=title, origin=origin, loaded=False)
'''
NEW = COMMON + '''
def crypto_market_brief(date=None, headers=None, symbols=("BTC",), lookback_days=30, extra=None, fresh=False):
    return Pack(["lead", "read", "watch", "risk", "news"])
def research_pack(symbol, topics=None, extra=None):
    return Pack(["lead", "read"])
def load_pack(report_id):
    p = Pack(["lead", "read", "watch", "risk", "news"]); p.loaded = True
    return p
def publish(pack, narrative=None, report_id=None, title=None, origin=None, lang="zh", shareable=None):
    return _record(narrative=narrative, title=title, origin=origin, shareable=shareable, loaded=getattr(pack, "loaded", False))
'''

red = 0
# 每次 run 一個暫存 workspace,全部放在這一個目錄底下,結束時一起刪
SCRATCH = tempfile.mkdtemp(prefix="cloud-report-test-")
atexit.register(shutil.rmtree, SCRATCH, True)


def t(name, ok, detail=""):
    global red
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok else f"  ← {detail}"))
    red += 0 if ok else 1


def run(lib_src, mode, req):
    ws = tempfile.mkdtemp(prefix="cloud-report-", dir=SCRATCH)
    os.makedirs(os.path.join(ws, "lib")); os.makedirs(os.path.join(ws, "tmp"))
    open(os.path.join(ws, "lib", "__init__.py"), "w").close()
    open(os.path.join(ws, "lib", "report_templates.py"), "w").write(lib_src)
    json.dump(req, open(os.path.join(ws, "tmp", "cloud-report-" + TURN + ".json"), "w"))
    p = subprocess.run([sys.executable, "-", mode], input=SCRIPT, text=True, capture_output=True, cwd=ws)
    lines = [json.loads(x) for x in p.stdout.splitlines() if x.startswith("{")]
    pub = os.path.join(ws, "published.json")
    return p, lines, (json.load(open(pub)) if os.path.exists(pub) else None), os.path.exists(os.path.join(ws, "tmp", "cloud-report-" + TURN + ".json"))


BUILD = {"template": "crypto_market_brief", "args": [], "kwargs": {"extra": ["x"]}}
FULL = dict(BUILD, report_id="crypto-market-x", title="T", shareable=False, lang="zh",
            narrative={"lead": "L", "news": [{"title": "n"}]})

p, out, pub, left = run(OLD, "build", BUILD)
t("舊機 build:印 describe 與能力行;extra 舊機不收 → dropped;沒有 news 槽;請求檔留著給 publish",
  p.returncode == 0 and "figures" in p.stdout and out[-1]["report_id"] == "crypto-market-x"
  and "news" not in out[-1]["slots"] and out[-1]["dropped"] == ["extra"] and left and pub is None, p.stdout + p.stderr)

t("舊機 build:missing 列出沒有新聞與 shareable(R6 據此講一句、問要不要更新)", out[-1]["missing"] == ["news", "shareable"], out)
p, out, pub, left = run(NEW, "build", BUILD)
t("新機 build:missing 是空的", p.returncode == 0 and out[-1]["missing"] == [], p.stdout + p.stderr)
doc_r6 = sec[sec.index("R6."):sec.index("The script (R3")]
t("R6:missing / dropped 不空時講缺什麼並問要不要更新,沒被要求不動手",
  "`missing`" in doc_r6 and "要我更新嗎" in doc_r6 and "never start it without one" in doc_r6)

p, out, pub, left = run(OLD, "publish", FULL)
t("舊機 publish:不 TypeError;shareable / lang / narrative.news 列進 dropped、其餘照發;請求檔刪掉",
  p.returncode == 0 and pub and pub["narrative"] == {"lead": "L"} and pub["title"] == "T" and pub["origin"] == "chat"
  and set(out[0]["dropped"]) == {"extra", "narrative.news", "shareable", "lang"} and out[-1]["published"] == "crypto-market-x.json"
  and not left, p.stdout + p.stderr)

p, out, pub, left = run(NEW, "publish", FULL)
t("新機 publish:重用 R3 那一包(load_pack)、shareable 帶進去、news 照收、沒有 dropped",
  p.returncode == 0 and pub and pub["loaded"] and pub["shareable"] is False and "news" in pub["narrative"]
  and out[0]["dropped"] == [] and not left, p.stdout + p.stderr)

p, out, pub, left = run(NEW, "publish", dict(FULL, report_id="../x"))
t("report_id 不合字元集 → 不拿去 load_pack,改重建", p.returncode == 0 and pub and not pub["loaded"], p.stdout + p.stderr)

for lib, name, req in ((OLD, "舊機沒有 research_pack", {"template": "research_pack", "args": ["ETH"]}),
                       (NEW, "名單外的函式", {"template": "load_pack", "args": ["x"]})):
    p, out, pub, left = run(lib, "build", req)
    t(f"{name} → template_unavailable、不呼叫、請求檔刪掉(不留在雲端)",
      p.returncode == 0 and out == [{"error": "template_unavailable"}] and pub is None and not left, p.stdout + p.stderr)

SKIPLIB = NEW.replace('self.skip = None', 'self.skip = "2026-09-05 非交易日"')
p, out, pub, left = run(SKIPLIB, "build", {"template": "crypto_market_brief"})
t("build 回 skip(R3 之後就停):請求檔刪掉", p.returncode == 0 and out[-1]["skip"] and not left, p.stdout + p.stderr)
p, out, pub, left = run(NEW, "build", {"template": "crypto_market_brief"})
t("正常 build:請求檔留著給 publish 用", p.returncode == 0 and left, p.stdout + p.stderr)

p, out, pub, left = run(OLD, "publish", dict(FULL, template="nope"))
t("publish 走到一半就停(模板不可用)也刪掉請求檔", not left and pub is None, p.stdout + p.stderr)

# ── R7 研究報告:分析腳本在雲端寫 blocks 檔,固定腳本組好後呼叫 lib.report.write_report ──
r7 = sec[sec.index("### R7."):]
RSCRIPT = re.search(r"The research script.*?```py\n(.*?\n)```\n", r7, re.S).group(1).replace("<turn>", TURN)
# 電腦版這一則回覆的 BLAVE_TURN_ID(R7.5 先讀出來當第二個參數):status／replace 只認這一則寫的(稽核 r3 P3-A)
REPLY, REPLY_B = "0123456789abcdef", "fedcba9876543210"
# 舊機 = 2026-09-28 前(沒有 target_id:同 id 會覆蓋、不認 1.4 以上的 schema)
R_OLD = '''
def write_report(report_id, title, blocks, type="research", report_type=None, created_at=None, meta=None, images=None):
    raise AssertionError("old lib must not be called")
'''
R_NEW = '''
import json
def target_id(report_id, replace=False):
    return report_id
def write_report(report_id, title, blocks, type="research", report_type=None, created_at=None, meta=None, images=None, replace=False):
    if any(b.get("markdown") == "REFUSE" for b in blocks):
        raise ValueError("The platform refused report x, so nothing was written: HTTP 400 blocks[1]")
    json.dump(dict(id=report_id, title=title, blocks=blocks, type=type, meta=meta,
                   images={k: v.decode("latin-1") for k, v in images.items()} if images else images), open("published.json", "w"))
    return "/w/reports/" + report_id + ".json"
FAILED_DIR, SENT_DIR, LEDGER = "reports/failed", "reports/sent", "reports/.written.jsonl"
CITED_IMAGES_MAX = 2
def status(report_id):
    return "sent"
'''


def put_pics(ws, pics):
    d = os.path.join(ws, "tmp", "cloud-report-" + TURN + "-files")
    for n, b in (pics or {}).items():
        os.makedirs(d, exist_ok=True)
        if isinstance(b, str):   # 一條路徑 = 放一個指過去的 symlink
            os.symlink(b, os.path.join(d, n))
        else:
            open(os.path.join(d, n), "wb").write(b)
    return d


def run_r7(lib_src, mode, req, built, reply=REPLY, pics=None):
    ws = tempfile.mkdtemp(prefix="cloud-research-", dir=SCRATCH)
    os.makedirs(os.path.join(ws, "lib")); os.makedirs(os.path.join(ws, "tmp"))
    open(os.path.join(ws, "lib", "__init__.py"), "w").close()
    if lib_src is not None:
        open(os.path.join(ws, "lib", "report.py"), "w").write(lib_src)
    reqp = os.path.join(ws, "tmp", "cloud-report-" + TURN + ".json")
    datap = os.path.join(ws, "tmp", "cloud-report-" + TURN + "-blocks.json")
    if req is not None:
        json.dump(req, open(reqp, "w"))
    if built is not None:
        json.dump(built, open(datap, "w"))
    put_pics(ws, pics)
    p = subprocess.run([sys.executable, "-", mode] + ([reply] if reply else []), input=RSCRIPT, text=True, capture_output=True, cwd=ws)
    lines = [json.loads(x) for x in p.stdout.splitlines() if x.startswith("{")]
    pub = os.path.join(ws, "published.json")
    return p, lines, (json.load(open(pub)) if os.path.exists(pub) else None), (os.path.exists(reqp), os.path.exists(datap))


BUILT = {"kpi": {"type": "kpi_row", "items": [{"label": "n", "value": "12"}]},
         "charts": [{"type": "line_chart", "series": []}, {"type": "table", "rows": []}],
         "spare": {"type": "table", "rows": []}}
RREQ = {"report_id": "pcr-study-1", "title": "PCR 高檔後一週台指期偏弱", "type": "research", "shareable": False,
        "blocks": [{"type": "text", "variant": "lead", "markdown": "L"}, {"analysis": "kpi"}, {"analysis": "charts"},
                   {"type": "image", "file": "x.png"}, {"type": "meta", "title": "hijack"},
                   {"type": "footnote", "items": [{"id": "1", "text": "s", "url": "https://x"}]}]}

p, out, pub, left = run_r7(R_NEW, "publish", RREQ, BUILT)
t("R7 新機 publish:佔位換成分析 block(list 攤平、照順序)、type／shareable／origin 進去、沒 source 的 image 與 meta 丟掉列出、沒用到的列 unused、兩個檔都刪",
  p.returncode == 0 and pub and [b["type"] for b in pub["blocks"]] == ["text", "kpi_row", "line_chart", "table", "footnote"]
  and pub["type"] == "research" and pub["meta"] == {"origin": "chat", "shareable": False} and pub["images"] is None
  and pub["title"] == RREQ["title"] and out[-1] == {"published": "pcr-study-1.json", "upload": "sent", "dropped": ["blocks[3].image", "blocks[4].meta"], "unused": ["spare"]}
  and left == (False, False), p.stdout + p.stderr)

p, out, pub, left = run_r7(R_OLD, "publish", RREQ, BUILT)
t("R7 舊機(沒有 target_id)→ template_unavailable、不呼叫 write_report、兩個檔都刪",
  p.returncode == 0 and out == [{"error": "template_unavailable"}] and pub is None and left == (False, False), p.stdout + p.stderr)
p, out, pub, left = run_r7(None, "publish", RREQ, BUILT)
t("R7 沒有 lib/report.py → template_unavailable", p.returncode == 0 and out == [{"error": "template_unavailable"}] and left == (False, False),
  p.stdout + p.stderr)

bad = dict(RREQ, report_id="../x", title="", type="weekly", blocks=[{"analysis": "nope"}, "str", {"analysis": ["kpi"]}])
p, out, pub, left = run_r7(R_NEW, "publish", bad, BUILT)
msgs = (out[-1].get("refused") or []) if out else []
t("R7 id／title／type／未知佔位／非物件 block 一次全列出(編號)、不呼叫 write_report、兩個檔留著給下一次",
  p.returncode == 0 and pub is None and left == (True, True) and len(msgs) == 7
  and all(m.startswith(f"{i}. ") for i, m in enumerate(msgs, 1)) and any("'nope'" in m for m in msgs), p.stdout + p.stderr)

p, out, pub, left = run_r7(R_NEW, "publish", dict(RREQ, blocks=[{"type": "text", "markdown": "REFUSE"}]), BUILT)
t("R7 平台拒絕(ValueError)→ refused 帶編號與原文、不 traceback、兩個檔留著",
  p.returncode == 0 and out and out[-1]["refused"][0].startswith("1. The platform refused") and left == (True, True)
  and "Traceback" not in p.stderr, p.stdout + p.stderr)

p, out, pub, left = run_r7(R_NEW, "publish", RREQ, None)
t("R7 分析檔不在 → refused、不呼叫", p.returncode == 0 and out and "refused" in out[-1] and pub is None, p.stdout + p.stderr)

p, out, pub, left = run_r7(R_NEW, "discard", RREQ, BUILT)
t("R7 discard → 兩個檔都刪、不呼叫", p.returncode == 0 and out == [{"discarded": True}] and pub is None and left == (False, False),
  p.stdout + p.stderr)

p, out, pub, left = run_r7(R_NEW, "publish", dict(RREQ, shareable="yes", type=None), BUILT)
t("R7 shareable 不是 bool 不帶;type 沒給預設 research",
  p.returncode == 0 and pub and pub["meta"] == {"origin": "chat"} and pub["type"] == "research", p.stdout + p.stderr)

p, out, pub, left = run_r7(R_NEW, "build", RREQ, BUILT)
t("R7 mode 打錯 → {error: mode}、不刪檔、不呼叫", p.returncode == 0 and out == [{"error": "mode"}] and pub is None
  and left == (True, True), p.stdout + p.stderr)
for rp in (None, "desktop-x", REPLY + " status"):
    p, out, pub, left = run_r7(R_NEW, "publish", RREQ, BUILT, reply=rp)
    t(f"R7 沒帶／帶錯這一則的 id({rp!r})→ {{error: mode}}、不刪檔、不呼叫",
      p.returncode == 0 and out == [{"error": "mode"}] and pub is None and left == (True, True), p.stdout + p.stderr)
p, out, pub, left = run_r7(R_NEW, "discard", RREQ, BUILT, reply=None)
t("R7 discard 不用帶這一則的 id", out == [{"discarded": True}] and left == (False, False), p.stdout + p.stderr)

# ── 引用圖:電腦版擷取 → 暫存目錄 → images= 交給 write_report ──
PIC = {"type": "image", "file": "cite-a.png", "alt": "PCR 走勢", "source": {"name": "TAIFEX", "url": "https://www.taifex.com.tw/x"}}
IREQ = dict(RREQ, blocks=RREQ["blocks"][:3] + [PIC] + RREQ["blocks"][5:])
p, out, pub, left = run_r7(R_NEW, "publish", IREQ, BUILT, pics={"cite-a.png": b"\x89PNG-a"})
t("R7 帶 source 而且檔在暫存目錄的圖 → block 留著、bytes 用 images= 交出去、不列 dropped",
  p.returncode == 0 and pub and pub["images"] == {"cite-a.png": "\x89PNG-a"} and PIC in pub["blocks"]
  and out[-1]["dropped"] == [], p.stdout + p.stderr)
for name, req, pics in (("檔不在暫存目錄", IREQ, None),
                        ("檔名是路徑", dict(IREQ, blocks=[dict(PIC, file="../cloud-report-" + TURN + ".json")] + IREQ["blocks"][:3]),
                         {"cite-a.png": b"x"}),   # 目錄要在,../ 才解得到請求檔
                        ("沒有 source(自己畫的圖)", dict(IREQ, blocks=[{k: v for k, v in PIC.items() if k != "source"}] + IREQ["blocks"][:3]),
                         {"cite-a.png": b"x"})):
    p, out, pub, left = run_r7(R_NEW, "publish", req, BUILT, pics=pics)
    t(f"R7 {name} → 那個 image 丟掉列進 dropped,報告照寫、不帶 images",
      p.returncode == 0 and pub and pub["images"] is None and "image" not in [b["type"] for b in pub["blocks"]]
      and any(d.endswith(".image") for d in out[-1]["dropped"]), p.stdout + p.stderr)
p, out, pub, left = run_r7(R_NEW, "publish", dict(IREQ, blocks=RREQ["blocks"][:2] + [{"analysis": "pic"}]),
                          dict(BUILT, pic=PIC), pics={"cite-a.png": b"x"})
t("R7 分析檔寫出來的 image(帶 source、檔也在)→ 不收、列進 dropped(圖只能是這台電腦擷取、請求檔點名的)",
  p.returncode == 0 and pub and pub["images"] is None and "image" not in [b["type"] for b in pub["blocks"]]
  and out[-1]["dropped"] == ["blocks[2].image"], p.stdout + p.stderr)
lws = tempfile.mkdtemp(dir=SCRATCH)
open(os.path.join(lws, "secret.png"), "wb").write(b"s")
p, out, pub, left = run_r7(R_NEW, "publish", IREQ, BUILT, pics={"cite-a.png": os.path.join(lws, "secret.png")})
t("R7 暫存圖目錄裡的 symlink → 不讀、那個 image 丟掉",
  p.returncode == 0 and pub and pub["images"] is None and out[-1]["dropped"] == ["blocks[3].image"], p.stdout + p.stderr)
p, out, pub, left = run_r7(R_NEW, "discard", IREQ, BUILT, reply=None, pics={"cite-a.png": b"x"})
t("R7 discard 連暫存圖目錄一起刪", out == [{"discarded": True}] and not any(
    os.path.isdir(os.path.join(SCRATCH, w, "tmp", "cloud-report-" + TURN + "-files")) for w in os.listdir(SCRATCH)
    if w.startswith("cloud-research-")), p.stdout + p.stderr)

# ── R7 用真的 lib/report.py:WARNING、NaN 拒絕帶編號與 key、上傳被拒後同 id 重送、replace 同 id 覆寫 ──
# 不帶 BLAVE_PROXY_TOKEN(= 經 SSH 跑的雲端機),平台的判決只在上傳時才有;uploader 由下面的 thread 代演,
# 搬檔與 upload_errors.log 一行的形狀照 runtime/report_uploader.py(_retire、log_error)。
import threading, time
REAL = tempfile.mkdtemp(prefix="cloud-research-real-", dir=SCRATCH)
FAST = RSCRIPT.replace("time.sleep(2)", "time.sleep(0.02)")
assert FAST != RSCRIPT
ENV = {k: v for k, v in os.environ.items() if not k.startswith("BLAVE_")}
ENV["PYTHONPATH"] = ROOT


SHIPPED = {}   # 上傳替身搬走報告那一刻,它的 sidecar 裡有哪些圖


def ship(rd, verdict, clear_delay=0.05):
    for n in (os.listdir(rd) if os.path.isdir(rd) else []):
        if not n.endswith(".json") or verdict is None:
            continue
        side = os.path.join(rd, n[:-5] + ".files")
        SHIPPED[n[:-5]] = sorted(os.listdir(side)) if os.path.isdir(side) else []
        sub = os.path.join(rd, verdict)
        os.makedirs(sub, exist_ok=True)
        if verdict == "failed":
            with open(os.path.join(rd, "upload_errors.log"), "a", encoding="utf-8") as f:
                f.write(f"2026-11-06T00:00:00Z {n[:-5]}: HTTP 400 blocks[5].items[0].url: not a link\n")
        os.replace(os.path.join(rd, n), os.path.join(sub, n))
        if verdict == "sent" and os.path.exists(os.path.join(rd, "failed", n)):
            time.sleep(clear_delay)   # 照 upload_one 的順序:先進 sent/(還有 _prune_sent),才清 failed/
            os.remove(os.path.join(rd, "failed", n))


def fake_uploader(rd, verdict, stop, clear_delay):
    time.sleep(0.1)   # 比 write_report 回來慢:腳本不等的話第一次 status() 一定還是 pending
    while not stop.is_set():
        ship(rd, verdict, clear_delay)
        time.sleep(0.01)


def put_files(ws, req, built):
    os.makedirs(os.path.join(ws, "tmp"), exist_ok=True)
    reqp = os.path.join(ws, "tmp", "cloud-report-" + TURN + ".json")
    datap = os.path.join(ws, "tmp", "cloud-report-" + TURN + "-blocks.json")
    if req is not None:
        json.dump(req, open(reqp, "w"), ensure_ascii=False)
    if built is not None:
        json.dump(built, open(datap, "w"))   # allow_nan 預設 True:模擬沒照 R7.2 寫的分析腳本
    return reqp, datap


def run_real(ws, mode, req, built, verdict, clear_delay=0.05, reply=REPLY, pics=None):
    reqp, datap = put_files(ws, req, built)
    put_pics(ws, pics)
    stop = threading.Event()
    th = threading.Thread(target=fake_uploader, args=(os.path.join(ws, "reports"), verdict, stop, clear_delay), daemon=True)
    th.start()
    p = subprocess.run([sys.executable, "-", mode, reply], input=FAST, text=True, capture_output=True, cwd=ws,
                       env=dict(ENV, BLAVE_AGENT_WORKSPACE=ws), timeout=60)
    stop.set(); th.join()
    lines = [json.loads(x) for x in p.stdout.splitlines() if x.startswith("{")]
    return p, lines, (os.path.exists(reqp), os.path.exists(datap))


def listing(ws, sub=""):
    d = os.path.join(ws, "reports", sub)
    return sorted(n for n in os.listdir(d) if n.endswith(".json")) if os.path.isdir(d) else []


def sent_lead(ws, n):
    return json.load(open(os.path.join(ws, "reports", "sent", n), encoding="utf-8"))["blocks"][1]["markdown"]


RB = {"kpi": {"type": "kpi_row", "items": [{"label": "樣本", "value": "12 段"}]},
      "chart": {"type": "table", "columns": ["a"], "rows": [["1"]]}}
WEAK = {"report_id": "pcr-real", "title": "PCR 高檔後台指期偏弱", "type": "research", "shareable": False,
        "blocks": [{"type": "text", "variant": "lead", "markdown": "高檔之後偏弱。"}, {"analysis": "kpi"},
                   {"analysis": "chart"}]}
GOOD = dict(WEAK, blocks=[dict(WEAK["blocks"][0], markdown="高檔後 12 段裡 9 段一週收黑。")] + WEAK["blocks"][1:])

ws = tempfile.mkdtemp(dir=REAL)
p, out, left = run_real(ws, "publish", WEAK, RB, "sent")
t("真 lib:WARNING 印出來、上傳完才回 published(upload: sent)、兩個檔刪掉",
  p.returncode == 0 and "WARNING: research lead's first sentence has no number" in p.stdout
  and out and out[-1].get("published") == "pcr-real.json" and out[-1].get("upload") == "sent"
  and listing(ws, "sent") == ["pcr-real.json"] and left == (False, False), p.stdout + p.stderr)
p, out, left = run_real(ws, "replace", GOOD, RB, "sent")
t("真 lib:修 WARNING 走 replace → 同一個 id 覆寫(sent/ 裡只有 pcr-real,內文換新),WARNING 沒了",
  p.returncode == 0 and out and out[-1].get("published") == "pcr-real.json" and "WARNING: research lead" not in p.stdout
  and listing(ws, "sent") == ["pcr-real.json"] and sent_lead(ws, "pcr-real.json").startswith("高檔後 12 段"),
  p.stdout + p.stderr)
p, out, left = run_real(ws, "replace", dict(GOOD, title="PCR 高檔後台指期偏弱(改)"), RB, "failed")
msgs = (out[-1].get("refused") or []) if out else []
t("真 lib:replace 上傳被拒 → refused(第一版還在 sent/、內文沒變),不被 sent/ 那份蓋成成功",
  p.returncode == 0 and len(msgs) == 1 and msgs[0].startswith("1. the platform refused pcr-real at upload:")
  and listing(ws, "sent") == ["pcr-real.json"] and sent_lead(ws, "pcr-real.json").startswith("高檔後 12 段")
  and left == (True, True), p.stdout + p.stderr)
p, out, left = run_real(ws, "publish", GOOD, RB, "sent")
t("真 lib:同一個 id 再 publish 一次就是第二份(pcr-real-2),R7.5 因此叫 agent 修 WARNING 不准用 publish",
  p.returncode == 0 and out and out[-1].get("published") == "pcr-real-2.json", p.stdout + p.stderr)

ws = tempfile.mkdtemp(dir=REAL)
p, out, left = run_real(ws, "publish", GOOD, RB, "failed")
msgs = (out[-1].get("refused") or []) if out else []
t("真 lib:上傳時被平台拒絕 → refused(編號、帶 upload_errors.log 的原因),兩個檔留著",
  p.returncode == 0 and len(msgs) == 1 and msgs[0].startswith("1. the platform refused pcr-real at upload:")
  and "HTTP 400" in msgs[0] and left == (True, True) and listing(ws, "failed") == ["pcr-real.json"], p.stdout + p.stderr)
p, out, left = run_real(ws, "publish", None, None, "sent", clear_delay=1.5)
t("真 lib:被拒後修好重送 → 同一個 id(不是 -2)、送出(uploader 隔 1.5 秒才清 failed/ 也不誤判成被拒)、failed/ 清掉、兩個檔刪掉",
  p.returncode == 0 and out and out[-1].get("published") == "pcr-real.json" and out[-1].get("upload") == "sent"
  and listing(ws, "failed") == [] and left == (False, False), p.stdout + p.stderr)

ws = tempfile.mkdtemp(dir=REAL)
p, out, left = run_real(ws, "publish", GOOD, RB, None)
t("真 lib:等到上限還沒上傳 → upload: pending、報告留在 reports/ 給 uploader、兩個檔刪掉",
  p.returncode == 0 and out and out[-1].get("upload") == "pending" and listing(ws) == ["pcr-real.json"]
  and left == (False, False), p.stdout + p.stderr)

ws = tempfile.mkdtemp(dir=REAL)
nan_req = dict(GOOD, blocks=GOOD["blocks"] + [{"type": "kpi_row", "items": [{"label": "x", "value": float("inf")}]}])
p, out, left = run_real(ws, "publish", nan_req, dict(RB, kpi={"type": "kpi_row", "items": [{"label": "n", "value": float("nan")}]}), "sent")
msgs = (out[-1].get("refused") or []) if out else []
t("真 lib:NaN／Infinity 被拒 → 每條有編號、分析來的點名 key、自己寫的說 this block、沒寫報告、兩個檔留著",
  p.returncode == 0 and len(msgs) == 2 and all(m.startswith(f"{i}. ") for i, m in enumerate(msgs, 1))
  and "analysis entry 'kpi'" in msgs[0] and "blocks[3]: this block" in msgs[1] and listing(ws) == []
  and left == (True, True) and "Traceback" not in p.stderr, p.stdout + p.stderr)

# ── 引擎在等上傳時把 ssh 砍掉:報告已經寫了,兩個暫存檔還在。照 R7.5 走 status,不是再 publish ──
def killed_publish(ws, req, built):
    reqp, datap = put_files(ws, req, built)
    p = subprocess.Popen([sys.executable, "-", "publish", REPLY], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=subprocess.PIPE, text=True, cwd=ws, env=dict(ENV, BLAVE_AGENT_WORKSPACE=ws))
    p.stdin.write(RSCRIPT)   # 真的 2 秒間隔:被砍的時候一定還在等
    p.stdin.close()
    target, end = os.path.join(ws, "reports", req["report_id"] + ".json"), time.time() + 30
    while not os.path.exists(target) and time.time() < end and p.poll() is None:
        time.sleep(0.02)
    p.kill()
    p.communicate()
    return os.path.exists(target), (os.path.exists(reqp), os.path.exists(datap))


ws = tempfile.mkdtemp(dir=REAL)
p, out, left = run_real(ws, "status", GOOD, RB, None)
t("真 lib:status 而這個對話還沒寫過 → {status: none}、兩個檔留著(可以照原 mode 再跑一次)",
  p.returncode == 0 and out == [{"status": "none"}] and left == (True, True), p.stdout + p.stderr)
written, left = killed_publish(ws, GOOD, RB)
t("真 lib:publish 在等上傳時被砍 → 報告已在 reports/、兩個暫存檔還在(這就是不准再 publish 的原因)",
  written and left == (True, True), str((written, left)))
ship(os.path.join(ws, "reports"), "sent")
p, out, left = run_real(ws, "status", None, None, None)
t("真 lib:被砍後走 status → 回 published(sent)、兩個檔刪掉、sent/ 只有一份、沒有 -2",
  p.returncode == 0 and out == [{"published": "pcr-real.json", "upload": "sent"}] and left == (False, False)
  and listing(ws, "sent") == ["pcr-real.json"] and listing(ws) == [], p.stdout + p.stderr)
p, out, left = run_real(ws, "status", None, None, None)
t("真 lib:status 再跑一次也一樣(檔已刪、從 ledger 找這個對話最後一份)",
  p.returncode == 0 and out == [{"published": "pcr-real.json", "upload": "sent"}], p.stdout + p.stderr)

ws = tempfile.mkdtemp(dir=REAL)
written, left = killed_publish(ws, GOOD, RB)
ship(os.path.join(ws, "reports"), "failed")
p, out, left = run_real(ws, "status", None, None, None)
msgs = (out[-1].get("refused") or []) if out else []
t("真 lib:被砍、上傳又被拒 → status 回 refused(帶原因)、兩個檔留著",
  written and len(msgs) == 1 and "HTTP 400" in msgs[0] and left == (True, True), p.stdout + p.stderr)
p, out, left = run_real(ws, "publish", None, None, "sent")
t("真 lib:照 refused 修好再 publish → 同一個 id(不是 -2)",
  p.returncode == 0 and out and out[-1].get("published") == "pcr-real.json" and listing(ws, "sent") == ["pcr-real.json"],
  p.stdout + p.stderr)

ws = tempfile.mkdtemp(dir=REAL)
p, out, left = run_real(ws, "publish", GOOD, RB, "sent")
first = sent_lead(ws, "pcr-real.json")
ledger = os.path.join(ws, "reports", ".written.jsonl")
aged = [dict(json.loads(ln), at=json.loads(ln)["at"] - 2101) for ln in open(ledger, encoding="utf-8")]
open(ledger, "w", encoding="utf-8").write("".join(json.dumps(d) + "\n" for d in aged))
later = dict(GOOD, blocks=[dict(GOOD["blocks"][0], markdown="後來的 turn 改寫 3 次。")] + GOOD["blocks"][1:])
p, out, left = run_real(ws, "replace", later, RB, "sent")
t("真 lib:ledger 那筆超過 35 分鐘 → replace 回 replace_expired、不寫、前一份內文沒變、兩個檔留著",
  p.returncode == 0 and out == [{"error": "replace_expired"}] and sent_lead(ws, "pcr-real.json") == first
  and listing(ws) == [] and listing(ws, "sent") == ["pcr-real.json"] and left == (True, True), p.stdout + p.stderr)
p, out, left = run_real(ws, "status", None, None, None)
t("真 lib:超過 35 分鐘的那筆 status 也不認(不是這一則回覆的)", out == [{"status": "none"}], p.stdout + p.stderr)

# ── 稽核 r3 P3-A:key 是這一則回覆的;同一條對話的下一則重用同一個 id,status／replace 都不認前一則那份 ──
ws = tempfile.mkdtemp(dir=REAL)
p, out, left = run_real(ws, "publish", GOOD, RB, "sent")
put_files(ws, GOOD, RB)
p, out, left = run_real(ws, "status", None, None, None, reply=REPLY_B)
t("真 lib:前一則發了 pcr-real,這一則同 id 還沒寫就跑 status → none、兩個檔留著(不認成前一則那份)",
  p.returncode == 0 and out == [{"status": "none"}] and left == (True, True), p.stdout + p.stderr)
p, out, left = run_real(ws, "replace", GOOD, RB, "sent", reply=REPLY_B)
t("真 lib:這一則 replace 前一則那份(35 分鐘內)→ replace_expired、不寫",
  out == [{"error": "replace_expired"}] and listing(ws, "sent") == ["pcr-real.json"] and left == (True, True), p.stdout + p.stderr)

# ── 引用圖,真 lib:圖進 final id 的 sidecar、上傳替身看得到;3 張 → refused;id 被佔走 → 進 -2 的 sidecar ──
def pic(n):
    return dict(PIC, file=n, alt="圖 " + n)


IMG = dict(GOOD, report_id="pcr-img", blocks=GOOD["blocks"] + [pic("cite-a.png"), pic("cite-b.jpg")])
ws = tempfile.mkdtemp(dir=REAL)
SHIPPED.clear()
p, out, left = run_real(ws, "publish", IMG, RB, "sent", pics={"cite-a.png": b"\x89PNG-a", "cite-b.jpg": b"\xff\xd8-b"})
side = os.path.join(ws, "reports", "pcr-img.files")
t("真 lib:2 張圖 → published、sidecar 在 final id 底下、上傳時替身看得到兩張、暫存圖目錄刪掉",
  p.returncode == 0 and out and out[-1].get("published") == "pcr-img.json" and out[-1].get("dropped") == []
  and SHIPPED.get("pcr-img") == ["cite-a.png", "cite-b.jpg"] and open(os.path.join(side, "cite-a.png"), "rb").read() == b"\x89PNG-a"
  and not os.path.isdir(put_pics(ws, {})) and left == (False, False), p.stdout + p.stderr)
three = dict(IMG, report_id="pcr-img3", blocks=IMG["blocks"] + [pic("cite-c.png")])
p, out, left = run_real(ws, "publish", three, RB, "sent", pics={n: b"x" for n in ("cite-a.png", "cite-b.jpg", "cite-c.png")})
msgs = (out[-1].get("refused") or []) if out else []
t("真 lib:3 張引用圖 → refused 帶編號(lib 的上限)、沒寫報告、暫存圖留著給下一次",
  p.returncode == 0 and len(msgs) == 1 and msgs[0].startswith("1. 3 cited images") and "pcr-img3" not in SHIPPED
  and not os.path.exists(os.path.join(ws, "reports", "pcr-img3.json")) and os.path.isfile(os.path.join(put_pics(ws, {}), "cite-c.png"))
  and left == (True, True), p.stdout + p.stderr)
shutil.rmtree(put_pics(ws, {}))
later_img = dict(IMG, blocks=GOOD["blocks"] + [pic("cite-z.png")])
p, out, left = run_real(ws, "publish", later_img, RB, "sent", reply=REPLY_B, pics={"cite-z.png": b"z"})
t("真 lib:下一則同 id 已被佔走 → 寫成 pcr-img-2,圖進 -2 的 sidecar、前一份的 sidecar 不多不少",
  p.returncode == 0 and out and out[-1].get("published") == "pcr-img-2.json" and SHIPPED.get("pcr-img-2") == ["cite-z.png"]
  and sorted(os.listdir(side)) == ["cite-a.png", "cite-b.jpg"], p.stdout + p.stderr)

# ── R7.4 本機那支:把請求點名的擷取圖搬進這一輪的資料夾(之後 scp、step 8 連資料夾刪) ──
STAGER = re.search(r"\*\*Pictures travel before publishing\*\*.*?```py\n(.*?\n)```\n", r7, re.S).group(1)


def run_stage(ws, req, sidecars):
    os.makedirs(os.path.join(ws, "tmp", "cloud-handoff", TURN), exist_ok=True)
    json.dump(req, open(os.path.join(ws, "tmp", "cloud-handoff", TURN, "report.json"), "w"))
    for rel, b in sidecars.items():
        os.makedirs(os.path.dirname(os.path.join(ws, "reports", rel)), exist_ok=True)
        if isinstance(b, str):
            os.symlink(b, os.path.join(ws, "reports", rel))
        else:
            open(os.path.join(ws, "reports", rel), "wb").write(b)
    p = subprocess.run([sys.executable, "-", TURN], input=STAGER, text=True, capture_output=True, cwd=ws,
                       env=dict(ENV, BLAVE_AGENT_WORKSPACE=ws), timeout=60)
    lines = [json.loads(x) for x in p.stdout.splitlines() if x.startswith("{")]
    out = os.path.join(ws, "tmp", "cloud-handoff", TURN, "files")
    return p, lines, sorted(os.listdir(out)) if os.path.isdir(out) else []


ws = tempfile.mkdtemp(dir=REAL)
p, out, got = run_stage(ws, IMG, {"pcr-img.files/cite-a.png": b"a", "pcr-img.files/cite-b.jpg": b"b"})
t("本機:擷取圖搬進 tmp/cloud-handoff/<turn>/files、這台電腦的 reports/ 不留(連空資料夾)",
  p.returncode == 0 and out == [{"staged": ["cite-a.png", "cite-b.jpg"], "missing": []}] and got == ["cite-a.png", "cite-b.jpg"]
  and not os.path.exists(os.path.join(ws, "reports", "pcr-img.files")), p.stdout + p.stderr)
p, out, got = run_stage(ws, IMG, {})
t("本機:被拒後再跑一次 → 已搬過的算 staged", out == [{"staged": ["cite-a.png", "cite-b.jpg"], "missing": []}], p.stdout + p.stderr)
ws = tempfile.mkdtemp(dir=REAL)
p, out, got = run_stage(ws, IMG, {"pcr-img.json": b"{}", "pcr-img.files/cite-a.png": b"old", "pcr-img-2.files/cite-a.png": b"new",
                                  "pcr-img-2.files/cite-b.jpg": b"b"})
t("本機:這台電腦已有 pcr-img → 擷取在 pcr-img-2.files(citeSlot),從那裡搬;已有報告的 sidecar 不碰",
  out == [{"staged": ["cite-a.png", "cite-b.jpg"], "missing": []}]
  and open(os.path.join(ws, "tmp", "cloud-handoff", TURN, "files", "cite-a.png"), "rb").read() == b"new"
  and os.listdir(os.path.join(ws, "reports", "pcr-img.files")) == ["cite-a.png"], p.stdout + p.stderr)
ws = tempfile.mkdtemp(dir=REAL)
p, out, got = run_stage(ws, dict(IMG, blocks=[pic("../../.env"), pic("cite-a.png")]), {"pcr-img.files/cite-a.png": b"a"})
t("本機:檔名不合 → {bad}、一張都不搬不送",
  p.returncode == 0 and out and "bad" in out[0] and got == [] and os.path.isfile(os.path.join(ws, "reports", "pcr-img.files", "cite-a.png")),
  p.stdout + p.stderr)
ws = tempfile.mkdtemp(dir=REAL)
p, out, got = run_stage(ws, dict(IMG, blocks=[pic("perm.png"), pic("cite-q.png")]), {"pcr-img.files/perm.png": b"p"})
t("本機:不是 browser_capture 的檔(沒 cite- 前綴)、找不到的檔 → missing、不搬",
  out == [{"staged": [], "missing": ["perm.png", "cite-q.png"]}] and got == []
  and os.path.isfile(os.path.join(ws, "reports", "pcr-img.files", "perm.png")), p.stdout + p.stderr)

ws = tempfile.mkdtemp(dir=REAL)
p, out, got = run_stage(ws, dict(IMG, report_id="../x"), {"../x.files/cite-a.png": b"a"})
t("本機:report_id 不合字元集 → {bad}、不拿去組路徑、一張都不搬",
  p.returncode == 0 and out == [{"bad": ["report_id"]}] and got == [] and os.path.isfile(os.path.join(ws, "x.files", "cite-a.png")),
  p.stdout + p.stderr)
ws = tempfile.mkdtemp(dir=REAL)
open(os.path.join(ws, "secret"), "wb").write(b"s")
p, out, got = run_stage(ws, dict(IMG, blocks=[pic("cite-a.png")]), {"pcr-img.files/cite-a.png": os.path.join(ws, "secret")})
t("本機:sidecar 裡的擷取檔是 symlink → missing、不搬(scp 會照 symlink 送出別的檔)",
  out == [{"staged": [], "missing": ["cite-a.png"]}] and got == [], p.stdout + p.stderr)
ws = tempfile.mkdtemp(dir=REAL)
os.makedirs(os.path.join(ws, "tmp", "cloud-handoff", TURN, "files"))
open(os.path.join(ws, "tmp", "cloud-handoff", TURN, "files", "notes.png"), "wb").write(b"n")
p, out, got = run_stage(ws, dict(IMG, blocks=[pic("notes.png")]), {})
t("本機:重跑時 files/ 裡沒有 cite- 前綴的檔也不算 staged(不送上雲)",
  out == [{"staged": [], "missing": ["notes.png"]}], p.stdout + p.stderr)

# ── mine() 只認請求檔的 rid:同一則先發 A,再放 B 的請求跑 status → none、檔留著(r3 P3-B) ──
ws = tempfile.mkdtemp(dir=REAL)
p, out, left = run_real(ws, "publish", GOOD, RB, "sent")
p, out, left = run_real(ws, "status", dict(GOOD, report_id="pcr-other"), RB, None)
t("真 lib:同一則發了 pcr-real,再放 pcr-other 的請求就跑 status → none、兩個檔留著",
  p.returncode == 0 and out == [{"status": "none"}] and left == (True, True), p.stdout + p.stderr)

t("R7 固定腳本只叫 lib.report:不 import 下單／帳戶／執行、不開子行程",
  not re.search(r"lib\.(order|account|execute)|subprocess|os\.system|report_templates", RSCRIPT))
r7_text = r7[:r7.index("The research script")]
t("R7 文件:資料檢查在本機、分析在雲端寫 blocks 檔、分析腳本不叫 write_report／publish、圖先搬再 scp 到暫存目錄、不進雲端 reports/",
  "Data check here, first" in r7_text and "tmp/cloud-report-<turn>-blocks.json" in r7_text
  and "never calls `write_report` or `publish`" in r7_text and "does not travel" not in r7_text
  and "tmp/cloud-report-<turn>-files/" in r7_text and "Never copy a picture into the cloud machine's `reports/`" in r7_text)
t("R7.4／R7.5 中途停下前先 discard(雲端已經有請求檔與分析檔)",
  "`discard` in place of `<name>` (the request and the analysis file are already there), then stop" in r7_text
  and "run the script with `discard` in place of `<name>` (it needs no `<reply>`), then stop and report it" in r7_text)
rs = open(os.path.join(ROOT, "references", "reports.md"), encoding="utf-8").read()
cite = rs[rs.index("### Citing an image from the web"):]
t("reports.md 引用圖那節點名雲端視角走 cloud-handoff R7.4、是那兩條規則唯一的例外",
  "**A report asked from the cloud view**" in cite and "`references/cloud-handoff.md` R7.4" in cite
  and "the one\n  exception to the two rules above" in cite)
t("R7.5 先讀這一則的 BLAVE_TURN_ID、過 16 hex、當第二個參數;不合就停",
  "BLAVE_TURN_ID" in r7_text and "`^[0-9a-f]{16}$`" in r7_text and "`publish <reply>`" in r7_text
  and "`status <reply>`" in r7_text and "**`replace <reply>`**" in r7_text and "stop and report it" in r7_text)
r71, r72 = r7_text[r7_text.index("R7.1."):r7_text.index("R7.2.")], r7_text[r7_text.index("R7.2."):r7_text.index("R7.3.")]
r73, r75 = r7_text[r7_text.index("R7.3."):r7_text.index("R7.4.")], r7_text[r7_text.index("R7.5."):]
t("R7.1 不再說兩邊是同一份資料;本機探針只決定要不要連線,門檻以 R7.3 為準",
  "the same Blave data" not in r71 and "the verdict that counts is R7.3's" in r71)
t("R7.2/R7.3 分析腳本在雲端也印探針三個數,agent 用雲端的數字重套第 2/3 步,不過就 discard、對話回答",
  "the probe's three figures" in r72 and "**this run's** three probe figures" in r73 and "`discard`" in r73)
t("R7.2 分析腳本寫檔前先建 tmp/", 'os.makedirs("tmp", exist_ok=True)' in r72)
t("R7.5 publish 會等上傳,要給長 timeout;被拒(含上傳時)走 R5、同 id;最多兩次",
  "180000ms" in r75 and "at upload" in r75 and "keeps the same id" in r75 and "at most two runs" in r75)
t("R7.5 WARNING 是建議;要修走 replace,不准再 publish(會變 -2)",
  "**`replace <reply>`**" in r75 and "a second `publish` is a second report" in r75
  and "never call `write_report` yourself" in r75 and "never that the report failed" in r75)
t("Reports 那節開頭點名研究報告走 R7", "takes R7 instead of R2–R5" in sec[:sec.index("R1.")])
t("R7.5 沒拿到 JSON 那一行 → 不准再 publish／replace,先跑 status;none 才照原 mode 再跑",
  "**No JSON line**" in r75 and "Never run `publish` or `replace` again for it" in r75
  and "`status <reply>` in place of `<name>`" in r75 and '`{"status": "none"}` → nothing was written' in r75)
t("R7.5 兩個引擎各自怎麼給等待的空間:Bash 給 180000ms;Codex exec_command 設 yield 30000、拿到 session id 用 write_stdin 輪詢、不重跑",
  "A tool named `Bash`" in r75 and "Codex's `exec_command`" in r75 and "`yield_time_ms` to 30000" in r75
  and "`write_stdin`" in r75 and "Never start the command again while that session runs" in r75
  and "exit code 124" in r75)
t("R7.5 結果清單列了 mode 打錯、replace_expired;status／mode／none 不算兩次",
  '`{"error": "mode"}` → the mode or `<reply>` was mistyped' in r75 and '`{"error": "replace_expired"}` → nothing was written' in r75
  and '`status` runs, and runs answered by `{"error": "mode"}` or `{"status": "none"}`, do not count' in r75)
t("R7.5 圖沒帶到自己一句、不准提議更新雲端主機(lib 太舊才走 R6 問更新);sent／pending 一律用 R6 那句(幾分鐘內出現)",
  "這份少了擷取的圖：沒能從這台電腦帶到雲端主機。" in r75 and "這份沒有附圖" not in r75 and '`missing` = `["images"]`' not in r75 and "Never offer to update the cloud machine for it" in r75
  and "R6's one sentence" not in r75 and "Reports list now" not in r75 and "Either `upload` value gets R6's sentence" in r75)

print("\nall green" if not red else f"\n{red} red")
sys.exit(1 if red else 0)
