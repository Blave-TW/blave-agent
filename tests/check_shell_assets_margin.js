// 資產分頁的保證金列(台灣期貨帳戶;設計 spec president-assets 版本 A):既有「帳戶 / 淨值」列下接一組
// .pf-wallets-cap.margin + .pf-wallet-row——可動用 / 原始 / 維持保證金、風險指標(前端算 權益數 ÷ 原始保證金)、更新時間。
// 缺值:key 存在但 null = 「—」;key 不存在 = 整列不畫;三個 key 都不存在 = 整塊不畫(加密所畫面不變)。
// 跑法:node tests/check_shell_assets_margin.js
const fs = require("fs"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "trade.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "trade.css"), "utf8");
let red = 0; const ok = (name, c) => { console.log((c ? "PASS  " : "FAIL  ") + name); if (!c) red++; };
const J = JSON.stringify;
const cut = (from, to) => { const a = src.indexOf(from), b = src.indexOf(to, a + from.length); if (a < 0 || b < 0) throw new Error("找不到 " + from); return src.slice(a, b); };

// ── 純邏輯:trMarginModel / trTwd 在純邏輯區塊裡(不碰 DOM) ──
eval(cut("/* ── 純邏輯(", "/* ── 純邏輯到此").replace(/^const /gm, "var "));
const PRES = { ok: true, equity: 12147198, currency: "TWD", accounts: { futures: 12147198 }, available: 11921198, initial_margin: 226000, maintenance_margin: 173000, margin_updated_at: 1790907300 };
let m = trMarginModel(PRES, 1);
ok("統一:三列照 key 順序、風險指標 = 權益數 ÷ 原始保證金 × 100、更新時間用 margin_updated_at", m && J(m.rows) === J([{ key: "available", value: 11921198 }, { key: "initial_margin", value: 226000 }, { key: "maintenance_margin", value: 173000 }])
  && Math.abs(m.risk.ratio - 5374.87) < 0.01 && m.risk.below === false && m.at === 1790907300);
ok("沒有 margin_updated_at 退回帳戶讀取器的 read_at;兩個都沒有 = null(不畫右側)", trMarginModel({ ...PRES, margin_updated_at: null }, 1759800000).at === 1759800000 && trMarginModel({ ...PRES, margin_updated_at: undefined }, null).at === null);
ok("原始保證金 0(沒部位)或 null:風險指標算不出 = null、不是 Infinity;不掛 below", trMarginModel({ ...PRES, initial_margin: 0 }, 1).risk.ratio === null && trMarginModel({ ...PRES, initial_margin: null }, 1).risk.ratio === null && trMarginModel({ ...PRES, initial_margin: 0, maintenance_margin: 0 }, 1).risk.below === false);
m = trMarginModel({ ...PRES, equity: 158420, accounts: { futures: 158420 } }, 1);
ok("權益數 < 維持保證金(且維持 > 0)= below;比率照算(70.10)", m.risk.below === true && Math.abs(m.risk.ratio - 70.10) < 0.01);
ok("權益數剛好等於維持保證金不算 below;維持 null / 0 永遠不算", trMarginModel({ ...PRES, equity: 173000, accounts: { futures: 173000 } }, 1).risk.below === false
  && trMarginModel({ ...PRES, equity: 1, accounts: { futures: 1 }, maintenance_margin: null }, 1).risk.below === false && trMarginModel({ ...PRES, equity: 1, accounts: { futures: 1 }, maintenance_margin: 0 }, 1).risk.below === false);
ok("群益(只有 available):一列、沒有風險指標列(原始保證金 key 不存在)", J(trMarginModel({ ok: true, equity: 1047300, currency: "TWD", available: 914300 }, 5)) === J({ rows: [{ key: "available", value: 914300 }], risk: null, at: 5 }));
ok("key 存在但 null:列保留、值 null(畫「—」);不是數字(字串 / NaN)同 null", J(trMarginModel({ ok: true, equity: 1, available: null, initial_margin: "x", maintenance_margin: NaN }, 1).rows.map((r) => r.value)) === J([null, null, null]));
ok("三個 key 都不存在(加密所、模擬)或讀失敗 = null(整塊不畫)", trMarginModel({ ok: true, equity: 1, accounts: { spot: 1, futures: 2 }, margin_updated_at: 9 }, 1) === null && trMarginModel({ ...PRES, ok: false }, 1) === null && trMarginModel(null, 1) === null);
ok("trTwd:整數、千分位、負值 U+2212;不是數字 null", trTwd(12147198) === "12,147,198" && trTwd(-67580.4) === "−67,580" && trTwd(0) === "0" && trTwd(NaN) === null && trTwd("1") === null);

// ── 畫面:最小假 DOM 跑原文的 trPaintAssets(同 check_shell_assets.js) ──
class N {
  constructor(tag) { this.tag = tag; this.children = []; this._t = ""; this.attrs = {}; this.className = ""; this.dataset = {}; }
  set textContent(v) { this._t = v == null ? "" : String(v); this.children = []; }
  get textContent() { return this._t + this.children.map((c) => c.textContent).join(""); }
  appendChild(c) { if (c.frag) { this.children.push(...c.children); c.children = []; } else this.children.push(c); return c; }
  append(...cs) { cs.forEach((c) => this.appendChild(typeof c === "string" ? document.createTextNode(c) : c)); }
  setAttribute(k, v) { this.attrs[k] = v; }
  all(cls) { const out = []; const walk = (n) => { n.children.forEach((c) => { if ((" " + c.className + " ").includes(" " + cls + " ")) out.push(c); walk(c); }); }; walk(this); return out; }
}
var document = { createElement: (t) => new N(t), createDocumentFragment: () => { const n = new N("#frag"); n.frag = true; return n; }, createTextNode: (s) => { const n = new N("#text"); n._t = String(s); return n; } };
var t = (k) => k, LANG = "zh", PAPER = "paper", BINANCE = "binance", CX_VENUES = {};
const BOX = new N("div");
var $ = (id) => (id === "tr-assets" ? BOX : null);
var TR = { st: { report: null }, sig: {} }, trTipSeq = 0;
var trShould = () => true;
const fnSrc = (name) => {
  const a = src.indexOf("function " + name + "(");
  if (a < 0) throw new Error("找不到 " + name);
  let i = src.indexOf("{", a), depth = 0;
  for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}" && --depth === 0) break; }
  return src.slice(a, i + 1);
};
eval(cut("const tr2 = ", "function trMoneyInto(").replace(/^const /gm, "var ")
  + ["trEl", "trSec", "trReport", "trVenueId", "trVenueLabel", "trCcy", "trUnit", "trFmt", "trFmt2", "trHead", "trTipLabel"].map(fnSrc).join("\n") + "\n" + cut("function trPaintAssets(", "function trPaintHist("));
const VEN = (id) => ({ [id]: { credentials: true, pair: true, order: true, account: true } });
const paint = (id, entry, readAt = 1759800000) => {
  BOX.textContent = ""; TR.st.report = { venues: VEN(id), account: { read_at: readAt, venues: { [id]: entry } } };
  try { trPaintAssets(); } catch (e) { return e; }
  return null;
};
const rowsOf = () => BOX.all("pf-wallet-row").map((r) => [r.all("w-name")[0].textContent, r.all("w-amt")[0].textContent]);
const local = (ts) => { const d = new Date(ts * 1000), p = (n) => String(n).padStart(2, "0"); return p(d.getMonth() + 1) + "/" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()); };

let err = paint("president", PRES);
ok("統一:畫得出來;淨值列是整數 + TWD(不是 12,147,198.00)", !err && BOX.all("pf-acct").length === 1 && BOX.all("pf-acct")[0].all("amt")[0].textContent === "tr.equity12,147,198TWD");
let cap = BOX.all("pf-wallets-cap");
ok("保證金 caption(.margin)在淨值列之後、右側更新時間 MM/DD HH:mm(mono .ts)用 margin_updated_at;錢包分佈不畫(只有一個錢包)", cap.length === 1 && cap[0].className === "pf-wallets-cap margin"
  && cap[0].children[0].textContent === "tr.margin" && cap[0].all("ts")[0].textContent === "tr.marginUpdated " + local(1790907300));
ok("四列:可動用 / 原始 / 維持(整數 + TWD)+ 風險指標 5,374.87%(不帶 TWD)", J(rowsOf()) === J([["tr.marginAvail", "11,921,198TWD"], ["tr.marginInitial", "226,000TWD"], ["tr.marginMaint", "173,000TWD"], ["tr.riskRatiotr.riskRatioTip", "5,374.87%"]]));
let risk = BOX.all("risk")[0];
ok("風險指標 label 是 tip 鈕(解釋「權益數 ÷ 原始保證金」);正常態沒有紅字、沒有 tag", risk && risk.all("tr-tipb").length === 1 && risk.all("tip")[0].textContent === "tr.riskRatioTip"
  && risk.all("danger").length === 0 && risk.all("mini_tag").length === 0);

err = paint("president", { ...PRES, equity: 158420, accounts: { futures: 158420 }, available: -67580 });
risk = BOX.all("risk")[0];
ok("權益數低於維持保證金:數值紅字(.w-amt.danger)+ mini tag danger「低於維持保證金」掛在 label 後;可動用負值用 U+2212", !err && risk && risk.all("w-amt")[0].className === "w-amt danger" && risk.all("w-amt")[0].textContent === "70.10%"
  && risk.all("mini_tag")[0].className === "mini_tag danger" && risk.all("mini_tag")[0].textContent === "tr.belowMaint" && rowsOf()[0][1] === "−67,580TWD");

err = paint("president", { ...PRES, initial_margin: 0, maintenance_margin: 0 });
ok("沒部位(原始 / 維持 0):列照畫 0 TWD、風險指標「—」不上色不掛 tag", !err && J(rowsOf().slice(1)) === J([["tr.marginInitial", "0TWD"], ["tr.marginMaint", "0TWD"], ["tr.riskRatiotr.riskRatioTip", "—"]]) && BOX.all("danger").length === 0);

err = paint("president", { ...PRES, available: null, margin_updated_at: null }, 1759800000);
ok("key 存在但 null:那列畫「—」(沒有 TWD 後綴);沒有 margin_updated_at 退回 read_at", !err && rowsOf()[0][1] === "—" && rowsOf().length === 4
  && BOX.all("pf-wallets-cap")[0].all("ts")[0].textContent === "tr.marginUpdated " + local(1759800000));
err = paint("president", { ...PRES, margin_updated_at: undefined }, null);
ok("更新時間兩個來源都沒有:caption 不畫右側", !err && BOX.all("pf-wallets-cap")[0].all("ts").length === 0 && BOX.all("pf-wallets-cap")[0].children.length === 1);

err = paint("capital", { ok: true, equity: 1047300, currency: "TWD", accounts: { futures: 1047300 }, available: 914300 }, 1759800000);
ok("群益(快照只有 available):只畫可動用那一列,沒有風險指標列;更新時間退 read_at", !err && J(rowsOf()) === J([["tr.marginAvail", "914,300TWD"]]) && BOX.all("risk").length === 0 && BOX.all("pf-wallets-cap")[0].all("ts").length === 1);

const BN = { ok: true, equity: 12.5, currency: "USDT", accounts: { spot: 3, funding: 40 }, holdings: [] };
err = paint("binance", BN);
ok("加密所(沒有保證金 key):畫面不變——淨值兩位小數、錢包分佈 caption 沒有 .margin、沒有保證金列、沒有 tip 鈕", !err && BOX.all("pf-acct")[0].all("amt")[0].textContent === "tr.equity43.00USDT"
  && BOX.all("pf-wallets-cap").length === 1 && BOX.all("pf-wallets-cap")[0].className === "pf-wallets-cap" && J(rowsOf()) === J([["tr.acct.fund", "40.00USDT"], ["tr.acct.spot", "3.00USDT"]]) && BOX.all("tr-tipb").length === 0);
err = paint("paper", { ok: true, equity: 9876.5, currency: "USDT" });
ok("模擬帳戶:一行淨值,什麼都不多畫", !err && BOX.all("pf-acct")[0].all("amt")[0].textContent === "tr.equity9,876.50USDT" && BOX.all("pf-wallets-cap").length === 0 && BOX.all("pf-wallet-row").length === 0);
err = paint("president", { ok: false, error: "no snapshot yet", currency: "TWD" });
ok("讀帳失敗:淨值「—」、不畫保證金", !err && BOX.all("pf-acct")[0].all("amt")[0].textContent === "tr.equity—" && BOX.all("pf-wallets-cap").length === 0);

// 指紋:保證金欄位在 r.account 裡,trShould("assets") 的指紋整包帶 r.account,保證金變了會重畫
ok("trShould(\"assets\") 的指紋含整個 r.account(保證金 / 更新時間變了就重畫)", /trShould\("assets", box, \[ids, r\.account, trUnit\(\)\]\)/.test(src));
ok("CSS:caption 左右排、紅字、mini tag danger 三條都在 trade.css", /\.pf-wallets-cap\.margin \{ display: flex;[^\n]*justify-content: space-between/.test(css)
  && /\.pf-wallet-row \.w-amt\.danger \{ color: var\(--color-redText\); \}/.test(css) && /\.pf-wallet-row \.mini_tag\.danger \{ background-color: var\(--color-redLight\); color: var\(--color-redBlack\); \}/.test(css));

console.log(red ? `\n${red} 項沒過` : "\n全部通過");
process.exit(red ? 1 : 0);
