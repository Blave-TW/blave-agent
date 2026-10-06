// 歡迎頁的資料清單(shell/renderer/welcome.js + welcome.css + index.html #wl;設計 mockup data-scope §1 / §2)。
//   ① 純邏輯 wdMode(從原文切出來跑):帳號狀態 → 對比版 / 單一清單——沒登入、查不到、舊 api、沒綁卡、餘額不夠、按小時付 → 兩欄對比;
//      綁卡試用中、名下有主機、API 方案(data_access = included)→ 單一清單;試用那句只在名下沒主機時講
//   ② 原文鎖:index.html 骨架(三顆籤後面是 #wl、起手籤 #chat-eg 退役)、welcome.css(.main-empty 是容器、≥700 才兩欄、不寫 hex)、
//      app.js 四個重畫入口、welcome.js 在 app.js 之後、telemetry 白名單尾端兩個名字(≤16 字、api 端同一份)、
//      每一列的字 zh / en 兩語齊全(列舉 WD_ROWS,不抽樣)、字裡沒有「付費」、價格數字不寫死({r} 只在 wd.note.billed)
//      一列一行(名字 + 小字,沒有第二行起手句);點列 = 「跟我討論要怎麼用〈資料名〉做策略」(模板 wd.ask × 每列的 .an):
//      wdRow / wdFill / wdAsk 原文接假 DOM 在純 node 跑(run_all 不起 Electron),歡迎頁每一列 × 兩語逐列組句子
//   ③ Electron(offscreen、show:false,不會出現在螢幕上):對比版兩欄且免費在前、右欄不上鎖不變灰、單一清單一欄且無 TWD 字樣、
//      點列 → 那一句落進輸入框、不送出、自己打的草稿留著;列高與熱區實測 ≥ 44、窄欄小字折到名字下面;
//      中欄 <700 上下疊;看全部資料 = 同一塊換成目錄(對比版多「來源」欄)
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
// 點某一列該落進輸入框的句子:模板代入那一列的 .an。比對時拿掉半形空白(中文模板在英數兩側補的那一格由 wdAsk 管,另外斷言)
const nosp = (x) => String(x).replace(/ /g, "");
const askOf = (L, id) => String(STR[L]["wd.ask"]).replace("{name}", STR[L]["wd.r." + id + ".an"]);

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
    const need = cat ? ["nm", "fq", "sn", "us"] : ["nm", "fq"]; if (wel) need.push("sy", "an"); if (TAB.WD_NT.has(id)) need.push("nt"); if (TAB.WD_WNM.has(id)) need.push("wnm");
    for (const L of ["zh", "en"]) for (const f of need) if (!STR[L]["wd.r." + id + "." + f]) missing.push(L + ":wd.r." + id + "." + f);
    if (!["crypto", "tw", "txf"].includes(mk) || ![TAB.WD_P, TAB.WD_B].includes(s)) missing.push("bad row " + id);
  }
  ok("② 每一列的字 zh / en 都齊(" + ROWS.length + " 列、目錄 " + CAT.length + " 列、歡迎頁 " + WEL.length + " 列)", missing.length === 0, missing.join(", "));
  const extra = []; for (const L of ["zh", "en"]) for (const k of Object.keys(STR[L])) if (k.startsWith("wd.r.") && !ROWS.some((r) => k.startsWith("wd.r." + r[0] + "."))) extra.push(L + ":" + k);
  ok("② 字串表沒有多出不在 WD_ROWS 的列(拿掉的列字也要一起拿掉:BingX、CME／ICE、公開大盤、公開期貨法人、異常漲跌)", extra.length === 0, extra.join(", "));
  const fixed = ["wd.title", "wd.mk.crypto", "wd.mk.tw", "wd.mk.txf", "wd.mk.txfo", "wd.col.free", "wd.col.blave", "wd.note.out", "wd.note.outNoNum", "wd.note.none", "wd.note.noneNoNum", "wd.note.billed", "wd.note.billedNoNum", "wd.note.nobal", "wd.note.topup", "wd.state.trial", "wd.all", "wd.less", "wd.sep", "wd.h.data", "wd.h.fq", "wd.h.sn", "wd.h.src", "wd.h.us", "wd.src.p", "wd.src.b", "wd.foot.1", "wd.foot.2"];
  ok("② 固定字 " + fixed.length + " 個 zh / en 都有;三個市場的歡迎頁兩欄都有列(免費欄空著那句 wd.empty.* 與 .wl-empty 隨台指期免費日線退役)", fixed.every((k) => STR.zh[k] && STR.en[k]) && ["crypto", "tw", "txf"].every((mk) => [TAB.WD_P, TAB.WD_B].every((sr) => WEL.some((r) => r[1] === mk && r[2] === sr)))
    && !Object.keys(STR.zh).concat(Object.keys(STR.en)).some((k) => k.startsWith("wd.empty.")) && !/wl-empty|wd\.empty/.test(src + css));
  const wd = (L) => Object.keys(STR[L]).filter((k) => k.startsWith("wd.")).map((k) => STR[L][k]);
  ok("② 字裡不出現「付費」/ paid;價格只在 wd.note.billed 一句({r} 由 account_status 下發,不寫死 2 TWD);試用天數也是 {t}", !wd("zh").some((s) => /付費/.test(s)) && !wd("en").some((s) => /\bpaid\b/i.test(s))
    && ["zh", "en"].every((L) => Object.keys(STR[L]).filter((k) => k.startsWith("wd.") && /\{r\}/.test(STR[L][k])).join() === "wd.note.billed") && !wd("zh").concat(wd("en")).some((s) => /\d\s*TWD/.test(s))
    && ["zh", "en"].every((L) => /\{t\}/.test(STR[L]["wd.note.out"]) && /\{t\}/.test(STR[L]["wd.note.none"]) && /\{d\}/.test(STR[L]["wd.state.trial"])));
  { const txd = ROWS.find((r) => r[0] === "txd"), txk = ROWS.find((r) => r[0] === "txk");
    const listed = /_TAIFEX_INDEX_FUT_LISTED = \{'TXF': '(\d{4}-\d\d-\d\d)', 'MXF': '(\d{4}-\d\d-\d\d)', 'TMF': '(\d{4}-\d\d-\d\d)'\}/.exec(read(path.join(SHELL, "..", "lib", "data.py"))) || [];
    ok("② 台指期 K 線拆兩列:txd 日線在免費欄第一列、txk 分線在 Blave 欄(頻率不再含日線);起始日與目錄補充(小台、微台上市日)逐字同 lib/data.py _TAIFEX_INDEX_FUT_LISTED;WD_TXF_KLINE_SRC 常數退役",
      !!txd && !!txk && txd[2] === TAB.WD_P && txd[4] === 1 && txk[2] === TAB.WD_B && txk[4] === 2 && !/WD_TXF_KLINE_SRC/.test(src)
      && listed[1] === "1998-07-21" && STR.zh["wd.r.txd.sn"] === listed[1] && STR.en["wd.r.txd.sn"] === listed[1] && /1998/.test(STR.zh["wd.r.txd.sy"]) && /1998/.test(STR.en["wd.r.txd.sy"])
      && ["zh", "en"].every((L) => STR[L]["wd.r.txd.nt"].includes(listed[2]) && STR[L]["wd.r.txd.nt"].includes(listed[3])) && /小台.*微台/.test(STR.zh["wd.r.txd.nt"]) && /Mini.*micro/.test(STR.en["wd.r.txd.nt"])
      && !/日/.test(STR.zh["wd.r.txk.fq"]) && !/daily/i.test(STR.en["wd.r.txk.fq"])
      && /"fetch_txf_daily_public"/.test(read(path.join(SHELL, "..", "lib", "quality_check.py"))), JSON.stringify([listed.slice(1), STR.zh["wd.r.txd.nt"], STR.en["wd.r.txd.nt"]]));
    const wn = ["zh", "en"].flatMap((L) => Object.keys(STR[L]).filter((k) => /^wd\.r\..*\.wn$/.test(k)).map((k) => L + ":" + k));
    ok("② 歡迎頁列的小字只有「頻率・起始年」:列尾補充 .wn 與 WD_WN 退役(兩語字串表沒有 wd.r.*.wn);歡迎頁短名 .wnm = bnk / txd / txk / twd / br(後兩個只有英文縮短,中文照抄 .nm),短名不帶「近月連續」那個括號",
      wn.length === 0 && !/WD_WN\b|"wn"/.test(src) && [...TAB.WD_WNM].sort().join() === "bnk,br,twd,txd,txk" && ["twd", "br"].every((id) => STR.zh["wd.r." + id + ".wnm"] === STR.zh["wd.r." + id + ".nm"] && STR.en["wd.r." + id + ".wnm"].length < STR.en["wd.r." + id + ".nm"].length)
      && ["zh", "en"].every((L) => ["txd", "txk"].every((id) => !/[()（）]/.test(STR[L]["wd.r." + id + ".wnm"]) && /[()（）]/.test(STR[L]["wd.r." + id + ".nm"]))), wn.join(", ")); }
  // ── 一列一行、點列 = 討論句(起手句 .tx 退役)──
  { const po = read(path.join(SHELL, "i18n", "zh.po")) + read(path.join(SHELL, "i18n", "en.po")), code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    const txKeys = ["zh", "en"].flatMap((L) => Object.keys(STR[L]).filter((k) => /^wd\.r\..*\.tx$/.test(k)).map((k) => L + ":" + k));
    ok("② 起手句退役:兩語字串表與 .po 沒有 wd.r.*.tx、welcome.js 不再讀 \"tx\"、第二行的 class(wd-l2 / wd-gl / wd-tx)在 js 與 css 都沒有;商品市場仍沒有列",
      txKeys.length === 0 && !/wd\.r\.[a-z0-9]+\.tx"/.test(po) && !/"tx"/.test(code) && !/wd-l2|wd-gl|wd-tx/.test(src + css) && !ROWS.some((r) => r[1] === "cmd"), txKeys.join(", "));
    ok("② 點列接的是討論句:wdRow 的 click = wdFill(wdAsk(t(\"wd.ask\"), wdK(id, \"an\")));列裡只有 .wd-l1 一行(名字 + 小字,小字 = 頻率・起始年)",
      /l1\.append\(wdEl\("span", "wd-nm", [^\n]*\), wdEl\("span", "wd-mt", wdK\(id, "fq"\) \+ t\("wd\.sep"\) \+ wdK\(id, "sy"\)\)\);\n\s*b\.appendChild\(l1\);\n\s*b\.addEventListener\("click", \(\) => wdFill\(wdAsk\(t\("wd\.ask"\), wdK\(id, "an"\)\)\)\);/.test(cutFn(src, "wdRow")));
    ok("② welcome.css:列高下限 44、只剩一行時垂直置中(.wd-row 是 grid,align-content: center)、內距 8/12 不變;小字跟在名字後面靠左(.wd-l1 flex-start、間距 12、baseline、放不下整段折行)",
      /\.wd-row \{\s*display: grid; align-content: center; width: 100%; min-height: 44px; padding: var\(--space-8\) var\(--space-12\);/.test(css)
      && /\.wd-l1 \{ display: flex; align-items: baseline; justify-content: flex-start; gap: var\(--space-2\) var\(--space-12\); flex-wrap: wrap; \}/.test(css) && !/space-between/.test(css.slice(css.indexOf(".wd-row"), css.indexOf(".wl-foot"))));
    ok("② 完整目錄:開著時 .wc-inner 放寬到 1040、「一列一塊」的斷點 860(兩欄清單的 700 不動)、一列一塊時列與分組列左右內距 12(左緣對齊標題);單一清單(沒有來源欄)不講 wd.foot.1",
      /\.wc-inner:has\(\.wd-catw\) \{ max-width: 1040px; \}/.test(css) && /@container \(max-width: 859\.98px\) \{\s*\.wd-cat thead/.test(css) && !/699\.98/.test(css) && /@container \(min-width: 700px\) \{\s*\.wl-body\.cmp2/.test(css)
      && /\.wd-cat tr \{ padding: var\(--space-12\); /.test(css) && /\.wd-cat tr\.g \{ padding: var\(--space-24\) var\(--space-12\) var\(--space-4\); /.test(css) && /\.wd-cat tbody tr:first-child\.g \{ padding-top: var\(--space-4\); \}/.test(css)
      && /if \(src\) foot\.appendChild\(wdEl\("p", "", t\("wd\.foot\.1"\)\)\);/.test(cutFn(src, "wdCatalog")) && (cutFn(src, "wdCatalog").match(/wd\.foot\.1/g) || []).length === 1);
    ok("② 第一次上色不靠載入順序:welcome.js 檔尾在 applyStatic 已經跑過時(#wl-seg 的 aria-label 是它填的)自己補畫一次", /\nif \(\$\("wl-seg"\)\.hasAttribute\("aria-label"\)\) wdPaint\(\);\n$/.test(src) && /id="wl-seg" role="group" data-i18n-aria="wd\.title">/.test(html) && !/id="wl-seg"[^>]*\saria-label=/.test(html));
    ok("② 模板 wd.ask 兩語都有、各恰好一個 {name}、沒有別的佔位", ["zh", "en"].every((L) => { const tpl = STR[L]["wd.ask"] || ""; return tpl.split("{name}").length === 2 && !/[{}]/.test(tpl.replace("{name}", "")); }), JSON.stringify([STR.zh["wd.ask"], STR.en["wd.ask"]]));
    ok("② wdAsk:中文模板貼著中文字、資料名頭尾是英數 → 補半形空白;頭尾是中文不補;英文模板不重複補;模板沒有 {name} 原樣回",
      P.wdAsk("用{name}做", "Put/Call Ratio") === "用 Put/Call Ratio 做" && P.wdAsk("用{name}做", "Binance 永續") === "用 Binance 永續做" && P.wdAsk("用{name}做", "台指 PCR") === "用台指 PCR 做"
      && P.wdAsk("用{name}做", "爆倉資料") === "用爆倉資料做" && P.wdAsk("with {name}", "funding rates") === "with funding rates" && P.wdAsk("with {name}.", "x1") === "with x1." && P.wdAsk("{name}", "A") === "A" && P.wdAsk("no slot", "A") === "no slot");

    // 點列的行為純 node 也跑:wdRow / wdFill / wdAsk 原文 + 真的 i18n.js t(),DOM 只給用到的那幾樣
    const lab = (L) => {
      const ta = { value: "", focus() { this.focused = true; } }, log = { tf: [], sized: 0, pane: [] };
      const C = { document: { createElement: (tag) => ({ tag, dataset: {}, kids: [], append(...a) { this.kids.push(...a); }, appendChild(a) { this.kids.push(a); return a; }, addEventListener(ev, fn) { this["on" + ev] = fn; } }) },
        $: (id) => { if (id !== "ta") throw new Error("unexpected $(" + id + ")"); return ta; }, autosize: () => { log.sized++; }, trackFeature: (n) => log.tf.push(n),
        paneSt: { chat: { off: false } }, paneToggle: (k, off) => { log.pane.push([k, off]); C.paneSt.chat.off = off; } };
      vm.createContext(C);
      const i18n = read(path.join(R, "i18n.js")); if (!/^let LANG = "en";$/m.test(i18n)) throw new Error("i18n.js 的 LANG 宣告變了");
      vm.runInContext(read(path.join(R, "strings.js")) + "\n" + i18n.replace(/^let LANG = "en";$/m, 'var LANG = "' + L + '";') + "\n"
        + src.slice(src.indexOf("const WD_P ="), src.indexOf("function wdNote(")).replace(/^const /gm, "var ") + "\n" + cutFn(src, "wdAsk") + "\n" + cutFn(src, "wdRow") + "\n" + cutFn(src, "wdFill"), C);
      return { C, ta, log, click: (id) => { const b = C.wdRow(id); b.onclick(); return b; } };
    };
    const bad = [], seen = {}; let built = 0;
    for (const L of ["zh", "en"]) {
      const X = lab(L), S = STR[L], tpl = S["wd.ask"], [pre, post] = tpl.split("{name}");
      for (const [id] of WEL) {
        X.ta.value = ""; X.C.WD.filled = ""; X.C.WD.pre = "";
        const b = X.click(id), got = X.ta.value, an = S["wd.r." + id + ".an"] || "", why = [];
        const mt = S["wd.r." + id + ".fq"] + S["wd.sep"] + S["wd.r." + id + ".sy"], l1 = b.kids[0] || {}, k = l1.kids || [];
        if (b.tag !== "button" || b.kids.length !== 1 || l1.className !== "wd-l1" || k.length !== 2 || k[0].className !== "wd-nm" || k[1].className !== "wd-mt") why.push("列不是只有一行「名字 + 小字」");
        if (k[0] && k[0].textContent !== S["wd.r." + id + (TAB.WD_WNM.has(id) ? ".wnm" : ".nm")]) why.push("列上顯示的名字不是 .nm / .wnm");
        if (k[1] && k[1].textContent !== mt) why.push("小字不是 頻率・起始年");
        if (!an || nosp(got) !== nosp(askOf(L, id))) why.push("不是模板代入 .an");
        if (!got.startsWith(pre) || !got.endsWith(post) || got.length <= tpl.length - 6) why.push("句子不完整");
        if (/[{}]|wd\.|undefined|null/.test(got)) why.push("佔位或 key 漏出來");
        if (/[()（）〈〉]/.test(got)) why.push("有括號");
        if (/\s\s|^\s|\s$|\n/.test(got)) why.push("多餘空白");
        if (L === "zh" && /[⺀-鿿][A-Za-z0-9]|[A-Za-z0-9][⺀-鿿]/.test(got)) why.push("中英之間少一格半形空白");
        if (L === "en" && /[^\x20-\x7e]/.test(got)) why.push("英文句子有非 ASCII 字");
        if (/\b(BTC|ETH|SOL|TSMC|Hon Hai)\b|台積電|鴻海|\d{4}/.test(an)) why.push(".an 帶了幣種 / 標的 / 年份");
        if (seen[L + got]) why.push("跟 " + seen[L + got] + " 同一句"); seen[L + got] = id;
        if (why.length) bad.push(L + ":" + id + "「" + got + "」" + why.join("、"));
        built++;
      }
    }
    ok("② 歡迎頁 " + WEL.length + " 列 × zh / en:每一列點下去都是完整句子(模板 wd.ask 代入 .an)、沒有括號與佔位、中英之間有空白、不帶幣種標的、各列不同句;列上顯示的是 .nm / .wnm、小字是 頻率・起始年",
      WEL.length > 0 && built === WEL.length * 2 && bad.length === 0, bad.join("\n    "));
    // wdFill 的情境(同 ③,這裡不靠 Electron)。A / B / C = 三列的句子
    const SA = askOf("zh", "bnk"), SB = askOf("zh", "ti"), SC = askOf("zh", "liq"), eq = (got, pre, sent) => got.startsWith(pre) && nosp(got.slice(pre.length)) === nosp(sent);
    let X = lab("zh"); const A = X.click("bnk") && X.ta.value;
    ok("② 空輸入框點一列 → 那一句落進輸入框、autosize + focus、記 welcome_data_row、聊天欄開著就不動它", eq(A, "", SA) && X.log.sized === 1 && X.ta.focused === true && X.log.tf.join() === "welcome_data_row" && X.log.pane.length === 0, A);
    const B = X.click("ti") && X.ta.value;
    ok("② 空框連點 A → B → 只剩 B(不疊成兩句)", eq(B, "", SB) && !B.includes("\n"), B);
    X = lab("zh"); X.ta.value = "半句  \n"; const D = X.click("bnk") && X.ta.value, E = X.click("ti") && X.ta.value, F = X.click("liq") && X.ta.value;
    ok("② 自己先打了「半句」再點 A → 「半句\\nA」(尾端空白收掉);再點 B → 「半句\\nB」、再點 C → 「半句\\nC」:只換那一句,自己打的字一直在(稽核 P1:原本第二次點會整框換掉)",
      eq(D, "半句\n", SA) && eq(E, "半句\n", SB) && eq(F, "半句\n", SC), JSON.stringify([D, E, F]));
    X = lab("zh"); X.click("bnk"); X.ta.value = X.ta.value + "，先看 4 小時線"; const G0 = X.ta.value, G = X.click("ti") && X.ta.value;
    ok("② 點 A 之後自己手動改了字再點 B → 改過的整段都算自己的字、留著,B 接在後面另起一行", eq(G, G0 + "\n", SB), G);
    X.ta.value = ""; const H = X.click("liq") && X.ta.value;
    ok("② 填完後自己把框清空(或送出後被清空)再點一列 → 只有那一句,不把舊的字帶回來", eq(H, "", SC), H);
    X = lab("zh"); X.C.paneSt.chat.off = true; X.click("fng");
    ok("② 聊天欄收著 → 先展開(paneToggle(\"chat\", false))再填", JSON.stringify(X.log.pane) === '[["chat",false]]' && eq(X.ta.value, "", askOf("zh", "fng")) && X.log.tf.length === 1, JSON.stringify(X.log)); }

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
    // 欄的範圍 = 它子項的聯集:兩欄並排時 .wl-col 是 display: contents,自己沒有盒子(getBoundingClientRect 全 0,並排的斷言會假綠)
    const rc = (c) => { const k = [...c.children].map((e) => e.getBoundingClientRect()); return { left: Math.min(...k.map((r) => r.left)), right: Math.max(...k.map((r) => r.right)), top: Math.min(...k.map((r) => r.top)), bottom: Math.max(...k.map((r) => r.bottom)) }; };
    return { visible: !$("main-empty").hidden && !$("wl").hidden, cmp2: body.classList.contains("cmp2"), cols: cols.map((c) => ({ cap: (c.querySelector(".wl-cap") || {}).textContent || "", note: (c.querySelector(".wl-note") || {}).textContent || "",
        rows: c.querySelectorAll(".wd-row").length, locked: c.querySelectorAll(".wd-row[disabled], .wd-row[aria-disabled], .wd-row.is-locked").length,
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
  { // 兩欄的欄頭與列共用橫排:右欄那句折成兩行時,兩條 hairline 與第一列仍在同一條 y(原本各排各的,錯開一行字高)
    const al = () => js(`[...$("wl-body").querySelectorAll(".wl-col")].map((c) => { const h = c.querySelector(".wl-colh"), hr = h.getBoundingClientRect(), cap = h.querySelector(".wl-cap").getBoundingClientRect(), n = h.querySelector(".wl-note");
      return { hTop: hr.top, hBot: hr.bottom, rTop: c.querySelector(".wd-row").getBoundingClientRect().top, wrapped: !!n && n.getBoundingClientRect().top >= cap.bottom - 2 }; })`);
    const same = (a) => Math.abs(a[0].hTop - a[1].hTop) < 0.5 && Math.abs(a[0].hBot - a[1].hBot) < 0.5 && Math.abs(a[0].rTop - a[1].rTop) < 0.5;
    const a1 = await al(); await js(`$("wl-body").style.width = "300px"`); await wait(50); const a2 = await al(), s2 = await snap(); await js(`$("wl-body").style.width = ""`); await wait(50);
    ok("③ 兩欄並排:欄頭同高、hairline 同一條 y、第一列同 y;把欄擠窄讓右欄那句折到第二行,三者仍對齊、仍是左右兩欄", same(a1) && !a1[1].wrapped && a2[1].wrapped && !a2[0].wrapped && same(a2) && a2[1].hBot - a2[1].hTop > a1[1].hBot - a1[1].hTop + 10
      && s2.cols[1].r.left >= s2.cols[0].r.right - 1, JSON.stringify([a1, a2])); }
  ok("③ 「看全部資料」鈕字、市場分段看得到、沒有 TWD 字樣(沒登入不講價)", s.all === Z["wd.all"] && s.seg && !/TWD/.test(s.text));
  // 點列:落進輸入框、不送出
  await js(`$("wl-body").querySelector(".wl-col .wd-row").click()`); await wait(50); s = await snap();
  ok("③ 點免費欄第一列 → 討論句(wd.ask × wd.r.bnk.an)落進輸入框、沒有送出(沒有泡泡、沒在跑)、記 welcome_data_row", nosp(s.ta) === nosp(askOf("zh", "bnk")) && !/[{}()（）]|wd\./.test(s.ta) && s.msgs === 0 && s.running === false && s.tf.includes("welcome_data_row"), JSON.stringify([s.ta, s.msgs, s.tf]));
  await js(`$("wl-body").querySelectorAll(".wl-col")[1].querySelector(".wd-row").click()`); await wait(50); s = await snap();
  ok("③ 再點另一列 → 上一句直接換掉(不疊成兩句)", nosp(s.ta) === nosp(askOf("zh", "ti")) && !s.ta.includes("\n"), s.ta);
  await js(`$("ta").value = "my own draft"; $("wl-body").querySelector(".wl-col .wd-row").click()`); await wait(50); s = await snap();
  ok("③ 自己打到一半的字留著,那一句接在後面另起一行", s.ta.startsWith("my own draft\n") && nosp(s.ta.slice(13)) === nosp(askOf("zh", "bnk")), s.ta);
  await js(`$("wl-body").querySelectorAll(".wl-col")[1].querySelector(".wd-row").click()`); await wait(50); s = await snap();
  ok("③ 接著再點另一列 → 只換那一句,自己打的字還在(稽核 P1)", s.ta.startsWith("my own draft\n") && nosp(s.ta.slice(13)) === nosp(askOf("zh", "ti")), s.ta);
  await js(`$("ta").value += " edited"; $("wl-body").querySelector(".wl-col .wd-row").click()`); await wait(50); s = await snap();
  ok("③ 點完自己又改了字再點一列 → 改過的整段留著,新的一句接在後面", s.ta.startsWith("my own draft\n") && s.ta.includes(" edited\n") && nosp(s.ta.split("\n").pop()) === nosp(askOf("zh", "bnk")) && s.ta.split("\n").length === 3, s.ta);
  await js(`$("ta").value = ""; WD.filled = ""; WD.pre = ""`);
  // 一列一行:幾何與熱區實測(canon › Verification:熱區用 elementFromPoint 量,不用 CSS 推)
  const geo = () => js(`[...$("wl-body").querySelectorAll(".wd-row")].map((b) => { b.scrollIntoView({ block: "center" });
    const r = b.getBoundingClientRect(), n = b.querySelector(".wd-nm").getBoundingClientRect(), m = b.querySelector(".wd-mt").getBoundingClientRect(), x = r.left + r.width / 2;
    let hit = 0; for (let y = Math.floor(r.top) - 2; y <= Math.ceil(r.bottom) + 2; y++) { const e = document.elementFromPoint(x, y); if (e && (e === b || b.contains(e))) hit++; }   // 整數 y:elementFromPoint 的命中測試以整 px 為單位,列的起點常落在 .5
    return { id: b.dataset.id, kids: b.children.length, l1: b.firstElementChild.className + ":" + b.firstElementChild.children.length, h: r.height, hit, one: m.top < n.bottom - 2, mid: Math.abs((n.top + n.bottom) / 2 - (r.top + r.bottom) / 2),
      nmLeft: n.left - r.left, gap: m.left - n.right, mtLeft: m.left - r.left, over: b.scrollWidth - b.clientWidth, mt: b.querySelector(".wd-mt").textContent }; })`);
  let g = await geo();
  ok("③ 每一列只有 .wd-l1 一行(名字 + 小字)、小字 = 頻率・起始年;列高與實測熱區都 ≥ 44;放得下的列是單行:高剛好 44、字垂直置中、名字內距 12、小字緊跟在名字後面隔 12(不靠右)",
    g.length === 6 && g.every((x) => x.kids === 1 && x.l1 === "wd-l1:2" && x.h >= 43.99 && x.hit >= 44 && x.over <= 0 && Math.abs(x.nmLeft - 12) < 0.6 && x.mt === Z["wd.r." + x.id + ".fq"] + Z["wd.sep"] + Z["wd.r." + x.id + ".sy"])
    && g.filter((x) => x.one).length >= 5 && g.filter((x) => x.one).every((x) => Math.abs(x.h - 44) < 0.01 && x.mid <= 1.5 && Math.abs(x.gap - 12) < 0.6)
    && (await js(`!$("wl-body").querySelector(".wd-l2, .wd-gl, .wd-tx")`)), JSON.stringify(g));
  await js(`$("wl-body").style.width = "200px"`); await wait(50); g = await geo();
  ok("③ 欄很窄(200):小字整段折到名字下面、靠左(跟名字同一條左緣)、列跟著長高、不橫向溢出", g.every((x) => !x.one && Math.abs(x.mtLeft - 12) < 0.6 && x.h > 44 && x.hit >= 44 && x.over <= 0), JSON.stringify(g));
  await js(`$("wl-body").style.width = ""`); await wait(50);
  { const sh = await js(`[...$("wl-seg").querySelectorAll("button")].map((b) => { b.scrollIntoView({ block: "center" }); const r = b.getBoundingClientRect(), x = r.left + r.width / 2, cy = (r.top + r.bottom) / 2; let hit = 0;
      for (let y = Math.floor(cy) - 30; y <= Math.ceil(cy) + 30; y++) { if (document.elementFromPoint(x, y) === b) hit++; } return { h: r.height, hit }; })`);
    ok("③ 市場分段三格的熱區實測 ≥ 44(視覺 30 高、::before 上下外擴,沒有被容器裁掉)", sh.length === 3 && sh.every((x) => x.h === 30 && x.hit >= 44), JSON.stringify(sh)); }
  // 窄:上下疊、免費在上
  w.setSize(1000, 900); await wait(400); s = await snap();
  ok("③ 1000 寬(中欄 < 700):上下疊、免費欄在上", s.cmp2 && s.cols.length === 2 && s.cols[1].r.top >= s.cols[0].r.bottom - 1 && s.cols[0].cap === Z["wd.col.free"], JSON.stringify([s.cols[0].r, s.cols[1].r]));
  w.setSize(1600, 900); await wait(400);
  // 台指期:免費欄是日線那一列(期交所),分線在 Blave 欄
  await js(`$("wl-seg").querySelector('[data-mk="txf"]').click()`); await wait(50); s = await snap();
  ok("③ 切到台指期:免費欄 1 列(台指期日線,短名、小字「日・1998 年起」)、Blave 欄 4 列(第一列是分線,短名)", s.cols[0].rows === 1 && s.cols[1].rows === 4
    && (await js(`(() => { const c = $("wl-body").querySelectorAll(".wl-col"), a = c[0].querySelector(".wd-row"), b = c[1].querySelector(".wd-row"); return a.dataset.id === "txd" && b.dataset.id === "txk" && a.querySelector(".wd-nm").textContent === t("wd.r.txd.wnm") && b.querySelector(".wd-nm").textContent === t("wd.r.txk.wnm") && a.querySelector(".wd-mt").textContent === t("wd.r.txd.fq") + t("wd.sep") + t("wd.r.txd.sy"); })()`)), JSON.stringify(s.cols.map((c) => c.rows)));
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
  ok("③ 單一清單的目錄沒有來源欄,目錄腳只講「不能回測的」那一句(不講在解釋公開 / Blave 標籤的 wd.foot.1)", (await js(`[...$("wl-body").querySelectorAll(".wd-foot p")].map((p) => p.textContent).join("|")`)) === Z["wd.foot.2"]);
  await js(`$("wl-all").click()`); await wait(50); s = await snap();
  ok("③ 再按一次 → 回到清單、分段回來", !s.table && s.seg && s.cols.length === 1 && s.all === Z["wd.all"]);
  await paint(`${base}`); await js(`$("wl-all").click()`); await wait(50); s = await snap();
  ok("③ 對比版的目錄多「來源」欄:5 欄、每列一個 Mini tag(公開 / Blave)、狀態列講那一句(按小時那句)", s.table && s.th === 5 && s.tags === CAT.length && s.state === Z["wd.note.billed"].replace("{r}", "2") && (await js(`$("wl-body").querySelectorAll(".wd-tag.line").length`)) === CAT.filter((r) => r[2] === TAB.WD_P).length, JSON.stringify([s.th, s.tags, s.state]));
  ok("③ 對比版的目錄腳兩句都在(wd.foot.1 + wd.foot.2)", (await js(`[...$("wl-body").querySelectorAll(".wd-foot p")].map((p) => p.textContent).join("|")`)) === Z["wd.foot.1"] + "|" + Z["wd.foot.2"]);
  // 目錄的兩種模式:中欄 ≥ 860 是表格(.wc-inner 放寬到 1040)、以下是一列一塊;量左緣與橫向溢出(zh / en)
  const cat = () => js(`(() => { const q = (s) => $("wl").querySelector(s), tx = (e) => { if (!e) return null; const r = document.createRange(); r.selectNodeContents(e); return Math.round(r.getBoundingClientRect().left * 10) / 10; };
    const me = $("main-empty"), cw = q(".wd-catw"), tb = q("table.wd-cat"), row = "tbody tr:not(.g) ";
    return { cont: me.clientWidth, inner: Math.round(q(".wd-catw").closest(".wc-inner").getBoundingClientRect().width), td: getComputedStyle(q(row + "td")).display, thW: q("thead").getBoundingClientRect().width,
      over: [me.scrollWidth - me.clientWidth, cw.scrollWidth - cw.clientWidth, Math.round((tb.getBoundingClientRect().right - cw.getBoundingClientRect().right) * 10) / 10],
      left: { title: tx(q(".wl-top .wl-cap")), state: tx($("wl-state")), group: tx(q("tr.g .wl-cap")), name: tx(q(row + "td.nm")), fq: tx(q(row + "td.fq")), src: tx(q(row + "td.sr")), us: tx(q(row + "td.us")), foot: tx(q(".wd-foot p")), all: tx($("wl-all")) },
      ntLines: Math.max(...[...$("wl").querySelectorAll("td.nm small")].map((e) => Math.round(e.getBoundingClientRect().height / 18))) }; })()`);
  const same = (o) => { const v = Object.values(o).filter((x) => x !== null); return v.length >= 8 && Math.max(...v) - Math.min(...v) <= 0.5; };
  for (const L of ["zh", "en"]) {
    await js(`setLang("${L}"); applyStatic(); true`); w.setSize(1600, 900); await wait(400);
    let c = await cat();
    ok("③ 目錄(" + L + ")中欄 ≥ 860 → 表格模式:.wc-inner 放寬(> 780、≤ 1040)、沒有橫向溢出、名字下的補充小字最多三行(780 寬時英文折到五行)", c.cont >= 860 && c.td === "table-cell" && c.inner > 780 && c.inner <= 1040 && c.over.every((x) => x <= 0.5) && c.ntLines <= 3, JSON.stringify(c));
    w.setSize(1320, 900); await wait(400); c = await cat();
    ok("③ 目錄(" + L + ")中欄 700–859 → 一列一塊(td 變 block、欄頭藏起來)、不橫捲;標題、狀態句、分組標籤、資料名、頻率、來源標籤、可以回測、目錄腳、「收起」鈕的左緣同一條線", c.cont >= 700 && c.cont < 860 && c.td === "block" && c.thW <= 1 && c.over.every((x) => x <= 0.5) && same(c.left), JSON.stringify(c));
  }
  await js(`setLang("zh"); applyStatic(); true`);
  w.setSize(1000, 900); await wait(400);
  { const c = await cat();
    ok("③ 窄欄的目錄:表格改成一列一塊(td 變 block、欄頭藏起來),不橫捲,左緣同一條線", c.td === "block" && c.thW <= 1 && c.over.every((x) => x <= 0.5) && same(c.left), JSON.stringify(c)); }
  await js(`$("wl-all").click()`); await wait(50);
  // 指紋:狀態沒變就不重畫(焦點不被洗掉)
  ok("③ 帳號狀態沒變再 wdPaint:DOM 不重建(焦點留在列上)", (await js(`(() => { const b = $("wl-body").querySelector(".wd-row"); b.focus(); wdPaint(); return document.activeElement === b; })()`)));
  // 第一次上色不靠載入順序(稽核 P2):設定裡選過語言時 applyStatic 在 app.js 裡同步跑完、早於 welcome.js,那一次畫不到
  await js(`localStorage.setItem("ws_lang", "zh"); true`);
  { const loaded = new Promise((r) => w.webContents.once("did-finish-load", r)); w.reload(); await loaded; await wait(1200); }
  ok("③ 選過語言、沒登入、重新載入:不用誰再叫 wdPaint,清單已經畫好(兩欄、中文、加密 2 + 4 列)", (await js(`(() => { const c = [...$("wl-body").querySelectorAll(".wl-col")]; return !hasToken && LANG === "zh" && c.length === 2 && c[0].querySelectorAll(".wd-row").length === 2 && c[1].querySelectorAll(".wd-row").length === 4 && c[0].querySelector(".wl-cap").textContent === t("wd.col.free") && $("wl-all").textContent === t("wd.all"); })()`)), JSON.stringify(await js(`({ hasToken: !!hasToken, LANG, saved: localStorage.getItem("ws_lang"), aria: $("wl-seg").getAttribute("aria-label"), cols: $("wl-body").querySelectorAll(".wl-col").length, rows: $("wl-body").querySelectorAll(".wd-row").length, all: $("wl-all").textContent, hidden: $("main-empty").hidden })`)));
  console.log(red ? `\n${red} FAILED` : "\nALL PASS");
  app.exit(red ? 1 : 0);
}).catch((e) => { console.log("FAIL  " + (e && e.stack || e)); app.exit(1); });
