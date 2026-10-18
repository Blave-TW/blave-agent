# 台股資料 — Taiwan Stock Data

> 台股資料（三大法人、融資融券、股權分級、財報、月營收、分點買賣超）由 [FinMind](https://finmindtrade.com) 提供；
> **Daily bars (`fetch_twstock_price` / `fetch_twstock_price_adj`, and their `*_batch` twins on a desktop without Blave access) are the Taiwan Stock Exchange's and Taipei Exchange's own numbers and need no Blave key** — on the desktop from Blave's daily copy of the exchanges' files (Blave CDN), else straight from the exchanges (next section; anything citing them carries the source line);
> 股票清單/基本資料（industry_code、listing_date）來自 TWSE/TPEx 官方公司資料，非 FinMind。

**⚠️ 一律優先用下面這些 `lib/data.py` 函式(不只是寫策略時,單純聊天問答也一樣),函式裡沒有的資料才去外面找。** `lib/data.py` 已經做好新鮮度、fallback、cache,手寫腳本沒有這層保護,拿到舊資料或直接崩潰都有可能。若 `lib/data.py` 的呼叫本身失敗,回報失敗,不要改用手寫腳本、更不要拿崩潰前的部分輸出當答案。

## 股票池（Universe）建立

用 `fetch_twstock_list(headers)`（見 `lib/data.py`）—— 回傳 DataFrame，index 為 `stock_id`，
欄位 `name`、`close`、`industry_code`、`listing_date`（`YYYY-MM-DD`）。涵蓋上市 + 上櫃全市場
（含 ETF，`industry_code`/`listing_date` 為 `None`）。基本資料一天更新一次，函式內建 1 天快取。

```python
df = fetch_twstock_list(headers)

# 全部普通股（排除 ETF / 無產業別的證券）
universe = df[df['industry_code'].notna()].index.tolist()

# 依產業別篩選（例如半導體 '24' + 電腦及周邊 '25'）
tech = df[df['industry_code'].isin(['24', '25'])].index.tolist()
```

`industry_code` 是 TWSE/TPEx 原始數字代碼（passthrough，不是解碼過的名稱）。常用代碼：
`15` 航運業、`17` 金融保險業、`22` 生技醫療業、`24` 半導體業、`25` 電腦及週邊設備業、
`26` 光電業、`27` 通信網路業、`28` 電子零組件業、`29` 電子通路業、`30` 資訊服務業、
`31` 其他電子業. Full 35-code map (listed and OTC share the codes): `TWSE_INDUSTRY_NAMES` / `twstock_industry_name(code)` in `lib/data.py`.

**⚠️ Universe 抽樣規則 — 必須分散產業**

台股代碼按產業群組排列（1xxx 水泥/食品、2xxx 紡織/化工/電子、9xxx 其他），直接取前 N 支會集中在少數產業。**回測 universe 必須依產業抽樣**，不得直接用 `[:100]` 截斷：

```python
from lib.data import fetch_twstock_list
from lib.strategy import twstock_universe_by_sector

df = fetch_twstock_list(headers)
universe = twstock_universe_by_sector(df, total=100)                      # every industry, ETFs out
tech = twstock_universe_by_sector(df, total=60, industries=['24', '25'])  # the user named industries
```

Equal draw per industry, the shortfall topped up at random; a fixed `seed` (default 42) gives the same ids from the same list. Run it once in a probe and paste the printed ids into `UNIVERSE` — the universe is a fixed list at backtest start, never drawn at import.

單支股票基本資料查詢用 `fetch_twstock_info(stock_id, headers)` —— 回傳
`{stock_id, name, close, industry_code, listing_date}` 或 `None`（查無此股）；內部直接查
`fetch_twstock_list` 的快取結果，不另外打 API。

---

## 台股日K — 原始 vs 還原價

| 函式 | 來源 | 何時使用 |
|---|---|---|
| `fetch_twstock_price(sid, start, end, hdrs)` | Blave CDN (TWSE `MI_INDEX` / TPEx `dailyQuotes`), else TWSE `STOCK_DAY` / TPEx `tradingStock` | **Charts, "how has it moved"** — actual market prices, what the user sees in a broker app; columns Open/High/Low/Close/Volume (shares; exact from the CDN, TPEx rounded to 1,000 on the `tradingStock` fallback) |
| `fetch_twstock_price_adj(sid, start, end, hdrs)` | same + the exchanges' price-continuity tables: 除權息 (TWSE `TWT49U` / TPEx `exDailyQ`), 減資 (`TWTAUU` / `revivt`), 變更面額 (`TWTB8U` / `pvChgRslt`), ETF 分割・反分割 (`TWTCAU` / `etfSplitRslt`, `etfRvsRslt`) | **Backtests** — backward-adjusted, returns comparable across those dates (factor = the table's 前收盤價 ÷ 參考價, from the event date on; the Blave adjusted series uses the same exchange events, so the two agree except on bars no exchange event reaches (mostly pre-2010 and 興櫃-era history, where Blave falls back to its dividend formula) and on an event day before 17:55, when Blave already carries the morning-listed event); columns Open/Close |

> 除權息後原始價格會向下跳空，還原價則平滑消除跳空，適合計算指標與回報。  
> 用戶問「台積電最近走勢怎樣」→ `fetch_twstock_price`；要跑 SMA 回測 → `fetch_twstock_price_adj`。

**Adjusted level.** On the CDN the factors accumulate from the stock's first CDN day (2010-01-04 at the earliest) whatever `start` is, so two runs with different starts get the same adjusted price on every day they share. The Blave endpoint accumulates from before 2010 (and through 興櫃 days the CDN does not carry), so its adjusted prices differ from the CDN's by one constant ratio per stock (2330 ≈ 0.77, 2317 ≈ 0.48, CDN ÷ Blave): the same returns, a different level. Never carry an adjusted price level from one source to another (a stop price, a fixed price threshold) — work in returns or in the unadjusted price. An ex-date on a day the stock did not trade (a halt) takes effect on its next traded day on both sources. The exchange fallback path (no CDN) still accumulates from the window start.

**Free, no key.** On the desktop (`BLAVE_AGENT_LOCAL=1`) the default chain is: **Blave CDN** → the Blave endpoint (a desktop without data access falls straight through, no wait) → the exchanges month by month → a third-party free source (last resort). The CDN is Blave's daily copy of the exchanges' whole-market closing files (TWSE `MI_INDEX`, TPEx `dailyQuotes`) plus their price-continuity tables, published at `download.blave.org/data/twstock/daily/v1/` around 17:55 Taipei once the exchanges' 17:30 final version is out, from 2010-01-04 on (delisted stocks included): one small file per stock, so five cold stocks take seconds, not the exchange path's ~10 minutes per listed stock. Between 17:35 and the CDN publication (or while the CDN is late) a call that needs today's bar takes just the missing final days from the exchange — never a bar before its 17:35 final. `*_batch` without Blave access (a 403 / no data access) is served from the CDN too — per stock up to 40 ids (late days filled from the exchange the same way), from the whole-market year files above that — while with access `*_batch` stays on the Blave endpoint, unchanged. A CDN-served frame (single or batch) that still stops before the latest final carries `df.attrs['asof']` (the day it is complete through) and a ⚠️ line; in a live tick it raises `FeedNotPublished` instead, so the strategy waits rather than trading on the older day. Ids the CDN chain hands to the key-free fallback stop at the latest final too (no 14:00 / 15:30 bar). Before 2010-01-04, an id the CDN does not list, or a CDN that is unreachable or switched off (its manifest says `enabled: false`) goes to the next source with a ⚠️ line. The exchange path: past months fetched once and cached, the current month re-fetched only after the next 17:35 final; TWSE one request per 3 s, TPEx one per second; TWSE has nothing before 2010-01-04; TPEx volume rounded to the thousand; a stock that moved from TPEx to TWSE has only its post-transfer months there (the CDN has both). **Before estimating a long run, check the source:** a cold exchange-path backfill is ~36 s per listed stock-year — only estimate that way when the CDN is not serving (a ⚠️ line names the fallback); if it exceeds ~25 minutes, tell the user how long and offer a shorter first run. **Any report or reply citing these numbers carries 「資料來源:臺灣證券交易所、證券櫃檯買賣中心(政府資料開放授權)」** (en: `Source: Taiwan Stock Exchange, Taipei Exchange (Open Government Data License)`), whichever of the exchange sources answered — CDN or exchange path, the data is the exchanges' and naming them is the licence condition. **Cloud machines use Blave data**, as before; `BLAVE_TWSTOCK_DAILY_SOURCE=cdn|public|blave` forces a chain either way (`public` = the old exchange → third-party source → Blave order). `df.attrs['source']` names the supplier (`TWSE` / `TPEx` / `Blave`, or the third-party source's own tag on the last-resort path; `df.attrs['via'] == 'Blave CDN'` when the CDN served it). Today's bar counts from 17:35 Taipei (`FEED_TIMING['twstock_price']`: TWSE 每日收盤行情 versions 14:00 / 15:30 / 17:30, third + 5 min).

---

## Real-Time Quote (即時報價)

| Function | Endpoint | When to use |
|---|---|---|
| `fetch_twstock_quote(sid, headers)` | `/twstock/quote/<sid>` | Single stock — current price check before a trade decision, "what's it trading at right now" |
| `fetch_twstock_quote_batch(stock_ids, headers)` | `/twstock/quote` | Multiple stocks in one call (max 50) — checking several holdings at once |

Both return a plain **dict** (or `{stock_id: dict}` for batch), not a DataFrame — there is
no date range to index on, only the current snapshot. Refreshes approximately every 10
seconds during market and post-market sessions; there is no history endpoint variant.

```python
quote = fetch_twstock_quote('2330', headers)
# {'open': 2415.0, 'high': 2465.0, 'low': 2415.0, 'close': 2445.0,
#  'change_price': -20.0, 'change_rate': -0.81, 'average_price': 2432.58,
#  'volume': 4245, 'total_volume': 26403, 'amount': 10379025000, 'total_amount': 64227410000,
#  'yesterday_volume': 27390, 'buy_price': 2445.0, 'buy_volume': 17,
#  'sell_price': 2450.0, 'sell_volume': 11, 'volume_ratio': 0.96,
#  'quote_time': '2026-07-03 14:30:00', 'stock_id': '2330', 'tick_type': 2}

quotes = fetch_twstock_quote_batch(['2330', '2317'], headers)
# {'2330': {...}, '2317': {...}}
```

**Notes:**
- `buy_price`/`sell_price` are best bid/ask, not last-traded price — use `close` for last price.
- `tick_type`: `0` = indeterminate, `1` = sell-initiated (賣盤成交), `2` = buy-initiated (買盤成交).
- `quote_time` is a full timestamp (`YYYY-MM-DD HH:MM:SS`), unlike every other twstock
  function's `date`, which is a bare calendar day — don't treat it as a date-only field.
- No local caching by design — the server enforces a 10s Redis TTL, so calling this
  repeatedly in a loop is fine and will pick up fresh data every ~10s; do not add your own
  parquet/file cache on top, it would defeat the purpose.
- Do not use for backtesting — no history exists. Use `fetch_twstock_price`/`fetch_twstock_price_adj` instead.

---

## Minute-Line OHLCV（現股分線）— preferred

Use `fetch_twstock_ohlcv` / `fetch_twstock_ohlcv_symbols` in `lib/data.py` — do not
hand-roll requests (the lib layer adds retry, chunking, monthly parquet cache, and
OHLC sanity checks).

- `fetch_twstock_ohlcv(stock_id, schema, headers, start=None, end=None, adjust=False)` →
  DataFrame with Open/High/Low/Close/Volume, UTC index (Asia/Taipei for `1d`).
  `headers` is the third argument here, unlike the other kline fetchers; the usual
  order `(stock_id, schema, start, end, headers)` is accepted too.
  `schema`: `'1m'`/`'5m'`/`'15m'`/`'30m'`/`'60m'`/`'1d'`. **Volume is in lots (張),
  not shares.** Bars carry minute-START labels; the 13:30 Taipei bar is the closing
  auction. History from 2019-01. `adjust=True` returns forward-adjusted (後復權)
  OHLC — use for backtests spanning ex-dividend dates; same factor pipeline as
  `fetch_twstock_price_adj`, volume unchanged; the server returns 503 (fail-loud)
  if adjustment factors are unavailable, never silently raw prices.
- `fetch_twstock_ohlcv_symbols(headers)` → list of stock_ids that already have
  minute-line data server-side.

**Coverage.** The whole market is backfilled server-side from 2019-01; requesting an
earlier `start` is silently clamped to 2019-01-01. Ongoing tracking per stock:
intraday real-time bars + a daily official correction after market close. Only very
newly listed stocks are demand-driven: seeded on their first query and queued for
deep backfill, so that query may return only recent data — full history usually
lands by the next day. Empty past months are cached locally with a 24-hour TTL
(not permanently), so the cache self-heals once the server has the data.

```python
df = fetch_twstock_ohlcv('2330', '5m', headers, start='2025-01-01', end='2025-06-30')
```

---

## 台股分K（1分鐘 OHLCV）— legacy endpoint

> Superseded for most uses by the minute-line section above (`fetch_twstock_ohlcv`
> supports 1m–60m/1d resampling, caching, and retry). Kept for reference only.

```python
import requests

def fetch_twstock_kbar(stock_id: str, start: str, end: str, headers: dict) -> pd.DataFrame:
    """最多 31 天，資料從 2019-01-01 起（與 minute/ohlcv 同一份資料）。欄位：date, minute, stock_id, open, high, low, close, volume"""
    r = requests.get(
        f"https://api.blave.org/studio/market/twstock/kbar/{stock_id}",
        params={"start": start, "end": end},
        headers=headers,
        timeout=60,
    )
    r.raise_for_status()
    data = r.json().get("data", [])
    if not data:
        return pd.DataFrame()
    df = pd.DataFrame(data)
    df["datetime"] = pd.to_datetime(df["date"] + " " + df["minute"])
    return df.set_index("datetime").sort_index()
```

**注意事項：**
- `minute` 格式為 `HH:MM:SS`（例如 `09:00:00`），為該分鐘 bar 的起點標籤
- 一天最多 271 筆（09:00–13:30，含 13:30 收盤撮合那根）；冷門股只有有成交的分鐘才有列
- 非交易日（週末、假日）自動略過，不返回資料
- 超過 31 天會回 400 錯誤；長期回測需分段呼叫
- 資料與 `minute/ohlcv` 同一份（伺服器本地分線庫，不打上游）：涵蓋股票以 `/studio/market/twstock/minute/ohlcv/symbols` 為準，不在名單內或已下市的代碼回 400
- 當日（盤中）資料為暫定值，16:10 後才換成官方分 K；回測請用昨日以前的資料

---

## 台股新聞

每天多篇，`date` 為 datetime 字串（含時間）。最多 31 天。

```python
def fetch_twstock_news(stock_id: str, start: str, end: str, headers: dict) -> pd.DataFrame:
    """欄位：date（datetime string）, title, source, link"""
    r = requests.get(
        f"https://api.blave.org/studio/market/twstock/news/{stock_id}",
        params={"start": start, "end": end},
        headers=headers,
        timeout=60,
    )
    r.raise_for_status()
    data = r.json().get("data", [])
    return pd.DataFrame(data) if data else pd.DataFrame()
```

---

## 市值

```python
def fetch_twstock_market_value(stock_id: str, start: str, end: str, headers: dict) -> pd.DataFrame:
    """欄位：date, market_value（元，NTD）。資料從 2004-01-01 起。"""
    r = requests.get(
        f"https://api.blave.org/studio/market/twstock/market_value/{stock_id}",
        params={"start": start, "end": end},
        headers=headers,
        timeout=60,
    )
    r.raise_for_status()
    data = r.json().get("data", [])
    return pd.DataFrame(data).set_index("date") if data else pd.DataFrame()
```

### Whole-market market-cap ranking (全市場市值排名)

`fetch_twstock_market_value_all(headers, top=None)` in `lib/data.py` returns the latest
market-cap ranking of the whole market in ONE call — use it whenever a question or a
screen is about market cap (前十大權值股, top-N pool by market cap). Never rebuild the
ranking from per-stock shares × price (that is ~2,000 calls and minutes of waiting).

```python
from lib.data import fetch_twstock_market_value_all

top10 = fetch_twstock_market_value_all(hdrs, top=10)
# columns: rank (1-based, market_value desc), stock_id, name, market_value (NTD 元, int),
#          market ("TWSE" 上市 / "TPEx" 上櫃), is_etf (bool)
top10.attrs["date"]                     # as-of publication date, 'YYYY-MM-DD'
top10.attrs["twse_ex_etf_market_value"] # 上市 ex-ETF market-cap total, NTD 元 int

# Index weight of a 上市 non-ETF stock (the denominator is whole-market even with top=10)
tsmc = top10.iloc[0]                    # 2330 — market "TWSE", not an ETF
share = tsmc["market_value"] / top10.attrs["twse_ex_etf_market_value"]

mv = fetch_twstock_market_value_all(hdrs)          # all ~2,400 rows
pool = mv[~mv["is_etf"]].head(300)["stock_id"].tolist()   # ETF-free market-cap top-300 universe
tpex_only = mv[mv["market"] == "TPEx"]                    # board filter, exact like is_etf
```

Notes:
- Universe = TWSE listed + TPEx OTC + ETFs; 興櫃 (emerging) excluded, ETNs have no data.
- **`is_etf` is the ETF flag** — filter with `mv[~mv["is_etf"]]`. Never by `stock_id` prefix
  (`"00"` is a market convention rather than a contract, and it misses REITs like `01010T`) and
  never by fetching a classification yourself: `is_etf` already IS that classification (FinMind
  `industry_category`) and is the same criterion the denominator uses, so a filtered pool and
  the denominator can never disagree. `is_etf` False means "not in the ETF set", **not**
  "confirmed not an ETF": a security FinMind publishes no category for (REIT `01010T`) is False
  and stays inside the denominator. `market` is a listing-board tag, not an ETF flag.
- **`rank` and `attrs["twse_ex_etf_market_value"]` are different universes.** `rank` is
  whole-market (上市 + 上櫃, ETFs included). The denominator covers 上市 only and excludes ETFs
  (FinMind `industry_category` in `{ETF, 上櫃ETF, 上櫃指數股票型基金(ETF)}`); REITs and
  preferred shares (特別股) are not excluded from it. So the ratio is an index weight
  (權值比重) only for a row whose `market` is `"TWSE"` and which is not an ETF — a TPEx or ETF
  row over this denominator is not a weight. Never describe a row's `rank` as a rank within
  that ex-ETF total.
- Updated once a day after the close (EOD); the server caches the ranking 30 min. Locally the
  FULL ranking is cached 1 hour as a single file and `top` is sliced locally, so repeat calls
  with different `top` are free within the hour. A cache hit that comes back without `market`,
  without `is_etf`, or without either `attrs` entry is discarded and refetched (whether `attrs`
  survive a parquet round-trip depends on the pandas version), so every field is always there.
- `top` must be an int in 1–3000 (validated locally, same range as the server); None = all.
- Errors: 404 = no recent data server-side; 503 = upstream rate limit (`_retry_get` retries
  503 with backoff, so a 503 that surfaces means the retries were exhausted).

---

## 八大行庫買賣超

每天 8 筆（一家銀行一筆）。FinMind 不支援單股查詢，後台會拉整天全市場資料再 filter，**最多 31 天**。

```python
def fetch_twstock_gov_bank(stock_id: str, start: str, end: str, headers: dict) -> pd.DataFrame:
    """欄位：date, bank_name, buy（張）, buy_amount（元）, sell（張）, sell_amount（元）"""
    r = requests.get(
        f"https://api.blave.org/studio/market/twstock/gov_bank/{stock_id}",
        params={"start": start, "end": end},
        headers=headers,
        timeout=60,
    )
    r.raise_for_status()
    data = r.json().get("data", [])
    return pd.DataFrame(data) if data else pd.DataFrame()
```

常用分析：
```python
df = fetch_twstock_gov_bank("2330", "2025-01-01", "2025-01-31", hdrs)

# 每日八大行庫合計淨買超（張）
daily_net = df.groupby("date").apply(lambda x: (x["buy"] - x["sell"]).sum())

# 各銀行累計淨買超
bank_net = (df.groupby("bank_name")["buy"].sum() - df.groupby("bank_name")["sell"].sum())
```

---

## PE / PB / 殖利率

用 `fetch_twstock_per(stock_id, start, end, headers)`（見 `lib/data.py`）—— DatetimeIndex
（與價格／法人等 fetcher 對齊，可直接 reindex），欄位 `dividend_yield`、`PER`、`PBR`，
資料從 2005-10-01 起。

```python
from lib.data import fetch_twstock_per

per = fetch_twstock_per("2408", "2026-01-01", "2026-07-28", hdrs)
latest = per.iloc[-1]        # dividend_yield / PER / PBR
```

當日資料在盤後直接取自 TWSE／TPEx 官方報表；上櫃比上市晚幾小時發布，未發布時退回 FinMind
（會慢一天）。ETF 沒有 PE 資料——官方報表與 FinMind 都不含，回傳空 DataFrame。

多支股票（價值選股）用 `fetch_twstock_per_batch(stock_ids, start, end, headers)`，見下方 Batch 資料函式。

---

## Dividend Events (股利事件)

Per-stock dividend event history — cash/stock amounts plus record/announce/ex/pay dates.
Use `fetch_twstock_dividend(stock_id, start, end, headers)`; for many stocks use
`fetch_twstock_dividend_batch(stock_ids, start, end, headers)` → `{stock_id: DataFrame}`.

```python
from lib.data import fetch_twstock_dividend

div = fetch_twstock_dividend("2330", "2025-01-01", None, hdrs)
# columns: record_date, period, announce_date, cash_ex_date, stock_ex_date,
#          pay_date, cash, stock, stock_ratio   (RangeIndex — event rows, not a series)
upcoming = div[div["cash_ex_date"] > pd.Timestamp.now().strftime("%Y-%m-%d")]
```

Notes:
- `period` is an **opaque label** (`114年第3季`, `113`, `不適用`, …) — group/compare by
  string, never parse it into a Western year.
- Empty date fields are `''` (empty string), never NaN. An announced event whose ex date
  is not decided yet has `cash_ex_date == ''` — range queries still surface it (the
  filter falls back to `stock_ex_date`, then `record_date`).
- Zero-value rows (`cash == 0 and stock == 0`) are announced **no-distribution** decisions
  and are kept — do not treat them as missing data.
- Unknown / delisted ids and stocks with no dividend history return an empty DataFrame;
  batch omits them silently.
- Full history per stock is cached with a 1-day TTL and sliced locally — repeat calls
  with different ranges are free within the day.

---

## 借券成交明細

每天多筆，`transaction_type` 為 `競價` 或 `議借`，每筆費率/張數不同。

```python
def fetch_twstock_lending(stock_id: str, start: str, end: str, headers: dict) -> pd.DataFrame:
    """欄位：date, transaction_type, volume, fee_rate, close, original_return_date, original_lending_period"""
    r = requests.get(
        f"https://api.blave.org/studio/market/twstock/lending/{stock_id}",
        params={"start": start, "end": end},
        headers=headers,
        timeout=60,
    )
    r.raise_for_status()
    data = r.json().get("data", [])
    return pd.DataFrame(data) if data else pd.DataFrame()
```

常用分析：
```python
df = fetch_twstock_lending("2330", "2025-01-01", "2025-05-30", hdrs)

# 每日借券總量
daily_volume = df.groupby("date")["volume"].sum()

# 競價 vs 議借 分布
by_type = df.groupby(["date", "transaction_type"])["volume"].sum().unstack(fill_value=0)

# 加權平均費率（借券成本）
df["value"] = df["volume"] * df["fee_rate"]
avg_fee = df.groupby("date").apply(lambda x: x["value"].sum() / x["volume"].sum())
```

---

## Market-wide data (大盤)

**In a strategy, attach 三大法人 / 融資融券 / 本益比 / 分點 / PCR with `lib.data.join_tw_flow` (one call, by publication time) — `references/strategy-code.md` › *Taiwan daily flows*; many stocks at once (Type C) → `align_feed` in the same section.**

Whole-market series — no `stock_id` dimension. Use these for index level, market breadth /
turnover, and market-wide institutional or margin flows; the per-stock `fetch_twstock_*`
functions above answer a different question and must not be summed as a substitute.

```python
from lib.data import (
    fetch_twmarket_index,          # (start, end, headers, index_id='TAIEX') → Open/High/Low/Close
    fetch_twmarket_turnover,       # (start, end, headers) → volume, value, trades
    fetch_twmarket_institutional,  # (start, end, headers) → foreign, investment_trust, dealer, total
    fetch_twmarket_margin,         # (start, end, headers) → margin/short balances
)

taiex = fetch_twmarket_index("2024-01-01", "2026-07-28", hdrs)   # DatetimeIndex, daily
```

| Function | Columns | Units | Since |
|---|---|---|---|
| `fetch_twmarket_index` | `Open` `High` `Low` `Close` | index points | 1999-01-05 |
| `fetch_twmarket_turnover` | `volume` `value` `trades` | shares / TWD / count | 1990-01-04 |
| `fetch_twmarket_institutional` | `foreign` `investment_trust` `dealer` `total` | TWD, net (buy - sell) | 2004-04-07 |
| `fetch_twmarket_margin` | `margin_balance` `margin_balance_prev` `margin_balance_value` `short_balance` `short_balance_prev` | lots (張), except `margin_balance_value` in TWD | 2001-01-03 |

Notes:
- `TAIEX` is the only supported `index_id`; any other value returns 400. The index carries no
  volume column — market turnover comes from `fetch_twmarket_turnover`, keyed on the same dates.
- In `fetch_twmarket_institutional`, `foreign + investment_trust + dealer = total` on every day,
  as TWSE publishes it. 外資自營商 (foreign dealers' own account) is already inside 自營商, so it
  is part of `dealer` once and never part of `foreign` (`foreign` is 外資及陸資(不含外資自營商)).
  TWSE prints 外資自營商 as its own row only from 2017-12-18; before that there is one
  外資(及陸資) row, taken whole as `foreign` (in both this series and the key-free twin).
- Margin balances are whole-market; `margin_balance_value` is the only TWD column, the rest are lots.
- TXO put/call ratio is a futures/options dataset — see `fetch_twfutures_pcr` in
  `references/twfutures.md`, not here.
- TAIEX daily index dividend points (`fetch_twmarket_dividend_points` — realized +
  forward estimates, the correction term for TXF basis math) is documented in
  `references/twfutures.md` › Index Dividend Points, since its main consumer is
  futures fair-basis logic.
- **Key-free twins, desktop only:** `fetch_twmarket_{index,turnover,institutional,margin}_public(start, end)`
  and `fetch_twfutures_institutional_public('TX'|'MTX'|'TMF', start, end)` return the same columns
  and units straight from TWSE (`MI_5MINS_HIST`, `FMTQIK`, `BFI82U`, `MI_MARGN`) and TAIFEX
  (`futContractsDateDown`), never through a Blave server. They run only on the user's own
  computer (`BLAVE_AGENT_LOCAL=1`; elsewhere they raise `TwPublicUnavailable`), one request every
  3 seconds to twse.com.tw (1 s to TAIFEX); 三大法人 and 融資 cost one request per trading day on a
  cold cache. The key-free 三大法人 starts 2004-05-03 (ask from May 2004, not April). The TAIEX report
  templates use them when this turn has no Blave data access; prefer the Blave functions
  otherwise. Anything citing them carries the attribution line `資料來源:臺灣證券交易所網站`
  / `資料來源:臺灣期貨交易所(政府資料開放授權)` (`df.attrs['source']` = `TWSE` / `TAIFEX`) —
  the TWSE line claims no open-data licence because 三大法人 (BFI82U) is not in that set.

---

## Batch 資料函式

所有台股資料一律用 batch 函式（即使只有 1 支），回傳 `dict {stock_id: DataFrame}`，超過 50 支自動切塊：

```python
from lib.data import (
    fetch_twstock_price_adj_batch,              # (stock_ids, start, end, headers) → Open/Close
    fetch_twstock_price_batch,                  # (stock_ids, start, end, headers) → 原始日K OHLCV（含 High/Low）
    fetch_twstock_per_batch,                    # (stock_ids, start, end, headers) → dividend_yield/PER/PBR
    fetch_twstock_institutional_batch,          # (stock_ids, start, end, headers) → foreign_net（= foreign_buy − foreign_sell，單位是股，÷1000 才是張）及原始欄位
    fetch_twstock_shareholding_batch,           # (stock_ids, start, end, headers) → shareholders 欄
    fetch_twstock_foreign_shareholding_batch,   # (stock_ids, start, end, headers) → 外資持股比率/股數
    fetch_twstock_financials_batch,             # (stock_ids, headers, types=None) → 損益表 long format
    fetch_twstock_balance_sheet_batch,          # (stock_ids, headers, types=None) → 資產負債表 long format
    fetch_twstock_monthly_revenue_batch,        # (stock_ids, headers) → revenue, revenue_month, revenue_year
    fetch_twstock_ratios_batch,                 # (stock_ids, headers, start=None, end=None) → 財務比率寬表（roe_q / roe_ttm …，見 Financial ratios）
)
```

`fetch_twstock_foreign_shareholding_batch` 主要欄位：

| 欄位 | 說明 |
|---|---|
| `ForeignInvestmentSharesRatio` | 外資持股比率（%） |
| `ForeignInvestmentShares` | 外資持股股數 |
| `ForeignInvestmentRemainRatio` | 外資剩餘可投資比率（%） |
| `ForeignInvestmentRemainingShares` | 外資剩餘可投資股數 |
| `NumberOfSharesIssued` | 已發行股數 |

分點資料（非 batch，按 trader 維度）：
- `fetch_twstock_trader_flows(trader_id, start, end, headers)` → MultiIndex (date, stock_id)，`net` 欄（買 - 賣股數）；trader_id 例如 `'9217'`（凱基-松山）

Per-stock branch flows (one stock, every branch; shares, net = buy − sell; daily, naive date index):
- `fetch_twstock_branch_daily_net(stock_id, start, end, headers)` → DataFrame, rows = dates, columns = `broker_id`; a branch that did not trade that day is 0.
- `fetch_twstock_all_broker_net(stock_id, start, end, headers)` → Series `net`: the day's net summed over every branch.
- `fetch_twstock_broker_net(stock_id, broker_id, start, end, headers)` → DataFrame `net` for one branch (`broker_id` e.g. `'9217'`); only the days that branch traded the stock.
- All three share one per-day cache and need Blave data access; a cold fetch goes in 90-day requests under a 270-per-5-minutes limit. A day is published around 21:30 Taipei — an empty answer for the last 3 days is not cached and is asked again.
- In a strategy attach them by publication time — `join_tw_flow(df, 'broker_total' | 'broker_branch', …)` or `align_feed` (`references/strategy-code.md` › *Taiwan daily flows*) — never a plain `join` on the date.

---

## Whole-market Screening (全市場選股)

**Never fan out per-stock fetchers across many stocks (including your own ThreadPool)** — the
per-stock endpoints are rate-limited; ~300 stocks already push 429 backoff into minutes. The
batch functions above take 50 ids per request, ~40 requests for the whole market. From 400 ids
up, the daily price fetchers' recent days and a filing-day refresh of monthly revenue / ratios come
from one whole-market request per dataset instead — same frames, same cache.

Work as a funnel — narrow the pool first, then pull time series (measured on the uid=1 machine):

1. **Narrow the pool (seconds)**: `fetch_twstock_market_value_all` (whole-market market-cap
   ranking in one call — THE first-layer filter for market-cap conditions: top-N pool, 前十大權值股;
   ETFs are in it, drop them with `~df["is_etf"]` and never by code prefix;
   `fetch_twstock_list` itself has no market-cap column), `fetch_twstock_list` (industry), `fetch_twstock_quote_batch`
   (whole-market change/volume ratio, ~24s), `fetch_twstock_monthly_revenue_batch` /
   `fetch_twstock_per_batch` (fundamental / value conditions) → down to a few hundred stocks.
   Per-stock `/market_value/{stock_id}` history is for the already-narrowed pool only.
2. **Time-series conditions (~10–30s per 100 stocks)**: on the narrowed pool use
   `fetch_twstock_price_batch` (KD / breakout and other conditions needing High/Low),
   `fetch_twstock_price_adj_batch` (moving averages / returns),
   `fetch_twstock_institutional_batch` (consecutive institutional buying).
3. Pulling time series for the whole market without narrowing takes ~2–3 minutes per pass —
   only do this when the user explicitly asks for a full-market scan, and say up front how
   long it will take.

---

## 注意股／處置股 — attention and disposition stocks

Exchange announcements: 注意股 (attention, `kind='notice'` — unusual price / volume / turnover
flagged that day) and 處置股 (disposition, `kind='disposal'` — for a period the stock trades by
periodic call auction, e.g. one match every 2–20 minutes, and buyers must prepay in full).
Source: TWSE and TPEx announcements, served by Blave
(`GET /studio/market/twstock/alerts`). Cite it as 「資料來源：臺灣證券交易所、證券櫃檯買賣中心」.

```python
from lib.data import fetch_twstock_alerts, twstock_disposal_mask

today = fetch_twstock_alerts(hdrs)                                           # disposals in force today + notices announced today (a disposal announced today that starts tomorrow is NOT here)
disp  = fetch_twstock_alerts(hdrs, start='2026-10-13', end='2026-10-13', kind='disposal')  # in force that day
hist  = fetch_twstock_alerts(hdrs, start='2001-01-01', stock_id='2492', kind='disposal')    # one stock, whole history
mask  = twstock_disposal_mask(universe, close_df.index, hdrs)                # dates × stocks, True = under disposition
```

| Table | From |
|---|---|
| TWSE disposals, TWSE notices | 2001-01 |
| TPEx notices | 2002-02 |
| TPEx disposals | 2003-09 (2002-02 – 2003-08 exist only as a static page and are not included) |

**Rows.** One row per announcement; index = `date`, the **announcement day** (repeats — several
stocks a day). `start` / `end` = the disposal period, both days included (NaT on notices).
`count` = the exchange's cumulative count. `condition` = the trigger as published (disposal:
「連續三次」, 「連續3個營業日」…; notice: the clauses cited, 「第一款、第五款」). `measure` =
disposal type (第一次處置 / 第二次處置 / 再次處置 / 人工管制撮合 / 收足五成款券 …; empty on early
TPEx rows → None). `reason` = full announcement text. `close` / `pe` = closing price and P/E on
the announcement (NaN on every TWSE disposal). `stock_id` covers warrants, ETFs and convertible
bonds too (`037060` is a warrant).

**`match_minutes`** (Int64) = the N of 「約每N分鐘撮合一次」 read from the text; `<NA>` when the
text names none — every TWSE disposal before ~2011 (the text is blank), and measures that are not
periodic matching. The minutes follow the rules of the day (TPEx 5 / 20 → 2 from 2026-08-10);
never assume a value.

**Range semantics** (same as the api): a disposal is returned when its PERIOD overlaps
`start`–`end`, a notice when its announcement day is inside it — so
`start=end=D, kind='disposal'` is "under disposition on D". No `start` / `end` → today; no `end`
→ today; no `start` → 2001 with `stock_id`, else `end` − 365 days. Whole-market ranges over 366
days are split per calendar year for you; finished years are cached for good, the current year
for 1 hour. With `stock_id` it is one request for the stock's whole history (cached 1 hour).
A disposal can overlap the next one for the same stock (a 第二次處置 announced inside the first).

**Updates.** Blave's store refreshes at 17:45, 21:30 and 07:00 Taipei. The exchanges announce
after the close; a TPEx evening announcement may only arrive in the 07:00 run. `FEED_TIMING`
(`'twstock_alerts'`) takes an announcement as known from 07:30 the next day.

### Backtest: drop disposed stocks from the universe

A disposal is announced after the close of the day before its period starts and is in force
from the next trading day. `twstock_disposal_mask` turns the announcements into "under
disposition on day D" — knowable before D's open, so it carries no look-ahead:

```python
def fetch_data(hdrs):
    from lib.data import fetch_twstock_price_adj_batch, twstock_disposal_mask
    px = fetch_twstock_price_adj_batch(UNIVERSE, START, END, hdrs)
    close_df = pd.DataFrame({s: df['Close'] for s, df in px.items()}).sort_index()
    open_df  = pd.DataFrame({s: df['Open'] for s, df in px.items()}).reindex(close_df.index)
    disposed = twstock_disposal_mask(close_df.columns, close_df.index, hdrs)
    return close_df, open_df, disposed

def compute_signals(data):
    close_df, open_df, disposed = data
    score = close_df.pct_change(20).where(~disposed)          # a disposed stock is not ranked
    ...
    w[disposed.to_numpy()] = 0.0                              # held into a disposal → exit next open
```

- `weights[disposed] = 0` exits at the next open, so the first disposal day is still held. Avoiding
  that day too would need the announcement at the previous bar's close, which it is not —
  **never `disposed.shift(-1)`**.
- The mask fetches whole-market disposals once (per calendar year, from the first date's year),
  never per stock; an id with no disposal is all False.
- `start` / `end` are the announced period. A market holiday or a trading suspension inside it
  extends the real end; the data does not record that extension.
- Need notices as a signal (e.g. 「注意股次數」)? Pivot `fetch_twstock_alerts(..., kind='notice')`
  to one row per announcement day and attach it with `align_feed(..., 'twstock_alerts', ...)` —
  never join on `date`.

---

## Financial ratios (財務比率)

Ready-made quarterly ratios, computed by Blave from the three statements — use these before
deriving a ratio by hand (the hand-made ROE below uses period-end equity; this one uses the
average, so do not mix the two).

```python
from lib.data import fetch_twstock_ratios, fetch_twstock_ratios_batch

r   = fetch_twstock_ratios('2330', hdrs)                              # one stock, whole history
rat = fetch_twstock_ratios_batch(universe, hdrs, start='2020-01-01')  # {sid: df}, 50 ids per request, chunked for you
roe = pd.DataFrame({sid: df['roe_ttm'] for sid, df in rat.items()})   # dates × stocks
```

API: `GET /studio/market/twstock/ratios/<stock_id>` and `GET /studio/market/twstock/batch/ratios`.
Wide frame, index = **quarter end**, history from 2013-03-31. `start` / `end` only cut the
returned rows (the cache holds the whole history, 30-day TTL, refreshed when a filing falls due).

| Columns | Unit |
|---|---|
| `gross_margin`, `operating_margin`, `pretax_margin`, `net_margin`, `opex_ratio`, `roe`, `roa` — each `_q` and `_ttm` | % (already ×100) |
| `revenue_yoy`, `revenue_qoq`, `operating_income_yoy`, `net_income_yoy`, `eps_yoy` — each `_q` and `_ttm` | % (already ×100) |
| `eps`, `revenue_per_share`, `fcf_per_share` — each `_q` and `_ttm` | TWD per share |
| `fcf_q`, `fcf_ttm` | TWD, raw amount (not thousands) |
| `interest_coverage`, `receivable_turnover`, `inventory_turnover`, `asset_turnover`, `cfo_to_net_income` — each `_q` and `_ttm` | times |
| `debt_ratio`, `current_ratio`, `quick_ratio` (period end, no suffix) | % (already ×100 — 245.76 means 2.46×) |
| `equity_multiplier` (period end, no suffix) | times |

`_q` = the quarter alone; `_ttm` = the trailing four quarters summed, NaN when any of the four
is missing.

Definitions that differ between data vendors — state them when you report a number:

- **Single-quarter ROE / ROA are not annualised**; the denominator is the average of the
  previous and the current quarter-end balance. `roe_ttm` / `roa_ttm` (TTM net income ÷ the
  average of the balance four quarters back and now) are the annual figures. Net income is
  total net income (`IncomeAfterTaxes`), equity is total equity.
- **Turnover**: `_q` = the quarter's flow ÷ average of previous and current quarter-end balance
  (not annualised); `_ttm` = four-quarter flow ÷ average of the balance four quarters back and
  now. Receivables include related-party receivables.
- **Growth** = (now − base) ÷ |base| × 100; a base of 0 → NaN. `_ttm` growth compares TTM with
  the TTM a year (`*_yoy_ttm`) or a quarter (`revenue_qoq_ttm`) earlier.
- **Per-share columns** use shares = parent-company net income ÷ EPS (the filing's own weighted
  share count, right for any par value), taken from the quarter with the largest |EPS| of the
  last four; all four under 0.1 → NaN.
- **Interest coverage** = (pre-tax income + interest) ÷ interest, interest from the cash flow
  statement's `InterestExpense`; NaN unless interest > 0.
- **Quick ratio** = (current assets − inventories − prepayments) ÷ current liabilities.
- **Free cash flow** = operating cash flow − |capex| (`PropertyAndPlantAndEquipment`),
  single-quarter values (the cash flow statement itself is year-to-date).
- **ROE** is NaN when average equity ≤ 0, `equity_multiplier` when period-end equity ≤ 0,
  `cfo_to_net_income` when net income ≤ 0.

**NaN, never 0.** A missing line item or a zero denominator is NaN — rank with `dropna()`, do
not `fillna(0)`. Financial-sector issuers lack many lines, so whole columns are NaN for them:
`gross_margin`, `operating_margin`, `receivable_turnover`, `inventory_turnover` for every
financial issuer checked; financial holdings also `current_ratio` / `quick_ratio` /
`operating_income_yoy`; banks, securities firms and insurers file no `Revenue`, so every
revenue-based column (margins, `opex_ratio`, `revenue_*`, `asset_turnover`) is NaN too. There is
no sector switch — it follows each filing, so test for NaN instead of assuming a list. `roe`,
`roa`, `eps`, `debt_ratio`, `equity_multiplier` are the columns that work across sectors.

**No statements:** an ETF or any code without financial statements raises
`requests.HTTPError` (404) from `fetch_twstock_ratios` and is simply absent from the
`fetch_twstock_ratios_batch` result — tell the user the code has no financial statements.

**Not here:** PER / PBR / dividend yield → `fetch_twstock_per_batch`; monthly-revenue YoY / MoM
→ `fetch_twstock_monthly_revenue_batch`.

**Lookahead:** a row is stamped with the quarter end but is public only from the dates in
*Lookahead Bias — 財報可用日期* below. Attach it with `align_feed(df, ratios_wide,
'twstock_ratios', INTERVAL, bar_tz='Asia/Taipei')` (`'twstock_financials_finance'` for
financial-sector issuers) — never join on the date. The store keeps the latest version of each
quarter: a restated filing replaces the earlier numbers.

---

## 財報因子計算

財報資料為 long format，先 pivot 再計算：

```python
fin_all = fetch_twstock_financials_batch(universe, hdrs)     # {sid: df}
bs_all  = fetch_twstock_balance_sheet_batch(universe, hdrs)
rev_all = fetch_twstock_monthly_revenue_batch(universe, hdrs)

for sid in universe:
    fin = fin_all[sid].pivot_table(index='date', columns='type', values='value', aggfunc='last')
    bs  = bs_all[sid].pivot_table(index='date', columns='type', values='value', aggfunc='last')
    rev = rev_all[sid]

    roe          = fin['IncomeAfterTaxes'] / bs['Equity']    # ROE
    gross_margin = fin['GrossProfit'] / fin['Revenue']       # 毛利率
    eps_yoy      = fin['EPS'].pct_change(4)                  # EPS YoY（同季比）
    rev_yoy      = rev['revenue'].pct_change(12)             # 月營收 YoY
```

Whole market and only a few items needed → pass `types=` (the balance sheet is ~110 items per
stock, most of the download): `fetch_twstock_balance_sheet_batch(universe, hdrs, types=['Equity'])`.
Only those `type` rows come back; the full frame's cache is untouched. At most 50 names per
call; an empty list raises `ValueError` (pass `None` for every item).

損益表 key types：`Revenue`、`GrossProfit`、`OperatingIncome`、`IncomeAfterTaxes`、`EPS`

資產負債表 key types：`TotalAssets`、`Equity`

---

## Lookahead Bias — 財報可用日期

| 季別 | 財報公告截止日 | 策略可用日 |
|------|-------------|-----------|
| Q1（1–3月） | 5/15 | 5/16 起 |
| Q2（4–6月） | 8/14 | 8/15 起 |
| Q3（7–9月） | 11/14 | 11/15 起 |
| Q4（10–12月） | 翌年 3/31 | 翌年 4/1 起 |

金融控股·銀行·證券·期貨·保險 listed issuers file Q2 by **8/31** (usable 9/1; 公開發行公司財務報告及營運情形公告申報特殊適用範圍辦法 §3(3)); 保險業 monthly revenue is due the **15th** from 2026 revenue (§3(5)). Blave serves a filing from 08:00 the usable day. Attach statements / revenue with `lib.data.align_feed` (`'twstock_financials'`, `'twstock_ratios'`, `'twstock_financials_finance'`, `'twstock_monthly_revenue'`, `'twstock_monthly_revenue_insurance'`) instead of shifting dates by hand — `references/strategy-code.md` › *External data*.
