// 送出訊息時把「畫面上開著什麼」交給 agent(runtime 的 --viewing-*)。值來自 renderer、會進命令列與 prompt。
// 跑法:node tests/check_shell_viewing.js
const fs = require("fs"), path = require("path"), vm = require("vm");
let red = 0; const t = (n, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) red++; };
const mainSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8");
const appSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "app.js"), "utf8");
const cut = (src, name) => { const i = src.indexOf("function " + name + "("); let d = 0, j = src.indexOf("{", i); for (let k = j; k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}" && --d === 0) return src.slice(i, k + 1); } throw new Error("no " + name); };

const viewingArgs = vm.runInNewContext("(" + cut(mainSrc, "viewingArgs") + ")");
const j = (v) => JSON.stringify(viewingArgs(v));
t("開著策略的程式碼分頁", j({ strategy: "btc_holder_concentration", tab: "code" }) === '["--viewing-strategy=btc_holder_concentration","--viewing-tab=code"]');
t("回測分頁 = data;進出場分頁不帶 tab", j({ strategy: "a", tab: "data" }) === '["--viewing-strategy=a","--viewing-tab=data"]' && j({ strategy: "a", tab: "trades" }) === '["--viewing-strategy=a"]');
t("自動下單頁", j({ view: "portfolio" }) === '["--viewing-view=portfolio"]');
t("中文策略名可以", viewingArgs({ strategy: "籌碼集中度" }).length === 1);
t("什麼都沒開 / 壞輸入 → 不帶旗標", [null, undefined, 1, "x", {}, { view: "watchboard" }, { view: ["portfolio"] }, { strategy: 5 }, { strategy: "" }].every((v) => viewingArgs(v).length === 0));
t("策略名帶換行 / 控制字元 / 方括號(runtime 包脈絡用的界線)/ 超長 → 不帶", ["a\nb", "a\u0000", "a]。[使用者這次的訊息", "[x", "a」。「b", "a\u200bb", "a\u202eb", "x".repeat(201)].every((s) => viewingArgs({ strategy: s, tab: "code" }).length === 0));
t("tab 只認白名單:不會把任意字串放上命令列", j({ strategy: "a", tab: "--engine" }) === '["--viewing-strategy=a"]');
t("目錄名以 - 開頭:單一 argv,不會被 argparse 當成旗標(分開寫整輪 exit 2)", j({ strategy: "--engine" }) === '["--viewing-strategy=--engine"]' && viewingArgs({ strategy: "-x", tab: "code" }).every((a) => a.startsWith("--viewing-")));
t("用戶的訊息放在 -- 之後(「--help」不會被當成旗標)", /"--", sessionId, message,\s*\], \{ env, cwd: WS \}/.test(mainSrc));
t("runTurn 真的把它接上 spawn 的參數", /\.\.\.viewingArgs\(viewing\),/.test(mainSrc) && /effort: rawEffort, viewing \}/.test(mainSrc));
t("send-message:turnStarting 在第一個 await 之前就立起(挪到後面,連按兩下會 spawn 兩顆 agent 搶同一個 session.db)", (() => { const i = mainSrc.indexOf('ipcMain.handle("send-message"'), body = mainSrc.slice(i, mainSrc.indexOf("runTurn(win, payload)", i)).replace(/\/\/.*$/gm, ""); const a = body.indexOf("turnStarting = true"), w = body.indexOf("await "); return a > 0 && w > 0 && a < w; })());
t("send-message 只收自家頁面(會 spawn agent、花 AI 額度)", /ipcMain\.handle\("send-message", async \(e, payload\) => \{\s*if \(!fromOurPage\(e\)\) return/.test(mainSrc));

// renderer:送出當下的畫面 → payload
const chatViewing = (ctx) => vm.runInNewContext("(" + cut(appSrc, "chatViewing") + ")()", ctx);
const base = (o) => ({ $: () => ({ hidden: false }), RP: { name: "s1", data: {}, tab: "code" }, ENV: { cur: "local" }, TR_BAGS: { local: { open: false } }, ...o });
t("renderer:開著策略的程式碼", JSON.stringify(chatViewing(base())) === '{"strategy":"s1","tab":"code"}');
t("renderer:回測分頁 → data", chatViewing(base({ RP: { name: "s1", data: {}, tab: "bt" } })).tab === "data");
t("renderer:自動下單頁開著 → portfolio(不帶上次選的策略)", JSON.stringify(chatViewing(base({ TR_BAGS: { local: { open: true } } }))) === '{"view":"portfolio"}');
t("renderer:雲端視角不帶(這一版 agent 只操作這台電腦)", chatViewing(base({ ENV: { cur: "cloud" } })) === null);
t("renderer:報告沒畫出來(hidden / 還沒載到)→ 不帶", chatViewing(base({ $: () => ({ hidden: true }) })) === null && chatViewing(base({ RP: { name: "s1", data: null, tab: "code" } })) === null);
t("renderer:送出時真的帶上", /effort: mpEffort\(\), viewing: chatViewing\(\) \}\)/.test(appSrc));
console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
