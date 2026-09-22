// 設定 modal 的兩塊畫面邏輯(shell/renderer/app.js):「關於」的更新狀態(upPaint 七種 phase)、帳號區兩態(acctPaintAcct)。
// 從原文切出函式,配一個最小的假 DOM 跑。跑法:node tests/check_shell_settings.js
const fs = require("fs"), path = require("path");
const R = path.join(__dirname, "..", "shell", "renderer");
const src = fs.readFileSync(path.join(R, "app.js"), "utf8"), html = fs.readFileSync(path.join(R, "index.html"), "utf8"), css = fs.readFileSync(path.join(R, "app.css"), "utf8"), trcss = fs.readFileSync(path.join(R, "trade.css"), "utf8");
const fnSrc = (name) => { const i = src.indexOf("function " + name + "("); if (i < 0) throw new Error("找不到 " + name); return src.slice(i, src.indexOf("\n}", i) + 2); };
let red = 0; const ok = (n, c) => { console.log((c ? "PASS  " : "FAIL  ") + n); if (!c) red++; };
const el = () => {
  const cls = new Set(["btn-quiet"]);
  const n = { _txt: "", hidden: false, onclick: null, title: "", _cls: "", children: [],
    classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), has: (c) => cls.has(c) },
    setAttribute: () => {},
    append: (...x) => { x.forEach((y) => { n.children.push(y); n._txt += typeof y === "string" ? y : y.textContent || ""; }); },
    appendChild: (x) => { n.children.push(x); n._txt += x.textContent || ""; return x; } };
  Object.defineProperty(n, "className", { get: () => n._cls, set: (v) => { n._cls = v; } });
  // textContent = "" 也要清掉子節點(真的 DOM 是這樣;不清的話清單重畫會越畫越長,測試就看不出漏清)
  Object.defineProperty(n, "textContent", { get: () => n._txt, set: (v) => { n._txt = v; n.children.length = 0; } });
  return n;
};
const dom = {}; const $ = (id) => dom[id] || (dom[id] = el());
const document = { createElement: () => el() };
let cur = null, planLoginBusy = false, oauthPending = false, HINT = null;
const setFocusGuard = () => {}, cmdLine = () => "";
const t = (k, v) => k + (v ? JSON.stringify(v) : "");
const calls = []; const window = { blave: { updateCheck: () => { calls.push("check"); return Promise.resolve(); }, updateInstall: () => { calls.push("install"); return Promise.resolve({ ok: true }); } } };
const upRefresh = () => {}; let UP = null, hasToken = false;
// 「關於」兩行 + 一顆鈕(upPlan 決策、upPaint 照畫、upGo / upRun 動作)。雲端那一袋與 trade.js 的幾支用假的
const TR_BAGS = { cloud: { st: null, reqIds: {} } }, ENV = { cloudDirty: false };
let running = false, LANG = "zh", confirmed = null, cloudReply = { ok: true, result: "update=queued" }, sysMsgs = [], said = [];
const envCloudKind = (st) => (st && st.kind) || "loading", trExecState = (st) => (st && st.exec) || "halted";
const trKindOf = (r) => (r && r.kind) || "undelivered", trSendError = (r) => "err:" + (r && r.error);
const trSend = async (bag, cmd) => { calls.push("cloud:" + cmd); return cloudReply; }, trPollSoon = () => {};
const confirmBox = (o) => { confirmed = o; }, addMsg = (c, x) => sysMsgs.push(x), srSay = (x) => said.push(x);
eval("var UPD = " + src.match(/var UPD = (\{[^\n]*\});/)[1]);
eval(fnSrc("upPlan")); eval(fnSrc("upNow")); eval(fnSrc("upPaint")); eval(fnSrc("upGo")); eval(fnSrc("upErrText")); eval(fnSrc("acctPaintAcct"));
eval("async " + fnSrc("upRun"));
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
  ok("ready、兩邊都沒在下單:不跳框,按下去是安裝", calls.join() === "install" && confirmed === null);
  p = paint({ ...C, phase: "blocked" }); ok("blocked(下單中)而雲端沒有新版:講原因、**沒有鈕**(下單中不裝)", p.msg === 'up.blocked{"nv":"0.0.2"}' && p.up && p.btn === null);
  p = paint({ ...C, phase: "error", error: "CHECK_FAILED" }); ok("error:這次沒檢查成功 + 檢查更新(鈕退回安靜的)", p.msg === "up.error" && p.up && p.btn === "up.check" && p.quiet && !p.out);
  p = paint({ ...C, phase: "error", error: "INSTALL_FAILED" }); ok("安裝失敗:講出來、可以再檢查", p.msg === 'up.installFailed{"nv":"0.0.2"}' && p.btn === "up.check");
  ok("版號每一種 phase 都在", ["idle", "checking", "ready", "blocked", "error"].every((ph) => paint({ ...C, phase: ph }).ver === 'up.app{"v":"0.0.1"}'));
  p = paint({ ...C, phase: "idle", backup: { n: 2, dir: ".official-backup/1.1.80-x/" } });
  ok("換版時蓋掉的改動:那一行講數量與位置", $("set-up-bk").textContent === 'up.backup{"n":2,"dir":".official-backup/1.1.80-x/"}');

  // ── 雲端那一行 ──
  const cloud = (o, extra) => ({ kind: "running", exec: "halted", alive: true, report: { reconciler: { alive: true } }, ...(extra || {}),
    cloud: { config_version: "1.1.80", latest_config_version: "1.1.83", turn_active: false, update: null, ...o } });
  const plan = (st, up, mem, localTurn) => upPlan({ up: up || { ...C, phase: "idle" }, cloud: st && st.cloud, kind: st ? envCloudKind(st) : "loading", localTurn: !!localTurn, mem: mem || {}, recAlive: true });
  let q = plan(cloud({}));
  ok("雲端落後:那一行「有新版」、鈕是「更新」、小點亮、聊天入口出現", q.cloud.s[0] === "up.c.available" && q.btn.label[0] === "up.update" && q.btn.act === "go" && q.dot && q.chat.show && !q.chat.disabled);
  ok("沒主機 / 沒登入 / 還沒讀到:雲端那一行不畫", plan({ kind: "none", cloud: {} }).cloud === null && plan({ kind: "signedOut", cloud: {} }).cloud === null && plan(null).cloud === null);
  q = plan({ kind: "stopped", cloud: { config_version: "1.1.80" } }, { ...C, phase: "ready" });
  ok("雲端停機:講原因,鈕照樣能更新這台電腦", q.cloud.s[0] === "up.c.stopped" && !q.cloud.has && q.doLocal && q.btn.act === "go");
  q = plan(cloud({ turn_active: true }));
  ok("雲端有回合在跑:鈕與聊天入口都停用,原因 up.busy", q.btn.disabled && q.btn.title[0] === "up.busy" && q.chat.disabled);
  q = plan(cloud({}), { ...C, phase: "ready" }, {}, true);
  ok("這台電腦有回合在跑:一樣停用", q.btn.disabled && q.chat.disabled);
  q = plan(cloud({ config_version: "1.1.83", update: { state: "done", result: "reconciler_down", requested_at: 1, from_version: "1.1.80" } }));
  ok("reconciler_down:紅字 + 重新啟動下單程式,絕不寫已更新", q.cloud.cls === "bad" && q.cloud.s[0] === "up.c.recDown" && q.cloud.act === "restart" && !/updated/i.test(q.cloud.s[0]));
  q = plan(cloud({ update: { state: "done", result: "not_updated", requested_at: 1, from_version: "1.1.80" } }));
  ok("not_updated:這次沒有更新成功 + 鈕變「再試一次」", q.cloud.s[0] === "up.c.notUpdated" && q.cloud.s[1].v === "1.1.80" && q.btn.label[0] === "up.retry");
  q = plan(cloud({ update: { state: "running", result: "updating", requested_at: 1e9, from_version: "1.1.80" } }), null, { pressedAt: 1e12 });
  ok("更新中(這次在這裡按的):正在更新 + 提醒句、鈕停用「更新中…」、不再算有新版", q.cloud.s[0] === "up.c.updating" && q.cloud.note[0] === "up.c.note" && q.btn.disabled && q.btn.label[0] === "up.updating" && !q.cloud.has);
  const upd = { state: "done", result: "updated", requested_at: 2e9, from_version: "1.1.80" };
  ok("updated:只有這次在這裡按的才講結果(對帳器活著才說重新啟動了);舊紀錄就是一般的已是最新版",
    plan(cloud({ config_version: "1.1.83", update: upd }), null, { pressedAt: 2e12 }).cloud.s[0] === "up.c.updatedRec"
    && plan(cloud({ config_version: "1.1.83", update: upd }), null, { pressedAt: 3e12 }).cloud.s[0] === "up.latest"
    && upPlan({ up: { ...C, phase: "idle" }, cloud: cloud({ config_version: "1.1.83", update: upd }).cloud, kind: "running", mem: { pressedAt: 2e12 }, recAlive: false }).cloud.s[0] === "up.latest");
  ok("按過之後聊天入口收起", plan(cloud({}), null, { chatHidden: true }).chat.show === false);

  // ── 按下去:雲端先送、這台電腦後重開;只有一邊在自動下單才跳框 ──
  UP = { ...C, phase: "ready" }; TR_BAGS.cloud.st = cloud({}); Object.assign(UPD, { pressedAt: 0, chatHidden: false, err: null, errCode: null, cloudSent: false });
  calls.length = 0; confirmed = null; upGo($("set-up-btn"), false); await new Promise((r) => setTimeout(r, 0));
  ok("兩邊都沒在下單:不跳框;雲端先送 update、這台電腦後安裝", confirmed === null && calls.join() === "cloud:update,install", calls.join());
  calls.length = 0; UPD.chatHidden = false; UPD.pressedAt = 0; TR_BAGS.cloud.st = cloud({}, { exec: "running" });
  upGo($("set-up-btn"), false);
  ok("雲端在下單:跳確認框、逐邊講,還沒按確定前什麼都沒送", !!confirmed && calls.length === 0 && confirmed.extra.children.length === 2 && confirmed.title === "up.cf.titleBoth");
  await confirmed.onOk(); ok("確定之後才送", calls.join() === "cloud:update,install");
  UP = { ...C, phase: "blocked" }; confirmed = null; calls.length = 0; TR_BAGS.cloud.st = cloud({}); UPD.chatHidden = false; UPD.pressedAt = 0;
  upGo($("set-up-btn"), false);
  ok("這台電腦在下單(blocked)而雲端有新版:跳框;確定後只送雲端、不裝本機", !!confirmed && confirmed.title === "up.cf.titleBoth");
  await confirmed.onOk(); ok("…blocked 不裝", calls.join() === "cloud:update");
  UP = { ...C, phase: "idle" }; calls.length = 0; confirmed = null; UPD.chatHidden = false; UPD.pressedAt = 0; sysMsgs.length = 0;
  await upRun(upNow(), true);
  ok("從聊天按的:提醒句(網頁工作頁多一條對話、用到 AI 額度)放進對話", sysMsgs.join() === "up.c.note" && said.indexOf("up.c.note") >= 0);
  // 失敗的說法
  for (const [err, key] of [["TURN_BUSY", "up.busy"], ["UNKNOWN_COMMAND", "up.c.notYet"], ["UPDATE_UNSUPPORTED", "up.c.unsupported"], ["MACHINE_NOT_RUNNING", "up.c.stopped"]])
    ok("雲端回 " + err + " → " + key, upErrText({ ok: false, error: err }) === key);
  TR_BAGS.cloud.reqIds.update = "R1"; cloudReply = { ok: false, error: "TURN_BUSY", kind: "undelivered", requestId: "R1" }; UPD.pressedAt = 0;
  await upRun(upNow(), false);
  ok("TURN_BUSY:紅字、request_id 丟掉(再按是新的意圖)、聊天入口回來", UPD.err === "up.busy" && TR_BAGS.cloud.reqIds.update === undefined && UPD.chatHidden === false
    && upNow().cloud.cls === "bad");
  TR_BAGS.cloud.st = cloud({ turn_active: false, fetched_at: UPD.errAt - 1000 }); upPaint(); upPaint();
  ok("#9 失敗之前抓到的那份(或每一輪重畫)不會讓紅字自己消失", UPD.err === "up.busy");
  TR_BAGS.cloud.st = cloud({ turn_active: false, fetched_at: UPD.errAt + 1000, transient: "OFFLINE" }); upPaint();
  ok("L4 這一輪沒抓到(transient:手上是舊的那份):紅字不收", UPD.err === "up.busy");
  TR_BAGS.cloud.st = cloud({ turn_active: false, fetched_at: UPD.errAt + 1000 }); upPaint();
  ok("…失敗之後抓到的新一份說回合結束了,那句才收掉", UPD.err === null);
  // #11 主機起來了:「已停機」那句也要收
  UPD.err = "up.c.stopped"; UPD.errCode = "MACHINE_NOT_RUNNING"; UPD.errAt = 5e12;
  TR_BAGS.cloud.st = { kind: "stopped", cloud: { fetched_at: 6e12 } }; upPaint();
  ok("#11 主機還停著:紅字留著", UPD.err === "up.c.stopped");
  TR_BAGS.cloud.st = cloud({ fetched_at: 6e12 }); upPaint();
  ok("#11 主機起來了:紅字收掉", UPD.err === null);
  // #11 送出成功到讀到這一次的紀錄之前:維持更新中(鈕不閃回「更新」)
  q = upPlan({ up: { ...C, phase: "idle" }, cloud: cloud({}).cloud, kind: "running", mem: { pressedAt: 1e12, cloudSent: true }, now: 1e12 + 3000 });
  ok("#11 ack 之後、紀錄還沒出現:更新中、鈕停用", q.cloud.updating && q.btn.disabled && q.btn.label[0] === "up.updating" && !q.chat.show);
  q = upPlan({ up: { ...C, phase: "idle" }, cloud: cloud({}).cloud, kind: "running", mem: { pressedAt: 1e12, cloudSent: true }, now: 1e12 + 300000 });
  ok("#11 …紀錄一直沒出現:收斂窗口過了就回到照實畫(不永遠卡住)", !q.cloud.updating && q.btn.act === "go");
  // spec ①:按下之前就講會留一條對話、會用到 AI 額度
  q = plan(cloud({}));
  ok("① 雲端有新版、還沒按:那一行已經帶著提醒句", q.cloud.note && q.cloud.note[0] === "up.c.note");
  TR_BAGS.cloud.st = cloud({ fetched_at: 7e12 }); Object.assign(UPD, { err: null, errCode: null, chatHidden: false, cloudSent: false, pressedAt: 0 }); UP = { ...C, phase: "idle" }; upPaint();
  ok("① 聊天那一行的 title 在按之前就是提醒句", !$("ws-update").hidden && $("ws-update").title === "up.c.note" && $("set-up-cnote").textContent === "up.c.note");
  // #10 雲端那段在等的時候這台電腦開始了一個回合:不重開
  UP = { ...C, phase: "ready" }; calls.length = 0; cloudReply = { ok: true, result: "update=queued" };
  const pp = upNow(); running = true; await upRun(pp, false); 
  ok("#10 按下之後本機開始跑回合:不重開(沒叫 install),那一行講原因", calls.indexOf("install") < 0 && UPD.localErr === "up.busy" && upNow().local.s === "up.busy");
  running = false; upPaint(); ok("…回合結束:原因收掉", UPD.localErr === null);
  { const S2 = fs.readFileSync(path.join(R, "strings.js"), "utf8");
    ok("② updatedRec 不宣稱「用新版重新啟動」(api 分不出);up.install 沒人用、刪掉", /"up\.c\.updatedRec": "更新完成，下單程式在跑。"/.test(S2) && !/"up\.c\.updatedRec": "[^"]*(新版重新啟動|restarted on the new version)/.test(S2) && !/"up\.install"/.test(S2)); }
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
