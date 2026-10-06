// 自帶 API 金鑰的介面與 IPC(0.1.16;shell/main.js llmKey*、shell/llmrelay.js verifyKey、shell/preload.js、renderer/apikey.js)。
//   ① IPC 沒有讀出金鑰的路:preload 只有 set / test / remove / cancel,只有 set 帶值;每一支回應(含 detect 帶回的 apikey 欄位)都沒有金鑰
//   ② set = 先打供應商驗、驗不過一個 byte 都不落地;test 重驗已存那把;remove 刪檔並清掉 apikey 連結
//   ③ verifyKey 狀態碼 → 代號(mock 供應商,不連外網)、可取消
//   ④ 型錄:DeepSeek 兩個型號、思考深度 low / high / max(預設 high、沒有關閉那一格)
//   ⑤ 每輪上限:轉送口在回 429 之前發 cap 事件,main.js 轉成 llm_cap;畫面把那一輪的 429 認成「這一輪用量到上限」
//   ⑥ 回合失敗分類、驗證錯誤句、設定頁的列、i18n
// 不開視窗、不用真金鑰。跑法:node tests/check_shell_apikey_ui.js
const fs = require("fs"), path = require("path"), os = require("os"), http = require("http");
const ROOT = path.join(__dirname, ".."), SH = path.join(ROOT, "shell");
const relayMod = require(path.join(SH, "llmrelay.js"));
const main = fs.readFileSync(path.join(SH, "main.js"), "utf8");
const preload = fs.readFileSync(path.join(SH, "preload.js"), "utf8");
const akSrc = fs.readFileSync(path.join(SH, "renderer", "apikey.js"), "utf8");
const app = fs.readFileSync(path.join(SH, "renderer", "app.js"), "utf8");
let red = 0; const t = (n, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) red++; };
const cut = (src, from, to) => { const a = src.indexOf(from), b = src.indexOf(to, a + from.length); if (a < 0 || b < 0) throw new Error("找不到 " + from); return src.slice(a, b); };
// 假金鑰每次現做(不寫死字面:掃描 hook 會把它當外洩)
const SECRET = "sk-UITEST-" + require("crypto").randomBytes(8).toString("hex"), WRONG = "sk-WRONG-" + require("crypto").randomBytes(6).toString("hex");

function mockProvider(status) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    const b = []; req.on("data", (c) => b.push(c));
    req.on("end", () => {
      hits.push({ path: req.url, key: req.headers["x-api-key"], body: Buffer.concat(b).toString() });
      if (status === "hang") return;   // 不回:測取消
      res.writeHead(status(req.headers["x-api-key"]), { "content-type": "application/json" });
      res.end('{"type":"error","error":{"message":"echo ' + req.headers["x-api-key"] + '"}}');   // 錯誤內文夾著金鑰:不能往回傳
    });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ url: `http://127.0.0.1:${srv.address().port}`, hits, close: () => { srv.close(); srv.closeAllConnections(); } })));
}
const presetsFor = (url) => ({ deepseek: { ...relayMod.PRESETS.deepseek, origin: url } });

(async () => {
  // ── ① preload:apikey 那幾支 ──
  const chans = [...preload.matchAll(/ipcRenderer\.invoke\("(apikey-[a-z-]+)"/g)].map((m) => m[1]);
  t("preload 的 apikey channel 只有 set / test / remove / cancel", JSON.stringify(chans.sort()) === JSON.stringify(["apikey-cancel", "apikey-remove", "apikey-set", "apikey-test"]));
  const lines = preload.split("\n").filter((l) => /apikey-/.test(l));
  t("只有 apikey-set 帶參數;其餘三支什麼都不帶", lines.filter((l) => /invoke\("apikey-(test|remove|cancel)"\)/.test(l)).length === 3 && lines.filter((l) => /invoke\("apikey-set", \{/.test(l)).length === 1);
  const handles = [...main.matchAll(/handle\("(apikey-[a-z-]+)"/g)].map((m) => m[1]).sort();
  t("main.js 只註冊這四支(都走 handle():只收自家頁面)", JSON.stringify(handles) === JSON.stringify(["apikey-cancel", "apikey-remove", "apikey-set", "apikey-test"]) && !/ipcMain\.handle\("apikey-/.test(main));
  t("沒有任何 channel 名字像讀出(get / load / read / reveal)", !/invoke\("apikey-(get|load|read|reveal|show)/.test(preload) && !/"(get|load|read)-?(llm|api)-?key/.test(preload));

  // ── ② 主行程的 set / test / remove(切 main.js 原文,假 safeStorage / userData / 遙測) ──
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apikey-ui-"));
  const mock = await mockProvider((k) => (k === SECRET ? 200 : 401));
  const P = presetsFor(mock.url);
  const tracked = [], conn = { saved: [], cleared: 0, kind: null, fail: false };
  const env = {
    fs, path, safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from("ENC" + Buffer.from(s).toString("base64")), decryptString: (b) => Buffer.from(String(b).slice(3), "base64").toString() },
    app: { getPath: () => dir }, tm: () => ({ track: (e, p) => tracked.push(e + ":" + (p && p.kind)) }),
    require: (m) => (m === "./llmrelay" ? { PRESETS: P, verifyKey: (pr, k, o) => relayMod.verifyKey(pr, k, o, P) } : require(m)),
    saveConnection: async (c) => { if (conn.fail) return false; conn.saved.push(c.kind); conn.kind = c.kind; return true; },
    loadConnection: () => (conn.kind ? { kind: conn.kind } : null), clearConnection: () => { conn.cleared++; conn.kind = null; },
  };
  const block = cut(main, "const llmKeyPath =", "function clearDataKey");
  const api = new Function(...Object.keys(env), block + "; return { saveLlmKey, loadLlmKey, llmKeyInfo, llmKeySet, llmKeyTest, llmKeyRemove, cancel: () => llmVerify && llmVerify.abort() };")(...Object.values(env));
  const file = path.join(dir, "apikey.bin");
  const noKey = (o) => !JSON.stringify(o).includes(SECRET) && !JSON.stringify(o).includes("WRONG");
  const bad = await api.llmKeySet({ preset: "deepseek", key: WRONG, connect: true });
  t("set 驗不過(401):回 KEY + 401、什麼都沒存、沒有連結、記 connect_failed apikey_key", bad.ok === false && bad.code === "KEY" && bad.status === 401 && !fs.existsSync(file) && conn.saved.length === 0 && tracked.includes("connect_failed:apikey_key"));
  t("回應裡沒有金鑰(供應商錯誤內文夾著金鑰也不回傳)", noKey(bad) && Object.keys(bad).sort().join() === "code,ok,status");
  t("驗證請求打的是內建表的路徑、帶的是使用者的金鑰、最小請求", mock.hits[0].path === "/anthropic/v1/messages" && mock.hits[0].key === WRONG && JSON.parse(mock.hits[0].body).max_tokens === 1 && !("thinking" in JSON.parse(mock.hits[0].body)));
  t("形狀不對(太短、含空白、未知供應商)不打網路就回 KEY", (await api.llmKeySet({ preset: "deepseek", key: "short" })).code === "KEY" && (await api.llmKeySet({ preset: "deepseek", key: "sk with space x" })).code === "KEY"
    && (await api.llmKeySet({ preset: "evil", key: SECRET })).code === "KEY" && mock.hits.length === 1);
  const good = await api.llmKeySet({ preset: "deepseek", key: SECRET, connect: true });
  t("set 驗過:存檔(密文帶型別標記)、connect:true 時連結存成 apikey", good.ok === true && good.code === "OK" && fs.existsSync(file) && conn.saved.join() === "apikey" && api.loadLlmKey().key === SECRET && noKey(good));
  conn.fail = true;
  const cf = await api.llmKeySet({ preset: "deepseek", key: SECRET, connect: true });
  conn.fail = false;
  t("金鑰驗過、存了,但切換連結失敗 → CONN(不是 OK + 200 讓畫面拼成「回了錯誤 (200)」)", cf.ok === false && cf.code === "CONN" && cf.status === 0 && api.loadLlmKey().key === SECRET && noKey(cf));
  const info = api.llmKeyInfo();
  t("畫面拿得到的(detect 的 apikey 欄位)只有存了哪一家與上架清單,沒有金鑰", info.saved === "deepseek" && info.presets.length === 1 && info.presets[0].name === "DeepSeek" && /^https:\/\//.test(relayMod.PRESETS.deepseek.keysUrl) && noKey(info) && !("key" in info));
  t("detect-agents 的回應掛的是 llmKeyInfo()(不是 loadLlmKey)", /handle\("detect-agents", \(\) => detectAgents\(\)\.then\(\(d\) => \(\{ \.\.\.d, apikey: llmKeyInfo\(\) \}\)\)\)/.test(main));
  const tst = await api.llmKeyTest();
  t("test 重驗已存那把(renderer 不給值)", tst.ok === true && mock.hits[mock.hits.length - 1].key === SECRET && noKey(tst));
  { // 列舉每一個 loadLlmKey() 呼叫點所在的函式:明文金鑰只該出現在這幾處;其中交給畫面的兩支(llmKeyInfo / apikeyModels)根本不碰 .key
    const owners = [...main.matchAll(/(function )?loadLlmKey\(\)/g)].filter((m) => !m[1]).map((m) => { const f = [...main.slice(0, m.index).matchAll(/(?:async )?function (\w+)\(/g)].pop(); return f ? f[1] : "?"; });
    const body = (n) => cut(main, "function " + n + "(", "\n}\n");
    t("loadLlmKey 的呼叫點只有 saveConnection / llmKeyInfo / llmKeyTest / apikeyModels / runTurn / createWindow(load-connection 只看解不解得開)", JSON.stringify(owners.sort()) === JSON.stringify(["apikeyModels", "createWindow", "llmKeyInfo", "llmKeyTest", "runTurn", "saveConnection"]) || (console.log("      呼叫點:", owners.join()), false));
    t("交給畫面的 llmKeyInfo / apikeyModels 不碰 .key", !/\.key\b/.test(body("llmKeyInfo")) && !/\bk\.key\b/.test(body("apikeyModels"))); }
  { const keep = fs.readFileSync(file); fs.writeFileSync(file, "ENCgarbage");
    t("金鑰檔在但解不開(被換掉、換了機器)→ loadLlmKey 回 null", api.loadLlmKey() === null); fs.writeFileSync(file, keep); }
  t("load-connection:連的是 apikey 但金鑰解不開(不只是檔不在)→ null(回連結畫面);runTurn 不用這道,照原紀錄讀金鑰、讀不到拋 APIKEY_MISSING(不換引擎)",
    /handle\("load-connection", \(\) => \{ const c = loadConnection\(\); return c && c\.kind === "apikey" && !loadLlmKey\(\) \? null : c; \}\);/.test(main)
    && /const conn = loadConnection\(\) \|\| \{\};/.test(cut(main, "async function runTurn", "\n}\n")) && /if \(conn\.kind === "apikey" && !llmKey\) throw new Error\("APIKEY_MISSING"\);/.test(main));
  t("saveConnection:kind apikey 沒有驗過的金鑰就不存", /if \(kind === "apikey" && !loadLlmKey\(\)\) return false;/.test(cut(main, "async function saveConnection", "\n}\n")));
  api.llmKeyRemove();
  t("remove:刪檔;目前連的是 apikey 就一起清掉連結", !fs.existsSync(file) && conn.cleared === 1 && (await api.llmKeyTest()).code === "MISSING");
  mock.close();

  // ── ③ verifyKey 狀態碼對應、網路、取消、同時只驗一把 ──
  for (const [st, code] of [[402, "CREDIT"], [429, "RATE"], [403, "KEY"], [500, "OTHER"]]) {
    const m = await mockProvider(() => st);
    const r = await relayMod.verifyKey("deepseek", SECRET, {}, presetsFor(m.url));
    t(`verifyKey ${st} → ${code}`, r.code === code && r.status === st && noKey(r));
    m.close();
  }
  t("verifyKey 連不到 → NET", (await relayMod.verifyKey("deepseek", SECRET, {}, presetsFor("http://127.0.0.1:1"))).code === "NET");
  { const m = await mockProvider("hang"), ac = new AbortController();
    const p = relayMod.verifyKey("deepseek", SECRET, { signal: ac.signal }, presetsFor(m.url));
    setTimeout(() => ac.abort(), 100);
    t("取消等待:中止那一個請求 → CANCELED", (await p).code === "CANCELED");
    const p2 = relayMod.verifyKey("deepseek", SECRET, { timeoutMs: 200 }, presetsFor(m.url));
    t("掛住的供應商逾時 → NET", (await p2).code === "NET");
    m.close(); }
  { const m = await mockProvider("hang"); P.deepseek.origin = m.url;
    const first = api.llmKeySet({ preset: "deepseek", key: SECRET });
    const second = await api.llmKeySet({ preset: "deepseek", key: SECRET });
    api.cancel();
    t("同時只驗一把:第二下 BUSY;取消後第一下回 CANCELED、沒存、不記失敗", second.code === "BUSY" && (await first).code === "CANCELED" && !fs.existsSync(file) && !tracked.some((x) => /apikey_other/.test(x)));
    m.close(); }

  // ── ④ 型錄 ──
  { const fn = cut(main, "function apikeyModels()", "\n}\n") + "\n}";
    const run = (k) => new Function("loadLlmKey", "require", "DEEPSEEK_EFFORTS", fn + "; return apikeyModels();")(() => k, () => relayMod, ["low", "high", "max"]);
    const o = run({ preset: "deepseek", key: SECRET });
    t("型錄:DeepSeek V4 Pro / Flash,預設 Pro", o.models.map((m) => m.id).join() === "deepseek-v4-pro,deepseek-v4-flash" && o.defaultModel === "deepseek-v4-pro" && o.models[0].name === "DeepSeek V4 Pro" && o.provider === "DeepSeek");
    t("思考深度 low / high / max、預設 high,沒有關閉(none / off / disabled)那一格", o.models.every((m) => m.efforts.join() === "low,high,max" && m.defaultEffort === "high"));
    t("沒存金鑰:型錄空的(選單不畫)", run(null).models.length === 0);
    t("modelOptions(\"apikey\") 走這一份、不打網路;回應沒有金鑰", /if \(kind === "apikey"\) return apikeyModels\(\);/.test(main) && noKey(o)); }

  // ── ⑤ 每輪上限:cap 事件先於 429 回應 ──
  { const m = await mockProvider(() => 200), order = [];
    const relay = await relayMod.startRelay({ preset: "deepseek", key: SECRET, limits: { maxRequests: 1 }, onEvent: (e) => { if (e.type === "cap") order.push("cap"); } }, presetsFor(m.url));
    const hit = () => new Promise((r) => { const q = http.request({ host: "127.0.0.1", port: relay.port, method: "POST", path: "/v1/messages", headers: { "x-api-key": relay.token, "content-type": "application/json" } }, (res) => { res.resume(); res.on("end", () => { order.push(String(res.statusCode)); r(); }); }); q.end('{"model":"deepseek-v4-pro","max_tokens":5,"messages":[]}'); });
    await hit(); await hit();
    t("上限到:cap 事件在 429 回到 CLI 之前就發了", order.join() === "200,cap,429");
    relay.stop(); m.close(); }
  t("main.js 把 cap 轉成 turn-event llm_cap(不靠比對 429 的字)", /ev\.type === "cap"[^\n]*webContents\.send\("turn-event", \{ type: "llm_cap" \}\)/.test(main));
  t("畫面:llm_cap 記進 turnCap、每一輪送出時歸零", /c\.type === "llm_cap"\) \{\s*turnCap = true;/.test(app) && /turnFaulted = false; turnCap = false;/.test(app));

  // ── ⑥ 回合失敗分類(renderer/apikey.js akFault / akErrText) ──
  const tt = (k, v) => k + (v ? JSON.stringify(v) : "");
  let resent = 0;
  const R = new Function("t", "MP", "resendLast", "setOpen", "setCat", "mpOpen", "akOpen_", akSrc.replace(/^const /gm, "var ") + "; return { akFault, akErrText };")(tt, { provider: "DeepSeek" }, () => { resent++; }, () => Promise.resolve(), () => {}, () => {});
  const cap = R.akFault('API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"turn usage limit reached"}}', true);
  cap.act();
  t("這一輪收過 llm_cap 的 429 → 「這一輪用量到上限」卡(可再送一次:走 app.js 的 resendLast,純附件那句與它帶的檔也重送)", cap && cap.cap === true && cap.text === "ak.f.cap" && cap.label === "fault.resend" && resent === 1);
  t("沒收過 llm_cap 的 429 → 供應商限流", R.akFault("API Error: 429 x", false).text.startsWith("ak.f.rate"));
  t("401 / 403 → 金鑰被拒,鈕「修改金鑰」", R.akFault("API Error: 401 x", false).text.startsWith("ak.f.key") && R.akFault("Failed to authenticate. API Error: 403 x", false).label === "ak.f.keyBtn");
  const f402 = R.akFault("API Error: 402 x", false);
  t("402 → 供應商餘額不足的一般卡(不是 Blave 的 creditFlow),第二顆鈕「切換 AI」", !f402.flow && f402.text.startsWith("ak.f.credit") && f402.second && f402.second.label === "fault.limitBtn");
  t("400 → 相容性句、鈕「選別的模型」;連不到 / 502 → 網路句", R.akFault("API Error: 400 x", false).label === "fault.noModelBtn" && R.akFault("API Error: Connection error.", false).text.startsWith("ak.f.net") && R.akFault("API Error: 502 x", false).text.startsWith("ak.f.net"));
  t("回覆裡提到 API Error(沒錨在開頭)不算", R.akFault("你的程式回 API Error: 401", false) === null && R.akFault("一般回覆", true) === null);
  { const cf = cut(app, "function classifyFault(text)", "\nfunction localAuthFault");
    const iAk = cf.indexOf('cur === "apikey"'), iLocal = cf.indexOf("/^Not logged in"), iCredit = cf.indexOf('return { flow: "credit" }'), iAuth = cf.indexOf("localAuthFault(cur)");
    t("classifyFault 的 apikey 分支排在 CLI 登入、Blave 402、localAuthFault 之前", iAk > 0 && iAk < iLocal && iAk < iCredit && iAk < iAuth); }
  t("驗證錯誤句:401 帶狀態碼、形狀不對另一句、402 / 429 / 網路 / 加密不可用各一句、取消與 BUSY 不出句", R.akErrText({ code: "KEY", status: 401 }, "DeepSeek") === 'ak.e.key{"p":"DeepSeek","s":"401"}' && R.akErrText({ code: "KEY", status: 0 }, "DeepSeek") === "ak.e.shape"
    && R.akErrText({ code: "CREDIT", status: 402 }, "D").startsWith("ak.e.credit") && R.akErrText({ code: "RATE" }, "D").startsWith("ak.e.rate") && R.akErrText({ code: "NET" }, "D").startsWith("ak.e.net")
    && R.akErrText({ code: "NO_SEAL" }, "D") === 'ak.e.seal{"p":"D"}' && R.akErrText({ code: "CONN", status: 0 }, "D") === 'ak.e.conn{"p":"D"}' && R.akErrText({ code: "OTHER", status: 500 }, "D").startsWith("ak.e.other") && R.akErrText({ code: "CANCELED" }) === null && R.akErrText({ code: "BUSY" }) === null && R.akErrText({ ok: true }) === null);
  t("沒有狀態碼(IPC 沒回 / status 0)→ ak.e.unknown;有狀態碼才用 ak.e.other", R.akErrText(null, "D") === 'ak.e.unknown{"p":"D"}' && R.akErrText({ code: "OTHER", status: 0 }, "D") === 'ak.e.unknown{"p":"D"}' && R.akErrText({ code: "OTHER", status: 503 }, "D") === 'ak.e.other{"p":"D","s":"503"}');
  t("上限卡只有一顆「再送一次」", !cap.second && cap.label === "fault.resend");
  { // 只有一家供應商:「供應商」是靜態文字,不畫 select;兩家以上才畫(假 DOM 跑 akFormNode)
    const mk = (tag) => { const n = { tag, cls: "", children: [], attrs: {}, style: {}, set className(v) { this.cls = v; }, get className() { return this.cls; }, set textContent(v) { this._t = v; this.children = []; }, get textContent() { return this._t || ""; },
      append(...c) { this.children.push(...c); }, appendChild(c) { this.children.push(c); }, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener() {}, querySelectorAll: () => [], get firstChild() { return this.children[0]; } }; return n; };
    const doc = { createElement: mk, createTextNode: (x) => ({ tag: "#text", _t: x, children: [] }) };
    const all = (n, out = []) => { if (n && n.tag) { out.push(n); (n.children || []).forEach((c) => all(c, out)); } return out; };
    const build = (presets) => new Function("document", "window", "t", "cur", akSrc.replace(/^const /gm, "var ") + "; AK.info = { saved: null, presets: P }; return akFormNode({ where: 'cn', preset: P[0].id, replacing: false, el: {} });".replace("P", "arguments[4]").replace("P[0]", "arguments[4][0]"))(doc, { blave: { platform: "darwin" } }, (k) => k, null, presets);
    const one = all(build([{ id: "deepseek", name: "DeepSeek", keysUrl: "https://x" }]));
    const two = all(build([{ id: "deepseek", name: "DeepSeek", keysUrl: "https://x" }, { id: "kimi", name: "Kimi", keysUrl: "https://y" }]));
    t("一家:沒有 select、靜態文字是 DeepSeek;兩家:有 select", !one.some((n) => n.tag === "select") && one.some((n) => n.cls === "ak-prov" && n._t === "DeepSeek") && two.some((n) => n.tag === "select")); }
  t("畫面不保存金鑰:apikey.js 只在 akSubmit 把輸入框的值交給 apikeySet;收表單先清空輸入框", /window\.blave\.apikeySet\(\{ preset: f\.preset, key: input\.value, connect: f\.where === "cn" \}\)/.test(akSrc)
    && !/AK\.[\w.]+\s*=\s*[^;\n]*\.value/.test(akSrc) && /if \(f\.el\.input\) f\.el\.input\.value = "";\s*AK\.form = null;/.test(akSrc) && /akClear\(\)/.test(cut(app, "function setClose()", "\n}")));

  // ── 設定 › 模型接入的列(mdlOptions 純邏輯) ──
  { const mdl = cut(app, "const MDL = {", "/* ── 設定 › 模型接入 的純邏輯到此");
    const mdlOptions = new Function(mdl.replace(/^const /gm, "var ") + "; return mdlOptions;")();
    const D = { claude: { installed: true, loggedIn: true }, codex: { installed: false } }, PR = [{ id: "deepseek", name: "DeepSeek", keysUrl: "https://x" }];
    const none = mdlOptions(D, "claude", true, null, { saved: null, presets: PR })[3];
    t("沒存:第四列「API 金鑰」+ 供應商清單 + 「設定」", none.kind === "apikey" && none.nameKey === "ak.row" && none.names.join() === "DeepSeek" && none.act === "ak.setup" && !none.isCur && !none.edit);
    const sv = mdlOptions(D, "claude", true, null, { saved: "deepseek", presets: PR })[3];
    t("存過:名字換成 DeepSeek、副行「你的 API 金鑰」、「使用」+「修改」", sv.name === "DeepSeek" && sv.desc === "ak.yours" && sv.act === "cn.use" && sv.edit === true);
    const on = mdlOptions(D, "apikey", true, null, { saved: "deepseek", presets: PR })[3];
    t("正在用:is-cur、沒有動作鈕(列尾「使用中」)、仍有「修改」", on.isCur && on.act === null && on.edit);
    t("沒有上架的供應商就不出這一列(不做 fake door)", mdlOptions(D, "claude", true, null, { saved: null, presets: [] }).length === 3 && mdlOptions(D, "claude", true).length === 3); }

  // ── i18n ──
  const po = Object.fromEntries(["zh", "en"].map((l) => { const m = {}; for (const x of fs.readFileSync(path.join(SH, "i18n", l + ".po"), "utf8").matchAll(/msgid "([^"]+)"\nmsgstr "((?:[^"\\]|\\.)*)"/g)) m[x[1]] = x[2]; return [l, m]; }));
  const used = new Set([...akSrc.matchAll(/\bt\("([^"]+)"/g)].map((m) => m[1]).concat([...akSrc.matchAll(/"(ak\.[\w.]+)"/g)].map((m) => m[1]), ["ak.bill", "APIKEY_MISSING", "ak.row", "ak.sep", "ak.edit"]));
  const missing = [...used].filter((k) => !(k in po.zh) || !(k in po.en));
  t("apikey.js / app.js 用到的字兩語都有" + (missing.length ? ":缺 " + missing : ""), missing.length === 0);
  const akKeys = Object.keys(po.zh).filter((k) => k.startsWith("ak.") || k === "APIKEY_MISSING");
  t("介面不提 Anthropic / Claude Code(兩語)", akKeys.every((k) => !/anthropic|claude/i.test(po.zh[k] + po.en[k])) && !/anthropic|claude/i.test(po.zh["cn.local.label"] + po.en["cn.local.label"]));
  t("Windows 那句不講「agent 讀不到」(同一個系統用戶解得開 DPAPI)", !/讀不到/.test(po.zh["ak.ruleWin"]) && !/can't read/.test(po.en["ak.ruleWin"]) && /加密存在這台電腦/.test(po.zh["ak.ruleWin"]) && /讀不到/.test(po.zh["ak.ruleMac"]));
  t("只開按量計費:表單有一句講清楚 Coding Plan 類不能用", /按量計費/.test(po.zh["ak.payg"]) && /Coding Plan/.test(po.zh["ak.payg"]) && /ak\.payg/.test(akSrc));
  t("組名改成「用你自己的 AI」(連結畫面與設定共用)", po.zh["cn.local.label"] === "用你自己的 AI" && po.en["cn.local.label"] === "Use your own AI");
  { const W = { "ak.payg": ["只能用按量計費的 API 金鑰。Coding Plan 這類月費方案的金鑰不能用。", "Pay-as-you-go API keys only. Keys from monthly plans, such as a Coding Plan, won't work."],
      "ak.e.shape": ["這不像完整的 API 金鑰：可能少貼了一段，或夾了空格、換行。整串重新複製後再貼一次。什麼都沒有改變。", "That doesn't look like a complete API key. Part of it may be missing, or it may contain a space or line break. Copy the whole key again and paste it. Nothing was changed."],
      "ak.e.other": ["{p} 回了錯誤（{s}）。等一下再試一次。什麼都沒有改變。", "{p} returned an error ({s}). Try again in a moment. Nothing was changed."],
      "ak.e.unknown": ["沒能跟 {p} 確認這把金鑰。等一下再試一次。什麼都沒有改變。", "Couldn't verify this key with {p}. Try again in a moment. Nothing was changed."],
      "ak.e.seal": ["這台電腦現在沒辦法把金鑰加密保存，所以沒有存。重新打開 Blave 再試一次。", "This computer can't store the key encrypted right now, so it wasn't saved. Restart Blave and try again."],
      "ak.f.cap": ["這一輪碰到 Blave 設的每輪用量上限，先停在這裡，免得一輪花太多。要繼續就再送一次。", "This turn hit Blave's per-turn usage limit and stopped here, so a single turn can't run up a large bill. Send again to continue."],
      "ak.f.keyBtn": ["修改金鑰", "Edit Key"] };
    const bad = Object.keys(W).filter((k) => po.zh[k] !== W[k][0] || po.en[k].replace(/\\"/g, '"') !== W[k][1]);
    t("設計師稽核定稿的字逐字相同" + (bad.length ? ":不同 " + bad : ""), bad.length === 0); }
  t("中文句子用全形標點(括號、逗號、句號)", akKeys.every((k) => !/[(),]/.test(po.zh[k].replace(/\{[ps]\}/g, ""))));

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(red ? red + " FAIL" : "ALL PASS");
  process.exit(red ? 1 : 0);
})();
