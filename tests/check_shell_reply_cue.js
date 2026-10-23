// 回合結束的系統通知(spec agent-reply-notifications-0130 §3.1–3.5、§4;canon notifications §8.3):main.js 的判斷從原文切出來跑。
//   1. replyCuePick:kind(done／await／fail／stopped／表外)× 前景 × 開關 列舉每一格
//   2. replyBody:三型的前綴與空摘錄、摘錄長度驗證、字還沒交過來不發
//   3. replyTitleOf:第一句用戶的話、拿掉附件那幾行、截 60 字、空的用 Blave
//   4. replyCue 整條:一輪一則(用掉就清)、awaiting 把 done 升成 await、show／click／failed 的埋點、點了開那條對話、不碰 Dock 紅點
//   5. 接線:runTurn 記 awaiting、結束記 pending、送出失敗那條也記;IPC 只收自家頁面;畫面算完 faulted 才送
// 不開 Electron、不建真的 Notification。跑法:node tests/check_shell_reply_cue.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const S = path.join(__dirname, "..", "shell");
const main = fs.readFileSync(path.join(S, "main.js"), "utf8"), app = fs.readFileSync(path.join(S, "renderer", "app.js"), "utf8");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };
const fn = (src, name) => { const i = src.indexOf("function " + name + "("); if (i < 0) throw new Error("找不到 " + name); let d = 0; for (let k = src.indexOf("{", src.indexOf(")", i)); k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}" && --d === 0) return src.slice(i, k + 1); } throw new Error("切不出 " + name); };
const line = (re) => { const m = main.match(re); if (!m) throw new Error("找不到 " + re); return m[0]; };
const PURE = [line(/const REPLY_KINDS = .*;/), line(/const replyGraphemes = .*;/), fn(main, "replyCuePick"), fn(main, "replyBody"), fn(main, "replyTitleOf")].join("\n");
const M = new Function("require", PURE + "\nreturn { replyCuePick, replyBody, replyTitleOf };")((m) => require(m === "./attach" ? path.join(S, "attach.js") : m));

// ---- 1. replyCuePick 列舉
const KINDS = ["done", "await", "fail", "stopped", "nope", undefined, null];
for (const kind of KINDS) for (const focused of [true, false, undefined]) for (const pref of [true, false, undefined]) {
  const exp = focused === false && pref === true && ["done", "await", "fail"].includes(kind) ? kind : null;
  const got = M.replyCuePick({ kind, focused, pref });
  ok(`kind=${kind} focused=${focused} pref=${pref} → ${exp}`, got === exp, got);
}
ok("replyCuePick(null／undefined) → null", M.replyCuePick(null) === null && M.replyCuePick(undefined) === null);

// ---- 2. replyBody
const L = { rc_await: "等你回覆：", rc_fail: "沒做完：", rc_doneEmpty: "回覆好了。", rc_awaitEmpty: "等你回覆。", rc_failEmpty: "沒做完。" };
const EN = { rc_await: "Waiting for you:", rc_fail: "Didn’t finish:", rc_doneEmpty: "Reply ready.", rc_awaitEmpty: "Waiting for your reply.", rc_failEmpty: "Didn’t finish." };
ok("done:摘錄本身、不加前綴", M.replyBody("done", "回測完成", L) === "回測完成");
ok("await:全形冒號前綴、不補空格", M.replyBody("await", "要用 20／55 嗎？", L) === "等你回覆：要用 20／55 嗎？");
ok("fail:前綴＋錯誤卡那句", M.replyBody("fail", "Blave AI 額度用完了。", L) === "沒做完：Blave AI 額度用完了。");
ok("en:半形冒號後補一格", M.replyBody("await", "Which one?", EN) === "Waiting for you: Which one?" && M.replyBody("fail", "x", EN) === "Didn’t finish: x");
ok("空摘錄:三型各自的字(不帶前綴)", M.replyBody("done", "", L) === "回覆好了。" && M.replyBody("await", "  ", L) === "等你回覆。" && M.replyBody("fail", "", L) === "沒做完。");
ok("摘錄不是字串:當空", [null, 5, {}, []].every((v) => M.replyBody("done", v, L) === "回覆好了。"));
const s60 = "字".repeat(60) + "…", s62 = "字".repeat(62);
ok("60 字＋「…」照收;超過 61 字當空(畫面那支截過了,超過就是不是它送的)", M.replyBody("done", s60, L) === s60 && M.replyBody("done", s62, L) === "回覆好了。");
ok("emoji 一個字算一格(61 個 grapheme 照收)", M.replyBody("done", "👍🏽".repeat(61), L) === "👍🏽".repeat(61));
ok("控制字元換成空白", M.replyBody("done", "a\u0007b", L) === "a b");
ok("字還沒交過來:不發(回空)", M.replyBody("done", "x", {}) === "" && M.replyBody("await", "x", { rc_awaitEmpty: "y" }) === "" && M.replyBody("fail", "", { rc_fail: "z" }) === "");
ok("表外型別:不發", M.replyBody("stopped", "x", L) === "" && M.replyBody("nope", "x", L) === "");

// ---- 3. replyTitleOf
const at = require(path.join(S, "attach.js"));
ok("標題 = 第一句用戶的話", M.replyTitleOf("ETH 突破回測") === "ETH 突破回測");
ok("換行與連續空白收成一格", M.replyTitleOf("幫我\n\n回測   ETH") === "幫我 回測 ETH");
ok("附件那幾行拿掉(不洩出 tmp/inbound 路徑)", M.replyTitleOf("看這張圖\n" + at.NOTE_OK.replace("{name}", "a.png") + "\n" + at.NOTE_FAIL) === "看這張圖");
ok("只有附件:Blave", M.replyTitleOf(at.NOTE_OK.replace("{name}", "a.png")) === "Blave");
ok("空／不是字串:Blave", M.replyTitleOf("") === "Blave" && M.replyTitleOf(null) === "Blave" && M.replyTitleOf(undefined) === "Blave");
ok("超過 60 字:截 60 接「…」", M.replyTitleOf("字".repeat(70)) === "字".repeat(60) + "…" && M.replyTitleOf("字".repeat(60)) === "字".repeat(60));

// ---- 4. replyCue 整條(假的 Notification / BrowserWindow / tm)
const mk = (o = {}) => {
  const made = [], tracked = [], sent = []; let badge = null, shown = 0;
  class FakeN { constructor(a) { this.a = a; this.h = {}; this.closed = false; made.push(this); } on(ev, f) { (this.h[ev] = this.h[ev] || []).push(f); return this; } show() { this.emit("show"); } close() { this.closed = true; } emit(ev, ...a) { (this.h[ev] || []).forEach((f) => f(...a)); } static isSupported() { return o.supported !== false; } }
  const win = { isDestroyed: () => false, webContents: { getURL: () => "file:///x/index.html", send: (ch, v) => sent.push([ch, v]) } };
  const ctx = { Notification: FakeN, tmLabels: o.labels || L, p1Alive: new Set(), p1Badge: 0, console: { error: () => {} },
    BrowserWindow: { getFocusedWindow: () => (o.focused ? win : null), getAllWindows: () => [win] }, isOurPageUrl: () => true,
    app: { dock: { setBadge: (v) => { badge = v; } } }, showMain: () => { shown++; }, tm: () => ({ track: (ev, p) => tracked.push(ev + ":" + p.act) }),
    replyNotifyGet: () => o.pref !== false, okSessionId: (id) => typeof id === "string" && /^desktop-[a-z0-9]{4,16}$/.test(id), replyTitle: (sid) => "T:" + sid, require };
  vm.createContext(ctx);
  vm.runInContext(["let replyPending = null, replyLast = null, replyOsOff = false;", PURE, fn(main, "notifWatch"), fn(main, "replyCue"), fn(main, "replyTurnStart"),
    "this.get = () => ({ replyPending, replyLast, replyOsOff }); this.setPending = (p) => { replyPending = p; };"].join("\n"), ctx);
  return { ctx, made, tracked, sent, badge: () => badge, shown: () => shown, cue: (c) => ctx.replyCue(c) };
};
const SID = "desktop-abcd1234";
let x = mk(); x.ctx.setPending({ sid: SID, awaiting: false });
ok("背景、開著、done:發一則,標題是那條對話、內文是摘錄", x.cue({ kind: "done", snippet: "回測完成" }) === true && x.made.length === 1 && x.made[0].a.title === "T:" + SID && x.made[0].a.body === "回測完成");
ok("…不另設 sound／silent(聲音同 P1 通知)", !("silent" in x.made[0].a) && !("sound" in x.made[0].a));
ok("…show 事件記 reply_notif done", x.tracked.join() === "reply_notif:done");
ok("…pending 用掉就清:畫面再送一次發不出第二則", x.ctx.get().replyPending === null && x.cue({ kind: "done", snippet: "again" }) === false && x.made.length === 1);
ok("…不碰 Dock 紅點、不加 p1Badge", x.badge() === null && x.ctx.p1Badge === 0);
x.made[0].emit("click");
ok("點了:記 click、叫出視窗、送 open-session 給那條對話", x.tracked.join() === "reply_notif:done,reply_notif:click" && x.shown() === 1 && JSON.stringify(x.sent) === JSON.stringify([["open-session", SID]]) && x.ctx.p1Alive.size === 0 && x.ctx.get().replyLast === null);
x = mk(); x.ctx.setPending({ sid: SID, awaiting: true });
ok("done 但主行程記到 awaiting:發「等你回覆」那型", x.cue({ kind: "done", snippet: "要用哪組？" }) === true && x.made[0].a.body === "等你回覆：要用哪組？" && x.tracked.join() === "reply_notif:await");
x = mk(); x.ctx.setPending({ sid: SID, awaiting: true });
ok("fail 不被 awaiting 改型", x.cue({ kind: "fail", snippet: "" }) === true && x.made[0].a.body === "沒做完。" && x.tracked.join() === "reply_notif:fail");
x = mk(); x.ctx.setPending({ sid: SID, awaiting: true });
ok("stopped:不發(awaiting 也不發)", x.cue({ kind: "stopped", snippet: "" }) === false && x.made.length === 0 && x.ctx.get().replyPending === null);
x = mk({ focused: true }); x.ctx.setPending({ sid: SID, awaiting: false });
ok("視窗在前景:不發", x.cue({ kind: "done", snippet: "x" }) === false && x.made.length === 0);
x = mk({ pref: false }); x.ctx.setPending({ sid: SID, awaiting: false });
ok("開關關著:不發", x.cue({ kind: "done", snippet: "x" }) === false && x.made.length === 0);
x = mk();
ok("沒有 pending(不是這台剛結束的回合):不發", x.cue({ kind: "done", snippet: "x" }) === false && x.made.length === 0);
x = mk(); x.ctx.setPending({ sid: "../etc", awaiting: false });
ok("pending 的對話 id 不合格:不發", x.cue({ kind: "done", snippet: "x" }) === false);
x = mk({ supported: false }); x.ctx.setPending({ sid: SID, awaiting: false });
ok("系統不支援通知:不發", x.cue({ kind: "done", snippet: "x" }) === false);
x = mk({ labels: {} }); x.ctx.setPending({ sid: SID, awaiting: false });
ok("字還沒交過來:不發", x.cue({ kind: "done", snippet: "x" }) === false && x.made.length === 0);
x = mk(); x.ctx.setPending({ sid: SID, awaiting: false });
ok("cue 不是物件:不發、pending 照清", x.cue("done") === false && x.ctx.get().replyPending === null);
x = mk(); x.ctx.setPending({ sid: SID, awaiting: false });
class SilentN { constructor(a) { this.a = a; this.h = {}; } on(ev, f) { (this.h[ev] = this.h[ev] || []).push(f); return this; } show() { (this.h.failed || []).forEach((f) => f({}, "not signed")); } static isSupported() { return true; } }
x.ctx.Notification = SilentN; x.cue({ kind: "done", snippet: "x" });
ok("failed(作業系統關了通知):記 os_off、osOff 立起、從存活集合拿掉", x.tracked.join() === "reply_notif:os_off" && x.ctx.get().replyOsOff === true && x.ctx.p1Alive.size === 0);
{ const y = mk(); y.ctx.setPending({ sid: SID, awaiting: false }); vm.runInContext("replyOsOff = true", y.ctx); y.cue({ kind: "done", snippet: "x" });
  ok("下一則成功 show:osOff 收掉", y.ctx.get().replyOsOff === false); }
{ const y = mk(); y.ctx.setPending({ sid: SID, awaiting: false }); y.cue({ kind: "done", snippet: "x" }); y.ctx.setPending({ sid: SID, awaiting: false });
  y.ctx.replyTurnStart();
  ok("下一輪開始:上一則還沒點的收掉、pending 清掉", y.made[0].closed === true && y.ctx.get().replyLast === null && y.ctx.get().replyPending === null); }

// ---- 5. 接線
const rt = fn(main, "runTurn");
ok("runTurn:一開始先收掉上一則(replyTurnStart)", /replyTurnStart\(\);\n  sessWaitingSave\(sessionId, false\);/.test(rt));
ok("runTurn:done chunk 記 awaiting(同 sessWaitingSave 那個值)", /turnAwaiting = c\.awaiting === true; sessWaitingSave\(sessionId, turnAwaiting\);/.test(rt));
ok("runTurn:close 時記 pending(用 runTurn 的 sessionId,不看畫面開著哪條)、在送 turn-end 之前", /replyPending = \{ sid: sessionId, awaiting: turnAwaiting \};[^\n]*\n[^\n]*\n    if \(!win\.isDestroyed\(\)\) win\.webContents\.send\("turn-end"/.test(rt));
ok("send-message:runTurn 失敗那條(畫面也會收到 turn-end)也記 pending", /\.catch\(\(err\) => \{[^\n]*\n      replyPending = \{ sid: payload && payload\.sessionId, awaiting: false \};\n      if \(win && !win\.isDestroyed\(\)\) win\.webContents\.send\("turn-end"/.test(main));
ok("IPC:reply-cue 與三支設定 handler 都只收自家頁面", /ipcMain\.on\("reply-cue", \(e, cue\) => \{ if \(fromOurPage\(e\)\) replyCue\(cue\); \}\);/.test(main)
  && /handle\("reply-notify", /.test(main) && /handle\("reply-notify-set", /.test(main) && /handle\("reply-notify-os", /.test(main));
ok("「開啟系統設定」網址寫死(Windows ms-settings:notifications;macOS 系統設定的通知頁)", /ms-settings:notifications/.test(fn(main, "replyOsSettings")) && /x-apple\.systempreferences:/.test(fn(main, "replyOsSettings")));
ok("tmLabels 預先列好五個 rc_ 鍵(trade-labels 只收已經在表上的鍵)", /rc_await: "", rc_fail: "", rc_doneEmpty: "", rc_awaitEmpty: "", rc_failEmpty: "",/.test(main));
ok("回合結束提示那段不碰 p1Badge／setBadge", !/p1Badge|setBadge/.test(fn(main, "replyCue") + fn(main, "replyTurnStart") + fn(main, "replyBody")));
const te = app.slice(app.indexOf("window.blave.onTurnEnd("));
ok("畫面:faulted 算完、錯誤卡都掛好之後才送 reply-cue(停止 → stopped)", /pendingErr = \[\];\n  replyCueSend\(stopped \? "stopped" : faulted \? "fail" : "done"/.test(te) && te.indexOf("replyCueSend(") > te.indexOf("const faulted ="));
ok("畫面:摘錄走 replySnippet;沒做完又沒回覆時用錯誤卡那一句,不用 errTail", /replySnippet\(reply\)/.test(fn(app, "replyCueSend")) && /\.fault-body > div/.test(fn(app, "replyCueSend")) && /!turnFaultEl\.classList\.contains\("is-calm"\)/.test(fn(app, "replyCueSend")) && !/errTail/.test(fn(app, "replyCueSend")));
ok("畫面:點通知開那條對話——已是那條、回合中、清單上沒有(被刪了)都不動", /if \(!id \|\| id === sessionId \|\| busyOn\(\)\) return;/.test(app) && /list\.some\(\(m\) => m && m\.id === id\) && !busyOn\(\)\) csOpen\(id\)/.test(app));

// ---- 6. 設定列與字
const html = fs.readFileSync(path.join(S, "renderer", "index.html"), "utf8");
ok("設定 › 一般:開關在「自動下單時不讓電腦睡」上面、sw-row、不寫說明句;OS 關掉那行預設藏著", html.indexOf('id="set-rn-sw"') > 0 && html.indexOf('id="set-rn-sw"') < html.indexOf('id="set-awake-sw"')
  && /<div class="sw-row"><span class="sw-l" id="set-rn-l" data-i18n="set.rn"><\/span><button type="button" class="sw" id="set-rn-sw" role="switch"/.test(html) && /id="set-rn-os" hidden>/.test(html));
const po = (lang) => fs.readFileSync(path.join(S, "i18n", lang + ".po"), "utf8"), str = (src, k) => (src.match(new RegExp('msgid "' + k.replace(/\./g, "\\.") + '"\nmsgstr "([^"]*)"')) || [])[1];
const WANT = { zh: { "set.rn": "回覆好了通知我", "set.rn.osOff": "系統通知已關閉。", "set.rn.osGo": "開啟系統設定", "rc.await": "等你回覆：", "rc.fail": "沒做完：", "rc.doneEmpty": "回覆好了。", "rc.awaitEmpty": "等你回覆。", "rc.failEmpty": "沒做完。" },
  en: { "set.rn": "Notify me when a reply is done", "set.rn.osOff": "System notifications are off.", "set.rn.osGo": "Open System Settings", "rc.await": "Waiting for you:", "rc.fail": "Didn’t finish:", "rc.doneEmpty": "Reply ready.", "rc.awaitEmpty": "Waiting for your reply.", "rc.failEmpty": "Didn’t finish." } };
for (const lang of ["zh", "en"]) { const src = po(lang); ok(lang + ".po:八個字照 spec §3.3(rc.failEmpty 是 spec 沒寫的空摘錄,待 Wei 定)", Object.entries(WANT[lang]).every(([k, v]) => str(src, k) === v), Object.keys(WANT[lang]).filter((k) => str(src, k) !== WANT[lang][k])); }
const tr = fs.readFileSync(path.join(S, "renderer", "trade.js"), "utf8");
ok("trade-labels 交五個 rc_ 字給主行程", /rc_await: t\("rc\.await"\), rc_fail: t\("rc\.fail"\), rc_doneEmpty: t\("rc\.doneEmpty"\), rc_awaitEmpty: t\("rc\.awaitEmpty"\), rc_failEmpty: t\("rc\.failEmpty"\),/.test(tr));

console.log(red ? red + " 紅" : "ALL PASS");
process.exit(red ? 1 : 0);
