// 錯誤回報(shell/errreport.js、renderer/errreport.js;spec agent-error-report-2026-11-16 §10 的最小檢查)。
//   1. 清洗:共用 fixture 每一則逐字等於 out、absent 的值不在;fixture 與 api 那份逐字相同(要 ../api 或 BLAVE_API_DIR,找不到 SKIP)
//   2. 指紋:fixture 的 hex 兩邊同一個
//   3. 自動送:同一批假訊息走 always,body 沒有 message、任何原值與原文都不在 body 裡
//   4. 一字不差:卡上顯示的文字 = 送出的 body 去掉 token、consent 後的同一份 JSON;token 不顯示
//   5. 沒按送出之前沒有任何請求;設定「不送」不出卡、不發請求、清檔;開發版不發請求
//   6. 每個本地日最多一張卡;〔不送〕的指紋 30 天內不再問、31 天後再問
//   7. 記錄檔:壞行丟掉不影響別行、超過 200 行丟最舊的、symlink 不跟(含截斷／consume 寫回時預先放好的 .tmp symlink)、manifest 對不上換 <other>、換完沒自家 frame 整筆丟
//   8. shell_main:主行程 Error → 一行;網路類、不是 Error 的不記;寫入端 symlink 不跟、超過 256 KB 不寫
//   9. 狀態檔壞掉 = 每次問我(不會變成自動送)
//  10. 接線:main.js 的 uncaughtExceptionMonitor 寫記錄、IPC 走 fromOurPage;畫面那支不碰對話存檔與手機同步
// 跑法:node tests/check_shell_errreport.js
"use strict";
const fs = require("fs"), path = require("path"), os = require("os");
const E = require(path.join(__dirname, "..", "shell", "errreport.js"));
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };

const FIX = path.join(__dirname, "fixtures", "error_report_cases.json");
const fx = JSON.parse(fs.readFileSync(FIX, "utf8"));
// ── 1 ──
for (const c of fx.scrub) {
  const got = E.scrub(c.in, c.known);
  ok(`1 ${c.name}`, got === c.out, { got, want: c.out });
  ok(`1 ${c.name}:原值不在`, !c.absent.some((v) => got.includes(v)), got);
}
const apiFix = path.join(process.env.BLAVE_API_DIR || path.join(__dirname, "..", "..", "api"), "tests", "fixtures", "error_report_cases.json");
if (!fs.existsSync(apiFix)) console.log("SKIP  1 fixture 兩端逐字比對(需要 ../api 或 BLAVE_API_DIR)");
else ok("1 fixture 與 api 那份逐字相同", fs.readFileSync(apiFix).equals(fs.readFileSync(FIX)), apiFix);
// ── 2 ──
for (const c of fx.fingerprint) ok(`2 指紋 ${c.source} ${c.exc_type}`, E.fingerprint(c.source, c.exc_type, c.frames) === c.hex);

// ── harness ──
const INSTALL = "3f2b8c1e-9a4d-4e7b-8c21-0a1b2c3d4e5f", TOKEN = "acct-" + "t".repeat(43);
function setup(o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "errrep-"));
  fs.mkdirSync(path.join(dir, "state"));
  const posts = [];
  let t = o.now || Date.UTC(2026, 10, 16, 4, 0, 0);
  const er = E.createErrReport({
    file: path.join(dir, "state", "error_reports.jsonl"), stateFile: path.join(dir, "error_report.json"), endpoint: "https://x/err",
    now: () => t, known: () => ["Hunter2pass", TOKEN],
    isOfficial: o.isOfficial || (() => true), isBundled: o.isBundled || (() => true),
    meta: () => ({ install_id: INSTALL, app_version: "0.1.56", runtime_version: "1.1.164", os: "mac", os_version: "15.5" }),
    token: () => TOKEN, post: (u, b) => { posts.push({ u, s: JSON.stringify(b), b }); return Promise.resolve({ status: 200 }); },
    live: o.live || (() => true),
  });
  const file = path.join(dir, "state", "error_reports.jsonl");
  const add = (recs) => fs.appendFileSync(file, recs.map((r) => (typeof r === "string" ? r : JSON.stringify(r)) + "\n").join(""));
  return { dir, er, posts, file, add, tick: (ms) => { t += ms; }, lines: () => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : []) };
}
const rec = (message, extra = {}) => ({ v: 1, ts: 1, source: "py_lib", exc_type: "KeyError", message, py_version: "3.12",
  frames: [{ file: "<other>" }, { file: "lib/runner.py", func: "run", line: 3120 }], ...extra });
const flush = () => new Promise((r) => setImmediate(r));

(async () => {
  // ── 3 ──
  {
    const h = setup();
    h.er.setMode("auto");
    h.add(fx.scrub.map((c, i) => rec(c.in, { exc_type: "E" + i })));
    ok("3 自動送:pending 不出卡", h.er.pending() === null);
    await flush();
    ok("3 …每一則都背景送出", h.posts.length === fx.scrub.length, h.posts.length);
    ok("3 …body 一律 consent always、沒有 message 這個 key", h.posts.every((p) => p.b.consent === "always" && !("message" in p.b)));
    const leak = [];
    for (const p of h.posts) for (const c of fx.scrub) for (const v of [...c.absent, ...(c.in.length > 3 ? [c.in] : [])]) if (p.s.includes(v)) leak.push(v);
    ok("3 …表中任何原值、原文都不在任何 body 裡", !leak.length, leak);
    ok("3 …白名單欄位剛好這幾個", Object.keys(h.posts[0].b).join() === "install_id,token,consent,source,exc_type,frames,app_version,runtime_version,os,os_version,py_version", Object.keys(h.posts[0].b));
    ok("3 …送完清掉記錄", h.lines().length === 0, h.lines());
  }
  // ── 4/5 ──
  {
    const h = setup();
    h.add([rec("login failed with Hunter2pass for A123456789"), rec("bitget accounts: USDT row has no accountEquity ({'available': '10234.5'", { exc_type: "ValueError" })]);
    const card = h.er.pending();
    await flush();
    ok("5 問我模式:有記錄就出卡、兩個指紋 = 2", card && card.n === 2, card);
    ok("5 沒按送出之前沒有任何請求", h.posts.length === 0, h.posts);
    ok("4 卡上不顯示 token、consent", card && !card.text.includes(TOKEN) && !card.text.includes("consent"), card && card.text);
    ok("4 卡上是清洗後的 message", card && card.text.includes("login failed with ⟦R⟧ for [id]") && !card.text.includes("10234.5"), card && card.text);
    ok("4 換一個 id 決定不算數", (await h.er.decide("nope", "send", false)) === false && h.posts.length === 0);
    await h.er.decide(card.id, "send", false);
    const sent = h.posts.map((p) => { const b = JSON.parse(p.s); delete b.token; delete b.consent; return b; });
    ok("4 一字不差:送出的 body 去掉 token、consent = 卡上那份", E.shownText(sent) === card.text, { sent: E.shownText(sent), card: card.text });
    ok("4 送出帶 consent once 與 token", h.posts.every((p) => p.b.consent === "once" && p.b.token === TOKEN));
    ok("5 送完清掉、模式仍是每次問我", h.lines().length === 0 && h.er.mode() === "ask");
    ok("5 同一個 id 不能送第二次", (await h.er.decide(card.id, "send", false)) === false && h.posts.length === 2);
  }
  {
    const h = setup();
    h.add([rec("x")]);
    const card = h.er.pending();
    await h.er.decide(card.id, "send", true);
    ok("5 勾了以後自動送:這一批照 once 帶 message", h.posts.length === 1 && h.posts[0].b.consent === "once" && "message" in h.posts[0].b);
    ok("5 …之後改成自動送", h.er.mode() === "auto");
    h.add([rec("y", { exc_type: "Other" })]);
    h.er.pending(); await flush();
    ok("5 …之後的新記錄背景送 always、沒有 message", h.posts.length === 2 && h.posts[1].b.consent === "always" && !("message" in h.posts[1].b));
  }
  {
    const h = setup();
    h.er.setMode("off");
    h.add([rec("x")]);
    ok("5 不送:不出卡", h.er.pending() === null);
    await flush();
    ok("5 不送:不發任何請求、清檔", h.posts.length === 0 && h.lines().length === 0);
    const h2 = setup({ live: () => false });
    h2.er.setMode("auto"); h2.add([rec("x")]); h2.er.pending(); await flush();
    ok("5 開發版不發請求", h2.posts.length === 0);
  }
  // ── 6 ──
  {
    const h = setup();
    h.add([rec("x")]);
    const c1 = h.er.pending();
    h.add([rec("y", { exc_type: "Other" })]);
    ok("6 同一個本地日第二次:不出卡", c1 && h.er.pending() === null);
    h.tick(86400000);
    const c2 = h.er.pending();
    ok("6 隔天:沒處理的併進下一張", c2 && c2.n === 2, c2);
    await h.er.decide(c2.id, "decline");
    ok("6 不送:記錄刪掉、沒有請求", h.lines().length === 0 && h.posts.length === 0);
    h.tick(86400000); h.add([rec("x again")]);
    ok("6 同指紋 30 天內不再問,記錄直接丟", h.er.pending() === null && h.lines().length === 0);
    h.tick(30 * 86400000); h.add([rec("x later")]);
    ok("6 過了 30 天再問", (h.er.pending() || {}).n === 1);
  }
  // ── 7 ──
  {
    const h = setup({ isOfficial: (rel) => rel !== "lib/order_mine.py" });
    h.add(["not json", JSON.stringify({ ...rec("x"), exc_type: "Bad\n" }), JSON.stringify({ ...rec("x"), frames: [{ file: "/Users/a/x.py", func: "f", line: 1 }] }),
      JSON.stringify({ ...rec("x"), frames: [{ file: "lib/../x.py", func: "f", line: 1 }] }),
      rec("innermost is agent-added", { frames: [{ file: "<other>" }, { file: "lib/order_mine.py", func: "place", line: 3 }, { file: "lib/runner.py", func: "run", line: 9 }] }),
      rec("good", { frames: [{ file: "lib/runner.py", func: "run", line: 9 }, { file: "lib/order_mine.py", func: "place", line: 3 }, { file: "<other>" }, { file: "lib/data.py", func: "get", line: 2 }] })]);
    const c = h.er.pending();
    const shown = c && JSON.parse(c.text);
    ok("7 壞行、路徑、..、結尾換行都丟;最內層自家格對不上 manifest(agent 加的檔 = 用戶的 code)整筆丟;只剩一則好的", c && c.n === 1 && shown[0].message === "good", c);
    ok("7 外層對不上 manifest 的換成 <other>、連續的併一格", shown && JSON.stringify(shown[0].frames) === JSON.stringify([{ file: "lib/runner.py", func: "run", line: 9 }, { file: "<other>" }, { file: "lib/data.py", func: "get", line: 2 }]), shown && shown[0].frames);
    ok("7 丟掉的行已經從檔裡清掉、好的那則等用戶決定", h.lines().length === 1, h.lines());
  }
  {
    const h = setup();
    h.add(Array.from({ length: 230 }, (_, i) => rec("m" + i, { exc_type: "E" + i })));
    const c = h.er.pending();
    ok("7 超過 200 行丟最舊的", c && c.n === 200 && !c.text.includes('"m29"') && c.text.includes('"m30"'), c && c.n);
  }
  {
    const h = setup();
    const outside = path.join(h.dir, "outside.jsonl");
    fs.writeFileSync(outside, JSON.stringify(rec("outside secret")) + "\n");
    fs.symlinkSync(outside, h.file);
    ok("7 記錄檔是 symlink:不讀、拿掉連結本身、外面的檔不動",
      h.er.pending() === null && !fs.existsSync(h.file) && fs.readFileSync(outside, "utf8").includes("outside secret"));
  }
  // 截斷與 consume 寫回時,工作區裡預先放好的 symlink 不能把主行程帶到工作區外(稽核 0156 S-1)
  if (process.platform !== "win32") {
    const outside = (h) => fs.readdirSync(h.dir).filter((f) => f !== "state" && f !== "error_report.json").sort().join();
    const plant = (h) => { const victim = path.join(h.dir, "victim.txt"); fs.writeFileSync(victim, "ORIGINAL\n"); fs.symlinkSync(victim, h.file + ".tmp");
      return { victim, intact: () => fs.readFileSync(victim, "utf8") === "ORIGINAL\n" && outside(h) === "victim.txt" }; };
    { const h = setup(), p = plant(h);
      h.add(Array.from({ length: 230 }, (_, i) => rec("m" + i, { exc_type: "E" + i })));
      const c = h.er.pending();
      ok("7 .tmp 預先是指向外面的 symlink:超過 200 行截斷 → 外面的檔一字不動、外面沒多出檔,記錄檔是一般檔、截成 200 行",
        p.intact() && c && c.n === 200 && !fs.lstatSync(h.file).isSymbolicLink() && h.lines().length === 200, [fs.readFileSync(p.victim, "utf8").slice(0, 80), outside(h)]); }
    { const h = setup(), p = plant(h);
      h.add(["not json", rec("good")]);
      const c = h.er.pending();
      if (c) await h.er.decide(c.id, "decline");
      ok("7 .tmp 預先是 symlink:consume 寫回(丟壞行、按〔不送〕清檔)→ 外面的檔一字不動", p.intact() && c && c.n === 1 && h.lines().length === 0, fs.readFileSync(p.victim, "utf8").slice(0, 80)); }
    { const h = setup(), ghost = path.join(h.dir, "ghost.txt");
      fs.symlinkSync(ghost, h.file + ".tmp");
      h.add(Array.from({ length: 201 }, (_, i) => rec("g" + i, { exc_type: "G" + i })));
      h.er.pending();
      ok("7 .tmp 預先是指向外面「還不存在」的 symlink:截斷不會在外面建出檔案", !fs.existsSync(ghost)); }
    { // 讀完、寫回之前記錄檔本身被換成 symlink:rename 換掉的是目錄項,外面的檔不動
      const h = setup(), victim = path.join(h.dir, "victim2.txt"); fs.writeFileSync(victim, "ORIGINAL\n");
      h.add(Array.from({ length: 201 }, (_, i) => rec("s" + i, { exc_type: "S" + i })));
      let swapped = false;
      const sneaky = Object.assign(Object.create(fs), { closeSync(fd) { fs.closeSync(fd); if (!swapped) { swapped = true; fs.unlinkSync(h.file); fs.symlinkSync(victim, h.file); } } });
      const er = E.createErrReport({ fs: sneaky, file: h.file, stateFile: path.join(h.dir, "s2.json"), endpoint: "x", now: () => 0, known: () => [],
        isOfficial: () => true, isBundled: () => true, meta: () => ({ install_id: INSTALL, app_version: "0.1.56", runtime_version: "1", os: "mac", os_version: "15" }),
        post: () => Promise.resolve(), live: () => true });
      er.pending();
      ok("7 讀完後記錄檔被換成 symlink:截斷寫回不會寫穿到外面", swapped && fs.readFileSync(victim, "utf8") === "ORIGINAL\n"); }
  }
  // ── 8 ──
  {
    const h = setup();
    const shellDir = __dirname;   // 這支測試檔當成 shell/ 底下的檔
    function boom() { throw new TypeError("cannot read x of undefined at /Users/alice/secret"); }
    let err; try { boom(); } catch (e) { err = e; }
    ok("8 主行程 Error → 寫一行", h.er.appendMain(err, shellDir) && h.lines().length === 1);
    const r = JSON.parse(h.lines()[0]);
    ok("8 …source shell_main、沒有 py_version、第一格是 shell/ 的檔", r.source === "shell_main" && !("py_version" in r)
      && r.exc_type === "TypeError" && r.frames[0].file === "shell/check_shell_errreport.js" && r.frames[0].func === "boom", r);
    const netErr = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    ok("8 網路類不記", !h.er.appendMain(netErr, shellDir) && !h.er.appendMain(new Error("net::ERR_INTERNET_DISCONNECTED"), shellDir));
    ok("8 不是 Error 的 rejection 不記", !h.er.appendMain("plain string", shellDir) && !h.er.appendMain({ message: "x" }, shellDir));
    ok("8 stack 裡沒有 shell/ 的檔不記", !h.er.appendMain(err, path.join(__dirname, "nowhere")));
    ok("8 記錄讀得回來、清洗後才顯示", (h.er.pending() || { text: "" }).text.includes("~/secret"));
    fs.appendFileSync(h.file, "x".repeat(E.MAX_FILE_BYTES + 1));
    ok("8 檔案超過 256 KB 不寫", !h.er.appendMain(err, shellDir));
    fs.unlinkSync(h.file);
    const outside = path.join(h.dir, "o.txt"); fs.writeFileSync(outside, ""); fs.symlinkSync(outside, h.file);
    ok("8 記錄檔是 symlink 不寫", !h.er.appendMain(err, shellDir) && fs.readFileSync(outside, "utf8") === "");
    const async = new Error("x"); async.stack = "Error: x\n    at async Object.<anonymous> (" + path.join(__dirname, "a.js") + ":3:9)\n    at new Foo [as bar] (" + path.join(__dirname, "b.js") + ":4:1)";
    const line = E.mainRecord(async, __dirname, 1);
    ok("8 V8 的 async／new／[as] 名字收成函式名的形狀", line && JSON.stringify(JSON.parse(line).frames) === JSON.stringify([{ file: "shell/a.js", func: "Object.<anonymous>", line: 3 }, { file: "shell/b.js", func: "Foo", line: 4 }]), line);
  }
  // ── 4b. 契約:照 fixture 的 records + meta + token 組出來的 body = fixture 的 bodies(api 那邊驗 clean() 全收) ──
  {
    const k = fx.contract, dir = fs.mkdtempSync(path.join(os.tmpdir(), "errc-")), posts = [];
    fs.mkdirSync(path.join(dir, "state"));
    const file = path.join(dir, "state", "error_reports.jsonl");
    const er = E.createErrReport({ file, stateFile: path.join(dir, "s.json"), endpoint: "x", now: () => 0, known: () => [],
      isOfficial: () => true, isBundled: () => true, meta: () => k.meta, token: () => k.token,
      post: (u, b) => { posts.push(JSON.stringify(b)); return Promise.resolve(); }, live: () => true });
    fs.writeFileSync(file, k.records.map((r) => JSON.stringify(r) + "\n").join(""));
    const c = er.pending(); await er.decide(c.id, "send", false);
    fs.writeFileSync(file, JSON.stringify(k.records[0]) + "\n"); er.setMode("auto"); er.pending(); await flush();
    ok("4b 組出來的 body 跟 fixture 逐字相同(api 用同一份驗收)", JSON.stringify(posts) === JSON.stringify(k.bodies.map((b) => JSON.stringify(b))), posts);
  }
  // ── 9 ──
  {
    const h = setup();
    fs.writeFileSync(path.join(h.dir, "error_report.json"), "{not json");
    ok("9 狀態檔壞掉 = 每次問我", h.er.mode() === "ask");
    ok("9 不認得的模式不改", h.er.setMode("always") === "ask" && h.er.setMode("auto") === "auto");
  }
  // ── 10 ──
  {
    const main = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8");
    ok("10 uncaughtExceptionMonitor 也寫錯誤記錄", /uncaughtExceptionMonitor[^\n]*errReport\(\)\.appendMain/.test(main));
    ok("10 四支 IPC 都走 fromOurPage 的 handle()", ["err-report-pending", "err-report-decide", "err-report-mode", "err-report-mode-set"]
      .every((c) => new RegExp(`\\bhandle\\("${c}"`).test(main)));
    const rend = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "errreport.js"), "utf8");
    const calls = [...rend.matchAll(/window\.blave\.(\w+)/g)].map((m) => m[1]);
    ok("10 詢問卡只用錯誤回報自己的 IPC 與回合結束的通知(不存進對話、不經手機同步)", calls.length && calls.every((c) => /^errReport/.test(c) || c === "onTurnEnd"), calls);
    // 手機同步上傳的是主行程對話存檔裡 user／assistant 的列(relay.js 的 sessions.rowsAfter);詢問卡只在畫面上,
    // 主行程那半也不碰對話存檔,所以沒有路徑進到同步內容
    const relay = fs.readFileSync(path.join(__dirname, "..", "shell", "relay.js"), "utf8");
    ok("10 手機同步只從對話存檔拿 user／assistant 的列", /opts\.sessions\.rowsAfter\(s\.id, after, SYNC_PER_SESSION, true\) \|\| \[\]\)\.filter\(\(x\) => x\.role === "user" \|\| x\.role === "assistant"\)/.test(relay));
    const erSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "errreport.js"), "utf8");
    ok("10 錯誤回報主行程那半不碰對話存檔", !/session|chat-meta|appendRow|saveRow/i.test(erSrc));
    const builder = fs.readFileSync(path.join(__dirname, "..", "shell", "electron-builder.config.js"), "utf8");
    ok("10 打包清單有 errreport.js(renderer/** 已含畫面那支與 css)", /files: \[[^\]]*"errreport\.js"/.test(builder));
    ok("10 shell/ 的 frame 對 app 本身(__dirname)驗、runtime/ 對 REPO 驗", /isBundled: \(rel\) => fs\.statSync\(rel\.startsWith\("shell\/"\) \? path\.join\(__dirname, rel\.slice\(6\)\) : path\.join\(REPO, rel\)\)/.test(main));
    ok("10 畫面用 textContent 放內容、不用 innerHTML", !/innerHTML/.test(rend));
  }
  console.log(red ? `\n${red} FAILED` : "\nall ok");
  process.exit(red ? 1 : 0);
})();
