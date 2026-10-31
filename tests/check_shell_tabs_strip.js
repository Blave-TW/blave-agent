// 電腦版對話分頁列的版面(spec chat-tabs-2026-10-29 §13.13 v5d-28):真的 index.html、假的 window.blave,不顯示的視窗裡量幾何。
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
// 自然寬都超過上限 180(12＋標題＋12):標題至少 13 個字寬
const LONG = ["SOL 突破策略掃參數再看一次全部", "ETH 資金費率套利回測結果比較", "台指期夜盤當沖回測比較三種", "幫我看 BTC 清算地圖哪裡最密", "0050 定期定額比較三種做法",
  "把 RSI 策略轉成 Pine 腳本再回測", "群益帳戶連線測試與下單流程", "美股財報前後波動研究整理", "OKX 網格策略上線前檢查清單", "台股創新高加營收篩選條件"];

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
    return { head: { w: head.width, h: head.height, top: head.top, left: head.left }, tabs: tabs.map((el) => ({ sid: el.dataset.sid, sel: el.getAttribute("aria-selected") === "true", nox: el.classList.contains("nox"), narrow: el.classList.contains("narrow"), ...R(el),
      bt: parseFloat(getComputedStyle(el).borderTopWidth), bb: parseFloat(getComputedStyle(el).borderBottomWidth), ch: el.clientHeight, xr: R(el.querySelector(".tab-x")), xv: el.querySelector(".tab-xv") ? getComputedStyle(el.querySelector(".tab-xv")).visibility : "(沒有 .tab-xv)", xd: getComputedStyle(el.querySelector(".tab-x")).display })),
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
    ok("列高 52;分頁元素 y=4–48(44 高 = 熱區),上下各 8 透明框 → 看得到的本體 28 在 y=12–40", g.head.h === 52 && g.tabs.every((t) => t.y === 4 && t.h === 44 && t.bt === 8 && t.bb === 8 && t.ch === 28), g.tabs.map((t) => [t.y, t.h, t.bt, t.bb, t.ch]));
    // 頂列共同中線 y=26(§13.13.8):量 (top+bottom)/2,從視窗上緣算
    const mid = await js(`(() => { const c = (el) => { const r = el.getBoundingClientRect(); return +((r.top + r.bottom) / 2).toFixed(2); }, q = (s) => document.querySelector(s);
      const sep = q('#cs-tabs .tab:not([aria-selected="true"]):has(+ .tab:not([aria-selected="true"]))'), sr = sep.getBoundingClientRect(), sc = getComputedStyle(sep, "::after");
      return { head: q("#cs-head").getBoundingClientRect().top, title: [...document.querySelectorAll("#cs-tabs .tab-t")].map(c), lead: [...document.querySelectorAll("#cs-tabs .tab-lead")].map(c), x: [...document.querySelectorAll("#cs-tabs .tab-xv")].map(c),
        toggle: c(q("#cs-toggle svg")), plus: c(q("#cs-new svg")), envsw: c(q(".envsw")), sep: +(sr.top + parseFloat(getComputedStyle(sep).borderTopWidth) + parseFloat(sc.top) + parseFloat(sc.height) / 2).toFixed(2) }; })()`);
    const all = [...mid.title, ...mid.lead, ...mid.x, mid.toggle, mid.plus, mid.envsw, mid.sep];
    ok("頂列共同中線 26 ± 0.5:分頁字、狀態格、×、分隔線、☰、＋、本機／雲端切換鈕", mid.head === 0 && all.length >= 9 && all.every((v) => Math.abs(v - 26) <= 0.5), mid);
    ok("× 32×28 蓋在本體尾端(y=12–40、右緣貼分頁右緣),平常不畫", g.tabs.every((t) => t.xr.w === 32 && t.xr.h === 28 && t.xr.y === 12 && Math.abs(t.xr.x + 32 - (t.x + t.w)) < 0.6 && t.xd !== "none" && t.xv === "hidden"), g.tabs.map((t) => [t.xr, t.x, t.w, t.xv]));
    { const n = await setup(720, ["新對話"].concat(LONG.slice(0, 1)), 1), w0 = n.tabs[0];
      const tw = await js(`document.querySelector("#cs-tabs .tab-t").getBoundingClientRect().width`);
      ok("自然寬 = 左 12 + 標題 + 右 12(不再加 × 的 32)", Math.abs(w0.w - (tw + 24)) < 1, { w: w0.w, title: tw }); }
    await setup(452, LONG.slice(0, 3), 0);
    ok("☰、＋ 熱區 44×52", g.toggle.w === 44 && g.toggle.h === 52 && g.plus.w === 44 && g.plus.h === 52, [g.toggle, g.plus]);
    const hitAt = (hx, hy) => js(`(() => { const h = document.getElementById("cs-head").getBoundingClientRect(), x = document.querySelectorAll("#cs-tabs .tab-x")[1].getBoundingClientRect(), t = document.querySelectorAll("#cs-tabs .tab")[1].getBoundingClientRect();
      const at = (px, py) => { const e = document.elementFromPoint(px, py); return e ? (e.closest(".tab-x") ? "x" : e.closest(".tab") ? "tab" : e.id || e.className) : null; };
      return { xTop: at(x.left + 16, h.top + 5), xBot: at(x.left + 16, h.top + 47), xL: at(x.left + 1, h.top + 30), tabTop: at(t.left + 20, h.top + 5), tabBot: at(t.left + 20, h.top + 47), drag: at(t.left + 20, h.top + 3), dragB: at(t.left + 20, h.top + 49), tglTop: at(document.getElementById("cs-toggle").getBoundingClientRect().left + 22, h.top + 1) }; })()`);
    const room = (k) => js(`(() => { const tab = document.querySelectorAll("#cs-tabs .tab")[${k}], t = tab.querySelector(".tab-t"), x = tab.querySelector(".tab-x"), ts = getComputedStyle(t), tr = t.getBoundingClientRect(), xr = x.getBoundingClientRect();
      const mk = ts.webkitMaskImage || ts.maskImage, stops = mk.split("100% - ").slice(1).map((v) => parseFloat(v));
      return { fadeEnd: +(tr.right - (stops[1] || 0)).toFixed(2), fadeStart: +(tr.right - (stops[0] || 0)).toFixed(2), xLeft: +xr.left.toFixed(2), mask: mk, to: ts.textOverflow, xBg: getComputedStyle(x).backgroundColor, xv: getComputedStyle(x).visibility, w: tab.getBoundingClientRect().width }; })()`);
    const hit0 = await hitAt();
    const rPre = await room(1);
    ok("沒滑過時 × 不接點擊(點分頁尾端就是選它)", hit0.xTop === "tab" && hit0.xBot === "tab", hit0);
    await mouse("mouseMove", g.head.left + t1.x + 20, g.head.top + 34);
    const hit = await hitAt();
    ok("滑過時 × 熱區 32×44(y=4–48);分頁熱區也是 y=4–48;列最上、最下 4 不是分頁(拖曳區)", hit.xTop === "x" && hit.xBot === "x" && hit.xL === "x" && hit.tabTop === "tab" && hit.tabBot === "tab" && hit.drag === "cs-tabs" && hit.dragB === "cs-tabs", hit);
    ok("☰ 熱區撐滿 52(貼頂邊那一點也是它)", hit.tglTop === "cs-toggle", hit);
    // 滑過才畫 ×,寬度不跳
    const before = t1.w;
    const g2 = await js("geo()");
    ok("滑過沒選中的分頁:× 畫出來、寬度不變;其他格不畫", g2.tabs[1].xv === "visible" && g2.tabs[1].w === before && g2.tabs[0].xv === "hidden" && g2.tabs[2].xv === "hidden", g2.tabs.map((t) => [t.xv, t.w]));
    // 滑過時標題尾端淡出(mask):完全透明的那一點正好落在 × 左緣,× 不墊底色硬蓋;寬度不變
    const r1 = await room(1);
    ok("滑過沒選中的:滑過前不淡出 → 滑過時標題尾端淡出、刪節號換成 clip、全透明正好在 × 左緣(不切出半個字)、× 不墊底色;總寬不變", rPre.mask === "none" && rPre.to === "ellipsis" && r1.to === "clip" && r1.xv === "visible" && /linear-gradient/.test(r1.mask) && Math.abs(r1.fadeEnd - r1.xLeft) < 0.6 && Math.abs(r1.fadeStart - (r1.fadeEnd - 12)) < 0.01 && r1.xBg === "rgba(0, 0, 0, 0)" && r1.w === before, r1);
    await mouse("mouseMove", g.head.left + t0.x + 20, g.head.top + 34);
    const g3 = await js("geo()");
    ok("滑過選中那格:它的 × 才畫", g3.tabs[0].xv === "visible" && g3.tabs[1].xv === "hidden", g3.tabs.map((t) => t.xv));
    const r0 = await room(0);
    ok("滑過選中那格:標題一樣淡出到 × 左緣,總寬不變", /linear-gradient/.test(r0.mask) && Math.abs(r0.fadeEnd - r0.xLeft) < 0.6 && r0.xBg === "rgba(0, 0, 0, 0)" && r0.w === t0.w, r0);
    await mouse("mouseMove", 5, 700);
    const r2 = await room(1);
    ok("滑走之後:淡出與 clip 都收回、× 不畫", r2.mask === "none" && r2.to === "ellipsis" && r2.xv === "hidden" && r1.mask !== "none", { r1, r2 });
    await mouse("mouseMove", 5, 700);
    const sty = await js(`(() => { const el = document.querySelector('#cs-tabs .tab[aria-selected="true"]'), cs = getComputedStyle(el), off = document.querySelector('#cs-tabs .tab:not([aria-selected="true"])');
      return { r: cs.borderTopLeftRadius, rr: cs.borderTopRightRadius, bl: cs.borderBottomLeftRadius, br: cs.borderBottomRightRadius, clip: cs.backgroundClip, bg: cs.backgroundColor, card: getComputedStyle(document.querySelector(".pane-chat")).backgroundColor, offBg: getComputedStyle(off).backgroundColor, sep: getComputedStyle(off, "::after").height, sepBg: getComputedStyle(off, "::after").backgroundColor, selSep: getComputedStyle(el, "::after").content,
        more: !!document.querySelector("#cs-more .cv7") }; })()`);
    ok("選中:本體填對話區底色(= 聊天欄底)、只填本體、四角外緣 8/16 → 本體是正圓 8;沒選中透明", sty.bg === sty.card && sty.clip === "padding-box" && [sty.r, sty.rr, sty.bl, sty.br].every((v) => v === "8px 16px") && sty.offBg === "rgba(0, 0, 0, 0)", sty);
    ok("分隔線只在兩個沒選中的之間,16 高;選中那格不畫", sty.sep === "16px" && sty.selSep === "none", sty);
    const cl = await js(`(async () => { const body = getComputedStyle(document.getElementById("cs-head")).backgroundColor; document.documentElement.dataset.env = "cloud"; await new Promise((r) => setTimeout(r, 400));
      const off = document.querySelector('#cs-tabs .tab:not([aria-selected="true"])'); const r = { local: body, row: getComputedStyle(document.getElementById("cs-head")).backgroundColor, sep: getComputedStyle(off, "::after").backgroundColor };
      document.documentElement.dataset.env = "local"; await new Promise((res) => setTimeout(res, 400)); return r; })()`);
    ok("雲端視角:分隔線改用 bg-body(hairline 跟灰列底同值會消失)", cl.sep === cl.local && cl.sep !== cl.row, cl);
    // +N 只寫「+N」,不畫 ▾
    const gm = await setup(452, LONG.slice(0, 7), 0);
    const mo = await js(`({ chev: !!document.querySelector("#cs-more .cv7, #cs-more [class*=chev]"), text: document.getElementById("cs-more").textContent })`);
    ok("+N 不畫 ▾", !!gm.more && !mo.chev && mo.text === "+3", mo); }
  // ── 本機／雲端切換鈕:格 36×24、軌 76×28(跟分頁、☰、＋ 同高)、圖示 14、熱區 36×44
  { const e = await js(`(() => { const sw = document.querySelector(".envsw"), b = sw.querySelector("button"), r = (el) => { const x = el.getBoundingClientRect(); return [x.width, x.height]; }, bc = getComputedStyle(b, "::before");
      const R = b.getBoundingClientRect(), cx = R.left + R.width / 2, cy = (R.top + R.bottom) / 2, on = (y) => { const el = document.elementFromPoint(cx, y); return !!el && b.contains(el); };
      return { rail: r(sw), btn: r(b), ic: r(b.querySelector(".envsw-ic")), hit: [cy, on(cy - 22) && on(cy + 21), !on(cy - 23) && !on(cy + 22)] }; })()`);   // 熱區 y=4–48(整數像素:4 與 47 在內、3 與 48 在外)
    ok("切換鈕:格 36×24、軌 76×28、圖示 14、熱區 36×44", e.btn.join() === "36,24" && e.rail.join() === "76,28" && e.ic.join() === "14,14" && e.hit.join() === "26,true,true", e); }

  // ── 窄分頁讓出 × 格:沒選中又被縮到 88 以下
  { const g = await setup(452, LONG.slice(0, 5), 0);
    const nr = await js(`(() => { const t = document.querySelector("#cs-tabs .tab.narrow .tab-t"), ts = t && getComputedStyle(t); return t ? { to: ts.textOverflow, mask: ts.webkitMaskImage || ts.maskImage } : null; })()`);
    ok("最窄的分頁不畫「…」(放不下會剩「新.」):text-overflow clip、尾端 8px 淡出", !!nr && nr.to === "clip" && /linear-gradient\(90deg, rgb\(0, 0, 0\) calc\(100% - 8px\), (transparent|rgba\(0, 0, 0, 0\))\)/.test(nr.mask), nr);
    ok("452 五個長標題:沒選中的被縮到 88 以下 → 讓出 × 格;選中那格照留", g.tabs.slice(1).every((t) => t.w < 88 && t.narrow && t.xd === "none") && !g.tabs[0].narrow && g.tabs[0].xd !== "none", g.tabs.map((t) => [t.w, t.narrow, t.xd]));
    const g2 = await setup(720, LONG.slice(0, 2).concat(["新對話"]), 0), n2 = g2.tabs[2];
    ok("沒選中、寬不到 88 的「新對話」(沒被縮過):不出 ×(× 不佔版面也不接點擊),標題照常(不淡出)", n2.w < 88 && n2.nox && !n2.narrow && n2.xd === "none", g2.tabs.map((t) => [t.w, t.nox, t.narrow, t.xd]));
    const cx = g2.head.left + n2.x + n2.w / 2, cy = g2.head.top + 26;
    await mouse("mouseMove", cx, cy);
    const hv = await js(`(() => { const el = document.querySelectorAll("#cs-tabs .tab")[2], e = document.elementFromPoint(${Math.round(cx)}, ${Math.round(cy)}); return { hit: e ? (e.closest(".tab-x") ? "x" : e.closest(".tab") === el ? "tab" : "other") : null, xd: getComputedStyle(el.querySelector(".tab-x")).display }; })()`);
    ok("…滑過它的正中間:點到的是分頁本體、× 不出現", hv.hit === "tab" && hv.xd === "none", hv);
    await mouse("mouseDown", cx, cy); await mouse("mouseUp", cx, cy);
    const after = await js(`({ n: CS.order.length, cur: CS.cur && CS.cur.sid })`);
    ok("…點它的正中間是切換過去,不會關掉", after.n === 3 && after.cur === n2.sid, { after, want: n2.sid });
    await mouse("mouseMove", 5, 700);
    // 選中那格標題短也最窄 112:× 32 只佔尾端,標題區與分頁中間點下去都停在原地
    const g3 = await setup(720, ["新對話"].concat(LONG.slice(0, 2)), 0), s3 = g3.tabs[0];
    ok("選中的「新對話」(自然寬 60)寬度 ≥ 112", s3.sel && s3.w >= 111.5, g3.tabs.map((t) => [t.sel, t.w]));
    for (const [nm, fx] of [["標題區", "title"], ["分頁正中間", "mid"]]) {
      const pt = await js(`(() => { const el = document.querySelectorAll("#cs-tabs .tab")[0], r = (fx => fx === "title" ? el.querySelector(".tab-t") : el)("${fx}").getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; })()`);
      await mouse("mouseMove", pt[0], pt[1]);
      const hit = await js(`(() => { const e = document.elementFromPoint(${pt[0]}, ${pt[1]}); return e ? (e.closest(".tab-x") ? "x" : e.closest(".tab") ? "tab" : "other") : null; })()`);
      await mouse("mouseDown", pt[0], pt[1]); await mouse("mouseUp", pt[0], pt[1]);
      const st = await js(`({ n: CS.order.length, cur: CS.cur && CS.cur.sid })`);
      ok("選中的「新對話」點" + nm + ":點到分頁本體、停在原地不關", hit === "tab" && st.n === 3 && st.cur === s3.sid, { hit, st, want: s3.sid });
    }
    await mouse("mouseMove", 5, 700); }

  // ── 焦點環四邊都在(稽核 A1):鍵盤焦點在沒選中、選中、被縮窄的分頁上,截圖量環四邊中點都是 --focus-ring 的色(× 出現也不蓋掉)
  // 不顯示的視窗收不到真的鍵盤焦點(document 沒有焦點):用 DevTools 協定把 :focus-visible 強制掛上去,畫的是同一套 CSS
  { const dbg = w.webContents.debugger; dbg.attach("1.3"); await dbg.sendCommand("DOM.enable"); await dbg.sendCommand("CSS.enable");
    let forced = null;
    const force = async (k) => { if (forced) await dbg.sendCommand("CSS.forcePseudoState", { nodeId: forced, forcedPseudoClasses: [] });
      const doc = await dbg.sendCommand("DOM.getDocument", { depth: -1 }), all = await dbg.sendCommand("DOM.querySelectorAll", { nodeId: doc.root.nodeId, selector: "#cs-tabs .tab" });
      forced = all.nodeIds[k]; await dbg.sendCommand("CSS.forcePseudoState", { nodeId: forced, forcedPseudoClasses: ["focus", "focus-visible"] }); };
    const kb = async () => { await mouse("mouseMove", 5, 700); forced = null; };
    const ring = async (k) => {
      await force(k);
      const box = await js(`(() => { const el = document.querySelectorAll("#cs-tabs .tab")[${k}]; const r = el.getBoundingClientRect(), b = parseFloat(getComputedStyle(el).borderTopWidth);
        const probe = document.createElement("i"); probe.style.color = "var(--focus-ring)"; document.body.appendChild(probe); const rgb = getComputedStyle(probe).color; probe.remove();
        return { x: r.left, y: r.top + b, w: r.width, h: r.height - 2 * b, fv: getComputedStyle(el, "::before").boxShadow.includes("inset"), xd: getComputedStyle(el.querySelector(".tab-x")).display + "/" + getComputedStyle(el.querySelector(".tab-x")).visibility, narrow: el.classList.contains("narrow"), sel: el.getAttribute("aria-selected"), rgb }; })()`);
      await wait(150);
      const X = Math.floor(box.x), Y = Math.floor(box.y), W = Math.ceil(box.x + box.w) - X, H = Math.ceil(box.y + box.h) - Y, R0 = box.x + box.w - X, L0 = box.x - X;
      const img = await w.webContents.capturePage({ x: X, y: Y, width: W, height: H }), sz = img.getSize(), bmp = img.toBitmap(), sc = sz.width / W;
      const px = (x, y) => { const o = (Math.round(y * sc) * sz.width + Math.round(x * sc)) * 4; return [bmp[o + 2], bmp[o + 1], bmp[o]]; };   // BGRA
      const want = box.rgb.match(/\d+/g).slice(0, 3).map(Number), near = (p) => p.every((v, i) => Math.abs(v - want[i]) <= 40);
      const mid = Math.floor(H / 2), cx = Math.floor(W / 2);
      return { k, sel: box.sel, narrow: box.narrow, fv: box.fv, xd: box.xd, left: near(px(L0 + 1, mid)), right: near(px(R0 - 1, mid)), top: near(px(cx, 1)), bottom: near(px(cx, H - 2)), rightPx: px(R0 - 1, mid), want };
    };
    const rs = [];
    await setup(720, LONG.slice(0, 4), 1); await kb();
    for (const k of [0, 1]) rs.push(await ring(k));
    await setup(452, LONG.slice(0, 5), 1); await kb();
    rs.push(await ring(0));
    ok("鍵盤焦點:選中、沒選中、被縮窄的分頁,焦點環四邊都在(× 出現時右邊也在)", rs.every((r) => r.fv && r.xd === (r.narrow ? "none/visible" : "flex/visible") && r.left && r.right && r.top && r.bottom)
      && rs.some((r) => r.narrow) && rs.some((r) => r.sel === "true") && rs.some((r) => !r.narrow && r.sel === "false"), rs);
    if (forced) await dbg.sendCommand("CSS.forcePseudoState", { nodeId: forced, forcedPseudoClasses: [] }); dbg.detach();
    const pos = await js(`(() => { const el = document.querySelectorAll("#cs-tabs .tab")[0], tip = document.getElementById("tabs-tip"); delete tip.dataset.off; tabsTip(el, CS.tabs.get(el.dataset.sid)); const m = document.getElementById("cs-menu");
      const h = document.getElementById("cs-head").getBoundingClientRect(), out = { tipTop: tip.hidden ? null : parseFloat(getComputedStyle(tip).top), menuTop: parseFloat(getComputedStyle(m).top) }; tabsTipOff(); return out; })()`);
    ok("tooltip 在分頁本體(y 40)下方 6 → 46;+N 選單在灰底(y 40)下方 8 → 48", pos.menuTop === 48 && pos.tipTop === 46, pos); }
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
