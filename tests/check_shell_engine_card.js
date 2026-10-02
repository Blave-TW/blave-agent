// 安裝進度卡(shell/renderer/engine.js + engine.css;0.1.12 B+C,mockup-desktop-first-run-progress)。
//   ① 文案逐字:zh / en 每一句對 mockup 的文案表(抄在下面 MOCK;mockup 檔在的話也直接從它的 `const L = {…}` 讀出來再比一次)。
//   ② 純邏輯 engView:進行中 / 慢 / 沒收到資料 / 失敗(網路、說不出來、有沒有一句在等)/ 超時 / 更新 / 完成;分段條、第 n / N 個、下載量那一行。
//   ③ 接線(原文):C 的時機(開 app 背景裝、工作頁打開就對一次快照)、失敗留泡泡+重試接著送、安裝中按停止不收卡、reduced-motion 例外。
// 跑法:node tests/check_shell_engine_card.js(純 node,不開 Electron)
const fs = require("fs"), path = require("path"), vm = require("vm");
const SHELL = path.join(__dirname, "..", "shell"), R = path.join(SHELL, "renderer");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + JSON.stringify(d).slice(0, 1500))); if (!c) red++; };
const read = (f) => fs.readFileSync(f, "utf8");
const src = read(path.join(R, "engine.js")), css = read(path.join(R, "engine.css")), appSrc = read(path.join(R, "app.js")), html = read(path.join(R, "index.html"));
const mainSrc = read(path.join(SHELL, "main.js")), pre = read(path.join(SHELL, "preload.js"));
const ctx = {}; vm.createContext(ctx);
vm.runInContext(read(path.join(R, "strings.js")) + "\n" + read(path.join(R, "i18n.js")).replace(/document\.documentElement\.lang = [^;]+;/, "") + "\nthis.STRINGS = STRINGS; this.t = t; this.setLang = setLang;", ctx);

// ── ① 文案逐字(mockup 的 L.zh / L.en;key 對照:mockup → 這裡)──
const MOCK = {
  zh: { head: "正在準備這台電腦（只有第一次）", headUpd: "這一版更新了引擎，補裝一次", headFail: "這台電腦還沒準備好", size: "要從網路下載約 {size}，網路慢時要幾分鐘。",
    ws: "建立工作區", engine: "安裝引擎", pkgs: "安裝策略套件", venv: "建立 Python 環境", nth: "第 {i} / {n} 個：{name}",
    slowA: "這一步要從網路下載，網路慢時會久一點。安裝程式還在跑，超過 {limit}會自動停下，可以重試。",
    bytes: "{a} / {b} MB", dlTotal: "已下載 {x} MB", dlDone: "下載完成", stallB: "{s} 沒有收到資料，還在等網路。超過 {limit}會自動停下，可以重試。",
    failHead: "下載 {name} 時網路中斷，沒有裝完。", failSub: "重試會從 {name} 接著裝，已裝好的不重裝；裝好後送出上面那句。",
    toHead: "{step}超過 {limit}還沒完成，已經停下。", toSub: "可能是網路太慢，或公司網路、VPN 擋住了下載。重試會從 {name} 接著裝。",
    details: "錯誤訊息", retry: "重試", ready: "這台電腦準備好了 · {t}", limit10: "10 分鐘" },
  en: { head: "Setting up this computer (first run only)", headUpd: "This version updates the engine. Installing once.", headFail: "This computer isn’t set up yet",
    size: "Downloads about {size}. A slow connection can take several minutes.", ws: "Create workspace", engine: "Install engine", pkgs: "Install strategy packages",
    venv: "Create Python environment", nth: "{i} of {n}: {name}",
    slowA: "This step downloads from the internet and takes longer on a slow connection. The installer is still running; it stops after {limit} and can be retried.",
    bytes: "{a} / {b} MB", dlTotal: "{x} MB downloaded", dlDone: "Downloaded", stallB: "No data for {s}. Still waiting on the network; stops after {limit} and can be retried.",
    failHead: "The network dropped while downloading {name}. Setup didn’t finish.", failSub: "Retry picks up at {name}; finished packages are kept. The message above sends once setup finishes.",
    toHead: "{step} didn’t finish within {limit} and was stopped.", toSub: "The connection may be too slow, or a company network or VPN may be blocking the download. Retry picks up at {name}.",
    details: "Error Details", retry: "Retry", ready: "This computer is ready · {t}", limit10: "10 min" },
};
const KEYMAP = { head: "eng.head", headUpd: "eng.headUpd", headFail: "eng.headFail", size: "eng.size", ws: "eng.ws", engine: "eng.engine", pkgs: "eng.pkgs", venv: "eng.venv", nth: "eng.nth",
  slowA: "eng.slow", bytes: "eng.bytes", dlTotal: "eng.dlTotal", stallB: "eng.stall", failHead: "eng.failNet", failSub: "eng.failSub", toSub: "eng.toSub",
  details: "eng.details", retry: "eng.retry", ready: "eng.ready" };
// mockup 檔在(monorepo 裡跑)就從原檔再讀一次,抄錯的話這裡會紅
const MOCKUP = [process.env.BLAVE_MOCKUP, path.join(__dirname, "..", "..", ".claude", "output", "designer", "mockup-desktop-first-run-progress.html")].find((f) => f && fs.existsSync(f));
if (MOCKUP) {
  const m = /const L = (\{[\s\S]*?\n\});/.exec(read(MOCKUP));
  const L = m && vm.runInNewContext("(" + m[1] + ")");
  ok("① 抄下來的文案跟 mockup 原檔逐字相同", !!L && ["zh", "en"].every((lg) => Object.keys(MOCK[lg]).every((k) => L[lg][k] === MOCK[lg][k])),
    L && ["zh", "en"].flatMap((lg) => Object.keys(MOCK[lg]).filter((k) => L[lg][k] !== MOCK[lg][k]).map((k) => lg + "." + k)));
} else console.log("SKIP  ① mockup 原檔不在(不在 monorepo 裡跑);用抄下來的那份比");
// 設計稽核 0.1.12(audit-0.1.12-first-run-progress.md)改掉或新增的句子:逐字照稽核定稿,不是 mockup
// (mockup 的 toHead 用 {step}、dlDone 那格與「約 8 MB」都被稽核換掉了)
const NB = "\u00a0";
const AUDIT = {
  zh: { "eng.headUpdPkgs": "這一版更新了策略套件，補裝一次", "eng.toHead": "{name} 超過 {limit}還沒完成，已經停下。", "eng.toHeadVenv": "建立 Python 環境超過 {limit}還沒完成，已經停下。",
    "eng.installing": "正在安裝", "eng.slowInst": "已經下載完，安裝程式還在跑。超過 {limit}會自動停下，可以重試。",
    "eng.optFail": "美股資料的套件沒有裝好，暫時抓不到美股資料，其他功能照常。下次開 Blave 會再裝一次。", "eng.min": "{m}" + NB + "分鐘",
    "eng.venvSub": "這一步在這台電腦上做，不用網路。重試會從這一步接著做。", "eng.venvSubHeld": "這一步在這台電腦上做，不用網路。重試會從這一步接著做，裝好後送出上面那句。" },
  en: { "eng.headUpdPkgs": "This version updates the strategy packages. Installing once.", "eng.toHead": "{name} didn’t finish installing within {limit} and was stopped.",
    "eng.toHeadVenv": "Creating the Python environment didn’t finish within {limit} and was stopped.", "eng.installing": "Installing",
    "eng.slowInst": "Download finished; the installer is still running. It stops after {limit} and can be retried.",
    "eng.optFail": "The US stock data packages didn’t install, so US stock data isn’t available for now. Everything else works as usual. Blave will try again next time it opens.", "eng.min": "{m}" + NB + "min",
    "eng.venvSub": "This step runs on this computer and doesn’t use the network. Retry picks up at this step.",
    "eng.venvSubHeld": "This step runs on this computer and doesn’t use the network. Retry picks up at this step; the message above sends once setup finishes." },
};
const AUDIT_MD = [process.env.BLAVE_AUDIT, path.join(__dirname, "..", "..", ".claude", "output", "designer", "audit-0.1.12-first-run-progress.md")].find((f) => f && fs.existsSync(f));
if (AUDIT_MD) {
  const md = read(AUDIT_MD);
  const miss = ["zh", "en"].flatMap((lg) => Object.entries(AUDIT[lg]).filter(([k]) => k !== "eng.min").filter(([, v]) => !md.includes(v)).map(([k]) => lg + "." + k));
  ok("① 抄下來的稽核定稿跟稽核報告原檔逐字相同", miss.length === 0, miss);
} else console.log("SKIP  ① 稽核報告原檔不在(不在 monorepo 裡跑);用抄下來的那份比");
for (const lg of ["zh", "en"]) {
  const bad = Object.entries(AUDIT[lg]).filter(([k, v]) => ctx.STRINGS[lg][k] !== v).map(([k]) => k + " → " + ctx.STRINGS[lg][k]);
  ok("① " + lg + ":稽核改過 / 新增的句子逐字照定稿(數字與單位之間是不換行空格)", bad.length === 0, bad);
}
ok("① 舊的「下載完成」那格拿掉了(左格改講正在安裝)", !("eng.dlDone" in ctx.STRINGS.zh) && !("eng.dlDone" in ctx.STRINGS.en) && !/eng\.dlDone/.test(src));
for (const lg of ["zh", "en"]) {
  const bad = Object.keys(KEYMAP).filter((k) => ctx.STRINGS[lg][KEYMAP[k]] !== MOCK[lg][k]);
  ok("① " + lg + ":每一句跟 mockup 逐字相同", bad.length === 0, bad.map((k) => k + " → " + ctx.STRINGS[lg][KEYMAP[k]]));
  ok("① " + lg + ":{limit} = 實際上限(10 分鐘)照 mockup 的寫法,空格換成不換行空格", ctx.STRINGS[lg]["eng.min"].replace("{m}", "10") === MOCK[lg].limit10.replace(" ", NB));
}
ok("① 截短的兩句只截不改:failSubIdle = failSub 的第一句;failOther = failHead 的最後一句",
  ctx.STRINGS.zh["eng.failSubIdle"] === MOCK.zh.failSub.split("；")[0] + "。" && ctx.STRINGS.en["eng.failSubIdle"] === MOCK.en.failSub.split(" The message")[0]
  && MOCK.zh.failHead.endsWith(ctx.STRINGS.zh["eng.failOther"]) && MOCK.en.failHead.endsWith(ctx.STRINGS.en["eng.failOther"]));
ok("① 舊的三行灰字與「約一分鐘」那句都拿掉了", !["engine.workspace", "engine.deps", "engine.preparing"].some((k) => k in ctx.STRINGS.zh || k in ctx.STRINGS.en)
  && !Object.values(ctx.STRINGS.zh).some((v) => /準備引擎/.test(v)) && !Object.values(ctx.STRINGS.en).some((v) => /Preparing the engine/.test(v)));
ok("① 更新後補裝不寫死「約 8 MB」", !/8 MB/.test(read(path.join(R, "strings.js"))) && !/sizeUpd/.test(src));

// ── ② 純邏輯 ──
const a = src.indexOf("/* ── 純邏輯(engView"), b = src.indexOf("/* ── 純邏輯到此");
if (a < 0 || b < 0) throw new Error("找不到純邏輯區塊的標記");
const block = src.slice(a, b);
ok("② 純邏輯區塊不碰 DOM", !/\bdocument\b|\$\(|window\./.test(block.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")));
// 跑在沒有 t / fmtDur / DOM 的 context:字一律經參數 tr 拿,偷用全域的會直接拋
const P = {}; vm.createContext(P); vm.runInContext(block.replace(/^const /gm, "var "), P);
const fmtDur = (sec) => { sec = Math.max(0, Math.floor(Number(sec) || 0)); if (sec < 60) return sec + "s"; if (sec < 3600) return Math.floor(sec / 60) + "m " + String(sec % 60).padStart(2, "0") + "s"; return Math.floor(sec / 3600) + "h " + String(Math.floor(sec / 60) % 60).padStart(2, "0") + "m"; };
const TR = { t: (k, v) => ctx.t(k, v), dur: fmtDur };
const T0 = 1000000;
const snap = (o) => Object.assign({ phase: "run", kind: "first", show: true, sizeMB: 200, acc: 0, t0: T0, tEnd: null, err: null,
  steps: [{ k: "ws", st: "done", ms: 400, t0: null }, { k: "engine", st: "done", ms: 70000, t0: null }, { k: "pkgs", st: "run", ms: 0, t0: T0 + 70400 }],
  cur: { step: "pkgs", sub: null, i: 3, n: 7, name: "matplotlib", t0: T0 + 90000, limitMs: 2700000, idleMs: 120000 },
  dl: { done: 120e6, file: { bytes: 4.2e6, total: 9.3e6 }, installing: false, lastByteAt: T0 + 95000 } }, o || {});
const V = (s, now, held) => P.engView(s, now, TR, held);
for (const lg of ["zh", "en"]) {
  ctx.setLang(lg); const t = (k, v) => ctx.t(k, v);
  const v = V(snap(), T0 + 96000);
  ok("② " + lg + " 進行中:標題、經過時間(只有這一個時間)、大小那句帶實測值", v.title === t("eng.head") && v.time === "1m 36s" && v.sub === t("eng.size", { size: "200 MB" }), v);
  ok("② " + lg + " 三列:做完的兩列有時間、正在跑的那列在跑", v.rows.map((r) => r.k + ":" + r.st + ":" + r.time).join() === "ws:done:0s,engine:done:1m 10s,pkgs:run:25s", v.rows);
  ok("② " + lg + " 第 3 / 7 個:名字分開給(畫成等寬字)", v.rows[2].dt.pre + v.rows[2].dt.mono + v.rows[2].dt.post === t("eng.nth", { i: 3, n: 7, name: "matplotlib" }) && v.rows[2].dt.mono === "matplotlib");
  ok("② " + lg + " 下載量那一行:這個檔 a / b MB、已下載總量;沒有總百分比、沒有速度、沒有預估時間",
    v.rows[2].meta.left === t("eng.bytes", { a: "4.2", b: "9.3" }) && v.rows[2].meta.right === t("eng.dlTotal", { x: "124.2" }) && !/%|MB\/s|剩|\bleft\b|ETA|預估/i.test(JSON.stringify([v.title, v.sub, v.time, v.rows.map((r) => [r.time, r.meta && r.meta.left, r.meta && r.meta.right])])), v.rows[2].meta);
  ok("② " + lg + " 分段條一段一步;套件那段 = 前面裝完的 2 / 7", v.segs.length === 3 && v.segs[0] === 1 && v.segs[1] === 1 && Math.abs(v.segs[2] - 2 / 7) < 1e-9, v.segs);
  ok("② " + lg + " 讀屏句 = 步驟+第 n 個(步驟換了、第 n 個換了才會變)", v.say === t("eng.pkgs") + " " + t("eng.nth", { i: 3, n: 7, name: "matplotlib" }));
  ok("② " + lg + " 平常沒有訊息槽", v.slot === null);
  const st = V(snap(), T0 + 95000 + 15000);
  ok("② " + lg + " 15s 沒收到資料:講秒數,{limit} = 多久沒資料就停(2 分鐘,稽核 0.1.12 P1-2)", st.slot && st.slot.kind === "stall" && st.slot.text === t("eng.stall", { s: "15s", limit: t("eng.min", { m: 2 }) }), st.slot);
  ok("② " + lg + " 14s 還不講", V(snap(), T0 + 95000 + 14000).slot === null);
  const slow = V(snap({ dl: { done: 0, file: null, installing: true, lastByteAt: T0 } }), T0 + 90000 + 45000);
  ok("② " + lg + " 下載完、還在安裝超過 45s:左格「正在安裝」(不再兩格都講已下載)、慢訊息講安裝程式還在跑", slow.slot && slow.slot.kind === "slow" && slow.slot.text === t("eng.slowInst", { limit: t("eng.min", { m: 45 }) }) && slow.rows[2].meta.left === t("eng.installing") && slow.rows[2].meta.right === t("eng.dlTotal", { x: "0.0" }), slow);
  const slowDl = V(snap({ cur: { step: "pkgs", sub: null, i: 3, n: 7, name: "matplotlib", t0: T0, limitMs: 600000 }, dl: { done: 0, file: { bytes: 1e6, total: 9e6 }, installing: false, lastByteAt: T0 + 49000 } }), T0 + 50000);
  ok("② " + lg + " 還在下載(有資料進來)超過 45s:講「網路慢時會久一點」", slowDl.slot && slowDl.slot.text === t("eng.slow", { limit: t("eng.min", { m: 10 }) }), slowDl.slot);
  const venv = V(snap({ steps: [{ k: "ws", st: "done", ms: 400, t0: null }, { k: "engine", st: "run", ms: 0, t0: T0 }, { k: "pkgs", st: "wait", ms: 0, t0: null }], cur: { step: "engine", sub: "venv", i: 0, n: 0, name: null, t0: T0, limitMs: 300000 }, dl: { done: 0, file: null, installing: false, lastByteAt: T0 } }), T0 + 3000);
  ok("② " + lg + " 引擎那一步先寫「建立 Python 環境」、還沒下載不出下載量、等待的那步沒有時間", venv.rows[1].dt.pre === t("eng.venv") && venv.rows[1].meta === null && venv.rows[2].time === "" && venv.segs.join() === "1,0,0", venv.rows);
  // 失敗
  const failS = snap({ phase: "fail", tEnd: T0 + 200000, steps: [{ k: "ws", st: "done", ms: 400, t0: null }, { k: "engine", st: "done", ms: 70000, t0: null }, { k: "pkgs", st: "err", ms: 129600, t0: null }],
    cur: { step: "pkgs", sub: null, i: 4, n: 7, name: "pyarrow", t0: T0, limitMs: 600000 }, dl: { done: 120e6, file: null, installing: false, lastByteAt: T0 },
    err: { kind: "net", msg: "ERROR: Exception:", step: "pkgs", name: "pyarrow", limitMs: 600000 } });
  const f1 = V(failS, T0 + 999999, true), f0 = V(failS, T0 + 999999, false);
  ok("② " + lg + " 失敗:標題換成還沒準備好、大小那句收掉、時間停在失敗那一刻", f1.title === t("eng.headFail") && f1.sub === null && f1.time === "3m 20s", f1);
  ok("② " + lg + " 失敗(網路):講停在哪個套件、重試從那裡接、有一句在等 → 裝好送出那句", f1.slot.kind === "fault" && f1.slot.head === t("eng.failNet", { name: "pyarrow" }) && f1.slot.sub === t("eng.failSub", { name: "pyarrow" }) && f1.slot.err === "ERROR: Exception:", f1.slot);
  ok("② " + lg + " 失敗(背景、沒有一句在等):不講「送出上面那句」", f0.slot.sub === t("eng.failSubIdle", { name: "pyarrow" }));
  ok("② " + lg + " 失敗那一列是 err、仍寫第 4 / 7 個;讀屏念失敗那句", f1.rows[2].st === "err" && f1.rows[2].dt.mono === "pyarrow" && f1.say === f1.slot.head && f1.rows[2].meta === null);
  const fo = V(Object.assign({}, failS, { err: { kind: "other", msg: "ERROR: No matching distribution found for pyarrow==25.0.1", step: "pkgs", name: "pyarrow", limitMs: 600000 } }), T0, false);
  ok("② " + lg + " 失敗(說不出原因):只寫「沒有裝完。」", fo.slot.head === t("eng.failOther"));
  const to = V(Object.assign({}, failS, { err: { kind: "timeout", msg: "timed out after 600s", step: "pkgs", name: "pyarrow", limitMs: 600000 } }), T0, true);
  ok("② " + lg + " 超時:主詞是卡住的那一個(每條 pip 各自計時)、{limit} = 實際上限、重試從那個套件接", to.slot.head === t("eng.toHead", { name: "pyarrow", limit: t("eng.min", { m: 10 }) }) && to.slot.sub === t("eng.toSub", { name: "pyarrow" }), to.slot);
  const toV = V(Object.assign({}, failS, { steps: [{ k: "engine", st: "err", ms: 300000, t0: null }], cur: { step: "engine", sub: "venv", i: 0, n: 0, name: null }, err: { kind: "timeout", msg: "timed out after 300s", step: "engine", name: null, limitMs: 300000 } }), T0, false);
  ok("② " + lg + " 卡在建 venv 超時:用 toHeadVenv、5 分鐘;副句是 venvSub(不是「可能是網路太慢」)", toV.slot.head === t("eng.toHeadVenv", { limit: t("eng.min", { m: 5 }) }) && toV.slot.sub === t("eng.venvSub"), toV.slot);
  const fv = V(Object.assign({}, failS, { steps: [{ k: "ws", st: "done", ms: 1, t0: null }, { k: "engine", st: "err", ms: 9, t0: null }, { k: "pkgs", st: "wait", ms: 0, t0: null }], cur: { step: "engine", sub: "venv", i: 0, n: 0, name: null }, err: { kind: "other", msg: "x", step: "engine", name: null } }), T0, false);
  ok("② " + lg + " 建 venv 就失敗(引擎那步、沒有套件名):副句換成 venvSub(不講網路、不講從哪個套件接)", fv.slot.sub === t("eng.venvSub") && fv.slot.head === t("eng.failOther"), fv.slot);
  ok("② " + lg + " …有一句在等時用 venvSubHeld", V(Object.assign({}, failS, { steps: [{ k: "engine", st: "err", ms: 9, t0: null }], cur: { step: "engine", sub: "venv", i: 0, n: 0, name: null }, err: { kind: "other", msg: "x", step: "engine", name: null } }), T0, true).slot.sub === t("eng.venvSubHeld"));
  ok("② " + lg + " 引擎那步但有名字(SDK 斷線):照舊講從 claude-agent-sdk 接著裝", V(Object.assign({}, failS, { steps: [{ k: "engine", st: "err", ms: 9, t0: null }], cur: { step: "engine", sub: null, i: 0, n: 0, name: "claude-agent-sdk" }, err: { kind: "net", msg: "x", step: "engine", name: "claude-agent-sdk" } }), T0, false).slot.sub === t("eng.failSubIdle", { name: "claude-agent-sdk" }));
  const up = V(snap({ kind: "update", sizeMB: null, steps: [{ k: "engine", st: "run", ms: 0, t0: T0 }], cur: { step: "engine", sub: null, i: 0, n: 0, name: "claude-agent-sdk", t0: T0, limitMs: 600000 }, dl: { done: 0, file: { bytes: 3e6, total: 92.9e6 }, installing: false, lastByteAt: T0 + 2000 } }), T0 + 3000);
  ok("② " + lg + " 更新後補裝(步驟有引擎):標題「更新了引擎」、不寫大小、只有一步就不畫分段條、引擎那列也有下載量", up.title === t("eng.headUpd") && up.sub === null && up.segs === null && up.rows.length === 1 && up.rows[0].meta.left === t("eng.bytes", { a: "3.0", b: "92.9" }), up);
  const up17 = V(snap({ kind: "update", sizeMB: null, steps: [{ k: "pkgs", st: "run", ms: 0, t0: T0 }], cur: { step: "pkgs", sub: null, i: 8, n: 17, name: "curl_cffi", t0: T0, limitMs: 600000 }, dl: { done: 0, file: { bytes: 1.1e6, total: 3.2e6 }, installing: false, lastByteAt: T0 + 2000 } }), T0 + 3000);
  ok("② " + lg + " 更新後只補套件(7 → 17):標題是「更新了策略套件」、第 8 / 17 個、分段條一段且前 7 個是滿的、下載量只算這次的", up17.title === t("eng.headUpdPkgs") && up17.sub === null && up17.rows[0].dt.pre + up17.rows[0].dt.mono + up17.rows[0].dt.post === t("eng.nth", { i: 8, n: 17, name: "curl_cffi" })
    && up17.segs && up17.segs.length === 1 && Math.abs(up17.segs[0] - 7 / 17) < 1e-9 && up17.rows[0].meta.left === t("eng.bytes", { a: "1.1", b: "3.2" }) && up17.rows[0].meta.right === t("eng.dlTotal", { x: "1.1" }), up17);
  ok("② " + lg + " 完成:不出卡;完成那一行帶總時間(含重試前的)", V(snap({ phase: "done", tEnd: T0 + 252000 }), T0) === null && P.engReadyText({ acc: 60000, t0: T0, tEnd: T0 + 192000 }, TR) === t("eng.ready", { t: "4m 12s" }));
  ok("② " + lg + " 只修 venv 連結(show=false)/ idle:不出卡", V(snap({ show: false }), T0) === null && V({ phase: "idle" }, T0) === null);
  ok("② " + lg + " 重試後經過時間接著算(acc)", V(snap({ acc: 200000 }), T0 + 1000).time === "3m 21s");
}

// ── ③ 接線 ──
const cut = (s, head) => { const i = s.indexOf(head); if (i < 0) throw new Error("no " + head); let d = 0; for (let k = s.indexOf("{", i); k < s.length; k++) { if (s[k] === "{") d++; else if (s[k] === "}" && --d === 0) return s.slice(i, k + 1); } throw new Error("unbalanced " + head); };
const submit = cut(appSrc, "async function submitMessage("), stop = cut(appSrc, "async function stopTurn(");
ok("③ preload:拉快照 + 聽快照;舊的 engine-progress 字串 key 不在了", /engineState: \(\) => ipcRenderer\.invoke\("engine-state"\)/.test(pre) && /onEngineState: \(fn\) => ipcRenderer\.on\("engine-state", \(_e, s\) => fn\(s\)\)/.test(pre) && !/engine-progress/.test(pre + mainSrc + appSrc));
ok("③ main:快照整份推給我們的頁、也可以拉", /handle\("engine-state", \(\) => engineSetup\(\)\.snapshot\(\)\)/.test(mainSrc) && /webContents\.send\("engine-state", s\)/.test(mainSrc));
ok("③ C 的時機:開 app 就在背景裝——在 workspace 同步之後、只有拿到單一實例鎖的那一份、不擋常駐程式起來",
  /if \(app\.hasSingleInstanceLock\(\)\) startStep\("workspace sync", syncOfficialOnUpdate\);\s*startStep\("trade host", tradeStartIfReady\);[^\n]*\n\s*if \(app\.hasSingleInstanceLock\(\)\) startStep\("engine", engineKick\);/.test(mainSrc)
  && /function engineKick\(\) \{\s*ensureEngineShared\(\)\.then\(\(\) => tradeStartIfReady\(\), /.test(mainSrc));
ok("③ C:送第一句話時接上同一份(ensure-engine 走 ensureEngineShared,不另起一份)", /handle\("ensure-engine", \(\) => ensureEngineShared\(\)\.then\(\(r\) => \{ tradeStartIfReady\(\); return r; \}\)\);/.test(mainSrc));
ok("③ C:工作頁一打開就跟主行程對一次快照(背景安裝可能早就開始了);engine.js 載入時也對一次(開場 IPC 可能比它先走完)",
  /engSync\(\)/.test(cut(appSrc, "function enterWorkspace(")) && /window\.blave\.engineState\(\)/.test(src) && /\nengSync\(\);\n/.test(src));
ok("③ 舊的灰字進度不在了(onEngineProgress / addMsg(\"sys\", t(key)))", !/onEngineProgress/.test(appSrc + src) && !/addMsg\("sys", t\(key\)\)/.test(appSrc));
ok("③ 安裝中送出:卡移到那句底下(泡泡 → 卡)", /engAfter\(bubble\)/.test(submit));
ok("③ 失敗:泡泡留著(engHold)、不收回輸入框;卡上沒畫出來(只修 venv)才退回失敗卡", /engHold\(msg, opts, bubble\); unlock\(\); return false;/.test(submit) && /faultCard\(\)\.set\(\{ text: t\("turn\.engineFailed"/.test(submit));
ok("③ 重試:同一個泡泡、同一句話再走一次 submitMessage(裝好就送出)", /submitMessage\(h\.msg, Object\.assign\(\{\}, h\.opts, \{ bubble: h\.bubble \}\)\)/.test(src) && /opts && opts\.bubble && opts\.bubble\.isConnected \? opts\.bubble : addMsg\("you", msg\)/.test(submit));
ok("③ 換送別句:等著的那句收掉(留著會像已經送出)", /engDropHeld\(\)/.test(submit));
ok("③ 安裝中按停止:這句不送、放回輸入框、安裝照跑——停止那條路完全不碰卡", /if \(engineWait && engineAbort\)/.test(stop) && !/ENG\b|eng[A-Z]\w*\(/.test(stop) && /engineAbort = \(\) => \{ unlock\(\); unsend\(\); \};/.test(submit));
ok("③ 卡的去留只看快照:engPaint 只有在 done 才收(停止 / 失敗都不收)", /if \(ENG\.card && s\.phase === "done"\) engDone\(s\);/.test(src) && (src.match(/ENG\.card = null/g) || []).length === 1);
{ const w = cut(src, "function engWarn(");
  ok("③ 美股那組沒裝好(快照 done + warn):卡照樣收、換成完成那一行,再出一張失敗卡講美股功能暫時不能用(錯誤訊息可展開、沒有重試鈕)、一次啟動只講一次",
    /if \(s\.warn\) engWarn\(s\);/.test(cut(src, "function engDone(")) && /else if \(s\.phase === "done" && s\.warn\) engWarn\(s\);/.test(src)
    && /faultCard\(\)\.set\(\{ calm: true, text: t\("eng\.optFail"\), sub \}\)/.test(w) && /if \(ENG\.warned \|\| !s\.warn\) return;\s*ENG\.warned = true;/.test(w) && !/label|retry/.test(w));
  ok("③ 美股那組的字 zh / en 都有、不寫死套件名與版本", ["zh", "en"].every((lg) => ctx.STRINGS[lg]["eng.optFail"] && !/yfinance|==/.test(ctx.STRINGS[lg]["eng.optFail"]))); }
ok("③ 換對話 / 開新對話清掉聊天欄後補回安裝卡(fail 沒有每秒重畫,不補就連重試鈕一起不見):csClearChat 最後、csOpen 畫完舊回合之後",
  /engReattach\(\);[^\n]*\n\}/.test(cut(appSrc, "function csClearChat(")) && /addHistoryAi\(x\.turn\.content\)\)\);\n\s*\$\("chat-eg"\)\.hidden = true;\n\s*if \(typeof engReattach === "function"\) engReattach\(\);/.test(cut(appSrc, "async function csOpen("))
  && /function engReattach\(\) \{ if \(ENG\.card\) ENG\.card\.remove\(\); engPaint\(\); \}/.test(src));
ok("③ index.html:engine.css 有載、engine.js 在 app.js 之後", /<link rel="stylesheet" href="engine\.css">/.test(html) && html.indexOf('src="engine.js"') > html.indexOf('src="app.js"'));
ok("③ reduced-motion:app.css 那條 `* { animation:none !important }` 之外,這張卡的轉圈照轉", /@media \(prefers-reduced-motion: reduce\) \{ \.eng-card \.spin16 \{ animation: trSpin 1s linear infinite !important; \} \}/.test(css) && /\* \{ transition: none !important; animation: none !important; \}/.test(read(path.join(R, "app.css"))));
ok("③ 顏色只用 token(不寫死 hex、不寫死毫秒)", !/#[0-9a-fA-F]{3,8}\b/.test(css.replace(/\/\*[\s\S]*?\*\//g, "")) && !/\d+ms\b/.test(css));

// ── ④ 行為:從原文切出 submitMessage / stopTurn / engRetry,配假的 window.blave 實際跑(稽核 0.1.12 T1 / T2:原本只有字串比對)──
(async () => { const vars = /^let turnStopping = [^\n]*\n(?:\/\/[^\n]*\n)?let engineAbort = [^\n]*$/m.exec(appSrc);
  const SUB = cut(appSrc, "async function submitMessage("), STOP = cut(appSrc, "async function stopTurn("), RETRY = cut(src, "function engRetry(");
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const mkRig = () => {
    const log = [], held = [];
    let resolveEngine = null, rejectEngine = null;
    const any = new Proxy(function () {}, { get: (_t, k) => (k === Symbol.toPrimitive ? () => "" : any), set: () => true, apply: () => any });
    const known = {
      window: { blave: {
        ensureEngine: () => { log.push("ensureEngine"); return new Promise((ok, no) => { resolveEngine = ok; rejectEngine = no; }); },
        engineState: async () => ({ phase: "fail", show: true }),
        sendMessage: async (p) => { log.push("send:" + p.message); return { started: true }; },
        stopTurn: async () => { log.push("stopTurn-ipc"); return true; } } },
      addMsg: (cls, text) => { const b = { cls, text, isConnected: true, remove() { this.isConnected = false; log.push("bubble-removed"); } }; log.push("bubble:" + text); return b; },
      stopRestore: (t) => log.push("restore:" + t), trackFeature: (n) => log.push("track:" + n),
      engHold: (msg, opts, bubble) => { held.push({ msg, opts, bubble }); log.push("hold"); }, engAfter: () => {}, engDropHeld: () => {}, engOnState: () => {},
      busyStart: () => log.push("busyStart"), faultCard: () => ({ set: (o) => log.push("fault:" + o.text) }), t: (k) => k,
      sessionId: "s1", MP: { model: null }, mpEffort: () => null, chatViewing: () => ({ env: "local" }), lastUserText: "", csTitle: "x",
      console, Promise, Object, JSON, setTimeout,
    };
    const ctx = new Proxy(known, { has: () => true, get: (o, k) => (k === Symbol.unscopables ? undefined : k in o ? o[k] : k in globalThis ? globalThis[k] : any), set: (o, k, v) => { o[k] = v; return true; } });
    const api = new Function("ctx", "with (ctx) { let running = false;\n" + vars[0] + "\n" + SUB + "\n" + STOP + "\n return { submitMessage, stopTurn, get running() { return running; }, get engineWait() { return engineWait; } }; }")(ctx);
    return { api, log, held, resolve: () => resolveEngine(), reject: (e) => rejectEngine(e) };
  };
  { const r = mkRig(); const p = r.api.submitMessage("hi", { typed: true }); await tick();
    const waiting = r.api.running && r.api.engineWait;
    await r.api.stopTurn(); r.resolve(); const res = await p; await tick();
    ok("④ 安裝中按停止:那句馬上收回並放回輸入框;裝好之後也不會送出(拿掉 engineSeq++ 這裡會紅)", waiting && res === false && !r.log.some((x) => /^send:/.test(x)) && r.log.includes("restore:hi") && r.log.includes("bubble-removed") && !r.log.includes("stopTurn-ipc") && !r.api.running, r.log); }
  { const r = mkRig(); const p = r.api.submitMessage("hi", { typed: true }); await tick(); r.resolve(); await p; await tick();
    ok("④ 沒按停止:裝好就送出那句", r.log.includes("send:hi") && r.log.includes("busyStart"), r.log); }
  { const r = mkRig(); const p = r.api.submitMessage("hi", { typed: true }); await tick(); r.reject(new Error("pip")); const res = await p;
    ok("④ 安裝失敗:泡泡留著(engHold)、不放回輸入框、輸入框解鎖", res === false && r.held.length === 1 && r.held[0].msg === "hi" && !r.log.includes("bubble-removed") && !r.log.some((x) => /^restore:/.test(x)) && !r.api.running, r.log); }
  // engRetry:同一個對話、沒有回合在跑 → 同一個泡泡再送;回合在跑 → 那句留著只重裝;換了對話 → 泡泡收掉只重裝
  const retryRig = (o) => {
    const log = [], bubble = { isConnected: true, remove() { this.isConnected = false; log.push("bubble-removed"); } };
    const ctx = { ENG: { held: { msg: "hi", opts: { typed: true }, bubble, sessionId: "s1" } }, sessionId: o.session || "s1", running: !!o.running,
      trackFeature: (n) => log.push("track:" + n), submitMessage: (m, op) => log.push("submit:" + m + (op.bubble === bubble ? ":same-bubble" : "")),
      window: { blave: { ensureEngine: () => { log.push("ensureEngine"); return Promise.resolve(); } } }, Object };
    new Function("ctx", "with (ctx) { " + RETRY + "\n engRetry(); }")(ctx);
    return { log, ctx };
  };
  { const r = retryRig({}); ok("④ 重試:同一個泡泡再走 submitMessage、送 engine_retry", r.log.join() === "track:engine_retry,submit:hi:same-bubble" && r.ctx.ENG.held === null, r.log); }
  { const r = retryRig({ running: true }); ok("④ 重試時有回合在跑:那句留著(還是等著的那句)、這次只重裝(稽核 0.1.12 P2-6)", r.log.join() === "track:engine_retry,ensureEngine" && r.ctx.ENG.held && r.ctx.ENG.held.msg === "hi", r.log); }
  { const r = retryRig({ session: "s2" }); ok("④ 換了對話再按重試:舊那句不送進新對話、泡泡收掉、只重裝", r.log.join() === "track:engine_retry,bubble-removed,ensureEngine" && r.ctx.ENG.held === null, r.log); }
  process.exit(red ? 1 : 0);
})();
process.on("beforeExit", () => { console.log("FAIL  非同步測試沒有跑到結尾"); process.exit(1); });
