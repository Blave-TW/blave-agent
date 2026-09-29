// 建議下一步(shell/renderer/suggest.js + app.js 的接線),不開 Electron、不碰 DOM 以外的東西:
//   1. <suggest> 區塊不會留在聊天文字裡:aiParts(app.js,歷史與升格都走它)剝掉完整區塊與沒收尾的尾段
//   2. 最多 3 行:sugItems 過濾非字串 / 空白 / 超長,取前 3
//   3. 送出後收合:回合結束才長出;送出(任何入口)、出錯、換對話都收合作廢;出錯 / 被停的回合不長
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

// ── 2/3. suggest.js:假 DOM 跑真的原文 ──
const el = (id) => { const e = { id, inert: false, children: [], _text: "", listeners: {}, classes: new Set(), attrs: {},
  classList: { add: (c) => e.classes.add(c), remove: (c) => e.classes.delete(c), contains: (c) => e.classes.has(c) },
  set textContent(v) { e._text = v; if (v === "") e.children = []; }, get textContent() { return e._text || e.children.map((c) => c.textContent).join(""); },
  appendChild(c) { e.children.push(c); c.parent = e; return c; }, append(...cs) { cs.forEach((c) => e.appendChild(c)); },
  setAttribute(k, v) { e.attrs[k] = v; }, addEventListener(k, f) { e.listeners[k] = f; },
  contains(x) { for (let p = x; p; p = p.parent) if (p === e) return true; return false; },
  focus() { doc.activeElement = e; }, get offsetHeight() { return 0; }, scrollHeight: 0, scrollTop: 0, clientHeight: 0 }; return e; };
const doc = { activeElement: null, createElement: () => el(null) };
const W = { "sug-wrap": el("sug-wrap"), "sug-rows": el("sug-rows"), "ta": el("ta"), "chat-scroll": el("chat-scroll") };
W["sug-rows"].parent = W["sug-wrap"]; W["sug-wrap"].inert = true; W["sug-wrap"].classes.add("is-closed");
const ctx = { $: (id) => W[id], document: doc, sessionId: "desktop-aaaa", running: false, tracked: [], sent: [],
  trackFeature: (n) => ctx.tracked.push(n), motionBaseMs: () => 0, chatEdge: () => {}, setTimeout, clearTimeout };
// submitMessage 的替身只做真的那支開頭兩件事(下面另外釘住原文):回合在跑就不送、否則先收合建議列。
// failNext:收合之後沒跑起來(暖機中停止、版本閘、busy、引擎起不來)——真的那支這時已 unlock(running=false)再回 false
ctx.submitMessage = async (m) => { if (!m || ctx.running) return false; ctx.sugCollapse(); ctx.running = true;
  if (ctx.failNext) { ctx.failNext = false; await null; ctx.running = false; return false; }
  ctx.sent.push(m); return true; };
new Function("ctx", "with (ctx) { " + sugSrc.replace(/^const SUG/m, "var SUG") + "\n ctx.sugItems = sugItems; ctx.sugChunk = sugChunk; ctx.sugCollapse = sugCollapse; ctx.sugTurnEnd = sugTurnEnd; ctx.SUG = SUG; }")(ctx);
const wait = () => new Promise((r) => setTimeout(r, 20));
const open = () => !W["sug-wrap"].inert && !W["sug-wrap"].classes.has("is-closed");
const rows = () => W["sug-rows"].children.map((b) => b.children[1].textContent);

const long = "x".repeat(201);
ok("sugItems:最多 3 句,非字串 / 空白 / 超過 200 字整條丟", JSON.stringify(ctx.sugItems({ items: ["a", 3, "  ", long, "b", null, "c", "d", "e"] })) === JSON.stringify(["a", "b", "c"]));
ok("sugItems:items 不是陣列 → 空", ctx.sugItems({ items: "a" }).length === 0 && ctx.sugItems(null).length === 0);

(async () => {
  ctx.sugChunk({ type: "suggestions", session_id: "desktop-aaaa", items: ["一", "二", "三", "四", "五"] });
  ok("收到 chunk 先收著,回合還沒結束不長出", !open() && W["sug-rows"].children.length === 0);
  ctx.sugTurnEnd(true); await wait();
  ok("回合結束停一拍才長出,最多 3 行、inert 拿掉、is-closed 拿掉", open() && JSON.stringify(rows()) === JSON.stringify(["一", "二", "三"]), rows());
  ok("行是 button、行首 ↳ 對讀屏隱藏、句子走 textContent", W["sug-rows"].children.every((b) => b.type === "button" && b.children[0].attrs["aria-hidden"] === "true" && b.children[0].textContent === "↳"));
  ok("長出時記 suggest_shown(只送名字)", JSON.stringify(ctx.tracked) === JSON.stringify(["suggest_shown"]));
  W["sug-rows"].children[1].focus();
  W["sug-rows"].children[1].listeners.click(); await wait();
  ok("點一行 = 原句送出", JSON.stringify(ctx.sent) === JSON.stringify(["二"]));
  ok("送出後收合:inert 與 is-closed 同進退", W["sug-wrap"].inert === true && W["sug-wrap"].classes.has("is-closed"));
  ok("焦點在行上時收合,焦點還給輸入框", doc.activeElement === W.ta);
  ok("回合跑起來才記 suggest_clicked;兩個事件都不帶句子", JSON.stringify(ctx.tracked) === JSON.stringify(["suggest_shown", "suggest_clicked"]));
  W["sug-rows"].children[0].listeners.click(); await wait();
  ok("回合在跑:作廢的行再點不送、不記、也不長回來", ctx.sent.length === 1 && ctx.tracked.length === 2 && !open());

  ctx.running = false; ctx.tracked = [];
  ctx.sugChunk({ items: ["x"] }); ctx.sugTurnEnd(false); await wait();
  ok("出錯 / 被停的回合:收到的建議不長出、也不留到下一輪", !open() && ctx.SUG.pending === null && ctx.tracked.length === 0);
  ctx.sugTurnEnd(true); await wait();
  ok("下一輪沒有新 chunk → 不長出舊的", !open());
  ctx.sugChunk({ session_id: "desktop-bbbb", items: ["別條對話的"] }); ctx.sugTurnEnd(true); await wait();
  ok("別條對話的 chunk 不收", !open());
  ctx.sugChunk({ items: ["y"] }); ctx.sugTurnEnd(true); ctx.sugCollapse(); await wait();
  ok("停一拍之間收合(送出 / 換對話):排好的長出取消", !open());
  ctx.sugChunk({ items: ["z"] }); ctx.sugTurnEnd(true); ctx.running = true; await wait();
  ok("停一拍之間又開了一輪:不長出", !open());
  ctx.running = false; ctx.sugChunk({ items: ["甲", "乙"] }); ctx.sugTurnEnd(true); await wait();
  ctx.tracked = []; ctx.failNext = true; W["sug-rows"].children[1].listeners.click(); await wait();
  ok("點了但沒跑起來:同一組長回來(點的句子不會塞回輸入框,收掉就什麼都不剩),不再記 shown、也不記 clicked",
    open() && JSON.stringify(rows()) === JSON.stringify(["甲", "乙"]) && ctx.tracked.length === 0 && ctx.running === false);

  // ── 接線(原文) ──
  const sub = cut(app, "async function submitMessage(msg, opts)", "UPD.turnCloud = false;");
  ok("submitMessage 開頭收合(打字、點建議、轉出、交接…任何入口)", /if \(!msg \|\| running\) return false;\n\s*if \(typeof sugCollapse === "function"\) sugCollapse\(\);/.test(sub));
  ok("換對話 / 新對話(csClearChat)收合", /function csClearChat\(\) \{[\s\S]*?sugCollapse\(\)[\s\S]*?\n\}/.test(app));
  ok("turn-event:suggestions → sugChunk、error → sugCollapse", /c\.type === "suggestions"\) \{\n\s*if \(typeof sugChunk === "function"\) sugChunk\(c\);/.test(app) && /c\.type === "error"\) \{\n\s*turnErrored = true;\n\s*if \(typeof sugCollapse === "function"\) sugCollapse\(\);/.test(app));
  const end = cut(app, "window.blave.onTurnEnd(async (r) => {", "\n});\n");
  ok("turn-end 收尾才長出(回覆定稿、轉出卡之後),出錯與停止都不長", /sugTurnEnd\(!stopped && !faulted\);[^\n]*\n\s*if \(rt\) resTurnEnd\(rt, cloudTurn\);/.test(end) && end.indexOf("sugTurnEnd(") > end.indexOf("xpTurnEnd(liveBubble)"));
  ok("collectDraft 不認 suggestions(不會被升成回覆)", !/suggestions/.test(cut(app, "function collectDraft(", "function draftShow(")));
  ok("index.html:建議列預設收合 + inert、group 帶 aria-label key、小標 aria-hidden、腳本與樣式都載入",
    /<div class="sug-wrap is-closed" id="sug-wrap" inert>/.test(html) && /role="group" data-i18n-aria="ws.sugGroup"/.test(html) && /class="sug-cap" aria-hidden="true" data-i18n="ws.sugGroup"/.test(html)
    && /<script src="app\.js"><\/script>\n<script src="suggest\.js"><\/script>/.test(html) && /<link rel="stylesheet" href="suggest\.css">/.test(html));
  console.log(red ? "\n" + red + " 紅" : "\nALL PASS");
  process.exit(red ? 1 : 0);
})();
