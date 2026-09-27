"""Minimal check for the report flow that has to finish in ~2 minutes: publish() reports every
problem at once; a refused publish is re-sent with the same pack (by id) without rebuilding it;
the same template call within 10 minutes re-uses the kept pack; extra bricks for today's event
land right after the KPI row, degrade when there is no data, and are capped at 3; per-brick
timings are recorded; describe() prints the publish checklist. No network.

Run: cd blave-agent && .venv/bin/python tests/check_report_flow.py
"""
import json, os, sys, tempfile, time
TMP = tempfile.mkdtemp(prefix="flow-")
os.environ["BLAVE_AGENT_WORKSPACE"] = os.path.join(TMP, "workspace")
os.environ["BLAVE_AGENT_STATE"] = os.path.join(TMP, "state")
os.environ["BLAVE_TURN_ID"] = "turn-a"   # pack 只在同一輪重用
for k in ("BLAVE_DATA_ACCESS", "BLAVE_DATA_ACCESS_WHY", "BLAVE_AGENT_LOCAL", "BLAVE_REPORT_PACKS", "BLAVE_SCHEDULED_RUN"):
    os.environ.pop(k, None)
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import numpy as np, pandas as pd
from lib import data as d
import lib.report_templates as T
import lib.report_bricks as B


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
rng = np.random.default_rng(5)
udays = pd.date_range("2026-06-01", "2026-09-02", freq="D", tz="UTC")
def bars(base):
    c = pd.Series(base * np.cumprod(1 + rng.normal(0, .02, len(udays))), index=udays)
    o = c.shift(1).fillna(c.iloc[0])
    return pd.DataFrame({"Open": o, "High": np.maximum(o, c) * 1.01, "Low": np.minimum(o, c) / 1.01, "Close": c,
                         "Volume": np.r_[np.full(len(udays) - 1, 100.0), 900.0]})
K = {s: bars(b) for s, b in (("BTCUSDT", 70000), ("ETHUSDT", 3000), ("SOLUSDT", 150), ("BGBUSDT", 5), ("XRPUSDT", 2))}
fetches = []
def kline(sym, *a, **k):
    fetches.append(sym)
    if sym not in K:
        raise ValueError("no such symbol")
    return K[sym].copy()
d.fetch_kline = kline
d.fetch_kline_batch = lambda syms, i, s, e, h: {x: kline(x) for x in syms}
ALPHA = pd.DataFrame({"alpha": rng.normal(0, 1, len(udays) - 1)}, index=udays[:-1])
for fn in ("fetch_funding_rate", "fetch_market_direction", "fetch_capital_shortage", "fetch_top_trader_exposure", "fetch_unusual_movement",
           "fetch_liquidation", "fetch_whale_hunter", "fetch_taker_intensity"):
    setattr(d, fn, lambda *a, **k: (fetches.append("alpha"), ALPHA.copy())[1])
d.fetch_open_interest_table = lambda h: {"coins": [{"token": "BTC", "market_cap": 2e12, "chg_24h": 0.02,
                                                    "by_exchange": {"okx": {"oi": 5e9, "chg_24h": -0.1}}},
                                                   {"token": "ETH", "market_cap": 4e11, "chg_24h": 0.01,
                                                    "by_exchange": {"okx": {"oi": 2e9, "chg_24h": -0.05}}}]}
d.fetch_long_short_ratio_table = lambda h: {"sources": [{"exchange": "binance", "type": "account", "key": "binance_account"}],
                                            "coins": [{"token": "BTC", "binance_account": 1.8}]}
d.fetch_liquidation_exchanges = lambda h, hours=24, top_n=10: {"total": {"total_liq_usd": 4e8, "long_liq_usd": 3e8},
    "exchanges": [{"exchange": "okx", "total_liq_usd": 1e8, "long_liq_usd": 8e7}, {"exchange": "binance", "total_liq_usd": 3e8}]}
d.fetch_binance_ticker_24h = lambda: pd.DataFrame({"last": 1.0, "change_pct": np.linspace(-9, 30, 20), "quote_volume": 1e8},
                                                  index=[f"C{i}USDT" for i in range(20)])
d.fetch_economic_calendar = lambda h, **k: pd.DataFrame(columns=["time", "country", "subject"])
H = {"api-key": "k", "secret-key": "s"}
d.fetch_open_interest_coin = lambda sym, h: {"windows": {"7d": {"chg": 0.05}}}

fails = 0
def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg); fails += (not cond)

# ── build: timings, checklist, extras ──
pack = T.crypto_market_brief("2026-09-02", H, extra=[["coin_snapshot", {"symbol": "BGB"}], ["exchange_snapshot", {"exchange": "okx"}],
                                                     ["relative_to", {"symbol": "BGB"}]])
names = [n for n, _ in pack.timings]
check({"quote_table", "derivs_table", "coin_snapshot"} <= set(names) and all(t >= 0 for _, t in pack.timings),
      "每塊積木的耗時記在 pack.timings")
ki = pack.owners.index("kpi_row")
check(pack.owners[ki + 1:ki + 4] == ["coin_snapshot", "exchange_snapshot", "relative_to"],
      f"加做的積木排在 KPI 列之後、預設積木之前:{pack.owners[:6]}")
titles = [b.get("title", "") for b in pack.blocks]
check(any(t.startswith("BGB 1 日") and "昨日成交量為前 20 日均" in t for t in titles) and any(t.startswith("Okx") is False and "OKX" in t for t in titles)
      and any(t.startswith("BGB 30 日") for t in titles), "加做的積木有自己的結論式標題(BGB 快照、OKX 衍生品、BGB 相對 BTC)")
desc = pack.describe()
check("publish 檢查表" in desc and "tag 只能 pos / neg / neutral" in desc and f"publish({pack.report_id!r}, narrative, title=" in desc
      and "今天加做的積木" in desc, "describe() 印出檢查表、加做清單、重送方式")

# ── the same call again re-uses the kept pack (no refetch) ──
fetches.clear()
again = T.crypto_market_brief("2026-09-02", H, extra=[["coin_snapshot", {"symbol": "BGB"}], ["exchange_snapshot", {"exchange": "okx"}],
                                                      ["relative_to", {"symbol": "BGB"}]])
check(not fetches and again.context == pack.context and again.report_id == pack.report_id,
      "10 分鐘內同一個呼叫:用留著的 pack,不重抓(數字也不會變)")
os.environ["BLAVE_TURN_ID"] = "turn-b"
fetches.clear()
T.crypto_market_brief("2026-09-02", H, extra=[["coin_snapshot", {"symbol": "BGB"}], ["exchange_snapshot", {"exchange": "okx"}],
                                             ["relative_to", {"symbol": "BGB"}]])
check(bool(fetches), "新的一輪(turn-b):不重用上一輪的 pack,重建(行情可能已經變了)")
os.environ["BLAVE_TURN_ID"] = "turn-a"
try:
    T.load_pack(pack.report_id); check(False, "cross-turn load")
except ValueError as e:
    check("earlier turn" in str(e), "publish(id) 拿到別一輪建的 pack:拒,要重建")
os.environ["BLAVE_TURN_ID"] = "turn-b"
os.environ.pop("BLAVE_TURN_ID")
fetches.clear()
T.crypto_market_brief("2026-09-02", H, fresh=False)
T.crypto_market_brief("2026-09-02", H, fresh=False)
check(fetches.count("BTCUSDT") >= 2, "不在任何一輪裡(沒有回合 id):每次都重建")
os.environ["BLAVE_TURN_ID"] = "turn-b"

# ── degrade + cap ──
p2 = T.crypto_market_brief("2026-09-02", H, extra=[["coin_snapshot", {"symbol": "NOPE"}], ["exchange_snapshot", {"exchange": "bitget"}]],
                           fresh=True)
check(not p2.skip and "coin_snapshot" not in p2.owners and "exchange_snapshot" not in p2.owners
      and any("NOPE" in n for n in p2.notes) and any("Bitget" in n for n in p2.notes),
      "加做沒資料(沒有這個幣、Blave 沒收 Bitget):那塊不出、記 notes、報告照出")
try:
    T.crypto_market_brief("2026-09-02", H, extra=[["coin_snapshot", {"symbol": "BGB"}]] * 4); check(False, "cap")
except ValueError as e:
    check("at most 3" in str(e), "加做超過 3 塊:拒")
try:
    T.crypto_market_brief("2026-09-02", H, extra=[["exchange_snapshot", {"exchange": "okx; rm"}]]); check(False, "param")
except ValueError as e:
    check("exchange name" in str(e), "加做的參數值照樣檢查")

os.environ["BLAVE_DATA_ACCESS"] = "0"
fetches.clear()
T.crypto_market_brief("2026-09-02", H, extra=[["coin_snapshot", {"symbol": "BGB"}], ["exchange_snapshot", {"exchange": "okx"}],
                                             ["relative_to", {"symbol": "BGB"}]])
os.environ.pop("BLAVE_DATA_ACCESS")
check(bool(fetches), "資料權限變了(例如剛綁卡):不重用,重新建")

# ── publish: every problem at once, then re-send by id ──
bad = {"lead": "BTC 在 84,000 美元附近整理,未能延續近一週的反彈,30 日均線之上但短線動能轉弱,ETF 資金卻同步轉正。",
       "read": "x" * 301,
       "watch": [("甲", "門檻", "值")],
       "news": [{"title": "t", "summary": "s。", "tag": "bullish", "sources": [("x", "https://a.b/1")], "published_at": NOW - 60}]}
try:
    pub(pack.report_id, bad); check(False, "應該被拒")
except ValueError as e:
    msg = str(e)
    check(all(k in msg for k in ("cap 300", "first sentence is", "1 row(s), needs 2–3", "tag must be one of"))
          and msg.count("\n  ") >= 4 and f"publish({pack.report_id!r}, narrative)" in msg,
          "publish 一次列出全部問題(read 太長、lead 第一句、watch 列數、news tag),並講怎麼用同一個 pack 重送")
fetches.clear()
good = {"lead": "現貨撐盤,槓桿正在退場。", "few_sources": "測試:單一來源",
        "read": ["**BTC 高於均線**:收盤位置見上", "**資金費率偏低**:見上", "**爆倉以多單為主**:見上"],
        "watch": "| 條件 | 門檻 | 現在值 |\n|---|---|---|\n| 甲 | 轉負 | 1 |\n| 乙 | 轉正 | 2 |",
        "news": [{"title": "Bitget 遭駭 3.52 億美元", "summary": "交易所遭駭客盜走 3.52 億美元。", "tag": "負面消息",
                  "sources": [("CoinDesk", "https://www.coindesk.com/x")], "published_at": NOW - 600, "symbols": ["BGB"]}]}
path = pub(pack.report_id, good)
doc = json.load(open(path))
news = [b for b in doc["blocks"] if b["type"] == "news"][0]
wt = [b for b in doc["blocks"] if b["type"] == "table" and b.get("title") == "觀察重點"][0]
check(not fetches and news["items"][0]["tag"] == "neg" and len(wt["rows"]) == 2
      and "- **BTC 高於均線**" in [b for b in doc["blocks"] if b["type"] == "text" and "判讀" in b["markdown"]][0]["markdown"],
      "用 id 重送:不重建;read 給 list、watch 給 markdown 表、tag 寫「負面消息」都照收")
# ── Report flow checks on what the agent wrote ──
try:
    pub(T.crypto_market_brief("2026-09-02", H, fresh=True).report_id,
              {"lead": "市場整理。", "few_sources": "x",
               "news": [{"title": "Bitget駭客轉移8300萬美元贓款XRP", "summary": "駭客把被盜資產轉出。", "tag": "neg",
                         "sources": [("CoinDesk", "https://www.coindesk.com/z")], "published_at": NOW - 600}]})
    check(False, "沒填 symbols 也要抓到 XRP")
except ValueError as e:
    check("names XRP" in str(e), "沒填 symbols:從標題抓到 XRP,照樣提示加做")
try:
    pub(T.crypto_market_brief("2026-09-02", H, fresh=True).report_id,
              {"lead": "市場整理。", "few_sources": "x",
               "news": [{"title": "交易所被盜資產換成瑞波幣", "summary": "駭客轉出資產。", "tag": "neg",
                         "sources": [("CoinDesk", "https://www.coindesk.com/y")], "published_at": NOW - 600}]})
    check(False, "中文幣名也要抓到")
except ValueError as e:
    check("names XRP" in str(e), "中文幣名(瑞波)對照成 XRP")
plain = T.crypto_market_brief("2026-09-02", H, fresh=True)          # 沒有加做
XRP = {"title": "Bitget 駭客轉出 8300 萬美元 XRP", "summary": "被盜資產以 XRP 轉出。", "tag": "neg", "symbols": ["XRP"],
       "sources": [("CoinDesk", "https://www.coindesk.com/a")], "published_at": NOW - 600}
OTHER = {"title": "ETF 單週淨流入", "summary": "現貨 ETF 資金連五日流入。", "tag": "neutral",
         "sources": [("CoinDesk", "https://www.coindesk.com/b")], "published_at": NOW - 900}
lead = {"lead": "XRP 失竊事件拖累盤面,槓桿正在退場。"}
try:
    pub(plain.report_id, dict(lead, news=[XRP, OTHER])); check(False, "應要求表態")
except ValueError as e:
    m = str(e)
    check("names XRP" in m and '["coin_snapshot", {"symbol": "XRP"}]' in m and "1 site(s) (coindesk.com), fewer than 3" in m,
          "新聞點名 XRP(負面)但沒加做:提示 coin_snapshot/relative_to(XRP);只有 1 個網站:要補到 3 個")
try:
    pub(plain.report_id, dict(lead, no_extra="x", news=[XRP, dict(OTHER, sources=[("Bitcoin.com", "https://news.bitcoin.com/b")])]))
    check(False, "兩個網站仍要提示")
except ValueError as e:
    check("2 site(s)" in str(e) and "fewer than 3" in str(e), "兩個網站仍不夠:提示補到 3 個")
THIRD = {"title": "監管機構調查交易所", "summary": "監管機構對交易所展開調查。", "tag": "neutral",
         "sources": [("Reuters", "https://www.reuters.com/c")], "published_at": NOW - 1200}
try:
    pub(plain.report_id, dict(lead, news=[XRP, dict(OTHER, sources=[("Bitcoin.com", "https://news.bitcoin.com/b")]), THIRD],
                              no_extra="XRP 已在三大法人數據中反映"))
    check(False, "lead 講 XRP 還填 no_extra:應拒")
except ValueError as e:
    check("no_extra does not cover" in str(e) and '["coin_snapshot", {"symbol": "XRP"}]' in str(e),
          "lead 講的標的(XRP)不能用 no_extra 帶過:要加做,提示給出 extra 寫法")
calm = {"lead": "槓桿正在退場,盤面整理。"}
ok = pub(plain.report_id, dict(calm, news=[XRP, dict(OTHER, sources=[("Bitcoin.com", "https://news.bitcoin.com/b")]), THIRD],
                               no_extra="Blave 沒收 Bitget,XRP 價格已在報價表"))
check(os.path.exists(ok), "敘事沒講 XRP:no_extra 一句 + 三個網站照發")
check(os.path.exists(pub(plain.report_id, dict(calm, no_extra="x", few_sources="今天只有兩家報導", news=[XRP, OTHER]))),
      "來源不到 3 家但在 few_sources 說明:照發")
withx = T.crypto_market_brief("2026-09-02", H, extra=[["coin_snapshot", {"symbol": "XRP"}]])
check(os.path.exists(pub(withx.report_id, dict(lead, few_sources="測試", news=[XRP]))), "照提示加做 coin_snapshot(XRP) 後:不再要求表態")
# 只有日期的新聞:存當天 12:00 UTC、標 precision=day(渲染只顯示日期,不是 00:00)
path = pub(withx.report_id, dict(lead, few_sources="測試", news=[dict(XRP, published_at="2026-09-01")]))
it = [b for b in json.load(open(path))["blocks"] if b["type"] == "news"][0]["items"][0]
check(it["published_at_precision"] == "day" and it["published_at"] == int(pd.Timestamp("2026-09-01 12:00", tz="UTC").timestamp()),
      "只有日期:12:00 UTC + published_at_precision=day")
path = pub(withx.report_id, dict(lead, few_sources="測試", news=[dict(XRP, published_at="2026-09-02 08:30")]))
it = [b for b in json.load(open(path))["blocks"] if b["type"] == "news"][0]["items"][0]
check("published_at_precision" not in it, "有時間:不帶 precision(= minute)")

os.environ["BLAVE_REPORT_PACKS"] = "off"
fetches.clear()
T.crypto_market_brief("2026-09-02", H)
check(bool(fetches), "BLAVE_REPORT_PACKS=off:每次都重建")
try:
    T.load_pack("nope-20260902"); check(False, "no pack")
except ValueError as e:
    check("no kept pack" in str(e), "沒有留著的 pack:講清楚要先建")

# ── 研究報告:research_pack 給一份資料,不用自己寫抓資料的腳本 ──

rp = T.research_pack("SOL", date="2026-09-02", headers=H, fresh=True)
kinds = [(o, b["type"]) for o, b in zip(rp.owners, rp.blocks)]
check(rp.type == "research" and rp.report_id == "research-sol-20260902"
      and {"price_chart", "coin_snapshot", "relative_to", "funding", "derivs_table", "blave_indicators", "levels_table"} <= set(rp.owners)
      and ("price_chart", "candlestick") in kinds and "SOL 價格" in rp.context and "publish 檢查表" in rp.describe(),
      "research_pack(SOL):價格 K 線、成交量、相對 BTC、資金費率、衍生品、Blave 指標、高低均線,describe 帶檢查表")
only = T.research_pack("SOL", topics=["price", "relative"], date="2026-09-02", headers=H, fresh=True)
check(set(only.owners) - {"kpi_row", "footnote"} == {"price_chart", "relative_to"}, "topics 只挑需要的段落")
try:
    T.research_pack("SOL", topics=["onchain"]); check(False, "topic")
except ValueError as e:
    check("unknown topic" in str(e), "不存在的 topic:拒並列出可選的")
try:
    pub(rp, {"lead": "SOL 走強靠現貨,槓桿還沒追上。", "no_extra": "x", "few_sources": "x", "news": [XRP],
                   "watch": [("甲", "門檻", "值"), ("乙", "門檻", "值")]})
    check(False, "research 缺 B3/B4/B5")
except ValueError as e:
    m = str(e)
    check(all(f"narrative[{k!r}]" in m for k in ("against", "robustness", "risk")) and "unknown narrative slot(s): ['watch']" in m,
          "研究報告:少了 against(B3)/robustness(B4)/risk(B5) 一次列出;watch 不是研究的槽位")
d_r = rp.describe()
check("against ≤" in d_r and "robustness ≤" in d_r and '"against": "- …"' in d_r and "shareable=True" in d_r
      and 'part=\"meta\"' in d_r and "不用去讀 references 或 lib 原始碼" in d_r,
      "研究 pack 的 describe:列出 against/robustness/risk、narrative 範例、publish 寫法、讀網頁只用 meta/section")
rdoc = json.load(open(pub(rp, {"lead": "SOL 走強靠現貨,槓桿還沒追上。", "no_extra": "x", "few_sources": "x",
                                     "against": "- 資金費率轉正,與現貨主導的說法不完全相符。",
                                     "robustness": "- 換成 60 日窗口,SOL 仍強於 BTC。",
                                     "risk": "若接下來三週 OI 增幅超過價格漲幅,這個結論作廢。",
                                     "news": [XRP]}, title="SOL 這波走強靠現貨,槓桿還沒追上", shareable=True)))
md = " ".join(b.get("markdown", "") for b in rdoc["blocks"] if b["type"] == "text")
closing = [b["markdown"] for b in rdoc["blocks"] if b["type"] == "text" and b["markdown"].startswith("## 總結")]
check("## 哪些數據不支持這個結論" in md and "## 換個做法結論還站得住嗎" in md and not any(b["type"] == "callout" for b in rdoc["blocks"])
      and len(closing) == 1 and closing[0].endswith("\n\n**推翻條件：**若接下來三週 OI 增幅超過價格漲幅，這個結論作廢。")
      and rdoc["blocks"][-2]["markdown"] == closing[0],
      "研究報告:B3/B4 各一段、B5(推翻條件)是總結的最後一句、總結在尾註前,不再有提示框")
src = [i["text"] for i in rdoc["blocks"][-1]["items"] if i["id"] == "src"][0]
check(src.count("價格") == 1 and "最後一根為今日未收盤 bar" in src, f"尾註同一句的短版長版只留長的:{src[:60]}")
check(all("url" not in i for i in rdoc["blocks"][-1]["items"])
      and all(s.get("url", "").startswith("https://") for b in rdoc["blocks"] if b["type"] == "news" for it in b["items"] for s in it["sources"]),
      "資料口徑尾註本來就沒有 url(Blave／Binance 不是讀者能開的頁);網路來源的連結在 news block 裡")
check(rdoc["type"] == "research" and rdoc["blocks"][0]["title"] == "SOL 這波走強靠現貨,槓桿還沒追上"
      and [b["type"] for b in rdoc["blocks"]][1:3] == ["text", "kpi_row"] and rdoc["blocks"][0]["shareable"] is True,
      "研究報告 publish:type research、標題用自己的主張、lead 後面緊接 kpi_row(§7b)")

# ── 總結、結論式標題、資料日(Wei 09-26) ──
def refusal(fn):
    """publish()'s refusal text, "" when it went through. Any other exception is a result too (the
    check that follows fails on it) — never a crash that stops the remaining checks."""
    try:
        fn()
        return ""
    except ValueError as e:
        return str(e)
    except Exception as e:
        return f"<{type(e).__name__}: {e}>"
base = {"lead": "槓桿正在退場,盤面整理。", "news": []}
m = refusal(lambda: T.publish(plain.report_id, base))
check("title=" in m and "narrative['summary'] is missing" in m, "有判讀卻沒給標題、沒寫總結:兩件一起列進退件清單")
m = refusal(lambda: T.publish(plain.report_id, dict(base, summary="去槓桿還沒結束,接下來看資金費率。"), title="加密市場晨報"))
check("not the template name" in m, "標題照抄範本名「加密市場晨報」:拒,要結論式")
m = refusal(lambda: T.publish(plain.report_id, dict(base, summary="槓桿正在退場,盤面整理中。"), title="槓桿退場"))
check("repeats the lead" in m, "總結重述 lead:拒")
m = refusal(lambda: T.publish(plain.report_id, dict(base, summary="甲。乙。丙。丁。"), title="槓桿退場"))
check("4 sentences, at most 3" in m, "總結超過 3 句:拒")
okdoc = json.load(open(T.publish(plain.report_id, dict(base, summary="去槓桿還沒結束,接下來看資金費率", risk="若資金費率重新轉正並走高,這個判斷就不成立。"),
                                 title="槓桿退場,現貨撐盤")))
tb = okdoc["blocks"]
check(tb[-2]["type"] == "text" and tb[-2].get("variant") == "summary"
      and tb[-2]["markdown"] == "## 總結\n\n去槓桿還沒結束，接下來看資金費率\n\n**推翻條件：**若資金費率重新轉正並走高，這個判斷就不成立。"
      and not any(x["type"] == "callout" for x in tb) and okdoc["title"] == "槓桿退場,現貨撐盤" and "extra" not in tb[0],
      "總結是 text variant=summary、在尾註前;推翻條件是最後一段、前綴由 publish 加;沒有風險框;今天的報告標題不加日期")
m = refusal(lambda: T.publish(plain.report_id, dict(base, summary="接下來看融資餘額與外資期貨淨多單。",
                                                   watch=[("外資期貨淨多單", "轉為淨空", "有"), ("融資餘額", "連三日減少", "有")]), title="槓桿退場"))
check("walks through 2 rows" in m, "總結把觀察重點表的兩列都念一遍:拒,只點名最重要的一項")
w1 = json.load(open(T.publish(plain.report_id, dict(base, summary="去槓桿還沒結束,接下來看外資期貨淨多單。",
                                                     watch=[("外資期貨淨多單", "轉為淨空", "有"), ("融資餘額", "連三日減少", "有")],
                                                     risk="推翻條件:若槓桿重新堆高,這個判斷就不成立。"), title="槓桿退場")))["blocks"]
check(w1[-2]["markdown"].count("推翻條件") == 1, "agent 自己寫了「推翻條件:」:publish 不重複加前綴")
kr = [x for x in tb if x["type"] == "kpi_row"]
auto_kr = [x for x in json.load(open(T.publish(plain.report_id)))["blocks"] if x["type"] == "kpi_row"]
check(kr and "title" not in kr[0] and auto_kr and auto_kr[0].get("title") and any(x["type"] == "kpi_row" and x.get("title") for x in plain.blocks),
      "有 lead:KPI 列不再帶結論式標題(跟 lead 重複,設計稽核 B7);純資料版照留;pack 本身沒被改")
desc = plain.describe()
check("summary 必填" in desc and "要打結論裡的那個判斷,不是反向的行情" in desc and "未見恐慌" in desc and "不是「賣更多」" in desc and '"summary":' in desc and "title=" in desc,
      "describe():總結必填、推翻條件要打結論裡的判斷(未見恐慌→恐慌訊號、外資轉賣→轉回買超)、範例有 summary 與 title")

def mini(rid, title, day, mode="morning", subject=None, bricks=()):
    pk = T.Pack(rid, title, "morning", title, [T.kpi_row([T.kpi("a", "1")]), T.footnote([("s", "口徑")])], {})
    pk.report_day, pk.mode, pk.subject, pk.bricks = day, mode, subject, [list(b) for b in bricks]
    return pk
NAR = {"lead": "外資轉賣,指數仍站穩。", "summary": "賣壓集中在個股調節,接下來看外資能否回補。", "few_sources": "測試", "news": []}
past = json.load(open(T.publish(mini("tw-close-20260901", "台股收盤報告", "2026-09-01", "close"), NAR, title="外資轉賣,指數仍站穩")))
check(past["title"] == "9/1 收盤｜外資轉賣,指數仍站穩" and past["blocks"][0]["title"] == past["title"]
      and {"label": "資料日", "value": "2026/09/01"} in past["blocks"][0]["extra"],
      "資料日不是今天(週六跑週四的收盤):標題前加「9/1 收盤｜」、頁首標資料日")
again = json.load(open(T.publish(mini("tw-close-20260901", "台股收盤報告", "2026-09-01", "close"), NAR, title="9/1 外資轉賣")))
check(again["title"] == "9/1 外資轉賣", "標題已經寫了日期:不重複加")
check("標題前加「9/1 收盤｜」" in mini("tw-close-20260901", "台股收盤報告", "2026-09-01", "close").describe(),
      "describe() 先講 publish 會自動加資料日,agent 不用自己寫")

m = refusal(lambda: T.publish(plain.report_id, dict(base, lead="BTC held flat; alts led gains。", summary="Majors cooled, no panic yet."), title="槓桿退場"))
check("is not in Chinese" in m, "中文報告寫成英文判讀(排程模擬 09-26):拒")
try:
    B.check_extra([{"type": "news", "title": "x"}]); check(False, "新聞當成積木")
except ValueError as e:
    check('["coin_snapshot", {"symbol": "XRP"}]' in str(e) and "narrative['news']" in str(e),
          "extra 塞新聞(排程模擬 09-26):錯誤訊息給積木寫法、說新聞放 narrative")
check("那件事真的發生" in plain.describe(), "describe():結論是「未見恐慌」這類否定判斷時,推翻條件是那件事發生")
m = refusal(lambda: T.publish(plain.report_id, dict(base, summary="較像獲利了結,指數仍守在 60 日均之上。",
                                                   watch=[("加權指數", "跌破60日均 45,321.99", "有"), ("融資餘額", "跌破 845.0 萬張", "有")]),
                              title="槓桿退場"))
check("守在" in m and "跌破60日均" in m and "845" not in m.split("floor or ceiling")[0],
      "總結寫「守在 60 日均之上」、觀察重點寫「跌破60日均」(排程模擬 09-26):拒;籌碼門檻「跌破 845.0 萬張」不算")
# 列舉:每個工程字(帶底線的積木名 + 函式名/「資料包」)寫進總結都要被擋;一般中文照發
missed = [w for w in T._internal_words()
          if "engineering names" not in refusal(lambda w=w: T.publish(plain.report_id, dict(base, summary=f"BTC 同期 +4.9%（{w}）。"), title="槓桿退場"))]
check(not missed and len(T._internal_words()) >= 20
      and "engineering names" not in refusal(lambda: T.publish(plain.report_id, dict(base, summary="BTC 同期上漲,資金費率轉正。"), title="槓桿退場"))
      and "不引用媒體報的數字" in plain.describe(),
      f"工程字(研究實測「資料包 relative_to」):{len(T._internal_words())} 個逐一擋下{'' if not missed else ' — 漏 ' + str(missed)};describe 叫算得出的數字自己算")
# relative_to 拿基準跟自己比(BNB 研究實測「BTC 30 日 +4.9%,BTC +4.9%」)
try:
    B.check_extra([["relative_to", {"symbol": "BTC"}]]); check(False, "自己比自己")
except ValueError as e:
    check("with itself" in str(e), "extra relative_to(BTC) 對 BTC:建 pack 前就拒")
selfp = T.crypto_market_brief("2026-09-02", H, fresh=True)
selfp.blocks.insert(1, T.line_chart("BTC 30 日 +4.9%", [("BTC", "primary", pd.Series([1.0, 2.0], index=udays[:2])),
                                                        ("BTC", "benchmark", pd.Series([1.0, 2.0], index=udays[:2]))]))
selfp.owners.insert(1, "relative_to")
check("compares a coin with itself" in refusal(lambda: T.publish(selfp, dict(base, summary="整理中,接下來看資金費率。"), title="槓桿退場")),
      "pack 裡有自己比自己的圖(舊 pack):publish 擋")
bnb = mini("research-bnb-20260902", "BNB 研究", "2026-09-02", subject="BNB",
           bricks=[["price_chart", {"symbol": "BNB"}], ["relative_to", {"symbol": "BNB", "benchmark": "BTC"}]])
BTCN = {"title": "BTC ETF 單週淨流出", "summary": "現貨 ETF 連三週淨流出。", "tag": "neg", "symbols": ["BTC"],
        "sources": [("CoinDesk", "https://www.coindesk.com/q")], "published_at": NOW - 600}
m = refusal(lambda: T.publish(bnb, dict(NAR, lead="BNB 相對 BTC 走強。", news=[BTCN]), title="BNB 走強"))
check("names BTC" not in m and '"relative_to", {"symbol": "BTC"}' not in m,
      "研究講到基準幣 BTC:不強迫加做(不會要 relative_to(BTC) 跟自己比)")
rp_w = T.research_pack("SOL", date="2026-09-02", headers=H, fresh=True)
check(["derivs_table", {"symbols": ["SOL", "BTC", "ETH"], "window": "7d"}] in rp_w.bricks
      and T.research_pack("SOL", date="2026-09-02", headers=H, fresh=True, window="24h", days=60).bricks[2][1].get("days") == 60,
      "research_pack:OI 預設 7 日窗(研究不是當日盤),days/window 可照用戶問的改")
# ── 新聞標籤:台股代號顯示名稱,查不到不顯示;單一標的的報告不重複掛自己 ──
TWN = {"title": "外資大砍友達、力積電", "summary": "外資賣超友達 8 萬張居首。", "tag": "neg", "symbols": ["2409", "6770"],
       "sources": [("鉅亨網", "https://news.cnyes.com/news/id/1")], "published_at": NOW - 600}
ETF = {"title": "外資逆勢買超主動式 ETF", "summary": "外資買超前十有五檔主動式 ETF。", "tag": "neutral", "symbols": ["00403A"],
       "sources": [("經濟日報", "https://money.udn.com/money/story/1")], "published_at": NOW - 700}
d.fetch_twstock_list = lambda h, **k: pd.DataFrame({"name": ["友達", "力積電"]}, index=pd.Index(["2409", "6770"], name="stock_id"))
twp = mini("tw-close-20260902", "台股收盤報告", "2026-09-02", "close", bricks=[["price_chart", {"symbol": "TAIEX"}]])
tw_nar = dict(NAR, read=["**外資調節**:大砍友達", "**乙**:二", "**丙**:三"], no_extra="已在三大法人數據中反映", news=[TWN, ETF])
m = refusal(lambda: T.publish(twp, tw_nar, title="外資轉賣"))
check("no_extra does not cover" in m and '["tw_institutional", {"symbol": "2409"}]' in m and "2409(友達)" in m,
      "台股:read 講到友達(新聞代號 2409)還填 no_extra:拒,提示加做 tw_institutional(2409)")
twp.extra_owners, twp.bricks = ["tw_institutional"], twp.bricks + [["tw_institutional", {"symbol": "2409"}]]
nb = [x for x in json.load(open(T.publish(twp, tw_nar, title="外資轉賣")))["blocks"] if x["type"] == "news"][0]
check(nb["items"][0]["symbols"] == ["友達", "力積電"] and "symbols" not in nb["items"][1],
      "加做之後照發;新聞標籤顯示友達、力積電,查不到名稱的 00403A 不顯示")
DOGE = {"title": "Bitwise DOGE ETF 清算", "summary": "規模僅剩 68.8 萬美元。", "tag": "neg", "symbols": ["DOGE"],
        "sources": [("Forbes", "https://www.forbes.com/a")], "published_at": NOW - 600}
dg = mini("symbol-doge-20260902", "DOGE 晨報", "2026-09-02", subject="DOGE", bricks=[["price_chart", {"symbol": "DOGE"}]])
dnar = dict(NAR, lead="DOGE ETF 清算,機構買盤退場。", no_extra="新聞皆聚焦DOGE本身", news=[DOGE])
m = refusal(lambda: T.publish(dg, dnar, title="DOGE ETF 清算"))
check("no_extra does not cover" in m and '["relative_to", {"symbol": "DOGE"}]' in m,
      "單幣晨報:新聞講的就是 DOGE 本身也要加做,提示 relative_to(DOGE)(不是重複的 coin_snapshot)")
dg.extra_owners = ["relative_to"]
nb = [x for x in json.load(open(T.publish(dg, dnar, title="DOGE ETF 清算")))["blocks"] if x["type"] == "news"][0]
check("symbols" not in nb["items"][0], "單幣晨報:每則新聞都等於報告標的,不掛 DOGE 標籤")
bt = mini("symbol-btc-20260902", "BTC 晨報", "2026-09-02", subject="BTC", bricks=[["price_chart", {"symbol": "BTC"}]])
check(os.path.exists(T.publish(bt, dict(NAR, lead="BTC 現貨撐盤。", news=[dict(DOGE, symbols=["BTC"], title="BTC ETF 流出")]), title="BTC 撐盤")),
      "BTC 晨報講 BTC:沒有更合適的積木可加(relative_to BTC 對 BTC 沒意義),不擋")

# 成交量倍數不拿今天剛開的那根(09-27 08:17 實測「ZEC 成交量為 20 日均 0.0 倍」)
K["ZECUSDT"] = bars(40)
K["ZECUSDT"].iloc[-1, K["ZECUSDT"].columns.get_loc("Volume")] = 0.5     # 早上 8 點:今天那根量幾乎是 0
real_tk = d.fetch_binance_ticker_24h
d.fetch_binance_ticker_24h = lambda: pd.DataFrame({"last": [40.0], "change_pct": [-0.55], "quote_volume": [1e7], "volume": [150.0]},
                                                  index=["ZECUSDT"])
zp = T.crypto_market_brief("2026-09-02", H, extra=[["coin_snapshot", {"symbol": "ZEC"}]], fresh=True)
zt = [x for x, o in zip(zp.blocks, zp.owners) if o == "coin_snapshot"][0]
check("近 24 小時成交量為前 20 日均 1.5 倍" in zt["title"] and zt["title"].startswith("ZEC 24 小時 -0.55%")
      and "近 24 小時量 ÷ 前 20 個完整日平均" in zt["caption"],
      f"coin_snapshot:用 Binance 近 24 小時滾動量 ÷ 前 20 個完整日(不拿今天剛開的那根),caption 寫口徑 — {zt['title']}")
d.fetch_binance_ticker_24h = lambda: (_ for _ in ()).throw(ConnectionError("blocked"))
zp = T.crypto_market_brief("2026-09-02", H, extra=[["coin_snapshot", {"symbol": "ZEC"}]], fresh=True)
zt = [x for x, o in zip(zp.blocks, zp.owners) if o == "coin_snapshot"][0]
check("昨日成交量為前 20 日均 1.0 倍" in zt["title"] and "0.0 倍" not in zt["title"] and "昨日量 ÷ 前 20 個完整日平均" in zt["caption"],
      f"拿不到 24 小時行情:改用昨天完整一天的量,caption 跟著改 — {zt['title']}")
d.fetch_binance_ticker_24h = real_tk
del K["ZECUSDT"]

# 台股個股盤中:今天那根還在長,量拿昨天完整那天比前 5 日(不拿半天量比整天均量)
tdays = pd.bdate_range("2026-07-01", "2026-09-02", tz="Asia/Taipei")
TWK = pd.DataFrame({"Open": 100.0, "High": 101.0, "Low": 99.0, "Close": 100.5, "Volume": 10_000.0}, index=tdays)
TWK.iloc[-1, TWK.columns.get_loc("Volume")] = 800.0          # 盤中 10:00 的量
d.fetch_twstock_ohlcv = lambda sid, iv, h, start=None, end=None: TWK.copy()
real_now = T._now_tpe
for hhmm, want in (("10:00", "09/01"), ("15:00", None)):
    T._now_tpe = lambda hhmm=hhmm: pd.Timestamp(f"2026-09-02 {hhmm}", tz="Asia/Taipei").to_pydatetime()
    sp = T.symbol_brief("2330", "2026-09-02", H, fresh=True)
    kv = [i for x in sp.blocks if x["type"] == "kpi_row" for i in x["items"] if i["label"].startswith("成交量")][0]
    ok = (kv["label"] == f"成交量（{want}）" and kv["delta"].startswith("+0.00%") and "今日盤中那根未計" in sp.context["收盤"]) if want \
        else (kv["label"] == "成交量" and kv["value"] == "800")
    check(ok, f"台股個股 {hhmm}:" + ("盤中量改用 09/01 完整日比前 5 日" if want else "收盤後照用當日量") + f" — {kv}")
T._now_tpe = real_now

# 聊天回覆範本(09-27 實測回了四句、重述數字、加「**結論**」標籤)
import io as _io, contextlib as _cl
buf = _io.StringIO()
with _cl.redirect_stdout(buf):
    T.publish(plain.report_id, dict(base, lead="槓桿正在退場,盤面整理。BTC 資金費率 +0.0008%。",
                                    summary="去槓桿還沒結束,現貨撐住盤面。接下來看資金費率是否轉負。"), title="槓桿退場")
out_ = buf.getvalue()
draft = [l for l in out_.splitlines() if l.startswith("[report] Reply with this")]
check(draft and draft[0].endswith("槓桿正在退場，盤面整理。接下來看資金費率是否轉負。") and "no bold label" in out_,
      f"publish 印出照抄得了的回覆範本:lead 第一句 + 總結裡的「接下來看…」;規則寫明不加標題與粗體標籤 — {draft}")
check(T._reply_draft({"lead": "外資轉賣。"}, {"rows": [{"cond": "外資期貨淨多單"}]}) == "外資轉賣。接下來看外資期貨淨多單。"
      and T._reply_draft({}, None) is None, "總結沒寫「接下來看」:用觀察重點第一列;沒有 lead(純資料版):不印範本")

# 成功訊息:電腦版講報告在「這台電腦」、雲端視角那一輪不准說已打開;雲端照舊
import io, contextlib
from lib import report as LR
for local, want, not_want in (("1", "do not say it is open", "Reports list"), (None, "Reports list", "This computer")):
    if local:
        os.environ["BLAVE_AGENT_LOCAL"] = local
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        LR.write_report("msg-test", "t", [{"type": "text", "markdown": "x"}], type="morning")
    os.environ.pop("BLAVE_AGENT_LOCAL", None)
    check(want in buf.getvalue() and not_want not in buf.getvalue(),
          f"寫完的訊息:{'電腦版說報告在這台電腦、雲端視角不說已打開' if local else '雲端說稍後出現在報告清單'}")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
