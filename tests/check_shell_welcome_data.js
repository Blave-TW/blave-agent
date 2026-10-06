// 歡迎頁的資料清單(shell/renderer/welcome.js + welcome.css + index.html #wl;設計 mockup data-scope §1 / §2)。
//   ① 純邏輯 wdMode(從原文切出來跑):帳號狀態 → 對比版 / 單一清單——沒登入、查不到、舊 api、沒綁卡、餘額不夠、按小時付 → 兩欄對比;
//      綁卡試用中、名下有主機、API 方案(data_access = included)→ 單一清單;試用那句只在名下沒主機時講
//   ② 原文鎖:index.html 骨架(三顆籤後面是 #wl、起手籤 #chat-eg 退役)、welcome.css(.main-empty 是容器、≥700 才兩欄、不寫 hex)、
//      app.js 四個重畫入口、welcome.js 在 app.js 之後、telemetry 白名單尾端兩個名字(≤16 字、api 端同一份)、
//      每一列的字 zh / en 兩語齊全(列舉 WD_ROWS,不抽樣)、字裡沒有「付費」、價格數字不寫死({r} 只在 wd.note.billed)
//   ③ Electron(offscreen、show:false,不會出現在螢幕上):對比版兩欄且免費在前、右欄不上鎖不變灰、單一清單一欄且無 TWD 字樣、
//      點列 → 那一句落進輸入框、不送出、自己打的草稿留著;中欄 <700 上下疊;看全部資料 = 同一塊換成目錄(對比版多「來源」欄)
// 跑法:node tests/check_shell_welcome_data.js(③ 要 BLAVE_TEST_WINDOW=1,①② 照跑)
const fs = require("fs"), path = require("path"), vm = require("vm"), os = require("os");
const SHELL = path.join(__dirname, "..", "shell"), R = path.join(SHELL, "renderer");
const GATE = require("./_electron_gate");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + String(d).slice(0, 1500))); if (!c) red++; };
const read = (f) => fs.readFileSync(f, "utf8");
const src = read(path.join(R, "welcome.js")), css = read(path.join(R, "welcome.css")), html = read(path.join(R, "index.html")), appSrc = read(path.join(R, "app.js"));
const STR = (() => { const sb = {}; vm.runInNewContext(read(path.join(R, "strings.js")) + "\nthis.S = STRINGS;", sb); return sb.S; })();
const cutFn = (s, name) => { const i = s.indexOf("function " + name + "("); if (i < 0) throw new Error("no " + name); let d = 0; for (let k = s.indexOf("{", i); k < s.length; k++) { if (s[k] === "{") d++; else if (s[k] === "}" && --d === 0) return s.slice(i, k + 1); } throw new Error("unbalanced " + name); };
// 列表(WD_ROWS 與來源常數)從原文切出來跑:測試列舉的就是畫面用的那一份
const TAB = (() => { const a = src.indexOf("const WD_P ="), b = src.indexOf("const WD = {"); const P = {}; vm.createContext(P); vm.runInContext(src.slice(a, b).replace(/^const /gm, "var "), P); return P; })();
const ROWS = TAB.WD_ROWS, WEL = ROWS.filter((r) => r[4] > 0), CAT = ROWS.filter((r) => r[3]);

if (!process.versions.electron) {
  // ── ① 純邏輯 ──
  const a = src.indexOf("/* ── 純邏輯("), b = src.indexOf("/* ── 純邏輯到此");
  if (a < 0 || b < 0) throw new Error("找不到純邏輯區塊的標記");
  const block = src.slice(a, b);
  ok("① 純邏輯區塊不碰 DOM / i18n", !/\bdocument\b|\$\(|window\.|\bt\(/.test(block.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")));
  const P = {}; vm.createContext(P); vm.runInContext(block, P);
  const M = (signed, s, da, left) => JSON.stringify(P.wdMode(signed, s, da, left));
  ok("① 沒登入 → 對比版、out(不管手上有什麼狀態)", M(false, null, null, 0) === '{"cmp":true,"k":"out"}' && M(false, { data_access: "included" }, "included", 5) === '{"cmp":true,"k":"out"}');
  ok("① 登入了但查不到 / 舊 api 沒有 data_access → 對比版、unknown(不斷言價格)", M(true, null, null, 0) === '{"cmp":true,"k":"unknown"}' && M(true, { data_included: false }, null, 0) === '{"cmp":true,"k":"unknown"}');
  ok("① 沒綁卡(none + NO_CARD)→ 對比版、none;有卡沒錢(none + 其他)→ nobal", M(true, { data_access: "none", reason: "NO_CARD" }, "none", 0) === '{"cmp":true,"k":"none"}' && M(true, { data_access: "none", reason: "NO_CREDIT" }, "none", 0) === '{"cmp":true,"k":"nobal"}' && M(true, { data_access: "none" }, "none", 0) === '{"cmp":true,"k":"nobal"}');
  ok("① 有卡沒主機按小時付(billed)→ 對比版、billed", M(true, { data_access: "billed" }, "billed", 0) === '{"cmp":true,"k":"billed"}');
  ok("① 綁卡試用中(included、沒主機、試用還有天數)→ 單一清單、trial", M(true, { data_access: "included", plan: { state: "none" } }, "included", 5) === '{"cmp":false,"k":"trial"}');
  ok("① 名下有主機 / API 方案(included)→ 單一清單、incl;有主機的人就算試用日期還在也不講「免費到」", M(true, { data_access: "included", plan: { state: "running" } }, "included", 5) === '{"cmp":false,"k":"incl"}' && M(true, { data_access: "included", plan: { state: "none" } }, "included", 0) === '{"cmp":false,"k":"incl"}' && M(true, { data_included: true }, "included", 0) === '{"cmp":false,"k":"incl"}');

  // ── ② 原文鎖 ──
  const chips = html.slice(html.indexOf('class="wc-chips"'), html.indexOf('id="wl"'));
  ok("② index.html:三顆籤(#chat-lib / #chat-idea / #chat-ns)之後是 #wl,起手籤 #chat-eg 退役;#wl 在 .wc-inner 裡、#main-empty 裡", /id="chat-lib"[\s\S]*id="chat-idea"[\s\S]*id="chat-ns"/.test(chips) && !html.includes('id="chat-eg"') && !/ws\.chatExample/.test(html + appSrc)
    && html.indexOf('id="wl"') > html.indexOf('id="main-empty"') && html.indexOf('id="wl"') < html.indexOf("</section>", html.indexOf('id="main-empty"')));
  ok("② #wl 骨架:小標 wd.title、市場分段 #wl-seg(.lib-seg 配方、三格 crypto / tw / txf、加密預設選中)、#wl-state aria-live、#wl-body、#wl-all 是 .btn-quiet 且不掛 data-i18n(字跟著模式換)",
    /<span class="wl-cap" data-i18n="wd\.title"><\/span>/.test(html) && /<span class="lib-seg" id="wl-seg" role="group" data-i18n-aria="wd\.title">/.test(html)
    && (html.slice(html.indexOf('id="wl-seg"'), html.indexOf("</span>", html.indexOf('id="wl-seg"'))).match(/data-mk="(crypto|tw|txf)" aria-pressed="(true|false)" data-i18n="wd\.mk\.\1"/g) || []).length === 3
    && /data-mk="crypto" aria-pressed="true"/.test(html) && /<p class="wl-state" id="wl-state" aria-live="polite"><\/p>/.test(html) && /<div class="wl-body" id="wl-body"><\/div>/.test(html)
    && /<button class="btn-quiet" id="wl-all" type="button"><\/button>/.test(html));
  ok("② 載入順序:welcome.css 有載;welcome.js 在 app.js 之後(用 app.js 的 $ / t / acct / planVars / autosize / trackFeature;放最後一支,不插進 app.js → suggest.js 之間)", /<link rel="stylesheet" href="welcome\.css">/.test(html) && html.indexOf('src="welcome.js"') > html.indexOf('src="app.js"') && (html.match(/<script src="[^"]+"><\/script>/g) || []).pop() === '<script src="welcome.js"></script>');
  ok("② app.js 四個重畫入口:acctPaint(帳號狀態變)、acctPrecheck(能跑的人不走 acctPaint)、applyStatic 最後(換語言)、acctSignOut(登出)",
    /wdPaint\(\)/.test(cutFn(appSrc, "acctPaint")) && /acct = await window\.blave\.accountStatus\(\); acctAt = Date\.now\(\);\n[^\n]*\n\s*if \(typeof wdPaint === "function"\) wdPaint\(\);/.test(appSrc)
    && /\[data-i18n-aria\]"\)\.forEach[^\n]*\n\s*if \(typeof wdPaint === "function"\) wdPaint\(\);[^\n]*\n\}/.test(appSrc) && /hasToken = false; acct = null; balLast = null; planErr = null; planBusy = false;\n\s*if \(typeof wdPaint === "function"\) wdPaint\(\);/.test(appSrc));
  ok("② 起手籤整個拿掉:app.js 沒有 chat-eg,兩語字串表與 .po 都沒有 ws.chatExample", !/chat-eg/.test(appSrc) && !("ws.chatExample" in STR.zh) && !("ws.chatExample" in STR.en) && !/ws\.chatExample/.test(read(path.join(SHELL, "i18n", "zh.po")) + read(path.join(SHELL, "i18n", "en.po"))));
  ok("② welcome.css:.main-empty 是容器(container-type)、兩欄只在 ≥700 的容器查詢裡、免費欄不靠 order 換位(DOM 順序就是免費在前)、不寫 hex、減少動態有收;小字不 nowrap(設計稽核 2);清單在時 .wc-inner 上對齊不置中(稽核 4);目錄分組標籤用 .wl-cap(稽核 1)",
    /\.main-empty \{ container-type: inline-size; \}/.test(css) && /@container \(min-width: 700px\) \{\s*\.wl-body\.cmp2 \{ grid-template-columns: 1fr 1fr;/.test(css)
    && /\.wl-body \{[^}]*grid-template-columns: 1fr;/.test(css) && !/\border:\s*-?\d/.test(css) && !/#[0-9a-fA-F]{3,8}\b/.test(css.replace(/\/\*[\s\S]*?\*\//g, "")) && /prefers-reduced-motion/.test(css)
    && !/\.wd-mt \{[^}]*nowrap/.test(css) && /\.wc-inner:has\(\.wl\) \{ margin: 0 0 auto; padding-top: var\(--space-32\); \}/.test(css) && !/wd-cap/.test(src + css) && /wdEl\("span", "wl-cap"/.test(src));
  ok("② 右欄不上鎖不變灰:welcome.js 不給列 disabled / aria-disabled / 鎖的 class;每一列都是 button", !/disabled|is-locked|lock/i.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")) && /wdEl\("button", "wd-row"\)/.test(src));
  ok("② 點列只填不送:wdFill 不叫 sendDraft / submitMessage,填完 autosize + focus,記 welcome_data_row;展開目錄記 welcome_data_all", !/sendDraft|submitMessage/.test(src) && /ta\.value = [^\n]*;\n\s*WD\.filled = ta\.value; autosize\(\); ta\.focus\(\);\n\s*trackFeature\("welcome_data_row"\);/.test(src) && /if \(WD\.all\) trackFeature\("welcome_data_all"\);/.test(src));
  { const F = require(path.join(SHELL, "telemetry.js")).EVENTS.feature_used.name;
    ok("② telemetry 白名單:welcome_data_row / welcome_data_all 接在 topup_lib 後面(0.1.17 聊天附件三個再接在後面)、≤16 字", F.slice(F.indexOf("topup_lib") + 1, F.indexOf("topup_lib") + 3).join() === "welcome_data_row,welcome_data_all" && ["welcome_data_row", "welcome_data_all"].every((n) => n.length <= 16));
    const apiPy = path.join(process.env.BLAVE_API_DIR || path.join(__dirname, "..", "..", "api"), "openclaw", "desktop_telemetry.py");
    if (!fs.existsSync(apiPy)) console.log("SKIP  api 白名單比對(需要 monorepo 版面或 BLAVE_API_DIR)");
    else ok("② api 端 desktop_telemetry.py 的 feature_used 白名單也有這兩個(逐字、順序同)", /"bind_lib", "topup_lib",\n(?:[^\n]*\n)*?\s*"welcome_data_row", "welcome_data_all",/.test(read(apiPy))); }
  // 字:列舉每一列、每個欄位、兩語;不抽樣
  const missing = [];
  for (const [id, mk, s, cat, wel] of ROWS) {
    const need = cat ? ["nm", "fq", "sn", "us"] : ["nm", "fq"]; if (wel) need.push("sy", "tx"); if (TAB.WD_NT.has(id)) need.push("nt"); if (TAB.WD_WN.has(id)) need.push("wn"); if (TAB.WD_WNM.has(id)) need.push("wnm");
    for (const L of ["zh", "en"]) for (const f of need) if (!STR[L]["wd.r." + id + "." + f]) missing.push(L + ":wd.r." + id + "." + f);
    if (!["crypto", "tw", "txf"].includes(mk) || ![TAB.WD_P, TAB.WD_B].includes(s)) missing.push("bad row " + id);
  }
  ok("② 每一列的字 zh / en 都齊(" + ROWS.length + " 列、目錄 " + CAT.length + " 列、歡迎頁 " + WEL.length + " 列)", missing.length === 0, missing.join(", "));
  const extra = []; for (const L of ["zh", "en"]) for (const k of Object.keys(STR[L])) if (k.startsWith("wd.r.") && !ROWS.some((r) => k.startsWith("wd.r." + r[0] + "."))) extra.push(L + ":" + k);
  ok("② 字串表沒有多出不在 WD_ROWS 的列(拿掉的列字也要一起拿掉:BingX、CME／ICE、公開大盤、公開期貨法人、異常漲跌)", extra.length === 0, extra.join(", "));
  const fixed = ["wd.title", "wd.mk.crypto", "wd.mk.tw", "wd.mk.txf", "wd.mk.txfo", "wd.col.free", "wd.col.blave", "wd.note.out", "wd.note.outNoNum", "wd.note.none", "wd.note.noneNoNum", "wd.note.billed", "wd.note.billedNoNum", "wd.note.nobal", "wd.note.topup", "wd.state.trial", "wd.empty.txf", "wd.all", "wd.less", "wd.sep", "wd.h.data", "wd.h.fq", "wd.h.sn", "wd.h.src", "wd.h.us", "wd.src.p", "wd.src.b", "wd.foot.1", "wd.foot.2"];
  ok("② 固定字 " + fixed.length + " 個 zh / en 都有;免費欄會空著的市場只有台指期(wd.empty.txf)", fixed.every((k) => STR.zh[k] && STR.en[k]) && WEL.filter((r) => r[1] === "txf" && r[2] === TAB.WD_P).length === 0 && ["crypto", "tw"].every((mk) => WEL.some((r) => r[1] === mk && r[2] === TAB.WD_P)));
  const wd = (L) => Object.keys(STR[L]).filter((k) => k.startsWith("wd.")).map((k) => STR[L][k]);
  ok("② 字裡不出現「付費」/ paid;價格只在 wd.note.billed 一句({r} 由 account_status 下發,不寫死 2 TWD);試用天數也是 {t}", !wd("zh").some((s) => /付費/.test(s)) && !wd("en").some((s) => /\bpaid\b/i.test(s))
    && ["zh", "en"].every((L) => Object.keys(STR[L]).filter((k) => k.startsWith("wd.") && /\{r\}/.test(STR[L][k])).join() === "wd.note.billed") && !wd("zh").concat(wd("en")).some((s) => /\d\s*TWD/.test(s))
    && ["zh", "en"].every((L) => /\{t\}/.test(STR[L]["wd.note.out"]) && /\{t\}/.test(STR[L]["wd.note.none"]) && /\{d\}/.test(STR[L]["wd.state.trial"])));
  ok("② 台指期 K 線那一列的來源是一個常數(WD_TXF_KLINE_SRC;免費日線接上後翻成 WD_P 就移到免費欄),現在是 Blave", /const WD_TXF_KLINE_SRC = WD_B;/.test(src) && ROWS.find((r) => r[0] === "txk")[2] === TAB.WD_B && /\["txk", "txf", WD_TXF_KLINE_SRC, 1, 1\]/.test(src));
  ok("② 起手句六句對得到 examples/(五句在這一版的清單上;WTI 那句隨商品市場一起拿掉:起始年待確認)", ["tsmc_ma", "txf_ma_1m", "tw100_foreign_zscore", "tw2317_broker_zscore", "btc_ti_5min"].every((d) => fs.existsSync(path.join(SHELL, "..", "examples", d, "strategy.py")))
    && ["twd", "txk", "inst", "br", "ti"].every((id) => WEL.some((r) => r[0] === id)) && !ROWS.some((r) => r[1] === "cmd"));

  // ── ③ Electron ──
  const bin = GATE.bin(SHELL, "③");
  if (!bin) { console.log(red ? `\n${red} FAILED` : "\nALL PASS"); process.exit(red ? 1 : 0); }
  const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit", env: { ...process.env, ELECTRON_ENABLE_LOGGING: "" } });
  process.exit(red || r.status ? 1 : 0);
}

const { app, BrowserWindow } = require("electron");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "blave-wd-")));
const STUB = `window.__tf = []; window.blave = new Proxy({}, { get: (_, k) => typeof k !== "string" ? undefined
  : k.startsWith("on") ? () => {} : k === "tradeLabels" ? () => {} : k === "trackFeature" ? (n) => window.__tf.push(n)
  : async () => ({ getLocale: "zh-TW", loadConnection: { kind: "claude" }, detectAgents: { claude: { installed: true, loggedIn: true }, codex: { installed: false } },
      listStrategies: [], listSessions: [], loadSession: [], loadSessionImages: [], updateState: { phase: "idle", current: "0.0.0" },
      telemetryGet: true, telemetryInstallId: "a3f9c2e1-7b04-4d6e-9e21-5c0b8d4f1a77" })[k] });`;
app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  const pre = path.join(app.getPath("userData"), "stub.js"); fs.writeFileSync(pre, STUB);
  const w = new BrowserWindow({ width: 1600, height: 900, show: false, webPreferences: { offscreen: true, preload: pre, contextIsolation: false, sandbox: false } });
  await w.loadFile(path.join(R, "index.html"));
  await new Promise((r) => setTimeout(r, 1200));
  const js = (code) => w.webContents.executeJavaScript(code, true);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // 畫面的量測:版本、欄數、每欄的小標與列數、幾何、右欄有沒有被鎖、狀態句、目錄
  const snap = () => js(`(() => { const body = $("wl-body"), cols = [...body.querySelectorAll(":scope > .wl-col")];
    const rc = (c) => { const r = c.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
    return { visible: !$("main-empty").hidden && !$("wl").hidden, cmp2: body.classList.contains("cmp2"), cols: cols.map((c) => ({ cap: (c.querySelector(".wl-cap") || {}).textContent || "", note: (c.querySelector(".wl-note") || {}).textContent || "",
        rows: c.querySelectorAll(".wd-row").length, empty: (c.querySelector(".wl-empty") || {}).textContent || "", locked: c.querySelectorAll(".wd-row[disabled], .wd-row[aria-disabled], .wd-row.is-locked").length,
        dim: [...c.querySelectorAll(".wd-row")].some((b) => parseFloat(getComputedStyle(b).opacity) < 1), r: rc(c) })),
      state: $("wl-state").textContent, stateBtn: !!$("wl-state").querySelector("button"), seg: !$("wl-seg").hidden, all: $("wl-all").textContent, text: $("wl").textContent,
      table: !!body.querySelector("table.wd-cat"), th: body.querySelectorAll("table.wd-cat th").length, tags: body.querySelectorAll(".wd-tag").length, groups: body.querySelectorAll("tr.g").length, trs: body.querySelectorAll("tbody tr:not(.g)").length,
      ta: $("ta").value, msgs: $("chat-scroll").querySelectorAll(".msg").length, running, tf: window.__tf.slice() }; })()`);
  const paint = (code) => js(`(() => { ${code}; WD.key = ""; wdPaint(); return true; })()`);
  const Z = STR.zh, DAY = 86400000;

  // 沒登入:對比版
  await paint(`hasToken = false; acct = null; pub = null; WD.mk = "crypto"; WD.all = false`);
  let s = await snap();
  ok("③ 歡迎頁可見;沒登入 → 兩欄對比:第一欄「免費，不用帳號」第二欄「Blave 資料」;加密:免費 2 列、Blave 4 列", s.visible && s.cmp2 && s.cols.length === 2 && s.cols[0].cap === Z["wd.col.free"] && s.cols[1].cap === Z["wd.col.blave"] && s.cols[0].rows === 2 && s.cols[1].rows === 4, JSON.stringify(s.cols.map((c) => [c.cap, c.rows])));
  ok("③ 右欄不上鎖、不變灰;右欄那句是「登入並綁卡後就能用」(公開價目拿不到 → 不帶數字那句)、是一顆鈕", s.cols[1].locked === 0 && !s.cols[1].dim && s.cols[1].note === Z["wd.note.outNoNum"] && (await js(`!!$("wl-body").querySelector(".wl-note button")`)));
  ok("③ 1600 寬:兩欄並排、免費欄在左", s.cols[1].r.left >= s.cols[0].r.right - 1 && Math.abs(s.cols[0].r.top - s.cols[1].r.top) < 2, JSON.stringify([s.cols[0].r, s.cols[1].r]));
  ok("③ 「看全部資料」鈕字、市場分段看得到、沒有 TWD 字樣(沒登入不講價)", s.all === Z["wd.all"] && s.seg && !/TWD/.test(s.text));
  // 點列:落進輸入框、不送出
  await js(`$("wl-body").querySelector(".wl-col .wd-row").click()`); await wait(50); s = await snap();
  ok("③ 點免費欄第一列 → 那一句(wd.r.bnk.tx)落進輸入框、沒有送出(沒有泡泡、沒在跑)、記 welcome_data_row", s.ta === Z["wd.r.bnk.tx"] && s.msgs === 0 && s.running === false && s.tf.includes("welcome_data_row"), JSON.stringify([s.ta, s.msgs, s.tf]));
  await js(`$("wl-body").querySelectorAll(".wl-col")[1].querySelector(".wd-row").click()`); await wait(50); s = await snap();
  ok("③ 再點另一列 → 上一句直接換掉(不疊成兩句)", s.ta === Z["wd.r.ti.tx"], s.ta);
  await js(`$("ta").value = "my own draft"; $("wl-body").querySelector(".wl-col .wd-row").click()`); await wait(50); s = await snap();
  ok("③ 自己打到一半的字留著,那一句接在後面另起一行", s.ta === "my own draft\n" + Z["wd.r.bnk.tx"], s.ta);
  await js(`$("ta").value = ""; WD.filled = ""`);
  // 窄:上下疊、免費在上
  w.setSize(1000, 900); await wait(400); s = await snap();
  ok("③ 1000 寬(中欄 < 700):上下疊、免費欄在上", s.cmp2 && s.cols.length === 2 && s.cols[1].r.top >= s.cols[0].r.bottom - 1 && s.cols[0].cap === Z["wd.col.free"], JSON.stringify([s.cols[0].r, s.cols[1].r]));
  w.setSize(1600, 900); await wait(400);
  // 台指期:免費欄空著照實寫一句
  await js(`$("wl-seg").querySelector('[data-mk="txf"]').click()`); await wait(50); s = await snap();
  ok("③ 切到台指期:免費欄沒有列、寫「台指期價格目前沒有免費來源。」;Blave 欄 4 列(含台指期 K 線:WD_TXF_KLINE_SRC 現在是 Blave)", s.cols[0].rows === 0 && s.cols[0].empty === Z["wd.empty.txf"] && s.cols[1].rows === 4, JSON.stringify(s.cols.map((c) => [c.rows, c.empty])));
  ok("③ 分段選中態跟著換", (await js(`[...$("wl-seg").querySelectorAll("button")].map((b) => b.getAttribute("aria-pressed")).join()`)) === "false,false,true");
  await js(`$("wl-seg").querySelector('[data-mk="crypto"]').click()`); await wait(50);
  // 登入後的各種狀態
  const base = `hasToken = true; acct = { can_run: true, data_included: false, data_access: "billed", data_hourly: 2, trial_days: 14, plan: { state: "none", trial_free_until: null } }`;
  await paint(base); s = await snap();
  ok("③ 有卡沒主機按小時付 → 對比版;右欄那句帶時價「2 TWD」、同一小時只收一次;整頁 TWD 只出現一次", s.cmp2 && s.cols[1].note === Z["wd.note.billed"].replace("{r}", "2") && (s.text.match(/TWD/g) || []).length === 1, s.cols[1].note);
  await paint(`${base}; acct.data_access = "none"; acct.reason = "NO_CARD"`); s = await snap();
  ok("③ 沒綁卡 → 對比版;右欄是「綁卡，送 14 天 Blave 資料」鈕、不出價格", s.cmp2 && s.cols[1].note === Z["wd.note.none"].replace("{t}", "14") && !/TWD/.test(s.text), s.cols[1].note);
  await paint(`${base}; acct.data_access = "none"; acct.reason = "NO_CREDIT"`); s = await snap();
  ok("③ 餘額不夠 → 對比版;右欄「餘額不夠付這小時的資料」+「儲值」鈕", s.cmp2 && s.cols[1].note.startsWith(Z["wd.note.nobal"]) && s.cols[1].note.endsWith(Z["wd.note.topup"]) && (await js(`$("wl-body").querySelector(".wl-note button").textContent`)) === Z["wd.note.topup"], s.cols[1].note);
  await paint(`${base}; acct.data_access = "included"; acct.data_included = true; acct.plan.trial_free_until = new Date(Date.now() + 5 * ${DAY}).toISOString()`); s = await snap();
  ok("③ 綁卡試用中 → 單一清單:一欄、加密 6 列、沒有欄小標、狀態句「試用中：這些資料免費用到 …」、沒有 TWD", !s.cmp2 && s.cols.length === 1 && s.cols[0].rows === 6 && s.cols[0].cap === "" && s.state.startsWith(Z["wd.state.trial"].split("{d}")[0]) && !/TWD/.test(s.text), JSON.stringify([s.cols.length, s.cols[0] && s.cols[0].rows, s.state]));
  await paint(`${base}; acct.data_access = "included"; acct.data_included = true; acct.plan.state = "running"; acct.plan.trial_free_until = new Date(Date.now() + 5 * ${DAY}).toISOString()`); s = await snap();
  ok("③ 名下有主機(含試用日期還在)→ 單一清單、狀態句空(不講「免費到」)、沒有價格字", !s.cmp2 && s.cols.length === 1 && s.state === "" && !/TWD/.test(s.text));
  ok("③ 單一清單的列照順序號:加密 bnk / fng / ti / conc / liq / fr", (await js(`[...$("wl-body").querySelectorAll(".wd-row")].map((b) => b.dataset.id).join()`)) === "bnk,fng,ti,conc,liq,fr");
  // 看全部資料:同一塊換成目錄
  await js(`$("wl-all").click()`); await wait(50); s = await snap();
  ok("③ 單一清單按「看全部資料」→ 同一塊換成目錄:表格、4 欄(不出「來源」)、三個市場分組、" + CAT.length + " 列、分段藏起來、鈕字變「收起目錄」、記 welcome_data_all", s.table && s.th === 4 && s.groups === 3 && s.trs === CAT.length && s.tags === 0 && !s.seg && s.all === Z["wd.less"] && s.tf.includes("welcome_data_all"), JSON.stringify([s.table, s.th, s.groups, s.trs, s.seg, s.all]));
  await js(`$("wl-all").click()`); await wait(50); s = await snap();
  ok("③ 再按一次 → 回到清單、分段回來", !s.table && s.seg && s.cols.length === 1 && s.all === Z["wd.all"]);
  await paint(`${base}`); await js(`$("wl-all").click()`); await wait(50); s = await snap();
  ok("③ 對比版的目錄多「來源」欄:5 欄、每列一個 Mini tag(公開 / Blave)、狀態列講那一句(按小時那句)", s.table && s.th === 5 && s.tags === CAT.length && s.state === Z["wd.note.billed"].replace("{r}", "2") && (await js(`$("wl-body").querySelectorAll(".wd-tag.line").length`)) === CAT.filter((r) => r[2] === TAB.WD_P).length, JSON.stringify([s.th, s.tags, s.state]));
  w.setSize(1000, 900); await wait(400);
  ok("③ 窄欄的目錄:表格改成一列一塊(td 變 block、欄頭藏起來),不橫捲", (await js(`(() => { const td = $("wl-body").querySelector("tbody tr:not(.g) td"), th = $("wl-body").querySelector("thead"); return getComputedStyle(td).display === "block" && th.getBoundingClientRect().width <= 1 && $("main-empty").scrollWidth <= $("main-empty").clientWidth; })()`)));
  await js(`$("wl-all").click()`); await wait(50);
  // 指紋:狀態沒變就不重畫(焦點不被洗掉)
  ok("③ 帳號狀態沒變再 wdPaint:DOM 不重建(焦點留在列上)", (await js(`(() => { const b = $("wl-body").querySelector(".wd-row"); b.focus(); wdPaint(); return document.activeElement === b; })()`)));
  console.log(red ? `\n${red} FAILED` : "\nALL PASS");
  app.exit(red ? 1 : 0);
}).catch((e) => { console.log("FAIL  " + (e && e.stack || e)); app.exit(1); });
