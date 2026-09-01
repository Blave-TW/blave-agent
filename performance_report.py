"""Periodic performance report generator — deterministic, zero LLM.

Runs hourly and does two things:

  1. Samples the account's equity from `manager/account.json` into
     `workspace/state/equity_history.jsonl`. The platform keeps its own hourly
     equity snapshot (MySQL `agent_equity_snapshot`), but that lives on the
     other side of the network from a machine-side generator, so the history
     has to accumulate here too. Hourly on purpose: same cadence as the
     platform's, so the two series are sampled from the same readings.
  2. Produces the daily / weekly report when one is due and drops it in
     `workspace/reports/` via report_uploader.drop() — the uploader ships it.
     Ids are deterministic (`daily-YYYY-MM-DD`, `wk-YYYY-MM-DD`, the UTC dates
     of the period COVERED), so a re-run overwrites its own report instead of
     producing a second one, on the machine and on the platform alike.

No LLM anywhere: reports are a scheduled artifact and must not burn the user's
credit. Everything here is arithmetic over files that already exist.

Reads DISK PRODUCTS ONLY — never imports `workspace/lib/`. lib rides
blaveclaw-config's manual update channel, so a machine whose user never said
「更新」 has an arbitrarily old copy; portfolio_reporter reads the same files for
the same reason. Any missing input costs the blocks that need it, never the
report: a machine with no equity history still gets its per-strategy table.

No figures are drawn here. The contract's chart blocks carry data series and
the web renders them (`.claude/docs/report-blocks.md` §2); the image channel is
for long-tail research figures and is not used by this generator.

Currency: mixed-currency accounts DEGRADE rather than convert. There are no fx
rates on this machine (the platform converts with `common/fx.py` for its own
snapshot), and inventing a rate here would put a second, disagreeing equity
curve in front of the user. Single-currency machines — the whole fleet as
observed — get the full report.
"""
import json
import math
import os
import platform
import sys
import time
from datetime import datetime, timedelta, timezone

import report_uploader

WORKSPACE = os.environ.get("BLAVE_AGENT_WORKSPACE", "/opt/blave-agent/workspace")
# workspace 自己的 state/，不是 runtime 的 /opt/blave-agent/state——同
# portfolio_reporter 的理由，而且放這裡機器端 agent 讀得到自己的權益歷史。
WORKSPACE_STATE = os.path.join(WORKSPACE, "state")
HISTORY_PATH = os.path.join(WORKSPACE_STATE, "equity_history.jsonl")
STATE_PATH = os.path.join(WORKSPACE_STATE, "performance_report.json")

# account.json 比這更舊就不取樣：機器停了或讀數卡住，補一個過期點會在曲線上
# 畫出一段假的平盤。同平台 agent_equity_snapshot.STALE_S。
STALE_S = 900
HISTORY_MAX_LINES = 10000  # 每小時一筆 ≈ 400 天
HISTORY_COMPACT_BYTES = 2 * 1024 * 1024
_MAX_POINTS = 2000  # 契約上限 5000；抽稀到這個量已經超過任何螢幕的解析度
_MAX_STRATEGY_ROWS = 100
# systemd TimeoutStartSec=120。stats.json 可以有好幾 MB，而這是 oneshot(每次
# 都是新 process，沒有 portfolio_reporter 那份 cache 可用)，所以掃策略要有底。
# **整支程式共用一份**,由 main() 從起點算出絕對截止時刻往下傳:日報與週報各自從
# 呼叫當下起算的話，星期一那一輪最壞是 60+60 秒再加上取樣，撞穿 TimeoutStartSec
# 就是 SIGKILL——state 沒存，下一個小時整套重來，然後每小時重演一次。
_BUDGET_S = 60
_MIN_RETURN_DAYS = 3   # 少於這個天數的風險指標只是雜訊
_MIN_HEATMAP_MONTHS = 2


def _read_json(path, default=None):
    # RecursionError(RuntimeError 的子類,不是 ValueError)= 巢狀深到 parser 爆堆疊。
    # 這裡讀的全是別的 process 寫的磁碟產物(account.json / stats.json / state.json),
    # 漏接就是 main() 每小時在同一個檔上死掉一次，日報與週報從此不再產出。
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError, RecursionError):
        return default


def _mtime(path):
    try:
        return int(os.path.getmtime(path))
    except OSError:
        return None


def _save_state(state):
    """哪一份日/週報已經處理過。原子換檔：這支程式可能在下一輪還沒跑完就被重跑。"""
    try:
        os.makedirs(WORKSPACE_STATE, exist_ok=True)
        tmp = STATE_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False)
        os.replace(tmp, STATE_PATH)
    except OSError as e:
        print(f"[performance_report] state write failed: {e}", file=sys.stderr)


# ── 權益取樣 ──────────────────────────────────────────────────────────────────


def _finite(v):
    """是不是一個**有限**的數。

    型別檢查不夠:`_read_json` 用的是裸 `json.load`,它收得下非標準的 `NaN` /
    `Infinity` 字面值(交易所模組把一個算壞的權益寫進 account.json 就會長這樣),
    而那些值 isinstance 是 float、通得過每一道型別閘門,一路流到
    `append_sample` 的 `json.dumps(allow_nan=False)` 才丟 ValueError——那裡的 try
    只接 OSError,於是 main() 在取樣階段整支掛掉，日報與週報從此不再產出。
    非有限數也不該進報告本文:`f"{nan:.2f}"` 是字串 "nan",渲染出來是一格假數字。"""
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _venue_equity(entry):
    """一個交易所的權益。accounts(錢包分佈)總和優先、fallback equity——與平台
    快照和工作頁的 pfLiveTotal 同一個語意，三邊不能各算各的。"""
    accounts = entry.get("accounts")
    if isinstance(accounts, dict) and accounts:
        values = [v for v in accounts.values() if _finite(v)]
        if values:
            return float(sum(values))
    equity = entry.get("equity")
    if _finite(equity):
        return float(equity)
    return None


def sample_equity(now=None):
    """account.json → 一筆樣本，或 None(檔不在 / 讀數過舊 / 沒有可用 venue)。

    ok=False 的 venue 跳過而不是記 0：讀失敗是「不知道」，補零會在曲線上打出一個
    假的斷崖（平台快照同一條規則）。時間戳用 read_at 而不是現在，樣本點才對得上
    真正的觀測時刻。"""
    now = int(now if now is not None else time.time())
    account = _read_json(os.path.join(WORKSPACE, "manager", "account.json"))
    if not isinstance(account, dict):
        return None
    read_at = account.get("read_at")
    if not isinstance(read_at, int) or isinstance(read_at, bool):
        return None
    if now - read_at > STALE_S:
        return None
    venues = {}
    for vid, entry in (account.get("venues") or {}).items():
        if not isinstance(entry, dict) or not entry.get("ok"):
            continue
        equity = _venue_equity(entry)
        if not _finite(equity):  # None,或幾個有限數加總溢位成 inf
            continue
        currency = entry.get("currency")
        venues[str(vid)] = {"equity": round(equity, 4),
                            "currency": currency if isinstance(currency, str) else None}
    if not venues:
        return None
    return {"t": read_at, "venues": venues}


def append_sample(sample):
    """append-only jsonl。同一個 read_at 不重複記：account_reader 沒跑新的一輪時，
    這個 job 照樣會醒來，補一個一模一樣的點只會讓日內報酬多一段假平盤。"""
    if not sample:
        return False
    history = read_history()
    if history and history[-1]["t"] >= sample["t"]:
        return False
    try:
        os.makedirs(WORKSPACE_STATE, exist_ok=True)
        with open(HISTORY_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(sample, ensure_ascii=False, allow_nan=False) + "\n")
    # ValueError 是 allow_nan=False 撞到非有限數。上游的 _finite 閘門已經擋掉了，
    # 但取樣是 main() 的第一步:這裡漏一個例外出去，日報週報就整段不產出。
    except (OSError, ValueError) as e:
        print(f"[performance_report] equity history append failed: {e}", file=sys.stderr)
        return False
    _compact_history()
    return True


def _compact_history():
    try:
        if os.path.getsize(HISTORY_PATH) <= HISTORY_COMPACT_BYTES:
            return
        with open(HISTORY_PATH, encoding="utf-8", errors="replace") as f:
            tail = f.readlines()[-HISTORY_MAX_LINES:]
        tmp = HISTORY_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.writelines(tail)
        os.replace(tmp, HISTORY_PATH)  # 原子：報告產出中途也可能在讀這個檔
    except OSError as e:
        print(f"[performance_report] equity history compaction failed: {e}",
              file=sys.stderr)


def read_history():
    """[{t, venues}]，依 t 排序。壞掉的行跳過——一行寫壞不該讓整段歷史消失。"""
    try:
        with open(HISTORY_PATH, encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
    except OSError:
        return []
    out = []
    for line in lines:
        try:
            row = json.loads(line)
        except (ValueError, RecursionError):  # 深巢的一行同樣只跳過那一行，見 _read_json
            continue
        if isinstance(row, dict) and isinstance(row.get("t"), int) \
                and isinstance(row.get("venues"), dict):
            out.append(row)
    out.sort(key=lambda r: r["t"])
    return out


# ── 序列 ──────────────────────────────────────────────────────────────────────


def equity_series(history):
    """(points [[t, total]], currency)。混幣別回 ([], None)：見模組 docstring。

    「沒回報幣別」(currency=None)與任何已知幣別同時出現**也算混幣別**。不知道那一腿
    是什麼幣，就沒有「同幣別」的根據可以把它加進總和——那等於偷偷假設了一個匯率，
    正是這個模組拒絕做的事。整台機器都沒回報幣別(集合 = {None})則照舊出圖,
    只是不標單位:那時候沒有任何一腿被當成別的幣。"""
    currencies = set()
    for row in history:
        for v in row["venues"].values():
            c = v.get("currency")
            # 非字串折成 None:currency 一路走到 `currency[:16]`,而歷史檔是磁碟產物
            currencies.add(c if isinstance(c, str) else None)
    if len(currencies) > 1:
        return [], None
    currency = next(iter(currencies), None)
    points = []
    for row in history:
        values = [v.get("equity") for v in row["venues"].values() if _finite(v.get("equity"))]
        if values:
            points.append([int(row["t"]), round(float(sum(values)), 2)])
    return points, currency


def _thin(points, limit=_MAX_POINTS):
    """等距抽稀，永遠保留最後一點（最新權益是報告的主角）。"""
    if len(points) <= limit:
        return points
    stride = len(points) // limit + 1
    out = points[::stride]
    if out[-1] != points[-1]:
        out.append(points[-1])
    return out


def _utc_date(ts):
    return datetime.fromtimestamp(ts, timezone.utc).date()


def _day_start(day):
    return int(datetime(day.year, day.month, day.day, tzinfo=timezone.utc).timestamp())


def daily_closes(points):
    """[(date, close)] — 每個 UTC 日的最後一個樣本。"""
    closes = {}
    for ts, value in points:
        closes[_utc_date(ts)] = value
    return sorted(closes.items())


def _returns(closes):
    """[(date, 報酬率)] — 相鄰兩個日收盤。前一日為 0 就跳過（除以零沒有意義）。"""
    out = []
    for (_, prev), (day, cur) in zip(closes, closes[1:]):
        if prev:
            out.append((day, cur / prev - 1.0))
    return out


def drawdown_points(points):
    """([[t, 負值百分比]], maxdd) — 由樣本序列的滾動高點算。"""
    peak = None
    out = []
    worst = {"value": 0.0, "from": points[0][0] if points else 0, "to": 0}
    peak_ts = points[0][0] if points else 0
    for ts, value in points:
        if peak is None or value > peak:
            peak, peak_ts = value, ts
        dd = (value / peak - 1.0) * 100 if peak else 0.0
        out.append([ts, round(dd, 4)])
        if dd < worst["value"]:
            worst = {"value": round(dd, 4), "from": peak_ts, "to": ts}
    return out, (worst if worst["value"] < 0 else None)


def monthly_returns(closes):
    """{(year, month): 百分比}。基準取該月之前最後一個收盤；沒有（整段歷史的第一
    個月）就用該月自己的第一個收盤，那個月因此是部分月份，由 caption 講明。"""
    if not closes:
        return {}
    months = {}
    for day, value in closes:
        months.setdefault((day.year, day.month), []).append((day, value))
    out = {}
    ordered = sorted(months)
    prev_close = None
    for key in ordered:
        series = months[key]
        base = prev_close if prev_close is not None else series[0][1]
        end = series[-1][1]
        if base:
            out[key] = round((end / base - 1.0) * 100, 2)
        prev_close = end
    return out


# ── 顯示格式（契約 §2：展示欄位一律已格式化字串）────────────────────────────


def _fmt_amount(value):
    return f"{value:,.2f}"


def _fmt_pct(value, signed=True):
    return f"{value:+.2f}%" if signed else f"{value:.2f}%"


def _tone(value):
    return "pos" if value > 0 else ("neg" if value < 0 else "neutral")


def _fmt_time(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%m/%d %H:%M")


def _fmt_day(day):
    return day.strftime("%m/%d")


# ── 磁碟產物 ──────────────────────────────────────────────────────────────────


def strategy_rows(deadline=None):
    """分策略一表。訊號來自 state.json(實際),Sharpe/MDD 來自 stats.json
    (回測)——兩種東西擺在同一列，所以欄名與 caption 都要標明後者是回測。"""
    root = os.path.join(WORKSPACE, "strategies")
    try:
        names = sorted(os.listdir(root))
    except OSError:
        return []
    rows = []
    for name in names:
        if len(rows) >= _MAX_STRATEGY_ROWS or (deadline and time.time() > deadline):
            break
        state_path = os.path.join(root, name, "state.json")
        state = _read_json(state_path)
        if not isinstance(state, dict):
            continue
        position = state.get("position")
        updated = _mtime(state_path)
        stats = _read_json(os.path.join(root, name, "stats.json"))
        sharpe = mdd = None
        if isinstance(stats, dict):
            sharpe = stats.get("Sharpe Ratio")
            mdd = stats.get("Max Drawdown [%]")
        # 非有限數走 None(表格 cell 渲染成 em-dash):一支回測沒有交易的策略,
        # stats.json 的 Sharpe 就是 NaN,而 f"{nan:.2f}" 是字串 "nan"——一格看起來
        # 像數字的假數字比一格空白難發現得多。
        rows.append({
            "name": name[:200],
            "symbol": str(state.get("symbol") or "")[:200] or None,
            "signal": f"{float(position):+.4g}" if _finite(position) else None,
            "updated": _fmt_time(updated) if updated else None,
            "sharpe": f"{float(sharpe):.2f}" if _finite(sharpe) else None,
            "mdd": _fmt_pct(float(mdd), signed=False) if _finite(mdd) else None,
        })
    return rows


_STRATEGY_COLUMNS = [
    {"key": "name", "label": "策略", "align": "left"},
    {"key": "symbol", "label": "標的", "align": "left"},
    {"key": "signal", "label": "訊號", "align": "right"},
    {"key": "updated", "label": "訊號更新", "align": "right"},
    {"key": "sharpe", "label": "回測 Sharpe", "align": "right"},
    {"key": "mdd", "label": "回測 MDD", "align": "right"},
]


def exposure_rows():
    """(rows, 名目敞口總額) — 交易所實際部位 vs 對帳目標。

    實際部位取 account.json(每 1–2 分鐘更新，而且 _norm_positions 已經把各家
    的形狀正規化成 {symbol: {side, size}},size 是帳戶幣計價的名目金額)；目標取
    last_reconcile.json，那是 reconcile 當下算出來的應有部位。兩邊都缺就沒有敞口
    可談，回空。"""
    account = _read_json(os.path.join(WORKSPACE, "manager", "account.json"), {}) or {}
    reconcile = _read_json(os.path.join(WORKSPACE, "manager", "last_reconcile.json"), {}) or {}
    targets = reconcile.get("target") if isinstance(reconcile, dict) else None
    targets = targets if isinstance(targets, dict) else {}

    actual = {}
    for venue_id, entry in (account.get("venues") or {}).items():
        if not isinstance(entry, dict) or not entry.get("ok"):
            continue
        for symbol, pos in (entry.get("positions") or {}).items():
            if not isinstance(pos, dict):
                continue
            size = pos.get("size")
            if not _finite(size) or not size:
                continue
            actual[str(symbol)] = {"venue": str(venue_id), "side": pos.get("side"),
                                   "size": float(size)}

    rows, gross = [], 0.0
    for symbol in sorted(set(actual) | set(targets)):
        act = actual.get(symbol)
        tgt = targets.get(symbol) if isinstance(targets.get(symbol), dict) else None
        tgt_size = tgt.get("size") if tgt else None
        act_size = act["size"] if act else None
        if act_size:
            gross += abs(act_size)
        # side 來自交易所模組，型別不保證是字串——表格 cell 只收字串/數字/null
        side = (act or tgt or {}).get("side")
        rows.append({
            "symbol": symbol[:200],
            "venue": act["venue"][:200] if act else None,
            "side": str(side)[:200] if side else None,
            "actual": _fmt_amount(act_size) if act_size is not None else None,
            "target": _fmt_amount(float(tgt_size)) if _finite(tgt_size) else None,
        })
    return rows[:500], gross


_EXPOSURE_COLUMNS = [
    {"key": "symbol", "label": "標的", "align": "left"},
    {"key": "venue", "label": "交易所", "align": "left"},
    {"key": "side", "label": "方向", "align": "left"},
    {"key": "actual", "label": "實際部位", "align": "right"},
    {"key": "target", "label": "對帳目標", "align": "right"},
]


def _machine_label():
    node = platform.node() or ""
    return node[:80] or None


# ── 報告 ──────────────────────────────────────────────────────────────────────


def _meta_block(title, report_type, now, period, equity, currency):
    block = {"type": "meta", "title": title, "report_type": report_type,
             "generated_at": int(now), "origin": "scheduled"}
    if period:
        block["period"] = period
    if equity is not None and currency:
        block["account"] = {"aum": round(equity, 2), "currency": currency[:16]}
    machine = _machine_label()
    if machine:
        block["machine"] = machine
    return block


def _kpi_block(items):
    return {"type": "kpi_row", "title": "重點數字", "items": items[:6]} if items else None


def _equity_kpi(equity, currency):
    return {"label": "帳戶權益", "value": _fmt_amount(equity), "tone": "neutral",
            "unit": currency[:16]} if currency else {
        "label": "帳戶權益", "value": _fmt_amount(equity), "tone": "neutral"}


def _window(points, start_ts, end_ts):
    return [p for p in points if start_ts <= p[0] < end_ts]


def build_daily(day, history, now, deadline=None):
    """day = 被報告的那個 UTC 日（通常是昨天）。資料不夠就少幾個 block。

    `deadline` = 掃策略目錄的**絕對**截止時刻,由 main() 算一次分給日報與週報共用
    (理由見 _BUDGET_S)。單獨呼叫時退回自己的一份預算。"""
    deadline = time.time() + _BUDGET_S if deadline is None else deadline
    points, currency = equity_series(history)
    start_ts, end_ts = _day_start(day), _day_start(day + timedelta(days=1))
    window = _window(points, start_ts, end_ts)
    latest = (window or points)[-1][1] if (window or points) else None

    blocks = [_meta_block(
        f"績效日報 {_fmt_day(day)}", "績效日報", now,
        {"from": f"{_fmt_day(day)} 00:00 UTC", "to": f"{_fmt_day(day)} 24:00 UTC"},
        latest, currency)]

    items = []
    if latest is not None:
        items.append(_equity_kpi(latest, currency))
    if len(window) >= 2 and window[0][1]:
        change = window[-1][1] - window[0][1]
        pct = change / window[0][1] * 100
        items.append({"label": "當日變化", "value": _fmt_pct(pct), "tone": _tone(pct)})
        items.append({"label": "當日損益", "value": f"{change:+,.2f}",
                      "tone": _tone(change),
                      **({"unit": currency[:16]} if currency else {})})

    exposure, gross = exposure_rows()
    if gross:
        items.append({"label": "名目敞口", "value": _fmt_amount(gross), "tone": "neutral",
                      **({"unit": currency[:16]} if currency else {})})
        if latest:
            items.append({"label": "敞口 / 權益", "value": _fmt_pct(gross / latest * 100, False),
                          "tone": "neutral"})
    strategies = strategy_rows(deadline=deadline)
    if strategies:
        items.append({"label": "策略數", "value": str(len(strategies)), "tone": "neutral"})

    kpi = _kpi_block(items)
    if kpi:
        blocks.append(kpi)
    if len(window) >= 2:
        blocks.append({
            "type": "line_chart", "title": "當日權益",
            "series": [{"name": "帳戶權益", "role": "primary", "points": _thin(window)}],
            "caption": f"每小時取樣，當日 {len(window)} 點；來源為各交易所回報的權益讀數。",
        })
    if exposure:
        blocks.append({"type": "table", "title": "敞口", "columns": _EXPOSURE_COLUMNS,
                       "rows": exposure,
                       "caption": "實際部位取自交易所讀數，對帳目標取自最近一次 reconcile。"})
    if strategies:
        blocks.append({"type": "table", "title": "分策略", "columns": _STRATEGY_COLUMNS,
                       "rows": strategies,
                       "caption": "訊號與更新時間是實際狀態；Sharpe 與 MDD 來自各策略 "
                                  "stats.json 的回測結果，不是這段期間的實際績效。"})
    if len(blocks) == 1:
        return None  # 只剩表頭 = 這台機器今天沒有任何可講的事
    return {"schema_version": "1.1", "id": f"daily-{day.isoformat()}",
            "type": "performance", "title": f"績效日報 {_fmt_day(day)}",
            "created_at": int(now), "blocks": blocks}


def build_weekly(last_day, history, now, deadline=None):
    """last_day = 被報告那一週的最後一個 UTC 日（星期日）。`deadline` 同 build_daily。"""
    deadline = time.time() + _BUDGET_S if deadline is None else deadline
    first_day = last_day - timedelta(days=6)
    points, currency = equity_series(history)
    start_ts, end_ts = _day_start(first_day), _day_start(last_day + timedelta(days=1))
    window = _window(points, start_ts, end_ts)
    latest = (window or points)[-1][1] if (window or points) else None
    closes = daily_closes(points)
    rets = _returns(closes)

    title = f"績效週報 {_fmt_day(first_day)}–{_fmt_day(last_day)}"
    blocks = [_meta_block(title, "績效週報", now,
                          {"from": _fmt_day(first_day), "to": _fmt_day(last_day)},
                          latest, currency)]

    items = []
    if latest is not None:
        items.append(_equity_kpi(latest, currency))
    if len(window) >= 2 and window[0][1]:
        pct = (window[-1][1] / window[0][1] - 1.0) * 100
        items.append({"label": "本週報酬", "value": _fmt_pct(pct), "tone": _tone(pct)})
    dd_points, maxdd = (drawdown_points(points) if points else ([], None))
    if maxdd:
        items.append({"label": "期間最大回撤", "value": _fmt_pct(maxdd["value"]),
                      "tone": "neg"})
    if len(rets) >= _MIN_RETURN_DAYS:
        mean = sum(r for _, r in rets) / len(rets)
        var = sum((r - mean) ** 2 for _, r in rets) / (len(rets) - 1)
        vol = var ** 0.5
        items.append({"label": "年化波動", "value": _fmt_pct(vol * (365 ** 0.5) * 100, False),
                      "tone": "neutral"})
        items.append({"label": "樣本天數", "value": str(len(closes)), "tone": "neutral"})
    kpi = _kpi_block(items)
    if kpi:
        blocks.append(kpi)

    if len(window) >= 2:
        blocks.append({
            "type": "line_chart", "title": "本週權益",
            "series": [{"name": "帳戶權益", "role": "primary", "points": _thin(window)}],
            "caption": f"每小時取樣，本週 {len(window)} 點。",
        })
    if len(points) >= 2 and len(dd_points) >= 2:
        block = {"type": "drawdown", "title": "回撤（全部樣本期間）",
                 "points": _thin(dd_points),
                 "caption": "以本機權益樣本的滾動高點計算，起點為開始取樣之日，"
                            "不代表帳戶成立以來的完整歷史。"}
        if maxdd:
            block["maxdd"] = maxdd
        blocks.append(block)

    months = monthly_returns(closes)
    if len(months) >= _MIN_HEATMAP_MONTHS:
        years = sorted({y for y, _ in months})[-40:]
        cols = [f"{m:02d}" for m in range(1, 13)]
        blocks.append({
            "type": "heatmap", "variant": "calendar", "title": "月報酬",
            "rows": [str(y) for y in years], "cols": cols,
            "values": [[months.get((y, m)) for m in range(1, 13)] for y in years],
            "caption": "由每日最後一筆權益樣本計算；第一個月為部分月份，"
                       "無樣本的月份留白。",
        })
    if len(rets) >= _MIN_RETURN_DAYS:
        mean = sum(r for _, r in rets) / len(rets)
        var = sum((r - mean) ** 2 for _, r in rets) / (len(rets) - 1)
        vol = var ** 0.5
        # format 是漲跌語意色的閘門(契約 §3):不標的一律中性,所以帶正負號的損益項
        # 要明講 percent/number,不然年化報酬與最大回撤會渲染成中性色。
        metrics = [
            {"label": "年化報酬", "value": _fmt_pct(mean * 365 * 100),
             "format": "percent"},
            {"label": "年化波動", "value": _fmt_pct(vol * (365 ** 0.5) * 100, False),
             "format": "percent"},
            {"label": "Sharpe", "value": f"{(mean / vol * (365 ** 0.5)):.2f}" if vol else "—",
             "format": "number"},
            {"label": "最大回撤",
             "value": _fmt_pct(maxdd["value"]) if maxdd else "0.00%",
             "format": "percent"},
            {"label": "樣本天數", "value": str(len(closes))},
        ]
        blocks.append({"type": "metric_table", "title": "風險指標", "items": metrics,
                       "caption": "年化以 365 日計、波動用樣本標準差，與工作頁策略指標"
                                  "同一口徑；樣本天數不足時這些數字只是參考。"})

    exposure, _ = exposure_rows()
    if exposure:
        blocks.append({"type": "table", "title": "敞口", "columns": _EXPOSURE_COLUMNS,
                       "rows": exposure,
                       "caption": "實際部位取自交易所讀數，對帳目標取自最近一次 reconcile。"})
    strategies = strategy_rows(deadline=deadline)
    if strategies:
        blocks.append({"type": "table", "title": "分策略", "columns": _STRATEGY_COLUMNS,
                       "rows": strategies,
                       "caption": "訊號與更新時間是實際狀態；Sharpe 與 MDD 來自各策略 "
                                  "stats.json 的回測結果，不是這段期間的實際績效。"})
    if len(blocks) == 1:
        return None
    return {"schema_version": "1.1", "id": f"wk-{last_day.isoformat()}",
            "type": "performance", "title": title, "created_at": int(now),
            "blocks": blocks}


# ── 排程 ──────────────────────────────────────────────────────────────────────


def due(now):
    """(daily_day, weekly_last_day) — 這一刻該涵蓋的期間，兩者都只看已經結束的日子。

    UTC 換日：機器跑 UTC，而且平台的通知推播讓 00:xx UTC 的日報落在台北早上八點多。
    週報鎖定「最近一個已經過完的星期日」而不是「今天是不是星期一」——機器星期一
    關著、星期二才開機時，補得回同一份週報，而不是整週沒有。"""
    today = _utc_date(now)
    return today - timedelta(days=1), today - timedelta(days=today.weekday() + 1)


def main():
    now = int(time.time())
    # process 起點算一次，日報 + 週報 + 取樣全部共用(見 _BUDGET_S)
    deadline = time.time() + _BUDGET_S
    if append_sample(sample_equity(now)):
        print("[performance_report] equity sample recorded", file=sys.stderr)

    state = _read_json(STATE_PATH, {})
    if not isinstance(state, dict):
        state = {}
    history = read_history()
    daily_day, weekly_day = due(now)
    changed = False
    for key, report_id, build in (
        ("daily", f"daily-{daily_day.isoformat()}",
         lambda: build_daily(daily_day, history, now, deadline)),
        ("weekly", f"wk-{weekly_day.isoformat()}",
         lambda: build_weekly(weekly_day, history, now, deadline)),
    ):
        if state.get(key) == report_id:
            continue
        doc = build()
        # 產出與「沒東西可講」都記進 state：跳過的判斷是看整段歷史，不是某一次讀取
        # 失敗，所以不必每小時重試一次，也不會每小時噴一份空報告。
        state[key] = report_id
        changed = True
        if doc is None:
            print(f"[performance_report] {report_id}: no data to report, skipped",
                  file=sys.stderr)
            continue
        try:
            path = report_uploader.drop(doc)
        except (OSError, ValueError) as e:
            print(f"[performance_report] {report_id} could not be dropped: {e}",
                  file=sys.stderr)
            state.pop(key, None)  # 沒落地就不算做過，下一輪重試
            continue
        print(f"[performance_report] wrote {path} ({len(doc['blocks'])} blocks)",
              file=sys.stderr)
    if changed:
        _save_state(state)


if __name__ == "__main__":
    main()
