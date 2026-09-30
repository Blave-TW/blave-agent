// 報告 bar_chart 的 profile 變體(爆倉地圖;契約 report-blocks.md 1.5、型錄 v1.5 裁示)——電腦版渲染器。
// 案例同 web/tests/check_report_profile.js;幾何與 draw 本體照慣例與 web 逐字一致(最後一組斷言比對)。
//
// 跑法:node tests/check_shell_report_profile.js
//
// 從 report-blocks.js 切真的 profileSpan / profileBucket / profileCum / profileBars(連同幾何 helper)
// 來跑:量測桶 {x0,x1,pos?,neg?} 同桶兩段(pos 綠上 neg 紅下、共桶寬、不淨額)、
// 桶縫規則、est 自 refline 向兩側 cumsum(無 refline 不畫、全圖單一 max 正規化到 85%)、
// refline 永不升紅、x 刻度抽稀、縱軸 2–3 刻度。bars / stacked 照舊。
const fs = require("fs");
const path = require("path");

const RD = path.join(__dirname, "..", "shell", "renderer");
const js = fs.readFileSync(path.join(RD, "report-blocks.js"), "utf8");
const css = fs.readFileSync(path.join(RD, "report-blocks.css"), "utf8");

let red = 0;
function ok(name, cond, detail) {
  console.log((cond ? "ok   " : "FAIL ") + name + (cond ? "" : "  " + JSON.stringify(detail)));
  if (!cond) red++;
}

// ---- 沙盒:真幾何 + 假 SVG 節點
function grab(name) {
  const a = js.indexOf("  function " + name + "(");
  if (a < 0) throw new Error("找不到 " + name);
  return js.slice(a, js.indexOf("\n  }\n", a) + 4);
}
function Node(tag) { this.tag = tag; this.attrs = {}; this.kids = []; this.text = ""; this.cls = ""; }
Node.prototype.appendChild = function (k) { this.kids.push(k); return k; };
Node.prototype.setAttribute = function (k, v) { this.attrs[k] = String(v); };
Node.prototype.replaceChild = function (n, o) { this.kids[this.kids.indexOf(o)] = n; };
const env = {
  MINUS: "−", DASH: "—", FULL_WIDTH: /[⺀-鿿豈-﫿＀-￯]/,
  global: {}, // 沒有 ResizeObserver → draw(680, 200) 同步走完
  el: (tag, cls) => { const n = new Node(tag); n.cls = cls || ""; return n; },
  svgEl: (tag, attrs) => {
    const n = new Node(tag);
    if (attrs) Object.keys(attrs).forEach((k) => { if (attrs[k] != null) n.attrs[k] = String(attrs[k]); });
    return n;
  },
  svgText: (x, y, t, attrs) => {
    const n = env.svgEl("text", attrs || {});
    n.attrs.x = String(x); n.attrs.y = String(y); n.text = t == null ? "" : String(t);
    return n;
  },
};
const code = ["num", "str", "arr", "group", "trimNum", "fmtAxis", "isWordUnit", "niceScale",
  "textWidth", "yGutter", "plotTop", "plotBottom", "plotTopOf", "xUnitPad", "xUnitLabel",
  "polyline", "chartSvg", "watermark", "profileSpan", "profileBucket", "profileCum", "profileBars"]
  .map(grab).join("\n");
const lib = new Function(...Object.keys(env), code + "\nreturn { profileBucket, profileCum, profileBars };")(...Object.values(env));

function all(node, pred, out) {
  out = out || [];
  if (pred(node)) out.push(node);
  (node.kids || []).forEach((k) => all(k, pred, out));
  return out;
}
const byCls = (n, c) => all(n, (x) => (x.attrs.class || "") === c);
const pts = (poly) => poly.attrs.points.split(" ").map((p) => p.split(",").map(Number));
const CTX = { i18n: { estModel: "EST" } };

// ---- profileCum(純函式):自 refline 向兩側累加,值放在離 refline 較遠的桶緣
const cum = lib.profileCum(
  [{ x0: 100, x1: 101, value: 5 }, { x0: 101, x1: 102, value: 3 }, { x0: 103, x1: 104, value: 7 }],
  102.5
);
ok("cumsum 方向:左側自近而遠累加、值在外緣(x0)",
  JSON.stringify(cum.left) === JSON.stringify([{ x: 101, cum: 3 }, { x: 100, cum: 8 }]), cum.left);
ok("cumsum 方向:右側值在外緣(x1)",
  JSON.stringify(cum.right) === JSON.stringify([{ x: 104, cum: 7 }]), cum.right);
// 跨在 refline 上的估計桶依「中點」分邊(web 同步的判斷點 2;x0<refX 那種寫法會分錯)
const straddle = lib.profileCum([{ x0: 104, x1: 106, value: 9 }], 104.5);
ok("跨線桶(x0 104–106,ref 104.5,中點 105)→ 右側", straddle.right.length === 1 && straddle.left.length === 0, straddle);

// ---- 主圖:100–110 十桶,現價 105,左多爆(neg)右空爆(pos);第 3 桶兩邊都有量
const buckets = [];
for (let i = 0; i < 10; i++)
  buckets.push(
    i === 2
      ? { x0: 102, x1: 103, pos: 12, neg: 12 } // 同桶兩段,而且不可淨額成 0
      : i < 5
        ? { x0: 100 + i, x1: 101 + i, neg: 10 + i }
        : { x0: 100 + i, x1: 101 + i, pos: 30 - i }
  );
const est = buckets.map((bk) => ({ x0: bk.x0, x1: bk.x1, value: (bk.pos || 0) + (bk.neg || 0) }));
const refline = { x: 105, label: "105" };
const full = lib.profileBars({ variant: "profile", buckets, est, refline }, CTX);
const svg = full.kids[0];

const ups = byCls(svg, "rb-bar-up"), dns = byCls(svg, "rb-bar-dn");
// 桶數:neg 4 桶 + pos 5 桶 + 兩段桶(pos+neg)1 桶 → 綠 6 段、紅 5 段
ok("量測桶:pos=綠 6 段、neg=紅 5 段(第 3 桶兩段都畫,不淨額)",
  ups.length === 6 && dns.length === 5, [ups.length, dns.length]);
const zeroY = Number(byCls(svg, "rb-grid")[0].attrs.y1);
ok("pos 段自零軸向上、neg 段自零軸向下",
  ups.every((r) => Math.abs(Number(r.attrs.y) + Number(r.attrs.height) - zeroY) < 0.01) &&
  dns.every((r) => Number(r.attrs.y) === zeroY), zeroY);
const both = { up: ups.find((r) => r.attrs.x === dns.find((d) => d.attrs.x === r.attrs.x)?.attrs.x) };
both.dn = dns.find((d) => d.attrs.x === both.up.attrs.x);
ok("同桶兩段共桶寬(同 x、同寬,不半寬並排)",
  both.up && both.dn && both.up.attrs.width === both.dn.attrs.width, both);
ok("pos:12 / neg:12 兩段等高、皆 > 0(不淨額)",
  Number(both.up.attrs.height) > 5 &&
  Math.abs(Number(both.up.attrs.height) - Number(both.dn.attrs.height)) < 0.01, both);
ok("舊形狀 value 不再收:只帶 value 的桶畫不出段",
  byCls(lib.profileBars({ variant: "profile", buckets: [{ x0: 0, x1: 1, value: 5 }, { x0: 1, x1: 2, value: -3 }] }, CTX).kids[0], "rb-bar-up").length === 0);
const slot = Number(dns[1].attrs.x) - Number(dns[0].attrs.x);
ok("桶縫 2px(桶寬 ≥6px)", Math.abs(slot - Number(dns[0].attrs.width) - 2) < 0.01, [slot, dns[0].attrs.width]);

const estLines = byCls(svg, "rb-est");
ok("est:左右各一條灰虛線", estLines.length === 2, estLines.length);
const [L, R] = [pts(estLines[0]), pts(estLines[1])];
ok("兩條都從 refline 的零軸起點出發", L[0][1] === zeroY && R[0][1] === zeroY && L[0][0] === R[0][0], [L[0], R[0]]);
ok("左條 x 遞減、右條 x 遞增(向兩側)",
  L.every((p, i) => !i || p[0] < L[i - 1][0]) && R.every((p, i) => !i || p[0] > R[i - 1][0]));
ok("cumsum 單調:越遠越高(y 遞減)",
  L.every((p, i) => !i || p[1] < L[i - 1][1]) && R.every((p, i) => !i || p[1] < R[i - 1][1]));
const top = 14; // 沒有詞單位 y_unit → plotTop(14) = 14
const minY = Math.min.apply(null, L.concat(R).map((p) => p[1]));
ok("最大累計 = 零軸以上繪圖區高的 85%", Math.abs(minY - (zeroY - 0.85 * (zeroY - top))) < 0.06, [minY, zeroY]);
ok("est 圖內標注(字樣由渲染端固定,i18n)", all(svg, (n) => n.text === "EST").length === 1);

const refEl = byCls(svg, "rb-ref");
ok("refline:預設樣式、永不升紅(沒有 is-em)", refEl.length === 1 && byCls(svg, "rb-ref is-em").length === 0);
ok("refline 頂端標籤", byCls(svg, "rb-ref-label")[0].text === "105");
ok("浮水印照掛(有繪圖區才掛)", byCls(svg, "rb-wm").length === 1);

// 縱軸 2–3 刻度:跨零 3 個、全正 2 個(text-anchor end、去掉浮水印)
const yTicks = (s) => all(s, (n) => n.tag === "text" && n.attrs["text-anchor"] === "end" && n.attrs.class !== "rb-wm");
ok("縱軸跨零 3 刻度(lo / 0 / hi)", yTicks(svg).length === 3, yTicks(svg).map((t) => t.text));
const posOnly = lib.profileBars(
  { variant: "profile", buckets: [{ x0: 0, x1: 1, pos: 2 }, { x0: 1, x1: 2, pos: 5 }] }, CTX
).kids[0];
ok("全正資料:2 刻度、正值帶 +(軸含零)", yTicks(posOnly).length === 2 && yTicks(posOnly).some((t) => t.text.charAt(0) === "+"), yTicks(posOnly).map((t) => t.text));

// x 刻度抽稀:100 桶不逐桶標
const many = [];
for (let i = 0; i < 150; i++) many.push({ x0: i, x1: i + 1, pos: 1 });
const manySvg = lib.profileBars({ variant: "profile", buckets: many }, CTX).kids[0];
const xTickN = all(manySvg, (n) => n.tag === "text" && n.attrs["text-anchor"] !== "end").length;
ok("x 刻度抽稀(150 桶 ≤ 8 個刻度)", xTickN > 1 && xTickN <= 8, xTickN);
const narrow = byCls(manySvg, "rb-bar-up");
const nslot = Number(narrow[1].attrs.x) - Number(narrow[0].attrs.x);
ok("桶寬 <6px 時縫收 1px", nslot < 6 && Math.abs(nslot - Number(narrow[0].attrs.width) - 1) < 0.01, [nslot, narrow[0].attrs.width]);

// est 但沒有 refline:不畫(累加方向沒有定義);桶照畫
// est 正規化必須是全圖單一 max:設計師以今天真資料驗(左總量 1,737、右 574,
// 右端終點該落在左側最高點的 574/1737 ≈ 33% 高;左右各自正規化會把右端拉到 100%)
{
  const eb = [
    { x0: 0, x1: 1, value: 1000 }, { x0: 1, x1: 2, value: 737 },
    { x0: 3, x1: 4, value: 300 }, { x0: 4, x1: 5, value: 274 },
  ];
  const bkt = eb.map((e) => ({ x0: e.x0, x1: e.x1, pos: 1 }));
  const s2 = lib.profileBars({ variant: "profile", buckets: bkt, est: eb, refline: { x: 2.5, label: "x" } }, CTX).kids[0];
  const z2 = Number(byCls(s2, "rb-grid")[0].attrs.y1);
  const lines = byCls(s2, "rb-est").map(pts);
  const leftEnd = lines[0][lines[0].length - 1][1];
  const rightEnd = lines[1][lines[1].length - 1][1];
  const amp2 = 0.85 * (z2 - 14);
  ok("左 1,737 → 頂到 85% 全高", Math.abs(leftEnd - (z2 - amp2)) < 0.06, [leftEnd, z2 - amp2]);
  ok("右 574 → 畫在 574/1737 ≈ 33% 高(全圖單一 max,不是各自 100%)",
    Math.abs(rightEnd - (z2 - (574 / 1737) * amp2)) < 0.06, [rightEnd, z2 - (574 / 1737) * amp2]);
}

const noRef = lib.profileBars({ variant: "profile", buckets, est }, CTX);
ok("est 無 refline:不畫 est、也沒有圖內標注",
  byCls(noRef.kids[0], "rb-est").length === 0 && all(noRef.kids[0], (n) => n.text === "EST").length === 0);
ok("桶不足 2 → null", lib.profileBars({ variant: "profile", buckets: [{ x0: 0, x1: 1, pos: 1 }] }, CTX) === null);
ok("pos / neg 帶負數的桶不合法", !lib.profileBucket({ x0: 0, x1: 1, pos: -1 }) && !lib.profileBucket({ x0: 0, x1: 1, neg: -1 }) && lib.profileBucket({ x0: 0, x1: 1 }));

// ---- 接線與樣式
ok("dispatch:profile → profileBars;bars / stacked 照舊",
  /if \(b\.variant === "stacked"\) return stackedBar\(b, ctx\);\n\s*if \(b\.variant === "profile"\) return profileBars\(b, ctx\);\n\s*return signedBars\(b, ctx\);/.test(js));
ok("CSS:.rb-est = greyMedium(電腦版 token --ink-3)1.5px 虛線、不上漲跌色",
  /\.rb-report \.rb-chart \.rb-est \{\n\s*fill: none;\n\s*stroke: var\(--ink-3\);\n\s*stroke-width: 1\.5;\n\s*stroke-dasharray: 4 3;/.test(css));
ok("DEFAULT_I18N 有 estModel", /estModel: "Est\. liquidation \(model\)",/.test(js));
{
  const strings = fs.readFileSync(path.join(RD, "strings.js"), "utf8");
  ok("i18n:rb.estModel 兩語都有、rptI18n 有接", /"rb\.estModel": "Est\. liquidation \(model\)"/.test(strings)
    && /"rb\.estModel": "預估清算量（模型）"/.test(strings)
    && /estModel: t\("rb\.estModel"\)/.test(fs.readFileSync(path.join(RD, "reports.js"), "utf8")));
}
// 幾何與 draw 本體照慣例與 web 逐字一致(同 dataDp / fmtLegend 那條)
const WEB_RB = path.join(__dirname, "..", "..", "web", "app", "static", "js", "agent", "report_blocks.js");
if (!fs.existsSync(WEB_RB)) console.log("SKIP  與 web 逐字比對(需要 monorepo 版面)");
else {
  const web = fs.readFileSync(WEB_RB, "utf8");
  const g = (src2, n) => { const a = src2.indexOf("  function " + n + "("); return a < 0 ? null : src2.slice(a, src2.indexOf("\n  }\n", a)); };
  ok("profileSpan / profileBucket / profileCum / profileBars 與 web 逐字相同",
    ["profileSpan", "profileBucket", "profileCum", "profileBars"].every((n) => g(web, n) && g(web, n) === g(js, n)));
}

console.log(red ? "\nFAIL " + red + " 項" : "\nALL PASS");
process.exit(red ? 1 : 0);
