// 「等你回覆」標記與 done.awaiting(references/turn-events.md;0.1.19 電腦版只存不畫——Wei 拍板電腦版不做「做完還沒看」)
//   1. aiParts(app.js):<await/> 三種寫法在串流與定稿都剝掉;串流中半截的(<awa)比照 <sug 先藏;定稿時真的以 <awa 結尾的留著
//   2. 主行程(main.js):done 的 awaiting 存進 state/chat-meta/<session>.json、新一輪送出就清掉、刪對話一起刪;listSessions 帶 waiting;kinds 不存
//   3. renderer 現在不畫 waiting(對話列沒有狀態字)
// 跑法:node tests/check_shell_await.js
const fs = require("fs"), path = require("path"), vm = require("vm"), os = require("os");
const SHELL = path.join(__dirname, "..", "shell"), R = path.join(SHELL, "renderer");
const app = fs.readFileSync(path.join(R, "app.js"), "utf8"), mainSrc = fs.readFileSync(path.join(SHELL, "main.js"), "utf8");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  " + JSON.stringify(d))); if (!c) red++; };
const cut = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); if (i < 0 || j < 0) throw new Error("找不到原文:" + a); return src.slice(i, j); };

// ── 1. aiParts ──
const md = fs.readFileSync(path.join(R, "md.js"), "utf8");
eval((md.slice(0, md.indexOf("const mdEl")) + cut(app, "const CARD_TAG", "function paintAi")).replace(/^const /gm, "var "));
const textOf = (r) => { let o = ""; const walk = (x) => { if (Array.isArray(x)) return x.forEach(walk); if (x && typeof x === "object") { if (typeof x.text === "string") o += x.text; if (typeof x.code === "string") o += x.code; Object.values(x).forEach(walk); } }; walk(r.blocks); return o; };
for (const [name, raw, want] of [
  ["<await/>", "要用哪個帳戶？\n<await/>", "要用哪個帳戶？"],
  ["<await />", "要用哪個帳戶？\n<await />", "要用哪個帳戶？"],
  ["<await></await>", "要用哪個帳戶？\n<await></await>", "要用哪個帳戶？"],
  ["<await/> 在 <suggest> 前面(契約的順序)", "要用哪個帳戶？\n<await/>\n<suggest>\nBinance\nOKX\n</suggest>", "要用哪個帳戶？"],
  ["<await/> 在 <export> 後面", "匯出好了。\n<blave-card:data-access/>\n<await/>", "匯出好了。"],
]) for (const live of [true, false]) {
  const s = textOf(aiParts(raw, live));
  ok("aiParts(" + (live ? "串流" : "定稿") + "):" + name + " → 聊天文字沒有 <await", !/<\/?await/.test(s) && s === want, s);
}
ok("串流中 <await/> 還沒湊齊(<a、<awa、<await、<await/、<await )先藏,不閃出字面;<await></awa 也藏", ["<a", "<aw", "<awa", "<await", "<await/", "<await ", "<await></awa"].every((h) => textOf(aiParts("回測跑完了。\n" + h, true)) === "回測跑完了。"),
  ["<a", "<awa", "<await/", "<await></awa"].map((h) => textOf(aiParts("回測跑完了。\n" + h, true))));
ok("定稿時真的以 <awa 結尾的回覆原樣留著;<awesome> 這種不是前綴的不藏;談到 await 這個字不動", textOf(aiParts("回測跑完了。 <awa", false)).endsWith("<awa") && textOf(aiParts("x <awe", true)).endsWith("<awe") && textOf(aiParts("Python 的 await 怎麼用", false)) === "Python 的 await 怎麼用");
ok("<suggest> 的既有行為不變(半截先藏、定稿留著)", ["<s", "<sug", "<suggest"].every((h) => textOf(aiParts("回測跑完了。\n" + h, true)) === "回測跑完了。") && textOf(aiParts("回測跑完了。 <sug", false)).endsWith("<sug"));

// ── 2. 主行程:存 / 讀 / 清 ──
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blave-await-"));
  const M = { fs, path, BASE: tmp, okSessionId: (id) => typeof id === "string" && /^desktop-[a-z0-9]{4,16}$/.test(id), JSON, Date };
  vm.createContext(M); vm.runInContext(cut(mainSrc, "/* ── 對話 meta(", "// ── 聊天裡的圖").replace(/^const /gm, "var "), M);
  const sid = "desktop-zzzz0002";
  ok("存 true → 讀 true(檔在 state/chat-meta/<session>.json、0600);存 false → 檔刪掉、讀 false;沒存過 → false;壞 id 不落地",
    M.sessWaitingSave(sid, true) === true && M.sessWaitingLoad(sid) === true && fs.existsSync(path.join(tmp, "state", "chat-meta", sid + ".json"))
    && (process.platform === "win32" || (fs.statSync(path.join(tmp, "state", "chat-meta", sid + ".json")).mode & 0o777) === 0o600)
    && M.sessWaitingSave(sid, false) === true && !fs.existsSync(path.join(tmp, "state", "chat-meta", sid + ".json")) && M.sessWaitingLoad(sid) === false
    && M.sessWaitingLoad("desktop-never000") === false && M.sessWaitingSave("../etc", true) === false && M.sessWaitingLoad("../etc") === false);
  ok("只認 awaiting === true:字串 'true' / 1 / undefined 都當 false(契約:awaiting 是 bool、永遠在)", M.sessWaitingSave(sid, "true") === true && M.sessWaitingLoad(sid) === false && M.sessWaitingSave(sid, 1) === true && M.sessWaitingLoad(sid) === false);
  fs.writeFileSync(path.join(tmp, "state", "chat-meta", sid + ".json"), "{not json");
  ok("壞檔讀成 false,不拋", M.sessWaitingLoad(sid) === false);
  fs.rmSync(tmp, { recursive: true, force: true });
  const store = cut(mainSrc, "/* ── 對話 meta(", "// ── 聊天裡的圖");
  ok("接線:done 那一行存 awaiting(=== true)、runTurn 一開始清掉(同 api /send)、listSessions 帶 waiting、deleteSession 連檔一起刪;kinds 不存",
    /if \(c && c\.type === "done"\) \{ turnFinalized = true; sessWaitingSave\(sessionId, c\.awaiting === true\); \}/.test(mainSrc)
    && /if \(!okSessionId\(sessionId\)\) throw new Error\("bad session id"\);\n  sessWaitingSave\(sessionId, false\);/.test(mainSrc)
    && /waiting: sessWaitingLoad\(r\.id\) \}\)\);/.test(cut(mainSrc, "function listSessions(", "function loadSession("))
    && /fs\.rmSync\(path\.join\(META_DIR, id \+ "\.json"\), \{ force: true \}\);/.test(cut(mainSrc, "function deleteSession(", "/* ── 聊天結果卡"))
    && !/\bc\.kinds\b|kinds:/.test(mainSrc));
}

// ── 3. renderer 不畫 ──
ok("renderer 現在不讀 waiting / awaiting(對話列沒有狀態字;要畫的時候連「回覆中 · 時長」一起做)", !/\.awaiting\b|\b(?:m|row|s|x|it)\.waiting\b/.test(app) && !/waiting/.test(cut(app, "function csRow(", "\n}\n")));

console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0);
