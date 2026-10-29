// 內建瀏覽器租約(0.1.37 對話分頁並行;shell/browser/index.js acquire / mcp.js acquire 掛勾)。不開視窗:電子物件與頁面都是假的,
// 走真的本機 MCP HTTP(每一輪自己那顆 token)。
//   1. beginTurn 只發 token、不拿租約;第一次呼叫瀏覽器工具才拿
//   2. 別條拿著時原地等、第一次等時通知主行程(onWait → 那個分頁的 browser_wait);拿著的那條收尾就輪到它
//   3. 等滿上限回 browser_busy(onBusy);等的那一輪先結束 → browser_off
//   4. 沒拿租約的那一輪收尾不動別條的租約;每一輪的 token 各自作廢
//   5. 等租約的時間不算進工具的上限(acquire 在開始計時之前);等待上限 + 最長工具上限 < 引擎那端 600 秒
// 跑法:node tests/check_shell_browser_lease.js
const path = require("path"), fs = require("fs"), os = require("os"), http = require("http"), { EventEmitter } = require("events");
const B = path.join(__dirname, "..", "shell", "browser");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  " + JSON.stringify(d).slice(0, 500))); if (!c) red++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cdpFile = require.resolve(path.join(B, "cdp"));
require.cache[cdpFile] = { id: cdpFile, filename: cdpFile, loaded: true, exports: { createPage: () => ({ attach: async () => {}, detach: () => {}, guarded: () => false, guard: async () => {}, disarm: async () => {}, quiet: async () => {}, run: async () => null }) } };
class FakeView { constructor() { const wc = new EventEmitter(); Object.assign(wc, { id: 1, setAudioMuted() {}, setWindowOpenHandler() {}, getURL: () => "", getTitle: () => "", isDestroyed: () => false, isLoading: () => false, loadURL: async () => {}, close() {}, stop() {}, navigationHistory: { canGoBack: () => false } }); this.webContents = wc; } getBounds() { return { x: 0, y: 0, width: 1, height: 1 }; } setBounds() {} }
const ses = { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDevicePermissionHandler() {}, on() {}, webRequest: { onBeforeRequest() {}, onResponseStarted() {} } };
const fakeE = { WebContentsView: FakeView, session: { fromPartition: () => ses }, nativeImage: { createFromBuffer: () => ({ getSize: () => ({ width: 1, height: 1 }) }) }, net: {} };
const win = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, contentView: { addChildView() {}, removeChildView() {} }, webContents: { send() {}, getZoomFactor: () => 1 } };

function rpc(mount, name) {
  const u = new URL(mount.url), body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }));
  return new Promise((resolve) => {
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { "content-type": "application/json", "content-length": body.length, authorization: "Bearer " + mount.token } }, (res) => {
      const b = []; res.on("data", (c) => b.push(c));
      res.on("end", () => { let j = null; try { j = JSON.parse(Buffer.concat(b).toString()); } catch (_) { j = null; } resolve({ status: res.statusCode, at: Date.now(), out: j && j.result ? JSON.parse(j.result.content[0].text) : null }); });
    });
    r.on("error", () => resolve({ status: 0 })); r.end(body);
  });
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blave-lease-"));
  const waits = [], busies = [];
  const Br = require(path.join(B, "index.js")).createBrowser({ electron: fakeE, stateDir: path.join(tmp, "snaps"), reportsDir: path.join(tmp, "reports"), getWin: () => win, uiLang: () => "en", track: () => {}, version: "t",
    reducedMotion: () => true, userPresent: () => true, leaseWaitMs: 300, onWait: (sid) => waits.push(sid), onBusy: (sid) => busies.push(sid) });
  const A = "desktop-aaaa1111", Bs = "desktop-bbbb2222", C = "desktop-cccc3333";
  const ma = await Br.beginTurn(win, A, { userSent: true }), mb = await Br.beginTurn(win, Bs, { userSent: true });
  ok("beginTurn 只發 token(各一顆、各一個 key),還沒有人拿租約", ma.token !== mb.token && ma.key !== mb.key && Br._cur() === null);
  const ra = await rpc(ma, "browser_tabs");
  ok("A 第一次呼叫瀏覽器工具:拿到租約、照常回", ra.status === 200 && ra.out && ra.out.ok !== false && Br._cur() && Br._cur().sessionId === A, ra);
  const pb = rpc(mb, "browser_tabs"); await sleep(60);
  ok("B 在 A 拿著時呼叫:原地等,通知一次 onWait(B)", Br._cur().sessionId === A && waits.join() === Bs);
  const t0 = Date.now(); Br.endTurn(ma.key); const rb = await pb;
  ok("A 收尾 → B 立刻拿到租約、那一次呼叫照常回", rb.out && rb.out.ok !== false && Br._cur().sessionId === Bs && rb.at - t0 < 200, rb);
  ok("A 作廢之後再用 A 的 token → 401", (await rpc(ma, "browser_tabs")).status === 401);
  const mc = await Br.beginTurn(win, C, { userSent: true });
  const rc = await rpc(mc, "browser_tabs");
  ok("等滿上限 → browser_busy(帶講得出原因的訊息)、onBusy(C);B 的租約不動", rc.out && rc.out.error === "browser_busy" && /another conversation/.test(rc.out.message) && busies.join() === C && Br._cur().sessionId === Bs, rc);
  ok("同一條等第二次不重複通知 onWait", (await rpc(mc, "browser_tabs"), waits.filter((x) => x === C).length === 1));
  const pc = rpc(mc, "browser_tabs"); await sleep(30); Br.endTurn(mc.key); const rc2 = await pc;
  ok("等的那一輪先結束 → 回 browser_off(這一輪已結束)、租約還在 B", rc2.out && rc2.out.error === "browser_off" && Br._cur().sessionId === Bs, rc2);
  const md = await Br.beginTurn(win, "desktop-dddd4444", {}); Br.endTurn(md.key);
  ok("沒拿租約的那一輪收尾:不動 B 的租約、B 的 token 照常", Br._cur().sessionId === Bs && (await rpc(mb, "browser_tabs")).status === 200);
  Br.endTurn(mb.key);
  ok("最後一條收尾:租約空出來", Br._cur() === null);

  const idx = fs.readFileSync(path.join(B, "index.js"), "utf8"), mcp = fs.readFileSync(path.join(B, "mcp.js"), "utf8");
  ok("mcp:acquire 在工具上限計時之前(等租約的時間不算進 CALL_MAX_MS)", mcp.indexOf("deny = await opts.acquire(myTurn") > 0 && mcp.indexOf("deny = await opts.acquire(myTurn") < mcp.indexOf("const cap = (opts.maxMs"));
  const wait = Number((/const LEASE_WAIT_MS = o\.leaseWaitMs \|\| (\d+);/.exec(idx) || [])[1]), search = require(path.join(B, "verify.js")).SEARCH_CALL_MAX_MS + 60000;
  ok("等待上限 + 最長的工具上限(搜尋)< 引擎那端的 600 秒", wait > 0 && wait + search < require(path.join(B, "..", "mcpcode.js")).BROWSER_TOOL_TIMEOUT_MS, { wait, search });
  const main = fs.readFileSync(path.join(B, "..", "main.js"), "utf8");
  ok("main.js:收尾只作廢這一輪的(endTurn(brMount.key));onWait 送那個分頁 browser_wait、記 br_wait;onBusy 記 br_busy",
    (main.match(/_browser\.endTurn\(brMount\.key\)/g) || []).length === 2 && !/_browser\.endTurn\(\)/.test(main)
    && /onWait: \(sid\) => \{ sendTurn\(sid, "turn-event", \{ type: "browser_wait" \}\); tm\(\)\.track\("feature_used", \{ name: "br_wait" \}\); \}/.test(main) && /onBusy: \(\) => tm\(\)\.track\("feature_used", \{ name: "br_busy" \}\)/.test(main));
  ok("runtime:browser_rule 講 browser_busy 怎麼對待", /`browser_busy` means another conversation still has it/.test(fs.readFileSync(path.join(B, "..", "..", "runtime", "agent_turn.py"), "utf8")));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(red ? `\n${red} FAILED` : "\nALL PASS");
  process.exit(red ? 1 : 0);
})().catch((e) => { console.log("FAIL  " + (e && e.stack)); process.exit(1); });
