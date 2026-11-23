// 策略組合區段標籤旁的說明外連(spec portfolio-help-icon §1;0.1.60 QA R4-2 改成文字「說明」＋ arrow-up-right,canon strategy-report › 說明文章外連):
// 配置、優化各一顆,外開教學頁對應段落(帶 ?src=desktop_learn)、各記 po_help_cfg／po_help_opt;可及名稱補「(在瀏覽器開啟)」;重畫後焦點靠 data-fk 找回
// 跑法:node tests/check_shell_po_help.js
const fs = require("fs"), path = require("path"), vm = require("vm");
let red = 0; const ok = (n, c, info) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || info === undefined ? "" : "  " + info)); if (!c) red++; };
const R = path.join(__dirname, "..", "shell", "renderer");
const src = fs.readFileSync(path.join(R, "trade.js"), "utf8"), psrc = fs.readFileSync(path.join(R, "portfolio.js"), "utf8");
const css = fs.readFileSync(path.join(R, "trade.css"), "utf8");
const cutF = (s, n) => { const i = s.indexOf("function " + n + "("); if (i < 0) throw new Error("no " + n); let d = 0; for (let k = s.indexOf("{", i); k < s.length; k++) { if (s[k] === "{") d++; else if (s[k] === "}" && --d === 0) return s.slice(i, k + 1); } throw new Error("no " + n); };

function node(tag) {
  return { tag, kids: [], attrs: {}, dataset: {}, on: {}, className: "", textContent: "",
    setAttribute(k, v) { this.attrs[k] = String(v); }, appendChild(c) { this.kids.push(c); return c; }, append(...c) { this.kids.push(...c); },
    addEventListener(e, f) { this.on[e] = f; } };
}
const opened = [], tracked = [];
const ctx = vm.createContext({ document: { createElement: node, createElementNS: (_ns, tag) => node(tag), createDocumentFragment: () => node("#frag") },
  t: (k) => k, trackFeature: (n) => tracked.push(n), docsUrl: (p) => "https://blave.org/docs/zh/" + p, window: { blave: { openExternal: (u) => opened.push(u) } },
  trEl: (tag, cls, text) => { const n = node(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; } });
vm.runInContext(cutF(src, "poHelpGroup"), ctx);
const make = (anchor, fk) => vm.runInContext(`poHelpGroup(trEl("span", "label", "L"), ${JSON.stringify(anchor)}, ${JSON.stringify(fk)})`, ctx);
const g = make("amounts", "po-help-cfg"), b = g.kids[1];
ok("結構:.lbl-grp 裡先標籤、後 button.pf-help(type=button、data-fk)", g.className === "lbl-grp" && g.kids[0].className === "label" && b.tag === "button" && b.type === "button" && b.className === "pf-help" && b.dataset.fk === "po-help-cfg");
ok("可見字「說明」、可及名稱 po.guideAria(包含可見字、補在瀏覽器開啟);不是 ?、沒有頁內泡泡、不加 title", b.attrs["aria-label"] === "po.guideAria" && b.kids[0].textContent === "po.guide"
  && !b.kids.some((k) => k.className === "pf-help-tip") && b.title === undefined);
ok("icon 是 svg、aria-hidden(Lucide arrow-up-right:兩條 path,沒有 circle)", b.kids[1].tag === "svg" && b.kids[1].attrs["aria-hidden"] === "true" && b.kids[1].kids.map((k) => k.tag).join() === "path,path");
b.on.click(); make("optimize", "po-help-opt").kids[1].on.click();
ok("按下:外開教學頁帶 ?src=desktop_learn 與段落錨點,記 po_help_cfg／po_help_opt(一顆一個名字)", JSON.stringify(opened) === JSON.stringify(["https://blave.org/docs/zh/portfolio?src=desktop_learn#amounts", "https://blave.org/docs/zh/portfolio?src=desktop_learn#optimize"]) && JSON.stringify(tracked) === JSON.stringify(["po_help_cfg", "po_help_opt"]));
ok("配置的三種標籤狀態(載入中、讀不到設定、有表)都走 poCfgSec;霧後面的示意底不放問號",
  (cutF(src, "poPaintCfg").match(/poCfgSec\(\)/g) || []).length === 2 && /poCfgSec\(\)/.test(cutF(src, "trAmountTable")) && !/poHelpGroup|poCfgSec/.test(cutF(psrc, "poFogCfg")));
ok("優化:「權重分配」區標題拿掉,問號搬到工具列右端(spec portfolio-optimize-lite §3),一直在", /poHelpGroup\(document\.createTextNode\(""\), "optimize", "po-help-opt"\)/.test(cutF(psrc, "mgToolbar")) && !/mg\.secAmounts/.test(psrc));
ok("CSS:熱區 44(上下 10、右 14、左 6)、z-index 2、12px ink-3、icon 12;沒有 ? 的泡泡規則了",
  /\.pf-help::before \{[^}]*inset: -10px -14px -10px -6px/.test(css) && /\.pf-help \{[^}]*z-index: 2/.test(css) && /\.pf-help \{[^}]*font-size: 12px/.test(css) && /\.pf-help \{[^}]*color: var\(--ink-3\)/.test(css)
  && /\.pf-help \.ic \{[^}]*width: 12px/.test(css) && !/pf-help-tip/.test(css) && !/\.pf-help[^{]*\{[^}]*cursor: help/.test(css));
console.log(red ? red + " FAILED" : "ALL PASS"); process.exitCode = red ? 1 : 0;
