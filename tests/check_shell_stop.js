// 電腦版停止鈕(shell/main.js 的 stopTurn / newTurnStop + renderer/app.js 的 sendBtnSync / stopTurn / stopRestore)。
//   1. 主行程:回合進行中(或正要開始)才寫停止旗標檔、每輪新檔名;runtime 沒收掉時 STOP_KILL_MS 後只殺這一輪的 agent_turn,
//      換了下一輪就不殺;旗標路徑經 BLAVE_TURN_INTERRUPT_FILE 交給 runtime
//   2. 畫面:回合中送出鈕 = 停止鈕(is-stop、aria 停止、可按),按下轉停止中、不先切回送出;沒送到就還原;
//      turn-end 才切回送出,用戶**自己打的**那句接回輸入框(畫面代組的句子不放回);停止不算失敗
// 跑法:node tests/check_shell_stop.js
const fs = require("fs"), os = require("os"), path = require("path");
const SH = path.join(__dirname, "..", "shell");
const mainSrc = fs.readFileSync(path.join(SH, "main.js"), "utf8");
const appSrc = fs.readFileSync(path.join(SH, "renderer", "app.js"), "utf8");
const cutFrom = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); if (i < 0 || j < 0) throw new Error("找不到標記:" + a); return src.slice(i, j); };
let red = 0; const ok = (n, c) => { console.log((c ? "PASS  " : "FAIL  ") + n); if (!c) red++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ── 1. 主行程 ──
  const mainCut = cutFrom(mainSrc, "let turnStopFile = null, turnFinalized = false, turnLastOut = 0;", "/* 本機常駐程式的宿主");
  const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "blave-stop-"));
  const M = new Function("fs", "path", "crypto", "BASE", `
    let activeTurn = null, turnStarting = false;
    ${mainCut.replace("const STOP_KILL_MS = 5000;", "const STOP_KILL_MS = 60;")}
    return { stopTurn, newTurnStop, get file() { return turnStopFile; }, set lastOut(v) { turnLastOut = v; }, set finalized(v) { turnFinalized = v; },
      set active(c) { activeTurn = c; }, set starting(v) { turnStarting = v; } };`)(fs, path, require("crypto"), BASE);
  ok("沒有回合:不寫旗標、回 false", M.stopTurn() === false);
  M.newTurnStop(); const f1 = M.file;
  ok("旗標在 <BASE>/state/turn_stop/ 底下", path.dirname(f1) === path.join(BASE, "state", "turn_stop"));
  let kills = 0; const child = { kill: () => { kills++; } };
  M.starting = true;
  ok("正要開始(還沒 spawn)按停止:旗標寫得下去", M.stopTurn() === true && fs.existsSync(f1));
  await wait(30); M.active = child; M.starting = false;
  await wait(60);
  ok("停止時還沒 spawn:保險不在 spawn 後馬上下手", kills === 0);
  await wait(80);
  ok("…spawn 後再等一段還沒收掉才殺", kills === 1);
  kills = 0;
  ok("回合進行中:回 true", M.stopTurn() === true);
  await wait(120);
  ok("runtime 沒收掉:STOP_KILL_MS 後殺 agent_turn(保險)", kills >= 1);
  kills = 0; M.stopTurn(); M.newTurnStop(); const f2 = M.file;
  await wait(120);
  ok("同一段時間裡換成下一輪了:不殺新那一輪", kills === 0);
  ok("換下一輪:舊旗標刪掉、新檔名不同", !fs.existsSync(f1) && f2 !== f1);
  // runtime 在等平倉腳本(Codex 持住引擎)時每秒送 ping:還在說話就不殺,沉默了才殺
  kills = 0; M.active = child; M.stopTurn();
  const talk = setInterval(() => { M.lastOut = Date.now(); }, 20);
  await wait(200);
  ok("agent_turn 還在送東西(等平倉腳本):保險不殺", kills === 0);
  clearInterval(talk); await wait(200);
  ok("…沉默滿 STOP_KILL_MS 才殺", kills === 1);
  kills = 0; M.newTurnStop(); M.stopTurn(); M.finalized = true; await wait(200);
  ok("收到 done 之後(寫歷史、壓縮摘要)不殺", kills === 0);
  ok("接線:stdout 每一段都記時間;done 那則記下已收尾", /child\.stdout\.on\("data", \(d\) => \{\n\s*turnLastOut = Date\.now\(\);/.test(mainSrc)
    && /if \(c && c\.type === "done"\) turnFinalized = true;/.test(mainSrc) && /turnFinalized = false;\n\}/.test(mainSrc));
  ok("旗標路徑經環境變數交給 runtime(不上 argv)", /\.\.\.\(turnStopFile \? \{ BLAVE_TURN_INTERRUPT_FILE: turnStopFile \} : \{\}\),/.test(mainSrc));
  ok("送出時先換新旗標(turnStarting 立起之後、任何 await 之前)", /turnStarting = true;\n\s*newTurnStop\(\);\n/.test(mainSrc));
  ok("stop-turn IPC 只收自家頁面(走 handle)", /handle\("stop-turn", \(\) => stopTurn\(\), false\);/.test(mainSrc));
  ok("preload 暴露 stopTurn", /stopTurn: \(\) => ipcRenderer\.invoke\("stop-turn"\)/.test(fs.readFileSync(path.join(SH, "preload.js"), "utf8")));
  ok("runtime 那半在:agent_turn 起 turn_stop 的 watcher", /stop_watch = turn_stop\.start\(sink, hold_engine=use_codex\)/.test(fs.readFileSync(path.join(SH, "..", "runtime", "agent_turn.py"), "utf8")));

  // ── 2. 畫面 ──
  const rCut = cutFrom(appSrc, "let turnStopping = false, turnStopped = false, engineWait = false, lastUserTyped = false;", "async function sendDraft() {");
  const mkEl = () => { const cls = new Set(), attr = {}; return { cls, attr, dataset: {}, disabled: true, value: "", focused: false,
    classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)) }, setAttribute: (k, v) => { attr[k] = v; }, focus() { this.focused = true; } }; };
  const els = { "btn-send": mkEl(), ta: mkEl() };
  const tracked = []; let stopReply = true; const calls = [];
  const R = new Function("$", "t", "trackFeature", "autosize", "window", "state", `
    let running = false;
    ${rCut}
    return { sendBtnSync, stopTurn, stopRestore, set running(v) { running = v; }, get stopping() { return turnStopping; },
      get stopped() { return turnStopped; }, set engineWait(v) { engineWait = v; } };`)(
    (id) => els[id], (k) => ({ "ws.stop": "停止", "ws.send": "送出" })[k], (n) => tracked.push(n), () => {},
    { blave: { stopTurn: async () => { calls.push("stop"); return stopReply; } } });
  const b = els["btn-send"];
  R.running = true; R.sendBtnSync();
  ok("回合中:送出鈕換成停止鈕(is-stop)、aria=停止、可按", b.cls.has("is-stop") && b.attr["aria-label"] === "停止" && b.dataset.i18nAria === "ws.stop" && b.disabled === false);
  await R.stopTurn();
  ok("按停止:請主行程停、記 chat_stop", calls.length === 1 && tracked.join() === "chat_stop");
  ok("…轉停止中(變淡),仍是停止鈕——不先切回送出", b.cls.has("is-stopping") && b.cls.has("is-stop"));
  await R.stopTurn();
  ok("停止中再按:不重送", calls.length === 1);
  R.running = false; R.sendBtnSync();
  ok("回合結束:回到送出鈕、aria=送出", !b.cls.has("is-stop") && !b.cls.has("is-stopping") && b.attr["aria-label"] === "送出");
  // 沒送到(主行程沒有回合)→ 還原,讓用戶再按
  const R2 = new Function("$", "t", "trackFeature", "autosize", "window", `let running = true; ${rCut} return { stopTurn, get stopping() { return turnStopping; }, get stopped() { return turnStopped; } };`)(
    (id) => els[id], (k) => k, () => {}, () => {}, { blave: { stopTurn: async () => false } });
  await R2.stopTurn();
  ok("主行程回 false:停止中還原,可以再按", R2.stopping === false && R2.stopped === false);
  // 暖機中(主行程還沒有回合):不還原,submitMessage 暖機完看到 turnStopped 就不送
  const R3 = new Function("$", "t", "trackFeature", "autosize", "window", `let running = true; ${rCut} engineWait = true; return { stopTurn, get stopped() { return turnStopped; } };`)(
    (id) => els[id], (k) => k, () => {}, () => {}, { blave: { stopTurn: async () => false } });
  await R3.stopTurn();
  ok("暖機中按停止:記住要停", R3.stopped === true);
  ok("…submitMessage 暖機完就收掉、原句放回", /if \(turnStopped\) \{ turnStopped = false; unlock\(\); bubble\.remove\(\); if \(lastUserTyped\) stopRestore\(msg\); return false; \}/.test(appSrc));
  els.ta.value = ""; R.stopRestore("幫我跑 BTC 回側");
  ok("停下後原句放回空的輸入框", els.ta.value === "幫我跑 BTC 回側" && els.ta.focused);
  els.ta.value = "改成 ETH"; R.stopRestore("幫我跑 BTC 回側");
  ok("輸入框已經有字:原句接在前面、不覆寫(同雲端 csJoinDraft)", els.ta.value === "幫我跑 BTC 回側\n改成 ETH");
  ok("按鈕分流:回合中按 = 停止,閒著按 = 送出", /\$\("btn-send"\)\.addEventListener\("click", \(\) => \(running \? stopTurn\(\) : sendDraft\(\)\)\);/.test(appSrc));
  const endCut = cutFrom(appSrc, "window.blave.onTurnEnd(async (r) => {", "/* 側欄 / 聊天欄");
  ok("turn-end:停止不算失敗(不問登入、不攤收據、保險殺掉的結束碼不顯示)", /const stopped = turnStopped; turnStopped = false;/.test(endCut)
    && /const exitLine = r\.code !== 0 && !stopped/.test(endCut) && /if \(!stopped && \(cur === "claude"/.test(endCut) && /const faulted = !stopped && \(/.test(endCut));
  ok("turn-end:切回送出鈕、原句放回", /turnStopping = false; sendBtnSync\(\);/.test(endCut) && /if \(stopped && lastUserTyped\) \{/.test(endCut) && /stopRestore\(lastUserText\);/.test(endCut));
  // 只放回用戶自己打的:把 submitMessage 裡算來源的那一行切出來跑
  const typedLine = /addMsg\("you", msg\); (lastUserTyped = [^;]+;) lastUserText = msg;/.exec(appSrc);
  ok("來源那一行在 submitMessage 裡", !!typedLine);
  const origin = (seq) => { let lastUserTyped = false, lastUserText = "";
    return seq.map(([msg, opts]) => { eval(typedLine[1]); lastUserText = msg; return lastUserTyped; }); };
  ok("手打的放回;送上雲端 / 策略庫 / 報告這些代組的句子不放回", JSON.stringify(origin([["嗨", { typed: true }], ["把策略送上雲端", { handoff: "up" }], ["用這支策略", undefined]])) === "[true,false,false]");
  ok("重送同一句:沿用原句的來源(手打的重送仍放回,代組的重送仍不放回)", JSON.stringify(origin([["嗨", { typed: true }], ["嗨", undefined], ["掃描參數", undefined], ["掃描參數", undefined]])) === "[true,true,false,false]");
  ok("輸入框送出帶 typed(只有這一個呼叫點帶)", /\$\("ta"\)\.value = ""; autosize\(\);\n\s*submitMessage\(msg, \{ typed: true \}\);/.test(appSrc)
    && ["handoff.js", "library.js", "reports.js", "newstrategy.js"].every((f) => !/typed: true/.test(fs.readFileSync(path.join(SH, "renderer", f), "utf8")))
    && (appSrc.match(/typed: true/g) || []).length === 1);
  const html = fs.readFileSync(path.join(SH, "renderer", "index.html"), "utf8"), css = fs.readFileSync(path.join(SH, "renderer", "app.css"), "utf8");
  ok("鈕裡兩個圖示:箭頭與方塊(同雲端 workspace.html)", /id="btn-send"[^>]*><span class="icon-send" aria-hidden="true">↑<\/span><svg class="icon-stop"[^>]*aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1\.5" fill="currentColor"\/><\/svg><\/button>/.test(html));
  ok("CSS:方塊平時藏、is-stop 換圖示、停止中 .55", /\.btn-send \.icon-stop \{ display: none; \}/.test(css) && /\.btn-send\.is-stop \.icon-send \{ display: none; \}/.test(css)
    && /\.btn-send\.is-stop \.icon-stop \{ display: block; \}/.test(css) && /\.btn-send\.is-stopping \{ opacity: \.55; \}/.test(css));
  const strings = fs.readFileSync(path.join(SH, "renderer", "strings.js"), "utf8");
  ok("字串:ws.stop 兩語都有(po2js 產物)", /"ws\.stop": "Stop"/.test(strings) && /"ws\.stop": "停止"/.test(strings));
  fs.rmSync(BASE, { recursive: true, force: true });
  console.log(red ? `\n${red} FAILED` : "\nALL PASS");
  process.exit(red ? 1 : 0);
})();
