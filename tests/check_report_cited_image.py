"""用戶要求引用的網頁圖一定進報告(0.1.8 e2e #56)。No network.

實測:agent 用 browser_capture 擷取了圖、把 image block append 到 pack.blocks 再 publish——publish 用
zip(pack.owners, pack.blocks) 配對,多出來的那一塊被無聲截掉;報告沒有圖、schema 停在 1.4、圖成了孤兒檔,
回覆也沒講。references 沒寫 pack 報告的引用圖要放哪。鎖:
  ① narrative["images"] → image block(帶 source)、schema 1.6、排在數據區塊之後判讀之前、不算進 16 塊;
  ② 手改 pack.blocks → 拒,不再無聲丟掉;
  ③ 擷取了卻沒引用 → 拒,直到引用或 narrative["images_unused"] 表態;表態後照發、孤兒檔刪掉、提示回覆要講;
  ④ images 的每一種壞法一次列完,什麼都不寫;
  ⑤ write_report(手寫報告)寫完也清沒被引用的擷取檔,不碰 images= 給的圖;
  ⑥ describe() 與 references 寫明放哪、怎麼算。

Run: cd blave-agent && .venv/bin/python tests/check_report_cited_image.py
"""
import contextlib, io, json, os, sys, tempfile
TMP = tempfile.mkdtemp(prefix="cite-")
os.environ["BLAVE_AGENT_WORKSPACE"] = os.path.join(TMP, "workspace")
os.environ["BLAVE_AGENT_STATE"] = os.path.join(TMP, "state")
os.environ["BLAVE_AGENT_LOCAL"] = "1"
for k in ("BLAVE_DATA_ACCESS", "BLAVE_DATA_ACCESS_WHY", "BLAVE_REPORT_PACKS", "BLAVE_SCHEDULED_RUN", "BLAVE_TURN_ID"):
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


def pack(rid="research-sol-20260928", n_tables=0):
    blocks = [T.kpi_row([T.kpi("SOL", "122.94")])]
    blocks += [T.table(f"表 {i}", [("a", "甲", "left")], [{"a": "1"}]) for i in range(n_tables)]
    blocks.append(T.footnote([("src", "口徑")]))
    pk = T.Pack(rid, "SOL 研究", "research", "研究報告", blocks, {}, owners=["kpi_row"] + ["t"] * n_tables + ["footnote"])
    pk.report_day, pk.subject = "2026-09-28", "SOL"
    return pk


def capture(rid, name="cite-muk8yonq-bf00fd.png"):
    d = os.path.join(R.REPORTS_DIR, rid + R.FILES_SUFFIX)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, name), "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
    return name


def sidecar(rid):
    try:
        return sorted(os.listdir(os.path.join(R.REPORTS_DIR, rid + R.FILES_SUFFIX)))
    except OSError:
        return []


def publish(pk, nar, **kw):
    """→ (doc or None, refusal text, stdout)"""
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            path = T.publish(pk, nar, title="SOL 相對強度領先大盤", shareable=True, **kw)
        return json.load(open(path)), "", buf.getvalue()
    except ValueError as e:
        return None, str(e), buf.getvalue()


NAR = {"lead": "SOL 相對強度領先大盤。", "summary": "強勢來自現貨買盤,接下來看未平倉量能否延續。",
       "against": "- 今年以來報酬仍落後同業。", "robustness": "- 換成 60 日窗口結論不變。",
       "risk": "若未平倉量轉為下滑,這個判斷就不成立。", "few_sources": "測試", "no_extra": "測試", "news": []}
SRC = {"name": "CryptoSlate", "url": "https://cryptoslate.com/predictions/market/what-price-will-solana-hit-in-september-2026/"}
RID = "research-sol-20260928"

# ── ② 實測那個寫法:append 到 pack.blocks ──
f = capture(RID)
pk = pack()
pk.blocks.append({"type": "image", "file": f, "alt": "SOL 近一個月價格走勢圖", "source": SRC})
doc, msg, _ = publish(pk, NAR)
check(doc is None and "pack.blocks was changed by hand" in msg and "narrative['images']" in msg,
      "② 手改 pack.blocks:拒並指路 narrative['images'](以前:無聲截掉、報告照發)", msg)
check(not os.path.exists(os.path.join(R.REPORTS_DIR, RID + ".json")) and sidecar(RID) == [f], "② 被拒時什麼都沒寫、擷取檔還在")

# ── ③ 擷取了卻沒引用 ──
doc, msg, _ = publish(pack(), NAR)
check(doc is None and "1 captured image(s) are not in the report" in msg and f in msg and "images_unused" in msg,
      "③ 擷取了卻沒放進 narrative:拒,列出檔名與兩條路", msg)

# ── ① 正路 ──
doc, msg, out = publish(pack(), dict(NAR, images=[{"file": f, "source": SRC, "alt": "SOL 近一個月價格走勢圖", "caption": "近一個月走勢"}]))
types = [b["type"] for b in (doc or {}).get("blocks", [])]
img = next((b for b in (doc or {}).get("blocks", []) if b["type"] == "image"), {})
check(doc is not None and doc["schema_version"] == "1.6" and img.get("file") == f and img.get("source") == SRC
      and img.get("alt") == "SOL 近一個月價格走勢圖" and img.get("caption") == "近一個月走勢" and "w" not in img, "① narrative['images'] → 帶 source 的 image block、schema 1.6", (msg, img))
check(types.count("image") == 1 and types.index("image") > types.index("kpi_row")
      and types.index("image") < min(i for i, b in enumerate(doc["blocks"]) if b["type"] == "text" and b["markdown"].startswith("## ")),
      "① 位置:數據區塊之後、判讀段落之前", types)
check(sidecar(RID) == [f] and "left out" not in out, "① 被引用的擷取檔留著")

big = pack("research-big-20260928", n_tables=9)   # meta + lead + kpi + 9 表 + against + robustness + 總結 + 尾註 = 16
fb = capture("research-big-20260928")
doc, msg, out = publish(big, dict(NAR, images=[{"file": fb, "source": SRC, "alt": "圖"}]))
check(doc is not None and len(doc["blocks"]) == 17 and "over 16" not in out
      and any(b["type"] == "image" for b in doc["blocks"]), "① 16 塊滿了再加引用圖:圖照放、不算進上限、不出提醒", (msg, out[:200]))
doc, msg, out = publish(pack("research-big2-20260928", n_tables=10), NAR)
check(doc is not None and "over 16" in out and "NOTE for you, not for the reply" in out and "WARNING" not in out.split("[report]")[0],
      "超過 16 塊的提醒標明是給 agent 的、不是給回覆的(#57)", out[:200])

# ── ③ 表態後照發、孤兒檔清掉 ──
RID2 = "research-eth-20260928"
g1, g2 = capture(RID2, "cite-aaa-111111.png"), capture(RID2, "cite-bbb-222222.png")
doc, msg, out = publish(pack(RID2), dict(NAR, images=[{"file": g1, "source": SRC, "alt": "圖"}]))
check(doc is None and "1 captured image(s) are not in the report: cite-bbb-222222.png" in msg, "③ 擷取兩張只引用一張:另一張要表態", msg)
doc, msg, out = publish(pack(RID2), dict(NAR, images=[{"file": g1, "source": SRC, "alt": "圖"}], images_unused="第二張被彈窗擋住,畫面不完整。"))
check(doc is not None and sidecar(RID2) == [g1] and "1 captured image(s) were left out and deleted" in out
      and "say in the reply" in out, "③ 表態後:報告照發、沒用到的擷取檔刪掉、提示回覆要講", (msg, sidecar(RID2), out[-300:]))
RID3 = "research-xrp-20260928"
capture(RID3)
doc, msg, out = publish(pack(RID3), dict(NAR, images_unused="網頁上的圖只是裝飾,跟結論無關。"))
check(doc is not None and doc["schema_version"] != "1.6" and sidecar(RID3) == [] and "not in the report and why" in out,
      "③ 一張都不放(表態):報告沒有圖、孤兒檔清掉、提示回覆要講", (msg, out[-300:]))
doc, msg, _ = publish(pack("research-ada-20260928"), dict(NAR, images_unused=""))
check(doc is None and "narrative['images_unused'] must be one sentence" in msg, "③ 表態不能是空字串", msg)

# ── ④ 壞法一次列完 ──
RID4 = "research-bad-20260928"
h = capture(RID4)
doc, msg, _ = publish(pack(RID4), dict(NAR, images=[
    {"file": "cite-nope.png", "source": SRC, "alt": "圖"},
    {"file": h, "source": {"name": "X", "url": "http://x.example/a"}, "alt": ""},
    {"file": h, "source": SRC, "alt": "圖", "w": 100}]))
check(doc is None and all(x in msg for x in ("has 3 items, at most 2", "is not a capture of this report", "https://host",
                                            "[1].alt is required", "unknown key(s) ['w']"))
      and "captured image(s) are not in the report" not in msg and sidecar(RID4) == [h],
      "④ 太多張、檔不存在、非 https、沒 alt、多餘欄位:一次列完,不寫檔、不刪檔", msg)
doc, msg, _ = publish(pack(RID4), dict(NAR, images="cite.png"))
check(doc is None and "must be a list of" in msg, "④ images 不是 list", msg)

# ── ⑤ write_report(手寫報告)──
RID5 = "handmade-20260928"
k1, k2 = capture(RID5, "cite-k1-aaaaaa.png"), capture(RID5, "cite-k2-bbbbbb.png")
with contextlib.redirect_stdout(io.StringIO()):
    R.write_report(RID5, "手寫", [{"type": "text", "markdown": "x"}, {"type": "image", "file": k1, "alt": "圖", "source": SRC},
                                  {"type": "image", "file": "perm.png", "alt": "自己畫的"}],
                   images={"perm.png": b"\x89PNG", "spare.png": b"\x89PNG"})
check(sidecar(RID5) == [k1, "perm.png", "spare.png"], "⑤ write_report:沒被引用的擷取檔刪掉;images= 給的圖不碰", sidecar(RID5))

# ── ⑥ 文件 ──
dsc = pack("research-doc-20260928").describe()
check('narrative["images"]' in dsc and "report='research-doc-20260928'" in dsc and "不算進 16 塊" in dsc and "images_unused" in dsc
      and "不要改 pack.blocks" in dsc, "⑥ describe() 檢查表寫明引用圖放哪、怎麼算、不放要表態")
ref = open(os.path.join(ROOT, "references", "reports.md"), encoding="utf-8").read()
sec = ref[ref.index("### Citing an image from the web"):ref.index("## 6. Structural rules")]
check('narrative["images"]' in sec and "does not\n  count them against R4's 16 blocks" in sec and "Never add to `pack.blocks` yourself" in sec
      and "the reply says so in one plain sentence" in sec and "cited images\n  not counted" in ref,
      "⑥ references/reports.md:放哪、不佔上限、不准改 pack.blocks、沒放要在回覆講")

print("all passed" if not fails else f"{fails} failed")
sys.exit(1 if fails else 0)
