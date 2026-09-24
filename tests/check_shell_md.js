// agent 回覆的 markdown(app.js paintAi → mdPaint)在真的 index.html 裡畫出來的樣子。用隨包的 Electron 開頁面,
// window.blave 換成假的(不起主行程、不連網),直接呼叫 addMsg("ai", …):
//   ① 09-23 送上雲端那則回覆(session.db turn 154 原文)的表格畫成 <table>:表頭 3 欄、6 列資料、沒有殘留的 |
//   ② 惡意字串(<img onerror>、<script>、javascript: 連結、儲存格裡的 HTML)不變成元素、只當字
//   ③ 10 欄的長表格:表格在 .md-tblwrap 裡自己橫捲,聊天欄與整頁都不出現橫向捲動
//   ④ 標題 / 巢狀清單 / 圍欄 / 行內程式碼 / 粗體 / 連結各自成元素
//   ⑤ 畫 markdown 的那一段程式裡沒有 innerHTML / outerHTML / insertAdjacentHTML
//   ⑥ 對話裡的連結(session.db turn 192 那則新聞 Sources 的形狀:markdown 連結 + 裸網址)點了走 window.blave.openExternal、
//      不在視窗內導覽、不開新視窗;javascript: 那條沒有 <a>、點它什麼都不開(0.1.1 用戶回報點連結沒反應)
// 跑法:node tests/check_shell_md.js(找不到 shell/node_modules 的 Electron 就 SKIP)
const path = require("path"), fs = require("fs");
const SHELL = path.join(__dirname, "..", "shell");

if (!process.versions.electron) {
  const bin = path.join(SHELL, "node_modules", ".bin", "electron");
  if (!fs.existsSync(bin)) { console.log("SKIP  找不到 shell/node_modules 的 Electron(先 cd shell && npm install)"); process.exit(0); }
  const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit" });
  process.exit(r.status == null ? 1 : r.status);
}

const { app, BrowserWindow } = require("electron");
const os = require("os");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "blave-md-")));
const STUB = `window.blave = new Proxy({}, { get: (_, k) => typeof k !== "string" ? undefined
  : k.startsWith("on") ? () => {} : k === "tradeLabels" ? () => {}
  : k === "openExternal" ? (u) => { (window.__opened = window.__opened || []).push(u); return Promise.resolve(true); }
  : async () => ({ getLocale: "zh-TW", loadConnection: { kind: "claude" }, detectAgents: { claude: { installed: true, loggedIn: true }, codex: { installed: false } },
      listStrategies: [], listSessions: [], loadSession: [], loadSessionImages: [], updateState: { phase: "idle", current: "0.0.0" } })[k] });`;
let red = 0; const ok = (n, c) => { console.log((c ? "PASS  " : "FAIL  ") + n); if (!c) red++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log("FAIL  逾時(60 秒)"); process.exit(1); }, 60000).unref();

const HANDOFF = `\`tmp/cloud-handoff\` 已確認清除完畢，搬遷流程結束。

**e2e_0923_ma 兩邊回測比較（Match，交易筆數／期間一致）：**

| | 這台電腦 | 雲端主機 |
|---|---|---|
| 總報酬 | −17.54% | −17.55% |
| Sharpe | −0.52 | −0.52 |
| 最大回撤 | −42.88% | −42.88% |
| 交易筆數 | 331 | 331 |
| 期間 | 2025-09-23 → 2026-09-23 | 2025-09-23 → 2026-09-23 |
| 資料來源 | Binance public klines | Blave data |

兩邊資料來源不同，小幅差異是正常的。

搬了：策略程式碼（strategy.py，無需資料源金鑰）。沒搬：交易所金鑰、下單金額、任何下單狀態。兩邊版本皆為 2026-09-23-b，無版本差異。要上實盤請到雲端主機的自動下單頁自行操作。`;
const EVIL = `<img src=x onerror="window.__pwned=1"> <script>window.__pwned=2</script> [點我](javascript:window.__pwned=3)

| a | <img src=x onerror="window.__pwned=4"> |
|---|---|
| <b>粗</b> | <a href="javascript:window.__pwned=5">x</a> |`;
const WIDE = "| " + Array.from({ length: 10 }, (_, k) => "欄位" + k).join(" | ") + " |\n|" + "---|".repeat(10) + "\n| " +
  Array.from({ length: 10 }, (_, k) => "BTCUSDT_PERP_" + k + "_1234567.89").join(" | ") + " |";
const MIX = "## 小標\n\n- 一\n  - 一之一\n    - 一之一之一\n- 二\n\n```python\nx = 2**3**2\n```\n\n用 `lib/data.py` 取 **K 線**,見 [官網](https://blave.org)。";
const LINKS = "以上為搜尋結果整理，細節與後續變化請以原文為準。\n\nSources:\n- [東協財經／2026年9月23日東協快訊](https://www.cna.com.tw/news/afe/202609233001.aspx)\n- 裸網址 https://money.udn.com/money/story/5607/9025347 也要能點\n- [點我](javascript:window.__pwned=6)";

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  const pre = path.join(app.getPath("userData"), "stub.js"); fs.writeFileSync(pre, STUB);
  const w = new BrowserWindow({ width: 1280, height: 820, show: false, webPreferences: { offscreen: true, preload: pre, contextIsolation: false, sandbox: false } });
  await w.loadFile(path.join(SHELL, "renderer", "index.html"));
  await wait(1200);
  const js = (s) => w.webContents.executeJavaScript(s, true);
  const say = (md) => js(`(() => { const el = addMsg("ai", ${JSON.stringify(md)}); el.id = "m" + document.querySelectorAll(".msg.ai").length; return el.id; })()`);

  let id = await say(HANDOFF);
  const h = await js(`(() => { const m = $("${id}"), tb = m.querySelector(".md-tblwrap > table");
    return { tb: !!tb, heads: tb ? [...tb.querySelectorAll("thead th")].map((x) => x.textContent) : [],
      rows: tb ? tb.querySelectorAll("tbody tr").length : 0, cell: tb ? tb.querySelector("tbody tr td:nth-child(2)").textContent : "",
      pipes: [...m.childNodes].some((n) => n.nodeName !== "PRE" && /\\|\\s*---/.test(n.textContent)),
      strong: m.querySelector("p strong") && m.querySelector("p strong").textContent, code: m.querySelector("p code") && m.querySelector("p code").textContent }; })()`);
  ok("① 送上雲端那則回覆的表格畫成 <table>(包在 .md-tblwrap 裡)", h.tb);
  ok("① 表頭三欄:空白 / 這台電腦 / 雲端主機", JSON.stringify(h.heads) === JSON.stringify(["", "這台電腦", "雲端主機"]));
  ok("① 六列資料,第一列第二格是 −17.54%", h.rows === 6 && h.cell === "−17.54%");
  ok("① 畫面上沒有殘留的 |---| 原文", !h.pipes);
  ok("① 表格上面那句的粗體與行內程式碼照樣成元素", h.strong === "e2e_0923_ma 兩邊回測比較（Match，交易筆數／期間一致）：" && h.code === "tmp/cloud-handoff");

  id = await say(EVIL); await wait(300);
  const e = await js(`(() => { const m = $("${id}");
    return { els: [...m.querySelectorAll("img,script,b,a,iframe")].map((x) => x.tagName + ":" + (x.getAttribute("href") || "")),
      txt: m.textContent, pwned: window.__pwned || 0, tb: !!m.querySelector("table") }; })()`);
  ok("② <img onerror>、<script>、<b>、<a href> 都沒有變成元素(javascript: 連結也沒有 href)", e.els.length === 0);
  ok("② 那些字原樣顯示成文字", e.txt.includes('<img src=x onerror="window.__pwned=1">') && e.txt.includes("<script>") && e.txt.includes("<b>粗</b>"));
  ok("② 沒有任何一段被執行", e.pwned === 0);
  ok("② 表格照畫、惡意字只在儲存格裡當字", e.tb);

  id = await say(WIDE); await wait(200);
  const o = await js(`(() => { const m = $("${id}"), wr = m.querySelector(".md-tblwrap"), cs = $("chat-scroll");
    return { wrap: !!wr, wSW: wr ? wr.scrollWidth : 0, wCW: wr ? wr.clientWidth : 0, csSW: cs.scrollWidth, csCW: cs.clientWidth,
      bodySW: document.documentElement.scrollWidth, iw: window.innerWidth, over: getComputedStyle(wr).overflowX }; })()`);
  ok(`③ 10 欄長表格在 .md-tblwrap 裡橫捲(內容 ${o.wSW}px > 可見 ${o.wCW}px,overflow-x=${o.over})`, o.wrap && o.wSW > o.wCW && o.over === "auto");
  ok(`③ 聊天欄沒有被撐寬(scrollWidth ${o.csSW} = clientWidth ${o.csCW})`, o.csSW <= o.csCW);
  ok(`③ 整頁沒有橫向捲動(${o.bodySW} ≤ ${o.iw})`, o.bodySW <= o.iw);

  id = await say(MIX);
  const x = await js(`(() => { const m = $("${id}");
    return { h2: m.querySelector("h2") && m.querySelector("h2").textContent, nest: !!m.querySelector("ul > li > ul > li > ul > li"),
      top: m.querySelectorAll(":scope > ul > li").length, pre: m.querySelector("pre > code") && m.querySelector("pre > code").textContent,
      code: m.querySelector("p code") && m.querySelector("p code").textContent, strong: m.querySelector("p strong") && m.querySelector("p strong").textContent,
      a: m.querySelector("p a") && [m.querySelector("p a").getAttribute("href"), m.querySelector("p a").textContent, m.querySelector("p a").target],
      raw: /(^|\\n)\\s*(##|- |\`\`\`)/.test(m.innerText) }; })()`);
  ok("④ ## 標題成 <h2>", x.h2 === "小標");
  ok("④ 三層巢狀清單成三層 <ul>,頂層兩項", x.nest && x.top === 2);
  ok("④ 圍欄成 <pre><code>、裡面的 ** 一個字都不動", x.pre === "x = 2**3**2");
  ok("④ 行內程式碼 / 粗體 / 連結(新分頁開)各自成元素", x.code === "lib/data.py" && x.strong === "K 線" && JSON.stringify(x.a) === JSON.stringify(["https://blave.org", "官網", "_blank"]));
  ok("④ 畫面上沒有殘留的 ##、- 、``` 記號", !x.raw);

  id = await say(LINKS); await wait(200);
  const l = await js(`(() => { const m = $("${id}"), as = [...m.querySelectorAll("a")]; window.__opened = [];
    const click = (n) => n.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    as.forEach(click);
    click([...m.querySelectorAll("li")].find((x) => x.textContent.includes("點我")));
    return { hrefs: as.map((a) => a.getAttribute("href")), opened: window.__opened, pwned: window.__pwned || 0, url: location.href }; })()`);
  await wait(300);   // 沒被 preventDefault 的 target=_blank 會非同步開一個新視窗
  ok("⑥ markdown 連結與裸網址各成 <a href>(新聞網站,不是 blave.org)", JSON.stringify(l.hrefs) === JSON.stringify(["https://www.cna.com.tw/news/afe/202609233001.aspx", "https://money.udn.com/money/story/5607/9025347"]));
  ok("⑥ 點了走 window.blave.openExternal(交給系統瀏覽器),兩條都到、順序一樣", JSON.stringify(l.opened) === JSON.stringify(l.hrefs));
  ok("⑥ 點了不在 app 視窗內導覽、沒開新視窗", BrowserWindow.getAllWindows().length === 1 && l.url === w.webContents.getURL());
  ok("⑥ javascript: 那條沒有 <a>、點它的字什麼都不開", l.hrefs.length === 2 && l.opened.length === 2 && l.pwned === 0);
  const m2 = await js(`(() => { const as = [...$("${id}").querySelectorAll("a")]; window.__opened = [];
    const ev = (n, type, init) => n.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
    ev(as[0], "auxclick", { button: 1 }); ev(as[1], "click", { metaKey: true }); ev(as[1], "click", { ctrlKey: true }); ev(as[0], "auxclick", { button: 2 });
    return window.__opened; })()`);
  await wait(300);
  ok("⑥ 中鍵(auxclick button 1)與 Cmd/Ctrl+click 也走 openExternal;右鍵不開", JSON.stringify(m2) === JSON.stringify([l.hrefs[0], l.hrefs[1], l.hrefs[1]]));
  ok("⑥ 中鍵沒開新視窗", BrowserWindow.getAllWindows().length === 1);

  const src = fs.readFileSync(path.join(SHELL, "renderer", "app.js"), "utf8");
  const a0 = src.indexOf("/* ── agent 回覆的顯示"), a1 = src.indexOf("function addMsg(", a0);
  ok("⑤ 畫 markdown 的那一段沒有 innerHTML / outerHTML / insertAdjacentHTML", a0 > 0 && a1 > a0 && !/innerHTML|outerHTML|insertAdjacentHTML/.test(src.slice(a0, a1)));

  console.log(red ? `\n${red} 紅` : "\nALL PASS");
  app.exit(red ? 1 : 0);
});
