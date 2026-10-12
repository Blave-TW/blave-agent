// 「更新績效」(0.1.21;設計 spec stats-manual-refresh-2026-10-10 §10 精簡版 A;機器端 runtime command_listener stats_refresh;
// 0.1.22 Wei 10-12:所有有 stats 的 Type A／C 都有,不只上線中——非上線的機器端重跑回測,title 只寫上次回測時間;碼改過還沒回測 → ack CODE_CHANGED)。
// 跑法:node tests/check_shell_perf_refresh.js(不開 Electron)
//   ① 指令通道:daemon.js UI_COMMANDS / argsOk 形狀 = runtime _stats_refresh_args(names 1–50、不重複、名字規則同 version_restore);
//      主行程 CLOUD_SHIPPED、renderer ENV_CLOUD_CMDS、runtime local_daemon.ALLOWED、fixture 四處都有
//   ② 埋點 perf_update 在白名單尾端(browser_hb_card 之後)、送出點只在 perfClick 的 ack started 之後
//   ③ 主行程 stratPerf:{ at = stats.json mtime(秒), refresh? } 同 runtime strategy_reporter._read_perf
//   ④ renderer 三態(假 DOM 跑真的 perf.js):Type A／C 都出、Type B 不出(xpIsTypeB)、閒置(滿一天才出 N 天前;上線中 / 非上線兩句 title)/ 更新中 / 失敗、
//      按下的指令形狀、ack 之後才記埋點、ack skip 碼各自的失敗行(CODE_CHANGED / INDEX_BROKEN / NOT_RUNNABLE / CONFIG_UNREADABLE)、
//      報告帶回的 SUPERSEDED / BUSY、上線中 = 下單設定有 key(金額 0 也算,versions.js verPicked)、完成唸一句
//   ⑤ 接線:rpShowTab 畫完回測分頁叫 perfPaint、三處上鎖 / 解鎖叫 perfBusy、index.html 載入順序、CSS、zh / en 字串
const fs = require("fs"), path = require("path"), os = require("os");
const S = path.join(__dirname, "..", "shell"), R = path.join(S, "renderer"), ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(p, "utf8");
const mainSrc = read(path.join(S, "main.js")), perfSrc = read(path.join(R, "perf.js")), appSrc = read(path.join(R, "app.js"));
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + String(d).slice(0, 400))); if (!c) red++; };
function fnSrc(src, name) {
  let a = src.indexOf("function " + name + "("); if (a < 0) throw new Error("找不到 " + name);
  let i = src.indexOf("{", a), depth = 0;
  if (src.slice(a - 6, a) === "async ") a -= 6;
  for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}" && --depth === 0) break; }
  return src.slice(a, i + 1);
}
// 單行的 const(行尾帶註解,所以不用「到下一個 ;」那種切法)
const constSrc = (src, name) => { const m = new RegExp("^const " + name + " = [^\\n]*\\n", "m").exec(src); if (!m) throw new Error("找不到 " + name); return m[0]; };

(async () => {
  // ── ① 指令通道 ──
  const { UI_COMMANDS, argsOk } = require(path.join(S, "daemon.js"));
  const nm = (i) => "s" + i;
  ok("daemon.js:stats_refresh 在 UI_COMMANDS;剛好 names,1–50 支、不重複、名字規則 [A-Za-z0-9_-]{1,128}",
    UI_COMMANDS.has("stats_refresh") && argsOk("stats_refresh", { names: ["momo"] }) && argsOk("stats_refresh", { names: ["a_b-C9", "x".repeat(128)] })
    && argsOk("stats_refresh", { names: Array.from({ length: 50 }, (_, i) => nm(i)) })
    && [{}, { names: [] }, { names: "momo" }, { names: ["momo"], x: 1 }, { names: ["momo", "momo"] }, { names: ["a.b"] }, { names: ["../x"] }, { names: ["x".repeat(129)] }, { names: [5] }, { names: [""] },
      { names: Array.from({ length: 51 }, (_, i) => nm(i)) }, { name: "momo" }, null].every((a) => !argsOk("stats_refresh", a)));
  const shipped = JSON.parse((mainSrc.match(/const CLOUD_SHIPPED = (\[[^\]]*\]);/) || [])[1] || "null");
  const envCmds = JSON.parse((read(path.join(R, "trade.js")).match(/const ENV_CLOUD_CMDS = (\[[^\]]*\]);/) || [])[1] || "null");
  const ld = read(path.join(ROOT, "runtime", "local_daemon.py")), allowedPy = /ALLOWED = frozenset\(\{([\s\S]*?)\}\)/.exec(ld);
  const fixture = JSON.parse(read(path.join(ROOT, "tests", "fixtures", "api_agent_command_allowed.json"))).allowed;
  ok("雲端也送得出:main.js CLOUD_SHIPPED 與 trade.js ENV_CLOUD_CMDS 逐項相等、都在 version_restore 之後接 stats_refresh",
    Array.isArray(shipped) && JSON.stringify(shipped) === JSON.stringify(envCmds) && shipped.slice(-2).join() === "version_restore,stats_refresh");
  ok("runtime local_daemon.ALLOWED 與 fixture(api 的 ALLOWED 副本)都有 stats_refresh;fixture 照字母序", !!allowedPy && /"stats_refresh"/.test(allowedPy[1]) && fixture.includes("stats_refresh")
    && JSON.stringify(fixture) === JSON.stringify(fixture.slice().sort()));

  // ── ② 埋點 ──
  const { EVENTS } = require(path.join(S, "telemetry.js")), F = EVENTS.feature_used.name;
  ok("perf_update 在白名單尾端(browser_hb_card 之後)、≤16 字", F.slice(-2).join() === "browser_hb_card,perf_update" && "perf_update".length <= 16);
  const click = fnSrc(perfSrc, "perfClick");
  ok("送出點只有 perfClick 一處,而且在 ack started 之後(按下、BUSY、結果不明、拒收都不記)", (perfSrc.match(/trackFeature\("perf_update"\)/g) || []).length === 1
    && /res\.started\.indexOf\(name\) >= 0\) \{ trackFeature\("perf_update"\);/.test(click) && click.indexOf('tradeSend("stats_refresh"') < click.indexOf('trackFeature("perf_update")'));

  // ── ③ 主行程 stratPerf ──
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "perf-")), dir = path.join(ws, "momo");
    fs.mkdirSync(dir);
    const M = new Function("fs", "path", constSrc(mainSrc, "RERUN_ERRS") + fnSrc(mainSrc, "stratPerf") + "\nreturn stratPerf;")(fs, path);
    ok("沒有 stats.json → null(不出這一組)", M(dir) === null);
    fs.writeFileSync(path.join(dir, "stats.json"), "{}");
    const at = Math.floor(fs.statSync(path.join(dir, "stats.json")).mtimeMs / 1000);
    ok("只有 stats.json → { at = mtime 秒 },不帶 refresh", JSON.stringify(M(dir)) === JSON.stringify({ at }));
    const rr = (doc) => { fs.writeFileSync(path.join(dir, "perf_refresh.json"), typeof doc === "string" ? doc : JSON.stringify(doc)); return M(dir).refresh; };
    ok("perf_refresh.json running → { status, at },pid 不往上交", JSON.stringify(rr({ status: "running", at: 1760000000, pid: 42 })) === '{"status":"running","at":1760000000}');
    ok("failed 帶認得的 err;不認得的 → EXIT", rr({ status: "failed", at: 5, err: "DATA" }).err === "DATA" && rr({ status: "failed", at: 5, err: "WHAT" }).err === "EXIT" && rr({ status: "failed", at: 5 }).err === "EXIT");
    ok("main.js RERUN_ERRS 也認 SUPERSEDED / BUSY(= runtime _RERUN_ERRS,本機讀檔這一層不能先降成 EXIT)", rr({ status: "failed", at: 5, err: "SUPERSEDED" }).err === "SUPERSEDED" && rr({ status: "failed", at: 5, err: "BUSY" }).err === "BUSY");
    ok("壞形狀(status 不認得、at 不是整數、陣列、檔壞)→ 不帶 refresh", [{ status: "done", at: 5 }, { status: "running", at: "5" }, [1], "{half"].every((d) => rr(d) === undefined));
    ok("loadStrategy 交出 perf: stratPerf(dir)", /versions: stratVersions\(dir\), perf: stratPerf\(dir\),/.test(fnSrc(mainSrc, "loadStrategy")));
    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ── ④ renderer 三態(假 DOM) ──
  const STR = new Function(read(path.join(R, "strings.js")) + "\nreturn STRINGS;")();
  const shlFmtTime = new Function(fnSrc(read(path.join(R, "report-sharelist.js")), "shlFmtTime") + "\nreturn shlFmtTime;")();
  const xpIsTypeB = new Function(fnSrc(read(path.join(R, "export.js")), "xpIsTypeB") + "\nreturn xpIsTypeB;")();   // Type B 的判法只有一份(程式碼分頁同一支)
  const verPickedSrc = fnSrc(read(path.join(R, "versions.js")), "verPicked");   // 上線中的判法只有一份(versions.js;真的那支餵進 rig)
  class El {
    constructor(tag) { this.tagName = tag; this.kids = []; this.attrs = {}; this.on = {}; this.className = ""; this.hidden = false; this.id = ""; this.dataset = {}; this.parentNode = null; this.title = undefined; }
    set textContent(v) { this.kids = v === "" || v == null ? [] : [String(v)]; }
    get textContent() { return this.kids.map((k) => (typeof k === "string" ? k : k.textContent)).join(""); }
    append(...xs) { xs.forEach((x) => this.appendChild(x)); }
    appendChild(x) { if (typeof x !== "string") { x.parentNode = this; } this.kids.push(x); return x; }
    insertBefore(x, ref) { x.parentNode = this; const i = ref ? this.kids.indexOf(ref) : -1; if (i < 0) this.kids.push(x); else this.kids.splice(i, 0, x); return x; }
    get nextSibling() { const p = this.parentNode; if (!p) return null; const i = p.kids.indexOf(this); return p.kids[i + 1] || null; }
    remove() { const p = this.parentNode; if (p) p.kids.splice(p.kids.indexOf(this), 1); this.parentNode = null; }
    setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; } removeAttribute(k) { if (k === "title") this.title = undefined; delete this.attrs[k]; }
    addEventListener(ev, fn) { (this.on[ev] = this.on[ev] || []).push(fn); }
    click() { (this.on.click || []).forEach((f) => f({ detail: 1 })); }
    has(c) { return this.className.split(/\s+/).includes(c); }
    all(pred, out = []) { this.kids.forEach((k) => { if (typeof k !== "string") { if (pred(k)) out.push(k); k.all(pred, out); } }); return out; }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    querySelectorAll(sel) { const cls = sel.split(",").map((x) => x.trim().replace(/^\./, "")); return this.all((k) => cls.some((c) => k.has(c))); }
  }
  const doc = { createElement: (tag) => new El(tag) };
  const names = ["pfEl", "perfOf", "perfShown", "perfLive", "perfState", "perfPaint", "perfBusy", "perfClick", "perfPollNeed", "perfPollStop", "perfPollEnsure", "perfPollTick"];
  const body = ["PF", "PFL", "PFP", "PF_POLL_MS", "PF_POLL_MAX_MS", "PF_ERRS", "PF_WHY", "pfSide"].map((n) => constSrc(perfSrc, n)).join("") + names.map((n) => fnSrc(perfSrc, n)).join("\n")
    + "\nreturn { " + names.join(", ") + ", PF, PFL, PFP };";
  const clock = { now: new Date(new Date().getFullYear(), 8, 28, 10, 0, 0).getTime() };   // 今年 9/28 10:00 本地時間(格式斷言不隨時區翻)
  class FakeDate extends Date { static now() { return clock.now; } }
  const nowS = () => Math.floor(clock.now / 1000);
  function rig(lang, opt) {
    opt = opt || {};
    const E = {}, byId = (id) => { for (const k of Object.keys(E)) { const hit = E[k].all((x) => x.id === id)[0]; if (hit) return hit; } return null; };
    const $ = (id) => E[id] || byId(id) || (E[id] = Object.assign(new El("div"), { id }));
    const tbl = STR[lang], t = (k, vars) => { let s = tbl[k] || k; if (vars) for (const v in vars) s = s.split("{" + v + "}").join(vars[v]); return s; };
    const cloud = opt.cloud === true, side = cloud ? "cloud" : "local";
    const bag = { name: "momo", data: { stats: { symbol: "BTCUSDT" }, code: opt.code || "", perf: opt.perf === undefined ? { at: nowS() - 3600 } : opt.perf }, drawn: {}, tab: "bt" };
    const RP = cloud ? { name: null, data: null, drawn: {} } : bag, RPC = cloud ? bag : { name: null, data: null, drawn: {} };
    // #rp-bt 裡是 renderBacktest 畫好的 .bt:meta 列(四組 .mgrp)+ 三組條列
    const host = $("rp-bt"), root = new El("div"); root.className = "bt"; const meta = new El("div"); meta.className = "bt-meta";
    ["BTCUSDT", "1h", "a → b", "fee"].forEach((x) => { const g = new El("span"); g.className = "mgrp"; g.textContent = x; meta.appendChild(g); });
    const cols = new El("div"); cols.className = "bt-cols"; root.append(meta, cols); host.appendChild(root);
    $("rp").hidden = false;
    const tracked = [], sent = [], said = [], timers = [], acks = [], paints = [];
    const api = { tradeSend: (cmd, args) => { sent.push([cmd, args]); return new Promise((res) => acks.push(res)); }, loadStrategy: async () => opt.reload ? opt.reload() : null };
    const amounts = "amounts" in opt ? opt.amounts : { momo: 100 };
    const st = amounts ? { report: { config: { amounts } } } : null;
    const VS = { local: { name: null, open: null }, cloud: { name: null, open: null } };
    const env = { document: doc, $, t, RP, RPC, RPC_CACHE: new Map(), rpBag: () => bag, rpPaintHead: () => paints.push("head"), rpShowTab: (tab) => paints.push(tab), rpTab: (B) => B.tab,
      running: opt.running === true, trackFeature: (n) => tracked.push(n), srSay: (x) => said.push(x), TR_BAGS: { local: { st: side === "local" ? st : null, api }, cloud: { st: side === "cloud" ? st : null, api } },
      // 上線中的判準只有一份(versions.js verPicked:下單設定有這個 key,金額 0 也算);真的那支,讀 env.TR_BAGS
      verPicked: null,
      xpIsTypeB, verPendingOf: () => opt.pending || null, VS, RERUN_WHY: { DATA: "data", REFUSED: "refused", TIMEOUT: "timeout" }, shlFmtTime,
      window: { blave: { loadStrategy: async () => (opt.reload ? opt.reload() : null) } }, setTimeout: (f, ms) => { timers.push([f, ms]); return timers.length; }, clearTimeout() {}, Date: FakeDate };
    env.verPicked = new Function("TR_BAGS", verPickedSrc + "\nreturn verPicked;")(env.TR_BAGS);
    const F = new Function(...Object.keys(env), body)(...Object.values(env));
    const upd = () => host.querySelector(".upd"), fail = () => host.querySelector(".upd-fail"), btn = () => host.querySelector("btn-quiet");
    return { F, E, $, B: bag, side, meta, root, host, upd, fail, btn, tracked, sent, said, timers, acks, paints, env, VS };
  }
  const flush = () => new Promise((r) => setImmediate(r));
  const tipZh = (at) => shlFmtTime(at, clock.now) + " 更新 · 每天報告前自動更新一次";
  // Type A／C 都出(Wei 10-12):非上線的也有鈕,title 只寫上次回測時間(機器端是重跑回測,沒有每天自動);Type B 不出
  const tipBtZh = (at) => "上次回測 " + shlFmtTime(at, clock.now);
  for (const [tag, amounts] of [["不在金額表", { other: 100 }], ["讀不到回報", null]]) {
    const r = rig("zh", { amounts }); r.F.perfPaint(r.B);
    ok("非上線(" + tag + "):有鈕,title = 「上次回測 MM/DD HH:mm」、不說每天自動;沒有失敗行、不輪詢", r.btn() && r.btn().title === tipBtZh(nowS() - 3600) && !/每天|自動/.test(r.btn().title) && !r.fail() && r.timers.length === 0);
  }
  { const z = rig("zh", { amounts: { momo: 0 } }); z.F.perfPaint(z.B); ok("金額 0 但在下單設定裡 = 上線中(機器端 live 刷新、每天 sweep 都算它;同 runtime _deployed_names):title 是每天自動那句", z.btn().title === tipZh(nowS() - 3600)); }
  { const vp = new Function("TR_BAGS", verPickedSrc + "\nreturn verPicked;"), mk = (amounts) => vp({ local: { st: amounts === null ? null : { report: { config: { amounts } } } } });
    ok("versions.js verPicked:hasOwnProperty 判法——key 在(含 0)true、不在 false、讀不到回報 null、strategyName 也認", mk({ momo: 0 })("local", { name: "momo" }) === true && mk({ other: 1 })("local", { name: "momo" }) === false && mk(null)("local", { name: "momo" }) === null && mk({ real: 0 })("local", { name: "momo", data: { strategyName: "real" } }) === true); }
  { const e = rig("en", { amounts: null }); e.F.perfPaint(e.B); ok("en 非上線:Last backtest …,沒有 auto-updated", e.btn().title === "Last backtest " + shlFmtTime(nowS() - 3600, clock.now) && !/auto/.test(e.btn().title)); }
  { const c = rig("zh", { cloud: true, amounts: { other: 1 } }); c.F.perfPaint(c.B); ok("雲端視角的非上線也出,同一句 title", c.btn() && c.btn().title === tipBtZh(nowS() - 3600)); }
  { const r = rig("zh", { amounts: null, perf: { at: nowS() - 3 * 86400 } }); r.F.perfPaint(r.B); ok("非上線 ≥ 1 天:「3 天前」照出,title 是上次回測那句", r.upd().kids[0].textContent === "3 天前" && r.upd().kids[0].title === tipBtZh(nowS() - 3 * 86400) && r.btn().title === undefined); }
  for (const code of ["# Type: B\nimport x", "#Type:B", "# -*- coding -*-\n# Type: B\n"]) {
    const r = rig("zh", { code }); r.F.perfPaint(r.B);
    ok("不出:Type B(檔頭 `# Type: B`,同 xpIsTypeB)→ meta 列尾沒有 .upd、沒有失敗行、不輪詢", !r.upd() && !r.fail() && r.meta.kids.length === 4 && r.timers.length === 0);
  }
  { const r = rig("zh", { code: "# Type: A\n" }); r.F.perfPaint(r.B); ok("Type A 檔頭照出", !!r.btn()); }
  { const r = rig("zh", { perf: null }); r.F.perfPaint(r.B); ok("不出:報告沒有 perf(舊 runtime / 沒有 stats.json)", !r.upd() && !r.fail()); }
  { const r = rig("zh"); r.VS.local.name = "momo"; r.VS.local.open = 2; r.F.perfPaint(r.B); ok("不出:時光機裡(回測分頁畫的是 vN 存的 blob)", !r.upd()); }
  { const r = rig("zh", { pending: { n: 2, status: "running" } }); r.F.perfPaint(r.B); ok("不出:還原的重跑中 / 沒完成(stats.json 已移開)", !r.upd()); }
  // 閒置 < 1 天:只有鈕,絕對時間與每日自動那句在鈕的 title
  {
    const r = rig("zh"); r.F.perfPaint(r.B);
    const u = r.upd(), b = r.btn();
    ok("閒置 < 1 天:.upd 是 meta 列最後一個子節點(不是 .mgrp,不會多一顆點),裡面只有一顆 .btn-quiet「更新績效」", u && r.meta.kids[r.meta.kids.length - 1] === u && u.kids.length === 1 && b && b.tagName === "button" && b.attrs.type === undefined && b.type === "button" && b.textContent === "更新績效" && b.id === "perf-btn");
    ok("閒置 < 1 天:title = 「MM/DD HH:mm 更新 · 每天報告前自動更新一次」,沒有「N 天前」、沒有 role=status、沒有失敗行", b.title === tipZh(nowS() - 3600) && !u.all((k) => k.has("ts")).length && !("role" in u.attrs) && !r.fail());
    const e = rig("en"); e.F.perfPaint(e.B);
    ok("en:Update Performance / Updated … · auto-updated once a day before the daily report", e.btn().textContent === "Update Performance" && e.btn().title === "Updated " + shlFmtTime(nowS() - 3600, clock.now) + " · auto-updated once a day before the daily report");
    ok("閒置時不輪詢", r.timers.length === 0 && e.timers.length === 0);
  }
  // 閒置 ≥ 1 天:多「N 天前」,title 跟著它、鈕沒有 title
  {
    const r = rig("zh", { perf: { at: nowS() - 3 * 86400 - 5 } }); r.F.perfPaint(r.B);
    const ts = r.upd().kids[0], b = r.btn();
    ok("閒置 ≥ 1 天:「3 天前」在鈕前面(.ts,不可點、沒掛事件),title 在它身上;鈕沒有 title", ts.has("ts") && ts.tagName === "span" && ts.textContent === "3 天前" && ts.title === tipZh(nowS() - 3 * 86400 - 5) && Object.keys(ts.on).length === 0 && b.title === undefined && r.upd().kids[1] === b);
    const one = rig("zh", { perf: { at: nowS() - 86400 } }); one.F.perfPaint(one.B);
    const en3 = rig("en", { perf: { at: nowS() - 3 * 86400 } }); en3.F.perfPaint(en3.B);
    const en1 = rig("en", { perf: { at: nowS() - 86400 } }); en1.F.perfPaint(en1.B);
    ok("剛滿一天 = 「1 天前」;en 3 days ago / 1 day ago", one.upd().kids[0].textContent === "1 天前" && en3.upd().kids[0].textContent === "3 days ago" && en1.upd().kids[0].textContent === "1 day ago");
    const under = rig("zh", { perf: { at: nowS() - 86399 } }); under.F.perfPaint(under.B);
    ok("差一秒滿一天 → 不出字", under.upd().kids.length === 1 && under.btn());
  }
  // 更新中(報告說的):圓環 + 更新中,role=status,鈕整個換掉;數字(三組條列)留著
  {
    const r = rig("zh", { perf: { at: nowS() - 7200, refresh: { status: "running", at: nowS() - 10 } } }); r.F.perfPaint(r.B);
    const u = r.upd(), busy = u.kids[0];
    ok("更新中:.upd[role=status] > .busy > .spin16[aria-hidden] + 「更新中」;沒有鈕、沒有「N 天前」、沒有失敗行", u.attrs.role === "status" && u.kids.length === 1 && busy.has("busy") && busy.kids[0].has("spin16") && busy.kids[0].attrs["aria-hidden"] === "true" && busy.kids[1].textContent === "更新中" && !r.btn() && !r.fail());
    ok("更新中:數字留著(三組條列沒被動)、開始輪詢(本機 2 秒)", r.root.kids[1] === r.host.querySelector("bt-cols") && r.timers.length === 1 && r.timers[0][1] === 2000 && r.F.PFP.local && r.F.PFP.local.name === "momo");
    const e = rig("en", { perf: { at: nowS() - 7200, refresh: { status: "running", at: nowS() - 10 } } }); e.F.perfPaint(e.B);
    ok("en:Updating", e.upd().kids[0].kids[1].textContent === "Updating");
    const c = rig("zh", { cloud: true, perf: { at: nowS() - 7200, refresh: { status: "running", at: nowS() - 10 } } }); c.F.perfPaint(c.B);
    ok("雲端視角同一套,輪詢 5 秒", c.upd().attrs.role === "status" && c.timers[0][1] === 5000 && c.F.PFP.cloud.name === "momo");
  }
  // 失敗(報告說的):回到閒置那一組(時間仍是舊的、鈕就是重試)+ meta 下一行原因,原因進 title
  {
    const r = rig("zh", { perf: { at: nowS() - 2 * 86400, refresh: { status: "failed", at: nowS() - 60, err: "DATA" } } }); r.F.perfPaint(r.B);
    const f = r.fail();
    ok("失敗:閒置那一組照舊(「2 天前」+ 鈕)", r.upd().kids[0].textContent === "2 天前" && r.btn() && r.btn().textContent === "更新績效");
    ok("失敗:<p class=upd-fail role=status title=原因> 緊跟在 .bt-meta 後面(三組條列之前):fault 記號(aria-hidden)+「沒更新成功，數字是舊的」",
      f && f.tagName === "p" && r.root.kids[1] === f && r.root.kids[2].has("bt-cols") && f.attrs.role === "status" && f.title === "沒取到資料" && f.kids[0].has("fault-mark") && f.kids[0].attrs["aria-hidden"] === "true" && f.kids[1].textContent === "沒更新成功，數字是舊的" && f.textContent === "沒更新成功，數字是舊的");
    const why = (err, lang) => { const q = rig(lang || "zh", { perf: { at: nowS() - 100, refresh: { status: "failed", at: nowS() - 60, err } } }); q.F.perfPaint(q.B); return q.fail().title; };
    ok("原因沿用版本重跑的四個字串(ver.rerunWhy.*);不認得的 → 中途出錯", why("REFUSED") === "被回測檢查擋下" && why("TIMEOUT") === "跑太久，已停下" && why("EXIT") === "中途出錯" && why("NOPE") === "中途出錯" && why("DATA", "en") === "no data came back");
    const e = rig("en", { perf: { at: nowS() - 100, refresh: { status: "failed", at: nowS() - 60, err: "EXIT" } } }); e.F.perfPaint(e.B);
    ok("en:Update failed; figures unchanged. / it hit an error;失敗不輪詢", e.fail().kids[1].textContent === "Update failed; figures unchanged." && e.fail().title === "it hit an error" && e.timers.length === 0);
    ok("報告帶回 SUPERSEDED(跑完但 runner 丟棄:檔案在途中被改)/ BUSY(等 runner 的回測鎖等到逾時)各有自己一句", why("SUPERSEDED") === "策略在更新途中被改過，數字沒換；再按一次" && why("BUSY") === "這支策略正在回測中，等它跑完再按一次"
      && why("SUPERSEDED", "en") === "The strategy was edited while updating; figures unchanged. Press again." && why("BUSY", "en") === "This strategy is being backtested right now; press again when it finishes.");
  }
  // 按下:當下換成更新中、送 stats_refresh {names:[name]};ack started 才記埋點;報告跟上(at 前進、refresh 消失)= 完成,唸一句
  {
    const r = rig("zh", { perf: { at: nowS() - 3 * 86400 } }); r.F.perfPaint(r.B);
    r.btn().click(); await flush();
    ok("按下:送 stats_refresh {names:[\"momo\"]}(不經 agent、不送聊天);當下就畫更新中(不等 ack);還沒記埋點", JSON.stringify(r.sent) === '[["stats_refresh",{"names":["momo"]}]]' && r.upd().attrs.role === "status" && !r.btn() && r.tracked.length === 0 && r.timers.length === 1);
    r.acks[0]({ ok: true, result: { started: ["momo"], skipped: {} } }); await flush();
    ok("ack started → 記 perf_update(只一次);還是更新中", r.tracked.join() === "perf_update" && r.upd().attrs.role === "status");
    // 報告跟上:先是 refresh running(疊層交棒給報告),再 refresh 消失 + at 前進(完成)
    r.B.data = { stats: { symbol: "BTCUSDT" }, perf: { at: nowS() - 3 * 86400, refresh: { status: "running", at: nowS() } } }; r.F.perfPaint(r.B);
    ok("報告說 running:疊層拿掉、照報告畫更新中、沒唸完成", r.F.PF.local.size === 0 && r.upd().attrs.role === "status" && r.said.length === 0);
    clock.now += 40 * 1000;
    r.B.data = { stats: { symbol: "BTCUSDT" }, perf: { at: nowS() } }; r.F.perfPaint(r.B);
    ok("完成:refresh 消失且時間前進 → 回閒置(鈕、沒有「N 天前」、title 是新時間)、讀屏唸「績效已更新」、輪詢停", r.btn() && r.upd().kids.length === 1 && r.btn().title === tipZh(nowS()) && r.said.join() === "績效已更新" && r.F.PFP.local === null && !r.fail());
    r.F.perfPaint(r.B);
    ok("再畫一次(狀態沒變)不重唸", r.said.length === 1);
    clock.now -= 40 * 1000;
  }
  {
    const e = rig("en", { perf: { at: nowS() - 100, refresh: { status: "running", at: nowS() - 10 } } }); e.F.perfPaint(e.B);
    clock.now += 30 * 1000; e.B.data = { stats: {}, perf: { at: nowS() } }; e.F.perfPaint(e.B); clock.now -= 30 * 1000;
    ok("en 完成:Performance updated", e.said.join() === "Performance updated");
  }
  // 按下的其他 ack:BUSY = 已經在跑,等報告、不記;結果不明 = 等報告、不記;拒收 = 失敗行(中途出錯)、鈕就是重試、不記
  {
    const r = rig("zh"); r.F.perfPaint(r.B); r.btn().click(); await flush(); r.acks[0]({ ok: true, result: { started: [], skipped: { momo: "BUSY" } } }); await flush();
    ok("BUSY:維持更新中、不記埋點", r.upd().attrs.role === "status" && r.tracked.length === 0);
    const w = rig("zh"); w.F.perfPaint(w.B); w.btn().click(); await flush(); w.acks[0]({ ok: false, error: "TIMEOUT", kind: "unknown" }); await flush();
    ok("ack 逾時 / 結果不明:不算失敗,維持更新中等報告、不記埋點", w.upd().attrs.role === "status" && w.tracked.length === 0 && !w.fail());
    clock.now += 121 * 1000; w.F.perfPaint(w.B); clock.now -= 121 * 1000;
    ok("ack 後 2 分鐘報告都沒跟上:疊層拿掉回閒置(不假稱失敗)、不輪了", w.btn() && !w.fail() && w.F.PF.local.size === 0 && w.F.PFP.local === null);
    const f = rig("zh"); f.F.perfPaint(f.B); f.btn().click(); await flush(); f.acks[0]({ ok: false, error: "NOT_ALLOWED", kind: "undelivered" }); await flush();
    ok("拒收:回閒置 + 失敗行(title 中途出錯),鈕就是重試、不記埋點、不輪詢", f.btn() && f.fail() && f.fail().title === "中途出錯" && f.tracked.length === 0 && f.F.PFP.local === null);
    f.btn().click(); await flush();
    ok("再按一次 = 同一條指令;當下失敗行收掉、回更新中", f.sent.length === 2 && JSON.stringify(f.sent[1]) === JSON.stringify(f.sent[0]) && !f.fail() && f.upd().attrs.role === "status");
    const n = rig("zh"); n.F.perfPaint(n.B); n.btn().click(); await flush(); n.acks[0]({ ok: true, result: { started: [], skipped: { momo: "NO_STATS" } } }); await flush();
    ok("NO_STATS / NOT_RUNNABLE:沒排進去 = 失敗行、不記", n.fail() && n.tracked.length === 0);
    const cc = rig("zh", { amounts: null }); cc.F.perfPaint(cc.B); cc.btn().click(); await flush(); cc.acks[0]({ ok: true, result: { started: [], skipped: { momo: "CODE_CHANGED" } } }); await flush();
    ok("CODE_CHANGED(非上線、碼改過還沒回測):回閒置 + 失敗行(同一句「沒更新成功」),title = 「程式碼改過還沒回測，請先回測」、不記埋點、不輪詢",
      cc.btn() && cc.fail() && cc.fail().title === "程式碼改過還沒回測，請先回測" && cc.fail().textContent === "沒更新成功，數字是舊的" && cc.tracked.length === 0 && cc.F.PFP.local === null);
    const ce = rig("en", { amounts: null }); ce.F.perfPaint(ce.B); ce.btn().click(); await flush(); ce.acks[0]({ ok: true, result: { started: [], skipped: { momo: "CODE_CHANGED" } } }); await flush();
    ok("en CODE_CHANGED:The code changed since the last backtest; run a backtest first.", ce.fail().title === "The code changed since the last backtest; run a backtest first.");
    const ackWhy = async (code, lang) => { const q = rig(lang || "zh"); q.F.perfPaint(q.B); q.btn().click(); await flush(); q.acks[0]({ ok: true, result: { started: [], skipped: { momo: code } } }); await flush(); return q.fail() ? q.fail().title : null; };
    ok("ack 的其他 skip 碼各自一句:NOT_RUNNABLE「這類策略不能更新績效」、INDEX_BROKEN「版本索引讀不到，請先回測一次」、CONFIG_UNREADABLE「下單設定讀不到，沒有更新」;NO_STATS 仍是中途出錯",
      await ackWhy("NOT_RUNNABLE") === "這類策略不能更新績效" && await ackWhy("INDEX_BROKEN") === "版本索引讀不到，請先回測一次" && await ackWhy("CONFIG_UNREADABLE") === "下單設定讀不到，沒有更新" && await ackWhy("NO_STATS") === "中途出錯"
      && await ackWhy("NOT_RUNNABLE", "en") === "This kind of strategy can't update its performance." && await ackWhy("INDEX_BROKEN", "en") === "The version index can't be read; run a backtest first." && await ackWhy("CONFIG_UNREADABLE", "en") === "The trading settings can't be read; nothing was updated.");
  }
  // 回合進行中:鈕 aria-disabled + title 原因,按了不送;解鎖後 title 回到時間那句
  {
    const r = rig("zh", { running: true }); r.F.perfPaint(r.B);
    ok("回合進行中:aria-disabled、title = turn.busy", r.btn().attrs["aria-disabled"] === "true" && r.btn().title === "上一輪還在跑。");
    r.btn().click(); await flush();
    ok("按了不送、不畫更新中", r.sent.length === 0 && r.btn());
    r.env.running = false;   // perfBusy 讀的是呼叫當下的 running
    const F2 = new Function(...Object.keys(r.env), body)(...Object.values(r.env)); F2.perfBusy();
    ok("解鎖:aria-disabled 拿掉、title 回到「MM/DD HH:mm 更新 · 每天報告前自動更新一次」", !("aria-disabled" in r.btn().attrs) && r.btn().title === tipZh(nowS() - 3600));
  }
  // 輪詢:內容變了才重畫(整袋換掉、drawn 清空 → rpPaintHead + rpShowTab),沒變就只重算疊層;換了策略就停
  {
    let next = null;
    const r = rig("zh", { perf: { at: nowS() - 100, refresh: { status: "running", at: nowS() - 10 } }, reload: () => next }); r.F.perfPaint(r.B);
    const P = r.F.PFP.local;
    await r.timers[0][0]();
    ok("輪詢:讀到一樣的 → 不重畫、再排一次", r.paints.length === 0 && r.timers.length === 2 && r.F.PFP.local === P);
    next = { stats: { symbol: "BTCUSDT" }, perf: { at: nowS() + 5 } };
    await r.timers[1][0]();
    ok("輪詢:讀到新的 → 整袋換掉、drawn 清空、重畫頁首與分頁(回測分頁重畫時 rpShowTab 會叫 perfPaint);更新結束就停", r.B.data === next && Object.keys(r.B.drawn).length === 0 && r.paints.join() === "head,bt" && r.F.PFP.local === null);
    const s = rig("zh", { perf: { at: nowS() - 100, refresh: { status: "running", at: nowS() - 10 } } }); s.F.perfPaint(s.B);
    s.B.name = "other"; await s.timers[0][0]();
    ok("輪詢:換了策略就停", s.F.PFP.local === null);
    const cap = rig("zh", { perf: { at: nowS() - 100, refresh: { status: "running", at: nowS() - 10 } } }); cap.F.perfPaint(cap.B);
    clock.now += (900 + 900 + 120) * 1000 + 1; await cap.timers[0][0](); clock.now -= (900 + 900 + 120) * 1000 + 1;
    ok("輪詢封頂(機器端兩個 15 分 + 餘裕;非上線的回測是 15 分):停、留佔位(重畫不再開回來)、以報告為準(還是更新中)", cap.F.PFP.local && cap.F.PFP.local.capped === true && cap.timers.length === 1 && cap.upd().attrs.role === "status");
    cap.btn && cap.F.perfPaint(cap.B);
    ok("封頂後重畫不開輪詢;再按一次才會(佔位清掉)", cap.timers.length === 1 && (() => { cap.B.data.perf = { at: nowS() - 100 }; cap.F.perfPaint(cap.B); cap.btn().click(); return cap.timers.length === 2 && cap.F.PFP.local.capped === undefined; })());
  }

  // ── ⑤ 接線 ──
  const html = read(path.join(R, "index.html")), css = read(path.join(R, "report-backtest.css"));
  ok("app.js:rpShowTab 畫完回測分頁就叫 perfPaint(B)", /R\.renderBacktest\(\$\("rp-bt"\), B\.data\.stats\);\n\s*if \(tab === "bt" && typeof perfPaint === "function"\) perfPaint\(B\);/.test(fnSrc(appSrc, "rpShowTab")));
  ok("app.js:三處上鎖 / 解鎖都在 verBusy 旁邊叫 perfBusy", (appSrc.match(/if \(typeof verBusy === "function"\) verBusy\(\); if \(typeof perfBusy === "function"\) perfBusy\(\);/g) || []).length === 3);
  ok("index.html:perf.js 在 versions.js 之後(用它的 verAmount / verPendingOf / VS / RERUN_WHY)、app.js 之後、export.js 之後(xpIsTypeB)", html.indexOf('src="perf.js"') > html.indexOf('src="versions.js"') && html.indexOf('src="versions.js"') > html.indexOf('src="app.js"') && html.indexOf('src="perf.js"') > html.indexOf('src="export.js"'));
  ok("CSS:.upd 靠右(margin-left: auto)、更新中 .busy、aria-disabled 的鈕走灰階退場、失敗行緊跟 meta(8)而三組條列仍離 16",
    /\.bt-meta > \.upd \{ display: inline-flex; align-items: center; gap: var\(--space-8\); margin-left: auto; white-space: nowrap; \}/.test(css) && /\.bt-meta > \.upd \.busy \{/.test(css)
    && /\.bt-meta > \.upd \.btn-quiet\[aria-disabled="true"\] \{ color: var\(--color-greyDark\); text-decoration: none; cursor: not-allowed; \}/.test(css)
    && /\.bt-meta > \.upd \.btn-quiet::before \{ inset: -15px -6px; \}/.test(css)
    && /\.bt > \.bt-meta \+ \.upd-fail \{ margin-top: var\(--space-8\); \}/.test(css) && /\.bt > \.upd-fail \+ \* \{ margin-top: var\(--space-16\); \}/.test(css) && !/#[0-9a-fA-F]{3,6}\b/.test(css.split("1b. 更新績效")[1].split("---- 2.")[0]));
  const keys = ["perf.btn", "perf.ago", "perf.agoOne", "perf.tip", "perf.busy", "perf.doneSr", "perf.fail"];
  ok("字串:七個 key zh / en 都有,逐字 = spec §10", keys.every((k) => STR.zh[k] && STR.en[k]) && STR.zh["perf.btn"] === "更新績效" && STR.zh["perf.busy"] === "更新中" && STR.zh["perf.fail"] === "沒更新成功，數字是舊的" && STR.zh["perf.doneSr"] === "績效已更新"
    && STR.en["perf.btn"] === "Update Performance" && STR.en["perf.busy"] === "Updating" && STR.en["perf.fail"] === "Update failed; figures unchanged." && STR.en["perf.doneSr"] === "Performance updated");
  ok("文案避開「回測」「重跑」「版本」三個詞(spec 開頭那條;非上線那兩句例外——Wei 10-12 非上線＝重跑回測,句子就該說回測)", keys.every((k) => !/回測|重跑|版本/.test(STR.zh[k]) && !/backtest|rerun|version/i.test(STR.en[k])));
  ok("非上線兩句(0.1.22):perf.tipBt 「上次回測 {t}」/ Last backtest {t};perf.codeChanged 「程式碼改過還沒回測，請先回測」", STR.zh["perf.tipBt"] === "上次回測 {t}" && STR.en["perf.tipBt"] === "Last backtest {t}"
    && STR.zh["perf.codeChanged"] === "程式碼改過還沒回測，請先回測" && STR.en["perf.codeChanged"] === "The code changed since the last backtest; run a backtest first.");
  ok("稽核後五句(perf.superseded / lockBusy / indexBroken / notRunnable / configUnreadable)zh / en 都有、PF_ERRS = 六碼", ["perf.superseded", "perf.lockBusy", "perf.indexBroken", "perf.notRunnable", "perf.configUnreadable"].every((k) => STR.zh[k] && STR.en[k])
    && /const PF_ERRS = \["REFUSED", "DATA", "TIMEOUT", "EXIT", "SUPERSEDED", "BUSY"\]/.test(perfSrc));
  ok("註解不再說 live tick 每根 K 重寫 stats.json(main.js / results.js)", !/live tick 每根 K 重寫 stats\.json|每根 K 的 live tick 都重寫/.test(mainSrc + read(path.join(R, "results.js"))));

  console.log(red ? `\n${red} FAILED` : "\nALL PASS");
  process.exit(red ? 1 : 0);
})();
