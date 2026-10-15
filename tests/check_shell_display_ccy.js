// 設定 › 顯示幣別(0.1.24,Wei 10-14;同網頁設定 modal 的 base_currency 下拉)。不起 Electron。
//   ① cloud.js:信封帶 base_currency_options(舊 api 沒這欄 = null);幣別或選項換了要推(summaryKey)
//   ② setBaseCurrency:只送信封明列的選項;寫完作廢在途的舊幣別回應、再重抓一次;沒登入 / 失敗不重抓
//   ③ 畫面:沒登入或沒選項整列不出;選項 ∪ 目前顯示幣、USD 排最前;改了記 display_ccy_set、叫輪詢
// 跑法:node tests/check_shell_display_ccy.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const SHELL = path.join(__dirname, "..", "shell"), R = path.join(SHELL, "renderer");
let red = 0; const ok = (name, c, info) => { console.log((c ? "PASS  " : "FAIL  ") + name + (c || !info ? "" : "\n      " + info)); if (!c) red++; };
const J = JSON.stringify;
const { interpret, createCloudHost, PREFS_ENDPOINT } = require(path.join(SHELL, "cloud.js"));
const env = (o) => ({ status: 200, body: Object.assign({ machine: { state: "running" }, portfolio: { config: {} }, portfolio_stale: false, currency: "USD", fx_rates: { USD: 1, TWD: 32 } }, o || {}) });

// ① 信封
ok("信封:base_currency_options 照 api 明列(大寫、只收幣別形狀);舊 api 沒這欄 = null",
  J(interpret(env({ base_currency_options: ["USD", "twd", "<x>", 3] })).base_currency_options) === J(["USD", "TWD"]) && interpret(env()).base_currency_options === null);
ok("summaryKey 帶顯示幣別與選項:改了偏好就推(合計、投入資金幣別、總權益跟著換)",
  /s\.currency, JSON\.stringify\(s\.base_currency_options \|\| null\)\]\.join\("\|"\)/.test(fs.readFileSync(path.join(SHELL, "cloud.js"), "utf8")));

// ② setBaseCurrency
(async () => {
  const creds = { token: "t", appSecret: "s", who: "u1" };
  let ccy = "USD", calls = [], gate = null, posted = false; const after = [];
  const post = async (url, body) => {
    calls.push([url.replace("https://x", ""), body.base_currency || null]);
    if (url.endsWith(PREFS_ENDPOINT)) { ccy = body.base_currency; posted = true; return { status: 200, body: { status: "ok" } }; }
    const mine = ccy; if (gate) await gate;   // 舊幣別那一份卡在路上
    return env({ currency: mine, base_currency_options: ["USD", "TWD"] });
  };
  const h = createCloudHost({ apiBase: "https://x", getCreds: () => creds, post, onChange: (sn) => { if (posted) after.push(sn.currency); }, now: () => Date.now(), setTimer: () => 0, clearTimer: () => {} });
  await h.refresh(true);
  ok("沒在選項上的幣別不送(BAD),不打 api", (await h.setBaseCurrency("JPY")).code === "BAD" && !calls.some((c) => c[0] === PREFS_ENDPOINT));
  // 在途的舊幣別回應:先讓一份狀態請求卡住,再改幣別
  let release; gate = new Promise((r) => { release = r; });
  const stale = h.refresh(true);
  const p = h.setBaseCurrency("TWD");
  await new Promise((r) => setTimeout(r, 10)); gate = null; release(); await stale;
  const res = await p;
  ok("寫偏好走 desktop 那一支(token + app_secret);成功後作廢在途的舊幣別回應、重抓一次:手上那份是 TWD",
    res.ok === true && calls.some((c) => c[0] === PREFS_ENDPOINT && c[1] === "TWD") && h.snapshot().currency === "TWD" && after.indexOf("USD") < 0, J({ res, snap: h.snapshot().currency, after }));
  const failH = createCloudHost({ apiBase: "https://x", getCreds: () => creds, post: async (u) => (u.endsWith(PREFS_ENDPOINT) ? { status: 500 } : env({ base_currency_options: ["USD", "TWD"] })), now: () => Date.now(), setTimer: () => 0, clearTimer: () => {} });
  await failH.refresh(true);
  const f = await failH.setBaseCurrency("TWD");
  const noLogin = createCloudHost({ apiBase: "https://x", getCreds: () => null, post: async () => env({ base_currency_options: ["USD", "TWD"] }), now: () => Date.now(), setTimer: () => 0, clearTimer: () => {} });
  ok("api 失敗 → FAIL;沒登入 → BAD/NO_LOGIN(信封沒有選項就不送)", f.ok === false && f.code === "FAIL" && (await noLogin.setBaseCurrency("TWD")).ok === false);

  // ③ 畫面(app.js 的 ccyOptions / ccyPaint / ccyPick)
  const app = fs.readFileSync(path.join(R, "app.js"), "utf8");
  const cut = (n) => { const i = app.indexOf("function " + n + "("); let d = 0; for (let k = app.indexOf("{", i); k < app.length; k++) { if (app[k] === "{") d++; else if (app[k] === "}" && --d === 0) return app.slice(i, k + 1); } throw new Error("no " + n); };
  const el = () => ({ hidden: false, dataset: {}, kids: [], disabled: false, value: "", textContent: "", appendChild(c) { this.kids.push(c); return c; }, focus() {} });
  const nodes = { "set-ccy-row": el(), "set-ccy": el(), "set-ccy-err": el(), "set-scrim": el() };
  const sent = [], ctx = vm.createContext({ $: (id) => nodes[id], document: { createElement: () => ({}) }, t: (k) => k, String, Array, Object,
    trackFeature: (n) => sent.push("feature:" + n), trPollSoon: () => sent.push("poll"), ENV: { cloudDirty: false },
    window: { blave: { cloudSetCcy: async (c) => { sent.push("set:" + c); return { ok: true, code: "OK" }; } } } });
  vm.runInContext("var hasToken = true; var TR_BAGS = { cloud: { st: null } };\n" + app.match(/^const CCY = [^\n]*/m)[0].replace(/^const /, "var ") + "\n" + ["ccyCloud", "ccyOptions", "ccyPaint", "ccyPick"].map((n) => (/async $/.test(app.slice(0, app.indexOf("function " + n + "("))) ? "async " : "") + cut(n)).join("\n"), ctx);
  const setCloud = (c) => vm.runInContext("TR_BAGS.cloud.st = " + J({ cloud: c }), ctx);
  setCloud({ code: "OK", currency: "USDT", base_currency_options: ["TWD", "USD"] }); vm.runInContext("ccyPaint()", ctx);
  ok("有選項、有登入:整列出現;選項 = api 清單 ∪ 目前顯示幣(USDT),USD 排最前;選中目前那個",
    nodes["set-ccy-row"].hidden === false && J(nodes["set-ccy"].kids.map((o) => o.value)) === J(["USD", "TWD", "USDT"]) && nodes["set-ccy"].value === "USDT", J(nodes["set-ccy"].kids.map((o) => o.value)));
  setCloud({ code: "OK", currency: "USD", base_currency_options: null }); vm.runInContext("ccyPaint()", ctx);
  const oldApi = nodes["set-ccy-row"].hidden;
  setCloud({ code: "OK", currency: "USD", base_currency_options: ["USD", "TWD"] }); vm.runInContext("hasToken = false; ccyPaint()", ctx);
  ok("舊 api(沒有 base_currency_options)、沒登入:整列不出", oldApi === true && nodes["set-ccy-row"].hidden === true);
  vm.runInContext("hasToken = true; ccyPaint()", ctx);
  await vm.runInContext("ccyPick('TWD')", ctx);
  ok("改成 TWD:送一次、記 display_ccy_set、叫輪詢(ENV.cloudDirty)把新的那份信封拿進來;新信封到之前下拉先停在 TWD",
    J(sent) === J(["set:TWD", "feature:display_ccy_set", "poll"]) && ctx.ENV.cloudDirty === true && nodes["set-ccy"].value === "TWD", J(sent));
  const html = fs.readFileSync(path.join(R, "index.html"), "utf8"), S = fs.readFileSync(path.join(R, "strings.js"), "utf8"), tel = fs.readFileSync(path.join(SHELL, "telemetry.js"), "utf8");
  ok("位置:設定 › 一般,語言那一列底下;字串兩語;埋點 display_ccy_set 在白名單",
    html.indexOf('id="set-lang"') > 0 && html.indexOf('id="set-ccy-row"') > html.indexOf('id="set-lang"') && html.indexOf('id="set-ccy-row"') < html.indexOf('id="set-up"')
    && S.includes('"set.ccy": "顯示幣別"') && S.includes('"set.ccy": "Display currency"') && S.includes('"set.ccyFail": "切換失敗，稍後再試。"') && /"display_ccy_set"[\],]/.test(tel));
  console.log(red ? `\n${red} 項沒過` : "\nALL PASS"); process.exit(red ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
