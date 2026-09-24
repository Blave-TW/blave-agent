// 自動下單頁的「淨值」與資產分頁要跟雲端同一個口徑(web workspace.html 的 pfLiveTotal / buildAccountBlock / appendHoldings,
// 平台 api/openclaw/agent_equity_snapshot.py):淨值 = accounts(各錢包)加總,沒有才退回 equity;資產分頁列錢包分佈與持幣。
// 0.0.4 實機:Binance 只畫出 U 本位合約那一個錢包的保證金餘額,資產分頁只有一行,現貨 / 資金 / 理財的錢都看不到。
// 跑法:node tests/check_shell_assets.js
const fs = require("fs"), os = require("os"), path = require("path");
const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "shell", "renderer", "trade.js"), "utf8");
let red = 0; const ok = (name, c) => { console.log((c ? "PASS  " : "FAIL  ") + name); if (!c) red++; };
const J = JSON.stringify;
const cut = (from, to) => { const a = src.indexOf(from), b = src.indexOf(to, a + from.length); if (a < 0 || b < 0) return null; return src.slice(a, b); };

// ── 純邏輯區塊 ──
const block = cut("/* ── 純邏輯(", "/* ── 純邏輯到此");
if (!block) throw new Error("找不到純邏輯區塊的標記");
eval(block.replace(/^const /gm, "var "));
const has = (n) => { try { return typeof eval(n) === "function"; } catch (_) { return false; } };

// 形狀照帳戶讀取器(runtime/account_reader.read_venue)的輸出;數字是編的
const BN = {
  ok: true, equity: 12.5, currency: "USDT", error: null,
  accounts: { spot: 3, funding: 40, futures: 20, earn: 7.25, options: 0, mystery_wallet: 1 },
  positions: { ETHUSDT: { side: "long", size: 15 } },
  holdings: [
    { asset: "USDT", amount: 39.5, usdt_value: 39.5, wallet: "funding" },
    { asset: "BNB", amount: 0.0123, usdt_value: 7.4, wallet: "futures" },
    { asset: "OLD", amount: 12, usdt_value: null, wallet: "spot" },
  ],
};
const TOTAL = 3 + 40 + 20 + 7.25 + 0 + 1;
const VEN = { binance: { credentials: true, pair: true, order: true, account: true } };
const REPORT = { venues: VEN, account: { read_at: 1, venues: { binance: BN } } };

ok("trLiveTotal 存在(淨值有自己的口徑,不是直接讀 equity)", has("trLiveTotal"));
ok("有錢包分佈:淨值 = 各錢包加總,不是下單錢包的 equity", has("trLiveTotal") && trLiveTotal(BN) === TOTAL);
ok("沒有錢包分佈(模擬帳戶、舊 lib):退回 equity", has("trLiveTotal") && trLiveTotal({ ok: true, equity: 9876.5 }) === 9876.5
  && trLiveTotal({ ok: true, equity: 55, accounts: null }) === 55 && trLiveTotal({ ok: true, equity: 55, accounts: {} }) === 55);
ok("錢包裡有壞值(NaN / 字串)不加總,退回 equity;兩個都沒有 = null", has("trLiveTotal") && trLiveTotal({ equity: 8, accounts: { a: 1, b: NaN } }) === 8
  && trLiveTotal({ equity: 8, accounts: { a: 1, b: "2" } }) === 8 && trLiveTotal({ equity: null, accounts: null }) === null && trLiveTotal(null) === null);
ok("錢包分佈:大到小、同額按名稱;只有一個錢包不列", has("trWalletRows")
  && J(trWalletRows(BN).map((w) => w.key)) === J(["funding", "futures", "earn", "spot", "mystery_wallet", "options"])
  && J(trWalletRows({ accounts: { futures: 5 } })) === "[]" && J(trWalletRows({ accounts: null })) === "[]");
ok("持幣:讀成功的那一家才列;一家時不掛交易所名;壞列跳過", has("trHoldingRows")
  && trHoldingRows(REPORT, ["binance"]).length === 3 && trHoldingRows(REPORT, ["binance"]).every((h) => h.venue === null)
  && trHoldingRows({ account: { venues: { binance: { ...BN, ok: false } } } }, ["binance"]).length === 0
  && trHoldingRows({ account: { venues: { binance: { ...BN, holdings: [null, { amount: 1 }, { asset: "X", amount: 1 }] } } } }, ["binance"]).length === 1);
ok("持幣排序:價值大到小,估不出價值的(null / 空 / 壞值)排最後、彼此照原順序(設計稽核 005 第 9 條)",
  J(trHoldingRows({ account: { venues: { binance: { ...BN, holdings: [{ asset: "A", amount: 1, usdt_value: 2 }, { asset: "N1", amount: 1, usdt_value: null }, { asset: "B", amount: 1, usdt_value: 900 },
    { asset: "N2", amount: 1, usdt_value: "x" }, { asset: "C", amount: 1, usdt_value: "15" }, { asset: "Z", amount: 1, usdt_value: 0 }] } } } }, ["binance"]).map((h) => h.asset)) === J(["B", "C", "A", "Z", "N1", "N2"]));

// ── 畫面:用最小的假 DOM 把原文的 trPaintAssets 跑一次 ──
class N {
  constructor(tag) { this.tag = tag; this.children = []; this._t = ""; this.attrs = {}; this.className = ""; }
  set textContent(v) { this._t = v == null ? "" : String(v); this.children = []; }
  get textContent() { return this._t + this.children.map((c) => c.textContent).join(""); }
  appendChild(c) { if (c.frag) { this.children.push(...c.children); c.children = []; } else this.children.push(c); return c; }
  append(...cs) { cs.forEach((c) => this.appendChild(typeof c === "string" ? document.createTextNode(c) : c)); }
  setAttribute(k, v) { this.attrs[k] = v; }
  all(cls) { const out = []; const walk = (n) => { n.children.forEach((c) => { if ((" " + c.className + " ").includes(" " + cls + " ")) out.push(c); walk(c); }); }; walk(this); return out; }
  tags(tag) { const out = []; const walk = (n) => { n.children.forEach((c) => { if (c.tag === tag) out.push(c); walk(c); }); }; walk(this); return out; }
}
var document = { createElement: (t) => new N(t), createDocumentFragment: () => { const n = new N("#frag"); n.frag = true; return n; }, createTextNode: (s) => { const n = new N("#text"); n._t = String(s); return n; } };
var t = (k) => k, LANG = "en", PAPER = "paper", BINANCE = "binance";
var CX_VENUES = {};   // trVenueLabel's brand table (trade.js); empty = its capitalised fallback
const BOX = new N("div");
var $ = (id) => (id === "tr-assets" ? BOX : null);
var TR = { st: { report: REPORT }, sig: {} };
var trShould = () => true;
// 原文的函式整支切出來(數大括號;這幾支裡沒有含大括號的字串)
const fnSrc = (name) => {
  const a = src.indexOf("function " + name + "(");
  if (a < 0) throw new Error("找不到 " + name);
  let i = src.indexOf("{", a), depth = 0;
  for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}" && --depth === 0) break; }
  return src.slice(a, i + 1);
};
const paint = cut("function trPaintAssets(", "function trPaintHist(");
if (!paint) throw new Error("找不到 trPaintAssets");
eval(["trEl", "trSec", "trReport", "trVenueId", "trVenueLabel", "trCcy", "trUnit", "trEquity", "trFmt2", "trHead"].map(fnSrc).join("\n") + "\n" + paint);

ok("總覽 / 金額表用的 trEquity() = 整個帳戶", Math.abs(trEquity() - TOTAL) < 1e-9);
let paintErr = null;
try { trPaintAssets(); } catch (e) { paintErr = e; }
ok("資產分頁畫得出來(不拋)", !paintErr);
const acct = BOX.all("pf-acct")[0], amtText = acct ? acct.all("amt")[0].textContent : "";
ok("帳戶那一列的淨值是整個帳戶(71.25),不是合約錢包的 12.50", amtText.includes("71.25") && !amtText.includes("12.50"));
const wrows = BOX.all("pf-wallet-row");
ok("有「錢包分佈」小標與每個錢包一列(含 0 的錢包,錢不能看起來不見)", BOX.all("pf-wallets-cap").length === 1 && wrows.length === 6);
ok("錢包列:顯示名走字串表(資金 / 合約…),沒對到的 key 原樣顯示,金額大到小", wrows.length === 6
  && J(wrows.map((r) => r.all("w-name")[0].textContent)) === J(["tr.acct.fund", "tr.acct.swap", "tr.acct.earn", "tr.acct.spot", "mystery_wallet", "tr.acct.options"])
  && wrows[0].all("w-amt")[0].textContent.startsWith("40.00"));
const rows = BOX.tags("tbody").length ? BOX.tags("tbody")[0].tags("tr") : [];
ok("持倉表:區段標籤 + 每個幣一列", BOX.textContent.includes("tr.holdings") && rows.length === 3);
ok("持倉列:幣名 + 錢包標、數量不再接幣名(第一欄就是它,設計稽核 005 第 9 條)、價值帶 USDT;估不出價值的畫「—」但照列", rows.length === 3
  && rows[0].textContent.startsWith("USDT") && rows[0].all("mkt-tag")[0].textContent === "tr.acct.fund"
  && rows[1].tags("td")[1].textContent === "0.0123" && rows[1].tags("td")[2].textContent === "7.40USDT"
  && rows[2].tags("td")[2].textContent === "—");

// 模擬帳戶(沒有 accounts、沒有 holdings):一行淨值,不多畫
BOX.textContent = "";
TR.st.report = { venues: { paper: VEN.binance }, account: { venues: { paper: { ok: true, equity: 9876.5, currency: "USDT" } } } };
try { trPaintAssets(); } catch (e) { paintErr = e; }
ok("模擬帳戶:淨值 = equity,沒有錢包分佈、沒有持倉表", !paintErr && BOX.all("pf-acct")[0].textContent.includes("9,876.50")
  && BOX.all("pf-wallets-cap").length === 0 && BOX.tags("table").length === 0 && Math.abs(trEquity() - 9876.5) < 1e-9);

// ── 權益曲線(shell/daemon.js):曲線與當日損益記的也要是整個帳戶,否則總權益跟曲線對不起來 ──
// 每個點帶 basis("wallets" 各錢包加總 / "equity" 只有下單錢包;0.0.4 的點沒有 basis = "equity")。
// 當日損益只在同一個口徑裡算;錢包分佈讀失敗(accounts_partial)那一輪不記點、不算當日損益
const { createDaemonHost } = require("../shell/daemon.js");
const { EventEmitter } = require("events");
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "blave-assets-")), WS = path.join(BASE, "workspace");
fs.mkdirSync(path.join(WS, "state"), { recursive: true });
const now = Math.floor(Date.now() / 1000);
const HIST = path.join(WS, "state", "equity_history.jsonl"), STATUS = path.join(WS, "state", "local_status.json");
const spawnFn = () => { const c = new EventEmitter(); c.stdin = new EventEmitter(); c.stdin.write = () => true; c.stdin.end = () => {};
  c.stderr = new EventEmitter(); c.kill = () => { setTimeout(() => c.emit("exit", 0, null), 5); return true; }; return c; };
const host = createDaemonHost({ python: "python3", script: "/nonexistent", base: BASE, workspace: WS, env: {}, spawnFn });
host.start();
const setup = (entry, hist) => {
  fs.writeFileSync(STATUS, J({ ...REPORT, daemon: { heartbeat_at: Math.floor(Date.now() / 1000) }, account: { read_at: now, venues: { binance: entry } } }));
  fs.writeFileSync(HIST, hist.map((r) => J(r) + "\n").join(""));
};
const rowsOf = () => fs.readFileSync(HIST, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

setup(BN, [{ ts: now - 5, venue: "binance", equity: 60, basis: "wallets", currency: "USDT" }]);
let eq = host.equity({ days: 1 });
ok("當日損益 = 整個帳戶 − 今天同口徑的基準(71.25 − 60),不是合約錢包的 12.5 − 60", eq.today && Math.abs(eq.today.pnl - (TOTAL - 60)) < 1e-9);

// 升級那一天:0.0.4 今天記的點只有合約錢包(沒有 basis)
setup(BN, [{ ts: now - 5, venue: "binance", equity: 12.5, currency: "USDT" }]);
eq = host.equity({ days: 1 });
ok("升級那天:0.0.4 的合約錢包點不拿來當基準——當日損益是「—」,不是把現貨、資金算成 +470%", eq.today === null);
ok("…曲線的點帶口徑(舊點 = equity),畫面才知道在哪裡斷線", eq.curve.length === 1 && eq.curve[0].basis === "equity");
host._eqTick();
const up = rowsOf();
ok("…同一小時照記一個全帳戶的點(口徑換了不等下一個整點),帶 basis: wallets", up.length === 2 && up[1].basis === "wallets" && Math.abs(up[1].equity - TOTAL) < 1e-9);
eq = host.equity({ days: 1 });
ok("…之後當日損益從新口徑的第一點算起", eq.today && Math.abs(eq.today.pnl) < 1e-9 && Math.abs(eq.today.start_equity - TOTAL) < 1e-9);

// 錢包分佈讀失敗:lib 退回只有合約錢包,帶 accounts_partial
const PART = { ...BN, accounts: { futures: 12.5 }, accounts_partial: true };
setup(PART, [{ ts: now - 3700, venue: "binance", equity: TOTAL, basis: "wallets", currency: "USDT" }]);   // 上一個整點:這一小時還沒記過
host.stop();
const host2 = createDaemonHost({ python: "python3", script: "/nonexistent", base: BASE, workspace: WS, env: {}, spawnFn });   // 記憶體裡沒有「這一小時記過」
host2.start();
eq = host2.equity({ days: 1 });
ok("錢包分佈讀失敗:當日損益是「—」,不是 12.5 − 71.25(−82%)", eq.today === null);
host2._eqTick();
ok("…這一輪不記點", rowsOf().length === 1);
setup({ ok: true, equity: 9876.5, currency: "USDT" }, []);
host2._eqTick();
ok("模擬帳戶(沒有錢包分佈):照記,口徑 equity", rowsOf().length === 1 && rowsOf()[0].basis === "equity");
host2.stop();
fs.rmSync(BASE, { recursive: true, force: true });

// 畫面:口徑換過的地方斷線;累積損益只從最後一段起算
ok("曲線:口徑不同的相鄰兩點不連線(moveTo)", /i && p\.b === pts\[i - 1\]\.b \? ctx\.lineTo/.test(src));
ok("累積損益:只取最後一次換口徑之後的點(平台算好的那條優先;這台電腦沒有,走本機推算)", /const pts = srv \? srv\.pts : isPnl \? all\.slice\(cut\) : all;/.test(src)
  && /\.map\(\(p\) => \(\{ t: p\.ts, v: p\.equity, b: p\.basis \|\| "equity" \}\)\)/.test(src));

// 啟動確認框:機器端證明只碰帳本裡的部位(回報 self_ledger === true)才講「你自己開的倉不會動」;舊 lib 不講(它會平)
ok("啟動確認框:只碰 Blave 的部位那一句只在 self_ledger === true 時出現", /\.concat\(r\.self_ledger === true \? \[t\("tr\.startOwnOnly"\)\] : \[\]\)/.test(src));

console.log(red ? `\n${red} 項沒過` : "\n全部通過");
process.exit(red ? 1 : 0);
