"""Minimal check for lib/report_templates.py — no network, no api.
Builds every template from synthetic frames and asserts the structural rules the
api enforces (references/reports.md §6): meta first, lead right after meta, one
footnote last, known block types, finite numbers, narrative caps, price charts as
candlesticks (schema 1.2) and everything else as line charts.
Run: cd blave-agent && .venv/bin/python tests/check_report_templates.py
"""
import json, math, os, re, sys, tempfile
os.environ["BLAVE_AGENT_WORKSPACE"] = tempfile.mkdtemp(prefix="rpt-")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import numpy as np, pandas as pd
from lib import data as d
import lib.report_templates as T
_REAL_NOW_TPE = T._now_tpe
# 夜盤是否已收看「現在」;釘住時鐘,不讓結果跟著跑測試的時刻變。預設在合成資料的夜盤收完之後。
T._now_tpe = lambda: pd.Timestamp("2026-09-02 09:00", tz="Asia/Taipei").to_pydatetime()

KNOWN = {"meta", "kpi_row", "line_chart", "candlestick", "drawdown", "heatmap", "bar_chart", "histogram", "box",
         "scatter", "metric_table", "table", "text", "quote", "footnote", "code", "divider", "callout", "image"}
days = pd.bdate_range("2026-06-01", "2026-09-01"); n = len(days); rng = np.random.default_rng(1)
walk = lambda base, vol: pd.Series(base * np.cumprod(1 + rng.normal(0, vol, n)), index=days)
def ohlc(close):
    """Coherent bars around a close series: open = previous close, wicks outside both."""
    o = close.shift(1).fillna(close.iloc[0]); wick = 1 + np.abs(rng.normal(0, .003, len(close)))
    return pd.DataFrame({"Open": o, "High": np.maximum(o, close) * wick, "Low": np.minimum(o, close) / wick, "Close": close})
d.fetch_twmarket_index = lambda s, e, h: ohlc(walk(45000, .01))
d.fetch_twmarket_turnover = lambda s, e, h: pd.DataFrame({"volume": walk(8e9, .1), "value": walk(9e11, .15), "trades": walk(2e6, .1)})
d.fetch_twmarket_institutional = lambda s, e, h: pd.DataFrame({"foreign": rng.normal(0, 2e10, n), "investment_trust": rng.normal(0, 5e9, n), "dealer": rng.normal(0, 5e9, n)}, index=days).assign(total=lambda x: x.sum(axis=1))
d.fetch_twmarket_margin = lambda s, e, h: pd.DataFrame({"margin_balance": walk(8.8e6, .005), "margin_balance_prev": walk(8.8e6, .005), "margin_balance_value": walk(3e11, .005), "short_balance": walk(3e5, .01), "short_balance_prev": walk(3e5, .01)})
d.fetch_twfutures_institutional = lambda fid, s, e, h: pd.DataFrame({"foreign_net_oi": rng.normal(-70000, 3000, n).round()}, index=days)
hours = pd.date_range("2026-08-27 00:00", "2026-09-02 05:00", freq="60min", tz="Asia/Taipei")
hours = hours[((hours.hour >= 8) & (hours.hour < 14)) | (hours.hour >= 15) | (hours.hour <= 5)]
d.fetch_twfutures_ohlcv = lambda sym, sch, s, e, h: pd.DataFrame({"Open": 46800., "High": 46900., "Low": 46700., "Close": 46800 + rng.normal(0, 50, len(hours)), "Volume": 100}, index=hours.tz_convert("UTC"))
d.fetch_economic_calendar = lambda h, **k: pd.DataFrame([{"date": "2026-09-02", "time": "20:30", "country": "US", "country_name": "美國", "subject": "非農就業", "subject_title": "<8月>", "predict": 150, "last": 142, "real": None, "unit": "千人", "priority": 1}])
udays = pd.date_range("2026-06-01", "2026-09-02", freq="D", tz="UTC")   # ≈ the 90-day crypto window
kl = lambda base: ohlc(pd.Series(base * np.cumprod(1 + rng.normal(0, .03, len(udays))), index=udays)).assign(Volume=1.0)
d.fetch_kline_batch = lambda syms, i, s, e, h: {x: kl(70000) for x in syms}
d.fetch_kline = lambda sym, i, s, e, h: kl(70000)
alpha = lambda scale: (lambda *a, **k: pd.DataFrame({"alpha": rng.normal(0, scale, len(udays) - 1)}, index=udays[:-1]))
for fn in ("fetch_funding_rate", "fetch_market_direction", "fetch_capital_shortage", "fetch_top_trader_exposure", "fetch_liquidation", "fetch_whale_hunter", "fetch_taker_intensity"):
    setattr(d, fn, alpha(0.01 if fn == "fetch_funding_rate" else 1.0))
tw = ohlc(walk(900, .02)).assign(Volume=walk(30000, .3)); tw.index = tw.index.tz_localize("Asia/Taipei")
d.fetch_twstock_ohlcv = lambda sid, sch, h, start=None, end=None, adjust=False: tw
d.fetch_twstock_institutional = lambda sid, s, e, h: pd.DataFrame({"foreign_net": rng.normal(0, 5e6, n)}, index=days)
HOL = pd.DataFrame({"date": pd.to_datetime(["2026-09-02"]), "name": ["測試休市"], "type": ["holiday"], "note": [None]})
HOL_SRC = "臺灣證券交易所 2026 年有價證券集中交易市場開（休）市日期（測試出處全文）；https://data.gov.tw/license"
HOL.attrs = {"source_zh": HOL_SRC, "source": "Taiwan Stock Exchange, 2026 (test)"}
d.fetch_twstock_holidays = lambda h, year=None: HOL

H = {"api-key": "x", "secret-key": "y"}
NAR = {"lead": "一句可證偽的主張。",
       "read": "- 外資買超 267 億,20 日均為 −40 億。\n- 投信買超 131 億,連三日。\n- 自營買超 163 億。",
       "watch": [("外資期貨淨多單", "回落到 1 萬口以下", "+12,300 口"),
                 ("外資現貨買超", "轉為連兩日淨賣超", "+267.0 億")],
       "risk": "外資連兩日淨賣超逾 150 億,這份解讀作廢。"}
# name → (title of the one price chart, or None; line_chart titles that must stay line charts)
PRICE = {"tw": ("加權指數", {"融資餘額", "外資期貨淨多單"}), "close": ("加權指數", {"融資餘額", "外資期貨淨多單"}),
         "crypto": (None, {"BTC 資金費率", "Blave 市場指標(z-score)"}),
         "2330": ("2330 日 K", set()), "btc": ("BTC 日 K", {"資金費率", "Blave 指標(z-score)"})}
fails = 0
def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg); fails += (not cond)

def walk_numbers(o):
    if isinstance(o, float): yield o
    elif isinstance(o, dict):
        for v in o.values(): yield from walk_numbers(v)
    elif isinstance(o, list):
        for v in o: yield from walk_numbers(v)

def sound(k):
    return all(c[3] <= min(c[1], c[4]) and max(c[1], c[4]) <= c[2] for c in k["candles"]) and \
        all(a[0] < z[0] and isinstance(a[0], int) for a, z in zip(k["candles"], k["candles"][1:]))

for name, pack in (("tw", T.tw_market_brief("2026-09-02", H)), ("close", T.tw_close_brief("2026-09-01", H)),
                   ("crypto", T.crypto_market_brief("2026-09-02", H)),
                   ("2330", T.symbol_brief("2330", "2026-09-02", H)), ("btc", T.symbol_brief("BTC", "2026-09-02", H))):
    for nar in (NAR, None):
        path = T.publish(pack, nar)
        check(os.path.basename(path) == pack.report_id + ("" if nar else "-auto") + ".json", f"{name}: {'有判讀' if nar else '純數據包'} id = {os.path.basename(path)[:-5]}")
        doc = json.load(open(path)); b = doc["blocks"]; types = [x["type"] for x in b]
        tag = f"{name}{'+narrative' if nar else ' data-only'}"
        check(types[0] == "meta" and types.count("meta") == 1, f"{tag}: meta 唯一且第一")
        check(types[-1] == "footnote" and types.count("footnote") == 1, f"{tag}: footnote 唯一且最後")
        check(set(types) <= KNOWN, f"{tag}: 只用契約有的 block 型別")
        leads = [i for i, x in enumerate(b) if x.get("variant") == "lead"]
        check(leads == ([1] if nar else []), f"{tag}: lead 只在 meta 之後(或無)")
        check(all(math.isfinite(v) for v in walk_numbers(doc)), f"{tag}: 數字全部有限")
        check(b[0].get("origin") == ("chat" if nar else "scheduled"), f"{tag}: origin={'chat' if nar else 'scheduled'}")
        check(all(x.get("type") == "kpi_row" and 1 <= len(x["items"]) <= 6 for x in b if x["type"] == "kpi_row"), f"{tag}: kpi_row 1–6 格")
        check(all(sum(s["role"] == "primary" for s in x["series"]) <= 1 for x in b if x["type"] == "line_chart"), f"{tag}: line_chart 最多一條 primary")
        # 每個圖表/表格都要有 caption,而且是比較基準不是把圖上的數字再念一遍(§7b A3);
        # kpi_row 的 title 是當日結論句——排程的純數據包沒有 lead,那行是唯一的結論。
        vis = [x for x in b if x["type"] in ("candlestick", "line_chart", "bar_chart", "table")]
        check(vis and all(0 < len(x.get("caption", "")) <= 300 for x in vis), f"{tag}: 每個圖表/表格都有 caption(≤300)")
        kr = [x for x in b if x["type"] == "kpi_row"][0]
        check(any(w in kr.get("title", "") for w in ("高於", "低於")), f"{tag}: kpi_row title 帶當日漲跌對基準的位置:{kr.get('title')}")
        pos = pack.context.get("收盤位置", "")
        check(bool(pos) and pos.split(",")[0] in kr.get("title", ""), f"{tag}: describe() 的收盤位置與 kpi_row title 同一句(agent 引用得到,不會自己再算一次)")
        price, lines = PRICE[name]
        ks = [x for x in b if x["type"] == "candlestick"]
        if price:
            n_k = len(ks[0]["candles"]) if ks else 0
            # title 帶當日結論(「{圖名}:收盤高於 60 日均 X%」),所以認前綴不認全等。
            check(len(ks) == 1 and ks[0]["title"].startswith(price) and n_k == 60, f"{tag}: 價格圖「{price}」是 K 線,{n_k} 根(範本統一 60 根,日 K 建議 40–65)")
            check(any(w in ks[0]["title"] for w in ("高於", "低於")) and "60 日均" in ks[0]["caption"],
                  f"{tag}: 價格圖 title 帶收盤對 60 日均的位置,caption 留口徑與基準值:{ks[0]['title']}")
            ma = re.search(r"60 日均 ([\d,.]+)", ks[0]["caption"])
            check(pos.split(",")[-1] in ks[0]["title"] and ma is not None and ma.group(1) in pack.describe(),
                  f"{tag}: 價格圖 title / caption 的 60 日均與 describe() 同一句同一個值")
            check(all(sound(k) and {"y_unit", "reflines"} <= set(k) for k in ks), f"{tag}: K 線高低包住開收、t 嚴格遞增,帶單位與 20 日參考線")
            check(all(not r["emphasis"] for k in ks for r in k.get("reflines", [])), f"{tag}: 參考線都不強調(強調低點讀起來像標支撐)")
            check(doc["schema_version"] == "1.2", f"{tag}: 含 K 線 → schema_version 1.2")
            ref = {r["label"]: r["y"] for r in (ks[0].get("reflines", []) if ks else [])}
            prior = ks[0]["candles"][-21:-1] if ks else []   # 倒數第 2–21 根,不含當日
            want = {"前 20 日高": max(k[2] for k in prior), "前 20 日低": min(k[3] for k in prior)} if prior else {}
            if name in ("tw", "close"):
                want.pop("前 20 日低", None)   # 大盤晨報、收盤報告只畫前 20 日高
            check(bool(want) and ref == want,
                  f"{tag}: 參考線恰為 {sorted(want)},值 = 倒數第 2–21 根的最高價/最低價")
            levels = {r["level"]: r["price"] for x in b if x["type"] == "table" and x.get("title") == "近期高低與均線" for r in x["rows"]}
            check(bool(want) and all(f"{k} {v:,.2f}" in pack.describe() for k, v in want.items())
                  and (name in ("tw", "close") or all(levels.get(k) == f"{v:,.2f}" for k, v in want.items())),
                  f"{tag}: 參考線、近期高低與均線表、describe() 的前 20 日高/低同名同值")
        else:
            check(not ks and doc["schema_version"] == "1.1", f"{tag}: 沒有 K 線 → 維持 1.1")
        check(not re.search(r"(?<!前 )20 日[高低]", json.dumps(doc, ensure_ascii=False) + pack.describe()),
              f"{tag}: 沒有不帶「前」的 20 日高/低標籤(同名不同口徑)")
        body = json.dumps(doc, ensure_ascii=False) + pack.describe()
        # 站上/跌破/守住/失守 沒有「支撐」兩個字,但把統計值講成地板或天花板,一樣是 §1b 禁的。
        check(not re.search("操作建議|支撐|壓力|關鍵價位|站上|跌破|守住|失守", body.replace("非支撐壓力", "")),
              f"{tag}: 範本不自帶操作建議/支撐壓力/站上跌破字眼")
        # watch 是表格不是散文槽:整寬的「條件 / 門檻 / 現在值」三欄,key 為 ASCII、不帶 format(現在值的 + 號不該被上色)。
        wt = [x for x in b if x["type"] == "table" and x.get("title") == "觀察重點"]
        check(len(wt) == bool(nar) and "## 觀察重點" not in body and (not nar or (
              [c["label"] for c in wt[0]["columns"]] == ["條件", "門檻", "現在值"]
              and all(c["key"].isascii() and "format" not in c for c in wt[0]["columns"])
              and 2 <= len(wt[0]["rows"]) <= 3
              and all(set(r) == {"cond", "threshold", "now"} for r in wt[0]["rows"]))),
              f"{tag}: watch 是「觀察重點」表格(條件/門檻/現在值 2–3 列),不是散文段")
        titles = {x.get("title") for x in b if x["type"] == "line_chart"}
        check(lines <= titles and not any("收盤" in (t or "") for t in titles), f"{tag}: 非價格圖仍是 line_chart,沒有收盤折線")
    check(pack.context and "narrative slots" in pack.describe(), f"{name}: describe() 列出數字與槽位")

d.fetch_twstock_ohlcv = lambda sid, sch, h, start=None, end=None, adjust=False: tw.tail(15)
p = T.symbol_brief("2330", "2026-09-02", H)
kb = [x for x in p.blocks if x["type"] == "candlestick"]
check(all(not x.get("title") for x in p.blocks if x["type"] == "kpi_row"),
      "日 K 不足 21 根:kpi_row 不下標題(只有漲跌、沒有基準的一句是裝飾)")
check(len(kb) == 1 and "reflines" not in kb[0] and any("不足 21 根" in x for x in p.notes)
      and "前 20 日" not in "".join(p.context.values())
      and all(not r["level"].startswith("前 20 日") for x in p.blocks if x["type"] == "table" for r in x["rows"]),
      "日 K 不足 21 根:不畫前 20 日高/低、記 notes,不拿較短的窗口頂替")
d.fetch_twstock_ohlcv = lambda sid, sch, h, start=None, end=None, adjust=False: tw

idx = pd.date_range("2026-01-01", periods=4, freq="D", tz="UTC")
bad = pd.DataFrame({"Open": [10., 10., 10., 10.], "High": [11., 9.5, 11., 11.], "Low": [9., 9., 9., 9.], "Close": [10.5, 9.2, np.nan, 10.2]}, index=idx)
ck = T.candlestick("x", bad)
check(ck is not None and [k[0] for k in ck["candles"]] == [T._ts(idx[0]), T._ts(idx[3])], "candlestick 丟掉 NaN 與開盤高於最高的那根(lib.data 只擋 high<low)")
check(T.candlestick("x", bad.iloc[:2]) is None, "candlestick 剩不到 2 根 → None(不產一張畫不出來的圖)")
long = ohlc(pd.Series(100 * np.cumprod(1 + rng.normal(0, .01, 150)), index=pd.date_range("2026-01-01", periods=150, freq="D", tz="UTC")))
ck = T.candlestick("x", long)
check(len(ck["candles"]) == 120 and ck["candles"][-1][0] == T._ts(long.index[-1]), "candlestick 超過 120 根只留最後 120 根")
try:
    T.kpi_row([T.kpi(str(i), "1") for i in range(7)]); check(False, "kpi_row 超過 6 格要 raise,不靜默砍")
except ValueError:
    check(True, "kpi_row 超過 6 格要 raise,不靜默砍")
check(len([b for b in json.load(open(T.publish(T.tw_market_brief("2026-09-02", H), None, report_id="tw-k")))["blocks"] if b["type"] == "kpi_row"][0]["items"]) == 6
      and any(i["label"] == "台指期夜盤" for i in json.load(open(os.path.join(os.environ["BLAVE_AGENT_WORKSPACE"], "reports", "tw-k.json")))["blocks"][1]["items"]),
      "台股晨報六格 KPI 含台指期夜盤")
p = T.tw_market_brief("2026-09-02", H)
check(p.context["台指期夜盤"].split("(")[1].startswith("收盤;") and "最新價" not in json.dumps(p.blocks, ensure_ascii=False),
      "夜盤已收(05:00 後、最後一根在):describe 寫收盤,footnote 不帶盤中說明")
full_night = d.fetch_twfutures_ohlcv

def night_case(last_bar, now, label, why):
    """夜盤資料只到 last_bar(bar 起始時間)、現在是 now:KPI label 恰為 label,describe 同一句,不寫收盤,footnote 講最新價。"""
    bars = hours[hours <= pd.Timestamp(last_bar, tz="Asia/Taipei")]
    d.fetch_twfutures_ohlcv = lambda sym, sch, s, e, h: pd.DataFrame({"Open": 46800., "High": 46900., "Low": 46700., "Close": 46800., "Volume": 100}, index=bars.tz_convert("UTC"))
    T._now_tpe = lambda: pd.Timestamp(now, tz="Asia/Taipei").to_pydatetime()
    p = T.tw_market_brief("2026-09-02", H)
    items = [x for x in p.blocks if x["type"] == "kpi_row"][0]["items"]
    state = label[len("台指期夜盤("):-1]
    foot = json.dumps([x for x in p.blocks if x["type"] == "footnote"], ensure_ascii=False)
    check(any(i["label"] == label for i in items) and p.context["台指期夜盤"].split("(")[1].startswith(state + ";")
          and "尚未收盤" not in foot and "不是收盤價" in foot, why)

night_case("2026-09-01 21:00", "2026-09-01 22:30", "台指期夜盤(盤中,截至 22:00)", "夜盤盤中、api 已丟未收那根:標「盤中,截至 22:00」")
night_case("2026-09-01 22:00", "2026-09-01 22:30", "台指期夜盤(盤中,截至 22:30)", "夜盤盤中、export 留著未收那根:時點取現在「截至 22:30」")
night_case("2026-09-02 02:00", "2026-09-02 09:00", "台指期夜盤(截至 03:00,資料未含收盤)", "05:00 後資料缺尾:不標收盤,label 與 footnote 不自相矛盾")
d.fetch_twfutures_ohlcv = full_night
T._now_tpe = lambda: pd.Timestamp("2026-09-02 09:00", tz="Asia/Taipei").to_pydatetime()

# ── 台股收盤報告:id / 夜盤 / 不發佈 / 法人未出 ──
REPORTS = os.path.join(os.environ["BLAVE_AGENT_WORKSPACE"], "reports")
def unwritten(rid):
    return not any(os.path.exists(os.path.join(REPORTS, rid + s + ".json")) for s in ("", "-auto"))
def skipped(p, why, *must):
    ok = bool(p.skip) and not p.blocks and all(m in p.skip for m in must) and p.skip in p.notes and "不發佈" in p.describe()
    check(ok and T.publish(p, NAR) is None and T.publish(p) is None and unwritten(p.report_id), why)

p = T.tw_close_brief("2026-09-01", H)
check(p.report_id == "tw-close-20260901" and p.title == "台股收盤報告" and p.type == "morning" and p.skip is None,
      "收盤報告:id tw-close-YYYYMMDD、標題台股收盤報告、type morning")
check("夜盤" not in json.dumps(p.blocks, ensure_ascii=False) + p.describe(), "收盤報告不含夜盤")
p = T.tw_close_brief("2026-09-02", H)
skipped(p, "休市表列為休市:不發佈,notes 講休市名稱、上一交易日,並附休市表出處全文", "測試休市", "上一交易日 2026-09-01", HOL_SRC)
check(p.context.get("休市表出處") == HOL_SRC and HOL_SRC in p.describe(), "休市表出處全文進 context 與 describe()(授權條件)")
d.fetch_twstock_holidays = lambda h, year=None: (_ for _ in ()).throw(AssertionError("週末不該查休市表"))
skipped(T.tw_close_brief("2026-09-05", H), "週六:不查休市表就不發佈,指名上一交易日", "週末", "2026-09-01")
d.fetch_twstock_holidays = lambda h, year=None: HOL
skipped(T.tw_close_brief("2026-09-03", H), "交易日但指數還沒有當日收盤(未入庫或臨時停市):不拿舊收盤充當今日", "尚未入庫", "2026-09-01")
d.fetch_twstock_holidays = lambda h, year=None: None
skipped(T.tw_close_brief("2026-09-02", H), "休市表拿不到、當日無收盤:不發佈", "尚未入庫")
p = T.tw_close_brief("2026-09-01", H)
check(p.skip is None and any("休市表無法取得" in x for x in p.notes) and os.path.exists(T.publish(p, NAR)),
      "休市表拿不到但當日有收盤:照發,notes 說明改用收盤資料判斷")
d.fetch_twstock_holidays = lambda h, year=None: HOL

full = {k: getattr(d, k) for k in ("fetch_twmarket_institutional", "fetch_twmarket_margin", "fetch_twfutures_institutional", "fetch_twmarket_turnover")}
d.fetch_twmarket_institutional = lambda s, e, h: full["fetch_twmarket_institutional"](s, e, h).iloc[:-1]
d.fetch_twmarket_margin = lambda s, e, h: full["fetch_twmarket_margin"](s, e, h).iloc[:-1]
d.fetch_twfutures_institutional = lambda fid, s, e, h: full["fetch_twfutures_institutional"](fid, s, e, h).iloc[:-1]
p = T.tw_close_brief("2026-09-01", H)
labels = [i["label"] for x in p.blocks if x["type"] == "kpi_row" for i in x["items"]]
body = json.dumps([x for x in p.blocks if x["type"] != "footnote"], ensure_ascii=False)   # 註腳的來源說明本來就列這些名稱
check(p.skip is None and labels == ["加權指數", "成交值"] and "三大法人" not in body and "融資餘額" not in body
      and "外資期貨淨多單" not in body and "08/31" not in body and "08-31" not in body
      and all(any(x.startswith(f"{k} 2026-09-01 尚未公布(資料源最新為 2026-08-31)") for x in p.notes) for k in ("三大法人", "融資餘額", "外資期貨淨多單")),
      "法人、融資、期貨法人當日未出:notes 寫尚未公布,區塊與 KPI 都不放前一日的數字")
for k, fn in full.items():
    setattr(d, k, fn)

p = T.tw_close_brief("2026-9-1", H)
check(p.report_id == "tw-close-20260901" and p.skip is None, "「2026-9-1」正規化成 2026-09-01:照發,不被逐字比對誤判成未入庫")
p = T.tw_close_brief(pd.Timestamp("2026-08-31 17:00", tz="UTC"), H)
check(p.report_id == "tw-close-20260901" and p.skip is None, "帶時區的 UTC 時間先換成台北日期(UTC 8/31 17:00 = 台北 9/1)")
for bad in ("9/1", "2026/09/01", "20260901"):
    try:
        T.tw_close_brief(bad, H); check(False, f"日期「{bad}」要明確拒絕,不能靜默 skip")
    except ValueError:
        check(True, f"日期「{bad}」明確拒絕(ValueError),不靜默 skip")

# 台北日期:機器時鐘是 UTC、時間落在 UTC 午夜前,台北已是隔天。改成 UTC 或拿掉 +8 都會拿到 9/11。
from datetime import datetime as _RealDT, timezone as _tz
_UTC_NOW = _RealDT(2026, 9, 11, 17, 30, tzinfo=_tz.utc)   # = 台北 2026-09-12 01:30
class _ClockDT(_RealDT):
    @classmethod
    def now(cls, tz=None):
        return _UTC_NOW.astimezone(tz) if tz else _UTC_NOW.replace(tzinfo=None)
    @classmethod
    def utcnow(cls):
        return _UTC_NOW.replace(tzinfo=None)
T.datetime, T._now_tpe = _ClockDT, _REAL_NOW_TPE
p = T.tw_close_brief(headers=H)
check(T._today_tpe() == "2026-09-12" and p.report_id == "tw-close-20260912",
      "預設日期取台北(UTC 9/11 17:30 → tw-close-20260912),不是機器的 UTC 日期")
T.datetime = _RealDT
T._now_tpe = lambda: pd.Timestamp("2026-09-02 09:00", tz="Asia/Taipei").to_pydatetime()
# ── 敘事上限與形式 ──
desc = pack.describe()
check((T.SLOTS["lead"][1], T.SLOTS["read"][1], T.SLOTS["risk"][1], T.SLOTS["watch"][1]) == (600, 300, 100, None),
      "敘事上限 lead 600 / read 300 / risk 100,watch 無字數上限(改為表格)")
check("lead≤600" in desc and "read≤300" in desc and "risk≤100" in desc
      and "watch=表格 2–3 列(條件/門檻/現在值)" in desc and "2400" not in desc and "1500" not in desc,
      "describe() 的 narrative slots 那行印出新上限與 watch 的表格形式")
ok3 = dict(NAR, read="### 外資買超集中電子權值 x\n內文一句。\n### 投信連三買 y\n內文一句。\n### 自營轉多 z\n內文一句。")
check(os.path.exists(T.publish(pack, ok3, report_id="read-heads")), "read 寫成三個 ### 子標:接受")
# 條數是範圍 3–5 不是定值:兩端都要驗,否則「放寬」只是把定值從 3 搬到別的數字。
ok5 = dict(NAR, read="- 甲 1\n- 乙 2\n- 丙 3\n- 丁 4\n- 戊 5")
check(os.path.exists(T.publish(pack, ok5, report_id="read-five")), "read 寫成五條:接受(上界)")
# 訊息本身也是契約:agent 看到的是這一行,不是這份文件——超了多少、該改成什麼形式都要講。
for bad, why, must in (({"lead": "x" * 601}, "lead 超過 600", "cap 600 (over by 1)"),
                       ({"read": "- 甲 1\n- 乙 2\n- 丙 3" + "x" * 300}, "read 超過 300", "cap 300 (over by"),
                       ({"read": "一段沒有小標也沒有條列的散文,講了很多但沒有把手。"}, "read 寫成散文", "3–5 items"),
                       ({"read": "- 甲 1\n- 乙 2"}, "read 只有兩條", "2 條"),
                       ({"read": "- 甲 1\n- 乙 2\n- 丙 3\n- 丁 4\n- 戊 5\n- 己 6"}, "read 六條", "6 條"),
                       ({"read": "### 甲 1\n- 乙 2\n- 丙 3\n- 丁 4"}, "read 混用子標與條列", "1 個 ### 子標"),
                       ({"risk": "x" * 101}, "risk 超過 100", "cap 100 (over by 1)"),
                       ({"watch": "觀察條件。"}, "watch 仍寫成散文", "is a table now, not prose"),
                       ({"watch": [("甲", "門檻", "現在值")]}, "watch 只有一列", "1 row(s), needs 2–3"),
                       ({"watch": [("甲", "門檻", "值")] * 4}, "watch 超過三列", "4 row(s), needs 2–3"),
                       ({"watch": [("甲", "門檻", "值"), ("乙", "門檻")]}, "watch 某列不是三格", "must be 3 strings"),
                       ({"watch": [("甲", "門檻", ""), ("乙", "門檻", "值")]}, "watch 某格是空的", "「現在值」是空的"),
                       ({"watch": [("甲", "門檻", "x" * 41), ("乙", "門檻", "值")]}, f"watch 某格超過 {T.WATCH_CELL} 字", "上限 40(超出 1)"),
                       ({"summary": "x"}, "未知槽位", "unknown narrative slot"),
                       ({"action": "x"}, "舊的 action 槽位", "renamed to 'watch'"),
                       ({"read": "- 見 [^nope]\n- 乙 2\n- 丙 3"}, "不存在的註腳引用", "footnote id(s) ['nope']"),
                       ({"watch": [("見 [^nope]", "門檻", "值"), ("乙", "門檻", "值")]}, "watch 格內不存在的註腳引用", "footnote id(s) ['nope']")):
    try:
        T.publish(pack, dict(NAR, **bad) if set(bad) <= set(T.SLOTS) else bad); check(False, f"publish 拒絕{why}")
    except ValueError as e:
        check(must in str(e), f"publish 拒絕{why},訊息帶「{must}」")

# ── 沒有 Blave 資料權限(電腦版 BLAVE_DATA_ACCESS=0):降級不失敗 ──
# Wei 2026-09-26:沒綁卡、沒登入也要能用;缺 Blave 資料照樣 publish,缺的寫在尾註。
PAID = ("fetch_twstock_price", "fetch_funding_rate", "fetch_market_direction", "fetch_capital_shortage", "fetch_top_trader_exposure",
        "fetch_liquidation", "fetch_whale_hunter", "fetch_taker_intensity", "fetch_economic_calendar",
        "fetch_twmarket_index", "fetch_twstock_ohlcv", "fetch_twstock_institutional", "fetch_twstock_holidays")
saved = {k: getattr(d, k) for k in PAID}
gate = lambda *a, **k: d._check_data_access()          # 真的那道閘:env=0 就 raise DataAccessError
for k in PAID:
    setattr(d, k, gate)
free_tw = pd.DataFrame({"Open": tw["Open"].values, "High": tw["High"].values, "Low": tw["Low"].values,
                        "Close": tw["Close"].values, "Volume": tw["Volume"].values * 1000}, index=tw.index.tz_localize(None))
free_tw.attrs["source"] = "TWSE"
d.fetch_twstock_price = lambda sid, s, e, h: free_tw
os.environ["BLAVE_DATA_ACCESS"] = "0"
os.environ["BLAVE_DATA_ACCESS_WHY"] = "no_card"

def no_access_case(name, pack, names, nar, lang="zh"):
    path = T.publish(pack, nar, lang=lang)
    doc = json.load(open(path)); b = doc["blocks"]; types = [x["type"] for x in b]
    foots = [x for x in b if x["type"] == "footnote"]
    item = [i for i in foots[0]["items"] if i["id"] == "blave"] if foots else []
    txt = item[0]["text"] if item else ""
    expect = ("No Blave data in this report" if lang == "en" else "這份沒有 Blave 資料") 
    check(pack.skip is None and os.path.exists(path) and types[-1] == "footnote" and types.count("footnote") == 1
          and all(math.isfinite(v) for v in walk_numbers(doc))
          and [m["name"] for m in pack.missing] == list(names) and all(m["reason"] == "no_data_access" for m in pack.missing)
          and len(item) == 1 and txt.startswith(expect) and all(n in txt for n in names) and "14" in txt
          and "無 Blave 資料權限(no_data_access)" in pack.describe() and "不要因此不產報告" in pack.describe(),
          f"{name}(access=0,{'有判讀' if nar else '純數據包'},{lang}):仍 publish、missing={list(names)}、尾註列缺的資料;describe 叫 agent 照樣發")
    return b

crypto_missing = ("BTC 資金費率", "市場方向", "資金稀缺", "頂尖交易員曝險", "今日總經事件")
p = T.crypto_market_brief("2026-09-02", H)
b = no_access_case("加密市場晨報", p, crypto_missing, NAR)
no_access_case("加密市場晨報", p, crypto_missing, None)
check([x["type"] for x in b if x["type"] in ("line_chart", "table")] and not any("Blave 市場指標" in (x.get("title") or "") for x in b)
      and [i["label"] for x in b if x["type"] == "kpi_row" for i in x["items"]] == ["BTC", "ETH"],
      "加密市場晨報(access=0):價格、相對表現、報價表照出(Binance 公開 K 線),Blave 指標的 KPI 與圖都不在")
foots = [x for x in b if x["type"] == "footnote"][0]["items"]
check([i["id"] for i in foots].count("blave") == 1 and len([i for i in p.blocks[-1]["items"] if i["id"] == "blave"]) == 0,
      "同一個 pack 發兩次:尾註那行只有一行,pack 自己的 footnote 沒被改到")
no_access_case("BTC 晨報", T.symbol_brief("BTC", "2026-09-02", H), ("資金費率", "爆倉指標", "巨鯨警報", "多空力道"), NAR)
p = T.symbol_brief("2330", "2026-09-02", H)
b = no_access_case("2330 晨報", p, ("外資買賣超",), NAR)
ks = [x for x in b if x["type"] == "candlestick"]
vol = [i for x in b if x["type"] == "kpi_row" for i in x["items"] if i["label"] == "成交量"][0]["value"]
src_txt = [i["text"] for i in b[-1]["items"] if i["id"] == "src"][0]
check(len(ks) == 1 and len(ks[0]["candles"]) == 60 and ks[0]["candles"][-1][0] == T._ts(tw.index[-1]) and vol == T._num(float(tw["Volume"].iloc[-1]))
      and any(i["text"] == d._TW_PUBLIC_SOURCE_ZH for i in b[-1]["items"]) and "TWSE 未還原價" not in src_txt,
      "2330 晨報(access=0):日 K 改走免費日線(股→張、台北時區同 ohlcv 路徑),尾註帶交易所顯名(lib.data 常數),src 行不再說 TWSE")
b = no_access_case("2330 晨報", T.symbol_brief("2330", "2026-09-02", H), ("外資買賣超",), None, lang="en")
check(any(i["text"] == d._TW_PUBLIC_SOURCE_EN for i in b[-1]["items"]) and not any(i["text"] == d._TW_PUBLIC_SOURCE_ZH for i in b[-1]["items"]),
      "lang=en:顯名換成英文常數")
src_txt = [i["text"] for x in b if x["type"] == "footnote" for i in x["items"] if i["id"] == "src"]
bb = json.load(open(T.publish(T.symbol_brief("BTC", "2026-09-02", H), None)))["blocks"]
src_btc = [i["text"] for i in bb[-1]["items"] if i["id"] == "src"][0]
check("資金費率" not in src_btc and "巨鯨" not in src_btc and "Binance USDT 永續日 K" in src_btc and "前 20 日高/低" in src_btc,
      "BTC 晨報(access=0):src 尾註不描述已跳過的 Blave 系列")
src_cr = [i["text"] for i in foots if i["id"] == "src"][0]
check(src_cr == "價格:Binance USDT 永續日 K。", "加密市場晨報(access=0):src 尾註只剩價格那句")
for fn, why in ((lambda: T.tw_market_brief("2026-09-02", H), "台股大盤晨報"), (lambda: T.tw_close_brief("2026-09-01", H), "台股收盤報告")):
    p = fn()
    check(bool(p.skip) and "加權指數" in p.skip and "no_data_access" not in p.skip and T.publish(p, NAR) is None and T.publish(p) is None
          and "不發佈" in p.describe(), f"{why}(access=0、非電腦版):不准走免費路徑 → skip 而不是 traceback(句子不帶內部代碼),publish 回 None")
# 電腦版(BLAVE_AGENT_LOCAL=1):兩份 TAIEX 報告改走 TWSE / TAIFEX 免費路徑,不再 skip;夜盤、休市表沒有免費路徑 → missing。
MKT = ("fetch_twmarket_turnover", "fetch_twmarket_institutional", "fetch_twmarket_margin", "fetch_twfutures_institutional", "fetch_twfutures_ohlcv")
saved_mkt = {k: getattr(d, k) for k in MKT}
for k in MKT:
    setattr(d, k, gate)
def _src(df, s):
    df = df.copy(); df.attrs["source"] = s; return df
pub = {"fetch_twmarket_index_public": lambda s, e: _src(saved["fetch_twmarket_index"](s, e, H), "TWSE"),
       "fetch_twmarket_turnover_public": lambda s, e: _src(saved_mkt["fetch_twmarket_turnover"](s, e, H), "TWSE"),
       "fetch_twmarket_institutional_public": lambda s, e: _src(saved_mkt["fetch_twmarket_institutional"](s, e, H), "TWSE"),
       "fetch_twmarket_margin_public": lambda s, e: _src(saved_mkt["fetch_twmarket_margin"](s, e, H), "TWSE"),
       "fetch_twfutures_institutional_public": lambda fid, s, e: _src(saved_mkt["fetch_twfutures_institutional"](fid, s, e, H), "TAIFEX")}
saved_pub = {k: getattr(d, k) for k in pub}
for k, fn in pub.items():
    setattr(d, k, fn)
os.environ["BLAVE_AGENT_LOCAL"] = "1"
asked = {}
for k in ("fetch_twmarket_index_public", "fetch_twmarket_institutional_public", "fetch_twmarket_margin_public"):
    setattr(d, k, (lambda k, f: lambda s, e: (asked.__setitem__(k, s), f(s, e))[1])(k, pub[k]))
p = T.tw_market_brief("2026-09-02", H)
check(asked == {"fetch_twmarket_index_public": "2026-06-04", "fetch_twmarket_institutional_public": "2026-07-19",
                "fetch_twmarket_margin_public": "2026-07-19"} and "60 日均" in p.context,
      f"回看:指數固定 90 日(60 日均算得出),逐日打的法人/融資只抓 45 日 — {asked}")
for k, fn in pub.items():
    setattr(d, k, fn)
for why, fn, miss in (("台股大盤晨報", lambda: T.tw_market_brief("2026-09-02", H), ["台指期夜盤", "今日總經事件"]),
                      ("台股收盤報告", lambda: T.tw_close_brief("2026-09-01", H), [])):
    p = fn()
    b = json.load(open(T.publish(p, NAR)))["blocks"]
    items = {i["id"]: i["text"] for i in b[-1]["items"]}
    labels = [i["label"] for x in b if x["type"] == "kpi_row" for i in x["items"]]
    check(p.skip is None and [m["name"] for m in p.missing] == miss
          and {"加權指數", "成交值", "外資買賣超", "融資餘額", "外資期貨淨多單"} <= set(labels)
          and items.get("src_twse") == d._TWSE_SOURCE_ZH and items.get("src_taifex") == d._TAIFEX_SOURCE_ZH
          and "本機直接取自交易所" in items["src"] and "經 Blave API" not in items["src"] and ("blave" in items) == bool(miss)
          and (why != "台股收盤報告" or any("休市表無法取得(沒有 Blave 資料權限)" in n for n in p.notes)),
          f"{why}(access=0、電腦版):走 TWSE/TAIFEX 照樣 publish,尾註帶兩所顯名、不說經 Blave,missing={miss}(休市表只進 notes,不叫人綁卡)")
    en = {i["id"]: i["text"] for i in json.load(open(T.publish(p, NAR, lang="en")))["blocks"][-1]["items"]}
    check(en["src_twse"] == d._TWSE_SOURCE_EN and en["src_taifex"] == d._TAIFEX_SOURCE_EN, f"{why} lang=en:兩所顯名換成英文")
d.fetch_twmarket_margin_public = lambda s, e: (_ for _ in ()).throw(ConnectionError("twse down"))
p = T.tw_market_brief("2026-09-02", H)
check(p.skip is None and "融資餘額" not in [m["name"] for m in p.missing] and any("融資餘額 免費資料抓取失敗(ConnectionError" in n for n in p.notes)
      and "融資餘額" not in p.context, "免費融資抓不到:進 notes、不進 missing(不是權限問題),其餘照出")
d.fetch_twmarket_index_public = lambda s, e: (_ for _ in ()).throw(ConnectionError("twse down"))
try:
    T.tw_close_brief("2026-09-01", H); check(False, "免費指數抓不到:丟真正錯誤")
except ValueError as e:
    check("加權指數免費資料抓不到(ConnectionError" in str(e) and isinstance(e.__cause__, ConnectionError),
          "免費指數抓不到:丟真正錯誤,不 skip、不叫人綁卡")
os.environ.pop("BLAVE_AGENT_LOCAL")
for k, fn in {**saved_mkt, **saved_pub}.items():
    setattr(d, k, fn)
# 非權限的錯誤(網路)不是 missing:落 notes,尾註不把它算成「沒 Blave 資料」。
d.fetch_market_direction = lambda *a, **k: (_ for _ in ()).throw(ConnectionError("boom"))
p = T.crypto_market_brief("2026-09-02", H)
check("市場方向" not in [m["name"] for m in p.missing] and any("市場方向 抓取失敗(ConnectionError)" in n for n in p.notes),
      "access=0 下付費 fetch 丟 ConnectionError:進 notes 不進 missing")
d.fetch_market_direction = gate
# B1(稽核):免費日線真的壞(交易所 / FinMind 連不上)時走真實鏈路 — _twstock_daily 退到 Blave、閘門丟
# DataAccessError 但帶 cause → 範本丟真正的錯誤,不 skip、不講綁卡。
d.fetch_twstock_price = saved["fetch_twstock_price"]   # 真的那支:走 _twstock_daily 的來源鏈
real_free, real_cache = d._fetch_twstock_daily_free, d._CACHE_DIR
d._fetch_twstock_daily_free = lambda *a, **k: (_ for _ in ()).throw(ConnectionError("twse.com.tw unreachable"))
d._CACHE_DIR = __import__("pathlib").Path(tempfile.mkdtemp(prefix="rpt-cache-"))
os.environ["BLAVE_AGENT_LOCAL"] = "1"
try:
    T.symbol_brief("2330", "2026-09-02", H); check(False, "免費日線壞掉:丟真正錯誤")
except ValueError as e:
    check("免費日線抓不到(ConnectionError" in str(e) and "綁卡" not in str(e) and isinstance(e.__cause__, ConnectionError),
          f"免費日線壞掉(真實鏈路、不 stub fetch_twstock_price):丟真正錯誤而不是「沒 Blave 權限」— {str(e)[:60]}")
except Exception as e:
    check(False, f"免費日線壞掉:預期 ValueError,得到 {type(e).__name__}: {str(e)[:80]}")
os.environ["BLAVE_TWSTOCK_DAILY_SOURCE"] = "blave"     # 強制走 Blave:第二次 DataAccessError 沒 cause,仍是真的無權限
p = T.symbol_brief("2330", "2026-09-02", H)
check(bool(p.skip) and "日 K" in p.skip, "BLAVE_TWSTOCK_DAILY_SOURCE=blave 強制走 Blave:沒有免費鏈,仍是無權限 skip")
os.environ.pop("BLAVE_TWSTOCK_DAILY_SOURCE"); os.environ.pop("BLAVE_AGENT_LOCAL")
d._fetch_twstock_daily_free, d._CACHE_DIR = real_free, real_cache
d.fetch_twstock_price = lambda sid, s, e, h: free_tw
os.environ["BLAVE_DATA_ACCESS_WHY"] = "signed_out"
p = T.crypto_market_brief("2026-09-02", H)
doc = json.load(open(T.publish(p, NAR)))
txt = [i for i in doc["blocks"][-1]["items"] if i["id"] == "blave"][0]["text"]
check(all(m["reason"] == "signed_out" for m in p.missing) and "登入" in txt and "signed_out" in p.describe(),
      "signed_out:missing reason=signed_out,尾註才提登入")
os.environ["BLAVE_DATA_ACCESS_WHY"] = "no_balance"
doc = json.load(open(T.publish(T.crypto_market_brief("2026-09-02", H), NAR)))
txt = [i for i in doc["blocks"][-1]["items"] if i["id"] == "blave"][0]["text"]
skip = T.tw_market_brief("2026-09-02", H).skip
check("綁卡" not in txt and "儲值" in txt and "綁卡" not in skip and "儲值" in skip, "no_balance:已綁卡的人不被叫去綁卡(尾註與 skip 同一句)")
os.environ["BLAVE_DATA_ACCESS_WHY"] = "unknown"
doc = json.load(open(T.publish(T.crypto_market_brief("2026-09-02", H), NAR)))
txt = [i for i in doc["blocks"][-1]["items"] if i["id"] == "blave"][0]["text"]
check("綁卡" not in txt and "登入" not in txt and "讀不到資料狀態" in txt, "unknown:不叫人綁卡也不叫人登入,講讀不到資料狀態")
os.environ["BLAVE_DATA_ACCESS_WHY"] = "no_card"
doc = json.load(open(T.publish(T.crypto_market_brief("2026-09-02", H), NAR)))
check("綁卡送 14 天" in [i for i in doc["blocks"][-1]["items"] if i["id"] == "blave"][0]["text"], "no_card:才講綁卡")
bare = free_tw.copy(); bare.attrs = {}
d.fetch_twstock_price = lambda sid, s, e, h: bare
try:
    T.symbol_brief("2330", "2026-09-02", H); check(False, "免費日線沒帶 source:不產一份沒有顯名的報告")
except ValueError as e:
    check("資料來源" in str(e), "免費日線沒帶 source:不產一份沒有顯名的報告(顯名是授權條件)")
d.fetch_twstock_price = lambda sid, s, e, h: free_tw
os.environ.pop("BLAVE_DATA_ACCESS_WHY"); os.environ.pop("BLAVE_DATA_ACCESS")
for k, fn in saved.items():
    setattr(d, k, fn)
p = T.crypto_market_brief("2026-09-02", H)
check(not p.missing and not any(i["id"] == "blave" for i in json.load(open(T.publish(p, NAR)))["blocks"][-1]["items"]),
      "有資料權限:missing 空、尾註沒有那行(雲端機一個位元組都不變)")

print("all checks passed" if not fails else f"FAILED: {fails}"); sys.exit(1 if fails else 0)
