// 聊天長網址縮短(spec designer/chat-long-url-2026-10-30,B 中段截)。
//   純 node:md.js 的 urlLabel 跑 spec 那 18 條測資(網頁 tests/url_label_vectors.json 的 url_label 要逐項相同,check_web_desktop_parity.js 比)、
//          urlTitle 解碼且不帶帳密、右鍵「複製連結」接好(只在 http(s) 連結上、寫進剪貼簿的是 linkURL、兩語都有字)、報告那一層不縮。
//   Electron(BLAVE_TEST_WINDOW=1,離屏視窗不顯示):真的 index.html 呼叫 addMsg("ai", …):
//     ① 裸網址縮短、title 是解碼後完整網址、href 不動 ② 防釣魚:描述字像網址但網域不同 → 改顯示真網域;AGENTS.md、v0.1.37 不改
//     ③ 選取複製(含只選到連結一半)貼出完整網址、用戶的反白不動;沒碰到縮過的連結不攔 ④ 串流到一半的半截 %e 不當掉
// 跑法:node tests/check_shell_url_label.js   完整:BLAVE_TEST_WINDOW=1 node tests/check_shell_url_label.js
const path = require("path"), fs = require("fs");
const SHELL = path.join(__dirname, "..", "shell");
const GATE = require("./_electron_gate");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  " + JSON.stringify(d))); if (!c) red++; };

// 輸入、期望(spec §1 測資表;順序與內容跟網頁那份一樣)
const CASES = [
  ["https://www.xq.com.tw/xstrader/%e7%94%a8ai%e5%8d%94%e5%8a%a9%e6%92%b0%e5%af%abxs%e7%ad%96%e7%95%a5-%e5%9d%87%e7%b7%9a%e7%aa%81%e7%a0%b4/", "xq.com.tw/…/用ai協助撰寫xs策略-均線突破"],
  ["https://www.tradingview.com/chart/?symbol=BINANCE%3ABTCUSDT.P&interval=60", "tradingview.com/chart?…"],
  ["https://github.com/Blave-TW/blave-agent/blob/main/shell/renderer/md.js#L120", "github.com/Blave-TW/…/renderer/md.js"],
  ["https://blave.org/", "blave.org"],
  ["https://blave.org", "blave.org"],
  ["https://www.binance.com/zh-TC/support/announcement/detail/1a2b3c4d5e6f7a8b9c0d", "binance.com/zh-TC/…/1a2b3c4d5e6f7a8b9c0d"],
  ["http://example.com/a", "http://example.com/a"],
  ["https://xn--fiq228c.tw/%E6%96%B0%E8%81%9E", "xn--fiq228c.tw/新聞"],
  ["https://example.com/%B7s%BBD", "example.com/%B7s%BBD"],
  ["https://example.com/report%E2%80%AEfdp.exe", "example.com/report%E2%80%AEfdp.exe"],
  ["https://binance.com@evil.example/login", "evil.example/login"],
  ["https://a-very-long-subdomain-name-for-testing.example-cloud-hosting.com/x", "a-very-long-subdomain-name-for-testing.example-cloud-hosting.com/…"],
  ["https://example.com:8443/api", "example.com:8443/api"],
  ["https://example.com/a%2Fb", "example.com/a%2Fb"],
  ["https://docs.blave.org/zh/agent#install", "docs.blave.org/zh/agent"],
  ["https://abcdefghijklmnopqrstuvwxyz012345.com/abcde", "abcdefghijklmnopqrstuvwxyz012345.com/…"],
  ["https://abcdefghijklmnopqrstuvwxyz0123456789abcdefgh.com/", "abcdefghijklmnopqrstuvwxyz0123456789abcdefgh.com"],
  ["https://xq.com.tw/用ai協助撰寫xs策略-均線突破/", "xq.com.tw/用ai協助撰寫xs策略-均線突破"],
];

if (!process.versions.electron) {
  const md = fs.readFileSync(path.join(SHELL, "renderer", "md.js"), "utf8");
  const a0 = md.indexOf("const URL_LABEL_MAX = "), a1 = md.indexOf("/* ── 報告的 text block", a0);
  let f = null;
  try { f = new Function(md.slice(a0, a1) + "\nreturn { urlLabel, urlTitle, URL_LABEL_MAX };")(); } catch (e) { ok("從 md.js 切出 urlLabel / urlTitle", false, e.message); }
  if (f) {
    ok("測資 18 條", CASES.length === 18);
    for (const [u, want] of CASES) { const got = f.urlLabel(u); ok("urlLabel " + u.slice(0, 70), got === want, { got, want }); }
    ok("上限 40 寬度單位", f.URL_LABEL_MAX === 40);
    ok("非 http(s) 不動", f.urlLabel("javascript:alert(1)") === null && f.urlLabel("mailto:a@b.c") === null && f.urlLabel("not a url") === null);
    ok("title:解碼後完整網址(xq 不再是一串 %e7)", f.urlTitle(CASES[0][0]) === "https://www.xq.com.tw/xstrader/用ai協助撰寫xs策略-均線突破/");
    ok("title:帳密不顯示、網域是真的那個,query 與 fragment 原樣", f.urlTitle("https://binance.com@evil.example/login?a=1#x") === "https://evil.example/login?a=1#x");
    ok("title:bidi 那段維持編碼", f.urlTitle(CASES[9][0]) === CASES[9][0]);
    ok("每條輸出都 ≤ 40 寬度,除非網域本身就超過", CASES.every(([u]) => { const s = f.urlLabel(u); let w = 0; for (const c of s) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(c) ? 2 : 1; return w <= 40 || !/\//.test(s.replace(/\/…$/, "")); }));
  }
  ok("報告那一層不縮:md.js 只定義、不呼叫 urlLabel / urlTitle(mdPaintInl 的 title 照舊)", !/[^\w]urlLabel\(/.test(md.slice(a1)) && !/urlTitle\(/.test(md.slice(0, a0) + md.slice(a1)));
  const app = fs.readFileSync(path.join(SHELL, "renderer", "app.js"), "utf8");
  ok("縮短只在 paintAi(聊天)跑", /mdPaint\(el, r\.blocks\);\n  chatUrls\(el\);/.test(app) && (app.match(/chatUrls\(/g) || []).length === 2);
  ok("URL_LIKE 只定義在 md.js(parity 只讀 md.js)", /^const URL_LIKE = /m.test(md) && !/^const URL_LIKE = /m.test(app));
  ok("聊天容器掛 copy 事件", app.includes('$("chat-scroll").addEventListener("copy", chatCopy);'));
  const main = fs.readFileSync(path.join(SHELL, "main.js"), "utf8"), cm = main.indexOf('win.webContents.on("context-menu"'), cmBody = cm < 0 ? "" : main.slice(cm, main.indexOf("});", cm));
  ok("右鍵選單:只在 http(s) 連結上跳、只有一格、寫進剪貼簿的是 linkURL", cm > 0 && /\^https\?:/.test(cmBody) && /clipboard\.writeText\(p\.linkURL\)/.test(cmBody) && (cmBody.match(/label:/g) || []).length === 1 && /nativeTheme, clipboard \} = require\("electron"\)/.test(main));
  const po = (lang) => (fs.readFileSync(path.join(SHELL, "i18n", lang + ".po"), "utf8").match(/^msgid "menu\.copyLink"\nmsgstr "(.*)"$/m) || [])[1];
  ok("「複製連結」兩語都有(zh 複製連結、en Copy Link)", po("zh") === "複製連結" && po("en") === "Copy Link");
  ok("選單字走 trade-labels(TR_MENU_KEYS 與 MENU_EN 都有)", fs.readFileSync(path.join(SHELL, "renderer", "trade.js"), "utf8").includes('"menu.copyLink"') && /menuCopyLink: "Copy Link"/.test(main));

  const bin = GATE.bin(SHELL);
  if (bin) {
    const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit" });
    if (r.status !== 0) red++;
  }
  console.log(red ? red + " 紅" : "ALL PASS");
  process.exit(red ? 1 : 0);
}

const { app, BrowserWindow } = require("electron");
const os = require("os");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "blave-url-")));
const STUB = `window.blave = new Proxy({}, { get: (_, k) => typeof k !== "string" ? undefined
  : k.startsWith("on") ? () => {} : k === "tradeLabels" ? () => {}
  : k === "openExternal" ? () => Promise.resolve(true)
  : async () => ({ getLocale: "zh-TW", loadConnection: { kind: "claude" }, detectAgents: { claude: { installed: true, loggedIn: true }, codex: { installed: false } },
      listStrategies: [], listSessions: [], loadSession: [], loadSessionImages: [], updateState: { phase: "idle", current: "0.0.0" } })[k] });`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log("FAIL  逾時(60 秒)"); process.exit(1); }, 60000).unref();

const XQ = CASES[0][0];
const MD = [
  "來源 " + XQ + " 看這篇",
  "角括號 <https://www.tradingview.com/chart/?symbol=BINANCE%3ABTCUSDT.P&interval=60>",
  "同字 [https://blave.org/](https://blave.org/)",
  "釣魚 [https://binance.com/login](https://evil.example/login)",
  "檔名 [AGENTS.md](https://github.com/x/y/AGENTS.md) 版號 [v0.1.37](https://github.com/x/y/releases/tag/v0.1.37)",
  "同網域 [www.blave.org](https://blave.org/) 描述 [官網](https://blave.org/zh)",
  "無斜線網域 [blave.org](https://evil.example/)",
].join("\n\n");

app.whenReady().then(async () => {
  const pre = path.join(app.getPath("userData"), "stub.js"); fs.writeFileSync(pre, STUB);
  const w = new BrowserWindow({ width: 1280, height: 820, show: false, webPreferences: { offscreen: true, preload: pre, contextIsolation: false, sandbox: false } });
  await w.loadFile(path.join(SHELL, "renderer", "index.html"));
  await wait(1200);
  const js = (s) => w.webContents.executeJavaScript(s, true);
  const d = await js(`(() => { const el = addMsg("ai", ${JSON.stringify(MD)}); el.id = "u1";
    return [...el.querySelectorAll("a")].map((a) => ({ t: a.textContent, h: a.getAttribute("href"), ti: a.title, s: a.hasAttribute("data-url-short"), aria: a.getAttribute("aria-label") })); })()`);
  const by = (h) => d.filter((x) => x.h === h);
  ok("① 裸網址縮短、href 不動、title 解碼", by(XQ).length === 1 && by(XQ)[0].t === CASES[0][1] && by(XQ)[0].ti === "https://www.xq.com.tw/xstrader/用ai協助撰寫xs策略-均線突破/" && by(XQ)[0].s, by(XQ));
  ok("① <url> 也算裸網址", d[1] && d[1].t === "tradingview.com/chart?…" && d[1].s, d[1]);
  ok("① [網址](同網址) 也縮", d[2] && d[2].t === "blave.org" && d[2].s, d[2]);
  ok("① 不加 aria-label(可及名稱就是看得到的縮短字)", d.every((x) => x.aria === null));
  ok("② 描述像網址、網域不同 → 顯示真網域", d[3] && d[3].t === "evil.example/login" && d[3].h === "https://evil.example/login" && d[3].s, d[3]);
  ok("② AGENTS.md、v0.1.37 的字不改(沒有斜線不算像網址),但 title 一樣有", d[4] && d[5] && d[4].t === "AGENTS.md" && d[5].t === "v0.1.37" && !d[4].s && !d[5].s && d[4].ti === "https://github.com/x/y/AGENTS.md", [d[4], d[5]]);
  ok("② 網域一樣的 [www.blave.org] 與一般描述字照原字", d[6] && d[7] && d[6].t === "www.blave.org" && d[7].t === "官網" && !d[6].s && !d[7].s, [d[6], d[7]]);
  ok("② 已知的漏洞照 spec 放行:沒有斜線的 [blave.org](evil) 不改", d[8] && d[8].t === "blave.org", d[8]);

  // ③ 選取複製:合成的 copy 事件帶一個 DataTransfer,不碰系統剪貼簿
  const copy = (setup) => js(`(() => { const m = $("u1"), sel = getSelection(), r = document.createRange(); ${setup}
    sel.removeAllRanges(); sel.addRange(r); const before = [r.startContainer, r.startOffset, r.endContainer, r.endOffset];
    const dt = new DataTransfer(), ev = new ClipboardEvent("copy", { clipboardData: dt, bubbles: true, cancelable: true });
    sel.anchorNode.parentElement.dispatchEvent(ev);
    const now = sel.getRangeAt(0), same = now.startContainer === before[0] && now.startOffset === before[1] && now.endContainer === before[2] && now.endOffset === before[3];
    return { plain: dt.getData("text/plain"), html: dt.getData("text/html"), prevented: ev.defaultPrevented, same }; })()`);
  const p0 = `const p = m.querySelector("p"), a = p.querySelector("a");`;
  let c = await copy(p0 + ` r.setStart(p.firstChild, 0); r.setEnd(p.lastChild, p.lastChild.length);`);
  ok("③ 選整段:text/plain 是完整原網址", c.prevented && c.plain === "來源 " + XQ + " 看這篇", c);
  ok("③ 選整段:text/html 裡的 <a> 字也換成 href", c.html.includes(">" + XQ + "</a>") && !c.html.includes("…"), c.html);
  ok("③ 用戶的反白沒動", c.same);
  c = await copy(p0 + ` r.setStart(p.firstChild, 1); r.setEnd(a.firstChild, 5);`);
  ok("③ 只選到連結前半:擴到整條、貼出完整網址,沒有半截縮短字", c.prevented && c.plain === "源 " + XQ && c.same, c);
  c = await copy(p0 + ` r.setStart(a.firstChild, 3); r.setEnd(a.firstChild, 8);`);
  ok("③ 只選到連結中間一小段:也是整條完整網址", c.prevented && c.plain === XQ, c);
  c = await copy(`const ps = m.querySelectorAll("p"); r.setStart(ps[0].firstChild, 0); r.setEnd(ps[1].lastChild.firstChild, 3);`);
  ok("③ 跨兩段:兩條都換成完整網址、段落之間有換行", c.prevented && c.plain.includes(XQ + " 看這篇\n") && c.plain.endsWith("https://www.tradingview.com/chart/?symbol=BINANCE%3ABTCUSDT.P&interval=60"), c);
  c = await copy(`const p = m.querySelectorAll("p")[4]; r.setStart(p.firstChild, 0); r.setEnd(p.lastChild, p.lastChild.length);`);
  ok("③ 沒碰到縮過的連結(檔名、版號那段):不攔,交給原生", !c.prevented && c.plain === "", c);

  // ④ 串流:網址還沒送完(半截 %e)不當掉,送完後字對
  const s = await js(`(() => { const el = addMsg("ai", ""); const half = ${JSON.stringify(XQ.slice(0, 47))};
    let err = null; try { paintAi(el, "看 " + half, true); } catch (e) { err = e.message; }
    const mid = el.querySelector("a") ? el.querySelector("a").textContent : null;
    paintAi(el, "看 " + ${JSON.stringify(XQ)}, false);
    return { err, mid, done: el.querySelector("a").textContent }; })()`);
  ok("④ 串流半截網址不丟例外、送完顯示對", s.err === null && typeof s.mid === "string" && s.done === CASES[0][1], s);

  console.log(red ? `\n${red} 紅` : "\nALL PASS");
  app.exit(red ? 1 : 0);
});
