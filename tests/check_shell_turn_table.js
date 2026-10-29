// 電腦版回合表(0.1.37 對話分頁真並行;技術方案 chat-tabs-parallel-tech §1.1、§1.4;shell/main.js)。
//   1. 列舉:單例(activeTurn / turnStarting / turnSessionId / turnStopFile…)一個都不剩;每一處「有沒有回合」的判斷
//      都在下面兩份清單之一(機器層級看 anyTurn()、那一條自己看 turns.has(sid)),清單上每一條也都還在——多一處、少一處都紅
//   2. startTurn:同一條一次一輪、不同條並行;壞 id／版本閘／拋例外／runTurn 失敗都把那一筆拿掉;
//      對著雲端主機的照 max_turns 排隊、結束一條補一條、取消排隊;重開收工中不開也不補
//   3. 雲端名額的來源:cloud.js 讀 turn_limits.max_turns,缺了 = null,main.js 當 1
//   4. 結束框的回合那句:兩條以上帶數字
// 跑法:node tests/check_shell_turn_table.js
const fs = require("fs"), path = require("path");
const SH = path.join(__dirname, "..", "shell");
const main = fs.readFileSync(path.join(SH, "main.js"), "utf8");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  " + JSON.stringify(d).slice(0, 600))); if (!c) red++; };
const cut = (a, b) => { const i = main.indexOf(a), j = main.indexOf(b, i); if (i < 0 || j < 0) throw new Error("找不到標記:" + a); return main.slice(i, j); };
const tick = () => new Promise((r) => setImmediate(r));

// ── 1. 列舉 ──
ok("單例一個都不剩", !/\b(activeTurn|turnStarting|turnSessionId|turnStopFile|turnFinalized|turnLastOut|newTurnStop)\b/.test(main),
  (main.match(/\b(activeTurn|turnStarting|turnSessionId|turnStopFile|turnFinalized|turnLastOut|newTurnStop)\b/g) || []));
const ANY = [   // 機器層級:任何一條在跑都算
  ["deleteStrategy", /^  if \(anyTurn\(\)\) return \{ ok: false, code: "TURN_RUNNING" \};/],
  ["browser-clear", /handle\("browser-clear", \(\) => \(anyTurn\(\) \? false : browser\(\)\.clearData\(\)\), false\);/],
  ["appMenuSync 結束那一格的「…」", /const ask = !!\(tradeMaybeLive\(\) \|\| anyTurn\(\)\);/],
  ["restartToUpdate", /turnBusy = \(\) => anyTurn\(\);/],
  ["06:00 排程 第一次判", /^      turn: anyTurn\(\), idleSec:/],
  ["06:00 排程 重判", /trading: !!tradeMaybeLive\(\), turn: anyTurn\(\), asking:/],
  ["06:00 排程 收引擎之後", /^    if \(anyTurn\(\)\) \{ draftOk = false; return \{ go: false, why: "turn" \}; \}/],
  ["搬到應用程式", /if \(tradeMaybeLive\(\) \|\| anyTurn\(\) \|\| _engineRun/],
  ["選單列「結束」的「…」", /const trayQuitLabel = \(maybe\) => \(maybe \|\| anyTurn\(\) \?/],
  ["選單列更新那一行停用", /busy: !!\(anyTurn\(\) \|\| restarting\)/],
  ["關視窗只收起來", /const trading = tradeMaybeLive\(\), turn = anyTurn\(\);/],
  ["結束前草稿那道併框", /const more = !!tradeMaybeLive\(\) \|\| anyTurn\(\) \|\| twLots\(\)\.held;/],
  ["結束前的回合確認框", /if \(!quitting && !quitConfirmed && anyTurn\(\)\) \{/],
];
const ONE = [   // 那一條自己
  ["deleteSession", /if \(!okSessionId\(id\) \|\| turns\.has\(id\)\) return false;/],
  ["startTurn 同一條序列", /if \(restarting \|\| turns\.has\(sid\)\) return \{ busy: true \};/],
];
const lines = main.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => /anyTurn\(\)|turns\.has\(/.test(l) && !/^\s*(\/\/|\/\*|\*)/.test(l));
const unknown = lines.filter((l) => !ANY.concat(ONE).some(([, re]) => re.test(l)));
ok("每一處 anyTurn() / turns.has( 都在清單上(新加的判斷要歸類:機器層級或那一條自己)", unknown.length === 0, unknown);
const missing = ANY.concat(ONE).filter(([, re]) => !lines.some((l) => re.test(l))).map(([n]) => n);
ok("清單上每一處都還在(" + (ANY.length + ONE.length) + " 處)", missing.length === 0, missing);
ok("tick 輪替不再看回合(回合手上只有帳號轉送口的 token)", /const tick = \(\) => \{ rotator\(\)\.ensure\(ROTATE_MIN_LEFT_MS\)\.catch\(\(\) => \{\}\); \};/.test(main));
ok("send-message 只收自家頁面,其餘全交給 startTurn", /ipcMain\.handle\("send-message", async \(e, payload\) => \{\n    if \(!fromOurPage\(e\)\) return \{ busy: true \};[^\n]*\n    return startTurn\(payload, "desktop"\);\n  \}\);/.test(main));
ok("turns-state 走 handle(只收自家頁面),preload 有 turnsState", /handle\("turns-state", \(\) => turnsState\(\), \[\]\);/.test(main) && /turnsState: \(\) => ipcRenderer\.invoke\("turns-state"\)/.test(fs.readFileSync(path.join(SH, "preload.js"), "utf8")));
ok("回合子行程降一級優先序,spawn 之後、調不了照跑", /rec\.child = child; rec\.phase = "running";\n  turnNice\(child\);/.test(main) && /os\.setPriority\(child\.pid, os\.constants\.priority\.PRIORITY_BELOW_NORMAL\)/.test(main));
ok("turn-event / turn-end 一律經 sendTurn 補 sid;runTurn 裡沒有直接 webContents.send", !/win\.webContents\.send\("turn-/.test(cut("async function runTurn(", "function turnWin()")) && /sendTurn\(sessionId, "turn-event", c\);/.test(main));
ok("⌘1–9 留給分頁:視角切換是 ⌘⇧1 / ⌘⇧2", /accelerator: "Cmd\+Shift\+1", click: \(\) => onEnv\("local"\)/.test(main) && /accelerator: "Cmd\+Shift\+2", click: \(\) => onEnv\("cloud"\)/.test(main) && !/accelerator: "Cmd\+[1-9]"/.test(main)
  && /!e\.shiftKey \|\| \(e\.code !== "Digit1" && e\.code !== "Digit2"\)/.test(fs.readFileSync(path.join(SH, "renderer", "trade.js"), "utf8")));

// ── 2. startTurn ──
const SRC = cut("const turns = new Map();", "/* 本機常駐程式的宿主") + "\n" + cut("function turnWin()", "/* 這個視窗只顯示我們自己的 index.html");
function rig(o = {}) {
  const sent = [], tracked = [], runs = [];
  const ctx = {
    fs: { mkdirSync() {}, writeFileSync() {}, rmSync() {} }, path, crypto: require("crypto"), BASE: "/b", os: { setPriority() {}, constants: { priority: {} } },
    restarting: null, okSessionId: (id) => typeof id === "string" && /^desktop-[a-z0-9]{4,16}$/.test(id),
    BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { getURL: () => "ours", send: (ch, p) => sent.push([ch, p]) } }] }, isOurPageUrl: () => true,
    replyPending: new Map(), loadConnection: () => ({ kind: o.kind || "claude" }),
    minGate: () => ({ ensureFresh: async () => { if (o.gateThrow) throw new Error("x"); }, turnAllowed: () => !o.blocked }),
    _cloud: o.snap === undefined ? null : { snapshot: () => o.snap }, cloudHost: () => ({ start() {} }),
    cloudHandoffOn: () => true, tm: () => ({ track: (e, p) => tracked.push(p && p.name ? p.name : e) }),
    runTurn: (rec, payload) => new Promise((resolve, reject) => { runs.push({ rec, payload, resolve, reject }); }),
  };
  const api = new Function("ctx", "with (ctx) { " + SRC + "\n return { startTurn, turns, turnQueue, turnFinish, stopTurn, cloudTurnLimit, liveTurnCount, anyTurn, turnPump }; }")(ctx);
  return { ctx, api, sent, tracked, runs };
}
const A = "desktop-aaaa1111", B = "desktop-bbbb2222", C = "desktop-cccc3333", D = "desktop-dddd4444";
const ends = (r) => r.sent.filter(([ch]) => ch === "turn-end").map(([, p]) => p);
(async () => {
  { const r = rig();
    const a1 = await r.api.startTurn({ sessionId: A, message: "x" }, "desktop");
    const a2 = await r.api.startTurn({ sessionId: A, message: "y" }, "desktop");
    const b1 = await r.api.startTurn({ sessionId: B, message: "z" }, "desktop");
    ok("同一條第二句 → busy;不同條 → 都開跑(本機不設上限)", a1.started && a2.busy && b1.started && r.runs.length === 2 && r.api.liveTurnCount() === 2 && r.api.anyTurn());
    ok("同時兩條在跑:當天第一次到 2 記 chat_par2", r.tracked.includes("chat_par2"));
    for (const s of [C, D, "desktop-eeee5555", "desktop-ffff6666", "desktop-gggg7777", "desktop-hhhh8888"]) await r.api.startTurn({ sessionId: s, message: "m" }, "desktop");
    ok("八條同時跑:chat_par4、chat_par8 都記到;本機沒有排隊", r.tracked.includes("chat_par4") && r.tracked.includes("chat_par8") && r.api.turnQueue.length === 0 && r.runs.length === 8);
    r.runs[0].reject(new Error("AGENT_BIN_MISSING")); await tick();
    const e = ends(r);
    ok("runTurn 失敗:那一筆拿掉、turn-end 帶 sid 與錯誤、記 reply-cue 要用的 pending;別條不動", !r.api.turns.has(A) && r.api.turns.has(B) && e.length === 1 && e[0].sid === A && e[0].code === 1 && /AGENT_BIN_MISSING/.test(e[0].errTail) && r.ctx.replyPending.get(A).awaiting === false);
    ok("收尾重複叫只算第一次", r.api.turnFinish(r.runs[0].rec, { code: 0 }, false) === false && ends(r).length === 1);
    ok("那一條收尾之後可以再送", (await r.api.startTurn({ sessionId: A, message: "again" }, "desktop")).started === true); }
  { const r = rig();
    ok("對話 id 不合格:回 busy、不進表(壞 key 不能卡住)", (await r.api.startTurn({ sessionId: "../x", message: "m" })).busy && r.api.turns.size === 0 && r.runs.length === 0); }
  { const r = rig({ kind: "blave", blocked: true });
    ok("版本閘擋下:回 blocked、表上那一筆拿掉、沒開跑", (await r.api.startTurn({ sessionId: A, message: "m" })).blocked === "UPDATE_REQUIRED" && r.api.turns.size === 0 && r.runs.length === 0); }
  { const r = rig({ kind: "blave", gateThrow: true }); let threw = false; r.ctx.minGate = () => ({ ensureFresh: async () => {}, turnAllowed: () => { throw new Error("boom"); } });
    try { await r.api.startTurn({ sessionId: A, message: "m" }); } catch (_) { threw = true; }
    const gone = r.api.turns.size === 0; r.ctx.minGate = () => ({ ensureFresh: async () => {}, turnAllowed: () => true });
    ok("版本閘那段拋例外:往外拋、表上那一筆照樣拿掉(稽核 R1),那條下一句照常開跑", threw && gone && (await r.api.startTurn({ sessionId: A, message: "m2" }, "desktop")).started === true); }
  { const r = rig(); r.ctx.restarting = "stopping";
    ok("重開收工中:回 busy", (await r.api.startTurn({ sessionId: A, message: "m" })).busy && r.api.turns.size === 0); }
  // 雲端名額
  { const r = rig({ snap: { code: "OK", max_turns: 2 } }), cloud = (sid) => ({ sessionId: sid, message: "m", viewing: { env: "cloud" } });
    const s1 = await r.api.startTurn(cloud(A)), s2 = await r.api.startTurn({ sessionId: B, message: "m", handoff: "up" }), s3 = await r.api.startTurn(cloud(C)), loc = await r.api.startTurn({ sessionId: D, message: "local" });
    ok("對著雲端(雲端視角或送上雲端)的照 max_turns:第 3 條 queued;本機視角的不計入", s1.started && s2.started && s3.queued && loc.started && r.api.turnQueue.join() === C && r.api.turns.get(C).phase === "queued" && r.runs.length === 3);
    ok("排隊:記 chat_queued、畫面收到 queued 事件(帶 sid);排隊中的不算在跑", r.tracked.includes("chat_queued") && r.sent.some(([ch, p]) => ch === "turn-event" && p.type === "queued" && p.sid === C) && r.api.liveTurnCount() === 3);
    r.ctx.restarting = "stopping"; r.api.turnFinish(r.runs[1].rec, { code: 0 }, false); await tick();
    ok("重開收工中:空出名額也不補", r.api.turns.get(C).phase === "queued" && r.runs.length === 3);
    r.ctx.restarting = null; r.api.turnPump(); await tick();
    ok("收工取消後補上:依序開跑、送 started 事件、payload 原樣交給 runTurn", r.api.turns.get(C).phase === "starting" && r.runs.length === 4 && r.runs[3].payload.viewing.env === "cloud" && r.sent.some(([, p]) => p.type === "started" && p.sid === C));
    const s5 = await r.api.startTurn(cloud("desktop-iiii9999"));
    ok("名額又滿 → 下一條排隊;取消排隊 = 拿掉、turn-end 帶 canceled、記 queue_cancel、沒開跑", s5.queued && r.api.stopTurn("desktop-iiii9999") === true && !r.api.turns.has("desktop-iiii9999") && r.api.turnQueue.length === 0
      && ends(r).some((e) => e.sid === "desktop-iiii9999" && e.canceled === true) && r.tracked.includes("queue_cancel") && r.runs.length === 4); }
  { ok("名額讀不到(還沒輪詢、不是 OK、舊 api 沒帶)= 1", rig().api.cloudTurnLimit() === 1 && rig({ snap: { code: "OFFLINE" } }).api.cloudTurnLimit() === 1 && rig({ snap: { code: "OK", max_turns: null } }).api.cloudTurnLimit() === 1 && rig({ snap: { code: "OK", max_turns: 4 } }).api.cloudTurnLimit() === 4); }
  { const r = rig(), cloud = (sid) => ({ sessionId: sid, message: "m", viewing: { env: "cloud" } });
    const s1 = await r.api.startTurn(cloud(A)), s2 = await r.api.startTurn(cloud(B));
    ok("名額讀不到時:雲端第 2 條就排隊(保守,試用也是 1)", s1.started && s2.queued); }

  // ── 3. cloud.js ──
  const { interpret } = require(path.join(SH, "cloud.js"));
  const body = (tl) => ({ status: 200, body: { machine: { state: "running" }, portfolio_stale: false, portfolio: {}, ...(tl === undefined ? {} : { turn_limits: tl }) } });
  ok("cloud.js:turn_limits.max_turns 取正整數;沒有這個鍵、型別不對、0 → null", interpret(body({ max_turns: 4, trial: false })).max_turns === 4 && interpret(body(undefined)).max_turns === null
    && interpret(body({ max_turns: "4" })).max_turns === null && interpret(body({ max_turns: 0 })).max_turns === null && interpret(body([])).max_turns === null && interpret(body({ max_turns: 1000 })).max_turns === 64);

  // ── 4. 結束框 ──
  const qtb = new Function(cut("function quitTurnBody(", "function quitOnSignals(") + "\n return quitTurnBody;")();
  const L = { quitTurnBody: "one", quitTurnBodyN: "{n} 個回覆還在跑" };
  ok("結束框:一條用舊句、兩條以上帶數字;字還沒交過來(沒有 N 句)退回舊句", qtb(1, L) === "one" && qtb(3, L) === "3 個回覆還在跑" && qtb(3, { quitTurnBody: "one" }) === "one");
  const po = (lang) => fs.readFileSync(path.join(SH, "i18n", lang + ".po"), "utf8");
  ok("tm.quitTurnBodyN 兩語都有 {n};trade.js 把它交給主行程", ["zh", "en"].every((l) => /msgid "tm\.quitTurnBodyN"\nmsgstr "\{n\}[^"]+"/.test(po(l)))
    && /quitTurnBodyN: t\("tm\.quitTurnBodyN", \{ n: "\{n\}" \}\)/.test(fs.readFileSync(path.join(SH, "renderer", "trade.js"), "utf8")));

  console.log(red ? `\n${red} 紅` : "\nALL PASS");
  process.exit(red ? 1 : 0);
})().catch((e) => { console.log("FAIL  " + (e && e.stack)); process.exit(1); });
