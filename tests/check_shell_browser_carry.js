// 前面回合開的分頁,下一輪 agent 接得上(第十三批 #200)。
// 代號(t<N>)在這次啟動裡不重編;還活著的 agent 分頁下一輪列得出、讀得到;每一道守門照當下的網址與狀態判;
// 用戶自己開的分頁不給代號;額度每回合重置;留著的舊分頁不會把 8 格卡死。
// 不開視窗、不連網路:視窗、分頁的 webContents、頁面物件(cdp.js)都是假的。
// 跑法:node tests/check_shell_browser_carry.js
const path = require("path"), fs = require("fs"), os = require("os"), { EventEmitter } = require("events");
const B = path.join(__dirname, "..", "shell", "browser");
const IP = require(path.join(B, "inpage"));
const { LIMITS, MAX_LIVE, createTabs } = require(path.join(B, "tabs"));
let red = 0, last = null; const t = (n, ok, d) => { console.log((ok ? "PASS  " : "FAIL  ") + n + (ok ? "" : "  " + JSON.stringify(d === undefined ? last : d).slice(0, 700))); if (!ok) red++; };
const SECRET = "PAGE-BODY-TEXT";

const cdpFile = require.resolve(path.join(B, "cdp"));
require.cache[cdpFile] = { id: cdpFile, filename: cdpFile, loaded: true, exports: { createPage: (wc) => {
  const p = {
    entered: [],
    attach: async () => {}, detach: () => {}, guarded: () => false, guard: async () => {}, disarm: async () => {}, quiet: async () => {},
    run: async (fn) => (fn === IP.fieldCandidates ? [] : fn === IP.maskFields ? 0 : fn === IP.readable ? 0 : null),
    extract: async () => { p.entered.push(wc.getURL()); return { markdown: (SECRET + " " + wc._body + " ").repeat(10), meta: { title: "page" }, headings: [], links: [], blocks: [], view: null }; },
    snapshot: async () => { p.entered.push(wc.getURL()); return { text: "- button " + SECRET, refs: 1, truncated: false }; },
  };
  wc._page = p; return p;
} } };

let wcSeq = 0; const wcs = [];
class FakeView {
  constructor() {
    const wc = new EventEmitter(); let url = "";
    Object.assign(wc, { id: ++wcSeq, _body: "first", setAudioMuted() {}, setWindowOpenHandler() {}, getURL: () => url, _go: (u) => { url = u; }, getTitle: () => "title of " + url, isDestroyed: () => false, isLoading: () => false,
      loadURL: async (u) => { url = u; }, close() {}, stop() {}, navigationHistory: { canGoBack: () => false },
      debugger: { sendCommand: async () => ({ data: Buffer.from("img").toString("base64") }) } });
    this.webContents = wc; wcs.push(wc);
  }
  getBounds() { return { x: 20000, y: 0, width: 1280, height: 800 }; }
  setBounds() {}
}
const ses = { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDevicePermissionHandler() {}, on() {}, webRequest: { onBeforeRequest() {}, onResponseStarted() {} } };
const fakeE = { WebContentsView: FakeView, session: { fromPartition: () => ses }, nativeImage: { createFromBuffer: () => ({ getSize: () => ({ width: 10, height: 10 }) }) }, net: {} };
const sent = [];
const win = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, contentView: { addChildView() {}, removeChildView() {} }, webContents: { send: (_ch, ev) => sent.push(ev), getZoomFactor: () => 1 } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blave-carry-"));
const SID = "desktop-carry1";
const J = (r) => (last = JSON.parse(r.content[0].text));

(async () => {
  const Br = require(path.join(B, "index.js")).createBrowser({ electron: fakeE, stateDir: path.join(tmp, "snaps"), reportsDir: path.join(tmp, "reports"), getWin: () => win, uiLang: () => "en", track: () => {}, version: "test", reducedMotion: () => true, userPresent: () => true });
  const call = (n, a) => Br._call(n, a || {}, { live: () => true });
  const turn = async () => { Br.endTurn(); await Br.beginTurn(win, SID); };
  const list = async () => J(await call("browser_tabs")).tabs;
  const left = () => Br._tabs.readBudget(LIMITS.readCharsPerTurn);   // 把這一輪剩下的讀取額度領光:回剩幾個字
  let host = 0;
  const open = async () => {
    const url = "https://site-" + (++host) + ".com/page";
    const o = J(await call("browser_open", { url }));
    if (!o.ok) throw new Error("browser_open: " + JSON.stringify(o));
    const tab = Br._tabs.byAlias(o.tab), wc = wcs[wcs.length - 1];
    const x = { alias: o.tab, url, tab, wc, page: wc._page, land: (u) => { wc._go(u); wc.emit("did-navigate", {}, u, 200); wc.emit("did-stop-loading"); } };
    x.land(url); return x;
  };
  const MAIL = "https://mail.google.com/mail/u/0/", SORRY = "https://www.google.com/sorry/index?continue=https://www.google.com/search%3Fq%3Dx";

  // ---- 第一輪開兩頁、讀其中一頁
  await Br.beginTurn(win, SID);
  const a = await open(), b = await open();
  const r1 = J(await call("browser_read", { tab: a.alias })), snap1 = a.tab.snapshotId;
  t("第一輪:讀得到、存了快照", r1.ok === true && r1.untrusted_content.includes("first") && !!snap1, r1);
  t("第一輪:browser_tabs 不標 from_previous_turn、沒有接續的說明", (await list()).every((x) => x.from_previous_turn === undefined) && last.note === undefined);

  // ---- 新回合:列得出、同一個代號、讀得到
  await turn();
  let ls = await list();
  t("新回合:browser_tabs 列出前面回合開的兩頁,標 from_previous_turn,帶網址與標題", ls.length === 2 && ls.every((x) => x.from_previous_turn === true && x.status === "ready")
    && ls[0].tab === a.alias && ls[0].url === a.url && ls[0].title === "title of " + a.url && ls[1].tab === b.alias && ls[1].url === b.url, ls);
  t("新回合:輸出帶一句怎麼接著用(同一個代號、不要重開同一個網址)", /from_previous_turn/.test(last.note) && /same id/.test(last.note) && /instead of opening the same address again/.test(last.note));
  t("新回合:額度重置(讀取 12 萬字是滿的)", left() === LIMITS.readCharsPerTurn);
  await turn();
  a.wc._body = "second";   // 用戶在那一頁點開了別的區塊:同一個網址、內容不一樣
  const sentAt = sent.length, r2 = J(await call("browser_read", { tab: a.alias }));
  t("沿用的分頁:同一個代號讀得到當下的內容", r2.ok === true && r2.tab === a.alias && r2.untrusted_content.includes("second") && Br._tabs.byAlias(a.alias) === a.tab, r2);
  t("沿用的分頁:這一輪讀的另存一份快照(不是上一輪那一份)", !!a.tab.snapshotId && a.tab.snapshotId !== snap1, [snap1, a.tab.snapshotId]);
  const used = LIMITS.readCharsPerTurn - left();
  t("沿用的分頁:讀取有扣到這一輪的額度", used > 0 && used === r2.untrusted_content.length, [used, r2.untrusted_content.length]);
  const c = await open();
  t("新開的分頁拿新的代號,不會撞到留著的那兩個", ![a.alias, b.alias].includes(c.alias) && Br._tabs.byAlias(a.alias) === a.tab && Br._tabs.byAlias(b.alias) === b.tab && Br._tabs.byAlias(c.alias) === c.tab, c.alias);
  ls = await list();
  t("這一輪新開的不標 from_previous_turn", ls.length === 3 && ls.find((x) => x.tab === c.alias).from_previous_turn === undefined && ls.filter((x) => x.from_previous_turn).length === 2, ls);
  Br.endTurn();
  const ts = sent.slice(sentAt).find((e) => e.type === "turn_sources");
  // 稽核 P2-7:以前格子只記這一輪開的——重開 app 時這一輪的格子沒有 a(只讀沿用分頁的回合整塊不見),整頁快照也不升級(升級只跑格子)
  t("回合紀錄:沿用的分頁這一輪有讀 → 進這一輪的來源(讀了 N 頁數它),也進這一輪的格子(已讀、這一輪的快照);這一輪沒碰的 b 不進",
    !!ts && ts.sources.length === 1 && ts.sources[0].id === a.tab.id && ts.sources[0].snapshot_id === a.tab.snapshotId
    && ts.tabs.map((x) => x.id + ":" + x.status).join() === a.tab.id + ":done," + c.tab.id + ":open" && ts.tabs[0].snapshot_id === a.tab.snapshotId, ts);
  await Br.beginTurn(win, SID);
  const sentAt2 = sent.length; J(await call("browser_tabs")); Br.endTurn();
  t("回合紀錄:沿用的分頁這一輪沒讀 → 不進這一輪的來源、也不進格子", (() => { const e = sent.slice(sentAt2).find((x) => x.type === "turn_sources"); return !!e && e.sources.length === 0 && e.tabs.length === 0; })());
  // browser_wait 不指名 = 這一輪用到的分頁,接上的前面回合分頁也算(稽核 P2-7:以前只認這一輪開的,回 not_found)
  await Br.beginTurn(win, SID);
  const sentAt3 = sent.length;
  J(await call("browser_read", { tab: b.alias }));
  const w0 = J(await call("browser_wait", {}));
  t("browser_wait 不帶 tab:等的是這一輪接上的沿用分頁(不是 not_found)", w0.ok === true && w0.tabs.map((x) => x.tab).join() === b.alias, w0);
  Br.endTurn();
  const e3 = sent.slice(sentAt3).find((x) => x.type === "turn_sources");
  t("只讀了沿用分頁的回合:格子裡有它(重開 app 時這一塊畫得回來)", !!e3 && e3.tabs.length === 1 && e3.tabs[0].id === b.tab.id && e3.tabs[0].status === "done" && e3.tabs[0].snapshot_id === b.tab.snapshotId, e3);

  // ---- 用戶接手中 → user_in_control;交還之後讀得到
  await Br.beginTurn(win, SID);
  Br.takeover(a.tab.id); a.page.entered.length = 0;
  for (const tool of ["browser_read", "browser_snapshot", "browser_close"]) {
    const r = J(await call(tool, { tab: a.alias }));
    t(tool + " 沿用的分頁、用戶接手中 → user_in_control,沒進頁面", r.ok === false && r.error === "user_in_control" && a.page.entered.length === 0 && !JSON.stringify(r).includes(SECRET), r);
  }
  t("user_in_control 的訊息:講了要按聊天列的「交還 agent」或請求卡上的「好了，交還 agent」(或回一句話)才能讀、要模型照實告訴用戶、不准講別的原因(#201)", /operating this tab/.test(last.message) && /hand it back\. Tell the user exactly this/.test(last.message) && /聊天裡那一頁的『交還 agent』，或請求卡上的『好了，交還 agent』，也可以直接回我一句話/.test(last.message) && /'Hand back' on that page in the chat/.test(last.message) && /'Done, hand back to agent' on the request card/.test(last.message) && !/Browser title/.test(last.message) && !/頁面上方|top of that page/.test(last.message)
    && /no other reason/.test(last.message) && /still open/.test(last.message), last);
  const ua = (await list()).find((x) => x.tab === a.alias);
  t("browser_tabs:用戶接手中的分頁標 user_control、只回主機名不回標題(稽核 S9 照舊)", ua.status === "user_control" && ua.url === "site-1.com" && ua.title === "" && ua.from_previous_turn === true && /operating/.test(ua.note), ua);
  Br.handback(a.tab.id);
  const r3 = J(await call("browser_read", { tab: a.alias }));
  t("交還之後讀得到", r3.ok === true && r3.untrusted_content.includes("second"), r3);

  // ---- 沿用的分頁當下的網址已經不是 agent 能去的 → 拿不到內容
  await turn();
  for (const [name, url, want] of [["被擋的網域", MAIL, "blocked_policy"], ["驗證頁", SORRY, "needs_user_verification"]]) {
    b.wc._go(url); b.page.entered.length = 0;
    for (const tool of ["browser_read", "browser_snapshot"]) {
      const r = J(await call(tool, { tab: b.alias }));
      t(tool + " 沿用的分頁當下在" + name + " → " + want + ",沒進頁面、沒內容", r.ok === false && r.error === want && b.page.entered.length === 0 && !JSON.stringify(r).includes(SECRET) && !JSON.stringify(r).includes("title of"), r);
    }
    const row = (await list()).find((x) => x.tab === b.alias);
    t("browser_tabs:那一頁只回主機名、不回標題(" + name + ")", !!row && row.title === "" && !/\//.test(row.url), row);
    t("被擋下的不算這一輪接上(usedTurn 沒記)", b.tab.usedTurn !== Br._tabs.turn());
  }
  b.wc._go(b.url);
  t("對照:網址回到一般的頁 → 讀得到", J(await call("browser_read", { tab: b.alias })).ok === true);

  // ---- 用戶自己開的分頁:不給代號、不列、指不到
  const u = Br.showLive("https://user-own.example.org/account");
  const ut = Br._tabs.get(u.id);
  t("用戶自己開的分頁沒有代號", !!ut && ut.by === "user" && ut.alias === null);
  await turn();
  ls = await list();
  t("用戶自己開的分頁不列(下一輪也不列)", !ls.some((x) => /user-own/.test(x.url)) && !JSON.stringify(ls).includes(u.id), ls);
  for (const id of [u.id, "null", "", "t999"]) { const r = J(await call("browser_read", { tab: id })); t("指不到:tab=" + JSON.stringify(id) + " → not_found", r.ok === false && r.error === "not_found", r); }
  Br._tabs.close(u.id);

  // ---- 關掉的、被收掉的不列
  J(await call("browser_close", { tab: c.alias }));
  await turn();
  ls = await list();
  t("關掉的分頁不列、指不到", !ls.some((x) => x.tab === c.alias) && J(await call("browser_read", { tab: c.alias })).error === "not_found", ls);
  J(await call("browser_read", { tab: a.alias }));   // a 讀完:可以讓位
  await turn();
  const many = []; for (let i = 0; i < MAX_LIVE; i++) many.push(await open());
  ls = await list();
  t("開到滿:讀完的舊分頁被收成快照讓位,不列;指它回「被收掉了,重開網址」", a.tab.status === "discarded" && !ls.some((x) => x.tab === a.alias)
    && J(await call("browser_read", { tab: a.alias })).error === "not_found" && /open the URL again/.test(last.message), [a.tab.status, ls]);
  t("開到滿:新開的每一頁都在載入、沒有排隊", many.every((x) => x.tab.status === "ready") && Br._tabs.queued() === 0 && Br._tabs.liveCount() <= MAX_LIVE, Br._tabs.liveCount());
  for (const x of many) Br._tabs.close(x.tab.id);
  Br._tabs.close(b.tab.id);

  // ---- 連續五個回合各開三頁、都沒讀:不會卡死
  const rounds = [];
  for (let i = 0; i < 5; i++) { await turn(); const xs = [await open(), await open(), await open()]; rounds.push(xs); t("第 " + (i + 1) + " 個回合:三頁都開得起來(沒有排隊)、活的分頁不超過 8", xs.every((x) => x.tab.status === "ready") && Br._tabs.queued() === 0 && Br._tabs.liveCount() <= MAX_LIVE, [xs.map((x) => x.tab.status), Br._tabs.liveCount()]); }
  t("讓位的是最舊那幾個回合留下來的分頁", rounds[0].every((x) => x.tab.status === "discarded") && rounds[4].every((x) => x.tab.status === "ready"), rounds.map((xs) => xs.map((x) => x.tab.status)));
  ls = await list();
  t("五個回合之後:列出來的都是活的、代號沒有重複", ls.length === Br._tabs.liveCount() && new Set(ls.map((x) => x.tab)).size === ls.length && ls.every((x) => ["ready", "loading"].includes(x.status)), ls);
  Br.endTurn();

  // ---- 別的對話留下來的分頁:不列、指不到;回到原來的對話又接得上
  await Br.beginTurn(win, SID);
  const mine = await open(); Br.endTurn();
  await Br.beginTurn(win, "desktop-other1");
  ls = await list();
  t("換一個對話:上一個對話的分頁不列、代號指不到", ls.length === 0 && J(await call("browser_read", { tab: mine.alias })).error === "not_found" && mine.page.entered.length === 0, ls);
  const theirs = await open();
  t("換一個對話:新開的分頁代號不重用", theirs.alias !== mine.alias);
  Br.endTurn(); await Br.beginTurn(win, SID);
  ls = await list();
  t("回到原來的對話:自己的分頁接得上,另一個對話的不列", ls.some((x) => x.tab === mine.alias) && !ls.some((x) => x.tab === theirs.alias) && J(await call("browser_read", { tab: mine.alias })).ok === true, ls);
  Br.endTurn();

  // ---- 名額與代號的純邏輯(tabs.js)
  const w = { now: 1e12, destroyed: [] };
  w.tabs = createTabs({ now: () => w.now, create: () => {}, destroy: (x) => w.destroyed.push(x.id), emit: () => {} });
  const op = (i) => { w.now += 1000; const x = w.tabs.open("https://h" + i + ".example/", "h" + i + ".example", "agent").tab; w.tabs.loaded(x.id); return x; };
  w.tabs.newTurn();
  const old = []; for (let i = 0; i < MAX_LIVE; i++) old.push(op(i));
  w.tabs.newTurn();
  old[0].userControl = true; w.tabs.setVisible(old[1].id, true); old[2].need = { kind: "submit" };
  t("接上前面回合的分頁:第一次回 true、之後回 false;這一輪開的回 false", w.tabs.use(old[3].id) === true && w.tabs.use(old[3].id) === false);
  const fresh = []; for (let i = 0; i < 4; i++) fresh.push(op(100 + i));
  t("滿了:收的是前面回合留下來、這一輪沒人碰的分頁;用戶在操作的、在看的、在等他按的、agent 這一輪接上的都不收",
    w.destroyed.join() === [old[4], old[5], old[6], old[7]].map((x) => x.id).join() && fresh.every((x) => x.status === "ready"), w.destroyed);
  const stuck = op(200);
  t("都收不掉的時候照舊排隊(不收這一輪開的、沒讀的頁)", stuck.status === "queued" && w.tabs.queued() === 1 && w.destroyed.length === 4);
  // 稽核 P2-2 的後半:自動交還之後 userControl 已經拿掉,他在這份文件裡打過的字還在——讀完的也不收
  const typed = createTabs({ now: () => w.now, create: () => {}, destroy: (x) => typedGone.push(x.id), emit: () => {}, max: 2 }), typedGone = [];
  typed.newTurn();
  const ta = typed.open("https://ta.example/", "ta.example", "agent").tab, tb = typed.open("https://tb.example/", "tb.example", "agent").tab;
  typed.loaded(ta.id); typed.loaded(tb.id); ta.userTyped = true; typed.markRead(ta.id); typed.markRead(tb.id);
  typed.open("https://tc.example/", "tc.example", "agent");
  t("滿了:讀完的頁裡,用戶打過字的那一頁不收(收的是另一頁)", typedGone.join() === tb.id && ta.status === "ready", typedGone);
  w.tabs.markRead(old[3].id);
  t("接上的分頁這一輪讀完 → 讓位,排隊的補上", old[3].status === "discarded" && stuck.status !== "queued");
  t("接上不算開新頁:這一輪照樣開得滿 40 頁", (() => { const w2 = createTabs({ now: () => w.now, create: () => {}, destroy: () => {}, emit: () => {} }); w2.newTurn(); const k = w2.open("https://k.example/", "k.example", "agent").tab; w2.newTurn(); w2.use(k.id);
    let e = null; for (let i = 0; i < LIMITS.pagesPerTurn; i++) { w.now += 61000; const r = w2.open("https://q" + i + ".example/", "q" + i + ".example", "agent"); if (r.error) e = r; else w2.close(r.tab.id); }
    w.now += 61000; return e === null && w2.open("https://z.example/", "z.example", "agent").scope === "turn"; })());

  // ---- 原文鎖
  const idx = fs.readFileSync(path.join(B, "index.js"), "utf8"), tools = require(path.join(B, "tools"));
  t("用戶在這份文件打字 → userTyped;換文件(did-navigate)清掉", /v\.userKeyNav = v\.navs; t\.userTyped = true; \}/.test(idx) && /wc\.on\("did-navigate", \(_e, url, code\) => \{ if \(priming\(url\)\) return; t\.url = url; v\.http = code \|\| 0; v\.navs\+\+; t\.userTyped = false;/.test(idx));
  t("tabFor:每一關都過了才記「這一輪接上」(在網址政策那一關之後、交出分頁之前)", /if \(a\) return \{ e: ERR\("blocked_policy"[^\n]*\n\s*tabs\.use\(t\.id\);[^\n]*\n\s*return \{ t, v \};/.test(idx));
  t("browser_tabs 列的是 reachable(這一輪開的+前面回合還活著的)", /name === "browser_tabs"\) \{ const list = tabs\.reachable\(\)\.map\(tabInfo\)/.test(idx));
  const desc = tools.TOOLS.find((x) => x.name === "browser_tabs").description;
  t("工具說明:browser_tabs 講了前面回合的分頁還在、照同一個代號用", /earlier turns that are still open/.test(desc) && /same id/.test(desc) && /until they hand it back \(Hand back button on that page in the chat, or by replying in chat\)\./.test(desc) && !/Hand back to agent/.test(desc), desc);

  // ---- 規則文字(references/browser.md)
  const md = fs.readFileSync(path.join(__dirname, "..", "references", "browser.md"), "utf8");
  const sec = (head) => { const i = md.indexOf(head); return i < 0 ? "" : md.slice(i, md.indexOf("\n## ", i + 1) < 0 ? undefined : md.indexOf("\n## ", i + 1)); };
  const carry = sec("## Tabs from earlier turns");
  t("規則:前面回合的分頁還在、代號不變,先 browser_tabs、不重開同一個網址(#201)", /stay open after the turn ends and keep the same id/.test(carry) && /call `browser_tabs`/.test(carry) && /`from_previous_turn`/.test(carry) && /the same address is not opened a second time/.test(carry), carry);
  t("規則:用戶說已經點開 / 登入 / 處理好了 → 先讀那個分頁(#201)", /already opened, clicked, signed in to or finished something/.test(carry) && /我已經點開了／登入好了／處理好了/.test(carry) && /read that tab first/.test(carry), carry);
  const uic = (md.split("\n").find((l) => l.startsWith("On `user_in_control`")) || "");
  t("規則:user_in_control 要照實講「按交還 agent 之後才能讀」,不編別的原因(#201)", /\*\*Hand back\*\* on that page in the chat/.test(uic) && /\*\*Done, hand back to agent\*\* on the request card/.test(uic) && !/Browser title/.test(uic) && /聊天裡那一頁的『交還 agent』，或請求卡上的『好了，交還 agent』，也可以直接回我一句話/.test(uic) && !/頁面上方|top of that page/.test(uic) && /Say exactly that in the reply/.test(uic) && /give no other reason/.test(uic) && /tabs are not reopened every turn/.test(uic), uic);

  const flow = sec("## Standard flow"), hid = (flow.split("\n").find((l) => l.startsWith("- **Content behind a tab")) || "");
  t("規則:讀不到預期內容、頁面上有分頁 / 展開鈕 / 顯示更多 → 先 snapshot 找到、click 點開、再讀;試過才可以說讀不到(#202)",
    /open it before you say it cannot be read/.test(hid) && /`browser_snapshot`/.test(hid) && /`browser_click`/.test(hid) && /then read again/.test(hid) && /Only after that try/.test(hid) && /Show more/.test(hid), hid);
  t("規則:點擊守門照舊(送出、購買、登入回 needs_user);只有規則、沒有站點特例(#202)", /submits, buys or signs in answers `needs_user`/.test(hid) && !/tradingview|\.com\b/i.test(hid), hid);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(red ? `\n${red} FAILED` : "\nALL PASS"); process.exit(red ? 1 : 0);
})().catch((e) => { console.log("FAIL  " + (e && e.stack) + "\n      last: " + JSON.stringify(last).slice(0, 500)); process.exit(1); });
