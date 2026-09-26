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
   - 付不出資料費(spec-desktop-0.1.6 §3):why 只有一個來源(主行程 libraryList 回的 why),詳情的主鈕與清單頂端的閘門卡照它分流。
   - 付費策略在 app 內買(§4.4):購買框兩段對齊網頁 libBuy / libPurchase;憑證只在主行程(帳號 token + app 專用密鑰)。
   用到 app.js 的 $ / t / LANG / hasToken / running / RP / RPC / csTitle / csStartNew / submitMessage / confirmBox / delClose / setOpen / setCat /
   planOpen / stratSelect / rpCloudSelect / paneSt / paneToggle、trade.js 的 ENV / TR_BAGS / trLeave / envShowMain / envCanSwitch / envCloudKind /
   envHeadState——都在呼叫時才取(這支比 app.js 先載)。 */

/* ── 純邏輯(tests/check_shell_library.js 從原文切出來跑;這一段不准碰 DOM / i18n)── */
const LIB_DAY = 86400000;
const LIB_TW_SYM_RE = /^(TXF|MXF|TMF|\d{4,6}[A-Z]?)$/;
const LIB_PAIR_RE = /^([A-Z0-9]{1,10})USDT$/;
// 分段只做前端篩選:category 含 TW / 台 → 台股;api 的 category 值不一致(trend / bundle 都有),用 report.symbol 是不是台指期 / 純數字股票代號輔助;判不出的歸加密
function libMarket(s) {
  const cat = s && typeof s.category === "string" ? s.category : "";
  if (/(^|[^A-Za-z])TW([^A-Za-z]|$)|\u53f0/.test(cat)) return "tw";   // \u53f0 = 台
  const sym = s && s.report && typeof s.report.symbol === "string" ? s.report.symbol : "";
  return LIB_TW_SYM_RE.test(sym) ? "tw" : "crypto";
}
function libDays(from, to) {
  const t0 = Date.parse(typeof from === "string" ? from : ""), t1 = Date.parse(typeof to === "string" ? to : "");
  return isFinite(t0) && isFinite(t1) && t1 >= t0 ? Math.round((t1 - t0) / LIB_DAY) : null;
}
function libYears(s) { const r = s && s.report, d = r ? libDays(r.equity_from, r.equity_to) : null; return d === null ? null : Math.round((d / 365.25) * 10) / 10; }
function libCreated(s) { const t0 = s && typeof s.created_at === "string" ? Date.parse(s.created_at.replace(" ", "T")) : NaN; return isFinite(t0) ? t0 : null; }
function libListedDays(s, now) { const c = libCreated(s); return c === null ? null : Math.max(0, Math.floor((now - c) / LIB_DAY)); }
function libIsFree(s) { return !(s && typeof s.price === "number" && s.price > 0); }
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
/* CTA 態(規格 §1.3 + §4.4,由上到下取第一個成立的;進行中提到最前——那支的回合就是它的進度)。c = { running, env, signedIn, dataAccess, why, cloud: "live"|"stale"|"stopped"|null,
   pending, noNew, buying, installedName }。回 { state, paid, name, err, why }:paid = 付費且還沒買;err = 上一輪是這支的下載、結束時沒新策略;
   why = noData 態的原因(no_card / no_balance / unknown;主行程算的,只在 noData 帶)。
   installedName 兩個視角各有來源(本機 = userData 的對照表、雲端 = 這次開 app 期間看到雲端清單多出來的那支),這裡只認有沒有 */
function libCta(s, c) {
  const paid = !libIsFree(s) && !s.purchased && !s.is_owner, local = c.env !== "cloud";
  const st = (state, name) => ({ state, paid, name: name || null, err: c.noNew === s.id && (state === "free" || state === "owned" || state === "installed"), why: state === "noData" ? (c.why === "no_card" || c.why === "no_balance" ? c.why : "unknown") : null });
  if (c.pending === s.id) return st("pending");   // 正在下載的那支:回合當然在跑,它講的是自己的進度,不是「上一輪還在跑」
  if (c.running) return st("busy");
  if (local && c.signedIn === false) return st("signedOut");
  if (local && c.dataAccess === "none") return st("noData");
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
/* ── 純邏輯到此 ── */

const LIB = { bags: { local: libNewBag(), cloud: libNewBag() }, data: null, loading: false, skel: false, failed: false, stale: false, seq: 0,
  pending: null, noNew: null, buying: null, installed: {}, chart: null, paintedEnv: null, reports: new Map(),   // reports: id → Promise<report|null>(詳情的 400 點曲線 + 回測期間)
  cloudInstalled: {}, cloudWait: null, cloudNames: null };   // 雲端視角的「已安裝」(只在這次 app 開著的期間;見 libCloudChanged)
const LIB_CLOUD_WAIT_MS = 3 * 60 * 1000;   // 回合結束後等雲端清單跟上的上限(主機的回報器有延遲);過了就不再認新出現的那支是這次下載的
function libNewBag() { return { open: false, detail: null, mkt: "all", scroll: 0, row: null }; }
const libEnv = () => (typeof ENV !== "undefined" && ENV.cur === "cloud" ? "cloud" : "local");
const libBag = (env) => LIB.bags[(env || libEnv()) === "cloud" ? "cloud" : "local"];
const libWhere = () => t(libEnv() === "cloud" ? "lib.where.cloud" : "lib.where.local");
const libFx = () => Number(t("lib.fxRate")) !== 1;
const libPriceText = (s) => libAmount(s.price, t("lib.fxRate"), t("lib.currency"), LANG, true);
const libBalanceText = (v) => libAmount(v, t("lib.fxRate"), t("lib.currency"), LANG, false) || "—";
// 兩句接起來:zh 全形句號後不留空格、en 留一個(brand 全形標點);不在字串表裡塞空格
function libJoin(a, b) { return b ? a + (LANG === "zh" ? "" : " ") + b : a; }
function libTrack(name) { try { if (window.blave && typeof window.blave.trackFeature === "function") window.blave.trackFeature(name); } catch (_) { } }   // 追蹤永遠不擋功能
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
  if (w) { if (libCloudSettle(w, list)) { LIB.cloudWait = null; changed = true; libSync(); } else if (Date.now() > w.until) LIB.cloudWait = null; }
  const names = list.map((x) => x.name).join("\n");
  if (names !== LIB.cloudNames) { LIB.cloudNames = names; changed = true; }
  if (changed) libCloudRepaintList();
}
function libCtaOf(s) {
  const env = libEnv();
  return libCta(s, {
    running: typeof running !== "undefined" && running === true, env,
    signedIn: typeof hasToken !== "undefined" ? !!hasToken : !!(LIB.data && LIB.data.signedIn),
    dataAccess: LIB.data ? LIB.data.dataAccess : null, why: LIB.data ? LIB.data.why : null, cloud: env === "cloud" ? libCloud() : null,
    pending: LIB.pending ? LIB.pending.id : null, noNew: LIB.noNew, buying: LIB.buying,
    installedName: libInstalledOf(s, env),
  });
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
  libLoad(false);   // 每次進視圖都重問主行程(它有 5 分鐘快取;dataAccess 每次現算)——綁卡 / 換帳號 / 換語言之後畫面才會跟上
  const h = B.detail ? $("lib-back") : $("lib-h");
  if (h && h.offsetParent) h.focus();
  libTrack("library_open");
}
// 選了策略 / 開自動下單:那一邊的策略庫收起來(中欄一次只有一個視圖)。trOpen 直接翻 DOM、不經 envShowMain,所以這裡自己收 #lib
function libLeave(env) {
  const B = libBag(env);
  if (!B.open) return;
  B.open = false; LIB.noNew = null;
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
}

/* ── 資料 ─────────────────────────────────────────────── */
async function libLoad(force) {
  const seq = ++LIB.seq;
  LIB.loading = true; LIB.failed = false; LIB.skel = false; LIB.stale = false;
  let shownAt = 0;
  // canon Loader:200ms 內回來不畫 skeleton;畫了至少留 300ms(rpWaitHold 同一個數)
  const timer = setTimeout(() => { if (LIB.seq !== seq || LIB.data) return; LIB.skel = true; shownAt = Date.now(); if (!$("lib").hidden) libPaint(); }, 200);
  let r = null;
  try { r = await window.blave.libraryList(LANG, force === true); } catch (_) { r = null; }
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
function libInvalidate() { LIB.stale = true; LIB.cloudInstalled = {}; LIB.cloudWait = null; LIB.cloudNames = null; libRefresh(); }   // 雲端「已安裝」是這個帳號的記憶:換人就丟
// 視圖開著時重問一次(設定關掉、視窗回前景:綁卡 / 儲值後閘門要解)
function libRefresh() { if (!$("lib").hidden) libLoad(false); }
// 送出「用這支」那一輪結束(app.js onTurnEnd,stratRefresh(true) 之後):本機多了一支就記下對照表;沒有就出灰字。雲端只重問一次狀態
function libTurnEnd() {
  const p = LIB.pending;
  if (!p) return;
  LIB.pending = null;
  if (p.env === "local") {
    // 新出現、或同名但 mtime 變了(「再下載一份」是整份覆蓋同名那支)都算成功;對照表已記的名字優先認它
    const touched = RP.list.filter((x) => p.before.get(x.name) !== x.mtime);
    const known = LIB.installed[String(p.id)], hit = touched.find((x) => x.name === known) || touched[0];
    if (hit) libInstalledSet(p.id, hit.name); else LIB.noNew = p.id;
  } else {
    if (window.blave && typeof window.blave.cloudRefresh === "function") window.blave.cloudRefresh().catch(() => {});
    if (libCloudSettle(p, libCloudList())) libCloudRepaintList();
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
  $("lib-head-list").hidden = !!det; $("lib-back").hidden = !det;
  $("lib-seg").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.mkt === B.mkt ? "true" : "false"));
  if (det) { $("lib-rows").textContent = ""; $("lib-gate").hidden = true; $("lib-state").hidden = true; libPaintDetail(det); }
  else { libChartDrop(); $("lib-det").hidden = true; $("lib-det").textContent = ""; libPaintList(); $("lib-body").scrollTop = B.scroll || 0; }
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
  const B = libBag(), rows = $("lib-rows"), state = $("lib-state"), gate = $("lib-gate");
  rows.textContent = ""; state.hidden = true; state.textContent = ""; gate.hidden = true; gate.textContent = "";
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
  // 閘門卡(§3.3):只在本機視角、登入著、付不出資料費時出;沒登入的清單是公開清單,人可以先逛
  if (libEnv() === "local" && LIB.data.signedIn && LIB.data.dataAccess === "none") { gate.hidden = false; gate.appendChild(libGateNode(LIB.data.why)); }
  const v = libVisible(LIB.data.strategies, B.mkt);
  if (!v.length) { state.hidden = false; state.textContent = t(LIB.data.strategies.length ? "lib.emptyMkt" : "lib.empty"); }
  v.forEach((s) => rows.appendChild(libRow(s)));
}
/* 付不出資料費的出口(§3.2):no_card 有試用 → 「綁卡,送 {t} 天資料」/ 沒試用或 t 空 → 「前往綁卡」/ no_balance → 「儲值」/ unknown → 描邊「資料與雲端方案」
   (查不到狀態時不擺一顆要錢的主鈕)。鈕都開 設定 › 資料與雲端方案。試用天數來自 planVars().t(api 的 trial.days),不寫死 */
function libGateBtn(why) {
  const trial = typeof acct !== "undefined" && acct && acct.trial_eligible === false ? false : true;
  const tDays = typeof planVars === "function" ? planVars().t : "";
  const b = libEl("button", why === "unknown" ? "btn-out" : "btn-fill", why === "no_balance" ? t("lib.gate.topup") : why === "unknown" ? t("set.cat.plan") : trial && tDays ? t("lib.gate.bindCard", { t: tDays }) : t("plan.addCard"));
  b.type = "button"; b.addEventListener("click", () => planOpen());
  return b;
}
// 試用天數只在鈕字講(libGateBtn),說明句不重述
function libGateText(why) {
  return t(why === "no_balance" ? "lib.gate.noBalance" : why === "unknown" ? "lib.gate.unknown" : "lib.gate.noCard");
}
// 清單頂端那一張(§3.3):左一句(同詳情鈕下說明的第一句)、右同一顆主鈕
function libGateNode(why) {
  const f = document.createDocumentFragment();
  f.append(libEl("p", "", libGateText(why)), libGateBtn(why));
  return f;
}
function libShowDetail(id) {
  const B = libBag(); B.row = id; B.detail = id;
  libPaint(); $("lib-body").scrollTop = 0;
  $("lib-back").focus();
}
function libBack() {
  const B = libBag(); B.detail = null; LIB.noNew = null;
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
  box.textContent = "";
  const c = libCtaOf(s), row = libEl("div", "row"), note = libEl("p", "note");
  const btn = (cls, label, on) => { const b = libEl("button", cls, label); b.type = "button"; if (on) b.addEventListener("click", () => on(b)); return b; };
  const dis = (label) => { const b = btn("btn-fill", label); b.disabled = true; return b; };
  const buyLabel = () => t("lib.buy", { price: libPriceText(s) || "—" });
  const paidNote = () => { note.textContent = libJoin(t("lib.note.paid"), libFx() ? t("lib.fxNote") : ""); };
  switch (c.state) {
    case "signedOut": row.appendChild(btn("btn-fill", t("cn.blave.btn"), () => setOpen().then(() => setCat("acct")))); note.classList.add("up"); note.textContent = t(c.paid ? "lib.gate.signedOutBuy" : "lib.gate.signedOut"); break;   // 主鈕「登入 Blave」→ 設定 › 帳號(§3.2 末,同 noData 一個重量)
    case "noData": row.appendChild(libGateBtn(c.why)); note.classList.add("up"); note.textContent = libGateText(c.why); break;
    case "busy": row.appendChild(dis(c.paid ? buyLabel() : t("lib.use"))); note.textContent = t("turn.busy"); break;
    case "stopped": case "stale": row.appendChild(dis(c.paid ? buyLabel() : t("lib.use"))); note.textContent = t(c.state === "stopped" ? "ho.gate.stopped" : "ho.gate.stale"); break;
    case "pending": row.appendChild(dis(t("lib.pending"))); note.textContent = t("lib.note.pending"); break;
    case "buying": row.appendChild(dis(t("lib.buy.busy"))); paidNote(); break;
    case "installed":
      row.append(btn("btn-fill", t("lib.open"), () => (libEnv() === "cloud" ? rpCloudSelect(c.name) : stratSelect(c.name))), btn("btn-quiet", t("lib.again"), (b) => libAsk(s, b)));
      note.textContent = t("lib.note.installed", { where: libWhere() }); break;
    case "paid": row.appendChild(btn("btn-fill", buyLabel(), (b) => libBuyBox(s, "confirm", b, {}))); paidNote(); break;
    case "owned": row.appendChild(btn("btn-fill", t("lib.use"), (b) => libAsk(s, b))); note.textContent = t("lib.note.owned"); break;
    default:
      row.appendChild(btn("btn-fill", t("lib.use"), (b) => libAsk(s, b)));
      note.textContent = t("lib.note.free");
  }
  if (row.childNodes.length) box.appendChild(row);
  box.appendChild(note);
  if (c.err) { const e = libEl("p", "err"), m = libEl("span", "fault-mark"); m.setAttribute("aria-hidden", "true"); e.append(m, libEl("span", "", t("lib.err.noNew"))); box.appendChild(e); }
}

/* ── 用這支(規格 §4.1):確認框 → 送一句固定訊息 ── */
function libAsk(s, opener) {
  if (typeof running !== "undefined" && running) return;
  if (typeof envCanSwitch === "function" && !envCanSwitch()) return;   // 別的框開著 / 選字中
  const cloud = libEnv() === "cloud", billed = !cloud && LIB.data && LIB.data.dataAccess === "billed";
  confirmBox({
    title: t("lib.cf.title", { title: s.title }), lines: [t("lib.cf.l1"), t("lib.cf.l2"), ...(billed ? [t("lib.note.billed")] : [])],
    ok: t("lib.cf.ok"), opener, env: cloud ? "cloud" : undefined, footWhere: cloud ? t("lib.cf.cloudNote") : undefined,
    onOk: () => libSend(s),
  });
  $("del-title").title = $("del-title").textContent;   // 只在 CSS 截一次(單行 ellipsis),全文放 title
}
// 送出:這條對話還沒講過話就送在這條,否則開新對話;成功(跑起來)才記進行中與 library_use
function libSend(s) {
  const msg = libMsg(s, t(libIsFree(s) ? "lib.msg" : "lib.msgPaid"));
  if (!msg) return;
  if (typeof paneSt !== "undefined" && paneSt.chat.off) paneToggle("chat", false);   // 聊天欄收著就先展開:過程在那裡回報
  if (csTitle) csStartNew();
  const env = libEnv(), cl = env === "cloud" ? libCloudList() : RP.list, before = cl ? new Map(cl.map((x) => [x.name, x.mtime])) : null;   // 同 stratRefresh 的比法:名字 + mtime;雲端清單缺席就不記(之後不猜)
  if (env === "cloud") LIB.cloudWait = null;   // 上一支還在等清單跟上就放掉:寧可它沒標「已安裝」,也不能把第二支的資料夾記到第一支
  submitMessage(msg).then((ok) => { if (ok) { LIB.pending = { id: s.id, env, before }; LIB.noNew = null; libTrack("library_use"); } libSync(); });
}

/* ── 購買(規格 §4.4):兩段確認框對齊網頁 libBuy / libPurchase;憑證只在主行程 ── */
function libBuyBox(s, stage, opener, o) {
  if (LIB.buying !== null) return;
  if (typeof envCanSwitch === "function" && !envCanSwitch()) return;
  const price = libPriceText(s) || "—", title = t("lib.buy.title", { title: s.title });
  if (stage === "confirm") {
    const lines = [t("lib.buy.price", { price })];
    const extra = document.createDocumentFragment();
    extra.appendChild(libEl("p", "cf-note", t("lib.buy.lead")));
    if (libEnv() === "local" && LIB.data && LIB.data.dataAccess === "billed") extra.appendChild(libEl("p", "cf-note", t("lib.note.billed")));   // 條件同 libAsk:雲端的資料費已併進主機費
    if (libFx()) extra.appendChild(libEl("p", "cf-note", t("lib.fxNote")));   // fx 註是註,不跟價格同一階
    // 失敗行不寫「沒有扣款」:網路類失敗無法確定;重按由 api 的 already-purchased 擋重複扣款
    if (o.failed) { const e = libEl("p", "plan-err is-calm"), m = libEl("span", "fault-mark"); m.setAttribute("aria-hidden", "true"); e.setAttribute("role", "status"); e.append(m, libEl("span", "", t("lib.buy.failed"))); extra.appendChild(e); }
    confirmBox({ title, lines, extra, ok: t("lib.buy.ok"), opener, onOk: () => libPurchase(s, o.confirmTopup === true) });
  } else if (stage === "topup") {
    confirmBox({ title, lines: [t("lib.buy.topup", { balance: libBalanceText(o.balance), price })], ok: t("lib.buy.charge"), opener, onOk: () => libPurchase(s, true) });
  } else if (stage === "noCard") {
    confirmBox({ title, lines: [t("lib.buy.noCard")], ok: t("acct.addCard"), opener, onOk: () => planOpen() });
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
  g("lib-nav").addEventListener("click", () => { if (!libBag().open) libOpen(); });
  g("chat-lib").addEventListener("click", () => libOpen());
  g("lib-back").addEventListener("click", libBack);
  g("lib-seg").addEventListener("click", (e) => { const b = e.target.closest("button[data-mkt]"); if (!b) return; libBag().mkt = b.dataset.mkt; libPaint(); });
  g("lib-body").addEventListener("scroll", () => { const B = libBag(); if (!B.detail) B.scroll = g("lib-body").scrollTop; });
  window.addEventListener("focus", () => libRefresh());   // 去瀏覽器綁卡 / 儲值回來:閘門要解(主行程回前景也會重問 account_status)
  window.blave.libraryInstalled().then((m) => { if (m && typeof m === "object") LIB.installed = m; }).catch(() => {});
})();
