// shell/wsfile.js 與它的呼叫點:主行程寫 workspace 裡的檔時,不能被 agent 預先放好的 symlink 帶到 workspace 外(稽核 2026-10-02 P2-1／N1)。
// 做法同稽核的 PoC:在暫存 workspace 裡把會被寫的那個名字先做成指向外面的 symlink,再跑真的 code,看外面有沒有多出檔案。
// 一律用暫存目錄,不碰 repo 與 ~/Blave。跑法:node tests/check_shell_wsfile.js
const fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto"), vm = require("vm");
const W = require("../shell/wsfile");
const SHELL = path.join(__dirname, "..", "shell");
let red = 0; const t = (n, ok, why) => { console.log((ok ? "PASS  " : "FAIL  ") + n + (ok || !why ? "" : "\n      " + why)); if (!ok) red++; };
const POSIX = process.platform !== "win32";
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "blave-wsfile-"));
let n = 0;
const fresh = () => { const d = path.join(ROOT, "c" + ++n), ws = path.join(d, "ws"), out = path.join(d, "outside"); fs.mkdirSync(ws, { recursive: true }); fs.mkdirSync(out); return { ws, out }; };
const outsideFiles = (out) => fs.readdirSync(out);
const leftovers = (dir, base) => fs.readdirSync(dir).filter((f) => f.startsWith("." + base + "."));
// 暫存檔名是隨機的:測「隨機名剛好被搶先佔走」時把 randomBytes 釘死,才放得了 symlink 在那個名字上
const realRB = crypto.randomBytes;
const pinRandom = () => { crypto.randomBytes = (k) => Buffer.alloc(k, 0xab); return "ab".repeat(6); };
const unpin = () => { crypto.randomBytes = realRB; };

// ---- replace ----
if (POSIX) {
  { const { ws, out } = fresh(), f = path.join(ws, ".env"), hex = pinRandom();
    fs.symlinkSync(path.join(out, "planted.txt"), path.join(ws, `..env.${hex}`));
    let code = null; try { W.replace(f, "AGENT_CONTROLLED\n"); } catch (e) { code = e.code; } finally { unpin(); }
    t("replace:暫存檔名上已經有 symlink → 不寫(EEXIST),外面沒有多出檔案,.env 沒被建出來", code === "EEXIST" && outsideFiles(out).length === 0 && !fs.existsSync(f), JSON.stringify([code, outsideFiles(out)])); }
  { const { ws, out } = fresh(), f = path.join(ws, ".env"), victim = path.join(out, "victim.txt");
    fs.writeFileSync(victim, "ORIGINAL\n"); fs.symlinkSync(victim, f);
    W.replace(f, "NEW\n");
    t("replace:目標本身是 symlink → 換掉的是目錄項,外面那個檔一個字沒動,.env 變成一般檔", fs.readFileSync(victim, "utf8") === "ORIGINAL\n" && !fs.lstatSync(f).isSymbolicLink() && fs.readFileSync(f, "utf8") === "NEW\n"); }
  { const { ws } = fresh(), f = path.join(ws, ".env"), old = process.umask(0o277);
    try { W.replace(f, "U=1\n"); } finally { process.umask(old); }
    t("replace:umask 把 owner 位元也扣掉(0o277)時照樣是 0600", (fs.statSync(f).mode & 0o777) === 0o600); }
  { const { ws } = fresh(), f = path.join(ws, ".env");
    W.replace(f, "A=1\n"); fs.chmodSync(f, 0o644); W.replace(f, "A=2\n");
    t("replace:權限 0600(既有檔也收成 0600)、內容是新的、不留暫存檔", (fs.statSync(f).mode & 0o777) === 0o600 && fs.readFileSync(f, "utf8") === "A=2\n" && leftovers(ws, ".env").length === 0); }
}
{ const { ws } = fresh(), f = path.join(ws, ".env");
  fs.mkdirSync(f);
  let threw = false; try { W.replace(f, "SECRET\n"); } catch (_) { threw = true; }
  t("replace:rename 失敗(目標是目錄)→ 往上拋,而且不留暫存檔(裡面是明文金鑰)", threw && leftovers(ws, ".env").length === 0, JSON.stringify(fs.readdirSync(ws))); }

// ---- append ----
if (POSIX) {
  { const { ws, out } = fresh(), f = path.join(ws, "log");
    fs.symlinkSync(path.join(out, "planted.txt"), f);
    let threw = false; try { W.append(f, "x\n"); } catch (_) { threw = true; }
    t("append:檔名是指向外面(還不存在)的 symlink → 拋錯,外面沒有多出檔案", threw && outsideFiles(out).length === 0); }
  { const { ws, out } = fresh(), f = path.join(ws, "log"), victim = path.join(out, "victim.txt");
    fs.writeFileSync(victim, "ORIGINAL\n"); fs.symlinkSync(victim, f);
    let threw = false; try { W.append(f, "x\n"); } catch (_) { threw = true; }
    t("append:檔名是指向外面既有檔的 symlink → 拋錯,外面那個檔沒被接上東西", threw && fs.readFileSync(victim, "utf8") === "ORIGINAL\n"); }
  { const { ws } = fresh(), f = path.join(ws, "log");
    W.append(f, "a\n"); W.append(f, "b\n");
    t("append:一般檔照接,新建的是 0600", fs.readFileSync(f, "utf8") === "a\nb\n" && (fs.statSync(f).mode & 0o777) === 0o600); }
}

// ---- 呼叫點:跑真的 code ----
const mainSrc = fs.readFileSync(path.join(SHELL, "main.js"), "utf8");
const cutFn = (src, name) => { const i = src.indexOf("function " + name + "("); let d = 0, end = -1;
  for (let k = src.indexOf("{", i); k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}" && --d === 0) { end = k + 1; break; } } return src.slice(i, end); };

// syncDataEnv(每一輪 runTurn 都可能寫 .env):舊的固定暫存名與新的隨機名都先種好 symlink
if (POSIX) {
  const { ws, out } = fresh(), hex = pinRandom();
  for (const nm of [".env.blave-tmp", `..env.${hex}`]) fs.symlinkSync(path.join(out, nm + "-planted"), path.join(ws, nm));
  fs.writeFileSync(path.join(ws, ".env"), "AGENT=controlled\n");
  const a = mainSrc.indexOf("const ENV_BEGIN"), b = mainSrc.indexOf("function syncDataEnv("), c = cutFn(mainSrc, "syncDataEnv");
  const ctx = { fs, path, wsfile: W, WS: ws, loadDataKey: () => ({ api_key: "k".repeat(64), secret_key: "s".repeat(64) }) };
  let r = null;
  try { vm.runInNewContext(mainSrc.slice(a, b) + c + "\nthis.f = syncDataEnv;", ctx); r = ctx.f(true); } finally { unpin(); }
  t("main.js syncDataEnv:暫存檔名上有 symlink → 外面沒有多出檔案(含明文 key 的內容寫不出去)", outsideFiles(out).length === 0, JSON.stringify([r, outsideFiles(out)]));
  t("main.js syncDataEnv:.env 仍是一般檔、原內容沒被蓋掉", !fs.lstatSync(path.join(ws, ".env")).isSymbolicLink() && fs.readFileSync(path.join(ws, ".env"), "utf8") === "AGENT=controlled\n");
  // 沒有人搶的時候照常寫進去
  fs.unlinkSync(path.join(ws, `..env.${hex}`));
  t("main.js syncDataEnv:正常情況照樣寫進 .env", ctx.f(true) === "ours" && /blave_api_key=k{64}/.test(fs.readFileSync(path.join(ws, ".env"), "utf8")) && outsideFiles(out).length === 0);
}

// datasrc.js(設定 › 資料來源 存金鑰)
(async () => {
  if (POSIX) {
    const D = require("../shell/datasrc.js");
    const { ws, out } = fresh(), envf = path.join(ws, ".env"), hex = pinRandom();
    for (const nm of [".env.blave-src-tmp", `..env.${hex}`]) fs.symlinkSync(path.join(out, nm + "-planted"), path.join(ws, nm));
    fs.writeFileSync(envf, "BINANCE_API_KEY=real\n");
    const ds = D.createDataSrc({ envFile: envf, lock: () => Promise.resolve(() => {}), strategies: () => [], trading: () => ({ live: false, amounts: {} }), now: () => 1790000000 });
    let r1 = null; try { r1 = await ds.save({ name: "FRED", isNew: true, fields: [{ name: "KEY", value: "v" }] }); } finally { unpin(); }
    t("datasrc.js 存金鑰:暫存檔名上有 symlink → 存失敗、外面沒有多出檔案、.env 原樣", r1 && r1.ok === false && outsideFiles(out).length === 0 && fs.readFileSync(envf, "utf8") === "BINANCE_API_KEY=real\n", JSON.stringify([r1, outsideFiles(out)]));
    fs.unlinkSync(path.join(ws, `..env.${hex}`));
    const r2 = await ds.save({ name: "FRED", isNew: true, fields: [{ name: "KEY", value: "v" }] });
    t("datasrc.js 存金鑰:正常情況照樣寫進 .env", r2.ok === true && /DATA_FRED_KEY='v'/.test(fs.readFileSync(envf, "utf8")) && !fs.lstatSync(envf).isSymbolicLink());
  }

  // main.js rptLogError(reports/upload_errors.log:接一行;超過 64KB 整檔改寫)
  if (POSIX) {
    const mk = (ws) => { const L = { fs, path, wsfile: W, WS: ws };
      vm.runInNewContext("const RPT_DIR = () => path.join(WS, 'reports');\n" + /const RPT_ERRLOG_MAX = [^\n]*/.exec(mainSrc)[0] + "\n" + cutFn(mainSrc, "rptLogError") + "\nthis.f = rptLogError;", L); return L.f; };
    { const { ws, out } = fresh(), log = mk(ws);
      fs.mkdirSync(path.join(ws, "reports")); fs.symlinkSync(path.join(out, "planted.txt"), path.join(ws, "reports", "upload_errors.log"));
      let threw = false; try { log("r1", "agent says hi"); } catch (_) { threw = true; }
      t("rptLogError:upload_errors.log 是指向外面的 symlink → 拋錯(呼叫端 try 住),外面沒有多出檔案", threw && outsideFiles(out).length === 0); }
    { const { ws, out } = fresh(), log = mk(ws), dir = path.join(ws, "reports"), f = path.join(dir, "upload_errors.log");
      fs.mkdirSync(dir); fs.writeFileSync(f, Array.from({ length: 900 }, (_, i) => "2026-10-03T00:00:00Z old-" + i + ": " + "y".repeat(80)).join("\n") + "\n");
      const hex = pinRandom(); fs.symlinkSync(path.join(out, "planted.txt"), path.join(dir, `.upload_errors.log.${hex}`));
      let threw = false; try { log("r1", "trim me"); } catch (_) { threw = true; } finally { unpin(); }
      t("rptLogError 超過 64KB 改寫:暫存檔名上有 symlink → 拋錯,外面沒有多出檔案(檔尾是 agent 寫得到的內容)", threw && outsideFiles(out).length === 0);
      fs.unlinkSync(path.join(dir, `.upload_errors.log.${hex}`));
      log("r1", "trim me");
      t("rptLogError 超過 64KB 改寫:正常情況照樣縮回去、是一般檔", fs.statSync(f).size < 64 * 1024 && !fs.lstatSync(f).isSymbolicLink() && fs.readFileSync(f, "utf8").trimEnd().endsWith("r1: trim me")); }
  }

  // 接線:這幾處都走 wsfile(daemon.js 的兩處 append 要真的跑起常駐程式才走得到,這裡用原文釘住)
  const dsSrc = fs.readFileSync(path.join(SHELL, "datasrc.js"), "utf8"), dmSrc = fs.readFileSync(path.join(SHELL, "daemon.js"), "utf8");
  t("接線:syncDataEnv 用 wsfile.replace,沒有固定的 .blave-tmp", (() => { const s = cutFn(mainSrc, "syncDataEnv"); return /else wsfile\.replace\(envFile, next\);/.test(s) && !/blave-tmp|writeFileSync|renameSync/.test(s); })());
  t("接線:datasrc.js 的 write 用 wsfile.replace,沒有固定的 .blave-src-tmp", /wsfile\.replace\(opts\.envFile, next\)/.test(dsSrc) && !/blave-src-tmp/.test(dsSrc));
  t("接線:rptLogError 只用 wsfile.append / wsfile.replace 寫", (() => { const s = cutFn(mainSrc, "rptLogError"); return /wsfile\.append\(f,/.test(s) && /wsfile\.replace\(f,/.test(s) && !/fs\.(appendFileSync|writeFileSync)/.test(s); })());
  t("接線:daemon.js 的 equity_history / ui_events 走 wsfile.append,檔裡沒有 appendFileSync", /wsfile\.append\(eqFile,/.test(dmSrc) && /wsfile\.append\(uiFile,/.test(dmSrc) && !/appendFileSync/.test(dmSrc));
  t("打包:wsfile.js 在 electron-builder 的 files 裡", /files:\s*\[[^\]]*"wsfile\.js"/.test(fs.readFileSync(path.join(SHELL, "electron-builder.config.js"), "utf8")));

  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0);
})();
