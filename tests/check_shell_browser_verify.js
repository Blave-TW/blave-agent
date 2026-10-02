// 搜尋被要求機器人驗證 → 交給用戶本人按(Wei 2026-09-28「先做 A」;設計師規格 designer-spec-search-verify)。
// 紅線:外殼與 agent 都不解驗證、不對驗證頁做任何操作。做的只有「認出來 → 交給用戶 → 等它離開」。
//   ① 判別表(網址與頁面標記)、等待的那一段(逾時 120 秒、動手後再 120 秒、出口、交還、人不在、呼叫期限)、搜尋之間的間隔:純邏輯,假時鐘
//   ② 原文鎖:等待那一段不碰頁面;agent 的每一支工具都經 tabFor(或自己擋);不改 user-agent;驗證頁不拍縮圖
//   ③ 真 Electron(隱藏視窗)+ 本機假的驗證頁:列舉每一支會碰頁面的工具 → needs_user_verification;頁面沒被碰;
//      用戶過了 → 同一次呼叫自動接著回結果、不用按交還;按出口 → 退到下一個引擎;這一輪拒絕過就不再問;人不在就不問
// 絕不連真的搜尋引擎:頁面全部由測試行程自己的本機代理供應。
// 跑法:node tests/check_shell_browser_verify.js(③ 要 BLAVE_TEST_WINDOW=1)
const path = require("path"), fs = require("fs"), os = require("os");
const SHELL = path.join(__dirname, "..", "shell");
const GATE = require("./_electron_gate");
const VF = require(path.join(SHELL, "browser", "verify.js"));
let red = 0, last = null; const t = (n, ok, d) => { console.log((ok ? "PASS  " : "FAIL  ") + n + (ok ? "" : "  " + JSON.stringify(d === undefined ? last : d).slice(0, 600))); if (!ok) red++; };

async function pure() {
  // ---- ① 判別表
  t("驗證頁認得出來:Google /sorry/(含子網域、各國網域);一般搜尋頁、別的網站不是",
    VF.verifyPage("https://www.google.com/sorry/index?continue=https://www.google.com/search%3Fq%3Dx") === "google" && VF.verifyPage("https://www.google.com.tw/sorry/") === "google"
    && VF.verifyPage("https://duckduckgo.com/anomaly.js?x=1") === "ddg"
    && !VF.verifyPage("https://www.google.com/search?q=sorry") && !VF.verifyPage("https://example.com/sorry/index") && !VF.verifyPage("javascript:alert(1)") && !VF.verifyPage(""));
  t("搜尋頁的認定:驗證頁不算搜尋頁;引擎要對", VF.searchPage("https://www.google.com/search?q=x", "google") && !VF.searchPage("https://www.google.com/sorry/index", "google")
    && !VF.searchPage("https://www.google.com/search?q=x", "ddg") && VF.searchPage("https://html.duckduckgo.com/html/?q=x", "ddg") && !VF.searchPage("https://example.com/search", "google"));
  // 稽核 P2-4:主機名字尾要整個對上
  const G_YES = ["google.com", "www.google.com", "www.google.com.tw", "www.google.co.jp", "www.google.co.uk", "www.google.de", "google.fr", "ipv4.google.com", "www.google.com.hk"];
  const G_NO = ["google.evil.com", "google.com.evil.io", "www.google.com.evil.io", "google.co.evil.net", "evilgoogle.com", "google.com.attacker", "google.evil", "google.comx", "notgoogle.de",
    "google.example.co.uk", "googleusercontent.com", "google.com.tw.evil.tw"];
  t("Google 的主機名:google.com、各國網域與子網域才算;把 google 放在前面的別人的網域不算",
    G_YES.every((h) => VF.engineOf("https://" + h + "/search?q=x") === "google" && VF.verifyPage("https://" + h + "/sorry/index") === "google" && VF.searchPage("https://" + h + "/search?q=x", "google"))
    && G_NO.every((h) => VF.engineOf("https://" + h + "/search?q=x") === null && VF.verifyPage("https://" + h + "/sorry/index") === null && !VF.searchPage("https://" + h + "/search?q=x", "google")),
    G_YES.filter((h) => VF.engineOf("https://" + h + "/") !== "google").concat(G_NO.filter((h) => VF.engineOf("https://" + h + "/") !== null)));
  t("DuckDuckGo 的主機名同樣要字尾整個對上", VF.engineOf("https://html.duckduckgo.com/html/?q=x") === "ddg" && VF.engineOf("https://duckduckgo.com.evil.io/") === null && VF.engineOf("https://evilduckduckgo.com/") === null);
  { const P = require(path.join(SHELL, "browser", "policy.js")), long = "x".repeat(400);
    t("外送檢查的搜尋引擎例外用同一條:冒牌的 google 網域帶長參數照樣要確認", String(P.GOOGLE_HOST) === String(VF.GOOGLE_HOST) && P.exfilRisk("https://www.google.com/search?q=" + long, new Set(), "") === null
      && !!P.exfilRisk("https://google.evil.com/search?q=" + long, new Set(), "") && !!P.exfilRisk("https://google.com.evil.io/search?q=" + long, new Set(), ""),
      [P.exfilRisk("https://www.google.com/search?q=" + long, new Set(), ""), P.exfilRisk("https://google.evil.com/search?q=" + long, new Set(), "")]); }
  const m = VF.marks("google");
  t("頁面標記是一張表(字串,送得進頁面):網址、標記、字、排除條件", typeof m.path === "string" && new RegExp(m.path).test("/sorry/index") && m.marks.includes("recaptcha") && /異常流量/.test(m.text) && m.unless === "#rso a h3"
    && VF.marks("ddg").unless === ".result__a");
  t("退路順序:Google → DuckDuckGo → 沒有了", VF.nextEngine("google") === "ddg" && VF.nextEngine("ddg") === null);
  t("常數:沒人理 120 秒、動手後再 120 秒、呼叫期限 270 秒(低於引擎端的工具逾時)、搜尋間隔 ≥ 3 秒",
    VF.VERIFY_WAIT_MS === 120000 && VF.VERIFY_TOUCHED_MS === 120000 && VF.SEARCH_CALL_MAX_MS === 270000 && VF.SEARCH_GAP_MS >= 3000);
  const codex = fs.readFileSync(path.join(__dirname, "..", "runtime", "codex_engine.py"), "utf8");
  const sec = Number((/mcp_servers\.blave_browser\.tool_timeout_sec=(\d+)/.exec(codex) || [])[1]);
  t("Codex 那一端的工具逾時高於呼叫期限(不然等到一半呼叫先斷)", sec * 1000 > VF.SEARCH_CALL_MAX_MS, sec);

  // ---- ① 等待(假時鐘)
  const run = async (o) => {
    let now = 1000000; const calls = { left: 0 };
    const d = Object.assign({ now: () => now, sleep: async (ms) => { now += ms; if (o.tick) o.tick(now - 1000000); }, alive: () => true, present: () => true, choice: () => null, touchedAt: () => 0, left: async () => { calls.left++; return false; } }, o.d(() => now - 1000000, () => now));
    const got = await VF.waitVerify(d);
    return { got, ms: now - 1000000 };
  };
  let r = await run({ d: () => ({}) });
  t("沒人理:120 秒逾時", r.got === "timeout" && r.ms >= 120000 && r.ms < 121000, r);
  r = await run({ d: (el) => ({ left: async () => el() >= 30000 }) });
  t("分頁離開驗證頁 → passed(不用按任何東西)", r.got === "passed" && r.ms >= 30000 && r.ms < 31000, r);
  r = await run({ d: (el, abs) => ({ touchedAt: () => (el() >= 100000 ? abs() - (el() - 100000) : 0) }) });
  t("用戶第 100 秒動手 → 從動手起再給 120 秒(第 220 秒才逾時)", r.got === "timeout" && r.ms >= 220000 && r.ms < 221000, r);
  r = await run({ d: (el, abs) => ({ touchedAt: () => (el() >= 119000 ? abs() - (el() - 119000) : 0) }) });
  t("最晚第 119 秒動手 → 總共不超過 240 秒", r.got === "timeout" && r.ms >= 239000 && r.ms <= 240000, r);
  r = await run({ d: (el) => ({ choice: () => (el() >= 5000 ? "ddg" : null) }) });
  const r2 = await run({ d: (el) => ({ choice: () => (el() >= 5000 ? "skip" : null) }) });
  t("按了出口(改用 DuckDuckGo / 這次不搜尋)→ exit", r.got === "exit" && r2.got === "exit" && r.ms < 6000, [r, r2]);
  r = await run({ d: (el) => ({ choice: () => (el() >= 5000 ? "done" : null) }) });
  t("按了「交還 agent」但還在驗證頁 → gave_up(不再問第二次);沒在換頁的只多等 1 秒", r.got === "gave_up" && r.ms >= 5000 && r.ms <= 6500, r);
  // 稽核 P2-6:按下去的當下頁面正在導回搜尋結果
  r = await run({ d: (el) => ({ choice: () => (el() >= 5000 ? "done" : null), loading: () => el() >= 4800 && el() < 7000, left: async () => el() >= 7000 }) });
  t("按「交還 agent」時頁面還在換頁(2 秒後載完,已經在搜尋結果上)→ 等它落定 → passed", r.got === "passed" && r.ms >= 7000 && r.ms < 7600, r);
  r = await run({ d: (el) => ({ choice: () => (el() >= 5000 ? "done" : null), loading: () => el() >= 5500 && el() < 6500, left: async () => el() >= 6500 }) });
  t("按下去之後半秒才開始換頁 → 照樣等到落定 → passed", r.got === "passed" && r.ms >= 6500 && r.ms < 7100, r);
  r = await run({ d: (el) => ({ choice: () => (el() >= 5000 ? "done" : null), loading: () => el() >= 4800 && el() < 7000 }) });
  t("換頁落定之後還在驗證頁 → gave_up", r.got === "gave_up" && r.ms >= 7000 && r.ms < 7600, r);
  r = await run({ d: (el) => ({ choice: () => (el() >= 5000 ? "done" : null), loading: () => true }) });
  t("一直載不完:等有上限(" + VF.HANDBACK_SETTLE_MS / 1000 + " 秒)→ gave_up", r.got === "gave_up" && VF.HANDBACK_SETTLE_MS === 8000 && r.ms >= 13000 && r.ms <= 13500, r);
  r = await run({ d: (el, abs) => ({ deadline: abs() + 7000, choice: () => (el() >= 5000 ? "done" : null), loading: () => true }) });
  t("等換頁也不超過這次呼叫的期限", r.got === "gave_up" && r.ms >= 7000 && r.ms <= 7500, r);
  r = await run({ d: (el) => ({ choice: () => (el() >= 5000 ? "done" : null), loading: () => true, alive: () => el() < 6000 }) });
  t("等換頁的時候分頁被關 → closed", r.got === "closed", r);
  r = await run({ d: (el) => ({ choice: () => (el() >= 5000 ? "done" : null), left: async () => el() >= 5000 }) });
  t("按了「交還 agent」而且已經離開驗證頁 → passed", r.got === "passed", r);
  // 同一次導覽稍早判過「還沒過」(頁面還沒長好),之後不再換頁:按交還要重判,不能當成放棄(改去 DuckDuckGo 重搜)
  { const forced = []; r = await run({ d: (el) => ({ choice: () => (el() >= 5000 ? "done" : null), left: async (f) => { forced.push([el(), !!f]); return !!f && el() >= 5000; } }) });
    t("按了「交還 agent」→ 重判(left 帶 force)→ 已經過了就 passed,不是 gave_up", r.got === "passed" && r.ms < 5500, r);
    t("還沒按之前的輪詢不帶 force(一次導覽只判一次,不每 250ms 跑一次判別)", forced.filter(([ms]) => ms < 5000).length > 10 && forced.filter(([ms]) => ms < 5000).every(([, f]) => !f), forced.slice(0, 3)); }
  r = await run({ d: (el) => ({ present: () => el() < 10000 }) });
  t("等到一半視窗縮到 Dock → absent", r.got === "absent" && r.ms >= 10000 && r.ms < 11000, r);
  r = await run({ d: (el) => ({ alive: () => el() < 3000 }) });
  t("分頁被關 / 回合結束 → closed", r.got === "closed", r);
  r = await run({ d: (el, abs) => ({ deadline: abs() + 40000, touchedAt: () => abs() }) });
  t("這次呼叫的期限先到 → timeout(不等到呼叫本身被引擎切斷)", r.got === "timeout" && r.ms >= 40000 && r.ms < 41000, r);
  t("等待結果 → search_unavailable 的原因", VF.reasonOf("exit") === "user_skipped" && VF.reasonOf("gave_up") === "user_skipped" && VF.reasonOf("timeout") === "timeout" && VF.reasonOf("absent") === "no_user" && VF.reasonOf("declined") === "captcha");
  const u = VF.unavailable("timeout"), f = VF.unavailable("failed"), x = VF.unavailable("nonsense");
  t("search_unavailable 的訊息:講原因、驗證類的叫它不要再搜、改開已知網址、回覆第一句要講沒搜到", u.reason === "timeout" && /robot check/.test(u.message) && /Do not search again to get around the check/.test(u.message)
    && /Open known addresses/.test(u.message) && /first sentence of your reply/.test(u.message) && !/Do not search again/.test(f.message) && x.reason === "failed");

  // ---- ① 搜尋之間的間隔
  { let now = 0; const log = [];
    const g = VF.createGate({ now: () => now, sleep: async (ms) => { log.push("sleep " + ms); now += ms; }, gapMs: 4000 });
    let running = 0, maxRunning = 0;
    const job = (name, ms) => g.run(async () => { running++; maxRunning = Math.max(maxRunning, running); log.push(name + " start " + now); now += ms; await Promise.resolve(); running--; log.push(name + " end " + now); return name; });
    const out = await Promise.all([job("a", 1000), job("b", 500), job("c", 200)]);
    t("連發三次搜尋:一個一個來(不平行)、前一次結束到下一次開始至少隔 4 秒", out.join() === "a,b,c" && maxRunning === 1
      && log.join("|") === "a start 0|a end 1000|sleep 4000|b start 5000|b end 5500|sleep 4000|c start 9500|c end 9700", log);
    const bad = g.run(async () => { throw new Error("x"); }).catch(() => "threw"), after = g.run(async () => "ok");
    t("前一次拋例外不會卡住後面的", (await bad) === "threw" && (await after) === "ok"); }

  // ---- ② 原文鎖
  const idx = fs.readFileSync(path.join(SHELL, "browser", "index.js"), "utf8"), vsrc = fs.readFileSync(path.join(SHELL, "browser", "verify.js"), "utf8");
  const cut = (src, head) => { const i = src.indexOf(head); if (i < 0) throw new Error("找不到 " + head); let d = 0; for (let k = src.indexOf("{", src.indexOf(")", i)); k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}" && --d === 0) return src.slice(i, k + 1); } throw new Error("切不出 " + head); };
  const hand = cut(idx, "async function handVerify(");
  const touches = (hand.match(/\.page\.\w+|\.wc\.\w+|IP\.\w+|executeJavaScript|sendInputEvent|insertText|loadURL|debugger/g) || []).sort();
  t("交接那一段對頁面只做兩件事:看網址(wc.getURL)、離開之後跑一次只讀的判別(page.serp);沒有點、填、按鍵、腳本、導覽", JSON.stringify(touches) === JSON.stringify([".page.serp", ".wc.getURL"]), touches);
  t("等換頁看的是主行程自己的載入狀態,不問頁面", /loading: \(\) => t\.status === "loading",/.test(hand));
  t("只讀的判別排在「導覽走了、載完了、網址是搜尋頁」之後", /left: async \(force\) => \{\s*if \(\(v\.navs === seen && !force\) \|\| t\.status === "loading"\) return false;\s*seen = v\.navs;\s*if \(!VF\.searchPage\(v\.wc\.getURL\(\), engine, engines\)\) return false;\s*try \{ const r = await v\.page\.serp\(engine, vf\);/.test(hand));
  t("verify.js 是純邏輯:不 require electron、不碰頁面", !/require\(["']electron["']\)/.test(vsrc) && !/executeJavaScript|sendInputEvent|webContents/.test(vsrc));
  const all = fs.readdirSync(path.join(SHELL, "browser")).map((f) => fs.readFileSync(path.join(SHELL, "browser", f), "utf8")).join("\n");
  t("不為了躲偵測改 user-agent / 指紋:整個 shell/browser 沒有 setUserAgent、userAgent 覆寫、解題服務", !/setUserAgent|userAgentFallback|Network\.setUserAgentOverride|2captcha|anti-?captcha|capsolver/i.test(all));
  t("驗證頁不拍縮圖:搜尋分頁整個不拍(認出來之前也拍不到)", /const shootable = \(t\) => !!t && t\.by === "agent" && !t\.userControl && !t\.searchTab && !t\.verify;/.test(idx) && /let t = r\.tab; t\.searchTab = true;/.test(idx) && /t = r2\.tab; t\.searchTab = true;/.test(idx));
  // agent 的工具:帶 tab 參數的每一支,在 call() 裡都要先過 tabFor(或自己先問 verifying)
  const { TOOLS } = require(path.join(SHELL, "browser", "tools.js"));
  const callSrc = cut(idx, "async function call(");
  const withTab = TOOLS.filter((x) => x.inputSchema.properties.tab).map((x) => x.name);
  const gated = callSrc.slice(callSrc.indexOf("const x = tabFor(args.tab); if (x.e) return x.e;\n    const { t, v } = x;"));
  const own = { browser_open: /if \(args\.tab\) \{\s*const x = tabFor\(args\.tab\); if \(x\.e\) return x\.e;/, browser_close: /if \(name === "browser_close"\) \{[^\n]*if \(verifying\(t\)\) return ERR\("needs_user_verification"/, browser_wait: /if \(!v \|\| policy\.agent\(v\.wc\.getURL\(\)\) \|\| verifying\(t\)\) return true;/ };
  const miss = withTab.filter((n) => (own[n] ? !own[n].test(n === "browser_wait" ? idx : callSrc) : !gated.includes('"' + n + '"')));
  t("列舉:帶 tab 的 " + withTab.length + " 支工具每一支都有擋(tabFor 在驗證頁回 needs_user_verification)", withTab.length >= 14 && miss.length === 0 && /if \(verifying\(t\)\) return \{ e: ERR\("needs_user_verification"/.test(cut(idx, "function tabFor(")), miss);
  t("browser_tabs 對驗證頁只回主機名、不回標題", /const hide = t\.userControl \|\| !!policy\.agent\(url\) \|\| verifying\(t\);/.test(idx));
  // 畫面
  const br = fs.readFileSync(path.join(SHELL, "renderer", "browser.js"), "utf8"), css = fs.readFileSync(path.join(SHELL, "renderer", "browser.css"), "utf8");
  const F = (name) => new Function("BR", "brTab", "brBlockNew", "brAppend", "brObserve", "brAddRow", "scrollChat", "brPaintHead", cut(br, "function " + name + "(") + "; return " + name + ";");
  const can = F("brCanOpenExt")();
  t("驗證頁不提供「用系統瀏覽器開」(在外面過驗證對內建瀏覽器沒有用)", !can({ url: "https://www.google.com/sorry/index", need: { kind: "captcha" } }) && !can({ url: "https://www.google.com/sorry/index", verify: true }) && can({ url: "https://a.test/" }));
  { const tabs = new Map([["s", { id: "s", search: true, need: { kind: "captcha" }, user: true }], ["p", { id: "p", need: { kind: "login" }, user: true }]]);
    const needs = (ids) => new Function("BR", cut(br, "function brNeedsUser(") + "; return brNeedsUser();")({ cur: { live: true, ids }, tabs });
    t("狀態列「等你操作」:搜尋驗證這一種,用戶動手之後仍然算在等;其他種類接手後照舊不算", needs(["s"]) === true && needs(["p"]) === false); }
  t("請求卡:說明句帶搜尋引擎的名字;出口鈕的字與送出的選擇跟著引擎走(Google → 改用 DuckDuckGo / ddg;DuckDuckGo → 這次不搜尋 / skip)",
    /captcha: t\("br\.ask\.captcha\.p", \{ engine: sum \|\| "Google" \}\)/.test(br) && /t\(k !== "captcha" \? "br\.ask\.skip" : lastEngine \? "br\.ask\.noSearch" : "br\.ask\.ddg"\)/.test(br)
    && /browserUserDone\(x\.id, k === "captcha" && !lastEngine \? "ddg" : "skip"\)/.test(br));
  t("聊天欄:等驗證的搜尋分頁進清單當一列 need,結束就離開;回合結束不留在摘要裡;只有這一列時不畫卡頭", /if \(x\.need\.kind === "captcha"\) brVerifyRow\(id, true\);/.test(br) && /case "need_clear": x\.need = null; brVerifyRow\(id, false\);/.test(br)
    && /case "handback": x\.user = false; x\.need = null; brVerifyRow\(id, false\);/.test(br) && /b\.ids\.slice\(\)\.forEach\(\(id\) => brVerifyRow\(id, false\)\);/.test(br)
    && css.includes(".bblk.only-need .bblk-head { display: none; }") && /b\.el\.classList\.toggle\("only-need", brOnlyVerify\(b\)\);/.test(br));
  { const noThumb = new Function(cut(br, "function brNoThumb(") + "; return brNoThumb;")();
    t("縮圖欄:進行中的卡只有驗證那一列 → 收掉;有別的頁 → 照舊留著(圖馬上會來)", noThumb(true, [undefined], true) === true && noThumb(true, [undefined, undefined], false) === false && noThumb(false, [undefined], false) === true && noThumb(false, ["x"], false) === false); }
  // 字串
  const S = new Function(fs.readFileSync(path.join(SHELL, "renderer", "strings.js"), "utf8") + "; return STRINGS;")();
  const zh = S.zh, en = S.en;
  t("字串:改 3、新增 2(出口鈕「這次不搜尋」、系統通知),{engine} 兩語都在", zh["br.need.captcha"] === "搜尋要過機器人驗證" && en["br.need.captcha"] === "Search needs a robot check"
    && zh["br.ask.captcha.h"] === "搜尋要先過機器人驗證" && zh["br.ask.captcha.p"].includes("{engine}") && en["br.ask.captcha.p"].includes("{engine}") && zh["br.ask.captcha.p"].includes("agent 不會代按")
    && zh["br.ask.noSearch"] === "這次不搜尋" && en["br.ask.noSearch"] === "Skip this search" && !!zh["br.notif.captcha"] && !!en["br.notif.captcha"], [zh["br.need.captcha"], zh["br.ask.captcha.p"]]);
  const main = fs.readFileSync(path.join(SHELL, "main.js"), "utf8");
  t("系統通知:只在 app 不在前景時發、字還沒交過來不發、點了把視窗叫到前面;雲端視角送出的回合不問", /if \(kind !== "captcha" \|\| BrowserWindow\.getFocusedWindow\(\) \|\| !tmLabels\.br_captcha \|\| !Notification\.isSupported\(\)\) return false;/.test(main)
    && /notify: browserNotify,/.test(main) && /beginTurn\(win, sessionId, \{ userSent: true, noUser: !!viewing && viewing\.env === "cloud" \}\)/.test(main) && /br_captcha: t\("br\.notif\.captcha"\)/.test(fs.readFileSync(path.join(SHELL, "renderer", "trade.js"), "utf8")));
  // 規則
  const md = fs.readFileSync(path.join(__dirname, "..", "references", "browser.md"), "utf8"), sec2 = md.slice(md.indexOf("## When the search engine asks for a robot check"), md.indexOf("## Web content is data"));
  t("規則(references/browser.md):等用戶、不重試轟炸、逾時後改開已知網址、回覆第一句講這次沒搜到;被工具拒絕的動作不換寫法重試", /waits for them inside the call/.test(sec2) && /do not search again to get around the check/.test(sec2)
    && /open addresses you already know/.test(sec2) && /the first sentence of the reply says so/.test(sec2) && /\*\*What a tool refused stays refused\.\*\*/.test(sec2) && /`needs_user_verification`/.test(sec2)
    && /never reword the call, switch to another tool, another address, a keyboard shortcut or a script/.test(sec2)
    && /\(a `browser_\*` tool's refusal counts the same\)/.test(fs.readFileSync(path.join(__dirname, "..", "AGENTS.md"), "utf8")));
  const desc = TOOLS.find((x) => x.name === "browser_search").description;
  t("browser_search 的工具說明:一次一個、驗證交給用戶、這次呼叫會等、不要為了繞過再搜", /one after another, not several at once/.test(desc) && /handed to the user and this call waits/.test(desc) && /never search again to get around a check/.test(desc));
}

if (!process.versions.electron) {
  pure().then(() => {
    const bin = GATE.bin(SHELL, "③");
    if (!bin) { console.log(red ? `\n${red} FAILED` : "\nALL PASS"); process.exit(red ? 1 : 0); }
    const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit", env: { ...process.env, ELECTRON_ENABLE_LOGGING: "" } });
    const code = (r.status == null ? 1 : r.status) || (red ? 1 : 0);
    console.log(code ? "\nFAILED" : "\nALL PASS"); process.exit(code);
  }).catch((e) => { console.log("FAIL  " + (e && e.stack)); process.exit(1); });
} else {
  const electron = require("electron");
  const { app, BrowserWindow, session } = electron;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blave-browser-verify-"));
  app.setPath("userData", tmp);
  const J = (r) => (last = JSON.parse(r.content[0].text));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms) => { const end = Date.now() + (ms || 8000); while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(100); } return null; };
  // 假的驗證頁:任何點擊、按鍵、輸入、腳本改標題都會留下記號
  const CHECK = (name) => `<!doctype html><html><head><title>${name} check</title></head><body><form id="captcha-form" action="/sorry/index" method="post">
<p>Our systems have detected unusual traffic.</p><input id="ans" name="ans"><button id="ok" type="submit">I'm not a robot</button></form>
<script>window.__touched=[];for (const e of ["click","mousedown","keydown","input","focusin","submit"]) document.addEventListener(e,(x)=>window.__touched.push(e+":"+(x.target&&x.target.id||"")),true);</script></body></html>`;
  const RESULTS = (q) => `<!doctype html><html><head><title>${q} - results</title></head><body><div id="rso">
<div><a href="http://news-a.test/one"><h3>First result for ${q}</h3></a><div>snippet one about it, long enough to count as a snippet text here</div></div>
<div><a href="http://news-b.test/two"><h3>Second result</h3></a><div>snippet two about it, long enough to count as a snippet text here</div></div></div></body></html>`;
  const DDG = (q) => `<!doctype html><html><head><title>${q} at ddg</title></head><body><div class="result"><a class="result__a" href="http://news-c.test/three">Third result</a><a class="result__snippet">snip</a></div></body></html>`;
  const hits = []; const S = { googleCheck: true, ddgCheck: false };
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ width: 1200, height: 800, show: false });
    await win.loadURL("data:text/html,<p>host</p>");
    const srv = require("http").createServer((req, res) => {
      const u = new URL(req.url, "http://" + req.headers.host); hits.push(req.method + " " + u.host + u.pathname);
      const html = (b) => { res.writeHead(200, { "content-type": "text/html" }); res.end(b); };
      if (u.host === "g.test" && u.pathname === "/search") { if (S.googleCheck) { res.writeHead(302, { location: "http://g.test/sorry/index?continue=" + encodeURIComponent(u.href) }); return res.end(); } return html(RESULTS(u.searchParams.get("q"))); }
      if (u.host === "g.test" && u.pathname.startsWith("/sorry")) return html(CHECK("G"));
      if (u.host === "d.test") return html(S.ddgCheck ? CHECK("D").replace('id="captcha-form"', 'id="challenge-form"') : DDG(u.searchParams.get("q")));
      return html("<title>page</title><p>" + "text ".repeat(80) + "</p>");
    });
    srv.on("connect", (req, sock) => { hits.push("CONNECT " + req.url); sock.destroy(); });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const ses = session.fromPartition("persist:agent-browser");
    await ses.setProxy({ proxyRules: "http=127.0.0.1:" + srv.address().port + ";https=127.0.0.1:" + srv.address().port, proxyBypassRules: "<-loopback>" });
    const sent = [], notes = []; let HERE = true;
    const realSend = win.webContents.send.bind(win.webContents);
    win.webContents.send = (ch, ev) => { if (ch === "browser-event") sent.push(ev); return realSend(ch, ev); };
    // 搜尋引擎表換成本機假頁面(判別規則照正式那一張的形狀)
    const engines = {
      google: { name: "Google", host: /^g\.test$/, search: /^\/search/, url: (q) => "http://g.test/search?q=" + encodeURIComponent(q), verify: VF.ENGINES.google.verify },
      ddg: { name: "DuckDuckGo", host: /^d\.test$/, search: /^\//, url: (q) => "http://d.test/html/?q=" + encodeURIComponent(q), verify: VF.ENGINES.ddg.verify },
    };
    const B = require(path.join(SHELL, "browser")).createBrowser({ electron, stateDir: path.join(tmp, "snaps"), reportsDir: path.join(tmp, "reports"), getWin: () => win, uiLang: () => "en", track: () => {}, version: "test",
      reducedMotion: () => true, engines, userPresent: () => HERE, notify: (k) => notes.push(k) });
    const ctx = { live: () => true };
    const call = (n, a) => B._call(n, a || {}, ctx);
    const pageOf = (frag) => electron.webContents.getAllWebContents().find((w) => w.session === ses && w.getURL().includes(frag));

    // ── 場景 A:驗證頁 → 交給用戶 → 用戶過了 → 同一次呼叫自動回結果
    await B.beginTurn(win, "desktop-verifytest1");
    const t0 = Date.now();
    const pending = call("browser_search", { query: "cpi today", count: 3 }).then(J);
    const need = await until(() => sent.find((e) => e.type === "need_user" && e.kind === "captcha"));
    t("A 搜尋落在驗證頁 → 發 need_user(captcha),帶搜尋引擎的名字;不直接回 search_unavailable", !!need && need.summary === "Google", sent.map((e) => e.type));
    t("A app 不在前景的系統通知交給主行程(這裡只驗有叫到)", notes.join() === "captcha", notes);
    const tab = B._tabs.thisTurn().find((x) => x.searchTab), alias = tab && tab.alias;
    t("A 那一格標成驗證中", !!tab && tab.verify === "google" && B._verifying(alias) === true, tab && tab.verify);
    const wc = pageOf("g.test/sorry");
    t("A 分頁真的停在假的驗證頁", !!wc && /\/sorry\/index/.test(wc.getURL()), wc && wc.getURL());
    // 列舉:每一支會碰頁面的工具
    const { TOOLS } = require(path.join(SHELL, "browser", "tools.js"));
    const ARGS = { browser_open: { url: "http://news-a.test/x", tab: alias }, browser_snapshot: { tab: alias }, browser_read: { tab: alias }, browser_get: { tab: alias, what: "text" }, browser_click: { tab: alias, ref: "@e1" },
      browser_fill: { tab: alias, ref: "@e1", text: "x" }, browser_type: { tab: alias, ref: "@e1", text: "x" }, browser_press: { tab: alias, key: "Enter" }, browser_scroll: { tab: alias, direction: "down" },
      browser_screenshot: { tab: alias }, browser_capture: { tab: alias, ref: "@e1", report: "r1" }, browser_back: { tab: alias }, browser_close: { tab: alias } };
    const touching = TOOLS.map((x) => x.name).filter((n) => TOOLS.find((x) => x.name === n).inputSchema.properties.tab && n !== "browser_wait");
    const refused = [];
    for (const n of touching) { if (!ARGS[n]) { refused.push(n + ":no-args-in-test"); continue; } const r = J(await call(n, ARGS[n])); if (r.ok !== false || r.error !== "needs_user_verification") refused.push(n + ":" + (r.error || "ok")); }
    t("A 列舉 " + touching.length + " 支會碰頁面的工具:每一支都回 needs_user_verification,理由寫給模型看", touching.length >= 13 && refused.length === 0 && /robot check/.test(last.message) && /user's to do/.test(last.message), refused);
    let r = J(await call("browser_wait", { tab: alias, until: "text", value: "unusual traffic", timeout_s: 2 }));
    t("A browser_wait until=text 不拿驗證頁的字來試探(立刻回,不讀頁面);browser_tabs 不回標題", r.ok === true && (() => { const x = J({ content: [{ text: JSON.stringify(r) }] }).tabs[0]; return x.title === "" && x.url === "g.test"; })(), r);
    r = J(await call("browser_open", { url: "http://g.test/sorry/index?continue=x" }));
    t("A agent 不能自己開驗證頁的網址", r.ok === false && r.error === "invalid_args", r);
    const before = sent.filter((e) => e.type === "thumb").length;
    B.setBlockVisible(true); await B._captureThumb(tab.id); await sleep(2600); B.setBlockVisible(false);
    t("A 驗證頁不拍縮圖(每 2 秒那一輪與補拍都沒有)", sent.filter((e) => e.type === "thumb" && e.id === tab.id).length === 0 && sent.filter((e) => e.type === "thumb").length === before);
    const touched = await wc.executeJavaScript("JSON.stringify([window.__touched, document.title, document.getElementById('ans').value])");
    t("A 頁面沒被碰:沒有點擊、按鍵、輸入、送出,標題與欄位都沒變", touched === JSON.stringify([[], "G check", ""]), touched);
    t("A 等待期間沒有重試轟炸:搜尋網址只打了一次、驗證頁只載了一次", hits.filter((h) => h === "GET g.test/search").length === 1 && hits.filter((h) => h.startsWith("GET g.test/sorry")).length === 1 && !hits.some((h) => h.startsWith("POST")), hits);
    let settled = false; pending.then(() => { settled = true; });
    await sleep(300);
    t("A 這次 browser_search 呼叫還在等(沒有先回)", settled === false);
    // 用戶接手、過了驗證(測試扮演用戶:伺服器放行,分頁被導回原本的搜尋網址)
    B.takeover(tab.id);
    S.googleCheck = false;
    await wc.loadURL("http://g.test/search?q=" + encodeURIComponent("cpi today"));
    const res = await Promise.race([pending, sleep(15000).then(() => null)]);
    t("A 分頁離開驗證頁 → 同一次呼叫自動回結果(不用按「交還 agent」)", !!res && res.ok === true && res.source === "google" && res.untrusted_content.results.length === 2 && res.untrusted_content.results[0].url === "http://news-a.test/one", res);
    t("A 自動交還:發 need_clear 與 handback,那一格不再是驗證中、也不再是用戶接手", sent.some((e) => e.type === "need_clear" && e.id === tab.id) && sent.some((e) => e.type === "handback" && e.id === tab.id && e.auto === true) && !tab.verify && !tab.userControl && !tab.need);
    t("A 結果沒有驗證頁的內容", !JSON.stringify(res).includes("unusual traffic") && !JSON.stringify(res).includes("not a robot"));
    console.log("      (A 等了 " + (Date.now() - t0) + " ms)");

    // ── 場景 B:用戶按出口 → 退到下一個引擎;這一輪不再問
    S.googleCheck = true; sent.length = 0; notes.length = 0;
    const p2 = call("browser_search", { query: "fed minutes" }).then(J);
    const need2 = await until(() => sent.find((e) => e.type === "need_user" && e.kind === "captcha"), 12000);
    t("B 過過驗證的那一輪再遇到 → 可以再問", !!need2);
    const tab2 = B._tabs.get(need2.id);
    B.userDone(tab2.id, "ddg");
    const res2 = await Promise.race([p2, sleep(15000).then(() => null)]);
    t("B 按了「改用 DuckDuckGo」→ 退到 DuckDuckGo 拿到結果;用戶沒在看的驗證頁收掉(不佔名額),agent 拿不到它", !!res2 && res2.ok === true && res2.source === "ddg" && res2.fallback_reason === "captcha" && tab2.status === "closed"
      && J(await call("browser_read", { tab: tab2.alias })).ok === false, res2);
    sent.length = 0;
    const live0 = B._tabs.liveCount();
    const res3 = J(await call("browser_search", { query: "third query" }));
    t("B 這一輪拒絕過 → 再遇到不再問(沒有 need_user),直接走退路;沒問的那張驗證頁不留著佔名額", res3.ok === true && res3.source === "ddg" && !sent.some((e) => e.type === "need_user") && B._tabs.liveCount() === live0 + 1, [res3, live0, B._tabs.liveCount()]);
    S.ddgCheck = true; sent.length = 0;
    const res4 = J(await call("browser_search", { query: "fourth query" }));
    t("B 退路也是驗證頁 → search_unavailable,帶原因,訊息叫它改開已知網址並在回覆講沒搜到", res4.ok === false && res4.error === "search_unavailable" && res4.reason === "captcha" && /Open known addresses/.test(res4.message) && !sent.some((e) => e.type === "need_user"), res4);
    B.endTurn();

    // ── 場景 C:人不在(視窗縮到 Dock / 雲端視角)→ 不問
    S.googleCheck = true; S.ddgCheck = true; sent.length = 0; notes.length = 0; HERE = false;
    await B.beginTurn(win, "desktop-verifytest2");
    const res5 = J(await call("browser_search", { query: "nobody home" }));
    t("C 視窗不在畫面上 → 不發 need_user、不發通知,照舊回 search_unavailable(原因 no_user)", res5.ok === false && res5.error === "search_unavailable" && res5.reason === "no_user", res5);
    t("C   (沒有問、沒有通知)", !sent.some((e) => e.type === "need_user") && notes.length === 0);
    B.endTurn();
    HERE = true; sent.length = 0;
    await B.beginTurn(win, "desktop-verifytest3", { noUser: true });
    const res6 = J(await call("browser_search", { query: "cloud view" }));
    t("C 從雲端視角送出的回合 → 一樣不問", res6.ok === false && res6.error === "search_unavailable" && !sent.some((e) => e.type === "need_user"), res6);
    B.endTurn();
    t("全程沒有連到任何真的搜尋引擎(https 一律經 CONNECT,被本機代理記下並拒絕)", !hits.some((h) => h.startsWith("CONNECT")), hits.filter((h) => h.startsWith("CONNECT")));
    srv.close(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* userData 還鎖著 */ }
    console.log(red ? `\n${red} FAILED` : "\nALL PASS(③)");
    app.exit(red ? 1 : 0);
  }).catch((e) => { console.log("FAIL  " + (e && e.stack) + "\n      last: " + JSON.stringify(last).slice(0, 500)); app.exit(1); });
}
