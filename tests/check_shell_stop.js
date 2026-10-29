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
  // ── 1. 主行程(0.1.37 起每一輪一筆 rec:停止檔、輸出時間、子行程都在 rec 裡,stopTurn(sid) 只動那一筆) ──
  const mainCut = cutFrom(mainSrc, "const STOP_KILL_MS = 5000;", "/* 本機常駐程式的宿主");
  const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "blave-stop-"));
  const M = new Function("fs", "path", "crypto", "BASE", `
    const turns = new Map(); const dequeued = []; let turnSeqN = 0;
    function turnDequeue(rec) { dequeued.push(rec.sid); turns.delete(rec.sid); return true; }
    ${mainCut.replace("const STOP_KILL_MS = 5000;", "const STOP_KILL_MS = 60;")}
    return { stopTurn, newTurnRec, turns, dequeued };`)(fs, path, require("crypto"), BASE);
  const A = "desktop-aaaa1111", Bs = "desktop-bbbb2222";
  ok("沒有回合:不寫旗標、回 false", M.stopTurn(A) === false && M.stopTurn() === false);
  const r1 = M.newTurnRec(A, "desktop", false); M.turns.set(A, r1);
  ok("旗標在 <BASE>/state/turn_stop/ 底下、每一輪各自一個檔名", path.dirname(r1.stopFile) === path.join(BASE, "state", "turn_stop") && M.newTurnRec(A).stopFile !== r1.stopFile);
  let kills = 0; const child = { kill: () => { kills++; } };
  ok("正要開始(還沒 spawn)按停止:旗標寫得下去", M.stopTurn(A) === true && fs.existsSync(r1.stopFile));
  await wait(30); r1.child = child; r1.phase = "running";
  await wait(60);
  ok("停止時還沒 spawn:保險不在 spawn 後馬上下手", kills === 0);
  await wait(80);
  ok("…spawn 後再等一段還沒收掉才殺", kills === 1);
  kills = 0;
  ok("回合進行中:回 true", M.stopTurn(A) === true);
  await wait(120);
  ok("runtime 沒收掉:STOP_KILL_MS 後殺 agent_turn(保險)", kills >= 1);
  kills = 0; M.stopTurn(A); M.turns.delete(A); const r2 = M.newTurnRec(A, "desktop", false); M.turns.set(A, r2); r2.child = child;
  await wait(120);
  ok("同一段時間裡換成下一輪了:不殺新那一輪", kills === 0);
  // runtime 在等平倉腳本(Codex 持住引擎)時每秒送 ping:還在說話就不殺,沉默了才殺
  kills = 0; M.stopTurn(A);
  const talk = setInterval(() => { r2.lastOut = Date.now(); }, 20);
  await wait(200);
  ok("agent_turn 還在送東西(等平倉腳本):保險不殺", kills === 0);
  clearInterval(talk); await wait(200);
  ok("…沉默滿 STOP_KILL_MS 才殺", kills === 1);
  kills = 0; M.turns.delete(A); const r3 = M.newTurnRec(A, "desktop", false); M.turns.set(A, r3); r3.child = child; M.stopTurn(A); r3.finalized = true; await wait(200);
  ok("收到 done 之後(寫歷史、壓縮摘要)不殺", kills === 0);
  // 兩條並行:A 的保險只看 A 自己的輸出時間與子行程(看全域會照 B 的時間殺錯)
  M.turns.clear(); let ka = 0, kb = 0;
  const ra = M.newTurnRec(A, "desktop", false), rb = M.newTurnRec(Bs, "desktop", false);
  ra.child = { kill: () => { ka++; } }; rb.child = { kill: () => { kb++; } }; M.turns.set(A, ra); M.turns.set(Bs, rb);
  const talkB = setInterval(() => { rb.lastOut = Date.now(); }, 20);
  M.stopTurn(A); await wait(200); clearInterval(talkB);
  ok("並行:停 A 只寫 A 的旗標、B 一直在說話也不救 A、B 不被殺", ka === 1 && kb === 0 && fs.existsSync(ra.stopFile) && !fs.existsSync(rb.stopFile));
  ok("並行:沒帶 sid 而且有兩條在跑:不猜、回 false", M.stopTurn() === false);
  M.turns.delete(A);
  ok("沒帶 sid、只剩一條:停那一條(畫面還是單分頁那一版)", M.stopTurn() === true && fs.existsSync(rb.stopFile));
  M.turns.clear(); const rq = M.newTurnRec(A, "desktop", true); rq.phase = "queued"; M.turns.set(A, rq);
  ok("排隊中的停止 = 取消排隊(不寫旗標)", M.stopTurn(A) === true && M.dequeued.join() === A && !fs.existsSync(rq.stopFile));
  ok("接線:stdout 每一段記這一輪的時間;done 那則記下這一輪已收尾", /child\.stdout\.on\("data", \(d\) => \{\n\s*rec\.lastOut = Date\.now\(\);/.test(mainSrc)
    && /if \(c && c\.type === "done"\) \{ rec\.finalized = true;/.test(mainSrc));
  ok("旗標路徑經環境變數交給 runtime(不上 argv)", /BLAVE_TURN_INTERRUPT_FILE: rec\.stopFile,/.test(mainSrc));
  ok("stop-turn IPC 只收自家頁面(走 handle)、帶 sid", /handle\("stop-turn", \(_e, sid\) => stopTurn\(typeof sid === "string" \? sid : null\), false\);/.test(mainSrc));
  ok("preload 暴露 stopTurn(sid 可不帶)", /stopTurn: \(sid\) => ipcRenderer\.invoke\("stop-turn", typeof sid === "string" \? sid : null\)/.test(fs.readFileSync(path.join(SH, "preload.js"), "utf8")));
  ok("runtime 那半在:agent_turn 起 turn_stop 的 watcher", /stop_watch = turn_stop\.start\(sink, hold_engine=use_codex\)/.test(fs.readFileSync(path.join(SH, "..", "runtime", "agent_turn.py"), "utf8")));

  // ── 2. 畫面 ──
  const rCut = cutFrom(appSrc, "let turnStopping = false, turnStopped = false, engineWait = false, lastUserTyped = false;", "async function sendDraft() {");
  const mkEl = () => { const cls = new Set(), attr = {}; return { cls, attr, dataset: {}, disabled: true, value: "", focused: false,
    classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)) }, setAttribute: (k, v) => { attr[k] = v; }, removeAttribute: (k) => { delete attr[k]; }, focus() { this.focused = true; } }; };
  const els = { "btn-send": mkEl(), ta: mkEl(), "ta-wait": Object.assign(mkEl(), { textContent: "上一輪還在跑" }) };
  const tracked = []; let stopReply = true; const calls = [], stopSids = [];
  const R = new Function("$", "t", "trackFeature", "autosize", "window", "state", `
    let running = false;
    var CS = { loaded: null }, sessionId = "desktop-stop0001"; const withTab = (T, fn) => fn(); const tabBg = () => false;
    ${rCut}
    return { sendBtnSync, stopTurn, stopRestore, set running(v) { running = v; }, get stopping() { return turnStopping; },
      get stopped() { return turnStopped; }, set engineWait(v) { engineWait = v; } };`)(
    (id) => els[id], (k) => ({ "ws.stop": "停止", "ws.send": "送出" })[k], (n) => tracked.push(n), () => {},
    { blave: { stopTurn: async (sid) => { calls.push("stop"); stopSids.push(sid); return stopReply; } } });
  const b = els["btn-send"];
  R.running = true; R.sendBtnSync();
  ok("回合中:送出鈕換成停止鈕(is-stop)、aria=停止、可按", b.cls.has("is-stop") && b.attr["aria-label"] === "停止" && b.dataset.i18nAria === "ws.stop" && b.disabled === false);
  await R.stopTurn();
  ok("按停止:請主行程停這一條(帶 sid)、記 chat_stop", calls.length === 1 && stopSids[0] === "desktop-stop0001" && tracked.join() === "chat_stop");
  ok("…轉停止中(變淡),仍是停止鈕——不先切回送出", b.cls.has("is-stopping") && b.cls.has("is-stop"));
  await R.stopTurn();
  ok("停止中再按:不重送", calls.length === 1);
  R.running = false; R.sendBtnSync();
  ok("回合結束:回到送出鈕、aria=送出;輸入框上方那一行(#71)跟著收掉", !b.cls.has("is-stop") && !b.cls.has("is-stopping") && b.attr["aria-label"] === "送出" && els["ta-wait"].textContent === "");
  // 沒送到(主行程沒有回合)→ 還原,讓用戶再按
  const R2 = new Function("$", "t", "trackFeature", "autosize", "window", `let running = true; var CS = { loaded: null }, sessionId = "desktop-stop0001"; const withTab = (T, fn) => fn(); const tabBg = () => false;
    ${rCut} return { stopTurn, get stopping() { return turnStopping; }, get stopped() { return turnStopped; } };`)(
    (id) => els[id], (k) => k, () => {}, () => {}, { blave: { stopTurn: async () => false } });
  await R2.stopTurn();
  ok("主行程回 false:停止中還原,可以再按", R2.stopping === false && R2.stopped === false);
  // 暖機中(主行程還沒有回合):不還原,submitMessage 暖機完看到 turnStopped 就不送
  const R3 = new Function("$", "t", "trackFeature", "autosize", "window", `let running = true; var CS = { loaded: null }, sessionId = "desktop-stop0001"; const withTab = (T, fn) => fn(); const tabBg = () => false;
    ${rCut} engineWait = true; return { stopTurn, get stopped() { return turnStopped; } };`)(
    (id) => els[id], (k) => k, () => {}, () => {}, { blave: { stopTurn: async () => false } });
  await R3.stopTurn();
  ok("暖機中按停止:記住要停", R3.stopped === true);
  ok("…submitMessage 暖機完就收掉、原句放回", /if \(turnStopped\) \{ turnStopped = false; unlock\(\); unsend\(\); return false; \}/.test(appSrc) && /const unsend = \(\) => \{ if \(!attachments\.length \|\| !attachedFiles\.length \|\| attachedFiles === attachments\) bubble\.remove\(\); if \(lastUserTyped\) stopRestore\(msg, attachments\); \};/.test(appSrc));
  els.ta.value = ""; R.stopRestore("幫我跑 BTC 回側");
  ok("停下後原句放回空的輸入框", els.ta.value === "幫我跑 BTC 回側" && els.ta.focused);
  els.ta.value = "改成 ETH"; R.stopRestore("幫我跑 BTC 回側");
  ok("輸入框已經有字:原句接在前面、不覆寫(同雲端 csJoinDraft)", els.ta.value === "幫我跑 BTC 回側\n改成 ETH");
  ok("按鈕分流:回合中按 = 停止,閒著按 = 送出", /\$\("btn-send"\)\.addEventListener\("click", \(\) => \(running \? stopTurn\(\) : sendDraft\(\)\)\);/.test(appSrc));
  const endCut = cutFrom(appSrc, "function turnEndPre(r) {", "/* 側欄 / 聊天欄");
  ok("turn-end:停止不算失敗(不問登入、不攤收據、保險殺掉的結束碼不顯示)", /const stopped = turnStopped; turnStopped = false;/.test(endCut)
    && /const exitLine = r\.code !== 0 && !stopped/.test(endCut) && /const probe = !stopped && \(cur === "claude"/.test(endCut) && /const faulted = !stopped && \(/.test(endCut));
  ok("turn-end:切回送出鈕、原句放回", /turnStopping = false; turnUiSync\(\);/.test(endCut) && /if \(stopped && lastUserTyped\) \{/.test(endCut) && /stopRestore\(lastUserText, lastUserAttachments\);/.test(endCut));
  // 只放回用戶自己打的:把 submitMessage 裡算來源的那一行切出來跑
  const typedLine = /addMsg\("you", msg, attachments\.map\(\(a\) => a\.name\)\); (lastUserTyped = [^;]+;) lastUserText = msg;/.exec(appSrc);
  ok("來源那一行在 submitMessage 裡", !!typedLine);
  const origin = (seq) => { let lastUserTyped = false, lastUserText = "";
    return seq.map(([msg, opts]) => { eval(typedLine[1]); lastUserText = msg; return lastUserTyped; }); };
  ok("手打的放回;送上雲端 / 策略庫 / 報告這些代組的句子不放回", JSON.stringify(origin([["嗨", { typed: true }], ["把策略送上雲端", { handoff: "up" }], ["用這支策略", undefined]])) === "[true,false,false]");
  ok("重送同一句:沿用原句的來源(手打的重送仍放回,代組的重送仍不放回)", JSON.stringify(origin([["嗨", { typed: true }], ["嗨", undefined], ["掃描參數", undefined], ["掃描參數", undefined]])) === "[true,true,false,false]");
  ok("輸入框送出帶 typed(只有這一個呼叫點帶)", /\$\("ta"\)\.value = ""; autosize\(\);\n[^\n]*\n\s*await submitMessage\(msg, \{ typed: true, attachments \}\);/.test(appSrc)
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
