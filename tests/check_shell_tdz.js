// shell/ 的「宣告前就讀」掃描(暫時性死區,TDZ)。踩到的那一次:mpOpen 第一行讀外層的 `cur`,同一個函式最後一行又有
// `const cur = …`——區塊裡的 const 遮住外層那個,第一行讀到的是還沒初始化的區域變數,每次呼叫都丟 ReferenceError,
// 模型選單永遠打不開。`node --check` 不會講、只比對原文的測試也不會講(tests/check_shell_undef.js 明寫它抓不到 TDZ)。
// 做法:每個區塊(函式本體、{}、for、switch、整支檔)直接宣告的 let / const / class,在**同一個區塊、宣告完成之前**被讀到就紅。
//   不進巢狀函式(那是之後才執行的);巢狀區塊自己又宣告同名的不算(讀到的是它自己那個)。
// 零新 dependency:用 Node 內建的 acorn(同 check_shell_undef.js)。拿不到就 SKIP 並講原因。
// 跑法:node tests/check_shell_tdz.js        (對照組:node tests/check_shell_tdz.js --file <某一版 app.js>)
const fs = require("fs"), path = require("path"), cp = require("child_process");
if (!process.execArgv.includes("--expose-internals")) {
  const r = cp.spawnSync(process.execPath, ["--expose-internals", "--no-warnings", __filename, ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(r.status == null ? 1 : r.status);
}
let acorn = null, why = "";
for (const id of ["internal/deps/acorn/acorn/dist/acorn", "internal/deps/acorn/dist/acorn"]) { try { acorn = require(id); break; } catch (e) { why = e.message; } }
if (!acorn || typeof acorn.parse !== "function") { console.log("SKIP  這個 Node(" + process.version + ")拿不到內建的 acorn:" + why); process.exit(0); }

const FN = ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"];
const isNode = (x) => x && typeof x === "object" && typeof x.type === "string";
const kids = (n) => Object.keys(n).flatMap((k) => (Array.isArray(n[k]) ? n[k] : [n[k]])).filter(isNode);
function names(p, out) {   // 宣告位置上的 pattern → 名字
  if (!p) return out;
  if (p.type === "Identifier") out.push(p.name);
  else if (p.type === "ObjectPattern") p.properties.forEach((q) => names(q.type === "RestElement" ? q.argument : q.value, out));
  else if (p.type === "ArrayPattern") p.elements.forEach((e) => names(e, out));
  else if (p.type === "AssignmentPattern") names(p.left, out);
  else if (p.type === "RestElement") names(p.argument, out);
  return out;
}
/* 這個區塊直接宣告的 let / const / class:名字 → 宣告完成的位置(那個 declarator 的結尾;`const x = f(x)` 的右邊也算宣告前) */
function lexical(stmts) {
  const m = new Map();
  for (const s of stmts) {
    if (s.type === "VariableDeclaration" && s.kind !== "var") s.declarations.forEach((d) => names(d.id, []).forEach((n) => { if (!m.has(n)) m.set(n, d.end); }));
    else if (s.type === "ClassDeclaration" && s.id) m.set(s.id.name, s.end);
  }
  return m;
}
const stmtsOf = (n) => (n.type === "Program" || n.type === "BlockStatement" ? n.body : n.type === "SwitchStatement" ? n.cases.flatMap((c) => c.consequent)
  : n.type === "ForStatement" && n.init && n.init.type === "VariableDeclaration" ? [n.init] : (n.type === "ForInStatement" || n.type === "ForOfStatement") && n.left.type === "VariableDeclaration" ? [n.left] : null);
/* 是「讀」的識別字:不是屬性名、不是物件字面的鍵、不是宣告的那個名字 */
function reads(n, parent, key, hit) {
  if (n.type === "Identifier") {
    if (parent && parent.type === "MemberExpression" && key === "property" && !parent.computed) return;
    if (parent && (parent.type === "Property" || parent.type === "MethodDefinition" || parent.type === "PropertyDefinition") && key === "key" && !parent.computed) return;
    if (parent && (parent.type === "LabeledStatement" || parent.type === "BreakStatement" || parent.type === "ContinueStatement")) return;
    hit(n); return;
  }
  for (const k of Object.keys(n)) {
    const v = n[k];
    (Array.isArray(v) ? v : [v]).filter(isNode).forEach((c) => reads(c, n, k, hit));
  }
}
function scan(root, file, out) {
  (function visit(n) {
    const stmts = stmtsOf(n);
    if (stmts) {
      const decl = lexical(stmts);
      if (decl.size) {
        // 在這個區塊裡找讀取:不進函式;巢狀區塊自己宣告了同名的,那個名字在它裡面不算
        (function walk(x, parent, key, shadow) {
          if (FN.includes(x.type) || x.type === "ClassBody") return;
          if (x !== n) { const inner = stmtsOf(x); if (inner) { const d2 = lexical(inner); if (d2.size) shadow = new Set([...shadow, ...d2.keys()]); } }
          if (x.type === "VariableDeclarator") { if (x.init) walk(x.init, x, "init", shadow); return; }   // 左邊是宣告,不是讀
          if (x.type === "Identifier") {
            reads(x, parent, key, (id) => { if (decl.has(id.name) && !shadow.has(id.name) && id.start < decl.get(id.name)) out.push({ file, name: id.name, line: root.__src.slice(0, id.start).split("\n").length }); });
            return;
          }
          for (const k of Object.keys(x)) { const v = x[k]; (Array.isArray(v) ? v : [v]).filter(isNode).forEach((c) => walk(c, x, k, shadow)); }
        })(n, null, null, new Set());
      }
    }
    kids(n).forEach(visit);
  })(root);
}
const parse = (src, file) => { const ast = acorn.parse(src, { ecmaVersion: "latest", sourceType: "script", allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true }); ast.__src = src; return ast; };

const SHELL = path.join(__dirname, "..", "shell");
const only = process.argv.indexOf("--file") >= 0 ? process.argv[process.argv.indexOf("--file") + 1] : null;
const files = only ? [only] : fs.readdirSync(path.join(SHELL, "renderer")).filter((f) => f.endsWith(".js")).map((f) => path.join(SHELL, "renderer", f))
  .concat(fs.readdirSync(SHELL).filter((f) => f.endsWith(".js")).map((f) => path.join(SHELL, f)), fs.readdirSync(path.join(SHELL, "browser")).filter((f) => f.endsWith(".js")).map((f) => path.join(SHELL, "browser", f)));
const out = [];
for (const f of files) scan(parse(fs.readFileSync(f, "utf8"), f), path.relative(path.join(__dirname, ".."), f), out);

// 掃描器自己要抓得到那一次的形狀,也不能把正常的寫法報成紅(不然綠燈沒有意義)
const probe = (src) => { const o = []; scan(parse(src, "probe"), "probe", o); return o.map((x) => x.name).join(); };
const self = [
  [`let cur = 1; function f() { if (cur === 1) g(); const cur = 2; return cur; }`, "cur"],            // mpOpen 那一次
  [`function f() { const a = a + 1; }`, "a"], [`function f() { { use(b); let b; } }`, "b"], [`function f() { for (const i of xs) {} use(c); const c = 1; }`, "c"],
  [`function f() { const a = 1; return a; }`, ""], [`function f() { const g = () => h; const h = 1; return g(); }`, ""],      // 巢狀函式之後才執行
  [`function f() { { const k = 1; use(k); } const k = 2; }`, ""], [`function f(o) { o.z = 1; return { z: 2 }; const z = 3; }`, ""],   // 巢狀區塊自己的;屬性名與鍵
  [`function f() { switch (x) { case 1: use(s); break; default: let s = 1; } }`, "s"],
];
const bad = self.filter(([src, want]) => probe(src) !== want);
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };
ok("掃描器:那一次的形狀與四種變形都抓得到;正常寫法(巢狀函式、巢狀區塊、屬性名)不誤報", !bad.length, bad.map(([s]) => s + " → " + probe(s)));
ok(`${files.length} 支檔沒有「宣告前就讀」的 let / const`, !out.length, out.slice(0, 20));
process.exit(red ? 1 : 0);
