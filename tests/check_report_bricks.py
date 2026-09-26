"""Minimal check for the 0.1.7 report layer — bricks, the news slot, publish()'s automatic
checks, lead_chart, W4 punctuation, custom recipes. No network, no api.
Run: cd blave-agent && .venv/bin/python tests/check_report_bricks.py
"""
import json, os, sys, tempfile
os.environ["BLAVE_AGENT_WORKSPACE"] = tempfile.mkdtemp(prefix="bricks-")
for k in ("BLAVE_DATA_ACCESS", "BLAVE_DATA_ACCESS_WHY", "BLAVE_AGENT_LOCAL", "BLAVE_SCHEDULED_RUN"):
    os.environ.pop(k, None)
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import numpy as np, pandas as pd
from lib import data as d
import lib.report_templates as T
import lib.report_bricks as B
from lib import report as R

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
d.fetch_twmarket_dividend_points = lambda s, e, h: pd.DataFrame({"points": [0.0], "estimated": [False]}, index=pd.to_datetime([s]))
d.fetch_twstock_dividend_batch = lambda ids, s, e, h: {}
H = {"api-key": "x", "secret-key": "y"}

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
b = doc(T.publish(tw, {"news": [ITEM, ITEM2, ITEM3]}, report_id="n1"))["blocks"]
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
auto = doc(T.publish(tw))["blocks"]
lic = [x for x in auto if x["type"] == "news" and x.get("title") == "Anue鉅亨"]
check(len(lic) == 1 and all("summary" not in i and "tag" not in i and i["channel"] == "licensed" for i in lic[0]["items"])
      and any("鉅亨網授權標題" in i["text"] for i in auto[-1]["items"]),
      "排程(無敘事):只放鉅亨授權標題,不帶摘要與標籤,尾註講明未經整理")
bad = lambda **kw: (lambda: T.publish(tw, {"news": [dict(ITEM, **kw)]}, report_id="nbad"))
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
refused(lambda: T.publish(tw, {"news": [ITEM, dict(ITEM2, sources=[("經濟日報", "https://money.udn.com/money/story/1")])]}), "repeats", "同一個 url 兩則")
refused(lambda: T.publish(tw, {"news": [ITEM, dict(ITEM2, title="台積電9月營收年增38%!")]}), "looks like item 0", "近似標題兩則")
refused(lambda: T.publish(tw, {"news": [dict(ITEM, title=f"標題{i}", sources=[("x", f"https://a.b/{i}")]) for i in range(6)]}), "needs 1–5", "超過 5 則")
lic_item = {"title": "鉅亨標題", "summary": "鉅亨報導的事件。", "tag": "neutral", "sources": [("Anue鉅亨", None)], "channel": "licensed", "published_at": NOW - 3600}
check(os.path.exists(T.publish(tw, {"news": [lic_item]}, report_id="nlic")), "describe() 的授權候選(channel=licensed)沒有連結也收")
crypto = T.crypto_market_brief("2026-09-02", H)
cb = doc(T.publish(crypto, {"lead": "BTC 現貨撐盤,槓桿正在退場。"}, report_id="c1"))["blocks"]
check(not any(x["type"] == "news" for x in cb) and any(i["id"] == "news" and "沒有附新聞" in i["text"] for i in cb[-1]["items"]),
      "加密晨報對話產出沒填新聞:不出 news block,尾註一句")
check(not any(i["id"] == "news" for i in doc(T.publish(crypto))["blocks"][-1]["items"]), "加密晨報排程:沒有新聞、也不多一行尾註")
sym = T.symbol_brief("BTC", "2026-09-02", H)
refused(lambda: T.publish(sym, {"news": [ITEM]}), "no news slot", "沒有 news 積木的配方填 news")

# ── R10 + W4 ──
refused(lambda: T.publish(sym, {"lead": "外資現貨與期貨同日轉多,量能放大六成,投信連三買,自營商也同步回補,這是資金回補而不是空窗反彈。"}), "cap 40", "lead 第一句超過 40 字")
refused(lambda: T.publish(sym, {"lead": "BTC 漲 3%、ETH 漲 5%、SOL 漲 7%,全面上攻。"}), "carries 3 numbers", "lead 第一句三個數字")
refused(lambda: T.publish(sym, {"lead": "+3.2%,-1.1%。"}), "only figures", "lead 第一句只有數字")
fund = sym.context["資金費率"].split("（")[0]                         # e.g. +0.1234%
v = float(fund.rstrip("%"))
near = f"{v * 1.01:+.4f}%" if abs(v) > 0.01 else None
if near:
    refused(lambda: T.publish(sym, {"read": f"- 資金費率 {near},偏高\n- 乙 1\n- 丙 2"}), "apart", f"數字對帳:{near} 對 describe() 的 {fund}(差 1%)")
check(os.path.exists(T.publish(sym, {"read": f"- 資金費率 {fund},偏高\n- 乙 1\n- 丙 2"}, report_id="r10ok")), "數字對帳:照抄 describe() 的值放行")
check(os.path.exists(T.publish(sym, {"read": f"- 資金費率 {v:+.2f}%,偏高\n- 乙 1\n- 丙 2"}, report_id="r10round")), "數字對帳:小數位數不同(進位)放行")
ctx = {"ETH": "+7.26%"}
p = T.Pack("x", "x", "morning", "x", [T.footnote([("s", "口徑")])], ctx)
refused(lambda: T.publish(p, {"read": "- ETH 漲 +7.36%\n- 乙 1\n- 丙 2"}), "1.38% apart", "數字對帳:spec 樣張 ETH +7.36% 對 +7.26%")
check(os.path.exists(T.publish(p, {"read": "- ETH 七日漲 +12.40%,是 BTC 的兩倍\n- 乙 1\n- 丙 2"}, report_id="r10new")), "數字對帳:差很多的新比較放行")
w = doc(T.publish(p, {"lead": "外資買超 267 億,20 日均賣超:見 `a,b:c`。", "risk": "外資連兩日淨賣超逾 150 億(推翻)"}, report_id="w4"))["blocks"]
check(w[1]["markdown"] == "外資買超 267 億，20 日均賣超：見 `a,b:c`。" and w[-2]["text"] == "外資連兩日淨賣超逾 150 億（推翻）",
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
check(os.path.exists(T.publish(pc, ok_nar, report_id="thr")), "數字對帳:watch 門檻欄、「跌破／逾」後面的門檻數字放行(845.0 對 848.1、46,000.00 對 46,616.24、210.0 對 211.4)")
refused(lambda: T.publish(pc, {"watch": [("融資餘額", "跌破 845.0 萬張", "848.9 萬張"), ("乙", "門檻", "值")]}), "apart", "數字對帳:watch 的現在值抄錯仍抓到")
refused(lambda: T.publish(pc, {"read": "- ETH 漲 +7.36%\n- 乙 1\n- 丙 2"}), "apart", "數字對帳:+7.36% 對 +7.26% 仍抓到")

# ── lead_chart ──
lb = doc(T.publish(tw, {"lead": "外資買超撐盤,期貨淨空單沒退。", "lead_chart": "tw_futures_inst"}, report_id="lc"))["blocks"]
ki = [x["type"] for x in lb].index("kpi_row")
check(lb[ki + 1]["type"] == "line_chart" and lb[ki + 1]["title"].startswith("外資期貨淨部位"), "lead_chart:指定的圖排到 KPI 列後面第一個")
refused(lambda: T.publish(tw, {"lead_chart": "nope"}), "lays out no chart", "lead_chart 指到不存在的積木")

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
check(bool(empty.skip) and T.publish(empty) is None, "沒有任何積木產出資料:skip,不送一份只剩空尾註的報告")
fn = T.footnote([])
check(not any(x["type"] == "footnote" for x in doc(T.publish(T.Pack("e", "e", "morning", "e", [T.kpi_row([T.kpi("a", "1")]), fn], {}), {"lead": "一句主張成立。"}))["blocks"]),
      "空的 footnote 不送出(api 會 400)")
refused(lambda: T.publish(tw, {"news": [dict(ITEM, symbols="2330")]}), "must be a list", "新聞 symbols 給字串")
refused(lambda: T.publish(tw, {"news": [dict(ITEM, published_at=float("nan"))]}), "finite unix time", "新聞時間 NaN")
refused(lambda: T.publish(tw, {"news": [dict(ITEM, sources=[("x", "https://good.com\\evil.com")])]}), "backslashes", "連結帶反斜線")
refused(lambda: T.publish(tw, {"news": [dict(ITEM, sources=[("x", "https://例子.com/a")])]}), "ASCII", "連結主機非 ASCII")

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
    refused(lambda adv=adv: T.publish(tw, {"news": [dict(ITEM, summary=f"營收創新高,{adv}。")]}), "reads as advice", f"摘要建議語氣「{adv}」")
check(os.path.exists(T.publish(tw, {"news": [dict(ITEM, summary="外資加碼台積電,連三日買超。")]}, report_id="factok")),
      "摘要「外資加碼台積電」是事實報導:放行")
pc2 = T.Pack("x", "x", "morning", "x", [T.footnote([("s", "口徑")])], {"外資": "+211.4 億"})
refused(lambda: T.publish(pc2, {"read": "- 外資買超達 211.9 億\n- 乙 1\n- 丙 2"}), "apart", "數字對帳:「達」後面的抄錯(211.9 對 211.4)仍擋")
refused(lambda: T.publish(pc2, {"read": "- 外資買超超過 211.9 億\n- 乙 1\n- 丙 2"}), "apart", "數字對帳:「超過」後面的抄錯仍擋")
d.fetch_news = lambda *a, **k: pd.DataFrame(columns=["id", "title", "published_at", "source", "tags", "stocks"])
only_news = B.build({"id": "my-news", "title": "新聞", "bricks": [["news", {"market": "tw"}]]}, "2026-09-02", H)
check(T.publish(only_news) is None and not os.path.exists(os.path.join(R.REPORTS_DIR, "my-news-20260902-auto.json")),
      "只放 news 的自組配方、排程時沒有候選:不發只剩 meta 的空報告")
try:
    T.publish(tw, {"news": [dict(ITEM, sources=[("x", "https://a.com/新聞")])]}); check(False, "非 ASCII 路徑")
except ValueError as e:
    check("percent-encoded" in str(e), "非 ASCII 路徑:錯誤訊息叫你先百分比編碼")

print("all checks passed" if not fails else f"FAILED: {fails}"); sys.exit(1 if fails else 0)
