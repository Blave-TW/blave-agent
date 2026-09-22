// 電腦版自動掛上 `blave` MCP(shell/mcpcode.js + main.js 的接線 + runtime 的 --mcp-config)。
// 接入碼能讓 agent 拿到用戶雲端主機的 SSH:這支釘住「碼只在主行程記憶體、只經單次設定檔交給 CLI、有效期內不重打、
// 換人就丟、拿不到就不掛而且不擋回合、功能預設關」。
// 跑法:node tests/check_shell_mcp_code.js
const fs = require("fs"), os = require("os"), path = require("path");
const M = require("../shell/mcpcode");
let red = 0; const t = (n, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) red++; };
const CODE = "blv_" + "a".repeat(40), CODE2 = "blv_" + "b".repeat(40), URL_OK = "https://mcp.blave.org/mcp";
const ok200 = (o = {}) => ({ status: 200, body: { access_code: CODE, expires_in: 7200, expires_at: 1, renew_after: 3600, mcp_url: URL_OK, machine_state: "running", server_time: 1, ...o } });
const world = (o = {}) => { const w = { now: 1e12, calls: 0, res: o.res || ok200(), creds: "creds" in o ? o.creds : { token: "tokA", appSecret: "sec" }, bodies: [] };
  w.mc = M.createMcpCode({ apiBase: "https://api.blave.org", now: () => w.now, getCreds: () => w.creds, post: async (u, b) => { w.calls++; w.bodies.push([u, b]); if (w.hang) await w.hang; if (w.res === "throw") throw new Error("net"); return w.res; } }); return w; };

(async () => {
  // ── interpret ──
  t("200 → OK;renew_after 不合理就用一半", M.interpret(ok200()).code === "OK" && M.interpret(ok200()).renewAfterMs === 3600000 && M.interpret(ok200({ renew_after: 99999 })).renewAfterMs === 3600000 && M.interpret(ok200({ renew_after: undefined })).renewAfterMs === 3600000);
  t("401 / 409 / 429 / 404 / 503 / 連不上 → 各自的代號(全部 = 不掛)", ["AUTH", "NO_MACHINE", "RATE_LIMITED", "UNAVAILABLE", "UNAVAILABLE"].join() === [401, 409, 429, 404, 503].map((s) => M.interpret({ status: s, body: {} }).code).join() && M.interpret(null).code === "OFFLINE" && M.interpret({ status: 500, body: {} }).code === "OFFLINE");
  t("mcp_url 只認 https + blave.org 底下(碼會連同 Bearer 交給那個網址);碼的形狀、有效期不對 → BAD_RESPONSE", ["http://mcp.blave.org/mcp", "https://evil.example/mcp", "https://blave.org.evil.example/", "https://u:p@mcp.blave.org/", "x", null].every((u) => M.interpret(ok200({ mcp_url: u })).code === "BAD_RESPONSE")
    && ["", "blv_short", "abc_" + "a".repeat(40), "blv_" + "a".repeat(20) + "\n", 5, null].every((c) => M.interpret(ok200({ access_code: c })).code === "BAD_RESPONSE") && [0, -1, 60, 1e9, "x"].every((e) => M.interpret(ok200({ expires_in: e })).code === "BAD_RESPONSE"));

  // ── 有效期內重用、過一半才續、續失敗用舊的 ──
  { const w = world(); const a = await w.mc.get(), b = await w.mc.get(); w.now += 59 * 60 * 1000; const c = await w.mc.get();
    t("第一輪打一次;之後有效期內每一輪都重用記憶體那顆,不再打(伺服器每呼叫一次就發新撤舊、桶 12 / 小時)", w.calls === 1 && a.accessCode === CODE && a.url === URL_OK && b.accessCode === CODE && c.accessCode === CODE);
    t("送的是兩顆憑證、打的是契約那支端點", w.bodies[0][0] === "https://api.blave.org/oauth/desktop/cloud/mcp_code" && JSON.stringify(w.bodies[0][1]) === JSON.stringify({ token: "tokA", app_secret: "sec" }));
    w.now += 2 * 60 * 1000; w.res = ok200({ access_code: CODE2 }); const d = await w.mc.get();
    t("過了 renew_after(一半)→ 續一顆新的", w.calls === 2 && d.accessCode === CODE2);
    w.now += 61 * 60 * 1000; w.res = { status: 503, body: {} }; const e = await w.mc.get(), f = await w.mc.get();
    t("續失敗而舊的還沒過期 → 繼續用舊的;而且退讓,不會每一輪都再打", e.accessCode === CODE2 && f.accessCode === CODE2 && w.calls === 3);
    w.now += 59 * 60 * 1000; const g = await w.mc.get();
    t("離過期不到 1 分鐘 → 不拿來掛(null);退讓期已過所以再問一次,還是失敗", g === null && w.calls === 4);
    const g2 = await w.mc.get(); t("退讓期內:不重打、仍然不掛", g2 === null && w.calls === 4);
    w.now += 11 * 60 * 1000; w.res = ok200(); const h = await w.mc.get(); t("退讓期過了、伺服器好了 → 拿到新的", h && h.accessCode === CODE && w.calls === 5); }

  // ── 拿不到就不掛,而且不拋 ──
  for (const [name, res] of [["沒有雲端主機(409)", { status: 409, body: { error_code: "NO_MACHINE" } }], ["端點還沒部署(404)", { status: 404, body: {} }], ["503 MCP_CODE_UNAVAILABLE", { status: 503, body: {} }], ["429", { status: 429, body: {} }], ["401", { status: 401, body: {} }], ["連不上(post 拋例外)", "throw"], ["回應被動過手腳", ok200({ mcp_url: "https://evil.example/" })]]) {
    const w = world({ res }); let threw = false, r; try { r = await w.mc.get(); await w.mc.get(); } catch (_) { threw = true; }
    t(name + " → null、不拋、第二輪不重打", !threw && r === null && w.calls === 1); }
  { const w = world({ creds: null }); t("沒登入 → 不打、null", (await w.mc.get()) === null && w.calls === 0);
    const w2 = world({ creds: { token: "tokA", appSecret: null } }); t("舊登入(沒有 app_secret)→ 不打、null", (await w2.mc.get()) === null && w2.calls === 0); }
  { const w = world(); await w.mc.get(); w.now -= 5000; t("本機時鐘被往回調(經過時間是負的)→ 當成過期,重新取", (await w.mc.get()) !== null && w.calls === 2); }

  // ── 這顆碼是誰的 ──
  { const w = world(); await w.mc.get(); w.creds = { token: "tokB", appSecret: "sec" }; w.res = ok200({ access_code: CODE2 }); const b = await w.mc.get();
    t("換了帳號(token 不同)→ A 的碼丟掉,替 B 重新取;B 拿不到 A 的", w.calls === 2 && b.accessCode === CODE2);
    w.res = { status: 409, body: {} }; w.creds = { token: "tokC", appSecret: "sec" }; t("C 沒有主機 → null(不會沿用 B 的)", (await w.mc.get()) === null); }
  { const w = world(); await w.mc.get(); w.mc.reset(); w.creds = null; t("登出(reset)→ 記憶體裡的碼沒了", (await w.mc.get()) === null && w.mc.state().has === false); }
  // 稽核登記:退讓跟著**人**走。同一個人不能靠登出再登入繞過 429;換成別的帳號則不該被前一個人的退讓連坐(桶是帳號桶)
  { const w = world({ res: { status: 429, body: {} } }); await w.mc.get();
    w.mc.reset(); await w.mc.get();
    t("被限速之後同一個人登出再登入:仍在退讓期內,不會再打(不能拿登出當繞過 429 的按鈕)", w.calls === 1 && w.mc.state().retryInMs > 0);
    w.now += 31 * 60 * 1000; w.res = ok200(); t("退讓期過了才會再打", (await w.mc.get()) !== null && w.calls === 2); }
  { const w = world({ res: { status: 429, body: {} } }); await w.mc.get();
    w.creds = { token: "tokB", appSecret: "sec" }; w.res = ok200();
    t("換成別的帳號:不被前一個人的退讓連坐,立刻替新的人取一顆", (await w.mc.get()) !== null && w.calls === 2 && w.mc.state().retryInMs === 0); }
  // 第三輪複查 7:退讓綁在賺到它的那顆 token 上,要活過「憑證讀不到」——不然被 429 的同一輪裡 Keychain 讀失敗 / 登出搶在 await 後面,
  // 同一顆 token 回來就立刻再打一次
  { const w = world({ res: { status: 429, body: {} } }); const real = w.creds; let n = 0;
    w.mc = M.createMcpCode({ apiBase: "https://api.blave.org", now: () => w.now, getCreds: () => (++n === 3 ? null : w.creds), post: async () => { w.calls++; return w.res; } });
    t("被 429 的同一輪裡憑證讀不到(get 尾端那次讀到 null)→ 退讓還在", (await w.mc.get()) === null && w.calls === 1 && w.mc.state().retryInMs > 0 && n === 3);
    w.creds = real; t("同一顆 token 回來:仍在退讓期內,不會再打", (await w.mc.get()) === null && w.calls === 1);
    w.now += 31 * 60 * 1000; w.res = ok200(); t("退讓期過了才會再打", (await w.mc.get()) !== null && w.calls === 2); }
  { const w = world({ res: { status: 429, body: {} } }); await w.mc.get(); const real = w.creds;
    w.creds = null; await w.mc.get(); w.creds = real;
    t("被 429 之後有一輪沒登入(沒走 reset 的登出)、再登回同一個人:退讓還在,不會再打", (await w.mc.get()) === null && w.calls === 1 && w.mc.state().retryInMs > 0);
    w.creds = { token: "tokB", appSecret: "sec" }; w.res = ok200();
    t("中間隔了一輪沒登入,換成 B:B 不繼承 A 的退讓,立刻取", (await w.mc.get()) !== null && w.calls === 2 && w.mc.state().retryInMs === 0); }
  t("drop() 不碰退讓:退讓只認 token,不靠 owner 判「是不是同一個人」", /function drop\(\) \{ gen\+\+; held = null; owner = null; \}/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "mcpcode.js"), "utf8")));
  { const w = world(); let release; w.hang = new Promise((r) => { release = r; }); const p = w.mc.get(); w.creds = { token: "tokB", appSecret: "sec" }; release(); const r = await p;
    t("在途時換了人:回來的那份不是現在這個人的 → 丟掉、這一輪不掛", r === null && w.mc.state().has === false); }
  { const w = world(); let release; w.hang = new Promise((r) => { release = r; }); const p1 = w.mc.get(), p2 = w.mc.get(); release(); await Promise.all([p1, p2]); t("同時兩個人要 → 只打一次", w.calls === 1); }
  t("state() 不含碼本身", !JSON.stringify(world().mc.state()).includes("blv_"));

  // ── 單次設定檔 ──
  { const base = fs.mkdtempSync(path.join(os.tmpdir(), "blave-mcp-")), dir = path.join(base, "mcp"), f = M.writeConfig(dir, { accessCode: CODE, url: URL_OK });
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    t("設定檔:目錄 0700、檔 0600、隨機檔名、內容只有 blave 一個 http server + Bearer", (fs.statSync(dir).mode & 0o777) === 0o700 && (fs.statSync(f).mode & 0o777) === 0o600 && /^[0-9a-f]{32}\.json$/.test(path.basename(f))
      && JSON.stringify(j) === JSON.stringify({ mcpServers: { blave: { type: "http", url: URL_OK, headers: { Authorization: "Bearer " + CODE } } } }));
    M.removeConfig(f); t("回合結束:檔案不在了;再刪一次不拋", !fs.existsSync(f) && (M.removeConfig(f), true) && (M.removeConfig(null), true));
    const left = M.writeConfig(dir, { accessCode: CODE, url: URL_OK }); M.sweep(dir); t("啟動清掃:上次 crash 留下的檔被清掉;目錄不存在也不拋", !fs.existsSync(left) && (M.sweep(path.join(base, "nope")), true));
    fs.writeFileSync(path.join(base, "blocker"), "x"); t("寫不進去(目錄其實是檔案)→ null,不拋", M.writeConfig(path.join(base, "blocker"), { accessCode: CODE, url: URL_OK }) === null);
    fs.rmSync(base, { recursive: true, force: true }); }

  // ── main.js 接線(原文) ──
  const mainSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8"), main = mainSrc.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  const cut = (name) => { const i = mainSrc.indexOf("function " + name + "("); let d = 0; for (let k = mainSrc.indexOf("{", i); k < mainSrc.length; k++) { if (mainSrc[k] === "{") d++; else if (mainSrc[k] === "}" && --d === 0) return mainSrc.slice(i, k + 1); } };
  t("功能旗標預設關(先修 sshd 才上線)", /const CLOUD_HANDOFF = false;/.test(main));
  { const mk = (packaged, release, envv) => new Function("app", "require", "process", "CLOUD_HANDOFF", "return (" + cut("cloudHandoffOn") + ")()")({ isPackaged: packaged }, () => ({ blaveRelease: release }), { env: envv }, false);
    t("發佈版:設了 BLAVE_CLOUD_HANDOFF=1 也不開;開發版才認", mk(true, true, { BLAVE_CLOUD_HANDOFF: "1" }) === false && mk(true, true, {}) === false && mk(false, false, { BLAVE_CLOUD_HANDOFF: "1" }) === true && mk(true, false, { BLAVE_CLOUD_HANDOFF: "1" }) === true
      && mk(false, false, {}) === false && mk(false, false, { BLAVE_CLOUD_HANDOFF: "true" }) === false); }
  { const turnCreds = eval("(" + cut("turnCreds") + ")"), row = (k, s, inc, on) => { const r = turnCreds(k, s, inc, on); return (r.proxyToken ? "T" : "-") + (r.dataKey ? "D" : "-") + (r.mcp ? "M" : "-"); };
    t("turnCreds 第三欄 mcp:功能開 + 有登入,不看連的是誰;它開著不會讓帳號 token 進環境", row("claude", true, true, true) === "-DM" && row("codex", true, false, true) === "--M" && row("blave", true, true, true) === "TDM"
      && row("claude", false, false, true) === "---" && row("blave", false, true, true) === "---");
    t("功能關:不管怎樣都不掛(兩種狀態都釘住)", ["claude", "codex", "blave"].every((k) => turnCreds(k, true, true, false).mcp === false && turnCreds(k, true, true, undefined).mcp === false && turnCreds(k, true, true, "1").mcp === false)); }
  t("接線:旗標進 turnCreds;拿到碼才寫檔;Codex 先不掛(鍵名還沒對著實際安裝的 codex 驗過)", /turnCreds\(conn\.kind, signedIn, signedIn && await dataIncluded\(\), cloudHandoffOn\(\)\)/.test(main)
    && /if \(plan\.mcp && !useCodex\) \{ const mount = await mcpCode\(\)\.get\(\); if \(mount\) mcpFile = require\("\.\/mcpcode"\)\.writeConfig\(mcpDir\(\), mount\); \}/.test(main));
  t("argv 上只有路徑(--mcp-config=<檔>);環境變數裡沒有碼", /\.\.\.\(mcpFile \? \["--mcp-config=" \+ mcpFile\] : \[\]\)/.test(main) && !/accessCode/.test(main) && !/BLAVE_MCP/.test(main));
  t("設定檔在 userData 底下(workspace 以外);close / error / spawn 失敗 / stdin 失敗四條路都刪", /const mcpDir = \(\) => path\.join\(app\.getPath\("userData"\), "mcp"\);/.test(main) && (main.match(/removeConfig\(mcpFile\)/g) || []).length === 4);
  t("登出清記憶體裡的碼;開 app 清掃(只有拿到單一實例鎖的那一份做:第二份 app 不可以刪掉第一份正在跑那一輪的設定檔);打包清單帶 mcpcode.js", /if \(_mcp\) _mcp\.reset\(\);/.test(main) && /if \(app\.hasSingleInstanceLock\(\)\) require\("\.\/mcpcode"\)\.sweep\(mcpDir\(\)\);/.test(main) && /"mcpcode\.js"/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "electron-builder.config.js"), "utf8")));
  t("畫面只拿得到開關(feature-flags),拿不到碼;mcpcode.js 不 log、不 require electron", /handle\("feature-flags", \(\) => \(\{ cloudHandoff: cloudHandoffOn\(\) \}\), \{ cloudHandoff: false \}\);/.test(main)
    && !/console\.|require\("electron"\)/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "mcpcode.js"), "utf8")) && !/mcpCode|mcp_code/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "preload.js"), "utf8")));

  // ── runtime(原文):只有電腦版認、給 SDK 的是路徑不是 dict、strict 仍然開著 ──
  const rt = fs.readFileSync(path.join(__dirname, "..", "runtime", "agent_turn.py"), "utf8");
  t("runtime:--mcp-config 只在 LocalSink 認;options.mcp_servers 拿到的是 str 路徑(dict 會讓 SDK 把 Bearer 放上 argv);strict_mcp_config 仍為 True", /if not isinstance\(sink, LocalSink\) or not isinstance\(mcp_config, str\) or not os\.path\.isabs\(mcp_config\):\s*\n\s*return None/.test(rt)
    && /options\.strict_mcp_config = True/.test(rt) && /_mcp = local_mcp_config\(sink, mcp_config\)\s*\n\s*if _mcp:\s*\n\s*options\.mcp_servers = _mcp/.test(rt) && !/mcp_servers\s*=\s*\{/.test(rt));
  t("runtime:設定檔不可以在 workspace 裡面(agent 寫得到的地方)", /if real == ws or real\.startswith\(ws \+ os\.sep\) or not os\.path\.isfile\(real\):\s*\n\s*return None/.test(rt));
  t("runtime:掛了才多一段規則(不讀不印設定與碼、金鑰只放 tmp/cloud-handoff/);沒掛 system prompt 不變", /def mcp_rule\(mounted\):[\s\S]{0,200}if not mounted:\s*\n\s*return ""/.test(rt) && /Never read, print, copy or summarise the MCP configuration/.test(rt) && /tmp\/cloud-handoff\//.test(rt));
  console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
})();
