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
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 稽核 S2:reports/<id>.files 若是 symlink,沒有沙箱的主行程會替沙箱裡的 agent 把檔寫到 workspace 外。
   目錄必須是 reportsDir 底下的真目錄;檔案不跟隨 symlink、不覆蓋既有檔。寫不了就丟錯。 */
function saveCite(reportsDir, report, file, buf) {
  fs.mkdirSync(reportsDir, { recursive: true });
  const dir = path.join(reportsDir, report + ".files");
  try { fs.mkdirSync(dir); } catch (e) { if (e.code !== "EEXIST") throw e; }
  if (!fs.lstatSync(dir).isDirectory()) throw new Error("report folder is not a plain directory");
  if (fs.realpathSync(dir) !== path.join(fs.realpathSync(reportsDir), report + ".files")) throw new Error("report folder is outside reports/");
  const K = fs.constants;
  const fd = fs.openSync(path.join(dir, file), K.O_CREAT | K.O_EXCL | K.O_WRONLY | (K.O_NOFOLLOW || 0), 0o644);
  try { fs.writeSync(fd, buf); } finally { fs.closeSync(fd); }
}

/**
 * d: { nativeImage, reportsDir, getWin(), uiLang(), reducedMotion(), ERR, R, MSG, emit, viewSize(v), withMask(v, fn, force),
 *      noteRead(t, v, ex), cur() → 這一輪的狀態物件, expanded() → 展開中的 tab id }
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
    let got;
    try {
      got = await awake(t, v, async () => {
        const g = await d.withMask(v, async () => {
          const s = await settled(v, b, c);
          if (s.refuse) return { refuse: s.refuse };
          if (gate.captureCovered(await v.page.covered(b, gate.capturePoints(s.c.box)))) return { covered: true };
          return { c: s.c, d: await v.page.captureClip(s.c.box, s.c.view, Math.min(2, CITE_MAX_W / s.c.box.w)) };
        }, true);
        // 出處頁照「讀了」記(來源紀錄與快照就是用戶查證這張圖的地方);快照也要醒著的合成器,所以放在同一段裡
        if (g && g.d && (!t.snapshotId || !t.readEver)) { try { await d.noteRead(t, v, await v.page.extract()); } catch (_) { /* 快照 best-effort */ } }
        return g;
      });
    } finally {
      await v.page.run(IP.mark, ["unframe"]).catch(() => {});
      v.pace.end();
    }
    if (!got) return ERR("sensitive_field", "a password / card / code field on this page has a value that could not be hidden, so nothing was captured", { tab: t.alias });
    if (got.asleep) return ERR("screenshot_failed", "the app window is closing, so the page cannot be captured", { tab: t.alias });
    if (got.refuse) return refuse(got.refuse);
    if (got.covered) return ERR("obscured", d.MSG.obscured, { tab: t.alias, ref: args.ref });
    if (!got.d) return ERR("screenshot_failed", "could not capture this element right now; try again", { tab: t.alias });
    // 稽核 S3:進門時判過的是當時的網址;拍的這段時間頁面自己換了網址(pushState 進後台路徑),圖與出處就對不上
    const now = v.wc.getURL(), a = policy.agent(now);
    if (a) return ERR("blocked_policy", d.blockedMsg(a.reason), { tab: t.alias, reason: a.reason, host: a.host });
    if (now !== url0) return refuse("page_changed");
    c = got.c;
    let img = d.nativeImage.createFromBuffer(Buffer.from(got.d, "base64"));
    const want = Math.min(CITE_MAX_W, Math.round(c.box.w * 2));   // 約 2×(螢幕 DPR 也乘進 CDP 的輸出,這裡收回來)
    if (img.getSize().width > want) img = img.resize({ width: want, quality: "best" });
    let buf = img.toPNG(), ext = "png";
    for (const q of [90, 75]) { if (buf.length <= CITE_BYTES_MAX) break; buf = img.toJPEG(q); ext = "jpg"; }
    if (!buf.length) return ERR("screenshot_failed", "could not capture this element right now; try again", { tab: t.alias });
    if (buf.length > CITE_BYTES_MAX) return ERR("capture_refused", "the picture is over 2 MB even as JPEG; pick a smaller chart element", { tab: t.alias, ref: args.ref, reason: "too_large" });
    const file = "cite-" + Date.now().toString(36) + "-" + crypto.randomBytes(3).toString("hex") + "." + ext;
    try { saveCite(d.reportsDir, report, file, buf); }
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

module.exports = { createCapture, saveCite, CITES_PER_TURN, CITE_FIT_MSG };
