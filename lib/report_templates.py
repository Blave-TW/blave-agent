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

publish() never overwrites a report: an id that is taken gets the next free one (`-2`, `-3`, …)
and the path it returns names the file written. To correct the report you published earlier in
the same turn, publish again with `replace=True`.

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

import json
import math
import os
import re
from datetime import datetime, timedelta, timezone

import pandas as pd

from lib import data as _data
from lib import report as _report
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
    "summary": ("## 總結", 200),
    # 推翻條件接在總結最後一句(Wei:收尾要有總結,不再單獨一個風險框);標題只剩給 describe 用
    "risk": ("推翻這份解讀的訊號", 100),
}
# `watch` 的表格形狀。key 必須是 ASCII(契約 §3),欄位一律 text format——現在值帶 + 號
# 會被上色規則讀成獲利。
WATCH_COLUMNS = (("cond", "條件", "left"), ("threshold", "門檻", "left"), ("now", "現在值", "right"))
WATCH_ROWS = (2, 3)
WATCH_CELL = 40
READ_ITEMS = (3, 5)
WATCH_CAPTION = "條件與門檻是這份判讀設的觀察位置；現在值取自本報告數據區的當日數值。"
# 研究報告(type research)的槽位:§7b B3/B4 兩段必寫、B5 是 risk 那格(換標題),B2 不讀當下所以沒有 watch
RESEARCH_SLOTS = {
    "lead": ("", 600),
    "read": ("## 發現", 300),
    "against": ("## 哪些數據不支持這個結論", 400),
    "robustness": ("## 換個做法結論還站得住嗎", 400),
    "summary": ("## 總結", 200),
    "risk": ("什麼會推翻這個結論", 150),
}
_SLOT_FORM = {
    "against": "B3:列出不支持結論的數字,各帶數字與它削弱多少;找不到就寫你查了什麼",
    "robustness": "B4:至少一個檢查(換窗口／換基準／前後半段／換定義),沒過就照實寫並把 lead 與標題改弱",
    "lead": "一個可證偽的主張",
    "read": "3–5 條,每條一個數字加它的基準;或 3–5 個 ### 子標",
    "summary": "1–3 句:把判讀收成「所以呢」,接下來看觀察重點裡最重要的那一項;不重述 lead",
    "risk": "一句,總結的最後一段(publish 加「推翻條件：」):否定結論裡那個判斷的訊號出現,這個判斷就不成立",
}
SUMMARY_LEAD_OVERLAP = 0.5
TITLE_MAX = 40
RESEARCH_TITLE_MAX = 24   # references/reports.md 7b A1: a shared link's preview card shows two lines


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
        self.context = {_fw(k): (v if k in _VERBATIM_CTX or not isinstance(v, str) else _fw(v)) for k, v in context.items()}
        # which brick laid out each block (kpi_row / footnote for the assembler's own) — lead_chart reads it
        self.owners = list(owners) if owners else ["?"] * len(self.blocks)
        # {"market", "n", "candidates", "at"}: the agent-filled news slot and where its block goes
        self.news = news
        self.notes = [_fw(n) for n in notes or []]   # what is missing and why
        self.meta = meta or {}
        self.skip = _fw(skip) if skip else skip   # reason this pack must not be published, or None
        # Blave-only series skipped for lack of data access: [{"name", "reason"}], reason
        # "signed_out" / "no_data_access". publish() names them in the footnote.
        self.missing = missing or []
        self.slots = dict(RESEARCH_SLOTS if type_ == "research" else SLOTS)
        # 每份對話產出的報告都可以帶新聞(Wei 拍板);沒有 news 積木的配方,新聞排在數據區塊之後,
        # 排程版照舊不出新聞(沒有積木就沒有授權候選)
        self.slots["news"] = ("新聞", None)
        self.timings = []                 # [(brick, seconds)] of the build that made it
        self.extra_owners = []            # bricks added for today's event (build(extra=…))
        self.built_at = 0.0
        self.report_day = None            # the day the report is about (YYYY-MM-DD); publish labels it when not today
        self.mode = "morning"
        self.subject = None               # a single-instrument pack's symbol (symbol brief, research)
        self.bricks = []                  # [[name, params]] run, extras included — which extra is already there
        self.closed = None                # {"asked", "label", "used"}: asked for a non-trading day, built on the last trading day

    _JSON_FIELDS = ("report_id", "title", "type", "report_type", "blocks", "context", "notes", "meta", "skip",
                    "missing", "owners", "news", "timings", "extra_owners", "built_at", "report_day", "mode",
                    "subject", "bricks", "closed")

    def to_json(self):
        return {k: getattr(self, k) for k in self._JSON_FIELDS}

    @classmethod
    def from_json(cls, d):
        p = cls(d["report_id"], d["title"], d["type"], d["report_type"], d["blocks"], d["context"],
                d.get("notes"), meta=d.get("meta"), skip=d.get("skip"), missing=d.get("missing"),
                owners=d.get("owners"), news=d.get("news"))
        p.timings = [tuple(t) for t in d.get("timings") or []]
        p.extra_owners = list(d.get("extra_owners") or [])
        p.built_at = float(d.get("built_at") or 0)
        p.report_day, p.mode, p.subject = d.get("report_day"), d.get("mode") or "morning", d.get("subject")
        p.bricks = list(d.get("bricks") or [])
        p.closed = d.get("closed")
        return p

    def describe(self):
        lines = [f"[{self.report_id}] {self.title}"]
        if self.closed:
            used = self.closed["used"]
            md = f"{int(used[5:7])}/{int(used[8:10])}"
            lines.append(f"  {self.closed['asked']} 休市({self.closed['label']}),這份用最近交易日 {used} 的資料,直接照這份做:"
                         f"lead 或回覆的第一句說「今天休市,用 {md} 的資料」")
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
                 else f"news=≤{(self.news or {}).get('n', NEWS_MAX_ITEMS)} 則" + "{title, summary≤40, tag, sources[(名稱, https 連結)], published_at}"
                 if k == "news" else f"{k}≤{cap}" + (f"({_SLOT_FORM[k]})" if k in _SLOT_FORM else "")
                 for k, (_, cap) in self.slots.items()]
        lines.append("  narrative slots: " + ", ".join(slots))
        charts = list(dict.fromkeys(o for o, b in zip(self.owners, self.blocks)
                                    if b.get("type") in _CHART_TYPES and o != "?"))
        if len(charts) > 1:
            lines.append("  lead_chart(選填,論點圖排第一): " + " / ".join(charts))
        if self.extra_owners:
            lines.append("  今天加做的積木(至少一塊要跟 lead 講的事直接相關): " + " / ".join(self.extra_owners))
        if self.subject and not str(self.subject).isdigit() and not any(n == "liq_map" for n, _ in self.bricks):
            lines.append(f"  可加做:[[\"liq_map\", {{\"symbol\": \"{self.subject}\"}}]] 爆倉地圖"
                         "(近 24 小時已發生強平的價位分布+模型估計層;講槓桿、爆倉、清算時加)")
        if not self.skip:
            lines += [f"  {x}" for x in _publish_checklist(self)]
        return "\n".join(lines)


def _publish_checklist(pack):
    """Everything publish() checks, most-often-broken first, plus the exact narrative shape — so the
    agent writes it once from describe() alone, without reading references or lib source (09-26
    transcripts: read as a list, watch as a markdown table, read over 300, lead over 40, figures
    re-typed from a rebuilt pack, a news tag outside pos/neg/neutral, lib source read for the
    news item fields)."""
    rid = pack.report_id
    n = (pack.news or {}).get("n", NEWS_MAX_ITEMS)
    research = pack.type == "research"
    title_max = RESEARCH_TITLE_MAX if research else TITLE_MAX
    lines = ["publish 檢查表(一次寫對;publish 一次列出全部不合格處):",
             f"  1. read ≤{pack.slots['read'][1]} 字,3–5 條 '- ' 條列(可直接給 list of str),或 3–5 個 ### 子標,不混用"]
    if research:
        lines += [f"  2. against ≤{RESEARCH_SLOTS['against'][1]} 字(B3 必寫)、robustness ≤{RESEARCH_SLOTS['robustness'][1]} 字"
                  f"(B4 必寫,至少一個檢查)、risk ≤{RESEARCH_SLOTS['risk'][1]} 字(B5:什麼會推翻這個結論,接在總結最後);沒有 watch",
                  "     研究只講歷史發現:不給買賣時點、目標價、價位,不說「現在正在發生」(B1/B2)"]
    else:
        lines.append(f"  2. watch = {WATCH_ROWS[0]}–{WATCH_ROWS[1]} 個 tuple (條件, 門檻, 現在值),每格 ≤{WATCH_CELL} 字;不是 markdown 表")
    _, day_cell = _dated_title(pack, "")
    day_note = (f"資料日 {day_cell['value']} 不是今天:publish 會在標題前加「{_dated_title(pack, '')[0].rstrip('｜')}｜」、頁首標資料日,"
                "標題裡不用再寫日期" if day_cell else "")
    lines += [
        f"  3. lead 第一句(到第一個「。」)≤{LEAD_FIRST_MAX} 字、≤{LEAD_FIRST_NUMBERS} 個數字、是結論;其餘數字放第二句"
        + (";研究:第一句寫出結論本身＋1 個數字＋它的基準,不寫懸念句;整段 ≤3 句、≤3 個數字" if research else ""),
        "  4. 數字照上面 describe() 原樣抄(小數位數一樣);新算的比較請寫成明顯不同的數;"
        "資料算得出來的數字一律自己算(例如 ETH 同期漲幅:extra 加 relative_to 的 ETH,或 relative_perf),不引用媒體報的數字;"
        "不寫積木名、函式名、「資料包」這類工程字;"
        "時間窗照用戶問的(問「這週」就是 7 日,describe 只有 24h 就從序列自己算 7 日,不拿 24h 頂替)",
        f"  5. news ≤{n} 則,來自至少 {NEWS_MIN_SITES} 個不同網站;每則填 symbols(它點名的代號,如 [\"XRP\"]、[\"2330\"]);"
        f"tag 只能 pos / neg / neutral;summary 一句 ≤{NEWS_SUMMARY_MAX} 字、自己的話、不給建議;"
        f"published_at 在 {NEWS_MAX_AGE_DAYS} 天內;web 來的每則至少一個 https 連結,"
        "同一個連結只能出現在一則(兩則不同的事都只有同一個列表頁當來源 → 只留一則,或各用文章自己的連結)",
        "  6. 今天的特殊事件要有自己的積木:新聞點名的標的(正面/負面)、lead／read／summary 講到的個股或幣,"
        "build 時加做 extra=[…](台股個股 [\"tw_institutional\", {\"symbol\": \"2409\"}] 或 price_chart;"
        "這份報告自己的幣 relative_to;其他幣 coin_snapshot);narrative['no_extra'] 只在積木建不出來(沒資料)時用。"
        "來源不到 3 家就在 narrative['few_sources'] 說明",
        f"  7. summary 必填,1–3 句 ≤{pack.slots['summary'][1]} 字:把判讀收成「所以呢」,用跟 lead 不同的話;"
        "「接下來看什麼」只點名觀察重點表裡最重要的那一項,不重列整張表。"
        "risk 一句,publish 放在總結最後一段、前面加「推翻條件：」(你不用寫這幾個字,read 裡也不要再寫一次);"
        "它要打結論裡的那個判斷,不是反向的行情:結論「觀望性拉回、未見恐慌」→ 推翻它的是恐慌訊號"
        "(融資大減、期貨空單大增、外資連續大賣),不是「外資轉買、空單縮小」(那是反彈);"
        "結論「外資轉賣」→ 推翻它的是外資轉回買超,不是「賣更多」(那是確認);"
        "結論裡有「未見恐慌」「尚未轉弱」這類否定判斷時,推翻條件就是那件事真的發生(恐慌、轉弱),不是反方向變好;不給買賣價位,價位只當統計值寫(均線、前 20 日高低不寫成地板或天花板,publish 會擋)",
        f"  8. title=\"<結論 ≤{title_max} 字>\" 必填:寫今天的結論,不是範本名「{pack.title}」" + (f";{day_note}" if day_note else ""),
        "  9. 比較多個標的:一張多序列圖(relative_perf,或正規化到同一基準)加一張比較表,不是每個標的各一張圖",
        "  10. 圖型由積木決定,不自選:每期發生量(爆倉金額、買賣超、成交量)→ bar_chart、"
        "水位與指標(OI、融資、資金費率、z-score)→ line_chart、價格 → K 線;自組序列(自訂報告)也照這張表",
        "  11. 中文標點用全形(夾在中文之間的 , : ; ( ) 會自動轉)",
        f"  12. 引用網頁上的圖(用戶要求時必放,最多 {_report.CITED_IMAGES_MAX} 張):browser_capture(tab, ref, report={rid!r}) 回傳的 file 與 source "
        "原樣放進 narrative[\"images\"] = [{\"file\": …, \"source\": {…}, \"alt\": \"這張圖畫的是什麼\"}];不算進 16 塊,不要改 pack.blocks;"
        "擷取了卻不放 → narrative[\"images_unused\"] 一句說明(檔案會刪),並在回覆講那張圖沒有放進報告",
        "  13. 前後比較用同一個基準:寫「從 A 到 B」「擴大／收斂 N 個百分點」的兩個值,基準與算法要一樣——分母、匯率、對照價"
        "都取同一天;有一個換了日期就不是同一個指標的變化,不寫成「從 A 到 B」。"
        "自己換算的衍生數字(上面 describe() 沒有的):在表或圖說寫明公式與每個輸入的日期;拿不到同基準的輸入,那一格寫「—」,不硬算;"
        "用戶說「不要估」時,衍生數字不進標題與 lead。百分位與排名不互換(「第 2 百分位」不是「第 2 低」)",
        "  讀網頁:有內建瀏覽器(電腦版)時 browser_read 只用 part=\"meta\" / \"outline\" / \"section\",不用 \"full\"(每頁約 3,000 字);"
        "沒有瀏覽器(雲端、排程)用 WebSearch 找、WebFetch 讀,prompt 只要標題、發布時間與一句重點",
        "  開頁:browser_open_many 只開打算讀的頁,開了的每一頁都要讀,不讀的不要開;新聞與數字先讀媒體或官方原文,"
        "論壇貼文、轉述、聚合頁只在找不到原文時用,來源名後面加「（轉述）」",
        "narrative 範例(照這個形狀填,不用去讀 references 或 lib 原始碼):",
        "  {\"lead\": \"一句結論。第二句放數字。\", \"read\": [\"**結論**:數字與基準\", …],"
        + (" \"against\": \"- …\", \"robustness\": \"- …\"," if research else " \"watch\": [(\"條件\", \"門檻\", \"現在值\"), …],"),
        "   \"summary\": \"<這些數字合起來代表什麼,直接寫結論,不加「所以呢」這類標籤>。接下來看<觀察重點最重要的一項>。\","
        " \"risk\": \"若出現否定結論那個判斷的訊號(寫出門檻),這個判斷就不成立。\",",
        "   \"news\": [{\"title\": \"標題\", \"summary\": \"一句\", \"tag\": \"neg\", \"symbols\": [\"ETH\"],"
        " \"sources\": [(\"來源名\", \"https://…\")], \"published_at\": \"YYYY-MM-DD HH:MM\"}]}",
        f"  publish({rid!r}, narrative, title=\"<結論 ≤{title_max} 字>\"" + (", shareable=True)" if research else ")"),
        f"  被拒:只改 narrative,publish({rid!r}, narrative, title=…) 重送同一個 pack;不要再呼叫範本重建"
        f"(資料會變、又多花 {int(sum(t for _, t in pack.timings)) or '數十'} 秒)",
        "  已經發出去才發現要改:同一輪內再 publish 一次並加 replace=True(只會換掉這一輪自己發的那份);"
        "不加就是多一份新報告——舊報告一律不會被蓋掉,id 已有報告時新的一份自動排下一個號,回覆不用提編號",
    ]
    return lines


def load_pack(report_id):
    """The pack a template built for `report_id` in the last PACK_TTL_S (build keeps it under
    state/report_packs/). Raises ValueError when there is none — build it again then."""
    from lib import report_bricks as RB
    path = os.path.join(RB._packs_dir(), f"{report_id}.json")
    try:
        with open(path, encoding="utf-8") as f:
            doc = json.load(f)
    except (OSError, ValueError):
        raise ValueError(f"no kept pack for {report_id!r}: call the template (or build) once, then publish") from None
    import time as _time
    turn = RB.current_turn()
    if turn and doc.get("turn") != turn:
        raise ValueError(f"the kept pack for {report_id!r} was built in an earlier turn: build it again "
                         "(the market has moved since), then publish")
    if _time.time() - float(doc.get("built_at", 0)) > RB.PACK_TTL_S:
        raise ValueError(f"the kept pack for {report_id!r} is older than {RB.PACK_TTL_S // 60} minutes: build it again")
    return Pack.from_json(doc)


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


# 範本的日 K 畫最後 90 根(60 日均涵蓋段 + 一個月對照),研究報告 120 根(契約上限)。桌機與 PDF 到 120 根
# 都是完整 K 棒;手機寬超過約 72 根渲染器降階成高低線——接受,不在產出端截短。
_PRICE_BARS = 90
_RESEARCH_BARS = 120


def _bars_window_days(bars, trading_week=5):
    """Calendar days to fetch so `bars` daily bars come back: a crypto day is a bar
    (`trading_week=7`); a Taiwan session week is 5 days plus room for a long holiday."""
    return bars + 2 if trading_week == 7 else bars * 7 // 5 + 14


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


def bar_profile(title, buckets, est=None, refline=None, x_unit=None, y_unit=None, caption=None):
    """bar_chart variant "profile" (contract 1.5): both sides of a quantity over a CONTINUOUS
    numeric x-axis (a price profile). buckets: [(x0, x1, pos, neg)] — pos / neg ≥ 0, the two
    sides of one bucket kept apart, NEVER netted (a `value` row is the old netted shape and is
    refused); a zero side is left off the item. est: [(x0, x1, value)], value ≥ 0 — the model
    layer, per-bucket values (the web accumulates them into a cumsum dashed line from
    refline.x, so est needs refline). refline: (x, formatted label)."""
    def edge_ok(out, x0, x1):
        return _finite(x0) and _finite(x1) and float(x0) < float(x1) and (not out or float(x0) >= out[-1]["x1"])
    bk = []
    for row in buckets or ():
        if isinstance(row, dict):
            if "value" in row:
                raise ValueError("profile buckets carry pos and neg (both sides, never netted), not value "
                                 "(contract 1.5) — pos = 上漲觸發的量(綠), neg = 下跌觸發的量(紅)")
            x0, x1, pos, neg = row.get("x0"), row.get("x1"), row.get("pos", 0.0), row.get("neg", 0.0)
        else:
            if len(row) != 4:
                raise ValueError("profile buckets are (x0, x1, pos, neg) — a (x0, x1, value) row is the old "
                                 "netted shape, refused (contract 1.5 keeps both sides)")
            x0, x1, pos, neg = row
        if not (edge_ok(bk, x0, x1) and _finite(pos) and _finite(neg) and float(pos) >= 0 and float(neg) >= 0):
            continue
        cell = {"x0": float(x0), "x1": float(x1)}
        if float(pos) > 0:
            cell["pos"] = float(pos)
        if float(neg) > 0:
            cell["neg"] = float(neg)
        bk.append(cell)
    if len(bk) < 2:
        return None
    bk = bk[:200]
    b = {"type": "bar_chart", "variant": "profile", "title": title[:80], "buckets": bk}
    if est is not None and refline is not None:
        ev = []
        for x0, x1, v in est:
            if edge_ok(ev, x0, x1) and _finite(v) and float(v) >= 0:
                ev.append({"x0": float(x0), "x1": float(x1), "value": float(v)})
        if len(ev) >= 2:
            b["est"] = ev[:200]
    if refline is not None:
        x, lab = refline
        if _finite(x):
            b["refline"] = {"x": float(x), "label": str(lab)[:32]}
    if "est" in b and "refline" not in b:
        del b["est"]                     # 契約:est 必須跟 refline 一起(累加方向由 refline 定義)
    if x_unit:
        b["x_unit"] = x_unit[:8]
    if y_unit:
        b["y_unit"] = y_unit[:8]
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


def text(markdown, lead=False, variant=None):
    b = {"type": "text", "markdown": markdown[:20000]}
    if lead or variant:
        b["variant"] = "lead" if lead else variant
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

def _window(hours):
    """A rolling window in words: 24 → 「24 小時」, 168 → 「7 日」(readers do not parse 168h)."""
    hours = int(hours)
    return f"{hours // 24} 日" if hours > 24 and hours % 24 == 0 else f"{hours} 小時"


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
    return "；".join([basis] + [c for c in clauses if c])


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


# 指數日 K 固定抓 140 個日曆日(90 根 K 棒 + 春節長假的餘裕;免費路徑一個月一次請求);lookback_days 只管
# 成交值、法人、融資、期貨法人——免費路徑上法人與融資一天一次請求,冷啟動成本跟著它走。
_TW_INDEX_DAYS = _bars_window_days(_PRICE_BARS)


def _tw_index_start(date, start, bars=_PRICE_BARS):
    days = max(_TW_INDEX_DAYS, _bars_window_days(bars))
    return min(start, (datetime.strptime(date, "%Y-%m-%d") - timedelta(days=days)).strftime("%Y-%m-%d"))


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
    # 晨報 v2(spec 2026-09-26 §2.2):沿用 id tw-market-YYYYMMDD。K 線與收盤報告同為 90 根;融資只留 KPI,
    # 圖留在收盤報告。
    "tw_market_brief": {
        "id": "tw-market", "title": "台股大盤晨報", "lookback_days": 45,
        "kpi": _TW_KPI + ["txf_night"],
        "bricks": [["price_chart", {"symbol": "TAIEX"}], ["tw_turnover", {}],
                   ["tw_institutional", {}], ["tw_margin", {"chart": False}], ["movers", {"market": "tw", "n": 10}],
                   ["tw_futures_inst", {}], ["txf_night", {}], ["tw_announcements", {"n": 3}],
                   ["news", {"market": "tw", "n": 5}],
                   ["event_calendar", {"countries": ["US", "CN", "TW", "JP", "EU"], "dividends": True}]],
    },
    "tw_close_brief": {
        "id": "tw-close", "title": "台股收盤報告", "lookback_days": 45, "mode": "close",
        "kpi": _TW_KPI,
        "bricks": [["price_chart", {"symbol": "TAIEX"}]] + _TW_FLOW + [
            ["event_calendar", {"countries": ["US", "CN", "TW", "JP", "EU"], "today_only": True}]],
    },
    # 恐懼貪婪的條款確認前,KPI 第六格放交易員曝險(spec §2.2)。lookback_days 是報價表「30 日報酬」欄的 N,
    # 指標折線的 90 日由積木自己的 days 決定。
    "crypto_market_brief": {
        "id": "crypto-market", "title": "加密市場晨報", "lookback_days": 30,
        "kpi": ["quote_table", "liquidation", "funding", "blave_indicators"],
        "bricks": [["quote_table", {"top_mcap": 5}], ["funding", {"symbol": "BTC", "chart": False}],
                   ["derivs_table", {}], ["liquidation", {"hours": 24}], ["movers", {"market": "crypto", "n": 5}],
                   ["blave_indicators", {"names": ["市場方向", "資金稀缺", "頂尖交易員曝險"],
                                         "kpi": ["市場方向", "頂尖交易員曝險"], "raw_chart": False, "days": 90}],
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


def build(recipe, date=None, headers=None, extra=None, fresh=False):
    """Run a recipe → `Pack` (see lib/report_bricks.py). `extra`: ≤3 bricks for today's event;
    a second identical call within 10 minutes returns the kept pack unless `fresh=True`."""
    from lib import report_bricks
    return report_bricks.build(recipe, date, headers, extra=extra, fresh=fresh)


def quickstart():
    """What a report in the user's own words (a custom recipe) or a research report needs before the
    first line of code, printed — so nothing is read or grepped first. Measured 09-28: one research
    turn spent its first three minutes and 15 calls in references/reports.md and lib source.
    The brick list and the signatures are taken from the code, so they cannot drift. Returns the text."""
    import inspect
    from lib import report_bricks
    sig = lambda f, drop=(): "(" + ", ".join(str(p) for n, p in inspect.signature(f).parameters.items() if n not in drop) + ")"
    first = lambda f: " ".join((f.__doc__ or "").strip().split("\n")[0].split())[:110]
    lines = [
        "[report] QUICK START for a report in the user's own words, or a research report.",
        "  Read this and start. Not first: references/reports.md, lib source, a grep for a signature (they are below).",
        "  Open a section of references/reports.md only when publish() refuses something its message does not explain.",
        "  An earlier chat answer made into a report: rerun its script from `ls -t tmp/research/` and build on that",
        "  output - never redo the research. An x-axis of 'day N after the event' is a bar_chart / table, never fake dates.",
        "ORDER (fixed)",
        "  1. Search the web (browser_search, then browser_open_many and browser_read part=meta / section; read every page",
        "     you opened). Blave data may be fetched in the same step while pages load.",
        "  2. Build the data pack once:",
        f"       one coin or Taiwan stock : pack = research_pack{sig(research_pack)}",
        f"       anything else            : pack = build(check_recipe(recipe), extra=[...])   build{sig(build)}",
        "  3. print(pack.describe())  -> every figure you may cite, the narrative slots with their limits, the publish checklist",
        f"  4. publish{sig(publish)}",
        "     research needs shareable=True or False. Refused -> fix what it lists, publish('<report id>', narrative, ...); never rebuild.",
        "RECIPE",
        '  {"id": "btc-derivs", "title": "BTC 衍生品", "lookback_days": 90, "kpi": ["price_chart", "liquidation"],',
        '   "bricks": [["price_chart", {"symbol": "BTC"}], ["derivs_table", {"symbols": ["BTC", "ETH"], "window": "7d"}]]}',
        f"  keys: {', '.join(_RECIPE_KEYS)}; id [a-z0-9-] up to 40, not starting with {' / '.join(_BUILTIN_PREFIXES)};",
        f"  at most {RECIPE_MAX_BRICKS} bricks that lay out a block; kpi names bricks of the recipe, the first is the focus;",
        "  extra = up to 3 more bricks for what today's news is about, same [name, {params}] form.",
        f"  research_pack topics: {', '.join(RESEARCH_TOPICS)}",
        "BRICKS  name(arguments) : what it lays out",
    ]
    lines += [f"  {name}{sig(fn, ('b',))} : {first(fn)}" for name, fn in report_bricks.BRICKS.items()]
    lines += [
        "A FIGURE NO BRICK SHOWS",
        "  Look once in references/lib.md (the fetchers and their signatures), not in lib source. What is not there comes",
        "  from the pages you read - the outlet's own article or the official page - cited, and the report says it is from the web.",
        "A FIGURE YOU WORK OUT YOURSELF, AND BEFORE / AFTER",
        "  'From A to B' needs both values on one basis and one formula: the denominator, the FX rate and the reference",
        "  price each of the SAME date on both sides. One input changed date -> not the same measure; never 'from A to B'.",
        "  State the formula and the date of every input in the table or the caption. No input on the same basis -> the",
        "  cell says —, do not compute it anyway. The user said not to estimate -> no derived figure in the title or the lead.",
        "  A percentile is not a rank: '2nd percentile' is never 'second lowest'.",
        "RUN IT",
        "  python3 -c '...' from the workspace root, or a tmp/ script run as python3 -m tmp.x (python3 tmp/x.py cannot import lib).",
    ]
    text = "\n".join(lines)
    try:   # Windows run.log is cp950: a line that cannot be encoded must not turn into an exception
        print(text)
    except UnicodeEncodeError:
        print(text.encode("ascii", "replace").decode("ascii"))
    return text


# ─── 自組配方:report_jobs/<id>/recipe.json ─────────────────────────────────────

_BUILTIN_PREFIXES = ("tw-market", "tw-close", "crypto-market", "symbol-", "research-")
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
        # report_id / type / report_type stay the built-ins' own: a custom id filed among tw-market-*, or a
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
                         "its reports would be filed as that template's")
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
    elif key == "window":
        one_of("24h", "7d")
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
    elif key == "exchange":
        if not (isinstance(v, str) and re.fullmatch(r"[A-Za-z]{2,12}", v)):
            raise ValueError(f"{where} must be an exchange name like okx or bybit, got {v!r}")
    elif key == "benchmark":
        if not sym(v):
            raise ValueError(f"{where} must be a symbol like BTC, got {v!r}")
    elif key == "days":
        whole(5, 365)
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


def tw_market_brief(date=None, headers=None, lookback_days=45, extra=None, fresh=False):
    """台股大盤晨報 data pack for the morning of `date` (Taipei; default today).
    Reads the last trading day's close, turnover, 三大法人, 融資, 外資期貨淨多單, the TXF night
    session, the 10 largest 成交值 and the day's 重大訊息 (desktop: TWSE open data), a news
    slot (鉅亨 headlines as candidates; yours to fill in chat) and today's macro events and
    除權息. `lookback_days` covers the flow series (20-day means, futures chart); the index
    chart always draws its last 90 sessions, whatever `lookback_days` is."""
    return build(_recipe("tw_market_brief", lookback_days=lookback_days), date, headers, extra, fresh)


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


def tw_close_brief(date=None, headers=None, lookback_days=45, extra=None, fresh=False):
    """台股收盤報告 data pack for trading day `date` (Taipei; default today): the day's
    TAIEX close, turnover, 三大法人, 融資 and 外資期貨淨多單. The night session is not part
    of it. A series that has not published `date` yet is left out and named in
    `pack.notes` — never shown with the previous day's value.

    `pack.skip` is set (and `publish` writes nothing) when `date` is not a trading day per
    `lib.data.is_tw_trading_day`, or when the index has no close for `date` yet (not landed,
    or an ad-hoc closure the holiday table does not list); the reason names the last
    trading day. No sector breakdown: lib has no per-industry daily series, and building
    one means a close fetch for every listed stock."""
    return build(_recipe("tw_close_brief", lookback_days=lookback_days), date, headers, extra, fresh)


def crypto_market_brief(date=None, headers=None, symbols=("BTC", "ETH", "SOL"), lookback_days=30, extra=None, fresh=False):
    """加密市場晨報 data pack: price and 1 / 7 / 30-day returns of `symbols` plus the five
    largest coins by market cap, the derivatives table (OI 24h, funding, long/short), 24h
    liquidations, the day's movers, the market-wide Blave indicators, a news slot (yours to
    fill in chat; a scheduled run has no licensed crypto source and lays out none) and
    today's macro events. `lookback_days` is the N of the N-day return column; the indicator
    chart spans 90 days regardless."""
    return build(_with_symbols(_recipe("crypto_market_brief", lookback_days=lookback_days), symbols), date, headers,
                 extra, fresh)


def symbol_brief(symbol, date=None, headers=None, lookback_days=90, extra=None, fresh=False):
    """單標的晨報 data pack. A 4–6 digit id is a Taiwan stock (日 K + 外資買賣超);
    anything else is a crypto USDT perp (日 K + 資金費率 + 爆倉 / 巨鯨 / 多空力道). The daily
    chart draws 90 bars; `lookback_days` is the window of the funding and indicator lines."""
    sym = str(symbol).strip().upper()
    if sym.isdigit():
        recipe = {"id": f"symbol-{sym}", "subject": sym, "title": f"{sym} 晨報", "report_type": "單標的晨報",
                  "lookback_days": lookback_days, "kpi": ["price_chart", "tw_institutional"],
                  "bricks": [["price_chart", {"symbol": sym}], ["tw_institutional", {"symbol": sym}],
                             ["levels_table", {}]]}
    else:
        label = _data.normalize_symbol(sym if sym.endswith("USDT") else sym + "USDT").replace("USDT", "")
        recipe = {"id": f"symbol-{label.lower()}", "subject": label, "title": f"{label} 晨報", "report_type": "單標的晨報",
                  "lookback_days": lookback_days, "kpi": ["price_chart", "funding", "blave_indicators"],
                  "bricks": [["price_chart", {"symbol": label}], ["funding", {"symbol": label, "variant": "symbol"}],
                             ["blave_indicators", {"names": ["爆倉指標", "巨鯨警報", "多空力道"], "symbol": label}],
                             ["levels_table", {}]]}
    return build(recipe, date, headers, extra, fresh)


RESEARCH_TOPICS = ("price", "volume", "relative", "derivatives", "indicators", "levels", "flows")


def research_pack(symbol, topics=None, date=None, headers=None, lookback_days=90, extra=None, fresh=False,
                  benchmark="BTC", window="7d", days=30):
    """研究報告 data pack for one coin or Taiwan stock — the data half of a `type: research`
    report, so a research question never starts from a hand-written fetch script. Same flow as a
    brief: search the news first, then `pack = research_pack("SOL", extra=[…])`, `describe()`,
    `publish(pack, narrative, title="<your claim>")` (references/reports.md §7b).

    topics (default all) picks the sections:
      price        daily candles (120 bars) with the prior-20 high/low and moving averages
      volume       today's volume against its 20-day mean, over a 90-bar daily chart (coin)
      relative     the symbol against `benchmark` over 30 days, rebased to 100 (coin)
      derivatives  funding (Binance), open interest change over `window` ("7d" default — a research
                   question spans weeks; "24h" only for a question about today) and long/short ratio (coin)
    `days` is the relative-performance window (default 30): set it to the span the user asked
    about. It does not change how many candles a chart draws.
      indicators   Blave 爆倉 / 巨鯨 / 多空力道 z-scores (coin)
      levels       recent highs / lows and moving averages as a table
      flows        外資買賣超, last 10 sessions (Taiwan stock)
    A section this machine has no data for is left out and named, as in any pack."""
    sym = str(symbol).strip().upper()
    want = set(RESEARCH_TOPICS if topics is None else topics)
    _check_param("window", "window", window)
    _check_param("days", "days", days)
    bad = sorted(want - set(RESEARCH_TOPICS))
    if bad:
        raise ValueError(f"unknown topic(s) {bad}; topics: {', '.join(RESEARCH_TOPICS)}")
    if sym.isdigit():
        bricks = [["price_chart", {"symbol": sym, "bars": _RESEARCH_BARS}]] if "price" in want or "levels" in want else []
        if "flows" in want:
            bricks.append(["tw_institutional", {"symbol": sym}])
        if "levels" in want:
            bricks.append(["levels_table", {}])
        bricks.append(["news", {"market": "tw", "q": sym}])
        recipe = {"id": f"research-{sym}", "subject": sym, "title": f"{sym} 研究", "type": "research", "report_type": "研究報告",
                  "lookback_days": lookback_days, "kpi": ["price_chart", "tw_institutional"], "bricks": bricks}
    else:
        label = _data.normalize_symbol(sym if sym.endswith("USDT") else sym + "USDT").replace("USDT", "")
        bricks = [["price_chart", {"symbol": label, "bars": _RESEARCH_BARS}]] if "price" in want or "levels" in want else []
        if "volume" in want:
            bricks.append(["coin_snapshot", {"symbol": label, "days": days}])
        if "relative" in want and label != benchmark.upper():
            bricks.append(["relative_to", {"symbol": label, "benchmark": benchmark, "days": days}])
        if "derivatives" in want:
            bricks.append(["funding", {"symbol": label, "variant": "symbol"}])
            bricks.append(["derivs_table", {"symbols": list(dict.fromkeys([label, "BTC", "ETH"])), "window": window}])
        if "indicators" in want:
            bricks.append(["blave_indicators", {"names": ["爆倉指標", "巨鯨警報", "多空力道"], "symbol": label}])
        if "levels" in want:
            bricks.append(["levels_table", {}])
        bricks.append(["news", {"market": "crypto"}])
        recipe = {"id": f"research-{label.lower()}", "subject": label, "title": f"{label} 研究", "type": "research",
                  "report_type": "研究報告", "lookback_days": lookback_days,
                  "kpi": ["price_chart", "funding", "blave_indicators"], "bricks": bricks}
    return build(recipe, date, headers, extra, fresh)


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

def _watch_from_markdown(text):
    """A markdown table of 3 columns (a common first try) → rows; None when it is not one."""
    rows = []
    for ln in text.strip().splitlines():
        ln = ln.strip()
        if not ln.startswith("|"):
            return None
        cells = [c.strip() for c in ln.strip("|").split("|")]
        if all(re.fullmatch(r":?-{2,}:?", c) for c in cells if c):
            continue
        if len(cells) != 3:
            return None
        rows.append(tuple(cells))
    if rows and rows[0] in (("條件", "門檻", "現在值"), ("condition", "threshold", "now")):
        rows = rows[1:]
    return rows or None


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


def publish(pack, narrative=None, report_id=None, title=None, origin=None, lang="zh", shareable=None, replace=False):
    """Assemble the pack and the narrative into a report and drop it. Returns the path.

    `pack` is a Pack or its report id (a string): a template call keeps the pack it built for
    PACK_TTL_S, so a refused publish is re-sent with `publish("<report id>", fixed_narrative)` —
    never by building the pack again (slower, and the live figures move under your narrative).
    Every problem is reported at once, numbered, with how to fix each.

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
    replace: True only to correct the report this turn already published under this id; by
    default a taken id means a new report under the next free id (lib.report.write_report).
    Returns None without writing when `pack.skip` is set."""
    if isinstance(pack, str):
        pack = load_pack(pack)
    if pack.skip:
        # 不 raise:排程跑到休市日要記成 skipped(exit 0、沒有新報告),raise 會變 failed 並發警報。
        print(f"[{pack.report_id}] not published: {pack.skip}")
        return None
    narrative = dict(narrative or {})
    problems = []

    def attempt(fn, *args):
        try:
            return fn(*args)
        except ValueError as e:
            problems.append(str(e))
            return None

    # 表態欄位:不渲染,只證明 agent 看過這幾條提示(加做、來源不到 3 家、擷取了圖卻不放)才決定不照做
    waived = {k: narrative.pop(k) for k in ("no_extra", "few_sources", "images_unused") if k in narrative}
    for k, v in waived.items():
        if not (isinstance(v, str) and 1 <= len(v.strip()) <= 200):
            problems.append(f"narrative[{k!r}] must be one sentence (1–200 characters) saying why")
    if "action" in narrative:
        problems.append("'action' was renamed to 'watch' (觀察重點): conditions and indicator thresholds "
                        "only, no trade instruction, see references/reports.md §1b")
        narrative.pop("action")
    unknown = set(narrative) - set(pack.slots) - {"lead_chart", "images"}
    if unknown:
        problems.append(f"unknown narrative slot(s): {sorted(unknown)}; allowed: {sorted(set(pack.slots) | {'lead_chart', 'images'})}")
        for k in unknown:
            narrative.pop(k)
    lead_chart = narrative.pop("lead_chart", None)
    images_in = narrative.pop("images", None)
    news_given = "news" in narrative
    news_in = narrative.pop("news", None)
    watch = narrative.pop("watch", None)
    if isinstance(narrative.get("read"), (list, tuple)) and all(isinstance(x, str) for x in narrative["read"]):
        # 一串條列 = 3–5 條 "- " 的 markdown(最常見的第一次寫法,直接收)
        narrative["read"] = "\n".join(x if x.lstrip().startswith(("- ", "### ")) else f"- {x.strip()}"
                                      for x in narrative["read"])
    for k in [k for k, v in narrative.items() if not isinstance(v, str)]:
        problems.append(f"narrative[{k!r}] must be a markdown string (read: or a list of bullet strings)")
        narrative.pop(k)
    narrative = {k: _fw(v) for k, v in narrative.items()}
    if isinstance(watch, str):
        watch = _watch_from_markdown(watch) or watch
    if watch and not isinstance(watch, (str, bytes)):
        try:
            watch = [tuple(_fw(str(c)) for c in row) if isinstance(row, (list, tuple)) else row for row in watch]
        except TypeError:
            pass
    watch_block = attempt(_watch_table, watch) if watch else None
    for k, v in narrative.items():
        cap = pack.slots[k][1]
        if len(v) > cap:
            problems.append(f"narrative[{k!r}] is {len(v)} chars, cap {cap} (over by {len(v) - cap}) — "
                            f"cut it, don't summarise the summary: {_SLOT_FORM[k]}"
                            + ("。圖表 title / caption 已經帶了結論與基準,敘事不再重述那些數字" if k == "read" else ""))
    if narrative.get("read", "").strip():
        attempt(_check_read_form, narrative["read"].strip())
    if narrative.get("lead", "").strip():
        problems.extend(_lead_problems(narrative["lead"].strip(), research=pack.type == "research"))
    problems.extend(_number_problems(pack, narrative, watch_block))
    image_blocks = attempt(_image_blocks, report_id or pack.report_id, images_in, replace) or []
    narrated = bool(watch_block) or any(v.strip() for v in narrative.values()) or bool(news_in) or bool(image_blocks)
    unused = sorted(set(_report.captured_files(report_id or pack.report_id, replace)) - {b["file"] for b in image_blocks})
    if unused and images_in is not None and not image_blocks:
        unused = []   # narrative['images'] 本身有錯:上面已經列了,改好再來算誰沒用到
    if unused and "images_unused" not in waived:
        problems.append(f"{len(unused)} captured image(s) are not in the report: {', '.join(unused)}. Cite each with "
                        "narrative['images'] = [{\"file\", \"source\", \"alt\"}] (file and source exactly as browser_capture "
                        "returned them), or say in one sentence why not in narrative['images_unused'] — those files are then "
                        "deleted, and when the user asked for a cited image the reply must say it is not in the report")
    if len(pack.owners) != len(pack.blocks):
        problems.append(f"pack.blocks was changed by hand ({len(pack.blocks)} blocks, {len(pack.owners)} owners): blocks added "
                        "that way are dropped without a word. Publish the kept pack by its id instead — "
                        f"publish({pack.report_id!r}, narrative) — with a cited image in narrative['images'] and extra data "
                        "from build(extra=[…])")
    news = attempt(_news_block, pack, news_in, news_given, narrated)
    news_block, news_foot = news if news else (None, None)
    news_block = _fw_block(news_block) if news_block else None
    names = _tw_names({s for it in (news_block or {}).get("items", []) for s in it.get("symbols") or []})
    if news_block and news_given:
        told = " ".join(narrative.get(k, "") for k in ("lead", "read", "summary"))
        problems.extend(_flow_problems(pack, news_block["items"], narrative.get("lead", ""), waived, told, names))
    if news_block:
        news_block = _news_display(pack, news_block, names)
    if narrated and lang != "en":
        latin = [k for k in ("lead", "summary") if narrative.get(k, "").strip() and not re.search("[㐀-鿿]", narrative[k])]
        if latin:
            problems.append(f"narrative {latin} is not in Chinese: this report is Chinese (lang={lang!r}) — write every "
                            "slot in Chinese; tickers, numbers and source names stay as they are")
    selfcmp = [x.get("title", "") for x in pack.blocks if x.get("type") == "line_chart"
               and len(x.get("series") or []) == 2 and x["series"][0]["name"] == x["series"][1]["name"]]
    if selfcmp:
        problems.append(f"the pack compares a coin with itself (「{selfcmp[0]}」): rebuild without that relative_to — "
                        "its benchmark is the same coin")
    if narrated:
        problems.extend(_title_problems(pack, title))
        problems.extend(_internal_problems([(f"narrative[{k!r}]", v) for k, v in narrative.items()]
                                           + [("title", title if isinstance(title, str) else "")]
                                           + [(f"watch row {i}", " ".join(r.values())) for i, r in
                                              enumerate((watch_block or {}).get("rows", []))]
                                           + [(f"news[{i}].summary", it.get("summary", ""))
                                              for i, it in enumerate((news_block or {}).get("items", []))]))
        problems.extend(_level_problems([(f"narrative[{k!r}]", v) for k, v in narrative.items()]
                                        + [("title", title if isinstance(title, str) else "")]
                                        + [(f"watch row {i}", " ".join(r.values())) for i, r in
                                           enumerate((watch_block or {}).get("rows", []))]))
        if not narrative.get("summary", "").strip():
            problems.append(f"narrative['summary'] is missing: 1–3 sentences ≤{pack.slots['summary'][1]} that close the "
                            "reading — so what, and what to watch next — in words other than the lead's; it goes last, "
                            "before the footnote, with risk as its final sentence")
        else:
            if narrative.get("lead", "").strip():
                problems.extend(_summary_problems(narrative["lead"].strip(), narrative.get("summary", "").strip()))
            named = [r["cond"] for r in (watch_block or {}).get("rows", []) if r["cond"] and r["cond"] in narrative.get("summary", "")]
            if len(named) > 1:
                problems.append(f"narrative['summary'] walks through {len(named)} rows of the 觀察重點 table ({', '.join(named)}): "
                                "name only the most important one — the table is right above it")
    if pack.type == "research" and narrated:
        for slot in ("against", "robustness", "risk"):
            if not narrative.get(slot, "").strip():
                problems.append(f"a research report needs narrative[{slot!r}] ({pack.slots[slot][0].lstrip('# ')}; "
                                f"references/reports.md §7b {'B3' if slot == 'against' else 'B4' if slot == 'robustness' else 'B5'})")
    if pack.news is not None and not news_given and narrated and "few_sources" not in waived:
        problems.append("this report has a news slot and you wrote none: search the web first (3+ sites, "
                        "§1b › News) and fill narrative['news'] — the licensed candidates are a start, not a search; "
                        "found nothing → news=[]; or one sentence in narrative['few_sources'] saying why")

    pairs = list(zip(pack.owners, pack.blocks))
    foot = pairs.pop()[1] if pairs and pairs[-1][1].get("type") == "footnote" else None
    if news_block is not None:
        at = (pack.news or {}).get("at")
        pairs.insert(len(pairs) if at is None else min(at, len(pairs)), ("news", news_block))
    if lead_chart is not None:
        pairs = attempt(_lead_chart_first, pairs, lead_chart) or pairs
    blocks = [b for _, b in pairs]
    if narrative.get("lead", "").strip():
        # 設計稽核 B7:KPI 列的結論式標題(「BTC −0.04%,高於近 30 日均 5.4%」)跟 lead 講同一件事;
        # 有 lead 就拿掉,純資料版(沒有 lead)照留——那時它就是整份報告的開場
        blocks = [{k: v for k, v in b.items() if k != "title"} if b.get("type") == "kpi_row" else b for b in blocks]
    degraded = os.environ.get("BLAVE_REPORT_DEGRADED") if not narrated else None
    degraded_foot = ("auto", _DEGRADED_FOOT.get(degraded, _DEGRADED_FOOT["failed"])) if degraded else None
    if not degraded_foot and not narrated and os.environ.get("BLAVE_REPORT_NOTE") == "agent_available":
        degraded_foot = ("auto", _AGENT_AVAILABLE_FOOT)
    if pack.missing or (lang == "en" and foot) or news_foot or degraded_foot:
        # Copy before changing anything: the pack is reusable and its footnote dict is shared.
        items = [dict(i, text=_data.PUBLIC_SOURCE_EN.get(i["text"], i["text"])) if lang == "en" else dict(i)
                 for i in (foot or {}).get("items", [])]
        items = [(i["id"], i["text"], i.get("url")) for i in items]
        if news_foot:
            items.append(news_foot)
        if degraded_foot:
            items.append(degraded_foot)
        foot = footnote(items + ([_missing_item(pack, lang)] if pack.missing else []))
    out = []
    if narrative.get("lead", "").strip():
        out.append(text(narrative["lead"].strip(), lead=True))
    out += blocks
    out += image_blocks   # 引用圖排在數據區塊之後、判讀之前:判讀引用它時圖已經在上面
    for slot in ("read", "against", "robustness"):
        body = narrative.get(slot, "").strip()
        if body and slot in pack.slots:
            heading = pack.slots[slot][0]
            # 只有 body 自己已經以這個標題開頭才省略;以 ### 子標或 #1 開頭的段落照常加標題。
            out.append(text(body if body.startswith(heading) else f"{heading}\n\n{body}"))
    if watch_block:
        out.append(watch_block)
    closing = _closing(pack.slots["summary"][0], narrative.get("summary", "").strip(), narrative.get("risk", "").strip(), lang)
    if closing:
        out.append(text(closing, variant="summary"))
    if foot and not foot.get("items"):
        foot = None
    if not blocks and not news_block and not narrated:
        # 例:只放 news 的自組配方,排程時沒有授權候選 → 發出去只剩 meta,是空報告
        print(f"[{pack.report_id}] not published: nothing in it today (no data block, no news, no narrative)")
        return None
    if foot:
        out.append(foot)
    # 全份一次全形轉換:區塊各自組字串時漏掉的(觀察重點的說明曾經就是),在這裡一併收掉。
    # en:缺資料那行是英文,尾註不轉
    out = [b if lang == "en" and b.get("type") == "footnote" else _fw_block(b) for b in out]
    # [^id] 是 api 唯一會拒的敘事錯誤,而 id 清單就在手上——本地先擋,免得整份進 failed/。
    known = {i["id"] for i in (foot or {}).get("items", [])}
    written = dict(narrative)
    if watch_block:
        written["watch"] = " ".join(v for r in watch_block["rows"] for v in r.values())
    for key, body in written.items():
        missing = sorted(set(_FNREF_RE.findall(body)) - known)
        if missing:
            problems.append(f"narrative[{key!r}] references footnote id(s) {missing} that the pack has not got; known: {sorted(known)}")
    if origin not in (None, "chat", "scheduled"):
        problems.append("origin must be 'chat' or 'scheduled'")
    if problems:
        raise ValueError(_refusal(pack, problems))
    counted = len(out) + 1 - len(image_blocks)   # 引用圖是用戶點名要的,不算進 R4 的 16 塊
    if counted > MAX_BLOCKS:
        print(f"NOTE for you, not for the reply: {counted} blocks, over {MAX_BLOCKS} (references/reports.md §1b R4). "
              "The report is written as it is; next time drop the bricks the lead does not use.")
    meta = dict(pack.meta)
    meta["origin"] = origin or ("chat" if narrated else "scheduled")
    title, day_cell = _dated_title(pack, title or pack.title)
    if day_cell and "period" not in meta:
        meta["extra"] = list(meta.get("extra") or []) + [day_cell]
    if shareable is not None and pack.type == "research":
        meta["shareable"] = bool(shareable)   # §7b B7 的自評紀錄(research_pack 的報告)
    # 純數據包用自己的 id(-auto):runtime 靠這個字尾分資料版與有判讀的(report_runner._published)。
    # 明給 report_id 就照給。id 已經有報告 → write_report 自己換下一個空的(-2、-3…),不蓋舊的
    if report_id is None:
        report_id = pack.report_id if narrated else pack.report_id + "-auto"
    # write_report prints the "moved to reports/sent/, reply now" line for both paths.
    path = write_report(report_id, title, out, type=pack.type, report_type=pack.report_type, meta=meta, replace=replace)
    if unused:
        print(f"[report] {len(unused)} captured image(s) were left out and deleted. If the user asked for a cited "
              "image, say in the reply - one plain sentence - that it is not in the report and why.")
    reply = _reply_draft(narrative, watch_block)
    if reply:
        # 09-27 實測:光是「一兩句」的規則,agent 仍回四句、重述數字、加粗體標籤——給一個照抄得了的範本
        try:   # Windows run.log 是 cp950:印不出來的字不能讓已寫好的報告變成例外
            print(f"[report] Reply with this after the where-it-is sentence (reword if you like, never longer): {reply}")
        except UnicodeEncodeError:
            pass
    return path


IMAGE_ALT_MAX, IMAGE_CAPTION_MAX, IMAGE_SOURCE_NAME_MAX = 200, 300, 40


def _image_blocks(report_id, images, replace=False):
    """narrative['images'] → cited `image` blocks (references/reports.md §5 › Citing an image from the
    web). Each item is what browser_capture returned — `file`, `source` {name, url} — plus `alt`
    and an optional `caption`. Every problem is raised at once; nothing is dropped quietly."""
    if images is None:
        return []
    if not isinstance(images, (list, tuple)) or not all(isinstance(x, dict) for x in images):
        raise ValueError("narrative['images'] must be a list of {\"file\", \"source\", \"alt\"} items")
    bad = []
    if len(images) > _report.CITED_IMAGES_MAX:
        bad.append(f"narrative['images'] has {len(images)} items, at most {_report.CITED_IMAGES_MAX}: keep the ones a "
                   "claim in the text rests on")
    have = set(_report.captured_files(report_id, replace))
    own = None if replace else _report._own(report_id)
    out = []
    for i, it in enumerate(images):
        where = f"narrative['images'][{i}]"
        extra = sorted(set(it) - {"file", "source", "alt", "caption"})
        if extra:
            bad.append(f"{where}: unknown key(s) {extra}; an item is file, source, alt and an optional caption")
        file, src, alt, cap = it.get("file"), it.get("source"), it.get("alt"), it.get("caption")
        if not isinstance(file, str) or file not in have:
            bad.append(f"{where}.file {file!r} is not a capture of this report — browser_capture(tab, ref, "
                       f"report={report_id!r}) writes it and returns the name; captured now: {sorted(have) or 'none'}"
                       + (" (you already published this report in this turn: to correct that one, publish with "
                          "replace=True and its pictures are found again)" if own else ""))
        if not (isinstance(alt, str) and 1 <= len(alt.strip()) <= IMAGE_ALT_MAX):
            bad.append(f"{where}.alt is required: what the chart shows, in the report's language, ≤{IMAGE_ALT_MAX} characters")
        if cap is not None and not (isinstance(cap, str) and 1 <= len(cap.strip()) <= IMAGE_CAPTION_MAX):
            bad.append(f"{where}.caption must be 1–{IMAGE_CAPTION_MAX} characters when given")
        name = src.get("name") if isinstance(src, dict) else None
        if not isinstance(src, dict) or set(src) != {"name", "url"} \
                or not (isinstance(name, str) and 1 <= len(name.strip()) <= IMAGE_SOURCE_NAME_MAX):
            bad.append(f"{where}.source must be {{\"name\" (≤{IMAGE_SOURCE_NAME_MAX}), \"url\"}}, as browser_capture returned it")
        else:
            try:
                _check_url(src["url"], f"{where}.source")
            except ValueError as e:
                bad.append(str(e))
        out.append((file, alt, src, cap))
    if bad:
        raise ValueError("\n           ".join(bad))
    return [dict({"type": "image", "file": file, "alt": alt.strip(),
                  "source": {"name": src["name"].strip(), "url": src["url"]}},
                 **({"caption": cap.strip()} if cap else {}))
            for file, alt, src, cap in out]


def _reply_draft(narrative, watch_block):
    """The chat reply after a narrated publish (設計稽核 B6): the lead's conclusion, then the one thing
    to watch — the summary's 「接下來看…」 sentence, else the first watch row. None without a lead."""
    lead = _first_sentence(narrative.get("lead", "")) if narrative.get("lead", "").strip() else ""
    if not lead:
        return None
    parts = [x.strip() for x in re.split(r"(?<=[。！？!?])", _MD_RE.sub("", narrative.get("summary", ""))) if x.strip()]
    nxt = next((x for x in parts if "接下來看" in x or "接下來觀察" in x), None)
    if nxt is None and watch_block and watch_block.get("rows"):
        nxt = f"接下來看{watch_block['rows'][0]['cond']}。"
    return lead + (nxt[nxt.index("接下來"):] if nxt and "接下來" in nxt else (nxt or ""))


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
        # 括號裡有中文、或緊貼著中文／全形標點(「42,711.41(+0.71%)，」)→ 全形
        p = _FW_PAREN_RE.sub(lambda m: f"（{m.group(1)}）" if _HAS_CJK_RE.search(m.group(0)) or
                             _HAS_CJK_RE.match(p[m.start() - 1:m.start()] or "x") or
                             _HAS_CJK_RE.match(p[m.end():m.end() + 1] or "x") else m.group(0), p)
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
_MD_RE = _report.MD_RE
_first_sentence = _report.first_sentence
# 研究 lead 的數字算法(references/reports.md 7b A2):窗口長度、段號、年份不算數字
_NOT_A_NUMBER_AFTER_RE = re.compile(r"\s*(?:個)?(?:交易)?(?:日|天|週|周|月|年|段)")
_YEAR_RE = re.compile(r"(?:19|20)\d\d")


def _source_of(src):
    from urllib.parse import urlsplit
    if src.get("url"):
        host = (urlsplit(src["url"]).hostname or "").lower()
        return host[4:] if host.startswith("www.") else host
    return src.get("name", "").strip().lower()


# 新聞標題/摘要裡的標的(agent 常沒填 symbols):常見幣種代號與中英文名、台股常見名稱。
# 只認這張表與本報告報價表裡的代號——大寫縮寫太多(ETF、SEC、USD、CEO),不猜。
_COMMON_COINS = ("BTC", "ETH", "XRP", "SOL", "BNB", "DOGE", "ADA", "TRX", "TON", "AVAX", "LINK", "DOT", "LTC", "BCH",
                 "SHIB", "SUI", "APT", "ARB", "OP", "NEAR", "ATOM", "UNI", "AAVE", "PEPE", "WIF", "HYPE", "ENA", "ONDO",
                 "TAO", "FIL", "ETC", "XLM", "HBAR", "ICP", "INJ", "SEI", "TIA", "BGB", "OKB", "CRO", "LEO", "ZEC",
                 "XMR", "WLD", "JUP", "PENDLE", "FET", "RENDER", "MKR", "LDO", "CAKE")
_NAME_TO_SYMBOL = {"比特幣": "BTC", "bitcoin": "BTC", "以太坊": "ETH", "以太幣": "ETH", "ethereum": "ETH", "瑞波": "XRP",
                   "ripple": "XRP", "索拉納": "SOL", "solana": "SOL", "幣安幣": "BNB", "狗狗幣": "DOGE", "dogecoin": "DOGE",
                   "艾達幣": "ADA", "cardano": "ADA", "波場": "TRX", "tron": "TRX", "台積電": "2330", "聯發科": "2454",
                   "鴻海": "2317", "廣達": "2382", "台達電": "2308", "聯電": "2303", "日月光": "3711", "中華電": "2412"}
_TICKER_RE = re.compile(r"(?<![A-Za-z0-9])([A-Z][A-Z0-9]{1,6})(?![A-Za-z0-9])")


def _named_symbols(item, known):
    """Instruments a news item names: its `symbols`, plus coin tickers / common names found in its
    title and summary (the table above, and the coins this report already quotes)."""
    text = f"{item.get('title', '')} {item.get('title_orig', '')} {item.get('summary', '')}"
    out = list(item.get("symbols") or [])
    out += [m for m in _TICKER_RE.findall(text) if m in _COMMON_COINS or m in known]
    low = text.lower()
    out += [sym for name, sym in _NAME_TO_SYMBOL.items() if name in low]
    return list(dict.fromkeys(out))


_TW_ID_RE = re.compile(r"\d{4}[0-9A-Z]{0,2}")
_SYMBOL_NAMES = {}
for _n, _s in _NAME_TO_SYMBOL.items():
    _SYMBOL_NAMES.setdefault(_s, []).append(_n)


def _tw_names(ids):
    """{Taiwan id: name} for the ids a news block names — Blave's stock list, else (desktop) TWSE's
    day-all table. An id neither knows is left out, and so is not shown."""
    ids = {str(i) for i in ids if _TW_ID_RE.fullmatch(str(i))}
    out = {}
    if not ids:
        return out
    try:
        # 一次、短逾時:只為新聞標籤的名稱,不值得讓 publish 為它退避好幾分鐘
        df = _data.fetch_twstock_list(headers_from_env(), max_retries=1, timeout=8)
        out = {i: str(df.loc[i, "name"]).strip() for i in ids if i in df.index}
    except Exception:
        pass
    rest = ids - {i for i, v in out.items() if v}
    if rest and _data.tw_market_public_allowed():
        try:
            df = _data.fetch_twse_day_all_public()
            out.update({i: str(df.loc[i, "name"]).strip() for i in rest if i in df.index})
        except Exception:
            pass
    return {i: v for i, v in out.items() if v and v.lower() != "nan"}


def _news_display(pack, block, names):
    """The news block as readers see it: a Taiwan id shown by its name (none found → not shown),
    and the report's own instrument dropped on a single-instrument report (every item would carry it)."""
    items = []
    for it in block["items"]:
        shown = []
        for s in it.get("symbols") or []:
            if pack.subject and s.upper() == str(pack.subject).upper():
                continue
            s = names.get(s) if _TW_ID_RE.fullmatch(s) else s
            if s and s not in shown:
                shown.append(s[:16])
        it = {k: v for k, v in it.items() if k != "symbols"}
        items.append(dict(it, symbols=shown[:5]) if shown else it)
    return dict(block, items=items)


def _extra_for(pack, sym):
    """The extra bricks that would show `sym`, minus the ones the pack already ran for it. [] = nothing
    to add (an ETF with a letter, BTC in its own brief, a stock brief that already has both)."""
    if _TW_ID_RE.fullmatch(sym):
        want = [["tw_institutional", {"symbol": sym}], ["price_chart", {"symbol": sym}]] if sym.isdigit() else []
    elif sym in _benchmarks(pack):
        want = []   # 基準幣本身:跟自己比沒有意義,它的走勢已在比較圖裡
    elif sym == str(pack.subject or "").upper():
        want = [["relative_to", {"symbol": sym}]]
    else:
        want = [["coin_snapshot", {"symbol": sym}], ["relative_to", {"symbol": sym}]]
    have = {(n, str(p.get("symbol", "")).upper()) for n, p in pack.bricks}
    return [w for w in want if (w[0], w[1]["symbol"].upper()) not in have]


def _benchmarks(pack):
    """Coins a comparison in this pack is measured against (relative_to's benchmark, BTC by default)."""
    out = {"BTC"}
    out |= {str(p.get("benchmark", "BTC")).upper() for n, p in pack.bricks if n == "relative_to"}
    return out


def _extra_hint(pack, sym):
    got = _extra_for(pack, sym)
    return "extra=[" + ", ".join(json.dumps(g, ensure_ascii=False) for g in got) + "]" if got else ""


def _mentions(text_, sym, names):
    return any(n and n in text_ for n in [sym, names.get(sym)] + _SYMBOL_NAMES.get(sym, []))


def _flow_problems(pack, items, lead, waived, told="", names=None):
    """§1b › Report flow, checked on what the agent actually wrote: news that names an instrument
    with good or bad news, and no extra brick built for it; news from fewer than NEWS_MIN_SITES sites.
    `no_extra` settles the first only for instruments the narrative does not argue from — one the
    lead / read / summary talks about gets its brick (09-26: 外資大砍友達、DOGE ETF 清算 both waived)."""
    names = names or {}
    out = []
    if not pack.extra_owners:
        known = {k for k in pack.context if re.fullmatch(r"[A-Z0-9]{2,8}", k)}
        syms = list(dict.fromkeys(s for it in items if it.get("tag") in ("pos", "neg")
                                  for s in _named_symbols(it, known)))
        syms += [s for it in items for s in _named_symbols(it, known) if _mentions(lead, s, names) and s not in syms]
        syms = [s for s in syms if _extra_for(pack, s)]
        if "no_extra" in waived:
            syms = [s for s in syms if _mentions(told, s, names)]
        if syms:
            hints = "; ".join(f"{s}{'(' + names[s] + ')' if s in names else ''}: {_extra_hint(pack, s)}" for s in syms[:3])
            out.append(f"today's news names {', '.join(syms[:3])} and the pack has no extra brick for it "
                       f"(references/reports.md §1b › Report flow): rebuild once with {hints} — then publish the same "
                       "narrative again" + (" (no_extra does not cover an instrument your lead / read / summary "
                                            "argues from: show it)" if "no_extra" in waived else
                                            "; narrative['no_extra'] only when that brick cannot be built (no data)"))
    if "few_sources" not in waived:
        sites = sorted({_source_of(s) for it in items for s in it.get("sources") or []} - {""})
        if len(sites) < NEWS_MIN_SITES:
            out.append(f"the news comes from {len(sites)} site(s) ({', '.join(sites) or '?'}), fewer than "
                       f"{NEWS_MIN_SITES}: read at least {NEWS_MIN_SITES} different sites and give the news at least "
                       f"{NEWS_MIN_SITES} different sources (§1b › News); or put one sentence in "
                       "narrative['few_sources'] saying why no more could be found")
    return out


# 把統計值(均線、前 20 日高低)講成地板或天花板 = 支撐壓力(§1b Levels);09-26 排程模擬的總結寫出
# 「指數仍守在 60 日均之上」。只認明確的字眼,籌碼門檻(「融資跌破 845 萬張」)不算。
_LEVEL_TALK_RE = re.compile(r"支撐|壓力[位區線]|守住|守在|失守|站回|(?:跌破|站上|站穩|回測)[^，。；,;]{0,6}(?:均線|日均|前\s*20\s*日[高低])")


def _level_problems(texts):
    hits = [f"{k}「{m.group(0)}」" for k, t in texts if t for m in [_LEVEL_TALK_RE.search(t)] if m]
    if not hits:
        return []
    return [f"{', '.join(hits[:4])} treats a level as a floor or ceiling (support / resistance): state where the close "
            "sits as a figure (「收盤高於 60 日均 6.0%」), and write thresholds as indicator / 籌碼 conditions "
            "(references/reports.md §1b › Levels)"]


# 讀者看不懂、也不該看到的工程字(09-26 研究實測:「BTC同期+4.9%(資料包 relative_to)」)
_INTERNAL_WORDS = ("資料包", "積木", "describe()", "publish(", "narrative", "research_pack", "report_templates",
                   "report_bricks", "lib/", "lib.", "extra=", "pack.", "BLAVE_")


def _internal_words():
    from lib import report_bricks
    # 只認帶底線的積木名:news / funding / movers / liquidation 是一般英文字
    return tuple(b for b in report_bricks.BRICKS if "_" in b) + _INTERNAL_WORDS


def _internal_problems(texts):
    words = _internal_words()
    hits = []
    for k, t in texts:
        low = (t or "").lower().replace("（", "(").replace("）", ")")
        hits += [f"{k}「{w}」" for w in words
                 if (re.search(rf"(?<![A-Za-z0-9_]){re.escape(w.lower())}(?![A-Za-z0-9_])", low) if w[-1].isalnum() else w.lower() in low)]
    if not hits:
        return []
    return [f"{', '.join(hits[:5])}: engineering names (bricks, functions, 資料包) are not for readers — say what the "
            "number is (「BTC 同期 +4.9%」), not where it came from"]


def _title_problems(pack, title):
    """A narrated report's title is its conclusion (§7b; briefs too since 0.1.7) — never the template name."""
    t = title.strip() if isinstance(title, str) else ""
    if not t or t == pack.title:
        return [f"publish(..., title=\"<conclusion ≤{TITLE_MAX} chars>\") is missing: the title states today's "
                f"conclusion (e.g. 「外資轉賣 338 億，指數仍站 60 日均之上」), not the template name 「{pack.title}」"]
    if len(t) > TITLE_MAX:
        return [f"title is {len(t)} chars, cap {TITLE_MAX} (over by {len(t) - TITLE_MAX}): state the conclusion shorter"
                + (f";研究建議 ≤{RESEARCH_TITLE_MAX} 字(分享卡只放得下兩行,references/reports.md 7b A1)"
                   if pack.type == "research" else "")]
    return []


def _bigrams(s):
    s = re.sub(r"[\s\W_]+", "", s)
    return {s[i:i + 2] for i in range(len(s) - 1)}


def _summary_problems(lead, summary):
    """The summary closes the reading in other words: the lead's first sentence copied, or most of its
    character pairs taken from the lead, is the opening said twice."""
    first = _first_sentence(lead).rstrip("。")
    sb, lb = _bigrams(summary), _bigrams(lead)
    share = len(sb & lb) / len(sb) if sb else 0.0
    out = []
    if (first and first in summary) or share > SUMMARY_LEAD_OVERLAP:
        out.append(f"narrative['summary'] repeats the lead ({share:.0%} of it is the lead's wording): say what it adds up "
                   "to — so what, and what to watch next — not the opening again")
    n = len([x for x in re.split(r"[。！？!?]", summary) if x.strip()])
    if n > 3:
        out.append(f"narrative['summary'] is {n} sentences, at most 3: the so-what and the one thing to watch")
    return out


_RISK_PREFIX = {"zh": "推翻條件：", "en": "What would prove this wrong: "}
_RISK_PREFIX_RE = re.compile(r"^\s*(\*\*)?推翻(條件|這份解讀的訊號)[:：]?(\*\*)?\s*")


def _closing(heading, summary, risk, lang="zh"):
    """The 總結 block's markdown (designer spec 09-26 ④): the summary, then the risk as its own last
    paragraph behind a fixed prefix publish writes — fixed so it can be found and translated."""
    if not summary and not risk:
        return ""
    parts = [heading] + ([summary] if summary else [])
    if risk:
        parts.append(f"**{_RISK_PREFIX.get(lang, _RISK_PREFIX['zh'])}**{_RISK_PREFIX_RE.sub('', risk)}")
    return "\n\n".join(parts)


def _dated_title(pack, title):
    """(title, meta.extra cell or None). A report about another day than today (a 收盤報告 run on
    Saturday for Thursday) says which day in its title and header — the header's date is when it
    was written, and read alone it passes Thursday's numbers off as today's."""
    day = pack.report_day
    if not day or day == _today_tpe():
        return title, None
    y, m, d = day.split("-")
    md = f"{int(m)}/{int(d)}"
    label = f"{md} 收盤" if pack.mode == "close" else md
    if md not in title:
        title = f"{label}｜{title}"
    return title, {"label": "資料日", "value": f"{y}/{m}/{d}"}


def _refusal(pack, problems):
    lines = "\n".join(f"  {i}. {p}" for i, p in enumerate(problems, 1))
    return (f"publish() refused {pack.report_id}: {len(problems)} problem(s) — fix every one, then re-send with "
            f"the SAME pack: publish({pack.report_id!r}, narrative). Do not call the template again (it is "
            f"slower and its live figures move under your narrative).\n{lines}")


def _lead_problems(lead, research=False):
    out = []
    for check in (_lead_len, (lambda x: _lead_nums(x, research)), _lead_words):
        try:
            check(lead)
        except ValueError as e:
            out.append(str(e))
    return out


def _lead_len(lead):
    first = _first_sentence(lead)
    if len(first) > LEAD_FIRST_MAX:
        raise ValueError(f"narrative['lead'] first sentence is {len(first)} chars, cap {LEAD_FIRST_MAX} "
                         f"(over by {len(first) - LEAD_FIRST_MAX}): 「{first}」 — one conclusion up to the first 「。」, "
                         "the figures go in the second sentence (references/reports.md §1b R9 S1)")


def _lead_nums(lead, research=False):
    first = _first_sentence(lead)
    nums = [m.group(0) for m in _NUM_RE.finditer(first) if not (research and _not_a_number(first, m))]
    if len(nums) > LEAD_FIRST_NUMBERS:
        raise ValueError(f"narrative['lead'] first sentence carries {len(nums)} numbers ({', '.join(nums)}), "
                         f"at most {LEAD_FIRST_NUMBERS} (one comparison): move the rest after the first 「。」")


def _not_a_number(text_, m):
    """A bare integer that is a window length, a segment number or a year (「60 日」「第 2 段」「2024 年」)."""
    if m.group(1) or m.group(3) or not m.group(2).isdigit():
        return False
    return bool(_YEAR_RE.fullmatch(m.group(2)) or _NOT_A_NUMBER_AFTER_RE.match(text_, m.end(2)))


def _lead_words(lead):
    first = _first_sentence(lead)
    words = re.sub(rf"[^{_CJK}A-Za-z]|[，。：；、（）！？「」—]", "", _NUM_RE.sub("", first))
    if len(words) < 2:
        raise ValueError(f"narrative['lead'] first sentence is only figures: 「{first}」 — say what they mean")


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
    problems = _number_problems(pack, narrative, watch_block)
    if problems:
        raise ValueError(problems[0])


def _number_problems(pack, narrative, watch_block):
    """R10.2: a figure that is almost — but not exactly, nor by rounding — one the pack
    printed is a mis-copy (ETH +7.36% against describe()'s +7.26%). A figure far from every
    pack figure is a new comparison and passes. Every slip, not just the first."""
    out = []
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
                out.append(f"narrative[{key!r}] quotes {raw} but describe() has {c[3]} ({c[4]}), "
                           f"{abs(v - c[0]) / c[0] * 100:.2f}% apart — write {c[3]} exactly (copy it from "
                           "describe()), or a comparison that is clearly a new number")
    return out


# ─── R5:新聞格 ────────────────────────────────────────────────────────────────

NEWS_SUMMARY_MAX = 40
NEWS_MIN_SITES = 3   # Wei 09-26:兩家太寒酸
NEWS_MAX_ITEMS = 5
NEWS_ITEM_FIELDS = ("title", "title_orig", "title_orig_lang", "summary", "tag", "sources", "published_at",
                    "published_at_precision", "symbols", "channel")
_LANG_TAG_RE = re.compile(r"(?=.{2,8}$)[a-z]{2,3}(-[A-Za-z0-9]{2,4})?")
NEWS_TAGS = ("pos", "neg", "neutral")
_TAG_ALIASES = {"positive": "pos", "negative": "neg", "正面": "pos", "正面消息": "pos", "負面": "neg",
                "負面消息": "neg", "中性": "neutral", "neu": "neutral"}
NEWS_MAX_AGE_DAYS = 7
NEWS_TITLE_SIMILAR = 0.85
# 建議語氣與操作字眼(R3):摘要只陳述事件,不評價、不指示
_NEWS_ADVICE_RE = re.compile(r"可望|值得布局|值得關注|建議(買|賣|進場|加碼|減碼)|(宜|應|可以?|趁\S{0,4})(進場|加碼|減碼|布局)"
                             r"|好時機|抄底|目標價|逢低|逢高")
_URL_BAD_RE = re.compile(r"[\x00-\x20\x7f]")
_CHART_TYPES = ("candlestick", "line_chart", "bar_chart", "table", "news", "heatmap", "histogram", "scatter", "box")


# 排程報告:agent 那一輪沒完成、runner 退回純資料版時,尾註講一句為什麼(report_runner.DEGRADED_REASONS)
_DEGRADED_FOOT = {
    "timeout": "這次 AI 整理沒有在時限內完成，以下是數據。",
    "balance": "這次點數餘額不足，沒有請 AI 整理，以下是數據。",
    "budget": "這次 AI 整理超過每份費用上限而停下，以下是數據。",
    "busy": "這次 AI 正忙於其他對話，沒有排到整理，以下是數據。",
    "failed": "這次 AI 整理沒有完成，以下是數據。",
    "no_report": "這次 AI 整理沒有完成，以下是數據。",
    "daily_cap": "今天這份報告已請 AI 整理過一次，這次只附數據。",
}


# 試用轉付費後的第一份排程報告(report_runner.check_upgrade):只說一次,不自動開、不扣費
_AGENT_AVAILABLE_FOOT = "升級後排程可以請 AI 整理新聞，跟 agent 說一聲就能開。"


def _news_describe(news):
    c = news["candidates"]
    search = ("  先上網查:至少 3 個不同網站(優先 鉅亨(授權,列表頁 https://news.cnyes.com/news/cat/headline"
              " 與 /news/cat/bc_crypto 可直接抓)與交易所/專案方官方公告;其他新聞站都可以用,"
              "標明來源、摘要用自己的話、不照抄全文);"
              "下面的候選只是起點,不能代替上網")
    why = {"denied": "無 Blave 資料權限,鉅亨候選省略", "failed": "鉅亨新聞抓取失敗", None: "上一個收盤之後"}[news.get("state")]
    head = (f"  新聞候選 {len(c)} 則(鉅亨授權,{why}):"
            if news["market"] == "tw" else "  新聞候選:加密的授權源是鉅亨列表頁 https://news.cnyes.com/news/cat/bc_crypto,"
            "其餘靠你上網蒐集(見 references/reports.md §1b News)")
    lines = [search, head]
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


_DATE_ONLY_RE = re.compile(r"\s*\d{4}-\d{2}-\d{2}\s*")


def _news_time(v, where, precision=None):
    """→ (unix seconds, "day" | "minute"). A bare date ('2026-09-25', or precision="day") is a
    day: stored at 12:00 UTC of that date (not midnight, which renders as a fake 00:00) — never
    later than now — and marked so the renderer shows the date only."""
    if precision not in (None, "day", "minute"):
        raise ValueError(f"{where}: published_at_precision must be 'day' or 'minute', got {precision!r}")
    if isinstance(v, bool):
        raise ValueError(f"{where}: published_at must be unix seconds, 'YYYY-MM-DD HH:MM' (Taipei) or 'YYYY-MM-DD'")
    day = precision == "day" or (isinstance(v, str) and _DATE_ONLY_RE.fullmatch(v) is not None)
    if isinstance(v, (int, float)):
        if not math.isfinite(v):
            raise ValueError(f"{where}: published_at must be a finite unix time, got {v!r}")
        ts = int(v)
        if day:
            d = datetime.fromtimestamp(ts, TPE).date()
            ts = int(datetime(d.year, d.month, d.day, 12, tzinfo=timezone.utc).timestamp())
    else:
        try:
            t = pd.Timestamp(str(v).strip())
        except (ValueError, TypeError):
            raise ValueError(f"{where}: published_at must be unix seconds, 'YYYY-MM-DD HH:MM' (Taipei) or "
                             f"'YYYY-MM-DD' (a day, when the page gives no time), got {v!r}")
        if day:
            ts = int(datetime(t.year, t.month, t.day, 12, tzinfo=timezone.utc).timestamp())
        else:
            ts = int((t.tz_localize(TPE) if t.tzinfo is None else t).timestamp())
    now = _now_tpe().timestamp()
    if day:
        ts = min(ts, int(now))
    if ts > now + 600:
        raise ValueError(f"{where}: published_at is in the future")
    if ts < now - NEWS_MAX_AGE_DAYS * 86400:
        raise ValueError(f"{where}: published_at is more than {NEWS_MAX_AGE_DAYS} days old — "
                         "a brief takes the news since the last close")
    return ts, ("day" if day else "minute")


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
    out, urls, titles, errs = [], {}, [], []
    for i, it in enumerate(items):
        try:
            item, nt = _news_one(i, it, urls, titles)
        except ValueError as e:
            errs.append(str(e))   # 每一則的問題都列出來,不是擋在第一則
            continue
        titles.append(nt)
        out.append(item)
    if errs:
        raise ValueError("\n     ".join(errs))
    return out


def _news_one(i, it, urls, titles):
    from difflib import SequenceMatcher
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
    tag = _TAG_ALIASES.get(str(it.get("tag") or "").strip().lower(), it.get("tag"))
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
    item["published_at"], prec = _news_time(it.get("published_at"), w, it.get("published_at_precision"))
    if prec == "day":
        item["published_at_precision"] = "day"   # 渲染端只顯示日期(沒有時間的新聞不畫成 00:00)
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
    return item, nt


def _news_title(items):
    """The block's own name comes first: 「綜合 3 家」 alone does not say what the block is
    (e2e 0.1.8 #59). The count or the outlet names are the supplement."""
    names = list(dict.fromkeys(s["name"] for it in items for s in it["sources"]))
    if len(names) >= 3:
        return f"新聞 · 綜合 {len(names)} 家"
    return "新聞 · " + "、".join(names) if names else "新聞"


def _news_block(pack, news_in, given, narrated):
    """(news block or None, footnote item or None) for this publish."""
    n = (pack.news or {}).get("n", NEWS_MAX_ITEMS)
    if given and news_in:
        items = _news_items(news_in, n)
        at = _now_tpe().strftime("%H:%M")
        return ({"type": "news", "title": _news_title(items), "items": items,
                 "caption": "上一個收盤之後;點名本報告標的的優先,其次是影響面大的"},
                ("news", f"新聞為 agent 於 {at} 蒐集整理；標籤依事件性質分類，不是股價預測。"))
    if pack.news is None:
        # 沒有 news 積木:只有 agent 明說「查過、沒有」(news=[])才寫那一行尾註
        return None, (("news", "這份沒有附新聞：這次沒有查到可用的新聞來源。") if given else None)
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
