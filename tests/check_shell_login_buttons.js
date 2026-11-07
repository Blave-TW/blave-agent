// 0.1.50 登入鈕與升級鈕(spec login-upgrade-buttons-0150 §5 外殼 5、7、8、10、11):
//   5. dataGateAction 狀態表:每一列 → 鈕字 key、動作、埋點;資料卡 plan_required 沒有第二顆
//   8. 事件列:沒資料權限跳過一輪的 strategy_failed 兩筆 → 只有最新那筆有鈕;現在拿得到資料 → 沒鈕;雲端視角不出
//  10. Blave 登入鈕的四個 key 只有〔登入 Blave〕〔重新登入 Blave〕兩種字面;券商登入不在範圍
//  11. runtime 的 no_credit 進來加上引擎錯誤字 → 一張 402 卡
//   +  主行程:card chunk 在 own 時不轉、err005／err007 讓帳號狀態快取作廢
// (第 6 條在 check_shell_settings.js、第 7 條在 check_shell_data_env.js、第 9 條在 check_shell_relay.js、第 12 條在 check_shell_telemetry.js)
// 跑法:node tests/check_shell_login_buttons.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const R = path.join(__dirname, "..", "shell", "renderer");
const app = fs.readFileSync(path.join(R, "app.js"), "utf8"), trade = fs.readFileSync(path.join(R, "trade.js"), "utf8");
const main = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8");
const cut = (src, name) => { const i = src.search(new RegExp("^(async )?function " + name + "\\(", "m")); if (i < 0) throw new Error("找不到 " + name); return src.slice(i, src.indexOf("\n}", i) + 2); };
const line = (src, re) => { const m = src.match(re); if (!m) throw new Error("找不到 " + re); return m[0].replace(/^const /, "var "); };
let red = 0;
const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  " + JSON.stringify(d))); if (!c) red++; };

(async () => {
  // ── 5 ──
  const G = { hit: [], hasToken: true, acct: null, planLoginBusy: false, revoked: false, starting: false, V: { t: 14 } };
  Object.assign(G, { t: (k, v) => (v ? k + JSON.stringify(v) : k), planVars: () => G.V, planState: () => (G.starting ? "starting" : "none"), authRevoked: () => G.revoked,
    trackFeature: (n) => G.hit.push("track:" + n), bindGo: (n) => G.hit.push("bind:" + n), planOpen: () => G.hit.push("planOpen"), planRepay: () => G.hit.push("planRepay"),
    planSignIn: async (b) => { G.hit.push("signin:" + (b || "")); return { ok: true }; } });
  vm.createContext(G);
  vm.runInContext([cut(app, "dataAccessOf"), line(app, /^const hasData = [^\n]*$/m), line(app, /^const acctNoCard = [^\n]*$/m), line(app, /^const acctOffer = [^\n]*$/m), cut(app, "dataGateAction")].join("\n"), G);
  const A = (o) => ({ can_run: true, plan: { state: "none" }, ...o });
  const row = async (where, setup) => {
    Object.assign(G, { hasToken: true, acct: null, planLoginBusy: false, revoked: false, starting: false, V: { t: 14 } }, setup);
    const g = G.dataGateAction(where, { btn: () => "B" }); G.hit = [];
    if (g) await g.on();
    return g ? [g.kind, g.label, G.hit.join()] : null;
  };
  const TABLE = [
    ["沒登入", { hasToken: false }, ["login", "pv.signin", "track:login_$,signin:B"]],
    ["登入失效(authRevoked)", { revoked: true, acct: A({ data_access: "included" }) }, ["login", "fault.authBtn", "track:login_$,signin:B"]],
    ["方案制、有試用資格沒卡", { acct: A({ data_access: "plan_required", has_card: false, trial_eligible: true }) }, ["plan", 'lib.gate.trial{"t":14}', "bind:bind_$"]],
    ["方案制、有試用資格沒卡、沒有天數", { V: { t: "" }, acct: A({ data_access: "plan_required", has_card: false, trial_eligible: true }) }, ["plan", "plan.addCard", "bind:bind_$"]],
    ["方案制、沒方案", { acct: A({ data_access: "plan_required", has_card: true }) }, ["plan", "data.seePlan", "track:plan_$,planOpen"]],
    ["方案扣款失敗", { acct: A({ data_access: "payment_failed" }) }, ["plan", "plan.repay", "planRepay"]],
    ["切換前 none、沒卡", { acct: A({ data_access: "none", reason: "NO_CARD" }) }, ["plan", "acct.addCard", "bind:bind_$"]],
    ["切換前 none、有卡", { acct: A({ data_access: "none", reason: "NO_CREDIT" }) }, ["plan", "fault.noCreditBtn", "bind:topup_$"]],
    ["現在拿得到資料(included)", { acct: A({ data_access: "included" }) }, null],
    ["現在拿得到資料(billed)", { acct: A({ data_access: "billed" }) }, null],
    ["啟動中", { starting: true, acct: A({ data_access: "plan_required" }) }, null],
    ["查不到", { acct: null }, null],
  ];
  for (const where of ["card", "event"]) {
    const src = where === "card" ? "data" : "event";
    for (const [name, setup, want] of TABLE) {
      const got = await row(where, setup), exp = want && [want[0], want[1], want[2].replace(/\$/g, src)];
      ok(`5 ${where}:${name} → ${exp ? exp.join(" / ") : "不出鈕"}`, JSON.stringify(got) === JSON.stringify(exp), got);
    }
  }
  Object.assign(G, { hasToken: true, acct: A({ data_access: "included" }), revoked: false });
  let g = G.dataGateAction("card", { relogin: true });
  ok("5 這一輪 err005(relogin):account_status 說有資料也是重新登入", g && g.kind === "login" && g.label === "fault.authBtn" && g.idle === "fault.authBtn");
  Object.assign(G, { hasToken: false, planLoginBusy: true }); G.hit = [];
  g = G.dataGateAction("event", { btn: () => "B" }); await g.on();
  ok("5 登入等待中:鈕字是取消等待、idle 留原字、按了不記 login_event(是取消)", g.label === "oauth.cancel" && g.idle === "pv.signin" && G.hit.join() === "signin:B", G.hit);
  { let signed = 0; Object.assign(G, { hasToken: false, planLoginBusy: false }); g = G.dataGateAction("card", { signedIn: () => signed++ }); await g.on();
    ok("5 登入成功才叫 signedIn(資料卡拿它清掉 ERR005 的黏著)", signed === 1); }
  ok("5 資料卡 plan_required 只有〔看方案〕,沒有第二顆〔API 方案〕", /if \(da === "plan_required"\) return \{ text: t\("data\.noPlan"\), \.\.\.gateBtn\(g\) \};/.test(cut(app, "dataCardState")) && !/apiPlanGo/.test(cut(app, "dataCardState")));
  ok("5 卡與事件列讀同一張表:dataCardState 與 trEvDataGate 都叫 dataGateAction", /dataGateAction\("card"/.test(cut(app, "dataCardState")) && /dataGateAction\("event"/.test(cut(trade, "trEvDataGate")));

  // ── 8 ──
  const T = { TR: { env: "local" } };
  vm.createContext(T);
  vm.runInContext([cut(trade, "trMs"), cut(trade, "trStrategyFailedNoteKey"), line(trade, /^const trEvPayload = [^\n]*$/m), cut(trade, "trEvGateEv"), cut(trade, "trEvDataGate")].join("\n"), T);
  const NO = "Traceback ...\nlib.data.DataAccessError: Blave data is not reachable on this desktop this turn";
  const e1 = { type: "strategy_failed", ts: "2026-11-07T01:00:00Z", payload: { strategy: "a", error: NO } };
  const e2 = { type: "strategy_failed", ts: "2026-11-07T03:00:00Z", payload: { strategy: "b", error: NO } };
  const e3 = { type: "strategy_failed", ts: "2026-11-07T05:00:00Z", payload: { strategy: "c", error: "ZeroDivisionError" } };
  ok("8 NoData 兩筆:只有最新那筆有鈕(別的失敗不算)", T.trEvGateEv([e1, e2, e3], true) === e2 && T.trEvGateEv([e2, e1], true) === e2);
  ok("8 雲端視角不出、沒有這一態不出", T.trEvGateEv([e1, e2], false) === null && T.trEvGateEv([e3], true) === null && T.trEvGateEv(null, true) === null);
  ok("8 接線:機器事件那段只有 ev === gateEv 那列接 trEvDataGate,gateEv 只在本機視角算", /const gateEv = trEvGateEv\(r\.events, TR\.env === "local"\);/.test(trade) && /if \(ev === gateEv\) trEvDataGate\(body\);/.test(trade));
  const body = () => { const b = { kids: [], append(...a) { this.kids.push(...a); } }; return b; };
  const el = (tag, cls, text) => ({ tag, cls, textContent: text, dataset: {}, h: null, addEventListener(_, f) { this.h = f; } });
  let clicked = 0;
  Object.assign(T, { trEl: el, dataGateAction: () => null });
  let b = body(); T.trEvDataGate(b);
  ok("8 現在拿得到資料(dataGateAction 回 null)→ 沒鈕", b.kids.length === 0);
  Object.assign(T, { dataGateAction: (where, o) => ({ kind: "login", label: "oauth.cancel", idle: "fault.authBtn", on: () => { clicked++; T.btnSeen = o.btn(); } }) });
  b = body(); T.trEvDataGate(b); const btn = b.kids[1]; btn.h();
  ok("8 有出口:同一行接一顆 btn-quiet、記原字、按了走表上的動作(把自己這顆鈕交給登入)", b.kids[0] === " " && btn.tag === "button" && btn.cls === "btn-quiet" && btn.dataset.signin === "fault.authBtn" && clicked === 1 && T.btnSeen === btn);

  // ── 10 ──
  const po = (lang) => { const o = {}; for (const m of fs.readFileSync(path.join(__dirname, "..", "shell", "i18n", lang + ".po"), "utf8").matchAll(/^msgid "([^"]+)"\nmsgstr "((?:[^"\\]|\\.)*)"$/gm)) o[m[1]] = m[2]; return o; };
  const zh = po("zh"), en = po("en"), KEYS = ["pv.signin", "cn.blave.btn", "fault.authBtn", "plan.relogin", "shr.gateGo"];   // shr.gateGo:分享框的登入鈕(Wei 0.1.50 加做)
  ok("10 zh:Blave 登入的五個 key 只有〔登入 Blave〕〔重新登入 Blave〕兩種", JSON.stringify([...new Set(KEYS.map((k) => zh[k]))].sort()) === JSON.stringify(["登入 Blave", "重新登入 Blave"].sort()), KEYS.map((k) => zh[k]));
  ok("10 en:只有 Sign In to Blave／Sign In to Blave Again 兩種", JSON.stringify([...new Set(KEYS.map((k) => en[k]))].sort()) === JSON.stringify(["Sign In to Blave", "Sign In to Blave Again"].sort()), KEYS.map((k) => en[k]));
  ok("10 不在範圍的照舊:券商的 tr.presRelogin、句中連結 mg.why.signin", zh["tr.presRelogin"] === "重新登入" && en["mg.why.signin"] === "Sign in to Blave");
  ok("10 新句 pv.e.relogin 兩語都在", zh["pv.e.relogin"] === "這台電腦的 Blave 登入已失效。" && en["pv.e.relogin"] === "Blave sign-in on this computer has expired.");
  ok("10 設定 › 帳號與方案的 revoked 態主鈕是 fault.authBtn", /revoked: +\{ h: "pv\.h\.revoked", lead: "", acts: \[planLoginBusy \? btn\("btn-out", t\("oauth\.cancel"\), planLogin\) : btn\("btn-fill", t\("fault\.authBtn"\), planLogin\)\] \},/.test(app));

  // ── 11 ──
  const E = { faults: [], lines: [], cur: "blave", faultShown: false, turnFaulted: false, turnFail: null, turnErrored: false, turnLimit: false, turnChanged: false, turnDataCode: null, draft: "", pendingErr: [], sessionId: "s" };
  Object.assign(E, { t: (k, v) => k + (v ? JSON.stringify(v) : ""), draftPromote: () => {}, sugCollapse: () => {}, addFault: (f) => E.faults.push(f), localAuthFault: (k) => ({ flow: "local", kind: k }),
    limitSwallow: () => false, holdErrors: () => false, sysLine: (x) => E.lines.push(typeof x === "function" ? x() : x), scrollChat: () => {}, draftShow: () => {} });
  vm.createContext(E);
  vm.runInContext([cut(app, "collectDraft"), line(app, /^const DATA_CARD_CODES = [^\n]*$/m), cut(app, "turnEventIn")].join("\n"), E);
  const reset = (o) => Object.assign(E, { faults: [], lines: [], faultShown: false, turnFaulted: false, turnFail: null, cur: "blave" }, o);
  reset({ faultShown: true, turnFaulted: true });
  E.turnEventIn({ type: "error", code: "no_credit", message: "Your Blave balance is empty" });
  ok("11 引擎錯誤字已經畫了 402 卡,runtime 再送 no_credit → 不再畫、也不多一行", E.faults.length === 0 && E.lines.length === 0, [E.faults, E.lines]);
  reset();
  E.turnEventIn({ type: "error", code: "no_credit", message: "x" }); E.turnEventIn({ type: "error", code: "no_credit", message: "x" });
  ok("11 只有 no_credit(引擎那句沒出來)→ 一張 402 卡(credit 流程),第二則不重畫", E.faults.length === 1 && E.faults[0].flow === "credit" && E.turnFail === "402" && E.lines.length === 0, [E.faults, E.lines]);
  reset({ cur: "claude" }); E.turnEventIn({ type: "error", code: "no_credit", message: "x" });
  ok("11 不是 Blave AI 的回合:不畫 402 卡,照舊一行", E.faults.length === 0 && E.lines.length === 1);
  reset(); E.turnEventIn({ type: "card", id: "data-access", code: "err005" }); const kept = E.turnDataCode;
  E.turnEventIn({ type: "card", id: "data-access", code: "bogus" }); E.turnEventIn({ type: "card", id: "other", code: "denied" });
  ok("card chunk:認得的代碼記進 turnDataCode,認不得的代碼／別的卡不動它", kept === "err005" && E.turnDataCode === "err005");

  // 主行程
  const stdout = main.slice(main.indexOf('if (line.startsWith("@@BLAVE@@")) {'), main.indexOf('let errTail = "";', main.indexOf('if (line.startsWith("@@BLAVE@@")) {')));
  ok("主行程:card chunk 在 own(用戶自己的 API 方案 key)時不轉;err005／err007 讓 lastAcct 作廢", /if \(c && c\.type === "card"\) \{\n\s*if \(dataAccess === "own"\) continue;[^\n]*\n\s*if \(c\.code === "err005" \|\| c\.code === "err007"\) lastAcct = null;/.test(stdout)
    && stdout.indexOf('c.type === "card"') < stdout.indexOf('sendTurn(sessionId, "turn-event", c)'));

  console.log(red ? `\n${red} 紅` : "\nALL PASS");
  process.exit(red ? 1 : 0);
})().catch((e) => { console.log("FAIL  " + (e && e.stack)); process.exit(1); });
