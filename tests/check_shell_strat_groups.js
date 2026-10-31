// 側欄策略資料夾的電腦版接線(spec strategy-sidebar-folders-2026-10-30;renderer/stratgroups.js + stratflags.js + app.js / trade.js)。不起 Electron。
//   ① 純邏輯:建市場資料夾的條件(沒有資料夾、≥8 支、已知市場 ≥2 種;空值與表外市場留未分類、不算數)與分組順序;
//   ② 清單:72 個 emoji 單一碼點不重複、六類各 12;每個都有 zh / en 名字(選擇器每格的 aria-label);sg.* 字兩語都齊;
//   ③ 接線(原文):重建入口都插組標題、選中先 sgReveal(在同一支提早 return 之前)、回合結束先送出編輯列、
//      編輯列開著時兩條重建路都等;組標題不叫 .strat-row / .strat-wrap(不被既有掃描掃到);焦點找下一列略過 hidden;
//      八個 sfolder_* 埋點都是字面、都在白名單;沒有 innerHTML;index.html 載入順序
// 跑法:node tests/check_shell_strat_groups.js(兩邊同一份的常數與 sgBuild 測資在 check_web_desktop_parity.js)
const fs = require("fs"), path = require("path"), vm = require("vm");
const SHELL = path.join(__dirname, "..", "shell"), R = path.join(SHELL, "renderer");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + String(d).slice(0, 600))); if (!c) red++; };
const read = (f) => fs.readFileSync(f, "utf8");
const sg = read(path.join(R, "stratgroups.js")), sf = read(path.join(R, "stratflags.js")), app = read(path.join(R, "app.js")), tr = read(path.join(R, "trade.js")), html = read(path.join(R, "index.html")), css = read(path.join(R, "app.css"));
const cutFn = (s, name) => { const i = s.indexOf("function " + name + "("); if (i < 0) throw new Error("no " + name); let d = 0; for (let k = s.indexOf("{", i); k < s.length; k++) { if (s[k] === "{") d++; else if (s[k] === "}" && --d === 0) return s.slice(i, k + 1); } throw new Error("unbalanced " + name); };
const block = (s, head, end) => { const i = s.indexOf(head); if (i < 0) throw new Error("no " + head); return s.slice(i, s.indexOf(end, i) + end.length); };

// ── ① 建市場資料夾 ──
{
  const c = { t: (k) => k };
  vm.runInNewContext([block(sg, "const SG_MAX = ", ";"), block(sg, "const SG_MARKETS = {", "};"), cutFn(sg, "sgAutoPlan")].join("\n") + "\nthis.plan = sgAutoPlan;", c);
  const sc = (folders, mk) => ({ groups: () => ({ v: 1, folders, map: {} }), market: (x) => mk[x.name] });
  const L = (n) => Array.from({ length: n }, (_, i) => ({ name: "s" + i }));
  const mk = { s0: "tw_stock", s1: "crypto", s2: "tw_stock", s3: null, s4: "other", s5: "crypto", s6: "us_stock", s7: "tw_stock" };
  const p = c.plan(sc([], mk), L(8));
  ok("① 8 支、三種已知市場:照各市場第一支的顯示順序建;空值與表外市場不歸任何組", JSON.stringify(p) === JSON.stringify({ order: ["tw_stock", "crypto", "us_stock"], by: { tw_stock: ["s0", "s2", "s7"], crypto: ["s1", "s5"], us_stock: ["s6"] } }), JSON.stringify(p));
  ok("① 7 支(新手門檻以下)→ 不出現", c.plan(sc([], mk), L(7)) === null);
  ok("① 已有資料夾 → 不出現(刪光才再出現)", c.plan(sc([{ id: "fok0001", name: "x", emoji: null }], mk), L(8)) === null);
  ok("① 已知市場只有一種(其餘未知)→ 不出現;本機回報還沒到 = 全部未知 → 不出現",
    c.plan(sc([], { s0: "crypto", s1: "crypto" }), L(8)) === null && c.plan(sc([], {}), L(12)) === null);
}

// ── ② 清單與字串 ──
{
  const c = {}; vm.runInNewContext(block(sg, "const SG_EMOJI = (", "\n);") + "\nthis.L = [...SG_EMOJI];", c);
  ok("② SG_EMOJI:72 個、單一碼點、不重複、不含 VS16 / ZWJ", c.L.length === 72 && new Set(c.L).size === 72 && c.L.every((e) => [...e].length === 1 && !/[️‍]/.test(e)));
  const S = {}; vm.runInNewContext(read(path.join(R, "strings.js")) + "\nthis.S = STRINGS;", S);
  const hex = (e) => "sg.e." + e.codePointAt(0).toString(16).toUpperCase();
  ok("② 72 個 emoji 都有 zh / en 名字(選擇器每格的 aria-label 與 title)", c.L.every((e) => S.S.zh[hex(e)] && S.S.en[hex(e)]) && S.S.zh[hex("⭐")] === "星星" && S.S.zh[hex("⛅")] === "晴時多雲",
    c.L.filter((e) => !S.S.zh[hex(e)] || !S.S.en[hex(e)]).join(""));
  const used = [...new Set([...(sg + sf).matchAll(/t\("(sg\.[\w.]+)"/g)].map((m) => m[1]))].filter((k) => !k.endsWith("."));   // "sg.e." + 碼點 在上一條驗
  const cats = [...block(sg, "const SG_CATS = [", "];").matchAll(/"(sg\.[\w.]+)"/g)].map((m) => m[1]), mkts = [...block(sg, "const SG_MARKETS = {", "};").matchAll(/\["([\w.]+)"/g)].map((m) => m[1]);
  const all = [...new Set(used.concat(cats, mkts))];
  ok("② 用到的 sg.* / 市場組名字串兩語都齊(" + all.length + " 個)", all.length > 25 && all.every((k) => S.S.zh[k] && S.S.en[k]), all.filter((k) => !S.S.zh[k] || !S.S.en[k]).join());
  ok("② 字照 spec §14", S.S.zh["sg.add"] === "新增資料夾" && S.S.zh["sg.uncat"] === "未分類" && S.S.zh["sg.auto"] === "建市場資料夾" && S.S.zh["sg.max"] === "最多 20 個資料夾"
    && S.S.zh["sg.delTitle"] === "刪除「{name}」？" && S.S.zh["sg.delBody"] === "裡面 {n} 支移到未分類。" && S.S.zh["sg.moved"] === "已移到{name}" && S.S.zh["sg.headAria"] === "{name}，{n} 支"
    && S.S.zh["sg.headLive"] === "，{m} 支上線中" && S.S.en["sg.headAria"] === "{name}, strategies: {n}" && S.S.en["sg.headLive"] === ", live: {m}" && S.S.en["sg.delBody"] === "Its strategies ({n}) move to Uncategorized." && S.S.zh["sg.more"] === "{name}選項" && S.S.zh["sg.moveTo"] === "移到{name}" && S.S.zh["sg.moveOut"] === "移出資料夾"
    && S.S.zh["sg.mkt.global"] === "國際期貨" && S.S.zh["sg.mkt.mixed"] === "混合");
  ok("② 市場組名(zh 同網頁 workspace_sg_mkt_*:加密、台指期、個股期貨、台股、美股、國際期貨、混合)、每語 ≤20 碼點(建好就是資料夾名,api 收的上限)",
    mkts.map((k) => S.S.zh[k]).join() === "加密,台指期,個股期貨,台股,美股,國際期貨,混合" && mkts.every((k) => ["zh", "en"].every((l) => [...S.S[l][k]].length <= 20)), mkts.map((k) => S.S.en[k]).join());
  ok("② 六類各 12 個,分類名照 spec(常用／市場／策略／動物／自然／物品)", cats.length === 6 && cats.map((k) => S.S.zh[k]).join() === "常用,市場,策略,動物,自然,物品");
}

// ── ③ 接線 ──
{
  const refresh = cutFn(app, "stratRefresh"), paint = cutFn(tr, "envPaintSide");
  ok("③ 兩個重建入口都在列建完後 sgLayout(本機 SF_LOCAL / 雲端 SF_CLOUD),雲端空清單也叫(新增鈕依清單長度判)",
    /\n\s*if \(typeof sgLayout === "function"\) sgLayout\(box, SF_LOCAL, RP\.list\);[^\n]*\n\s*if \(typeof envPaintLocalDots === "function"\)/.test(refresh)
    && /sgLayout\(box, SF_CLOUD, list\);/.test(paint) && /sgLayout\(box, SF_CLOUD, \[\]\); return; \}/.test(paint) && /prefs\.flags, prefs\.groups, list\.map/.test(paint));
  ok("③ 選中先 sgReveal,排在「同一支提早 return」之前(stratSelect / rpCloudSelect)",
    /async function stratSelect\(name, force\) \{\n\s*if \(name && typeof sgReveal === "function"\) sgReveal\("local", name\);[^\n]*\n\s*if \(name === RP\.name && !force\) return;/.test(app)
    && /async function rpCloudSelect\(name, force\) \{\n\s*if \(name && typeof sgReveal === "function"\) sgReveal\("cloud", name\);\n\s*if \(name === RPC\.name && !force\) return;/.test(app));
  ok("③ 回合結束:緊接在 stratRefresh(true) 之前送出編輯列(否則 sgEditing 擋住它與後面的結果卡)", /\n\s*if \(typeof sgEditCommit === "function"\) sgEditCommit\(\);[^\n]*\n\s*stratRefresh\(true\)\.catch\(\(\) => \{\}\)\.then\((?:tabBound\()?\(\) => \{ if \(typeof libTurnEnd === "function"\) libTurnEnd\(\);/.test(app));
  ok("③ 編輯列開著:本機 sfBeforeRebuild 與雲端 sfCloudHold 都等;結束時 sgEditEnd 先寫、再重排、最後 sfFlushWaiters",
    /SF\.dragActive \|\| sgEditing\(\) \? new Promise/.test(cutFn(sf, "sfBeforeRebuild")) && /if \(SF\.dragActive \|\| sgEditing\(\)\) \{/.test(cutFn(sf, "sfCloudHold"))
    && (() => { const e = cutFn(sg, "sgEditEnd"); return e.indexOf("sgSetFolders") < e.indexOf("SG.editing = false") && e.indexOf("SG.editing = false") < e.indexOf("sgRelayout(sc)") && e.lastIndexOf("sfFlushWaiters()") > e.indexOf("sgRelayout(sc)"); })());
  ok("③ 編輯列:圖示鈕 mousedown 擋預設(不讓名稱框失焦送出);焦點進選擇器的那次失焦不算送出;Esc / 空字串 = 取消",
    /ib\.addEventListener\("mousedown", \(e\) => e\.preventDefault\(\)\);/.test(sg) && /if \(sgPick && !sgPick\.hidden && \(!to \|\| sgPick\.contains\(to\)\)\) return;/.test(sg)
    && /if \(commit && name\.trim\(\) && sgCodepoints\(name\) <= SG_NAME_MAX\)/.test(sg) && /else if \(e\.key === "Escape"\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); sgEditEnd\(false\); \}/.test(sg));
  {
    const i = sg.indexOf('input.addEventListener("keydown", '), j = sg.indexOf("\n  });", i);
    const calls = [], c = { sgEditEnd: (x) => calls.push(x) };
    vm.runInNewContext("this.h = " + sg.slice(i + 'input.addEventListener("keydown", '.length, j + 4).replace(/\);$/, ""), c);
    const ev = (key, isComposing, keyCode) => ({ key, isComposing, keyCode, preventDefault() {}, stopPropagation() {} });
    const run = (e) => { calls.length = 0; c.h(e); return calls.join(); };
    ok("③ 編輯列:輸入法組字中(isComposing 或 keyCode 229)的 Esc / Enter 不取消、不送出;沒在組字才照常",
      i >= 0 && run(ev("Escape", true, 27)) === "" && run(ev("Escape", false, 229)) === "" && run(ev("Enter", true, 13)) === "" && run(ev("Enter", false, 229)) === ""
      && run(ev("Escape", false, 27)) === "false" && run(ev("Enter", false, 13)) === "true", String(i));
  }
  ok("③ 組標題 class 是 sg-head(不叫 strat-row / strat-wrap / strat-item / cs-row,不被 refreshRunDots、選中態、stratDelSync 掃到);切換鈕與 ⋯ 是兄弟(鈕不包鈕)",
    /sgEl\("div", "sg-head"/.test(sg) && !/sg-head[^"\n]*(strat-row|strat-wrap|strat-item|cs-row)/.test(sg) && /head\.appendChild\(tog\);/.test(sg) && /head\.appendChild\(more\);/.test(sg));
  ok("③ 本機清除段連組標題與建市場鈕一起清;焦點找下一列略過 hidden(stratRefreshAt、雲端刪除後的 next)",
    /box\.querySelectorAll\(":scope > \.sg-head, :scope > \.sg-auto"\)\.forEach\(\(n\) => n\.remove\(\)\);/.test(cutFn(sg, "sgLayout")) && /\.filter\(\(w\) => !w\.hidden\)/.test(cutFn(app, "stratRefreshAt")) && /querySelectorAll\(":scope > \.strat-wrap:not\(\[hidden\]\)"\)\], at = rows\.findIndex/.test(tr));
  ok("③ 組尾綠點:本機每輪狀態回來、雲端重建時都重算(讀列上的 .run-dot,不另開一套)", /sgHeadsSync\(\$\("strat-list"\)\); sgAutoSync\(\$\("strat-list"\), SF_LOCAL\);/.test(cutFn(tr, "envPaintLocalDots")) && /c\.querySelector\("\.strat-name \.run-dot"\)/.test(cutFn(sg, "sgHeadsSync")));
  ok("③ 收合:列加 hidden(不移除、不包容器),寫回時收合的列仍在 DOM;收合不寫順序、不送 strat_reorder", /rows\.forEach\(\(w\) => \{ w\.hidden = shut; \}\);/.test(cutFn(sg, "sgToggle")) && !/sfWriteOrder|sfMoved/.test(cutFn(sg, "sgToggle"))
    && /\[\.\.\.sc\.box\(\)\.querySelectorAll\(":scope > \.strat-wrap"\)\]/.test(cutFn(sf, "sfWriteOrder")));
  ok("③ 換序 / 刪資料夾 / 建市場資料夾寫回順序但不送 strat_reorder(只有拖列與 Alt+↑/↓ 送)", ["sgMoveFolder", "sgDelete", "sgAuto"].every((f) => /sfWriteOrder\(sc\)/.test(cutFn(sg, f)) && !/sfMoved\(|strat_reorder/.test(cutFn(sg, f)))
    && /function sfMoved\(sc\) \{\n\s*trackFeature\("strat_reorder"\);\n\s*sfWriteOrder\(sc\);\n\}/.test(sf));
  const { EVENTS } = require(path.join(SHELL, "telemetry.js")), names = EVENTS.feature_used.name;
  const sent = [...new Set([...(sg + sf).matchAll(/trackFeature\("(sfolder_\w+)"\)/g)].map((m) => m[1]))].sort();
  ok("③ 八個 sfolder_* 都有送出點、都是字面、都在白名單、≤16 字", sent.join() === "sfolder_auto,sfolder_create,sfolder_delete,sfolder_emoji,sfolder_move,sfolder_rename,sfolder_reorder,sfolder_toggle" && sent.every((n) => names.indexOf(n) >= 0 && n.length <= 16), sent.join());
  ok("③ 資料夾名一律 textContent,沒有 innerHTML;不碰下單設定(amounts / weights / exchanges)", !/innerHTML/.test(sg) && !/\.(amounts|weights|exchanges)\b|config\b/.test(sg));
  ok("③ index.html:stratgroups.js 緊接在 stratflags.js 之後", /<script src="stratflags\.js"><\/script>\n<script src="stratgroups\.js"><\/script>/.test(html));
  ok("③ CSS:組標題 sticky 44 高、z-index 低於拖拉中的列(3);釘頂疊放時 focus-within 浮上來;emoji 走 --font-emoji;選中格 1px --active-line",
    /\.strat-add\[hidden\] \{ display: none; \}/.test(css) && /\.sg-head\.sg-drop \{ z-index: 5; \}/.test(css) && /e\.composedPath\(\)/.test(sg) && /\.sg-head \{ position: sticky; top: 0; z-index: 1;[^}]*height: 44px;/.test(css) && /\.sg-head:focus-within, \.sg-head\.menu-open \{ z-index: 2; \}/.test(css) && /\.strat-wrap\.dragging \{ z-index: 3;/.test(css)
    && /\.sg-ic\.is-emoji \{ font: 14px\/16px var\(--font-emoji\); \}/.test(css) && /\.sg-cell\[aria-checked="true"\] \{ border-color: var\(--active-line\); \}/.test(css)
    && /html\[data-platform="win32"\] \.flag-pop\.sg-pick \{ width: calc\(224px \+ var\(--scrollbar-w\)\); \}/.test(css)
    && /\.sg-tog\[aria-expanded="true"\] > \.sg-chev \{ transform: translateY\(1px\) rotate\(-135deg\); \}/.test(css) && /\.sg-chev \{[^}]*rotate\(45deg\)/.test(css) && !/sgSvg\("chevron"/.test(sg)
    && /\.sg-tog:focus-visible, \.sg-auto:focus-visible \{ outline-offset: -2px; \}/.test(css) && /body\.is-dragging \.sg-head \.sg-more \{ opacity: 0;/.test(css) && /\.strat-list\.has-groups > \.strat-wrap \{ scroll-margin-top: 44px; \}/.test(css));
}
console.log(red ? `\n${red} 紅` : "\n全綠");
process.exit(red ? 1 : 0);
