// 模型選單打得開(0.1.8 開發版 P0:點了鈕有反白、面板不出現,所有引擎都一樣)。
// 根因是 mpOpen 裡的區域 `const cur` 遮住外層的 `cur`,第一行就丟 ReferenceError;只比對原文的測試看不出來,所以這支**真的呼叫** mpOpen。
//   1. 引擎是 Blave AI / 不是 Blave AI:呼叫 mpOpen() 不丟例外、面板 hidden === false、鈕的 aria-expanded = true
//   2. Blave AI + 已登入:開選單時重讀餘額(主行程 10 秒內用上一次的答案);沒登入、別的引擎不讀
//   3. 鍵盤開的焦點落在選中那一列,滑鼠開的不動焦點;回合進行中不開;mpPickModel 同一個寫法也跑一次
// 跑法:node tests/check_shell_model_menu.js
const fs = require("fs"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "app.js"), "utf8");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };
const fn = (name) => { const i = src.indexOf("function " + name + "("); if (i < 0) throw new Error("找不到 " + name); let d = 0; for (let k = src.indexOf("{", src.indexOf(")", i)); k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}" && --d === 0) return src.slice(i, k + 1); } throw new Error("切不出 " + name); };

function world(o) {
  const els = {}, focused = [], checks = [];
  const row = { focus() { focused.push("row"); } };
  const $ = (id) => els[id] || (els[id] = { id, hidden: id === "mp-panel", attrs: {}, cls: new Set(), classList: { add: (c) => els[id].cls.add(c), remove: (c) => els[id].cls.delete(c) },
    setAttribute(k, v) { this.attrs[k] = v; }, focus() { focused.push(id); }, querySelector: () => (o.noRow ? null : row) });
  // 外層的 cur / running 等照 app.js 是 let:包在同一層宣告,函式照原文放進來——遮蔽與 TDZ 才會跟真的一樣
  const M = new Function("$", "balLoad", "o", `let cur = o.cur, running = !!o.running, hasToken = !!o.hasToken;
    const MP = { model: "a", kind: "claude", prefs: {} }; const mpEffort = () => "high", mpCur = () => ({ efforts: ["high"] }), mpSave = () => {}, mpPaint = () => {};
    ${fn("mpOpen")}\n${fn("mpClose")}\n${fn("mpPickModel")}\n return { mpOpen, mpClose, mpPickModel };`)($, () => checks.push(1), o);
  return { M, $, focused, checks };
}
const open = (o, viaMouse) => { const w = world(o); let err = null; try { w.M.mpOpen(viaMouse); } catch (e) { err = String(e); } return Object.assign(w, { err }); };

for (const cur of ["blave", "claude", "codex", null]) {
  const w = open({ cur, hasToken: true, acctAt: Date.now() }, true);
  ok(`引擎 ${cur}:mpOpen() 不丟例外、面板打開、aria-expanded = true`, w.err === null && w.$("mp-panel").hidden === false && w.$("mp").cls.has("is-open") && w.$("mp-trigger").attrs["aria-expanded"] === "true", w.err);
}
ok("Blave AI + 已登入:開選單時重讀餘額一次", open({ cur: "blave", hasToken: true }, true).checks.length === 1);
ok("沒登入 / 別的引擎:不讀", [{ cur: "blave", hasToken: false }, { cur: "claude", hasToken: true }, { cur: "codex", hasToken: true }].every((o) => open(o, true).checks.length === 0));
ok("鍵盤開的:焦點落在選中那一列;滑鼠開的不動焦點;沒有選中列也不炸", open({ cur: "claude" }, false).focused.join() === "row" && open({ cur: "claude" }, true).focused.length === 0 && open({ cur: "claude", noRow: true }, false).err === null);
{ const w = open({ cur: "blave", running: true, hasToken: true, acctAt: 0 }, true);
  ok("回合進行中:不開、也不讀餘額", w.err === null && w.$("mp-panel").hidden === true && w.checks.length === 0); }
{ const w = world({ cur: "blave" }); let err = null; try { w.M.mpPickModel("b", false); } catch (e) { err = String(e); }
  ok("mpPickModel() 同樣不丟例外(鍵盤選的焦點跟到選中列)", err === null && w.focused.join() === "row", err); }
{ const w = open({ cur: "claude" }, true); w.M.mpClose(true);
  ok("mpClose():面板收起、焦點回到鈕上", w.$("mp-panel").hidden === true && w.$("mp-trigger").attrs["aria-expanded"] === "false" && w.focused.join() === "mp-trigger"); }
console.log(red ? `\n${red} FAILED` : "\nALL PASS"); process.exit(red ? 1 : 0);
