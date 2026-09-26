"""
Report bricks — one piece of a report each: fetch its series, lay out 0–2 blocks, contribute
KPI cells, `describe()` lines and footnote text. A recipe (`lib.report_templates.RECIPES`,
or a `recipe.json` of your own) lists bricks with their parameters; `build(recipe)` runs them
in order and assembles a `Pack` — the same `Pack` the four templates always returned.

    from lib.report_templates import build, publish
    pack = build({"id": "my-brief", "title": "我的晨報",
                  "kpi": ["price_chart", "funding"],
                  "bricks": [["price_chart", {"symbol": "BTC"}], ["funding", {"symbol": "BTC"}],
                             ["levels_table", {}]]})

Every brick takes the two roads the templates took for missing data, and only those:
`DataAccessError` → `pack.missing` (publish() names it in the footnote), any other failure →
`pack.notes` and the brick lays out nothing. `BRICKS` lists them; `brick_catalogue()` prints
each with its parameters.
"""

import math
from datetime import datetime, timedelta

import pandas as pd

from lib import data as _data
from lib import report_templates as T


class Skip(Exception):
    """The recipe's main series is not there (no data access off the desktop, a non-trading
    day): nothing to publish. Carries what the skipped Pack shows."""

    def __init__(self, reason, context=None, notes=None):
        super().__init__(reason)
        self.reason = reason
        self.context = context if context is not None else {}
        self.notes = notes if notes is not None else [reason]


class Brick:
    """What one brick hands the assembler. `foot` items are (id, text) or (id, text, "tail");
    items that share an id are joined into one footnote line, tail fragments last."""

    def __init__(self, blocks=(), kpis=(), foot=(), headline=None, finalize=None, private=False, slot=None):
        self.blocks = [b for b in blocks if b]
        if private:
            # 契約 1.4:帶持倉、成本價的 block 由產出端標 private,公開頁在 api 讀取端整塊剝掉
            self.blocks = [dict(x, private=True) for x in self.blocks]
        self.slot = slot                # "news": an agent-filled slot laid out where this brick sits
        self.kpis = list(kpis)
        self.foot = list(foot)
        self.headline = headline
        self.finalize = finalize        # callable(build) → [(id, text)] appended after every brick
        self.private = private


class Build:
    """Shared state of one recipe run: the report day, headers, the notes / missing / context
    every brick writes into (in brick order, which is the order describe() prints), and a
    cache so two bricks reading the same series fetch it once."""

    def __init__(self, recipe, date, headers, lookback_days, mode="morning"):
        self.recipe = recipe
        self.date = date
        self.headers = headers
        self.lookback_days = lookback_days
        self.mode = mode
        self.start = (datetime.strptime(date, "%Y-%m-%d") - timedelta(days=lookback_days)).strftime("%Y-%m-%d")
        self.notes, self.missing, self.ctx, self.meta = [], [], {}, {}
        self.used = set()
        self.cache = {}
        self.asof = None
        self.news = None                # set by the news brick: {"market", "n", "candidates"}


# ─── shared loaders ───────────────────────────────────────────────────────────

def _tw_index(b):
    """TAIEX daily bars (cleaned), cached. DataAccessError off the desktop → Skip."""
    if "taiex" not in b.cache:
        try:
            idx = T._clean_ohlc(T._tw_market_index(T._tw_index_start(b.date, b.start), b.date, b.headers, b.used))
        except _data.DataAccessError:
            raise Skip(_skip_text(T._TW_MARKET_SERIES)) from None
        if len(idx) < 2:
            raise ValueError(f"加權指數資料不足兩個交易日,無法產{'收盤報告' if b.mode == 'close' else '晨報'}")
        b.cache["taiex"] = idx
    return b.cache["taiex"]


def _skip_text(what):
    return f"沒有 Blave 資料,{what}全部經 Blave,這份產不出來。{T._access_fix('zh')}"


def _crypto_window_start(b):
    return T._window_start(b.lookback_days + 2)


def _crypto_closes(b, symbols):
    """{pair: close series} for the recipe's coins, one batch fetch per recipe run."""
    key = ("closes", tuple(symbols))
    if key not in b.cache:
        syms = [_data.normalize_symbol(s if s.endswith("USDT") else s + "USDT") for s in symbols]
        try:
            klines = _data.fetch_kline_batch(syms, "1d", _crypto_window_start(b), None, b.headers)
        except _data.DataAccessError:
            # Only when the kline source is Blave: the desktop sets BLAVE_KLINE_SOURCE=binance (public).
            raise Skip(_skip_text("日 K(BLAVE_KLINE_SOURCE 不是 binance)")) from None
        closes = {}
        for s in syms:
            df = klines.get(s)
            if df is None or len(df) < 2:
                b.notes.append(f"{s} 日 K 不足")
                continue
            closes[s] = df["Close"].dropna()
        if not closes:
            raise ValueError("沒有任何幣種的日 K,無法產晨報")
        b.cache[key] = closes
    return b.cache[key]


def _series_frame(b, label, blave, public, cols):
    """A TAIEX-brief flow series (Blave, else the desktop's free twin), cached by label."""
    if label not in b.cache:
        b.cache[label] = T._tw_market(blave, public, label, b.notes, b.missing, b.used, cols)
    return b.cache[label]


# ─── A. 行情 ──────────────────────────────────────────────────────────────────

def price_chart(b, symbol="TAIEX", bars=T._PRICE_BARS, display_days=None):
    """#2 K 線. `symbol`: "TAIEX" (加權指數), a 4–6 digit Taiwan stock id, or a coin (BTC).
    The price brick owns the day's headline (kpi_row title) and the 收盤位置 line.
    `display_days` (TAIEX only) draws only the bars of the last N calendar days; the 60-day
    mean and the prior-20 high are still computed on the full 90-day window."""
    s = str(symbol).strip().upper()
    if s == "TAIEX":
        return _price_taiex(b, bars, display_days)
    if s.isdigit():
        return _price_twstock(b, s, bars)
    return _price_crypto(b, s, bars)


def _price_taiex(b, bars, display_days=None):
    idx = _tw_index(b)
    date = b.date
    if b.mode == "close":
        _close_gate(b, idx)
    close, prev = float(idx["Close"].iloc[-1]), float(idx["Close"].iloc[-2])
    asof = idx.index[-1].strftime("%Y-%m-%d")
    b.asof = asof
    chg = close / prev - 1
    high20, _ = T._prior20(idx, b.notes)
    ma60 = T._mean(idx["Close"], 60)
    ctx = b.ctx
    ctx["資料日"] = asof if b.mode != "close" else date
    move = (f"{T._signed(close - prev, 2)} 點,{T._pct(chg * 100)}" if b.mode == "close" else T._pct(chg * 100))
    ctx["加權指數"] = f"{T._num(close, 2)}({move})" + (f",前 20 日高 {T._num(high20, 2)}" if high20 is not None else "")
    if ma60 is not None:
        ctx["60 日均"] = T._num(ma60, 2)
    T._where(ctx, close, [(high20, "前 20 日高"), (ma60, "60 日均")])
    if b.mode != "close" and asof != date:
        b.meta["period"] = {"from": asof[5:].replace("-", "/"), "to": date[5:].replace("-", "/")}
    shown = idx.tail(bars)
    if display_days:
        shown = shown[shown.index >= shown.index[-1] - pd.Timedelta(days=display_days)]
    ck = T.candlestick(T._price_title("加權指數", close, ma60), shown, y_unit="點",
                       caption=T._cap(f"近 {len(shown)} 個交易日日 K",
                                      f"參考線為前 20 日高 {T._num(high20, 2)}(不含當日)" if high20 is not None else None,
                                      f"60 日均 {T._num(ma60, 2)}(含當日收盤)" if ma60 is not None else None),
                       reflines=[(high20, "前 20 日高", False)] if high20 is not None else None)
    return Brick([ck], [T.kpi("加權指數", T._num(close, 2), T._tone(chg), delta=T._pct(chg * 100))],
                 headline=T._headline("加權指數", chg, close, high20, "前 20 日高"),
                 finalize=lambda b: _tw_market_foot(b))


def _tw_market_foot(b):
    foot = []
    T._tw_market_foot(foot, b.used)
    return foot


def _close_gate(b, idx):
    """台股收盤報告: `date` must be a trading day whose close has landed, else Skip."""
    date = b.date
    try:
        trading = _data.is_tw_trading_day(date, b.headers)
    except _data.DataAccessError:
        # 休市表只有 Blave 那條,但它只用來判斷是否交易日、不是報告的一塊:不進 missing(尾註不叫人綁卡),
        # 退回「今天有沒有指數收盤」判斷(下面 trading is None 那支)。
        trading = None
    last_day = idx.index[-1].strftime("%Y-%m-%d")
    if trading is None:
        b.notes.append("TWSE 休市表無法取得(" + ("沒有 Blave 資料權限" if b.used else "端點未上線或該年度尚未公布")
                       + "),是否交易日改以今日有無加權指數收盤判斷")
    skip = None
    if trading is False:
        label, src = T._closure(date, b.headers)
        skip = f"{date} 非交易日({label}),不產收盤報告;上一交易日 {last_day}"
        if src:
            b.ctx["休市表出處"] = src
            skip += f"。休市表出處(轉述時原文照附):{src}"
    elif last_day != date:
        skip = (f"{date} 的加權指數收盤尚未入庫,或今日臨時停市(颱風停市不在休市表內);"
                f"最近一個有收盤資料的交易日是 {last_day}")
    if skip:
        b.notes.append(skip)
        b.ctx["上一交易日"] = last_day
        raise Skip(skip, b.ctx, b.notes)


def _price_twstock(b, stock_id, bars):
    date = b.date
    foot = []
    try:
        df = _data.fetch_twstock_ohlcv(stock_id, "1d", b.headers, start=b.start, end=date)
    except _data.DataAccessError:
        # The daily fetcher goes to the stock's own exchange on the desktop (no key): shares → 張,
        # naive Taipei dates → the same tz the ohlcv path carries.
        try:
            df = _data.fetch_twstock_price(stock_id, b.start, date, b.headers)
        except _data.DataAccessError as e:
            # A cause means the free chain ran and failed (lib.data chains it): that is the
            # real error, not a data-access one — never "add a card" for an exchange outage.
            if e.__cause__ is not None:
                raise ValueError(f"{stock_id} 免費日線抓不到({type(e.__cause__).__name__}: "
                                 f"{str(e.__cause__)[:120]})") from e.__cause__
            raise Skip(_skip_text("日 K")) from None
        if df is None or df.empty:
            raise ValueError(f"{stock_id} 日 K 不足兩個交易日")
        src = df.attrs.get("source")
        if not src:
            # The exchanges' licence makes naming the source a condition: no source, no report.
            raise ValueError(f"{stock_id} 免費日線沒有帶 attrs['source'],無法標示資料來源")
        df = df.copy()
        df["Volume"] = df["Volume"] / 1000.0
        if df.index.tz is None:
            df.index = df.index.tz_localize("Asia/Taipei")
        # publish(lang="en") swaps it through lib.data.PUBLIC_SOURCE_EN.
        foot.append(("src_free", _data._TW_PUBLIC_SOURCE_ZH if src in ("TWSE", "TPEx") else f"資料來源:{src}"))
    df = T._clean_ohlc(df) if df is not None else df
    if df is None or len(df) < 2:
        raise ValueError(f"{stock_id} 日 K 不足兩個交易日")
    c = df["Close"].dropna()
    last, prev = float(c.iloc[-1]), float(c.iloc[-2])
    chg = last / prev - 1
    vol, vol5 = float(df["Volume"].iloc[-1]), float(df["Volume"].tail(5).mean())
    ctx = b.ctx
    ctx["資料日"] = str(c.index[-1].date())
    ctx["收盤"] = f"{T._num(last, 2)}({T._pct(chg * 100)}),量 {T._num(vol)} 張(5 日均 {T._num(vol5)})"
    lv = _levels_into(b, df, last)
    b.cache["levels"] = (lv, last, "tw")
    ck = T.candlestick(T._price_title(f"{stock_id} 日 K", last, lv.get("60 日均")), df.tail(bars), y_unit="元",
                       caption=T._cap(f"近 {min(len(df), bars)} 個交易日日 K,未還原價", _level_ref(lv),
                                      f"60 日均 {T._num(lv['60 日均'], 2)}" if "60 日均" in lv else None),
                       reflines=T._level_lines(lv))
    foot.append(("src", "日 K 為未還原價" if foot else "日 K 為 TWSE 未還原價"))
    kpis = [T.kpi("收盤", T._num(last, 2), T._tone(chg), delta=T._pct(chg * 100)),
            T.kpi("成交量", T._num(vol), "neutral", unit="張", delta=T._pct((vol / vol5 - 1) * 100) + " vs 5日均")]
    return Brick([ck], kpis, foot, headline=T._headline(stock_id, chg, last, lv.get("前 20 日高"), "前 20 日高"))


def _price_crypto(b, sym, bars):
    s = _data.normalize_symbol(sym if sym.endswith("USDT") else sym + "USDT")
    label = s.replace("USDT", "")
    try:
        df = _data.fetch_kline(s, "1d", _crypto_window_start(b), None, b.headers)
    except _data.DataAccessError:
        raise Skip(_skip_text("日 K(BLAVE_KLINE_SOURCE 不是 binance)")) from None
    df = T._clean_ohlc(df) if df is not None else df
    if df is None or len(df) < 2:
        raise ValueError(f"{s} 日 K 不足")
    c = df["Close"].dropna()
    last, chg = float(c.iloc[-1]), float(c.iloc[-1] / c.iloc[-2] - 1)
    ctx = b.ctx
    ctx["資料日"] = str(c.index[-1].date())
    ctx["價格"] = f"{T._num(last, 2)} USDT({T._pct(chg * 100)})"
    lv = _levels_into(b, df, last)
    b.cache["levels"] = (lv, last, "crypto")
    # 60 日均仍用整段收盤算,K 線只畫最後 bars 根。
    ck = T.candlestick(T._price_title(f"{label} 日 K", last, lv.get("60 日均")), df.tail(bars), y_unit="USDT",
                       caption=T._cap(f"近 {min(len(df), bars)} 根日 K", _level_ref(lv),
                                      f"60 日均 {T._num(lv['60 日均'], 2)}" if "60 日均" in lv else None),
                       reflines=T._level_lines(lv))
    foot = [("src", "價格:Binance USDT 永續日 K,最後一根為今日未收盤 bar。")]
    return Brick([ck], [T.kpi(label, T._num(last, 2), T._tone(chg), unit="USDT", delta=T._pct(chg * 100))], foot,
                 headline=T._headline(label, chg, last, lv.get("前 20 日高"), "前 20 日高"))


def _levels_into(b, df, last):
    lv = T._levels(df, b.notes)
    b.ctx[T._LEVELS_TITLE] = ", ".join(f"{k} {T._num(v, 2)}" for k, v in lv.items())
    T._where(b.ctx, last, [(lv.get("前 20 日高"), "前 20 日高"), (lv.get("60 日均"), "60 日均")])
    return lv


def _level_ref(lv):
    if "前 20 日高" not in lv:
        return None
    return ("參考線為前 20 日高 " + T._num(lv["前 20 日高"], 2) + " / 低 " + T._num(lv["前 20 日低"], 2) + "(不含當日)")


def quote_table(b, symbols=("BTC", "ETH", "SOL"), kpi_n=2, top_mcap=0):
    """#3 多標的報價表 (crypto): price, 1 / 7 / N-day return per coin; the first `kpi_n` coins
    go to the KPI row, and the first coin's position against its N-day mean is the headline.
    `top_mcap`: add the N largest coins by market cap (Blave open-interest table; left out
    without data access) after `symbols`."""
    lookback = b.lookback_days
    symbols = list(symbols) + _top_mcap(b, symbols, top_mcap)
    b.cache["crypto_symbols"] = symbols
    closes = _crypto_closes(b, symbols)
    rows, kpis = [], []
    ctx = b.ctx
    for s, c in closes.items():
        last = float(c.iloc[-1])
        r1 = c.iloc[-1] / c.iloc[-2] - 1
        r7 = c.iloc[-1] / c.iloc[-8] - 1 if len(c) > 8 else None
        r30 = c.iloc[-1] / c.iloc[-(lookback + 1)] - 1 if len(c) > lookback else None
        label = s.replace("USDT", "")
        rows.append({"symbol": label, "price": T._num(last, 2), "r1": T._pct(r1 * 100),
                     "r7": T._pct(r7 * 100) if r7 is not None else None,
                     "r30": T._pct(r30 * 100) if r30 is not None else None})
        ctx[label] = f"{T._num(last, 2)},1d {T._pct(r1 * 100)}" + (f",30d {T._pct(r30 * 100)}" if r30 is not None else "")
        if len(kpis) < kpi_n:
            kpis.append(T.kpi(label, T._num(last, 2), T._tone(r1), unit="USDT", delta=T._pct(r1 * 100)))
    ctx["資料日"] = str(next(iter(closes.values())).index[-1].date())
    base = next(iter(closes))
    base_c = closes[base]
    base_ma = T._mean(base_c, lookback)
    if base_ma is not None:
        ctx[f"{base.replace('USDT', '')} 近 {lookback} 日均"] = T._num(base_ma, 2)
        T._where(ctx, float(base_c.iloc[-1]), [(base_ma, f"近 {lookback} 日均")])
    headline = T._headline(base.replace("USDT", ""), float(base_c.iloc[-1] / base_c.iloc[-2] - 1),
                           float(base_c.iloc[-1]), base_ma, f"近 {lookback} 日均")
    by1 = sorted(((float(c.iloc[-1] / c.iloc[-2] - 1), s.replace("USDT", "")) for s, c in closes.items()), reverse=True)
    title = (f"1 日最強 {by1[0][1]} {T._pct(by1[0][0] * 100)},最弱 {by1[-1][1]} {T._pct(by1[-1][0] * 100)}"
             if len(by1) > 1 else "主要幣種報價與報酬")
    tb = T.table(title, [("symbol", "幣種", "left"), ("price", "價格", "right"),
                                       ("r1", "1 日", "right", "percent"), ("r7", "7 日", "right", "percent"),
                                       ("r30", f"{lookback} 日", "right", "percent")], rows,
                 caption="Binance USDT 永續日 K 收盤;最後一根為今日未收盤 bar")
    return Brick([tb], kpis, [("src", "價格:Binance USDT 永續日 K。")], headline=headline)


def relative_perf(b, symbols=("BTC", "ETH", "SOL")):
    """#4 相對表現: each coin rebased to 100 on the window's first day (≤4 lines)."""
    lookback = b.lookback_days
    closes = _crypto_closes(b, symbols)
    base = next(iter(closes))
    win = {s: c.tail(lookback + 1) for s, c in closes.items()}   # 圖與表同一個 N 日窗口
    series = [(base.replace("USDT", ""), "primary", win[base] / win[base].iloc[0] * 100)]
    series += [(s.replace("USDT", ""), "benchmark", c / c.iloc[0] * 100) for s, c in win.items() if s != base][:3]
    rel = sorted(((float(c.iloc[-1] / c.iloc[0] * 100 - 100), s.replace("USDT", "")) for s, c in win.items()),
                 reverse=True)
    spread = f"{rel[0][1]} 領先 {rel[-1][1]} {rel[0][0] - rel[-1][0]:,.1f} 個百分點" if len(rel) > 1 else None
    if spread:
        b.ctx[f"{lookback} 日相對表現"] = spread
    lc = T.line_chart(f"相對表現(重定基 100,{lookback} 日)" + (f":{spread}" if spread else ""), series, y_unit="",
                      caption=T._cap("每個幣種以窗口第一天收盤為 100",
                                     f"窗口報酬 {rel[0][1]} {rel[0][0]:+,.1f}%、{rel[-1][1]} {rel[-1][0]:+,.1f}%"
                                     if len(rel) > 1 else None))
    return Brick([lc], foot=[("src", "價格:Binance USDT 永續日 K。")])


def tw_turnover(b):
    """成交值 (KPI only): the day's TWSE turnover against its 5-day mean."""
    date, cols = b.date, _data._TWMARKET_TURNOVER_COLUMNS
    turn = _series_frame(b, "成交值", lambda: _data.fetch_twmarket_turnover(b.start, date, b.headers),
                         lambda: _data.fetch_twmarket_turnover_public(b.start, date), cols)
    if b.mode == "close":
        if not (T._on_day(turn, date) and T._finite(turn["value"].iloc[-1])):
            T._pending("成交值", turn, date, b.notes)
            return Brick()
        val = float(turn["value"].iloc[-1])
    else:
        val, _ = T._last_two(turn["value"]) if len(turn) else (None, None)
        if val is None:
            b.notes.append("成交值無資料")
            return Brick()
    avg5 = float(turn["value"].tail(5).mean())
    b.ctx["成交值"] = f"{val / 1e12:.2f} 兆(5 日均 {avg5 / 1e12:.2f} 兆)"
    return Brick(kpis=[T.kpi("成交值", f"{val / 1e12:.2f}", "neutral", unit="兆",
                             delta=T._pct((val / avg5 - 1) * 100) + " vs 5日均")])


# ─── B. 籌碼與衍生品 ──────────────────────────────────────────────────────────

def tw_institutional(b, symbol=None):
    """#7 三大法人. `symbol=None` = the whole market (bar chart of the day's three buyers);
    a stock id = that stock's 外資買賣超 (張) and its last 10 sessions."""
    if symbol:
        return _inst_stock(b, str(symbol))
    date = b.date
    inst = _series_frame(b, "三大法人", lambda: _data.fetch_twmarket_institutional(b.start, date, b.headers),
                         lambda: _data.fetch_twmarket_institutional_public(b.start, date),
                         _data._TWMARKET_INST_COLUMNS)
    cols = ("foreign", "investment_trust", "dealer", "total")
    close = b.mode == "close"
    ok = (T._on_day(inst, date) if close else len(inst)) and all(T._finite(inst[c].iloc[-1]) for c in cols)
    if not ok:
        if close:
            T._pending("三大法人", inst, date, b.notes)
        else:
            b.notes.append("三大法人無資料")
        return Brick()
    last = inst.iloc[-1]
    f_prev = float(inst["foreign"].iloc[-2]) if len(inst) > 1 and T._finite(inst["foreign"].iloc[-2]) else None
    b.ctx["三大法人"] = (f"外資 {T._tw_yi(last['foreign'])}({'前一交易日' if close else '昨'} "
                      f"{T._tw_yi(f_prev) if f_prev is not None else '—'})、"
                      f"投信 {T._tw_yi(last['investment_trust'])}、自營 {T._tw_yi(last['dealer'])}、"
                      f"合計 {T._tw_yi(last['total'])}")
    # 指數可能已是今天、籌碼還是昨天:日期不同的 KPI 在 delta 標日期,讀者才不會把兩天讀成同一天。
    k = (T.kpi("外資買賣超", T._tw_yi(float(last["foreign"])), T._tone(float(last["foreign"]))) if close else
         T.kpi("外資買賣超", T._tw_yi(float(last["foreign"])), T._tone(float(last["foreign"])),
               delta=T._dated("", inst.index[-1], b.asof)))
    f20 = T._mean(inst["foreign"], 20)
    if f20 is not None:
        b.ctx["外資 20 日均"] = T._tw_yi(f20)
    day = date if close else inst.index[-1].strftime("%Y-%m-%d")
    # 合計不佔 KPI 格(六格要留給夜盤),寫在長條圖說明裡。
    fv = float(last["foreign"])
    title = f"外資{'買' if fv >= 0 else '賣'}超 {abs(fv) / 1e8:,.1f} 億" + (
        f",20 日均{'買' if f20 >= 0 else '賣'}超 {abs(f20) / 1e8:,.1f} 億" if f20 is not None else "")
    bc = T.bar_chart(title,
                     [("外資", last["foreign"] / 1e8), ("投信", last["investment_trust"] / 1e8),
                      ("自營商", last["dealer"] / 1e8)],
                     caption=T._cap(f"{day} 淨買賣超金額,億元",
                                    f"三大法人合計 {T._tw_yi(float(last['total']))}",
                                    f"外資近 20 個交易日平均 {T._tw_yi(f20)}" if f20 is not None else None))
    return Brick([bc], [k])


def _inst_stock(b, stock_id):
    inst = None
    try:
        inst = _data.fetch_twstock_institutional(stock_id, b.start, b.date, b.headers)
    except _data.DataAccessError:
        T._no_access("外資買賣超", b.notes, b.missing)
    except Exception as e:
        b.notes.append(f"外資買賣超抓取失敗({type(e).__name__})")
    if inst is None or not len(inst) or "foreign_net" not in inst:
        return Brick()
    kpis, foot = [], []
    fn = inst["foreign_net"].dropna() / 1000.0   # 股 → 張
    if len(fn):
        f_last = float(fn.iloc[-1])
        f5 = float(fn.tail(5).sum())
        b.ctx["外資買賣超"] = f"{T._signed(f_last)} 張(近 5 日累計 {T._signed(f5)} 張,{fn.index[-1].date()})"
        kpis.append(T.kpi("外資買賣超", T._signed(f_last), T._tone(f_last), unit="張", delta=f"5日累計 {T._signed(f5)}"))
        foot.append(("inst", "外資買賣超 = 外資買進 − 賣出,資料源以股為單位,此處換算為張(÷1000)。"))
    net = inst["foreign_net"].dropna() / 1000.0
    tail = net.tail(10)
    f10 = float(tail.sum())
    prev10 = float(net.tail(20).head(10).sum()) if len(net) >= 20 else None
    b.ctx["外資 10 日累計"] = f"{T._signed(f10)} 張" + (f"(前 10 日 {T._signed(prev10)} 張)" if prev10 is not None else "")
    title = f"外資近 10 日{'買' if f10 >= 0 else '賣'}超 {abs(f10):,.0f} 張" + (
        f",前 10 日{'買' if prev10 >= 0 else '賣'}超 {abs(prev10):,.0f} 張" if prev10 is not None else "")
    bc = T.bar_chart(title, [(t.strftime("%m/%d"), v) for t, v in tail.items()],
                     caption=T._cap("每日淨買賣超,張",
                                    f"10 日累計 {T._signed(f10)} 張,前 10 個交易日累計 {T._signed(prev10)} 張"
                                    if prev10 is not None else f"10 日累計 {T._signed(f10)} 張"))
    return Brick([bc], kpis, foot)


def tw_margin(b, chart=True):
    """#8 融資餘額 (萬張): KPI plus, unless `chart=False`, the line of the lookback window."""
    date = b.date
    mg = _series_frame(b, "融資餘額", lambda: _data.fetch_twmarket_margin(b.start, date, b.headers),
                       lambda: _data.fetch_twmarket_margin_public(b.start, date), _data._TWMARKET_MARGIN_COLUMNS)
    close = b.mode == "close"
    m20 = T._mean(mg["margin_balance"], 20) if len(mg) else None
    if close:
        if not (T._on_day(mg, date) and T._finite(mg["margin_balance"].iloc[-1])):
            T._pending("融資餘額", mg, date, b.notes)
            return Brick()
        m_last, m_prev = T._last_two(mg["margin_balance"])
    else:
        m_last, m_prev = T._last_two(mg["margin_balance"]) if len(mg) else (None, None)
        if m_last is None:
            b.notes.append("融資餘額無資料")
            return Brick()
    d_m = (m_last - m_prev) if m_prev is not None else 0.0
    b.ctx["融資餘額"] = f"{m_last / 1e4:,.1f} 萬張({T._signed(d_m / 1e4, 1)} 萬張)"
    if m20 is not None:
        b.ctx["融資 20 日均"] = f"{m20 / 1e4:,.1f} 萬張"
    delta = f"{T._signed(d_m / 1e4, 1)} 萬張"
    k = T.kpi("融資餘額", f"{m_last / 1e4:,.1f}", "neutral", unit="萬張",
              delta=delta if close else T._dated(delta, mg.index[-1], b.asof))
    foot = [("margin", "融資增減 = 今日餘額 − 前一交易日餘額(實際餘額變化)。TWSE 的「前日餘額」欄已含"
                       "拆分、減資等公司行動調整,這類日子兩種算法會不同。")] if close else []
    lc = None
    if chart:
        title = f"融資 {m_last / 1e4:,.1f} 萬張" + (
            f",比 20 日均{'多' if m_last >= m20 else '少'} {abs(m_last - m20) / 1e4:,.1f} 萬張" if m20 is not None else "")
        lc = T.line_chart(title, [("融資餘額", "primary", mg["margin_balance"] / 1e4)], y_unit="萬張",
                          caption=T._cap("TWSE 日融資餘額,張數(圖為萬張)",
                                         f"最新 {m_last / 1e4:,.1f} 萬張,近 20 個交易日平均 {m20 / 1e4:,.1f} 萬張"
                                         if m20 is not None else None))
    return Brick([lc], [k], foot)


def tw_futures_inst(b, contract="TX"):
    """#9 外資期貨淨多單 (口): KPI plus the line with its 0 reference."""
    date = b.date
    fut = None
    try:
        fut = _series_frame(b, "外資期貨淨多單",
                            lambda: _data.fetch_twfutures_institutional(contract, b.start, date, b.headers),
                            lambda: _data.fetch_twfutures_institutional_public(contract, b.start, date),
                            _data._TWFUT_INST_COLUMNS)
    except Exception as e:
        b.notes.append(f"期貨三大法人抓取失敗({type(e).__name__})")
    close = b.mode == "close"
    n20 = T._mean(fut["foreign_net_oi"], 20) if fut is not None and len(fut) else None
    if close:
        ok = fut is not None and T._on_day(fut, date) and T._finite(fut["foreign_net_oi"].iloc[-1])
        if not ok:
            if fut is not None:
                T._pending("外資期貨淨多單", fut, date, b.notes)
            return Brick()
    elif fut is None or not len(fut):
        return Brick()
    f_last, f_prev = T._last_two(fut["foreign_net_oi"])
    d_f = (f_last - f_prev) if f_prev is not None else 0.0
    b.ctx["外資期貨淨多單"] = (f"{T._signed(f_last)} 口({T._signed(d_f)} 口)" if close else
                          f"{T._signed(f_last)} 口({T._signed(d_f)} 口,{fut.index[-1].strftime('%m-%d')})")
    if n20 is not None:
        b.ctx["外資期貨 20 日均"] = f"{T._signed(n20)} 口"
    # 淨部位是方向不是損益:長期淨空會永遠紅,上色沒有資訊,一律 neutral。
    delta = T._signed(d_f) + " 口"
    k = T.kpi("外資期貨淨多單", T._signed(f_last), "neutral", unit="口",
              delta=delta if close else T._dated(delta, fut.index[-1], b.asof))
    foot = [("futinst", "期貨三大法人為 TAIFEX 日盤收盤後統計的未平倉淨口數(多 − 空)。" if close else
             "期貨三大法人為 TAIFEX 盤後統計,晨報引用的是前一交易日收盤後的未平倉淨口數(多 − 空)。")]
    title = f"外資期貨淨部位 {T._signed(f_last)} 口" + (f",20 日均 {T._signed(n20)} 口" if n20 is not None else "")
    lc = T.line_chart(title, [("外資淨多單", "primary", fut["foreign_net_oi"])], y_unit="口",
                      caption=T._cap("TAIFEX 盤後未平倉淨口數(多 − 空)",
                                     f"最新 {T._signed(f_last)} 口,近 20 個交易日平均 {T._signed(n20)} 口"
                                     if n20 is not None else None),
                      reflines=[(0.0, "0", False)])
    return Brick([lc], [k], foot)


def txf_night(b):
    """台指期夜盤 (KPI only): the last night session after the data day, labelled live until 05:00."""
    night = T._txf_night_session(b.headers, b.asof, b.notes, b.missing)
    if not night:
        return Brick()
    b.ctx["台指期夜盤"] = (f"{T._num(night['close'])}({night['state']};{T._pct(night['chg'] * 100)} "
                        f"vs 日盤收 {T._num(night['day_close'])})")
    label = "台指期夜盤" if night["done"] else f"台指期夜盤({night['state']})"
    foot = [("night", "台指期夜盤 = 15:00 至次日 05:00 的交易時段,漲跌以同日日盤收盤價為基準。"
             + ("" if night["done"] else "數值為截至標示時點的最新價,不是收盤價。"))]
    return Brick(kpis=[T.kpi(label, T._num(night["close"]), T._tone(night["chg"]), delta=T._pct(night["chg"] * 100))],
                 foot=foot)


def funding(b, symbol="BTC", variant="market", chart=True):
    """#13 資金費率 (Binance, daily, %): KPI plus the line with its 0 reference. `variant`
    "market" labels it with the coin (a market brief), "symbol" plain 資金費率 (a coin's brief)."""
    s = _data.normalize_symbol(symbol if symbol.endswith("USDT") else symbol + "USDT")
    coin = s.replace("USDT", "")
    market = variant == "market"
    name = f"{coin} 資金費率" if market else "資金費率"
    kpis = []
    ser = T._indicator(_data.fetch_funding_rate, (s, "1d", _crypto_window_start(b), None, b.headers), name,
                       b.ctx, kpis, b.notes, b.missing, fmt=lambda v: f"{v:+.4f}%")
    if ser is None:
        return Brick()
    if not chart:
        return Brick(kpis=kpis, foot=[("src", "資金費率為 Binance 日頻,單位 %。")])
    lc = T.line_chart(f"{name} {float(ser.iloc[-1]):+.4f}%,7 日均 {float(ser.tail(7).mean()):+.4f}%",
                      [(coin, "primary", ser)], y_unit="%", reflines=[(0.0, "0", False)],
                      caption=T._cap(f"Binance {s} 日頻資金費率,單位 %" if market else "Binance 日頻資金費率,單位 %",
                                     T._vs7(ser, lambda v: f"{v:+.4f}%")))
    foot = ([("src", "資金費率為 Binance 日頻,單位 %。"), ("src", "日頻指標只到前一個完整日。", "tail")] if market
            else [("src", "資金費率單位 %。")])
    return Brick([lc], kpis, foot)


_INDICATORS = {
    "市場方向": ("fetch_market_direction", False), "資金稀缺": ("fetch_capital_shortage", False),
    "頂尖交易員曝險": ("fetch_top_trader_exposure", False),
    "爆倉指標": ("fetch_liquidation", True), "巨鯨警報": ("fetch_whale_hunter", True),
    "多空力道": ("fetch_taker_intensity", True),
}
# 不是 z-score 的那一支(實測值約 20–30):不能跟 z-score 同軸,單獨一張、不標單位。
_RAW_INDICATORS = ("頂尖交易員曝險",)


def blave_indicators(b, names=("市場方向", "資金稀缺", "頂尖交易員曝險"), symbol=None, kpi=None, raw_chart=True):
    """#15 Blave 指標: the z-score series share one line chart (≤4); 頂尖交易員曝險 (raw value)
    gets its own unless `raw_chart=False`. Market-wide names need no symbol; 爆倉 / 巨鯨 /
    多空力道 are per coin. `kpi`: which names go to the KPI row (default all)."""
    kpis, got = [], {}
    s = _data.normalize_symbol(symbol if symbol.endswith("USDT") else symbol + "USDT") if symbol else None
    start = _crypto_window_start(b)
    for n in names:
        fn_name, per_coin = _INDICATORS[n]
        args = (s, "1d", start, None, b.headers) if per_coin else ("1d", start, None, b.headers)
        mine = []
        got[n] = T._indicator(getattr(_data, fn_name), args, n, b.ctx, mine, b.notes, b.missing,
                              gloss="正 = 淨多" if n in _RAW_INDICATORS else "0 = 歷史平均")
        if kpi is None or n in kpi:
            kpis += mine
    z = [(n, "benchmark", x) for n, x in got.items() if x is not None and n not in _RAW_INDICATORS]
    blocks, foot = [], []
    if z:
        z[0] = (z[0][0], "primary", z[0][2])
        z0 = z[0][2]
        blocks.append(T.line_chart(f"{z[0][0]} {float(z0.iloc[-1]):+.2f}(0 = 歷史平均),7 日均 {float(z0.tail(7).mean()):+.2f}", z[:4],
                                   caption=T._cap("標準化分數,0 = 樣本均值", "日頻資料只到前一個完整日",
                                                  f"{z[0][0]} {T._vs7(z[0][2])}")))
    raw = [(n, x) for n, x in got.items() if x is not None and n in _RAW_INDICATORS]
    for n, x in (raw if raw_chart else []):
        blocks.append(T.line_chart(f"{n} {float(x.iloc[-1]):+.2f}(正 = 淨多),7 日均 {float(x.tail(7).mean()):+.2f}",
                                   [("曝險", "primary", x)],
                                   caption=T._cap("Blave 頂尖交易員曝險指標原始值(非標準化),日頻資料只到前一個完整日",
                                                  T._vs7(x))))
    if symbol:
        if z:
            foot.append(("src", "爆倉 / 巨鯨 / 多空力道為 Blave 指標 z-score。"))
    else:
        if z:
            foot.append(("src", "市場方向 / 資金稀缺為 Blave 指標(z-score)" + (";" if raw else "。")))
        if raw:
            foot.append(("src", "頂尖交易員曝險為指標原始值。"))
        if z or raw:
            foot.append(("src", "日頻指標只到前一個完整日。", "tail"))
    return Brick(blocks, kpis, foot)


# ─── C. 事件 ──────────────────────────────────────────────────────────────────

def event_calendar(b, countries=("US", "CN", "TW", "JP", "EU"), today_only=False, dividends=False):
    """#19 今日事件: macro events (鉅亨經濟日曆, priority 1–2) and, with `dividends`, today's
    除權息 — the TAIEX dividend points and the ex-dates of the stocks the movers brick listed.
    `today_only`: leave it out when the report day is not today (the calendar only knows 'now')."""
    if today_only and b.date != T._today_tpe():   # 經濟日曆只查得到「今天」;補產過去日期的報告不附別天的事件
        return Brick()
    rows = T._calendar_rows(b.headers, b.notes, b.missing, countries=list(countries))
    div = _dividend_rows(b) if dividends else []
    if not rows and not div:
        return Brick()
    # 事件表沒有比較基準可寫:它是時刻表不是量測,caption 只留口徑(預期/前值已在欄位裡)。
    title = "今日總經事件" if not div else "今日總經與除權息事件"
    cap = "台北時間;priority 1–2 的事件" + (";除權息列加權指數除息點數與成交值前 10 檔的除權息日" if div else "")
    return Brick([T.table(title, T._CAL_COLUMNS, rows + div, caption=cap)])


def _dividend_rows(b):
    day, rows = b.date, []
    try:
        pts = _data.fetch_twmarket_dividend_points(day, day, b.headers)
    except _data.DataAccessError:
        T._no_access("除權息", b.notes, b.missing)
        return []
    except Exception as e:
        b.notes.append(f"加權指數除息點數抓取失敗({type(e).__name__})")
        pts = None
    if pts is not None and len(pts) and T._finite(pts["points"].iloc[-1]) and float(pts["points"].iloc[-1]) > 0:
        est = bool(pts["estimated"].iloc[-1]) if "estimated" in pts else False
        rows.append({"time": "—", "country": "除權息",
                     "subject": f"加權指數除息 {float(pts['points'].iloc[-1]):.1f} 點" + ("(預估)" if est else ""),
                     "predict": None, "last": None})
        b.ctx["加權指數除息"] = f"{float(pts['points'].iloc[-1]):.1f} 點" + ("(預估)" if est else "")
    ids = b.cache.get("tw_movers_ids") or []
    if ids:
        try:
            got = _data.fetch_twstock_dividend_batch(ids, day, day, b.headers)
        except Exception as e:
            b.notes.append(f"個股除權息抓取失敗({type(e).__name__})")
            got = {}
        for sid in ids:
            df = got.get(sid)
            for _, r in (df if df is not None else pd.DataFrame()).iterrows():
                kind = [k for k, col, amt in (("除息", "cash_ex_date", "cash"), ("除權", "stock_ex_date", "stock"))
                        if r.get(col) == day and T._finite(r.get(amt)) and float(r[amt]) > 0]
                if kind:
                    rows.append({"time": "—", "country": "除權息", "subject": f"{sid} " + "、".join(kind)
                                 + (f" 現金 {float(r['cash']):g} 元" if "除息" in kind else ""),
                                 "predict": None, "last": None})
    return rows


# ─── D. 位置 ──────────────────────────────────────────────────────────────────

def levels_table(b):
    """#20 近期高低與均線 — needs a `price_chart` of a single stock / coin earlier in the recipe."""
    if "levels" not in b.cache:
        b.notes.append("近期高低與均線 需要配方裡先有單一標的的 price_chart,省略")
        return Brick()
    lv, last, kind = b.cache["levels"]
    tail = ("前 20 日高/低 = 不含當日(今日未收盤 bar)的前 20 根日 K 最高價/最低價,均線取收盤價(含當日)。"
            if kind == "crypto" else
            ",成交量為張。前 20 日高/低 = 不含當日的前 20 個交易日最高價/最低價,均線取收盤價(含當日)。")
    return Brick([T._levels_table(lv, last)], foot=[("src", tail, "tail")])


# ─── 0.1.7 新積木 ─────────────────────────────────────────────────────────────

def _cached(b, key, fn):
    """A B付 snapshot shared by several bricks; the DataAccessError / failure is cached too so
    the second brick does not ask again (and does not name it missing twice)."""
    if key not in b.cache:
        try:
            b.cache[key] = ("ok", fn())
        except _data.DataAccessError as e:
            b.cache[key] = ("denied", e)
        except Exception as e:
            b.cache[key] = ("failed", e)
    return b.cache[key]


def _snapshot(b, key, fn, name):
    state, val = _cached(b, key, fn)
    if state == "ok":
        return val
    if state == "denied":
        if name not in [m["name"] for m in b.missing]:
            T._no_access(name, b.notes, b.missing)
    elif not any(n.startswith(name) for n in b.notes):
        b.notes.append(f"{name} 抓取失敗({type(val).__name__})")
    return None


def _oi_table(b):
    return _snapshot(b, "oi_table", lambda: _data.fetch_open_interest_table(b.headers), "未平倉量")


def _top_mcap(b, have, n):
    if not n:
        return []
    table = _oi_table(b)
    if not table:
        return []
    have = {s.upper().replace("USDT", "") for s in have}
    coins = sorted((c for c in table.get("coins") or [] if T._finite(c.get("market_cap"))),
                   key=lambda c: -float(c["market_cap"]))
    return [c["token"] for c in coins if c.get("token") and c["token"].upper() not in have][:n]


def _usd(v):
    v = float(v)
    for div, unit in ((1e9, "B"), (1e6, "M"), (1e3, "K")):
        if abs(v) >= div:
            return f"{v / div:,.1f}{unit}"
    return f"{v:,.0f}"


def liquidation(b, hours=24):
    """#11 爆倉: every exchange's forced liquidations over the last `hours` (USD notional,
    bars per exchange); the KPI is the total with the share that was longs."""
    data = _snapshot(b, ("liq", hours), lambda: _data.fetch_liquidation_exchanges(b.headers, hours=hours, top_n=10),
                     f"{hours}h 爆倉")
    if not data:
        return Brick()
    tot = data.get("total") or {}
    total, longs = tot.get("total_liq_usd"), tot.get("long_liq_usd")
    if not (T._finite(total) and float(total) > 0 and T._finite(longs)):
        b.notes.append(f"{hours}h 爆倉 無資料")
        return Brick()
    lp = float(longs) / float(total) * 100
    b.ctx[f"{hours}h 爆倉"] = f"{_usd(total)} USD,多單佔 {lp:.0f}%"
    rows = sorted(((x.get("exchange") or "?", x.get("total_liq_usd")) for x in data.get("exchanges") or []
                   if T._finite(x.get("total_liq_usd")) and float(x["total_liq_usd"]) > 0), key=lambda r: -float(r[1]))
    bc = T.bar_chart(f"{hours}h 爆倉 {_usd(total)} USD,多單佔 {lp:.0f}%",
                     [(name.capitalize(), float(v) / 1e6) for name, v in rows],
                     caption=f"各交易所強平名目金額,百萬 USD;滾動 {hours} 小時,5 分鐘對齊。多單爆倉 = 價格下跌被強平的多方部位")
    return Brick([bc], [T.kpi(f"{hours}h 爆倉", _usd(total), "neutral", unit="USD", delta=f"多單佔 {lp:.0f}%")],
                 [("liq", "爆倉為 Blave 彙整的各交易所強平名目金額(USD,採集時換算),各所價格口徑與涵蓋度不同。")])


def derivs_table(b, symbols=None):
    """#14 衍生品總表: one row per coin — OI 24h change, latest funding, Binance account
    long/short ratio. Directions, not P&L: every column is text (no gain / loss colour).
    A source without data access drops its column; all three gone → no block."""
    syms = [s.upper().replace("USDT", "") for s in (symbols or b.cache.get("crypto_symbols") or ("BTC", "ETH", "SOL"))][:8]
    oi = _oi_table(b)
    lsr = _snapshot(b, "lsr_table", lambda: _data.fetch_long_short_ratio_table(b.headers), "多空比")
    start = _crypto_window_start(b)
    fund, denied = {}, False
    for c in syms:
        try:
            df = _data.fetch_funding_rate(f"{c}USDT", "1d", start, None, b.headers)
        except _data.DataAccessError:
            denied = True
            break
        except Exception:
            continue
        ser = df["alpha"].dropna() if df is not None and "alpha" in df else None
        if ser is not None and len(ser):
            fund[c] = float(ser.iloc[-1])
    if denied and not any("資金費率" in m["name"] for m in b.missing):
        T._no_access("資金費率", b.notes, b.missing)
    oi_by = {str(c.get("token", "")).upper(): c for c in (oi or {}).get("coins") or []}
    key = next((x.get("key") for x in (lsr or {}).get("sources") or []
                if x.get("exchange") == "binance" and x.get("type") == "account"), None)
    lsr_by = {str(c.get("token", "")).upper(): c.get(key) for c in (lsr or {}).get("coins") or []} if key else {}
    cols = [("coin", "幣種", "left")]
    if oi_by:
        cols.append(("oi", "OI 24h", "right"))
    if fund:
        cols.append(("fund", "資金費率", "right"))
    if lsr_by:
        cols.append(("lsr", "多空比", "right"))
    if len(cols) == 1:
        return Brick()
    rows, best = [], None
    for c in syms:
        r = {"coin": c}
        chg = (oi_by.get(c) or {}).get("chg_24h")
        if T._finite(chg):
            r["oi"] = T._pct(float(chg) * 100, 1)
            if best is None or float(chg) > best[1]:
                best = (c, float(chg))
        if c in fund:
            r["fund"] = f"{fund[c]:+.4f}%"
        if T._finite(lsr_by.get(c)):
            r["lsr"] = f"{float(lsr_by[c]):.2f}"
        rows.append(r)
    if best:
        b.ctx["OI 24h 最大增幅"] = f"{best[0]} {T._pct(best[1] * 100, 1)}"
    parts = []
    if oi_by:
        parts.append("OI = USDT 本位永續未平倉名目(USD,單邊)的 24h 變化")
    if fund:
        parts.append("資金費率為 Binance 日頻最新值")
    if lsr_by:
        parts.append("多空比 = Binance 帳戶數多單 ÷ 空單")
    title = f"OI 24h 增幅最大:{best[0]} {T._pct(best[1] * 100, 1)}" if best else "衍生品總表"
    return Brick([T.table(title, cols, rows, caption=";".join(parts))])


def movers(b, market="crypto", n=None):
    """#6 異動: crypto = the 5 biggest 24h gainers and losers among Binance's 100 most-traded
    USDT perps (+ Blave 異常漲跌 when there is data access); tw = the 10 largest 成交值 of the
    last TWSE session (desktop: TWSE open data)."""
    return _movers_tw(b, n or 10) if market == "tw" else _movers_crypto(b, n or 5)


def _movers_crypto(b, n):
    try:
        t = _data.fetch_binance_ticker_24h()
    except Exception as e:
        b.notes.append(f"Binance 24h 漲跌幅抓取失敗({type(e).__name__}),異動表省略")
        return Brick()
    t = t[[s.isascii() and s.isalnum() for s in t.index]]
    t = t.sort_values("quote_volume", ascending=False).head(100)
    if len(t) < 2 * n:
        b.notes.append("Binance 24h 漲跌幅資料不足,異動表省略")
        return Brick()
    up = t.sort_values("change_pct", ascending=False).head(n)
    down = t.sort_values("change_pct").head(n)
    picked = list(up.index) + [s for s in down.index if s not in up.index]
    signal, denied = {}, False
    start = _crypto_window_start(b)
    for s in picked:
        try:
            df = _data.fetch_unusual_movement(s, "1d", start, None, b.headers)
        except _data.DataAccessError:
            denied = True
            break
        except Exception:
            continue
        ser = df["alpha"].dropna() if df is not None and "alpha" in df else None
        if ser is not None and len(ser):
            signal[s] = float(ser.iloc[-1])
    if denied:
        T._no_access("異常漲跌訊號", b.notes, b.missing)
    cols = [("coin", "幣種", "left"), ("chg", "24h", "right", "percent"), ("vol", "24h 成交額", "right")]
    if signal:
        cols.append(("sig", "異常漲跌", "right"))
    rows = []
    for s in picked:
        r = t.loc[s]
        row = {"coin": s.replace("USDT", ""), "chg": T._pct(float(r["change_pct"])), "vol": _usd(r["quote_volume"])}
        if s in signal:
            row["sig"] = f"{signal[s]:+.2f}"
        rows.append(row)
    top, bot = up.iloc[0], down.iloc[0]
    b.ctx["24h 漲幅最大"] = f"{up.index[0].replace('USDT', '')} {T._pct(float(top['change_pct']))}"
    b.ctx["24h 跌幅最大"] = f"{down.index[0].replace('USDT', '')} {T._pct(float(bot['change_pct']))}"
    title = f"24h 漲幅最大 {b.ctx['24h 漲幅最大']},跌幅最大 {b.ctx['24h 跌幅最大']}"
    cap = (f"Binance USDT 永續,24h 成交額前 100 名中漲幅前 {n} 與跌幅前 {n};滾動 24 小時"
           + (";異常漲跌為 Blave 指標 z-score(日頻,只到前一個完整日)" if signal else ""))
    return Brick([T.table(title, cols, rows, caption=cap)], foot=[("src", "漲跌幅:Binance 公開 24h 行情。")])


def _twse_day_all(b):
    state, val = _cached(b, "twse_day_all", _data.fetch_twse_day_all_public)
    return val if state == "ok" else None


def _movers_tw(b, n):
    if not _data.tw_market_public_allowed():
        b.notes.append("成交值排行只在電腦版提供(TWSE 開放資料),省略")
        return Brick()
    df = _twse_day_all(b)
    if df is None or not len(df):
        b.notes.append("成交值排行 抓取失敗,省略")
        return Brick()
    top = df[df["value"].notna()].sort_values("value", ascending=False).head(n)
    b.cache["tw_movers_ids"] = list(top.index)
    rows = []
    for sid, r in top.iterrows():
        prev = r["close"] - r["change"] if T._finite(r["close"]) and T._finite(r["change"]) else None
        rows.append({"code": sid, "name": r["name"], "close": T._num(r["close"], 2) if T._finite(r["close"]) else None,
                     "chg": T._pct((r["change"] / prev) * 100) if prev else None,
                     "value": f"{r['value'] / 1e8:,.1f} 億"})
    first = top.iloc[0]
    b.ctx["成交值第一"] = f"{top.index[0]} {first['name']} {first['value'] / 1e8:,.1f} 億"
    day = df.attrs.get("date")
    if day and b.asof and day != b.asof:
        b.notes.append(f"成交值排行的資料日是 {day},指數是 {b.asof}")
    tb = T.table(f"成交值第一:{b.ctx['成交值第一']}",
                 [("code", "代號", "left"), ("name", "名稱", "left"), ("close", "收盤", "right"),
                  ("chg", "漲跌", "right", "percent"), ("value", "成交值", "right")], rows,
                 caption=f"TWSE 上市證券(含 ETF){day or ''} 成交金額前 {n}")
    return Brick([tb], foot=[("src_twse_open", _data._TWSE_OPENDATA_SOURCE_ZH)])


# 重大訊息條款 → 標籤。只收查證過條文意義的款次;對不上的一律中性(R5)。尚無查證過的款次,所以目前全部中性。
_ANNOUNCE_TAGS = {}


def tw_announcements(b, symbols=None, n=5):
    """#18 重大訊息 (TWSE open data, desktop only): the latest day's announcements of `symbols`,
    or of the most-traded listed companies — a `news` block, tags by clause only."""
    if not _data.tw_market_public_allowed():
        b.notes.append("重大訊息只在電腦版提供(TWSE 開放資料),省略")
        return Brick()
    try:
        df = _data.fetch_tw_announcements_public()
    except Exception as e:
        b.notes.append(f"重大訊息抓取失敗({type(e).__name__}),省略")
        return Brick()
    if symbols:
        want = [str(x) for x in symbols]
        df = df[df["stock_id"].isin(want)]
    else:
        day_all = _twse_day_all(b)
        if day_all is not None and len(day_all):
            rank = day_all["value"].rank(ascending=False)
            df = df.assign(_r=df["stock_id"].map(rank).fillna(1e9)).sort_values(["_r", "time"], ascending=[True, False])
    if not len(df):
        b.notes.append("重大訊息 今日沒有" + ("點名標的的公告" if symbols else "公告"))
        return Brick()
    total = len(df)
    df = df.head(min(n, 10))
    items = [{"title": f"{r['name']}：{r['subject']}"[:120], "tag": _ANNOUNCE_TAGS.get(r["clause"], "neutral"),
              "sources": [{"name": "TWSE 重大訊息"}], "channel": "licensed",
              "published_at": int(r["time"].timestamp()), "symbols": [r["stock_id"]]} for _, r in df.iterrows()]
    b.ctx["重大訊息"] = f"{total} 則(列 {len(items)} 則):" + "、".join(f"{r['stock_id']} {r['name']}" for _, r in df.iterrows())
    order = "依點名標的" if symbols else "依前一交易日成交值排序"
    block = {"type": "news", "title": f"重大訊息 {len(items)} 則", "items": items,
             "caption": f"TWSE 上市公司重大訊息,最新一個公告日;{order},取前 {n} 則;標籤依條款類別,對不上的一律中性"}
    return Brick([block], foot=[("src_twse_open", _data._TWSE_OPENDATA_SOURCE_ZH)])


def news(b, market="tw", n=5, q=None):
    """#17 新聞 — the one agent-filled brick. It fetches the licensed (a) layer as candidates
    (鉅亨 B2B via Blave for Taiwan; none for crypto), prints them in describe(), and leaves
    the `news` slot for you: publish(pack, narrative={..., "news": [...]}). A scheduled run
    (no narrative) lays out the licensed candidates as they are — titles, source, time."""
    cands, state = [], None
    if market == "tw":
        since = None
        if b.asof:
            since = int(pd.Timestamp(b.asof).tz_localize(T.TPE).timestamp()) + 13 * 3600 + 1800   # 上一個收盤 13:30
        try:
            df = _data.fetch_news(b.headers, q=q, since=since, limit=40)
        except _data.DataAccessError:
            T._no_access("鉅亨新聞", b.notes, b.missing)
            df, state = None, "denied"
        except Exception as e:
            b.notes.append(f"鉅亨新聞抓取失敗({type(e).__name__})")
            df, state = None, "failed"
        for _, r in (df if df is not None else pd.DataFrame()).iterrows():
            cands.append({"title": str(r["title"])[:120], "sources": [{"name": str(r.get("source") or "Anue鉅亨")[:40]}],
                          "channel": "licensed", "published_at": int(r["published_at"])})
    b.news = {"market": market, "n": n, "candidates": cands, "state": state}
    return Brick(slot="news")


BRICKS = {
    "price_chart": price_chart, "quote_table": quote_table, "relative_perf": relative_perf,
    "tw_turnover": tw_turnover, "tw_institutional": tw_institutional, "tw_margin": tw_margin,
    "tw_futures_inst": tw_futures_inst, "txf_night": txf_night, "funding": funding,
    "blave_indicators": blave_indicators, "event_calendar": event_calendar, "levels_table": levels_table,
    "liquidation": liquidation, "derivs_table": derivs_table, "movers": movers,
    "tw_announcements": tw_announcements, "news": news,
}


# ─── assembler ────────────────────────────────────────────────────────────────

def _merge_foot(bricks, finals):
    """Brick footnote items in brick order; every "src" fragment joined into one line placed
    after them (tail fragments last, identical fragments once); then the finalizers' lines."""
    items, order, src, tail = {}, [], [], []
    for br in bricks:
        for f in br.foot:
            fid, txt, pos = f[0], f[1], (f[2] if len(f) > 2 else None)
            if fid == "src":
                (tail if pos == "tail" else src).append(txt)
                continue
            if fid not in items:
                order.append(fid)
                items[fid] = txt
    out = [(i, items[i]) for i in order]
    joined = list(dict.fromkeys(src)) + [t for t in dict.fromkeys(tail) if t not in src]
    if joined:
        out.append(("src", "".join(joined)))
    for fn in finals:
        out += fn
    return out


def build(recipe, date=None, headers=None):
    """Run a recipe → `Pack`. `recipe`: {"id", "title", "type"?, "report_type"?, "kpi": [brick
    names, focus first], "bricks": [[name, {params}], …], "lookback_days"?, "mode"?}.
    Blocks come out as: kpi_row, then each brick's blocks in recipe order, then the footnote."""
    headers = headers or T.headers_from_env()
    mode = recipe.get("mode", "morning")
    if mode == "close":
        date = _data._taipei_date(date or T._today_tpe()).strftime("%Y-%m-%d")
    else:
        date = date or T._today_tpe()
    rid = f"{recipe['id']}-{date.replace('-', '')}"
    title = recipe["title"]
    type_ = recipe.get("type", "morning")
    report_type = recipe.get("report_type", title)
    b = Build(recipe, date, headers, recipe.get("lookback_days", 45), mode)
    done = []
    try:
        for name, params in recipe["bricks"]:
            if name not in BRICKS:
                raise ValueError(f"unknown brick {name!r}; bricks: {', '.join(BRICKS)}")
            done.append((name, BRICKS[name](b, **(params or {}))))
    except Skip as e:
        return T.Pack(rid, title, type_, report_type, [], e.context, e.notes, skip=e.reason)
    first = {}
    for name, br in done:
        first.setdefault(name, br)
    kpis, headline = [], None
    for n in recipe.get("kpi", []):
        br = first.get(n)
        if br is None:
            continue
        if headline is None and br.kpis:
            headline = br.headline
        kpis += br.kpis
    bricks = [br for _, br in done]
    blocks, owners, news_at = [], [], None
    if kpis:
        blocks.append(T.kpi_row(kpis, title=headline))
        owners.append("kpi_row")
    for name, br in done:
        if br.slot == "news":
            news_at = len(blocks)
        blocks += br.blocks
        owners += [name] * len(br.blocks)
    foot = _merge_foot(bricks, [br.finalize(b) for br in bricks if br.finalize])
    if not any(x.get("type") != "kpi_row" for x in blocks) and not kpis and b.news is None:
        why = "這份配方今天沒有任何積木產出資料:" + ("、".join(b.notes) if b.notes else "來源都沒有資料")
        return T.Pack(rid, title, type_, report_type, [], b.ctx, b.notes + [why], skip=why, missing=b.missing)
    blocks.append(T.footnote(foot))
    owners.append("footnote")
    news = dict(b.news, at=news_at) if b.news is not None else None
    return T.Pack(rid, title, type_, report_type, blocks, b.ctx, b.notes, meta=b.meta, missing=b.missing,
                  owners=owners, news=news)
