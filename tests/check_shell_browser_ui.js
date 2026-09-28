// 內建瀏覽器畫面(renderer/browser.js),用隨包 Electron 開真的 index.html,window.blave 換成假的,直接餵 browser-event:
//   ① 全部展開時,事件不重建格子(同一批 DOM 節點、不重播進場),有新頁才 append 新格
//   ② 中欄不會被任何事件搶走:餵完一整串事件 browserExpand 一次都沒被叫、模式還是牆;程式碼觸發的 click 也不展開(只有用戶真的點)
//   ③ 請求卡:summary 沒有句尾標點時補「。」再接「按之前再看一次。」
//   ④ 相似網域 / 可疑網址那一列的訊息槽跟擋下頁同一句
// 跑法:node tests/check_shell_browser_ui.js(找不到 shell/node_modules 的 Electron 就 SKIP)
const path = require("path"), fs = require("fs");
const SHELL = path.join(__dirname, "..", "shell");
const GATE = require("./_electron_gate");
if (!process.versions.electron) {
  const bin = GATE.bin(SHELL);
  if (!bin) { process.exit(0); }
  const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit", env: { ...process.env, ELECTRON_ENABLE_LOGGING: "" } });
  process.exit(r.status == null ? 1 : r.status);
}
const { app, BrowserWindow } = require("electron");
const os = require("os");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "blave-brui-")));
const STUB = `window.__expand = 0; window.__ev = null;
window.blave = new Proxy({}, { get: (_, k) => typeof k !== "string" ? undefined
  : k === "onBrowserEvent" ? (fn) => { window.__ev = fn; }
  : k === "browserExpand" ? async () => { window.__expand++; return { live: true, status: "ready" }; }
  : k.startsWith("on") ? () => {} : ["tradeLabels", "browserBounds", "browserBlockVisible", "trackFeature"].includes(k) ? () => {}
  : async () => ({ getLocale: "zh-TW", loadConnection: { kind: "claude" }, detectAgents: { claude: { installed: true, loggedIn: true }, codex: { installed: false } },
      listStrategies: [], listSessions: [], loadSession: [], loadSessionImages: [], browserHistory: [], updateState: { phase: "idle", current: "0.0.0" }, telemetryGet: true })[k] });`;
let red = 0; const ok = (n, c) => { console.log((c ? "PASS  " : "FAIL  ") + n); if (!c) red++; };

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  const pre = path.join(app.getPath("userData"), "stub.js"); fs.writeFileSync(pre, STUB);
  const w = new BrowserWindow({ width: 1280, height: 800, show: false, webPreferences: { offscreen: true, preload: pre, contextIsolation: false, sandbox: false } });
  await w.loadFile(path.join(SHELL, "renderer", "index.html"));
  await new Promise((r) => setTimeout(r, 1200));
  const js = (code) => w.webContents.executeJavaScript(code, true);
  const r = await js(`(async () => {
    const ev = (o) => window.__ev(o);
    setLang("zh");
    ev({ type: "block_open" });
    for (const [id, u] of [["p1", "https://a.example/x"], ["p2", "https://b.example/y"], ["p3", "https://c.example/z"]]) { ev({ type: "page_open", id, url: u }); ev({ type: "page_loaded", id, title: id }); }
    brWall(BR.blocks[0]);
    await new Promise((res) => setTimeout(res, 50));
    const first = [...document.querySelectorAll(".bw .pt")];
    const wallClose = document.querySelectorAll(".bw-head .bw-close").length === 1;
    const events = [
      { type: "page_act", id: "p1", kind: "click", ref: "@e1", text: "More", box: { x: 10, y: 10, w: 50, h: 20 }, vw: 1280, vh: 800 },
      { type: "page_progress", id: "p2", n: 3, total: 9, pos: 0.4 }, { type: "thumb", id: "p1", dataURI: "AAAA" }, { type: "page_done", id: "p2", snapshot_id: null },
      { type: "page_extract", id: "p2", line: "headline" }, { type: "need_user", id: "p3", kind: "submit", summary: "填好了:Email" }, { type: "user_takeover", id: "p3" },
      { type: "handback", id: "p3" }, { type: "need_clear", id: "p3" }, { type: "page_act", id: "p1", kind: "outline" }, { type: "page_nav", id: "p1", url: "https://a.example/x2" },
      { type: "page_discarded", id: "p1", snapshot_id: "s0123456789abcdef" }, { type: "report_write" }, { type: "page_blocked", id: "p2", kind: "download", detail: "a.zip" },
    ];
    for (const e of events) { ev(e); await new Promise((res) => setTimeout(res, 5)); }
    const after = [...document.querySelectorAll(".bw .pt")];
    ev({ type: "page_open", id: "p4", url: "https://binance-login.xyz/" });
    ev({ type: "page_blocked", id: "p4", kind: "scheme", reason: "lookalike", like: "binance.com", detail: "binance-login.xyz" });
    await new Promise((res) => setTimeout(res, 20));
    const withNew = [...document.querySelectorAll(".bw .pt")];
    withNew[0].click(); document.querySelector(".bblk .pt") && document.querySelector(".bblk .pt").click();   // 程式碼觸發的 click(isTrusted=false)
    const p4foot = withNew.find((el) => el.dataset.id === "p4").querySelector(".pt-foot").textContent;
    const ask = brAsk({ id: "p3", need: { kind: "submit", summary: "填好了:Email、提前 15 分鐘" } }).querySelector("p").textContent;
    const ask2 = brAsk({ id: "p3", need: { kind: "submit", summary: "填好了。" } }).querySelector("p").textContent;
    const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const favImg = brFav("https://a.example/x", PNG).querySelector("img");
    const favRemote = brFav("https://q.example/x", "https://q.example/favicon.ico");
    ev({ type: "page_favicon", id: "p2", dataURI: PNG });
    const p2bar = document.querySelector('.bw .pt[data-id="p2"] .pt-bar .fav img');
    const sameSite = brFav("https://b.example/other").querySelector("img");
    return { favImg: !!favImg && favImg.src === PNG, favRemote: !favRemote.querySelector("img") && favRemote.textContent === "q", p2bar: !!p2bar, sameSite: !!sameSite, wallClose,
      mode: BR.exp && BR.exp.mode, expand: window.__expand, same: first.length === 3 && first.every((el, i) => el === after[i]) && after.length === 3,
      appended: withNew.length === 4 && withNew.slice(0, 3).every((el, i) => el === first[i]), p4foot, ask, ask2, addrH: t("br.blk.addr.h") };
  })()`);
  ok("① 全部展開:14 個事件之後還是同一批格子節點(沒有重建、不重播進場)", r.same);
  ok("① 有新的一頁才 append 新格,舊格不動", r.appended);
  ok("② 中欄沒被搶:整串事件 + 程式碼觸發的 click 之後 browserExpand 0 次、模式仍是牆", r.expand === 0 && r.mode === "wall");
  ok("③ summary 沒句尾標點補「。」再接「按之前再看一次。」;已經有句號的不重複", r.ask === "填好了:Email、提前 15 分鐘。按之前再看一次。" && r.ask2 === "填好了。按之前再看一次。");
  ok("④ 相似網域那一列寫「已擋下這個網址」(跟擋下頁同一句)", r.p4foot === r.addrH && r.addrH === "已擋下這個網址");
  ok("favicon:data URL 畫成 16px 圖;遠端網址一律不當 <img src>,退回字母格", r.favImg && r.favRemote);
  ok("favicon:page_favicon 事件之後,牆格條頭與同網站之後畫的圖示都換成圖", r.p2bar && r.sameSite);
  const r2 = await js(`(() => {
    brCollapse(false);
    window.__ev({ type: "block_open" });
    const b = BR.cur;
    for (const id of ["q1", "q2", "q3", "q4"]) window.__ev({ type: "page_open", id, url: "https://" + id + ".example/" });
    window.__ev({ type: "page_done", id: "q1", read: true }); window.__ev({ type: "page_done", id: "q2" });
    window.__ev({ type: "turn_sources", sources: [{ id: "q1", url: "https://q1.example/", title: "Q1", snapshot_id: "s0123456789abcdef" }, { id: "q3", url: "https://q3.example/", title: "Q3", snapshot_id: "s0123456789abcde0" }], tabs: [] });
    return new Promise((res) => setTimeout(() => res({ sum: (document.querySelector(".bblk.sum:last-of-type summary") || b.sum || {}).textContent || b.sum.textContent, cards: document.querySelectorAll(".srcs, .src").length }), 2500));
  })()`);
  const r3 = await js(`(() => {
    window.__ev({ type: "block_open" });
    window.__ev({ type: "page_open", id: "e1", url: "https://github.com/trending" }); window.__ev({ type: "page_loaded", id: "e1", title: "Trending" });
    window.__ev({ type: "page_progress", id: "e1", n: 1, total: 5 });
    window.__ev({ type: "turn_sources", sources: [], tabs: [] });
    const x = BR.tabs.get("e1"), st = brStatusNode(x);
    const pl = brFav("https://g.example/", "data:image/png;base64,AAAA", true), np = brFav("https://h.example/", "data:image/png;base64,AAAA", false);
    const tile = document.querySelector('.bblk .pt[data-id="e1"]');
    const bandHidden = !tile || tile.querySelector(".pg-band").hidden === true;
    return { bandHidden, foot: brFoot(x), unread: !!st && st.className === "st-t" && st.textContent === t("br.unread") && t("br.unread") === "未讀", plate: pl.classList.contains("plate"), noPlate: !np.classList.contains("plate") };
  })()`);
  // 第七批起(設計師規格「分得出未讀跟讀不了」第 1 節的表):開了、載入正常、agent 沒讀完的頁,回合結束後狀態位是「未讀」兩個字(不是 pulse、不是留空)
  ok("回合結束時沒讀完的頁:訊息槽改成頁面標題、狀態位寫「未讀」(pulse 停)、縮圖上的讀取帶收掉", r3.foot === "Trending" && r3.unread && r3.bandHidden);
  const r4 = await js(`(async () => {
    window.__ev({ type: "block_open" }); const b = BR.cur;
    for (const id of ["z1", "z2", "z3"]) window.__ev({ type: "page_open", id, url: "https://" + id + ".example/" });
    await brExpand("z1");
    const before = document.querySelector('.bv-tab[data-id="z2"] .fav').classList.contains("has-img");
    window.__ev({ type: "page_favicon", id: "z2", dataURI: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", plate: false });
    window.__ev({ type: "page_progress", id: "z1", n: 1, total: 3 });
    const after = document.querySelector('.bv-tab[data-id="z2"] .fav').classList.contains("has-img");
    const headBtns = document.querySelectorAll(".bblk-head .br-open, .bblk-head .btn-quiet, .bblk summary .btn-quiet").length;
    // ✕:熱區用 elementFromPoint 實測(中心上下左右各 21px 都打到它);下緣在標題列內、在頁面框(原生 view)上緣之上
    const cb = document.querySelector(".bw-head .bw-close"), cr = cb.getBoundingClientRect(), hr = document.querySelector(".bw-head").getBoundingClientRect(), pr = document.querySelector(".bv-page").getBoundingClientRect();
    const cx = cr.left + cr.width / 2, cy = cr.top + cr.height / 2, hitAt = (dx, dy) => { const e = document.elementFromPoint(cx + dx, cy + dy); return !!e && (e === cb || cb.contains(e)); };
    const closeBtn = { label: cb.getAttribute("aria-label"), size: cr.width + "x" + cr.height, hit: [[0, 0], [21, 0], [-21, 0], [0, 21], [0, -21]].every(([dx, dy]) => hitAt(dx, dy)), below: hitAt(0, hr.bottom - cy + 1),
      inHead: cr.bottom + 6 <= hr.bottom && cr.bottom + 6 <= pr.top, alignH5: Math.abs(cy - (() => { const h = document.querySelector(".bw-head h5").getBoundingClientRect(); return h.top + h.height / 2; })()) };
    cb.focus(); BR.sig = null; brPaintOverlay();
    closeBtn.refocus = document.activeElement === document.querySelector(".bw-head .bw-close") && document.activeElement !== cb;
    document.querySelector(".bw-head .bw-close").click();
    closeBtn.closed = BR.exp === null && document.querySelector("#bw").hidden && BR.tabs.has("z1");
    for (const id of ["z1", "z2", "z3"]) window.__ev({ type: "page_done", id, read: true });   // 疊圖只放真的讀到內容的頁
    window.__ev({ type: "turn_sources", sources: [], tabs: [] });
    await new Promise((res) => setTimeout(res, 2500));   // 匯流動畫播完才換成摘要列
    const favs = [...b.el.querySelectorAll(".favs .fav")].map((f) => Number(f.style.zIndex));
    return { before, after, favs, headBtns, closeBtn };
  })()`);
  ok("分頁列的 favicon 即時換上(事件後到,分頁列不重建也會更新)", r4.before === false && r4.after === true);
  ok("摘要列疊圖由左到右 z-index 遞減", r4.favs.length === 3 && r4.favs[0] > r4.favs[1] && r4.favs[1] > r4.favs[2]);
  ok("深色 favicon 才墊淺底(plate),其餘不墊", r3.plate && r3.noPlate);
  ok("這一輪的頁開在中欄時,聊天卡頭沒有文字鈕(「收回」拿掉了)", r4.headBtns === 0);
  ok("中欄 ✕:牆與單頁都有、aria-label「關閉」、視覺 32×32、對齊 h5 那一行", r.wallClose && r4.closeBtn.label === "關閉" && r4.closeBtn.size === "32x32" && r4.closeBtn.alignH5 <= 1);
  ok("中欄 ✕:熱區 44(elementFromPoint 實測)、標題列下緣以下打不到、不伸進頁面框(原生 view)", r4.closeBtn.hit && !r4.closeBtn.below && r4.closeBtn.inHead);
  ok("中欄 ✕:重畫後焦點放回新的 ✕;按了只收展開層(分頁還在)", r4.closeBtn.refocus && r4.closeBtn.closed);
  const r5 = await js(`(() => {
    window.__ev({ type: "block_open" }); const b = BR.cur;
    window.__ev({ type: "page_open", id: "g1", url: "https://www.google.com/search?q=btc" }); window.__ev({ type: "search", id: "g1", source: "google", results: [] }); window.__ev({ type: "page_done", id: "g1" });
    for (const id of ["n1", "n2", "n3"]) window.__ev({ type: "page_open", id, url: "https://" + id + ".example/" });
    window.__ev({ type: "page_done", id: "n1", read: true });
    const head = b.head.textContent;
    brWall(b); const wallHead = document.querySelector(".bw-stat").textContent; brCollapse(false);
    return { head, wallHead, searchIcon: brStatusNode(BR.tabs.get("g1")) === null, readIcon: !!brStatusNode(BR.tabs.get("n1")) };
  })()`);
  const r6 = await js(`(async () => {
    brCollapse(false);
    window.__ev({ type: "block_open" });
    window.__ev({ type: "page_open", id: "h1", url: "https://h1.example/", by: "agent", alias: "t9" }); window.__ev({ type: "page_loaded", id: "h1", title: "H1" });
    await brExpand("h1");
    const stat = () => { const s = document.querySelector(".bw-stat"); return { text: s.textContent, btn: [...s.querySelectorAll("button")].map((b) => b.textContent).join("|") }; };
    const tile = () => brFoot(BR.tabs.get("h1"));
    window.__ev({ type: "user_takeover", id: "h1" });
    const held = stat(), heldFoot = tile();
    window.__ev({ type: "turn_sources", sources: [], tabs: [] });
    const afterTurn = stat();
    window.__ev({ type: "handback", id: "h1", auto: true });   // 下一輪開始、block_open 之前就到
    const back = stat(), backFoot = tile();
    return { held, heldFoot, afterTurn, back, backFoot, userOp: t("br.userOp"), hb: t("br.handback"), user: BR.tabs.get("h1").user };
  })()`);
  ok("自動交還(handback auto: true):接手時頁首寫「你在操作」+「交還 agent」,回合結束後還在;事件一到兩個都消失、格子的訊息槽也不再寫「你在操作」",
    r6.held.text.includes(r6.userOp) && r6.held.btn === r6.hb && r6.heldFoot === r6.userOp && r6.afterTurn.btn === r6.hb
    && !r6.back.text.includes(r6.userOp) && r6.back.btn === "" && r6.backFoot !== r6.userOp && r6.user === false);
  ok("已讀 / 總數跟摘要列同口徑:搜尋結果頁不算已讀、也不算在總數;聊天區塊頭與中欄牆頭同一個數", /1\/3/.test(r5.head) && /1\/3/.test(r5.wallHead));
  ok("搜尋結果頁列出來但不打勾;真的讀過的頁打勾", r5.searchIcon && r5.readIcon);
  ok("「讀了 N 頁」= 主行程這一輪的來源筆數(2 筆 → 讀了 2 頁;只開沒讀的不算),聊天裡沒有來源卡", /讀了 2 頁/.test(r2.sum) && !r2.cards);
  console.log(red ? `\n${red} FAILED` : "\nALL PASS");
  app.exit(red ? 1 : 0);
}).catch((e) => { console.log("FAIL  " + (e && e.stack)); app.exit(1); });
