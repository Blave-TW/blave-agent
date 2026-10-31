// 第一次對話 modal(shell/renderer/intro.js + main.js introCheck;spec-desktop-first-chat-modal-2026-10-25 §6.1)。不起 Electron。
//   ① introDecide(從原文切出來跑):每一種不彈的原因列舉一次,外加全部成立會彈的那一格
//   ② introSync:主行程那一問放最後、只問一次;回覆不是 { show: true } 一律不彈
//   ③ introEngineWatch:快照已是失敗就不叫 ensureEngine(會從頭重裝);這次失敗過,之後重試成功也不算可用
//   ④ main.js introCheck 接暫存 sqlite(要 node:sqlite,Node 22.5+;沒有就只做靜態 SQL 檢查):
//      檔不在 / 有 user turn(非 desktop- 前綴也算)/ 只有 assistant / 開檔失敗 / 沒有 turns 表 / ui-prefs 壞掉 / 已有 introSeen
//   ⑤ 接線:submitMessage 過了空句與回合中那道才記、escTop、wdPaint、preload、IPC 預設值、載入順序、四個埋點字面
//   ⑥ 示範影片:兩支片與兩張 poster 在 renderer/intro/、introMedia 的語言對應、CSP 開 media-src、intro.play 兩語有字
// 跑法:node tests/check_shell_intro.js
const fs = require("fs"), path = require("path"), os = require("os");
const SHELL = path.join(__dirname, "..", "shell"), R = path.join(SHELL, "renderer");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + String(d).slice(0, 600))); if (!c) red++; };
const read = (f) => fs.readFileSync(f, "utf8");
const src = read(path.join(R, "intro.js")), mainSrc = read(path.join(SHELL, "main.js")), appSrc = read(path.join(R, "app.js"));
const cutFn = (s, name) => { const i = s.indexOf("function " + name + "("); if (i < 0) throw new Error("no " + name); let d = 0; for (let k = s.indexOf("{", i); k < s.length; k++) { if (s[k] === "{") d++; else if (s[k] === "}" && --d === 0) return s.slice(i, k + 1); } throw new Error("unbalanced " + name); };
const tick = () => new Promise((r) => setImmediate(r));

// ① 純函式
const introDecide = new Function(cutFn(src, "introDecide") + "; return introDecide;")();
const PASS = { done: false, conn: true, engine: "ok", acctKnown: true, fill: false, sent: false, running: false, modal: false, visible: true, check: { show: true } };
ok("全部成立 → 彈", introDecide(PASS) === "");
const NO = [
  ["已經彈過(這次開著)", { done: true }, "done"],
  ["還沒連上 AI", { conn: false }, "conn"],
  ["主行程讀取出錯(回 show:false)", { check: { show: false } }, "ipc"],
  ["老用戶升級(有 user turn,主行程回 show:false)", { check: { show: false } }, "ipc"],
  ["已有 introSeen(主行程回 show:false)", { check: { show: false } }, "ipc"],
  ["主行程還沒回 / 假的 IPC 回 undefined", { check: undefined }, "ipc"],
  ["主行程回的不是 true(\"true\"、1)", { check: { show: "true" } }, "ipc"],
  ["引擎這次開著失敗過", { engine: "fail" }, "engine_fail"],
  ["引擎還在等", { engine: "wait" }, "engine_wait"],
  ["帳號狀態未知(連 Blave AI、已登入、還沒回或回 null)", { acctKnown: false }, "acct"],
  ["stFill 為真(確定跑不了)", { fill: true }, "fill"],
  ["這次開著送出過", { sent: true }, "sent"],
  ["回合在跑", { running: true }, "running"],
  ["別的 modal 開著 / 工作頁藏著", { modal: true }, "modal"],
  ["視窗藏起來", { visible: false }, "hidden"],
];
for (const [n, patch, why] of NO) ok("不彈:" + n, introDecide({ ...PASS, ...patch }) === why, introDecide({ ...PASS, ...patch }));

// ② introSync:其餘條件成立才問主行程、只問一次;回 show:true 才彈
async function syncCase(reply, patch) {
  const calls = { ask: 0, show: 0 }, INTRO = { done: false, engine: "ok", sent: false, check: undefined };
  const ctx = { INTRO, introDecide, introShow: () => { calls.show++; INTRO.done = true; },
    introInputs: () => ({ ...PASS, ...patch, done: INTRO.done, check: INTRO.check }),
    window: { blave: { introCheck: () => { calls.ask++; return typeof reply === "function" ? reply() : reply; } } } };
  const introSync = new Function("ctx", "with (ctx) { return " + cutFn(src, "introSync") + "; }")(ctx);
  ctx.introSync = introSync;
  introSync(); introSync(); await tick(); await tick(); introSync(); await tick();
  return calls;
}
(async () => {
  let c = await syncCase({ show: true });
  ok("主行程回 show:true → 問一次、彈一次", c.ask === 1 && c.show === 1, JSON.stringify(c));
  c = await syncCase({ show: false });
  ok("主行程回 show:false → 問一次、不彈、之後不再問", c.ask === 1 && c.show === 0, JSON.stringify(c));
  c = await syncCase(undefined);
  ok("IPC 回 undefined(測試的假 window.blave)→ 不彈", c.ask === 1 && c.show === 0, JSON.stringify(c));
  c = await syncCase(() => Promise.reject(new Error("x")));
  ok("IPC 丟錯 → 不彈", c.ask === 1 && c.show === 0, JSON.stringify(c));
  c = await syncCase({ show: true }, { sent: true });
  ok("前面有條件不成立 → 根本不問主行程", c.ask === 0 && c.show === 0, JSON.stringify(c));

  // ③ 引擎
  async function engCase({ snap, ensure, failEvent }) {
    const INTRO = { engine: "wait" }, calls = { ensure: 0, sync: 0 }; let onState = null;
    const ctx = { INTRO, introSync: () => { calls.sync++; },
      window: { blave: { onEngineState: (fn) => { onState = fn; }, engineState: () => (typeof snap === "function" ? snap() : snap),
        ensureEngine: () => { calls.ensure++; if (failEvent) onState({ phase: "fail" }); return ensure === "reject" ? Promise.reject(new Error("x")) : Promise.resolve(); } } } };
    const w = new Function("ctx", "with (ctx) { return " + cutFn(src, "introEngineWatch") + "; }")(ctx);
    await w(); await tick();
    return { engine: INTRO.engine, ...calls };
  }
  let e = await engCase({ snap: { phase: "fail", show: true } });
  ok("快照已是失敗 → 不叫 ensureEngine(不替用戶重裝)、記失敗", e.ensure === 0 && e.engine === "fail", JSON.stringify(e));
  e = await engCase({ snap: { phase: "idle" } });
  ok("早就裝好(快照停在 idle)→ ensureEngine 立刻 resolve → 可用、重判一次", e.ensure === 1 && e.engine === "ok" && e.sync === 1, JSON.stringify(e));
  e = await engCase({ snap: { phase: "run" }, ensure: "reject" });
  ok("安裝中、之後失敗(reject)→ 失敗", e.engine === "fail" && e.sync === 0, JSON.stringify(e));
  e = await engCase({ snap: { phase: "run" }, failEvent: true });
  ok("這次失敗過(事件)、之後重試成功 resolve → 仍是失敗、不重判", e.engine === "fail" && e.sync === 0, JSON.stringify(e));
  e = await engCase({ snap: () => Promise.reject(new Error("x")) });
  ok("讀不到快照 → 照常等 ensureEngine", e.ensure === 1 && e.engine === "ok", JSON.stringify(e));

  // ④ main.js introCheck
  const body = cutFn(mainSrc, "introCheck");
  ok("introCheck 不借 sessionDb / onbPrefsGet / listSessions(出錯時會把老用戶判成新用戶)", !/sessionDb\(|onbPrefsGet\(|listSessions\(/.test(body));
  ok("introCheck 的 SQL 不篩 desktop- 前綴、不帶 LIMIT 200", /role = 'user'/.test(body) && !/desktop-/.test(body) && !/LIMIT 200/.test(body));
  let sqlite = null; try { sqlite = require("node:sqlite"); } catch (_) { /* Node < 22.5 */ }
  if (!sqlite) console.log("SKIP  introCheck 接暫存 sqlite(這個 Node " + process.version + " 沒有 node:sqlite;用 Node 22.5+ 跑)");
  else {
    const T = fs.mkdtempSync(path.join(os.tmpdir(), "blave-intro-"));
    let n = 0;
    const run = ({ prefs, db }) => {
      const d = path.join(T, String(n++)); fs.mkdirSync(d);
      const P = path.join(d, "ui-prefs.json"), DB = path.join(d, "session.db");
      if (prefs !== undefined) fs.writeFileSync(P, prefs);
      if (db === "dir") fs.mkdirSync(DB);
      else if (db === "garbage") fs.writeFileSync(DB, "not a database at all, just bytes");
      else if (db) { const x = new sqlite.DatabaseSync(DB); x.exec(db.schema || "CREATE TABLE turns (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, created_at REAL)");
        for (const [sid, role] of db.rows || []) x.prepare("INSERT INTO turns (session_id, role, content, created_at) VALUES (?, ?, 'x', 0)").run(sid, role); x.close(); }
      const ctx = { fs, require, SESSION_DB: DB, uiPrefsPath: () => P };
      return new Function("ctx", "with (ctx) { return " + body + "; }")(ctx)();
    };
    const C = [
      ["全新安裝:沒有 ui-prefs、沒有 session.db → 彈", {}, true],
      ["ui-prefs 有別的偏好、沒有 introSeen、沒有 session.db → 彈", { prefs: '{"theme":"dark"}' }, true],
      ["已有 introSeen → 不彈", { prefs: '{"introSeen":true}' }, false],
      ["ui-prefs 壞掉(讀得到檔、解析失敗)→ 不彈", { prefs: "{nope" }, false],
      ["session.db 只有 assistant → 彈", { db: { rows: [["desktop-abcd", "assistant"]] } }, true],
      ["session.db 是空的 turns 表 → 彈", { db: { rows: [] } }, true],
      ["有 user turn(desktop-)→ 不彈", { db: { rows: [["desktop-abcd", "assistant"], ["desktop-abcd", "user"]] } }, false],
      ["有 user turn(不是 desktop- 前綴)→ 不彈", { db: { rows: [["web-x", "user"]] } }, false],
      ["session.db 開不起來(是資料夾)→ 不彈", { db: "dir" }, false],
      ["session.db 不是資料庫 → 不彈", { db: "garbage" }, false],
      ["session.db 還沒有 turns 表 → 不彈", { db: { schema: "CREATE TABLE other (x)" } }, false],
    ];
    for (const [name, fx, want] of C) { let r; try { r = run(fx); } catch (err) { r = err; } ok("introCheck:" + name, r && r.show === want, JSON.stringify(r) || String(r)); }
    fs.rmSync(T, { recursive: true, force: true });
  }
  ok("introSeenSet 寫 ui-prefs 的 introSeen(不動 welcome-prefs 的白名單)", /uiPrefsPatch\(\{ introSeen: true \}\)/.test(cutFn(mainSrc, "introSeenSet")));
  ok("IPC:intro-check 拒絕時回 { show: false }、intro-seen 走自家頁面守門",
    /handle\("intro-check", \(\) => introCheck\(\), \{ show: false \}\);/.test(mainSrc) && /handle\("intro-seen", \(\) => introSeenSet\(\), false\);/.test(mainSrc));
  const pre = read(path.join(SHELL, "preload.js"));
  ok("preload 開放 introCheck / introSeen", /introCheck: \(\) => ipcRenderer\.invoke\("intro-check"\)/.test(pre) && /introSeen: \(\) => ipcRenderer\.invoke\("intro-seen"\)/.test(pre));

  // ⑤ 接線
  const sm = cutFn(appSrc, "submitMessage"), g = sm.indexOf("|| running) return false;"), m = sm.indexOf("introMarkSent()");
  ok("submitMessage:空句 / 回合中那道之後就記「送出過」(所有入口都經過這裡)", g > 0 && m > g && m < sm.indexOf("running = true"));
  ok("escTop 收得到第一次對話框", /!\$\("intro-scrim"\)\.hidden \? \(\) => introClose\("close"\)/.test(cutFn(appSrc, "escTop")));
  ok("帳號狀態變了(wdPaint)會重判", /introSync\(\)/.test(cutFn(read(path.join(R, "welcome.js")), "wdPaint")));
  const html = read(path.join(R, "index.html")), at = (s) => html.indexOf(s);
  ok("index.html:intro.js 排在 welcome.js、browser.js 之後;intro.css 有載;框在設定框前面、預設藏著",
    at('<script src="intro.js">') > at('<script src="welcome.js">') && at('<script src="intro.js">') > at('<script src="browser.js">') && at('href="intro.css"') > 0
    && at('id="intro-scrim"') > 0 && at('id="intro-scrim"') < at('id="set-scrim"') && /<div class="scrim" id="intro-scrim"[^>]*\bhidden>/.test(html));
  ok("點遮罩不關(intro-scrim 沒有 mousedown / click 關框)", !/intro-scrim"\)\.addEventListener\("(mousedown|click)"/.test(src));
  for (const n of ["intro_shown", "intro_send"]) ok("埋點 " + n + " 是字面送出點", src.includes('trackFeature("' + n + '")'));
  ok("埋點 intro_type / intro_close 是字面送出點", src.includes('trackFeature(how === "type" ? "intro_type" : "intro_close")'));
  const vm = require("vm"), S = (() => { const sb = {}; vm.runInNewContext(read(path.join(R, "strings.js")) + "\nthis.S = STRINGS;", sb); return sb.S; })();
  ok("送出句是 intro.msg(文案長度豁免的形狀),鈕字另一個 key", src.includes('csSendAway(t("intro.msg"))') && /data-i18n="intro\.ask"/.test(html) && S.zh["intro.msg"] !== S.zh["intro.ask"]);

  // ⑥ 示範影片
  const MEDIA = ["hero_demo_md.mp4", "hero_demo_zh_md.mp4", "hero_demo_poster.jpg", "hero_demo_zh_poster.jpg"];
  const gone = MEDIA.filter((f) => !fs.existsSync(path.join(R, "intro", f)) || !fs.statSync(path.join(R, "intro", f)).size);
  ok("兩支片、兩張 poster 都在 renderer/intro/(不是空檔)", !gone.length, gone.join());
  const introMedia = new Function(cutFn(src, "introMedia") + "; return introMedia;")();
  const want = { zh: ["intro/hero_demo_zh_md.mp4", "intro/hero_demo_zh_poster.jpg"], en: ["intro/hero_demo_md.mp4", "intro/hero_demo_poster.jpg"] };
  for (const [lang, w] of [["zh", want.zh], ["en", want.en], ["cn", want.en], [undefined, want.en]]) {
    const m = introMedia(lang);
    ok("語言 " + lang + " → " + w[0] + " + " + w[1], m.src === w[0] && m.poster === w[1], JSON.stringify(m));
  }
  ok("introMedia 給的路徑都對得到檔", ["zh", "en"].every((l) => { const m = introMedia(l); return fs.existsSync(path.join(R, m.src)) && fs.existsSync(path.join(R, m.poster)); }));
  ok("introShow 照當下的 LANG 挑檔", /introMedia\(LANG\)/.test(cutFn(src, "introShow")));
  ok("index.html CSP 開 media-src 'self'", /http-equiv="Content-Security-Policy" content="[^"]*\bmedia-src 'self';/.test(html));
  ok("intro.play 兩語有字", !!(S.zh["intro.play"] && S.en["intro.play"]), JSON.stringify([S.zh["intro.play"], S.en["intro.play"]]));

  console.log(red ? `\n${red} 紅` : "\n全綠");
  process.exit(red ? 1 : 0);
})();
