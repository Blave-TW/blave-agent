// 策略頁「進出場紀錄」往左補(0.1.28,對齊網頁 execWatchEarlier / execMergeChunks)。跑法:node tests/check_shell_trades_backfill.js
//   ① 純函式:manifest 清洗、挑塊(由近到遠、批次上限、根數夠就停、分線上限)、左緣判定、合併(只接更早的、排序去重、指標線對齊、成交去重)、
//      起點部位語意、箭頭收起門檻
//   ② 主行程 loadChart:只認列得出來的策略資料夾、塊號範圍、chart/ 與檔案不跟 symlink、manifest hash 與 sha1 對不上 → STALE
//   ③ 雲端 chart():名字與塊號的閘門、manifest 404 = 沒有分塊;postJSON 要 gzip 時自己解
const fs = require("fs"), path = require("path"), os = require("os"), vm = require("vm"), crypto = require("crypto"), zlib = require("zlib");
const { PassThrough } = require("stream");
const SHELL = path.join(__dirname, "..", "shell"), R = path.join(SHELL, "renderer");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + String(d).slice(0, 1500))); if (!c) red++; };
const J = JSON.stringify;
function fnSrc(src, name) {
  let a = src.indexOf("function " + name + "("); if (a < 0) throw new Error("找不到 " + name);
  let i = src.indexOf("{", a), depth = 0;
  if (src.slice(a - 6, a) === "async ") a -= 6;
  for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}" && --depth === 0) break; }
  return src.slice(a, i + 1);
}

(async () => {
  // ── ① 純函式 ──
  const sb = { window: {} }; vm.createContext(sb); vm.runInContext(fs.readFileSync(path.join(R, "report-trades.js"), "utf8"), sb);
  const TP = sb.window.BlaveReport._tradesPure;

  const man = TP.sanitizeManifest({ hash: "h", truncated: true, chunks: [{ id: 0, t0: 0, t1: 9, bars: 10 }, { id: -1, t0: 0, t1: 1 }, { id: 1.5, t0: 0, t1: 1 }, { id: 2, t0: "x", t1: 1 }, null, { id: 1, t0: 10, t1: 19 }] });
  ok("① manifest:壞塊丟掉、bars 缺當 0、truncated 只認 true", J(man) === J({ hash: "h", chunks: [{ id: 0, t0: 0, t1: 9, bars: 10 }, { id: 1, t0: 10, t1: 19, bars: 0 }], truncated: true }), J(man));
  ok("① manifest:一塊都不剩 / 不是物件 → null", TP.sanitizeManifest({ chunks: [{ id: "a" }] }) === null && TP.sanitizeManifest(null) === null && TP.sanitizeManifest({ chunks: {} }) === null);

  const M10 = { hash: "h", truncated: false, chunks: Array.from({ length: 10 }, (_, i) => ({ id: i, t0: i * 100, t1: i * 100 + 99, bars: 100 })) };
  const ids = (a) => a.map((c) => c.id).join();
  ok("① 挑塊:只挑含最早已載那根之前資料的塊(t0 < 第一根),由近到遠;根數夠就停", ids(TP.nextChunks(M10, new Set(), 850, 150, 0, false)) === "8,7", ids(TP.nextChunks(M10, new Set(), 850, 150, 0, false)));
  ok("① 挑塊:一次最多 6 塊;已載過的跳過", ids(TP.nextChunks(M10, new Set([8]), 950, 1e9, 0, false)) === "9,7,6,5,4,3");
  ok("① 挑塊:分線補到 50 萬根就停(第一塊無條件)", ids(TP.nextChunks({ chunks: [{ id: 0, t0: 0, t1: 1, bars: 20000 }, { id: 1, t0: 2, t1: 3, bars: 20000 }] }, new Set(), 100, 1e9, 499000, true)) === "1"
    && ids(TP.nextChunks({ chunks: [{ id: 0, t0: 0, t1: 1, bars: 20000 }, { id: 1, t0: 2, t1: 3, bars: 20000 }] }, new Set(), 100, 1e9, 499000, false)) === "1,0");
  ok("① 挑塊:都載過 / 都不早於第一根 → 空(= 到頭)", TP.nextChunks(M10, new Set([0, 1, 2]), 250, 1e9, 0, false).length === 0 && TP.nextChunks(M10, new Set(), 0, 1e9, 0, false).length === 0);
  ok("① 左緣:可視左緣離最早已載那根 ≤ 200 根才補", TP.nearLeftEdge(300, 100) && !TP.nearLeftEdge(301, 100) && TP.nearLeftEdge(-2, 0));

  const row = (t) => [t, 1, 2, 0.5, 1.5, 1];
  const panes = [{ name: "MA", pane: "", overlay: true, points: [{ time: 100, value: 1 }, { time: 101, value: 1 }] }, { name: "RSI", pane: "", overlay: false, points: [{ time: 98, value: 1 }, { time: 101, value: 1 }] }];
  const datas = [
    { candles: [row(50), row(52), row(100), row(101)], panes: [{ name: "MA", points: [[50, 2], [99, 2], [100, 9]] }, { name: "RSI", points: [[97, 3], [98, 9]] }, { name: "OTHER", points: [[1, 1], [2, 2]] }],
      trades: [{ ts: 52, price: 1, delta: 1, direction: "buy", position: 1 }, { ts: 52, price: 1, delta: -1, direction: "sell", position: 0 }, { ts: 100, price: 1, delta: 1, direction: "buy", position: 1 }] },
    { candles: [row(51), row(50), "x", row(49)], panes: [], trades: [{ ts: 49, price: 0, delta: 1, direction: "buy" }] },
  ];
  const mo = TP.mergeOlder(100, panes, new Set([100]), datas);
  ok("① 合併 K 線:只接第一根(100)之前的、跨塊排序去重、壞列丟", mo.older.map((c) => c.time).join() === "49,50,51,52", J(mo.older));
  ok("① 合併指標線:依名字對齊、只取那條線首點之前的;對不上的線略過", mo.paneOlder.map((p) => p.map((x) => x.time).join("|")).join(",") === "50|99,97", J(mo.paneOlder));
  ok("① 合併成交:已知的 ts 不收,同一批同一個 ts 的兩筆都留,壞的丟", mo.trades.map((x) => x.ts + x.direction).join() === "52buy,52sell", J(mo.trades));

  const tail = [{ ts: 200 }], st0 = { value: 3, known: true };
  ok("① 起點部位:沒補到更早成交 → 照 stats 的 trades_start_position", TP.mergedTrades(tail, st0, [], true).start === st0);
  ok("① 起點部位:補到且載到最早一塊 → 從 0 起算;還沒到頭 → 未知;成交依時間排", J(TP.mergedTrades(tail, st0, [{ ts: 5 }], true)) === J({ trades: [{ ts: 5 }, { ts: 200 }], start: { value: 0, known: true } })
    && TP.mergedTrades(tail, st0, [{ ts: 5 }], false).start.known === false);
  ok("① 箭頭:可見箭頭平均間距 < 4px 收、≥ 6px 才再出,4–6 之間維持原狀;沒有可見箭頭 = 照畫",
    !TP.marksShown(true, 399, 100) && TP.marksShown(true, 400, 100) && TP.marksShown(true, 500, 100) && !TP.marksShown(false, 500, 100)
    && !TP.marksShown(false, 599, 100) && TP.marksShown(false, 600, 100) && TP.marksShown(false, 1000, 0) && TP.marksShown(true, 1000, 0));
  { const mk = [1, 2, 2, 5, 9].map((time) => ({ time }));
    ok("① 可見箭頭數:落在 [t0, t1](含兩端、同一根多筆都算)", TP.countMarkersIn(mk, 2, 5) === 3 && TP.countMarkersIn(mk, 0, 100) === 5 && TP.countMarkersIn(mk, 3, 4) === 0 && TP.countMarkersIn(mk, 9, 9) === 1 && TP.countMarkersIn(mk, 6, 2) === 0 && TP.countMarkersIn([], 0, 9) === 0); }
  ok("① 分線上限字:n 從 SUB5_MAX_BARS 帶,zh「50 萬」、en「500K」", TP.SUB5_MAX_BARS === 500000 && TP.fmtBarCap(TP.SUB5_MAX_BARS, "zh-Hant") === "50 萬" && TP.fmtBarCap(TP.SUB5_MAX_BARS, "en") === "500K");
  { const trJs = fs.readFileSync(path.join(R, "report-trades.js"), "utf8"), strs = fs.readFileSync(path.join(R, "strings.js"), "utf8");
    ok("① historyCapped 帶 {n}(兩語)、狀態字有 role=status、exhaust 與沒有來源時關 fixLeftEdge",
      /"tr\.historyCapped": "Loads up to \{n\} minute bars"/.test(strs) && /"tr\.historyCapped": "分線最多載入 \{n\} 根"/.test(strs)
      && /t\("tr\.historyCapped", \{ n: fmtBarCap\(SUB5_MAX_BARS,/.test(trJs) && /moreEl\.setAttribute\("role", "status"\)/.test(trJs)
      && /function exhaust\(\) \{\s*E\.done = true;\s*releaseLeftEdge\(\);/.test(trJs) && /if \(!src\) releaseLeftEdge\(\);/.test(trJs)); }
  ok("① interval 秒數:5m = 300、1min = 60、認不得 = null", TP.intervalSec("5m") === 300 && TP.intervalSec("1min") === 60 && TP.intervalSec("1H") === 3600 && TP.intervalSec("abc") === null);

  // ── ② 主行程 loadChart ──
  const mainSrc = fs.readFileSync(path.join(SHELL, "main.js"), "utf8");
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "chart-"));
  const SD = path.join(ws, "strategies");
  const mk = (name) => { const d = path.join(SD, name); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, "strategy.py"), "x = 1\n"); return d; };
  const writeChart = (dir, bodies, hash) => {
    const cd = path.join(dir, "chart"); fs.mkdirSync(cd, { recursive: true });
    const chunks = bodies.map((b, id) => { const raw = Buffer.from(J(b)); fs.writeFileSync(path.join(cd, `chunk-${id}.json`), raw); return { id, t0: id, t1: id, bars: 1, sha1: crypto.createHash("sha1").update(raw).digest("hex") }; });
    fs.writeFileSync(path.join(cd, "manifest.json"), J({ v: 1, hash, chunks }));
  };
  const momo = mk("momo"); writeChart(momo, [{ candles: [[1, 1, 1, 1, 1, 1]] }, { candles: [[2, 1, 1, 1, 1, 1]] }], "H1");
  mk("bare");
  const outside = mk("outside"); writeChart(outside, [{ secret: 1 }], "HX");
  const linked = mk("linked"); fs.symlinkSync(path.join(outside, "chart"), path.join(linked, "chart"));
  const flink = mk("flink"); writeChart(flink, [{ candles: [] }], "HF");
  fs.unlinkSync(path.join(flink, "chart", "chunk-0.json")); fs.symlinkSync(path.join(outside, "chart", "chunk-0.json"), path.join(flink, "chart", "chunk-0.json"));
  const env = {
    fs, path, crypto,
    STRAT_DIR: () => SD,
    stratNames: () => fs.readdirSync(SD, { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(path.join(SD, d.name, "strategy.py"))).map((d) => d.name),
  };
  const consts = /const CHART_MAX_CHUNKS = [^\n]*\n/.exec(mainSrc)[0] + /const CHART_MANIFEST_MAX = [^\n]*\n/.exec(mainSrc)[0];
  const L = new Function(...Object.keys(env), consts + fnSrc(mainSrc, "readChartFile") + "\n" + fnSrc(mainSrc, "loadChart") + "\nreturn loadChart;")(...Object.values(env));
  const m = await L("momo", "manifest");
  ok("② manifest:讀得到", m.code === "OK" && m.manifest.hash === "H1" && m.manifest.chunks.length === 2, J(m));
  const c1 = await L("momo", "chunk", 1, "H1");
  ok("② chunk:塊號 + 手上的 hash 對得上 → 那一塊", c1.code === "OK" && c1.data.candles[0][0] === 2, J(c1));
  ok("② 沒有 chart/ → OK + manifest null(畫面不往左補)", J(await L("bare", "manifest")) === J({ code: "OK", manifest: null }));
  const bad = await Promise.all(["../outside", "momo/../outside", "momo/chart", "/etc", "", "nope", "..", "momo\u0000"].map((n) => L(n, "chunk", 0, "H1")));
  ok("② 路徑穿越:不是列得出來的策略資料夾一律 ERROR", bad.every((r) => r.code === "ERROR"), J(bad));
  const badCid = await Promise.all([-1, 50, "0", 1.5, null, undefined, 1e9].map((c) => L("momo", "chunk", c, "H1")));
  ok("② 塊號只收 0..49 的整數", badCid.every((r) => r.code === "ERROR"), J(badCid));
  ok("② part 只收 manifest / chunk", (await L("momo", "../../x")).code === "ERROR");
  ok("② chart/ 是 symlink(指到別的策略)→ 當沒有", J(await L("linked", "manifest")) === J({ code: "OK", manifest: null }) && (await L("linked", "chunk", 0, "HX")).code === "ERROR");
  ok("② 塊檔是 symlink → 不跟", (await L("flink", "chunk", 0, "HF")).code === "ERROR");
  ok("② 手上 manifest 的 hash 跟現在的不同(回測重跑換了整包)→ STALE", (await L("momo", "chunk", 0, "OLD")).code === "STALE" && (await L("momo", "chunk", 0)).code === "STALE");
  fs.writeFileSync(path.join(momo, "chart", "chunk-0.json"), J({ candles: [[9, 1, 1, 1, 1, 1]] }));
  ok("② 塊的 sha1 跟 manifest 記的不同(讀到換到一半)→ STALE", (await L("momo", "chunk", 0, "H1")).code === "STALE");
  ok("② IPC 有接、preload 有開", /handle\("load-chart", \(_e, q\) => loadChart\(/.test(mainSrc) && /handle\("cloud-chart", \(_e, q\) => cloudHost\(\)\.chart\(q\)/.test(mainSrc)
    && /loadChart: \(q\) => ipcRenderer\.invoke\("load-chart"/.test(fs.readFileSync(path.join(SHELL, "preload.js"), "utf8")));
  fs.rmSync(ws, { recursive: true, force: true });

  // ── ③ 雲端 ──
  const cloud = require(path.join(SHELL, "cloud.js"));
  const sent = [];
  let reply = { status: 200, body: { hash: "h", chunks: [] } };
  const host = cloud.createCloudHost({ apiBase: "https://x", getCreds: () => ({ token: "t", appSecret: "s", who: "w" }), post: async (u, b) => { sent.push([u, b]); return reply; } });
  const r1 = await host.chart({ name: "momo", part: "manifest" });
  ok("③ manifest:打 /cloud/chart_data、body 帶 name + part", r1.code === "OK" && r1.manifest.hash === "h" && sent[0][0] === "https://x/oauth/desktop/cloud/chart_data" && sent[0][1].part === "manifest" && sent[0][1].name === "momo", J(sent));
  reply = { status: 404, body: { error: "no chart data" } };
  ok("③ manifest 404 = 沒有分塊 → OK + null;chunk 404 → UNREACH", J(await host.chart({ name: "momo", part: "manifest" })) === J({ code: "OK", manifest: null }) && (await host.chart({ name: "momo", part: "chunk", cid: 0 })).code === "UNREACH");
  reply = { status: 200, body: { candles: [] } };
  const r3 = await host.chart({ name: "momo", part: "chunk", cid: 3 });
  ok("③ chunk:cid 原樣送", r3.code === "OK" && sent[sent.length - 1][1].cid === 3);
  const n0 = sent.length;
  const rej = await Promise.all([{ name: "../x", part: "manifest" }, { name: "momo", part: "chunk", cid: 50 }, { name: "momo", part: "chunk", cid: "1" }, { name: "momo", part: "overview" }, null].map((q) => host.chart(q)));
  ok("③ 名字 / 塊號 / part 不對 → UNREACH、不打 api", rej.every((r) => r.code === "UNREACH") && sent.length === n0);

  // postJSON 要 gzip:帶 Accept-Encoding、回應是 gzip 就解;沒要的照舊
  const postSrc = fnSrc(mainSrc, "postJSON");
  const fakeReq = (gz, payload) => {
    const seen = {};
    const https = { request: (url, o, cb) => { seen.headers = o.headers; seen.timeout = o.timeout; const req = new PassThrough(); req.end = () => {
      const res = new PassThrough(); res.statusCode = 200; res.headers = gz ? { "content-encoding": "gzip" } : {};
      cb(res); res.end(gz ? zlib.gzipSync(Buffer.from(payload)) : Buffer.from(payload)); }; return req; } };
    const post = new Function("require", postSrc + "\nreturn postJSON;")((m) => (m === "https" ? https : require(m)));
    return { post, seen };
  };
  const big = J({ candles: Array.from({ length: 20000 }, (_, i) => [i, 1, 2, 0.5, 1.5, 1]), note: "中文跨塊" });
  { const f = fakeReq(true, big); const r = await f.post("https://x/y", {}, { gzip: true, timeout: 60000 });
    ok("③ postJSON gzip:帶 Accept-Encoding、解開、timeout 照給", r.status === 200 && r.body.candles.length === 20000 && r.body.note === "中文跨塊" && f.seen.headers["Accept-Encoding"] === "gzip" && f.seen.timeout === 60000); }
  { const f = fakeReq(false, big); const r = await f.post("https://x/y", {});
    ok("③ postJSON 沒要 gzip:不帶 Accept-Encoding、照舊解 JSON(多位元組字跨塊不壞)", r.body.note === "中文跨塊" && !("Accept-Encoding" in f.seen.headers)); }
  ok("③ 雲端宿主只有 chart_data 那支要 gzip", /u\.endsWith\(require\("\.\/cloud"\)\.CHART_ENDPOINT\) \? \{ gzip: true/.test(mainSrc));

  // app.js:兩個視角都把來源交給 renderTrades
  const app = fs.readFileSync(path.join(R, "app.js"), "utf8");
  ok("④ 接線:renderTrades 帶 rpChartSource(B);雲端那袋走 cloudChart、這台電腦走 loadChart(帶 hash)", /R\.renderTrades\(\$\("rp-tr"\), B\.data\.stats, \{ chart: rpChartSource\(B\) \}\)/.test(app)
    && /cloud = B === RPC/.test(fnSrc(app, "rpChartSource")) && /loadChart\(\{ name, part: "chunk", cid, hash \}\)/.test(fnSrc(app, "rpChartSource")));

  console.log(red ? `\n${red} FAIL` : "\nALL PASS");
  process.exit(red ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
