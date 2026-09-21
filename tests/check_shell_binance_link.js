// shell/binance_link.js:連接 Binance 真錢帳戶的流程(查權限 → 過了才存 → 定期重查 → 兩次確認才通知),
// 加上 daemon.js 的 trusted 那條路、main.js 四支 IPC 的信任邊界。不打真的 Binance、不起 electron(全部注入假的)。
// 跑法:node tests/check_shell_binance_link.js
const fs = require("fs"), path = require("path");
const BL = require("../shell/binance_link.js"), { argsOk } = require("../shell/daemon.js");
let red = 0; const t = (n, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) red++; };
const K = "A".repeat(64), S = "b".repeat(64);
const perm = (b) => ({ status: 200, body: { ipRestrict: true, createTime: 1, enableReading: true, enableWithdrawals: false, enableSpotAndMarginTrading: true, enableFutures: true, ...b } });

/* 一套假的外部世界。http / ipRes 可以中途換;sent 記下交給 daemon 的每一包;timers 記下排了什麼。 */
function world(init) {
  const w = { http: perm(), ipRes: { status: 200, body: { ip: "203.0.113.7", family: 4 } }, env: "", sent: [], saved: null, notes: [], now: 1e12, timers: [], sendOk: true, notifyOk: true, ...init };
  w.link = BL.createBinanceLink({
    http: async (url, headers) => { w.lastUrl = url; w.lastHeaders = headers; if (w.http === "throw") throw new Error("x"); return w.http; },
    myIp: async () => { if (w.ipRes === "throw") throw new Error("x"); return w.ipRes; },
    send: async (env) => { w.sent.push(env); if (w.sendOk) w.env = `BLAVE_API_KEY=keep\nBINANCE_API_KEY=${env.BINANCE_API_KEY}\nBINANCE_SECRET_KEY=${env.BINANCE_SECRET_KEY}\n`; return w.sendOk ? { ok: true } : { ok: false, error: "DAEMON_DOWN" }; },
    readEnv: () => w.env, loadState: () => w.saved, saveState: (o) => { w.saved = JSON.parse(JSON.stringify(o)); },
    notify: (v) => { w.notes.push(v); return w.notifyOk; }, now: () => w.now, setTimer: (fn, ms) => { w.timers.push(ms); return w.timers.length; }, clearTimer: () => {},
  });
  return w;
}

(async () => {
  // ── 對外 IP:只認 IPv4 ──
  t("my_ip 回 IPv4 → 採用", BL.pickIp({ status: 200, body: { ip: "203.0.113.7", family: 4 } }) === "203.0.113.7");
  t("IPv6 → 不採用(Binance 白名單只收 IPv4)", BL.pickIp({ status: 200, body: { ip: "2001:db8::1", family: 6 } }) === null);
  t("family 說 4 但字串不是 IPv4、或 family 缺席 → 不採用", BL.pickIp({ status: 200, body: { ip: "2001:db8::1", family: 4 } }) === null && BL.pickIp({ status: 200, body: { ip: "203.0.113.7" } }) === null
    && BL.pickIp({ status: 200, body: { ip: "999.1.1.1", family: 4 } }) === null && BL.pickIp({ status: 200, body: { ip: "1.2.3.4<script>", family: 4 } }) === null);
  t("401 / 503 / 連不上 / 沒登入(null) → null,不丟例外", BL.pickIp({ status: 401, body: {} }) === null && BL.pickIp({ status: 503, body: { error_code: "IP_UNAVAILABLE" } }) === null && BL.pickIp(null) === null);
  { const w = world({ ipRes: { status: 200, body: { ip: "2001:db8::1", family: 6 } } }); t("link.ip():只有 IPv6 → null", (await w.link.ip()) === null);
    w.ipRes = "throw"; t("link.ip():連不上 → null", (await w.link.ip()) === null); }

  // ── 連接:查過才存 ──
  { const w = world({ http: perm({ enableWithdrawals: true }) }); const r = await w.link.connect(K, S);
    t("提領權限開著 → 不存:沒有任何東西交給 daemon、state 檔沒寫", r.ok === false && r.code === "WITHDRAW_ENABLED" && w.sent.length === 0 && w.saved === null); }
  for (const [name, http, code] of [["交易權限沒開", perm({ enableSpotAndMarginTrading: false, enableFutures: false, ipRestrict: false }), "TRADING_DISABLED"],
    ["-2015", { status: 401, body: { code: -2015 } }, "IP_OR_KEY"], ["-1022", { status: 400, body: { code: -1022 } }, "BAD_SECRET"], ["-1021", { status: 400, body: { code: -1021 } }, "CLOCK"],
    ["200 但看不懂", { status: 200, body: {} }, "UNKNOWN"], ["連不上", "throw", "NETWORK"]]) {
    const w = world({ http }); const r = await w.link.connect(K, S);
    t(`${name} → ${code},不存`, r.ok === false && r.code === code && w.sent.length === 0);
  }
  { const w = world(); const r = await w.link.connect(K, S);
    t("全對 → 存:剛好一整對交給 daemon,state 記下結果與當時的 IP", r.ok === true && r.code === "OK" && w.sent.length === 1 && Object.keys(w.sent[0]).sort().join() === "BINANCE_API_KEY,BINANCE_SECRET_KEY"
      && w.saved.prev.ok === true && w.saved.ipThen === "203.0.113.7");
    t("回給畫面的結果與 state 檔都不含金鑰", JSON.stringify(r).indexOf(K) < 0 && JSON.stringify(r).indexOf(S) < 0 && JSON.stringify(w.saved).indexOf(K) < 0 && JSON.stringify(w.saved).indexOf(S) < 0);
    t("secret 只拿來簽章:不出現在打 Binance 的 URL 與 header", w.lastUrl.indexOf(S) < 0 && JSON.stringify(w.lastHeaders).indexOf(S) < 0 && /^https:\/\/api\.binance\.com\/sapi\/v1\/account\/apiRestrictions\?/.test(w.lastUrl));
    t("連上之後排 24 小時重查", w.timers[w.timers.length - 1] === 24 * 3600 * 1000); }
  { const w = world({ http: perm({ ipRestrict: false }) }); const r = await w.link.connect(K, S);
    t("交易開著但沒白名單 → 存,帶提醒(NO_IP_RESTRICT)", r.ok === true && r.code === "NO_IP_RESTRICT" && w.sent.length === 1); }
  { const w = world({ http: perm({ enableFutures: false }) }); const r = await w.link.connect(K, S);
    t("現貨開、合約沒開 → 收(lib 兩種都下得了),結果如實帶 futures:false 給畫面講", r.ok === true && r.detail.futures === false && r.detail.spot === true && w.sent.length === 1);
    const w2 = world({ http: perm({ enableSpotAndMarginTrading: false }) }); const r2 = await w2.link.connect(K, S);
    t("合約開、現貨沒開 → 收,帶 spot:false", r2.ok === true && r2.detail.spot === false && r2.detail.futures === true); }
  { const w = world({ sendOk: false }); const r = await w.link.connect(K, S);
    t("查過了但 daemon 沒收下 → SEND_FAILED,不當成已連接、不寫 state", r.ok === false && r.code === "SEND_FAILED" && w.saved === null); }
  { const w = world(); let hit = false; w.link = null; const w2 = world({}); w2.http = perm();
    for (const [a, b] of [["", S], [K, ""], [K + " ", S], [K + "\nBLAVE_API_KEY=x", S], [K, S + "\""], [123, S], [K, null], ["短", S]]) { const r = await w2.link.connect(a, b); if (r.code !== "BAD_KEY_FORMAT" || w2.sent.length) hit = true; }
    t("形狀不對的金鑰(空、帶空白 / 換行 / 引號、不是字串)→ BAD_KEY_FORMAT,連 Binance 都不打", !hit && w2.lastUrl === undefined); }
  { const w = world({ http: { status: 429, body: {} } }); const r1 = await w.link.connect(K, S); w.http = perm(); const r2 = await w.link.connect(K, S);
    t("429 → 鎖 60 秒:鎖著的期間再按不會再打 Binance(不退讓會升級成封 IP)", r1.code === "RATE_LIMITED" && r1.lockMs === 60000 && r2.code === "RATE_LIMITED" && w.sent.length === 0);
    w.now += 61000; t("鎖過了 → 可以再連", (await w.link.connect(K, S)).ok === true);
    const w3 = world({ http: { status: 418, body: {} } }); t("418 → 鎖 5 分鐘", (await w3.link.connect(K, S)).lockMs === 300000); }

  // ── 重查:兩次確認才通知;只通知、不停單 ──
  { const w = world(); await w.link.connect(K, S);
    w.http = { status: 401, body: { code: -2015 } }; w.ipRes = { status: 200, body: { ip: "198.51.100.9", family: 4 } };
    await w.link.recheck(); t("第一次中:不發通知,排 5 分鐘後再確認", w.notes.length === 0 && w.timers[w.timers.length - 1] === BL.CONFIRM_MS && w.link.state().verdict === null);
    w.now += BL.CONFIRM_MS; await w.link.recheck();
    t("隔 5 分鐘第二次還是中 → 發一則 IP_CHANGED,帶新的 IP", w.notes.length === 1 && w.notes[0].reason === "IP_CHANGED" && w.notes[0].ip === "198.51.100.9" && w.link.state().verdict.reason === "IP_CHANGED");
    w.now += 24 * 3600 * 1000; await w.link.recheck(); w.now += BL.CONFIRM_MS; await w.link.recheck();
    t("同一件事隔天還在:不重複通知", w.notes.length === 1);
    w.http = perm(); await w.link.recheck();
    t("用戶修好了(白名單改成新 IP)→ verdict 清掉、基準 IP 換成新的", w.link.state().verdict === null && w.saved.ipThen === "198.51.100.9");
    w.http = perm({ enableWithdrawals: true }); await w.link.recheck(); w.now += BL.CONFIRM_MS; await w.link.recheck();
    t("修好之後又出事(提領被打開)→ 比得出來,再發一則 WITHDRAW_ENABLED,級別 P1(其餘是 P2)", w.notes.length === 2 && w.notes[1].reason === "WITHDRAW_ENABLED" && w.notes[1].level === "P1" && w.notes[0].level === "P2" && w.link.state().verdict.code === "WITHDRAW_ENABLED"); }
  { const w = world(); await w.link.connect(K, S); w.http = perm({ enableSpotAndMarginTrading: false, enableFutures: false });
    await w.link.recheck(); w.now += BL.CONFIRM_MS; await w.link.recheck();
    t("交易權限沒了 → TRADING_LOST(P2)", w.notes.length === 1 && w.notes[0].reason === "TRADING_LOST" && w.notes[0].level === "P2");
    w.http = perm({ enableSpotAndMarginTrading: false, enableFutures: false, enableWithdrawals: true }); w.now += 3600000; await w.link.recheck(); w.now += BL.CONFIRM_MS; await w.link.recheck();
    t("先發過交易權限那則,之後提領又被打開 → 不被去重吃掉,再發一則 P1", w.notes.length === 2 && w.notes[1].reason === "WITHDRAW_ENABLED" && w.notes[1].level === "P1"); }
  { const w = world({ notifyOk: false }); await w.link.connect(K, S); w.http = perm({ enableWithdrawals: true });
    await w.link.recheck(); w.now += BL.CONFIRM_MS; await w.link.recheck();
    t("通知沒真的送出去(字還沒交過來 / 系統不支援)→ 不記成已通知,5 分鐘後再試", w.notes.length === 1 && w.link.state().verdict.notified === false && w.saved.verdict.notified === false && w.timers[w.timers.length - 1] === BL.CONFIRM_MS);
    w.now += BL.CONFIRM_MS; await w.link.recheck(); t("下一輪還是沒送出去 → 再試一次", w.notes.length === 2 && w.link.state().verdict.notified === false);
    w.notifyOk = true; w.now += BL.CONFIRM_MS; await w.link.recheck(); t("這次送出去了 → 記成已通知、回到 24 小時", w.notes.length === 3 && w.link.state().verdict.notified === true && w.timers[w.timers.length - 1] === 24 * 3600 * 1000);
    w.now += 24 * 3600 * 1000; await w.link.recheck(); t("之後不再重發", w.notes.length === 3); }
  { const w = world(); await w.link.connect(K, S); w.http = { status: 400, body: { code: -1022 } }; await w.link.recheck(); w.now += BL.CONFIRM_MS; await w.link.recheck();
    t("存著的金鑰對不上了(-1022)→ 歸「金鑰被拒」,不說成權限變了;code 留給畫面講原因", w.notes.length === 1 && w.notes[0].reason === "KEY_REJECTED" && w.link.state().verdict.code === "BAD_SECRET"); }
  { const w = world({ saved: { prev: { ok: true, code: "OK" }, ipThen: "203.0.113.7", checkedAt: 1e12 - 1000 } }); w.env = `BINANCE_API_KEY=${K}\nBINANCE_SECRET_KEY=${S}\n`;
    w.link.recheckIfDue(); await new Promise((r) => setImmediate(r)); const none = w.lastUrl === undefined;
    w.now += 24 * 3600 * 1000; w.link.recheckIfDue(); await new Promise((r) => setTimeout(r, 10));
    t("睡眠醒來:沒過期不打 Binance,過期了才補查一次", none && w.lastUrl !== undefined); }
  { const w = world(); await w.link.connect(K, S); w.http = { status: 401, body: { code: -2015 } };
    await w.link.recheck(); w.http = perm(); w.now += BL.CONFIRM_MS; await w.link.recheck();
    t("第一次中、第二次好了 → 當沒發生", w.notes.length === 0 && w.link.state().verdict === null);
    w.http = { status: 401, body: { code: -2015 } }; await w.link.recheck(); w.now += 1000; await w.link.recheck();
    t("兩次靠太近(1 秒)不算確認", w.notes.length === 0);
    w.now += 3 * 60 * 1000; await w.link.recheck(); t("隔 3 分鐘也不算:要真的隔滿 5 分鐘(Wei 拍板)", w.notes.length === 0);
    w.now += 2 * 60 * 1000; await w.link.recheck(); t("從第一次算起滿 5 分鐘 → 算", w.notes.length === 1); }
  { const w = world(); await w.link.connect(K, S); w.http = "throw"; await w.link.recheck(); w.now += BL.CONFIRM_MS; await w.link.recheck();
    t("斷網不算事:不通知、不蓋掉上一次有結論的結果", w.notes.length === 0 && w.saved.prev.ok === true);
    w.http = { status: 401, body: { code: -2015 } }; await w.link.recheck(); w.now += BL.CONFIRM_MS; await w.link.recheck();
    t("OK → 斷網 → -2015:照樣叫人;IP 沒變 → KEY_REJECTED", w.notes.length === 1 && w.notes[0].reason === "KEY_REJECTED"); }
  { const w = world(); await w.link.connect(K, S); w.http = { status: 401, body: { code: -2015 } }; w.ipRes = { status: 200, body: { ip: "2001:db8::1", family: 6 } };
    const st = await w.link.recheck(true);
    t("用戶自己按重新測試:結果直接上畫面、不發系統通知;只拿得到 IPv6 → 不猜(REJECTED)", w.notes.length === 0 && st.verdict.reason === "REJECTED" && st.verdict.ip === null); }
  { const w = world(); await w.link.connect(K, S); w.env = "BLAVE_API_KEY=keep\nPAPER_API_KEY=paper\n"; w.http = { status: 401, body: { code: -2015 } }; const before = w.lastUrl;
    await w.link.recheck(); t("解除綁定 / 改綁模擬交易之後:不打 Binance、比對基準清掉", w.lastUrl === before && w.saved.prev === null && w.notes.length === 0); }
  { const w = world({ saved: { prev: { ok: true, code: "OK" }, ipThen: "<img src=x>", verdict: { reason: "IP_CHANGED", ip: "javascript:1" } } });
    t("state 檔被改過:不是 IPv4 的東西不會一路帶到畫面", w.link.state().verdict.ip === null); }
  t("readKeys:只認 BINANCE_ 那一對、剝一層引號;缺一半 = 沒綁", BL.readKeys(`X=1\nBINANCE_API_KEY="${K}"\nbinance_secret_key=${S}\n`).apiKey === K && BL.readKeys(`BINANCE_API_KEY=${K}\n`) === null && BL.readKeys(null) === null);

  // ── daemon.js:renderer 那條路仍然只收模擬交易 ──
  const bn = { env: { BINANCE_API_KEY: K, BINANCE_SECRET_KEY: S } };
  t("renderer 的 credentials 帶 Binance 金鑰 → BAD_ARGS(繞不過主行程的權限檢查)", argsOk("credentials", bn) === false && argsOk("credentials", bn, false) === false && argsOk("credentials", bn, "true") === false);
  t("trusted 那條路:剛好一整對才收;半對、多一個 key、值帶換行都不收", argsOk("credentials", bn, true) === true && argsOk("credentials", { env: { BINANCE_API_KEY: K } }, true) === false
    && argsOk("credentials", { env: { ...bn.env, BLAVE_API_KEY: "x" } }, true) === false && argsOk("credentials", { env: { BINANCE_API_KEY: K + "\nX=1", BINANCE_SECRET_KEY: S } }, true) === false
    && argsOk("credentials", { env: { PAPER_API_KEY: "paper", PAPER_SECRET_KEY: "paper" } }, true) === false);
  t("模擬交易照舊;解除綁定兩種都拿得掉,別的名字不行", argsOk("credentials", { env: { PAPER_API_KEY: "paper", PAPER_SECRET_KEY: "paper", PAPER_BOUND_TS: "1700000000" } }) === true
    && argsOk("credentials_remove", { env: ["BINANCE_API_KEY", "BINANCE_SECRET_KEY"] }) === true && argsOk("credentials_remove", { env: ["BLAVE_API_KEY"] }) === false);

  // ── main.js:四支 IPC 的信任邊界(把那一段原文切出來,配假的 ipcMain 真的跑)──
  const mainSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8");
  const seg = mainSrc.slice(mainSrc.indexOf('  ipcMain.handle("binance-ip"'), mainSrc.indexOf('  ipcMain.handle("min-version-state"'));
  const handlers = {}, calls = [];
  const fakeLink = { ip: async () => "203.0.113.7", state: () => ({ last: null }), recheck: async (m) => { calls.push(["recheck", m]); return {}; }, connect: async (a, b) => { calls.push(["connect", a, b]); return { ok: true, code: "OK" }; } };
  let ours = false;
  new Function("ipcMain", "fromOurPage", "binanceLink", seg)({ handle: (n, fn) => { handlers[n] = fn; } }, () => ours, () => fakeLink);
  const names = ["binance-ip", "binance-state", "binance-recheck", "binance-connect"];
  t("main.js:binance-* 剛好這四支(多一支要回來補這份檢查)", Object.keys(handlers).sort().join() === names.slice().sort().join() && (mainSrc.match(/ipcMain\.(handle|on)\("binance-/g) || []).length === 4);
  const foreign = []; for (const n of names) foreign.push(await handlers[n]({}, { apiKey: K, secret: S }));
  t("不是我方頁面發的 → 四支全部拒絕,binance_link 一次都沒被叫到", foreign[0] === null && foreign[1] === null && foreign[2] === null && foreign[3].ok === false && foreign[3].code === "NOT_ALLOWED" && calls.length === 0);
  ours = true;
  t("我方頁面:參數不是物件 → 拒絕", (await handlers["binance-connect"]({}, "x")).code === "NOT_ALLOWED" && (await handlers["binance-connect"]({}, [K, S])).code === "NOT_ALLOWED" && calls.length === 0);
  await handlers["binance-connect"]({}, { apiKey: K, secret: S, trusted: true }); await handlers["binance-recheck"]({});
  t("我方頁面:connect 只把兩個字串交下去;用戶按的重查是 manual", calls[0].length === 3 && calls[0][1] === K && calls[0][2] === S && calls[1][1] === true);
  t("main.js:Binance 金鑰只經 trusted 那條路送;renderer 的 trade-send 不帶第三個參數", /send\("credentials", \{ env \}, \{ trusted: true \}\)/.test(mainSrc) && (mainSrc.match(/trusted: true/g) || []).length === 1
    && /const out = tradeHost\(\)\.send\(cmd, args && typeof args === "object" \? args : \{\}\);/.test(mainSrc));
  t("main.js:my_ip 強制走 IPv4", /my_ip`, \{ token: tok \}, \{ family: 4 \}\)/.test(mainSrc));
  t("main.js:通知真的交給系統才回 true;字沒到 / 不支援 → false;只有 P1 亮 Dock 紅點", /isSupported\(\)\) return false;/.test(mainSrc) && /v\.level === "P1" && app\.dock/.test(mainSrc) && /n\.show\(\);\n[^\n]*\n[^\n]*\n  return true;/.test(mainSrc));
  t("main.js:binance-state 只推給自家頁面;睡眠醒來補查", /isOurPageUrl\(w\.webContents\.getURL\(\)\)\) w\.webContents\.send\("binance-state"/.test(mainSrc) && /powerMonitor\.on\("resume", \(\) => _binanceLink\.recheckIfDue\(\)\)/.test(mainSrc));
  t("main.js / binance_link.js:金鑰不進 log", !/console\.(log|error|warn)\([^)]*(apiKey|secret\b|BINANCE_)/.test(mainSrc) && !/console\./.test(fs.readFileSync(path.join(__dirname, "..", "shell", "binance_link.js"), "utf8")));
  const filesLine = (fs.readFileSync(path.join(__dirname, "..", "shell", "electron-builder.config.js"), "utf8").match(/^\s*files: \[[^\n]*$/m) || [""])[0];
  t("打包清單有 binance_link.js 與 binance_check.js(稽核 R11:缺檔 = 發佈版連不了,或檢查靜默不跑)", /"binance_link\.js"/.test(filesLine) && /"binance_check\.js"/.test(filesLine));
  t("binance_link 載入檢查模組沒有 try/catch 退路(缺檔要整個炸掉,不能變成不檢查)", /^const BC = require\("\.\/binance_check"\);$/m.test(fs.readFileSync(path.join(__dirname, "..", "shell", "binance_link.js"), "utf8")));
  const daemonPy = fs.readFileSync(path.join(__dirname, "..", "runtime", "local_daemon.py"), "utf8"), clPy = fs.readFileSync(path.join(__dirname, "..", "runtime", "command_listener.py"), "utf8");
  t("runtime:Binance 只在 daemon 行程裡打開;聊天綁定那條路(command_listener 的預設)仍然只有模擬交易", /cl\.LOCAL_OPEN_VENUES = frozenset\(cl\.LOCAL_OPEN_VENUES \| \{"BINANCE"\}\)/.test(daemonPy) && /^LOCAL_OPEN_VENUES = frozenset\(\{"PAPER"\}\)$/m.test(clPy));

  console.log(red ? `\n${red} 個失敗` : "\n全部通過"); process.exit(red ? 1 : 0);
})();
