// shell/binance_check.js:連接 Binance 時的權限判讀與定期重查。不打真的 Binance(http 是假的)。
// 跑法:node tests/check_shell_binance_check.js
const crypto = require("crypto");
const { classify, check, recheck, recheckVerdict, nextPrev, sign, VERDICT_LEVEL } = require("../shell/binance_check.js");
let red = 0; const t = (n, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) red++; };
const ok200 = (b) => ({ status: 200, body: { ipRestrict: true, createTime: 1700000000000, enableReading: true, enableWithdrawals: false, enableSpotAndMarginTrading: true, enableFutures: true, ...b } });
(async () => {
  t("全對:有白名單、合約開、提領關 → OK", classify(ok200(), "futures").code === "OK" && classify(ok200(), "futures").ok === true);
  t("提領開著 → 不存(就算其他都對)", classify(ok200({ enableWithdrawals: true }), "futures").code === "WITHDRAW_ENABLED" && classify(ok200({ enableWithdrawals: true }), "spot").ok === false);
  t("沒設白名單的一般 key:交易權限全關 → TRADING_DISABLED", classify(ok200({ ipRestrict: false, enableSpotAndMarginTrading: false, enableFutures: false }), "futures").code === "TRADING_DISABLED");
  t("現貨開、合約沒開、要做合約 → FUTURES_DISABLED(白名單沒問題,是 Futures 那格)", classify(ok200({ enableFutures: false }), "futures").code === "FUTURES_DISABLED");
  t("做現貨只看現貨那一格", classify(ok200({ enableFutures: false }), "spot").code === "OK" && classify(ok200({ enableSpotAndMarginTrading: false }), "spot").code === "TRADING_DISABLED");
  t("交易開著但沒有白名單(用戶自己關了安全管控):放行但帶提醒", (() => { const r = classify(ok200({ ipRestrict: false }), "futures"); return r.ok === true && r.code === "NO_IP_RESTRICT" && r.detail.warn === true; })());
  t("200 但不是權限物件(空物件、HTML 字串、欄位型別不對):不下結論 = UNKNOWN,不是「交易權限沒了」", classify({ status: 200, body: {} }, "futures").code === "UNKNOWN" && classify({ status: 200, body: "<html>" }, "futures").code === "UNKNOWN"
    && classify(ok200({ enableFutures: "true" }), "futures").code === "UNKNOWN" && classify(ok200({ ipRestrict: 1 }), "futures").code === "UNKNOWN");
  t("提領那一格缺席或不是 boolean → 不放行(這是「提領開著不存」唯一的一道檢查)", (() => { const b = ok200().body; delete b.enableWithdrawals; const r = classify({ status: 200, body: b }, "futures"); return r.ok === false && r.code === "UNKNOWN"; })()
    && classify(ok200({ enableWithdrawals: "false" }), "futures").ok === false);
  t("優先序:提領開著且交易關著 → WITHDRAW_ENABLED", classify(ok200({ enableWithdrawals: true, enableFutures: false, enableSpotAndMarginTrading: false }), "futures").code === "WITHDRAW_ENABLED");
  t("429 / 418 = RATE_LIMITED(呼叫端要退讓)", classify({ status: 429, body: { code: -1003 } }, "futures").code === "RATE_LIMITED" && classify({ status: 418, body: {} }, "futures").code === "RATE_LIMITED");
  const E = (code, status = 400) => classify({ status, body: { code, msg: "x" } }, "futures").code;
  t("錯誤碼對應:-2015 / -2014 / -1022 / -1021 / 其他", E(-2015, 401) === "IP_OR_KEY" && E(-2014) === "BAD_KEY_FORMAT" && E(-1022) === "BAD_SECRET" && E(-1021) === "CLOCK" && E(-9999) === "UNKNOWN" && classify({ status: 500, body: "oops" }, "futures").code === "UNKNOWN");
  t("連不上 = NETWORK", classify(null, "futures").code === "NETWORK" && classify({}, "futures").code === "NETWORK");

  let seen = null;
  const r = await check({ apiKey: "K", secret: "S", market: "futures", now: () => 1700000000000, http: async (url, h) => { seen = { url, h }; return ok200(); } });
  const q = "timestamp=1700000000000&recvWindow=10000";
  t("請求:打官方現貨主機的 apiRestrictions、簽章正確、key 放 header、secret 不出現在網址", r.code === "OK" && seen.url === `https://api.binance.com/sapi/v1/account/apiRestrictions?${q}&signature=${crypto.createHmac("sha256", "S").update(q).digest("hex")}`
    && seen.h["X-MBX-APIKEY"] === "K" && !seen.url.includes("=S&") && sign("S", q).length === 64);
  t("http 丟例外 = NETWORK,不炸", (await check({ apiKey: "K", secret: "S", http: async () => { throw new Error("offline"); } })).code === "NETWORK");
  const LONG = "s3cr3t-" + "x".repeat(40);
  let seen2 = null; const r2 = await check({ apiKey: "K", secret: LONG, http: async (url, h) => { seen2 = { url, h }; return ok200(); } });
  t("secret 不出現在網址、任何 header、回傳值裡", !seen2.url.includes(LONG) && !JSON.stringify(seen2.h).includes(LONG) && !JSON.stringify(r2).includes(LONG) && Object.keys(seen2.h).join() === "X-MBX-APIKEY");
  t("market any(連接畫面):現貨或合約至少開一個就收,細節帶哪個沒開;兩個都沒開才 TRADING_DISABLED;提領照擋", (() => { const a = classify(ok200({ enableFutures: false }), "any"), b = classify(ok200({ enableSpotAndMarginTrading: false }), "any");
    return a.ok && a.detail.futures === false && a.detail.spot === true && b.ok && b.detail.spot === false && classify(ok200({ enableFutures: false, enableSpotAndMarginTrading: false }), "any").code === "TRADING_DISABLED" && classify(ok200({ enableWithdrawals: true }), "any").code === "WITHDRAW_ENABLED"; })());
  t("testnet 旗標不是檢查的開關(稽核 S3):呼叫端帶 testnet:true 也照樣打正式站、照樣擋提領", await (async () => { let url = ""; const x = await check({ apiKey: "K", secret: "S", testnet: true, http: async (u) => { url = u; return ok200({ enableWithdrawals: true }); } }); return x.ok === false && x.code === "WITHDRAW_ENABLED" && url.indexOf("https://api.binance.com/") === 0; })());
  t("market 只認 spot / futures(\"SPOT\" 這種寫法直接丟錯,不默默當成合約)", await (async () => { try { await check({ apiKey: "K", secret: "S", market: "SPOT", http: async () => ok200() }); return false; } catch (_) { return true; } })());
  t("空的 key / secret 不發請求", await (async () => { let called = false; const x = await check({ apiKey: "", secret: "S", http: async () => { called = true; } }); return x.code === "BAD_KEY_FORMAT" && !called; })());

  const OK = { ok: true, code: "OK" }, bad = (code) => ({ ok: false, code });
  t("重查:原本可以、現在 -2015 且對外 IP 換了 → IP_CHANGED", recheckVerdict(OK, bad("IP_OR_KEY"), "1.1.1.1", "2.2.2.2").reason === "IP_CHANGED");
  t("重查:-2015、兩次 IP 都拿得到且沒變 → KEY_REJECTED", recheckVerdict(OK, bad("IP_OR_KEY"), "1.1.1.1", "1.1.1.1").reason === "KEY_REJECTED");
  t("重查:-2015 但對外 IP 拿不到 → 中性的 REJECTED(不猜是金鑰被刪)", recheckVerdict(OK, bad("IP_OR_KEY"), null, "1.1.1.1").reason === "REJECTED" && recheckVerdict(OK, bad("IP_OR_KEY"), "1.1.1.1", "").reason === "REJECTED");
  t("重查:每一種判讀都要求兩次確認", [recheckVerdict(OK, bad("IP_OR_KEY"), "1", "2"), recheckVerdict(OK, bad("TRADING_DISABLED"))].every((v) => v.confirm === true));
  let pv = OK; pv = nextPrev(pv, bad("NETWORK")); const third = recheckVerdict(pv, bad("IP_OR_KEY"), "1.1.1.1", "1.1.1.1");
  t("三步序列 OK → 斷網 → -2015:斷網不蓋掉上一次的結論,第三步照樣叫人", pv === OK && third && third.reason === "KEY_REJECTED");
  t("nextPrev:沒結論的(斷網/時鐘/限速/不明/testnet)都不覆寫,有結論的才覆寫", ["NETWORK", "CLOCK", "UNKNOWN", "RATE_LIMITED", "SKIPPED_TESTNET"].every((c) => nextPrev(OK, { ok: c === "SKIPPED_TESTNET", code: c }) === OK) && nextPrev(OK, bad("TRADING_DISABLED")).code === "TRADING_DISABLED");
  t("重查:交易權限沒了 = TRADING_LOST;全部是 P2", (() => { const a = recheckVerdict(OK, bad("TRADING_DISABLED")), f = recheckVerdict(OK, bad("FUTURES_DISABLED"));
    return a.reason === "TRADING_LOST" && a.level === "P2" && f.reason === "TRADING_LOST" && a.confirm === true && Object.keys(VERDICT_LEVEL).every((k) => VERDICT_LEVEL[k] === "P2"); })());
  // MVP 不做「提領後來被打開」那一則(Wei 拍板):重查不看提領那一格;連接當下照舊擋
  t("重查時提領開著 → 沒有 verdict、表上也沒有這個 reason", recheckVerdict(OK, bad("WITHDRAW_ENABLED")) === null && !("WITHDRAW_ENABLED" in VERDICT_LEVEL)
    && classify(ok200({ enableWithdrawals: true }), "any", true).ok === true && classify(ok200({ enableWithdrawals: true, enableSpotAndMarginTrading: false, enableFutures: false }), "any", true).code === "TRADING_DISABLED");
  t("連接時提領開著 → 仍然不存;check() 沒有任何參數跳得過(standing / recheck / testnet 塞進物件都沒用)", await (async () => { const http = async () => ok200({ enableWithdrawals: true });
    const a = await check({ apiKey: "K", secret: "S", market: "any", http }), b = await check({ apiKey: "K", secret: "S", market: "any", http, standing: true, recheck: true, testnet: true }), c = await check({ apiKey: "K", secret: "S", market: "any", http }, true);
    const r = await recheck({ apiKey: "K", secret: "S", market: "any", http });
    return a.code === "WITHDRAW_ENABLED" && a.ok === false && b.code === "WITHDRAW_ENABLED" && c.code === "WITHDRAW_ENABLED" && r.ok === true; })());
  t("重查仍然要求四個欄位都是 boolean(提領那格缺席 / 不是 boolean → 不下結論)", classify(ok200({ enableWithdrawals: undefined }), "any", true).code === "UNKNOWN" && classify(ok200({ enableWithdrawals: "false" }), "any", true).code === "UNKNOWN");
  t("重查:存著的金鑰對不上(-1022 / -2014)歸金鑰被拒,不掉進權限類;-2015 三種都是 P2", recheckVerdict(OK, bad("BAD_SECRET")).reason === "KEY_REJECTED" && recheckVerdict(OK, bad("BAD_KEY_FORMAT")).reason === "KEY_REJECTED"
    && ["1.1.1.1|2.2.2.2", "1.1.1.1|1.1.1.1", "|"].every((p) => recheckVerdict(OK, bad("IP_OR_KEY"), p.split("|")[0] || null, p.split("|")[1] || null).level === "P2"));
  t("重查:斷網、時鐘、不明錯誤都不叫人(不因為斷網就停單)", [bad("NETWORK"), bad("CLOCK"), bad("UNKNOWN"), bad("RATE_LIMITED")].every((c) => recheckVerdict(OK, c, "1", "2") === null));
  t("重查:本來就不行的、或現在還是好的 → 沒事", recheckVerdict(bad("TRADING_DISABLED"), bad("TRADING_DISABLED")) === null && recheckVerdict(OK, OK) === null && recheckVerdict(null, bad("IP_OR_KEY")) === null
    && recheckVerdict({ ok: true, code: "NO_IP_RESTRICT" }, { ok: true, code: "OK" }) === null);
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "shell", "binance_check.js"), "utf8");
  t("這個檔不寫檔、不 log、不 require electron", !/require\("(fs|electron)"\)|console\.|writeFile/.test(src));
  console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
})();
