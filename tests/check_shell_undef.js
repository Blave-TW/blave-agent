// shell/ 的未宣告識別字掃描。踩過兩次同一種:`trPaintHead` 的 `st`、`mpPickModel` 的 `viaMouse`——
// 只在某個分支才求值的識別字,`node --check` 與單元測試都撞不到,要等用戶走到那個分支才丟 ReferenceError。
// 做法:完整的作用域解析(var / function 提升、let / const / class 區塊、參數與解構、catch 參數、具名函式表達式),
// 把解析不到的識別字對照「已知全域」。renderer 六支照 index.html 的載入順序當成**共用一個全域**的 classic script;
// 主行程各檔各自一個模組作用域。抓不到的東西:打錯的屬性名(c.last_ok_a)、TDZ。
// 零新 dependency:用 Node 內建的 acorn(--expose-internals;這支檔會自己帶旗標重跑一次)。拿不到就 SKIP 並講原因,不假綠也不紅。
// 跑法:node tests/check_shell_undef.js        (對照組:node tests/check_shell_undef.js --file <某一版 trade.js>)
const fs = require("fs"), path = require("path"), cp = require("child_process");
if (!process.execArgv.includes("--expose-internals")) {
  const r = cp.spawnSync(process.execPath, ["--expose-internals", "--no-warnings", __filename, ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(r.status == null ? 1 : r.status);
}
let acorn = null, why = "";
for (const id of ["internal/deps/acorn/acorn/dist/acorn", "internal/deps/acorn/dist/acorn"]) { try { acorn = require(id); break; } catch (e) { why = e.message; } }
if (!acorn || typeof acorn.parse !== "function") { console.log("SKIP  這個 Node(" + process.version + ")拿不到內建的 acorn:" + why); process.exit(0); }

const SHELL = path.join(__dirname, "..", "shell");
const BROWSER = "window document navigator location localStorage sessionStorage console setTimeout clearTimeout setInterval clearInterval requestAnimationFrame cancelAnimationFrame getComputedStyle matchMedia ResizeObserver MutationObserver IntersectionObserver Image KeyboardEvent MouseEvent Event CustomEvent Node Element HTMLElement DocumentFragment URL URLSearchParams AbortController fetch performance devicePixelRatio queueMicrotask structuredClone Intl TextEncoder TextDecoder Blob FileReader Path2D";
const LANGUAGE = "undefined NaN Infinity globalThis Object Array String Number Boolean Symbol BigInt Math JSON Date RegExp Error TypeError RangeError SyntaxError ReferenceError Promise Map Set WeakMap WeakSet Proxy Reflect parseInt parseFloat isNaN isFinite encodeURIComponent decodeURIComponent encodeURI decodeURI escape unescape arguments eval Uint8Array Uint16Array Uint32Array Int32Array Float32Array Float64Array ArrayBuffer DataView";
const NODE = "require module exports __dirname __filename process Buffer console setTimeout clearTimeout setInterval clearInterval setImmediate clearImmediate URL URLSearchParams AbortController fetch TextEncoder TextDecoder queueMicrotask structuredClone performance";
const set = (...lists) => new Set(lists.join(" ").split(/\s+/));

const FN = ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"];
const isNode = (x) => x && typeof x === "object" && typeof x.type === "string";
const kids = (n) => Object.keys(n).filter((k) => k !== "loc").flatMap((k) => (Array.isArray(n[k]) ? n[k] : [n[k]])).filter(isNode);
function declare(p, scope) {   // 宣告位置上的 pattern:把名字放進 scope
  if (!p) return;
  if (p.type === "Identifier") scope.add(p.name);
  else if (p.type === "ObjectPattern") p.properties.forEach((q) => declare(q.type === "RestElement" ? q.argument : q.value, scope));
  else if (p.type === "ArrayPattern") p.elements.forEach((e) => declare(e, scope));
  else if (p.type === "AssignmentPattern") declare(p.left, scope);
  else if (p.type === "RestElement") declare(p.argument, scope);
}
function hoist(n, scope) {     // var 與 function 宣告提升到函式作用域(不進巢狀函式;sloppy 模式區塊裡的 function 也算)
  if (n.type === "VariableDeclaration" && n.kind === "var") n.declarations.forEach((d) => declare(d.id, scope));
  if (n.type === "FunctionDeclaration") { scope.add(n.id.name); return; }
  if (FN.includes(n.type)) return;
  kids(n).forEach((k) => hoist(k, scope));
}
function lexical(stmts, scope) { // 這個區塊直接宣告的 let / const / class
  stmts.forEach((s) => {
    if (s.type === "VariableDeclaration" && s.kind !== "var") s.declarations.forEach((d) => declare(d.id, scope));
    if (s.type === "ClassDeclaration") scope.add(s.id.name);
  });
}
function analyze(bodies, globals) {
  const out = [], stack = [];
  const resolved = (name) => stack.some((s) => s.has(name)) || globals.has(name);
  const inScope = (fn) => { stack.push(new Set()); try { fn(stack[stack.length - 1]); } finally { stack.pop(); } };
  const patExprs = (p) => {     // 宣告位置上的 pattern 裡只有預設值與 computed key 是運算式
    if (!p || p.type === "Identifier") return;
    if (p.type === "AssignmentPattern") { patExprs(p.left); visit(p.right); }
    else if (p.type === "ObjectPattern") p.properties.forEach((q) => { if (q.type === "RestElement") patExprs(q.argument); else { if (q.computed) visit(q.key); patExprs(q.value); } });
    else if (p.type === "ArrayPattern") p.elements.forEach(patExprs);
    else if (p.type === "RestElement") patExprs(p.argument);
    else visit(p);
  };
  function visit(n) {
    if (!isNode(n)) return;
    switch (n.type) {
      case "Identifier": if (!resolved(n.name)) out.push({ name: n.name, file: n.loc && n.loc.source, line: n.loc && n.loc.start.line }); return;
      case "FunctionDeclaration": case "FunctionExpression": case "ArrowFunctionExpression":
        return inScope((s) => {
          if (n.type === "FunctionExpression" && n.id) s.add(n.id.name);
          n.params.forEach((p) => declare(p, s));
          if (n.body.type === "BlockStatement") { hoist(n.body, s); lexical(n.body.body, s); n.params.forEach(patExprs); n.body.body.forEach(visit); }
          else { n.params.forEach(patExprs); visit(n.body); }
        });
      case "BlockStatement": case "StaticBlock": return inScope((s) => { lexical(n.body, s); n.body.forEach(visit); });
      case "ForStatement": case "ForInStatement": case "ForOfStatement":
        return inScope((s) => { const d = n.init || n.left; if (d && d.type === "VariableDeclaration" && d.kind !== "var") d.declarations.forEach((x) => declare(x.id, s)); kids(n).forEach(visit); });
      case "CatchClause": return inScope((s) => { declare(n.param, s); patExprs(n.param); visit(n.body); });
      case "SwitchStatement": visit(n.discriminant); return inScope((s) => { lexical(n.cases.flatMap((c) => c.consequent), s); n.cases.forEach((c) => { visit(c.test); c.consequent.forEach(visit); }); });
      case "ClassDeclaration": case "ClassExpression": return inScope((s) => { if (n.id) s.add(n.id.name); visit(n.superClass); visit(n.body); });
      case "VariableDeclarator": patExprs(n.id); visit(n.init); return;
      case "MemberExpression": visit(n.object); if (n.computed) visit(n.property); return;
      case "Property": case "MethodDefinition": case "PropertyDefinition": if (n.computed) visit(n.key); visit(n.value); return;
      case "LabeledStatement": visit(n.body); return;
      case "BreakStatement": case "ContinueStatement": case "MetaProperty": return;
      default: kids(n).forEach(visit);
    }
  }
  inScope((top) => { bodies.forEach((b) => { hoist(b, top); lexical(b.body, top); }); bodies.forEach((b) => b.body.forEach(visit)); });
  return out;
}
const parse = (file, label) => acorn.parse(fs.readFileSync(file, "utf8"), { ecmaVersion: "latest", sourceType: "script", locations: true, sourceFile: label || path.relative(SHELL, file), allowHashBang: true });
const show = (xs) => [...new Set(xs.map((x) => x.name + " @ " + x.file + ":" + x.line))];

// index.html 的載入順序就是「哪幾支共用一個全域」的事實來源;node_modules 來的那一支只貢獻它的全域名字
const html = fs.readFileSync(path.join(SHELL, "renderer", "index.html"), "utf8");
const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
const RENDERER_GLOBALS = set(BROWSER, LANGUAGE, "LightweightCharts");

const i = process.argv.indexOf("--file");
if (i > 0) {   // 對照組:把 renderer 裡同名的那一支換成指定的檔,其餘照舊
  const alt = process.argv[i + 1], name = process.argv[i + 2] || "trade.js";
  const bodies = scripts.filter((s) => !s.startsWith("../")).map((s) => (s === name ? parse(alt, name + "(對照組)") : parse(path.join(SHELL, "renderer", s))));
  const bad = show(analyze(bodies, RENDERER_GLOBALS)); bad.forEach((x) => console.log("UNDEF " + x)); process.exit(bad.length ? 1 : 0);
}

let red = 0; const ok = (n, c) => { console.log((c ? "PASS  " : "FAIL  ") + n); if (!c) red++; };
const own = scripts.filter((s) => !s.startsWith("../"));
ok("index.html 載入的自家 script 有七支(多了 / 少了要回來看這支測試的前提)", own.length === 8);   // 第七支 = datasrc.js(設定 › 資料來源)、第八支 = handoff.js(送上雲端 / 拉回)
const r = show(analyze(own.map((s) => parse(path.join(SHELL, "renderer", s))), RENDERER_GLOBALS));
ok("renderer(" + own.join(" ") + ")沒有未宣告的識別字" + (r.length ? ":\n        " + r.join("\n        ") : ""), r.length === 0);
const MAIN = fs.readdirSync(SHELL).filter((f) => f.endsWith(".js") && f !== "electron-builder.config.js").concat(fs.readdirSync(path.join(SHELL, "tools")).filter((f) => f.endsWith(".js")).map((f) => "tools/" + f));
MAIN.forEach((f) => { const m = show(analyze([parse(path.join(SHELL, f))], set(NODE, LANGUAGE, f === "preload.js" ? "window document" : ""))); ok("主行程 " + f + " 沒有未宣告的識別字" + (m.length ? ":\n        " + m.join("\n        ") : ""), m.length === 0); });
// 這支掃描自己要抓得到東西:餵一段已知有洞的碼
const probe = acorn.parse("function a(x){ const { p = q, ...r } = x; if (x) { let y = 1; } return y + p + r; } function b(v){ return () => v; } function c(){ return v2; } try {} catch (e) { e; } for (const k of []) k; label: for (;;) break label;", { ecmaVersion: "latest", locations: true, sourceFile: "probe" });
ok("自我檢查:抓得到區塊外的 let、巢狀函式外的參數、解構預設值裡的洞;不誤報 catch 參數 / for 變數 / label", show(analyze([probe], set(LANGUAGE))).map((x) => x.split(" ")[0]).sort().join() === "q,v2,y");
console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
