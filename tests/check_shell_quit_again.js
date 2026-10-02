// 結束攔截每一次都要攔(e2e 0.1.8 第七批 #7;實測 09-28 10:38、12:30)。
// 自動下單執行中第一次結束跳確認框、按「取消」;之後再結束一次,app 直接結束——沒有框、daemon 沒收工、事件清單沒記。
// 原因不在旗標(取消之後 quitAsking 還原、quitConfirmed 沒設):結束訊號(SIGTERM / SIGINT / SIGHUP)main.js 沒有自己接,
// Chromium 自己的處理只管第一次,收到一次就把訊號還原成系統預設,第二次直接殺掉行程,根本不經過 before-quit。
//   ① 原文鎖:訊號由 main.js 自己接、每一次都走 app.quit();掛在 ready 之後;取消之後兩個旗標的狀態
//   ② 真 Electron(不開任何視窗):before-quit 每次都攔 → 連送三次 SIGTERM,三次都進 before-quit、行程還活著;放行之後才結束。
//      同一支再跑一次「不掛」的對照組:第二次訊號行程就沒了(證明①那一段是必要的)
// 跑法:node tests/check_shell_quit_again.js(② 要 BLAVE_TEST_WINDOW=1;Windows 沒有這幾個訊號,② 不跑)
const path = require("path"), fs = require("fs");
const SHELL = path.join(__dirname, "..", "shell");
const GATE = require("./_electron_gate");
const mainSrc = fs.readFileSync(path.join(SHELL, "main.js"), "utf8");
const cut = (src, head) => { const i = src.indexOf(head); if (i < 0) throw new Error("找不到 " + head); let d = 0; for (let k = src.indexOf("{", src.indexOf(")", i)); k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}" && --d === 0) return src.slice(i, k + 1); } throw new Error("切不出 " + head); };
const WIRE = cut(mainSrc, "function quitOnSignals(");

if (process.versions.electron) {
  // ② 的子行程:沒有視窗。argv 最後一個是 "wired" | "bare"
  const { app } = require("electron");
  const wired = process.argv[process.argv.length - 1] === "wired";
  let asked = 0, allow = false;
  app.on("window-all-closed", () => {});
  app.on("before-quit", (e) => { asked++; process.stdout.write("ASK " + asked + "\n"); if (!allow) e.preventDefault(); });
  process.stdin.on("data", (d) => { if (String(d).includes("allow")) { allow = true; process.stdout.write("ALLOW\n"); } });
  app.whenReady().then(() => {
    if (wired) new Function("proc", "quit", WIRE + "; return quitOnSignals(proc, quit);")(process, () => app.quit());
    process.stdout.write("READY\n");
  });
} else {
  let red = 0; const t = (n, ok, d) => { console.log((ok ? "PASS  " : "FAIL  ") + n + (ok ? "" : "  " + JSON.stringify(d))); if (!ok) red++; };
  // ---- ①
  { const calls = [], proc = { platform: "darwin", on: (s, f) => calls.push([s, f]) }; let quits = 0;
    const sigs = new Function("proc", "quit", WIRE + "; return quitOnSignals(proc, quit);")(proc, () => quits++);
    calls.forEach(([, f]) => { f(); f(); });
    t("三個結束訊號都接、每一次都叫 quit(不是只有第一次)", sigs.join() === "SIGTERM,SIGINT,SIGHUP" && calls.map((c) => c[0]).join() === "SIGTERM,SIGINT,SIGHUP" && quits === 6, [sigs, quits]);
    const win = { platform: "win32", on: () => { throw new Error("不該掛"); } };
    t("Windows 不掛", new Function("proc", "quit", WIRE + "; return quitOnSignals(proc, quit);")(win, () => {}).length === 0); }
  const ready = mainSrc.slice(mainSrc.indexOf("app.whenReady().then(() => {"));
  t("掛在 ready 之後(Chromium 自己的處理是啟動時裝的,後掛的才算數),走的是 app.quit()——也就是 before-quit 那兩道攔截", /\n  quitOnSignals\(process, \(\) => app\.quit\(\)\);/.test(ready) && mainSrc.indexOf("quitOnSignals(process,") > mainSrc.indexOf("app.whenReady().then(() => {"));
  const bq = cut(mainSrc, 'app.on("before-quit", (e) =>');
  const thens = bq.match(/\.then\(\(r\) => \{[^\n]*/g) || [];
  t("按了取消:quitAsking 還原、quitConfirmed 不設(下一次結束照樣會問);對話框自己出錯也還原", thens.length === 2 && thens.every((x) => /^\.then\(\(r\) => \{ quitAsking = false; if \(r\.response === sg\.goIndex\) \{ quitConfirmed = true;/.test(x) && /\}, \(\) => \{ quitAsking = false; \}\);$/.test(x)), thens);
  t("攔截的條件只看「現在」:正在下單(tradeMaybeLive)或回合在跑,沒有「問過一次就不再問」的旗標", /const live = !quitting && !quitConfirmed && tradeMaybeLive\(\);/.test(bq) && /if \(!quitting && !quitConfirmed && \(activeTurn \|\| turnStarting\)\) \{/.test(bq) && !/asked|askedOnce|quitAsked/.test(bq));

  // ---- ②
  const done = () => { console.log(red ? `\n${red} FAILED` : "\nALL PASS"); process.exit(red ? 1 : 0); };
  if (process.platform === "win32") { console.log("SKIP  Windows 沒有 SIGTERM 的同等語意  ②"); done(); }
  const bin = GATE.bin(SHELL, "②");
  if (!bin) done();
  const { spawn } = require("child_process");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function run(mode) {
    const c = spawn(bin, [__filename, mode], { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, ELECTRON_ENABLE_LOGGING: "" } });
    let out = "", exited = null; c.stdout.on("data", (d) => { out += d; }); c.on("exit", (code, sig) => { exited = { code, sig }; });
    const until = async (re, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (re.test(out) || exited) return re.test(out); await sleep(50); } return false; };
    const log = [];
    if (!(await until(/READY/, 20000))) { try { c.kill("SIGKILL"); } catch (_) { /* 已結束 */ } return { mode, log: ["not ready"], out, exited }; }
    for (let i = 1; i <= 3; i++) {
      if (exited) { log.push("dead before signal " + i); break; }
      c.kill("SIGTERM");
      const asked = await until(new RegExp("ASK " + i + "\\n"), 3000);
      await sleep(300);
      log.push((asked ? "asked" : "not-asked") + (exited ? "+dead" : "+alive"));
    }
    if (!exited) { c.stdin.write("allow\n"); await until(/ALLOW/, 3000); c.kill("SIGTERM"); const end = Date.now() + 8000; while (!exited && Date.now() < end) await sleep(50); log.push(exited ? "exit " + exited.code : "still alive"); }
    if (!exited) { try { c.kill("SIGKILL"); } catch (_) { /* 已結束 */ } }
    return { mode, log, asks: (out.match(/ASK \d+/g) || []).length, exited };
  }
  (async () => {
    const w = await run("wired");
    t("② 取消之後再結束:連送三次 SIGTERM,三次都進 before-quit、行程都還活著;放行之後才正常結束", w.log.join() === "asked+alive,asked+alive,asked+alive,exit 0" && w.asks === 4, w);
    const b = await run("bare");
    t("② 對照組(不掛訊號):第一次有攔到,第二次訊號行程直接沒了、沒進 before-quit——就是實測到的 bug", b.log[0] === "asked+alive" && /not-asked\+dead|dead before/.test(b.log[1] || "") && b.asks === 1, b);
    done();
  })().catch((e) => { console.log("FAIL  " + (e && e.stack)); process.exit(1); });
}
