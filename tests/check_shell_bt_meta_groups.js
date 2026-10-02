// 回測頁首那一行(.bt-meta)的結構(web IOS1 的電腦版那一半):每個直接子節點都是一組 .mgrp,沒有獨立的分隔節點;
// 組間的「·」由 CSS 畫在後一組左邊的空隙裡,折到行首時被容器裁掉,行尾不留孤點。
// 不開 Electron:把 report-backtest.js / report-robust.js 的 buildMeta 原文切出來,用假的 DOM 跑。
// 跑法:node tests/check_shell_bt_meta_groups.js
const path = require("path"), fs = require("fs");
const R = path.join(__dirname, "..", "shell", "renderer");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + String(d).slice(0, 600))); if (!c) red++; };
const read = (f) => fs.readFileSync(path.join(R, f), "utf8");
// 從 `function NAME(` 起數大括號,切出整個函式
const cut = (src, name) => { const i = src.indexOf("function " + name + "("); if (i < 0) return ""; let d = 0; for (let j = src.indexOf("{", i); j < src.length; j++) { if (src[j] === "{") d++; else if (src[j] === "}" && --d === 0) return src.slice(i, j + 1); } return ""; };

class Node {
  constructor(tag) { this.tag = tag; this.className = ""; this.children = []; this.text = ""; }
  appendChild(n) { this.children.push(n); return n; }
  append(...ns) { ns.forEach((n) => this.appendChild(n)); }
  setAttribute() {}
  get childNodes() { return this.children; }
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(""); }
}
const el = (tag, cls, text) => { const n = new Node(tag); n.className = cls || ""; if (text != null) n.text = String(text); return n; };
const bt = read("report-backtest.js"), rob = read("report-robust.js");
const btMeta = new Function("el", "t", "const DASH = \"—\", MINUS = \"−\"; const isNum = (v) => typeof v === \"number\" && isFinite(v);\n" + cut(bt, "fmtFixed") + "\n" + cut(bt, "buildMeta") + "\nreturn buildMeta;")(el, (k) => k.toUpperCase());
const robMeta = new Function("el", "const DASH = \"—\"; const isNum = (v) => typeof v === \"number\" && isFinite(v);\n" + cut(rob, "feeTxt") + "\n" + cut(rob, "buildMeta") + "\nreturn buildMeta;")(el);
const NOCTX = { start: null, end: null, fee: null };
const kids = (m) => m.children.map((c) => c.className);
const shown = (m) => m.children.map((c) => c.textContent).join("·");   // 「·」模擬 CSS 在組與組之間畫的點

const full = btMeta({ symbol: "BTCUSDT", interval: "1h", start: "a", end: "b", "fee [%]": 0.05 });
ok("回測頁首:每個直接子節點都是 .mgrp", full.children.length === 4 && kids(full).every((c) => c === "mgrp"), kids(full));
ok("回測頁首:組與組之間一個點、頭尾沒有點;手續費的標籤與值在同一組", shown(full) === "BTCUSDT·1h·a → b·BT.FEE0.05%", shown(full));
const noSym = btMeta({ interval: "1d", start: "x", end: "y", fee: 0.001 });
ok("沒有 symbol:第一組就是內容,不以點開頭", kids(noSym).every((c) => c === "mgrp") && shown(noSym) === "1d·x → y·BT.FEE0.10%", shown(noSym));
const rm = robMeta({}, { rows: [1, 2, 3], cols: [1, 2], ctx: NOCTX }, { buildMeta: () => btMeta({ symbol: "ETHUSDT", interval: "4h" }), t: (k) => k });
ok("參數掃描頁首:接在回測頁首後面也只加組,沒有獨立的分隔節點", kids(rm).every((c) => c === "mgrp") && shown(rm) === "ETHUSDT·4h·rob.metaScan3×2", shown(rm));
const rm0 = robMeta({}, { rows: [1], cols: [1], ctx: NOCTX }, { buildMeta: () => null, t: (k) => k });
ok("參數掃描頁首:回測頁首是空的也只有一組", kids(rm0).join() === "mgrp", kids(rm0));
const rmOwn = robMeta({ symbol: "TXF", interval: "1h", start: "2015-01-01", end: "2026-10-01", "fee [%]": 0.01 }, { rows: [1, 2], cols: [1], ctx: { start: "2020-01-01", end: "2026-09-15", fee: 0.02 } }, { buildMeta: (o) => btMeta(o), t: (k) => k });
ok("參數掃描頁首(0.1.12):期間與手續費是掃描自己的、不是回測的;手續費那組由參數掃描自己加(同 .mgrp,不重複)", kids(rmOwn).every((c) => c === "mgrp") && shown(rmOwn) === "TXF·1h·2020-01-01 → 2026-09-15·bt.fee0.02%·rob.metaScan2×1", shown(rmOwn));
ok("兩個檔案都沒有 bt-sep / bt-mpart / msep 這種獨立節點", !/bt-sep|bt-mpart|msep/.test(bt + rob));

const css = read("report-backtest.css").replace(/\/\*[\s\S]*?\*\//g, "");
const rule = (sel) => { const i = css.indexOf("\n" + sel + " {"); return i < 0 ? "" : css.slice(i, css.indexOf("}", i)); };
ok("容器裁掉折到行首的點(overflow-x: clip)、組間 24", /overflow-x: clip;/.test(rule(".bt-meta")) && /gap: var\(--space-4\) var\(--space-24\);/.test(rule(".bt-meta")), rule(".bt-meta"));
const dot = rule(".bt-meta > .mgrp + .mgrp::before");
ok("點畫在後一組左邊的空隙裡(absolute、right: 100%、寬 24 置中),讀屏不念", /content: "·" \/ "";/.test(dot) && /position: absolute;/.test(dot) && /right: 100%;/.test(dot) && /width: var\(--space-24\);/.test(dot) && /text-align: center;/.test(dot)
  && /position: relative;/.test(rule(".bt-meta > .mgrp")) && /white-space: nowrap;/.test(rule(".bt-meta > .mgrp")), dot);

console.log(red ? `\n${red} FAILED` : "\nALL PASS");
process.exit(red ? 1 : 0);
