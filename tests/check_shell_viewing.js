// 送出訊息時把「畫面上開著什麼」交給 agent(runtime 的 --viewing-*)。值來自 renderer、會進命令列與 prompt。
// A′(操作對象隨視角走):每一則都帶 `env`;雲端視角 → `--viewing-env=cloud`,而且指的策略是雲端那一份(RPC)。
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
t("策略名帶換行 / 控制字元 / 方括號(runtime 包脈絡用的界線)/ 超長 → 不帶", ["a\nb", "a\u0000", "a]。[使用者這次的訊息", "[x", "a」。「b", "a​b", "a‮b", "x".repeat(201)].every((s) => viewingArgs({ strategy: s, tab: "code" }).length === 0));
t("tab 只認白名單:不會把任意字串放上命令列", j({ strategy: "a", tab: "--engine" }) === '["--viewing-strategy=a"]');
t("目錄名以 - 開頭:單一 argv,不會被 argparse 當成旗標(分開寫整輪 exit 2)", j({ strategy: "--engine" }) === '["--viewing-strategy=--engine"]' && viewingArgs({ strategy: "-x", tab: "code" }).every((a) => a.startsWith("--viewing-")));
// A′:哪一邊。只送 cloud(這台電腦是預設、不送,舊 runtime 的行為逐位元組不變);怪值當沒送;單一 --flag=value、永遠排最後
t("雲端視角 → --viewing-env=cloud(單獨一個也送:雲端沒開任何東西時 agent 仍要知道做在哪)", j({ env: "cloud" }) === '["--viewing-env=cloud"]');
t("雲端視角 + 策略 / 自動下單頁:env 排最後,前面照舊", j({ strategy: "a", tab: "code", env: "cloud" }) === '["--viewing-strategy=a","--viewing-tab=code","--viewing-env=cloud"]'
  && j({ view: "portfolio", env: "cloud" }) === '["--viewing-view=portfolio","--viewing-env=cloud"]');
t("這台電腦 / 怪值 / 沒給 → 不送 env(白名單只有 cloud)", [{ env: "local" }, { env: "CLOUD" }, { env: "cloud " }, { env: ["cloud"] }, { env: 1 }, { env: null }].every((v) => viewingArgs(v).length === 0)
  && j({ strategy: "a", env: "local" }) === '["--viewing-strategy=a"]' && j({ view: "portfolio", env: "x" }) === '["--viewing-view=portfolio"]');
t("用戶的訊息不進 argv(同機 `ps` 看得到;聊天貼 key 是支援的流程):走 stdin", (() => { const i = mainSrc.indexOf('path.join(REPO, "runtime", "agent_turn.py")'), args = mainSrc.slice(i, mainSrc.indexOf("], { env: childEnv(env), cwd: WS, windowsHide: true })", i)).replace(/\/\/.*$/gm, ""); return i > 0 && !/\bmessage\b/.test(args.replace(/"[^"]*"/g, "")) && /"--message-stdin", "--", sessionId,\s*$/.test(args) && /child\.stdin\.end\(message\)/.test(mainSrc); })());
t("訊息不是字串 / 超過上限 → spawn 之前就拒絕;stdin.end 拋了會把子行程收掉(不留一支卡在讀 stdin 的)", /if \(typeof message !== "string" \|\| Buffer\.byteLength\(message, "utf8"\) > MESSAGE_MAX_BYTES\) throw new Error\("bad message"\);/.test(mainSrc)
  && mainSrc.indexOf('throw new Error("bad message")') < mainSrc.indexOf('path.join(REPO, "runtime", "agent_turn.py")') && /try \{ child\.stdin\.end\(message\); \} catch \(err\) \{ try \{ child\.kill\(\); \}/.test(mainSrc));
t("runtime 的 --message-stdin 有大小上限(兩邊同一個數)", (() => { const rt = fs.readFileSync(path.join(__dirname, "..", "runtime", "agent_turn.py"), "utf8"); return /MESSAGE_STDIN_MAX = 1024 \* 1024/.test(rt) && /sys\.stdin\.buffer\.read\(MESSAGE_STDIN_MAX \+ 1\)/.test(rt) && /const MESSAGE_MAX_BYTES = 1024 \* 1024;/.test(mainSrc); })());
t("runtime 認得 --message-stdin,而且訊息的位置參數變選填(機隊照舊走位置參數)", (() => { const rt = fs.readFileSync(path.join(__dirname, "..", "runtime", "agent_turn.py"), "utf8"); return /add_argument\("message", nargs="\?"/.test(rt) && /add_argument\("--message-stdin", action="store_true"\)/.test(rt) && /sys\.stdin\.buffer\.read\(/.test(rt); })());
/* 兩半的閘門:外殼已經送 --viewing-env=cloud,而 agent_turn.py 是 parse_args()(不是 parse_known_args)——runtime 那半沒接上之前,
   雲端視角的每一輪都會被 argparse 當未知旗標、exit 2。這一條紅 = 外殼不可以先出貨。契約:值只有 cloud;同一輪的
   --viewing-strategy 指的是雲端那一份同名策略;runtime 把「做在雲端主機」寫進 prompt,並在 tool chunk 帶 where("cloud"|"local")給動作列的 .wtag。 */
t("runtime 認得 --viewing-env(runtime 那半;沒接上前外殼不可以出貨)", (() => { const rt = fs.readFileSync(path.join(__dirname, "..", "runtime", "agent_turn.py"), "utf8"); return /add_argument\("--viewing-env"/.test(rt); })());
t("runTurn 真的把它接上 spawn 的參數", /\.\.\.viewingArgs\(viewing\),/.test(mainSrc) && /effort: rawEffort, viewing \}/.test(mainSrc));
t("send-message:turnStarting 在第一個 await 之前就立起(挪到後面,連按兩下會 spawn 兩顆 agent 搶同一個 session.db)", (() => { const i = mainSrc.indexOf('ipcMain.handle("send-message"'), body = mainSrc.slice(i, mainSrc.indexOf("runTurn(win, payload)", i)).replace(/\/\/.*$/gm, ""); const a = body.indexOf("turnStarting = true"), w = body.indexOf("await "); return a > 0 && w > 0 && a < w; })());
t("send-message 只收自家頁面(會 spawn agent、花 AI 額度)", /ipcMain\.handle\("send-message", async \(e, payload\) => \{\s*if \(!fromOurPage\(e\)\) return/.test(mainSrc));

// renderer:送出當下的畫面 → payload(兩袋:RP = 這台電腦選中的、RPC = 雲端選中的;#tr / #rp 誰開著由 envShowMain 決定)
const chatViewing = (ctx) => vm.runInNewContext("(" + cut(appSrc, "chatViewing") + ")()", ctx);
const base = (o) => ({ $: () => ({ hidden: false }), RP: { name: "s1", data: {}, tab: "code" }, RPC: { name: "c1", data: {}, tab: "bt" }, ENV: { cur: "local" }, TR_BAGS: { local: { open: false }, cloud: { open: true } }, ...o });
const hid = (ids) => (id) => ({ hidden: ids.indexOf(id) >= 0 });
t("renderer:開著策略的程式碼(這台電腦)", JSON.stringify(chatViewing(base())) === '{"env":"local","strategy":"s1","tab":"code"}');
t("renderer:回測分頁 → data", chatViewing(base({ RP: { name: "s1", data: {}, tab: "bt" } })).tab === "data");
t("renderer:自動下單頁開著 → portfolio(不帶上次選的策略)", JSON.stringify(chatViewing(base({ TR_BAGS: { local: { open: true }, cloud: { open: true } } }))) === '{"env":"local","view":"portfolio"}');
t("renderer:雲端視角帶 env=cloud,而且指的是雲端那一份(RPC),不是這台電腦同名的那支", JSON.stringify(chatViewing(base({ ENV: { cur: "cloud" }, $: hid(["tr"]) }))) === '{"env":"cloud","strategy":"c1","tab":"data"}');
t("renderer:雲端視角的自動下單頁 → portfolio + env=cloud;雲端沒有主機可看(#tr 與 #rp 都藏著)→ 只有 env", JSON.stringify(chatViewing(base({ ENV: { cur: "cloud" }, $: hid(["rp"]) }))) === '{"env":"cloud","view":"portfolio"}'
  && JSON.stringify(chatViewing(base({ ENV: { cur: "cloud" }, $: hid(["rp", "tr"]) }))) === '{"env":"cloud"}');
t("renderer:報告沒畫出來(hidden / 還沒載到)→ 只有 env", JSON.stringify(chatViewing(base({ $: hid(["rp"]) }))) === '{"env":"local"}' && JSON.stringify(chatViewing(base({ RP: { name: "s1", data: null, tab: "code" } }))) === '{"env":"local"}');
t("renderer:送出時真的帶上,而且 viewing 在畫「你的那則」之前取一次(送出當下定案);你的那則下面不再掛 .wtag", /const viewing = opts && opts\.viewing && typeof opts\.viewing === "object" \? opts\.viewing : chatViewing\(\);\s*addMsg\("you", msg\);/.test(appSrc) && /effort: mpEffort\(\), viewing \}\)/.test(appSrc) && !/whereTag\(viewing/.test(appSrc));
console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
