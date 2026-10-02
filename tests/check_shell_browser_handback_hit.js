// 內建瀏覽器的「交還 agent」(0.1.12 B 案:標題列從灰字文字鈕改成實心小鈕;聊天那一列也帶一顆;接手時請求卡不拆、頁面框不跳)。
// 視覺 24 高(狀態句那一格 18 高、只裁左右,鈕上下各溢出 3);熱區是 .btn-fill 的外擴 7(錨在 padding box:22+14=36)。
// 熱區用 elementFromPoint 實測(canon › 熱區一律實測,不用 inset 推算):36 高、整塊在標題列內、不蓋到 ✕ 與網址列,標題列高度不變。
// 跑法:node tests/check_shell_browser_handback_hit.js(沒設 BLAVE_TEST_WINDOW=1 時 Electron 那段 SKIP)
const path = require("path"), fs = require("fs"), os = require("os");
const SHELL = path.join(__dirname, "..", "shell");
const GATE = require("./_electron_gate");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + String(d).slice(0, 2000))); if (!c) red++; };
if (!process.versions.electron) {
  const css = fs.readFileSync(path.join(SHELL, "renderer", "browser.css"), "utf8");
  const js = fs.readFileSync(path.join(SHELL, "renderer", "browser.js"), "utf8");
  ok("① 標題列的交還是實心鈕(.btn-fill,字是「好了，交還 agent」),不再是灰字文字鈕", /brEl\("button", "btn-fill"\); hb\.type = "button"; hb\.append\(brEl\("span", "", t\("br\.handback\.done"\)\)\);/.test(js) && !/\.bw-stat \.btn-quiet/.test(css));
  ok("① browser.css:小尺寸 24 高、左右 8、字 12;狀態句那一格只裁左右(鈕與熱區上下不被裁)", /\.bw-stat \.btn-fill \{ height: 24px; padding: 0 var\(--space-8\); margin-left: var\(--space-4\); font-size: 12px; \}/.test(css) && /\.bw-stat \.btn-fill > span \{ display: block; overflow: hidden; text-overflow: ellipsis; \}/.test(css) && /\.bw-stat \{[^}]*height: 18px;[^}]*overflow-x: clip;/.test(css));
  ok("① 中欄 ≤440 只留交還鈕(狀態句與手形收掉),鈕到這時才可以縮;鈕本身不設 overflow(不然外擴的熱區會被裁)", /@container main \(max-width: 440px\) \{\s*\.bw-stat:has\(> \.btn-fill\) > :not\(\.btn-fill\) \{ display: none; \}\s*\.bw-stat \.btn-fill \{ margin-left: 0; flex: 0 1 auto; min-width: 0; \}/.test(css) && !/\.bw-stat \.btn-fill \{[^}]*overflow/.test(css));
  ok("① 按下去念「已交還 agent」(鈕跟著消失,讀屏要有回饋)", /window\.blave\.browserHandback\(x\.id\); srSay\(t\("br\.handedBack"\)\);/.test(js));
  // ---- 聊天那一列的「交還 agent」與請求卡不拆(設計稽核 0.1.12,Wei 拍板)
  const cut = (src, head) => { const i = src.indexOf(head); if (i < 0) throw new Error("找不到 " + head); let d = 0; for (let k = src.indexOf("{", src.indexOf(")", i)); k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}" && --d === 0) return src.slice(i, k + 1); } throw new Error("切不出 " + head); };
  { const brUserOp = (x) => !!x && !!x.user && x.by !== "user", t = (k) => k;
    const foot = new Function("t", "brUserOp", "brReg", "brHost", cut(js, "function brFoot(") + "; return brFoot;")(t, brUserOp, (h) => h, () => "");
    ok("① 訊息槽:接手中寫「你在操作」,優先於 need(搜尋驗證接手後不再寫「搜尋要過機器人驗證」);用戶自己開的頁照舊講 need",
      foot({ user: true, by: "agent", need: { kind: "captcha" } }) === "br.userOp" && foot({ user: true, by: "agent", need: { kind: "login" } }) === "br.userOp"
      && foot({ need: { kind: "captcha" } }) === "br.need.captcha" && foot({ user: true, by: "user", need: { kind: "login" } }) === "br.need.login"); }
  const sync = cut(js, "function brSyncHold("), ask = cut(js, "function brAsk(");
  ok("① 接手中的那一列標 data-hold,牆上補一顆 .btn-out「交還 agent」(br.handback.chat):按了交還、念「已交還 agent」、不往上冒(不展開中欄);不再接手就拿掉",
    /on = brUserOp\(x\)/.test(sync) && /el\.dataset\.hold = ""/.test(sync) && /delete el\.dataset\.hold/.test(sync) && /brEl\("button", "btn-out pt-hb"\)/.test(sync)
    && /e\.stopPropagation\(\); trackFeature\("browser_hb_chat"\); window\.blave\.browserHandback\(id\); srSay\(t\("br\.handedBack"\)\);/.test(sync) && /hb\.textContent = t\("br\.handback\.chat"\)/.test(sync) && /if \(!want\.has\(hb\.dataset\.id\)\) hb\.remove\(\);/.test(sync)
    && /function brPaintHead\(b\) \{\s*brThumbClass\(b, b\.el\);\s*brSyncHold\(b\);\s*if \(b\.sum\)/.test(js));
  ok("① 鈕不巢狀在列(button)裡:列裡是同尺寸的隱形佔位,鈕用 anchor 疊上去;佔位是 hidden,鈕要 position-visibility: always(不然一起被藏)",
    /sp = brEl\("span", "pt-hbs"\); sp\.setAttribute\("aria-hidden", "true"\); sp\.style\.setProperty\("anchor-name", "--brh"/.test(js) && /hb\.style\.setProperty\("position-anchor", "--brh" \+ el\.__hk\)/.test(sync)
    && /\.pt-hb \{ position: absolute; left: anchor\(left\); top: anchor\(top\); position-visibility: always; z-index: 1; height: 24px; padding: 0 var\(--space-8\); font-size: 12px; \}/.test(css)
    && /\.bblk \.pt\[data-hold\] \.pt-hbs \{ display: block; visibility: hidden; height: 24px; padding: 0 var\(--space-8\); border: 1px solid transparent; font-size: 12px;/.test(css));
  ok("① 接手中的那一列一直攤開:進行中跟 wait 一樣露出;回合結束摘要收著時也攤在摘要行下面(只露它和它的鈕)",
    /\.bblk:not\(\.sum\) \.wall > \.pt:not\(\[data-ph="wait"\]\):not\(\[data-hold\]\)/.test(css) && /\.bblk:not\(\.sum\):not\(:has\(\.pt\[data-ph="wait"\], \.pt\[data-hold\]\)\) \.wall \{ display: none; \}/.test(css)
    && /\.bblk\.sum:not\(\[open\]\):has\(\.pt\[data-hold\]\)::details-content \{ content-visibility: visible; \}/.test(css) && /\.bblk\.sum:not\(\[open\]\) \.wall > :not\(\.pt\[data-hold\], \.pt-hb\) \{ display: none; \}/.test(css));
  ok("① 狀態位讓給鈕、手形進訊息槽;重排格子不理會交還鈕(不然每次重畫都把格子搬一次、重播進場)",
    /const n = hold \? null : brStatusNode\(x\)/.test(js) && /if \(hold\) foot\.append\(brIcon\("hand"\)\)/.test(js) && /filter\(\(el\) => !el\.classList\.contains\("pt-hb"\)\)/.test(cut(js, "function brOrder(")));
  ok("① 請求卡接手後不拆(頁面框不跳):slot 只看 x.need;卡上拿掉「我來…」、出口鈕照留;確認網址的「仍要開啟」不是接手,照留",
    /else if \(x\.need\) slot\.append\(brAsk\(x\)\);/.test(js) && !/x\.need && !x\.user\) slot/.test(js) && /act\.append\(skip\); if \(!x\.user \|\| k === "confirm"\) act\.append\(me\);/.test(ask));
  { const S = new Function(fs.readFileSync(path.join(SHELL, "renderer", "strings.js"), "utf8") + "; return STRINGS;")(), head = cut(js, "function brStatLine(");
    ok("① 兩顆交還鈕都有 aria-label「交還 agent：{網域}」/「Hand back: {domain}」(聊天鈕的字只有「交還 agent」/「Hand back」,讀屏分不出是哪一頁)",
      S.zh["br.handback.aria"] === "交還 agent：{domain}" && S.en["br.handback.aria"] === "Hand back: {domain}" && S.zh["br.handback.chat"] === "交還 agent" && S.en["br.handback.chat"] === "Hand back"
      && /hb\.setAttribute\("aria-label", t\("br\.handback\.aria", \{ domain: brReg\(brHost\(x\.url\)\) \|\| x\.url \}\)\);/.test(head)
      && /hb\.setAttribute\("aria-label", t\("br\.handback\.aria", \{ domain: \(x && brReg\(brHost\(x\.url\)\)\) \|\| \(x && x\.url\) \|\| "" \}\)\);/.test(sync));
    ok("① 埋點:標題列那顆每按都記 browser_hb_head、聊天那顆記 browser_hb_chat(不看有沒有 need);browser_handoff 照舊只在有 need 時記",
      /if \(x\.need\) trackFeature\("browser_handoff"\); trackFeature\("browser_hb_head"\); window\.blave\.browserHandback\(x\.id\);/.test(head)
      && /e\.stopPropagation\(\); trackFeature\("browser_hb_chat"\); window\.blave\.browserHandback\(id\);/.test(sync)); }
  const bin = GATE.bin(SHELL, "②");
  if (!bin) { console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0); }
  const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit", env: { ...process.env, ELECTRON_ENABLE_LOGGING: "" } });
  const sub = r.status == null ? 1 : r.status;
  console.log(red || sub ? `\n${red + sub} 紅` : "\nALL PASS");
  process.exit(red || sub ? 1 : 0);
}
const { app, BrowserWindow } = require("electron");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blave-hb-hit-"));
app.setPath("userData", tmp);
const STUB = `window.__ev = null;
window.blave = new Proxy({}, { get: (_, k) => typeof k !== "string" ? undefined
  : k === "onBrowserEvent" ? (fn) => { window.__ev = fn; }
  : k === "browserExpand" ? async () => ({ live: true, status: "ready" })
  : k.startsWith("on") ? () => {} : ["tradeLabels", "browserBounds", "browserBlockVisible", "trackFeature"].includes(k) ? () => {}
  : async () => ({ getLocale: "zh-TW", loadConnection: { kind: "claude" }, detectAgents: { claude: { installed: true, loggedIn: true }, codex: { installed: false } },
      listStrategies: [], listSessions: [], loadSession: [], loadSessionImages: [], browserHistory: [], updateState: { phase: "idle", current: "0.0.0" }, telemetryGet: true })[k] });`;
setTimeout(() => { console.log("FAIL  ② 逾時(60 秒)"); process.exit(1); }, 60000).unref();
const MEASURE = `(() => {
  const head = document.querySelector(".bw-head"), btn = document.querySelector(".bw-stat .btn-fill"), close = document.querySelector(".bw-head .bw-close"), label = document.querySelector(".bw-stat .t"), bar = document.querySelector(".bv-bar, .bv-url, .bv-tabs");
  const br = btn.getBoundingClientRect(), hr = head.getBoundingClientRect(), cx = br.left + br.width / 2, cy = br.top + br.height / 2;
  const hit = (x, y) => { const e = document.elementFromPoint(x, y); return !!e && (e === btn || btn.contains(e)); };
  // 沿中線往上下、左右逐 0.5px 探,連續打到這顆鈕的範圍就是熱區
  const run = (dx, dy) => { let n = 0; while (n < 200 && hit(cx + dx * (n + 0.5), cy + dy * (n + 0.5))) n += 0.5; return n; };
  const up = run(0, -1), down = run(0, 1), left = run(-1, 0), right = run(1, 0);
  const own = (el) => { if (!el) return null; const r = el.getBoundingClientRect(), e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!e && (e === el || el.contains(e)); };
  const lr = label.getBoundingClientRect();
  return { text: btn.textContent, visual: Math.round(br.width) + "x" + Math.round(br.height), hitH: up + down, hitW: left + right, top: cy - up, bottom: cy + down, headTop: hr.top, headBottom: hr.bottom, headH: Math.round(hr.height),
    statH: Math.round(document.querySelector(".bw-stat").getBoundingClientRect().height), closeOwn: own(close), labelOwn: own(label), labelGap: Math.round((cx - left - lr.right) * 10) / 10, barOwn: own(bar), barTop: bar ? bar.getBoundingClientRect().top : null,
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth }; })()`;
app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  const pre = path.join(tmp, "stub.js"); fs.writeFileSync(pre, STUB);
  const w = new BrowserWindow({ width: 1024, height: 680, useContentSize: true, show: false, webPreferences: { offscreen: true, preload: pre, contextIsolation: false, sandbox: false } });
  await w.loadFile(path.join(SHELL, "renderer", "index.html"));
  await new Promise((r) => setTimeout(r, 1200));
  const js = (code) => w.webContents.executeJavaScript(code, true);
  for (const lang of ["zh", "en"]) {
    await js(`(async () => { setLang(${JSON.stringify(lang)}); brCollapse(false); window.__ev({ type: "block_open" });
      window.__ev({ type: "page_open", id: "h-${lang}", url: "https://h1.example/", by: "agent", alias: "t9" }); window.__ev({ type: "page_loaded", id: "h-${lang}", title: "H1" });
      await brExpand("h-${lang}"); window.__ev({ type: "user_takeover", id: "h-${lang}" }); await new Promise((r) => setTimeout(r, 100)); })()`);
    const m = await js(MEASURE);
    console.log(`      ${lang}:「${m.text}」視覺 ${m.visual},熱區 ${m.hitW}×${m.hitH}(y ${m.top}–${m.bottom});標題列 y ${m.headTop}–${m.headBottom}、高 ${m.headH};熱區左緣到狀態句文字 ${m.labelGap}`);
    ok(`② ${lang}:熱區高 36(elementFromPoint 實測;.btn-fill 外擴 7 錨在 padding box),鈕 24 高;狀態句那一格仍是 18 高、標題列 49 高(接手前後標題列不跳)`, m.hitH === 36 && m.statH === 18 && m.headH === 49 && /x24$/.test(m.visual), JSON.stringify(m));
    ok(`② ${lang}:熱區整塊在標題列內、不伸進下面的分頁列 / 網址列`, m.top >= m.headTop && m.bottom <= m.headBottom && (m.barTop == null || m.bottom <= m.barTop) && m.barOwn !== false, JSON.stringify(m));
    ok(`② ${lang}:不蓋到相鄰的東西——✕ 的中心打到 ✕、狀態句文字的中心打到文字、熱區左緣在文字右緣之外;沒有橫向溢出`, m.closeOwn === true && m.labelOwn === true && m.labelGap >= 0 && !m.overflowX, JSON.stringify(m));
  }
  w.destroy();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* userData 還鎖著 */ }
  console.log(red ? `\n${red} FAILED` : "\nALL PASS");
  app.exit(red ? 1 : 0);
}).catch((e) => { console.log("FAIL  " + (e && e.stack)); app.exit(1); });
