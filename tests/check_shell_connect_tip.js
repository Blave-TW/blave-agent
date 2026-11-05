// 設定 › 連結兩列開關(0.1.46 熱修,Wei 在 0.1.45 測試軌實測):
//   A. 「在手機 App 上查看這台電腦的部位」的 tooltip 看不到。根因:.mv .sw-l 沒有 position: relative,泡泡的定位基準一路找到
//      .set-modal(transform 會成為定位基準),bottom: 100% 把它畫到框外、再被 .set-modal 的 overflow: hidden 整顆裁掉。
//      補了 relative 之後,頁頂第一列往上只剩 .set-content 的 16 內距,泡泡仍會被捲動框裁掉,所以第一列改往下長。
//   B. 點開關的名稱會切換開關(label[for]):手機查看關掉會刪伺服器上的資料,誤觸就刪。兩列的 label 都不掛 for,
//      開關的名稱照舊由 aria-labelledby 指到 label 裡那個 span。
//   ① 原文:mvBlock / phBlock 不設 htmlFor、aria-labelledby 仍在;CSS 兩條規則在
//   ② 真的排版(隨包的 Electron、offscreen 不顯示的視窗):手機查看開／關、手機查看不出(手機對話變第一列) × zh／en,
//      每顆泡泡強制顯示後都在 .set-content 裡;label 沒有 control、開關沒有 labels,點字開關收不到 click
// 跑法:node tests/check_shell_connect_tip.js(沒設 BLAVE_TEST_WINDOW=1 時 ② SKIP)
const fs = require("fs"), path = require("path"), os = require("os");
const SHELL = path.join(__dirname, "..", "shell"), R = path.join(SHELL, "renderer");
const GATE = require("./_electron_gate");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + String(d).slice(0, 3000))); if (!c) red++; };
const read = (f) => fs.readFileSync(f, "utf8");

if (!process.versions.electron) {
  const src = read(path.join(R, "app.js")), css = read(path.join(R, "app.css"));
  const fnSrc = (name) => { const i = src.indexOf("function " + name + "("); if (i < 0) throw new Error("找不到 " + name); return src.slice(i, src.indexOf("\n}", i) + 2); };
  for (const [fn, id] of [["mvBlock", "mv"], ["phBlock", "ph"]]) {
    ok(`① ${fn}:label 不掛 for(點字不切開關)`, !/htmlFor/.test(fnSrc(fn)), fnSrc(fn).split("\n")[2]);
    ok(`① ${fn}:開關名稱仍由 aria-labelledby 指到 ${id}-l、說明指到 ${id}-tip`, fnSrc(fn).includes(`sw.setAttribute("aria-labelledby", "${id}-l"); sw.setAttribute("aria-describedby", "${id}-tip");`));
  }
  ok("① CSS:手機查看的 label 是泡泡的定位基準(.mv .sw-l relative)", /(^|\n)[^{\n]*\.mv \.sw-l[^{\n]*\{ position: relative; \}/.test(css));
  ok("① CSS:連結頁第一列的泡泡往下長", css.includes("#set-connect > :first-child .sw-l > .tip { bottom: auto; top: calc(100% + 6px); }"));
  const bin = GATE.bin(SHELL, "②");
  if (!bin) { console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0); }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blave-conntip-"));
  const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit", env: { ...process.env, BLAVE_TEST_USERDATA: tmp } });
  fs.rmSync(tmp, { recursive: true, force: true }); ok("跑完暫存目錄不存在", !fs.existsSync(tmp), tmp);
  const sub = r.status == null ? 1 : r.status;
  console.log(red || sub ? `\n${red + sub} 紅` : "\nALL PASS");
  process.exit(red || sub ? 1 : 0);
}

const { app, BrowserWindow } = require("electron");
app.setPath("userData", process.env.BLAVE_TEST_USERDATA || fs.mkdtempSync(path.join(os.tmpdir(), "blave-conntip-")));
const STUB = `window.blave = new Proxy({}, { get: (_, k) => typeof k !== "string" ? undefined
  : k.startsWith("on") ? () => {} : k === "tradeLabels" ? () => {}
  : async () => ({ getLocale: "zh-TW", loadConnection: { kind: "claude" }, detectAgents: { claude: { installed: true, loggedIn: true }, codex: { installed: false } },
      listStrategies: [], listSessions: [], loadSession: [], loadSessionImages: [], updateState: { phase: "idle", current: "0.0.0" } })[k] });`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log("FAIL  ② 逾時(120 秒)"); process.exit(1); }, 120000).unref();
const SYNC = { running: false, done: 0, total: 0, error: false, synced: true };
const CASES = [
  ["手機查看開著", { visible: true, signedIn: true, on: true, name: "Mac" }],
  ["手機查看關著", { visible: true, signedIn: true, on: false }],
  ["手機查看不出(手機對話是第一列)", { visible: false }],
];
const PAINT = (mv) => `(() => { MV = ${JSON.stringify(mv)}; PH = { visible: true, signedIn: true, on: false, pending: false, sync: ${JSON.stringify(SYNC)} };
  const sc = $("set-scrim"); sc.hidden = false; sc.classList.add("open");
  $("set-modal").querySelectorAll(".set-pane").forEach((p) => { p.hidden = p.id !== "set-connect"; });
  connectPaint();
  const c = document.querySelector(".set-content").getBoundingClientRect(), out = [];
  document.querySelectorAll("#set-connect .tip").forEach((tip) => { tip.style.display = "block"; const r = tip.getBoundingClientRect(); tip.style.display = "";
    out.push({ id: tip.id, top: Math.round(r.top), bottom: Math.round(r.bottom), cTop: Math.round(c.top), cBottom: Math.round(c.bottom),
      inside: r.height > 0 && r.top >= c.top - 0.5 && r.bottom <= c.bottom + 0.5 && r.left >= c.left - 0.5 && r.right <= c.right + 0.5 }); });
  const labels = [];
  document.querySelectorAll("#set-connect .sw-row").forEach((row) => { const sw = row.querySelector(".sw"), lbl = row.querySelector("label"); if (!sw || !lbl) return;
    let hits = 0; const h = () => { hits++; }; sw.addEventListener("click", h, true); lbl.click(); lbl.querySelector(".set-tipl").click(); sw.removeEventListener("click", h, true);
    const name = sw.getAttribute("aria-labelledby");
    labels.push({ id: sw.id, control: lbl.control ? lbl.control.id : null, swLabels: sw.labels.length, hits, named: !!document.getElementById(name) && lbl.contains(document.getElementById(name)) }); });
  return { tips: out, labels }; })()`;

app.whenReady().then(async () => {
  const pre = path.join(app.getPath("userData"), "stub.js"); fs.writeFileSync(pre, STUB);
  const w = new BrowserWindow({ width: 1280, height: 820, show: false, webPreferences: { offscreen: true, preload: pre, contextIsolation: false, sandbox: false } });
  await w.loadFile(path.join(SHELL, "renderer", "index.html"));
  await wait(1000);
  const js = (s) => w.webContents.executeJavaScript(s, true);
  for (const lang of ["zh", "en"]) {
    await js(`setLang("${lang}")`);
    for (const [name, mv] of CASES) {
      const res = await js(PAINT(mv));
      const want = mv.visible ? 2 : 1;
      ok(`② ${lang} ${name}:${res.tips.length} 顆泡泡都在 .set-content 裡(${res.tips.map((x) => x.id + " " + x.top + "–" + x.bottom).join(",")};框 ${res.tips[0] && res.tips[0].cTop}–${res.tips[0] && res.tips[0].cBottom})`,
        res.tips.length === want && res.tips.every((x) => x.inside), JSON.stringify(res.tips));
      ok(`② ${lang} ${name}:label 沒有 control、開關沒有 labels,點名稱開關收不到 click;名稱 span 在 label 裡`,
        res.labels.length === want && res.labels.every((x) => x.control === null && x.swLabels === 0 && x.hits === 0 && x.named), JSON.stringify(res.labels));
    }
  }
  process.exit(red ? 1 : 0);
});
