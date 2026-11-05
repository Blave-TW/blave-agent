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
const L = { quitTitle: zh("tm.quitTitle"), quitCloudNote: zh("tm.quitCloudNote"), quitStay: zh("tm.quitStay"), updateReady: zh("tm.updateReady"), paperVenue: "模擬交易",
  moveTitle: zh("tm.move.title"), moveBody: zh("tm.move.body"), moveGo: zh("tm.move.go"), moveNo: zh("tm.move.no"),
  moveAuthExists: zh("tm.move.authExists"), moveAuthApps: zh("tm.move.authApps"), gotIt: zh("src.gotIt") };

const RESTART = cut(src, "async function restartToUpdate("), MOVE = cut(src, "async function askMoveToApps(");
const MOVE_PATH = /^const moveDeclinedPath = [^\n]*;$/m.exec(src)[0];

// ── §0 / §1 restartToUpdate(0.1.36 起確認一律在 app 內的更新 modal:updAsk 叫畫面開框;spec desktop-update-pill §4)──
// 假收工同 probe(稽核 scratchpad/audit-0110/probe.js):stop 收完 child 才清掉,之後 tradeMaybeLive 才變 null(daemon.js 的實際行為)
// updAsk 用假的(畫面那一端);真的 updAsk 往返與取消在 tests/check_shell_update_pill.js
const READY = { credentials: true, pair: true, order: true, account: true };
function rig(o) {
  const log = [], boxes = [], tracked = [];
  let quitConfirmed = false, child = !!o.trading, phase = o.phase || "blocked", nAsk = 0;
  const ctx = {
    // 草稿:沒給 o.draft = 已經問過(draftOk);給了就是畫面上有 / 沒有草稿(draftDirty 只在下單中那一支叫)
    draftOk: o.draft === undefined, draftNote: false,
    draftDirty: async () => { log.push("draftDirty"); if (o.stopDuringDraft) child = false; return o.draft === "dirty"; },
    draftGate: async () => { log.push("draftGate"); return true; },
    quitAsking: !!o.asking, moveAsking: !!o.moveAsking, quitting: false, restarting: null, setRestarting: (v) => { ctx.restarting = v; }, noteManualTarget: () => { log.push("noteManual"); }, installWatch: () => { log.push("installWatch"); }, anyTurn() { return !!(this.activeTurn || this.turnStarting); }, anyTurnOrQueued() { return !!(this.activeTurn || this.turnStarting); }, turnQueue: [], liveTurnCount() { return this.activeTurn || this.turnStarting ? 1 : 0; }, activeTurn: o.turn ? {} : null, turnStarting: false, tmLabels: { ...L }, TT: { quitDetail: TT.quitDetail, cloudTrading: (s) => !!(s && s.trading), stayGo: TT.stayGo }, process: { platform: o.platform || "darwin" },
    planRestart, cloudSt: () => (o.cloud ? { trading: true } : null), BrowserWindow: { getAllWindows: () => [] },
    tradeMaybeLive: () => (child ? { venue: "binance" } : null), venueName: (id) => (id === "binance" ? "Binance" : ""),
    showMain: () => { log.push("showMain"); },
    tm: () => ({ track: (ev, p) => { tracked.push(ev + ":" + p.name); log.push("used"); } }),
    dialog: { showMessageBox: () => { log.push("NATIVE DIALOG"); return Promise.resolve({ response: 0 }); } },
    updAsk: (kind, data) => { boxes.push({ kind, data }); log.push("ask:" + kind); nAsk++; if (o.onAsk) o.onAsk(nAsk, kind); const go = typeof o.go === "function" ? o.go(nAsk, kind) : !!o.go; return Promise.resolve(go); },
    updater: () => ({ state: () => ({ phase, version: "0.1.36" }), install: () => { const res = o.installRes || (phase !== "ready" && phase !== "blocked" ? { ok: false, error: "NOT_READY" } : child ? { ok: false, error: "TRADING" } : { ok: true }); log.push("install:" + (res.ok ? "ok" : res.error)); if (o.installThrows) throw new Error("boom"); return res; } }),
    app: { quit: () => log.push("app.quit") },
    _tradeHost: { status: () => ({ report: { venues: o.venues || { binance: READY } } }), noteQuit: () => { log.push("noteQuit"); if (o.noteQuitThrows) throw new Error("note"); },
      stop: () => { log.push("stop:start"); return new Promise((ok) => setTimeout(() => { child = false; log.push("stop:done"); ok(); }, 30)); } },
    console: { error: () => {} },
    // 0.1.12:背景安裝的 pip 在跑時要先收掉(稽核 0.1.12 P1-1);沒在裝時是立刻回來的 no-op,不進 log
    engineAbort: () => (o.installing ? new Promise((ok) => setTimeout(() => { log.push("engineAbort"); ok(true); }, 10)) : Promise.resolve(false)),
  };
  Object.defineProperty(ctx, "quitConfirmed", { get: () => quitConfirmed, set: (v) => { quitConfirmed = v; log.push("quitConfirmed=" + v); } });
  ctx.venueReady = (v) => !!(v && v.credentials && v.pair && v.order && v.account);
  ctx.tradePaperOnly = new Function("ctx", "with (ctx) { " + cut(src, "function tradePaperOnly(") + "\n return tradePaperOnly; }")(ctx);
  const fn = new Function("ctx", "with (ctx) { " + RESTART + "\n return restartToUpdate; }")(ctx);
  return { run: (opts) => fn(opts), log, boxes, tracked, ctx, confirmed: () => quitConfirmed, setPhase: (p) => { phase = p; } };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  { const r = rig({ trading: false, phase: "ready", draft: "clean" }), res = await r.run({ confirmed: true });
    t("沒在下單、畫面已開過 §4.1(confirmed):直接 install,不再問、不跑 draftGate;裝成才送埋點 feature_used update_restart", res.ok === true && r.log.join() === "install:ok,noteManual,used,installWatch" && r.ctx.restarting === "installing" && r.boxes.length === 0 && r.tracked.join() === "feature_used:update_restart" && r.ctx.draftOk === true, r.log); }
  { const r = rig({ trading: false, phase: "ready", draft: "dirty" }), res = await r.run({ confirmed: true });
    t("…有草稿也不跑 draftGate、不跳系統框(草稿那句 §4.1 已經講了)", res.ok === true && !r.log.includes("draftGate") && !r.log.includes("draftDirty") && !r.log.includes("NATIVE DIALOG"), r.log); }
  { const r = rig({ trading: false, phase: "ready", go: true }), res = await r.run();
    t("沒在下單、沒帶 confirmed(選單列入口):主行程叫畫面開 §4.1(plain、帶已暫存的版號),按重新啟動才 install", res.ok === true && r.log.join() === "ask:plain,install:ok,noteManual,used,installWatch" && r.boxes[0].data.v === "0.1.36", r.log); }
  { const r = rig({ trading: false, phase: "ready", go: false, draft: "clean" }), res = await r.run();
    t("…§4.1 按取消:回 CANCELED,不 install、不送埋點、draftOk 不設", res.error === "CANCELED" && r.log.join() === "ask:plain" && r.tracked.length === 0 && r.ctx.draftOk === false, r.log); }
  for (const bad of [{ confirmed: "true" }, { confirmed: 1 }, "confirmed", null]) {
    const r = rig({ trading: false, phase: "ready", go: false }); await r.run(bad);
    t("confirmed 只認 === true(" + JSON.stringify(bad) + " 當沒帶,照樣先問)", r.log.join() === "ask:plain", r.log); }
  { const r = rig({ trading: false, phase: "ready", draft: "clean", installRes: { ok: false, error: "NOT_READY" } }), res = await r.run({ confirmed: true });
    t("…install 沒成:收回 draftOk、不送埋點(不多算,稽核 P2-6)", res.ok === false && r.ctx.draftOk === false && r.tracked.length === 0, r.log); }
  { const r = rig({ trading: true, go: true, draft: "dirty" }), res = await r.run();
    t("下單中、有草稿:主行程用 draftDirty 判,草稿那句併進 §4.2(unsaved: true);按確認照樣停單收工再 install,draftOk 記下",
      res.ok === true && r.log[0] === "draftDirty" && !r.log.includes("draftGate") && r.boxes.length === 1 && r.boxes[0].kind === "trading" && r.boxes[0].data.unsaved === true && r.log.includes("install:ok") && r.ctx.draftOk === true, [r.log, r.boxes]); }
  { const r = rig({ trading: true, go: false, draft: "dirty" }), res = await r.run();
    t("…按取消:什麼都不動、draftOk 不設", res.error === "CANCELED" && !r.log.includes("stop:start") && !r.log.some((x) => /^install/.test(x)) && r.ctx.draftOk === false, r.log); }
  { const r = rig({ trading: true, go: false, draft: "clean" }); await r.run();
    t("…下單中、沒有草稿:§4.2 的 unsaved 是 false", r.boxes.length === 1 && r.boxes[0].data.unsaved === false, r.boxes); }
  { const r = rig({ trading: true, go: false }); await r.run({ confirmed: true });
    t("下單中帶 confirmed(§4.1 開著時開始下單):照樣改問 §4.2,不直接裝", r.boxes.length === 1 && r.boxes[0].kind === "trading" && !r.log.some((x) => /^install/.test(x)), r.log); }
  // 稽核 P3-2:下單中按更新、查草稿那段剛好停了單 → 改走直接裝之前要先開 §4.1(草稿那句在那裡)
  { const r = rig({ trading: true, phase: "blocked", draft: "dirty", stopDuringDraft: true, go: false }), res = await r.run();
    t("P3-2 下單中查草稿時剛好停單:改開 §4.1,按取消就不 install", res.error === "CANCELED" && r.log.join() === "draftDirty,ask:plain", r.log); }
  { const r = rig({ trading: true, phase: "blocked", draft: "dirty", stopDuringDraft: true, go: true }), res = await r.run();
    t("P3-2 …§4.1 按重新啟動:問過才 install", res.ok === true && r.log.join() === "draftDirty,ask:plain,install:ok,noteManual,used,installWatch" && r.ctx.draftOk === true, r.log); }
  { const r = rig({ trading: false, phase: "ready" }); let n = 0;
    r.ctx.updAsk = (kind) => { r.boxes.push({ kind }); r.log.push("ask:" + kind); n++; if (n === 1) r.ctx.tradeMaybeLive = () => ({ venue: "binance" }); return Promise.resolve(n === 1); };
    const res = await r.run();
    t("§4.1 開著時開始下單:按重新啟動後主行程改問 §4.2(由主行程回畫面開),不直接裝", r.log.join() === "ask:plain,ask:trading" && res.error === "CANCELED", r.log); }
  // 稽核 P3-1:直接裝送出之後 Squirrel／NSIS 才失敗(onState phase error、restarting 不是 installing):收回 draftOk
  { const ON = cut(src, "const onState = (st) =>").replace(/^const onState = /, ""), log = [];
    const ctx = { BrowserWindow: { getAllWindows: () => [] }, _officialBackup: null, restarting: null, draftOk: true, app: { quit: () => log.push("app.quit") }, installFailed: () => log.push("installFailed"), upNotesKick: (v) => log.push("notes:" + v), _upStaged: null };
    const on = new Function("ctx", "with (ctx) { return (" + ON + "); }")(ctx);
    on({ phase: "ready", version: "0.1.36" }); const kept = ctx.draftOk;
    on({ phase: "error" }); const dropped = ctx.draftOk === false && log.join() === "notes:0.1.36";
    ctx.draftOk = true; ctx.restarting = "installing"; on({ phase: "error" });
    t("P3-1 直接裝之後才失敗:draftOk 收回(下次結束照樣問草稿);installing 之後失敗走 installFailed;進 ready 時抓一次更新說明", kept === true && dropped && log.join() === "notes:0.1.36,installFailed", [kept, dropped, log]); }
  { const r = rig({ trading: false, phase: "ready", installing: true }), res = await r.run({ confirmed: true });
    t("0.1.12 背景安裝的 pip 在跑:先收掉 pip(等它結束)再 install", res.ok === true && r.log.join() === "engineAbort,install:ok,noteManual,used,installWatch", r.log); }
  { const r = rig({ trading: true, go: true, installing: true }), res = await r.run();
    t("0.1.12 下單中、按確認、pip 也在跑:停單收完 → 收 pip → install", res.ok === true && r.log.join() === "ask:trading,used,quitConfirmed=true,noteQuit,stop:start,stop:done,engineAbort,install:ok,noteManual", r.log); }
  { const r = rig({ trading: true, go: false }), res = await r.run();
    t("下單中、按取消:沒 noteQuit、沒 stop、沒 install;回 CANCELED", res.error === "CANCELED" && r.log.join() === "ask:trading", r.log);
    t("…取消後旗標都還原:quitConfirmed 沒設、restarting 沒設(下次結束 / 再按照樣會問)", r.confirmed() === false && r.ctx.restarting === null);
    t("…按取消不送埋點(沒有用到)", r.tracked.length === 0);
    t("§4.2 的內容由主行程算:交易所名(venueName)、雲端在下單與否、草稿;畫面不重算", JSON.stringify(r.boxes[0].data) === '{"venue":"Binance","cloud":false,"unsaved":false,"paper":false}', r.boxes[0]); }
  { const r = rig({ trading: true, go: false, venues: { paper: READY } }); r.ctx.tradeMaybeLive = () => ({ venue: "paper" }); r.ctx.venueName = () => "模擬交易"; await r.run();
    t("§4.2 只有模擬帳戶:paper: true(畫面出模擬記號)", r.boxes[0].data.paper === true, r.boxes[0]); }
  { const r = rig({ trading: true, go: false, venues: { paper: READY, president: READY, binance: { credentials: true } } }); r.ctx.tradeMaybeLive = () => ({ venue: "paper" }); await r.run();
    t("§4.2 模擬加真錢(統一)同時下單:排序後第一個是 paper 也標真錢(paper: false;同畫面 trCfPaperOnly,沒連好的不算)", r.boxes[0].data.paper === false, r.boxes[0]); }
  { const r = rig({ trading: true, go: false }); r.ctx.tradeMaybeLive = () => ({ venue: null }); r.ctx.venueName = () => ""; await r.run();
    t("§4.2 讀不到交易所(tradeMaybeLive 只知道可能在下單):不給 paper、venue 空字串(畫面不出記號、換不帶名字的那句)", !("paper" in r.boxes[0].data) && r.boxes[0].data.venue === "", r.boxes[0]); }
  { const r = rig({ trading: true, cloud: true, go: false }); await r.run();
    t("雲端也確定在下單:§4.2 帶 cloud: true(畫面加 tm.quitCloudNote)", r.boxes[0].data.cloud === true); }
  t("系統原生框退役:restartToUpdate 裡沒有 dialog.showMessageBox、沒有 stayGo、沒有 updateBody", !/showMessageBox|stayGo|updateBody/.test(RESTART));
  { const r = rig({ trading: true, go: true }), res = await r.run();
    t("按確認:順序 quitConfirmed=true → noteQuit → stop 收完 → install(收工走結束 app 同一條)", r.log.join() === "ask:trading,used,quitConfirmed=true,noteQuit,stop:start,stop:done,install:ok,noteManual" && res.ok === true, r.log);
    t("…交給 quitAndInstall 之後 restarting = installing(紅燈、Cmd+Q 放行,它要關視窗才能重開)", r.ctx.restarting === "installing");
    t("…沒有另外接回下單(重開後對帳器照規矩停著)", !/_tradeHost\.(start|send)\(|tradeHost\(\)\.(start|send)\(|tradeStartIfReady|"resume"/.test(RESTART));
    t("…埋點 feature_used update_restart 一次(確認後,stop 最多 11 秒,送得出去)", r.tracked.join() === "feature_used:update_restart"); }

  // ── 稽核 P1-1:確認到裝好之間(probe A / A2 / B)──
  { const r = rig({ trading: true, go: true }); const p1 = r.run(); await sleep(10);
    t("收工中 restarting = stopping(send-message 回忙碌、選單列那一行停用、紅燈只收視窗都看它)", r.ctx.restarting === "stopping");
    const p2 = r.run(); const res = await Promise.all([p1, p2]);
    t("A 收工中再按一次:不開第二個框、noteQuit / stop / install 各一次,第二次回 ASKING", r.boxes.length === 1 && r.log.filter((x) => x === "noteQuit").length === 1 && r.log.filter((x) => x === "stop:start").length === 1
      && r.log.filter((x) => /^install/.test(x)).length === 1 && res[1].error === "ASKING", [r.log, res]); }
  { const r = rig({ trading: true, go: true }); const p1 = r.run(); await sleep(10);
    const src2 = cut(src, "async function startTurn(");
    t("B 收工中送聊天:startTurn 把 restarting 算進忙碌(回合開不起來,不會被無聲砍掉)", /if \(restarting \|\| turns\.has\(sid\)\) return \{ busy: true \};/.test(src2) && !!r.ctx.restarting); await p1; }
  { const r = rig({ trading: true }); r.ctx.updAsk = (kind) => { r.boxes.push({ kind }); r.log.push("ask:" + kind); r.ctx.turnStarting = true; return Promise.resolve(true); };
    const res = await r.run();
    t("框開著時回合開始了(程式觸發):按確認也不收工,回 TURN_BUSY,旗標不動", res.error === "TURN_BUSY" && !r.log.includes("noteQuit") && !r.log.includes("stop:start") && r.confirmed() === false && r.ctx.restarting === null, r.log); }
  // ── 稽核 P1-2:收工前 phase 變了 / 收工後沒裝成(probe C)──
  { const r = rig({ trading: true }); r.ctx.updAsk = (kind) => { r.boxes.push({ kind }); r.log.push("ask:" + kind); r.setPhase("error"); return Promise.resolve(true); };
    const res = await r.run();
    t("C 框開著時 updater 出錯(phase → error):不收工、回 NOT_READY、quitConfirmed 沒設", res.error === "NOT_READY" && !r.log.includes("noteQuit") && !r.log.includes("stop:start") && r.confirmed() === false && r.ctx.restarting === null, r.log); }
  { const r = rig({ trading: true, go: true }); const p = r.run(); await sleep(10); r.setPhase("error"); const res = await p;
    t("C' 收工期間 phase → error、install 回 NOT_READY:改走 app.quit()(已同意停單,不留停一半、app 沒重開)", r.log.slice(-2).join() === "install:NOT_READY,app.quit" && res.quit === true, r.log); }
  { const r = rig({ trading: true, go: true, installRes: { ok: false, error: "TRADING" } }), res = await r.run();
    t("收工後 install 不管回什麼錯(TRADING 也一樣):一律 app.quit()", r.log.slice(-2).join() === "install:TRADING,app.quit" && res.quit === true, r.log); }
  { const r = rig({ trading: true, go: true, noteQuitThrows: true }); let threw = false, res = null; try { res = await r.run(); } catch (_) { threw = true; }
    t("確認後整段拋例外(noteQuit 炸了):不往外拋,改走 app.quit()", !threw && res && res.quit === true && r.log.slice(-1)[0] === "app.quit", r.log); }
  { const r = rig({ trading: true, go: true, installThrows: true }); let threw = false; try { await r.run(); } catch (_) { threw = true; }
    t("install 拋例外:同上,app.quit()", !threw && r.log.slice(-1)[0] === "app.quit", r.log); }
  { const r = rig({ trading: true, asking: true }), res = await r.run();
    t("已經有確認框開著(quitAsking,跟結束攔截共用):不疊第二個,回 ASKING", res.error === "ASKING" && r.boxes.length === 0 && r.log.length === 0); }
  { const r = rig({ trading: true, moveAsking: true }), res = await r.run();
    t("搬移框開著(moveAsking):更新重開也不疊框,回 ASKING(稽核 integ-0124 P2-2)", res.error === "ASKING" && r.boxes.length === 0 && r.log.length === 0); }
  { const r = rig({ trading: true }); r.ctx.quitting = true; const res = await r.run();
    t("app 已經在結束(quitting):不問、不收工,回 ASKING", res.error === "ASKING" && r.log.length === 0); }
  { const r = rig({ trading: false, turn: true, phase: "ready" }), res = await r.run({ confirmed: true });
    t("本機回合在跑:回 TURN_BUSY、不裝(帶 confirmed 也一樣)", res.error === "TURN_BUSY" && r.log.length === 0); }
  { const r = rig({ trading: false, phase: "downloading" }), res = await r.run({ confirmed: true });
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
    t("restartToUpdate 設 restarting 一律經 setRestarting(沒有直接賦值)", !/\brestarting = /.test(RESTART) && (RESTART.match(/setRestarting\(/g) || []).length === 5
      && /handle\("update-state", \(\) => \(\{ \.\.\.updater\(\)\.state\(\), backup: _officialBackup, restarting: !!restarting \}\)\);/.test(src)
      && /send\("update-state", \{ \.\.\.st, backup: _officialBackup, restarting: !!restarting \}\)/.test(src)); }

  // ── 主行程其他接點(原文)──
  { const bq = cut(src, 'app.on("before-quit", (e) =>'), close = cut(src, 'app.on("browser-window-created", (_e, win) =>'), up = cut(src, "function updater(");
    t("收工中按 Cmd+Q:before-quit 先擋(restarting === stopping),不再跑一次 stop、不跟 quitAndInstall 搶", /^app\.on\("before-quit", \(e\) => \{\n[^\n]*\n  if \(restarting === "stopping"\) \{ e\.preventDefault\(\); return; \}/.test(bq));
    t("收工中按紅燈:只收視窗;交給 quitAndInstall 之後放行(它要關視窗才能重開)", /if \(restarting === "stopping"\) \{ e\.preventDefault\(\); win\.hide\(\); return; \}/.test(close));
    t("before-quit 兩道確認框:showMain 在設 quitAsking 之前、包在 try(稽核 P2-1)", (bq.match(/try \{ showMain\(\); \} catch \(_\) \{[^}]*\}\n    quitAsking = true;/g) || []).length === 2 && !/quitAsking = true;\n    showMain\(\);/.test(bq));
    t("quitAndInstall 自己失敗(Squirrel 非同步出錯,phase → error)而 restarting = installing:走 installFailed(下面逐條跑)", /if \(restarting === "installing" && st\.phase === "error"\) installFailed\(\);/.test(up)); }

  // ── §4 askMoveToApps ──
  const moveRig = (o) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blave-move-")), log = [], errs = [], tracked = [];
    if (o.declined) fs.writeFileSync(path.join(dir, "move-declined.json"), "{}");
    const win = { destroyed: false, isDestroyed() { return this.destroyed; } };
    const ctx = { tmLabels: o.noLabels ? { moveTitle: "", moveBody: "", moveGo: "", moveNo: "" } : o.noAuthLabels ? { ...L, moveAuthExists: "", moveAuthApps: "", gotIt: "" } : { ...L }, shouldAskMove, fs, path, moveAsked: !!o.askedBefore,
      quitting: false, quitConfirmed: false, quitAsking: false, moveAsking: false, anyTurn() { return !!(this.activeTurn || this.turnStarting); }, anyTurnOrQueued() { return !!(this.activeTurn || this.turnStarting); }, turnQueue: [], liveTurnCount() { return this.activeTurn || this.turnStarting ? 1 : 0; }, activeTurn: null, turnStarting: false, win,
      process: { platform: o.platform || "darwin" }, BrowserWindow: { getAllWindows: () => [win] }, tradeMaybeLive: () => (o.trading ? { venue: "x" } : null),
      tm: () => ({ track: (ev, p) => tracked.push(ev + ":" + p.name) }), console: { error: (e) => errs.push(String(e)) },
      engineSetup: () => ({ busy: () => !!(o.engineBusy || ctx.engineBusyNow), snapshot: () => ({ phase: ctx.enginePhase || "idle" }) }),
      _engineRun: null, moveNeedsAuth: (exe) => { log.push("auth?" + (exe === dir ? "" : ":" + exe)); return !!(o.needsAuth || ctx.needsAuthNow); },
      moveAuthReason: (exe) => { log.push("auth?" + (exe === dir ? "" : ":" + exe)); return o.needsAuth ? o.needsAuth === true ? "apps" : o.needsAuth : null; },
      app: { isPackaged: o.packaged !== false, getPath: () => dir, isInApplicationsFolder: () => { log.push("inApps?"); return !!o.inApps; },
        moveToApplicationsFolder: () => { log.push("move"); if (o.moveThrows) throw new Error("perm"); return o.moveRes !== false; } },
      dialog: { showMessageBox: (_w, opts) => { log.push("dialog"); ctx.box = opts; if (o.onDialog) o.onDialog(ctx); return Promise.resolve({ response: o.response }); } } };
    const fn = new Function("ctx", "with (ctx) { " + MOVE_PATH + "\n" + MOVE + "\n return askMoveToApps; }")(ctx);
    const marked = () => fs.existsSync(path.join(dir, "move-declined.json"));
    return { fn, log, errs, tracked, ctx, marked, dir };
  };
  { const seen = [], m = moveRig({ response: 1, onDialog: (c) => seen.push(c.moveAsking) }), r = await m.fn();
    const a = [], n = moveRig({ response: 0, needsAuth: "apps", onDialog: (c) => a.push(c.moveAsking) }); await n.fn();
    t("P2-2 搬移框與授權提示框開著時 moveAsking = true,關了還原(before-quit / 更新重開看它不疊框)", r === true && seen.join() === "true" && m.ctx.moveAsking === false && a.join() === "true" && n.ctx.moveAsking === false, [seen, a]); }
  { const m = moveRig({ response: 0 }), r = await m.fn();
    t("按「不要移」:寫下記號、沒呼叫 move;不送埋點", r === false && m.marked() && !m.log.includes("move") && m.tracked.length === 0, m.log);
    const b = m.ctx.box;
    t("詢問框:question、標題 / 內文 tm.move.*、鈕 [不要移, 移到應用程式]、預設是「移」、Esc 是「不要移」", b.type === "question" && b.message === L.moveTitle && b.detail === L.moveBody
      && JSON.stringify(b.buttons) === JSON.stringify([L.moveNo, L.moveGo]) && b.defaultId === 1 && b.cancelId === 0, b);
    t("…同一次啟動再叫:不問第二次", (await m.fn()) === false && m.log.filter((x) => x === "dialog").length === 1);
    t("…之後的啟動:有記號就永遠不問", await (async () => { const n = moveRig({ response: 1, declined: true }); return (await n.fn()) === false && !n.log.includes("dialog"); })()); }
  { const m = moveRig({ response: 1, engineBusy: true }), r = await m.fn();
    t("引擎安裝中(pip 在跑):不問、不搬、不記、不送埋點;下次啟動再問", r === false && !m.log.includes("dialog") && !m.log.includes("move") && !m.marked() && m.tracked.length === 0 && m.ctx.moveAsked === false, m.log); }
  { const m = moveRig({ response: 1, onDialog: (c) => { c.engineBusyNow = true; } }), r = await m.fn();
    t("框開著時引擎開始裝、用戶按「移」:這次不搬、不記", r === false && m.log.includes("dialog") && !m.log.includes("move") && !m.marked(), m.log); }
  { const m = moveRig({ response: 1, needsAuth: true, noAuthLabels: true }), r = await m.fn();
    t("搬移要系統授權、提示的字還沒交:不問、不提示、不叫 moveToApplicationsFolder、不記、不送埋點,留一行 log;下次啟動再判",
      r === false && !m.log.includes("dialog") && !m.log.includes("move") && !m.marked() && m.tracked.length === 0 && m.ctx.moveAsked === false && m.errs.some((e) => /\[move\] needs authorization \(apps\)/.test(e)), m.log); }
  for (const [reason, text] of [["exists", L.moveAuthExists], ["apps", L.moveAuthApps]]) {
    const m = moveRig({ response: 0, needsAuth: reason }), r = await m.fn(), b = m.ctx.box || {};
    t("搬移要系統授權(" + reason + "):跳只有「知道了」的 info 框、字照原因;不搬、不記「不要」、不送埋點",
      r === false && m.log.join() === "auth?,inApps?,dialog" && b.type === "info" && b.message === text && !b.detail && JSON.stringify(b.buttons) === JSON.stringify([L.gotIt])
      && b.defaultId === 0 && b.cancelId === 0 && !m.marked() && m.tracked.length === 0 && m.ctx.moveAsked === true, { log: m.log, b }); }
  { const m = moveRig({ response: 0, needsAuth: "exists" }); await m.fn(); await m.fn();
    t("搬移要系統授權:同一次啟動只跳一次(第二次判斷不再跳)", m.log.filter((x) => x === "dialog").length === 1, m.log); }
  { const m = moveRig({ response: 0, needsAuth: "apps", trading: true }), n = moveRig({ response: 0, needsAuth: "apps", declined: true }), k = moveRig({ response: 0, needsAuth: "apps", engineBusy: true });
    t("搬移要系統授權:下單中、拒絕過、引擎安裝中跟詢問框同一組條件,不提示", (await m.fn()) === false && (await n.fn()) === false && (await k.fn()) === false
      && ![m, n, k].some((x) => x.log.includes("dialog"))); }
  { const m = moveRig({ response: 1, onDialog: (c) => { c.needsAuthNow = true; } }), r = await m.fn();
    t("框開著時變成要授權、用戶按「移」:不叫 moveToApplicationsFolder、不記", r === false && m.log.includes("dialog") && !m.log.includes("move") && !m.marked(), m.log); }
  // ensure() 還在等登入 shell / 鎖檔(_engineRun 在、沒有子行程):等這一輪跑完才判
  { const m = moveRig({ response: 1 }); let done; m.ctx._engineRun = new Promise((ok) => { done = ok; });
    const p = m.fn(); await new Promise((ok) => setImmediate(ok)); const early = m.log.includes("dialog");
    m.ctx._engineRun = null; done(); const r = await p;
    t("引擎那一輪還沒判完(沒有子行程):先不問;判完什麼都不用裝 → 照常問、照常搬", !early && r === true && m.log.includes("dialog") && m.log.includes("move"), m.log); }
  { const m = moveRig({ response: 1 }); let done; m.ctx._engineRun = new Promise((ok) => { done = ok; });
    const p = m.fn(); m.ctx.quitAsking = true; m.ctx._engineRun = null; done(); const r = await p;
    t("等引擎那一輪的期間結束確認框開了:不再疊搬移框、不記", r === false && !m.log.includes("dialog") && !m.marked(), m.log); }
  { const m = moveRig({ response: 1 }); let done; m.ctx._engineRun = new Promise((ok) => { done = ok; });
    const p = m.fn(); m.ctx.enginePhase = "done"; m.ctx._engineRun = null; done(); const r = await p;
    t("…判完之後真的裝了東西(phase 不是 idle):這次不問、不記;下次啟動再問", r === false && !m.log.includes("dialog") && !m.marked() && m.ctx.moveAsked === false, m.log); }
  { const m = moveRig({ response: 1 }); let fail; m.ctx._engineRun = new Promise((_ok, no) => { fail = no; }); m.ctx._engineRun.catch(() => {});
    const p = m.fn(); m.ctx.enginePhase = "fail"; m.ctx._engineRun = null; fail(new Error("pip")); let threw = false, r = null; try { r = await p; } catch (_) { threw = true; }
    t("…那一輪安裝失敗:不往外拋、不問", !threw && r === false && !m.log.includes("dialog"), m.log); }
  { const m = moveRig({ response: 1, onDialog: (c) => { c._engineRun = Promise.resolve(); } }), r = await m.fn();
    t("框開著時引擎那一輪剛開始(還沒有子行程)、用戶按「移」:這次不搬、不記", r === false && m.log.includes("dialog") && !m.log.includes("move") && !m.marked(), m.log); }
  { const m = moveRig({ response: 1 }), r = await m.fn();
    t("按「移」、搬成功(true):沒寫記號、回 true(app 自己重開);按下就送 feature_used app_move(成功會立刻重開,事後送不出去)", r === true && !m.marked() && m.log.join() === "auth?,inApps?,dialog,auth?,move" && m.tracked.join() === "feature_used:app_move", m.log); }
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
  { const m = moveRig({ response: 1, platform: "win32", needsAuth: true }), n = moveRig({ response: 1, packaged: false, needsAuth: true });
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
      const log = [], ctx = { restarting: null, quitting: false, quitConfirmed: false, quitAsking: false, draftOk: true, draftNote: false, draftNoted: (d) => d, moveAsking: !!o.moveAsking, anyTurn() { return !!(this.activeTurn || this.turnStarting); }, anyTurnOrQueued() { return !!(this.activeTurn || this.turnStarting); }, turnQueue: [], liveTurnCount() { return this.activeTurn || this.turnStarting ? 1 : 0; }, activeTurn: o.turn ? {} : null, turnStarting: false,
        tradeMaybeLive: () => (o.live ? { venue: "binance" } : null), showMain: () => log.push("showMain"), BrowserWindow: { getAllWindows: () => [] }, tmLabels: { ...L, quitBody: "q {venue}", quitTitle: "t", quitTurnTitle: "tt", quitTurnBody: "tb" }, venueName: () => "Binance", cloudSt: () => null, twLots: () => ({ pres: { lots: 0, known: true }, cap: { lots: 0, known: true }, held: false }),
        TT: { quitDetail: TT.quitDetail, cloudTrading: () => false, stayGo: TT.stayGo }, process: { platform: "darwin" }, dialog: { showMessageBox: () => { log.push("dialog"); return new Promise(() => {}); } },
        _tradeHost: o.daemon ? { isRunning: () => true, stop: () => new Promise((ok) => setTimeout(() => { log.push("daemon:stopped"); ok(); }, 10)) } : null,
        _codexPkg: o.codex ? { busy: () => true, abort: () => new Promise((ok) => setTimeout(() => { log.push("codexAbort"); ok(true); }, 5)) } : null,   // 0.1.39 Codex 引擎套件下載中
        _engineSetup: { busy: () => !!o.installing, compiling: () => !!o.compiling }, engineAbort: () => new Promise((ok) => setTimeout(() => { log.push("engineAbort"); ok(true); }, 5)),
        app: { on: (ev, fn) => { ctx.handler = fn; }, quit: () => log.push("app.quit") } };
      new Function("ctx", "with (ctx) { " + BQ + "); }")(ctx);
      return { fire: async () => { const e = { prevented: false, preventDefault() { this.prevented = true; } }; ctx.handler(e); await sleep(40); return e.prevented; }, log, ctx };
    };
    { const q = quitRig({ installing: true }); const prevented = await q.fire();
      t("結束 app、pip 在跑:先攔下、收掉 pip、再 app.quit()", prevented && q.log.join() === "engineAbort,app.quit" && q.ctx.quitting === true, q.log); }
    { const q = quitRig({ installing: true, daemon: true }); await q.fire();
      t("…常駐程式也在跑:兩個都收完才 app.quit()", q.log.includes("engineAbort") && q.log.includes("daemon:stopped") && q.log[q.log.length - 1] === "app.quit", q.log); }
    { const q = quitRig({ compiling: true }); const prevented = await q.fire();
      t("…只有背景編 .pyc 在跑(0.1.28):同樣先攔下、收掉(engineAbort 連它一起收)、再 app.quit(),不留孤兒 python", prevented && q.log.join() === "engineAbort,app.quit", q.log); }
    { const q = quitRig({ codex: true }); const prevented = await q.fire();
      t("…只有 Codex 引擎套件在下載(0.1.39):同樣先攔下、收掉下載(殺 tar／關 socket)、再 app.quit()", prevented && q.log.includes("codexAbort") && q.log[q.log.length - 1] === "app.quit", q.log); }
    { const q = quitRig({}); const prevented = await q.fire();
      t("…都沒在跑:不攔、不收", !prevented && q.log.length === 0, q.log); }
    { const a = quitRig({ live: true, moveAsking: true }), b = quitRig({ turn: true, moveAsking: true }), c = quitRig({ live: true });
      const pa = await a.fire(), pb = await b.fire(), pc = await c.fire();
      t("P2-2 搬移框開著時按 Cmd+Q:下單中 / 回合在跑兩道都先擋、不疊結束確認框;沒開搬移框照常問", pa && pb && !a.log.includes("dialog") && !b.log.includes("dialog") && pc && c.log.includes("dialog"), [a.log, b.log, c.log]); } }
  // ── 接線:三個入口都走 restartToUpdate ──
  t("IPC update-install 改叫 restartToUpdate;confirmed 只在過了 fromOurPage 之後才交進去、只認 === true", /ipcMain\.handle\("update-install", \(e, opts\) => \(!fromOurPage\(e\) \? \{ ok: false, error: "NOT_ALLOWED" \} : restartToUpdate\(\{ confirmed: !!\(opts && opts\.confirmed === true\) \}\)\)\);/.test(src));
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
  // 0.1.36 起第二條:每天 06:00 的 scheduledInstall(spec desktop-update-pill §5)。只有它與 restartToUpdate 叫得到 install()
  const SCHED = cut(src, "async function scheduledInstall("), ss = src.indexOf(SCHED), se = ss + SCHED.length;
  const installs = [...src.matchAll(/\.install\(\)/g)].map((m) => m.index);
  t("§5 main.js 裡每一個 .install() 都在 restartToUpdate 或 scheduledInstall 裡面", installs.length >= 2 && installs.every((i) => (i > rs && i < re) || (i > ss && i < se)), installs.length);
  const schedCallers = src.split("\n").filter((l) => /scheduledInstall\(/.test(l) && !/async function scheduledInstall\(/.test(l) && !/^\s*(\/\/|\/\*|\*)/.test(l));
  t("§5 scheduledInstall 只有一個呼叫點:啟動時掛的每分鐘計時器;IPC 叫不到它(handle / ipcMain 那幾行沒有它)", schedCallers.length === 1 && /setInterval\(\(\) => \{ scheduledInstall\(\)\.catch\(/.test(schedCallers[0])
    && !src.split("\n").some((l) => /ipcMain\.|\bhandle\("/.test(l) && /scheduledInstall/.test(l)), schedCallers);
  t("§5 scheduledInstall 不跳任何框、不送 update_restart、不叫 restartToUpdate;判斷交給 schedupdate.js", !/showMessageBox|updAsk|update_restart|restartToUpdate|new Notification/.test(SCHED) && /require\("\.\/schedupdate"\)/.test(SCHED));
  const callers = src.split("\n").filter((l) => /restartToUpdate\(/.test(l) && !/async function restartToUpdate\(/.test(l) && !/^\s*(\/\/|\/\*|\*)/.test(l));
  t("§5 restartToUpdate 只有兩個呼叫點(IPC、選單列那一行),都不在計時器裡", callers.length === 2 && callers.every((l) => !/setTimeout|setInterval|setImmediate/.test(l)), callers);
  t("§5 restartToUpdate / askMoveToApps 裡沒有計時器;updater.js 沒有系統通知;除了排程那一支,沒有計時器叫 install / restartToUpdate", ![RESTART, MOVE].some((s) => /setTimeout|setInterval|new Notification/.test(s)) && !/new Notification/.test(upSrc)
    && !/setTimeout\([^\n]*(install|restartToUpdate)/i.test(src) && src.split("\n").filter((l) => /setInterval\([^\n]*(install|restartToUpdate)/i.test(l)).length === 1);
  t("§5 5 秒那一輪只叫 poll()(推畫面),不叫 install / restartToUpdate", /startStep\("update poll", \(\) => updater\(\)\.poll\(\)\)/.test(cut(src, "function trayStart(")) && !/install|restartToUpdate/.test(cut(src, "function trayStart(")));

  // ── 字 ──
  const po = { zh: fs.readFileSync(path.join(SHELL, "i18n", "zh.po"), "utf8"), en: fs.readFileSync(path.join(SHELL, "i18n", "en.po"), "utf8") };
  const W = { zh: { "tm.updateBody": "重新啟動後，這台電腦不會再下單，也不會平倉。部位留在{venue}，重開後要按「啟動下單」。", "tm.move.title": "把 Blave 移到「應用程式」資料夾？",
      "tm.move.body": "在這裡 Blave 無法自動更新。移過去後會自動重新開啟。", "tm.move.go": "移到應用程式", "tm.move.no": "不要移" },
    en: { "tm.updateBody": "After the restart, this computer places no more orders and closes no positions. Positions stay at {venue}, and it won't trade again until you press Start trading.",
      "tm.move.title": "Move Blave to the Applications folder?", "tm.move.body": "Blave can’t update itself from here. It reopens after the move.", "tm.move.go": "Move to Applications", "tm.move.no": "Don’t Move" } };
  t("五個 key 兩語逐字在 .po(spec §1 / §4;tm.updateBody 0.1.36 改成兩句、去分號)", ["zh", "en"].every((l) => !/[；;]/.test(W[l]["tm.updateBody"])) && ["zh", "en"].every((l) => Object.keys(W[l]).every((k) => po[l].includes('msgid "' + k + '"\nmsgstr "' + W[l][k] + '"\n'))));
  const trSrc = fs.readFileSync(path.join(SHELL, "renderer", "trade.js"), "utf8");
  t("trPushLabels 交 move 四個、不再交 updateBody(§4.2 改由畫面自己翻);tmLabels 沒有 updateBody 退路、move 四個預設空的(沒交字就不問)", /moveTitle: t\("tm\.move\.title"\), moveBody: t\("tm\.move\.body"\), moveGo: t\("tm\.move\.go"\), moveNo: t\("tm\.move\.no"\)/.test(trSrc)
    && !/updateBody/.test(trSrc) && !/updateBody/.test(src) && /moveTitle: "", moveBody: "", moveGo: "", moveNo: "",/.test(src));
  t("提示框的字:兩語逐字在 .po、trPushLabels 交這三個、tmLabels 預設空的",
    po.zh.includes('msgid "tm.move.authExists"\nmsgstr "應用程式資料夾已經有 Blave，請改開那一份。"\n') && po.zh.includes('msgid "tm.move.authApps"\nmsgstr "請把 Blave 拖進應用程式資料夾，才收得到更新。"\n')
    && po.en.includes('msgid "tm.move.authExists"\nmsgstr "Blave is already in your Applications folder. Please open that copy instead."\n') && po.en.includes('msgid "tm.move.authApps"\nmsgstr "Drag Blave into your Applications folder to receive updates."\n')
    && /moveAuthExists: t\("tm\.move\.authExists"\), moveAuthApps: t\("tm\.move\.authApps"\), gotIt: t\("src\.gotIt"\)/.test(fs.readFileSync(path.join(SHELL, "renderer", "trade.js"), "utf8"))
    && /moveAuthExists: "", moveAuthApps: "", gotIt: "",/.test(src));
  t("up.row.readyQuit 刪乾淨(.po、strings.js、程式都沒有)", !/readyQuit/.test(po.zh + po.en + S + shellJs.map((x) => x[1]).join("")));

  // ── 手機對話開著按更新(0.1.45;11-03 Wei 真機:視窗收掉、app 沒結束、沒裝)──
  // Mac 的 quitAndInstall 要所有視窗關掉才交給 Squirrel;假 install 當場觸發真的 close handler,看有沒有被藏窗攔下
  { const CLOSE = cut(src, 'app.on("browser-window-created", (_e, win) => {') + ");", SCHED = cut(src, "async function scheduledInstall(");
    const line = (re) => { const m = re.exec(src); if (!m) throw new Error("找不到 " + re); return m[0]; };
    const PHONE_ON = line(/^const phoneOn = [^\n]*$/m);
    const LIVE = cut(src, "function tradeLive(") + "\n" + cut(src, "function tradeMaybeLive(");
    const BG = cut(src, "function bgEligible("), BACK = cut(src, "function installBack("), FAILED = cut(src, "function installFailed("), WATCH = cut(src, "function installWatch("), QC = cut(src, "function quitCanceled(");
    const AT = (h, m) => new Date(2026, 10, 4, h, m).getTime();
    const rigC = (o) => {
      const on = {}, log = [], prefs = { ...(o.prefs || {}) }, tracked = [], windows = [];
      const mkWin = (visible) => { const win = { h: {}, visible, isDestroyed: () => false, isVisible: () => win.visible, hide() { win.visible = false; ctx.hid = true; }, webContents: { getURL: () => "file:///ours" }, on(ev, f) { win.h[ev] = f; } }; on["browser-window-created"](null, win); windows.push(win); return win; };
      const fireClose = (win) => { const e = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; win.h.close(e); return e.defaultPrevented; };
      const halted = o.trade === "halt", live = o.trade === "live";
      const status = () => (halted || live ? { alive: true, running: true, report: { venues: { paper: { credentials: 1, pair: 1, order: 1, account: 1 } }, halt: { halted }, reconciler: { alive: true }, daemon: { reconciler: { running: true } } } } : { alive: false, running: false, report: null });
      const ctx = { app: { on: (ev, f) => { on[ev] = f; }, quit: () => log.push("app.quit"), relaunch: () => log.push("app.relaunch"), getVersion: () => "0.1.45" },
        restarting: null, quitConfirmed: false, quitting: false, quitAsking: false, moveAsking: false, draftOk: false, draftNote: false, hiddenSaid: false, bgHidden: !!o.bgHidden, bgAuto: false,
        _relay: { isOn: () => o.phone !== false, isVisible: () => o.phone !== false }, _tradeHost: { status }, lastVenue: "paper", venueReady: (v) => !!(v && v.credentials && v.pair && v.order && v.account),
        anyTurn: () => !!o.turn, anyTurnOrQueued: () => !!(o.turn || o.queued), twLots: () => ({ held: !!o.twHeld }), isOurPageUrl: () => true, draftGate: async () => { log.push("draftGate"); return false; }, draftDirty: async () => false, tmLabels: {},
        Notification: { isSupported: () => false }, notifWatch: (n) => n, phoneHiddenSaid: () => true, phoneHiddenSaidSet() {}, setRestarting: (v) => { ctx.restarting = v; log.push("restarting:" + v); },
        engineAbort: async () => { if (o.onAbort) o.onAbort(ctx, windows); }, planRestart, updAsk: async () => true, tm: () => ({ track: (ev, p) => tracked.push(ev + ":" + (p.name || p.stage)) }),
        updAutoGet: () => o.on !== false, updSchedRec: () => ({ target: prefs.updSchedTarget || null, failed: prefs.updSchedFailed || null, manual: prefs.updManualTarget || null }), updSchedReports: () => ({ running: false, next_due_at: null }), updSchedJobs: () => ({}), engineSetup: () => ({ busy: () => false }), _engineRun: null,
        pageAsk: async (x) => (/upIdleUi/.test(x) ? o.uiIdle !== false : !!o.dirty), uiPrefsPatch: (p) => { Object.assign(prefs, p); log.push("prefs:" + Object.keys(p).join("+")); }, _schedRunning: false, venueName: () => "", cloudSt: () => null, TT: {}, tradePaperOnly: () => false, showMain: () => log.push("showMain"), draftMainWin: () => (o.noMain ? null : windows[0] || null),
        INSTALL_WATCH_MS: 5, console: { error() {} }, setTimeout, process: { platform: o.platform || "darwin" }, BrowserWindow: { getAllWindows: () => windows.filter((w) => !w.closed) }, noteManualTarget: () => log.push("noteManual"), installWatch: () => log.push("installWatch"),
        require: (m) => (m === "electron" ? { powerMonitor: { getSystemIdleTime: () => (o.idle === undefined ? 9999 : o.idle) } } : require(path.join(SHELL, m))), Date: class extends Date { static now() { return o.now || AT(6, 5); } },
        bgWinOn: () => !!o.winOn, updater: () => ({ state: () => ({ phase: o.phase || "ready", version: "0.1.99" }), install: (a) => { log.push("install"); ctx.installArg = a; if (o.installRes) return o.installRes; const win = mkWin(true); ctx.fired = true; ctx.prevented = fireClose(win); return { ok: true }; } }) };
      new Function("ctx", "with (ctx) {" + LIVE + "\n" + PHONE_ON + "\n" + CLOSE + "\n" + BG + "\n" + RESTART + "\n" + SCHED + "\n" + BACK + "\n" + FAILED + "\n" + QC + "\nctx.r = restartToUpdate; ctx.s = scheduledInstall; ctx.tml = tradeMaybeLive; ctx.back = installBack; ctx.failed = installFailed; ctx.qc = quitCanceled; ctx.bge = bgEligible; ctx.watch = () => {" + WATCH.replace(/^function installWatch\(\) \{/, "").replace(/\}$/, "") + "}; }")(ctx);
      return { ctx, log, prefs, tracked, mkWin, fireClose, windows };
    };
    for (const entry of ["pill", "tray", "sched"]) for (const phone of [true, false]) {
      const r = rigC({ phone, trade: "halt" });
      await (entry === "sched" ? r.ctx.s(AT(6, 5)) : r.ctx.r(entry === "pill" ? { confirmed: true } : undefined));
      t(`手機${phone ? "開" : "關"} × ${entry}:install 當下關窗不被攔、不藏窗(修法拿掉這一格會紅)`, r.ctx.fired === true && r.ctx.prevented === false && !r.ctx.hid && r.ctx.restarting === "installing", r.log);
    }
    { const r = rigC({}), win = r.mkWin(true);
      t("平常手機開著紅燈仍是收進背景,bgHidden 立起來;視窗再出現(show 事件)就收回", r.fireClose(win) === true && r.ctx.hid === true && r.ctx.bgHidden === true && (win.h.show(), r.ctx.bgHidden === false)); }
    { const r = rigC({ queued: true }), res = await r.ctx.r({ confirmed: true });
      t("排隊中的回合:按重新啟動不裝(不然視窗關了才跳回合框)", res.error === "TURN_BUSY" && !r.log.includes("install") && r.ctx.restarting === null, r.log); }
    { const r = rigC({ installRes: { ok: false, error: "NOT_READY" } }), res = await r.ctx.r({ confirmed: true });
      t("install 當場失敗:restarting 與 draftOk 都收回", res.ok === false && r.ctx.restarting === null && r.ctx.draftOk === false && !r.log.includes("noteManual"), r.log); }
    { const r = rigC({ installRes: { ok: false, error: "NOT_READY" } }), res = await r.ctx.s(AT(6, 5));
      t("排程 install 當場失敗:restarting 收回、不寫目標版號、窗內不會每分鐘卡住", res.go === false && r.ctx.restarting === null && r.prefs.updSchedTarget === null, r.log); }

    // Squirrel 之後才失敗:不能留在視窗收掉卻沒更新的狀態
    { const r = rigC({ prefs: { updManualTarget: "0.1.99" } }); r.ctx.restarting = "installing"; r.ctx.failed();
      t("人按的:回錯時視窗已全關 → 結束,不重開(ShipIt 可能還排著那份安裝)", r.log.join() === "app.quit" && r.prefs.updManualTarget === "0.1.99", r.log); }
    { const r = rigC({ prefs: { updSchedTarget: "0.1.99", updHiddenBoot: { v: "0.1.99", at: 1 } } }); r.ctx.restarting = "installing"; r.ctx.bgAuto = true; r.ctx.failed();
      t("閒著自動裝:回錯時視窗已全關 → 用舊版重開回背景(標記改舊版版號)、目標版號留給下次啟動記失敗", r.log.join() === "prefs:updHiddenBoot,app.relaunch,app.quit" && r.prefs.updHiddenBoot.v === "0.1.45" && r.prefs.updSchedTarget === "0.1.99", r.log); }
    { const r = rigC({}); r.ctx.restarting = "installing"; r.ctx.bgAuto = true; r.ctx.quitting = true; r.ctx.failed();
      t("回錯時 before-quit 正在等收工:照叫 relaunch,但不再叫 app.quit(會切斷對帳器撤單與手機回 not_run)", r.log.includes("app.relaunch") && !r.log.includes("app.quit"), r.log); }
    { const r = rigC({ prefs: { updManualTarget: "0.1.99" } }), w = r.mkWin(true); r.ctx.restarting = "installing"; r.ctx.draftOk = true; r.ctx.failed();
      t("視窗還在(Windows NSIS 在 app.quit 前就失敗):不結束、回原畫面、送 update_failed、清標記", !r.log.includes("app.quit") && r.ctx.restarting === null && r.ctx.draftOk === false && r.prefs.updManualTarget === null && r.tracked.join() === "update_failed:install" && w.visible, r.log); }
    { const r = rigC({ prefs: { updSchedTarget: "0.1.99" } }); r.mkWin(false); r.ctx.restarting = "installing"; r.ctx.bgAuto = true; r.ctx.draftOk = true; r.ctx.back();
      t("收回時是閒著那條:不叫視窗、同一版記成失敗不再試", !r.log.includes("showMain") && r.prefs.updSchedFailed === "0.1.99" && r.prefs.updSchedTarget === null && r.ctx.bgAuto === false, r.log); }
    { const r = rigC({ prefs: { updManualTarget: "0.1.99" } }); r.mkWin(false); r.ctx.restarting = "installing"; r.ctx.back();
      t("收回時是人按的:視窗叫回來、不記成排程失敗", r.log.includes("showMain") && !r.prefs.updSchedFailed, r.log); }
    { const r = rigC({}); r.mkWin(false); r.ctx.restarting = "installing"; r.ctx.watch(); await new Promise((ok) => setTimeout(ok, 25));
      t("看門狗:install 回 ok 之後 app 還活著 → 收回(Windows 的 BaseUpdater 找不到安裝檔時不發事件)", r.ctx.restarting === null && r.tracked.join() === "update_failed:install", r.log); }
    { const r = rigC({}); r.mkWin(false); r.ctx.restarting = "installing"; r.ctx.quitAsking = true; r.ctx.installWatch = r.ctx.watch; r.ctx.watch(); await new Promise((ok) => setTimeout(ok, 25)); const held = r.ctx.restarting === "installing";
      r.ctx.quitAsking = false; await new Promise((ok) => setTimeout(ok, 25));
      t("看門狗:結束框開著時等它,框收了才判", held && r.ctx.restarting === null, r.log); }
    { const r = rigC({}); r.mkWin(false); r.ctx.restarting = "installing"; r.ctx.quitting = true; r.ctx.watch(); await new Promise((ok) => setTimeout(ok, 25));
      t("看門狗:已經在結束就不動", r.ctx.restarting === "installing" && r.tracked.length === 0, r.log); }
    { const r = rigC({}); r.ctx.restarting = "installing"; r.ctx.draftOk = true; r.ctx.qc();
      t("結束框(統一／群益部位)按取消:restarting 收回,不卡在重新啟動中", r.ctx.restarting === null && r.ctx.draftOk === false, r.log); }

    // 閒著自動裝
    const bgRig = (o = {}) => { const r = rigC({ bgHidden: true, now: AT(14, 0), trade: "none", ...o }); r.mkWin(false); return r; };
    { const r = bgRig(), res = await r.ctx.s(AT(14, 0));
      t("閒著:窗外也裝;先寫隱藏標記與 upd_idle_run 才 install,寫目標版號、不送 upd_sched_run", res.go === true && r.log.indexOf("prefs:updHiddenBoot") < r.log.indexOf("install") && r.tracked.join() === "feature_used:upd_idle_run" && r.prefs.updHiddenBoot.v === "0.1.99" && r.prefs.updSchedTarget === "0.1.99" && r.ctx.bgAuto === true && r.ctx.prevented === false, r.log); }
    { const r = bgRig({ trade: "halt" }), res = await r.ctx.s(AT(14, 0));
      t("暫停中(HALT):tradeMaybeLive 回 null,算閒著", r.ctx.tml() === null && res.go === true, [res, r.log]); }
    { const r = bgRig({ trade: "live" }), res = await r.ctx.s(AT(14, 0));
      t("下單中:不動", !!r.ctx.tml() && res.go === false && res.why === "trading" && !r.log.includes("install") && r.ctx.restarting === null, [res, r.log]); }
    for (const [name, o, why] of [["手機對話關著", { phone: false }, "window"], ["視窗沒收進背景", { bgHidden: false }, "window"], ["開關關掉(用戶說不要自動重開)", { on: false }, "off"], ["Windows 預設關", { platform: "win32" }, "window"], ["回合在跑", { turn: true }, "turn"], ["回合排隊", { queued: true }, "turn"],
      ["統一／群益有部位", { twHeld: true }, "tw_held"], ["有草稿", { dirty: true }, "draft"], ["畫面有框或輸入框不空", { uiIdle: false }, "ui"], ["同一版失敗過", { prefs: { updSchedFailed: "0.1.99" } }, "failed"], ["還沒暫存好", { phase: "staging" }, "phase"]]) {
      const r = bgRig(o), res = await r.ctx.s(AT(14, 0));
      t("閒著不裝:" + name + " → " + why, res.go === false && res.why === why && !r.log.includes("install") && !("updHiddenBoot" in r.prefs) && r.ctx.restarting === null, [res, r.log]);
    }
    { const r = bgRig({ idle: 0 }), res = await r.ctx.s(AT(14, 0));
      t("閒著:用戶正在用電腦(鍵鼠剛動過)也裝,只看視窗藏著", res.go === true && r.log.includes("install"), [res, r.log]); }
    { const r = rigC({ idle: 30, trade: "none", now: AT(6, 5) }), res = await r.ctx.s(AT(6, 5));
      t("06:00 視窗看得到:仍要鍵鼠閒置", res.go === false && res.why === "active", res); }
    { const r = bgRig({ platform: "win32", winOn: true }), res = await r.ctx.s(AT(14, 0));
      t("Windows 打開旗標:閒著走靜默安裝、寫隱藏標記", res.go === true && r.ctx.installArg && r.ctx.installArg.silent === true && !!r.prefs.updHiddenBoot, [res, r.log]); }
    { const r = bgRig(), res = await r.ctx.s(AT(14, 0));
      t("Mac 閒著:install 不帶 silent", res.go === true && r.ctx.installArg === undefined, res); }
    { const r = rigC({ platform: "win32", winOn: true, trade: "none", now: AT(6, 5) }), res = await r.ctx.s(AT(6, 5));
      t("Windows 06:00 視窗看得到:不靜默", res.go === true && r.ctx.installArg === undefined, res); }
    { const r = rigC({ platform: "win32", winOn: true, phone: true }), res = await r.ctx.r({ confirmed: true });
      t("Windows 人按的:不靜默", res.ok === true && r.ctx.installArg === undefined, [res, r.log]); }
    { const { createUpdater } = require("../shell/updater.js"), calls = [], au = { quitAndInstall: (...a) => calls.push(a), on() {}, setFeedURL() {} };
      let fire = null; const on0 = au.on; au.on = (ev, f) => { if (ev === "update-downloaded") fire = f; return on0.call(au, ev, f); };
      const u = createUpdater({ autoUpdater: au, nativeUpdater: null, feedUrl: "http://x", currentVersion: "1.0.0", isTrading: () => false, onState() {}, setTimer: () => {} });
      u.start(); fire({ version: "1.0.1" }); u.install(); await tick(); u.install({ silent: true }); await tick();
      t("updater.install:預設 quitAndInstall(false, true);silent 才 (true, true)", JSON.stringify(calls) === "[[false,true],[true,true]]", calls); }
    { const r = bgRig(); r.windows[0].visible = true; const res = await r.ctx.s(AT(14, 0));
      t("還有視窗看得到(標記漏收的保險):不裝", res.go === false && res.why === "window", res); }
    { const r = bgRig({ onAbort: (c, w) => { w[0].visible = true; } }), res = await r.ctx.s(AT(14, 0));
      t("收引擎那段用戶把視窗叫回來:放掉這一輪、restarting 收回、不送埋點", res.go === false && res.why === "shown" && !r.log.includes("install") && r.ctx.restarting === null && r.ctx.draftOk === false && r.tracked.length === 0, [res, r.log]); }
    { const r = rigC({ bgHidden: true, trade: "none" }); r.mkWin(false); const res = await r.ctx.s(AT(6, 5));
      t("06:00 窗內也符合閒著:走同一次、只裝一次,照閒著那條藏窗", res.go === true && r.log.filter((x) => x === "install").length === 1 && r.tracked.join() === "feature_used:upd_idle_run" && !!r.prefs.updHiddenBoot, r.log); }
    { const r = rigC({ trade: "none" }), res = await r.ctx.s(AT(6, 5));
      t("06:00 視窗看得到:照舊重開(不寫隱藏標記、送 upd_sched_run)", res.go === true && !("updHiddenBoot" in r.prefs) && r.tracked.join() === "feature_used:upd_sched_run", r.log); }

    // 重開那一端
    const { hiddenBoot, HIDDEN_BOOT_MAX_MS, schedPlan } = require("../shell/schedupdate.js");
    const HB = { current: "0.1.46", now: 1e12, platform: "darwin" };
    t("隱藏啟動:版號對、時間內才藏(Windows 同一份標記)", hiddenBoot({ v: "0.1.46", at: 1e12 - 60000 }, HB) === true && hiddenBoot({ v: "0.1.46", at: 1e12 }, { ...HB, platform: "win32" }) === true);
    t("隱藏啟動:沒裝上(舊版被打開)、標記過期、未來時間、其他平台、壞標記 → 視窗照常", [[{ v: "0.1.45", at: 1e12 }, HB], [{ v: "0.1.46", at: 1e12 - HIDDEN_BOOT_MAX_MS }, HB], [{ v: "0.1.46", at: 1e12 + 1 }, HB], [{ v: "0.1.46", at: 1e12 }, { ...HB, platform: "linux" }], [null, HB], [{ v: "0.1.46" }, HB], ["x", HB]].every(([m, c]) => hiddenBoot(m, c) === false));
    const ok6 = { now: AT(14, 0), on: true, phase: "ready", version: "1", idleSec: 9999, reports: { running: false, next_due_at: null }, dirty: false, uiBusy: false };
    t("schedPlan:background 只免時間窗與鍵鼠閒置,其餘條件一條都不少", schedPlan(ok6).why === "window" && schedPlan({ ...ok6, background: true }).go === true && ["trading", "turn", "twHeld", "asking", "engineBusy", "backtesting", "optimizing", "exectesting", "refreshing", "rerunning", "closing"].every((k) => schedPlan({ ...ok6, background: true, [k]: true }).go === false) && schedPlan({ ...ok6, background: true, on: false }).go === false && schedPlan({ ...ok6, background: true, idleSec: 0 }).go === true);
    { const BOOT = cut(src, "function bgBootCheck(");
      const go = (prefs, o = {}) => { const log = [], cur = { ...prefs }; const ctx = { app: { hasSingleInstanceLock: () => o.lock !== false, getVersion: () => "0.1.46", hide: () => log.push("hide") }, fs: { readFileSync: () => { if (o.noFile) throw new Error("ENOENT"); return JSON.stringify(cur); } }, uiPrefsPath: () => "x", uiPrefsPatch: (p) => { Object.assign(cur, p); log.push("patch"); }, process: { platform: "darwin" }, require: (m) => require(path.join(SHELL, m)), bgBoot: false, bgHidden: false, moveChecked: false, bgBootQuietUntil: 0, BG_BOOT_QUIET_MS: 5000, Date };
        new Function("ctx", "with (ctx) {" + BOOT + "\nbgBootCheck(); }")(ctx); return { ctx, log, cur }; };
      const fresh = go({ updHiddenBoot: { v: "0.1.46", at: Date.now() } });
      t("啟動讀到標記:藏窗、app.hide 把焦點還回去、之後幾秒 activate 不算人按、不問搬移、讀完就清", fresh.ctx.bgBoot === true && fresh.ctx.bgHidden === true && fresh.ctx.moveChecked === true && fresh.ctx.bgBootQuietUntil > Date.now() && fresh.log.join() === "patch,hide" && fresh.cur.updHiddenBoot === null);
      const old = go({ updHiddenBoot: { v: "0.1.45", at: Date.now() } });
      t("標記版號對不上:照常開視窗,標記一樣清掉(一次性)", old.ctx.bgBoot === false && old.log.join() === "patch" && old.cur.updHiddenBoot === null);
      t("沒標記、第二份 app:什麼都不動(第二份不能清第一份的標記)", go({}).log.length === 0 && go({ updHiddenBoot: { v: "0.1.46", at: Date.now() } }, { lock: false }).log.length === 0); }
    { const BOOT2 = cut(src, "function updSchedBoot(");
      const go = (rec, ver) => { const tracked = [], patched = []; const ctx = { updSchedRec: () => rec, require: (m) => require(path.join(SHELL, m)), app: { getVersion: () => ver }, uiPrefsPatch: (p) => patched.push(p), tm: () => ({ track: (e, p) => tracked.push(e + ":" + p.stage) }) };
        new Function("ctx", "with (ctx) {" + BOOT2 + "\nupdSchedBoot(); }")(ctx); return { tracked, patched }; };
      const a = go({ target: null, failed: null, manual: "0.1.46" }, "0.1.45");
      t("人按的沒裝上:下次啟動送 update_failed stage=install,清掉記號,不記成排程失敗", a.tracked.join() === "update_failed:install" && a.patched[0].updManualTarget === null && a.patched[0].updSchedFailed === null);
      const b = go({ target: null, failed: null, manual: "0.1.46" }, "0.1.46");
      t("人按的裝上了:不送", b.tracked.length === 0 && b.patched[0].updManualTarget === null); }
    // 隱藏重開的頁:第一次顯示前不能把提示算成看過。真的 hidden-boot.js + 真的 phAskMaybe
    { const HB_SRC = fs.readFileSync(path.join(SHELL, "renderer", "hidden-boot.js"), "utf8"), APP = fs.readFileSync(path.join(SHELL, "renderer", "app.js"), "utf8"), vm = require("vm");
      const pg = (hidden, stored) => { const seen = [], ls = {}, listeners = []; let shown = null; const doc = Object.assign(Object.create({ visibilityState: "visible", hidden: false }), { querySelectorAll: () => [], addEventListener: (_e, f) => listeners.push(f), dispatchEvent: () => listeners.forEach((f) => f()) });
        const c = { document: doc, Event: function () {}, sessionStorage: { getItem: (k) => (stored ? "1" : ls[k] || null), setItem: (k, v) => { ls[k] = v; } }, window: { blave: { hiddenBoot: hidden, onHiddenBootShown: (f) => { shown = f; }, relayAskShown: async (id) => { seen.push("askShown:" + id); } } }, Object,
          PH: { ask: { id: "a1" }, signedIn: true, on: false }, PH_ASKED: null, PH_BUSY: false, phShown: () => true, trackFeature: (n) => seen.push(n) };
        c.$stub = () => {}; vm.createContext(c); vm.runInContext(HB_SRC, c);
        vm.runInContext(cut(APP, "function phAskMaybe(").replace(/\n  PH_ASKED = a\.id;[\s\S]*$/, '\n  PH_ASKED = a.id;\n  window.blave.relayAskShown(a.id);\n  trackFeature("phone_ask_shown");\n}'), c); doc.addEventListener("visibilitychange", () => vm.runInContext("phAskMaybe()", c));
        return { c, doc, seen, show: () => shown && shown(), ask: () => vm.runInContext("phAskMaybe()", c), stored: () => ls.blaveHiddenBootShown }; };
      { const p = pg(true); p.ask(); const before = p.seen.length; p.show();
        t("藏窗啟動:顯示前配對框不算看過;第一次顯示才算(靠補的 visibilitychange)、記下顯示過", before === 0 && p.doc.visibilityState === "visible" && p.seen.join() === "askShown:a1,phone_ask_shown" && p.stored() === "1", p.seen); }
      { const p = pg(false); p.ask(); t("一般啟動:不動 visibilityState,照舊當下就算", p.seen.length === 2 && p.doc.visibilityState === "visible", p.seen); }
      { const p = pg(true, true); p.ask(); t("顯示過之後重新載入:不再回報 hidden", p.seen.length === 2, p.seen); }
      const html = fs.readFileSync(path.join(SHELL, "renderer", "index.html"), "utf8");
      t("hidden-boot.js 在所有頁面腳本之前(theme-boot.js 不讀 visibilityState,排它前面);只有藏窗那一扇帶參數;顯示時才通知", (html.match(/<script[^>]*>/g) || []).slice(0, 2).join().replace(/\s+/g, " ") === '<script src="theme-boot.js">,<script src="hidden-boot.js">' && /\.\.\.\(bgBoot \? \["--blave-hidden-boot"\] : \[\]\)/.test(src) && /win\.once\("show", \(\) => \{ shown = true; tell\(\); \}\);/.test(src) && /win\.webContents\.once\("did-finish-load", tell\);/.test(src)); }
    { const sm = cut(src, "function showMain(");
      t("showMain 先解除 app.hide,不然隱藏重開之後點選單列也叫不出視窗", /^function showMain\(\) \{\n  if \(!HEADLESS && app\.isHidden && app\.isHidden\(\)\) app\.show\(\);/.test(sm));
      t("隱藏重開剛起來那幾秒 activate 不叫視窗", /app\.on\("activate", \(\) => \{ if \(Date\.now\(\) >= bgBootQuietUntil\) showMain\(\); \}\);/.test(src));
      t("createWindow 只有啟動那一扇藏", /\.\.\.\(bgBoot \? \{ show: false, paintWhenInitiallyHidden: true \} : \{\}\),/.test(src) && /bgBoot = false;   \/\/ 只有啟動那一扇/.test(cut(src, "function createWindow("))); }
  }

  await tick();
  console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0);
})();
