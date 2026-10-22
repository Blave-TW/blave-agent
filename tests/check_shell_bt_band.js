// 回測分頁權益圖的隨機投組範圍帶(designer 0126/random-band spec A 案):Type C 的 stats.json 帶 benchmark_band
// {p5,p25,p50,p75,p95}(權益倍數、長度 = daily_dates)時,p5–p95 填灰、中位數虛線、策略線最後畫;y 軸含 p5 / p95;
// 帶最厚不到 10px 收成只畫中位數;只有畫了帶才多圖例項。欄位缺 / 長度不符 / 非正數 → 畫面跟沒有帶時逐筆一樣。
// 不開 Electron:整支 report-backtest.js 跑在 vm 裡,假 DOM + 記錄每個 canvas 呼叫的假 context。
// 跑法:node tests/check_shell_bt_band.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const R = path.join(__dirname, "..", "shell", "renderer");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + String(d).slice(0, 600))); if (!c) red++; };
const STR = vm.runInNewContext(fs.readFileSync(path.join(R, "strings.js"), "utf8").replace(/^const STRINGS/m, "var STRINGS") + "\nSTRINGS");

const TOK = { "--color-primary": "#ff8a00", "--color-red": "#e5484d", "--border-hairline": "#2a3138", "--ink-3": "#818f97",
  "--color-greyDark": "#546168", "--chart-band": "#546168", "--color-greyMedium": "#818f97", "--surface-muted": "#1c2228", "--color-green": "#30a46c" };
const BAND_FILL = "rgba(84,97,104,0.55)";

class Node {
  constructor(tag) { this.tag = tag; this.className = ""; this.children = []; this.text = ""; this.attrs = {}; this.id = ""; this.type = ""; this.style = {}; }
  appendChild(n) { if (n.tag === "#frag") this.children.push(...n.children); else this.children.push(n); return n; }   // fragment 跟真 DOM 一樣攤平
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v) { this.children = []; this.text = v == null ? "" : String(v); }
}
const all = (n) => [n].concat(...n.children.map(all));
const byCls = (root, c) => all(root).filter((x) => x.className.split(/\s+/).includes(c));

function harness(size) {
  const calls = [];
  const canvasSize = { w: size ? size.w : 600, h: size ? size.h : 320 };
  const ctx = new Proxy({ measureText: (s) => ({ width: String(s).length * 6 }) }, {
    get: (o, k) => (k in o ? o[k] : (...a) => calls.push([k, ...a])),
    set: (o, k, v) => { calls.push(["=" + String(k), v]); return true; },
  });
  let roCb = null;
  const sb = {
    console, window: { devicePixelRatio: 1 },
    document: {
      documentElement: {},
      createDocumentFragment: () => new Node("#frag"),
      createTextNode: (s) => { const n = new Node("#text"); n.text = String(s); return n; },
      createElement(tag) {
        const n = new Node(tag);
        if (tag === "canvas") {
          Object.defineProperty(n, "clientWidth", { get: () => canvasSize.w });
          Object.defineProperty(n, "clientHeight", { get: () => canvasSize.h });
          n.getContext = () => ctx;
        }
        return n;
      },
    },
    getComputedStyle: () => ({ getPropertyValue: (k) => TOK[k] || "", fontFamily: "sans-serif" }),
    ResizeObserver: function (cb) { roCb = cb; this.observe = () => {}; this.disconnect = () => {}; },
    t: (k, vars) => { let s = STR.zh[k]; if (s === undefined) return "<<" + k + ">>"; Object.keys(vars || {}).forEach((v) => { s = s.split("{" + v + "}").join(vars[v]); }); return s; },
  };
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(R, "report-backtest.js"), "utf8"), sb);
  return { R: sb.window.BlaveReport, calls, size: canvasSize, fireResize: () => roCb && roCb() };
}

// 跟真檔同型:Type C、日報酬 + 日期,帶是倍數(1.0 起)
const N = 120;
const dates = Array.from({ length: N }, (_, i) => new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10));
const rets = Array.from({ length: N }, (_, i) => (i === 0 ? 0 : 0.004 + 0.01 * Math.sin(i / 7)));
const mk = (lo, hi) => {   // p50 = 1 → 1.3,p5 / p95 以 lo / hi 為終點比例往外張
  const p50 = dates.map((_, i) => 1 + 0.3 * (i / (N - 1)));
  const w = (k) => p50.map((v, i) => v * Math.pow(k, Math.sqrt(i / (N - 1))));
  return { p5: w(lo), p25: w(Math.sqrt(lo)), p50, p75: w(Math.sqrt(hi)), p95: w(hi) };
};
const WIDE = mk(0.3, 1.8), NARROW = mk(0.995, 1.005);
const base = { "benchmark_strategy_ret_pct": 95, "Total Return [%]": 50, daily_dates: dates, daily_returns: rets };

function render(stats, size) {
  const h = harness(size), box = new Node("div");
  h.R.renderBacktest(box, stats);
  const chart = byCls(box, "bt-canvas")[0], head = byCls(box, "bt-label")[0];
  return { h, box, chart, head, legend: () => head.children.map((c) => [c.className, c.textContent]) };
}
// 從呼叫紀錄找:某個 fill 當下的 fillStyle;某個 stroke 當下的 strokeStyle / lineWidth / dash
function scan(calls) {
  const st = { fillStyle: null, strokeStyle: null, lineWidth: null, dash: [] }, ev = [];
  calls.forEach((c, i) => {
    if (c[0][0] === "=") st[c[0].slice(1)] = c[1];
    else if (c[0] === "setLineDash") st.dash = c[1];
    else if (c[0] === "fill" || c[0] === "stroke" || c[0] === "fillText") ev.push({ i, op: c[0], text: c[1], fill: st.fillStyle, stroke: st.strokeStyle, lw: st.lineWidth, dash: JSON.stringify(st.dash) });
  });
  return ev;
}
const EQ_TOP = 12, EQ_H = 320 - 12 - 22 - 4 - Math.round((320 - 12 - 22 - 4) / 3.2);   // drawChart 的權益區幾何

// ── readBand ──
{
  const { R } = harness(), rb = R._bt.readBand;
  const good = rb({ daily_dates: dates, benchmark_band: WIDE });
  ok("readBand:五條都合法 → 收下並 ×100(對齊權益 100 起算)", !!good && good.p50[0] === 100 && Math.abs(good.p95[N - 1] - 130 * 1.8) < 1e-9);
  const drop = (k) => { const b = { ...WIDE }; delete b[k]; return b; };
  const bad = [
    ["沒有 benchmark_band", { daily_dates: dates }],
    ["benchmark_band 是 null", { daily_dates: dates, benchmark_band: null }],
    ["缺 p25(沒用到的那條也要在)", { daily_dates: dates, benchmark_band: drop("p25") }],
    ["p95 少一點", { daily_dates: dates, benchmark_band: { ...WIDE, p95: WIDE.p95.slice(1) } }],
    ["p5 有 NaN", { daily_dates: dates, benchmark_band: { ...WIDE, p5: WIDE.p5.map((v, i) => (i === 50 ? NaN : v)) } }],
    ["p50 有 0", { daily_dates: dates, benchmark_band: { ...WIDE, p50: WIDE.p50.map((v, i) => (i === 9 ? 0 : v)) } }],
    ["p75 有負數", { daily_dates: dates, benchmark_band: { ...WIDE, p75: WIDE.p75.map((v, i) => (i === 9 ? -1 : v)) } }],
    ["p5 有字串數字", { daily_dates: dates, benchmark_band: { ...WIDE, p5: WIDE.p5.map((v, i) => (i === 2 ? "1.0" : v)) } }],
    ["p95 不是陣列", { daily_dates: dates, benchmark_band: { ...WIDE, p95: { 0: 1 } } }],
    ["沒有 daily_dates", { benchmark_band: WIDE }],
  ];
  const leak = bad.filter(([, s]) => rb(s) !== null).map(([n]) => n);
  ok("readBand:" + bad.length + " 種壞輸入一律 null(整組不畫)", leak.length === 0, leak.join("、"));
}

// ── buildSeries:帶跟權益同一組索引 ──
{
  const { R } = harness();
  const d2 = dates.map((d, i) => (i === 3 ? null : d));
  const s = R._bt.buildSeries({ daily_dates: d2, daily_returns: rets, benchmark_band: WIDE });
  ok("buildSeries:跳過非字串日期時帶也跳過同一天(第 3 點對到原本第 4 天)",
    !!s.band && s.band.p5.length === s.equity.length && s.equity.length === N - 1 && s.band.p50[3] === WIDE.p50[4] * 100 && s.band.p95[2] === WIDE.p95[2] * 100);
  ok("buildSeries:沒有帶 → series.band 是 null", R._bt.buildSeries(base).band === null);
}

// ── 寬帶:畫帶 + 中位數 + 圖層順序 + y 範圍 + 圖例 ──
{
  const r = render({ ...base, benchmark_band: WIDE });
  const ev = scan(r.h.calls);
  const fills = ev.filter((e) => e.op === "fill" && e.fill === BAND_FILL);
  const med = ev.filter((e) => e.op === "stroke" && e.stroke === TOK["--color-greyMedium"] && e.lw === 1.2 && e.dash === "[4,4]");
  const eq = ev.filter((e) => e.op === "stroke" && e.stroke === TOK["--color-primary"] && e.lw === 2);
  const grid = ev.filter((e) => e.op === "stroke" && e.stroke === TOK["--border-hairline"]);
  ok("寬帶:帶填一次(--chart-band @ 0.55)、中位數虛線 [4,4] 1.2px greyMedium 一條、策略線一條", fills.length === 1 && med.length === 1 && eq.length === 1, JSON.stringify([fills.length, med.length, eq.length]));
  ok("圖層:權益區格線 → 帶 → 中位數 → 策略線", fills.length && med.length && eq.length && grid.length && grid[0].i < fills[0].i && fills[0].i < med[0].i && med[0].i < eq[0].i);
  // 帶那條 path:fill 之前、上一個 beginPath 之後的所有 lineTo
  const fi = fills[0] ? fills[0].i : 0;
  let bp = fi; while (bp > 0 && r.h.calls[bp][0] !== "beginPath") bp--;
  const ys = r.h.calls.slice(bp, fi).filter((c) => c[0] === "lineTo").map((c) => c[2]);
  ok("y 範圍含 p5 / p95:帶的每一點都落在權益區內(沒被裁)", ys.length === 2 * N && ys.every((y) => y >= EQ_TOP - 1e-6 && y <= EQ_TOP + EQ_H + 1e-6), ys.length + " 點 " + Math.min(...ys).toFixed(1) + "–" + Math.max(...ys).toFixed(1));
  ok("y 範圍含 p5:策略最低沒低過 1×,但 p5 到 0.3× → 0.5× 刻度畫出來", ev.some((e) => e.op === "fillText" && e.text === "0.5×"));
  ok("圖例:權益 → 隨機 p5–p95 → 隨機中位數 → 回撤", JSON.stringify(r.legend()) === JSON.stringify([["bt-legend", "權益"], ["bt-legend band", "隨機 p5–p95" + STR.zh["bt.tip.band"]], ["bt-legend med", "隨機中位數"], ["bt-legend dd", "回撤"]]), JSON.stringify(r.legend()));
  const item = r.head.children[1], btn = item.children[0], tip = item.children[1];
  ok("帶那一項的說明:button.mp-tip(鍵盤可聚焦)+ role=tooltip 泡泡,aria-describedby 對到", btn && btn.tag === "button" && btn.className === "mp-tip" && tip.className === "tip" && tip.getAttribute("role") === "tooltip" && btn.getAttribute("aria-describedby") === tip.id && !!tip.id);
  ok("canvas aria-label 換成含隨機投組範圍那句", r.chart.getAttribute("aria-label") === STR.zh["bt.chartAriaBand"]);
  const kept = r.head.children.slice();
  r.h.fireResize();
  ok("同一個收合狀態再 resize 一次:圖例節點不重建", r.head.children.length === kept.length && r.head.children.every((c, i) => c === kept[i]));
}

// ── 窄帶:收成中位數 ──
{
  const r = render({ ...base, benchmark_band: NARROW });
  const ev = scan(r.h.calls);
  ok("窄帶(最厚 < 10px):不填帶,只畫中位數虛線", !ev.some((e) => e.op === "fill" && e.fill === BAND_FILL) && ev.filter((e) => e.op === "stroke" && e.dash === "[4,4]" && e.lw === 1.2).length === 1);
  ok("窄帶圖例:權益 → 隨機中位數(說明換窄帶那句)→ 回撤;不再寫「≈等權」", !/等權|equal weight/.test(JSON.stringify(r.legend()) + STR.en["bt.tip.bandNarrow"]) && JSON.stringify(r.legend()) === JSON.stringify([["bt-legend", "權益"], ["bt-legend med", "隨機中位數" + STR.zh["bt.tip.bandNarrow"]], ["bt-legend dd", "回撤"]]), JSON.stringify(r.legend()));
  // 門檻:二分出「剛好開始畫帶」的寬度,量那張圖帶的最厚處 → 應該剛好 ≥ 10px(用像素判定,不用比例)
  const bandYs = (calls) => { const fi = calls.findIndex((c) => c[0] === "fill" && calls.slice(0, calls.indexOf(c)).reverse().find((x) => x[0] === "=fillStyle")[1] === BAND_FILL);
    if (fi < 0) return null; let bp = fi; while (calls[bp][0] !== "beginPath") bp--; return calls.slice(bp, fi).filter((c) => c[0] === "lineTo").map((c) => c[2]); };
  let lo = 0.9, hi = 0.9999;   // lo 畫帶、hi 收合
  for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2; if (bandYs(render({ ...base, benchmark_band: mk(m, 1 / m) }).h.calls)) lo = m; else hi = m; }
  const ys = bandYs(render({ ...base, benchmark_band: mk(lo, 1 / lo) }).h.calls) || [];
  let thick = 0; for (let i = 0; i < N; i++) thick = Math.max(thick, ys[2 * N - 1 - i] - ys[i]);
  ok("門檻:剛好畫帶的那張,帶最厚 = 10px(差 < 0.01);再窄一點就收合", ys.length === 2 * N && thick >= 10 && thick < 10.01 && !bandYs(render({ ...base, benchmark_band: mk(hi, 1 / hi) }).h.calls), thick.toFixed(4));
  const sw = render({ ...base, benchmark_band: NARROW }, { w: 1600, h: 320 });
  ok("拉寬到 1600:收合判定不變(canvas 高固定)", !scan(sw.h.calls).some((e) => e.op === "fill" && e.fill === BAND_FILL) && sw.head.children.length === 3);
}

// ── 沒有帶 / 帶壞掉:畫面逐筆跟沒有帶一樣 ──
{
  const plain = render(base);
  const sig = JSON.stringify(plain.h.calls);
  ok("沒有帶:圖例兩項、aria 原句、沒有灰填色也沒有 [4,4] 虛線", JSON.stringify(plain.legend()) === JSON.stringify([["bt-legend", "權益"], ["bt-legend dd", "回撤"]])
    && plain.chart.getAttribute("aria-label") === STR.zh["bt.chartAria"] && !scan(plain.h.calls).some((e) => e.fill === BAND_FILL || e.dash === "[4,4]"));
  const broken = [
    { ...WIDE, p95: WIDE.p95.slice(2) }, { ...WIDE, p5: WIDE.p5.map((v, i) => (i ? v : Infinity)) }, { p5: WIDE.p5, p50: WIDE.p50, p95: WIDE.p95 }, "x", [],
  ];
  const diff = broken.map((b, i) => [i, render({ ...base, benchmark_band: b })]).filter(([, r]) => JSON.stringify(r.h.calls) !== sig || r.head.children.length !== 2 || r.chart.getAttribute("aria-label") !== STR.zh["bt.chartAria"]).map(([i]) => i);
  ok("帶壞掉的 " + broken.length + " 種:canvas 呼叫逐筆等於沒有帶、圖例兩項、aria 原句", diff.length === 0, diff.join(","));
}

// ── 分頁藏著時第一次量到 0:圖例先兩項,真的畫了才換 ──
{
  const r = render({ ...base, benchmark_band: WIDE }, { w: 0, h: 0 });
  const before = r.head.children.length;
  r.h.size.w = 600; r.h.size.h = 320; r.h.fireResize();
  ok("藏著的分頁:畫之前圖例兩項,切回來畫了之後四項", before === 2 && r.head.children.length === 4, before + " → " + r.head.children.length);
}

// ── CSS 色票與字串 ──
{
  const css = fs.readFileSync(path.join(R, "report-backtest.css"), "utf8");
  ok("CSS:帶色票 10×10 radius-micro、--chart-band 55%(與圖同);中位數與 0050 共用一條色票規則 14px 2px 虛線 greyMedium;圖例可折行",
    /\.bt-legend\.band::before \{[^}]*width: 10px;[^}]*height: 10px;[^}]*var\(--radius-micro\)[^}]*color-mix\(in srgb, var\(--chart-band\) 55%, transparent\)/.test(css)
    && /\.bt-legend\.med::before,\n\.bt-legend\.bh::before \{[^}]*width: 14px;[^}]*border-top: 2px dashed var\(--color-greyMedium\)/.test(css)
    && /\.bt-label \{[^}]*flex-wrap: wrap;/.test(css) && /\.bt-legend \{ position: relative;/.test(css));
  const keys = ["bt.legendBand", "bt.legendMedian", "bt.tip.band", "bt.tip.bandNarrow", "bt.chartAriaBand"];
  ok("五個新字串兩語都有;舊的 bt.legendMedianNarrow 兩語都不在", keys.every((k) => STR.zh[k] && STR.en[k]) && !("bt.legendMedianNarrow" in STR.zh) && !("bt.legendMedianNarrow" in STR.en));
  ok("圖例字照 spec 逐字", STR.zh["bt.legendBand"] === "隨機 p5–p95" && STR.zh["bt.legendMedian"] === "隨機中位數" && STR.zh["bt.tip.bandNarrow"] === "隨機投組的範圍太窄，只畫中位數。"
    && STR.en["bt.legendBand"] === "Random p5–p95" && STR.en["bt.legendMedian"] === "Random median" );
}

// ── 台股 Type C:0050 買進持有(designer typec-0050-benchmark-2026-10-20 A 版)──
{
  const SER = dates.map((_, i) => 1 + 0.9 * (i / (N - 1)));   // 終點 1.9×,比策略高
  const bhOf = (extra) => ({ kind: "0050_bh", symbol: "0050", adjusted: true, fee_pct: 0, ret_pct: 61.75, cagr_pct: 9, mdd_pct: -20, series: SER, ...(extra || {}) });
  const tw = (bh, extra) => ({ "Total Return [%]": 50, daily_dates: dates, daily_returns: rets, benchmark_bh: bh, ...(extra || {}) });
  const { R: RR } = harness();
  const rbh = RR._bt.readBh;
  ok("readBh:合法 → ×100", (() => { const v = rbh(tw(bhOf())); return !!v && v.length === N && v[0] === 100 && Math.abs(v[N - 1] - 190) < 1e-9; })());
  const noSer = bhOf(); delete noSer.series;
  const badBh = [["null", tw(null)], ["沒有 series", tw(noSer)], ["series 少一點", tw(bhOf({ series: SER.slice(1) }))], ["series 多一點", tw(bhOf({ series: SER.concat([2]) }))],
    ["有 NaN", tw(bhOf({ series: SER.map((v, i) => (i === 5 ? NaN : v)) }))], ["有 0", tw(bhOf({ series: SER.map((v, i) => (i === 5 ? 0 : v)) }))],
    ["有字串", tw(bhOf({ series: SER.map((v, i) => (i === 5 ? "1" : v)) }))], ["沒有鍵", { daily_dates: dates, daily_returns: rets }]];
  const leak = badBh.filter(([, st]) => rbh(st) !== null).map(([n]) => n);
  ok("readBh:" + badBh.length + " 種壞輸入一律 null(不畫線)", leak.length === 0, leak.join("、"));
  ok("有 benchmark_bh 鍵(含 null)就不讀隨機帶", RR._bt.readBand(tw(bhOf(), { benchmark_band: WIDE })) === null && RR._bt.readBand(tw(null, { benchmark_band: WIDE })) === null);
  const d2 = dates.map((d, i) => (i === 3 ? null : d));
  const s2 = RR._bt.buildSeries(tw(bhOf(), { daily_dates: d2 }));
  ok("buildSeries:跳過非字串日期時 0050 也跳過同一天", !!s2.bh && s2.bh.length === s2.equity.length && s2.bh[3] === SER[4] * 100);

  const mrow = (box) => byCls(box, "bt-mrow").find((r) => /0050|BTC|SPY|基準報酬/.test(r.children[0].textContent));
  const tipOf = (key, sym) => STR.zh[key].split("{sym}").join(sym);
  const r = render(tw(bhOf()));
  const ev = scan(r.h.calls);
  const dash = ev.filter((e) => e.op === "stroke" && e.stroke === TOK["--color-greyMedium"] && e.lw === 1.2 && e.dash === "[4,4]");
  const eq = ev.filter((e) => e.op === "stroke" && e.stroke === TOK["--color-primary"] && e.lw === 2);
  const grid = ev.filter((e) => e.op === "stroke" && e.stroke === TOK["--border-hairline"]);
  ok("0050:一條 greyMedium 1.2px [4,4] 虛線、不填色,圖層 格線 → 0050 → 策略線",
    dash.length === 1 && !ev.some((e) => e.op === "fill" && e.fill === BAND_FILL) && grid[0].i < dash[0].i && dash[0].i < eq[0].i, JSON.stringify([dash.length, eq.length]));
  let bp = dash[0] ? dash[0].i : 0; while (bp > 0 && r.h.calls[bp][0] !== "beginPath") bp--;
  const ys = r.h.calls.slice(bp, dash[0] ? dash[0].i : 0).filter((c) => c[0] === "lineTo" || c[0] === "moveTo").map((c) => c[2]);
  ok("0050:y 範圍含它(1.9× 也在權益區內)", ys.length === N && ys.every((y) => y >= EQ_TOP - 1e-6 && y <= EQ_TOP + EQ_H + 1e-6), ys.length + " 點");
  ok("0050 圖例:權益 → 0050 持有(不掛 tooltip)→ 回撤", JSON.stringify(r.legend()) === JSON.stringify([["bt-legend", "權益"], ["bt-legend bh", "0050 持有"], ["bt-legend dd", "回撤"]]), JSON.stringify(r.legend()));
  ok("0050 圖例:代號 0050 包 .mono(同統計列)", byCls(r.head, "bt-legend").filter((c) => / bh$/.test(c.className)).some((c) => byCls(c, "mono").some((m) => m.textContent === "0050")));
  ok("0050:canvas aria 用 0050 那句", r.chart.getAttribute("aria-label") === "回測期間的權益曲線、0050 持有與回撤");
  const row = mrow(r.box), btn = row && row.children[0].children[0];
  ok("統計列:標籤 0050 持有、0050 包 .mono、值 +61.75% 中性色",
    !!btn && btn.children[0].className === "mono" && btn.children[0].textContent === "0050" && btn.textContent === "0050 持有"
    && row.children[1].textContent === "+61.75%" && !/pos|neg/.test(row.children[1].className), row && JSON.stringify([btn && btn.textContent, btn && btn.children.map((c) => c.className + ":" + c.textContent), row.children[1].textContent, row.children[1].className]));
  ok("統計列 tooltip:還原價那句(含配息)", row && row.children[0].children[1].textContent === tipOf("bt.tip.benchmarkBhAdj", "0050")
    && row.children[0].children[1].textContent.includes("含配息"));
  r.h.fireResize();
  ok("resize 之後圖例照樣三項", r.head.children.length === 3);

  const rn = render(tw(null));
  const rowN = mrow(rn.box);
  ok("benchmark_bh = null(不知道是哪一檔):標籤寫基準報酬、值「—」(na)、tooltip 換原因句、不畫線、圖例兩項",
    rowN && rowN.children[0].children[0].textContent === "基準報酬" && rowN.children[1].textContent === "—" && / na/.test(rowN.children[1].className)
    && rowN.children[0].children[1].textContent === STR.zh["bt.tip.benchmarkBhNa"]
    && !scan(rn.h.calls).some((e) => e.dash === "[4,4]") && rn.head.children.length === 2 && rn.chart.getAttribute("aria-label") === STR.zh["bt.chartAria"]);
  const rs = render(tw(noSer));
  const rowS = mrow(rs.box);
  ok("沒有 series:數字照出、正常 tooltip、不畫線、圖例兩項",
    rowS && rowS.children[1].textContent === "+61.75%" && rowS.children[0].children[1].textContent === tipOf("bt.tip.benchmarkBhAdj", "0050")
    && !scan(rs.h.calls).some((e) => e.dash === "[4,4]") && rs.head.children.length === 2);
  const ro = render({ ...base, benchmark_band: WIDE });
  const rowO = mrow(ro.box);
  ok("舊台股 / 加密 Type C(只有隨機帶):基準報酬 + 隨機投組句、照畫帶",
    rowO && rowO.children[0].children[0].textContent === "基準報酬" && rowO.children[1].textContent === "贏過 95% 隨機投組"
    && rowO.children[0].children[1].textContent === STR.zh["bt.tip.benchmarkRank"] && scan(ro.h.calls).some((e) => e.op === "fill" && e.fill === BAND_FILL));
  const ra = render({ "Benchmark Return [%]": 12.3, "Total Return [%]": 50, daily_dates: dates, daily_returns: rets });
  const rowA = mrow(ra.box);
  ok("Type A 照舊:基準報酬 +12.30%、Type A 的 tooltip", rowA && rowA.children[1].textContent === "+12.30%" && rowA.children[0].children[1].textContent === STR.zh["bt.tip.benchmark"]);
  // 加密 Type C:BTCUSDT 顯示 BTC、tooltip 是未調整那句(不寫含配息);美股 SPY 是還原價那句
  const rb = render(tw(bhOf({ kind: "BTC_bh", symbol: "BTCUSDT", adjusted: false })));
  const rowB = mrow(rb.box), btnB = rowB && rowB.children[0].children[0];
  ok("BTC:統計列標籤 BTC 持有、BTC 包 .mono、tooltip 未調整那句(沒有含配息)",
    !!btnB && btnB.textContent === "BTC 持有" && btnB.children[0].className === "mono" && btnB.children[0].textContent === "BTC"
    && rowB.children[0].children[1].textContent === tipOf("bt.tip.benchmarkBhRaw", "BTC") && !rowB.children[0].children[1].textContent.includes("配息"),
    rowB && rowB.children[0].textContent);
  ok("BTC:圖例 BTC 持有、aria 用 BTC", JSON.stringify(rb.legend()) === JSON.stringify([["bt-legend", "權益"], ["bt-legend bh", "BTC 持有"], ["bt-legend dd", "回撤"]])
    && rb.chart.getAttribute("aria-label") === "回測期間的權益曲線、BTC 持有與回撤", JSON.stringify(rb.legend()));
  const rsp = render(tw(bhOf({ kind: "SPY_bh", symbol: "SPY", adjusted: true })));
  const rowP = mrow(rsp.box);
  ok("SPY:統計列標籤 SPY 持有、tooltip 還原價那句",
    rowP && rowP.children[0].children[0].textContent === "SPY 持有" && rowP.children[0].children[1].textContent === tipOf("bt.tip.benchmarkBhAdj", "SPY")
    && JSON.stringify(rsp.legend()[1]) === JSON.stringify(["bt-legend bh", "SPY 持有"]), rowP && rowP.children[0].textContent);
  const k5 = ["bt.benchmarkBh", "bt.chartAriaBh", "bt.tip.benchmarkBhAdj", "bt.tip.benchmarkBhRaw", "bt.tip.benchmarkBhNa"];
  ok("五個字串兩語都有,{sym} 在該在的地方", k5.every((k) => STR.zh[k] && STR.en[k] && (k === "bt.tip.benchmarkBhNa" ? !STR.en[k].includes("{sym}") : STR.en[k].includes("{sym}") && STR.zh[k].includes("{sym}"))));
  ok("字串照定稿逐字", STR.zh["bt.benchmarkBh"] === "{sym} 持有" && STR.en["bt.benchmarkBh"] === "{sym} buy & hold"
    && STR.en["bt.chartAriaBh"] === "Equity curve, {sym} buy & hold and drawdown over the backtest period"
    && STR.zh["bt.tip.benchmarkBhNa"] === "這次回測抓不到買進持有基準的價格可比。"
    && STR.zh["bt.tip.benchmarkBhAdj"].includes("含配息") && !STR.zh["bt.tip.benchmarkBhRaw"].includes("配息")
    && STR.en["bt.tip.benchmarkBhAdj"].includes("dividends") && !STR.en["bt.tip.benchmarkBhRaw"].includes("dividend"));
  const tok = fs.readFileSync(path.join(R, "tokens.css"), "utf8");
  ok("tokens.css:--chart-band 亮 #818f97、暗 greyDark", /:root \{[\s\S]*--chart-band: #818f97;[\s\S]*\[data-theme="dark"\] \{[\s\S]*--chart-band: var\(--color-greyDark\);/.test(tok));
}

console.log(red ? "\n" + red + " FAILED" : "\nALL PASS");
process.exit(red ? 1 : 0);
