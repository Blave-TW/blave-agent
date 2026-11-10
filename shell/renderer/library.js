/* 策略庫(設計:blave-canon output/designer/spec-desktop-library-2026-09-25.md;雲端工作頁 #lib_panel 縮成中欄的尺寸)。
   側欄「策略庫」→ 中欄清單(市場選單、排序選單;預設推薦 = 官方或已驗證優先)→ 詳情(曲線、四個數字、三道關卡、怎麼交易)→「用這支」確認框 →
   送給 agent 同一句固定訊息(lib.msg / lib.msgPaid,逐字同 web 的 workspace_lib_msg;runtime 認這個句型,一行不改)。
   - 清單由主行程打 api(renderer 的 CSP 不外連;主行程逐欄驗過型別才交過來);這裡仍一律 textContent。
   - 兩個視角各記一份「開著 / 詳情那支 / 分段 / 捲動」(LIB.bags,同 TR_BAGS 的作法);中欄誰該出現由 trade.js 的 envShowMain
     在最後一步問 libShowMain。選策略 / 開自動下單會 libLeave。
   - 「已安裝」(§1.2):外殼在 userData 記 { marketplace id → 本機策略資料夾名 };送出「用這支」那一輪結束、本機清單多了一支就記下;
     名字被刪就從表裡拿掉。雲端視角不寫檔:同一套「送出前記清單、之後看多了誰」的比法,只記在這次 app 開著的期間(libCloudChanged)。
   - 不導流(§13):未驗證的社群策略也列(平鋪在同一份清單的尾段,帶「未驗證」tag;spec-desktop-0.1.6 §2),詳情用 /report 補到 400 點曲線、
     總報酬、關卡數值、回測期間;沒有任何開網頁的入口。
   - 付不出資料費(spec-desktop-0.1.6 §3):why 只有一個來源(主行程 libraryList 回的 why);清單分「現在就能用」與第二組,
     閘門卡掛在第二組頭上,詳情主鈕照這支要不要 Blave 資料分流(libGrouping / libCta)。本機「用這支」由主行程代下載。
   - 沒登入(spec library-login-required):清單與詳情照舊公開、清單不預告;下載一律要登入,詳情主鈕是〔登入 Blave〕,回來停在同一支。
   - 上網找點子(spec-0.1.13 §5):三個入口都問 libIdeaOn,框本身在 newstrategy.js(ideaOpen)。
   - 付費策略在 app 內買(§4.4):購買框兩段對齊網頁 libBuy / libPurchase;憑證只在主行程(帳號 token + app 專用密鑰)。
   用到 app.js 的 $ / t / LANG / hasToken / running / RP / RPC / csTitle / csStartNew / submitMessage / confirmBox / delClose / setOpen / setCat /
   planOpen / planSignIn / stratSelect / rpCloudSelect / paneSt / paneToggle、trade.js 的 ENV / TR_BAGS / trLeave / envShowMain / envCanSwitch / envCloudKind /
   envHeadState——都在呼叫時才取(這支比 app.js 先載)。 */

/* ── 純邏輯(tests/check_shell_library.js 從原文切出來跑;這一段不准碰 DOM / i18n)── */
const LIB_DAY = 86400000;
const LIB_PAIR_RE = /^([A-Z0-9]{1,10})USDT$/;
/* 市場選單(同網頁 library_rules.market / MARKETS):api 的 market 優先;舊 api 沒有它時退回 category,而 category 分不出台指期
   (台期所上架的歸在 TW Stock),所以退回時不會有 txf。null = 只在「全部」 */
const LIB_MARKETS = ["crypto", "txf", "twstock", "usstock"];
const LIB_CATEGORY_MARKET = { Crypto: "crypto", "TW Stock": "twstock", "US Stock": "usstock" };
function libMarket(s) {
  if (!s) return null;
  if (LIB_MARKETS.includes(s.market)) return s.market;
  return Object.prototype.hasOwnProperty.call(LIB_CATEGORY_MARKET, s.category) ? LIB_CATEGORY_MARKET[s.category] : null;
}
// 找點子框只認 crypto / tw / txf / any:美股沒有對應的那句話,交給「不限」
function libIdeaMkt(mkt) { return mkt === "crypto" ? "crypto" : mkt === "twstock" ? "tw" : mkt === "txf" ? "txf" : mkt === "usstock" ? "us" : "any"; }
function libDays(from, to) {
  const t0 = Date.parse(typeof from === "string" ? from : ""), t1 = Date.parse(typeof to === "string" ? to : "");
  return isFinite(t0) && isFinite(t1) && t1 >= t0 ? Math.round((t1 - t0) / LIB_DAY) : null;
}
function libYears(s) { const r = s && s.report, d = r ? libDays(r.equity_from, r.equity_to) : null; return d === null ? null : Math.round((d / 365.25) * 10) / 10; }
// 排序與門檻用的樣本年數:不捨入、期間不到 0 天算 null(逐行同 web library_rules.years);libYears 只給畫面顯示(捨到 0.1 年)
function libSampleYears(s) {
  const r = s && s.report; if (!r || !r.equity_from || !r.equity_to) return null;
  const t0 = Date.parse(r.equity_from), t1 = Date.parse(r.equity_to);
  return !isFinite(t0) || !isFinite(t1) || t1 <= t0 ? null : (t1 - t0) / (365.25 * LIB_DAY);
}
function libCreated(s) { const t0 = s && typeof s.created_at === "string" ? Date.parse(s.created_at.replace(" ", "T")) : NaN; return isFinite(t0) ? t0 : null; }
function libListedDays(s, now) { const c = libCreated(s); return c === null ? null : Math.max(0, Math.floor((now - c) / LIB_DAY)); }
function libIsFree(s) { return !(s && typeof s.price === "number" && s.price > 0); }
// 這支要不要 Blave 資料(api 的 blave_data;spec-0.1.13 §1.1):"none" / "required" / null(未標)。用到它的判斷一律把 null 當 required
function libNeeds(s) { return s && (s.blave_data === "none" || s.blave_data === "required") ? s.blave_data : null; }
// lib_pick 的 data 屬性(§8):未標記成 unknown
function libPickData(s) { const n = libNeeds(s); return n === "none" ? "none" : n === "required" ? "required" : "unknown"; }
/* 清單要不要分組、用哪一套組名(§1.2;c = { env, signedIn, dataAccess, why })。null = 不分組;否則 signedOut / no_card / no_balance /
   no_plan / plan_failed / unknown(no_plan / plan_failed 是方案制:沒有含資料的方案、方案扣款失敗)。
   登入著但查不到帳號狀態(dataAccess null)當 unknown:0.1.12 把它當能用,回合跑起來才失敗 */
function libGrouping(c) {
  if (c.env === "cloud") return null;
  if (c.signedIn === false) return "signedOut";
  if (c.dataAccess === "included" || c.dataAccess === "billed") return null;
  if (c.dataAccess === "none" || c.dataAccess === "plan_required" || c.dataAccess === "payment_failed")
    return ["no_card", "no_balance", "no_plan", "plan_failed"].includes(c.why) ? c.why : "unknown";
  return "unknown";
}
// 分組的兩組(§2.2):第一組是免資料的;兩組各自保持 libVisible 的順序。沒登入不分組(library-login-required:清單不預告登入)
function libSplit(list) {
  const now = [], later = [];
  (Array.isArray(list) ? list : []).forEach((s) => (libNeeds(s) === "none" ? now : later).push(s));
  return { now, later };
}
/* 找點子四個入口共用的條件(§1.4;c = { env, browserOn, engine, signedIn, canRun }):這台電腦、內建瀏覽器開著、引擎跑得動。
   Blave AI 要登入而且帳號能跑(查不到 canRun 不算擋);還沒連引擎不出 */
function libIdeaOn(c) {
  const engineOk = c.engine === "claude" || c.engine === "codex" || c.engine === "apikey" || (c.engine === "blave" && c.signedIn === true && c.canRun !== false);
  return c.env === "local" && c.browserOn === true && engineOk;
}
// 代下載沒成的那句:主行程判的 kind(+ 畫面自己的 unsent)→ 字串 key;認不得的一律當 fail
function libDlKey(kind) { return kind === "signinFailed" ? "row.failed" : ["blocked", "gone", "rateLimited", "unsent", "agentOld", "agentOldReopen"].includes(kind) ? "lib.dl." + kind : "lib.dl.fail"; }
// 確認框與購買框的資料費那一行(§4.1):本機、按小時計費、而且這支不是只用公開資料。兩個框共用這一支,條件不會漂
function libFeeLine(env, dataAccess, needs) { return env !== "cloud" && dataAccess === "billed" && needs !== "none"; }
// 推薦排序(同公開頁 library_rules.recoSort):已驗證 → 樣本長 → 新;刻意不看報酬 / Sharpe(最漂亮的回測多半最過擬合)
function libCompare(a, b) {
  const va = a.verified ? 1 : 0, vb = b.verified ? 1 : 0;
  if (va !== vb) return vb - va;
  const ya = libSampleYears(a), yb = libSampleYears(b);
  if (ya !== yb) { if (ya === null) return 1; if (yb === null) return -1; return yb - ya; }
  const ca = libCreated(a), cb = libCreated(b);
  if (ca === cb) return 0; if (ca === null) return 1; if (cb === null) return -1;
  return cb - ca;
}
/* 這個分段要畫的一份清單(spec-desktop-0.1.6 §2.1):主鍵「官方或已驗證」在前,其後照 libCompare。主鍵寫成 code 是因為 libCompare
   第一階只看 verified——「官方但沒跑關卡」在純 libCompare 下會掉到未驗證那一段;Wei 說的是「官方與已驗證在前」 */
function libRecoCmp(a, b) { return (Number(!!(b.is_official || b.verified)) - Number(!!(a.is_official || a.verified))) || libCompare(a, b); }
/* 排序選單(spec library-sort-rows-2026-11-06 §3):key 與順序同網頁公開頁 #mp_sort 的 data-sort,另插 installs。
   數值排序時未驗證或樣本未滿 1 年的沉底;官方身分不救(比的是數字可不可信)。同值照推薦決勝、缺值排最後(同 web valueSort) */
const LIB_SORTS = ["reco", "installs", "sample", "sharpe", "mdd", "annual", "newest"];
const LIB_SINK_SORTS = ["sharpe", "mdd", "annual"];
const LIB_FLOOR_YEARS = 1;
// 用不捨入的年數:#117 樣本 0.98 年捨入成 1.0,第一格講總報酬卻不沉底就對不上(§3.2)
function libUnderYear(s) { const y = libSampleYears(s); return y !== null && y < LIB_FLOOR_YEARS; }
function libSinks(s) { return !(s && s.verified) || libSampleYears(s) === null || libUnderYear(s); }
// 沉底那段從第幾支開始(組標籤畫在它正上方;設計稽核 library-sort-review 第二節第 3 題):只有會沉底的三種排序有,沒有沉底的回 -1。
// list 是 libVisible 排好的(沉底的全在後面),分組時每組各自呼叫
function libSinkAt(list, sort) { return LIB_SINK_SORTS.includes(sort) ? list.findIndex(libSinks) : -1; }
function libNum(v) { return typeof v === "number" && isFinite(v) ? v : null; }
function libMddOf(s) { const v = libNum(s && s.report ? s.report.max_drawdown : null); return v === null ? null : -Math.abs(v); }
function libSortVal(s, by) {
  const r = s && s.report;
  if (by === "installs") return libNum(s.purchase_count);
  if (by === "sample") return libSampleYears(s);
  if (by === "sharpe") return libNum(r ? r.sharpe : null);
  if (by === "mdd") return libMddOf(s);
  if (by === "annual") return libNum(r ? r.annual_return : null);
  if (by === "newest") return libCreated(s);
  return null;
}
function libVisible(list, mkt, sort) {
  const inMkt = (Array.isArray(list) ? list : []).filter((s) => s && (mkt === "all" || libMarket(s) === mkt));
  const by = LIB_SORTS.includes(sort) ? sort : "reco";
  if (by === "reco") return inMkt.sort(libRecoCmp);
  const sink = LIB_SINK_SORTS.includes(by);
  return inMkt.sort((a, b) => {
    if (sink) { const d = Number(libSinks(a)) - Number(libSinks(b)); if (d) return d; }
    const x = libSortVal(a, by), y = libSortVal(b, by);
    if (x === y) return libRecoCmp(a, b);
    if (x === null) return 1; if (y === null) return -1;
    return y - x;
  });
}
// 關卡數值的字(抄 web library_rules.rate):費率 0.0005 → "0.05%"(最少 2 位、尾零去掉);p 的字是 libP(純邏輯區塊外面)
function libRate(v) {
  if (typeof v !== "number" || !isFinite(v)) return "—";
  let s = (v * 100).toFixed(4).replace(/0+$/, "");
  if (/\.\d$/.test(s)) s += "0";
  if (/\.$/.test(s)) s += "00";
  return s + "%";
}
function libGateFails(gc) { return gc ? ["fee", "mcpt", "robust"].filter((k) => gc[k] === "fail").length : 0; }
// 主鈕位置是閘門(要付錢或開方案才能用)的幾態:why 帶 libGrouping 的原因,lib_blocked 也照它送
const LIB_GATE_STATES = ["noData", "planBuy", "planResume", "planWait"];
// api 開不了方案的原因碼(PLAN_ALREADY_ACTIVE 不在這:那是已經有方案,重拉帳號就回一般購買)
const LIB_PLAN_BLOCKS = ["HAS_SERVER", "PLAN_CHARGE_UNCONFIRMED", "PLAN_NOT_ACTIVE"];
/* CTA 態(spec-0.1.13 §1.3 + 0.1.6 §4.4,由上到下取第一個成立的;進行中提到最前——那支的回合就是它的進度)。c = { running, env, signedIn, dataAccess, why, cloud: "live"|"stale"|"stopped"|null,
   pending, noNew, buying, installedName, bindWait, bbOk, noCard, bal }。回 { state, paid, name, err, why, pub, again }:paid = 付費且還沒買;err = 上一輪是這支的下載、結束時沒新策略;
   why = noData 態的原因(libGrouping 的 no_card / no_balance / unknown,只在 noData 帶);pub = 分組中而這支只用公開資料(鈕下講那一句);again = 已安裝態能不能再下載一份(沒登入不能)。
   沒登入一律擋下載,已安裝的照樣打得開;資料牆只擋要資料(含未標)的。installedName 兩個視角各有來源(本機 = userData 的對照表、
   雲端 = 這次開 app 期間看到雲端清單多出來的那支),這裡只認有沒有 */
function libCta(s, c) {
  const paid = !libIsFree(s) && !s.purchased && !s.is_owner, local = c.env !== "cloud", g = libGrouping(c), none = libNeeds(s) === "none";
  // short:已知沒卡、錢包也不夠買這支 → 主鈕直接出綁卡框(稽核 ②);沒卡但錢包夠或還不知道,照舊走確認框與資料牆(③)
  const short = paid && c.noCard === true && typeof c.bal === "number" && typeof s.price === "number" && c.bal < s.price;
  const st = (state, name) => ({ state, paid, short, name: name || null, err: c.noNew === s.id && (state === "free" || state === "owned" || state === "installed"), why: LIB_GATE_STATES.includes(state) ? g : null, pub: local && g !== null && none, again: !(local && c.signedIn === false) });
  if (c.pending === s.id) return st("pending");   // 正在下載的那支:回合當然在跑,它講的是自己的進度,不是「上一輪還在跑」
  if (c.bindWait === s.id) return st("bindWait");   // 綁卡即購買的付款頁開著:等結果
  if (c.running) return st("busy");
  if (local && c.signedIn === false && !c.installedName) return st("signedOut");
  /* 一步開通(spec library-free-data-one-step §3):方案制、沒方案(no_plan = 沒試用資格,或有卡)、這支要資料 → 主鈕〔開通 每 30 天 N〕／〔開通並購買 N〕。
     卡、錢包、Starter 月價任一查不到就不猜,照舊資料牆〔看方案〕。報價回了開不了方案的原因(帳號層級,c.planBlock):名下有主機 → 恢復方案;
     上一筆方案扣款還在確認 → 不出主鈕;其他退回資料牆 */
  if (local && g === "no_plan" && !none && c.planMo === true && c.bbOk !== s.id && typeof c.noCard === "boolean" && typeof c.bal === "number" && typeof c.planTwd === "number" && c.planTwd > 0) {
    if (c.planBlock === "HAS_SERVER") return st("planResume");
    if (c.planBlock === "PLAN_CHARGE_UNCONFIRMED") return st("planWait");
    if (!c.planBlock) return c.buying === s.id ? st("buying") : st("planBuy");
  }
  // 沒卡的人看付費策略:主鈕照樣是購買,綁卡與方案試用在購買框裡一起做(spec library-buy-with-bind §3;原型態 1)
  // bbOk:剛綁卡即購買成功、帳號與清單還沒重拉回來:先當已購買,不閃資料牆(稽核 ④)
  if (local && g !== null && g !== "signedOut" && !none && !(g === "no_card" && short) && c.bbOk !== s.id) return st("noData");
  if (!local && c.cloud !== "live") return st(c.cloud === "stopped" ? "stopped" : "stale");
  if (c.buying === s.id) return st("buying");
  if (c.installedName) return st("installed", c.installedName);
  if (paid) return st("paid");
  if (!libIsFree(s)) return st("owned");
  return st("free");
}
// 送給 agent 的那句話:id 先代、標題後代(標題是 api 來的字:控制字元拿掉、截 120);範本壞掉回 null,寧可不送
function libMsg(s, tpl) {
  const id = s && Number.isInteger(s.id) && s.id > 0 ? String(s.id) : null;
  const title = s && typeof s.title === "string" ? s.title.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) : "";
  if (!id || !title || typeof tpl !== "string" || tpl.split("{title}").length !== 2 || tpl.split("{id}").length !== 2) return null;
  return tpl.split("{id}").join(id).split("{title}").join(title);
}
/* 價格 / 餘額的字(規格 §4.4;照網頁 library_rules.amount):zh 原值、en ÷ rate;價格無條件進位到分(報低於實扣是紅線)、餘額不進位;
   最多 2 位小數、千分位、幣別後綴 */
function libAmount(twd, rate, ccy, lang, ceil) {
  if (typeof twd !== "number" || !isFinite(twd)) return null;
  const r = Number(rate) > 0 ? Number(rate) : 1, raw = twd / r;
  const v = ceil ? Math.ceil(raw * 100 - 1e-9) / 100 : Math.floor(raw * 100 + 1e-9) / 100;
  return new Intl.NumberFormat(lang === "zh" ? "zh-TW" : "en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(v) + " " + ccy;
}
function libPct(v) { return typeof v === "number" && isFinite(v) ? (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(2) + "%" : "—"; }
function libFixed(v, d) { return typeof v === "number" && isFinite(v) ? v.toFixed(d) : "—"; }
const LIB_IV_KEYS = { "5m": "lib.iv.5m", "15m": "lib.iv.15m", "1h": "lib.iv.1h", "2h": "lib.iv.2h", "4h": "lib.iv.4h", "8h": "lib.iv.8h", "12h": "lib.iv.12h", "1d": "lib.iv.1d" };
const LIB_DIR_KEYS = { long: "lib.dir.long", long_short: "lib.dir.long_short", short: "lib.dir.short" };
function libIvKey(iv) {
  const v = String(iv || "").toLowerCase().replace(/\s+/g, "");
  if (v === "5min" || v === "5m") return "5m";
  if (v === "15min" || v === "15m") return "15m";
  if (v === "60m" || v === "60min" || v === "1h") return "1h";
  if (v === "2h" || v === "120m" || v === "120min") return "2h";
  if (v === "4h" || v === "240m" || v === "240min") return "4h";
  if (v === "8h" || v === "480m" || v === "480min") return "8h";
  if (v === "12h" || v === "720m" || v === "720min") return "12h";
  if (v === "1d" || v === "d" || v === "1day") return "1d";
  return null;
}
// 購買回應 → 分支(規格 §4.4 第 3 步;形狀 = 網頁 /strategies/<id>/purchase 的原樣)
function libBuyBranch(status, body) {
  const err = body && typeof body.error === "string" ? body.error : "";
  if (status === 200 && body && body.status === "ok") return "ok";
  // api 只在卡刷了之後才帶 amount_twd:錢在錢包、策略沒買成。要排在 already purchased 前面,不然會當成功、不講剛刷的錢
  if ((status === 400 || status === 402 || status === 500) && body && typeof body.amount_twd === "number" && body.amount_twd > 0) return "charged";
  if (status === 400 && /already purchased/i.test(err)) return "ok";
  // 一鍵框帶的金額／來源跟伺服器不符(沒扣):要排在一般 409(併發)前面
  if (status === 409 && body && (body.error_code === "PRICE_CONFIRM_REQUIRED" || body.error_code === "SOURCE_CHANGED")) return "changed";
  // 錢包是負的:api 不刷卡(刷了也補不完欠款加策略價,每次重按都再刷一次);也要排在一般 409 前面,不然會講成處理中
  if (status === 409 && body && body.error_code === "BALANCE_NEGATIVE") return "negative";
  if (status === 409) return "inProgress";
  if (status === 402 && body && body.needs_topup) return body.has_card ? "topup" : "noCard";
  if (status === 402 && /no card bound/i.test(err)) return "noCard";
  return "failed";
}
/* 綁卡即購買(spec library-buy-with-bind-2026-11-06 §3,同網頁 bind_buy.js quoteOf):不帶 confirm 的報價回應 → 出哪一種框。
   trial = 框 1(順便開試用)、plain = 框 2(只買)、plan = 框 3(要方案、不給買);has_card = 報價前剛綁好卡(回一般購買)、
   owned = 已買過、open = 上一張付款頁還開著(下次帶 restart)、rate = 429;其餘 fallback(舊的「去綁卡」框) */
function libBbBox(status, body) {
  const b = body || {}, code = b.error_code, pos = (v) => (typeof v === "number" && isFinite(v) && v > 0 ? Math.round(v) : null);
  if (status === 429) return { kind: "rate" };
  // 帶 accept_plan 的方案單報價(框 ③)要排在 trial／plain 前面:它的 trial 也是 false,漏判會出框 2、只刷策略價、方案沒開
  if (code === "PRICE_CONFIRM_REQUIRED" && b.plan === true) return libPlanTerms(b, "planpay");
  if (code === "PRICE_CONFIRM_REQUIRED" && pos(b.price_twd))
    return { kind: b.trial === true ? "trial" : "plain", price: pos(b.price_twd), trialDays: pos(b.trial_days), planMonthly: pos(b.plan_monthly_twd), due: libBbDue(b), renew: b.plan_renews_card === true };
  if (code === "PLAN_REQUIRED" && pos(b.plan_monthly_twd)) return { kind: "plan", planMonthly: pos(b.plan_monthly_twd) };
  if (LIB_PLAN_BLOCKS.includes(code)) return { kind: "block", block: code };
  if (code === "PLAN_ALREADY_ACTIVE" || code === "USE_TRIAL" || code === "NOTHING_TO_PAY") return { kind: "refresh" };
  if (code === "HAS_CARD") return { kind: "has_card" };
  if (code === "BIND_PLAN_IN_PROGRESS") return { kind: "open" };
  if (status === 400 && /already purchased/i.test(typeof b.error === "string" ? b.error : "")) return { kind: "owned" };
  return { kind: "fallback" };
}
// 方案欠費中:回呼會用剛綁的卡一起補扣(§9),框裡多一句。api 回正數才講
function libBbDue(b) { const v = b ? b.plan_due_twd : null; return typeof v === "number" && isFinite(v) && v > 0 ? Math.round(v) : null; }
/* bind_purchase_result 的那一筆 → { kind: none | pending | ok | wallet | failed, code, amount, trialUntil }。別支策略的(24 小時內的舊紀錄)是 none。
   先看 status:wallet 時 reason 是代號;failed 時 reason 是藍新的句子,代號只在 reason_code(稽核 r2 第 3 題) */
function libBbRes(res, sid) {
  if (!res || res.strategy_id !== sid || !["pending", "ok", "wallet", "failed"].includes(res.status)) return { kind: "none" };
  const amt = typeof res.amount_twd === "number" && isFinite(res.amount_twd) && res.amount_twd > 0 ? Math.round(res.amount_twd) : null;
  const code = res.reason_code || (res.status === "wallet" ? res.reason : null) || null;
  const out = { kind: res.status, code: res.status === "ok" || res.status === "pending" ? null : code, amount: amt, trialUntil: res.trial_until || null };
  // 方案單(0.1.50):留在錢包的是 wallet_twd(amount_twd 是刷的總額);B 型(策略價 0)的 ok 沒有買策略
  if (res.plan === true) Object.assign(out, { plan: true, planStatus: res.plan_status || null, planReason: res.plan_reason || null, free: res.price_twd === 0,
    wallet: typeof res.wallet_twd === "number" && isFinite(res.wallet_twd) && res.wallet_twd > 0 ? Math.round(res.wallet_twd) : null });
  /* 方案付款期間在別處開了(plan_status active):api 的 status 是 wallet(方案那筆留在錢包),reason 卻是空的或 already_purchased——策略其實買到了
     (marketplace._settle_plan_order 1478–1489)。這時是成功:不能講「策略沒買成」、不能留會失敗的購買鈕(web 稽核 B1) */
  if (out.plan && out.kind === "wallet" && out.planStatus !== "failed" && (out.code === null || out.code === "already_purchased")) out.kind = "ok";
  return out;
}
// 有卡的 /purchase 刷了卡卻沒買成(libBuyBranch 的 charged):跟綁卡即購買的 wallet 同一套句子
function libBbCharged(body) {
  const b = body || {};
  return { kind: "wallet", code: b.reason_code || b.reason || null, amount: Math.round(b.amount_twd), trialUntil: null };
}
/* 主鈕下方那幾句(原型態 6／7 + §9):[{ key, p?(金額 TWD), d?(MM/DD) }]。下架與已買過用原型那兩句,其餘講「已刷 N,錢在錢包,策略沒買成」;
   開了試用的人錢進錢包時多講到期日。ok 沒有句子(主鈕已經換成安裝並回測) */
function libBbLines(r) {
  if (!r) return [];
  if (r.kind === "lines") return r.list;   // 框 ② 的結果(libCardLines)
  if (r.kind === "failed") return [{ key: "lib.bb.failed" }];
  if (r.kind === "note") return [{ key: r.key }];
  // 方案單:都成沒有句子;方案別處已開才講方案那筆在錢包。wallet_twd 是 null(分不出來)就不寫數字
  if (r.plan && (r.kind === "ok" || r.kind === "wallet")) {
    const p = r.wallet;
    if (r.kind === "ok") return r.planStatus === "active" && p ? [{ key: "lib.bb.planActive", p }] : r.code === "already_purchased" && p ? [{ key: "lib.bb.owned", p }] : [];
    // 方案沒成而原因在帳號層級:結果句後接原因句,同一個槽兩句(設計稽核 desktop-one-step 三)
    const why = r.planReason === "HAS_SERVER" ? [{ key: "lib.bb.hasServer" }] : r.planReason === "PLAN_CHARGE_UNCONFIRMED" ? [{ key: "lib.bb.unsettled" }] : [];
    if (r.planStatus === "failed") return [p ? { key: "lib.bb.planFail", p } : { key: "lib.bb.planFailNoAmt" }, ...why];
    return [p ? { key: "lib.bb.planPart", p } : { key: "lib.bb.planPartNoAmt" }];
  }
  if (r.kind !== "wallet") return [];
  const key = r.code === "unavailable" ? "lib.bb.gone" : r.code === "already_purchased" ? "lib.bb.owned" : "lib.bb.wallet";
  const out = [r.amount ? { key, p: r.amount } : { key: "lib.bb.walletNoAmt" }];
  const d = libBbDate(r.trialUntil);
  if (d) out.push({ key: "lib.bb.trialOn", d });
  return out;
}
// 自動儲值那句的兩個數字:取法同網頁,讀 public_tiers 的 trial.auto_topup_min / auto_topup_amount(pub.trial);都是正數才講
function libBbTopup(tr) {
  const lo = tr ? tr.auto_topup_min : null, amt = tr ? tr.auto_topup_amount : null, ok = (v) => typeof v === "number" && isFinite(v) && v > 0;
  return ok(lo) && ok(amt) ? { lo: Math.round(lo).toLocaleString("en-US"), a: Math.round(amt).toLocaleString("en-US") } : null;
}
// api 給台北時間的 ISO:照字面取 MM/DD,不經這台電腦的時區
function libBbDate(iso) { const m = /^\d{4}-(\d{2})-(\d{2})/.exec(typeof iso === "string" ? iso : ""); return m ? m[1] + "/" + m[2] : null; }
// 曲線的時間軸:spark 均勻分布在 equity_from–equity_to;同一天只留最後一點(lightweight-charts 要嚴格遞增)
function libCurve(spark, from, to) {
  if (!Array.isArray(spark) || spark.length < 2) return null;
  const days = libDays(from, to);
  if (days === null) return null;
  const t0 = Date.parse(from), n = spark.length, out = [];
  for (let i = 0; i < n; i++) {
    if (typeof spark[i] !== "number" || !isFinite(spark[i]) || spark[i] <= 0) return null;
    const d = new Date(t0 + Math.round((i * days) / (n - 1)) * LIB_DAY).toISOString().slice(0, 10);
    if (out.length && out[out.length - 1].time === d) out[out.length - 1].value = spark[i];
    else out.push({ time: d, value: spark[i] });
  }
  return out.length >= 2 ? out : null;
}
// 這一語言的成功筆記 id / 標題(spec-0.1.12-library-notes §2.2):缺就是缺,不拿另一個語言頂
function libNoteId(s, lang) { const m = s && s.success_note_ids; const v = m && typeof m === "object" ? m[lang] : null; return Number.isInteger(v) && v > 0 ? v : null; }
/* 歡迎頁①的卡(spec desktop-welcome-library-first §2.3)。候選 = 免費 × 官方 × 不是自己的 × 這個視角沒裝過(installed 回呼);
   不看 purchased:官方策略 /code 抓過一次 api 就記一筆 0 元購買,不代表這台有。只留不用再付錢就能跑的,不拿要資料的補滿(歡迎頁是第一眼,不放牆;沒登入按下去先進詳情,welcome.js wcUse):
   雲端、資料已含 → 全部;其餘(沒登入／billed／none／方案制／查不到)→ 不用 Blave 資料的。billed 也只出不用資料的:第一眼不讓確認框多出收費句。
   每個市場先一支、不到三支照 libVisible 補;回傳照 libVisible 的順序,不照挑的順序。c = { env, signedIn, dataAccess, wait, installed };wait = 帳號狀態還在讀 → null(骨架) */
function wcReco(list, c) {
  const o = c || {};
  if (o.wait) return null;
  const seen = typeof o.installed === "function" ? o.installed : () => false;
  const runs = o.env === "cloud" || (o.signedIn !== false && o.dataAccess === "included") ? () => true : (s) => libNeeds(s) === "none";
  const cands = libVisible((Array.isArray(list) ? list : []).filter((s) => s && libIsFree(s) && s.is_official === true && !s.is_owner && runs(s) && !seen(s)), "all");
  const picked = [], mk = new Set();
  cands.forEach((s) => { const m = String(libMarket(s)); if (picked.length < 3 && !mk.has(m)) { mk.add(m); picked.push(s); } });
  cands.forEach((s) => { if (picked.length < 3 && !picked.includes(s)) picked.push(s); });
  return cands.filter((s) => picked.includes(s));
}
// 卡的第一格(canon › Beginner strategy card › 指標列):回測樣本未滿 1 年講總報酬,否則年化
function wcFirstKv(s) { return libUnderYear(s) ? "total" : "ann"; }
// 列上迷你曲線的點:對數縱軸、起點那條基準線的 y;spark 不是 ≥ 2 個正數就回 null(不畫)
function libSparkPath(sp, w, h, pad) {
  if (!Array.isArray(sp) || sp.length < 2 || !sp.every((v) => typeof v === "number" && isFinite(v) && v > 0)) return null;
  const lg = sp.map(Math.log), mn = Math.min(...lg), span = Math.max(...lg) - mn || 1, y = (v) => h - pad - ((v - mn) / span) * (h - 2 * pad);
  return { pts: lg.map((v, i) => [(i * w) / (lg.length - 1), y(v)]), base: y(lg[0]) };
}
function libNoteTitle(s, lang) { const m = s && s.success_note_titles; const v = m && typeof m === "object" ? m[lang] : null; return typeof v === "string" && v.trim() ? v.trim() : null; }
/* ── 一步開通(spec library-free-data-one-step;api 契約 output/backend/library-one-step-api)── */
// 方案報價的金額與來源:合計對不上分項就不出框(鈕上的數字一定等於實刷)。kind = planpay(框 ③,付款頁)/ cardplan(框 ②,有卡或錢包夠)
function libPlanTerms(b, kind) {
  const n = (v) => (typeof v === "number" && isFinite(v) ? Math.round(v) : null), src = (v) => (["wallet", "card", "free", "none"].includes(v) ? v : null);
  const price = n(b.price_twd), plan = n(b.plan_twd), total = n(b.total_twd);
  if (price === null || price < 0 || !(plan > 0) || !(total > 0) || price + plan !== total) return { kind: "fallback" };
  return { kind, price, plan, total, renewsOn: libBbDate(b.plan_renews_on), planSrc: src(b.plan_source), priceSrc: price > 0 ? src(b.price_source) : null,
    last4: typeof b.card_last4 === "string" && /^\d{4}$/.test(b.card_last4) ? b.card_last4 : null };
}
/* checkout_quote(200)或 card_checkout 不動錢的回應(409 報價／SOURCE_CHANGED、403 NO_CARD)→ 下一步:
   planpay = 沒卡、錢包不夠這次總額 → 框 ③;cardplan = 有卡或錢包夠 → 框 ②;block = 開不了方案(帳號層級);refresh = 已經有資料或該走試用,重拉帳號;
   gone = 下架;rate / fail */
function libPqOf(status, b) {
  if (status === 429) return { kind: "rate" };
  if (status === 404) return { kind: "gone" };
  if (!b) return { kind: "fail" };
  const code = b.error_code;
  if (code === "PLAN_ALREADY_ACTIVE" || code === "NOTHING_TO_PAY") return { kind: "refresh" };
  if (LIB_PLAN_BLOCKS.includes(code)) return { kind: "block", block: code };
  if (status === 200) {
    if (b.plan_blocked === "PLAN_ALREADY_ACTIVE") return { kind: "refresh" };
    if (b.plan_blocked) return LIB_PLAN_BLOCKS.includes(b.plan_blocked) ? { kind: "block", block: b.plan_blocked } : { kind: "fail" };
    if (!b.plan_required || (b.trial_eligible && !b.has_card)) return { kind: "refresh" };
  } else if (!["PRICE_CONFIRM_REQUIRED", "SOURCE_CHANGED", "NO_CARD"].includes(code) || b.plan !== true) return { kind: "fail" };
  const q = libPlanTerms(b, "cardplan");
  if (q.kind === "fallback") return { kind: "fail" };
  if (code === "NO_CARD" || q.planSrc === "none" || q.priceSrc === "none") q.kind = "planpay";
  else if (!q.planSrc || (q.price > 0 && !q.priceSrc)) return { kind: "fail" };   // 框 ② 要寫今天從哪扣,來源不明不出框
  q.changed = code === "SOURCE_CHANGED";
  return q;
}
// 框 ② 第三行的前半句「今天從哪扣」:兩筆同源一句;方案扣錢包、策略刷卡(或反過來)另一句;末四碼拿不到寫「綁定的卡」。內部帳號(free)不講
function libPbSrc(q) {
  const P = q.planSrc, S = q.price > 0 ? q.priceSrc : null, l = q.last4;
  if (P === "free" || S === "free") return null;
  const one = S === null || S === P ? P : null;
  if (one === "wallet") return { key: "lib.bb.srcWallet" };
  if (one === "card") return l ? { key: "lib.bb.srcCard", l } : { key: "lib.bb.srcCardAny" };
  if (P === "wallet" && S === "card") return l ? { key: "lib.bb.srcMixWc", l } : { key: "lib.bb.srcMixWcAny" };
  if (P === "card" && S === "wallet") return l ? { key: "lib.bb.srcMixCw", l } : { key: "lib.bb.srcMixCwAny" };
  return null;
}
/* card_checkout 按 OK 之後的回應 → ok(都成;策略已買過也算)/ part(方案成、策略沒成)/ declined(方案那筆刷卡被拒,什麼都沒扣)/
   requote(金額或來源變了、錢包不夠了:重報價重出框,不自動重送)/ block / refresh / inProgress / rate / fail */
function libCardOut(status, b) {
  if (status === 200 && b && (b.status === "ok" || b.status === "partial")) {
    if (b.status === "ok" || b.purchase_reason === "already_purchased") return { kind: "ok" };
    return { kind: "part", amount: typeof b.amount_twd === "number" && isFinite(b.amount_twd) && b.amount_twd > 0 ? Math.round(b.amount_twd) : null, reason: b.purchase_reason || null };
  }
  if (status === 429) return { kind: "rate" };
  const code = b ? b.error_code : null;
  if (code === "CHECKOUT_IN_PROGRESS") return { kind: "inProgress" };
  if (code === "PLAN_ALREADY_ACTIVE" || code === "NOTHING_TO_PAY") return { kind: "refresh" };
  // PLAN_CONFIRM_REQUIRED = 方案那段漲價(api 的 PlanError 原樣回):一樣重報價重出框
  if (["PRICE_CONFIRM_REQUIRED", "SOURCE_CHANGED", "NO_CARD", "PLAN_CONFIRM_REQUIRED"].includes(code)) return { kind: "requote", changed: code === "SOURCE_CHANGED" };
  if (LIB_PLAN_BLOCKS.includes(code)) return { kind: "block", block: code };
  if (code === "PLAN_CHARGE_FAILED") return { kind: "declined" };
  return { kind: "fail" };
}
// part 的結果句:刷了卡沒買成講金額在錢包;錢包付款的交易出錯(錢沒離開錢包)講錢在錢包;其他(刷卡被拒、錢包不夠、忙)這筆沒扣
function libCardLines(o) {
  if (o.amount) return [{ key: "lib.bb.planPart", p: o.amount }];
  return [{ key: o.reason === "error" ? "lib.bb.planPartNoAmt" : "lib.bb.partNoCharge" }];
}
// 付款頁(框 ③)回來的終態 → lib_bindplan 的 step;free = 免費策略的單
function libBpStep(out, free) {
  if (out.kind === "ok") return free ? "ok_free" : "ok_paid";
  if (out.kind === "failed") return "failed";
  if (out.kind === "wallet") return out.planStatus === "failed" ? "wallet" : "part";
  return null;
}
/* 訪客鈕登入回來接哪一步(spec §2.3;唯一跳過框的訪客 C 由 libLoginGo 另判)。c = 登入後重算的 libCta:
   install = 直接代下載(免費／已買);box = 出購買框或開通框;pay = 有試用資格沒卡看要資料的免費策略,開網站綁卡頁(試用條款在那頁);cta = 停在主鈕 */
function libLoginNext(c, planMo) {
  if (!c) return "cta";
  if (c.state === "free" || c.state === "owned") return "install";
  if (c.state === "paid" || c.state === "planBuy") return "box";
  // 付費的沒卡有試用(錢包夠或讀不到時 libCta 是 noData)不開綁卡頁:報價出框 1(spec §2.3;稽核 desktop-one-step S-2)
  if (c.state === "noData" && c.why === "no_card" && planMo === true) return c.paid ? "box" : "pay";
  return "cta";
}
// 訪客主鈕的字:付費 → 登入並購買 N;不用資料 → 登入並安裝;要資料(含未標)→ 登入並使用
function libSignedOutKey(s, paid) { return paid ? "lib.bb.loginBuy" : libNeeds(s) === "none" ? "lib.bb.loginInstall" : "lib.bb.loginUse"; }
/* 付完自動送「安裝並回測」那一回合的保守估價(TWD)。依據:過去 30 天 Blave AI 實扣 usage_llm 約 9,200 TWD／13,518 次請求
   ≈ 0.7 TWD／次,一個安裝並回測回合常 20+ 步 → 平均約 14;Claude 系一步比 DeepSeek 貴數倍,取排程回合的單份上限 1.0 USD ≈ 40 */
const LIB_TURN_EST = 40;
/* 這一回合跑完會不會讓用戶多被扣錢(Wei 11-09):會就不自動送。engine:claude／codex 用用戶自己的訂閱,不經 Blave,回 true;
   apikey(自帶 API key,按 token 計費)、未知 → false。blave 照 api deduct_credit 的扣法:綁卡前額度(free)→ 試用 AI 額度(trial,
   只在試用中有值)→ 錢包,錢包扣完低於自動儲值門檻就刷卡 300。估值會超支(最後幾筆落到錢包),所以錢包已在門檻以下一律不送;
   門檻以上時,額度加上錢包離門檻的距離要夠 3 倍估值(複稽 2 P1)。任一數字讀不到 → false */
function libTurnFree(engine, b, thr, est) {
  if (engine === "claude" || engine === "codex") return true;
  if (engine !== "blave" || !b || typeof b.balance !== "number" || !isFinite(b.balance) || typeof thr !== "number" || !(thr > 0) || !(est > 0)) return false;
  if (b.balance < thr) return false;
  const pos = (v) => (typeof v === "number" && isFinite(v) && v > 0 ? v : 0);
  return pos(b.free) + pos(b.trial) + (b.balance - thr) >= 3 * est;
}
/* ── 純邏輯到此 ── */
// p 的規則只有一份,在 strategy_versions.js fillP(那支在 library.js 之後載入,呼叫時才讀);門檻跟 api 的 mcpt_alpha 走
function libP(tpl, p, alpha) {
  if (typeof p !== "number" || !isFinite(p)) return "—";
  return window.blaveVersions.fillP(tpl, p, alpha);
}

const LIB = { bags: { local: libNewBag(), cloud: libNewBag() }, data: null, loading: false, skel: false, failed: false, stale: false, seq: 0,
  pending: new Map(), noNew: null, buying: null, installed: {}, chart: null, paintedEnv: null, reports: new Map(),   // reports: id → Promise<report|null>(詳情的 400 點曲線 + 回測期間)
  dlFail: null,   // 本機代下載沒成:{ id, kind: blocked | gone | signin | fail | unsent | signinFailed,relogin }(§4.2);再按一次、離開詳情、libInvalidate 清掉
  gone: false, ctaFocus: null,   // gone:開著的詳情那支從清單消失,清單頂端講一句;ctaFocus:這支剛登入回來,清單畫好後焦點給主鈕
  cloudInstalled: {}, cloudWait: null, cloudNames: null,   // 雲端視角的「已安裝」(只在這次 app 開著的期間;見 libCloudChanged)
  brOn: false, ideaShown: null,   // brOn:內建瀏覽器開關的快取;ideaShown:清單上次畫的找點子入口是開是關
  // 綁卡即購買:bbWait = { id, q, until } 付款頁開著、輪詢中;bbRes = id → 結果(libBbRes 的形狀,或 { kind: "note", key });
  // bbRestart = 上一張付款頁還開著的那幾支(下次帶 restart);bbTop = 結果那支已不在清單(下架),句子放清單頂
  bbWait: null, bbRes: new Map(), bbRestart: new Set(), bbTop: null, bbResumed: false, bbTimer: null, bbBusy: false,
  bal: null, bbOk: null,   // bal:錢包餘額(TWD 數字,讀不到 null),判斷要不要直接出綁卡框;bbOk:剛買成、重拉中的那支
  planBlock: null, loginGo: null, loginDirect: null };   // planBlock:報價說開不了方案的原因碼(帳號層級,換帳號／作廢就清);loginGo:訪客鈕登入回來要接下一步的那支(只接一次)
const LIB_CLOUD_WAIT_MS = 3 * 60 * 1000;   // 回合結束後等雲端清單跟上的上限(主機的回報器有延遲);過了就不再認新出現的那支是這次下載的
function libNewBag() { return { open: false, detail: null, mkt: "all", sort: "reco", scroll: 0, row: null }; }
const libEnv = () => (typeof ENV !== "undefined" && ENV.cur === "cloud" ? "cloud" : "local");
const libBag = (env) => LIB.bags[(env || libEnv()) === "cloud" ? "cloud" : "local"];
const libWhere = () => t(libEnv() === "cloud" ? "lib.where.cloud" : "lib.where.local");
const libFx = () => Number(t("lib.fxRate")) !== 1;
const libPriceText = (s) => libAmount(s.price, t("lib.fxRate"), t("lib.currency"), LANG, true);
const libBalanceText = (v) => libAmount(v, t("lib.fxRate"), t("lib.currency"), LANG, false) || "—";
// 兩句接起來:zh 全形句號後不留空格、en 留一個(brand 全形標點);不在字串表裡塞空格
function libJoin(a, b) { return b ? a + (LANG === "zh" ? "" : " ") + b : a; }
function libTrack(name) { try { if (window.blave && typeof window.blave.trackFeature === "function") window.blave.trackFeature(name); } catch (_) { } }   // 追蹤永遠不擋功能
// 「想用但被擋」(lib_blocked,canon product-telemetry 登記表):why 只有列舉值,主行程再驗一次
function libBlocked(why) { try { if (why && window.blave && typeof window.blave.trackEvent === "function") window.blave.trackEvent("lib_blocked", { why }); } catch (_) { } }
// 點進詳情時主鈕位置是閘門、不是「使用」→ 被擋的原因;忙碌 / 下載中 / 購買中不算被擋(那是暫時的)
// why 只在閘門那幾態有值(libCta 的 LIB_GATE_STATES)
function libBlockedWhy(c) { return c.state === "signedOut" ? "signed_out" : c.why ? c.why : c.state === "stopped" || c.state === "stale" ? "cloud_off" : null; }
function libEl(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
// 範本裡的 {k} 換成節點(數字要進 .mono、字留在 sans):t() 沒給的變數會原樣留著,這裡再切
function libRich(key, vars) {
  const f = document.createDocumentFragment(), tpl = t(key), re = /\{(\w+)\}/g;
  let last = 0, m = null;
  while ((m = re.exec(tpl)) !== null) {
    if (m.index > last) f.append(tpl.slice(last, m.index));
    const v = vars ? vars[m[1]] : undefined;
    f.append(v instanceof Node ? v : v == null ? m[0] : String(v));
    last = re.lastIndex;
  }
  if (last < tpl.length) f.append(tpl.slice(last));
  return f;
}
const libMono = (text) => libEl("span", "mono", text);
function libFind(id) { return LIB.data ? LIB.data.strategies.find((x) => x.id === id) || null : null; }
// 雲端那一邊:running 且 1 小時內同步過才算活著(同 handoff.js 的 hoCloudLive);停機 / 逾時各自講各自的那一句
function libCloud() {
  const st = TR_BAGS.cloud.st, kind = envCloudKind(st);
  if (kind === "stopped") return "stopped";
  if (kind !== "running") return "stale";
  return envHeadState(st, Date.now()) === "unknown" ? "stale" : "live";
}
function libInstalledName(s) {
  const key = String(s.id), name = LIB.installed[key];
  if (!name) return null;
  if (typeof RP !== "undefined" && RP.list.some((x) => x.name === name)) return name;
  delete LIB.installed[key];   // 那支被刪了:表裡拿掉,回免費態
  window.blave.libraryInstalled({ id: s.id, name: null }).catch(() => {});
  return null;
}
/* 雲端視角的「已安裝」:沒有檔、沒有端點——送出「用這支」時記下雲端清單(名字 → mtime),回合結束後看清單多了哪一支(同本機的比法);
   雲端清單跟著主機的回報走、可能晚幾輪才帶到新的那支,所以回合結束時比不到就掛著等(libCloudChanged,有上限)。那支從雲端清單消失就拿掉 */
// 「這一份沒帶清單」≠ 空清單(同 trade.js trCloudListOk 那道門:索引讀不回、登出那一輪都是缺席)——缺席回 null,四個用的地方對 null 不刪、不記、不動
const libCloudOk = () => !!(TR_BAGS.cloud.st && TR_BAGS.cloud.st.cloud && TR_BAGS.cloud.st.cloud.strategies_ok === true);
const libCloudList = () => (libCloudOk() && typeof envCloudList === "function" ? envCloudList(TR_BAGS.cloud.st) : null);
function libCloudInstalledName(s) {
  const key = String(s.id), name = LIB.cloudInstalled[key], list = libCloudList();
  if (!name) return null;
  if (!list || list.some((x) => x.name === name)) return name;
  delete LIB.cloudInstalled[key];
  return null;
}
const libInstalledOf = (s, env) => ((env || libEnv()) === "cloud" ? libCloudInstalledName(s) : libInstalledName(s));
// 雲端清單裡新出現、或同名 mtime 變了的那支就是這次下載的;記下了回 true。送出時或現在缺席就不猜
function libCloudSettle(p, list) {
  if (!p.before || !list) return false;
  // 雲端的 mtime 是 api 的 updated_at:內容 hash 變、索引過期重報都會動,不能拿「mtime 變了」認策略——只認名字不在送出前清單裡的(新下載),或名字就是對照表已記的那支(再下載一份)
  const known = LIB.cloudInstalled[String(p.id)], hit = list.find((x) => !p.before.has(x.name)) || list.find((x) => x.name === known && p.before.get(x.name) !== x.mtime);
  if (!hit) return false;
  LIB.cloudInstalled[String(p.id)] = hit.name;
  return true;
}
function libCloudRepaintList() { if (!$("lib").hidden && libEnv() === "cloud" && !libBag().detail) libPaintList(); }
// trade.js 每次讀到雲端清單都叫(trPoll):掛著的下載比一次;記下了或成員變了才重畫列(每輪重畫會把焦點打掉)
function libCloudChanged(list) {
  if (!libCloudOk() || !Array.isArray(list)) return;
  const w = LIB.cloudWait;
  let changed = false;
  if (w) { if (libCloudSettle(w, list)) { LIB.cloudWait = null; changed = true; libTrack("lib_installed"); libSync(); } else if (Date.now() > w.until) LIB.cloudWait = null; }
  const names = list.map((x) => x.name).join("\n");
  if (names !== LIB.cloudNames) { LIB.cloudNames = names; changed = true; }
  if (changed) { libCloudRepaintList(); if (typeof wcPaint === "function") wcPaint(); }
}
// 清單分組與詳情主鈕共用同一份帳號狀態(登入與否、資料狀態),兩邊才不會一個說「現在就能用」一個說要登入
function libCtx() {
  const env = libEnv();
  return { env, signedIn: typeof hasToken !== "undefined" ? !!hasToken : !!(LIB.data && LIB.data.signedIn),
    dataAccess: LIB.data ? LIB.data.dataAccess : null, why: LIB.data ? LIB.data.why : null,
    noCard: typeof acctNoCard === "function" && typeof acct !== "undefined" && acct ? acctNoCard(acct) : null, bal: LIB.bal,
    planMo: libPlanMo(), planTwd: typeof planVars === "function" ? planVars().pr : null, planBlock: LIB.planBlock };
}
function libCtaOf(s) {
  const c = libCtx();
  const bb = LIB.bbRes.get(s.id);
  if (bb && bb.kind === "ok" && !(bb.plan && bb.free)) s.purchased = true;   // 這次 app 開著期間綁卡即購買成功過:清單晚一步或讀不到也照已購買畫(免費策略的方案單沒買東西)
  return libCta(s, Object.assign(c, {
    running: false, cloud: c.env === "cloud" ? libCloud() : null,   // 回合中不再擋〔使用〕:另開分頁送(csSendAway);進度看 LIB.pending(每支一份)
    pending: LIB.pending.has(s.id) ? s.id : null, noNew: LIB.noNew, buying: LIB.buying, bindWait: LIB.bbWait ? LIB.bbWait.id : null, bbOk: LIB.bbOk,
    installedName: libInstalledOf(s, c.env),
  }));
}
/* 找點子入口(§1.4):三個入口都問這一支;LIB.brOn 是內建瀏覽器開關的快取(libIdeaSync 更新) */
function libIdeaNow() {
  const a = typeof acct !== "undefined" ? acct : null;
  return libIdeaOn({ env: libEnv(), browserOn: LIB.brOn === true, engine: typeof cur !== "undefined" ? cur : null,
    signedIn: typeof hasToken !== "undefined" && !!hasToken, canRun: a ? a.can_run : null });
}
// 開機、開策略庫、切視角、換引擎、帳號狀態變了、回前景、設定裡切內建瀏覽器:重問開關、重畫四個入口(值沒變就不動清單,焦點與捲動留著)
async function libIdeaSync() {
  let p = null;
  try { p = await window.blave.browserPrefs(); } catch (_) { p = null; }
  LIB.brOn = !!(p && p.enabled);
  libIdeaPaint();
}
// 開機那一次可能在 app.js 載入前就回來($ 還沒有):只碰 getElementById
function libIdeaPaint() {
  const on = libIdeaNow();
  ["chat-idea", "wf-idea"].forEach((id) => { const chip = document.getElementById(id); if (chip) chip.hidden = !on; });   // 歡迎頁①與完成後首頁各一顆
  if (LIB.ideaShown === on) return;
  LIB.ideaShown = on;
  if (!document.getElementById("lib").hidden && !libBag().detail) libPaintListKeep();
}

/* ── 開 / 關 ──────────────────────────────────────────── */
// silent:歡迎頁卡開詳情不記 library_open(卡的流量另記 wcard_*,不灌進策略庫報表);它接著開詳情。其餘從別頁進來一律落列表,不留在上次那支
async function libOpen(o) {
  const B = libBag();
  if (!(o && o.silent)) B.detail = null;
  if (typeof trLeave === "function") trLeave(libEnv());
  if (typeof rptLeave === "function") rptLeave();   // 報告與策略庫互斥(renderer/reports.js)
  if (libEnv() === "local") { if (typeof stratSelect === "function") await stratSelect(null); }
  else if (typeof rpCloudSelect === "function") await rpCloudSelect(null);
  B.open = true;
  LIB.planBlock = null;   // 開不了方案的原因只記到下一次進來:扣款確認完、恢復了方案,主鈕要能回來(重按會再報價,還沒好 api 會再回同一碼)
  if (B !== libBag()) return;   // 等的時候切走了:只記下這一邊是開著的
  envShowMain();
  libIdeaSync();
  libLoad(false);   // 每次進視圖都重問主行程(它有 5 分鐘快取;dataAccess 每次現算)——綁卡 / 換帳號 / 換語言之後畫面才會跟上
  libBbResume(); libBalLoad();
  if (typeof pubLoad === "function" && !(typeof pub !== "undefined" && pub)) pubLoad().then(() => libSync()).catch(() => {});   // 訪客鈕下的試用天數與方案價(公開價目)
  const h = B.detail ? $("lib-back") : $("lib-h");
  if (h && h.offsetParent) h.focus();
  if (!(o && o.silent)) libTrack("library_open");
}
// 選了策略 / 開自動下單:那一邊的策略庫收起來(中欄一次只有一個視圖)。trOpen 直接翻 DOM、不經 envShowMain,所以這裡自己收 #lib
function libLeave(env) {
  const B = libBag(env);
  if (!B.open) return;
  B.open = false; LIB.noNew = null; LIB.dlFail = null; LIB.gone = false; LIB.ctaFocus = null; LIB.bbTop = null;
  if (B === libBag()) { libSortClose(false); libMktClose(false); $("lib").hidden = true; $("lib-nav").removeAttribute("aria-current"); libChartDrop(); }
}
/* envShowMain(trade.js)的最後一步:策略庫開著就蓋掉其餘視圖。gate = 雲端沒主機可看(開通頁),那時側欄入口也藏著 */
function libShowMain(gate) {
  const on = !gate && libBag().open, was = !$("lib").hidden;
  if (on) { $("rp").hidden = true; $("tr").hidden = true; $("po").hidden = true; $("main-empty").hidden = true; $("tr-nav").removeAttribute("aria-current"); $("po-nav").removeAttribute("aria-current"); }
  $("lib").hidden = !on;
  if (on) $("lib-nav").setAttribute("aria-current", "page"); else $("lib-nav").removeAttribute("aria-current");
  if (on && (!was || LIB.paintedEnv !== libEnv())) { libPaint(); if (was) libLoad(false); }   // 剛打開 / 切視角(兩邊都開著也要換成這一邊那袋)
  else if (!on && was) libChartDrop();
  libIdeaPaint();   // 切視角也走這裡:雲端不出找點子(歡迎頁那顆籤在 #main-empty,策略庫關著也要跟著換)
}

/* ── 資料 ─────────────────────────────────────────────── */
async function libLoad(force) {
  const seq = ++LIB.seq, fresh = force === true || LIB.stale === true;   // 作廢過(libInvalidate / 買了)就略過主行程的 5 分鐘快取
  LIB.loading = true; LIB.failed = false; LIB.skel = false; LIB.stale = false;
  let shownAt = 0;
  // canon Loader:200ms 內回來不畫 skeleton;畫了至少留 300ms(rpWaitHold 同一個數)
  const timer = setTimeout(() => { if (LIB.seq !== seq || LIB.data) return; LIB.skel = true; shownAt = Date.now(); if (!$("lib").hidden) libPaint(); if (typeof wcPaint === "function") wcPaint(); }, 200);
  let r = null;
  try { r = await window.blave.libraryList(LANG, fresh); } catch (_) { r = null; }
  if (LIB.seq !== seq) return;
  clearTimeout(timer);
  if (shownAt) {
    const hold = typeof rpWaitHold === "function" ? rpWaitHold(shownAt, Date.now()) : 0;
    if (hold) { await new Promise((res) => setTimeout(res, hold)); if (LIB.seq !== seq) return; }
  }
  LIB.loading = false; LIB.skel = false;
  const prev = LIB.data ? JSON.stringify(LIB.data) : null;
  if (r && Array.isArray(r.strategies)) LIB.data = { strategies: r.strategies, signedIn: r.signedIn === true, dataAccess: r.dataAccess || null, why: typeof r.why === "string" ? r.why : null, lang: LANG };
  else LIB.failed = true;   // 手上有舊清單就照畫舊的;沒有才畫「讀不到」
  if (!$("lib").hidden && (prev === null || prev !== JSON.stringify(LIB.data) || LIB.paintedEnv !== libEnv())) libPaint();   // 沒變就不重畫(捲動、焦點、曲線都留著)
  if (typeof wcPaint === "function") wcPaint();   // 歡迎頁①的卡(renderer/welcome.js;自己有指紋)
  libCtaFocusNow();
}
// 登入 / 登出 / 換帳號 / 買了(app.js 在 hasToken 翻轉的地方叫;購買成功自己叫):手上那份作廢,開著就立刻重問
function libInvalidate() { LIB.stale = true; LIB.dlFail = null; LIB.bbWait = null; LIB.bbRes.clear(); LIB.bbRestart.clear(); LIB.bbTop = null; LIB.bal = null; LIB.bbOk = null; LIB.planBlock = null; LIB.cloudInstalled = {}; LIB.cloudWait = null; LIB.cloudNames = null; libRefresh(); }   // 雲端「已安裝」是這個帳號的記憶:換人就丟
// 視圖開著時重問一次(設定關掉、視窗回前景:綁卡 / 儲值後閘門要解)
function libRefresh() { LIB.planBlock = null; if (!$("lib").hidden) libLoad(false); }   // 回前景:開不了方案的原因也重問(同 libOpen)
// 送出「用這支」那一輪結束(app.js onTurnEnd,stratRefresh(true) 之後):本機多了一支就記下對照表;沒有就出灰字。雲端只重問一次狀態
function libTurnEnd() {
  // 還在代下載(stage dl)的不算:結束的是用戶另外送的那一輪。sid 對不上的是別條(對話分頁並行):那支那一輪還在跑
  const mine = [...LIB.pending.values()].filter((p) => p.stage !== "dl" && (!p.sid || p.sid === sessionId));
  if (!mine.length) return;
  for (const p of mine) libTurnSettle(p);
  libSync();
  if (typeof wcPaint === "function") wcPaint();   // 剛裝好的那支立刻從歡迎頁的卡拿掉(稽核 B4)
}
function libTurnSettle(p) {
  LIB.pending.delete(p.id);
  if (p.env === "local") {
    // 只認新出現的、或對照表已記的那支程式碼變了(「再下載一份」是整份覆蓋同名那支);別支被動到不算
    const known = LIB.installed[String(p.id)], touched = RP.list.filter((x) => !p.before.has(x.name) || (x.name === known && p.before.get(x.name) !== x.codeMtime));
    const hit = touched.find((x) => x.name === known) || touched[0];
    // 兩支同時裝:多出來的資料夾分不出是誰的。寧可沒標「已安裝」,也不能把這支的資料夾記到另一支(同 cloudWait 的取捨)
    if (p.overlap && !(hit && hit.name === known)) {
      const taken = new Set(Object.values(LIB.installed)), free = touched.filter((x) => !taken.has(x.name));
      if (free.length === 1 && !LIB.pending.size) { libInstalledSet(p.id, free[0].name); libTrack("lib_installed"); }
      return;
    }
    if (hit) { libInstalledSet(p.id, hit.name); libTrack("lib_installed"); } else { LIB.noNew = p.id; libTrack("library_no_new"); }
  } else {
    if (window.blave && typeof window.blave.cloudRefresh === "function") window.blave.cloudRefresh().catch(() => {});
    if (libCloudSettle(p, libCloudList())) { libTrack("lib_installed"); libCloudRepaintList(); }
    else LIB.cloudWait = { id: p.id, before: p.before, until: Date.now() + LIB_CLOUD_WAIT_MS };   // 清單還沒跟上:等輪詢帶新的來
  }
}
// 這支擋不擋:本機每支一份,不同支可以同時裝;雲端「等清單跟上」只有一格(LIB.cloudWait),一次一支
function libPendingBlocks(s) { return LIB.pending.has(s.id) || (libEnv() === "cloud" && [...LIB.pending.values()].some((p) => p.env === "cloud")); }
function libPendingSet(id, rec) {
  const others = [...LIB.pending.values()].filter((p) => p.id !== id && p.env === rec.env);
  if (others.length) { rec.overlap = true; for (const p of others) p.overlap = true; }
  const old = LIB.pending.get(id); if (old && old.overlap) rec.overlap = true;
  LIB.pending.set(id, rec);
}
function libInstalledSet(id, name) {
  LIB.installed[String(id)] = name;
  window.blave.libraryInstalled({ id, name }).then((m) => { if (m && typeof m === "object") { LIB.installed = m; if (typeof wcPaint === "function") wcPaint(); } }).catch(() => {});
}
// 回合開始 / 結束(running 變了)、購買中、對照表變了:詳情的 CTA 就地重畫;清單的 tag 在 libStratChanged
function libSync() {
  if (typeof wcBusySync === "function") wcBusySync();   // 歡迎頁卡的回合鎖與代下載鎖:用戶在歡迎頁時策略庫是藏著的,要在下一行之前
  if ($("lib").hidden) return;
  const B = libBag(), s = B.detail ? libFind(B.detail) : null;
  if (s) libPaintCta(s);
}
// 本機清單重建了(app.js stratRefresh):列上的「已安裝」跟著變、刪掉的從表裡拿掉
function libStratChanged() { if (!$("lib").hidden && !libBag().detail) libPaintList(); }
function libRepaint() { if ($("lib").hidden) return; LIB.reports.clear(); libPaint(); if (LIB.data && LIB.data.lang !== LANG) libLoad(false); }   // api 給的標題 / 說明也要換語言;報告快取跟著語言走(主行程 per id:lang,沒問過的語言會再打一次)

/* ── 畫 ──────────────────────────────────────────────── */
function libPaint() {
  const B = libBag(); LIB.paintedEnv = libEnv();
  const lost = !!(B.detail && LIB.data && !libFind(B.detail));
  if (lost) { B.detail = null; LIB.dlFail = null; LIB.gone = true; }   // 那支不在清單裡了(下架):回清單,頂端講一句
  const det = B.detail ? libFind(B.detail) : null;
  $("lib-head-list").hidden = !!det; $("lib-back").hidden = !det;
  libPaintGone();
  libSortClose(!det && $("lib-sort-menu").contains(document.activeElement));
  libMktClose(!det && $("lib-mkt-menu").contains(document.activeElement));   // 選單開著時清單重畫(清單到了、換語言):焦點在面板裡就還給觸發鈕,不掉到 body
  if (det) { $("lib-rows").textContent = ""; $("lib-grps").textContent = ""; $("lib-state").hidden = true; libPaintDetail(det); }
  else { libChartDrop(); $("lib-det").hidden = true; $("lib-det").textContent = ""; libPaintDesc(); libPaintList(); $("lib-body").scrollTop = B.scroll || 0; }
  if (lost && libFocusFree()) $("lib-h").focus();
}
// 市場選單:選中的那項、觸發器上的值、每一項的支數(0 也印、照樣可選;網頁同一套)。清單還沒到就都不印;清單每重畫一次就跟著重算
function libPaintMkt() {
  const B = libBag(), list = LIB.data ? LIB.data.strategies : null;
  if (B.mkt !== "all" && !LIB_MARKETS.includes(B.mkt)) B.mkt = "all";
  $("lib-mkt-menu").querySelectorAll(".ct-mi").forEach((b) => {
    const on = b.dataset.mkt === B.mkt, n = list ? libVisible(list, b.dataset.mkt).length : 0;
    b.setAttribute("aria-checked", on ? "true" : "false");
    if (on) $("lib-mkt-v").textContent = b.querySelector(".l").textContent;
    b.querySelector(".ct-mv").textContent = list ? String(n) : "";
  });
}
// 市場與排序兩個選單共用開關(面板 id / 觸發器 id)
function libMenuClose(menu, trig, focus) {
  const m = $(menu);
  if (m.hidden) return;
  m.hidden = true; m.style.left = "";
  $(trig).setAttribute("aria-expanded", "false");
  if (focus) $(trig).focus();
}
function libMenuOpen(menu, trig) {
  const m = $(menu);
  m.hidden = false; m.style.left = "";
  // 中欄窄、觸發器被擠到列尾時:面板往左挪,不超出中欄右緣
  const gap = 8, over = m.getBoundingClientRect().right - ($("lib").getBoundingClientRect().right - gap);
  if (over > 0) m.style.left = -Math.round(over) + "px";
  $(trig).setAttribute("aria-expanded", "true");
  (m.querySelector('[aria-checked="true"]') || m.querySelector(".ct-mi")).focus();
}
function libMktClose(focus) { libMenuClose("lib-mkt-menu", "lib-mkt-trig", focus); }
function libMktOpen() { libMenuOpen("lib-mkt-menu", "lib-mkt-trig"); }
function libMktPick(mkt) {
  libMktClose(true);
  if (mkt === libBag().mkt) return;
  libBag().mkt = mkt; LIB.gone = false; libTrack("lib_mkt_pick"); libPaint();
}
// 排序選單(§3.4):選中那項、觸發器上的值
function libPaintSort() {
  const B = libBag();
  if (!LIB_SORTS.includes(B.sort)) B.sort = "reco";
  $("lib-sort-menu").querySelectorAll(".ct-mi").forEach((b) => {
    const on = b.dataset.sort === B.sort;
    b.setAttribute("aria-checked", on ? "true" : "false");
    if (on) $("lib-sort-v").textContent = b.querySelector(".l").textContent;
  });
}
function libSortClose(focus) { libMenuClose("lib-sort-menu", "lib-sort-trig", focus); }
function libSortOpen() { libMenuOpen("lib-sort-menu", "lib-sort-trig"); }
// 換了順序還停在原捲動位置沒有意義:捲回頂端(清掉 B.scroll)
function libSortPick(by) {
  libSortClose(true);
  const B = libBag();
  if (by === B.sort || !LIB_SORTS.includes(by)) return;
  B.sort = by; B.scroll = 0; LIB.gone = false;
  try { if (window.blave && typeof window.blave.trackEvent === "function") window.blave.trackEvent("lib_sort", { by }); } catch (_) { }
  libPaint();
}
/* 頁首說明句(§2.7):排序那句;找點子開著時後面接「沒有合適的,〔請 agent 上網找點子〕。」——文字鈕和句號包在同一個 nowrap 裡,句號不單獨掉行 */
function libPaintDesc() {
  const d = $("lib-desc"), on = libIdeaNow();
  LIB.ideaShown = on;
  d.textContent = "";
  if (!on) { d.textContent = t("lib.desc"); return; }
  d.append(libJoin(t("lib.desc"), t("idea.descLead")) + (LANG === "zh" ? "" : " "));
  const nw = libEl("span", "nw");
  nw.append(libIdeaBtn("btn-quiet", "idea.link", "lib_head"), LANG === "zh" ? "\u3002" : ".");
  d.appendChild(nw);
}
// 找點子的入口鈕(頁首 / 第一組空):市場預設照清單選的市場
function libIdeaBtn(cls, key, from) {
  const b = libEl("button", cls, t(key)); b.type = "button";
  b.addEventListener("click", () => { if (typeof ideaOpen === "function") ideaOpen(b, from, libIdeaMkt(libBag().mkt)); });
  return b;
}
// 重畫清單但焦點留在原本那一列(找點子開關切換時;libBack 同一套 data-id 找法);焦點原本在被拿掉的文字鈕上就交給頁首標題,不掉到 body
function libPaintListKeep() {
  const a = document.activeElement, row = a && a.closest ? a.closest(".lib-row") : null, id = row ? row.dataset.id : null;
  const inList = !!a && ($("lib-head-list").contains(a) || $("lib-grps").contains(a) || $("lib-state").contains(a));
  libPaintDesc(); libPaintList();
  const r = id ? $("lib-body").querySelector('.lib-row[data-id="' + id + '"]') : null;
  if (r) r.focus(); else if (inList && !a.isConnected) $("lib-h").focus();
}
function libTags(s) {
  const out = [];
  if (s.verified) out.push(libEl("span", "tag is-verified", t("lib.verified")));
  if (libIsFree(s)) out.push(libEl("span", "tag", t("lib.free")));
  else if (s.purchased || s.is_owner) out.push(libEl("span", "tag", t("lib.owned")));
  else { const p = libEl("span", "tag is-price"); p.append(libPriceNode(s)); out.push(p); }
  if (libInstalledOf(s)) out.push(libEl("span", "tag", t("lib.installed")));
  return out;
}
// 「1,200 TWD」= .mono 數字 + 一般字幣別(同網頁 .lib-tag.is-price)
function libPriceNode(s) {
  const f = document.createDocumentFragment(), txt = libPriceText(s) || "—", i = txt.lastIndexOf(" ");
  if (i < 0) { f.append(libMono(txt)); return f; }
  f.append(libMono(txt.slice(0, i)), libEl("span", "", txt.slice(i + 1)));   // 幣別自己一個節點:inline-flex 會吃掉純文字開頭的空白
  return f;
}
// 標的與頻率:「BTC/USDT 永續」「TXF 台指期」「2330 台股」/ 沒有標的 = 多標的;週期用網頁同一組字。
// noIv:清單列只留代號「BTC/USDT」「TXF」「2330」,不帶市場後綴與週期(同 web 列;設計稽核 library-sort-review 第 7 條)
function libSymbolNodes(s, noIv) {
  const r = s.report || {}, sym = typeof r.symbol === "string" ? r.symbol.trim() : "", parts = [];
  if (!sym) parts.push(t("lib.mk.multi"));
  else if (noIv) parts.push(libMono(LIB_PAIR_RE.test(sym) ? sym.replace(LIB_PAIR_RE, "$1/USDT") : sym));
  else if (LIB_PAIR_RE.test(sym)) parts.push(libMono(sym.replace(LIB_PAIR_RE, "$1/USDT")), " " + t("lib.mk.perp"));
  else if (/^(TXF|MXF|TMF)$/.test(sym)) parts.push(libMono(sym), " " + t("lib.mk.txf"));
  else if (/^\d{4,6}[A-Z]?$/.test(sym)) parts.push(libMono(sym), " " + t("lib.mk.tw"));
  else parts.push(libMono(sym));
  if (noIv) return parts;
  const k = libIvKey(r.interval);
  if (k) parts.push(" · " + t(LIB_IV_KEYS[k])); else if (typeof r.interval === "string" && r.interval) parts.push(" · ", libMono(r.interval));
  return parts;
}
/* 列(§4.1):標題＋tag / 副標只留標的 → 迷你曲線 → 第一格(樣本未滿 1 年講總報酬,同 wcFirstKv)→ 第二格(照 Sharpe 排時換 Sharpe,否則最大回撤)→ ›。
   副標只在「安裝最多」「最新上架」時接排序依據:那兩個數列上別處看不到 */
function libRow(s, sort) {
  const b = libEl("button", "lib-row"); b.type = "button"; b.dataset.id = String(s.id);
  const l = libEl("div", "lib-row-l"), l1 = libEl("div", "l1"), l2 = libEl("div", "l2");
  // 按鈕照內容唸(不另給 aria-label,看得到的 tag 才念得到):標題與 tag 之間塞空白文字節點,唸起來才不會黏在一起;flex 版面不畫它
  l1.appendChild(libEl("span", "t", s.title)); libTags(s).forEach((x) => l1.append(" ", x));
  l2.append(...libSymbolNodes(s, true));
  if (sort === "installs") l2.append(" · ", libRich("lib.installs", { n: libMono(String(s.purchase_count)) }));
  else if (sort === "newest") { const d = libListedDays(s, Date.now()); if (d !== null) l2.append(" · ", libRich("lib.listedFor", { n: libMono(String(d)) })); }
  l.append(l1, l2);
  const r = s.report || {}, tot = wcFirstKv(s) === "total", v1 = tot ? r.total_return : r.annual_return, mdd = libMddOf(s);
  const sign = (v) => (typeof v === "number" ? (v > 0 ? " up" : v < 0 ? " down" : "") : "");
  const cells = [[t(tot ? "lib.kv.total" : "lib.kv.ann"), libPct(v1), sign(v1)],
    sort === "sharpe" ? [t("lib.kv.sharpe"), libFixed(r.sharpe, 2), ""] : [t("lib.kv.mdd"), libPct(mdd), mdd === null ? "" : " down"]];
  const spark = libEl("div", "spark"), cv = document.createElement("canvas");
  cv.width = LIB_SPARK_W; cv.height = LIB_SPARK_H; cv.setAttribute("aria-hidden", "true"); cv.blaveSpark = r.spark;
  spark.appendChild(cv);
  b.append(l, spark);
  cells.forEach(([k, v, cls]) => { const n = libEl("div", "num"); n.append(libEl("div", "k", k), libEl("div", "v mono" + cls, v)); b.appendChild(n); });
  const go = libEl("span", "go", "›"); go.setAttribute("aria-hidden", "true");
  b.append(go);
  b.addEventListener("click", () => libShowDetail(s.id));
  return b;
}
// 迷你曲線(§4.3):canvas 2D,不每列開 lightweight-charts;顏色從 CSS 變數讀,換主題重畫(blave:theme)。spark 壞掉就留白
const LIB_SPARK_W = 88, LIB_SPARK_H = 28;
function libSparkDraw(cv) {
  const p = libSparkPath(cv.blaveSpark, LIB_SPARK_W, LIB_SPARK_H, 2), x = cv.getContext && cv.getContext("2d");
  if (!x) return;
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(LIB_SPARK_W * dpr); cv.height = Math.round(LIB_SPARK_H * dpr);
  x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, LIB_SPARK_W, LIB_SPARK_H);
  if (!p) return;
  const tok = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  x.strokeStyle = tok("--border-frame"); x.lineWidth = 1; x.setLineDash([2, 2]);
  x.beginPath(); x.moveTo(0, p.base); x.lineTo(LIB_SPARK_W, p.base); x.stroke(); x.setLineDash([]);
  x.strokeStyle = tok("--color-green"); x.lineWidth = 1.25; x.lineJoin = "round";
  x.beginPath(); p.pts.forEach(([px, py], i) => (i ? x.lineTo(px, py) : x.moveTo(px, py))); x.stroke();
}
function libSparkAll() { document.querySelectorAll("#lib .lib-row .spark canvas").forEach(libSparkDraw); }
function libPaintList() {
  const B = libBag(), rows = $("lib-rows"), state = $("lib-state"), grps = $("lib-grps");
  libPaintMkt(); libPaintSort();
  rows.textContent = ""; state.hidden = true; state.textContent = ""; grps.textContent = "";
  if (!LIB.data) {
    if (LIB.skel) {
      [94, 82, 90, 76, 87].forEach((w) => {
        const r = libEl("div", "sk-row"), l = libEl("div"), a = libEl("div", "sk"), c = libEl("div", "sk s"), n = libEl("div", "sk");
        a.style.width = w + "%"; c.style.width = Math.round(w * 0.7) + "%"; l.append(a, c); r.append(l, libEl("div", "sk sk-c"), n, libEl("span"));
        rows.appendChild(r);
      });
    } else if (LIB.failed) {
      state.hidden = false;
      const b = libEl("button", "btn-out", t("lib.retry")); b.type = "button"; b.addEventListener("click", () => libLoad(true));
      state.append(t("lib.error"), document.createElement("br"), b);
    }
    return;
  }
  const v = libVisible(LIB.data.strategies, B.mkt, B.sort);
  // 市場分段整個空(§2.5):一行字;找點子開著時頁首說明句已有那個連結,這裡不再給一次(稽核 W4),關著才接〔新增策略〕
  if (!v.length) {
    state.hidden = false; state.append(t(LIB.data.strategies.length ? "lib.emptyMkt" : "lib.empty"));
    if (!libIdeaNow()) { const b = libEl("button", "btn-out", t("ns.chip")); b.type = "button"; b.addEventListener("click", () => { if (typeof nsOpen === "function") nsOpen(b); }); state.append(document.createElement("br"), b); }
    return;
  }
  // 沒權限時分兩組(§2.2 / §2.3):閘門卡掛在它管的第二組頭上;第二組空就平鋪(這個分段全部能直接用)
  const g = libGrouping(libCtx()), sp = g && g !== "signedOut" ? libSplit(v) : null;
  // 沉底組標籤:規則寫在它生效的位置(觸控與讀屏都拿得到,不靠 tooltip);同組標題的 h6,上距 16、不加線
  const fill = (host, arr) => {
    const at = libSinkAt(arr, B.sort);
    arr.forEach((s, i) => { if (i === at) host.appendChild(libEl("h6", "lib-grp-h lib-sink-h", t("lib.sinkHead"))); host.appendChild(libRow(s, B.sort)); });
  };
  if (!sp || !sp.later.length) { fill(rows, v); libSparkAll(); return; }
  const grp = (id, label, n) => {
    const sec = libEl("section", "lib-grp"), h = libEl("h6", "lib-grp-h"); sec.setAttribute("aria-labelledby", id); h.id = id;
    h.append(label, libMono(String(n))); sec.appendChild(h); return sec;
  };
  const listOf = (arr) => { const d = libEl("div", "lib-rows"); fill(d, arr); return d; };
  const g1 = grp("lib-grp-now", t("lib.grp.now"), sp.now.length);
  if (sp.now.length) g1.appendChild(listOf(sp.now));
  else {   // 第一組空(台股 × 沒卡):一行字,找點子開著就接文字鈕
    const p = libEl("p", "lib-grp-empty", t("lib.grp.empty"));
    if (libIdeaNow()) p.append(LANG === "zh" ? "" : " ", libIdeaBtn("btn-quiet", "idea.link", "lib_empty"));
    g1.appendChild(p);
  }
  // 方案制的 no_card = 有試用資格又沒卡:組名講缺什麼、不放句子,試用鈕旁邊一顆「看方案」(spec paywall-redesign-2026-10-21 §2.2)
  const trialGate = g === "no_card" && libPlanMo();
  const g2 = grp("lib-grp-later", t(trialGate ? "lib.grp.data" : LIB_GRP_KEYS[g][0]), sp.later.length), gate = libEl("div", "lib-gate");
  if (trialGate) {
    const act = libEl("div", "act"), more = libEl("button", "btn-quiet", t("data.seePlan")); more.type = "button";
    more.addEventListener("click", () => { libTrack("plan_lib"); planOpen(); });
    act.append(libGateBtn(g), more); gate.appendChild(act);
  } else gate.append(libEl("p", "", t(LIB_GRP_KEYS[g][1])), libGateBtn(g));
  g2.append(gate, listOf(sp.later));
  grps.append(g1, g2);
  libSparkAll();
}
// 第二組的組名與閘門卡那一句(§2.2 表)
const LIB_GRP_KEYS = { no_card: ["lib.grp.card", "lib.grp.gate.noCard"], no_balance: ["lib.grp.topup", "lib.grp.gate.noBalance"],
  no_plan: ["lib.grp.plan", "lib.grp.gate.noPlan"], plan_failed: ["lib.grp.repay", "lib.grp.gate.planFailed"],
  unknown: ["lib.grp.check", "lib.grp.gate.unknown"] };
const libPlanMo = () => typeof planMo === "function" && planMo();
/* 付不出資料費的出口(§3.2):no_card 有試用 → 「綁卡,送 {t} 天資料」/ 沒試用或 t 空 → 「前往綁卡」/ no_balance → 「儲值」/ unknown → 描邊「帳號與方案」
   (查不到狀態時不擺一顆要錢的主鈕;鈕字用 pv.e.btn——「開這一頁的鈕」的字,跟資料卡那顆共用)。這幾顆開 設定 › 帳號與方案。
   方案制的 no_card(有試用資格又沒卡)→「綁卡免費試用 {t} 天」直接開瀏覽器綁卡頁(bindGo),收費講在那一頁。試用天數來自 planVars().t(api 的 trial.days),不寫死 */
function libGateBtn(why) {
  // 方案制:沒有方案 →「看方案」開設定 › 帳號與方案(那一頁有開通鈕與 API 方案);扣款失敗 →「重新付款」外開網站方案頁
  if (why === "no_plan") { const b = libEl("button", "btn-fill", t("data.seePlan")); b.type = "button"; b.addEventListener("click", () => { libTrack("plan_lib"); planOpen(); }); return b; }
  if (why === "plan_failed") { const b = libEl("button", "btn-fill", t("plan.repay")); b.type = "button"; b.addEventListener("click", () => planRepay()); return b; }
  const trial = typeof acct !== "undefined" && acct && acct.trial_eligible === false ? false : true;
  const tDays = typeof planVars === "function" ? planVars().t : "";
  if (why === "no_card" && libPlanMo()) {
    const b = libEl("button", "btn-fill", trial && tDays ? t("lib.gate.trial", { t: tDays }) : t("plan.addCard")); b.type = "button";
    b.addEventListener("click", () => bindGo("bind_lib"));
    return b;
  }
  const b = libEl("button", why === "unknown" ? "btn-out" : "btn-fill", why === "no_balance" ? t("lib.gate.topup") : why === "unknown" ? t("pv.e.btn") : trial && tDays ? t("lib.gate.bindCard", { t: tDays }) : t("plan.addCard"));
  b.type = "button"; b.addEventListener("click", () => { if (why !== "unknown") libTrack(why === "no_balance" ? "topup_lib" : "bind_lib"); planOpen(); });
  return b;
}
/* 詳情的登入鈕:直接開瀏覽器登入(app.js planSignIn)。cls:已安裝那格是文字鈕。label 有給 = 訪客主鈕(〔登入並安裝／使用／購買 N〕,spec
   library-free-data-one-step §2.1):登入回來照 libLoginGo 接下一步一次;〔重新登入 Blave〕不續走 */
function libSignInBtn(key, cls, label, direct) {
  const b = signInLabel(libEl("button", cls || "btn-fill"), label || t(key || "cn.blave.btn")); b.type = "button";
  b.addEventListener("click", () => libSignIn(b, !!label, direct));
  return b;
}
// direct:鈕上寫的金額,登入後報價對得上才可跳過框;只有訪客 C 帶
async function libSignIn(b, go, direct) {
  const id = libBag().detail, env = libEnv(), was = LIB.dlFail && LIB.dlFail.id === id ? LIB.dlFail : null;
  if (!planLoginBusy && !oauthPending) libTrack("login_lib");   // 等待中再按是取消,不算一次登入
  if (was && was.kind === "signinFailed") { LIB.dlFail = was.relogin ? { id, kind: "signin" } : null; libClearFail(); }   // 上一次沒成的那句活不過這一次;key 被撤的那句留著
  const r = await planSignIn(b);
  if (!r) return;   // 這一按是取消:結果由開始登入那一按收
  const here = () => !$("lib").hidden && libEnv() === env && libBag().detail === id;
  if (r.ok) { LIB.ctaFocus = id; LIB.loginGo = go ? id : null; LIB.loginDirect = go && direct ? direct : null; if (LIB.loading) b.disabled = true; else libCtaFocusNow(); return; }   // 清單還在路上:這顆舊鈕再按會又登入一次
  if (!here()) return;
  if (!oauthGaveUp(r.code)) LIB.dlFail = { id, kind: "signinFailed", relogin: !!(was && (was.kind === "signin" || was.relogin)) };
  libSync();
  const m = libCtaMain(); if (m && libFocusFree()) m.focus();
}
function libClearFail() { const c = $("lib-cta"), e = c && c.querySelector(".err"); if (e) e.remove(); }
// 等瀏覽器時他可能已經在輸入框打字或開了框:焦點還在策略庫裡(或掉到 body)才接手
function libFocusFree() { const a = document.activeElement; return !a || a === document.body || $("lib").contains(a); }
/* 登入回來:清單與帳號狀態到了才畫得出真正的下一步(綁卡、購買),所以等 libLoad 收尾才給焦點,只給一次。
   訪客主鈕按的(loginGo)再接下一步一次(libLoginGo);重畫會換掉鈕,放在 libLoad 最後一步;那支剛好下架就交給 libPaint 的頁首焦點 */
function libCtaFocusNow() {
  const id = LIB.ctaFocus, go = LIB.loginGo === id, direct = go ? LIB.loginDirect : null;
  if (id === null) return;
  LIB.ctaFocus = null; LIB.loginGo = null; LIB.loginDirect = null;
  if ($("lib").hidden || libBag().detail !== id) return;
  libSync();
  const m = libCtaMain(); if (m && libFocusFree()) m.focus();
  if (go) libLoginGo(id, direct);
}
/* 訪客鈕登入回來接一次(spec §2.3):先讀錢包(卡與帳號狀態 planLogin 已等過),照重算的主鈕走它本來會走的那條——付費一律出框、
   不用資料或已買的直接代下載、有試用資格沒卡的要資料免費策略開網站綁卡頁。中途離開這支、換視角就不接。
   唯一不出框的:C(不用資料的付費策略)沒卡、錢包不夠,報價是一次性、金額等於鈕上(direct) → 直接開付款頁(Wei 11-09;spec §2.3 第 90 行) */
async function libLoginGo(id, direct) {
  if (libEnv() !== "local") return;
  await libBalLoad();
  // 清單那一份的帳號狀態若剛好沒讀到(dataAccess null、why unknown),重拉一次再判:這裡決定的是付錢那條路
  if (!LIB.data || LIB.data.dataAccess === null || LIB.data.why === "unknown") { try { await libLoad(true); } catch (_) { } }
  const s = libFind(id);
  if (!s || $("lib").hidden || libEnv() !== "local" || libBag().detail !== id || LIB.buying !== null) return;
  const c = libCtaOf(s), next = libLoginNext(c, libPlanMo()), m = libCtaMain();
  const dir = next === "box" && c.state === "paid" && c.short && libNeeds(s) === "none" && direct ? direct : null;
  try { window.blave.trackEvent("lib_login_go", { next: dir ? "pay_direct" : next }); } catch (_) { }   // pay = 開網站綁卡頁;pay_direct = 開藍新付款頁
  if (next === "install") libSend(s);
  else if (next === "pay") bindGo("bind_lib");
  else if (next === "box" && c.state === "planBuy") libPlanBuy(s, m);
  else if (next === "box") { if (c.short || c.state === "noData") libBindBuy(s, m, dir ? { direct: dir } : undefined); else libBuyBox(s, "confirm", m, {}); }   // noData = 付費、沒卡有試用:報價出框 1
}
function libPaintGone() {
  const p = $("lib-gone"); p.textContent = "";
  const top = LIB.bbTop && !(LIB.data && libFind(LIB.bbTop.id)) ? libBbLines(LIB.bbTop.out) : [];   // 綁卡即購買下架沒買成:那支已不在清單,結果句放這裡
  p.hidden = !LIB.gone && !top.length;
  if (p.hidden) return;
  const m = libEl("span", "fault-mark"); m.setAttribute("aria-hidden", "true");
  p.append(m, libEl("span", "", top.length ? top.map(libBbText).join(LANG === "zh" ? "" : " ") : t("lib.dl.gone")));
}
/* 詳情 noData 鈕下那句(§3):第一句看資料需求(要用 / 未標),第二句看原因——no_card 不接(鈕字已經講了) */
function libNoDataText(s, why) {
  return libJoin(t(libNeeds(s) === "required" ? "lib.need.data" : "lib.need.unknown"), why === "no_balance" ? t("lib.why.noBalance") : why === "no_plan" ? t("lib.why.noPlan") : why === "plan_failed" ? t("lib.why.planFailed") : why === "unknown" ? t("lib.why.unknown") : "");
}
// 訪客看要資料的免費策略,鈕下那句的兩個數字(試用天數、Starter 每 30 天價;沒登入讀公開價目)。方案制之前或讀不到就不出
function libLoginUseVars() {
  if (!libPlanMo() || typeof planVars !== "function") return null;
  const v = planVars();
  return v.t && v.pr ? { t: String(v.t), p: libTwd(v.pr) } : null;
}
// 有試用資格又沒卡(方案制的 no_card)時的試用天數與每 30 天價,鈕下續扣句與報價比對用;任一讀不到 null(照舊出框 1)
function libTrialTerms(c) {
  if (!c || c.why !== "no_card" || !libPlanMo() || typeof planVars !== "function") return null;
  const v = planVars(), d = Number(v.t), p = Number(v.pr);
  return Number.isInteger(d) && d > 0 && Number.isInteger(p) && p > 0 ? { t: d, p } : null;
}
function libShowDetail(id) {
  const B = libBag(); B.row = id; B.detail = id; LIB.gone = false; LIB.bbTop = null;
  libPaint(); $("lib-body").scrollTop = 0;
  const s = libFind(id); if (s) libBlocked(libBlockedWhy(libCtaOf(s)));
  $("lib-back").focus();
}
function libBack() {
  const B = libBag();
  B.detail = null; LIB.noNew = null; LIB.dlFail = null; LIB.gone = false; LIB.ctaFocus = null;
  libPaint();
  const r = $("lib-body").querySelector('.lib-row[data-id="' + B.row + '"]');   // 主段或(展開著的)社群段
  if (r) r.focus(); else $("lib-h").focus();
}
function libKv(rows) {
  const kv = libEl("div", "lib-kv");
  rows.forEach(([k, v]) => { kv.appendChild(libEl("div", "k", k)); const d = libEl("div", "v mono"); if (v instanceof Node) d.appendChild(v); else d.textContent = v; kv.appendChild(d); });
  return kv;
}
function libPaintDetail(s) {
  libChartDrop();
  const det = $("lib-det"); det.hidden = false; det.textContent = "";
  const r = s.report || null, now = Date.now();
  // 頭部
  const head = libEl("div", "lib-dhead"), hl = libEl("div", "lib-dhead-l"), badges = libEl("div", "lib-badges");
  libTags(s).forEach((x) => badges.appendChild(x));
  const meta = libEl("div", "lib-meta");
  meta.append(t(s.is_official ? "lib.official" : "lib.community"), " · ", ...libSymbolNodes(s), " · ", libRich("lib.installs", { n: libMono(String(s.purchase_count)) }));
  hl.append(badges, libEl("h5", "", s.title), meta);
  if (s.summary && s.summary.trim()) hl.appendChild(libEl("p", "lib-sum", s.summary.trim()));
  const cta = libEl("div", "lib-cta"); cta.id = "lib-cta";
  head.append(hl, cta); det.appendChild(head);
  libPaintCta(s);
  // 卡 1:回測
  const c1 = libEl("div", "lib-card");
  let chartHost = null;
  if (r && r.spark) { chartHost = libEl("div", "chart"); chartHost.id = "lib-chart"; c1.appendChild(chartHost); }
  else c1.appendChild(libEl("p", "chart-none", t("lib.noCurve")));
  const split = libEl("div", "lib-split"), colA = libEl("div", "lib-kvcol"), colB = libEl("div", "lib-kvcol");
  const y = libYears(s), days = libListedDays(s, now);
  colA.append(libEl("div", "gh", t("lib.kv.bt")), libKv([
    [t("lib.kv.total"), libPct(r ? r.total_return : null)], [t("lib.kv.ann"), libPct(r ? r.annual_return : null)], [t("lib.kv.sharpe"), libFixed(r ? r.sharpe : null, 2)],
    [t("lib.kv.mdd"), libPct(r ? r.max_drawdown : null)], [t("lib.kv.sample"), y === null ? "—" : t("lib.sampleYrs", { n: y.toFixed(1) })]]));
  colB.append(libEl("div", "gh", t("lib.kv.listed")), libKv([[t("lib.kv.days"), days === null ? "—" : String(days)], [t("lib.kv.installs"), String(s.purchase_count)]]));
  split.append(colA, colB); c1.appendChild(split); det.appendChild(c1);
  // 成功筆記入口卡(spec-0.1.12-library-notes §2.3):回測卡正下方;這一語言沒有筆記就整張不出
  if (libNoteId(s, LANG)) det.appendChild(libNoteLink(s));
  // 卡 2:三道品質關卡——只依 api 的 gate_checks 渲染,前端不重算;官方沒有就整張不出。社群:先講結論(沒過幾道 / 沒跑過),再列三道
  const gc = r && r.gate_checks;
  if (gc || !s.is_official) {
    const c2 = libEl("div", "lib-card"); c2.appendChild(libEl("h6", "", t("lib.gates.title")));
    if (!s.is_official && !gc) c2.appendChild(libEl("p", "lib-p", t("lib.gates.community")));
    else if (!s.is_official && libGateFails(gc) > 0) { const p = libEl("p", "lib-p"); p.appendChild(libRich("lib.gates.failed", { k: libMono(String(libGateFails(gc))) })); c2.appendChild(p); }
    if (gc) {
      const g = r.gates || {}, fee = g.fee || {}, rob = g.robust || {};
      const vals = { fee: [t("lib.gate.feeAssumed", { v: libRate(fee.rate) }), t("lib.gate.feeActual", { v: libRate(fee.actual) })], mcpt: gc.mcpt === "na" ? [] : [libP(t("lib.gate.p"), g.mcpt_p, g.mcpt_alpha)],
        robust: [typeof rob.ratio === "number" && isFinite(rob.ratio) ? t("lib.gate.robustVal", { ratio: String(Math.round(rob.ratio * 100)) }) : "—"] };
      const ul = libEl("ul", "gates");
      [["fee", "lib.gate1", "lib.gate1d"], ["mcpt", "lib.gate2", "lib.gate2d"], ["robust", "lib.gate3", "lib.gate3d"]].forEach(([key, n, d]) => {
        const li = libEl("li"), v = gc[key], gr = libEl("span", "gr");
        const gv = libEl("span", "gv " + (v === "pass" ? "up" : v === "fail" ? "down" : "na"), t(v === "pass" ? "lib.gate.pass" : v === "fail" ? "lib.gate.fail" : "lib.gate.naShort"));
        gr.appendChild(key === "mcpt" && v !== "pass" && v !== "fail" ? libGateTip(gv, t("lib.gate.na"), "lib-gate-na-tip") : gv);
        vals[key].forEach((x) => { const gx = libEl("span", "gx mono", x); gr.appendChild(key === "robust" && rob.ratio > 1 ? libGateTip(gx, t("lib.gate.robustOver"), "lib-gate-rob-tip") : gx); });
        li.append(libEl("span", "gn", t(n)), gr, libEl("span", "gd", t(d))); ul.appendChild(li);
      });
      c2.appendChild(ul);
    }
    det.appendChild(c2);
  }
  // 卡 3:它怎麼交易
  const c3 = libEl("div", "lib-card"); c3.appendChild(libEl("h6", "", t("lib.how")));
  if (s.description && s.description.trim()) c3.appendChild(libEl("p", "lib-p", s.description.trim()));
  const dl = libEl("dl", "lib-dl");
  const dd = (k, v, id) => { dl.appendChild(libEl("dt", "", k)); const d = libEl("dd"); if (id) d.id = id; if (v instanceof Node) d.appendChild(v); else d.textContent = v; dl.appendChild(d); };
  // 回測期間:先用清單的曲線區間,/report 回來就地換成 backtest_start/end(有報告列就留一格,沒曲線先寫 —)
  if (r) dd(t("lib.meta.period"), r.equity_from && r.equity_to ? libMono(r.equity_from + " — " + r.equity_to) : "—", "lib-period");
  const symWrap = libEl("span"); symWrap.append(...libSymbolNodes(s)); dd(t("lib.meta.symbol"), symWrap);
  if (s.direction && LIB_DIR_KEYS[s.direction]) dd(t("lib.meta.direction"), t(LIB_DIR_KEYS[s.direction]));
  if (typeof s.max_exposure === "number") dd(t("lib.meta.exposure"), libRich("lib.exposure", { n: libMono(String(+s.max_exposure.toFixed(2))) }));
  c3.appendChild(dl); det.appendChild(c3);
  if (chartHost) libChartDraw(chartHost, r);
  if (r) libReportLoad(s);   // 兩段式:先用 64 點 spark 畫,/report 回來換 400 點——同一支才動、只換曲線與回測期間,不整頁重畫
}
function libReportLoad(s) {
  let p = LIB.reports.get(s.id);
  if (!p) {
    p = window.blave.libraryReport(s.id, LANG).then((rep) => (rep && typeof rep === "object" ? rep : null)).catch(() => null);
    LIB.reports.set(s.id, p);
    p.then((rep) => { if (!rep) LIB.reports.delete(s.id); });   // 失敗不記:下次進詳情再問(主行程失敗也不記,會真的再打一次);畫面停在 spark、不出錯誤字
  }
  p.then((rep) => { if (rep && !$("lib").hidden && libBag().detail === s.id) libReportApply(rep, s); });
}
function libReportApply(rep, s) {
  const det = $("lib-det"), bm = rep.benchmark && typeof rep.benchmark === "object" ? rep.benchmark : null;
  const curve = rep.equity ? { spark: rep.equity, equity_from: rep.equity_from, equity_to: rep.equity_to, bench: bm ? bm.equity : null } : null;
  if (curve && libCurve(curve.spark, curve.equity_from, curve.equity_to)) {   // 先確認畫得出來:換不成就留著 spark,不能從有圖退成沒圖
    let host = $("lib-chart");
    if (host) libChartDrop();
    else { const none = det.querySelector(".lib-card .chart-none"); if (none) { host = libEl("div", "chart"); host.id = "lib-chart"; none.replaceWith(host); } }
    // 圖例跟著第二條線一起出(spec library-benchmark §2 兩段式):線沒畫成就不出,不預留空的圖例列
    if (host && libChartDraw(host, curve) && host.isConnected) host.before(libBenchLegend(bm));
  }
  if (bm) libBenchTable(bm, s);
  const per = $("lib-period");
  if (per && rep.backtest_start && rep.backtest_end) { per.textContent = ""; per.appendChild(libMono(rep.backtest_start + " — " + rep.backtest_end)); }
}
function libCtaMain() { const c = $("lib-cta"); return c ? c.querySelector(".btn-fill, .btn-out") : null; }
function libPaintCta(s) {
  const box = $("lib-cta"); if (!box) return;
  const hadFocus = box.contains(document.activeElement);   // 重畫前焦點在鈕上:畫完還給新的主鈕(§3 末,同 libPurchase)
  box.textContent = "";
  const c = libCtaOf(s), row = libEl("div", "row"), note = libEl("p", "note"); note.id = "lib-cta-note";
  const under = [];   // 直接開付款頁的鈕下那一行續扣,跟著鈕、不佔訊息槽
  const btn = (cls, label, on) => { const b = libEl("button", cls, label); b.type = "button"; if (on) b.addEventListener("click", () => on(b)); return b; };
  const dis = (label) => { const b = btn("btn-fill", label); b.disabled = true; return b; };
  const buyLabel = () => t("lib.buy", { price: libPriceText(s) || "—" });
  // 下載撞到 key 被撤(有 token、沒有能用的 key):再按安裝一樣撞,主鈕換成重新登入;已安裝那格主鈕仍是打開,換掉的是再下載那顆
  const dl = LIB.dlFail && LIB.dlFail.id === s.id && libEnv() === "local" ? LIB.dlFail : null, relogin = !!dl && (dl.kind === "signin" || dl.relogin === true);
  const bb = LIB.bbRes.get(s.id) || null;
  const bbGone = c.state === "paid" && !!bb && bb.kind === "wallet" && bb.code === "unavailable";
  switch (relogin && ["free", "owned", "paid"].includes(c.state) ? "relogin" : bbGone ? "bbGone" : c.state) {
    case "relogin": row.appendChild(libSignInBtn("fault.authBtn")); break;
    case "signedOut": {   // 鈕寫動作與金額(spec library-free-data-one-step §2.1;金額寫實刷的 TWD);鈕下:要資料的免費 → 試用與方案價(下面訊息槽),其餘空白
      const key = libSignedOutKey(s, c.paid);
      // C(不用資料的付費策略):登入後沒卡、報價金額等於鈕上就直接開付款頁(沒有續扣)。換算幣(en 價格寫 USD)一律出框,同網頁與已登入那條
      const dc = key === "lib.bb.loginBuy" && !libFx() && libNeeds(s) === "none" && Number.isInteger(s.price) && s.price > 0;
      row.appendChild(libSignInBtn(null, null, t(key, { p: key === "lib.bb.loginBuy" ? libTwd(s.price) : "" }), dc ? s.price : undefined));
      if (key === "lib.bb.loginUse") { const v = libLoginUseVars(); if (v) note.textContent = t("lib.bb.loginUseNote", v); }
      break;
    }
    case "noData": row.appendChild(libGateBtn(c.why)); note.classList.add("up"); note.textContent = libNoDataText(s, c.why); break;
    /* 一步開通:鈕上寫這次要付的合計(方案第一期＋還沒買的策略價);框裡的數字以報價為準。
       沒卡、錢包不夠合計(會走付款頁):按下去不出框 ③、直接開付款頁(Wei 11-09)。鈕下一行講續扣:D 寫之後每 30 天多少;B 的鈕字已寫每 30 天多少,只講可取消 */
    case "planBuy": {
      const x = libCtx(), total = (c.paid ? s.price : 0) + x.planTwd, direct = x.noCard === true && typeof x.bal === "number" && x.bal < total;
      row.appendChild(btn("btn-fill", t(c.paid ? "lib.bb.planD" : "lib.bb.planB", { p: libTwd(total) }), (b) => libPlanBuy(s, b, direct ? { direct: total } : undefined)));
      under.push(libEl("p", "note", c.paid ? t("lib.bb.renewNote", { p: libTwd(x.planTwd) }) : t("lib.bb.cancelNote")));
      break;
    }
    // 名下有主機:方案在主機那邊,到網站恢復;句子只講原因(設計稽核 web-one-step #5)
    // 鈕會開瀏覽器離開 app:用設定頁同一顆〔到網站恢復方案〕(設計稽核 desktop-one-step #3)
    case "planResume": row.appendChild(btn("btn-fill", t("plan.resumeWeb"), () => planWebGo())); note.textContent = t("lib.bb.hasServer"); break;
    case "planWait": note.textContent = t("lib.bb.unsettled"); break;   // 上一筆方案扣款還在確認:叫人等,不給鈕
    case "stopped": case "stale": row.appendChild(dis(c.paid ? buyLabel() : t("lib.use"))); note.textContent = t(c.state === "stopped" ? "ho.gate.stopped" : "ho.gate.stale"); break;
    case "pending": row.appendChild(dis(t("lib.pending"))); break;   // 鈕本身說了進行中,鈕下不再補「進度在右邊的對話」(Wei 10-17)
    case "buying": row.appendChild(dis(t("lib.buy.busy"))); break;
    case "bindWait": {   // 原型態 4:付款頁在瀏覽器,付完輪詢會自己換;可以重開一張(作廢舊的)
      const b = dis(""), sp = libEl("span", "spin16"); sp.setAttribute("aria-hidden", "true"); b.append(sp, t("lib.bb.waiting")); row.appendChild(b);
      note.setAttribute("role", "status");
      note.append(t("lib.bb.waitNote"), LANG === "zh" ? "" : " ", btn("btn-quiet", t("lib.bb.reopen"), (b) => libBbReopenAsk(s, b)));
      break;
    }
    case "installed":
      row.append(btn("btn-fill", t("lib.open"), async () => { await (libEnv() === "cloud" ? rpCloudSelect(c.name) : stratSelect(c.name)); $("rp-name").focus(); }));
      if (relogin) row.appendChild(libSignInBtn("fault.authBtn", "btn-quiet"));
      else if (c.again) row.appendChild(btn("btn-quiet", t("lib.again"), (b) => libAsk(s, b)));
      break;
    case "bbGone": break;   // 綁卡即購買刷了卻因下架沒買成(清單還沒跟上):不給鈕,只留結果句(稽核 ⑥-2)
    case "paid": {
      /* 沒卡、錢包不夠(short):報價跟鈕上鈕下講的對得上才直接開付款頁,否則照舊框 2／框 1。C(不用資料)鈕下空白;
         要資料、有試用資格(方案制的 no_card)鈕下一行試用後續扣。鈕上是換算幣(en 寫 USD)時鈕上沒有實刷的 TWD,不跳框 */
      const sh = c.short && !libFx() && Number.isInteger(s.price) && s.price > 0;
      const tr = c.short && libNeeds(s) !== "none" ? libTrialTerms(libCtx()) : null, ok = sh && (libNeeds(s) === "none" || tr);
      const pb = btn("btn-fill", buyLabel(), (b) => c.short ? libBindBuy(s, b, ok ? { direct: s.price, trial: tr || undefined } : undefined) : libBuyBox(s, "confirm", b, {}));
      if (LIB.buyRead === s.id) { const sp = libEl("span", "spin16"); sp.setAttribute("aria-hidden", "true"); pb.prepend(sp); pb.disabled = true; }   // 開框前讀餘額:鈕字不換
      row.appendChild(pb);
      if (tr) under.push(libEl("p", "note", t("lib.bb.trialRenewNote", { t: String(tr.t), p: libTwd(tr.p) })));
      break;
    }
    case "owned": row.appendChild(btn("btn-fill", t("lib.use"), (b) => libAsk(s, b))); break;
    default:   // free:鈕下不再補「只用公開價格」那句(Wei 10-17)
      row.appendChild(btn("btn-fill", t("lib.use"), (b) => libAsk(s, b)));
  }
  if (row.childNodes.length) box.appendChild(row);
  // 綁卡即購買／刷了沒買成的結果:主鈕下方那一格,不跳框(spec §5)。刷卡失敗是紅記號;錢進錢包是灰記號(錢沒丟)
  // 鈕下最多一行(Wei 11-09):有結果句時只出結果句(同網頁),續扣那一行收起來;重按會重新報價
  /* 付完那句(設計稽核第 4 條):鈕下結果槽、不加記號(灰記號的意思是「沒發生」),12px ink-2。本機會自動安裝,安裝中留著、裝好收掉 */
  if (bb && bb.kind === "paid" && c.state === "installed") LIB.bbRes.delete(s.id);
  const paid = bb && bb.kind === "paid" && c.state !== "installed" ? libEl("p", "note up", libBbText(bb)) : null;
  if (paid) paid.setAttribute("role", "status");
  const bbl = libBbLines(bb);
  if (bbl.length || paid) note.textContent = "";
  else under.forEach((p) => box.appendChild(p));
  note.hidden = !note.textContent;
  box.appendChild(note);
  if (paid) box.appendChild(paid);
  if (bbl.length) {
    const e = libEl("div", "err" + (bb.kind === "failed" || bb.bad ? " is-bad" : "")), m = libEl("span", "fault-mark"), d = libEl("div");
    m.setAttribute("aria-hidden", "true"); e.setAttribute("role", "status");
    bbl.forEach((l) => d.appendChild(libEl("p", "", libBbText(l))));
    e.append(m, d); box.appendChild(e);
  }
  /* 付款頁回來、這次同時綁了卡:自動儲值預設開著,在這裡講一次(詳情頁鈕下不講)。電腦版沒有讀／改自動儲值的端點,
     用設定頁同一句(plan.topupShort,「可在網頁關閉」);數字讀不到就不出 */
  const tb = bb && bb.bound ? libBbTopup(typeof pub !== "undefined" && pub ? pub.trial : null) : null;
  if (tb) { const p = libEl("p", "note", t("plan.topupShort", { a: tb.lo, b: tb.a })); p.id = "lib-cta-topup"; box.appendChild(p); }
  if (c.err) { const e = libEl("p", "err"), m = libEl("span", "fault-mark"); m.setAttribute("aria-hidden", "true"); e.append(m, libEl("span", "", t("lib.err.noNew"))); box.appendChild(e); }
  // key 被撤(signin):鈕字〔重新登入 Blave〕已經講了,不另寫一句(中欄 480 會把標題區擠壞;設計稽核 v045)
  if (LIB.dlFail && LIB.dlFail.id === s.id && c.state !== "pending" && LIB.dlFail.kind !== "signin") {
    const e = libEl("p", "err"), m = libEl("span", "fault-mark"); m.setAttribute("aria-hidden", "true"); e.setAttribute("role", "status");
    e.append(m, libEl("span", "", t(libDlKey(LIB.dlFail.kind)))); box.appendChild(e);
  }
  if (hadFocus) { const b = box.querySelector("button:not(:disabled)"); if (b) b.focus(); }   // 停用的(下載中)接不了焦點:那條路由 libSend 自己還
}


/* ── 成功筆記(canon › 說明文章外連):詳情的入口卡,用瀏覽器開網站那一頁。只能連免費筆記(付費的在網站上會跳解鎖牆);清單沒帶 price,外殼判斷不了,靠上架時把關 ── */
function libExtIcon() {   // Lucide arrow-up-right
  const NS = "http://www.w3.org/2000/svg", svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "ic"); svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
  ["M7 7h10v10", "M7 17 17 7"].forEach((d) => { const p = document.createElementNS(NS, "path"); p.setAttribute("d", d); svg.appendChild(p); });
  return svg;
}
function libNoteLink(s) {
  const title = libNoteTitle(s, LANG) || t("lib.note.fallback");   // 清單沒帶標題(舊 api)就寫固定字,入口照出
  const a = libEl("a", "lib-noteln"); a.id = "lib-noteln";
  a.href = "https://blave.org/studio/" + LANG + "/success_note/read/" + libNoteId(s, LANG) + "?src=desktop_note";
  a.setAttribute("aria-label", t("lib.note.aria", { t: title }));
  const l = libEl("span", "l"), go = libEl("span", "go");
  l.append(libEl("span", "k", t("lib.note.k")), libEl("span", "t", title));
  go.appendChild(libExtIcon());
  a.append(l, go);
  a.addEventListener("click", (e) => { e.preventDefault(); window.blave.openExternal(a.href); libTrack("lib_note_web"); });
  return a;
}

/* ── 用這支(規格 §4.1):確認框 → 送一句固定訊息 ── */
/* o.from === "welcome"(歡迎頁①的卡):確定後先切到這支的詳情再送。下載失敗、沒送出、沒新策略只畫在詳情的 #lib-cta,
   從歡迎頁直送的話錯誤畫進藏著的面板(稽核 M1)。焦點由 delClose 先還給卡的 CTA,libShowDetail 再交給詳情的返回鈕 */
function libAsk(s, opener, o) {
  if (libPendingBlocks(s)) return;   // 同一支不起第二個下載;別支本機可以同時裝
  if (typeof envCanSwitch === "function" && !envCanSwitch()) return;   // 別的框開著 / 選字中
  const cloud = libEnv() === "cloud", fee = libFeeLine(libEnv(), LIB.data ? LIB.data.dataAccess : null, libNeeds(s));
  const again = libCtaOf(s).state === "installed";   // 頁首拿掉了覆蓋說明,改在按下「再下載一份」後的框裡講
  confirmBox({
    title: t(again ? "lib.cf.titleAgain" : "lib.cf.title", { title: s.title }),
    lines: [...(again ? [t("lib.cf.l0Again", { where: libWhere() })] : []), t(cloud ? "lib.cf.l1" : "lib.cf.l1Local"), ...(fee ? [t("lib.note.billed")] : [])],
    ok: t(again ? "lib.cf.okAgain" : "lib.cf.ok"), opener, env: cloud ? "cloud" : undefined, footWhere: cloud ? t("lib.cf.cloudNote") : undefined,
    onOk: o && o.from === "welcome" ? async () => { await libOpen({ silent: true }); libShowDetail(s.id); libSend(s, { from: "welcome" }); } : () => libSend(s),
  });
  $("del-title").title = $("del-title").textContent;   // 只在 CSS 截一次(單行 ellipsis),全文放 title
}
/* 送出:這條對話還沒講過話就送在這條,否則開新對話;成功(跑起來)才記進行中與 library_use。
   本機先由外殼代下載(§4.2;主行程 libraryDownload 寫 workspace/tmp/library_<id>.py),成功才送 lib.msgLocal——
   那句是 runtime 契約(references/marketplace.md › Desktop-downloaded picks)。雲端照舊送 lib.msg / lib.msgPaid,外殼寫不進雲端主機 */
async function libSend(s, o) {
  if (libPendingBlocks(s)) return;
  const env = libEnv(), local = env !== "cloud";
  const msg = libMsg(s, t(local ? "lib.msgLocal" : libIsFree(s) ? "lib.msg" : "lib.msgPaid"));
  if (!msg) return;
  if (typeof paneSt !== "undefined" && paneSt.chat.off) paneToggle("chat", false);   // 聊天欄收著就先展開:過程在那裡回報
  const cl = env === "cloud" ? libCloudList() : RP.list, before = cl ? new Map(cl.map((x) => [x.name, env === "cloud" ? x.mtime : x.codeMtime])) : null;   // 本機比程式碼的 mtime(mtime 含 stats／scan,別支更新績效會被當成這支裝好);雲端只有 mtime,清單缺席就不記(之後不猜)
  if (env === "cloud") LIB.cloudWait = null;   // 上一支還在等清單跟上就放掉:寧可它沒標「已安裝」,也不能把第二支的資料夾記到第一支
  LIB.dlFail = null;
  let send = msg, opts;
  if (local) {
    // 送出對象在按下去那一刻定案:下載那一兩秒裡切到雲端視角,這句也不能變成送給雲端主機(那邊沒有 tmp/library_<id>.py)
    opts = { viewing: typeof chatViewing === "function" ? chatViewing() : { env: "local" } };
    libPendingSet(s.id, { id: s.id, env, before, stage: "dl" }); LIB.noNew = null; libSync();
    let r = null;
    try { r = await window.blave.libraryDownload(s.id); } catch (_) { r = null; }
    if (!r || r.ok !== true) {
      LIB.pending.delete(s.id);
      const kind = r && ["blocked", "gone", "signin", "rateLimited", "agentOld", "agentOldReopen"].includes(r.kind) ? r.kind : "fail";
      if (kind === "agentOld" || kind === "agentOldReopen") libBlocked("agent_old");   // 想用但這台 lib 太舊(api 交付碼前擋下)
      if (kind === "gone") libInvalidate();   // 下架了:清單重拉(先清再記,libInvalidate 會把 dlFail 清掉)
      LIB.dlFail = { id: s.id, kind };
      libSync(); const b = libCtaMain(); if (b) b.focus();
      return;
    }
    if (r.legacy) {   // workspace 還是舊契約:照舊由 agent 自己下載
      send = libMsg(s, t(libIsFree(s) ? "lib.msg" : "lib.msgPaid"));
      if (!send) { LIB.pending.delete(s.id); libSync(); return; }
    }
    LIB.pending.get(s.id).stage = "turn"; libSync();
  }
  const sent = csSendAway(send, opts), at = CS.away;
  if (LIB.pending.has(s.id)) LIB.pending.get(s.id).sid = at.sid;   // 代下載那段的 pending(stage turn)也只認這一條
  sent.then((ok) => {
    if (ok) {
      libPendingSet(s.id, { id: s.id, env, before, sid: at.sid }); LIB.noNew = null; libTrack("library_use");
      if (o && o.from === "welcome") libTrack(local ? "wcard_use" : "wcard_use_cloud");
      // 這支的資料需求(§8):只在本機送——雲端沒有資料牆,這個屬性在那邊沒有意義
      if (local) { try { window.blave.trackEvent("lib_pick", { data: libPickData(s) }); } catch (_) { } }
    }
    else if (local) { LIB.pending.delete(s.id); LIB.dlFail = { id: s.id, kind: "unsent" }; }   // 下載中有別句先送出(回合在跑)等:講出來,不靜默
    libSync();
    // 回合送出了,但引擎是 Blave AI 而帳號不能跑:下一步就是 402(按了「使用」但被擋)
    const a = typeof acct !== "undefined" ? acct : null;
    if (ok && typeof cur !== "undefined" && cur === "blave" && a && a.can_run === false) libBlocked(a.reason === "NO_CREDIT" ? "ai_no_credit" : "ai_no_card");
  });
}

/* ── 購買(規格 §4.4):兩段確認框對齊網頁 libBuy / libPurchase;憑證只在主行程 ── */
function libBuyBox(s, stage, opener, o) {
  if (LIB.buying !== null) return;
  // 任何一支裝到一半都不開購買(碰錢不放寬;代下載中買完接著的 libSend 可能被擋掉,變成付了錢卻沒裝)
  if (LIB.pending.size) { const n = $("lib-cta-note"); if (n) { n.textContent = t("lib.buyWait"); n.hidden = false; } return; }
  if (typeof envCanSwitch === "function" && !envCanSwitch()) return;
  if (stage === "confirm" && !o.failed && !o.legacy) { libBuyOneOpen(s, opener); return; }   // 一鍵框;餘額或卡讀不到才回下面的兩段
  const price = libPriceText(s) || "—", title = t("lib.buy.title", { title: s.title });
  if (stage === "confirm") {
    const lines = [t("lib.buy.price", { price })];
    const extra = document.createDocumentFragment();
    extra.appendChild(libEl("p", "cf-note", t("lib.buy.lead")));
    if (libFeeLine(libEnv(), LIB.data ? LIB.data.dataAccess : null, libNeeds(s))) extra.appendChild(libEl("p", "cf-note", t("lib.note.billed")));   // 條件同 libAsk:雲端的資料費已併進主機費
    if (libFx()) extra.appendChild(libEl("p", "cf-note", t("lib.fxNote")));   // fx 註是註,不跟價格同一階
    // 失敗行不寫「沒有扣款」:網路類失敗無法確定;重按由 api 的 already-purchased 擋重複扣款
    if (o.failed) { const e = libEl("p", "plan-err is-calm"), m = libEl("span", "fault-mark"); m.setAttribute("aria-hidden", "true"); e.setAttribute("role", "status"); e.append(m, libEl("span", "", t("lib.buy.failed"))); extra.appendChild(e); }
    confirmBox({ title, lines, extra, ok: t("lib.buy.ok"), opener, onOk: () => libPurchase(s, o.confirmTopup === true) });
  } else if (stage === "topup") {
    confirmBox({ title, lines: [t("lib.buy.topup", { balance: libBalanceText(o.balance), price })], ok: t("lib.buy.charge"), opener, onOk: () => libPurchase(s, true) });
  } else if (stage === "noCard") {
    confirmBox({ title, lines: [t("lib.buy.noCard")], ok: t("acct.addCard"), opener, onOk: () => { libTrack("bind_lib"); planOpen(); } });
  } else {
    confirmBox({ title, lines: [t("lib.buy.inProgress")], ok: t("cdel.gotIt"), single: true, opener, onOk: () => {} });
  }
  $("del-title").title = $("del-title").textContent;
}
async function libPurchase(s, confirmTopup) {
  if (LIB.buying !== null) return;
  LIB.buying = s.id; LIB.bbRes.delete(s.id); libSync();
  // 購買中:框不關、兩顆鈕都停用、Esc / ✕ / 框外都無效(delClose 看 dataset.lock)——扣款在路上,不讓人關框重按
  const busy = libEl("p", "cf-busy"), sp = libEl("span", "spin16"); sp.setAttribute("aria-hidden", "true"); busy.append(sp, t("lib.buy.busy"));
  confirmBox({ title: t("lib.buy.title", { title: s.title }), lines: [t("lib.buy.price", { price: libPriceText(s) || "—" })], extra: busy, ok: t("lib.buy.busy"), okDisabled: true, onOk: () => {} });
  const sc = $("del-scrim"); sc.dataset.lock = "1"; $("del-cancel").disabled = true; $("del-close").disabled = true;
  let r = null;
  try { r = await window.blave.libraryPurchase(s.id, confirmTopup === true); } catch (_) { r = null; }
  delete sc.dataset.lock; $("del-cancel").disabled = false; $("del-close").disabled = false;
  delClose(false);
  LIB.buying = null;
  const branch = libBuyBranch(r ? r.status : 0, r ? r.body : null);
  if (branch === "ok" || branch === "inProgress") LIB.stale = true;   // purchased 變了:主行程那份已作廢,這裡也標
  // 鈕上已經寫了「並使用」:不再開下載框;自動送跟付款頁、框 ② 同一道判斷(雲端視角、會多扣錢就停在已購買,複稽 2 P2)
  if (branch === "ok") { s.purchased = true; libSync(); const b = libCtaMain(); if (b) b.focus(); libAutoInstall(s); libRefresh(); return; }
  if (branch === "charged") {   // 卡刷了、沒買成:照實講錢在錢包;已買過的就是已購買,不自動安裝
    const out = libBbCharged(r.body); LIB.bbRes.set(s.id, out); LIB.stale = true;
    if (out.code === "already_purchased") s.purchased = true;
    libSync(); const b = libCtaMain(); if (b) b.focus(); libRefresh(); libBalLoad(); return;
  }
  libSync();
  const opener = libCtaMain();
  if (branch === "topup") libBuyBox(s, "topup", opener, { balance: r.body.balance });
  else if (branch === "noCard") libBindBuy(s, opener);
  else if (branch === "inProgress") libBuyBox(s, "inProgress", opener, {});
  else if (branch === "negative") libBuyOneBox(s, { price: s.price, source: "card", msg: "negative" }, opener);   // 舊兩段框的第二段(帶 confirm_topup)也會撞到
  else libBuyBox(s, "confirm", opener, { failed: true, confirmTopup });
}

/* ── 一鍵購買框(A 帳單式,designer purchase-confirm-2026-11-10):開框前就決定扣款來源(錢包夠 → 錢包;不夠又有卡 → 卡),
   按一次就扣;付款中、失敗、金額或來源變了都留在同一個框(stay),只有成功／刷了沒買成／要綁卡才關。
   餘額讀不到、不知道有沒有卡、價格不是正整數:退回上面的兩段流程(o.legacy),不帶核對欄位 ── */
function libHasCard() {
  const a = typeof acct !== "undefined" ? acct : null;
  if (!a) return null;
  return a.has_card === true ? true : typeof acctNoCard === "function" && acctNoCard(a) ? false : null;
}
async function libBuyOneOpen(s, opener) {
  const price = Number.isInteger(s.price) && s.price > 0 ? s.price : null;
  if (price === null) { libBuyBox(s, "confirm", opener, { legacy: true }); return; }
  if (typeof LIB.bal !== "number") {
    if (LIB.buyRead != null) return;
    // 讀餘額時主鈕真 disabled＋鈕內轉圈、鈕字不換(設計稽核 purchase-box 第 7 條);狀態放 LIB,中途重畫的新主鈕照樣畫成讀取中
    LIB.buyRead = s.id; libSync();
    try { await libBalLoad(); } finally { LIB.buyRead = null; libSync(); }
    // 讀餘額那一下用戶可能已經離開這支、開了別的框或開始裝
    if (LIB.buying !== null || LIB.pending.size || $("lib").hidden || libBag().detail !== s.id || (typeof envCanSwitch === "function" && !envCanSwitch())) return;
  }
  const bal = LIB.bal;
  let card = libHasCard();
  if (card === null && LIB.last4) card = true;   // 帳號狀態還沒回來時,餘額那支回了末四碼也算有卡
  // 錢包不夠又已知沒卡也走舊流程:它收 402 再進綁卡即購買;這裡直接跳 libBindBuy 會跟報價回的 HAS_CARD 互相丟回來
  const source = typeof bal !== "number" ? null : bal >= price ? "wallet" : card === true ? "card" : null;
  if (!source) { libBuyBox(s, "confirm", libCtaMain() || opener, { legacy: true }); return; }
  // 錢包是負的又要走卡:api 一定回 BALANCE_NEGATIVE,不畫一個按了必被拒的〔付 N〕框,直接畫那一態
  libBuyOneBox(s, { price, source, msg: source === "card" && bal < 0 ? "negative" : undefined }, libCtaMain() || opener);
}
/* q = { price, source, msg?: changed | failed | inProgress | negative }。msg 是框底唯一的訊息槽(互斥,設計稽核第 1、3、6 條):
   失敗、錢包是負的紅記號;剛變了、處理中灰記號。兩態都不給付款鈕(再按只會再撞一次 409):處理中只留〔知道了〕;
   錢包是負的主鈕〔前往儲值〕＋取消,也不寫「一次付清」(這一態不付錢) */
const LIB_PB_MSG = { changed: "lib.pb.changed", failed: "lib.buy.failed", inProgress: "lib.buy.inProgress", negative: "lib.pb.negative" };
function libBuyOneBox(s, q, opener) {
  const extra = document.createDocumentFragment();
  extra.appendChild(libEl("p", "lib-pb-nm", s.title));
  const dl = libEl("dl", "cf-rows lib-pb-rows"), row = (k, v, cls, ddCls) => { const r = libEl("div", "cf-row" + (cls ? " " + cls : "")); r.append(libEl("dt", "", k), libEl("dd", ddCls || "", v)); dl.appendChild(r); };
  row(t("lib.pb.price"), libTwd(q.price), "lead");
  row(t("lib.pb.pay"), q.source === "wallet" ? t("lib.pb.wallet") : LIB.last4 ? t("lib.pb.card", { l: "••" + LIB.last4 }) : t("lib.pb.cardAny"), "", "sans");
  extra.appendChild(dl);
  if (q.msg !== "negative") extra.appendChild(libEl("p", "lib-pb-fine", t("lib.pb.once")));   // 負餘額這一態不付錢
  if (libFeeLine(libEnv(), LIB.data ? LIB.data.dataAccess : null, libNeeds(s))) extra.appendChild(libEl("p", "lib-pb-fine", t("lib.note.billed")));   // 條件同 libAsk:雲端的資料費已併進主機費
  // 失敗句不寫「沒有扣款」:網路類失敗無法確定;重按由 api 的 already-purchased 擋重複扣款
  const msg = LIB_PB_MSG[q.msg], bad = q.msg === "failed" || q.msg === "negative";
  if (msg) { const e = libEl("p", "plan-err lib-pb-err" + (bad ? "" : " is-calm")), m = libEl("span", "fault-mark"); m.setAttribute("aria-hidden", "true"); e.setAttribute("role", "status"); e.append(m, libEl("span", "", t(msg))); extra.appendChild(e); }
  if (q.msg === "inProgress") confirmBox({ title: t("lib.pb.title"), lines: [], extra, ok: t("cdel.gotIt"), single: true, opener, onOk: () => {} });
  // 負餘額:給一條去補的路(設計複稽核 r2 §2),同設定頁方案卡的〔前往儲值〕(app.js plan.err.credit);另留取消
  else if (q.msg === "negative") confirmBox({ title: t("lib.pb.title"), lines: [], extra, ok: t("plan.addCredit"), opener, onOk: () => bindGo("topup_set") });
  else confirmBox({ title: t("lib.pb.title"), lines: [], extra, ok: t("lib.bb.pay", { p: libTwd(q.price) }), opener, stay: true, onOk: () => libBuyOneGo(s, q, opener) });
  $("del-title").title = $("del-title").textContent;
}
async function libBuyOneGo(s, q, opener) {
  if (LIB.buying !== null) return;
  LIB.buying = s.id; LIB.bbRes.delete(s.id); libSync();
  // 付款中:框不關、取消與 ✕ 停用、Esc／框外無效(delClose 看 dataset.lock)。主鈕只用 aria-disabled(delOkBusy),焦點留在鈕上;重按由 LIB.buying 擋
  const sc = $("del-scrim"), ok = $("del-ok"), ctx = typeof delCtx !== "undefined" ? delCtx : null;
  sc.dataset.lock = "1"; $("del-cancel").disabled = true; $("del-close").disabled = true;
  const busyLabel = t("lib.bb.paying"); ok.textContent = busyLabel; delOkBusy(true);
  let r = null;
  try { r = await window.blave.libraryPurchase(s.id, q.source === "card", { price: q.price, source: q.source }); } catch (_) { r = null; }
  delete sc.dataset.lock; $("del-cancel").disabled = false; $("del-close").disabled = false;
  LIB.buying = null;
  // 付款中框被別的框換掉(confirmBox 不看 lock,例如結束 app 的確認):結果寫到主鈕下,不收別人的框、不把購買框蓋回來(同 web cfCloseSeq／mine)
  const mine = !sc.hidden && (typeof delCtx === "undefined" || delCtx === ctx);
  const shut = () => { if (mine) delClose(false); };
  const body = r && r.body ? r.body : {}, branch = libBuyBranch(r ? r.status : 0, r ? r.body : null), main = () => libCtaMain() || opener;
  const box = (next) => { if (mine) { libBuyOneBox(s, next, main()); return; } LIB.bbRes.set(s.id, { kind: "note", key: LIB_PB_MSG[next.msg], bad: next.msg === "failed" || next.msg === "negative" }); libSync(); };
  if (branch === "ok" || branch === "inProgress") LIB.stale = true;
  if (branch === "ok") {
    shut(); s.purchased = true;
    // 只有 200 才真的扣了;400 already purchased 是別處已買過,這次沒扣。扣款來源以 api 回的 paid_from 為準,舊 api 沒這欄才照框上的
    const from = body.paid_from === "wallet" || body.paid_from === "card" ? body.paid_from : q.source;
    if (r.status === 200) LIB.bbRes.set(s.id, { kind: "paid", key: from === "card" ? "lib.pb.doneCard" : "lib.pb.doneWallet", p: q.price });
    libSync(); const b = libCtaMain(); if (b && mine) b.focus(); libAutoInstall(s); libRefresh(); libBalLoad(); return;
  }
  if (branch === "charged") {   // 卡刷了、沒買成:照實講錢在錢包;已買過的就是已購買,不自動安裝
    shut();
    const out = libBbCharged(body); LIB.bbRes.set(s.id, out); LIB.stale = true;
    if (out.code === "already_purchased") s.purchased = true;
    libSync(); const b = libCtaMain(); if (b && mine) b.focus(); libRefresh(); libBalLoad(); return;
  }
  if (branch === "noCard") { shut(); libSync(); libBindBuy(s, main()); return; }
  libSync();
  if (branch === "changed") {
    // 收到的是現在的條件:價格、餘額、有沒有卡都跟上,清單與詳情的價格一起換(同 web)
    const np = typeof body.price_twd === "number" && body.price_twd > 0 ? body.price_twd : null;
    if (np !== null) s.price = np;
    if (typeof body.balance_twd === "number") LIB.bal = body.balance_twd;
    if (typeof acct !== "undefined" && acct && (body.price_source === "card" || body.price_source === "none")) acct = { ...acct, has_card: body.price_source === "card" };   // 409 一律帶 has_card;libPurchaseBody 把缺欄收成 false,所以改看 price_source
    libSync();
    if (body.price_source === "none") { shut(); libSync(); libBindBuy(s, main()); return; }   // 錢包不夠、卡也沒了:綁卡即購買
    // 新價不是整數:一鍵框只送整數金額,用舊價重畫會一直撞 409;退回舊兩段流程(不帶核對欄位)
    if (np !== null && !Number.isInteger(np)) { shut(); if (mine) libBuyBox(s, "confirm", main(), { legacy: true }); else box({ msg: "changed" }); return; }
    if (body.price_source === "wallet" || body.price_source === "card") { box({ price: np !== null ? np : q.price, source: body.price_source, msg: "changed" }); return; }
  } else if (branch === "topup") { box({ price: q.price, source: "card", msg: "changed" }); return; }   // 舊 api:錢包框送出時錢包已不夠
  else if (branch === "inProgress") { box({ price: q.price, source: q.source, msg: "inProgress" }); return; }
  else if (branch === "negative") { if (typeof body.balance_twd === "number") LIB.bal = body.balance_twd; box({ price: q.price, source: "card", msg: "negative" }); return; }
  box({ price: q.price, source: q.source, msg: "failed" });
}

/* ── 綁卡即購買(spec library-buy-with-bind-2026-11-06;原型 prototype-library-buy-with-bind):沒卡又錢包不夠 → 報價 → 框 1／2／3 →
   瀏覽器付款 → 輪詢結果,放主鈕下方;回 app 不自動安裝。金額一律從 api 讀;卡刷的是 TWD,en 也照 TWD 寫(不換算) ── */
const LIB_BB_POLL_MS = 5000;   // 電腦版查結果每分鐘 30 次上限,這裡 12 次
const LIB_BB_WAIT_MS = 30 * 60 * 1000;   // 付款單效期(§3.6);過了還沒結果就停,主鈕回原樣
function libTwd(n) { return new Intl.NumberFormat(LANG === "zh" ? "zh-TW" : "en-US", { maximumFractionDigits: 0 }).format(n) + " TWD"; }
// 一句結果的字(純文字,進 .err 的 <p>):{p} 金額、{d} 試用到期日
function libBbText(l) { return t(l.key, { p: l.p != null ? libTwd(l.p) : "", d: l.d || "" }); }
function libBbTrack(step) { try { window.blave.trackEvent("lib_bindbuy", { step }); } catch (_) { } }
function libBpTrack(step) { try { if (step) window.blave.trackEvent("lib_bindplan", { step }); } catch (_) { } }
function libCpTrack(step) { try { window.blave.trackEvent("lib_cardplan", { step }); } catch (_) { } }
function libBbNote(id, key) { LIB.bbRes.set(id, { kind: "note", key }); libSync(); }
/* o.direct:鈕上金額。沒欠費、不動既有方案續期、金額相同才不出框:只買(o 沒帶 trial)→ 不出框 2;
   o.trial = 鈕下講的試用天數與每 30 天價,報價開試用且兩個數字都相同 → 不出框 1。其餘照舊出框 */
async function libBindBuy(s, opener, o) {
  if (LIB.buying !== null) return;
  LIB.buying = s.id; libSync();
  let r = null;
  try { r = await window.blave.libraryBindBuy(s.id, { lang: LANG }); } catch (_) { r = null; }   // 不帶 confirm = 報價,錢不動
  if (typeof pubLoad === "function") { try { await pubLoad(); } catch (_) { } }   // 自動儲值那句的數字(一小時快取)
  LIB.buying = null; libSync();
  const q = libBbBox(r ? r.status : 0, r ? r.body : null);
  const tr = o && o.trial, same = !!(o && o.direct) && q.price === o.direct && !q.due && !q.renew;
  if (same && (tr ? q.kind === "trial" && q.trialDays === tr.t && q.planMonthly === tr.p : q.kind === "plain")) { libBindBuyGo(s, q, LIB.bbRestart.has(s.id)); return; }
  libBindBuyBox(s, q, libCtaMain() || opener);
}
function libBindBuyBox(s, q, opener) {
  const title = t("lib.buy.title", { title: s.title });
  if (q.kind === "planpay" || q.kind === "block" || q.kind === "refresh") { libPlanNext(s, q, opener); return; }   // 一步開通的單(帶 accept_plan 才會拿到)
  if (q.kind === "has_card") { libBuyBox(s, "confirm", opener, {}); return; }
  if (q.kind === "owned") { s.purchased = true; LIB.stale = true; libSync(); libRefresh(); return; }
  if (q.kind === "rate" || q.kind === "open") { libBbNote(s.id, q.kind === "rate" ? "lib.bb.rate" : "lib.bb.open"); return; }
  const lede = (key, n) => { const p = libEl("p", "cf-lede"); p.appendChild(libRich(key, { p: libMono(libTwd(n)) })); return p; };
  const extra = document.createDocumentFragment(), tu = libBbTopup(typeof pub !== "undefined" && pub ? pub.trial : null);
  if (q.kind === "plan") {   // 決定 2:沒試用資格又沒方案、這支要資料:不給買,開方案頁
    extra.appendChild(lede("lib.bb.needPlan", q.planMonthly));
    confirmBox({ title, lines: [], extra, ok: t("lib.bb.planBtn"), opener, onOk: () => { libTrack("plan_lib"); planOpen(); } });
  } else if ((q.kind === "trial" || q.kind === "plain") && !tu) { libBuyBox(s, "noCard", opener, {}); return;   // 自動儲值的數字讀不到:不在沒講清楚的情況下讓人綁卡,退回舊框(同網頁)
  } else if (q.kind === "trial" || q.kind === "plain") {
    if (q.kind === "trial") {   // 決定 1:這支要資料、現在沒資料權限、有試用資格 → 順便開試用
      const dl = libEl("dl", "cf-rows bb"), row = (k, v, cls, ddCls) => { const r = libEl("div", "cf-row" + (cls ? " " + cls : "")); r.append(libEl("dt", "", k), libEl("dd", ddCls || "", v)); dl.appendChild(r); };
      row(t("lib.bb.today"), libTwd(q.price), "lead");
      if (q.trialDays) row(t("lib.bb.trialRow", { d: String(q.trialDays) }), t("lib.free"), "", "sans");
      if (q.planMonthly) row(t("lib.bb.after"), libTwd(q.planMonthly));
      extra.appendChild(dl);
    } else extra.appendChild(lede("lib.bb.plain", q.price));
    // 欠費句緊貼「今天刷多少」:同一張卡今天會多刷的錢(稽核 ⑦)
    if (q.due) { const p = libEl("p", "cf-due"); p.appendChild(libRich("lib.bb.due", { p: libMono(libTwd(q.due)) })); extra.appendChild(p); }
    if (q.kind === "trial") extra.appendChild(libEl("p", "", t("lib.bb.trialNote")));
    // 有方案、沒綁卡的人(api 報價的 plan_renews_card):這張卡之後也會被方案續期用到(Wei 11-07)
    if (q.renew) extra.appendChild(libEl("p", "", t("lib.bb.renew")));
    // 這張卡綁上時自動儲值預設開著:一般綁卡那句(網頁 bc_risk_note,逐字同)。tu 在上面已確定讀得到
    extra.appendChild(libEl("p", "", t("lib.bb.topup", tu)));
    confirmBox({ title, lines: [], extra, ok: t("lib.bb.ok"), opener, onOk: () => libBindBuyGo(s, q, LIB.bbRestart.has(s.id)) });
  } else { libBuyBox(s, "noCard", opener, {}); return; }   // 報價拿不到(舊 api、網路):照舊叫他去綁卡
  $("del-title").title = $("del-title").textContent;
}
async function libBindBuyGo(s, q, restart) {
  if (LIB.buying !== null) return;
  LIB.buying = s.id; LIB.bbRes.delete(s.id); libSync();
  // 方案單(框 ③)確認的是合計;一般單照舊確認策略價
  const plan = q.kind === "planpay";
  const opts = plan ? { lang: LANG, acceptPlan: true, confirmTotal: q.total, free: q.price === 0, restart: restart === true } : { lang: LANG, confirm: q.price, restart: restart === true };
  let r = null;
  try { r = await window.blave.libraryBindBuy(s.id, opts); } catch (_) { r = null; }
  LIB.buying = null;
  if (r && r.opened) {
    LIB.bbRestart.delete(s.id);
    if (plan) libBpTrack(q.price === 0 ? "start_free" : "start_paid"); else libBbTrack("start");
    LIB.bbWait = { id: s.id, q: plan ? Object.assign({}, q, { plan: true, free: q.price === 0 }) : q, until: Date.now() + LIB_BB_WAIT_MS }; libSync();
    libBbPollSoon(LIB_BB_POLL_MS);
    return;
  }
  const q2 = libBbBox(r ? r.status : 0, r ? r.body : null);
  if (q2.kind === "open") LIB.bbRestart.add(s.id);
  // 方案單在報價之後剛好綁了卡:回框 ②(重報價);金額變了、開不了方案、已經有資料:照新條件走
  if (plan && q2.kind === "has_card") { libSync(); libPlanBuy(s, libCtaMain()); return; }
  if (["planpay", "block", "refresh"].includes(q2.kind)) { libSync(); libPlanNext(s, q2, libCtaMain()); return; }
  if (["trial", "plain", "plan", "has_card", "owned"].includes(q2.kind)) { libSync(); libBindBuyBox(s, q2, libCtaMain()); return; }   // 改價、剛變成要方案:用新條件重問,不自動再送
  libBbNote(s.id, q2.kind === "rate" ? "lib.bb.rate" : q2.kind === "open" ? "lib.bb.open" : "lib.buy.failed");
  const m = libCtaMain(); if (m && libFocusFree()) m.focus();
}
/* 重開付款頁 = 開一張新單(restart):藍新同一個訂單號不能再送一次(api agent_plan BIND_PLAN_OPEN_KEY 註解,MPG03008),舊頁也沒被作廢、還付得了。
   所以先講清楚兩頁都付會怎樣再開(程式稽核 N3) */
function libBbReopenAsk(s, opener) {
  const w = LIB.bbWait;
  if (!w) return;
  // 重開 app 後接著等的方案單沒有合計:重報價、重出框 ③(按 OK 才帶 restart 開新單)
  const requote = w.q.plan === true && !w.q.total;
  confirmBox({ title: t("lib.buy.title", { title: s.title }), lines: [t("lib.bb.open")], ok: t("lib.bb.reopen"), opener,
    onOk: requote ? () => { LIB.bbRestart.add(s.id); libPlanBuy(s, libCtaMain()); } : () => libBindBuyGo(s, w.q, true) });
  $("del-title").title = $("del-title").textContent;
}
function libBbPollSoon(ms) { clearTimeout(LIB.bbTimer); LIB.bbTimer = setTimeout(libBbPoll, ms); }
async function libBbPoll() {
  const w = LIB.bbWait;
  if (!w || LIB.bbBusy) return;
  LIB.bbBusy = true;
  // 重開過付款頁、付的卻是舊頁:api 的結果槽被新單佔著,舊單買成了也寫不進(程式稽核 D1)。回前景時與每 30 秒重拉一次清單,買到了就當成功
  w.n = (w.n || 0) + 1;
  if (w.check || w.n % 6 === 0) { w.check = false; try { await libLoad(true); } catch (_) { } }
  const got = LIB.bbWait === w ? libFind(w.id) : null;
  // 方案單不走這條:策略買到不代表方案開了(付了舊頁的方案單,結果照輪詢)
  if (got && got.purchased && !(w.q && w.q.plan)) { LIB.bbBusy = false; libBbDone(w.id, { kind: "ok", code: null, amount: null, trialUntil: null }); return; }
  let r = null;
  try { r = await window.blave.libraryBindResult(); } catch (_) { r = null; }
  LIB.bbBusy = false;
  if (LIB.bbWait !== w) return;
  const out = libBbRes(r ? r.res : null, w.id);
  if (out.kind === "ok" || out.kind === "wallet" || out.kind === "failed") { libBbDone(w.id, out, w.q); return; }
  if ((r && !r.mark) || Date.now() > w.until) { LIB.bbWait = null; LIB.bbRes.set(w.id, { kind: "note", key: "lib.bb.expired" }); libSync(); return; }   // 記號過期或超過付款單效期:不再等,講一句(稽核 ⑤)
  libBbPollSoon(LIB_BB_POLL_MS);
}
// q:等待時的那張單(方案單帶 plan / free;重開 app 後由主行程的記號補)
function libBbDone(id, out, q) {
  clearTimeout(LIB.bbTimer); LIB.bbWait = null;
  if (out.kind === "ok" || out.kind === "wallet") out.bound = true;   // 付款頁付成功 = 卡綁上了(刷卡失敗沒有卡)
  LIB.bbRes.set(id, out);
  const plan = out.plan === true || !!(q && q.plan);
  if (plan) libBpTrack(libBpStep(out, out.plan === true ? out.free : !!(q && q.free))); else libBbTrack(out.kind);
  const s = libFind(id);
  // 免費策略的方案單沒有買東西
  if (s && ((out.kind === "ok" && !(plan && (out.free || (q && q.free)))) || out.code === "already_purchased")) s.purchased = true;
  if (out.kind === "wallet" && out.code === "unavailable") LIB.bbTop = { id, out };
  if (plan && out.planStatus === "failed" && LIB_PLAN_BLOCKS.includes(out.planReason)) LIB.planBlock = out.planReason;   // 名下有主機等:主鈕換恢復方案
  libAfterPay(id, out.kind === "ok");
  if (out.kind === "ok") libAutoInstall(s);
}
/* 付成功自動安裝並回測一次(Wei 11-09,推翻 0.1.49 決定 5;安裝不會開始下單):付款頁與框 ② 共用。本機沒裝過、沒在裝才送;
   切到雲端視角就不送(送出對象會變)。這一回合會讓用戶多被扣錢就不送(libTurnFree),停在已購買讓他自己按 */
async function libAutoInstall(s) {
  const can = () => !!s && libEnv() === "local" && !libInstalledOf(s, "local") && !LIB.pending.has(s.id);
  if (!can()) return;
  const eng = typeof cur !== "undefined" ? cur : null, a = typeof acct !== "undefined" ? acct : null, n = (v) => (typeof v === "number" && isFinite(v) ? v : null);
  let b = null;
  if (eng === "blave") { try { b = await window.blave.balance(); } catch (_) { b = null; } }
  const own = n(a && typeof a === "object" ? a.auto_topup_min : null);   // 帳號狀態那份優先,讀不到用公開價目
  const thr = own !== null ? own : n(typeof pub !== "undefined" && pub && pub.trial ? pub.trial.auto_topup_min : null);
  if (libTurnFree(eng, b, thr, LIB_TURN_EST) && can()) libSend(s);   // 讀餘額那一下切走或開始裝了就不送
}
/* 付完(或框 ② 回來)之後:清單的資料狀態與帳號都重問(主行程已作廢快取)。ok = 都成:重拉期間 bbOk 暫態蓋住資料牆,
   兩份都回來才拿掉;試用或方案真的沒開成(資料權限仍是 none)這時才照實出資料牆。焦點給主鈕(安裝並回測就是下一步) */
function libAfterPay(id, ok) {
  if (ok) LIB.bbOk = id;
  LIB.stale = true;
  const acctP = typeof acctSet === "function" && typeof hasToken !== "undefined" && hasToken
    ? window.blave.accountStatus().then((a) => { if (a && hasToken) { acctSet(a); if (typeof acctPaint === "function") acctPaint(); } }).catch(() => {}) : Promise.resolve();
  libSync();
  Promise.all([acctP, libLoad(true), libBalLoad()]).then(() => { if (LIB.bbOk === id) { LIB.bbOk = null; libSync(); } });
  const m = libCtaMain(); if (m && libFocusFree()) m.focus();
}
// 錢包餘額(主行程 10 秒快取):只拿來判斷「沒卡又不夠」要不要直接出綁卡框;讀不到就 null,照舊走確認框
async function libBalLoad() {
  let r = null;
  try { r = typeof hasToken !== "undefined" && hasToken ? await window.blave.balance() : null; } catch (_) { r = null; }
  const v = r && typeof r.balance === "number" && isFinite(r.balance) ? r.balance : null;
  LIB.last4 = r && typeof r.last4 === "string" ? r.last4 : null;
  if (v !== LIB.bal) { LIB.bal = v; libSync(); }
}
// 付款頁開著時 app 被關掉:進策略庫時問一次主行程的記號,有就接著等(每次 app 開著只問一次)
async function libBbResume() {
  if (LIB.bbResumed || LIB.bbWait) return;
  LIB.bbResumed = true;
  let r = null;
  try { r = await window.blave.libraryBindResult(); } catch (_) { r = null; }
  if (!r || !r.mark || LIB.bbWait) return;
  const out = libBbRes(r.res, r.mark.id), mq = { plan: r.mark.plan === true, free: r.mark.free === true };
  if (out.kind === "ok" || out.kind === "wallet" || out.kind === "failed") { libBbDone(r.mark.id, out, mq); return; }
  const s = libFind(r.mark.id), price = s && typeof s.price === "number" ? Math.round(s.price) : null;
  // 方案單重開付款頁要重報價(合計記號裡沒有):q 只帶 plan,〔重新打開付款頁〕走 libPlanBuy
  LIB.bbWait = { id: r.mark.id, q: mq.plan ? Object.assign({ kind: "planpay" }, mq) : { price }, until: r.mark.at + LIB_BB_WAIT_MS }; libSync();
  libBbPollSoon(LIB_BB_POLL_MS);
}

/* ── 一步開通(spec library-free-data-one-step;原型 prototype-library-free-data-one-step,字以原型為準):沒方案、要資料的策略,
   主鈕一按就把錢的事做完。先問 checkout_quote(唯讀)→ 沒卡又錢包不夠 → 付款頁(bind_purchase 帶 accept_plan、確認合計);
   有卡或錢包夠總額 → 框 ②(card_checkout,確認合計與框上寫的來源)。金額、日期、末四碼全讀 api;按 OK 前不動錢。
   o.direct = 主鈕上寫的合計:報價也是付款頁、合計相同才跳過框 ③(A 案);登入接續、重開付款頁、重報價不帶,照舊出框 ── */
async function libPlanBuy(s, opener, o) {
  if (LIB.buying !== null) return;
  if (LIB.pending.size) { const n = $("lib-cta-note"); if (n) { n.textContent = t("lib.buyWait"); n.hidden = false; } return; }   // 同 libBuyBox:裝到一半不碰錢
  if (typeof envCanSwitch === "function" && !envCanSwitch()) return;
  LIB.buying = s.id; LIB.bbRes.delete(s.id); libSync();
  let r = null;
  try { r = await window.blave.libraryCheckoutQuote(s.id); } catch (_) { r = null; }
  if (typeof pubLoad === "function") { try { await pubLoad(); } catch (_) { } }   // 框 ③ 自動儲值那句的數字
  LIB.buying = null; libSync();
  const q = libPqOf(r ? r.status : 0, r ? r.body : null);
  if (o && o.changed && q.kind === "cardplan") q.changed = true;
  if (o && o.direct && q.kind === "planpay" && q.total === o.direct) { libBindBuyGo(s, q, LIB.bbRestart.has(s.id)); return; }
  libPlanNext(s, q, libCtaMain() || opener);
}
function libPlanNext(s, q, opener) {
  if (q.kind === "planpay" || q.kind === "cardplan") { libPlanBox(s, q, opener); return; }
  if (q.kind === "block") { LIB.planBlock = q.block; libSync(); const m = libCtaMain(); if (m && libFocusFree()) m.focus(); return; }
  if (q.kind === "refresh") { LIB.planBlock = null; libAfterPay(s.id, false); return; }   // 已經有方案或資料、該走試用:重拉,主鈕自己換
  if (q.kind === "gone") { libInvalidate(); return; }
  libBbNote(s.id, q.kind === "rate" ? "lib.bb.rate" : "lib.buy.failed");
  const m = libCtaMain(); if (m && libFocusFree()) m.focus();
}
/* 框 ③(planpay;A 案之後只剩合計跟鈕上不同、或沒帶 direct 的路徑才出)／框 ②(cardplan)同一個形狀(spec §4):兩列金額＋一句。框 ② 那句前面接「今天從哪扣」;框 ③ 不寫來源(鈕〔綁卡並付〕講了),
   最後固定加自動儲值那句(設計稽核 web-one-step #1:凡綁卡的框都有,不計入三行)。付費策略標題同購買框,免費的是「開通 Blave Agent 方案」 */
function libPlanBox(s, q, opener) {
  const pay = q.kind === "planpay", paid = q.price > 0, tu = libBbTopup(typeof pub !== "undefined" && pub ? pub.trial : null);
  if (pay && !tu) { libTrack("plan_lib"); planOpen(); return; }   // 自動儲值的數字讀不到:不在沒講清楚的情況下讓人綁卡,退回方案頁(同 0.1.49 框 1／2 的退法)
  const n0 = (v) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(v);
  const extra = document.createDocumentFragment(), dl = libEl("dl", "cf-rows bb");
  const row = (k, v, cls) => { const r = libEl("div", "cf-row" + (cls ? " " + cls : "")); r.append(libEl("dt", "", k), libEl("dd", "", v)); dl.appendChild(r); };
  if (q.changed) extra.appendChild(libEl("p", "cf-due", t("lib.bb.srcChanged")));   // 錢包剛變了、來源不同了:講為什麼框又出現一次
  row(paid ? t("lib.bb.planToday", { a: n0(q.plan), p: n0(q.price) }) : t(pay ? "lib.bb.todayCard" : "lib.bb.todayPay"), libTwd(q.total), "lead");
  row(q.renewsOn ? t("lib.bb.planRenew", { d: q.renewsOn }) : t("lib.bb.after"), libTwd(q.plan));
  extra.appendChild(dl);
  const src = pay ? null : libPbSrc(q);
  extra.appendChild(libEl("p", "", src ? libJoin(t(src.key, { l: src.l || "" }), t("lib.bb.planTail")) :t("lib.bb.planTail")));
  if (pay) extra.appendChild(libEl("p", "", t("lib.bb.topup", tu)));
  confirmBox({ title: paid ? t("lib.buy.title", { title: s.title }) : t("lib.bb.planTitle"), lines: [], extra, opener,
    ok: t(pay ? "lib.bb.planOk" : "lib.bb.pay", { p: libTwd(q.total) }),
    onOk: pay ? () => libBindBuyGo(s, q, LIB.bbRestart.has(s.id)) : () => libCardGo(s, q) });
  $("del-title").title = $("del-title").textContent;
}
/* 框 ② 按 OK:card_checkout 一次開方案再買策略。扣款在路上時框鎖住(同 libPurchase)。金額或來源變了 → 重報價重出框,不自動重送 */
async function libCardGo(s, q) {
  if (LIB.buying !== null) return;
  LIB.buying = s.id; LIB.bbRes.delete(s.id); libSync();
  const busy = libEl("p", "cf-busy"), sp = libEl("span", "spin16"); sp.setAttribute("aria-hidden", "true"); busy.append(sp, t("lib.bb.paying"));   // 接鈕上的動詞〔付 N〕(設計稽核 desktop-one-step #5)
  confirmBox({ title: q.price > 0 ? t("lib.buy.title", { title: s.title }) : t("lib.bb.planTitle"), lines: [], extra: busy, ok: t("lib.bb.paying"), okDisabled: true, onOk: () => {} });
  const sc = $("del-scrim"); sc.dataset.lock = "1"; $("del-cancel").disabled = true; $("del-close").disabled = true;
  let r = null;
  try { r = await window.blave.libraryCardCheckout(s.id, { total: q.total, planSrc: q.planSrc, priceSrc: q.price > 0 ? q.priceSrc : null }); } catch (_) { r = null; }
  delete sc.dataset.lock; $("del-cancel").disabled = false; $("del-close").disabled = false;
  delClose(false);
  LIB.buying = null;
  const o = libCardOut(r ? r.status : 0, r ? r.body : null), free = q.price === 0, focus = () => { const m = libCtaMain(); if (m && libFocusFree()) m.focus(); };
  if (o.kind === "ok") { libCpTrack(free ? "ok_free" : "ok_paid"); if (!free) s.purchased = true; LIB.planBlock = null; libAfterPay(s.id, true); libAutoInstall(s); return; }
  // 方案成、策略沒成:主鈕回〔購買並使用〕(這時已有方案,就是一般購買)
  if (o.kind === "part") { libCpTrack("part"); LIB.bbRes.set(s.id, { kind: "lines", list: libCardLines(o) }); libAfterPay(s.id, false); return; }
  if (o.kind === "declined") { libCpTrack("failed"); LIB.bbRes.set(s.id, { kind: "failed" }); libSync(); focus(); return; }
  if (o.kind === "requote") { libSync(); libPlanBuy(s, libCtaMain(), { changed: o.changed }); return; }
  if (o.kind === "block" || o.kind === "refresh") { libPlanNext(s, o, libCtaMain()); return; }
  libSync();
  if (o.kind === "inProgress") { libBuyBox(s, "inProgress", libCtaMain(), {}); return; }
  // 打不到或認不得:不寫「沒有扣款」(網路類失敗無法確定);重按時 api 跳過已開的方案、已買的策略
  libBbNote(s.id, o.kind === "rate" ? "lib.bb.rate" : "lib.buy.failed"); focus();
}

/* ── 跟基準比(spec library-benchmark-2026-10-27 B 版):沒有 benchmark 時這裡都不會被叫到,畫面跟以前同一份 ── */
// 代號同回測分頁 bhSym:BTCUSDT 寫 BTC
function libBenchSym(bm) { return bm.symbol.replace(/USDT$/, ""); }
// 回撤一律 ≤ 0(web library_rules.mdd):api 給正數也照負的寫
function libMdd(v) { return typeof v === "number" && isFinite(v) ? -Math.abs(v) : null; }
// tooltip 同回測分頁 buildMetrics:還原價 / 永續兩句擇一,有 as_of 再接一句(zh 不加空白)
function libBenchTip(bm) {
  const sym = libBenchSym(bm);
  return libJoin(t(bm.adjusted === false ? "bt.tip.benchmarkBhRaw" : "bt.tip.benchmarkBhAdj", { sym }), bm.as_of ? t("bt.tip.benchmarkBhAsOf", { date: bm.as_of }) : "");
}
// 品質關卡那格的短解釋:同 libBenchTable 的泡泡(lib-tipw + mp-tip + .tip),字本身是觸發點,字級色都跟著那格
function libGateTip(node, text, id) {
  const tw = libEl("span", "lib-tipw"), btn = libEl("button", "mp-tip"), tip = libEl("span", "tip", text);
  btn.type = "button"; btn.appendChild(node); tip.id = id; tip.setAttribute("role", "tooltip"); btn.setAttribute("aria-describedby", id);
  tw.append(btn, tip);
  return tw;
}
function libBenchLabel(bm) { return libRich("bt.benchmarkBh", { sym: libMono(libBenchSym(bm)) }); }
function libBenchLegend(bm) {
  const lg = libEl("div", "bt-label lib-legend"), bh = libEl("span", "bt-legend bh");
  bh.appendChild(libBenchLabel(bm));
  lg.append(libEl("span", "bt-legend", t("bt.equity")), bh);
  return lg;
}
// 「回測」欄的兩欄 kv 換成 指標｜策略｜{sym} 持有;樣本年數併進表頭。策略欄同 kv 不上色,基準欄是比較對象、也不上色
function libBenchTable(bm, s) {
  const split = $("lib-det").querySelector(".lib-split"), colA = split && split.firstElementChild;
  if (!colA) return;
  const r = s.report || {}, y = libYears(s);
  const tbl = libEl("table", "lib-cmp"), hr = tbl.appendChild(libEl("thead")).appendChild(libEl("tr"));
  const h0 = libEl("th", "gh", t("lib.kv.bt"));
  if (y !== null) h0.append(" · ", libRich("lib.sampleYrs", { n: libMono(y.toFixed(1)) }));
  const tw = libEl("span", "lib-tipw"), btn = libEl("button", "mp-tip"), tip = libEl("span", "tip", libBenchTip(bm));
  btn.type = "button"; btn.appendChild(libBenchLabel(bm)); tip.id = "lib-bh-tip"; tip.setAttribute("role", "tooltip"); btn.setAttribute("aria-describedby", tip.id);
  tw.append(btn, tip);
  const h2 = libEl("th"); h2.appendChild(tw);
  hr.append(h0, libEl("th", "", t("lib.cmp.strategy")), h2);
  hr.querySelectorAll("th").forEach((th) => { th.scope = "col"; });
  const body = tbl.appendChild(libEl("tbody"));
  [[t("lib.cmp.total"), libPct(r.total_return), libPct(bm.total_return)], [t("lib.kv.ann"), libPct(r.annual_return), libPct(bm.annual_return)],
    [t("lib.kv.sharpe"), libFixed(r.sharpe, 2), libFixed(bm.sharpe, 2)], [t("lib.kv.mdd"), libPct(libMdd(r.max_drawdown)), libPct(libMdd(bm.max_drawdown))]].forEach(([k, a, b]) => {
    const tr = body.appendChild(libEl("tr")), th = libEl("th", "", k); th.scope = "row";
    tr.append(th, libEl("td", "mono", a), libEl("td", "mono bh", b));
  });
  colA.textContent = ""; colA.appendChild(tbl); split.classList.add("wide");
}

/* ── 曲線(lightweight-charts;顏色接法同 report-trades.js buildChart)── */
function libChartDrop() { if (LIB.chart) { try { LIB.chart.remove(); } catch (_) { } LIB.chart = null; } }   // remove 丟例外 = 已經拆了
// 回傳基準線有沒有畫上(r.bench:跟 r.spark 同長、同一段日期的買進持有倍數)
function libChartDraw(host, r) {
  const data = libCurve(r.spark, r.equity_from, r.equity_to), bench = r.bench ? libCurve(r.bench, r.equity_from, r.equity_to) : null;
  if (!data || typeof LightweightCharts === "undefined") { host.replaceWith(libEl("p", "chart-none", t("lib.noCurve"))); return false; }
  const LWC = LightweightCharts, tok = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const chart = LWC.createChart(host, {
    autoSize: true,
    layout: { textColor: tok("--ink-3"), background: { type: "solid", color: tok("--surface-card") }, attributionLogo: false },
    leftPriceScale: { visible: true, borderVisible: false, mode: LWC.PriceScaleMode.Logarithmic, entireTextOnly: true, scaleMargins: { top: 0.08, bottom: 0.06 } },   // 頂端軸標不被裁、起點不貼底
    rightPriceScale: { visible: false },
    timeScale: { borderVisible: false, fixLeftEdge: true, fixRightEdge: true, timeVisible: false,
      tickMarkFormatter: (time, type) => { const y = time && typeof time === "object" ? time.year : String(time).slice(0, 4); return type === LWC.TickMarkType.Year ? String(y) : ""; } },
    grid: { vertLines: { visible: false }, horzLines: { color: tok("--border-hairline") } },
    crosshair: { mode: LWC.CrosshairMode.Hidden },
    handleScroll: false, handleScale: false,
    localization: { priceFormatter: (v) => +v.toFixed(v >= 10 ? 0 : v >= 2 ? 1 : 2) + "×" },   // 去尾零:1× / 1.5× / 2× / 4×
  });
  try {
    // 基準先畫、策略線壓在上面;log 軸照兩條一起 autoscale,基準不會被裁掉。LargeDashed 對齊 web 的 4/4,也跟 1× 那條 Dashed 分得開
    const bs = bench ? chart.addSeries(LWC.LineSeries, { color: tok("--color-greyMedium"), lineWidth: 1, lineStyle: LWC.LineStyle.LargeDashed, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }) : null;
    if (bs) bs.setData(bench);
    const series = chart.addSeries(LWC.LineSeries, { color: tok("--color-green"), lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    series.setData(data);
    const one = series.createPriceLine({ price: 1, color: tok("--ink-3"), lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, axisLabelVisible: false });
    chart.timeScale().fitContent();
    LIB.chart = chart;
    // 換主題只改色(策略線是綠,亮暗同值;基準的 greyMedium 亮暗不同)
    chart.blaveRetheme = () => {
      chart.applyOptions({ layout: { textColor: tok("--ink-3"), background: { type: "solid", color: tok("--surface-card") } }, grid: { horzLines: { color: tok("--border-hairline") } } });
      one.applyOptions({ color: tok("--ink-3") });
      if (bs) bs.applyOptions({ color: tok("--color-greyMedium") });
    };
    return !!bs;
  } catch (_) { chart.remove(); host.replaceWith(libEl("p", "chart-none", t("lib.noCurve"))); return false; }
}

/* ── 接線(這支比 app.js 先載:只用 getElementById,不碰 app.js 的全域;handler 裡的才在點擊時取)── */
(function libWire() {
  const g = (id) => document.getElementById(id);
  g("lib-nav").addEventListener("click", () => { if (!libBag().open) libOpen(); else sideReclick(() => libLeave(), libBag().detail ? libBack : null); });   // 詳情先回列表;列表再點 = 回 welcome(trade.js sideReclick)
  g("lib-back").addEventListener("click", libBack);
  g("lib-mkt-trig").addEventListener("click", () => { if (g("lib-mkt-menu").hidden) libMktOpen(); else libMktClose(false); });
  g("lib-mkt-menu").addEventListener("click", (e) => { const b = e.target.closest(".ct-mi[data-mkt]"); if (b) libMktPick(b.dataset.mkt); });
  g("lib-sort-trig").addEventListener("click", () => { if (g("lib-sort-menu").hidden) libSortOpen(); else libSortClose(false); });
  g("lib-sort-menu").addEventListener("click", (e) => { const b = e.target.closest(".ct-mi[data-sort]"); if (b) libSortPick(b.dataset.sort); });
  // 鍵盤同換合約選單(portfolio.js ctMenuBuild);Esc 擋在這裡,不讓 app.js escTop 再收一次
  const menuKeys = (id, close) => g(id).addEventListener("keydown", (e) => {
    const items = [...g(id).querySelectorAll(".ct-mi")], i = items.indexOf(document.activeElement);
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus(); }
    else if (e.key === "Home" || e.key === "End") { e.preventDefault(); items[e.key === "Home" ? 0 : items.length - 1].focus(); }
    else if (e.key === "Tab") close(false);
  });
  menuKeys("lib-mkt-menu", libMktClose); menuKeys("lib-sort-menu", libSortClose);
  document.addEventListener("pointerdown", (e) => { if (!g("lib-mkt-menu").hidden && !g("lib-mkt").contains(e.target)) libMktClose(false); }, true);
  document.addEventListener("pointerdown", (e) => { if (!g("lib-sort-menu").hidden && !g("lib-sort").contains(e.target)) libSortClose(false); }, true);
  g("lib-body").addEventListener("scroll", () => { const B = libBag(); if (!B.detail) B.scroll = g("lib-body").scrollTop; });
  window.addEventListener("focus", () => { libRefresh(); libIdeaSync(); });
  window.addEventListener("focus", () => { if (LIB.bbWait) { LIB.bbWait.check = true; libBbPollSoon(0); } if (!$("lib").hidden) libBalLoad(); });   // 付完或儲值後切回 app   // 付完切回 app:立刻查一次綁卡即購買的結果
  window.addEventListener("blave:theme", () => { libSparkAll(); if (LIB.chart && LIB.chart.blaveRetheme) try { LIB.chart.blaveRetheme(); } catch (_) { } });   // 去瀏覽器綁卡 / 儲值回來:閘門要解(主行程回前景也會重問 account_status)
  g("chat-idea").addEventListener("click", () => { if (typeof ideaOpen === "function") ideaOpen(g("chat-idea"), "welcome", "any"); });   // 歡迎頁①:開找點子框,不限市場
  libIdeaSync();
  window.blave.libraryInstalled().then((m) => { if (m && typeof m === "object") { LIB.installed = m; if (typeof wcPaint === "function") wcPaint(); } }).catch(() => {});
})();
