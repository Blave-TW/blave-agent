// 電腦版與網頁兩個表面要同一份的常數(稽核 audit-0.1.13-web C3):倍數提醒門檻 LEV_T1 / T2 / T3、階段表 PHASE_OF / PHASE_NONE,
// 以及讀帳失敗時的帳戶幣別對照表(八個帳戶,統一期貨 president 在網頁是 hidden 條目、仍要帶 ccy)。一邊改了、另一邊沒跟就紅。
//   電腦版:shell/renderer/trade.js 的 LEV_T* 與 CX_VENUES[].ccy + TR_VENUE_CCY_OTHER
//   網頁:web/app/main/templates/agent/workspace.html 的 LEV_T* 與 CX_VENUES[].ccy
// 網頁那棵用 BLAVE_WEB_DIR 指定(預設 monorepo 的 ../web);找不到就 fail,不 SKIP——不比對等於沒有這支測試。
// 跑法:BLAVE_WEB_DIR=/path/to/web node tests/check_web_desktop_parity.js
const fs = require("fs"), path = require("path");
let red = 0; const ok = (n, c, why) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || !why ? "" : "  " + why)); if (!c) red++; };
const webDir = process.env.BLAVE_WEB_DIR || path.join(__dirname, "..", "..", "web");
const wsPath = path.join(webDir, "app", "main", "templates", "agent", "workspace.html");
if (!fs.existsSync(wsPath)) { console.log("FAIL  找不到 " + wsPath + "(設 BLAVE_WEB_DIR 指到 web)"); process.exit(1); }
const web = fs.readFileSync(wsPath, "utf8"), desk = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "trade.js"), "utf8");
const lev = (src) => ["LEV_T1", "LEV_T2", "LEV_T3"].map((k) => { const m = new RegExp("\\b" + k + " = (\\d+(?:\\.\\d+)?)\\b").exec(src); return m ? Number(m[1]) : null; });
const dl = lev(desk), wl = lev(web);
ok("LEV_T1 / T2 / T3 兩邊都有、而且相等(" + JSON.stringify(dl) + " vs " + JSON.stringify(wl) + ")", dl.every((x) => x != null) && JSON.stringify(dl) === JSON.stringify(wl));
// 電腦版:CX_VENUES 的 ccy + 另外兩個帳戶
const cx = /const CX_VENUES = \{([\s\S]*?)\};/.exec(desk), other = /const TR_VENUE_CCY_OTHER = \{([^}]*)\};/.exec(desk);
const dt = {};
if (cx) for (const m of cx[1].matchAll(/(\w+): \{([^}]*)\}/g)) { const c = /ccy: "(\w+)"/.exec(m[2]); if (c) dt[m[1]] = c[1]; }
if (other) for (const m of other[1].matchAll(/(\w+): "(\w+)"/g)) dt[m[1]] = m[2];
// 網頁:CX_VENUES 陣列裡每個 { id: "…", … ccy: "…" }
const wa = web.indexOf("const CX_VENUES = ["), wb = web.indexOf("\n        ];\n", wa), wt = {};
if (wa >= 0 && wb > wa) for (const m of web.slice(wa, wb).matchAll(/\{\s*id: "(\w+)"[^{}]*?ccy: "(\w+)"/g)) wt[m[1]] = m[2];
const sorted = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
ok("幣別對照表兩邊同一份(八個帳戶)", Object.keys(dt).length === 8 && sorted(dt) === sorted(wt), sorted(dt) + " vs " + sorted(wt));
// 階段表(canon › 回合狀態列 9):電腦版 app.js 與網頁 workspace.html 的 PHASE_OF / PHASE_NONE 同一份——網頁稽核改了表,這裡就紅
const appSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "app.js"), "utf8");
const phaseOf = (src) => { const m = /const PHASE_OF = \{([\s\S]*?)\};/.exec(src); const o = {}; if (m) for (const x of m[1].matchAll(/(\w+): "(\w+)"/g)) o[x[1]] = x[2]; return o; };
const phaseNone = (src) => { const m = /const PHASE_NONE = new Set\(\[([\s\S]*?)\]\);/.exec(src); return m ? [...m[1].matchAll(/"(\w+)"/g)].map((x) => x[1]).sort() : null; };
const dpo = phaseOf(appSrc), wpo = phaseOf(web), dpn = phaseNone(appSrc), wpn = phaseNone(web);
ok("階段表 PHASE_OF 兩邊同一份", Object.keys(dpo).length > 10 && sorted(dpo) === sorted(wpo), sorted(dpo) + " vs " + sorted(wpo));
ok("PHASE_NONE 兩邊同一份", !!dpn && !!wpn && JSON.stringify(dpn) === JSON.stringify(wpn), JSON.stringify(dpn) + " vs " + JSON.stringify(wpn));
console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0);
