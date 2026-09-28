// 操作中畫面閃爍(Wei 0.1.7 實測 TradingView):讀到就存的快照走 captureBeyondViewport,
// 它會暫時改 viewport → 整頁 reflow;agent 打字點擊的回合裡高頻觸發就是閃爍。
// 修法:操作中(saveSnapshot)只拍當下視口(不動 viewport);回合結束(endTurn)才把
// 還開著的頁升級成整頁版(snaps.updateImage,一輪一次)。
// 跑法:node tests/check_shell_browser_snapshot_flicker.js
const fs = require("fs");
const path = require("path");
const os = require("os");
const SHELL = path.join(__dirname, "..", "shell");
const src = fs.readFileSync(path.join(SHELL, "browser", "index.js"), "utf8");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };

// ---- 來源接線:誰拍視口版、誰拍整頁版
ok("saveSnapshot(操作中)拍視口版:captureSnapshotImage 不帶 full", /const image = await withMask\(v, \(\) => captureSnapshotImage\(v\)\);/.test(src));
const cap = (src.match(/async function captureSnapshotImage\(v, full\) \{[\s\S]*?\n  \}/) || [""])[0];
const head = cap.split("captureBeyondViewport: true")[0];   // 以真參數切,不吃註解裡的字
ok("captureSnapshotImage:!full 那條提早 return、碰不到 captureBeyondViewport(不動 viewport)", /if \(!full\) \{/.test(head) && /return \{ data: Buffer\.from\(shot\.data, "base64"\), ext: "webp" \};/.test(head) && cap.includes("captureBeyondViewport: true"));
ok("endTurn 把還開著的頁升級成整頁版並寫回(一輪一次)", /captureSnapshotImage\(v, true\)/.test(src) && /snaps\.updateImage\(c\.sessionId, r\.snapshot_id, image\)/.test(src));
ok("升級照樣走 withMask,而且帶 force(仍展開的頁也藏標記,快照不烤進游標;稽核 A-P2-2)",
  /await withMask\(v, \(\) => captureSnapshotImage\(v, true\), true\)/.test(src) && /async function withMask\(v, fn, force\)/.test(src)
  && /return await withoutMarks\(v, fn, force\);/.test(src));
// 縮圖(2 秒一輪)從來就不做 emulation override:clip 縮放,不碰 viewport。
// setDeviceMetricsOverride 全檔只允許出現在 parkEmulate(常駐一次的 park 排版,見 park_layout 測試),
// 任何「每次擷取都切 override」的寫法回來就抓
const thumbFn = (src.match(/async function captureThumb\(id\) \{[\s\S]*?\n  \}/) || [""])[0];
ok("縮圖路徑沒有 beyond-viewport / metrics override", thumbFn.length > 0 && !/captureBeyondViewport|DeviceMetricsOverride/.test(thumbFn));
// 第七批 #6 多一處:wideEmulate(「送進 TradingView」在窄的中欄時,頁面暫時用寬版面排版)——一樣是切一次、不是每次擷取都切
ok("setDeviceMetricsOverride 只在 parkEmulate 與 wideEmulate(不在任何擷取路徑)", src.split("setDeviceMetricsOverride").length === 3
  && /function parkEmulate\(v\) \{[\s\S]{0,600}setDeviceMetricsOverride/.test(src) && /function wideEmulate\(v\) \{[\s\S]{0,600}setDeviceMetricsOverride/.test(src)
  && !/DeviceMetricsOverride/.test((src.match(/async function captureSnapshotImage\(v, full\) \{[\s\S]*?\n  \}/) || ["DeviceMetricsOverride"])[0]));

// ---- snaps.updateImage 行為:換圖、meta 跟上、壞參數拒收
const snaps = require(path.join(SHELL, "browser", "snapshots.js")).createSnapshots(fs.mkdtempSync(path.join(os.tmpdir(), "blave-upimg-")), {});
const sid = "desktop-flick1";
const id = snaps.save(sid, { url: "https://x.test/a", title: "A", markdown: "m", image: { data: Buffer.from("small"), ext: "webp" }, turn: 1 });
ok("save 出一份視口版", !!id && snaps.load(sid, id).image.length > 0);
const before = snaps.load(sid, id).image;
ok("updateImage 換成整頁版(內容真的變了)", snaps.updateImage(sid, id, { data: Buffer.from("FULL-PAGE-IMAGE"), ext: "webp" }) === true && snaps.load(sid, id).image !== before && snaps.load(sid, id).image.includes(Buffer.from("FULL-PAGE-IMAGE").toString("base64")));
ok("markdown / meta 不受影響", snaps.load(sid, id).markdown === "m" && snaps.load(sid, id).title === "A");
ok("壞參數拒收:沒圖 / 壞副檔名 / 壞 id", snaps.updateImage(sid, id, null) === false && snaps.updateImage(sid, id, { data: Buffer.from("x"), ext: "svg" }) === false && snaps.updateImage(sid, "nope", { data: Buffer.from("x"), ext: "webp" }) === false);

// ---- 展開在中欄的那頁:擷取不藏標記(藏了又放=即時頁肉眼可見的閃;量測 8 秒 18 次 → 0)
{
  const cut = (src.match(/async function withoutMarks\(v, fn, force\) \{[\s\S]*?\n  \}/) || [""])[0];
  const runWM = (isLive) => {
    const calls = [];
    const env = { wcTab: { get: () => (isLive ? "T1" : "T2") }, expanded: "T1", IP: { marksVisible: "MV" } };
    const fn = new Function(...Object.keys(env), "return (" + cut.replace(/^async function withoutMarks/, "async function") + ")")(...Object.values(env));
    const v = { wc: { id: 9 }, page: { run: (w, a) => { calls.push(a ? a[0] : w); return Promise.resolve(); } } };
    return fn(v, async () => calls.push("CAP")).then(() => calls);
  };
  const runWMF = (isLive) => {
    const calls = [];
    const env = { wcTab: { get: () => (isLive ? "T1" : "T2") }, expanded: "T1", IP: { marksVisible: "MV" } };
    const fn = new Function(...Object.keys(env), "return (" + cut.replace(/^async function withoutMarks/, "async function") + ")")(...Object.values(env));
    const v = { wc: { id: 9 }, page: { run: (w, a) => { calls.push(a ? a[0] : w); return Promise.resolve(); } } };
    return fn(v, async () => calls.push("CAP"), true).then(() => calls);
  };
  Promise.all([runWM(true), runWM(false), runWMF(true)]).then(([live, parked, forced]) => {
    ok("展開在看的那頁:直接拍,不藏/放標記層(不閃)", live.join(",") === "CAP", live);
    ok("parked 的頁照舊:藏 → 拍 → 放(縮圖乾淨)", parked.join(",") === "false,CAP,true", parked);
    ok("force(回合結束升級):展開的頁也照藏(快照乾淨;一次性,無閃爍顧慮)", forced.join(",") === "false,CAP,true", forced);
    console.log(red ? "\n" + red + " FAILED" : "\nALL PASS");
    process.exit(red ? 1 : 0);
  });
}

