"""references/cloud-handoff.md › Reports asked from the cloud view:那支遠端腳本(從原文切出來跑)。

雲端主機的 lib/ 可能比這台電腦舊(沒有 load_pack、publish 不收 shareable / lang、沒有 news 槽)。
腳本要偵測能力後降級:舊機少的選項與槽列進 `dropped`,不准讓 TypeError / unknown slot 丟到用戶面前;
新機要重用 R3 那一包(load_pack),把 shareable 帶進 publish。兩種 lib 用最小替身模擬(形狀照
9aa8a7b = 2026-09-24-b 與現行 lib/report_templates.py 的簽名),不打網路。

跑法:python3 tests/check_cloud_report_script.py
"""
import json, os, re, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
doc = open(os.path.join(ROOT, "references", "cloud-handoff.md"), encoding="utf-8").read()
sec = doc[doc.index("## Reports asked from the cloud view"):doc.index("## Updating the cloud machine")]
SCRIPT = re.search(r"```py\n(.*?\n)```\n", sec, re.S).group(1)

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


def t(name, ok, detail=""):
    global red
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok else f"  ← {detail}"))
    red += 0 if ok else 1


def run(lib_src, mode, req):
    ws = tempfile.mkdtemp(prefix="cloud-report-")
    os.makedirs(os.path.join(ws, "lib")); os.makedirs(os.path.join(ws, "tmp"))
    open(os.path.join(ws, "lib", "__init__.py"), "w").close()
    open(os.path.join(ws, "lib", "report_templates.py"), "w").write(lib_src)
    json.dump(req, open(os.path.join(ws, "tmp", "cloud-report.json"), "w"))
    p = subprocess.run([sys.executable, "-", mode], input=SCRIPT, text=True, capture_output=True, cwd=ws)
    lines = [json.loads(x) for x in p.stdout.splitlines() if x.startswith("{")]
    pub = os.path.join(ws, "published.json")
    return p, lines, (json.load(open(pub)) if os.path.exists(pub) else None), os.path.exists(os.path.join(ws, "tmp", "cloud-report.json"))


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

print("\nall green" if not red else f"\n{red} red")
sys.exit(1 if red else 0)
