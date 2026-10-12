// 聊天附件(0.1.17):跟雲端同一條契約。
//   1. shell/attach.js(主行程):消毒 / 上限同 api openclaw/webchat.py,落地與給引擎的兩行逐字同 runtime/web_bridge.py
//   2. renderer/app.js:chip 流程(選 / 拖 / 貼 → chip → 隨下一句送出 → 送出去了才清)、太大與空檔擋在畫面、純附件可送、
//      重送連檔一起送、停止時檔跟句子一起放回、貼上有字就貼字、拖文字進輸入框不攔
//   4. 落地排在「這一輪不跑」的檢查之後;workspace/tmp/inbound 放超過七天的由外殼清(只清那一層的一般檔案)
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
  t("驗形狀:不是物件 / 沒檔名 / data 不是字串 / 不是 base64 / 空檔 / 超過 5 MiB → null", [null, "x", [], { name: "a" }, { name: "a", data: 1 }, { name: "a", data: "@@@@" }, { name: "a", data: "abc" }, { name: "a", data: "" },
    { name: "a", data: "A".repeat(7000004) }].every((v) => at.validate(v) === null)
    && !!at.validate({ name: "a", data: b64("x") }) && at.validate({ name: "a", data: b64("x") }).mime === null && at.validate({ name: "a", data: b64("x"), mime: "text/plain" }).mime === "text/plain");
  { // 稽核 P1:xlsx / docx / pptx 的 MIME 超過 64 字,原本整個附件被判不合法(started 已回、畫面「bad attachment」,重送一樣失敗)
    const office = { "成交紀錄.xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "說明.docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "簡報.pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation" };
    const got = Object.keys(office).map((name) => { const v = at.validate({ name, mime: office[name], data: b64("PK" + name) }), saved = at.save(TMP, { name, mime: office[name], data: b64("PK" + name) });
      return { name, len: office[name].length, ok: !!v && v.mime === null && v.name === name, saved, same: saved === name && fs.readFileSync(path.join(TMP, "tmp", "inbound", name), "utf8") === "PK" + name }; });
    t("mime 不拿來拒收:xlsx / docx / pptx(真實 MIME 65 / 71 / 73 字)驗得過、落得了地、內容原樣;太長或不是字串的 mime 當成沒給(null),64 字以內的照留", got.map((g) => g.len).join() === "65,71,73" && got.every((g) => g.ok && g.same)
      && at.validate({ name: "a", data: b64("x"), mime: "m".repeat(65) }).mime === null && at.validate({ name: "a", data: b64("x"), mime: 5 }).mime === null && at.validate({ name: "a", data: b64("x"), mime: "m".repeat(64) }).mime === "m".repeat(64)
      && at.validate({ name: "t.xls", data: b64("x"), mime: "application/vnd.ms-excel" }).mime === "application/vnd.ms-excel", got);
    t("…主行程沒有任何地方讀驗過的 mime(runTurn 只看 validate 回不回 null、save 只寫位元組):當成沒給不影響後面", !/\bv\.mime\b/.test(mainSrc) && (mainSrc.match(/at\.validate\(attachment\)/g) || []).length === 1 && !/\.mime/.test(fs.readFileSync(path.join(SHELL, "attach.js"), "utf8").replace(/att\.mime/g, ""))); }
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

  // ── 七天清掃(電腦版不跑 runtime/prune_job.py)──
  { const ws = fs.mkdtempSync(path.join(TMP, "prune-")), inb = path.join(ws, "tmp", "inbound"), outside = fs.mkdtempSync(path.join(TMP, "outside-"));
    fs.mkdirSync(path.join(inb, "sub"), { recursive: true });
    const now = Date.now(), day = 86400e3, old = (p, days) => { const tt = new Date(now - days * day); fs.utimesSync(p, tt, tt); };
    const w = (p, days) => { fs.writeFileSync(p, "x"); old(p, days); return p; };
    const fOld = w(path.join(inb, "old.csv"), 8), fNew = w(path.join(inb, "new.csv"), 6), fSub = w(path.join(inb, "sub", "old-in-sub.csv"), 30), fOut = w(path.join(outside, "victim.txt"), 30);
    fs.symlinkSync(fOut, path.join(inb, "link-to-file")); fs.symlinkSync(outside, path.join(inb, "link-to-dir"));
    try { fs.lutimesSync(path.join(inb, "link-to-file"), new Date(now - 30 * day), new Date(now - 30 * day)); } catch (_) { /* 平台不支援就算了:連結本來就不是一般檔案 */ }
    old(path.join(inb, "sub"), 30);
    const n = at.prune(ws, now);
    t("prune:只刪 inbound 這一層放超過七天的一般檔案;七天內的、子目錄(與裡面的舊檔)、symlink 與它指到的檔都不動", n === 1 && !fs.existsSync(fOld) && fs.existsSync(fNew) && fs.existsSync(fSub) && fs.existsSync(fOut) && fs.lstatSync(path.join(inb, "link-to-file")).isSymbolicLink() && fs.lstatSync(path.join(inb, "link-to-dir")).isSymbolicLink() && fs.existsSync(path.join(outside, "victim.txt")), { n });
    // inbound / tmp 被換成連到外面的 symlink:整個不清(不然等於替 agent 刪 workspace 以外的檔)
    const ws2 = fs.mkdtempSync(path.join(TMP, "prune2-")); fs.mkdirSync(path.join(ws2, "tmp")); fs.symlinkSync(outside, path.join(ws2, "tmp", "inbound"));
    const ws3 = fs.mkdtempSync(path.join(TMP, "prune3-")), out3 = fs.mkdtempSync(path.join(TMP, "outside3-")); fs.mkdirSync(path.join(out3, "inbound")); const fOut3 = w(path.join(out3, "inbound", "victim.txt"), 30); fs.symlinkSync(out3, path.join(ws3, "tmp"));
    t("prune:inbound 或 tmp 是連到別處的 symlink → 一個都不刪", at.prune(ws2, now) === 0 && fs.existsSync(fOut) && at.prune(ws3, now) === 0 && fs.existsSync(fOut3));
    t("prune:目錄不存在(沒收過檔)→ 0、不拋、不建目錄", at.prune(path.join(TMP, "nope"), now) === 0 && !fs.existsSync(path.join(TMP, "nope")));
    const ws4 = fs.mkdtempSync(path.join(TMP, "prune4-")); at.save(ws4, { name: "first.txt", data: b64("1") }); old(path.join(ws4, "tmp", "inbound", "first.txt"), 9); at.save(ws4, { name: "second.txt", data: b64("2") });
    t("落地新附件時順手清:九天前那個不見了、剛存的還在", !fs.existsSync(path.join(ws4, "tmp", "inbound", "first.txt")) && fs.existsSync(path.join(ws4, "tmp", "inbound", "second.txt")));
    t("外殼啟動時清一次(startStep,失敗不擋啟動);七天同 runtime/prune_job.py", /startStep\("inbound prune", \(\) => require\("\.\/attach"\)\.prune\(WS\)\);/.test(mainSrc) && /INBOUND_RETENTION_DAYS = 7\b/.test(fs.readFileSync(path.join(ROOT, "runtime", "prune_job.py"), "utf8")) && /const INBOUND_KEEP_MS = 7 \* 24 \* 3600 \* 1000;/.test(fs.readFileSync(path.join(SHELL, "attach.js"), "utf8"))); }

  // ── main.js 接線 ──
  const rt = (mainSrc.match(/async function runTurn\(win, \{[^}]*\}\) \{[\s\S]*?\n\}/) || [""])[0];
  t("runTurn 收 attachment:先驗形狀(壞的整輪不跑)與加上那一行之後的 stdin 上限 → 落地 workspace/tmp/inbound → withNote 接在訊息尾端",
    /async function runTurn\(win, \{ sessionId, message, [^}]*attachment \}\)/.test(rt)
    && /const v = at\.validate\(attachment\);\n\s*if \(!v\) throw new Error\("bad attachment"\);\n\s*if \(Buffer\.byteLength\(at\.withNote\(message, "0000000000_" \+ v\.name\), "utf8"\) > MESSAGE_MAX_BYTES\) throw new Error\("bad message"\);/.test(rt)
    && /if \(at\) message = at\.withNote\(message, at\.save\(WS, attachment\)\);/.test(rt) && rt.indexOf("at.save(") < rt.indexOf("child.stdin.end(message)"));
  { const iVal = rt.indexOf("at.validate(attachment)"), iSave = rt.indexOf("at.save(WS, attachment)"), iCodex = rt.indexOf('throw new Error("AGENT_BIN_MISSING")'), iKey = rt.indexOf('throw new Error("APIKEY_MISSING")');
    t("落地排在「這一輪不跑」的檢查之後:Codex 不見 / 金鑰不見那兩條路不留沒有回合的檔(整支 runTurn 只落地一次)", iVal > 0 && iCodex > iVal && iKey > iVal && iSave > iCodex && iSave > iKey && (rt.match(/at\.save\(/g) || []).length === 1, { iVal, iCodex, iKey, iSave });
    const bl = (x) => Buffer.byteLength(x, "utf8");
    t("…事先量長度用的那一行是最長的:撞名前綴剛好 10 位秒數 + 底線,而且不比「接收失敗」那行短(1 個字的檔名也是)", bl(at.withNote("", "0000000000_a")) >= bl(at.withNote("", null)) && bl(at.withNote("", "0000000000_a")) === bl(at.withNote("", `${Math.floor(Date.now() / 1000)}_a`))); }
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
    && /\$\("attach-name"\)\.textContent = attachedFile \? attachedFile\.name : "";\n[^\n]*\n\s*attachHintPaint\(\);/.test(cut("setAttachment")) && /attachHintPaint\(\);[^\n]*\n\}/.test(cut("mpPaint")) && /youRelang\(\);[^\n]*\n\s*attachHintPaint\(\);/.test(appSrc) && !/attachNoImage\(/.test(cut("sendDraft") + (appSrc.match(/async function submitMessage\(msg, opts\) \{[\s\S]*?\n\}/) || [""])[0]));
  const map = vm.runInNewContext((appSrc.match(/const ATTACH_FEATURE = \{[^}]*\};/) || [""])[0] + "ATTACH_FEATURE"), kind = vm.runInNewContext("(" + cut("attachKind") + ")");
  const feat = (f, from) => map[kind(f, from)];
  t("埋點名:貼上 → attach_paste(不分圖或檔);選檔 / 拖放的圖 → attach_image;其他 → attach_file", feat({ type: "image/png" }, "paste") === "attach_paste" && feat({ type: "image/jpeg" }, "file") === "attach_image" && feat({ type: "text/csv" }, "file") === "attach_file" && feat({ type: "" }, "file") === "attach_file" && feat(null, undefined) === "attach_file");
  const F = EVENTS.feature_used.name;
  // 0.1.18 統一本機開通的 pres_* 六個接在它們後面,再接方案制那幾個
  const ai = F.indexOf("attach_file");
  t("三個名字在 0.1.17 那批最後(後面接 0.1.18 的 pres_* 六個、再接方案制 plan_monthly…、0.1.20 的 strat_* 與請求卡交還鈕 browser_hb_card 收尾)、≤16 字", F.slice(ai, ai + 3).join() === "attach_file,attach_image,attach_paste" && F.slice(ai + 3, ai + 9).every((n) => /^pres_/.test(n)) && F[ai + 9] === "plan_monthly" && F.slice(-3).join() === "strat_flag_set,strat_reorder,browser_hb_card" && F.slice(ai, ai + 3).every((n) => n.length <= 16));
  t("選檔 / 拖放 / 貼上三個入口都走 takeAttachment:太大講一行(同雲端 addNotice)、不掛 chip", /if \(file\.size > ATTACH_MAX_BYTES\) \{ addMsg\("sys", t\("ws\.attachTooLarge"\)\)\.dataset\.i18n = "ws\.attachTooLarge"; return false; \}/.test(cut("takeAttachment"))
    && /const ATTACH_MAX_BYTES = 5 \* 1024 \* 1024;/.test(appSrc) && /\$\("attach-input"\)\.value = "";[^\n]*\n\s*takeAttachment\(f, "file"\);/.test(appSrc) && /addEventListener\("drop", [^\n]*takeAttachment\(f, "file"\)/.test(appSrc) && /addEventListener\("paste", [\s\S]{0,300}?takeAttachment\(f, "paste"\)/.test(appSrc));
  t("迴紋針 → 開檔案框;✕ → 清 chip", /\$\("attach-btn"\)\.addEventListener\("click", \(\) => \$\("attach-input"\)\.click\(\)\);/.test(appSrc) && /\$\("attach-clear"\)\.addEventListener\("click", \(\) => \{ setAttachment\(null\);/.test(appSrc));
  t("檔名截尾時全名在 title(長檔名看得到副檔名);清 chip 時一併清掉", /\$\("attach-name"\)\.title = attachedFile \? attachedFile\.name : "";/.test(cut("setAttachment")));
  { // 空檔:選到那一刻就講、不掛 chip(主行程不收 0 位元組,等它回絕時 chip 已清、埋點已送)。真的跑 takeAttachment
    const msgs = [], set = [];
    const mkTake = (blave) => new Function("addMsg", "t", "setAttachment", "ATTACH_MAX_BYTES", "window", cut("takeAttachment") + "; return takeAttachment;")((cls, text) => { const m = { cls, text, dataset: {} }; msgs.push(m); return m; }, (k) => k, (f, from) => set.push([f, from]), at.ATTACH_MAX_BYTES, { blave });
    const take = mkTake({ attachNameMax: at.ATTACH_NAME_MAX });
    const r0 = take({ size: 0, name: "empty.csv" }, "file"), n0 = set.length, rBig = take({ size: at.ATTACH_MAX_BYTES + 1, name: "big.bin" }, "file"), r1 = take({ size: 1, name: "a" }, "paste");
    t("takeAttachment:0 位元組 → 講「檔案是空的」、不掛 chip;太大照舊;1 byte 掛上", r0 === false && n0 === 0 && msgs[0].cls === "sys" && msgs[0].text === "ws.attachEmpty" && msgs[0].dataset.i18n === "ws.attachEmpty" && rBig === false && msgs[1].text === "ws.attachTooLarge" && r1 === true && set.length === 1 && set[0][1] === "paste", { r0, rBig, r1, msgs });
    t("…主行程確實不收空檔(畫面那一道擋的就是這個)", at.validate({ name: "empty.csv", data: "" }) === null);
    // 檔名太長:同一類(主行程回絕時已經回了 started)。上限只有主行程那一個數字,經 additionalArguments → preload → window.blave.attachNameMax
    const nSet = set.length, nMsg = msgs.length, long = "長".repeat(at.ATTACH_NAME_MAX) + "x", edge = "x".repeat(at.ATTACH_NAME_MAX);
    const rLong = take({ size: 1, name: long }, "file"), longMsg = msgs[nMsg], rEdge = take({ size: 1, name: edge }, "file");
    t("takeAttachment:檔名超過上限 → 講「檔名太長」、不掛 chip;剛好等於上限照掛(跟主行程同一條線)", rLong === false && set.length === nSet + 1 && longMsg && longMsg.text === "ws.attachNameLong" && longMsg.dataset.i18n === "ws.attachNameLong" && rEdge === true && set[nSet][0].name === edge
      && at.validate({ name: long, data: b64("x") }) === null && !!at.validate({ name: edge, data: b64("x") }), { rLong, rEdge, longMsg });
    t("…上限沒交過來(0 / 沒這個欄位)→ 畫面不擋,仍由主行程擋", mkTake({ attachNameMax: 0 })({ size: 1, name: long }, "file") === true && mkTake({})({ size: 1, name: long }, "file") === true);
    const preLine = (preSrc.match(/^\s*attachNameMax: ([^\n]*?),\n/m) || [])[1] || "null", argOf = (argv) => new Function("process", "return " + preLine)({ argv });
    t("上限的來源只有 shell/attach.js:main.js 用 additionalArguments 帶 ATTACH_NAME_MAX、preload 從 process.argv 讀(沒有 argv 也回 0、不丟例外:preload 一丟 window.blave 就不存在);app.js 與 preload 都不寫數字", /additionalArguments: \["--blave-attach-name-max=" \+ require\("\.\/attach"\)\.ATTACH_NAME_MAX\],/.test(mainSrc)
      && argOf(["electron", "--x=1", "--blave-attach-name-max=" + at.ATTACH_NAME_MAX]) === at.ATTACH_NAME_MAX && argOf(["electron"]) === 0 && argOf(["electron", "--blave-attach-name-max=abc"]) === 0 && argOf(undefined) === 0
      && /const nameMax = window\.blave\.attachNameMax;/.test(cut("takeAttachment")) && !/\b\d{2,}\b/.test(cut("takeAttachment")) && !/\d/.test(preLine.replace("[1]", "").replace("=== 0", "").replace("|| 0", "")), { preLine }); }
  { // 拖放:兩支純函式真的跑
    const D = vm.runInNewContext(cut("dragHasFiles") + "\n" + cut("dragIsText") + "\n({ dragHasFiles, dragIsText })");
    const el = (editable) => ({ nodeType: 1, closest: (sel) => (sel === "textarea, input, [contenteditable]" && editable ? {} : null) });
    const txt = { types: ["text/plain", "text/html"] }, files = { types: ["Files"] }, both = { types: ["text/uri-list", "Files"] };
    t("dragHasFiles:types 含 Files 才算檔(選取的文字 / 沒有 dataTransfer 不算)", D.dragHasFiles(files) && D.dragHasFiles(both) && !D.dragHasFiles(txt) && !D.dragHasFiles(null) && !D.dragHasFiles({}));
    t("dragIsText:拖的是文字而且落在可打字的欄位 → 不攔;落在別處、或拖的是檔 → 照舊攔", D.dragIsText({ target: el(true), dataTransfer: txt }) && D.dragIsText({ target: { nodeType: 3, parentElement: el(true) }, dataTransfer: txt })
      && !D.dragIsText({ target: el(false), dataTransfer: txt }) && !D.dragIsText({ target: el(true), dataTransfer: files }) && !D.dragIsText({ target: el(true), dataTransfer: both }) && !D.dragIsText({ target: null, dataTransfer: txt })); }
  t("拖放接線:dragenter / dragover / drop 三支都先放行文字(不 preventDefault);檔案只認輸入框,視窗其他地方照舊攔、不收;落點提示只給檔案",
    /\["dragenter", "dragover"\]\.forEach\(\(ev\) => document\.addEventListener\(ev, \(e\) => \{ if \(dragIsText\(e\)\) return; e\.preventDefault\(\);/.test(appSrc)
    && /document\.addEventListener\("drop", \(e\) => \{ if \(dragIsText\(e\)\) return; e\.preventDefault\(\);[^\n]*if \(!ciBox\.contains\(e\.target\)\) return;/.test(appSrc)
    && /ciBox\.addEventListener\("dragover", \(e\) => \{ if \(dragHasFiles\(e\.dataTransfer\)\) ciBox\.classList\.add\("is-drag"\); \}\);/.test(appSrc));
  { // 貼上:把真的那支 handler 掛到假的 #ta 上,餵假的 clipboardData
    const pasteSrc = (appSrc.match(/\$\("ta"\)\.addEventListener\("paste", [\s\S]*?\n\}\);/) || [""])[0];
    let handler = null; const taken = [];
    new Function("$", "takeAttachment", cut("pasteFile") + "\n" + pasteSrc)(() => ({ addEventListener: (n, fn) => { if (n === "paste") handler = fn; } }), (f, from) => { taken.push([f, from]); return true; });
    const cd = (files, text) => ({ files, getData: (k) => (k === "text/plain" ? text || "" : "") });
    const paste = (c) => { const e = { clipboardData: c, prevented: false, preventDefault() { this.prevented = true; } }; const n = taken.length; handler(e); return (e.prevented ? "attach" : "text") + ":" + (taken.length - n); };
    const png = { name: "image.png", type: "image/png" }, csv = { name: "報告 Q3.csv", type: "text/csv" }, b = { name: "b.txt", type: "text/plain" };
    t("貼上:剪貼簿同時有字與圖(試算表複製儲存格)→ 不攔、字照常貼、不掛 chip", !!handler && paste(cd([png], "12\t34\n56\t78")) === "text:0" && paste(cd([png], "營收 1,234")) === "text:0");
    t("貼上:只有圖 / 檔沒有字(截圖、複製的圖)→ 當附件(from = paste)", paste(cd([png], "")) === "attach:1" && paste(cd([png], " \n")) === "attach:1" && paste({ files: [png] }) === "attach:1" && taken[taken.length - 1][0] === png && taken[taken.length - 1][1] === "paste");
    t("貼上:從檔案管理員複製的檔(字只是檔名或路徑,多檔一行一個)仍當附件;字多了別的就貼字", paste(cd([csv], "報告 Q3.csv")) === "attach:1" && paste(cd([csv], "/Users/me/Desktop/報告 Q3.csv")) === "attach:1" && paste(cd([csv, b], "報告 Q3.csv\rb.txt")) === "attach:1" && paste(cd([csv], "報告 Q3.csv 幫我看")) === "text:0" && paste(cd([csv, b], "報告 Q3.csv\n別的字")) === "text:0");
    t("貼上:剪貼簿沒檔 → 文字照常貼(不 preventDefault)", paste(cd([], "純文字")) === "text:0" && paste(null) === "text:0" && paste({}) === "text:0"); }
  const sd = cut("sendDraft"), sub = (appSrc.match(/async function submitMessage\(msg, opts\) \{[\s\S]*?\n\}/) || [""])[0];
  t("sendDraft:純附件可送;chip 不在這裡清(由 submitMessage 在 started 那一刻清:還掛著同一個檔才清)", /if \(\(!msg && !attachment\) \|\| running\) return;/.test(sd) && /await submitMessage\(msg, \{ typed: true, attachment, from: attachedFrom \}\);/.test(sd) && !/setAttachment\(/.test(sd)
    && /if \(r\.started && attachment && attachedFile === attachment\) setAttachment\(null\);\n\s*if \(r\.started\) \{/.test(sub) && (sub.match(/setAttachment\(/g) || []).length === 1);
  t("submitMessage:純附件可送;泡泡末行畫檔名;送出那一刻才讀位元組(讀不到 → 講一行、收泡泡、chip 留著);payload 帶 { name, mime, data }",
    /if \(\(!msg && !attachment\) \|\| running\) return false;/.test(sub) && /addMsg\("you", msg, attachment \? attachment\.name : null\)/.test(sub)
    && /att = \{ name: attachment\.name, mime: attachment\.type \|\| "application\/octet-stream", data: await readAttachment\(attachment\) \};/.test(sub)
    && /catch \(_\) \{ addMsg\("sys", t\("ws\.attachReadFail"\)\)\.dataset\.i18n = "ws\.attachReadFail"; unsend\(\); unlock\(\); return false; \}/.test(sub) && /viewing, attachment: att \}\);/.test(sub));
  t("…回合跑起來才送 attach_* 埋點(chat_sent 之後);busy / 版本閘那幾條不送", /if \(r\.started\) \{ busyStart\(\); trackFeature\("chat_sent"\); if \(attachment\) trackFeature\(ATTACH_FEATURE\[attachKind\(attachment, opts && opts\.from\)\]\); return true; \}/.test(sub) && (sub.match(/attachKind\(/g) || []).length === 1);
  t("上一句帶的檔另外記(lastUserAttachment / lastUserFrom;沒帶 = null);檔名不進 lastUserText", /lastUserText = msg;/.test(sub) && !/lastUserText = [^;]*attachment/.test(sub) && /lastUserAttachment = attachment; lastUserFrom = attachment \? \(opts && opts\.from\) \|\| "file" : null;/.test(sub));
  { // 「再送一次」:真的跑 canResend / resendLast
    const line = (name) => (appSrc.match(new RegExp("^function " + name + "\\(\\)[^\\n]*$", "m")) || [""])[0];
    const rig = (text, att, running) => { const calls = []; const api = new Function("submitMessage", "running", "lastUserText", "lastUserAttachment", "lastUserFrom", line("canResend") + "\n" + line("resendLast") + "\nreturn { canResend, resendLast };")((m, o) => { calls.push([m, o]); return Promise.resolve(true); }, !!running, text, att, att ? "paste" : null); return { api, calls }; };
    const file = { name: "a.csv", type: "text/csv" };
    const pure = rig("", file), both = rig("看一下", file), txt = rig("嗨", null), none = rig("", null), busy = rig("嗨", file, true);
    pure.api.resendLast(); both.api.resendLast(); txt.api.resendLast(); none.api.resendLast(); busy.api.resendLast();
    t("重送:純附件那句(字是空的)也送得出去,而且帶同一個檔與來源", pure.api.canResend() && pure.calls.length === 1 && pure.calls[0][0] === "" && pure.calls[0][1].attachment === file && pure.calls[0][1].from === "paste", pure.calls);
    t("重送:帶字的那句連檔一起;沒帶檔的照舊只送句子;沒有上一句 / 回合在跑 → 不送", both.calls[0][0] === "看一下" && both.calls[0][1].attachment === file && txt.calls.length === 1 && txt.calls[0][1].attachment === null && !none.api.canResend() && none.calls.length === 0 && busy.calls.length === 0);
    const akSrc = fs.readFileSync(path.join(R, "apikey.js"), "utf8");
    t("每一顆重送鈕都走 resendLast(app.js 四處 + apikey.js);沒有只看 lastUserText 的閘", ((appSrc + akSrc).match(/submitMessage\(lastUserText/g) || []).length === 1 && !/!lastUserText\b|&& lastUserText\)/.test(appSrc + akSrc)
      && (appSrc.match(/resendLast\(\)/g) || []).length >= 4 && /const resend = \(\) => \{ resendLast\(\); \};/.test(akSrc) && /if \(!canResend\(\)\) return; if \(dataCard === card\) dataCard = null;/.test(appSrc)); }
  { // 停止還原:真的跑 stopRestore 與 turn-end 那一段
    const mk = (chip) => { const els = { ta: { value: "", focused: false, focus() { this.focused = true; } } }, st = { set: [] };
      const fn = new Function("$", "autosize", "st", "chip", "let attachedFile = chip; const setAttachment = (f, from) => { attachedFile = f; st.set.push([f, from]); };\n" + cut("stopRestore") + "\nreturn stopRestore;")((id) => els[id], () => {}, st, chip); return { fn, ta: els.ta, st }; };
    const file = { name: "a.csv" }, other = { name: "b.csv" };
    const a = mk(null); a.fn("", file, "paste"); const b2 = mk(other); b2.fn("看一下", file, "file"); const c = mk(null); c.fn("看一下", file, "file"); const d = mk(null); d.fn("", null);
    t("stopRestore:純附件那句 → 檔放回 chip(帶原來的來源)、輸入框不動、游標回輸入框", a.st.set.length === 1 && a.st.set[0][0] === file && a.st.set[0][1] === "paste" && a.ta.value === "" && a.ta.focused);
    t("stopRestore:字與檔一起放回;chip 已經掛了別的檔 → 不蓋,字照樣放回;什麼都沒有 → 不動", c.st.set.length === 1 && c.ta.value === "看一下" && b2.st.set.length === 0 && b2.ta.value === "看一下" && d.st.set.length === 0 && !d.ta.focused);
    const stopBlk = (appSrc.match(/if \(stopped && lastUserTyped\) \{[\s\S]*?\n  \}/) || [""])[0];
    const end = (o) => { const log = []; new Function("stopped", "lastUserTyped", "lastUserText", "lastUserAttachment", "lastUserFrom", "attachedFile", "turnGotReply", "turnHadTool", "turnBubble", "stopRestore", stopBlk)(true, true, o.text, o.att, "file", o.chip, !!o.reply, false, { parentNode: {}, remove: () => log.push("bubble-removed") }, (x, f, from) => log.push("restore:" + x + ":" + (f ? f.name : "-") + ":" + from)); return log.join(); };
    t("停止(turn-end):純附件那句不再無聲消失——泡泡收回、檔回到 chip", end({ text: "", att: file, chip: null }) === "bubble-removed,restore::a.csv:file", end({ text: "", att: file, chip: null }));
    t("…chip 被回合中另外掛的檔佔住(放不回去)→ 泡泡留著;沒帶檔的句子照舊收泡泡;有回覆的照舊留泡泡、檔仍放回", end({ text: "", att: file, chip: other }) === "restore::a.csv:file" && end({ text: "嗨", att: null, chip: other }) === "bubble-removed,restore:嗨:-:file" && end({ text: "嗨", att: file, chip: null, reply: true }) === "restore:嗨:a.csv:file");
    // 沒送出去的路(unsend):真的跑那一行。稽核 P2:「再送一次」遇到 busy / 版本閘 / 讀檔失敗,而 chip 已被另一個檔佔住 → 原本泡泡照收、檔放不回,無聲消失
    const unLine = (sub.match(/^  const unsend = \(\) => \{[^\n]*\};$/m) || [""])[0];
    const un = (o) => { const log = []; if (!unLine) return "no unsend line"; new Function("bubble", "lastUserTyped", "msg", "attachment", "lastUserFrom", "attachedFile", "stopRestore", unLine + "\nunsend();")({ remove: () => log.push("bubble-removed") }, o.typed !== false, o.text, o.att, "file", o.chip, (x, f, from) => log.push("restore:" + x + ":" + (f ? f.name : "-") + ":" + from)); return log.join(); };
    t("沒送出去的路(unsend:busy / 版本閘 / 暖機中停止 / 引擎起不來 / 讀檔失敗):泡泡收回、這一句帶的檔跟句子一起放回(chip 空著,或還掛著同一個檔)", !!unLine && un({ text: "", att: file, chip: null }) === "bubble-removed,restore::a.csv:file" && un({ text: "看一下", att: file, chip: file }) === "bubble-removed,restore:看一下:a.csv:file" && un({ text: "嗨", att: null, chip: other }) === "bubble-removed,restore:嗨:-:file", unLine);
    t("…chip 被另一個檔佔住(放不回去)→ 泡泡留著,檔不無聲消失;自動組的固定句(沒帶檔)照舊只收泡泡、不塞回輸入框", un({ text: "", att: file, chip: other }) === "restore::a.csv:file" && un({ text: "看一下", att: file, chip: other }) === "restore:看一下:a.csv:file" && un({ text: "轉出", att: null, chip: null, typed: false }) === "bubble-removed", unLine); }
  t("addMsg:帶檔名時泡泡多一行「迴紋針 + 檔名」(設計稽核 0.1.17:不用 📎 emoji;圖示複製輸入框那顆 .icon-attach、檔名走文字節點、不拼 innerHTML)", /if \(attachment\) \{ if \(text\) b\.appendChild\(document\.createTextNode\("\\n"\)\); b\.appendChild\(attachLine\(attachment\)\); \}/.test(cut("addMsg"))
    && /s\.className = "msg-attach";\n\s*s\.append\(\$\("attach-btn"\)\.querySelector\("\.icon-attach"\)\.cloneNode\(true\), document\.createTextNode\(name\)\);/.test(cut("attachLine")) && !/innerHTML/.test(cut("attachLine")));
  t("app.js / index.html 沒有 📎(canon:不用 emoji);純文字場合(對話標題)只留檔名", !/📎/.test(appSrc) && !/📎/.test(html) && /if \(!csTitle\) \{ csTitle = msg \|\| attachment\.name; csRenderHead\(\); csRemember\(\); \}/.test(appSrc));
  t("舊對話畫回去:使用者那句走 addHistoryYou(拆掉那一行、畫迴紋針 + 檔名);標題不帶那一行、純附件開頭的只留檔名", /x\.turn\.role === "user" \? addHistoryYou\(x\.turn\.content\)/.test(appSrc) && /function addHistoryYou\(content\) \{ const a = splitAttachNote\(content\); return addMsg\("you", a\.text, a\.attachment\); \}/.test(appSrc) && /csTitle = first\.text \|\| first\.attachment \|\| "";/.test(appSrc));
  t("畫面拿不到路徑:app.js 沒讀 File.path、沒有 webUtils", !/\.path\b[^\n]*attach|webUtils|getPathForFile/i.test(appSrc.split("聊天附件")[1] || "x"));
  t("telemetry 不記檔名:trackFeature 只收名字", !/trackFeature\([^)]*\.name/.test(appSrc));

  // ── 3. 畫面與字串 ──
  t("index.html:chip(檔名 + ✕)貼著輸入框——在建議列與 #ta-wait 之下、.chat-input 正上方(設計稽核 0.1.17:建議列每輪都長,chip 放它上面離輸入框 200 多 px)、迴紋針在工具列最左、hidden file input", /<div class="attach-chip" id="attach-chip" hidden>\s*<span class="attach-name" id="attach-name"><\/span>[\s\S]{0,200}<span class="attach-hint" id="attach-hint" role="note" hidden><\/span>\s*<button type="button" class="attach-clear" id="attach-clear" data-i18n-aria="ws\.attachRemove">✕<\/button>\s*<\/div>\s*<div class="chat-input">/.test(html)
    && html.indexOf('id="ws-update"') < html.indexOf('id="sug-wrap"') && html.indexOf('id="sug-wrap"') < html.indexOf('id="ta-wait"') && html.indexOf('id="ta-wait"') < html.indexOf('id="attach-chip"') && /<div class="ci-bar">\s*<!--[\s\S]*?-->\s*<input type="file" id="attach-input" hidden \/>\s*<button class="btn-attach" id="attach-btn" type="button" data-i18n-aria="ws\.attach">/.test(html));
  const st = fs.readFileSync(path.join(R, "strings.js"), "utf8");
  t("空檔那句 en / zh 都有、zh 全形標點", (st.match(/"ws\.attachEmpty": "/g) || []).length === 2 && st.includes('"ws.attachEmpty": "這個檔案是空的，沒有內容可以傳。"'));
  t("檔名太長那句 en / zh 都有、zh 全形標點", (st.match(/"ws\.attachNameLong": "/g) || []).length === 2 && st.includes('"ws.attachNameLong": "檔名太長，請改短一點再傳。"'));
  t("六個字串 en / zh 都有;zh 全形標點;太大那句同雲端 workspace_attach_too_large;不讀圖兩句照設計稽核", ["ws.attach", "ws.attachRemove", "ws.attachTooLarge", "ws.attachReadFail", "ws.attachNoImage", "ws.attachNoImageLong"].every((k) => (st.match(new RegExp('"' + k.replace(".", "\\.") + '": "', "g")) || []).length === 2)
    && st.includes('"ws.attachTooLarge": "檔案太大，上限 5MB。"') && st.includes('"ws.attachTooLarge": "File is too large. The limit is 5 MB."') && st.includes('"ws.attach": "附加檔案"') && st.includes('"ws.attachRemove": "移除附件"') && /"ws\.attachReadFail": "[^"]*。"/.test(st) && st.includes('"ws.attachNoImage": "{model} 不讀圖"') && st.includes('"ws.attachNoImageLong": "{model} 不讀圖，這張會被略過。"') && st.includes(`"ws.attachNoImage": "{model} can't read images"`) && st.includes(`"ws.attachNoImageLong": "{model} can't read images. This one will be skipped."`));
  const css = fs.readFileSync(path.join(R, "app.css"), "utf8");
  t("app.css:泡泡末行的附件 .msg-attach = inline-flex、flex-start、圖示撐一行高 1.6em、與檔名隔 --space-4(設計稽核 0.1.18,同 web);圖示沿用 .icon-attach(沒有第二份迴紋針)", /\.msg-attach \{ display: inline-flex; align-items: flex-start; gap: var\(--space-4\); max-width: 100%; vertical-align: top; \}\n\.msg-attach \.icon-attach \{ flex: none; height: 1\.6em; \}/.test(css) && (html.match(/class="icon-attach"/g) || []).length === 1);
  t("app.css:拖放落點 = 虛線 + --ink、排在 :focus-within 之後;提示字 --ink-3、與檔名隔 8;沒有沒人用的 .btn-attach:disabled", css.includes(".chat-input.is-drag { border-color: var(--ink); border-style: dashed; }") && css.indexOf(".chat-input:focus-within {") < css.indexOf(".chat-input.is-drag {") && /\.attach-hint \{ flex: none; margin-left: var\(--space-4\); color: var\(--ink-3\);/.test(css) && /\.attach-chip \{[^}]*gap: var\(--space-4\)/.test(css) && !css.includes(".btn-attach:disabled"));
  t("app.css:✕ 看得到的是 20px、熱區用 ::before 外擴 4px = 28×28(桌面下限 24)", /\.attach-clear \{ position: relative; flex: none; width: 20px; height: 20px;/.test(css) && css.includes('.attach-clear::before { content: ""; position: absolute; inset: -4px; }'));
  t("app.css:.btn-attach / .attach-chip / .attach-name / .attach-clear / 拖放落點提示,不寫死色碼", [".btn-attach {", ".attach-chip {", ".attach-name {", ".attach-clear {", ".chat-input.is-drag {"].every((s) => css.includes(s)) && !/#[0-9a-f]{3,6}\b/i.test(css.split(".btn-attach {")[1].split(".chat-input.is-drag {")[1].split("\n")[0] + css.split(".btn-attach {")[1].split("/* 檔案拖到")[0]));
} finally { fs.rmSync(TMP, { recursive: true, force: true }); }
console.log(red ? `\n${red} FAILED` : "\nALL PASS"); process.exit(red ? 1 : 0);
