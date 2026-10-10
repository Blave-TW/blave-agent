// 內建瀏覽器的「交還 agent」(0.1.20 A 案,設計師 browser-captcha-handback spec 七條):接手中請求卡上「我來…」換成實心主鈕
// 「好了，交還 agent」(所有接手型別;確認網址不是接手,照留「仍要開啟」),標題列只剩手形＋「你在操作」、不放鈕;聊天那一列的 .pt-hb 照留。
//   ① 純 node:brAsk / brStatLine 的結構、CSS 把標題列那顆鈕與 ≤440 的收字規則拿掉、埋點 browser_hb_card、驗證卡文案最後一個子句 = 鈕字逐字相同
//   ② Electron(BLAVE_TEST_WINDOW=1):接手前後請求卡同高(同一列換一顆同尺寸的鈕)、鈕順序描邊出口在左 / 實心在右、接手那一刻不送 bounds(去重)、標題列沒有鈕
// 跑法:node tests/check_shell_browser_handback_card.js(沒設 BLAVE_TEST_WINDOW=1 時 Electron 那段 SKIP)
const path = require("path"), fs = require("fs"), os = require("os");
const SHELL = path.join(__dirname, "..", "shell");
const GATE = require("./_electron_gate");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + String(d).slice(0, 2000))); if (!c) red++; };
if (!process.versions.electron) {
  const css = fs.readFileSync(path.join(SHELL, "renderer", "browser.css"), "utf8");
  const js = fs.readFileSync(path.join(SHELL, "renderer", "browser.js"), "utf8");
  const cut = (src, head) => { const i = src.indexOf(head); if (i < 0) throw new Error("找不到 " + head); let d = 0; for (let k = src.indexOf("{", src.indexOf(")", i)); k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}" && --d === 0) return src.slice(i, k + 1); } throw new Error("切不出 " + head); };
  const ask = cut(js, "function brAsk("), head = cut(js, "function brStatLine(");
  ok("① 標題列(brStatLine)接手中只畫手形＋「你在操作」,沒有鈕;browser_hb_head 整支 renderer 都不再送",
    /if \(brUserOp\(x\)\) \{ host\.append\(brIcon\("hand"\), brEl\("span", "t", t\("br\.userOp"\)\)\); return; \}/.test(head) && !/btn-fill/.test(head) && !/browser_hb_head/.test(js));
  ok("① browser.css:標題列那顆鈕的尺寸規則與 ≤440「狀態句收掉只留鈕」的 container query 都拿掉;狀態句那一格照舊 18 高、只截文字那一段",
    !/\.bw-stat \.btn-fill/.test(css) && !/max-width: 440px/.test(css) && /\.bw-stat \{[^}]*height: 18px;/.test(css) && /\.bw-stat \.t \{ flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; \}/.test(css));
  ok("① 請求卡(brAsk):描邊出口先 append(在左);沒接手或確認網址 → 「我來…」/「仍要開啟」;接手中(brUserOp)→ .btn-fill「好了，交還 agent」在右;卡只有 txt + act 兩塊(接手前後同一列、卡不長高)",
    /act\.append\(skip\);\s*if \(!x\.user \|\| k === "confirm"\) act\.append\(me\);\s*else if \(brUserOp\(x\)\) \{\s*const hb = brEl\("button", "btn-fill", t\("br\.handback\.done"\)\); hb\.type = "button";/.test(ask)
    && /act\.append\(hb\);\s*\}\s*box\.append\(txt, act\);/.test(ask) && !/if \(x\.user\) /.test(ask));
  ok("① 卡上那顆:aria-label「交還 agent：{網域}」;按了記 browser_handoff(照舊,卡一定帶 need)＋ browser_hb_card、交還、念「已交還 agent」(鈕跟卡一起消失,讀屏要有回饋)",
    /hb\.setAttribute\("aria-label", t\("br\.handback\.aria", \{ domain: brReg\(brHost\(x\.url\)\) \|\| x\.url \}\)\);/.test(ask)
    && /hb\.addEventListener\("click", \(\) => \{ trackFeature\("browser_handoff"\); trackFeature\("browser_hb_card"\); window\.blave\.browserHandback\(x\.id\); srSay\(t\("br\.handedBack"\)\); \}\);/.test(ask));
  ok("① 聊天那一列的 .pt-hb 照留(中欄收起時的出口),埋點 browser_hb_chat 不動", /brEl\("button", "btn-out pt-hb"\)/.test(js) && /trackFeature\("browser_hb_chat"\); window\.blave\.browserHandback\(id\); srSay\(t\("br\.handedBack"\)\);/.test(cut(js, "function brSyncHold(")));
  ok("① 請求卡的鈕列照 canon 第 6 條:gap 8、align-self center;中欄 ≤600 整張卡改直排、鈕列靠右(既有規則,沒新寫)",
    /\.ask \.act \{ flex: none; display: flex; gap: var\(--space-8\); align-self: center; \}/.test(css) && /@container main \(max-width: 600px\) \{[^@]*\.bv \.ask \{ flex-direction: column; gap: var\(--space-12\); \}\s*\.bv \.ask \.act \{ align-self: flex-end; \}/.test(css));
  ok("① 畫面送 bounds 只有 brSendBounds 一個出口而且去重(同一個位置不再送 → 接手那一刻網頁不動)", (js.match(/window\.blave\.browserBounds\(/g) || []).length === 1
    && /function brSendBounds\(b\) \{ const key = JSON\.stringify\(b\); if \(key === brLastBounds\) return; brLastBounds = key; window\.blave\.browserBounds\(b\); \}/.test(js));
  { const S = new Function(fs.readFileSync(path.join(SHELL, "renderer", "strings.js"), "utf8") + "; return STRINGS;")();
    ok("① 驗證卡文案(br.ask.captcha.p):講「過了會自動接著搜尋」也講「沒接上再按」,引用的鈕字跟 br.handback.done 逐字相同;zh 用「」、en 用雙引號",
      S.zh["br.ask.captcha.p"] === "搜尋次數一多，{engine} 會要確認是真人在用。驗證由你自己按，agent 不會代按；過了會自動接著搜尋，沒接上再按「" + S.zh["br.handback.done"] + "」。"
      && S.en["br.ask.captcha.p"] === "After several searches in a row, {engine} asks to confirm a person is there. You do the check yourself; the agent never does it for you. Once it passes, the search picks up on its own; if it doesn't, press \"" + S.en["br.handback.done"] + "\"."
      && S.zh["br.handback.done"] === "好了，交還 agent" && S.en["br.handback.done"] === "Done, hand back to agent", [S.zh["br.ask.captcha.p"], S.en["br.ask.captcha.p"]]); }
  const bin = GATE.bin(SHELL, "②");
  if (!bin) { console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0); }
  const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit", env: { ...process.env, ELECTRON_ENABLE_LOGGING: "" } });
  const sub = r.status == null ? 1 : r.status;
  console.log(red || sub ? `\n${red + sub} 紅` : "\nALL PASS");
  process.exit(red || sub ? 1 : 0);
}
const { app, BrowserWindow } = require("electron");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blave-hb-card-"));
app.setPath("userData", tmp);
const STUB = `window.__ev = null; window.__bounds = [];
window.blave = new Proxy({}, { get: (_, k) => typeof k !== "string" ? undefined
  : k === "onBrowserEvent" ? (fn) => { window.__ev = fn; }
  : k === "browserExpand" ? async () => ({ live: true, status: "ready" })
  : k === "browserBounds" ? (b) => { window.__bounds.push(b); }
  : k.startsWith("on") ? () => {} : ["tradeLabels", "browserBlockVisible", "trackFeature"].includes(k) ? () => {}
  : async () => ({ getLocale: "zh-TW", loadConnection: { kind: "claude" }, detectAgents: { claude: { installed: true, loggedIn: true }, codex: { installed: false } },
      listStrategies: [], listSessions: [], loadSession: [], loadSessionImages: [], browserHistory: [], updateState: { phase: "idle", current: "0.0.0" }, telemetryGet: true })[k] });`;
setTimeout(() => { console.log("FAIL  ② 逾時(60 秒)"); process.exit(1); }, 60000).unref();
const MEASURE = `(() => {
  const card = document.querySelector(".bv .ask"), stat = document.querySelector(".bw-stat");
  const btns = card ? [...card.querySelectorAll(".act button")] : [], r = card ? card.getBoundingClientRect() : { height: -1, top: -1 };
  const oneRow = btns.length === 2 && Math.abs(btns[0].getBoundingClientRect().top - btns[1].getBoundingClientRect().top) < 1 && btns[0].getBoundingClientRect().right <= btns[1].getBoundingClientRect().left;
  return { h: Math.round(r.height), top: Math.round(r.top), btns: btns.map((b) => [b.className, b.textContent]), oneRow,
    statBtns: stat ? stat.querySelectorAll("button").length : -1, statText: stat ? stat.textContent : "", p: card ? card.querySelector("p").textContent : "", bounds: window.__bounds.length }; })()`;
app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  const pre = path.join(tmp, "stub.js"); fs.writeFileSync(pre, STUB);
  const w = new BrowserWindow({ width: 1024, height: 680, useContentSize: true, show: false, webPreferences: { offscreen: true, preload: pre, contextIsolation: false, sandbox: false } });
  await w.loadFile(path.join(SHELL, "renderer", "index.html"));
  await new Promise((r) => setTimeout(r, 1200));
  const js = (code) => w.webContents.executeJavaScript(code, true);
  for (const [kind, summary] of [["login", ""], ["captcha", "Google"], ["file", ""], ["submit", "Send the form"]]) {
    const id = "c-" + kind;
    await js(`(async () => { setLang("zh"); brCollapse(false); window.__ev({ type: "block_open" });
      window.__ev({ type: "page_open", id: ${JSON.stringify(id)}, url: "https://h1.example/x", by: "agent", alias: "t9" }); window.__ev({ type: "page_loaded", id: ${JSON.stringify(id)}, title: "H1" });
      window.__ev({ type: "need_user", id: ${JSON.stringify(id)}, kind: ${JSON.stringify(kind)}, summary: ${JSON.stringify(summary)} });
      await brExpand(${JSON.stringify(id)}); await new Promise((r) => setTimeout(r, 200)); })()`);
    const before = await js(MEASURE);
    await js(`(async () => { window.__ev({ type: "user_takeover", id: ${JSON.stringify(id)} }); await new Promise((r) => setTimeout(r, 200)); })()`);
    const after = await js(MEASURE);
    console.log(`      ${kind}:接手前 ${before.h} 高 [${before.btns.map((b) => b[1]).join(" | ")}] → 接手後 ${after.h} 高 [${after.btns.map((b) => b[1]).join(" | ")}];bounds 送了 ${before.bounds} → ${after.bounds} 次`);
    ok(`② ${kind}:接手後卡上是描邊出口在左、實心「好了，交還 agent」在右,同一列`, after.btns.length === 2 && /btn-out/.test(after.btns[0][0]) && /btn-fill/.test(after.btns[1][0]) && after.btns[1][1] === "好了，交還 agent" && after.oneRow, JSON.stringify(after));
    ok(`② ${kind}:卡高度與頂緣不變(接手前後同一列換一顆同尺寸的鈕)、接手那一刻不再送 bounds(去重)`, after.h === before.h && after.top === before.top && after.bounds === before.bounds, JSON.stringify([before, after]));
    ok(`② ${kind}:標題列只有「你在操作」,沒有鈕`, after.statBtns === 0 && after.statText.includes("你在操作"), JSON.stringify(after));
    if (kind === "captcha") ok("② captcha:卡上說明句的最後一個子句點名卡上那顆鈕(逐字同鈕字)", /沒接上再按「好了，交還 agent」。$/.test(after.p), after.p);
  }
  w.destroy();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* userData 還鎖著 */ }
  console.log(red ? `\n${red} FAILED` : "\nALL PASS");
  app.exit(red ? 1 : 0);
}).catch((e) => { console.log("FAIL  " + (e && e.stack)); app.exit(1); });
