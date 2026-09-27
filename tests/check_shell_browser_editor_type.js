// 把 code 打進 Monaco / CodeMirror(Wei 0.1.7 實測:agent 打不進 TradingView 的 Pine Editor)。
// 三個根因與修法:
//   1. 焦點——Input.insertText 打進「有焦點的元素」;DOM.focus 對編輯面(view-lines 一類)是 no-op,
//      focusTarget 補 element.focus() 並認可編輯器把焦點轉給自己的隱藏 textarea;對不到 → 報錯不亂打
//   2. 座標——Monaco 的打字入口是 1px 隱藏 textarea,center() 對它一定 not_visible;打字不走座標,
//      量不到中心點只擋點擊,不擋 type / fill
//   3. 重排——insertText 會被 Monaco 當「打字」逐行 auto-indent,Pine 縮排整段跑版(實測);
//      編輯器目標改走真貼上(剪貼簿存 → wc.paste() → 還原),貼上不重排;一般欄位照走 insertText
// 長文字:browser_type 逐字只到 40 字,長 code 一次進(insertText / 貼上)。
// 真機驗證:TradingView /chart/ 匿名開 Pine Editor,12 行 Pine v6 逐字正確(含 4 空格縮排、
// 「Add to chart」跳 TV 自己的登入視窗=登入邊界,見 references/tradingview-pine.md)。
// 跑法:node tests/check_shell_browser_editor_type.js
const fs = require("fs");
const path = require("path");
const SHELL = path.join(__dirname, "..", "shell");
const cdp = fs.readFileSync(path.join(SHELL, "browser", "cdp.js"), "utf8");
const idx = fs.readFileSync(path.join(SHELL, "browser", "index.js"), "utf8");
const IP = require(path.join(SHELL, "browser", "inpage.js"));
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };

// ---- 1. fill 的接線:焦點驗證 → 編輯器判別 → 清空 → 貼上 / insertText
const fill = (cdp.match(/async function fill\(b, text, d, opt\) \{[\s\S]*?\n  \}/) || [""])[0];
ok("fill:DOM.focus 之後跑 focusTarget,對不到焦點報錯不亂打",
  /await send\("DOM\.focus", \{ backendNodeId: b \}\)/.test(fill) && /callOn\(b, IP\.focusTarget\)/.test(fill) && /could not focus the field/.test(fill));
ok("fill:編輯器目標走真貼上(剪貼簿存 → wc.paste → 還原),一般欄位照走 Input.insertText",
  /clipboard\.readText\(\)/.test(fill) && /clipboard\.writeText\(String\(text\)\)/.test(fill) && /wc\.paste\(\)/.test(fill) &&
  fill.indexOf("wc.paste()") < fill.indexOf('send("Input.insertText"') &&
  /finally \{ try \{ saved \? clipboard\.writeText\(saved\) : clipboard\.clear\(\); \}/.test(fill));
ok("fill:編輯器清空走真鍵盤 Cmd/Ctrl+A(clearField 回 false 那條),modifiers 對平台",
  /process\.platform === "darwin" \? 4 : 2/.test(fill) && /dispatchKeyEvent", \{ type: "keyDown", key: "a", code: "KeyA", modifiers: mod/.test(fill));

// ---- 2. inpage 的兩個純函式(以 toString 送進頁面跑:不可引用模組層變數)
["focusTarget", "clearField"].forEach((n) => ok(n + " 自含(函式體不引用模組層變數)", typeof IP[n] === "function" && !/EDITOR_SEL/.test(IP[n].toString())));
// focusTarget 行為:可聚焦 → focus 後 activeElement=目標;編輯面 → 容器裡的隱藏 textarea;都對不到 → false
function runFocus(el, doc) { return new Function("document", "el", "return (" + IP.focusTarget.toString() + ").call(el)")(doc, el); }
const mkDoc = () => ({ activeElement: null, body: {}, documentElement: {} });
{
  const doc = mkDoc();
  const el = { contains: () => false, closest: () => null, focus() { doc.activeElement = el; } };
  ok("focusTarget:可聚焦的欄位 → element.focus() 補上", runFocus(el, doc) === true);
}
{
  const doc = mkDoc();
  const host = {}; const ta = { tagName: "TEXTAREA", contains: () => false, closest: (s) => (/monaco/.test(s) ? host : null), focus() { doc.activeElement = ta; } };
  host.querySelector = (s) => (/textarea/.test(s) ? ta : null);
  const surface = { contains: () => false, closest: (s) => (/monaco/.test(s) ? host : null), focus() { /* view-lines 不可聚焦 */ } };
  ok("focusTarget:編輯面(不可聚焦)→ 焦點落到同一個編輯器容器裡的隱藏 textarea → 算對到", runFocus(surface, doc) === true && doc.activeElement === ta);
}
{
  const doc = mkDoc();
  const stray = { tagName: "INPUT", contains: () => false, closest: () => null };
  doc.activeElement = stray;   // 頁面上別的欄位有焦點
  const el = { contains: () => false, closest: () => null };   // 目標不可聚焦、也不在編輯器裡
  ok("focusTarget:對不到(焦點在不相干的欄位)→ false(insertText 不會打進去)", runFocus(el, doc) === false);
}
// clearField:編輯器容器裡 → false(改走鍵盤全選);一般 textarea 照舊 select()
{
  const inMonaco = { closest: (s) => (/monaco/.test(s) ? {} : null) };
  ok("clearField:編輯器裡的欄位回 false(value/selection 只是緩衝區,清不到文件)", IP.clearField.call(inMonaco) === false);
  let selected = false;
  const ta = { closest: () => null, value: "x", focus() {}, select() { selected = true; } };
  ok("clearField:一般欄位照舊 select()", IP.clearField.call(ta) === true && selected);
}

// ---- 2b. fill 行為(抽真函式、mock CDP / 剪貼簿):編輯器走貼上、一般欄位走 insertText
async function runFill({ editor, clear }) {
  const calls = { send: [], paste: 0, clip: [] };
  const clipboard = { _t: "USER-CLIP", readText: () => clipboard._t, writeText: (s) => { calls.clip.push(s); clipboard._t = s; }, clear: () => calls.clip.push(null) };
  const env = {
    send: async (m, p) => { calls.send.push(m); return {}; },
    callOn: async (b, fn) => (fn === IP.focusTarget ? true : fn === IP.clearField ? !editor : /closest/.test(fn.toString()) ? editor : true),
    IP, sleep: async () => {}, process, wc: { paste: () => { calls.paste++; } },
    require: (m) => (m === "electron" ? { clipboard } : require(m)),
  };
  const fn = new Function(...Object.keys(env), "return (" + fill.replace(/^async function fill/, "async function") + ")")(...Object.values(env));
  const r = await fn(1, "line1\n    line2", { isSelect: false }, { clear, perChar: false });
  return { r, calls, clipEnd: clipboard._t };
}
(async () => {
  const ed = await runFill({ editor: true, clear: true });
  ok("編輯器:真的貼上一次、沒送 insertText、剪貼簿先寫後還", ed.calls.paste === 1 && !ed.calls.send.includes("Input.insertText")
    && ed.calls.clip[0] === "line1\n    line2" && ed.clipEnd === "USER-CLIP", ed.calls);
  ok("編輯器:清空走真鍵盤(dispatchKeyEvent ×2)", ed.calls.send.filter((m) => m === "Input.dispatchKeyEvent").length === 2, ed.calls.send);
  const plain = await runFill({ editor: false, clear: true });
  ok("一般欄位:insertText、不碰剪貼簿、不 paste", plain.calls.send.includes("Input.insertText") && plain.calls.paste === 0 && plain.calls.clip.length === 0, plain.calls);

// ---- 3. doAct:打字不走座標、長文字不逐鍵
ok("doAct:量不到中心點只擋點擊(type / fill 繼續,pos 歸 null)",
  /if \(pos\.error && action === "click"\) return ERR/.test(idx) && /if \(pos\.error\) pos = null;/.test(idx));
ok("doAct:沒 pos 就不畫目標框 / 游標滑行,page_act 的 box 帶 null", /if \(pos\) \{\n      await v\.page\.run\(IP\.mark, \["ref"/.test(idx) && /box: pos \? pos\.box : null/.test(idx));
ok("doAct:browser_type 逐字只到 40 字,長 code 一次進", /const perChar = text\.length <= 40 && \(action === "type" \|\| spend\(t, text\.length \* 35\)\);/.test(idx));

  console.log(red ? "\n" + red + " FAILED" : "\nALL PASS");
  process.exit(red ? 1 : 0);
})();
