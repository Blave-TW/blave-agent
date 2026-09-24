// 版本混搭矩陣的外殼半邊(tests/check_version_matrix.py 的 V5 / V6 cells;文件
// .claude/output/specs/version-matrix-2026-09-24.md):新外殼(電腦版 0.0.5)讀到**舊形狀**與**新形狀**的
// api / 雲端回報時各怎麼畫。函式原文從 shell/ 切出來跑(同 check_shell_own_positions.js 的作法),形狀全用
// 固定樣本——舊形狀 = 欄位不在,另加型別不對的樣本(外殼不能把 "true" 當 true)。
// 跑法:node tests/check_version_matrix_shell.js [--src DIR] [--old-src DIR]
//   --src 讀哪一份 shell/(預設這個 repo);--old-src 舊的那一份(V6-01 比 VERSION 用,沒給就用 git HEAD)
const fs = require("fs"), path = require("path"), cp = require("child_process");
const argv = process.argv.slice(2), arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const SRC = path.resolve(arg("--src") || path.join(__dirname, "..")), OLD = arg("--old-src");
const rd = (p) => fs.readFileSync(path.join(SRC, p), "utf8");
const trade = rd("shell/renderer/trade.js"), app = rd("shell/renderer/app.js"), main = rd("shell/main.js"), strings = rd("shell/renderer/strings.js");
let red = 0;
const ok = (cid, name, c) => { console.log((c ? "PASS  " : "FAIL  ") + cid + "  " + name); if (!c) red++; return c; };
const note = (cid, s) => console.log("NOTE  " + cid + "  " + s);
function fnSrc(src, name) {
  const a = src.indexOf("function " + name + "(");
  if (a < 0) throw new Error("找不到 " + name);
  let i = src.indexOf("{", a), depth = 0;
  for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}" && --depth === 0) break; }
  return src.slice(a, i + 1);
}
const lineOf = (src, re) => { const m = re.exec(src); return m ? src.slice(0, m.index).split("\n").length : null; };

/* ── V5-01 account_status:舊 api(沒有 data_access / data_hour_paid)與新 api ── */
{
  const mainDA = eval("(" + fnSrc(main, "dataAccessOf") + ")"), appDA = eval("(" + fnSrc(app, "dataAccessOf") + ")");
  const hasData = (s) => { const a = appDA(s); return a === "included" || a === "billed"; };
  const OLD_IN = { can_run: true, data_included: true }, OLD_OUT = { can_run: true, data_included: false };
  const NEW = (a, x) => Object.assign({ can_run: true, data_access: a, data_included: a === "included", data_hourly: 2 }, x || {});
  const cases = [[OLD_IN, "included"], [OLD_OUT, null], [NEW("included"), "included"], [NEW("billed"), "billed"],
    [NEW("none"), "none"], [{ data_access: "later", data_included: true }, "included"], [{ data_access: 1, data_included: "true" }, null], [null, null]];
  ok("V5-01", "main.js 與 renderer 的 dataAccessOf 對每個樣本(舊/新/怪)給同一個答案", cases.every(([s, want]) => mainDA(s) === want && appDA(s) === want));
  ok("V5-01", "舊 api 不含資料(data_included:false)→ 當作沒有:不把資料 key 寫進 .env(main.js hasBlaveData 的條件)", !hasData(OLD_OUT) && hasData(OLD_IN));
  ok("V5-01", "新 api billed 算拿得到、none 不算", hasData(NEW("billed")) && !hasData(NEW("none")));
  ok("V5-01", "費用那一則已拿掉:新舊 api 的 data_hour_paid 外殼都不再讀(回合結束不出那一行)", !/data_hour_paid|dataFeeNote/.test(app));
  // pvK:舊 api 用 .old 那一版句子(那時沒有主機的人真的拿不到資料);每一個 pvK key 兩語都要有兩版
  var acct = null;
  const pvK = eval("(" + /const pvK = (\(k\) => [^;]+);/.exec(app)[1] + ")");
  acct = OLD_IN; const a1 = pvK("pv.e.sub"); acct = NEW("billed"); const a2 = pvK("pv.e.sub"); acct = null; const a3 = pvK("pv.e.sub");
  ok("V5-01", "pvK:舊 api / 查不到 → .old 句;新 api → 新句", a1 === "pv.e.sub.old" && a2 === "pv.e.sub" && a3 === "pv.e.sub.old");
  // 只算真的拿去 t() 翻的那些(pvK("pv.h.billed") === "pv.h.billed" 只是拿來判新舊,不查字串)
  const keys = [...new Set((app.match(/t\(pvK\("([^"]+)"\)/g) || []).map((m) => /"([^"]+)"/.exec(m)[1]))];
  const langs = (strings.match(/^  ([a-z]{2}): \{$/gm) || []).length;
  const miss = keys.filter((k) => [k, k + ".old"].some((kk) => (strings.split(`"${kk}":`).length - 1) < langs));
  ok("V5-01", `pvK 的 ${keys.length} 個 key 在 ${langs} 個語言都有新舊兩版(缺:${miss.join(", ") || "無"})`, keys.length > 0 && miss.length === 0);
}

/* ── V5-02 雲端回報:舊 runtime/舊 lib(沒有 self_ledger / can_trade_portfolio / weights)與新 ── */
{
  var TR = { st: { alive: true, report: null } }, t = (k) => k, LANG = "en";
  const pure = trade.slice(trade.indexOf("/* ── 純邏輯("), trade.indexOf("/* ── 純邏輯到此"));
  eval(pure.replace(/^const /gm, "var ").replace(/^let /gm, "var "));
  const trReport = () => TR.st.report;
  const lockM = /const locked = (!!x\.portfolio && !\(stored\[n\] > 0\) && !\(\(trReport\(\) \|\| \{\}\)\.can_trade_portfolio === true\));/.exec(trade);
  ok("V5-02", "撥款鎖的原文找得到(trade.js:" + lineOf(trade, /const locked = !!x\.portfolio/) + ")", !!lockM);
  const locked = (report, stored) => { TR.st.report = report; const x = { portfolio: true }, n = "basket"; return eval(lockM[1]); };
  ok("V5-02", "舊回報(沒有 can_trade_portfolio):投資組合的撥款鎖著", locked({}, {}) === true);
  ok("V5-02", "can_trade_portfolio 是字串 \"true\" / 1:照樣鎖(只認 true)", locked({ can_trade_portfolio: "true" }, {}) && locked({ can_trade_portfolio: 1 }, {}));
  ok("V5-02", "新回報 can_trade_portfolio:true → 解鎖", locked({ can_trade_portfolio: true }, {}) === false);
  ok("V5-02", "舊回報但已經撥過款(stored > 0)→ 不鎖(改金額 / 歸零要能做)", locked({}, { basket: 500 }) === false);
  // 目標:舊 lib 的 Type C 狀態沒有 weights、沒有 symbol → 不算任何目標(不猜);新狀態 → 每個資產
  const T0 = trClientTargets({ basket: 1000 }, { basket: { position: 0, market: "swap", updated_at: 1 } });
  ok("V5-02", "舊 Type C 狀態(沒有 weights):沒有目標列", JSON.stringify(T0) === "{}");
  const T1 = trClientTargets({ basket: 1000 }, { basket: { type: "portfolio", weights: { BTCUSDT: 0.5, ETHUSDT: 0.5 }, market: "swap" } });
  ok("V5-02", "新 Type C 狀態:金額 × 權重", T1.BTCUSDT === 500 && T1.ETHUSDT === 500);
  const T2 = trClientTargets({ basket: 1000 }, { basket: { weights: "BTCUSDT:1", symbol: null, market: "swap" } });
  ok("V5-02", "weights 型別不對(字串):不當權重、也不炸", JSON.stringify(T2) === "{}");
  // 自己的部位:只有 self_ledger === true 才講「只碰自己的」;欄位不在 / 1 / "true" 都當舊 lib(會碰手動部位,紅字是實話)
  const startOwnLine = /\.concat\(r\.self_ledger === true \? \[t\("tr\.startOwnOnly"\)\] : \[\]\)/.test(trade);
  ok("V5-02", "啟動框「只碰 Blave 自己的部位」那句只在 self_ledger === true 時出現(原文)", startOwnLine);
  const V = { binance: { credentials: true, pair: true, order: true, account: true } };
  const X = (self_ledger) => ({ venues: V, self_ledger, portfolio_configured: true,
    reconciler: { stopped: { reason: "machine_restart", gated: true } }, last_reconcile: { actual: { BTCUSDT: { side: "long", size: 50 } } } });
  ok("V5-02", "解除暫停框:舊回報(沒有 self_ledger)→ x1(帳上的部位會被平,照舊警告)", trReleaseKind(X(undefined)).kind === "x1" && trReleaseKind(X(1)).kind === "x1" && trReleaseKind(X("true")).kind === "x1");
  ok("V5-02", "解除暫停框:新回報 self_ledger:true → x2(只講機器人的部位)", trReleaseKind(X(true)).kind === "x2");
  note("V5-02", "部位分頁的舊 lib 畫法(整個帳戶畫成要平)由 tests/check_shell_own_positions.js §4 釘住,這裡不重複");
}

/* ── V5-03 雲端舊 runtime(1.1.89)不在「啟動下單」時起對帳器 ── */
{
  const m = /const trRunStart = \(cmd\) => trRun\("running", cloud \? \[\(S\) => trSend\(S, cmd, \{\}\)\] : \[/.exec(trade);
  ok("V5-03", "電腦版的雲端啟動只送 resume / resume_wait 一個指令(trade.js:" + lineOf(trade, /const trRunStart = /) + ")", !!m);
  const shipped = /const CLOUD_SHIPPED = \[([^\]]+)\]/.exec(main);
  ok("V5-03", "主行程也不放行 restart_reconciler 上雲端(CLOUD_SHIPPED)", !!shipped && !/restart_reconciler/.test(shipped[1]));
  var TR = { st: { alive: true, report: null } };
  const pure = trade.slice(trade.indexOf("/* ── 純邏輯("), trade.indexOf("/* ── 純邏輯到此"));
  eval(pure.replace(/^const /gm, "var ").replace(/^let /gm, "var "));
  // 舊 runtime 收到 resume:HALT 清掉、對帳器沒起來(沒有重開紀錄時)。雲端下一份回報長這樣
  const rep = { venues: { paper: { credentials: true, pair: true, order: true, account: true } }, halt: { halted: false }, reconciler: { alive: false, heartbeat_at: null } };
  const st = { alive: true, report: rep };
  const s = trExecState(st);
  ok("V5-03", `舊雲端 runtime:按了啟動、對帳器沒起來 → 狀態「${s}」,不是「執行中」(不會假裝在下單)`, s === "dead");
  ok("V5-03", "…對帳器沒在跑的判斷(trRecRunning)也是 false", trRecRunning(st) === false);
  note("V5-03", "使用者看到「對帳器停了」那一態;電腦版沒有雲端重啟鈕,要到網頁工作頁按(網頁會補送 restart_reconciler)。"
    + "runtime 1.1.90 發佈後約 5 分鐘自動更新到新 runtime,之後同一個按鈕就會起對帳器(check_version_matrix.py V1-01)");
}

/* ── V5-04 最低版本閘:api 還沒提高 Desktop.min_version 之前,0.0.4 照常 ── */
{
  const mv = require(path.join(SRC, "shell", "minversion.js"));
  ok("V5-04", "舊 api(public_tiers 沒有 desktop 鍵)→ 不擋", mv.minFromBody({}) === null && mv.isBlocked("0.0.4", mv.minFromBody({})) === false);
  ok("V5-04", "api 提高到 0.0.5:0.0.4 被擋、0.0.5 / 0.0.5-beta.1 不擋", mv.isBlocked("0.0.4", "0.0.5") && !mv.isBlocked("0.0.5", "0.0.5") && !mv.isBlocked("0.0.5-beta.1", "0.0.5"));
  const ver = JSON.parse(rd("shell/package.json")).version;
  note("V5-04", `shell/package.json 現在是 ${ver}:出 0.0.5 時要先改版號,否則 api 提高 min_version 會連新包一起擋`);
  ok("V5-04", "外殼版號 ≥ 0.0.5(出貨前的閘;現在還沒改就會是 FAIL)", !mv.isBlocked(ver, "0.0.5"));
}

/* ── V5-05 權益曲線:0.0.4 記的點沒有 basis ── 既有的 tests/check_shell_assets.js ── */
{
  const r = cp.spawnSync(process.execPath, [path.join(SRC, "tests", "check_shell_assets.js")], { encoding: "utf8", timeout: 120000 });
  const fails = (r.stdout || "").split("\n").filter((l) => /^FAIL/.test(l));
  ok("V5-05", `tests/check_shell_assets.js(舊點沒有 basis = equity,換口徑不跨算當日損益)exit ${r.status}${fails.length ? ":" + fails.join(" | ") : ""}`, r.status === 0);
}

/* ── V6-01 電腦版換包時只在「隨包 VERSION 比 workspace 新」才拷 lib ── */
{
  const m = /const officialStale = (\(bundled, ws\) => [^;]+);/.exec(main);
  const officialStale = eval(m[1]);
  ok("V6-01", "officialStale:VERSION 一樣 → 不拷(新 runtime + 舊 lib)", officialStale("2026-09-23-b", "2026-09-23-b") === false && officialStale("2026-09-24", "2026-09-23-b") === true);
  const newV = rd("VERSION").trim();
  let oldV = null;
  try { oldV = OLD ? fs.readFileSync(path.join(OLD, "VERSION"), "utf8").trim() : cp.execSync("git -C " + JSON.stringify(SRC) + " show HEAD:VERSION", { encoding: "utf8" }).trim(); } catch (_) { oldV = null; }
  const libSame = (() => {
    if (!OLD) { try { return cp.execSync("git -C " + JSON.stringify(SRC) + " status --porcelain -- lib manager references examples allocators AGENTS.md CLAUDE.md strategies/TEMPLATE_A.py strategies/TEMPLATE_C.py", { encoding: "utf8" }).trim() === ""; } catch (_) { return null; } }
    const r = cp.spawnSync("diff", ["-rq", "-x", "__pycache__", path.join(OLD, "lib"), path.join(SRC, "lib")]);
    return r.status === 0;
  })();
  note("V6-01", `workspace VERSION:舊 ${oldV}、新 ${newV};官方檔${libSame ? "沒變" : "有變"}`);
  ok("V6-01", "官方檔有變時 VERSION 必須比舊的大——否則電腦版換包後不拷新 lib,雲端「更新」也不會亮(出貨前的閘)", libSame || (oldV !== null && officialStale(newV, oldV)));
}

/* ── V6-05 兩邊的「更新」指示(v4:關於一行 + 聊天那一格;沒有更新鈕、沒有 S0–S7)── */
{
  const upPlan = eval("(" + fnSrc(app, "upPlan") + ")");
  const P = (cv, lv, ph, x) => upPlan({ up: { phase: ph || "idle", current: "0.0.5", checkedAt: 1 }, cloud: { config_version: cv, latest_config_version: lv }, kind: "running", localTurn: false, mem: {}, now: 0, cloudStale: false, wu: null, ...(x || {}) });
  const same = P("2026-09-23-b", "2026-09-23-b"), lag = P("2026-09-23-b", "2026-09-24");
  ok("V6-05", "雲端 VERSION 落後 → cloudLag、關於列不寫「已是最新版」(也沒有第四個狀態;更新走檢查更新→本機 agent)", lag.cloudLag === true && lag.row.status === null && lag.slot === null);
  ok("V6-05", "雲端 VERSION 等於最新 → 已是最新版、沒有東西可按(VERSION 沒 bump 的 lib 改動雲端永遠看不到)", same.cloudLag === false && same.row.status[0] === "up.row.latest" && same.slot === null && same.link.kind === "check");
  const loc = P("2026-09-24", "2026-09-24", "ready");
  ok("V6-05", "這台電腦那一半只看 app 更新器(外殼版號),跟 workspace VERSION 無關:ready → 「重新啟動以完成更新」", loc.slot && loc.slot.kind === "restart" && loc.link.kind === "restart" && loc.row.status[0] === "up.row.ready");
  const both = P("2026-09-23-b", "2026-09-24", "ready");
  ok("V6-05", "兩邊都有新版:app 那半照樣給重新啟動;雲端那半不擋它", both.slot && both.slot.kind === "restart" && both.cloudLag === true);
  const unk = P(null, "2026-09-24");
  ok("V6-05", "雲端還沒回報版號(舊機器 / 讀不到)→ 不算落後、不寫雲端那段(不猜)", unk.cloudLag === false && !unk.row.segs.some((s) => s[0] === "up.row.cloud"));
  const applying = P("2026-09-23-b", "2026-09-24", "idle", { wu: { state: "applying" } });
  ok("V6-05", "新形狀:報告帶 workspace_update.state = applying → 那一格「更新中…」;舊形狀(沒有那個欄位)沒有 (c)", applying.slot && applying.slot.kind === "applying" && lag.slot === null);
}

console.log(red ? `\n${red} FAIL` : "\nall pass");
process.exit(red ? 1 : 0);
