// 0.1.35 本機 AI 登入失敗補埋點(spec desktop-auth-fail-telemetry):auth_fail 的來源／狀態判法、兩條送法、cli_auth 的 how 對照。
// renderer/app.js 的純函式與回合結束那段原文切出來配假的 detectAgents／trackEvent 跑;不起 Electron、不跑真的 CLI。
// 跑法:node tests/check_shell_auth_fail.js
const fs = require("fs"), path = require("path"), os = require("os");
const SHELL = path.join(__dirname, "..", "shell");
const { EVENTS, FROM_RENDERER, createTelemetry, cliAuthHow } = require(path.join(SHELL, "telemetry.js"));
const app = fs.readFileSync(path.join(SHELL, "renderer", "app.js"), "utf8");
let red = 0; const t = (n, ok, info) => { console.log((ok ? "PASS  " : "FAIL  ") + n + (ok || info === undefined ? "" : "  " + JSON.stringify(info))); if (!ok) red++; };
const fnSrc = (name) => { const i = app.indexOf("function " + name + "("); if (i < 0) throw new Error("找不到 " + name); let d = 0;
  for (let k = app.indexOf("{", i); k < app.length; k++) { if (app[k] === "{") d++; else if (app[k] === "}" && --d === 0) return app.slice(i, k + 1); } throw new Error(name); };
const whySrc = (app.match(/^const whyState = .*$/m) || [])[0];
if (!whySrc) { console.log("FAIL  找不到 whyState"); process.exit(1); }
const WHY = EVENTS.auth_fail.why;

// 純函式與回合結束那段放進同一個 with(ctx):cur／trackEvent／window 都是 ctx 上的,測試可以中途換 cur
const tail = (() => { const a = app.indexOf("  const reason = !stopped && (faulted || turnFail)"), b = app.indexOf("turnFail = null; turnFailSrc = null;", a);
  if (a < 0 || b < 0) throw new Error("找不到回合結束送 turn_failed 那段"); return app.slice(a, b) + "turnFail = null; turnFailSrc = null;"; })();
const mk = (ctx) => new Function("ctx", "with (ctx) { " + whySrc + "\n" + ["authFailSrc", "turnReasonOf", "authFailWhy", "cliAuthSend", "authFailProbe"].map(fnSrc).join("\n")
  + "\nreturn { authFailSrc, turnReasonOf, authFailWhy, authFailProbe, turnEnd: (r, stopped, faulted, d) => { " + tail + " } }; }")(ctx);
const quiet = mk({ trackEvent: () => {}, window: { blave: {} }, turnFail: null, turnFailSrc: null, cur: "claude" });

// ── 來源 ──
const SRC = [["Not logged in · Please run /login", "nologin"], ["API Error: 401 {\"type\":\"error\"}", "401"], ["Failed to authenticate. API Error: 403 forbidden", "403"],
  ["Failed to authenticate. API Error: 401 x", "401"], ["好的,我來跑回測。", null], ["你的交易所回 API Error: 401,要重設金鑰", null], ["API Error: 402 {}", null], ["API Error: 4010", null], ["", null], [undefined, null]];
t("authFailSrc:沒登入那句 → nologin、開頭的 API Error 401／403(可帶 Failed to authenticate.)→ 401／403;一般回覆、不在開頭、402、其他 → null",
  SRC.every(([x, want]) => quiet.authFailSrc(x) === want), SRC.map(([x]) => quiet.authFailSrc(x)));
t("…regex 跟 classifyFault 同一組(沒登入那句、API Error 錨在開頭)", fnSrc("classifyFault").includes("/^Not logged in\\b|Please run \\/login/") && fnSrc("authFailSrc").includes("/^Not logged in\\b|Please run \\/login/")
  && fnSrc("classifyFault").includes("/^(?:Failed to authenticate\\. )?API Error: (40[123])\\b/") && fnSrc("authFailSrc").includes("/^(?:Failed to authenticate\\. )?API Error: (40[13])\\b/"));

// ── 狀態 ──
const det = (x) => ({ claude: { installed: true, loggedIn: false, authOutside: false, why: null, ...x }, codex: { installed: true, loggedIn: false, authOutside: false, why: null } });
const ST = [[det({ loggedIn: true }), "in"], [det({ authOutside: true }), "out"], [det({}), "no"], [null, "unk"], [det({ why: "claude_timeout" }), "unk"], [det({ why: "claude_cantrun" }), "unk"],
  [{ codex: {} }, "unk"], [det({ loggedIn: true, authOutside: true }), "in"]];
t("authFailWhy 狀態段:已登入 → in;沒登入且 authOutside 真／假 → out／no;丟例外(null)、逾時、跑不起來、結果裡沒有這個引擎 → unk",
  ST.every(([d, want]) => quiet.authFailWhy("claude", "nologin", d) === "c_nologin_" + want), ST.map(([d]) => quiet.authFailWhy("claude", "nologin", d)));
t("…引擎前綴 c／x;沒有來源或不是本機 CLI 的引擎 → null", quiet.authFailWhy("codex", "probe", det({})) === "x_probe_no" && quiet.authFailWhy("claude", null, det({})) === null
  && quiet.authFailWhy("blave", "401", det({})) === null && quiet.authFailWhy("apikey", "401", det({})) === null);
// 走得到的組合全在白名單上,白名單上每個值都走得到(列舉,不是抽樣):classifyFault 那條只有 Claude(Codex 失敗只走 error chunk),
// 重問那條判成 loggedOut 的前提是 installed && !loggedIn && !whyState,所以只會是 out／no
{ const reach = new Set();
  for (const src of ["nologin", "401", "403"]) for (const [d] of ST) reach.add(quiet.authFailWhy("claude", src, d));
  for (const kind of ["claude", "codex"]) for (const out of [true, false]) { const d = det({}); d[kind].authOutside = out; reach.add(quiet.authFailWhy(kind, "probe", d)); }
  t("走得到的 why = 白名單 16 個(逐一對到、沒有多也沒有少),每個 ≤13 字", reach.size === WHY.length && WHY.every((w) => reach.has(w)) && WHY.every((w) => w.length <= 13), [...reach].filter((w) => !WHY.includes(w))); }

// ── 回合結束那段:兩條送法 ──
async function run({ cur = "claude", turnFail = null, turnFailSrc = null, errTail = "", stopped = false, faulted = true, d = null, detect }) {
  const sent = [], calls = { detect: 0 };
  const ctx = { cur, turnFail, turnFailSrc, trackEvent: (ev, props) => sent.push(ev + ":" + Object.values(props).join()),
    window: { blave: { detectAgents: () => { calls.detect++; return detect ? detect() : Promise.resolve(det({})); } } } };
  const f = mk(ctx);
  f.turnEnd({ errTail }, stopped, faulted, d);
  const sync = sent.slice();   // turnEnd 同步跑完那一刻已經出門的
  return { sent, sync, calls, ctx, settle: async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); return sent; } };
}
(async () => {
  let x = await run({ turnFail: "auth", turnFailSrc: "nologin", detect: () => Promise.resolve(det({})) });
  t("classifyFault 那條:turn_failed 當下就送、補問不 await(同步跑完時 auth_fail 還沒出去)", x.sync.join() === "turn_failed:auth" && x.calls.detect === 1, x.sync);
  await x.settle();
  t("…補問回來才送 auth_fail c_nologin_no,順手送 cli_auth(偵測的 how)", x.sent.join() === "turn_failed:auth,auth_fail:c_nologin_no,cli_auth:", x.sent);
  t("…送完 turnFail／turnFailSrc 都清掉", x.ctx.turnFail === null && x.ctx.turnFailSrc === null);
  let release; x = await run({ turnFail: "auth", turnFailSrc: "401", detect: () => new Promise((r) => { release = r; }) });
  x.ctx.cur = "codex";   // 補問還沒回來,用戶已經換引擎
  release(det({ loggedIn: true, how: "claude_ai" })); await x.settle();
  t("補問回來前換了引擎:仍用送出當下的引擎與來源(c_401_in)", x.sent.join() === "turn_failed:auth,auth_fail:c_401_in,cli_auth:claude_ai", x.sent);
  x = await run({ turnFail: "auth", turnFailSrc: "403", detect: () => Promise.reject(new Error("ipc")) }); await x.settle();
  t("補問丟例外 → unk", x.sent.join() === "turn_failed:auth,auth_fail:c_403_unk", x.sent);
  x = await run({ turnFail: "auth", turnFailSrc: "nologin", detect: () => { throw new Error("sync"); } }); await x.settle();
  t("補問同步丟例外也不炸 → unk", x.sent.join() === "turn_failed:auth,auth_fail:c_nologin_unk", x.sent);
  t("補問那條不設 loggedOut、不畫卡(authFailProbe 裡沒有 loggedOut／addFault)", !/loggedOut|addFault|busyEnd/.test(fnSrc("authFailProbe")) && !/loggedOut|addFault/.test(fnSrc("cliAuthSend")));
  x = await run({ cur: "codex", turnFail: "auth", turnFailSrc: "probe", d: det({}) }); await x.settle();
  t("重問那條:用 await 回來的結果、緊接 turn_failed 送,不再開第二次偵測(x_probe_no)", x.sent.join() === "turn_failed:auth,auth_fail:x_probe_no" && x.calls.detect === 0, x.sent);
  { const d = det({ authOutside: true }); x = await run({ turnFail: "auth", turnFailSrc: "probe", d }); await x.settle();
    t("…Claude 金鑰設在回合讀不到的地方 → c_probe_out", x.sent.join() === "turn_failed:auth,auth_fail:c_probe_out" && x.calls.detect === 0, x.sent); }
  x = await run({ turnFail: "auth", turnFailSrc: "nologin", errTail: "spawn AGENT_BIN_MISSING" }); await x.settle();
  t("reason 被覆寫成 engine_missing:只送 turn_failed,不送 auth_fail、也不開補問", x.sent.join() === "turn_failed:engine_missing" && x.calls.detect === 0, x.sent);
  x = await run({ turnFail: "auth", turnFailSrc: "nologin", stopped: true }); await x.settle();
  t("按停止的回合:都不送、照樣清掉", x.sent.length === 0 && x.calls.detect === 0 && x.ctx.turnFail === null && x.ctx.turnFailSrc === null, x.sent);
  x = await run({ turnFail: "402", turnFailSrc: null }); await x.settle();
  t("不是 auth:只有 turn_failed", x.sent.join() === "turn_failed:402" && x.calls.detect === 0, x.sent);
  x = await run({ turnFail: "auth", turnFailSrc: null }); await x.settle();
  t("auth 但來源認不出來:不送 auth_fail、不補問", x.sent.join() === "turn_failed:auth" && x.calls.detect === 0, x.sent);

  // ── 接線 ──
  t("draftPromote 指定 turnFail 時一起覆寫來源", /if \(fail\) \{ turnFail = fail; turnFailSrc = fail === "auth" \? authFailSrc\(text\) : null; \}/.test(app));
  t("重問:d 提到 try 外面、loggedOut 那行照舊、Claude 順手送 cli_auth;判成 loggedOut 才記來源 probe", /let d = null;[^\n]*\n[^\n]*\n[^\n]*\n\s*try \{ d = await window\.blave\.detectAgents\(\); loggedOut = !!\(d\[cur\] && d\[cur\]\.installed && !d\[cur\]\.loggedIn && !whyState\(d\[cur\]\)\); if \(cur === "claude"\) cliAuthSend\(d\); \}/.test(app)
    && /\n\s*if \(loggedOut\) turnFailSrc = "probe";\n/.test(app));
  t("auth_fail、cli_auth 在 FROM_RENDERER、每日去重", FROM_RENDERER.includes("auth_fail") && FROM_RENDERER.includes("cli_auth")
    && /const DAILY = \[[^\]]*"auth_fail", "cli_auth"\]/.test(fs.readFileSync(path.join(SHELL, "telemetry.js"), "utf8")));
  t("登入成功:連結畫面在 await detect() 之後、偵測確實已登入才記;聊天卡照 r.ok", /await detect\(\);\n\s*const x = \(lastDetect && lastDetect\[kind\]\) \|\| \{\};\n\s*if \(r\.ok && x\.loggedIn\) trackFeature\(kind === "codex" \? "codex_login_ok" : "claude_login_ok"\);/.test(app)
    && /if \(r\.ok\) \{ trackFeature\(kind === "codex" \? "codex_login_ok" : "claude_login_ok"\); me\.done\(\); \}/.test(app));

  // ── cli_auth 的 how(telemetry.js 唯一一份;主行程 detectAgents 放進 out.claude.how)──
  const HOW = [["claude.ai", "claude_ai"], ["api_key", "api_key"], ["api_key_helper", "api_key_helper"], ["oauth_token", "oauth_token"], ["third_party", "third_party"], ["none", "none"],
    [null, "none"], [undefined, "none"], ["oauth", "other"], ["Claude.ai", "other"], ["constructor", "other"], ["__proto__", "other"], [42, "other"], [{}, "other"]];
  t("cliAuthHow:六個原值逐一對到、null／缺 = none、表外(含原型鏈上的名字、非字串)= other;輸出全在白名單", HOW.every(([m, want]) => cliAuthHow(m) === want)
    && HOW.every(([m]) => EVENTS.cli_auth.how.includes(cliAuthHow(m))) && EVENTS.cli_auth.how.every((h) => HOW.some(([m]) => cliAuthHow(m) === h)), HOW.map(([m]) => cliAuthHow(m)));
  const main = fs.readFileSync(path.join(SHELL, "main.js"), "utf8");
  t("主行程:detectAgents 在 JSON 讀得出來時才算 how(其餘留 null);saveConnection 在 connect_done 之後送;開 app 那條先看今天送過沒才開子行程",
    /out\.claude\.authMethod = j\.authMethod \|\| null;\n\s*out\.claude\.how = cliAuthHow\(j\.authMethod\);/.test(main) && /authOutside: false, how: null \}/.test(main)
    && /tm\(\)\.track\("connect_done", \{ kind: saved\.kind \}\);\n\s*if \(saved\.kind === "claude" && d\) tm\(\)\.track\("cli_auth", \{ how: d\.claude\.how \}\);/.test(main)
    && /if \(!c \|\| c\.kind !== "claude" \|\| !telemetryLive\(\) \|\| !tm\(\)\.isEnabled\(\) \|\| tm\(\)\.sentToday\("cli_auth"\)\) return;\n\s*detectAgents\(\)\.then/.test(main)
    && (main.match(/CLI_AUTH_HOW|"claude\.ai": "claude_ai"/g) || []).length === 0);

  // ── sentToday:每日鍵的前綴,含送出中 ──
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "blave-authfail-"));
  try {
    let release2; const tm = createTelemetry({ dir: TMP, endpoint: "https://x/t", appVersion: "0.1.35", osVersion: "15.5", lang: "zh-TW", post: () => new Promise((r) => { release2 = r; }) });
    const before = tm.sentToday("cli_auth");
    tm.track("cli_auth", { how: "claude_ai" }); await new Promise((r) => setImmediate(r));
    const during = tm.sentToday("cli_auth");
    release2({ status: 200 }); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
    t("sentToday:還沒送 false、送出中 true、2xx 之後 true;別的事件不受影響;值不在表上的 cli_auth 不送", before === false && during === true && tm.sentToday("cli_auth") === true
      && tm.sentToday("auth_fail") === false && tm.sentToday("cli_auth_x") === false && tm.track("cli_auth", { how: null }) === false && tm.track("cli_auth", { how: "wei@example.com" }) === false);
  } finally { fs.rmSync(TMP, { recursive: true, force: true }); }

  console.log(red ? `\n${red} FAILED` : "\nALL PASS");
  process.exit(red ? 1 : 0);
})().catch((e) => { console.log("FAIL  " + (e && e.stack || e)); process.exit(1); });
