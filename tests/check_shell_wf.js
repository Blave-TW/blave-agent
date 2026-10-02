// 報告頁「樣本外驗證」分頁(shell/renderer/report-wf.js,雲端工作頁 wf 段的移植)。
//   ① 純函式(node 直接 vm 載入):sanitizeWf / wfBand / wfPreset / wfRunsOf / wfTotalDays 跟雲端工作頁那一份逐項比輸出
//      (從 web workspace.html 原文切出來跑,兩邊看同一份 wf.json 要得出同一個結論;找不到 web 樹就 SKIP 那一段),
//      外加本機這份自己的判讀:真的 lib 寫出來的 wf.json(tests/fixtures/wf_sample.json)、五段 band、分母護欄、過時、單參數、壞輸入。
//   ② 用隨包的 Electron 開真的 index.html,真的 renderWf 一次:結果頁(重跑列、結論卡、曲線、落點網格、每輪明細)、空狀態
//      (旋鈕 + 時間軸 + 共 N 輪)、雲端主機落後(一句 + 去更新)、送出 → 已送出(舊結果拿掉、環在鈕裡)→ 回合結束沒新結果舊結果回來、
//      別的回合進行中鈕停用 + 一行說明(打到一半的窗長不被洗掉)、參數名只進 textContent。
//   ③ 接線:主行程讀 wf.json、wfMtime 讓開著的分頁原地重畫(不出結果卡)、cloud.js 白名單、分頁列 / 面板、還原凍結、
//      固定訊息與 wf.* 字串逐字 = web 的 zh / en msgstr。
// 跑法:node tests/check_shell_wf.js(BLAVE_TEST_WINDOW=1 才跑 ②;BLAVE_WEB_DIR 指 web 樹,預設 monorepo 的 ../../web)
const path = require("path"), fs = require("fs"), vm = require("vm");
const SHELL = path.join(__dirname, "..", "shell");
const GATE = require("./_electron_gate");
let red = 0; const ok = (n, c, why) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || !why ? "" : "\n      " + why)); if (!c) red++; };
const SAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "wf_sample.json"), "utf8"));   // lib/walk_forward 真的寫出來的一份:11 輪、365/30
const CODE = "ENTRY_TH = 0.002\nEXIT_TH = -0.002\n";
const STATS = { symbol: "BTCUSDT", interval: "1d", start: "2023-01-01", end: "2024-11-30", "fee [%]": 0.05, "Generated At": 50 };

if (!process.versions.electron) {
  // ── ① 純函式 ──
  const sb = { window: {}, console };
  vm.createContext(sb);
  for (const f of ["report-backtest.js", "report-robust.js", "report-wf.js"]) vm.runInContext(fs.readFileSync(path.join(SHELL, "renderer", f), "utf8"), sb);
  const W = sb.window.BlaveReport._wf;
  const w0 = W.sanitizeWf(SAMPLE, CODE);
  ok("① lib 寫出來的 wf.json:整份收下(11 輪、365/30、曲線 330 點、軸 4×3、目前參數 = 碼裡的常數、不過時)",
    !!w0 && w0.nRuns === 11 && w0.runs.length === 11 && w0.lookback === 365 && w0.step === 30 && w0.oos.dates.length === 330 && w0.rows.length === 4 && w0.cols.length === 3
    && JSON.stringify(w0.current) === "[0.002,-0.002]" && !w0.stale && !w0.single && w0.tail === 4);
  ok("① 樣本外效率 0.99 → high;五段邊界 0.2 / 0.5 / 0.7(下限含)", W.wfBand(w0) === "high" && [[0.19, "far"], [0.2, "low"], [0.49, "low"], [0.5, "edge"], [0.69, "edge"], [0.7, "high"]].every(([v, b]) => W.wfBand({ ...w0, wfe: v }) === b));
  ok("① 分母護欄:樣本內 Sharpe < 0.25 或缺、wfe null → 無法判斷(不做除法)", W.wfBand({ ...w0, isStats: { ...w0.isStats, "Sharpe Ratio": 0.24 } }) === "none" && W.wfBand({ ...w0, isStats: { ...w0.isStats, "Sharpe Ratio": null } }) === "none" && W.wfBand({ ...w0, wfe: null }) === "none");
  { const noIs = { ...SAMPLE, wfe: 3 }; delete noIs.is_stats;
    ok("① P2-7 wf.json 缺 is_stats(agent 手寫漏了)/ is_stats 不是物件 / Sharpe 不是數字 → 無法判斷,不繞過分母護欄",
      W.wfBand(W.sanitizeWf(noIs, CODE)) === "none" && W.wfBand(W.sanitizeWf({ ...noIs, is_stats: [1] }, CODE)) === "none" && W.wfBand({ ...w0, isStats: {} }) === "none" && W.wfBand({ ...w0, isStats: { "Sharpe Ratio": NaN } }) === "none"); }
  ok("① 過時 = 碼裡的常數 ≠ wf.current;讀不到常數 → 不標過時、目前參數退回 wf.current", W.sanitizeWf(SAMPLE, "ENTRY_TH = 0.004\nEXIT_TH = -0.002\n").stale && !W.sanitizeWf(SAMPLE, "").stale && JSON.stringify(W.sanitizeWf(SAMPLE, "").current) === "[0.002,-0.002]");
  const ONE = { ...SAMPLE, col_param: "_", col_vals: [0], current: [0.002, 0], runs: SAMPLE.runs.map((r) => ({ ...r, params: [r.params[0], 0] })) };
  ok("① 單參數(第二軸一格、名字 _):single、過時只比第一個常數", (() => { const a = W.sanitizeWf(ONE, "ENTRY_TH = 0.002\n"), b = W.sanitizeWf(ONE, "ENTRY_TH = 0.006\n"); return a.single && !a.stale && b.stale; })());
  ok("① 被排除的輪:檔案沒寫 excluded_runs 才用 train_sharpe ≤ 0 自推", (() => { const runs = SAMPLE.runs.map((r, i) => ({ ...r, train_sharpe: i < 2 ? -0.1 : r.train_sharpe })); const x = { ...SAMPLE, runs }; delete x.excluded_runs; return JSON.stringify(W.sanitizeWf(x, CODE).excluded) === "[1,2]" && W.sanitizeWf({ ...x, excluded_runs: [5] }, CODE).excluded.join() === "5"; })());
  const BAD = [null, 7, "x", [], {}, { ...SAMPLE, lookback_days: 0 }, { ...SAMPLE, step_days: 1.5 }, { ...SAMPLE, lookback_days: 20001 }];
  ok("① 沒有窗長就不是一份結果:" + BAD.length + " 種壞輸入一律 null", BAD.every((b) => W.sanitizeWf(b, CODE) === null));
  ok("① 一輪壞掉整張明細不要(半份表比沒有更糟)、曲線 dates / cum 不等長不畫、日期字串 > 32 字不收、參數名 > 64 不畫落點圖",
    W.sanitizeWf({ ...SAMPLE, runs: SAMPLE.runs.map((r, i) => (i === 3 ? { ...r, k: "4" } : r)) }, CODE).runs === null
    && W.sanitizeWf({ ...SAMPLE, oos: { dates: SAMPLE.oos.dates, cum: SAMPLE.oos.cum.slice(1) } }, CODE).oos === null
    && W.sanitizeWf({ ...SAMPLE, oos: { dates: SAMPLE.oos.dates.map((d, i) => (i ? d : "x".repeat(33))), cum: SAMPLE.oos.cum } }, CODE).oos === null
    && W.sanitizeWf({ ...SAMPLE, row_param: "x".repeat(65) }, CODE).rowParam === null);
  ok("① 預填三層:≥1185 天 1095/30、455–1184 天 365/30、更短退回 4:1(步長 floor(總天數÷12)、下限 30)",
    JSON.stringify([1185, 1184, 455, 454, 120].map((d) => W.wfPreset(d))) === '[{"step":30,"lookback":1095},{"step":30,"lookback":365},{"step":30,"lookback":365},{"step":37,"lookback":148},{"step":30,"lookback":120}]');
  ok("① 輪數 = floor((總天數 − 訓練窗) ÷ 步長);訓練窗 ≥ 總天數 / 非正數 → 0;總天數從回測起訖日算,缺了退回每輪日期",
    W.wfRunsOf(700, 365, 30) === 11 && W.wfRunsOf(365, 365, 30) === 0 && W.wfRunsOf(700, 0, 30) === 0 && W.wfTotalDays(STATS, null) === 699 && W.wfTotalDays({}, w0) === W.wfDays(w0.runs[0].tr0, w0.runs[10].te1));
  ok("① 重選線三段:≤12 整條、13–60 短刻度、>60 不畫;標記點是各輪 test_start 在曲線上的位置(第一輪不畫)",
    W.wfMarkMode(12) === "line" && W.wfMarkMode(13) === "tick" && W.wfMarkMode(60) === "tick" && W.wfMarkMode(61) === "none" && W.wfRunMarks(w0).length === 10 && W.wfRunMarks(w0)[0] === w0.oos.dates.indexOf(w0.runs[1].te0));
  // 0.1.12 Wei 截圖:台指期 1h 十年、累積報酬到 +1700%,舊碼步長卡 50% + 格線 24 條上限 → 刻度擠在下半部停在 +1050%、還多出一條 −100%
  {
    const axis = (lo, hi) => { lo = Math.min(lo, 0); hi = Math.max(hi, 0); const p = (hi - lo) * 0.08 || 1; return W.wfTicks(lo - p, hi + p); };
    const nice = (s) => { const m = s / Math.pow(10, Math.floor(Math.log10(s) + 1e-9)); return [1, 2, 5].some((x) => Math.abs(m - x) < 1e-6); };
    const sane = (a) => a.ticks.length >= 4 && a.ticks.length <= 6 && nice(a.step) && a.ticks.every((v, i) => v >= a.lo - 1e-9 && v <= a.hi + 1e-9 && (!i || v > a.ticks[i - 1]));
    const tw = axis(-5, 1700);
    ok("① Y 軸刻度:截圖那份(−5% … +1700%)→ 步長 500、0 / +500 / +1000 / +1500,刻度涵蓋到曲線頂、沒有 −100%",
      sane(tw) && tw.step === 500 && tw.ticks.join() === "0,500,1000,1500" && tw.hi >= 1700 && tw.lo <= -5 && tw.lo > -500, JSON.stringify(tw));
    const bad = [];
    for (const lo of [0, -0.01, -0.3, -5, -37, -95, -99.9]) for (let e = -3; e <= 6; e += 0.01) {
      const h = Math.pow(10, e);
      for (const hi of [h, -Math.min(h, 99.99)]) { const a = axis(Math.min(lo, hi), Math.max(lo, hi)); if (!sane(a) || a.lo > Math.min(lo, hi, 0) || a.hi < Math.max(lo, hi, 0)) bad.push([lo, hi, a.ticks.length, a.step]); }
    }
    ok("① Y 軸刻度掃 1.2 萬組(低點 0 … −99.9%、高點 0.001% … +100 萬%、全部是負的):每組 4–6 條、1 / 2 / 5 × 10^n、刻度都在軸內、軸包得住資料", bad.length === 0, JSON.stringify(bad.slice(0, 5)));
    const flat = axis(0, 0), tiny = axis(0, 0.3), neg = axis(-60, -3);
    ok("① Y 軸刻度:全平(0%)、只有 +0.3%、全部是負的 → 都有 4–6 條;0 那條是真的 0(虛線判斷 v === 0);小步長標籤不帶浮點尾巴",
      sane(flat) && flat.ticks.includes(0) && sane(tiny) && tiny.dp === 1 && tiny.ticks.map((v) => W.wfTickLabel(v, tiny.dp)).join() === "0.0%,+0.1%,+0.2%,+0.3%"
      && sane(neg) && neg.ticks.includes(0) && neg.ticks.map((v) => W.wfTickLabel(v, neg.dp)).join() === "−60%,−40%,−20%,0%", JSON.stringify([flat, tiny, neg]));
    const big = axis(0, 400000);
    ok("① Y 軸刻度字:≥ 1,000 加千分位(同交易分頁 trFmt2)→ +1,500% / +400,000% / −1,000%;未滿 1,000 不變",
      tw.ticks.map((v) => W.wfTickLabel(v, tw.dp)).join(" ") === "0% +500% +1,000% +1,500%" && big.ticks.map((v) => W.wfTickLabel(v, big.dp)).join(" ") === "0% +100,000% +200,000% +300,000% +400,000%"
      && W.wfTickLabel(-1000, 0) === "−1,000%" && W.wfTickLabel(999, 0) === "+999%" && W.wfTickLabel(1e-30, 30) === "+0.00000000000000000000%", big.ticks.map((v) => W.wfTickLabel(v, big.dp)).join(" "));
    ok("① Y 軸刻度:壞輸入(lo ≥ hi、非有限、相減溢位)不畫刻度、不當機", [[1, 1], [2, 1], [NaN, 1], [0, Infinity], [-1.7e308, 1.7e308]].every(([a, b]) => W.wfTicks(a, b).ticks.length === 0));

    // 真的 drawChart 畫在假 canvas 上:刻度字與曲線點用同一把尺(值剛好落在刻度上的點,y 跟那個刻度字一樣),全部在繪圖區內、字不疊
    const draw = (cum, Wd, Hd) => {
      const calls = [], ctx = new Proxy({ measureText: (s) => ({ width: s.length * 6 }) }, {
        get: (o, k) => (k in o ? o[k] : (...a) => calls.push([k, ...a])), set: () => true });
      sb.document = { documentElement: {} }; sb.getComputedStyle = () => ({ getPropertyValue: () => "#888" });
      W.drawChart({ clientWidth: Wd, clientHeight: Hd, getContext: () => ctx }, { oos: { dates: cum.map((_, i) => "2020-01-" + String(1 + (i % 28)).padStart(2, "0")), cum }, runs: null, step: 30 });
      const labels = calls.filter((c) => c[0] === "fillText" && /%$/.test(c[1])).map((c) => ({ s: c[1], x: c[2], y: c[3] }));
      const pts = calls.filter((c) => c[0] === "moveTo" || c[0] === "lineTo").slice(-cum.length).map((c) => ({ x: c[1], y: c[2] }));
      return { labels, pts };
    };
    const shot = Array.from({ length: 3180 }, (_, i) => (i === 0 ? 0 : i === 2000 ? 1500 : i === 2950 ? 1700 : -5 + (1250 * i) / 3180));
    const bad2 = [];
    for (const [nm, cum] of [["截圖", shot], ["+40 萬%", [0, 100, 400000]], ["+0.3%", [0, 0.1, 0.3]], ["全負", [-2, -30, -60]], ["兩點", [0, 3.4]], ["全平", [0, 0]], ["+12%(要撐域)", [0, 5, 12]]]) for (const [Wd, Hd] of [[510, 220], [414, 220]]) {
      const { labels, pts } = draw(cum, Wd, Hd), ys = labels.map((l) => l.y).sort((a, b) => a - b);
      const inPlot = (y) => y >= 12 - 1e-6 && y <= Hd - 22 + 1e-6;
      const gap = ys.slice(1).every((y, i) => y - ys[i] >= 14);
      const same = labels.every((l) => cum.every((v, i) => wfTickVal(l.s) !== v || Math.abs(pts[i].y - l.y) < 1e-6));
      const fits = labels.every((l) => l.x - 6 * l.s.length >= 0);
      if (labels.length < 4 || labels.length > 6 || !ys.every(inPlot) || !pts.every((p) => inPlot(p.y)) || !gap || !same || !fits) bad2.push(nm + "@" + Wd + " " + labels.map((l) => l.s + "@" + l.y.toFixed(1)).join(" "));
    }
    function wfTickVal(s) { return Number(s.replace("−", "-").replace(/[,%]/g, "")); }
    ok("① drawChart(假 canvas):截圖那份 / 極大 / 極小 / 全負 / 兩點 / 全平 / 要撐域 × 兩種寬 → 刻度 4–6 條、刻度字與曲線都在繪圖區內、字距 ≥ 14px、左邊界放得下最寬的字、落在刻度值上的點跟刻度字同一個 y",
      bad2.length === 0, bad2.join("\n      "));
  }
  ok("① 送出簽章只看 wf / code / Generated At(live 策略每根 K 重寫的 Sharpe 不算)", W.sentSig({ wf: SAMPLE, code: "x", stats: { "Generated At": 1, "Sharpe Ratio": 2 } }) === W.sentSig({ wf: SAMPLE, code: "x", stats: { "Generated At": 1, "Sharpe Ratio": 3 } }) && W.sentSig({ wf: SAMPLE, code: "x", stats: { "Generated At": 2 } }) !== W.sentSig({ wf: SAMPLE, code: "x", stats: { "Generated At": 1 } }));

  // ── ① 雲端「已送出」留到新結果到(稽核 P2-4,Wei 選 B):純函式 sentNow / holdLeft ──
  {
    const H = W.WF_CLOUD_HOLD_MS, sig = "S1", e = (x) => ({ sig, turn: 7, ...(x || {}) });
    const o = (x) => ({ busy: false, turn: 7, scope: "cloud", ...(x || {}) });
    ok("① 回合還在跑(就是送出那一輪):本機 / 雲端都是已送出;pending 只在回合進行中算", W.sentNow(e(), sig, o({ busy: true }), 0) && W.sentNow(e(), sig, o({ busy: true, scope: "local" }), 0)
      && W.sentNow(e({ pending: true, turn: null }), sig, o({ busy: true }), 0) && !W.sentNow(e({ pending: true, turn: null }), sig, o(), 0));
    ok("① 本機:回合結束就回來(wf.json 已落地)", !W.sentNow(e(), sig, o({ scope: "local" }), 0) && W.holdLeft(e({ endAt: 0 }), o({ scope: "local" }), 1) === null);
    { const x = e(), t0 = 1000;
      ok("① 雲端:回合結束後留著(第一次看到結束時記 endAt),回合結束後滿 5 分鐘前一刻還留、到了就回來",
        W.sentNow(x, sig, o(), t0) && x.endAt === t0 && W.sentNow(x, sig, o(), t0 + H - 1) && !W.sentNow(x, sig, o(), t0 + H) && x.endAt === t0); }
    { const x = e(); W.sentNow(x, sig, o({ busy: true }), 0);
      ok("① 雲端:回合還在跑的那段不起算(長回合不會一結束就超過上限)", x.endAt == null && W.holdLeft(x, o({ busy: true }), 0) === null); }
    ok("① 雲端:新結果到了(wf 簽章變了)→ 不再是已送出,原地換成新結果", !W.sentNow(e({ endAt: 0 }), "S2", o(), 10));
    { const y = e(); W.sentNow(y, sig, o(), 0); W.sentNow(y, sig, o(), H);
      ok("① 雲端:到上限退回過就不再回來(時間倒回上限內也不會又變成已送出)", y.done && !W.sentNow(y, sig, o(), 10) && W.holdLeft(y, o(), 10) === null);
      ok("① A2 滿上限退回的那筆記 timedOut(結論槽要講一句);還沒到上限不記", y.timedOut === true && (() => { const z = e(); W.sentNow(z, sig, o(), 0); W.sentNow(z, sig, o(), H - 1); return !z.timedOut; })()); }
    ok("① 雲端:之後別的回合在跑,照樣留著(那一輪已經結束了)", W.sentNow(e(), sig, o({ busy: true, turn: 9 }), 0));
    { const x = e({ endAt: 100 });
      ok("① holdLeft:等雲端那一段剩多久;回合還在跑 / 到上限 / pending → null", W.holdLeft(x, o(), 100 + 60000) === H - 60000 && W.holdLeft(x, o(), 100 + H) === null
        && W.holdLeft(e(), o({ busy: true }), 0) === null && W.holdLeft(e({ pending: true, endAt: 0 }), o(), 1) === null); }
  }

  // ── ① 回合結束 wfTurnEnded 與兩個計時(複驗 P2-R3 / P2-R4):假的 setTimeout / setInterval,不等真時間 ──
  {
    const F = { seq: 0, t: new Map(), i: new Map(), ct: [], ci: [] };
    Object.assign(sb, { setTimeout: (fn, ms) => { const id = ++F.seq; F.t.set(id, { fn, ms }); return id; }, clearTimeout: (id) => { F.ct.push(id); F.t.delete(id); },
      setInterval: (fn, ms) => { const id = ++F.seq; F.i.set(id, { fn, ms }); return id; }, clearInterval: (id) => { F.ci.push(id); F.i.delete(id); } });
    const reset = () => { F.t.clear(); F.i.clear(); F.ct.length = 0; F.ci.length = 0; W._sent.clear(); };
    const data = { name: "c1", wf: { x: 1 }, code: "A = 1", stats: null }, sig = W.sentSig(data), T0 = 1e9;
    const opts = (x) => ({ busy: false, turn: 7, scope: "cloud", now: () => T0 + 1000, resync: () => { F.resynced = (F.resynced || 0) + 1; }, refetch: (n) => { (F.ref = F.ref || []).push(n); return F.refRet !== false; }, ...(x || {}) });
    const box = {}, st = { data, sent: true, gate: true, knobs: null };
    // wfTurnEnded:只記「那一回合」的紀錄;失敗 → done,雲端那筆 30 秒後補抓一次(本機不抓)
    reset(); W._sent.set("cloud:c1", { sig, turn: 7, name: "c1" }); W._sent.set("cloud:c2", { sig, turn: 6, name: "c2" }); W._sent.set("local:c1", { sig, turn: 7, name: "c1" });
    W.wfTurnEnded(7, false, { now: () => T0 });
    const e1 = W._sent.get("cloud:c1"), e2 = W._sent.get("cloud:c2");
    ok("① wfTurnEnded:只替那一回合的紀錄記 endAt(不等面板畫到);別的回合不動;沒失敗就不 done、不排補抓", e1.endAt === T0 && !e1.done && e2.endAt == null && F.t.size === 0);
    reset(); W._sent.set("cloud:c1", { sig, turn: 7, name: "c1" }); W._sent.set("local:c1", { sig, turn: 7, name: "c1" }); F.ref = [];
    W.wfTurnEnded(7, true, { now: () => T0, refetch: (n) => { F.ref.push(n); } });
    const [fr] = [...F.t.values()];
    ok("① A2 失敗退回的那筆不記 timedOut(那不是「沒傳回來」)", !W._sent.get("cloud:c1").timedOut);
    ok("① wfTurnEnded 失敗:那一回合的紀錄 done(當場退回);只替雲端那筆排一次 30 秒後的補抓,名字是送出那一支",
      W._sent.get("cloud:c1").done && W._sent.get("local:c1").done && !W.sentNow(W._sent.get("cloud:c1"), sig, opts(), T0 + 1) && F.t.size === 1 && fr.ms === W.WF_CLOUD_REFETCH_MS && (fr.fn(), F.ref.join() === "c1"));
    // holdArm:回合結束後掛一個上限計時 + 一個重抓計時;同一筆不重掛;換一筆先清舊的
    reset(); const s1 = { sig, turn: 7, name: "c1", endAt: T0 }; W._sent.set("cloud:c1", s1);
    W.holdArm(box, st, opts());
    const [t1] = [...F.t.keys()], [i1] = [...F.i.keys()];
    ok("① holdArm:等雲端那一段掛上兩個計時(上限 = 剩下的時間 + 50ms、重抓每 30 秒)", F.t.size === 1 && F.i.size === 1 && F.t.get(t1).ms === W.WF_CLOUD_HOLD_MS - 1000 + 50 && F.i.get(i1).ms === W.WF_CLOUD_REFETCH_MS);
    W.holdArm(box, st, opts());
    ok("① holdArm 同一筆紀錄再叫一次:不重掛", F.t.size === 1 && F.i.size === 1 && F.ct.length === 0 && F.ci.length === 0);
    const s2 = { sig, turn: 8, name: "c1", endAt: T0 }; W._sent.set("cloud:c1", s2); W.holdArm(box, st, opts());
    ok("① holdArm 換了一筆紀錄:先清舊的兩個計時再掛新的", F.ct.includes(t1) && F.ci.includes(i1) && F.t.size === 1 && F.i.size === 1);
    const [t2] = [...F.t.keys()], [i2] = [...F.i.keys()];
    F.ref = []; F.refRet = true; F.i.get(i2).fn();
    ok("① 重抓計時:叫 refetch(送出那一支的名字);還在那一支(回 true)就繼續", F.ref.join() === "c1" && F.i.has(i2));
    F.refRet = false; F.i.get(i2).fn();
    ok("① 重抓計時:refetch 回 false(人已經不在那一支)→ 兩個計時當場收掉", F.ci.includes(i2) && F.ct.includes(t2) && F.t.size === 0 && F.i.size === 0);
    F.refRet = true; W.holdArm(box, st, opts()); const [t3] = [...F.t.keys()], [i3] = [...F.i.keys()]; F.resynced = 0; F.t.get(t3).fn();
    ok("① 上限計時到了:叫 resync(畫回舊結果),重抓計時一起清掉", F.resynced === 1 && F.ci.includes(i3) && F.i.size === 0);
    reset(); W._sent.set("cloud:c1", { sig, turn: 7, name: "c1", endAt: T0 }); W.holdArm(box, st, opts({ busy: true }));
    ok("① holdArm:回合還在跑 / 本機 → 不掛", F.t.size === 0 && W.holdArm(box, st, opts({ scope: "local" })) === undefined && F.t.size === 0);
    // wfSync:回合剛結束、畫面不動(已送出照舊)→ 就在這裡掛上兩個計時
    reset(); W._sent.set("cloud:c1", { sig, turn: 7, name: "c1", endAt: T0 }); const cont = { isConnected: true }; W._shown.set(cont, { data, sent: true, gate: true, knobs: null });
    sb.window.BlaveReport.wfSync(cont, opts());
    ok("① wfSync:回合結束那一刻(已送出照舊、不重畫)就把兩個計時掛上", F.t.size === 1 && F.i.size === 1);
    { const seen = [], cont2 = { isConnected: true }; W._shown.set(cont2, { data, sent: true, gate: true, knobs: { setWait: (w) => seen.push(w), setBusy: () => {}, btn: { isConnected: true } } });
      sb.window.BlaveReport.wfSync(cont2, opts()); sb.window.BlaveReport.wfSync(cont2, opts({ busy: true }));
      ok("① A1 wfSync:回合結束、等雲端那一段 → 鈕上的字就地換成「結果傳回中」(setWait true);回合還在跑 → false", JSON.stringify(seen) === "[true,false]", JSON.stringify(seen)); }
    reset();
    for (const k of ["setTimeout", "clearTimeout", "setInterval", "clearInterval"]) delete sb[k];
  }

  // ── ① 0.1.11 B10 wfAwaiting:切回分頁 / 視窗回前景時要不要補抓(只讀不寫) ──
  {
    const data = { name: "c1", wf: { x: 1 }, code: "A = 1", stats: null }, sig = W.sentSig(data), cloud = { scope: "cloud", busy: false, turn: 7 };
    const at = (rec, o, d) => { W._sent.clear(); if (rec) W._sent.set((rec.key || "cloud") + ":c1", { sig, turn: 7, name: "c1", ...rec }); return W.wfAwaiting(d || data, { ...cloud, ...(o || {}) }); };
    ok("① B10 wfAwaiting:結果傳回中(回合結束、等雲端;之後別的回合在跑也算)/ 滿上限退回(timedOut)→ 要補抓",
      at({ endAt: 0 }) && at({ endAt: 0 }, { busy: true, turn: 9 }) && at({ endAt: 0, done: true, timedOut: true }));
    ok("① P2-1 送出的那一回合還在跑 → 不抓(wf.json 回合結束才寫;回合裡重跑回測會讓簽章對不上、「已送出」提早退掉)", !at({}, { busy: true }) && !at({ endAt: 0 }, { busy: true }));
    ok("① B10 wfAwaiting:失敗退回(done、沒 timedOut)/ 還在暖機(pending)/ 新結果已到(sig 不同)/ 本機視角 / 沒送過 / 別支 → 不抓",
      !at({ endAt: 0, done: true }) && !at({ pending: true, turn: null }) && !at({ sig: "OLD" }) && !at({ key: "local" }, { scope: "local" }) && !at(null) && !at({}, {}, { ...data, name: "c2" }));
    const rec = { sig, turn: 7, name: "c1", endAt: 0 }; W._sent.clear(); W._sent.set("cloud:c1", rec); const snap = JSON.stringify(rec);
    W.wfAwaiting(data, { ...cloud, now: () => W.WF_CLOUD_HOLD_MS * 3 });
    ok("① B10 wfAwaiting 不改紀錄(不記 endAt / done / timedOut——那是畫的時候 sentNow 的事)", JSON.stringify(rec) === snap);
    W._sent.clear();
  }

  // ── ① 0.1.11 B2 / B3:假 DOM 跑真的 renderWf,量結果頁的結論卡與兩段 legend(不開視窗)──
  {
    const flat = (n) => [n].concat(...(n.childNodes || []).map(flat));
    function node(tag) {
      const n = { tagName: tag.toUpperCase(), nodeType: 1, childNodes: [], parentNode: null, attrs: {}, style: { setProperty() {} }, dataset: {}, className: "",
        get classList() { const c = () => n.className.split(/\s+/).filter(Boolean); return { add: (x) => { if (!c().includes(x)) n.className = c().concat(x).join(" "); }, remove: (x) => { n.className = c().filter((y) => y !== x).join(" "); }, contains: (x) => c().includes(x) }; },
        setAttribute(k, v) { n.attrs[k] = String(v); }, getAttribute(k) { return k in n.attrs ? n.attrs[k] : null; }, addEventListener() {},
        appendChild(ch) { if (ch.nodeType === 11) { ch.childNodes.splice(0).forEach((x) => n.appendChild(x)); return ch; } ch.parentNode = n; n.childNodes.push(ch); return ch; },
        append(...xs) { xs.forEach((x) => n.appendChild(typeof x === "string" ? DOC.createTextNode(x) : x)); }, remove() {}, contains(x) { return flat(n).includes(x); },
        get textContent() { return n.childNodes.map((x) => x.textContent).join(""); }, set textContent(v) { n.childNodes = []; if (v !== "" && v != null) n.appendChild(DOC.createTextNode(String(v))); } };
      return n;
    }
    const DOC = { createElement: node, createTextNode: (s) => ({ nodeType: 3, textContent: String(s), childNodes: [] }), createDocumentFragment: () => ({ nodeType: 11, childNodes: [], appendChild(x) { this.childNodes.push(x); return x; } }),
      activeElement: null, body: node("body"), documentElement: node("html") };
    const dsb = { window: {}, console, document: DOC, getComputedStyle: () => ({ getPropertyValue: () => "" }) };
    vm.createContext(dsb);
    for (const f of ["report-backtest.js", "report-robust.js", "report-wf.js"]) vm.runInContext(fs.readFileSync(path.join(SHELL, "renderer", f), "utf8"), dsb);
    const S = vm.runInNewContext(fs.readFileSync(path.join(SHELL, "renderer", "strings.js"), "utf8").replace(/^const STRINGS/m, "var STRINGS") + "\nSTRINGS");
    const R = dsb.window.BlaveReport, DW = R._wf;
    const cls = (root, c) => flat(root).filter((x) => x.nodeType === 1 && x.className.split(/\s+/).includes(c));
    const one = (root, c) => cls(root, c)[0];
    const page = (lang, wf, code, rec) => {
      const t = (k) => S[lang][k], box = node("div"), data = { stats: STATS, wf, code: code == null ? CODE : code, name: "s1" };
      DW._sent.clear(); if (rec) DW._sent.set("local:s1", { sig: DW.sentSig(data), turn: 1, name: "s1", ...rec });
      R.renderWf(box, data, { t, busy: false, turn: 1, scope: "local", gate: true });
      const card = one(box, "wf-card"), legs = cls(box, "wf-legend"), mv = one(one(box, "wf-facts"), "bt-mv");
      return { card, first: card.childNodes[0].className, verdict: (one(card, "wf-verdict") || {}).textContent, mv: mv.textContent, band: one(mv, "wf-band"),
        tags: cls(box, "wf-tag").length + cls(box, "wf-status").length, chartLabel: cls(box, "bt-label")[0].textContent, legs: legs.map((l) => l.childNodes.map((x) => x.textContent)), all: box.textContent };
    };
    const zh = page("zh", SAMPLE), en = page("en", SAMPLE);
    ok("① B2 結論卡:頂上那一格沒有 tag,卡的第一塊就是比較表;樣本外效率那一列「0.99 · 高於門檻」(zh)/「0.99 · above the bar」(en),中性色",
      zh.tags === 0 && zh.first === "wf-cmp" && !zh.verdict && zh.mv === "0.99 · 高於門檻" && en.mv === "0.99 · above the bar" && !zh.band.classList.contains("is-risk"), JSON.stringify([zh.first, zh.mv, en.mv]));
    const far = page("zh", { ...SAMPLE, wfe: 0.1 }), none = page("zh", { ...SAMPLE, wfe: null }), noneEn = page("en", { ...SAMPLE, wfe: null });
    const lowIs = page("zh", { ...SAMPLE, is_stats: { ...SAMPLE.is_stats, "Sharpe Ratio": 0.2 } }), staleNone = page("zh", { ...SAMPLE, wfe: null }, "ENTRY_TH = 0.004\nEXIT_TH = -0.002\n");
    const css = fs.readFileSync(path.join(SHELL, "renderer", "report-wf.css"), "utf8");
    ok("① B2 遠低於門檻:判斷字上風險色(文字用 --color-redText,分隔點不上色)", far.mv === "0.10 · 遠低於門檻" && far.band.classList.contains("is-risk") && far.band.textContent === "遠低於門檻"
      && /\.wf-facts \.wf-band\.is-risk \{ color: var\(--color-redText\); \}/.test(css) && !/--color-red\)/.test(css), JSON.stringify(far.mv));
    ok("① D4 無法判斷(wfe 缺 / 樣本內 Sharpe < 0.25):值槽只放判斷字,沒有「—」也沒有「 · 」;過時又無法判斷 → 只有「—」",
      none.mv === "無法判斷" && noneEn.mv === "cannot be judged" && lowIs.mv === "無法判斷" && !cls(none.card, "na").length && staleNone.mv === "—" && !staleNone.band, JSON.stringify([none.mv, noneEn.mv, lowIs.mv, staleNone.mv]));
    const stale = page("zh", SAMPLE, "ENTRY_TH = 0.004\nEXIT_TH = -0.002\n"), tout = page("zh", SAMPLE, null, { done: true, timedOut: true });
    ok("① B2 頂上那一格只給警示:過時 → 「程式碼已變更…」、那一列只留數值;滿上限退回 → A2 那一句(B10 刪掉後半句)、判斷照留",
      stale.first === "wf-verdict" && stale.verdict === S.zh["wf.verdictStale"] && stale.mv === "0.99" && !stale.band
      && tout.first === "wf-verdict" && tout.verdict === "這次的結果沒傳回來，下面是上一次的。" && tout.mv === "0.99 · 高於門檻", JSON.stringify([stale.mv, tout.verdict]));
    ok("① B3 曲線 legend 三項(樣本外 / 重選線 / 末尾不足一輪,沒有「樣本內沒有曲線」);小標沒有「（測試窗接起來）」",
      JSON.stringify(zh.legs[0]) === JSON.stringify(["樣本外（每輪重選參數）", "重新選參數", "末尾 4 天不足一輪，未納入"]) && zh.chartLabel === "樣本外累積報酬" && en.chartLabel === "Out-of-Sample Cumulative Return", JSON.stringify([zh.legs[0], zh.chartLabel]));
    ok("① B3 落點圖 legend:格內數字 / 虛線框 / 不是建議值(driftLegRef 留著,「是哪幾輪…看下面的每輪明細」刪掉)",
      zh.legs[1].length === 3 && zh.legs[1][0] === S.zh["wf.driftLegCount"] && zh.legs[1][2] === S.zh["wf.driftLegRef"] && !/每輪明細/.test(zh.legs[1].join("")), JSON.stringify(zh.legs[1]));
    ok("① B3 刪掉的兩個 key 兩語都不在 strings.js、report-wf.js 也不再引用", ["zh", "en"].every((l) => !("wf.legNoIs" in S[l]) && !("wf.driftLegWhere" in S[l]))
      && !/wf\.legNoIs|wf\.driftLegWhere/.test(fs.readFileSync(path.join(SHELL, "renderer", "report-wf.js"), "utf8")));
    DW._sent.clear();
  }

  // ── ① 0.1.11 定稿字(精簡稽核 §4 B4 / B6 / B7 / B1 / B10;逐字)──
  {
    const S = vm.runInNewContext(fs.readFileSync(path.join(SHELL, "renderer", "strings.js"), "utf8").replace(/^const STRINGS/m, "var STRINGS") + "\nSTRINGS");
    const FIN = { zh: { "wf.emptyBoundary": "驗的是「用歷史挑參數」這個做法，不會給你新參數。", "wf.confirmBody": "約兩分鐘，結果會出現在這個分頁。", "wf.waitTimeout": "這次的結果沒傳回來，下面是上一次的。", "wf.colTer": "測試報酬" },
      en: { "wf.emptyBoundary": "It tests the method of picking parameters from history — it gives you no new parameters.", "wf.confirmBody": "Takes about two minutes; results appear in this tab.",
        "wf.waitTimeout": "This run’s results didn’t arrive — below is the previous run.", "wf.btnRerun": "Rerun Validation", "wf.colTer": "Test Return" } };
    const bad = [];
    for (const l of ["zh", "en"]) for (const [k, v] of Object.entries(FIN[l])) if (S[l][k] !== v) bad.push(l + ":" + k);
    ok("① B4 / B10 / B6 / B1 定稿字逐字(emptyBoundary、confirmBody、waitTimeout、btnRerun、colTer)", bad.length === 0, bad.join(", "));
    const ver = Object.entries(S.en).filter(([k]) => k.startsWith("ver."));
    ok("① B6 ver.* 的 en 沒有 re-run / Re-run(統一 rerun);B7 分頁維持 Trades,句子直接點名 Trades 分頁、parameter scan 全拼(設計稽核 0.1.11 D1 / D7)", ver.length > 20 && !ver.some(([, v]) => /re-run/i.test(v)) && /^The Trades tab fills in /.test(S.en["ver.frozenRerun"]) && S.en["rp.tab.trades"] === "Trades",
      ver.filter(([, v]) => /re-run/i.test(v)).map(([k]) => k).join(", "));
    // 0.1.11 追加(Wei 核准):en 全部的 re-run 都統一成 rerun,連送給 agent 的搬移句(ho.msg.*)也是;固定觸發句 wf.msgRun / rob.msgScan 本來就沒有這個字,也不能動
    const reRun = Object.entries(S.en).filter(([, v]) => /re-run/i.test(v)).map(([k]) => k);
    ok("① en 全部字串沒有 re-run / Re-run(rob.verdict.stale、res.notRerun、ho.msg.* / ho.note.* 都是 rerun)", reRun.length === 0
      && S.en["rob.verdict.stale"] === "The backtest was rerun — the current position updates after a rescan." && S.en["res.notRerun"] === "Not rerun yet", reRun.join(", "));
    ok("① 讀屏的曲線描述(wf.chartAria)也拿掉「（測試窗接起來）」,跟 chartLabel 一致",
      S.zh["wf.chartAria"] === "樣本外累積報酬：累積報酬 {r}，區間 {a} 至 {b}；每 {d} 天重新選一次參數" && S.en["wf.chartAria"] === "Out-of-sample cumulative return: cumulative return {r}, {a} to {b}; parameters re-picked every {d} days");
  }

  // ── ① 跟雲端工作頁那一份逐項比 ──
  const WEB = process.env.BLAVE_WEB_DIR || path.join(__dirname, "..", "..", "web");
  const WS = path.join(WEB, "app", "main", "templates", "agent", "workspace.html");
  if (!fs.existsSync(WS)) console.log("SKIP  ① 雲端那一份比對(需要 web 樹:BLAVE_WEB_DIR 或 monorepo 的 ../web)");
  else {
    const src = fs.readFileSync(WS, "utf8");
    const fnSrc = (name) => {   // 從 "function name(" 起,數大括號切到收尾
      const at = src.indexOf("function " + name + "(");
      if (at < 0) throw new Error("web 沒有 " + name);
      let i = src.indexOf("{", at), depth = 0;
      for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}" && --depth === 0) break; }
      return src.slice(at, i + 1);
    };
    const consts = [...src.matchAll(/^\s*const (WF_(?:MIN_DENOM|MIN_RUNS|MAX_RUNS|MARK_LINE_MAX|MARK_TICK_MAX|MAX_POINTS|MAX_DAYS|STR_MAX|STAT_KEYS)|ROB_MAX_DIM) = [^;]+;/gm)].map((m) => m[0].trim());
    const FNS = ["wfNum", "wfPosInt", "wfStr", "wfStats", "wfPairVals", "wfSame", "wfDays", "sanitizeWf", "wfBand", "wfPreset", "wfRunsOf", "wfTotalDays", "wfMarkMode", "wfRunMarks",
      "robNumList", "robConstFromCode", "robLocate", "robDecimals"];
    let web = null;
    try {
      const ctx = { console };
      vm.createContext(ctx);
      vm.runInContext(consts.join("\n") + "\n" + FNS.map(fnSrc).join("\n") + "\nthis.__W = { sanitizeWf, wfBand, wfPreset, wfRunsOf, wfTotalDays, wfMarkMode, wfRunMarks };", ctx);
      web = ctx.__W;
    } catch (e) { ok("① 從 web workspace.html 切得出 wf 那一組函式", false, e.message); }
    if (web) {
      const runs44 = Array.from({ length: 44 }, (_, i) => ({ ...SAMPLE.runs[i % 11], k: i + 1 }));
      const CASES = [[SAMPLE, CODE], [SAMPLE, ""], [SAMPLE, "ENTRY_TH = 0.004\nEXIT_TH = -0.002\n"], [ONE, "ENTRY_TH = 0.002\n"], [ONE, "ENTRY_TH = 0.006\n"],
        [{ ...SAMPLE, runs: runs44, n_runs: 44 }, CODE], [{ ...SAMPLE, excluded_runs: undefined }, CODE], [{ ...SAMPLE, excluded_runs: undefined, runs: SAMPLE.runs.map((r, i) => (i === 2 ? { ...r, train_sharpe: 0 } : r)) }, CODE], [{ ...SAMPLE, wfe: null }, CODE],
        [{ ...SAMPLE, is_stats: { ...SAMPLE.is_stats, "Sharpe Ratio": 0.2 } }, CODE], [{ ...SAMPLE, runs: SAMPLE.runs.map((r, i) => (i === 3 ? { ...r, k: "4" } : r)) }, CODE],
        [{ ...SAMPLE, oos: { dates: SAMPLE.oos.dates, cum: SAMPLE.oos.cum.slice(1) } }, CODE], [{ ...SAMPLE, row_vals: [1, "2"] }, CODE], [{ ...SAMPLE, current: [1] }, ""],
        [{ ...SAMPLE, tail_days: -1 }, CODE], ...BAD.map((b) => [b, CODE])];
      const diff = CASES.map(([x, code], i) => [i, JSON.stringify(W.sanitizeWf(x, code)), JSON.stringify(web.sanitizeWf(x, code))]).filter(([, a, b]) => a !== b);
      ok("① sanitizeWf:" + CASES.length + " 份輸入,本機這份跟雲端那份輸出逐字相同", diff.length === 0, diff.map(([i]) => "case " + i).join(", "));
      const bands = CASES.map(([x, code]) => { const a = W.sanitizeWf(x, code); return a ? [W.wfBand(a), web.wfBand(a), W.wfMarkMode(a.runs ? a.runs.length : 0), web.wfMarkMode(a.runs ? a.runs.length : 0), JSON.stringify(W.wfRunMarks(a)), JSON.stringify(web.wfRunMarks(a))] : null; }).filter(Boolean);
      ok("① wfBand / wfMarkMode / wfRunMarks 在同一批結果上兩邊一樣", bands.every((b) => b[0] === b[1] && b[2] === b[3] && b[4] === b[5]));
      const days = [0, 30, 90, 120, 364, 454, 455, 700, 1184, 1185, 3000, 12000];
      ok("① wfPreset / wfRunsOf / wfTotalDays 兩邊一樣", days.every((d) => JSON.stringify(W.wfPreset(d)) === JSON.stringify(web.wfPreset(d)) && [[365, 30], [1095, 30], [30, 1], [0, 30], [d, 30]].every(([l, s]) => W.wfRunsOf(d, l, s) === web.wfRunsOf(d, l, s)))
        && [STATS, {}, { start: "x", end: "2024-01-01" }].every((bt) => W.wfTotalDays(bt, w0) === web.wfTotalDays(bt, w0)));
    }
    // 雲端那份還沒換上 wfTicks 之前只記一行 SKIP(前端照 0.1.12 交接改完,這段自動變成逐項比)
    if (!src.includes("function wfTicks(")) console.log("SKIP  ① wfTicks 兩邊比對(web workspace.html 還沒有 wfTicks)");
    else {
      let webT = null;
      try {
        const ctx = { console }; vm.createContext(ctx);
        vm.runInContext("const WF_GRID_MAX_LINES = 24;\n" + ["wfTicks", "wfTickLabel"].map(fnSrc).join("\n") + "\nthis.__T = { wfTicks, wfTickLabel };", ctx);
        webT = ctx.__T;
      } catch (e) { ok("① 從 web workspace.html 切得出 wfTicks / wfTickLabel", false, e.message); }
      if (webT) {
        const R = [[-141.4, 1836.4], [-1, 1], [-0.024, 0.324], [-64.8, 4.8], [-0.96, 12.96], [-8, 108], [2, 1], [-1e5, 1e6]];
        ok("① wfTicks / wfTickLabel 兩邊一樣", R.every(([a, b]) => { const x = W.wfTicks(a, b), y = webT.wfTicks(a, b); return JSON.stringify(x) === JSON.stringify(y) && x.ticks.every((v) => W.wfTickLabel(v, x.dp) === webT.wfTickLabel(v, y.dp)); }));
      }
    }
  }

  // ── ③ 接線 ──
  const read = (f) => fs.readFileSync(path.join(SHELL, f), "utf8");
  const main = read("main.js"), app = read("renderer/app.js"), ver = read("renderer/versions.js"), html = read("renderer/index.html"), res = read("renderer/results.js"), tr = read("renderer/trade.js");
  const fn = (n) => main.slice(main.indexOf("function " + n + "("), main.indexOf("\n}\n", main.indexOf("function " + n + "(")));
  ok("③ loadStrategy 讀 strategies/<name>/wf.json(同 scan.json 走 readResultJson);回傳帶 wf", /readResultJson\(path\.join\(dir, "wf\.json"\)\)/.test(fn("loadStrategy")) && /return \{ name, stats, scan, wf, code,/.test(fn("loadStrategy")));
  { // readResultJson(稽核 P2-6):agent 寫的結果檔只讀一般檔、≤2MB、是物件;其餘一律 null(主行程同步讀,過大的檔會卡住 app)
    const os = require("os"), tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "wf-read-"));
    const ctx = { fs, require, console, Buffer }; vm.createContext(ctx);
    vm.runInContext(main.slice(main.indexOf("const RESULT_JSON_MAX"), main.indexOf("function loadStrategy(")) + "\nthis.readResultJson = readResultJson; this.MAX = RESULT_JSON_MAX;", ctx);
    const at = (n, body) => { const p = path.join(tmp, n); fs.writeFileSync(p, body); return p; };
    const good = at("wf.json", JSON.stringify(SAMPLE)), arr = at("arr.json", "[1]"), half = at("half.json", '{"a":'), big = at("big.json", '{"a":"' + "x".repeat(ctx.MAX) + '"}');
    const link = path.join(tmp, "link.json"); fs.symlinkSync(good, link);
    let fifo = null; try { require("child_process").execFileSync("mkfifo", [path.join(tmp, "fifo.json")]); fifo = path.join(tmp, "fifo.json"); } catch (_) { /* 沒有 mkfifo 就少驗這一種 */ }
    ok("③ readResultJson:正常 → 物件;陣列 / 寫到一半 / 超過 2MB / symlink / FIFO(不卡住)/ 不存在 → null",
      ctx.readResultJson(good).n_runs === 11 && [arr, half, big, link, fifo, path.join(tmp, "none.json")].filter(Boolean).every((p) => ctx.readResultJson(p) === null) && ctx.MAX === 2 * 1024 * 1024 && (!!fifo || process.platform === "win32"));
    { // 讀的時候還在長大:fstat 說 7 bytes、實際更長;前 8 bytes「{"a":1} 」本身是合法 JSON——只有「讀超過就不收」那一條擋得住(開檔與讀都是真的,只有 fstat 報小)
      const g = at("grow.json", '{"a":1} {"b":2}');
      const grow = { fs: { ...fs, constants: fs.constants, fstatSync: (fd) => { const r = fs.fstatSync(fd); return { isFile: () => r.isFile(), size: 7 }; } }, require, console, Buffer };
      vm.createContext(grow); vm.runInContext(main.slice(main.indexOf("const RESULT_JSON_MAX"), main.indexOf("function loadStrategy(")) + "\nthis.readResultJson = readResultJson;", grow);
      ok("③ readResultJson:比 fstat 說的還長(讀的時候還在長大 / 被換掉)→ null", grow.readResultJson(g) === null && ctx.readResultJson(good) !== null); }
    const rsrc = main.slice(main.indexOf("function readResultJson("), main.indexOf("function loadStrategy("));
    ok("③ readResultJson 開檔用 O_NOFOLLOW + O_NONBLOCK、檢查 fstat(fd)、最多讀上限 + 1 byte(複驗 P2-R5:不先 lstat 路徑再另外讀)",
      /fs\.openSync\(p, C\.O_RDONLY \| \(C\.O_NOFOLLOW \|\| 0\) \| \(C\.O_NONBLOCK \|\| 0\)\)/.test(rsrc) && /fs\.fstatSync\(fd\)/.test(rsrc) && /Math\.min\(st\.size, RESULT_JSON_MAX\) \+ 1/.test(rsrc) && !/readFileSync/.test(rsrc));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  ok("③ listStrategies 交出 wfMtime、算進最近動過;結果卡的簽章(results.js resSig)不看它——web 沒有 wf 結果卡",
    /wfMtime = fs\.statSync\(path\.join\(dir, "wf\.json"\)\)\.mtimeMs/.test(fn("listStrategies")) && /scanMtime: scMtime, wfMtime,/.test(fn("listStrategies")) && /x\.wfMtime \|\| 0/.test(main.slice(main.indexOf("const stratTouchedAt"), main.indexOf("const stratOrder"))) && !/wf/i.test(res.slice(res.indexOf("function resSig"), res.indexOf("function resStratItem"))));
  ok("③ stratRefresh:只跑了驗證的那一輪(wfMtime 變了)開著的那支也原地重讀", /if \(was && now && \(resStratSub\(was, now\) \|\| \(now\.wfMtime \|\| 0\) !== \(was\.wfMtime \|\| 0\)\)\) \{ await stratReload\(RP\.name\); return; \}/.test(app));
  const { interpretStrategy } = require(path.join(SHELL, "cloud.js"));
  ok("③ cloud.js interpretStrategy 留 wf(物件才給,否則 null)", interpretStrategy({ status: 200, body: { strategy: { name: "m", wf: SAMPLE } } }, "m").strategy.wf.n_runs === 11 && interpretStrategy({ status: 200, body: { strategy: { name: "m", wf: [1] } } }, "m").strategy.wf === null);
  ok("③ 分頁列:參數掃描之後、程式碼之前;面板、css、js 都在;js 在 report-robust.js 之後(借它的 _rob)",
    /data-tab="rob" data-i18n="rp\.tab\.rob"><\/button>\s*<button class="rp-tab" type="button" role="tab" data-tab="wf" data-i18n="rp\.tab\.wf"><\/button>\s*<button[^>]*data-tab="code"/.test(html)
    && /id="rp-wf" role="tabpanel" hidden/.test(html) && /report-wf\.css/.test(html) && /<script src="report-robust\.js"><\/script>\s*<script src="report-wf\.js"><\/script>/.test(html));
  ok("③ rpShowTab 把 wf 交給 renderWf(t / busy / turn / scope / gate / onRun / onUpdate / buildMeta 從外面交進去);三處回合開始 / 結束都叫 rpWfSync;雲端狀態輪詢也叫(閘門翻面)",
    /R\.renderWf\(\$\("rp-wf"\), rpWfData\(B\.data, B\.name\), rpWfOpts\(\)\)/.test(app) && /function rpWfData\(data, name\) \{ return \{ stats: data\.stats, wf: data\.wf \|\| null, code: data\.code, name \}; \}/.test(app)
    && /return \{ t, busy: running, turn: turnSeq, scope: cloud \? "cloud" : "local", gate, onRun: rpWfAsk, onUpdate: rpWfUpdate, buildMeta: R\.buildMeta,\s*resync: rpWfSync, refocus: rpWfRefocus, refetch: rpWfRefetch \};/.test(app)
    && /window\.BlaveReport\.wfTurnEnded\(turnSeq, faulted \|\| stopped, \{ refetch: rpWfRefetch \}\);\n  upTurnEnded\(faulted\);\n  running = false;[^\n]*rpWfSync\(\);/.test(app)
    && /const gate = !cloud \? true : typeof c\.config_supports_wf === "boolean" \? c\.config_supports_wf : null;/.test(app)
    && (app.match(/rpRobSync\(\); rpWfSync\(\);/g) || []).length === 3 && /if \(typeof rpWfSync === "function"\) rpWfSync\(\);/.test(tr));
  ok("③ 送出:確認框 → 先 begin()(暖機那段也算已送出,稽核 P2-1)→ 固定訊息(msgRun,name 傳資料夾名)→ 成功才記 wf_requested、回合序號;不覆寫 viewing",
    /onOk: \(\) => \{ if \(typeof begin === "function"\) begin\(\); rpWfAuto\.delete\(name\); submitMessage\(t\("wf\.msgRun", \{ name, lookback: String\(lookback\), step: String\(step\) \}\)\)\.then\(\(ok\) => \{ if \(ok\) trackFeature\("wf_requested"\); resolve\(ok \? turnSeq : false\); \}\); \}/.test(app)
    && !/viewing/.test(app.slice(app.indexOf("function rpWfAsk"), app.indexOf("function rpWfUpdate"))) && /lines: \(behindMaybe \? \[t\("wf\.needUpdate"\)\] : \[\]\)\.concat\(\[t\("wf\.emptyBoundary"\), t\("wf\.confirmBody"\)\]\)/.test(app));
  ok("③ 還原凍結:時光機 / 重跑中 wf 分頁跟進出場、參數掃描一起 disabled、面板一起收", /b\.disabled = b\.dataset\.tab === "tr" \|\| b\.dataset\.tab === "rob" \|\| b\.dataset\.tab === "wf";/.test(ver) && /for \(const k of \["bt", "tr", "rob", "wf", "code"\]\) \$\("rp-" \+ k\)\.hidden = true;/.test(ver));

  { const css = read("renderer/report-wf.css"), wfjs = read("renderer/report-wf.js"), robjs = read("renderer/report-robust.js");
    ok("③ R1 每輪明細:表頭固定 58(折不折行看資料不看語言),捲動框上限 = 表頭 + 12.5 列 × 50(12 輪不捲、13 輪起固定露出半列)",
      /\.wf-run-tbl thead th \{ vertical-align: bottom; height: 58px; \}/.test(css) && /\.wf-scroll \{\s*max-height: calc\(58px \+ 12\.5 \* 50px\);/.test(css) && !/en 58/.test(css));
    ok("③ R2 拿著焦點的鈕被停用前先交給分頁鈕(樣本外驗證 setDis、參數掃描 syncEmpty);送不出去時焦點落在 body 也交回;app.js 兩支 refocus",
      /const setDis = \(v\) => \{ if \(v && !btn\.disabled && document\.activeElement === btn && typeof opts\.refocus === "function"\) opts\.refocus\(\); btn\.disabled = v; \};/.test(wfjs)
      && !/[^.]btn\.disabled = (locked|true)/.test(wfjs.slice(wfjs.indexOf("function recalc"), wfjs.indexOf("function setBusy")))
      && /if \(opts\.busy && !st\.btn\.disabled && document\.activeElement === st\.btn && typeof opts\.refocus === "function"\) opts\.refocus\(\);\s*st\.btn\.disabled = !!opts\.busy;/.test(robjs)
      && (wfjs.match(/if \(document\.activeElement === document\.body && typeof opts\.refocus === "function"\) opts\.refocus\(\);/g) || []).length === 1
      && (robjs.match(/if \(document\.activeElement === document\.body && typeof opts\.refocus === "function"\) opts\.refocus\(\);/g) || []).length === 1
      && /function rpRobRefocus\(\) \{ const b = \$\("rp-tabs-scroll"\)\.querySelector\('\.rp-tab\[data-tab="rob"\]'\); if \(b && !b\.disabled\) b\.focus\(\); \}/.test(app)); }

  { // rpWfRefetch(複驗 P2-R1 / P2-R2):綁送出那一支、只在背景抓、抓到不同才換;人在別的分頁只換資料不重畫
    // 沙盒裡的 Promise 換成同步 thenable:抓回來的那一段當場跑完,斷言不必等 microtask(不然會落在總結之後)
    const src = app.slice(app.indexOf("function rpWfRefetch("), app.indexOf("\n", app.indexOf("function rpWfData(")) + 1);
    const SyncP = { resolve: (v) => ({ then: (f) => { f(v); return { catch: () => {} }; } }) };
    const D1 = { v: 1, wf: { a: 1 }, code: "c", stats: { "Generated At": 5, "Sharpe Ratio": 1 } }, D2 = { ...D1, v: 2, wf: { a: 2 } };
    const mk = (x) => { const c = { ENV: { cur: "cloud" }, RPC: { name: "A", tab: "wf", drawn: { wf: true, tr: true }, data: D1 }, RPC_CACHE: new Map([["A", D1]]), paints: 0, loads: [], next: D2, swap: false, console, Promise: SyncP, JSON, ...(x || {}) };
      c.window = { BlaveReport: { wfSig: W.sentSig } };
      c.TR_BAGS = { cloud: { api: { loadStrategy: (n) => { c.loads.push(n); if (c.swap) c.RPC.name = "X"; return c.next; } } } }; c.rpCloudPaint = () => { c.paints++; }; vm.createContext(c); vm.runInContext(src + "\nthis.f = rpWfRefetch;", c); return c; };
    let c = mk(); const r1 = c.f("B");
    ok("③ rpWfRefetch:人已經不在送出那一支(看的是 A,送出的是 B)→ 回 false、不抓(計時由 report-wf 收);不走 rpCloudSelect", r1 === false && c.loads.length === 0 && !/rpCloudSelect/.test(src));
    c = mk(); c.ENV.cur = "local"; ok("③ rpWfRefetch:換到本機視角 → 回 false、不抓", c.f("A") === false && c.loads.length === 0);
    c = mk(); c.f("A");
    ok("③ rpWfRefetch:在樣本外驗證分頁、抓到不同 → 換資料、清 drawn、重畫一次", c.loads.join() === "A" && c.RPC.data.v === 2 && c.RPC_CACHE.get("A").v === 2 && c.paints === 1 && Object.keys(c.RPC.drawn).length === 0);
    c = mk(); c.RPC.tab = "tr"; c.f("A");
    ok("③ rpWfRefetch:人在別的分頁(進出場)、抓到不同 → 只換資料,不重畫眼前那一頁(K 線縮放、選取、焦點不動),wf 留給切過去時畫", c.RPC.data.v === 2 && c.paints === 0 && JSON.stringify(c.RPC.drawn) === '{"tr":true}');
    c = mk(); c.next = { ...D1, v: 3, stats: { ...D1.stats, "Sharpe Ratio": 2 } }; c.f("A");
    ok("③ P2-2 live 策略每根 K 重寫績效(wf / 碼 / 明確回測都沒變):只換資料、不重畫眼前的樣本外驗證(網格 hover、焦點、捲動不被重設);別的分頁下次切過去再畫",
      c.RPC.data.v === 3 && c.RPC_CACHE.get("A").v === 3 && c.paints === 0 && JSON.stringify(c.RPC.drawn) === '{"wf":true}');
    c = mk(); c.next = { ...D1, stats: { ...D1.stats, "Generated At": 6 } }; c.f("A");
    ok("③ P2-2 明確回測(Generated At)變了照重畫(那是另一份結果)", c.paints === 1);
    c = mk(); c.next = D1; c.f("A");
    ok("③ rpWfRefetch:抓到一樣的 → 什麼都不動", c.paints === 0 && c.RPC.drawn.wf === true && c.loads.length === 1);
    c = mk(); c.swap = true; const p2 = c.f("A");
    ok("③ rpWfRefetch:抓的時候人換了一支 → 抓回來的不套上去", p2 === true && c.RPC.data.v === 1 && c.paints === 0);
  }

  { // 0.1.11 B10 rpWfAutoRefetch:切回分頁 / 視窗回前景補抓一次;只抓眼前那一支、只在等結果時、退避加上限(P2-3)、不掛計時器
    const a0 = app.indexOf("const RP_WF_AUTO_GAP_MS"), a1 = app.indexOf("\n", app.indexOf("window.blave.onWindowActive", a0)) + 1, src = app.slice(a0, a1);
    const mk = (x) => { const c = { ENV: { cur: "cloud" }, RPC: { name: "A", data: { wf: 1, code: "x", stats: {} } }, asked: [], fetched: [], listeners: [], awaiting: true, timers: 0, Date: { now: () => 1e6 },
      setTimeout: () => { c.timers++; }, setInterval: () => { c.timers++; }, Map, Math, rpWfData: (d, name) => ({ stats: d.stats, wf: d.wf || null, code: d.code, name }), ...(x || {}) };
      c.window = { BlaveReport: { wfAwaiting: (d, o) => { c.asked.push([d.name, o.scope]); return c.awaiting; } }, blave: { onWindowActive: (fn) => c.listeners.push(fn) } };
      c.rpWfOpts = () => ({ scope: c.ENV.cur === "cloud" ? "cloud" : "local" }); c.rpWfRefetch = (n) => { c.fetched.push(n); return true; };
      vm.createContext(c); vm.runInContext(src + "\nthis.f = rpWfAutoRefetch;", c); return c; };
    let c = mk(); c.f(0);
    ok("③ B10 等結果中:問 wfAwaiting 的是眼前那一支(名字 = RPC.name、scope 雲端),是就用 rpWfRefetch 背景抓那一支", JSON.stringify(c.asked) === '[["A","cloud"]]' && c.fetched.join() === "A");
    c = mk({ awaiting: false }); c.f(0); ok("③ B10 不在等結果(失敗退回 / 新結果已到 / 沒送過):不抓", c.fetched.length === 0);
    c = mk(); c.ENV.cur = "local"; c.f(0); ok("③ B10 本機視角:不問、不抓", c.asked.length === 0 && c.fetched.length === 0);
    c = mk(); c.RPC.name = null; c.f(0); ok("③ B10 沒在看報告(關掉 / 去策略庫):不抓", c.fetched.length === 0);
    { c = mk(); const S = 1000, times = [];   // 每秒來回切一次視窗,切一個小時:第 k 次之後隔 10 秒 × 2^(k-1)(上限 10 分鐘),一段等待最多 8 次
      for (let t = 0; t <= 3600 * S; t += S) { const n = c.fetched.length; c.f(t); if (c.fetched.length > n) times.push(t / S); }
      ok("③ P2-3 退避加上限:間隔 10、20、40、80、160、320、600 秒(10 分鐘封頂),一段等待最多 8 次(api 跟 LLM 共用每分鐘 30 次的桶)", JSON.stringify(times) === "[0,10,30,70,150,310,630,1230]", JSON.stringify(times));
      c.RPC.name = "B"; c.f(3601 * S); const b1 = c.fetched.slice(-1)[0];
      c.RPC.name = "A"; c.awaiting = false; c.f(3602 * S); c.awaiting = true; c.f(3603 * S);
      ok("③ P2-3 計數各支分開(換一支照抓);不在等了(新結果到了 / 重新送出)就歸零,下一段等待重新起算", b1 === "B" && c.fetched.slice(-1)[0] === "A" && c.fetched.length === 10, c.fetched.join()); }
    c = mk();
    ok("③ B10 視窗回前景:模組載入時只註冊一次;拿到焦點(true)才抓,失焦(false)不抓;整段不掛任何計時器",
      c.listeners.length === 1 && (c.listeners[0](false), c.fetched.length === 0) && (c.listeners[0](true), c.fetched.join() === "A") && c.timers === 0 && !/set(Timeout|Interval)/.test(src));
    { // 複驗 R-P2-1:第一段抓滿 8 次 → 重新送出 → 回合中一次都沒切視窗、沒點分頁(兩段之間沒有任何 awaiting=false 的呼叫)→ 第二段照樣抓
      const ask = app.slice(app.indexOf("function rpWfAsk("), app.indexOf("\n}\n", app.indexOf("function rpWfAsk(")) + 2);
      c = mk(); Object.assign(c, { confirmBox: (o) => o.onOk(), rpBag: () => c.RPC, rpWfCloud: () => ({ config_supports_wf: true }), upNow: () => ({}), UPD: {}, turnSeq: 5, t: (k) => k, trackFeature: () => {},
        submitMessage: () => ({ then: (f) => f(true) }), Promise: function (fn) { fn(() => {}); } });
      vm.runInContext(ask + "\nthis.ask = rpWfAsk;", c);
      for (let k = 0; k < 40; k++) c.f(k * 700 * 1000);
      const first = c.fetched.length; c.f(60 * 60 * 1000); const capped = c.fetched.length === first;
      c.ask("A", 365, 30, true, null, () => {}); c.f(61 * 60 * 1000);
      ok("③ R-P2-1 重新送出(rpWfAsk 的 onOk)就把那一支的補抓次數歸零:上一段抓滿 8 次、中間沒有任何呼叫,新的一段照樣抓", first === 8 && capped && c.fetched.length === 9, c.fetched.length); }
    ok("③ P2-4 判斷要不要補抓用 rpWfData(跟畫的那一份同一個組法)", /R\.wfAwaiting\(rpWfData\(RPC\.data, RPC\.name\), rpWfOpts\(\)\)/.test(src));
    ok("③ B10 接線:分頁列 click 在 rpShowTab 之後、選的是 wf 才叫(先畫才會把滿上限那筆記成 timedOut);app.js 只有這一處 onWindowActive",
      /rpShowTab\(b\.dataset\.tab\); trackFeature\(RP_TAB_FEATURE\[b\.dataset\.tab\]\);\n  if \(b\.dataset\.tab === "wf"\) rpWfAutoRefetch\(\);/.test(app) && (app.match(/onWindowActive\(/g) || []).length === 1
      && (app.match(/rpWfAutoRefetch\(/g) || []).length === 3);
  }

  { // B5 固定觸發句只顯示一行摘要(設計精簡稽核 B5):fixedMatch / fixedName / fixedLabel 從 app.js 原文切出來,配真的 strings.js 與 i18n.js 的 t()
    const src = app.slice(app.indexOf("const FIXED_PROMPTS"), app.indexOf("const RECEIPT_RE"));
    const trSrcFn = (nm) => { const i = tr.indexOf("function " + nm + "("); return tr.slice(i, tr.indexOf("\n}\n", i) + 2); };
    const ctx = { console, RP: { list: [{ name: "btc_sma", displayName: "BTC 均線交叉" }] }, TR_BAGS: { cloud: { st: { cloud: { strategies: [{ name: "tw_2330", display_name: "台積電 動能" }] } } } } };
    vm.createContext(ctx);
    vm.runInContext(read("renderer/strings.js").replace(/^const STRINGS/m, "var STRINGS") + "\n" + read("renderer/i18n.js").replace(/^let LANG/m, "var LANG") + "\n"
      + trSrcFn("envCloudList") + "\n" + src + "\nthis.fm = fixedMatch; this.fl = fixedLabel;", ctx);
    const T = (l, k, v) => { ctx.LANG = l; return vm.runInContext("t(" + JSON.stringify(k) + ", " + JSON.stringify(v) + ")", ctx); };
    const at = (l, text, which) => { ctx.LANG = l; return ctx.fl(text, which); };
    const V = { name: "btc_sma", lookback: "1095", step: "30" };
    const wzh = T("zh", "wf.msgRun", V), wen = T("en", "wf.msgRun", V), szh = T("zh", "rob.msgScan", { name: "tw_2330" }), sen = T("en", "rob.msgScan", { name: "tw_2330" });
    ok("③ B5 命中(zh):樣本外驗證的整句 → 泡泡「對 BTC 均線交叉 做樣本外驗證(訓練窗 1095 天、測試窗 30 天)」、標題「BTC 均線交叉 · 樣本外驗證」(名稱從策略清單查)",
      at("zh", wzh) === "對 BTC 均線交叉 做樣本外驗證（訓練窗 1095 天、測試窗 30 天）" && at("zh", wzh, "title") === "BTC 均線交叉 · 樣本外驗證");
    ok("③ B5 命中(en):英文整句在 en 介面 → en 摘要;參數掃描兩語也命中(名稱從雲端清單查)",
      at("en", wen) === "Run out-of-sample validation on BTC 均線交叉 (train 1095 days, test 30 days)" && at("en", wen, "title") === "BTC 均線交叉 · Out-of-Sample"
      && at("zh", szh) === "掃描 台積電 動能 的參數" && at("en", sen, "title") === "台積電 動能 · Parameter Scan");
    ok("③ B5 跨語言:en 送出的整句在 zh 介面也認得,摘要照現在的語言", at("zh", wen) === "對 BTC 均線交叉 做樣本外驗證（訓練窗 1095 天、測試窗 30 天）" && at("en", szh) === "Scan the parameters of 台積電 動能");
    const MISS = [wzh + " ", wzh.slice(0, -1), "嗨 " + wzh, wzh.replace("1095", "一千"), wzh.replace("1095", ""), sen + "\n再幫我畫圖", "掃描 tw_2330 的參數", "", null];
    ok("③ B5 不命中:多一個字 / 少一個字 / 前面多講一句 / 天數不是數字或是空的 / 後面多一行 / 只寫了摘要那句 → null(照原文畫)", MISS.every((m) => at("zh", m) === null));
    // 0.1.9 就出貨的參數掃描觸發句(0.1.3 起沒改過):session.db 裡的舊對話原文要認得。改了 rob.msgScan 的字,這條會紅——提醒舊泡泡會變回全文
    const OLD = { zh: "請掃描策略 btc_sma 的參數（lib.param_scan：scan_grid → find_plateau → write_scan → plot_heatmap），範圍由你依指標分佈決定，掃完回報尖峰與穩健點。",
      en: "Please scan the parameters of strategy btc_sma (lib.param_scan: scan_grid → find_plateau → write_scan → plot_heatmap). Choose the ranges from the indicator distribution, then report the peak and the robust point." };
    ok("③ B5 舊紀錄:0.1.9 出貨的參數掃描原句(zh / en)照樣換成摘要", at("zh", OLD.zh) === "掃描 BTC 均線交叉 的參數" && at("en", OLD.en) === "Scan the parameters of BTC 均線交叉");
    const odd = ["a.b(c)*+?[x]", "x 做 walk-forward 樣本外驗證：訓練窗 7 天"];
    ok("③ B5 名稱帶 regex 特殊字元、或含模板的分隔字時照樣抓對(錨定 + 最短比對往後擴到整句成立);清單查不到 → 退回代號",
      odd.every((n) => { const m = ctx.fm(T("zh", "wf.msgRun", { name: n, lookback: "365", step: "30" }), ctx.STRINGS); return m && m.vars.name === n && m.vars.lookback === "365" && m.vars.step === "30"; })
      && at("zh", T("zh", "wf.msgRun", { name: "unknown_x", lookback: "365", step: "30" }), "title") === "unknown_x · 樣本外驗證");
    ok("③ B5 接線:只換顯示——addMsg 的用戶泡泡、對話標題(含 tooltip)、清單列都走 fixedLabel;送出的仍是原句(msgRun 不動);listSessions 不截 120(摘要之後才截)",
      /const lab = fixedLabel\(text\);\n    b\.className = "bubble"; b\.textContent = lab \|\| text;[^\n]*\n    if \(lab\) b\._fixed = text;/.test(app) && /function youRelang\(\) \{[^\n]*b\.textContent = fixedLabel\(b\._fixed\) \|\| b\._fixed;/.test(app) && /const shown = csTitle \? fixedLabel\(csTitle, "title"\) \|\| csTitle : "";[^\n]*\n  \$\("cs-title"\)\.textContent = shown \|\| t\("cs\.new"\);\n  \$\("cs-title"\)\.title = shown;/.test(app)
      && /const fixedTitle = m\.title \? fixedLabel\(m\.title, "title"\) : null;\n  name\.textContent = fixedTitle \|\| \(m\.title \|\| ""\)\.slice\(0, 120\) \|\| t\("cs\.new"\);/.test(app)
      && /title: String\(r\.title \|\| ""\)\.slice\(0, 4000\)/.test(fn("listSessions")) && /submitMessage\(t\("wf\.msgRun", \{ name, lookback: String\(lookback\), step: String\(step\) \}\)\)/.test(app)
      && (app.match(/fixedLabel\(/g) || []).length === 5);   // 第五處是 youRelang(切語言時重組泡泡的摘要)
    const B5 = { zh: { "wf.msgRunLabel": "對 {name} 做樣本外驗證（訓練窗 {lookback} 天、測試窗 {step} 天）", "wf.msgRunTitle": "{name} · 樣本外驗證", "rob.msgScanLabel": "掃描 {name} 的參數", "rob.msgScanTitle": "{name} · 參數掃描" },
      en: { "wf.msgRunLabel": "Run out-of-sample validation on {name} (train {lookback} days, test {step} days)", "wf.msgRunTitle": "{name} · Out-of-Sample", "rob.msgScanLabel": "Scan the parameters of {name}", "rob.msgScanTitle": "{name} · Parameter Scan" } };
    { const long = "超長策略名稱".repeat(20) + "尾", tt = at("zh", T("zh", "wf.msgRun", { name: "long_x", lookback: "365", step: "30" }).replace("long_x", "long_x"), "title");
      ctx.RP.list.push({ name: "long_x", displayName: long }); const t2 = at("zh", T("zh", "wf.msgRun", { name: "long_x", lookback: "365", step: "30" }), "title");
      ok("③ B5 標題不截策略名:121 字的名稱整串留著、後綴照接(清單列不再對固定觸發句套 120 字截斷)", t2 === long + " · 樣本外驗證" && long.length > 120 && tt === "long_x · 樣本外驗證"); }
    ok("③ B5 四個 key = 精簡稽核定稿(zh / en)", ["zh", "en"].every((l) => Object.entries(B5[l]).every(([k, v]) => ctx.STRINGS[l][k] === v)));
  }

  // 字串:wf.* 與 rp.tab.wf 逐字 = web 的 msgstr(key 名照電腦版慣例,字不改);msgRun 尤其不能改(references/lib.md 拿它當觸發句)
  const sj = read("renderer/strings.js"), block = (l) => sj.split(`  ${l}: {`)[1].split("\n  },")[0];
  const vals = (b) => Object.fromEntries([...b.matchAll(/^\s*("(?:[^"\\]|\\.)*"): ("(?:[^"\\]|\\.)*"),?$/gm)].map((m) => [JSON.parse(m[1]), JSON.parse(m[2])]));
  const DT = { en: vals(block("en")), zh: vals(block("zh")) };
  // 設計精簡稽核 A7 / A8 的定稿(逐字照抄 audit-0.1.10-uiux-simplicity.md §2)
  const FR = { zh: ["回測重跑完就有進出場紀錄；參數掃描與樣本外驗證要再跑一次。", "灰掉的分頁沒有資料，回測重跑完才有。"],
    en: ["The Trades tab fills in once the backtest reruns; run the parameter scan and out-of-sample validation again.", "The greyed-out tabs have no data until the backtest reruns."] };
  ok("③ A7 / A8 重跑中 / 沒完成那兩句 = 精簡稽核定稿(zh / en;en 帶 0.1.11 B6 rerun、D1 Trades 分頁)", ["zh", "en"].every((l) => DT[l]["ver.frozenRerun"] === FR[l][0] && DT[l]["ver.frozenRerunFailed"] === FR[l][1]));
  ok("③ A10 en 大小寫:Param Scan / Start Scan / Sent — See Chat", DT.en["rp.tab.rob"] === "Param Scan" && DT.en["rob.btnScan"] === "Start Scan" && DT.en["rob.btnSent"] === "Sent — See Chat");
  if (!fs.existsSync(WS)) console.log("SKIP  ③ 字串逐字比對(需要 web 樹)");
  else {
    const src = fs.readFileSync(WS, "utf8");
    const pairs = [["rp.tab.wf", "workspace_tab_wf"], ...[...src.matchAll(/^\s*(wf[A-Z]\w*): \{\{ _\('(workspace_wf_\w+)'\)/gm)].map((m) => ["wf." + m[1][2].toLowerCase() + m[1].slice(3), m[2]])];
    const po = (l) => { const t = fs.readFileSync(path.join(WEB, "app", "translations", l, "LC_MESSAGES", "messages.po"), "utf8"), out = {};
      for (const m of t.matchAll(/^msgid "((?:[^"\\]|\\.)*)"\nmsgstr ((?:"(?:[^"\\]|\\.)*"\n?)+)/gm)) out[JSON.parse('"' + m[1] + '"')] = [...m[2].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => JSON.parse('"' + x[1] + '"')).join("");
      return out; };
    const WP = { en: po("en"), zh: po("zh") };
    /* 沒有例外,一律逐字 = web(0.1.11 起 wf.colTer 也是:web B1 跟上 A13)。
       wf.btnWait / wf.waitTimeout 是電腦版專屬(雲端結果晚到的等待與退回,web 靠輪詢自動換新,沒有這兩態),web 沒有這兩個 key。 */
    const DESKTOP_ONLY = { "wf.btnWait": { zh: "結果傳回中", en: "Fetching Results" },
      "wf.waitTimeout": { zh: "這次的結果沒傳回來，下面是上一次的。", en: "This run’s results didn’t arrive — below is the previous run." } };
    const off = [];
    for (const [k, mid] of pairs) for (const l of ["en", "zh"]) if (DT[l][k] !== WP[l][mid]) off.push(l + ":" + k);
    // B3 兩邊都刪 wf.legNoIs / wf.driftLegWhere:0.1.10 的 60 對(含 B5 兩個)減 2 = 58;web 還留著的話 off 會列出它們(電腦版已經沒有這兩個 key)
    ok("③ " + pairs.length + " 個 wf 字串 × zh / en 逐字 = web 的 msgstr(含 wf.msgRun、wf.colTer),沒有例外;B3 刪掉的兩個 key web 也不在",
      pairs.length === 60 && off.length === 0 && !pairs.some(([k]) => k === "wf.legNoIs" || k === "wf.driftLegWhere"), off.join(", "));
    ok("③ 電腦版專屬的兩個 key(wf.btnWait / wf.waitTimeout)= 精簡稽核定稿、web 沒有", Object.entries(DESKTOP_ONLY).every(([k, v]) => ["zh", "en"].every((l) => DT[l][k] === v[l]) && !pairs.some(([kk]) => kk === k))
      && DT.zh["wf.msgRun"] === WP.zh.workspace_wf_msg_run && DT.en["wf.msgRun"] === WP.en.workspace_wf_msg_run);
    // 真正送進對話的是代入後的那一句(references/lib.md 拿它當觸發句):用 i18n.js 的 t() 代入,跟 web msgstr 做同樣代入逐字相同
    const tctx = { STRINGS: { en: DT.en, zh: DT.zh } }; vm.createContext(tctx);
    vm.runInContext(read("renderer/i18n.js").replace(/^let LANG/m, "var LANG"), tctx);
    const V = { name: "btc_sma_cross", lookback: "1095", step: "30" };
    const subst = (s) => s.replace(/\{(\w+)\}/g, (_, k) => V[k]);
    ok("③ 代入後的固定訊息(t(\"wf.msgRun\", { name, lookback, step }))zh / en 都 = web 那句代入同樣的值", ["zh", "en"].every((l) => { tctx.LANG = l; return vm.runInContext(`t("wf.msgRun", ${JSON.stringify(V)})`, tctx) === subst(WP[l].workspace_wf_msg_run); }));
  }

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
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "blave-wf-")));
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
  const tf = (k, v) => js(`t(${JSON.stringify(k)}, ${JSON.stringify(v || {})})`);
  const r0 = await js(`(() => { const b = document.querySelector('#rp-tabs [data-tab="wf"]'); return b && b.textContent; })()`);
  ok("② 真的 index.html:分頁列有「" + (await tf("rp.tab.wf")) + "」那一顆(data-i18n 翻出來)", r0 === (await tf("rp.tab.wf")));
  await js(`window.__calls = []; window.__turn = 1; window.__upd = 0; window.__box = document.createElement("div"); window.__box.style.width = "760px"; document.body.appendChild(window.__box);
    window.__opts = (busy, turn, scope, gate) => ({ t, busy, turn: turn == null ? window.__turn : turn, scope: scope || "local", gate: gate === undefined ? true : gate, buildMeta: window.BlaveReport.buildMeta,
      onUpdate: () => { window.__upd++; }, onRun: (name, lb, st, rerun, opener) => { window.__calls.push([name, lb, st, rerun, opener && opener.tagName]); return new Promise((r) => setTimeout(() => r(window.__turn), 10)); } });
    window.__render = (data, busy, turn, scope, gate) => window.BlaveReport.renderWf(window.__box, data, window.__opts(busy, turn, scope, gate));
    window.__sync = (busy, turn, scope, gate) => window.BlaveReport.wfSync(window.__box, window.__opts(busy, turn, scope, gate)); 0;`);
  const D = (wf, code) => JSON.stringify({ stats: { symbol: "BTCUSDT", interval: "1d", start: "2023-01-01", end: "2024-11-30", "Generated At": 50 }, wf, code: code == null ? "ENTRY_TH = 0.002\nEXIT_TH = -0.002\n" : code, name: "s1" });
  const PAGE = `(() => { const q = (s) => [...window.__box.querySelectorAll(s)]; const cv = window.__box.querySelector("canvas.wf-canvas");
    return { meta: (window.__box.querySelector(".bt-meta") || {}).textContent, bar: !!window.__box.querySelector(".wf-bar"), knobs: q(".wf-bar input").map((i) => i.value + (i.disabled ? "x" : "")),
      est: (window.__box.querySelector(".wf-bar .wf-est") || {}).textContent, btn: (window.__box.querySelector(".wf-bar .wf-go") || {}).textContent, btnDis: (window.__box.querySelector(".wf-bar .wf-go") || {}).disabled,
      spin: !!window.__box.querySelector(".wf-go .spin16"), bandCls: (window.__box.querySelector(".wf-facts .wf-band") || {}).className, band: (window.__box.querySelector(".wf-facts .wf-band") || {}).textContent, status: !!window.__box.querySelector(".wf-status, .wf-tag"),
      verdict: (window.__box.querySelector(".wf-verdict") || {}).textContent, cmp: q(".wf-cmp-tbl tbody tr").map((tr) => [...tr.children].slice(1).map((td) => td.textContent)),
      wfe: (window.__box.querySelector(".wf-facts .bt-mv") || {}).textContent, canvas: cv ? cv.width : -1, grid: q(".wf-grid td").length, hits: q(".wf-grid td.is-hit").reduce((s, td) => s + +td.textContent, 0),
      cur: q(".wf-grid td.is-current").length, focus: q(".wf-grid td[tabindex='0']").length, runs: q(".wf-run-tbl tbody tr").length, card: !!window.__box.querySelector(".wf-card"),
      legend: q(".wf-block:has(canvas) .wf-legend .it").length, behind: (window.__box.querySelector(".wf-bar .wf-est.is-bad") || {}).textContent, dash: q(".wf-legend .dashline").length, facts: (window.__box.querySelector(".wf-drift-facts") || {}).textContent }; })()`;

  let r = await js(`(() => { window.__render(${D(SAMPLE)}, false); return ${PAGE}; })()`);
  ok("② 結果頁:meta → 重跑列(旋鈕預填這次的 365 / 30、共 11 輪、重新驗證可按)→ 結論卡", r.meta && r.meta.includes("BTCUSDT") && r.bar && r.knobs.join() === "365,30" && r.est === (await tf("wf.estRuns", { n: "11" })) && r.btn === (await tf("wf.btnRerun")) && !r.btnDis && r.card);
  ok("② 結論卡:頂上沒有警示也沒有 tag;比較表兩列 × 三欄;樣本外效率那一列「0.99 · 高於門檻」(中性)", !r.status && !r.verdict && r.band === (await tf("wf.tagHigh")) && !/is-risk/.test(r.bandCls) && r.cmp.length === 2 && r.cmp.every((x) => x.length === 3) && r.wfe === "0.99 · " + (await tf("wf.tagHigh")));
  ok("② 曲線畫得出來(畫布有寬)、legend:樣本外 / 重選虛線(11 輪 ≤12)/ 末尾不足一輪(B3 刪掉「樣本內沒有曲線」)", r.canvas > 0 && r.dash === 1 && r.legend === 3, JSON.stringify(r));
  ok("② 落點網格 4×3 = 12 格、格內次數加總 = 11 輪、目前參數一格虛線;每輪明細 11 列;事實行「11 輪選出…」", r.grid === 12 && r.hits === 11 && r.cur === 1 && r.focus >= 1 && r.runs === 11 && r.facts && r.facts.startsWith("11"));
  r = await js(`(() => { window.__render(${D(SAMPLE, "ENTRY_TH = 0.004\nEXIT_TH = -0.002\n")}, false); return ${PAGE}; })()`);
  ok("② 程式碼改過(過時):頂上只有那一句;樣本外效率那一列只留數值、不下門檻判斷", !r.band && r.wfe === "0.99" && r.verdict === (await tf("wf.verdictStale")));
  r = await js(`(() => { window.__render(${D({ ...SAMPLE, wfe: 0.1 })}, false); return ${PAGE}; })()`);
  ok("② 遠低於門檻(< 0.2)才上風險色", /is-risk/.test(r.bandCls) && r.band === (await tf("wf.tagFar")));

  // 空狀態
  const EMPTY = `(() => { const q = (s) => [...window.__box.querySelectorAll(s)]; const b = window.__box.querySelector(".wf-empty .wf-go");
    return { knobs: q(".wf-empty input").map((i) => i.value + (i.disabled ? "x" : "")), tl: q(".wf-tl-row").length, est: (window.__box.querySelector(".wf-empty .wf-est") || {}).textContent, estBad: !!window.__box.querySelector(".wf-est.is-bad"),
      btn: b && b.textContent, dis: b && b.disabled, spin: !!(b && b.querySelector(".spin16")), cap: (window.__box.querySelector(".wf-cap") || {}).textContent, lead: (window.__box.querySelector(".wf-empty p.lead") || {}).textContent, card: !!window.__box.querySelector(".wf-card") }; })()`;
  r = await js(`(() => { window.__render(${D(null)}, false); return ${EMPTY}; })()`);
  ok("② 空狀態(699 天):預填 365 / 30、迷你時間軸 5 列(1、2、3、⋮、N)、共 11 輪、開始驗證可按", r.knobs.join() === "365,30" && r.tl === 5 && r.est === (await tf("wf.estRuns", { n: "11" })) && r.btn === (await tf("wf.btnRun")) && !r.dis && !r.card);
  r = await js(`(() => { const i = window.__box.querySelector(".wf-empty input"); i.value = "690"; i.dispatchEvent(new Event("input")); return ${EMPTY}; })()`);
  ok("② 訓練窗拉到 690:只夠 0 輪 → 一行說明、鈕停用", r.estBad && r.est === (await tf("wf.estBad", { n: "0" })) && r.dis);
  r = await js(`(() => { const i = [...window.__box.querySelectorAll(".wf-empty input")]; i[0].value = "30"; i[1].value = "0"; i[1].value = ""; i[0].dispatchEvent(new Event("input")); return ${EMPTY}; })()`);
  ok("② 測試窗清空:鈕停用", r.dis);
  r = await js(`(() => { window.__render(${D(null)}, false, null, "cloud", false); return ${EMPTY}; })()`);
  ok("② 雲端主機落後(gate false):一句「先更新主機程式」+ 去更新,不建旋鈕", r.knobs.length === 0 && r.lead === (await tf("wf.behind")) && r.btn === (await tf("minv.btn")) && !r.dis);
  r = await js(`(() => { window.__box.querySelector(".wf-empty .wf-go").click(); return window.__upd; })()`);
  ok("② 落後態按鈕 → onUpdate(去設定 › 更新),不送驗證", r === 1 && (await js(`window.__calls.length`)) === 0);
  r = await js(`(() => { window.__render(${D(null)}, false, null, "cloud", null); return ${EMPTY}; })()`);
  ok("② 閘門不知道(null):照常可跑(誤擋整個機隊比白跑一次貴)", r.knobs.length === 2 && !r.dis);

  // 回合進行中 / 送出 / 回合結束
  r = await js(`(() => { window.__render(${D(null)}, false); const i = window.__box.querySelector(".wf-empty input"); i.value = "400"; i.dispatchEvent(new Event("input"));
    window.__turn = 5; window.__sync(true); const a = ${EMPTY}; window.__sync(false); const b = ${EMPTY}; return { a, b }; })()`);
  ok("② 別的回合進行中:鈕停用 + 一行「agent 正在回覆」;回合結束解鎖——打到一半的 400 沒被洗掉(就地換,不重畫)",
    r.a.dis && r.a.cap === (await tf("rob.busy")) && r.a.knobs[0] === "400" && !r.b.dis && !r.b.cap && r.b.knobs[0] === "400");
  r = await js(`(async () => { window.__render(${D(SAMPLE)}, false); window.__box.querySelector(".wf-bar .wf-go").click(); window.__turn = 9;
    await new Promise((r) => setTimeout(r, 40)); return { calls: window.__calls, page: ${PAGE} }; })()`);
  ok("② 重新驗證 → onRun(資料夾名、365、30、rerun、鈕)→ 已送出:舊結果整塊拿掉、旋鈕鎖住、鈕停用且環在鈕裡「已送出，看對話」",
    JSON.stringify(r.calls) === '[["s1",365,30,true,"BUTTON"]]' && !r.page.card && r.page.runs === 0 && r.page.knobs.join() === "365x,30x" && r.page.btnDis && r.page.spin && r.page.btn === (await tf("wf.btnSent")));
  r = await js(`(() => { window.__render(${D(SAMPLE)}, true, 9); return ${PAGE}; })()`);
  ok("② 同一回合、同一份結果重畫:仍是已送出", !r.card && r.spin);
  r = await js(`(() => { window.__render(${D(SAMPLE)}, true, 9, "cloud"); return ${PAGE}; })()`);
  ok("② 雲端同名策略不吃本機那份的已送出", r.card && !r.spin);
  r = await js(`(() => { window.__render(${D(SAMPLE)}, true, 9); window.__sync(false, 9); return ${PAGE}; })()`);
  ok("② 回合結束還沒等到新結果:舊結果回來、鈕解鎖", r.card && !r.spin && !r.btnDis && r.runs === 11);
  r = await js(`(() => { window.__render(${D(SAMPLE)}, false, null, "local", true); window.__sync(false, null, "local", false); return ${PAGE}; })()`);
  ok("② 閘門翻成 false:整片重畫,重跑列多一行「先更新主機程式」、鈕換成去更新(同 web:「共 N 輪」那行留著)", r.behind === (await tf("wf.behind")) && r.btn === (await tf("minv.btn")) && !r.btnDis);

  r = await js(`(() => { window.__render(${D({ ...SAMPLE, row_param: "<img src=x onerror=1>" })}, false); return { img: window.__box.querySelectorAll("img").length, corner: window.__box.querySelector(".wf-grid th.corner").textContent }; })()`);
  ok("② 參數名是 agent / 雲端來的字串:只進 textContent,不變成元素", r.img === 0 && r.corner.includes("<img src=x onerror=1>"));
  r = await js(`(() => { window.__render(${D(SAMPLE)}, false); const td = window.__box.querySelector(".wf-grid td[tabindex='0']"); td.focus(); td.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    const tip = document.getElementById("wf-tip"), on = tip && tip.classList.contains("is-on") && tip.textContent; document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    return { on, off: tip && !tip.classList.contains("is-on"), aria: td.getAttribute("aria-label") }; })()`);
  ok("② 落點格鍵盤 focus:body 層 tooltip 亮起、內容 = aria-label;Esc 收", r.on && r.on === r.aria && r.off);

  // 真的 app.js 路徑:rpShowTab("wf") 畫進 #rp-wf;沒回測時 wf 分頁跟其他三個一起 disabled
  r = await js(`(() => { document.getElementById("rp").hidden = false; RP.name = "s1"; RP.data = ${D(SAMPLE)}; RP.drawn = {}; rpShowTab("wf");
    const tab = document.querySelector('#rp-tabs [data-tab="wf"]'), a = { sel: tab.getAttribute("aria-selected"), dis: tab.disabled, shown: !document.getElementById("rp-wf").hidden, card: !!document.querySelector("#rp-wf .wf-card"), rob: document.getElementById("rp-rob").hidden };
    RP.data = { ...RP.data, stats: null }; RP.drawn = {}; rpShowTab("code"); const b = { dis: tab.disabled, wfHidden: document.getElementById("rp-wf").hidden };
    return { a, b }; })()`);
  ok("② app.js rpShowTab:選 wf → 那一面板打開、畫出結論卡、其他面板收起;沒回測 → wf 分頁 disabled、面板收起",
    r.a.sel === "true" && !r.a.dis && r.a.shown && r.a.card && r.a.rob && r.b.dis && r.b.wfHidden, JSON.stringify(r));

  // ── 稽核修正:P2-1 暖機那段認得是自己送的、沒送出去收掉 pending;S2 重畫拿掉焦點 → refocus;L4 閘門 null ↔ true 不重建 ──
  await js(`window.__p = { mode: "ok", begun: 0, refocused: 0, resynced: 0 }; window.__dummy = document.createElement("button"); document.body.appendChild(window.__dummy);
    window.__popts = (busy, turn, gate) => ({ ...window.__opts(busy, turn, "local", gate), resync: () => { window.__p.resynced++; window.__sync(true, 77); }, refocus: () => { window.__p.refocused++; window.__dummy.focus(); },
      onRun: (name, lb, st, rerun, opener, begin) => { begin(); window.__p.begun++; window.__turn = 21; window.__sync(true, 21);   // 同 app:begin → submitMessage 同步把回合開起來(rpWfSync)
        return new Promise((r) => setTimeout(() => r(window.__p.mode === "ok" ? 21 : false), 10)); } });
    window.__prender = (data, busy, turn, gate) => window.BlaveReport.renderWf(window.__box, data, window.__popts(busy, turn, gate));
    window.__sync = (busy, turn, scope, gate) => window.BlaveReport.wfSync(window.__box, window.__popts(busy, turn == null ? window.__turn : turn, gate)); 0;`);
  r = await js(`(async () => { window.__prender(${D(null)}, false); const b = window.__box.querySelector(".wf-empty .wf-go"); b.focus(); b.click();
    const mid = { spin: !!window.__box.querySelector(".wf-go .spin16"), cap: !!window.__box.querySelector(".wf-cap"), txt: (window.__box.querySelector(".wf-go") || {}).textContent, focusDummy: document.activeElement === window.__dummy };
    await new Promise((r) => setTimeout(r, 40)); return { mid, p: window.__p }; })()`);
  ok("② P2-1 按下確認 → begin() → 回合一開(還沒回來)就是「已送出」(環在鈕裡),不是「agent 正在回覆上一則訊息」;S2 鈕被重畫拿掉,焦點交給 refocus(不掉到 body)",
    r.p.begun === 1 && r.mid.spin && !r.mid.cap && r.mid.txt === (await tf("wf.btnSent")) && r.mid.focusDummy && r.p.refocused >= 1, JSON.stringify(r));
  r = await js(`(async () => { window.__p.mode = "fail"; window.__p.resynced = 0; window.__turn = 30; window.__prender(${D({ ...SAMPLE, wfe: 0.42 })}, false, 30); window.__box.querySelector(".wf-bar .wf-go").click();
    await new Promise((r) => setTimeout(r, 40)); return { resynced: window.__p.resynced, card: !!window.__box.querySelector(".wf-card"), cap: (window.__box.querySelector(".wf-cap") || {}).textContent, spin: !!window.__box.querySelector(".wf-go .spin16") }; })()`);
  ok("② P2-1 沒送出去(submitMessage 回 false,例如別的回合剛好開了):收掉 pending、照現在的回合狀態重畫——舊結果回來、鈕停用 + 那一行說明",
    r.resynced === 1 && r.card && !r.spin && r.cap === (await tf("rob.busy")), JSON.stringify(r));
  r = await js(`(() => { window.__p.mode = "ok"; window.__prender(${D(null)}, false, 40, null); const i = window.__box.querySelector(".wf-empty input"); i.value = "400"; i.dispatchEvent(new Event("input"));
    window.BlaveReport.wfSync(window.__box, window.__popts(false, 40, true)); const a = window.__box.querySelector(".wf-empty input").value;
    window.BlaveReport.wfSync(window.__box, window.__popts(false, 40, false)); const b = !!window.__box.querySelector(".wf-empty p.lead"); return { a, b }; })()`);
  ok("② L4 閘門 null → true 不重建(打到一半的 400 留著);翻成 false 才整片換成落後態", r.a === "400" && r.b, JSON.stringify(r));

  // ── 版面:另開視窗量(預設版面 = panesInit 夾出來的側欄 / 聊天欄;不拖拉)──
  // B1:最小寬 1024、聊天欄開著,五顆分頁 + 轉出鈕;S1:預設 1280 每輪明細七欄放得下;列高上限 = 表頭 + 12 列
  const measure = async (width, locale, runs) => {
    const pre2 = path.join(app.getPath("userData"), "stub-" + locale + ".js"); fs.writeFileSync(pre2, STUB.replace('getLocale: "zh-TW"', "getLocale: " + JSON.stringify(locale)));
    const w2 = new BrowserWindow({ width, height: 800, show: false, webPreferences: { offscreen: true, preload: pre2, contextIsolation: false, sandbox: false } });
    await w2.loadFile(path.join(SHELL, "renderer", "index.html")); await wait(900);
    const wf = { ...SAMPLE, n_runs: runs, runs: Array.from({ length: runs }, (_, i) => ({ ...SAMPLE.runs[i % 11], k: i + 1 })) };
    const m = await w2.webContents.executeJavaScript(`(async () => {
      RP.name = "s1"; RP.data = { stats: { symbol: "BTCUSDT", start: "2023-01-01", end: "2024-11-30", "Generated At": 5 }, wf: ${JSON.stringify(wf)}, code: "ENTRY_TH = 0.002\\nEXIT_TH = -0.002\\n", name: "s1", displayName: "s1", description: "" }; RP.drawn = {}; RP.tab = "wf";
      document.getElementById("rp").hidden = false; rpPaintHead(RP); rpShowTab("wf"); await new Promise((r) => setTimeout(r, 400));
      const R = (el) => el.getBoundingClientRect(), main = document.getElementById("rp"), sc = document.getElementById("rp-tabs-scroll"), more = document.getElementById("rp-tabs-more"), xp = document.getElementById("xp-dd");
      const box = document.querySelector(".wf-scroll"), tb = box.querySelector("table"), rows = [...tb.querySelectorAll("tbody tr")].map((r) => R(r).height);
      const out = { main: Math.round(R(main).width), mainR: Math.round(R(main).right), xpShown: !xp.hidden, xpR: Math.round(R(xp).right), over: sc.scrollWidth > sc.clientWidth + 1, more: !more.hidden,
        boxW: box.clientWidth, tblW: tb.scrollWidth, head: R(tb.querySelector("thead tr")).height, row: rows[0], rowsSame: rows.slice(0, -1).every((h) => Math.abs(h - rows[0]) < 0.5), boxH: box.clientHeight, boxSH: box.scrollHeight,
        selBottom: Math.round(R(sc.querySelector('[aria-selected="true"]')).bottom), barBottom: Math.round(R(document.getElementById("rp-tabs")).bottom) };
      rpShowTab("code"); await new Promise((r) => setTimeout(r, 100));
      const code = sc.querySelector('[data-tab="code"]'); out.codeIn = R(code).right <= R(sc).right + 1 && R(code).left >= R(sc).left - 1;
      if (!more.hidden) { const cls = more.className; out.back = cls.includes("is-back"); }
      rpShowTab("bt"); await new Promise((r) => setTimeout(r, 100)); const bt = sc.querySelector('[data-tab="bt"]'); out.btIn = R(bt).left >= R(sc).left - 1;
      return out; })()`, true);
    w2.destroy(); return m;
  };
  for (const loc of ["zh-TW", "en-US"]) {
    const a = await measure(1024, loc, 11), b = await measure(1280, loc, 12), c = await measure(1280, loc, 13);
    console.log("      " + loc + " 1024:" + JSON.stringify(a) + "\n      " + loc + " 1280:" + JSON.stringify(b) + "\n      " + loc + " 1280/13 輪:" + JSON.stringify(c));
    ok("② B1 " + loc + " 1024 聊天欄開著:分頁段溢出 → 捲動捷徑出現;轉出鈕看得到且右緣不出中欄;選程式碼 / 回測都捲得進可視範圍;選中分頁底線壓在列底(窄版 padding 不吃掉 hairline 那 1px)",
      a.over && a.more && a.xpShown && a.xpR <= a.mainR && a.codeIn && a.btIn && a.selBottom === a.barBottom, JSON.stringify(a));
    ok("② B1 " + loc + " 1280:分頁段放得下,捲動捷徑不出現(版面同 0.1.9)", !b.over && !b.more && b.xpShown && b.xpR <= b.mainR && b.selBottom === b.barBottom, JSON.stringify(b));
    ok("② S1 " + loc + " 1280:每輪明細日期兩行,七欄放得進捲動框(不橫捲)", b.tblW <= b.boxW + 1, JSON.stringify(b));
    const vis = (c.boxH - c.head) / c.row;   // 13 輪時框裡看得到幾列(R1:表頭固定 58、上限 12.5 列 → 恰好 12.5)
    ok("② S1 " + loc + " .wf-scroll 高度上限:12 輪整張不出直捲;13 輪才捲、框裡看得到 12 列以上不到 13 列(列高一致)", b.boxSH <= b.boxH + 1 && c.rowsSame && c.boxSH > c.boxH + 1 && Math.abs(c.head - 58) < 0.5 && Math.abs(vis - 12.5) < 0.05, JSON.stringify(c) + " 可見 " + vis.toFixed(2) + " 列");
  }

  console.log(red ? `\n② ${red} 紅` : "\n② ALL PASS");
  app.exit(red ? 1 : 0);
});
