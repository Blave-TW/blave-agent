// 電腦版更新提示(designer spec-desktop-update-prompt-0.1.10):
//   §0 / §1 restartToUpdate:聊天那一格、關於列、選單列共用的「重新啟動以完成更新」。沒在下單直接裝;下單中先問(同結束攔截的框),
//            確認後 quitConfirmed → noteQuit → stop 收完 → install;install 還說在下單就改走 app.quit()。重開後不自動接回下單
//   §4 askMoveToApps:不在「應用程式」資料夾就問一次;「不要移」記下來、之後不問;授權框取消 / 出錯不記
//   §5 明確不做:quitAndInstall 只在 updater.js install();install 只由 restartToUpdate 叫;更新這條路沒有計時器、沒有系統通知
// 從 shell/main.js 原文切出來,配假的 dialog / tradeHost / updater / app 跑。不開 Electron、不碰真的收工路徑。
// 跑法:node tests/check_shell_update_restart.js
const fs = require("fs"), os = require("os"), path = require("path");
const SHELL = path.join(__dirname, "..", "shell");
const src = fs.readFileSync(path.join(SHELL, "main.js"), "utf8"), upSrc = fs.readFileSync(path.join(SHELL, "updater.js"), "utf8");
const cut = (s, head) => { const i = s.indexOf(head); if (i < 0) throw new Error("找不到 " + head); let d = 0; for (let k = s.indexOf("{", s.indexOf(")", i)); k < s.length; k++) { if (s[k] === "{") d++; else if (s[k] === "}" && --d === 0) return s.slice(i, k + 1); } throw new Error("切不出 " + head); };
const { planRestart, shouldAskMove } = require("../shell/updater.js");
const TT = require("../shell/traytext.js");
let red = 0; const t = (n, ok, d) => { console.log((ok ? "PASS  " : "FAIL  ") + n + (ok || d === undefined ? "" : "  " + JSON.stringify(d))); if (!ok) red++; };
const tick = () => new Promise((r) => setImmediate(r));
const S = fs.readFileSync(path.join(SHELL, "renderer", "strings.js"), "utf8");
const zh = (k) => { const m = new RegExp('"' + k.replace(/\./g, "\\.") + '": "([^"]*)"').exec(S.slice(S.indexOf("zh:"))); if (!m) throw new Error("字串表沒有 " + k); return m[1]; };
const L = { quitTitle: zh("tm.quitTitle"), updateBody: zh("tm.updateBody"), quitCloudNote: zh("tm.quitCloudNote"), quitStay: zh("tm.quitStay"), updateReady: zh("tm.updateReady"), paperVenue: "模擬交易",
  moveTitle: zh("tm.move.title"), moveBody: zh("tm.move.body"), moveGo: zh("tm.move.go"), moveNo: zh("tm.move.no") };

const RESTART = cut(src, "async function restartToUpdate("), MOVE = cut(src, "async function askMoveToApps(");
const MOVE_PATH = /^const moveDeclinedPath = [^\n]*;$/m.exec(src)[0];

// ── §0 / §1 restartToUpdate ──
// 假收工同 probe(稽核 scratchpad/audit-0110/probe.js):stop 收完 child 才清掉,之後 tradeMaybeLive 才變 null(daemon.js 的實際行為)
function rig(o) {
  const log = [], boxes = [], tracked = [];
  let quitConfirmed = false, child = !!o.trading, phase = o.phase || "blocked", nDialog = 0;
  const ctx = {
    quitAsking: !!o.asking, quitting: false, restarting: null, setRestarting: (v) => { ctx.restarting = v; }, activeTurn: o.turn ? {} : null, turnStarting: false, tmLabels: { ...L }, TT: { quitDetail: TT.quitDetail, cloudTrading: (s) => !!(s && s.trading), stayGo: TT.stayGo }, process: { platform: o.platform || "darwin" },
    planRestart, cloudSt: () => (o.cloud ? { trading: true } : null), BrowserWindow: { getAllWindows: () => [] },
    tradeMaybeLive: () => (child ? { venue: "binance" } : null), venueName: (id) => (id === "binance" ? "Binance" : ""),
    showMain: () => { log.push("showMain"); if (o.showMainThrows) throw new Error("window gone"); },
    tm: () => ({ track: (ev, p) => { tracked.push(ev + ":" + p.name); log.push("used"); } }),
    dialog: { showMessageBox: (_w, opts) => { boxes.push(opts); log.push("dialog"); nDialog++; if (o.onDialog) o.onDialog(nDialog); return o.dialogThrows ? Promise.reject(new Error("x")) : Promise.resolve({ response: typeof o.response === "function" ? o.response(nDialog) : o.response }); } },
    updater: () => ({ state: () => ({ phase }), install: () => { const res = o.installRes || (phase !== "ready" && phase !== "blocked" ? { ok: false, error: "NOT_READY" } : child ? { ok: false, error: "TRADING" } : { ok: true }); log.push("install:" + (res.ok ? "ok" : res.error)); if (o.installThrows) throw new Error("boom"); return res; } }),
    app: { quit: () => log.push("app.quit") },
    _tradeHost: { noteQuit: () => { log.push("noteQuit"); if (o.noteQuitThrows) throw new Error("note"); },
      stop: () => { log.push("stop:start"); return new Promise((ok) => setTimeout(() => { child = false; log.push("stop:done"); ok(); }, 30)); } },
    console: { error: () => {} },
    // 0.1.12:背景安裝的 pip 在跑時要先收掉(稽核 0.1.12 P1-1);沒在裝時是立刻回來的 no-op,不進 log
    engineAbort: () => (o.installing ? new Promise((ok) => setTimeout(() => { log.push("engineAbort"); ok(true); }, 10)) : Promise.resolve(false)),
  };
  Object.defineProperty(ctx, "quitConfirmed", { get: () => quitConfirmed, set: (v) => { quitConfirmed = v; log.push("quitConfirmed=" + v); } });
  const fn = new Function("ctx", "with (ctx) { " + RESTART + "\n return restartToUpdate; }")(ctx);
  return { run: () => fn(), log, boxes, tracked, ctx, confirmed: () => quitConfirmed, setPhase: (p) => { phase = p; } };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  { const r = rig({ trading: false, phase: "ready" }), res = await r.run();
    t("沒在下單:直接 install,不跳框、不收工;裝成才送埋點 feature_used update_restart", res.ok === true && r.log.join() === "install:ok,used" && r.boxes.length === 0 && r.tracked.join() === "feature_used:update_restart", r.log); }
  { const r = rig({ trading: false, phase: "ready", installing: true }), res = await r.run();
    t("0.1.12 背景安裝的 pip 在跑:先收掉 pip(等它結束)再 install", res.ok === true && r.log.join() === "engineAbort,install:ok,used", r.log); }
  { const r = rig({ trading: true, response: 1, installing: true }), res = await r.run();
    t("0.1.12 下單中、按確認、pip 也在跑:停單收完 → 收 pip → install", res.ok === true && r.log.join() === "showMain,dialog,used,quitConfirmed=true,noteQuit,stop:start,stop:done,engineAbort,install:ok", r.log); }
  { const r = rig({ trading: false, phase: "ready", installRes: { ok: false, error: "NOT_READY" } }), res = await r.run();
    t("…直接 install 當下沒成:不送埋點(不多算,稽核 P2-6)", res.ok === false && r.tracked.length === 0); }
  { const r = rig({ trading: true, response: 0 }), res = await r.run();
    t("下單中、按取消(回應 0):先 showMain 再跳框;沒 noteQuit、沒 stop、沒 install;回 CANCELED", res.error === "CANCELED" && r.log.join() === "showMain,dialog", r.log);
    t("…取消後旗標都還原:quitAsking false、quitConfirmed 沒設、restarting 沒設(下次結束 / 再按照樣會問)", r.ctx.quitAsking === false && r.confirmed() === false && r.ctx.restarting === null);
    t("…按取消不送埋點(沒有用到)", r.tracked.length === 0);
    const b = r.boxes[0];
    t("確認框:warning、標題 tm.quitTitle、內文 tm.updateBody 帶 venue、鈕 [取消, 重新啟動以完成更新]、預設與 Esc 都是取消", b.type === "warning" && b.message === L.quitTitle
      && b.detail === L.updateBody.replace("{venue}", "Binance") && JSON.stringify(b.buttons) === JSON.stringify([L.quitStay, L.updateReady]) && b.defaultId === 0 && b.cancelId === 0, b); }
  // 0.1.12 設計稽核:noLink 之後 Windows 照陣列由左往右畫——動作在左、取消在最右;預設與 Esc 仍是取消。macOS 照上面那組不動
  { const r = rig({ trading: true, response: 1, platform: "win32" }), res = await r.run(), b = r.boxes[0];
    t("Windows:鈕 [重新啟動以完成更新, 取消]、預設與 Esc 都是取消(1);按取消(回 1)→ CANCELED,什麼都沒動", JSON.stringify(b.buttons) === JSON.stringify([L.updateReady, L.quitStay]) && b.defaultId === 1 && b.cancelId === 1 && b.noLink === true
      && res.error === "CANCELED" && r.log.join() === "showMain,dialog", JSON.stringify([b, r.log])); }
  { const r = rig({ trading: true, response: 0, platform: "win32" }), res = await r.run();
    t("Windows:按左邊那顆(回 0 = 重新啟動)→ 收工再裝", res.ok === true && r.log.indexOf("noteQuit") > 0 && r.log.some((x) => /^install:/.test(x)), r.log); }
  { const r = rig({ trading: true, cloud: true, response: 0 }); await r.run();
    t("雲端也確定在下單:內文多一段 tm.quitCloudNote(同結束攔截,經 TT.quitDetail)", r.boxes[0].detail === TT.quitDetail(L.updateBody.replace("{venue}", "Binance"), L.quitCloudNote) && r.boxes[0].detail.includes(L.quitCloudNote)); }
  { const r = rig({ trading: true, response: 1 }), res = await r.run();
    t("按確認(回應 1):順序 quitConfirmed=true → noteQuit → stop 收完 → install(收工走結束 app 同一條)", r.log.join() === "showMain,dialog,used,quitConfirmed=true,noteQuit,stop:start,stop:done,install:ok" && res.ok === true, r.log);
    t("…交給 quitAndInstall 之後 restarting = installing(紅燈、Cmd+Q 放行,它要關視窗才能重開)", r.ctx.restarting === "installing");
    t("…沒有另外接回下單(重開後對帳器照規矩停著)", !/_tradeHost\.(start|send)\(|tradeHost\(\)\.(start|send)\(|tradeStartIfReady|"resume"/.test(RESTART));
    t("…埋點 feature_used update_restart 一次(確認後,stop 最多 11 秒,送得出去)", r.tracked.join() === "feature_used:update_restart"); }
  { const r = rig({ trading: true, response: 1 }); const p = r.run(); await sleep(5);
    t("框開著那段時間 quitAsking = true(Cmd+Q 不會疊第二個框)", r.ctx.quitAsking === true || r.log.includes("stop:start")); await p; }

  // ── 稽核 P1-1:確認到裝好之間(probe A / A2 / B)──
  { const r = rig({ trading: true, response: 1 }); const p1 = r.run(); await sleep(10);
    t("收工中 restarting = stopping(send-message 回忙碌、選單列那一行停用、紅燈只收視窗都看它)", r.ctx.restarting === "stopping");
    const p2 = r.run(); const res = await Promise.all([p1, p2]);
    t("A 收工中再按一次:不跳第二個框、noteQuit / stop / install 各一次,第二次回 ASKING", r.boxes.length === 1 && r.log.filter((x) => x === "noteQuit").length === 1 && r.log.filter((x) => x === "stop:start").length === 1
      && r.log.filter((x) => /^install/.test(x)).length === 1 && res[1].error === "ASKING", [r.log, res]); }
  { const r = rig({ trading: true, response: (n) => (n === 1 ? 1 : 0) }); const p1 = r.run(); await sleep(10); const p2 = r.run(); await Promise.all([p1, p2]);
    t("A2 收工中再按:根本不會出現第二個框,也就沒有「按了取消其實取消不了」", r.boxes.length === 1, r.log); }
  { const r = rig({ trading: true, response: 1, onDialog: () => {} }); const p1 = r.run(); await sleep(10);
    const src2 = cut(src, 'ipcMain.handle("send-message", async (e, payload) =>');
    t("B 收工中送聊天:send-message 把 restarting 算進忙碌(回合開不起來,不會被無聲砍掉)", /if \(activeTurn \|\| turnStarting \|\| restarting\) return \{ busy: true \};/.test(src2) && !!r.ctx.restarting); await p1; }
  { const r = rig({ trading: true, response: 1, onDialog: () => {} }); r.ctx.dialog.showMessageBox = (_w, opts) => { r.boxes.push(opts); r.log.push("dialog"); r.ctx.turnStarting = true; return Promise.resolve({ response: 1 }); };
    const res = await r.run();
    t("框開著時回合開始了(程式觸發):按確認也不收工,回 TURN_BUSY,旗標不動", res.error === "TURN_BUSY" && !r.log.includes("noteQuit") && !r.log.includes("stop:start") && r.confirmed() === false && r.ctx.restarting === null, r.log); }
  // ── 稽核 P1-2:收工前 phase 變了 / 收工後沒裝成(probe C)──
  { const r = rig({ trading: true, response: 1 }); r.ctx.dialog.showMessageBox = (_w, opts) => { r.boxes.push(opts); r.log.push("dialog"); r.setPhase("error"); return Promise.resolve({ response: 1 }); };
    const res = await r.run();
    t("C 框開著時 updater 出錯(phase → error):不收工、回 NOT_READY、quitConfirmed 沒設", res.error === "NOT_READY" && !r.log.includes("noteQuit") && !r.log.includes("stop:start") && r.confirmed() === false && r.ctx.restarting === null, r.log); }
  { const r = rig({ trading: true, response: 1 }); const p = r.run(); await sleep(10); r.setPhase("error"); const res = await p;
    t("C' 收工期間 phase → error、install 回 NOT_READY:改走 app.quit()(已同意停單,不留停一半、app 沒重開)", r.log.slice(-2).join() === "install:NOT_READY,app.quit" && res.quit === true, r.log); }
  { const r = rig({ trading: true, response: 1, installRes: { ok: false, error: "TRADING" } }), res = await r.run();
    t("收工後 install 不管回什麼錯(TRADING 也一樣):一律 app.quit()", r.log.slice(-2).join() === "install:TRADING,app.quit" && res.quit === true, r.log); }
  { const r = rig({ trading: true, response: 1, noteQuitThrows: true }); let threw = false, res = null; try { res = await r.run(); } catch (_) { threw = true; }
    t("確認後整段拋例外(noteQuit 炸了):不往外拋,改走 app.quit()", !threw && res && res.quit === true && r.log.slice(-1)[0] === "app.quit", r.log); }
  { const r = rig({ trading: true, response: 1, installThrows: true }); let threw = false; try { await r.run(); } catch (_) { threw = true; }
    t("install 拋例外:同上,app.quit()", !threw && r.log.slice(-1)[0] === "app.quit", r.log); }
  // ── 稽核 P2-1 ──
  { const r = rig({ trading: true, response: 0, showMainThrows: true }), res = await r.run();
    t("showMain 拋例外:照樣問、quitAsking 還原(不會之後 Cmd+Q 永遠沒反應)", res.error === "CANCELED" && r.boxes.length === 1 && r.ctx.quitAsking === false, r.log); }
  { const r = rig({ trading: true, dialogThrows: true }), res = await r.run();
    t("對話框自己出錯:當成取消,旗標還原", res.error === "CANCELED" && r.ctx.quitAsking === false && r.confirmed() === false && !r.log.some((x) => /^install/.test(x))); }
  { const r = rig({ trading: true, asking: true }), res = await r.run();
    t("已經有確認框開著(quitAsking,跟結束攔截共用):不疊第二個,回 ASKING", res.error === "ASKING" && r.boxes.length === 0 && r.log.length === 0); }
  { const r = rig({ trading: true }); r.ctx.quitting = true; const res = await r.run();
    t("app 已經在結束(quitting):不問、不收工,回 ASKING", res.error === "ASKING" && r.log.length === 0); }
  { const r = rig({ trading: false, turn: true, phase: "ready" }), res = await r.run();
    t("本機回合在跑:回 TURN_BUSY、不裝(同今天)", res.error === "TURN_BUSY" && r.log.length === 0); }
  { const r = rig({ trading: false, phase: "downloading" }), res = await r.run();
    t("還沒下載好:回 NOT_READY", res.error === "NOT_READY" && r.log.length === 0); }
  // ── 設計複驗 0.1.10:restarting 一變就推給畫面、重建選單列(不等 5 秒)──
  { const SR = cut(src, "function setRestarting("), sent = [], steps = [];
    const ctx = { restarting: null, _officialBackup: null, updater: () => ({ state: () => ({ phase: "blocked" }) }), startStep: (w, f) => steps.push(w), traySync: () => {},
      BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (ch, a) => sent.push([ch, a]) } }] } };
    const setR = new Function("ctx", "with (ctx) { " + SR + "\n return setRestarting; }")(ctx);
    setR("stopping");
    t("setRestarting:設旗標、當下推 update-state(restarting: true)、重建選單列", ctx.restarting === "stopping" && sent.length === 1 && sent[0][0] === "update-state" && sent[0][1].restarting === true && sent[0][1].phase === "blocked" && steps.join() === "tray", sent);
    const trS = fs.readFileSync(path.join(SHELL, "renderer", "trade.js"), "utf8");
    t("選單列的「重新啟動中…」:trPushLabels 交 tm.restarting、主行程英文退路 Restarting…;兩語逐字", /restarting: t\("tm\.restarting"\)/.test(trS) && /restarting: "Restarting…",/.test(src)
      && zh("tm.restarting") === "重新啟動中…" && zh("up.restarting") === "重新啟動中…" && /"tm\.restarting": "Restarting…"/.test(S) && /"up\.restarting": "Restarting…"/.test(S));
    t("restartToUpdate 設 restarting 一律經 setRestarting(沒有直接賦值)", !/\brestarting = /.test(RESTART) && (RESTART.match(/setRestarting\(/g) || []).length === 3
      && /handle\("update-state", \(\) => \(\{ \.\.\.updater\(\)\.state\(\), backup: _officialBackup, restarting: !!restarting \}\)\);/.test(src)
      && /send\("update-state", \{ \.\.\.st, backup: _officialBackup, restarting: !!restarting \}\)/.test(src)); }

  // ── 主行程其他接點(原文)──
  { const bq = cut(src, 'app.on("before-quit", (e) =>'), close = cut(src, 'app.on("browser-window-created", (_e, win) =>'), up = cut(src, "function updater(");
    t("收工中按 Cmd+Q:before-quit 先擋(restarting === stopping),不再跑一次 stop、不跟 quitAndInstall 搶", /^app\.on\("before-quit", \(e\) => \{\n[^\n]*\n  if \(restarting === "stopping"\) \{ e\.preventDefault\(\); return; \}/.test(bq));
    t("收工中按紅燈:只收視窗;交給 quitAndInstall 之後放行(它要關視窗才能重開)", /if \(restarting === "stopping"\) \{ e\.preventDefault\(\); win\.hide\(\); return; \}/.test(close));
    t("before-quit 兩道確認框:showMain 在設 quitAsking 之前、包在 try(稽核 P2-1)", (bq.match(/try \{ showMain\(\); \} catch \(_\) \{[^}]*\}\n    quitAsking = true;/g) || []).length === 2 && !/quitAsking = true;\n    showMain\(\);/.test(bq));
    t("quitAndInstall 自己失敗(Squirrel 非同步出錯,phase → error)而 restarting = installing:改走 app.quit()", /if \(restarting === "installing" && st\.phase === "error"\) app\.quit\(\);/.test(up)); }

  // ── §4 askMoveToApps ──
  const moveRig = (o) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blave-move-")), log = [], errs = [], tracked = [];
    if (o.declined) fs.writeFileSync(path.join(dir, "move-declined.json"), "{}");
    const win = { destroyed: false, isDestroyed() { return this.destroyed; } };
    const ctx = { tmLabels: o.noLabels ? { moveTitle: "", moveBody: "", moveGo: "", moveNo: "" } : { ...L }, shouldAskMove, fs, path, moveAsked: !!o.askedBefore,
      quitting: false, quitConfirmed: false, activeTurn: null, turnStarting: false, win,
      process: { platform: o.platform || "darwin" }, BrowserWindow: { getAllWindows: () => [win] }, tradeMaybeLive: () => (o.trading ? { venue: "x" } : null),
      tm: () => ({ track: (ev, p) => tracked.push(ev + ":" + p.name) }), console: { error: (e) => errs.push(String(e)) },
      app: { isPackaged: o.packaged !== false, getPath: () => dir, isInApplicationsFolder: () => { log.push("inApps?"); return !!o.inApps; },
        moveToApplicationsFolder: () => { log.push("move"); if (o.moveThrows) throw new Error("perm"); return o.moveRes !== false; } },
      dialog: { showMessageBox: (_w, opts) => { log.push("dialog"); ctx.box = opts; if (o.onDialog) o.onDialog(ctx); return Promise.resolve({ response: o.response }); } } };
    const fn = new Function("ctx", "with (ctx) { " + MOVE_PATH + "\n" + MOVE + "\n return askMoveToApps; }")(ctx);
    const marked = () => fs.existsSync(path.join(dir, "move-declined.json"));
    return { fn, log, errs, tracked, ctx, marked, dir };
  };
  { const m = moveRig({ response: 0 }), r = await m.fn();
    t("按「不要移」:寫下記號、沒呼叫 move;不送埋點", r === false && m.marked() && !m.log.includes("move") && m.tracked.length === 0, m.log);
    const b = m.ctx.box;
    t("詢問框:question、標題 / 內文 tm.move.*、鈕 [不要移, 移到應用程式]、預設是「移」、Esc 是「不要移」", b.type === "question" && b.message === L.moveTitle && b.detail === L.moveBody
      && JSON.stringify(b.buttons) === JSON.stringify([L.moveNo, L.moveGo]) && b.defaultId === 1 && b.cancelId === 0, b);
    t("…同一次啟動再叫:不問第二次", (await m.fn()) === false && m.log.filter((x) => x === "dialog").length === 1);
    t("…之後的啟動:有記號就永遠不問", await (async () => { const n = moveRig({ response: 1, declined: true }); return (await n.fn()) === false && !n.log.includes("dialog"); })()); }
  { const m = moveRig({ response: 1 }), r = await m.fn();
    t("按「移」、搬成功(true):沒寫記號、回 true(app 自己重開);按下就送 feature_used app_move(成功會立刻重開,事後送不出去)", r === true && !m.marked() && m.log.join() === "inApps?,dialog,move" && m.tracked.join() === "feature_used:app_move", m.log); }
  { const m = moveRig({ response: 1, moveRes: false }), r = await m.fn();
    t("授權框按取消(false):沒寫記號,下次啟動再問", r === false && !m.marked()); }
  { const m = moveRig({ response: 1, moveThrows: true }); let threw = false, r = null;
    try { r = await m.fn(); } catch (_) { threw = true; }
    t("搬移拋例外:不往外拋、沒寫記號、留一行 log", !threw && r === false && !m.marked() && m.errs.some((e) => /\[move\] perm/.test(e)), m.errs); }
  { const m = moveRig({ response: 1, noLabels: true });
    t("畫面還沒交字(tmLabels 空的):不問(中文用戶不先看到英文)", (await m.fn()) === false && m.log.length === 0); }
  // 稽核 P2-2:框開著的時候開始下單 / 開始回合 → 按了「移」也不搬、不記
  { const m = moveRig({ response: 1, onDialog: (c) => { c.tradeMaybeLive = () => ({ venue: "x" }); } }), r = await m.fn();
    t("按「移」之前那段時間開始下單:這次不搬、不記「不要」(搬移會走結束攔截,被擋下會從垃圾桶的 bundle 繼續跑)", r === false && !m.log.includes("move") && !m.marked(), m.log); }
  { const m = moveRig({ response: 1, onDialog: (c) => { c.turnStarting = true; } }), r = await m.fn();
    t("按「移」之前那段時間開始回合:同上,不搬、不記", r === false && !m.log.includes("move") && !m.marked(), m.log); }
  // 稽核 P2-5:框是因為 app 在結束 / 視窗被關才回 cancelId 的 → 用戶沒選,不記成「不要」
  { const m = moveRig({ response: 0, onDialog: (c) => { c.quitting = true; } }), r = await m.fn();
    t("框開著時 app 開始結束(quitting),回 0:不記「不要」", r === false && !m.marked()); }
  { const m = moveRig({ response: 0, onDialog: (c) => { c.win.destroyed = true; } }), r = await m.fn();
    t("框開著時 parent 視窗被關掉,回 0:不記「不要」", r === false && !m.marked()); }
  { const m = moveRig({ response: 1, trading: true });
    t("下單中:這次不問,也不記成「不要」", (await m.fn()) === false && !m.log.includes("dialog") && !m.marked()); }
  { const m = moveRig({ response: 1, inApps: true });
    t("已經在「應用程式」裡:不問", (await m.fn()) === false && !m.log.includes("dialog")); }
  { const m = moveRig({ response: 1, platform: "win32" }), n = moveRig({ response: 1, packaged: false });
    t("Windows、開發版:不問,也不叫 macOS 限定的 isInApplicationsFolder", (await m.fn()) === false && m.log.length === 0 && (await n.fn()) === false && n.log.length === 0); }
  t("接線:trade-labels 第一次收到字才判一次(moveChecked),包在 startStep 裡、Promise 的錯誤只留 log",
    /if \(!moveChecked\) \{ moveChecked = true; startStep\("move to apps", \(\) => \{ askMoveToApps\(\)\.catch\(/.test(cut(src, 'ipcMain.on("trade-labels", (e, labels) =>')));
  t("記號檔在 userData(同 p1-notified.json 的做法)、只寫一個小 JSON", /const moveDeclinedPath = \(\) => path\.join\(app\.getPath\("userData"\), "move-declined\.json"\);/.test(src) && /fs\.writeFileSync\(moveDeclinedPath\(\), JSON\.stringify\(\{ declined: true \}\), \{ mode: 0o600 \}\)/.test(MOVE));

  // ── 稽核 P2-4:.app 換了位置之後 venv 的 python 是斷掉的連結 → 開機就修、修好就起 daemon(不等送第一句話)──
  { const TSI = cut(src, "function tradeStartIfReady("), VLB = cut(src, "function venvLinkBroken("), EES = cut(src, "function ensureEngineShared(");
    const venv = (o) => {
      const log = []; let linkOk = !o.broken, runs = 0; const pend = [];
      const ctx = { WIN: !!o.win, VENV_PY: "/b/venv/bin/python", WS: "/b/ws", venvRepairTried: false, _engineRun: null, console: { error: (m) => log.push("err:" + m) },
        fs: { existsSync: (p) => (p === "/b/venv/bin/python" ? linkOk : true), lstatSync: () => ({ isSymbolicLink: () => true }) },
        tradeHost: () => ({ start: () => log.push("daemon") }), binanceLink: () => ({ start: () => log.push("binance") }),
        ensureEngine: () => { runs++; log.push("ensure"); return new Promise((ok, no) => pend.push(() => { if (o.fail) no(new Error("pip")); else { if (!o.stillBroken) linkOk = true; ok(); } })); } };
      const api = new Function("ctx", "with (ctx) { " + [TSI, VLB, EES].join("\n") + "\n return { tradeStartIfReady, ensureEngineShared }; }")(ctx);
      return { api, log, ctx, runs: () => runs, finish: async () => { while (pend.length) pend.shift()(); await tick(); await tick(); } };
    };
    { const v = venv({ broken: false }); v.api.tradeStartIfReady();
      t("venv 好的:照舊直接起 daemon,不修", v.log.join() === "daemon,binance"); }
    { const v = venv({ broken: true }); v.api.tradeStartIfReady();
      t("斷掉的連結:不起 daemon、先修(ensureEngine)", v.log.join() === "ensure" && v.runs() === 1);
      const p2 = v.api.ensureEngineShared();
      t("修的途中送第一句話(ensure-engine):共用同一份,不再跑第二支 -m venv / pip", v.runs() === 1);
      await v.finish(); await p2;
      t("修好之後自己起 daemon(進度不經這裡:enginesetup 的快照推給畫面)", v.log.join() === "ensure,daemon,binance", v.log);
      v.api.tradeStartIfReady(); t("…之後再叫:照舊起(不再修)", v.runs() === 1); }
    { const v = venv({ broken: true, fail: true }); v.api.tradeStartIfReady(); await v.finish();
      t("修失敗:只留一行 log、不起 daemon、不拋;這次啟動不再自動試(留給送訊息那條路)", v.log[0] === "ensure" && v.log.some((x) => /venv repair failed/.test(x)) && !v.log.includes("daemon") && (v.api.tradeStartIfReady(), v.runs() === 1), v.log); }
    { const v = venv({ broken: true, stillBroken: true }); v.api.tradeStartIfReady(); await v.finish();
      t("修完還是斷的:不起、不迴圈", v.runs() === 1 && !v.log.includes("daemon")); }
    { const v = venv({ broken: true, win: true }); v.api.tradeStartIfReady();
      t("Windows:venv 沒有連結,不走這條", v.runs() === 0 && v.log.length === 0); }
    t("接線:ensure-engine 與開 app 的背景安裝都走 ensureEngineShared(同一份);快照只送給我們的頁", /handle\("ensure-engine", \(\) => ensureEngineShared\(\)\.then\(\(r\) => \{ tradeStartIfReady\(\); return r; \}\)\);/.test(src)
      && /function engineKick\(\) \{\s*ensureEngineShared\(\)/.test(src) && (src.match(/ensureEngine\(/g) || []).length === 2
      && /if \(!w\.isDestroyed\(\) && isOurPageUrl\(w\.webContents\.getURL\(\)\)\) w\.webContents\.send\("engine-state", s\)/.test(src)); }

  // ── 0.1.12 結束 app:背景安裝的 pip 在跑就先收掉(稽核 0.1.12 P1-1);沒在裝、常駐程式也沒在跑就直接放行 ──
  { const BQ = cut(src, 'app.on("before-quit", (e) => {');
    const quitRig = (o) => {
      const log = [], ctx = { restarting: null, quitting: false, quitConfirmed: false, quitAsking: false, activeTurn: null, turnStarting: false, tradeMaybeLive: () => null,
        _tradeHost: o.daemon ? { isRunning: () => true, stop: () => new Promise((ok) => setTimeout(() => { log.push("daemon:stopped"); ok(); }, 10)) } : null,
        _engineSetup: { busy: () => !!o.installing }, engineAbort: () => new Promise((ok) => setTimeout(() => { log.push("engineAbort"); ok(true); }, 5)),
        app: { on: (ev, fn) => { ctx.handler = fn; }, quit: () => log.push("app.quit") } };
      new Function("ctx", "with (ctx) { " + BQ + "); }")(ctx);
      return { fire: async () => { const e = { prevented: false, preventDefault() { this.prevented = true; } }; ctx.handler(e); await sleep(40); return e.prevented; }, log, ctx };
    };
    { const q = quitRig({ installing: true }); const prevented = await q.fire();
      t("結束 app、pip 在跑:先攔下、收掉 pip、再 app.quit()", prevented && q.log.join() === "engineAbort,app.quit" && q.ctx.quitting === true, q.log); }
    { const q = quitRig({ installing: true, daemon: true }); await q.fire();
      t("…常駐程式也在跑:兩個都收完才 app.quit()", q.log.includes("engineAbort") && q.log.includes("daemon:stopped") && q.log[q.log.length - 1] === "app.quit", q.log); }
    { const q = quitRig({}); const prevented = await q.fire();
      t("…都沒在跑:不攔、不收", !prevented && q.log.length === 0, q.log); } }
  // ── 接線:三個入口都走 restartToUpdate ──
  t("IPC update-install 改叫 restartToUpdate", /ipcMain\.handle\("update-install", \(e\) => \(!fromOurPage\(e\) \? \{ ok: false, error: "NOT_ALLOWED" \} : restartToUpdate\(\)\)\);/.test(src));
  t("選單列那一行 click = restartToUpdate()", /click: \(\) => \{ restartToUpdate\(\)\.catch\(/.test(cut(src, "function trayMenu(")));
  t("埋點只用 feature_used 的兩個 name(不開新事件型別):update_restart 在 restartToUpdate、app_move 在 askMoveToApps", (RESTART.match(/tm\(\)\.track\(/g) || []).length === 1 && /tm\(\)\.track\("feature_used", \{ name: "update_restart" \}\)/.test(RESTART)
    && (MOVE.match(/tm\(\)\.track\(/g) || []).length === 1 && /tm\(\)\.track\("feature_used", \{ name: "app_move" \}\)/.test(MOVE) && !/update_restart|app_move/.test(Object.keys(require("../shell/telemetry.js").EVENTS).join()));

  // ── §5 明確不做(列舉式原文掃描)──
  const shellJs = fs.readdirSync(SHELL).filter((f) => /\.js$/.test(f)).map((f) => [f, fs.readFileSync(path.join(SHELL, f), "utf8")])
    .concat(fs.readdirSync(path.join(SHELL, "renderer")).filter((f) => /\.js$/.test(f)).map((f) => ["renderer/" + f, fs.readFileSync(path.join(SHELL, "renderer", f), "utf8")]));
  const qai = shellJs.flatMap(([f, s]) => [...s.matchAll(/quitAndInstall\(/g)].map((m) => [f, m.index]));
  const upInstall = cut(upSrc, "function install(");
  t("§5 quitAndInstall 整個外殼只出現一次,在 updater.js 的 install() 裡", qai.length === 1 && qai[0][0] === "updater.js" && upInstall.includes("quitAndInstall("), qai);
  const rs = src.indexOf(RESTART), re = rs + RESTART.length;
  const installs = [...src.matchAll(/\.install\(\)/g)].map((m) => m.index);
  t("§5 main.js 裡每一個 .install() 都在 restartToUpdate 裡面", installs.length >= 1 && installs.every((i) => i > rs && i < re), installs.length);
  const callers = src.split("\n").filter((l) => /restartToUpdate\(/.test(l) && !/async function restartToUpdate\(/.test(l) && !/^\s*(\/\/|\/\*|\*)/.test(l));
  t("§5 restartToUpdate 只有兩個呼叫點(IPC、選單列那一行),都不在計時器裡", callers.length === 2 && callers.every((l) => !/setTimeout|setInterval|setImmediate/.test(l)), callers);
  t("§5 restartToUpdate / askMoveToApps / updater.js 裡沒有計時器、沒有系統通知", ![RESTART, MOVE].some((s) => /setTimeout|setInterval|new Notification/.test(s)) && !/new Notification/.test(upSrc)
    && !/setTimeout\([^\n]*(install|restartToUpdate)/.test(src) && !/setInterval\([^\n]*(install|restartToUpdate)/.test(src));
  t("§5 5 秒那一輪只叫 poll()(推畫面),不叫 install / restartToUpdate", /startStep\("update poll", \(\) => updater\(\)\.poll\(\)\)/.test(cut(src, "function trayStart(")) && !/install|restartToUpdate/.test(cut(src, "function trayStart(")));

  // ── 字 ──
  const po = { zh: fs.readFileSync(path.join(SHELL, "i18n", "zh.po"), "utf8"), en: fs.readFileSync(path.join(SHELL, "i18n", "en.po"), "utf8") };
  const W = { zh: { "tm.updateBody": "重新啟動之後，這台電腦就不會再下單，也不會平倉；部位留在{venue}。重開後要重新按「啟動下單」。", "tm.move.title": "把 Blave 移到「應用程式」資料夾？",
      "tm.move.body": "在這裡 Blave 無法自動更新。移過去後會自動重新開啟。", "tm.move.go": "移到應用程式", "tm.move.no": "不要移" },
    en: { "tm.updateBody": "After the restart, this computer places no more orders and closes nothing; positions stay at {venue}. Press Start trading to resume.",
      "tm.move.title": "Move Blave to the Applications folder?", "tm.move.body": "Blave can’t update itself from here. It reopens after the move.", "tm.move.go": "Move to Applications", "tm.move.no": "Don’t Move" } };
  t("五個新 key 兩語逐字在 .po(spec §1 / §4)", ["zh", "en"].every((l) => Object.keys(W[l]).every((k) => po[l].includes('msgid "' + k + '"\nmsgstr "' + W[l][k] + '"\n'))));
  const trSrc = fs.readFileSync(path.join(SHELL, "renderer", "trade.js"), "utf8");
  t("trPushLabels 交這五個;tmLabels 的 updateBody 英文退路 = en、move 四個預設空的(沒交字就不問)", /updateBody: t\("tm\.updateBody"\), moveTitle: t\("tm\.move\.title"\), moveBody: t\("tm\.move\.body"\), moveGo: t\("tm\.move\.go"\), moveNo: t\("tm\.move\.no"\)/.test(trSrc)
    && src.includes('updateBody: "' + W.en["tm.updateBody"] + '",') && /moveTitle: "", moveBody: "", moveGo: "", moveNo: "",/.test(src));
  t("up.row.readyQuit 刪乾淨(.po、strings.js、程式都沒有)", !/readyQuit/.test(po.zh + po.en + S + shellJs.map((x) => x[1]).join("")));

  await tick();
  console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0);
})();
