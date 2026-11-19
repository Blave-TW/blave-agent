// 統一本機開通:登入被擋之後的兩條出路,畫面(president.js)接到真的主行程(president_local.js,假 safeStorage、暫存目錄)。
//   1. 改交易密碼:開通走到清單後 PRES.acct 已清掉、重開框也不回填——「用新密碼確認」要送存著的帳號,不是空字串(否則主行程回 BAD_ACCOUNT)
//   2. 改帳號:密碼錯／原因不明也給(統一的查無此使用者歸在密碼類),憑證兩類照舊;改完要重綁憑證,不能拿 daemon 手上的舊帳號再登入
// 跑法:node tests/check_shell_president_recheck.js
const fs = require("fs"), os = require("os"), path = require("path"), vm = require("vm");
const P = require("../shell/president_local");
const src = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "president.js"), "utf8");
let red = 0; const ok = (n, c, got) => { console.log((c ? "PASS  " : "FAIL  ") + n); if (!c) { red++; if (got !== undefined) console.log("      got: " + JSON.stringify(got)); } };
const cut = (from, to) => { const a = src.indexOf(from), b = src.indexOf(to, a + 1); if (a < 0 || b < 0) throw new Error("找不到 " + from); return src.slice(a, b); };
const fn = (name) => cut(name, "\n}\n") + "\n}\n";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pres-recheck-"));
const fakeSeal = { available: () => true, encrypt: (v) => Buffer.from("SEALED:" + Buffer.from(v).toString("base64")), decrypt: (b) => Buffer.from(String(b).slice(7), "base64").toString() };
fs.mkdirSync(path.join(tmp, "home", "PSCCA"), { recursive: true }); fs.writeFileSync(path.join(tmp, "home", "PSCCA", "PSC_X_20270930.pfx"), "x");
const sent = [];   // 真的交給 daemon 的 op
let certReply = { ok: true, result: { env: "live" } };
const daemon = { send: async (cmd, a) => { sent.push(a.op); return a.op === "cert" ? certReply : { ok: true, result: { env: "live" } }; }, sealPresident: () => "sealed" };
const main = P.createPresident({ userData: path.join(tmp, "ud"), home: path.join(tmp, "home"), platform: "win32", seal: fakeSeal, host: () => daemon, pickFile: async () => null });

const calls = { creds: [], cert: [], steps: [] };
const ctx = {
  window: { blave: {
    presidentInfo: async () => main.info(),
    presidentCreds: async (account, password) => { calls.creds.push(account); return main.saveCreds({ account, password }); },
    presidentCert: async (caPassword, source) => { calls.cert.push({ caPassword, source }); return { code: "OK" }; },
  } },
};
vm.createContext(ctx);
vm.runInContext([
  cut("const PRESIDENT = ", "let PRES = presBlank();"), "let PRES = presBlank();",
  cut("/* ── 純邏輯", "/* ── 純邏輯到此 ── */"),
  `let PC = null; const presPC = () => PC;
   function presPaint() {} function presDown() { return false; } function presTrack() {} function presScan() {}
   async function presStep(n) { calls.steps.push(n); }
   const t = (k) => k, presP = (cls, text) => ({ p: text }), presRowErr = () => null;
   const capBtn = (cls, text, on, id) => ({ id, on }), capErr = (x) => ({ err: x }), capActs = (...b) => ({ acts: b.filter(Boolean) }), capFrag = (...x) => x;`,
  cut("const presErr = ", "\n") + "\n",
  fn("async function presResume("), fn("async function presSaveCreds("), fn("async function presGo("), fn("async function presRecheck("), fn("function presProbeBody("),
  `this.S = () => PRES; this.reset = () => { PRES = presBlank(); }; this.setPC = (x) => { PC = x; };
   this.presResume = presResume; this.presGo = presGo; this.presRecheck = presRecheck; this.presView = presView; this.presMsgPlace = presMsgPlace;
   this.btns = (view) => presProbeBody(view, PC).find((x) => x && x.acts).acts.map((b) => b.id);
   this.click = (view, id) => presProbeBody(view, PC).find((x) => x && x.acts).acts.find((b) => b.id === id).on();`,
].join("\n"), Object.assign(ctx, { calls }));

const ACCT = "70000011234", S = Date.now() / 1000;
const CERT_OK = { status: "ok", at: S - 50, not_after: "2027-09-30T00:00:00Z" };
const pcFail = (state) => ({ v: 1, updated_at: S - 5, env: "live", setup: { status: "ok" }, cert: CERT_OK, probe: { status: "failed", state, env: "live", at: S - 3 }, worker: { status: "idle" } });
const W = { win: true, now: Date.now() };

(async () => {
  // 第一次開通:帳密頁送出 → 清單(PRES.acct 清掉)
  ctx.reset(); Object.assign(ctx.S(), { phase: "form", acct: ACCT, pw: "old-pw" });
  await ctx.presGo();
  ok("開通送帳密:存了、進清單、畫面上的帳號清掉、第一次不算改帳號(不重綁)", main._load().account === ACCT && ctx.S().phase === "flow" && ctx.S().acct === "" && !ctx.S().recert, ctx.S());
  await main.certUse({ caPassword: "ca-pw", source: "found" });   // 憑證那一步成功、切過正式:存了憑證密碼、live
  const certBefore = main._load();
  ok("(前提)憑證密碼與正式環境存著", certBefore.ca_password === "ca-pw" && certBefore.live === true, certBefore);

  // 1. 統一說密碼不對 → 關框再開(presResume 不回填 PRES.acct)→ 改交易密碼
  ctx.setPC(pcFail("password")); ctx.reset(); await ctx.presResume();
  ok("重開框回到清單、PRES.acct 是空的、停在密碼錯", ctx.S().phase === "flow" && ctx.S().acct === "" && ctx.presView(pcFail("password"), ctx.S(), W) === "d-PASSWORD");
  ctx.click("d-PASSWORD", "pres-change-pw");
  ok("按改交易密碼 → d-pw", ctx.presView(pcFail("password"), ctx.S(), W) === "d-pw");
  calls.creds.length = 0; calls.cert.length = 0; calls.steps.length = 0;
  ctx.S().pw = "new-pw";
  await ctx.presRecheck();
  ok("1 用新密碼確認:送的是存著的帳號、不是空字串", calls.creds.length === 1 && calls.creds[0] === ACCT, calls.creds);
  ok("1 主行程沒回 BAD_ACCOUNT、畫面沒有錯", ctx.S().msg === null, ctx.S().msg);
  ok("1 新密碼存下、同帳號照留憑證密碼與環境", main._load().password === "new-pw" && main._load().account === ACCT && main._load().live === true && main._load().ca_password === "ca-pw", main._load().account);
  ok("1 同一張憑證重綁(沿用憑證密碼)再確認登入;離開改密碼態、密碼欄清掉", JSON.stringify(calls.cert) === JSON.stringify([{ caPassword: null, source: "found" }])
    && JSON.stringify(calls.steps) === JSON.stringify(["probe"]) && !ctx.S().recheck && ctx.S().pw === "", { cert: calls.cert, steps: calls.steps });
  // 存著的帳號讀不到(主行程沒有帳密):不送、不回 BAD_ACCOUNT 那句,講整框的帳密問題
  ctx.reset(); ctx.S().phase = "flow"; ctx.S().recheck = true; ctx.S().pw = "x"; calls.creds.length = 0;
  await ctx.presRecheck();
  ok("1 沒有存著的帳號 → 不送帳密、整框講 NO_CREDS", calls.creds.length === 0 && ctx.S().msg && ctx.S().msg.code === "NO_CREDS" && ctx.presMsgPlace(ctx.S().msg) === "frame", ctx.S().msg);

  // 2. 改帳號:密碼錯／原因不明也給;憑證兩類照舊;其他類沒有
  const has = (v) => ctx.btns(v);
  ok("2 d-PASSWORD:確認登入、改交易密碼、改帳號", JSON.stringify(has("d-PASSWORD")) === JSON.stringify(["pres-confirm", "pres-change-pw", "pres-acct-swap"]), has("d-PASSWORD"));
  ok("2 d-UNKNOWN:確認登入、改交易密碼、改帳號", JSON.stringify(has("d-UNKNOWN")) === JSON.stringify(["pres-confirm", "pres-change-pw", "pres-acct-swap"]), has("d-UNKNOWN"));
  ok("2 d-CERT／d-CERT_MISMATCH 照舊:換憑證、改帳號", ["d-CERT", "d-CERT_MISMATCH"].every((v) => JSON.stringify(has(v)) === JSON.stringify(["pres-confirm", "pres-recert", "pres-acct-swap"])));
  ok("2 逾時／維護／沒帳密:只有確認登入", ["d-TIMEOUT", "d-MAINTENANCE", "d-NOCREDS"].every((v) => JSON.stringify(has(v)) === JSON.stringify(["pres-confirm"])));
  // 查無此使用者歸在密碼類 → 按改帳號 → 帳密頁 → 新帳號 → 回清單要先重綁憑證(daemon 手上還是舊帳號,憑證密碼也跟著換帳號丟了)
  ctx.setPC(pcFail("password")); ctx.reset(); await ctx.presResume();
  ctx.click("d-PASSWORD", "pres-acct-swap");
  ok("2 按改帳號 → 帳密頁、帳號欄是空的", ctx.presView(pcFail("password"), ctx.S(), W) === "d-form" && ctx.S().acct === "");
  const NEW = "70000099999";
  Object.assign(ctx.S(), { acct: NEW, pw: "pw2" }); calls.steps.length = 0;
  await ctx.presGo();
  ok("2 存成新帳號、舊帳號的憑證密碼丟掉、從測試環境開始", main._load().account === NEW && main._load().ca_password === undefined && main._load().live === false);
  ok("2 回清單先重綁憑證(d-cert),不是回到密碼錯那一態讓人用舊帳號再登入;不自動送登入", ctx.S().phase === "flow" && ctx.S().recert === true
    && ctx.presView(pcFail("password"), ctx.S(), W) === "d-cert" && calls.steps.length === 0, ctx.S());

  // 3. 改帳號存了、沒重綁就關框(cxForget → presBlank)再開:畫面與主行程兩層都不能用 daemon 手上的舊帳號登入
  ctx.reset(); await ctx.presResume();
  const v3 = ctx.presView(pcFail("password"), ctx.S(), W);
  ok("3 重開框:停在選憑證(d-cert),不是密碼錯那一態、看不到「確認登入」", v3 === "d-cert" && ctx.S().recert === true, { v3, recert: ctx.S().recert });
  sent.length = 0;
  for (const [op, o] of [["probe", {}], ["test_order", {}], ["start", {}], ["host", { env: "live" }], ["host", { url: "test167.pfctrade.com" }]]) {
    const r = await main.step(op, o);
    ok(`3 主行程底線:沒重綁前 ${op} 回 NO_CA_PW、不交給 daemon`, r.code === "NO_CA_PW" && sent.length === 0, { r, sent });
  }
  ok("3 不登入的步驟照常(host 切環境、stop)", (await main.step("stop", {})).code === "OK" && sent.join() === "stop", sent);
  // 憑證那一步交出去、回條還沒來(SENT):daemon 已拿到新帳號,登入放行;憑證密碼照舊等 OK 才存
  certReply = { ok: false, error: "UNKNOWN_RESULT" };
  ok("3 (前提)重綁回 SENT", (await main.certUse({ caPassword: "ca-new", source: "found" })).code === "SENT" && main._load().ca_password === undefined);
  sent.length = 0;
  ok("3 重綁交出新帳號之後:probe 交給 daemon、重開框不再強制選憑證", (await main.step("probe", {})).code === "OK" && sent.join() === "probe" && main.info().rebindNeeded === false, sent);
  // 再改一次帳號:sealed_acct 跟著舊帳號走,新帳號又擋回去
  await main.saveCreds({ account: "70000077777", password: "pw3" });
  ok("3 又改帳號 → 再擋(sealed_acct 是上一個帳號的)", (await main.step("probe", {})).code === "NO_CA_PW" && main.info().rebindNeeded === true);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(red ? `\n${red} 紅` : "\n全綠"); process.exit(red ? 1 : 0);
})().catch((e) => { console.log("FAIL  " + (e && e.stack)); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(1); });
