// 綁卡前 30 TWD AI 額度的外殼三處(0.1.22;spec desktop-precard-credit §5.2 / §5.4)。不打 api、不開 Electron。
//   登入送的額度事先不預告(不講有、不講多少),用完才由卡片叫他綁卡。
//   ① 連結畫面:偵測完本機都不能用、沒登入、公開價目有額度 → 大標／標題／副標換版(副標不帶數字);數字 0 或拿不到、已登入、有本機 AI、還在偵測 → 原字;換語言後再畫
//   ② 設定 › 帳號與方案:balance 照收 free_ai_credit_left(沒領過 null),但「AI 額度」那一列對誰都不出(已綁卡也不出)
//   ③ 用完的卡:NO_CARD + free_ai_credit_used_up → 預檢卡 / 402 卡換「額度用完了」那組字(不帶數字)、埋點 pre_free / turn_free(兩個事件同順序接在表尾);NO_CREDIT 照舊
// 跑法:node tests/check_shell_free_credit.js
const fs = require("fs"), path = require("path");
const SHELL = path.join(__dirname, "..", "shell");
const app = fs.readFileSync(path.join(SHELL, "renderer", "app.js"), "utf8");
const { EVENTS } = require(path.join(SHELL, "telemetry.js"));
const { interpret } = require(path.join(SHELL, "balance.js"));
const { en, zh } = new Function(fs.readFileSync(path.join(SHELL, "renderer", "strings.js"), "utf8") + "; return STRINGS;")();   // 產生檔沒有 module.exports(頁面用 <script> 載)
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };
const fn = (name) => { const i = app.indexOf("function " + name + "("); if (i < 0) throw new Error("找不到 " + name); let d = 0; for (let k = app.indexOf("{", app.indexOf(")", i)); k < app.length; k++) { if (app[k] === "{") d++; else if (app[k] === "}" && --d === 0) return app.slice(i, k + 1); } throw new Error("切不出 " + name); };
const line = (re) => { const m = app.match(re); if (!m) throw new Error("找不到 " + re); return m[0]; };

// ① 連結畫面:真的跑 cnFreeQ / cnFreeMode / cnFreePaint,DOM 換成三個假節點
{
  const els = { h4: {}, ttl: {}, meta: {} };
  const S = { pub: null, hasToken: false, lastDetect: null, localReady: false, lang: "zh" };
  const t = (k, v) => { let s = (S.lang === "zh" ? zh : en)[k] || k; if (v) for (const x in v) s = s.split("{" + x + "}").join(v[x]); return s; };
  const M = new Function("document", "t", "S", `let pub, hasToken, lastDetect, localReady;
    const sync = () => { pub = S.pub; hasToken = S.hasToken; lastDetect = S.lastDetect; localReady = S.localReady; };
    ${line(/^const cnFreeQ = .*$/m)}\n${fn("cnFreeMode")}\n${fn("cnFreePaint")}
    return { paint: () => { sync(); cnFreePaint(); }, mode: () => { sync(); return cnFreeMode(); } };`)(
    { querySelector: (sel) => (/h4$/.test(sel) ? els.h4 : /cn-ttl/.test(sel) ? els.ttl : els.meta) }, t, S);
  const shown = () => [els.h4.textContent, els.ttl.textContent, els.meta.textContent].join(" | ");
  const ORIG_ZH = "Blave 不內建 AI。 | 用 Blave AI | 首次綁卡送 100 TWD 的 AI 額度，之後按用量計費";
  S.pub = { trial: { days: 14 }, free_ai_credit: 30 }; S.lastDetect = { claude: {}, codex: {} }; M.paint();
  ok("① 偵測完都不能用、沒登入、有額度 → 大標「先用 Blave AI 開始」、標題「Blave AI」、副標只說登入就能用(不提額度與金額)",
    shown() === "先用 Blave AI 開始 | Blave AI | 登入就能直接開始用", shown());
  S.lang = "en"; M.paint();
  ok("① en 同一組", shown() === "Start with Blave AI | Blave AI | Sign in and start right away", shown());
  S.lang = "zh";
  S.lastDetect = null; M.paint(); ok("① 還在偵測(lastDetect null)→ 原字", shown() === ORIG_ZH, shown());
  S.lastDetect = {}; S.localReady = true; M.paint(); ok("① 本機有可用的 AI → 原字(那條路已經走得通)", shown() === ORIG_ZH, shown());
  S.localReady = false; S.hasToken = true; M.paint(); ok("① 已登入 → 原字(「登入就能用」對他不是新消息)", shown() === ORIG_ZH, shown());
  S.hasToken = false; S.pub = { trial: { days: 14 }, free_ai_credit: 0 }; M.paint(); ok("① 額度 0(停發)→ 原字", shown() === ORIG_ZH && M.mode() === false, shown());
  S.pub = { trial: { days: 14 } }; M.paint(); ok("① 舊 api 沒有 free_ai_credit → 原字", shown() === ORIG_ZH, shown());
  S.pub = null; M.paint(); ok("① 公開價目讀不到 → 原字", shown() === ORIG_ZH, shown());
  S.pub = { trial: { days: 14 }, free_ai_credit: "30" }; ok("① 數字是字串也認(Number);副標裡沒有數字", M.mode() === true && (S.pub.free_ai_credit = 1234, M.paint(), !/\d/.test(els.meta.textContent)), els.meta.textContent);
  ok("① 接線:paintBlaveBtn(偵測完、登入／登出)與 applyStatic(換語言,data-i18n 剛寫回原句)都重畫;公開價目讀回來也畫",
    /mdlPaint\(\);[^\n]*\n  cnFreePaint\(\);\n\}/.test(app) && /\[data-i18n-aria\][^\n]*\n  if \(typeof wdPaint === "function"\) wdPaint\(\); cnFreePaint\(\);/.test(app) && /pubLoad\(\)\.then\(\(\) => \{ acctPaintAcct\(\); cnFreePaint\(\); \}\);/.test(app));
  ok("① index.html 不動:三個節點仍掛原本的 data-i18n(換語言先寫回原句,再由 cnFreePaint 決定)", /data-i18n="cn\.h"/.test(fs.readFileSync(path.join(SHELL, "renderer", "index.html"), "utf8")) && !/cn\.h\.free|descFree/.test(fs.readFileSync(path.join(SHELL, "renderer", "index.html"), "utf8")));
  const mainSrc = fs.readFileSync(path.join(SHELL, "main.js"), "utf8");
  ok("① 主行程 publicPricing 帶 free_ai_credit(> 0 才是數字,其餘 null);renderer 不自己打 api", /free_ai_credit: n\(b\.free_ai_credit\)/.test(mainSrc) && !/"\/openclaw\/public_tiers"/.test(app));
}

// ② 餘額端點多接一個欄位;設定頁不畫
{
  const r = (b) => interpret({ status: 200, body: b });
  ok("② free_ai_credit_left:數字照收、null / 缺 / 字串 → null;balance 與 trial 不受影響",
    r({ balance: 0, trial_ai_credit_left: null, free_ai_credit_left: 12.4 }).free === 12.4 && r({ balance: 0, trial_ai_credit_left: 5, free_ai_credit_left: 0 }).free === 0
    && r({ balance: 1, trial_ai_credit_left: null, free_ai_credit_left: null }).free === null && r({ balance: 1, trial_ai_credit_left: null }).free === null && r({ balance: 1, free_ai_credit_left: "30" }).free === null
    && JSON.stringify(r({ balance: 7, trial_ai_credit_left: 3, free_ai_credit_left: 30 })) === '{"balance":7,"trial":3,"free":30}');
  (async () => {
    // 那一列對誰都不出(Wei 拍板 2B):畫它的唯一一處連同狀態一起拿掉——列舉 renderer 每個檔,沒有任何地方再讀這筆額度或用那個字串
    const R = path.join(SHELL, "renderer"), files = fs.readdirSync(R).filter((f) => /\.(js|html)$/.test(f) && f !== "strings.js");
    const hits = files.filter((f) => /plan\.free\b|balFree|\br\.free\b/.test(fs.readFileSync(path.join(R, f), "utf8")));
    ok("② 帳號與方案:「AI 額度」那一列任何狀態都不出——renderer 沒有一個檔再用 plan.free / balFree / balance 的 free(列舉 " + files.length + " 個檔)", files.length > 10 && hits.length === 0, hits);
    ok("② plan.free 兩個語言都已拿掉", !("plan.free" in zh) && !("plan.free" in en));
    const pp = fn("planPaint");
    ok("② 帳號列之後直接接 Blave 餘額列", /id\.append\(who, hint\);\n    if \(hasToken\) \{\n      const n = balNow\(\)/.test(pp));

    // ③ 用完的卡
    const kind = new Function("return (" + fn("acctCardKind") + ")")();
    const UP = { can_run: false, reason: "NO_CARD", free_ai_credit_used_up: true };
    ok("③ 埋點:NO_CARD + used_up → pre_free / turn_free;沒 used_up(或 false / 舊 api 沒欄位)照舊 pre_card / turn_card;NO_CREDIT 照舊(有卡沒餘額不是這組字)",
      kind("pre", UP) === "pre_free" && kind("turn", UP) === "turn_free" && kind("pre", { reason: "NO_CARD" }) === "pre_card" && kind("turn", { reason: "NO_CARD", free_ai_credit_used_up: false }) === "turn_card"
      && kind("pre", { reason: "NO_CREDIT", free_ai_credit_used_up: true }) === "pre_credit" && kind("turn", { reason: "NO_CREDIT", free_ai_credit_used_up: true }) === "turn_credit" && kind("pre", null) === "pre_card" && kind("turn", null) === "turn_credit");
    const WANT = ["pre_card", "pre_credit", "turn_card", "turn_credit", "pre_free", "turn_free"];
    ok("③ 白名單:acct_card_shown 與 acct_card_click 同一份、新值接在表尾、≤16 字", JSON.stringify(EVENTS.acct_card_shown.card) === JSON.stringify(WANT) && JSON.stringify(EVENTS.acct_card_click.card) === JSON.stringify(WANT) && WANT.every((v) => v.length <= 16));
    // 卡片的字:切 acctPaint 出來跑,只看 text
    const cards = [];
    const P = new Function("t", "acct", "acctCard", "creditCards", "cnFreeQ", "RP", "LANG", `let acctGone = null, dataCardSync = () => {}, mpBillPaint = undefined, planWatch = () => {}, libIdeaPaint = undefined, wdPaint = undefined, $ = () => null;
      const acctSub = () => null, acctAction = () => ({}), acctCrypto = () => null, resendSecond = () => null, resendState = (c, x) => ({ text: x }), acctShown = () => {}, acctBackTrack = () => {};
      ${fn("acctCardKind")}\n${fn("acctFreeUpText")}\n${fn("acctBuiltText")}\n${fn("acctPaint")}\nacctPaint();`);
    const mk = () => { const c = {}; c.set = (s) => { c.last = s; }; return c; };
    const run = (acct, q, n, lang) => { const pre = mk(), turn = mk(); P((k, v) => k + (v && v.q ? "{" + v.q + "}" : "") + (v && v.n ? "{" + v.n + "}" : ""), acct, pre, [turn], () => q, { list: Array(n || 0).fill({}) }, lang || "zh"); return [pre.last.text, turn.last.text].join(" / "); };
    ok("③ 用完、沒綁卡:預檢卡「acct.freeUpNoNum」、402 卡「fault.freeUpNoNum」——公開價目有數字也不帶(那筆額度事先沒預告)", run(UP, "30") === "acct.freeUpNoNum / fault.freeUpNoNum", run(UP, "30"));
    ok("③ 預檢卡先講建了幾支(spec-starters §1.7):1 支 acct.built1、N 支 acct.builtN{n};en 兩句間一個空格、zh 不留;0 支不加;402 卡不動",
      run(UP, "30", 1) === "acct.built1{1}acct.freeUpNoNum / fault.freeUpNoNum" && run(UP, "30", 3, "en") === "acct.builtN{3} acct.freeUpNoNum / fault.freeUpNoNum" && run(UP, "30", 0, "en") === "acct.freeUpNoNum / fault.freeUpNoNum"
      && run({ can_run: false, reason: "NO_CARD" }, "30", 3) === "acct.noCard / fault.needCard", [run(UP, "30", 1), run(UP, "30", 3, "en")].join(" | "));
    ok("③ 數字拿不到:同一組", run(UP, "") === "acct.freeUpNoNum / fault.freeUpNoNum", run(UP, ""));
    ok("③ 沒綁卡、沒用完(或舊 api):原字 acct.noCard / fault.needCard", run({ can_run: false, reason: "NO_CARD" }, "30") === "acct.noCard / fault.needCard");
    ok("③ 有卡沒餘額:原字,不管 used_up", run({ can_run: false, reason: "NO_CREDIT", free_ai_credit_used_up: true }, "30") === "acct.noCredit / fault.noCredit");
    ok("③ 能跑:原字(可以開始了 / 額度到了)", run({ can_run: true, free_ai_credit_used_up: true }, "30") === "acct.ready / acct.creditIn");
    ok("③ 鈕與小字不動:兩張卡仍走 acctAction(前往綁卡)+ acctSub;402 卡第二顆仍是「再送一次」(「改用自己的 AI」先不做)",
      /acctBuiltText\(RP\.list\.length\) \+ acctFreeUpText\("pre"\) : t\(s\.reason === "NO_CREDIT" \? "acct\.noCredit" : "acct\.noCard"\), sub: acctSub\(s\), \.\.\.acctAction\(s, "pre"\)/.test(app)
      && /acctFreeUpText\("turn"\) : t\("fault\.needCard"\), sub: acctSub\(s\), \.\.\.acctAction\(s, "turn"\), second: resendSecond\(\)/.test(app));
    // 字串:zh / en 都有、zh 逐字
    const KEYS = ["cn.h.free", "cn.blave.descFree", "acct.freeUpNoNum", "fault.freeUpNoNum"];
    ok("字串:四個 key zh / en 都有;帶數字的 acct.freeUp / fault.freeUp 已拿掉", KEYS.every((k) => zh[k] && en[k]) && ["acct.freeUp", "fault.freeUp"].every((k) => !(k in zh) && !(k in en)));
    ok("字串:zh 逐字(登入送的額度事先不預告、不寫夠跑幾輪;402 那句「沒有跑完」——進行中的請求放行、下一筆才擋)",
      zh["cn.h.free"] === "先用 Blave AI 開始" && zh["cn.blave.descFree"] === "登入就能直接開始用"
      && zh["acct.freeUpNoNum"] === "AI 額度用完了。" && zh["fault.freeUpNoNum"] === "AI 額度用完了，這一輪沒有跑完。"
      && KEYS.every((k) => !/夠跑|回測|幾輪/.test(zh[k]) && !/enough|backtest|\d+ turns/.test(en[k])));
    ok("字串:事先不預告——四句都不帶數字、{q} 或 TWD", KEYS.every((k) => ![zh[k], en[k]].some((x) => /\d|\{q\}|TWD/.test(x))));
    console.log(red ? `\n${red} FAILED` : "\nALL PASS"); process.exit(red ? 1 : 0);
  })().catch((e) => { console.log("FAIL  " + (e && e.stack)); process.exit(1); });
}
