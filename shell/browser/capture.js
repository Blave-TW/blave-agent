// browser_capture(報告引用圖;spec-report-image-cite-0.1.8 §4;references/reports.md › Citing an image from the web)。
// 只拍 agent 指定的那一個元素,出處跟圖檔一起回——source 由工具產生,agent 拆不開也不必自己填。
// 跟截圖同一套:先遮有值的敏感欄位與金流 iframe(遮不到不拍)、藏頁面標記;網域政策由 tabFor 擋在前面,拍完再判一次。
// 不直接 require electron:頁面物件與 nativeImage 都由 index.js 傳進來(tests/check_shell_browser_capture_flow.js 用假的跑整條流程)。
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const policy = require("./policy");
const gate = require("./gate");
const C = require("./content");
const IP = require("./inpage");

const CITE_MAX_W = 1360;              // 680px 閱讀欄 ×2
const CITE_BYTES_MAX = 2 * 1024 * 1024;   // 報告圖檔上限(lib/report.py、main.js RPT_BYTES_MAX)
const CITES_PER_TURN = 10;
const REPORT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SETTLE_MS = 200;
const LOAD_WAIT_MS = 4000, LOAD_POLL_MS = 200;   // 等元素裡的圖載完,最多這麼久
const RETAKE_MS = 800;                           // 拍到空的 / 被切斷的圖:等這麼久重拍一次
const CITE_URL_MSG = {
  scheme: "only https pages can be cited; open the https address of this page and capture again",
  credentials: "the page address carries a user name or password and cannot be cited",
  long: "the page address is longer than 500 characters and cannot be cited; open a shorter address for the same page (without tracking parameters) and capture again",
  format: "the page address contains spaces or control characters and cannot be cited",
};
const CITE_FIT_MSG = {
  too_small: "the element is too small to be a chart; pick the chart or figure element itself",
  too_large: "the element is about as large as the whole view or larger — that is a page screenshot, not a single chart; pick the chart or figure element itself",
  not_visible: "the element cannot be shown whole on screen (it is hidden, sits in a scrolled container or has no box); pick another element",
  unstable: "the page kept moving while the element was being captured, so the picture could be of the wrong area; wait for the page to finish loading (browser_wait), take a new snapshot and capture again",
  page_changed: "the page address changed while the element was being captured; take a new snapshot and capture again",
  incomplete: "the picture came out blank or cut off — the chart had not finished loading or drawing, or something covers part of it; nothing was saved. Wait for the page (browser_wait), take a new snapshot and capture again, or pick another chart",
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 展開在中欄(畫在螢幕上)的分頁,CDP 拍回來的像素是顯示器色彩空間的值:Display P3 的 Mac 上 sRGB 的 #f00 拍成 234/51/35
   (停在視窗外那條路回的是 sRGB,cea5d05 實測)。存出去的圖不帶色彩設定檔,看的人一律當 sRGB,顏色就偏了——存之前轉回 sRGB。
   只認 Chromium 對標準 Display P3 描述檔印出來的那一種(ui/gfx/color_space.cc ToString:原色在 0.001 內對上 P3 就印 P3);
   sRGB 顯示器本來就對;校色過的自訂原色、HDR 認不出來,照原樣存(跟以前一樣) */
const displayIsP3 = (cs) => typeof cs === "string" && /\bprimaries:P3,/.test(cs) && /\btransfer:SRGB,/.test(cs);
// 線性 Display P3(D65)→ 線性 sRGB:兩組原色的 RGB→XYZ 相乘(白點都是 D65,不用色適應)
const P3_TO_SRGB = [1.2249402, -0.2249402, 0, -0.042057, 1.042057, 0, -0.0196376, -0.078636, 1.0982736];
const ENC_STEPS = 16384;
let srgbLut = null;
/** BGRA 點陣(nativeImage.toBitmap 的排法)原地從 Display P3 轉成 sRGB;alpha 不動。 */
function p3ToSrgb(bm) {
  if (!srgbLut) {
    const dec = new Float64Array(256), enc = new Uint8Array(ENC_STEPS + 1);
    for (let v = 0; v < 256; v++) { const c = v / 255; dec[v] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
    for (let k = 0; k <= ENC_STEPS; k++) { const l = k / ENC_STEPS; enc[k] = Math.round(255 * (l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055)); }
    srgbLut = { dec, enc };
  }
  const { dec, enc } = srgbLut, m = P3_TO_SRGB;
  const out = (l) => enc[Math.round((l <= 0 ? 0 : l >= 1 ? 1 : l) * ENC_STEPS)];
  for (let i = 0; i + 3 < bm.length; i += 4) {
    const b = dec[bm[i]], g = dec[bm[i + 1]], r = dec[bm[i + 2]];
    bm[i + 2] = out(m[0] * r + m[1] * g + m[2] * b);
    bm[i + 1] = out(m[3] * r + m[4] * g + m[5] * b);
    bm[i] = out(m[6] * r + m[7] * g + m[8] * b);
  }
  return bm;
}

/* 報告不覆寫:這個 id 已經有報告時,圖是給「下一份」的——放進下一個空 id(<id>-2、-3…)的資料夾,已有報告的資料夾不進新圖。
   跟 lib/report.py 的 _serial / _free_id 是同一條規則(tests/check_report_no_overwrite.py 逐例對照),改一邊就要改另一邊。 */
const AUTO_SUFFIX = "-auto", ID_MAX = 64;
function citeSerial(report, n) {
  if (n < 2) return report;
  const tail = report.endsWith(AUTO_SUFFIX) && report.length > AUTO_SUFFIX.length ? AUTO_SUFFIX : "";
  const suffix = "-" + n + tail;
  return report.slice(0, report.length - tail.length).slice(0, ID_MAX - suffix.length) + suffix;
}
function citeSlot(reportsDir, report) {
  const taken = (id) => fs.existsSync(path.join(reportsDir, id + ".json")) || fs.existsSync(path.join(reportsDir, "sent", id + ".json"));
  let n = 1;
  while (taken(citeSerial(report, n))) n++;
  return citeSerial(report, n);
}

/* 稽核 S2:reports/<id>.files 若是 symlink,沒有沙箱的主行程會替沙箱裡的 agent 把檔寫到 workspace 外。
   目錄必須是 reportsDir 底下的真目錄;檔案不跟隨 symlink、不覆蓋既有檔。寫不了就丟錯。 */
function saveCite(reportsDir, report, file, buf) {
  fs.mkdirSync(reportsDir, { recursive: true });
  const slot = citeSlot(reportsDir, report), dir = path.join(reportsDir, slot + ".files");
  try { fs.mkdirSync(dir); } catch (e) { if (e.code !== "EEXIST") throw e; }
  if (!fs.lstatSync(dir).isDirectory()) throw new Error("report folder is not a plain directory");
  if (fs.realpathSync(dir) !== path.join(fs.realpathSync(reportsDir), slot + ".files")) throw new Error("report folder is outside reports/");
  const K = fs.constants;
  const fd = fs.openSync(path.join(dir, file), K.O_CREAT | K.O_EXCL | K.O_WRONLY | (K.O_NOFOLLOW || 0), 0o644);
  try { fs.writeSync(fd, buf); } finally { fs.closeSync(fd); }
  return dir;
}
/* 回合結束:這一輪擷取了、卻沒有任何報告收下的圖清掉(實機:agent 先用一個 id 擷取,後來改用另一個 id 發佈,第一個資料夾成了孤兒)。
   只動這一輪自己寫的那幾個檔(cites = doCapture 記下的 { dir, file }),而且那個資料夾的 id 現在仍然沒有報告——有報告的資料夾
   一個字都不碰(寫報告時 lib/report.py 已經清過沒引用的)。資料夾空了才收。回清掉的檔數 */
function sweepCites(reportsDir, cites) {
  let n = 0;
  if (!reportsDir || !Array.isArray(cites)) return n;
  let root; try { root = fs.realpathSync(reportsDir); } catch (_) { return n; }
  const has = (id) => fs.existsSync(path.join(reportsDir, id + ".json")) || fs.existsSync(path.join(reportsDir, "sent", id + ".json"));
  for (const c of cites) {
    const dir = c && typeof c.dir === "string" ? c.dir : "", file = c && typeof c.file === "string" ? c.file : "", id = path.basename(dir).slice(0, -".files".length);
    if (!/^cite-[A-Za-z0-9.-]{1,70}$/.test(file) || !dir.endsWith(".files") || !REPORT_ID_RE.test(id) || has(id)) continue;
    try {
      if (!fs.lstatSync(dir).isDirectory() || fs.realpathSync(dir) !== path.join(root, id + ".files")) continue;
      if (fs.lstatSync(path.join(dir, file)).isFile()) { fs.unlinkSync(path.join(dir, file)); n++; }
    } catch (_) { /* 已經被報告收走(lib 搬到實際 id 的資料夾)或不在了 */ }
    try { fs.rmdirSync(dir); } catch (_) { /* 還有別的檔:留著 */ }
  }
  return n;
}

/**
 * d: { nativeImage, reportsDir, getWin(), uiLang(), reducedMotion(), colorSpace() → 視窗所在顯示器的色彩空間字串(Electron display.colorSpace),
 *      ERR, R, MSG, emit, viewSize(v), withMask(v, fn, force),
 *      noteRead(t, v, ex), recheck(t, v) → 這一頁現在還能不能交給 agent(不能 = 被擋的那個回應;可以 = null),
 *      cur() → 這一輪的狀態物件, expanded() → 展開中的 tab id }
 */
function createCapture(d) {
  const { ERR, R } = d;
  /* 停在視窗外的分頁閒置幾秒後合成器就不再出畫面:Page.captureScreenshot 等到逾時,或回捲動前的舊畫面(實測 Electron 44,
     視窗顯示中、置頂、關掉遮擋判定都一樣)——舊畫面會變成一張錯的引用圖。view 只要有 1×1 px 疊進視窗內容區就會出畫面
     (視窗隱藏也行),所以擷取那一下把它的左上角貼到視窗右下角那一個像素,拍完放回原位。展開在中欄的分頁本來就在視窗裡。
     叫不醒(視窗正在關)就不拍:沒醒的合成器給的是舊畫面(稽核 B7)。 */
  async function awake(t, v, fn) {
    if (t.id === d.expanded()) return fn();
    let b0 = null, nb = null;
    try { b0 = v.view.getBounds(); const cb = d.getWin().getContentBounds(); nb = { x: cb.width - 1, y: cb.height - 1, width: b0.width, height: b0.height }; v.view.setBounds(nb); await sleep(150); }
    catch (_) { return { asleep: true }; }
    try { return await fn(); } finally {
      // 這段期間用戶把它展開到中欄(bounds 已經被 expand 換掉)就不放回去
      try { const cb2 = v.view.getBounds(); if (cb2.x === nb.x && cb2.y === nb.y) v.view.setBounds(b0); } catch (_) { /* 已關 */ }
    }
  }
  /* 稽核 B1:外框在叫醒合成器、上遮罩之後重量(lazy 圖、sticky header 都在這時才動),連兩次量到同一個位置才拍。
     回 { c } 或 { refuse: CITE_FIT_MSG 的 key }。 */
  async function settled(v, b, first) {
    let prev = first;
    for (let i = 0; i < 2; i++) {
      if (i) await sleep(SETTLE_MS);
      let c; try { c = await v.page.clipOf(b); } catch (_) { return { refuse: "not_visible" }; }
      if (c.error) return { refuse: "not_visible" };
      const fit = gate.captureFit(c.box, c.view);
      if (fit) return { refuse: fit };
      if (gate.captureDrift(prev, c) <= gate.CAPTURE_DRIFT_MAX) return { c };
      prev = c;
    }
    return { refuse: "unstable" };
  }
  /* 元素裡的圖載完了沒(e2e 0.1.8:loading="lazy" 的圖捲進畫面才開始抓,外框不動所以 settled() 看不出來,拍到上半張)。
     回 "ready" | "waited"(等過,外框要重量)| "loading"(等不到)。查不出來不擋——事後還有 captureBlank 那一道 */
  async function pictures(v, b) {
    const until = Date.now() + LOAD_WAIT_MS;
    for (let waited = false; ; waited = true) {
      let n; try { n = await v.page.callOn(b, IP.pendingPictures); } catch (_) { return waited ? "waited" : "ready"; }
      if (!(typeof n === "number" && n > 0)) return waited ? "waited" : "ready";
      if (Date.now() >= until) return "loading";
      await sleep(LOAD_POLL_MS);
    }
  }
  // 拍到的那張是不是空的 / 被切斷(gate.captureBlank)。讀不出像素就當作沒問題,不因為檢查本身壞掉而拒拍
  function blank(img) {
    try { const s = img.getSize(); return typeof img.toBitmap === "function" ? gate.captureBlank(img.toBitmap(), s.width, s.height) : null; } catch (_) { return null; }
  }
  async function doCapture(t, v, args) {
    const report = String(args.report || "");
    if (!REPORT_ID_RE.test(report)) return ERR("invalid_args", "report must be the id of the report the picture is for ([A-Za-z0-9_-]{1,64}), the same id you pass to write_report");
    if (!d.reportsDir) return ERR("invalid_args", "reports are not available here");
    const url0 = v.wc.getURL();
    const url = policy.citeUrl(url0);   // 稽核 S1:token 類參數不進報告(報告會被公開分享)
    const bad = policy.citable(url);
    if (bad) return ERR("capture_refused", CITE_URL_MSG[bad], { tab: t.alias, reason: "page_url" });
    // 縮到 Dock 時 awake() 也叫不醒合成器,CDP 擷取只會等到逾時(實測)——直接說,不讓 agent 空等 8 秒
    const w = d.getWin && d.getWin();
    if (!w || w.isDestroyed() || w.isMinimized()) return ERR("screenshot_failed", "the app window is minimized, so the page cannot be captured; ask the user to bring the Blave window back, then capture again", { tab: t.alias });
    const cur = d.cur();
    // 檢查與遞增之間不能有 await:平行送來的呼叫各自都會看到「還沒滿」(稽核 B3)。還沒拍就被拒的退回去
    if ((cur.captures || 0) >= CITES_PER_TURN) return ERR("rate_limited", "capture limit for this turn reached", { retry_in_s: 0 });
    cur.captures = (cur.captures || 0) + 1;
    const refund = (r) => { cur.captures = Math.max(0, cur.captures - 1); return r; };
    const b = v.page.node(args.ref);
    if (b === null) return refund(ERR("stale_ref", d.MSG.stale_ref, { tab: t.alias }));
    // 節點不在了才是過期的 ref;還在但沒有盒子(display:none)重新 snapshot 也是同一個 ref,回 stale_ref 只會讓 agent 繞圈(稽核 B5)
    let alive = false; try { alive = await v.page.callOn(b, function () { return !!this.isConnected; }); } catch (_) { /* 節點已回收 */ }
    if (!alive) return refund(ERR("stale_ref", d.MSG.stale_ref, { tab: t.alias }));
    const refuse = (reason) => ERR("capture_refused", CITE_FIT_MSG[reason], { tab: t.alias, ref: args.ref, reason });
    let c; try { c = await v.page.clipOf(b); } catch (_) { return refund(refuse("not_visible")); }
    const fit = c.error ? "not_visible" : gate.captureFit(c.box, c.view);
    if (fit) return refund(refuse(fit));
    const reduced = d.reducedMotion ? d.reducedMotion() : false;
    d.emit("page_act", Object.assign({ id: t.id, kind: "capture", ref: String(args.ref), box: c.box }, d.viewSize(v)));
    const pace = v.pace.arrive();
    if (pace.cut) await v.page.run(IP.mark, ["settle"]).catch(() => {});
    if (t.visible) await v.page.run(IP.mark, ["ref", { box: c.box, label: d.uiLang() === "zh" ? "擷取" : "Capture", tag: true }, reduced]).catch(() => {});
    const moved = () => { const e = d.recheck(t, v); return e ? { denied: e } : v.wc.getURL() !== url0 ? { refuse: "page_changed" } : null; };
    const shoot = () => awake(t, v, async () => {
      const g = await d.withMask(v, async () => {
        let s = await settled(v, b, c);
        if (s.refuse) return { refuse: s.refuse };
        const p = await pictures(v, b);
        if (p === "loading") return { refuse: "incomplete" };
        if (p === "waited") { await sleep(SETTLE_MS); s = await settled(v, b, s.c); if (s.refuse) return { refuse: s.refuse }; }   // 載完到畫出來差一拍;沒寫尺寸的圖載完會把版面推開
        if (gate.captureCovered(await v.page.covered(b, gate.capturePoints(s.c.box)))) return { covered: true };
        // 稽核 P1-1:等外框停住、等圖載完可以花上幾秒;拍之前用當下的狀態重判(換到 agent 不能去的網址、驗證頁、用戶接手)
        const denied = moved(); if (denied) return denied;
        return { c: s.c, d: await v.page.captureClip(s.c.box, s.c.view, Math.min(2, CITE_MAX_W / s.c.box.w)) };
      }, true);
      // 拍完、存快照之前再判一次:不通過的那一頁不進快照、不進來源清單
      const denied = g && g.d ? moved() : null; if (denied) return denied;
      // 出處頁照「讀了」記(來源紀錄與快照就是用戶查證這張圖的地方);快照也要醒著的合成器,所以放在同一段裡
      if (g && g.d && (!t.snapshotId || !t.readEver)) { try { await d.noteRead(t, v, await v.page.extract()); } catch (_) { /* 快照 best-effort */ } }
      return g;
    });
    let got, img = null, onScreen = false;   // onScreen:這一次是展開在中欄拍的(awake 的同一個判斷)
    try {
      onScreen = t.id === d.expanded();
      got = await shoot();
      if (got && got.d) img = d.nativeImage.createFromBuffer(Buffer.from(got.d, "base64"));
      /* 壞圖不進報告:拍到空的 / 下半一大片平色的圖,等一下重拍一次(canvas 圖表資料晚到、合成器那一格還沒畫);
         還是一樣就拒絕,讓 agent 換一張。重拍走同一條路(重量外框、等圖載完、查遮擋) */
      if (img && blank(img)) {
        await sleep(RETAKE_MS);
        onScreen = t.id === d.expanded();
        got = await shoot(); img = null;
        if (got && got.d) { img = d.nativeImage.createFromBuffer(Buffer.from(got.d, "base64")); if (blank(img)) got = { refuse: "incomplete" }; }
      }
    } finally {
      await v.page.run(IP.mark, ["unframe"]).catch(() => {});
      v.pace.end();
    }
    if (!got) return ERR("sensitive_field", "a password / card / code field on this page has a value that could not be hidden, so nothing was captured", { tab: t.alias });
    if (got.denied) return got.denied;
    if (got.asleep) return ERR("screenshot_failed", "the app window is closing, so the page cannot be captured", { tab: t.alias });
    if (got.refuse) return refuse(got.refuse);
    if (got.covered) return ERR("obscured", d.MSG.obscured, { tab: t.alias, ref: args.ref });
    if (!got.d || !img) return ERR("screenshot_failed", "could not capture this element right now; try again", { tab: t.alias });
    // 稽核 S3:進門時判過的是當時的網址;拍的這段時間頁面自己換了網址(pushState 進後台路徑),圖與出處就對不上
    const now = v.wc.getURL(), a = policy.agent(now);
    if (a) return ERR("blocked_policy", d.blockedMsg(a.reason), { tab: t.alias, reason: a.reason, host: a.host });
    if (now !== url0) return refuse("page_changed");
    const late = d.recheck(t, v); if (late) return late;
    c = got.c;
    if (onScreen && displayIsP3(d.colorSpace ? d.colorSpace() : null)) {
      try { const s0 = img.getSize(); img = d.nativeImage.createFromBitmap(p3ToSrgb(img.toBitmap()), { width: s0.width, height: s0.height }); }
      catch (_) { /* 轉不了:照原樣存(跟以前一樣),不為了顏色擋掉這張圖 */ }
    }
    const want = Math.min(CITE_MAX_W, Math.round(c.box.w * 2));   // 約 2×(螢幕 DPR 也乘進 CDP 的輸出,這裡收回來)
    if (img.getSize().width > want) img = img.resize({ width: want, quality: "best" });
    let buf = img.toPNG(), ext = "png";
    for (const q of [90, 75]) { if (buf.length <= CITE_BYTES_MAX) break; buf = img.toJPEG(q); ext = "jpg"; }
    if (!buf.length) return ERR("screenshot_failed", "could not capture this element right now; try again", { tab: t.alias });
    if (buf.length > CITE_BYTES_MAX) return ERR("capture_refused", "the picture is over 2 MB even as JPEG; pick a smaller chart element", { tab: t.alias, ref: args.ref, reason: "too_large" });
    const file = "cite-" + Date.now().toString(36) + "-" + crypto.randomBytes(3).toString("hex") + "." + ext;
    try { (cur.cites || (cur.cites = [])).push({ dir: saveCite(d.reportsDir, report, file, buf), file }); }   // 記下來:回合結束時沒被報告收下的要清(sweepCites)
    catch (_) { return ERR("internal", "could not save the picture into the report folder"); }
    const host = new URL(url).hostname;
    let site = ""; try { site = await v.page.run(function () { const m = document.querySelector('meta[property="og:site_name"], meta[name="application-name"]'); return m ? String(m.getAttribute("content") || "").slice(0, 200) : ""; }); } catch (_) { /* 用網域 */ }
    site = C.scrub(site).replace(/\s+/g, " ").trim();
    // 名稱 ≤40(契約 image.source.name);站名太長就用網域,不截半個名字
    const name = site && [...site].length <= 40 ? site : [...host.replace(/^www\./, "")].slice(0, 40).join("");
    const s = img.getSize();
    return R({ ok: true, tab: t.alias, report, file, source: { name, url }, host, width: s.width, height: s.height, bytes: buf.length, source_url: C.scrub(url, 2000), title: C.scrub(v.wc.getTitle(), 300) });
  }
  return { doCapture };
}

module.exports = { createCapture, saveCite, citeSlot, sweepCites, CITES_PER_TURN, CITE_FIT_MSG, p3ToSrgb, displayIsP3 };
