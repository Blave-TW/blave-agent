/* 桌面版 i18n 的漂移閘門。跑法:node tests/check_shell_strings.js
 *
 * 抓四種會讓用戶看到半成品的錯:
 *   1. en / zh 兩張表的 key 不對齊 —— 少一邊就會在那個語系露出英文或 key。
 *   2. 程式用到但表裡沒有的 key —— t() 會原樣吐 key 到畫面上。
 *   3. renderer 的非註解行裡還留著中文字面 —— 那就是漏翻的字串。
 *   4. strings.js 跟 .po 不同步 —— 翻譯改了但忘了重跑產生器。
 *
 * 第 3 項只掃 renderer(用戶看得到的那層)。main.js 不組句子、只丟穩定代號,
 * 所以它的中文只會出現在註解裡。
 */
const fs = require("fs");
const path = require("path");

const SHELL = path.join(__dirname, "..", "shell");
const read = (p) => fs.readFileSync(path.join(SHELL, p), "utf8");

let bad = 0;
const fail = (msg) => { console.log("FAIL  " + msg); bad++; };
const pass = (msg) => console.log("PASS  " + msg);

// ---- 1. en / zh 對齊 ----
// 用戶看得到的那層:主畫面 + 報告的各個分頁模組(report-*.js 由別的檔負責,
// 沒列進來的話它們的 key 漂移、漏翻的字面都不會被擋到)。
// trade.js(自動下單頁)也是手寫的畫面檔;strings.js 是產生的、i18n.js 不放字串,兩個不掃。
const RENDERER_FILES = ["renderer/app.js", "renderer/index.html",
  ...fs.readdirSync(path.join(SHELL, "renderer")).filter((f) => /^(report-.*|trade|datasrc|handoff)\.js$/.test(f)).map((f) => "renderer/" + f)];

const src = read("renderer/strings.js");
const block = (name) => src.split(`  ${name}: {`)[1].split("\n  },")[0];
const keysOf = (b) => new Set([...b.matchAll(/^\s*"([^"]+)":/gm)].map((m) => m[1]));
const en = keysOf(block("en"));
const zh = keysOf(block("zh"));
const onlyEn = [...en].filter((k) => !zh.has(k));
const onlyZh = [...zh].filter((k) => !en.has(k));
if (onlyEn.length || onlyZh.length) {
  fail(`en/zh 不對齊 — 只有 en: [${onlyEn}] / 只有 zh: [${onlyZh}]`);
} else {
  pass(`en/zh 各 ${en.size} 個 key,對齊`);
}

// ---- 2. 用到的 key 都存在 ----
const used = new Set();
for (const f of RENDERER_FILES) {
  const txt = read(f);
  for (const m of txt.matchAll(/\bt\("([^"]+)"/g)) used.add(m[1]);
  for (const m of txt.matchAll(/data-i18n(?:-html|-ph|-aria)?="([^"]+)"/g)) used.add(m[1]);
}
// 主行程丟出去的:progress("key") 與 new Error("STABLE_CODE")
const mainjs = read("main.js");
for (const m of mainjs.matchAll(/progress\("([a-z][\w.]+)"\)/g)) used.add(m[1]);
for (const m of mainjs.matchAll(/new Error\("([A-Z_]{4,})"\)/g)) used.add(m[1]);

const missing = [...used].filter((k) => !en.has(k));
if (missing.length) fail(`用到但表裡沒有:[${missing}]`);
else pass(`引用的 ${used.size} 個 key 都在表裡`);

// ---- 3. renderer 的非註解行沒有中文字面 ----
const HAN = /[一-鿿]/;
for (const f of RENDERER_FILES) {
  const hits = [];
  let inBlock = false;
  read(f).split("\n").forEach((line, i) => {
    const s = line.trim();
    if (f.endsWith(".html")) {
      if (s.startsWith("<!--")) inBlock = !s.includes("-->");
      else if (inBlock) { if (s.includes("-->")) inBlock = false; }
      else if (HAN.test(line)) hits.push(i + 1 + ": " + s.slice(0, 60));
      return;
    }
    if (inBlock) { if (s.includes("*/")) inBlock = false; return; }
    if (s.startsWith("/*")) { inBlock = !s.includes("*/"); return; }
    if (s.startsWith("//") || s.startsWith("*")) return;
    // 行尾註解:把 // 之後切掉再看(字串裡的 // 很少,切多了只會少報)
    const code = line.split("//")[0];
    if (HAN.test(code)) hits.push(i + 1 + ": " + s.slice(0, 60));
  });
  if (hits.length) fail(`${f} 非註解行還有中文字面:\n    ` + hits.join("\n    "));
  else pass(`${f} 非註解行沒有中文字面`);
}

// ---- 4. strings.js 是不是從現在的 .po 產出來的 ----
// 產到暫存再比對,不比 hash:標頭那行以後要改,hash 會無謂地紅。
// 沒有 babel 的環境(別台機器、CI)跳過,前三項仍然照跑。
const { execFileSync } = require("child_process");
// 找一顆裝了 babel 的 python:先看 BLAVE_PO_PYTHON,再試 PATH 上的 python3。
// 不寫死任何人機器上的路徑——這是公開 repo。
function findPython() {
  for (const py of [process.env.BLAVE_PO_PYTHON, "python3"].filter(Boolean)) {
    try { execFileSync(py, ["-c", "import babel"], { stdio: "pipe" }); return py; }
    catch (_) { /* 下一個 */ }
  }
  return null;
}
const PY = findPython();
if (!PY) {
  console.log("SKIP  strings.js 同步檢查(找不到裝了 babel 的 python;可設 BLAVE_PO_PYTHON)");
} else {
  const keep = read("renderer/strings.js");
  const SJ = path.join(SHELL, "renderer/strings.js"), mtime0 = fs.statSync(SJ).mtimeMs;
  try {
    execFileSync(PY, [path.join(SHELL, "tools", "po2js.py")], { stdio: "pipe" });
    const now = read("renderer/strings.js");
    if (now !== keep) {
      fs.writeFileSync(SJ, keep);  // 別動工作樹
      fail("strings.js 跟 .po 不同步 —— 跑 `python shell/tools/po2js.py` 再 commit");
    } else {
      pass("strings.js 與 .po 同步");
      // 同步的時候產生器不可以重寫檔案:打包新鮮度閘門比的是 mtime,
      // 跑一次測試就把來源變新 = 「產物比來源舊」假紅(而假紅會訓練大家忽略那個閘門)
      if (fs.statSync(SJ).mtimeMs === mtime0) pass("產生器沒有白寫一次(mtime 沒動,打包新鮮度閘門不會被測試弄紅)");
      else fail("po2js.py 內容沒變還是重寫了 strings.js —— 打包新鮮度閘門會因此假紅");
    }
  } catch (e) {
    fail("產生器跑不起來:" + (e.stderr ? e.stderr.toString().trim() : e.message));
  }
}

// ---- 5. 對用戶顯示的門檻不得寫死數字 ----
// spec-desktop-positions-readable.md §2:門檻數字只能來自機器端回報的 gates,
// 前端那顆平坦的 10 只能拿來判斷(trGateSide),永遠不可以印成文案。
// 兩頭都守:字串本身不能有數字或參數,呼叫端不能再塞第二個參數進去。
const valsOf = (b) => Object.fromEntries([...b.matchAll(/^\s*("(?:[^"\\]|\\.)*"): ("(?:[^"\\]|\\.)*"),?$/gm)]
  .map((m) => [JSON.parse(m[1]), JSON.parse(m[2])]));
const enV = valsOf(block("en")), zhV = valsOf(block("zh"));
const numbered = ["en", "zh"].filter((l) => /\d|\{/.test((l === "en" ? enV : zhV)["tr.threshold"] || ""));
if (numbered.length) fail(`tr.threshold 帶了數字或參數(${numbered})—— §2:門檻只能來自 gates,文案不提數字`);
else pass("tr.threshold 兩語都不提數字");
const trjs = read("renderer/trade.js");
if (/t\("tr\.threshold",/.test(trjs)) fail("trade.js 又把值代進 tr.threshold —— §2 只准不帶參數的 t(\"tr.threshold\")");
else if (!/t\("tr\.threshold"\)/.test(trjs)) fail("trade.js 找不到 t(\"tr.threshold\") 的呼叫");
else pass("trade.js 的 tr.threshold 不帶參數");

// ---- 6. 雲端視角:網頁限定的事歸給網頁工作頁;agent 做得到的事不可以再歸給網頁 ----
// A′ 之後 agent 能在雲端主機上做策略,「新增策略要到網頁」是假話。今天仍是網頁限定的:定期報告、每支策略的下單方式與
// 策略管理(spec-desktop-cloud-writable §6 剩下的那幾列)。連接交易所**不再是**網頁限定:cxModalOpen 在主機 running 時兩個視角都開得起來
// (cxConnectCloud)。網頁限定那一句從 pv.d.running 搬進「方案內容與計費」(pv.inc.web,spec-desktop-settings-cleanup §4);
// 兩句都查:提到這幾件事就得在同一句指去網頁工作頁,而且不可以再把連接交易所歸給網頁。
const CAP = { zh: [/定期報告/, /連接交易所/, /下單方式/], en: [/report/i, /connect(ing)? an exchange/i, /order handling/i] };
const NOT_WEB = { zh: /新增策略/, en: /add(ing)? strateg/i };
const HOME = { zh: /工作頁/, en: /workspace/i };
const CX_WEB = { zh: /連接交易所/, en: /connect(ing)? an exchange/i };
["en", "zh"].forEach((l) => ["pv.d.running", "pv.inc.web"].forEach((k) => {
  const s = (l === "en" ? enV : zhV)[k] || "";
  const liar = s.split(/[。.]/).filter((x) => CAP[l].some((re) => re.test(x)) && !HOME[l].test(x));
  if (!s) fail(`${k}(${l})不在表裡`);
  else if (liar.length) fail(`${k}(${l})把雲端視角做不到的事講成做得到:「${liar[0].trim()}」`);
  else if (NOT_WEB[l].test(s)) fail(`${k}(${l})還在把「新增策略」歸給網頁——agent 現在能在雲端主機上做策略`);
  else if (s.split(/[。.]/).some((x) => CX_WEB[l].test(x) && HOME[l].test(x))) fail(`${k}(${l})還在把「連接交易所」歸給網頁——app 在雲端視角就連得了`);
  else pass(`${k}(${l})的網頁限定清單歸給網頁工作頁,新增策略、連接交易所不再歸給它`);
}));
if (/定期報告/.test(zhV["pv.inc.web"] || "") && /工作頁/.test(zhV["pv.inc.web"] || "") && !/定期報告/.test(zhV["pv.d.running"] || "")) pass("網頁限定那一句從運行中搬進方案內容(pv.inc.web),運行中那段不再講");
else fail("網頁限定那一句要在 pv.inc.web、不在 pv.d.running");

// ---- 7. A′ 落地的六句 + 那一組新 key ----
// 四句重寫不得再講「只能看」「留在電腦上」;刪掉的 key(cut1 / tr.ro.note、「操作對象」那列的五句)不得留在表裡;
// §2 抓不到用 dataset.i18n 指派的 key(trade.js envPaint 的 placeholder、app.js 的 .wtag / .sysline),在這裡明列。
const GONE = ["chat.tgt.cut1", "tr.ro.note", "chat.tgt.label", "chat.tgt.cloudNone", "chat.tgt.cloudSignedOut", "chat.tgt.cloudStarting", "chat.tgt.cloudStopped"], NEW = ["chat.tgt.cloud", "chat.ph.cloud", "chat.sw.cloud", "chat.sw.local", "tr.cloud.onboardExtra"];
const LIE = { zh: /只能看|留在電腦上|還不能操作/, en: /can only view|stay on this computer|can’t work on the cloud/i };
{ const gone = GONE.filter((k) => en.has(k) || zh.has(k)), miss = NEW.filter((k) => !en.has(k) || !zh.has(k));
  if (gone.length) fail(`已刪的 key 還在表裡:[${gone}]`); else pass("chat.tgt.cut1 / tr.ro.note / 操作對象那列的五句兩語都刪了");
  if (miss.length) fail(`A′ 那一組 key 缺:[${miss}]`); else pass("A′ 留下的五個 key(.wtag / placeholder / 系統行 / onboardExtra)兩語都在");
  const lies = ["en", "zh"].flatMap((l) => ["pv.d.running", "pv.inc.note", "tr.onboard.cloud", "ho.emptyHint"].filter((k) => LIE[l].test((l === "en" ? enV : zhV)[k] || "")).map((k) => l + ":" + k));
  if (lies.length) fail(`重寫的四句還帶著已經不成立的話:[${lies}]`); else pass("四句重寫不再講「只能看」「留在電腦上」");
  // agent 不下單(inventory §7):同一句裡 agent 後面不可以接「啟動 / 暫停」——那是用戶自己在 app 裡按的
  const AGENT_ACT = { zh: /agent[^。；;]*(啟動|暫停)/, en: /agent[^.;]*\b(start|pause)/i };
  const acts = ["en", "zh"].flatMap((l) => ["pv.d.running", "pv.inc.note", "tr.onboard.cloud", "ho.emptyHint"].filter((k) => AGENT_ACT[l].test((l === "en" ? enV : zhV)[k] || "")).map((k) => l + ":" + k));
  if (acts.length) fail(`把啟動 / 暫停下單講成 agent 做的:[${acts}]`); else pass("啟動 / 暫停下單不跟 agent 同一句(主詞是用戶)");
  // ho.emptyHint 兩條路並陳,順序仍是 handoff 在前(MVP 一句話:電腦 = 研發的地方);不可以只留「請 agent 做」
  const hz = zhV["ho.emptyHint"] || "", he = enV["ho.emptyHint"] || "";
  if (hz.indexOf("送上雲端") > 0 && hz.indexOf("送上雲端") < hz.indexOf("agent") && /Send to Cloud/.test(he) && he.indexOf("Send to Cloud") < he.indexOf("agent")) pass("ho.emptyHint 兩條路並陳、handoff 在前");
  else fail("ho.emptyHint 要先講「送上雲端」、再講「或請 agent 做一支」");
}

// ---- 7. 停機跨棒自動暫停還沒上線(lib/downtime 在 downtime-lib 分支、沒併進 main),兩句不得承諾它 ----
{ const PROMISE = { zh: /自動暫停|逐支確認|一張單都不下|連減倉/, en: /auto(matically)?[- ]?paus|pauses itself|until you confirm|places no orders/i };
  const keys = ["tr.means.3", "tr.cloud.means.4"];
  const miss = ["en", "zh"].flatMap((l) => keys.filter((k) => !(l === "en" ? enV : zhV)[k]).map((k) => l + ":" + k));
  const hits = ["en", "zh"].flatMap((l) => keys.filter((k) => PROMISE[l].test((l === "en" ? enV : zhV)[k] || "")).map((k) => l + ":" + k));
  if (miss.length) fail(`停機那兩句缺:[${miss}]`);
  else if (hits.length) fail(`停機那兩句又承諾了還沒上線的自動暫停:[${hits}]`);
  else pass("tr.means.3 / tr.cloud.means.4 不承諾自動暫停");
}

console.log(bad ? `\n${bad} 紅` : "\nALL PASS");
process.exit(bad ? 1 : 0);
