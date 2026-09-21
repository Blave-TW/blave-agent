// shell/daemon.js(本機常駐程式的宿主)對**真的** runtime/local_daemon.py 跑一輪:啟動、簽章指令、
// 拒收沒簽的、狀態檔、收工。跑法:node tests/check_shell_daemon.js(需要 python3;不碰 ~/Blave)
const fs = require("fs"), os = require("os"), path = require("path");
const { createDaemonHost, UI_COMMANDS, argsOk } = require("../shell/daemon.js");
const ROOT = path.join(__dirname, "..");
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "blave-dh-")), WS = path.join(BASE, "workspace");
fs.mkdirSync(path.join(WS, "manager"), { recursive: true });
fs.mkdirSync(path.join(WS, "strategies"), { recursive: true });
fs.writeFileSync(path.join(WS, "manager", "wait_for_bar.py"), "");
fs.symlinkSync(path.join(ROOT, "lib"), path.join(WS, "lib"));   // halt 走 lib/guard;用 repo 那份,唯讀
let red = 0;
const t = (name, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + name); if (!ok) red++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PY = process.env.BLAVE_TEST_PYTHON || "python3";
const host = createDaemonHost({ python: PY, script: path.join(ROOT, "runtime", "local_daemon.py"), base: BASE, workspace: WS,
  env: { PATH: process.env.PATH, HOME: os.homedir(), BLAVE_KLINE_SOURCE: "binance", BLAVE_PROXY_TOKEN: "must-not-matter" } });

(async () => {
  t("daemon 沒跑:resume 直接回 DAEMON_DOWN,不寫檔", (await host.send("resume", {})).error === "DAEMON_DOWN"
    && !fs.existsSync(path.join(WS, "state", "local_cmd", "in")));
  t("畫面沒有的指令不送(delete_strategy)", (await host.send("delete_strategy", { name: "x" })).error === "NOT_ALLOWED");
  t("白名單不含會動報告排程 / 偏好的指令", !["report_delete", "preferences_set", "manage_backtest", "tz_set"].some((c) => UI_COMMANDS.has(c)));
  // 參數形狀:renderer 被攻破時不能藉 credentials 把任意 key 寫進 .env,也不能拿掉別的 key
  t("credentials 只收這一版認得的 key 與值", argsOk("credentials", { env: { PAPER_API_KEY: "paper", PAPER_SECRET_KEY: "paper", PAPER_BOUND_TS: "1789920000" } })
    && !argsOk("credentials", { env: { BINANCE_API_KEY: "x" } }) && !argsOk("credentials", { env: { PAPER_API_KEY: "paper", PATH: "/tmp" } })
    && !argsOk("credentials", { env: {} }) && !argsOk("credentials", { env: { PAPER_API_KEY: "paper" }, extra: 1 }));
  t("credentials_remove 只准拿掉認得的 key", argsOk("credentials_remove", { env: ["PAPER_API_KEY", "paper_secret_key"] })
    && !argsOk("credentials_remove", { env: ["blave_api_key"] }) && !argsOk("credentials_remove", { env: [] }));
  t("amounts:名字、有限非負數、上限", argsOk("amounts", { amounts: { a_b: 1000, c: 0 } }) && !argsOk("amounts", { amounts: { a: -1 } })
    && !argsOk("amounts", { amounts: { a: 1e12 } }) && !argsOk("amounts", { amounts: { "../x": 1 } }) && !argsOk("amounts", { amounts: { a: "1" } }));
  t("不收參數的指令帶了參數就拒", argsOk("close_all", {}) && !argsOk("close_all", { venue: "x" }) && (await host.send("close_all", { x: 1 })).error === "BAD_ARGS");
  // spawn 失敗(python 不在):不能是未捕捉例外,isRunning 要回 false,stop() 要馬上回來(稽核 B1)
  const bad = createDaemonHost({ python: path.join(BASE, "no-such-python"), script: "x.py", base: BASE, workspace: WS, env: {} });
  bad.start(); await sleep(300);
  const t0 = Date.now(); await bad.stop();
  t("spawn 失敗:isRunning=false、stop() 不卡", !bad.isRunning() && Date.now() - t0 < 1000 && (await bad.send("resume", {})).error === "DAEMON_DOWN");
  host.start();
  for (let i = 0; i < 100 && !host.status().alive; i++) await sleep(200);
  const st = host.status();
  t("起得來、狀態檔有心跳", st.running && st.alive && st.report && st.report.daemon.signed === true);
  t("狀態檔不含 secret 與任何 key 值", !/[0-9a-f]{64}/.test(JSON.stringify(st.report)));
  const h = await host.send("halt", {});
  t("簽章的 halt → ack ok、HALT 檔出現", h.ok === true && fs.existsSync(path.join(WS, "state", "HALT")));
  // 模擬 agent 往 in/ 丟一份沒簽的 resume:daemon 要拒收,HALT 還在
  const forged = "forged" + Date.now();
  const inDir = path.join(WS, "state", "local_cmd", "in");
  fs.writeFileSync(path.join(inDir, forged + ".json"), JSON.stringify({ body: JSON.stringify({ id: forged, cmd: "resume", args: {}, ts: Date.now() / 1000 }), mac: "" }));
  let ack = null;
  for (let i = 0; i < 50 && !ack; i++) { await sleep(200); try { ack = JSON.parse(fs.readFileSync(path.join(WS, "state", "local_cmd", "ack", forged + ".json"), "utf8")); } catch (_) {} }
  t("沒簽的 resume 被拒、HALT 沒被拿掉", ack && ack.ok === false && fs.existsSync(path.join(WS, "state", "HALT")));
  const big = await host.send("amounts", { amounts: Object.fromEntries(Array.from({ length: 200 }, (_, i) => ["s".repeat(120) + i, 1])) });
  t("超過 16KB 的指令在這一側就擋下", big.error === "TOO_LARGE");
  // 權益歷史:reset 之前的點不進曲線;今天的損益以今天第一個點為基準;沒有帳戶時 today 是 null(不編數字)
  const now = Math.floor(Date.now() / 1000), eqf = path.join(WS, "state", "equity_history.jsonl");
  fs.writeFileSync(eqf, [{ ts: now - 9000, venue: "paper", equity: 5 }, { ts: now - 8000, reset: true }, "garbage",
    { ts: now - 7200, venue: "paper", equity: 10000 }, { ts: now - 3600, venue: "paper", equity: 10100 }]
    .map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n");
  const eq = host.equity({ days: 1 });
  t("equity():reset 前的點與壞行不進曲線", eq.curve.length === 2 && eq.curve[0].equity === 10000 && eq.baseline_ts === now - 7200);
  t("equity():沒有讀得到的帳戶 → today 是 null、unrealized 是 null", eq.today === null && eq.unrealized === null);
  const pid = st.report.daemon.pid;
  await host.stop();
  let gone = false; try { process.kill(pid, 0); } catch (_) { gone = true; }
  t("stop():daemon 行程結束", gone && !host.isRunning());
  t("stop() 之後 status 不再說活著", host.status().alive === false);
  host.start();
  for (let i = 0; i < 100 && !host.status().alive; i++) await sleep(200);
  t("再起一份:拿得到鎖、換了新的 secret 也能簽", host.status().alive && (await host.send("halt", {})).ok === true);
  await host.stop();
  fs.rmSync(BASE, { recursive: true, force: true });
  console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0);
})();
