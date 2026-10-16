// 配置表「部位」格 trPaintPosCell(spec portfolio-help-icon §2.3,同網頁 pfPaintPosCell):逐狀態畫一次。
// 判斷順序:主機版本較舊 → 還沒有訊號 → 金額 0 不下單 → 空手 → 多／空;雲端等回報整格灰一階、部位 0 畫短線
// 跑法:node tests/check_shell_pos_cell.js
const fs = require("fs"), path = require("path"), vm = require("vm");
let red = 0; const ok = (n, c, info) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || info === undefined ? "" : "  " + info)); if (!c) red++; };
const J = JSON.stringify;
const src = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "trade.js"), "utf8");
const cutF = (n) => { const i = src.indexOf("function " + n + "("); if (i < 0) throw new Error("no " + n); let d = 0; for (let k = src.indexOf("{", i); k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}" && --d === 0) return src.slice(i, k + 1); } throw new Error("no " + n); };
const node = (tag) => { const n = { tag, className: "", text: "", title: "", kids: [], classList: { add(c) { n.className += (n.className ? " " : "") + c; } },
  appendChild(c) { n.kids.push(c); return c; }, append(...c) { n.kids.push(...c); },
  get textContent() { return n.text + n.kids.map((k) => (typeof k === "string" ? k : k.textContent)).join(""); }, set textContent(v) { n.text = v; n.kids = []; } }; return n; };
const flat = (n, out = []) => { if (n && n.tag) { out.push(n); n.kids.forEach((k) => flat(k, out)); } return out; };
const ctx = vm.createContext({ document: { createElement: node }, Math, Number, isFinite, String, JSON, LANG: "zh", price: null,
  t: (k, o) => k + (o ? " " + J(o) : ""), trTxfPrice: () => ctx.price });
vm.runInContext(["trEl", "trFmt", "trRoundLots", "trLotsFmt", "trLotsTgtFmt", "trTxfRefMoney", "trSignalText", "trTypeC", "trPaintPosCell"].map(cutF).join("\n"), ctx);
const TXF = { cv: 200, prod: "tr.txfProd.txf" };
const paint = (a, pos, st, f) => { const td = node("td"); ctx.args = [td, a, pos, st ? vm.runInContext("trTypeC(" + J(st) + ")", ctx) : null, f || {}];
  vm.runInContext("trPaintPosCell.apply(null, args)", ctx); const all = flat(td);
  return { td, txt: td.textContent, cls: td.className, dirs: all.filter((x) => /^dir /.test(x.className)).map((x) => x.className + ":" + x.textContent),
    nums: all.filter((x) => x.className === "num").map((x) => x.textContent), numTip: (all.find((x) => x.className === "num") || {}).title || "",
    word: (all.find((x) => x.className === "pos-word") || {}).textContent, wordTip: (all.find((x) => x.className === "pos-word") || {}).title || "",
    sub: (all.find((x) => x.className === "pos-sub") || {}).textContent, split: all.some((x) => /pos-main split/.test(x.className)), dash: all.some((x) => x.className === "amt-dash") }; };

let r = paint(3000, 1);
ok("做多:方向字「多」上買色、數字不帶號、副行訊號 ×1.00", J(r.dirs) === J(["dir buy:tr.rel.long"]) && J(r.nums) === J(["3,000"]) && r.sub === 'tr.sigLine {"x":"×1.00"}' && r.cls === "n pos", J(r));
r = paint(2000, -0.5);
ok("做空:「空」上賣色、金額取絕對值、副行 ×−0.50", J(r.dirs) === J(["dir sell:tr.rel.short"]) && J(r.nums) === J(["1,000"]) && r.sub === 'tr.sigLine {"x":"×−0.50"}', J(r));
r = paint(2000, 0);
ok("空手(訊號 0、金額 > 0):寫空手、沒有副行、沒有數字", r.word === "tr.flat" && r.sub === undefined && !r.nums.length, J(r));
r = paint(0, 1);
ok("不下單(金額 0)優先於有方向", r.word === "tr.amtOff" && !r.dirs.length, J(r));
r = paint(0, 0);
ok("不下單優先於空手", r.word === "tr.amtOff", J(r));
r = paint(1000, 0, { weights: { A: 0.6, B: -0.3, C: 0 } });
ok("投資組合多空並列:「多 600 · 空 300」(split)、副行持倉 2 檔", r.split && J(r.dirs) === J(["dir buy:tr.rel.long", "dir sell:tr.rel.short"]) && J(r.nums) === J(["600", "300"]) && r.sub === 'tr.typeCHold {"n":2}', J(r));
r = paint(1000, 0, { weights: { A: -0.25, B: -0.25 } });
ok("投資組合只做空:「空 500」、副行持倉 2 檔", !r.split && J(r.dirs) === J(["dir sell:tr.rel.short"]) && J(r.nums) === J(["500"]) && r.sub === 'tr.typeCHold {"n":2}', J(r));
r = paint(1000, 0, { weights: { A: 0, B: 0 } });
ok("投資組合權重全 0:空手", r.word === "tr.flat" && !r.sub, J(r));
ctx.price = 20000; r = paint(2, 1, null, { txf: TXF });
ok("台指期口數列:「多 2」、名目台幣掛在數字上、取整前後相同不寫原值", J(r.dirs) === J(["dir buy:tr.rel.long"]) && J(r.nums) === J(["2"]) && r.numTip === 'tr.lotsNotionalTip {"amt":"8,000,000"}' && r.sub === 'tr.sigLine {"x":"×1.00"}', J(r));
r = paint(3, -0.5, null, { txf: TXF });
ok("台指期取整:−1.5 → 空 2 口(half-up 同對帳器),原值 −1.5 與名目一起掛在數字上", J(r.nums) === J(["2"]) && r.dirs[0] === "dir sell:tr.rel.short" && r.numTip === 'po.lotsRawTip {"n":"−1.5"}\ntr.lotsNotionalTip {"amt":"8,000,000"}', J(r));
ctx.price = null; r = paint(1, 0.4, null, { txf: TXF });
ok("台指期取整後 0 口:寫空手,取整前的原值 0.4 放 tooltip", r.word === "tr.flat" && r.wordTip === 'po.lotsRawTip {"n":"0.4"}' && !r.nums.length, J(r));
r = paint(2, 1, null, { txf: TXF });
ok("台指期沒報價:口數照寫、tooltip 不寫名目", J(r.nums) === J(["2"]) && r.numTip === "", J(r));
r = paint(1000, 1, null, { notYet: true });
ok("還沒有訊號(含新勾還沒存的列):「—」、tooltip tr.sigNotYet、na", r.txt === "—" && r.td.title === "tr.sigNotYet" && r.cls === "n pos na", J(r));
r = paint(0, 0, null, { notYet: true });
ok("還沒有訊號優先於金額 0", r.txt === "—", J(r));
r = paint(1000, 1, null, { noSig: true, notYet: true });
ok("主機版本較舊優先於一切:po.hostOld、na pending", r.txt === "po.hostOld" && r.cls === "n pos na pending", J(r));
r = paint(3000, 1, null, { sentOn: true });
ok("雲端等回報:照狀態畫、整格 pend-col", r.cls === "n pos pend-col" && J(r.nums) === J(["3,000"]), J(r));
r = paint(0, 1, null, { sentOn: true }); const r2 = paint(1000, 0, null, { sentOn: true });
ok("雲端等回報、部位 0(不下單或空手):畫短線,不寫字", r.dash && !r.word && r2.dash && !r2.word && r.cls === "n pos pend-col", J([r, r2]));
r = paint(1000, 1, null, { sentOn: true, notYet: true });
ok("雲端等回報、還沒有訊號:照舊「—」、帶 pend-col", r.txt === "—" && r.cls === "n pos na pend-col", J(r));
const td = paint(3000, 1).td; ctx.args = [td, 0, 1, null, {}]; vm.runInContext("trPaintPosCell.apply(null, args)", ctx);
ok("同一格重畫(打字時 repaint):先清乾淨,不留上一次的子節點與 title", td.textContent === "tr.amtOff" && td.title === "" && td.kids.length === 1);
console.log(red ? red + " FAILED" : "ALL PASS"); process.exitCode = red ? 1 : 0;
