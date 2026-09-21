// Binance 金鑰重查出事的本機通知(shell/main.js binanceNotify):共用呈現路徑的單元測試。
// Electron 42 起沒簽章的包不出通知,發佈包又不該有測試鉤子——所以這條只用「注入假的 Notification」驗:
// 標題 / 內文、全是 P2 所以不亮 Dock 紅點、真的交給系統才回 true、failed 要留 log。**不加任何執行期鉤子**(這份檢查也釘住這一點)。
// 跑法:node tests/check_shell_bn_notify.js
const fs = require("fs"), path = require("path"), vm = require("vm");
let red = 0; const t = (n, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) red++; };
const S = path.join(__dirname, "..", "shell");
const mainSrc = fs.readFileSync(path.join(S, "main.js"), "utf8");
const cut = (src, name) => { const i = src.indexOf("function " + name + "("); if (i < 0) throw new Error("no " + name); let d = 0; for (let k = src.indexOf("{", i); k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}" && --d === 0) return src.slice(i, k + 1); } throw new Error("unbalanced " + name); };

{ const mk = (o = {}) => { const made = [], logs = []; let badge = null;
    class FakeN { constructor(a) { this.a = a; this.h = {}; this.shown = false; made.push(this); } on(ev, fn) { (this.h[ev] = this.h[ev] || []).push(fn); return this; } show() { this.shown = true; } emit(ev, ...a) { (this.h[ev] || []).forEach((f) => f(...a)); } static isSupported() { return o.supported !== false; } }
    const ctx = { Notification: FakeN, tmLabels: o.labels || { key_ipTitle: "IP 換了", key_ipBody: "新的 IP 是 {ip}", key_rejTitle: "金鑰被拒", key_rejSameIpBody: "b1", key_rejUnknownBody: "b2", key_permTitle: "交易權限沒了", key_permBody: "b3" },
      p1Alive: new Set(), p1Badge: 0, shown: 0, showMain: () => { ctx.shown++; }, BrowserWindow: { getFocusedWindow: () => (o.focused ? {} : null) }, app: { dock: { setBadge: (v) => { badge = v; } } }, console: { error: (m) => logs.push(m) } };
    vm.createContext(ctx); vm.runInContext(cut(mainSrc, "notifWatch") + "\n" + cut(mainSrc, "binanceNotify"), ctx);
    return { ctx, made, logs, badge: () => badge, call: (v) => vm.runInContext("binanceNotify(" + JSON.stringify(v) + ")", ctx) }; };
  let x = mk(); let r = x.call({ reason: "TRADING_LOST", level: "P2", ip: null });
  t("交易權限沒了(P2):真的 show、標題內文對、回 true、不亮 Dock 紅點", r === true && x.made.length === 1 && x.made[0].shown && x.made[0].a.title === "交易權限沒了" && x.made[0].a.body === "b3" && x.badge() === null);
  x = mk(); r = x.call({ reason: "IP_CHANGED", level: "P2", ip: "203.0.113.7" });
  t("IP 換了(P2):{ip} 代進去、不亮紅點", r === true && x.made[0].a.body === "新的 IP 是 203.0.113.7" && x.badge() === null);
  x = mk(); t("MVP 不做「提領後來被打開」那一則:沒有這個 reason 的字、叫了也不發;就算有人傳 level:P1 也不亮紅點", x.call({ reason: "WITHDRAW_ENABLED", level: "P1" }) === false && x.made.length === 0 && x.call({ reason: "IP_CHANGED", level: "P1", ip: "1.1.1.1" }) === true && x.badge() === null && !/key_wd|WITHDRAW_ENABLED/.test(cut(mainSrc, "binanceNotify")));
  x = mk(); x.call({ reason: "IP_CHANGED", level: "P2", ip: "$&$1" });
  t("{ip} 用函式代入:$& 這類替換樣式不會被展開", x.made[0].a.body === "新的 IP 是 $&$1");
  x = mk(); t("四種 reason 都有對應的字;表外的 reason 不發、回 false", ["IP_CHANGED", "KEY_REJECTED", "REJECTED", "TRADING_LOST"].every((k) => x.call({ reason: k, level: "P2" }) === true) && x.call({ reason: "constructor" }) === false && x.call({ reason: "NOPE" }) === false && x.call(null) === false);
  x = mk({ labels: {} }); t("字還沒交過來 → 不發、回 false(binance_link 不會記成已通知,下一輪再試)", x.call({ reason: "TRADING_LOST", level: "P2" }) === false && x.made.length === 0);
  x = mk({ supported: false }); t("系統不支援通知 → 不發、回 false", x.call({ reason: "TRADING_LOST", level: "P2" }) === false && x.made.length === 0);
  x = mk(); x.call({ reason: "TRADING_LOST", level: "P2" }); x.made[0].emit("failed", {}, "not signed");
  t("failed:留一行 log(含哪一種)、從存活集合拿掉", x.logs.length === 1 && /binance TRADING_LOST failed: not signed/.test(x.logs[0]) && x.ctx.p1Alive.size === 0);
  x = mk(); x.call({ reason: "TRADING_LOST", level: "P2" }); x.made[0].emit("click");
  t("點通知:把視窗叫回來", x.ctx.shown === 1 && x.ctx.p1Alive.size === 0);
  t("沒有執行期的測試鉤子(合成 verdict 的環境變數 / IPC 一律不存在)", !/BLAVE_TEST_BN|TEST_VERDICT|binance-test/i.test(mainSrc) && !/BLAVE_TEST_BN|TEST_VERDICT/i.test(fs.readFileSync(path.join(S, "binance_link.js"), "utf8"))); }

console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
