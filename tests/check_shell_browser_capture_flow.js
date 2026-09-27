// browser_capture 的流程(shell/browser/capture.js)與它用的純函式,不開 Electron:頁面、view、nativeImage 都是假的。
// 釘住 0.1.8 稽核那幾條:拍前重量外框(B1)、出處網址剝 token(S1)、reports/<id>.files 是 symlink 不寫(S2)、
// 拍完用當下網址重判(S3)、「整個畫面」加面積比(B2)、平行呼叫不超過 10 張(B3)、被遮住不拍(B4)、
// 沒有盒子不回 stale_ref(B5)、叫不醒合成器不拍(B7)。真 Electron 的端到端在 check_shell_browser_capture.js。
// 跑法:node tests/check_shell_browser_capture_flow.js
const path = require("path"), fs = require("fs"), os = require("os");
const B = path.join(__dirname, "..", "shell", "browser");
const policy = require(path.join(B, "policy")), gate = require(path.join(B, "gate"));
const { createCapture, saveCite, CITES_PER_TURN } = require(path.join(B, "capture"));
let red = 0; const t = (n, ok, got) => { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) { red++; if (got !== undefined) console.log("      got: " + JSON.stringify(got).slice(0, 400)); } };

// ── S1:出處網址 ──
for (const [u, want] of [
  ["https://a.com/chart?id=7&token=SECRET&sig=1", "https://a.com/chart?id=7"],
  ["https://a.com/x#access_token=abc&expires_in=3600", "https://a.com/x"],
  ["https://s3.amazonaws.com/b/k.png?X-Amz-Signature=ab&X-Amz-Credential=c&v=2", "https://s3.amazonaws.com/b/k.png?v=2"],
  ["https://a.com/d?api_key=K&apiKey=K2&authToken=T&client_secret=S", "https://a.com/d"],
  ["https://a.com/d?KEY=abc&page=2", "https://a.com/d?page=2"],
  ["https://a.com/stock?code=2330&state=open", "https://a.com/stock?code=2330&state=open"],
  ["https://a.com/doc#section-2", "https://a.com/doc#section-2"],
  ["https://a.com/app#/view?session=zz", "https://a.com/app"],
  ["https://glassnode.com/charts/x?a=1", "https://glassnode.com/charts/x?a=1"],
  ["not a url", "not a url"],
]) { const got = policy.citeUrl(u); t("citeUrl " + u.slice(0, 50) + " → " + want.slice(0, 50), got === want, got); }

// ── B2 / B1 / B4 純函式 ──
const V = { w: 1280, h: 800, px: 0, py: 0 };
for (const [box, want, n] of [
  [{ x: 100, y: 100, w: 600, h: 300 }, null, "一般圖表"], [{ x: 0, y: 50, w: 1280, h: 560 }, null, "滿版寬、高 70%"],
  [{ x: 0, y: 0, w: 1280, h: 679 }, "too_large", "寬 100% × 高 84.9%(舊規則放行)"], [{ x: 0, y: 0, w: 1150, h: 800 }, "too_large", "寬 89.8% × 高 100%(舊規則放行)"],
  [{ x: 20, y: 20, w: 1160, h: 690 }, "too_large", "90%×85%"], [{ x: 10, y: 10, w: 60, h: 300 }, "too_small", "太窄"],
  [{ x: -200, y: 10, w: 400, h: 300 }, "not_visible", "一半在可視區外"],
]) { const got = gate.captureFit(box, V); t("captureFit " + n + " → " + want, got === want, got); }
const at = (x, y, w, h, py) => ({ box: { x, y, w: w || 600, h: h || 300 }, view: { w: 1280, h: 800, px: 0, py: py || 0 } });
t("captureDrift:同一個位置 = 0;頁面捲了但元素在文件裡沒動 = 0", gate.captureDrift(at(10, 100), at(10, 100)) === 0 && gate.captureDrift(at(10, 400, 0, 0, 0), at(10, 100, 0, 0, 300)) === 0);
t("captureDrift:往下推 300 = 300;大小變了也算", gate.captureDrift(at(10, 100), at(10, 400)) === 300 && gate.captureDrift(at(10, 100, 600, 300), at(10, 100, 600, 340)) === 40);
t("captureCovered:中心被遮 / 兩個角被遮 → 擋;一個角、查不出來 → 不擋",
  gate.captureCovered([true, false, false, false, false]) && gate.captureCovered([false, true, true, false, false])
  && !gate.captureCovered([false, true, false, false, false]) && !gate.captureCovered([null, null, null, null, null]) && !gate.captureCovered([]));
{ const p = gate.capturePoints({ x: 100, y: 100, w: 600, h: 300 }); t("capturePoints:中心 + 四角,全部落在框內", p.length === 5 && p[0].x === 400 && p[0].y === 250 && p.every((q) => q.x > 100 && q.x < 700 && q.y > 100 && q.y < 400), p); }

// ── S2:寫檔 ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blave-capflow-"));
const reports = path.join(tmp, "ws", "reports"), outside = path.join(tmp, "outside");
fs.mkdirSync(outside);
{
  saveCite(reports, "r1", "cite-a.png", Buffer.from("x"));
  t("saveCite:一般情況寫進 reports/<id>.files/", fs.readFileSync(path.join(reports, "r1.files", "cite-a.png"), "utf8") === "x");
  let threw = false; try { saveCite(reports, "r1", "cite-a.png", Buffer.from("y")); } catch (_) { threw = true; }
  t("saveCite:不覆蓋既有檔", threw && fs.readFileSync(path.join(reports, "r1.files", "cite-a.png"), "utf8") === "x");
  fs.symlinkSync(outside, path.join(reports, "evil.files"));
  threw = false; try { saveCite(reports, "evil", "cite-b.png", Buffer.from("x")); } catch (_) { threw = true; }
  t("saveCite:<id>.files 是 symlink → 不寫,外面的目錄沒有多檔", threw && fs.readdirSync(outside).length === 0, fs.readdirSync(outside));
  fs.writeFileSync(path.join(reports, "plain.files"), "");
  threw = false; try { saveCite(reports, "plain", "cite-c.png", Buffer.from("x")); } catch (_) { threw = true; }
  t("saveCite:<id>.files 是一般檔 → 不寫", threw);
  fs.mkdirSync(path.join(reports, "r2.files"));
  fs.symlinkSync(path.join(outside, "leak.png"), path.join(reports, "r2.files", "cite-d.png"));
  threw = false; try { saveCite(reports, "r2", "cite-d.png", Buffer.from("x")); } catch (_) { threw = true; }
  t("saveCite:檔名已經是(懸空的)symlink → 不跟過去寫", threw && !fs.existsSync(path.join(outside, "leak.png")));
}

// ── 流程 ──
const J = (r) => JSON.parse(r.content[0].text);
const R = (obj, isError) => ({ content: [{ type: "text", text: JSON.stringify(obj) }], isError: !!isError });
const ERR = (error, message, extra) => R(Object.assign({ ok: false, error, message }, extra || {}), true);
const BOX = at(100, 100);
function rig(over) {
  const x = Object.assign({ url: "https://charts.test/funding?id=7&token=SECRET", urlAfter: null, clips: [BOX], covered: [false, false, false, false, false], alive: true, clipThrows: false, boundsThrow: false, clipped: [], masked: 0, cur: { captures: 0 } }, over || {});
  let shot = false, nclip = 0;
  const v = {
    wc: { getURL: () => (shot && x.urlAfter ? x.urlAfter : x.url), getTitle: () => "Funding weekly" },
    view: { getBounds: () => { if (x.boundsThrow) throw new Error("closing"); return { x: 20000, y: 0, width: 1280, height: 800 }; }, setBounds: () => {} },
    pace: { arrive: () => ({}), end: () => {} },
    page: {
      node: (ref) => (ref === "e1" ? 11 : null),
      callOn: async () => { if (x.alive === "gone") throw new Error("no node"); return x.alive; },
      clipOf: async () => { if (x.clipThrows) throw new Error("no box"); const c = x.clips[Math.min(nclip, x.clips.length - 1)]; nclip++; return c; },
      covered: async () => x.covered,
      captureClip: async (box) => { x.clipped.push(box); shot = true; return Buffer.from("img").toString("base64"); },
      run: async () => "Chart Weekly", extract: async () => ({ meta: {} }),
    },
  };
  const img = { getSize: () => ({ width: 1200, height: 600 }), resize: () => img, toPNG: () => Buffer.from("png-bytes"), toJPEG: () => Buffer.from("jpg") };
  const cap = createCapture({
    nativeImage: { createFromBuffer: () => img }, reportsDir: reports, getWin: () => ({ isDestroyed: () => false, isMinimized: () => false, getContentBounds: () => ({ width: 1200, height: 800 }) }),
    uiLang: () => "zh", reducedMotion: () => true, ERR, R, MSG: { stale_ref: "stale", obscured: "covered" }, blockedMsg: (r) => "blocked " + r, emit: () => {}, viewSize: () => ({ vw: 1280, vh: 800 }),
    withMask: async (_v, fn) => { x.masked++; return fn(); }, noteRead: async () => {}, cur: () => x.cur, expanded: () => null,
  });
  const files = (id) => { try { return fs.readdirSync(path.join(reports, id + ".files")); } catch (_) { return []; } };
  return { x, files, go: (id, ref) => cap.doCapture({ id: 1, alias: "t1", visible: false, snapshotId: "s", readEver: true }, v, { ref: ref || "e1", report: id }) };
}
(async () => {
  { const g = rig(), r = J(await g.go("ok1"));
    t("一般情況:存檔、回 {file, source},遮罩有過", r.ok === true && g.files("ok1").length === 1 && g.files("ok1")[0] === r.file && r.source.name === "Chart Weekly" && g.x.masked === 1 && g.x.cur.captures === 1, r);
    t("S1:source.url 與 source_url 都不帶 token", r.source.url === "https://charts.test/funding?id=7" && r.source_url === r.source.url && !JSON.stringify(r).includes("SECRET"), r); }
  { const moved = at(100, 400), g = rig({ clips: [BOX, moved, moved] }), r = J(await g.go("b1a"));
    t("B1:上遮罩之後外框被往下推 300 → 重量、停住了,用新位置拍", r.ok === true && g.x.clipped.length === 1 && g.x.clipped[0].y === 400, [r, g.x.clipped]); }
  { const g = rig({ clips: [BOX, at(100, 400), at(100, 460)] }), r = J(await g.go("b1b"));
    t("B1:一直在動 → capture_refused / unstable,不拍、不寫檔", r.error === "capture_refused" && r.reason === "unstable" && g.x.clipped.length === 0 && g.files("b1b").length === 0, r); }
  { const g = rig({ clips: [BOX, at(100, 100, 1280, 700)] }), r = J(await g.go("b1c"));
    t("B1:重量之後變成整個畫面大 → too_large,不拍", r.error === "capture_refused" && r.reason === "too_large" && g.x.clipped.length === 0, r); }
  { const g = rig({ urlAfter: "https://charts.test/funding?id=8" }), r = J(await g.go("s3a"));
    t("S3:拍的期間網址換了 → capture_refused / page_changed,圖丟掉", r.error === "capture_refused" && r.reason === "page_changed" && g.files("s3a").length === 0, r); }
  { const g = rig({ url: "https://www.binance.com/en/support/announcement", urlAfter: "https://www.binance.com/en/my/wallet/account/main" }), r = J(await g.go("s3b"));
    t("S3:拍的期間頁面 pushState 進交易所後台 → blocked_policy,圖丟掉", r.error === "blocked_policy" && g.files("s3b").length === 0, r); }
  { const g = rig(), rs = (await Promise.all(Array.from({ length: 12 }, () => g.go("b3")))).map(J);
    t("B3:平行 12 次 → 剛好 " + CITES_PER_TURN + " 張,其餘 rate_limited", rs.filter((r) => r.ok).length === CITES_PER_TURN && rs.filter((r) => r.error === "rate_limited").length === 2 && g.files("b3").length === CITES_PER_TURN, rs.map((r) => r.error || "ok")); }
  { const g = rig({ clips: [at(10, 10, 60, 30)] }); const rs = []; for (let i = 0; i < 12; i++) rs.push(J(await g.go("b3r")));
    t("B3:還沒拍就被拒的(太小)不吃名額", rs.every((r) => r.reason === "too_small") && g.x.cur.captures === 0, g.x.cur); }
  { const g = rig({ covered: [true, true, true, false, false] }), r = J(await g.go("b4"));
    t("B4:圖表上面蓋著別的元素 → obscured,不拍", r.error === "obscured" && g.x.clipped.length === 0 && g.files("b4").length === 0, r); }
  { const g = rig({ clipThrows: true }), r = J(await g.go("b5a"));
    t("B5:節點還在但沒有盒子 → capture_refused / not_visible(不是 stale_ref)", r.error === "capture_refused" && r.reason === "not_visible", r); }
  { const g = rig({ alive: "gone" }), r = J(await g.go("b5b")), r2 = J(await rig({ alive: false }).go("b5c")), r3 = J(await rig().go("b5d", "e9"));
    t("B5:節點不在了 / 沒有這個 ref → stale_ref", r.error === "stale_ref" && r2.error === "stale_ref" && r3.error === "stale_ref", [r, r2, r3]); }
  { const g = rig({ boundsThrow: true }), r = J(await g.go("b7"));
    t("B7:叫不醒合成器(視窗正在關)→ screenshot_failed,不拍", r.error === "screenshot_failed" && g.x.clipped.length === 0 && g.files("b7").length === 0, r); }
  { const r = J(await rig().go("../x")), g = rig(), r2 = J(await g.go("evil"));
    t("壞報告 id → invalid_args;<id>.files 是 symlink → internal、外面沒有多檔", r.error === "invalid_args" && r2.error === "internal" && fs.readdirSync(outside).length === 0, [r, r2]); }
  // index.js 真的走這一支(不是留著舊的那份)
  const idx = fs.readFileSync(path.join(B, "index.js"), "utf8");
  t("index.js 的 browser_capture 接的是 capture.js,自己不再有 captureClip 呼叫", /createCapture\(\{/.test(idx) && /name === "browser_capture"\) return doCapture\(t, v, args\)/.test(idx) && !/captureClip\(/.test(idx));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(red ? `\n${red} FAILED` : "\nALL PASS"); process.exit(red ? 1 : 0);
})();
