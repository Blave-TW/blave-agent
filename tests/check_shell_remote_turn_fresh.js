// 畫面外開跑的回合(手機那一輪:chattabs.js tabsOnEvent 收到 started)要跟 submitMessage 一樣把每輪狀態歸零。
// 0.1.42 實測:沒歸零時 liveBubble 還指著上一輪的回覆泡泡——下一輪碰工具就把它拔掉(上一輪回覆不見),
// 沒碰工具就把新回覆接進那顆舊泡泡(排在新問題上面)。這裡照原文切出 tabsOnEvent／turnEventIn／draftPromote 實跑三輪。
// 跑法:node tests/check_shell_remote_turn_fresh.js
const fs = require("fs"), path = require("path");
const R = path.join(__dirname, "..", "shell", "renderer");
const app = fs.readFileSync(path.join(R, "app.js"), "utf8"), ct = fs.readFileSync(path.join(R, "chattabs.js"), "utf8");
const fnOf = (src, name) => { const i = src.search(new RegExp("(async )?function " + name + "\\(")); if (i < 0) throw new Error("找不到 " + name); return src.slice(i, src.indexOf("\n}", i) + 2); };
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };

const chat = { kids: [] };
const node = (kind) => { const n = { kind, _raw: "", _cards: [], parentNode: chat, remove() { chat.kids.splice(chat.kids.indexOf(n), 1); n.parentNode = null; } }; chat.kids.push(n); return n; };
const env = {
  T: { sid: "s1" }, CS: { main: new Map() }, MP: { model: null }, UPD: { turnCloud: false }, LIMIT_READONLY: [], cur: "claude", sessionId: "s1",
  tabsOf: () => env.T, tabsQueued() {}, tabsPaint() {}, withTab: (_T, fn) => fn(),
  addMsg: (kind) => node(kind), paintAi: (b, raw) => { b._raw = raw; },
  busyStart() { env.busy = { anchor: null }; }, busyHide() {}, busyStep() {}, busyStepDone() {}, busyReason() {}, busySet() {}, actToolPrep() {}, scrollChat() {}, upPaint() {}, sysLine() {}, addImage() {}, addFault() {},
  actKindOf: () => ({ kind: "x" }), stepWhere: () => "local", classifyFault: () => null, turnFailOf: () => null, trackEvent() {}, holdErrors: () => false, t: (k) => k,
};
const names = ["collectDraft", "draftShow", "draftPromote", "turnEventIn"].concat(/function turnFresh\(/.test(app) ? ["turnFresh"] : []);
const vars = "var running = false, turnSeq = 0, turnSeqMine = 0, draft = '', liveBubble = null, busy = null, ACT = { textStart: 0, lastDelta: 0 }, faultShown = false, turnLimit = false, turnChanged = false, pendingErr = [], turnAiBubbles = [], turnFaultEl = null,"
  + " turnModel = null, turnGotReply = false, turnErrored = false, turnFaulted = false, turnCap = false, turnCards = [], turnBubble = null, turnHadTool = false, turnFail = null, turnFailSrc = null, lastUserTyped = true;";
const S = new Function("env", "with (env) { " + vars + "\n" + names.map((n) => fnOf(app, n)).join("\n") + "\n" + fnOf(ct, "tabsOnEvent")
  + "\nreturn { ev: tabsOnEvent, end: () => { running = false; }, st: () => ({ liveBubble, lastUserTyped }) }; }")(env);

const turn = (chunks) => { for (const c of [{ type: "started", sid: "s1" }].concat(chunks)) S.ev({ sid: "s1", ...c }); S.end(); };
const ai = () => chat.kids.filter((n) => n.kind === "ai");

turn([{ type: "text", text: "嗨！" }, { type: "done" }]);
const b1 = ai()[0];
turn([{ type: "text", text: "我來查" }, { type: "tool", tool: "Bash", status: "running" }, { type: "tool", tool: "Bash", status: "done" }, { type: "text", text: "夜盤大跌" }, { type: "done" }]);
ok("第二輪碰工具:第一輪的回覆泡泡還在畫面上", !!b1 && b1.parentNode === chat && b1._raw === "嗨！", ai().map((n) => n._raw));
turn([{ type: "text", text: "我是 Claude" }, { type: "done" }]);
const raws = ai().map((n) => n._raw);
ok("三輪三顆回覆泡泡,各是自己那一輪的字", JSON.stringify(raws) === JSON.stringify(["嗨！", "夜盤大跌", "我是 Claude"]), raws);
ok("畫面外的回合不認上一輪電腦前打的那句(停止時不塞回輸入框)", S.st().lastUserTyped === false, S.st().lastUserTyped);

console.log(red ? "\n" + red + " FAIL" : "\nall PASS");
process.exit(red ? 1 : 0);
