// 策略頁「進出場紀錄」的預設範圍、圖↔表連動、交易地圖(0.1.27;設計稿 trades-tab-range 方案三)。
//   ① 純函式:initialRange(框收進來的成交:前端/尾端/兩端空白、裝不下往回收到箭頭間距 ≥ 24px 且兩端不裁/至少 130 根/首根之前的點不算/寬 0 退回)、
//      clampRange、trackPnl、mapBars、nearestMarker、fmtAmount;CSS 的 hover 與選中是兩種底
//   ② 真的畫(隨包的 Electron、offscreen):一打開的範圍、點列 → 同段一起亮 + 框住那段、再點取消、
//      交易地圖 ←/→ 與點擊會移範圍、列的損益 tooltip、埋點名字
// 跑法:node tests/check_shell_trades_map.js(沒設 BLAVE_TEST_WINDOW=1 時 ② SKIP)
const fs = require("fs"), path = require("path"), os = require("os"), vm = require("vm");
const SHELL = path.join(__dirname, "..", "shell"), R = path.join(SHELL, "renderer");
const GATE = require("./_electron_gate");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + String(d).slice(0, 2000))); if (!c) red++; };
const read = (f) => fs.readFileSync(f, "utf8");
const DAY = 86400, T0 = Date.UTC(2020, 0, 1) / 1000;

// 日線 n 根;positions = [[進場索引, 出場索引 | null, 調倉筆數]],每段多做一單位
function fixture(n, positions) {
  const candles = [];
  for (let i = 0; i < n; i++) { const c = 100 + Math.sin(i / 9) * 10 + i * 0.01; candles.push([T0 + i * DAY, c, c + 1, c - 1, c, 1]); }
  const trades = [];
  let pos = 0;
  positions.forEach(([a, b, adj]) => {
    pos = 1; trades.push({ ts: T0 + a * DAY, price: candles[a][4], delta: 1, direction: "buy", position: pos });
    for (let k = 1; k <= (adj || 0); k++) { pos += 0.5; trades.push({ ts: T0 + (a + k) * DAY, price: candles[a + k][4], delta: 0.5, direction: "buy", position: pos }); }
    if (b != null) { trades.push({ ts: T0 + b * DAY, price: candles[b][4], delta: -pos, direction: "sell", position: 0 }); pos = 0; }
  });
  return { candles, trades, interval: "1d", trades_start_position: 0 };
}

if (!process.versions.electron) {
  const js = read(path.join(R, "report-trades.js")), css = read(path.join(R, "report-trades.css")), tok = read(path.join(R, "tokens.css"));
  const sb = { window: {} }; vm.createContext(sb); vm.runInContext(js, sb); const TP = sb.window.BlaveReport._tradesPure;
  const build = (st) => { const c = TP.sanitizeCandles(st.candles), tr = TP.buildTracks(TP.sanitizeTrades(st.trades), TP.startPosition(st)); tr.forEach((x) => { x.pnl = TP.trackPnl(x, c[c.length - 1].close); }); return { c, tr }; };
  const J = JSON.stringify;

  // 框進來的箭頭的幾何:筆數、平均間距(px)、兩端箭頭離圖邊幾 px、最新那筆在不在、範圍裡的箭頭是不是「從某筆起往後全部」(沒有跳過)
  const geom = (tr, c, W, r) => {
    const all = []; tr.forEach((t) => t.points.forEach((p) => { if (p.ts >= c[0].time) all.push(Math.round((p.ts - c[0].time) / DAY)); }));
    all.sort((x, y) => x - y);
    const inR = all.filter((i) => i >= r.from && i <= r.to), n = inR.length, ppb = W / (r.to - r.from);
    return { n, avg: n > 1 ? ((inR[n - 1] - inR[0]) * ppb) / (n - 1) : Infinity, edgeL: (inR[0] - r.from) * ppb, edgeR: (r.to - inR[n - 1]) * ppb,
      newest: inR[n - 1] === all[all.length - 1], contiguous: n === all.filter((i) => i >= inR[0]).length, total: all.length };
  };
  // 箭頭約 12px 寬:中心離圖邊 ≥ 6px 才不被裁
  const sound = (g) => g.avg >= 24 && g.edgeL >= 6 && g.edgeR >= 6 && g.newest && g.contiguous;
  const W = 1000;

  // 裁定三的三個例子:範圍框的是收進來的成交,不是整段 K 線
  { const P = Array.from({ length: 10 }, (_, k) => [1200 + k * 70, 1240 + k * 70]), { c, tr } = build(fixture(2000, P)), r = TP.initialRange(tr, c, W), g = geom(tr, c, W, r);
    ok("① 前端空白(成交從第 1200 根才開始):全部裝得下也不拉回回測起點,左緣 = 第一筆 − 4%、右緣 = 最後一根 + 4;間距 ≥ 24px、兩端箭頭不被裁",
      r.from === 1200 - Math.round((2003 - 1200) * 0.04) && r.to === 2003 && g.n === 20 && sound(g), J({ r, g })); }
  { const P = Array.from({ length: 10 }, (_, k) => [100 + k * 70, 140 + k * 70]), { c, tr } = build(fixture(2000, P)), r = TP.initialRange(tr, c, W), g = geom(tr, c, W, r);
    const span = 770 - 100, to = 770 + Math.round(span * 0.15);
    ok("① 尾端空白(早就空手、最後一筆在第 770 根):右緣 = 最後一筆 + 15%,左緣 = 第一筆 − 4%;間距 ≥ 24px、兩端箭頭不被裁",
      r.to === to && r.from === 100 - Math.round((to - 100) * 0.04) && g.n === 20 && sound(g), J({ r, g })); }
  { const P = Array.from({ length: 10 }, (_, k) => [800 + k * 30, 815 + k * 30]), { c, tr } = build(fixture(3000, P)), r = TP.initialRange(tr, c, W), g = geom(tr, c, W, r);
    ok("① 兩端都有空白:左右都貼著成交框;間距 ≥ 24px、兩端箭頭不被裁", r.from > 700 && r.to < 1200 && g.n === 20 && sound(g), J({ r, g })); }

  // 裝不下:名額用扣掉留白後的寬度算,間距照樣 ≥ 24px;沒收進來的那根不被左側留白框進來
  { const P = Array.from({ length: 60 }, (_, k) => [20 + k * 30, 35 + k * 30]);
    for (const w of [480, 700, 1000]) { const { c, tr } = build(fixture(1900, P)), r = TP.initialRange(tr, c, w), g = geom(tr, c, w, r);
      ok("① 裝不下(寬 " + w + "):從最新往回收,間距 ≥ 24px、兩端不裁、沒有跳過任何一筆、不是全部", sound(g) && g.n < g.total && r.to === 1903, J({ r, g })); }
    const e = build(fixture(3000, P.slice(0, 40))), r = TP.initialRange(e.tr, e.c, 480), g = geom(e.tr, e.c, 480, r);
    ok("① 裝不下且早就空手:右緣 = 最後一筆 + 15%,間距 ≥ 24px、兩端不裁", r.to < 1300 && sound(g), J({ r, g }));
    const op = build(fixture(3000, P.slice(0, 40).concat([[2990, null]]))), ro = TP.initialRange(op.tr, op.c, 480);
    ok("① 最後一段未平倉 → 右緣照舊停在最後一根 + 4", ro.to === 3003, J(ro));
    const near = build(fixture(1220, P.slice(0, 40))), rn = TP.initialRange(near.tr, near.c, 480);
    ok("① 尾端空檔比成交跨度短 → 右緣照舊", rn.to === 1223, J(rn)); }

  // 沒收進來那根跟最早收進來那根緊鄰(逐筆收、每 2 根一筆):左緣停在兩根中間,最早那顆不貼圖邊
  { const dense = fixture(5000, []);
    dense.trades = Array.from({ length: 996 }, (_, k) => ({ ts: T0 + (3000 + k * 2) * DAY, price: 100, delta: 1, direction: "buy", position: k + 1 }));
    const d = build(dense), r = TP.initialRange(d.tr, d.c, 2000), g = geom(d.tr, d.c, 2000, r);
    ok("① 緊鄰時左緣停在兩根中間(+0.5 根):最早收進來那顆離圖邊 ≥ 6px、間距 ≥ 24px", sound(g) && r.from % 1 === 0.5 && g.n < g.total, J({ r, g })); }

  // 最少 130 根優先
  { const close = build(fixture(620, Array.from({ length: 60 }, (_, k) => [20 + k * 10, 25 + k * 10]))), r2 = TP.initialRange(close.tr, close.c, 24 * 4);
    ok("① 最少 130 根:貼著資料尾端時往左補,不超出最後一根 + 4", r2.from === 623 - 130 && r2.to === 623, J(r2));
    const mid = build(fixture(3000, [[1500, 1510], [1520, 1530]])), rm = TP.initialRange(mid.tr, mid.c, W);
    ok("① 最少 130 根:成交在中間時往兩側平均補(以成交為中心)", rm.to - rm.from === 130 && Math.abs((rm.from + rm.to) / 2 - 1515) <= 1, J(rm));
    const tiny = build(fixture(100, [[10, 20], [40, 50]])), rt = TP.initialRange(tiny.tr, tiny.c, W);
    ok("① 整段資料不到 130 根 → 整段", J(rt) === J({ from: -2, to: 103 }), J(rt));
    const head = build(fixture(3000, [[3, 8], [12, 18]])), rh = TP.initialRange(head.tr, head.c, W);
    ok("① 成交貼著首根:左緣不早於首根(-2)、往右補到 130", rh.from === -2 && rh.to === 128, J(rh)); }

  // 未平倉段與調倉都算筆數(未平倉 → 右緣照舊)
  { const { c, tr } = build(fixture(1000, [[100, 200, 0], [300, 400, 0], [500, 600, 3], [900, null, 2]]));
    const r = TP.initialRange(tr, c, 8 * 24 + 5), g = geom(tr, c, 8 * 24 + 5, r);
    ok("① 未平倉段與調倉都算筆數:右緣停在最後一根 + 4,收進來的筆數沒有跳過", r.to === 1003 && g.contiguous && g.newest, J({ r, g }));
    // 一段從不歸零、每 100 根調一次倉:上限 4 筆 → 左緣 = 第 4 新那筆(4600)− 4%;4% 比到下一筆(4500)的距離短,照留
    const sparse = fixture(5000, []);
    sparse.trades = Array.from({ length: 40 }, (_, k) => ({ ts: T0 + (1000 + k * 100) * DAY, price: 100, delta: 1, direction: "buy", position: k + 1 }));
    const sp = build(sparse), r6 = TP.initialRange(sp.tr, sp.c, 4 * 24);
    const r7 = TP.initialRange(sp.tr, sp.c, 30);
    ok("① 名額下限 4 筆(同網頁):寬 30 只裝得下 1 筆,仍照 4 筆收(沒有下限會只收最新一筆、被 130 根下限蓋成 4873)", r7.from === 4584 && J(r7) === J(r6), J(r7));
    ok("① 最新那段自己就超過上限 → 逐筆往回數:收到第 4 新那筆為止,左緣 = 那筆 − 4%", r6.from === 4600 - Math.round((5003 - 4600) * 0.04) && r6.to === 5003, J(r6)); }
  // 首根 K 棒之前的點:不上圖、不佔名額
  { const st = fixture(1000, [[100, 200], [300, 400], [500, 600]]), base = build(fixture(1000, [[100, 200], [300, 400], [500, 600]]));
    st.trades.unshift({ ts: T0 - 50 * DAY, price: 99, delta: 1, direction: "buy", position: 1 }, { ts: T0 - 40 * DAY, price: 98, delta: -1, direction: "sell", position: 0 });
    const { c, tr } = build(st);
    ok("① 首根 K 棒之前那段不佔名額:範圍跟沒有那段時一樣", J(TP.initialRange(tr, c, 6 * 24)) === J(TP.initialRange(base.tr, base.c, 6 * 24)), J([TP.initialRange(tr, c, 6 * 24), TP.initialRange(base.tr, base.c, 6 * 24)]));
    ok("① 寬 0 / 沒有段 → 退回最近 130 根", J(TP.initialRange(tr, c, 0)) === J({ from: 870, to: 1003 }) && J(TP.initialRange([], c, 900)) === J({ from: 870, to: 1003 })); }

  ok("① clampRange:範圍寬度不變、夾在 [-2, 最後一根 + 4];比整段寬就貼左", J(TP.clampRange(-50, 100, 999)) === J({ from: -2, to: 98 }) && J(TP.clampRange(950, 100, 999)) === J({ from: 903, to: 1003 })
    && J(TP.clampRange(400, 100, 999)) === J({ from: 400, to: 500 }) && J(TP.clampRange(10, 5000, 999)) === J({ from: -2, to: 4998 }));

  { const { c, tr } = build(fixture(400, [[10, 20], [30, 60], [100, null]]));
    ok("① trackPnl:平倉 = Σ賣 − Σ買;未平倉用最後一根收盤算浮動", Math.abs(tr[0].pnl - (c[20].close - c[10].close)) < 1e-9 && Math.abs(tr[1].pnl - (c[60].close - c[30].close)) < 1e-9 && Math.abs(tr[2].pnl - (c[399].close - c[100].close)) < 1e-9, J(tr.map((x) => x.pnl)));
    const part = TP.buildTracks(TP.sanitizeTrades([{ ts: T0 + 5 * DAY, price: 100, delta: -1, direction: "sell", position: 0 }]), { value: 1, known: true });
    ok("① partial 段(接手紀錄前的部位)不給損益", TP.trackPnl(part[0], 100) === null);
    const bars = TP.mapBars(tr, c);
    ok("① mapBars:每段一條、索引是持倉期間;賺 win / 賠 loss / 未平倉 none", bars.length === 3 && bars[0].a === 10 && bars[0].b === 20 && bars[2].b === 399
      && bars.map((b) => b.tone).join() === [tr[0].pnl >= 0 ? "win" : "loss", tr[1].pnl >= 0 ? "win" : "loss", "none"].join(), J(bars)); }

  { const M = [10, 20, 20, 30, 40].map((t, i) => ({ time: t, id: "m" + i }));
    const dx = (px) => (m) => Math.abs(m.time * 2 - px);
    ok("① nearestMarker:6px 內最近的那個;超過就沒有;垂直條件不過的跳過", TP.nearestMarker(M, 20, dx(41), () => true, 6).id === "m1" && TP.nearestMarker(M, 25, dx(50), () => true, 6) === null
      && TP.nearestMarker(M, 30, dx(61), (m) => m.id !== "m3", 6) === null && TP.nearestMarker(M, 40, dx(79), () => true, 6).id === "m4");
    ok("① fmtAmount:整數、千分位、負號用 −", TP.fmtAmount(1234.6) === "1,235" && TP.fmtAmount(-5.2) === "−5"); }
  ok("① 列的 marker id 與清單列 id 同一套(段索引 + 點索引)", /id: pointId\(ti, pi\),/.test(js) && /rows\.push\(\{ track: track, trackIdx: ti, point: p, id: pointId\(ti, pi\) \}\)/.test(js));

  ok("① tokens.css 補 --surface-row-hover(light white / dark darkBody,= web main.css)", /--surface-row-hover: var\(--color-white\);/.test(tok) && /\[data-theme="dark"\][\s\S]*--surface-row-hover: var\(--color-darkBody\);/.test(tok));
  ok("① 清單是一張卡(卡面底、圓角 lg、上下內距 4),hover 才落得回地色;方向詞用文字色階,選中列的方向詞改墨色",
    /\.tr-list \{[^}]*padding: var\(--space-4\) 0;[^}]*border-radius: var\(--radius-lg\);[^}]*background: var\(--surface-card\);/.test(css)
    && /\.tr-side\.is-buy \{ color: var\(--color-greenText\); \}/.test(css) && /\.tr-side\.is-sell \{ color: var\(--color-redText\); \}/.test(css) && /\.tr-row\.is-sel \.tr-side \{ color: var\(--ink\); \}/.test(css));
  ok("① 清單列 hover / 箭頭帶出 = row-hover;選中那段 = muted(兩種底)", /\.tr-row:hover,\s*\.tr-row\.is-hot \{ background: var\(--surface-row-hover\);/.test(css) && /\.tr-row\.is-sel \{ background: var\(--surface-muted\);/.test(css)
    && !/\.tr-row:hover[^{]*\{[^}]*surface-muted/.test(css));
  ok("① 埋點:三個名字是字面、在白名單裡", /trackFeature\(fromChart \? "trades_mark_pick" : "trades_row_pick"\);/.test(js) && (js.match(/trackFeature\("trades_map_move"\);/g) || []).length === 3
    && ["trades_row_pick", "trades_mark_pick", "trades_map_move"].every((n) => require(path.join(SHELL, "telemetry.js")).EVENTS.feature_used.name.includes(n)));

  const bin = GATE.bin(SHELL, "②");
  if (!bin) { console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0); }
  const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit" });
  const sub = r.status == null ? 1 : r.status;
  console.log(red || sub ? `\n${red + sub} 紅` : "\nALL PASS");
  process.exit(red || sub ? 1 : 0);
}

const { app, BrowserWindow } = require("electron");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blave-trades-map-"));
app.setPath("userData", tmp);
app.on("window-all-closed", () => {});   // 兩個案例之間關掉第一個視窗時 app 不能跟著結束
setTimeout(() => { console.log("FAIL  ② 逾時(90 秒)"); process.exit(1); }, 90000).unref();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const document_has_partial = (tips) => tips.some((x) => /接續紀錄起點前/.test(x));

const P = Array.from({ length: 60 }, (_, k) => [20 + k * 30, 35 + k * 30]);
const BIG = fixture(1900, P), SMALL = fixture(600, [[50, 90], [200, 260], [400, null]]);
const page = (stats) => `<!doctype html><html lang="zh-TW" data-theme="dark"><head><meta charset="utf-8">
<link rel="stylesheet" href="${path.join(R, "tokens.css")}"><link rel="stylesheet" href="${path.join(R, "report-trades.css")}">
<style>#host { width: 1100px; height: 800px; }</style></head><body><div id="host"></div>
<script src="${path.join(SHELL, "node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.js")}"></script>
<script src="${path.join(R, "strings.js")}"></script><script src="${path.join(R, "i18n.js")}"></script>
<script>setLang("zh"); window.__sent = []; function trackFeature(n) { window.__sent.push(n); }</script>
<script src="${path.join(R, "report-trades.js")}"></script>
<script>window.BlaveReport.renderTrades(document.getElementById("host"), ${JSON.stringify(stats)});</script></body></html>`;

async function open(stats) {
  const f = path.join(tmp, "p" + Math.random().toString(36).slice(2) + ".html");
  fs.writeFileSync(f, page(stats));
  const win = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { offscreen: true, sandbox: true } });
  await win.loadFile(f);
  await wait(800);
  return { win, ev: (s) => win.webContents.executeJavaScript(s) };
}
const VT = `document.querySelector(".tr-map").getAttribute("aria-valuetext")`;
const day = (i) => { const d = new Date((T0 + i * DAY + 8 * 3600) * 1000); return d.getUTCFullYear() + "/" + String(d.getUTCMonth() + 1).padStart(2, "0") + "/" + String(d.getUTCDate()).padStart(2, "0"); };

app.whenReady().then(async () => {
  { const { win, ev } = await open(SMALL);
    const vt = await ev(VT);
    // 3 段 5 筆全部裝得下:框收進來的成交(第 50 根起),不拉回第一根;最後一段未平倉 → 右緣到最後一根
    ok("② 筆數少 → 框住全部成交(左緣在第一筆之前一點、不是回測起點,右緣到最後一根)", vt.split(" – ")[0] < day(50) && vt.split(" – ")[0] > day(0) && vt.endsWith(day(599)), vt);
    win.destroy(); }

  const { win, ev } = await open(BIG);
  const s0 = await ev(`({ vt: ${VT}, role: document.querySelector(".tr-map").getAttribute("role"), tab: document.querySelector(".tr-map").tabIndex, inCard: !!document.querySelector(".tr-card > .tr-chart + .tr-map"),
    lit: (() => { const c = document.querySelector(".tr-map canvas"), x = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < x.length; i += 4) if (x[i]) n++; return n; })() })`);
  const from0 = s0.vt.split(" – ")[0];
  ok("② 筆數多 → 不是整段、也不是只有 130 根(左緣在第一根之後、最後 130 根之前)", from0 > day(0) && from0 < day(1900 - 130) && s0.vt.endsWith(day(1899)), s0.vt);
  ok("② 交易地圖在同一張卡裡、圖的正下方;role=slider、可 tab 到、canvas 有畫東西", s0.inCard && s0.role === "slider" && s0.tab === 0 && s0.lit > 1000, JSON.stringify(s0));

  // 點最新一段的平倉列(清單新的在上:第一列)
  const s1 = await ev(`(async () => { const rows = [...document.querySelectorAll(".tr-row")]; rows[0].click(); await new Promise((r) => setTimeout(r, 300));
    return { sel: rows.filter((r) => r.classList.contains("is-sel")).length, cur: rows.findIndex((r) => r.getAttribute("aria-current") === "true"), vt: ${VT}, tip0: rows[0].title, tip1: rows[1].title, sent: window.__sent.slice() }; })()`);
  const last = P[59];
  ok("② 點一列 → 同段兩列一起亮、aria-current 只在被點那列、圖框住那段(兩側留空)", s1.sel === 2 && s1.cur === 0 && s1.vt.split(" – ")[0] <= day(last[0]) && s1.vt.split(" – ")[1] >= day(last[1]) && s1.vt.split(" – ")[0] > day(last[0] - 30), JSON.stringify(s1));
  ok("② 列的 tooltip:已平倉 + 獲利/虧損約 N(同段兩列同一句)", /^此段倉位已平倉，(獲利|虧損)約 [\d,]+$/.test(s1.tip0) && s1.tip0 === s1.tip1, s1.tip0);
  ok("② 點列記 trades_row_pick", s1.sent.join() === "trades_row_pick", s1.sent.join());
  const s2 = await ev(`(async () => { document.querySelector(".tr-row").click(); await new Promise((r) => setTimeout(r, 300));
    return { sel: document.querySelectorAll(".tr-row.is-sel").length, cur: document.querySelectorAll('.tr-row[aria-current="true"]').length, vt: ${VT}, sent: window.__sent.length }; })()`);
  ok("② 再點同一段 → 取消選取、範圍不動、不另記埋點", s2.sel === 0 && s2.cur === 0 && s2.vt === s1.vt && s2.sent === 1, JSON.stringify(s2));

  // 圖 → 表:範圍還框著最新那段(取消選取不動範圍),進場箭頭在圖左側約兩成處、K 棒下方。
  // 真的滑鼠事件掃過去,記下第一次有列亮起來的位置,再在那裡按下去
  await ev(`(() => { window.__hit = null; window.__mx = null; document.addEventListener("mousemove", (e) => { window.__mx = [e.clientX, e.clientY]; }, true);
    new MutationObserver(() => { if (!window.__hit && document.querySelector(".tr-row.is-hot")) window.__hit = { at: window.__mx.slice(), row: [...document.querySelectorAll(".tr-row")].findIndex((r) => r.classList.contains("is-hot")), pointer: document.querySelector(".tr-chart").classList.contains("is-onmark") }; })
      .observe(document.querySelector(".tr-list"), { subtree: true, attributes: true, attributeFilter: ["class"] }); })()`);
  const box = await ev(`(() => { const r = document.querySelector(".tr-chart").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  let hit = null;
  // LWC 一幀只處理最後一個 mousemove:每一步都等一幀。步距 6×20 小於退路的命中框(水平 ±6、垂直 32)
  for (let x = box.x + box.w * 0.08; x < box.x + box.w * 0.4 && !hit; x += 6) {
    for (let y = box.y + box.h * 0.3; y < box.y + box.h * 0.9; y += 20) { win.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(x), y: Math.round(y) }); await wait(20); }
    hit = await ev("window.__hit");
  }
  ok("② hover 箭頭 → 對應的列亮(is-hot)、游標變成可點", !!hit && hit.row >= 0 && hit.pointer, JSON.stringify(hit));
  if (hit) {
    win.webContents.sendInputEvent({ type: "mouseMove", x: hit.at[0], y: hit.at[1] });
    win.webContents.sendInputEvent({ type: "mouseDown", x: hit.at[0], y: hit.at[1], button: "left", clickCount: 1 });
    win.webContents.sendInputEvent({ type: "mouseUp", x: hit.at[0], y: hit.at[1], button: "left", clickCount: 1 });
    await wait(400);
    const s5 = await ev(`({ sel: [...document.querySelectorAll(".tr-row")].map((r, i) => r.classList.contains("is-sel") ? i : -1).filter((i) => i >= 0), cur: [...document.querySelectorAll(".tr-row")].findIndex((r) => r.getAttribute("aria-current") === "true"), sent: window.__sent.slice() })`);
    ok("② 點箭頭 = 點那一列:那段整段亮、aria-current 在那筆、記 trades_mark_pick", s5.sel.length === 2 && s5.sel.includes(hit.row) && s5.cur === hit.row && s5.sent.join() === "trades_row_pick,trades_mark_pick", JSON.stringify(s5));
    await ev(`document.querySelectorAll(".tr-row")[${JSON.stringify(hit.row)}].click()`);   // 取消選取,後面的地圖案例從乾淨狀態開始
    await ev(`window.__sent = window.__sent.filter((n) => n !== "trades_mark_pick")`);
  }

  // 地圖:← 往回半個範圍;點地圖最左邊 → 範圍移到最前面
  const s3 = await ev(`(async () => { const m = document.querySelector(".tr-map"); const before = ${VT};
    m.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })); await new Promise((r) => setTimeout(r, 300)); const afterKey = ${VT};
    const rc = m.querySelector("canvas").getBoundingClientRect();
    m.setPointerCapture = () => {};
    m.dispatchEvent(new PointerEvent("pointerdown", { clientX: rc.left + 2, clientY: rc.top + rc.height / 2, button: 0, pointerId: 1, bubbles: true }));
    m.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, bubbles: true })); await new Promise((r) => setTimeout(r, 300));
    return { before, afterKey, afterClick: ${VT}, sent: window.__sent.slice() }; })()`);
  ok("② 地圖 ← → 範圍往前移", s3.afterKey.split(" – ")[0] < s3.before.split(" – ")[0] && s3.afterKey.split(" – ")[1] < s3.before.split(" – ")[1], JSON.stringify(s3));
  ok("② 點地圖最左邊 → 範圍移到回測開頭", s3.afterClick.split(" – ")[0] === day(0), JSON.stringify(s3));
  ok("② 方向鍵、點地圖各記一次 trades_map_move", s3.sent.join() === "trades_row_pick,trades_map_move,trades_map_move", s3.sent.join());
  // 在外框裡按下去:沒拖就不記;拖出位移才記一次(同一次拖曳不重記)
  const s3b = await ev(`(async () => { const m = document.querySelector(".tr-map"), rc = m.querySelector("canvas").getBoundingClientRect(), n0 = window.__sent.length;
    const at = (x) => ({ clientX: x, clientY: rc.top + rc.height / 2, button: 0, pointerId: 2, bubbles: true }), x0 = rc.left + 3;   // 外框貼著最左(上一步移到開頭了)
    m.dispatchEvent(new PointerEvent("pointerdown", at(x0))); m.dispatchEvent(new PointerEvent("pointerup", at(x0))); await new Promise((r) => setTimeout(r, 200));
    const still = window.__sent.length - n0, vt0 = ${VT};
    m.dispatchEvent(new PointerEvent("pointerdown", at(x0))); m.dispatchEvent(new PointerEvent("pointermove", at(x0 + 40))); m.dispatchEvent(new PointerEvent("pointermove", at(x0 + 80)));
    m.dispatchEvent(new PointerEvent("pointerup", at(x0 + 80))); await new Promise((r) => setTimeout(r, 300));
    return { still, dragged: window.__sent.length - n0, moved: ${VT} !== vt0 }; })()`);
  ok("② 外框裡按了沒拖 → 不記;拖出位移 → 記一次", s3b.still === 0 && s3b.dragged === 1 && s3b.moved, JSON.stringify(s3b));

  // 換策略重畫:舊圖釋放、新的照樣畫得出來
  const s4 = await ev(`(() => { window.BlaveReport.renderTrades(document.getElementById("host"), ${JSON.stringify(SMALL)}); return document.querySelectorAll(".tr-card").length + ":" + document.querySelectorAll(".tr-map").length; })()`);
  ok("② 重畫一次:卡與地圖各一張(沒有疊兩份)", s4 === "1:1", s4);
  win.destroy();

  // 沒有 K 棒(舊 runner)、最後一段未平倉:浮動損益算不出來,tooltip 講還持有,不誤用 partial 的文案
  { const noC = fixture(10, [[2, 4], [6, null]]); delete noC.candles;
    const { win: w2, ev: e2 } = await open(noC);
    const tips = await e2(`[...document.querySelectorAll(".tr-row")].map((r) => r.title)`);
    ok("② 沒有 K 棒:未平倉段寫「仍持有」(不給數字、不是 partial 文案);平倉段照舊有損益", tips[0] === "此段倉位在回測結束時仍持有。" && /^此段倉位已平倉，/.test(tips[1]) && !document_has_partial(tips), JSON.stringify(tips));
    w2.destroy(); }

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* userData 還鎖著 */ }
  console.log(red ? `\n${red} FAILED` : "\nALL PASS");
  app.exit(red ? 1 : 0);
}).catch((e) => { console.log("FAIL  " + (e && e.stack)); process.exit(1); });
