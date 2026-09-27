// 策略轉出(spec-desktop-strategy-export-0.1.8)的最小檢查。跑法:node tests/check_shell_export.js
// ① renderer/export.js 的純邏輯(從原文切出來跑):加密 → XQ 擋、送給 agent 的句子只放合規資料夾名、chunk 形狀、週期換算、檔案切換清單;
// ② main.js 的 stratExports(切出來跑,真的寫檔):三個固定檔名、>256KB / symlink 不收、sidecar hash 判過期優先於 mtime;
// ③ 接線:export chunk 不再被 onTurnEvent 吞掉(0.1.7 的 bug:agent 說「轉好了」,畫面拿不到檔),而且卡在 paintAi 定稿之後才掛。
const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto");
const SHELL = path.join(__dirname, "..", "shell");
const xp = fs.readFileSync(path.join(SHELL, "renderer", "export.js"), "utf8");
const main = fs.readFileSync(path.join(SHELL, "main.js"), "utf8");
const app = fs.readFileSync(path.join(SHELL, "renderer", "app.js"), "utf8");
let red = 0;
const ok = (name, c) => { console.log((c ? "PASS  " : "FAIL  ") + name); if (!c) red++; };
const cut = (src, a, b, what) => { const i = src.indexOf(a), j = src.indexOf(b, i); if (i < 0 || j < 0) { ok("切得出 " + what, false); return ""; } return src.slice(i, j); };

// ── ① 純邏輯 ──
const pure = cut(xp, "const XP_ORDER", "/* ── 純邏輯到此 ── */", "export.js 純邏輯");
const X = new Function(pure.replace(/^const XP = .*$/m, "") + "\nreturn { XP_ORDER, xpIsCrypto, xpAvail, xpMsg, xpChunkOk, xpSize, xpIvl, xpFiles };")();
ok("SYMBOL 以 USDT 結尾 = 加密 → XQ 不能選,另外兩個照常", !X.xpAvail("xq", { symbol: "BTCUSDT" }) && X.xpAvail("mc", { symbol: "BTCUSDT" }) && X.xpAvail("pine", { symbol: "BTCUSDT" }));
ok("BTC-USDC、fetch_kline 也算加密", X.xpIsCrypto({ symbol: "BTC-USDC" }) && X.xpIsCrypto({ symbol: "X", cryptoKline: true }));
ok("台股 2330 / 台指 TXF / 讀不到 SYMBOL → XQ 照常給選", X.xpAvail("xq", { symbol: "2330" }) && X.xpAvail("xq", { symbol: "TXF" }) && X.xpAvail("xq", {}) && X.xpAvail("xq", null));
const tpl = { xq: "把策略 {id} 轉成 XQ XS 版。", mc: "mc {id}", pine: "pine {id}" };
ok("固定句只代入資料夾名", X.xpMsg("xq", "btc_sma-1", tpl) === "把策略 btc_sma-1 轉成 XQ XS 版。");
ok("資料夾名不合規(空白、引號、換行、>64)→ 不送", [" x", "a\"b", "a\nb", "x".repeat(65), ""].every((id) => X.xpMsg("pine", id, tpl) === null));
ok("未知 target / 範本沒有恰好一個 {id} → 不送", X.xpMsg("ninja", "a", tpl) === null && X.xpMsg("xq", "a", { xq: "{id}{id}" }) === null && X.xpMsg("xq", "a", { xq: "no id" }) === null);
const chunk = { type: "export", target: "pine", strategy: "btc_sma", filename: "btc_sma_pine.pine", content: "//@version=6\n" };
ok("runtime 的 chunk 形狀收", X.xpChunkOk(chunk));
ok("壞 chunk 不收(target、strategy、空內容)", !X.xpChunkOk({ ...chunk, target: "ea" }) && !X.xpChunkOk({ ...chunk, strategy: "../x" }) && !X.xpChunkOk({ ...chunk, content: "" }) && !X.xpChunkOk(null));
ok("大小顯示同 web xpSize", X.xpSize(900) === "900 B" && X.xpSize(1434) === "1.4 KB");
const iv = (a, k) => JSON.stringify(X.xpIvl(a, k));
ok("週期:Pine 1h = 1 小時;XQ / MC 1h = 60 分鐘、4h = 240 分鐘", iv("1h", "pine") === '["xp.ivl.h",{"n":1}]' && iv("1h", "mc") === '["xp.ivl.m",{"n":60}]' && iv("4h", "xq") === '["xp.ivl.m",{"n":240}]');
ok("週期:15m、1d、1w;認不得(2d、空、1M)→ null", iv("15m", "pine") === '["xp.ivl.m",{"n":15}]' && iv("1d", "xq") === '["xp.ivl.d",{}]' && iv("1w", "mc") === '["xp.ivl.w",{}]' && X.xpIvl("2d", "xq") === null && X.xpIvl("", "xq") === null && X.xpIvl("1M", "xq") === null);
const d = { exports: [{ target: "pine", content: "a" }, { target: "xq", content: "b" }] };
ok("檔案切換:有檔的平台、順序同選單(XQ → MC → TV)", JSON.stringify(X.xpFiles(d, true, null)) === '["xq","pine"]');
ok("雲端視角 / 時光機 / 沒有轉出檔 → 空(= 程式碼分頁跟以前一樣)", X.xpFiles(d, false, null).length === 0 && X.xpFiles(d, true, "v5").length === 0 && X.xpFiles({ exports: [] }, true, null).length === 0 && X.xpFiles({}, true, null).length === 0);

// ── ② main.js stratExports ──
const mainCut = cut(main, "const EXPORT_FILES", "/* 「下載…」", "main.js stratExports");
const M = new Function("fs", "path", "require", mainCut + "\nreturn { stratExports, stratUsesKline, EXPORT_FILES };")(fs, path, require);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-xp-")), ex = path.join(dir, "exports");
fs.mkdirSync(ex);
const code = 'SYMBOL = "BTCUSDT"\n';
fs.writeFileSync(path.join(dir, "strategy.py"), code);
fs.writeFileSync(path.join(ex, "pine.pine"), "//@version=6\n");
fs.writeFileSync(path.join(ex, "mc.txt"), "x".repeat(256 * 1024 + 1));
fs.writeFileSync(path.join(dir, "secret.txt"), "nope");
fs.symlinkSync(path.join(dir, "secret.txt"), path.join(ex, "xq.xs"));
const past = new Date(Date.now() - 3600e3);
fs.utimesSync(path.join(ex, "pine.pine"), past, past);   // 轉出檔比 strategy.py 舊
let out = M.stratExports(dir, code);
ok("只收 regular file ≤256KB(symlink、過大都不收)", out.length === 1 && out[0].target === "pine" && out[0].content === "//@version=6\n");
ok("沒有 sidecar:strategy.py 比轉出檔新 → 過期", out[0].stale === true);
const sha = crypto.createHash("sha256").update(code).digest("hex");
fs.writeFileSync(path.join(ex, "pine.pine.meta.json"), JSON.stringify({ target: "pine", source_sha256: sha, exported_at: "2026-09-27T06:32:00Z" }));
out = M.stratExports(dir, code);
ok("有 sidecar 且 hash 相同 → 不過期(mtime 被誤觸不算),轉出時間取 sidecar", out[0].stale === false && out[0].exportedAt === Date.parse("2026-09-27T06:32:00Z"));
out = M.stratExports(dir, code + "# edited\n");
ok("sidecar hash 跟現在的 strategy.py 不同 → 過期", out[0].stale === true);
ok("fetch_kline 在資料夾任一支 .py → cryptoKline", !M.stratUsesKline(dir) && (fs.writeFileSync(path.join(dir, "helper.py"), "from lib.data import fetch_kline\n"), M.stratUsesKline(dir)));

// ── ②b 轉出卡的存檔(重開 app 畫回來;主行程其他地方讀得到路徑)──
const storeCut = cut(main, "const XP_DIR = ", "/* ── 報告(renderer/reports.js", "main.js 轉出卡存檔");
const base = fs.mkdtempSync(path.join(os.tmpdir(), "check-xp-base-"));
const S = new Function("fs", "path", "BASE", "STRAT_DIR", "okSessionId", "EXPORT_FILES", "EXPORT_MAX",
  storeCut + "\nreturn { noteExport, flushExports, loadSessionExports, exportById, exportRef, readSnap };")(
  fs, path, base, () => path.join(base, "ws", "strategies"), (id) => typeof id === "string" && /^desktop-[a-z0-9]{4,16}$/.test(id), M.EXPORT_FILES, 256 * 1024);
const sid = "desktop-abcd1234";
const rec = S.noteExport({ type: "export", target: "pine", strategy: "btc_sma", filename: "../../evil", content: "//@version=6\n" }, sid);
ok("export chunk → 快照落地、檔名由策略名重建(不信 chunk 的 filename)", !!rec && rec.filename === "btc_sma_pine.pine" && fs.readFileSync(rec.snap, "utf8") === "//@version=6\n");
ok("主行程讀得到:exportRef 給 workspace 檔的路徑 + 平台 + 策略名", S.exportRef("btc_sma", "pine") === rec && rec.src === path.join(base, "ws", "strategies", "btc_sma", "exports", "pine.pine") && rec.target === "pine");
ok("壞 chunk / 壞 session 不落地", S.noteExport({ target: "pine", strategy: "../x", content: "a" }, sid) === null && S.noteExport({ target: "pine", strategy: "a", content: "a" }, "../x") === null);
const before = Date.now() / 1000;
S.flushExports(sid, [rec]);
const hist = S.loadSessionExports(sid);
ok("回合結束才寫 index,ts ≥ 結束時間(排在那一輪回覆之後);交給畫面的沒有路徑", hist.length === 1 && hist[0].ts >= before && hist[0].id === rec.id && !("snap" in hist[0]) && !("src" in hist[0]));
ok("卡的「下載…」用 id 找回那一輪的快照;亂給的 id / 別的 session 找不到", S.exportById(sid, rec.id).snap === rec.snap && S.exportById(sid, "../../x") === null && S.exportById("desktop-zzzz9999", rec.id) === null);

// ── ③ 接線 ──
ok("onTurnEvent 有 export 分支,交給 xpChunk", /else if \(c\.type === "export"\) \{\s*\n\s*if \(typeof xpChunk === "function"\) xpChunk\(c\);/.test(app));
const end = app.indexOf("window.blave.onTurnEnd("), paintAt = app.indexOf("paintAi(liveBubble, liveBubble._raw, false)", end), cardAt = app.indexOf("xpTurnEnd(liveBubble)", end);
ok("回合結束:paintAi 定稿之後才掛轉出卡(順序反了卡會被清掉)", end > 0 && paintAt > end && cardAt > paintAt);
ok("rpPaintHead 叫 xpPaint(觸發器與程式碼分頁跟著換策略 / 視角)", /function rpPaintHead\(B\) \{[\s\S]*?xpPaint\(\);[\s\S]*?\n\}/.test(app));
ok("save-export / reveal-export 走 handle()(過 fromOurPage),reveal 只認 token", /handle\("save-export", /.test(main) && /handle\("reveal-export", \(_e, token\) => \{ const p = savedExports\.get\(/.test(main));
ok("主行程收到 export chunk 就落地、回合結束寫 index", /c\.type === "export"\) \{ const rec = noteExport\(c, sessionId\)/.test(main) && /flushExports\(sessionId, turnXp\)/.test(main));
{ // 同一則回覆裡結果卡永遠最後:有 .res-group 就插在它前面
  const put = new Function((/^function xpPut\(host, card\) \{.*\}$/m.exec(xp) || [""])[0] + "\nreturn xpPut;")();
  const mk = (g) => { const kids = g ? ["text", g] : ["text"]; return { kids, querySelector: () => g, appendChild: (c) => kids.push(c) }; };
  const g = { before: (c) => h1.kids.splice(h1.kids.indexOf(g), 0, c) }, h1 = mk(g), h2 = mk(null);
  put(h1, "xp"); put(h2, "xp");
  ok("轉出卡在結果卡之前(xpPut);沒有結果卡就接在最後;export.js 不再直接 appendChild(xpCard", JSON.stringify(h1.kids.map((x) => (x === g ? "res" : x))) === '["text","xp","res"]' && h2.kids.join() === "text,xp" && !/appendChild\(xpCard/.test(xp));
}
{ // e2e 0.1.8 #49:這一輪沒有 export chunk(模型漏寫標記),檔案照樣在資料夾裡 → 回合結束仍重掃,程式碼分頁當下就多一份
  const src = cut(xp, "function xpTurnEnd(bubble)", "function xpCard(", "xpTurnEnd / xpReload");
  const run = async (pending, rpName) => {
    const RP = { name: rpName, data: rpName ? { exports: [] } : null }, seen = { load: [], paint: 0, cards: 0 };
    const env = { XP: { pending }, RP, rpBag: () => RP, xpCodePaint: () => { seen.paint++; }, scrollChat: () => {},
      xpHost: () => ({}), xpPut: () => { seen.cards++; }, xpCard: (c) => c,
      window: { blave: { loadStrategy: async (n) => { seen.load.push(n); return { exports: [{ target: "pine", content: "x" }], cryptoKline: false }; } } } };
    const f = new Function(...Object.keys(env), src + "\nreturn xpTurnEnd;")(...Object.values(env));
    f(null); await new Promise((r) => setTimeout(r, 0));
    return { seen, RP, left: env.XP.pending.length };
  };
  (async () => {
    const a = await run([], "tsmc_ma_cross");
    ok("沒有卡的一輪:正開著的那支仍重掃 exports 並重畫檔案切換", a.seen.load.join() === "tsmc_ma_cross" && a.seen.paint === 1 && a.seen.cards === 0 && a.RP.data.exports[0].target === "pine");
    const b = await run([{ target: "xq", strategy: "other" }], "tsmc_ma_cross");
    ok("卡是別支策略的:卡照掛、開著的那支也重掃", b.seen.cards === 1 && b.seen.load.join() === "tsmc_ma_cross" && b.left === 0);
    const c = await run([], null);
    ok("沒有開著的策略:不讀檔", c.seen.load.length === 0 && c.seen.paint === 0);
    console.log(red ? "\n" + red + " 紅" : "\nALL PASS");
    process.exit(red ? 1 : 0);
  })();
}
ok("csOpen 把轉出卡插回舊對話", /concat\([^\n]*brs, xps, ress\)/.test(app) && /x\.xp \? xpRestore\(x\.xp\)/.test(app));

