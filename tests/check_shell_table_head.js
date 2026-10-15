// 策略組合頁與自動下單頁的表頭(Wei 10-15):單位放欄名後的括號裡(zh 全形「金額（USDT）」、en 半形「Amount (USDT)」),
// 跟欄名同一個字樣(不再是另一顆小字 .ccy);未啟動／已暫停的差額 tooltip 拿掉。帳上與優化表金額兩個 tooltip 等定案,還在
// 跑法:node tests/check_shell_table_head.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const R = path.join(__dirname, "..", "shell", "renderer");
const trSrc = fs.readFileSync(path.join(R, "trade.js"), "utf8"), pfSrc = fs.readFileSync(path.join(R, "portfolio.js"), "utf8"), strSrc = fs.readFileSync(path.join(R, "strings.js"), "utf8");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  " + JSON.stringify(d))); if (!c) red++; };
const cut = (src, name) => { const i = src.indexOf("function " + name + "("); let d = 0; for (let k = src.indexOf("{", i); k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}" && --d === 0) return src.slice(i, k + 1); } throw new Error(name); };
const S = { list: strSrc.match(/"tr\.colUnit": "[^"]*"/g) || [] };   // strings.js 先 en 後 zh
const pick = (i) => /"tr\.colUnit": "([^"]*)"/.exec(S.list[i])[1];
const node = (tag) => { const n = { tag, className: "", text: "", kids: [], title: "", appendChild(c) { n.kids.push(c); return c; } }; Object.defineProperty(n, "textContent", { get: () => n.text + n.kids.map((k) => k.textContent).join(""), set: (v) => { n.text = v; n.kids = []; } }); return n; };
const run = (tpl, cols) => {
  const ctx = { document: { createElement: node }, t: (k, o) => (k === "tr.colUnit" ? tpl.replace("{label}", o.label).replace("{unit}", o.unit) : k) };
  vm.createContext(ctx); vm.runInContext(cut(trSrc, "trEl") + "\n" + cut(trSrc, "trHead") + "\nthis.trHead = trHead;", ctx);
  return ctx.trHead(cols).kids[0].kids;
};
ok("tr.colUnit 兩語:en 半形「{label} ({unit})」、zh 全形「{label}（{unit}）」", S.list.length === 2 && pick(0) === "{label} ({unit})" && pick(1) === "{label}（{unit}）");
const zh = run(pick(1), [["金額", "n", "USDT"], ["目標", "n", "口"], ["差額", "n"], ["帳上", "n", null, "def"]]);
ok("zh:金額（USDT）、目標（口）;沒單位的照原字;單位不再是另一顆 .ccy", zh[0].textContent === "金額（USDT）" && zh[1].textContent === "目標（口）" && zh[2].textContent === "差額" && !zh.some((th) => th.kids.some((k) => /ccy/.test(k.className))), zh.map((x) => x.textContent));
const en = run(pick(0), [["Amount", "n", "TWD"], ["Target", "n", null]]);
ok("en:Amount (TWD);單位 null 不加括號", en[0].textContent === "Amount (TWD)" && en[1].textContent === "Target", en.map((x) => x.textContent));
ok("帶說明的欄頭仍是虛線 + title(只剩待定的兩處),字含單位", zh[3].kids[0].className === "th-tip" && zh[3].kids[0].title === "def");
const tips = [...(trSrc + pfSrc).matchAll(/trHead\(([\s\S]*?)\)\);/g)].map((m) => m[1]).join("\n");
ok("差額的未啟動／已暫停 tooltip 與字串都拿掉;剩下的欄頭 tooltip 只有帳上(po.actualTip)與優化表金額(mg.propTip)", !/diffIdle/.test(trSrc + pfSrc + strSrc) && /po\.actualTip/.test(tips) && /mg\.propTip/.test(tips)
  && (tips.match(/\[t\("[^"]+"[^\]]*?, t\(/g) || []).length === 2, tips.match(/\[t\("[^"]+"[^\]]*?, t\(/g));
console.log(red ? `\n${red} FAILED` : "\nALL PASS"); process.exit(red ? 1 : 0);
