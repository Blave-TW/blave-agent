// 缺資料來源金鑰(0.1.15):策略頁 #rp-nobt 的缺金鑰態 + 設定 › 資料來源的「還沒有金鑰」列。
// 守的東西:missingSources 只比來源不比欄位、不交值;兩頁口徑一致(helper 檔也算);#rp-nobt 三態互斥、雲端視角不出;
// list().missing 的內容;從缺金鑰列新增 = 名稱預填且唯讀、欄位預填、焦點在貼金鑰框。不開視窗。跑法:node tests/check_shell_missing_key.js
const fs = require("fs"), os = require("os"), path = require("path");
const SHELL = path.join(__dirname, "..", "shell"), R = path.join(SHELL, "renderer");
const D = require("../shell/datasrc.js");
let red = 0; const ok = (n, c, info) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || !info ? "" : "  → " + info)); if (!c) red++; };
const cut = (src, name) => { const i = src.indexOf("function " + name + "("); if (i < 0) throw new Error("no " + name); let d = 0; for (let k = src.indexOf("{", i); k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}" && --d === 0) return src.slice(i, k + 1); } throw new Error("no " + name); };

// ---- 極簡 DOM(只夠這兩頁的畫法用) ----
function el(tag) {
  const e = { tagName: tag.toUpperCase(), children: [], parent: null, className: "", dataset: {}, attrs: {}, listeners: {}, hidden: false, readOnly: false, value: "", _text: "",
    classList: { add: (c) => { const s = new Set(e.className.split(/\s+/).filter(Boolean)); s.add(c); e.className = [...s].join(" "); }, remove: (c) => { e.className = e.className.split(/\s+/).filter((x) => x && x !== c).join(" "); },
      contains: (c) => e.className.split(/\s+/).includes(c), toggle: (c, on) => (on ? e.classList.add(c) : e.classList.remove(c)) },
    append(...ns) { for (const n of ns) { const x = typeof n === "string" ? { text: n, children: [] } : n; x.parent = e; e.children.push(x); } }, appendChild(n) { e.append(n); return n; },
    get textContent() { return e._text + e.children.map((c) => (c.text != null ? c.text : c.textContent)).join(""); },
    set textContent(v) { e.children = []; e._text = String(v); },
    setAttribute(k, v) { e.attrs[k] = String(v); }, getAttribute(k) { return k in e.attrs ? e.attrs[k] : null }, removeAttribute(k) { delete e.attrs[k]; },
    addEventListener(t, f) { (e.listeners[t] = e.listeners[t] || []).push(f); }, dispatchEvent(ev) { (e.listeners[ev.type] || []).forEach((f) => f(ev)); },
    click() { (e.listeners.click || []).forEach((f) => f({ currentTarget: e })); }, focus() { doc.activeElement = e; },
    querySelectorAll(sel) { return all(e).filter((x) => x !== e && sel.split(",").some((s) => match(x, s.trim().split(/\s+/), e))); },
    querySelector(sel) { return e.querySelectorAll(sel)[0] || null; },
    get isConnected() { return true; } };
  return e;
}
const all = (e) => [e, ...e.children.filter((c) => c.tagName).flatMap(all)];
function one(x, s) {
  const m = /^([a-z0-9]*)((?:[#.][\w-]+)*)((?:\[[\w-]+\])*)(:not\(\[(\w+)\]\))?$/.exec(s); if (!m) throw new Error("selector " + s);
  if (m[1] && x.tagName !== m[1].toUpperCase()) return false;
  for (const p of m[2].match(/[#.][\w-]+/g) || []) { if (p[0] === "#" ? x.id !== p.slice(1) : !x.classList.contains(p.slice(1))) return false; }
  for (const a of m[3].match(/\[[\w-]+\]/g) || []) { const k = a.slice(1, -1); if (k.startsWith("data-") ? !(k.slice(5) in x.dataset) : !(k in x.attrs)) return false; }
  if (m[5] && x[m[5] === "readonly" ? "readOnly" : m[5]]) return false;
  return true;
}
function match(x, parts, root) {
  if (!one(x, parts[parts.length - 1])) return false;
  let rest = parts.slice(0, -1), p = x.parent;
  while (rest.length && p && p !== root.parent) { if (one(p, rest[rest.length - 1])) rest = rest.slice(0, -1); if (p === root) break; p = p.parent; }
  return !rest.length;
}
const doc = { activeElement: null, createElement: el, createTextNode: (s) => ({ text: s, children: [] }) };

(async () => {
  // ================= 主行程:datasrc.js =================
  const WS = fs.mkdtempSync(path.join(os.tmpdir(), "blave-miss-")), ENVF = path.join(WS, ".env");
  const mk = (name, files) => { const d = path.join(WS, "strategies", name); fs.mkdirSync(d, { recursive: true }); for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(d, f), c); return { name, displayName: name.toUpperCase(), file: path.join(d, "strategy.py"), dir: d }; };
  const SECRET = "sk_live_should_never_leave_9f3";
  const S = [
    mk("a", { "strategy.py": 'K = os.environ["DATA_FINMIND_TOKEN"]\nF = os.environ["DATA_FRED_KEY"]\n' }),
    mk("b", { "strategy.py": "from helper import x\n", "helper.py": 'T = os.environ["DATA_FINMIND_USER"]\nP = os.environ["DATA_POLYGON_KEY"]\n', "notes.txt": "DATA_TXTONLY_KEY\n" }),
    mk("c", { "strategy.py": 'X = os.environ["DATA_API_KEY"]\nY = os.environ["DATA_GHOST_KEY"]\n' }),
  ];
  fs.writeFileSync(ENVF, `${D.BEGIN}\n# source FRED added=1\nDATA_FRED_SECRET='${SECRET}'\n# source GHOST added=2\n${D.END}\n`);
  const ds = D.createDataSrc({ envFile: ENVF, lock: () => Promise.resolve(() => {}), strategies: () => S, trading: () => ({ live: false }) });
  const l = ds.list(), miss = Object.fromEntries((l.missing || []).map((m) => [m.name, m]));
  ok("list().missing:清單裡沒有的來源都列(含只在 helper.py 用到的 POLYGON);清單有的 FRED 不列", l.ok && JSON.stringify(Object.keys(miss)) === JSON.stringify(["FINMIND", "GHOST", "POLYGON"]), JSON.stringify(l.missing));
  ok("只有一行 `# source` 註解、零欄位的來源 = 沒有,算缺(GHOST)", !!miss.GHOST && !l.sources.some((s) => s.name === "GHOST"));
  ok("只比來源不比欄位:清單 FRED 只有 SECRET、程式碼用 DATA_FRED_KEY,不算缺", !miss.FRED && l.sources.some((s) => s.name === "FRED"));
  ok("fields = 程式碼裡寫到的欄位名(跨策略、跨檔合併、排序);usedBy = 用到它的策略顯示名", miss.FINMIND && JSON.stringify(miss.FINMIND.fields) === '["TOKEN","USER"]' && JSON.stringify(miss.FINMIND.usedBy) === '["A","B"]');
  ok("交易所形狀(DATA_API_KEY)與非 .py 檔不算", !miss.API && !miss.TXTONLY);
  ok("list() 整份輸出不含任何值", !JSON.stringify(l).includes(SECRET));
  ok("names():清單上的來源名,零欄位的不算,不含值", JSON.stringify(ds.names()) === '["FRED"]');
  ok("missingOf:用到 − 清單(只比名稱)", JSON.stringify(D.missingOf(["FINMIND", "FRED", "POLYGON"], ["FRED"])) === '["FINMIND","POLYGON"]' && JSON.stringify(D.missingOf(null, [])) === "[]");
  const many = Array.from({ length: D.MAX_SOURCES + 5 }, (_, i) => "S" + i);
  const big = mk("big", { "strategy.py": many.map((n) => `os.environ["DATA_${n}_KEY"]`).join("\n") });
  const ds2 = D.createDataSrc({ envFile: path.join(WS, "none.env"), lock: () => Promise.resolve(() => {}), strategies: () => [big] });
  ok("missing 上限沿用 MAX_SOURCES", ds2.list().missing.length === D.MAX_SOURCES);
  fs.rmSync(WS, { recursive: true, force: true });

  // ================= 主行程:main.js 接線 =================
  const main = fs.readFileSync(path.join(SHELL, "main.js"), "utf8");
  { const smiss = new Function("dataSrc", "require", "stratDataSources", "return (" + cut(main, "stratMissingSources") + ")");
    const req = (m) => require(path.join(SHELL, m)), used = () => ["FINMIND", "FRED"];
    ok("stratMissingSources:拿 stratDataSources(dir)(掃全部 .py)跟 dataSrc.names() 比;清單讀不到(null)或還沒建好 = 不講缺",
      JSON.stringify(smiss({ names: () => ["FRED"] }, req, used)("/d")) === '["FINMIND"]' && JSON.stringify(smiss({ names: () => null }, req, used)("/d")) === "[]" && JSON.stringify(smiss(null, req, used)("/d")) === "[]"
      && /missingOf\(stratDataSources\(dir\), have\)/.test(cut(main, "stratMissingSources"))); }
  ok("loadStrategy 回 missingSources", /missingSources: stratMissingSources\(dir\)/.test(cut(main, "loadStrategy")));
  ok("資料來源頁也掃整個資料夾:strategies() 注入 dir", /strategies: \(\) => listStrategies\(\)\.map\(\(s\) => \(\{[^\n]*dir: path\.join\(STRAT_DIR\(\), s\.name\)/.test(main));

  // ================= renderer:策略頁 #rp-nobt =================
  const app = fs.readFileSync(path.join(R, "app.js"), "utf8");
  const STR = {}; new Function("window", fs.readFileSync(path.join(R, "strings.js"), "utf8").replace(/^const STRINGS\b/m, "window.STRINGS"))(STR);
  const ZH = STR.STRINGS.zh, EN = STR.STRINGS.en;
  const tt = (k, v) => { let s = ZH[k] || k; if (v) for (const x in v) s = s.split("{" + x + "}").join(v[x]); return s; };
  const nb = el("p"); nb.id = "rp-nobt"; nb.dataset.i18n = "rp.noBt"; nb.hidden = true;
  const env = { cur: "local" }, RP = { name: "a" }, RPC = { name: "a" };
  const turn = { running: false };
  const [paint, missSync] = new Function("$", "t", "document", "ENV", "RP", "xpIsTypeB", "rpGoDataSrc", "turn", "with (turn) { " + cut(app, "rpMissKey") + cut(app, "rpNobtPaint") + cut(app, "rpMissSync") + "return [rpNobtPaint, rpMissSync]; }")(
    () => nb, tt, doc, env, RP, (d) => !!d.typeB, () => {}, turn);
  const state = () => ({ hidden: nb.hidden, miss: nb.classList.contains("is-miss"), i18n: nb.dataset.i18n, text: nb.textContent, btn: nb.children.filter((c) => c.tagName === "BUTTON").length });
  RP.data = { missingSources: ["FINMIND"] }; paint(RP, false);
  let s1 = state();
  ok("缺一把、沒回測:缺金鑰態(.is-miss、拿掉 data-i18n、文字＋一顆鈕)", !s1.hidden && s1.miss && s1.i18n === undefined && s1.btn === 1 && s1.text.startsWith("缺 FINMIND 的金鑰，回測跑不起來。") && s1.text.endsWith("去資料來源"), JSON.stringify(s1));
  paint(RP, true); ok("有回測也出", !nb.hidden && nb.classList.contains("is-miss"));
  { const btn = () => nb.children.find((c) => c.tagName === "BUTTON");
    turn.running = true; RP.data = { missingSources: ["FINMIND"] }; paint(RP, false); const a = btn().disabled === true;
    turn.running = false; missSync(); const b = btn().disabled === false;
    turn.running = true; missSync(); const c = btn().disabled === true;
    turn.running = false; paint(RP, false); const d = btn().disabled === false;
    ok("回合進行中「去資料來源」停用、結束恢復;回合開始 / 結束的三處都叫 rpMissSync", a && b && c && d && (app.match(/stratDelSync\(\); rpMissSync\(\);/g) || []).length === 3, JSON.stringify({ a, b, c, d })); }
  RP.data = { missingSources: ["FINMIND"], typeB: true }; paint(RP, false);
  ok("缺金鑰 > Type B:Type B 句尾換「這支跑不起來」,不出 rp.noBtB", state().miss && state().text.startsWith("缺 FINMIND 的金鑰，這支跑不起來。") && !state().text.includes(ZH["rp.noBtB"]));
  RP.data = { missingSources: ["FINMIND", "FRED"] }; paint(RP, false);
  ok("缺兩把", state().text.startsWith("缺 FINMIND、FRED 的金鑰，回測跑不起來。"));
  RP.data = { missingSources: ["FINMIND", "FRED", "POLYGON", "X"] }; paint(RP, false);
  ok("缺三把以上:列前兩個＋總數", state().text.startsWith("缺 FINMIND、FRED 等 4 個來源的金鑰，回測跑不起來。"));
  ok("英文 many 用 {k} = 剩幾個", EN["rp.missKey.many"].includes("{k} more") && /k: miss\.length - 2/.test(cut(app, "rpMissKey")));
  RP.data = { missingSources: [], typeB: true }; paint(RP, false);
  let s2 = state();
  ok("不缺、Type B、沒回測 → rp.noBtB,class 與鈕都清掉", !s2.hidden && !s2.miss && s2.i18n === "rp.noBtB" && s2.btn === 0 && s2.text === ZH["rp.noBtB"], JSON.stringify(s2));
  RP.data = { missingSources: [] }; paint(RP, false);
  ok("不缺、沒回測 → rp.noBt", state().i18n === "rp.noBt" && !state().miss && !state().hidden);
  paint(RP, true); ok("不缺、有回測 → 收起", nb.hidden && !state().miss);
  RPC.data = { missingSources: ["FINMIND"] }; env.cur = "cloud"; paint(RPC, false);
  ok("雲端視角(雲端那袋)不出缺金鑰", !state().miss && state().i18n === "rp.noBt");
  RP.data = { missingSources: ["FINMIND"] }; paint(RP, false);
  ok("雲端視角時就算拿到本機那袋也不出", !state().miss);
  env.cur = "local";
  ok("rpShowTab 交給 rpNobtPaint;applyStatic 重畫缺金鑰那格(它沒有 data-i18n)", /rpNobtPaint\(B, has\);/.test(cut(app, "rpShowTab")) && /if \(\$\("rp-nobt"\)\.classList\.contains\("is-miss"\)\) rpNobtPaint\(rpBag\(\), true\);/.test(cut(app, "applyStatic")));
  ok("時光機那態把 .is-miss 拿掉", /nobt\.classList\.remove\("is-miss"\); nobt\.dataset\.i18n = why;/.test(fs.readFileSync(path.join(R, "versions.js"), "utf8")));
  const css = fs.readFileSync(path.join(R, "app.css"), "utf8");
  ok("CSS:.is-miss 的 flex 不蓋過 [hidden](:not([hidden]))、文字 ink-2、不寫死 hex", /\.rp-nobt\.is-miss:not\(\[hidden\]\) \{ display: flex; align-items: center; gap: var\(--space-12\); flex-wrap: wrap; color: var\(--ink-2\); \}/.test(css) && /\.rp-nobt\.is-miss \.t \{ flex: 1 1 220px; min-width: 0; \}/.test(css));
  ok("存檔 / 刪除成功後通知策略頁重讀", /rpSrcChanged\(\); return; \}/.test(cut(fs.readFileSync(path.join(R, "datasrc.js"), "utf8"), "srcSave")) && /if \(r && r\.ok && typeof rpSrcChanged === "function"\) rpSrcChanged\(\);/.test(fs.readFileSync(path.join(R, "datasrc.js"), "utf8")) && /stratReload\(RP\.name\)/.test(cut(app, "rpSrcChanged")));
  ok("「去資料來源」開設定 › 資料來源並要求焦點交給缺金鑰列", /SRC\.focusMiss = true; setCat\("src"\);/.test(cut(app, "rpGoDataSrc")));
  ok("「去資料來源」按下就送 feature_used missing_key_go(字面、不帶來源名),名字在白名單最後", /^function rpGoDataSrc\(\) \{ trackFeature\("missing_key_go"\);/.test(cut(app, "rpGoDataSrc"))
    && (() => { const N = require("../shell/telemetry.js").EVENTS.feature_used.name; return N[N.length - 1] === "missing_key_go" && "missing_key_go".length <= 16; })());

  // ================= renderer:設定 › 資料來源 =================
  const rsrc = fs.readFileSync(path.join(R, "datasrc.js"), "utf8");
  const box = el("div"); box.id = "set-src";
  const ids = () => Object.fromEntries(all(box).filter((x) => x.id).map((x) => [x.id, x]));
  const $ = (id) => (id === "set-src" ? box : ids()[id] || null);
  const ctx = { $, t: tt, document: doc, ENV: { cur: "local" }, setFocusGuard: () => {}, srSay: () => {}, confirmBox: () => {}, window: { blave: {} } };
  const api = new Function(...Object.keys(ctx), rsrc + "\nreturn { SRC, srcPaint, srcOpenForm, srcBack, srcClear };")(...Object.values(ctx));
  const { SRC } = api;
  SRC.loaded = true; SRC.items = []; SRC.missing = [{ name: "FINMIND", usedBy: ["融資反轉（2）", "外資連買警示"], fields: ["TOKEN"] }]; SRC.focusMiss = true;
  api.srcPaint();
  const rows = box.querySelectorAll(".src-row");
  ok("清單原本空但有缺金鑰:不出空狀態,有頁首「新增資料來源」+ 缺金鑰列", !box.querySelector(".src-empty") && box.querySelector(".src-head .btn-out") && rows.length === 1 && rows[0].dataset.miss === "FINMIND");
  const small = rows[0].querySelector("small"), st = small.querySelector(".st");
  ok("缺金鑰列小字:「還沒有金鑰」包 .st,其後「 · 用到它的策略:…」;title 是全文", st && st.textContent === "還沒有金鑰" && small.textContent === "還沒有金鑰 · 用到它的策略：融資反轉（2）、外資連買警示" && small.title === small.textContent);
  ok("兩語的 src.rowMissing 都有第一個「 · 」可切", ZH["src.rowMissing"].indexOf(" · ") > 0 && EN["src.rowMissing"].indexOf(" · ") > 0);
  const acts = rows[0].querySelectorAll(".acts .btn-quiet");
  ok("動作只有一顆「新增」,焦點(focusMiss)交給它、旗標用掉", acts.length === 1 && acts[0].textContent === "新增" && doc.activeElement === acts[0] && SRC.focusMiss === false);
  SRC.items = [{ name: "FRED", fields: ["KEY"], usedBy: [] }]; api.srcPaint();
  ok("缺金鑰列排在一般列前面", box.querySelectorAll(".src-row")[0].dataset.miss === "FINMIND" && !("miss" in box.querySelectorAll(".src-row")[1].dataset));
  box.querySelectorAll(".src-row")[0].querySelector(".btn-quiet").click();
  const nm = $("src-name"), fn = box.querySelectorAll(".src-fname");
  ok("按「新增」:名稱預填且唯讀、label = src.nameLocked、走新增(SRC.edit 為 null)", SRC.view === "form" && nm.value === "FINMIND" && nm.readOnly === true && box.querySelector(".src-l").textContent === ZH["src.nameLocked"] && SRC.edit === null);
  ok("欄位照程式碼預填、可改(不唯讀)、焦點在第一個貼金鑰框", fn.length === 1 && fn[0].value === "TOKEN" && fn[0].readOnly === false && doc.activeElement === box.querySelector(".src-value"));
  api.srcBack(); api.srcOpenForm(null);
  ok("回清單後按一般「新增資料來源」:名稱可填、不帶上一筆預填", $("src-name").value === "" && $("src-name").readOnly === false && box.querySelectorAll(".src-fname")[0].value === "KEY" && SRC.fixed === null);
  SRC.missing[0].fields = []; api.srcBack(); box.querySelectorAll(".src-row")[0].querySelector(".btn-quiet").click();
  ok("缺金鑰列沒有欄位資訊:退回預設 KEY 一列,名稱照鎖", box.querySelectorAll(".src-fname")[0].value === "KEY" && $("src-name").readOnly === true);
  api.srcClear(); ok("離開那一類(srcClear)把鎖名清掉", SRC.fixed === null);
  ctx.ENV.cur = "cloud"; SRC.cloud = ["FRED"]; api.srcPaint();
  ok("雲端視角不畫缺金鑰列", !box.querySelector("[data-miss]") && box.querySelectorAll(".src-row").length === 1);
  ok("renderer 那一半仍不用 innerHTML", !/innerHTML|insertAdjacentHTML|outerHTML/.test(rsrc + cut(app, "rpNobtPaint")));

  console.log(red ? `\n${red} 條紅` : "\n全綠");
  process.exit(red ? 1 : 0);
})();
