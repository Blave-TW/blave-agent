// 用戶在聊天送出訊息 → 他接手過的 agent 分頁自動交還(第十五批)。
//   ① 不開視窗(視窗、webContents、頁面物件都是假的):哪些交還、哪些留給用戶;交還之後每一道守門都還在;
//      連續兩個回合各接手一次;填到一半的表單不被 agent 的導覽沖掉;agent 動作到一半用戶接手
//   ② 真 Electron(隱藏視窗)+ 本機假頁面:用戶接手、點開頁面上的分頁 → 新回合 agent 讀到的是他改過之後的內容;
//      焦點在密碼欄(含 shadow root 裡的)那一頁不交還
// 跑法:node tests/check_shell_browser_auto_handback.js(② 要 BLAVE_TEST_WINDOW=1)
const path = require("path"), fs = require("fs"), os = require("os"), { EventEmitter } = require("events");
const SHELL = path.join(__dirname, "..", "shell"), B = path.join(SHELL, "browser");
const GATE = require("./_electron_gate");
let red = 0, last = null; const t = (n, ok, d) => { console.log((ok ? "PASS  " : "FAIL  ") + n + (ok ? "" : "  " + JSON.stringify(d === undefined ? last : d).slice(0, 700))); if (!ok) red++; };
const J = (r) => (last = JSON.parse(r.content[0].text));
const SENT = { userSent: true };

if (!process.versions.electron) (async () => {
  const IP = require(path.join(B, "inpage"));
  const SECRET = "PAGE-BODY-TEXT";
  const cdpFile = require.resolve(path.join(B, "cdp"));
  const REAL_CDP = require(cdpFile);   // focused() 的判定要用真的那支(下面把 index.js 看到的 cdp 換成假頁面)
  require.cache[cdpFile] = { id: cdpFile, filename: cdpFile, loaded: true, exports: { createPage: (wc) => {
    const p = {
      entered: [], clicks: 0, fills: 0, disarmed: 0, focusAsked: 0,
      attach: async () => {}, detach: () => {}, guarded: () => false, guard: async () => {}, disarm: async () => { p.disarmed++; }, quiet: async () => {},
      run: async (fn) => { if (fn === IP.dirtyFields) { if (wc._dirty === "throw") throw new Error("x"); return wc._dirty; } return fn === IP.fieldCandidates ? [] : fn === IP.maskFields ? 0 : fn === IP.readable ? 0 : null; },
      focused: async () => { p.focusAsked++; if (wc._focus === "throw") throw new Error("no page"); return typeof wc._focus === "function" ? wc._focus() : wc._focus; },
      extract: async () => { p.entered.push(wc.getURL()); if (wc._during) wc._during(); return { markdown: (SECRET + " " + wc._body + " ").repeat(10), meta: { title: "page" }, headings: [], links: [], blocks: [], view: null }; },
      snapshot: async () => { p.entered.push(wc.getURL()); return { text: "- button " + SECRET, refs: 1, truncated: false }; },
      node: () => 1, describe: async () => wc._desc, center: async () => { if (wc._onCenter) wc._onCenter(); return { x: 5, y: 5, box: { x: 0, y: 0, w: 10, h: 10 } }; },
      click: async () => { p.clicks++; return {}; }, fill: async () => { p.fills++; return {}; },
    };
    wc._page = p; return p;
  } } };

  let wcSeq = 0; const wcs = [];
  const BODY = { backendNodeId: 1, desc: { tag: "body", inForm: false } };   // 焦點不在任何欄位(判得出、可交還)
  class FakeView {
    constructor() {
      const wc = new EventEmitter(); let url = "";
      Object.assign(wc, { id: ++wcSeq, _body: "first", _focus: BODY, _dirty: 0, _desc: null, _loads: [], _backs: 0, setAudioMuted() {}, setWindowOpenHandler() {}, getURL: () => url, _go: (u) => { url = u; }, getTitle: () => "title of " + url, isDestroyed: () => false, isLoading: () => false,
        loadURL: async (u) => { wc._loads.push(u); url = u; }, close() {}, stop() {}, navigationHistory: { canGoBack: () => true, goBack: () => { wc._backs++; } },
        debugger: { sendCommand: async () => ({ data: Buffer.from("img").toString("base64") }) } });
      this.webContents = wc; wcs.push(wc); this._b = { x: 20000, y: 0, width: 1280, height: 800 };
    }
    getBounds() { return this._b; }
    setBounds(b) { this._b = b; }
  }
  const ses = { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDevicePermissionHandler() {}, on() {}, webRequest: { onBeforeRequest() {}, onResponseStarted() {} } };
  const fakeE = { WebContentsView: FakeView, session: { fromPartition: () => ses }, nativeImage: { createFromBuffer: () => ({ getSize: () => ({ width: 10, height: 10 }) }) }, net: {} };
  const sent = [];
  const win = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, contentView: { addChildView() {}, removeChildView() {} }, webContents: { send: (_ch, ev) => sent.push(ev), getZoomFactor: () => 1 } };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blave-autohb-"));
  const SID = "desktop-autohb1", OTHER = "desktop-autohb2";
  const Br = require(path.join(B, "index.js")).createBrowser({ electron: fakeE, stateDir: path.join(tmp, "snaps"), reportsDir: path.join(tmp, "reports"), getWin: () => win, uiLang: () => "en", track: () => {}, version: "test", reducedMotion: () => true, userPresent: () => true });
  const call = (n, a) => Br._call(n, a || {}, { live: () => true });
  const turn = async (sid, opts) => { Br.endTurn(); const at = sent.length; await Br.beginTurn(win, sid || SID, opts === undefined ? SENT : opts); return sent.slice(at); };
  const backs = (evs, x) => evs.filter((e) => e.type === "handback" && e.id === x.tab.id);
  const row = async (x) => J(await call("browser_tabs")).tabs.find((r) => r.tab === x.alias);
  let host = 0;
  const open = async () => {
    const url = "https://site-" + (++host) + ".com/page";
    const o = J(await call("browser_open", { url }));
    if (!o.ok) throw new Error("browser_open: " + JSON.stringify(o));
    const tab = Br._tabs.byAlias(o.tab), wc = wcs[wcs.length - 1];
    const x = { alias: o.tab, url, tab, wc, page: wc._page, land: (u) => { wc._go(u); wc.emit("did-navigate", {}, u, 200); wc.emit("did-stop-loading"); } };
    x.land(url); return x;
  };
  const kept = async (name, x, evs, want) => {
    x.page.entered.length = 0;
    const r = J(await call("browser_read", { tab: x.alias }));
    t("不交還:" + name + " → 還是「你在操作」、沒發 handback、agent 碰它回 " + want + "、沒進頁面", x.tab.userControl === true && backs(evs, x).length === 0 && r.ok === false && r.error === want
      && x.page.entered.length === 0 && !JSON.stringify(r).includes(SECRET), [x.tab.userControl, backs(evs, x), r]);
  };
  const MAIL = "https://mail.google.com/mail/u/0/", SORRY = "https://www.google.com/sorry/index?continue=https://www.google.com/search%3Fq%3Dx";

  // ---- 1. 交還:agent 開的、用戶接手中的分頁,用戶送出訊息的新回合一開始就還回來
  await Br.beginTurn(win, SID, SENT);
  const a = await open();
  J(await call("browser_read", { tab: a.alias }));
  Br.takeover(a.tab.id); a.wc._body = "second";   // 用戶接手、點開了別的區塊
  t("接手中:agent 碰它回 user_in_control", J(await call("browser_read", { tab: a.alias })).error === "user_in_control");
  let evs = await turn();
  const hb = backs(evs, a);
  t("交還:新回合開始時發既有的 handback 事件、帶 auto: true、帶這個對話的 session_id,而且只發一次", hb.length === 1 && hb[0].auto === true && hb[0].session_id === SID && a.tab.userControl === false, evs);
  t("交還:在任何工具呼叫之前就發了(beginTurn 回來時已經交還)", evs.every((e) => e.type !== "block_open"));
  let r = J(await call("browser_read", { tab: a.alias }));
  t("交還之後:同一個代號讀得到用戶改過之後的內容", r.ok === true && r.tab === a.alias && r.untrusted_content.includes("second"), r);
  t("交還之後:browser_tabs 不再標 user_control,帶網址與標題", (await row(a)).status === "ready" && last.tabs.find((x) => x.tab === a.alias).url === a.url);
  t("手動按「交還 agent」的事件不帶 auto(照舊)", (() => { Br.takeover(a.tab.id); const at = sent.length; Br.handback(a.tab.id); const e = sent.slice(at).find((x) => x.type === "handback"); return !!e && e.auto === undefined; })());

  // ---- 2a. 用戶自己開的分頁:不動
  const u = Br.showLive("https://user-own.example.org/page"), ut = Br._tabs.get(u.id);
  Br.takeover(u.id);
  evs = await turn();
  t("不交還:用戶自己開的分頁 → 不動、沒發事件、沒有代號、browser_tabs 不列", ut.by === "user" && ut.userControl === true && ut.alias === null && !evs.some((e) => e.type === "handback" && e.id === u.id)
    && !JSON.stringify(J(await call("browser_tabs"))).includes("user-own"), [ut, evs]);
  t("  而且沒有問過那一頁的焦點(那一頁不跑任何東西)", wcs[wcs.length - 1]._page.focusAsked === 0);
  Br._tabs.close(u.id);

  // ---- 2b. 驗證頁:永不自動交還
  const v1 = await open(), v2 = await open();
  Br.endTurn();
  v1.tab.verify = "google"; Br.takeover(v1.tab.id);      // 搜尋時認出來的驗證頁,用戶在回合之間點了它
  v2.wc._go(SORRY); Br.takeover(v2.tab.id);             // 當下網址就是驗證頁
  evs = await turn();
  await kept("驗證頁(t.verify)", v1, evs, "needs_user_verification");
  await kept("驗證頁(當下網址判定)", v2, evs, "needs_user_verification");
  t("  驗證頁沒有問過焦點(那一頁不跑任何東西)", v1.page.focusAsked === 0 && v2.page.focusAsked === 0);
  v1.tab.verify = null; v2.wc._go(v2.url);
  evs = await turn();
  t("對照:不再是驗證頁 → 下一輪交還", backs(evs, v1).length === 1 && backs(evs, v2).length === 1 && !v1.tab.userControl && !v2.tab.userControl);
  Br._tabs.close(v1.tab.id); Br._tabs.close(v2.tab.id);

  // ---- 2c. 焦點在敏感欄位:這一頁不交還(判定就是 gate.sensitiveField)
  const s = await open();
  const FIELDS = [["密碼欄", { tag: "input", type: "password" }], ["一次性驗證碼", { tag: "input", type: "text", autocomplete: "one-time-code" }], ["卡號", { tag: "input", type: "text", autocomplete: "cc-number" }],
    ["身分證號", { tag: "input", type: "text", label: "身分證字號" }], ["iframe 裡(金流商的卡號欄,看不進去)", { tag: "iframe" }]];
  for (const [name, desc] of FIELDS) {
    Br.takeover(s.tab.id); s.wc._focus = { backendNodeId: 1, desc };
    evs = await turn();
    await kept("焦點在" + name, s, evs, "user_in_control");
  }
  t("  user_in_control 的訊息照第十三批:請用戶按「交還 agent」", /Hand back to agent/.test(last.message) && /交還 agent/.test(last.message));
  s.wc._focus = "throw";
  evs = await turn();
  await kept("問不到焦點(頁面沒回應)", s, evs, "user_in_control");
  // 稽核 P1-2:判不出的一律不交還(fail-closed)
  Br.takeover(s.tab.id); s.wc._focus = null;
  evs = await turn();
  await kept("問到的是 null(頁面沒有 activeElement / evaluate 沒回物件)", s, evs, "user_in_control");
  Br.takeover(s.tab.id); s.wc._focus = { backendNodeId: 1, desc: { tag: "x-login", opaque: true } };
  evs = await turn();
  await kept("焦點停在 closed shadow root 的宿主(看不進去,裡面可能是密碼欄)", s, evs, "user_in_control");
  Br.takeover(s.tab.id); s.wc._focus = { backendNodeId: 1, desc: {} };
  evs = await turn();
  await kept("問到的描述是空的(判不出)", s, evs, "user_in_control");
  for (const type of ["keyDown", "mouseDown", "char"]) {
    Br.takeover(s.tab.id); s.wc._focus = () => { s.wc.emit("input-event", {}, { type }); return BODY; };   // 問焦點的這段時間他又在這一頁動手
    evs = await turn();
    await kept("等焦點的期間用戶又動手(" + type + ")", s, evs, "user_in_control");
  }
  Br.takeover(s.tab.id); s.wc._focus = () => { s.wc.emit("input-event", {}, { type: "mouseMove" }); return BODY; };
  evs = await turn();
  t("對照:等待期間只有滑鼠移動(不算動手)→ 照常交還", backs(evs, s).length === 1 && !s.tab.userControl, evs);
  Br.takeover(s.tab.id);
  s.wc._focus = { backendNodeId: 1, desc: { tag: "input", type: "text", label: "Search" } };
  evs = await turn();
  t("對照:焦點移到一般欄位 → 下一輪交還、讀得到", backs(evs, s).length === 1 && J(await call("browser_read", { tab: s.alias })).ok === true);
  s.wc._focus = BODY;
  Br.takeover(s.tab.id); evs = await turn();
  t("對照:焦點不在任何欄位(body)→ 交還", backs(evs, s).length === 1 && !s.tab.userControl);
  t("敏感欄位的判定沿用 gate.sensitiveField(沒有另寫一套)", (() => { const src = fs.readFileSync(path.join(B, "index.js"), "utf8"); const i = src.indexOf("async function handable("); return /gate\.sensitiveField\(f\.desc\)/.test(src.slice(i, i + 900)); })());
  t("按鍵的分級:焦點在 closed shadow root 的宿主上 → 跟 iframe 一樣交給用戶", (() => { const G = require(path.join(B, "gate")); const r = G.classify("press", { tag: "x-login", opaque: true, inForm: false }, "Enter"); return r.ok === false && r.error === "needs_user"; })());
  // cdp.js focused():closed shadow root 頁內走不進去(e.shadowRoot 是 null),靠 DOM.describeNode 的 shadowRoots 標 opaque
  { const focusedWith = async (node) => {
      const dbg = { isAttached: () => true, attach() {}, on() {}, sendCommand: async (m) => ({ "Page.getFrameTree": { frameTree: { frame: { id: "f" } } }, "Page.createIsolatedWorld": { executionContextId: 7 },
        "Runtime.evaluate": { result: { objectId: "o1" } }, "DOM.describeNode": { node }, "DOM.resolveNode": { object: { objectId: "o2" } }, "Runtime.callFunctionOn": { result: { value: { tag: node.nodeName.toLowerCase(), inForm: false } } }, "Runtime.releaseObject": {} })[m] };
      return REAL_CDP.createPage({ debugger: dbg }).focused(); };
    const closed = await focusedWith({ backendNodeId: 5, nodeName: "X-LOGIN", shadowRoots: [{ nodeName: "#document-fragment", shadowRootType: "closed" }] });
    const open = await focusedWith({ backendNodeId: 5, nodeName: "X-LOGIN", shadowRoots: [{ nodeName: "#document-fragment", shadowRootType: "open" }] });
    const plain = await focusedWith({ backendNodeId: 5, nodeName: "INPUT" });
    t("focused():宿主帶 closed shadow root → desc.opaque;open 的(頁內已經走進去過)與一般元素不標", closed.desc.opaque === true && closed.desc.tag === "x-login" && open.desc.opaque === undefined && plain.desc.opaque === undefined, [closed, open, plain]); }

  // ---- 2d. 別的對話的分頁:不動
  Br.takeover(s.tab.id);
  evs = await turn(OTHER);
  t("不交還:別的對話送出訊息 → 這個對話的分頁不動、沒發事件、沒問焦點", s.tab.userControl === true && backs(evs, s).length === 0 && J(await call("browser_read", { tab: s.alias })).error === "not_found", evs);
  const o1 = await open(); Br.takeover(o1.tab.id);
  evs = await turn(SID);
  t("回到原來的對話:自己的分頁交還;另一個對話的那一頁不動", backs(evs, s).length === 1 && !s.tab.userControl && o1.tab.userControl === true && backs(evs, o1).length === 0, evs);
  Br._tabs.close(o1.tab.id);

  // ---- 2e. 沒有用戶在場的回合
  Br.takeover(s.tab.id);
  evs = await turn(SID, { userSent: true, noUser: true });
  await kept("從雲端視角送出的回合(noUser)", s, evs, "user_in_control");
  evs = await turn(SID, { noUser: false });
  await kept("沒有標明是用戶送出的回合(排程之類;沒帶 userSent)", s, evs, "user_in_control");
  evs = await turn(SID, null);
  await kept("beginTurn 沒帶 opts", s, evs, "user_in_control");
  evs = await turn();
  t("對照:用戶在這台電腦送出 → 交還", backs(evs, s).length === 1 && !s.tab.userControl);

  // ---- 2f. 當下網址屬於被擋的網域:不交還;手動交還也照樣被網址政策擋
  Br.takeover(s.tab.id); s.wc._go(MAIL);   // 登入後落在帳戶頁
  evs = await turn();
  await kept("當下網址 agent 不能去", s, evs, "blocked_policy");
  t("  回的是被擋(不是叫用戶按交還——按了也沒用),只帶主機名", last.reason !== undefined && !JSON.stringify(last).includes("/mail/u/0") && !/Hand back/.test(last.message), last);
  t("  browser_tabs:那一頁只回主機名、不回標題", (await row(s)).title === "" && !/\//.test(last.tabs.find((x) => x.tab === s.alias).url));
  Br.handback(s.tab.id); s.page.entered.length = 0;
  for (const tool of ["browser_read", "browser_snapshot", "browser_screenshot"]) { r = J(await call(tool, { tab: s.alias })); t("交還不會繞過網址政策:" + tool + " → blocked_policy,沒進頁面", r.ok === false && r.error === "blocked_policy" && s.page.entered.length === 0 && !JSON.stringify(r).includes(SECRET), r); }
  s.wc._go(s.url);

  // ---- 3. 交還之後的守門一條都不少
  Br.takeover(s.tab.id); evs = await turn();
  t("(準備)交還了", backs(evs, s).length === 1);
  s.wc._during = () => s.wc._go(MAIL);   // 讀到一半頁面轉去 agent 不能去的網址
  r = J(await call("browser_read", { tab: s.alias }));
  t("交還之後:讀取前後重判照舊(讀的那段時間落到被擋的網址 → 不交內容)", r.ok === false && r.error === "blocked_policy" && !JSON.stringify(r).includes(SECRET), r);
  s.wc._during = null; s.wc._go(s.url);
  s.wc._desc = { tag: "input", type: "password", inForm: true };
  for (const tool of ["browser_fill", "browser_type"]) { r = J(await call(tool, { tab: s.alias, ref: "@e1", text: "x" })); t("交還之後:" + tool + " 密碼欄 → sensitive_field,沒填", r.ok === false && r.error === "sensitive_field" && s.page.fills === 0, r); }
  s.wc._desc = { tag: "input", type: "text", autocomplete: "one-time-code" };
  r = J(await call("browser_get", { tab: s.alias, what: "value", ref: "@e1" }));
  t("交還之後:驗證碼欄 browser_get value → 空", r.ok === true && r.untrusted_content === "", r);
  for (const [name, desc, kind] of [["登入鈕", { tag: "button", name: "Sign in", text: "Sign in" }, "action"], ["購買鈕", { tag: "button", name: "Buy now", text: "Buy now" }, "action"], ["送出表單", { tag: "button", name: "Next", text: "Next", isSubmit: true, inForm: true, formMethod: "post" }, "submit"]]) {
    s.wc._desc = desc; const at = sent.length;
    r = J(await call("browser_click", { tab: s.alias, ref: "@e1" }));
    t("交還之後:點" + name + " → needs_user(" + kind + "),沒按下去", r.ok === false && r.error === "needs_user" && r.kind === kind && s.page.clicks === 0 && sent.slice(at).some((e) => e.type === "need_user"), r);
    Br.userDone(s.tab.id, "skip");
  }
  s.wc._go(SORRY);
  t("交還之後:那一頁變成驗證頁 → needs_user_verification", J(await call("browser_snapshot", { tab: s.alias })).error === "needs_user_verification");
  s.wc._go(s.url);

  // ---- 連續兩個回合各接手一次
  const c = await open();
  for (const n of [1, 2]) {
    Br.takeover(c.tab.id); c.wc._body = "round-" + n;
    t("第 " + n + " 次接手:這一輪 agent 碰它回 user_in_control", J(await call("browser_read", { tab: c.alias })).error === "user_in_control");
    evs = await turn();
    r = J(await call("browser_read", { tab: c.alias }));
    t("第 " + n + " 次接手之後的新回合:交還一次、同一個代號讀到他那一次改的內容", backs(evs, c).length === 1 && r.ok === true && r.untrusted_content.includes("round-" + n) && Br._tabs.byAlias(c.alias) === c.tab, r);
  }
  evs = await turn();
  t("沒有人接手的回合:不發 handback", !evs.some((e) => e.type === "handback"), evs);

  // ---- 4a. 用戶填到一半的表單:agent 在那一格導覽(會沖掉)→ needs_user
  const f = await open();
  Br.takeover(f.tab.id);
  f.wc.emit("input-event", {}, { type: "keyDown" });   // 用戶在這一頁打字
  f.wc._dirty = 2;
  evs = await turn();
  t("(準備)填到一半的那一頁照樣交還、讀得到", backs(evs, f).length === 1 && J(await call("browser_read", { tab: f.alias })).ok === true);
  const loads = f.wc._loads.length, at4 = sent.length;
  r = J(await call("browser_open", { url: f.url, tab: f.alias }));
  t("填到一半:browser_open 到同一格(重新載入)→ needs_user、講了原因與出路、沒有導覽、沒有跳請求卡", r.ok === false && r.error === "needs_user" && r.kind === "unsaved_input" && /typed into a form/.test(r.message) && /new tab/.test(r.message)
    && f.wc._loads.length === loads && !sent.slice(at4).some((e) => e.type === "need_user"), r);
  r = J(await call("browser_open", { url: "https://elsewhere.example.com/", tab: f.alias }));
  t("填到一半:browser_open 把這一格導去別處 → needs_user、沒有導覽", r.error === "needs_user" && r.kind === "unsaved_input" && f.wc._loads.length === loads, r);
  r = J(await call("browser_back", { tab: f.alias }));
  t("填到一半:browser_back → needs_user、沒有回上一頁", r.error === "needs_user" && r.kind === "unsaved_input" && f.wc._backs === 0, r);
  r = J(await call("browser_open", { url: "https://elsewhere.example.com/" }));
  t("出路:同一個網址開在新分頁照常", r.ok === true && r.tab !== f.alias, r);
  f.wc._dirty = "throw";
  t("問不到欄位(頁面沒回應)→ 當成有,不導覽", J(await call("browser_open", { url: f.url, tab: f.alias })).kind === "unsaved_input" && f.wc._loads.length === loads);
  f.wc._dirty = 0;
  t("對照:用戶打過字、但欄位都空了(他送出了、或清掉了)→ 照常導覽", J(await call("browser_open", { url: f.url, tab: f.alias })).ok === true && f.wc._loads.length === loads + 1);
  f.land(f.url); f.wc._dirty = 3;
  t("對照:換了一份文件之後(用戶沒在新的這一頁打過字)→ 照常導覽", J(await call("browser_open", { url: f.url, tab: f.alias })).ok === true && f.wc._loads.length === loads + 2);
  const g = await open(); g.wc._dirty = 1;
  t("對照:用戶沒打過字的頁(欄位是 agent 自己填的)→ 照常導覽", J(await call("browser_open", { url: g.url, tab: g.alias })).ok === true);
  t("只回數量不回值:dirtyFields 不含欄位內容", (() => { const doc = { querySelectorAll: () => [{ tagName: "INPUT", type: "text", value: "typed-by-user", defaultValue: "" }, { tagName: "INPUT", type: "hidden", value: "csrf", defaultValue: "" }, { tagName: "INPUT", type: "search", value: "q", defaultValue: "" },
    { tagName: "INPUT", type: "text", value: "same", defaultValue: "same" }, { tagName: "TEXTAREA", value: "note", defaultValue: "" }, { tagName: "INPUT", type: "text", value: "ro", defaultValue: "", readOnly: true }, { tagName: "INPUT", type: "password", value: "pw", defaultValue: "" }] };
    const n = new Function("document", IP.dirtyFields.toString() + "; return dirtyFields();")(doc); return n === 3; })());

  // ---- 4b. agent 動作到一半用戶又點了那一頁:乾淨地收到 user_in_control
  const k = await open();
  Br.expand(k.tab.id, { x: 0, y: 0, width: 800, height: 600 });
  k.wc._desc = { tag: "button", name: "Show more", text: "Show more" };
  k.wc._onCenter = () => k.wc.emit("input-event", {}, { type: "mouseDown" });   // agent 量位置的時候用戶點了這一頁
  const atK = sent.length;
  r = J(await call("browser_click", { tab: k.alias, ref: "@e1" }));
  const evK = sent.slice(atK);
  t("動作到一半被接手:工具回 user_in_control,沒有按下去", r.ok === false && r.error === "user_in_control" && k.page.clicks === 0 && k.tab.userControl === true, r);
  t("  沒留半套:守門收掉、agent 窗口收掉、沒有請求卡、分頁沒有 need、畫面收到 user_takeover", k.page.disarmed >= 1 && Br._agentActive(k.tab.id) === false && !evK.some((e) => e.type === "need_user") && !k.tab.need && evK.some((e) => e.type === "user_takeover" && e.id === k.tab.id), evK);
  k.wc._onCenter = null; k.wc._desc = { tag: "input", type: "text", label: "Note" };
  Br.handback(k.tab.id);
  await new Promise((res) => setTimeout(res, 700));   // agent 自己的輸入之後 600ms 內的事件不算用戶的(index.js input-event)
  k.wc._onCenter = () => k.wc.emit("input-event", {}, { type: "keyDown" });
  r = J(await call("browser_fill", { tab: k.alias, ref: "@e1", text: "x" }));
  t("填字到一半被接手:user_in_control,沒有填", r.error === "user_in_control" && k.page.fills === 0, r);
  k.wc._onCenter = null;
  evs = await turn();
  r = J(await call("browser_click", { tab: k.alias, ref: "@e1" }));
  t("下一輪:交還,同一個動作照常做得了", backs(evs, k).length === 1 && r.ok === true && k.page.clicks === 1, r);
  Br.endTurn();

  // ---- 原文鎖
  const idx = fs.readFileSync(path.join(B, "index.js"), "utf8"), main = fs.readFileSync(path.join(SHELL, "main.js"), "utf8");
  t("掛點:beginTurn 裡、tabs.newTurn 之後;要 userSent 而且不是 noUser", /tabs\.newTurn\(sessionId\);\n[^\n]*\n\s*if \(opts && opts\.userSent === true && !cur\.noUser\) await autoHandback\(cur\);/.test(idx));
  t("只看這個對話 agent 指得到的分頁(tabs.reachable),而且只認 by === \"agent\";問焦點前後比一次用戶輸入的時間戳", /for \(const t of tabs\.reachable\(\)\) \{\n\s*if \(t\.by !== "agent" \|\| !t\.userControl\) continue;\n[^\n]*\n\s*const touched = v\.userInputs \|\| 0;\n\s*if \(!\(await handable\(t\)\)\) continue;\n[^\n]*\n\s*if \(cur === c && t\.userControl && \(v\.userInputs \|\| 0\) === touched\) handback\(t\.id, true\);/.test(idx));
  t("handable 是 fail-closed:問不到、null、看不進去(iframe / opaque)、敏感欄位都回 false", (() => { const h = idx.slice(idx.indexOf("async function handable("), idx.indexOf("async function autoHandback(")); return /catch \(_\) \{ return false; \}/.test(h) && /if \(!f \|\| !f\.desc \|\| !f\.desc\.tag\) return false;/.test(h) && /f\.desc\.tag === "iframe" \|\| f\.desc\.opaque \|\| gate\.sensitiveField\(f\.desc\)\) return false;/.test(h); })());
  t("main.js:只有 send-message(用戶送出)會起回合,而且標了 userSent", (main.match(/\brunTurn\(/g) || []).length === 2 && /ipcMain\.handle\("send-message"[\s\S]{0,2500}runTurn\(win, payload\)/.test(main)
    && /beginTurn\(win, sessionId, \{ userSent: true, noUser: !!viewing && viewing\.env === "cloud" \}\)/.test(main));
  t("verify.js 檔頭(紅線)沒動", /^\/\/ /.test(fs.readFileSync(path.join(B, "verify.js"), "utf8")) && require("child_process").spawnSync("git", ["diff", "--quiet", "8bb6aaa", "--", "shell/browser/verify.js"], { cwd: path.join(__dirname, "..") }).status === 0);

  // ---- 規則文字(references/browser.md)
  const md = fs.readFileSync(path.join(__dirname, "..", "references", "browser.md"), "utf8");
  const i0 = md.indexOf("## Tabs from earlier turns"), carry = md.slice(i0, md.indexOf("\n## ", i0 + 1));
  t("規則:用戶送出訊息時他接手過的分頁自動交還;他說處理好了就直接讀,不要請他按交還", /handed back to you by itself/.test(carry) && /read that tab first/.test(carry) && /do not ask them to hand it back/.test(carry), carry);
  t("規則:用戶剛操作過的頁先讀,不重新載入、不導去別處、不回上一頁", /read it before anything else/.test(carry) && /never reload it, go back in it or send it to another address/.test(carry) && /kind: "unsaved_input"/.test(carry), carry);
  const uic = (md.split("\n").find((l) => l.startsWith("On `user_in_control`")) || "");
  t("規則:「請用戶按交還 agent」只適用於仍然回 user_in_control 的分頁(焦點在密碼欄之類、這一輪中途接手)", /was not handed back/.test(uic) && /password, code or card field/.test(uic) && /during this turn/.test(uic) && /Hand back to agent/.test(uic) && /Say exactly that in the reply/.test(uic), uic);
  t("規則檔只有英文(引給用戶看的那幾句除外)", !/[一-鿿]/.test(carry.replace(/「[^」]*」/g, "")) && !/[一-鿿]/.test(uic.replace(/「[^」]*」/g, "").replace(/\(交還 agent\)/g, "")));

  fs.rmSync(tmp, { recursive: true, force: true });
  const bin = GATE.bin(SHELL, "②");
  if (!bin) { console.log(red ? `\n${red} FAILED` : "\nALL PASS"); process.exit(red ? 1 : 0); }
  const x = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit", env: { ...process.env, ELECTRON_ENABLE_LOGGING: "" } });
  const code = (x.status == null ? 1 : x.status) || (red ? 1 : 0);
  console.log(code ? "\nFAILED" : "\nALL PASS"); process.exit(code);
})().catch((e) => { console.log("FAIL  " + (e && e.stack) + "\n      last: " + JSON.stringify(last).slice(0, 500)); process.exit(1); });
else {
  const electron = require("electron");
  const { app, BrowserWindow, session } = electron;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blave-autohb-e-"));
  app.setPath("userData", tmp);
  const FILL = Array.from({ length: 6 }, (_, i) => "<p>Paragraph " + i + " of the page, long enough to count as real text for the reader.</p>").join("");
  const TABS = "<!doctype html><title>Strategy</title><button id=a onclick=\"show('OVERVIEW-PANE')\">Overview</button><button id=b onclick=\"show('SOURCE-CODE-PANE')\">Source code</button>"
    + "<article><h1>Strategy</h1><p id=pane>OVERVIEW-PANE is showing now, with enough words in it to be read as the body of this page.</p>" + FILL + "</article>"
    + "<script>function show(x){document.getElementById('pane').textContent=x+' is showing now, with enough words in it to be read as the body of this page.'}</script>";
  const LOGIN = "<!doctype html><title>Sign in</title><article><h1>Sign in</h1>" + FILL + "</article><form method=post action=/login><label>User <input id=u name=user></label><label>Password <input id=p type=password name=pw></label><button>Sign in</button></form>";
  const SHADOW = "<!doctype html><title>Shadow</title><article><h1>Shadow</h1>" + FILL + "</article><div id=host></div><script>const r=document.getElementById('host').attachShadow({mode:'open'});r.innerHTML='<input id=sp type=password>';</script>";
  // closed shadow root:頁內腳本走不進去(host.shadowRoot 是 null),裡面的密碼欄只有 CDP 看得到;宿主是自訂元素
  const CLOSED = "<!doctype html><title>Closed</title><article><h1>Closed</h1>" + FILL + "</article><x-login id=host></x-login><input id=plain>"
    + "<script>const r=document.getElementById('host').attachShadow({mode:'closed'});r.innerHTML='<input id=cp type=password>';window.__cp=r.getElementById('cp');</script>";
  const hits = [];
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ width: 1200, height: 800, show: false });
    await win.loadURL("data:text/html,<p>host</p>");
    const srv = require("http").createServer((req, res) => {
      const u = new URL(req.url, "http://" + req.headers.host); hits.push(req.method + " " + u.host + u.pathname);
      res.writeHead(200, { "content-type": "text/html" });
      res.end(u.pathname === "/tabs" ? TABS : u.pathname === "/login" ? LOGIN : u.pathname === "/shadow" ? SHADOW : u.pathname === "/closed" ? CLOSED : "<title>x</title><p>x</p>");
    });
    srv.on("connect", (_req, sock) => sock.destroy());   // https 一律不出去
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const ses = session.fromPartition("persist:agent-browser");
    await ses.setProxy({ proxyRules: "http=127.0.0.1:" + srv.address().port + ";https=127.0.0.1:" + srv.address().port, proxyBypassRules: "<-loopback>" });
    const sent = []; const realSend = win.webContents.send.bind(win.webContents);
    win.webContents.send = (ch, ev) => { if (ch === "browser-event") sent.push(ev); return realSend(ch, ev); };
    const Br = require(path.join(SHELL, "browser")).createBrowser({ electron, stateDir: path.join(tmp, "snaps"), reportsDir: path.join(tmp, "reports"), getWin: () => win, uiLang: () => "en", track: () => {}, version: "test", reducedMotion: () => true, userPresent: () => true });
    const SID = "desktop-autohbe1";
    const call = (n, a) => Br._call(n, a || {}, { live: () => true });
    const wcOf = (frag) => electron.webContents.getAllWebContents().find((w) => w.getURL().includes(frag));
    const turn = async () => { Br.endTurn(); const at = sent.length; await Br.beginTurn(win, SID, SENT); return sent.slice(at); };
    const openWait = async (url) => { const o = J(await call("browser_open", { url })); await call("browser_wait", { tab: o.tab }); return { alias: o.tab, tab: Br._tabs.byAlias(o.tab), wc: wcOf(url.replace("http://", "")) }; };
    await Br.beginTurn(win, SID, SENT);

    // a. 用戶接手、點開「Source code」那個分頁 → 新回合 agent 讀到他改過之後的內容
    const p = await openWait("http://hb1.test/tabs");
    let r = J(await call("browser_read", { tab: p.alias }));
    t("a 第一輪:agent 讀到的是預設那一面(Overview)", r.ok === true && /OVERVIEW-PANE/.test(r.untrusted_content) && !/SOURCE-CODE-PANE/.test(r.untrusted_content), r);
    Br.takeover(p.tab.id);
    await p.wc.executeJavaScript("document.getElementById('b').click()");   // 用戶點開了另一面
    r = J(await call("browser_read", { tab: p.alias }));
    t("a 用戶接手中:user_in_control,拿不到內容", r.ok === false && r.error === "user_in_control" && !JSON.stringify(r).includes("PANE"), r);
    let evs = await turn();
    t("a 用戶送出訊息的新回合:那一頁自動交還(handback auto: true)", evs.filter((e) => e.type === "handback" && e.id === p.tab.id && e.auto === true).length === 1 && p.tab.userControl === false, evs);
    r = J(await call("browser_tabs"));
    t("a browser_tabs:同一個代號、標 from_previous_turn、狀態 ready", (() => { const x = r.tabs.find((y) => y.tab === p.alias); return !!x && x.from_previous_turn === true && x.status === "ready" && x.title === "Strategy"; })(), r);
    r = J(await call("browser_read", { tab: p.alias }));
    t("a agent 讀到的是用戶改過之後的內容(Source code),不是原本那一面", r.ok === true && /SOURCE-CODE-PANE/.test(r.untrusted_content) && !/OVERVIEW-PANE/.test(r.untrusted_content), r);
    t("a 沒有重新載入那一頁(伺服器只收到一次)", hits.filter((h) => h === "GET hb1.test/tabs").length === 1, hits);

    // b. 焦點在密碼欄:不交還;焦點移開之後才交還,而且密碼讀不到
    const q = await openWait("http://hb2.test/login");
    Br.takeover(q.tab.id);
    await q.wc.executeJavaScript("(() => { const u = document.getElementById('u'), p = document.getElementById('p'); u.value = 'wei'; p.value = 'hunter2-secret'; p.focus(); return document.activeElement.id; })()");
    evs = await turn();
    r = J(await call("browser_read", { tab: q.alias }));
    t("b 焦點在密碼欄:新回合不交還、沒發 handback、agent 碰它回 user_in_control", q.tab.userControl === true && !evs.some((e) => e.type === "handback" && e.id === q.tab.id) && r.ok === false && r.error === "user_in_control" && !JSON.stringify(r).includes("hunter2"), [evs, r]);
    const tabsNow = await call("browser_tabs");
    t("b browser_tabs:那一頁標 user_control、只回主機名", (() => { const x = J(tabsNow).tabs.find((y) => y.tab === q.alias); return x.status === "user_control" && x.url === "hb2.test" && x.title === ""; })(), last);
    await q.wc.executeJavaScript("document.getElementById('u').focus()");
    evs = await turn();
    t("b 焦點移到帳號欄:下一輪交還", evs.some((e) => e.type === "handback" && e.id === q.tab.id && e.auto === true) && q.tab.userControl === false, evs);
    r = J(await call("browser_snapshot", { tab: q.alias }));
    const snap = r.untrusted_content || "";
    t("b 交還之後:snapshot 讀不到密碼欄的值", r.ok === true && /Password/.test(snap) && !snap.includes("hunter2"), r);
    const ref = (re) => { const x = snap.split("\n").find((l) => re.test(l)); const m = x && x.match(/\[(@e\d+)\]/); return m ? m[1] : null; };
    r = J(await call("browser_fill", { tab: q.alias, ref: ref(/textbox "Password"/), text: "x" }));
    t("b 交還之後:密碼欄 fill → sensitive_field", r.ok === false && r.error === "sensitive_field", r);
    r = J(await call("browser_get", { tab: q.alias, what: "value", ref: ref(/textbox "Password"/) }));
    t("b 交還之後:密碼欄 browser_get value → 空", r.ok === true && r.untrusted_content === "", r);
    r = J(await call("browser_click", { tab: q.alias, ref: ref(/button "Sign in"/) }));
    t("b 交還之後:登入鈕 → needs_user,伺服器沒收到 POST", r.ok === false && r.error === "needs_user" && !hits.some((h) => h.startsWith("POST")), [r, hits]);
    t("b 密碼還在欄位裡(agent 沒有動到用戶填的東西)", (await q.wc.executeJavaScript("document.getElementById('p').value")) === "hunter2-secret");
    Br.userDone(q.tab.id, "skip");
    // 填到一半的表單(帳號、密碼都填了、還沒送出):agent 在這一格導覽會沖掉 → needs_user,頁面沒有重新載入
    await new Promise((res) => setTimeout(res, 700));
    q.wc.sendInputEvent({ type: "keyDown", keyCode: "Shift" }); q.wc.sendInputEvent({ type: "keyUp", keyCode: "Shift" });   // 用戶在這一頁按過鍵盤(真的輸入事件)
    await new Promise((res) => setTimeout(res, 200));
    const loginHits = () => hits.filter((h) => h === "GET hb2.test/login").length;
    r = J(await call("browser_open", { url: "http://hb2.test/login", tab: q.alias }));
    t("b 填到一半的表單:browser_open 到同一格 → needs_user(unsaved_input),沒有重新載入、用戶填的還在", r.ok === false && r.error === "needs_user" && r.kind === "unsaved_input" && loginHits() === 1
      && (await q.wc.executeJavaScript("document.getElementById('u').value + '|' + document.getElementById('p').value")) === "wei|hunter2-secret", [r, hits]);
    r = J(await call("browser_read", { tab: q.alias }));
    t("b 那一頁照樣讀得到(只是不能導走)", r.ok === true && /Sign in/.test(r.untrusted_content) && !JSON.stringify(r).includes("hunter2"), r);

    // c. 焦點在開放 shadow root 裡的密碼欄:一樣不交還
    const s = await openWait("http://hb3.test/shadow");
    Br.takeover(s.tab.id);
    await s.wc.executeJavaScript("(() => { const e = document.getElementById('host').shadowRoot.getElementById('sp'); e.focus(); return document.activeElement.id; })()");
    evs = await turn();
    t("c 焦點在 shadow root 裡的密碼欄:不交還", s.tab.userControl === true && !evs.some((e) => e.type === "handback" && e.id === s.tab.id), evs);
    await s.wc.executeJavaScript("document.getElementById('host').shadowRoot.getElementById('sp').blur()");
    evs = await turn();
    t("c 焦點離開之後:下一輪交還", s.tab.userControl === false && evs.some((e) => e.type === "handback" && e.id === s.tab.id && e.auto === true), evs);

    // d. 焦點在 closed shadow root 裡的密碼欄(稽核 P1-2):頁內只看得到宿主 → 不交還;按鍵也不代按
    const d = await openWait("http://hb4.test/closed");
    Br.takeover(d.tab.id);
    const act = await d.wc.executeJavaScript("(() => { window.__cp.value = 'closed-secret'; window.__cp.focus(); const a = document.activeElement; return a.id + '|' + (a.shadowRoot === null); })()");
    t("d(前提)頁內看到的焦點停在宿主、宿主的 shadowRoot 是 null", act === "host|true", act);
    evs = await turn();
    r = J(await call("browser_read", { tab: d.alias }));
    t("d 焦點在 closed shadow root 的宿主:不交還、沒發 handback、agent 碰它回 user_in_control、密碼沒露出", d.tab.userControl === true && !evs.some((e) => e.type === "handback" && e.id === d.tab.id) && r.error === "user_in_control" && !JSON.stringify(r).includes("closed-secret"), [evs, r]);
    await d.wc.executeJavaScript("document.getElementById('plain').focus()");
    evs = await turn();
    t("d 焦點移到一般欄位:下一輪交還", d.tab.userControl === false && evs.some((e) => e.type === "handback" && e.id === d.tab.id && e.auto === true), evs);
    await d.wc.executeJavaScript("window.__cp.focus()");
    r = J(await call("browser_press", { tab: d.alias, key: "Enter" }));
    t("d 交還之後焦點又回到 closed shadow root:browser_press Enter → needs_user(看不到按的是什麼)", r.ok === false && r.error === "needs_user" && (await d.wc.executeJavaScript("window.__cp.value")) === "closed-secret", r);
    Br.userDone(d.tab.id, "skip");

    t("整段沒有任何請求出到本機替身以外(https 一律被拒)", hits.every((h) => /^(GET|POST) hb\d\.test\//.test(h)), hits);
    Br.endTurn();
    srv.close(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* userData 還鎖著 */ }
    console.log(red ? `\n${red} FAILED` : "\nALL PASS(②)");
    app.exit(red ? 1 : 0);
  }).catch((e) => { console.log("FAIL  " + (e && e.stack) + "\n      last: " + JSON.stringify(last).slice(0, 500)); app.exit(1); });
}
