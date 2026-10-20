# Finding Strategy Ideas on the Web

Applies when the user wants strategy ideas from the web: the app's 「上網找點子」 message ("Search the web for 3 backtestable … strategy ideas"), 「幫我找靈感」, "what strategies could I try". Desktop: the built-in browser (`browser.md`; switched off = no web). Cloud: the engine's own web fetch, if the turn has one. The list below is where to start, so most turns need no search at all.

## Flow

1. Pick **3–6 sites** from *Sources* that fit the type (A / C) and market asked for — never the whole list (12 full reads use up the 120k read budget).
2. `browser_open_many` those list pages → `browser_read(part="links")` on each (cheap) → pick candidates.
3. Open only the single pages you will read, and read every page you open (`browser.md` › *Standard flow*).
4. A topic none of the listed sites covers (e.g. funding rate): skip the generic blogs and search once right away, then open the best results. Otherwise no search. One search per turn at most.

## Sources

**Type A — single-symbol signals**

| Market | URL | Use |
|---|---|---|
| Crypto / any | `https://www.tradingview.com/scripts/?script_type=strategies` | Recent popular open-source strategies (*TradingView* below) |
| Crypto / any | `https://www.tradingview.com/scripts/editors-picks/?script_type=strategies` | Editors' picks |
| Crypto / any | `https://www.tradingview.com/scripts/<keyword>/?script_type=strategies` (e.g. `momentum`) | First choice when there is a topic |
| Crypto | `https://github.com/freqtrade/freqtrade-strategies` | Open-source crypto strategies, code readable |
| Crypto | `https://jesse.trade/strategies` | Community strategies with past performance |
| Any | `https://github.com/je-suis-tm/quant-trading` | Dozens of classic strategies in Python (A and C) |
| Any | `https://www.quantconnect.com/forum/discussions/1/` | Forum threads, often with code |
| Any | `https://www.mql5.com/en/articles` | EA articles with complete entry/exit rules (mostly FX; rules carry over) |
| Any | `https://blog.quantinsti.com/`, `https://robotwealth.com/blog/` | Tutorials with backtests |
| Crypto / any | `https://www.reddit.com/r/algotradingcrypto/top/?t=month`, `https://www.reddit.com/r/algotrading/top/?t=month` | Leads only, never the source |
| TW stocks / TAIFEX | `https://www.xq.com.tw/xstrader/` | XQ's blog: TW stock and index-futures strategy / screener scripts |
| TW stocks / TAIFEX | `https://www.ptt.cc/bbs/Stock/search?q=策略`, `https://www.ptt.cc/bbs/Stock/index.html`, `https://www.ptt.cc/bbs/Option/index.html` (index futures / options) | Noisy, leads only; the search page beats the front page |

**Type C — multi-symbol weights / factors**

| Market | URL | Use |
|---|---|---|
| Any | `https://quantpedia.com/screener`, `https://quantpedia.com/blog/` | Academic strategy encyclopedia (the list is short, open single entries); blog has new analyses |
| Any | `https://quantocracy.com/` | Quant blog aggregator, fastest for new posts |
| Any | `https://paperswithbacktest.com/strategies` | Paper strategies sorted by Sharpe (the site says that sort flatters) |
| Any | `https://cssanalytics.wordpress.com/` | Allocation and risk-parity weighting |
| Any | `https://www.aqr.com/Insights/Research`, `https://www.robeco.com/en-int/insights` | Factor research (value, momentum, quality, low vol) to carry over to TW stocks or crypto |
| Any | `https://www.quantconnect.com/research/` | Research posts with code |
| Any | `https://arxiv.org/list/q-fin.PM/recent` (also `q-fin.ST`, `q-fin.TR`) | Papers; extract the rules yourself |
| Any | `https://www.nber.org/papers?page=1&perPage=50`, `https://www.cxoadvisory.com/`, `https://www.reddit.com/r/quant/top/?t=month` | Leads only (CXO is mostly paywalled: titles) |
| Crypto | `https://www.binance.com/en/research`, `https://www.galaxy.com/insights/research`, `https://www.21shares.com/en-us/insights`, `https://research.glassnode.com/` | Narrative-heavy, leads only; Glassnode ideas mostly need on-chain data Blave lacks (*Fit check*) |
| TW stocks | `https://finlab.finance/blog` | TW quant strategies with backtests |
| TW stocks | `https://statementdog.com/blog` | Fundamentals-based picks (revenue, margin, ROE) — matches Blave's financial data |
| TW stocks | `https://blog.fugle.tw/`, `https://www.stockfeel.com.tw/`, `https://www.cmoney.tw/notes/?cid=22814`, `https://uanalyze.com.tw/articles` | Stock / sector / chip analysis, leads only |
| TW stocks | `https://rich01.com/`, `https://www.cmoney.tw/learn/`, `https://www.pocket.tw/school/` | Beginner methods; coarse rules, add the numbers |

## TradingView community scripts

- Use the `/scripts/` URLs above — **never the chart's Indicators dialog** (its community rows have no refs; you cannot click them).
- The list is already recent-popular and open-source. More: `https://www.tradingview.com/scripts/page-2/?script_type=strategies`, `page-3` … — never scroll the page. Past page 42 it sends you back to page 1. There is no all-time ranking on the web; do not look for one.
- For idea hunting you may read an open-source script's Source code to state its rules exactly; the output is still rules + URL only — no code, nothing in `strategies/` until the user picks one (`strategy-code.md` › *Building from code the user points to*).
- **When a TradingView list has a script that fits, at least one delivered idea comes from it** (not only from sources that are cheaper to read).
- The code sits behind the script page's `tab "Source code"`: snapshot, click it, then read. One script is ~28k characters — choose from the list and the description first, open Source code only for the ones you will deliver.
- Protected / invite-only: say the code is not readable and work from the description (`strategy-code.md`).

## Output

What the request asks (the app's message: 3 ideas, explicit entry and exit rules, whether Blave data is needed, the source URL). **Each idea ends with its source URL on a line of its own** — a site name alone is not a source. An idea found on several sites cites the original one.

## Fit check

Every rule's data must exist in `lib/data.py` (crypto: Binance USDT-M klines, funding, OI, Blave indicators; TW stocks: adjusted prices, institutional flows, PER, dividends, monthly revenue, financial ratios, shareholding; TAIFEX). Not there (US ETFs, on-chain) → pick another idea; never deliver one that cannot be backtested.

## Dead or hijacked site

A listed site that opens as something else — gambling, parked domain, 404, a robot check — is skipped with one sentence in the reply; do not read its content.
