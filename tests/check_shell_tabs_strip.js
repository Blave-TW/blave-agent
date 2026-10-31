// 電腦版對話分頁列的版面(spec chat-tabs-2026-10-29 §13 v5b-height):真的 index.html、假的 window.blave,不顯示的視窗裡量幾何。
//   容量:長標題 720 放 9 個、10 個時 8＋「+N」;452 放 5、6 個時 4＋「+N」;336 放 3、4 個時 2＋「+N」;短標題放得更多;選中的落在後面排在列尾
//   熱區:分頁元素 44 高(上 8 透明)、看得到的本體 36 貼列下緣;× 32×44,滑過或焦點才畫,寬度不跳;☰／＋ 44×52;列最上 8 不是分頁
//   選中:填卡面色、上兩角看得到的是正圓 8;沒選中的被縮到 88 以下讓出 × 格;用滑鼠關分頁凍住寬度,滑鼠離開分頁列才重排
// 跑法:node tests/check_shell_tabs_strip.js(要 BLAVE_TEST_WINDOW=1 才起 Electron,沒設就 SKIP)
const fs = require("fs"), path = require("path");
const SHELL = path.join(__dirname, "..", "shell");
const GATE = require("./_electron_gate");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + JSON.stringify(d).slice(0, 900))); if (!c) red++; };

if (!process.versions.electron) {
  const bin = GATE.bin(SHELL, "分頁列版面");
  if (!bin) { console.log("\nALL PASS"); process.exit(0); }
  const tmp = fs.mkdtempSync(path.join(require("os").tmpdir(), "blave-tabs-strip-"));
  const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit", env: { ...process.env, BLAVE_TEST_USERDATA: tmp } });
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(r.status === 0 ? 0 : 1);
} else {
const { app, BrowserWindow } = require("electron");
app.setPath("userData", process.env.BLAVE_TEST_USERDATA);
const STUB = `const __fixed = {
  getLocale: async () => "zh-TW", hasBlaveToken: async () => false, loadConnection: async () => ({ kind: "claude" }),
  detectAgents: async () => ({ claude: { installed: true, loggedIn: true }, codex: { installed: false } }),
  tabsPrefs: async () => null, tabsPrefsSet: async () => {}, listSessions: async () => [], loadSession: async () => [], loadSessionImages: async () => [], listStrategies: async () => [],
  updateState: async () => ({ phase: "idle", current: "0.0.0" }), platform: "darwin",
};
window.blave = new Proxy(__fixed, { get: (o, k) => (k in o ? o[k] : typeof k !== "string" ? undefined : k.startsWith("on") ? () => {} : k === "tradeLabels" ? () => {} : async () => undefined) });`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log("FAIL  逾時(60 秒)"); process.exit(1); }, 60000).unref();
process.on("unhandledRejection", (e) => { console.log("FAIL  頁面裡丟錯:" + (e && e.message)); process.exit(1); });
const LONG = ["SOL 突破策略掃參數再看一次", "ETH 資金費率套利回測結果", "台指期夜盤當沖回測比較", "幫我看 BTC 清算地圖哪裡密", "0050 定期定額比較三種做法",
  "把 RSI 策略轉成 Pine 腳本", "群益帳戶連線測試與下單", "美股財報前後波動研究", "OKX 網格策略上線前檢查", "台股創新高加營收篩選"];

app.whenReady().then(async () => {
  const preload = path.join(app.getPath("userData"), "stub.js"); fs.writeFileSync(preload, STUB);
  const w = new BrowserWindow({ width: 1600, height: 800, show: false, webPreferences: { offscreen: true, preload, contextIsolation: false, sandbox: false } });
  await w.loadFile(path.join(SHELL, "renderer", "index.html"));
  await wait(800);
  const js = (s) => w.webContents.executeJavaScript(s, true);
  const mouse = async (type, x, y) => { x = Math.round(x); y = Math.round(y); w.webContents.sendInputEvent(type === "mouseMove" ? { type, x, y } : { type, x, y, button: "left", clickCount: 1 }); await wait(120); };
  // 開 n 個分頁、選第 sel 個、聊天欄寬 cw;回列上的幾何
  const setup = (cw, titles, sel) => js(`(async () => {
    for (const s of CS.order.slice()) { const T = CS.tabs.get(s); if (T && T !== CS.cur) tabsDestroy(T); }
    CS.order = [CS.cur.sid]; CS.freeze = null;
    const titles = ${JSON.stringify(titles)};
    const Ts = titles.map((ti, i) => i === 0 ? CS.cur : tabMake("t" + Date.now() + "-" + i, { title: ti, lazy: true }));
    Ts[0].title = titles[0]; csTitle = titles[0];
    CS.order = Ts.map((T) => T.sid);
    document.body.classList.add("resizing"); paneSt.chat.w = ${cw}; paneSt.chat.off = false; panesRender(false);
    tabShow(Ts[${sel}]); if (CS.loaded === Ts[${sel}] || true) csTitle = Ts[${sel}].title;
    tabsPaint(); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); tabsPaint(); document.body.classList.remove("resizing");
    return geo();
  })()`);
  await js(`window.geo = () => {
    const head = document.getElementById("cs-head").getBoundingClientRect(), R = (el) => { const r = el.getBoundingClientRect(); return { x: r.left - head.left, y: r.top - head.top, w: r.width, h: r.height, cx: r.left + r.width / 2 }; };
    const tabs = [...document.querySelectorAll("#cs-tabs .tab")];
    return { head: { w: head.width, h: head.height, top: head.top, left: head.left }, tabs: tabs.map((el) => ({ sid: el.dataset.sid, sel: el.getAttribute("aria-selected") === "true", narrow: el.classList.contains("narrow"), ...R(el),
      bt: parseFloat(getComputedStyle(el).borderTopWidth), xr: R(el.querySelector(".tab-x")), xv: el.querySelector(".tab-xv") ? getComputedStyle(el.querySelector(".tab-xv")).visibility : "(沒有 .tab-xv)", xd: getComputedStyle(el.querySelector(".tab-x")).display })),
      more: document.getElementById("cs-more").hidden ? null : R(document.getElementById("cs-more")), toggle: R(document.getElementById("cs-toggle")), plus: R(document.getElementById("cs-new")), order: CS.order.slice() };
  }; 1;`);
  const st = await js(`({ ws: !document.getElementById("view-ws").hidden, n: CS.tabs.size })`);
  ok("進了工作頁、有一個分頁", st.ws && st.n === 1, st);

  // ── 容量(§13.6 表):標題都長
  for (const [cw, all, more] of [[720, 9, 8], [452, 5, 4], [336, 3, 2]]) {
    let g = await setup(cw, LONG.slice(0, all), 0);
    ok(`${cw}:${all} 個長標題全放、沒有 +N`, g.head.w === cw - 1 && g.tabs.length === all && !g.more, { head: g.head.w, n: g.tabs.length, more: g.more, w: g.tabs.map((t) => t.w) });
    g = await setup(cw, LONG.slice(0, all + 1).concat(all + 1 < LONG.length ? [] : ["多一條"]), 0);
    ok(`${cw}:${all + 1} 個時列上 ${more} 個＋「+N」,最後一格沒被裁`, g.tabs.length === more && !!g.more && g.tabs[g.tabs.length - 1].x + g.tabs[g.tabs.length - 1].w <= g.more.x + 0.5, { n: g.tabs.length, more: g.more, w: g.tabs.map((t) => t.w) });
  }
  // 短標題放得更多(舊的固定公式 452 只放 3)
  { const g = await setup(452, ["A", "B", "C", "D", "E", "F"], 0);
    ok("452:6 個短標題全放(寬跟著標題、本來就窄的不撐大)", g.tabs.length === 6 && !g.more && g.tabs.slice(1).every((t) => t.w < 60), g.tabs.map((t) => t.w)); }
  // 選中的落在後面:排在列尾
  { const g = await setup(452, LONG.slice(0, 8), 7);
    ok("選中第 8 個(收起來的位置):列上是前 3 個＋它,它在列尾", g.tabs.length === 4 && g.tabs[3].sel && g.tabs[3].sid === g.order[7], g.tabs.map((t) => [t.sel, t.sid === g.order[7]])); }
  // 寬度:上限 180、最窄 60／選中 112
  { const g = await setup(720, LONG.slice(0, 2), 0);
    ok("寬度上限 180", g.tabs.every((t) => Math.abs(t.w - 180) < 0.6), g.tabs.map((t) => t.w));
    const g2 = await setup(452, LONG.slice(0, 5), 0);
    ok("452 五個長標題:五個都在列上,選中那格 ≥ 112、其他 ≥ 60", g2.tabs.length === 5 && g2.tabs[0].w >= 111.5 && g2.tabs.slice(1).every((t) => t.w >= 59.5), g2.tabs.map((t) => t.w)); }

  // ── 熱區與本體
  { const g = await setup(452, LONG.slice(0, 3), 0), t0 = g.tabs[0], t1 = g.tabs[1];
    ok("列高 52;分頁元素 y=8、44 高,上框 8 透明 → 看得到的本體 36 貼列下緣", g.head.h === 52 && g.tabs.every((t) => t.y === 8 && t.h === 44 && t.bt === 8), g.tabs.map((t) => [t.y, t.h, t.bt]));
    ok("× 格 32 寬、每格都留(沒選中的也在,平常不畫)", g.tabs.every((t) => t.xr.w === 32 && t.xr.h === 36 && t.xd !== "none") && g.tabs.every((t) => t.xv === "hidden"), g.tabs.map((t) => [t.xr, t.xd, t.xv]));
    ok("☰、＋ 熱區 44×52", g.toggle.w === 44 && g.toggle.h === 52 && g.plus.w === 44 && g.plus.h === 52, [g.toggle, g.plus]);
    const hit = await js(`(() => { const h = document.getElementById("cs-head").getBoundingClientRect(), x = document.querySelectorAll("#cs-tabs .tab-x")[1].getBoundingClientRect(), t = document.querySelectorAll("#cs-tabs .tab")[1].getBoundingClientRect();
      const at = (px, py) => { const e = document.elementFromPoint(px, py); return e ? (e.closest(".tab-x") ? "x" : e.closest(".tab") ? "tab" : e.id || e.className) : null; };
      return { xTop: at(x.left + 16, h.top + 9), xBot: at(x.left + 16, h.top + 51), xL: at(x.left + 1, h.top + 30), tabTop: at(t.left + 20, h.top + 9), drag: at(t.left + 20, h.top + 4), tglTop: at(document.getElementById("cs-toggle").getBoundingClientRect().left + 22, h.top + 1) }; })()`);
    ok("× 熱區伸進透明那 8(y=9 也是 ×)、到列底;分頁上方那 8 也是分頁;列最上 8 不是分頁(拖曳區)", hit.xTop === "x" && hit.xBot === "x" && hit.xL === "x" && hit.tabTop === "tab" && hit.drag === "cs-tabs", hit);
    ok("☰ 熱區撐滿 52(貼頂邊那一點也是它)", hit.tglTop === "cs-toggle", hit);
    // 滑過才畫 ×,寬度不跳
    const before = t1.w;
    await mouse("mouseMove", g.head.left + t1.x + 20, g.head.top + 34);
    const g2 = await js("geo()");
    ok("滑過沒選中的分頁:× 畫出來、寬度不變;其他格不畫", g2.tabs[1].xv === "visible" && g2.tabs[1].w === before && g2.tabs[0].xv === "hidden" && g2.tabs[2].xv === "hidden", g2.tabs.map((t) => [t.xv, t.w]));
    await mouse("mouseMove", g.head.left + t0.x + 20, g.head.top + 34);
    const g3 = await js("geo()");
    ok("滑過選中那格:它的 × 才畫", g3.tabs[0].xv === "visible" && g3.tabs[1].xv === "hidden", g3.tabs.map((t) => t.xv));
    await mouse("mouseMove", 5, 700);
    const sty = await js(`(() => { const el = document.querySelector('#cs-tabs .tab[aria-selected="true"]'), cs = getComputedStyle(el), off = document.querySelector('#cs-tabs .tab:not([aria-selected="true"])');
      return { r: cs.borderTopLeftRadius, rr: cs.borderTopRightRadius, clip: cs.backgroundClip, bg: cs.backgroundColor, card: getComputedStyle(document.querySelector(".pane-chat")).backgroundColor, offBg: getComputedStyle(off).backgroundColor, sep: getComputedStyle(off, "::after").height, selSep: getComputedStyle(el, "::after").content }; })()`);
    ok("選中:填卡面色(= 聊天欄底)、只填看得到的本體、上兩角外緣 8/16 → 本體是正圓 8;沒選中透明", sty.bg === sty.card && sty.clip === "padding-box" && sty.r === "8px 16px" && sty.rr === "8px 16px" && sty.offBg === "rgba(0, 0, 0, 0)", sty);
    ok("分隔線只在兩個沒選中的之間,20 高;選中那格不畫", sty.sep === "20px" && sty.selSep === "none", sty); }

  // ── 窄分頁讓出 × 格:沒選中又被縮到 88 以下
  { const g = await setup(452, LONG.slice(0, 5), 0);
    ok("452 五個長標題:沒選中的被縮到 88 以下 → 讓出 × 格;選中那格照留", g.tabs.slice(1).every((t) => t.w < 88 && t.narrow && t.xd === "none") && !g.tabs[0].narrow && g.tabs[0].xd !== "none", g.tabs.map((t) => [t.w, t.narrow, t.xd]));
    const g2 = await setup(720, LONG.slice(0, 2).concat(["新對話"]), 0);
    ok("本來就短的(新對話)不算窄,× 格照留", !g2.tabs[2].narrow && g2.tabs[2].xd !== "none", g2.tabs.map((t) => [t.w, t.narrow])); }

  // ── 用滑鼠關分頁:寬度凍住,下一顆 × 停在游標底下;離開分頁列才重排
  { const g = await setup(720, LONG.slice(0, 4), 0), t1 = g.tabs[1];
    const px = g.head.left + t1.x + t1.w - 16, py = g.head.top + 34;
    await mouse("mouseMove", px, py); await mouse("mouseDown", px, py); await mouse("mouseUp", px, py);
    const g2 = await js("geo()");
    ok("× 按下去:那條關掉、其餘每格照原寬(後面的往左補位)", g2.tabs.length === 3 && g2.tabs[0].w === g.tabs[0].w && g2.tabs[1].w === g.tabs[2].w && g2.tabs[2].w === g.tabs[3].w && g2.tabs[1].x === t1.x,
      { before: g.tabs.map((t) => [t.x, t.w]), after: g2.tabs.map((t) => [t.x, t.w]) });
    const hitNext = await js(`(() => { const e = document.elementFromPoint(${px}, ${py}); return !!(e && e.closest(".tab-x")); })()`);
    ok("…游標下就是下一顆 ×", hitNext);
    await mouse("mouseMove", 5, 700);
    const g3 = await js(`({ f: CS.freeze, g: geo() })`);
    ok("滑鼠離開分頁列:放掉凍住、照標題重排", g3.f === null && g3.g.tabs.every((t) => Math.abs(t.w - 180) < 0.6), g3.g.tabs.map((t) => t.w));
    // 鍵盤關不凍
    await js(`(() => { const el = document.querySelector('#cs-tabs .tab[aria-selected="true"]'); el.focus(); el.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true })); })()`);
    const g4 = await js(`({ f: CS.freeze, g: geo() })`);
    ok("鍵盤 Delete 關:不凍,剩下的當場照標題重排", g4.f === null && g4.g.tabs.length === 2 && g4.g.tabs.every((t) => Math.abs(t.w - 180) < 0.6), g4.g.tabs.map((t) => t.w)); }

  console.log(red ? `\n${red} 紅` : "\nALL PASS");
  app.exit(red ? 1 : 0);
});
}
