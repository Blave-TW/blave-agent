// 引擎的用量上限(e2e 0.1.8 第八批 #4,e2e #187)。Wei 實測:Claude Code 訂閱用量到上限,回合 13 秒後中斷,聊天裡是引擎的英文原文
// 「You've hit your session limit · resets 1:50pm (Asia/Taipei)」加通用錯誤句「這一輪中途斷了,你剛才的要求可能只做完一部分」。
//   1. limitMatch:認得出實測那一句(逐字稿 2026-09-28 13:38);錨在開頭、只認現在連的那個引擎;認不出來 → null(照舊走通用句)
//   2. limitWhen:引擎給的時刻 + 引擎標的時區 → 用戶時區的寫法;讀不懂就不寫時間
//   3. limitSwallow:沒做過會改東西的步驟,不說「可能只做完一部分」
//   4. 接線與字串
// 從 renderer/app.js 原文切出來跑,不起 Electron。跑法:node tests/check_shell_limit_fault.js
const fs = require("fs"), path = require("path");
const R = path.join(__dirname, "..", "shell", "renderer");
const src = fs.readFileSync(path.join(R, "app.js"), "utf8");
const STR = new Function(fs.readFileSync(path.join(R, "strings.js"), "utf8") + "; return STRINGS;")();
const cut = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); if (i < 0 || j < 0) throw new Error("找不到標記:" + a); return src.slice(i, j); };
const L = new Function(cut("const LIMIT_RULES = [", "function classifyFault(") + "\nreturn { LIMIT_RULES, limitMatch, limitWhen, limitSwallow, LIMIT_READONLY };")();
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };

// ---- 1. 認不認得
const REAL = "You've hit your session limit · resets 1:50pm (Asia/Taipei)";
let m = L.limitMatch(REAL, "claude");
ok("實測那一句:認得出,重置時間與時區拿得到", !!m && m.when === "1:50pm" && m.zone === "Asia/Taipei", m);
ok("同一句型的其他額度(週額度、帶日期)、彎引號、前後空白也認得", [["You've hit your weekly limit · resets Oct 3, 9am (Asia/Taipei)", "Oct 3, 9am"], ["You’ve hit your session limit · resets 9am (America/New_York)\n", "9am"], ["You've hit your limit · resets 11:05pm", "11:05pm"]]
  .every(([s, w]) => { const x = L.limitMatch(s, "claude"); return !!x && x.when === w; }));
ok("認不出來 → null:agent 的回覆裡提到 limit(不在開頭)、別的錯誤、空字串", ["你問的那句 You've hit your session limit · resets 1:50pm (Asia/Taipei) 是引擎的訊息", "API Error: 429 rate limited", "You've hit the order size limit on Binance.", "", null]
  .every((s) => L.limitMatch(s, "claude") === null));
ok("只認現在連的那個引擎的樣式:Codex / Blave AI 連著時這一句不算(照舊走通用句)", L.limitMatch(REAL, "codex") === null && L.limitMatch(REAL, "blave") === null && L.limitMatch(REAL, null) === null);
ok("判別是一張表(一列一種引擎訊息),每一列都錨在開頭", Array.isArray(L.LIMIT_RULES) && L.LIMIT_RULES.length >= 1 && L.LIMIT_RULES.every((r) => typeof r.engine === "string" && r.re instanceof RegExp && r.re.source[0] === "^"));

// ---- 2. 時間
const NOW = Date.parse("2026-09-28T05:38:18Z");   // 台北 13:38
ok("用戶在台北:13:50,兩語同一套(canon:24 小時制,en 不寫 1:50 PM)", L.limitWhen("1:50pm", "Asia/Taipei", NOW, "zh", "Asia/Taipei") === "13:50" && L.limitWhen("1:50pm", "Asia/Taipei", NOW, "en", "Asia/Taipei") === "13:50",
  [L.limitWhen("1:50pm", "Asia/Taipei", NOW, "zh", "Asia/Taipei"), L.limitWhen("1:50pm", "Asia/Taipei", NOW, "en", "Asia/Taipei")]);
ok("用戶在紐約:同一個時刻換成他的時區(01:50),不是照抄引擎的 1:50pm", L.limitWhen("1:50pm", "Asia/Taipei", NOW, "zh", "America/New_York") === "01:50" && L.limitWhen("1:50pm", "Asia/Taipei", NOW, "en", "America/New_York") === "01:50",
  L.limitWhen("1:50pm", "Asia/Taipei", NOW, "zh", "America/New_York"));
ok("今天這個時刻已經過了 → 明天,帶日期", L.limitWhen("9am", "Asia/Taipei", NOW, "zh", "Asia/Taipei") === "09/29 09:00" && L.limitWhen("9am", "Asia/Taipei", NOW, "en", "Asia/Taipei") === "09/29 09:00",
  [L.limitWhen("9am", "Asia/Taipei", NOW, "zh", "Asia/Taipei"), L.limitWhen("9am", "Asia/Taipei", NOW, "en", "Asia/Taipei")]);
ok("引擎給了月日(週額度):照那一天", L.limitWhen("Oct 3, 9am", "Asia/Taipei", NOW, "zh", "Asia/Taipei") === "10/03 09:00" && L.limitWhen("Oct 3 at 9:30am", "Asia/Taipei", NOW, "en", "Asia/Taipei") === "10/03 09:30",
  [L.limitWhen("Oct 3, 9am", "Asia/Taipei", NOW, "zh", "Asia/Taipei"), L.limitWhen("Oct 3 at 9:30am", "Asia/Taipei", NOW, "en", "Asia/Taipei")]);
ok("12am / 12pm", L.limitWhen("12am", "Asia/Taipei", NOW, "zh", "Asia/Taipei") === "09/29 00:00" && L.limitWhen("12pm", "Asia/Taipei", Date.parse("2026-09-28T01:00:00Z"), "zh", "Asia/Taipei") === "12:00",
  [L.limitWhen("12am", "Asia/Taipei", NOW, "zh", "Asia/Taipei"), L.limitWhen("12pm", "Asia/Taipei", Date.parse("2026-09-28T01:00:00Z"), "zh", "Asia/Taipei")]);
ok("寫法只有兩種:HH:mm 與 MM/DD HH:mm(補零);沒有 AM / PM、沒有月份名", ["1:50pm", "9am", "Oct 3, 9am", "12am", "Dec 31 at 11:59pm"].every((w) => ["zh", "en"].every((l) => /^(\d{2}\/\d{2} )?\d{2}:\d{2}$/.test(L.limitWhen(w, "Asia/Taipei", NOW, l, "Asia/Taipei")))));
ok("引擎沒標時區:當成這台電腦的時區(不丟例外)", typeof L.limitWhen("11:05pm", "", NOW, "zh") === "string" && L.limitWhen("11:05pm", "", NOW, "zh") !== "");
ok("讀不懂的時間、不認得的時區 → 空字串(那一句不寫時間,不猜)", ["in 2 hours", "soon", "25:00pm", "13pm", "Foo 3, 9am", ""].every((w) => L.limitWhen(w, "Asia/Taipei", NOW, "zh", "Asia/Taipei") === "") && L.limitWhen("1:50pm", "Mars/Olympus", NOW, "zh", "Asia/Taipei") === "");

// ---- 3. 緊接著的那句通用錯誤
ok("沒跑起來的兩種一律吞;「中途斷了」只在沒做過會改東西的步驟時吞;步數上限、認不得的代號照出", L.limitSwallow("not_started", false) && L.limitSwallow("not_started_upstream", true) && L.limitSwallow("partial", false)
  && !L.limitSwallow("partial", true) && !L.limitSwallow("max_turns", false) && !L.limitSwallow(undefined, false));
ok("只讀的步驟是一張表:搜尋、讀網頁、讀檔、抓資料、查帳戶在內;下單、改檔、寫策略、排程、操作網頁、跑回測、認不出來的都不在", ["search", "web_read", "file_read", "data", "account", "status"].every((k) => L.LIMIT_READONLY.includes(k))
  && ["order", "file_write", "strategy_write", "schedule", "web_act", "backtest", "scan", "report", "install", "cloud", "live_tick", "unknown"].every((k) => !L.LIMIT_READONLY.includes(k)));

// ---- 4. 接線與字串
ok("classifyFault 先認用量上限;卡上的鈕開「設定 › 模型接入」", /function classifyFault\(text\) \{\n  const lim = limitMatch\(text, cur\);/.test(src) && /act: \(\) => setOpen\(\)\.then\(\(\) => setCat\("model"\)\) \};/.test(src)
  && /text: when \? t\("fault\.limit", \{ name, when \}\) : t\("fault\.limitNoTime", \{ name \}\)/.test(src));
ok("畫了上限卡就記下(turnLimit);會改東西的步驟在工具開跑時記(turnChanged);回合開始兩個都歸零", /turnLimit = !!f\.limit; addFault\(f\);/.test(src)
  && /if \(c\.status !== "done" && LIMIT_READONLY\.indexOf\(actKindOf\(c\)\.kind\) < 0\) turnChanged = true;/.test(src) && /faultShown = false; turnLimit = false; turnChanged = false; pendingErr = \[\];/.test(src));
ok("error chunk:上限卡之後的通用句照 limitSwallow 吞", /if \(turnLimit && limitSwallow\(c\.code, turnChanged\)\) return;/.test(src));
const keys = ["fault.limit", "fault.limitNoTime", "fault.limitBtn"];
ok("字串 zh / en 都在;帶引擎名與重置時間的位置;講出口(設定 › 模型接入)", keys.every((k) => STR.zh[k] && STR.en[k]) && /\{name\}/.test(STR.zh["fault.limit"]) && /\{when\}/.test(STR.zh["fault.limit"]) && /\{when\}/.test(STR.en["fault.limit"])
  && !/\{when\}/.test(STR.zh["fault.limitNoTime"]) && keys.slice(0, 2).every((k) => STR.zh[k].includes("› " + STR.zh["set.cat.model"] + "」") && STR.en[k].includes("› " + STR.en["set.cat.model"])));
// 「模型接入」那一頁自己的用詞是 AI;engine 在這個 app 裡已經指下單引擎(設計師定稿)
ok("上限卡三句講「AI」,不講「引擎 / engine」;鈕是「切換 AI」/ Switch AI", keys.every((k) => !/引擎/.test(STR.zh[k]) && !/engine/i.test(STR.en[k])) && STR.zh["fault.limitBtn"] === "切換 AI" && STR.en["fault.limitBtn"] === "Switch AI"
  && STR.zh["fault.limit"] === "你的 {name} 訂閱用量到上限了，{when} 重置。在那之前可以到「設定 › 模型接入」換別的 AI 繼續。" && STR.en["fault.limit"] === "Your {name} subscription has reached its usage limit. It resets at {when}. Until then, switch to another AI in Settings › Model access."
  && STR.zh["fault.limitNoTime"] === "你的 {name} 訂閱用量到上限了。重置之前可以到「設定 › 模型接入」換別的 AI 繼續。" && STR.en["fault.limitNoTime"] === "Your {name} subscription has reached its usage limit. Until it resets, switch to another AI in Settings › Model access.");
ok("對外文案不寫死別家的方案名稱或價格", keys.every((k) => !/\b(Pro|Max|Plus|Team|Free)\b|[$＄]|\d+\s*(美元|元|USD)/.test(STR.zh[k] + " " + STR.en[k])));
ok("不說「只做完一部分」:上限那兩句裡沒有這種話", !/一部分|partly|midway/.test(STR.zh["fault.limit"] + STR.zh["fault.limitNoTime"] + STR.en["fault.limit"] + STR.en["fault.limitNoTime"]));
console.log(red ? `\n${red} FAILED` : "\nALL PASS"); process.exit(red ? 1 : 0);
