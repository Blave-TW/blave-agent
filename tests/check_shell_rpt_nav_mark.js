// 新報告的記號(spec first-strategy-sidebar §A5):0.1.57 起側欄沒有報告列,記號改成一個旗標(reports.js RPT.mark)加兩個落點——
// 選單關著畫在左下第一格(app.js amFirstPaint,check_shell_prompt_slot.js 驗長相與名稱)、選單開著畫在「報告」那一列的列尾(amPaint,這裡驗)。
// 何時亮、何時清照舊:本機與雲端共用一個旗標,哪一個視角進報告清單、或打開任何一份報告(含結果卡〔打開報告〕)都收掉;只打開選單不清。
// 跑法:node tests/check_shell_rpt_nav_mark.js(切 reports.js／app.js 原文進 vm 跑,不開 Electron)
const fs = require("fs"), path = require("path"), vm = require("vm");
const R = path.join(__dirname, "..", "shell", "renderer");
const src = fs.readFileSync(path.join(R, "reports.js"), "utf8"), app = fs.readFileSync(path.join(R, "app.js"), "utf8");
let red = 0; const t = (n, ok, d) => { console.log((ok ? "PASS  " : "FAIL  ") + n + (ok || d === undefined ? "" : "  " + JSON.stringify(d))); if (!ok) red++; };
const cutFn = (s, name) => { const i = s.indexOf("function " + name + "("); if (i < 0) throw new Error("no " + name); let d = 0; for (let k = s.indexOf("{", i); k < s.length; k++) { if (s[k] === "{") d++; else if (s[k] === "}" && --d === 0) return s.slice(i, k + 1); } throw new Error("unbalanced " + name); };

function env(view) {
  const els = {}, el = (id) => els[id] || (els[id] = { id, hidden: false, scrollTop: 0, focus() {} });
  const bags = { local: { open: false, reading: null, scroll: 0, row: null }, cloud: { open: false, reading: null, scroll: 0, row: null } };
  const paints = [];
  const ctx = { $: el, RPT: { readSeq: 0, mark: false }, rptBag: (e) => bags[(e || view.env) === "cloud" ? "cloud" : "local"], libEnv: () => view.env, amFirstPaint: () => paints.push(1),
    envShowMain() {}, rptLoad() {}, rptFocusHome() {}, libTrack() {}, rptPaint() {}, stratSelect: async () => {}, rpCloudSelect: async () => {} };
  vm.createContext(ctx);
  vm.runInContext("async " + cutFn(src, "rptOpen") + "\n" + cutFn(src, "rptShowRead") + "\n" + cutFn(src, "rptMarkSet"), ctx);
  return { ctx, paints };
}

(async () => {
  for (const where of ["local", "cloud"]) {
    let { ctx, paints } = env({ env: where });
    ctx.RPT.mark = true;
    const opened = await ctx.rptOpen();
    t(where + ":進報告清單 → 旗標清掉、第一格重畫", opened === true && ctx.RPT.mark === false && paints.length === 1);
    ({ ctx, paints } = env({ env: where }));
    ctx.RPT.mark = true;
    ctx.rptShowRead("r1");
    t(where + ":直接打開一份報告(rptShowRead)→ 旗標清掉", ctx.RPT.mark === false && paints.length === 1);
    ctx.rptMarkSet(false);
    t(where + ":旗標沒變就不重畫", paints.length === 1);
  }
  // 亮的兩處照舊(本機一輪對話寫出報告、雲端輪詢到新報告),只是從 #rpt-nav-new 換成旗標;不新增觸發
  t("亮:rptTurnEnd 與 rptCloudPollTick 各一處 rptMarkSet(true),條件照舊(那一邊的清單沒在眼前)", /if \(!rptListShown\("local"\)\) rptMarkSet\(true\);/.test(cutFn(src, "rptTurnEnd"))
    && /if \(!rptListShown\("cloud"\)\) rptMarkSet\(true\);/.test(cutFn(src, "rptCloudPollTick")) && (src.match(/rptMarkSet\(true\)/g) || []).length === 2 && !/rpt-nav/.test(src));
  t("結果卡〔打開報告〕的路徑仍是 rptOpen → rptShowRead", /if \(!\(await rptOpen\(\)\)\) return null;[\s\S]{0,600}rptShowRead\(it\.ref\);/.test(fs.readFileSync(path.join(R, "results.js"), "utf8")));
  t("只打開選單不清旗標:amOpen／amPaint 不碰 rptMarkSet／RPT.mark 寫入", !/rptMarkSet|RPT\.mark\s*=/.test(cutFn(app, "amOpen") + cutFn(app, "amPaint")));

  // 落點二:選單「報告」那一列的列尾(真的 amPaint 配假 DOM)
  const mk = (tag) => { const n = { tag, className: "", textContent: "", attrs: {}, children: [], title: "", setAttribute(k, v) { n.attrs[k] = v; }, append(...k) { n.children.push(...k); }, addEventListener() {} }; return n; };
  const menu = mk("div"); menu.replaceChildren = (...k) => { menu.children = k; };
  const STR = { "rpt.nav": "報告", "rpt.newMark": "有新報告", "ws.settings": "設定", "am.docs": "說明文件" };
  const run = (mark) => {
    vm.runInNewContext(cutFn(app, "amPaint") + "\namPaint();", { $: (id) => (id === "side-menu" ? menu : { hidden: true }), LANG: "zh", t: (k) => STR[k] || k, document: { createElement: mk },
      amSignedIn: () => false, amMark: () => mark, rptBag: () => ({ open: false }), libExtIcon: () => mk("svg"), acct: null, oauthPending: false, planLoginBusy: false,
      upDotNow: () => ({ on: false, key: null }) });
    return menu.children.find((b) => b.children[0] && b.children[0].textContent === "報告");
  };
  const on = run(true), off = run(false);
  const dot = on.children.find((k) => k.className === "nav-new");
  t("落點二:有新報告時「報告」那一列列尾一顆 aria-hidden 的點、那一列名稱「報告，有新報告」", !!dot && dot.attrs["aria-hidden"] === "true" && on.attrs["aria-label"] === "報告，有新報告", on.attrs);
  t("沒新報告:那一列沒有點、不另設名稱", off.children.length === 1 && !("aria-label" in off.attrs));
  t("沒登入選單三項:報告、空白、設定、說明文件(沒有 email、帳號與方案、用量、登出)", menu.children.map((k) => (k.className === "am-gap" ? "GAP" : k.children[0].textContent)).join() === "報告,GAP,設定,說明文件");
  console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
})();
