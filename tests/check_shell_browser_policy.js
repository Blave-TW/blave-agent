// 內建瀏覽器的網址政策(shell/browser/policy.js):**列舉**每一條黑名單、每一種 scheme、每一種私有位址寫法,另列必過網址。
// 跑法:node tests/check_shell_browser_policy.js
const P = require("../shell/browser/policy");
let red = 0; const t = (n, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) red++; };
const reason = (fn, u, k) => { const r = fn(u, k); return r ? r.reason : null; };

// ── 網路層:scheme ──
const badSchemes = ["file:///etc/passwd", "javascript:alert(1)", "chrome://settings", "devtools://devtools/bundled/x.html", "about:blank", "ftp://x.example/", "blave://x", "vscode://x", "mailto:a@b.c"];
t("非 http(s) 的主 frame 一律擋:" + badSchemes.length + " 種", badSchemes.every((u) => reason(P.network, u, "main") === "scheme"));
t("data: / blob: 主 frame 擋、子資源放行", reason(P.network, "data:text/html,x", "main") === "scheme" && reason(P.network, "blob:https://a.com/x", "main") === "scheme" && P.network("data:image/png;base64,AA", "sub") === null && P.network("blob:https://a.com/x", "sub") === null);
t("URL 帶帳密擋", reason(P.network, "https://u:p@example.com/", "main") === "credentials_in_url" && reason(P.network, "https://u@example.com/", "main") === "credentials_in_url");
t("非 80/443 port 擋", reason(P.network, "https://example.com:8443/", "main") === "port" && reason(P.network, "http://example.com:8000/", "sub") === "port" && P.network("https://example.com:443/", "main") === null);

// ── 網路層:SSRF(每一種寫法)──
const privates = [
  "http://localhost/", "http://LOCALHOST./", "http://a.localhost/", "http://printer.local/", "http://db.internal/", "http://router.lan/", "http://x.home.arpa/",
  "http://127.0.0.1/", "http://127.1.2.3/", "http://0.0.0.0/", "http://10.0.0.1/", "http://172.16.0.1/", "http://172.31.255.255/", "http://192.168.1.1/",
  "http://169.254.169.254/latest/meta-data/", "http://100.64.0.1/", "http://100.127.255.255/", "http://198.18.0.1/", "http://224.0.0.1/",
  "http://2130706433/", "http://0x7f000001/", "http://017700000001/", "http://127.000.000.001/", "http://0x7f.1/", "http://10.1/",
  "http://[::1]/", "http://[::]/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:7f00:1]/", "http://[::ffff:10.0.0.1]/", "http://[fc00::1]/", "http://[fd12:3456::1]/", "http://[fe80::1]/",
];
const leaked = privates.filter((u) => reason(P.network, u, "main") !== "private_address");
t("內網 / 本機 / link-local / CGNAT / 十進位八進位十六進位 / IPv6 ULA / v4-mapped 全擋(" + privates.length + " 條)" + (leaked.length ? " 漏:" + leaked.join(" ") : ""), leaked.length === 0);
t("子資源一樣擋內網(頁面打回本機 MCP / 路由器)", reason(P.network, "http://127.0.0.1:1234/mcp", "sub") === "private_address");
t("公網 IP 不誤擋", P.network("http://8.8.8.8/", "main") === null && P.network("http://172.32.0.1/", "main") === null && P.network("http://[2606:4700::1111]/", "main") === null);

// ── 網路層:廣告追蹤(列舉整張表)──
const adMiss = P.ADS.filter((d) => { const h = d.split("/")[0], path = d.includes("/") ? "/" + d.split("/").slice(1).join("/") : "/"; return reason(P.network, "https://x." + h + path + "x", "sub") !== "ads" && reason(P.network, "https://" + h + path, "sub") !== "ads"; });
t("廣告追蹤清單每一條都擋(" + P.ADS.length + " 條)" + (adMiss.length ? " 漏:" + adMiss.join(" ") : ""), adMiss.length === 0);

// ── 工具層:黑名單 / 敏感網域 / blave(列舉)──
// 對方條款 / robots 禁 AI 不是擋的理由(Wei 09-28):這幾站 agent 照開;名單只留給有危害的網站
const TERMS_SITES = ["https://www.theblock.co/post/1", "https://theblock.co/", "https://www.coindesk.com/markets/", "https://cointelegraph.com/news/x", "https://decrypt.co/1",
  "https://money.udn.com/money/story/1", "https://www.moneydj.com/kmdj/news/x", "https://www.reuters.com/markets/"];
const termsBlocked = TERMS_SITES.filter((u) => P.agent(u) !== null);
t("條款 / robots 禁 AI 的新聞站 agent 照開(" + TERMS_SITES.length + " 條)" + (termsBlocked.length ? " 被擋:" + termsBlocked.join(" ") : ""), termsBlocked.length === 0 && P.AGENT_BLOCKLIST.length === 0);
t("放行條款站之後,內網 / 相似網域 / 交易所後台 / 銀行 / 授權頁照擋", reason(P.agent, "http://192.168.1.1/") === "private_address" && reason(P.agent, "https://binance-login.xyz/") === "lookalike"
  && reason(P.agent, "https://www.binance.com/en/my/wallet") === "sensitive_domain" && reason(P.agent, "https://www.ctbcbank.com/") === "sensitive_domain" && reason(P.agent, "https://accounts.google.com/o/oauth2/auth") === "oauth");
t("TradingView 放行(Wei 拍板)", P.agent("https://www.tradingview.com/symbols/BTCUSDT/") === null);
t("*.blave.org 擋(資料走 lib/data.py)", ["https://blave.org/", "https://api.blave.org/x", "https://www.blave.org/zh"].every((u) => reason(P.agent, u) === "blave"));
const sens = P.BANKS.concat(P.BROKERS, P.PAYMENTS);
// 清單本身也要釘:官方支援與 attribution 表上的交易所、三家台股券商(群益 / 統一 / 永豐)、主要銀行與金流——從清單拿掉一家要紅
const MUST_EX = ["binance.com", "bingx.com", "okx.com", "gate.io", "gate.com", "bybit.com", "bitmart.com", "bitfinex.com", "kucoin.com", "coinbase.com", "kraken.com", "bitget.com", "mexc.com"];
const MUST_SENS = ["capital.com.tw", "capitalfutures.com.tw", "pscnet.com.tw", "pfcf.com.tw", "pfctrade.com", "sinotrade.com.tw", "sinopac.com", "ctbcbank.com", "esunbank.com", "cathaybk.com.tw", "paypal.com", "ecpay.com.tw", "newebpay.com", "checkout.stripe.com"];
const missEx = MUST_EX.filter((d) => !P.EXCHANGES.includes(d)), missSens = MUST_SENS.filter((d) => !sens.includes(d));
t("必備清單都在(交易所 " + MUST_EX.length + "、券商銀行金流 " + MUST_SENS.length + ")" + (missEx.concat(missSens).length ? " 缺:" + missEx.concat(missSens).join(" ") : ""), !missEx.length && !missSens.length);
const sensMiss = sens.filter((d) => reason(P.agent, "https://" + d + "/") !== "sensitive_domain" || reason(P.agent, "https://www." + d + "/login") !== "sensitive_domain");
t("券商 / 銀行 / 金流整個網域擋(" + sens.length + " 條)" + (sensMiss.length ? " 漏:" + sensMiss.join(" ") : ""), sensMiss.length === 0);
const backends = ["/en/my/dashboard", "/my", "/en/login", "/login", "/en/trade/BTC_USDT", "/futures/BTCUSDT", "/en/usercenter/api-management", "/account/api", "/assets/deposit", "/en/fiat/withdraw", "/en/register", "/zh-TW/my/wallet"];
const exMiss = [];
for (const d of P.EXCHANGES) {
  for (const p of backends) if (reason(P.agent, "https://www." + d + p) !== "sensitive_domain") exMiss.push(d + p);
  for (const sub of ["accounts", "api", "app", "m", "trade", "futures"]) if (reason(P.agent, "https://" + sub + "." + d + "/") !== "sensitive_domain") exMiss.push(sub + "." + d);
}
t("交易所後台(登入、帳戶、API 金鑰、下單、充提;" + P.EXCHANGES.length + " 家 × " + (backends.length + 6) + " 路徑)全擋" + (exMiss.length ? " 漏:" + exMiss.slice(0, 10).join(" ") : ""), exMiss.length === 0);
const pubs = ["https://www.binance.com/en/support/announcement/new-cryptocurrency-listing", "https://www.binance.com/", "https://www.okx.com/help/fee", "https://academy.binance.com/en/articles/x", "https://www.bybit.com/en/announcement-info/", "https://support.bybit.com/hc/x", "https://www.gate.io/fee", "https://www.bingx.com/en/support/", "https://www.coinbase.com/price/bitcoin", "https://blog.kraken.com/x", "https://www.binance.com/zh-TW/blog/x"];
const pubBlocked = pubs.filter((u) => P.agent(u) !== null);
t("交易所公開頁(公告、費率、說明中心、學院、部落格、價格頁)可讀" + (pubBlocked.length ? " 被擋:" + pubBlocked.join(" ") : ""), pubBlocked.length === 0);
// Wei 09-26:交易所「網域 × 路徑」——公開內容頁放行、後台擋、未知路徑預設擋
const bbSeg = [...P.EXCHANGE_BACKEND_SEGMENTS].filter((seg) => ["binance.com", "okx.com", "bybit.com", "bingx.com", "gate.io", "bitget.com"].some((d) => P.agent("https://www." + d + "/en/" + seg + "/x") === null));
t("後台擋單每一段(" + P.EXCHANGE_BACKEND_SEGMENTS.size + ")× 六大交易所都擋" + (bbSeg.length ? " 漏:" + bbSeg.join(" ") : ""), bbSeg.length === 0);
t("後台段出現在放行路徑底下也擋(/support/…/login、公開子網域的 /account)", reason(P.agent, "https://www.binance.com/en/support/login") === "sensitive_domain" && reason(P.agent, "https://support.bybit.com/account") === "sensitive_domain");
t("必擋:/my/、/trade/、/account(Wei 點名)", ["https://www.binance.com/zh-TC/my/wallet", "https://www.binance.com/en/trade/BTC_USDT", "https://www.okx.com/account/users", "https://www.bybit.com/user/assets/home", "https://bingx.com/en/perpetual/BTC-USDT", "https://www.gate.io/myaccount/profile", "https://www.bitget.com/asset/spot"].every((u) => reason(P.agent, u) === "sensitive_domain"));
t("必放行:Binance Square 貼文、Bybit wiki 文章、行情頁、新聞、學院", ["https://www.binance.com/zh-TC/square/post/361962871022995", "https://www.bybit.com/zh-TW/wiki/article/eth-bitcoin-etfs-hit-10-month-inflow-peak/", "https://www.binance.com/en/markets/overview", "https://www.okx.com/zh-hant/news/x", "https://academy.binance.com/en/articles/x", "https://www.bitget.com/price/bitcoin", "https://www.gate.io/announcements/article/1"].every((u) => P.agent(u) === null));
t("未知路徑預設擋(fail-closed)", ["https://www.gate.io/some-new-feature", "https://www.binance.com/en/launchpool", "https://m.okx.com/"].every((u) => reason(P.agent, u) === "sensitive_domain"));
// ── 稽核 S5:交易所判法的洞 ──
const S5 = ["https://www.okx.com/#/balance", "https://www.binance.com/#/my/wallet", "https://www.binance.com/en/support/announcement?x=1#/my/wallet", "https://www.okx.com/#!/account",
  "https://www.maicoin.com/?page=account", "https://www.binance.com/#top", "https://www.binance.com/en/support/%6Dy", "https://www.binance.com/en/square/post/..%2F..%2Fmy",
  "https://www.binance.com/en/support/x%5Cmy", "https://support.accounts.binance.com/", "https://academy.accounts.binance.com/en/articles"];
const s5Miss = S5.filter((u) => reason(P.agent, u) !== "sensitive_domain");
t("S5 hash 路由、首頁帶查詢 / fragment、百分比編碼、反斜線、公開子網域只比最左一段——都擋(" + S5.length + ")" + (s5Miss.length ? " 漏:" + s5Miss.join(" ") : ""), s5Miss.length === 0);
t("S5 沒被誤傷:主站首頁、說明中心頁內錨點、academy 子網域", P.agent("https://www.binance.com/") === null && P.agent("https://www.binance.com/en/support/faq#section") === null && P.agent("https://academy.binance.com/en/articles/x") === null);
// ── 稽核 S4:OAuth 授權頁 ──
const OAUTH = ["https://accounts.google.com/o/oauth2/v2/auth?client_id=evil&scope=email", "https://accounts.google.com/signin", "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  "https://appleid.apple.com/auth/authorize", "https://github.com/login/oauth/authorize?client_id=x", "https://x.com/i/oauth2/authorize", "https://api.twitter.com/oauth/authorize",
  "https://www.facebook.com/v19.0/dialog/oauth", "https://discord.com/oauth2/authorize", "https://evil.example/any?client_id=a&redirect_uri=https%3A%2F%2Fevil.example%2Fcb"];
const oMiss = OAUTH.filter((u) => reason(P.agent, u) !== "oauth");
t("S4 身分提供者登入 / 授權頁與任何 client_id+redirect_uri 的授權請求都擋(" + OAUTH.length + ")" + (oMiss.length ? " 漏:" + oMiss.join(" ") : ""), oMiss.length === 0);
t("S4 不誤傷:github repo 頁、x.com 貼文、google 搜尋", P.agent("https://github.com/vercel-labs/agent-browser") === null && P.agent("https://x.com/someone/status/1") === null && P.agent("https://www.google.com/search?q=x") === null);
// ── 相似網域(Wei 09-26):正例一批必擋(網路層主 frame,用戶與 agent 都擋),反例一批必過;正牌網域本身與子網域一律不擋 ──
const url = require("url");
const LIKE_POS = [
  ["login.binance.com.evil.io", "binance.com"], 
  ["blnance.com", "binance.com"], ["b1nance.com", "binance.com"], ["binnance.com", "binance.com"], [url.domainToASCII("bіnance.com"), "binance.com"],
  [url.domainToASCII("оkx.com"), "okx.com"], ["coinbese.com", "coinbase.com"], ["kucoln.com", "kucoin.com"],
  ["paypa1.com", "paypal.com"], [url.domainToASCII("pаypal.com"), "paypal.com"], ["rnexc.com", "mexc.com"],
  ["b1ave.org", "blave.org"], 
  // 同品牌換頂級網域(Wei 拍板要擋)、正牌網域整段放在別人網域前面
  // 品牌嵌在別人網域裡、旁邊帶詐騙常用字(連字號、點、直接相連都算);blave 自己任何嵌入都擋
  ["binance-login.xyz", "binance.com"], ["okx-support.net", "okx.com"], ["bybit-airdrop.io", "bybit.com"], ["sinopac-bank.top", "sinopac.com"], ["binancelogin.com", "binance.com"],
  ["login.binance-x.com", "binance.com"], ["binance.support-center.io", "binance.com"], ["binanceapp.xyz", "binance.com"], ["binance-app.io", "binance.com"], ["coinbase-kefu.com", "coinbase.com"],
  ["bybitairdrop.io", "bybit.com"], ["secure-bitfinex.net", "bitfinex.com"], ["binance-sign-in.com", "binance.com"], ["blave-org.com", "blave.org"], ["myblave.com", "blave.org"],
  // 稽核 R10:共用託管平台上的仿冒租戶
  // 稽核 R13:託管平台上租戶名剛好等於品牌(不在官方租戶白名單)
  ["blave.github.io", "blave.org"], ["binance.github.io", "binance.com"], ["bybit.vercel.app", "bybit.com"],
  ["binance-login.github.io", "binance.com"], ["bybit-airdrop.pages.dev", "bybit.com"], ["blave-login.vercel.app", "blave.org"], ["okx-support.netlify.app", "okx.com"], ["b1nance.github.io", "binance.com"],
  // 稽核 R11:gateio 單獨當品牌;非官方的「錢包」網域(官方是 web3.okx.com / web3.bitget.com)
  ["gateio-support.com", "gate.io"], ["okxwallet.io", "okx.com"], ["bitgetwallet.com", "bitget.com"],
  // 未經查證是官方的區域網域照擋(Upbit 印尼官方是 id.upbit.com、moomoo 新加坡是 moomoo.com/sg)
  ["upbit.id", "upbit.com"], ["moomoo.sg", "moomoo.com"],
  ["binance.xyz", "binance.com"], ["okx.io", "okx.com"], ["bybit.net", "bybit.com"], ["blave.com", "blave.org"], ["bingx.io", "bingx.com"], ["crypto.com.evil.io", "crypto.com"], ["binanse.com", "binance.com"], ["coinbaase.com", "coinbase.com"],
];
const likeMiss = LIKE_POS.filter(([h, like]) => { const r = P.network("https://" + h + "/", "main"); return !r || r.reason !== "lookalike" || r.like !== like; });
t("相似網域正例(" + LIKE_POS.length + ")全擋,而且回報命中的正牌網域" + (likeMiss.length ? " 漏:" + likeMiss.map((x) => x[0]).join(" ") : ""), likeMiss.length === 0);
t("IDN 混用拉丁 + 西里爾字母(不像任何品牌也擋)", reason(P.network, "https://" + url.domainToASCII("gооgle-news.com") + "/", "main") === "lookalike");
const LIKE_NEG = ["www.coindesk.com", "cointelegraph.com", "decrypt.co", "coinglass.com", "coingecko.com", "coinmarketcap.com", "cryptopanic.com", "investing.com",
  "www.tradingview.com", "bitcoin.org", "bitcoinmagazine.com", "reuters.com", "bloomberg.com", "news.cnyes.com", "twse.com.tw", "gateway.com", "capitalone.com",
  "krakenfiles.com", "github.com", "google.com", "duckduckgo.com", "medium.com", "x.com", "youtube.com", "beaconcha.in", "mempool.space", "farside.co.uk",
  "cmegroup.com", "glassnode.com", "messari.io", "defillama.com", "etherscan.io", "wikipedia.org", "yahoo.com", "ptt.cc", "base.org", "bing.com", "bitly.com",
  "bitso.com", "bitpay.com", "okcoin.com", "bitcoin.com", "data.binance.vision", "binance.org", "www.bitmex.com", "tw.stock.yahoo.com",
  // 稽核 R1:官方 API 文件 / 測試網 / 我們自己的 / 一般網站,都不該擋
  "bybit-exchange.github.io", "bingx-api.github.io", "binance-docs.github.io", "okx.github.io", "coinbase.github.io", "hyperliquid.gitbook.io", "testnet.binancefuture.com",
  "blave-tw.github.io", "brave.com", "search.brave.com", "blade.com", "blake.com", "debit.com", "whitebox.com", "sinopec.com", "revolt.com", "firstrate.com", "bitmain.com",
  "yuantafunds.com", "paypal-community.com", "binance.medium.com", "okex.com", "bingxdao.com",
  // 品牌名嵌在別人的網域裡:Wei 09-26 拍板不擋
  "bitgett.com",   // 6 字品牌不比拼字距離(接受的漏擋,同 phemax / by6it)
  // 品牌嵌在別人網域裡、旁邊沒有詐騙常用字:放行(Wei 09-26)
  // 稽核 R9:銀行 / 金流 / 政府網域與一般組織撞名,不當同品牌換頂級網域
  "post-support.ch", "paypal.me", "revolut.me", "post.ch", "post.at", "post.news", "stripe.dev", "stripe.press", "stripe.network", "robinhood.org",
  // 官方區域站(查證過,在 OFFICIAL_ALT)
  "www.binance.tr", "www.trbinance.com", "www.webull.hk",
  // 稽核 R12:Gate API 網域、Hyperliquid 官方測試網
  "www.gateio.ws", "api.gateio.ws", "app.hyperliquid-testnet.xyz", "api.hyperliquid-testnet.xyz",
  // 託管平台上的官方租戶、一般租戶
  "okx.github.io", "coinbase.github.io", "someone.github.io", "my-blog.vercel.app",
  "mybinance.com", "binancenews.example", "kucoinwiki.com", "evilbinance.com", "binancehappy.com", "binance-apple.com", "binanceplayground.com",
  // 官方其他網域白名單(同品牌換頂級網域會擋,這些是官方的)
  "binance.us", "www.binance.co.jp", "www.bybit.eu", "api.bybit.kz", "api-testnet.gateapi.io",
  // 常見大站
  "amazon.com", "apple.com", "microsoft.com", "facebook.com", "instagram.com", "linkedin.com", "reddit.com", "netflix.com", "openai.com", "anthropic.com", "coinbase.com", "stripe.com", "notion.so", "discord.com", "telegram.org", "binance.com"];
const likeFalse = LIKE_NEG.filter((h) => P.lookalike(h));
// 詐騙常用字表每一個字都要擋得到(品牌 + 連字號 + 那個字),而且只有一處定義
const scamMiss = P.SCAM_WORDS.filter((w) => !P.lookalike("binance-" + w + ".xyz"));
t("詐騙常用字表(" + P.SCAM_WORDS.length + ")每一個字跟品牌組在一起都擋" + (scamMiss.length ? " 漏:" + scamMiss.join(",") : ""), scamMiss.length === 0 && ["login", "support", "airdrop", "kyc", "wallet", "kefu", "app", "official", "refund"].every((w) => P.SCAM_WORDS.includes(w)));
t("相似網域反例(" + LIKE_NEG.length + ")都不擋" + (likeFalse.length ? " 誤擋:" + likeFalse.join(" ") : ""), likeFalse.length === 0);
const protectedHosts = [...new Set(P.EXCHANGES.concat(P.BROKERS, P.BANKS, P.PAYMENTS, ["blave.org"]).map((d) => P.registrable(d)))];
const selfHit = protectedHosts.filter((r) => P.lookalike(r) || P.lookalike("www." + r) || P.lookalike("accounts." + r));
t("正牌網域本身與子網域(" + protectedHosts.length + " 個 × 3)一律不算相似" + (selfHit.length ? " 誤擋:" + selfHit.join(" ") : ""), selfHit.length === 0);
t("相似網域只看主 frame(子資源不判,避免頁面上的第三方資源被當釣魚)", P.network("https://binance-login.xyz/a.js", "sub") === null);
t("相似網域不被當成交易所後台(尾碼帶點界線);品牌嵌在別人網域裡照 Wei 拍板放行", P.agent("https://evilbinance.com/my") === null && P.hostOn("evilbinance.com", "binance.com") === false && P.hostOn("a.binance.com", "binance.com") === true);
const okUrls = ["https://www.google.com/search?q=btc", "https://html.duckduckgo.com/html/?q=btc", "https://www.coindesk.com/markets/", "https://beaconcha.in/", "https://www.investing.com/economic-calendar/", "https://news.cnyes.com/news/cat/headline", "http://example.com/"];
const okBlocked = okUrls.filter((u) => P.agent(u) !== null);
t("一般新聞 / 搜尋 / 研究站必過" + (okBlocked.length ? " 被擋:" + okBlocked.join(" ") : ""), okBlocked.length === 0);
t("agent 層先過網路層(內網、scheme 照擋)", reason(P.agent, "http://127.0.0.1/") === "private_address" && reason(P.agent, "file:///x") === "scheme");
t("R12 gateio.ws 是交易所網域:後台路徑照擋、公開頁放行", reason(P.agent, "https://www.gateio.ws/myaccount/profile") === "sensitive_domain" && P.agent("https://www.gateio.ws/announcements/article/1") === null);
t("R15 hyperliquid-testnet.xyz 是交易所網域:/trade 與 api 子網域照擋,跟正式站一致", reason(P.agent, "https://app.hyperliquid-testnet.xyz/trade") === "sensitive_domain" && reason(P.agent, "https://api.hyperliquid-testnet.xyz/info") === "sensitive_domain" && P.lookalike("app.hyperliquid-testnet.xyz") === null);
t("可註冊網域(近似):news.cnyes.com → cnyes.com、a.b.com.tw → b.com.tw、IP 原樣", P.registrable("news.cnyes.com") === "cnyes.com" && P.registrable("a.b.com.tw") === "b.com.tw" && P.registrable("8.8.8.8") === "8.8.8.8");

console.log(red ? `\n${red} FAILED` : "\nALL PASS");
process.exit(red ? 1 : 0);
