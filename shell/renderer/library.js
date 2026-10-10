/* 策略庫(設計:blave-canon output/designer/spec-desktop-library-2026-09-25.md;雲端工作頁 #lib_panel 縮成中欄的尺寸)。
   側欄「策略庫」→ 中欄清單(市場分段、已驗證優先)→ 詳情(曲線、四個數字、三道關卡、怎麼交易)→「用這支」確認框 →
   送給 agent 同一句固定訊息(lib.msg / lib.msgPaid,逐字同 web 的 workspace_lib_msg;runtime 認這個句型,一行不改)。
   - 清單由主行程打 api(renderer 的 CSP 不外連;主行程逐欄驗過型別才交過來);這裡仍一律 textContent。
   - 兩個視角各記一份「開著 / 詳情那支 / 分段 / 捲動」(LIB.bags,同 TR_BAGS 的作法);中欄誰該出現由 trade.js 的 envShowMain
     在最後一步問 libShowMain。選策略 / 開自動下單會 libLeave。
   - 「已安裝」(§1.2):外殼在 userData 記 { marketplace id → 本機策略資料夾名 };送出「用這支」那一輪結束、本機清單多了一支就記下;
     名字被刪就從表裡拿掉。雲端視角不寫檔:同一套「送出前記清單、之後看多了誰」的比法,只記在這次 app 開著的期間(libCloudChanged)。
   - 不導流(§13):未驗證的社群策略也列(平鋪在同一份清單的尾段,帶「未驗證」tag;spec-desktop-0.1.6 §2),詳情用 /report 補到 400 點曲線、
     總報酬、關卡數值、回測期間;沒有任何開網頁的入口。
   - 付不出資料費(spec-desktop-0.1.6 §3)、沒登入(spec-0.1.13 §2):why 只有一個來源(主行程 libraryList 回的 why);清單分「現在就能用」與第二組,
     閘門卡掛在第二組頭上,詳情主鈕照這支要不要 Blave 資料分流(libGrouping / libCta)。本機「用這支」由主行程代下載。
   - 上網找點子(spec-0.1.13 §5):四個入口都問 libIdeaOn,框本身在 newstrategy.js(ideaOpen)。
   - 付費策略在 app 內買(§4.4):購買框兩段對齊網頁 libBuy / libPurchase;憑證只在主行程(帳號 token + app 專用密鑰)。
   用到 app.js 的 $ / t / LANG / hasToken / running / RP / RPC / csTitle / csStartNew / submitMessage / confirmBox / delClose / setOpen / setCat /
   planOpen / stratSelect / rpCloudSelect / paneSt / paneToggle、trade.js 的 ENV / TR_BAGS / trLeave / envShowMain / envCanSwitch / envCloudKind /
   envHeadState——都在呼叫時才取(這支比 app.js 先載)。 */

/* ── 純邏輯(tests/check_shell_library.js 從原文切出來跑;這一段不准碰 DOM / i18n)── */
const LIB_DAY = 86400000;
const LIB_PAIR_RE = /^([A-Z0-9]{1,10})USDT$/;
// 清單只有公開策略,api 在 approve / 官方上架時把 category 收斂成固定幾個值;Crypto / TW Stock 以外(US Stock、Forex、Other)沒有分頁,只在「全部」
function libMarket(s) {
  const cat = s && s.category;
  return cat === "Crypto" ? "crypto" : cat === "TW Stock" ? "tw" : "other";
}
function libDays(from, to) {
  const t0 = Date.parse(typeof from === "string" ? from : ""), t1 = Date.parse(typeof to === "string" ? to : "");
  return isFinite(t0) && isFinite(t1) && t1 >= t0 ? Math.round((t1 - t0) / LIB_DAY) : null;
}
function libYears(s) { const r = s && s.report, d = r ? libDays(r.equity_from, r.equity_to) : null; return d === null ? null : Math.round((d / 365.25) * 10) / 10; }
function libCreated(s) { const t0 = s && typeof s.created_at === "string" ? Date.parse(s.created_at.replace(" ", "T")) : NaN; return isFinite(t0) ? t0 : null; }
function libListedDays(s, now) { const c = libCreated(s); return c === null ? null : Math.max(0, Math.floor((now - c) / LIB_DAY)); }
function libIsFree(s) { return !(s && typeof s.price === "number" && s.price > 0); }
// 這支要不要 Blave 資料(api 的 blave_data;spec-0.1.13 §1.1):"none" / "required" / null(未標)。用到它的判斷一律把 null 當 required
function libNeeds(s) { return s && (s.blave_data === "none" || s.blave_data === "required") ? s.blave_data : null; }
// 不登入也能用(§1.1b;Wei 10-02):官方 × 免費 × 不用 Blave 資料,三個缺一不可(未標不算)。主行程的 libAnonOk 與 api /public_code 各再判一次
function libAnonOk(s) { return !!s && s.is_official === true && libIsFree(s) && libNeeds(s) === "none"; }
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
// 分組的兩組(§2.2):沒登入時第一組是免登入策略、已登入時是免資料的;兩組各自保持 libVisible 的順序
function libSplit(list, grouping) {
  const first = grouping === "signedOut" ? libAnonOk : (s) => libNeeds(s) === "none", now = [], later = [];
  (Array.isArray(list) ? list : []).forEach((s) => (first(s) ? now : later).push(s));
  return { now, later };
}
/* 找點子四個入口共用的條件(§1.4;c = { env, browserOn, engine, signedIn, canRun }):這台電腦、內建瀏覽器開著、引擎跑得動。
   Blave AI 要登入而且帳號能跑(查不到 canRun 不算擋);還沒連引擎不出 */
function libIdeaOn(c) {
  const engineOk = c.engine === "claude" || c.engine === "codex" || c.engine === "apikey" || (c.engine === "blave" && c.signedIn === true && c.canRun !== false);
  return c.env === "local" && c.browserOn === true && engineOk;
}
// 代下載沒成的那句:主行程判的 kind(+ 畫面自己的 unsent)→ 字串 key;認不得的一律當 fail
function libDlKey(kind) { return ["blocked", "gone", "anonGone", "signin", "rateLimited", "unsent"].includes(kind) ? "lib.dl." + kind : "lib.dl.fail"; }
// 確認框與購買框的資料費那一行(§4.1):本機、按小時計費、而且這支不是只用公開資料。兩個框共用這一支,條件不會漂
function libFeeLine(env, dataAccess, needs) { return env !== "cloud" && dataAccess === "billed" && needs !== "none"; }
// 推薦排序(同公開頁 library_rules.recoSort):已驗證 → 樣本長 → 新;刻意不看報酬 / Sharpe(最漂亮的回測多半最過擬合)
function libCompare(a, b) {
  const va = a.verified ? 1 : 0, vb = b.verified ? 1 : 0;
  if (va !== vb) return vb - va;
  const ya = libYears(a), yb = libYears(b);
  if (ya !== yb) { if (ya === null) return 1; if (yb === null) return -1; return yb - ya; }
  const ca = libCreated(a), cb = libCreated(b);
  if (ca === cb) return 0; if (ca === null) return 1; if (cb === null) return -1;
  return cb - ca;
}
/* 這個分段要畫的一份清單(spec-desktop-0.1.6 §2.1):主鍵「官方或已驗證」在前,其後照 libCompare。主鍵寫成 code 是因為 libCompare
   第一階只看 verified——「官方但沒跑關卡」在純 libCompare 下會掉到未驗證那一段;Wei 說的是「官方與已驗證在前」 */
function libVisible(list, mkt) {
  const inMkt = (Array.isArray(list) ? list : []).filter((s) => s && (mkt === "all" || libMarket(s) === mkt));
  return inMkt.sort((a, b) => (Number(!!(b.is_official || b.verified)) - Number(!!(a.is_official || a.verified))) || libCompare(a, b));
}
// 關卡數值的字(抄 web library_rules.rate / fillP):費率 0.0005 → "0.05%"(最少 2 位、尾零去掉);p < 0.001 整段換成「p < 0.001」
function libRate(v) {
  if (typeof v !== "number" || !isFinite(v)) return "—";
  let s = (v * 100).toFixed(4).replace(/0+$/, "");
  if (/\.\d$/.test(s)) s += "0";
  if (/\.$/.test(s)) s += "00";
  return s + "%";
}
function libP(tpl, p) {
  if (typeof p !== "number" || !isFinite(p)) return "—";
  if (p < 0.001) return tpl.replace(/=\s*\{p\}/, "< 0.001").replace("{p}", "< 0.001");
  return tpl.replace("{p}", p.toFixed(4));
}
function libGateFails(gc) { return gc ? ["fee", "mcpt", "robust"].filter((k) => gc[k] === "fail").length : 0; }
/* CTA 態(spec-0.1.13 §1.3 + 0.1.6 §4.4,由上到下取第一個成立的;進行中提到最前——那支的回合就是它的進度)。c = { running, env, signedIn, dataAccess, why, cloud: "live"|"stale"|"stopped"|null,
   pending, noNew, buying, installedName }。回 { state, paid, name, err, why, pub }:paid = 付費且還沒買;err = 上一輪是這支的下載、結束時沒新策略;
   why = noData 態的原因(libGrouping 的 no_card / no_balance / unknown,只在 noData 帶);pub = 分組中而這支只用公開資料(鈕下講那一句)。
   沒登入只擋不是免登入策略的那幾支;資料牆只擋要資料(含未標)的。installedName 兩個視角各有來源(本機 = userData 的對照表、
   雲端 = 這次開 app 期間看到雲端清單多出來的那支),這裡只認有沒有 */
function libCta(s, c) {
  const paid = !libIsFree(s) && !s.purchased && !s.is_owner, local = c.env !== "cloud", g = libGrouping(c), none = libNeeds(s) === "none";
  const st = (state, name) => ({ state, paid, name: name || null, err: c.noNew === s.id && (state === "free" || state === "owned" || state === "installed"), why: state === "noData" ? g : null, pub: local && g !== null && none });
  if (c.pending === s.id) return st("pending");   // 正在下載的那支:回合當然在跑,它講的是自己的進度,不是「上一輪還在跑」
  if (c.running) return st("busy");
  if (local && c.signedIn === false && !libAnonOk(s)) return st("signedOut");
  if (local && g !== null && g !== "signedOut" && !none) return st("noData");
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
  if (status === 400 && /already purchased/i.test(err)) return "ok";
  if (status === 409) return "inProgress";
  if (status === 402 && body && body.needs_topup) return body.has_card ? "topup" : "noCard";
  if (status === 402 && /no card bound/i.test(err)) return "noCard";
  return "failed";
}
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
function libNoteTitle(s, lang) { const m = s && s.success_note_titles; const v = m && typeof m === "object" ? m[lang] : null; return typeof v === "string" && v.trim() ? v.trim() : null; }
/* 筆記內文白名單重建(§2.4)。root = 解析好的惰性文件 body;mk(tag, cls) 造一個沒有屬性的空元素。只用 mk + 附加字串重建,
   來源的屬性一個都不搬(事件屬性、href、style 從構造上就進不來)。a 拆成純文字:筆記裡的連結都導去網頁版,電腦版不導流。
   第一個 <hr>(不論在第幾層)之後是寫給網頁訪客的導流段,整段不畫。 */
const LIB_NT_TAGS = { P: "p", H3: "h3", UL: "ul", OL: "ol", LI: "li", STRONG: "strong", B: "strong", EM: "em", BR: "br", TABLE: "table", TR: "tr", TH: "th", TD: "td", BLOCKQUOTE: "div" };
const LIB_NT_DROP = /^(IMG|PICTURE|SOURCE|VIDEO|AUDIO|SCRIPT|STYLE|LINK|META|IFRAME|FRAME|FRAMESET|OBJECT|EMBED|SVG|MATH|CANVAS|NOSCRIPT|TEMPLATE|FORM|INPUT|BUTTON|SELECT|TEXTAREA|HEAD|TITLE)$/;
const LIB_NT_NO_TEXT = { table: 1, tr: 1, ul: 1, ol: 1 };   // 這幾種容器裡的裸字只會是排版空白
function libNoteBuild(root, mk) {
  const out = mk("div", "nt-body");
  let cut = false;
  const walk = (src, dst, dtag) => {
    for (const n of Array.from((src && src.childNodes) || [])) {
      if (cut) return;
      if (n.nodeType === 3) {
        const s = String(n.nodeValue == null ? "" : n.nodeValue);
        if (dtag === "body") { if (s.trim()) { const p = mk("p"); p.append(s.trim()); dst.append(p); } }
        else if (s.trim() || !LIB_NT_NO_TEXT[dtag]) dst.append(s);
        continue;
      }
      if (n.nodeType !== 1) continue;
      const tag = String(n.nodeName || "").toUpperCase();
      if (tag === "HR") { cut = true; return; }
      if (LIB_NT_DROP.test(tag)) continue;
      const to = Object.prototype.hasOwnProperty.call(LIB_NT_TAGS, tag) ? LIB_NT_TAGS[tag] : null;
      if (!to) { walk(n, dst, dtag); continue; }   // a / thead / tbody / 未知容器:拆掉留內容
      const m = tag === "BLOCKQUOTE" ? mk("div", "nt-lead") : mk(to);
      walk(n, m, to);
      if (to === "table") { const w = mk("div", "nt-tw"); w.append(m); dst.append(w); } else dst.append(m);
    }
  };
  walk(root, out, "body");
  return out;
}
/* ── 純邏輯到此 ── */

const LIB = { bags: { local: libNewBag(), cloud: libNewBag() }, data: null, loading: false, skel: false, failed: false, stale: false, seq: 0,
  pending: null, noNew: null, buying: null, installed: {}, chart: null, paintedEnv: null, reports: new Map(),   // reports: id → Promise<report|null>(詳情的 400 點曲線 + 回測期間)
  dlFail: null,   // 本機代下載沒成:{ id, kind: blocked | gone | signin | fail | unsent }(§4.2);再按一次、離開詳情、libInvalidate 清掉
  cloudInstalled: {}, cloudWait: null, cloudNames: null,   // 雲端視角的「已安裝」(只在這次 app 開著的期間;見 libCloudChanged)
  busyTold: null, noteSeq: 0,   // busyTold:回合中點過哪一支的停用主鈕(那句「上一輪還在跑。」要留著,回合結束 libSync 清掉);noteSeq:筆記載入的世代
  brOn: false, ideaShown: null };   // brOn:內建瀏覽器開關的快取;ideaShown:清單上次畫的找點子入口是開是關
const LIB_CLOUD_WAIT_MS = 3 * 60 * 1000;   // 回合結束後等雲端清單跟上的上限(主機的回報器有延遲);過了就不再認新出現的那支是這次下載的
function libNewBag() { return { open: false, detail: null, note: null, mkt: "all", scroll: 0, detScroll: 0, row: null }; }   // note = 開著的筆記 id(第三層;null = 沒開)
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
function libBlockedWhy(c) { return c.state === "signedOut" ? "signed_out" : c.state === "noData" ? c.why : c.state === "stopped" || c.state === "stale" ? "cloud_off" : null; }
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
  if (changed) libCloudRepaintList();
}
// 清單分組與詳情主鈕共用同一份帳號狀態(登入與否、資料狀態),兩邊才不會一個說「現在就能用」一個說要登入
function libCtx() {
  const env = libEnv();
  return { env, signedIn: typeof hasToken !== "undefined" ? !!hasToken : !!(LIB.data && LIB.data.signedIn),
    dataAccess: LIB.data ? LIB.data.dataAccess : null, why: LIB.data ? LIB.data.why : null };
}
function libCtaOf(s) {
  const c = libCtx();
  return libCta(s, Object.assign(c, {
    running: typeof running !== "undefined" && running === true, cloud: c.env === "cloud" ? libCloud() : null,
    pending: LIB.pending ? LIB.pending.id : null, noNew: LIB.noNew, buying: LIB.buying,
    installedName: libInstalledOf(s, c.env),
  }));
}
/* 找點子入口(§1.4):四個入口都問這一支;LIB.brOn 是內建瀏覽器開關的快取(libIdeaSync 更新) */
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
  const on = libIdeaNow(), chip = document.getElementById("chat-idea");
  if (chip) chip.hidden = !on;
  if (LIB.ideaShown === on) return;
  LIB.ideaShown = on;
  if (!document.getElementById("lib").hidden && !libBag().detail) libPaintListKeep();
}

/* ── 開 / 關 ──────────────────────────────────────────── */
async function libOpen() {
  const B = libBag();
  if (typeof trLeave === "function") trLeave();
  if (typeof rptLeave === "function") rptLeave();   // 報告與策略庫互斥(renderer/reports.js)
  if (libEnv() === "local") { if (typeof stratSelect === "function") await stratSelect(null); }
  else if (typeof rpCloudSelect === "function") await rpCloudSelect(null);
  B.open = true;
  if (B !== libBag()) return;   // 等的時候切走了:只記下這一邊是開著的
  envShowMain();
  libIdeaSync();
  libLoad(false);   // 每次進視圖都重問主行程(它有 5 分鐘快取;dataAccess 每次現算)——綁卡 / 換帳號 / 換語言之後畫面才會跟上
  const h = B.detail ? $("lib-back") : $("lib-h");
  if (h && h.offsetParent) h.focus();
  libTrack("library_open");
}
// 選了策略 / 開自動下單:那一邊的策略庫收起來(中欄一次只有一個視圖)。trOpen 直接翻 DOM、不經 envShowMain,所以這裡自己收 #lib
function libLeave(env) {
  const B = libBag(env);
  if (!B.open) return;
  B.open = false; LIB.noNew = null; LIB.dlFail = null;
  if (B === libBag()) { $("lib").hidden = true; $("lib-nav").removeAttribute("aria-current"); libChartDrop(); }
}
/* envShowMain(trade.js)的最後一步:策略庫開著就蓋掉其餘視圖。gate = 雲端沒主機可看(開通頁),那時側欄入口也藏著 */
function libShowMain(gate) {
  const on = !gate && libBag().open, was = !$("lib").hidden;
  if (on) { $("rp").hidden = true; $("tr").hidden = true; $("main-empty").hidden = true; $("tr-nav").removeAttribute("aria-current"); }
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
  const timer = setTimeout(() => { if (LIB.seq !== seq || LIB.data) return; LIB.skel = true; shownAt = Date.now(); if (!$("lib").hidden) libPaint(); }, 200);
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
}
// 登入 / 登出 / 換帳號 / 買了(app.js 在 hasToken 翻轉的地方叫;購買成功自己叫):手上那份作廢,開著就立刻重問
function libInvalidate() { LIB.stale = true; LIB.dlFail = null; LIB.cloudInstalled = {}; LIB.cloudWait = null; LIB.cloudNames = null; libRefresh(); }   // 雲端「已安裝」是這個帳號的記憶:換人就丟
// 視圖開著時重問一次(設定關掉、視窗回前景:綁卡 / 儲值後閘門要解)
function libRefresh() { if (!$("lib").hidden) libLoad(false); }
// 送出「用這支」那一輪結束(app.js onTurnEnd,stratRefresh(true) 之後):本機多了一支就記下對照表;沒有就出灰字。雲端只重問一次狀態
function libTurnEnd() {
  const p = LIB.pending;
  if (!p || p.stage === "dl") return;   // 還在代下載:結束的是用戶另外送的那一輪,不是這支的
  LIB.pending = null;
  if (p.env === "local") {
    // 新出現、或同名但 mtime 變了(「再下載一份」是整份覆蓋同名那支)都算成功;對照表已記的名字優先認它
    const touched = RP.list.filter((x) => p.before.get(x.name) !== x.mtime);
    const known = LIB.installed[String(p.id)], hit = touched.find((x) => x.name === known) || touched[0];
    if (hit) { libInstalledSet(p.id, hit.name); libTrack("lib_installed"); } else { LIB.noNew = p.id; libTrack("library_no_new"); }
  } else {
    if (window.blave && typeof window.blave.cloudRefresh === "function") window.blave.cloudRefresh().catch(() => {});
    if (libCloudSettle(p, libCloudList())) { libTrack("lib_installed"); libCloudRepaintList(); }
    else LIB.cloudWait = { id: p.id, before: p.before, until: Date.now() + LIB_CLOUD_WAIT_MS };   // 清單還沒跟上:等輪詢帶新的來
  }
  libSync();
}
function libInstalledSet(id, name) {
  LIB.installed[String(id)] = name;
  window.blave.libraryInstalled({ id, name }).then((m) => { if (m && typeof m === "object") LIB.installed = m; }).catch(() => {});
}
// 回合開始 / 結束(running 變了)、購買中、對照表變了:詳情的 CTA 就地重畫;清單的 tag 在 libStratChanged
function libSync() {
  if (!(typeof running !== "undefined" && running === true)) LIB.busyTold = null;   // 清在這裡、不在 libPaintCta:忙碌中也會重畫,會把剛講的那句抹掉
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
  if (B.detail && LIB.data && !libFind(B.detail)) B.detail = null;   // 那支不在清單裡了(下架):回清單
  const det = B.detail ? libFind(B.detail) : null;
  if (det && B.note !== null) B.note = libNoteId(det, LANG);   // 換語言:跟著換成那一語言的筆記,沒有就退回詳情
  const reading = !!det && B.note !== null;
  $("lib-head-list").hidden = !!det; $("lib-back").hidden = !det;
  // 筆記層的返回鈕寫策略名(一眼知道回到哪);全文放 title(單行截斷)
  $("lib-back-l").hidden = reading; $("lib-back-s").hidden = !reading; $("lib-back-s").textContent = reading ? det.title : "";
  if (reading) $("lib-back").title = det.title; else $("lib-back").removeAttribute("title");
  $("lib-seg").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.mkt === B.mkt ? "true" : "false"));
  if (det) { $("lib-rows").textContent = ""; $("lib-grps").textContent = ""; $("lib-state").hidden = true; if (reading) libPaintNote(det); else libPaintDetail(det); }
  else { libChartDrop(); $("lib-det").hidden = true; $("lib-det").textContent = ""; libPaintDesc(); libPaintList(); $("lib-body").scrollTop = B.scroll || 0; }
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
// 找點子的入口鈕(頁首 / 第一組空 / 市場空):市場預設照清單分段
function libIdeaBtn(cls, key, from) {
  const b = libEl("button", cls, t(key)); b.type = "button";
  b.addEventListener("click", () => { if (typeof ideaOpen === "function") ideaOpen(b, from, libBag().mkt === "all" ? "any" : libBag().mkt); });
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
// 標的與頻率:「BTC/USDT 永續」「TXF 台指期」「2330 台股」/ 沒有標的 = 多標的;週期用網頁同一組字
function libSymbolNodes(s) {
  const r = s.report || {}, sym = typeof r.symbol === "string" ? r.symbol.trim() : "", parts = [];
  if (!sym) parts.push(t("lib.mk.multi"));
  else if (LIB_PAIR_RE.test(sym)) parts.push(libMono(sym.replace(LIB_PAIR_RE, "$1/USDT")), " " + t("lib.mk.perp"));
  else if (/^(TXF|MXF|TMF)$/.test(sym)) parts.push(libMono(sym), " " + t("lib.mk.txf"));
  else if (/^\d{4,6}[A-Z]?$/.test(sym)) parts.push(libMono(sym), " " + t("lib.mk.tw"));
  else parts.push(libMono(sym));
  const k = libIvKey(r.interval);
  if (k) parts.push(" · " + t(LIB_IV_KEYS[k])); else if (typeof r.interval === "string" && r.interval) parts.push(" · ", libMono(r.interval));
  return parts;
}
function libRow(s) {
  const b = libEl("button", "lib-row"); b.type = "button"; b.dataset.id = String(s.id);
  const l = libEl("div", "lib-row-l"), l1 = libEl("div", "l1"), l2 = libEl("div", "l2");
  l1.appendChild(libEl("span", "t", s.title)); libTags(s).forEach((x) => l1.appendChild(x));
  l2.append(t(s.is_official ? "lib.official" : "lib.community"), " · ", ...libSymbolNodes(s));
  const y = libYears(s);
  if (y !== null) l2.append(" · ", libRich("lib.years", { n: libMono(y.toFixed(1)) }));   // 同一組數字位數相同:1.0 年,不是 1 年
  l.append(l1, l2);
  const r = s.report, ann = r ? r.annual_return : null;
  const num = libEl("div", "num");
  num.append(libEl("div", "v mono" + (typeof ann === "number" ? (ann > 0 ? " up" : ann < 0 ? " down" : "") : ""), libPct(ann)), libEl("div", "k", t("lib.annLabel")));
  const go = libEl("span", "go", "›"); go.setAttribute("aria-hidden", "true");
  b.append(l, num, go);
  b.addEventListener("click", () => libShowDetail(s.id));
  return b;
}
function libPaintList() {
  const B = libBag(), rows = $("lib-rows"), state = $("lib-state"), grps = $("lib-grps");
  rows.textContent = ""; state.hidden = true; state.textContent = ""; grps.textContent = "";
  if (!LIB.data) {
    if (LIB.skel) {
      [94, 82, 90, 76, 87].forEach((w) => {
        const r = libEl("div", "sk-row"), l = libEl("div"), a = libEl("div", "sk"), c = libEl("div", "sk s"), n = libEl("div", "sk");
        a.style.width = w + "%"; c.style.width = Math.round(w * 0.7) + "%"; l.append(a, c); r.append(l, n, libEl("span"));
        rows.appendChild(r);
      });
    } else if (LIB.failed) {
      state.hidden = false;
      const b = libEl("button", "btn-out", t("lib.retry")); b.type = "button"; b.addEventListener("click", () => libLoad(true));
      state.append(t("lib.error"), document.createElement("br"), b);
    }
    return;
  }
  const v = libVisible(LIB.data.strategies, B.mkt);
  if (!v.length) {   // 市場分段整個空(§2.5):一行字 + 一個填充動作——找點子開著就請 agent 上網找,否則新增策略
    state.hidden = false; state.append(t(LIB.data.strategies.length ? "lib.emptyMkt" : "lib.empty"), document.createElement("br"));
    if (libIdeaNow()) state.appendChild(libIdeaBtn("btn-out", "idea.btn", "lib_empty"));
    else { const b = libEl("button", "btn-out", t("ns.chip")); b.type = "button"; b.addEventListener("click", () => { if (typeof nsOpen === "function") nsOpen(b); }); state.appendChild(b); }
    return;
  }
  // 沒權限時分兩組(§2.2 / §2.3):閘門卡掛在它管的第二組頭上;第二組空就平鋪(這個分段全部能直接用)
  const g = libGrouping(libCtx()), sp = g ? libSplit(v, g) : null;
  if (!sp || !sp.later.length) { v.forEach((s) => rows.appendChild(libRow(s))); return; }
  const grp = (id, label, n) => {
    const sec = libEl("section", "lib-grp"), h = libEl("h6", "lib-grp-h"); sec.setAttribute("aria-labelledby", id); h.id = id;
    h.append(label, libMono(String(n))); sec.appendChild(h); return sec;
  };
  const listOf = (arr) => { const d = libEl("div", "lib-rows"); arr.forEach((s) => d.appendChild(libRow(s))); return d; };
  const g1 = grp("lib-grp-now", t("lib.grp.now"), sp.now.length);
  if (sp.now.length) g1.appendChild(listOf(sp.now));
  else {   // 第一組空(台股 × 沒卡):一行字,找點子開著就接文字鈕
    const p = libEl("p", "lib-grp-empty", t("lib.grp.empty"));
    if (libIdeaNow()) p.append(LANG === "zh" ? "" : " ", libIdeaBtn("btn-quiet", "idea.link", "lib_empty"));
    g1.appendChild(p);
  }
  const g2 = grp("lib-grp-later", t(LIB_GRP_KEYS[g][0]), sp.later.length), gate = libEl("div", "lib-gate");
  gate.append(libEl("p", "", t(LIB_GRP_KEYS[g][1])), g === "signedOut" ? libSignInBtn() : libGateBtn(g));
  g2.append(gate, listOf(sp.later));
  grps.append(g1, g2);
}
// 第二組的組名與閘門卡那一句(§2.2 表)
const LIB_GRP_KEYS = { no_card: ["lib.grp.card", "lib.grp.gate.noCard"], no_balance: ["lib.grp.topup", "lib.grp.gate.noBalance"],
  no_plan: ["lib.grp.plan", "lib.grp.gate.noPlan"], plan_failed: ["lib.grp.repay", "lib.grp.gate.planFailed"],
  unknown: ["lib.grp.check", "lib.grp.gate.unknown"], signedOut: ["lib.grp.signedOut", "lib.grp.gate.signedOut"] };
/* 付不出資料費的出口(§3.2):no_card 有試用 → 「綁卡,送 {t} 天資料」(方案制講「免費試用」,.m)/ 沒試用或 t 空 → 「前往綁卡」/ no_balance → 「儲值」/ unknown → 描邊「帳號與方案」
   (查不到狀態時不擺一顆要錢的主鈕;鈕字用 pv.e.btn——「開這一頁的鈕」的字,跟資料卡那顆共用)。鈕都開 設定 › 帳號與方案。試用天數來自 planVars().t(api 的 trial.days),不寫死 */
function libGateBtn(why) {
  // 方案制:沒有方案 →「看方案」開設定 › 帳號與方案(那一頁有開通鈕與 API 方案);扣款失敗 →「重新付款」外開網站方案頁
  if (why === "no_plan") { const b = libEl("button", "btn-fill", t("data.seePlan")); b.type = "button"; b.addEventListener("click", () => { libTrack("plan_lib"); planOpen(); }); return b; }
  if (why === "plan_failed") { const b = libEl("button", "btn-fill", t("plan.repay")); b.type = "button"; b.addEventListener("click", () => planRepay()); return b; }
  const trial = typeof acct !== "undefined" && acct && acct.trial_eligible === false ? false : true;
  const tDays = typeof planVars === "function" ? planVars().t : "";
  const b = libEl("button", why === "unknown" ? "btn-out" : "btn-fill", why === "no_balance" ? t("lib.gate.topup") : why === "unknown" ? t("pv.e.btn") : trial && tDays ? t(typeof planMo === "function" && planMo() ? "lib.gate.bindCard.m" : "lib.gate.bindCard", { t: tDays }) : t("plan.addCard"));
  b.type = "button"; b.addEventListener("click", () => { if (why !== "unknown") libTrack(why === "no_balance" ? "topup_lib" : "bind_lib"); planOpen(); });
  return b;
}
// 「登入 Blave」(詳情主鈕與沒登入那組的閘門卡同一顆):開 設定 › 帳號與方案
function libSignInBtn() {
  const b = libEl("button", "btn-fill", t("cn.blave.btn")); b.type = "button";
  b.addEventListener("click", () => setOpen().then(() => setCat("plan")));
  return b;
}
/* 詳情 noData 鈕下那句(§3):第一句看資料需求(要用 / 未標),第二句看原因——no_card 不接(鈕字已經講了) */
function libNoDataText(s, why) {
  return libJoin(t(libNeeds(s) === "required" ? "lib.need.data" : "lib.need.unknown"), why === "no_balance" ? t("lib.why.noBalance") : why === "no_plan" ? t("lib.why.noPlan") : why === "plan_failed" ? t("lib.why.planFailed") : why === "unknown" ? t("lib.why.unknown") : "");
}
function libShowDetail(id) {
  const B = libBag(); B.row = id; B.detail = id; B.note = null;
  libPaint(); $("lib-body").scrollTop = 0;
  const s = libFind(id); if (s) libBlocked(libBlockedWhy(libCtaOf(s)));
  $("lib-back").focus();
}
function libBack() {
  const B = libBag();
  if (B.note !== null) { libNoteBack(); return; }
  B.detail = null; LIB.noNew = null; LIB.dlFail = null;
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
      const vals = { fee: [t("lib.gate.feeAssumed", { v: libRate(fee.rate) }), t("lib.gate.feeActual", { v: libRate(fee.actual) })], mcpt: gc.mcpt === "na" ? [] : [libP(t("lib.gate.p"), g.mcpt_p)],
        robust: [typeof rob.ratio === "number" && isFinite(rob.ratio) ? t("lib.gate.robustVal", { ratio: String(Math.round(rob.ratio * 100)) }) : "—"] };
      const ul = libEl("ul", "gates");
      [["fee", "lib.gate1", "lib.gate1d"], ["mcpt", "lib.gate2", "lib.gate2d"], ["robust", "lib.gate3", "lib.gate3d"]].forEach(([key, n, d]) => {
        const li = libEl("li"), v = gc[key], gr = libEl("span", "gr");
        gr.appendChild(libEl("span", "gv " + (v === "pass" ? "up" : v === "fail" ? "down" : "na"), t(v === "pass" ? "lib.gate.pass" : v === "fail" ? "lib.gate.fail" : "lib.gate.na")));
        vals[key].forEach((x) => gr.appendChild(libEl("span", "gx mono", x)));
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
  p.then((rep) => { if (rep && !$("lib").hidden && libBag().detail === s.id) libReportApply(rep); });
}
function libReportApply(rep) {
  const det = $("lib-det"), curve = rep.equity ? { spark: rep.equity, equity_from: rep.equity_from, equity_to: rep.equity_to } : null;
  if (curve && libCurve(curve.spark, curve.equity_from, curve.equity_to)) {   // 先確認畫得出來:換不成就留著 spark,不能從有圖退成沒圖
    let host = $("lib-chart");
    if (host) libChartDrop();
    else { const none = det.querySelector(".lib-card .chart-none"); if (none) { host = libEl("div", "chart"); host.id = "lib-chart"; none.replaceWith(host); } }
    if (host) libChartDraw(host, curve);
  }
  const per = $("lib-period");
  if (per && rep.backtest_start && rep.backtest_end) { per.textContent = ""; per.appendChild(libMono(rep.backtest_start + " — " + rep.backtest_end)); }
}
function libCtaMain() { const c = $("lib-cta"); return c ? c.querySelector(".btn-fill") : null; }
function libPaintCta(s) {
  const box = $("lib-cta"); if (!box) return;
  const hadFocus = box.contains(document.activeElement);   // 重畫前焦點在鈕上:畫完還給新的主鈕(§3 末,同 libPurchase)
  box.textContent = "";
  const c = libCtaOf(s), row = libEl("div", "row"), note = libEl("p", "note"); note.id = "lib-cta-note";
  const btn = (cls, label, on) => { const b = libEl("button", cls, label); b.type = "button"; if (on) b.addEventListener("click", () => on(b)); return b; };
  const dis = (label) => { const b = btn("btn-fill", label); b.disabled = true; return b; };
  const buyLabel = () => t("lib.buy", { price: libPriceText(s) || "—" });
  const paidNote = () => { note.textContent = libJoin(t("lib.note.paid"), libFx() ? t("lib.fxNote") : ""); };
  switch (c.state) {
    case "signedOut": row.appendChild(libSignInBtn()); note.classList.add("up"); note.textContent = t(c.paid ? "lib.gate.signedOutBuy" : "lib.gate.signedOut"); break;   // 只講登入、不提卡與資料:登入後真的撞到資料牆再講(Wei 10-02)
    case "noData": row.appendChild(libGateBtn(c.why)); note.classList.add("up"); note.textContent = libNoDataText(s, c.why); break;
    case "busy": {   // 點了才講(同策略版本):不常駐那句;aria-disabled 讓鍵盤停得上去,點 / Enter / Space 才把原因寫進鈕下
      const b = btn("btn-fill", c.paid ? buyLabel() : t("lib.use"), () => libBusyTell(s));
      b.setAttribute("aria-disabled", "true"); b.title = t("turn.busy"); row.appendChild(b);
      note.setAttribute("role", "status");
      if (LIB.busyTold === s.id) { note.textContent = t("turn.busy"); b.setAttribute("aria-describedby", "lib-cta-note"); }
      break;
    }
    case "stopped": case "stale": row.appendChild(dis(c.paid ? buyLabel() : t("lib.use"))); note.textContent = t(c.state === "stopped" ? "ho.gate.stopped" : "ho.gate.stale"); break;
    case "pending": row.appendChild(dis(t("lib.pending"))); note.textContent = LIB.pending && LIB.pending.stage === "dl" ? "" : t("lib.note.pending"); break;   // 下載中對話裡還沒有東西可看
    case "buying": row.appendChild(dis(t("lib.buy.busy"))); paidNote(); break;
    case "installed":
      row.append(btn("btn-fill", t("lib.open"), () => (libEnv() === "cloud" ? rpCloudSelect(c.name) : stratSelect(c.name))), btn("btn-quiet", t("lib.again"), (b) => libAsk(s, b)));
      break;
    case "paid": row.appendChild(btn("btn-fill", buyLabel(), (b) => libBuyBox(s, "confirm", b, {}))); paidNote(); break;
    case "owned": row.appendChild(btn("btn-fill", t("lib.use"), (b) => libAsk(s, b))); if (c.pub) note.textContent = t("lib.pub"); break;
    default:   // free:分組中而這支只用公開資料,鈕下講一句(沒有任何登入或卡的字;§0.1)
      row.appendChild(btn("btn-fill", t("lib.use"), (b) => libAsk(s, b)));
      if (c.pub) note.textContent = t("lib.pub");
  }
  if (row.childNodes.length) box.appendChild(row);
  note.hidden = !note.textContent && c.state !== "busy";   // 忙碌態那一格空著也留在無障礙樹裡:帶著內容才出現的 live region 讀屏常常不唸
  box.appendChild(note);
  if (c.err) { const e = libEl("p", "err"), m = libEl("span", "fault-mark"); m.setAttribute("aria-hidden", "true"); e.append(m, libEl("span", "", t("lib.err.noNew"))); box.appendChild(e); }
  if (LIB.dlFail && LIB.dlFail.id === s.id && c.state !== "pending") {
    const e = libEl("p", "err"), m = libEl("span", "fault-mark"); m.setAttribute("aria-hidden", "true"); e.setAttribute("role", "status");
    e.append(m, libEl("span", "", t(libDlKey(LIB.dlFail.kind)))); box.appendChild(e);
  }
  if (hadFocus) { const b = box.querySelector("button:not(:disabled)"); if (b) b.focus(); }   // 停用的(下載中)接不了焦點:那條路由 libSend 自己還
}

// 回合中點了停用的主鈕:就地寫那句(不整個重畫,焦點留在鈕上);記下是哪一支,忙碌中重畫時補回
function libBusyTell(s) {
  LIB.busyTold = s.id;
  const n = $("lib-cta-note"), b = libCtaMain();
  if (n) { n.textContent = t("turn.busy"); n.hidden = false; }
  if (b) b.setAttribute("aria-describedby", "lib-cta-note");
}

/* ── 成功筆記(spec-0.1.12-library-notes §2.3–2.5):詳情的入口卡 → 中欄第三層閱讀頁 ── */
function libChevron() {
  const NS = "http://www.w3.org/2000/svg", svg = document.createElementNS(NS, "svg"), p = document.createElementNS(NS, "path");
  svg.setAttribute("class", "ic"); svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true"); p.setAttribute("d", "m9 18 6-6-6-6");
  svg.appendChild(p);
  return svg;
}
function libNoteLink(s) {
  const b = libEl("button", "lib-noteln"); b.type = "button"; b.id = "lib-noteln";
  const l = libEl("span", "l"), go = libEl("span", "go");
  l.append(libEl("span", "k", t("lib.note.k")), libEl("span", "t", libNoteTitle(s, LANG) || t("lib.note.fallback")));   // 清單沒帶標題(舊 api)就寫固定字,入口照出
  go.appendChild(libChevron());
  b.append(l, go);
  b.addEventListener("click", () => libNoteOpen(s));
  return b;
}
function libNoteOpen(s) {
  const B = libBag(), id = libNoteId(s, LANG);
  if (!id) return;
  B.detScroll = $("lib-body").scrollTop; B.note = id;
  libPaint(); $("lib-body").scrollTop = 0;
  const h = $("lib-nt-title"); if (h) h.focus();
}
// 回到詳情(頂部返回、頁尾「回到策略」同一條):捲回進來前的位置、焦點還給入口卡
function libNoteBack() {
  const B = libBag(); B.note = null; LIB.noteSeq++;
  libPaint(); $("lib-body").scrollTop = B.detScroll || 0;
  const b = $("lib-noteln"); if (b) b.focus(); else $("lib-back").focus();
}
function libPaintNote(s) {
  libChartDrop();
  const det = $("lib-det"); det.hidden = false; det.textContent = "";
  const nt = libEl("article", "nt"); nt.setAttribute("aria-labelledby", "lib-nt-title");
  const h = libEl("h5", "nt-title", libNoteTitle(s, LANG)); h.id = "lib-nt-title"; h.tabIndex = -1;
  const meta = libEl("div", "nt-meta"), body = libEl("div", "nt-slot");
  nt.append(libEl("div", "nt-k", t("lib.note.k")), h, meta, body);
  det.appendChild(nt);
  libNoteLoad(s, libBag().note);
}
// canon Loader:200ms 內回來不畫 skeleton;畫了至少留 300ms。標題已知就先畫標題,不知道時標題位置也是一條 skeleton
async function libNoteLoad(s, id) {
  const seq = ++LIB.noteSeq, here = () => LIB.noteSeq === seq && !$("lib").hidden && libBag().note === id && !!$("lib-nt-title");
  let shownAt = 0;
  const timer = setTimeout(() => {
    if (!here()) return;
    shownAt = Date.now();
    const h = $("lib-nt-title"), slot = $("lib-det").querySelector(".nt-slot");
    if (!h.textContent) { h.textContent = ""; const k = libEl("span", "sk nt-sk-h"); k.setAttribute("aria-hidden", "true"); h.appendChild(k); }
    const sk = libEl("div", "nt-body nt-sk"); sk.setAttribute("aria-hidden", "true");
    [[82, "h"], 0, [96], [88], [92], [70], 0, [90], [84], [60]].forEach((x) => { if (!x) { sk.appendChild(libEl("div", "nt-sk-gap")); return; } const b = libEl("div", "sk" + (x[1] ? " nt-sk-h" : "")); b.style.width = x[0] + "%"; sk.appendChild(b); });
    slot.textContent = ""; slot.appendChild(sk);
  }, 200);
  let n = null;
  try { n = await window.blave.libraryNote(id); } catch (_) { n = null; }
  clearTimeout(timer);
  if (!here()) return;
  if (shownAt) {
    const hold = typeof rpWaitHold === "function" ? rpWaitHold(shownAt, Date.now()) : 0;
    if (hold) { await new Promise((res) => setTimeout(res, hold)); if (!here()) return; }
  }
  const h = $("lib-nt-title"), slot = $("lib-det").querySelector(".nt-slot"), meta = $("lib-det").querySelector(".nt-meta");
  slot.textContent = "";
  const ok = n && typeof n === "object" && typeof n.html === "string" && n.html;
  if (!ok) {
    if (h.querySelector(".sk")) h.textContent = libNoteTitle(s, LANG) || "";
    const st = libEl("p", "lib-state"); st.setAttribute("role", "status");
    const b = libEl("button", "btn-out", t("lib.retry")); b.type = "button";
    b.addEventListener("click", () => { h.focus(); slot.textContent = ""; libNoteLoad(s, id); });   // 先把焦點交給標題再清:不然被拿掉的這顆鈕會把焦點丟到 BODY
    st.append(t("lib.note.err"), document.createElement("br"), b); slot.appendChild(st);
    return;
  }
  h.textContent = (typeof n.title === "string" && n.title) || libNoteTitle(s, LANG) || "";
  meta.textContent = ""; if (typeof n.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(n.date)) meta.appendChild(libMono(n.date));
  // DOMParser 的 text/html 文件是惰性的(不跑 script、不載資源);再由 libNoteBuild 只用白名單標籤、零屬性重建
  slot.appendChild(libNoteBuild(new DOMParser().parseFromString(n.html, "text/html").body, (tag, cls) => libEl(tag, cls)));
  const foot = libEl("div", "nt-foot"), back = libEl("button", "btn-out", t("lib.note.back")); back.type = "button";
  back.addEventListener("click", libNoteBack);
  foot.appendChild(back); slot.appendChild(foot);
  libTrack("library_note");
}

/* ── 用這支(規格 §4.1):確認框 → 送一句固定訊息 ── */
function libAsk(s, opener) {
  if (typeof running !== "undefined" && running) return;
  if (LIB.pending) return;   // 代下載那一兩秒 running 還是 false:切到另一支再按不能起第二個下載
  if (typeof envCanSwitch === "function" && !envCanSwitch()) return;   // 別的框開著 / 選字中
  const cloud = libEnv() === "cloud", fee = libFeeLine(libEnv(), LIB.data ? LIB.data.dataAccess : null, libNeeds(s));
  const again = libCtaOf(s).state === "installed";   // 頁首拿掉了覆蓋說明,改在按下「再下載一份」後的框裡講
  confirmBox({
    title: t(again ? "lib.cf.titleAgain" : "lib.cf.title", { title: s.title }),
    lines: [...(again ? [t("lib.cf.l0Again", { where: libWhere() })] : []), t(cloud ? "lib.cf.l1" : "lib.cf.l1Local"), t("lib.cf.l2"), ...(fee ? [t("lib.note.billed")] : [])],
    ok: t(again ? "lib.cf.okAgain" : "lib.cf.ok"), opener, env: cloud ? "cloud" : undefined, footWhere: cloud ? t("lib.cf.cloudNote") : undefined,
    onOk: () => libSend(s),
  });
  $("del-title").title = $("del-title").textContent;   // 只在 CSS 截一次(單行 ellipsis),全文放 title
}
/* 送出:這條對話還沒講過話就送在這條,否則開新對話;成功(跑起來)才記進行中與 library_use。
   本機先由外殼代下載(§4.2;主行程 libraryDownload 寫 workspace/tmp/library_<id>.py),成功才送 lib.msgLocal——
   那句是 runtime 契約(references/marketplace.md › Desktop-downloaded picks)。雲端照舊送 lib.msg / lib.msgPaid,外殼寫不進雲端主機 */
async function libSend(s) {
  if (LIB.pending) return;
  const env = libEnv(), local = env !== "cloud";
  const msg = libMsg(s, t(local ? "lib.msgLocal" : libIsFree(s) ? "lib.msg" : "lib.msgPaid"));
  if (!msg) return;
  if (typeof paneSt !== "undefined" && paneSt.chat.off) paneToggle("chat", false);   // 聊天欄收著就先展開:過程在那裡回報
  const cl = env === "cloud" ? libCloudList() : RP.list, before = cl ? new Map(cl.map((x) => [x.name, x.mtime])) : null;   // 同 stratRefresh 的比法:名字 + mtime;雲端清單缺席就不記(之後不猜)
  if (env === "cloud") LIB.cloudWait = null;   // 上一支還在等清單跟上就放掉:寧可它沒標「已安裝」,也不能把第二支的資料夾記到第一支
  LIB.dlFail = null;
  let send = msg, opts;
  if (local) {
    // 送出對象在按下去那一刻定案:下載那一兩秒裡切到雲端視角,這句也不能變成送給雲端主機(那邊沒有 tmp/library_<id>.py)
    opts = { viewing: typeof chatViewing === "function" ? chatViewing() : { env: "local" } };
    LIB.pending = { id: s.id, env, before, stage: "dl" }; LIB.noNew = null; libSync();
    let r = null;
    try { r = await window.blave.libraryDownload(s.id); } catch (_) { r = null; }
    if (!r || r.ok !== true) {
      LIB.pending = null;
      const kind = r && ["blocked", "gone", "anonGone", "signin", "rateLimited"].includes(r.kind) ? r.kind : "fail";
      if (kind === "gone" || kind === "anonGone") libInvalidate();   // 下架了(或匿名那條已不給):清單重拉(先清再記,libInvalidate 會把 dlFail 清掉)
      LIB.dlFail = { id: s.id, kind };
      libSync(); const b = libCtaMain(); if (b) b.focus();
      return;
    }
    if (r.legacy) {   // workspace 還是舊契約:照舊由 agent 自己下載
      send = libMsg(s, t(libIsFree(s) ? "lib.msg" : "lib.msgPaid"));
      if (!send) { LIB.pending = null; libSync(); return; }
    }
    LIB.pending.stage = "turn"; libSync();
  }
  if (csTitle) csStartNew();
  submitMessage(send, opts).then((ok) => {
    if (ok) {
      LIB.pending = { id: s.id, env, before }; LIB.noNew = null; libTrack("library_use");
      // 這支的資料需求(§8):只在本機送——雲端沒有資料牆,這個屬性在那邊沒有意義
      if (local) { try { window.blave.trackEvent("lib_pick", { data: libPickData(s) }); } catch (_) { } }
    }
    else if (local) { LIB.pending = null; LIB.dlFail = { id: s.id, kind: "unsent" }; }   // 下載中有別句先送出(回合在跑)等:講出來,不靜默
    libSync();
    // 回合送出了,但引擎是 Blave AI 而帳號不能跑:下一步就是 402(按了「使用」但被擋)
    const a = typeof acct !== "undefined" ? acct : null;
    if (ok && typeof cur !== "undefined" && cur === "blave" && a && a.can_run === false) libBlocked(a.reason === "NO_CREDIT" ? "ai_no_credit" : "ai_no_card");
  });
}

/* ── 購買(規格 §4.4):兩段確認框對齊網頁 libBuy / libPurchase;憑證只在主行程 ── */
function libBuyBox(s, stage, opener, o) {
  if (LIB.buying !== null || LIB.pending) return;   // 代下載中:買完接著的 libSend 會被擋掉,變成付了錢卻沒裝
  if (typeof envCanSwitch === "function" && !envCanSwitch()) return;
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
  LIB.buying = s.id; libSync();
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
  if (branch === "ok") { s.purchased = true; libSync(); const b = libCtaMain(); if (b) b.focus(); libSend(s); libRefresh(); return; }   // 鈕上已經寫了「並使用」:不再開下載框
  libSync();
  const opener = libCtaMain();
  if (branch === "topup") libBuyBox(s, "topup", opener, { balance: r.body.balance });
  else if (branch === "noCard") libBuyBox(s, "noCard", opener, {});
  else if (branch === "inProgress") libBuyBox(s, "inProgress", opener, {});
  else libBuyBox(s, "confirm", opener, { failed: true, confirmTopup });
}

/* ── 曲線(lightweight-charts;顏色接法同 report-trades.js buildChart)── */
function libChartDrop() { if (LIB.chart) { try { LIB.chart.remove(); } catch (_) { } LIB.chart = null; } }   // remove 丟例外 = 已經拆了
function libChartDraw(host, r) {
  const data = libCurve(r.spark, r.equity_from, r.equity_to);
  if (!data || typeof LightweightCharts === "undefined") { host.replaceWith(libEl("p", "chart-none", t("lib.noCurve"))); return; }
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
    const series = chart.addSeries(LWC.LineSeries, { color: tok("--color-green"), lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    series.setData(data);
    series.createPriceLine({ price: 1, color: tok("--ink-3"), lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, axisLabelVisible: false });
    chart.timeScale().fitContent();
    LIB.chart = chart;
  } catch (_) { chart.remove(); host.replaceWith(libEl("p", "chart-none", t("lib.noCurve"))); }
}

/* ── 接線(這支比 app.js 先載:只用 getElementById,不碰 app.js 的全域;handler 裡的才在點擊時取)── */
(function libWire() {
  const g = (id) => document.getElementById(id);
  g("lib-nav").addEventListener("click", () => { if (!libBag().open) libOpen(); else sideReclick(() => libLeave()); });   // 再點一次 = 回 welcome(trade.js sideReclick)
  g("chat-lib").addEventListener("click", () => libOpen());
  g("lib-back").addEventListener("click", libBack);
  g("lib-seg").addEventListener("click", (e) => { const b = e.target.closest("button[data-mkt]"); if (!b) return; libBag().mkt = b.dataset.mkt; libPaint(); });
  g("lib-body").addEventListener("scroll", () => { const B = libBag(); if (!B.detail) B.scroll = g("lib-body").scrollTop; });
  window.addEventListener("focus", () => { libRefresh(); libIdeaSync(); });   // 去瀏覽器綁卡 / 儲值回來:閘門要解(主行程回前景也會重問 account_status)
  g("chat-idea").addEventListener("click", () => { if (typeof ideaOpen === "function") ideaOpen(g("chat-idea"), "welcome", "any"); });   // 歡迎頁籤:開找點子框,市場不限
  libIdeaSync();
  window.blave.libraryInstalled().then((m) => { if (m && typeof m === "object") LIB.installed = m; }).catch(() => {});
})();
