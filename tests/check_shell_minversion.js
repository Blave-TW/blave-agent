// shell/minversion.js:最低版本閘(安全事故用)。失敗方向一律放行。不打真的 api(fetchTiers 是假的)。
// 跑法:node tests/check_shell_minversion.js
const fs = require("fs"), path = require("path");
const { createGate, isBlocked, parse, minFromBody, START_CMDS, FRESH_MS } = require("../shell/minversion.js");
const { UI_COMMANDS } = require("../shell/daemon.js");
let red = 0; const t = (n, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) red++; };
(async () => {
  // 比較
  t("低於 → 擋;等於、高於 → 不擋", isBlocked("1.3.9", "1.4.0") && !isBlocked("1.4.0", "1.4.0") && !isBlocked("1.4.1", "1.4.0") && !isBlocked("2.0.0", "1.4.0"));
  t("逐段數值比較,不是字串比較(1.10.0 > 1.9.0)", !isBlocked("1.10.0", "1.9.0") && isBlocked("1.9.0", "1.10.0") && isBlocked("0.9.9", "0.10.0"));
  t("預發佈版視同同號正式版:1.4.0-beta.1 不被 1.4.0 擋,但被 1.4.1 擋", !isBlocked("1.4.0-beta.1", "1.4.0") && isBlocked("1.4.0-beta.1", "1.4.1"));
  t("min 的形狀不對 → 不擋(v 前綴、兩段、四段、前導零、預發佈尾碼、空字串、非字串、超過四位數)", ["v1.4.0", "1.4", "1.4.0.0", "01.4.0", "1.4.0-rc1", "", " 1.4.0", "1.4.0 ", "99999.0.0", null, undefined, 14, {}, ["9.9.9"]].every((m) => !isBlocked("0.0.1", m)));
  t("app 自己的版號解析不出來 → 不擋", ["", "dev", "1.4", null, undefined, "x.y.z"].every((v) => !isBlocked(v, "9.9.9")));
  t("parse:strict 不收預發佈、不 strict 會去掉", parse("1.2.3-beta", true) === null && parse("1.2.3-beta", false).join() === "1,2,3");
  t("minFromBody:沒有 desktop 鍵 / null / 壞形狀 → null", [{}, { desktop: null }, { desktop: {} }, { desktop: { min_version: null } }, { desktop: { min_version: "v2" } }, { desktop: "9.9.9" }, null, "x", []].every((b) => minFromBody(b) === null) && minFromBody({ desktop: { min_version: "1.4.0" } }) === "1.4.0");

  // 閘
  let clock = 1e9, reply = { desktop: { min_version: "9.0.0" } }, calls = [], changes = [], blockedHits = 0;
  const mk = (ver) => createGate({ currentVersion: ver || "0.1.0", fetchTiers: async (force) => { calls.push(force); if (reply instanceof Error) throw reply; return reply; },
    onChange: (s) => changes.push(s), onBlocked: () => blockedHits++, now: () => clock, setTimer: () => 0 });
  let g = mk();
  t("還沒問到之前不擋(啟動當下 api 還沒回)", g.state().blocked === false && g.tradeAllowed("resume") && g.turnAllowed("blave"));
  await g.refresh();
  t("api 說 min 9.0.0、app 0.1.0 → 擋;通知畫面一次、叫更新器去查一次", g.state().blocked === true && changes.length === 1 && changes[0].blocked === true && changes[0].min === "9.0.0" && blockedHits === 1);
  // 擋的點逐一列舉
  const allowed = [...UI_COMMANDS].filter((c) => g.tradeAllowed(c)).sort().join(), denied = [...UI_COMMANDS].filter((c) => !g.tradeAllowed(c)).sort().join();
  t("被擋時:UI_COMMANDS 裡只有啟動類送不出去(" + denied + ");暫停、改金額、金鑰的增刪照常", denied === "resume,resume_wait" && ["halt", "amounts", "credentials_remove"].every((c) => allowed.split(",").includes(c)));
  t("START_CMDS 裡的每一個都是 UI_COMMANDS 認得的指令(改名會紅)", [...START_CMDS].every((c) => UI_COMMANDS.has(c)));
  t("被擋時:只擋 Blave AI;連自己 CLI 的人照常聊", g.turnAllowed("blave") === false && g.turnAllowed("claude") === true && g.turnAllowed("codex") === true && g.turnAllowed(undefined) === true);
  await g.refresh(); t("狀態沒變不重複通知", changes.length === 1 && blockedHits === 1);
  // fail-open 與「問不到不解除」
  reply = new Error("offline"); await g.refresh(true);
  t("已確認被擋之後斷網:不因為問不到就解開", g.state().blocked === true);
  reply = null; await g.refresh(true); t("fetch 回 null(不是 200 / 不是物件)= 問不到:同上", g.state().blocked === true);
  reply = { desktop: { min_version: null } }; await g.refresh(true);
  t("api 明確回 null = 權威的解除;通知畫面", g.state().blocked === false && changes.length === 2 && changes[1].blocked === false && g.tradeAllowed("resume") && g.turnAllowed("blave"));
  reply = { linux: [] }; g = mk(); await g.refresh(); t("舊 api(沒有 desktop 鍵)→ 不擋", g.state().blocked === false);
  reply = new Error("offline"); g = mk(); await g.refresh(); t("一開始就連不上 → 不擋(fail-open)", g.state().blocked === false && g.state().checked_at === 0);
  reply = { desktop: { min_version: "9.0.0" } }; g = mk("dev-build"); await g.refresh(); t("app 版號不是 A.B.C → 永遠不擋", g.state().blocked === false);

  // 動作前補問
  reply = { desktop: { min_version: null } }; g = mk(); await g.refresh(); calls = [];
  await g.ensureFresh(); t("答案還新鮮:動作前不另外打 api", calls.length === 0);
  clock += FRESH_MS + 1; reply = { desktop: { min_version: "9.0.0" } };
  const st = await g.ensureFresh(); t("答案超過一小時:動作前補問一次(不看快取),補問到被擋就擋", calls.length === 1 && calls[0] === true && st.blocked === true);
  clock += FRESH_MS + 1; reply = new Error("offline"); calls = [];
  t("補問問不到:照手上的答案走", (await g.ensureFresh()).blocked === true && calls.length === 1);
  { let release; const hang = new Promise((r) => { release = r; }); const g2 = createGate({ currentVersion: "0.1.0", fetchTiers: () => hang, now: () => clock, setTimer: () => 0 });
    const keep = setTimeout(() => {}, 20000);   // 閘自己的 timer 是 unref 的(不拖住 app 結束);測試裡要有人撐著事件迴圈
    const t0 = Date.now(); const s2 = await g2.ensureFresh(); const took = Date.now() - t0; release(null); clearTimeout(keep);
    t("補問卡住(api 很慢):最多等幾秒就放行,不讓人卡在按鈕上", s2.blocked === false && took >= 4000 && took < 9000); }
  { let n = 0; const g3 = createGate({ currentVersion: "0.1.0", fetchTiers: async () => { n++; return {}; }, now: () => clock, setTimer: () => 0 });
    await Promise.all([g3.refresh(), g3.refresh(), g3.ensureFresh()]); t("同時多個人問:只打一次", n === 1); }

  // 接線(main.js 原文)
  const src = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8");
  t("main.js:trade-send 的啟動類先補問、被擋回 UPDATE_REQUIRED,而且在送給常駐程式之前", /START_CMDS\.has\(cmd\)\) \{ await minGate\(\)\.ensureFresh\(\); if \(!minGate\(\)\.tradeAllowed\(cmd\)\) return \{ ok: false, error: "UPDATE_REQUIRED" \}; \}\s*\n\s*const out = tradeHost\(\)\.send\(/.test(src));
  t("main.js:send-message 在 runTurn 之前擋 Blave AI,而且被擋時把 turnStarting 放掉", /if \(!minGate\(\)\.turnAllowed\(kind\)\) \{ turnStarting = false; return \{ blocked: "UPDATE_REQUIRED" \}; \}\s*\n\s*\}\s*\n\s*\} catch \(err\) \{ turnStarting = false; throw err; \}[^\n]*\n\s*runTurn\(win, payload\)/.test(src));
  t("main.js:會啟動下單的入口只有 trade-send 這一個(選單列那條只送 halt)", (src.match(/tradeHost\(\)\.send\(/g) || []).length === 3 && /tradeHost\(\)\.send\("halt"/.test(src)
    && /tradeHost\(\)\.send\("credentials", \{ env \}, \{ trusted: true \}\)/.test(src));   // 第三個是 Binance 連接(binance_link):只送 credentials,啟動不了下單
  t("main.js:會開回合的入口只有 send-message 這一個", (src.match(/[^a-zA-Z]runTurn\(/g) || []).length === 2);
  t("main.js:版本閘與方案頁讀同一支、同一份快取(不另開請求)", (src.match(/\/openclaw\/public_tiers/g) || []).length === 1 && /fetchTiers: \(force\) => publicTiers\(force\)/.test(src));
  t("main.js:被擋的那一刻叫更新器去查;狀態只推給自家頁面", /onBlocked: \(\) => \{ try \{ updater\(\)\.check\(\);/.test(src) && /isOurPageUrl\(w\.webContents\.getURL\(\)\)\) w\.webContents\.send\("min-version-state"/.test(src));
  t("main.js:啟動時就開始查", /minGate\(\)\.start\(\);/.test(src));
  console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
})();
