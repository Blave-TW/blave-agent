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
                 meta=None, skip=None, missing=None, owners=None, news=None):
        self.report_id = report_id
        self.title = title
        self.type = type_
        self.report_type = report_type
        self.blocks = [_fw_block(b) for b in blocks]
        # 休市表出處是授權條件要原文照附的一句,不動它的標點
        self.context = {k: (v if k in _VERBATIM_CTX or not isinstance(v, str) else _fw(v)) for k, v in context.items()}
        # which brick laid out each block (kpi_row / footnote for the assembler's own) — lead_chart reads it
        self.owners = list(owners) if owners else ["?"] * len(self.blocks)
        # {"market", "n", "candidates", "at"}: the agent-filled news slot and where its block goes
        self.news = news
        self.notes = notes or []          # what is missing and why
        self.meta = meta or {}
        self.skip = skip                  # reason this pack must not be published, or None
        # Blave-only series skipped for lack of data access: [{"name", "reason"}], reason
        # "signed_out" / "no_data_access". publish() names them in the footnote.
        self.missing = missing or []
        self.slots = dict(SLOTS)
        if news is not None:
            self.slots["news"] = ("新聞", None)

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
        if self.news is not None:
            lines += _news_describe(self.news)
        slots = [f"{k}=表格 {WATCH_ROWS[0]}–{WATCH_ROWS[1]} 列(條件/門檻/現在值)" if k == "watch"
                 else f"news=≤{self.news['n']} 則" + "{title, summary≤40, tag, sources[(名稱, https 連結)], published_at}"
                 if k == "news" else f"{k}≤{cap}" + (f"({_SLOT_FORM[k]})" if k in _SLOT_FORM else "")
                 for k, (_, cap) in self.slots.items()]
        lines.append("  narrative slots: " + ", ".join(slots))
        charts = list(dict.fromkeys(o for o, b in zip(self.owners, self.blocks)
                                    if b.get("type") in _CHART_TYPES and o != "?"))
        if len(charts) > 1:
            lines.append("  lead_chart(選填,論點圖排第一): " + " / ".join(charts))
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
    """items: (id, text) or (id, text, https url) — a url makes the report schema 1.4."""
    out = []
    for it in items:
        d = {"id": it[0], "text": it[1][:1000]}
        if len(it) > 2 and it[2]:
            d["url"] = it[2]
        out.append(d)
    return {"type": "footnote", "items": out[:30]}


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
    return f"最新 {fmt(float(ser.iloc[-1]))}，7 日均 {fmt(float(ser.tail(7).mean()))}"


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


def _indicator(fn, args, name, ctx, kpis, notes, missing, fmt=lambda v: f"{v:+.2f}", gloss=None):
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
    ctx[name] = f"{fmt(v)}（7 日均 {fmt(m7)}，{ser.index[-1].date()}）"
    # gloss:自家指標第一次出現時的白話讀法(R9 W3),寫在 delta 裡,不另寫說明段
    kpis.append(kpi(name, fmt(v), "neutral", delta=(f"{gloss},7日均 {fmt(m7)}" if gloss else f"7日均 {fmt(m7)}")))
    return ser


# ─── recipes: the four templates ──────────────────────────────────────────────
# A recipe is data: which bricks (lib/report_bricks.py), in which order, with which
# parameters; `kpi` names the bricks whose KPI cells make the row, the first one the focus.

_TW_FLOW = [["tw_turnover", {}], ["tw_institutional", {}], ["tw_margin", {}], ["tw_futures_inst", {}]]
_TW_KPI = ["price_chart", "tw_turnover", "tw_institutional", "tw_margin", "tw_futures_inst"]

RECIPES = {
    # 晨報 v2(spec 2026-09-26 §2.2):沿用 id tw-market-YYYYMMDD。指數計算窗口仍 90 天(60 日均、前 20 日高
    # 要 60 個交易日),K 線只畫最後 45 天;融資只留 KPI,圖留在收盤報告。
    "tw_market_brief": {
        "id": "tw-market", "title": "台股大盤晨報", "lookback_days": 45,
        "kpi": _TW_KPI + ["txf_night"],
        "bricks": [["price_chart", {"symbol": "TAIEX", "display_days": 45}], ["tw_turnover", {}],
                   ["tw_institutional", {}], ["tw_margin", {"chart": False}], ["movers", {"market": "tw", "n": 10}],
                   ["tw_futures_inst", {}], ["txf_night", {}], ["tw_announcements", {"n": 5}],
                   ["news", {"market": "tw", "n": 5}],
                   ["event_calendar", {"countries": ["US", "CN", "TW", "JP", "EU"], "dividends": True}]],
    },
    "tw_close_brief": {
        "id": "tw-close", "title": "台股收盤報告", "lookback_days": 45, "mode": "close",
        "kpi": _TW_KPI,
        "bricks": [["price_chart", {"symbol": "TAIEX"}]] + _TW_FLOW + [
            ["event_calendar", {"countries": ["US", "CN", "TW", "JP", "EU"], "today_only": True}]],
    },
    # 恐懼貪婪的條款確認前,KPI 第六格放交易員曝險(spec §2.2)。
    "crypto_market_brief": {
        "id": "crypto-market", "title": "加密市場晨報", "lookback_days": 30,
        "kpi": ["quote_table", "liquidation", "funding", "blave_indicators"],
        "bricks": [["quote_table", {"top_mcap": 5}], ["funding", {"symbol": "BTC", "chart": False}],
                   ["derivs_table", {}], ["liquidation", {"hours": 24}], ["movers", {"market": "crypto", "n": 5}],
                   ["blave_indicators", {"names": ["市場方向", "資金稀缺", "頂尖交易員曝險"],
                                         "kpi": ["市場方向", "頂尖交易員曝險"], "raw_chart": False}],
                   ["news", {"market": "crypto", "n": 5}],
                   ["event_calendar", {"countries": ["US", "CN", "EU", "JP"]}]],
    },
}


def _recipe(name, **over):
    r = dict(RECIPES[name])
    r.update(over)
    return r


def _with_symbols(recipe, symbols):
    syms = list(symbols)
    recipe["bricks"] = [[n, dict(p, symbols=syms) if n in ("relative_perf", "quote_table") else p]
                        for n, p in recipe["bricks"]]
    return recipe


def build(recipe, date=None, headers=None):
    """Run a recipe → `Pack` (see lib/report_bricks.py)."""
    from lib import report_bricks
    return report_bricks.build(recipe, date, headers)


# ─── 自組配方:report_jobs/<id>/recipe.json ─────────────────────────────────────

_BUILTIN_PREFIXES = ("tw-market", "tw-close", "crypto-market", "symbol-")
_RECIPE_ID_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,39}")
# 只出 KPI、不佔版面的積木不算進 R4 的 8 塊
_KPI_ONLY = {"tw_turnover", "txf_night"}
RECIPE_MAX_BRICKS = 8
# run.py of a recipe job: fixed text, the recipe is the job's data (references/reports.md §8)
RECIPE_RUN_PY = (
    "import os, sys\n"
    "sys.path.insert(0, os.getcwd())\n"
    "from lib.report_templates import build, load_recipe, publish\n"
    "publish(build(load_recipe(__file__)))\n"
)


def check_recipe(recipe):
    """Raise ValueError unless `recipe` is a runnable custom recipe: id (slug, not a built-in
    template's prefix), title, known bricks with known parameters, ≤8 bricks that lay out a
    block, `kpi` naming bricks in it. Returns the recipe."""
    import inspect
    from lib import report_bricks
    if not isinstance(recipe, dict):
        raise ValueError("a recipe is a dict {id, title, kpi, bricks}")
    extra = sorted(set(recipe) - set(_RECIPE_KEYS))
    if extra:
        # report_id / type / report_type stay the built-ins' own: a custom id overwriting tw-market-*, or a
        # `performance` type carrying news, is exactly what this check is for
        raise ValueError(f"recipe has unknown key(s) {extra}; a custom recipe takes {', '.join(_RECIPE_KEYS)}")
    lb = recipe.get("lookback_days", 45)
    if isinstance(lb, bool) or not isinstance(lb, int) or not 1 <= lb <= 365:
        raise ValueError(f"recipe lookback_days must be an integer 1–365, got {lb!r}")
    rid = recipe.get("id")
    if not isinstance(rid, str) or not _RECIPE_ID_RE.fullmatch(rid):
        raise ValueError(f"recipe id {rid!r} must match [a-z0-9][a-z0-9-]{{0,39}}")
    if any(rid == p.rstrip("-") or rid.startswith(p if p.endswith("-") else p + "-") for p in _BUILTIN_PREFIXES):
        raise ValueError(f"recipe id {rid!r} collides with a built-in template ({', '.join(_BUILTIN_PREFIXES)}): "
                         "the same id on the same day overwrites that template's report")
    title = recipe.get("title")
    if not isinstance(title, str) or not 1 <= len(title) <= 80:
        raise ValueError("recipe title must be 1–80 characters")
    bricks = recipe.get("bricks")
    if not isinstance(bricks, list) or not bricks:
        raise ValueError("recipe bricks must be a non-empty list of [name, {params}]")
    laid = 0
    for i, entry in enumerate(bricks):
        if not (isinstance(entry, (list, tuple)) and len(entry) == 2 and isinstance(entry[1], dict)):
            raise ValueError(f"bricks[{i}] must be [name, {{params}}]")
        name, params = entry
        fn = report_bricks.BRICKS.get(name)
        if fn is None:
            raise ValueError(f"bricks[{i}]: unknown brick {name!r}; bricks: {', '.join(report_bricks.BRICKS)}")
        allowed = [p for p in inspect.signature(fn).parameters if p != "b"]
        bad = sorted(set(params) - set(allowed))
        if bad:
            raise ValueError(f"bricks[{i}] {name}: unknown parameter(s) {bad}; takes {allowed}")
        for k, v in params.items():
            _check_param(f"bricks[{i}] {name}.{k}", k, v)
        if name not in _KPI_ONLY and params.get("chart", True):
            laid += 1
    if laid > RECIPE_MAX_BRICKS:
        raise ValueError(f"recipe lays out {laid} bricks, at most {RECIPE_MAX_BRICKS} (references/reports.md §1b R4): "
                         "drop the ones the lead does not use")
    names = [n for n, _ in bricks]
    for k in recipe.get("kpi", []):
        if k not in names:
            raise ValueError(f"kpi names {k!r}, which is not a brick of this recipe")
    if recipe.get("mode", "morning") not in ("morning", "close"):
        raise ValueError("recipe mode is 'morning' or 'close'")
    if recipe.get("mode") == "close" and not any(
            n == "price_chart" and str(p.get("symbol", "TAIEX")).upper() == "TAIEX" for n, p in bricks):
        raise ValueError("a 'close' recipe needs [\"price_chart\", {\"symbol\": \"TAIEX\"}]: it decides whether "
                         "the day was a trading day with a landed close; without it a holiday publishes nothing")
    return recipe


_RECIPE_KEYS = ("id", "title", "kpi", "bricks", "mode", "lookback_days")


def _check_param(where, key, v):
    """Value rules for brick parameters a recipe.json may carry — refused at save time, not
    on the first scheduled run."""
    from lib import report_bricks

    def whole(lo, hi):
        if isinstance(v, bool) or not isinstance(v, int) or not lo <= v <= hi:
            raise ValueError(f"{where} must be an integer {lo}–{hi}, got {v!r}")

    def listof(lo, hi, item_ok, what):
        if not isinstance(v, list) or not lo <= len(v) <= hi or not all(item_ok(x) for x in v):
            raise ValueError(f"{where} must be a list of {lo}–{hi} {what}, got {v!r}")

    def one_of(*choices):
        if v not in choices:
            raise ValueError(f"{where} must be one of {', '.join(map(repr, choices))}, got {v!r}")

    sym = lambda x: isinstance(x, str) and re.fullmatch(r"[A-Za-z0-9]{1,20}", x) is not None
    if key == "names":
        listof(1, 6, lambda x: x in report_bricks._INDICATORS, f"indicator names ({', '.join(report_bricks._INDICATORS)})")
    elif key == "kpi":
        if v is not None:
            listof(0, 6, lambda x: x in report_bricks._INDICATORS, "indicator names")
    elif key == "symbols":
        if v is not None:
            listof(1, 8, sym, "symbols")
    elif key == "symbol":
        if v is not None and not sym(v):
            raise ValueError(f"{where} must be a symbol like TAIEX, 2330 or BTC, got {v!r}")
    elif key == "market":
        one_of("tw", "crypto")
    elif key == "variant":
        one_of("market", "symbol")
    elif key == "countries":
        listof(1, 10, lambda x: isinstance(x, str) and re.fullmatch(r"[A-Z]{2}", x) is not None, "ISO country codes")
    elif key == "q":
        if v is not None and (not isinstance(v, str) or not 1 <= len(v) <= 40):
            raise ValueError(f"{where} must be 1–40 characters")
    elif key == "n":
        whole(1, 10)
    elif key == "hours":
        whole(1, 168)
    elif key == "bars":
        whole(2, 120)
    elif key in ("top_mcap", "kpi_n"):
        whole(0, 6)
    elif key == "display_days":
        if v is not None:
            whole(5, 365)
    elif key in ("chart", "raw_chart", "today_only", "dividends"):
        if not isinstance(v, bool):
            raise ValueError(f"{where} must be true or false, got {v!r}")
    elif key == "contract":
        if not (isinstance(v, str) and re.fullmatch(r"[A-Z]{2,4}", v)):
            raise ValueError(f"{where} must be a TAIFEX product id like TX, got {v!r}")


def save_recipe(job_id, recipe):
    """Write `report_jobs/<job_id>/recipe.json` (checked). Then register the schedule with
    `lib.report.register_schedule(job_id, …, script=RECIPE_RUN_PY)`. Returns the path."""
    import json
    from lib.report import JOBS_DIR, _write_text_atomic
    check_recipe(recipe)
    d = os.path.join(JOBS_DIR, job_id)
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, "recipe.json")
    _write_text_atomic(path, json.dumps(recipe, ensure_ascii=False, indent=2) + "\n")
    return path


def load_recipe(run_py):
    """The recipe next to a job's run.py (report_jobs/<id>/recipe.json)."""
    import json
    with open(os.path.join(os.path.dirname(os.path.abspath(run_py)), "recipe.json"), encoding="utf-8") as f:
        return check_recipe(json.load(f))


def tw_market_brief(date=None, headers=None, lookback_days=45):
    """台股大盤晨報 data pack for the morning of `date` (Taipei; default today).
    Reads the last trading day's close, turnover, 三大法人, 融資, 外資期貨淨多單, the TXF night
    session, the 10 largest 成交值 and the day's 重大訊息 (desktop: TWSE open data), a news
    slot (鉅亨 headlines as candidates; yours to fill in chat) and today's macro events and
    除權息. `lookback_days` covers the flow series (20-day means, futures chart); the index
    always spans 90 days for its 60-day mean, and the chart draws its last 45 days."""
    return build(_recipe("tw_market_brief", lookback_days=lookback_days), date, headers)


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
    return build(_recipe("tw_close_brief", lookback_days=lookback_days), date, headers)


def crypto_market_brief(date=None, headers=None, symbols=("BTC", "ETH", "SOL"), lookback_days=30):
    """加密市場晨報 data pack: price and 1 / 7 / 30-day returns of `symbols` plus the five
    largest coins by market cap, the derivatives table (OI 24h, funding, long/short), 24h
    liquidations, the day's movers, the market-wide Blave indicators, a news slot (yours to
    fill in chat; a scheduled run has no licensed crypto source and lays out none) and
    today's macro events."""
    return build(_with_symbols(_recipe("crypto_market_brief", lookback_days=lookback_days), symbols), date, headers)


def symbol_brief(symbol, date=None, headers=None, lookback_days=90):
    """單標的晨報 data pack. A 4–6 digit id is a Taiwan stock (日 K + 外資買賣超);
    anything else is a crypto USDT perp (日 K + 資金費率 + 爆倉 / 巨鯨 / 多空力道)."""
    sym = str(symbol).strip().upper()
    if sym.isdigit():
        recipe = {"id": f"symbol-{sym}", "title": f"{sym} 晨報", "report_type": "單標的晨報",
                  "lookback_days": lookback_days, "kpi": ["price_chart", "tw_institutional"],
                  "bricks": [["price_chart", {"symbol": sym}], ["tw_institutional", {"symbol": sym}],
                             ["levels_table", {}]]}
    else:
        label = _data.normalize_symbol(sym if sym.endswith("USDT") else sym + "USDT").replace("USDT", "")
        recipe = {"id": f"symbol-{label.lower()}", "title": f"{label} 晨報", "report_type": "單標的晨報",
                  "lookback_days": lookback_days, "kpi": ["price_chart", "funding", "blave_indicators"],
                  "bricks": [["price_chart", {"symbol": label}], ["funding", {"symbol": label, "variant": "symbol"}],
                             ["blave_indicators", {"names": ["爆倉指標", "巨鯨警報", "多空力道"], "symbol": label}],
                             ["levels_table", {}]]}
    return build(recipe, date, headers)


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

    narrative: {"lead", "read", "watch", "risk"} — any subset — plus, on a pack with a news
    slot, "news", and optionally "lead_chart". `lead` / `read` / `risk` are markdown capped by
    `pack.slots` (600 / 300 / 100); `watch` is 2–3 rows of (條件, 門檻, 現在值), not prose.
    `lead` becomes the opening conclusion card (right after meta), `read` a section after the
    data blocks, `watch` the 觀察重點 table, `risk` a warning callout just before the footnote.
    `news` is a list of ≤5 items {title, title_orig?, title_orig_lang?, summary, tag, sources,
    published_at, symbols?, channel?} (references/reports.md §1b › News); `lead_chart` names the brick
    whose chart moves up to right after the KPI row (the chart the lead argues from).
    No narrative = a data-only report — the honest form for a scheduled run, never a place for
    a made-up view; its news block (if the pack has one) is the licensed headlines as they are.
    Before anything is written, the lead's first sentence and every number the narrative
    quotes are checked against the pack (references/reports.md §1b › Automatic checks), and
    commas / colons / semicolons / brackets between Chinese characters become full-width.
    origin: "chat" (default) or "scheduled" — shown in the report header.
    lang: "zh" (default) or "en" — only the footnote line about missing Blave data
    (`pack.missing`) and the exchanges' attribution lines are localised; the blocks are Chinese.
    Returns None without writing when `pack.skip` is set."""
    if pack.skip:
        # 不 raise:排程跑到休市日要記成 skipped(exit 0、沒有新報告),raise 會變 failed 並發警報。
        print(f"[{pack.report_id}] not published: {pack.skip}")
        return None
    narrative = dict(narrative or {})
    if "action" in narrative:
        raise ValueError("'action' was renamed to 'watch' (觀察重點): conditions and indicator thresholds "
                         "only, no trade instruction, see references/reports.md §1b")
    if "news" in narrative and pack.news is None:
        raise ValueError("this pack has no news slot: add the `news` brick to the recipe, or leave 'news' out")
    unknown = set(narrative) - set(pack.slots) - {"lead_chart"}
    if unknown:
        raise ValueError(f"unknown narrative slot(s): {sorted(unknown)}; allowed: {sorted(set(pack.slots) | {'lead_chart'})}")
    lead_chart = narrative.pop("lead_chart", None)
    news_given = "news" in narrative
    news_in = narrative.pop("news", None)
    watch = narrative.pop("watch", None)
    for k, v in narrative.items():
        if not isinstance(v, str):
            raise ValueError(f"narrative[{k!r}] must be a markdown string")
    narrative = {k: _fw(v) for k, v in narrative.items()}
    if watch and not isinstance(watch, (str, bytes)):
        try:
            watch = [tuple(_fw(str(c)) for c in row) if isinstance(row, (list, tuple)) else row for row in watch]
        except TypeError:
            pass
    watch_block = _watch_table(watch) if watch else None
    for k, v in narrative.items():
        cap = pack.slots[k][1]
        if len(v) > cap:
            raise ValueError(f"narrative[{k!r}] is {len(v)} chars, cap {cap} (over by {len(v) - cap}) — "
                             f"cut it, don't summarise the summary: {_SLOT_FORM[k]}"
                             + ("。圖表 title / caption 已經帶了結論與基準,敘事不再重述那些數字" if k == "read" else ""))
    if narrative.get("read", "").strip():
        _check_read_form(narrative["read"].strip())
    if narrative.get("lead", "").strip():
        _check_lead(narrative["lead"].strip())
    _check_numbers(pack, narrative, watch_block)
    narrated = bool(watch_block) or any(v.strip() for v in narrative.values()) or bool(news_in)
    news_block, news_foot = _news_block(pack, news_in, news_given, narrated)
    news_block = _fw_block(news_block) if news_block else None

    pairs = list(zip(pack.owners, pack.blocks))
    foot = pairs.pop()[1] if pairs and pairs[-1][1].get("type") == "footnote" else None
    if news_block is not None:
        at = pack.news.get("at")
        pairs.insert(len(pairs) if at is None else min(at, len(pairs)), ("news", news_block))
    if lead_chart is not None:
        pairs = _lead_chart_first(pairs, lead_chart)
    blocks = [b for _, b in pairs]
    if pack.missing or (lang == "en" and foot) or news_foot:
        # Copy before changing anything: the pack is reusable and its footnote dict is shared.
        items = [dict(i, text=_data.PUBLIC_SOURCE_EN.get(i["text"], i["text"])) if lang == "en" else dict(i)
                 for i in (foot or {}).get("items", [])]
        items = [(i["id"], i["text"], i.get("url")) for i in items]
        if news_foot:
            items.append(news_foot)
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
    if foot and not foot.get("items"):
        foot = None
    if not blocks and not news_block and not narrated:
        # 例:只放 news 的自組配方,排程時沒有授權候選 → 發出去只剩 meta,是空報告
        print(f"[{pack.report_id}] not published: nothing in it today (no data block, no news, no narrative)")
        return None
    if foot:
        # en:缺資料那行是英文,別被轉成全形;其餘尾註在 Pack 建立時已轉過
        out.append(_fw_block(foot) if lang != "en" else foot)
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
    if len(out) + 1 > MAX_BLOCKS:
        print(f"WARNING: {len(out) + 1} blocks, over {MAX_BLOCKS} (references/reports.md §1b R4): "
              "drop the bricks the lead does not use")
    meta = dict(pack.meta)
    meta["origin"] = origin or ("chat" if narrated else "scheduled")
    # 純數據包用自己的 id(-auto):排程版同一天跑,不能把早上那份有判讀的蓋掉
    # (29026 實測:cron 首跑覆蓋了對話產的 tw-market-20260902)。明給 report_id 就照給。
    if report_id is None:
        report_id = pack.report_id if narrated else pack.report_id + "-auto"
    # write_report prints the "moved to reports/sent/, reply now" line for both paths.
    return write_report(report_id, title or pack.title, out,
                        type=pack.type, report_type=pack.report_type, meta=meta)


# ─── R9 W4:全形標點 ───────────────────────────────────────────────────────────

_CJK = "㐀-鿿　-〿＀-￯"
_FW_PUNCT = {",": "，", ":": "：", ";": "；"}
# 數字裡的 , 與 :(1,234.5、20:30)與網址的 :// 不動,其餘一律轉
_FW_SEP_RE = re.compile(r"(?<!\d),|,(?!\d)|(?<!\d):(?!//)|:(?!\d|//)|;")
_FW_PAREN_RE = re.compile(r"\(([^()\n]*)\)")
_HAS_CJK_RE = re.compile(f"[{_CJK}]")
# code spans and bare links keep their punctuation (a `:` or `,` inside a URL is part of it)
_CODE_SPAN_RE = re.compile(r"(`[^`\n]*`|https?://[^\s)）]+)")
_VERBATIM_CTX = ("休市表出處",)


def _fw(s):
    """Half-width , : ; ( ) that touch Chinese → full-width (references/reports.md §1b W4).
    Numbers (1,234.5), clock times (20:30), URLs and `code spans` are left alone. Deterministic
    and idempotent — a conversion, never a refusal."""
    if not isinstance(s, str) or not _HAS_CJK_RE.search(s):
        return s
    parts = _CODE_SPAN_RE.split(s)
    for i in range(0, len(parts), 2):
        p = re.sub(r"\s*([，：；])\s*", r"\1", _FW_SEP_RE.sub(lambda m: _FW_PUNCT[m.group(0)], parts[i]))
        p = _FW_PAREN_RE.sub(lambda m: f"（{m.group(1)}）" if _HAS_CJK_RE.search(m.group(0)) or
                             _HAS_CJK_RE.match(p[m.start() - 1:m.start()] or "x") else m.group(0), p)
        parts[i] = p
    return "".join(parts)


def _verbatim(text_):
    """Attribution lines a source's licence wants as written: never re-punctuated."""
    return text_ in _data.PUBLIC_SOURCE_EN or text_ in _data.PUBLIC_SOURCE_EN.values() or text_.startswith("資料來源")


def _fw_block(b):
    """W4 over one block's own words. News titles are the source's words and stay as they are;
    numbers, code and URLs are untouched."""
    if not isinstance(b, dict):
        return b
    t = b.get("type")
    out = dict(b)
    for k in ("title", "caption", "text", "markdown"):
        if isinstance(out.get(k), str) and t != "code":
            out[k] = _fw(out[k])
    if t == "kpi_row":
        out["items"] = [dict(i, label=_fw(i["label"]), **({"delta": _fw(i["delta"])} if "delta" in i else {}))
                        for i in out["items"]]
    elif t == "table":
        out["columns"] = [dict(c, label=_fw(c["label"])) for c in out["columns"]]
        out["rows"] = [{k: _fw(v) for k, v in r.items()} for r in out["rows"]]
    elif t == "footnote":
        out["items"] = [i if _verbatim(i["text"]) else dict(i, text=_fw(i["text"])) for i in out["items"]]
    elif t == "news":
        out["items"] = [dict(i, **({"summary": _fw(i["summary"])} if "summary" in i else {})) for i in out["items"]]
    elif t in ("line_chart", "bar_chart"):
        if "series" in out:
            out["series"] = [dict(x, name=_fw(x["name"])) for x in out["series"]]
        if "items" in out:
            out["items"] = [dict(x, label=_fw(x["label"])) for x in out["items"]]
    if "reflines" in out:
        out["reflines"] = [dict(r, label=_fw(r["label"])) for r in out["reflines"]]
    return out


# ─── R10:publish() 的自動檢查 ─────────────────────────────────────────────────

LEAD_FIRST_MAX = 40
LEAD_FIRST_NUMBERS = 2
MAX_BLOCKS = 16
# 同單位、同樣小數位數、相對差距落在 (0, 2%] = 抄錯。門檻用樣張校準:抓得到 +7.36% 對 +7.26%(1.4%);
# 小數位數不同的是進位(46,948.7 對 46,948.72),整數多半是門檻(「淨賣超逾 150 億」對 −150.6 億、
# 「回落到 70,000 口」對 −70,312 口),差距遠大於 2% 的是新算出來的比較——三種都放行。
NUMBER_NEAR = 0.02
_NUM_RE = re.compile(r"(?<![\w.])([+\-−]?)(\d[\d,]*(?:\.\d+)?)\s*(%|億|兆|萬張|口)?")
_MD_RE = re.compile(r"[*_`#>\[\]]|\^[\w-]+")


def _first_sentence(lead):
    plain = _MD_RE.sub("", lead).strip()
    return re.split(r"(?<=[。！？!?])", plain, maxsplit=1)[0].strip()


def _check_lead(lead):
    """R9 S1 / R10.1: the lead's first sentence stands on its own — it is the list summary,
    the notification and the share card's description."""
    first = _first_sentence(lead)
    nums = [m.group(0) for m in _NUM_RE.finditer(first)]
    words = _NUM_RE.sub("", first)
    words = re.sub(rf"[^{_CJK}A-Za-z]|[，。：；、（）！？「」—]", "", words)
    if len(first) > LEAD_FIRST_MAX:
        raise ValueError(f"narrative['lead'] first sentence is {len(first)} chars, cap {LEAD_FIRST_MAX} "
                         f"(over by {len(first) - LEAD_FIRST_MAX}): 「{first}」 — one conclusion up to the first 「。」, "
                         "the figures go in the second sentence (references/reports.md §1b R9 S1)")
    if len(nums) > LEAD_FIRST_NUMBERS:
        raise ValueError(f"narrative['lead'] first sentence carries {len(nums)} numbers ({', '.join(nums)}), "
                         f"at most {LEAD_FIRST_NUMBERS} (one comparison): move the rest after the first 「。」")
    if len(words) < 2:
        raise ValueError(f"narrative['lead'] first sentence is only figures: 「{first}」 — say what they mean")


# 門檻字眼後面的數字是觀察位置,本來就該靠近現值(「跌破 845.0 萬張」對現值 848.1 萬張),不是抄錯
# 「達／超過」不在表上:它們常是事實句(「買超達 211.9 億」),放行會讓抄錯漏網
_THRESHOLD_BEFORE_RE = re.compile(r"(跌破|站上|站回|逾|低於|高於|回落到|回落至|降到|升到|突破|大於|小於|不到)\s*[^\d\s]{0,6}\s*$")


def _numbers(text_, thresholds=True):
    """[(abs value, decimals shown, unit, as written)] for the figures R10 compares: the ones
    written with a decimal point — a copied figure keeps the pack's precision. With
    `thresholds=False` a figure right after a threshold word (跌破 / 逾 / 高於 …) is left out."""
    out = []
    text_ = text_ or ""
    for m in _NUM_RE.finditer(text_):
        sign, digits, unit = m.group(1), m.group(2), m.group(3) or ""
        if "." not in digits:
            continue
        if not thresholds and _THRESHOLD_BEFORE_RE.search(text_[max(0, m.start() - 12):m.start()]):
            continue
        try:
            v = float(digits.replace(",", ""))
        except ValueError:
            continue
        dec = len(digits.split(".")[1]) if "." in digits else 0
        out.append((v, dec, unit, m.group(0).strip()))
    return out


def _check_numbers(pack, narrative, watch_block):
    """R10.2: a figure that is almost — but not exactly, nor by rounding — one the pack
    printed is a mis-copy (ETH +7.36% against describe()'s +7.26%). A figure far from every
    pack figure is a new comparison and passes."""
    ctx = [(v, dec, unit, raw, label) for label, val in pack.context.items() if isinstance(val, str)
           for v, dec, unit, raw in _numbers(val)]
    texts = dict(narrative)
    if watch_block:
        # 只有「現在值」是抄自 describe() 的;「門檻」是 agent 設的觀察位置
        texts["watch"] = " ".join(r["now"] for r in watch_block["rows"])
    for key, body in texts.items():
        for v, dec, unit, raw in _numbers(body, thresholds=False):
            same = [c for c in ctx if c[2] == unit and c[1] == dec]
            if any(c[0] == v for c in same):
                continue
            near = [c for c in same if c[0] and 0 < abs(v - c[0]) / c[0] <= NUMBER_NEAR]
            if near:
                c = min(near, key=lambda c: abs(v - c[0]))
                raise ValueError(f"narrative[{key!r}] quotes {raw} but describe() has {c[3]} ({c[4]}), "
                                 f"{abs(v - c[0]) / c[0] * 100:.2f}% apart — a copying slip: quote the "
                                 "describe() figure, or write a comparison that is clearly a new number")


# ─── R5:新聞格 ────────────────────────────────────────────────────────────────

NEWS_SUMMARY_MAX = 40
NEWS_ITEM_FIELDS = ("title", "title_orig", "title_orig_lang", "summary", "tag", "sources", "published_at", "symbols",
                    "channel")
_LANG_TAG_RE = re.compile(r"(?=.{2,8}$)[a-z]{2,3}(-[A-Za-z0-9]{2,4})?")
NEWS_TAGS = ("pos", "neg", "neutral")
NEWS_MAX_AGE_DAYS = 7
NEWS_TITLE_SIMILAR = 0.85
# 建議語氣與操作字眼(R3):摘要只陳述事件,不評價、不指示
_NEWS_ADVICE_RE = re.compile(r"可望|值得布局|值得關注|建議(買|賣|進場|加碼|減碼)|(宜|應|可以?|趁\S{0,4})(進場|加碼|減碼|布局)"
                             r"|好時機|抄底|目標價|逢低|逢高")
_URL_BAD_RE = re.compile(r"[\x00-\x20\x7f]")
_CHART_TYPES = ("candlestick", "line_chart", "bar_chart", "table", "news", "heatmap", "histogram", "scatter", "box")


def _news_describe(news):
    c = news["candidates"]
    why = {"denied": "無 Blave 資料權限,鉅亨候選省略", "failed": "鉅亨新聞抓取失敗", None: "上一個收盤之後"}[news.get("state")]
    head = (f"  新聞候選 {len(c)} 則(鉅亨授權,{why}):"
            if news["market"] == "tw" else "  新聞候選:加密沒有授權新聞源,新聞格只能靠你上網蒐集(見 references/reports.md §1b News)")
    lines = [head]
    for it in c[:15]:
        t = datetime.fromtimestamp(it["published_at"], TPE).strftime("%m-%d %H:%M")
        lines.append(f"    - [{it['sources'][0]['name']} {t}] {it['title']}")
    return lines


def _check_url(url, where):
    from urllib.parse import urlsplit
    if not isinstance(url, str) or not 1 <= len(url) <= 500 or _URL_BAD_RE.search(url) or "\\" in url \
            or not url.isascii():
        raise ValueError(f"{where}: url must be 1–500 ASCII characters with no spaces or backslashes "
                         f"(an international domain in its xn-- form, a non-ASCII path percent-encoded first), got {url!r}")
    try:
        u = urlsplit(url)
        host = u.hostname
    except ValueError:
        host, u = None, None
    if u is None or u.scheme != "https" or not host or u.username is not None or u.password is not None:
        raise ValueError(f"{where}: url must be https://host/… with no user name or password, got {url!r}")
    return url


def _news_time(v, where):
    if isinstance(v, bool):
        raise ValueError(f"{where}: published_at must be unix seconds or 'YYYY-MM-DD HH:MM' (Taipei)")
    if isinstance(v, (int, float)):
        if not math.isfinite(v):
            raise ValueError(f"{where}: published_at must be a finite unix time, got {v!r}")
        ts = int(v)
    else:
        try:
            t = pd.Timestamp(str(v))
        except (ValueError, TypeError):
            raise ValueError(f"{where}: published_at must be unix seconds or 'YYYY-MM-DD HH:MM' (Taipei), got {v!r}")
        ts = int((t.tz_localize(TPE) if t.tzinfo is None else t).timestamp())
    now = _now_tpe().timestamp()
    if ts > now + 600:
        raise ValueError(f"{where}: published_at is in the future")
    if ts < now - NEWS_MAX_AGE_DAYS * 86400:
        raise ValueError(f"{where}: published_at is more than {NEWS_MAX_AGE_DAYS} days old — "
                         "a brief takes the news since the last close")
    return ts


def _norm_title(t):
    return re.sub(rf"[^{_CJK}A-Za-z0-9]", "", t).lower()


def _news_items(items, n):
    """narrative['news'] → contract items, or ValueError naming the item and the rule."""
    from difflib import SequenceMatcher
    if not isinstance(items, (list, tuple)):
        raise ValueError("narrative['news'] is a list of items {title, summary, tag, sources, published_at}")
    if not 1 <= len(items) <= n:
        raise ValueError(f"narrative['news'] has {len(items)} item(s), needs 1–{n}: pick the ones that name "
                         "this report's instruments first, then the wide-impact ones (references/reports.md §1b R5)")
    out, urls, titles = [], {}, []
    for i, it in enumerate(items):
        w = f"narrative['news'][{i}]"
        if not isinstance(it, dict):
            raise ValueError(f"{w} must be a dict")
        extra = sorted(set(it) - set(NEWS_ITEM_FIELDS))
        if extra:
            raise ValueError(f"{w} has unknown field(s) {extra}; fields: {', '.join(NEWS_ITEM_FIELDS)}")
        title = str(it.get("title") or "").strip()
        if not 1 <= len(title) <= 120:
            raise ValueError(f"{w}.title must be 1–120 characters (a foreign title: your translation here, "
                             "the original in title_orig)")
        item = {"title": title}
        if it.get("title_orig"):
            orig = str(it["title_orig"]).strip()
            if len(orig) > 120:
                raise ValueError(f"{w}.title_orig is {len(orig)} characters, cap 120")
            item["title_orig"] = orig
            lang_ = it.get("title_orig_lang")
            if not isinstance(lang_, str) or not _LANG_TAG_RE.fullmatch(lang_):
                raise ValueError(f"{w}.title_orig_lang must name the original's language as a short BCP-47 tag "
                                 f"(en, ja, ko, zh-Hans), got {lang_!r}")
            item["title_orig_lang"] = lang_
        elif it.get("title_orig_lang"):
            raise ValueError(f"{w}.title_orig_lang without title_orig: it labels the original title's language")
        summary = _fw(str(it.get("summary") or "").strip())
        if not summary:
            raise ValueError(f"{w}.summary is empty — one sentence in your own words, ≤{NEWS_SUMMARY_MAX}")
        if len(summary) > NEWS_SUMMARY_MAX:
            raise ValueError(f"{w}.summary is {len(summary)} chars, cap {NEWS_SUMMARY_MAX} "
                             f"(over by {len(summary) - NEWS_SUMMARY_MAX}) — one sentence")
        if re.search(r"[。！？!?]", summary.rstrip("。！？!? ")):
            raise ValueError(f"{w}.summary is more than one sentence: 「{summary}」")
        if _NEWS_ADVICE_RE.search(summary):
            raise ValueError(f"{w}.summary 「{summary}」 reads as advice ({_NEWS_ADVICE_RE.search(summary).group(0)}): "
                             "state what happened, never what to do (references/reports.md §1b R3)")
        item["summary"] = summary
        tag = it.get("tag")
        if tag not in NEWS_TAGS:
            raise ValueError(f"{w}.tag must be one of {', '.join(NEWS_TAGS)} — pos / neg = good or bad news for "
                             "the instrument it names; no single instrument named, or unsure → neutral")
        item["tag"] = tag
        channel = it.get("channel", "web")
        if channel not in ("web", "licensed"):
            raise ValueError(f"{w}.channel must be 'web' (you found it) or 'licensed' (a describe() candidate)")
        srcs = it.get("sources")
        if not isinstance(srcs, (list, tuple)) or not 1 <= len(srcs) <= 3:
            raise ValueError(f"{w}.sources must be 1–3 (名稱, https 連結) pairs")
        clean = []
        for j, sv in enumerate(srcs):
            name, url = (sv.get("name"), sv.get("url")) if isinstance(sv, dict) else (tuple(sv) + (None,))[:2]
            name = str(name or "").strip()
            if not 1 <= len(name) <= 40:
                raise ValueError(f"{w}.sources[{j}] name must be 1–40 characters")
            s = {"name": name}
            if url:
                s["url"] = _check_url(url, f"{w}.sources[{j}]")
                if s["url"] in urls:
                    raise ValueError(f"{w} repeats {s['url']} (already item {urls[s['url']]}): one event, one item — "
                                     "merge the reports into one item's sources")
                urls[s["url"]] = i
            clean.append(s)
        if channel == "web" and not any("url" in s for s in clean):
            raise ValueError(f"{w} has no https link: an item you found on the web carries the link to the "
                             "article it summarises (a licensed describe() candidate is channel='licensed')")
        item["sources"] = clean
        item["channel"] = channel
        item["published_at"] = _news_time(it.get("published_at"), w)
        if it.get("symbols"):
            if not isinstance(it["symbols"], (list, tuple)):
                raise ValueError(f"{w}.symbols must be a list, e.g. ['2330']")
            syms = [str(x).strip() for x in it["symbols"]]
            if len(syms) > 5 or any(not 1 <= len(x) <= 16 for x in syms):
                raise ValueError(f"{w}.symbols: at most 5, each 1–16 characters")
            item["symbols"] = syms
        nt = _norm_title(title)
        for k, other in enumerate(titles):
            if nt and other and (nt in other or other in nt or SequenceMatcher(None, nt, other).ratio() >= NEWS_TITLE_SIMILAR):
                raise ValueError(f"{w} looks like item {k} again (「{title}」): one event, one item — "
                                 "put both outlets in that item's sources")
        titles.append(nt)
        out.append(item)
    return out


def _news_title(items):
    names = list(dict.fromkeys(s["name"] for it in items for s in it["sources"]))
    if len(names) >= 3:
        return f"綜合 {len(names)} 家"
    return "、".join(names)


def _news_block(pack, news_in, given, narrated):
    """(news block or None, footnote item or None) for this publish."""
    if pack.news is None:
        if given:
            raise ValueError("this pack has no news slot: add the `news` brick to the recipe, or leave 'news' out")
        return None, None
    n = pack.news["n"]
    if given and news_in:
        items = _news_items(news_in, n)
        at = _now_tpe().strftime("%H:%M")
        return ({"type": "news", "title": _news_title(items), "items": items,
                 "caption": "上一個收盤之後;點名本報告標的的優先,其次是影響面大的"},
                ("news", f"新聞為 agent 於 {at} 蒐集整理；標籤依事件性質分類，不是股價預測。"))
    cands = pack.news["candidates"] if not given else []
    if cands:
        items = sorted(cands, key=lambda x: -x["published_at"])[:n]
        return ({"type": "news", "title": _news_title(items), "items": items,
                 "caption": "上一個收盤之後的授權新聞標題,依發布時間排列"},
                ("news", "新聞為鉅亨網授權標題，依發布時間排列，未經整理、不帶判讀。"))
    if narrated:
        return None, ("news", "這份沒有附新聞：這次沒有可用的新聞來源。")
    return None, None


def _lead_chart_first(pairs, name):
    """R9 N2: the chart the lead argues from goes right after the KPI row."""
    idx = next((i for i, (o, b) in enumerate(pairs) if o == name and b.get("type") in _CHART_TYPES), None)
    if idx is None:
        have = list(dict.fromkeys(o for o, b in pairs if b.get("type") in _CHART_TYPES and o != "?"))
        raise ValueError(f"lead_chart={name!r} lays out no chart in this pack; one of: {', '.join(have)}")
    pair = pairs.pop(idx)
    k = next((i for i, (_, b) in enumerate(pairs) if b.get("type") == "kpi_row"), -1)
    pairs.insert(k + 1, pair)
    return pairs
