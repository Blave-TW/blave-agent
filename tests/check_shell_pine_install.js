// 送進 TradingView(spec .claude/output/designer/spec-desktop-pine-install-0.1.8.md;外殼自己貼,不經 agent)。
//   ① shell/browser/pine.js 純邏輯:網址組合、商品對應(只收確定的)、無障礙樹定位、讀回比對
//   ⓪ 流程停在交接(Wei 2026-09-28):貼完之後外殼不再讀那一頁——「檢查結果」「回傳回測結果」「請 agent 修」三個入口與它們背後讀頁面的程式、
//      IPC 都拿掉了;留一條列舉:交接之後沒有任何路徑會再讀那個分頁(含縮圖與快照)
//   ② 流程(假頁面):三步 → 交接;**永遠不按「加到圖表」**;找不到入口 / 讀回不符 → nf;頁面不在畫面上、用戶動手 → 不硬貼
//      登入態(編輯器本來開著、版面晚一步自己開回來、名字被截短、有未存變更跳確認框)、每步上限、診斷、中途被導走
//   ③ renderer/pine-install.js 純邏輯(從原文切出來跑):狀態機、填色歸屬、送給 agent 的那一種固定句(請 agent 貼)
//   ④ 接線:槽、填色切換、IPC 只傳 ref、事件、字串、樣式
//   ⑤ 真站(選跑,發版閘門不跑:連的是別人的網站):BLAVE_LIVE_TV=1 BLAVE_TEST_WINDOW=1 → 離屏視窗(不顯示)匿名跑到交接。
//      會短暫用到剪貼簿(貼完還原);剪貼簿是空的或是圖片就不跑
// 跑法:node tests/check_shell_pine_install.js
const GATE = require("./_electron_gate");
const fs = require("fs"), path = require("path"), os = require("os");
const SHELL = path.join(__dirname, "..", "shell");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };
const read = (...p) => fs.readFileSync(path.join(SHELL, ...p), "utf8");
const PINE = '//@version=6\nstrategy("Blave: BTC SMA Cross", overlay = true)\nfast = ta.sma(close, 45)\nif fast > close\n    strategy.entry("L", strategy.long)\nplot(fast)\n';

if (process.versions.electron) { if (process.env.BLAVE_LIVE_TV === "1") live(); else process.exit(0); } else main().then(() => process.exit(red ? 1 : 0));

async function main() {
  const P = require(path.join(SHELL, "browser", "pine.js"));

  // ── ① 純邏輯 ──
  const U = (symbol, interval, cryptoKline) => P.chartUrl({ symbol, interval, cryptoKline });
  ok("網址:USDT-M 永續 + 1h → BINANCE:<SYM>.P、interval=60", U("BTCUSDT", "1h", true).url === "https://www.tradingview.com/chart/?symbol=BINANCE%3ABTCUSDT.P&interval=60", U("BTCUSDT", "1h", true));
  ok("網址:週期換算 15m / 4h / 1d / 1w", ["15m", "4h", "1d", "1w", "240min"].map((i) => P.tvInterval(i)).join() === "15,240,D,W,240");
  ok("網址:TradingView 不認的週期(6h、2d、月線、亂字)不帶——只帶商品", ["6h", "2d", "1M", "0m", "abc", "", null].every((i) => P.tvInterval(i) === null)
    && U("ETHUSDT", "6h", true).url === "https://www.tradingview.com/chart/?symbol=BINANCE%3AETHUSDT.P");
  const bare = "https://www.tradingview.com/chart/";
  ok("商品對不上 → 不帶任何參數(台股、台指期、沒用 fetch_kline 的、USDC、帶符號的)",
    [["2330", "1d", false], ["TXF", "5m", false], ["BTCUSDT", "1h", false], ["BTCUSDC", "1h", true], ["GOLD(XAU)-USDT", "1h", true], ["BTC-USDT", "1h", true], [null, "1h", true], ["", "1h", true]]
      .every((a) => U(...a).url === bare && U(...a).symbol === null && U(...a).interval === null));
  ok("商品代號不會被拿來組出別的網域或參數", U("X&interval=1#USDT", "1h", true).url === bare && U("a/../bUSDT", "1h", true).url === bare);
  ok("只認 https 的 tradingview.com", P.onTv("https://www.tradingview.com/chart/") && P.onTv("https://tw.tradingview.com/x") && !P.onTv("https://tradingview.com.evil.io/") && !P.onTv("http://www.tradingview.com/") && !P.onTv("https://eviltradingview.com/"));

  const SNAP = (o) => [
    '- button "BTCUSDT.P" [@e2]', '- button "Pine" [@e58]',
    ...(o.tester ? ['- button "Open context menu" [@e60] collapsed', '- button "Jan 1, 2026 — Sep 28, 2026" [@e61] collapsed', '- button "Column setup" [@e62] collapsed'] : []),
    ...(o.editor ? ['- button "Close" [@e66]', `- button ${JSON.stringify(o.title)} [@e67] ${o.menu ? "expanded" : "collapsed"}`, ...(o.extra ? ['- button "Version 3" [@e69]'] : []), `- button "${o.add || "Add to chart"}" [@e68]${o.addOff ? " disabled" : ""}`, `- button "${o.save || "Save script"}" [@e82]`,
      '- button "More" [@e70] collapsed', ...(o.noEd ? [] : [`- textbox "Editor content;Press Alt+F1 for Accessibility Options." [@e${o.ed}] value="secret line of the user's script"`])] : []),
    ...(o.menu ? ['- menuitem "Save script" [@e84]', `- menuitem "${o.create || "Create new"}" [@e89] ${o.sub ? "expanded" : "collapsed"}`] : []),
    ...(o.sub ? ['- menuitem "Indicator" [@e90]', `- menuitem "${o.strat || "Strategy"}" [@e91]`] : []),
    ...(o.dialog ? ['- button "Save" [@e121]', '- button "Don\'t save" [@e122]', '- button "Cancel" [@e123]'] : []),
  ].join("\n");
  const L = P.locate(P.parseSnap(SNAP({ editor: true, title: 'My "old" script', ed: 79, menu: true, sub: true })));
  ok("定位:role + name;腳本名稱鈕認位置(加到圖表前一顆、帶展開狀態),名字有引號也讀得對",
    L.pine.ref === "@e58" && L.add.ref === "@e68" && L.title.ref === "@e67" && L.title.name === 'My "old" script' && L.editor.ref === "@e79" && L.createNew.ref === "@e89" && L.strategy.ref === "@e91", L);
  ok("定位:繁中 / 簡中的名字也認", ["新增到圖表", "添加到图表"].every((n) => P.NAMES.add.test(n)) && ["建立新的", "创建新的"].every((n) => P.NAMES.createNew.test(n)) && P.NAMES.strategy.test("策略") && ["未命名腳本", "无标题脚本"].every((n) => P.NAMES.untitled.test(n)));
  ok("定位:編輯器沒開時找不到「加到圖表」與腳本名稱鈕", (() => { const l = P.locate(P.parseSnap(SNAP({}))); return l.pine && !l.add && !l.title && !l.editor; })());
  // 登入態實測(2026-09-28,診斷 log 的 seen 原樣):腳本已經在圖上,那一格是 disabled 的「Update on chart」,下方開著策略測試器
  const ON_CHART = ['- button "Pine" [@e58]', '- button "Open context menu" [@e60] collapsed', '- button "Jan 1, 2026 — Sep 28, 2026" [@e61] collapsed', '- button "Column setup" [@e62] collapsed',
    '- button "Untitled script" [@e67] collapsed', '- button "Update on chart" [@e68] disabled', '- button "Save script" [@e82]', '- button "More" [@e70] collapsed',
    '- textbox "Editor content;Press Alt+F1 for Accessibility Options." [@e79] value="x"', '- button [@e102]', '- button "Line 1, Col 1" [@e103]'].join("\n");
  ok("定位:腳本已在圖上(Update on chart、disabled)→ 編輯器、名稱鈕、那一格都認得;策略測試器的展開鈕不會被當成名稱鈕", (() => { const l = P.locate(P.parseSnap(ON_CHART)); return l.editor && l.editor.ref === "@e79" && l.title && l.title.ref === "@e67" && l.add && l.add.ref === "@e68"; })(), P.locate(P.parseSnap(ON_CHART)));
  ok("定位:「Update on chart」繁中 / 簡中的名字也認;那一格的名字對不上時用「存檔」當錨(名稱鈕仍找得到)", ["圖表更新", "图表更新"].every((n) => P.NAMES.update.test(n)) && ["儲存腳本", "保存脚本"].every((n) => P.NAMES.save.test(n))
    && (() => { const l = P.locate(P.parseSnap(ON_CHART.replace("Update on chart", "Refresh"))); return l.add === null && l.title && l.title.ref === "@e67" && l.save.ref === "@e82"; })());
  ok("定位:名稱鈕與「加到圖表」之間多一顆鈕也認得(往前三顆以內、帶展開狀態);名字被截短的未命名也算未命名",
    (P.locate(P.parseSnap(SNAP({ editor: true, title: "Untitled …", ed: 79, extra: true }))).title || {}).ref === "@e67" && ["Untitled …", "Untitled script", "未命名…"].every((n) => P.NAMES.untitled.test(n)) && !P.NAMES.untitled.test("My Untitled"));
  ok("診斷的候選元素:只有 role / 名字(≤80 字)/ 狀態,≤30 個,不帶欄位的值", (() => {
    const c = P.candidates(P.parseSnap(SNAP({ editor: true, title: "T".repeat(99), ed: 79, menu: true, sub: true, dialog: true }) + "\n" + Array.from({ length: 60 }, (_, i) => `- menuitem "m${i}" [@e${300 + i}]`).join("\n")));
    return c.length === 30 && c.every((n) => n.name.length <= 80 && Object.keys(n).join() === "role,name,state") && !/secret/.test(JSON.stringify(c)) && c.some((n) => n.role === "textbox") && c.some((n) => n.state === "expanded");
  })());
  ok("定位:「加到圖表」前一顆不是帶展開狀態的鈕 → 不猜", P.locate(P.parseSnap('- button "Close" [@e1]\n- button "Add to chart" [@e2]')).title === null);

  const lastPage = "if fast > close\n    strategy.entry(\"L\", strategy.long)\nplot(fast)\n";
  ok("讀回:第一行與最後一行逐字相符才算貼對", P.pasteOk(PINE, PINE, lastPage) === true);
  ok("讀回:尾巴後面還有別的字(沒蓋掉原本的內容)→ 不算", P.pasteOk(PINE, PINE, lastPage + '// This Pine Script…\nindicator("My script")\n') === false);
  ok("讀回:第一行不是我們的、讀不到、縮排被重排 → 不算", !P.pasteOk(PINE, "// other\n" + PINE, lastPage) && !P.pasteOk(PINE, "", lastPage) && !P.pasteOk(PINE, PINE, "") && !P.pasteOk(PINE, PINE, "    plot(fast)\n"));
  ok("網頁來的字:剝控制字元、零寬、bidi 覆寫、換行,壓空白、截長", P.clean("a\u200b\u202eb\u0007c\u2028d\n e" + "x".repeat(300), 20) === "ab c d e" + "x".repeat(12));
  // ── ② 流程(假頁面)──
  const REF = { pine: "@e58", title: "@e67", add: "@e68", create: "@e89", strat: "@e91" };
  function rig(o) {
    // selfOpen:n = 第 n 次看頁面時面板自己開回來(登入態的版面還原);edLate:n = 面板在了,但編輯器本體第 n 次看才出現;
    // dirty = 目前的腳本有未存的變更(按「策略」跳確認框、腳本不換);leaveAfter = 按了那一顆之後頁面被導到別的站
    o = Object.assign({ visible: true, hoverOnly: false, newScript: true, paste: "ok", enabled: true, editorOpen: false, names: {}, selfOpen: 0, edLate: 0, dirty: false, menuOpen: false, onChart: false }, o || {});
    const st = { editor: o.editorOpen, menu: o.menuOpen, sub: false, ed: 79, title: o.title || "Old strategy", doc: "// old script\nplot(close)\n", cursor: "end", dialog: false, looks: 0, url: o.url || "https://www.tradingview.com/chart/w1EWngqG/?symbol=BINANCE%3ABTCUSDT.P&interval=60" };
    const log = { clicks: [], marks: [], emits: [], arms: 0, disarms: 0, fills: 0, keys: [], lines: [], layout: [], direct: [] };
    st.layout = o.visible ? o.width || 1280 : 1280;   // 頁面排版的寬度:600 以下 TradingView 不畫 Pine 那顆鈕(真站實測);停在視窗外的分頁固定 1280
    const t = { id: "p1", status: "loading", visible: o.visible, userControl: false };
    const nodeOf = (ref) => Number(String(ref).slice(2));
    const page = {
      snapshot: async () => {
        st.looks++; if (o.selfOpen && st.looks >= o.selfOpen) st.editor = true;
        // onChart:目前那支已經在圖上 →「Update on chart」(disabled);開了新腳本才變回「Add to chart」
        const held = o.onChart && (st.ed === 79 || o.stuck) ? { add: "Update on chart", addOff: true, tester: true } : { tester: o.onChart };
        const text = SNAP(Object.assign({ editor: st.editor && !(o.narrowLosesEditor && st.layout <= 600), title: st.title, ed: st.ed, menu: st.menu, sub: st.sub, dialog: st.dialog, noEd: st.looks < o.edLate, extra: o.extra }, held, o.names));
        return { text: st.layout <= 600 ? text.split("\n").filter((l) => !/^- button "Pine" /.test(l)).join("\n") : text };
      },
      node: (ref) => nodeOf(ref),
      center: async (b, on) => { log.direct.push(!on); return { x: 10, y: 10, direct: !on, box: { x: 1, y: 1, w: 20, h: 10 } }; },
      describe: async () => ({ tag: "textarea" }),
      click: async (b) => {
        const ref = "@e" + b; log.clicks.push(ref);
        if (ref === REF.pine) { if (!o.pineDead) st.editor = !st.editor; }
        else if (ref === REF.title) st.menu = !st.menu;
        else if (ref === REF.create) { if (!o.hoverOnly) st.sub = true; }
        else if (ref === REF.strat) { st.menu = false; st.sub = false; if (o.dirty) st.dialog = true; else if (o.newScript) { st.ed = 94; st.title = "Untitled script"; st.doc = "// template\nstrategy(\"My strategy\")\n"; } }
        if (o.takeoverAfter === ref) t.userControl = true;
        if (o.leaveAfter === ref) st.url = "https://accounts.example.com/login?next=tradingview.com";
        return { x: 10, y: 10 };
      },
      fill: async (b, text, d, opt) => { log.fills++; log.fillOpt = opt; if (o.paste === "error") return { error: "obscured", message: "x" }; st.doc = o.paste === "append" ? text + st.doc : text; st.cursor = "end"; return {}; },
      press: async (k, on, mods) => { log.keys.push([k, on, mods]); st.cursor = "top"; return {}; },
      callOn: async (b, fn) => {
        if (/dispatchEvent/.test(fn.toString())) { st.sub = true; return true; }
        const ls = st.doc.split("\n"); return st.cursor === "top" ? ls.slice(0, 10).join("\n") : ls.slice(-4).join("\n");
      },
      run: async (fn, args) => { if (fn === P.dialogUp) return st.dialog ? "warn" : o.promo ? "other" : null; log.marks.push(args && args[0]); return true; },
      disarm: async () => {},
    };
    const v = { page, wc: { getURL: () => st.url, getTitle: () => o.pageTitle || "BTCUSDT.P 84,514.7 ▲ +0.13%" } };
    const d = {
      open: (url) => { log.url = url; if (o.open === "blocked") return { tab: t, blocked: { reason: "x" } }; if (o.open === "error") return { error: "rate_limited" }; return { tab: t }; },
      tab: (id) => (id === t.id ? t : null), view: (id) => (id === t.id ? v : null),
      waitLoaded: async () => { t.status = o.load === "fail" ? "failed" : "ready"; },
      visible: async () => o.visible, input: (_v, fn) => fn(),
      arm: async () => { log.arms++; return true; }, disarm: async () => { log.disarms++; },
      emit: (type, p) => log.emits.push([type, p]), sensitive: () => false, enabled: () => o.enabled, lang: () => "zh", reduced: () => false, sleep: async () => {},
      log: (e) => log.lines.push(e),
    };
    if (o.width !== undefined) Object.assign(d, { width: async () => (o.visible ? o.width : 0), narrow: async () => { log.layout.push("narrow@" + log.clicks.length + "/" + log.fills); st.layout = o.width; },
      widen: async (_t, _v, w) => { log.layout.push("wide " + w); if (o.widenFails) return false; st.layout = w; return true; } });
    return { pine: P.createPine(d), log, t, st };
  }
  const JOB = { content: PINE, strategy: "btc_sma_cross", filename: "btc_sma_cross_pine.pine", symbol: "BTCUSDT", interval: "1h", cryptoKline: true };
  const steps = (log) => log.emits.filter((e) => e[0] === "pine_step").map((e) => e[1].step).join();
  const realNow = Date.now; let clock = realNow();   // 找不到東西的分支要等到逾時:測試裡時間自己走
  Date.now = () => (clock += 500);

  // 中欄變窄(Wei 把聊天欄拉寬,中欄約 560):TradingView 窄版面不畫 Pine 那顆鈕
  {
    const r = rig({ width: 512 }), res = await r.pine.install(JOB);
    ok("中欄 512:先讓頁面以 1280 排版再找鈕 → 照樣走到交接;貼上之前還原成真實寬度(還原排在四次點擊之後、貼上之前)", res.state === "handover" && r.log.layout.join() === "wide 1280,narrow@4/0" && r.st.layout === 512 && r.st.doc === PINE
      && r.log.clicks.join() === [REF.pine, REF.title, REF.create, REF.strat].join(), [res, r.log.layout, r.log.clicks]);
    ok("  寬版面排版中(縮小顯示)不送真滑鼠:四次點擊都走直接 click 那一條;交接時框「加到圖表」用的是還原之後的版面", r.log.direct.slice(0, 4).every((x) => x === true) && r.log.marks.includes("need"), [r.log.direct, r.log.marks]);
    ok("門檻與排版寬度是常數:640 以下才換、換成 1280(真站實測:600 以下沒有那顆鈕、610 以上有)", P.TV_MIN_W === 640 && P.TV_LAYOUT_W === 1280);
    const w = rig({ width: 700 }), rw = await w.pine.install(JOB);
    ok("中欄 700(夠寬):不動版面", rw.state === "handover" && w.log.layout.length === 0, w.log.layout);
    const h = rig({ width: 512, visible: false }), rh = await h.pine.install(JOB);
    ok("分頁不在畫面上(停在視窗外,本來就是 1280):不動版面", h.log.layout.length === 0 && rh.why === "hidden", [rh, h.log.layout]);
    const f = rig({ width: 512, widenFails: true }), rf = await f.pine.install(JOB);
    ok("換不成寬版面 → 找不到鈕的原因是寬度:nf / narrow(不是 pine_button),沒有點任何東西", rf.state === "nf" && rf.why === "narrow" && f.log.clicks.length === 0, rf);
    const g = rig({ width: 512, narrowLosesEditor: true }), rg = await g.pine.install(JOB);
    ok("還原之後編輯器不見了 → nf / narrow,不貼", rg.state === "nf" && rg.why === "narrow" && g.log.fills === 0 && g.st.doc !== PINE, rg);
    const d2 = rig({ width: 512, dirty: true }), rd = await d2.pine.install(JOB);
    ok("中途停下來(未存變更 → 交給用戶)也還原成真實寬度", rd.state === "needs_user" && d2.log.layout[0] === "wide 1280" && /^narrow@/.test(d2.log.layout[d2.log.layout.length - 1]) && d2.st.layout === 512, [rd, d2.log.layout]);
    const pd = rig({ pineDead: true, width: 1000 }), rp = await pd.pine.install(JOB);
    ok("夠寬卻找不到:原因照舊(不是 narrow)", rp.state === "nf" && rp.why !== "narrow", rp);
  }
  {
    const r = rig(), res = await r.pine.install(JOB);
    ok("流程:開圖表 → 開編輯器 → 開新腳本 → 貼上 → 交接", res.state === "handover" && res.id === "p1" && res.set === true && steps(r.log) === "1,2,3" && r.st.doc === PINE && r.st.title === "Untitled script", res);
    ok("流程:按過的只有 Pine、腳本名稱、建立新的、策略——**沒有按「加到圖表」**", r.log.clicks.join() === [REF.pine, REF.title, REF.create, REF.strat].join() && !r.log.clicks.includes(REF.add), r.log.clicks);
    ok("流程:帶好商品與週期的網址;事件先 pine_open、最後 pine_result", r.log.url === "https://www.tradingview.com/chart/?symbol=BINANCE%3ABTCUSDT.P&interval=60" && r.log.emits[0][0] === "pine_open" && r.log.emits[r.log.emits.length - 1][0] === "pine_result" && r.log.emits[1][1].sym === "BTCUSDT.P");
    ok("流程:貼上走編輯器那條(先清空、一次貼入,不逐字)", r.log.fills === 1 && r.log.fillOpt.clear === true && r.log.fillOpt.perChar === false);
    ok("流程:每次動手前開導覽守門,交接時收掉(之後用戶自己按的送出不會被當成程式觸發)", r.log.arms >= 5 && r.log.disarms >= 1);
    ok("流程:交接時「加到圖表」掛「由你按」;全程不畫 agent 游標(沒有 move)", r.log.marks.includes("need") && !r.log.marks.includes("move") && r.log.marks.includes("click"), r.log.marks);
    ok("流程:讀回前把游標移到文件開頭(mac Cmd+↑、其餘 Ctrl+Home)", r.log.keys.length === 1 && r.log.keys[0][1] === true && (process.platform === "darwin" ? r.log.keys[0][0] === "ArrowUp" && r.log.keys[0][2] === 4 : r.log.keys[0][0] === "Home" && r.log.keys[0][2] === 2), r.log.keys);
  }
  { const r = rig({ editorOpen: true }), res = await r.pine.install(JOB); ok("編輯器本來就開著:不按 Pine(那顆是開合)", res.state === "handover" && !r.log.clicks.includes(REF.pine), r.log.clicks); }
  { const r = rig({ editorOpen: true, edLate: 4 }), res = await r.pine.install(JOB); ok("面板開著、編輯器本體還在載:只等、不按 Pine(按了會把面板關掉)", res.state === "handover" && !r.log.clicks.includes(REF.pine) && r.st.editor === true, [res, r.log.clicks]); }
  { const r = rig({ selfOpen: 3 }), res = await r.pine.install(JOB); ok("登入態的版面晚一步自己把編輯器開回來:先等一下,開了就不按 Pine", res.state === "handover" && !r.log.clicks.includes(REF.pine) && r.st.editor === true, [res, r.log.clicks]); }
  { const r = rig({ editorOpen: true, title: "Untitled …", extra: true }), res = await r.pine.install(JOB); ok("名稱被截短(Untitled …)、旁邊多一顆鈕:照樣開新腳本貼上", res.state === "handover" && r.log.clicks.join() === [REF.title, REF.create, REF.strat].join(), [res, r.log.clicks]); }
  {
    const r = rig({ editorOpen: true, onChart: true, title: "Untitled script" }), res = await r.pine.install(JOB);
    ok("登入態、腳本已在圖上(Update on chart):不按 Pine,走到「建立新的 → 策略」、貼進新腳本、交接", res.state === "handover" && r.log.clicks.join() === [REF.title, REF.create, REF.strat].join() && r.log.fills === 1 && r.st.doc === PINE, [res, r.log.clicks]);
    ok("交接時「由你按」掛在新腳本的「加到圖表」上;那顆從頭到尾沒被按", r.log.marks.includes("need") && !r.log.clicks.includes(REF.add), r.log.marks);
  }
  { const r = rig({ editorOpen: true, onChart: true, stuck: true }), res = await r.pine.install(JOB); ok("貼完那一格還是 disabled(按不了)→ 不掛「由你按」", res.state === "handover" && !r.log.marks.includes("need"), [res, r.log.marks]); }
  { const r = rig({ editorOpen: true, onChart: true, dirty: true }), res = await r.pine.install(JOB); ok("腳本已在圖上 + 有未存的變更 → 一樣交給用戶", res.state === "needs_user" && r.log.fills === 0, res); }
  { const r = rig({ editorOpen: true, names: { add: "Refresh" } }), res = await r.pine.install(JOB); ok("那一格的名字兩個都對不上:靠編輯器本體 + 名稱鈕照樣貼;沒有可掛的鈕就不掛「由你按」", res.state === "handover" && r.log.fills === 1 && !r.log.marks.includes("need"), [res, r.log.marks]); }
  { const r = rig({ editorOpen: true, menuOpen: true }), res = await r.pine.install(JOB); ok("腳本選單本來就開著:不按名稱鈕(那顆是開合)", res.state === "handover" && !r.log.clicks.includes(REF.title), [res, r.log.clicks]); }
  {
    const r = rig({ editorOpen: true, dirty: true }), doc = r.st.doc, res = await r.pine.install(JOB);
    ok("目前的腳本有未存的變更(跳確認框)→ needs_user:不按框上任何一顆、不貼、原本的內容沒動", res.state === "needs_user" && res.why === "unsaved" && r.log.fills === 0 && r.st.doc === doc && r.log.clicks.join() === [REF.title, REF.create, REF.strat].join() && r.st.dialog === true, [res, r.log.clicks]);
    ok("診斷:結果帶卡在哪一步與當時看到的候選元素(含框上的鈕),寫一行 log", res.diag.step === 2 && res.diag.dialog === "warn" && res.diag.seen.some((n) => n.name === "Don't save") && r.log.lines.length === 1 && r.log.lines[0].why === "unsaved" && r.log.lines[0].seen.length > 0, [res.diag, r.log.lines]);
    const line = JSON.stringify(r.log.lines[0]);
    ok("log:不含版面代號、網址路徑、編輯器文字、策略碼;欄位固定", !/w1EWngqG|chart\/|secret|old script|strategy\.entry/.test(line) && r.log.lines[0].host === "www.tradingview.com" && r.log.lines[0].layout === true && Object.keys(r.log.lines[0]).join() === "ts,state,why,step,ms,host,layout,dialog,seen", line);
  }
  { const r = rig(), res = await r.pine.install(JOB); ok("成功也寫一行 log(不帶候選元素)", res.state === "handover" && r.log.lines.length === 1 && r.log.lines[0].state === "handover" && r.log.lines[0].seen.length === 0, r.log.lines); }
  { const r = rig({ leaveAfter: REF.title }), res = await r.pine.install(JOB); ok("流程中途頁面被導到別的站 → 下一次動手前就停(不點、不貼)", res.state === "fail" && res.why === "off_site" && r.log.clicks.join() === [REF.pine, REF.title].join() && r.log.fills === 0, [res, r.log.clicks]); }
  { const r = rig({ leaveAfter: REF.strat }), res = await r.pine.install(JOB); ok("新腳本開好之後才被導走 → 不貼", res.state === "fail" && res.why === "off_site" && r.log.fills === 0 && r.log.keys.length === 0, res); }
  {
    // 每一步的上限:什麼都找不到時,「正在開 Pine 編輯器」那一段不超過 15 秒(測試裡的時鐘每問一次走 500ms)
    const span = async (o) => { const r = rig(o), t0 = clock, res = await r.pine.install(JOB); return [res, clock - t0]; };
    const a = await span({ pineDead: true }), b = await span({ editorOpen: true, names: { create: "Nope" } }), c = await span({ editorOpen: true, newScript: false });
    ok("上限:編輯器開不出來 / 找不到新建入口 / 新腳本沒出現,各自 ≤15 秒就回報", [a, b, c].every((x) => x[0].state === "nf" && x[1] <= 15000 + 3000) && a[0].why === "editor" && b[0].why === "create_new" && c[0].why === "new_script", [a, b, c].map((x) => [x[0].why, x[1]]));
  }
  { const r = rig({ hoverOnly: true, visible: false }), res = await r.pine.install(JOB); ok("頁面不在畫面上:子選單靠 hover 事件打開,但不硬貼(全選與貼上送不進去)→ 沒有送出去", res.state === "fail" && res.why === "hidden" && r.log.fills === 0 && r.log.clicks.includes(REF.strat), res); }
  { const r = rig({ names: { add: "新增到圖表", create: "建立新的", strat: "策略" }, newScript: false }); r.st.title = "舊策略"; const res = await r.pine.install(JOB); ok("開不出新腳本 → 停(不貼進用戶原本那一支)", res.state === "nf" && res.why === "new_script" && r.log.fills === 0, res); }
  { const r = rig({ names: { create: "Something else" } }), res = await r.pine.install(JOB); ok("找不到「建立新的」→ 找不到 Pine 編輯器", res.state === "nf" && res.why === "create_new" && r.log.fills === 0, res); }
  { const r = rig({ paste: "append" }), res = await r.pine.install(JOB); ok("讀回不符(原本的內容沒被蓋掉)→ nf,不交接、不掛「由你按」", res.state === "nf" && res.why === "readback" && !r.log.marks.includes("need"), res); }
  { const r = rig({ paste: "error" }), res = await r.pine.install(JOB); ok("貼不進去 → nf", res.state === "nf" && res.why === "paste", res); }
  { const r = rig({ takeoverAfter: REF.title }), res = await r.pine.install(JOB); ok("貼到一半用戶在頁面上動手 → 讓開,不再按任何東西", res.state === "fail" && res.why === "interrupted" && r.log.clicks.join() === [REF.pine, REF.title].join() && r.log.fills === 0, [res, r.log.clicks]); }
  { const r = rig({ load: "fail" }), res = await r.pine.install(JOB); ok("頁面打不開 → 沒有送出去", res.state === "fail" && r.log.clicks.length === 0, res); }
  { const r = rig({ url: "https://accounts.example.com/login" }), res = await r.pine.install(JOB); ok("載完不在 tradingview.com(被轉走)→ 不動手", res.state === "fail" && r.log.clicks.length === 0, res); }
  { const r = rig({ open: "blocked" }), res = await r.pine.install(JOB); ok("被政策擋下 → 沒有送出去", res.state === "fail" && res.why === "open", res); }
  { const r = rig({ enabled: false }), res = await r.pine.install(JOB); ok("設定裡關了內建瀏覽器 → 不開分頁", res.state === "off" && r.log.url === undefined, res); }
  { const r = rig(), res = await r.pine.install({ content: "  ", strategy: "x" }); ok("沒有檔案內容 → 不開分頁", res.state === "fail" && r.log.url === undefined, res); }
  { const r = rig({ pageTitle: "NOSUCHUSDT.P" }), res = await r.pine.install(JOB); ok("商品沒真的帶到(標題沒有價格)→ 照貼,交接卡請用戶自己切", res.state === "handover" && res.set === false, res); }
  { const r = rig(), res = await r.pine.install(Object.assign({}, JOB, { symbol: "2330", cryptoKline: false })); ok("台股:開不帶參數的圖表,交接卡請用戶自己切", res.state === "handover" && res.set === false && r.log.url === bare, [res, r.log.url]); }
  {
    const r = rig(); let second = null;
    const first = r.pine.install(JOB); second = await r.pine.install(JOB); await first;
    ok("一次一個:貼到一半再按 → busy,不開第二個分頁", second.state === "busy");
  }
  { // ⓪ 交接之後沒有任何路徑會再讀那個分頁
    const r = rig(), res = await r.pine.install(JOB), looks = r.log.lines.length;
    const pineSrc0 = read("browser", "pine.js"), idx0 = read("browser", "index.js"), main0 = read("main.js"), pre0 = read("preload.js"), rend0 = read("renderer", "pine-install.js");
    ok("pine.js 交接之後只剩「送進」一個入口:沒有 check / read,也沒有讀頁面數字、主控台、圖例的程式", res.state === "handover" && Object.keys(r.pine).join() === "install,busy"
      && !/readTv|containerCell|consoleWrapper|legend-source-item|classify|statRows|errLines|pineTitle/.test(pineSrc0) && !("readTv" in P) && !("classify" in P), Object.keys(r.pine));
    ok("主行程沒有「檢查」「回傳」兩支 IPC,preload 也沒有;renderer 沒有呼叫點", !/pine-check|pine-read|pineCheck|pineRead/.test(main0 + pre0 + idx0 + rend0) && (main0.match(/handle\("pine-[a-z-]+"/g) || []).join() === 'handle("pine-install"');
    ok("renderer 沒有會讀那一頁的函式與入口(檢查結果、回傳回測結果、請 agent 修)", !/function tv(Check|Read|Fix|Compose|StatLines|FixMsg)\b|tv\.st\.check|tv\.read\b|tv\.fix\b/.test(rend0));
    // 縮圖與快照也是讀:用戶自己開的分頁(送進 TradingView 那一頁是 by:"user")與用戶接手中的分頁都不拍
    ok("縮圖:只拍 agent 開、而且沒被用戶接手的分頁;每 2 秒那一輪與補拍都過同一關", /const shootable = \(t\) => !!t && t\.by === "agent" && !t\.userControl && !t\.searchTab && !t\.verify;/.test(idx0)
      && /if \(!shootable\(t\)\) continue;\n        await captureThumb\(id\);/.test(idx0) && /const t = tabs\.get\(id\), v = views\.get\(id\); if \(!t \|\| !v \|\| !shootable\(t\)\) return;/.test(idx0));
    ok("回合結束的整頁快照:被用戶接手的頁不再拍(留著 agent 讀的那一版)", /const v = views\.get\(r\.id\); if \(!v \|\| !shootable\(tabs\.get\(r\.id\)\)\) continue;/.test(idx0));
    ok("agent 的工具照舊碰不到這一頁(by 不是 agent 的分頁、用戶接手中的分頁)", /if \(!cur \|\| !t \|\| t\.by !== "agent" \|\| t\.userControl\) return false;/.test(idx0) && /open: \(url\) => openUrl\(url, "user"\)/.test(idx0));
    // 列舉:主行程對分頁下的每一個「讀」——CDP 截圖、capturePage、頁面內執行(page.run / callOn)、無障礙快照——所在的函式都在名單上
    // 拍頁面的地方:縮圖(2 處,過 shootable)、agent 讀頁時的快照(captureSnapshotImage 本體 3 處＋定義與 2 個呼叫點:讀頁那條只到得了 agent 的分頁、
    // 回合結束那條過 shootable)、agent 的截圖工具(1 處,同樣只到得了 agent 的分頁)
    const readers = [...idx0.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(captureScreenshot|capturePage\(|captureSnapshotImage\(v)/g)].length;
    ok("列舉:index.js 裡會拍頁面的呼叫點數目沒有變多(多一個就要有人看過它拍不拍得到用戶的頁)", readers === 9, readers);
  }
  Date.now = realNow;

  const pineSrc = read("browser", "pine.js");
  ok("每一步的上限寫在一處;整段「正在開 Pine 編輯器」有總上限", /const LOAD_MS = 20000, SYMBOL_MS = 6000, FIND_MS = 6000, GRACE_MS = 1500, OPEN_MS = 8000, MENU_MS = 3000, NEW_MS = 6000, STEP2_MS = 15000;/.test(pineSrc) && /step\(2\); x\.end = Date\.now\(\) \+ STEP2_MS;/.test(pineSrc));
  ok("每次 click() 開頭與貼上前都再認一次網址", /async function click\(t, v, node, hover\) \{\s*guardSite\(t, v\);/.test(pineSrc) && /guardSite\(t, v\);\s*const f = await d\.input\(v, \(\) => v\.page\.fill\(/.test(pineSrc) && /if \(!onTv\(v\.wc\.getURL\(\)\)\) throw OFF;/.test(pineSrc));
  ok("確認框上的鈕不在定位表裡(外殼找不到也按不到)", !/Don't save|不儲存|Cancel|取消/.test(pineSrc));
  const CDP = require(path.join(SHELL, "browser", "cdp.js")), cdpSrc = read("browser", "cdp.js"), idxSrc = read("browser", "index.js");
  ok("帶修飾鍵的按鍵寫死白名單:mac 只收 Cmd+↑、其餘只收 Ctrl+Home", CDP.modsOk("ArrowUp", 4, "darwin") && CDP.modsOk("Home", 2, "win32") && CDP.modsOk("Home", 2, "linux")
    && [["ArrowUp", 2, "darwin"], ["Home", 2, "darwin"], ["Home", 4, "darwin"], ["ArrowUp", 4, "win32"], ["Enter", 4, "darwin"], ["Enter", 2, "win32"], ["Home", 6, "win32"], ["ArrowUp", 12, "darwin"], ["Home", "2", "win32"], ["Tab", 1, "linux"]].every((a) => !CDP.modsOk(...a)));
  {
    const sent = [], wc = { debugger: { sendCommand: async (m, p) => { sent.push([m, p]); return {}; }, on() {}, isAttached: () => true } }, pg = CDP.createPage(wc);
    const bad = await pg.press("Enter", true, 4), off = await pg.press(process.platform === "darwin" ? "ArrowUp" : "Home", false, process.platform === "darwin" ? 4 : 2), n0 = sent.length;
    const good = await pg.press(process.platform === "darwin" ? "ArrowUp" : "Home", true, process.platform === "darwin" ? 4 : 2);
    ok("press:白名單外的組合、不在畫面上 → invalid_args,一個按鍵事件都不送", bad.error === "invalid_args" && off.error === "invalid_args" && n0 === 0 && !good.error && sent.length === 2, [bad, off, sent]);
  }
  ok("agent 工具那條路不帶修飾鍵", (idxSrc.match(/page\.press\(/g) || []).length === 1 && /v\.page\.press\(key, onScreenK\)\)/.test(idxSrc) && /!modsOk\(key, mods, process\.platform\)/.test(cdpSrc));
  ok("pine.js 沒有任何一處去點「存檔」、碰「登入」「警報」:定位表只有那八個名字(存檔只當位置的錨)", Object.keys(P.NAMES).join() === "pine,add,update,save,createNew,strategy,untitled,editor" && !/alert|webhook|publish/i.test(pineSrc.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")));
  ok("「加到圖表」/「Update on chart」/「存檔」只拿來定位與掛「由你按」:click() 的呼叫點沒有 add、save", (pineSrc.match(/await click\(t, v, [^)]*\)/g) || []).every((c) => !/\.(add|save|update)\b/.test(c)) && (pineSrc.match(/await click\(/g) || []).length === 4);

  // ── ③ renderer 純邏輯 ──
  const src = read("renderer", "pine-install.js");
  const a = src.indexOf("/* ── 純邏輯("), b = src.indexOf("/* ── 純邏輯到此 ── */");
  ok("pine-install.js 有純邏輯區段", a > 0 && b > a);
  const R = new Function(src.slice(a, b) + "\nreturn { tvPasteMsg, tvNext, tvModel, tvStatModel };")();
  const S = (evs, s0) => evs.reduce((s, e) => R.tvNext(s, e), s0 || null);
  const M = (s, o) => R.tvModel(s, o || {});
  { const SEND = { type: "send", ref: { strategy: "a" }, strategy: "a" }, nar = S([SEND, { type: "result", state: "nf", why: "narrow", id: "p1" }]), nf = S([SEND, { type: "result", state: "nf", why: "pine_button", id: "p1" }]);
    ok("中欄太窄(why: narrow):講「把中欄拉寬再試一次」,不講「TradingView 可能改了版面」;不提供「請 agent 貼」(它來貼也一樣找不到)", nar.tv === "nf" && nar.narrow === true && M(nar).msg === "tv.err.narrow" && M(nar).quiet.length === 0
      && nf.narrow === false && M(nf).msg === "tv.err.editor" && M(nf).quiet.join() === "tv.agentPaste", [nar, M(nar), M(nf)]);
    ok("  之後的事件(回合進行中、用戶動手)不會把原因洗掉;再送一次才清", S([{ type: "busy" }], nar).narrow === true && S([{ type: "takeover" }], nar).narrow === true && !S([SEND], nar).narrow);
    ok("  瀏覽器層那張卡:太窄時只有「再試一次」一顆,說明句是太窄那一句", /if \(s\.tv === "nf" && s\.narrow\) return ask\(t\("tv\.nf\.h"\), t\("tv\.nf\.narrow\.p"\), e \? \[\["tv\.retry", "btn-fill", \(\) => tvSend\(e\.ctx\)\]\] : null\);/.test(src)); }
  ok("狀態機:idle → 主鈕「送進」拿填色、說明句是誠實句", (() => { const m = M(null); return m.primary === "tv.send" && m.fill === "ext" && m.cap === "xp.capHonest" && !m.pDis && !m.nav; })());
  ok("狀態機:重開畫回來的舊卡、過期檔 → 填色還給原本那顆", M(null, { old: true }).fill === "base" && M(null, { stale: true }).fill === "base" && M({ tv: "sending" }, { old: true }).fill === "ext");
  const sending = S([{ type: "send", ref: { strategy: "a" }, strategy: "a" }, { type: "step", step: 2, id: "p1", sym: "BTCUSDT.P" }]);
  ok("狀態機:貼上中 → 鈕鎖住、轉圈 +「正在貼進」、有分頁可看", (() => { const m = M(sending); return sending.tv === "sending" && sending.step === 2 && sending.tab === "p1" && m.pDis && m.spin && m.st === "tv.sending" && m.nav; })(), sending);
  const ho = S([{ type: "result", state: "handover", id: "p1", set: true }], sending);
  ok("狀態機:交接(貼好了)→ 主鈕還是「送進 TradingView」、可按(再按 = 再貼進另一支新腳本),退成描邊、填色還給原本那顆;說明句換成貼好之後那一句", (() => { const m = M(ho); return ho.tv === "handover" && m.primary === "tv.send" && m.fill === "base" && m.cap === "tv.sentHint" && !m.pDis && m.msg === null && m.nav; })(), ho);
  ok("狀態機:用戶在頁面上動手 → user;畫法跟交接一樣(主鈕、描邊、說明句)", S([{ type: "takeover" }], ho).tv === "user" && JSON.stringify(Object.assign(M(S([{ type: "takeover" }], ho)), { tv: 0 })) === JSON.stringify(Object.assign(M(ho), { tv: 0 })));
  ok("狀態機:交接的結果晚到第二次(事件 + 回傳)不把「你在操作」退回交接", S([{ type: "takeover" }, { type: "result", state: "handover", set: true }], ho).tv === "user");
  ok("狀態機:idle / 貼上中的 takeover 不改狀態", S([{ type: "takeover" }], sending).tv === "sending" && S([{ type: "takeover" }]).tv === "idle");
  ok("狀態機:主鈕的字永遠是「送進 TradingView」", [null, sending, ho, S([{ type: "takeover" }], ho), S([{ type: "result", state: "nf" }], sending), S([{ type: "result", state: "needs_user" }], sending), S([{ type: "result", state: "fail" }], sending)].every((st) => M(st).primary === "tv.send"));
  ok("狀態機:找不到編輯器 → 填色仍是「送進」、紅字 + 文字鈕「請 agent 貼」", (() => { const n = S([{ type: "result", state: "nf" }], sending), mn = M(n); return mn.fill === "ext" && mn.msg === "tv.err.editor" && mn.quiet.join() === "tv.agentPaste"; })());
  ok("狀態機:分頁不在了 / 關了瀏覽器 / 打不開 / 這一版不認得的結果(舊主行程的 done、compile、closed…)→ 沒有送出去、可再送", ["fail", "gone", "off", "busy", undefined, "done", "compile", "notyet", "reading", "ok", "closed"].every((st) => { const m = M(S([{ type: "result", state: st }], sending)); return m.tv === "fail" && m.primary === "tv.send" && m.msg === "tv.err.unknown" && !m.pDis; }));
  ok("狀態機:退役的狀態與事件都不在了(done / reading / returned / compile / closed / notyet;returned / unsent)", !/"done"|"reading"|"returned"|"compile"|"closed"|notyet|"unsent"|"ok"/.test(src.slice(a, b)));
  ok("狀態機:回合進行中按「請 agent 貼」→ 灰字(不是紅字),下一個事件就收", (() => { const s = S([{ type: "busy" }], ho); return M(s).soft === "tv.err.busy" && M(s).msg === null && M(S([{ type: "takeover" }], s)).soft === null; })());
  ok("狀態機:有未存的變更 → 紅字請用戶自己處理、主鈕仍是「送進」(再試)、不給「請 agent 貼」(agent 去貼會撞上同一個框)", (() => {
    const u = S([{ type: "result", state: "needs_user", why: "unsaved", id: "p1" }], sending), m = M(u);
    return u.tv === "unsaved" && m.primary === "tv.send" && !m.pDis && m.msg === "tv.err.unsaved" && m.quiet.length === 0 && m.nav && R.tvStatModel(u).join("|") === "warn|tv.st.unsaved|";
  })());
  ok("瀏覽器層狀態句:貼上中三步、找不到、未存變更;貼好之後(交接、用戶動手)照一般分頁畫——不寫「等你按」、不寫「你在操作」、沒有「檢查結果」", (() => {
    const K = (s) => { const m = R.tvStatModel(s); return m ? m.join("|") : null; };
    return K({ tv: "sending", step: 1, sym: "BTCUSDT.P" }) === "spin|tv.st.chart|1" && K({ tv: "sending", step: 1 }) === "spin|tv.st.chartN|1" && K({ tv: "sending", step: 2 }) === "spin|tv.st.editor|2" && K({ tv: "sending", step: 3 }) === "spin|tv.st.paste|3"
      && K({ tv: "nf" }) === "warn|tv.st.nf|" && K({ tv: "unsaved" }) === "warn|tv.st.unsaved|" && [{ tv: "handover" }, { tv: "user" }, { tv: "fail" }, { tv: "idle" }, null].every((s) => K(s) === null);
  })());
  ok("請 agent 貼:只放合規的資料夾名", R.tvPasteMsg("btc_sma_cross", "paste {id} now") === "paste btc_sma_cross now" && [null, "", "a b", "a/b", "x".repeat(65), "顯示名稱"].every((id) => R.tvPasteMsg(id, "paste {id}") === null) && R.tvPasteMsg("a", "no slot") === null);

  // ── ③b 程式碼分頁的排法(設計稽核 0.1.8 第三批 D2):真的跑 tvPaintSlot,看節點掛在哪 ──
  { const mkEl = (tag, cls, text) => { const n = { tag, className: cls || "", kids: [], attrs: {}, parent: null, hidden: false, disabled: false, _t: text == null ? "" : String(text),
      get textContent() { return this._t + this.kids.map((k) => k.textContent).join(""); }, set textContent(v) { this._t = String(v); this.kids = []; },
      setAttribute(k, v) { this.attrs[k] = String(v); }, addEventListener() {},
      appendChild(c) { if (typeof c === "string") c = mkEl("#text", "", c); if (c.parent) c.remove(); c.parent = this; this.kids.push(c); return c; }, append(...c) { c.forEach((x) => this.appendChild(x)); },
      insertBefore(c, ref) { if (!ref) return this.appendChild(c); if (c.parent) c.remove(); c.parent = this; this.kids.splice(this.kids.indexOf(ref), 0, c); return c; },
      after(c) { const p = this.parent; if (c.parent) c.remove(); c.parent = p; p.kids.splice(p.kids.indexOf(this) + 1, 0, c); },
      before(c) { const p = this.parent; if (c.parent) c.remove(); c.parent = p; p.kids.splice(p.kids.indexOf(this), 0, c); },
      remove() { if (this.parent) { this.parent.kids = this.parent.kids.filter((x) => x !== this); this.parent = null; } },
      has(cls2) { return (" " + this.className + " ").includes(" " + cls2 + " "); },
      all(f, out = []) { this.kids.forEach((k) => { if (f(k)) out.push(k); k.all(f, out); }); return out; },
      querySelectorAll(sel) { return this.all((k) => k.has(sel.replace(/^\./, ""))); },
      querySelector(sel) { return sel === ".xp-st:not(.tv-x)" ? this.all((k) => k.has("xp-st") && !k.has("tv-x"))[0] || null : this.querySelectorAll(sel)[0] || null; } };
      return n; };
    const paint = (where, state, lang, runningNow) => {
      const host = mkEl("div", "xp-view"), row = mkEl("div", where === "code" ? "xv-acts" : "xp-acts"), grp = mkEl("div", "grp"), own = mkEl("span", "xp-st"), slot = mkEl("span", "xp-ext"), btn = mkEl("button", "btn-fill");
      host.append(mkEl("p", "xp-cap"), row, mkEl("div", "xv-steps"));
      if (where === "code") { grp.append(mkEl("button", "btn-fill", "copy"), slot); row.append(grp, own); } else row.append(mkEl("button", "btn-quiet", "view"), own, slot);
      const e = { ctx: { where, wrap: host, row, base: null, strategy: "s", id: where === "card" ? "c1" : null }, btn };
      const i = src.indexOf("function tvPaintSlot(e) {"), j = src.indexOf("/* ── 動作 ── */", i);
      new Function("R", "STR", "lang", "xpMk", "state", "running", "e", src.slice(i, j) + "\nconst tvSlotEl = () => slot0, tvCan = () => true, tvStateOf = () => state, tvModel = R.tvModel, xpFill = () => {}, tvOpenOn = () => false,"
        + " t = (k) => STR[lang][k] || k, brEl = xpMk, trackFeature = () => {}, brExpand = () => {}, tvAgentPaste = () => {}, slot0 = e.ctx.row.querySelector('.xp-ext');\ntvPaintSlot(e); tvPaintSlot(e);")(
        R, new Function(read("renderer", "strings.js") + "\nreturn STRINGS;")(), lang, mkEl, state, runningNow === true, e);
      return { host, row, grp }; };
    const shape = (o) => { const box = o.host.kids[o.host.kids.indexOf(o.row) + 1], inRow = o.row.all((k) => k.has("tv-x")), boxes = o.host.all((k) => k.has("xv-msg"));
      return { boxes: boxes.length, after: !!box && box.has("xv-msg"), inRow: inRow.length, kids: box && box.has("xv-msg") ? box.kids.map((k) => k.tag + "." + k.className.replace(" tv-x", "") + (k.has("xp-acts") ? "[" + k.kids.length + "]" : "")).join(" | ") : "" }; };
    const nf = { tv: "nf", tab: "t1" };
    const zh = shape(paint("code", nf, "zh")), en = shape(paint("code", nf, "en"));
    ok("找不到編輯器:訊息自己一行、兩顆出口鈕在下面一行,裝在動作列後面的容器裡——動作列裡什麼都不插", zh.after && zh.inRow === 0 && zh.kids === "p.xp-st err | div.xp-acts[2]", zh);
    ok("zh 與 en 同一個排法(同一個狀態不再兩種樣子);重畫不會疊出第二個容器", JSON.stringify(zh) === JSON.stringify(en) && zh.boxes === 1, [zh, en]);
    ok("有未存變更 / 沒送成 / 正在回覆(灰字):句子一樣自己一行", ["unsaved", "fail"].every((tv) => /^p\.xp-st err( \||$)/.test(shape(paint("code", { tv, tab: "t1", errors: [] }, "zh")).kids))
      && /^p\.xp-st( \||$)/.test(shape(paint("code", { tv: "idle", soft: "busy" }, "zh", true)).kids) && shape(paint("code", { tv: "idle", soft: "busy" }, "zh", true)).inRow === 0);
    ok("送出中的狀態句也自己一行;沒有東西要講(idle)就不起容器", shape(paint("code", { tv: "sending", step: 1 }, "en")).kids.startsWith("p.xp-st") && shape(paint("code", { tv: "idle" }, "zh")).boxes === 0);
    const card = paint("card", nf, "zh"), cs = shape(card);
    ok("對話裡的卡不變:訊息在動作列上面、鈕在動作列裡,不起 .xv-msg", cs.boxes === 0 && cs.inRow === 2 && card.host.kids[card.host.kids.indexOf(card.row) - 1].has("xp-msg"), cs);
    ok("樣式:容器上距 8、出口鈕那一行上距 4、間距沿用 .xp-acts 的 16", /\.xv-msg \{ margin-top: var\(--space-8\); \}/.test(read("renderer", "export.css")) && /\.xv-msg \.xp-acts \{ margin-top: var\(--space-4\); \}/.test(read("renderer", "export.css"))
      && /\.xp-acts \{ display: flex; flex-wrap: wrap; align-items: center; gap: var\(--space-8\) var\(--space-16\);/.test(read("renderer", "export.css"))); }

  // ── ④ 接線 ──
  const xp = read("renderer", "export.js"), br = read("renderer", "browser.js"), mainSrc = read("main.js"), pre = read("preload.js"), idx = read("browser", "index.js"), css = read("renderer", "export.css"), html = read("renderer", "index.html");
  ok("槽:pine-install.js 往 XP_ACTIONS 推 provider;在 export.js、browser.js 之後載入", /XP_ACTIONS\.push\(tvProvide\);/.test(src) && html.indexOf('src="pine-install.js"') > html.indexOf('src="browser.js"') && html.indexOf('src="browser.js"') > html.indexOf('src="export.js"'));
  ok("槽:只有 Pine 的卡與程式碼分頁有(XQ / MC 沒有)", (xp.match(/xpExt\(\{/g) || []).length === 2 && (xp.match(/if \((c\.target|k) === "pine"\) \w+\.appendChild\(xpExt\(/g) || []).length === 2 && /if \(ctx\.target !== "pine"/.test(src));
  ok("填色:槽拿填色時原本那顆退描邊(xpFill);過期那一面不動;重開畫回來的卡帶 old", /function xpFill\(ctx, who\) \{ if \(ctx\.base && !ctx\.stale\) ctx\.base\.className = who === "ext" \? "btn-out" : "btn-fill"; \}/.test(xp)
    && /function xpRestore\(rec\) \{ xpPut\(xpHost\(null\), xpCard\(rec, true\)\); \}/.test(xp) && /old: !!old/.test(xp) && /base: dl/.test(xp) && /base: cp/.test(xp) && /xpFill\(c, m\.fill\)/.test(src));
  ok("不畫的時候(關了內建瀏覽器、雲端視角、時光機):不放鈕、填色還給原本那顆——不是灰掉", /const tvCan = \(\) => TV\.on === true && xpLocal\(\) && !XP\.tm;/.test(src) && /if \(!tvCan\(\)\) \{\s*if \(e\.btn\.parentNode === slot\) e\.btn\.remove\(\);\s*xpFill\(c, "base"\)/.test(src));
  ok("每一顆鈕都只認用戶真的按(isTrusted)——含會開 agent 回合的「請 agent 貼」", (() => {
    const ls = src.match(/addEventListener\("click", [^\n]*/g) || [];
    return ls.length === 4 && ls.every((l) => /^addEventListener\("click", \(ev\) => \{? ?if \(!?ev\.isTrusted\)/.test(l));
  })(), src.match(/addEventListener\("click", [^\n]*/g));
  ok("未存變更的卡:只有「再試一次」", /if \(s\.tv === "unsaved"\) return ask\(t\("tv\.unsaved\.h"\), t\("tv\.unsaved\.p"\), e \? \[\["tv\.retry", "btn-out", \(\) => tvSend\(e\.ctx\)\]\] : null\);/.test(src));
  ok("只有用戶真的按才動(isTrusted);中欄只在按了送進那一次自己打開", /if \(ev\.isTrusted\) tvPrimary\(e, btn\)/.test(src) && /Number\(ev\.step\) === 1 && TV\.armed && ev\.id\) \{ TV\.armed = false; brExpand/.test(src));
  ok("過期檔 / 舊卡按送進:先開確認框", /if \(\(c\.stale \|\| c\.old\) && c\.at\) \{[^}]*confirmBox\(\{ title: t\("tv\.cf\.stale\.h"\)/.test(src));
  ok("回合進行中:請 agent 貼不搶(送進不開回合,不受限)", (src.match(/if \(running === true\) \{/g) || []).length === 1 && !/async function tvSend\(c\) \{[^}]*running/.test(src));
  ok("IPC:renderer 只給 ref——不給內容、不給路徑、不給網址", /pineInstall: \(ref\) => ipcRenderer\.invoke\("pine-install", ref \? \{ session: ref\.session, id: ref\.id, strategy: ref\.strategy \} : null\)/.test(pre)
    && /handle\("pine-install", \(_e, ref\) => \{ const job = pineJob\(/.test(mainSrc) && !/pineInstall\([^)]*(content|url|path)/.test(src));
  ok("主行程自己取檔:卡 → exportById 的快照、程式碼分頁 → workspace 那一份(檔名取 exportRef);只收 pine", /const r = exportById\(ref\.session, ref\.id\); if \(!r \|\| r\.target !== "pine"\) return null;/.test(mainSrc) && /const rec = exportRef\(name, "pine"\);/.test(mainSrc) && /if \(!stratNames\(\)\.includes\(name\)\) return null;/.test(mainSrc));
  ok("分頁是 user 分頁、沿用同一個隔離 session 與守門", /open: \(url\) => openUrl\(url, "user"\)/.test(idx) && /arm: markAgent/.test(idx) && /agentUntil\.delete\(v\.wc\.id\); backstop\.delete\(v\.wc\.id\); return v\.page\.disarm\(\);/.test(idx));
  ok("診斷 log:~/Blave/state/pine-install.log,一行一筆、0600、超過 256KB 換檔;pine.js 自己不寫檔", /pineLog: path\.join\(BASE, "state", "pine-install\.log"\)/.test(mainSrc) && /log: pineLog,/.test(idx)
    && /if \(fs\.statSync\(o\.pineLog\)\.size > 256 \* 1024\) fs\.renameSync\(o\.pineLog, o\.pineLog \+ "\.1"\);/.test(idx) && /fs\.appendFileSync\(o\.pineLog, JSON\.stringify\(entry\) \+ "\\n", \{ mode: 0o600 \}\);/.test(idx));
  ok("browser.js:狀態句、訊息槽、簽章、事件、換對話都接到 pine-install.js", /tvStat\(host, x\)\) return;/.test(br) && /const tvn = typeof tvSlot === "function" \? tvSlot\(x\) : null;/.test(br) && /tvSig\(exp\.id\)/.test(br)
    && /case "pine_open": BR\.pineNext = true; return;/.test(br) && /case "pine_step": case "pine_result": if \(typeof tvOnEvent === "function"\) tvOnEvent\(ev\); return;/.test(br) && /function brReset\(\) \{ if \(typeof tvReset === "function"\) tvReset\(\);/.test(br));
  ok("槽認「那一列還在不在」:程式碼分頁重畫後舊的那顆不會再被塞回去", /TV\.slots = TV\.slots\.filter\(\(e\) => e\.ctx\.row\.isConnected\);/.test(src) && /const tvSlotEl = \(c\) => \(c\.where === "code" \? c\.row : c\.wrap\)\.querySelector\("\.xp-ext"\);/.test(src));
  ok("不跨重開保存:狀態只在記憶體(沒有 localStorage、沒有寫檔的 IPC)", !/localStorage|sessionStorage/.test(src) && !/writeFile|appendFile/.test(pineSrc));
  ok("樣式:槽在程式碼分頁排最前;聊天容器 <520 檔名獨佔一行", /\.xv-acts \.grp \.xp-ext \{ order: -1; \}/.test(css) && /@container chat \(max-width: 520px\) \{\s*\.xp:has\(\.xp-ext:not\(:empty\)\) \{ flex-wrap: wrap;[^}]*\}\s*\.xp:has\(\.xp-ext:not\(:empty\)\) \.f \{ flex: 1 1 100%; \}/.test(css) && !/#[0-9a-fA-F]{3,8}\b/.test(css.slice(css.indexOf("Pine 的動作槽"))));
  const STR = new Function(read("renderer", "strings.js") + "\nreturn STRINGS;")();
  const keys = [...new Set((src.match(/"tv\.[A-Za-z.]+"/g) || []).map((k) => k.slice(1, -1)))];
  ok("字串:用到的 tv.* 兩種語言都有(" + keys.length + " 個),英文按鈕 Title Case", keys.length >= 25 && keys.every((k) => STR.zh[k] && STR.en[k]) && ["tv.send", "tv.agentPaste", "tv.retry", "tv.cf.stale.ok"].every((k) => STR.en[k].split(" ").every((w) => /^(to|[A-Z])/.test(w))), keys.filter((k) => !STR.zh[k] || !STR.en[k]));
  ok("字串:會花額度的那一顆字面寫「請 agent」;固定句恰好一個插槽", /^請 agent/.test(STR.zh["tv.agentPaste"]) && ["zh", "en"].every((l) => STR[l]["tv.msg.paste"].split("{id}").length === 2));
  { const GONE = ["tv.read", "tv.reading", "tv.readAgain", "tv.returnedAt", "tv.returnedLoop", "tv.msg.head", "tv.msg.line", "tv.msg.empty", "tv.msg.sent", "tv.st.check", "tv.notyet", "tv.st.wait", "tv.st.reading", "tv.st.done", "tv.done.h", "tv.done.p",
      "tv.st.compile", "tv.cmp.h", "tv.cmp.p", "tv.err.compile", "tv.fix", "tv.msg.fix", "tv.err.closed"];
    ok("字串(設計師定稿):太窄的兩句兩語都在,都講「拉寬再試一次」;zh 講「按鈕」不講「入口」(en 是 button,用戶找的是一顆鈕)", /Pine 編輯器的按鈕/.test(STR.zh["tv.err.narrow"]) && /Pine 編輯器的按鈕/.test(STR.zh["tv.nf.narrow.p"]) && !/入口/.test(STR.zh["tv.err.narrow"] + STR.zh["tv.nf.narrow.p"])
      && /Pine Editor button/.test(STR.en["tv.err.narrow"]) && /Pine Editor button/.test(STR.en["tv.nf.narrow.p"]) && /拉寬/.test(STR.zh["tv.err.narrow"]) && /再試一次/.test(STR.zh["tv.nf.narrow.p"]) && /Widen it/.test(STR.en["tv.err.narrow"]) && /try again/.test(STR.en["tv.nf.narrow.p"]) && !/改了版面/.test(STR.zh["tv.err.narrow"] + STR.zh["tv.nf.narrow.p"]));
    ok("字串:退役的 23 個 key 兩語都拿掉,程式也不再引用", GONE.length === 23 && GONE.every((k) => !(k in STR.zh) && !(k in STR.en) && src.indexOf('"' + k + '"') < 0), GONE.filter((k) => k in STR.zh || k in STR.en || src.indexOf('"' + k + '"') >= 0));
    ok("字串:交接卡講「貼完之後這一頁不會再被讀取」;方案限制搬進交接卡;貼好之後那一句指路到聊天;回合進行中那一句不再講回傳", /貼完之後這一頁不會再被讀取/.test(STR.zh["tv.ho.p"]) && /isn’t read again/.test(STR.en["tv.ho.p"])
      && /t\("tv\.planHint"\)/.test(src.slice(src.indexOf("function tvSlot("))) && /把錯誤訊息貼到聊天/.test(STR.zh["tv.sentHint"]) && !/回傳/.test(STR.zh["tv.sentHint"] + STR.zh["tv.err.busy"]) && !/Send (the )?[Rr]esults/.test(STR.en["tv.sentHint"] + STR.en["tv.err.busy"])); }
  const tvCopy = Object.keys(STR.zh).filter((k) => /^tv\./.test(k)).map((k) => STR.zh[k] + " " + STR.en[k]).join(" ");
  ok("文案:不把 TradingView 跟自動交易放在一起,不出現警報 / webhook,不講「一鍵」", !/自動交易|自動下單|下單|auto[- ]?trad|place orders|警報|alert|webhook|一鍵|one[- ]click/i.test(tvCopy));
  const TM = require(path.join(SHELL, "telemetry.js")).EVENTS.feature_used.name;
  const sent = [...new Set((src.match(/trackFeature\("tv_[a-z_]+"\)/g) || []).map((s) => s.slice(14, -2)))].sort();
  ok("埋點:還有送出點的是四個(tv_send / tv_pasted / tv_agent_paste / tv_fail_editor);tv_read / tv_fix / tv_fail_compile 沒有送出點了,名字留在白名單(舊外殼還在送)", sent.join() === ["tv_agent_paste", "tv_fail_editor", "tv_pasted", "tv_send"].join() && sent.every((n) => TM.includes(n) && n.length <= 16)
    && TM.slice(-8).join() === "tv_send,tv_pasted,tv_read,tv_fix,tv_agent_paste,tv_fail_editor,tv_fail_compile,browser_open_ext", sent);

  // ── ⑤ 真站(選跑)──
  if (process.env.BLAVE_LIVE_TV === "1") {
    const bin = GATE.bin(SHELL, "⑤");
    if (bin) { const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit", env: { ...process.env, ELECTRON_ENABLE_LOGGING: "" } }); if (r.status) red++; }
  } else console.log("SKIP  真站那段(BLAVE_LIVE_TV=1 才跑:離屏視窗、匿名、會短暫用到剪貼簿)");
  console.log(red ? "\n" + red + " FAILED" : "\nALL PASS");
}

// 離屏視窗(offscreen:不顯示、不搶焦點,但頁面是 visible、真鍵盤真滑鼠送得進去)。不登入、不按「加到圖表」
function live() {
  const { app, BrowserWindow, clipboard } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "blave-pine-live-")));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  app.whenReady().then(async () => {
    try {
      const fmts = clipboard.availableFormats ? await clipboard.availableFormats() : [], txt = await clipboard.readText();
      if (!txt || fmts.some((f) => /image/.test(f))) { console.log("SKIP  真站:剪貼簿是空的或是圖片,不動它"); return app.exit(0); }
      const win = new BrowserWindow({ width: 1400, height: 900, show: false, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, partition: "pine-live" } });
      const wc = win.webContents; wc.setAudioMuted(true);
      const P = require(path.join(SHELL, "browser", "pine.js")), page = require(path.join(SHELL, "browser", "cdp.js")).createPage(wc);
      const t = { id: "live", status: "loading", visible: true, userControl: false }, v = { page, wc }, steps = [], lines = [];
      let reload = true;
      wc.on("did-stop-loading", () => { t.status = "ready"; });
      const pine = P.createPine({
        open: (url) => { if (reload) { wc.loadURL(url).catch(() => {}); page.attach().catch(() => {}); } return { tab: t }; }, tab: () => t, view: () => v,
        waitLoaded: async (tt, ms) => { const end = Date.now() + ms; while (Date.now() < end && tt.status !== "ready") await sleep(200); },
        visible: async () => { try { return (await page.run(function () { return document.visibilityState; })) === "visible"; } catch (_) { return false; } },
        input: (_v, fn) => fn(), arm: () => page.guard(3000, (req) => req.method === "GET" || req.method === "HEAD").then(() => true, () => false), disarm: () => page.disarm(),
        emit: (type, p) => { if (type === "pine_step") steps.push(p.step); }, sensitive: require(path.join(SHELL, "browser", "gate.js")).sensitiveField, enabled: () => true, lang: () => "en", reduced: () => true, sleep, log: (e) => lines.push(e),
      });
      const r = await pine.install({ content: PINE, strategy: "btc_sma_cross", filename: "btc_sma_cross_pine.pine", symbol: "BTCUSDT", interval: "1h", cryptoKline: true });
      ok("真站:匿名跑到交接(開圖表 → Pine 編輯器 → 新腳本 → 貼上 → 讀回相符)", r.state === "handover" && r.set === true && steps.join() === "1,2,3", r);
      ok("真站:剪貼簿貼完還原", (await clipboard.readText()) === txt);
      ok("真站:沒有跳出登入框(沒按「加到圖表」)", (await page.run(function () { return document.querySelectorAll('[data-dialog-name="sign-in"]').length; })) === 0);
      // 同一頁再送一次 = 編輯器開著、剛貼的那支還沒存(登入態再送一次就是這個樣子;匿名時換頁會重置,所以不重載)
      reload = false;
      const edit = async () => { const l = P.locate(P.parseSnap((await page.snapshot({ interactive_only: true }, () => false)).text)); return l.editor ? page.callOn(page.node(l.editor.ref), function () { return String(this.value); }) : null; };
      const was = await edit(), r2 = await pine.install({ content: PINE.replace("45", "50"), strategy: "btc_sma_cross", filename: "btc_sma_cross_pine.pine", symbol: "BTCUSDT", interval: "1h", cryptoKline: true });
      ok("真站:編輯器開著 + 有未存的變更 → needs_user(確認框留給用戶,沒貼、內容沒變)", r2.state === "needs_user" && r2.why === "unsaved" && (await edit()) === was && (await page.run(P.dialogUp)) === "warn", r2);
      ok("真站:診斷那一行有候選元素、沒有網址路徑與編輯器文字", lines.length === 2 && lines[1].seen.length > 0 && !/\/chart|ta\.sma/.test(JSON.stringify(lines[1])), lines[1]);
    } catch (e) { ok("真站:跑完沒有例外", false, String(e && e.stack || e)); }
    app.exit(red ? 1 : 0);
  });
}
