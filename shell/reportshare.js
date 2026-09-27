// Blave 電腦版 — 報告公開分享(主行程用)。契約 blave-canon docs/report-sharing.md;端點 api openclaw/desktop_auth.py 的
// POST /oauth/desktop/share/{state,publish,update,revoke}(body 多一個不認得的欄位就 400,所以這裡逐欄組、不轉交 renderer 的物件)。
//
// 為什麼在主行程:兩顆憑證(帳號 token + app_secret)只在這裡(同 cloud.js 檔頭);本機報告的全文與圖由主行程讀檔,
// renderer 只給得了 view / id / 掛名二選一 / 有沒有勾。聲明版本與條款版本也在這裡加:那是法遵證據(契約 §2),
// 不能讓畫面層決定送哪一版。
//
// 這個檔不 require electron;HTTP、憑證、讀本機報告都由呼叫端注入(測試用假的)。
// 三行勾選的字面一改就換(契約 §1「字面一有變動,聲明版本就進位」);web report_share.js 送同一個值
const DISCLAIMER_VERSION = "rs-ack-2026.09.27";
// = web/app/legal.py TOS_VERSION(api 沒有端點給這個值;tests/check_shell_report_share.js 在 monorepo 版面比對兩邊)
const TOS_VERSION = "2026-09-28";
const EP = { state: "/oauth/desktop/share/state", publish: "/oauth/desktop/share/publish", update: "/oauth/desktop/share/update", revoke: "/oauth/desktop/share/revoke" };
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
/* 非 200 的回應 → 穩定代號(renderer 拿去查字;IPC 不搬句子)。op = state | publish | update | revoke */
function failCode(res, op) {
  if (res && res.status === 507) return "IMAGE_QUOTA";   // 5xx 裡唯一不是「連不上」的:用戶的圖片配額滿了,重送也一樣
  if (!res || !res.status || res.status >= 500) return "UNREACH";
  const b = res.body && typeof res.body === "object" ? res.body : {};
  if (res.status === 401) return "RELOGIN";
  if (res.status === 429) return "RATE_LIMITED";
  if (res.status === 409) return "ALREADY";
  if (res.status === 422) return "NOT_SHAREABLE";
  if (res.status === 403) return "NO_MACHINE";   // 雲端視角:api 的 ERR008(Blave Agent 沒在跑),同 web 的 @blave_agent_required
  // update / revoke 的 404 = 這份沒公開;publish 的 404 = 雲端平台上沒有這份報告
  if (res.status === 404) return op === "publish" ? "NOT_SHAREABLE" : "NOT_PUBLIC";
  if (res.status === 400 && b.error_code === "NO_DISPLAY_NAME") return "NO_DISPLAY_NAME";
  return "NOT_SHAREABLE";   // 其餘 400 / 413:報告過不了 api 的驗證器,重送也一樣
}

/* api 拒收時回的那一句(帶欄位路徑,例 blocks[3].source.url: must be an https URL)→ 給畫面與 upload_errors.log 的一行。
   本機報告到分享這一刻才第一次過 api 的驗證器(電腦版不跑 report_uploader),這一句丟掉的話用戶與 agent 都不知道錯在哪 */
const DETAIL_MAX = 300;
function failDetail(res) {
  const b = res && res.body && typeof res.body === "object" ? res.body : {};
  const raw = typeof b.error === "string" && b.error ? b.error : typeof b.error_code === "string" ? b.error_code : "";
  return raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, DETAIL_MAX);
}
const DETAIL_CODES = ["NOT_SHAREABLE", "IMAGE_QUOTA"];

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
          logError(id, message)(選用:本機報告被 api 拒收時寫 reports/upload_errors.log),
          store(選用:createShareStore) } */
function createShareClient(opts) {
  const withMtime = (view, id, share) => (view === "local" && share && opts.store ? Object.assign(share, { local_mtime: opts.store.get(id, share.code) }) : share);
  function creds() {
    let c = null; try { c = opts.getCreds(); } catch (_) { /* Keychain 讀不到:當成沒登入 */ }
    if (!c || !c.token) return { code: "NO_LOGIN" };
    if (!c.appSecret) return { code: "RELOGIN" };   // 舊登入沒有 app_secret
    return { token: c.token, appSecret: c.appSecret };
  }
  // 回應回來時再看一次現在是誰:請求在路上時換了帳號,這份就是上一個人的(同 cloud.js readOnce)
  async function call(op, view, id, extra) {
    if (VIEWS.indexOf(view) < 0 || typeof id !== "string" || !ID_RE.test(id)) return { res: null, code: "BAD_ARGS" };
    const c = creds();
    if (c.code) return { res: null, code: c.code };
    let res = null;
    try { res = await opts.post(opts.apiBase + EP[op], { token: c.token, app_secret: c.appSecret, view, id, ...extra }); } catch (_) { /* 連不上 */ }
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
      return { code: "OK", share: b.share === null ? null : withMtime(view, id, cleanShare(b.share)), displayName: name };
    },
    /* 公開 / 更新公開版本。a = { byline: "anonymous"|"name", confirmed: true, update: bool }。本機報告的全文與圖在這裡讀、原樣送 */
    async publish(view, id, a) {
      if (!a || a.confirmed !== true || (a.byline !== "anonymous" && a.byline !== "name")) return { code: "BAD_ARGS" };
      const extra = { confirmed: true, byline: a.byline, disclaimer_version: DISCLAIMER_VERSION, tos_version: TOS_VERSION };
      let loc = null;
      if (view === "local") {
        try { loc = typeof id === "string" && ID_RE.test(id) ? opts.readLocal(id) : null; } catch (_) { loc = null; }
        if (!loc || !loc.report) return { code: "NO_REPORT" };
        extra.report = loc.report; extra.images = loc.images || {};
      }
      const done = (share) => { if (loc && opts.store) opts.store.set(id, share.code, loc.mtime); return { code: "OK", share: withMtime(view, id, share) }; };
      const { res, code } = await call(a.update === true ? "update" : "publish", view, id, extra);
      if (code === "UNREACH" && a.update !== true) {
        // 等不到回應不等於沒公開(20 張圖的報告 api 要存一陣子):先問一次狀態,已經公開就照成功畫(稽核 P2-8)
        const st = await this.state(view, id);
        if (st.code === "OK" && st.share) return done(st.share);
      }
      if (code !== "OK") {
        const detail = DETAIL_CODES.indexOf(code) >= 0 ? failDetail(res) : "";
        if (detail && view === "local" && opts.logError) { try { opts.logError(id, "share refused (" + res.status + "): " + detail); } catch (_) { /* 寫不了不擋 */ } }
        return detail ? { code, detail } : { code };
      }
      const share = cleanShare(res.body && res.body.share);
      return share ? done(share) : { code: "UNREACH" };
    },
    async revoke(view, id) {
      const { code } = await call("revoke", view, id, {});
      return { code };
    },
  };
}

module.exports = { createShareClient, createShareStore, cleanShare, failCode, failDetail, DISCLAIMER_VERSION, TOS_VERSION, EP };
