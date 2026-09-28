// 分享框:勾選列在捲動區下方時,主鈕停用要講得出原因(0.1.8 第十八批 DF2;web WF2 的電腦版對應)。
// 視窗矮(1024×680、en、績效報告)時框的內容要捲,勾選在可視範圍外;主鈕停用、訊息槽是空的,用戶不知道要往下捲。
// 勾選不搬到框腳(契約 report-sharing §1:勾之前一定捲過三行),改成在既有的訊息槽出一句。
//   ① 原文:字串 zh / en 都有、勾選仍在捲動區裡
//   ② 真的排版(隨包的 Electron、看不見的視窗):出現與收掉的時機、不蓋掉失敗句與上限句
// 跑法:node tests/check_shell_share_scroll_hint.js(沒設 BLAVE_TEST_WINDOW=1 時 ② SKIP)
const fs = require("fs"), path = require("path"), os = require("os");
const SHELL = path.join(__dirname, "..", "shell"), R = path.join(SHELL, "renderer");
const GATE = require("./_electron_gate");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + String(d).slice(0, 2000))); if (!c) red++; };
const read = (f) => fs.readFileSync(f, "utf8");

if (!process.versions.electron) {
  const str = read(path.join(R, "strings.js")), html = read(path.join(R, "index.html"));
  ok("① shr.scrollHint:en 與 zh 各一句", /"shr\.scrollHint": "Scroll down and tick the box to publish\."/.test(str) && /"shr\.scrollHint": "往下捲，勾選後才能公開。"/.test(str));
  const body = (html.match(/<form class="set-modal shr-modal"[\s\S]*?<div class="modal-foot">/) || [""])[0], foot = (html.match(/id="shr-modal"[\s\S]*?<div class="modal-foot">([\s\S]*?)<\/form>/) || ["", ""])[1];
  ok("① 勾選仍在捲動區(三行之後),沒有搬到框腳", /shr-three[\s\S]*id="shr-ack"/.test(body) && !/shr-ack/.test(foot) && /id="shr-msg" role="status"/.test(foot));
  const bin = GATE.bin(SHELL, "②");
  if (!bin) { console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0); }
  const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit" });
  const sub = r.status == null ? 1 : r.status;
  console.log(red || sub ? `\n${red + sub} 紅` : "\nALL PASS");
  process.exit(red || sub ? 1 : 0);
}

const { app, BrowserWindow } = require("electron");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blave-shr-hint-"));
app.setPath("userData", tmp);
const NOW = Math.floor(Date.now() / 1000);
const REPORT = { schema_version: "1.6", id: "perf", type: "performance", title: "Weekly performance", created_at: NOW - 3600,
  blocks: [{ type: "meta", title: "Weekly performance", origin: "chat" }, { type: "text", variant: "lead", markdown: "Equity rose this week. Second sentence." }] };
const STUB = `window.__s = { state: { code: "OK", share: null, displayName: "Wei" }, pub: { code: "UNREACH" } };
const __fixed = { getLocale: async () => window.__locale || "en-US", loadConnection: async () => ({ kind: "claude" }), detectAgents: async () => ({ claude: { installed: true, loggedIn: true }, codex: { installed: false } }),
  listStrategies: async () => [], listSessions: async () => [], loadSession: async () => [], loadSessionImages: async () => [], updateState: async () => ({ phase: "idle", current: "0.0.0" }),
  hasBlaveToken: async () => true, ensureEngine: async () => ({}), libraryList: async () => ({ strategies: [], signedIn: true, dataAccess: "included" }),
  reportsList: async () => ({ reports: [{ id: "perf", title: "P", type: "performance", created_at: ${NOW - 200}, mtime: ${(NOW - 200) * 1000} }] }), reportLoad: async () => (${JSON.stringify({ report: REPORT, images: {} })}),
  cloudReports: async () => ({ code: "UNREACH", reports: [] }), shareState: async () => window.__s.state, sharePublish: async () => window.__s.pub, trackFeature: () => {} };
window.blave = new Proxy(__fixed, { get: (o, k) => (k in o ? o[k] : typeof k !== "string" ? undefined : k.startsWith("on") ? () => {} : k === "tradeLabels" ? () => {} : async () => undefined) });`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log("FAIL  ② 逾時(90 秒)"); process.exit(1); }, 90000).unref();
const SNAP = `(() => { const g = (x) => document.getElementById(x), b = g("shr-modal").querySelector(".modal-body"), m = g("shr-msg"), cs = getComputedStyle(m), row = g("shr-ack").closest(".shr-chk").getBoundingClientRect(), br = b.getBoundingClientRect(), mr = g("shr-modal").getBoundingClientRect();
  return { open: !g("shr-scrim").hidden, lang: LANG, vw: innerWidth, vh: innerHeight, modalH: Math.round(mr.height), inView: mr.top >= 0 && mr.bottom <= innerHeight, scrollH: b.scrollHeight, clientH: b.clientHeight, top: Math.round(b.scrollTop),
    ackVisible: row.top >= br.top - 0.5 && row.bottom <= br.bottom + 0.5, ackInBody: b.contains(g("shr-ack")), msg: m.textContent, hintCls: m.classList.contains("is-hint"), fs: cs.fontSize, lh: Math.round(parseFloat(cs.lineHeight) / parseFloat(cs.fontSize) * 100) / 100, color: cs.color, ink2: getComputedStyle(g("shr-must")).color,
    desc: g("shr-send").getAttribute("aria-describedby"), send: g("shr-send").disabled, ack: g("shr-ack").checked, focus: document.activeElement && document.activeElement.id, overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth }; })()`;

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  app.on("window-all-closed", () => {});
  const preload = path.join(tmp, "stub.js"); fs.writeFileSync(preload, STUB);
  const open = async (width, height, locale) => {
    fs.writeFileSync(preload, `window.__locale = ${JSON.stringify(locale)};\n` + STUB);
    const w = new BrowserWindow({ width, height, useContentSize: true, show: false, webPreferences: { offscreen: true, preload, contextIsolation: false, sandbox: false } });
    await w.loadFile(path.join(R, "index.html"));
    await wait(1200);
    const js = (s) => w.webContents.executeJavaScript(s, true);
    await js(`(async () => { if (!rptBag().open) await rptOpen(); await new Promise((r) => setTimeout(r, 150)); rptShowRead("perf"); })()`); await wait(500);
    return { w, js, share: async () => { await js(`document.getElementById("rpt-share").click()`); await wait(400); return js(SNAP); }, snap: async () => { await wait(250); return js(SNAP); } };
  };
  const scroll = (p, to) => p.js(`(() => { const b = document.querySelector("#shr-modal .modal-body"); b.scrollTop = ${to === "end" ? "b.scrollHeight" : to}; })()`);

  let p = await open(1024, 680, "en-US");
  const HINT = await p.js(`t("shr.scrollHint")`), FAILED = await p.js(`t("shr.failed")`);
  let s = await p.share();
  console.log(`      en ${s.vw}×${s.vh}:框高 ${s.modalH},捲動區內容 ${s.scrollH}、可視 ${s.clientH}(要捲 ${s.scrollH - s.clientH});訊息槽 ${s.fs}／${s.lh}／${s.color}`);
  ok("② en、1024×680、績效報告:內容要捲、勾選列不在可視範圍(這個測試的前提)", s.open && s.lang === "en" && s.vw === 1024 && s.vh === 680 && s.scrollH > s.clientH && !s.ackVisible && s.focus === "shr-anon", JSON.stringify(s));
  ok("② 開框:訊息槽出「Scroll down and tick the box to publish.」、主鈕停用且 aria-describedby 指向它", s.msg === HINT && HINT === "Scroll down and tick the box to publish." && s.desc === "shr-msg" && s.send, JSON.stringify(s));
  ok("② 樣式:12px／1.5／--ink-2(同揭露小字的字色),不是警示色;框在視窗內、沒有橫向溢出;勾選還在捲動區", s.fs === "12px" && s.lh === 1.5 && s.color === s.ink2 && s.hintCls && s.inView && !s.overflowX && s.ackInBody, JSON.stringify(s));
  await scroll(p, "end"); s = await p.snap();
  ok("② 捲到看得見勾選:提示收掉、aria-describedby 拿掉;主鈕仍停用(還沒勾)", s.ackVisible && s.msg === "" && s.desc === null && !s.hintCls && s.send, JSON.stringify(s));
  await scroll(p, 0); s = await p.snap();
  ok("② 捲回去、勾選又看不到:提示回來", !s.ackVisible && s.msg === HINT && s.desc === "shr-msg", JSON.stringify(s));
  await p.js(`document.getElementById("shr-ack").click()`); await scroll(p, 0); s = await p.snap();
  ok("② 已勾選:勾選列不在可視範圍也不出提示,主鈕可按", s.ack && !s.ackVisible && s.msg === "" && s.desc === null && !s.send, JSON.stringify(s));
  await p.js(`document.getElementById("shr-send").click()`); await wait(300);
  await p.js(`document.getElementById("shr-ack").click()`); await scroll(p, 0); s = await p.snap();
  ok("② 失敗句優先:送出失敗後取消勾選、勾選列看不到,訊息槽仍是失敗那一句", !s.ack && !s.ackVisible && s.msg === FAILED && !s.hintCls, JSON.stringify(s));
  await p.js(`shrClose()`); await wait(100);
  await p.js(`window.__s.state = { code: "OK", share: null, displayName: "Wei", limits: { todayCount: 10, dailyLimit: 10, liveCount: 1, liveLimit: 50 } }`);
  await p.js(`rptShowRead("perf")`); await wait(500);
  s = await p.share();
  ok("② 上限句優先:達每日上限時訊息槽是上限那一句,不是捲動提示", s.open && !s.ackVisible && s.msg === (await p.js(`t("shr.limitDaily", { n: "10" })`)) && s.desc === "shr-msg" && s.send && !s.hintCls, JSON.stringify(s));
  await p.js(`shrClose()`); await wait(100);
  await p.js(`window.__s.state = { code: "OK", share: null, displayName: null }`);
  await p.js(`rptShowRead("perf")`); await wait(500);
  s = await p.share();
  ok("② 沒有名字可掛(焦點直接落在勾選框、框自己捲到看得見):不出提示", s.open && s.focus === "shr-ack" && s.ackVisible && s.msg === "" && s.desc === null, JSON.stringify(s));
  p.w.destroy();

  p = await open(1280, 800, "en-US"); s = await p.share();
  console.log(`      en ${s.vw}×${s.vh}:捲動區內容 ${s.scrollH}、可視 ${s.clientH}`);
  ok("② en、1280×800:不用捲、不出提示", s.open && s.scrollH <= s.clientH && s.ackVisible && s.msg === "" && s.desc === null, JSON.stringify(s));
  p.w.destroy();
  p = await open(1024, 680, "zh-TW"); s = await p.share();
  console.log(`      zh ${s.vw}×${s.vh}:捲動區內容 ${s.scrollH}、可視 ${s.clientH}`);
  ok("② zh、1024×680:勾選看得見就不出提示;看不見就出中文那一句", s.open && s.lang === "zh" && (s.ackVisible ? s.msg === "" && s.desc === null : s.msg === "往下捲，勾選後才能公開。" && s.desc === "shr-msg"), JSON.stringify(s));
  p.w.destroy();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* userData 還鎖著 */ }
  console.log(red ? `\n${red} FAILED` : "\nALL PASS");
  app.exit(red ? 1 : 0);
}).catch((e) => { console.log("FAIL  " + (e && e.stack)); app.exit(1); });
