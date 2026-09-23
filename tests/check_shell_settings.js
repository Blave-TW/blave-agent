// 設定 modal 的兩塊畫面邏輯(shell/renderer/app.js):「關於」的更新狀態(upPaint 七種 phase)、帳號區兩態(acctPaintAcct)。
// 從原文切出函式,配一個最小的假 DOM 跑。跑法:node tests/check_shell_settings.js
const fs = require("fs"), path = require("path");
const R = path.join(__dirname, "..", "shell", "renderer");
const src = fs.readFileSync(path.join(R, "app.js"), "utf8"), html = fs.readFileSync(path.join(R, "index.html"), "utf8"), css = fs.readFileSync(path.join(R, "app.css"), "utf8"), trcss = fs.readFileSync(path.join(R, "trade.css"), "utf8");
const fnSrc = (name) => { const i = src.indexOf("function " + name + "("); if (i < 0) throw new Error("找不到 " + name); return src.slice(i, src.indexOf("\n}", i) + 2); };
let red = 0; const ok = (n, c) => { console.log((c ? "PASS  " : "FAIL  ") + n); if (!c) red++; };
const el = () => {
  const cls = new Set(["btn-quiet"]);
  const n = { _txt: "", hidden: false, onclick: null, title: "", _cls: "", children: [], dataset: {}, attrs: {}, focus: () => { document.activeElement = n; },
    classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), has: (c) => cls.has(c), add: (c) => cls.add(c), remove: (c) => cls.delete(c) },
    contains: () => false, addEventListener: (ev, fn) => { if (ev === "click") n.onclick = fn; }, focus: () => { document.activeElement = n; },
    querySelector: () => null, querySelectorAll: () => [],
    setAttribute: (k, v) => { n.attrs[k] = String(v); },
    append: (...x) => { x.forEach((y) => { n.children.push(y); n._txt += typeof y === "string" ? y : y.textContent || ""; }); },
    appendChild: (x) => { n.children.push(x); n._txt += x.textContent || ""; return x; } };
  Object.defineProperty(n, "className", { get: () => n._cls, set: (v) => { n._cls = v; } });
  let first = null; Object.defineProperty(n, "firstElementChild", { get: () => first || (first = el()) });   // #ws-update 裡那個 span
  // textContent = "" 也要清掉子節點(真的 DOM 是這樣;不清的話清單重畫會越畫越長,測試就看不出漏清)
  Object.defineProperty(n, "textContent", { get: () => n._txt, set: (v) => { n._txt = v; n.children.length = 0; } });
  return n;
};
const dom = {}; const $ = (id) => dom[id] || (dom[id] = el());
const document = { createElement: () => el(), activeElement: null, body: {} };
var ENV = { cloudDirty: false }; let polls = 0, refreshes = 0; const trPoll = () => { polls++; };
var UP_TICK = null; let ticks = 0; const setInterval = () => ++ticks, clearInterval = () => {};   // S2/S3 每秒重畫:這裡只記有沒有開
let cur = null, planLoginBusy = false, oauthPending = false, HINT = null;
const setFocusGuard = () => {}, cmdLine = () => "";
const t = (k, v) => k + (v ? JSON.stringify(v) : "");
const calls = []; const window = { blave: { updateCheck: () => { calls.push("check"); return Promise.resolve(); }, updateInstall: () => { calls.push("install"); return Promise.resolve({ ok: true }); } } };
const upRefresh = () => {}; let UP = null, hasToken = false;
// 「關於」兩行 + 一顆鈕(upPlan 決策、upPaint 照畫、upGo 動作)。雲端那一袋、聊天送出用假的
// Wei 09-22 新原則:用本機 app 不得觸發雲端 agent 回合——雲端那半改成在本機聊天送一句(帶 viewing env:cloud),不送雲端指令
const TR_BAGS = { cloud: { st: null, reqIds: {} } };
let running = false, LANG = "zh", sent = [], startOk = true;
const envCloudKind = (st) => (st && st.kind) || "loading";
const trRestartUnconfirmed = (r) => { const x = r && r.reconciler && r.reconciler.stopped; return !!(x && x.reason === "machine_restart" && x.gated === false); };   // 同 trade.js(那邊有自己的測試)
const submitMessage = async (msg, o) => { sent.push([msg, o]); if (startOk) running = true; return startOk; };   // 真的那支一開跑就把 running 設起來
const paneSt = { chat: { off: false } }, paneToggle = () => {};
eval("var UPD = " + src.match(/var UPD = (\{[^\n]*\});/)[1]);
eval(src.match(/const UP_REPORT_WAIT_MS = [^\n]*;/)[0].replace(/^const /, "var ")); eval(fnSrc("upClock")); eval(fnSrc("upObserve"));
const stepWhere = (c) => (c && c.where) || "local";
eval(fnSrc("upPlan")); eval(fnSrc("upLocalTurn")); eval(fnSrc("upNow")); eval(fnSrc("upPaint")); eval("async " + fnSrc("upGo")); eval("async " + fnSrc("upInstallLocal"));
eval(fnSrc("upTurnEnded")); eval(fnSrc("acctPaintAcct"));
const paint = (st) => { UP = st; upPaint(); const b = $("set-up-btn"); return { ver: $("set-up-ver").textContent, msg: $("set-up-txt").textContent, up: $("set-up-txt").className.includes("up"), btn: b.hidden ? null : b.textContent, out: b.classList.has("btn-out"), quiet: b.classList.has("btn-quiet") }; };
const C = { current: "0.0.1", version: "0.0.2" };
let p = paint({ ...C, phase: "off", version: null });
ok("off(沒有更新來源):只有版號,沒有狀態句、沒有鈕", p.ver === 'up.app{"v":"0.0.1"}' && p.msg === "" && p.btn === null);
p = paint({ ...C, phase: "idle" }); ok("idle:已是最新版 + 安靜的「檢查更新」", p.msg === "up.latest" && p.btn === "up.check" && p.quiet && !p.out && !p.up);
p = paint({ ...C, phase: "checking" }); ok("checking:沒有鈕", p.msg === "up.checking" && p.btn === null);
p = paint({ ...C, phase: "downloading", percent: 42 }); ok("downloading:有百分比用帶百分比的句子,沒有鈕;沒有百分比退回不帶的", p.msg === 'up.downloadingPct{"nv":"0.0.2","pct":42}' && p.btn === null && paint({ ...C, phase: "downloading", percent: null }).msg === 'up.downloading{"nv":"0.0.2"}');
p = paint({ ...C, phase: "staging" }); ok("staging:沒有鈕(還沒驗完章,不能給重啟)", p.msg === 'up.staging{"nv":"0.0.2"}' && p.btn === null);
p = paint({ ...C, phase: "ready" }); ok("ready:句子升一階、鈕換成描邊的「更新」(兩邊共用那一顆)", p.up && p.btn === "up.update" && p.out && !p.quiet && !$("set-up-dot").hidden);
(async () => {
  calls.length = 0; await $("set-up-btn").onclick(); await new Promise((r) => setImmediate(r));
  ok("只有這台電腦有新版:按下去是安裝(不跳框)", calls.join() === "install" && sent.length === 0);
  p = paint({ ...C, phase: "blocked" }); ok("blocked(下單中)而雲端沒有新版:講原因、**沒有鈕**(下單中不裝)", p.msg === 'up.blocked{"nv":"0.0.2"}' && p.up && p.btn === null);
  p = paint({ ...C, phase: "error", error: "CHECK_FAILED" }); ok("error:這次沒檢查成功 + 檢查更新(鈕退回安靜的)", p.msg === "up.error" && p.up && p.btn === "up.check" && p.quiet && !p.out);
  p = paint({ ...C, phase: "error", error: "INSTALL_FAILED" }); ok("安裝失敗:講出來、可以再檢查", p.msg === 'up.installFailed{"nv":"0.0.2"}' && p.btn === "up.check");
  ok("版號每一種 phase 都在", ["idle", "checking", "ready", "blocked", "error"].every((ph) => paint({ ...C, phase: ph }).ver === 'up.app{"v":"0.0.1"}'));
  p = paint({ ...C, phase: "idle", backup: { n: 2, dir: ".official-backup/1.1.80-x/" } });
  ok("換版時蓋掉的改動:那一行講數量與位置", $("set-up-bk").textContent === 'up.backup{"n":2,"dir":".official-backup/1.1.80-x/"}');

  // ── 雲端那一行 ──
  const cloud = (o) => ({ kind: "running", cloud: { config_version: "1.1.80", latest_config_version: "1.1.83", turn_active: false, update: null, ...o } });
  const plan = (st, up, mem, localTurn, now) => upPlan({ up: up || { ...C, phase: "idle" }, cloud: st && st.cloud, kind: st ? envCloudKind(st) : "loading", localTurn: !!localTurn, mem: mem || {}, now: now || 0 });
  let q = plan(cloud({}));
  ok("雲端落後:那一行「有新版」+ 按之前就講的提醒句(本機 agent 去做、用你自己的 AI 額度)、鈕是「更新」、小點亮、聊天入口出現",
    q.cloud.s[0] === "up.c.available" && q.cloud.note[0] === "up.c.note" && q.btn.label[0] === "up.update" && q.btn.act === "cloud" && q.dot && q.chat.show && !q.chat.disabled);
  { // spec-restart-gated-false-display §6-3:報告 reconciler.stopped.gated === false(停不住的是舊版對帳器)→ 版號一樣也要出「更新」
    const same = cloud({ config_version: "1.1.83" });
    const q1 = upPlan({ up: { ...C, phase: "idle" }, cloud: same.cloud, kind: "running", localTurn: false, mem: {}, cloudStale: true });
    const q0 = upPlan({ up: { ...C, phase: "idle" }, cloud: same.cloud, kind: "running", localTurn: false, mem: {}, cloudStale: false });
    ok("§6-3 gated:false:版號一樣也算雲端有新版(鈕、聊天入口出現,那一行講舊版停不住);沒有這個旗標照舊是最新版",
      q1.cloud.has && q1.btn.act === "cloud" && q1.chat.show && q1.cloud.s[0] === "up.c.needsUpdate" && !q0.cloud.has && q0.cloud.s[0] === "up.latest");
    const Rs = (g) => ({ kind: "running", cloud: same.cloud, report: { reconciler: { stopped: { reason: "machine_restart", gated: g } } } });
    TR_BAGS.cloud.st = Rs(false); ok("§6-3 upNow 從報告讀 gated(嚴格 false)交給 upPlan", upNow().cloud.has === true && ((TR_BAGS.cloud.st = Rs(undefined)), upNow().cloud.has === false));
    TR_BAGS.cloud.st = Rs(false); Object.assign(UPD, { result: "idle", doneAt: 5, doneFor: "1.1.83" }); upPaint();
    ok("§6-3 版號一樣、但還停不住:不算追上(上一回合的結果不清掉)", UPD.doneAt === 5);
    Object.assign(UPD, { result: null, doneAt: 0, doneFor: null }); TR_BAGS.cloud.st = null; }
  ok("沒主機 / 沒登入 / 還沒讀到:雲端那一行不畫", plan({ kind: "none", cloud: {} }).cloud === null && plan({ kind: "signedOut", cloud: {} }).cloud === null && plan(null).cloud === null);
  q = plan({ kind: "stopped", cloud: { config_version: "1.1.80" } }, { ...C, phase: "ready" });
  ok("雲端停機:講原因,鈕照樣能更新這台電腦", q.cloud.s[0] === "up.c.stopped" && !q.cloud.has && q.doLocal && q.btn.act === "local");
  q = plan(cloud({ turn_active: true }));
  ok("停用條件只看本機回合:雲端 turn_active 不再擋(雲端那半是本機 agent 的一回合)", !q.btn.disabled && !q.chat.disabled);
  q = plan(cloud({}), null, {}, true);
  ok("這台電腦有回合在跑:鈕與聊天入口停用,原因 up.busy", q.btn.disabled && q.btn.title[0] === "up.busy" && q.chat.disabled);
  q = plan(cloud({ update: { state: "done", result: "reconciler_down", requested_at: 1, from_version: "1.1.80" } }));
  ok("/cloud/state 的 update 讀數不再用(紀錄說什麼都不影響畫面)", q.cloud.s[0] === "up.c.available" && q.btn.act === "cloud");
  // ── v2 §2 狀態表(spec-desktop-update-experience-v2):session 內的每一種狀態都由 upPlan 決定 ──
  const T0 = 1e12, ses = (o) => ({ session: { startAt: T0, lastTurnAt: T0, fromCv: "1.1.80", nv: "1.1.83" }, ...o });
  q = plan(cloud({}), null, ses({ cloudTurn: true }), true, T0 + 83000);
  ok("S2 按鈕送出的那一回合在跑:正在更新雲端主機・{t}(從按下起算)、註腳過程在聊天;鈕 spinner「更新中」停用;聊天那一行是不可點的狀態列;要每秒重畫",
    q.cloud.s[0] === "up.c.running" && q.cloud.s[1].t === "1:23" && q.cloud.note[0] === "up.c.runNote" && q.btn.disabled && q.btn.spin && q.btn.label[0] === "up.updating" && !q.cloud.has
    && q.chat.show && q.chat.kind === "status" && q.chat.text[0] === "up.c.chatRunning" && q.chat.text[1].t === "1:23" && q.tick);
  q = plan(cloud({}), null, ses({ cloudTurn: false, result: "idle", doneAt: T0 + 5000 }), true, T0 + 600000);
  ok("S3 session 內後續的回合在跑(例如回「好」):agent 回覆中・{t},時間不歸零;鈕同 S2", q.cloud.s[0] === "up.c.replying" && q.cloud.s[1].t === "10:00" && q.btn.spin && q.btn.disabled && q.chat.kind === "status" && q.chat.text[0] === "up.c.replying" && q.tick);
  const idle = ses({ result: "idle", doneAt: T0 + 60000, doneFor: "1.1.83" }), fault = ses({ result: "fault", doneAt: T0 + 60000, doneFor: "1.1.83" });
  q = plan(cloud({}), null, idle, false, T0 + 60000 + UP_REPORT_WAIT_MS);
  ok("視覺稽核 2-6:S2–S5 的句子跟 S1 同一階(--ink-2),不比靜態通知暗;完成態維持綠", ["up.c.running", "up.c.replying", "up.c.checking", "up.c.noReport"].every((k) => {
    const st2 = k === "up.c.running" ? plan(cloud({}), null, ses({ cloudTurn: true }), true, T0) : k === "up.c.replying" ? plan(cloud({}), null, ses({ cloudTurn: false, result: "idle", doneAt: T0 + 1 }), true, T0 + 2)
      : k === "up.c.checking" ? plan(cloud({}), null, idle, false, T0 + 60001) : plan(cloud({}), null, idle, false, T0 + 60000 + UP_REPORT_WAIT_MS + 1);
    return st2.cloud.s[0] === k && st2.cloud.cls === "up"; }) && plan(cloud({ config_version: "1.1.83" }), null, { done: { from: "1.1.80", to: "1.1.83" } }).cloud.cls === "ok");
  ok("S4 回合結束、還沒追上、≤ 3 分鐘:「agent 回覆了,看聊天」;鈕**不鎖**;聊天那一行「看 agent 的回覆」(可點);不出紅字、不每秒重畫",
    q.cloud.s[0] === "up.c.checking" && q.cloud.cls !== "bad" && !q.btn.disabled && q.btn.act === "cloud" && q.btn.title[0] === "up.c.note" && q.chat.kind === "reply" && q.chat.text[0] === "up.c.chatSeeReply" && !q.tick);
  q = plan(cloud({}), null, idle, false, T0 + 60000 + UP_REPORT_WAIT_MS + 1);
  ok("S5 過了 3 分鐘:「還沒收到雲端主機回報 {nv}」+ 提醒句;聊天那一行回到「立即更新到最新版本」", q.cloud.s[0] === "up.c.noReport" && q.cloud.s[1].nv === "1.1.83" && q.cloud.note[0] === "up.c.note" && q.chat.kind === "go" && q.chat.text[0] === "up.chat" && q.btn.act === "cloud" && UP_REPORT_WAIT_MS === 180000);
  q = plan(cloud({}), null, fault, false, T0 + 61000);
  ok("S6 回合出錯:回到「有新版」、指到聊天,不出紅字", q.cloud.s[0] === "up.c.available" && q.cloud.cls !== "bad" && q.cloud.note[0] === "up.c.seeChat" && q.btn.act === "cloud" && q.chat.kind === "go");
  ok("A 沒有「這次沒有更新成功」這一態:失敗由聊天講", !/notUpdated|up\.retry|UP_SETTLE_MS/.test(fnSrc("upPlan")));
  q = plan(cloud({ config_version: "1.1.83" }), null, { done: { from: "1.1.80", to: "1.1.83" } });
  ok("S7 已更新到 {nv}(綠字)+ {from} → {nv};鈕回到檢查更新;聊天那一行綠字、不可點", q.cloud.s[0] === "up.c.done" && q.cloud.s[1].nv === "1.1.83" && q.cloud.cls === "ok" && q.cloud.note[0] === "up.c.doneFrom" && q.cloud.note[1].from === "1.1.80"
    && (!q.btn || q.btn.act === "check") && q.chat.kind === "done" && q.chat.text[0] === "up.c.chatDone");
  ok("S7 送出下一則訊息之後聊天那一行收起,「關於」照停", (() => { const x = plan(cloud({ config_version: "1.1.83" }), null, { done: { from: "1.1.80", to: "1.1.83" }, doneChatHidden: true }); return x.cloud.s[0] === "up.c.done" && x.chat.show === false; })()
    && /if \(UPD\.done\) UPD\.doneChatHidden = true;/.test(fnSrc("submitMessage")));
  q = plan(cloud({}), { ...C, phase: "ready" }, idle, false, T0 + 61000);
  ok("R2 兩邊都有新版:主鈕是雲端那一半,這台電腦另有一顆", q.btn.act === "cloud" && q.localBtn && q.localBtn.label[0] === "up.installLocal" && !q.localBtn.disabled);
  q = plan(cloud({}), { ...C, phase: "ready" }, ses({ cloudTurn: true }), true, T0);
  ok("R2 …雲端那一回合在跑時,本機那顆也停用(重開會斷掉它)", q.localBtn && q.localBtn.disabled);
  ok("R2 只有這台電腦有新版:主鈕就是本機那一半,沒有第二顆", plan(cloud({ config_version: "1.1.83" }), { ...C, phase: "ready" }).btn.act === "local" && plan(cloud({ config_version: "1.1.83" }), { ...C, phase: "ready" }).localBtn === null);
  // ── upObserve:session 什麼時候結束、什麼時候算「已更新」 ──
  const O = (mem, cl, localTurn, now, stale) => upObserve(mem, cl.cloud, !!stale, !!localTurn, now || T0);
  let m = O(ses({ doneAt: 5, result: "idle" }), cloud({ config_version: "1.1.83" }));
  ok("S7 session 內追上 → done { from: 按下時的 cv, to: nv },session 結束", m.done && m.done.from === "1.1.80" && m.done.to === "1.1.83" && m.session === null && m.doneAt === 0 && m.result === null);
  m = O(m, cloud({ config_version: "1.1.83" }), false, T0 + 9e6);
  ok("S7 追上之後一直停著(再看幾次、過多久都不清)", m.done && m.done.to === "1.1.83");
  m = O(m, cloud({ config_version: "1.1.83", latest_config_version: "1.1.90" }));
  ok("S7 下一次落後出現才清掉", m.done === null && m.lagCv === "1.1.83");
  m = O({ done: null, lagCv: null }, cloud({})); m = O(m, cloud({ config_version: "1.1.83" }));
  ok("S7 不是按鈕觸發(用戶自己打字叫 agent 更新):原本落後、之後 cv 變了而且追上 → 一樣有「已更新」,from = 變之前那一版", m.done && m.done.from === "1.1.80" && m.done.to === "1.1.83");
  m = O({ done: null, lagCv: null }, cloud({ config_version: "1.1.83" }));
  ok("S0 一開就是最新版:不冒出「已更新」", m.done === null);
  m = O(ses({ cloudTurn: false }), cloud({ latest_config_version: "1.1.90" }));
  ok("session 內出了更新一版:session 結束(這一次的結果不拿來判下一版)", m.session === null);
  m = O(ses({}), cloud({}), false, T0 + 30 * 60000 + 1);
  ok("按下後 30 分鐘都沒有回合在跑:session 結束;有回合在跑就續命", m.session === null && O(ses({}), cloud({}), true, T0 + 40 * 60000).session !== null);
  m = O(ses({}), cloud({ config_version: "1.1.83" }), false, T0, true);
  ok("§6-3 版號一樣、但還停不住(gated:false):不算追上", m.session !== null && m.done === null);
  { // 稽核的測試缺口 ②:{t} 從按下起累計,換回合不歸零(之前改成每回合歸零六支測試全綠)
    const mem = ses({ cloudTurn: true }), c1 = plan(cloud({}), null, mem, true, T0 + 30000);
    // lastTurnAt 也要推進:不推的話「把基準換成 lastTurnAt」這種歸零方式看不出來(追加稽核 3)
    const mem2 = { ...mem, cloudTurn: false, result: "idle", doneAt: T0 + 40000, session: { ...mem.session, lastTurnAt: T0 + 40000 } }, c2 = plan(cloud({}), null, mem2, true, T0 + 90000);
    ok("{t} 從按下起累計:第一回合 0:30,第二回合仍從按下起算(1:30,不是 0:50)", c1.cloud.s[1].t === "0:30" && c2.cloud.s[1].t === "1:30" && c2.cloud.s[0] === "up.c.replying"); }
  { // 追加稽核 2:fault 收掉 session 之後,S6 不可以變成永久標籤——這一版的事情有結論就清掉
    let f = O(ses({ cloudTurn: false, result: "fault", doneAt: T0 + 1000, doneFor: "1.1.83" }), cloud({}), false, T0 + 2000);
    ok("fault:session 收掉,S6 的字還在(還沒追上、也還沒出新版)", f.session === null && f.result === "fault" && f.doneAt > 0
      && plan(cloud({}), null, f, false, T0 + 3000).cloud.s[0] === "up.c.available");
    const g = O({ ...f }, cloud({ config_version: "1.1.83" }), false, T0 + 4000);
    ok("fault 之後追上了:S6 清掉,換成 S7「已更新到」", g.doneAt === 0 && g.result === null && g.doneFor === null && plan(cloud({ config_version: "1.1.83" }), null, g, false, T0 + 5000).cloud.s[0] === "up.c.done");
    const h = O({ ...f }, cloud({ latest_config_version: "1.1.90" }), false, T0 + 4000);
    ok("fault 之後出了更新一版:S6 清掉,回到「有新版」(不是「上一次沒完成」)", h.doneAt === 0 && h.result === null && plan(cloud({ latest_config_version: "1.1.90" }), null, h, false, T0 + 5000).cloud.note[0] === "up.c.note");
    const k2 = O({ ...f }, cloud({}), false, T0 + 9e6);
    ok("fault、同一版還沒有結論:過多久都還是 S6(兩個條件都要,不是靠時間)", k2.doneAt > 0 && k2.result === "fault");
    // 這一條只治「沒有 session 的殘留」:session 還在(S4 / S5 正在等回報)時不可以順手把 doneAt 清掉,否則 S4 直接掉回 S1
    const live = O(ses({ cloudTurn: false, result: "idle", doneAt: T0 + 1000, doneFor: "1.1.83" }), cloud({ latest_config_version: "1.1.83" }), false, T0 + 2000);
    ok("session 還在時不清 doneAt(S4 要靠它;清掉就掉回 S1)", live.session !== null && live.doneAt > 0 && plan(cloud({}), null, live, false, T0 + 2000).cloud.s[0] === "up.c.checking");
    // 同一條的另一半:S5(過了 3 分鐘)也靠 doneAt,session 還在時被清掉的話會退回 S1「有新版」
    const live5 = O(ses({ cloudTurn: false, result: "idle", doneAt: T0 + 1000, doneFor: "1.1.83" }), cloud({ latest_config_version: "1.1.83" }), false, T0 + 2000);
    ok("session 還在、過了 3 分鐘:仍是 S5(doneAt 沒被順手清掉)", plan(cloud({}), null, live5, false, T0 + 1000 + UP_REPORT_WAIT_MS + 1).cloud.s[0] === "up.c.noReport");
    /* 這條清理只治「沒有 session 的殘留」:按下當時還讀不到 latest(session.nv / doneFor 都是 null),之後 latest 才冒出來——
       session 還在、人還在等回報,不可以因為 lv !== doneFor 就把 S4 清成 S1 */
    const unk = O({ session: { startAt: T0, lastTurnAt: T0, fromCv: "1.1.80", nv: null }, cloudTurn: false, result: "idle", doneAt: T0 + 1000, doneFor: null, done: null, lagCv: null },
      cloud({}), false, T0 + 2000);
    ok("按下時還讀不到新版號:latest 後來出現也不清掉在途的 S4", unk.session !== null && unk.doneAt > 0 && plan(cloud({}), null, unk, false, T0 + 2000).cloud.s[0] === "up.c.checking"); }
  { /* 稽核 R2:換語言會把聊天上方那一行洗回「立即更新到最新版本」,dataset.kind 卻還是上一個狀態
       → S4 按下去變成捲聊天、S7 的綠字被洗掉還帶 aria-disabled(看起來像壞掉的鈕)。
       修法:那個 span 不掛 data-i18n(字由 upPaint 決定,S2/S3/S7 還帶 {t} / {nv},通用迴圈也填不出來) */
    const span = html.slice(html.indexOf('id="ws-update"'), html.indexOf("</button>", html.indexOf('id="ws-update"')));
    ok("R2 #ws-update 的字不走 data-i18n(換語言不會洗掉 upPaint 寫的字)", !/data-i18n/.test(span) && /<span><\/span>/.test(span));
    // applyStatic:通用迴圈跑完之後那一行還是 upPaint 寫的字、kind 也還對得上
    // upPaint 用真的 Date.now():fixture 也要照現在的時鐘做,才落在 S4(回合結束 3 分鐘內)
    const N4 = Date.now();
    const st4 = { cloudTurn: false, result: "idle", doneAt: N4 - 1000, doneFor: "1.1.83", done: null, lagCv: null, doneChatHidden: false,
      session: { startAt: N4 - 5000, lastTurnAt: N4 - 1000, fromCv: "1.1.80", nv: "1.1.83" } };
    TR_BAGS.cloud.st = cloud({}); Object.assign(UPD, st4); UP = { ...C, phase: "idle" }; upPaint();
    const before = $("ws-update").firstElementChild.textContent, kind = $("ws-update").dataset.kind;
    const staticSrc = fnSrc("applyStatic");
    // 逐字跑 applyStatic 裡那三行通用迴圈(假 DOM 只收有 data-i18n 的節點:#ws-update 的 span 沒有就不會被碰到)
    const nodes = /data-i18n="[^"]*"/.test(span) ? [$("ws-update").firstElementChild] : [];
    nodes.forEach((el) => { el.textContent = "up.chat"; });
    ok("R2 換語言之後那一行仍是「看 agent 的回覆」、kind 仍是 reply(不會變成立即更新)", kind === "reply" && before === "up.c.chatSeeReply" && $("ws-update").firstElementChild.textContent === before
      && /if \(typeof upPaint === "function" && typeof UP !== "undefined"\) upPaint\(\);/.test(staticSrc));
    Object.assign(UPD, { session: null, result: null, doneAt: 0, doneFor: null, done: null, lagCv: null }); }
  { // 稽核 R3:版號讀不到(api 的 VERSION 抓失敗會快取 60 秒的 null;主機還沒回報也是 null)時不可以印出「回報 null。」
    const stale = (mem, t2) => upPlan({ up: { ...C, phase: "idle" }, cloud: { config_version: "1.1.83", latest_config_version: null }, kind: "running", localTurn: false, mem, now: t2, cloudStale: true });
    const ses2 = (o) => ({ session: { startAt: T0, lastTurnAt: T0, fromCv: "1.1.83", nv: null }, ...o });
    const s5 = stale(ses2({ result: "idle", doneAt: T0 + 1000, doneFor: null }), T0 + 1000 + UP_REPORT_WAIT_MS + 1);
    const s6 = stale(ses2({ result: "fault", doneAt: T0 + 1000, doneFor: null }), T0 + 2000);
    ok("R3 讀不到版號:S5 / S6 都不帶 {nv},改用不指名版號那一句", s5.cloud.s[0] === "up.c.needsUpdate" && !s5.cloud.s[1] && s6.cloud.s[0] === "up.c.needsUpdate" && !s6.cloud.s[1]
      && stale(ses2({ result: "idle", doneAt: T0 + 1000, doneFor: null }), T0 + 1001).cloud.s[0] === "up.c.checking");
    const lv2 = (mem, t2) => upPlan({ up: { ...C, phase: "idle" }, cloud: { config_version: "1.1.80", latest_config_version: "1.1.83" }, kind: "running", localTurn: false, mem, now: t2 });
    ok("R3 讀得到版號:S5 / S6 照樣帶 {nv}", lv2(ses2({ result: "idle", doneAt: T0 + 1000, doneFor: "1.1.83" }), T0 + 1000 + UP_REPORT_WAIT_MS + 1).cloud.s[1].nv === "1.1.83"
      && lv2(ses2({ result: "fault", doneAt: T0 + 1000, doneFor: "1.1.83" }), T0 + 2000).cloud.s[1].nv === "1.1.83"); }
  { // 稽核 R4:回合結束時讀不到版號(doneFor = null),之後 lv 冒出來不可以把 S6 清掉
    const f2 = { session: null, cloudTurn: false, result: "fault", doneAt: T0 + 1000, doneFor: null, done: null, lagCv: null };
    const a2 = O({ ...f2 }, cloud({}), false, T0 + 2000);
    ok("R4 doneFor 是 null:lv 出現不算「出了新版」,S6 留著", a2.doneAt > 0 && a2.result === "fault");
    const b2 = O({ ...f2 }, cloud({ config_version: "1.1.83" }), false, T0 + 2000);
    ok("R4 …但追上了照樣清掉(不會變成永久標籤)", b2.doneAt === 0 && b2.result === null); }
  ok("upClock:m:ss、上限 59:59", upClock(0) === "0:00" && upClock(83000) === "1:23" && upClock(9e9) === "59:59");

  // ── 按下去:雲端那半 = 在本機聊天送那一句(帶 viewing env:cloud),不送雲端指令;這台電腦那半這一次不重開 ──
  UP = { ...C, phase: "ready" }; TR_BAGS.cloud.st = cloud({}); Object.assign(UPD, { cloudTurn: false, result: null, doneAt: 0, doneFor: null, session: null, done: null, lagCv: null, doneChatHidden: false });
  calls.length = 0; sent.length = 0; running = false;
  await upGo();
  ok("雲端有新版:送的是本機聊天那一句、帶 viewing env:cloud;沒有任何雲端指令;這台電腦這一次不重開;開一段 session(記下按下時的 cv / nv)",
    sent.length === 1 && sent[0][0] === "up.c.msg" && JSON.stringify(sent[0][1]) === '{"viewing":{"env":"cloud"}}' && calls.length === 0 && UPD.cloudTurn === true
    && UPD.session && UPD.session.fromCv === "1.1.80" && UPD.session.nv === "1.1.83");
  running = true; ticks = 0; upPaint();
  ok("回合在跑:關於那一行是「正在更新雲端主機・{t}」、鈕停用帶 spinner、聊天那一行是狀態列(aria-disabled、不是 disabled)、開始每秒重畫",
    /^up\.c\.running/.test($("set-up-ctxt").textContent) && $("set-up-btn").disabled === true && $("set-up-btn").children.some((c) => c && c.className === "spin16")
    && !$("ws-update").hidden && $("ws-update").dataset.kind === "status" && $("ws-update").attrs["aria-disabled"] === "true" && $("ws-update").disabled === false && !!UP_TICK);
  ok("A 接線:turn-end 把「出錯 / 沒回覆 / 登出」交給 upTurnEnded;工具步驟**不**拿來猜有沒有更新(busyStep 不碰 UPD)",
    /upTurnEnded\(r\.code !== 0 \|\| turnFaulted \|\| turnErrored \|\| !turnGotReply \|\| loggedOut\);\s*running = false;/.test(src) && !/UPD/.test(fnSrc("busyStep")));
  window.blave.cloudRefresh = () => { refreshes++; return Promise.resolve(); };
  upTurnEnded(false); running = false; upPaint(); await new Promise((r) => setImmediate(r));
  ok("回合結束立刻強制問一次雲端,問完標記雲端要重讀並立刻輪詢一次(主機已回報就不必等下一輪)", refreshes === 1 && ENV.cloudDirty === true && polls === 1);
  ok("A 回合結束、沒出錯 → idle、S4(不是已完成);每秒重畫停掉",
    UPD.cloudTurn === false && UPD.result === "idle" && UPD.doneAt > 0 && $("set-up-ctxt").textContent === "up.c.checking" && $("ws-update").dataset.kind === "reply" && UP_TICK === null);
  running = true; upPaint();
  ok("S3 之後的回合(回「好」)也算更新中:「agent 回覆中」", /^up\.c\.replying/.test($("set-up-ctxt").textContent));
  ok("B4 每秒跳的秒數放在 aria-hidden 的小節點裡(role=status 不會每秒重念整句)", (() => { const ct = $("set-up-ctxt"), sp = ct.children.find((c) => c && c.attrs && c.attrs["aria-hidden"] === "true"); return !!sp && /:/.test(sp.textContent) && ct.textContent.length > sp.textContent.length; })()
    && /role="status"/.test(html.slice(html.indexOf('id="set-up-ctxt"') - 120, html.indexOf('id="set-up-ctxt"') + 40)));
  upTurnEnded(true); running = false; upPaint();
  ok("B8 回合出錯(S6)當場收掉更新期間,不讓它再活 30 分鐘;S6 那一行照樣講「有新版 + 看聊天」", UPD.session === null);
  ok("session 內後續回合出錯 → fault(S6)", UPD.result === "fault" && $("set-up-ctxt").textContent === 'up.c.available{"nv":"1.1.83"}' && $("set-up-cnote").textContent === "up.c.seeChat");
  TR_BAGS.cloud.st = cloud({ config_version: "1.1.83" }); upPaint();
  ok("S7 追上了:「已更新到 1.1.83」停住(綠字),session 收掉", $("set-up-ctxt").textContent === 'up.c.done{"nv":"1.1.83"}' && $("set-up-ctxt").className.includes("ok") && UPD.session === null && $("ws-update").dataset.kind === "done");
  upPaint(); upPaint();
  ok("S7 再畫幾次也不退回「已是最新版」", $("set-up-ctxt").textContent === 'up.c.done{"nv":"1.1.83"}');
  TR_BAGS.cloud.st = cloud({});
  Object.assign(UPD, { cloudTurn: false, doneAt: 0, result: null, session: null, done: null, lagCv: null }); sent.length = 0; startOk = false;
  await upGo();
  ok("聊天沒送出去(上一輪還在跑 / 版本被停用):不進更新期間", UPD.cloudTurn === false && UPD.session === null && sent.length === 1);
  startOk = true; UP = { ...C, phase: "idle" }; TR_BAGS.cloud.st = cloud({}); Object.assign(UPD, { doneAt: 0 }); upPaint();
  ok("聊天那一行的 title 在按之前就是提醒句", !$("ws-update").hidden && $("ws-update").title === "up.c.note" && $("set-up-cnote").textContent === "up.c.note");
  ok("聊天那一行:狀態列 / 已更新不可點;「看 agent 的回覆」捲到最後一則;只有 go 才送更新", /if \(k === "reply"\) \{ scrollChat\(\); return; \}/.test(src) && /if \(k === "go"\) upGo\(\);/.test(src));
  { const S2 = fs.readFileSync(path.join(R, "strings.js"), "utf8");
    ok("提醒句與送出那一句的字(zh / en);舊的雲端指令字串與 up.install / up.c.updating(換成 up.c.running)都清掉",
      /"up\.c\.note": "這台電腦的 agent 會連上雲端主機做更新，用你自己的 AI 額度；若下單程式在跑，它會先問你。"/.test(S2) && /"up\.c\.msg": "把雲端主機更新到最新版本"/.test(S2) && /"up\.c\.msg": "Update the cloud machine to the latest version"/.test(S2)
      && !/"up\.(install|c\.(recDown|restart|restartSent|updatedRec|notYet|unsupported|updating)|cf\.[a-zA-Z]+)"/.test(S2)
      && /"up\.c\.running": "正在更新雲端主機 · \{t\}"/.test(S2) && /"up\.c\.running": "Updating the cloud machine · \{t\}"/.test(S2) && !/・/.test(S2) && /"up\.c\.done": "已更新到 \{nv\}"/.test(S2) && /"up\.c\.noReport": "還沒收到雲端主機回報 \{nv\}。/.test(S2)); }
const S = fs.readFileSync(path.join(R, "strings.js"), "utf8");
ok("字串:up.app / acct.signedOut 在、up.label / up.current 清掉、前綴「{v} ·」拿掉", /"up\.app"/.test(S) && /"acct\.signedOut"/.test(S) && !/"up\.(label|current)"/.test(S) && !/"up\.[a-zA-Z]+": "\{v\} /.test(S));

// 設定 › 帳號(正式分類;左欄底那一塊已退場)
const acctState = () => ({ a1: $("acct-a1").textContent, a2: $("acct-a2").textContent, dot: $("acct-a2").className.includes("on"),
  btn: $("set-acct-btn").textContent, btnCls: $("set-acct-btn").className, list: $("acct-list").children.map((x) => x.textContent) });
hasToken = false; cur = "claude"; acctPaintAcct();
let A = acctState();
ok("未登入:Blave 帳號 / 未登入(沒有綠點)/ 填色的「登入 Blave」/ 兩條「登入拿得到什麼」", A.a1 === "acct.lbl" && A.a2 === "acct.signedOut" && !A.dot && A.btn === "cn.blave.btn" && A.btnCls === "btn-fill" && A.list.join() === "acct.in.1,acct.in.2");
planLoginBusy = true; acctPaintAcct();
ok("登入等待中:同一顆鈕變「取消」而不是變灰(同方案頁)", acctState().btn === "oauth.cancel" && acctState().btnCls === "btn-out");
planLoginBusy = false;
hasToken = true; acctPaintAcct(); A = acctState();
ok("已登入、用自己的 CLI:綠點 + 已登入、描邊的「登出」、兩條「登出會怎樣」", A.a2 === "acct.signedIn" && A.dot && A.btn === "acct.out" && A.btnCls === "btn-out" && A.list.join() === "acct.out.1,acct.out.2");
cur = "blave"; acctPaintAcct();
ok("已登入、用 Blave 的 AI:多一條講「登出會回到選 AI 的畫面」,而且排第一(最突兀的後果先講);用自己 CLI 的人不出這一條", acctState().list.join() === "acct.out.3,acct.out.1,acct.out.2");
ok("登出不另跳確認框(可逆、沒有東西會被刪);那顆鈕的 id 不變,焦點留在同一個位置", !/confirmBox\(\{[^}]*acct\.out/.test(src) && /\$\("set-acct-btn"\)\.focus\(\)/.test(src));
ok("「前往」只換分類、不外開瀏覽器(錢的事在「資料與雲端方案」)", /\$\("acct-to-plan-btn"\)\.addEventListener\("click", \(\) => \{ setCat\("plan"\);/.test(src));
ok("未登入時走現有的登入流程(planLogin),不另寫一條", /await planLogin\(\); acctPaintAcct\(\); return;/.test(src) && (src.match(/startOAuth\(/g) || []).length === 4);   // 4 = HEAD 既有的次數:帳號頁沒有多開一條
ok("左欄底那一塊清乾淨:DOM / CSS / 程式都沒有舊的 id 與 class", !/id="set-acct"[^-]/.test(html) && !/set-acct-who|set-acct-st\b/.test(html + src) && !/\.set-acct \.(who|l1|l2|lbl|mail)|\.set-cats \.set-acct/.test(css));
const CATS = (re) => [...html.matchAll(re)].map((m) => m[1]).join();
ok("分類順序:一般 → 模型接入 → 資料來源 → 資料與雲端方案 → 帳號 → 隱私;每一類都有自己的頁", CATS(/class="set-cat"[^>]*data-set-cat="([a-z]+)"/g) === "display,model,src,plan,acct,priv" && CATS(/class="set-pane[^"]*" data-set-cat="([a-z]+)"/g) === "display,model,src,plan,acct,priv");
const PO2 = ["zh", "en"].map((l) => fs.readFileSync(path.join(__dirname, "..", "shell", "i18n", l + ".po"), "utf8"));
ok("那一類定名「一般」;指到它的句子(minv.trade)兩語都跟著改", /msgid "set\.cat\.display"\nmsgstr "一般"/.test(PO2[0]) && /msgid "set\.cat\.display"\nmsgstr "General"/.test(PO2[1])
  && /msgid "minv\.trade"\nmsgstr "[^\n]*設定 › 一般/.test(PO2[0]) && /msgid "minv\.trade"\nmsgstr "[^\n]*Settings › General/.test(PO2[1]));

// 設定 › 模型接入(三選一;連結畫面那張卡不再搬進設定)
const mdl = (() => { const a = src.indexOf("const MDL = {"), b = src.indexOf("/* ── 設定 › 模型接入 的純邏輯到此"); if (a < 0 || b < 0) throw new Error("找不到純邏輯區塊"); return src.slice(a, b); })();
if (/\bdocument\b|\$\(|window\./.test(mdl.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""))) throw new Error("模型接入的純邏輯碰了 DOM");
eval(mdl.replace(/^const /gm, "var "));
const D = { claude: { installed: true, loggedIn: true }, codex: { installed: true, loggedIn: false } };
const shape = (o) => [o.kind, o.isCur, o.st && o.st.key, String(o.act)].join("|");
let M = mdlOptions(D, "claude", true);
ok("三個選項、選一個:Blave 有登入狀態與「切換」;用中的那一列沒有動作(列尾改放「使用中」)", M.length === 3 && shape(M[0]) === "blave|false|st.signedIn|cn.blave.switch" && shape(M[1]) === "claude|true|st.signedIn|null" && shape(M[2]) === "codex|false|st.notSignedIn|cn.signIn");
ok("沒登入 Blave、現在用的是本機 agent:那一列是「登入並切換」(不是「登入 Blave」)", mdlOptions(D, "claude", false)[0].act === "cn.blave.signinSwitch" && mdlOptions(D, null, false)[0].act === "cn.blave.btn" && mdlOptions(D, "claude", false)[0].st.key === "st.notSignedIn");
M = mdlOptions({ claude: { installed: false }, codex: { installed: false } }, "blave", true);
ok("用的是 Blave 的 AI:那一列 is-cur、沒有動作;沒裝的兩列沒有鈕", shape(M[0]) === "blave|true|st.signedIn|null" && shape(M[1]) === "claude|false|st.notFound|null" && shape(M[2]) === "codex|false|st.notFound|null");
M = mdlOptions(D, "claude", false, { login: "codex" });
ok("等待登入中:那一列變「取消等待」(這一頁每次重畫都是新節點,等待狀態要在資料裡);其餘鈕由 waiting 鎖住", M[2].act === "login.cancel" && /b\.disabled = waiting && o\.act !== "login\.cancel"/.test(src) && /if \(o\.act === "login\.cancel"\) return window\.blave\.cancelAgentLogin\(\)/.test(src));
ok("等待 OAuth 中:Blave 那一列變「取消」,等待結束會重畫(不然「取消」留在畫面上)", mdlOptions(D, "claude", false, { oauth: true })[0].act === "oauth.cancel" && /oauthPending = false;\n    b\.textContent = was;\n    waitChanged\(\);/.test(src));
M = mdlOptions(null, "claude", true);
ok("偵測中:兩列只換狀態字、不給動作(列數不變);Blave 那一列不受偵測影響", shape(M[1]) === "claude|false|cn.detecting|null" && shape(M[2]) === "codex|false|cn.detecting|null" && M[0].act === "cn.blave.switch");
ok("連結畫面那張卡不再搬進設定(兩邊各畫各的,共用的是底下的邏輯)", !/set-model"\)\.appendChild\(document\.querySelector\("\.cn-card"\)\)/.test(src) && !/\$\("cn-foot"\)\.before\(/.test(src) && /function mdlPaint\(\)/.test(src) && /id="set-model"[^>]*><\/div>/.test(html));
ok("登入 / 連結完重畫之後,焦點回同一列的鈕(兩個表面都靠 data-kind)", /if \(kind\) div\.dataset\.kind = kind;/.test(src) && /r\.dataset\.kind = o\.kind;/.test(src) && /host\(\)\.querySelector\('\[data-kind="' \+ kind \+ '"\] button'\)/.test(src));
ok("模型接入頁的小框鈕只亮這一頁(不動全站的 .pf-act);「使用中」= 灰填 + 加粗 + 列尾三個字", /#set-model \.pf-act\{[^}]*--ink-2/.test(css) && /\.cn-opt\.is-cur\{background:var\(--surface-muted\)\}/.test(css) && /\.cn-opt\.is-cur \.n\{font-weight:600\}/.test(css));
ok("字串:設定頁那一列是「Blave 的 AI」,連結畫面的動詞句「用 Blave 的 AI」照舊", /msgid "cn\.blave\.name"\nmsgstr "Blave 的 AI"/.test(PO2[0]) && /msgid "cn\.blave\.title"\nmsgstr "用 Blave 的 AI"/.test(PO2[0]) && /data-i18n="cn\.blave\.title"/.test(html));
ok("字串:本機那一組改成「這台電腦上的 agent」,群組小標「由 Blave 提供」", /msgid "cn\.local\.label"\nmsgstr "這台電腦上的 agent"/.test(PO2[0]) && /msgid "cn\.blave\.group"\nmsgstr "由 Blave 提供"/.test(PO2[0]));

// 重畫吃掉焦點 → Esc 關不掉設定(R3-1:「重新偵測」那一顆被銷毀時踩到)
ok("重新偵測那一組掛的是 data-kind(焦點還原查的就是它),不是 data-k", /g\.dataset\.kind = "redetect";/.test(src) && !/dataset\.k = /.test(fnSrc("mdlPaint")) && /querySelector\('\[data-kind="' \+ focusKind\.kind \+ '"\] button'\)/.test(src));
ok("設定裡重畫過的每一塊都過同一關:焦點掉到 BODY 或掉出 modal 就放回框內(不靠個別欄位名猜對)", /function setFocusGuard\(\) \{[\s\S]{0,400}a !== document\.body && \$\("set-modal"\)\.contains\(a\)/.test(src)
  && ["mdlPaint", "acctPaintAcct", "privPaint"].every((n) => /setFocusGuard\(\);\n\}/.test(fnSrc(n))));
// V4:等待狀態(oauthPending / planLoginBusy)是一件事、兩份 DOM。列舉:凡是改這兩個旗標的地方都要重畫兩個表面
// 每一個**指派點**(不是每一個函式)後面三行內要看到 waitChanged():同一支裡漏掉其中一次也要抓得到
const bare = src.replace(/^\s*\/\/.*$/gm, "");   // 註解掉的程式不算數
const sites = [...bare.matchAll(/^[^\n]*\b(?:oauthPending|planLoginBusy) = (?!false, |null)[^\n]*$/gm)].filter((m) => !/^let /.test(m[0].trim()));
const late = sites.filter((m) => !/waitChanged\(\)/.test(bare.slice(m.index, m.index + 400).split("\n").slice(0, 4).join("\n"))).map((m) => m[0].trim().slice(0, 40));
ok("改了等待旗標的每一處都重畫兩個表面(共 " + sites.length + " 處" + (late.length ? ";漏的:" + late.join(" / ") : "") + ")", sites.length >= 7 && late.length === 0 && /function waitChanged\(\) \{ mdlPaint\(\); acctPaintAcct\(\); \}/.test(bare));
ok("V4(a) 帳號那顆「取消」按得動:等待是別的表面開始的也取消得了(planLogin 在那種情況會靜默 return)", /if \(oauthPending && !planLoginBusy\) \{ window\.blave\.cancelOAuth\(\); return; \}/.test(src));
ok("V1 上一則不會活過下一次登入(離線登出那句只有 detect() 會清)", /^\s*setHint\(null\);/m.test(fnSrc("planLogin").replace(/^\s*\/\/.*$/gm, "")));
ok("V2 確認框 / 圖片放大開著時,焦點歸它們(不靠 inert 讓 focus\(\) 變 no-op)", /if \(!\$\("del-scrim"\)\.hidden \|\| !\$\("lb-scrim"\)\.hidden\) return;/.test(fnSrc("setFocusGuard")));
ok("模型接入那一頁畫得出共用的那一則(它是三個表面之一)", /if \(HINT\) \{ const p = el\("p", "cn-hint"\);/.test(fnSrc("mdlPaint")));

// 帳號頁的訊息格:一個 owner
ok("帳號頁有放訊息的地方,而且只由 acctPaintAcct 寫(planPaint 會頻繁叫它,不能有第二個寫入者)", /id="acct-hint"/.test(html) && (src.match(/\$\("acct-hint"\)|el\("acct-hint"\)/g) || []).length === 1 && /el\("acct-hint"\)/.test(fnSrc("acctPaintAcct")) && /\n  mdlPaint\(\);\n  acctPaintAcct\(\);\n/.test(fnSrc("setHint")));
ok("登出沒撤成那句、登入等待中那句都到得了帳號頁", /const msg = waiting \? \{ text: t\("pv\.w\.waiting"\) \} : HINT;/.test(src) && /setHint\(\{ text: t\("cn\.blave\.signOutLocalOnly"\) \}\)/.test(src));
hasToken = true; HINT = { text: "cn.blave.signOutLocalOnly" }; acctPaintAcct();
ok("登出沒撤成:那句話出現在帳號頁(登出鈕就住在這一頁,別處看不到)", $("acct-hint").textContent === "cn.blave.signOutLocalOnly" && $("acct-hint").hidden === false);
hasToken = false; planLoginBusy = true; acctPaintAcct();
ok("登入等待中:講「瀏覽器已開啟」(等待是當下的狀態,壓過上一則)", $("acct-hint").textContent === "pv.w.waiting");
planLoginBusy = false; HINT = null; acctPaintAcct();
ok("沒有訊息就收起來", $("acct-hint").hidden === true && $("acct-hint").textContent === "");
hasToken = true; cur = "blave"; acctPaintAcct();
ok("字串:acct.out.3 照定稿(不跟 acct.out.2「對話留在這台電腦」打架)", /msgid "acct\.out\.3"\nmsgstr "你現在用的是 Blave 的 AI，登出會回到選 AI 的畫面，要先選一個才能繼續用。"/.test(PO2[0]));
// 聊天欄捲動邊界:靜止沒有線,捲起來才浮一條
ok("捲動時才出現的那條線:兩層捲動都掛、以看得見的那一層為準;靜止沒有線", /\.chat-head\.is-scrolled \{ box-shadow: 0 1px 0 var\(--border-hairline\); \}/.test(css) && !/\.chat-head \{[^}]*box-shadow/.test(css)
  && /\$\("chat-scroll"\)\.addEventListener\("scroll", chatEdge\)/.test(src) && /\$\("cs-list"\)\.addEventListener\("scroll", chatEdge\)/.test(src) && /list\.hidden \? \$\("chat-scroll"\) : list/.test(src));
ok("搬家留下的死規則與舊註解清掉", !/\.set-pane \.cn-(card|sec)/.test(css) && !/把 \.cn-card 整個搬進來/.test(html));

// 頂列那條帶子:視窗頂是同一條標題帶,三段(側欄 ::before、中欄 .tb、右欄 .chat-head 與它收合後的漸層)必須同高——
// 以後改一處漏一處,這一則會紅。.tb 還要用負的 margin 把自己疊回那一條上,值也得跟著
const BAR = [["app.css .cn-bar/.ws-bar", /\.cn-bar, \.ws-bar \{[^}]*height: (\d+)px/, css], ["app.css .pane-strategies/.pane-main padding-top", /\.pane-strategies, \.pane-main \{ padding-top: (\d+)px/, css],
  ["app.css html.ws-sc .pane-strategies padding-top", /html\.ws-sc \.pane-strategies \{ width: 44px; padding: (\d+)px/, css], ["app.css .chat-head", /\.chat-head \{\s*flex: none; height: (\d+)px/, css],
  ["app.css .cn-mid padding-bottom", /\.cn-mid \{[^}]*padding-bottom: (\d+)px/, css], ["trade.css .tb height", /\.pane-main > \.tb \{\s*flex: none; height: (\d+)px/, trcss],
  ["trade.css .tb margin-top", /\.pane-main > \.tb \{\s*flex: none; height: \d+px; margin-top: -(\d+)px/, trcss], ["trade.css 側欄 ::before", /\.pane-strategies::before \{[^}]*height: (\d+)px/, trcss],
  ["trade.css .chat-strip 漸層(上)", /linear-gradient\(var\(--surface-muted\) (\d+)px/, trcss], ["trade.css .chat-strip 漸層(下)", /var\(--surface-card\) (\d+)px\)/, trcss]];
const bars = BAR.map(([name, re, text]) => { const m = text.match(re); return [name, m ? m[1] : "找不到"]; });
ok("頂列三段同高(" + [...new Set(bars.map((b) => b[1]))].join("/") + "):" + bars.filter((b) => b[1] !== "52").map((b) => b[0]).join() , bars.every((b) => b[1] === "52"));
ok("紅綠燈對到那條帶子的中線(帶子 52 → 中線 26 → 燈 y=19)", /trafficLightPosition: \{ x: 12, y: 19 \}/.test(fs.readFileSync(path.join(R, "..", "main.js"), "utf8")));
ok("不該跟著動的 44 還在:側欄細軌的寬、收合後的寬、選項列與分類鈕的熱區下限", /html\.ws-sc \.pane-strategies \{ width: 44px;/.test(css) && /off: 44/.test(src) && /\.cn-opt\{[^}]*min-height:44px/.test(css) && /\.cn-row \{[\s\S]{0,120}min-height: 44px;/.test(css));

// 頂列底線
ok("中欄頂列與聊天頭沒有底線;雲端那兩條 transparent 跟著退場(沒有線可以透明)", !/\.pane-main > \.tb \{[^}]*border-bottom/.test(trcss) && !/\.chat-head \{[^}]*border-bottom/.test(css) && !/border-bottom-color: transparent/.test(trcss.split("html\[data-env")[1] || ""));
ok("分頁列與欄界那幾條線留著", /\.main-tabs \{[^}]*border-bottom: 1px solid var\(--border-hairline\)/.test(trcss) && /\.modal-head \{[^}]*border-bottom/.test(css));
ok("CSS:舊的三條規則與 .set-up 樣式清掉", !/\.set-acct \.(lbl|mail|btn-quiet)|\.set-up-txt|\.set-up \.btn-quiet/.test(css));
ok("字標拿掉:DOM / CSS / 程式都沒有 .ws-brand 與 #ws-home;收合鈕上距 12", !/ws-brand|ws-home/.test(html + css + src) && /html\.ws-sc \.side-rail \{[^}]*padding-top: var\(--space-12\);/.test(css));
ok("分隔線:帳號那一塊、「關於」上面、AI 接入頁列間那三條拿掉;標題列下緣、左右欄直線、方案頁的腳留著", !/\.set-acct[^{]*\{[^}]*border-top/.test(css) && !/\.set-about \{[^}]*border-top/.test(css) && !/\.cn-row \+ \.cn-row/.test(css)
  && /\.modal-head \{[^}]*border-bottom/.test(css) && /\.set-cats\s*\{[^}]*border-right/.test(css) && /\.plan-foot\s*\{[^}]*border-top/.test(css));
// 設定 › 隱私
const PO = ["zh", "en"].map((l) => fs.readFileSync(path.join(__dirname, "..", "shell", "i18n", l + ".po"), "utf8"));
ok("隱私:分類排最後、開關是 role=switch + aria-checked、即時生效(切換後以主行程回的為準)", /data-set-cat="acct"[^>]*><\/button>\s*\n\s*(<!--[\s\S]*?-->\s*\n\s*)?<button[^>]*data-set-cat="priv"[^>]*><\/button>\s*\n\s*<\/nav>/.test(html)
  && /setAttribute\("role", "switch"\)/.test(fnSrc("privPaint")) && /aria-checked/.test(fnSrc("privPaint")) && /PRIV = \(await window\.blave\.telemetrySet\(want\)\) === true/.test(src));
ok("隱私:會收 4 條、不收 6 條(含「事件紀錄不含 IP 位址」原話);關掉後清單留著、標題與尾句換掉", /PRIV_COLLECT = \[("priv\.collect\.[1-4]",? ?){4}\]/.test(src) && /PRIV_NEVER = \[("priv\.never\.[1-6]",? ?){6}\]/.test(src)
  && /msgid "priv\.never\.6"\nmsgstr "事件紀錄不含 IP 位址"/.test(PO[0]) && /msgid "priv\.never\.6"\nmsgstr "Event records contain no IP address"/.test(PO[1])
  && /off \? t\("priv\.collect\.hOff"\) : t\("priv\.collect\.h"\)/.test(src) && /off \? t\("priv\.kept"\) : t\("priv\.fine"\)/.test(src));
{ /* 法遵入口(法遵稽核):app 裡本來連一個服務條款 / 隱私權政策的連結都沒有,而隱私權政策 §9.1 還叫人到
     設定 › 隱私 關遙測、拿安裝識別碼。隱私權政策放隱私那一頁、服務條款跟版本資訊放「關於」;兩個都外開瀏覽器、網址帶目前語言。
     **不加同意步驟、不擋畫面**(Wei 還沒決定任何接受流程) */
  const seen2 = []; const realOpen = window.blave.openExternal;
  window.blave.openExternal = (u) => { seen2.push(u); };
  // privPaint 真的跑一次(假 DOM 夠用:它只用 createElement / append / textContent)
  eval(src.match(/const PRIV_COLLECT = [^\n]*;/)[0].replace(/^const /, "var ")); eval(src.match(/const PRIV_NEVER = [^\n]*;/)[0].replace(/^const /, "var "));
  eval(src.match(/^const legalUrl = [^\n]*$/m)[0].replace(/^const /, "var "));
  var PRIV = true, PRIV_ID = "abc", privToggle = () => {}, srSay = () => {};
  eval(fnSrc("privPaint"));
  LANG = "zh"; privPaint();
  // privPaint 用 document.createElement 組節點,不經過 $():從 #set-priv 的子樹把那顆鈕找出來
  const findBtn = () => { const out = []; const walk = (n) => { if (!n || !n.children) return; n.children.forEach((c) => { if (c && typeof c === "object") { if (c.onclick && c.textContent === "legal.privacy") out.push(c); walk(c); } }); }; walk($("set-priv")); return out[0]; };
  const pl = findBtn();
  if (pl && pl.onclick) pl.onclick();
  ok("隱私那一頁有「隱私權政策」,點了外開 /disclaimer/zh/privacy_policy(不是寫死英文)", !!pl && seen2.join() === "https://blave.org/disclaimer/zh/privacy_policy");
  LANG = "en"; privPaint(); { const b2 = findBtn(); if (b2 && b2.onclick) b2.onclick(); }
  ok("換語言之後網址跟著換", seen2[1] === "https://blave.org/disclaimer/en/privacy_policy");
  ok("「關於」那一塊有服務條款,點了外開 /disclaimer/<lang>/terms_of_service;走既有的 openExternal,沒有自己另開一套",
    /<p class="set-legal"><button type="button" class="btn-quiet" id="set-terms" data-i18n="legal\.terms"><\/button><\/p>/.test(html)
    && /\$\("set-terms"\)\.addEventListener\("click", \(\) => window\.blave\.openExternal\(legalUrl\("terms_of_service"\)\)\);/.test(src)
    && /const legalUrl = \(page\) => "https:\/\/blave\.org\/disclaimer\/" \+ LANG \+ "\/" \+ page;/.test(src)
    && /\.set-legal \{ margin: var\(--space-16\) 0 0; \}/.test(css));
  ok("兩個字都在(zh / en)", /msgid "legal\.terms"\nmsgstr "服務條款"/.test(PO[0]) && /msgid "legal\.terms"\nmsgstr "Terms of Service"/.test(PO[1])
    && /msgid "legal\.privacy"\nmsgstr "隱私權政策"/.test(PO[0]) && /msgid "legal\.privacy"\nmsgstr "Privacy Policy"/.test(PO[1]));
  ok("**沒有**同意步驟 / 擋畫面:沒有 accept / agree / consent 那一類的閘門", !/legal\.(accept|agree|consent)|acceptTerms|consentGate/.test(src + html + PO[0] + PO[1]));
  // 署名從 NOTICE 讀出來再去 LICENSE 找,不寫死字串:法人名稱改了(2026-09-23 從
  // 「Blave」改成正式公司名)時,兩個檔一起改才會綠,只改一邊就紅——寫死的話
  // 只會變成「改名字就要順手改測試」,守不到「兩份不一致」這件事
  { const lic = fs.readFileSync(path.join(__dirname, "..", "LICENSE"), "utf8");
    const notice = fs.readFileSync(path.join(__dirname, "..", "NOTICE"), "utf8");
    const m = notice.match(/^Copyright .+$/m);
    ok("LICENSE 的 Apache 樣板佔位已經填成 repo 自己的署名(同 NOTICE)",
      !!m && lic.includes("\n   " + m[0] + "\n") && !/\[yyyy\]|\[name of copyright owner\]/.test(lic)); }
  window.blave.openExternal = realOpen; LANG = "zh"; }
ok("隱私:會收那一條寫到 macOS 版本與系統語言;七個事件逐項對得上契約的白名單", /macOS 版本、系統語言/.test(PO[0]) && Object.keys(require("../shell/telemetry.js").EVENTS).length === 7 && /首次開啟、每日開啟、完成連結（哪一種 AI）、登入、第一次回測、啟動下單（模擬或真錢）、上雲端運行/.test(PO[0]));
ok("全 app 的字串不出現「匿名 / anonymous」;首次告知的 priv.notice* 沒有建", PO.every((x) => !/匿名|anonym/i.test(x.replace(/^#.*$/gm, ""))) && PO.every((x) => !/priv\.notice/.test(x)) && !/telemetryNoticed/.test(src));
// 設定 › 資料與雲端方案 › 主機運行中那格:主鈕是「切到雲端」(關設定 + 走切換器同一個守門入口),不再外開網頁(Wei:不用前往工作頁了)
{
  const node = () => { const n = el(); n.dataset = {}; n.querySelectorAll = () => []; n.contains = () => false; n.firstChild = null;
    n.addEventListener = (_ev, fn) => { n._on = fn; }; n._click = () => n._on && n._on({ currentTarget: n }); return n; };
  dom["set-plan"] = node(); document.createElement = node;
  const seen = [];
  window.blave.openExternal = (u) => { seen.push("ext:" + u); };
  const setClose = () => { seen.push("close"); }, envSwitchGuarded = (e) => { seen.push("env:" + e); return true; };
  let acct = { plan: { state: "running" } }, acctPending = 0, planBusy = false, planSince = 0, planSlowSaid = false, planErr = null, planLastView = null, planMoreOpen = false;
  const PLAN_SLOW_MS = 1e9, srSay = () => {}, planAsk = () => {}, planLogin = () => {}, acctCheck = () => {}, acctUrl = () => "acct", planWebUrl = () => "https://blave.org/agent/zh", planState = () => acct.plan.state;
  const planVars = () => ({ p: "", h: "", m: "", a: "", b: "", v: "", t: "", q: "", top: "", d: "", n: 0, name: "Claude Code" });
  const envPlanChanged = undefined;
  hasToken = true; cur = "claude";
  eval(fnSrc("planView")); eval(src.match(/^function planToCloud\(\).*$/m)[0]); eval(fnSrc("planPaint"));
  const paintPlan = () => { planPaint(); const foot = dom["set-plan"].children[1], act = foot.children[foot.children.length - 1]; return act.children; };
  let acts = paintPlan();
  ok("running:兩顆鈕 = 「前往網頁停用」+「切到雲端」(plan.switchCloud);不再有「前往工作頁」", acts.map((b) => b.textContent).join() === "plan.manage,plan.switchCloud" && acts[1].className === "btn-out" && acts[1].disabled === false);
  acts[1]._click();
  ok("按「切到雲端」:先關設定、再走 envSwitchGuarded(\"cloud\");沒有 openExternal", seen.join() === "close,env:cloud");
  seen.length = 0; acts[0]._click();
  ok("「前往網頁停用」照舊外開網頁", seen.join() === "ext:https://blave.org/agent/zh");
  ok("planToCloud 就是那兩個呼叫,沒有第二套切換邏輯", /^function planToCloud\(\) \{ setClose\(\); envSwitchGuarded\("cloud"\); \}$/m.test(src) && !/plan\.openWs/.test(fnSrc("planPaint")));
  // 其他三格不動:starting 沒有切換鈕;stopped 仍是「前往網頁管理」+「前往儲值」
  acct = { plan: { state: "stopped" } }; seen.length = 0; acts = paintPlan();
  ok("stopped 格照舊:前往網頁管理 + 前往儲值,兩顆都外開", acts.map((b) => b.textContent).join() === "plan.manageStopped,plan.addCredit" && (acts[0]._click(), acts[1]._click(), seen.join() === "ext:https://blave.org/agent/zh,ext:acct"));
  acct = { plan: { state: "starting" } }; acts = paintPlan();
  ok("starting 格照舊:一顆灰掉的「啟動中…」", acts.map((b) => b.textContent).join() === "plan.starting" && acts[0].disabled === true);
  // 內文講切換器、標題不動。哪些事歸給網頁工作頁、哪些不可以再歸給它——那條規則由 check_shell_strings.js 守,這裡只守「內文確實在講切換器」。
  ok("內文改講切換器,標題不動(zh / en)", /msgid "pv\.d\.running"\nmsgstr "切到頂列的「雲端」，[^\n]*工作頁/.test(PO[0])
    && /msgid "pv\.d\.running"\nmsgstr "Switch to “Cloud” in the top bar[^\n]*(web workspace|workspace on the web)/.test(PO[1]) && /msgid "pv\.h\.running"\nmsgstr "策略可以在雲端主機上線了"/.test(PO[0])
    && /msgid "plan\.switchCloud"\nmsgstr "切到雲端"/.test(PO[0]) && /msgid "plan\.switchCloud"\nmsgstr "Switch to cloud"/.test(PO[1]));
}
})().then(() => {
console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
});
