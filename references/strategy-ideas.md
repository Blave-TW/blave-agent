# Finding Strategy Ideas on the Web

Applies when the user wants strategy ideas from the web: the app's 「上網找點子」 message ("Search the web for 3 backtestable … strategy ideas"), 「幫我找靈感」, "what strategies could I try". Desktop: the built-in browser (`browser.md`; switched off = no web). Cloud: the engine's own web fetch, if the turn has one. The list below is where to start, so most turns need no search at all.

Also applies when the user asks for one strategy by style, investor or paper without giving its rules: *Looking up a method before building*.

## Flow

1. Pick **3–6 sites** from *Sources* that fit the type (A / C) and market asked for — never the whole list (12 full reads use up the 120k read budget).
2. `browser_open_many` those list pages → `browser_read(part="links")` on each (cheap) → pick candidates.
3. Open only the single pages you will read, and read every page you open (`browser.md` › *Standard flow*).
4. A topic none of the listed sites covers (e.g. funding rate): skip the generic blogs and search once right away, then open the best results. Otherwise no search. One search per turn at most.

## Looking up a method before building

The user asked for a strategy by type or style (value, momentum, mean reversion), by an investor's method (Graham, Buffett, Lynch) or from a study or paper, and gave no concrete rules. What you remember of a method is one version of it with the numbers guessed; published versions state the universe, thresholds and rebalance dates. So look first, then build from one of them.

- **Not for:** the user already gave the rules; they only want an existing strategy backtested, its numbers or a parameter changed; the question is market data `lib/data.py` has. "Backtest Graham's stock picks" names a method, not an existing strategy, so it still looks first. Rules given but naming an indicator or term you do not recognise → still look up who publishes it first (`AGENTS.md` › Data Sources).
- **Where:** as in the opening paragraph (desktop: the built-in browser; cloud: the engine's own web fetch, if the turn has one). Desktop browser switched off (no web by any route, `browser.md`), a cloud turn without web, or a cloud engine with no search tool (e.g. DeepSeek): write the strategy from the method as you know it; the reply says plainly that this one was not checked on the web, and gives no source list.
- **Flow:**
  1. Search once first (desktop: `browser_search`), naming the method and the market (e.g. `Graham defensive investor criteria`, `Piotroski F-score rules`, or the method's local name for TW stocks) — investor and paper methods rarely sit on a list page. For stock selection, factors and value, add one or two pages from *Stock selection, factors, value* below.
  2. Open 2–4 pages, the original over a summary (the paper, the investor's own criteria, a write-up that states every threshold), and read each one you open — on the desktop, the same 120k read budget and *Standard flow* as `browser.md`.
  3. Take **one** rule set: the one whose data passes the *Fit check* and that states the most numbers. A threshold the source leaves out, you set and say so. Never blend several pages into a rule set none of them used. None fits the data you have: take the closest version Blave data can test (another market, or a proxy you name), and the reply says which substitute rules you used and why; never swap markets silently.
  4. Build and run it as usual (`strategy-code.md`). No pick step: the user asked for a strategy, not a menu.
- **Reply:** the first sentence stays the benchmark comparison (`AGENTS.md` › *Reporting a backtest*); the next one names the pages you used (title and URL) and the rule set you took, plus any threshold you set yourself. E.g. "Rules from TEJ's Dreman contrarian article (Quantpedia's book-to-market page read too), backtested on Blave data: P/E and yield filters, then at least 3 of 5 quality points, rebalanced quarterly; the article gives no holding count, so I set 20." A return the source reports is quoted only as that source's backtest, with its market and period — never as Blave's result or what this strategy will make; the numbers that count are this run's.

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

**Stock selection, factors, value — also an investor's or a paper's method** (FinLab and StatementDog above fit here too)

| Market | URL | Use |
|---|---|---|
| TW stocks | `https://www.tejwin.com/insight-category/tquant-lab/` | TEJ's TQuant Lab articles: named investors' methods and factor screens tested on TW stocks with the rules in full (e.g. the Dreman contrarian article: P/E, yield and market-cap filters, a five-point quality score, quarterly rebalance dates) |
| Any | `https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/data_library.html` → a factor's *Details* page (e.g. `…/Data_Library/det_form_btm.html`) | How the academic factors (value, size, momentum, profitability, investment) are built: sort variable, breakpoints, formation month. US data; carry the rules over |
| Any | `https://quantpedia.com/strategies/<name>` (e.g. `value-book-to-market-factor`) | One strategy per page; the free *Simple trading strategy* block gives universe, sort and rebalance, often without percentile cutoffs |

## TradingView community scripts

- Use the `/scripts/` URLs above — **never the chart's Indicators dialog** (its community rows have no refs; you cannot click them).
- The list is already recent-popular and open-source. More: `https://www.tradingview.com/scripts/page-2/?script_type=strategies`, `page-3` … — never scroll the page. Past page 42 it sends you back to page 1. There is no all-time ranking on the web; do not look for one.
- For idea hunting you may read an open-source script's Source code to state its rules exactly; the output is still rules + URL only — no code, nothing in `strategies/` until the user picks one (`strategy-code.md` › *Building from code the user points to*).
- **When a TradingView list has a script that fits, at least one delivered idea comes from it** (not only from sources that are cheaper to read).
- The code sits behind the script page's `tab "Source code"`: snapshot, click it, then read. One script is ~28k characters — choose from the list and the description first, open Source code only for the ones you will deliver.
- Protected / invite-only: say the code is not readable and work from the description (`strategy-code.md`).

## Output

This reply exists so the user can pick one — the chat column is narrow and a reply longer than one phone screen goes unread. So it carries only what the pick needs:

- One opening sentence for what every idea shares (whether Blave data is needed, that you read only the page or also the code). Never repeat it per idea.
- Per idea: its logic in one plain sentence; at most two caveats that would change the pick (tested only on another market, too few trades, parameters the source leaves out); the source URL on a line of its own — the script or article page itself, never a list page or a site name. An idea found on several sites cites the original one.
- Exact entry / exit / stop rules wait until the user picks one or asks for them.
- End with the idea you recommend and a one-clause reason, and say that replying with its number starts the backtest.

Reply in the user's language; the example below is the shape, not the wording.

<example>
All three use only public Binance klines, no Blave data; I read the page descriptions, not the code.
1. First-4-hour fake breakout. Price breaks out of the UTC 0–4 range and closes back inside, so enter the other way. The author tested it only on gold.
https://www.tradingview.com/script/…
2. Bollinger squeeze breakout (ETH). Volatility contracts, then expands; follow the direction. The page shows only 11 trades, and two parameters are left for us to fill in.
https://jesse.trade/strategies/…
3. …
I'd test 1 first: its rules are the most complete and need no extra parameters. Reply with a number to start the backtest.
</example>

## Fit check

Every rule's data must exist in `lib/data.py` (crypto: Binance USDT-M klines, funding, OI, Blave indicators, liquidations `fetch_liquidation`, Fear & Greed `fetch_fear_greed`, CME COT `fetch_cme_cot` — long/short ratio `fetch_long_short_ratio_coin` and CVD `fetch_cvd_coin` hold only 7 days, too short to backtest; TW stocks: adjusted prices, institutional flows, PER, dividends, monthly revenue, financial ratios, shareholding, margin trading `fetch_twstock_margin` / market-wide `fetch_twmarket_margin`, broker branches `fetch_twstock_broker_net`, attention / disposition stocks `fetch_twstock_alerts`; TAIFEX incl. put/call ratio `fetch_twfutures_pcr`; US stocks / ETFs `fetch_usstock_price`). Not there (on-chain) → pick another idea; never deliver one that cannot be backtested.

## Dead or hijacked site

A listed site that opens as something else — gambling, parked domain, 404, a robot check — is skipped with one sentence in the reply; do not read its content.
