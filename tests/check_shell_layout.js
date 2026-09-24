// 要真的排出來才驗得到的版面(vm 假 DOM 沒有版面):用隨包的 Electron 開真的 index.html + CSS,
// window.blave 換成假的(不起主行程、不碰 workspace、不連網),經真的函式畫,量位置。
// 聊天泡泡(addMsg):
//   ① 貼一段 120 字沒有斷點的 token(金鑰、網址、路徑)→ 泡泡不超出聊天欄、內容不溢出泡泡
//   ② 一般中文與英文不因此在奇怪的地方斷:英文只在空白處換行、短中文一行
//   ③ 對照:把泡泡的 overflow-wrap 蓋回 normal,①要壞(證明量得到那個 bug)
// 文字鈕 .btn-quiet(spec-desktop-settings-cleanup §0):
//   ④ 關於的「服務條款 · 隱私權政策」、隱私頁的「隱私權政策」:字的左緣 = 內容欄起點(關於那一行 #set-up-line 的左緣)
//   ⑤ 對照:把 UA 的左右 padding 蓋回去,④要壞
// 跑法:node tests/check_shell_layout.js(找不到 shell/node_modules 的 Electron 就 SKIP)
const path = require("path"), fs = require("fs");
const SHELL = path.join(__dirname, "..", "shell");

if (!process.versions.electron) {
  const bin = path.join(SHELL, "node_modules", ".bin", "electron");
  if (!fs.existsSync(bin)) { console.log("SKIP  找不到 shell/node_modules 的 Electron(先 cd shell && npm install)"); process.exit(0); }
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
let red = 0; const ok = (n, c) => { console.log((c ? "PASS  " : "FAIL  ") + n); if (!c) red++; };

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
    await w.webContents.executeJavaScript(`setCat("priv")`, true); await new Promise((r) => setTimeout(r, 400));
    const pedge = await w.webContents.executeJavaScript(`document.querySelector("#set-priv .sw-l").getBoundingClientRect().left`, true);
    const priv2 = await w.webContents.executeJavaScript(textL("#priv-legal"), true);
    const pads = await w.webContents.executeJavaScript(`[...document.querySelectorAll("#set-modal .btn-quiet")].filter((b) => b.getClientRects().length).map((b) => getComputedStyle(b).paddingLeft + "/" + getComputedStyle(b).paddingRight)`, true);
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
  console.log(red ? `\n${red} 紅` : "\nALL PASS");
  app.exit(red ? 1 : 0);
});
