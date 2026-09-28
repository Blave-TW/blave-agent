// Blave 電腦版 — 報告公開分享(主行程用)。契約 blave-canon docs/report-sharing.md;端點 api openclaw/desktop_auth.py 的
// POST /oauth/desktop/share/{state,publish,update,revoke,list}(body 多一個不認得的欄位就 400,所以這裡逐欄組、不轉交 renderer 的物件)。
//
// 為什麼在主行程:兩顆憑證(帳號 token + app_secret)只在這裡(同 cloud.js 檔頭);本機報告的全文與圖由主行程讀檔,
// renderer 只給得了 view / id / 掛名二選一 / 有沒有勾。聲明版本與條款版本也在這裡加:那是法遵證據(契約 §2),
// 不能讓畫面層決定送哪一版。
//
// 這個檔不 require electron;HTTP、憑證、讀本機報告都由呼叫端注入(測試用假的)。
// 三行勾選的字面一改就換(契約 §1「字面一有變動,聲明版本就進位」);web report_share.js 送同一個值
const DISCLAIMER_VERSION = "rs-ack-2026.09.28";
// = web/app/legal.py TOS_VERSION(api 沒有端點給這個值;tests/check_shell_report_share.js 在 monorepo 版面比對兩邊)
const TOS_VERSION = "2026-09-28";
const EP = { state: "/oauth/desktop/share/state", publish: "/oauth/desktop/share/publish", update: "/oauth/desktop/share/update", revoke: "/oauth/desktop/share/revoke", list: "/oauth/desktop/share/list" };
const VIEWS = ["local", "cloud"];
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/, CODE_RE = /^[A-Za-z0-9_-]{4,64}$/;
const NAME_MAX = 64;   // = api BYLINE_MAX

const ts = (v) => (Number.isInteger(v) && v >= 946684800 && v <= 4102444800 ? v : null);
/* api 的 share 物件 → 畫面用的形狀;形狀不對 → null(當沒公開畫,api 在下一次動作時再守) */
function cleanShare(s) {
  if (!s || typeof s !== "object" || typeof s.code !== "string" || !CODE_RE.test(s.code) || ts(s.published_at) == null) return null;
  return { code: s.code, published_at: s.published_at, byline: typeof s.byline === "string" ? s.byline.slice(0, NAME_MAX) : null,
    source_stored_at: ts(s.source_stored_at), report_stored_at: ts(s.report_stored_at) };
}
/* api 被拒回應的 error_code(agent_report_share.py)→ 外殼的代號。BAD_IMAGE 對人講的跟 BAD_CONTENT 同一句(出口都是請 agent 整理);
   BAD_REQUEST = 外殼自己送錯(id、勾選紀錄的形狀),不是這份報告的問題 */
const API_CODES = { BAD_CONTENT: "BAD_CONTENT", BAD_IMAGE: "BAD_CONTENT", BAD_REQUEST: "BAD_REQUEST", NO_DISPLAY_NAME: "NO_DISPLAY_NAME", TOO_LARGE: "TOO_LARGE",
  NOT_SHAREABLE: "NOT_SHAREABLE", LIVE_LIMIT: "LIVE_LIMIT", DAILY_LIMIT: "DAILY_LIMIT", IMAGE_QUOTA: "IMAGE_QUOTA" };
/* 非 200 的回應 → 穩定代號(renderer 拿去查字;IPC 不搬句子)。op = state | publish | update | revoke。
   先認 api 的 error_code;讀不到(舊 api、中間的代理回的)才照狀態碼判斷 */
function failCode(res, op) {
  const st = res && res.status;
  if (!st) return "UNREACH";
  const b = res.body && typeof res.body === "object" ? res.body : {};
  const given = typeof b.error_code === "string" ? b.error_code : "";
  // 5xx 只認 507(用戶的圖片配額滿了,重送也一樣);其餘 5xx 帶什麼代號都是「連不上」
  if ((st === 507 || (st >= 400 && st < 500)) && Object.prototype.hasOwnProperty.call(API_CODES, given)) return API_CODES[given];
  if (st === 507) return "IMAGE_QUOTA";
  if (st >= 500) return "UNREACH";
  if (st === 401) return "RELOGIN";
  if (st === 429) return "RATE_LIMITED";   // 份數滿了 / 今天的次數用完有自己的代號(上面);剩下的是每分鐘限流
  if (st === 409) return "ALREADY";
  if (st === 422) return "NOT_SHAREABLE";
  if (st === 403) return "NO_MACHINE";   // 雲端視角:api 的 ERR008(Blave Agent 沒在跑),同 web 的 @blave_agent_required
  // update / revoke 的 404 = 這份沒公開;publish 的 404 = 雲端平台上沒有這份報告
  if (st === 404) return op === "publish" ? "NOT_SHAREABLE" : "NOT_PUBLIC";
  if (st === 413) return "TOO_LARGE";
  if (st === 400 && given) return "BAD_REQUEST";   // UNKNOWN_FIELD / VIEW_REQUIRED / ID_REQUIRED…:欄位送錯
  return "BAD_CONTENT";   // 沒有代號的 400 = 舊 api 的驗證器拒收
}
/* 上限(share/state、share/list 的頂層四欄;LIVE_LIMIT / DAILY_LIMIT 的 limit):不是非負整數就當沒給,畫面不出數字 */
const count = (v) => (Number.isInteger(v) && v >= 0 && v <= 100000 ? v : null);
function cleanLimits(b) {
  const o = b && typeof b === "object" ? b : {};
  return { liveCount: count(o.live_count), liveLimit: count(o.live_limit), todayCount: count(o.today_count), dailyLimit: count(o.daily_limit) };
}
const LIST_MAX = 200, TITLE_MAX = 200, ORIGINS = ["cloud", "desktop"], TYPES = ["research", "morning", "performance"];
/* share/list 的一列 → 畫面用的形狀;代碼 / 來源 / 時間不對 → null(那一列不畫)。
   url_path 不轉交:公開網址由畫面拿 code 自己組(同閱讀頁的公開列),api 回什麼路徑都進不了剪貼簿 */
function cleanListRow(r) {
  if (!r || typeof r !== "object" || typeof r.code !== "string" || !CODE_RE.test(r.code) || ORIGINS.indexOf(r.origin) < 0 || ts(r.published_at) == null) return null;
  const title = typeof r.title === "string" ? r.title.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, TITLE_MAX) : "";
  return { code: r.code, origin: r.origin, reportId: typeof r.report_id === "string" && ID_RE.test(r.report_id) ? r.report_id : null, title,
    type: TYPES.indexOf(r.type) >= 0 ? r.type : null, published_at: r.published_at, byline: typeof r.byline === "string" && r.byline.trim() ? r.byline.trim().slice(0, NAME_MAX) : null,
    sourceExists: r.origin === "cloud" && typeof r.source_exists === "boolean" ? r.source_exists : null };   // null = 不知道(desktop 袋,或 api 讀不到雲端索引)
}

/* api 拒收時回的那一句(英文、帶欄位路徑,例 blocks[3].source.url: must be an https URL)→ 只進 log:本機報告寫
   reports/upload_errors.log(agent 用 lib.report.status(id) 讀得到),兩種視角都寫主行程的 log。畫面不顯示它(Wei 0928):
   那是給產報告的 agent 讀的字,用戶看到的是 shr.badContent / shr.tooLarge 那一句與出口。
   本機報告到分享這一刻才第一次過 api 的驗證器(電腦版不跑 report_uploader),這一句丟掉的話 agent 不知道錯在哪 */
const DETAIL_MAX = 300;
function failDetail(res) {
  const b = res && res.body && typeof res.body === "object" ? res.body : {};
  const raw = typeof b.error === "string" && b.error ? b.error : typeof b.error_code === "string" ? b.error_code : "";
  return raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, DETAIL_MAX);
}
const DETAIL_CODES = ["BAD_CONTENT", "TOO_LARGE", "NOT_SHAREABLE", "IMAGE_QUOTA"];   // 這份報告被拒:原文兩個 log 都寫
const APP_LOG_CODES = ["BAD_REQUEST"];   // 外殼送錯:只寫主行程的 log(不是 agent 改報告改得掉的)

/* 尾註 id 重複(0.1.7 的 lib 在「台股大盤積木 + 任何帶來源句的積木」時會寫出兩條 src)api 一律拒收。已經在磁碟上的報告
   不重做也要能公開:送出的那一份先併好。只動送出的那份、不改檔——檔的 mtime 是「公開後改過沒有」的依據,主行程改檔會讓
   每一份都變成「改過」,也會跟正在寫檔的 lib 搶。規則 = lib/report.py unique_footnotes(tests/check_report_footnotes.py 比兩邊)。 */
const FN_TEXT_MAX = 1000, FN_ID_MAX = 32;
function joinNotes(texts) {
  let out = "";
  for (let t of texts) {
    t = t.trim();
    const core = t.replace(/[)）」』】》”’"']+$/, "");
    if (core && !/\p{P}$/u.test(core)) t += /[\u3400-\u9fff]/.test(t) ? "。" : ".";
    out += t;
  }
  return out;
}
function uniqueFootnotes(report) {
  if (!report || typeof report !== "object" || !Array.isArray(report.blocks)) return report;
  const blocks = report.blocks.map((b) => {
    if (!b || typeof b !== "object" || b.type !== "footnote" || !Array.isArray(b.items)) return b;
    const rows = [], first = new Map();
    const taken = new Set(b.items.filter((r) => r && typeof r === "object").map((r) => r.id));
    for (let it of b.items) {
      if (!it || typeof it !== "object" || typeof it.id !== "string" || typeof it.text !== "string") { rows.push(it); continue; }
      const head = first.get(it.id);
      if (!head) { it = { ...it }; first.set(it.id, it); rows.push(it); continue; }
      if ((head.url ?? null) === (it.url ?? null)) {
        if (head.text.includes(it.text.trim())) continue;
        const joined = joinNotes([head.text, it.text]);
        if ([...joined].length <= FN_TEXT_MAX) { head.text = joined; continue; }
      }
      let n = 2; const base = [...it.id].slice(0, FN_ID_MAX - 4).join("");
      while (taken.has(base + "-" + n) || first.has(base + "-" + n)) n++;
      it = { ...it, id: base + "-" + n };
      first.set(it.id, it); rows.push(it);
    }
    return { ...b, items: rows };
  });
  return { ...report, blocks };
}

/* 本機報告公開當下那份檔的 mtime(稽核 P2-6):「公開後改過沒有」拿同一台電腦的兩個 mtime 比,不拿這台的鐘比 api 的鐘。
   file = 一份小 JSON { id: { code, mtime } };讀不到 / 壞了 = 沒有紀錄(renderer 退回比 published_at) */
const STORE_MAX = 500;
function createShareStore(file) {
  const fs = require("fs"), path = require("path");
  const load = () => { try { const o = JSON.parse(fs.readFileSync(file, "utf8")); return o && typeof o === "object" && !Array.isArray(o) ? o : {}; } catch (_) { return {}; } };
  return {
    get(id, code) { const x = load()[id]; return x && x.code === code && Number.isFinite(x.mtime) ? x.mtime : null; },
    set(id, code, mtime) {
      if (!Number.isFinite(mtime)) return;
      const o = load(); delete o[id]; o[id] = { code, mtime };
      const keys = Object.keys(o); for (const k of keys.slice(0, Math.max(0, keys.length - STORE_MAX))) delete o[k];
      try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + ".tmp", JSON.stringify(o)); fs.renameSync(file + ".tmp", file); } catch (_) { /* 記不下來:退回比 published_at */ }
    },
  };
}

/* opts:{ apiBase, post(url, body) → Promise<{status, body}>, getCreds() → { token, appSecret } | null,
          readLocal(id) → { report, images: { 檔名: base64 }, mtime } | null,
          logError(id, message)(選用:本機報告被 api 拒收時寫 reports/upload_errors.log),log(message)(選用:主行程的 log),
          store(選用:createShareStore) } */
function createShareClient(opts) {
  const withMtime = (view, id, share) => (view === "local" && share && opts.store ? Object.assign(share, { local_mtime: opts.store.get(id, share.code) }) : share);
  function creds() {
    let c = null; try { c = opts.getCreds(); } catch (_) { /* Keychain 讀不到:當成沒登入 */ }
    if (!c || !c.token) return { code: "NO_LOGIN" };
    if (!c.appSecret) return { code: "RELOGIN" };   // 舊登入沒有 app_secret
    return { token: c.token, appSecret: c.appSecret };
  }
  async function call(op, view, id, extra) {
    if (VIEWS.indexOf(view) < 0 || typeof id !== "string" || !ID_RE.test(id)) return { res: null, code: "BAD_ARGS" };
    return send(op, { view, id, ...extra });
  }
  // 回應回來時再看一次現在是誰:請求在路上時換了帳號,這份就是上一個人的(同 cloud.js readOnce)。
  // fields = 憑證以外的欄位(api 對多的欄位回 400;revoke 的三種指名方式混用也是 400,所以清單那條路不帶 view / id)
  async function send(op, fields) {
    const c = creds();
    if (c.code) return { res: null, code: c.code };
    let res = null;
    try { res = await opts.post(opts.apiBase + EP[op], { token: c.token, app_secret: c.appSecret, ...fields }); } catch (_) { /* 連不上 */ }
    let cur = null; try { cur = opts.getCreds(); } catch (_) { /* 讀不到 = 沒登入 */ }
    if (!cur || cur.token !== c.token) return { res: null, code: "UNREACH" };
    return { res, code: res && res.status === 200 ? "OK" : failCode(res, op) };
  }
  return {
    /* 一份報告的公開狀態 + 能掛的名字。{ code: "OK", share: {…}|null, displayName: string|null } / { code } */
    async state(view, id) {
      const { res, code } = await call("state", view, id, {});
      if (code !== "OK") return { code };
      const b = res.body && typeof res.body === "object" ? res.body : {};
      if (!("share" in b)) return { code: "UNREACH" };
      const name = typeof b.display_name === "string" && b.display_name.trim() ? b.display_name.trim().slice(0, NAME_MAX) : null;
      return { code: "OK", share: b.share === null ? null : withMtime(view, id, cleanShare(b.share)), displayName: name, limits: cleanLimits(b) };
    },
    /* 公開 / 更新公開版本。a = { byline: "anonymous"|"name", confirmed: true, update: bool }。本機報告的全文與圖在這裡讀,除了尾註 id(見 uniqueFootnotes)原樣送 */
    async publish(view, id, a) {
      if (!a || a.confirmed !== true || (a.byline !== "anonymous" && a.byline !== "name")) return { code: "BAD_ARGS" };
      const extra = { confirmed: true, byline: a.byline, disclaimer_version: DISCLAIMER_VERSION, tos_version: TOS_VERSION };
      let loc = null;
      if (view === "local") {
        try { loc = typeof id === "string" && ID_RE.test(id) ? opts.readLocal(id) : null; } catch (_) { loc = null; }
        if (!loc || !loc.report) return { code: "NO_REPORT" };
        extra.report = uniqueFootnotes(loc.report); extra.images = loc.images || {};
      }
      const done = (share) => { if (loc && opts.store) opts.store.set(id, share.code, loc.mtime); return { code: "OK", share: withMtime(view, id, share) }; };
      const { res, code } = await call(a.update === true ? "update" : "publish", view, id, extra);
      if (code === "UNREACH" && a.update !== true) {
        // 等不到回應不等於沒公開(20 張圖的報告 api 要存一陣子):先問一次狀態,已經公開就照成功畫(稽核 P2-8)
        const st = await this.state(view, id);
        if (st.code === "OK" && st.share) return done(st.share);
      }
      // 送出時才撞到上限(開框之後別處又公開了):帶上限的數字,畫面那一句要用
      if (code === "LIVE_LIMIT" || code === "DAILY_LIMIT") return { code, limit: count(res.body.limit) };
      if (code !== "OK") {
        const mine = DETAIL_CODES.indexOf(code) >= 0;
        const detail = mine || APP_LOG_CODES.indexOf(code) >= 0 ? failDetail(res) : "";
        if (detail && mine && view === "local" && opts.logError) { try { opts.logError(id, "share refused (" + res.status + "): " + detail); } catch (_) { /* 寫不了不擋 */ } }
        if (detail && opts.log) { try { opts.log(view + " " + id + ": share refused (" + res.status + "): " + detail); } catch (_) { /* 同上 */ } }
        return { code };
      }
      const share = cleanShare(res.body && res.body.share);
      return share ? done(share) : { code: "UNREACH" };
    },
    async revoke(view, id) {
      const { code } = await call("revoke", view, id, {});
      return { code };
    },
    /* 這個帳號所有公開中的報告(兩袋都列;設定 › 公開連結)。{ code: "OK", shares: [...], limits } / { code } */
    async list() {
      const { res, code } = await send("list", {});
      if (code !== "OK") return { code };
      const b = res.body && typeof res.body === "object" ? res.body : {};
      if (!Array.isArray(b.shares)) return { code: "UNREACH" };
      return { code: "OK", shares: b.shares.slice(0, LIST_MAX).map(cleanListRow).filter(Boolean), limits: cleanLimits(b) };
    },
    // 清單上的取消分享:只憑代碼撤(原檔不在這台電腦、不在雲端也撤得掉)
    async revokeCode(code) {
      if (typeof code !== "string" || !CODE_RE.test(code)) return { code: "BAD_ARGS" };
      return { code: (await send("revoke", { code })).code };
    },
  };
}

module.exports = { createShareClient, uniqueFootnotes, createShareStore, cleanShare, cleanListRow, cleanLimits, failCode, failDetail, DISCLAIMER_VERSION, TOS_VERSION, EP };
