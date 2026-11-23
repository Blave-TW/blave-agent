// 電腦版 0.1.60 P3 小修(QA desktop-0159-cu-2026-11-22、desktop-0158-regression-2026-11-21):每條一個最小檢查,修前紅。
// 真的函式配假 DOM 能跑的就跑,其餘釘原文。不開 Electron。
// 跑法:node tests/check_shell_p3_0160.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const ROOT = path.join(__dirname, ".."), R = path.join(ROOT, "shell", "renderer");
const read = (f) => fs.readFileSync(path.join(R, f), "utf8");
const app = read("app.js"), appCss = read("app.css"), trCss = read("trade.css"), tr = read("trade.js"), rpt = read("reports.js");
const STR = vm.runInNewContext(read("strings.js") + "\nSTRINGS");
let red = 0; const t = (n, ok, d) => { console.log((ok ? "PASS  " : "FAIL  ") + n + (ok || d === undefined ? "" : "  " + JSON.stringify(d))); if (!ok) red++; };
const cutFn = (s, name) => { const i = s.indexOf("function " + name + "("); if (i < 0) return ""; let d = 0; for (let k = s.indexOf("{", i); k < s.length; k++) { if (s[k] === "{") d++; else if (s[k] === "}" && --d === 0) return s.slice(i, k + 1); } return ""; };

// #1 停用的描邊鈕:框退到 hairline、hover 不灰填(同 .pf-act:disabled)
t("#1 .btn-out:disabled 字 ink-disabled、框 border-hairline、hover 也不填色",
  /\.btn-out:disabled, \.btn-out:disabled:hover, #rpt-ask\[aria-disabled="true"\] \{ color: var\(--ink-disabled\); background: transparent; border-color: var\(--border-hairline\); cursor: not-allowed; \}/.test(appCss));

// #4 資產頁:cash 錢包有名字;計價幣與台幣數量 2 位
{ const L = cutFn(tr, "trAcctLabel");
  const lab = L ? vm.runInNewContext(L + "\ntrAcctLabel('cash')", { t: (k) => STR.zh[k] || k }) : null;
  t("#4 錢包 cash 寫「現金」/ Cash,不印英文小寫", lab === "現金" && STR.en["tr.acct.cash"] === "Cash", lab);
  t("#4 持幣表數量:計價幣(TR_QUOTE_SUFFIX)與 USD／TWD 最多 2 位,其他幣 8 位", /maximumFractionDigits: cashLike \? 2 : 8/.test(tr) && /cashLike = TR_QUOTE_SUFFIX\.indexOf\(String\(h\.asset\)\.toUpperCase\(\)\) >= 0/.test(tr)); }

// #13 設定框換類／重開從頂端看起
{ const body = cutFn(app, "setCat");
  const pane = (cat) => ({ dataset: { setCat: cat }, hidden: false });
  const scr = { scrollTop: 480 }, panes = [pane("display"), pane("plan")];
  const ctx = { $: (id) => (id === "set-cats" ? { querySelectorAll: () => [] } : id === "set-modal" ? { querySelectorAll: () => panes, querySelector: (q) => (q === ".set-content" ? scr : null) } : { hidden: true }),
    akClear: () => {}, srcClear: () => {}, rulesClear: () => {}, aboutIdLoad: () => {}, ccyPaint: () => {}, SHL_SCROLL: false };
  try { vm.runInNewContext(body + "\nsetCat('priv');", Object.assign(ctx, { privLoad: () => {} })); } catch (e) { scr.err = String(e); }
  t("#13 setCat 把 .set-content 捲回 0(重開設定框不停在上次捲到的地方)", scr.scrollTop === 0, scr); }

// R4-7 回合結束的「思考過程」掛 data-i18n,切語言會重畫
t("R4-7 回合結束把 b.verb 掛 data-i18n=turn.process", /b\.verb\.dataset\.i18n = "turn\.process"; b\.verb\.textContent = t\("turn\.process"\);/.test(app));

// R4-3 事件一律拿最長範圍判「恢復／啟動」
t("R4-3 總覽事件抓最長範圍(TR_RANGES 最後一個),畫面照圖表範圍篩", /S\.api\.tradeEvents\(\{ days: TR_RANGES\[TR_RANGES\.length - 1\]\[1\] \}\)/.test(tr) && /if \(ms != null && ms >= from\) rows\.push/.test(tr));

// R3-2 熱圖軸名截尾時全名在 title
t("R3-2 參數掃描與樣本外熱圖左上軸名掛 title(全名)", [["report-robust.js", "sc"], ["report-wf.js", "w"]].every(([f, v]) => { const s = read(f);
  return s.includes('corner.appendChild(el("span", "r mono", ' + v + '.rowParam + " ↓")).title = ' + v + ".rowParam;") && s.includes('corner.appendChild(el("span", "mono", ' + v + '.colParam + " →")).title = ' + v + ".colParam;"); }));

// R5-5 送上雲端等著的那一行寫策略名稱
t("R5-5 「…等著上雲端」代入 hoLabel(策略名稱),字串加引號", /t\("env\.open\.pend", \{ id: typeof hoLabel === "function" \? hoLabel\(pid, RP\.list\) : pid \}\)/.test(tr) && STR.zh["env.open.pend"] === "「{id}」等著上雲端。");

// R5-7 報告沒產出:知道是哪一條就給〔查看〕切回去,句子不講「右邊的對話」
{ const body = cutFn(rpt, "rptPaintTools");
  t("R5-7 rptPaintTools:有 noNewSid 用 rpt.err.noNewView 並接〔查看〕(busyView 那一條)", /RPT\.noNewSid = p\.sid \|\| null/.test(rpt) && /text = t\(noNewSid \? "rpt\.err\.noNewView" : "rpt\.err\.noNew"\)/.test(body)
    && /trackFeature\("rpt_nonew_view"\); busyView\(noNewSid\);/.test(body) && STR.zh["rpt.err.noNewView"] === "這一輪沒有產出新報告。" && !/右邊/.test(STR.zh["rpt.err.noNewView"])); }

// R5-9 找點子那句不再叫 agent「回數字」:讓答案鈕規則接手
t("R5-9 idea.msg 兩語都不要求回數字", !/回數字/.test(STR.zh["idea.msg"]) && !/number/.test(STR.en["idea.msg"]));
{ const ideas = fs.readFileSync(path.join(ROOT, "references", "strategy-ideas.md"), "utf8");
  t("R5-9 references/strategy-ideas.md › Output:有答案鈕時點子進答案鈕、不要人回數字", ideas.includes("When this turn's rule gives answer buttons, they carry the ideas")); }

// #18 agent 的策略說明範例用全形標點
{ const sc = fs.readFileSync(path.join(ROOT, "references", "strategy-code.md"), "utf8");
  t("#18 strategy-code.md 範例 DESCRIPTION 全形逗號;全形規則只管 DESCRIPTION／LOGIC,DISPLAY_NAME 不用「、；：「」」(各層會拒、退回代號)", !sc.includes("集中度,集中度") && sc.includes("Chinese text in `DESCRIPTION` and `LOGIC` uses full-width punctuation")
    && !/Chinese text in `DISPLAY_NAME`/.test(sc) && sc.includes("`DISPLAY_NAME` takes none of `、；：「」;:`")); }

// 0158 P3-11 優化方法框的下拉:焦點是墨／白邊框
t("0158 P3-11 .mg-sel:focus 走 border-color、不留 UA outline", /\.mg-sel:focus \{ border-color: var\(--ink\); outline: none; \}/.test(trCss));

console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
