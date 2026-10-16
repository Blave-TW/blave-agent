// 投資組合預覽(機器回報 previews;runtime/portfolio_reporter.typec_previews)。不起 Electron。
//   ① 策略組合 › 配置:回報有預覽 → 畫它並標成預覽;回報沒預覽(過時被 reporter 拿掉)→ 這支沒有權重,總訊號部位那一列是「計算中…」
//   ② 實盤權重在就用實盤的,預覽不蓋過去;自動下單 › 部位從不用預覽
//   ③ 註記的日期只讀 bar_date(機器端照市場換好的交易日),外殼不從 bar_at 換算
// 跑法:node tests/check_shell_typec_preview.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const R = path.join(__dirname, "..", "shell", "renderer");
const src = fs.readFileSync(path.join(R, "trade.js"), "utf8");
const S = (() => { const raw = fs.readFileSync(path.join(R, "strings.js"), "utf8");
  return (0, eval)("(" + raw.slice(raw.indexOf("{", raw.indexOf("const STRINGS")), raw.lastIndexOf("}") + 1) + ")"); })();
let red = 0; const ok = (name, c, info) => { console.log((c ? "PASS  " : "FAIL  ") + name + (c || !info ? "" : "\n      " + info)); if (!c) red++; };
const cutF = (s, n) => { const i = s.indexOf("function " + n + "("); if (i < 0) throw new Error("no " + n); let d = 0; for (let k = s.indexOf("{", i); k < s.length; k++) { if (s[k] === "{") d++; else if (s[k] === "}" && --d === 0) return s.slice(i, k + 1); } throw new Error("no " + n); };

const C = {}; vm.runInNewContext(cutF(src, "poCfgStates") + "\nthis.f = poCfgStates;", C);
const W = { "2330": 0.5, "2454": 0.5 };
const pv = { type: "portfolio", market: "spot", weights: W, rebalance_at: 1, bar_at: 1791936000, bar_date: "2026-10-14" };
const withPv = C.f({ states: {}, previews: { tw4: pv } });
ok("① 有預覽:配置頁拿到它的權重並標 preview", withPv.tw4 && withPv.tw4.preview === true && withPv.tw4.weights === W);
const gone = C.f({ states: {}, previews: {} });
ok("① 預覽過時被機器拿掉(previews 沒這支):這支沒有權重", !gone.tw4);
const poSig = cutF(src, "poSigTable");
ok("① 沒有權重的投資組合:總訊號部位那一列寫 tr.typecPending(「計算中…」)",
  /return x\.portfolio === true && !\(st && st\.weights && typeof st\.weights === "object"\)/.test(poSig)
  && /trHostOld\(\) \? t\("po\.hostOld"\) : t\("tr\.typecPending"\)/.test(poSig)
  && S.zh["tr.typecPending"] === "計算中…" && S.en["tr.typecPending"] === "Computing…");
const live = C.f({ states: { tw4: { type: "portfolio", weights: { "2330": 0 } } }, previews: { tw4: pv } });
ok("② 實盤權重在(就算全 0):用實盤的,預覽不蓋過去", live.tw4.preview !== true && live.tw4.weights["2330"] === 0);
ok("② 只有配置頁用預覽:poPaintCfg 用 poCfgStates,自動下單 › 部位照讀 r.states",
  /states = poCfgStates\(r\)/.test(cutF(src, "poPaintCfg")) && /poSigTable\(r, trStored\(\) \|\| \{\}, r\.states \|\| \{\}, "trade"\)/.test(cutF(src, "trPaintPos")));
ok("③ 註記日期讀 bar_date,不碰 bar_at;字串帶 {date}",
  /x\.bar_date/.test(poSig) && !/bar_at/.test(poSig) && /\{date\}/.test(S.zh["po.previewNote"]) && /\{date\}/.test(S.en["po.previewNote"]));
console.log(red ? `\n${red} FAILED` : "\nall checks passed");
process.exit(red ? 1 : 0);
