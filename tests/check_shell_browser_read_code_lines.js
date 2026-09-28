// browser_read 讀程式碼區塊時行號對得上(0.1.8 第十六批 #3):每行一個區塊元素的程式碼檢視器,空的行元素被 innerText 整個吃掉,
// agent 數到的第 9–11 行其實是畫面上的第 10–12 行。shell/browser/inpage.js 的 extract() 在 <pre> 裡遇到這種結構改成逐行讀。
//   ① 原文:preText 在 extract 裡面(extract 會被 toString() 送進頁面,必須自給自足)
//   ② 隨包的 Electron、看不見的視窗、本機替身頁(data: 網址,不連外):各種寫法讀出來的行數與畫面一致;一般文章不受影響
// 跑法:node tests/check_shell_browser_read_code_lines.js(沒設 BLAVE_TEST_WINDOW=1 時 ② SKIP)
const path = require("path"), fs = require("fs"), os = require("os");
const SHELL = path.join(__dirname, "..", "shell");
const GATE = require("./_electron_gate");
const IP = require(path.join(SHELL, "browser", "inpage.js"));
let red = 0; const t = (n, ok, d) => { console.log((ok ? "PASS  " : "FAIL  ") + n + (ok || d === undefined ? "" : "  ← " + JSON.stringify(d))); if (!ok) red++; };

if (!process.versions.electron) {
  const src = IP.extract.toString();
  t("① preText 定義在 extract 裡面,<pre> 那一支用它", /function preText\(pre\)/.test(src) && /tg === "pre"\) \{ blk\(n, "```\\n" \+ preText\(n\)/.test(src));
  t("① 沒有站點特例(extract 不看網域)", !/location\.host|hostname|tradingview/i.test(src));
  const bin = GATE.bin(SHELL, "②");
  if (!bin) { console.log(red ? `\n${red} FAILED` : "\nALL PASS"); process.exit(red ? 1 : 0); }
  const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit", env: { ...process.env, ELECTRON_ENABLE_LOGGING: "" } });
  const sub = r.status == null ? 1 : r.status;
  console.log(red || sub ? "\nFAILED" : "\nALL PASS");
  process.exit(red || sub ? 1 : 0);
}
const { app, BrowserWindow } = require("electron");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blave-read-lines-"));
app.setPath("userData", tmp);
// 12 行,第 3、6、7 行是空的:問第 9–11 行要答得出這三行
const LINES = ["//@version=6", "indicator(\"x\")", "", "len = input.int(14)", "src = close", "", "", "ma = ta.sma(src, len)", "up = ta.crossover(src, ma)", "dn = ta.crossunder(src, ma)", "plot(ma)", "alertcondition(up)"];
const WANT = LINES.join("\n");
const tok = (l) => l.split(" ").map((w, i) => (i ? " " : "") + "<span>" + w.replace(/</g, "&lt;") + "</span>").join("");
const rows = (empty, sep) => LINES.map((l) => "<div class=line>" + (l ? tok(l) : empty) + "</div>").join(sep || "");
const pad = "<p>" + "Filler paragraph text for the main node heuristic. ".repeat(6) + "</p>";
const CASES = [
  ["每行一個 div、空行是空的 div(重現:原本空行被吃掉)", "<pre>" + rows("") + "</pre>", WANT],
  ["每行一個 div、空行裡放一個 <br>(原本每個空行多算一行)", "<pre>" + rows("<br>") + "</pre>", WANT],
  ["<pre><code> 裡每行一個 div", "<pre>\n<code>" + rows("") + "</code>\n</pre>", WANT],
  ["每行一個 display:block 的 span", "<pre><style>.line{display:block}</style>" + LINES.map((l) => "<span class=line>" + l + "</span>").join("") + "</pre>", null],
  ["藏起來的行不讀", "<pre>" + rows("") + "<div hidden>secret</div></pre>", WANT],
  ["純文字的 <pre>(照舊)", "<pre><code>" + LINES.join("\n") + "</code></pre>", WANT],
  ["行內上色的 <pre>(span + 換行字元,照舊)", "<pre>" + LINES.map((l) => "<span>" + l + "</span>").join("\n") + "</pre>", WANT],
];
const page = (body) => "data:text/html;charset=utf-8," + encodeURIComponent("<!doctype html><html><body><article><h1>Script</h1>" + pad + body + pad + "</article></body></html>");
const code = (md) => { const m = /```\n([\s\S]*?)\n```/.exec(md); return m ? m[1] : null; };
setTimeout(() => { console.log("FAIL  ② 逾時(60 秒)"); process.exit(1); }, 60000).unref();

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  const w = new BrowserWindow({ width: 900, height: 700, show: false, webPreferences: { offscreen: true } });
  const read = async (body) => { await w.loadURL(page(body)); return w.webContents.executeJavaScript("(" + IP.extract.toString() + ")()", true); };
  for (const [name, body, want] of CASES) {
    if (want === null) {   // <style> 在 pre 裡:容器有別的子元素,不算「每行一個元素」→ 照舊 innerText;鎖的是不會壞掉
      const got = code((await read(body)).markdown);
      t("② " + name + ":容器裡混了別的元素 → 照舊讀法,內容都在", !!got && LINES.filter(Boolean).every((l) => got.includes(l)), got);
      continue;
    }
    const got = code((await read(body)).markdown), ln = got == null ? [] : got.split("\n");
    t("② " + name + ":" + LINES.length + " 行、第 9–11 行對得上", got === want && ln.slice(8, 11).join("|") === LINES.slice(8, 11).join("|"), got);
  }
  // 行與行之間夾著換行字元(pre 裡會畫成一行):不是這種結構,照舊 innerText
  const mixed = "<pre>" + rows("", "\n") + "</pre>";
  await w.loadURL(page(mixed));
  const inner = await w.webContents.executeJavaScript("document.querySelector('pre').innerText", true);
  t("② 行元素之間夾著文字節點:照舊用 innerText", code((await read(mixed)).markdown + "") === inner.replace(/\n$/, "") || (await read(mixed)).markdown.includes("```\n" + inner + "\n```"), inner);
  // 一般文章:空的 div、段落、清單照舊
  const art = await read("<div></div><p>First paragraph.</p><div class=sp></div><div><div></div></div><ul><li>one</li><li>two</li></ul><p>Last.</p>");
  t("② 一般文章不受影響:空的 div 不會變成空行", art.markdown.includes("First paragraph.\n\n- one\n- two\n\nLast.\n\n"), art.markdown);
  // 上限照舊:20000 字
  const big = await read("<pre>" + Array.from({ length: 4000 }, (_, i) => "<div>line " + i + " " + "x".repeat(40) + "</div>").join("") + "</pre>");
  const bc = code(big.markdown);
  t("② 很長的程式碼區塊照舊截在 20000 字;超過 5000 行的不逐行量", !!bc && bc.length <= 20000 && bc.startsWith("line 0 ") && code((await read("<pre>" + "<div>a</div>".repeat(5001) + "</pre>")).markdown).length <= 20000, bc && bc.length);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* userData 還鎖著 */ }
  console.log(red ? `\n${red} FAILED` : "\nALL PASS");
  app.exit(red ? 1 : 0);
}).catch((e) => { console.log("FAIL  " + (e && e.stack)); app.exit(1); });
