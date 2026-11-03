// 回合鎖放寬的稽核修正(v044-busy-lock-2026-11-03 B1–B4 與 P3)。真碼從原文切出來跑,不開 Electron;舊碼缺函式時各條自己紅,不整支炸。
//   B1 touched 認得 Windows 路徑、cd、kind_obj;認不出對象的工具一律當碰過;雲端那袋多算對著雲端的回合
//   B2 scan／wf 不是現在這份碼跑的:主行程標 code_stale,畫面照過時畫
//   B3 別支被動到(mtime 變、程式碼沒變)不算這支裝好
//   B4 送上雲端／拉回一開跑就算對著雲端;雲端更新中不送
//   P3 掛 sid 的句子那條跑完就收;裝到一半點購買要講原因;策略庫回合鎖的死路拿掉
// 跑法:node tests/check_shell_busy_audit.js
const fs = require("fs"), os = require("os"), path = require("path"), vm = require("vm"), crypto = require("crypto");
const SH = path.join(__dirname, "..", "shell"), R = path.join(SH, "renderer"), read = (f) => fs.readFileSync(path.join(R, f), "utf8");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + JSON.stringify(d).slice(0, 400))); if (!c) red++; };
function fnOf(src, name) {
  let a = src.indexOf("function " + name + "("); if (a < 0) return "";
  let i = src.indexOf("{", src.indexOf(")", a)), d = 0;
  for (; i < src.length; i++) { if (src[i] === "{") d++; else if (src[i] === "}" && --d === 0) break; }
  return src.slice(a, i + 1);
}
const lineOf = (src, re) => { const m = re.exec(src); return m ? m[0] + "\n" : ""; };
const res = read("results.js"), ct = read("chattabs.js"), ver = read("versions.js"), lib = read("library.js"), app = read("app.js"), ho = read("handoff.js"), busy = read("busy.js");

// ── B1 ──
const toolSrc = lineOf(res, /^const RES_STRAT_PATH = [^\n]*/m) + lineOf(res, /^const RES_KIND_STRAT = [^\n]*/m) + lineOf(res, /^const RES_KIND_SAFE = [^\n]*/m) + fnOf(res, "resTurnTool");
const runTool = (c) => { const rt = { touched: new Set(), opaque: false }; let paints = 0;
  try { new Function("RES", "verBusy", toolSrc + "\nreturn resTurnTool;")({ turn: rt }, () => paints++)(c); } catch (e) { return { rt, paints, err: String(e) }; }
  return { rt, paints }; };
const has = (c, n) => runTool(c).rt.touched.has(n);
ok("B1 Windows 路徑(Read／Write／Edit 的 summary 是反斜線)", has({ type: "tool", kind: "strategy_write", summary: "strategies\\abc\\strategy.py" }, "abc"));
ok("B1 `cd strategies/abc && …`:路徑結尾沒有斜線", has({ type: "tool", kind: "unknown", summary: "strategies/abc" }, "abc"));
ok("B1 kind 帶資料夾名、摘要沒路徑(python3 -c):照 kind_obj", has({ type: "tool", kind: "backtest", kind_obj: "abc", summary: "restore" }, "abc"));
ok("B1 其他帶名字的 kind:strategy_read／live_tick／scan／validate", ["strategy_read", "live_tick", "scan", "validate"].every((k) => has({ type: "tool", kind: k, kind_obj: "abc" }, "abc")));
{ const r = runTool({ type: "tool", kind: "unknown", summary: "scan_grid write_scan" });
  ok("B1 heredoc 認不出對象:當碰過(opaque),叫 verBusy 當場鎖", r.rt.opaque === true && r.paints === 1, r); }
{ const r = runTool({ type: "tool", kind: "strategy_write", kind_obj: "a".repeat(59) + "…" });
  ok("B1 kind_obj 被截斷:不是完整名字,不收,當碰過", r.rt.opaque === true && r.rt.touched.size === 0, r); }
ok("B1 沒帶 kind 的舊 chunk 也當碰過", runTool({ type: "tool", summary: "x" }).rt.opaque === true);
{ const safe = ["search", "web_read", "docs", "file_read", "file_write", "files", "silent"].map((kind) => runTool({ type: "tool", kind, kind_obj: "x.py", summary: "x.py" }).rt.opaque);
  ok("B1 確定不碰策略的 kind:不算碰過(不然查個網頁全部都鎖)", safe.every((x) => x === false), safe); }
ok("B1 my_strategies/x 不算", !has({ type: "tool", kind: "file_read", summary: "my_strategies/x/y" }, "x"));
{ const CS = { tabs: new Map([["a", { sid: "a", st: { running: true, "RES.turn": { viewStrat: null, touched: new Set(), opaque: true } } }]]), loaded: null, main: new Map() };
  const src = lineOf(ct, /^const tabRun = [^\n]*/m) + lineOf(ct, /^const tabVal = [^\n]*/m) + "var running = false;\n" + (fnOf(ct, "csStratTurn") || "function csStratTurn() { return null; }");
  ok("B1 回合 opaque:任何一支都鎖", new Function("CS", "RES", src + "\nreturn csStratTurn;")(CS, { turn: null })("x") === "a"); }
{ const f = (B, RPC, st, cl) => { const s = fnOf(ver, "verTurnOf"); return s ? new Function("RPC", "csStratTurn", "csCloudTurn", s + "\nreturn verTurnOf;")(RPC, () => st, () => cl)(B) : "none"; };
  const RPC = { name: "c" }, RP = { name: "l" };
  ok("B1 雲端那袋:對著雲端的回合都鎖;本機那袋不算", f(RPC, RPC, null, "t1") === "t1" && f(RP, RPC, null, "t1") === null && f(RP, RPC, "t2", null) === "t2"); }

// ── B2 ──
{ const dir = fs.mkdtempSync(path.join(os.tmpdir(), "busy-audit-")), name = "s1", sd = path.join(dir, name); fs.mkdirSync(sd);
  const code = "A = 1\n中文 = 2\n", h = crypto.createHash("sha256").update(Buffer.from(code)).digest("hex").slice(0, 16);
  fs.writeFileSync(path.join(sd, "strategy.py"), code);
  const main = fs.readFileSync(path.join(SH, "main.js"), "utf8"), load = fnOf(main, "loadStrategy");
  // loadStrategy 回傳時讀的其他欄位不是這裡的事:沒列的名字一律給空函式
  const env = (scan, wf) => new Proxy({ fs, path, crypto, stratNames: () => [name], STRAT_DIR: () => dir, readResultJson: (p) => (/scan\.json/.test(p) ? scan : wf) }, { has: (o, k) => k in o || !(k in globalThis), get: (o, k) => (k in o ? o[k] : k === Symbol.unscopables ? undefined : () => null) });
  const run = (scan, wf) => new Function("env", `with (env) { ${load}\n return loadStrategy; }`)(env(scan, wf))(name);
  const a = run({ code_hash: "deadbeefdeadbeef" }, { code_hash: h }), b = run({ x: 1 }, null);
  ok("B2 主行程:code_hash 跟現在的檔不同 → scan 標 code_stale;相同不標;沒帶(舊機器的檔)不標", a.scan.code_stale === true && a.wf.code_stale !== true && b.scan.code_stale !== true, [a.scan, a.wf, b.scan]);
  fs.rmSync(dir, { recursive: true, force: true }); }
{ const sb = { window: {}, console }; vm.runInNewContext(read("report-robust.js"), sb); vm.runInNewContext(read("report-wf.js"), sb); const Rb = sb.window.BlaveReport._rob, W = sb.window.BlaveReport._wf;
  const SCAN = { row_param: "A", col_param: "B", row_vals: [10, 20, 30], col_vals: [0.5, 0.7, 0.9], grid: [[3, 0.2, 0.1], [0.3, 1.4, 1.5], [null, 1.5, 1.6]], window: 1, fee: 0.0005, start: "2025-01-01", end: "2025-06-01", generated_at: 100 };
  const stats = { start: "2025-01-01", end: "2025-06-01", "fee [%]": 0.05, "Generated At": 50 };
  ok("B2 參數掃描:code_stale → 過時(不是最新結論);沒標照舊", Rb.sanitizeScan({ ...SCAN, code_stale: true }, stats, "").stale === true && Rb.sanitizeScan(SCAN, stats, "").stale === false);
  const WF = { lookback_days: 365, step_days: 30, row_param: "A", col_param: "B", row_vals: [1, 2], col_vals: [1, 2], current: [1, 1], n_runs: 3, runs: [] };
  const w1 = W.sanitizeWf({ ...WF, code_stale: true }, "A = 1\nB = 1\n"), w0 = W.sanitizeWf(WF, "A = 1\nB = 1\n");
  ok("B2 樣本外:code_stale → 過時;常數相同、沒標照舊", !!w1 && w1.stale === true && !!w0 && w0.stale === false, [w1 && w1.stale, w0 && w0.stale]); }

// ── B3 ──
{ const inst = [], tr = [], env = { LIB: { pending: new Map(), installed: {}, noNew: null, cloudWait: null }, RP: { list: [] }, libTrack: (n) => tr.push(n), libInstalledSet: (id, n) => { inst.push(id + "=" + n); }, window: {} };
  const F = new Function("env", `with (env) { ${fnOf(lib, "libTurnSettle")}\n return libTurnSettle; }`)(env);
  const before = new Map([["b", 5], ["known", 7]]);
  env.RP.list = [{ name: "b", mtime: 99, codeMtime: 5 }, { name: "known", mtime: 8, codeMtime: 7 }];
  F({ id: 7, env: "local", before });
  ok("B3 別支更新績效／掃描完(mtime 變、程式碼沒變):不記成這支裝好,講沒新策略", inst.length === 0 && env.LIB.noNew === 7 && tr.join() === "library_no_new", { inst, tr });
  inst.length = 0; tr.length = 0; env.LIB.noNew = null; env.RP.list = [{ name: "b", mtime: 9, codeMtime: 6 }, { name: "new1", mtime: 1, codeMtime: 1 }];
  F({ id: 8, env: "local", before });
  ok("B3 別支程式碼也變了(另一條在改):只認新出現的那個", inst.join() === "8=new1", inst);
  inst.length = 0; env.LIB.installed = { 9: "known" }; env.RP.list = [{ name: "known", mtime: 9, codeMtime: 8 }];
  F({ id: 9, env: "local", before });
  ok("B3 再下載一份:已知那支程式碼變了算成功", inst.join() === "9=known", inst);
  ok("B3 送出時的快照存程式碼 mtime(本機)", /env === "cloud" \? x\.mtime : x\.codeMtime/.test(lib)); }

// ── B4 ──
{ const sm = fnOf(app, "submitMessage");
  ok("B4 送上雲端／拉回(opts.handoff)一開跑就算對著雲端", /turnViewCloud = !!\(viewing && viewing\.env === "cloud"\) \|\| !!\(opts && opts\.handoff\);/.test(sm));
  ok("B8 turnViewCloud 在開跑那次重畫之前定案;開跑紀錄建好再判一次還原鎖", sm.indexOf("turnViewCloud =") > 0 && sm.indexOf("turnViewCloud =") < sm.indexOf("running = true;") && sm.indexOf("verBusy()") > sm.indexOf("resTurnStart(viewing"));
  const s = fnOf(ho, "hoBlocked"), blocked = (once, sid, runningSid) => s ? new Function("csOnceLive", "UPD", "csTabRunning", s + "\nreturn hoBlocked;")(() => once, { cloudSid: sid }, (x) => x === runningSid)("k") : "none";
  ok("B4 雲端更新中:送上雲端不送,帶去更新那條", JSON.stringify(blocked(null, "u", "u")) === '{"key":"ho.updating","sid":"u"}', blocked(null, "u", "u"));
  ok("B4 更新那條跑完就放行;同一支還在送照擋", blocked(null, "u", "x") === null && blocked({ sid: "a" }, null, null).key === "ho.sending");
  ok("B4 hoAsk 按下與確認都看 hoBlocked", (fnOf(ho, "hoAsk").match(/hoBlocked\(onceKey\)/g) || []).length === 2); }

// ── P3 ──
{ const quiet = [], els = [{ dataset: { busy: "1", sid: "done" } }, { dataset: { busy: "1", sid: "live" } }];
  const doc = { querySelectorAll: (q) => (q === "[data-busy][data-sid]" ? els : []) };
  const f = new Function("document", "busyOn", "csTabRunning", "busyLock", "busyQuiet", "BUSY_PENDING", fnOf(busy, "busySync") + "\nreturn busySync;")(doc, () => true, (s) => s === "live", () => {}, (x) => quiet.push(x), null);
  f();
  ok("P3 掛 sid 的句子:那條跑完就收,別條還在跑也收;那條還在跑不收", quiet.length === 1 && quiet[0] === els[0], quiet.length); }
{ const note = { textContent: "", hidden: true }, boxes = [], env = { LIB: { buying: null, pending: new Map([[1, {}]]) }, $: (id) => (id === "lib-cta-note" ? note : {}), t: (k) => k, confirmBox: (o) => boxes.push(o) };
  const s = fnOf(lib, "libBuyBox"); let thrown = null;
  try { new Function("env", `with (env) { ${s}\n return libBuyBox; }`)(env)({ id: 2 }, "confirm", null, {}); } catch (e) { thrown = String(e); }
  ok("P3 裝到一半點購買:不開框(碰錢不放寬),鈕下講一句", boxes.length === 0 && note.textContent === "lib.buyWait" && note.hidden === false, { note, thrown }); }
ok("S1 策略庫回合鎖的死路拿掉:libBusyTell、busyTold、不帶 sid 的〔停止〕", !/libBusyTell|busyTold|busyFixLink\(note, "stop"\)/.test(lib));
console.log(red ? red + " 紅" : "ALL PASS");
process.exit(red ? 1 : 0);
