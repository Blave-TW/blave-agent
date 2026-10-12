// 報告圖浮水印畫在圖底署名列(canon design-system › Chart watermark › 位置;同 web tests/check_report_wm_row.js,改讀電腦版渲染器)。
//
// 跑法:node tests/check_shell_report_wm_row.js
//
// 載入整支 report-blocks.js(假 DOM、沒有 ResizeObserver → 各圖照預設寬同步畫完),
// 每種圖各畫一張:浮水印的字頂要在所有資料與軸標的下緣之下,字底要在 viewBox 內。
// 舊版畫在繪圖區右下、被資料蓋住(手機寬的負值直條吃掉 blave.org)。
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const js = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "report-blocks.js"), "utf8");

function Node(tag) {
  this.tagName = tag.toUpperCase();
  this.attrs = {};
  this.kids = [];
  this.className = "";
  this.textContent = "";
  const self = this;
  this.classList = {
    add: (c) => { self.className = (self.className + " " + c).trim(); },
    toggle: () => {},
    contains: (c) => (self.attrs.class || self.className).split(" ").includes(c),
  };
}
Node.prototype.appendChild = function (k) { this.kids.push(k); return k; };
Node.prototype.insertBefore = function (k) { this.kids.push(k); return k; };
Node.prototype.replaceChild = function (n, o) { this.kids[this.kids.indexOf(o)] = n; };
Node.prototype.setAttribute = function (k, v) { this.attrs[k] = String(v); };
Node.prototype.getAttribute = function (k) { return this.attrs[k]; };
Node.prototype.removeAttribute = function (k) { delete this.attrs[k]; };
Node.prototype.querySelector = function () { return null; };

const document = {
  documentElement: { lang: "zh" },
  createElement: (t) => new Node(t),
  createElementNS: (ns, t) => new Node(t),
  createTextNode: (t) => { const n = new Node("#text"); n.textContent = t; return n; },
};
const window = { console };
vm.runInNewContext(js, { window, document, console });
const render = window.renderReportBlock;

let red = 0;
function ok(name, cond, detail) {
  console.log((cond ? "ok   " : "FAIL ") + name + (cond ? "" : "  " + JSON.stringify(detail)));
  if (!cond) red++;
}
function all(node, out) {
  out = out || [];
  out.push(node);
  node.kids.forEach((k) => all(k, out));
  return out;
}
function svgOf(node) {
  return all(node).find((n) => n.tagName === "SVG");
}
// 每個非浮水印元素的下緣(viewBox 單位);文字基線下再算 3 的下伸部
function lowEdge(n) {
  const a = n.attrs, f = (k) => parseFloat(a[k]);
  switch (n.tagName) {
    case "TEXT": return f("y") + 3;
    case "RECT": return f("y") + f("height");
    case "LINE": return Math.max(f("y1"), f("y2"));
    case "CIRCLE": return f("cy") + f("r");
    case "POLYLINE": return Math.max(...a.points.split(" ").map((p) => +p.split(",")[1]));
    case "PATH": {
      const nums = a.d.match(/-?[\d.]+/g).map(Number);
      return Math.max(...nums.filter((_, i) => i % 2 === 1));
    }
    default: return -Infinity;
  }
}

const day = 86400, t0 = 1704067200;
const line = (k) => Array.from({ length: 60 }, (_, i) => [t0 + i * day, Math.sin(i / 7) * 10 - i * k]);
const cases = {
  line_chart: { type: "line_chart", y_unit: "%", series: [{ name: "A", role: "primary", points: line(0.3) }] },
  candlestick: {
    type: "candlestick",
    candles: Array.from({ length: 40 }, (_, i) => [t0 + i * day, 100 - i, 103 - i, 97 - i, 99 - i]),
  },
  drawdown: { type: "drawdown", points: line(0.1).map((p) => [p[0], -Math.abs(p[1])]) },
  "bar_chart bars(直條)": {
    type: "bar_chart", variant: "bars",
    items: [{ label: "20日", value: 1.03 }, { label: "60日", value: -2.13 }],
  },
  "bar_chart bars(橫條)": {
    type: "bar_chart", variant: "bars",
    items: Array.from({ length: 12 }, (_, i) => ({ label: "很長的類別名稱第" + i + "項", value: i % 2 ? i : -i })),
  },
  "bar_chart profile": {
    type: "bar_chart", variant: "profile",
    buckets: Array.from({ length: 10 }, (_, i) =>
      i < 5 ? { x0: 100 + i, x1: 101 + i, neg: 10 + i } : { x0: 100 + i, x1: 101 + i, pos: 30 - i }),
    refline: { x: 105, label: "105" },
  },
  histogram: {
    type: "histogram", x_unit: "%",
    bins: Array.from({ length: 12 }, (_, i) => ({ x0: i - 6, x1: i - 5, count: 12 - Math.abs(i - 6) })),
  },
  box: {
    type: "box", y_unit: "%",
    groups: [
      { label: "1月", min: -2, q1: -0.6, median: 0.1, q3: 0.8, max: 2.4 },
      { label: "5月", min: -3.4, q1: -1.6, median: -0.7, q3: 0.2, max: 1.4, outliers: [-4.1] },
    ],
  },
  scatter: {
    type: "scatter", x_unit: "%", y_unit: "%",
    points: Array.from({ length: 30 }, (_, i) => ({ x: i - 15, y: ((i * 7) % 13) - 6 })),
    regression: { slope: 0.3, intercept: 0 },
  },
};

Object.keys(cases).forEach((name) => {
  const node = render(cases[name], {});
  const s = node && svgOf(node);
  if (!s) return ok(name + ":畫得出來", false, null);
  const vbH = parseFloat(s.attrs.viewBox.split(" ")[3]);
  const nodes = all(s);
  const wm = nodes.filter((n) => (n.attrs.class || "") === "rb-wm");
  ok(name + ":恰好一個浮水印", wm.length === 1, wm.length);
  if (wm.length !== 1) return;
  const y = parseFloat(wm[0].attrs.y);
  const low = Math.max(...nodes.filter((n) => n !== wm[0]).map(lowEdge));
  // 11px 字的字頂約在基線上 8
  ok(name + ":浮水印在資料與軸標之下", y - 8 > low, { wmY: y, lowestOther: low });
  ok(name + ":浮水印在 viewBox 內", y + 3 <= vbH, { wmY: y, vbH });
  if (s.attrs.height) ok(name + ":釘死的 height 含署名列", +s.attrs.height === vbH, s.attrs.height);
});

// 散布圖:署名列緊貼 x 軸標籤下一行(Wei 核准),不隔一段空帶
{
  const s = svgOf(render(cases.scatter, {}));
  const texts = all(s).filter((n) => n.tagName === "TEXT");
  const wmY = +texts.find((n) => n.attrs.class === "rb-wm").attrs.y;
  const axisY = Math.max(...texts.filter((n) => n.attrs.class !== "rb-wm").map((n) => +n.attrs.y));
  ok("scatter:署名列與 x 軸標籤基線相距 ≤ 20", wmY - axisY <= 20, { wmY, axisY });
}

// 給定尺寸(看盤板卡片的 chartSize):署名列從框內扣,整張圖不超出呼叫端給的高
{
  const s = svgOf(render(cases.line_chart, { chartSize: { w: 400, h: 300 } }));
  ok("line_chart:給定高 300 → viewBox 高 300", s.attrs.viewBox === "0 0 400 300", s.attrs.viewBox);
}

ok("dodgeWatermark 已刪", !/dodgeWatermark/.test(js));

console.log(red ? "\nFAIL " + red + " 項" : "\nALL PASS");
process.exit(red ? 1 : 0);
