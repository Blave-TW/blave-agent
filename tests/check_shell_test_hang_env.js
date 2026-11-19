// shell/main.js 的 testHangEnv:測試開關 BLAVE_TEST_HANG_BEFORE_SEND 只在開發版、從啟動 app 的環境帶給常駐程式;
// 打包版一律不帶,格式不對也不帶。tradeHost 是唯一的呼叫點(agent 回合的環境不經過它)。跑法:node tests/check_shell_test_hang_env.js
const fs = require("fs"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8");
let red = 0; const t = (n, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) red++; };
const a = src.indexOf("function testHangEnv"), b = src.indexOf("function tradeHost", a);
if (a < 0 || b < 0) { console.log("FAIL  main.js 裡找不到 testHangEnv"); process.exit(1); }
eval(src.slice(a, b));

const K = "BLAVE_TEST_HANG_BEFORE_SEND";
t("開發版、秒數:帶", testHangEnv({ [K]: "600" }, false)[K] === "600");
t("開發版、forever:帶", testHangEnv({ [K]: "forever" }, false)[K] === "forever");
t("打包版:不帶", !(K in testHangEnv({ [K]: "600" }, true)));
t("沒設:不帶", Object.keys(testHangEnv({}, false)).length === 0);
t("格式不對:不帶", ["", "abc", "-5", "1;rm", "600 x"].every((v) => !(K in testHangEnv({ [K]: v }, false))));
const calls = src.split("testHangEnv(").length - 1;
t("只有定義與 tradeHost 兩處", calls === 2 && /tradeHost\(\) \{[\s\S]{0,900}extraEnv: testHangEnv\(process\.env, app\.isPackaged\)/.test(src));
// daemon.js:extraEnv 進常駐程式的環境,沒給就是空的(其他呼叫端不變)
const { createDaemonHost } = require(path.join(__dirname, "..", "shell", "daemon.js"));
const spawned = [];
const fakeSpawn = (cmd, args, opts) => { spawned.push(opts.env); const { EventEmitter } = require("events"); const c = new EventEmitter(); c.stdin = Object.assign(new EventEmitter(), { write() {}, end() {} }); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.pid = 1; c.kill = () => {}; return c; };
for (const [label, extra, want] of [["給了", { [K]: "forever" }, "forever"], ["沒給", undefined, undefined]]) {
  spawned.length = 0;
  const tmpWs = fs.mkdtempSync(path.join(require("os").tmpdir(), "hang-env-"));
  try { const h = createDaemonHost({ python: "py", script: "s", base: "/b", workspace: tmpWs, env: { PATH: "/x" }, ...(extra ? { extraEnv: extra } : {}), spawnFn: fakeSpawn }); h.start && h.start(); h.stop && h.stop(); } catch (e) { /* 起不來的部分與這題無關 */ }
  fs.rmSync(tmpWs, { recursive: true, force: true });
  t(`daemon.js extraEnv ${label}:常駐程式環境 ${want === undefined ? "沒有" : "有"} ${K}`, spawned.length > 0 && spawned[0][K] === want && spawned[0].PATH === "/x");
}
process.exit(red ? 1 : 0);
