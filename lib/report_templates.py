"""
Report templates — the deterministic half of a report, built from `lib.data`.

A template returns a `Pack`: the data blocks (KPI row, charts, tables, footnote)
already in contract shape, plus the numbers behind them (`pack.context`) and the
narrative slots left for you to fill (`pack.slots`). You write the judgement —
lead / read / watch / risk — and `publish()` assembles and drops the report.
You never build a chart block by hand for these report types, and you never
recompute a number the pack already carries.

Every chart and table the pack builds carries a `caption` — its measurement basis plus
the baseline the figure is read against (references/reports.md §7b A3) — and the
`kpi_row` and the price chart carry the day's headline fact in their `title`. Those
numbers are all in `describe()`: cite them, don't restate them in a narrative slot.

    from lib.report_templates import tw_market_brief, publish

    pack = tw_market_brief()              # today's TW market data pack
    print(pack.describe())                # the numbers, one line each — cite these
    publish(pack, narrative={
        "lead":   "...one falsifiable claim (≤600)...",
        "read":   "- 甲:數字加它的基準\n- 乙:…\n- 丙:…",      # 3–5 條,或 3–5 個 ### 子標;整格 ≤300
        "watch":  [("外資期貨淨多單", "回落到 1 萬口以下", "+12,300 口"),      # 2–3 列,不是散文
                   ("外資現貨買超", "轉為連兩日淨賣超", "+267.0 億")],
        "risk":   "...one falsifiable indicator threshold that voids the lead (≤100)...",
    })

    publish(pack)                          # no narrative = data pack only, id gets "-auto"
                                           # (a scheduled run: no LLM, no invented view)

Templates: `tw_market_brief()`, `tw_close_brief()`, `crypto_market_brief()`, `symbol_brief(symbol)`.
A pack with `pack.skip` set (tw_close_brief on a non-trading day, or before today's close
has landed) is never published: `publish()` prints why and returns None.
Block shapes follow `references/reports.md` §3; the narrative rules are §7 (one
claim in the lead, every number a cause or a comparison, write the other side).
The pack never invents a value: a series the source does not have is a block
that is not there, and `describe()` says so. A Blave-only series this machine has no
data access to (desktop, `BLAVE_DATA_ACCESS=0`) is skipped the same way — listed in
`pack.missing` with the reason, named in a footnote line `publish()` adds — and the
rest of the report is published. The two TAIEX briefs take their index, turnover, 三大法人,
融資 and 期貨法人 straight from TWSE / TAIFEX on the desktop instead (with the exchanges'
attribution in the footnote); only where that key-free path is not allowed (a machine
without BLAVE_AGENT_LOCAL=1) do they have nothing to publish and set `pack.skip`.
"""

import math
import os
import re
from datetime import datetime, timedelta, timezone

import pandas as pd

from lib import data as _data
from lib.report import write_report

TPE = timezone(timedelta(hours=8))
_FNREF_RE = re.compile(r"\[\^([A-Za-z0-9_-]{1,32})\]")

# Narrative slots: key → (heading, char cap). A cap is an upper bound that doubles as
# the target — 讀者 80% 在 350 字前離開,而區塊的 title / caption 已經帶了結論與基準,
# 敘事再講一次就是一面沒人讀的牆。`watch` 沒有字數上限:它是表格,不是散文。
SLOTS = {
    "lead": ("", 600),
    "read": ("## 判讀", 300),
    # 不叫「操作建議」:對不特定人給支撐壓力、買賣價位是投顧法規點名的態樣,這格只寫條件與門檻。
    "watch": ("觀察重點", None),
    "risk": ("推翻這份解讀的訊號", 100),
}
# `watch` 的表格形狀。key 必須是 ASCII(契約 §3),欄位一律 text format——現在值帶 + 號
# 會被上色規則讀成獲利。
WATCH_COLUMNS = (("cond", "條件", "left"), ("threshold", "門檻", "left"), ("now", "現在值", "right"))
WATCH_ROWS = (2, 3)
WATCH_CELL = 40
READ_ITEMS = (3, 5)
WATCH_CAPTION = "條件與門檻是這份判讀設的觀察位置;現在值取自本報告數據區的當日數值。"
_SLOT_FORM = {
    "lead": "一個可證偽的主張",
    "read": "3–5 條,每條一個數字加它的基準;或 3–5 個 ### 子標",
    "risk": "一句可證偽的",
}


class Pack:
    """What a template hands back. `blocks` are contract-shaped and complete;
    `slots` lists the narrative you may add; `context` holds the figures
    (label → display string) that `describe()` prints for you to cite."""

    def __init__(self, report_id, title, type_, report_type, blocks, context, notes=None,
                 meta=None, skip=None, missing=None):
        self.report_id = report_id
        self.title = title
        self.type = type_
        self.report_type = report_type
        self.blocks = blocks
        self.context = context
        self.notes = notes or []          # what is missing and why
        self.meta = meta or {}
        self.skip = skip                  # reason this pack must not be published, or None
        # Blave-only series skipped for lack of data access: [{"name", "reason"}], reason
        # "signed_out" / "no_data_access". publish() names them in the footnote.
        self.missing = missing or []
        self.slots = dict(SLOTS)

    def describe(self):
        lines = [f"[{self.report_id}] {self.title}"]
        if self.skip:
            lines.append(f"  不發佈: {self.skip}")
        lines += [f"  {k}: {v}" for k, v in self.context.items()]
        if self.notes:
            lines += ["  缺少:"] + [f"    - {n}" for n in self.notes]
        if self.missing:
            lines.append(f"  無 Blave 資料權限({self.missing[0]['reason']}),省略:{_missing_names(self)}"
                         " — 照樣 publish(尾註會列出),對話裡講一句就好;不要因此不產報告")
        slots = [f"{k}=表格 {WATCH_ROWS[0]}–{WATCH_ROWS[1]} 列(條件/門檻/現在值)" if cap is None
                 else f"{k}≤{cap}" + (f"({_SLOT_FORM[k]})" if k in _SLOT_FORM else "")
                 for k, (_, cap) in self.slots.items()]
        lines.append("  narrative slots: " + ", ".join(slots))
        return "\n".join(lines)


# ─── headers ──────────────────────────────────────────────────────────────────

def headers_from_env():
    """Auth headers from the workspace `.env` (or the environment). Same shape as
    references/lib.md: lowercase keys, `api-key` / `secret-key` header names."""
    env = dict(os.environ)
    try:
        from dotenv import dotenv_values
        env.update({k: v for k, v in dotenv_values().items() if v is not None})
    except ImportError:
        pass
    return {"api-key": env.get("blave_api_key", ""), "secret-key": env.get("blave_secret_key", "")}


# ─── small block constructors (shape by construction) ─────────────────────────

def _finite(v):
    try:
        return v is not None and math.isfinite(float(v))
    except (TypeError, ValueError):
        return False


def _ts(idx):
    """DatetimeIndex entry → unix seconds int (UTC)."""
    t = pd.Timestamp(idx)
    if t.tzinfo is None:
        t = t.tz_localize("UTC")
    return int(t.timestamp())


def _points(series, scale=1.0):
    return [[_ts(t), float(v) * scale] for t, v in series.items() if _finite(v)]


def kpi(label, value, tone="neutral", unit=None, delta=None):
    item = {"label": label[:40], "value": value, "tone": tone}
    if unit:
        item["unit"] = unit[:16]
    if delta is not None:
        item["delta"] = delta
    return item


def kpi_row(items, title=None):
    # 契約 1–6 格。超過就 raise,不靜默砍:砍掉的那格 describe() 還在列,agent 會引用一個
    # 讀者看不到的數字。
    if not 1 <= len(items) <= 6:
        raise ValueError(f"kpi_row takes 1–6 items, got {len(items)}")
    b = {"type": "kpi_row", "items": list(items)}
    if title:
        b["title"] = title[:80]
    return b


def line_chart(title, series, y_unit=None, caption=None, reflines=None):
    """series: list of (name, role, pandas Series). Drops NaN points; a series with
    no finite point is dropped; returns None when nothing survives."""
    out = []
    for name, role, s in series:
        pts = _points(s)
        if pts:
            out.append({"name": name[:40], "role": role, "points": pts[-5000:]})
    if not out:
        return None
    b = {"type": "line_chart", "title": title[:80], "series": out[:4]}
    if y_unit:
        b["y_unit"] = y_unit[:8]
    if caption:
        b["caption"] = caption[:300]
    if reflines:
        b["reflines"] = [{"y": float(y), "label": lab[:32], "emphasis": bool(em)}
                         for y, lab, em in reflines if _finite(y)][:4]
    return b


# 範本的價格 K 線一律畫最後 60 根:手機寬度約放得下 68 根完整 K 棒(日 K 建議 40–65)。
_PRICE_BARS = 60


def _clean_ohlc(df):
    """The bars a candlestick can draw: sorted, de-duplicated, no NaN, open/close inside
    high/low. Other columns (Volume) ride along on the kept rows."""
    # lib.data 只丟 high<low 的壞 K;開收落在高低之外的那根也會讓 api 整份 400,丟掉留一個缺口。
    # 範本畫圖與算價位共用這一份,參考線才不會算到圖上沒畫的那根。
    df = df[~df.index.duplicated(keep="last")].sort_index()
    o, h, l, c = (df[k].astype(float) for k in ("Open", "High", "Low", "Close"))
    ok = pd.concat([o, h, l, c], axis=1).notna().all(axis=1) & (l <= o.combine(c, min)) & (o.combine(c, max) <= h)
    return df[ok]


def candlestick(title, df, y_unit=None, caption=None, reflines=None):
    """df: Open/High/Low/Close on a DatetimeIndex. Keeps the last ≤120 drawable bars;
    returns None when fewer than 2 survive."""
    ohlc = _clean_ohlc(df)[["Open", "High", "Low", "Close"]].astype(float)
    candles = [[_ts(t), *map(float, row)] for t, row in zip(ohlc.index, ohlc.values)][-120:]
    if len(candles) < 2:
        return None
    b = {"type": "candlestick", "title": title[:80], "candles": candles}
    if y_unit:
        b["y_unit"] = y_unit[:8]
    if caption:
        b["caption"] = caption[:300]
    if reflines:
        b["reflines"] = [{"y": float(y), "label": lab[:32], "emphasis": bool(em)}
                         for y, lab, em in reflines if _finite(y)][:4]
    return b


def bar_chart(title, items, caption=None):
    its = [{"label": lab[:40], "value": float(v)} for lab, v in items if _finite(v)]
    if not its:
        return None
    b = {"type": "bar_chart", "title": title[:80], "variant": "bars", "items": its[:60]}
    if caption:
        b["caption"] = caption[:300]
    return b


def table(title, columns, rows, caption=None):
    """columns: list of (key, label, align[, format]); rows: list of dicts keyed by key."""
    cols = []
    for c in columns:
        key, label, align = c[0], c[1], c[2]
        d = {"key": key, "label": label[:40], "align": align}
        if len(c) > 3 and c[3]:
            d["format"] = c[3]
        cols.append(d)
    keys = {c["key"] for c in cols}
    clean = [{k: (None if (isinstance(v, float) and not math.isfinite(v)) else v)
              for k, v in r.items() if k in keys} for r in rows]
    if not clean:
        return None
    b = {"type": "table", "title": title[:80], "columns": cols[:20], "rows": clean[:500]}
    if caption:
        b["caption"] = caption[:300]
    return b


def text(markdown, lead=False):
    b = {"type": "text", "markdown": markdown[:20000]}
    if lead:
        b["variant"] = "lead"
    return b


def callout(text_, tone="warning", title=None):
    b = {"type": "callout", "tone": tone, "text": text_[:2000]}
    if title:
        b["title"] = title[:120]
    return b


def footnote(items):
    return {"type": "footnote", "items": [{"id": i, "text": t[:1000]} for i, t in items][:30]}


# ─── formatting helpers ───────────────────────────────────────────────────────

def _pct(v, digits=2):
    return f"{v:+.{digits}f}%"


def _num(v, digits=0):
    return f"{v:,.{digits}f}"


def _signed(v, digits=0):
    return f"{v:+,.{digits}f}"


def _tone(v):
    return "pos" if v > 0 else "neg" if v < 0 else "neutral"


def _tw_yi(v):
    """TWD → 億, one decimal, signed."""
    return f"{v / 1e8:+,.1f} 億"


def _mean(series, n):
    """n 個交易日的簡單平均,不足 n 根回 None。窗口不夠就不寫這個比較句,不拿較短的
    窗口頂替(同 _prior20)——讀者看到「20 日均」就是 20 根。"""
    s = series.dropna()
    return float(s.tail(n).mean()) if len(s) >= n else None


def _vs(last, base, label, digits=1):
    """「高於/低於{label} X%」。收盤相對某個統計值的位置是事實陳述,不是支撐壓力
    (references/reports.md §1b);算不出基準就回 None,整句省略。"""
    if not (_finite(last) and _finite(base)) or float(base) == 0:
        return None
    d = (float(last) / float(base) - 1) * 100
    sep = " " if label[0].isdigit() else ""   # 中文接數字要留一格(「低於 60 日均」),接中文不留
    return f"{'高於' if d >= 0 else '低於'}{sep}{label} {abs(d):.{digits}f}%"


def _cap(basis, *clauses):
    """caption = 口徑 + 比較基準(§7b A3)。範本產出的每個圖表都要有 caption,而且不是把
    圖上的數字再念一遍;算不出來的比較句直接省略,只留口徑。"""
    return ";".join([basis] + [c for c in clauses if c])


def _vs7(ser, fmt=lambda v: f"{v:+.2f}"):
    """指標圖的比較句:最新值對自己的 7 日均(與 KPI delta 同一組數字)。"""
    if ser is None or len(ser) == 0:
        return None
    return f"最新 {fmt(float(ser.iloc[-1]))},7 日均 {fmt(float(ser.tail(7).mean()))}"


def _where(ctx, last, pairs):
    """describe() 裡的「收盤位置」:title 與 caption 用的比較句,原句放進 context。
    agent 引用得到同一句,就不會自己再算一次(算出第二個版本的數字)。"""
    txt = ",".join(c for c in (_vs(last, base, label) for base, label in pairs) if c)
    if txt:
        ctx["收盤位置"] = txt


def _headline(name, chg, last, base, base_label):
    """kpi_row 的 title:當日漲跌 + 它對一個基準的位置(§7b A3/A4)。排程跑的純數據包
    沒有 lead,這行是整份報告唯一的結論句,所以由範本從當日資料算,不是寫死的判斷。
    基準算不出來就回 None(不下標題):只有漲跌的一句跟下面 KPI 那格一字不差,是裝飾。"""
    vs = _vs(last, base, base_label)
    return f"{name} {_pct(chg * 100)},{vs}" if vs else None


def _price_title(name, last, ma, ma_label="60 日均"):
    """價格圖的 title:圖名 + 收盤在窗口裡的位置。標題本身就是主張,讀者掃小標就抓得到
    (§7b A5/A7);均線算不出來就只留圖名。"""
    vs = _vs(last, ma, ma_label)
    return f"{name}:收盤{vs}" if vs else name


def _dated(delta, ts, asof):
    """Append the series date to a KPI delta when it differs from the report's as-of day."""
    d = pd.Timestamp(ts).strftime("%Y-%m-%d")
    if d == asof:
        return delta or None
    tag = pd.Timestamp(ts).strftime("%m/%d")
    return f"{delta}({tag})" if delta else tag


def _last_two(series):
    s = series.dropna()
    if len(s) == 0:
        return None, None
    return float(s.iloc[-1]), (float(s.iloc[-2]) if len(s) > 1 else None)


def _window_start(days):
    return (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d")


def _now_tpe():
    return datetime.now(TPE)


def _today_tpe():
    return _now_tpe().strftime("%Y-%m-%d")


def _access_reason():
    """Why BLAVE_DATA_ACCESS=0 (shell's BLAVE_DATA_ACCESS_WHY): 'signed_out' or, for
    no_card / no_balance / unknown, 'no_data_access'."""
    return "signed_out" if os.environ.get("BLAVE_DATA_ACCESS_WHY") == "signed_out" else "no_data_access"


def _no_access(name, notes, missing):
    missing.append({"name": name, "reason": _access_reason()})
    notes.append(f"{name} 無 Blave 資料權限,省略")


def _missing_names(pack):
    return "、".join(dict.fromkeys(m["name"] for m in pack.missing))


def _skip_no_access(rid, title, report_type, what):
    """A template whose base series is Blave-only and unreachable: nothing to publish.
    The sentence carries no internal code: the agent relays it as is."""
    skip = f"沒有 Blave 資料,{what}全部經 Blave,這份產不出來。{_access_fix('zh')}"
    return Pack(rid, title, "morning", report_type, [], {}, [skip], skip=skip)


_TW_MARKET_SERIES = "加權指數、成交值、三大法人、融資、期貨法人"


def _tw_market(blave, public, name, notes, missing, used, empty_cols):
    """One TAIEX-brief series: Blave first; with no Blave data access this turn, the key-free
    TWSE / TAIFEX twin (desktop only) — `used` collects the exchanges that answered, for the
    attribution line. A free-path failure is a note and an empty frame, never a stand-in."""
    try:
        return blave()
    except _data.DataAccessError:
        if not _data.tw_market_public_allowed():
            _no_access(name, notes, missing)
            return pd.DataFrame(columns=empty_cols)
    try:
        df = public()
    except Exception as e:
        notes.append(f"{name} 免費資料抓取失敗({type(e).__name__}: {str(e)[:80]})")
        return pd.DataFrame(columns=empty_cols)
    used.add(df.attrs["source"])
    return df


# 指數日 K 固定抓 90 個日曆日(約 60 個交易日):60 日均與 60 根 K 棒要這麼多;lookback_days 只管
# 成交值、法人、融資、期貨法人——免費路徑上法人與融資一天一次請求,冷啟動成本跟著它走。
_TW_INDEX_DAYS = 90


def _tw_index_start(date, start):
    return min(start, (datetime.strptime(date, "%Y-%m-%d") - timedelta(days=_TW_INDEX_DAYS)).strftime("%Y-%m-%d"))


def _tw_market_index(start, date, headers, used):
    """TAIEX daily bars for the two briefs; DataAccessError only when the key-free path is not
    allowed. A free-path failure raises the real error — never an 'add a card' skip for an
    exchange outage."""
    try:
        return _data.fetch_twmarket_index(start, date, headers)
    except _data.DataAccessError:
        if not _data.tw_market_public_allowed():
            raise
    try:
        df = _data.fetch_twmarket_index_public(start, date)
    except Exception as e:
        raise ValueError(f"加權指數免費資料抓不到({type(e).__name__}: {str(e)[:120]})") from e
    used.add(df.attrs["source"])
    return df


def _tw_market_foot(foot, used):
    """src line + the exchanges' attribution (a licence condition) when a free path served."""
    via = "本機直接取自交易所" if used else "經 Blave API"
    foot.append(("src", f"指數、成交值、三大法人、融資餘額:TWSE 日資料,{via}。三大法人為淨買賣超金額,融資餘額為張數。"
                 "前 20 日高 = 不含當日的前 20 個交易日最高價;20/60 日均為含當日的簡單平均。"))
    if "TWSE" in used:
        foot.append(("src_twse", _data._TWSE_SOURCE_ZH))
    if "TAIFEX" in used:
        foot.append(("src_taifex", _data._TAIFEX_SOURCE_ZH))


def _calendar_rows(headers, notes, missing, countries=None):
    """Today's priority-1/2 macro events as table rows; [] when none or unavailable."""
    today = _today_tpe()
    try:
        cal = _data.fetch_economic_calendar(headers, start=today, end=today, countries=countries,
                                            max_priority=2, limit=12)
    except _data.DataAccessError:
        _no_access("今日總經事件", notes, missing)
        return []
    except Exception as e:  # the brief must not die on a side table
        notes.append(f"經濟日曆抓取失敗({type(e).__name__}),今日事件表省略")
        return []
    rows = []
    for _, r in cal.iterrows():
        t = r.get("time")
        rows.append({"time": t if isinstance(t, str) and t else "—", "country": r.get("country_name") or r.get("country"),
                     "subject": f"{r.get('subject')} {r.get('subject_title') or ''}".strip(),
                     "predict": _fmt_cal(r.get("predict"), r.get("unit")),
                     "last": _fmt_cal(r.get("last"), r.get("unit"))})
    return rows


def _fmt_cal(v, unit):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    u = unit or ""
    return f"{v}{u}" if u in ("%", "") else f"{v} {u}"


_CAL_COLUMNS = [("time", "時間", "left"), ("country", "國家", "left"), ("subject", "指標", "left"),
                ("predict", "預期", "right"), ("last", "前值", "right")]


def _indicator(fn, args, name, ctx, kpis, notes, missing, fmt=lambda v: f"{v:+.2f}"):
    """One Blave indicator series → context line + KPI; None (and a note) when the
    fetch fails or is empty. Indicator values are not P&L, so the KPI stays neutral."""
    try:
        df = fn(*args)
    except _data.DataAccessError:
        _no_access(name, notes, missing)
        return None
    except Exception as e:
        notes.append(f"{name} 抓取失敗({type(e).__name__})")
        return None
    ser = df["alpha"].dropna() if df is not None and "alpha" in df else pd.Series(dtype=float)
    if len(ser) == 0:
        notes.append(f"{name} 無資料")
        return None
    v, m7 = float(ser.iloc[-1]), float(ser.tail(7).mean())
    ctx[name] = f"{fmt(v)}(7 日均 {fmt(m7)},{ser.index[-1].date()})"
    kpis.append(kpi(name, fmt(v), "neutral", delta=f"7日均 {fmt(m7)}"))
    return ser


# ─── template 1: 台股大盤晨報 ─────────────────────────────────────────────────

def tw_market_brief(date=None, headers=None, lookback_days=45):
    """台股大盤晨報 data pack for the morning of `date` (Taipei; default today).
    Reads the last trading day's close, turnover, 三大法人, 融資, 外資期貨淨多單 and
    the TXF night session. `lookback_days` covers the flow series (20-day means, margin and
    futures charts); the index always spans 90 days for its 60-day mean and 60-bar chart."""
    headers = headers or headers_from_env()
    date = date or _today_tpe()
    start = (datetime.strptime(date, "%Y-%m-%d") - timedelta(days=lookback_days)).strftime("%Y-%m-%d")
    notes, ctx, blocks, kpis, foot, missing = [], {}, [], [], [], []
    rid, title = f"tw-market-{date.replace('-', '')}", "台股大盤晨報"
    used = set()

    try:
        idx = _clean_ohlc(_tw_market_index(_tw_index_start(date, start), date, headers, used))   # end=date 已由 fetch 端裁切
    except _data.DataAccessError:
        # 沒 Blave 權限、又不是電腦版(不准走免費路徑):沒有可以建的東西。
        return _skip_no_access(rid, title, title, _TW_MARKET_SERIES)
    if len(idx) < 2:
        raise ValueError("加權指數資料不足兩個交易日,無法產晨報")
    close, prev = float(idx["Close"].iloc[-1]), float(idx["Close"].iloc[-2])
    asof = idx.index[-1].strftime("%Y-%m-%d")
    chg = close / prev - 1
    high20, _ = _prior20(idx, notes)
    ma60 = _mean(idx["Close"], 60)
    ctx["資料日"] = asof
    ctx["加權指數"] = f"{_num(close, 2)}({_pct(chg * 100)})" + (f",前 20 日高 {_num(high20, 2)}" if high20 is not None else "")
    if ma60 is not None:
        ctx["60 日均"] = _num(ma60, 2)
    _where(ctx, close, [(high20, "前 20 日高"), (ma60, "60 日均")])
    kpis.append(kpi("加權指數", _num(close, 2), _tone(chg), delta=_pct(chg * 100)))

    turn = _tw_market(lambda: _data.fetch_twmarket_turnover(start, date, headers),
                      lambda: _data.fetch_twmarket_turnover_public(start, date), "成交值", notes, missing, used,
                      _data._TWMARKET_TURNOVER_COLUMNS)
    val, val_prev = _last_two(turn["value"]) if len(turn) else (None, None)
    if val is not None:
        avg5 = float(turn["value"].tail(5).mean())
        ctx["成交值"] = f"{val / 1e12:.2f} 兆(5 日均 {avg5 / 1e12:.2f} 兆)"
        kpis.append(kpi("成交值", f"{val / 1e12:.2f}", "neutral", unit="兆",
                        delta=_pct((val / avg5 - 1) * 100) + " vs 5日均"))
    else:
        notes.append("成交值無資料")

    inst = _tw_market(lambda: _data.fetch_twmarket_institutional(start, date, headers),
                      lambda: _data.fetch_twmarket_institutional_public(start, date), "三大法人", notes, missing, used,
                      _data._TWMARKET_INST_COLUMNS)
    blocks_inst = None
    inst_ok = len(inst) and all(_finite(inst[c].iloc[-1]) for c in ("foreign", "investment_trust", "dealer", "total"))
    if inst_ok:
        last = inst.iloc[-1]
        f_prev = float(inst["foreign"].iloc[-2]) if len(inst) > 1 and _finite(inst["foreign"].iloc[-2]) else None
        ctx["三大法人"] = (f"外資 {_tw_yi(last['foreign'])}(昨 {_tw_yi(f_prev) if f_prev is not None else '—'})、"
                        f"投信 {_tw_yi(last['investment_trust'])}、自營 {_tw_yi(last['dealer'])}、"
                        f"合計 {_tw_yi(last['total'])}")
        # 指數可能已是今天、籌碼還是昨天:日期不同的 KPI 在 delta 標日期,讀者才不會把兩天讀成同一天。
        kpis.append(kpi("外資買賣超", _tw_yi(float(last["foreign"])), _tone(float(last["foreign"])),
                        delta=_dated("", inst.index[-1], asof)))
        f20 = _mean(inst["foreign"], 20)
        if f20 is not None:
            ctx["外資 20 日均"] = _tw_yi(f20)
        # 合計不佔 KPI 格(六格要留給夜盤),寫在長條圖說明裡。
        blocks_inst = bar_chart("三大法人買賣超(億元)",
                                [("外資", last["foreign"] / 1e8), ("投信", last["investment_trust"] / 1e8),
                                 ("自營商", last["dealer"] / 1e8)],
                                caption=_cap(f"{inst.index[-1].strftime('%Y-%m-%d')} 淨買賣超金額,億元",
                                             f"三大法人合計 {_tw_yi(float(last['total']))}",
                                             f"外資近 20 個交易日平均 {_tw_yi(f20)}" if f20 is not None else None))
    else:
        notes.append("三大法人無資料")

    mg = _tw_market(lambda: _data.fetch_twmarket_margin(start, date, headers),
                    lambda: _data.fetch_twmarket_margin_public(start, date), "融資餘額", notes, missing, used,
                    _data._TWMARKET_MARGIN_COLUMNS)
    m_last, m_prev = _last_two(mg["margin_balance"]) if len(mg) else (None, None)
    m20 = _mean(mg["margin_balance"], 20) if len(mg) else None
    if m_last is not None:
        d_m = (m_last - m_prev) if m_prev is not None else 0.0
        ctx["融資餘額"] = f"{m_last / 1e4:,.1f} 萬張({_signed(d_m / 1e4, 1)} 萬張)"
        if m20 is not None:
            ctx["融資 20 日均"] = f"{m20 / 1e4:,.1f} 萬張"
        kpis.append(kpi("融資餘額", f"{m_last / 1e4:,.1f}", "neutral", unit="萬張",
                        delta=_dated(f"{_signed(d_m / 1e4, 1)} 萬張", mg.index[-1], asof)))
    else:
        notes.append("融資餘額無資料")

    fut = None
    try:
        fut = _tw_market(lambda: _data.fetch_twfutures_institutional("TX", start, date, headers),
                         lambda: _data.fetch_twfutures_institutional_public("TX", start, date), "外資期貨淨多單",
                         notes, missing, used, _data._TWFUT_INST_COLUMNS)
    except Exception as e:
        notes.append(f"期貨三大法人抓取失敗({type(e).__name__})")
    n20 = _mean(fut["foreign_net_oi"], 20) if fut is not None and len(fut) else None
    if fut is not None and len(fut):
        f_last, f_prev = _last_two(fut["foreign_net_oi"])
        d_f = (f_last - f_prev) if f_prev is not None else 0.0
        ctx["外資期貨淨多單"] = f"{_signed(f_last)} 口({_signed(d_f)} 口,{fut.index[-1].strftime('%m-%d')})"
        if n20 is not None:
            ctx["外資期貨 20 日均"] = f"{_signed(n20)} 口"
        # 淨部位是方向不是損益:長期淨空會永遠紅,上色沒有資訊,一律 neutral。
        kpis.append(kpi("外資期貨淨多單", _signed(f_last), "neutral", unit="口",
                        delta=_dated(_signed(d_f) + " 口", fut.index[-1], asof)))
        foot.append(("futinst", "期貨三大法人為 TAIFEX 盤後統計,晨報引用的是前一交易日收盤後的未平倉淨口數(多 − 空)。"))

    night = _txf_night_session(headers, asof, notes, missing)
    if night:
        ctx["台指期夜盤"] = (f"{_num(night['close'])}({night['state']};{_pct(night['chg'] * 100)} "
                          f"vs 日盤收 {_num(night['day_close'])})")
        label = "台指期夜盤" if night["done"] else f"台指期夜盤({night['state']})"
        kpis.append(kpi(label, _num(night["close"]), _tone(night["chg"]), delta=_pct(night["chg"] * 100)))
        foot.append(("night", "台指期夜盤 = 15:00 至次日 05:00 的交易時段,漲跌以同日日盤收盤價為基準。"
                     + ("" if night["done"] else "數值為截至標示時點的最新價,不是收盤價。")))

    blocks.append(kpi_row(kpis, title=_headline("加權指數", chg, close, high20, "前 20 日高")))
    ck = candlestick(_price_title("加權指數", close, ma60), idx.tail(_PRICE_BARS), y_unit="點",
                     caption=_cap(f"近 {min(len(idx), _PRICE_BARS)} 個交易日日 K",
                                  f"參考線為前 20 日高 {_num(high20, 2)}(不含當日)" if high20 is not None else None,
                                  f"60 日均 {_num(ma60, 2)}(含當日收盤)" if ma60 is not None else None),
                     reflines=[(high20, "前 20 日高", False)] if high20 is not None else None)
    if ck:
        blocks.append(ck)
    if blocks_inst:
        blocks.append(blocks_inst)
    if m_last is not None:
        lc = line_chart("融資餘額", [("融資餘額", "primary", mg["margin_balance"] / 1e4)], y_unit="萬張",
                        caption=_cap("TWSE 日融資餘額,張數(圖為萬張)",
                                     f"最新 {m_last / 1e4:,.1f} 萬張,近 20 個交易日平均 {m20 / 1e4:,.1f} 萬張"
                                     if m20 is not None else None))
        if lc:
            blocks.append(lc)
    if fut is not None and len(fut):
        lc = line_chart("外資期貨淨多單", [("外資淨多單", "primary", fut["foreign_net_oi"])], y_unit="口",
                        caption=_cap("TAIFEX 盤後未平倉淨口數(多 − 空)",
                                     f"最新 {_signed(f_last)} 口,近 20 個交易日平均 {_signed(n20)} 口"
                                     if n20 is not None else None),
                        reflines=[(0.0, "0", False)])
        if lc:
            blocks.append(lc)
    cal = _calendar_rows(headers, notes, missing, countries=["US", "CN", "TW", "JP", "EU"])
    if cal:
        # 事件表沒有比較基準可寫:它是時刻表不是量測,caption 只留口徑(預期/前值已在欄位裡)。
        blocks.append(table("今日總經事件", _CAL_COLUMNS, cal, caption="台北時間;priority 1–2 的事件"))
    _tw_market_foot(foot, used)
    blocks.append(footnote(foot))

    # 標題不帶日期——報告清單列本身顯示建立時間(Wei 2026-09-02 拍板);id 仍帶日期,同日重跑才會覆蓋。
    # 資料日與晨報日不同才標 period,同日就省(印「09/02–09/02」沒有資訊)。
    meta = {} if asof == date else {"period": {"from": asof[5:].replace("-", "/"), "to": date[5:].replace("-", "/")}}
    return Pack(rid, title, "morning", title, blocks, ctx, notes, meta=meta, missing=missing)


def _txf_night_session(headers, day, notes, missing):
    """Last TXF night session after trading day `day` (YYYY-MM-DD): close and change
    vs that day's day-session close, from 60m bars. None when the source has no
    bars in the 15:00–05:00 window (or no bars at all). Blave-only: no key-free path."""
    try:
        df = _data.fetch_twfutures_ohlcv("TXF", "60m", (pd.Timestamp(day) - timedelta(days=5)).strftime("%Y-%m-%d"),
                                         None, headers)
    except _data.DataAccessError:
        _no_access("台指期夜盤", notes, missing)
        return None
    except Exception as e:
        notes.append(f"台指期 60m 抓取失敗({type(e).__name__}),夜盤省略")
        return None
    if df is None or len(df) == 0:
        notes.append("台指期 60m 無資料,夜盤省略")
        return None
    t = df.index
    t = t.tz_localize("UTC") if t.tz is None else t
    tpe = t.tz_convert(TPE)
    d = pd.Timestamp(day).date()
    day_mask = (tpe.date == d) & (tpe.hour >= 8) & (tpe.hour < 14)
    # 夜盤 15:00 至次日 05:00;bar 以起始分鐘標記,收盤那根標 05:00,所以次日取 hour ≤ 5。
    night_mask = ((tpe.date == d) & (tpe.hour >= 15)) | ((tpe.date == d + timedelta(days=1)) & (tpe.hour <= 5))
    if not day_mask.any():
        notes.append(f"台指期 {day} 無日盤 60m bar,夜盤省略")
        return None
    if not night_mask.any():
        notes.append(f"台指期 {day} 無夜盤 bar(資料源可能不含夜盤,或夜盤尚未開始)")
        return None
    day_close = float(df.loc[day_mask, "Close"].iloc[-1])
    close = float(df.loc[night_mask, "Close"].iloc[-1])
    # bar 以起始時間標記(api 丟掉未收的那根,export 路徑可能留著),價格的時點 = min(起始 + 60 分,
    # 現在, 05:00)。夜盤還在交易時這是盤中價;不標出來,agent 會寫成「夜盤收」(uid=1 T13)。
    now = pd.Timestamp(_now_tpe())
    session_end = pd.Timestamp(d + timedelta(days=1)).tz_localize(TPE) + pd.Timedelta(hours=5)
    as_of = min(tpe[night_mask][-1] + pd.Timedelta(minutes=60), now, session_end)
    done = as_of >= session_end
    if done:
        state = "收盤"
    elif now < session_end:
        state = f"盤中,截至 {as_of:%H:%M}"
    else:
        state = f"截至 {as_of:%H:%M},資料未含收盤"
    return {"close": close, "day_close": day_close, "chg": close / day_close - 1, "state": state, "done": done}


# ─── template 1b: 台股收盤報告 ────────────────────────────────────────────────

def _on_day(frame, day):
    return frame is not None and len(frame) > 0 and frame.index[-1].strftime("%Y-%m-%d") == day


def _pending(label, frame, day, notes):
    if (frame is None or not len(frame)) and any(n.startswith(label) for n in notes):
        return   # already explained (fetch failed / no data access) — "not published yet" would contradict it
    last = frame.index[-1].strftime("%Y-%m-%d") if frame is not None and len(frame) else "無資料"
    notes.append(f"{label} {day} 尚未公布(資料源最新為 {last}),本報告不列,不拿前一日的數字充當今日")


def _closure(day, headers):
    """(label, attribution or None) for a non-trading `day`. The attribution is the holiday
    table's licence condition: whatever repeats the label must carry it verbatim."""
    d = pd.Timestamp(day)
    if d.weekday() >= 5:
        return "週末", None
    table = _data.fetch_twstock_holidays(headers, d.year)
    if table is None:
        return "休市", None
    rows = table[table["date"] == d]
    label = f"TWSE 休市表:{rows['name'].iloc[0]}" if len(rows) else "TWSE 休市表"
    return label, table.attrs.get("source_zh") or table.attrs.get("source")


def tw_close_brief(date=None, headers=None, lookback_days=45):
    """台股收盤報告 data pack for trading day `date` (Taipei; default today): the day's
    TAIEX close, turnover, 三大法人, 融資 and 外資期貨淨多單. The night session is not part
    of it. A series that has not published `date` yet is left out and named in
    `pack.notes` — never shown with the previous day's value.

    `pack.skip` is set (and `publish` writes nothing) when `date` is not a trading day per
    `lib.data.is_tw_trading_day`, or when the index has no close for `date` yet (not landed,
    or an ad-hoc closure the holiday table does not list); the reason names the last
    trading day. No sector breakdown: lib has no per-industry daily series, and building
    one means a close fetch for every listed stock."""
    headers = headers or headers_from_env()
    # 下面拿日期字串跟資料日期逐字比對;不先正規化,「2026-9-1」會永遠對不上而被當成「收盤未入庫」跳過。
    date = _data._taipei_date(date or _today_tpe()).strftime("%Y-%m-%d")
    start = (datetime.strptime(date, "%Y-%m-%d") - timedelta(days=lookback_days)).strftime("%Y-%m-%d")
    rid, title = f"tw-close-{date.replace('-', '')}", "台股收盤報告"
    notes, ctx, blocks, kpis, foot, missing = [], {}, [], [], [], []
    used = set()

    try:
        idx = _clean_ohlc(_tw_market_index(_tw_index_start(date, start), date, headers, used))
    except _data.DataAccessError:
        return _skip_no_access(rid, title, title, _TW_MARKET_SERIES)
    if len(idx) < 2:
        raise ValueError("加權指數資料不足兩個交易日,無法產收盤報告")
    try:
        trading = _data.is_tw_trading_day(date, headers)
    except _data.DataAccessError:
        # 休市表只有 Blave 那條,但它只用來判斷是否交易日、不是報告的一塊:不進 missing(尾註不叫人綁卡),
        # 退回「今天有沒有指數收盤」判斷(下面 trading is None 那支)。
        trading = None
    last_day = idx.index[-1].strftime("%Y-%m-%d")
    if trading is None:
        notes.append("TWSE 休市表無法取得(" + ("沒有 Blave 資料權限" if used else "端點未上線或該年度尚未公布")
                     + "),是否交易日改以今日有無加權指數收盤判斷")
    skip = None
    if trading is False:
        label, src = _closure(date, headers)
        skip = f"{date} 非交易日({label}),不產收盤報告;上一交易日 {last_day}"
        if src:
            ctx["休市表出處"] = src
            skip += f"。休市表出處(轉述時原文照附):{src}"
    elif last_day != date:
        skip = (f"{date} 的加權指數收盤尚未入庫,或今日臨時停市(颱風停市不在休市表內);"
                f"最近一個有收盤資料的交易日是 {last_day}")
    if skip:
        notes.append(skip)
        ctx["上一交易日"] = last_day
        return Pack(rid, title, "morning", title, [], ctx, notes, skip=skip)

    close, prev = float(idx["Close"].iloc[-1]), float(idx["Close"].iloc[-2])
    chg = close / prev - 1
    high20, _ = _prior20(idx, notes)
    ma60 = _mean(idx["Close"], 60)
    ctx["資料日"] = date
    ctx["加權指數"] = (f"{_num(close, 2)}({_signed(close - prev, 2)} 點,{_pct(chg * 100)})"
                    + (f",前 20 日高 {_num(high20, 2)}" if high20 is not None else ""))
    if ma60 is not None:
        ctx["60 日均"] = _num(ma60, 2)
    _where(ctx, close, [(high20, "前 20 日高"), (ma60, "60 日均")])
    kpis.append(kpi("加權指數", _num(close, 2), _tone(chg), delta=_pct(chg * 100)))

    turn = _tw_market(lambda: _data.fetch_twmarket_turnover(start, date, headers),
                      lambda: _data.fetch_twmarket_turnover_public(start, date), "成交值", notes, missing, used,
                      _data._TWMARKET_TURNOVER_COLUMNS)
    if _on_day(turn, date) and _finite(turn["value"].iloc[-1]):
        val, avg5 = float(turn["value"].iloc[-1]), float(turn["value"].tail(5).mean())
        ctx["成交值"] = f"{val / 1e12:.2f} 兆(5 日均 {avg5 / 1e12:.2f} 兆)"
        kpis.append(kpi("成交值", f"{val / 1e12:.2f}", "neutral", unit="兆",
                        delta=_pct((val / avg5 - 1) * 100) + " vs 5日均"))
    else:
        _pending("成交值", turn, date, notes)

    inst = _tw_market(lambda: _data.fetch_twmarket_institutional(start, date, headers),
                      lambda: _data.fetch_twmarket_institutional_public(start, date), "三大法人", notes, missing, used,
                      _data._TWMARKET_INST_COLUMNS)
    blocks_inst = None
    if _on_day(inst, date) and all(_finite(inst[c].iloc[-1]) for c in ("foreign", "investment_trust", "dealer", "total")):
        last = inst.iloc[-1]
        f_prev = float(inst["foreign"].iloc[-2]) if len(inst) > 1 and _finite(inst["foreign"].iloc[-2]) else None
        ctx["三大法人"] = (f"外資 {_tw_yi(last['foreign'])}(前一交易日 {_tw_yi(f_prev) if f_prev is not None else '—'})、"
                        f"投信 {_tw_yi(last['investment_trust'])}、自營 {_tw_yi(last['dealer'])}、"
                        f"合計 {_tw_yi(last['total'])}")
        kpis.append(kpi("外資買賣超", _tw_yi(float(last["foreign"])), _tone(float(last["foreign"]))))
        f20 = _mean(inst["foreign"], 20)
        if f20 is not None:
            ctx["外資 20 日均"] = _tw_yi(f20)
        blocks_inst = bar_chart("三大法人買賣超(億元)",
                                [("外資", last["foreign"] / 1e8), ("投信", last["investment_trust"] / 1e8),
                                 ("自營商", last["dealer"] / 1e8)],
                                caption=_cap(f"{date} 淨買賣超金額,億元",
                                             f"三大法人合計 {_tw_yi(float(last['total']))}",
                                             f"外資近 20 個交易日平均 {_tw_yi(f20)}" if f20 is not None else None))
    else:
        _pending("三大法人", inst, date, notes)

    mg = _tw_market(lambda: _data.fetch_twmarket_margin(start, date, headers),
                    lambda: _data.fetch_twmarket_margin_public(start, date), "融資餘額", notes, missing, used,
                    _data._TWMARKET_MARGIN_COLUMNS)
    margin_ok = _on_day(mg, date) and _finite(mg["margin_balance"].iloc[-1])
    m20 = _mean(mg["margin_balance"], 20) if len(mg) else None
    if margin_ok:
        m_last, m_prev = _last_two(mg["margin_balance"])
        d_m = (m_last - m_prev) if m_prev is not None else 0.0
        ctx["融資餘額"] = f"{m_last / 1e4:,.1f} 萬張({_signed(d_m / 1e4, 1)} 萬張)"
        if m20 is not None:
            ctx["融資 20 日均"] = f"{m20 / 1e4:,.1f} 萬張"
        kpis.append(kpi("融資餘額", f"{m_last / 1e4:,.1f}", "neutral", unit="萬張",
                        delta=f"{_signed(d_m / 1e4, 1)} 萬張"))
        foot.append(("margin", "融資增減 = 今日餘額 − 前一交易日餘額(實際餘額變化)。TWSE 的「前日餘額」欄已含"
                     "拆分、減資等公司行動調整,這類日子兩種算法會不同。"))
    else:
        _pending("融資餘額", mg, date, notes)

    fut = None
    try:
        fut = _tw_market(lambda: _data.fetch_twfutures_institutional("TX", start, date, headers),
                         lambda: _data.fetch_twfutures_institutional_public("TX", start, date), "外資期貨淨多單",
                         notes, missing, used, _data._TWFUT_INST_COLUMNS)
    except Exception as e:
        notes.append(f"期貨三大法人抓取失敗({type(e).__name__})")
    fut_ok = fut is not None and _on_day(fut, date) and _finite(fut["foreign_net_oi"].iloc[-1])
    n20 = _mean(fut["foreign_net_oi"], 20) if fut is not None and len(fut) else None
    if fut_ok:
        f_last, f_prev = _last_two(fut["foreign_net_oi"])
        d_f = (f_last - f_prev) if f_prev is not None else 0.0
        ctx["外資期貨淨多單"] = f"{_signed(f_last)} 口({_signed(d_f)} 口)"
        if n20 is not None:
            ctx["外資期貨 20 日均"] = f"{_signed(n20)} 口"
        kpis.append(kpi("外資期貨淨多單", _signed(f_last), "neutral", unit="口", delta=_signed(d_f) + " 口"))
        foot.append(("futinst", "期貨三大法人為 TAIFEX 日盤收盤後統計的未平倉淨口數(多 − 空)。"))
    elif fut is not None:
        _pending("外資期貨淨多單", fut, date, notes)

    blocks.append(kpi_row(kpis, title=_headline("加權指數", chg, close, high20, "前 20 日高")))
    ck = candlestick(_price_title("加權指數", close, ma60), idx.tail(_PRICE_BARS), y_unit="點",
                     caption=_cap(f"近 {min(len(idx), _PRICE_BARS)} 個交易日日 K",
                                  f"參考線為前 20 日高 {_num(high20, 2)}(不含當日)" if high20 is not None else None,
                                  f"60 日均 {_num(ma60, 2)}(含當日收盤)" if ma60 is not None else None),
                     reflines=[(high20, "前 20 日高", False)] if high20 is not None else None)
    if ck:
        blocks.append(ck)
    if blocks_inst:
        blocks.append(blocks_inst)
    if margin_ok:
        lc = line_chart("融資餘額", [("融資餘額", "primary", mg["margin_balance"] / 1e4)], y_unit="萬張",
                        caption=_cap("TWSE 日融資餘額,張數(圖為萬張)",
                                     f"最新 {m_last / 1e4:,.1f} 萬張,近 20 個交易日平均 {m20 / 1e4:,.1f} 萬張"
                                     if m20 is not None else None))
        if lc:
            blocks.append(lc)
    if fut_ok:
        lc = line_chart("外資期貨淨多單", [("外資淨多單", "primary", fut["foreign_net_oi"])], y_unit="口",
                        caption=_cap("TAIFEX 盤後未平倉淨口數(多 − 空)",
                                     f"最新 {_signed(f_last)} 口,近 20 個交易日平均 {_signed(n20)} 口"
                                     if n20 is not None else None),
                        reflines=[(0.0, "0", False)])
        if lc:
            blocks.append(lc)
    if date == _today_tpe():   # 經濟日曆只查得到「今天」;補產過去日期的報告不附別天的事件
        cal = _calendar_rows(headers, notes, missing, countries=["US", "CN", "TW", "JP", "EU"])
        if cal:
            blocks.append(table("今日總經事件", _CAL_COLUMNS, cal, caption="台北時間;priority 1–2 的事件"))
    _tw_market_foot(foot, used)
    blocks.append(footnote(foot))
    return Pack(rid, title, "morning", title, blocks, ctx, notes, missing=missing)


# ─── template 2: 加密市場晨報 ─────────────────────────────────────────────────

def crypto_market_brief(date=None, headers=None, symbols=("BTC", "ETH", "SOL"), lookback_days=30):
    """加密市場晨報 data pack: BTC/ETH(/others) price and returns, funding, and the
    market-wide Blave indicators (市場方向 / 資金稀缺 / 頂尖交易員曝險)."""
    headers = headers or headers_from_env()
    date = date or _today_tpe()          # 報告日與 id 一律台北日期,同日重跑才會覆蓋
    start = _window_start(lookback_days + 2)
    notes, ctx, blocks, kpis, foot, missing = [], {}, [], [], [], []
    rid, title = f"crypto-market-{date.replace('-', '')}", "加密市場晨報"
    syms = [_data.normalize_symbol(s if s.endswith("USDT") else s + "USDT") for s in symbols]
    try:
        klines = _data.fetch_kline_batch(syms, "1d", start, None, headers)
    except _data.DataAccessError:
        # Only when the kline source is Blave: the desktop sets BLAVE_KLINE_SOURCE=binance (public).
        return _skip_no_access(rid, title, title, "日 K(BLAVE_KLINE_SOURCE 不是 binance)")
    closes = {}
    for s in syms:
        df = klines.get(s)
        if df is None or len(df) < 2:
            notes.append(f"{s} 日 K 不足")
            continue
        closes[s] = df["Close"].dropna()
    if not closes:
        raise ValueError("沒有任何幣種的日 K,無法產晨報")
    rows = []
    for s, c in closes.items():
        last = float(c.iloc[-1])
        r1 = c.iloc[-1] / c.iloc[-2] - 1
        r7 = c.iloc[-1] / c.iloc[-8] - 1 if len(c) > 8 else None
        r30 = c.iloc[-1] / c.iloc[-(lookback_days + 1)] - 1 if len(c) > lookback_days else None
        label = s.replace("USDT", "")
        rows.append({"symbol": label, "price": _num(last, 2), "r1": _pct(r1 * 100),
                     "r7": _pct(r7 * 100) if r7 is not None else None,
                     "r30": _pct(r30 * 100) if r30 is not None else None})
        ctx[label] = f"{_num(last, 2)},1d {_pct(r1 * 100)}" + (f",30d {_pct(r30 * 100)}" if r30 is not None else "")
        if len(kpis) < 2:
            kpis.append(kpi(label, _num(last, 2), _tone(r1), unit="USDT", delta=_pct(r1 * 100)))
    ctx["資料日"] = str(next(iter(closes.values())).index[-1].date())

    fund = _indicator(_data.fetch_funding_rate, ("BTCUSDT", "1d", start, None, headers), "BTC 資金費率",
                      ctx, kpis, notes, missing, fmt=lambda v: f"{v:+.4f}%")
    direction = _indicator(_data.fetch_market_direction, ("1d", start, None, headers), "市場方向", ctx, kpis, notes, missing)
    shortage = _indicator(_data.fetch_capital_shortage, ("1d", start, None, headers), "資金稀缺", ctx, kpis, notes, missing)
    exposure = _indicator(_data.fetch_top_trader_exposure, ("1d", start, None, headers), "頂尖交易員曝險", ctx, kpis, notes, missing)

    base = next(iter(closes))
    base_c = closes[base]
    base_ma = _mean(base_c, lookback_days)
    if base_ma is not None:
        ctx[f"{base.replace('USDT', '')} 近 {lookback_days} 日均"] = _num(base_ma, 2)
        _where(ctx, float(base_c.iloc[-1]), [(base_ma, f"近 {lookback_days} 日均")])
    blocks.append(kpi_row(kpis[:6], title=_headline(base.replace("USDT", ""),
                                                    float(base_c.iloc[-1] / base_c.iloc[-2] - 1),
                                                    float(base_c.iloc[-1]), base_ma, f"近 {lookback_days} 日均")))
    win = {s: c.tail(lookback_days + 1) for s, c in closes.items()}   # 圖與表同一個 N 日窗口
    series = [(base.replace("USDT", ""), "primary", win[base] / win[base].iloc[0] * 100)]
    series += [(s.replace("USDT", ""), "benchmark", c / c.iloc[0] * 100) for s, c in win.items() if s != base][:3]
    rel = sorted(((float(c.iloc[-1] / c.iloc[0] * 100 - 100), s.replace("USDT", "")) for s, c in win.items()),
                 reverse=True)
    spread = f"{rel[0][1]} 領先 {rel[-1][1]} {rel[0][0] - rel[-1][0]:,.1f} 個百分點" if len(rel) > 1 else None
    if spread:
        ctx[f"{lookback_days} 日相對表現"] = spread
    lc = line_chart(f"相對表現(重定基 100,{lookback_days} 日)" + (f":{spread}" if spread else ""), series, y_unit="",
                    caption=_cap("每個幣種以窗口第一天收盤為 100",
                                 f"窗口報酬 {rel[0][1]} {rel[0][0]:+,.1f}%、{rel[-1][1]} {rel[-1][0]:+,.1f}%"
                                 if len(rel) > 1 else None))
    if lc:
        blocks.append(lc)
    blocks.append(table("主要幣種報價與報酬", [("symbol", "幣種", "left"), ("price", "價格", "right"),
                                              ("r1", "1 日", "right", "percent"), ("r7", "7 日", "right", "percent"),
                                              ("r30", f"{lookback_days} 日", "right", "percent")], rows,
                        caption="Binance USDT 永續日 K 收盤;最後一根為今日未收盤 bar"))
    if fund is not None:
        lc = line_chart("BTC 資金費率", [("BTC", "primary", fund)], y_unit="%", reflines=[(0.0, "0", False)],
                        caption=_cap("Binance BTCUSDT 日頻資金費率,單位 %",
                                     _vs7(fund, lambda v: f"{v:+.4f}%")))
        if lc:
            blocks.append(lc)
    ind = [(n, "benchmark", s) for n, s in (("市場方向", direction), ("資金稀缺", shortage)) if s is not None]
    if ind:
        ind[0] = (ind[0][0], "primary", ind[0][2])
        lc = line_chart("Blave 市場指標(z-score)", ind,
                        caption=_cap("標準化分數,0 = 樣本均值", "日頻資料只到前一個完整日",
                                     f"{ind[0][0]} {_vs7(ind[0][2])}"))
        if lc:
            blocks.append(lc)
    if exposure is not None:
        # 這支不是 z-score(實測值約 20–30),不能跟上面同軸;單獨一張、不標單位。
        lc = line_chart("頂尖交易員曝險", [("曝險", "primary", exposure)],
                        caption=_cap("Blave 頂尖交易員曝險指標原始值(非標準化),日頻資料只到前一個完整日",
                                     _vs7(exposure)))
        if lc:
            blocks.append(lc)
    cal = _calendar_rows(headers, notes, missing, countries=["US", "CN", "EU", "JP"])
    if cal:
        blocks.append(table("今日總經事件", _CAL_COLUMNS, cal, caption="台北時間;priority 1–2 的事件"))
    # 只描述報告裡有的系列:跳過的指標不留一句讀者找不到對應圖的口徑。
    src = "價格:Binance USDT 永續日 K。"
    if fund is not None:
        src += "資金費率為 Binance 日頻,單位 %。"
    if direction is not None or shortage is not None:
        src += "市場方向 / 資金稀缺為 Blave 指標(z-score)" + (";" if exposure is not None else "。")
    if exposure is not None:
        src += "頂尖交易員曝險為指標原始值。"
    if any(x is not None for x in (fund, direction, shortage, exposure)):
        src += "日頻指標只到前一個完整日。"
    foot += [("src", src)]
    blocks.append(footnote(foot))
    return Pack(rid, title, "morning", title, blocks, ctx, notes, missing=missing)


# ─── template 3: 單標的晨報 ───────────────────────────────────────────────────

def symbol_brief(symbol, date=None, headers=None, lookback_days=90):
    """單標的晨報 data pack. A 4–6 digit id is a Taiwan stock (日 K + 外資買賣超);
    anything else is a crypto USDT perp (日 K + 資金費率 + 爆倉 / 巨鯨 / 多空力道)."""
    headers = headers or headers_from_env()
    sym = str(symbol).strip().upper()
    if sym.isdigit():
        return _tw_symbol_brief(sym, date, headers, lookback_days)
    return _crypto_symbol_brief(sym, date, headers, lookback_days)


def _prior20(bars, notes):
    """(前 20 日高, 前 20 日低) = 倒數第 2–21 根的最高價/最低價,或 (None, None) 並記 notes。"""
    # 不含當日:含當日時收盤永遠不可能高於這個值,判讀會寫出與事實相反的「仍在 20 日高之下」;
    # 不含當日,今日收盤才可能高於(或低於)這個值。不足 21 根就不算,不拿短窗口頂替。
    if len(bars) < 21:
        notes.append(f"日 K 只有 {len(bars)} 根,不足 21 根,前 20 日高/低省略")
        return None, None
    w = bars.iloc[-21:-1]
    return float(w["High"].max()), float(w["Low"].min())


def _levels(bars, notes):
    """bars: `_clean_ohlc` 過的日 K(同一份也拿去畫圖)。均線取收盤,含當日。"""
    hi, lo = _prior20(bars, notes)
    lv = {} if hi is None else {"前 20 日高": hi, "前 20 日低": lo}
    for n in (5, 20, 60):
        if len(bars) >= n:
            lv[f"{n} 日均"] = float(bars["Close"].tail(n).mean())
    return lv


_LEVELS_TITLE = "近期高低與均線"


def _level_lines(lv):
    # 兩條都不強調:紅色低點線讀起來就是在標支撐,與「價位是統計、不是支撐」相反。
    return [(lv[k], k, False) for k in ("前 20 日高", "前 20 日低") if k in lv]


def _levels_table(lv, last):
    rows = [{"level": k, "price": _num(v, 2), "dist": _pct((last / v - 1) * 100)} for k, v in lv.items()]
    # 距現價是方向不是損益,不走 percent 的上色閘門。
    return table(_LEVELS_TITLE, [("level", "項目", "left"), ("price", "數值", "right"), ("dist", "距現價", "right")],
                 rows, caption="歷史統計值,非支撐壓力或進出場價。距現價 = 現價相對該數值的百分比,正值表示現價在其上")


def _tw_symbol_brief(stock_id, date, headers, lookback_days):
    date = date or _today_tpe()
    start = (datetime.strptime(date, "%Y-%m-%d") - timedelta(days=lookback_days)).strftime("%Y-%m-%d")
    notes, ctx, blocks, kpis, foot, missing = [], {}, [], [], [], []
    rid, title = f"symbol-{stock_id}-{date.replace('-', '')}", f"{stock_id} 晨報"
    try:
        df = _data.fetch_twstock_ohlcv(stock_id, "1d", headers, start=start, end=date)
    except _data.DataAccessError:
        # The daily fetcher goes to the stock's own exchange on the desktop (no key): shares → 張,
        # naive Taipei dates → the same tz the ohlcv path carries.
        try:
            df = _data.fetch_twstock_price(stock_id, start, date, headers)
        except _data.DataAccessError as e:
            # A cause means the free chain ran and failed (lib.data chains it): that is the
            # real error, not a data-access one — never "add a card" for an exchange outage.
            if e.__cause__ is not None:
                raise ValueError(f"{stock_id} 免費日線抓不到({type(e.__cause__).__name__}: "
                                 f"{str(e.__cause__)[:120]})") from e.__cause__
            return _skip_no_access(rid, title, "單標的晨報", "日 K")
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
    df = _clean_ohlc(df) if df is not None else df
    if df is None or len(df) < 2:
        raise ValueError(f"{stock_id} 日 K 不足兩個交易日")
    c = df["Close"].dropna()
    last, prev = float(c.iloc[-1]), float(c.iloc[-2])
    chg = last / prev - 1
    vol, vol5 = float(df["Volume"].iloc[-1]), float(df["Volume"].tail(5).mean())
    ctx["資料日"] = str(c.index[-1].date())
    ctx["收盤"] = f"{_num(last, 2)}({_pct(chg * 100)}),量 {_num(vol)} 張(5 日均 {_num(vol5)})"
    kpis.append(kpi("收盤", _num(last, 2), _tone(chg), delta=_pct(chg * 100)))
    kpis.append(kpi("成交量", _num(vol), "neutral", unit="張", delta=_pct((vol / vol5 - 1) * 100) + " vs 5日均"))
    lv = _levels(df, notes)
    ctx[_LEVELS_TITLE] = ", ".join(f"{k} {_num(v, 2)}" for k, v in lv.items())
    _where(ctx, last, [(lv.get("前 20 日高"), "前 20 日高"), (lv.get("60 日均"), "60 日均")])

    inst = None
    try:
        inst = _data.fetch_twstock_institutional(stock_id, start, date, headers)
    except _data.DataAccessError:
        _no_access("外資買賣超", notes, missing)
    except Exception as e:
        notes.append(f"外資買賣超抓取失敗({type(e).__name__})")
    if inst is not None and len(inst) and "foreign_net" in inst:
        fn = inst["foreign_net"].dropna() / 1000.0   # 股 → 張
        if len(fn):
            f_last = float(fn.iloc[-1])
            f5 = float(fn.tail(5).sum())
            ctx["外資買賣超"] = f"{_signed(f_last)} 張(近 5 日累計 {_signed(f5)} 張,{fn.index[-1].date()})"
            kpis.append(kpi("外資買賣超", _signed(f_last), _tone(f_last), unit="張", delta=f"5日累計 {_signed(f5)}"))
            foot.append(("inst", "外資買賣超 = 外資買進 − 賣出,資料源以股為單位,此處換算為張(÷1000)。"))
    blocks.append(kpi_row(kpis[:6], title=_headline(stock_id, chg, last, lv.get("前 20 日高"), "前 20 日高")))
    ck = candlestick(_price_title(f"{stock_id} 日 K", last, lv.get("60 日均")), df.tail(_PRICE_BARS), y_unit="元",
                     caption=_cap(f"近 {min(len(df), _PRICE_BARS)} 個交易日日 K,未還原價",
                                  ("參考線為前 20 日高 " + _num(lv["前 20 日高"], 2) + " / 低 " + _num(lv["前 20 日低"], 2)
                                   + "(不含當日)") if "前 20 日高" in lv else None,
                                  f"60 日均 {_num(lv['60 日均'], 2)}" if "60 日均" in lv else None),
                     reflines=_level_lines(lv))
    if ck:
        blocks.append(ck)
    if inst is not None and len(inst) and "foreign_net" in inst:
        net = inst["foreign_net"].dropna() / 1000.0
        tail = net.tail(10)
        f10 = float(tail.sum())
        prev10 = float(net.tail(20).head(10).sum()) if len(net) >= 20 else None
        ctx["外資 10 日累計"] = f"{_signed(f10)} 張" + (f"(前 10 日 {_signed(prev10)} 張)" if prev10 is not None else "")
        bc = bar_chart("外資近 10 日買賣超(張)", [(t.strftime("%m/%d"), v) for t, v in tail.items()],
                       caption=_cap("每日淨買賣超,張",
                                    f"10 日累計 {_signed(f10)} 張,前 10 個交易日累計 {_signed(prev10)} 張"
                                    if prev10 is not None else f"10 日累計 {_signed(f10)} 張"))
        if bc:
            blocks.append(bc)
    lt = _levels_table(lv, last)
    if lt:
        blocks.append(lt)
    foot.append(("src", ("日 K 為未還原價" if foot and foot[0][0] == "src_free" else "日 K 為 TWSE 未還原價")
                 + ",成交量為張。前 20 日高/低 = 不含當日的前 20 個交易日最高價/最低價,均線取收盤價(含當日)。"))
    blocks.append(footnote(foot))
    return Pack(rid, title, "morning", "單標的晨報", blocks, ctx, notes, missing=missing)


def _crypto_symbol_brief(sym, date, headers, lookback_days):
    date = date or _today_tpe()
    start = _window_start(lookback_days + 2)
    s = _data.normalize_symbol(sym if sym.endswith("USDT") else sym + "USDT")
    label = s.replace("USDT", "")
    notes, ctx, blocks, kpis, foot, missing = [], {}, [], [], [], []
    rid, title = f"symbol-{label.lower()}-{date.replace('-', '')}", f"{label} 晨報"
    try:
        df = _data.fetch_kline(s, "1d", start, None, headers)
    except _data.DataAccessError:
        return _skip_no_access(rid, title, "單標的晨報", "日 K(BLAVE_KLINE_SOURCE 不是 binance)")
    df = _clean_ohlc(df) if df is not None else df
    if df is None or len(df) < 2:
        raise ValueError(f"{s} 日 K 不足")
    c = df["Close"].dropna()
    last, chg = float(c.iloc[-1]), float(c.iloc[-1] / c.iloc[-2] - 1)
    ctx["資料日"] = str(c.index[-1].date())
    ctx["價格"] = f"{_num(last, 2)} USDT({_pct(chg * 100)})"
    kpis.append(kpi(label, _num(last, 2), _tone(chg), unit="USDT", delta=_pct(chg * 100)))
    lv = _levels(df, notes)
    ctx[_LEVELS_TITLE] = ", ".join(f"{k} {_num(v, 2)}" for k, v in lv.items())
    _where(ctx, last, [(lv.get("前 20 日高"), "前 20 日高"), (lv.get("60 日均"), "60 日均")])

    args = (s, "1d", start, None, headers)
    fund = _indicator(_data.fetch_funding_rate, args, "資金費率", ctx, kpis, notes, missing, fmt=lambda v: f"{v:+.4f}%")
    liq = _indicator(_data.fetch_liquidation, args, "爆倉指標", ctx, kpis, notes, missing)
    whale = _indicator(_data.fetch_whale_hunter, args, "巨鯨警報", ctx, kpis, notes, missing)
    taker = _indicator(_data.fetch_taker_intensity, args, "多空力道", ctx, kpis, notes, missing)
    blocks.append(kpi_row(kpis[:6], title=_headline(label, chg, last, lv.get("前 20 日高"), "前 20 日高")))
    # 60 日均仍用整段收盤算,K 線只畫最後 _PRICE_BARS 根。
    ck = candlestick(_price_title(f"{label} 日 K", last, lv.get("60 日均")), df.tail(_PRICE_BARS), y_unit="USDT",
                     caption=_cap(f"近 {min(len(df), _PRICE_BARS)} 根日 K",
                                  ("參考線為前 20 日高 " + _num(lv["前 20 日高"], 2) + " / 低 " + _num(lv["前 20 日低"], 2)
                                   + "(不含當日)") if "前 20 日高" in lv else None,
                                  f"60 日均 {_num(lv['60 日均'], 2)}" if "60 日均" in lv else None),
                     reflines=_level_lines(lv))
    if ck:
        blocks.append(ck)
    if fund is not None:
        lc = line_chart("資金費率", [(label, "primary", fund)], y_unit="%", reflines=[(0.0, "0", False)],
                        caption=_cap("Binance 日頻資金費率,單位 %", _vs7(fund, lambda v: f"{v:+.4f}%")))
        if lc:
            blocks.append(lc)
    ind = [(n, "benchmark", x) for n, x in (("爆倉指標", liq), ("巨鯨警報", whale), ("多空力道", taker)) if x is not None]
    if ind:
        ind[0] = (ind[0][0], "primary", ind[0][2])
        lc = line_chart("Blave 指標(z-score)", ind,
                        caption=_cap("標準化分數,0 = 樣本均值", "日頻資料只到前一個完整日",
                                     f"{ind[0][0]} {_vs7(ind[0][2])}"))
        if lc:
            blocks.append(lc)
    lt = _levels_table(lv, last)
    if lt:
        blocks.append(lt)
    foot.append(("src", "價格:Binance USDT 永續日 K,最後一根為今日未收盤 bar。"
                 + ("資金費率單位 %。" if fund is not None else "")
                 + ("爆倉 / 巨鯨 / 多空力道為 Blave 指標 z-score。" if ind else "")
                 + "前 20 日高/低 = 不含當日(今日未收盤 bar)的前 20 根日 K 最高價/最低價,均線取收盤價(含當日)。"))
    blocks.append(footnote(foot))
    return Pack(rid, title, "morning", "單標的晨報", blocks, ctx, notes, missing=missing)


# ─── publish ──────────────────────────────────────────────────────────────────

def _watch_table(rows):
    """narrative['watch'] → a `table` block. Rows are (條件, 門檻, 現在值) triples —
    prose is what the wall was made of, so this slot no longer takes a string."""
    if isinstance(rows, (str, bytes)):
        raise ValueError("narrative['watch'] is a table now, not prose: give "
                         f"{WATCH_ROWS[0]}–{WATCH_ROWS[1]} rows of (條件, 門檻, 現在值), e.g. "
                         "[('外資期貨淨多單', '回落到 1 萬口以下', '+12,300 口'), "
                         "('外資現貨連續買超', '轉為連兩日淨賣超', '+267.0 億')] — references/reports.md §1b")
    try:
        rows = list(rows)
    except TypeError:
        raise ValueError(f"narrative['watch'] must be a list of (條件, 門檻, 現在值) rows, got {type(rows).__name__}")
    lo, hi = WATCH_ROWS
    if not lo <= len(rows) <= hi:
        raise ValueError(f"narrative['watch'] has {len(rows)} row(s), needs {lo}–{hi} — "
                         "一列一個條件;湊不出第二個條件就別發這一格,寫不下第四個就留最重要的三個")
    clean = []
    for i, row in enumerate(rows):
        if not isinstance(row, (list, tuple)) or len(row) != 3:
            raise ValueError(f"narrative['watch'][{i}] must be 3 strings (條件, 門檻, 現在值), got {row!r}")
        cells = {}
        for (key, label, _), value in zip(WATCH_COLUMNS, row):
            value = str(value).strip()
            if not value:
                raise ValueError(f"narrative['watch'][{i}] 的「{label}」是空的 — "
                                 "三格缺一格就不要放這一列(現在值報不出來,這個條件就還不能觀察)")
            if len(value) > WATCH_CELL:
                raise ValueError(f"narrative['watch'][{i}] 的「{label}」是 {len(value)} 字,上限 {WATCH_CELL}"
                                 f"(超出 {len(value) - WATCH_CELL}) — 一格寫一件事,理由留給 read")
            cells[key] = value
        clean.append(cells)
    return table(SLOTS["watch"][0], WATCH_COLUMNS, clean, caption=WATCH_CAPTION)


def _check_read_form(body):
    """`read` 是用掃的:3–5 條各帶一個數字的條列,或 3–5 個各自是主張的 ### 子標,兩種擇一。

    範圍而不是定值:有些日子只有三件事值得講,有些有五件;湊到定值只會多出填充的一條
    或砍掉真的該講的一條。整格仍受 300 字上限管,所以放寬條數不會放寬總長度。"""
    lines = [ln.strip() for ln in body.splitlines() if ln.strip()]
    heads = [ln for ln in lines if ln.startswith("### ")]
    bullets = [ln for ln in lines if ln.startswith("- ")]
    lo, hi = READ_ITEMS
    if (lo <= len(heads) <= hi and not bullets) or (lo <= len(bullets) <= hi and not heads):
        return
    raise ValueError(f"narrative['read'] must be {lo}–{hi} items in ONE form — '- ' bullets "
                     f"(每條一個數字加它的基準) or '### ' sub-headings (小標本身就是主張); "
                     f"found {len(heads)} 個 ### 子標、{len(bullets)} 條「- 」條列. "
                     "整段散文不算:讀者是靠標題與條列找東西的 — references/reports.md §1b")


# One sentence per BLAVE_DATA_ACCESS_WHY (shell/main.js dataAccessWhy): `unknown` covers a signed-in
# account whose status could not be read this turn — likely already carded, so it is not told to
# add one; the default (no reason given) is that neutral sentence too.
_MISSING_FOOT = {
    "zh": ("這份沒有 Blave 資料({names})。", {
        "signed_out": "登入 Blave、綁卡送 14 天資料後可以補上。",
        "no_card": "綁卡送 14 天資料後可以補上。",
        "no_balance": "儲值後可以補上。"}, "這一輪讀不到資料狀態,下次有 Blave 資料時可以補上。"),
    "en": ("No Blave data in this report ({names}). ", {
        "signed_out": "Sign in to Blave and add a card for 14 days of data to fill it in.",
        "no_card": "Adding a card starts 14 days of data that fills it in.",
        "no_balance": "Topping up the balance fills it in."},
        "The data status could not be read this turn; the next run with Blave data fills it in."),
}


def _access_fix(lang):
    """What restores Blave data, matching the shell's reason (BLAVE_DATA_ACCESS_WHY)."""
    _, fixes, default = _MISSING_FOOT["en" if lang == "en" else "zh"]
    return fixes.get(os.environ.get("BLAVE_DATA_ACCESS_WHY"), default)


def _missing_item(pack, lang):
    """Footnote line naming the Blave-only series the report is missing."""
    head = _MISSING_FOOT["en" if lang == "en" else "zh"][0]
    names = _missing_names(pack) if lang != "en" else ", ".join(dict.fromkeys(m["name"] for m in pack.missing))
    return ("blave", head.format(names=names) + _access_fix(lang))


def publish(pack, narrative=None, report_id=None, title=None, origin=None, lang="zh"):
    """Assemble the pack and the narrative into a report and drop it. Returns the path.

    narrative: {"lead", "read", "watch", "risk"} — any subset. `lead` / `read` / `risk`
    are markdown capped by `pack.slots` (600 / 300 / 100); `watch` is 2–3 rows of
    (條件, 門檻, 現在值), not prose. `lead` becomes the opening conclusion card (right
    after meta), `read` a section after the data blocks, `watch` the 觀察重點 table,
    `risk` a warning callout just before the footnote. No narrative = a data-only
    report — the honest form for a scheduled run, never a place for a made-up view.
    origin: "chat" (default) or "scheduled" — shown in the report header.
    lang: "zh" (default) or "en" — only the footnote line about missing Blave data
    (`pack.missing`) is localised; the template blocks are Chinese.
    Returns None without writing when `pack.skip` is set."""
    if pack.skip:
        # 不 raise:排程跑到休市日要記成 skipped(exit 0、沒有新報告),raise 會變 failed 並發警報。
        print(f"[{pack.report_id}] not published: {pack.skip}")
        return None
    narrative = dict(narrative or {})
    if "action" in narrative:
        raise ValueError("'action' was renamed to 'watch' (觀察重點): conditions and indicator thresholds "
                         "only, no trade instruction, see references/reports.md §1b")
    unknown = set(narrative) - set(pack.slots)
    if unknown:
        raise ValueError(f"unknown narrative slot(s): {sorted(unknown)}; allowed: {sorted(pack.slots)}")
    watch = narrative.pop("watch", None)
    watch_block = _watch_table(watch) if watch else None
    for k, v in narrative.items():
        cap = pack.slots[k][1]
        if not isinstance(v, str):
            raise ValueError(f"narrative[{k!r}] must be a markdown string")
        if len(v) > cap:
            raise ValueError(f"narrative[{k!r}] is {len(v)} chars, cap {cap} (over by {len(v) - cap}) — "
                             f"cut it, don't summarise the summary: {_SLOT_FORM[k]}"
                             + ("。圖表 title / caption 已經帶了結論與基準,敘事不再重述那些數字" if k == "read" else ""))
    if narrative.get("read", "").strip():
        _check_read_form(narrative["read"].strip())
    blocks = list(pack.blocks)
    foot = blocks.pop() if blocks and blocks[-1].get("type") == "footnote" else None
    if pack.missing or (lang == "en" and foot):
        # Copy before changing anything: the pack is reusable and its footnote dict is shared.
        items = [(i["id"], _data.PUBLIC_SOURCE_EN.get(i["text"], i["text"]) if lang == "en" else i["text"])
                 for i in (foot or {}).get("items", [])]
        foot = footnote(items + ([_missing_item(pack, lang)] if pack.missing else []))
    out = []
    if narrative.get("lead", "").strip():
        out.append(text(narrative["lead"].strip(), lead=True))
    out += blocks
    body = narrative.get("read", "").strip()
    if body:
        heading = pack.slots["read"][0]
        # 只有 body 自己已經以這個標題開頭才省略;以 ### 子標或 #1 開頭的段落照常加標題。
        out.append(text(body if body.startswith(heading) else f"{heading}\n\n{body}"))
    if watch_block:
        out.append(watch_block)
    if narrative.get("risk", "").strip():
        out.append(callout(narrative["risk"].strip(), tone="warning", title=pack.slots["risk"][0]))
    if foot:
        out.append(foot)
    # [^id] 是 api 唯一會拒的敘事錯誤,而 id 清單就在手上——本地先擋,免得整份進 failed/。
    known = {i["id"] for i in (foot or {}).get("items", [])}
    written = dict(narrative)
    if watch_block:
        written["watch"] = " ".join(v for r in watch_block["rows"] for v in r.values())
    for key, body in written.items():
        missing = sorted(set(_FNREF_RE.findall(body)) - known)
        if missing:
            raise ValueError(f"narrative[{key!r}] references footnote id(s) {missing} that the pack has not got; known: {sorted(known)}")
    if origin not in (None, "chat", "scheduled"):
        raise ValueError("origin must be 'chat' or 'scheduled'")
    meta = dict(pack.meta)
    narrated = bool(watch_block) or any(v.strip() for v in narrative.values())
    meta["origin"] = origin or ("chat" if narrated else "scheduled")
    # 純數據包用自己的 id(-auto):排程版同一天跑,不能把早上那份有判讀的蓋掉
    # (29026 實測:cron 首跑覆蓋了對話產的 tw-market-20260902)。明給 report_id 就照給。
    if report_id is None:
        report_id = pack.report_id if narrated else pack.report_id + "-auto"
    # write_report prints the "moved to reports/sent/, reply now" line for both paths.
    return write_report(report_id, title or pack.title, out,
                        type=pack.type, report_type=pack.report_type, meta=meta)
