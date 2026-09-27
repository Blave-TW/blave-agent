// 雲端群益開通的狀態機(shell/renderer/capital.js 的純邏輯段,從原文切出來跑)。
//   capital_connect(runtime/capital_connect.py 寫的那一份)+ 畫面自己的狀態 → spec-capital-connect-v2 §2 的哪一態。
//   逐一列舉 probe.state(契約表上的每一個)、每種「在跑」、過渡期(主機不認得 capital_*)、主機不是 Windows、
//   上傳失敗比確認帳密新、307 只試一次、卡住的 running 不算在跑。
// 跑法:node tests/check_shell_capital_view.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const src = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "capital.js"), "utf8");
const a = src.indexOf("/* ── 純邏輯"), b = src.indexOf("/* ── 純邏輯到此 ── */");
let red = 0; const ok = (n, c, got) => { console.log((c ? "PASS  " : "FAIL  ") + n); if (!c) { red++; if (got !== undefined) console.log("      got: " + JSON.stringify(got)); } };
if (a < 0 || b < 0) { console.log("FAIL  capital.js 找不到純邏輯段的記號"); process.exit(1); }
const head = src.slice(0, src.indexOf("const capBlank"));   // 常數(CAP_STEP_OF_BUSY、CAP_STUCK_MS…)
const blank = /const capBlank = \(\) => \((\{[\s\S]*?\})\);/.exec(src)[1];
const ctx = {}; vm.createContext(ctx);
vm.runInContext(head + "\nconst capBlank = () => (" + blank + ");\n" + src.slice(a, b) + "\nthis.capView = capView; this.capIsWindows = capIsWindows; this.capRunning = capRunning; this.capProbeRow = capProbeRow; this.capDate = capDate; this.capBlank = capBlank;", ctx);
const { capView, capIsWindows, capRunning, capProbeRow, capDate } = ctx;

const NOW = 1790000000 * 1000, S = NOW / 1000;
const W = { win: true, now: NOW };
const ui = (o) => Object.assign(ctx.capBlank(), { phase: "flow" }, o || {});
const cc = (o) => Object.assign({ v: 1, updated_at: S - 5, busy: null, vault: true,
  setup: { status: "ok", at: S - 100 }, cert: { status: "idle", at: null }, probe: { status: "idle", at: null }, worker: { status: "idle", at: null } }, o || {});
const view = (c, u, x) => capView(c, u || ui(), x || W);

// 入口
ok("主機不是 Windows → c-win(表單不出)", view(null, ui({ phase: "form" }), { win: false, now: NOW }) === "c-win");
ok("還不知道是不是 Windows(報告沒 platform)→ 不擋", view(null, ui({ phase: "form" }), { win: null, now: NOW }) === "c-form");
ok("platform=Windows / Linux / 沒有時看 os_type", capIsWindows({ platform: "Windows" }) === true && capIsWindows({ platform: "Linux" }) === false
  && capIsWindows({}, { machine: { os_type: "windows" } }) === true && capIsWindows({}, { machine: { os_type: "linux" } }) === false && capIsWindows(null, null) === null);
ok("過渡期:主機不認得 capital_* → c-handoff(不管狀態)", view(cc(), ui({ notCapable: true })) === "c-handoff");
ok("表單", view(null, ui({ phase: "form" })) === "c-form");
// 在跑的最先
ok("剛送 setup、回報還沒動(capital_connect 還不存在)→ 選做法那一態、元件列轉圈", view(null, ui({ sent: { step: "setup", at: NOW } })) === "c-pick" && capRunning(null, { step: "setup" }, NOW) === "setup");
ok("busy=capital_pfx → c-importing", view(cc({ busy: "capital_pfx" })) === "c-importing");
ok("上傳那一步的後半(busy 還是 capital_pfx、probe running)→ c-probe", view(cc({ busy: "capital_pfx", cert: { status: "ok", at: S - 3 }, probe: { status: "running", at: S - 2 } })) === "c-probe");
ok("cert importing → c-importing", view(cc({ cert: { status: "importing", at: S - 3 } })) === "c-importing");
ok("busy=capital_probe → c-probe", view(cc({ busy: "capital_probe" })) === "c-probe");
ok("剛按「我已解鎖」(sent unlock)→ c-probe", view(cc(), ui({ sent: { step: "unlock", at: NOW } })) === "c-probe");
ok("worker running → c-finish", view(cc({ worker: { status: "running", at: S - 3 } })) === "c-finish");
ok("卡在 running 超過 25 分鐘(主機重開打斷)不算在跑", capRunning(cc({ updated_at: S - 3600, probe: { status: "running", at: S - 3600 } }), null, NOW) === null);
ok("busy 但 updated_at 很久以前 → 不算在跑", capRunning(cc({ busy: "capital_setup", updated_at: S - 3600, setup: { status: "ok", at: S - 3600 } }), null, NOW) === null);
// 元件
ok("setup failed → c-setup-fail", view(cc({ setup: { status: "failed", at: S - 5, error: "SETUP_FAILED:script" } })) === "c-setup-fail");
ok("setup running 時可以先選做法(上傳鈕另外鎖)", view(cc({ setup: { status: "running", at: S - 5 } }), ui({ route: "pfx" })) === "c-pfx");
// 選做法
ok("元件好了、還沒選 → c-pick", view(cc()) === "c-pick");
ok("選了匯入 → c-pfx;選了遠端桌面 → c-rdp", view(cc(), ui({ route: "pfx" })) === "c-pfx" && view(cc(), ui({ route: "rdp" })) === "c-rdp");
ok("上傳失敗(cert failed)→ c-pfx(不管畫面選了什麼)", view(cc({ cert: { status: "failed", at: S - 5, error: "PFX_PASSWORD" } })) === "c-pfx");
ok("匯入成功、還沒確認帳密 → c-probe-idle", view(cc({ cert: { status: "ok", at: S - 5 } })) === "c-probe-idle");
// probe.state 逐一(契約表)
const P = (state, extra) => cc({ cert: { status: "ok", at: S - 60 }, probe: Object.assign({ status: state === "ok" ? "ok" : "failed", at: S - 30, state, code: null, futures: true, securities: true }, extra || {}) });
const TABLE = { ok: "c-finish", no_accounts: "c-sign", pw_wrong: "c-pw-err", pw_locked: "c-pw-locked", verify_needed: "c-verify",
  cert_old: "c-cert-bad", cert_unusable: "c-cert-bad", cert_expired: "c-cert-bad", device_code: "c-probe-fail", api_version: "c-setup-fail",
  no_credentials: "c-pw-err", vehicle_failed: "c-probe-fail", timeout: "c-probe-fail", unknown: "c-probe-fail" };
for (const [st, want] of Object.entries(TABLE)) ok(`probe.state=${st} → ${want}`, view(P(st)) === want, view(P(st)));
ok("沒見過的 state 也有出口 → c-probe-fail", view(P("something_new")) === "c-probe-fail");
// 簽署三態
ok("no_accounts:開過簽署頁 → c-sign-wait;按過我簽好了、還是讀不到 → c-sign-none", view(P("no_accounts"), ui({ signOpened: true })) === "c-sign-wait" && view(P("no_accounts"), ui({ signOpened: true, signChecked: true })) === "c-sign-none");
// 307 只試一次、300 重填
ok("307 還沒按過我已解鎖 → c-pw-locked;按過 → c-pw-change(只剩改密碼)", view(P("pw_locked")) === "c-pw-locked" && view(P("pw_locked"), ui({ unlockUsed: true })) === "c-pw-change");
ok("主機當場回 PW_RECHECK_NEEDED(recheck)→ 重填帳密,蓋過其他態", view(P("no_accounts"), ui({ recheck: true })) === "c-pw-err" && view(P("pw_locked"), ui({ recheck: true, unlockUsed: true })) === "c-pw-change");
ok("重填之後在跑的那一步優先(probe running 蓋過 recheck)", view(cc({ busy: "capital_probe" }), ui({ recheck: true })) === "c-probe");
// 上傳失敗比確認帳密新 → 講上傳的錯;比較舊 → 看 probe
ok("上傳失敗比上一次確認帳密新 → c-pfx", view(Object.assign(P("cert_unusable"), { cert: { status: "failed", at: S - 5, error: "PFX_OLDER" } })) === "c-pfx");
ok("上傳失敗比上一次確認帳密舊 → 照 probe", view(Object.assign(P("no_accounts"), { cert: { status: "failed", at: S - 90, error: "PFX_OLDER" } })) === "c-sign");
// 完成
ok("worker ok + 兩個市場 → c-done;只讀到證券 → c-done-ts", view(Object.assign(P("ok"), { worker: { status: "ok", at: S } })) === "c-done"
  && view(Object.assign(P("ok", { futures: false }), { worker: { status: "ok", at: S } })) === "c-done-ts");
ok("worker failed → c-finish-fail(不自動重送)", view(Object.assign(P("ok"), { worker: { status: "failed", at: S, error: "SNAPSHOT_TIMEOUT" } })) === "c-finish-fail");
// 稽核 S-1:這次開框重存過帳密(credsUpd = 送出前主機那份的 updated_at)→ 之前的確認帳密與下單程式不算數
const OLD = Object.assign(P("ok"), { worker: { status: "ok", at: S - 20 } });
ok("S-1 重綁後:舊的 worker ok 不算「已連接」、舊的 probe ok 不送 finish → c-probe-idle", view(OLD, ui({ credsUpd: S - 5 })) === "c-probe-idle"
  && view(Object.assign(P("ok"), { worker: { status: "idle", at: null } }), ui({ credsUpd: S - 5 })) === "c-probe-idle", view(OLD, ui({ credsUpd: S - 5 })));
ok("S-1 重綁後重新確認完(probe 比 credsUpd 新)→ c-finish;下單程式重起完 → c-done", view(Object.assign(P("ok", { at: S }), { worker: { status: "ok", at: S - 20 } }), ui({ credsUpd: S - 5 })) === "c-finish"
  && view(Object.assign(P("ok", { at: S }), { worker: { status: "ok", at: S + 5 } }), ui({ credsUpd: S - 5 })) === "c-done");
ok("S-1 舊的 pw_wrong 也不算:重綁後等新的結果", view(P("pw_wrong", { code: 300 }), ui({ credsUpd: S - 5 })) === "c-probe-idle");
ok("S-1 主機上本來沒有 capital_connect(credsUpd null)→ 有結果就算數", view(P("no_accounts"), ui({ credsUpd: null })) === "c-sign");
// 轉圈掛在哪一列
ok("重查掛在上一次結果那一列:簽署 / 檢核 / 帳密 / 憑證", capProbeRow(P("no_accounts")) === "sign" && capProbeRow(P("verify_needed")) === "verify" && capProbeRow(P("pw_locked")) === "pw" && capProbeRow(cc()) === "cert");
// 日期
ok("到期日 ISO → YYYY/MM/DD;壞的 → null", /^2027\/09\/2[67]$/.test(capDate("2027-09-26T15:59:59Z")) && capDate("nope") === null && capDate(null) === null);

console.log(red ? `${red} FAIL` : "ALL PASS");
process.exit(red ? 1 : 0);
