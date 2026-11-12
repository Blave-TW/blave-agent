// 模擬帳戶台股現金不夠(spec paper-tw-cash-short §1;工單 paper-twstock-cash-short §5):paper + 台股 + insufficient_margin → 專屬那一句,不是「到交易所調高槓桿」。
// 輸入是 tests/check_paper_tw_cash_short.py 從真的對帳一輪拿到的 order_errors.json 列(原樣貼進來),讀的那一端判斷:token、row.exchange、代號三條。
// 模擬帳戶加密現貨買單同一句(句子不提台股)。對照:真交易所同 token 仍是 tr.err.margin;台指期 paper_margin 仍是 tr.err.paperMargin;模擬合約不算。
// 本機 P1 通知不叫模擬拒單(P2,同 api level_for;main.js p1FromState 在 exchange=paper 就略過),專屬內文的變體已拿掉(稽核 0153 P3-1)。
// 跑法:node tests/check_shell_paper_tw_cash_text.js [blave-agent 根目錄](不起 Electron)
const fs = require("fs"), path = require("path"), vm = require("vm");
const ROOT = process.argv[2] || path.join(__dirname, "..");
let red = 0; const ok = (n, c) => { console.log((c ? "PASS  " : "FAIL  ") + n); if (!c) red++; };
const src = fs.readFileSync(path.join(ROOT, "shell", "renderer", "trade.js"), "utf8");
const mainSrc = fs.readFileSync(path.join(ROOT, "shell", "main.js"), "utf8");
const strings = fs.readFileSync(path.join(ROOT, "shell", "renderer", "strings.js"), "utf8");
const cutIn = (s, name) => { const i = s.indexOf("function " + name + "("); if (i < 0) throw new Error("no " + name); let d = 0; for (let k = s.indexOf("{", i); k < s.length; k++) { if (s[k] === "{") d++; else if (s[k] === "}" && --d === 0) return s.slice(i, k + 1); } };
const cutFn = (name) => cutIn(src, name);
const cutConst = (name) => { const i = src.indexOf("const " + name + " ="); if (i < 0) throw new Error("no " + name); let d = 0; for (let k = src.indexOf("{", i); k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}" && --d === 0) return src.slice(i, src.indexOf(";", k) + 1); } };

const ctx = { t: (k) => k, trFmt: String, trCcy: () => "USDT", BITGET_VERIFIED_MODES: [], PAPER: "paper", String, Object, RegExp };
vm.createContext(ctx);
vm.runInContext([cutConst("TR_REJECT_TEXT")].concat(["trErrToken", "trPaperTwCashRow", "trPaperSellRow", "trOrderErrParse", "trOrderErrText"].map(cutFn)).join("\n").replace(/^const /gm, "var "), ctx);

const NEW_KEY = "tr.err.paperCash";
// 對帳一輪的真實列(情境 A:帳本 10,000 USDT、策略 1,000,000 台幣、30 檔等權)
const PAPER_TW = { strategies: ["tw_eq30"], ts: "2026-11-10T08:25:55.605683", symbol: "9107@spot", exchange: "paper",
  error: "[order_reject:insufficient_margin] insufficient paper cash for 9107 buy (677.46 < 1044.26)" };
const text = (row) => ctx.trOrderErrText(row.symbol, row.error, row);
const CASES = [
  ["模擬帳戶台股現金不夠 → 專屬那一句", PAPER_TW, true],
  ["模擬帳戶台股、上櫃代號(.TWO)也一樣", { ...PAPER_TW, symbol: "6488.TWO@spot", error: PAPER_TW.error.replace(/9107/g, "6488.TWO") }, true],
  ["chase 限價買單那句(原文沒有數字)也一樣", { ...PAPER_TW, error: "[order_reject:insufficient_margin] insufficient paper cash to rest a 9107 buy" }, true],
  ["雲端轉手清掉英文原文、只剩 token:看 token + exchange + 代號,一樣拿專屬那句", { ...PAPER_TW, error: "[order_reject:insufficient_margin]" }, true],
  ["對照:真交易所同 token 仍是 tr.err.margin", { ...PAPER_TW, symbol: "BTCUSDT", exchange: "binance", error: "[order_reject:insufficient_margin] Margin is insufficient." }, false, "tr.err.margin"],
  ["對照:真券商路由的台股代號同 token 仍是 tr.err.margin(不單看代號)", { ...PAPER_TW, exchange: "capital", error: "[order_reject:insufficient_margin] 保證金不足" }, false, "tr.err.margin"],
  ["對照:台指期 paper_margin 仍是 tr.err.paperMargin", { symbol: "TXF", exchange: "paper", error: "[order_reject:paper_margin] contract margin 120000 exceeds paper equity 100000 — refused" }, false, "tr.err.paperMargin"],
  ["模擬帳戶加密現貨買單現金不夠 → 同一句(句子不提台股)", { symbol: "BTCUSDT@spot", exchange: "paper", error: "[order_reject:insufficient_margin] insufficient paper cash for BTCUSDT buy (12.00 < 500.50)" }, true],
  ["模擬帳戶加密現貨限價買單、原文被清掉只剩 token → 同一句", { symbol: "ETHUSDT@spot", exchange: "paper", error: "[order_reject:insufficient_margin]" }, true],
  ["對照:真交易所加密現貨同 token 仍是 tr.err.margin", { symbol: "BTCUSDT@spot", exchange: "binance", error: "[order_reject:insufficient_margin] Account has insufficient balance." }, false, "tr.err.margin"],
  ["對照:模擬帳戶的合約(沒有 @spot)同 token 不拿現貨那句", { symbol: "BTCUSDT", exchange: "paper", error: "[order_reject:insufficient_margin] x" }, false, "tr.err.margin"],
  ["對照:模擬帳戶台指期即使帶 insufficient_margin 也不拿現貨那句", { symbol: "TXF", exchange: "paper", error: "[order_reject:insufficient_margin] x" }, false, "tr.err.margin"],
  ["對照:沒有 token、只有英文原文不夠(不單靠原文)", { ...PAPER_TW, error: "insufficient paper cash for 9107 buy (677.46 < 1044.26)" }, false],
];
for (const [name, row, hit, want] of CASES) {
  ok(name, hit ? text(row) === NEW_KEY : text(row) !== NEW_KEY && (!want || text(row) === want));
}
ok("沒有 exchange 欄位的舊列(照現狀):token + 台股代號 + 原文才算,加密現貨照舊句", text({ symbol: "9107@spot", error: PAPER_TW.error }) === NEW_KEY
  && text({ symbol: "9107@spot", error: "[order_reject:insufficient_margin] x" }) === "tr.err.margin"
  && text({ symbol: "BTCUSDT@spot", error: "[order_reject:insufficient_margin] insufficient paper cash for BTCUSDT buy (1 < 2)" }) === "tr.err.margin");   // 沒 exchange 的舊列:加密現貨分不出模擬或真帳戶,照舊句
// 模擬帳戶賣的比持有的多:0.1.53 起 lib 不帶 token,原文是唯一訊號,所以一定要路由 paper
{ const SELL = [["市價賣單(新 lib,沒有 token)", { symbol: "2330@spot", exchange: "paper", error: "insufficient 2330 to sell (100.0 < 200.0)" }, true],
    ["限價賣單(新 lib,沒有 token)", { symbol: "BTCUSDT@spot", exchange: "paper", error: "insufficient BTC to rest a sell" }, true],
    ["舊 lib 帶 insufficient_margin token", { symbol: "2330@spot", exchange: "paper", error: "[order_reject:insufficient_margin] insufficient 2330 to sell (100.0 < 200.0)" }, true],
    ["對照:不是 paper 路由的同一句原文不認", { symbol: "2330@spot", exchange: "binance", error: "insufficient 2330 to sell (100.0 < 200.0)" }, false],
    ["對照:沒帶列不認", null, false]];
  for (const [name, row, hit] of SELL) {
    const err = row ? row.error : "insufficient 2330 to sell (1 < 2)";
    ok("paperSell " + name, (ctx.trOrderErrText("2330", err, row) === "tr.err.paperSell") === hit);
  } }
ok("對照:沒帶列的舊呼叫(兩個參數)行為不變", ctx.trOrderErrText(PAPER_TW.symbol, PAPER_TW.error) === "tr.err.margin");

// 接線:畫面上兩條路(部位列底下、總覽事件列)都把整列交給判斷;本機通知換專屬內文
ok("接線:部位列與事件列都把那一列傳進 trOrderErrParse／trOrderErrText",
  /trOrderErrParse\(err, le\) \? trOrderErrText\("", err, le\)/.test(src) && /if \(trOrderErrParse\(raw, e\)\) body\.append\(" ", trEl\("span", "dim", "— " \+ trOrderErrText\([^)]*, raw, e\)\)\);/.test(src));
// 本機 P1:模擬拒單在 p1FromState 就略過(P2),通知那一段不會拿到 paper 的列——專屬內文的變體不留
ok("接線:本機 P1 略過模擬拒單(exchange=paper 的 order_error),且不留 paper 專屬通知變體",
  /if \(type === "order_error" && e\.exchange === "paper"\) continue;/.test(mainSrc)
  && !/p1PaperTwCash|p1PaperSell|paper_cash|paper_sell|_paper_cash|_paper_sell|ev_order_error_paper_/.test(mainSrc)
  && !/ev_order_error_paper_/.test(src));

// 新句子兩語都在,且不提交易所/合約/槓桿
const vals = [...strings.matchAll(new RegExp('"' + NEW_KEY.replace(/\./g, "\\.") + '":\\s*"([^"]*)"', "g"))].map((m) => m[1]);
ok("strings.js 有 " + NEW_KEY + "(en + zh 至少兩份)", vals.length >= 2);
ok("新句子沒有 交易所/合約/槓桿/exchange/leverage/contract", vals.length > 0 && vals.every((v) => !/交易所|合約|槓桿|exchange|leverage|contract/i.test(v)));

console.log(red ? `${red} FAILED` : "ALL OK");
process.exit(red ? 1 : 0);
