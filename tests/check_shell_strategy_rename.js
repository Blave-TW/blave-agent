// 側欄策略改名的外殼這一半(spec strategy-rename-2026-11-05;lib：tests/check_strategy_rename.py、runtime：tests/check_rename_command.py)。
// 真碼從原文切出來跑,不開 Electron:
//  ① main.js 的 codeHash 跟 lib 同一個定義(tests/fixtures/code_hash_name.json),舊的整檔 hash 也認;〔改名〕的能力看 lib 的 STRATEGY_RENAME
//  ② rename_strategy:daemon 只收 {name, display_name}、雲端兩份白名單都有、埋點白名單有 strat_rename
//  ③ 名稱規則三常數 = lib.strategy(NAME_MAX、不收的字、包在 [ ] 裡);同名比對 NFKC + 小寫、不比自己;打到 60 字是提示不是錯
//  ④ 錯誤碼對應的 key 兩語都在;選單:〔改名〕在第一條線下第一項、移到資料夾上面不再有線;編輯列擋重建、回合結束照失焦收
// 跑法:node tests/check_shell_strategy_rename.js
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const ROOT = path.join(__dirname, ".."), SH = path.join(ROOT, "shell"), R = path.join(SH, "renderer");
const read = (p) => fs.readFileSync(p, "utf8");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + JSON.stringify(d).slice(0, 300))); if (!c) red++; };
const lineOf = (src, re) => { const m = re.exec(src); return m ? m[0] + "\n" : ""; };
function fnOf(src, name) {
  let a = src.indexOf("function " + name + "("); if (a < 0) return "";
  let i = src.indexOf("{", src.indexOf(")", a)), d = 0;
  for (; i < src.length; i++) { if (src[i] === "{") d++; else if (src[i] === "}" && --d === 0) break; }
  return src.slice(a, i + 1);
}

// ① hash
const main = read(path.join(SH, "main.js"));
const hashSrc = ["HASH_NAME_LINE_RE", "sha16", "codeHash", "codeHashMatches"].map((k) => lineOf(main, new RegExp("^const " + k + " = [^\\n]*", "m"))).join("");
const H = new Function("crypto", hashSrc + "return { codeHash, codeHashMatches, sha16 };")(crypto);
const fx = JSON.parse(read(path.join(__dirname, "fixtures", "code_hash_name.json")));
for (const c of fx.cases) {
  const want = crypto.createHash("sha256").update(Buffer.from(c.norm, "utf8")).digest("hex").slice(0, 16);
  ok("① codeHash fixture: " + c.why, H.codeHash(Buffer.from(c.src, "utf8")) === want, H.codeHash(Buffer.from(c.src, "utf8")));
}
{ const b = Buffer.from('A = 1\nDISPLAY_NAME = "x"\n', "utf8");
  ok("① codeHashMatches 認舊的整檔 hash,不認 null", H.codeHashMatches(b, H.sha16(b)) && H.codeHashMatches(b, H.codeHash(b)) && !H.codeHashMatches(b, null)); }
ok("① 掃描／樣本外的過時判斷改用 codeHashMatches(改名不算改碼)", /!codeHashMatches\(codeBuf, r\.code_hash\)/.test(main) && !/digest\("hex"\)\.slice\(0, 16\); for \(const r of \[scan, wf\]\)/.test(main));
ok("① 本機〔改名〕的能力 = lib 的 STRATEGY_RENAME 那一行,listStrategies 每支帶 renamable",
  /function libRenames\(ws\)[\s\S]{0,400}\/\^STRATEGY_RENAME\\s\*=\\s\*1\\b\/m\.test/.test(main) && /version: stratVersionNow\(dir\), renamable, jobRunning \}/.test(main));
ok("① lib/strategy.py 有那一行", /^STRATEGY_RENAME\s*=\s*1\b/m.test(read(path.join(ROOT, "lib", "strategy.py"))));

// ② 指令與埋點白名單
const daemon = require(path.join(SH, "daemon.js")), tele = require(path.join(SH, "telemetry.js"));
ok("② daemon UI_COMMANDS 有 rename_strategy", daemon.UI_COMMANDS.has("rename_strategy"));
const good = { name: "abc_1", display_name: "均線 A" };
const shapes = [[good, true], [{ name: "abc", display_name: "" }, true], [{ name: "abc" }, false], [{ display_name: "x" }, false],
  [{ ...good, n: 1 }, false], [{ name: "a.b", display_name: "x" }, false], [{ name: "x".repeat(129), display_name: "x" }, false],
  [{ name: "abc", display_name: 5 }, false], [{ name: "abc", display_name: "x".repeat(401) }, false]];
for (const [a, want] of shapes) ok("② argsOk(rename_strategy, " + JSON.stringify(a).slice(0, 60) + ") = " + want, daemon.argsOk("rename_strategy", a) === want);
const shipped = JSON.parse(lineOf(main, /const CLOUD_SHIPPED = (\[[^\]]*\])/).replace(/^.*?= /, "").replace(/;\s*$/, ""));
const trade = read(path.join(R, "trade.js")), envCmds = JSON.parse(lineOf(trade, /^const ENV_CLOUD_CMDS = [^\n]*/m).replace(/^.*?= /, "").replace(/;\s*$/, ""));
ok("② 雲端兩份白名單(main.js CLOUD_SHIPPED、trade.js ENV_CLOUD_CMDS)都有 rename_strategy", shipped.includes("rename_strategy") && envCmds.includes("rename_strategy"));
const feat = tele.EVENTS.feature_used && tele.EVENTS.feature_used.name;
ok("② feature_used 白名單有 strat_rename(≤16 字)", Array.isArray(feat) && feat.includes("strat_rename") && "strat_rename".length <= 16);
ok("② 雲端清單帶 renamable(runtime 報告 = true 才算)", /renamable: x\.renamable === true/.test(trade));

// ③ 名稱規則
const rn = read(path.join(R, "stratrename.js")), lib = read(path.join(ROOT, "lib", "strategy.py"));
const consts = ["SRN_NAME_MAX", "SRN_NAME_BAD", "srnWrapped", "srnCp", "srnFold"].map((k) => lineOf(rn, new RegExp("^const " + k + " = [^\\n]*", "m"))).join("");
const P = (list) => new Function("RP", "TR_BAGS", "envCloudList", consts + fnOf(rn, "srnOthers") + fnOf(rn, "srnProblem") + "return { srnProblem, SRN_NAME_MAX, SRN_NAME_BAD };")({ list }, { cloud: {} }, () => []);
const L = P([{ name: "me", displayName: "我" }, { name: "other", displayName: "Ｔrend Ａ" }, { name: "plain_id", displayName: null }]);
ok("③ NAME_MAX = lib NAME_MAX = 60", L.SRN_NAME_MAX === 60 && /^NAME_MAX = 60$/m.test(lib));
ok("③ 不收的字跟 spec 同一組 `、;:；：「」\"\\`,lib 也都不收", [..."、;:；：「」\"\\"].every((c) => L.SRN_NAME_BAD.test("a" + c) && lib.includes(c === "\\" ? "\\\\\\\\" : c)));
const sp = (v) => { const p = L.srnProblem({ env: "local" }, "me", v); return p ? p.key + (p.hint ? "+hint" : "") + (p.c ? ":" + p.c : "") : null; };
const cases = [["趨勢 B", null], ["a;b", "strat.nameBad:;"], ["名「x」", "strat.nameBad:「"], ["[範本]", "strat.nameWrapped"], ["[測試] 均線", null],
  ["ETH（4h）", null], ["trend a", "strat.nameDup"], [" PLAIN_ID ", "strat.nameDup"], ["我", null], ["x".repeat(60), "strat.nameMax+hint"], ["x".repeat(59), null]];
for (const [v, want] of cases) ok("③ srnProblem(" + JSON.stringify(v.slice(0, 12)) + ") = " + want, sp(v) === want, sp(v));
ok("③ 字數按 code point(不是 UTF-16 單位)", /Array\.from\(v\)\.length/.test(rn) && /Array\.from\(ed\.input\.value\)\.slice\(0, SRN_NAME_MAX\)/.test(rn));

// ④ 錯誤碼、字、選單、生命週期
const errKeys = JSON.parse(lineOf(rn, /^const SRN_ERR_KEYS = [\s\S]*?\};/m).replace(/^.*?= /, "").replace(/;\s*$/, "").replace(/(\w+):/g, '"$1":'));
ok("④ 錯誤碼表涵蓋 lib／runtime 的每個拒絕碼", ["BAD_NAME", "DUPLICATE", "TURN_RUNNING", "JOB_RUNNING", "NOT_LITERAL", "NOT_FOUND"].every((k) => k in errKeys));
const S = new Function(read(path.join(R, "strings.js")) + "; return STRINGS;")();
const keys = ["strat.rename", "strat.menu", "strat.nameAria", "strat.nameMax", "strat.nameBad", "strat.nameWrapped", "strat.nameDup", "strat.renameGone", "strat.renameNoLiteral", "strat.renameFail", "strat.renameJob", "strat.renamed"]
  .concat(Object.values(errKeys).filter(Boolean));
ok("④ 用到的 key 兩語都有", keys.every((k) => S.en[k] && S.zh[k]), keys.filter((k) => !S.en[k] || !S.zh[k]));
ok("④ {c}／{name} 佔位在兩語都在", S.zh["strat.nameBad"].includes("{c}") && S.en["strat.nameBad"].includes("{c}") && S.en["strat.menu"].includes("{name}") && S.zh["strat.renamed"].includes("{name}"));
const flags = read(path.join(R, "stratflags.js")), build = fnOf(flags, "sfPopBuild");
ok("④ 選單順序:旗標 — 改名、移除旗標、送上雲端／拉回、移到資料夾 — 移到垃圾桶(最多兩條線:搬家與移到資料夾上面都沒有線)", /sfPop\.append\(d1, rn, rm, ho, moves, d2, del\)/.test(build) && !/const dm = sep\(\)/.test(build) && !/const dh = sep\(\)/.test(build) && /hidden = !\(canRn \|\| cur \|\| hoDir \|\| mv\)/.test(fnOf(flags, "sfPopOpen")));
ok("④ 選單 aria-label 用 strat.menu", /t\("strat\.menu", \{ name: x\.displayName \|\| x\.name \}\)/.test(fnOf(flags, "sfPopText")));
ok("④ 停用 = aria-disabled、按了沒反應;機器不會改名就不出", /rn\.getAttribute\("aria-disabled"\) === "true"\) return/.test(build) && /rn\.hidden = !canRn/.test(fnOf(flags, "sfPopOpen")));
ok("④ 改名列開著時擋住清單重建(sgEditing 看 SRN.edit)", /SRN\.edit/.test(lineOf(flags, /^const sgEditing = [^\n]*/m)));
ok("④ 回合結束與開資料夾編輯列都先照失焦收", /srnCommit\(\)/.test(read(path.join(R, "app.js"))) && /srnCommit\(\)/.test(fnOf(read(path.join(R, "stratgroups.js")), "sgEditOpen")));
ok("④ 輸入法組字中的 Enter／Esc 不算", /e\.isComposing \|\| e\.keyCode === 229\) return/.test(rn));
const html = read(path.join(R, "index.html"));
ok("④ index.html 在 stratgroups.js 之後載入 stratrename.js", html.indexOf('src="stratrename.js"') > html.indexOf('src="stratgroups.js"') && html.indexOf('src="stratgroups.js"') > 0);

// ⑤ 設計稽核(strategy-rename-desktop-audit-2026-11-05)
const daemonSrc = read(path.join(SH, "daemon.js"));
ok("⑤ 主行程等 ack 90 秒 > runtime 給改名的 60 秒(冷啟動第一次也等得到)", daemon.CMD_TIMEOUT_MS.rename_strategy === 90000
  && /_RENAME_TIMEOUT_S = 60\b/.test(read(path.join(ROOT, "runtime", "command_listener.py"))));
{ const ack = new Function(fnOf(rn, "srnAck") + "return srnAck;")();
  ok("⑤ 結果不明(UNKNOWN_RESULT／雲端 unknown／沒回)不算失敗;TIMEOUT 是確定沒執行", ack({ ok: false, error: "UNKNOWN_RESULT" }).unknown && ack({ ok: false, kind: "unknown", error: "x" }).unknown
    && ack(null).unknown && !ack({ ok: false, error: "TIMEOUT" }).unknown && ack({ ok: false, error: "ValueError: DUPLICATE: x" }).code === "DUPLICATE"); }
{ const save = fnOf(rn, "srnSave");
  ok("⑤ 結果不明時先重讀名字(srnLanded),已經是新名字就照成功處理、送埋點", /const landed = a\.unknown && await srnLanded\(/.test(save) && /if \(a\.ok \|\| landed\) \{ await srnDone\(/.test(save)
    && /trackFeature\("strat_rename"\)/.test(fnOf(rn, "srnDone")) && !/if \(changed\)/.test(fnOf(rn, "srnDone")));
  const L2 = new Function("window", "TR_BAGS", "envCloudList", "async " + fnOf(rn, "srnLanded") + "return srnLanded;");
  const landed = L2({ blave: { listStrategies: async () => [{ name: "a", displayName: "新名" }] } }, {}, () => []);
  landed({ env: "local" }, "a", "新名").then((y) => landed({ env: "local" }, "a", "別的").then((n) => ok("⑤ srnLanded 照清單裡顯示的名字判", y === true && n === false))); }
{ const paint = fnOf(rn, "srnPaintErr");
  ok("⑤ 機器回的錯只寫一行字,框不變紅(紅框只給名稱規則)", /const err = ed\.err, bad = !!p && !p\.hint && !p\.machine;/.test(paint) && /machine: true \}/.test(fnOf(rn, "srnSave"))); }
ok("⑤ JOB_RUNNING 講正在重跑,不叫人按 Enter 再試", errKeys.JOB_RUNNING === "strat.renameJob" && S.zh["strat.renameJob"] && !/Enter/.test(S.en["strat.renameJob"]));
ok("⑤ 兩句錯誤字照 recheck 縮成 web 窄側欄也一行放得下", S.zh["strat.renameNoLiteral"] === "在對話裡請 agent 改。" && S.zh["strat.renameJob"] === "正在重跑回測，跑完再改。");
ok("⑤ 背景重跑時停用:本機清單每支帶 jobRunning,srnLocked 先看它", /if \(x\.jobRunning === true\) return true;/.test(fnOf(rn, "srnLocked")) && /renamable, jobRunning \}/.test(main));
const css = read(path.join(R, "app.css"));
ok("⑤ 框貼齊列的 hover 底、框裡的字對齊列字(11 + 1px 框 = 12)、轉圈在框內、框下那行對齊框裡的字",
  /\.srn-edit \{[^}]*padding: 0 0 0 var\(--space-12\);/.test(css) && /\.srn-input \{[^}]*padding: 0 var\(--space-6\) 0 11px;/.test(css)
  && /\.srn-ring \{[^}]*right: var\(--space-6\);/.test(css) && /\.srn-err \{ margin: var\(--space-2\) var\(--space-12\) var\(--space-6\) calc\(var\(--space-12\) \+ var\(--space-12\)\);/.test(css));
ok("⑤ 不收的字放在 --surface-muted 小底塊裡", /\.srn-err \.srn-ch \{[^}]*background: var\(--surface-muted\);/.test(css) && /\.srn-err \.srn-ch \{[^}]*border-radius: var\(--radius-xs\);/.test(css));

{ const done = fnOf(rn, "srnDone");
  ok("⑦ 存好後只在焦點原本在編輯列或 body 時交還那一列(點到別處就不搶;recheck §3)",
    /const ae = document\.activeElement, back = ed\.node\.contains\(ae\) \|\| ae === document\.body/.test(done) && done.indexOf("back =") < done.indexOf("srnEnd(true)") && /if \(b && back\) b\.focus\(\);/.test(done)); }
// ⑥ 改名後留在原位(Wei 11-05):lib 還原 mtime,主行程照 mtime 排、快取 key 帶 ctime 才讀得到新名字
{ const os = require("os"), dir = fs.mkdtempSync(path.join(os.tmpdir(), "srn-order-"));
  for (const [n, t] of [["a", 3], ["b", 2], ["c", 1]]) { fs.mkdirSync(path.join(dir, n)); const f = path.join(dir, n, "strategy.py"); fs.writeFileSync(f, `DISPLAY_NAME = "${n}"\n`); fs.utimesSync(f, t * 1000, t * 1000); }
  const pick = (k) => lineOf(main, new RegExp("^const " + k + " = [^\\n]*", "m"));
  const env = { fs, path, STRAT_DIR: () => dir, stratNames: () => ["a", "b", "c"], stratCache: new Map(), num: (v) => v, stratVersionNow: () => null,
    stratPerf: () => null, stratRerun: () => null, libRenames: () => true, tm: () => ({ track() {} }), stratAnnReturn: () => null };
  const L3 = new Function(...Object.keys(env), pick("stratTouchedAt") + pick("stratOrder") + fnOf(main, "stratMeta") + fnOf(main, "stratLogic") + fnOf(main, "listStrategies") + "return listStrategies;")(...Object.values(env));
  const first = L3().map((x) => x.name).join();
  const f = path.join(dir, "c", "strategy.py"), st = fs.statSync(f);
  fs.writeFileSync(f + ".tmp", 'DISPLAY_NAME = "改過"\n'); fs.renameSync(f + ".tmp", f); fs.utimesSync(f, st.atime, st.mtime);   // = lib.strategy.rename
  const after = L3();
  ok("⑥ 改名(檔換掉、mtime 還原)後順序不變、顯示名換新", first === "a,b,c" && after.map((x) => x.name).join() === "a,b,c" && after[2].displayName === "改過", [first, after.map((x) => x.name + ":" + x.displayName)]);
  fs.rmSync(dir, { recursive: true, force: true }); }

console.log(red ? `\nFAIL: ${red}` : "\nOK");
process.exit(red ? 1 : 0);
