// 建議下一步 v2(shell/renderer/suggest.js + app.js / main.js 的接線;spec suggest-next-step-v2 §0、§1),不開 Electron:
//   1. <suggest> 區塊不會留在聊天文字裡:aiParts(app.js,歷史與升格都走它)剝掉完整區塊與沒收尾的尾段
//   2. 只取第一句(舊 runtime 給 3 句);kind 沒帶時照句首判
//   3. 灰字:回合結束停一拍才畫,輸入框空、沒附件、不在組字中才畫;第一次畫出來才記 suggest_shown、念一次
//   4. Tab / → 填入(帶修飾鍵不攔)、Esc 作廢不記;用鍵盤填滿 3 次不再畫鍵帽
//   5. 送出結算:跑起來才算 sent / sent_ed / missed;連續 5 次沒用 → 減少狀態(只剩導航句),填入一次就恢復;失敗不算
//   6. 設定開關:關掉不畫、送 off;打開歸零
// 跑法:node tests/check_shell_suggest.js
const fs = require("fs"), path = require("path");
const R = path.join(__dirname, "..", "shell", "renderer");
const app = fs.readFileSync(path.join(R, "app.js"), "utf8"), sugSrc = fs.readFileSync(path.join(R, "suggest.js"), "utf8");
const html = fs.readFileSync(path.join(R, "index.html"), "utf8");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  " + JSON.stringify(d))); if (!c) red++; };
const cut = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); if (i < 0 || j < 0) throw new Error("找不到原文:" + a); return src.slice(i, j); };

// ── 1. aiParts ──
const md = fs.readFileSync(path.join(R, "md.js"), "utf8");
eval((md.slice(0, md.indexOf("const mdEl")) + cut(app, "const CARD_TAG", "function paintAi")).replace(/^const /gm, "var "));
const textOf = (r) => { let o = ""; const walk = (x) => { if (Array.isArray(x)) return x.forEach(walk); if (x && typeof x === "object") { if (typeof x.text === "string") o += x.text; if (typeof x.code === "string") o += x.code; Object.values(x).forEach(walk); } }; walk(r.blocks); return o; };
for (const [name, raw, want] of [
  ["完整區塊在尾端", "回測跑完了,年化 12%。\n\n<suggest>\n帶我看怎麼把 BTC 均線上模擬盤\n掃一下參數\n</suggest>", "回測跑完了,年化 12%。"],
  ["沒收尾的尾段(回合被殺在區塊中間)", "回測跑完了。\n<suggest>\n帶我看怎麼", "回測跑完了。"],
  // 前後的空白跟區塊一起剝,結果同 runtime extract_suggestions
  ["兩個區塊都剝", "前段 <suggest>a</suggest> 中段\n<suggest>\nb\n</suggest>", "前段中段"],
  ["區塊與卡片標記並存", "拿不到資料。\n<blave-card:data-access/>\n<suggest>\n先登入\n</suggest>", "拿不到資料。"],
]) {
  for (const live of [true, false]) {
    const r = aiParts(raw, live), s = textOf(r);
    ok("aiParts(" + (live ? "串流" : "定稿") + "):" + name + " → 聊天文字沒有 <suggest> 也沒有建議句", !/<\/?suggest/.test(s) && s === want, s);
  }
}
ok("沒有區塊的回覆一字不動(含談到 suggest 這個字)", textOf(aiParts("suggest 一下 <b>x</b>", false)) === "suggest 一下 <b>x</b>");
ok("串流中 <suggest> 還沒湊齊(<sug、<sugges)先藏,不閃出字面", ["<s", "<sug", "<sugges", "<suggest"].every((h) => textOf(aiParts("回測跑完了。\n" + h, true)) === "回測跑完了。"));
ok("定稿時真的以 <sug 結尾的回覆原樣留著;<sup> 這種不是前綴的不藏", textOf(aiParts("回測跑完了。 <sug", false)).endsWith("<sug") && textOf(aiParts("x <sup", true)).endsWith("<sup"));

// ── 2–6. suggest.js:假 DOM 跑真的原文 ──
const el = (id) => { const e = { id, value: "", hidden: false, listeners: {}, classes: new Set(), attrs: {}, _text: "",
  classList: { add: (c) => e.classes.add(c), remove: (c) => e.classes.delete(c), contains: (c) => e.classes.has(c), toggle: (c, on) => { if (on) e.classes.add(c); else e.classes.delete(c); } },
  set textContent(v) { e._text = v; }, get textContent() { return e._text; },
  setAttribute(k, v) { e.attrs[k] = String(v); }, removeAttribute(k) { delete e.attrs[k]; },
  addEventListener(k, f) { (e.listeners[k] = e.listeners[k] || []).push(f); },
  fire(k, ev) { (e.listeners[k] || []).forEach((f) => f(Object.assign({ type: k }, ev))); },
  setSelectionRange(a, b) { e.sel = [a, b]; }, focus() {} }; return e; };
const W = {}; ["ta", "ta-field", "sug-ghost-t", "sug-kbd", "sug-desc", "set-sug-sw"].forEach((id) => { W[id] = el(id); });
const LS = new Map();
const ctx = { $: (id) => W[id], sessionId: "desktop-aaaa", running: false, composing: false, attachedFiles: [], tracked: [], said: [],
  trackFeature: (n) => ctx.tracked.push(n), srSay: (s) => ctx.said.push(s), autosize: () => {}, motionBaseMs: () => 0,
  escTop: () => ctx.topLayer || null, t: (k, v) => k + (v ? ":" + v.s : ""),
  lsGet: (k) => (LS.has(k) ? LS.get(k) : null), lsSet: (k, v) => LS.set(k, String(v)), setTimeout, clearTimeout };
new Function("ctx", "with (ctx) { " + sugSrc.replace(/^const SUG = /m, "var SUG = ") +
  "\n Object.assign(ctx, { sugPick, sugKindOf, sugChunk, sugTurnEnd, sugCollapse, sugPaint, sugSnap, sugSettle, sugUnsend, sugMode, SUG }); }")(ctx);
const wait = () => new Promise((r) => setTimeout(r, 20));
const shown = () => W["ta-field"].classes.has("has-ghost");
const key = (k, extra = {}) => { const e = Object.assign({ key: k, keyCode: 0, isComposing: false, defaultPrevented: false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
  prevented: false, preventDefault() { e.prevented = true; } }, extra); W.ta.fire("keydown", e); return e; };
const typeIn = (v) => { W.ta.value = v; W.ta.fire("input", {}); };
const arm = async (text = "回測 BTC 均線", kind) => { ctx.sugCollapse(); ctx.sugChunk({ items: [text], kind }); ctx.sugTurnEnd(true); await wait(); };
const reset = () => { ctx.sugCollapse(); LS.clear(); ctx.tracked = []; ctx.said = []; W.ta.value = ""; ctx.attachedFiles = []; ctx.composing = false; ctx.running = false; ctx.topLayer = null; delete ctx.BR; };
// 送一句(sendDraft → submitMessage 的順序):快照 → 清空 → 作廢 → 跑起來才結算
const send = (msg, started = true) => { ctx.sugSnap(msg); W.ta.value = ""; ctx.sugCollapse(); if (started) ctx.sugSettle(msg); else ctx.sugUnsend(); };

// 取句與 kind 後備:跑網頁那份測資(web/tests/suggest_vectors.json),兩個表面同一套判法;找不到 web 樹就紅,不 SKIP
{
  const vp = path.join(process.env.BLAVE_WEB_DIR || path.join(__dirname, "..", "..", "web"), "tests", "suggest_vectors.json");
  const V = fs.existsSync(vp) ? JSON.parse(fs.readFileSync(vp, "utf8")) : null;
  ok("讀得到網頁的 suggest_vectors.json(設 BLAVE_WEB_DIR)", !!V && V.pick.length > 0 && V.kind.length > 0, vp);
  if (V) {
    for (const v of V.pick) ok("sugPick:" + v.name, JSON.stringify(ctx.sugPick(v.chunk)) === JSON.stringify(v.pick), ctx.sugPick(v.chunk));
    for (const v of V.kind) ok("sugKindOf(" + JSON.stringify(v.text) + ") = " + v.kind, ctx.sugKindOf(v.text) === v.kind);
  }
  ok("sugPick:chunk 不是物件 → null", ctx.sugPick(null) === null);
}
// suggest.js 不在 check_shell_strings 的掃描範圍(SUG_NAV_PREFIXES 要跟網頁逐字同、是中文字面),它用的 t() key 在這裡驗
{
  const STR = fs.readFileSync(path.join(R, "strings.js"), "utf8");
  const keys = [...sugSrc.matchAll(/\bt\("([^"]+)"/g)].map((m) => m[1]);
  const html = fs.readFileSync(path.join(R, "index.html"), "utf8");
  const htmlKeys = [...html.matchAll(/data-i18n="(set\.sug[^"]*)"/g)].map((m) => m[1]);
  const all = keys.concat(htmlKeys), miss = all.filter((k) => (STR.match(new RegExp('"' + k.replace(/\./g, "\\.") + '":', "g")) || []).length !== 2);
  ok("suggest.js / 設定開關用到的 key 在 en、zh 兩張表都有(" + all.join(", ") + ")", all.length >= 4 && miss.length === 0, miss);
}

(async () => {
  reset();
  ctx.sugChunk({ type: "suggestions", session_id: "desktop-aaaa", items: ["掃 A 的參數找穩定區", "二", "三"] });
  ok("收到 chunk 先收著,回合還沒結束不畫", !shown());
  ctx.sugTurnEnd(true); await wait();
  ok("回合結束停一拍才畫:灰字是第一句、鍵帽在、textarea 掛 aria-describedby", shown() && W["sug-ghost-t"].textContent === "掃 A 的參數找穩定區" && !W["sug-kbd"].hidden
    && W.ta.attrs["aria-describedby"] === "sug-desc" && W["sug-desc"].textContent === "ws.sugDesc:掃 A 的參數找穩定區");
  ok("第一次畫出來:記 suggest_shown、讀屏念一次(只送名字)", JSON.stringify(ctx.tracked) === '["suggest_shown"]' && JSON.stringify(ctx.said) === '["ws.sugSay:掃 A 的參數找穩定區"]');
  typeIn("我");
  ok("一打字就藏、拿掉 aria-describedby", !shown() && !("aria-describedby" in W.ta.attrs));
  typeIn("");
  ok("刪回空白:同一句再出現,不重送 shown、不重念", shown() && ctx.tracked.length === 1 && ctx.said.length === 1);
  let e = key("Enter");
  ok("Enter 不攔(空輸入框照現行什麼都不做,不送出灰字)", !e.prevented && W.ta.value === "");
  e = key("Tab", { shiftKey: true });
  ok("Shift+Tab 不攔", !e.prevented && W.ta.value === "");
  e = key("ArrowRight", { metaKey: true });
  ok("帶修飾鍵的 → 不攔", !e.prevented && W.ta.value === "");
  ctx.composing = true; ctx.sugPaint();
  ok("組字中:灰字先藏", !shown());
  e = key("Tab");
  ok("組字中按 Tab:交給輸入法,不填入、不記", !e.prevented && W.ta.value === "" && ctx.tracked.length === 1);
  e = key("Tab", { isComposing: true }); key("Tab", { keyCode: 229 });
  ctx.composing = false; ctx.sugPaint();
  ok("組字結束:灰字回來", shown() && W.ta.value === "");
  e = key("Tab");
  ok("Tab:填入原句、preventDefault、記 suggest_filled、鍵盤次數 +1、灰字收掉", e.prevented && W.ta.value === "掃 A 的參數找穩定區" && !shown()
    && JSON.stringify(ctx.tracked) === '["suggest_shown","suggest_filled"]' && LS.get("ws_sug_tab") === "1" && JSON.stringify(W.ta.sel) === JSON.stringify([W.ta.value.length, W.ta.value.length]));
  typeIn("");
  ok("填入後把字刪光:這句用過了,不再出現", !shown());
  send("掃 A 的參數找穩定區");
  ok("填入後原句送出、跑起來:suggest_sent", ctx.tracked[ctx.tracked.length - 1] === "suggest_sent");

  reset(); await arm("掃 A 的參數找穩定區"); key("ArrowRight"); W.ta.value = "掃 A 的參數找穩定區,區間 10 到 30";
  send(W.ta.value.trim());
  ok("→ 也填入;改過字才送:suggest_sent_ed、不算沒用", JSON.stringify(ctx.tracked) === '["suggest_shown","suggest_filled","suggest_sent_ed"]' && (LS.get("ws_sug_miss") || "0") === "0");

  reset(); await arm(); key("Tab"); send("回測 BTC 均線", false);
  ok("填入後沒送出去(busy / 版本閘…):不記、不算沒用", JSON.stringify(ctx.tracked) === '["suggest_shown","suggest_filled"]' && (LS.get("ws_sug_miss") || "0") === "0");
  send("回測 BTC 均線");
  ok("…字放回輸入框後再送:填入狀態還在,記 suggest_sent", ctx.tracked[ctx.tracked.length - 1] === "suggest_sent");

  reset(); await arm(); send("我自己打的");
  ok("灰字出現過、自己打字送出:suggest_missed、計數 1", JSON.stringify(ctx.tracked) === '["suggest_shown","suggest_missed"]' && LS.get("ws_sug_miss") === "1");
  reset(); await arm(); send("我自己打的", false);
  ok("沒送出去:不算沒用", (LS.get("ws_sug_miss") || "0") === "0" && ctx.tracked.length === 1);
  reset(); W.ta.value = "還沒送的草稿"; await arm();
  ok("輸入框有草稿:先不畫、不記 shown", !shown() && ctx.tracked.length === 0);
  send("還沒送的草稿");
  ok("從來沒畫出來過:送出不算沒用", (LS.get("ws_sug_miss") || "0") === "0" && ctx.tracked.length === 0);
  reset(); ctx.attachedFiles = [{}]; await arm();
  ok("有附件:先不畫", !shown());
  ctx.attachedFiles = []; ctx.sugPaint();
  ok("附件清掉才第一次畫(這時才算 shown)", shown() && JSON.stringify(ctx.tracked) === '["suggest_shown"]');
  ctx.sugCollapse(); ctx.sugSettle("卡片送的");
  ok("從別的入口送出(沒經過 sendDraft、沒快照):作廢、不算沒用", !shown() && ctx.tracked.length === 1 && (LS.get("ws_sug_miss") || "0") === "0");

  reset(); await arm(); e = key("Escape", { keyCode: 27 });
  ok("Esc:作廢、preventDefault、不記", e.prevented && !shown() && ctx.tracked.length === 1);
  typeIn("x"); typeIn("");
  ok("Esc 作廢的那句刪回空白也不回來", !shown());
  send("x");
  ok("Esc 作廢後送出:不算沒用", (LS.get("ws_sug_miss") || "0") === "0");
  for (const [name, setup, extra] of [["有 modal / 選單開著(escTop)", () => { ctx.topLayer = () => {}; }, {}], ["內建瀏覽器展開層開著", () => { ctx.BR = { exp: {} }; }, {}],
    ["別人已 preventDefault", () => {}, { defaultPrevented: true }], ["組字中(keyCode 229)", () => {}, { keyCode: 229 }]]) {
    reset(); await arm(); setup(); e = key("Escape", extra);
    ok("Esc:" + name + " → 讓給它,不作廢、不 preventDefault", shown() && !e.prevented);
  }

  reset(); ctx.sugChunk({ items: ["x"] }); ctx.sugTurnEnd(false); await wait();
  ok("出錯 / 被停的回合:不畫、不留到下一輪", !shown() && ctx.SUG.pending === null && ctx.tracked.length === 0);
  ctx.sugTurnEnd(true); await wait();
  ok("下一輪沒有新 chunk → 不畫舊的", !shown());
  ctx.sugChunk({ session_id: "desktop-bbbb", items: ["別條對話的"] }); ctx.sugTurnEnd(true); await wait();
  ok("別條對話的 chunk 不收", !shown());
  ctx.sugChunk({ items: ["y"] }); ctx.sugTurnEnd(true); ctx.sugCollapse(); await wait();
  ok("停一拍之間作廢(送出 / 換對話):不畫", !shown());
  ctx.sugChunk({ items: ["z"] }); ctx.sugTurnEnd(true); ctx.running = true; await wait();
  ok("停一拍之間又開了一輪:不畫", !shown());

  reset();
  for (let i = 1; i <= 5; i++) { await arm(); send("自己打的 " + i); }
  ok("連續 5 次沒用:第 5 次記 suggest_reduced、進減少狀態、送出帶 reduced", ctx.tracked.filter((x) => x === "suggest_missed").length === 5
    && ctx.tracked.filter((x) => x === "suggest_reduced").length === 1 && ctx.tracked[ctx.tracked.length - 1] === "suggest_reduced" && ctx.sugMode() === "reduced");
  await arm("回測 A", "step");
  ok("減少狀態:step 句不畫", !shown());
  await arm("帶我看怎麼把 A 加進策略組合");
  ok("減少狀態:導航句照畫(沒帶 kind 也認得)", shown());
  ctx.tracked = []; send("自己打的 6");
  ok("超過門檻再沒用:只記 missed,不重送 reduced", JSON.stringify(ctx.tracked) === '["suggest_missed"]');
  await arm("帶我看怎麼先綁模擬盤帳戶"); key("Tab");
  ok("填入一次就恢復:計數歸零、送出回到 normal", LS.get("ws_sug_miss") === "0" && ctx.sugMode() === "normal");

  reset();
  for (let i = 0; i < 3; i++) { await arm(); key("Tab"); W.ta.value = ""; }
  await arm();
  ok("用鍵盤填滿 3 次:不再畫鍵帽,灰字照畫", shown() && W["sug-kbd"].hidden && LS.get("ws_sug_tab") === "3");

  reset(); await arm(); W["set-sug-sw"].fire("click", {});
  ok("設定關掉:灰字作廢、記 suggest_off、存 ws_sug_on=0、開關畫成關、送出帶 off", !shown() && ctx.tracked[ctx.tracked.length - 1] === "suggest_off" && LS.get("ws_sug_on") === "0"
    && W["set-sug-sw"].attrs["aria-checked"] === "false" && W["set-sug-sw"].classes.has("off") && ctx.sugMode() === "off");
  ctx.tracked = []; await arm("帶我看怎麼把 A 加進策略組合");
  ok("關掉時:連導航句都不畫、不記 shown", !shown() && !ctx.tracked.includes("suggest_shown"));
  LS.set("ws_sug_miss", "7"); W["set-sug-sw"].fire("click", {});
  ok("重新打開:記 suggest_on、計數歸零、開關畫成開", ctx.tracked[ctx.tracked.length - 1] === "suggest_on" && LS.get("ws_sug_miss") === "0"
    && W["set-sug-sw"].attrs["aria-checked"] === "true" && ctx.sugMode() === "normal");

  // ── 接線(原文) ──
  const sub = cut(app, "async function submitMessage(msg, opts)", "\n/* ── A′ 的標示");
  const sd = cut(app, "async function sendDraft()", "/* 真的送出一句話。");
  ok("sendDraft:清空輸入框之前先存快照", /running\) return;\n\s*if \(typeof sugSnap === "function"\) sugSnap\(msg\);[^\n]*\n\s*\$\("ta"\)\.value = "";/.test(sd));
  ok("submitMessage 開頭作廢(任何入口)", /if \(\(!msg && !attachments\.length\) \|\| running\) return false;\n\s*if \(typeof sugCollapse === "function"\) sugCollapse\(\);/.test(sub));
  ok("跑起來(r.started)那一支之前結算", /if \(r\.started && typeof sugSettle === "function"\) sugSettle\(msg\);[^\n]*\n(?:\s*\/\/[^\n]*\n)?\s*if \(r\.started && attachments\.length[^\n]*\n\s*if \(r\.started\) \{ busyStart\(\); trackFeature\("chat_sent"\);/.test(sub));
  ok("沒送出去的路都走 unlock:還原填入狀態", /const unlock = \(\) => \{ if \(typeof sugUnsend === "function"\) sugUnsend\(\);/.test(sub) && (sub.match(/unsend\(\); unlock\(\);|unlock\(\); unsend\(\);/g) || []).length >= 4);
  ok("送出帶 suggestMode", /sendMessage\(\{\n\s*sessionId, suggestMode: typeof sugMode === "function" \? sugMode\(\) : "normal", message: msg,/.test(sub));
  ok("setAttachments 之後重畫灰字", /box\.hidden = !attachedFiles\.length;\n\s*if \(typeof sugPaint === "function"\) sugPaint\(\);/.test(app));
  ok("換對話 / 新對話(csClearChat)作廢", /function csClearChat\(\) \{[\s\S]*?sugCollapse\(\)[\s\S]*?\n\}/.test(app));
  ok("turn-event:suggestions → sugChunk", /c\.type === "suggestions"\) \{\n\s*if \(typeof sugChunk === "function"\) sugChunk\(c\);/.test(app));
  const end = cut(app, "window.blave.onTurnEnd(async (r) => {", "\n});\n");
  ok("turn-end 收尾才畫,出錯與停止都不畫", /sugTurnEnd\(!stopped && !faulted\);/.test(end) && end.indexOf("sugTurnEnd(") > end.indexOf("xpTurnEnd()"));
  ok("collectDraft 不認 suggestions(不會被升成回覆)", !/suggestions/.test(cut(app, "function collectDraft(", "function draftShow(")));
  ok("index.html:舊建議列拿掉;灰字疊在 textarea 那一列(.ta-field 包 textarea + aria-hidden 灰字 + kbd + sr-only 說明),在 .ci-bar 之前",
    !/sug-wrap|sug-close|sug-rows/.test(html)
    && /<div class="chat-input">\s*<!--[\s\S]*?-->\s*<div class="ta-field" id="ta-field">\s*<textarea id="ta" rows="1" data-i18n-ph="ws\.placeholder"><\/textarea>\s*<div class="sug-ghost" aria-hidden="true"><span class="sug-ghost-t" id="sug-ghost-t"><\/span><kbd id="sug-kbd">Tab<\/kbd><\/div>\s*<span class="sr-only" id="sug-desc"><\/span>\s*<\/div>\s*<div class="ci-bar">/.test(html)
    && /<script src="app\.js"><\/script>\n<script src="suggest\.js"><\/script>/.test(html) && /<link rel="stylesheet" href="suggest\.css">/.test(html));
  ok("index.html:設定 › 一般有開關(role=switch、labelledby 字、describedby 說明泡泡)",
    /<div class="set-pane" data-set-cat="display">[\s\S]*<button type="button" class="sw" id="set-sug-sw" role="switch" aria-checked="true" aria-labelledby="set-sug-l" aria-describedby="set-sug-tip"><\/button>[\s\S]*<div class="set-pane" data-set-cat="model"/.test(html)
    && /<span class="set-sug-l" id="set-sug-l" data-i18n="set\.sug"><\/span><span class="tip" id="set-sug-tip" role="tooltip" data-i18n="set\.sug\.tip"><\/span>/.test(html));
  const css = fs.readFileSync(path.join(R, "suggest.css"), "utf8");
  ok("suggest.css:灰字不吃滑鼠、單行省略號;沒有寫死的色碼與毫秒", /pointer-events: none/.test(css) && /text-overflow: ellipsis/.test(css) && /white-space: nowrap/.test(css) && !/#[0-9a-f]{3,8}\b|\d+ms\b/i.test(css));
  const main = fs.readFileSync(path.join(R, "..", "main.js"), "utf8");
  const sa = new Function((main.match(/function suggestArgs\(mode\) \{[^\n]*\}/) || ["function suggestArgs() { return null; }"])[0] + "\nreturn suggestArgs;")();
  ok("main.js suggestArgs:只送 reduced / off,normal 與怪值不帶", JSON.stringify(sa("reduced")) === '["--suggest-mode=reduced"]' && JSON.stringify(sa("off")) === '["--suggest-mode=off"]'
    && [undefined, "normal", "off --x", 3, null].every((m) => JSON.stringify(sa(m)) === "[]"));
  ok("main.js runTurn 收 suggestMode、接在 viewingArgs 後面", /attachments, suggestMode \}\) \{/.test(main) && /\.\.\.viewingArgs\(viewing\),\n\s*\.\.\.suggestArgs\(suggestMode\),/.test(main));
  console.log(red ? "\n" + red + " 紅" : "\nALL PASS");
  process.exit(red ? 1 : 0);
})();
