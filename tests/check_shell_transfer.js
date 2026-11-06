// shell/transfer.js(送上雲端／拉回這台電腦的主行程那一半)+ cloudcmd／daemon／main.js 的接線。
// 重點:① 讀檔規則同 runtime collect_export(symlink 不跟、檔名不合規整個拒、上限)② 金鑰值只照名字取、不送交易所形狀、
// 沒有就不帶 secrets ③ 拉回的檔兩份 sha256 都對才寫暫存,daemon 拿到的只有暫存代號與雜湊 ④ renderer 送不了 strategy_import。
// 最後對真的 runtime/local_daemon.py 送一次暫存匯入(Type B 會下單 → 不試跑,不起任何回測)。
// 跑法:node tests/check_shell_transfer.js(需要 python3;不碰 ~/Blave)
const fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto");
const T = require("../shell/transfer.js"), ds = require("../shell/datasrc.js");
const { createDaemonHost, UI_COMMANDS, MAIN_ONLY_COMMANDS, argsOk } = require("../shell/daemon.js");
const { createCloudCmd } = require("../shell/cloudcmd.js");
const ROOT = path.join(__dirname, "..");
let red = 0;
const t = (name, ok, why) => { console.log((ok ? "PASS  " : "FAIL  ") + name + (ok || why === undefined ? "" : "  → " + JSON.stringify(why))); if (!ok) red++; };
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "blave-xf-")), WS = path.join(BASE, "workspace");
const SD = path.join(WS, "strategies");
const mkStrat = (name, files) => { const d = path.join(SD, name); fs.mkdirSync(d, { recursive: true }); for (const [f, v] of Object.entries(files)) fs.writeFileSync(path.join(d, f), v); return d; };

(async () => {
  // ── ① collectLocal ──
  const d = mkStrat("momo", { "strategy.py": "STRATEGY_NAME = 'momo'\n", "helper.py": "X = 1\n", "stats.json": "{}", "notes.txt": "n" });
  fs.symlinkSync(path.join(BASE, "outside.py"), path.join(d, "link.py"));
  fs.writeFileSync(path.join(BASE, "outside.py"), "SECRET = 1\n");
  let c = T.collectLocal(WS, "momo");
  t("讀資料夾裡一般的 .py,symlink 不跟、不帶;非 .py 不帶", c.files && c.files.map((x) => x.f).join() === "helper.py,strategy.py", c);
  t("每個檔帶 sha256 與 base64,內容一致", c.files.every((x) => sha(Buffer.from(x.b64, "base64")) === x.sha256) && Buffer.from(c.files[1].b64, "base64").toString() === "STRATEGY_NAME = 'momo'\n");
  mkStrat("badname", { "strategy.py": "x\n", "a b.py": "y\n" });
  t("檔名不合規 → 整個拒(BAD_FILES),不默默略過", T.collectLocal(WS, "badname").error === "BAD_FILES");
  mkStrat("resv", { "strategy.py": "x\n", "con.py": "y\n" });
  t("Windows 保留名的檔 → BAD_FILES", T.collectLocal(WS, "resv").error === "BAD_FILES");
  mkStrat("big", { "strategy.py": "x".repeat(T.FILE_MAX + 1) });
  t("單檔超過 128 KB → TOO_LARGE 點名那個檔", JSON.stringify(T.collectLocal(WS, "big")) === '{"error":"TOO_LARGE","detail":"strategy.py"}');
  mkStrat("tot", { "strategy.py": "x".repeat(90000), "b.py": "y".repeat(90000) });
  t("合計超過 160 KB → TOO_LARGE", T.collectLocal(WS, "tot").error === "TOO_LARGE");
  mkStrat("bin", { "strategy.py": Buffer.from([0xff, 0xfe]) });
  t("不是 UTF-8 → NOT_UTF8", T.collectLocal(WS, "bin").error === "NOT_UTF8");
  mkStrat("nostrat", { "helper.py": "x\n" });
  t("沒有 strategy.py / 不存在 / 壞名字 → NO_SOURCE／BAD_ARGS", T.collectLocal(WS, "nostrat").error === "NO_SOURCE" && T.collectLocal(WS, "nope").error === "NO_SOURCE"
    && T.collectLocal(WS, "../x").error === "BAD_ARGS" && T.collectLocal(WS, "con").error === "BAD_ARGS");
  fs.symlinkSync(d, path.join(SD, "aliased"));
  t("策略資料夾本身是 symlink → NO_SOURCE", T.collectLocal(WS, "aliased").error === "NO_SOURCE");

  // ── ② dataSecrets ──
  const env = ["OKX_API_KEY='realkey'", ds.BEGIN, "# source FRED added=1", "DATA_FRED_KEY='fredval'", "# source POLY added=1", "DATA_POLY_TOKEN='p1'", "DATA_POLY_SECRET='p2'",
    "# source API added=1", "DATA_API_KEY='looksvenue'", "# source BAD added=1", "DATA_BAD_KEY='has space'", ds.END, ""].join("\n");
  let sec = T.dataSecrets(env, ["FRED", "POLY", "QUANDL"], ds);
  t("照策略用到的來源取值:受管區塊裡那幾個欄位全帶;沒有的來源列在 missing", JSON.stringify(sec) === '{"secrets":{"DATA_FRED_KEY":"fredval","DATA_POLY_TOKEN":"p1","DATA_POLY_SECRET":"p2"},"missing":["QUANDL"]}', sec);
  sec = T.dataSecrets(env, ["API", "BAD"], ds);
  t("交易所形狀的名字(DATA_API_KEY)、過不了 cleanValue 的值不送;區塊外的交易所金鑰永遠不碰", JSON.stringify(sec.secrets) === "{}" && !JSON.stringify(sec).includes("realkey"), sec);

  // ── ③ checkExport ──
  const raw = { "strategy.py": Buffer.from("STRATEGY_NAME = 'cl'\n"), "h.py": Buffer.from("Y = 2\n") };
  const ack = { files: Object.entries(raw).map(([f, b]) => ({ f, sha256: sha(b) })), left_behind: ["params.json"], type: "A" };
  const got = { status: "done", name: "cl", files: Object.entries(raw).map(([f, b]) => ({ f, sha256: sha(b), b64: b.toString("base64") })) };
  let ck = T.checkExport("cl", ack, got);
  t("兩份 sha256 都對 → 交出 bytes", ck.files && ck.files.length === 2 && ck.files[0].raw.equals(raw["strategy.py"]));
  const bad = (mut) => { const g = JSON.parse(JSON.stringify(got)), a = JSON.parse(JSON.stringify(ack)); mut(g, a); return T.checkExport("cl", a, g).error; };
  t("暫存端點的內容被換(b64 跟 sha 不合)→ BAD_FILES", bad((g) => { g.files[1].b64 = Buffer.from("Y = 3\n").toString("base64"); }) === "BAD_FILES");
  t("暫存端點的 sha 跟 ack 不同 → BAD_FILES", bad((g) => { g.files[1].sha256 = sha(Buffer.from("Y = 3\n")); g.files[1].b64 = Buffer.from("Y = 3\n").toString("base64"); }) === "BAD_FILES");
  t("多一個檔、少一個檔、沒有 strategy.py、名字不對、還沒好 → 一律拒", bad((g) => { g.files.push({ f: "x.py", sha256: sha(Buffer.from("")), b64: "" }); }) === "BAD_FILES"
    && bad((g) => { g.files.pop(); }) === "BAD_FILES" && bad((g, a) => { a.files = a.files.slice(1); g.files = g.files.slice(1); }) === "BAD_FILES"
    && T.checkExport("other", ack, got).error === "BAD_FILES" && T.checkExport("cl", ack, { status: "pending" }).error === "BAD_FILES");
  t("檔名過不了閘門(路徑形)→ BAD_FILES", bad((g, a) => { a.files[1].f = "../h.py"; g.files[1].f = "../h.py"; }) === "BAD_FILES");

  // ── ④ stage / unstage ──
  const sid = "a".repeat(32), staged = T.stage(WS, sid, ck.files), sdir = path.join(WS, "state", "transfer_in", sid);
  t("暫存:寫進 state/transfer_in/<id>/、0600、交回 {f, sha256}", fs.readFileSync(path.join(sdir, "h.py"), "utf8") === "Y = 2\n" && (fs.statSync(path.join(sdir, "h.py")).mode & 0o777) === 0o600
    && JSON.stringify(staged) === JSON.stringify(ack.files));
  let threw = null; try { T.stage(WS, sid, ck.files); } catch (e) { threw = e.code; }
  t("同一個代號第二次 → 丟 EEXIST,不覆蓋", threw === "EEXIST");
  const old = "b".repeat(32); fs.mkdirSync(path.join(WS, "state", "transfer_in", old)); const past = new Date(Date.now() - 2 * 3600 * 1000); fs.utimesSync(path.join(WS, "state", "transfer_in", old), past, past);
  T.unstage(WS, sid); T.stage(WS, "c".repeat(32), ck.files);
  t("一小時前留下的暫存順手清掉;unstage 收得掉", !fs.existsSync(path.join(WS, "state", "transfer_in", old)) && !fs.existsSync(sdir));
  t("壞的暫存代號不寫", (() => { try { T.stage(WS, "../x", ck.files); return false; } catch (e) { return e.message === "BAD_STAGE"; } })());
  T.unstage(WS, "c".repeat(32));

  // ── ⑤ up() ──
  const calls = [], send = async (cmd, args, secrets, opts) => { calls.push({ cmd, args, secrets, opts }); return { ok: true, result: { dest: "momo_2", run: "backtest" }, requestId: "r".repeat(32) }; };
  const deps = (envText, srcs) => ({ ws: WS, readEnv: () => envText, sources: () => srcs, ds, send });
  let r = await T.up(deps(env, ["FRED", "QUANDL"]), "momo", "momo_2", "q".repeat(32));
  const c0 = calls[0];
  t("送上雲端:strategy_import {name, to, files},金鑰放頂層 secrets,沿用呼叫端的 requestId", c0.cmd === "strategy_import" && c0.args.name === "momo" && c0.args.to === "momo_2"
    && c0.args.files.length === 2 && JSON.stringify(c0.secrets) === '{"DATA_FRED_KEY":"fredval"}' && c0.opts.requestId === "q".repeat(32) && !("secrets" in c0.args));
  t("回傳帶 missing(這台電腦沒有金鑰的來源),沒有任何金鑰值", JSON.stringify(r.missing) === '["QUANDL"]' && !JSON.stringify(r).includes("fredval"));
  calls.length = 0; await T.up(deps("", []), "momo", "momo", null);
  t("沒有要搬的金鑰 → secrets 整個不帶(api 對 {} 回 400);to 跟 name 一樣就不帶", calls[0].secrets === null && !("to" in calls[0].args));
  calls.length = 0; r = await T.up(deps("", []), "big", null, null);
  t("讀檔就擋下 → 不送、回 kind local 帶代碼與檔名", calls.length === 0 && r.ok === false && r.kind === "local" && r.error === "TOO_LARGE" && r.detail === "strategy.py");
  r = await T.up(deps("", []), "con", null, null);
  t("壞名字 → 不送", calls.length === 0 && r.error === "BAD_ARGS");

  // ── ⑥ down() ──
  const dn = { sent: [], daemon: [], fetches: 0 };
  const ddeps = (o = {}) => ({ ws: WS, sleep: async () => {},
    send: async (cmd, args) => { dn.sent.push({ cmd, args }); return o.sendFail || { ok: true, id: "e".repeat(32), result: Object.assign({ name: "cl" }, ack) }; },
    fetchExport: async () => { dn.fetches++; return dn.fetches < 2 ? { status: "pending" } : o.got || got; },
    daemonSend: async (args) => { dn.daemon.push({ cmd: "strategy_import", args, there: fs.readdirSync(path.join(WS, "state", "transfer_in", args.stage)).sort() }); return o.daemon || { ok: true, result: { dest: "cl", run: "backtest" } }; } });
  r = await T.down(ddeps(), "cl", null);
  const dd = dn.daemon[0];
  t("拉回:strategy_export {name} → 等暫存端點(pending 不算錯)→ 比對 → 暫存 → 本機 strategy_import {name, stage, files:[{f, sha256}]}", dn.sent[0].cmd === "strategy_export" && JSON.stringify(dn.sent[0].args) === '{"name":"cl"}'
    && dn.fetches === 2 && dd.cmd === "strategy_import" && /^[0-9a-f]{32}$/.test(dd.args.stage) && JSON.stringify(dd.args.files) === JSON.stringify(ack.files) && dd.there.join() === "h.py,strategy.py" && !("to" in dd.args));
  t("回傳本機 import 的 ack、left_behind;暫存收掉", r.ok === true && r.result.dest === "cl" && r.exported.left_behind.join() === "params.json" && !fs.existsSync(path.join(WS, "state", "transfer_in", dd.args.stage)));
  t("daemon 參數過得了 daemon.js 的形狀檢查(argsOk)", argsOk("strategy_import", dd.args, true));
  dn.daemon.length = 0; dn.fetches = 0;
  r = await T.down(ddeps({ got: Object.assign({}, got, { files: got.files.map((x, i) => (i ? Object.assign({}, x, { b64: Buffer.from("evil\n").toString("base64") }) : x)) }) }), "cl", null);
  t("暫存端點的檔被換 → 不寫暫存、不送 daemon", r.ok === false && r.error === "BAD_FILES" && dn.daemon.length === 0);
  dn.fetches = 0; r = await T.down(Object.assign(ddeps(), { fetchExport: async () => ({ status: "pending" }) }), "cl", null);
  t("暫存一直沒好 → HANDOVER,不送 daemon", r.ok === false && r.error === "HANDOVER" && dn.daemon.length === 0);
  r = await T.down(ddeps({ sendFail: { ok: false, error: "MACHINE_NOT_RUNNING", kind: "undelivered" } }), "cl", null);
  t("export 沒送出 → 原樣回(畫面走 trSendError)", r.ok === false && r.kind === "undelivered" && r.error === "MACHINE_NOT_RUNNING");
  dn.fetches = 0; r = await T.down(ddeps({ daemon: { ok: false, error: "ValueError: NAME_MISMATCH: x" } }), "cl", "cl_2");
  t("本機拒絕 → kind rejected 帶原字串;to 帶過去", r.ok === false && r.kind === "rejected" && /NAME_MISMATCH/.test(r.error) && dn.daemon[dn.daemon.length - 1].args.to === "cl_2");

  // ── ⑦ cloudcmd:secrets 只跟 credentials 與 strategy_import 走 ──
  const posts = [], cc = createCloudCmd({ apiBase: "https://x", getCreds: () => ({ token: "tk", appSecret: "as" }), setTimer: (fn) => setImmediate(fn),
    post: async (u, b) => { posts.push([u, b]); return u.endsWith("/ack") ? { status: 200, body: { status: "done", ok: true, result: {} } } : { status: 200, body: { status: "queued", id: "i".repeat(32) } }; } });
  await cc.send("strategy_import", { name: "x" }, { DATA_FRED_KEY: "v" });
  await cc.send("halt", {}, { DATA_FRED_KEY: "v" });
  const bodies = posts.filter((p) => p[0].endsWith("/command")).map((p) => p[1]);
  t("cloudcmd:strategy_import 的金鑰放進頂層 secrets;別的指令帶了也丟掉", JSON.stringify(bodies[0].secrets) === '{"DATA_FRED_KEY":"v"}' && !("secrets" in bodies[1]));

  // ── ⑧ daemon.js:只有主行程送得出 strategy_import ──
  t("strategy_import 在 MAIN_ONLY、不在 UI_COMMANDS(renderer 的 trade-send 送不出)", MAIN_ONLY_COMMANDS.has("strategy_import") && !UI_COMMANDS.has("strategy_import"));
  const shape = { name: "cl", stage: "a".repeat(32), files: [{ f: "strategy.py", sha256: "0".repeat(64) }] };
  t("形狀:多欄、b64、壞代號、壞檔名、壞名字一律不收", argsOk("strategy_import", shape, true) && argsOk("strategy_import", Object.assign({}, shape, { to: "cl_2" }), true)
    && [Object.assign({}, shape, { env: {} }), Object.assign({}, shape, { stage: "../x" }), Object.assign({}, shape, { name: "con" }), Object.assign({}, shape, { files: [] }),
      Object.assign({}, shape, { files: [{ f: "strategy.py", sha256: "0".repeat(64), b64: "eA==" }] }), Object.assign({}, shape, { files: [{ f: "../a.py", sha256: "0".repeat(64) }] })].every((a) => !argsOk("strategy_import", a, true)));

  // ── ⑨ main.js 接線 ──
  const mainSrc = fs.readFileSync(path.join(ROOT, "shell", "main.js"), "utf8"), pre = fs.readFileSync(path.join(ROOT, "shell", "preload.js"), "utf8");
  t("main.js:transfer-up／transfer-down 兩支,旗標與名字閘門先擋;拉回交 daemon 一律 trusted", /handle\("transfer-up", async \(_e, name, to, requestId\) => \{\n\s*if \(!cloudHandoffOn\(\) \|\| !xfName\(name\)/.test(mainSrc)
    && /handle\("transfer-down", async \(_e, name, to\) => \{\n\s*if \(!cloudHandoffOn\(\) \|\| !xfName\(name\)/.test(mainSrc) && /daemonSend: \(args\) => tradeHost\(\)\.send\("strategy_import", args, \{ trusted: true, timeoutMs: 60000 \}\)/.test(mainSrc)
    && /fetchExport: \(id\) => cloudCmd\(\)\.fetchExport\(id\)/.test(mainSrc));
  t("cloud-send 照舊拒收 strategy_import／strategy_export(只走 transfer-*)", !/CLOUD_SHIPPED = \[[^\]]*strategy_(import|export)/.test(mainSrc));
  t("preload 只給名字、目標名、requestId", /transferUp: \(name, to, requestId\) => ipcRenderer\.invoke\("transfer-up", name, to, requestId\)/.test(pre) && /transferDown: \(name, to\) => ipcRenderer\.invoke\("transfer-down", name, to\)/.test(pre));
  t("回合帶 --handoff-card(手機來的、旗標關的不帶)", /\.\.\.\(rec\.origin === "mobile" \|\| !cloudHandoffOn\(\) \? \[\] : \["--handoff-card"\]\)/.test(mainSrc));

  // ── ⑩ 對真的 local_daemon 送一次暫存匯入 ──
  const venv = path.join(ROOT, ".venv", "bin", "python"), PY = process.env.BLAVE_TEST_PYTHON || (fs.existsSync(venv) ? venv : "python3");
  {
    fs.mkdirSync(path.join(WS, "manager"), { recursive: true }); fs.writeFileSync(path.join(WS, "manager", "wait_for_bar.py"), "");
    fs.symlinkSync(path.join(ROOT, "lib"), path.join(WS, "lib"));
    const host = createDaemonHost({ python: PY, script: path.join(ROOT, "runtime", "local_daemon.py"), base: BASE, workspace: WS,
      env: { PATH: process.env.PATH, HOME: os.homedir(), BLAVE_KLINE_SOURCE: "binance" } });
    host.start();
    for (let i = 0; i < 100 && !(host.status() && host.status().alive); i++) await new Promise((res) => setTimeout(res, 100));
    const B = Buffer.from("# Type: B\nfrom lib.order_binance import place_order\nplace_order('BTCUSDT', 'BUY', 1, {})\n");
    const sid2 = "d".repeat(32), st2 = T.stage(WS, sid2, [{ f: "strategy.py", raw: B }]);
    const renderer = await host.send("strategy_import", { name: "pulled_b", stage: sid2, files: st2 });
    t("renderer 那條(沒有 trusted)送不出", renderer.ok === false && renderer.error === "NOT_ALLOWED");
    const a = await host.send("strategy_import", { name: "pulled_b", stage: sid2, files: st2 }, { trusted: true, timeoutMs: 30000 });
    t("主行程送:daemon 讀暫存、寫進 strategies/pulled_b/,會下單的 Type B 不試跑;暫存刪掉", a.ok === true && a.result && a.result.dest === "pulled_b" && a.result.run === "not_run"
      && fs.readFileSync(path.join(SD, "pulled_b", "strategy.py")).equals(B) && !fs.existsSync(path.join(WS, "state", "transfer_in", sid2)), a);
    await host.stop();
  }
  fs.rmSync(BASE, { recursive: true, force: true });
  console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
