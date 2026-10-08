// 電腦版字體(設計評估 desktop-windows-typography-2026-10-08):Chromium 不認 ui-monospace、Electron 的 monospace 預設是 Courier,
// 所以 Roboto Mono 要隨包;堆疊只准寫在 tokens.css 的 --font-sans / --font-mono(canon › Type › 字體家族),其餘 css 一律引 token。
// 跑法:node tests/check_shell_fonts.js
const fs = require("fs"), path = require("path");
const R = path.join(__dirname, "..", "shell", "renderer");
const read = (f) => fs.readFileSync(path.join(R, f), "utf8");
let red = 0; const ok = (name, c) => { console.log((c ? "PASS  " : "FAIL  ") + name); if (!c) red++; };

const tok = read("tokens.css");
const cssFiles = fs.readdirSync(R).filter((f) => f.endsWith(".css") && f !== "tokens.css");
// report-print.css 的「共用」段逐字 = web 的 report_print.css(tests/check_shell_report_pdf.js 比對),那段歸 web 管、這裡不查
const SHARED = "/* ========== 共用:以下到檔尾逐字同 web 的 report_print.css ========== */";
const own = (f, s) => (f === "report-print.css" && s.indexOf(SHARED) > 0 ? s.slice(0, s.indexOf(SHARED)) : s);
const others = cssFiles.map((f) => [f, own(f, read(f))]);

// ── 1. 隨包 Roboto Mono ──
const face = tok.match(/@font-face \{[^}]*\}/);
const src = face && face[0].match(/url\("fonts\/([^"]+\.woff2)"\)/);
const woff = src && path.join(R, "fonts", src[1]);
ok("tokens.css 有 @font-face 引 fonts/*.woff2", !!src);
ok("woff2 檔存在且非空(" + (src ? src[1] : "?") + ")", !!woff && fs.existsSync(woff) && fs.statSync(woff).size > 1000);
ok("@font-face 是 Roboto Mono、涵蓋 400 與 500(可變字型 100–700)、font-display block", !!face && /font-family: "Roboto Mono";/.test(face[0]) && /font-weight: 100 700;/.test(face[0]) && /font-display: block;/.test(face[0]));
ok("授權檔隨字型放一起(fonts/OFL.txt)", fs.existsSync(path.join(R, "fonts", "OFL.txt")) && /SIL Open Font License, Version 1\.1/.test(fs.readFileSync(path.join(R, "fonts", "OFL.txt"), "utf8")));
const build = fs.readFileSync(path.join(__dirname, "..", "shell", "electron-builder.config.js"), "utf8");
ok("electron-builder files 含 renderer/**/*(字型檔才會進包)", /files:\s*\[[^\]]*"renderer\/\*\*\/\*"/.test(build));
for (const html of ["index.html", "report-print.html"]) ok(html + " CSP 允許 font-src 'self'", /font-src 'self'/.test(read(html)));

// ── 2. 堆疊 token ──
const sans = tok.match(/--font-sans: ([^;]+);/), mono = tok.match(/--font-mono: ([^;]+);/);
ok("tokens.css 定義 --font-sans 與 --font-mono", !!sans && !!mono);
ok("mono 堆疊:Roboto Mono 領頭、無 ui-monospace(Chromium 不認)", !!mono && /^"Roboto Mono",/.test(mono[1]) && !/ui-monospace/.test(mono[1]) && /monospace$/.test(mono[1]));
ok("sans 堆疊:Mac 段 -apple-system + PingFang TC、Windows 段 Segoe UI Variable + Segoe UI + Microsoft JhengHei UI", !!sans
  && /^-apple-system, BlinkMacSystemFont, "PingFang TC", "Segoe UI Variable( Text)?", "Segoe UI", "Microsoft JhengHei UI", system-ui, sans-serif$/.test(sans[1]));
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");   // 註解裡提到字型名不算
const leak = others.filter(([, s]) => /"Roboto Mono"|-apple-system|BlinkMacSystemFont|"Segoe UI"|"SF Mono"|Menlo|Consolas/.test(strip(s))).map(([f]) => f);
ok("tokens.css 以外的 css 不直寫字型名(只准 var(--font-sans / --font-mono))" + (leak.length ? " → " + leak.join(", ") : ""), leak.length === 0);
const uim = others.filter(([, s]) => /ui-monospace/.test(strip(s))).map(([f]) => f);
ok("任何 css 都沒有 ui-monospace(含 var() 的 fallback)" + (uim.length ? " → " + uim.join(", ") : ""), uim.length === 0 && !/ui-monospace/.test(strip(tok)));
ok("各 css 有引到 token(sans / mono 各至少一處)", others.some(([, s]) => /var\(--font-sans\)/.test(s)) && others.some(([, s]) => /var\(--font-mono\)/.test(s)));
ok("report-print.css 的 --pdf-sans / --pdf-mono 引同一組 token(PDF 跟 app 同字)", /--pdf-sans: var\(--font-sans\);/.test(read("report-print.css")) && /--pdf-mono: var\(--font-mono\);/.test(read("report-print.css")));
ok("report-wf.js 的 canvas 字族從 --font-mono 讀,不寫死", /ctx\.font = "\d+px " \+ token\("--font-mono"\)/.test(read("report-wf.js")) && !/ui-monospace/.test(read("report-wf.js")));


// ── 3. Windows 的 11px Mini tag 字重 400(正黑體沒有 600;只掛 win32,mac 照 canon 600) ──
const app = read("app.css");
const winTag = app.match(/html\[data-platform="win32"\] \.lib \.tag,[^{]*\{ font-weight: 400; \}/);
const tagSels = [".lib .tag", ".rb-report .rb-news-tag", ".pf-wallet-row .mini_tag", ".mode", ".envm", ".shr-tag", ".tag-you"];
ok("app.css 有 win32 專屬的 Mini tag 字重 400 規則", !!winTag);
ok("規則涵蓋外殼所有 11px/600 的 tag 元件", !!winTag && tagSels.every((sel) => winTag[0].includes('html[data-platform="win32"] ' + sel)));
const base = { ".lib .tag": read("library.css"), ".rb-report .rb-news-tag": read("report-blocks.css"), ".pf-wallet-row .mini_tag": read("trade.css"), ".mode": read("trade.css"), ".envm": app, ".shr-tag": read("report-share.css"), ".tag-you": read("browser.css") };
ok("那些 tag 的基礎規則仍是 11px/600(mac 不變、win32 只蓋字重)", tagSels.every((sel) => new RegExp(sel.replace(/[.]/g, "\\.") + " \\{[^}]*font-size: 11px;[^}]*font-weight: 600;|" + sel.replace(/[.]/g, "\\.") + " \\{[^}]*font-weight: 600;[^}]*font-size: 11px;").test(base[sel])));
ok("win32 記號由 app.js 掛在 <html data-platform>(規則才會生效)", /document\.documentElement\.dataset\.platform = window\.blave\.platform/.test(read("app.js")));

// ── 4. 報告小字下限 11px(canon 最小字階 = Mini tag 11;正黑體在 10.5px 以下 DirectWrite 會糊橫筆,兩平台一起抬) ──
const small = others.filter(([f]) => /^report-.*\.css$|^library\.css$/.test(f)).filter(([, s]) => /font-size: 10(\.5)?px/.test(strip(s))).map(([f]) => f);
ok("report-*.css / library.css 沒有 font-size: 10px / 10.5px" + (small.length ? " → " + small.join(", ") : ""), small.length === 0);
ok("report-wf.js 的 canvas 刻度字 11px", /ctx\.font = "11px " \+ token\("--font-mono"\)/.test(read("report-wf.js")));
ok("report-blocks.js 的圖內文字寬估算跟著 11px(全形 11、半形 6.6 = 0.6em)", /\? 11 : 6\.6;/.test(read("report-blocks.js")) && /\.rb-report \.rb-chart text \{\s*font-size: 11px;/.test(read("report-blocks.css")));

process.exit(red ? 1 : 0);
