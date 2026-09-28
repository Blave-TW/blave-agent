// 內建瀏覽器的網址政策(純資料 + 純函式,不 require electron;tests/check_shell_browser_policy.js 逐條列舉)。
// 契約:.claude/output/specs/desktop-browser-agent-tools-2026-09-26.md §3.1。分兩層:
//   network(): 該 partition 的每個請求都過(用戶與 agent 一視同仁)——scheme、帳密、內網/本機、非 80/443、廣告追蹤。
//   agent():   只管 agent 的工具呼叫,以分頁「當下」網址判——有危害的網站、交易所/券商後台、銀行、金流、*.blave.org。
// 用戶自己在分頁裡開交易所後台照常;agent 對那一頁什麼都讀不到、點不到(「用戶開、agent 讀」的繞法在這層關掉)。
"use strict";

// 可註冊網域用的多段尾碼。沒有帶 PSL(不新增 dependency),所以這是近似:清單外的多段尾碼會被當成一段。
// 只影響顯示與「同網域每分鐘 6 頁」的分組;黑名單比對一律用 hostOn()(主機名尾碼比對),不靠它。
const MULTI_TLD = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "com.tw", "org.tw", "net.tw", "gov.tw", "edu.tw", "idv.tw",
  "com.cn", "net.cn", "org.cn", "com.hk", "org.hk", "co.jp", "ne.jp", "or.jp", "com.au", "net.au", "org.au",
  "co.kr", "or.kr", "com.sg", "com.my", "co.in", "com.br", "co.nz", "com.mx", "co.za", "com.tr", "com.vn", "co.id", "com.ph",
]);

// 【工具層】有危害的網站(惡意程式、詐騙)。對方條款或 robots 禁 AI 不是列進來的理由(Wei 09-28 拍板),所以目前是空的。
const AGENT_BLOCKLIST = [];

// 【工具層】D3 交易所(Wei 09-26 拍板):**公開內容頁放行**(公告、新聞、學院、Square、行情 / 價格頁、說明中心、費率),
// **後台照擋**(登入、帳戶、資產、下單 / 交易、API 管理、充提、設定等要登入的路徑)。判斷是「網域 × 路徑」三段:
//   1. 路徑(語系段之後)任何一段落在 EXCHANGE_BACKEND_SEGMENTS → 擋(明列的後台擋單,放行清單壓不過它);
//   2. 第一段落在 EXCHANGE_PUBLIC_SEGMENTS(或公開子網域、主站首頁)→ 放行;
//   3. 其餘未知路徑 → 擋(fail-closed:漏列一個公開頁只是讀不到,漏列一個後台路徑就是 agent 進得去)。
// 放行的頁面裡,密碼欄、POST 表單、下單 / 付款 / 登入字樣的鈕照樣走 gate.js 分級,由用戶自己按。
// 清單 = root CLAUDE.md attribution 表 + venue-onboarding §5 + 其他主要交易所(待數據研究員補)。
const EXCHANGES = [
  "binance.com", "binance.us", "bingx.com", "okx.com", "gate.io", "gate.com", "bybit.com", "bitmart.com", "bitfinex.com",
  "kucoin.com", "coinbase.com", "kraken.com", "bitget.com", "mexc.com", "htx.com", "huobi.com", "crypto.com", "upbit.com",
  "bithumb.com", "bitstamp.net", "gemini.com", "deribit.com", "hyperliquid.xyz", "bitopro.com", "maicoin.com", "phemex.com",
  "bitflyer.com", "coinone.co.kr", "lbank.com", "whitebit.com", "poloniex.com", "bitvavo.com", "gateio.ws", "hyperliquid-testnet.xyz",
];
const EXCHANGE_PUBLIC_SUBDOMAINS = new Set(["academy", "research", "blog", "support", "help", "announcement", "announcements", "docs", "developers", "status", "learn", "news", "square"]);
const EXCHANGE_PUBLIC_SEGMENTS = new Set([
  "support", "announcement", "announcements", "announcement-info", "help", "helpcenter", "help-center", "faq", "fee", "fees", "fee-schedule", "fee-rate",
  "blog", "academy", "research", "learn", "news", "price", "prices", "markets", "square", "feed", "listing", "listings", "docs", "api-docs",
  "about", "legal", "terms", "careers", "press", "institutional", "campaign-rules", "wiki", "article", "articles", "insights", "glossary",
]);
// 明列的後台擋單(各主要交易所實際用到的路徑段;任何位置出現都擋):
//   Binance /my/ /usercenter/ /trade/ /futures/ /fiat/ /convert/ /copy-trading/ /earn/;OKX /account/ /balance/ /trade-spot/ /trade-swap/;
//   Bybit /user/ /trade/ /assets/;BingX /spot/ /perpetual/ /assets/;Gate /myaccount/ /futures/ /trade/;Bitget /asset/ /spot/ /futures/。
const EXCHANGE_BACKEND_HOSTS = new Set(["app", "m", "fapi", "dapi", "papi", "vapi", "eapi", "stream", "ws", "wss", "pro", "web3", "c2c", "otc", "auth", "id", "sso", "passport"]);
const EXCHANGE_BACKEND_SEGMENTS = new Set([
  "my", "myaccount", "account", "accounts", "user", "usercenter", "user-center", "userinfo", "profile", "me", "dashboard",
  "login", "log-in", "signin", "sign-in", "register", "signup", "sign-up", "logout", "oauth", "authorize", "kyc", "verification", "verify", "security", "settings", "setting",
  "assets", "asset", "wallet", "balance", "balances", "fiat", "deposit", "withdraw", "withdrawal", "transfer", "payment", "pay", "buy-crypto", "buy-sell-crypto", "p2p", "convert",
  "trade", "trading", "trade-spot", "trade-swap", "trade-futures", "spot", "futures", "margin", "perpetual", "swap", "options", "delivery", "orders", "order", "order-history",
  "api-management", "apimanagement", "api-key", "apikey", "api", "copy-trading", "copytrading", "bots", "earn", "savings", "staking", "referral", "rewards", "invite", "affiliate-center",
]);
// 【工具層】D3 券商、銀行、金流:整個網域擋(公開頁價值低,後台與公開頁混在一起)。台灣券商 / 銀行清單待數據研究員補。
const BROKERS = [
  "capital.com.tw", "capitalfutures.com.tw", "pscnet.com.tw", "pfcf.com.tw", "pfctrade.com", "yuanta.com.tw", "yuantafutures.com.tw", "sinotrade.com.tw", "fubon.com",
  "kgi.com.tw", "kgieworld.com.tw", "cathaysec.com.tw", "masterlink.com.tw", "concords.com.tw", "tssco.com.tw", "jihsun.com.tw",
  "president.com.tw", "entrust.com.tw", "firstrade.com", "interactivebrokers.com", "schwab.com", "fidelity.com", "robinhood.com",
  "webull.com", "futuhk.com", "moomoo.com", "tdameritrade.com", "etrade.com",
];
const BANKS = [
  "sinopac.com", "ctbcbank.com", "esunbank.com", "esunbank.com.tw", "cathaybk.com.tw", "taishinbank.com.tw", "richart.tw",
  "megabank.com.tw", "bot.com.tw", "firstbank.com.tw", "hncb.com.tw", "landbank.com.tw", "tcb-bank.com.tw", "chb.com.tw",
  "scsb.com.tw", "kgibank.com.tw", "linebank.com.tw", "nextbank.com.tw", "rakuten-bank.com.tw", "citibank.com.tw",
  "hsbc.com.tw", "dbs.com.tw", "standardchartered.com.tw", "ipost.post.gov.tw", "feib.com.tw", "ubot.com.tw",
  "chase.com", "bankofamerica.com", "wellsfargo.com", "citi.com", "hsbc.com", "barclays.co.uk", "revolut.com", "wise.com",
];
const PAYMENTS = [
  "paypal.com", "ecpay.com.tw", "newebpay.com", "jkopay.com", "tappaysdk.com", "linepay.line.me", "pay.line.me",
  "checkout.stripe.com", "billing.stripe.com", "buy.stripe.com", "pay.google.com", "payments.google.com",
  "checkout.shopify.com", "pay.amazon.com",
];

// 【網路層】廣告與追蹤(精簡內建清單,不新增 dependency)。子資源與主 frame 都擋。
const ADS = [
  "doubleclick.net", "googlesyndication.com", "googleadservices.com", "google-analytics.com", "googletagmanager.com",
  "googletagservices.com", "adservice.google.com", "connect.facebook.net", "scorecardresearch.com", "taboola.com",
  "outbrain.com", "criteo.com", "criteo.net", "adnxs.com", "rubiconproject.com", "pubmatic.com", "openx.net",
  "amazon-adsystem.com", "adsrvr.org", "quantserve.com", "chartbeat.com", "chartbeat.net", "hotjar.com", "moatads.com",
  "2mdn.net", "casalemedia.com", "indexww.com", "smartadserver.com", "teads.tv", "yieldmo.com", "sharethrough.com",
  "bidswitch.net", "3lift.com", "media.net", "zemanta.com", "clarity.ms", "bat.bing.com", "ads-twitter.com",
  "analytics.twitter.com", "ads.linkedin.com", "px.ads.linkedin.com", "snap.licdn.com", "analytics.tiktok.com",
  "cdn.mxpnl.com", "api-js.mixpanel.com", "cdn.segment.com", "nr-data.net", "adform.net", "serving-sys.com",
  "mathtag.com", "rlcdn.com", "demdex.net", "everesttech.net", "krxd.net", "bluekai.com", "exelator.com", "agkn.com",
  "tapad.com", "adsafeprotected.com", "doubleverify.com", "imrworldwide.com", "gemius.pl", "yandex.ru/ads",
  "popads.net", "propellerads.com", "mgid.com", "revcontent.com", "adroll.com", "quantcount.com", "sonobi.com",
];

const lc = (s) => String(s || "").toLowerCase().replace(/\.$/, "");
/** host 是否就是 d 或 d 的子網域(尾碼比對,帶點界線:evilbinance.com 不算 binance.com)。 */
function hostOn(host, d) { host = lc(host); d = lc(d); return host === d || host.endsWith("." + d); }
/** 可註冊網域(近似,見 MULTI_TLD)。IP 原樣回。 */
function registrable(host) {
  host = lc(host).replace(/^\[|\]$/g, "");
  if (!host || /^[0-9.]+$/.test(host) || host.includes(":")) return host;
  const p = host.split(".");
  if (p.length <= 2) return host;
  const last2 = p.slice(-2).join(".");
  return MULTI_TLD.has(last2) ? p.slice(-3).join(".") : last2;
}

// ── IP 判斷(URL 解析器已把十進位 / 八進位 / 十六進位的 IPv4 寫法正規化成點分四段)──
function v4Private(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0 && Number(m[3]) === 0) ||
    (a === 198 && (b === 18 || b === 19)) || a >= 224;
}
function v6Private(h) {
  h = lc(h).replace(/^\[|\]$/g, "");
  if (!h.includes(":")) return false;
  if (h === "::" || h === "::1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (mapped) return v4Private(mapped[1]);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);   // WHATWG 會把 ::ffff:127.0.0.1 正規化成 ::ffff:7f00:1
  if (hex) { const n = (parseInt(hex[1], 16) << 16) >>> 0 | parseInt(hex[2], 16); return v4Private([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".")); }
  return /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h) || /^ff/.test(h) || /^64:ff9b:/.test(h) || /^::(\d|[0-9a-f]{1,4}:)/.test(h);
}
// ── 外送檢查(複審 B-2;Wei 拍板):agent 被網頁誘導時,可以把讀到的東西塞進網址參數、開到別人的網域(GET 不必按鈕)。
// agent 要開的網域這一輪還沒出現過,而且網址參數很長、或參數值是這一輪讀過的頁面上的字 → 先停下來請用戶確認。
// 門檻依據:本機 ~/.claude 逐字稿裡 agent 實際開過的 625 個不重複網址(WebFetch／browser_open／open_many),
// query＋fragment 長度 p99=26、最大 55(GitHub issue 搜尋);帶 utm 追蹤參數的新聞連結一般在 80–180。取 200:
// 比正常瀏覽高一截,又低於夾帶一段文章或金鑰所需的長度。搜尋引擎的查詢網址照常放行(它本來就長、而且是 agent 自己的查詢字)。
const EXFIL_TAIL_MAX = 200;
const EXFIL_VALUE_MIN = 40;   // 參數值至少這麼長才去比對讀過的頁面(短的會撞到普通單字)
function searchEngine(u) {
  const h = u.hostname.toLowerCase();
  return (/(^|\.)google\.[a-z.]+$/.test(h) && /^\/(search|webhp)/.test(u.pathname)) || /(^|\.)duckduckgo\.com$/.test(h)
    || (/(^|\.)bing\.com$/.test(h) && u.pathname.startsWith("/search"));
}
const squash = (x) => String(x || "").replace(/\s+/g, " ").trim().toLowerCase();
/** → null(照常開)或 { reason: "long_query" | "page_text", host }。seen = 這一輪出現過的可註冊網域;readText = 這一輪讀過的頁面文字。 */
function exfilRisk(raw, seen, readText) {
  let u; try { u = new URL(String(raw || "")); } catch (_) { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (searchEngine(u)) return null;
  const host = registrable(u.hostname);
  if (seen && seen.has(host)) return null;
  if (u.search.length + u.hash.length > EXFIL_TAIL_MAX) return { reason: "long_query", host };
  const text = readText ? squash(readText) : "";
  if (text) {
    const vals = [...u.searchParams.values(), decodeURIComponentSafe(u.hash.slice(1))];
    for (const v of vals) { const q = squash(v); if (q.length >= EXFIL_VALUE_MIN && text.includes(q.slice(0, EXFIL_VALUE_MIN))) return { reason: "page_text", host }; }
  }
  return null;
}
function decodeURIComponentSafe(x) { try { return decodeURIComponent(x); } catch (_) { return x; } }

/** DNS 解析結果裡有任何一個內網 / 本機位址(`192.168.1.1.nip.io` 這種公開網域指到內網;複審 B-1)。
 *  endpoints = session.resolveHost 回的 [{ address, family }]。 */
// 只認這幾段(複審 B-1 列的):198.18/15、100.64/10 刻意不算——Clash 的 fake-ip／TUN 模式、Tailscale 會把每個網站都解析到
// 那兩段,算進去就是整個瀏覽器打不開
function dnsPrivateAddr(a) {
  a = String(a || "").toLowerCase().replace(/^\[|\]$/g, "");
  const m = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(a);
  if (m) { const x = +m[1], y = +m[2]; return x === 0 || x === 10 || x === 127 || (x === 169 && y === 254) || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168); }
  return a === "::" || a === "::1" || /^f[cd][0-9a-f]{2}:/.test(a) || /^fe[89ab][0-9a-f]:/.test(a);
}
function resolvesPrivate(endpoints) {
  return (endpoints || []).some((e) => e && dnsPrivateAddr(e.address));
}
/** 這個主機名 / IP 是不是本機或內網(SSRF)。 */
function privateHost(host) {
  const h = lc(host).replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan") || h.endsWith(".home.arpa")) return true;
  return v4Private(h) || v6Private(h);
}

// ── 相似網域(canon 設計系統 第 7 條「可疑網址」;Wei 09-26 拍板補)──────────────────────
// 受保護的正牌網域 = 交易所、券商、銀行、金流的可註冊網域 + blave.org。命中下列任一條就當釣魚:
//   ① IDN(xn--)解碼後混用拉丁與西里爾 / 希臘字母,或換回拉丁字形(skeleton)後就是正牌品牌;
//   ② 常見替換(1↔l、0↔o、rn↔m、vv↔w)後等於正牌品牌;
//   ③ 品牌名(可註冊網域第一段)編輯距離:只比 ≥7 字的交易所品牌,字首相同、長度差 ≤1,距離 1(≥10 字放寬到 2);
//   ④ 同品牌換頂級網域(binance.xyz;官方其他網域在 OFFICIAL_ALT 白名單);
//   ⑤ 正牌網域整段放在別人網域前面(login.binance.com.evil.io、crypto.com.evil.io)。
//   ⑥ 品牌名嵌在別人的網域裡,而且旁邊帶 SCAM_WORDS 裡的字(連字號、點、直接相連都算):binance-login.xyz、okx.support-center.io、bybitairdrop.io;
//      沒帶這類字的(kucoinwiki.com、binancenews.example、mybinance.com)放行。blave 自己的品牌任何嵌入都擋(Wei 09-26 拍板)。
// 正牌網域本身與它的子網域一律不算(registrable 相同)。
const LOOKALIKE_SKIP = new Set(["google.com", "amazon.com", "line.me", "shopify.com"]);   // 金流清單裡順帶進來的通用大站,不當品牌比
// 同品牌、不同頂級網域(binance.xyz、okx.io)一律當仿冒(Wei 09-26 拍板);關掉這一條只要改這個常數
const SAME_BRAND_OTHER_TLD = true;
// 官方的其他網域(白名單;不在這裡的同品牌網域會被擋)。每一條附來源:
const OFFICIAL_ALT = new Set([
  "binance.us",          // Binance.US(美國獨立營運的官方平台,www.binance.us)
  "binance.vision",      // Binance 官方驗證頁列出 data.binance.vision(www.binance.com/en/official-verification)
  "binance.org",         // BNB Chain 的舊官方網域(Binance 旗下)
  "binancefuture.com",   // Binance 合約舊測試網 testnet.binancefuture.com(現行文件改列 demo-fapi.binance.com;稽核 R1 指定放行)
  "binance.co.jp",       // Binance Japan(日本持牌子公司)
  "bybit.eu",            // Bybit EU GmbH,MiCAR 持牌(Bybit 新聞稿 2025-07;Bybit API 文件列 api.bybit.eu)
  "bybit.kz",            // Bybit Kazakhstan,AFSA 持牌(Bybit 新聞稿;Bybit API 文件列 api.bybit.kz)
  "gateapi.io",          // Gate API 測試網 api-testnet.gateapi.io(blave-quant-skill gate 文件)
  "paypal-community.com", // PayPal 官方社群(稽核 R1 列為誤擋)
  "binance.tr",          // Binance TR(土耳其持牌站,www.binance.tr;Binance 部落格〈Introducing Binance TR〉)
  "trbinance.com",       // Binance TR 的登入 / 交易網域(www.trbinance.com)
  "webull.hk",           // Webull Securities Limited,香港 SFC 持牌(www.webull.hk)
  "gateio.ws",           // Gate 的 API 網域 api.gateio.ws(blave-quant-skill gate 文件;Gate API v4 官方 base URL)
  "hyperliquid-testnet.xyz", // Hyperliquid 官方測試網 app / api.hyperliquid-testnet.xyz(Hyperliquid 官方文件 testnet faucet 頁)
]);
// 共用託管平台上的官方租戶(交易所 / 我們自己的 API 文件站)
const OFFICIAL_TENANTS = new Set(["bybit-exchange.github.io", "bingx-api.github.io", "binance-docs.github.io", "okx.github.io", "coinbase.github.io", "hyperliquid.gitbook.io", "blave-tw.github.io",
  "binance.medium.com"]);   // Binance 官方 Medium
// 「同品牌換頂級網域」不比的品牌:名字就是一般字,別的組織拿去用很正常(robinhood.org 是慈善機構)
const SAME_BRAND_EXEMPT = new Set(["robinhood"]);
// 共用託管平台:子網域是任何人都能開的(github.io、gitbook.io…),官方文件也常放在這裡——只看可註冊網域第一段,所以這些平台的子網域不會被當仿冒
const SHARED_HOSTING = new Set(["github.io", "gitbook.io", "gitlab.io", "medium.com", "notion.site", "vercel.app", "netlify.app", "pages.dev", "readthedocs.io", "substack.com", "blogspot.com", "wordpress.com", "herokuapp.com", "web.app", "firebaseapp.com"]);
// 編輯距離只比辨識度高、夠長(≥7 字)的交易所品牌;銀行 / 券商的名字常跟一般公司撞(sinopac / sinopec)
// 通用字:當 token 完全相等才算(不做子字串、不做距離)
const GENERIC_BRANDS = new Set(["gate", "capital", "wise", "chase", "crypto", "gemini", "citi", "kraken", "fidelity", "president", "entrust", "concords", "hsbc", "dbs", "bot", "chb", "pay", "linepay", "richart", "fubon"]);
// 詐騙網域常用字(Wei 09-26 拍板;改這一處就好)。「app」只算整段剛好是 app(binanceapp、binance-app),不算 happy、apple 裡的 app
const SCAM_WORDS = ["login", "signin", "sign-in", "support", "help", "service", "airdrop", "claim", "reward", "rewards", "bonus", "giveaway", "verify", "verification", "kyc",
  "wallet", "secure", "security", "account", "auth", "unlock", "recover", "recovery", "refund", "bank", "pay", "payment", "update", "official", "app",
  "kefu", "fuli", "jiangli", "lingqu", "tuikuan", "renzheng", "denglu"];
const EXACT_ONLY = new Set(["app"]);
const ALWAYS_EMBED = new Set(["blave"]);   // 我們自己的品牌:嵌在任何別人的網域裡都擋
/** 品牌 b 嵌在 host(非官方)裡,而且旁邊有詐騙常用字。只看公開尾碼之前的部分。 */
function embedScam(body, b) {
  if (GENERIC_BRANDS.has(b)) return false;
  if (!body.includes(b)) return false;
  if (ALWAYS_EMBED.has(b)) return true;
  // 把品牌拿掉,剩下的每一段(以 . 或 - 切)都是「旁邊的字」;品牌前後直接相連的那一截也算一段
  const rest = body.split(b).join("-").split(/[.-]+/).filter(Boolean);
  const joined = body.split(b).join("-").replace(/\./g, "-");
  return SCAM_WORDS.some((w) => {
    if (w.includes("-")) return joined.split(/-+/).join("-").includes(w);
    return rest.some((part) => part === w || (!EXACT_ONLY.has(w) && w.length >= 3 && (part.startsWith(w) || part.endsWith(w)) && part.length <= w.length + 6));
  });
}
let _protected = null, _exBrands = null;
const EXCHANGE_BRANDS = () => _exBrands || (_exBrands = new Set(EXCHANGES.map((d) => registrable(d).split(".")[0]).concat(["gateio"])));
let _brokerBrands = null;
const BROKER_BRANDS = () => _brokerBrands || (_brokerBrands = new Set(BROKERS.map((d) => registrable(d).split(".")[0])));
function protectedBrands() {
  if (_protected) return _protected;
  const regs = new Set(["blave.org"]);
  for (const d of EXCHANGES.concat(BROKERS, BANKS, PAYMENTS)) { const r = registrable(d); if (!LOOKALIKE_SKIP.has(r)) regs.add(r); }
  const brands = new Map();   // 品牌名 → 正牌網域(第一個)
  for (const r of regs) {
    if (/(^|\.)gov\.[a-z]{2}$|\.gov$/.test(r)) continue;   // 政府網域(ipost.post.gov.tw → post)不當品牌:post.ch、post.at 不是仿冒
    const b = r.split(".")[0]; if (!brands.has(b)) brands.set(b, r);
  }
  brands.set("gateio", "gate.io");   // gate 是一般字(通用品牌不比),gateio 這個寫法是 Gate 自己的
  _protected = { regs, brands };
  return _protected;
}
const CONFUSABLE = { "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "i", "ј": "j", "ѕ": "s", "ԁ": "d", "ɡ": "g", "һ": "h", "к": "k", "м": "m", "т": "t", "в": "b", "н": "h", "ո": "n", "α": "a", "ο": "o", "ρ": "p", "ν": "v", "ι": "i", "κ": "k", "τ": "t", "υ": "u", "ε": "e", "ı": "i", "ⅼ": "l", "ǀ": "l" };
function skeleton(s) { return [...s.normalize("NFKC")].map((c) => CONFUSABLE[c] || c).join("").normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }
function canon(s) { return s.replace(/rn/g, "m").replace(/vv/g, "w").replace(/1/g, "l").replace(/0/g, "o").replace(/i/g, "l"); }
function editDist(a, b, cap) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let best = i;
    for (let j = 1; j <= b.length; j++) { cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); best = Math.min(best, cur[j]); }
    if (best > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
}
/** 相似網域:回 { like: 正牌網域 } 或 null。host 是 URL 解析後的主機名(IDN 已是 xn-- 形式)。 */
function lookalike(host) {
  host = lc(host);
  if (!host || /^[\d.]+$/.test(host) || host.includes(":")) return null;
  const { regs, brands } = protectedBrands();
  const reg = registrable(host);
  if (regs.has(reg) || OFFICIAL_ALT.has(reg) || LOOKALIKE_SKIP.has(reg) || OFFICIAL_TENANTS.has(host)) return null;
  // 共用託管平台(github.io、pages.dev、vercel.app…):租戶那一段(binance-login.github.io 的 binance-login)就是要比的名字
  const hosted = SHARED_HOSTING.has(reg);
  const url = require("url");
  // ① IDN
  for (const label of host.split(".")) {
    if (!label.startsWith("xn--")) continue;
    const uni = url.domainToUnicode(label + ".x").replace(/\.x$/, "");
    const latin = /[a-z]/i.test(uni), cyr = /[\u0400-\u04ff\u0500-\u052f]/.test(uni), greek = /[\u0370-\u03ff]/.test(uni);
    const sk = skeleton(uni).toLowerCase();
    for (const [b, r] of brands) if (sk === b || (sk.length >= 4 && canon(sk) === canon(b))) return { like: r };
    if (latin && (cyr || greek)) return { like: null };
  }
  // 只看可註冊網域的第一段(login.binance.com.evil.io 的可註冊網域是 evil.io——它的子網域標籤另外看 token 相等)
  const tenant = hosted ? host.slice(0, host.length - reg.length - 1).split(".").pop() : null;
  if (hosted && !tenant) return null;
  // 託管平台上只有白名單(OFFICIAL_TENANTS)是官方;租戶名剛好等於品牌(blave.github.io、binance.github.io)不是我們 / 他們的帳號,當仿冒
  if (hosted && brands.has(tenant)) return { like: brands.get(tenant) };
  const first = hosted ? tenant : reg.split(".")[0];
  const body = hosted ? tenant : host.slice(0, host.length - reg.slice(reg.indexOf(".") + 1).length - 1);
  // 正牌網域整段出現在別人的網域前面(crypto.com.evil.io、login.binance.com.evil.io):通用字品牌也算
  for (const r of regs) if (host.startsWith(r + ".") || host.includes("." + r + ".")) return { like: r };
  for (const [b, r] of brands) {
    const generic = GENERIC_BRANDS.has(b);
    // ④ 同品牌、不同頂級網域:只用在交易所與券商品牌(銀行、金流的名字跟一般組織撞名太多:paypal.me、stripe.dev、post.ch);
    //   託管平台上租戶名剛好等於品牌(okx.github.io 這類)不算
    if (first === b) {
      if (SAME_BRAND_OTHER_TLD && !hosted && !generic && !SAME_BRAND_EXEMPT.has(b) && (EXCHANGE_BRANDS().has(b) || BROKER_BRANDS().has(b) || ALWAYS_EMBED.has(b))) return { like: r };   // blave 自己也算
      continue;
    }
    if (generic) continue;
    // ⑥ 品牌名嵌在別人的網域裡:只在旁邊帶詐騙常用字時擋(binance-login.xyz、okxsupport.net);blave 是我們自己,任何嵌入都擋
    if (embedScam(body, b)) return { like: r };
    // ② 常見替換
    if (first.length >= 4 && canon(first) === canon(b)) return { like: r };
    // ③ 編輯距離:只比 ≥7 字的交易所品牌,字首相同,長度差 ≤1(打錯字型的釣魚);距離 1(≥10 字才放寬到 2)
    if (b.length >= 7 && EXCHANGE_BRANDS().has(b) && first[0] === b[0] && Math.abs(first.length - b.length) <= 1) {
      const cap = b.length >= 10 ? 2 : 1;
      if (editDist(first, b, cap) <= cap) return { like: r };
    }
  }
  return null;
}

/**
 * 【網路層】一個請求能不能出去。回 null = 放行;否則 { reason }。
 * kind: "main"(主 frame 導覽)| "sub"(子資源)。data:/blob: 只准子資源(頁面自己的圖、worker)。
 */
function network(raw, kind) {
  let u; try { u = new URL(String(raw)); } catch (_) { return { reason: "scheme" }; }
  const p = u.protocol;
  if (p === "data:" || p === "blob:") return kind === "sub" ? null : { reason: "scheme" };
  if (p !== "http:" && p !== "https:" && p !== "ws:" && p !== "wss:") return { reason: "scheme" };
  if ((p === "ws:" || p === "wss:") && kind === "main") return { reason: "scheme" };
  if (u.username || u.password) return { reason: "credentials_in_url" };
  if (privateHost(u.hostname)) return { reason: "private_address", host: u.hostname };
  if (u.port && u.port !== "80" && u.port !== "443") return { reason: "port", host: u.hostname };
  if (kind === "main") { const lk = lookalike(u.hostname); if (lk) return { reason: "lookalike", host: u.hostname, like: lk.like }; }
  if (ADS.some((d) => d.includes("/") ? (hostOn(u.hostname, d.split("/")[0]) && u.pathname.startsWith("/" + d.split("/").slice(1).join("/"))) : hostOn(u.hostname, d))) return { reason: "ads", host: u.hostname };
  return null;
}

// 路徑第一段是語系(/en/、/zh-TW/)時看第二段。不用「任兩個字母」:/my/ 是 Binance 的帳戶區,不能被當成語系跳過
const LOCALE_RE = /^(en|zh|ja|ko|es|fr|de|ru|pt|it|tr|vi|th|id|ar|pl|uk|nl|ms|fil|[a-z]{2}-[a-z0-9]{2,4})$/;
function exchangePublic(u) {
  const host = lc(u.hostname), reg = registrable(host);
  const rawPath = u.pathname + (u.hash || "");
  // 編碼過的分隔符 / 點、反斜線:後端可能解碼後落到別的路徑,一律當未知(fail-closed)
  if (/%2f|%5c|%2e|\\/i.test(rawPath)) return false;
  // 其他百分比編碼(%6Dy = my)先解碼再比;解不開就當未知
  const dec = (x) => { try { return decodeURIComponent(x); } catch (_) { return null; } };
  const segs = u.pathname.toLowerCase().split("/").filter(Boolean).map(dec);
  if (segs.includes(null)) return false;
  // hash 路由(#/my/wallet、#!/balance):SPA 的真正路徑在這裡,一起丟進後台擋單比對
  const hashSegs = /^#!?\//.test(u.hash || "") ? u.hash.replace(/^#!?/, "").split(/[?#]/)[0].toLowerCase().split("/").filter(Boolean) : [];
  const strip = (a) => (a.length && LOCALE_RE.test(a[0]) ? a.slice(1) : a);
  const rest = strip(segs);
  if (rest.concat(strip(hashSegs)).some((x) => EXCHANGE_BACKEND_SEGMENTS.has(x))) return false;
  // 公開子網域要完整比對:academy.binance.com 才算,support.accounts.binance.com 不算
  const sub = host.endsWith("." + reg) ? host.slice(0, -reg.length - 1) : "";
  // 子網域本身是後台(accounts.、api.、app.、m.、trade.…):不管路徑都擋
  if (sub.split(".").some((l) => EXCHANGE_BACKEND_SEGMENTS.has(l) || EXCHANGE_BACKEND_HOSTS.has(l))) return false;
  if (EXCHANGE_PUBLIC_SUBDOMAINS.has(sub)) return true;
  const first = rest[0];
  // 首頁只認主站、而且不帶查詢字串與 fragment(?page=account、#/balance 都可能是登入後的畫面)
  if (!first) return (sub === "www" || sub === "") && !u.search && !u.hash;
  return EXCHANGE_PUBLIC_SEGMENTS.has(first) || /^(announcement|support|help|fee)[a-z-]*$/.test(first);   // announcement-info、support-center 這類變體
}

// 【工具層】身分提供者的登入 / 授權頁:agent 被網頁誘導去按「Allow」就等於替攻擊者的 app 拿到用戶的帳號授權
const IDP_HOSTS = ["accounts.google.com", "login.microsoftonline.com", "login.live.com", "appleid.apple.com", "idmsa.apple.com", "login.yahoo.com", "auth.line.me", "access.line.me"];
// 【工具層】IdP 的帳戶面(稽核 B-P1-1,Wei 拍板):OAuth 子視窗登入後,IdP session cookie 留在
// agent 的 partition——信箱/雲端硬碟/帳戶設定從此都是登入態,agent 導覽一律擋。
// 只擋 agent(工具層):用戶自己接手要去哪都行;OAuth 子視窗不走 agent(),也不受此擋。
const IDP_ACCOUNT_HOSTS = ["mail.google.com", "myaccount.google.com", "drive.google.com", "contacts.google.com", "calendar.google.com",
  "icloud.com", "outlook.office.com", "outlook.live.com", "accountscenter.facebook.com"];
const IDP_ACCOUNT_PATHS = [["facebook.com", /^\/settings(\/|$)/]];
const IDP_PATHS = [["github.com", /^\/login(\/|$)/], ["x.com", /^\/i\/oauth2/], ["twitter.com", /^\/i\/oauth2/], ["api.twitter.com", /^\/oauth/], ["api.x.com", /^\/oauth/],
  ["www.facebook.com", /^\/(v[\d.]+\/)?dialog\/oauth/], ["discord.com", /^\/oauth2/], ["www.linkedin.com", /^\/oauth/], ["www.reddit.com", /^\/api\/v1\/authorize/]];
/** OAuth / OIDC 授權請求:IdP 的登入授權頁,或任何網站上帶 client_id + (redirect_uri | response_type) 的網址。 */
function oauthPage(u) {
  const h = lc(u.hostname);
  if (IDP_HOSTS.some((d) => hostOn(h, d))) return true;
  if (IDP_PATHS.some(([d, re]) => h === d && re.test(u.pathname))) return true;
  const q = u.searchParams;
  return q.has("client_id") && (q.has("redirect_uri") || q.has("response_type"));
}

/**
 * 【工具層】agent 能不能對這個網址動手(開、讀、點)。回 null = 可以;否則 { reason, host }。
 * 先過 network(),再過 agent 專屬的清單。
 */
function agent(raw) {
  const n = network(raw, "main");
  if (n) return n;
  const u = new URL(String(raw)), h = lc(u.hostname);
  if (u.protocol !== "http:" && u.protocol !== "https:") return { reason: "scheme", host: h };
  if (hostOn(h, "blave.org")) return { reason: "blave", host: h };
  if (AGENT_BLOCKLIST.some((d) => hostOn(h, d))) return { reason: "blocklist", host: h };
  if (oauthPage(u)) return { reason: "oauth", host: h };
  if (IDP_ACCOUNT_HOSTS.some((d) => hostOn(h, d))) return { reason: "sensitive_domain", host: h };
  if (IDP_ACCOUNT_PATHS.some(([d, re]) => hostOn(h, d) && re.test(u.pathname))) return { reason: "sensitive_domain", host: h };
  if (BANKS.some((d) => hostOn(h, d)) || BROKERS.some((d) => hostOn(h, d)) || PAYMENTS.some((d) => hostOn(h, d))) return { reason: "sensitive_domain", host: h };
  if (EXCHANGES.some((d) => hostOn(h, d)) && !exchangePublic(u)) return { reason: "sensitive_domain", host: h };
  return null;
}

/**
 * 【用戶自己按「用系統瀏覽器開」】這個網址能不能交給系統瀏覽器。回 null = 可以;否則 { reason, host }。
 * 那是用戶自己的瀏覽器、自己的操作:agent 不准碰的敏感網域(交易所與券商後台、銀行、登入授權頁)、blave.org、廣告網域照開。
 * 有危害的不開:不是 http(s)、網址帶帳密、本機 / 內網位址、非標準埠、相似網域、有危害的網站名單。
 */
const EXTERNAL_DENY = ["scheme", "credentials_in_url", "private_address", "port", "lookalike", "blocklist"];
function external(raw) {
  let u; try { u = new URL(String(raw)); } catch (_) { return { reason: "scheme" }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { reason: "scheme", host: lc(u.hostname) };
  const a = agent(u.href);
  return a && EXTERNAL_DENY.includes(a.reason) ? a : null;
}
/**
 * 這個分頁要交給系統瀏覽器的網址,或 null(不開)。tab = 分頁紀錄;live = 分頁當下的網址(webContents.getURL())——
 * 頁面自己換過網址(pushState)之後以它為準;被擋下、打不開的頁停在 about:blank,用紀錄的那個。
 * 等用戶確認的網址(need.kind === "confirm")還沒放行:不開。renderer 只給分頁 id,網址從來不由它說。
 */
function externalUrl(tab, live) {
  if (!tab || typeof tab !== "object") return null;
  if (tab.need && tab.need.kind === "confirm" && !tab.userDone) return null;
  const now = typeof live === "string" && /^https?:\/\//i.test(live) ? live : "";
  const url = now || (typeof tab.url === "string" ? tab.url : "");
  return url && !external(url) ? url : null;
}

/**
 * 引用圖的出處網址(browser_capture):報告契約 1.6 的 image.source.url 規則照外部連結——https、有主機、不帶帳密、
 * ≤500 字、不含空白與控制字元。在擷取當下擋:圖存下去之後才被 api 以 400 拒收,整份報告會進 failed/。
 * 回 null = 可以引用;否則 "scheme" | "credentials" | "long" | "format"。
 */
function citable(raw) {
  const s = String(raw == null ? "" : raw);
  if (s.length > 500) return "long";
  if (/[\s\p{Cc}]/u.test(s)) return "format";
  let u; try { u = new URL(s); } catch (_) { return "scheme"; }
  if (u.protocol !== "https:" || !u.hostname) return "scheme";
  if (u.username || u.password) return "credentials";
  return null;
}

/**
 * 引用圖出處網址的清理(稽核 S1):報告會被公開分享,網址裡的祕密(簽章網址、OAuth 回跳留下的 token、私人儀表板的 key)
 * 不能跟著出去。寧可多剝:剝掉之後頁面開不出同一個畫面,比 token 公開好。
 * query:名稱命中的參數拿掉;fragment:看起來像參數串而且有一個命中,整段拿掉。解析不了就原樣回(由 citable 擋)。
 */
const SECRET_KEYS = new Set([
  "token", "key", "apikey", "sig", "signature", "sign", "secret", "session", "sessionid", "sid", "auth", "authorization",
  "password", "passwd", "pwd", "pass", "jwt", "otp", "ticket", "credential", "credentials",
]);   // code / state 不列:一次性、短效,而且 ?code=2330 這種股票代號頁很常見
const SECRET_TAILS = ["token", "secret", "signature", "apikey", "password", "sessionid"];
const SECRET_HEADS = ["xamz", "xgoog"];
function secretKey(k) {
  const n = lc(k).replace(/[^a-z0-9]/g, "");
  return SECRET_KEYS.has(n) || SECRET_TAILS.some((x) => n.endsWith(x)) || SECRET_HEADS.some((x) => n.startsWith(x));
}
function citeUrl(raw) {
  const s = String(raw == null ? "" : raw);
  let u; try { u = new URL(s); } catch (_) { return s; }
  let cut = false;
  for (const k of [...new Set(u.searchParams.keys())]) if (secretKey(k)) { u.searchParams.delete(k); cut = true; }
  const f = u.hash.slice(1);
  if (f.includes("=") && f.split(/[?&;]/).some((p) => secretKey(decodeSafe(p.split("=")[0])))) { u.hash = ""; cut = true; }
  return cut ? u.href : s;
}
function decodeSafe(x) { try { return decodeURIComponent(x); } catch (_) { return x; } }

module.exports = { network, agent, external, externalUrl, EXTERNAL_DENY, citable, citeUrl, lookalike, SCAM_WORDS, privateHost, resolvesPrivate, exfilRisk, EXFIL_TAIL_MAX, registrable, hostOn, AGENT_BLOCKLIST, EXCHANGES, EXCHANGE_PUBLIC_SEGMENTS, EXCHANGE_BACKEND_SEGMENTS, BROKERS, BANKS, PAYMENTS, ADS };
