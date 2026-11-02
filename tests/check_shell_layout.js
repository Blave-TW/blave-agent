// 要真的排出來才驗得到的版面(vm 假 DOM 沒有版面):用隨包的 Electron 開真的 index.html + CSS,
// window.blave 換成假的(不起主行程、不碰 workspace、不連網),經真的函式畫,量位置。
// 聊天泡泡(addMsg):
//   ① 貼一段 120 字沒有斷點的 token(金鑰、網址、路徑)→ 泡泡不超出聊天欄、內容不溢出泡泡
//   ② 一般中文與英文不因此在奇怪的地方斷:英文只在空白處換行、短中文一行
//   ③ 對照:把泡泡的 overflow-wrap 蓋回 normal,①要壞(證明量得到那個 bug)
// 文字鈕 .btn-quiet(spec-desktop-settings-cleanup §0):
//   ④ 關於的「服務條款 · 隱私權政策」、隱私頁的「隱私權政策」:字的左緣 = 內容欄起點(關於那一行 #set-up-line 的左緣)
//   ⑤ 對照:把 UA 的左右 padding 蓋回去,④要壞
// 設定 modal 方案 B(spec settings-modal-b-2026-10-24):
//   ⑥ S7/S15 分類欄:目前項底色 = --surface-muted、hover 用的 --surface-row-hover 跟它不同(亮暗都量);視覺高 34、熱區上下各補 5 到 44
//   ⑦ S8 「一般」三組:組內 8、組間 32;「關於」緊接防睡那組、隔 32(不釘底)
//   ⑧ S9 每一類第一行字到內容區頂端 16–23(資料來源空清單時以前是 40)
//   ⑨ 0.1.39 驗收熱區(☰、迴紋針、送出、托盤 ×)⑩ 聊天欄寬度縮放後還原 ⑪ ＋ 不疊空分頁、換語言分頁名跟著換
// 跑法:node tests/check_shell_layout.js(找不到 shell/node_modules 的 Electron 就 SKIP)
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
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "blave-bubble-")));
const STUB = `window.blave = new Proxy({}, { get: (_, k) => typeof k !== "string" ? undefined
  : k.startsWith("on") ? () => {} : k === "tradeLabels" ? () => {}
  : async () => ({ getLocale: "zh-TW", loadConnection: { kind: "claude" }, detectAgents: { claude: { installed: true, loggedIn: true }, codex: { installed: false } },
      listStrategies: [], listSessions: [], loadSession: [], loadSessionImages: [], updateState: { phase: "idle", current: "0.0.0" },
      telemetryGet: true, telemetryInstallId: "a3f9c2e1-7b04-4d6e-9e21-5c0b8d4f1a77" })[k] });`;
const TOKEN = "BINANCE_API_KEY=" + "FAKE_not_a_real_key_".repeat(6).slice(0, 104);   // 120 字、沒有任何斷點
const EN = "Please check whether the strategy still holds after the funding rate flipped negative last week and tell me what changed";
let red = 0; const ok = (n, c, why) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || !why ? "" : "  ← " + why)); if (!c) red++; };

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  const pre = path.join(app.getPath("userData"), "stub.js"); fs.writeFileSync(pre, STUB);
  const w = new BrowserWindow({ width: 1024, height: 760, show: false, webPreferences: { offscreen: true, preload: pre, contextIsolation: false, sandbox: false } });
  await w.loadFile(path.join(SHELL, "renderer", "index.html"));
  await new Promise((r) => setTimeout(r, 1200));
  const measure = (text) => w.webContents.executeJavaScript(`(() => {
    const el = addMsg("you", ${JSON.stringify(text)}), b = el.querySelector(".bubble"), sc = $("chat-scroll");
    const br = b.getBoundingClientRect(), sr = sc.getBoundingClientRect(), tn = b.firstChild;
    // 每一個字的列位置:換列發生在哪一個字前面
    const breaks = []; let top = null;
    for (let i = 0; i < tn.length; i++) { const rg = document.createRange(); rg.setStart(tn, i); rg.setEnd(tn, i + 1); const r = rg.getClientRects()[0]; if (!r) continue;
      if (top != null && r.top > top + 2) breaks.push(i); top = r.top; }
    const out = { right: br.right, scRight: sr.right - parseFloat(getComputedStyle(sc).paddingRight), over: b.scrollWidth - b.clientWidth, scOver: sc.scrollWidth - sc.clientWidth, lines: breaks.length + 1,
      badBreak: breaks.filter((i) => tn.data[i - 1] !== " " && tn.data[i] !== " ").length };
    el.remove(); return out;
  })()`, true);

  const tok = await measure("幫我把這組金鑰綁到真錢帳戶:" + TOKEN);
  ok(`① 120 字的 token:泡泡右緣 ${tok.right.toFixed(1)} 不超過聊天欄內緣 ${tok.scRight.toFixed(1)}、泡泡與聊天欄都沒有橫向溢出`, tok.right <= tok.scRight + 0.5 && tok.over <= 0 && tok.scOver <= 0 && tok.lines > 1);
  const url = await measure("https://blave.org/zh/agent/workspace/" + "a".repeat(100));
  ok("① 長網址同樣收在泡泡裡", url.right <= url.scRight + 0.5 && url.over <= 0);
  const en = await measure(EN);
  ok(`② 英文句只在空白處換行(${en.lines} 行、字中斷行 ${en.badBreak} 處)`, en.lines > 1 && en.badBreak === 0 && en.over <= 0);
  const zh = await measure("幫我看一下 BTC 的 Sharpe");
  ok("② 短中文一行、不被拆", zh.lines === 1);
  await w.webContents.executeJavaScript(`(() => { const s = document.createElement("style"); s.id = "bug"; s.textContent = ".msg.you .bubble { overflow-wrap: normal !important; min-width: auto !important; }"; document.head.appendChild(s); })()`, true);
  const bug = await measure("幫我把這組金鑰綁到真錢帳戶:" + TOKEN);
  ok("③ 對照:overflow-wrap 蓋回 normal 時量得到溢出(這支測試抓得到那個 bug)", bug.right > bug.scRight + 0.5 || bug.over > 0 || bug.scOver > 0);

  // ── 文字鈕:字的左緣要落在它旁邊那條文字邊上 ──
  const textL = (sel) => `(() => { const b = document.querySelector(${JSON.stringify(sel)}), tn = [...b.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
    const rg = document.createRange(); rg.setStart(tn, 0); rg.setEnd(tn, 1); return rg.getBoundingClientRect().left; })()`;
  const legal = async () => {
    await w.webContents.executeJavaScript(`(async () => { running = false; await setOpen(); setCat("display"); })()`, true);
    await new Promise((r) => setTimeout(r, 300));
    const edge = await w.webContents.executeJavaScript(`document.querySelector("#set-up-line").getBoundingClientRect().left`, true);
    const terms = await w.webContents.executeJavaScript(textL("#set-terms"), true), priv1 = await w.webContents.executeJavaScript(textL("#set-privacy"), true);
    // 0.1.32 起隱私頁只剩一顆文字鈕(手機查看、內建瀏覽器搬走了):padding 從一般與隱私兩頁一起收
    const padsOf = `[...document.querySelectorAll("#set-modal .btn-quiet")].filter((b) => b.getClientRects().length).map((b) => getComputedStyle(b).paddingLeft + "/" + getComputedStyle(b).paddingRight)`;
    const pads0 = await w.webContents.executeJavaScript(padsOf, true);
    await w.webContents.executeJavaScript(`setCat("priv")`, true); await new Promise((r) => setTimeout(r, 400));
    const pedge = await w.webContents.executeJavaScript(`document.querySelector("#set-priv .sw-l").getBoundingClientRect().left`, true);
    const priv2 = await w.webContents.executeJavaScript(textL("#priv-legal"), true);
    const pads = pads0.concat(await w.webContents.executeJavaScript(padsOf, true));
    await w.webContents.executeJavaScript(`setClose()`, true);
    return { edge, terms, priv1, pedge, priv2, pads };
  };
  const L1 = await legal();
  ok(`④ 關於:「服務條款」的字在關於那一行的起點上(${L1.terms.toFixed(1)} vs ${L1.edge.toFixed(1)}),「隱私權政策」在它右邊`, Math.abs(L1.terms - L1.edge) < 0.5 && L1.priv1 > L1.terms);
  ok(`④ 隱私頁:「隱私權政策」的字在內容欄起點(${L1.priv2.toFixed(1)} vs ${L1.pedge.toFixed(1)})`, Math.abs(L1.priv2 - L1.pedge) < 0.5);
  ok("④ 設定裡看得到的文字鈕左右 padding 都是 0(" + L1.pads.length + " 顆)", L1.pads.length >= 2 && L1.pads.every((x) => x === "0px/0px"));
  await w.webContents.executeJavaScript(`(() => { const s = document.createElement("style"); s.textContent = ".btn-quiet { padding: 1px 6px !important; }"; document.head.appendChild(s); })()`, true);
  const L2 = await legal();
  ok("⑤ 對照:文字鈕的 UA padding 蓋回去時,字就不在那條線上(這支測試抓得到那 6px)", Math.abs(L2.terms - L2.edge) > 3 && Math.abs(L2.priv2 - L2.pedge) > 3);
  await w.webContents.executeJavaScript(`document.getElementById("bug-pad") && document.getElementById("bug-pad").remove()`, true);
  await w.webContents.executeJavaScript(`[...document.querySelectorAll("style")].filter((s) => /padding: 1px 6px/.test(s.textContent)).forEach((s) => s.remove())`, true);
  const X = (s) => w.webContents.executeJavaScript(s, true), nap = (ms) => new Promise((r) => setTimeout(r, ms));
  await X(`(async () => { await setOpen(); setCat("display"); })()`); await nap(300);
  for (const theme of ["light", "dark"]) {
    await X(`document.documentElement.setAttribute("data-theme", ${JSON.stringify(theme)})`); await nap(400);   // 等底色的 transition 跑完
    const c = await X(`(() => {
      const probe = (v) => { const d = document.createElement("div"); d.style.background = "var(" + v + ")"; document.getElementById("set-modal").appendChild(d); const c = getComputedStyle(d).backgroundColor; d.remove(); return c; };
      const cur = document.querySelector('.set-cat[aria-current="true"]'), cs = getComputedStyle(cur);
      return { cur: cs.backgroundColor, w: cs.fontWeight, muted: probe("--surface-muted"), hover: probe("--surface-row-hover"), card: probe("--surface-card"),
        rule: [...document.styleSheets].some((sh) => { try { return [...sh.cssRules].some((r) => r.media && r.media.mediaText === "(hover: hover)" && [...r.cssRules].some((x) => x.selectorText === '.set-cat:not([aria-current="true"]):hover' && /--surface-row-hover/.test(x.style.background))); } catch (_) { return false; } }) }; })()`);
    ok(`⑥ S7 ${theme}:目前項 = --surface-muted＋600(${c.cur});hover 走 --surface-row-hover(${c.hover}),跟目前項、卡面都不同`, c.cur === c.muted && c.w === "600" && c.hover !== c.muted && c.hover !== c.card && c.rule);
  }
  await X(`document.documentElement.setAttribute("data-theme", "light")`);
  const hit = await X(`(() => { const cats = [...document.querySelectorAll("#set-cats .set-cat")].filter((b) => !b.hidden), f = cats[0], l = cats[cats.length - 1], a = f.getBoundingClientRect(), b = l.getBoundingClientRect(), x = a.left + a.width / 2;
    const at = (y) => { const e = document.elementFromPoint(x, y); return e && e.closest(".set-cat"); };
    const own = cats.every((c) => { const r = c.getBoundingClientRect(); return at(r.top + 1) === c && at(r.bottom - 1) === c; });
    const conn = document.querySelector('#set-cats .set-cat[data-set-cat="connect"]');
    return { h: cats.map((c) => Math.round(c.getBoundingClientRect().height)), up: at(a.top - 4) === f, down: at(b.bottom + 4) === l, outUp: at(a.top - 6) !== f, outDown: at(b.bottom + 6) !== l, own,
      connHidden: !!conn && conn.hidden && getComputedStyle(conn).display === "none" }; })()`);
  ok(`⑥ S15 分類鈕視覺高 34(${hit.h.join("/")}),熱區上下各多 5:邊外 4px 還點得到、6px 點不到;每顆可見框的上下緣 1px 點到的都是自己(不被鄰居的熱區吃掉)`, hit.h.every((h) => h === 34) && hit.up && hit.down && hit.outUp && hit.outDown && hit.own, JSON.stringify(hit));
  ok("⑥ 平台沒開放手機查看時,「連結」那顆真的不佔位(display: none)", hit.connHidden);
  const gap = await X(`(() => { const r = (id) => document.querySelector(id).getBoundingClientRect(), rows = [...document.querySelectorAll('#set-modal .set-pane[data-set-cat="display"] > .set-row')].filter((x) => !x.hidden).map((x) => x.getBoundingClientRect());
    const sc = document.querySelector(".set-content").getBoundingClientRect();
    return { inRows: rows.slice(1).map((x, i) => Math.round(x.top - rows[i].bottom)), toRn: Math.round(r(".set-rn").top - rows[rows.length - 1].bottom), rnRs: Math.round(r(".set-rs").top - r(".set-rn").bottom), rsSug: Math.round(r(".set-sug").top - r(".set-rs").bottom), sugAwake: Math.round(r(".set-awake").top - r(".set-sug").bottom),
      awakeAbout: Math.round(r("#set-up").top - r(".set-awake").bottom), aboutGap: Math.round(sc.bottom - r("#set-up").bottom) }; })()`);
  ok(`⑦ S8 一般:組內 8(${gap.inRows.join("/")}、防睡 ${gap.sugAwake});開關列撐到 44、彼此不留空(${gap.rnRs}、${gap.rsSug},設計稽核 B4);組間 32(→回覆通知 ${gap.toRn}、→關於 ${gap.awakeAbout});關於不釘底`, gap.inRows.every((g) => g === 8) && gap.rnRs === 0 && gap.rsSug === 0 && gap.sugAwake === 8 && gap.toRn === 32 && gap.awakeAbout === 32, JSON.stringify(gap));
  const tops = {};
  for (const cat of ["display", "model", "src", "plan", "priv"]) {
    await X(`setCat(${JSON.stringify(cat)})`); await nap(350);
    tops[cat] = await X(`(() => { const sc = document.querySelector(".set-content"), pane = [...sc.children].find((p) => !p.hidden), tw = document.createTreeWalker(pane, NodeFilter.SHOW_TEXT);
      let n; while ((n = tw.nextNode())) { if (!n.textContent.trim()) continue; const rg = document.createRange(); rg.selectNodeContents(n); const b = rg.getBoundingClientRect(); if (b.height) return Math.round(b.top - sc.getBoundingClientRect().top); } return null; })()`);
  }
  // 量的是第一個文字節點的行框頂(含行高的上半),比字形頂多 1–2px:一般那一類的第一列是 34 高的下拉列、字置中,量到 25
  ok(`⑧ S9 每一類第一行字到內容區頂端都在 16–25(資料來源以前多 24):${JSON.stringify(tops)}`, Object.values(tops).every((v) => v !== null && v >= 16 && v <= 25));
  await X(`setClose()`); await nap(300);
  // ⑨ 0.1.39 驗收的熱區(canon Fitts 44,視覺不變):從鈕中心往四個方向掃 elementFromPoint,量自己吃得到的範圍
  const HIT = `window.__hit = (el) => { const b = el.getBoundingClientRect(), cx = b.x + b.width / 2, cy = b.y + b.height / 2;
    const own = (x, y) => { const t = document.elementFromPoint(x, y); return !!t && (t === el || el.contains(t)); };
    let l = cx, r = cx, u = cy, d = cy; while (own(l - 1, cy) && l > 0) l--; while (own(r + 1, cy) && r < innerWidth) r++; while (own(cx, u - 1) && u > 0) u--; while (own(cx, d + 1) && d < innerHeight) d++;
    return { vw: Math.round(b.width), vh: Math.round(b.height), w: r - l + 1, h: d - u + 1 }; };`;
  const hits = await X(`(() => { ${HIT} const tr = $("sug-tray-x").parentElement, was = tr.hidden; tr.hidden = false;
    const o = {}; for (const id of ["cs-toggle", "attach-btn", "btn-send", "sug-tray-x"]) o[id] = __hit($(id));
    const ta = $("ta").getBoundingClientRect(); o.taBottom = document.elementFromPoint(ta.x + 20, ta.bottom - 1) === $("ta"); tr.hidden = was; return o; })()`);
  ok(`⑨ ☰ 熱區 44×52(不被聊天欄分隔線蓋掉):${JSON.stringify(hits["cs-toggle"])}`, hits["cs-toggle"].w >= 44 && hits["cs-toggle"].h >= 52);
  ok(`⑨ 迴紋針、送出視覺 32、熱區 ≥44×44;× 視覺 36、熱區 ≥44;輸入格最底那條線還是輸入格的:${JSON.stringify(hits)}`,
    ["attach-btn", "btn-send"].every((k) => hits[k].vw === 32 && hits[k].vh === 32 && hits[k].w >= 44 && hits[k].h >= 44) && hits["sug-tray-x"].vw === 36 && hits["sug-tray-x"].w >= 44 && hits["sug-tray-x"].h >= 44 && hits.taBottom);
  // ⑩ 聊天欄寬度:視窗縮小只夾畫出來的寬,拉回來還原成用戶拉的寬(0.1.39 Mac 實測縮到 1024 再拉回停在 364)
  w.setContentSize(1440, 760); await nap(500);
  const w0 = await X(`paneSt.chat.w`);
  w.setContentSize(1024, 760); await nap(500);
  const w1 = await X(`paneSt.chat.w`);
  w.setContentSize(1440, 760); await nap(500);
  const w2 = await X(`paneSt.chat.w`);
  ok(`⑩ 聊天欄 1440 → 1024 → 1440:${w0} → ${w1} → ${w2}(縮小時夾、拉回還原)`, w0 === 452 && w1 < 452 && w2 === 452);
  w.setContentSize(1024, 760); await nap(300);
  // ⑪ 已經有空白又閒著的分頁時按 ＋:切過去用它,不再開一個(0.1.39 Mac 實測兩個「新對話」並排);換語言時分頁名跟著換
  const tb = await X(`(() => { const first = CS.cur; csStartNew({ force: true, quiet: true }); const second = CS.cur; csTitle = "測試問題"; tabsPaint();
    const n0 = CS.tabs.size; csNewClick(); const reuse = CS.cur === first && CS.tabs.size === n0;
    applyLangChoice("en"); const en = [...$("cs-tabs").querySelectorAll(".tab-t")].map((x) => x.textContent);
    applyLangChoice("zh"); const zh = [...$("cs-tabs").querySelectorAll(".tab-t")].map((x) => x.textContent);
    return { reuse, n0, two: second !== first, en, zh }; })()`);
  // ⑫ 更新膠囊「重新啟動更新：{v}」(Wei 11-01):側欄預設 236 與最窄 180、zh／en、下單中多一個「…」,字都完整(span 不溢出),記下有沒有拿掉圖示
  w.setContentSize(1440, 760); await nap(400);
  const pills = [], UP0 = await X(`JSON.stringify(UP)`);
  for (const lang of ["zh", "en"]) for (const sw of [236, 180]) for (const ph of ["ready", "blocked"]) {
    await X(`setLang(${JSON.stringify(lang)}); paneSt.side.off = false; paneSt.side.w = paneSt.side.want = ${sw}; panesRender(false); UP = { phase: ${JSON.stringify(ph)}, version: "0.1.41", current: "0.1.40" }; upPillPaint();`); await nap(450);
    pills.push(await X(`(() => { upPillFit(); const tx = $("up-pill-t"), pl = $("up-pill");
      return { lang: ${JSON.stringify(lang)}, sw: ${sw}, ph: ${JSON.stringify(ph)}, text: tx.textContent, sw0: tx.scrollWidth, cw: tx.clientWidth, pill: Math.round(pl.getBoundingClientRect().width), title: pl.title, aria: pl.getAttribute("aria-label"),
        foot: Math.round(document.querySelector(".ws-foot").getBoundingClientRect().width), noIc: pl.classList.contains("no-ic") }; })()`)); }
  await X(`setLang("zh"); UP = ${UP0}; upPillPaint(); paneSt.side.w = paneSt.side.want = PANES.side.def; panesRender(false);`);
  w.setContentSize(1024, 760); await nap(300);
  console.log("      膠囊量測:" + JSON.stringify(pills));
  const at = (sw) => pills.filter((x) => x.sw === sw);
  ok(`⑫ 膠囊預設側欄 236:全句、zh／en、下單中,字完整、版號完整`, at(236).length === 4 && at(236).every((x) => x.sw0 <= x.cw && x.text.includes("0.1.41") && /重新啟動更新|Restart to update/.test(x.text)), JSON.stringify(at(236)));
  ok(`⑫ 最窄側欄 180:換短句「更新：0.1.41」、版號不被切、全句在 title 與可及名稱`, at(180).length === 4 && at(180).every((x) => x.sw0 <= x.cw && /^(更新：|Update: )0\.1\.41…?$/.test(x.text) && /重新啟動更新|Restart to update/.test(x.title) && x.aria === x.title), JSON.stringify(at(180)));
  // ⑭ 設計稽核 B4 的熱區(視覺不變):側欄 ＋／資料夾鈕 44×44 不重疊、提示音開關 44×44、「開啟系統設定」80×45
  const hot = await X(`(async () => { ${HIT} const o = {}, add = $("strat-add"), sg = $("sg-add"); $("strat-head").hidden = false; sg.hidden = false; o.add = __hit(add); o.sg = __hit(sg);
    await setOpen(); setCat("display"); await new Promise((r) => setTimeout(r, 400)); o.sw = __hit($("set-rs-sw")); const os = $("set-rn-os"), was = os.hidden; os.hidden = false; await new Promise((r) => setTimeout(r, 100)); o.go = __hit($("set-rn-os-go")); o.sug = __hit(document.querySelector(".set-sug .sw") || $("set-rs-sw")); os.hidden = was; setClose(); return o; })()`);
  ok(`⑭ 側欄 ＋、資料夾鈕視覺 28、熱區 ≥44×44:${JSON.stringify([hot.add, hot.sg])}`, [hot.add, hot.sg].every((x) => x.vw === 28 && x.vh === 28 && x.w >= 44 && x.h >= 44));
  // ⑯ 兩顆隔 4(同網頁):熱區透明外擴不佔版面、貼著不重疊;預設 236 與最窄 180 都量,標題不被擠
  w.setContentSize(1440, 760); await nap(400);
  for (const sw of [236, 180]) {
    const g = await X(`(async () => { ${HIT} paneSt.side.off = false; paneSt.side.w = paneSt.side.want = ${sw}; panesRender(false); await new Promise((r) => setTimeout(r, 450));
      const a = $("sg-add"), b = $("strat-add"), ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(), y = ra.y + ra.height / 2, l = document.querySelector("#strat-head .label"), rl = l.getBoundingClientRect();
      let dead = 0, both = 0, last = null; for (let x = Math.floor(ra.right); x < Math.ceil(rb.left); x++) { const e = document.elementFromPoint(x + 0.5, y); const own = e === a || a.contains(e) ? "a" : e === b || b.contains(e) ? "b" : null; if (!own) dead++; else if (last === "b" && own === "a") both++; last = own; }
      return { gap: rb.left - ra.right, a: __hit(a), b: __hit(b), dead, both, labelW: rl.width, labelGap: ra.left - rl.right, headOver: rb.right - $("strat-head").getBoundingClientRect().right, paneOver: (() => { const p = $("strat-head").parentElement; return { over: p.scrollWidth - p.clientWidth, ox: getComputedStyle(p).overflowX, cls: p.className }; })() }; })()`);
    ok(`⑯ 側欄 ${sw}:圖示隔 4、熱區各 ≥44×44、中間沒有死區也沒有搶點、標題有留位:${JSON.stringify(g)}`, g.gap === 4 && g.a.vw === 28 && g.b.vw === 28 && g.a.w >= 44 && g.b.w >= 44 && g.a.h >= 44 && g.b.h >= 44 && g.dead === 0 && g.both === 0 && g.labelGap >= 16 && g.headOver <= 0 && (g.paneOver.over <= 0 || g.paneOver.ox === "hidden" || g.paneOver.ox === "visible" || g.paneOver.ox === "clip"), JSON.stringify(g));
  }
  await X(`paneSt.side.w = paneSt.side.want = PANES.side.def; panesRender(false);`); w.setContentSize(1024, 760); await nap(300);
  ok(`⑭ 提示音開關熱區 ≥44×44、下一顆也是;「開啟系統設定」熱區 ≥44 高:${JSON.stringify([hot.sw, hot.sug, hot.go])}`, hot.sw.w >= 44 && hot.sw.h >= 44 && hot.sug.h >= 44 && hot.go.h >= 44 && hot.go.w >= 80);
  // ⑬ 投資組合列的標的格寫股票名字:欄窄時只在名字之間換行,不把一個名字拆兩半,也不把表撐開
  const nm = await X(`(() => { const host = document.createElement("div"); host.style.cssText = "position:fixed;left:0;top:0;width:420px;background:#fff;z-index:99";
    const names = ["元大台灣高股息優質低波動基金", "聯電", "國泰台灣領袖五十正二基金甲"], out = [];
    for (const sep of [", ", "、"]) { host.innerHTML = '<table class="pf-tbl" style="width:100%"><tr><td class="key">策略</td><td class="sname c-sym"></td><td class="n">100,000</td></tr></table>';
      document.body.appendChild(host); const c = host.querySelector(".c-sym"); c.textContent = names.join(sep) + " 等 6 檔";
      const tn = c.firstChild, lines = []; let top = null, cur = ""; const rg = document.createRange();
      for (let i = 0; i < tn.length; i++) { rg.setStart(tn, i); rg.setEnd(tn, i + 1); const b = rg.getClientRects()[0]; if (!b) continue; if (top != null && b.top > top + 2) { lines.push(cur); cur = ""; } top = b.top; cur += tn.data[i]; } lines.push(cur);
      out.push({ lines, over: host.scrollWidth - host.clientWidth }); host.remove(); }
    return { out, names }; })()`);
  ok(`⑬ 標的格窄欄:名字不被拆成兩半、表沒有撐開:${JSON.stringify(nm.out)}`, nm.out.every((o) => o.lines.length > 1 && o.over <= 0 && nm.names.every((n) => o.lines.some((l) => l.includes(n)))));
  // ⑮ 金額格實際輸入序列(設計全流程稽核 P1-2):新列格子空的;游標落在最前面(滑鼠點中間)打 1000 就是 1,000,不是 10,000;沒打就離開還是空的,不補 0
  const seq = await X(`(async () => {
    const fake = Object.assign({}, TR.st, { alive: true, report: { venues: {}, config: { amounts: { kept: 2000 } }, states: { kept: { symbol: "BTCUSDT", position: 1 } }, reconciler: { alive: false } } });
    TR.st = fake; TR.list = [{ name: "fresh", displayName: "新策略", hasBacktest: true, symbol: "ETHUSDT", market: "swap", universe: [] }, { name: "kept", displayName: "已存", hasBacktest: true, symbol: "BTCUSDT", market: "swap", universe: [] }]; TR.listLoaded = true;
    TR.picked = new Set(["fresh", "kept"]); TR.edits = {}; TR.raw = {}; TR.bad = {}; TR.view = "po"; TR.open = true; TR.poTab = "cfg"; $("po-view") && ($("po-view").hidden = false); TR.sig.cfg = null;
    const box = $("po-cfg"), host = box.parentElement; let up = box; while (up && up !== document.body) { up.hidden = false; up = up.parentElement; } poPaintCfg();
    const cell = (n) => box.querySelector('.amt-in[data-amt="' + n + '"]'), a = cell("fresh"), out = { start: a ? a.value : null, keptStart: cell("kept") ? cell("kept").value : null };
    a.focus(); a.dispatchEvent(new FocusEvent("blur")); out.blurEmpty = a.value;
    a.focus(); a.setSelectionRange(0, 0); document.execCommand("insertText", false, "1000"); out.typed = a.value; out.edit = TR.edits.fresh; a.dispatchEvent(new FocusEvent("blur")); out.after = a.value;
    const k = cell("kept"); k.focus(); k.select(); document.execCommand("delete"); k.dispatchEvent(new FocusEvent("blur")); out.keptCleared = k.value;
    const sv = () => box.querySelector('[data-fk="save"]');
    if (document.activeElement) document.activeElement.blur(); TR.edits = {}; TR.raw = {}; TR.bad = {}; TR.picked = new Set(["fresh", "kept"]); TR.sig.cfg = null; poPaintCfg(); out.saveOffBlank = sv() ? sv().disabled : null;
    const f2 = cell("fresh"); f2.focus(); f2.setSelectionRange(0, 0); document.execCommand("insertText", false, "300"); out.saveOffTyped = sv() ? sv().disabled : null;
    TR.picked = null; TR.edits = {}; TR.raw = {}; TR.list = []; return out; })()`);
  ok(`⑮ 只有空的新列:〔儲存〕停用;打了金額立刻可按:${JSON.stringify([seq.saveOffBlank, seq.saveOffTyped])}`, seq.saveOffBlank === true && seq.saveOffTyped === false);
  ok(`⑮ 新列格子空的、游標在最前面打 1000 是 1,000、沒打就離開不補 0;已存過金額清空照舊寫 0:${JSON.stringify(seq)}`, seq.start === "" && seq.keptStart === "2,000" && seq.blurEmpty === "" && seq.typed === "1000" && seq.edit === 1000 && seq.after === "1,000" && seq.keptCleared === "0");
  ok(`⑪ 別的分頁空著又閒著:＋ 切過去、不疊空分頁;換語言分頁名跟著換:${JSON.stringify(tb)}`, tb.two && tb.reuse && tb.en.includes("New chat") && !tb.en.includes("新對話") && tb.zh.includes("新對話"));
  console.log(red ? `\n${red} 紅` : "\nALL PASS");
  app.exit(red ? 1 : 0);
});
