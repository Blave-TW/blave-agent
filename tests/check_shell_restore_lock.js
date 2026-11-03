// 〔還原〕〔再跑一次〕只鎖同一支策略(Wei 11-03):送出時看著的那支 ∪ 這一輪工具已碰過的;看不出碰什麼的一律算。
// 〔刪策略〕維持全機鎖,同條對話 Enter 與〔再送一次〕維持擋住。真碼從 renderer 原文切出來跑,不開 Electron。
// 跑法:node tests/check_shell_restore_lock.js
const fs = require("fs"), path = require("path");
const R = path.join(__dirname, "..", "shell", "renderer"), read = (f) => fs.readFileSync(path.join(R, f), "utf8");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + JSON.stringify(d).slice(0, 400))); if (!c) red++; };
function fnOf(src, name) {
  let a = src.indexOf("function " + name + "("); if (a < 0) return "";
  let i = src.indexOf("{", src.indexOf(")", a)), d = 0;
  for (; i < src.length; i++) { if (src[i] === "{") d++; else if (src[i] === "}" && --d === 0) break; }
  return src.slice(a, i + 1);
}
const ct = read("chattabs.js"), ver = read("versions.js"), res = read("results.js"), app = read("app.js");
const lineOf = (src, re) => { const m = re.exec(src); return m ? m[0] + "\n" : ""; };
const rt = (view, touched) => ({ viewStrat: view || null, touched: new Set(touched || []) });
const tab = (sid, r) => ({ sid, st: { running: true, "RES.turn": r } });
// 真的 csStratTurn;舊碼沒有這支時退回舊的判準(任何回合),讓下面的行為斷言自己紅,而不是炸掉
function pred(tabs, main) {
  const CS = { tabs: new Map(tabs.map((T) => [T.sid, T])), loaded: null, main: new Map(main || []) }, RES = { turn: null };
  const src = lineOf(ct, /^const tabRun = [^\n]*/m) + lineOf(ct, /^const tabVal = [^\n]*/m) + "var running = false;\n" + (fnOf(ct, "csStratTurn") || 'function csStratTurn() { for (const T of CS.tabs.values()) if (tabRun(T)) return T.sid; for (const [s, p] of CS.main) if (p) return s; return null; }');
  return new Function("CS", "RES", src + "\nreturn csStratTurn;")(CS, RES);
}
ok("定義:chattabs.js 有 csStratTurn", !!fnOf(ct, "csStratTurn"));
{ const f = pred([tab("a", rt("x"))]);
  ok("① 送出時看著 x:x 鎖、y 不鎖", f("x") === "a" && f("y") === null, [f("x"), f("y")]); }
{ const f = pred([tab("a", rt(null, ["z"]))]);
  ok("① 這一輪工具碰過 z:z 鎖、y 不鎖", f("z") === "a" && f("y") === null, [f("z"), f("y")]); }
{ const f = pred([tab("a", rt(null, []))]);
  ok("① 對話沒看著策略、工具還沒碰:任何一支都不鎖(agent 之後才碰的算不到)", f("x") === null); }
{ const f = pred([tab("a", null)]);
  ok("① 看不出碰什麼(手機那一輪開成的分頁、收尾中):一律算", f("x") === "a"); }
{ const f = pred([], [["phone", "running"]]);
  ok("① 沒開成分頁的回合:一律算", f("x") === "phone"); }
{ const idle = tab("a", rt("x")); idle.st.running = false; const f = pred([idle]);
  ok("① 閒著的分頁不算", f("x") === null); }

// 回合紀錄:resTurnStart 記看著的那支(不混進 touched:結果卡用 touched 認這一輪的產出);resTurnTool 碰到新策略當場重畫鎖
{ const s = fnOf(res, "resTurnStart");
  ok("② resTurnStart 記 viewStrat,不寫進 touched", /viewStrat: viewing && viewing\.strategy \? viewing\.strategy : null/.test(s) && /touched: new Set\(\)/.test(s));
  const repaint = []; const RES = { turn: { touched: new Set() } };
  const f = new Function("RES", "verBusy", lineOf(res, /^const RES_STRAT_PATH = [^\n]*/m) + lineOf(res, /^const RES_KIND_STRAT = [^\n]*/m) + lineOf(res, /^const RES_KIND_SAFE = [^\n]*/m) + fnOf(res, "resTurnTool") + "\nreturn resTurnTool;")(RES, () => repaint.push(1));
  f({ type: "tool", summary: "edit strategies/abc/strategy.py" }); f({ type: "tool", summary: "read strategies/abc/stats.json" });
  ok("② 工具碰到新策略:記進 touched、叫 verBusy;同一支第二次不重畫", RES.turn.touched.has("abc") && repaint.length === 1, repaint.length); }

// verBusy／verRestoreAsk／verRetry:別支有回合在跑照可按,同一支鎖(舊碼看任何回合會紅)
function verRig(name, turnSid, open) {
  const btn = () => ({ attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; }, title: "" });
  const els = { "ver-restore": btn(), "ver-retry": btn() }, S = { data: { current: 3 }, open: open === undefined ? 1 : open, err: null }, boxes = [], restores = [], painted = [];
  const B = { name, data: {} }, env = { $: (id) => els[id] || null, t: (k) => k, rpBag: () => B, verSideOf: () => "local", VS: { local: S }, verPaintErr: (x) => painted.push(x.err), verAmount: () => 0, verBoxCtx: () => ({}), verEl: () => ({}),
    confirmBox: (o) => boxes.push(o), verDoRestore: (...a) => restores.push(a), VER: { canRestoreInPlace: () => true, pending: () => ({ status: "failed", n: 3 }) }, verPaintRerun() {}, verNeedUpdate() {}, verGuard() {},
    csStratTurn: (n) => (typeof turnSid === "function" ? turnSid(n) : turnSid), RPC: {}, csCloudTurn: () => null, csAnyTurn: () => !!(typeof turnSid === "function" ? "any" : turnSid) || env.anyOther === true, anyOther: false };
  const src = ["verTurnOf", "verBusy", "verRestoreLocked", "verRestoreAsk", "verRetry"].map((n) => fnOf(ver, n)).join("\n");
  const F = new Function("env", `with (env) { ${src}\n return { verBusy, verRestoreAsk, verRetry }; }`)(env);
  return { F, els, S, boxes, restores, painted, env };
}
{ const r = verRig("mine", null); r.env.anyOther = true; r.F.verBusy();
  ok("③ 別支的回合在跑(眼前這支沒人碰):還原、再跑一次不鎖", !("aria-disabled" in r.els["ver-restore"].attrs) && !("aria-disabled" in r.els["ver-retry"].attrs), r.els["ver-restore"].attrs);
  r.F.verRestoreAsk();
  ok("③ 別支的回合在跑:還原開得了確認框", r.boxes.length === 1, r.boxes.length);
  r.S.open = null; const sent = r.F.verRetry();
  ok("③ 別支的回合在跑:再跑一次送得出去", sent === true && r.restores.length === 1, { sent, n: r.restores.length }); }
{ const r = verRig("mine", "tab1"); r.F.verBusy();
  ok("③ 同一支有回合:兩顆都 aria-disabled", r.els["ver-restore"].attrs["aria-disabled"] === "true" && r.els["ver-retry"].attrs["aria-disabled"] === "true");
  r.F.verRestoreAsk(); ok("③ 同一支有回合:還原不開框", r.boxes.length === 0);
  r.S.open = null; ok("③ 同一支有回合:再跑一次不送", r.F.verRetry() === false && r.restores.length === 0); }
{ let cur = null; const r = verRig("mine", () => cur); r.F.verRestoreAsk(); cur = "tab9"; (r.boxes[0] || { onOk() {} }).onOk();
  ok("③ 框開著的期間回合碰到這支:按確認不還原,講原因並帶那條的 sid", r.restores.length === 0 && r.S.err && r.S.err.key === "busy.restore" && r.S.err.sid === "tab9", r.S.err); }
ok("③ 〔查看〕帶去擋路那條:原因行掛 sid", /el\.dataset\.sid = S\.err\.sid/.test(fnOf(ver, "verPaintErr")) && /verTurnOf\(rpBag\(\)\)/.test(fnOf(ver, "verBusyNote")));

// 沒放寬的
ok("④ 刪策略維持全機鎖(本機、雲端列、主行程)", /busyLock\(d, csAnyTurn\(\)\)/.test(fnOf(app, "stratDelSync")) && /busyLock\(d, busyOn\(\)\)/.test(read("trade.js")) && /if \(anyTurn\(\)\) return \{ ok: false, code: "TURN_RUNNING" \};/.test(fs.readFileSync(path.join(R, "..", "main.js"), "utf8")));
ok("④ 同條對話 Enter、〔再送一次〕維持擋住", /if \(running && \$\("ta"\)\.value\.trim\(\)\) \{ busySendTell\(\); return; \}/.test(app) && /function canResend\(\) \{ return !running/.test(app) && /if \(running\) \{ busySendTell\(\); return; \}   \/\/ 卡上的鈕回合中照畫/.test(app));

console.log(red ? red + " 紅" : "ALL PASS");
process.exit(red ? 1 : 0);
