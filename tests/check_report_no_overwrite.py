"""報告一律存成新的,不覆寫既有報告(Wei 2026-09-28;e2e 0.1.8 #97 #115 #124)。No network.

實測:同一天同範本再產一次(crypto-market-20260928)、沒帶日期的 id 隔天再做(research-btc)都把前一份整份蓋掉。鎖:
  ① id 已有報告 → 寫到下一個空 id(-2、-3…),回傳的路徑是實際寫的那一份;舊報告與它的 <id>.files/ 逐 byte 不變;
  ② reports/sent/ 裡的、帳本(.written.jsonl)記過的 id 都算已有(雲端 sent/ 只留 20 份);failed/ 的不算(重寫就是修它);
  ③ replace=True 只換得掉「這一輪自己寫的」:同一輪 → 覆寫那一份(用當時要的 id 或實際 id 都找得到);
     別輪寫的、沒有回合 id(排程 run.py)→ 照樣寫成新的;
  ④ -auto 的序號排在字尾前(runtime 靠 id 以 -auto 結尾認資料版);超過 64 字從主幹截;
  ⑤ 引用圖:id 已有報告時外殼把圖放進下一個空 id 的資料夾,寫報告時找得到、舊報告的資料夾沒有混進新圖;
     同一輪 replace 時,後來補拍的圖搬進自己那一份;沒用到的擷取檔照清;
  ⑥ 手放進 <要的 id>.files/ 的圖(不是擷取檔)跟著複製到新 id 的資料夾;
  ⑦ publish()(範本)同一套:同 pack 再發一次是新的一份,replace=True 才換掉這一輪的;
  ⑧ 外殼 capture.js 的 citeSlot 跟 lib 的 _free_id 逐例相同(有 node 才跑)。

Run: cd blave-agent && .venv/bin/python tests/check_report_no_overwrite.py
"""
import contextlib, io, json, os, shutil, subprocess, sys, tempfile
TMP = tempfile.mkdtemp(prefix="noover-")
os.environ["BLAVE_AGENT_WORKSPACE"] = os.path.join(TMP, "workspace")
os.environ["BLAVE_AGENT_STATE"] = os.path.join(TMP, "state")
os.environ["BLAVE_AGENT_LOCAL"] = "1"
for k in ("BLAVE_DATA_ACCESS", "BLAVE_DATA_ACCESS_WHY", "BLAVE_REPORT_PACKS", "BLAVE_SCHEDULED_RUN", "BLAVE_TURN_ID",
          "BLAVE_SCHEDULED_JOB"):
    os.environ.pop(k, None)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import pandas as pd
import lib.report as R
import lib.report_templates as T

T._now_tpe = lambda: pd.Timestamp("2026-09-28 04:05", tz="Asia/Taipei").to_pydatetime()
fails = 0


def check(cond, msg, got=None):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg + ("" if cond or got is None else f"  → {got!r}"))
    fails += (not cond)


def turn(tid):
    os.environ.pop("BLAVE_TURN_ID", None)
    if tid:
        os.environ["BLAVE_TURN_ID"] = tid


def write(rid, lead, **kw):
    with contextlib.redirect_stdout(io.StringIO()) as out:
        path = R.write_report(rid, "標題 " + lead, [{"type": "text", "variant": "lead", "markdown": lead}] + kw.pop("blocks", []),
                              type="morning", **kw)
    return os.path.basename(path)[:-5], out.getvalue()


def raw(rid):
    with open(os.path.join(R.REPORTS_DIR, rid + ".json"), "rb") as f:
        return f.read()


def lead(rid):
    return json.loads(raw(rid))["blocks"][1]["markdown"]


def files(rid):
    try:
        return sorted(os.listdir(os.path.join(R.REPORTS_DIR, rid + R.FILES_SUFFIX)))
    except OSError:
        return None


def put(rid, name, data=b"\x89PNG\r\n\x1a\n"):
    d = os.path.join(R.REPORTS_DIR, rid + R.FILES_SUFFIX)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, name), "wb") as f:
        f.write(data)


def cite(name):
    return {"type": "image", "file": name, "alt": "圖", "source": {"name": "Site", "url": "https://example.com/a"}}


# ── ① 不覆寫 ──
turn("t1")
a, _ = write("research-btc", "第一份", images={"fig.png": b"one"})
before = raw(a)
turn("t2")
b, out = write("research-btc", "第二份", images={"fig.png": b"two"})
c, _ = write("research-btc", "第三份")
check((a, b, c) == ("research-btc", "research-btc-2", "research-btc-3"), "① id 已有報告 → -2、-3;回傳路徑是實際寫的那一份", (a, b, c))
check(raw(a) == before and lead(b) == "第二份" and json.loads(raw(b))["id"] == b, "① 舊報告逐 byte 不變;新報告的信封 id = 新 id")
check(open(os.path.join(R.REPORTS_DIR, a + ".files", "fig.png"), "rb").read() == b"one"
      and open(os.path.join(R.REPORTS_DIR, b + ".files", "fig.png"), "rb").read() == b"two", "① images= 的圖寫進新 id 的資料夾,舊資料夾的同名圖不變")
check("NEW report" in out and "research-btc-2" in out and "replace=True" in out and out.isascii(), "① 輸出講明寫成新的一份、怎麼改自己這份(ASCII)", out)

# ── ② sent/、帳本、failed/ ──
os.makedirs(R.SENT_DIR, exist_ok=True)
os.makedirs(R.FAILED_DIR, exist_ok=True)
os.replace(os.path.join(R.REPORTS_DIR, "research-btc-3.json"), os.path.join(R.SENT_DIR, "research-btc-3.json"))
d, _ = write("research-btc", "第四份")
check(d == "research-btc-4", "② sent/ 裡的 id 算已有", d)
e, _ = write("old-sent", "已上傳")
os.remove(os.path.join(R.REPORTS_DIR, "old-sent.json"))   # 雲端:上傳後搬進 sent/、之後被修剪掉
f, _ = write("old-sent", "隔天再做")
check(f == "old-sent-2", "② 檔案不在了但帳本記過 → 仍算已有(雲端 sent/ 只留 20 份)", f)
with open(os.path.join(R.FAILED_DIR, "refused.json"), "w") as fh:
    fh.write("{}")
g, _ = write("refused", "修好重寫")
check(g == "refused", "② failed/ 的不算已有:同 id 重寫就是修它", g)

# ── ③ replace 只換這一輪自己寫的 ──
turn("t3")
h, _ = write("research-btc", "這一輪的第一版")
h2, _ = write("research-btc", "這一輪的修正版", replace=True)
check(h == h2 == "research-btc-5" and lead(h) == "這一輪的修正版" and raw(a) == before, "③ 同一輪 replace=True(用當時要的 id)→ 覆寫自己那一份,更早的不動", (h, h2))
h3, _ = write(h, "再修一次", replace=True)
check(h3 == h and lead(h) == "再修一次", "③ 用實際 id 也找得到自己那一份", h3)
turn("t4")
i, _ = write("research-btc", "別輪想蓋", replace=True)
check(i == "research-btc-6" and lead(h) == "再修一次", "③ 別輪寫的 replace 不掉:寫成新的", i)
turn(None)
j, out = write("research-btc", "排程", replace=True)
check(j == "research-btc-7" and "replace=True" not in out, "③ 沒有回合 id(排程 run.py)→ 一律新的,也不印 replace 提示", (j, out))

# ── ④ -auto 與長度 ──
k1, _ = write("tw-market-20260928-auto", "早")
k2, _ = write("tw-market-20260928-auto", "晚")
k3, _ = write("tw-market-20260928-auto", "夜")
check((k1, k2, k3) == ("tw-market-20260928-auto", "tw-market-20260928-2-auto", "tw-market-20260928-3-auto")
      and all(x.endswith("-auto") for x in (k1, k2, k3)) and lead(k1) == "早", "④ 資料版每次都是新的一份,id 仍以 -auto 結尾", (k1, k2, k3))
long = "x" * 64
l1, _ = write(long, "長")
l2, _ = write(long, "長二")
check(l1 == long and l2 == "x" * 62 + "-2" and R._ID_RE.fullmatch(l2) is not None, "④ 64 字的 id:序號從主幹截出位置", l2)

# ── ⑤ 引用圖 ──
turn("t5")
put("research-btc", "cite-old.png")            # 舊報告自己的引用圖
snap = files("research-btc")
slot = R._free_id("research-btc")              # 外殼 citeSlot 會選的資料夾
put(slot, "cite-new.png")
put(slot, "cite-unused.png")
check(R.captured_files("research-btc") == ["cite-new.png", "cite-unused.png"], "⑤ 寫報告前:找得到等著的擷取檔,看不到舊報告的", R.captured_files("research-btc"))
m, _ = write("research-btc", "含引用圖", blocks=[cite("cite-new.png")])
check(m == slot and files(m) == ["cite-new.png"] and files("research-btc") == snap, "⑤ 圖跟到新 id 的資料夾、沒用到的清掉;舊報告的資料夾原封不動", (m, files(m), files("research-btc")))
put(R._free_id(m), "cite-more.png")            # 同一輪補拍(那時 m 已經有報告 → 外殼放進再下一個)
waiting = R._free_id(m)
check(R.captured_files("research-btc", replace=True) == ["cite-more.png", "cite-new.png"], "⑤ replace:自己那一份的圖與補拍的都找得到", R.captured_files("research-btc", True))
m2, _ = write("research-btc", "補一張", blocks=[cite("cite-new.png"), cite("cite-more.png")], replace=True)
check(m2 == m and files(m) == ["cite-more.png", "cite-new.png"] and files(waiting) is None and files("research-btc") == snap,
      "⑤ replace:補拍的圖搬進自己那一份、暫放的資料夾收掉", (m2, files(m), files(waiting)))

put("old-sent", "cite-late.png")               # 檔案規則選的資料夾(old-sent 的檔不在了)跟帳本選的 id 不同:圖照樣跟得到
o, _ = write("old-sent", "帳本與檔案不同步", blocks=[cite("cite-late.png")])
check(o == "old-sent-3" and files(o) == ["cite-late.png"] and files("old-sent") is None, "⑤ 帳本說已用、檔案不在:圖從外殼放的地方搬到實際 id", (o, files(o), files("old-sent")))

# ── ⑥ 手放的圖 ──
turn("t6")
put("research-btc", "hand.png", b"hand")
n, _ = write("research-btc", "手放的圖", blocks=[{"type": "image", "file": "hand.png", "alt": "圖"}])
check(files(n) == ["hand.png"] and "hand.png" in files("research-btc"), "⑥ 手放進 <要的 id>.files/ 的圖複製到新 id(原處留著)", (n, files(n)))
check(not any(".." in x or os.sep in x for x in os.listdir(R.REPORTS_DIR)) and
      write("safe", "壞檔名", blocks=[{"type": "image", "file": "../../x.png", "alt": "圖"}])[0] == "safe", "⑥ 壞檔名(路徑)不拿去組路徑")

# ── ⑦ publish() ──
turn("t7")


def pack(rid="research-sol-20260928"):
    blocks = [T.kpi_row([T.kpi("SOL", "122.94")]), T.footnote([("src", "口徑")])]
    pk = T.Pack(rid, "SOL 研究", "research", "研究報告", blocks, {}, owners=["kpi_row", "footnote"])
    pk.report_day, pk.subject = "2026-09-28", "SOL"
    return pk


NAR = {"lead": "SOL 本週站穩高檔。", "read": ["**甲**:第一點", "**乙**:第二點", "**丙**:第三點"], "against": "- 沒有找到反例,查了成交量",
       "robustness": "- 換窗口後結論相同", "summary": "動能仍在,接下來看成交量。", "risk": "若成交量連三日萎縮,這個判斷就不成立。", "news": []}


def pub(**kw):
    with contextlib.redirect_stdout(io.StringIO()):
        return os.path.basename(T.publish(pack(), dict(NAR), title="SOL 站穩高檔", shareable=False, **kw))[:-5]


p1, p2 = pub(), pub()
p3 = pub(replace=True)
check((p1, p2, p3) == ("research-sol-20260928", "research-sol-20260928-2", "research-sol-20260928-2"), "⑦ publish:再發一次是新的一份;replace=True 換掉這一輪最後那份", (p1, p2, p3))
with contextlib.redirect_stdout(io.StringIO()):
    q1 = os.path.basename(T.publish(pack("my-daily-20260928")))[:-5]
    q2 = os.path.basename(T.publish(pack("my-daily-20260928")))[:-5]
check((q1, q2) == ("my-daily-20260928-auto", "my-daily-20260928-2-auto"), "⑦ publish(pack)(排程的資料版):每跑一次一份", (q1, q2))

# ── ⑧ 外殼同一條規則 ──
node = shutil.which("node")
if node:
    cases = ["research-btc", "tw-market-20260928-auto", long, "fresh-id", "old-sent", h]
    js = ("const c = require(process.argv[1]); console.log(JSON.stringify(JSON.parse(process.argv[3]).map((x) => c.citeSlot(process.argv[2], x))))")
    got = json.loads(subprocess.run([node, "-e", js, os.path.join(ROOT, "shell", "browser", "capture.js"), R.REPORTS_DIR, json.dumps(cases)],
                                    capture_output=True, text=True, check=True).stdout)
    check(got == [R._free_id(x) for x in cases], "⑧ capture.js citeSlot 與 lib _free_id 逐例相同", (got, [R._free_id(x) for x in cases]))
else:
    print("  SKIP  ⑧ 沒有 node")

# ── 文件 ──
doc = open(os.path.join(ROOT, "references", "reports.md"), encoding="utf-8").read()
check("overwrites" not in doc.split("## 2.")[0] and "replace=True" in doc and "A report is never overwritten" in doc,
      "references/reports.md §1 寫的是新行為(沒有「同 id 就是覆寫」)")

shutil.rmtree(TMP, ignore_errors=True)
print("\nALL PASS" if not fails else f"\n{fails} FAILED")
sys.exit(1 if fails else 0)
