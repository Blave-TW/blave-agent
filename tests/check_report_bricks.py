"""Minimal check for the 0.1.7 report layer — bricks, the news slot, publish()'s automatic
checks, lead_chart, W4 punctuation, custom recipes. No network, no api.
Run: cd blave-agent && .venv/bin/python tests/check_report_bricks.py
"""
import json, os, sys, tempfile
os.environ["BLAVE_AGENT_WORKSPACE"] = tempfile.mkdtemp(prefix="bricks-")
os.environ["BLAVE_REPORT_PACKS"] = "off"   # 每格自己的假資料:不重用上一格留下的 pack(重用另有一格驗)
for k in ("BLAVE_DATA_ACCESS", "BLAVE_DATA_ACCESS_WHY", "BLAVE_AGENT_LOCAL", "BLAVE_SCHEDULED_RUN"):
    os.environ.pop(k, None)
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import numpy as np, pandas as pd
from lib import data as d
import lib.report_templates as T
import lib.report_bricks as B
from lib import report as R


def pub(pack, nar=None, **kw):
    """publish() with the two fields every narrated report needs (title, summary) filled in, for the
    checks that are about something else."""
    if nar:
        nar = dict(nar)
        nar.setdefault("summary", "合起來看方向一致,接下來看量能能否延續。")
        kw.setdefault("title", "測試結論:方向一致")
    return T.publish(pack, nar, **kw)

T._now_tpe = lambda: pd.Timestamp("2026-09-02 09:00", tz="Asia/Taipei").to_pydatetime()
NOW = int(pd.Timestamp("2026-09-02 09:00", tz="Asia/Taipei").timestamp())
rng = np.random.default_rng(3)
days = pd.bdate_range("2026-06-01", "2026-09-01"); n = len(days)
udays = pd.date_range("2026-06-01", "2026-09-02", freq="D", tz="UTC")
def bars(idx, base):
    c = pd.Series(base * np.cumprod(1 + rng.normal(0, .01, len(idx))), index=idx)
    o = c.shift(1).fillna(c.iloc[0])
    return pd.DataFrame({"Open": o, "High": np.maximum(o, c) * 1.002, "Low": np.minimum(o, c) / 1.002, "Close": c, "Volume": 1.0})
IDX, K = bars(days, 45000), {s: bars(udays, b) for s, b in (("BTCUSDT", 70000), ("ETHUSDT", 3000), ("SOLUSDT", 150))}
ALPHA = pd.DataFrame({"alpha": rng.normal(0, 1, len(udays) - 1)}, index=udays[:-1])
d.fetch_twmarket_index = lambda s, e, h: IDX.copy()
d.fetch_twmarket_turnover = lambda s, e, h: pd.DataFrame({"volume": 1.0, "value": 9e11, "trades": 1.0}, index=days)
d.fetch_twmarket_institutional = lambda s, e, h: pd.DataFrame({"foreign": 2.67e10, "investment_trust": 1e9, "dealer": 1e9, "total": 2.87e10}, index=days)
d.fetch_twmarket_margin = lambda s, e, h: pd.DataFrame({"margin_balance": np.linspace(9e6, 9.28e6, n)}, index=days)
d.fetch_twfutures_institutional = lambda f, s, e, h: pd.DataFrame({"foreign_net_oi": np.linspace(-60000, -70000, n)}, index=days)
d.fetch_twfutures_ohlcv = lambda *a: pd.DataFrame(columns=["Open", "High", "Low", "Close"])
d.fetch_economic_calendar = lambda h, **k: pd.DataFrame([{"time": "20:30", "country": "US", "country_name": "美國", "subject": "非農就業", "subject_title": "<8月>", "predict": 150, "last": 142, "unit": "千人"}])
d.fetch_kline_batch = lambda syms, i, s, e, h: {x: K[x].copy() for x in syms if x in K}
d.fetch_kline = lambda sym, i, s, e, h: K["BTCUSDT"].copy()
for fn in ("fetch_funding_rate", "fetch_market_direction", "fetch_capital_shortage", "fetch_top_trader_exposure",
           "fetch_liquidation", "fetch_whale_hunter", "fetch_taker_intensity", "fetch_unusual_movement"):
    setattr(d, fn, lambda *a, **k: ALPHA.copy())
d.fetch_open_interest_table = lambda h: {"coins": [{"token": "BTC", "market_cap": 2e12, "chg_24h": 0.021}, {"token": "ETH", "market_cap": 4e11, "chg_24h": -0.01},
                                                   {"token": "XRP", "market_cap": 1e11, "chg_24h": 0.064}]}
d.fetch_long_short_ratio_table = lambda h: {"sources": [{"exchange": "okx", "type": "account", "key": "okx_account"},
                                                        {"exchange": "binance", "type": "top_account", "key": "binance_top_account"},
                                                        {"exchange": "binance", "type": "account", "key": "binance_account"}],
                                            "coins": [{"token": "BTC", "binance_account": 1.84, "binance_top_account": 9.0, "okx_account": 7.0}]}
d.fetch_liquidation_exchanges = lambda h, hours=24, top_n=10: {"total": {"total_liq_usd": 4e8, "long_liq_usd": 3e8},
                                                               "exchanges": [{"exchange": "binance", "total_liq_usd": 3e8}, {"exchange": "okx", "total_liq_usd": 1e8}]}
TICK = pd.DataFrame({"last": 1.0, "change_pct": np.linspace(-9, 30, 20), "quote_volume": 1e8}, index=[f"C{i}USDT" for i in range(19)] + ["龙虾USDT"])
d.fetch_binance_ticker_24h = lambda: TICK.copy()
d.fetch_news = lambda h, q=None, since=None, limit=None: pd.DataFrame([{"id": "1", "title": "鉅亨標題", "published_at": NOW - 3600, "source": "Anue鉅亨", "tags": [], "stocks": []}])
d.fetch_tw_announcements_public = lambda: pd.DataFrame([{"time": pd.Timestamp("2026-09-01 17:00", tz="Asia/Taipei"), "stock_id": "2330", "name": "台積電",
                                                         "subject": "公告董事會決議", "clause": "第51款", "fact_date": "2026-09-01"}])
DAY = pd.DataFrame({"name": ["台積電"], "value": [4e10], "volume": 1.0, "close": 100.0, "change": 1.0, "trades": 1.0}, index=pd.Index(["2330"], name="stock_id"))
DAY.attrs = {"date": "2026-09-01"}
d.fetch_twse_day_all_public = lambda: DAY.copy()
d.fetch_twstock_market_value_all = lambda h, top=None: pd.DataFrame({"stock_id": ["2330"], "market_value": [1e13]})
d.fetch_twmarket_dividend_points = lambda s, e, h: pd.DataFrame({"points": [0.0], "estimated": [False]}, index=pd.to_datetime([s]))
d.fetch_twstock_dividend_batch = lambda ids, s, e, h: {}
H = {"api-key": "x", "secret-key": "y"}
d.fetch_twstock_list = lambda h, **k: pd.DataFrame({"name": ["台積電", "友達", "力積電"]}, index=pd.Index(["2330", "2409", "6770"], name="stock_id"))
d.fetch_open_interest_coin = lambda sym, h: {"windows": {"7d": {"chg": {"BTC": 0.03, "ETH": -0.02, "SOL": 0.12}.get(sym)}}}

fails = 0
def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg); fails += (not cond)

def refused(fn, must, why):
    try:
        fn(); check(False, f"{why}(沒有拒收)")
    except ValueError as e:
        check(must in str(e), f"{why}:訊息帶「{must}」" + ("" if must in str(e) else f" — 實際:{str(e)[:120]}"))

def doc(path):
    return json.load(open(path))

# ── news slot ──
tw = T.tw_market_brief("2026-09-02", H)
check(tw.news is not None and "news" in tw.slots and "鉅亨標題" in tw.describe() and "新聞候選 1 則" in tw.describe(),
      "台股晨報 v2:有 news 格,describe() 列出鉅亨候選")
ITEM = {"title": "台積電 9 月營收年增 38%", "summary": "月營收創單月新高,年增近四成。", "tag": "pos",
        "sources": [("經濟日報", "https://money.udn.com/money/story/1"), ("Anue鉅亨", "https://news.cnyes.com/x")],
        "published_at": "2026-09-01 18:30", "symbols": ["2330"]}
ITEM2 = {"title": "聯準會理事:降息仍需更多數據", "title_orig": "Fed governor says more data needed", "title_orig_lang": "en", "summary": "理事認為通膨尚未穩定回落。",
         "tag": "neutral", "sources": [{"name": "Reuters", "url": "https://www.reuters.com/a"}], "published_at": NOW - 7200}
ITEM3 = {"title": "美光財報優於預期", "summary": "營收與毛利率都高於市場預期。", "tag": "neutral",
         "sources": [("CNBC", "https://www.cnbc.com/b")], "published_at": NOW - 5000}
b = doc(pub(tw, {"no_extra": "測試:不加做", "few_sources": "測試", "news": [ITEM, ITEM2, ITEM3]}, report_id="n1"))["blocks"]
nb = [x for x in b if x["type"] == "news" and x.get("title", "").startswith("綜合")]
types = [x["type"] for x in b]
check(len(nb) == 1 and nb[0]["title"] == "綜合 4 家" and nb[0]["items"][0]["summary"] == "月營收創單月新高，年增近四成。"
      and nb[0]["items"][1]["title_orig"] == "Fed governor says more data needed" and nb[0]["items"][1]["title_orig_lang"] == "en" and nb[0]["items"][0]["channel"] == "web"
      and nb[0]["items"][0]["published_at"] == int(pd.Timestamp("2026-09-01 18:30", tz="Asia/Taipei").timestamp()),
      "agent 填的新聞:≥3 家寫「綜合 N 家」、摘要轉全形、title_orig 帶著、台北時間字串轉 unix 秒")
check(types.index("news") < max(i for i, x in enumerate(b) if x["type"] == "table" and "事件" in (x.get("title") or "")),
      "新聞 block 落在配方的位置(事件表之前),不是整份最後")
check(doc(os.path.join(R.REPORTS_DIR, "n1.json"))["schema_version"] == "1.4" and any(i["id"] == "news" and "agent 於 09:00 蒐集整理" in i["text"] for i in b[-1]["items"]),
      "有 news block → 1.4;尾註固定一行寫蒐集時間與標籤依據")
auto = doc(pub(tw))["blocks"]
lic = [x for x in auto if x["type"] == "news" and x.get("title") == "Anue鉅亨"]
check(len(lic) == 1 and all("summary" not in i and "tag" not in i and i["channel"] == "licensed" for i in lic[0]["items"])
      and any("鉅亨網授權標題" in i["text"] for i in auto[-1]["items"]),
      "排程(無敘事):只放鉅亨授權標題,不帶摘要與標籤,尾註講明未經整理")
bad = lambda **kw: (lambda: pub(tw, {"no_extra": "測試:不加做", "few_sources": "測試", "news": [dict(ITEM, **kw)]}, report_id="nbad"))
refused(bad(summary="這是一句非常非常長的摘要,超過了四十個字的上限,所以應該要被拒收才對,一定要被拒收。"), "cap 40", "摘要超過 40 字")
refused(bad(summary="營收創新高。毛利率也創高。"), "more than one sentence", "摘要兩句")
refused(bad(summary="營收創新高,值得布局。"), "reads as advice", "摘要帶建議語氣")
refused(bad(sources=[("經濟日報", "http://money.udn.com/x")]), "must be https", "http 連結")
refused(bad(sources=[("經濟日報", "https://u:p@money.udn.com/x")]), "no user name", "連結帶帳密")
refused(bad(sources=[("經濟日報", None)]), "no https link", "web 新聞沒有連結")
refused(bad(tag="bullish"), "must be one of", "標籤不在三選一")
refused(bad(title_orig="Taiwan exports jump"), "title_orig_lang must name", "有原文標題卻沒標語言")
refused(bad(title_orig_lang="en"), "without title_orig", "標了語言卻沒有原文標題")
refused(bad(published_at=NOW + 7200), "in the future", "未來時間")
refused(bad(published_at=NOW - 30 * 86400), "days old", "超過窗口的舊聞")
refused(lambda: pub(tw, {"no_extra": "測試:不加做", "few_sources": "測試", "news": [ITEM, dict(ITEM2, sources=[("經濟日報", "https://money.udn.com/money/story/1")])]}), "repeats", "同一個 url 兩則")
refused(lambda: pub(tw, {"no_extra": "測試:不加做", "few_sources": "測試", "news": [ITEM, dict(ITEM2, title="台積電9月營收年增38%!")]}), "looks like item 0", "近似標題兩則")
refused(lambda: pub(tw, {"no_extra": "測試:不加做", "few_sources": "測試", "news": [dict(ITEM, title=f"標題{i}", sources=[("x", f"https://a.b/{i}")]) for i in range(6)]}), "needs 1–5", "超過 5 則")
lic_item = {"title": "鉅亨標題", "summary": "鉅亨報導的事件。", "tag": "neutral", "sources": [("Anue鉅亨", None)], "channel": "licensed", "published_at": NOW - 3600}
check(os.path.exists(pub(tw, {"no_extra": "測試:不加做", "few_sources": "測試", "news": [lic_item]}, report_id="nlic")), "describe() 的授權候選(channel=licensed)沒有連結也收")
crypto = T.crypto_market_brief("2026-09-02", H)
refused(lambda: pub(crypto, {"lead": "BTC 現貨撐盤,槓桿正在退場。"}, report_id="c1"), "search the web first",
        "有新聞格的報告對話產出卻沒填 news:要求先上網查(候選不能代替)")
cb = doc(pub(crypto, {"lead": "BTC 現貨撐盤,槓桿正在退場。", "few_sources": "查了三家都沒有相關新聞"}, report_id="c1"))["blocks"]
check(not any(x["type"] == "news" for x in cb) and any(i["id"] == "news" and "沒有附新聞" in i["text"] for i in cb[-1]["items"]),
      "有說明為什麼沒新聞(few_sources):照發,不出 news block,尾註一句")
check("先上網查:至少 3 個不同網站" in T.tw_market_brief("2026-09-02", H).describe(), "台股晨報 describe 第一句要求先上網查 3 個網站")
_nd = "\n".join(T._news_describe({"candidates": [], "market": "crypto"}))
check("其他新聞站都可以用" in _nd and "標明來源" in _nd and not any(w in _nd for w in ("robots", "禁令", "條款")),
      "新聞來源:不以對方條款 / robots 禁 AI 為由排除任何站(Wei 09-28);標來源、不照抄的品質規則還在")
check(not any(i["id"] == "news" for i in doc(pub(crypto))["blocks"][-1]["items"]), "加密晨報排程:沒有新聞、也不多一行尾註")
sym = T.symbol_brief("BTC", "2026-09-02", H)
sb = doc(pub(sym, {"lead": "BTC 現貨撐盤,槓桿正在退場。", "no_extra": "測試:不加做", "few_sources": "測試", "news": [dict(ITEM, symbols=["BTC"])]}, report_id="symnews"))["blocks"]
st = [x["type"] for x in sb]
check("news" in st and st.index("news") < st.index("footnote") and sb[-2]["markdown"].startswith("## 總結")
      and any(i["id"] == "news" for i in sb[-1]["items"]),
      "沒有 news 積木的範本(單標的晨報)也收對話填的新聞:排在數據區塊之後、尾註一行")
nb0 = doc(pub(sym, {"lead": "BTC 現貨撐盤,槓桿正在退場。", "news": []}, report_id="symnews0"))["blocks"]
check("news" not in [x["type"] for x in nb0] and any("沒有查到" in i["text"] for i in nb0[-1]["items"]),
      "news=[](查過沒有):不出 block,尾註一句")
na = doc(pub(sym, {"lead": "BTC 現貨撐盤,槓桿正在退場。"}, report_id="symnone"))["blocks"]
check(not any(i["id"] == "news" for i in na[-1]["items"]), "沒填 news 的單標的晨報:輸出不變(不多一行尾註)")
check(not any(x["type"] == "news" for x in doc(pub(sym))["blocks"]), "單標的晨報排程:照舊沒有新聞")

# ── R10 + W4 ──
refused(lambda: pub(sym, {"lead": "外資現貨與期貨同日轉多,量能放大六成,投信連三買,自營商也同步回補,這是資金回補而不是空窗反彈。"}), "cap 40", "lead 第一句超過 40 字")
refused(lambda: pub(sym, {"lead": "BTC 漲 3%、ETH 漲 5%、SOL 漲 7%,全面上攻。"}), "carries 3 numbers", "lead 第一句三個數字")
refused(lambda: pub(sym, {"lead": "+3.2%,-1.1%。"}), "only figures", "lead 第一句只有數字")
fund = sym.context["資金費率"].split("（")[0]                         # e.g. +0.1234%
v = float(fund.rstrip("%"))
near = f"{v * 1.01:+.4f}%" if abs(v) > 0.01 else None
if near:
    refused(lambda: pub(sym, {"read": f"- 資金費率 {near},偏高\n- 乙 1\n- 丙 2"}), "apart", f"數字對帳:{near} 對 describe() 的 {fund}(差 1%)")
check(os.path.exists(pub(sym, {"read": f"- 資金費率 {fund},偏高\n- 乙 1\n- 丙 2"}, report_id="r10ok")), "數字對帳:照抄 describe() 的值放行")
check(os.path.exists(pub(sym, {"read": f"- 資金費率 {v:+.2f}%,偏高\n- 乙 1\n- 丙 2"}, report_id="r10round")), "數字對帳:小數位數不同(進位)放行")
ctx = {"ETH": "+7.26%"}
p = T.Pack("x", "x", "morning", "x", [T.footnote([("s", "口徑")])], ctx)
refused(lambda: pub(p, {"read": "- ETH 漲 +7.36%\n- 乙 1\n- 丙 2"}), "1.38% apart", "數字對帳:spec 樣張 ETH +7.36% 對 +7.26%")
check(os.path.exists(pub(p, {"read": "- ETH 七日漲 +12.40%,是 BTC 的兩倍\n- 乙 1\n- 丙 2"}, report_id="r10new")), "數字對帳:差很多的新比較放行")
w = doc(pub(p, {"lead": "外資買超 267 億,20 日均賣超:見 `a,b:c`。", "risk": "外資連兩日淨賣超逾 150 億(推翻)"}, report_id="w4"))["blocks"]
check(w[1]["markdown"] == "外資買超 267 億，20 日均賣超：見 `a,b:c`。" and w[-2]["markdown"].endswith("外資連兩日淨賣超逾 150 億（推翻）"),
      f"W4:中文旁的 , : ( ) 轉全形,code span 不動 — {w[1]['markdown']}")
check(T._fw("1,234.5 在 20:30,見 https://a.b/c") == "1,234.5 在 20:30，見 https://a.b/c" and T._fw(T._fw("甲,乙")) == "甲，乙",
      "W4:數字、時間、網址不動;轉換可重複套用")
check(T._fw("見 https://a.b/c:d,e 與 [x](https://x.y/a,b)。甲,乙") == "見 https://a.b/c:d,e 與 [x](https://x.y/a,b)。甲，乙",
      "W4:連結裡的 : 與 , 屬於網址,不轉")
d.fetch_news, _news = (lambda *a, **k: d._check_data_access()), d.fetch_news
os.environ["BLAVE_DATA_ACCESS"] = "0"
desc = T.tw_market_brief("2026-09-02", H).describe()
os.environ.pop("BLAVE_DATA_ACCESS"); d.fetch_news = _news
check("無 Blave 資料權限,鉅亨候選省略" in desc and "上一個收盤之後" not in desc.split("新聞候選")[1].split("\n")[0],
      "新聞候選沒資料權限:describe() 講權限,不講「上一個收盤之後」")

# 稽核 B1:觀察門檻本來就靠近現值,不是抄錯
pc = T.Pack("x", "x", "morning", "x", [T.footnote([("s", "口徑")])],
            {"融資餘額": "848.1 萬張（-2.1 萬張）", "加權指數": "46,616.24（-0.5%）", "外資": "+211.4 億", "ETH": "+7.26%"})
ok_nar = {"watch": [("融資餘額", "跌破 845.0 萬張", "848.1 萬張"), ("外資", "單日賣超逾 210.0 億", "+211.4 億")],
          "risk": "加權指數收盤跌破 46,000.00 這份解讀作廢。", "read": "- 若單日賣超逾 210.0 億就轉弱\n- 乙 1\n- 丙 2"}
check(os.path.exists(pub(pc, ok_nar, report_id="thr")), "數字對帳:watch 門檻欄、「跌破／逾」後面的門檻數字放行(845.0 對 848.1、46,000.00 對 46,616.24、210.0 對 211.4)")
refused(lambda: pub(pc, {"watch": [("融資餘額", "跌破 845.0 萬張", "848.9 萬張"), ("乙", "門檻", "值")]}), "apart", "數字對帳:watch 的現在值抄錯仍抓到")
refused(lambda: pub(pc, {"read": "- ETH 漲 +7.36%\n- 乙 1\n- 丙 2"}), "apart", "數字對帳:+7.36% 對 +7.26% 仍抓到")

# ── lead_chart ──
lb = doc(pub(tw, {"lead": "外資買超撐盤,期貨淨空單沒退。", "lead_chart": "tw_futures_inst", "news": []}, report_id="lc"))["blocks"]
ki = [x["type"] for x in lb].index("kpi_row")
check(lb[ki + 1]["type"] == "line_chart" and lb[ki + 1]["title"].startswith("外資期貨淨部位"), "lead_chart:指定的圖排到 KPI 列後面第一個")
refused(lambda: pub(tw, {"lead_chart": "nope", "news": []}), "lays out no chart", "lead_chart 指到不存在的積木")

# ── bricks ──
bt = B.Build({}, "2026-09-02", H, 30)
m = B.movers(bt, "crypto", 5)
coins = [r["coin"] for r in m.blocks[0]["rows"]]
check("龙虾" not in coins and coins[0] == "C18" and "sig" in m.blocks[0]["rows"][0], "movers:非 ASCII 代號排除,漲幅第一在最前,有異常漲跌欄")
dv = B.derivs_table(B.Build({}, "2026-09-02", H, 30), ["BTC", "ETH"])
row = dv.blocks[0]["rows"][0]
check(row == {"coin": "BTC", "oi": "+2.1%", "fund": row.get("fund"), "lsr": "1.84"} and all("format" not in c for c in dv.blocks[0]["columns"]),
      "derivs_table:多空比讀 sources[] 裡 Binance 的 account 那支,欄位一律不上色")
gated = {k: getattr(d, k) for k in ("fetch_open_interest_table", "fetch_long_short_ratio_table", "fetch_funding_rate")}
for k in gated:
    setattr(d, k, lambda *a, **kw: d._check_data_access())
os.environ["BLAVE_DATA_ACCESS"] = "0"
bt = B.Build({}, "2026-09-02", H, 30)
dv = B.derivs_table(bt, ["BTC"])
check(dv.blocks == [] and [x["name"] for x in bt.missing] == ["未平倉量", "多空比", "資金費率"], "derivs_table 沒資料權限:三欄都缺 → 不出,missing 各一筆")
os.environ.pop("BLAVE_DATA_ACCESS")
for k, f in gated.items():
    setattr(d, k, f)
bt = B.Build({}, "2026-09-02", H, 45)
check(B.tw_announcements(bt).blocks == [] and any("只在電腦版" in x for x in bt.notes), "重大訊息:雲端(沒有 BLAVE_AGENT_LOCAL)不抓")
os.environ["BLAVE_AGENT_LOCAL"] = "1"
an = B.tw_announcements(B.Build({}, "2026-09-02", H, 45))
check(an.blocks[0]["type"] == "news" and an.blocks[0]["items"][0]["tag"] == "neutral" and an.blocks[0]["items"][0]["title"] == "台積電：公告董事會決議",
      "重大訊息:電腦版出 news block,條款對不上一律中性")
ROUTINE = pd.DataFrame([{"time": pd.Timestamp("2026-09-01 17:00", tz="Asia/Taipei") + pd.Timedelta(minutes=i), "stock_id": sid, "name": nm,
                         "subject": subj, "clause": "第51款", "fact_date": "2026-09-01"}
                        for i, (sid, nm, subj) in enumerate([("2330", "台積電", "公告本公司名稱變更"), ("2330", "台積電", "公告本公司股票面額變更"),
                                                             ("2330", "台積電", "公告贖回海外第五次無擔保轉換公司債"),
                                                             ("9999", "小公司", "公告與大廠簽訂重大供貨合約"),
                                                             ("2330", "台積電", "公告與國際客戶簽訂先進製程合作"),
                                                             ("2330", "台積電", "公告董事會通過資本支出"),
                                                             ("2330", "台積電", "公告擴大美國廠投資"),
                                                             ("2330", "台積電", "公告取得有價證券")])])
d.fetch_tw_announcements_public = lambda: ROUTINE.copy()
bt = B.Build({}, "2026-09-02", H, 45)
an2 = B.tw_announcements(bt)
titles = [i["title"] for i in an2.blocks[0]["items"]] if an2.blocks else []
check(len(titles) == 3 and all("台積電" in t for t in titles)
      and not any(w in "".join(titles) for w in ("名稱變更", "面額", "轉換公司債", "有價證券", "小公司")),
      f"重大訊息:只留權值股(市值／成交值前段)、排除更名／面額／可轉債／有價證券等例行公告,最多 3 則 — {titles}")
d.fetch_tw_announcements_public = lambda: ROUTINE.iloc[:4].copy()
bt = B.Build({}, "2026-09-02", H, 45)
check(B.tw_announcements(bt).blocks == [] and any("例行公告或非權值股" in n for n in bt.notes), "過濾後沒有:不出這塊,記 notes")
os.environ.pop("BLAVE_AGENT_LOCAL")
pv = B.Brick([T.table("持倉", [("s", "標的", "left")], [{"s": "2330"}])], private=True)
check(pv.blocks[0]["private"] is True and doc(R.write_report("pv", "t", [pv.blocks[0]], type="performance"))["schema_version"] == "1.4",
      "private 積木:block 帶 private,write_report 標 1.4")
check(doc(R.write_report("fu", "t", [T.footnote([("a", "x", "https://a.b")])], type="research"))["schema_version"] == "1.4"
      and doc(R.write_report("fv", "t", [T.footnote([("a", "x")])], type="research"))["schema_version"] == "1.1",
      "footnote 帶 url 才升 1.4,沒帶維持原版號")

# ── custom recipe ──
rec = {"id": "my-btc", "title": "我的 BTC 晨報", "lookback_days": 90, "kpi": ["price_chart", "funding"],
       "bricks": [["price_chart", {"symbol": "BTC"}], ["funding", {"symbol": "BTC", "variant": "symbol"}], ["liquidation", {}], ["levels_table", {}]]}
path = T.save_recipe("my-btc", rec)
run = os.path.join(os.path.dirname(path), "run.py")
open(run, "w").write(T.RECIPE_RUN_PY)
cwd = os.getcwd(); os.chdir(os.environ["BLAVE_AGENT_WORKSPACE"])
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(T.__file__))))
exec(compile(T.RECIPE_RUN_PY, run, "exec"), {"__file__": run})
os.chdir(cwd)
out = doc(os.path.join(R.REPORTS_DIR, "my-btc-20260902-auto.json"))
check([x["type"] for x in out["blocks"]][:3] == ["meta", "kpi_row", "candlestick"] and out["blocks"][0]["origin"] == "scheduled",
      "自組配方:recipe.json + 固定 run.py 排程跑出純數據包(-auto)")
refused(lambda: T.check_recipe(dict(rec, id="crypto-market-x")), "collides", "自組配方 id 撞內建範本前綴")
refused(lambda: T.check_recipe(dict(rec, bricks=[["movers", {}]] * 9)), "at most 8", "自組配方超過 8 塊")
refused(lambda: T.check_recipe(dict(rec, bricks=[["news", {"zzz": 1}]])), "unknown parameter", "自組配方參數打錯")

# 稽核 B2–B4、B6:自組配方在存檔當下就拒
refused(lambda: T.check_recipe(dict(rec, report_id="tw-market-20260902")), "unknown key", "自組配方帶 report_id 繞過前綴檢查")
refused(lambda: T.check_recipe(dict(rec, type="performance")), "unknown key", "自組配方改 type")
refused(lambda: T.check_recipe(dict(rec, lookback_days=10 ** 6)), "1–365", "lookback_days 超出範圍")
refused(lambda: T.check_recipe(dict(rec, bricks=[["blave_indicators", {"names": ["不存在"]}]])), "indicator names", "blave_indicators 的 names 打錯")
refused(lambda: T.check_recipe(dict(rec, bricks=[["movers", {"n": "5"}]])), "integer 1–10", "movers n 是字串")
refused(lambda: T.check_recipe(dict(rec, bricks=[["tw_announcements", {"n": 50}]])), "integer 1–10", "重大訊息 n 超過契約 10 則")
refused(lambda: T.check_recipe(dict(rec, bricks=[["quote_table", {"symbols": ["BTC"] * 50}]])), "1–8 symbols", "報價表 50 個標的")
refused(lambda: T.check_recipe({"id": "my-close", "title": "x", "mode": "close", "bricks": [["tw_turnover", {}], ["tw_margin", {}]]}),
        "needs [\"price_chart\"", "close 模式沒放指數")
check(T.check_recipe({"id": "my-close", "title": "x", "mode": "close", "kpi": ["price_chart"],
                      "bricks": [["price_chart", {"symbol": "TAIEX"}], ["tw_margin", {}]]})["mode"] == "close", "close 模式有指數:收")
empty = B.build({"id": "my-empty", "title": "x", "bricks": [["levels_table", {}]]}, "2026-09-02", H)
check(bool(empty.skip) and pub(empty) is None, "沒有任何積木產出資料:skip,不送一份只剩空尾註的報告")
fn = T.footnote([])
check(not any(x["type"] == "footnote" for x in doc(pub(T.Pack("e", "e", "morning", "e", [T.kpi_row([T.kpi("a", "1")]), fn], {}), {"lead": "一句主張成立。"}))["blocks"]),
      "空的 footnote 不送出(api 會 400)")
refused(lambda: pub(tw, {"no_extra": "測試:不加做", "few_sources": "測試", "news": [dict(ITEM, symbols="2330")]}), "must be a list", "新聞 symbols 給字串")
refused(lambda: pub(tw, {"no_extra": "測試:不加做", "few_sources": "測試", "news": [dict(ITEM, published_at=float("nan"))]}), "finite unix time", "新聞時間 NaN")
refused(lambda: pub(tw, {"no_extra": "測試:不加做", "few_sources": "測試", "news": [dict(ITEM, sources=[("x", "https://good.com\\evil.com")])]}), "backslashes", "連結帶反斜線")
refused(lambda: pub(tw, {"no_extra": "測試:不加做", "few_sources": "測試", "news": [dict(ITEM, sources=[("x", "https://例子.com/a")])]}), "ASCII", "連結主機非 ASCII")

# ── 列舉:每種報告實際產出的每個字串,中文旁沒有半形標點、時間窗不寫 24h/168h/1d ──
# 範圍 = 讀者看得到的(每個 block 的字串)+ describe() 印給 agent 的 context / notes / skip。
# 不查:新聞標題(來源原文)、授權照錄的出處句、網址、code。
import re as _re
_CJK = "㐀-鿿　-〿＀-￯"
HALF = _re.compile(rf"[{_CJK}][,;:()]|[,;:()][{_CJK}]|\)[,;:]|[,;:]\(")
RAW_WINDOW = _re.compile(r"(?<![A-Za-z0-9_./])\d+\s?[hd](?![A-Za-z0-9])")
def strings(x, path=""):
    if isinstance(x, str):
        yield path, x
    elif isinstance(x, dict):
        for k, v in x.items():
            if k in ("points", "candles", "url", "source"):
                continue
            yield from strings(v, f"{path}.{k}")
    elif isinstance(x, list):
        for i, v in enumerate(x):
            yield from strings(v, f"{path}[{i}]")
def offenders(blocks, pack):
    out = []
    for i, blk in enumerate(blocks):
        if blk.get("type") == "code":
            continue
        for path, t in strings(blk, f"[{i}]{blk.get('type')}"):
            if (blk.get("type") == "news" and path.endswith(".title")) or (blk.get("type") == "footnote" and T._verbatim(t)):
                continue
            t = T._CODE_SPAN_RE.sub("", t)
            if HALF.search(t) or RAW_WINDOW.search(t):
                out.append(f"{path}: {t[:70]}")
    for k, v in list(pack.context.items()) + [(f"notes[{i}]", n) for i, n in enumerate(pack.notes)] + [("skip", pack.skip or "")]:
        if k in T._VERBATIM_CTX:
            continue
        for t in (str(k), str(v)):
            if HALF.search(t) or RAW_WINDOW.search(t):
                out.append(f"describe {k}: {t[:70]}")
    return out
FULL = {"lead": "槓桿退場,現貨撐盤。", "read": ["**甲**:一", "**乙**:二", "**丙**:三"],
        "watch": [("外資期貨淨多單", "轉為淨空", "有"), ("融資餘額", "連三日減少", "有")],
        "summary": "合起來是去槓桿而不是轉空,接下來看量能。", "risk": "若槓桿重新堆高,這個判斷就不成立。",
        "no_extra": "測試", "few_sources": "測試", "news": [ITEM]}
RES = {k: v for k, v in FULL.items() if k != "watch"}
RES.update(against="- 資金費率轉正(不支持)", robustness="- 換 60 日窗口仍成立")
CUSTOM = {"id": "leverage-week", "title": "槓桿擁擠度週報", "lookback_days": 7, "kpi": ["liquidation"],
          "bricks": [["funding", {"symbols": ["BTC", "ETH", "SOL"]}], ["derivs_table", {"symbols": ["BTC", "ETH", "SOL"], "window": "7d"}],
                     ["liquidation", {"hours": 168}]]}
d.fetch_news = lambda h, q=None, since=None, limit=None: pd.DataFrame([{"id": "1", "title": "鉅亨標題", "published_at": NOW - 3600, "source": "Anue鉅亨", "tags": [], "stocks": []}])
os.environ["BLAVE_AGENT_LOCAL"] = "1"      # 電腦版才有的積木(成交值前十、重大訊息)也要列進來
cases = [("台股晨報", T.tw_market_brief("2026-09-02", H), FULL), ("台股收盤", T.tw_close_brief("2026-09-01", H), FULL),
         ("加密晨報", T.crypto_market_brief("2026-09-02", H), FULL), ("單幣晨報", T.symbol_brief("BTC", "2026-09-02", H), FULL),
         ("研究", T.research_pack("SOL", date="2026-09-02", headers=H), RES),
         ("自組配方", T.build(T.check_recipe(CUSTOM), "2026-09-02", H), FULL)]
os.environ.pop("BLAVE_AGENT_LOCAL")
bad = []
for name, pk, nar in cases:
    if pk.skip:
        bad.append(f"{name}: skip {pk.skip}")
        continue
    blocks = doc(T.publish(pk, nar, title="測試結論", report_id=f"enum-{len(bad)}-{pk.report_id}"))["blocks"]
    bad += [f"{name} {o}" for o in offenders(blocks, pk)]
    bad += [f"{name} [{i}] callout" for i, x in enumerate(blocks) if x["type"] == "callout"]
    bad += [] if blocks[-2].get("variant") == "summary" else [f"{name}: 尾註前不是 variant=summary 的總結"]
check(not bad, f"列舉 {len(cases)} 種報告的全部字串:沒有夾在中文旁的半形標點、沒有 24h/168h 這種時間窗、沒有單獨的風險框"
      + ("" if not bad else " — " + " | ".join(bad[:8])))

# ── 比較題:一張多序列圖 + 比較表;問「這週」用 7 日 ──
cp = cases[-1][1]
lines = [x for x in cp.blocks if x["type"] == "line_chart"]
tb = [x for x in cp.blocks if x["type"] == "table"][0]
kl = [i["label"] for x in cp.blocks if x["type"] == "kpi_row" for i in x["items"]]
check(len(lines) == 1 and [s_["name"] for s_ in lines[0]["series"]] == ["BTC", "ETH", "SOL"] and "7 日均最高" in lines[0]["title"]
      and [c["label"] for c in tb["columns"]][1:3] == ["OI 7 日", "資金費率 7 日均"] and tb["rows"][2]["oi"] == "+12.0%"
      and "OI 7 日增幅最大:SOL" in tb["title"].replace("：", ":") and kl == ["7 日爆倉"],
      f"funding(symbols=…) 三幣一張圖;derivs_table(window=7d) 用各幣 7 日 OI 與 7 日均資金費率;168 小時寫成「7 日」— {kl} {tb['title']}")
check(T._window(24) == "24 小時" and T._window(168) == "7 日" and T._window(12) == "12 小時", "時間窗中文:24 小時 / 7 日")

wk = T.tw_market_brief("2026-09-05", H)
check(wk.skip is None and (wk.closed or {}).get("label") == "週末" and "用 9/1 的資料" in wk.describe() and "先問" not in wk.describe(),
      "週六要台股晨報:直接用最近交易日,describe 叫第一句講「今天休市,用 9/1 的資料」")
# ── 圖型寫死在積木層(Wei 09-27):flow → bar、水位/指標 → line、價格 → K 線;逐積木斷言 ──
CHART_TYPES = ("candlestick", "line_chart", "bar_chart", "histogram", "heatmap", "scatter", "box")
def kinds_of(pack):
    out = {}
    for o, blk in zip(pack.owners, pack.blocks):
        if blk.get("type") in CHART_TYPES:
            out.setdefault(o, set()).add(blk["type"])
    return out

_LM_LABELS = [80000.0 + 100 * i for i in range(200)]
real_fetch_liq_map = d.fetch_liquidation_map
d.fetch_liquidation_map = lambda sym, h: {"price": 90000.0, "labels": list(_LM_LABELS),
    "oi_value": [1e6] * 200, "cumsum": [1e6] * 200,
    "liquidation": {"24h": {"buy_liq": [2e5 if l > 90000 else 0.0 for l in _LM_LABELS],
                            "sell_liq": [4e5 if l <= 90000 else 0.0 for l in _LM_LABELS]}}}
os.environ["BLAVE_AGENT_LOCAL"] = "1"
tdays = pd.bdate_range("2026-05-01", "2026-09-02", tz="Asia/Taipei")
d.fetch_twstock_ohlcv = lambda sid, iv, h, start=None, end=None: pd.DataFrame(
    {"Open": 100.0, "High": 101.0, "Low": 99.0, "Close": 100.5, "Volume": 10_000.0}, index=tdays)
d.fetch_twstock_institutional = lambda sid, start, end, h: pd.DataFrame({"foreign_net": 1_000_000.0}, index=tdays)
seen_kinds = {}
for pk in (T.tw_market_brief("2026-09-02", H, fresh=True),
           T.tw_close_brief("2026-09-01", H, fresh=True),
           T.crypto_market_brief("2026-09-02", H, fresh=True,
                                 extra=[["coin_snapshot", {"symbol": "BTC"}], ["relative_to", {"symbol": "ETH"}]]),
           T.symbol_brief("BTC", "2026-09-02", H, fresh=True, extra=[["liq_map", {"symbol": "BTC"}]]),
           T.symbol_brief("2330", "2026-09-02", H, fresh=True),
           B.build({"id": "kinds-x", "title": "圖型", "bricks": [["relative_perf", {"symbols": ["BTC", "ETH"]}],
                                                                ["funding", {"symbols": ["BTC", "ETH"]}]]}, "2026-09-02", H)):
    for o, ks in kinds_of(pk).items():
        seen_kinds.setdefault(o, set()).update(ks)
os.environ.pop("BLAVE_AGENT_LOCAL")
wrong = {o: sorted(ks) for o, ks in seen_kinds.items() if ks != {B.CHART_KIND.get(o)}}
unregistered = sorted(set(seen_kinds) - set(B.CHART_KIND))
check(not wrong and not unregistered and set(B.CHART_KIND) <= set(B.BRICKS),
      "圖型逐積木斷言:price_chart/coin_snapshot=K 線、tw_institutional/liquidation=bar、"
      "margin/futures/funding/indicators/relative=line;出圖的積木都登記在 CHART_KIND"
      + ("" if not wrong and not unregistered else f" — 不符 {wrong} 未登記 {unregistered}"))
check({"price_chart", "tw_institutional", "tw_margin", "tw_futures_inst", "funding", "blave_indicators",
       "liquidation", "coin_snapshot", "relative_to", "relative_perf"} <= set(seen_kinds),
      f"逐積木斷言真的蓋到每個會出圖的積木(蓋到 {len(seen_kinds)} 個):{sorted(seen_kinds)}")

# ── 爆倉地圖積木(契約 1.5 profile):50 桶、有號、est+refline 成對、版號 1.5 ──
lm = T.symbol_brief("BTC", "2026-09-02", H, fresh=True, extra=[["liq_map", {"symbol": "BTC"}]])
pf = [x for x, o in zip(lm.blocks, lm.owners) if o == "liq_map"][0]
bks = pf["buckets"]
check(pf["type"] == "bar_chart" and pf["variant"] == "profile" and len(bks) == B.LIQ_MAP_BUCKETS == 50
      and all(r["x0"] < r["x1"] for r in bks) and all(a["x1"] <= c["x0"] for a, c in zip(bks, bks[1:]))
      and not any("value" in r for r in bks)
      and pf["refline"] == {"x": 90000.0, "label": "90,000"} and pf["x_unit"] == "USDT" and pf["y_unit"] == "百萬 USD",
      "liq_map:bar_chart profile、50 桶、x0<x1 嚴格遞增不重疊、桶不帶 value、refline=現價、單位 USDT/百萬 USD")
straddle = [r for r in bks if r["x0"] <= 90000 < r["x1"]][0]
check(all(set(r) & {"pos", "neg"} == {"neg"} for r in bks if r["x1"] <= 90000)
      and all(set(r) & {"pos", "neg"} == {"pos"} for r in bks if r["x0"] > 90000)
      and straddle.get("neg") == 0.4 and straddle.get("pos") == 0.6
      and abs(sum(r.get("neg", 0.0) for r in bks) * 1e6 - 4e5 * 101) < 1e-3
      and abs(sum(r.get("pos", 0.0) for r in bks) * 1e6 - 2e5 * 99) < 1e-3,
      f"liq_map:pos=空單、neg=多單各自進欄位不淨額;跨界桶兩段都留({straddle});零的一邊省略欄位;兩邊合計不掉量")
try:
    T.bar_profile("t", [(1.0, 2.0, 3.0), (2.0, 3.0, 4.0)]); check(False, "value 列應被擋")
except ValueError as e:
    check("never netted" in str(e) or "netted shape" in str(e), "bar_profile:送舊的 (x0, x1, value) 三欄列被建構子擋")
try:
    T.bar_profile("t", [{"x0": 1.0, "x1": 2.0, "value": 3.0}, {"x0": 2.0, "x1": 3.0, "value": 4.0}]); check(False, "value dict 應被擋")
except ValueError as e:
    check("not value" in str(e), "bar_profile:dict 帶 value 也擋")
check(len(pf["est"]) == 50 and all(r["value"] >= 0 for r in pf["est"])
      and abs(sum(r["value"] for r in pf["est"]) * 1e6 - 1e6 * 200) < 1e-3   # 每桶原始值,不是累加(渲染端自己畫 cumsum)
      and [(r["x0"], r["x1"]) for r in pf["est"]] == [(r["x0"], r["x1"]) for r in bks]
      and "模型估計、非實際掛單" in pf["caption"] and "×3.3" in pf["caption"],
      "liq_map:est 每桶 ≥0、桶界跟 buckets 對齊;caption 標明模型估計與 ×3.3 口徑")
check("多單" in pf["title"] and "集中在" in pf["title"] and "80,000" in pf["title"],
      f"liq_map:結論式標題點出最集中價位帶與方向 — {pf['title']}")
d.fetch_liquidation_map = lambda sym, h: {"price": 90000.0, "labels": list(_LM_LABELS), "oi_value": [1e6] * 200,
    "liquidation": {"24h": {"buy_liq": [5e6 if 95200 <= l < 95600 else 0.0 for l in _LM_LABELS],
                            "sell_liq": [5.5e6 if 84800 <= l < 85200 else 0.0 for l in _LM_LABELS]}}}
two = T.symbol_brief("BTC", "2026-09-02", H, fresh=True, extra=[["liq_map", {"symbol": "BTC"}]])
tt = [x for x, o in zip(two.blocks, two.owners) if o == "liq_map"][0]["title"]
check(" 與 " in tt and tt.index("多單") < tt.index("空單") and "84,800" in tt and "95,200" in tt,
      f"liq_map:兩邊都重(次重 ≥ 最重八成)標題兩帶都寫、重的在前 — {tt}")
d.fetch_liquidation_map = lambda sym, h: {"price": 90000.0, "labels": list(_LM_LABELS),
    "oi_value": [1e6] * 200, "cumsum": [1e6] * 200,
    "liquidation": {"24h": {"buy_liq": [2e5 if l > 90000 else 0.0 for l in _LM_LABELS],
                            "sell_liq": [4e5 if l <= 90000 else 0.0 for l in _LM_LABELS]}}}
lmdoc = doc(T.publish(lm, {"lead": "槓桿退場,現貨撐盤。", "read": ["**甲**:1", "**乙**:2", "**丙**:3"],
                           "watch": [("條件", "門檻", "值"), ("乙", "門檻", "值")],
                           "summary": "去槓桿為主,接下來看資金費率。", "risk": "若槓桿重新堆高,這個判斷就不成立。",
                           "no_extra": "測試", "few_sources": "測試", "news": []}, title="槓桿退場,現貨撐盤"))
check(lmdoc["schema_version"] == "1.5" and any(x.get("variant") == "profile" for x in lmdoc["blocks"]),
      "liq_map 出現 → schema_version 1.5(契約:只在用到 profile 時標)")
check(doc(T.publish(T.symbol_brief("BTC", "2026-09-02", H, fresh=True)))["schema_version"] != "1.5",
      "沒有 profile 的報告不標 1.5(舊 api 照收)")
plainlm = T.symbol_brief("BTC", "2026-09-02", H, fresh=True)
check('[["liq_map", {"symbol": "BTC"}]]' in plainlm.describe() and "liq_map" not in
      T.symbol_brief("2330", "2026-09-02", H, fresh=True).describe(),
      "describe 候選:幣的單幣晨報/研究列爆倉地圖,台股個股不列")
d.fetch_liquidation_map = lambda sym, h: (_ for _ in ()).throw(d.DataAccessError("no access"))
nolm = T.symbol_brief("BTC", "2026-09-02", H, fresh=True, extra=[["liq_map", {"symbol": "BTC"}]])
check(not any(o == "liq_map" for o in nolm.owners) and any("爆倉地圖" in m["name"] for m in nolm.missing),
      "沒有資料權限:地圖那塊不出、記 missing,報告照發")
d.fetch_liquidation_map = lambda sym, h: {"price": 90000.0, "labels": list(_LM_LABELS), "oi_value": [1e6] * 200,
    "liquidation": {"24h": {"buy_liq": [0.0] * 200, "sell_liq": [0.0] * 200}}}
z = T.symbol_brief("BTC", "2026-09-02", H, fresh=True, extra=[["liq_map", {"symbol": "BTC"}]])
check(not any(o == "liq_map" for o in z.owners) and any("沒有爆倉" in n for n in z.notes),
      "近 24 小時沒有爆倉:不畫空圖,記 notes")

# fetch_liquidation_map:兩層欄位照原樣回來(渲染積木等設計定案,資料端先就緒)
asked = {}
real_snap = d._raw_snapshot
d._raw_snapshot = lambda ep, h, params=None, allow_404=False: (asked.update(ep=ep, params=params) or
    {"price": 84000.0, "labels": [80000.0, 84000.0, 88000.0], "oi_value": [1e6, 2e6, 3e6],
     "cumsum": [1e6, 3e6, 6e6], "liquidation": {"24h": {"buy_liq": [0.0, 0.0, 5e5], "sell_liq": [4e5, 0.0, 0.0]}}})
m = real_fetch_liq_map("btc", H)
check(asked == {"ep": "liquidation/get_map", "params": {"symbol": "BTCUSDT"}}
      and m["liquidation"]["24h"]["buy_liq"][2] == 5e5 and m["oi_value"][1] == 2e6 and len(m["labels"]) == 3,
      "fetch_liquidation_map:走 /liquidation/get_map、symbol 正規化成 BTCUSDT,已發生(24h buy/sell)與模型估計(oi_value/cumsum)兩層都在")
check("MODEL ESTIMATE" in real_fetch_liq_map.__doc__ and "HAPPENED" in real_fetch_liq_map.__doc__,
      "docstring 寫明哪層是已發生、哪層是模型估計(渲染端 caption 的依據)")
d._raw_snapshot = real_snap

# 稽核 B5:報告用的 fetcher 在上游壞掉時幾秒內放棄
import importlib, types
real = importlib.reload(__import__("lib.data", fromlist=["x"]))
slept = []
class _R:
    def __init__(self, code, retry=None):
        self.status_code, self.text, self.headers = code, "down", ({"Retry-After": str(retry)} if retry else {})
    def raise_for_status(self):
        import requests
        if self.status_code >= 400:
            raise requests.HTTPError(str(self.status_code), response=self)
    def json(self):
        return {}
real.time = types.SimpleNamespace(sleep=slept.append, time=__import__("time").time)
real.requests.get, _get = (lambda *a, **k: _R(503)), real.requests.get
try:
    real.fetch_news({"api-key": "k", "secret-key": "s"})
except Exception:
    pass
check(sum(slept) <= 10, f"fetch_news:鉅亨 503 時 {sum(slept)} 秒內放棄(原本 126 秒)")
del slept[:]
real.requests.get = lambda *a, **k: _R(429, retry=300)
try:
    real.fetch_binance_ticker_24h()
except Exception:
    pass
real.requests.get = _get
check(sum(slept) <= 5, f"Binance 24h:429 Retry-After 300 時不等({sum(slept)} 秒)")

# 複查追加
for adv in ("可以進場布局", "宜加碼", "現在是進場好時機", "趁回檔加碼", "應減碼"):
    refused(lambda adv=adv: pub(tw, {"no_extra": "測試:不加做", "few_sources": "測試", "news": [dict(ITEM, summary=f"營收創新高,{adv}。")]}), "reads as advice", f"摘要建議語氣「{adv}」")
check(os.path.exists(pub(tw, {"no_extra": "測試:不加做", "few_sources": "測試", "news": [dict(ITEM, summary="外資加碼台積電,連三日買超。")]}, report_id="factok")),
      "摘要「外資加碼台積電」是事實報導:放行")
pc2 = T.Pack("x", "x", "morning", "x", [T.footnote([("s", "口徑")])], {"外資": "+211.4 億"})
refused(lambda: pub(pc2, {"read": "- 外資買超達 211.9 億\n- 乙 1\n- 丙 2"}), "apart", "數字對帳:「達」後面的抄錯(211.9 對 211.4)仍擋")
refused(lambda: pub(pc2, {"read": "- 外資買超超過 211.9 億\n- 乙 1\n- 丙 2"}), "apart", "數字對帳:「超過」後面的抄錯仍擋")
d.fetch_news = lambda *a, **k: pd.DataFrame(columns=["id", "title", "published_at", "source", "tags", "stocks"])
only_news = B.build({"id": "my-news", "title": "新聞", "bricks": [["news", {"market": "tw"}]]}, "2026-09-02", H)
check(pub(only_news) is None and not os.path.exists(os.path.join(R.REPORTS_DIR, "my-news-20260902-auto.json")),
      "只放 news 的自組配方、排程時沒有候選:不發只剩 meta 的空報告")
try:
    pub(tw, {"no_extra": "測試:不加做", "few_sources": "測試", "news": [dict(ITEM, sources=[("x", "https://a.com/新聞")])]}); check(False, "非 ASCII 路徑")
except ValueError as e:
    check("percent-encoded" in str(e), "非 ASCII 路徑:錯誤訊息叫你先百分比編碼")

print("all checks passed" if not fails else f"FAILED: {fails}"); sys.exit(1 if fails else 0)
