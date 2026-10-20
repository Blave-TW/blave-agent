// 報告的「進出場紀錄」分頁:回測沒有逐筆紀錄(組合策略 Type C、0 筆)就不出,同網頁 has_trades(0.1.28 流程稽核 P2-1)。
//   台股 Type C 改用 0050 基準後 stats 沒有 benchmark_n,舊判斷退回「這支策略沒有進出場紀錄」,跟回測數據的 5248 筆打架。
//   rpShowTab 從 app.js 原文切出來跑:有逐筆 → 分頁在、點得到;沒有 → 分頁收起,要求開它的退回回測數據;沒有回測 → 照舊停用、不收。
// 跑法:node tests/check_shell_trades_tab.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const app = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "app.js"), "utf8");
let red = 0; const ok = (n, c, got) => { console.log((c ? "PASS  " : "FAIL  ") + n); if (!c) { red++; if (got !== undefined) console.log("      got: " + JSON.stringify(got)); } };

function fnSrc(src, name) {
  const at = src.indexOf("function " + name + "(");
  if (at < 0) return null;
  let i = src.indexOf("{", at), depth = 0;
  for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1); }
  return null;
}
const body = fnSrc(app, "rpShowTab");
if (!body) { console.log("FAIL  app.js 找不到 rpShowTab"); process.exit(1); }

function run(stats, tab) {
  const el = () => ({ hidden: false, disabled: false, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } });
  const tabs = ["bt", "tr", "rob", "wf", "code"].map((k) => Object.assign(el(), { dataset: { tab: k } }));
  const els = { "rp-wait": el(), "rp-tabs": Object.assign(el(), { querySelectorAll: () => tabs }) };
  ["bt", "tr", "rob", "wf", "code"].forEach((k) => { els["rp-" + k] = el(); });
  const drawn = [], B = { data: stats === undefined ? null : { stats }, drawn: {}, tab: null };
  const ctx = { $: (id) => els[id], rpBag: () => B, rpNobtPaint: () => {}, rpChartSource: () => null, rpRobOpts: () => ({}), rpWfData: () => ({}), rpWfOpts: () => ({}),
    window: { BlaveReport: { renderBacktest: () => drawn.push("bt"), renderTrades: () => drawn.push("tr") } } };
  vm.createContext(ctx); vm.runInContext(body + "\nrpShowTab(" + JSON.stringify(tab) + ");", ctx);
  const tr = tabs[1], sel = tabs.find((b) => b.attrs["aria-selected"] === "true");
  return { trHidden: tr.hidden, trDisabled: tr.disabled, selected: sel && sel.dataset.tab, tab: B.tab, panelTr: !els["rp-tr"].hidden, panelBt: !els["rp-bt"].hidden, drawn };
}

let r = run({ trades: [{ t: 1 }], benchmark_bh: null }, "tr");
ok("有逐筆紀錄:進出場分頁在、選得到、畫進出場", !r.trHidden && r.selected === "tr" && r.panelTr && r.drawn.join() === "tr", r);
r = run({ trades: [], benchmark_bh: { symbol: "0050" } }, "tr");
ok("台股 Type C(0050 基準、沒有 benchmark_n、trades 空):分頁收起,要開進出場的退回回測數據", r.trHidden && r.selected === "bt" && r.tab === "bt" && r.panelBt && !r.panelTr && r.drawn.join() === "bt", r);
r = run({ benchmark_n: 1000 }, "bt");
ok("隨機投組基準的 Type C(沒有 trades 欄):分頁收起,停在回測數據", r.trHidden && r.selected === "bt", r);
r = run({ trades: [] }, "code");
ok("0 筆的 Type A:同網頁,分頁也收起;程式碼照開", r.trHidden && r.selected === "code", r);
r = run(null, "code");
ok("沒有回測:進出場分頁照舊停用、不收(跟其他三個一起)", !r.trHidden && r.trDisabled && r.selected === "code", r);

console.log(red ? `${red} FAILED` : "ALL PASS");
process.exit(red ? 1 : 0);
