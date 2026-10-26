// 回合中的鎖第一期(設計 spec busy-lock-2026-10;renderer/busy.js)。跑法:node tests/check_shell_busy_lock.js(不開 Electron)
//   ① 列舉:renderer 每一個看回合狀態(全域 running)就 return 的守門,都要有可見回饋;沒有回饋的只准在 QUIET 那幾處(各寫為什麼不是用戶點得到的路)
//   ② 放開的(設定、模型、登出、登入、資料來源鈕、對話清單鈕)原文裡不再看 running;留下的鎖不用原生 disabled、✕ 照畫
//   ③ busy.js 在假 DOM 跑:原因句＋補救連結、停止 / 查看、埋點名、回合結束收掉、借用的原因行也收
//   ④ 主行程 deleteSession:回合中只拒刪正在回覆的那條
const fs = require("fs"), path = require("path");
const SH = path.join(__dirname, "..", "shell"), R = path.join(SH, "renderer");
const read = (p) => fs.readFileSync(p, "utf8");
const appSrc = read(path.join(R, "app.js")), busySrc = read(path.join(R, "busy.js")), mainSrc = read(path.join(SH, "main.js")), trSrc = read(path.join(R, "trade.js"));
const pend = []; const await_ = (f) => pend.push(new Promise((r) => setImmediate(r)).then(f));
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + JSON.stringify(d).slice(0, 600))); if (!c) red++; };
function fnSrc(src, name) {
  let a = src.indexOf("function " + name + "("); if (a < 0) throw new Error("找不到 " + name);
  if (src.slice(a - 6, a) === "async ") a -= 6;
  let i = src.indexOf("{", src.indexOf(")", a)), depth = 0;
  for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}" && --depth === 0) break; }
  return src.slice(a, i + 1);
}

// ── ① 列舉守門 ──
// 看回合狀態(全域 running,或包它的 runningNow() / upLocalTurn() / busyOn() / xpDisabled() / opts.busy)且同一行 return 的地方
const TURN = String.raw`(?:(?<![.\w"'])running(?![\w"':])|runningNow\(\)|upLocalTurn\(\)|busyOn\(\)|xpDisabled\(\)|opts\.busy\b)`;
const GUARD = new RegExp(TURN + String.raw`[^\n]*\breturn\b|\breturn\b[^\n]*` + TURN);
const FEEDBACK = /busyTell|busyCut\(|busySendTell|busyHit|taWaitShow|xpNote|tvSet\(|CAP\.msg = \{ code: "TURN_BUSY"|stopTurn\(\)|rpcOwed = true/;
// 不是「用戶點了」的路,或回饋在呼叫端:各自寫為什麼
const QUIET = [
  ["app.js", "if (!running || turnStopping) return;", "stopTurn 自己:沒回合可停"],
  ["app.js", "if ((!msg && !attachments.length) || running) return;", "sendDraft:送出鍵回合中是停止(btn-send 分流),Enter 那條先講了原因"],
  ["app.js", "if ((!msg && !attachments.length) || running) return false;", "submitMessage 最後一道:每個入口自己先講"],
  ["app.js", "function upLocalTurn()", "只是讀值"],
  ["app.js", "if (busyOn()) return;", "csStartNew / csOpen 最後一道:入口(csNewClick、列的 click)先講"],
  ["app.js", "if (!id || id === sessionId || busyOn()) return;", "點了回合結束的系統通知(open-session):回合中只叫出視窗、不換對話(spec agent-reply-notifications-0130 §3.5),畫面上沒有按了沒反應的控件"],
  ["app.js", "if (running === true) { swHeld = { from, to }; return; }", "切視角的系統行延到回合結束才插,不是擋操作(切視角本身照切)"],
  ["app.js", "function canResend() { return !running", "述詞;重送的鈕先看 running、走 busySendTell"],
  ["capital.js", "return capHandoff(\"setup\");", "capHandoff 自己寫 TURN_BUSY 進框裡的訊息槽"],
  ["library.js", "if (typeof running !== \"undefined\" && running) return;", "libAsk:回合中 CTA 是 busy 態(libBusyTell 講),走不到這裡"],
  ["versions.js", "if (!S.data || S.open === null || running) return;", "verRestoreAsk:ver-restore 的 click 先看 aria-disabled、講原因"],
  ["versions.js", "if (!pd || pd.status !== \"failed\" || running) return false;", "verRetry:ver-retry 的 click 先看 aria-disabled、講原因"],
  ["suggest.js", "if (running) return;", "建議灰字停一拍之間又開了一輪,這句已經過期;不是點擊守門"],
  ["suggest.js", "return !!SUG.text && !SUG.used && !SUG.gone && !running", "述詞:托盤在不在場(回合中不畫),不是點擊守門"],
  ["engine.js", "&& running) { window.blave.ensureEngine()", "安裝重試照跑(進度卡就是回饋),等著的那句留到回合結束"],
  ["trade.js", "return running ? \"ct.errUpdate\"", "trCtErrKey 的參數叫 running(下單程式在跑),跟回合無關"],
  ["perf.js", "b.setAttribute(\"aria-disabled\", \"true\"); b.title = t(\"busy.perf\"); return;", "perfBusy 畫鎖態,不是點擊"],
  ["portfolio.js", "if (!running && !mgBacktest()", "畫面組字(running 是本地變數)"],
  ["busy.js", "", "鎖本身"],
  ["app.js", "if (upLocalTurn()) return;", "upInstall:兩個入口(ws-update、set-up-btn)先看 busyLocked、講原因"],
  ["export.js", "if (!XP_PLATFORM[target] || xpDisabled() ||", "xpAsk:入口 xpOpen 與 again 鈕先講原因(xpNote)"],
  ["report-robust.js", "const isSent = (st, opts) =>", "「已送出」態的述詞,不是點擊守門"],
  ["report-wf.js", "if (s.pending) return !!opts.busy;", "「已送出」態的述詞"],
  ["report-wf.js", "if (opts.busy && s.turn === opts.turn) return true;", "「已送出」態的述詞"],
  ["report-wf.js", "opts.scope !== \"cloud\" || (opts.busy && s.turn === opts.turn)) return null;", "雲端樣本外驗證的計時述詞"],
  ["report-wf.js", "if (!s || s.pending || (opts.busy && s.turn === opts.turn)) return false;", "「已送出」態的述詞"],
];
const hits = [];
for (const f of fs.readdirSync(R).filter((n) => /\.js$/.test(n) && n !== "strings.js")) {
  read(path.join(R, f)).split("\n").forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, "");
    if (!GUARD.test(code)) return;
    if (/function \w+\([^)]*\brunning\b/.test(code) || /\(err, running\)|ctx\.running|c\.running|sup\.running|\bbusy: running\b|\brunning: typeof running\b|\blocalTurn: upLocalTurn\(\)/.test(code)) return;   // 參數 / 欄位叫 running、把狀態交給模組(它們自己畫原因)
    if (FEEDBACK.test(code)) return;
    if (QUIET.some(([qf, s]) => qf === f && (s === "" || code.includes(s)))) return;
    hits.push(f + ":" + (i + 1) + "  " + code.trim().slice(0, 140));
  });
}
ok("① 列舉:每一個回合中 return 的守門都有可見回饋(busyTell / busySendTell / 既有原因行),例外只在 QUIET 名單", hits.length === 0, hits);
hits.forEach((h) => console.log("      " + h));
const silentQuiet = QUIET.filter(([qf, s]) => s && !read(path.join(R, qf)).includes(s)).map((q) => q.slice(0, 2).join(" "));
ok("① QUIET 名單每一條都還在原文裡(拿掉了就從名單刪,不留空條目)", silentQuiet.length === 0, silentQuiet);

// ── ② 放開 / 留下 ──
const released = ["setOpen", "mpOpen", "acctOutAsk", "acctSignOut", "planLogin", "planSignIn"].filter((n) => /(?<![.\w"'])running(?![\w"'])/.test(fnSrc(appSrc, n).replace(/\/\/.*$/gm, "")));
ok("② 放開(spec §2.3):設定、模型、登出、登入不再看 running", released.length === 0, released);
ok("② 換 AI / 登出:回合中走確認框、先停再做(busyCut / busyStopThen),不是靜默擋",
  /if \(busyOn\(\)\) \{ busyCut\(null, \(\) => connectNow\(kind, info\)\); return; \}/.test(fnSrc(appSrc, "connect")) && /busyCut\(b, \(\) => blaveGoNow\(b\)\)/.test(fnSrc(appSrc, "blaveGo"))
  && !/busyOn\(\)/.test(fnSrc(appSrc, "connectNow")) && !/busyOn\(\)/.test(fnSrc(appSrc, "blaveGoNow"))
  && /onOk: \(\) => busyStopThen\(acctSignOut\)/.test(fnSrc(appSrc, "acctOutAsk")) && /busyOn\(\) \? \[t\("busy\.cut\.out"\)\]/.test(fnSrc(appSrc, "acctOutAsk"))
  && /if \(!hasToken \|\| oauthPending \|\| planLoginBusy \|\| acctOutBusy\) return;\n  acctOutBusy = true;\n  const r = await window\.blave\.signOutBlave\(\)\.finally\(\(\) => \{ acctOutBusy = false; \}\);/.test(fnSrc(appSrc, "acctSignOut")));
{ const ak = read(path.join(R, "apikey.js")), ask = fnSrc(ak, "akRemoveAsk");
  ok("② 回合中移除正在用的自帶金鑰:確認框先講會停、按下走 busyStopThen(akRemove)", /const cut = cur === "apikey" && busyOn\(\);/.test(ask) && /cut \? \[t\("busy\.cut\.out"\)\] : \[\]/.test(ask) && /onOk: cut \? \(\) => busyStopThen\(akRemove\) : akRemove/.test(ask)); }
const natives = [];
for (const f of fs.readdirSync(R).filter((n) => /\.js$/.test(n))) {
  const src = read(path.join(R, f));
  for (const m of src.matchAll(/[^\n]*\.disabled = [^;\n]*(\brunning\b|runningNow\(\)|upLocalTurn\(\)|busyOn\(\)|opts\.busy)[^\n]*/g)) {
    // 已知例外(spec §1-2 偏差,待拍板):參數掃描鈕回合中原生 disabled,原因句 rob.busy 常駐在鈕下(不是點了沒反應)
    if (f === "report-robust.js" && /st\.btn\.disabled = !!opts\.busy;/.test(m[0])) continue;
    natives.push(f + ": " + m[0].trim().slice(0, 120));
  }
  for (const m of src.matchAll(/\$\("(ws-conn|mp-trigger|cs-toggle|cs-new|cs-newrow)"\)\.disabled = /g)) natives.push(f + ": " + m[0]);
}
ok("② 沒有任何控件因為回合而用原生 disabled(鈕不消失、可聚焦);設定入口、模型、對話清單鈕不再停用", natives.length === 0, natives);
ok("② 雲端策略列 ✕ 回合中照畫(canDel 不看 running),畫出來就套鎖", /const canDel = kind === "running";/.test(fnSrc(trSrc, "envPaintSide")) && /busyLock\(d, busyOn\(\)\)/.test(fnSrc(trSrc, "envPaintSide")));
ok("② 對話清單:切換別條、新對話、刪回覆中這條都是鎖＋原因;刪別條不鎖",
  /else if \(busyOn\(\)\) busyTell\(csWhy\(\), "switch"\)/.test(fnSrc(appSrc, "csRow")) && /if \(m\.id === sessionId\) \{ busyLock\(del, busyOn\(\)\); del\.onBusy = \(\) => busyTell\(csWhy\(\), "chatDel"\); \}/.test(fnSrc(appSrc, "csRow"))
  && /busyTell\(csWhy\(\), "new"\)/.test(fnSrc(appSrc, "csNewClick")) && /\$\("cs-new"\)\.addEventListener\("click", csNewClick\);/.test(appSrc) && /\$\("cs-newrow"\)\.addEventListener\("click", csNewClick\);/.test(appSrc));
ok("② 更新三顆(重新啟動以完成更新 × 2、更新雲端主機):回合中 aria-disabled、點了講原因", /busyTell\(busySlot\("ws-up-why", w\), "update"\)/.test(appSrc) && /busyTell\(busySlot\("set-up-why", b\.parentNode\), "update"\)/.test(appSrc)
  && /if \(upLocalTurn\(\)\) \{ busyTell\(busySlot\("upc-why"/.test(fnSrc(appSrc, "upCloudUpdate")) && /busyLock\(btn, upBusy\)/.test(fnSrc(appSrc, "upPaint")) && /busyLock\(cbtn, cBusy\)/.test(fnSrc(appSrc, "upPaint")));
const flips = appSrc.split("\n").filter((l) => /(^\s*|[;{]\s*)running = (true|false);/.test(l) && !/^let running/.test(l));
ok("② 每一個改 running 的地方都叫 busySync(鎖態與原因句跟著回合走)", flips.length >= 3 && flips.every((l) => /busySync\(\)/.test(l)), flips.filter((l) => !/busySync\(\)/.test(l)).map((l) => l.trim().slice(0, 80)));

// ── ③ busy.js 在假 DOM 跑 ──
class El {
  constructor(tag) { this.tag = tag; this.kids = []; this.attrs = {}; this.dataset = {}; this.on = {}; this.hidden = false; this.parentNode = null; this._t = ""; this.className = ""; this.id = ""; }
  get textContent() { return this._t + this.kids.map((k) => (typeof k === "string" ? k : k.textContent)).join(""); }
  set textContent(v) { this._t = String(v); this.kids = []; }
  get isConnected() { let x = this; while (x.parentNode) x = x.parentNode; return x === root; }
  get nextSibling() { const p = this.parentNode; if (!p) return null; const i = p.kids.indexOf(this); return p.kids[i + 1] || null; }
  setAttribute(k, v) { this.attrs[k] = String(v); } removeAttribute(k) { delete this.attrs[k]; } getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  append(...c) { c.forEach((x) => this.appendChild(x)); }
  appendChild(c) { if (typeof c === "string") { this.kids.push(c); return c; } if (c.parentNode) c.parentNode.kids = c.parentNode.kids.filter((x) => x !== c); c.parentNode = this; this.kids.push(c); return c; }
  insertBefore(c, ref) { if (c.parentNode) c.parentNode.kids = c.parentNode.kids.filter((x) => x !== c); c.parentNode = this; const i = ref ? this.kids.indexOf(ref) : -1; if (i < 0) this.kids.push(c); else this.kids.splice(i, 0, c); return c; }
  addEventListener(ev, fn) { (this.on[ev] = this.on[ev] || []).push(fn); } click() { (this.on.click || []).forEach((f) => f({})); } focus() { calls.push("focus:" + this.id); }
  querySelector(sel) { const c = sel.replace(/^\./, ""); return this.all().find((x) => (" " + x.className + " ").includes(" " + c + " ")) || null; }
  all() { const out = []; const walk = (x) => x.kids.forEach((k) => { if (typeof k !== "string") { out.push(k); walk(k); } }); walk(this); return out; }
}
const root = new El("body"), byId = {};
const doc = { createElement: (tag) => new El(tag), getElementById: (id) => root.all().find((x) => x.id === id) || null,
  querySelectorAll: (sel) => (sel === "[data-busy]" ? root.all().filter((x) => "busy" in x.dataset) : sel === "#cs-rows .cs-item" ? root.all().filter((x) => x.className === "cs-item") : []), querySelector: () => null };
const $ = (id) => byId[id] || (byId[id] = root.appendChild(Object.assign(new El("div"), { id })));
const STR = new Function(read(path.join(R, "strings.js")) + "\nreturn STRINGS;")();
const tracked = [], calls = [];
const env = { document: doc, $, t: (k) => STR.zh[k] || "<" + k + ">", running: true, trackFeature: (n) => tracked.push(n), stopTurn: () => calls.push("stop"), taWaitShow: () => calls.push("ta"),
  setClose: () => calls.push("setClose"), csShowList: (on) => calls.push("list:" + on), paneSt: { chat: { off: true } }, paneToggle: (k, off) => calls.push("pane:" + k + ":" + off), scrollChat: () => calls.push("scroll"),
  confirmBox: (o) => calls.push(o) };
const timers = [];
env.setTimeout = (f, ms) => { timers.push({ f, ms, live: true }); return timers.length; };
env.clearTimeout = (i) => { if (timers[i - 1]) timers[i - 1].live = false; };
doc.activeElement = null; doc.body = root;
// busyOn 讀 S.running(S = env):讓測試切回合狀態
const mkBusy = (extra) => new Function("S", ...Object.keys(env), (extra || "") + busySrc.replace(/function busyOn\(\) \{[^\n]*\}/, "function busyOn() { return S.running === true; }")
  + "\nreturn { BUSY, BUSY_FEATURE, busyTell, busyFixLink, busySlot, busySync, busyStopThen, busyCut, busyHit, busySendTell, busyOn, get pending() { return BUSY_PENDING; } };")(env, ...Object.values(env));
const B = mkBusy();
const head = $("cs-head");
const slot = B.busySlot("cs-why", head);
B.busyTell(slot, "chatDel");
const fix = slot.kids.find((k) => typeof k !== "string" && k.tag === "button");
ok("③ 原因句:槽在 anchor 正後面、role=status + aria-live=polite、字 = busy.chatDel、跟一顆「停止」;記 lock_chat_del",
  head.nextSibling === slot && slot.attrs.role === "status" && slot.attrs["aria-live"] === "polite" && !slot.hidden && slot.kids[0].textContent === STR.zh["busy.chatDel"]
  && fix && fix.textContent === STR.zh["busy.fix.stop"] && fix.className.includes("btn-quiet") && tracked.join() === "lock_chat_del", { k: slot.textContent, tracked });
fix.click();
ok("③ 按「停止」:停那條回合、記 lock_fix", calls.includes("stop") && tracked.join() === "lock_chat_del,lock_fix");
B.busyTell(slot, "switch");
ok("③ 一個容器一個槽:新的一句取代舊的(只剩一顆補救)", slot.kids[0].textContent === STR.zh["busy.switch"] && slot.kids.filter((k) => typeof k !== "string" && k.tag === "button").length === 1);
$("set-scrim").hidden = false; $("cs-list").hidden = false; calls.length = 0;
B.busyTell(B.busySlot("perf-why", $("x")), "perf");
{ const perfSlot = B.busySlot("perf-why", $("x")), cap = new El("p"); $("x").appendChild(cap); cap.textContent = "x";
  ok("③ 稽核 0127b1 P1-5:同一畫面只留一句——別的槽寫新句時,上一句(cs-why)收掉", slot.hidden && slot.textContent === "" && !("busy" in slot.dataset) && !perfSlot.hidden && perfSlot.dataset.busy === "1");
  B.busyFixLink(cap, "stop");
  ok("③ P1-5:各頁自己的原因句(掃描／驗證／轉出…經 busyFixLink 掛〔停止〕)也算一句:收掉別處的、自己記 data-busy", perfSlot.hidden && cap.dataset.busy === "1");
  B.busyTell(perfSlot, "perf"); }
ok("③ P1-5:轉出那一行換成別的原因(時光機)時先拿掉 data-busy,回合結束不會把它一起收", /function xpNote\(text\) \{ const n = \$\("xp-note"\); if \(!n\) return; delete n\.dataset\.busy;/.test(read(path.join(R, "export.js"))));
B.busySlot("perf-why", $("x")).kids.find((k) => typeof k !== "string" && k.tag === "button").click();
ok("③ 按「查看」:關設定、收清單、展開聊天欄、捲到底、焦點回輸入框;記 lock_fix", calls.join() === "setClose,list:false,pane:chat:false,scroll,focus:ta" && tracked.slice(-2).join() === "lock_perf,lock_fix", calls);
const want = { update: "lock_update", perf: "lock_perf", rerun: "lock_perf", restore: "lock_restore", del: "lock_del", chatDel: "lock_chat_del", switch: "lock_switch", new: "lock_switch", cloudUpd: "lock_send", send: "lock_send", sendAway: "lock_send" };
const FEATURES = require(path.join(SH, "telemetry.js")).EVENTS.feature_used.name;
ok("③ 每一把鎖都有字(zh / en)、都對到 spec §4 的埋點名,名字都在白名單上;刪策略(del)只記埋點、沒有字(Wei 10-24)",
  JSON.stringify(Object.keys(B.BUSY).sort()) === JSON.stringify(Object.keys(want).filter((k) => k !== "del").sort()) && Object.keys(want).every((k) => B.BUSY_FEATURE[k] === want[k] && (k === "del" || (STR.zh[B.BUSY[k].key] && STR.en[B.BUSY[k].key])))
  && !("busy.del" in STR.zh) && !("busy.del" in STR.en)
  && ["lock_update", "lock_perf", "lock_chat_del", "lock_switch", "lock_send", "lock_fix", "lock_restore", "lock_del"].every((n) => FEATURES.includes(n)));
const borrowed = $("rp-ho-note"); B.busyTell(borrowed, "send");
const before = !borrowed.hidden && borrowed.textContent === STR.zh["turn.busy"];
env.running = false; B.busySync();
ok("③ 回合結束(busySync):所有原因句收掉,借用的原因行(#rp-ho-note)也收", before && slot.hidden && slot.textContent === "" && borrowed.hidden && borrowed.textContent === "" && !("busy" in borrowed.dataset));
{ // 先停再做:單一待辦槽、停止中、回合一結束當場做、逾時不做
  const fire = () => timers.filter((x) => x.live).forEach((x) => { x.live = false; x.f(); });
  calls.length = 0; let did = []; env.running = false; B.busyCut(null, () => did.push("a"));
  ok("③ 沒有回合:換 AI 直接做、不開框", did.join() === "a" && calls.length === 0);
  env.running = true; const btn = Object.assign(new El("button"), { id: "out" }); $("plan-row").appendChild(btn);
  $("set-scrim").hidden = true; env.paneSt.chat.off = false;
  B.busyCut(btn, () => did.push("b"));
  const box = calls.find((x) => x && typeof x === "object");
  ok("③ 回合中換 AI:先開框(標題一句、內文 busy.cut.out,不重複),還沒按不停也不做", did.join() === "a" && box && box.title === STR.zh["busy.cut.title"] && box.lines.join() === STR.zh["busy.cut.out"] && box.ok === STR.zh["busy.cut.ok"] && !calls.includes("stop"));
  box.onOk();
  const why = doc.getElementById("busy-cut-why");
  ok("③ 按下確認:叫停止、「停止中…」寫在不會被重畫的聊天標題列下方(設定關著)、還沒做", calls.includes("stop") && did.join() === "a" && why && !why.hidden && why.textContent === STR.zh["busy.stopping"] && $("cs-head").nextSibling === why && !!B.pending);
  B.busyStopThen(() => did.push("c"));
  ok("③ 單一待辦:又排一件,取代上一件(不疊)、舊的計時作廢", B.pending && timers.filter((x) => x.live).length === 1);
  env.running = false; B.busySync();
  ok("③ 回合一結束(busySync)當場做,而且只做最後那一件;停止中那行收掉", did.join() === "a,c" && !B.pending && why.hidden && timers.filter((x) => x.live).length === 0);
  // 設定開著:槽在設定標題列下方;等待中整頁重畫把槽拆掉、又把設定關了 → 逾時那句重新取槽,寫到看得見的聊天標題列下方(聊天欄收著先展開)
  const sm = $("set-modal"), mh = Object.assign(new El("div"), { className: "modal-head" }); sm.appendChild(mh); $("set-scrim").hidden = false;
  env.running = true; B.busyStopThen(() => did.push("d"));
  const inSet = doc.getElementById("busy-cut-why"), atSet = mh.nextSibling === inSet && inSet.textContent === STR.zh["busy.stopping"];
  inSet.parentNode.kids = inSet.parentNode.kids.filter((x) => x !== inSet); inSet.parentNode = null;
  $("set-scrim").hidden = true; env.paneSt.chat.off = true; calls.length = 0; fire();
  const why2 = doc.getElementById("busy-cut-why"), fx = why2 && why2.kids.find((k) => typeof k !== "string" && k.tag === "button");
  ok("③ 設定開著時「停止中…」在設定標題列下方;逾時重新取槽(舊節點被拆了也寫得出來)、寫到聊天標題列下方,聊天欄收著也不動版面",
    atSet && why2 && why2.isConnected && $("cs-head").nextSibling === why2 && !calls.includes("pane:chat:false"), { atSet, calls });
  ok("③ 20 秒還沒停:不做(確認框說了會先停),講「沒停下來」並留「停止」可再按", did.join() === "a,c" && !B.pending && !why2.hidden && why2.kids[0].textContent === STR.zh["busy.stopFail"] && fx && fx.textContent === STR.zh["busy.fix.stop"]);
  env.paneSt.chat.off = true; calls.length = 0; B.busySendTell();
  ok("③ 送一句話被擋、聊天欄收著:先展開聊天欄再寫輸入框上方那一句", calls.join() === "pane:chat:false,ta", calls);
  env.running = false; B.busySync();
  ok("③ 逾時那件之後回合才結束:也不補做", did.join() === "a,c");
}
{ // M1 回歸:真的 connect / connectNow(會再進守門的那支)接真的 busy.js——逾時後不可以自己又跳框、也不可以換
  calls.length = 0; timers.length = 0; env.running = true;
  const saved = [], ws = [];
  const C = new Function("S", "B", "saved", "ws", `const busyOn = B.busyOn, busyCut = B.busyCut, window = { blave: { saveConnection: async (c) => { saved.push(c.kind); return true; } } };
    const detect = () => {}, trackEvent = () => {}, enterWorkspace = (k) => ws.push(k); let cur = null;
    ${fnSrc(appSrc, "connect")}\n${fnSrc(appSrc, "connectNow")}\nreturn { connect };`)(env, B, saved, ws);
  C.connect("codex", { path: "/x" });
  const boxes = () => calls.filter((x) => x && typeof x === "object");
  boxes()[0].onOk(); timers.filter((x) => x.live).forEach((x) => { x.live = false; x.f(); });
  await_(() => {
    ok("③ M1:換 AI 停不下來逾時 → 不再跳第二個確認框、不換", boxes().length === 1 && saved.length === 0 && ws.length === 0, { boxes: boxes().length, saved });
    calls.length = 0; C.connect("codex", { path: "/x" }); boxes()[0].onOk(); env.running = false; B.busySync();
    await_(() => ok("③ M1:回合收掉 → 直接換(connectNow,不再過守門、不再開框)", boxes().length === 1 && saved.join() === "codex" && ws.join() === "codex", { boxes: boxes().length, saved, ws }));
  });
}

// ── ④ 主行程 deleteSession ──
{
  const deletes = []; let failMeta = false;
  const M = new Function("fs", "path", "okSessionId", "sessionDb", "IMG_DIR", "RES_DIR", "META_DIR", "BASE", "XP_DIR", `
    let activeTurn = null, turnStarting = false, turnSessionId = null;
    ${fnSrc(mainSrc, "deleteSession")}
    return { deleteSession, set: (a, s, id) => { activeTurn = a; turnStarting = s; turnSessionId = id; } };`)(
    { rmSync: () => {} }, path, (id) => /^desktop-[a-z0-9]{4,16}$/.test(id),
    () => ({ exec: (q) => deletes.push(q), prepare: (q) => ({ run: (id) => { if (failMeta && /session_meta/.test(q)) throw new Error("SQLITE_BUSY"); deletes.push(q.split(" ")[2] + ":" + id); } }), close: () => {} }), "/i", "/r", "/m", "/b", "/x");
  M.set({}, false, "desktop-aaaa1111");
  const busyCur = M.deleteSession("desktop-aaaa1111"), busyOther = M.deleteSession("desktop-bbbb2222");
  M.set(null, true, "desktop-aaaa1111"); const starting = M.deleteSession("desktop-aaaa1111");
  M.set(null, false, "desktop-aaaa1111"); const idle = M.deleteSession("desktop-aaaa1111");
  ok("④ deleteSession:回合中(含正要開始)拒刪正在回覆的那條;別條照刪;回合結束後那條也能刪;寫之前先等寫鎖(busy_timeout)",
    busyCur === false && busyOther === true && starting === false && idle === true && deletes.includes("PRAGMA busy_timeout = 3000") && deletes.includes("turns:desktop-bbbb2222"), { busyCur, busyOther, starting, idle });
  deletes.length = 0; const okRun = M.deleteSession("desktop-cccc3333");
  ok("④ 兩張表包在 BEGIN IMMEDIATE … COMMIT 裡", okRun === true && deletes.join() === "PRAGMA busy_timeout = 3000,BEGIN IMMEDIATE,turns:desktop-cccc3333,session_meta:desktop-cccc3333,COMMIT", deletes);
  deletes.length = 0; failMeta = true; const bad = M.deleteSession("desktop-dddd4444"); failMeta = false;
  ok("④ 第二句寫不進:ROLLBACK(turns 那句一起撤)、回 false", bad === false && deletes.join() === "PRAGMA busy_timeout = 3000,BEGIN IMMEDIATE,turns:desktop-dddd4444,ROLLBACK", deletes);
  ok("④ send-message 開跑時記下是哪一條(turnSessionId 在 turnStarting 立起之前就設好)", /turnSessionId = payload && payload\.sessionId;[^\n]*\n\s*turnStarting = true;\n\s*newTurnStop\(\);/.test(mainSrc));
  ok("④ 畫面:刪對話沒刪成不無聲關框(清單上方講一句 cs.delFail)", /if \(!\(await window\.blave\.deleteSession\(m\.id\)\)\) \{ delClose\(false\); const w = csWhy\(\); w\.textContent = t\("cs\.delFail"\); w\.hidden = false; return; \}/.test(appSrc)
    && !!STR.zh["cs.delFail"] && !!STR.en["cs.delFail"]);
}
ok("字:「上一輪還在跑」這類工程用語不再出現在任何 zh 字串", Object.values(STR.zh).every((v) => !/上一輪還在跑/.test(v)));
{ const css = read(path.join(R, "app.css")), m = css.match(/\.busy-fix::before \{([^}]*)\}/), body = m ? m[1] : "";
  const h = /height: (\d+)px/.exec(body), viz = css.match(/\.busy-fix, \.busy-fix:hover \{([^}]*)\}/);
  ok("補救鈕熱區:.busy-fix::before 置中固定高 ≥ 44(不靠全域 -6 的 30)、寬至少 44;視覺那條不加 padding／高度",
    !!h && Number(h[1]) >= 44 && /top: 50%/.test(body) && /left: 50%/.test(body) && /width: max\(44px,/.test(body) && /translate\(-50%, -50%\)/.test(body) && !!viz && !/padding|height|line-height/.test(viz[1]), body);
  // 稽核 0127b1 P1-4:44 高的熱區要落在原因句自己的盒子裡——行盒 18,上下各要 ≥ 13 內距;busyFixLink 寫進的每一種容器都要點名
  const pad = css.match(/:is\(([^)]*)\):has\(> \.busy-fix\) \{([^}]*)\}/), lst = pad ? pad[1].split(",").map((x) => x.trim()) : [];
  const pt = pad && /padding-top: (\d+)px/.exec(pad[2]), pb = pad && /padding-bottom: (\d+)px/.exec(pad[2]);
  ok("補救鈕熱區不伸進鄰列:掛了補救鈕的原因句上下內距 ≥ (44 − 18) / 2,而且涵蓋 busyFixLink 寫進的每一種容器",
    !!pt && !!pb && Number(pt[1]) >= 13 && Number(pb[1]) >= 13
    && [".busy-why", ".xp-note", ".rp-ho-note", ".rob-cap", ".wf-cap", "#lib-cta-note", "#ver-banner-err", "#ver-rerun-busy"].every((x) => lst.indexOf(x) >= 0), JSON.stringify(lst)); }
{ const css = read(path.join(R, "app.css")), rob = read(path.join(R, "report-robust.js"));
  const grey = css.match(/\.btn-fill:disabled, [^{]*\{([^}]*)\}/), na = css.match(/\n(\.lib-cta \.btn-fill\[aria-disabled="true"\][^{]*)\{([^}]*)\}/);
  ok("稽核 0127b1 P1-3:回合中鎖住的「開始掃描／開始驗證」照 Disabled ①——跟填色鈕停用同一組灰、游標 not-allowed;掃描只在被鎖(不是已送出)時掛 .is-lock",
    !!grey && /\.btn-fill\.is-lock/.test(grey[0]) && /\.wf-go\[aria-disabled="true"\]/.test(grey[0]) && !!na && /\.wf-go\[aria-disabled="true"\]/.test(na[1]) && /\.btn-fill\.is-lock/.test(na[1]) && /cursor: not-allowed/.test(na[2])
    && /st\.btn\.classList\.toggle\("is-lock", !!opts\.busy && !on\)/.test(rob)
    && /#rp-ho\[aria-disabled="true"\] \{[^}]*cursor: not-allowed/.test(css)); }
(async () => {
  for (let n = 0; n < pend.length; n++) await pend[n];   // 巢狀的 await_ 會在跑的時候再推進來
  console.log(red ? red + " 紅" : "ALL PASS");
  process.exit(red ? 1 : 0);
})();
