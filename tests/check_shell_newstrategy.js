// 新增策略 modal(shell/renderer/newstrategy.js;spec-desktop-0.1.6 §4)。
//   ① 純邏輯(從原文切出來跑,不碰 DOM):nsCompose zh / en——只填週期(09-25 在雲端版實填 4h 量到的原句)、全填、全空 → ""、邏輯尾端的 。/ . 不重複、
//      空格跳過;字串表 ns.* 逐字同 web 的 workspace_ns_*(previewEmpty 除外:只放「—」佔位)。
//   ② 接線(原文):index.html 的 ＋ / chip / 框的骨架與載入順序;trapTab 擴到 input / textarea;escTop 鏈有 #ns-scrim;telemetry 白名單有 strategy_new;沒有 innerHTML。
//   ③ 用隨包的 Electron 開真的 index.html:＋ 開框(焦點到名稱欄、空表單送出 disabled 且 aria-describedby 指到 ns-hint、預覽「—」)→ 填一格預覽即時 = 組句、送出 enabled →
//      送出 → 送到對話的就是那句、關框、表單清空、strategy_new;失敗 → 框留著、欄位不清、腳那一句;雲端視角三處目的地記號;停機 → 送出 disabled + 閘門句;
//      回合中 → disabled + turn.busy;策略庫連結關框開策略庫;歡迎頁 chip 開框不送訊息;Esc / 取消關框、焦點回 ＋。
// 跑法:node tests/check_shell_newstrategy.js(找不到 shell/node_modules 的 Electron 時 ③ SKIP,①② 照跑)
const fs = require("fs"), path = require("path"), vm = require("vm"), os = require("os");
const SHELL = path.join(__dirname, "..", "shell"), R = path.join(SHELL, "renderer");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + String(d).slice(0, 2000))); if (!c) red++; };
const read = (f) => fs.readFileSync(f, "utf8");
const src = read(path.join(R, "newstrategy.js")), appSrc = read(path.join(R, "app.js")), html = read(path.join(R, "index.html")), strings = read(path.join(R, "strings.js"));
const cutFn = (s, name) => { const i = s.indexOf("function " + name + "("); if (i < 0) throw new Error("no " + name); let d = 0; for (let k = s.indexOf("{", i); k < s.length; k++) { if (s[k] === "{") d++; else if (s[k] === "}" && --d === 0) return s.slice(i, k + 1); } throw new Error("unbalanced " + name); };
const STR = (() => { const sb = {}; vm.runInNewContext(strings + "\nthis.S = STRINGS;", sb); return sb.S; })();
// web 的字(逐字;web/app/translations/*/LC_MESSAGES/messages.po 的 workspace_ns_*,2026-09-25 抄下)
const WEB = {
  zh: { lead: "幫我建立策略", symbol: "標的", timeframe: "週期", indicators: "指標", logic: "邏輯", dflt: "加密貨幣標的未註明市場時，預設 USDT 本位永續合約。", hint: "至少填寫一項，其餘交給 agent 判斷。", previewEmpty: "（至少填寫一項）", submit: "送出到對話" },
  en: { lead: "Create a strategy", symbol: "Symbol", timeframe: "Timeframe", indicators: "Indicators", logic: "Logic", dflt: "For crypto symbols, default to USDT-margined perpetual futures unless stated otherwise.", hint: "Fill in at least one field — the agent works out the rest.", previewEmpty: "(fill in at least one field)", submit: "Send to Chat" },   // submit 依 canon 改 Title Case(設計稽核 建-2),不逐字同 web
};
const S = (L) => ({ lead: STR[L]["ns.msgLead"], symbol: STR[L]["ns.msgSymbol"], timeframe: STR[L]["ns.msgTimeframe"], indicators: STR[L]["ns.msgIndicators"], logic: STR[L]["ns.msgLogic"], dflt: STR[L]["ns.msgDefault"] });

if (!process.versions.electron) {
  // ── ① 純邏輯 ──
  const a = src.indexOf("/* ── 純邏輯("), b = src.indexOf("/* ── 純邏輯到此");
  if (a < 0 || b < 0) throw new Error("找不到純邏輯區塊的標記");
  const block = src.slice(a, b);
  ok("① 純邏輯區塊不碰 DOM / i18n", !/\bdocument\b|\$\(|window\.|\bt\(/.test(block.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")));
  const P = {}; vm.createContext(P); vm.runInContext(block.replace(/^const /gm, "var "), P);
  ["zh", "en"].forEach((L) => ok(`① ${L} ns.* 的組句字逐字同 web 的 workspace_ns_msg_* / hint;預覽空格只放「—」(規則講在頂端 ns.hint 一次,不逐字同 web 的 preview_empty)`, ["lead", "symbol", "timeframe", "indicators", "logic", "dflt"].every((k) => S(L)[k] === WEB[L][k]) && STR[L]["ns.hint"] === WEB[L].hint && STR[L]["ns.previewEmpty"] === "—" && STR[L]["ns.submit"] === WEB[L].submit));
  ok("① zh 只填週期 4h = 雲端版實填量到的原句", P.nsCompose({ timeframe: "4h" }, "zh", S("zh")) === "幫我建立策略。週期：4h。加密貨幣標的未註明市場時，預設 USDT 本位永續合約。");
  ok("① zh 全填:名稱進「」、每格一句、邏輯尾端的 。不重複、尾句", P.nsCompose({ name: "均線黃金交叉", symbol: "BTC", timeframe: "1h", indicators: "MA20、MA50", logic: "黃金交叉做多，死亡交叉平倉。" }, "zh", S("zh"))
    === "幫我建立策略「均線黃金交叉」。標的：BTC。週期：1h。指標：MA20、MA50。邏輯：黃金交叉做多，死亡交叉平倉。加密貨幣標的未註明市場時，預設 USDT 本位永續合約。");
  ok("① zh 邏輯尾端的 ！？ 也去掉再補 。;只有空白的格子跳過(全空 → \"\")", P.nsCompose({ logic: "跌破月線就跑！！" }, "zh", S("zh")) === "幫我建立策略。邏輯：跌破月線就跑。加密貨幣標的未註明市場時，預設 USDT 本位永續合約。"
    && P.nsCompose({ name: "  ", symbol: "\n" }, "zh", S("zh")) === "" && P.nsCompose({}, "zh", S("zh")) === "" && P.nsCompose(null, "zh", S("zh")) === "");
  ok("① en 全填:名稱進雙引號、半形冒號句號、邏輯尾端的 . 不重複、尾句前一個空格", P.nsCompose({ name: "MA cross", symbol: "BTC", timeframe: "4h", indicators: "RSI", logic: "Long when RSI < 30." }, "en", S("en"))
    === 'Create a strategy "MA cross". Symbol: BTC. Timeframe: 4h. Indicators: RSI. Logic: Long when RSI < 30. For crypto symbols, default to USDT-margined perpetual futures unless stated otherwise.');
  ok("① en 只填週期", P.nsCompose({ timeframe: "4h" }, "en", S("en")) === "Create a strategy. Timeframe: 4h. For crypto symbols, default to USDT-margined perpetual futures unless stated otherwise.");

  // ── ② 接線 ──
  ok("② index.html:側欄「策略」標題旁 #strat-add(aria-haspopup=dialog、aria-label ns.title、inline svg);歡迎頁第三顆 #chat-ns 在 #chat-lib 之後、#chat-eg 之前", /<div class="strat-head" id="strat-head"><span class="label" data-i18n="ws\.strategies"><\/span><button class="strat-add" id="strat-add" type="button" aria-haspopup="dialog" data-i18n-aria="ns\.title"><svg/.test(html)
    && html.indexOf('id="chat-ns"') > html.indexOf('id="chat-lib"') && html.indexOf('id="chat-ns"') < html.indexOf('id="chat-eg"') && /<button class="wc-chip" id="chat-ns" type="button" data-i18n="ns\.chip">/.test(html));
  ok("② 框的骨架:#ns-scrim(dialog、預設 hidden)> form#ns-modal.set-modal.del-modal;五格(name / symbol / timeframe / indicators / logic)、預覽 .cf-quote#ns-preview(aria-live)、腳 .foot-msg(role=status)+ 策略庫連結 + 取消 + submit(預設 disabled)", /<div class="scrim" id="ns-scrim" role="dialog" aria-modal="true" aria-labelledby="ns-title" hidden>\s*<form class="set-modal del-modal" id="ns-modal">/.test(html)
    && ["name", "symbol", "timeframe", "indicators", "logic"].every((n) => new RegExp('name="' + n + '"').test(html)) && /<div class="cf-quote empty" id="ns-preview" aria-live="polite"><\/div>/.test(html) && /<span class="foot-msg" id="ns-msg" role="status"><\/span>/.test(html)
    && /<button type="button" class="btn-quiet" id="ns-lib" data-i18n="ns\.libLink">/.test(html) && /<button type="submit" class="btn-fill" id="ns-submit" data-i18n="ns\.submit" disabled>/.test(html) && /<span class="envm" id="ns-env" hidden>/.test(html) && /<span class="del-where" id="ns-where" hidden>/.test(html));
  ok("② newstrategy.js 在 report-blocks.js 之後、app.js 之前載;沒有 innerHTML;strategy_new 在 telemetry.js 白名單、送出點只在 r.started 之後", html.indexOf('src="newstrategy.js"') > html.indexOf('src="report-blocks.js"') && html.indexOf('src="newstrategy.js"') < html.indexOf('src="app.js"')
    && !/innerHTML|insertAdjacentHTML/.test(src) && require(path.join(SHELL, "telemetry.js")).EVENTS.feature_used.name.includes("strategy_new") && /if \(!ok\) \{[^\n]*return; \}[^\n]*\n[\s\S]*?libTrack\("strategy_new"\)/.test(cutFn(src, "nsSend")) && /nsLock\(true\);[\s\S]*?await submitMessage[\s\S]*?nsLock\(false\);/.test(cutFn(src, "nsSend")) && /\["ns-submit", "ns-cancel", "ns-close"\]/.test(src)
    && /<span class="modal-btns"><button type="button" class="btn-out" id="ns-cancel"[^\n]*<button type="submit" class="btn-fill" id="ns-submit"[^\n]*<\/span>/.test(html));
  ok("② app.js:trapTab 圈到 input / textarea;escTop 鏈有 #ns-scrim(在 del 之後、cx 之前);回合三個出口都 nsSync;applyStatic 叫 nsRepaint", /querySelectorAll\("button, select, input, textarea"\)/.test(cutFn(appSrc, "trapTab")) && /!\$\("rpn-scrim"\)\.hidden \? rptNewClose : !\$\("ns-scrim"\)\.hidden \? nsClose : !\$\("cx-scrim"\)\.hidden/.test(cutFn(appSrc, "escTop"))
    && (appSrc.match(/if \(typeof nsSync === "function"\) nsSync\(\);/g) || []).length === 3 && /if \(typeof nsRepaint === "function"\) nsRepaint\(\);/.test(cutFn(appSrc, "applyStatic")));
  { const keys = [...new Set([...src.matchAll(/\bt\("(ns\.[^"]+)"/g)].map((m) => m[1]).concat([...html.matchAll(/data-i18n(?:-aria|-ph)?="(ns\.[^"]+)"/g)].map((m) => m[1])))];
    const missing = keys.filter((k) => !(k in STR.zh) || !(k in STR.en));
    ok("② 用到的 " + keys.length + " 個 ns.* key zh / en 都齊;zh 全形標點", missing.length === 0 && Object.keys(STR.zh).filter((k) => k.startsWith("ns.")).every((k) => !/[一-鿿][,.?:;!]/.test(STR.zh[k])), missing); }

  // ── ③ 交給 Electron ──
  const bin = path.join(SHELL, "node_modules", ".bin", "electron");
  if (!fs.existsSync(bin)) { console.log("SKIP  ③ 找不到 shell/node_modules 的 Electron(先 cd shell && npm install)"); console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0); }
  const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit" });
  const sub = r.status == null ? 1 : r.status;
  console.log(red || sub ? `\n${red + sub} 紅` : "\nALL PASS");
  process.exit(red || sub ? 1 : 0);
}

const { app, BrowserWindow } = require("electron");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "blave-ns-")));
const STUB = `window.__ns = { sent: [], sendResult: { started: true }, tracked: [] };
const __fixed = {
  getLocale: async () => "zh-TW", loadConnection: async () => ({ kind: "claude" }), detectAgents: async () => ({ claude: { installed: true, loggedIn: true }, codex: { installed: false } }),
  listStrategies: async () => [], listSessions: async () => [], loadSession: async () => [], loadSessionImages: async () => [], updateState: async () => ({ phase: "idle", current: "0.0.0" }),
  hasBlaveToken: async () => true, ensureEngine: async () => ({}), libraryList: async () => ({ strategies: [], signedIn: true, dataAccess: "included" }), reportsList: async () => ({ reports: [] }),
  sendMessage: async (p) => { window.__ns.sent.push(p); return window.__ns.sendResult; }, trackFeature: (n) => { window.__ns.tracked.push(n); },
};
window.blave = new Proxy(__fixed, { get: (o, k) => (k in o ? o[k] : typeof k !== "string" ? undefined : k.startsWith("on") ? () => {} : k === "tradeLabels" ? () => {} : async () => undefined) });`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log("FAIL  ③ 逾時(90 秒)"); process.exit(1); }, 90000).unref();

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  const preload = path.join(app.getPath("userData"), "stub.js"); fs.writeFileSync(preload, STUB);
  const w = new BrowserWindow({ width: 1280, height: 820, show: false, webPreferences: { offscreen: true, preload, contextIsolation: false, sandbox: false } });
  await w.loadFile(path.join(SHELL, "renderer", "index.html"));
  await wait(1200);
  const js = (s) => w.webContents.executeJavaScript(s, true);
  const T = (k, v) => js(`t(${JSON.stringify(k)}, ${JSON.stringify(v || {})})`);
  const box = () => js(`(() => { const sc = document.getElementById("ns-scrim"), f = document.getElementById("ns-modal"); return { open: !sc.hidden, cloud: f.querySelector(".modal-head").classList.contains("cloud"), env: document.getElementById("ns-env").hidden, where: document.getElementById("ns-where").hidden,
    preview: document.getElementById("ns-preview").textContent, empty: document.getElementById("ns-preview").classList.contains("empty"), dis: document.getElementById("ns-submit").disabled, desc: document.getElementById("ns-submit").getAttribute("aria-describedby"), msg: document.getElementById("ns-msg").textContent, busy: document.querySelectorAll("#ns-msg .cf-busy .spin16").length,
    focus: document.activeElement && (document.activeElement.id || document.activeElement.name), inert: document.getElementById("view-ws").inert, w: f.getBoundingClientRect().width, vals: ["name", "symbol", "timeframe", "indicators", "logic"].map((n) => f.elements[n].value).join("|") }; })()`);

  let r = await js(`(async () => { document.getElementById("strat-add").click(); await new Promise((r) => setTimeout(r, 120)); return true; })()`);
  let b = await box();
  ok("③ ＋ → 開框:440 寬、焦點在名稱欄、預覽「—」(.empty)、送出 disabled + aria-describedby=ns-hint、本機不掛雲端記號、底下 inert", b.open && Math.round(b.w) === 440 && b.focus === "ns-name" && b.preview === (await T("ns.previewEmpty")) && b.empty && b.dis && b.desc === "ns-hint" && !b.cloud && b.env && b.where && b.inert && b.msg === "", JSON.stringify(b));
  await js(`(() => { const f = document.getElementById("ns-modal"); f.elements.timeframe.value = "4h"; f.dispatchEvent(new Event("input", { bubbles: true })); })()`); b = await box();
  ok("③ 填一格(週期 4h)→ 預覽即時 = 組句(雲端版實填量到的原句)、送出 enabled、aria-describedby 拿掉", b.preview === "幫我建立策略。週期：4h。加密貨幣標的未註明市場時，預設 USDT 本位永續合約。" && !b.empty && !b.dis && b.desc === null, JSON.stringify(b));
  // 失敗:submitMessage 回 false(上一輪還在跑那一句由對話講)→ 框留著、欄位不清、腳那一句、鈕回復
  await js(`window.__ns.sendResult = { started: false }; document.getElementById("ns-submit").click();`); await wait(120); b = await box();
  ok("③ 送出失敗:框留著、欄位不清、腳「送不出去…」、送出鈕回復", b.open && b.vals === "||4h||" && b.msg === (await T("modal.sendFailed")) && !b.dis && (await js("window.__ns.sent.length")) === 1 && !(await js("window.__ns.tracked.includes('strategy_new')")), JSON.stringify(b));
  // 成功:送到對話的就是預覽那句、關框、表單清空、焦點回 ＋、strategy_new
  await js(`window.__ns.sendResult = { started: true }; running = false; document.getElementById("ns-submit").click();`); await wait(150); b = await box();
  r = await js(`({ last: window.__ns.sent[window.__ns.sent.length - 1].message, env: window.__ns.sent[window.__ns.sent.length - 1].viewing.env, tracked: window.__ns.tracked.includes("strategy_new"), you: [...document.querySelectorAll("#chat-scroll .msg.you .bubble")].map((x) => x.textContent) })`);
  ok("③ 送出成功:對話收到預覽那句(viewing.env=local)、關框、表單清空、預覽回空態、焦點回 ＋、strategy_new、底下不再 inert", r.last === "幫我建立策略。週期：4h。加密貨幣標的未註明市場時，預設 USDT 本位永續合約。" && r.env === "local" && r.tracked && r.you[r.you.length - 1] === r.last
    && !b.open && b.vals === "||||" && b.empty && b.focus === "strat-add" && !b.inert, JSON.stringify([r, b]));
  // 回合中:送出 disabled + turn.busy
  await js(`(async () => { running = false; document.getElementById("strat-add").click(); await new Promise((r) => setTimeout(r, 100)); const f = document.getElementById("ns-modal"); f.elements.name.value = "x"; f.dispatchEvent(new Event("input", { bubbles: true })); })()`); await wait(60);
  b = await box(); const enabled = !b.dis;
  await js(`running = true; nsSync();`); b = await box();
  ok("③ 回合中:送出 disabled + 腳放 turn.busy;回合結束 → 回復", enabled && b.dis && b.msg === (await T("turn.busy")) && (await js(`(running = false, nsSync(), !document.getElementById("ns-submit").disabled && document.getElementById("ns-msg").textContent === "")`)), JSON.stringify(b));
  // Esc 關框、焦點回 ＋;取消也一樣
  await js(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));`); b = await box();
  ok("③ Esc → 關框、焦點回 ＋、欄位留著(下次開還在)", !b.open && b.focus === "strat-add" && b.vals === "x||||", JSON.stringify(b));
  // 歡迎頁 chip:開框不送訊息;策略庫連結:關框、開策略庫
  const n0 = await js("window.__ns.sent.length");
  await js(`(async () => { document.getElementById("chat-ns").click(); await new Promise((r) => setTimeout(r, 100)); })()`); await wait(60); b = await box();
  r = await js(`(async () => { document.getElementById("ns-lib").click(); await new Promise((r) => setTimeout(r, 120)); return { open: !document.getElementById("ns-scrim").hidden, lib: !document.getElementById("lib").hidden, sent: window.__ns.sent.length }; })()`);
  ok("③ 歡迎頁 chip 開框(焦點到名稱欄)、不送訊息;「看策略庫的現成策略」→ 關框、開策略庫", b.open && b.focus === "ns-name" && r.sent === n0 && !r.open && r.lib, JSON.stringify([b, r]));
  // 雲端視角:三處目的地記號;停機 → 送出 disabled + ho.gate.stopped
  r = await js(`(async () => { running = false; libLeave(); ENV.cur = "cloud"; TR_BAGS.cloud.st = { cloud: { code: "OK", machine: { state: "stopped" } } }; document.getElementById("cv-empty").hidden = true; envShowMain(); nsOpen(document.getElementById("strat-add")); await new Promise((r) => setTimeout(r, 100));
    const f = document.getElementById("ns-modal"); f.elements.name.value = "y"; f.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`); b = await box();
  ok("③ 雲端視角:標題列 .cloud + 「雲端」記號 + 腳的目的地句;主機停機 → 送出 disabled + ho.gate.stopped", b.open && b.cloud && !b.env && !b.where && b.dis && b.msg === (await T("ho.gate.stopped")), JSON.stringify(b));
  await js(`TR_BAGS.cloud.st = { cloud: { code: "OK", machine: { state: "running" } } }; nsSync();`); b = await box();
  ok("③ 雲端 running 但 1 小時內沒同步過(stale)→ 仍 disabled + ho.gate.stale", b.dis && b.msg === (await T("ho.gate.stale")), JSON.stringify(b));
  await js(`nsClose(); ENV.cur = "local"; TR_BAGS.cloud.st = null; envShowMain();`);
  // en:組句換英文
  r = await js(`(async () => { setLang("en"); applyStatic(); document.getElementById("strat-add").click(); await new Promise((r) => setTimeout(r, 100)); const f = document.getElementById("ns-modal"); f.reset(); f.elements.timeframe.value = "4h"; f.dispatchEvent(new Event("input", { bubbles: true }));
    const out = { preview: document.getElementById("ns-preview").textContent, title: document.getElementById("ns-title").textContent }; nsClose(); setLang("zh"); applyStatic(); return out; })()`);
  ok("③ en:預覽句換英文、標題換字", r.preview === "Create a strategy. Timeframe: 4h. For crypto symbols, default to USDT-margined perpetual futures unless stated otherwise." && r.title === "Add Strategy", JSON.stringify(r));
  ok("③ 整個流程沒有 innerHTML 進畫面(表單值只進 textContent)", (await js(`document.querySelectorAll("#ns-preview *").length`)) === 0);

  console.log(red ? `\n③ ${red} 紅` : "\n③ ALL PASS");
  app.exit(red ? 1 : 0);
});
