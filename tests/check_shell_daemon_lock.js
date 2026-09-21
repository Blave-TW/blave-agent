// shell/daemon.js:daemon 以 exit 3(另一支還握著 workspace 的鎖)退出時的退讓重試。假的 spawn,不起 python、不碰 ~/Blave。
// 跑法:node tests/check_shell_daemon_lock.js
const fs = require("fs"), os = require("os"), path = require("path");
const { EventEmitter } = require("events");
const { createDaemonHost } = require("../shell/daemon.js");
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "blave-dl-"));
let red = 0;
const t = (name, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + name); if (!ok) red++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* codes[i] = 第 i 次 spawn 出來的假 daemon 幾毫秒後以什麼 code 退出;null = 一直活著。
   假 child 沒有 kill 以外的能力:宿主要是去殺「持鎖的行程」,這裡也看不到——那一條由下面的原始碼檢查守。 */
function fakeHost(name, codes, opts = {}) {
  const ws = path.join(BASE, name); fs.mkdirSync(ws, { recursive: true });
  const spawned = [];
  const spawnFn = () => {
    const c = new EventEmitter(); c.stdin = new EventEmitter(); c.stdin.write = () => true; c.stdin.end = () => {};
    c.stderr = new EventEmitter(); c.kill = () => { setTimeout(() => c.emit("exit", 0, null), 5); return true; };
    const code = codes[spawned.length]; spawned.push(Date.now());
    if (code !== null && code !== undefined) setTimeout(() => c.emit("exit", code, null), 10);
    return c;
  };
  const host = createDaemonHost({ python: "x", script: "x.py", base: BASE, workspace: ws, env: {}, spawnFn,
    lockRetryMs: [40, 80, 120], lockSettleMs: 100, ...opts });
  return { host, spawned };
}

(async () => {
  // 鎖被占 → 依序重試 → 第三次拿到
  const a = fakeHost("a", [3, 3, null]);
  a.host.start(); await sleep(25);
  let st = a.host.status();
  t("exit 3:不算在跑、lockRetry 標出第 1/3 次與下一次嘗試的時間", !st.running && st.lastExit.code === 3 && st.lockRetry
    && st.lockRetry.attempt === 1 && st.lockRetry.max === 3 && st.lockRetry.nextAt > Date.now());
  await sleep(60); st = a.host.status();
  t("第二次還是 3 → 第 2/3 次", a.spawned.length === 2 && st.lockRetry && st.lockRetry.attempt === 2);
  await sleep(100); st = a.host.status();
  t("第三次起來了:剛起來的頭一段仍標 lockRetry(nextAt:null),畫面不閃回「正常」", a.spawned.length === 3 && st.running && st.lockRetry && st.lockRetry.nextAt === null);
  await sleep(120); st = a.host.status();
  t("撐過 settle → lockRetry 回 null、在跑", st.running && st.lockRetry === null && a.spawned.length === 3);
  const gaps = a.spawned.slice(1).map((x, i) => x - a.spawned[i]);
  t("間隔照表遞增(40 → 80)", gaps[0] >= 40 && gaps[1] >= 80 && gaps[1] > gaps[0]);
  await a.host.stop();

  // 重試用完 → 落到原本的失敗狀態,不再試
  const b = fakeHost("b", [3, 3, 3, 3, 3]);
  b.host.start(); await sleep(400);
  st = b.host.status();
  t("重試用完:共 spawn 1+3 次就停、lockRetry 是 null、lastExit.code 仍是 3", b.spawned.length === 4 && !st.running && st.lockRetry === null && st.lastExit.code === 3);

  // 非 3 不走這條
  const c = fakeHost("c", [2]);
  c.host.start(); await sleep(200);
  st = c.host.status();
  t("exit 2:不重試、沒有 lockRetry", c.spawned.length === 1 && st.lockRetry === null && st.lastExit.code === 2 && st.restarts === 0);
  const d = fakeHost("d", [1, null]);
  d.host.start(); await sleep(60);
  st = d.host.status();
  t("exit 1:走原本的當機重啟(restarts),不標 lockRetry", st.lockRetry === null && st.restarts === 1 && d.spawned.length === 1);
  await d.host.stop();

  // 等鎖期間 app 要關:stop() 之後不能再冒出一支 daemon
  const e = fakeHost("e", [3, null]);
  e.host.start(); await sleep(25);
  await e.host.stop(); await sleep(80);
  t("等鎖期間 stop():重試取消,不再 spawn", e.spawned.length === 1 && !e.host.isRunning() && e.host.status().lockRetry === null);

  // 等鎖期間有人又叫了一次 start()(引擎裝完與開場各叫一次):舊的重試 timer 要清掉,不然 stop() 清不到它,之後還會冒一支出來
  const f = fakeHost("f", [3, 3, null, null, null]);
  f.host.start(); await sleep(25); f.host.start(); await sleep(10);
  await f.host.stop(); const atStop = f.spawned.length; await sleep(250);
  t("等鎖期間第二次 start() → 之後 stop():不再冒出任何一支", atStop === 2 && f.spawned.length === 2 && !f.host.isRunning() && f.host.status().lockRetry === null);

  // 只等不殺:宿主的原始碼裡沒有任何對「別的 pid」下手的路
  const src = fs.readFileSync(path.join(__dirname, "..", "shell", "daemon.js"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  t("daemon.js 不讀 lock 檔、不 process.kill 任何 pid(只會 kill 自己起的 child)", !/process\.kill|local_daemon\.lock|pkill|killall/.test(src));

  fs.rmSync(BASE, { recursive: true, force: true });
  console.log(red ? `\n${red} FAILED` : "\nall ok");
  process.exit(red ? 1 : 0);
})();
