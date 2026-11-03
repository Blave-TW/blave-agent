// 手機來的第一句開成新分頁(tab-open 帶 echo):畫面先讀 session.db 再補畫 echo。runtime 搶先把那句寫進 session.db 的話,
// 舊碼歷史畫一次、echo 再畫一次。這裡照原文切出 tab-open 處理、csOpen、csDraw 實跑兩種先後,手機那句都只畫一次、帶「來自手機」。
// 跑法:node tests/check_shell_phone_echo_once.js
const fs = require("fs"), path = require("path");
const S = path.join(__dirname, "..", "shell"), R = path.join(S, "renderer");
const app = fs.readFileSync(path.join(R, "app.js"), "utf8"), ct = fs.readFileSync(path.join(R, "chattabs.js"), "utf8");
const main = fs.readFileSync(path.join(S, "main.js"), "utf8"), pre = fs.readFileSync(path.join(S, "preload.js"), "utf8");
const fnOf = (src, name) => { const i = src.search(new RegExp("(async )?function " + name + "\\(")); if (i < 0) throw new Error("找不到 " + name); return src.slice(i, src.indexOf("\n}", i) + 2); };
const cutReg = (src) => { const a = "window.blave.onTabOpen((o) => {", i = src.indexOf(a); if (i < 0) throw new Error("找不到 onTabOpen"); return "(" + src.slice(i + "window.blave.onTabOpen(".length, src.indexOf("\n});", i) + 2) + ")"; };
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };

ok("主行程 tab-open 帶開跑時間 since、preload 轉過去", /sendTurn\(sid, "tab-open", \{[^\n]*since: Date\.now\(\) \/ 1000 \}\)/.test(main) && /since: Number\.isFinite\(o\.since\) \? o\.since : 0/.test(pre));

async function run(rowLanded) {
  const you = [], since = 1000;
  const tick = () => new Promise((r) => setImmediate(r));
  const env = {
    CS: { tabs: new Map(), main: new Map(), order: [] }, csItems: [], window: { blave: {
      loadSession: async () => (rowLanded ? [{ role: "user", content: "嗨", ts: since + 0.4 }] : []),
      loadSessionImages: async () => [] } },
    document: { getElementById: () => null }, requestAnimationFrame: () => {}, trackFeature() {}, t: (k) => k, tabsTitle: () => "",
    tabMake: (sid) => { const T = { sid, dead: false }; env.CS.tabs.set(sid, T); return T; }, tabsAdd() {}, tabShow() {}, tabsQueued() {}, csRenderHead() {},
    withTab: (_T, fn) => fn(), addHistoryYou: (c, origin) => you.push({ c, origin }),
    csPaintHistory: (_T, turns) => turns.forEach((x) => { if (x.role === "user") env.addHistoryYou(x.content, x.origin); }),
    $: () => null,
  };
  const h = new Function("env", "with (env) { var running = false, turnSeq = 0, turnSeqMine = 0;\n" + fnOf(app, "csOpen") + "\n" + fnOf(app, "csDraw") + "\nreturn " + cutReg(ct) + "; }")(env);
  h({ sid: "desktop-x", origin: "mobile", focus: false, echo: "嗨", since });
  for (let i = 0; i < 5; i++) await tick();
  return you;
}
(async () => {
  let y = await run(true);
  ok("runtime 先寫進那句:手機那句只畫一次、帶「來自手機」", y.length === 1 && y[0].origin === "mobile", y);
  y = await run(false);
  ok("歷史還沒有那句:照舊補畫 echo 一次", y.length === 1 && y[0].origin === "mobile", y);
  console.log(red ? "\n" + red + " FAIL" : "\nall PASS");
  process.exit(red ? 1 : 0);
})();
