// 歡迎頁的資料清單(shell/renderer/welcome.js + welcome.css + index.html #wl;設計 mockup data-scope §1)。
//   ① 純邏輯 wdMode(從原文切出來跑):帳號狀態 → 對比版 / 單一清單——沒登入、查不到、舊 api、沒綁卡、餘額不夠、按小時付 → 兩欄對比;
//      綁卡試用中、名下有主機、API 方案(data_access = included)→ 單一清單;試用那句只在名下沒主機時講
//   ② 原文鎖:index.html 骨架(記號與標題「開始一支策略」並排一行 → 三顆籤 → #wl、狀態句在頁尾、起手籤 #chat-eg 退役)、welcome.css(.main-empty 是容器、≥760 才兩欄、不寫 hex)、
//      app.js 四個重畫入口、welcome.js 在 app.js 之後、telemetry 白名單尾端兩個名字(≤16 字、api 端同一份)、
//      每一列的字 zh / en 兩語齊全(列舉 WD_ROWS,不抽樣)、字裡沒有「付費」、價格數字不寫死({r} 只在 wd.note.billed)
//      一列一行(名字 + 小字,沒有第二行起手句);點列 = 「跟我討論要怎麼用〈資料名〉做策略」(模板 wd.ask × 每列的 .an):
//      wdRow / wdFill / wdAsk 原文接假 DOM 在純 node 跑(run_all 不起 Electron),歡迎頁每一列 × 兩語逐列組句子;
//      「看全部資料」= 用瀏覽器開網站的資料文件頁(wdDocs 原文在純 node 跑:三個市場 × 兩語六個網址),app 內的完整目錄退役(程式、樣式、字串都不留)
//   ③ Electron(offscreen、show:false,不會出現在螢幕上):對比版兩欄且免費在前、右欄不上鎖不變灰、單一清單一欄且無 TWD 字樣、
//      點列 → 那一句落進輸入框、不送出、自己打的草稿留著;列高與熱區實測 ≥ 44、窄欄小字折到名字下面;
//      A2 版面:步驟內容(籤／起手句／小標／卡／頁尾)同一條左軸、比記號內縮 32、清單是一張卡(列有底色、頭尾收圓角,兩欄各一張)、小字靠右成欄、hover 換色、狀態句在頁尾同一行;
//      中欄 <760 上下疊;點「看全部資料」→ 外開文件頁(六個網址)、清單畫面一個節點都不變、記 welcome_data_all
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
const ROWS = TAB.WD_ROWS;
// 「看全部資料」該開的網址:逐字寫在這裡(不從被測的程式推)。台指期在台股那一頁
const DOCS = { zh: { crypto: "https://blave.org/docs/zh/data_crypto", tw: "https://blave.org/docs/zh/data_twstock", txf: "https://blave.org/docs/zh/data_twstock" },
  en: { crypto: "https://blave.org/docs/en/data_crypto", tw: "https://blave.org/docs/en/data_twstock", txf: "https://blave.org/docs/en/data_twstock" } };
// 點某一列該落進輸入框的句子:模板代入那一列的 .an。比對時拿掉半形空白(中文模板在英數兩側補的那一格由 wdAsk 管,另外斷言)
const nosp = (x) => String(x).replace(/ /g, "");
const askOf = (L, id) => String(STR[L]["wd.ask"]).replace("{name}", STR[L]["wd.r." + id + ".an"]);

if (!process.versions.electron) {
  // ── ① 純邏輯 ──
  const a = src.indexOf("/* ── 純邏輯("), b = src.indexOf("/* ── 純邏輯到此");
  if (a < 0 || b < 0) throw new Error("找不到純邏輯區塊的標記");
  const block = src.slice(a, b);
  ok("① 純邏輯區塊不碰 DOM / i18n", !/\bdocument\b|\$\(|window\.|\bt\(/.test(block.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")));
  // wdMode 叫 app.js 的 acctOffer(有沒有卡的共用判斷):那兩行原文一起切進來跑
  // 改版前沒有這兩行:不丟例外,讓下面的斷言在舊碼上紅在語意
  const offerSrc = ["acctNoCard", "acctOffer"].map((n) => { const m = appSrc.match(new RegExp("^const " + n + " = [^\\n]*$", "m")); return m ? m[0].replace(/^const /, "var ") : ""; }).join("\n");
  const P = {}; vm.createContext(P); vm.runInContext(offerSrc + "\n" + block, P);
  const M = (signed, s, da, left) => JSON.stringify(P.wdMode(signed, s, da, left));
  ok("① 沒登入 → 對比版、out(不管手上有什麼狀態)", M(false, null, null, 0) === '{"cmp":true,"k":"out"}' && M(false, { data_access: "included" }, "included", 5) === '{"cmp":true,"k":"out"}');
  ok("① 登入了但查不到 / 舊 api 沒有 data_access → 對比版、unknown(不斷言價格)", M(true, null, null, 0) === '{"cmp":true,"k":"unknown"}' && M(true, { data_included: false }, null, 0) === '{"cmp":true,"k":"unknown"}');
  ok("① 沒綁卡(none + NO_CARD)→ 對比版、none;有卡沒錢(none + 其他)→ nobal", M(true, { data_access: "none", reason: "NO_CARD" }, "none", 0) === '{"cmp":true,"k":"none"}' && M(true, { data_access: "none", reason: "NO_CREDIT" }, "none", 0) === '{"cmp":true,"k":"nobal"}' && M(true, { data_access: "none" }, "none", 0) === '{"cmp":true,"k":"nobal"}');
  ok("① 有卡沒主機按小時付(billed)→ 對比版、billed", M(true, { data_access: "billed" }, "billed", 0) === '{"cmp":true,"k":"billed"}');
  ok("① 方案制:沒有方案 → 對比版 noplan(有試用資格又沒卡 → none,綁卡拿試用);扣款失敗 → 對比版 payfail",
    M(true, { data_access: "plan_required", reason: null }, "plan_required", 0) === '{"cmp":true,"k":"noplan"}' && M(true, { data_access: "plan_required", reason: "NO_CARD", trial_eligible: true }, "plan_required", 0) === '{"cmp":true,"k":"none"}'
    && M(true, { data_access: "plan_required", reason: "NO_CARD", trial_eligible: false }, "plan_required", 0) === '{"cmp":true,"k":"noplan"}' && M(true, { data_access: "payment_failed" }, "payment_failed", 0) === '{"cmp":true,"k":"payfail"}');
  /* paywall-redesign-2026-10-21 §5.1 狀態表每一列一案(方案制;沒卡看 has_card,舊 api 沒這欄退回 reason) */
  { const PR = (o) => M(true, { data_access: "plan_required", ...o }, "plan_required", 0), NONE = '{"cmp":true,"k":"none"}', NOPLAN = '{"cmp":true,"k":"noplan"}';
    ok("① §5.1 沒卡、有試用資格、綁卡前額度還有剩(can_run=true、reason 空、has_card:false)→ none(綁卡試用那句;舊碼看 reason 會落到 noplan)", PR({ can_run: true, reason: null, has_card: false, trial_eligible: true }) === NONE);
    ok("① §5.1 沒卡、有試用資格、額度用完(can_run=false、reason NO_CARD、has_card:false)→ none", PR({ can_run: false, reason: "NO_CARD", has_card: false, trial_eligible: true }) === NONE);
    ok("① §5.1 本機 CLI 登入、沒卡、有試用資格(can_run=false、reason 空——不是 Blave AI 的錢的問題)→ none", PR({ can_run: false, reason: null, has_card: false, trial_eligible: true }) === NONE);
    ok("① §5.1 有卡、試用中(included、沒主機、試用還有天數)→ 單一清單 trial;has_card:true 而 plan_required(不該出現的組合)也不講試用", M(true, { data_access: "included", has_card: true, plan: { state: "none" } }, "included", 5) === '{"cmp":false,"k":"trial"}'
      && PR({ can_run: true, has_card: true, trial_eligible: true }) === NOPLAN);
    ok("① §5.1 試用資格已用掉、沒方案:有卡或沒卡都 noplan", PR({ has_card: true, trial_eligible: false }) === NOPLAN && PR({ has_card: false, trial_eligible: false }) === NOPLAN && PR({ has_card: false, reason: "NO_CARD", trial_eligible: false }) === NOPLAN);
    ok("① §5.1 has_card 優先於 reason:has_card:true 就算 reason 還是 NO_CARD 也不是沒卡", PR({ can_run: false, has_card: true, reason: "NO_CARD", trial_eligible: true }) === NOPLAN);
    ok("① §5.1 方案扣款失敗 → payfail(不看 has_card)", M(true, { data_access: "payment_failed", has_card: false, trial_eligible: true }, "payment_failed", 0) === '{"cmp":true,"k":"payfail"}');
    ok("① §5.1 沒登入 → out(不看 has_card)", M(false, { data_access: "plan_required", has_card: false, trial_eligible: true }, "plan_required", 0) === '{"cmp":true,"k":"out"}');
    ok("① §5.1 新外殼接舊 api(沒有 has_card):退回 reason——NO_CARD+有試用 → none、reason 空 → noplan(跟改版前同一份分類)",
      PR({ can_run: false, reason: "NO_CARD", trial_eligible: true }) === NONE && PR({ can_run: true, reason: null, trial_eligible: true }) === NOPLAN && PR({ can_run: true, reason: null, has_card: null, trial_eligible: true }) === NOPLAN); }
  ok("① 綁卡試用中(included、沒主機、試用還有天數)→ 單一清單、trial", M(true, { data_access: "included", plan: { state: "none" } }, "included", 5) === '{"cmp":false,"k":"trial"}');
  ok("① 名下有主機 / API 方案(included)→ 單一清單、incl;有主機的人就算試用日期還在也不講「免費到」", M(true, { data_access: "included", plan: { state: "running" } }, "included", 5) === '{"cmp":false,"k":"incl"}' && M(true, { data_access: "included", plan: { state: "none" } }, "included", 0) === '{"cmp":false,"k":"incl"}' && M(true, { data_included: true }, "included", 0) === '{"cmp":false,"k":"incl"}');

  // ── ② 原文鎖 ──
  const chips = html.slice(html.indexOf('class="wc-chips"'), html.indexOf('id="wl-fold"'));
  const wcBox = html.slice(html.indexOf('id="main-empty"'), html.indexOf("</section>", html.indexOf('id="main-empty"')));
  ok("② index.html(onboarding E/F):#main-empty 裡是 .wc-inner#wc(步驟清單,預設 hidden)與 .wf#wf(完成後首頁,預設 hidden);#wc 由上到下 記號 → 市場題 → ①(#chat-idea、#onb-lib)→ ②(#st-rows、#chat-ns、#wl-fold、#wl)→ ③ → ④ → #onb-fin;#chat-lib、起手籤 #chat-eg、三張卡 #wc-reco 退役",
    /<div class="wc-inner" id="wc" hidden>/.test(wcBox) && /<div class="wf" id="wf" hidden>/.test(wcBox) && wcBox.split('class="wc-inner"').length === 2 && !html.includes('id="chat-lib"') && !html.includes('id="chat-eg"') && !html.includes('id="wc-reco"') && !/ws\.chatExample/.test(html + appSrc)
    && ['class="wc-mark"', 'class="onb-mq"', 'id="chat-idea"', 'id="onb-lib"', 'id="st-rows"', 'id="chat-ns"', 'id="wl-fold"', 'id="wl"', 'id="onb-po"', 'id="onb-paper"', 'id="onb-fin"', 'id="wf"'].every((x, i, a) => wcBox.includes(x) && (i === 0 || wcBox.indexOf(x) > wcBox.indexOf(a[i - 1]))));
  { const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]), dup = ids.filter((x, i) => ids.indexOf(x) !== i);
    ok("② 入口籤的 id 不重複:index.html 每一個 id 都只出現一次(列舉全部 " + ids.length + " 個)", ids.length > 100 && dup.length === 0, dup.join(", ")); }
  ok("② 標題拿掉(Wei 10-19):沒有 .wc-head / h4.wc-h,兩語字串表與 .po 都沒有 workspace_wel_h;記號 svg.wc-mark 直接在 #wc 第一個;起手句容器 role=group、aria-labelledby 指到步驟②的標題列",
    !/wc-head|class="wc-h"/.test(html) && /<div class="wc-inner" id="wc" hidden>\s*<svg class="wc-mark"/.test(wcBox) && html.split('class="wc-mark"').length === 2
    && !("workspace_wel_h" in STR.zh) && !("workspace_wel_h" in STR.en) && !/workspace_wel_h/.test(read(path.join(SHELL, "i18n", "zh.po")) + read(path.join(SHELL, "i18n", "en.po")))
    && /<div class="st-rows" id="st-rows" role="group" aria-labelledby="onb-h2"><\/div>/.test(html) && !("wd.start" in STR.zh) && !("lib.chip" in STR.en));
  ok("② 資料摺疊(§1.5):#wl-fold 是 button、aria-expanded=false、aria-controls=wl、字 = wd.title、行尾是共用的 .mp-chev(canon Trigger + caret;不再用 ›,Wei)、收起朝下展開翻上只綁 aria-expanded;#wl 預設 hidden(每次開 app 都收起來,不讀不寫任何偏好)",
    /<button class="wl-fold" id="wl-fold" type="button" aria-expanded="false" aria-controls="wl"><span data-i18n="wd\.title"><\/span><span class="mp-chev" aria-hidden="true"><\/span><\/button>/.test(html)
    && /\.wl-fold \{[^}]*display: inline-flex; align-items: center;/.test(css) && /\.wl-fold\[aria-expanded="true"\] \.mp-chev \{ transform: rotate\(-135deg\); margin-bottom: -2px; \}/.test(css) && !/›/.test(html.slice(html.indexOf('id="wl-fold"'), html.indexOf("</button>", html.indexOf('id="wl-fold"')))) && /<div class="wl" id="wl" hidden>/.test(html)
    && !/localStorage|Prefs|prefs/.test(src.slice(src.indexOf('$("wl-fold").addEventListener'), src.indexOf("/* ── 入門步驟(E)"))));
  ok("② #wl 骨架:頂端小標拿掉(摺疊鈕已經寫了 wd.title)、市場分段 #wl-seg(.lib-seg 配方、三格 crypto / tw / txf、加密預設選中)、#wl-body、頁尾 .wl-foot 裡依序是 #wl-all(.btn-quiet、字固定 = data-i18n wd.all,同設定頁條款那兩顆外開鈕的做法)與 #wl-state(aria-live);狀態句不在清單上面",
    /<div class="wl-top">\s*<span class="lib-seg" id="wl-seg" role="group" data-i18n-aria="wd\.title">/.test(html)
    && (html.slice(html.indexOf('id="wl-seg"'), html.indexOf("</span>", html.indexOf('id="wl-seg"'))).match(/data-mk="(crypto|tw|txf)" aria-pressed="(true|false)" data-i18n="wd\.mk\.\1"/g) || []).length === 3
    && /data-mk="crypto" aria-pressed="true"/.test(html) && /<div class="wl-body" id="wl-body"><\/div>\s*<div class="wl-foot"><button class="btn-quiet" id="wl-all" type="button" data-i18n="wd\.all"><\/button><p class="wl-state" id="wl-state" aria-live="polite"><\/p><\/div>/.test(html)
    && html.split('id="wl-state"').length === 2);
  ok("② 載入順序:welcome.css 有載;welcome.js 在 app.js 之後(用 app.js 的 $ / t / acct / planVars / autosize / trackFeature;放最後一支,不插進 app.js → suggest.js 之間)", /<link rel="stylesheet" href="welcome\.css">/.test(html) && html.indexOf('src="welcome.js"') > html.indexOf('src="app.js"') && (html.match(/<script src="[^"]+"><\/script>/g) || []).pop() === '<script src="welcome.js"></script>');
  ok("② app.js 四個重畫入口:acctPaint(帳號狀態變)、acctPrecheck(能跑的人不走 acctPaint)、applyStatic 最後(換語言)、acctSignOut(登出)",
    /wdPaint\(\)/.test(cutFn(appSrc, "acctPaint")) && /acct = await window\.blave\.accountStatus\(\); acctAt = Date\.now\(\);\n[^\n]*\n\s*if \(typeof wdPaint === "function"\) wdPaint\(\);/.test(appSrc)
    && /\[data-i18n-aria\]"\)\.forEach[^\n]*\n\s*if \(typeof wdPaint === "function"\) wdPaint\(\);[^\n]*\n\}/.test(appSrc) && /hasToken = false; acct = null; balLast = null; planErr = null; planBusy = false;\n\s*if \(typeof wdPaint === "function"\) wdPaint\(\);/.test(appSrc));
  ok("② 起手籤整個拿掉:app.js 沒有 chat-eg,兩語字串表與 .po 都沒有 ws.chatExample", !/chat-eg/.test(appSrc) && !("ws.chatExample" in STR.zh) && !("ws.chatExample" in STR.en) && !/ws\.chatExample/.test(read(path.join(SHELL, "i18n", "zh.po")) + read(path.join(SHELL, "i18n", "en.po"))));
  ok("② welcome.css:.main-empty 是容器(container-type)、兩欄只在 ≥760 的容器查詢裡、免費欄不靠 order 換位(DOM 順序就是免費在前)、不寫 hex、減少動態有收;小字不 nowrap(設計稽核 2);.wc-inner 最寬 760、上對齊不置中(稽核 4);欄小標用 .wl-cap(稽核 1)",
    /\.main-empty \{ container-type: inline-size; \}/.test(css) && /@container \(min-width: 760px\) \{\s*\.wl-body\.cmp2 \{ grid-template-columns: 1fr 1fr;/.test(css)
    && /\.wl-body \{[^}]*grid-template-columns: 1fr;/.test(css) && !/\border:\s*-?\d/.test(css) && !/#[0-9a-fA-F]{3,8}\b/.test(css.replace(/\/\*[\s\S]*?\*\//g, "")) && /prefers-reduced-motion/.test(css)
    && !/\.wd-mt \{[^}]*nowrap/.test(css) && /\.wc-inner \{ width: 100%; max-width: 760px; margin: 0 0 auto; padding-top: var\(--space-32\); align-items: stretch; \}/.test(css) && !/wd-cap/.test(src + css) && /wdEl\("span", "wl-cap"/.test(src));
  ok("② 右欄不上鎖不變灰:資料清單(wdRow / wdPaint / wdNote)不給列 disabled / aria-disabled / 鎖的 class;每一列都是 button", !/disabled|is-locked|lock/i.test((cutFn(src, "wdRow") + cutFn(src, "wdPaint") + cutFn(src, "wdNote")).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")) && /wdEl\("button", "wd-row"\)/.test(src));
  ok("② 點列只填不送:wdRow / wdFillText / wdFill 不叫 sendDraft / submitMessage;wdFillText 填完 autosize + focus、不送埋點;wdFill = wdFillText + welcome_data_row(起手句只填不送走 wdFillText + starter_fill,不灌資料列的數)",
    !/sendDraft|submitMessage|trackFeature/.test(cutFn(src, "wdFillText")) && !/sendDraft|submitMessage/.test(cutFn(src, "wdRow") + cutFn(src, "wdFill")) && /ta\.value = [^\n]*;\n\s*WD\.filled = ta\.value; autosize\(\); ta\.focus\(\);\n\}/.test(cutFn(src, "wdFillText"))
    && /^function wdFill\(text\) \{ wdFillText\(text\); trackFeature\("welcome_data_row"\); \}$/.test(cutFn(src, "wdFill")) && /wdFillText\(text\); trackFeature\("starter_fill"\);/.test(cutFn(src, "stGo")) && !/wdFill\(/.test(cutFn(src, "stGo")));
  { const F = require(path.join(SHELL, "telemetry.js")).EVENTS.feature_used.name;
    ok("② telemetry 白名單:welcome_data_row / welcome_data_all 接在 topup_lib 後面(0.1.17 聊天附件三個再接在後面)、≤16 字", F.slice(F.indexOf("topup_lib") + 1, F.indexOf("topup_lib") + 3).join() === "welcome_data_row,welcome_data_all" && ["welcome_data_row", "welcome_data_all"].every((n) => n.length <= 16));
    const apiPy = path.join(process.env.BLAVE_API_DIR || path.join(__dirname, "..", "..", "api"), "openclaw", "desktop_telemetry.py");
    if (!fs.existsSync(apiPy)) console.log("SKIP  api 白名單比對(需要 monorepo 版面或 BLAVE_API_DIR)");
    else ok("② api 端 desktop_telemetry.py 的 feature_used 白名單也有這兩個(逐字、順序同)", /"bind_lib", "topup_lib",\n(?:[^\n]*\n)*?\s*"welcome_data_row", "welcome_data_all",/.test(read(apiPy))); }
  // 字:列舉每一列、每個欄位、兩語;不抽樣。欄位只有畫面用的四個(目錄的 .nt / .sn / .us 與短名 .wnm 隨目錄退役)
  const FIELDS = ["nm", "fq", "sy", "an"], missing = [];
  for (const [id, mk, s] of ROWS) {
    for (const L of ["zh", "en"]) for (const f of FIELDS) if (!STR[L]["wd.r." + id + "." + f]) missing.push(L + ":wd.r." + id + "." + f);
    if (!["crypto", "tw", "txf"].includes(mk) || ![TAB.WD_P, TAB.WD_B].includes(s)) missing.push("bad row " + id);
  }
  ok("② 每一列的字 zh / en 都齊(" + ROWS.length + " 列 × nm / fq / sy / an)", ROWS.length === 16 && ROWS.every((r) => r.length === 3) && missing.length === 0, missing.join(", "));
  const rowKeys = new Set(ROWS.flatMap((r) => FIELDS.map((f) => "wd.r." + r[0] + "." + f)));
  const extra = []; for (const L of ["zh", "en"]) for (const k of Object.keys(STR[L])) if (k.startsWith("wd.r.") && !rowKeys.has(k)) extra.push(L + ":" + k);
  ok("② 字串表的 wd.r.* 恰好是 WD_ROWS × 四個欄位:沒有多出來的列(BingX、CME／ICE、公開大盤、公開期貨法人、異常漲跌,與只進目錄的 14 列)、沒有多出來的欄位(.nt / .sn / .us / .wnm)", extra.length === 0, extra.join(", "));
  ok("② 列的順序就是畫面順序(WD_ROWS 沒有順序欄):加密 bnk fng ti conc liq fr、台股 twd inst rev twm br、台指期 txd txk txio fi pcr",
    ["crypto", "tw", "txf"].map((mk) => ROWS.filter((r) => r[1] === mk).map((r) => r[0]).join(" ")).join("|") === "bnk fng ti conc liq fr|twd inst rev twm br|txd txk txio fi pcr" && /const wdWel = \(mk\) => WD_ROWS\.filter\(\(r\) => r\[1\] === mk\);/.test(src));
  const fixed = ["wd.title", "wd.mk.crypto", "wd.mk.tw", "wd.mk.txf", "wd.col.free", "wd.col.blave", "wd.note.out", "wd.note.out.m", "wd.note.outNoNum", "wd.note.none", "wd.note.trial", "wd.note.noneNoNum", "wd.note.billed", "wd.note.billedNoNum", "wd.note.noplan", "wd.note.payfail", "wd.note.nobal", "wd.note.topup", "wd.state.trial", "wd.all", "wd.sep", "wd.ask", "wd.ask.build"];
  ok("② 固定字 " + fixed.length + " 個 zh / en 都有、wd.* 除了列的字就只有這些;三個市場的歡迎頁兩欄都有列(免費欄空著那句 wd.empty.* 與 .wl-empty 隨台指期免費日線退役)", fixed.every((k) => STR.zh[k] && STR.en[k])
    && ["zh", "en"].every((L) => Object.keys(STR[L]).filter((k) => k.startsWith("wd.") && !k.startsWith("wd.r.")).sort().join() === fixed.slice().sort().join())
    && ["crypto", "tw", "txf"].every((mk) => [TAB.WD_P, TAB.WD_B].every((sr) => ROWS.some((r) => r[1] === mk && r[2] === sr)))
    && !/wl-empty|wd\.empty/.test(src + css));
  const wd = (L) => Object.keys(STR[L]).filter((k) => k.startsWith("wd.")).map((k) => STR[L][k]);
  ok("② 字裡不出現「付費」/ paid;價格只在 wd.note.billed 一句({r} 由 account_status 下發,不寫死 2 TWD);試用天數也是 {t}", !wd("zh").some((s) => /付費/.test(s)) && !wd("en").some((s) => /\bpaid\b/i.test(s))
    && ["zh", "en"].every((L) => Object.keys(STR[L]).filter((k) => k.startsWith("wd.") && /\{r\}/.test(STR[L][k])).join() === "wd.note.billed") && !wd("zh").concat(wd("en")).some((s) => /\d\s*TWD/.test(s))
    && ["zh", "en"].every((L) => ["wd.note.out", "wd.note.out.m", "wd.note.none", "wd.note.trial"].every((k) => /\{t\}/.test(STR[L][k])) && /\{d\}/.test(STR[L]["wd.state.trial"])));
  // 右欄那句的兩態(wdNote 原文接假 DOM 在純 node 跑):方案制(planMo 真)試用結束會自動扣方案費,講「免費試用」不講「送」;切換前照舊「送」;沒天數兩態都是不帶數字那句
  { const note = (L, mo, k, v, click) => {
      const C = { planMo: () => mo, planOpen() { C.went = "plan"; }, bindGo(n) { C.went = "bind:" + n; }, signInLabel: (b, label) => { b.textContent = label; return b; }, document: { createElement: (tag) => ({ tag, kids: [], append(...a) { this.kids.push(...a); }, appendChild(a) { this.kids.push(a); return a; }, addEventListener(ev, fn) { this.click = fn; } }) } };
      vm.createContext(C);
      vm.runInContext(read(path.join(R, "strings.js")) + "\n" + read(path.join(R, "i18n.js")).replace(/^let LANG = "en";$/m, 'var LANG = "' + L + '";') + "\n" + src.slice(src.indexOf("const wdEl ="), src.indexOf("const wdK =")) + "\n" + cutFn(src, "wdNote"), C);
      const into = C.document.createElement("span"); C.wdNote(k, v, into);
      if (click) { const b = into.kids.find((x) => typeof x !== "string"); C.went = null; if (b && b.click) b.click(); return C.went; }
      return into.kids.map((x) => (typeof x === "string" ? x : x.textContent)).join("|"); };
    ok("② 右欄那句(zh)兩態:方案制 →「登入並綁卡，免費試用 14 天 Blave 資料」/「綁卡，免費試用 14 天」(欄名已寫 Blave 資料,paywall-redesign §2.2);切換前 →「送 14 天」照舊;沒天數兩態都不帶數字、是一顆鈕",
      note("zh", true, "out", { t: "14" }) === "登入並綁卡，免費試用 14 天 Blave 資料" && note("zh", false, "out", { t: "14" }) === "登入並綁卡，送 14 天 Blave 資料"
      && note("zh", true, "none", { t: "14" }) === "綁卡，免費試用 14 天" && note("zh", true, "none", { t: "7" }) === "綁卡，免費試用 7 天" && note("zh", false, "none", { t: "14" }) === "綁卡，送 14 天 Blave 資料"
      && note("zh", true, "out", { t: "" }) === "登入並綁卡後就能用" && note("zh", false, "none", { t: "" }) === "綁卡後就能用", [note("zh", true, "out", { t: "14" }), note("zh", true, "none", { t: "14" })].join(" / "));
    ok("② 右欄那句(en)兩態:方案制 free trial(連字號 U+2011,同 pv.h.offer.m);切換前 days free", note("en", true, "out", { t: "14" }) === "Sign in and add a card for a 14\u2011day free trial of Blave data"
      && note("en", true, "none", { t: "14" }) === "Add a card for a 14\u2011day free trial" && note("en", false, "out", { t: "14" }) === "Sign in and add a card: 14 days of Blave data free", note("en", true, "out", { t: "14" }));
    ok("② 右欄沒卡那顆鈕:方案制直接開瀏覽器綁卡頁(bindGo,記 bind_welcome;沒天數那句也一樣)、切換前照舊開設定 › 帳號與方案;沒登入照舊開瀏覽器登入不開綁卡頁",
      note("zh", true, "none", { t: "14" }, true) === "bind:bind_welcome" && note("zh", true, "none", { t: "" }, true) === "bind:bind_welcome" && note("zh", false, "none", { t: "14" }, true) === "plan" && note("zh", true, "noplan", {}, true) === "plan");
    ok("② 指紋帶 planMo():公開價目晚到、或登入後 acct 帶方案欄位時那句才會跟著重畫", /JSON\.stringify\(\[LANG, m\.k, m\.cmp, WD\.mk, v\.t, v\.r, v\.d, planMo\(\)\]\)/.test(src)); }
  { const txf = ROWS.filter((r) => r[1] === "txf");
    const listed = /_TAIFEX_INDEX_FUT_LISTED = \{'TXF': '(\d{4}-\d\d-\d\d)', 'MXF': '(\d{4}-\d\d-\d\d)', 'TMF': '(\d{4}-\d\d-\d\d)'\}/.exec(read(path.join(SHELL, "..", "lib", "data.py"))) || [];
    ok("② 台指期 K 線拆兩列:txd 日線在免費欄第一列、txk 分線在 Blave 欄第一列(頻率不再含日線);起始年同 lib/data.py _TAIFEX_INDEX_FUT_LISTED 的 TXF 上市年;WD_TXF_KLINE_SRC 常數退役",
      txf[0][0] === "txd" && txf[0][2] === TAB.WD_P && txf[1][0] === "txk" && txf[1][2] === TAB.WD_B && !/WD_TXF_KLINE_SRC/.test(src)
      && listed[1] === "1998-07-21" && /1998/.test(STR.zh["wd.r.txd.sy"]) && /1998/.test(STR.en["wd.r.txd.sy"])
      && !/日/.test(STR.zh["wd.r.txk.fq"]) && !/daily/i.test(STR.en["wd.r.txk.fq"])
      && /"fetch_txf_daily_public"/.test(read(path.join(SHELL, "..", "lib", "quality_check.py"))), JSON.stringify([listed.slice(1), STR.zh["wd.r.txd.sy"], STR.en["wd.r.txd.sy"]]));
    const wn = ["zh", "en"].flatMap((L) => Object.keys(STR[L]).filter((k) => /^wd\.r\..*\.wn$/.test(k)).map((k) => L + ":" + k));
    ok("② 歡迎頁列的小字只有「頻率・起始年」:列尾補充 .wn 與 WD_WN 退役;列上的名字只有 .nm 一種(目錄的長名與短名表 WD_WNM 退役),台指期兩列的名字不帶「近月連續」那個括號",
      wn.length === 0 && !/WD_WN\b|WD_WNM|"wn"|"wnm"/.test(src) && ["zh", "en"].every((L) => ["txd", "txk"].every((id) => !/[()（）]/.test(STR[L]["wd.r." + id + ".nm"]))), wn.join(", ")); }
  // ── 一列一行、點列 = 討論句(起手句 .tx 退役)──
  { const po = read(path.join(SHELL, "i18n", "zh.po")) + read(path.join(SHELL, "i18n", "en.po")), code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    const txKeys = ["zh", "en"].flatMap((L) => Object.keys(STR[L]).filter((k) => /^wd\.r\..*\.tx$/.test(k)).map((k) => L + ":" + k));
    ok("② 起手句退役:兩語字串表與 .po 沒有 wd.r.*.tx、welcome.js 不再讀 \"tx\"、第二行的 class(wd-l2 / wd-gl / wd-tx)在 js 與 css 都沒有;商品市場仍沒有列",
      txKeys.length === 0 && !/wd\.r\.[a-z0-9]+\.tx"/.test(po) && !/"tx"/.test(code) && !/wd-l2|wd-gl|wd-tx/.test(src + css) && !ROWS.some((r) => r[1] === "cmd"), txKeys.join(", "));
    ok("② 點列接的句子(§1.5):拿得到的列(單一清單、對比版免費欄)= wd.ask.build「幫我建一支並回測」;對比版 Blave 資料欄 = 討論句 wd.ask;列裡只有 .wd-l1 一行(名字 + 小字,小字 = 頻率・起始年)",
      /l1\.append\(wdEl\("span", "wd-nm", [^\n]*\), wdEl\("span", "wd-mt", wdK\(id, "fq"\) \+ t\("wd\.sep"\) \+ wdK\(id, "sy"\)\)\);\n\s*b\.appendChild\(l1\);\n\s*b\.addEventListener\("click", \(\) => wdFill\(wdAsk\(t\(build \? "wd\.ask\.build" : "wd\.ask"\), wdK\(id, "an"\)\)\)\);/.test(cutFn(src, "wdRow"))
      && /col\.appendChild\(wdRow\(r\[0\], src === WD_P\)\)/.test(cutFn(src, "wdPaint")) && /wdWel\(WD\.mk\)\.forEach\(\(r\) => col\.appendChild\(wdRow\(r\[0\], true\)\)\)/.test(cutFn(src, "wdPaint"))
      && STR.zh["wd.ask.build"] === "用{name}幫我建一支策略並回測" && STR.en["wd.ask.build"] === "Build and backtest a strategy with {name}");
    ok("② welcome.css:列高下限 44、只剩一行時垂直置中(.wd-row 是 grid,align-content: center)、內距 8/16(卡內距);小字靠右成欄(.wd-l1 space-between、間距 12、baseline、放不下整段折行)",
      /\.wd-row \{\s*display: grid; align-content: center; width: 100%; min-height: 44px; padding: var\(--space-8\) var\(--space-16\);/.test(css)
      && /\.wd-l1 \{ display: flex; align-items: baseline; justify-content: space-between; gap: var\(--space-2\) var\(--space-12\); flex-wrap: wrap; \}/.test(css));
    ok("② welcome.css(onboarding E/F):.wc-inner 子項靠左撐滿、最寬 760;記號 32 靠左;步驟內容內縮 32;起手句不留上距;F 的記號 104、實色 --color-watermark、不用 opacity;小標列與頁尾不內縮(同一條左軸)",
      /\.wc-mark \{ width: var\(--space-32\); color: var\(--ink\); align-self: flex-start; \}/.test(css) && !/\.wc-head|\.wc-h \{/.test(css)
      && /\.st-rows \{ margin: 0 calc\(-1 \* var\(--space-12\)\);/.test(css) && /\.onb-body \{ padding-left: var\(--space-32\);/.test(css)
      && /\.wf-mark \{ width: 104px; height: auto; flex: none; color: var\(--color-watermark\); \}/.test(css) && !/opacity/.test(css.replace(/\/\*[\s\S]*?\*\//g, ""))
      && /\.wl-top \{[^}]*padding: 0; \}/.test(css) && /\.wl-colh \{[^}]*padding: 0 0 var\(--space-8\); border-bottom: 0; margin-bottom: 0; \}/.test(css)
      && /\.wl-foot \{ display: flex; align-items: center; justify-content: space-between; gap: var\(--space-4\) var\(--space-16\); flex-wrap: wrap; margin-top: var\(--space-4\); padding: 0; \}/.test(css)
      && /\.wl-state \{ margin: 0; padding: 0; /.test(css) && /\.wl-foot > \.btn-quiet \{ display: inline-flex; align-items: center; min-height: 44px; color: var\(--ink-2\); \}/.test(css));
    ok("② welcome.css(A2):清單是一張卡——列自己上 --surface-card、列間 hairline、頭尾兩列收 --radius-lg(每欄第一列 = :first-child 或欄頭後那一列);行尾 › 用 ::after(替代文字空字串,不加 DOM);hover 底換 --surface-muted、小字換 --ink-2、› 換 --ink;focus 外框內縮;減少動態連 ::after 一起收",
      /\.wd-row \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto; column-gap: var\(--space-12\); align-items: center;[^}]*background: var\(--surface-card\); border-bottom: 1px solid var\(--border-hairline\); border-radius: 0;/.test(css)
      && /\.wd-row::after \{ content: "›" \/ ""; color: var\(--ink-3\); font-size: 14px; line-height: 1; transition: color var\(--motion-fast\) var\(--ease-standard\); \}/.test(css)
      && /\.wd-row:first-child, \.wl-colh \+ \.wd-row \{ border-top-left-radius: var\(--radius-lg\); border-top-right-radius: var\(--radius-lg\); \}/.test(css)
      && /\.wd-row:last-child \{ border-bottom: 0; border-bottom-left-radius: var\(--radius-lg\); border-bottom-right-radius: var\(--radius-lg\); \}/.test(css)
      && /\.wd-row:hover \{ background: var\(--surface-muted\); \}/.test(css) && /\.wd-row:hover \.wd-mt \{ color: var\(--ink-2\); \}/.test(css) && /\.wd-row:hover::after \{ color: var\(--ink\); \}/.test(css)
      && /\.wd-row:focus-visible \{ outline-offset: -2px; \}/.test(css) && /prefers-reduced-motion: reduce\) \{ \.wd-row, \.wd-row::after, \.st-row, \.wl-fold, \.wl-fold \.mp-chev, button\.onb-h \{ transition: none; \} \}/.test(css)
      && !/wd-go|"go"/.test(src));
    ok("② 完整目錄退役:welcome.js / welcome.css / index.html 沒有目錄的程式與樣式(wdCatalog、WD.all、WD_NT、.wd-cat* / .wd-foot / .wd-tag、放寬 1040、一列一塊的 860 斷點),兩語 .po 與字串表沒有目錄的字(wd.less / wd.h.* / wd.src.* / wd.foot.* / wd.mk.txfo);容器查詢只有兩條:兩欄清單 760、起手句窄版 480(卡片三欄 640 隨三張卡退役)",
      !/wdCatalog|WD\.all|\ball:\s*(true|false)|WD_NT|wd-cat|wd-foot|wd-tag|wd\.less|wd\.h\.|wd\.src\.|wd\.foot\.|txfo|<table|"table"/.test(src + css + html.slice(html.indexOf('id="wl"'), html.indexOf("</section>", html.indexOf('id="wl"'))))
      && !/1040px|859\.98|max-width: (?!479px\))\d+(\.\d+)?px\)/.test(css) && /@container \(min-width: 760px\) \{\s*\.wl-body\.cmp2/.test(css) && (css.match(/@container \([^)]*\)/g) || []).sort().join() === ["@container (min-width: 760px)", "@container (max-width: 479px)"].sort().join()
      && !/msgid "wd\.(less|h\.|src\.|foot\.|mk\.txfo)/.test(po) && !/msgid "wd\.r\.[a-z0-9]+\.(nt|sn|us|wnm)"/.test(po));
    // 「看全部資料」:wdDocs 原文 + app.js 的 docsUrl 原文在純 node 跑;外開與埋點換成記錄器
    { const dl = /^const docsUrl = \(page\) => "https:\/\/blave\.org\/docs\/" \+ LANG \+ "\/" \+ page;$/m.exec(appSrc);
      const docs = (L, mk) => { const log = { ext: [], tf: [], painted: 0 }, C = { LANG: L, WD: { mk }, trackFeature: (n) => log.tf.push(n), wdPaint: () => { log.painted++; }, window: { blave: { openExternal: (u) => { log.ext.push(u); } } } };
        vm.createContext(C); vm.runInContext((dl ? dl[0] : "") + "\n" + cutFn(src, "wdDocs") + "\nwdDocs();", C); return log; };
      const got = {}, badDocs = [];
      for (const L of ["zh", "en"]) { got[L] = {}; for (const mk of ["crypto", "tw", "txf"]) { const g = docs(L, mk); got[L][mk] = g.ext[0];
        if (g.ext.length !== 1 || g.ext[0] !== DOCS[L][mk] || g.tf.join() !== "welcome_data_all" || g.painted !== 0) badDocs.push(L + ":" + mk + " " + JSON.stringify(g)); } }
      ok("② 點「看全部資料」→ 用瀏覽器開網站的資料文件頁:加密 → /docs/<語言>/data_crypto、台股與台指期 → /docs/<語言>/data_twstock(三個市場 × zh / en 六個網址逐字比對),各外開恰好一次、記 welcome_data_all、不重畫清單",
        !!dl && badDocs.length === 0, badDocs.join("\n    ") || JSON.stringify(got));
      ok("② 接線:#wl-all 的 click 直接接 wdDocs(不切換任何模式、WD 沒有 all 這個狀態);網址的 base 與語言段同 legalUrl / acctUrl 那一套(app.js docsUrl,用 LANG);字是固定的 wd.all、wdPaint 不再改它",
        /\n\$\("wl-all"\)\.addEventListener\("click", wdDocs\);\n/.test(src) && (src.match(/\$\("wl-all"\)/g) || []).length === 1 && !/WD\.all|\ball:/.test(src.slice(src.indexOf("const WD = {"), src.indexOf("\n", src.indexOf("const WD = {"))))
        && !/blave\.org/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")) && /docsUrl\(WD\.mk === "crypto" \? "data_crypto" : "data_twstock"\)/.test(cutFn(src, "wdDocs")) && !/wdPaint|WD\.\w+\s*=[^=]/.test(cutFn(src, "wdDocs"))
        && STR.zh["wd.all"] === "看全部資料" && STR.en["wd.all"] === "See All Data");
      // 主行程那一關:open-external IPC 走 openWebSafe(webUrl:http(s)、不帶帳密),六個網址原樣放行
      const mainSrc = read(path.join(SHELL, "main.js")), M = {}; vm.createContext(M); vm.runInContext(cutFn(mainSrc, "webUrl") + "\nthis.webUrl = webUrl;", M); M.URL = URL;
      ok("② 主行程放行:open-external 的 handler 是 openWebSafe,六個網址過 webUrl 原樣回來(/docs/ 路徑不會被擋)", /handle\("open-external", \(_e, url\) => openWebSafe\(url\), false\);/.test(mainSrc)
        && ["zh", "en"].every((L) => ["crypto", "tw", "txf"].every((mk) => M.webUrl(DOCS[L][mk]) === DOCS[L][mk]))); }
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
        + src.slice(src.indexOf("const WD_P ="), src.indexOf("function wdNote(")).replace(/^const /gm, "var ") + "\n" + cutFn(src, "wdAsk") + "\n" + cutFn(src, "wdRow") + "\n" + cutFn(src, "wdFillText") + "\n" + cutFn(src, "wdFill"), C);
      return { C, ta, log, click: (id, build) => { const b = C.wdRow(id, build); b.onclick(); return b; } };
    };
    const bad = [], seen = {}; let built = 0;
    for (const L of ["zh", "en"]) for (const build of [false, true]) {
      const X = lab(L), S = STR[L], tk = build ? "wd.ask.build" : "wd.ask", tpl = S[tk], [pre, post] = tpl.split("{name}");
      for (const [id] of ROWS) {
        X.ta.value = ""; X.C.WD.filled = ""; X.C.WD.pre = "";
        const b = X.click(id, build), got = X.ta.value, an = S["wd.r." + id + ".an"] || "", why = [];
        const mt = S["wd.r." + id + ".fq"] + S["wd.sep"] + S["wd.r." + id + ".sy"], l1 = b.kids[0] || {}, k = l1.kids || [];
        if (b.tag !== "button" || b.kids.length !== 1 || l1.className !== "wd-l1" || k.length !== 2 || k[0].className !== "wd-nm" || k[1].className !== "wd-mt") why.push("列不是只有一行「名字 + 小字」");
        if (k[0] && k[0].textContent !== S["wd.r." + id + ".nm"]) why.push("列上顯示的名字不是 .nm");
        if (k[1] && k[1].textContent !== mt) why.push("小字不是 頻率・起始年");
        if (!an || nosp(got) !== nosp(String(tpl).replace("{name}", an))) why.push("不是模板代入 .an");
        if (!got.startsWith(pre) || !got.endsWith(post) || got.length <= tpl.length - 6) why.push("句子不完整");
        if (/[{}]|wd\.|undefined|null/.test(got)) why.push("佔位或 key 漏出來");
        if (/[()（）〈〉]/.test(got)) why.push("有括號");
        if (/\s\s|^\s|\s$|\n/.test(got)) why.push("多餘空白");
        if (L === "zh" && /[⺀-鿿][A-Za-z0-9]|[A-Za-z0-9][⺀-鿿]/.test(got)) why.push("中英之間少一格半形空白");
        if (L === "en" && /[^\x20-\x7e]/.test(got)) why.push("英文句子有非 ASCII 字");
        if (/\b(BTC|ETH|SOL|TSMC|Hon Hai)\b|台積電|鴻海|\d{4}/.test(an)) why.push(".an 帶了幣種 / 標的 / 年份");
        if (seen[L + got]) why.push("跟 " + seen[L + got] + " 同一句"); seen[L + got] = id;
        if (why.length) bad.push(L + ":" + tk + ":" + id + "「" + got + "」" + why.join("、"));
        built++;
      }
    }
    ok("② 歡迎頁 " + ROWS.length + " 列 × zh / en × 兩個模板(wd.ask / wd.ask.build):每一列點下去都是完整句子(模板代入 .an)、沒有括號與佔位、中英之間有空白、不帶幣種標的、各列不同句;列上顯示的是 .nm、小字是 頻率・起始年",
      ROWS.length > 0 && built === ROWS.length * 4 && bad.length === 0, bad.join("\n    "));
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

  // ── 起手句(0.1.26;spec-starters §1.4 / §2 / §4.1 / §5.1)──
  { const a = src.indexOf("/* ── 純邏輯("), b = src.indexOf("/* ── 純邏輯到此"), Q = {}; vm.createContext(Q); vm.runInContext(src.slice(a, b), Q);
    // §2.2 那張表逐列列舉:true = 只填不送
    const TABLE = [
      [{ engine: "claude", signedIn: false, canRun: false }, false], [{ engine: "codex", signedIn: true, canRun: false }, false], [{ engine: "apikey", signedIn: true, canRun: null }, false],
      [{ engine: "blave", signedIn: true, canRun: null }, false], [{ engine: "blave", signedIn: true, canRun: true }, false], [{ engine: "blave", signedIn: true, canRun: false }, true],
      [{ engine: "blave", signedIn: false, canRun: false }, false], [{ engine: "blave", signedIn: false, canRun: null }, false], [{ engine: null, signedIn: true, canRun: true }, true], [{ engine: undefined, signedIn: false, canRun: null }, true]];
    const badT = TABLE.filter(([c, want]) => Q.stFill(c) !== want).map(([c]) => JSON.stringify(c));
    ok("② stFill(§2.2 表逐列):自接 Claude／Codex／API 金鑰一律送;Blave AI 已登入且確定不能跑才只填;查不到當能跑;沒登入照送(交給登入卡);還沒連 AI 只填", badT.length === 0, badT.join(" "));
    const WANT = {
      zh: { crypto: ["BTC 日線：收盤站上 200 日均線買進，跌破賣出", "BTC 日線：收盤站上 200 日均線買進，跌破賣出。幫我建成策略，回測 2020 年至今。"],
        tw: ["台積電、聯發科、鴻海、台達電、富邦金五檔等權持有，每月再平衡", "台積電（2330）、聯發科（2454）、鴻海（2317）、台達電（2308）、富邦金（2881）五檔等權持有，每月再平衡。幫我建成策略，回測 2022 年至今。"],
        txf: ["台指期日線：收盤突破 20 日高點做多，跌破 10 日低點平倉", "台指期日線：收盤突破 20 日高點做多，跌破 10 日低點平倉。幫我建成策略，回測 2015 年至今。"] },
      en: { crypto: ["BTC daily: buy on a close above the 200\u2011day MA, sell on a close below", "BTC daily: buy on a close above the 200-day MA, sell on a close below. Build it as a strategy and backtest from 2020."],
        tw: ["Hold TSMC, MediaTek, Hon Hai, Delta Electronics and Fubon Financial in equal weights, rebalanced monthly", "Hold TSMC (2330), MediaTek (2454), Hon Hai (2317), Delta Electronics (2308) and Fubon Financial (2881) in equal weights, rebalanced monthly. Build it as a strategy and backtest from 2022."],
        txf: ["TAIEX futures daily: go long on a close above the 20\u2011day high, exit on a close below the 10\u2011day low", "TAIEX futures daily: go long on a close above the 20-day high, exit on a close below the 10-day low. Build it as a strategy and backtest from 2015."] } };
    const badS = [];
    for (const L of ["zh", "en"]) for (const mk of ["crypto", "tw", "txf"]) {
      const row = STR[L]["starter_" + mk + "_row"], send = STR[L]["starter_" + mk + "_send"];
      if (row !== WANT[L][mk][0] || send !== WANT[L][mk][1]) badS.push(L + ":" + mk + " 不是定稿");
      if (/%|0050|大盤|報酬|return|benchmark|outperform|beat/i.test(row + send)) badS.push(L + ":" + mk + " 寫了報酬或比較");
      if (/\(\d{4}\)|（\d{4}）/.test(row)) badS.push(L + ":" + mk + " 列上帶了代號");
    }
    ok("② en 列上的「N‑day」用不斷行連字號 U+2011(spec §10;1440 寬時不會斷成「10-」/「day」),送出那句維持一般連字號;歡迎頁卡片退役,卡片專用的字(wc.annLabel、workspace_wel_or / _more、workspace_lib_bt_span / _detail)一起刪,策略庫面板的 lib.annLabel 不動",
      ["crypto", "txf"].every((mk) => /\d\u2011day/.test(STR.en["starter_" + mk + "_row"]) && !/\d-day/.test(STR.en["starter_" + mk + "_row"]) && /\d-day/.test(STR.en["starter_" + mk + "_send"]) && !/\u2011/.test(STR.en["starter_" + mk + "_send"]))
      && ["wc.annLabel", "workspace_wel_or", "workspace_wel_more", "workspace_lib_bt_span", "workspace_lib_detail"].every((k) => !(k in STR.zh) && !(k in STR.en)) && STR.en["lib.annLabel"] === "Annualized · backtest" && STR.zh["lib.annLabel"] === "年化・回測" && !/wcCard|wcCurve|wcDetail|wcLoad/.test(src));
    ok("② 起手句六句 × 兩語逐字是 spec §5.1 定稿;沒有報酬率、%、0050、大盤或任何比較字;台股只在送出那句帶代號;起始年 {y} 起 / From {y}", badS.length === 0
      && STR.zh["starter_since"] === "{y} 起" && STR.en["starter_since"] === "From {y}", badS.join("、"));
    ok("② 三列的順序固定 加密｜台股｜台指期、年份同送出句;tag 用既有的 wd.mk.*(en 台股改 TW Stocks);輸入框提示改成講想法的短句(spec §9:聊天欄最窄 336 也放得下)",
      /const ST_ROWS = \[\["crypto", 2020\], \["tw", 2022\], \["txf", 2015\]\];/.test(src) && STR.en["wd.mk.tw"] === "TW Stocks" && STR.zh["wd.mk.tw"] === "台股"
      && STR.zh["ws.placeholder"] === "說一個交易想法…" && STR.en["ws.placeholder"] === "Describe a trading idea…");
    ok("② 起手句的列:button.st-row[data-starter]、送出 icon(SEND_ROW_IC)aria-hidden、tag + 句子 + 起始年;送出照 suggest 的寫法(submitMessage 回 true 才記 starter_<mk> 與 pending);回合中是鎖(aria-disabled,點了在輸入框上方講原因;busy-lock spec)",
      /wdEl\("button", "st-row"\); b\.type = "button"; b\.dataset\.starter = mk; busyLock\(b, runningNow\(\)\);/.test(cutFn(src, "stPaint")) && /if \(runningNow\(\)\) \{ busySendTell\(\); return; \}/.test(cutFn(src, "stGo")) && /g\.setAttribute\("aria-hidden", "true"\); g\.innerHTML = SEND_ROW_IC;/.test(cutFn(src, "stPaint"))
      && /submitMessage\(text\)\.then\(\(ok\) => \{ if \(ok\) \{ trackFeature\(ST_FEATURE\[mk\]\); ST\.pending = \{ before \}; \} \}\);/.test(cutFn(src, "stGo")) && /busyLock\(b, runningNow\(\)\)/.test(cutFn(src, "stSync")));
    // stTurnEnd:原文接假的 RP / trackFeature 跑
    const turn = (before, after, pending) => { const tf = [], C = { RP: { list: after.map((name) => ({ name })) }, trackFeature: (n) => tf.push(n), ST: { pending: pending ? { before: new Set(before) } : null } };
      vm.createContext(C); vm.runInContext(cutFn(src, "stTurnEnd") + "\nstTurnEnd(); stTurnEnd();", C); return tf.join(); };
    ok("② stTurnEnd:起手句那一輪結束、清單多了一支 → starter_new;沒多(含停止、出錯、只是改名以外的動)→ starter_no_new;只算一次;沒送過起手句不記",
      turn(["a"], ["a", "b"], true) === "starter_new" && turn(["a"], ["a"], true) === "starter_no_new" && turn([], [], true) === "starter_no_new" && turn(["a", "b"], ["a"], true) === "starter_no_new" && turn([], ["x"], false) === "");
    ok("② app.js 接線:stratRefresh 畫完清單設 RP.loaded 再叫 wcSync(不閃:#wc / #wf 在那之前一直 hidden,由 onbPaint 決定出哪一個);送出／unlock／回合結束三排都叫 stSync;回合結束在 libTurnEnd 那條 then 裡、排在最前面叫 stTurnEnd(清單重讀完才比;後面任一支拋例外 pending 也不會漏到下一輪,稽核 B3);enterWorkspace 叫 wcArm(3 秒保底從進工作頁起算,稽核 B1)",
      /RP\.loaded = true; if \(typeof wcSync === "function"\) wcSync\(\);/.test(cutFn(appSrc, "stratRefresh")) && (appSrc.match(/if \(typeof nsSync === "function"\) nsSync\(\); if \(typeof stSync === "function"\) stSync\(\);/g) || []).length === 3
      && /stratRefresh\(true\)\.catch\(\(\) => \{\}\)\.then\(\(\) => \{ if \(typeof stTurnEnd === "function"\) stTurnEnd\(\); if \(typeof libTurnEnd === "function"\) libTurnEnd\(\);/.test(appSrc)
      && /stratRefresh\(false\);\n\s*if \(typeof wcArm === "function"\) wcArm\(\);/.test(cutFn(appSrc, "enterWorkspace")) && !/\nsetTimeout\(/.test(src) && /WC\.armed = true; setTimeout\(\(\) => \{ if \(!WC\.shown\) wcSync\(\); \}, 3000\);/.test(cutFn(src, "wcArm"))
      && /function wcSync\(\) \{\n  if \(!WC\.shown\) WC\.shown = true;\n  onbPaint\(\);\n\}/.test(src));
    // 新策略開新對話(Wei):這條對話講過話(csTitle)就先 csStartNew,送出與只填不送兩條都一樣;聊天欄收著先展開;只填不送時補回預檢卡
    { const run = (title, fill) => { const log = [], C = { csTitle: title, sessionId: "old", RP: { list: [] }, WD: {}, ST: {}, ST_FEATURE: { crypto: "starter_crypto" }, hasToken: true, cur: "blave", acct: { can_run: !fill },
          paneSt: { chat: { off: true } }, paneToggle: () => log.push("pane"), runningNow: () => false, wdPaint: () => {}, t: (k) => k, stFill: (c) => c.canRun === false,
          csStartNew: () => { log.push("new"); C.sessionId = "new"; C.csTitle = ""; }, wdFillText: (x) => log.push("fill:" + C.sessionId), trackFeature: () => {}, acctPrecheck: () => log.push("precheck"),
          submitMessage: (x) => { log.push("send:" + C.sessionId); return Promise.resolve(false); } };
        vm.createContext(C); vm.runInContext(cutFn(src, "stGo"), C); C.stGo("crypto"); return { log: log.join(), sid: C.sessionId }; };
      const a = run("舊對話", false), b = run("", false), c = run("舊對話", true), d = run("", true);
      ok("起手句:有舊對話時先開新對話再送(sessionId 換掉);新對話不重開;只填不送也先開新對話再填、補回預檢卡;聊天欄收著先展開",
        a.sid === "new" && a.log === "pane,new,send:new" && b.sid === "old" && b.log === "pane,send:old" && c.log === "pane,new,fill:new,precheck" && d.log === "pane,fill:old", JSON.stringify([a, b, c, d])); }
    const F = require(path.join(SHELL, "telemetry.js")).EVENTS.feature_used.name, i = F.indexOf("lib_mkt_pick");
    ok("② telemetry 白名單:七個起手句名字接在 lib_mkt_pick 後面、順序同 spec §4.1、≤16 字(總數由 check_shell_telemetry 鎖;之後的版本可以再接在後面);welcome.js 送的 feature 名字都在白名單裡",
      F.slice(i + 1, i + 8).join() === "starter_crypto,starter_tw,starter_txf,starter_fill,starter_new,starter_no_new,wd_fold_open" && F.length >= 158 && F.slice(i + 1).every((n) => n.length <= 16)
      && [...src.matchAll(/trackFeature\("([a-z_]+)"\)/g)].map((m) => m[1]).every((n) => F.includes(n)) && ["crypto", "tw", "txf"].every((mk) => F.includes("starter_" + mk))); }
  // ── ③ Electron ──
  const bin = GATE.bin(SHELL, "③");
  if (!bin) { console.log(red ? `\n${red} FAILED` : "\nALL PASS"); process.exit(red ? 1 : 0); }
  const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit", env: { ...process.env, ELECTRON_ENABLE_LOGGING: "" } });
  process.exit(red || r.status ? 1 : 0);
}

const { app, BrowserWindow } = require("electron");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "blave-wd-")));
const STUB = `window.__tf = []; window.__ext = []; window.blave = new Proxy({}, { get: (_, k) => typeof k !== "string" ? undefined
  : k.startsWith("on") ? () => {} : k === "tradeLabels" ? () => {} : k === "trackFeature" ? (n) => window.__tf.push(n)
  : k === "openExternal" ? (u) => { window.__ext.push(u); return Promise.resolve(true); }
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
  // 畫面的量測:版本、欄數、每欄的小標與列數、幾何、右欄有沒有被鎖、狀態句、外開過的網址
  const snap = () => js(`(() => { const body = $("wl-body"), cols = [...body.querySelectorAll(":scope > .wl-col")];
    // 欄的範圍 = 它子項的聯集:兩欄並排時 .wl-col 是 display: contents,自己沒有盒子(getBoundingClientRect 全 0,並排的斷言會假綠)
    const rc = (c) => { const k = [...c.children].map((e) => e.getBoundingClientRect()); return { left: Math.min(...k.map((r) => r.left)), right: Math.max(...k.map((r) => r.right)), top: Math.min(...k.map((r) => r.top)), bottom: Math.max(...k.map((r) => r.bottom)) }; };
    return { visible: !$("main-empty").hidden && !$("wc").hidden && !$("wl").hidden, cmp2: body.classList.contains("cmp2"), cols: cols.map((c) => ({ cap: (c.querySelector(".wl-cap") || {}).textContent || "", note: (c.querySelector(".wl-note") || {}).textContent || "",
        rows: c.querySelectorAll(".wd-row").length, locked: c.querySelectorAll(".wd-row[disabled], .wd-row[aria-disabled], .wd-row.is-locked").length,
        dim: [...c.querySelectorAll(".wd-row")].some((b) => parseFloat(getComputedStyle(b).opacity) < 1), r: rc(c) })),
      state: $("wl-state").textContent, stateBtn: !!$("wl-state").querySelector("button"), seg: !$("wl-seg").hidden, all: $("wl-all").textContent, text: $("wl").textContent,
      html: $("wl").innerHTML, old: $("wl").querySelectorAll("table, .wd-catw, .wd-cat, .wd-foot, .wd-tag").length, ext: window.__ext.slice(),
      ta: $("ta").value, msgs: $("chat-scroll").querySelectorAll(".msg").length, running, tf: window.__tf.slice() }; })()`);
  const paint = (code) => js(`(() => { ${code}; WD.key = ""; wdPaint(); return true; })()`);
  const Z = STR.zh, DAY = 86400000;
  const askB = (L, id) => String(STR[L]["wd.ask.build"]).replace("{name}", STR[L]["wd.r." + id + ".an"]);
  // 起手句版:整頁等第一次清單讀完才出現(stub 的 listStrategies 回空陣列);三列起手句;資料摺疊預設收起,點了才展開並記 wd_fold_open
  { const f0 = await js(`({ wc: $("wc").hidden, wl: $("wl").hidden, exp: $("wl-fold").getAttribute("aria-expanded"), loaded: RP.loaded === true, rows: [...$("st-rows").querySelectorAll(".st-row")].map((b) => b.dataset.starter).join(), tf: window.__tf.slice() })`);
    await js(`$("wl-fold").click(); true`); await wait(50);
    await wait(300); const f1 = await js(`({ wl: $("wl").hidden, exp: $("wl-fold").getAttribute("aria-expanded"), tf: window.__tf.slice(), rot: getComputedStyle($("wl-fold").querySelector(".mp-chev")).transform, mid: (() => { const t = $("wl-fold").querySelector("span").getBoundingClientRect(), c = $("wl-fold").querySelector(".mp-chev").getBoundingClientRect(); return Math.abs((t.top + t.bottom) / 2 - (c.top + c.bottom) / 2); })() })`);
    ok("③ 開 app:清單讀完才顯示 #wc(RP.loaded)、三列起手句 crypto / tw / txf;#wl 收起、aria-expanded=false;點摺疊 → 展開、aria-expanded=true、箭頭翻上、箭頭跟字垂直置中(差 ≤ 2px;盒子轉 45° 後的外框量)、記 wd_fold_open 一次",
      !f0.wc && f0.loaded && f0.rows === "crypto,tw,txf" && f0.wl && f0.exp === "false" && !f0.tf.includes("wd_fold_open") && !f1.wl && f1.exp === "true" && f1.rot !== "none" && f1.mid <= 2 && f1.tf.filter((n) => n === "wd_fold_open").length === 1, JSON.stringify([f0, f1])); }

  // 沒登入:對比版
  await paint(`hasToken = false; acct = null; pub = null; WD.mk = "crypto"`);
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
  ok("③ 點免費欄第一列 → 建策略那句(wd.ask.build × wd.r.bnk.an)落進輸入框、沒有送出(沒有泡泡、沒在跑)、記 welcome_data_row", nosp(s.ta) === nosp(askB("zh", "bnk")) && !/[{}()（）]|wd\./.test(s.ta) && s.msgs === 0 && s.running === false && s.tf.includes("welcome_data_row"), JSON.stringify([s.ta, s.msgs, s.tf]));
  await js(`$("wl-body").querySelectorAll(".wl-col")[1].querySelector(".wd-row").click()`); await wait(50); s = await snap();
  ok("③ 再點另一列 → 上一句直接換掉(不疊成兩句)", nosp(s.ta) === nosp(askOf("zh", "ti")) && !s.ta.includes("\n"), s.ta);
  await js(`$("ta").value = "my own draft"; $("wl-body").querySelector(".wl-col .wd-row").click()`); await wait(50); s = await snap();
  ok("③ 自己打到一半的字留著,那一句接在後面另起一行", s.ta.startsWith("my own draft\n") && nosp(s.ta.slice(13)) === nosp(askB("zh", "bnk")), s.ta);
  await js(`$("wl-body").querySelectorAll(".wl-col")[1].querySelector(".wd-row").click()`); await wait(50); s = await snap();
  ok("③ 接著再點另一列 → 只換那一句,自己打的字還在(稽核 P1)", s.ta.startsWith("my own draft\n") && nosp(s.ta.slice(13)) === nosp(askOf("zh", "ti")), s.ta);
  await js(`$("ta").value += " edited"; $("wl-body").querySelector(".wl-col .wd-row").click()`); await wait(50); s = await snap();
  ok("③ 點完自己又改了字再點一列 → 改過的整段留著,新的一句接在後面", s.ta.startsWith("my own draft\n") && s.ta.includes(" edited\n") && nosp(s.ta.split("\n").pop()) === nosp(askB("zh", "bnk")) && s.ta.split("\n").length === 3, s.ta);
  await js(`$("ta").value = ""; WD.filled = ""; WD.pre = ""`);
  // 一列一行:幾何與熱區實測(canon › Verification:熱區用 elementFromPoint 量,不用 CSS 推)
  const geo = () => js(`[...$("wl-body").querySelectorAll(".wd-row")].map((b) => { b.scrollIntoView({ block: "center" });
    const r = b.getBoundingClientRect(), n = b.querySelector(".wd-nm").getBoundingClientRect(), m = b.querySelector(".wd-mt").getBoundingClientRect(), x = r.left + r.width / 2;
    let hit = 0; for (let y = Math.floor(r.top) - 2; y <= Math.ceil(r.bottom) + 2; y++) { const e = document.elementFromPoint(x, y); if (e && (e === b || b.contains(e))) hit++; }   // 整數 y:elementFromPoint 的命中測試以整 px 為單位,列的起點常落在 .5
    return { id: b.dataset.id, kids: b.children.length, l1: b.firstElementChild.className + ":" + b.firstElementChild.children.length, h: r.height, hit, one: m.top < n.bottom - 2, mid: Math.abs((n.top + n.bottom) / 2 - (r.top + r.bottom) / 2),
      nmLeft: n.left - r.left, gap: m.left - n.right, mtLeft: m.left - r.left, mtRight: m.right, col: [...$("wl-body").querySelectorAll(".wl-col")].indexOf(b.closest(".wl-col")), over: b.scrollWidth - b.clientWidth, mt: b.querySelector(".wd-mt").textContent }; })`);
  let g = await geo();
  // 成欄:同一欄裡單行的列,小字右緣同一條 x(行尾 › 的左邊);名字與小字之間至少隔 12
  const colRight = (g) => [0, 1].every((c) => { const v = g.filter((x) => x.col === c && x.one).map((x) => x.mtRight); return v.length > 0 && Math.max(...v) - Math.min(...v) < 0.6; });
  ok("③ 每一列只有 .wd-l1 一行(名字 + 小字)、小字 = 頻率・起始年;列高與實測熱區都 ≥ 44;放得下的列是單行:高剛好 44、字垂直置中、名字內距 16、小字靠右——同一欄的小字右緣貼齊成欄(不跟在名字後面)",
    g.length === 6 && g.every((x) => x.kids === 1 && x.l1 === "wd-l1:2" && x.h >= 43.99 && x.hit >= 44 && x.over <= 0 && Math.abs(x.nmLeft - 16) < 0.6 && x.mt === Z["wd.r." + x.id + ".fq"] + Z["wd.sep"] + Z["wd.r." + x.id + ".sy"])
    && g.filter((x) => x.one).length >= 5 && g.filter((x) => x.one).every((x) => Math.abs(x.h - 44) < 0.01 && x.mid <= 1.5 && x.gap >= 11.4) && colRight(g) && g.some((x) => x.one && x.gap > 40)
    && (await js(`!$("wl-body").querySelector(".wd-l2, .wd-gl, .wd-tx")`)), JSON.stringify(g));
  await js(`$("wl-body").style.width = "200px"`); await wait(50); g = await geo();
  ok("③ 欄很窄(200):小字整段折到名字下面、靠左(跟名字同一條左緣)、列跟著長高、不橫向溢出", g.every((x) => !x.one && Math.abs(x.mtLeft - 16) < 0.6 && x.h > 44 && x.hit >= 44 && x.over <= 0), JSON.stringify(g));
  await js(`$("wl-body").style.width = ""`); await wait(50);
  // A2:清單是一張卡。token 的實際值從一顆探針讀(不寫死色碼);每欄的列:底色、四個角、列間線、行尾 ›、列與列緊貼
  const card = () => js(`(() => { const pr = document.createElement("i"); pr.style.cssText = "position:absolute;background:var(--surface-card);color:var(--ink-2);border-radius:var(--radius-lg)"; document.body.appendChild(pr);
    const ps = getComputedStyle(pr), tok = { bg: ps.backgroundColor, ink2: ps.color, lg: ps.borderTopLeftRadius }; pr.remove();
    const tx = (e) => { const r = document.createRange(); r.selectNodeContents(e); return r.getBoundingClientRect(); }, q = (s) => document.querySelector(s), foot = q(".wl-foot").getBoundingClientRect(), st = $("wl-state"), all = tx($("wl-all"));
    return { tok, cols: [...$("wl-body").querySelectorAll(".wl-col")].map((c) => [...c.querySelectorAll(".wd-row")].map((b) => { const s = getComputedStyle(b), r = b.getBoundingClientRect();
        return { bg: s.backgroundColor, rad: [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius].join(" "), bb: s.borderBottomWidth, go: getComputedStyle(b, "::after").content, kids: b.children.length, l: r.left, r: r.right, t: r.top, b: r.bottom }; })),
      axis: { chip: q("#onb-b1 .wc-chip:not([hidden])").getBoundingClientRect().left, st: tx(q(".st-row .g")).left, ns: $("chat-ns").getBoundingClientRect().left, colh: q(".wl-colh .wl-cap") ? tx(q(".wl-colh .wl-cap")).left : null, card: q(".wd-row").getBoundingClientRect().left, all: all.left },
      order: [q(".onb-mq").getBoundingClientRect().bottom, q("#st-rows").getBoundingClientRect().top, q("#st-rows").getBoundingClientRect().bottom, q("#onb-b2 .onb-opts").getBoundingClientRect().top, q("#onb-b2 .onb-opts").getBoundingClientRect().bottom, q(".wl").getBoundingClientRect().top],
      head: { toOpts: q("#onb-b2 .onb-opts").getBoundingClientRect().top - q("#st-rows").getBoundingClientRect().bottom, indent: tx(q(".st-row .g")).left - q(".wc-mark").getBoundingClientRect().left },
      stIn: st.parentElement === q(".wl-foot") && st.previousElementSibling === $("wl-all"), stMid: st.textContent ? (tx(st).top + tx(st).bottom) / 2 - (all.top + all.bottom) / 2 : null, stRight: st.textContent ? foot.right - tx(st).right : null, footRight: foot.right - Math.max(...[...document.querySelectorAll(".wd-row")].map((b) => b.getBoundingClientRect().right)),
      over: $("main-empty").scrollWidth - $("main-empty").clientWidth }; })()`);
  const cardOk = (k) => k.tok.lg !== "0px" && !/rgba\(0, 0, 0, 0\)|transparent/.test(k.tok.bg) && k.cols.every((rows) => rows.length > 0 && rows.every((x, i) => { const first = i === 0, last = i === rows.length - 1, lg = k.tok.lg, z = "0px";
    return x.bg === k.tok.bg && x.rad === [first ? lg : z, first ? lg : z, last ? lg : z, last ? lg : z].join(" ") && x.bb === (last ? "0px" : "1px") && /›/.test(x.go) && /\/ ""$/.test(x.go) && x.kids === 1 && (first || Math.abs(x.t - rows[i - 1].b) < 0.6); }));
  const axisOk = (k) => { const v = Object.values(k.axis).filter((x) => x !== null); return Math.max(...v) - Math.min(...v) <= 0.6; };
  let k = await card();
  ok("③ A2 兩欄:兩欄各自是一張完整的卡(列 = --surface-card;各欄第一列上兩角、最後一列下兩角 = --radius-lg,中間的列直角;列間 1px 線、最後一列沒有;列緊貼;行尾 › 是 ::after、列裡沒有多的節點),兩張卡之間有欄距 16、等寬",
    k.cols.length === 2 && cardOk(k) && Math.abs(k.cols[1][0].l - k.cols[0][0].r - 16) < 0.6 && Math.abs((k.cols[0][0].r - k.cols[0][0].l) - (k.cols[1][0].r - k.cols[1][0].l)) < 0.6 && k.over <= 0, JSON.stringify(k));
  ok("③ 步驟內容同一條左軸:①的第一顆籤、起手句的送出 icon、新增策略、欄小標、卡、「看全部資料」的左緣同一條 x,比記號內縮 32;由上到下 市場題 → 起手句 →(隔 8)新增策略那一列 → 清單",
    axisOk(k) && k.order.every((y, i) => i === 0 || y >= k.order[i - 1] - 0.5) && Math.abs(k.head.toOpts - 8) < 0.6 && Math.abs(k.head.indent - 32) < 0.6, JSON.stringify([k.axis, k.order, k.head]));
  { // 起手句的列(§1.4):tag 欄三列等寬(subgrid)、句子不溢出、送出 icon 不進讀屏名字;只填不送 / 回合中 disabled
    const geoSt = () => js(`[...$("st-rows").querySelectorAll(".st-row")].map((b) => { const tg = b.querySelector(".tag"), tx = b.querySelector(".txt"), sn = b.querySelector(".since"), r = (e) => e.getBoundingClientRect();
      return { mk: b.dataset.starter, tagW: r(tg).width, tagL: r(tg).left, tagOn: getComputedStyle(tg).display !== "none", txtL: r(tx).left, txtT: r(tx).top, sinceT: r(sn).top, sinceL: r(sn).left, over: tx.scrollWidth - tx.clientWidth, rowOver: b.scrollWidth - b.clientWidth, h: r(b).height, txt: tx.textContent, since: sn.textContent }; })`);
    const g1 = await geoSt();
    ok("③ 起手句 1600 寬:tag 靠左(不撐滿欄;spec §9)、三列 tag 左緣同一條 x、句子左緣同一條 x(tag 欄照最長的那個等寬)、起始年在同一行、句子不溢出、列高 ≥ 36;字是定稿列上那句與「{y} 起」",
      g1.length === 3 && g1.every((x) => x.tagOn && Math.abs(x.tagL - g1[0].tagL) < 0.6 && Math.abs(x.txtL - g1[0].txtL) < 0.6 && Math.abs(x.sinceT - x.txtT) < 4 && x.over <= 0 && x.rowOver <= 0 && x.h >= 36)
      && Math.min(...g1.map((x) => x.tagW)) < Math.max(...g1.map((x) => x.tagW)) - 4   /* 加密 / 台股 比 台指期 窄:沒被撐滿欄 */
      && g1.map((x) => x.txt).join("|") === ["crypto", "tw", "txf"].map((mk) => Z["starter_" + mk + "_row"]).join("|") && g1.map((x) => x.since).join() === "2020 起,2022 起,2015 起", JSON.stringify(g1));
    { const pt = await js(`(() => { const b = $("st-rows").querySelector(".st-row"); b.scrollIntoView({ block: "center" }); const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
      const look = () => js(`(() => { const b = $("st-rows").querySelector(".st-row"), pr = document.createElement("i"); pr.style.cssText = "position:absolute;background:var(--surface-card)"; document.body.appendChild(pr); const card = getComputedStyle(pr).backgroundColor; pr.remove();
        return { on: b.matches(":hover"), bg: getComputedStyle(b).backgroundColor, tag: getComputedStyle(b.querySelector(".tag")).backgroundColor, card, name: b.textContent }; })()`);
      w.webContents.sendInputEvent({ type: "mouseMove", x: pt.x, y: pt.y }); await wait(400); const h = await look(); w.webContents.sendInputEvent({ type: "mouseMove", x: 2, y: 2 }); await wait(300);
      ok("③ 起手句 hover:底色 = --surface-card(spec §10-1),跟市場 tag 不同色、tag 看得到;按鈕名字裡 tag、句子、起始年之間有空白(讀屏不黏在一起)、名字前面沒有 icon 的字",
        h.on && h.bg === h.card && h.bg !== h.tag && h.name === Z["wd.mk.crypto"] + " " + Z["starter_crypto_row"] + " " + Z["starter_since"].replace("{y}", "2020"), JSON.stringify(h)); }
    const fill = await js(`(() => { window.__tf.length = 0; cur = "blave"; hasToken = true; acct = { can_run: false, reason: "NO_CARD" }; $("ta").value = "my idea"; WD.filled = ""; WD.pre = "";
      $("st-rows").querySelector('[data-starter="txf"]').click(); const r = { ta: $("ta").value, tf: window.__tf.slice(), msgs: $("chat-scroll").querySelectorAll(".msg").length, running, seg: $("wl-seg").querySelector('[aria-pressed="true"]').dataset.mk };
      $("st-rows").querySelector('[data-starter="crypto"]').click(); r.ta2 = $("ta").value; r.tf2 = window.__tf.slice(); return r; })()`);
    ok("③ Blave AI 已登入但不能跑 → 點起手句只填不送:自己的字留著、整句送出版接在下一行、沒有泡泡;連點兩列只換那一句;只記 starter_fill(不記 welcome_data_row);資料分段跟著換到最後點的市場",
      fill.ta === "my idea\n" + Z["starter_txf_send"] && fill.ta2 === "my idea\n" + Z["starter_crypto_send"] && fill.tf.join() === "starter_fill" && fill.tf2.join() === "starter_fill,starter_fill" && fill.msgs === 0 && fill.running === false && fill.seg === "txf", JSON.stringify(fill));
    const dis = await js(`(() => { running = true; stSync(); const b = [...$("st-rows").querySelectorAll(".st-row")]; const r = { dis: b.every((x) => x.getAttribute("aria-disabled") === "true" && !x.disabled), cur: getComputedStyle(b[0]).cursor, op: getComputedStyle(b[0]).opacity };
      const n0 = $("chat-scroll").querySelectorAll(".msg").length; b[0].click(); r.told = $("ta-wait").textContent === t("turn.busy") && $("chat-scroll").querySelectorAll(".msg").length === n0;
      running = false; stSync(); r.back = b.every((x) => !x.hasAttribute("aria-disabled")); taWaitShow(false); cur = "claude"; hasToken = false; acct = null; $("ta").value = ""; WD.filled = ""; WD.pre = ""; WD.mk = "crypto"; WD.key = ""; wdPaint(); return r; })()`);
    ok("③ 回合進行中三列是鎖(aria-disabled、cursor not-allowed、不用 opacity);點了不送、輸入框上方講原因;回合結束解除", dis.dis && dis.cur === "not-allowed" && dis.op === "1" && dis.told && dis.back, JSON.stringify(dis)); }
  { // hover:底換 --surface-muted、小字從 --ink-3 換 --ink-2(ink-3 壓在 hover 底上不到 4.5:1)、› 換色
    const tgt = `$("wl-body").querySelectorAll(".wl-col")[1].querySelector(".wd-row")`, look = () => js(`(() => { const b = ${tgt}; return { on: b.matches(":hover"), mt: getComputedStyle(b.querySelector(".wd-mt")).color, bg: getComputedStyle(b).backgroundColor, go: getComputedStyle(b, "::after").color }; })()`);
    const pt = await js(`(() => { const b = ${tgt}; b.scrollIntoView({ block: "center" }); const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    const h0 = await look(); w.webContents.sendInputEvent({ type: "mouseMove", x: pt.x, y: pt.y }); await wait(400); const h1 = await look();
    w.webContents.sendInputEvent({ type: "mouseMove", x: 2, y: 2 }); await wait(400); const h2 = await look();
    ok("③ A2 hover:滑到列上 → 底色換掉、小字換成 --ink-2、› 換色;移開全部回來", !h0.on && h1.on && !h2.on && h0.bg === k.tok.bg && h1.bg !== h0.bg && h0.mt !== k.tok.ink2 && h1.mt === k.tok.ink2 && h1.go !== h0.go && JSON.stringify(h2) === JSON.stringify(h0), JSON.stringify([h0, h1, h2, k.tok])); }
  { const sh = await js(`[...$("wl-seg").querySelectorAll("button")].map((b) => { b.scrollIntoView({ block: "center" }); const r = b.getBoundingClientRect(), x = r.left + r.width / 2, cy = (r.top + r.bottom) / 2; let hit = 0;
      for (let y = Math.floor(cy) - 30; y <= Math.ceil(cy) + 30; y++) { if (document.elementFromPoint(x, y) === b) hit++; } return { h: r.height, hit }; })`);
    ok("③ 市場分段三格的熱區實測 ≥ 44(視覺 30 高、::before 上下外擴,沒有被容器裁掉)", sh.length === 3 && sh.every((x) => x.h === 30 && x.hit >= 44), JSON.stringify(sh)); }
  // 窄:上下疊、免費在上
  w.setSize(1000, 900); await wait(400); s = await snap();
  ok("③ 1000 寬(中欄 < 760):上下疊、免費欄在上", s.cols[1].r.top >= s.cols[0].r.bottom - 1 && s.cmp2 && s.cols.length === 2 && s.cols[0].cap === Z["wd.col.free"], JSON.stringify([s.cols[0].r, s.cols[1].r]));
  { const nw = await js(`({ w: $("main-empty").clientWidth, rows: [...$("st-rows").querySelectorAll(".st-row")].map((b) => { const tx = b.querySelector(".txt"), sn = b.querySelector(".since"); return { tag: getComputedStyle(b.querySelector(".tag")).display, below: sn.getBoundingClientRect().top >= tx.getBoundingClientRect().bottom - 1, left: Math.abs(sn.getBoundingClientRect().left - tx.getBoundingClientRect().left), over: b.scrollWidth - b.clientWidth }; }) })`);
    ok("③ 1000 寬(中欄 < 480):起手句的 tag 欄藏起來、起始年折到句子下一行且跟句子同左緣、不溢出", nw.w - 48 < 480 && nw.rows.length === 3 && nw.rows.every((x) => x.tag === "none" && x.below && x.left < 0.6 && x.over <= 0), JSON.stringify(nw)); }
  w.setSize(1600, 900); await wait(400);
  // 台指期:免費欄是日線那一列(期交所),分線在 Blave 欄
  await js(`$("wl-seg").querySelector('[data-mk="txf"]').click()`); await wait(50); s = await snap();
  ok("③ 切到台指期:免費欄 1 列(台指期日線、小字「日・1998 年起」)、Blave 欄 4 列(第一列是分線)", s.cols[0].rows === 1 && s.cols[1].rows === 4
    && (await js(`(() => { const c = $("wl-body").querySelectorAll(".wl-col"), a = c[0].querySelector(".wd-row"), b = c[1].querySelector(".wd-row"); return a.dataset.id === "txd" && b.dataset.id === "txk" && a.querySelector(".wd-nm").textContent === t("wd.r.txd.nm") && b.querySelector(".wd-nm").textContent === t("wd.r.txk.nm") && a.querySelector(".wd-mt").textContent === t("wd.r.txd.fq") + t("wd.sep") + t("wd.r.txd.sy"); })()`)), JSON.stringify(s.cols.map((c) => c.rows)));
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
  k = await card(); g = await geo();
  ok("③ A2 單一清單:一張完整的卡(沒有欄頭,第一列 = :first-child 收上兩角、最後一列收下兩角)、左軸同一條、六列小字右緣成欄", k.cols.length === 1 && k.cols[0].length === 6 && cardOk(k) && axisOk(k) && k.axis.colh === null && k.over <= 0
    && g.every((x) => x.one && Math.abs(x.nmLeft - 16) < 0.6) && Math.max(...g.map((x) => x.mtRight)) - Math.min(...g.map((x) => x.mtRight)) < 0.6, JSON.stringify([k, g.map((x) => x.mtRight)]));
  ok("③ A2 頁尾:狀態句(試用到期)在 .wl-foot 裡、接在「看全部資料」後面,同一行、靠右貼齊卡的右緣", k.stIn && Math.abs(k.stMid) <= 1.5 && Math.abs(k.stRight) < 0.6 && Math.abs(k.footRight) < 0.6, JSON.stringify([k.stIn, k.stMid, k.stRight, k.footRight]));
  await paint(`${base}; acct.data_access = "included"; acct.data_included = true; acct.plan.state = "running"; acct.plan.trial_free_until = new Date(Date.now() + 5 * ${DAY}).toISOString()`); s = await snap();
  ok("③ 名下有主機(含試用日期還在)→ 單一清單、狀態句空(不講「免費到」)、沒有價格字", !s.cmp2 && s.cols.length === 1 && s.state === "" && !/TWD/.test(s.text));
  ok("③ 單一清單的列照順序號:加密 bnk / fng / ti / conc / liq / fr", (await js(`[...$("wl-body").querySelectorAll(".wd-row")].map((b) => b.dataset.id).join()`)) === "bnk,fng,ti,conc,liq,fr");
  // 看全部資料:外開網站的資料文件頁,清單畫面不動(app 內的完整目錄退役)
  { const s0 = await snap(); await js(`$("wl-all").click()`); await wait(50); s = await snap();
    ok("③ 單一清單按「看全部資料」→ 用瀏覽器開 " + DOCS.zh.crypto + "(恰好一次)、記 welcome_data_all;清單一個節點都沒變(#wl 的 innerHTML 逐字同)、分段還在、鈕字不變、沒有目錄的表格",
      s0.ext.length === 0 && !s0.tf.includes("welcome_data_all") && s.ext.join() === DOCS.zh.crypto && s.tf.filter((n) => n === "welcome_data_all").length === 1
      && s.html === s0.html && s.seg && !s.cmp2 && s.cols.length === 1 && s.cols[0].rows === 6 && s.all === Z["wd.all"] && s.old === 0, JSON.stringify([s.ext, s.tf, s.seg, s.all, s.old, s.html === s0.html])); }
  // 三個市場 × 兩語 × 兩種版本(對比版 / 單一清單):每一格點下去開的網址逐字比對,點完畫面與點之前相同
  { const badUrl = [], got = [];
    for (const mode of ["cmp", "one"]) {
      await paint(mode === "cmp" ? base : `${base}; acct.data_access = "included"; acct.data_included = true; acct.plan.state = "running"`);
      for (const L of ["zh", "en"]) {
        await js(`setLang("${L}"); applyStatic(); true`); await wait(50);
        for (const mk of ["crypto", "tw", "txf"]) {
          await js(`(() => { window.__ext.length = 0; window.__tf.length = 0; const b = $("wl-seg").querySelector('[data-mk="${mk}"]'); if (b.getAttribute("aria-pressed") !== "true") b.click(); return true; })()`); await wait(50);
          const a = await snap(); await js(`$("wl-all").click()`); await wait(50); const b = await snap();
          got.push(b.ext.join());
          if (b.ext.join() !== DOCS[L][mk] || b.tf.join() !== "welcome_data_all" || b.html !== a.html || !b.seg || b.old !== 0 || b.cmp2 !== (mode === "cmp") || b.all !== STR[L]["wd.all"]
            || b.cols.reduce((n, c) => n + c.rows, 0) !== ROWS.filter((r) => r[1] === mk).length) badUrl.push([mode, L, mk, b.ext, b.tf, b.html === a.html, b.seg, b.old, b.all].join(" / "));
        }
      }
    }
    ok("③ 「看全部資料」三個市場 × zh / en × 對比版 / 單一清單共 12 格:加密開 data_crypto、台股與台指期開 data_twstock、語言段跟著介面語言;每格外開恰好一次、記一次 welcome_data_all、畫面不變(列數、分段、鈕字、innerHTML)",
      got.length === 12 && badUrl.length === 0, badUrl.join("\n    ") || got.join(", "));
    await js(`setLang("zh"); applyStatic(); $("wl-seg").querySelector('[data-mk="crypto"]').click(); true`); await wait(50); }
  w.setSize(1000, 900); await wait(400);
  // 指紋:狀態沒變就不重畫(焦點不被洗掉)
  ok("③ 帳號狀態沒變再 wdPaint:DOM 不重建(焦點留在列上)", (await js(`(() => { const b = $("wl-body").querySelector(".wd-row"); b.focus(); wdPaint(); return document.activeElement === b; })()`)));
  // 第一次上色不靠載入順序(稽核 P2):設定裡選過語言時 applyStatic 在 app.js 裡同步跑完、早於 welcome.js,那一次畫不到
  await js(`localStorage.setItem("ws_lang", "zh"); true`);
  { const loaded = new Promise((r) => w.webContents.once("did-finish-load", r)); w.reload(); await loaded; await wait(1200); }
  ok("③ 選過語言、沒登入、重新載入:不用誰再叫 wdPaint,清單已經畫好(兩欄、中文、加密 2 + 4 列)", (await js(`(() => { const c = [...$("wl-body").querySelectorAll(".wl-col")]; return !hasToken && LANG === "zh" && c.length === 2 && c[0].querySelectorAll(".wd-row").length === 2 && c[1].querySelectorAll(".wd-row").length === 4 && c[0].querySelector(".wl-cap").textContent === t("wd.col.free") && $("wl-all").textContent === t("wd.all"); })()`)), JSON.stringify(await js(`({ hasToken: !!hasToken, LANG, saved: localStorage.getItem("ws_lang"), aria: $("wl-seg").getAttribute("aria-label"), cols: $("wl-body").querySelectorAll(".wl-col").length, rows: $("wl-body").querySelectorAll(".wd-row").length, all: $("wl-all").textContent, hidden: $("main-empty").hidden })`)));
  console.log(red ? `\n${red} FAILED` : "\nALL PASS");
  app.exit(red ? 1 : 0);
}).catch((e) => { console.log("FAIL  " + (e && e.stack || e)); app.exit(1); });
