// Codex 模型選擇器在剛裝好的電腦上永遠不出現:~/.codex/models_cache.json 第一次 codex exec 才寫出來,
// 進工作頁時型錄是空的就把 #mp 藏起來、之後不再讀。修法是每輪收尾(mpTurnEnd)型錄還空著就重讀一次。
//   1. 型錄空 → #mp 隱藏
//   2. kind = codex、型錄空 → 回合結束再呼叫 mpInit("codex");第二輪讀到型錄 → #mp 長出來
//   3. 型錄非空、或 kind 不是 codex → 不重呼叫
//   4. 接線:onTurnEnd 收尾、running = false 之後才呼叫(回合進行中不會觸發),成功失敗都呼叫
// 跑法:node tests/check_shell_mp_retry.js
const fs = require("fs"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "app.js"), "utf8");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };
const fn = (name) => { const i = src.indexOf("function " + name + "("); if (i < 0) throw new Error("找不到 " + name); let d = 0; for (let k = src.indexOf("{", src.indexOf(")", i)); k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}" && --d === 0) return src.slice(i, k + 1); } throw new Error("切不出 " + name); };
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

function world(catalogs, MP) {
  const els = {}; const $ = (id) => els[id] || (els[id] = { hidden: false });
  let reads = 0;
  const window = { blave: { modelOptions: async () => catalogs[Math.min(reads++, catalogs.length - 1)], loadModelPrefs: async () => ({}) } };
  const M = new Function("$", "window", "MP", "isObj", "mpPaint", `async ${fn("mpInit")}\n${fn("mpTurnEnd")}\n return { mpInit, mpTurnEnd };`)($, window, MP, isObj, () => {});
  return { M, $, reads: () => reads };
}
const EMPTY = { models: [], defaultModel: null };
const FULL = { models: [{ id: "gpt-5.5", efforts: ["high"] }], defaultModel: "gpt-5.5" };
const tick = () => new Promise((r) => setTimeout(r, 0));

(async () => {
  {
    const MP = { kind: null, models: [], prefs: {}, model: null };
    const w = world([EMPTY, FULL], MP);
    await w.M.mpInit("codex");
    ok("型錄空 → #mp 隱藏", w.$("mp").hidden === true && MP.models.length === 0);
    w.M.mpTurnEnd(); await tick();
    ok("codex + 型錄空:回合結束再讀一次型錄", w.reads() === 2, w.reads());
    ok("第二輪讀到型錄 → #mp 長出來、選中預設", w.$("mp").hidden === false && MP.model === "gpt-5.5", [w.$("mp").hidden, MP.model]);
    w.M.mpTurnEnd(); await tick();
    ok("型錄非空 → 不重讀", w.reads() === 2, w.reads());
  }
  for (const kind of ["blave", "claude"]) {
    const MP = { kind, models: [], prefs: {}, model: null };
    const w = world([EMPTY], MP);
    w.M.mpTurnEnd(); await tick();
    ok(`kind = ${kind}、型錄空 → 不重讀`, w.reads() === 0, w.reads());
  }
  {
    const MP = { kind: null, models: [], prefs: {}, model: null };
    const w = world([EMPTY, EMPTY], MP);
    await w.M.mpInit("codex"); w.M.mpTurnEnd(); await tick();
    ok("重讀仍空 → #mp 維持隱藏", w.$("mp").hidden === true && w.reads() === 2);
  }
  const i = src.indexOf("window.blave.onTurnEnd(async (r) => {");
  const end = src.slice(i, src.indexOf("\n});\n", i));
  const at = end.indexOf("mpTurnEnd();");
  ok("onTurnEnd 收尾呼叫 mpTurnEnd,在 running = false 之後、不包條件(成功失敗都重讀)",
    at > 0 && at > end.indexOf("running = false;") && /\n {2}mpTurnEnd\(\);\n/.test(end), at);
  console.log(red ? `\n${red} FAILED` : "\nALL PASS"); process.exit(red ? 1 : 0);
})();
