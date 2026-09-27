// 雲端群益開通的畫面流程(隨包 Electron + 真的 index.html,window.blave 換成假的;不連網、不碰任何主機)。
//   ① 主機不是 Windows:只有一句、沒有表單、主鈕不出
//   ② 表單:欄位空 → 主鈕停用;送出 → 先存帳密再送 setup;欄位清空(DOM 裡不留密碼)
//   ③ 過渡期:主機不認得 capital_setup(unknown command)→ 交給 agent 那一態;按下去 = 本機 agent 收到一句(視角 cloud)、框關掉
//   ④ 匯入:選檔只拿到檔名;上傳送出的是匯出密碼(pfx 在主行程);回報「匯入中」→「確認帳密…」→ 自動送 finish(一次)→ 完成
//   ⑤ 上傳失敗的代號對到欄下那一句(PFX_PASSWORD 在密碼欄、PFX_OLDER 在檔案欄)
//   ⑥ 307:「我已解鎖」送 unlock,主機回 PW_RECHECK_NEEDED → 只剩重填帳密(兩欄)
//   ⑦ 帳密的揭露句只在 vault:true 才出現
//   ⑧ 設定 › 帳戶:開通中那一列「繼續」帶回群益清單;埋點名字都在白名單上
// 跑法:node tests/check_shell_capital_flow.js(找不到 shell/node_modules 的 Electron 就 SKIP)
const path = require("path"), fs = require("fs");
const SHELL = path.join(__dirname, "..", "shell");
const GATE = require("./_electron_gate");
if (!process.versions.electron) {
  const bin = GATE.bin(SHELL);
  if (!bin) { process.exit(0); }
  const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit" });
  process.exit(r.status == null ? 1 : r.status);
}
const { app, BrowserWindow } = require("electron");
const os = require("os");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "blave-capflow-")));
const STUB = `window.__over = {}; window.__calls = [];
window.blave = new Proxy({}, { get: (_, k) => typeof k !== "string" ? undefined
  : k.startsWith("on") ? () => {} : k === "tradeLabels" ? () => {}
  : k === "trackFeature" ? (n) => window.__calls.push(["trackFeature", [n]])
  : async (...a) => { window.__calls.push([k, a]); if (k in window.__over) return window.__over[k](...a);
      return ({ getLocale: "zh-TW", loadConnection: { kind: "claude" }, detectAgents: { claude: { installed: true, loggedIn: true }, codex: { installed: false } },
        listStrategies: [], listSessions: [], loadSession: [], loadSessionImages: [], updateState: { phase: "idle", current: "0.0.0" } })[k]; } });`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let red = 0; const ok = (n, c, got) => { console.log((c ? "PASS  " : "FAIL  ") + n); if (!c) { red++; if (got !== undefined) console.log("      got: " + JSON.stringify(got).slice(0, 400)); } };
const J = JSON.stringify;

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  setTimeout(() => { console.log("FAIL  逾時(90 秒)"); app.exit(1); }, 90000).unref();
  const pre = path.join(app.getPath("userData"), "stub.js"); fs.writeFileSync(pre, STUB);
  const w = new BrowserWindow({ width: 1200, height: 800, show: false, webPreferences: { offscreen: true, preload: pre, contextIsolation: false, sandbox: false } });
  await w.loadFile(path.join(SHELL, "renderer", "index.html"));
  await wait(1200);
  const js = (s) => w.webContents.executeJavaScript(s, true).catch((e) => { console.log("JSFAIL " + s.slice(0, 160)); throw e; });
  const run = (s) => w.webContents.executeJavaScript("(() => { " + s + "; return 0; })()", true);   // 賦值成函式的那幾行:回傳值不能跨 IPC
  const S = Math.floor(Date.now() / 1000);
  // 雲端視角、主機運行中;輪詢停掉(狀態由測試直接換)
  const setState = (report) => js(`(() => { TR_BAGS.cloud.st = { alive: true, cloud: { code: "OK", machine: { state: "running", public_ip: "203.0.113.9", os_type: "windows" }, strategies: [] }, report: ${J(report)} }; capPaint(); })()`);
  await js(`(() => { trPollSoon = () => {}; trPoll = async () => {}; if (ENV.cur !== "cloud") envSwitch("cloud"); })()`);
  const open = async (report, venue) => { await setState(report); await js(`(() => { if (!$("cx-scrim").hidden) cxModalClose(false); window.__calls = []; cxModalOpen(null, ${J(venue || null)}); if (${J(!venue)}) { const s = $("cx-venue"); s.value = "capital"; s.dispatchEvent(new Event("change")); } })()`); await wait(100); };
  const view = () => js(`CAP.view`);
  const calls = (k) => js(`window.__calls.filter((c) => c[0] === ${J(k)}).map((c) => c[1])`);
  const fill = (o) => js(`(() => { for (const [id, v] of Object.entries(${J(o)})) { const i = $(id); i.value = v; i.dispatchEvent(new Event("input")); } })()`);
  const click = (id) => js(`(() => { const b = $(${J(id)}); if (!b) return false; b.click(); return true; })()`);
  const text = () => js(`$("cx-body").textContent`);
  const t = (k) => js(`t(${J(k)})`);

  // ① 不是 Windows
  await open({ platform: "Linux", venues: {} });
  ok("① Linux 主機:c-win,沒有帳密欄、主鈕不出", (await view()) === "c-win" && !(await js(`!!$("cap-id")`)) && (await js(`$("cx-go").hidden`)) && (await text()).indexOf(await t("cap.needWin")) >= 0);

  // ② 表單
  await open({ platform: "Windows", venues: {} });
  ok("② 表單:兩欄、主鈕停用、腳有那一句", (await view()) === "c-form" && (await js(`!!$("cap-id") && !!$("cap-pw")`)) && (await js(`$("cx-go").getAttribute("aria-disabled")`)) === "true"
    && (await js(`$("cap-foot-msg").textContent`)) === (await t("cap.beforeC")));
  ok("⑦ vault 還不知道:不出「帳密存在哪?」", !(await js(`!!$("cap-store-q")`)));
  await fill({ "cap-id": "A123456789", "cap-pw": "tr-secret-pw" });
  ok("② 填好 → 主鈕可按", (await js(`$("cx-go").getAttribute("aria-disabled")`)) === "false");
  // ③ 過渡期:帳密存成功、setup 回 NOT_CAPABLE
  await run(`window.__over.capitalCreds = async () => ({ code: "OK" }); window.__over.capitalStep = async () => ({ code: "NOT_CAPABLE" });`);
  await js(`$("cx-go").click()`); await wait(150);
  ok("② 先存帳密(ID 與密碼原樣交主行程)再送 setup", J(await calls("capitalCreds")) === J([["A123456789", "tr-secret-pw"]]) && J(await calls("capitalStep")) === J([["setup"]]));
  ok("② 送出後 DOM 與畫面狀態裡都沒有交易密碼", !(await js(`document.body.innerHTML.includes("tr-secret-pw") || [...document.querySelectorAll("input")].some((i) => i.value === "tr-secret-pw") || CAP.pw === "tr-secret-pw"`)));
  ok("③ 主機不認得 capital_* → 交給 agent 那一態(三步 + 主鈕)", (await view()) === "c-handoff" && (await js(`$("cx-go").textContent.trim()`)) === (await t("cap.ho.go")));
  await run(`window.__sent = null; window.submitMessage = async (m, o) => { window.__sent = [m, o]; return true; };`);
  await js(`$("cx-go").click()`); await wait(100);
  const sent = await js(`window.__sent`);
  ok("③ 按下去:本機 agent 收到那一句、視角是雲端;框關掉;記 cap_rdp_open", !!sent && sent[0] === (await t("cap.ho.prompt")) && sent[1].viewing.env === "cloud" && (await js(`$("cx-scrim").hidden`))
    && (await calls("trackFeature")).some((c) => c[0] === "cap_rdp_open"));

  // ④ 匯入主路
  const cc = (o) => Object.assign({ v: 1, updated_at: S, busy: null, vault: true, setup: { status: "ok", at: S }, cert: { status: "idle", at: null }, probe: { status: "idle", at: null }, worker: { status: "idle", at: null } }, o);
  const VEN = { capital: { credentials: true, pair: true, order: true, account: true } };
  await open({ platform: "Windows", venues: VEN, capital_connect: cc({}) }, "capital");
  ok("④ 帳密已存、主機上開始過 → 直接回到清單(選做法)", (await view()) === "c-pick");
  await click("cap-opt-pfx"); await wait(50);
  ok("④ 選匯入 → 檔案欄 + 匯出密碼 + 誠實句;上傳鈕停用", (await view()) === "c-pfx" && (await text()).indexOf(await t("cap.pfx.e2e")) >= 0 && (await js(`$("cap-upload").getAttribute("aria-disabled")`)) === "true");
  await run(`window.__over.capitalPick = async () => ({ code: "OK", name: "A123456789.pfx", size: 5268 });`);
  await click("cap-pick"); await wait(50);
  await fill({ "cap-ppw": "export-pw" });
  ok("④ 選好檔(只有檔名)+ 密碼 → 上傳鈕可按", (await text()).indexOf("A123456789.pfx") >= 0 && (await js(`$("cap-upload").getAttribute("aria-disabled")`)) === "false");
  await run(`window.__over.capitalUpload = async () => ({ code: "SENT" });`);
  await click("cap-upload"); await wait(50);
  ok("④ 上傳送的是匯出密碼;送出後欄位清空、進「匯入中」、記 cap_pfx_upload", J(await calls("capitalUpload")) === J([["export-pw"]]) && (await view()) === "c-importing" && !(await js(`CAP.ppw`))
    && (await calls("trackFeature")).some((c) => c[0] === "cap_pfx_upload"));
  await setState({ platform: "Windows", venues: VEN, capital_connect: cc({ updated_at: S + 5, busy: "capital_pfx", cert: { status: "ok", at: S + 5, not_after: "2027-09-26T15:59:59Z" }, probe: { status: "running", at: S + 5 } }) });
  ok("④ 回報:匯入完、確認帳密中 → c-probe(憑證列轉圈)", (await view()) === "c-probe");
  await run(`window.__calls = []; window.__over.capitalStep = async () => ({ code: "SENT" });`);
  await setState({ platform: "Windows", venues: VEN, capital_connect: cc({ updated_at: S + 20, cert: { status: "ok", at: S + 5, not_after: "2027-09-26T15:59:59Z" }, probe: { status: "ok", at: S + 20, state: "ok", code: 0, futures: true, securities: true } }) });
  await wait(50); await setState({ platform: "Windows", venues: VEN, capital_connect: cc({ updated_at: S + 20, cert: { status: "ok", at: S + 5, not_after: "2027-09-26T15:59:59Z" }, probe: { status: "ok", at: S + 20, state: "ok", code: 0, futures: true, securities: true } }) });
  ok("④ 帳密確認通過 → 自動送 finish,只送一次", J(await calls("capitalStep")) === J([["finish"]]) && (await view()) === "c-finish");
  await setState({ platform: "Windows", venues: VEN, capital_connect: cc({ updated_at: S + 40, cert: { status: "ok", at: S + 5, not_after: "2027-09-26T15:59:59Z" }, probe: { status: "ok", at: S + 20, state: "ok", code: 0, futures: false, securities: true }, worker: { status: "ok", at: S + 40 } }) });
  ok("④ 下單程式起來 → 完成(只讀到證券:期貨那列「—」+ 另簽一句)、主鈕是「完成」、記 cap_ready",
    (await view()) === "c-done-ts" && (await text()).indexOf(await t("cap.tfMissing")) >= 0 && (await js(`$("cx-go").textContent.trim()`)) === (await t("cap.finish"))
    && (await calls("trackFeature")).some((c) => c[0] === "cap_ready"));

  // ⑤ 上傳失敗的代號 → 欄下那一句
  await open({ platform: "Windows", venues: VEN, capital_connect: cc({ cert: { status: "failed", at: S, error: "PFX_PASSWORD" } }) }, "capital");
  ok("⑤ PFX_PASSWORD → 匯出密碼欄下紅字、欄框紅", (await view()) === "c-pfx" && (await js(`$("cap-ppw-err") && $("cap-ppw-err").textContent`)) === (await t("cap.pfx.errPw")) && (await js(`$("cap-ppw").classList.contains("is-err")`)));
  await open({ platform: "Windows", venues: VEN, capital_connect: cc({ cert: { status: "failed", at: S, error: "PFX_OLDER" } }) }, "capital");
  ok("⑤ PFX_OLDER → 檔案欄下那一句", (await text()).indexOf(await t("cap.pfx.errOlder")) >= 0);

  // ⑥ 307
  await open({ platform: "Windows", venues: VEN, capital_connect: cc({ cert: { status: "ok", at: S - 9 }, probe: { status: "failed", at: S, state: "pw_locked", code: 307 } }) }, "capital");
  ok("⑥ 307 → c-pw-locked,只有「我已解鎖」", (await view()) === "c-pw-locked" && (await js(`!!$("cap-unlock") && !$("cap-id")`)));
  await run(`window.__over.capitalStep = async (n) => (n === "unlock" ? { code: "PW_RECHECK_NEEDED" } : { code: "SENT" });`);
  await click("cap-unlock"); await wait(50);
  ok("⑥ 送的是 unlock;主機拒絕 → 只剩重填帳密(兩欄)+ 改密碼那一句", J(await calls("capitalStep")) === J([["unlock"]]) && (await view()) === "c-pw-change"
    && (await js(`!!$("cap-id") && !!$("cap-pw")`)) && (await text()).indexOf(await t("cap.err.pwChange")) >= 0);
  ok("⑥ 一列只有一個紅記號:密碼的錯在欄下(紅字、沒有第二個短劃)", (await js(`[...document.querySelectorAll("#cx-body .cap-step")].every((li) => li.querySelectorAll(".fault-mark").length <= 1)`))
    && (await js(`$("cap-pw-err") && $("cap-pw-err").textContent`)) === (await t("cap.err.pwChange")));
  ok("⑦ vault:true → 重填時有「帳密存在哪?」,展開是 Wei 拍板那句", (await js(`!!$("cap-store-q")`)) && (await js(`$("cap-store").textContent`)) === (await t("cap.storeCloud")));
  await run(`window.__calls = []; window.__over.capitalCreds = async () => ({ code: "OK" });`);
  await fill({ "cap-id": "A123456789", "cap-pw": "new-pw" }); await click("cap-recheck"); await wait(80);
  ok("⑥ 重填 → 先存帳密再確認一次(probe)", J(await calls("capitalCreds")) === J([["A123456789", "new-pw"]]) && J(await calls("capitalStep")) === J([["probe"]]));

  for (const vault of [false, null]) {   // 帳密還在 .env(舊 workspace / 寫不進獨立檔):那一句不能講
    await open({ platform: "Windows", venues: VEN, capital_connect: cc({ vault, cert: { status: "ok", at: S - 9 }, probe: { status: "failed", at: S, state: "pw_wrong", code: 300 } }) }, "capital");
    ok(`⑦ vault:${vault} → 重填時不出「帳密存在哪?」`, (await view()) === "c-pw-err" && !(await js(`!!$("cap-store-q")`)));
  }
  // 321:交給 agent 的那一句講的是連線檢核,不是申請憑證
  await open({ platform: "Windows", venues: VEN, capital_connect: cc({ cert: { status: "ok", at: S - 9 }, probe: { status: "failed", at: S, state: "verify_needed", code: 321 } }) }, "capital");
  await run(`window.__sent = null; window.submitMessage = async (m, o) => { window.__sent = [m, o]; return true; };`);
  await click("cap-ho"); await wait(80);
  ok("⑥′ 321 → 連線檢核那一列;交給 agent 送的是檢核那一句", (await js(`window.__sent && window.__sent[0]`)) === (await t("cap.ho.promptVerify")));
  // 稽核 S-1:解綁再重綁(主機上有舊的 probe ok + worker ok)→ 重新確認,不直接「已連接」、不自動送 finish
  const DONE = cc({ cert: { status: "ok", at: S - 99 }, probe: { status: "ok", at: S - 90, state: "ok", code: 0, futures: true, securities: true }, worker: { status: "ok", at: S - 80 } });
  await open({ platform: "Windows", venues: {}, capital_connect: DONE });
  await run(`window.__calls = []; window.__over.capitalCreds = async () => ({ code: "OK" }); window.__over.capitalStep = async () => ({ code: "SENT" });`);
  await fill({ "cap-id": "A123456789", "cap-pw": "new-pw" }); await js(`$("cx-go").click()`); await wait(120);
  ok("S-1 重綁:setup 已 ok → 送 probe(不是 finish)、畫面在確認帳密,不是已連接", J(await calls("capitalStep")) === J([["probe"]]) && (await view()) === "c-probe");
  await setState({ platform: "Windows", venues: VEN, capital_connect: Object.assign({}, DONE, { updated_at: S + 1 }) }); await wait(50);
  ok("S-1 回報動了但 probe 還是舊的 → c-probe-idle,沒有自動送 finish", (await view()) === "c-probe-idle" && J(await calls("capitalStep")) === J([["probe"]]));
  await setState({ platform: "Windows", venues: VEN, capital_connect: Object.assign({}, DONE, { updated_at: S + 30, probe: { status: "ok", at: S + 30, state: "ok", code: 0, futures: true, securities: true } }) }); await wait(50);
  ok("S-1 新的 probe ok → 送 finish(重起下單程式吃新帳密)", J(await calls("capitalStep")) === J([["probe"], ["finish"]]) && (await view()) === "c-finish");
  // 稽核 S-4:開框時已經完成的,不重記 cap_ready / cap_setup_done
  await open({ platform: "Windows", venues: VEN, capital_connect: DONE }, "capital");
  ok("S-4 已完成的框再打開:c-done,不記 cap_ready / cap_setup_done", (await view()) === "c-done" && !(await calls("trackFeature")).some((c) => c[0] === "cap_ready" || c[0] === "cap_setup_done"));
  // 稽核 S-2:「我已解鎖」送出後主機一直沒回報,「再試一次」送一般的 probe,不再送 after_unlock
  await open({ platform: "Windows", venues: VEN, capital_connect: cc({ cert: { status: "ok", at: S - 9 }, probe: { status: "failed", at: S, state: "pw_locked", code: 307 } }) }, "capital");
  await run(`window.__over.capitalStep = async () => ({ code: "SENT" });`);
  await click("cap-unlock"); await wait(50);
  await run(`CAP.sent.at = Date.now() - 120000; CAP.sig = null; capPaint();`); await wait(50);
  await js(`(() => { const b = [...document.querySelectorAll("#cx-body .btn-out")].find((x) => x.textContent === t("cap.tryAgain")); if (b) b.click(); return !!b; })()`); await wait(50);
  ok("S-2 解鎖逾時的「再試一次」送 probe,after_unlock 只送過一次", J(await calls("capitalStep")) === J([["unlock"], ["probe"]]));

  // 設計稽核(電腦版):身分證明碼、停滯態一個記號、揭露句在鈕之後、檢核先下載再查、完成值「已開通」
  await open({ platform: "Windows", venues: {} });
  ok("C-3 身分證字號明碼、自動大寫;交易密碼照樣遮住", (await js(`$("cap-id").type`)) === "text" && (await js(`$("cap-pw").type`)) === "password"
    && (await (async () => { await fill({ "cap-id": "a123456789" }); return js(`$("cap-id").value`); })()) === "A123456789");
  await open({ platform: "Windows", venues: VEN, capital_connect: cc({}) }, "capital");
  await run(`CAP.sent = { step: "probe", at: Date.now() - 120000, upd: ${S} }; CAP.sig = null; capPaint();`); await wait(50);
  ok("C-6 主機一直沒回報:那一列靜態點、沒有轉圈、沒有第二個記號;一句 + 再試一次", (await js(`!document.querySelector("#cx-body .cap-step .spin16") && !document.querySelector("#cx-body .cap-step .fault-mark") && !!document.querySelector("#cx-body .cap-step.is-cur .cap-mk .cur")`))
    && (await text()).indexOf(await t("cap.err.noMove")) >= 0);
  await open({ platform: "Windows", venues: VEN, capital_connect: cc({ cert: { status: "ok", at: S - 9 }, probe: { status: "failed", at: S, state: "pw_wrong", code: 300 } }) }, "capital");
  ok("設計:「帳密存在哪?」在「重新確認」之後", (await js(`!!($("cap-recheck").compareDocumentPosition($("cap-store-q")) & Node.DOCUMENT_POSITION_FOLLOWING)`)));
  await open({ platform: "Windows", venues: VEN, capital_connect: cc({ cert: { status: "ok", at: S - 9 }, probe: { status: "failed", at: S, state: "verify_needed", code: 321 } }) }, "capital");
  ok("C-4 檢核:先是實心「下載檢核工具」", (await js(`$("cap-verify-dl").className`)) === "btn-fill" && !(await js(`!!$("cap-probe")`)));
  await run(`window.__calls = [];`); await click("cap-verify-dl"); await wait(50);
  ok("C-4 按過下載 → 主鈕翻成「再查一次」、下載降成 quiet;開的是檢核工具的網址", (await js(`$("cap-probe").className`)) === "btn-fill" && (await js(`$("cap-verify-dl").className`)) === "btn-quiet"
    && /SKCOMVerifyDJ\.zip$/.test(((await calls("openExternal"))[0] || [""])[0]));
  await open({ platform: "Windows", venues: VEN, capital_connect: Object.assign(cc({ cert: { status: "ok", at: S - 9, not_after: "2027-09-26T15:59:59Z" } }), { probe: { status: "ok", at: S - 5, state: "ok", code: 0, futures: true, securities: true }, worker: { status: "ok", at: S } }) }, "capital");
  ok("C-1 完成的值是「已開通」", (await text()).indexOf(await t("cap.acct.read")) >= 0 && (await t("cap.acct.read")) === "已開通");

  // 設計第二輪 R-D1:讀取失敗掛在「讀取帳戶」列,另給 quiet「交給 agent」(promptRead);EN 鎖住那句
  const lastStep = () => js(`(() => { const li = document.querySelector("#cx-body .cap-step.is-cur"); return li ? li.querySelector(".cap-n").textContent : null; })()`);
  for (const [name, c] of [["c-probe-fail", cc({ cert: { status: "ok", at: S - 9 }, probe: { status: "failed", at: S, state: "vehicle_failed", code: null } })],
    ["c-finish-fail", cc({ cert: { status: "ok", at: S - 9 }, probe: { status: "ok", at: S - 5, state: "ok", code: 0, futures: true, securities: true }, worker: { status: "failed", at: S, error: "SNAPSHOT_TIMEOUT" } })]]) {
    await open({ platform: "Windows", venues: VEN, capital_connect: c }, "capital");
    await run(`window.__sent = null; window.submitMessage = async (m, o) => { window.__sent = [m, o]; return true; };`);
    const onRead = (await view()) === name && (await lastStep()) === (await t("cap.s.read")) && (await js(`$("cap-ho").className`)) === "btn-quiet";
    await click("cap-ho"); await wait(80);
    ok(`R-D1 ${name}:失敗在「讀取帳戶」列,quiet 交給 agent 送 promptRead`, onRead && (await js(`window.__sent && window.__sent[0]`)) === (await t("cap.ho.promptRead")));
  }
  await open({ platform: "Windows", venues: VEN, capital_connect: cc({ probe: { status: "failed", at: S, state: "timeout" } }) }, "capital");
  ok("R-D1 還沒有憑證紀錄時,確認帳密失敗照舊掛在憑證列", (await lastStep()) === (await t("cap.c.pick")));
  const enLocked = require("fs").readFileSync(path.join(SHELL, "i18n", "en.po"), "utf8").match(/msgid "cap\.err\.pwLocked"\nmsgstr "([^"]*)"/)[1];
  ok("R-D1 EN:Capital has locked your trading password.", enLocked === "Capital has locked your trading password.");

  // ⑧ 設定 › 帳戶 開通中
  await js(`cxModalClose(false)`);
  await setState({ platform: "Windows", venues: VEN, capital_connect: cc({ probe: { status: "failed", at: S, state: "no_accounts" } }), account: { venues: { capital: { ok: false, error: "account: no snapshot" } } } });
  await js(`(() => { TR = TR_BAGS.cloud; TR.st = TR_BAGS.cloud.st; TR.sig = {}; $("tr-set").hidden = false; trPaintSet(); })()`);
  const row = await js(`$("tr-set").textContent`);
  ok("⑧ 開通中那一列:群益 + 開通中 + 繼續;不畫讀帳失敗的紅字", row.indexOf(await t("cap.venue")) >= 0 && row.indexOf(await t("cap.pending")) >= 0 && (await js(`!!$("cap-continue")`)) && !(await js(`!!$("tr-set").querySelector(".plan-err:not(.is-calm)")`)));
  ok("⑧ 開通中讀帳失敗不算串接失敗(標頭不講 串接失敗);下單程式起來之後讀帳失敗照舊算", (await js(`trFailedIds(TR_BAGS.cloud.st.report).length`)) === 0
    && (await js(`trFailedIds(Object.assign({}, TR_BAGS.cloud.st.report, { capital_connect: Object.assign({}, TR_BAGS.cloud.st.report.capital_connect, { worker: { status: "ok" } }) })).length`)) === 1);
  await click("cap-continue"); await wait(80);
  ok("⑧ 按「繼續」→ 群益清單的簽署那一步", (await js(`CXF.venue`)) === "capital" && (await view()) === "c-sign");
  const TMW = require(path.join(SHELL, "telemetry.js"));
  const names = (await js(`window.__calls.filter((c) => c[0] === "trackFeature").map((c) => c[1][0])`)).concat(["cap_form_saved", "cap_setup_done", "cap_pfx_upload", "cap_sign_open", "cap_ready", "cap_rdp_open"]);
  ok("⑧ 埋點名字都在 feature_used 白名單上", names.every((n) => TMW.EVENTS ? TMW.EVENTS.feature_used.name.indexOf(n) >= 0 : true));

  console.log(red ? `${red} FAIL` : "ALL PASS");
  app.exit(red ? 1 : 0);
});
