// 側欄「報告」的新報告記號(#rpt-nav-new):本機與雲端共用一個記號,哪一個視角進報告清單、或打開任何一份報告(含結果卡〔打開報告〕)都收掉。
// 0.1.7 起雲端產出也會亮記號,收的那一條卻還只限本機,雲端視角永遠收不掉。
// 跑法:node tests/check_shell_rpt_nav_mark.js(切 reports.js 原文的 rptOpen / rptShowRead 進 vm 跑,不開 Electron)
const fs = require("fs"), path = require("path"), vm = require("vm");
const src = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "reports.js"), "utf8");
let red = 0; const t = (n, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) red++; };
const cutFn = (s, name) => { const i = s.indexOf("function " + name + "("); if (i < 0) throw new Error("no " + name); let d = 0; for (let k = s.indexOf("{", i); k < s.length; k++) { if (s[k] === "{") d++; else if (s[k] === "}" && --d === 0) return s.slice(i, k + 1); } throw new Error("unbalanced " + name); };

function env(view) {
  const els = {}, el = (id) => els[id] || (els[id] = { id, hidden: false, scrollTop: 0, focus() {} });
  const bags = { local: { open: false, reading: null, scroll: 0, row: null }, cloud: { open: false, reading: null, scroll: 0, row: null } };
  const ctx = { $: el, RPT: { readSeq: 0 }, rptBag: (e) => bags[(e || view.env) === "cloud" ? "cloud" : "local"], libEnv: () => view.env,
    envShowMain() {}, rptLoad() {}, rptFocusHome() {}, libTrack() {}, rptPaint() {}, stratSelect: async () => {}, rpCloudSelect: async () => {} };
  vm.createContext(ctx);
  vm.runInContext("async " + cutFn(src, "rptOpen") + "\n" + cutFn(src, "rptShowRead"), ctx);
  return { ctx, mark: el("rpt-nav-new") };
}

(async () => {
  for (const where of ["local", "cloud"]) {
    let { ctx, mark } = env({ env: where });
    mark.hidden = false;
    const opened = await ctx.rptOpen();
    t(where + ":進報告清單 → 記號收掉", opened === true && mark.hidden === true);
    ({ ctx, mark } = env({ env: where }));
    mark.hidden = false;
    ctx.rptShowRead("r1");
    t(where + ":直接打開一份報告(rptShowRead)→ 記號收掉", mark.hidden === true);
  }
  // 結果卡〔打開報告〕走 rptOpen 再 rptShowRead(results.js resOpenReport);兩支都收,中間被 rptOpen 的守門擋下也不留記號
  t("結果卡〔打開報告〕的路徑仍是 rptOpen → rptShowRead", /if \(!\(await rptOpen\(\)\)\) return null;[\s\S]{0,600}rptShowRead\(it\.ref\);/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "results.js"), "utf8")));
  console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
})();
