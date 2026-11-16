// browser_read 讀程式碼區塊時行號對得上(0.1.8 第十六批 #3):每行一個區塊元素的程式碼檢視器,空的行元素被 innerText 整個吃掉,
// agent 數到的第 9–11 行其實是畫面上的第 10–12 行。shell/browser/inpage.js 的 extract() 在 <pre> 裡遇到這種結構改成逐行讀。
// 0.1.54:不是 <pre> 的程式碼檢視器(white-space: pre 的 div、每個語法記號一個 span、行間 <br>)也照行讀;程式碼截長一律留記號。
//   ① 原文:preText、codeView 在 extract 裡面(extract 會被 toString() 送進頁面,必須自給自足)
//   ② 隨包的 Electron、看不見的視窗、本機替身頁(data: 網址,不連外):各種寫法讀出來的行數與畫面一致;一般文章不受影響
// 跑法:node tests/check_shell_browser_read_code_lines.js(沒設 BLAVE_TEST_WINDOW=1 時 ② SKIP)
const path = require("path"), fs = require("fs"), os = require("os");
const SHELL = path.join(__dirname, "..", "shell");
const GATE = require("./_electron_gate");
const IP = require(path.join(SHELL, "browser", "inpage.js"));
let red = 0; const t = (n, ok, d) => { console.log((ok ? "PASS  " : "FAIL  ") + n + (ok || d === undefined ? "" : "  ← " + JSON.stringify(d))); if (!ok) red++; };

if (!process.versions.electron) {
  const src = IP.extract.toString();
  t("① preText 定義在 extract 裡面,<pre> 那一支用它", /function preText\(pre\)/.test(src) && /tg === "pre"\) \{ codeBlk\(n, preText\(n\), 20000\)/.test(src));
  t("① 兩條程式碼路徑都經 codeBlk(fence 長度跟著內容、記號與收尾 fence 不被 200k 切掉)", /function codeBlk\(n, s, cap\)/.test(src) && /codeBlk\(n, cv, MAX\)/.test(src) && !/blk\(n, "```/.test(src));
  t("① 沒有站點特例(extract 不看網域)", !/location\.host|hostname|tradingview/i.test(src));
  t("① gutter 定義在 extract 裡面,跟 SKIP、hidden 同一關先擋(行號欄在程式碼前面就要擋下)", /function gutter\(el\)/.test(src) && /SKIP\.has\(tg\) \|\| hidden\(n\) \|\| gutter\(n\)\) continue;/.test(src));
  t("① codeView 也定義在 extract 裡面,一般遞迴前先問它", /function codeView\(el\)/.test(src) && /const cv = codeView\(n\);[\s\S]*?block\(n, depth \+ 1\);\s*\}\s*\}\s*block\(root, 0\)/.test(src));
  // extract 之後還要過 readPart(切 12k)與 envelope(scrub):縮排、連續空行、截斷記號送到 agent 手上要原樣
  const C = require(path.join(SHELL, "browser", "content.js"));
  const fence = "```\nif x\n    strategy.entry(\"L\", strategy.long)\n\n\n\t// tab\n… [truncated: 40 of 104696 characters]\n```\n\n";
  const rp = C.readPart({ markdown: "# T\n\n" + fence, headings: [], links: [], meta: {} }, { part: "full" }, (n) => n);
  t("① readPart + envelope 不動程式碼的空白與截斷記號", C.envelope("https://x.example/", "T", rp.content, { total_chars: rp.total_chars }).untrusted_content === "# T\n\n" + fence, rp);
  // 精簡讀取也帶 total_chars(0.1.54):agent 點開 Source code 後用 part=meta 量整頁大小,不必先燒一次 12k 的 full
  const big = { markdown: "x".repeat(47926), headings: [{ id: "h1", level: 1, text: "S", at: 0 }], links: [{ text: "a", url: "https://a.example/" }], meta: { title: "S" } };
  let spent = 0; const bud = (n) => { spent += n; return n; };
  const sm = ["meta", "outline", "links"].map((p) => C.readPart(big, { part: p }, bud));
  t("① part=meta / outline / links 都回 total_chars = 整頁 markdown 長度,只扣自己那一小段的預算", sm.every((x) => x.total_chars === 47926 && x.content) && spent < 300, { sm: sm.map((x) => x.total_chars), spent });
  t("① 預算用完時精簡讀取照舊 budget_exhausted(不洩 total_chars)", C.readPart(big, { part: "meta" }, () => 0).error === "budget_exhausted" && C.readPart(big, { part: "meta" }, () => 0).total_chars === undefined);
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
const code = (md) => { const m = /(`{3,})\n([\s\S]*?)\n\1\n/.exec(md); return m ? m[2] : null; };
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
  const bigLen = Array.from({ length: 4000 }, (_, i) => "line " + i + " " + "x".repeat(40)).join("\n").length, bm = /\n… \[truncated: (\d+) of (\d+) characters\]$/.exec(bc || "");
  t("② <pre> 截長不再靜默:最後一行是截斷記號,N = 留下的字數、M = 原文字數", !!bm && Number(bm[1]) === bc.length - bm[0].length && Number(bm[2]) === bigLen, bc && bc.slice(-80));

  // 不是 <pre> 的程式碼檢視器(0.1.54):white-space: pre 的 div,每行一個 span、裡面每個語法記號一個 span,行間 <br>,空行是包著空 span 的 span。
  // 原本一般遞迴把每個記號拆成一段、換行與縮排全丟
  const PINE = ["//@version=6", "strategy(title = \"x\", overlay = true)", "", "len = input.int(14, \"Length\")  // lookback", "if ta.crossover(close, ta.sma(close, len))", "    strategy.entry(\"L\", strategy.long)", "    // exit after 5 bars", "", "", "if bar_index % 5 == 0", "    strategy.close(\"L\")"];
  const toks = (l) => (l.match(/^ */)[0] ? "<span>" + l.match(/^ */)[0] + "</span>" : "") + (l.trim().match(/\/\/.*|"[^"]*"|\w+|[^\s\w]|\s+/g) || []).map((x) => "<span>" + x.replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</span>").join("");
  const viewer = (lines) => "<div class=code-x><div class=viewer style=\"white-space:pre\">" + lines.map((l) => "<span>" + (l ? toks(l) : "<span></span>") + "</span><br>").join("") + "</div></div>";
  const pv = await read(viewer(PINE)), pc = code(pv.markdown), pl = pc == null ? [] : pc.split("\n");
  t("② 程式碼檢視器照行讀:" + PINE.length + " 行、每行內容與縮排、空行、// 註解都對得上", pc === PINE.join("\n") && pl.length === PINE.length && pl[5] === PINE[5] && pl[7] === "" && pl[8] === "", pc);
  t("② 程式碼檢視器不再逐記號拆段", !/\n\n\(\n\n|\n\noverlay\n\n/.test(pv.markdown) && pv.markdown.split("```").length === 3, pv.markdown.slice(0, 400));
  const single = await read("<div style=\"white-space:pre\"><span>Price</span> <span>42</span></div><p>After.</p>");
  t("② 只有一行的 white-space: pre 標籤照舊(不包成程式碼)", !single.markdown.includes("```") && single.markdown.includes("Price\n\n42\n\nAfter.\n\n"), single.markdown);
  const plain = await read("<div style=\"white-space:pre\">Line one\nLine two</div><p>After.</p>");
  t("② white-space: pre 但沒有 span(純文字)照舊", !plain.markdown.includes("```") && plain.markdown.includes("Line one Line two\n\nAfter.\n\n"), plain.markdown);
  const mixedBox = await read("<div style=\"white-space:pre\"><span>a</span><br><div>block child</div><span>b</span></div><p>After.</p>");
  t("② white-space: pre 但裡面有區塊元素照舊", !mixedBox.markdown.includes("```"), mixedBox.markdown);
  const HUGE = Array.from({ length: 4200 }, (_, i) => "x" + i + " = " + "1".repeat(40)), hugeLen = HUGE.join("\n").length;
  const hv = await read(viewer(HUGE)), hc = code(hv.markdown) || "", hm = /\n… \[truncated: (\d+) of (\d+) characters\]$/.exec(hc);
  t("② 程式碼檢視器超過 200k:截斷處留記號(M = 原文字數)、收尾的 fence 還在、沒有截在 2 萬", hugeLen > 200000 && !!hm && Number(hm[2]) === hugeLen && Number(hm[1]) === hc.length - hm[0].length && hc.length > 150000, { hugeLen, got: hc.length, tail: hc.slice(-80), mdTail: hv.markdown.slice(-40) });
  const mid = Array.from({ length: 900 }, (_, i) => "v" + i + " = " + "2".repeat(40)), mv = code((await read(viewer(mid))).markdown);
  t("② 程式碼檢視器 2 萬到 20 萬之間整段讀完,不截", mid.join("\n").length > 40000 && mv === mid.join("\n"), mv && mv.length);
  // 檢視器旁的行號欄(0.1.54):一欄每行一個數字,跟程式碼並排;原本整欄在 fence 前讀成一段一個數字
  const nums = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => "<div>" + (a + i) + "</div>").join("");
  const pane = (lines) => viewer(lines).replace(/^<div class=code-x>|<\/div>$/g, "");
  const GUT = [
    ["行號欄是檢視器的前一個兄弟", "<div style=\"display:flex\"><div>" + nums(1, PINE.length) + "</div>" + pane(PINE) + "</div>"],
    ["行號欄與檢視器各包兩層", "<div style=\"display:flex\"><div class=margin><div class=overlays>" + nums(1, PINE.length) + "</div></div><div class=scroll><div class=lines>" + pane(PINE) + "</div></div></div>"],
    ["行號欄絕對定位疊在左邊", "<div style=\"position:relative\"><div style=\"position:absolute;left:0;top:0;width:40px\">" + nums(1, PINE.length) + "</div><div style=\"margin-left:60px\">" + pane(PINE) + "</div></div>"],
  ];
  for (const [name, body] of GUT) {
    const g = await read(body);
    t("② " + name + ":行號不出現、程式碼照舊", !/^\d+$/m.test(g.markdown) && code(g.markdown) === PINE.join("\n") && g.markdown.split("```").length === 3, g.markdown.slice(0, 500));
  }
  const artNums = await read("<div>1</div><div>2</div><div>3</div><div><div>4</div><div>5</div></div>" + viewer(PINE) + "<div><div>6</div><div>7</div></div>");
  t("② 文章裡上下疊的數字段落(同頁有檢視器)照讀", artNums.markdown.includes("1\n\n2\n\n3\n\n4\n\n5\n\n") && artNums.markdown.includes("```\n\n6\n\n7\n\n") && code(artNums.markdown) === PINE.join("\n"), artNums.markdown);
  const noCode = await read("<div><div>1</div><div>2</div><div>3</div></div><div style=\"display:flex\"><div>" + nums(4, 6) + "</div><div><p>Side text, not code.</p></div></div>");
  t("② 沒有程式碼檢視器時並排的數字欄也照讀", noCode.markdown.includes("1\n\n2\n\n3\n\n4\n\n5\n\n6\n\n"), noCode.markdown);
  // 註解裡的網址做成 <a>、強調做成 <b>:還是程式碼檢視器,不退回逐記號拆段
  const LINKED = ["//@version=6", "// docs: https://x.example/pine", "if close > open", "    strategy.entry(\"L\", strategy.long)"];
  const lv = "<div style=\"white-space:pre\"><span><span>//@version=6</span></span><br><span><span>// docs: </span><a href=\"https://x.example/pine\">https://x.example/pine</a></span><br>"
    + "<span><b>if</b><span> close &gt; open</span></span><br><span><span>    </span><span>strategy.entry(\"L\", strategy.long)</span></span><br></div>";
  const lc = code((await read(lv)).markdown);
  t("② 檢視器裡有 <a>、<b>:照行讀,內容與縮排對得上", lc === LINKED.join("\n"), lc);
  // 程式碼裡有一行 ```:fence 比它長,區塊不會提早收尾
  const TICKS = ["s = \"x\"", "```", "y = 1", "`` z ``"];
  const tv = await read("<div style=\"white-space:pre\">" + TICKS.map((l) => "<span>" + l.replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</span><br>").join("") + "</div>");
  const tp = await read("<pre>" + TICKS.join("\n") + "</pre>");
  t("② 內容有 ``` 時 fence 用 4 個反引號,檢視器與 <pre> 兩條路都整段在 fence 裡", [tv, tp].every((x) => x.markdown.includes("````\n" + TICKS.join("\n") + "\n````\n\n") && code(x.markdown) === TICKS.join("\n")), [tv.markdown.slice(300, 420), tp.markdown.slice(300, 420)]);
  // 整頁快滿 200k 時才遇到程式碼:只剩記號也要有記號與收尾 fence
  const fill = "<p>" + "y".repeat(3000) + "</p>";
  const near = await read(fill.repeat(66) + "<p>" + "y".repeat(1519) + "</p>" + viewer(PINE));
  const at = near.markdown.indexOf("```"), tail = near.markdown.slice(at);
  t("② 剩不到 60 字的空間:程式碼只留記號,記號與收尾 fence 都在,最多超出 200k 一小段", at > 0 && 200000 - at < 60 && /^```\n\n… \[truncated: 0 of \d+ characters\]\n```\n\n$/.test(tail) && near.markdown.length <= 200000 + 80, { room: 200000 - at, tail, len: near.markdown.length });
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* userData 還鎖著 */ }
  console.log(red ? `\n${red} FAILED` : "\nALL PASS");
  app.exit(red ? 1 : 0);
}).catch((e) => { console.log("FAIL  " + (e && e.stack)); app.exit(1); });
