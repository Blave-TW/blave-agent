// 設定以外的「登入 Blave」直接開瀏覽器登入(app.js planSignIn → planLogin),不先開設定 › 帳號與方案再要他按一次。
// 跑法:node tests/check_shell_signin_direct.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const R = path.join(__dirname, "..", "shell", "renderer");
const read = (f) => fs.readFileSync(path.join(R, f), "utf8");
const cut = (src, name) => { const i = src.indexOf("function " + name + "("); if (i < 0) throw new Error("找不到 " + name); return src.slice(src.lastIndexOf("\n", i) + 1, src.indexOf("\n}", i) + 2); };
const app = read("app.js"), lib = read("library.js"), wel = read("welcome.js"), shr = read("report-share.js"), shl = read("report-sharelist.js");

let red = 0;
const ok = (name, c, extra) => { console.log((c ? "PASS  " : "FAIL  ") + name + (c || !extra ? "" : "  " + extra)); if (!c) red++; };
const btn = () => ({ textContent: "", isConnected: true, dataset: {}, h: null, addEventListener(_, f) { this.h = f; }, click() { return this.h && this.h(); } });

/* 1. 列舉:renderer 裡每一個開「帳號與方案」的呼叫點都要在這張表裡,而且沒有一個是登入鈕。
   新增一個 planOpen / setCat("plan") 就得來這裡說它為什麼不是登入(登入一律走 planSignIn) */
const NOT_SIGNIN = {   // 檔 → 所在函式:登出之後切到這一類、查不到狀態 / 舊 api、看方案、綁卡 / 儲值、看完整方案
  "app.js": ["acctSignOut", "setCat", "dataCardState", "planOpen", "mvBlock"],   // mvBlock:設定 › 隱私「前往登入」切到同一個設定裡的帳號與方案(mockup-desktop-mobile-view-toggle A 版 mv.leadOut;登入失效同一句)
  "library.js": ["libGateBtn", "libBuyBox", "libPaintList"],   // libPaintList:方案制試用閘門旁的「看方案」(paywall-redesign-2026-10-21)
  "welcome.js": ["wdNote"],
  "trade.js": ["envPaintEmpty"],
};
const SIGNIN_KEYS = /"(cn\.blave\.btn|pv\.signin|shr\.gateGo|wd\.note\.out(NoNum|\.m)?)"/;
const sites = [];
fs.readdirSync(R).filter((f) => f.endsWith(".js")).forEach((f) => {
  let fn = null;
  read(f).split("\n").forEach((line, i) => {
    const m = /^(?:async )?function (\w+)\(/.exec(line); if (m) fn = m[1];
    if (/^\s*(\/\/|\/\*|\*)/.test(line)) return;
    if (/\bplanOpen\(\)|setCat\("plan"\)/.test(line)) sites.push({ f, i: i + 1, fn, line });
  });
});
const stray = sites.filter((s) => !(NOT_SIGNIN[s.f] || []).includes(s.fn));
ok("每一個開帳號與方案的呼叫點都有登記(共 " + sites.length + " 處)", sites.length >= 8 && stray.length === 0, stray.map((s) => s.f + ":" + s.i + " " + s.fn).join(", "));
const signinRoutedToPlan = sites.filter((s) => SIGNIN_KEYS.test(s.line));
ok("沒有一顆登入鈕開的是帳號與方案", signinRoutedToPlan.length === 0, signinRoutedToPlan.map((s) => s.f + ":" + s.i).join(", "));
ok("report-share / report-sharelist 不再開帳號與方案", !/setCat\("plan"\)/.test(shr) && !/setCat\("plan"\)/.test(shl));

{ // 按登入的埋點:三個開瀏覽器的入口都在 startOAuth 之前送 login_click(planSignIn 的入口都經 planLogin)
  const before = (body) => { const a = body.indexOf('trackFeature("login_click")'), b = body.indexOf("window.blave.startOAuth("); return a > 0 && b > a; };
  const flow = cut(app, "blaveLoginFlow"), start = flow.slice(flow.indexOf("async function start()"));
  ok("login_click 在 blaveGoNow / blaveLoginFlow.start / planLogin 的 startOAuth 之前各送一次", before(cut(app, "blaveGoNow")) && before(start) && before(cut(app, "planLogin"))
    && (app.match(/trackFeature\("login_click"\)/g) || []).length === 3);
  ok("授權網址帶 src=desktop_app(註冊來源)", /device_label: [^\n]*\n(?:\s*\/\/[^\n]*\n)?\s*src: "desktop_app",\n\s*\}\);\n\s*const authUrl = /.test(fs.readFileSync(path.join(R, "..", "main.js"), "utf8")));
}

/* 2. planSignIn 本身:等待中鈕字換「取消等待」、結束還原;等待中再按 = planLogin 的取消;回合在跑照樣登入(回合中鎖減量放開登入);呼叫端已換掉字就不蓋回去 */
function harness() {
  const C = { planLoginBusy: false, planLoginOut: false, oauthPending: false, running: false, calls: 0, resolve: null, t: (k) => k };
  C.planLogin = () => { C.calls++; if (C.planLoginBusy) { C.resolve(); return Promise.resolve(); } C.planLoginBusy = C.oauthPending = true; return new Promise((r) => { C.resolve = () => { C.planLoginBusy = C.oauthPending = false; r(); }; }); };
  vm.createContext(C);
  vm.runInContext(cut(app, "planSignIn").replace(/^async function planSignIn/m, "var planSignIn = async function"), C);
  return C;
}
(async () => {
  let C = harness(), b = btn(); b.textContent = "cn.blave.btn";
  const p = C.planSignIn(b);
  ok("按下去就走 planLogin,鈕字換成取消等待", C.calls === 1 && b.textContent === "oauth.cancel");
  C.planSignIn(null); const b2 = btn(); b2.textContent = "cn.blave.btn"; C.planSignIn(b2);
  ok("等待中從字不是取消的地方再按(分享框、被重畫過的鈕):不取消正在走的那次", C.calls === 1 && C.planLoginBusy === true);
  C.planSignIn(b);
  ok("等待中按那顆「取消等待」= 取消(planLogin 自己的取消分支)", C.calls === 2);
  await p;
  ok("結束後鈕字還原", b.textContent === "cn.blave.btn", b.textContent);

  C = harness(); b = btn(); b.textContent = "pv.signin";
  const p2 = C.planSignIn(b); b.textContent = "fault.resend"; C.resolve(); await p2;
  ok("登入成功後呼叫端已經換掉鈕字(資料卡換〔再送一次〕):不蓋回去", b.textContent === "fault.resend");

  C = harness(); C.running = true; b = btn(); b.textContent = "cn.blave.btn";
  const pRun = C.planSignIn(b);
  ok("回合在跑:照樣登入(回合中鎖減量第一期放開登入,check_shell_busy_lock ②)", C.calls === 1 && b.textContent === "oauth.cancel");
  C.resolve(); await pRun;
  C = harness(); C.oauthPending = true; await C.planSignIn(null);
  ok("別的登入在等(模型接入那條):不另開一次", C.calls === 0);
  C = harness(); const p3 = C.planSignIn(null); C.resolve(); await p3;
  ok("沒有鈕(分享框的確認鈕)也能登入", C.calls === 1);

  /* 2b. 稽核 M1:設定外面開始的登入,關設定不取消;設定裡面開始的(設定 › 帳號與方案的 planLogin、公開連結 shlSignIn)照舊取消 */
  C = harness(); C.planSignIn(btn());
  const outFlag = C.planLoginOut; C.resolve();
  C = harness(); C.planSignIn(btn(), true);
  ok("planSignIn 從設定外面開始 → planLoginOut = true;帶 inSettings(公開連結)→ false", outFlag === true && C.planLoginOut === false);
  { const sc = cut(app, "setClose"), pl = cut(app, "planLogin");
    ok("setClose 只取消設定裡開始的登入:oauthPending 而且不是(planLoginBusy 且 planLoginOut);planLogin 收尾清掉 planLoginOut;公開連結帶 inSettings",
      /if \(oauthPending && !\(planLoginBusy && planLoginOut\)\) window\.blave\.cancelOAuth\(\);/.test(sc) && !/oauthPending \|\| planLoginBusy/.test(sc)
      && /planLoginBusy = oauthPending = planLoginOut = false;/.test(pl) && /await planSignIn\(b, true\)/.test(cut(shl, "shlSignIn")));
    // setClose 的判斷原式在純 node 跑:四種狀態
    const cond = /if \((oauthPending && !\(planLoginBusy && planLoginOut\))\)/.exec(sc)[1], dec = (o, b, out) => vm.runInNewContext(cond, { oauthPending: o, planLoginBusy: b, planLoginOut: out });
    ok("關設定:外面開始的 planSignIn 在等 → 不取消;設定裡的 planLogin 在等 → 取消;模型接入(blaveGo)在等 → 取消;沒在等 → 不叫",
      dec(true, true, true) === false && dec(true, true, false) === true && dec(true, false, false) === true && dec(false, false, false) === false); }
  /* 2c. 稽核 S1:等待中重畫的登入鈕直接畫成「取消等待」,按了取消同一次;planLogin 收尾把這些鈕換回原字 */
  { const G = { t: (k) => k, planLoginBusy: true }; vm.createContext(G); vm.runInContext(cut(app, "signInLabel"), G);
    const b9 = G.signInLabel(btn(), "cn.blave.btn"); G.planLoginBusy = false; const b10 = G.signInLabel(btn(), "cn.blave.btn");
    ok("signInLabel:等待中建的鈕字是取消等待、原字記在 data-signin;沒在等就是原字", b9.textContent === "oauth.cancel" && b9.dataset.signin === "cn.blave.btn" && b10.textContent === "cn.blave.btn");
    ok("planLogin 收尾把 data-signin 的鈕從取消等待換回原字;策略庫、歡迎頁的登入鈕用 signInLabel 建;資料卡沒登入那態等待中鈕字是取消等待",
      /querySelectorAll\("button\[data-signin\]"\)\.forEach\(\(x\) => \{ if \(x\.textContent === t\("oauth\.cancel"\)\) x\.textContent = x\.dataset\.signin; \}\);/.test(cut(app, "planLogin"))
      && /signInLabel\(libEl\("button", "btn-fill"\), t\("cn\.blave\.btn"\)\)/.test(cut(lib, "libSignInBtn")) && /if \(signIn\) signInLabel\(b, txt\);/.test(cut(wel, "wdNote"))
      && /label: t\(planLoginBusy \? "oauth\.cancel" : "pv\.signin"\)/.test(cut(app, "dataCardState"))); }
  ok("公開連結的登入鈕也用 signInLabel 建(稽核 r2 S4);資料卡沒登入那態記 data-signin = pv.signin,等待中才長出來的也換得回原字(r2 S2)",
    /signInLabel\(libEl\("button", "btn-out"\), t\("cn\.blave\.btn"\)\)/.test(shl) && /if \(b1\) \{ if \(!hasToken && !ready\) b1\.dataset\.signin = t\("pv\.signin"\); else delete b1\.dataset\.signin; \}/.test(cut(app, "dataCardSync")));
  C = harness(); b = btn(); b.textContent = "oauth.cancel"; b.dataset.signin = "cn.blave.btn"; C.planLoginBusy = true; C.resolve = () => { C.planLoginBusy = false; };
  C.planSignIn(b);
  ok("等待中重畫過、畫成取消等待的那顆:按了就是取消同一次", C.calls === 1 && C.planLoginBusy === false);

  /* 3. 各入口真的叫 planSignIn */
  const hit = [];
  const L = { t: (k) => k, hit, planLoginBusy: false, signInLabel: (b, label) => { b.dataset.signin = label; b.textContent = label; return b; }, planSignIn: (x) => hit.push(["signin", x]), setOpen: () => { hit.push(["setOpen"]); return Promise.resolve(); }, setCat: () => hit.push(["setCat"]), planOpen: () => hit.push(["planOpen"]),
    libEl: () => btn() };
  vm.createContext(L);
  vm.runInContext(cut(lib, "libSignInBtn"), L);
  const lb = L.libSignInBtn(); lb.click();
  ok("策略庫「登入 Blave」(清單閘門卡與詳情主鈕同一顆):直接 planSignIn(帶著自己這顆鈕)", hit.length === 1 && hit[0][0] === "signin" && hit[0][1] === lb, JSON.stringify(hit.map((h) => h[0])));

  hit.length = 0;
  const W = { t: (k) => k, planMo: () => false, signInLabel: (b, label) => { b.dataset.signin = label; b.textContent = label; return b; }, planSignIn: (x) => hit.push(["signin", x]), planOpen: () => hit.push(["planOpen"]), wdEl: () => btn() };
  vm.createContext(W);
  vm.runInContext(cut(wel, "wdNote"), W);
  const into = { kids: [], append(...a) { this.kids.push(...a); }, appendChild(a) { this.kids.push(a); return a; } };
  W.wdNote("out", { t: 14 }, into); into.kids[0].click();
  ok("歡迎頁沒登入那句(登入並綁卡):直接 planSignIn", hit.length === 1 && hit[0][0] === "signin");
  hit.length = 0; into.kids.length = 0;
  W.wdNote("none", { t: 14 }, into); W.wdNote("noplan", {}, into); into.kids.filter((k) => k.click).forEach((k) => k.click());
  ok("已登入那幾句(綁卡 / 看方案)照舊開帳號與方案", hit.length === 2 && hit.every((h) => h[0] === "planOpen"), JSON.stringify(hit));
  hit.length = 0; into.kids.length = 0; W.planMo = () => true; W.bindGo = (src) => hit.push(["bind", src]);
  W.wdNote("none", { t: 14 }, into); W.wdNote("noplan", {}, into); into.kids.filter((k) => k.click).forEach((k) => k.click());
  ok("方案制:沒綁卡那句直開綁卡頁(bind_welcome),沒方案那句照舊開帳號與方案", JSON.stringify(hit) === JSON.stringify([["bind", "bind_welcome"], ["planOpen"]]), JSON.stringify(hit));

  hit.length = 0;
  let box = null;
  const S = { t: (k) => k, planSignIn: (x) => hit.push(["signin", x]), setOpen: L.setOpen, setCat: L.setCat, confirmBox: (o) => { box = o; } };
  vm.createContext(S);
  vm.runInContext(cut(shr, "shrGateAsk"), S);
  S.shrGateAsk({}); box.onOk();
  ok("報告分享沒登入的確認框:主鈕直接 planSignIn,不開設定", hit.length === 1 && hit[0][0] === "signin");

  const loads = [];
  const SL = { hasToken: false, planSignIn: async () => { SL.hasToken = SL.next; }, shlLoad: () => loads.push(1), next: true };
  vm.createContext(SL);
  vm.runInContext(cut(shl, "shlSignIn").replace(/^async function shlSignIn/m, "var shlSignIn = async function"), SL);
  await SL.shlSignIn(btn());
  ok("設定 › 公開連結沒登入:原地登入,登入回來重抓清單", loads.length === 1);
  SL.hasToken = false; SL.next = false; await SL.shlSignIn(btn());
  ok("取消了(還是沒登入):不重抓", loads.length === 1);
  ok("公開連結的登入鈕接的是 shlSignIn", /SHL\.view === "fail" \? shlLoad : \(\) => shlSignIn\(b\)/.test(shl));

  /* 4. 資料卡:沒登入那一態是〔登入 Blave〕+ planSignIn;查不到狀態那一態照舊開帳號與方案 */
  hit.length = 0;
  const D = { t: (k) => k, hasToken: false, acct: null, planLoginBusy: false, dataCard: { b1: "B1" }, planVars: () => ({ t: 14, p: 0 }), pvK: (k) => k, planState: () => "none",
    planSignIn: (x) => hit.push(["signin", x]), planOpen: () => hit.push(["planOpen"]) };
  vm.createContext(D);
  vm.runInContext(cut(app, "dataCardState"), D);
  let st = D.dataCardState(); st.on();
  ok("資料卡沒登入:鈕字 pv.signin、按了 planSignIn(帶資料卡那顆鈕)", st.label === "pv.signin" && hit.length === 1 && hit[0][0] === "signin" && hit[0][1] === "B1", JSON.stringify([st.label, hit]));
  hit.length = 0; D.hasToken = true; st = D.dataCardState(); st.on();
  ok("資料卡已登入但狀態查不到:照舊〔帳號與方案〕開設定", st.label === "pv.e.btn" && hit.length === 1 && hit[0][0] === "planOpen", JSON.stringify([st.label, hit]));

  console.log(red ? "\n" + red + " 紅" : "\nALL PASS");
  process.exit(red ? 1 : 0);
})().catch((e) => { console.log("FAIL  " + e.stack); process.exit(1); });
process.on("beforeExit", () => { console.log("FAIL  非同步測試沒有跑到結尾"); process.exit(1); });
