// 報告頁「參數掃描」分頁(shell/renderer/report-robust.js,雲端工作頁 robust 段的移植)。
//   ① 純函式(node 直接 vm 載入):sanitizeScan 壞輸入 → null、目前參數先從策略碼的頂層常數找、
//      找不到才用 scan.current 並依 generated_at < "Generated At" 判過時、robWhere 五態、缺 nbr_mean / peak / plateau 自算。
//   ② 用隨包的 Electron 開真的 index.html,真的 renderRobust 一次:空狀態(鈕、busy 停用、送出後鎖成「已送出」)、
//      有 scan(tag、三列比較表、熱圖 R×C 格、目前參數虛線格、可 focus 的角色格、鄰域平均切換、meta 的「掃描 R×C」、
//      欄數多時把標記格捲進可視範圍);「已送出」不跨回合、本機 / 雲端不互污染(robSync 就地改鈕)。
//   ③ 主行程:loadStrategy 帶出 scan.json、listStrategies 的 mtime 把 scan.json 算進去;cloud.js 白名單留 scan。
//   單參數(spec single-param-scan-2026-10-12 §4):col_param "_" + 一格 col_vals → single;定位只讀第一個常數、文字不出現 _ / "/ 0" / N×1、
//      確認框「範圍」列與 rob.msgRescan1;二維零變化靠 tests/fixtures/shell_robust_3x3.json(改前存的 innerHTML 快照)逐字比對。
// 跑法:node tests/check_shell_robust.js(找不到 shell/node_modules 的 Electron 時 ② SKIP,①③ 照跑)
const path = require("path"), fs = require("fs"), vm = require("vm");
const SHELL = path.join(__dirname, "..", "shell");
const GATE = require("./_electron_gate");
let red = 0; const ok = (n, c) => { console.log((c ? "PASS  " : "FAIL  ") + n); if (!c) red++; };

// 3×3:尖峰 (0,0) 孤立高;(1..2, 1..2) 平原;(2,0) 沒交易
const SCAN = { row_param: "A", col_param: "B", row_vals: [10, 20, 30], col_vals: [0.5, 0.7, 0.9],
  grid: [[3.0, 0.2, 0.1], [0.3, 1.4, 1.5], [null, 1.5, 1.6]], window: 1, fee: 0.0005, start: "2025-01-01", end: "2025-06-01", generated_at: 100 };
// 單參數 6×1:第二軸 "_" 一格;尖峰 (0,0) 孤立高、平原 (3..4, 0);(5,0) 沒交易
const SINGLE = { row_param: "N", col_param: "_", row_vals: [10, 20, 30, 40, 50, 60], col_vals: [0],
  grid: [[2.0], [0.1], [0.2], [1.5], [1.6], [null]], window: 1, fee: 0.0005, start: "2025-01-01", end: "2025-06-01", generated_at: 100 };
const SNAP = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "shell_robust_3x3.json"), "utf8"));

if (!process.versions.electron) {
  // ── ① 純函式 ──
  const sb = { window: {}, console };
  vm.runInNewContext(fs.readFileSync(path.join(SHELL, "renderer", "report-robust.js"), "utf8"), sb);
  const R = sb.window.BlaveReport._rob;
  const sc = R.sanitizeScan(SCAN, null, "");
  ok("① 合法 scan(缺 nbr_mean / peak / plateau):自算 → 尖峰 (0,0)、穩健 = 鄰域平均最高 (2,2)、rd/cd 小數位 0/1", !!sc && sc.peak.i === 0 && sc.peak.j === 0 && sc.plateau.i === 2 && sc.plateau.j === 2 && sc.rd === 0 && sc.cd === 1 && sc.nbr[2][0] === null && Math.abs(sc.nbr[1][1] - (3.0 + 0.2 + 0.1 + 0.3 + 1.4 + 1.5 + 1.5 + 1.6) / 8) < 1e-9);
  ok("① scan 自帶 peak / plateau / nbr_mean:以機器端為準,不重算", (() => { const s = R.sanitizeScan({ ...SCAN, peak: { i: 1, j: 1 }, plateau: { i: 1, j: 2 }, nbr_mean: [[9, 9, 9], [9, 9, 9], [9, 9, 9]] }, null, ""); return s.peak.i === 1 && s.plateau.j === 2 && s.nbr[0][0] === 9; })());
  ok("① 索引出界的 peak / 形狀不對的 nbr_mean:退回自算,不丟例外", (() => { const s = R.sanitizeScan({ ...SCAN, peak: { i: 7, j: 0 }, nbr_mean: [[1, 2]] }, null, ""); return s.peak.i === 0 && s.nbr.length === 3; })());
  const BAD = [null, 7, "x", [], {}, { ...SCAN, row_param: "" }, { ...SCAN, col_param: "x".repeat(65) }, { ...SCAN, row_vals: [10, "20", 30] }, { ...SCAN, row_vals: [10, NaN, 30] },
    { ...SCAN, col_vals: [] }, { ...SCAN, col_vals: Array.from({ length: 41 }, (_, i) => i) }, { ...SCAN, grid: [[1, 2, 3], [1, 2, 3]] }, { ...SCAN, grid: [[1, 2], [1, 2], [1, 2]] }, { ...SCAN, grid: "no" },
    { ...SCAN, grid: [[null, null, null], [null, null, null], [null, null, null]] }];
  ok("① 壞輸入一律 null(缺 / 型別錯 / 參數名 >64 / 軸 >40 / 空軸 / 網格形狀不合 / 全格沒交易):" + BAD.length + " 種", BAD.every((b) => R.sanitizeScan(b, null, "") === null));
  ok("① 每格非有限值視為缺(NaN 經 JSON 是 null;字串也當缺)", R.sanitizeScan({ ...SCAN, grid: [[3.0, "x", 0.1], [0.3, 1.4, 1.5], [null, 1.5, 1.6]] }, null, "").grid[0][1] === null);
  ok("① 目前參數先從策略碼頂層常數找(取最後一個;行尾註解照收;縮排 / 算式不認)", (() => {
    const a = R.sanitizeScan(SCAN, null, "A = 10\nA = 20  # tuned\nB = 0.7\n"); const b = R.sanitizeScan(SCAN, null, "    A = 20\nB = 0.7 * 2\n");
    return a.cur && a.cur.i === 1 && a.cur.j === 1 && b.cur === null && R.constFromCode("A = 1e3", "A") === 1000 && R.constFromCode("A = -.5", "A") === -0.5 && R.constFromCode("A = 1", "a b") === null; })());
  ok("① 常數不在軸上 → 不在掃描範圍({i:null, vals})→ outscan", (() => { const s = R.sanitizeScan(SCAN, null, "A = 99\nB = 0.7"); return s.cur && s.cur.i === null && s.cur.vals[0] === 99 && R.robWhere(s) === "outscan"; })());
  ok("① 策略碼讀不到常數才用 scan.current;scan 早於回測(generated_at < Generated At)→ 過時、current 丟掉", (() => {
    const cur = { ...SCAN, current: { i: 0, j: 0, vals: [10, 0.5] } };
    const fresh = R.sanitizeScan(cur, { "Generated At": 50 }, ""), stale = R.sanitizeScan(cur, { "Generated At": 200 }, ""), noBt = R.sanitizeScan(cur, null, "");
    return !fresh.stale && fresh.cur.i === 0 && stale.stale && stale.cur === null && R.robWhere(stale) === "stale" && !noBt.stale && noBt.cur.i === 0; })());
  ok("① 策略碼有常數就不看時間戳(採用穩健參數重跑後 scan.current 才是舊的)", !R.sanitizeScan({ ...SCAN, current: { i: 0, j: 0 } }, { "Generated At": 200 }, "A = 30\nB = 0.9").stale);
  ok("① scan.current 出界但帶 vals → 不在掃描範圍;vals 不是兩個數 → 未知", (() => { const a = R.sanitizeScan({ ...SCAN, current: { i: null, j: null, vals: [1, 2] } }, null, ""), b = R.sanitizeScan({ ...SCAN, current: { vals: [1] } }, null, ""); return a.cur.i === null && a.cur.vals[1] === 2 && b.cur === null && R.robWhere(b) === "outscan"; })());
  const at = (i, j) => R.sanitizeScan({ ...SCAN, current: { i, j } }, null, "");
  ok("① robWhere 五態:尖峰上 / 就是穩健格 → inside / 鄰域內 → inside / 區外 / outscan", R.robWhere(at(0, 0)) === "peak" && R.robWhere(at(2, 2)) === "inside" && R.robWhere(at(1, 1)) === "inside" && R.robWhere(at(0, 2)) === "outside" && R.robWhere(R.sanitizeScan(SCAN, null, "")) === "outscan");
  ok("① 尖峰 = 穩健同格時是 inside 不是 peak(穩健格本身優先)", R.robWhere(R.sanitizeScan({ ...SCAN, peak: { i: 2, j: 2 }, current: { i: 2, j: 2 } }, null, "")) === "inside");
  ok("① window 不是正整數 / 超過每軸上限 → 1;window 2 時鄰域擴到 5×5", R.sanitizeScan({ ...SCAN, window: 0 }, null, "").w === 1 && R.sanitizeScan({ ...SCAN, window: 41 }, null, "").w === 1 && R.sanitizeScan({ ...SCAN, window: 2.5 }, null, "").w === 1 && R.sanitizeScan({ ...SCAN, window: 2 }, null, "").w === 2 && R.robWhere(R.sanitizeScan({ ...SCAN, window: 2, current: { i: 0, j: 2 } }, null, "")) === "inside");
  ok("① 格式:負號用 U+2212(科學記號的指數負號也換)、缺值 —", R.pv(-0.5, 2) === "−0.50" && R.pv(1e-7, 2) === "1e−7" && R.f2(null) === "—" && R.f2(-0.001) === "0.00" && R.f2(1.234) === "1.23");
  ok("① 送出簽章只看 scan / code / Generated At(整份 stats 每根 K 都會變)", R.sentSig({ scan: SCAN, code: "x", stats: { "Generated At": 1, "Sharpe Ratio": 2 } }) === R.sentSig({ scan: SCAN, code: "x", stats: { "Generated At": 1, "Sharpe Ratio": 3 } }) && R.sentSig({ scan: SCAN, code: "x", stats: null }) !== R.sentSig({ scan: SCAN, code: "y", stats: null }));

  // ── ① 過時判定第 1 層(spec-0.1.12-scan-stale §2 / §6):掃描自己的 start / end / fee 對現在的回測;web 工作頁同一套 ──
  const BT = { start: "2025-01-01", end: "2025-06-01", "fee [%]": 0.05 }, CODE = "A = 10\nB = 0.5\n";
  const judge = (st, scan, code) => R.sanitizeScan(scan || SCAN, st, code === undefined ? CODE : code);
  const fresh = (st, scan, code) => { const s = judge(st, scan, code); return !s.stale && !s.changed.period && !s.changed.fee; };
  const staleBy = (st, what, scan) => { const s = judge(st, scan); return s.stale && s.cur === null && R.robWhere(s) === "stale" && s.changed.period === (what === "period") && s.changed.fee === (what === "fee"); };
  const endPlus = (d) => new Date(Date.parse("2025-06-01T00:00:00Z") + d * 86400000).toISOString().slice(0, 10);
  ok("① 期間、手續費都跟掃描當下一樣 → 不過時,目前參數照常定位(0,0)", fresh(BT) && judge(BT).cur.i === 0 && judge(BT).cur.j === 0);
  ok("① 只改起日 → 過時(只點名期間);cur 一律 null(常數讀得到也一樣)、robWhere = stale", staleBy({ ...BT, start: "2024-01-01" }, "period"));
  ok("① 只改手續費 → 過時(只點名手續費)", staleBy({ ...BT, "fee [%]": 0.1 }, "fee"));
  ok("① 訖日往後延 29 天、剛好 30 天 → 不過時(不超過 " + R.ROB_END_GRACE_DAYS + " 天,同 web robChanged)", R.ROB_END_GRACE_DAYS === 30 && fresh({ ...BT, end: endPlus(29) }) && fresh({ ...BT, end: endPlus(30) }));
  ok("① 訖日往後延 31 天 → 過時(期間)", staleBy({ ...BT, end: endPlus(31) }, "period"));
  // 訖日往前縮:只有回測比掃描新(Generated At > generated_at;SCAN 的 generated_at = 100)才算變;掃描較新 = 掃描抓到較新的 K 線
  ok("① 訖日往前縮 1 天、回測在掃描之後重跑(Generated At 101 > 100)→ 過時(期間)", staleBy({ ...BT, end: endPlus(-1), "Generated At": 101 }, "period"));
  ok("① 訖日往前縮 1 天、掃描比回測新(Generated At 99 < 100)或同一秒(100)→ 不過時", fresh({ ...BT, end: endPlus(-1), "Generated At": 99 }) && fresh({ ...BT, end: endPlus(-1), "Generated At": 100 }));
  ok("① 訖日往前縮、缺任一個時間戳(回測沒 Generated At / 掃描沒 generated_at / 型別不對)→ 這一條不判",
    fresh({ ...BT, end: endPlus(-40) }) && fresh({ ...BT, end: endPlus(-40), "Generated At": 500 }, { ...SCAN, generated_at: undefined }) && fresh({ ...BT, end: endPlus(-40), "Generated At": "500" }));
  ok("① 時間戳只管訖日往前縮:掃描較新時,起日不同 / 手續費不同 / 訖日晚超過 30 天照樣過時",
    staleBy({ ...BT, start: "2024-01-01", "Generated At": 50 }, "period") && staleBy({ ...BT, "fee [%]": 0.1, "Generated At": 50 }, "fee") && staleBy({ ...BT, end: endPlus(31), "Generated At": 50 }, "period"));
  ok("① 只改兩個掃描常數(把參數改成穩健值)→ 不過時,「目前」重新定位到 (2,2)", (() => { const s = judge(BT, null, "A = 30\nB = 0.9\n"); return !s.stale && s.cur.i === 2 && s.cur.j === 2 && R.robWhere(s) === "inside"; })());
  ok("① 回測的日期帶時間(取前 10 字)→ 同一天不算變", fresh({ ...BT, start: "2025-01-01 00:00:00", end: "2025-06-01T08:00:00" }));
  ok("① 舊 Type C 只有小數 fee:0.0005 = 0.05% 不算變、0.001 算變", fresh({ start: BT.start, end: BT.end, fee: 0.0005 }) && staleBy({ start: BT.start, end: BT.end, fee: 0.001 }, "fee"));
  ok("① 舊檔缺 start:起日不判(回測起日不同也不算變)、meta 不畫期間那一組(ctx.start null);訖日照判",
    (() => { const sc = { ...SCAN, start: undefined }, s = judge({ ...BT, start: "2015-01-01" }, sc); return !s.stale && s.ctx.start === null && s.ctx.end === "2025-06-01"; })() && staleBy({ ...BT, end: endPlus(40) }, "period", { ...SCAN, start: undefined }));
  ok("① 任一邊缺費率 / 日期格式不對 / 沒回測 → 那一項不判(未知 ≠ 變了)", fresh({ start: BT.start, end: BT.end }) && fresh(BT, { ...SCAN, fee: "0.0005" }) && fresh(BT, { ...SCAN, fee: -1 })
    && fresh({ ...BT, start: "20150101" }) && fresh({ ...BT, end: "x".repeat(40) }) && fresh(null) && judge(BT, { ...SCAN, fee: "0.0005" }).ctx.fee === null);
  ok("① 舊規則還在:讀不到常數、scan 早於回測 → 過時,但沒有點名項(staleParts 空 → 用 rob.verdict.stale)",
    (() => { const s = judge({ ...BT, "Generated At": 200 }, null, ""); return s.stale && s.cur === null && R.staleParts(s).length === 0; })());
  ok("① 過時句的項:依「期間 → 手續費」排,值是現在回測的(日期取前 10 字、費率至少兩位)",
    (() => { const p = R.staleParts(judge({ start: "2015-01-01 00:00", end: "2026-10-01", "fee [%]": 0.01 })); return p.length === 2 && p[0].key === "rob.stale.period" && p[0].vars.start === "2015-01-01" && p[0].vars.end === "2026-10-01" && p[1].key === "rob.stale.fee" && p[1].vars.fee === "0.01"; })());
  ok("① 費率顯示:至少兩位、最多四位,兩位以內跟回測 meta 一樣", R.feeTxt(0.05) === "0.05" && R.feeTxt(0.1) === "0.10" && R.feeTxt(0.045) === "0.045" && R.feeTxt(0.0123) === "0.0123" && R.feeTxt(0) === "0.00" && R.feeTxt(null) === "—");
  ok("① 重新掃描帶的網格:兩軸名稱、頭尾值(照軸的小數位)、格數;scanInfo 帶現在回測的期間 / 費率",
    (() => { const s = judge(BT), g = R.gridInfo(s), i = R.scanInfo(BT, s), e = R.scanInfo(BT, null);
      return JSON.stringify(g) === JSON.stringify({ single: false, rp: "A", r0: "10", r1: "30", cp: "B", c0: "0.5", c1: "0.9", R: "3", C: "3", raw: { rp: "A", r0: "10", r1: "30", cp: "B", c0: "0.5", c1: "0.9" } }) && i.rescan && !i.stale && i.now.fee === "0.05" && i.now.start === "2025-01-01" && i.grid.rp === "A"
        && !e.rescan && e.grid === null && e.now.end === "2025-06-01"; })());
  ok("① 網格值:軸遞減、帶負數 → 顯示(pv)與訊息(raw)都是最小到最大;顯示用 U+2212 補位數,訊息用原值、ASCII 負號(同 web robAskRescan)",
    (() => { const g = R.gridInfo(R.sanitizeScan({ ...SCAN, row_vals: [-1, -2.5, -3], col_vals: [0.9, 0.7, 0.5] }, BT, ""));
      return g.r0 === "−3.0" && g.r1 === "−1.0" && g.c0 === "0.5" && g.c1 === "0.9" && g.raw.r0 === "-3" && g.raw.r1 === "-1" && g.raw.c0 === "0.5" && g.raw.c1 === "0.9" && !/\u2212/.test(JSON.stringify(g.raw)); })());
  ok("① 聊天結果卡(scanTag):期間變了一樣是過時 → tag null、只剩格數", (() => { const tg = sb.window.BlaveReport.scanTag({ scan: SCAN, stats: { ...BT, start: "2020-01-01" }, code: CODE }), f = sb.window.BlaveReport.scanTag({ scan: SCAN, stats: BT, code: CODE }); return tg.tag === null && tg.rows === 3 && f.tag === "rob.tag.peak"; })());

  // ── ① 單參數(col_param "_" + 一格 col_vals;同 report-wf.js 的 single)──
  {
    const one = R.sanitizeScan(SINGLE, BT, "N = 10\n");
    ok("① 單參數:single、尖峰 (0,0)、穩健 (4,0)(鄰域 = 相鄰三格)、目前參數只讀第一個常數 → (0,0)、j 恆 0", one && one.single === true && one.peak.i === 0 && one.peak.j === 0 && one.plateau.i === 4 && one.plateau.j === 0 && one.cur.i === 0 && one.cur.j === 0 && R.robWhere(one) === "peak"
      && R.robWhere(R.sanitizeScan(SINGLE, BT, "N = 40\n")) === "inside" && R.robWhere(R.sanitizeScan(SINGLE, BT, "N = 20\n")) === "outside");
    ok("① 單參數:策略碼沒有第二個常數也不走 scan.current / 時間戳那條(回測重跑標記不消失)", !R.sanitizeScan({ ...SINGLE, current: { i: 0, j: 0 } }, { ...BT, "Generated At": 200 }, "N = 40\n").stale && R.sanitizeScan(SINGLE, { ...BT, "Generated At": 200 }, "N = 40\n").cur.i === 3);
    ok("① 單參數:常數不在軸上 → outscan,vals = [值, 0];讀不到常數 → scan.current(兩個數)照用", (() => { const a = R.sanitizeScan(SINGLE, BT, "N = 99\n"), b = R.sanitizeScan({ ...SINGLE, current: { i: null, j: null, vals: [21, 0] } }, BT, ""); return a.cur.i === null && a.cur.vals[0] === 99 && a.cur.vals[1] === 0 && R.robWhere(a) === "outscan" && b.cur.vals[0] === 21; })());
    ok("① 不是單參數:第二軸是真常數只有一格(B / [0.5])→ 照二維;\"_\" 配兩格也不算", R.sanitizeScan({ ...SINGLE, col_param: "B", col_vals: [0.5] }, BT, "N = 20\n").single === false && R.sanitizeScan({ ...SINGLE, col_param: "B", col_vals: [0.5] }, BT, "N = 20\n").cur === null
      && R.sanitizeScan({ ...SINGLE, col_vals: [0, 1], grid: SINGLE.grid.map((r) => [r[0], r[0]]) }, BT, "N = 20\n").single === false);
    ok("① 單參數 gridInfo:只有 rp / r0 / r1 / R(沒有第二軸、沒有 \"_\");scanInfo.grid 同", JSON.stringify(R.gridInfo(one)) === JSON.stringify({ single: true, rp: "N", r0: "10", r1: "60", R: "6", raw: { rp: "N", r0: "10", r1: "60" } }) && R.scanInfo(BT, one).grid.single === true && !/_/.test(JSON.stringify(R.gridInfo(one))));
    ok("① 單參數 scanTag:single、tag 在穩健格上是 atPlateau1", (() => { const a = sb.window.BlaveReport.scanTag({ scan: SINGLE, stats: BT, code: "N = 50" }), b = sb.window.BlaveReport.scanTag({ scan: SINGLE, stats: BT, code: "N = 10" }), c = sb.window.BlaveReport.scanTag({ scan: SCAN, stats: BT, code: CODE }); return a.single === true && a.tag === "rob.tag.atPlateau1" && a.rows === 6 && a.cols === 1 && b.tag === "rob.tag.peak" && c.single === false; })());
  }
  {
    // 組句用真的 strings.js + i18n.js 的 t()(同 check_shell_wf.js B5 的載法)
    const ictx = { console };
    vm.createContext(ictx);
    vm.runInContext(fs.readFileSync(path.join(SHELL, "renderer", "strings.js"), "utf8").replace(/^const STRINGS/m, "var STRINGS") + "\n" + fs.readFileSync(path.join(SHELL, "renderer", "i18n.js"), "utf8").replace(/^let LANG/m, "var LANG"), ictx);
    const tt = (l) => (k, v) => { ictx.LANG = l; return ictx.t(k, v); };
    const both = R.staleParts(judge({ ...BT, start: "2015-01-01", "fee [%]": 0.01 })), feeOnly = R.staleParts(judge({ ...BT, "fee [%]": 0.01 }));
    const fill = (s) => s.tpl.replace(/\{(\w+)\}/g, (_, k) => s.vars[k]);
    ok("① 過時句 zh:兩項用「、」串、接「，下面是改之前的掃描結果。」(不寫「重新掃描後才會更新」)",
      fill(R.staleTpl(both, tt("zh"))) === "回測期間已改成 2015-01-01 → 2025-06-01、手續費已改成 0.01%，下面是改之前的掃描結果。" && fill(R.staleTpl(feeOnly, tt("zh"))) === "手續費已改成 0.01%，下面是改之前的掃描結果。");
    ok("① 過時句 en:句首大寫、兩項用「, 」串、接「 — below is the scan from before the change.」",
      fill(R.staleTpl(both, tt("en"))) === "The backtest period is now 2015-01-01 → 2025-06-01, the fee is now 0.01% — below is the scan from before the change." && fill(R.staleTpl(feeOnly, tt("en"))) === "The fee is now 0.01% — below is the scan from before the change.");
  }

  // ── ③ 主行程 / cloud.js ──
  const main = fs.readFileSync(path.join(SHELL, "main.js"), "utf8"), fn = (n) => main.slice(main.indexOf("function " + n + "("), main.indexOf("\n}\n", main.indexOf("function " + n + "(")));
  ok("③ loadStrategy 讀 strategies/<name>/scan.json(readResultJson:一般檔、≤2MB、不是物件 → null);回傳帶 scan", /readResultJson\(path\.join\(dir, "scan\.json"\)\)/.test(fn("loadStrategy")) && /return \{ name, stats, scan, wf, code,/.test(fn("loadStrategy")));
  ok("③ listStrategies 的 mtime 把 scan.json 算進去(只掃描沒回測的那一輪結束後 stratRefresh(true) 才會重載)", /scMtime = fs\.statSync\(path\.join\(dir, "scan\.json"\)\)\.mtimeMs/.test(fn("listStrategies")) && /Math\.max\(mtime, sMtime, scMtime, wfMtime\)/.test(fn("listStrategies")) && (fn("listStrategies").match(/mtime: touched/g) || []).length === 2);
  const { interpretStrategy } = require(path.join(SHELL, "cloud.js"));
  const body = (s) => ({ status: 200, body: { strategy: { name: "m", code: "", ...s } } });
  ok("③ cloud.js interpretStrategy 留 scan(物件才給,否則 null)", interpretStrategy(body({ scan: SCAN }), "m").strategy.scan.row_param === "A" && interpretStrategy(body({ scan: [1] }), "m").strategy.scan === null && interpretStrategy(body({}), "m").strategy.scan === null);
  const app = fs.readFileSync(path.join(SHELL, "renderer", "app.js"), "utf8"), html = fs.readFileSync(path.join(SHELL, "renderer", "index.html"), "utf8");
  ok("③ app.js:rpShowTab / rpBodyPaint 的分頁清單含 rob,rob 交給 renderRobust(t / busy / onScan / buildMeta 都從外面交進去);index.html 有分頁鈕、面板、css、js", (app.match(/\["bt", "tr", "rob", "wf", "xt", "code"\]/g) || []).length === 2
    && /R\.renderRobust\(\$\("rp-rob"\), \{ stats: B\.data\.stats, scan: B\.data\.scan \|\| null, code: B\.data\.code, name: B\.name \}, rpRobOpts\(\)\)/.test(app)
    && /return \{ t, busy: csAnyTurn\(\), turn: turnSeq, scope: rpBag\(\) === RPC \? "cloud" : "local", onScan: rpRobAsk, busyFix: \(el\) => busyFixLink\(el, "stop"\), buildMeta: R\.buildMeta, resync: rpRobSync, refocus: rpRobRefocus \};/.test(app)
    && /data-tab="rob" data-i18n="rp\.tab\.rob"/.test(html) && /id="rp-rob" role="tabpanel" hidden/.test(html) && /report-robust\.css/.test(html) && /<script src="report-robust\.js"><\/script>\s*(?:<script src="(?:report-wf|report-xt|md|report-blocks|reports|report-share|report-sharelist|report-pdf|newstrategy)\.js"><\/script>\s*)*<script src="trade\.js">/.test(html));
  ok("③ app.js:掃描鈕走確認框 → csSendAway(從別處送一句話;不覆寫 viewing:chatViewing 在雲端視角本來就回 env:cloud + strategy)、resolve 回合序號;回合開始 / 結束三處都叫 turnUiSync(裡面 rpRobSync 就地改鈕,不重畫);每輪 turnSeq++",
    /onOk: \(\) => \{ if \(typeof begin === "function"\) begin\(\); csSendAway\(msg\)\.then\(\(ok\) => \{ if \(ok\) trackFeature\("scan_requested"\); resolve\(ok \? turnSeq : false\); \}\); \}/.test(app) && !/viewing/.test(app.slice(app.indexOf("function rpRobAsk"), app.indexOf("function rpRobSync"))) && (app.match(/turnUiSync\(\)/g) || []).length >= 3 && /rpRobSync\(\); rpWfSync\(\);/.test(fs.readFileSync(path.join(SHELL, "renderer", "chattabs.js"), "utf8"))
    && /R\.robSync\(\$\("rp-rob"\), rpRobOpts\(\)\)/.test(app) && /UPD\.turnCloud = false; turnSeq\+\+;/.test(app));
  ok("③ app.js onTurnEnd:碰過雲端的回合結束 → 雲端那支的報告背景重抓(rpCloudSelect force),而且在 upTurnEnded 歸零 UPD.turnCloud 之前先記下", (() => { const s = app.slice(app.indexOf("function turnEndPre("), app.indexOf("/* 側欄 / 聊天欄")); return /const cloudTurn = UPD\.turnCloud;/.test(s) && s.indexOf("const cloudTurn = UPD.turnCloud;") < s.indexOf("upTurnEnded(faulted);") && /if \(cloudTurn && RPC\.name\) rpCloudSelect\(RPC\.name, true\);/.test(s) && s.indexOf("turnUiSync();") < s.indexOf("rpCloudSelect(RPC.name, true)"); })());
  {
    // 確認框與訊息:rpRobAsk 從 app.js 原文切出來,配真的 strings.js / i18n.js 與一個只夠用的假 DOM(不開視窗)
    const node = (tag) => ({ tag, className: "", kids: [], _t: null,
      get textContent() { return this._t !== null ? this._t : this.kids.map((k) => k.textContent).join(""); }, set textContent(v) { this._t = String(v); this.kids = []; },
      appendChild(c) { if (c.tag === "#frag") c.kids.forEach((k) => this.kids.push(k)); else this.kids.push(c); this._t = null; return c; }, append(...cs) { cs.forEach((c) => this.appendChild(c)); },
      get firstChild() { return this.kids[0] || null; } });
    const actx = { console, document: { createElement: node, createDocumentFragment: () => node("#frag"), createTextNode: (s) => ({ tag: "#text", textContent: String(s) }) },
      RPC: {}, rpBag: () => ({}), turnSeq: 5, calls: [], sent: [], feats: [] };
    actx.confirmBox = (o) => actx.calls.push(o); actx.submitMessage = (m) => { actx.sent.push(m); return Promise.resolve(true); }; actx.csSendAway = actx.submitMessage; actx.trackFeature = (n) => actx.feats.push(n);
    vm.createContext(actx);
    const fnSrc = (nm) => { const i = app.indexOf("function " + nm + "("); return app.slice(i, app.indexOf("\n}\n", i) + 2); };
    vm.runInContext(fs.readFileSync(path.join(SHELL, "renderer", "strings.js"), "utf8").replace(/^const STRINGS/m, "var STRINGS") + "\n" + fs.readFileSync(path.join(SHELL, "renderer", "i18n.js"), "utf8").replace(/^let LANG/m, "var LANG")
      + "\n" + fnSrc("rpRobAsk") + "\n" + app.slice(app.indexOf("const FIXED_PROMPTS"), app.indexOf("const RECEIPT_RE")).replace("const FIXED_PROMPTS", "var FIXED_PROMPTS"), actx);
    const T = (k, v) => vm.runInContext("t(" + JSON.stringify(k) + ", " + JSON.stringify(v || {}) + ")", actx);
    const sc = R.sanitizeScan(SCAN, { ...BT, start: "2015-01-01" }, CODE), info = R.scanInfo({ ...BT, start: "2015-01-01" }, sc);
    const rowsOf = (o) => { const dl = o.extra.kids.find((k) => k.tag === "dl"); return dl ? dl.kids.map((r) => [r.kids[0].textContent, r.kids[1].textContent, r.kids[1].kids[0].className || r.kids[1].kids[0].kids.filter((k) => k.className === "mono").length]) : []; };
    for (const L of ["zh", "en"]) {
      actx.LANG = L; actx.calls.length = 0; actx.sent.length = 0;
      actx.rpRobAsk("s1", null, () => {}, info);
      const o = actx.calls[0], rows = rowsOf(o), note = o.extra.kids.find((k) => k.className === "cf-note");
      o.onOk();   // 只比送出的訊息本身(trackFeature 在 submitMessage 的微任務裡)
      const want = T("rob.msgRescan", { name: "s1", start: "2015-01-01", end: "2025-06-01", fee: "0.05", rp: "A", r0: "10", r1: "30", cp: "B", c0: "0.5", c1: "0.9" });
      ok("③ (" + L + ") 重新掃描確認框:標題「" + T("rob.btnRescan") + "」、lead、期間 / 手續費 / 網格三列(值包 .mono,dl 是 cf-rows kv)、cf-note;送出的訊息寫明期間、費率與上次兩軸",
        o.title === T("rob.btnRescan") && o.lines.length === 1 && o.lines[0] === T("rob.cfLead") && o.ok === T("rob.cfOk") && o.extra.kids[0].className === "cf-rows kv"
        && JSON.stringify(rows) === JSON.stringify([[T("rob.cfPeriod"), "2015-01-01 → 2025-06-01", "mono"], [T("rob.cfFee"), "0.05%", "mono"], [T("rob.cfGrid"), T("rob.cfGridVal", { rp: "A", r0: "10", r1: "30", cp: "B", c0: "0.5", c1: "0.9", R: "3", C: "3" }), 8]])
        && note && note.textContent === T("rob.cfNote") && actx.sent[0] === want && /2015-01-01/.test(want) && /0\.05%/.test(want) && /A/.test(want), JSON.stringify(rows));
      actx.calls.length = 0; actx.sent.length = 0;
      actx.rpRobAsk("s1", null, () => {}, R.scanInfo(BT, R.sanitizeScan({ ...SCAN, row_vals: [-1, -2.5, -3] }, BT, "")));
      { const o2 = actx.calls[0]; o2.onOk(); const gridTxt = rowsOf(o2)[2][1];
        ok("③ (" + L + ") 負數遞減軸:確認框的網格列顯示 −3.0–−1.0(pv),送給 agent 的訊息寫 A(-3–-1)原值、ASCII 負號、小的在前",
          gridTxt.indexOf("A −3.0–−1.0") === 0 && actx.sent[0] === T("rob.msgRescan", { name: "s1", start: "2025-01-01", end: "2025-06-01", fee: "0.05", rp: "A", r0: "-3", r1: "-1", cp: "B", c0: "0.5", c1: "0.9" }) && !/\u2212/.test(actx.sent[0]), gridTxt + " | " + actx.sent[0]); }
      const fm = vm.runInContext("fixedMatch", actx)(want, vm.runInContext("STRINGS", actx));
      ok("③ (" + L + ") 重新掃描的訊息在對話裡顯示成一行摘要(FIXED_PROMPTS 認得,名稱抓對)", fm && fm.label === "rob.msgRescanLabel" && fm.title === "rob.msgScanTitle" && fm.vars.name === "s1" && fm.vars.r1 === "30");
      actx.calls.length = 0; actx.sent.length = 0;
      actx.rpRobAsk("s1", null, () => {}, R.scanInfo(BT, null));
      const e = actx.calls[0]; e.onOk();
      ok("③ (" + L + ") 空狀態「開始掃描」確認框:emptyCap + 期間 / 手續費兩列、沒有網格與 cf-note;訊息仍是 rob.msgScan 原句(觸發句不動)",
        e.title === T("rob.btnScan") && e.lines[0] === T("rob.emptyCap") && JSON.stringify(rowsOf(e)) === JSON.stringify([[T("rob.cfPeriod"), "2025-01-01 → 2025-06-01", "mono"], [T("rob.cfFee"), "0.05%", "mono"]])
        && !e.extra.kids.some((k) => k.className === "cf-note") && actx.sent[0] === T("rob.msgScan", { name: "s1" }));
      actx.calls.length = 0; actx.sent.length = 0;
      actx.rpRobAsk("s1", null, () => {}, R.scanInfo(BT, R.sanitizeScan(SINGLE, BT, "N = 20\n")));
      { const o1 = actx.calls[0]; o1.onOk(); const rows1 = rowsOf(o1), want1 = T("rob.msgRescan1", { name: "s1", start: "2025-01-01", end: "2025-06-01", fee: "0.05", rp: "N", r0: "10", r1: "60" });
        const fm1 = vm.runInContext("fixedMatch", actx)(want1, vm.runInContext("STRINGS", actx));
        ok("③ (" + L + ") 單參數重新掃描:lead 換 cfLead1、第三列是「範圍」N 10–60(6 格)、cf-note 照舊;送 rob.msgRescan1(二維句不動)、句裡沒有 _（ / 0–0;對話摘要認得(label 沿用)",
          o1.lines[0] === T("rob.cfLead1") && JSON.stringify(rows1[2]) === JSON.stringify([T("rob.cfRange"), T("rob.cfRangeVal", { rp: "N", r0: "10", r1: "60", R: "6" }), 4]) && rows1.length === 3 && o1.extra.kids.some((k) => k.className === "cf-note")
          && actx.sent[0] === want1 && want1 !== T("rob.msgRescan", { name: "s1" }) && !/_（|_ \(|0–0|\{/.test(want1) && /N/.test(want1) && fm1 && fm1.label === "rob.msgRescanLabel" && fm1.title === "rob.msgScanTitle" && fm1.vars.name === "s1" && fm1.vars.r1 === "60", JSON.stringify(rows1) + " | " + actx.sent[0]); }
      actx.calls.length = 0;
      actx.rpRobAsk("s1", null, () => {}, { rescan: false, now: { start: null, end: null, fee: null }, grid: null });
      ok("③ (" + L + ") 回測讀不到期間 / 費率:那兩列不畫(不寫「—」)、也不放空的 dl", actx.calls[0].extra.kids.length === 0);
    }
  }
  {
    // 寫入端合約(過時判定拿 scan.json 的 start / end 跟回測的 stats.json 比):lib.md 要釘住「傳回測自己記的那組」,
    // 尤其 Type C 的 stats start 是 WARMUP 之後第一根、不是 s.START——傳錯的話每份掃描一產出就是過時
    const lm = fs.readFileSync(path.join(__dirname, "..", "references", "lib.md"), "utf8");
    const ws = lm.split("\n").find((l) => l.includes("- `write_scan(grid, row_vals, col_vals")) || "";
    const runner = fs.readFileSync(path.join(__dirname, "..", "lib", "runner.py"), "utf8");
    ok("③ lib.md 的 write_scan:start / end 傳回測 stats.json 記的那組;Type A = s.START;Type C 是 WARMUP 之後第一根(不是 s.START);資料比回測新建議切到回測的 end(只是建議:掃描較新時訖日較晚不判過時);Rescan 觸發句有寫怎麼做",
      /`start` \/ `end` = \*\*the backtest's own range, as recorded in `strategies\/<name>\/stats\.json`/.test(ws) && /Type A: stats `start` is `s\.START` verbatim/.test(ws)
      && /Type C: stats `start` is the first bar the runner keeps after `WARMUP` \(`price_df\.iloc\[WARMUP:\]`\), \*\*not\*\* `s\.START`/.test(ws) && /Recommended: scan the same bars the backtest saw[^;]*df = df\.loc\[:end\]/.test(ws) && /fresher bars are not flagged/.test(ws)
      && /- \*\*Rescan\*\* — zh「請重新掃描策略 \{name\} 的參數/.test(lm) && /four fixed prompts/.test(lm), ws.slice(0, 200));
    ok("③ 上面那句跟 runner 對得上:Type A stats start = config START、Type C = WARMUP 裁掉之後 close_df 的第一根",
      /'start': config\.get\('START'\), 'end': df\.index\[-1\]/.test(runner) && /price_df += price_df\.iloc\[warmup:\]/.test(runner) && /'start': close_df\.index\[0\]\.strftime\('%Y-%m-%d'\)/.test(runner));
  }
  const css = fs.readFileSync(path.join(SHELL, "renderer", "report-robust.css"), "utf8"), tok = fs.readFileSync(path.join(SHELL, "renderer", "tokens.css"), "utf8");
  ok("③ 設計稽核:圖例色塊不叫 .sw(撞 app.css 的開關);風險 tag 用 tokens 的 redLight / redBlack(亮暗各一組);比較表 overflow-x:auto;glyph 貼左上角(置中會壓到數字,設計師複核 09-25);空狀態那一句 13px",
    !/\.rob-legend \.sw\b/.test(css) && /\.rob-legend \.rob-sw \{/.test(css) && /\.rob-tag\.is-risk \{\s*background: var\(--color-redLight\);\s*color: var\(--color-redBlack\);/.test(css)
    && (tok.match(/--color-redLight:/g) || []).length === 2 && (tok.match(/--color-redBlack:/g) || []).length === 2 && /\.rob-cmp \{[^}]*overflow-x: auto;/.test(css)
    && /\.rob-tbl td \.rob-glyph \{[^}]*position: absolute;\s*left: 4px;\s*top: 2px;/.test(css) && /\.rob-empty-txt \{[^}]*font-size: 13px;[^}]*color: var\(--ink-3\);/.test(css) && !/\.rob-tipwrap/.test(css));

  // ── ② 交給 Electron ──
  const bin = GATE.bin(SHELL, "②");
  if (!bin) { console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0); }
  const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit" });
  const sub = r.status == null ? 1 : r.status;
  console.log(red || sub ? `\n${red + sub} 紅` : "\nALL PASS");
  process.exit(red || sub ? 1 : 0);
}

const { app, BrowserWindow } = require("electron");
const os = require("os");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "blave-robust-")));
const STUB = `window.blave = new Proxy({}, { get: (_, k) => typeof k !== "string" ? undefined
  : k.startsWith("on") ? () => {} : k === "tradeLabels" ? () => {}
  : async () => ({ getLocale: "zh-TW", loadConnection: { kind: "claude" }, detectAgents: { claude: { installed: true, loggedIn: true }, codex: { installed: false } },
      listStrategies: [], listSessions: [], loadSession: [], loadSessionImages: [], updateState: { phase: "idle", current: "0.0.0" } })[k] });`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log("FAIL  ② 逾時(60 秒)"); process.exit(1); }, 60000).unref();

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  const pre = path.join(app.getPath("userData"), "stub.js"); fs.writeFileSync(pre, STUB);
  const w = new BrowserWindow({ width: 1280, height: 820, show: false, webPreferences: { offscreen: true, preload: pre, contextIsolation: false, sandbox: false } });
  await w.loadFile(path.join(SHELL, "renderer", "index.html"));
  await wait(1000);
  const js = (s) => w.webContents.executeJavaScript(s, true);
  const STATS = { symbol: "BTCUSDT", interval: "1h", start: "2025-01-01", end: "2025-06-01", "fee [%]": 0.05, "Generated At": 50 };
  // 一次畫進 #rp-rob 的複本(同 CSS 環境);opts 由測試自己給:t 用畫面上那顆、onScan 記下呼叫並回 true
  await js(`window.__calls = []; window.__turn = 1; window.__box = document.createElement("div"); document.body.appendChild(window.__box);
    window.__opts = (busy, turn, scope) => ({ t, busy, turn: turn == null ? window.__turn : turn, scope: scope || "local", buildMeta: window.BlaveReport.buildMeta, onScan: (name, opener, begin, info) => { window.__calls.push([name, opener && opener.tagName]); window.__info = info; return new Promise((r) => setTimeout(() => r(window.__turn), 5)); } });   // 同 app:resolve 時才知道跑起來的是哪一輪
    window.__render = (data, busy, turn, scope) => window.BlaveReport.renderRobust(window.__box, data, window.__opts(busy, turn, scope));
    window.__sync = (busy, turn, scope) => window.BlaveReport.robSync(window.__box, window.__opts(busy, turn, scope)); 0;`);

  // 空狀態
  await js(`window.__lk = (x) => x.disabled || x.getAttribute("aria-disabled") === "true"; 0`);   // 回合中的鎖是 aria-disabled(busy-lock spec §8),其他原因照舊原生 disabled:兩種都算鎖住
  let r = await js(`(() => { window.__render({ stats: ${JSON.stringify(STATS)}, scan: null, code: "", name: "s1" }, false);
    const b = window.__box.querySelector(".rob-empty button.btn-fill"), p = window.__box.querySelector(".rob-empty .rob-empty-txt"); return { has: !!b, dis: b && window.__lk(b), txt: b && b.textContent, line: p && p.textContent, before: p && p.nextElementSibling === b, cap: !!window.__box.querySelector(".rob-cap"), heat: !!window.__box.querySelector(".rob-tbl") }; })()`);
  ok("② 沒有 scan:空狀態 = 一句「還沒掃過參數。」+ 一顆「開始掃描」填色鈕(句在鈕前)、可按、沒有熱圖", r.has && !r.dis && r.txt === (await js(`t("rob.btnScan")`)) && r.line === (await js(`t("rob.empty")`)) && r.before && !r.cap && !r.heat);
  r = await js(`(() => { window.__render({ stats: ${JSON.stringify(STATS)}, scan: null, code: "", name: "s1" }, true);
    const b = window.__box.querySelector(".rob-empty button.btn-fill"); return { dis: window.__lk(b), native: b.disabled, aria: b.getAttribute("aria-disabled"), txt: b.textContent, cap: (window.__box.querySelector(".rob-cap") || {}).textContent }; })()`);
  ok("② 回合進行中:鈕鎖住(aria-disabled,不是原生 disabled:鍵盤停得上去)+ 一行常駐原因;文字仍是「開始掃描」", r.dis && !r.native && r.aria === "true" && r.txt === (await js(`t("rob.btnScan")`)) && r.cap === (await js(`t("rob.busy")`)));
  // 〔停止〕:同 app.js rpRobOpts 交真的 busyFixLink;回合中實點 → 真的 stopTurn 走下去(轉成停止中)、記 lock_fix;點被鎖的鈕本身不送
  r = await js(`(() => { const tr = []; const tf = window.trackFeature; window.trackFeature = (n) => tr.push(n);
    running = true; turnStopping = false; window.__calls = [];
    window.BlaveReport.renderRobust(window.__box, { stats: ${JSON.stringify(STATS)}, scan: null, code: "", name: "s1" }, { ...window.__opts(true), busyFix: (el) => busyFixLink(el, "stop") });
    const b = window.__box.querySelector(".rob-empty button.btn-fill"); b.click();
    const cap = window.__box.querySelector(".rob-cap"), fix = cap && cap.querySelector("button.busy-fix");
    const o = { sent: window.__calls.length, txt: cap && cap.textContent, role: cap && cap.getAttribute("role"), fix: fix && fix.textContent };
    if (fix) fix.click();
    o.stopping = turnStopping; o.tr = tr.slice(); running = false; window.trackFeature = tf; return o; })()`);
  ok("② 〔停止〕實點:原因句「…送出。 停止」、role=status;點被鎖的鈕不送;點〔停止〕→ 回合轉停止中、記 lock_fix",
    r.sent === 0 && r.txt === (await js(`t("rob.busy") + " " + t("busy.fix.stop")`)) && r.role === "status" && r.fix === (await js(`t("busy.fix.stop")`)) && r.stopping === true && r.tr.includes("lock_fix"), JSON.stringify(r));
  await wait(50); await js(`turnStopping = false; turnStopped = false; 0`);
  r = await js(`(async () => { window.__render({ stats: ${JSON.stringify(STATS)}, scan: null, code: "", name: "s1" }, false);
    const b0 = window.__box.querySelector(".rob-empty button"); b0.focus(); b0.click();
    window.__turn = 7; window.__sync(true);   // 送出 → app 那邊回合開始:busy + 新序號(promise 還沒回來)
    const mid = { dis: window.__lk(b0), txt: b0.textContent, cap: !!window.__box.querySelector(".rob-cap") };
    await new Promise((r) => setTimeout(r, 30));
    const b = window.__box.querySelector(".rob-empty button.btn-fill");
    return { calls: window.__calls, mid, same: b === b0, dis: window.__lk(b), txt: b.textContent, cap: !!window.__box.querySelector(".rob-cap") }; })()`);
  // 焦點:Chromium 把 focus 中的鈕設成 disabled 就會自己掉到 body(真 disabled 的規格行為,web 同),節點不重建能保的是不閃、不 reflow
  ok("② 按下 → 回合開始先鎖鈕 + 忙碌說明 → onScan 回來(回合序號)→ 同一顆鈕就地改成「已送出，看對話」(不重建、說明收掉)",
    JSON.stringify(r.calls) === '[["s1","BUTTON"]]' && r.mid.dis && r.mid.txt === (await js(`t("rob.btnScan")`)) && r.mid.cap && r.same && r.dis && r.txt === (await js(`t("rob.btnSent")`)) && !r.cap);
  r = await js(`(() => { window.__render({ stats: ${JSON.stringify(STATS)}, scan: null, code: "", name: "s1" }, true); const b = window.__box.querySelector(".rob-empty button"); return b.textContent; })()`);
  ok("② 同一支、簽章沒變、同一回合還在跑:整塊重畫仍是「已送出」", r === (await js(`t("rob.btnSent")`)));
  r = await js(`(() => { window.__sync(false); const a = window.__box.querySelector(".rob-empty button"); const r1 = [a.textContent, window.__lk(a), !!window.__box.querySelector(".rob-cap")];
    window.__turn = 8; window.__sync(true); const b = window.__box.querySelector(".rob-empty button"); return { r1, r2: [b.textContent, window.__lk(b), !!window.__box.querySelector(".rob-cap")], same: a === b }; })()`);
  ok("② 回合結束沒產出:就地解鎖回「開始掃描」;下一輪無關的回合開始:只是停用 + 忙碌說明,不再變回「已送出」(不跨回合)", r.r1[0] === (await js(`t("rob.btnScan")`)) && r.r1[1] === false && !r.r1[2] && r.r2[0] === (await js(`t("rob.btnScan")`)) && r.r2[1] === true && r.r2[2] && r.same);
  r = await js(`(() => { window.__turn = 7; window.__render({ stats: ${JSON.stringify(STATS)}, scan: null, code: "", name: "s1" }, true, 7, "cloud"); return window.__box.querySelector(".rob-empty button").textContent; })()`);
  ok("② 雲端視角的同名策略(同 sig、同回合):不吃本機那份的「已送出」", r === (await js(`t("rob.btnScan")`)));
  // 結果頁:頂列常駐「重新掃描」(spec-0.1.12-scan-stale §3.1)
  r = await js(`(() => { window.__render({ stats: ${JSON.stringify(STATS)}, scan: ${JSON.stringify(SCAN)}, code: "A = 10\\nB = 0.5", name: "s2" }, false);
    const top = window.__box.querySelector(".bt.rob > .rob-top"), b = top && top.querySelector("button.rob-go"), tbl = window.__box.querySelector(".rob-tbl");
    window.__sync(true); const busy = { dis: window.__lk(b), cap: (top.querySelector(".rob-cap") || {}).textContent, same: top.querySelector("button.rob-go") === b, tbl: window.__box.querySelector(".rob-tbl") === tbl };
    window.__sync(false); return { first: top.firstElementChild.classList.contains("bt-meta"), cls: b.className, txt: b.textContent, dis0: window.__lk(b), busy, after: [window.__lk(b), !!top.querySelector(".rob-cap"), b.isConnected, window.__box.querySelector(".rob-tbl") === tbl] }; })()`);
  ok("② 結果頁(新鮮):頂列 = meta + 描邊鈕「重新掃描」;別的回合在跑 → 就地停用 + 一行忙碌說明(不重畫熱圖),結束解鎖",
    r.first && r.cls === "btn-out rob-go" && r.txt === (await js(`t("rob.btnRescan")`)) && !r.dis0 && r.busy.dis && r.busy.cap === (await js(`t("rob.busy")`)) && r.busy.same && r.busy.tbl && JSON.stringify(r.after) === "[false,false,true,true]", JSON.stringify(r));
  r = await js(`(async () => { window.__calls = []; window.__turn = 9; const b0 = window.__box.querySelector("button.rob-go"); b0.click();
    window.__sync(true); const mid = { dis: window.__lk(b0), card: !!window.__box.querySelector(".rob-card") };
    await new Promise((r) => setTimeout(r, 30));
    const b = window.__box.querySelector("button.rob-go");
    const sentView = { calls: window.__calls, info: window.__info, cls: b.className, dis: window.__lk(b), txt: b.textContent, spin: !!b.querySelector(".spin16"), card: !!window.__box.querySelector(".rob-card"), heat: !!window.__box.querySelector(".rob-tbl"), meta: !!window.__box.querySelector(".rob-top .bt-meta") };
    window.__sync(false); const back = window.__box.querySelector("button.rob-go");
    return { mid, sentView, back: [back.className, back.disabled, !!window.__box.querySelector(".rob-card"), !!window.__box.querySelector(".rob-tbl")] }; })()`);
  ok("② 結果頁按「重新掃描」:onScan 帶 info(rescan、上次兩軸、現在的期間 / 費率)→ 送出成功只留 meta + 填色停用鈕(轉圈 +「已送出，看對話」),結論卡與熱圖收掉;回合結束沒新結果 → 舊結果回來",
    JSON.stringify(r.sentView.calls) === '[["s2","BUTTON"]]' && r.sentView.info.rescan === true && r.sentView.info.grid.rp === "A" && r.sentView.info.grid.r1 === "30" && r.sentView.info.now.fee === "0.05"
    && r.mid.dis && r.mid.card && r.sentView.cls === "btn-fill rob-go" && r.sentView.dis && r.sentView.spin && r.sentView.txt === (await js(`t("rob.btnSent")`)) && !r.sentView.card && !r.sentView.heat && r.sentView.meta
    && JSON.stringify(r.back) === '["btn-out rob-go",false,true,true]', JSON.stringify(r));

  // 有 scan:目前參數在尖峰上(策略碼 A=10 / B=0.5)
  const full = (code) => js(`(() => { window.__render({ stats: ${JSON.stringify(STATS)}, scan: ${JSON.stringify(SCAN)}, code: ${JSON.stringify(code)}, name: "s1" }, false);
    const q = (s) => [...window.__box.querySelectorAll(s)];
    const cur = q(".rob-tbl td.is-current")[0];
    return { meta: (window.__box.querySelector(".bt-meta") || {}).textContent, tag: (window.__box.querySelector(".rob-tag") || {}).className, verdict: (window.__box.querySelector(".rob-verdict") || {}).textContent,
      rows: q(".rob-cmp-tbl tbody tr").map((tr) => [...tr.children].map((td) => td.textContent)), cells: q(".rob-tbl td").length, cur: cur ? [cur.dataset.i, cur.dataset.j] : null,
      focusable: q(".rob-tbl td[tabindex='0']").map((td) => td.dataset.i + td.dataset.j), na: q(".rob-tbl td.is-na").map((td) => td.textContent), glyphs: q(".rob-tbl td .rob-glyph").map((g) => g.className),
      c00: q(".rob-tbl td")[0].textContent, bg00: q(".rob-tbl td")[0].style.background, aria: q(".rob-tbl td")[0].getAttribute("aria-label"), legend: q(".rob-legend .it").length, sw: q(".rob-legend .rob-sw").length, oldSw: q(".rob-legend .sw").length }; })()`);
  r = await full("A = 10\nB = 0.5\n");
  const tf = (k, v) => js(`t(${JSON.stringify(k)}, ${JSON.stringify(v || {})})`);
  ok("② meta 列:回測那一行 + 「掃描 3×3」", r.meta && r.meta.includes("BTCUSDT") && r.meta.endsWith((await tf("rob.metaScan")) + "3×3"));
  ok("② 尖峰上:風險 tag + 尖峰那句;比較表只有尖峰 / 穩健兩列(目前就是尖峰列)", /is-risk/.test(r.tag) && r.verdict === (await tf("rob.verdict.peak")) && r.rows.length === 2 && r.rows[0][1] === "10 / 0.5" && r.rows[0][2] === "3.00" && r.rows[1][1] === "30 / 0.9");
  ok("② 熱圖 3×3 = 9 格;目前參數虛線格在 (0,0);可 focus 的只有有角色的格(尖峰=目前 (0,0)、穩健 (2,2));沒交易那格「—」", r.cells === 9 && JSON.stringify(r.cur) === '["0","0"]' && r.focusable.join() === "00,22" && r.na.join() === "—");
  ok("② 格內:▲ / ● 是 CSS 幾何 glyph、數字兩位小數、底色是 token + alpha 現算(不是 hex)、aria-label 帶參數對 / 值 / 角色", r.glyphs.join() === "rob-glyph peak,rob-glyph plateau" && r.c00 === "3.00" && /^rgba\(/.test(r.bg00) && r.aria.startsWith("A 10 · B 0.5: ") && r.aria.includes("(") && r.legend === 4 && r.sw === 3 && r.oldSw === 0);
  r = await full("A = 10\nB = 0.9\n");
  ok("② 區外:中性 tag、三列(多「目前」列 10 / 0.9)、虛線格在 (0,2)", /is-neutral/.test(r.tag) && r.verdict === (await tf("rob.verdict.outside")) && r.rows.length === 3 && r.rows[2][1] === "10 / 0.9" && JSON.stringify(r.cur) === '["0","2"]' && r.focusable.join() === "00,02,22");
  r = await full("A = 99\nB = 0.5\n");
  ok("② 不在掃描範圍:目前列參數照寫、兩個值 —、沒有虛線格", r.verdict === (await tf("rob.verdict.outscan")) && r.rows[2][1] === "99 / 0.5" && r.rows[2][2] === "—" && r.rows[2][3] === "—" && r.cur === null);
  r = await js(`(() => { const q = (s) => [...window.__box.querySelectorAll(s)]; q(".rob-seg button")[1].click();
    const P = window.BlaveReport._rob, want = P.f2(P.sanitizeScan(${JSON.stringify(SCAN)}, null, "").nbr[0][0]);
    return { lbl: window.__box.querySelector(".rob-heat-label").textContent, c00: q(".rob-tbl td")[0].textContent, want, pressed: q(".rob-seg button").map((b) => b.getAttribute("aria-pressed")).join(), glyph: !!q(".rob-tbl td")[0].querySelector(".rob-glyph") }; })()`);
  ok("② 切到鄰域平均:label 換、(0,0) 從 3.00 變成鄰域平均(" + r.want + ")、標記不動", r.lbl === (await tf("rob.heatNbr", { k: "3" })) && r.c00 === r.want && r.c00 !== "3.00" && r.pressed === "false,true" && r.glyph);
  r = await js(`(() => { const td = [...window.__box.querySelectorAll(".rob-tbl td")][8]; td.focus(); td.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    const tip = document.querySelector(".rob-tip"); const on = tip && tip.classList.contains("is-on") && tip.getAttribute("aria-hidden") === "false" && tip.textContent;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); return { on, off: !tip.classList.contains("is-on"), hover: !td.classList.contains("is-hover") }; })()`);
  ok("② 鍵盤 focus 到穩健格:body 層的 .tip 單例亮起、內容帶參數對與角色字;Esc 收", r.on && r.on.includes("A 30") && r.on.includes(await tf("rob.role.plateau")) && r.off && r.hover);
  r = await js(`(() => { const b = window.__box.querySelector(".rob-cmp-tbl th button.mp-tip"); b.focus(); b.dispatchEvent(new FocusEvent("focus"));
    const tip = document.querySelector(".rob-tip"); const on = tip.classList.contains("is-on") && tip.textContent; b.dispatchEvent(new FocusEvent("blur"));
    return { on, off: !tip.classList.contains("is-on"), inline: window.__box.querySelectorAll(".rob-cmp-tbl .tip").length, aria: b.getAttribute("aria-describedby") === tip.id }; })()`);
  ok("② 比較表欄頭「鄰域平均」的說明也走同一顆 body 層單例(表可橫捲不會裁到它);blur 收;沒有行內 .tip", r.on === (await tf("rob.cmp.nbrTip", { k: "3" })) && r.off && r.inline === 0 && r.aria);
  r = await js(`(() => { const b = window.__box.querySelector(".rob-cmp-tbl th button.mp-tip"), tip = document.querySelector(".rob-tip"); b.dispatchEvent(new FocusEvent("focus"));
    document.dispatchEvent(new PointerEvent("pointermove")); const stays = tip.classList.contains("is-on");
    window.__box.style.display = "none"; document.dispatchEvent(new PointerEvent("pointermove")); const off = !tip.classList.contains("is-on"); window.__box.style.display = ""; return { stays, off }; })()`);
  ok("② 錨點還在畫面上時滑鼠動不收;錨點不在畫面上了(換頁 / 重畫,收不到 blur)下一次滑鼠動就收", r.stays && r.off, JSON.stringify(r));
  r = await js(`(() => { window.__box.style.width = "400px"; const cols = Array.from({ length: 12 }, (_, i) => Math.round(10 * (i + 1)) / 100); const row = cols.map((_, j) => (j === 11 ? 2.5 : 0.3));
    window.__render({ stats: ${JSON.stringify(STATS)}, scan: { row_param: "A", col_param: "B", row_vals: [1, 2], col_vals: cols, grid: [row, row.map((v) => v * 0.9)], window: 1 }, code: "A = 1\\nB = 1.2", name: "s1" }, false);
    const f = window.__box.querySelector(".rob-frame"); const td = window.__box.querySelector(".rob-tbl td.is-current"); const r = td.getBoundingClientRect(), fr = f.getBoundingClientRect();
    const out = { sl: f.scrollLeft, canScroll: f.scrollWidth > f.clientWidth, visible: r.right <= fr.right + 1 && r.left >= fr.left }; window.__box.style.width = ""; return out; })()`);
  ok("② 12 欄、400 寬:標記在最右欄 → frame 自己捲到看得見它(不縮格)", r.canScroll && r.sl > 0 && r.visible);
  r = await js(`(() => { window.__render({ stats: ${JSON.stringify(STATS)}, scan: ${JSON.stringify({ ...SCAN, current: { i: 0, j: 0 }, generated_at: 10 })}, code: "", name: "s1" }, false);
    return { tag: !!window.__box.querySelector(".rob-tag"), verdict: window.__box.querySelector(".rob-verdict").textContent, cur: !!window.__box.querySelector(".rob-tbl td.is-current") }; })()`);
  ok("② 過時(scan 早於回測、策略碼讀不到常數):沒有 tag、結論「回測已重跑」、沒有虛線格", !r.tag && r.verdict === (await tf("rob.verdict.stale")) && !r.cur);
  // 過時第 1 層:回測期間改了(常數照樣讀得到)。meta 寫掃描自己的期間 / 費率,不是回測的
  const stale = (st, scan) => js(`(() => { window.__render({ stats: ${JSON.stringify(st)}, scan: ${JSON.stringify(scan || SCAN)}, code: "A = 10\\nB = 0.9", name: "s3" }, false);
    const q = (s) => [...window.__box.querySelectorAll(s)], v = window.__box.querySelector(".rob-verdict"), b = window.__box.querySelector("button.rob-go");
    return { meta: window.__box.querySelector(".bt-meta").textContent, tag: !!window.__box.querySelector(".rob-tag"), status: getComputedStyle(window.__box.querySelector(".rob-status")).display,
      verdict: v.textContent, monos: [...v.querySelectorAll(".mono")].map((m) => [m.textContent, getComputedStyle(m).whiteSpace]), rows: q(".rob-cmp-tbl tbody tr").length, cur: q(".rob-tbl td.is-current").length,
      dash: q(".rob-legend .rob-sw.dash").length, peakMark: q(".rob-tbl td .rob-glyph").length, cls: b.className }; })()`);
  r = await stale({ ...STATS, start: "2015-01-01", end: "2026-10-01", "fee [%]": 0.01 });
  ok("② 過時(期間 + 手續費都改了):沒有 tag(狀態列不佔位)、結論換成點名句(值包 .mono、不在值中間折行)、比較表沒有「目前」列、沒有虛線格與「目前參數」圖例、▲● 留著、鈕升填色",
    !r.tag && r.status === "none" && r.verdict === (await tf("rob.stale.period", { start: "2015-01-01", end: "2026-10-01" })).replace(/^./, (c) => c.toUpperCase()) + (await tf("rob.stale.join")) + (await tf("rob.stale.fee", { fee: "0.01" })) + (await tf("rob.stale.tail"))
    && JSON.stringify(r.monos) === JSON.stringify([["2015-01-01", "nowrap"], ["2026-10-01", "nowrap"], ["0.01", "nowrap"]]) && r.rows === 2 && r.cur === 0 && r.dash === 0 && r.peakMark === 2 && r.cls === "btn-fill rob-go", JSON.stringify(r));
  ok("② 過時頁的 meta 寫掃描自己的期間與費率(2025-01-01 → 2025-06-01、0.05%),不是回測的 2015 / 0.01", r.meta.includes("2025-01-01 → 2025-06-01") && r.meta.includes("0.05%") && !r.meta.includes("2015") && !r.meta.includes("0.01%") && r.meta.includes("BTCUSDT"));
  r = await stale({ ...STATS, end: "2025-06-30" });
  ok("② 訖日往後延 29 天:不過時 → 一般結論句、有 tag、鈕是描邊", r.tag && r.verdict === (await tf("rob.verdict.outside")) && r.cls === "btn-out rob-go");
  r = await stale(STATS, { ...SCAN, start: undefined, fee: undefined });
  ok("② 掃描缺起日 / 費率:meta 不畫期間與手續費那兩組(不拿回測的補),只剩 symbol / interval / 掃描 R×C", !r.meta.includes("→") && !r.meta.includes("%") && r.meta.includes("BTCUSDT") && r.meta.endsWith((await tf("rob.metaScan")) + "3×3"));
  r = await js(`(() => { window.__render({ stats: ${JSON.stringify(STATS)}, scan: { row_param: "<img onerror=x>", col_param: "B", row_vals: [1], col_vals: [1], grid: [[1]] }, code: "", name: "s1" }, false);
    return { img: window.__box.querySelectorAll("img").length, txt: window.__box.querySelector(".rob-tbl th.corner").textContent }; })()`);
  ok("② 參數名是雲端 / agent 來的字串:只進 textContent,不變成元素", r.img === 0 && r.txt.includes("<img onerror=x>"));

  // ── ② 單參數(6×1、col_param "_"):一欄熱圖,文字不出現 _ / "/ 0" / N×1;二維 3×3 的 innerHTML 跟改前快照逐字相同 ──
  const one = (code) => js(`(() => { window.__render({ stats: ${JSON.stringify(STATS)}, scan: ${JSON.stringify(SINGLE)}, code: ${JSON.stringify(code)}, name: "s9" }, false);
    const q = (s) => [...window.__box.querySelectorAll(s)], tbl = window.__box.querySelector(".rob-tbl"), cur = q(".rob-tbl td.is-current")[0];
    return { meta: window.__box.querySelector(".bt-meta").textContent, tag: (window.__box.querySelector(".rob-tag") || {}).textContent, verdict: window.__box.querySelector(".rob-verdict").textContent,
      hdr: window.__box.querySelector(".rob-cmp-tbl th.prm").textContent, rows: q(".rob-cmp-tbl tbody tr").map((tr) => [...tr.children].map((td) => td.textContent)),
      cls: tbl.className, minW: tbl.style.minWidth, aria: tbl.getAttribute("aria-label"), corner: q(".rob-tbl th.corner span").map((x) => x.textContent), colTh: q(".rob-tbl thead th:not(.corner)").map((x) => x.textContent),
      cells: q(".rob-tbl td").length, cur: cur ? [cur.dataset.i, cur.dataset.j] : null, cellAria: q(".rob-tbl td")[0].getAttribute("aria-label"), legend: q(".rob-legend .it").map((x) => x.textContent), text: window.__box.textContent }; })()`);
  r = await one("N = 10\n");
  const bad = (t) => /_|\/ 0|×1|×|\{/.test(t);   // 佔位痕跡:_、x / 0、N×1(單參數整頁沒有 ×)、沒填的 {var}
  ok("② 單參數(尖峰上):meta「掃描 6 格」(不寫 6×1)、tag / 結論是 *1 版、比較表欄頭只有 N、參數欄只印值、熱圖 is-single、不設 minWidth、aria 用 heatAria1、角落一行、欄頭空、6 格、虛線格 (0,0)",
    r.meta.endsWith((await tf("rob.metaScan")) + (await tf("rob.cells", { n: "6" }))) && r.tag === (await tf("rob.tag.peak")) && r.verdict === (await tf("rob.verdict.peak1")) && r.hdr === "N" && r.rows.length === 2 && r.rows[0][1] === "10" && r.rows[1][1] === "50"
    && r.cls === "rob-tbl is-single" && r.minW === "" && r.aria === (await tf("rob.heatAria1", { rp: "N" })) && JSON.stringify(r.corner) === '["N ↓"]' && JSON.stringify(r.colTh) === '[""]' && r.cells === 6 && JSON.stringify(r.cur) === '["0","0"]'
    && r.cellAria.startsWith("N 10: ") && !bad(r.text), JSON.stringify(r));
  r = await one("N = 50\n");
  const curPl1 = await tf("rob.legend.curPlateau1"), curOff1 = await tf("rob.legend.curOff1", { prm: "99" });
  ok("② 單參數(就是穩健格):tag atPlateau1、圖例「目前參數 = 穩健參數」(*1)、尖峰 / 穩健圖例的參數只印值", r.tag === (await tf("rob.tag.atPlateau1")) && r.legend.includes(curPl1) && r.legend[0] === (await tf("rob.legend.peak", { prm: "10" })) && r.legend[1] === (await tf("rob.legend.plateau", { prm: "50" })) && !bad(r.text), JSON.stringify(r.legend));
  r = await one("N = 99\n");
  ok("② 單參數(不在掃描範圍):目前列只印 99、圖例 curOff1「不在掃描範圍內」、沒有虛線格", r.verdict === (await tf("rob.verdict.outscan")) && r.rows[2][1] === "99" && r.legend.includes(curOff1) && r.cur === null && !bad(r.text), JSON.stringify(r.rows));
  r = await js(`(() => { const q = (s) => [...window.__box.querySelectorAll(s)]; q(".rob-seg button")[1].click(); const lbl = window.__box.querySelector(".rob-heat-label").textContent;
    const td = q(".rob-tbl td")[4]; td.focus(); td.dispatchEvent(new FocusEvent("focusin", { bubbles: true })); const tip = document.querySelector(".rob-tip").textContent; document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    const b = window.__box.querySelector(".rob-cmp-tbl th button.mp-tip"); b.dispatchEvent(new FocusEvent("focus")); const tip2 = document.querySelector(".rob-tip").textContent; b.dispatchEvent(new FocusEvent("blur")); return { lbl, tip, tip2 }; })()`);
  ok("② 單參數:鄰域 label 是 heatNbr1(相鄰 3 格)、格 tooltip 第一行只有「N 50」(不帶 ·)、欄頭說明是 cmp.nbrTip1", r.lbl === (await tf("rob.heatNbr1", { k: "3" })) && r.tip.startsWith("N 50" + (await tf("rob.tipSharpe", { s: "1.60", n: "1.55" }))) && r.tip2 === (await tf("rob.cmp.nbrTip1", { k: "3" })) && !bad(r.lbl + r.tip + r.tip2), JSON.stringify(r));
  r = await js(`(() => { window.__render({ stats: ${JSON.stringify(STATS)}, scan: ${JSON.stringify({ ...SINGLE, col_param: "B", col_vals: [0.5] })}, code: "N = 10\\nB = 0.5", name: "s9" }, false);
    const tbl = window.__box.querySelector(".rob-tbl"); return { cls: tbl.className, minW: tbl.style.minWidth, corner: tbl.querySelectorAll("th.corner span").length, meta: window.__box.querySelector(".bt-meta").textContent }; })()`);
  ok("② 第二軸是真常數只有一格(不是 \"_\"):照二維畫(沒有 is-single、有 minWidth、角落兩行、meta 6×1)", r.cls === "rob-tbl" && r.minW === "340px" && r.corner === 2 && r.meta.endsWith((await tf("rob.metaScan")) + "6×1"));
  {
    const diffs = [];
    for (const e of SNAP) {
      const html = await js(`(() => { setLang(${JSON.stringify(e.lang)}); window.BlaveReport.renderRobust(window.__box, { stats: ${JSON.stringify(e.stats)}, scan: ${JSON.stringify(e.scan)}, code: ${JSON.stringify(e.code)}, name: "s1" },
        { t, busy: false, turn: 1, scope: "local", buildMeta: window.BlaveReport.buildMeta, onScan: () => Promise.resolve(false) }); return window.__box.innerHTML; })()`);
      if (html !== e.html) diffs.push(e.lang + "/" + e.state);
    }
    await js(`setLang("zh"); 0;`);
    ok("② 二維零變化:3×3 fixture 六種落點 × zh / en 的 innerHTML 與改前快照(tests/fixtures/shell_robust_3x3.json)逐字相同", SNAP.length === 12 && diffs.length === 0, diffs.join(", "));
  }

  console.log(red ? `\n② ${red} 紅` : "\n② ALL PASS");
  app.exit(red ? 1 : 0);
});
