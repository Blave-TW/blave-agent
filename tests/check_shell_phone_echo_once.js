// 手機來的第一句開成新分頁(tab-open 帶 echo):畫面先讀 session.db 再補畫 echo。runtime 搶先把那句寫進 session.db 的話,
// 舊碼歷史畫一次、echo 再畫一次。這裡照原文切出 tab-open 處理、csOpen、csDraw 實跑兩種先後,手機那句都只畫一次、帶「來自手機」。
// 手機那句是第一句時,分頁標題也要跟著設(不然一直是「新對話」)。
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
// 手機那句是第一句:分頁標題比照電腦前送出(空才設、拆掉附件行、純附件留檔名);背景分頁不動眼前的標題列,清單那一列跟著換
// withTab 照 chattabs.js 的契約:csTitle 是「目前載入那個分頁」的別名,跑完存回 T.title
async function titles() {
  const tick = () => new Promise((r) => setImmediate(r));
  const NOTE = "\n[用戶傳了檔案：tmp/inbound/1730000000_a.csv，請先讀取檔案內容再回應]";
  async function go(o) {
    const head = [], saved = [], cur = { sid: "cur", st: { csTitle: o.curTitle || "" }, title: o.curTitle || "" };
    const env = {
      CS: { tabs: new Map(), main: new Map(), order: [], cur, loaded: cur, bg: false }, csItems: [{ id: "phone-1", title: "" }],
      window: { blave: { loadSession: async () => o.history || [], loadSessionImages: async () => [] } },
      document: { getElementById: () => null }, requestAnimationFrame: () => {}, trackFeature() {}, t: (k) => k, tabsTitle: () => "",
      tabMake: (sid) => { const T = { sid, dead: false, st: { csTitle: "" }, title: "" }; env.CS.tabs.set(sid, T); return T; }, tabsAdd() {}, tabShow(T) { const C = env.CS; C.loaded.st.csTitle = env.csTitle; C.cur = C.loaded = T; env.csTitle = T.st.csTitle; }, tabsQueued() {},
      csRenderHead: () => head.push(env.csTitle), tabsSave: () => saved.push("save"), tabsPaint() {}, csFilter: () => saved.push("filter"),
      addHistoryYou() {}, csPaintHistory: (T, turns) => { const f = env.splitAttachNote((turns.find((x) => x.role === "user") || {}).content || ""); env.csTitle = f.text || f.attachments[0] || ""; },
      $: (id) => (id === "cs-list" ? { hidden: !o.listOpen } : null),
      withTab(T, fn) { const C = env.CS; if (T === C.loaded) return fn(); const prev = C.loaded, bg = C.bg; prev.st.csTitle = env.csTitle;
        C.loaded = T; env.csTitle = T.st.csTitle; C.bg = T !== C.cur;
        try { return fn(); } finally { T.st.csTitle = env.csTitle; T.title = env.csTitle; C.loaded = prev; env.csTitle = prev.st.csTitle; C.bg = bg; } },
      csTitle: o.curTitle || "",
    };
    if (o.existing) { const T = env.tabMake("phone-1"); T.st.csTitle = T.title = o.existing; T.drawn = true; env.CS.tabs.set("phone-1", T); }
    const fns = ["csOpen", "csDraw", "tabsPhoneTitle"].map((n) => fnOf(n === "tabsPhoneTitle" ? ct : app, n)).join("\n") + "\n" + fnOf(app, "splitAttachNote");
    const res = app.match(/const ATTACH_NOTE_RE = [^\n]+\nconst ATTACH_FAIL_RE = [^\n]+/)[0];
    const h = new Function("env", "with (env) { var running = false, turnSeq = 0, turnSeqMine = 0;\n" + res + "\n" + fns + "\nenv.splitAttachNote = splitAttachNote;\nreturn " + cutReg(ct) + "; }")(env);
    h({ sid: "phone-1", origin: "mobile", focus: o.focus === true, echo: o.echo, since: 1000 });
    for (let i = 0; i < 6; i++) await tick();
    const T = env.CS.tabs.get("phone-1");
    return { title: T.title, cur: env.csTitle, head, saved, item: env.csItems[0].title };
  }
  let r = await go({ echo: "看一下 BTC 資金費率" + NOTE, curTitle: "眼前那條" });
  ok("背景分頁、歷史還沒有那句:分頁標題 = 手機那句(拆掉附件行),清單那一列同步、記分頁", r.title === "看一下 BTC 資金費率" && r.item === "看一下 BTC 資金費率" && r.saved.includes("save"), r);
  ok("…背景分頁不動眼前那條的標題與標題列", r.cur === "眼前那條" && r.head.every((x) => x !== "看一下 BTC 資金費率"), r);
  r = await go({ echo: "嗨", focus: true });
  ok("目前分頁(切過去的):標題與標題列都換成那句", r.title === "嗨" && r.cur === "嗨" && r.head.includes("嗨"), r);
  r = await go({ echo: NOTE.slice(1) });
  ok("純附件那句:標題用檔名(同電腦前)", r.title === "a.csv", r);
  r = await go({ echo: "第二句", existing: "原本的標題" });
  ok("已經有標題(之前講過話):不改", r.title === "原本的標題" && r.item === "", r);
  r = await go({ echo: "嗨", history: [{ role: "user", content: "嗨", ts: 1000.4 }] });
  ok("歷史先讀到那句:標題照歷史、不重設", r.title === "嗨" && !r.saved.length, r);
  r = await go({ echo: "嗨", listOpen: true });
  ok("對話清單開著:重畫那一列", r.saved.includes("filter") && r.item === "嗨", r);
}
(async () => {
  let y = await run(true);
  ok("runtime 先寫進那句:手機那句只畫一次、帶「來自手機」", y.length === 1 && y[0].origin === "mobile", y);
  y = await run(false);
  ok("歷史還沒有那句:照舊補畫 echo 一次", y.length === 1 && y[0].origin === "mobile", y);
  await titles();
  console.log(red ? "\n" + red + " FAIL" : "\nall PASS");
  process.exit(red ? 1 : 0);
})();
