"""用戶指名修改既有報告 → 改在原檔,走 lib.report.edit_report(Wei 2026-09-28;e2e 0.1.8 第七批 #1)。No network.

實測:用戶說「把剛剛這份報告的標題改成…,其他不動」,agent 直接用 Python 改 reports/<id>.json。鎖:
  ① 指名修改 → 同 id、報告檔數不變、created_at 不變(清單順序不跳)、沒被點到的 block 逐字不變;檔案的 mtime 會動
     (電腦版結果卡的「之後有更新」比的就是它);帳本記一筆;
  ② 沒指名的新報告(write_report 同一個 id)→ 新 id,原報告不動;
  ③ 走的是同一套寫入:引用圖上限照擋(擋下時原檔不變)、schema 版本重算、沒用到的擷取檔照清;
  ④ 雲端:已上傳的報告在 sent/,改完回到 reports/ 等上傳,block 還指著的圖一起帶回來;
  ⑤ 不在這台機器上 → FileNotFoundError,什麼都不寫;沒給要改什麼 → ValueError;
  ⑥ 規則:reports.md §1 與 AGENTS.md 寫明走 edit_report、不准手改 JSON、沒被指名的不動、「再做一份」是新的、公開連結不跟著變。

Run: cd blave-agent && .venv/bin/python tests/check_report_edit.py
"""
import contextlib, io, json, os, shutil, sys, tempfile, time
TMP = tempfile.mkdtemp(prefix="rptedit-")
os.environ["BLAVE_AGENT_WORKSPACE"] = os.path.join(TMP, "workspace")
os.environ["BLAVE_AGENT_LOCAL"] = "1"
for k in ("BLAVE_TURN_ID", "BLAVE_SCHEDULED_JOB", "BLAVE_SCHEDULED_RUN"):
    os.environ.pop(k, None)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import lib.report as R

fails = 0


def check(cond, msg, got=None):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg + ("" if cond or got is None else f"  → {got!r}"))
    fails += (not cond)


def quiet(fn, *a, **kw):
    with contextlib.redirect_stdout(io.StringIO()) as out:
        r = fn(*a, **kw)
    return r, out.getvalue()


def doc(rid, d=None):
    with open(os.path.join(d or R.REPORTS_DIR, rid + ".json"), encoding="utf-8") as f:
        return json.load(f)


def reports():
    return sorted(n for n in os.listdir(R.REPORTS_DIR) if n.endswith(".json"))


def raises(exc, fn, *a, **kw):
    try:
        quiet(fn, *a, **kw)
    except exc as e:
        return str(e) or True
    return False


BLOCKS = [{"type": "text", "variant": "lead", "markdown": "台積電站上新高。"},
          {"type": "kpi_row", "items": [{"label": "收盤", "value": "1,085", "tone": "neutral"}]},
          {"type": "text", "markdown": "第二段,有一個錯自。"}]

# ── ① 指名修改 ──
os.environ["BLAVE_TURN_ID"] = "t1"
quiet(R.write_report, "research-2330", "舊標題", BLOCKS, created_at=1790000000, meta={"shareable": False}, images={"fig.png": b"one"})
quiet(R.write_report, "research-btc", "另一份", BLOCKS, created_at=1790000100)
before, other, n0 = doc("research-2330"), open(os.path.join(R.REPORTS_DIR, "research-btc.json"), "rb").read(), reports()
p = os.path.join(R.REPORTS_DIR, "research-2330.json")
os.utime(p, (time.time() - 60, time.time() - 60))
m0 = os.stat(p).st_mtime_ns
os.environ["BLAVE_TURN_ID"] = "t2"
path, out = quiet(R.edit_report, "research-2330", title="新標題")
after = doc("research-2330")
check(os.path.basename(path) == "research-2330.json" and reports() == n0, "① 改標題:同 id、報告檔數不變", (path, reports()))
check(after["title"] == "新標題" and after["blocks"][0]["title"] == "新標題", "① 信封與 meta 的標題都換了(畫面讀的是 meta 那一個)", after["blocks"][0])
check(after["created_at"] == before["created_at"] == 1790000000 and after["blocks"][0]["generated_at"] == before["blocks"][0]["generated_at"],
      "① created_at 不變:清單順序不跳", after["created_at"])
check(after["blocks"][1:] == before["blocks"][1:] and after["type"] == before["type"] and after["blocks"][0]["shareable"] is False, "① 沒被點到的 block 與型別逐字不變")
check(os.stat(p).st_mtime_ns > m0, "① 檔案 mtime 動了:結果卡的「之後有更新」照常出現")
check(open(os.path.join(R.REPORTS_DIR, "research-btc.json"), "rb").read() == other, "① 沒被指名的那一份逐 byte 不變")
check(open(os.path.join(R.REPORTS_DIR, "research-2330.files", "fig.png"), "rb").read() == b"one", "① 圖留著")
# 第九批 #4:帳本那一行是「改過」的紀錄(at = 修改的時間,不是報告的 created_at),不是這一輪的所有權
line = json.loads(open(R.LEDGER, encoding="utf-8").read().splitlines()[-1])
check(line["id"] == "research-2330" and line["turn"] == "t2" and line.get("edited") is True
      and abs(line["at"] - time.time()) < 60 and line["at"] != after["created_at"],
      "① 帳本記了這一筆:edited、這一輪的 turn、at 是修改的時間(不是 created_at)", line)
check(R._own("research-2330") is None and R.target_id("research-2330", replace=True) == "research-2330-2",
      "① 改過別輪的報告不等於這一輪寫的:同一輪 replace=True 蓋不到它,寫出去是新的一份", R.target_id("research-2330", replace=True))
os.environ["BLAVE_TURN_ID"] = "t1"
quiet(R.edit_report, "research-btc", title="另一份(改)")
check(R._own("research-btc") == "research-btc" and R.target_id("research-btc", replace=True) == "research-btc",
      "① 這一輪自己寫的那份,改過之後仍是自己的:replace=True 照舊換掉同一份")
os.environ["BLAVE_TURN_ID"] = "t2"
other = open(os.path.join(R.REPORTS_DIR, "research-btc.json"), "rb").read()
check("changed in place" in out and "NEW report" not in out and "replace=True" not in out and out.isascii(), "① 輸出講明改在原處(ASCII),不提 replace", out)
reports_js = open(os.path.join(ROOT, "shell", "renderer", "reports.js"), encoding="utf-8").read()
check('typeof r.created_at === "number"' in reports_js and 'return r.id + "@" + (typeof r.mtime === "number" ? r.mtime' in reports_js,
      "① 電腦版:清單照 created_at 排、版本鍵是 id + mtime(這兩件事沒變,上面兩條才成立)")

_, _ = quiet(R.edit_report, "research-2330", change=lambda b: b[3].update(markdown="第二段,有一個錯字。"))
fixed = doc("research-2330")
check(fixed["blocks"][3]["markdown"] == "第二段,有一個錯字。" and fixed["blocks"][:3] == after["blocks"][:3] and fixed["title"] == "新標題" and reports() == n0,
      "① 改一段:只有那一段變,標題留著上一次改的", fixed["blocks"][3])

# ── ② 沒指名的新報告 ──
path2, _ = quiet(R.write_report, "research-2330", "再做一份", BLOCKS)
check(os.path.basename(path2) == "research-2330-2.json" and doc("research-2330") == fixed and len(reports()) == len(n0) + 1, "② 再做一份(write_report 同 id)→ 新 id,原報告不動", path2)

# ── ③ 同一套寫入 ──
cite = lambda n: {"type": "image", "file": n, "alt": "圖", "source": {"name": "Site", "url": "https://example.com/a"}}
snap = open(p, "rb").read()
err = raises(ValueError, R.edit_report, "research-2330", change=lambda b: b + [cite("cite-1.png"), cite("cite-2.png"), cite("cite-3.png")])
check(bool(err) and "at most 2" in str(err) and open(p, "rb").read() == snap, "③ 引用圖上限照擋,擋下時原檔不變", err)
side = os.path.join(R.REPORTS_DIR, "research-2330.files")
for n in ("cite-keep.png", "cite-unused.png"):
    open(os.path.join(side, n), "wb").write(b"\x89PNG")
quiet(R.edit_report, "research-2330", change=lambda b: b + [cite("cite-keep.png"), {"type": "news", "items": []}])
check(sorted(os.listdir(side)) == ["cite-keep.png", "fig.png"], "③ 沒用到的擷取檔照清,images= 給的圖不動", sorted(os.listdir(side)))
check(doc("research-2330")["schema_version"] == "1.6" and fixed["schema_version"] == "1.3", "③ schema 版本照內容重算", doc("research-2330")["schema_version"])

# ── ④ 雲端:報告在 sent/ ──
os.makedirs(R.SENT_DIR, exist_ok=True)
quiet(R.write_report, "brief-0928", "晨報", BLOCKS + [{"type": "image", "file": "eq.png", "alt": "圖"}], type="morning", created_at=1790000200, images={"eq.png": b"eq", "gone.png": b"x"})
os.replace(os.path.join(R.REPORTS_DIR, "brief-0928.json"), os.path.join(R.SENT_DIR, "brief-0928.json"))
os.replace(os.path.join(R.REPORTS_DIR, "brief-0928.files"), os.path.join(R.SENT_DIR, "brief-0928.files"))
path4, _ = quiet(R.edit_report, "brief-0928", title="晨報(更正)")
d4 = doc("brief-0928")
check(path4 == os.path.join(R.REPORTS_DIR, "brief-0928.json") and d4["title"] == "晨報(更正)" and d4["created_at"] == 1790000200 and d4["type"] == "morning",
      "④ 已上傳的報告:改完的檔回到 reports/ 等上傳,同 id、同 created_at", path4)
check(os.listdir(os.path.join(R.REPORTS_DIR, "brief-0928.files")) == ["eq.png"], "④ block 還指著的圖一起帶回來(沒被指到的不帶)", os.listdir(os.path.join(R.REPORTS_DIR, "brief-0928.files")))

# ── ⑤ 拒絕 ──
n5 = reports()
e1 = raises(FileNotFoundError, R.edit_report, "no-such-report", title="x")
check(bool(e1) and "offer to make a new one" in str(e1) and reports() == n5, "⑤ 不在這台機器上:FileNotFoundError,什麼都不寫,訊息講該怎麼跟用戶說", e1)
check(bool(raises(ValueError, R.edit_report, "research-2330")) and bool(raises(ValueError, R.edit_report, "../x", title="x")), "⑤ 沒給要改什麼、id 不合格:ValueError")

# ── ⑥ 規則 ──
md = open(os.path.join(ROOT, "references", "reports.md"), encoding="utf-8").read().split("## 2.")[0]
rule = md[md.index("- **Changing a report the user named**"):md.index("- **Writing the file yourself**")]
check("`lib.report.edit_report`" in rule and "**Never edit `reports/<id>.json` by hand**" in rule and "A report nobody named is never\n  changed" in rule
      and "is a new report" in rule and "the link is not\n  updated by the change" in rule and "「檢查後更新公開版本」" in rule and "`created_at`" in rule,
      "⑥ reports.md §1:走 edit_report、不准手改 JSON、沒被指名的不動、「再做一份」是新的、公開連結不跟著變")
agents = [l for l in open(os.path.join(ROOT, "AGENTS.md"), encoding="utf-8").read().splitlines() if l.startswith("A report is a document")]
check(len(agents) == 1 and "goes through `edit_report` on that same report" in agents[0] and "never a hand edit of the JSON" in agents[0], "⑥ AGENTS.md › Reports 指到 edit_report")

shutil.rmtree(TMP, ignore_errors=True)
print("\nALL PASS" if not fails else f"\n{fails} FAILED")
sys.exit(1 if fails else 0)
