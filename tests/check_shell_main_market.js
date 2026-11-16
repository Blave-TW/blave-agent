// 主要市場(spec market-pref-2026-11-09;不起 Electron、不開視窗):
//   ① 主行程 mainmarket.js:只問新裝(askInit)、改值先寫本機再送帳號、§2.4 對帳四條、換人、待送與在途、舊 api、shown 第二次寫 mktAsk:false、
//      回合旗標;§4 狀態表裡「出不出第二步」由 get().ask 與 v 決定的那幾列逐列跑。
//   ② renderer 純邏輯(market.js 純邏輯區塊、library.js wcReco 的 mkt):市場對應、出不出、歡迎頁①挑法。
//   ③ 接線(原文):app.js 的進門閘與失敗回第一步的呼叫點、index.html 的節點與載入順序、設定列、telemetry 白名單、字串、打包清單。
// 跑法:node tests/check_shell_main_market.js
const fs = require("fs"), path = require("path"), vm = require("vm"), os = require("os");
const SHELL = path.join(__dirname, "..", "shell"), R = path.join(SHELL, "renderer");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + String(d).slice(0, 1500))); if (!c) red++; };
const read = (f) => fs.readFileSync(f, "utf8");
const MM = require(path.join(SHELL, "mainmarket.js"));
const A = "a".repeat(32), B = "b".repeat(32);

/* ── ① 主行程 ── */
function rig(o) {
  const st = { prefs: Object.assign({}, (o && o.prefs) || {}), creds: (o && o.creds) || null, posts: [], reply: (o && o.reply) || (() => ({ status: 200, body: {} })), changes: 0, hold: null };
  st.mm = MM.createMainMarket({
    readPrefs: () => JSON.parse(JSON.stringify(st.prefs)),
    patchPrefs: (p) => { if (st.fail) throw new Error("disk"); Object.assign(st.prefs, p); },
    getCreds: () => st.creds, apiBase: "https://api.example", ask: o && o.ask,
    post: (u, b) => { st.posts.push({ u, b }); if (st.hold) return st.hold; return Promise.resolve(st.reply(b)); },
    onChange: () => { st.changes++; },
  });
  return st;
}
const tick = () => new Promise((r) => setImmediate(r));
const CA = { token: "tA", appSecret: "sA", who: A }, CB = { token: "tB", appSecret: "sB", who: B };

(async () => {
  // askInit:只問新裝
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mkt-ask-"));
  try {
    const prefs = {}; const rd = () => prefs, pt = (p) => Object.assign(prefs, p);
    ok("① askInit:空的 userData → 問,寫 mktAsk:true", MM.askInit(tmp, rd, pt) === true && prefs.mktAsk === true);
    ok("① askInit:有 mktAsk 就用,不再判", MM.askInit(tmp, () => ({ mktAsk: false }), pt) === false);
    for (const f of MM.INSTALL_MARKS) {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), "mkt-old-")), p2 = {};
      fs.writeFileSync(path.join(d, f), "x");
      const r = MM.askInit(d, () => p2, (p) => Object.assign(p2, p));
      fs.rmSync(d, { recursive: true, force: true });
      ok("① askInit:升級上來的舊安裝(有 " + f + ")→ 不問", r === false && p2.mktAsk === false);
    }
    ok("① askInit:寫不進去 → 照算出來的值,不丟例外", MM.askInit(tmp, () => ({}), () => { throw new Error("disk"); }) === true);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }

  // 沒登入在第二步選 → 本機 src null、不送;設了值就不再問
  { const s = rig({ ask: true });
    ok("① 新裝、沒值:get().ask 為真、v 為 null(第二步出)", s.mm.get().ask === true && s.mm.get().v === null);
    const g = s.mm.set("txf", { fresh: true });
    ok("① 沒登入選台指期:本機 { txf, null }、沒送帳號、不再問(mktAsk:false)", g.v === "txf" && s.prefs.mainMarket.src === null && s.posts.length === 0 && g.ask === false && s.prefs.mktAsk === false);
    ok("① 亂值不寫", s.mm.set("stock").v === "txf" && s.mm.set(null).v === "txf" && s.mm.set({ v: "txf" }).v === "txf");
    ok("① 回合旗標:txf 帶、all 不帶", JSON.stringify(s.mm.args()) === '["--main-market=txf"]' && (s.mm.set("all"), s.mm.args().length === 0)); }

  // §2.4 第 2 條:沒登入選的,下次登入
  { const s = rig({ ask: true }); s.mm.set("twstock", { fresh: true }); s.creds = CA;
    s.mm.reconcile(A, { main_market: "crypto" }); await tick();
    ok("① §2.4-2 這次連結畫面剛選的(fresh)、帳號是 crypto → 以剛選的為準,寫上帳號(驗收:結果 twstock、帳號變 twstock)",
      s.prefs.mainMarket.v === "twstock" && s.prefs.mainMarket.src === A && s.posts.length === 1 && s.posts[0].b.main_market === "twstock" && s.posts[0].u.endsWith(MM.ENDPOINT) && !s.prefs.mktPend, JSON.stringify(s.prefs)); }
  { const s = rig({ prefs: { mainMarket: { v: "twstock", src: null } } }); s.creds = CA;
    s.mm.reconcile(A, { main_market: "crypto" });
    ok("① §2.4-2 更早以前選的(不是這次)、帳號有值 → 以帳號為準,本機改 crypto、推給畫面", s.prefs.mainMarket.v === "crypto" && s.prefs.mainMarket.src === A && s.posts.length === 0 && s.changes === 1); }
  { const s = rig({ prefs: { mainMarket: { v: "usstock", src: null } } }); s.creds = CA;
    s.mm.reconcile(A, { main_market: null }); await tick();
    ok("① §2.4-2 帳號沒值 → 本機值寫上帳號", s.posts.length === 1 && s.posts[0].b.main_market === "usstock" && s.prefs.mainMarket.src === A && !s.prefs.mktPend); }
  // seal:這次在連結畫面選、登入完成才進工作頁 → 進門那一刻就以剛選的為準;進門時沒登入就不再算剛選的
  { const s = rig({ ask: true }); s.mm.set("txf", { fresh: true }); s.creds = CA; s.mm.seal(); await tick();
    ok("① seal:剛選的、進門時已登入 → src 換成這個人、寫上帳號", s.prefs.mainMarket.src === A && s.posts.length === 1 && s.posts[0].b.main_market === "txf");
    s.mm.reconcile(A, { main_market: "txf" });
    ok("① seal 之後帳號回來是 txf → 不動、不重推", s.prefs.mainMarket.v === "txf" && s.changes === 0); }
  { const s = rig({ ask: true }); s.mm.set("txf", { fresh: true }); s.mm.seal(); s.creds = CA;
    s.mm.reconcile(A, { main_market: "crypto" });
    ok("① seal 時沒登入(Claude Code)→ 之後才登入、帳號有值 → 以帳號為準", s.prefs.mainMarket.v === "crypto" && s.posts.length === 0); }

  // §2.4 第 1 條:登入著改值;待送與在途
  { const s = rig({ prefs: { mainMarket: { v: "crypto", src: A } } }); s.creds = CA;
    let release; s.hold = new Promise((r) => { release = r; });
    s.mm.set("txf");
    ok("① 登入著改值:本機先換、送出前就記待送 { txf, A }", s.prefs.mainMarket.v === "txf" && s.prefs.mktPend && s.prefs.mktPend.v === "txf" && s.prefs.mktPend.who === A);
    s.mm.reconcile(A, { main_market: "crypto" });
    ok("① 在途時回來一份舊的帳號值 → 本機不被蓋", s.prefs.mainMarket.v === "txf" && s.posts.length === 1);
    s.mm.set("usstock");
    ok("① 在途時又改 → 待送換成最後那個,不另開第二個請求", s.prefs.mktPend.v === "usstock" && s.posts.length === 1);
    s.hold = null; release({ status: 200, body: {} }); await tick(); await tick();
    ok("① 第一個請求回來、待送不是它 → 補送最後那個,成功才清", s.posts.length === 2 && s.posts[1].b.main_market === "usstock" && !s.prefs.mktPend, JSON.stringify(s.posts.map((x) => x.b.main_market))); }
  { const s = rig({ prefs: { mainMarket: { v: "crypto", src: A } }, reply: () => ({ status: 503, body: {} }) }); s.creds = CA;
    s.mm.set("txf"); await tick();
    ok("① 斷網改值:畫面照換、旗標留著、不出錯", s.prefs.mainMarket.v === "txf" && s.prefs.mktPend.v === "txf");
    s.mm.reconcile(A, { main_market: "crypto" }); await tick();
    ok("① 恢復連線前回來一份 account_status → 本機不回跳、重送", s.prefs.mainMarket.v === "txf" && s.posts.length === 2);
    const s2 = rig({ prefs: JSON.parse(JSON.stringify(s.prefs)) }); s2.creds = CA;   // 關 app 重開:旗標在 ui-prefs
    s2.mm.reconcile(A, { main_market: "crypto" }); await tick();
    ok("① 斷網改值後關 app 重開、連上 → 帳號補上 txf、旗標清掉、本機不回跳", s2.posts.length === 1 && s2.posts[0].b.main_market === "txf" && !s2.prefs.mktPend && s2.prefs.mainMarket.v === "txf"); }
  { const s = rig({ prefs: { mainMarket: { v: "crypto", src: A } }, reply: () => ({ status: 400, body: { error_code: "BAD_CURRENCY" } }) }); s.creds = CA;
    s.mm.set("txf"); await tick(); s.mm.reconcile(A, { main_market: "crypto" }); await tick();
    ok("① 舊 api(400 BAD_CURRENCY):這次開 app 不再送、旗標留著、本機不被蓋", s.posts.length === 1 && s.prefs.mktPend.v === "txf" && s.prefs.mainMarket.v === "txf"); }
  { const s = rig({ prefs: { mainMarket: { v: "crypto", src: A } }, reply: () => ({ status: 400, body: { error_code: "BAD_MAIN_MARKET" } }) }); s.creds = CA;
    s.mm.set("usstock"); await tick();
    ok("① api 還不認 usstock(400 BAD_MAIN_MARKET):不再送、本機留 usstock", s.posts.length === 1 && s.prefs.mainMarket.v === "usstock" && s.prefs.mktPend.v === "usstock"); }
  { const s = rig({ prefs: { mainMarket: { v: "crypto", src: A } } }); s.creds = { token: "tA", appSecret: null, who: A };
    s.mm.set("txf"); await tick();
    ok("① 舊登入沒有 app_secret:不送,旗標留著", s.posts.length === 0 && s.prefs.mktPend.v === "txf"); }

  // §2.4 第 3 條:web 改過
  { const s = rig({ prefs: { mainMarket: { v: "crypto", src: A } } }); s.creds = CA;
    s.mm.reconcile(A, { main_market: "txf" });
    ok("① §2.4-3 帳號值不同、沒有待送 → 以帳號為準(在 web 改過,下一次 account_status 就跟上)", s.prefs.mainMarket.v === "txf" && s.changes === 1);
    s.mm.reconcile(A, { main_market: "txf" });
    ok("① 一樣的值不重推畫面", s.changes === 1); }

  // §2.4 第 4 條:換人
  { const s = rig({ prefs: { mainMarket: { v: "txf", src: A }, mktPend: { v: "txf", who: A } } }); s.creds = CB;
    s.mm.reconcile(B, { main_market: null }); await tick();
    ok("① 換人:A 離線改值 → 登出 → 登入 B → B 沒被寫入、A 的旗標丟掉、A 的本機值當沒值", s.posts.length === 0 && !s.prefs.mktPend && s.prefs.mainMarket === null); }
  { const s = rig({ prefs: { mainMarket: { v: "txf", src: A } } }); s.creds = CB;
    s.mm.reconcile(B, { main_market: "crypto" });
    ok("① 換人:B 帳號有值 → 本機換 B 的", s.prefs.mainMarket.v === "crypto" && s.prefs.mainMarket.src === B); }
  { const s = rig({ prefs: { mainMarket: { v: "txf", src: A } } }); s.creds = CA;
    let release; s.hold = new Promise((r) => { release = r; }); s.mm.set("crypto");
    s.creds = CB; s.hold = null; release({ status: 200, body: {} }); await tick();
    ok("① 寫入在途時換了人:不清 A 的旗標、不補送給 B", s.prefs.mktPend && s.prefs.mktPend.who === A && s.posts.length === 1); }

  // 對帳邊界
  { const s = rig({ prefs: { mainMarket: { v: "txf", src: A } } }); s.creds = CA;
    s.mm.reconcile(A, {}); s.mm.reconcile(null, { main_market: "crypto" }); s.mm.reconcile(A, null);
    ok("① 舊 api(沒有 main_market 鍵)、沒登入、空回應 → 不對帳", s.prefs.mainMarket.v === "txf" && s.changes === 0); }
  { const s = rig({ prefs: { mainMarket: { v: "nope", src: A }, mktPend: { v: "txf", who: "x" } } });
    ok("① ui-prefs 形狀不對(壞值、壞 who)→ 當沒設", s.mm.get().v === null && s.mm.args().length === 0); }

  // §4 狀態表(出不出第二步 = ask && 沒值;renderer mktAsks 同一條)
  { const s = rig({ ask: true }); s.creds = CA;
    s.mm.reconcile(A, { main_market: "crypto" });
    ok("① §4 Blave 登入完成、帳號已有 main_market、還沒答 → 本機採帳號值、不再問(收掉第二步)", s.mm.get().v === "crypto" && s.mm.get().ask === false && s.changes === 1); }
  { const s = rig({ ask: true }); s.mm.set("all");
    ok("① §4 跳過:存 all、不再問", s.mm.get().v === "all" && s.mm.get().ask === false && s.mm.args().length === 0); }
  { const s = rig({ ask: false });
    ok("① §4 升級上來的舊安裝:不問,值維持沒設(畫面當 all)", s.mm.get().ask === false && s.mm.get().v === null); }
  { const s = rig({ ask: true, prefs: { mktAsk: true } });
    s.mm.shown(); s.mm.shown();
    ok("① §4 第二步第一次開 app 畫出來:記一次(同一次開 app 只記一次),還要問", s.prefs.mktSeen === 1 && s.prefs.mktAsk === true && s.mm.get().ask === true);
    const s2 = rig({ ask: true, prefs: JSON.parse(JSON.stringify(s.prefs)) });
    s2.mm.shown();
    ok("① §4 第二步開著關 app、重開又畫出來:寫 mktAsk:false(下次不問),這次照問(登入失敗回第一步、重連時再出)", s2.prefs.mktAsk === false && s2.mm.get().ask === true);
    ok("① §4 第三次開 app:askInit 讀到 false 不問", MM.askInit("/nonexistent", () => s2.prefs, () => {}) === false); }
  { const s = rig({ ask: true }); s.creds = CA; s.mm.set("txf"); s.creds = CB;
    s.mm.reconcile(B, { main_market: null });
    ok("① §4 登出後換人登入:本機值清掉,但不再問(連結畫面再出現也不出第二步)", s.mm.get().v === null && s.mm.get().ask === false); }

  /* ── ② renderer 純邏輯 ── */
  const msrc = read(path.join(R, "market.js"));
  const a = msrc.indexOf("/* ── 純邏輯("), b = msrc.indexOf("/* ── 純邏輯到此");
  const block = msrc.slice(a, b);
  ok("② market.js 純邏輯區塊不碰 DOM / i18n", a > 0 && b > a && !/\bdocument\b|\$\(|window\.|\bt\(/.test(block.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")));
  const P = {}; vm.createContext(P); vm.runInContext(block.replace(/^const /gm, "var "), P);
  ok("② 策略庫預設:四個市場照用,all／沒設 → 全部", ["crypto", "twstock", "txf", "usstock"].every((v) => P.mktLibOf(v) === v) && P.mktLibOf("all") === "all" && P.mktLibOf(null) === "all" && P.mktLibOf("x") === "all");
  ok("② 資料清單分段:twstock→tw、txf→txf,usstock／all／沒設 → crypto", P.mktWdOf("crypto") === "crypto" && P.mktWdOf("twstock") === "tw" && P.mktWdOf("txf") === "txf"
    && P.mktWdOf("usstock") === "crypto" && P.mktWdOf("all") === "crypto" && P.mktWdOf(null) === "crypto");
  ok("② 出不出第二步:要問而且沒值才出", P.mktAsks({ ask: true, v: null }) && !P.mktAsks({ ask: true, v: "all" }) && !P.mktAsks({ ask: true, v: "txf" }) && !P.mktAsks({ ask: false, v: null }) && !P.mktAsks(null));
  ok("② 連接帳戶框:只有 txf 讓台灣期貨那組排前面", P.mktTwFirst("txf") && ["crypto", "twstock", "usstock", "all", null].every((v) => !P.mktTwFirst(v)));
  ok("② 市場值與 api _MAIN_MARKET_OPTIONS／主行程同一組", JSON.stringify(P.MKT_VALUES.concat("all")) === JSON.stringify(MM.MARKETS));

  // wcReco 的 mkt
  const lsrc = read(path.join(R, "library.js"));
  const la = lsrc.indexOf("/* ── 純邏輯("), lb = lsrc.indexOf("/* ── 純邏輯到此");
  const L = {}; vm.createContext(L); vm.runInContext(lsrc.slice(la, lb).replace(/^const /gm, "var "), L);
  const S = (o) => Object.assign({ id: 1, title: "x", price: 0, category: "Crypto", created_at: "2026-06-10 00:00:00", purchase_count: 0, purchased: false, is_owner: false, is_official: true, verified: true, blave_data: "none", report: null }, o);
  const day = (i) => "2026-06-" + String(20 - i).padStart(2, "0") + " 00:00:00";
  const list = [S({ id: 1, market: "crypto", created_at: day(1) }), S({ id: 2, market: "crypto", created_at: day(2) }), S({ id: 3, market: "twstock", created_at: day(3) }),
    S({ id: 4, market: "txf", created_at: day(4) }), S({ id: 5, market: "txf", created_at: day(5) }), S({ id: 6, market: "txf", created_at: day(6) }), S({ id: 7, market: "usstock", created_at: day(7) })];
  const ids = (l, mkt) => L.wcReco(l, { env: "cloud", mkt }).map((x) => x.id).join();
  ok("② wcReco 沒設／all → 照現行(每市場先一支、照 libVisible 順序)", ids(list, null) === ids(list, "all") && ids(list, undefined) === ids(list, "all"), ids(list, null) + " vs " + ids(list, "all"));
  ok("② wcReco txf → 三張都是台指期", ids(list, "txf") === "4,5,6", ids(list, "txf"));
  ok("② wcReco usstock → 美股那支在前,不足由其他市場照現行挑法補滿三張", ids(list, "usstock").split(",")[0] === "7" && ids(list, "usstock").split(",").length === 3
    && new Set(ids(list, "usstock").split(",").slice(1).map((i) => list[i - 1].market)).size === 2, ids(list, "usstock"));
  ok("② wcReco 主要市場 0 支 → 照現行從其他市場挑", ids(list.filter((s) => s.market !== "twstock"), "twstock") === ids(list.filter((s) => s.market !== "twstock"), null));
  // 主要市場那一池不看要不要 Blave 資料(Wei 選 A:台指期官方策略全要資料,沒登入時一張都出不來);補位照舊只出不用資料的
  { const req = list.map((x) => Object.assign({}, x, { blave_data: x.market === "crypto" || x.market === "usstock" ? "none" : "required" }));
    const out = (mkt) => L.wcReco(req, { env: "local", signedIn: false, dataAccess: null, wait: false, installed: () => false, mkt });
    const txf = out("txf"), us = out("usstock"), none = out(null);
    ok("② 沒登入、主要市場=台指期、三支都要資料 → 三張都是台指期", txf.map((x) => x.id).join() === "4,5,6", txf.map((x) => x.id).join());
    ok("② …三張按下去都先進詳情(libCta 是 signedOut,wcUse 不是 free 就走 wcDetail)", txf.every((x) => L.libCta(x, { env: "local", signedIn: false }).state === "signedOut")
      && /const st = libCtaOf\(s\)\.state;\n\s*if \(st !== "free"\) \{ if \(st === "signedOut"\) trackFeature\("wcard_signin"\); wcDetail\(s\); return; \}/.test(read(path.join(R, "welcome.js"))));
    ok("② 沒登入、主要市場=美股:美股那支排第一,補位照舊不出要資料的(台股、台指期都不補)", us[0].id === 7 && us.length === 3 && us.slice(1).every((x) => x.blave_data === "none"), us.map((x) => x.id + ":" + x.market).join());
    ok("② 沒設主要市場:照舊一張要資料的都不出", none.every((x) => x.blave_data === "none") && none.length > 0, none.map((x) => x.id).join());
    ok("② 登入、資料已含:主要市場池照樣是台指期三張", L.wcReco(req, { env: "local", signedIn: true, dataAccess: "included", wait: false, installed: () => false, mkt: "txf" }).map((x) => x.id).join() === "4,5,6"); }

  /* ── ②b renderer 流程:market.js 整支跑在 vm 裡(假 DOM、假 window.blave),enterWorkspace 換成「過了 mktHold 就算進門」── */
  function flow(o) {
    const el = (id) => { const n = { id, hidden: false, dataset: {}, attrs: {}, kids: [], ls: {}, textContent: "", value: "", cls: new Set(),
      classList: { add: (c) => n.cls.add(c), remove: (c) => n.cls.delete(c) }, setAttribute: (k, v) => { n.attrs[k] = v; }, addEventListener: (ev, fn) => { n.ls[ev] = fn; },
      focus: () => { E.doc.activeElement = n; }, contains: (x) => x === n || n.kids.includes(x), closest: () => null, append: (...a) => { n.kids.push(...a); }, appendChild: (x) => { n.kids.push(x); } };
      return n; };
    const E = { calls: [], entered: [], tracked: [], acctAsked: 0, ids: {}, mainSt: Object.assign({ v: null, src: null, ask: true }, o && o.st) };
    ["view-connect", "cn-mkt", "cn-mkt-wait", "btn-blave", "set-mkt", "cn-mkt-skip"].forEach((id) => { E.ids[id] = el(id); });
    const tiles = ["crypto", "twstock", "txf", "usstock"].map((m) => { const n = el("tile-" + m); n.dataset.mk = m; E.ids["cn-mkt"].kids.push(n); return n; });
    E.tiles = tiles;
    E.doc = { activeElement: null, querySelectorAll: (q) => (q === "#cn-mkt .mk-opt" ? tiles : []), querySelector: (q) => (/data-mk="crypto"/.test(q) ? tiles[0] : null),
      getElementById: (id) => E.ids[id], createElement: (tag) => el(tag) };
    let onMM = null;
    const ctx = {
      document: E.doc, $: (id) => E.ids[id], t: (k) => k, trackEvent: (n, p) => E.tracked.push(n + ":" + Object.values(p).join()),
      hasToken: !!(o && o.token), oauthPending: false, loginPending: null, ROWMSG: {}, PKG: { snap: null },
      window: { blave: {
        mainMarket: async () => E.mainSt,
        mainMarketSet: (p) => { E.calls.push(JSON.stringify(p)); if (p.v) E.mainSt = { v: p.v, src: null, ask: false }; return Promise.resolve(E.mainSt); },
        accountStatus: () => { E.acctAsked++; return Promise.resolve(null); }, onMainMarket: (fn) => { onMM = fn; }, cancelOAuth: () => {}, cancelAgentLogin: () => {} } },
    };
    vm.createContext(ctx);
    vm.runInContext(msrc.replace(/^const /gm, "var ") + "\nvar enterWorkspace = function (kind, info) { if (mktHold(kind, info)) return; entered.push(kind); };", Object.assign(ctx, { entered: E.entered }));
    E.ctx = ctx; E.push = (st) => onMM(st);
    return E;
  }
  {
    const E = flow(); await E.ctx.mktLoad();
    E.ctx.mktStart();
    ok("②b 新裝按下連線鈕:第二步出來、焦點在「加密」、送 shown 一次、主行程記 shown", E.ctx.MKT.on && E.ids["view-connect"].cls.has("is-mkt") && E.doc.activeElement === E.tiles[0]
      && E.tracked.join() === "mkt_q:shown" && E.calls.includes('{"shown":true}'));
    E.ctx.oauthPending = true; E.ctx.mktPaint();
    ok("②b 等 Blave 登入:狀態行「row.opened」＋〔login.cancel〕", E.ids["cn-mkt-wait"].kids.map((k) => k.textContent).join("|") === "|row.opened||login.cancel");
    E.tiles[2].ls.click();
    ok("②b 還沒連上先點台指期:不進門、格留按下態、送 mkt_q txf、存 { txf, fresh }", E.entered.length === 0 && E.tiles[2].attrs["aria-pressed"] === "true" && E.tiles[0].attrs["aria-pressed"] === "false"
      && E.tracked.includes("mkt_q:txf") && E.calls.includes('{"v":"txf","fresh":true}'));
    E.ctx.oauthPending = false; E.ctx.enterWorkspace("blave", {});
    ok("②b 連上:直接進工作頁、收掉第二步、seal", E.entered.join() === "blave" && !E.ctx.MKT.on && !E.ids["view-connect"].cls.has("is-mkt") && E.calls.includes('{"seal":true}'));
  }
  {
    // 新裝、沒登入:第二步選台指期 → ①的卡馬上照主要市場重挑(wcPaint 由 mktApply 叫,不等下一輪輪詢);設定改值同一條
    const E = flow(), seen = [];
    const free = list.map((x) => Object.assign({}, x, { blave_data: "none" }));
    E.ctx.wcPaint = () => seen.push(L.wcReco(free, { env: "local", signedIn: false, dataAccess: null, wait: false, installed: () => false, mkt: E.ctx.MKT.v }).map((x) => x.id).join());
    await E.ctx.mktLoad();
    E.ctx.mktStart(); E.tiles[2].ls.click();
    ok("②b 新裝沒登入、第二步點台指期:①的卡立刻重挑成三張台指期", seen[seen.length - 1] === "4,5,6", JSON.stringify(seen));
    E.ids["set-mkt"].value = "usstock"; E.ids["set-mkt"].ls.change({ currentTarget: E.ids["set-mkt"] });
    ok("②b 設定 › 一般改成美股:①的卡立刻重挑、美股那支排第一", seen[seen.length - 1].split(",")[0] === "7", JSON.stringify(seen));
  }
  {
    const E = flow(); await E.ctx.mktLoad();
    E.ctx.enterWorkspace("claude", { path: "/x" });
    ok("②b 本機 CLI 已登入、一按就連上:停在第二步、沒有狀態行、沒登入不問帳號", E.entered.length === 0 && E.ctx.MKT.held && E.ctx.MKT.held.kind === "claude" && E.ids["cn-mkt-wait"].kids.length === 0 && E.acctAsked === 0);
    ok("②b 停在第二步時別處的失敗(背景補抓 Codex)不送回第一步", E.ctx.mktBack() === false && E.ctx.MKT.on);
    E.ids["cn-mkt-skip"].ls.click();
    ok("②b 按跳過:存 all、送 skip、進工作頁", E.entered.join() === "claude" && E.tracked.includes("mkt_q:skip") && E.calls.includes('{"v":"all","fresh":true}'));
  }
  {
    const E = flow({ token: true }); await E.ctx.mktLoad();
    E.ctx.enterWorkspace("blave", {});
    ok("②b 登入著連上、還沒答:停在第二步並問一次帳號", E.entered.length === 0 && E.acctAsked === 1);
    E.push({ v: "crypto", src: "a".repeat(32), ask: false });
    ok("②b 帳號已有值(主行程對帳推過來):收掉第二步、直接進", E.entered.join() === "blave" && !E.ctx.MKT.on);
  }
  {
    const E = flow(); await E.ctx.mktLoad();
    E.ctx.mktStart(); E.ctx.loginPending = "claude"; E.ctx.ROWMSG.claude = "opened"; E.ctx.mktPaint();
    ok("②b 等 Claude Code 登入:狀態行同 Blave 那一句＋取消", E.ids["cn-mkt-wait"].kids.map((k) => k.textContent).join("|") === "|row.opened||login.cancel");
    E.ctx.loginPending = null; E.doc.activeElement = E.tiles[1];
    ok("②b 登入失敗:回第一步(回 true)、焦點交給 Blave 那顆", E.ctx.mktBack() === true && !E.ctx.MKT.on && E.doc.activeElement === E.ids["btn-blave"]);
    E.ctx.mktStart();
    ok("②b 沒答的人重連:第二步再出(shown 只送一次)", E.ctx.MKT.on && E.tracked.filter((x) => x === "mkt_q:shown").length === 1);
    E.tiles[1].ls.click(); E.ctx.mktBack();
    E.ctx.mktStart();
    ok("②b 答過再失敗再重連:不再出第二步,連上直接進", !E.ctx.MKT.on && (E.ctx.enterWorkspace("claude", {}), E.entered.join() === "claude"));
  }
  {
    const E = flow(); await E.ctx.mktLoad();
    E.ctx.PKG.snap = { phase: "download", bytes: 120e6, total: 260e6 }; E.ctx.mktStart();
    const first = E.ids["cn-mkt-wait"].kids[1]; E.ctx.mktPaint();
    ok("②b Codex 下載中:狀態行是下載進度、沒有取消鈕;進度沒變不重建", first && first.textContent === "cn.pkgDl" && E.ids["cn-mkt-wait"].kids.length === 3 && E.ids["cn-mkt-wait"].kids[1] === first);
  }
  {
    const E = flow({ st: { ask: false } }); await E.ctx.mktLoad();
    E.ctx.mktStart(); E.ctx.enterWorkspace("claude", {});
    ok("②b 升級上來的舊安裝:不出第二步,連上直接進", !E.tracked.length && E.entered.join() === "claude");
    const F = flow(); await F.ctx.mktLoad(); F.ids["view-connect"].hidden = true;
    F.ctx.mktStart(); F.ctx.enterWorkspace("codex", {});
    ok("②b 連結畫面沒在顯示(設定 › 模型接入換引擎、額度卡的框):不出、不擋", !F.ctx.MKT.on && F.entered.join() === "codex");
  }
  {
    const E = flow({ st: { v: "txf", ask: false } }); E.ctx.LIB = { bags: { local: { mkt: "all" }, cloud: { mkt: "crypto", mktUser: true } } }; E.ctx.WD = { mk: "crypto" };
    await E.ctx.mktLoad();
    ok("②b 讀到 txf:設定列、策略庫沒手動切過的那袋、資料清單跟著;手動切過的那袋不動", E.ids["set-mkt"].value === "txf" && E.ctx.LIB.bags.local.mkt === "txf" && E.ctx.LIB.bags.cloud.mkt === "crypto" && E.ctx.WD.mk === "txf");
    E.ctx.MKT.wdUser = true; E.ids["set-mkt"].ls.change({ currentTarget: { value: "twstock" } });
    ok("②b 設定改成台股:寫本機與帳號、送 mkt_set、資料清單手動切過就不蓋", E.calls.includes('{"v":"twstock"}') && E.tracked.includes("mkt_set:twstock") && E.ctx.LIB.bags.local.mkt === "twstock" && E.ctx.WD.mk === "txf");
    E.ids["set-mkt"].ls.change({ currentTarget: { value: "twstock" } }); E.ids["set-mkt"].ls.change({ currentTarget: { value: "stock" } });
    ok("②b 同值、亂值不送", E.tracked.filter((x) => x.startsWith("mkt_set")).length === 1);
  }

  /* ── ③ 接線 ── */
  const app = read(path.join(R, "app.js")), html = read(path.join(R, "index.html")), mainSrc = read(path.join(SHELL, "main.js")), pre = read(path.join(SHELL, "preload.js"));
  const wel = read(path.join(R, "welcome.js")), tr = read(path.join(R, "trade.js")), css = read(path.join(R, "app.css"));
  const G = (f) => 'typeof ' + f + ' === "function"';
  const has = (x) => app.includes(x);
  ok("③ enterWorkspace 第一行是進門閘", has('function enterWorkspace(kind, info) {\n  if (' + G("mktHold") + ' && mktHold(kind, info)) return;'));
  ok("③ 開始連線的三個入口叫 mktStart(Blave OAuth、連結畫面那一列的登入、Codex 從連結畫面下載)",
    has('waitChanged();\n  if (' + G("mktStart") + ') mktStart();') && has('paintRows(lastDetect); if (' + G("mktStart") + ') mktStart(); }') && has('if (from === "agent-rows" && ' + G("mktStart") + ') mktStart();'));
  ok("③ 失敗／取消回第一步:OAuth 失敗、連結畫面那一列登入沒成、存連線失敗、Codex 下載失敗與沒接上登入",
    has('"blave_oauth" });\n    // 從第二步取消等待') && has('if (' + G("mktBack") + ' && mktBack() && code === "OAUTH_CANCELLED") setHint(null);')
    && has('catch (e) { if (' + G("mktBack") + ') mktBack(); throw e; }') && has('if (PKG.done && PKG.auto === "agent-rows" && ' + G("mktBack") + ') mktBack(); return; }')
    && has('else if (box && box.id === "agent-rows" && ' + G("mktBack") + ') mktBack();') && has('if (inRow && ' + G("mktBack") + ') mktBack();') && has('if (saved === false) {\n    if (' + G("mktBack") + ') mktBack();')
    && has('if (PKG.auto === "agent-rows" && ' + G("mktBack") + ') mktBack();') && has('box.id === "agent-rows" && ' + G("mktBack") + ') mktBack(); return; }')
    && (app.match(/PKG\.auto = null; if \(typeof mktBack === "function"\) mktBack\(\);/g) || []).length === 2);
  ok("③ 狀態行跟著重畫(paintRows、waitChanged、換語言)", has('  if (' + G("mktPaint") + ') mktPaint();   // 第二步卡頂') && has('function waitChanged() { mdlPaint(); acctPaintAcct(); if (' + G("mktPaint") + ') mktPaint(); }')
    && has('cnFreePaint(); if (' + G("mktPaint") + ') mktPaint();'));
  ok("③ 啟動:讀完主要市場才接回上次的連線", app.indexOf("await mktLoad();") > 0 && app.indexOf("await mktLoad();") < app.indexOf("const prev = await window.blave.loadConnection();"));
  ok("③ market.js 緊接在 i18n.js 後面載入(trade.js／library.js／app.js／welcome.js 執行時讀 MKT)", /<script src="i18n\.js"><\/script>\n<script src="market\.js"><\/script>\n/.test(html));
  ok("③ 第二步節點:原大標仍是 #view-connect 第一個 h4(cnFreePaint 寫它)、題目另一個 h4、四格 group 指題目、狀態行 role=status、跳過",
    /<h4 data-i18n="cn\.h\.free"><\/h4>\s*<!--[^>]*-->\s*<p class="cn-step" data-i18n="cn\.mkt\.step"><\/p>\s*<h4 id="cn-mkt-q" data-i18n="cn\.mkt\.q"><\/h4>/.test(html)
    && /<div class="mk-grid" role="group" aria-labelledby="cn-mkt-q">/.test(html) && /<p class="cn-wait" id="cn-mkt-wait" role="status"><\/p>/.test(html)
    && ["crypto|lib.mkt.crypto", "twstock|lib.mkt.tw", "txf|lib.mkt.txf", "usstock|lib.mkt.us"].every((x) => { const [v, k] = x.split("|"); return html.includes('data-mk="' + v + '" aria-pressed="false" data-i18n="' + k + '"'); })
    && /id="cn-mkt-skip" data-i18n="cn\.mkt\.skip"/.test(html) && /class="cn-mkt-foot" data-i18n="cn\.mkt\.foot"/.test(html));
  ok("③ 第二步藏第一步的大標、兩區、尾註那句與語言 segment", /#view-connect\.is-mkt :is\(\.cn-mid > h4:first-of-type, \.cn-sec:not\(\.cn-mkt\), \.cn-foot > p:first-child, \.cn-lang\) \{ display: none; \}/.test(css));
  ok("③ 設定 › 一般:主要市場接在顯示幣別後面,選項順序 不指定、加密、台股、台指期、美股",
    html.indexOf('id="set-mkt"') > html.indexOf('id="set-ccy-err"') && html.indexOf('id="set-mkt"') < html.indexOf('class="set-rn"')
    && /<option value="all" data-i18n="set\.mkt\.all"><\/option>\s*<option value="crypto" data-i18n="lib\.mkt\.crypto"><\/option>\s*<option value="twstock" data-i18n="lib\.mkt\.tw"><\/option>\s*<option value="txf" data-i18n="lib\.mkt\.txf"><\/option>\s*<option value="usstock" data-i18n="lib\.mkt\.us"><\/option>/.test(html));
  ok("③ 歡迎頁:wcReco 帶 mkt、指紋帶 MKT.v;資料清單手動切過就記住;找點子從歡迎頁開帶主要市場",
    /mkt = typeof MKT === "undefined" \? null : MKT\.v;/.test(wel) && /installed: \(s\) => wcInstalled\(s, env\), mkt \}\)/.test(wel) && /skel, mkt, shown\.map/.test(wel) && /MKT\.wdUser = true; wdPaint\(\);/.test(wel)
    && /ideaOpen\(\$\("wf-idea"\), "welcome", libIdeaMkt\(mktLibOf\(MKT\.v\)\)\)/.test(wel) && /"welcome", libIdeaMkt\(mktLibOf\(MKT\.v\)\)\); \}\);/.test(lsrc));
  ok("③ 策略庫:手動切過的袋記 mktUser,mktApply 不蓋", /function libMktPick\(mkt\) \{\s*libMktClose\(true\);\s*if \(mkt === libBag\(\)\.mkt\) return;\s*libBag\(\)\.mktUser = true;[^\n]*\n  libBag\(\)\.mkt = mkt; LIB\.gone = false; libTrack\("lib_mkt_pick"\); libPaint\(\);\s*\}/.test(lsrc) && /if \(!B\.mktUser\) B\.mkt = mktLibOf\(MKT\.v\)/.test(msrc));
  // 0.1.53 連接框改成交易所磚(cxTiles):txf 時台灣期貨那組磚排在加密那組前面,其餘照舊加密在前
  ok("③ 連接帳戶框:txf 時台灣期貨那組磚排在加密那組前面", /const twFirst = typeof MKT !== "undefined" && mktTwFirst\(MKT\.v\);[^\n]*\n  if \(twFirst\) twGroup\(\);\n  group\("crypto", "cx\.group\.crypto", [^\n]*\n  if \(!twFirst\) twGroup\(\);\n  return w;/.test(tr));
  ok("③ 主行程:IPC 兩支、whenReady 第一步判新裝、account_status 回來對帳、preload 三支",
    /handle\("main-market", \(\) => mainMkt\(\)\.get\(\)/.test(mainSrc) && /handle\("main-market-set", \(_e, p\) => mainMktSet\(p\)/.test(mainSrc)
    && /app\.whenReady\(\)\.then\(\(\) => \{\n  if \(app\.hasSingleInstanceLock\(\)\) startStep\("market ask", mktAskInit\);/.test(mainSrc)
    && /syncDataAccess\(a === "included" \|\| a === "billed", true\);\n    try \{ mainMkt\(\)\.reconcile\(who, b\); \}/.test(mainSrc)
    && /mainMarket: \(\) => ipcRenderer\.invoke\("main-market"\)/.test(pre) && /mainMarketSet: \(p\) =>/.test(pre) && /onMainMarket: \(fn\) =>/.test(pre));
  ok("③ 打包清單有 mainmarket.js", /"mainmarket\.js"/.test(read(path.join(SHELL, "electron-builder.config.js"))));
  const T = require(path.join(SHELL, "telemetry.js"));
  ok("③ 埋點:mkt_q／mkt_set 值逐序同 spec §9、畫面送得、每日去重(值同 api desktop_telemetry)",
    JSON.stringify(T.EVENTS.mkt_q) === JSON.stringify({ act: ["shown", "skip", "crypto", "twstock", "txf", "usstock"] }) && JSON.stringify(T.EVENTS.mkt_set) === JSON.stringify({ v: ["all", "crypto", "twstock", "txf", "usstock"] })
    && T.FROM_RENDERER.includes("mkt_q") && T.FROM_RENDERER.includes("mkt_set") && /"mkt_q", "mkt_set"\];\n\/\/ 每日一則/.test(read(path.join(SHELL, "telemetry.js"))));
  const STR = (() => { const sb = {}; vm.runInNewContext(read(path.join(R, "strings.js")) + "\nthis.S = STRINGS;", sb); return sb.S; })();
  const want = { "cn.mkt.step": ["最後一步", "Last Step"], "cn.mkt.q": ["主要做哪個市場？", "Which Market Do You Mainly Trade?"], "cn.mkt.foot": ["之後可以在設定改。", "You can change this in Settings."],
    "cn.mkt.skip": ["跳過", "Skip"], "set.mkt": ["主要市場", "Main market"], "set.mkt.all": ["不指定", "No preference"] };
  ok("③ 字串逐字同 spec §10(zh／en)", Object.entries(want).every(([k, [z, e]]) => STR.zh[k] === z && STR.en[k] === e));
  ok("③ 四格沿用 lib.mkt.*,不新增", STR.zh["lib.mkt.crypto"] === "加密" && STR.zh["lib.mkt.tw"] === "台股" && STR.zh["lib.mkt.txf"] === "台指期" && STR.zh["lib.mkt.us"] === "美股");

  console.log(red ? `\n${red} failed` : "\nall passed");
  process.exit(red ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
