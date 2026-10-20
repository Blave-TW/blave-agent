// 沒綁卡(NO_CARD)的預檢卡與 402 卡:綁卡之外多一顆「用加密貨幣轉帳儲值」文字鈕,外開網站用量頁的加密分頁、記 feature_used crypto_topup。
// 不打 api、不開 Electron。跑法:node tests/check_shell_crypto_topup.js
const fs = require("fs"), path = require("path");
const SHELL = path.join(__dirname, "..", "shell");
const app = fs.readFileSync(path.join(SHELL, "renderer", "app.js"), "utf8");
const { EVENTS } = require(path.join(SHELL, "telemetry.js"));
const { en, zh } = new Function(fs.readFileSync(path.join(SHELL, "renderer", "strings.js"), "utf8") + "; return STRINGS;")();
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };
const fn = (name) => { const i = app.indexOf("function " + name + "("); if (i < 0) throw new Error("找不到 " + name); let d = 0; for (let k = app.indexOf("{", app.indexOf(")", i)); k < app.length; k++) { if (app[k] === "{") d++; else if (app[k] === "}" && --d === 0) return app.slice(i, k + 1); } throw new Error("切不出 " + name); };
const line = (re) => { const m = app.match(re); if (!m) throw new Error("找不到 " + re); return m[0]; };

// 真的跑 acctAction / acctCrypto / acctPaint,卡片與外開都換成記錄器
const log = [];
const P = new Function("t", "acct", "acctCard", "creditCards", "LANG", "window", `let acctGone = null, dataCardSync = () => {}, mpBillPaint = undefined, planWatch = () => {}, libIdeaPaint = undefined, wdPaint = undefined, $ = () => null;
  const acctSub = () => null, resendSecond = () => ({ label: "fault.resend" }), resendState = (c, x) => ({ text: x }), acctShown = () => {}, acctBackTrack = () => {}, acctClicked = () => window.log.push("click"), acctFreeUpText = () => "", acctBuiltText = () => "", RP = { list: [] };
  ${fn("trackFeature")}\n${line(/^const acctUrl = .*$/m)}\n${line(/^const cryptoTopupUrl = .*$/m)}\n${fn("acctCardKind")}\n${fn("acctAction")}\n${fn("acctCrypto")}\n${fn("acctPaint")}\nacctPaint();`);
const mk = () => { const c = {}; c.set = (s) => { c.last = s; }; return c; };
const W = { log, blave: { trackFeature: (n) => log.push("t:" + n), openExternal: (u) => log.push("o:" + u) } };
const run = (acct, lang) => { const pre = mk(), turn = mk(); P((k) => k, acct, pre, [turn], lang || "zh", W); return [pre.last, turn.last]; };

{
  const [pre, turn] = run({ can_run: false, reason: "NO_CARD" });
  ok("NO_CARD:兩張卡都是「前往綁卡」+「用加密貨幣轉帳儲值」;402 卡的「再送一次」還在",
    pre.label === "acct.addCard" && pre.third && pre.third.label === "acct.cryptoTopup" && turn.label === "acct.addCard" && turn.third && turn.third.label === "acct.cryptoTopup" && turn.second && turn.second.label === "fault.resend", [pre, turn]);
  log.length = 0; pre.third.on();
  ok("按加密鈕:只記 crypto_topup(不進綁卡漏斗 acct_card_click)、外開 ?from=desktop&pay=crypto#topup",
    log.join() === "t:crypto_topup,o:https://blave.org/agent/zh/usage?from=desktop&pay=crypto#topup", log);
  log.length = 0; run({ can_run: false, reason: "NO_CARD" }, "en")[1].third.on();
  ok("網址跟著介面語言", log[1] === "o:https://blave.org/agent/en/usage?from=desktop&pay=crypto#topup", log);
  log.length = 0; pre.on();
  ok("綁卡鈕不變:記 acct_card_click、外開原本的 ?from=desktop#topup", log.join() === "click,o:https://blave.org/agent/zh/usage?from=desktop#topup", log);
}
{
  const [pre, turn] = run({ can_run: false, reason: "NO_CREDIT" });
  ok("NO_CREDIT(有卡沒餘額)不出加密鈕", !pre.third && !turn.third, [pre, turn]);
  const [p2, t2] = run({ can_run: true });
  ok("能跑時不出加密鈕", !p2.third && !t2.third, [p2, t2]);
}
ok("faultCard 有第三格文字鈕,沒給 third 就藏起來;third 進重畫的比對 key",
  /const b3 = document\.createElement\("button"\); b3\.type = "button"; b3\.className = "btn-quiet"; b3\.hidden = true;/.test(app)
  && /b3\.hidden = !s\.third;/.test(app) && /s\.third \? s\.third\.label : null/.test(fn("faultCard")));
ok("crypto_topup 在 feature_used 白名單、≤16 字", EVENTS.feature_used.name.includes("crypto_topup") && "crypto_topup".length <= 16);
ok("字串 acct.cryptoTopup:zh 用「加密貨幣轉帳」這個對外名稱、en 有", zh["acct.cryptoTopup"] === "用加密貨幣轉帳儲值" && !!en["acct.cryptoTopup"] && !/USDT/.test(zh["acct.cryptoTopup"] + en["acct.cryptoTopup"]));
console.log(red ? `\n${red} FAILED` : "\nALL PASS"); process.exit(red ? 1 : 0);
