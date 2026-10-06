// 聊天附件(0.1.17):跟雲端同一條契約。
//   1. shell/attach.js(主行程):消毒 / 上限同 api openclaw/webchat.py,落地與給引擎的兩行逐字同 runtime/web_bridge.py
//   2. renderer/app.js:chip 流程(選 / 拖 / 貼 → chip → 隨下一句送出 → 送出去了才清)、太大擋在畫面、純附件可送、重送不重送檔
//   3. 畫面拿不到路徑:只交位元組,主行程不接路徑;埋點三個名字在白名單、≤16 字、不記檔名
// 跑法:node tests/check_shell_attach.js
const fs = require("fs"), os = require("os"), path = require("path"), vm = require("vm");
const ROOT = path.join(__dirname, ".."), SHELL = path.join(ROOT, "shell"), R = path.join(SHELL, "renderer");
const at = require(path.join(SHELL, "attach.js"));
const { EVENTS } = require(path.join(SHELL, "telemetry.js"));
const appSrc = fs.readFileSync(path.join(R, "app.js"), "utf8"), mainSrc = fs.readFileSync(path.join(SHELL, "main.js"), "utf8");
const html = fs.readFileSync(path.join(R, "index.html"), "utf8"), preSrc = fs.readFileSync(path.join(SHELL, "preload.js"), "utf8");
const bridge = fs.readFileSync(path.join(ROOT, "runtime", "web_bridge.py"), "utf8");
let red = 0; const t = (n, ok, d) => { console.log((ok ? "PASS  " : "FAIL  ") + n + (ok || d === undefined ? "" : "  " + JSON.stringify(d))); if (!ok) red++; };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "blave-attach-"));
const b64 = (s) => Buffer.from(s).toString("base64");

try {
  // ── 1. 主行程:契約同雲端 ──
  const okNote = /note = f"(\[[^"]*\{saved\}[^"]*\])"/.exec(bridge), failNote = /note = "(\[[^"]*\])"\n/.exec(bridge.split("接收失敗也照常跑")[1] || "");
  t("給引擎的兩行逐字同 runtime/web_bridge.py(f-string 的 {saved} 對到 {name})", !!okNote && !!failNote && okNote[1].replace("{saved}", "{name}") === at.NOTE_OK && failNote[1] === at.NOTE_FAIL, { okNote: okNote && okNote[1], failNote: failNote && failNote[1] });
  t("落地位置同 runtime INBOUND_DIR(workspace/tmp/inbound)", /INBOUND_DIR = f"\{WORKSPACE\}\/tmp\/inbound"/.test(bridge) && at.save(TMP, { name: "where.txt", mime: "text/plain", data: b64("x") }) === "where.txt" && fs.existsSync(path.join(TMP, "tmp", "inbound", "where.txt")));
  t("上限同雲端:原檔 5 MiB(web ATTACH_MAX_BYTES)、base64 7,000,000 字 / 檔名 128 / mime 64(api webchat.py)", at.ATTACH_MAX_BYTES === 5 * 1024 * 1024 && at.ATTACH_DATA_MAX === 7000000 && at.ATTACH_NAME_MAX === 128 && at.ATTACH_MIME_MAX === 64);
  const apiPy = path.join(process.env.BLAVE_API_DIR || path.join(ROOT, "..", "api"), "openclaw", "webchat.py");
  if (fs.existsSync(apiPy)) { const a = fs.readFileSync(apiPy, "utf8"); t("…api 端那三個常數沒漂", /ATTACH_NAME_MAX = 128\b/.test(a) && /ATTACH_DATA_MAX = 7_000_000\b/.test(a) && /ATTACH_MIME_MAX = 64\b/.test(a)); }
  else console.log("SKIP  api 常數比對(需要 BLAVE_API_DIR 或 monorepo 版面)");
  t("檔名消毒同 api:basename、去控制字元、空 / . / .. / 超長不收", at.sanitizeName("/etc/../x/報告 Q3.csv") === "報告 Q3.csv" && at.sanitizeName("C:\\Users\\me\\a.txt") === "a.txt" && at.sanitizeName("a\u0000b\nc.txt") === "abc.txt"
    && [null, 1, "", "..", ".", "/", "x".repeat(129), "dir/"].every((v) => at.sanitizeName(v) === null) && at.sanitizeName("x".repeat(128)) === "x".repeat(128));
  t("驗形狀:不是物件 / 沒檔名 / data 不是字串 / 不是 base64 / 空檔 / 超過 5 MiB / mime 太長 → null", [null, "x", [], { name: "a" }, { name: "a", data: 1 }, { name: "a", data: "@@@@" }, { name: "a", data: "abc" }, { name: "a", data: "" },
    { name: "a", data: b64("x"), mime: "m".repeat(65) }, { name: "a", data: b64("x"), mime: 5 }, { name: "a", data: "A".repeat(7000004) }].every((v) => at.validate(v) === null)
    && !!at.validate({ name: "a", data: b64("x") }) && at.validate({ name: "a", data: b64("x") }).mime === null && !!at.validate({ name: "a", data: b64("x"), mime: "text/plain" }));
  { const big = Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64"), max = Buffer.alloc(5 * 1024 * 1024).toString("base64");
    t("剛好 5 MiB 收、多 1 byte 不收(base64 字數都在 7,000,000 內)", max.length <= 7000000 && !!at.validate({ name: "a.bin", data: max }) && at.validate({ name: "a.bin", data: big }) === null); }
  t("驗過的物件只剩 name / mime / bytes:多塞的欄位不跟過去", JSON.stringify(Object.keys(at.validate({ name: "a", data: b64("x"), mime: "t/p", path: "/etc/passwd", extra: 1 }))) === '["name","mime","bytes"]');
  const n1 = at.save(TMP, { name: "../../evil.csv", mime: "text/csv", data: b64("a,b") });
  t("落地:路徑段被剝掉只留 basename、0600、內容原樣", n1 === "evil.csv" && fs.readFileSync(path.join(TMP, "tmp", "inbound", "evil.csv"), "utf8") === "a,b" && (fs.statSync(path.join(TMP, "tmp", "inbound", "evil.csv")).mode & 0o777) === 0o600 && !fs.existsSync(path.join(TMP, "evil.csv")));
  const n2 = at.save(TMP, { name: "evil.csv", data: b64("c") });
  t("撞名加 `<秒>_` 前綴(同 web_bridge),原檔不被蓋掉", /^\d{10}_evil\.csv$/.test(n2) && fs.readFileSync(path.join(TMP, "tmp", "inbound", "evil.csv"), "utf8") === "a,b" && fs.readFileSync(path.join(TMP, "tmp", "inbound", n2), "utf8") === "c");
  t("形狀不對 / 寫不進去 → null(呼叫端補「接收失敗」那行照跑回合)", at.save(TMP, { name: "", data: b64("x") }) === null && at.save(path.join(TMP, "tmp", "inbound", "evil.csv"), { name: "a", data: b64("x") }) === null);
  t("訊息 + 那一行;純附件只有那一行;存失敗換成接收失敗那行", at.withNote("看一下", "a.csv") === "看一下\n" + at.NOTE_OK.replace("{name}", "a.csv") && at.withNote("", "a.csv") === at.NOTE_OK.replace("{name}", "a.csv") && at.withNote("看一下", null) === "看一下\n" + at.NOTE_FAIL);
  t("attach.js 不寫 log、不碰 console / telemetry", !/console\.|require\("\.\/telemetry|\.track\(/.test(fs.readFileSync(path.join(SHELL, "attach.js"), "utf8")));

  // ── main.js 接線 ──
  const rt = (mainSrc.match(/async function runTurn\(win, \{[^}]*\}\) \{[\s\S]*?\n\}/) || [""])[0];
  t("runTurn 收 attachment:驗形狀(壞的整輪不跑)→ 落地 workspace/tmp/inbound → withNote 接在訊息尾端 → 再量一次 stdin 上限",
    /async function runTurn\(win, \{ sessionId, message, [^}]*attachment \}\)/.test(rt) && /if \(!at\.validate\(attachment\)\) throw new Error\("bad attachment"\);/.test(rt)
    && /message = at\.withNote\(message, at\.save\(WS, attachment\)\);/.test(rt) && (rt.match(/Buffer\.byteLength\(message, "utf8"\) > MESSAGE_MAX_BYTES\) throw new Error\("bad message"\)/g) || []).length === 2
    && rt.indexOf("at.withNote(") < rt.indexOf("child.stdin.end(message)"));
  t("主行程不接路徑:runTurn / attach.js 沒有從 attachment 拿 path 去 copy", !/attachment\.path|copyFileSync|webUtils/.test(rt + fs.readFileSync(path.join(SHELL, "attach.js"), "utf8")) && !/webUtils|getPathForFile/.test(preSrc));
  t("preload 的 sendMessage 整包交給 send-message(attachment 隨 payload 走,沒有另一條通道)", /sendMessage: \(payload\) => ipcRenderer\.invoke\("send-message", payload\)/.test(preSrc));

  // ── 2. renderer:chip 流程 ──
  const cut = (name) => { const i = appSrc.indexOf("function " + name + "("); if (i < 0) throw new Error("找不到 " + name); let d = 0, j = appSrc.indexOf("{", i); for (let k = j; k < appSrc.length; k++) { if (appSrc[k] === "{") d++; else if (appSrc[k] === "}" && --d === 0) return appSrc.slice(i, k + 1); } throw new Error("切不到 " + name); };
  const consts = (appSrc.match(/const ATTACH_NOTE_RE = [^\n]+\nconst ATTACH_FAIL_RE = [^\n]+\n/) || [""])[0];
  const split = vm.runInNewContext(consts + "(" + cut("splitAttachNote") + ")");
  const ok1 = split(at.withNote("幫我看這份", "1759700000_data.csv")), ok2 = split(at.withNote("", "圖 1.png")), f1 = split(at.withNote("看一下", null));
  t("splitAttachNote:逐字稿尾端那一行拆掉、檔名拿回來;撞名落地的 `<10 位秒數>_` 前綴剝掉 = 送出當下看到的檔名(中文檔名 / 純附件 / 接收失敗 / 沒附件)",
    JSON.stringify(ok1) === '{"text":"幫我看這份","attachment":"data.csv"}' && JSON.stringify(ok2) === '{"text":"","attachment":"圖 1.png"}' && JSON.stringify(f1) === '{"text":"看一下","attachment":null}'
    && JSON.stringify(split("普通一句")) === '{"text":"普通一句","attachment":null}' && JSON.stringify(split(null)) === '{"text":"","attachment":null}', { ok1, ok2, f1 });
  t("…那一行只認在尾端(用戶自己在句子中間打出同樣的字不算)", split(at.NOTE_OK.replace("{name}", "a") + "\n後面還有話").attachment === null);
  { const dir = fs.mkdtempSync(path.join(TMP, "clash-")); at.save(dir, { name: "report.csv", data: b64("1") }); const second = at.save(dir, { name: "report.csv", data: b64("2") });
    t("撞名真實情境:第二份落地成 <秒>_report.csv,重開還原後泡泡與標題都顯示 report.csv", /^\d{10}_report\.csv$/.test(second) && split(at.withNote("再看一次", second)).attachment === "report.csv" && split(at.withNote("", second)).attachment === "report.csv"); }
  t("…只剝 10 位秒數 + 底線:9 位 / 11 位 / 沒底線不動", split(at.withNote("", "123456789_a.csv")).attachment === "123456789_a.csv" && split(at.withNote("", "12345678901_a.csv")).attachment === "12345678901_a.csv" && split(at.withNote("", "1759700000a.csv")).attachment === "1759700000a.csv");
  // 模型不讀圖的提示(設計稽核 3):看 mime 與模型 id,Blave AI 的 deepseek/* 與自帶金鑰的 deepseek-* 都算;貼上的圖一樣算
  const noImg = vm.runInNewContext("(" + cut("attachNoImage") + ")");
  t("attachNoImage:圖 + DeepSeek(兩種 id 形狀)→ true;非圖 / Claude / 沒檔 / 沒模型 → false", noImg({ type: "image/png" }, "deepseek/deepseek-v4-pro") && noImg({ type: "image/jpeg" }, "deepseek-v4-flash") && !noImg({ type: "text/csv" }, "deepseek/deepseek-v4-pro") && !noImg({ type: "image/png" }, "anthropic/claude-sonnet-5-5") && !noImg({ type: "image/png" }, "claude-sonnet-5-5") && !noImg(null, "deepseek/deepseek-v4-pro") && !noImg({ type: "image/png" }, null) && !noImg({ type: "image/png" }, "x-deepseek"));
  t("提示畫在 chip 檔名後(次要字,帶模型名、title 與 aria 用長句);setAttachment / mpPaint(換模型)/ 換語言都重畫;不擋送出", /<span class="attach-name" id="attach-name"><\/span>[\s\S]{0,200}<span class="attach-hint" id="attach-hint" role="note" hidden><\/span>/.test(html)
    && /h\.textContent = t\("ws\.attachNoImage", \{ model \}\); h\.title = t\("ws\.attachNoImageLong", \{ model \}\); h\.setAttribute\("aria-label", h\.title\);/.test(cut("attachHintPaint")) && /const m = mpCur\(\), model = m \? m\.name : MP\.model;/.test(cut("attachHintPaint"))
    && /\$\("attach-name"\)\.textContent = attachedFile \? attachedFile\.name : "";\n\s*attachHintPaint\(\);/.test(cut("setAttachment")) && /attachHintPaint\(\);[^\n]*\n\}/.test(cut("mpPaint")) && /youRelang\(\);[^\n]*\n\s*attachHintPaint\(\);/.test(appSrc) && !/attachNoImage\(/.test(cut("sendDraft") + (appSrc.match(/async function submitMessage\(msg, opts\) \{[\s\S]*?\n\}/) || [""])[0]));
  const map = vm.runInNewContext((appSrc.match(/const ATTACH_FEATURE = \{[^}]*\};/) || [""])[0] + "ATTACH_FEATURE"), kind = vm.runInNewContext("(" + cut("attachKind") + ")");
  const feat = (f, from) => map[kind(f, from)];
  t("埋點名:貼上 → attach_paste(不分圖或檔);選檔 / 拖放的圖 → attach_image;其他 → attach_file", feat({ type: "image/png" }, "paste") === "attach_paste" && feat({ type: "image/jpeg" }, "file") === "attach_image" && feat({ type: "text/csv" }, "file") === "attach_file" && feat({ type: "" }, "file") === "attach_file" && feat(null, undefined) === "attach_file");
  const F = EVENTS.feature_used.name;
  t("三個名字在白名單最後、≤16 字", F.slice(-3).join() === "attach_file,attach_image,attach_paste" && F.slice(-3).every((n) => n.length <= 16));
  t("選檔 / 拖放 / 貼上三個入口都走 takeAttachment:太大講一行(同雲端 addNotice)、不掛 chip", /if \(file\.size > ATTACH_MAX_BYTES\) \{ addMsg\("sys", t\("ws\.attachTooLarge"\)\)\.dataset\.i18n = "ws\.attachTooLarge"; return false; \}/.test(cut("takeAttachment"))
    && /const ATTACH_MAX_BYTES = 5 \* 1024 \* 1024;/.test(appSrc) && /\$\("attach-input"\)\.value = "";[^\n]*\n\s*takeAttachment\(f, "file"\);/.test(appSrc) && /addEventListener\("drop", [^\n]*takeAttachment\(f, "file"\)/.test(appSrc) && /addEventListener\("paste", [\s\S]{0,300}?takeAttachment\(f, "paste"\)/.test(appSrc));
  t("迴紋針 → 開檔案框;✕ → 清 chip", /\$\("attach-btn"\)\.addEventListener\("click", \(\) => \$\("attach-input"\)\.click\(\)\);/.test(appSrc) && /\$\("attach-clear"\)\.addEventListener\("click", \(\) => \{ setAttachment\(null\);/.test(appSrc));
  t("拖放只認輸入框:視窗其他地方 drop 一律 preventDefault 不開檔、不收", /document\.addEventListener\("drop", \(e\) => \{ e\.preventDefault\(\);[^\n]*if \(!ciBox\.contains\(e\.target\)\) return;/.test(appSrc));
  t("貼上:剪貼簿沒檔就讓文字照常貼(不 preventDefault)", /const f = e\.clipboardData && e\.clipboardData\.files && e\.clipboardData\.files\[0\];\n\s*if \(!f\) return;\n\s*e\.preventDefault\(\);/.test(appSrc));
  const sd = cut("sendDraft"), sub = (appSrc.match(/async function submitMessage\(msg, opts\) \{[\s\S]*?\n\}/) || [""])[0];
  t("sendDraft:純附件可送;送出去了(ok)才清 chip,沒送出去留著", /if \(\(!msg && !attachment\) \|\| running\) return;/.test(sd) && /const ok = await submitMessage\(msg, \{ typed: true, attachment, from: attachedFrom \}\);\n\s*if \(ok && attachedFile === attachment\) setAttachment\(null\);/.test(sd));
  t("submitMessage:純附件可送;泡泡末行畫檔名;送出那一刻才讀位元組(讀不到 → 講一行、收泡泡、chip 留著);payload 帶 { name, mime, data }",
    /if \(\(!msg && !attachment\) \|\| running\) return false;/.test(sub) && /addMsg\("you", msg, attachment \? attachment\.name : null\)/.test(sub)
    && /att = \{ name: attachment\.name, mime: attachment\.type \|\| "application\/octet-stream", data: await readAttachment\(attachment\) \};/.test(sub)
    && /catch \(_\) \{ addMsg\("sys", t\("ws\.attachReadFail"\)\)\.dataset\.i18n = "ws\.attachReadFail"; unsend\(\); unlock\(\); return false; \}/.test(sub) && /viewing, attachment: att \}\);/.test(sub));
  t("…回合跑起來才送 attach_* 埋點(chat_sent 之後);busy / 版本閘那幾條不送", /if \(r\.started\) \{ busyStart\(\); trackFeature\("chat_sent"\); if \(attachment\) trackFeature\(ATTACH_FEATURE\[attachKind\(attachment, opts && opts\.from\)\]\); return true; \}/.test(sub) && (sub.match(/attachKind\(/g) || []).length === 1);
  t("重送只重送句子(lastUserText = msg,不含檔);檔名不進 lastUserText", /lastUserText = msg;/.test(sub) && !/lastUserText = [^;]*attachment/.test(sub));
  t("addMsg:帶檔名時泡泡多一行「📎 檔名」(同雲端;無縮圖)", /if \(attachment\) b\.appendChild\(document\.createTextNode\(\(text \? "\\n" : ""\) \+ "📎 " \+ attachment\)\);/.test(cut("addMsg")));
  t("舊對話畫回去:使用者那句走 addHistoryYou(拆掉那一行、畫 📎);標題不帶那一行", /x\.turn\.role === "user" \? addHistoryYou\(x\.turn\.content\)/.test(appSrc) && /function addHistoryYou\(content\) \{ const a = splitAttachNote\(content\); return addMsg\("you", a\.text, a\.attachment\); \}/.test(appSrc) && /csTitle = first\.text \|\| \(first\.attachment \? "📎 " \+ first\.attachment : ""\);/.test(appSrc));
  t("畫面拿不到路徑:app.js 沒讀 File.path、沒有 webUtils", !/\.path\b[^\n]*attach|webUtils|getPathForFile/i.test(appSrc.split("聊天附件")[1] || "x"));
  t("telemetry 不記檔名:trackFeature 只收名字", !/trackFeature\([^)]*\.name/.test(appSrc));

  // ── 3. 畫面與字串 ──
  t("index.html:chip(檔名 + ✕)在更新那一格之下、建議列之上(同雲端的順序)、迴紋針在工具列最左、hidden file input", /<div class="attach-chip" id="attach-chip" hidden>\s*<span class="attach-name" id="attach-name"><\/span>[\s\S]{0,200}<span class="attach-hint" id="attach-hint" role="note" hidden><\/span>\s*<button type="button" class="attach-clear" id="attach-clear" data-i18n-aria="ws\.attachRemove">✕<\/button>/.test(html)
    && html.indexOf('id="ws-update"') < html.indexOf('id="attach-chip"') && html.indexOf('id="attach-chip"') < html.indexOf('id="sug-wrap"') && /<div class="ci-bar">\s*<!--[\s\S]*?-->\s*<input type="file" id="attach-input" hidden \/>\s*<button class="btn-attach" id="attach-btn" type="button" data-i18n-aria="ws\.attach">/.test(html));
  const st = fs.readFileSync(path.join(R, "strings.js"), "utf8");
  t("六個字串 en / zh 都有;zh 全形標點;太大那句同雲端 workspace_attach_too_large;不讀圖兩句照設計稽核", ["ws.attach", "ws.attachRemove", "ws.attachTooLarge", "ws.attachReadFail", "ws.attachNoImage", "ws.attachNoImageLong"].every((k) => (st.match(new RegExp('"' + k.replace(".", "\\.") + '": "', "g")) || []).length === 2)
    && st.includes('"ws.attachTooLarge": "檔案太大，上限 5MB。"') && st.includes('"ws.attachTooLarge": "File too large — the limit is 5MB."') && st.includes('"ws.attach": "附加檔案"') && st.includes('"ws.attachRemove": "移除附件"') && /"ws\.attachReadFail": "[^"]*。"/.test(st) && st.includes('"ws.attachNoImage": "{model} 不讀圖"') && st.includes('"ws.attachNoImageLong": "{model} 不讀圖，這張會被略過。"') && st.includes(`"ws.attachNoImage": "{model} can't read images"`) && st.includes(`"ws.attachNoImageLong": "{model} can't read images — this one will be skipped."`));
  const css = fs.readFileSync(path.join(R, "app.css"), "utf8");
  t("app.css:拖放落點 = 虛線 + --ink、排在 :focus-within 之後;提示字 --ink-3、與檔名隔 8;沒有沒人用的 .btn-attach:disabled", css.includes(".chat-input.is-drag { border-color: var(--ink); border-style: dashed; }") && css.indexOf(".chat-input:focus-within {") < css.indexOf(".chat-input.is-drag {") && /\.attach-hint \{ flex: none; margin-left: var\(--space-4\); color: var\(--ink-3\);/.test(css) && /\.attach-chip \{[^}]*gap: var\(--space-4\)/.test(css) && !css.includes(".btn-attach:disabled"));
  t("app.css:.btn-attach / .attach-chip / .attach-name / .attach-clear / 拖放落點提示,不寫死色碼", [".btn-attach {", ".attach-chip {", ".attach-name {", ".attach-clear {", ".chat-input.is-drag {"].every((s) => css.includes(s)) && !/#[0-9a-f]{3,6}\b/i.test(css.split(".btn-attach {")[1].split(".chat-input.is-drag {")[1].split("\n")[0] + css.split(".btn-attach {")[1].split("/* 檔案拖到")[0]));
} finally { fs.rmSync(TMP, { recursive: true, force: true }); }
console.log(red ? `\n${red} FAILED` : "\nALL PASS"); process.exit(red ? 1 : 0);
