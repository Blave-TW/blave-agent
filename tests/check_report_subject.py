"""A single-instrument brick says which instrument it is about (batch 9 #1): a 2330 外資買賣超 chart
inside a whole-market report was titled 「外資近 10 日賣超 20,764 張」 and read as the whole market's.
Every brick in SINGLE_SUBJECT is run here; a new brick with a symbol / exchange parameter that is
not registered fails. No network, no api.
Run: cd blave-agent && .venv/bin/python tests/check_report_subject.py
"""
import inspect, os, shutil, sys, tempfile
WS = os.environ["BLAVE_AGENT_WORKSPACE"] = tempfile.mkdtemp(prefix="subject-")
os.environ["BLAVE_REPORT_PACKS"] = "off"
for k in ("BLAVE_DATA_ACCESS", "BLAVE_DATA_ACCESS_WHY", "BLAVE_AGENT_LOCAL", "BLAVE_SCHEDULED_RUN"):
    os.environ.pop(k, None)
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import numpy as np, pandas as pd
from lib import data as d
import lib.report_templates as T
import lib.report_bricks as B

T._now_tpe = lambda: pd.Timestamp("2026-09-02 09:00", tz="Asia/Taipei").to_pydatetime()
rng = np.random.default_rng(9)
days = pd.bdate_range("2026-05-01", "2026-09-01", tz="Asia/Taipei"); n = len(days)
udays = pd.date_range("2026-05-01", "2026-09-02", freq="D", tz="UTC")
def bars(idx, base):
    c = pd.Series(base * np.cumprod(1 + rng.normal(0, .01, len(idx))), index=idx)
    o = c.shift(1).fillna(c.iloc[0])
    return pd.DataFrame({"Open": o, "High": np.maximum(o, c) * 1.002, "Low": np.minimum(o, c) / 1.002, "Close": c, "Volume": 1000.0})
ALPHA = pd.DataFrame({"alpha": rng.normal(0, 1, len(udays) - 1)}, index=udays[:-1])
d.fetch_twmarket_index = lambda s, e, h: bars(days.tz_localize(None), 45000)
d.fetch_twmarket_institutional = lambda s, e, h: pd.DataFrame({"foreign": -3.38e10, "investment_trust": -1e10, "dealer": 1e9, "total": -4.28e10}, index=days.tz_localize(None))
d.fetch_twstock_ohlcv = lambda sid, i, h, start=None, end=None: bars(days, 2400)
d.fetch_twstock_institutional = lambda sid, s, e, h: pd.DataFrame({"foreign_net": rng.normal(0, 5e6, n)}, index=days.tz_localize(None))
d.fetch_kline = lambda sym, i, s, e, h: bars(udays, 150)
d.fetch_kline_batch = lambda syms, i, s, e, h: {x: bars(udays, 150) for x in syms}
for fn in ("fetch_funding_rate", "fetch_liquidation", "fetch_whale_hunter", "fetch_taker_intensity"):
    setattr(d, fn, lambda *a, **k: ALPHA.copy())
d.fetch_binance_ticker_24h = lambda: pd.DataFrame({"change_pct": [1.0], "volume": [2000.0]}, index=["SOLUSDT"])
d.fetch_liquidation_map = lambda pair, h: {"labels": list(np.linspace(100, 200, 200)), "price": 150.0, "oi_value": [1e6] * 200,
                                           "liquidation": {"24h": {"buy_liq": [2e6] * 200, "sell_liq": [1e6] * 200}}}
d.fetch_liquidation_exchanges = lambda h, hours=24, top_n=10: {"total": {"total_liq_usd": 4e8, "long_liq_usd": 3e8},
                                                               "exchanges": [{"exchange": "okx", "total_liq_usd": 1e8, "long_liq_usd": 6e7}]}
d.fetch_open_interest_table = lambda h: {"coins": [{"token": "BTC", "by_exchange": {"okx": {"oi": 1e9, "chg_24h": 0.02}}}]}
d.fetch_twstock_list = lambda h, **k: pd.DataFrame({"name": ["台積電"]}, index=pd.Index(["2330"], name="stock_id"))
d.tw_market_public_allowed = lambda: False
d.is_tw_trading_day = lambda *a, **k: True
H = {"api-key": "x", "secret-key": "y"}

fails = 0
def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg); fails += (not cond)

def run(bricks, kpi=(), subject=None):
    r = {"id": "mix", "title": "混合報告", "lookback_days": 90, "kpi": list(kpi), "bricks": bricks}
    if subject:
        r["subject"] = subject
    return B.build(r, "2026-09-02", H)

def titled(pack):
    return [x for x in pack.blocks if x["type"] not in ("kpi_row", "footnote", "meta")]

# ── the registry covers every brick that takes one instrument ──
takes = {name: next((p for p in ("symbol", "exchange") if p in inspect.signature(fn).parameters), None) for name, fn in B.BRICKS.items()}
check({k: v for k, v in takes.items() if v} == B.SINGLE_SUBJECT,
      "SINGLE_SUBJECT 列齊每一支帶 symbol / exchange 參數的積木:" + "、".join(B.SINGLE_SUBJECT))

# ── each of them, in somebody else's report: title, KPI label and describe() key name the instrument ──
CASES = [("price_chart", {"symbol": "2330"}, "2330"), ("tw_institutional", {"symbol": "2330"}, "2330 台積電"),
         ("price_chart", {"symbol": "SOL"}, "SOL"), ("funding", {"symbol": "SOL", "variant": "symbol"}, "SOL"),
         ("funding", {"symbol": "SOL"}, "SOL"),
         ("blave_indicators", {"symbol": "SOL", "names": ["爆倉指標", "巨鯨警報", "多空力道"]}, "SOL"),
         ("coin_snapshot", {"symbol": "SOL"}, "SOL"), ("liq_map", {"symbol": "SOL"}, "SOL"),
         ("relative_to", {"symbol": "SOL"}, "SOL"), ("exchange_snapshot", {"exchange": "okx"}, "OKX")]
check({c[0] for c in CASES} == set(B.SINGLE_SUBJECT), "下面逐支跑的積木 = SINGLE_SUBJECT 全部")
for name, params, who in CASES:
    p = run([[name, params]], kpi=[name])
    blocks = titled(p)
    labels = [i["label"] for x in p.blocks if x["type"] == "kpi_row" for i in x["items"]]
    keys = [k for k in p.context if k != "資料日"]
    tag = f"{name}({list(params.values())[0]}{'/' + params['variant'] if 'variant' in params else ''})"
    check(bool(blocks) and all(x.get("title", "").startswith(who) for x in blocks),
          f"{tag}: 每個 block 的標題以「{who}」開頭 — {[x.get('title', '')[:24] for x in blocks]}")
    check(all(who.split()[0] in l for l in labels) and all(who.split()[0] in k for k in keys) and bool(keys),
          f"{tag}: KPI 標籤與 describe() 的鍵都帶標的 — {labels} / {keys}")
lv = run([["price_chart", {"symbol": "2330"}], ["levels_table", {}]])
check([x["title"] for x in lv.blocks if x["type"] == "table"] == ["2330 台積電 近期高低與均線"], "levels_table: 標題帶它前面那張 K 線的標的")
d.fetch_twfutures_institutional = lambda c, s, e, h: pd.DataFrame({"foreign_net_oi": np.linspace(-6e4, -7e4, n)}, index=days.tz_localize(None))
fx = run([["tw_futures_inst", {}], ["tw_futures_inst", {"contract": "MTX"}]])
check([x["title"][:10] for x in titled(fx)] == ["外資期貨淨部位 -7", "MTX 外資期貨淨部"] and "MTX 外資期貨淨多單" in fx.context and "外資期貨淨多單" in fx.context,
      "tw_futures_inst: 不是 TX 的商品帶商品代號,兩個商品不共用同一格")

# ── 2330 個股外資 next to the whole market's: never the same label, never the same key ──
b = B.Build({"id": "mix", "bricks": []}, "2026-09-02", H, 90)
mk, st = B.tw_institutional(b), B.tw_institutional(b, symbol="2330")
check(mk.kpis[0]["label"] == "外資買賣超" and st.kpis[0]["label"] == "2330 台積電 外資買賣超",
      "同一份報告:整體外資 KPI「外資買賣超」、個股「2330 台積電 外資買賣超」")
check({"三大法人", "外資 20 日均", "2330 台積電 外資買賣超", "2330 台積電 外資 10 日累計"} <= set(b.ctx) and "外資買賣超" not in b.ctx
      and "外資 10 日累計" not in b.ctx, "同一份報告:describe() 的鍵互不相同,個股的鍵帶代號與名稱")
check(st.blocks[0]["title"].startswith("2330 台積電 外資近 10 日") and st.blocks[0]["caption"].startswith("2330 台積電 每日淨買賣超"),
      "個股外資的圖:標題與圖說都帶「2330 台積電」")
mix = run([["price_chart", {"symbol": "TAIEX"}], ["price_chart", {"symbol": "2330"}]])
check("加權指數" in mix.context and "2330 台積電 收盤" in mix.context and "收盤位置" in mix.context and "2330 台積電 收盤位置" in mix.context,
      "大盤 K 線 + 個股 K 線:個股的收盤、收盤位置不蓋掉大盤的")

# ── a name no list knows: the id alone ──
d.fetch_twstock_list = lambda h, **k: pd.DataFrame({"name": []}, index=pd.Index([], name="stock_id"))
nn = run([["tw_institutional", {"symbol": "2409"}]])
check(titled(nn)[0]["title"].startswith("2409 外資近 10 日"), "查不到名稱:只帶代號")
d.fetch_twstock_list = lambda h, **k: pd.DataFrame({"name": ["台積電"]}, index=pd.Index(["2330"], name="stock_id"))

# ── the instrument's own report: the row stays short, the charts still say who ──
own = T.symbol_brief("2330", "2026-09-02", H)
labels = [i["label"] for x in own.blocks if x["type"] == "kpi_row" for i in x["items"]]
check(labels == ["收盤", "成交量", "外資買賣超"] and "外資買賣超" in own.context and "收盤" in own.context,
      f"2330 晨報(整份只講一檔):KPI 與 describe() 的鍵不重複代號 — {labels}")
check([x["title"][:11] for x in titled(own)] == ["2330 日 K：收盤", "2330 台積電 外資", "2330 台積電 近期"],
      f"2330 晨報:每張圖表的標題仍帶標的 — {[x['title'][:11] for x in titled(own)]}")
sol = T.symbol_brief("SOL", "2026-09-02", H)
check("資金費率" in sol.context and all(x["title"].startswith("SOL") for x in titled(sol)),
      "SOL 晨報:鍵維持「資金費率」,圖的標題帶 SOL")

shutil.rmtree(WS, ignore_errors=True)
check(not os.path.isdir(WS), "temp workspace removed at the end")
print("\n" + ("ALL PASS" if not fails else f"{fails} FAILED"))
sys.exit(1 if fails else 0)
