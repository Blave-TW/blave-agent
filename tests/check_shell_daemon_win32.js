// shell/daemon.js 收工順序:win32 只送 EOF、逾時才 kill(Node 在 Windows 的 kill() 一律 TerminateProcess,
// 沒有撤單那條路);darwin 仍是 EOF + SIGTERM 同時送。假的 spawn,不起 python、不碰 ~/Blave。
// 跑法:node tests/check_shell_daemon_win32.js
const fs = require("fs"), os = require("os"), path = require("path");
const { EventEmitter } = require("events");
const { createDaemonHost } = require("../shell/daemon.js");
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "blave-dw-"));
let red = 0;
const t = (name, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + name); if (!ok) red++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* exitOnEof:daemon 收到 EOF 後幾毫秒自己退出(null = 不理 EOF,只有 kill 能結束它)。
   log 記下宿主對子行程做的每一件事與時間。 */
function fakeHost(name, platform, exitOnEof) {
  const ws = path.join(BASE, name); fs.mkdirSync(ws, { recursive: true });
  const log = []; const t0 = Date.now();
  const spawnFn = () => {
    const c = new EventEmitter();
    c.stdin = new EventEmitter(); c.stdin.write = () => true;
    c.stdin.end = () => { log.push(["end", Date.now() - t0]); if (exitOnEof !== null) setTimeout(() => c.emit("exit", 0, null), exitOnEof); };
    c.stderr = new EventEmitter();
    c.kill = (sig) => { log.push(["kill:" + sig, Date.now() - t0]); setTimeout(() => c.emit("exit", null, sig), 5); return true; };
    return c;
  };
  const host = createDaemonHost({ python: "x", script: "x.py", base: BASE, workspace: ws, env: {}, spawnFn, platform, stopKillMs: 120, stopGiveUpMs: 300 });
  return { host, log };
}

(async () => {
  // win32、daemon 乖乖走 EOF:只有 end,沒有任何 kill
  const a = fakeHost("a", "win32", 30);
  a.host.start(); await sleep(10);
  const ta = Date.now(); await a.host.stop();
  t("win32:收工 = 只送 EOF,daemon 自己退出,沒有 kill", a.log.map((x) => x[0]).join(",") === "end" && Date.now() - ta < 120 && !a.host.isRunning());

  // win32、daemon 不理 EOF:等滿預算才 kill,而且 kill 不是在 EOF 的同一刻
  const b = fakeHost("b", "win32", null);
  b.host.start(); await sleep(10);
  await b.host.stop();
  const names = b.log.map((x) => x[0]);
  t("win32:EOF 沒回應 → 逾時才 kill(順序 end → kill)", names.join(",") === "end,kill:SIGKILL" && b.log[1][1] - b.log[0][1] >= 110 && !b.host.isRunning());

  // darwin:一字不變——EOF 與 SIGTERM 同一刻送出
  const c = fakeHost("c", "darwin", null);
  c.host.start(); await sleep(10);
  await c.host.stop();
  const cn = c.log.map((x) => x[0]);
  t("darwin:EOF + SIGTERM 同一刻送出(daemon 應 SIGTERM 退出,沒走到 SIGKILL)", cn.join(",") === "end,kill:SIGTERM" && c.log[1][1] - c.log[0][1] < 20);

  // 預設值沒動:9 秒 kill、11 秒放行
  const src = fs.readFileSync(path.join(__dirname, "..", "shell", "daemon.js"), "utf8");
  t("stop() 預算仍是 9000 / 11000 毫秒", /STOP_KILL_MS = 9000, STOP_GIVE_UP_MS = 11000/.test(src));

  fs.rmSync(BASE, { recursive: true, force: true });
  console.log(red ? `\n${red} FAILED` : "\nall ok");
  process.exit(red ? 1 : 0);
})();
