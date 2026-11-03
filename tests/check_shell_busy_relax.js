// 回合鎖放寬(0.1.44,盤點 busy-lock-inventory-2026-11-02)。真碼從 renderer 原文切出來跑,不開 Electron。
//   ① csTurnLive:「已送出」認送出那一輪——別條開跑不解鎖,同一條接著聊的下一輪也不算
//   ② csCloudTurn／upPlan:更新雲端主機只擋對著雲端的回合;本機回合不擋它,但第一行重新啟動照鎖
//   ③ csShowRunning:只剩關掉但還在跑的、或沒開成分頁的那條,〔查看〕也帶得到
//   ④ 〔停止〕只停擋路那一條;「先停再做」(登出／換 AI)才停全部
//   ⑤ 送上雲端、轉出:同一支同一件事還在跑就不開第二條
//   ⑥ 策略庫:本機兩支可以同時裝、分不清誰的資料夾就不記;雲端一次一支;裝到一半不開購買
//   ⑦ 留著的鎖:更新重啟、刪策略、刪回覆中那條、同條對話 Enter、重送
// 跑法:node tests/check_shell_busy_relax.js
const fs = require("fs"), path = require("path");
const R = path.join(__dirname, "..", "shell", "renderer"), read = (f) => fs.readFileSync(path.join(R, f), "utf8");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + JSON.stringify(d).slice(0, 500))); if (!c) red++; };
function fnOf(src, name) {
  let a = src.indexOf("function " + name + "("); if (a < 0) throw new Error("找不到 " + name);
  if (src.slice(a - 6, a) === "async ") a -= 6;
  let i = src.indexOf("{", src.indexOf(")", a)), d = 0;
  for (; i < src.length; i++) { if (src[i] === "{") d++; else if (src[i] === "}" && --d === 0) break; }
  return src.slice(a, i + 1);
}
const lineOf = (src, re) => { const m = re.exec(src); if (!m) throw new Error("找不到 " + re); return m[0] + "\n"; };
const ct = read("chattabs.js"), app = read("app.js"), lib = read("library.js"), busy = read("busy.js"), ho = read("handoff.js"), xp = read("export.js");

// 分頁核心的替身:loaded 那條讀全域,其他讀 T.st(同 chattabs.js)
function tabsEnv() {
  return new Function("env", `with (env) {
    ${lineOf(ct, /^const tabRun = [^\n]*/m)}${lineOf(ct, /^const tabVal = [^\n]*/m)}
    ${fnOf(ct, "csTurnLive")}\n${fnOf(ct, "csCloudTurn")}\n${fnOf(ct, "csShowRunning")}
    ${lineOf(ct, /^const CS_ONCE = [^\n]*/m)}${fnOf(ct, "csOnceLive")}\n${fnOf(ct, "csOnceMark")}
    return { csTurnLive, csCloudTurn, csShowRunning, csOnceLive, csOnceMark }; }`);
}
const mkTab = (sid, st, o) => ({ sid, st: { running: false, turnSeqMine: 0, turnViewCloud: false, "UPD.turnCloud": false, ...st }, closed: false, ...(o || {}) });
function rig(tabs, main) {
  const env = { CS: { tabs: new Map(tabs.map((T) => [T.sid, T])), loaded: null, main: new Map(main || []), away: null }, running: false, turnSeqMine: 0, turnViewCloud: false, UPD: { turnCloud: false, cloudSid: null }, shown: [], opened: [] };
  env.tabShow = (T) => env.shown.push(T.sid); env.csOpen = (sid) => env.opened.push(sid);
  return { env, F: tabsEnv()(env) };
}

// ── ① ──
{ const A = mkTab("a", { running: true, turnSeqMine: 7 }), B = mkTab("b", { running: true, turnSeqMine: 9 }), { env, F } = rig([A, B]);
  ok("① 送出那一輪還在跑:別條開跑(流水號往前走)也還是 live", F.csTurnLive("a", 7) === true);
  A.st.turnSeqMine = 12; ok("① 同一條接著聊的下一輪不是它", F.csTurnLive("a", 7) === false);
  A.st.turnSeqMine = 7; A.st.running = false; ok("① 那條閒下來就不是", F.csTurnLive("a", 7) === false);
  ok("① 分頁已收掉就不是", F.csTurnLive("gone", 7) === false);
  env.CS.loaded = B; env.running = true; env.turnSeqMine = 9; B.st.turnSeqMine = 0; B.st.running = false;
  ok("① 載入中那條讀全域(T.st 要換出去才更新)", F.csTurnLive("b", 9) === true); }

// ── ② ──
{ const local = mkTab("l", { running: true }), { F } = rig([local]);
  ok("② 只有本機回合:不算對著雲端", F.csCloudTurn() === null);
  const view = mkTab("v", { running: true, turnViewCloud: true }), r2 = rig([local, view]);
  ok("② 送出時看著雲端:算,回傳那一條", r2.F.csCloudTurn() === "v");
  const touched = mkTab("t", { running: true, "UPD.turnCloud": true }), r3 = rig([touched]);
  ok("② 這一輪碰過雲端(工具走雲端):算", r3.F.csCloudTurn() === "t");
  const upd = mkTab("u", { running: true }), r4 = rig([upd]); r4.env.UPD.cloudSid = "u";
  ok("② 更新那一輪自己:算", r4.F.csCloudTurn() === "u");
  const r5 = rig([local], [["phone1", "running"]]);
  ok("② 沒開成分頁的回合(手機來的、重載前的):看不出對著哪邊,算", r5.F.csCloudTurn() === "phone1");
  const idle = mkTab("i", { running: false, turnViewCloud: true }), r6 = rig([idle]);
  ok("② 閒著的分頁不算", r6.F.csCloudTurn() === null);
  { const f = new Function(lineOf(app, /^function upCloudTurn\(\) [^\n]*/m) + "return upCloudTurn;")();
    ok("② 開機第一次畫(chattabs.js 還沒載入):不炸,當沒有", f() === null); }
  ok("② 手機來的那一輪開成分頁時記成對著雲端(兩個入口)", /lastUserAttachments = \[\]; turnViewCloud = true; \} busyStart\(\);/.test(ct) && /turnSeqMine = turnSeq; turnViewCloud = true; turnUiSync\(\);/.test(app));
  ok("② 送出當下定案:submitMessage 照 viewing 記", /const viewing = [^\n]*chatViewing\(\);\n  turnViewCloud = !!\(viewing && viewing\.env === "cloud"\)/.test(fnOf(app, "submitMessage")));
  ok("② 切換分頁跟著走(TAB_KEYS)", /\["turnViewCloud", \(\) => turnViewCloud,/.test(ct));

  const plan = new Function(lineOf(app, /^const UP_RETRY_MS = [^\n]*/m) + fnOf(app, "upPlan") + "\nreturn upPlan;")();
  const base = { up: { phase: "ready", current: "1" }, kind: "running", cloud: { config_version: "a", latest_config_version: "b" }, mem: {}, now: 1e6, exec: "running" };
  const p1 = plan({ ...base, localTurn: true, cloudTurn: false });
  ok("② 只有本機回合:更新雲端主機可按(自動下單在跑照先問)", p1.cloud.link && p1.cloud.link.disabled === false && p1.cloud.link.ask === true, p1.cloud);
  ok("② 只有本機回合:第一行重新啟動照鎖(重開 app 會砍掉回合)", p1.link.kind === "restart" && p1.link.disabled === true);
  const p2 = plan({ ...base, localTurn: true, cloudTurn: true });
  ok("② 有對著雲端的回合:更新雲端主機鎖", p2.cloud.link.disabled === true);
  const p3 = plan({ ...base, localTurn: true, cloudTurn: false, mem: { session: { startAt: 1e6 - 1000 } } });
  ok("② 剛送出更新的 3 分鐘:別條本機回合在跑也不把鈕放回來(不會重送)", p3.cloud.link === null && p3.cloud.status[0] === "up.row.applying", p3.cloud);
  ok("② 更新期間的閒置計時只看對著雲端的回合,無關的本機回合不延長", /upObserve\(UPD, cst\.cloud, trRestartUnconfirmed\(cst\.report\), !!upCloudTurn\(\), Date\.now\(\)\)/.test(app)); }

// ── ③ ──
{ const closed = mkTab("c", { running: true }, { closed: true }), r = rig([closed]); r.F.csShowRunning();
  ok("③ 只剩關掉但還在跑的那條:走 csOpen 接回分頁列", r.env.opened.join() === "c" && r.env.shown.length === 0);
  const open = mkTab("o", { running: true }), r2 = rig([closed, open]); r2.F.csShowRunning();
  ok("③ 有開著的就看開著的", r2.env.shown.join() === "o" && r2.env.opened.length === 0);
  const r3 = rig([], [["phone1", "running"]]); r3.F.csShowRunning();
  ok("③ 沒開成分頁的那條:csOpen", r3.env.opened.join() === "phone1");
  const r4 = rig([open]); r4.env.running = true; r4.F.csShowRunning();
  ok("③ 眼前這條在跑:不動", r4.env.shown.length === 0 && r4.env.opened.length === 0); }

// ── ④ ──
{ const calls = [], tracked = [], env = { trackFeature: (n) => tracked.push(n), csStopOne: (s) => calls.push("one:" + s), csStopAll: () => calls.push("all"), stopTurn: () => calls.push("stop"), csOpen: (s) => calls.push("open:" + s), csShowRunning: () => calls.push("show"),
    $: () => ({ hidden: true, focus() {} }), paneSt: { chat: { off: false } }, scrollChat() {}, setClose() {}, csShowList() {} };
  const F = new Function(...Object.keys(env), fnOf(busy, "busyFix") + fnOf(busy, "busyView") + "return { busyFix };")(...Object.values(env));
  F.busyFix("stop", "s1"); F.busyFix("view", "s2"); F.busyFix("view");
  ok("④ 帶 sid 的〔停止〕／〔查看〕只對著那一條;不帶 sid 的〔查看〕找在跑的", calls.join() === "one:s1,open:s2,show", calls);
  const stopLinks = [...["app.js", "busy.js", "library.js", "versions.js", "handoff.js", "export.js", "report-robust.js", "report-wf.js", "perf.js"]].flatMap((f) => [...read(f).matchAll(/busyFixLink\([^\n]{0,30}"stop"\)/g)].map((m) => f));
  ok("④ 不帶 sid 的〔停止〕只剩「停不下來再按一次」(busy.js)", stopLinks.join() === "busy.js", stopLinks);
  ok("④ 更新雲端主機的〔停止〕帶擋路那條的 sid", /"cloudUpd", cloudSid\)/.test(fnOf(app, "upCloudUpdate")) && !/upLocalTurn/.test(fnOf(app, "upCloudUpdate")));
  ok("④ 先停再做(登出／換 AI／移除金鑰)照舊停全部:它們要所有回合都收掉", /csStopAll\(\)/.test(fnOf(busy, "busyStopThen"))); }

// ── ⑤ ──
{ const A = mkTab("a", { running: true, turnSeqMine: 5 }), r = rig([A]); r.env.CS.away = { sid: "a", seq: 5 };
  ok("⑤ 沒送過:不擋", r.F.csOnceLive("k") === null);
  r.F.csOnceMark("k");
  ok("⑤ 那一輪在跑:回傳那一條", r.F.csOnceLive("k").sid === "a");
  A.st.running = false;
  ok("⑤ 跑完就作廢(不靠回合結束事件)", r.F.csOnceLive("k") === null && r.F.csOnceLive("k") === null);
  const hoAsk = fnOf(ho, "hoAsk"), xpAsk = fnOf(xp, "xpAsk");
  ok("⑤ 送上雲端:按下先看、框開著的期間另一條送了再看一次、送出同步記", /const onceKey = "ho:" \+ dir \+ ":" \+ id, once = hoBlocked\(onceKey\);\n  if \(once\) \{ hoOnceTell\(once\); return; \}/.test(hoAsk) && /const again = hoBlocked\(onceKey\); if \(again\) \{ hoOnceTell\(again\); return; \}/.test(hoAsk) && /csSendAway\(msg, \{ handoff: dir[^\n]*\n\s*csOnceMark\(onceKey\);/.test(hoAsk));
  ok("⑤ 轉出:同一支同平台同一套;別的平台照轉", /const onceKey = "xp:" \+ target \+ ":" \+ id/.test(xpAsk) && /const again = csOnceLive\(onceKey\)/.test(xpAsk) && /const sending = csSendAway\(msg\); csOnceMark\(onceKey\);/.test(xpAsk)); }

// ── ⑥ ──
{ const inst = [], tr = [], env = { LIB: { pending: new Map(), installed: {}, noNew: null, cloudWait: null }, RP: { list: [] }, sessionId: "s1", libTrack: (n) => tr.push(n), libSync() {}, libEnv: () => env.E, E: "local", wcPaint: undefined,
    libInstalledSet: (id, n) => { inst.push(id + "=" + n); env.LIB.installed[id] = n; }, libCloudSettle: () => false, libCloudList: () => [], libCloudRepaintList() {}, LIB_CLOUD_WAIT_MS: 1, window: {} };
  const F = new Function("env", `with (env) { ${fnOf(lib, "libPendingBlocks")}\n${fnOf(lib, "libPendingSet")}\n${fnOf(lib, "libTurnEnd")}\n${fnOf(lib, "libTurnSettle")}\n return { libPendingBlocks, libPendingSet, libTurnEnd }; }`)(env);
  const before = () => new Map([["old", 1]]), P = env.LIB.pending;
  F.libPendingSet(1, { id: 1, env: "local", before: before(), sid: "s1" });
  ok("⑥ 本機:同一支擋,別支不擋", F.libPendingBlocks({ id: 1 }) && !F.libPendingBlocks({ id: 2 }));
  F.libPendingSet(2, { id: 2, env: "local", before: before(), sid: "s2" });
  ok("⑥ 兩支並存(每支一份,互不覆蓋)", P.size === 2 && P.get(1).sid === "s1" && P.get(2).sid === "s2" && P.get(1).overlap && P.get(2).overlap);
  env.RP.list = [{ name: "old", mtime: 1 }, { name: "aa", mtime: 2 }]; env.sessionId = "s1"; F.libTurnEnd();
  ok("⑥ 只收結束那一條的那支;另一支還在裝時,多出來的資料夾分不出是誰的:不記、不講沒新策略", !P.has(1) && P.has(2) && inst.length === 0 && env.LIB.noNew === null, { inst, noNew: env.LIB.noNew });
  env.sessionId = "other"; F.libTurnEnd(); ok("⑥ 別條結束:不動", P.has(2));
  env.sessionId = "s2"; env.RP.list = [{ name: "old", mtime: 1 }, { name: "aa", mtime: 2 }, { name: "bb", mtime: 3 }]; F.libTurnEnd();
  ok("⑥ 兩個都新、對不到:寧可不標「已安裝」,也不記錯", !P.size && inst.length === 0, inst);
  P.clear(); env.LIB.installed = { 7: "aa" };
  F.libPendingSet(8, { id: 8, env: "local", before: before(), sid: "s8", overlap: true }); env.sessionId = "s8"; F.libTurnEnd();
  ok("⑥ 同裝的另一支已記走自己的資料夾、只剩一個對得上:這支記它", inst.join() === "8=bb", inst);
  inst.length = 0; P.clear(); env.LIB.installed = {};
  F.libPendingSet(9, { id: 9, env: "local", before: before(), sid: "s9" }); env.sessionId = "s9"; env.RP.list = [{ name: "old", mtime: 1 }, { name: "cc", mtime: 4 }]; F.libTurnEnd();
  ok("⑥ 沒有同裝:照舊認新資料夾", inst.join() === "9=cc", inst);
  P.clear(); F.libPendingSet(3, { id: 3, env: "local", before: before(), stage: "dl" }); env.sessionId = "s3"; F.libTurnEnd();
  ok("⑥ 還在代下載:結束的是別輪,這支留著", P.has(3)); P.clear();
  env.E = "cloud"; F.libPendingSet(4, { id: 4, env: "cloud", before: before(), sid: "s4" });
  ok("⑥ 雲端一次一支(等清單跟上只有一格)", F.libPendingBlocks({ id: 4 }) && F.libPendingBlocks({ id: 5 })); P.clear();
  ok("⑥ 碰錢不放寬:任何一支裝到一半都不開購買框", /if \(LIB\.pending\.size\) \{[^\n]*return; \}/.test(fnOf(lib, "libBuyBox"))); }

// ── ⑦ 留著的鎖 ──
{ ok("⑦ 更新重啟看任何回合", /function upLocalTurn\(\) \{ try \{ return typeof csAnyTurn === "function" \? csAnyTurn\(\)/.test(app) && /localTurn: upLocalTurn\(\), cloudTurn: !!upCloudTurn\(\)/.test(app));
  ok("⑦ 刪策略(畫面與主行程)看任何回合;還原、再跑一次縮到同一支的測試在 check_shell_restore_lock.js", /busyLock\(d, csAnyTurn\(\)\)/.test(fnOf(app, "stratDelSync")) && /if \(anyTurn\(\)\) return \{ ok: false, code: "TURN_RUNNING" \};/.test(fs.readFileSync(path.join(R, "..", "main.js"), "utf8")));
  ok("⑦ 換 AI、登出、刪回覆中那條", /busyCut\(null, \(\) => connectNow\(kind, info\)\)/.test(app) && /busyOn\(\) \? \[t\("busy\.cut\.out"\)\]/.test(app) && /busyLock\(del, csTabRunning\(m\.id\)\)/.test(app));
  ok("⑦ 同條對話:Enter 與重送回合中照擋(Wei 11-03 拍板不做排隊)", /if \(running && \$\("ta"\)\.value\.trim\(\)\) \{ busySendTell\(\); return; \}/.test(app) && /function canResend\(\) \{ return !running/.test(app)); }

console.log(red ? red + " 紅" : "ALL PASS");
process.exit(red ? 1 : 0);
