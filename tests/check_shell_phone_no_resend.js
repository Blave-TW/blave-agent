// 手機那一輪失敗:電腦上的錯誤卡不出〔再送一次〕、按到也不送。舊碼 resendLast 送的是 lastUserText——上一輪電腦前那句,
// 可能是另一道下單指令。改送手機那句也不行:手機那邊可能已經自己重送,同一句會跑兩次。
// 照原文切出 tabsOnEvent 與重送那幾支實跑。跑法:node tests/check_shell_phone_no_resend.js
const fs = require("fs"), path = require("path");
const R = path.join(__dirname, "..", "shell", "renderer");
const app = fs.readFileSync(path.join(R, "app.js"), "utf8"), ct = fs.readFileSync(path.join(R, "chattabs.js"), "utf8");
const fnOf = (src, name) => { const i = src.search(new RegExp("(async )?function " + name + "\\(")); if (i < 0) throw new Error("找不到 " + name); return src.slice(i, src.indexOf("\n}", i) + 2); };
const lineOf = (src, re) => { const m = src.match(re); return m ? m[0] : ""; };
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };

const sent = [];
const env = {
  T: { sid: "s1" }, CS: { main: new Map() }, MP: { model: null }, t: (k) => k,
  tabsOf: () => env.T, tabsQueued() {}, tabsPaint() {}, withTab: (_T, fn) => fn(), busyStart() {}, busySendTell() {},
  submitMessage: (msg) => { sent.push(msg); return Promise.resolve(true); },
};
const names = ["canResend", "resendLast", "resendState", "resendSecond"].concat(/function turnFresh\(/.test(app) ? ["turnFresh"] : []);
const vars = "var running = false, turnSeq = 0, turnSeqMine = 0, liveBubble = null, faultShown = false, turnLimit = false, turnChanged = false, pendingErr = [], turnAiBubbles = [], turnFaultEl = null,"
  + " turnModel = null, turnGotReply = false, turnErrored = false, turnFaulted = false, turnCap = false, turnCards = [], turnBubble = null, turnHadTool = false, lastUserTyped = true, lastUserText = '幫我市價買 0.1 BTC', lastUserAttachments = [];";
const S = new Function("env", "with (env) { " + vars + "\n" + lineOf(app, /^const resendable = [^\n]*/m) + "\n" + names.map((n) => fnOf(app, n)).join("\n") + "\n" + fnOf(ct, "tabsOnEvent")
  + "\nreturn { ev: tabsOnEvent, end: () => { running = false; }, resendLast, resendState, resendSecond }; }")(env);

S.ev({ sid: "s1", type: "started" }); S.end();
(async () => {
  await S.resendLast();
  ok("手機那一輪失敗後按〔再送一次〕:不送出上一輪電腦前那句", sent.length === 0, sent);
  const st = S.resendState({ set() {} }, "可以了");
  ok("錯誤卡(resendState)不出〔再送一次〕鈕", !st.label, st.label);
  const sec = S.resendSecond();
  ok("額度卡的第二顆〔再送一次〕也不出", !(sec && sec.label), sec && sec.label);
  console.log(red ? "\n" + red + " FAIL" : "\nall PASS");
  process.exit(red ? 1 : 0);
})();
