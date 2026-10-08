/* window.BlaveReport.renderWf(el, { stats, wf, code, name }, opts)
 * window.BlaveReport.wfSync(el, opts) — 回合開始 / 結束、雲端版本旗標翻面時叫:已送出態翻了就整片重畫,否則就地換鈕態
 * — 報告頁「樣本外驗證」分頁(雲端工作頁 data-tab="wf" 那一段的移植,spec-workspace-walkforward-2026-09-10)。
 *
 * 純函式(sanitizeWf / wfBand / wfPreset / wfRunsOf / wfTotalDays / wfMarkMode / wfRunMarks)與 DOM 結構照抄
 * workspace.html 的 wf 段,規則一條不改——兩邊看同一份 wf.json 要得出同一個結論。參數格式、常數讀法、軸上定位
 * 借 report-robust.js 的 _rob(同一套,不另抄)。這頁刻意沒有「採用」鈕、不出現任何 p 值(Wei 09-10 #10)。
 *
 * 這支**不依賴桌面版的全域**,環境全在 opts:`t` = i18n;`onRun(name, lookback, step, rerun, opener, begin)` = 送出(確認框按下時先叫 begin())
 * (回 Promise<turn|false>);`busy` / `turn` = 回合狀態(「已送出」只認送出那一輪);`scope` = 本機 / 雲端;
 * `gate` = 主機的 lib 帶不帶 walk_forward(true / false / null,false 才擋);`onUpdate(btn)` = 落後時那顆鈕;
 * `buildMeta(stats)` = 回測那一行 meta;`resync()` = 沒送出去時照現在的回合狀態重畫;`refocus()` = 重畫拿掉焦點時交給分頁鈕;
 * 雲端才用的:`refetch(name)` = 背景重抓雲端那一支(回 false = 人已經不在那一支)。回合結束另由呼叫端叫 `wfTurnEnded(turn, failed, { refetch })`;
 * 切回分頁 / 視窗回前景時呼叫端先問 `wfAwaiting(data, opts)`,是才補抓。
 *
 * SECURITY: wf.json 是 agent 寫的、雲端那份又經 api 轉過一手——逐欄型別檢查(數值有限、索引在網格內、每軸 ≤40、
 * 參數名 ≤64 字、輪數與序列長度有上限)後才用,文字一律只進 textContent。 */
(function () {
  "use strict";

  const DASH = "—";
  const WF_MIN_DENOM = 0.25;   // 樣本內 Sharpe 低於這條就不做除法(分母護欄)
  const WF_MIN_RUNS = 3;       // 少於 3 輪,每輪明細與重選落點都看不出東西 → 擋下送出
  const WF_MAX_RUNS = 1000;    // 同 api / lib 的 sanity bound
  // 曲線的重選線:≤12 輪整條虛線、13–60 輪 X 軸短刻度、>60 輪不畫改 legend 文字
  const WF_MARK_LINE_MAX = 12;
  const WF_MARK_TICK_MAX = 60;
  const WF_MAX_POINTS = 4000;  // 曲線點數上限(機器端與 api 兩側同樣卡 4000)
  const WF_MAX_DAYS = 20000;   // 窗長 / 總天數的合理上限
  const WF_STR_MAX = 32;       // 日期字串長度上限
  const WF_GRID_MAX_LINES = 24;   // 格線圈數硬上限:lo/hi 由未信任的 cum 推出來
  // oos_stats / is_stats 的四個欄位:沿用 runner.py 既有字串
  const WF_STAT_KEYS = ["Sharpe Ratio", "Ann. Return [%]", "Max Drawdown [%]", "Trades"];

  const rob = () => (window.BlaveReport && window.BlaveReport._rob) || {};
  const fmtPct = (v) => { const f = window.BlaveReport && window.BlaveReport.fmtSignedPct; return f ? f(v) : null; };

  // ---------------------------------------------------------------- 純計算(照抄雲端)

  function wfNum(v) { return typeof v === "number" && isFinite(v) ? v : null; }
  function wfPosInt(v, max) { return Number.isInteger(v) && v > 0 && v <= max ? v : null; }
  function wfStr(v) { return typeof v === "string" && v && v.length <= WF_STR_MAX ? v : null; }
  function wfStats(o) {
    const out = {};
    if (!o || typeof o !== "object") return out;
    WF_STAT_KEYS.forEach((k) => { out[k] = wfNum(o[k]); });
    return out;
  }
  // 參數對 = 兩個值(不是索引):過時判定要拿它跟程式碼裡的常數比
  function wfPairVals(v) {
    if (!Array.isArray(v) || v.length !== 2) return null;
    const a = wfNum(v[0]), b = wfNum(v[1]);
    return a === null || b === null ? null : [a, b];
  }
  function wfSame(a, b) { return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)); }
  // "YYYY-MM-DD" 兩日相差幾天;任一不合就回 null(不猜)
  function wfDays(a, b) {
    if (!/^\d{4}-\d{2}-\d{2}/.test(a || "") || !/^\d{4}-\d{2}-\d{2}/.test(b || "")) return null;
    const t0 = Date.parse(a.slice(0, 10) + "T00:00:00Z"), t1 = Date.parse(b.slice(0, 10) + "T00:00:00Z");
    if (!isFinite(t0) || !isFinite(t1) || t1 <= t0) return null;
    return Math.round((t1 - t0) / 86400000);
  }

  function sanitizeWf(raw, code) {
    if (!raw || typeof raw !== "object") return null;
    const R = rob();
    const lookback = wfPosInt(raw.lookback_days, WF_MAX_DAYS), step = wfPosInt(raw.step_days, WF_MAX_DAYS);
    if (lookback === null || step === null) return null;   // 沒有窗長就不是一份結果

    // 每輪明細:任一輪型別不對就整塊不要(半份表比沒有更糟)
    let runs = null;
    if (Array.isArray(raw.runs) && raw.runs.length && raw.runs.length <= WF_MAX_RUNS) {
      const out = [];
      for (let i = 0; i < raw.runs.length; i++) {
        const r = raw.runs[i];
        if (!r || typeof r !== "object") { out.length = 0; break; }
        const k = wfPosInt(r.k, WF_MAX_RUNS);
        const tr0 = wfStr(r.train_start), tr1 = wfStr(r.train_end), te0 = wfStr(r.test_start), te1 = wfStr(r.test_end);
        if (k === null || !tr0 || !tr1 || !te0 || !te1) { out.length = 0; break; }
        out.push({ k, tr0, tr1, te0, te1, params: wfPairVals(r.params), trS: wfNum(r.train_sharpe), teS: wfNum(r.test_sharpe), ret: wfNum(r.test_return) });
      }
      if (out.length) runs = out;
    }

    // 落點圖的兩條軸;缺了整塊不畫(沒有軸就不知道「離多遠」),每輪表照畫
    const rows = R.numList(raw.row_vals), cols = R.numList(raw.col_vals);
    const rowParam = typeof raw.row_param === "string" && raw.row_param && raw.row_param.length <= 64 ? raw.row_param : null;
    const colParam = typeof raw.col_param === "string" && raw.col_param && raw.col_param.length <= 64 ? raw.col_param : null;

    // 樣本外曲線:dates 與 cum 等長才畫。cum 是累積報酬「百分比」(13.84 = +13.84%),一天一點
    let oos = null;
    const od = raw.oos && typeof raw.oos === "object" ? raw.oos : null;
    if (od && Array.isArray(od.dates) && Array.isArray(od.cum)) {
      const n = od.dates.length;
      if (n >= 2 && n <= WF_MAX_POINTS && od.cum.length === n) {
        let ok = true;
        for (let i = 0; i < n; i++) if (!wfStr(od.dates[i]) || wfNum(od.cum[i]) === null) { ok = false; break; }
        if (ok) oos = { dates: od.dates.slice(), cum: od.cum.slice() };
      }
    }

    // 被排除的輪以檔案為準;缺了才用 train_sharpe ≤ 0 自推
    let excluded = null;
    if (Array.isArray(raw.excluded_runs) && raw.excluded_runs.length <= WF_MAX_RUNS) excluded = raw.excluded_runs.filter((k) => wfPosInt(k, WF_MAX_RUNS) !== null);
    if (!excluded && runs) excluded = runs.filter((r) => r.trS !== null && r.trS <= 0).map((r) => r.k);

    const current = wfPairVals(raw.current);
    // 過時 = 程式碼裡的兩個常數任一 ≠ wf.current(重用參數掃描那套讀法);讀不到常數 / 檔案沒有 current → 一律判為否
    let stale = false, codeCur = null;
    // 單參數策略:第二軸只有一格、名字 "_"(references/lib.md › Single-constant)。過時判定只看第一個常數,第二軸整個不畫
    const single = !!(cols && cols.length === 1 && colParam === "_");
    if (rowParam && colParam) {
      const rv = R.constFromCode(code, rowParam), cv = single ? 0 : R.constFromCode(code, colParam);
      if (rv !== null && cv !== null) {
        codeCur = [rv, cv];
        if (current) stale = !wfSame(rv, current[0]) || (!single && !wfSame(cv, current[1]));
      }
    }

    const nRuns = wfPosInt(raw.n_runs, WF_MAX_RUNS) || (runs ? runs.length : null);
    const tail = Number.isInteger(raw.tail_days) && raw.tail_days >= 0 && raw.tail_days <= WF_MAX_DAYS ? raw.tail_days : null;
    return {
      lookback, step, nRuns, tail, stale, rowParam, colParam, single, rows, cols,
      rd: rows ? R.decimals(rows) : 0, cd: cols ? R.decimals(cols) : 0,
      current: codeCur || current,   // 落點圖的虛線框:碼裡的常數優先
      oos, oosStats: wfStats(raw.oos_stats), isStats: wfStats(raw.is_stats), excluded: excluded || [], wfe: wfNum(raw.wfe), runs,
    };
  }

  // 落點順序:過時 → 分母護欄 → WFE 四段。分母護欄這邊獨立成立——機器端算不出來寫 null,兩邊同時把關
  function wfBand(w) {
    const isS = w.isStats["Sharpe Ratio"];
    // is_stats 缺(agent 手寫 wf.json 漏了)時 isS 是 undefined:不能讓它繞過分母護欄(0.1.11 code 稽核 P2-7)
    if (isS == null || !(isS >= WF_MIN_DENOM)) return "none";
    if (w.wfe === null) return "none";
    return w.wfe < 0.2 ? "far" : w.wfe < 0.5 ? "low" : w.wfe < 0.7 ? "edge" : "high";
  }
  // 預填三層,每月重最佳化:資料夠切 3 輪就用最長的訓練窗——三年(1095/30)、一年(365/30);都不夠才退回比例公式。機器端 default_windows 同一套
  function wfPreset(totalDays) {
    const total = totalDays || 0;
    if (total >= 1095 + WF_MIN_RUNS * 30) return { step: 30, lookback: 1095 };
    if (total >= 365 + WF_MIN_RUNS * 30) return { step: 30, lookback: 365 };
    const step = Math.max(30, Math.floor(total / 12));
    return { step, lookback: step * 4 };
  }
  function wfRunsOf(total, lookback, step) {
    return total > 0 && step > 0 && lookback > 0 && total > lookback ? Math.floor((total - lookback) / step) : 0;
  }
  function wfTotalDays(bt, w) {
    const d = wfDays(bt && bt.start, bt && bt.end);
    if (d) return d;
    return w && w.runs ? wfDays(w.runs[0].tr0, w.runs[w.runs.length - 1].te1) : null;
  }
  function wfMarkMode(nRuns) { return nRuns <= WF_MARK_LINE_MAX ? "line" : nRuns <= WF_MARK_TICK_MAX ? "tick" : "none"; }
  // 每輪邊界在曲線上的索引:用該輪 test_start 在 dates 裡的位置,不是「輪序 × 步長」——步長是天數,序列不保證每天一點
  function wfRunMarks(w) {
    if (!w.runs || !w.oos) return [];
    const at = {};
    w.oos.dates.forEach((d, i) => { if (at[d] === undefined) at[d] = i; });
    const out = [];
    w.runs.forEach((r, k) => {
      if (k === 0) return;   // 第一輪的起點就是圖的左緣
      const i = at[r.te0];
      if (i !== undefined && i > 0 && i < w.oos.dates.length - 1) out.push(i);
    });
    return out;
  }
  /* 「已送出」的簽章:驗證結果 / 程式碼 / 明確回測(Generated At)三者——不拿整份 stats,live 策略每根 K 重寫績效 */
  function sentSig(data) {
    const st = data.stats && typeof data.stats === "object" ? data.stats : null;
    return JSON.stringify([data.wf, data.code, st ? st["Generated At"] : null]);
  }

  // ---------------------------------------------------------------- DOM 小工具

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  // 樣板裡的 {x} 包進 .mono(數字與漢字不共用字體,雲端 fillTpl 同做法);缺值畫「—」
  function fillTpl(tpl, vars) {
    const frag = document.createDocumentFragment(), str = String(tpl), re = /\{(\w+)\}/g;
    let last = 0, m;
    while ((m = re.exec(str))) {
      if (m.index > last) frag.appendChild(document.createTextNode(str.slice(last, m.index)));
      const v = vars[m[1]];
      frag.appendChild(el("span", "mono", v == null ? DASH : String(v)));
      last = re.lastIndex;
    }
    if (last < str.length) frag.appendChild(document.createTextNode(str.slice(last)));
    return frag;
  }
  const tplText = (tpl, vars) => { const s = el("span"); s.appendChild(fillTpl(tpl, vars)); return s.textContent; };
  function token(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  /* tooltip:一顆 body 層級的 fixed 單例(材質是 app.css 的 .tip,同參數掃描的 .rob-tip)。落點格與列名 / 指標名共用——
   * frame 橫捲、格子 overflow:hidden 都會裁掉行內氣泡。hover 與鍵盤 focus 都開;leave / blur / Esc 收 */
  let tipEl = null, tipAnchor = null;
  function tipBox() {
    if (tipEl) return tipEl;
    tipEl = el("div", "tip wf-tip");
    tipEl.id = "wf-tip";
    tipEl.setAttribute("role", "tooltip");
    tipEl.setAttribute("aria-hidden", "true");
    document.body.appendChild(tipEl);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideTip(); });
    const gone = () => { if (tipAnchor && !tipAnchor.getClientRects().length) hideTip(); };
    document.addEventListener("pointermove", gone);
    document.addEventListener("keyup", gone);
    if (window.blave && window.blave.onWindowActive) window.blave.onWindowActive((on) => { if (!on) hideTip(); });
    return tipEl;
  }
  function showTip(anchor, text) {
    const tip = tipBox();
    tipAnchor = anchor;
    tip.textContent = text;
    const r = anchor.getBoundingClientRect();
    tip.style.left = Math.max(0, Math.min(r.left, window.innerWidth - 272)) + "px";
    tip.style.top = r.bottom + 6 + "px";
    tip.classList.add("is-on");
    tip.setAttribute("aria-hidden", "false");
  }
  function hideTip() {
    if (!tipEl) return;
    tipAnchor = null;
    tipEl.classList.remove("is-on");
    tipEl.setAttribute("aria-hidden", "true");
    document.querySelectorAll(".wf-grid td.is-hover").forEach((td) => td.classList.remove("is-hover"));
  }
  // 有說明的標籤:觸發點 = app.css 的 .mp-tip(點線底線),泡泡走上面的單例
  function tipLabel(text, tip) {
    const btn = el("button", "mp-tip", text);
    btn.type = "button";
    btn.setAttribute("aria-describedby", "wf-tip");
    const open = () => showTip(btn, tip);
    btn.addEventListener("mouseenter", open);
    btn.addEventListener("focus", open);
    btn.addEventListener("mouseleave", hideTip);
    btn.addEventListener("blur", hideTip);
    return btn;
  }
  function busyLabel(btn, text) {   // 等待環在鈕裡、文字前(同雲端 cnBusyLabel)
    btn.textContent = "";
    const sp = el("span", "spin16");
    sp.setAttribute("aria-hidden", "true");
    btn.append(sp, document.createTextNode(text));
  }

  // ---------------------------------------------------------------- 1. 結論卡

  // 頂上那一格只放警示(過時 / 滿上限退回)+ 兩列比較表 + 樣本外效率那一列(數值與門檻判斷同一列)。通過判斷只看樣本外效率
  function buildCard(w, t, timedOut) {
    const card = el("div", "wf-card");
    const band = wfBand(w);
    // 過時態不下門檻判斷,這句是唯一的過時訊號
    if (w.stale) card.appendChild(el("p", "wf-verdict", t("wf.verdictStale")));
    // 滿 5 分鐘退回舊結果:同一個槽、同一套樣式;兩個同時成立時 stale 優先(舊結果不只是舊,還對不上現在的碼)。新結果到了 / 下一次送出就不再成立(設計精簡稽核 A2)
    else if (timedOut) card.appendChild(el("p", "wf-verdict", t("wf.waitTimeout")));

    // 樣本外 = 測試窗拼接整段;樣本內 = 各有效輪的訓練窗平均。報酬欄一律年化;全中性不上漲跌色
    const cmp = el("div", "wf-cmp"), tbl = el("table", "wf-cmp-tbl"), thead = el("thead"), hr = el("tr");
    hr.appendChild(el("th"));
    [t("wf.colSharpe"), t("wf.colAnn"), t("wf.colDd")].forEach((h) => hr.appendChild(el("th", null, h)));
    thead.appendChild(hr);
    tbl.appendChild(thead);
    const tbody = el("tbody");
    function row(series, name, tipText, st) {
      const tr = el("tr"), who = el("span", "who");
      // 色塊只有樣本外那列有(它是圖上那條線);樣本內給一個同寬的透明位,兩個列名才對齊
      const g = el("span", "wf-glyph " + (series || "is-none"));
      g.setAttribute("aria-hidden", "true");
      who.append(g, tipLabel(name, tipText));
      const td0 = el("td");
      td0.appendChild(who);
      tr.appendChild(td0);
      [rob().f2(st["Sharpe Ratio"]), fmtPct(st["Ann. Return [%]"]), fmtPct(st["Max Drawdown [%]"])].forEach((x) => {
        const bad = x === null || x === DASH;
        tr.appendChild(el("td", "num mono" + (bad ? " na" : ""), bad ? DASH : x));
      });
      return tr;
    }
    tbody.appendChild(row("s1", t("wf.rowOos"), t("wf.tipOos"), w.oosStats));
    tbody.appendChild(row(null, t("wf.rowIs"), t("wf.tipIs"), w.isStats));
    tbl.appendChild(tbody);
    cmp.appendChild(tbl);
    card.appendChild(cmp);

    // 通過條件只有樣本外效率一列(沿用回測分頁的指標列元件):「0.99 · 高於門檻」,過時態只留數值(設計精簡稽核 B2)
    const facts = el("div", "wf-facts"), r = el("div", "bt-mrow"), mk = el("div", "bt-mk"), mv = el("div", "bt-mv");
    const showWfe = band !== "none" && w.wfe !== null;
    mk.appendChild(tipLabel(t("wf.factWfe"), t("wf.tipWfe")));
    // none 態(非過時)值槽只放判斷字:「—」跟「無法判斷」講的是同一件事(設計稽核 0.1.11 D4);過時態只留數值,none 時就是「—」
    const judge = !w.stale, num = showWfe || !judge;
    if (num) mv.appendChild(el("span", "mono" + (showWfe ? "" : " na"), showWfe ? w.wfe.toFixed(2) : DASH));
    if (judge) {
      // 只有「遠低於門檻」(< 0.2)上紅:0.5 是慣例不是證明,紅色越常見越分不出嚴重程度
      const BAND = { none: t("wf.tagNone"), far: t("wf.tagFar"), low: t("wf.tagLow"), edge: t("wf.tagEdge"), high: t("wf.tagHigh") }[band];
      if (num) mv.appendChild(document.createTextNode(" · "));
      mv.appendChild(el("span", "wf-band" + (band === "far" ? " is-risk" : ""), BAND));
    }
    r.append(mk, mv);
    facts.appendChild(r);
    card.appendChild(facts);
    return card;
  }

  // ---------------------------------------------------------------- 2. 樣本外累積報酬

  // 拼接的樣本外累積報酬,只有一條線:樣本內是各輪訓練窗各自算完再平均,拼起來等於同一段行情算十幾次
  function buildChart(w, t) {
    if (!w.oos) return null;
    const wrap = el("div", "wf-block");
    wrap.appendChild(el("div", "bt-label", t("wf.chartLabel")));
    const frame = el("div", "bt-frame"), cv = el("canvas", "wf-canvas");
    cv.setAttribute("role", "img");
    const cum = w.oos.cum;
    cv.setAttribute("aria-label", tplText(t("wf.chartAria"), { r: fmtPct(cum[cum.length - 1]) || DASH, a: w.oos.dates[0], b: w.oos.dates[w.oos.dates.length - 1], d: w.step }));
    frame.appendChild(cv);
    wrap.appendChild(frame);

    const lg = el("div", "wf-legend");
    const item = (sw, node) => { const it = el("span", "it"); if (sw) it.appendChild(sw); it.appendChild(node); return it; };
    const g = el("span", "wf-glyph s1");
    g.setAttribute("aria-hidden", "true");
    lg.appendChild(item(g, document.createTextNode(t("wf.legOos"))));
    // 重選線的 legend 跟著三段走:整條虛線 / 短刻度 / 畫不下就用文字說
    const mode = wfMarkMode(w.runs ? w.runs.length : 0);
    if (mode === "none") lg.appendChild(item(null, fillTpl(t("wf.legReoptText"), { d: w.step })));
    else {
      const dl = el("span", mode === "line" ? "dashline" : "tickmark");
      dl.setAttribute("aria-hidden", "true");
      lg.appendChild(item(dl, document.createTextNode(mode === "line" ? t("wf.legReopt") : t("wf.legReoptTick"))));
    }
    if (w.tail) lg.appendChild(item(null, fillTpl(t("wf.tailNote"), { d: w.tail })));
    wrap.appendChild(lg);
    return { node: wrap, canvas: cv };
  }

  // Y 軸:步長只取 1 / 2 / 5 × 10^n,域內刻度落在 4–6 條。先找域內 ≤ 6 條的最小步長;不到 4 條時把域往刻度上撐
  // (離 0 遠的那側先撐),回傳撐過的 lo / hi——曲線與刻度都用這組 lo / hi 換算,比例尺只有一個。
  // 刻度值 = 整數 k × 步長:0 才是真的 0(虛線那條),小步長也不會冒出 0.30000000000000004
  function wfTicks(lo, hi) {
    const none = { lo, hi, step: 0, dp: 0, ticks: [] };
    if (!isFinite(lo) || !isFinite(hi) || !isFinite(hi - lo) || !(hi > lo)) return none;
    const span = hi - lo, eps = 1e-9;
    const first = (s) => Math.ceil(lo / s - eps), last = (s) => Math.floor(hi / s + eps);
    let p = Math.floor(Math.log10(span / 10)), step = 0, dp = 0;
    for (let guard = 0; guard < 12 && !step; p++) {
      for (const m of [1, 2, 5]) {
        const s = m * Math.pow(10, p);
        if (last(s) - first(s) + 1 <= 6) { step = s; dp = Math.max(0, -p); break; }
        guard++;
      }
    }
    if (!step) return none;
    let k0 = first(step), k1 = last(step);
    const grow = (top) => { if (top) { k1 = Math.ceil(hi / step - eps); hi = Math.max(hi, k1 * step); } else { k0 = Math.floor(lo / step + eps); lo = Math.min(lo, k0 * step); } };
    if (k1 - k0 + 1 < 4) grow(Math.abs(hi) >= Math.abs(lo));
    if (k1 - k0 + 1 < 4) grow(Math.abs(hi) < Math.abs(lo));
    const ticks = [];
    for (let k = k0; k <= k1 && ticks.length < WF_GRID_MAX_LINES; k++) ticks.push(k === 0 ? 0 : k * step);
    return { lo, hi, step, dp, ticks };
  }
  // 千分位同交易分頁 trFmt2(en-US 分組,各語系小數點一律 .);小數位上限 20 是 toLocaleString 的舊上限,髒資料的極窄區間才會碰到
  function wfTickLabel(v, dp) {
    const d = Math.min(dp, 20);
    return (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) + "%";
  }

  // 單序列、線性 % 軸(對數軸在累積報酬 ≤ −100% 時沒有定義)。分頁藏著時量到 0,等 ResizeObserver 再叫
  function drawChart(canvas, w) {
    const W = canvas.clientWidth, H = canvas.clientHeight;
    if (!W || !H || !w.oos) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.font = "10px " + token("--font-mono");   // canvas 不吃 CSS 變數,字族從 tokens.css 讀
    const cLine = token("--color-data-1"), cGrid = token("--border-hairline"), cText = token("--ink-3"), cMark = token("--color-greyDark");

    const cum = w.oos.cum, n = cum.length;
    let lo = Math.min.apply(null, cum), hi = Math.max.apply(null, cum);
    lo = Math.min(lo, 0);   // 0% 那條永遠留在畫面裡
    hi = Math.max(hi, 0);
    const padv = (hi - lo) * 0.08 || 1;
    const ax = wfTicks(lo - padv, hi + padv);
    lo = ax.lo; hi = ax.hi;
    const labels = ax.ticks.map((v) => wfTickLabel(v, ax.dp));
    // 左邊界跟著最寬的刻度字走:+10000% 這種字塞不進固定 40px;上限三分之一寬,髒資料也留得出繪圖區
    const labelW = labels.reduce((m, s) => Math.max(m, ctx.measureText(s).width), 0);
    const padL = Math.min(Math.max(40, Math.ceil(labelW) + 10), Math.floor(W / 3)), padR = 10, padT = 12, padB = 22;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const xAt = (i) => padL + (plotW * i) / (n - 1);
    const yAt = (v) => padT + plotH * (1 - (v - lo) / (hi - lo));

    ctx.textBaseline = "middle";
    ctx.lineWidth = 1;
    ax.ticks.forEach((v, i) => {
      const y = yAt(v);
      ctx.strokeStyle = cGrid;
      ctx.setLineDash(v === 0 ? [3, 3] : []);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = cText;
      ctx.textAlign = "right";
      ctx.fillText(labels[i], padL - 6, y);
    });

    // 重新選參數的時點:≤12 輪每輪邊界一條虛線、13–60 輪 X 軸上 4px 短刻度、>60 輪不畫(legend 用文字說)
    const mode = wfMarkMode(w.runs ? w.runs.length : 0);
    if (mode !== "none") {
      const y0 = mode === "line" ? padT : padT + plotH - 4;
      ctx.strokeStyle = cMark;
      ctx.setLineDash(mode === "line" ? [2, 4] : []);
      wfRunMarks(w).forEach((i) => { const x = xAt(i); ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, padT + plotH); ctx.stroke(); });
      ctx.setLineDash([]);
    }

    ctx.strokeStyle = cLine;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    for (let i = 0; i < n; i++) { const x = xAt(i), y = yAt(cum[i]); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    ctx.stroke();

    // 共用時間軸:頭 / 中 / 尾(同雲端 btDateTicks)
    const idx = [0, Math.floor((n - 1) / 2), n - 1], aligns = ["left", "center", "right"];
    ctx.fillStyle = cText;
    ctx.textBaseline = "alphabetic";
    idx.forEach((i, k) => {
      const d = w.oos.dates[i];
      ctx.textAlign = aligns[k];
      const x = k === 0 ? padL : k === 2 ? W - padR : padL + (plotW * i) / (n - 1);
      ctx.fillText(d, x, H - 6);
    });
  }

  // ---------------------------------------------------------------- 3. 每輪選中參數落點圖

  // 沿用參數掃描那張網格,格內寫「這格被選中幾輪」;輪序放 tooltip 與 aria-label,績效在下面的每輪明細
  function buildDrift(w, t) {
    if (!w.rows || !w.cols || !w.rowParam || !w.colParam || !w.runs) return null;
    const R = rob(), pv = R.pv, sep = t("wf.listSep");
    const wrap = el("div", "wf-block");
    wrap.appendChild(el("div", "bt-label", t("wf.driftLabel")));
    const frame = el("div", "rob-frame"), tbl = el("table", "wf-grid");
    tbl.setAttribute("aria-label", w.single ? tplText(t("wf.driftAria1"), { rp: w.rowParam }) : tplText(t("wf.driftAria"), { rp: w.rowParam, cp: w.colParam }));
    // 每欄 32px:格內只有一位數,可讀下限比熱圖低。fixed layout 先扣掉 border-spacing 再分欄,欄數 +2 個間隙一起算
    tbl.style.minWidth = 84 + w.cols.length * 32 + (w.cols.length + 2) * 4 + "px";
    const thead = el("thead"), hr = el("tr"), corner = el("th", "corner");
    corner.scope = "col";
    corner.appendChild(el("span", "r mono", w.rowParam + " ↓"));
    if (!w.single) corner.appendChild(el("span", "mono", w.colParam + " →"));
    hr.appendChild(corner);
    w.cols.forEach((c) => { const th = el("th", null, w.single ? "" : pv(c, w.cd)); th.scope = "col"; hr.appendChild(th); });
    thead.appendChild(hr);
    tbl.appendChild(thead);

    const curI = w.current ? R.locate(w.rows, w.current[0]) : -1, curJ = w.current ? R.locate(w.cols, w.current[1]) : -1;
    // 每輪先定位一次(格數 × 輪數 × 軸長的三重掃描會在 40×40 網格上爆掉);落在網格外的輪不進圖,但每輪明細照列
    const hitsAt = {};
    w.runs.forEach((f) => {
      if (!f.params) return;
      const i = R.locate(w.rows, f.params[0]), j = R.locate(w.cols, f.params[1]);
      if (i < 0 || j < 0) return;
      (hitsAt[i + ":" + j] = hitsAt[i + ":" + j] || []).push(f.k);
    });
    const tbody = el("tbody");
    w.rows.forEach((r, i) => {
      const tr = el("tr"), th = el("th", null, pv(r, w.rd));
      th.scope = "row";
      tr.appendChild(th);
      w.cols.forEach((c, j) => {
        const hits = hitsAt[i + ":" + j] || [], isCur = curI === i && curJ === j, td = el("td");
        if (hits.length) { td.classList.add("is-hit"); td.textContent = String(hits.length); }
        if (isCur) td.classList.add("is-current");
        let lbl = w.rowParam + " " + pv(r, w.rd) + (w.single ? "" : " · " + w.colParam + " " + pv(c, w.cd)) + ": ";
        lbl += hits.length ? tplText(t("wf.driftTipHits"), { k: hits.join(sep) }) : t("wf.driftTipNone");
        if (isCur) lbl += t("wf.driftTipCur");
        td.setAttribute("aria-label", lbl);
        td.dataset.tip = lbl;
        if (hits.length || isCur) td.tabIndex = 0;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    frame.appendChild(tbl);
    wrap.appendChild(frame);

    // 事實行:漂移幅度用數字講一次(不進判斷句)
    const picked = w.runs.filter((f) => !!f.params);
    if (picked.length) {
      const uniq = {}, r0 = [], c0 = [];
      picked.forEach((f) => { uniq[f.params[0] + "/" + f.params[1]] = 1; r0.push(f.params[0]); c0.push(f.params[1]); });
      const facts = el("div", "bt-meta wf-drift-facts"), g0 = el("span", "mgrp");
      const txt = el("span");   // 一整句進一個行內節點:.mgrp 是 inline-flex,直接放文字節點會在數字兩邊各多一個 gap
      txt.appendChild(fillTpl(t("wf.driftFacts"), { n: picked.length, u: Object.keys(uniq).length }));
      g0.appendChild(txt);
      facts.appendChild(g0);
      // 組間的「·」由 CSS 畫(report-backtest.css .bt-meta > .mgrp + .mgrp),不插獨立分隔節點
      const seg = (name, vals, d) => {
        const g = el("span", "mgrp");
        g.append(el("span", "", name), el("span", "mono", pv(Math.min.apply(null, vals), d) + " – " + pv(Math.max.apply(null, vals), d)));
        facts.appendChild(g);
      };
      seg(w.rowParam, r0, w.rd);
      if (!w.single) seg(w.colParam, c0, w.cd);
      wrap.appendChild(facts);
    }

    const lg = el("div", "wf-legend"), item = (node) => { const it = el("span", "it"); it.appendChild(node); return it; };
    lg.appendChild(item(document.createTextNode(t("wf.driftLegCount"))));
    if (curI >= 0 && curJ >= 0) lg.appendChild(item(fillTpl(t("wf.driftLegCur"), { p: pv(w.rows[curI], w.rd) + (w.single ? "" : " / " + pv(w.cols[curJ], w.cd)) })));
    // 第二道防線:使用者在這裡才真的看到一組具體數字,手最癢
    lg.appendChild(item(document.createTextNode(t("wf.driftLegRef"))));
    wrap.appendChild(lg);

    // tooltip:hover 與鍵盤 focus 都開;內容鏡射在 aria-label。事件委派在 tbody
    const show = (td) => { if (!td.dataset.tip) return; showTip(td, td.dataset.tip); td.classList.add("is-hover"); };
    const cellOf = (e) => { const td = e.target && e.target.closest ? e.target.closest("td") : null; return td && tbody.contains(td) && td.tabIndex === 0 ? td : null; };
    tbody.addEventListener("mouseover", (e) => { const td = cellOf(e); if (td && !td.classList.contains("is-hover")) show(td); });
    tbody.addEventListener("mouseout", (e) => { const td = cellOf(e); if (td && !(e.relatedTarget && td.contains(e.relatedTarget))) hideTip(); });
    tbody.addEventListener("focusin", (e) => { const td = cellOf(e); if (td) show(td); });
    tbody.addEventListener("focusout", hideTip);
    return wrap;
  }

  // ---------------------------------------------------------------- 4. 每輪明細

  // 7 欄;被排除的輪降色 + 表下註記(色不是唯一載體)。全部輪數一次畫進 DOM,收在固定高度的捲動框、表頭 sticky
  function buildRuns(w, t) {
    if (!w.runs) return null;
    const R = rob();
    const wrap = el("div", "wf-block");
    wrap.appendChild(el("div", "bt-label", t("wf.runsLabel")));
    const scroll = el("div", "wf-scroll");
    scroll.tabIndex = 0;   // 捲動框要鍵盤捲得動
    scroll.setAttribute("role", "region");
    scroll.setAttribute("aria-label", t("wf.runsLabel"));
    const tbl = el("table", "pf-tbl wf-run-tbl"), thead = el("thead"), hr = el("tr");
    [[t("wf.colRun"), "n"], [t("wf.colTrain"), "win"], [t("wf.colTest"), "win"], [t("wf.colPick"), null], [t("wf.colTrs"), "n"], [t("wf.colTes"), "n"], [t("wf.colTer"), "n"]].forEach((c) => {
      const th = el("th", c[1], c[0]);
      th.scope = "col";
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    tbl.appendChild(thead);
    const voided = {};
    w.excluded.forEach((k) => { voided[k] = 1; });
    const tbody = el("tbody");
    w.runs.forEach((r) => {
      const tr = el("tr");
      tr.appendChild(el("td", "n", String(r.k)));
      // 日期兩行(起日一行、「→ 迄日」一行):中欄在預設視窗只有 544,單行會把最右兩欄(測試 Sharpe / 測試窗報酬)裁掉(設計稽核 S1)
      [[r.tr0, r.tr1], [r.te0, r.te1]].forEach(([a, b]) => { const td = el("td", "win"); td.append(el("span", "d", a), el("span", "d", "→ " + b)); tr.appendChild(td); });
      const tdp = el("td", "pick");
      tdp.appendChild(el("span", "mono", r.params ? R.pv(r.params[0], w.rd) + (w.single ? "" : " / " + R.pv(r.params[1], w.cd)) : DASH));
      tr.appendChild(tdp);
      tr.appendChild(el("td", "n" + (voided[r.k] ? " void" : ""), R.f2(r.trS)));
      tr.appendChild(el("td", "n", R.f2(r.teS)));
      // 反紅綠燈:負報酬上紅,正報酬中性——這頁在找失敗,不慶祝成功
      const ret = fmtPct(r.ret);
      tr.appendChild(el("td", "n" + (r.ret !== null && r.ret < 0 ? " neg" : ""), ret === null ? DASH : ret));
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    scroll.appendChild(tbl);
    wrap.appendChild(scroll);
    if (w.excluded.length) wrap.appendChild(el("p", "wf-run-note", tplText(t("wf.voidNote"), { k: w.excluded.join(t("wf.listSep")) })));
    return wrap;
  }

  // ---------------------------------------------------------------- 5. 旋鈕 / 空狀態 / 重跑列

  // 迷你時間軸:第 1、2、3 輪、⋮、第 N 輪(≤4 輪就全列)。幾何都在 CSS(.wf-tl),這裡只給 --tl-p 與每列的 --k
  function drawTimeline(box, lookback, step, n, t) {
    box.textContent = "";
    box.hidden = !(n >= 1 && lookback > 0 && step > 0);
    if (box.hidden) return;
    box.style.setProperty("--tl-p", ((60 * step) / (lookback + step)).toFixed(3) + "%");
    const rows = n > 4 ? [1, 2, 3, 0, n] : Array.from({ length: n }, (_, i) => i + 1);
    rows.forEach((k) => {
      const r = el("div", "wf-tl-row");
      r.appendChild(el("span", "wf-tl-no", k ? String(k) : "⋮"));
      if (k) {
        const tr = el("span", "wf-tl-track" + (n > 4 && k === n ? " is-last" : ""));
        tr.style.setProperty("--k", String(k - 1));
        tr.append(el("span", "wf-tl-tr"), el("span", "wf-tl-te"));
        r.appendChild(tr);
      }
      box.appendChild(r);
    });
    box.setAttribute("aria-label", tplText(t("wf.tlAria"), { l: lookback, s: step, n }));
  }

  const sent = new Map();          // scope:name → { sig, turn, lookback, step }(送出當下的簽章、那一回合、窗長)
  const shown = new WeakMap();     // container → 這一次畫的那一份(wfSync 用)
  const sentKey = (opts, name) => (opts.scope || "") + ":" + name;
  // 維持「已送出」:回合還在跑、而且就是送出的那一回合、而且驗證結果 / 程式碼 / 明確回測沒變
  // pending = 確認框按下、submitMessage 還沒回來(第一次暖機約一分鐘):那段 running 已是 true,不認它的話會顯示「agent 正在回覆上一則訊息」(稽核 P2-1)
  /* 雲端:回合結束時 wf.json 常常還在 reporter → api 的路上(比回合晚到)。這時退回舊結果,用戶會把上一次的數字當成這次的(稽核 P2-4,
   * Wei 選 B):「已送出」一直留著,直到 ① wf 簽章變了(新結果到了,sig 對不上,原地換成新結果)② 那一回合失敗 / 被停止
   * ③ 回合結束後滿 WF_CLOUD_HOLD_MS。本機的 wf.json 在回合結束前就落地,不留。
   * 回合結束由呼叫端當下告訴這裡(wfTurnEnded):endAt / done 記在「那一支送出的那一回合」的紀錄上,不等面板畫到(複驗 P2-R3)。
   * 留著的期間每 WF_CLOUD_REFETCH_MS 叫一次 opts.refetch(送出那一支的名字)(背景重抓雲端那一份,抓到不同才換) */
  const WF_CLOUD_HOLD_MS = 5 * 60 * 1000, WF_CLOUD_REFETCH_MS = 30 * 1000;
  const nowOf = (opts) => (typeof opts.now === "function" ? opts.now() : Date.now());
  // 純函式(tests/check_shell_wf.js 直接跑):這一份現在是不是「已送出」。會在 s 上記 done(到上限時)
  // done = 已經因為失敗或上限退回過:之後時間怎麼算,都不再變回已送出
  function sentNow(s, sig, opts, now) {
    if (!s || s.done || s.sig !== sig) return false;
    if (s.pending) return !!opts.busy;
    if (opts.busy && s.turn === opts.turn) return true;   // 送出的那一回合還在跑
    if (opts.scope !== "cloud") return false;              // 本機:回合結束就回來(wf.json 已經落地)
    if (s.endAt == null) s.endAt = now;                    // 兜底:呼叫端沒報回合結束(wfTurnEnded)時,第一次看到它結束就算
    if (now - s.endAt < WF_CLOUD_HOLD_MS) return true;
    s.done = true;
    s.timedOut = true;   // 滿上限才退回(不是失敗):結論槽要講一句「這次的沒傳回來」(設計精簡稽核 A2)
    return false;
  }
  // 還在「等雲端結果」的那一段:剩幾毫秒到上限;不在那一段 → null
  function holdLeft(s, opts, now) {
    if (!s || s.done || s.pending || s.endAt == null || opts.scope !== "cloud" || (opts.busy && s.turn === opts.turn)) return null;
    const left = WF_CLOUD_HOLD_MS - (now - s.endAt);
    return left > 0 ? left : null;
  }
  function isSent(data, opts) {
    return sentNow(sent.get(sentKey(opts, data.name)), sentSig(data), opts, nowOf(opts));
  }
  /* 雲端這一支是不是還在等結果:結果傳回中(回合已結束),或滿上限退回(timedOut)。切回分頁、視窗回前景時據此補抓一次(設計精簡稽核 B10)。
     只讀不寫(不走 sentNow,它會記 endAt / done);失敗退回的不算(那條 wfTurnEnded 已排過補抓);sig 對不上 = 新結果已經到了 */
  function wfAwaiting(data, opts) {
    if (!data || !data.name || opts.scope !== "cloud") return false;
    const s = sent.get(sentKey(opts, data.name));
    // 送出的那一回合還在跑:不抓。wf.json 在回合結束才寫,這時抓不到新結果;agent 若在回合裡先重跑回測,抓回來的明確回測會讓簽章對不上、
    // 「已送出」提早退掉而把舊結果當這次的(0.1.11 code 稽核 P2-1)。回合結束有 wfTurnEnded / rpCloudSelect 那一次抓
    if (!s || s.pending || (opts.busy && s.turn === opts.turn)) return false;
    return s.sig === sentSig(data) && (!s.done || !!s.timedOut);
  }
  // 等雲端結果那一段的兩個計時:到上限叫 resync(畫回舊結果)、期間定時 refetch。換了一筆紀錄 / 不在那一段就收掉
  const holds = new WeakMap();
  function holdClear(container) { const h = holds.get(container); if (h) { clearTimeout(h.t); clearInterval(h.i); holds.delete(container); } }
  function holdArm(container, st, opts) {
    const s = st.sent ? sent.get(sentKey(opts, st.data.name)) : null, left = holdLeft(s, opts, nowOf(opts));
    if (left == null) { holdClear(container); return; }
    const h = holds.get(container);
    if (h && h.s === s) return;
    holdClear(container);
    const t = setTimeout(() => { holdClear(container); if (typeof opts.resync === "function") opts.resync(); }, left + 50);
    // refetch 綁送出那一支的名字(不是當下看的那支);回 false = 人已經不在那一支(切走 / 換視角 / 關掉報告)→ 計時當場收掉,回來重畫時照剩下的時間再掛
    const i = typeof opts.refetch === "function" ? setInterval(() => { if (opts.refetch(s.name) === false) holdClear(container); }, WF_CLOUD_REFETCH_MS) : null;
    holds.set(container, { s, t, i });
  }
  /* 回合結束(呼叫端在 onTurnEnd 當下叫):送出的那一回合 = turn 的紀錄記下 endAt;失敗 / 被停止 → done(當場退回舊結果)。
   * 失敗的判準有啟發式(沒收到回覆、用量上限…),雲端的 wf.json 可能其實寫好了:雲端那筆退回之後再補抓一次(o.refetch) */
  function wfTurnEnded(turn, failed, o) {
    o = o || {};
    const now = typeof o.now === "function" ? o.now() : Date.now();
    sent.forEach((s, key) => {
      if (s.pending || s.done || s.turn !== turn) return;
      if (s.endAt == null) s.endAt = now;
      if (!failed) return;
      s.done = true;
      if (key.indexOf("cloud:") === 0 && typeof o.refetch === "function") setTimeout(() => o.refetch(s.name), WF_CLOUD_REFETCH_MS);
    });
  }

  /* 旋鈕組(空狀態與頂端重跑列共用):預填 / 即時估算 / 輪數 < 3 或 > 1000 擋下 / 已送出兩個 input 一起 disabled。
   * 重跑列(rerun):box 就是 .wf-bar,不帶時間軸;空狀態:box 是 display:contents 的 .wf-kbox,旋鈕與估算之間夾迷你時間軸。
   * 回合進行中(別的回合)鈕停用 + 一行說明(同參數掃描空狀態);就地換,不重建——打到一半的窗長不會被洗掉 */
  function buildKnobs(container, data, stats, w, opts, rerun) {
    const t = opts.t, total = wfTotalDays(stats, w), snt = isSent(data, opts), rec = sent.get(sentKey(opts, data.name));
    const init = snt ? rec : w ? { lookback: w.lookback, step: w.step } : wfPreset(total);
    const box = el("div", rerun ? "wf-bar" : "wf-kbox"), knobs = el("div", "wf-knobs");
    // label 前的色塊當圖例:灰 = 訓練窗、橘 = 測試窗(同時間軸與樣本外曲線)
    function knob(label, glyph, val) {
      const k = el("label", "wf-knob"), pre = el("span", "pre"), g = el("span", "wf-glyph " + glyph);
      g.setAttribute("aria-hidden", "true");
      pre.append(g, document.createTextNode(label));
      const inp = el("input");
      inp.type = "number"; inp.min = "1"; inp.step = "15"; inp.value = String(val); inp.disabled = snt;
      k.append(pre, inp, el("span", "unit", t("wf.unitDay")));
      knobs.appendChild(k);
      return inp;
    }
    const iLb = knob(t("wf.knobLookback"), "s0", init.lookback), iSt = knob(t("wf.knobStep"), "s1", init.step);
    box.appendChild(knobs);
    const tl = rerun ? null : el("div", "wf-tl");
    if (tl) { tl.setAttribute("role", "img"); box.appendChild(tl); }
    const est = el("p", "wf-est");
    box.appendChild(est);
    const behind = opts.gate === false;
    const btn = el("button", "btn-fill wf-go", rerun ? t("wf.btnRerun") : t("wf.btnRun"));
    btn.type = "button";
    let busyCap = null, busyNow = false, inited = false;
    if (behind) {
      // 只剩重跑區會走到這裡(空狀態的落後態不建旋鈕):一行說明 + 鈕換成去更新
      box.appendChild(el("p", "wf-est is-bad", t("wf.behind")));
      btn.textContent = t("minv.btn");
    } else if (snt) {
      btn.disabled = true;
      busyLabel(btn, t("wf.btnSent"));
    }
    /* 回合已經結束、還在等雲端結果那一段(holdLeft 不是 null):鈕上的字換成「結果傳回中」(對話已經講完了,「看對話」是錯的);
       轉圈與停用照舊。鈕的字變了讀屏不一定唸,另放一個看不見的 role=status 唸同一句(設計精簡稽核 A1) */
    const waitSr = el("span", "sr-only");
    waitSr.setAttribute("role", "status");
    box.appendChild(waitSr);
    let waitNow = false;
    function setWait(w) {
      if (!snt || behind || w === waitNow) return;
      waitNow = w;
      busyLabel(btn, t(w ? "wf.btnWait" : "wf.btnSent"));
      waitSr.textContent = w ? t("wf.btnWait") : "";
    }
    setWait(holdLeft(rec, opts, nowOf(opts)) !== null);
    const read = () => ({ lookback: parseInt(iLb.value, 10) || 0, step: parseInt(iSt.value, 10) || 0 });
    // 拿著焦點的鈕要停用(別的回合開了、送不出去):先把焦點交給分頁鈕,不讓它掉到 <body>(設計複稽核 R2)
    const setDis = (v) => { if (v && !btn.disabled && document.activeElement === btn && typeof opts.refocus === "function") opts.refocus(); btn.disabled = v; };
    function recalc() {
      const locked = behind ? false : snt || busyNow;   // 輪數估算不得解鎖這兩態的鈕
      const v = read();
      // 回測的起訖日讀不出來就估不了輪數:估算行留白、鈕照樣可按(擋下的判準是「算得出來而且不夠」)
      if (!total) {
        est.className = "wf-est"; est.textContent = "";
        if (tl) drawTimeline(tl, 0, 0, 0, t);
        if (!behind) setDis(locked || !(v.lookback >= 1 && v.step >= 1));
        return;
      }
      const n = wfRunsOf(total, v.lookback, v.step);
      if (tl) drawTimeline(tl, v.lookback, v.step, n, t);
      est.textContent = "";
      if (n < WF_MIN_RUNS || n > WF_MAX_RUNS) {   // 兩頭都擋:< 3 輪看不出東西,> 1000 輪機器端會拒(白跑一回合)
        est.className = "wf-est is-bad";
        est.appendChild(n < WF_MIN_RUNS ? fillTpl(t("wf.estBad"), { n }) : fillTpl(t("wf.estOver"), { n, max: WF_MAX_RUNS }));
        if (!behind) setDis(true);
        return;
      }
      est.className = "wf-est";
      est.appendChild(fillTpl(t("wf.estRuns"), { n }));
      if (!behind) setDis(locked);
    }
    function setBusy(busy) {
      const next = !!busy && !snt && !behind;
      if (inited && next === busyNow) return;   // 雲端輪詢每 15 秒叫一次:狀態沒變就不重算(時間軸五列不必重建)
      inited = true;
      busyNow = next;
      if (busyNow && !busyCap) { busyCap = el("p", "wf-cap", t("rob.busy")); box.appendChild(busyCap); }
      else if (!busyNow && busyCap) { busyCap.remove(); busyCap = null; }
      recalc();
    }
    // 鈕放在組裡最後、忙碌說明再接在鈕後面(兩種模式同一個順序;空狀態的 box 是 display:contents,鈕照樣是 .wf-empty 的直向項目)
    box.appendChild(btn);
    iLb.addEventListener("input", recalc);
    iSt.addEventListener("input", recalc);
    btn.addEventListener("click", () => {
      if (behind) { if (typeof opts.onUpdate === "function") opts.onUpdate(btn); return; }
      const v = read();   // 送出時再驗一次
      const nn = total ? wfRunsOf(total, v.lookback, v.step) : null;
      if ((nn !== null && (nn < WF_MIN_RUNS || nn > WF_MAX_RUNS)) || v.lookback < 1 || v.step < 1) { recalc(); return; }
      if (typeof opts.onRun !== "function") return;
      const sig = sentSig(data), key = sentKey(opts, data.name);
      // begin:呼叫端在確認框按下、送出之前叫——送出那一刻回合一開(running)就認得是自己送的
      const begin = () => sent.set(key, { sig, turn: null, pending: true, lookback: v.lookback, step: v.step });
      Promise.resolve(opts.onRun(data.name, v.lookback, v.step, rerun, btn, begin)).catch(() => false).then((turn) => {
        if (!turn && turn !== 0) {
          // 沒送出去(別的回合剛好開了等):收掉 pending,照現在的回合狀態重畫(忙碌就是停用 + 那一行說明)
          const cur = sent.get(key);
          if (cur && cur.pending) { sent.delete(key); if (typeof opts.resync === "function") opts.resync(); }
          // 確認框收起時把焦點還給 opener,那時它可能已經被停用(別的回合先開了)→ 焦點落在 body:交給分頁鈕(R2)
          if (document.activeElement === document.body && typeof opts.refocus === "function") opts.refocus();
          return;
        }
        sent.set(key, { sig, turn, name: data.name, lookback: v.lookback, step: v.step });
        // 送出成功 = 那一回合已開:整片重畫成「已送出」(舊結果拿掉、環在鈕裡)
        const st = shown.get(container);
        if (st && st.data === data) renderWf(container, data, { ...opts, busy: true, turn });
      });
    });
    setBusy(opts.busy);
    return { box, btn, setBusy, setWait };
  }

  // 空狀態:落後的機器 = 一句話 + 去更新,旋鈕與估算對它全是死的 UI;能跑的機器 = 兩個旋鈕 + 迷你時間軸 + 共 N 輪 + 開始驗證
  function buildEmpty(container, data, stats, opts) {
    const box = el("div", "wf-empty");
    if (opts.gate === false) {
      box.appendChild(el("p", "lead", opts.t("wf.behind")));
      const go = el("button", "btn-fill wf-go", opts.t("minv.btn"));
      go.type = "button";
      go.addEventListener("click", () => { if (typeof opts.onUpdate === "function") opts.onUpdate(go); });
      box.appendChild(go);
      return { node: box, knobs: null };
    }
    const k = buildKnobs(container, data, stats, null, opts, false);
    box.appendChild(k.box);
    return { node: box, knobs: k };
  }

  // ---------------------------------------------------------------- 入口

  const observers = new WeakMap();
  /* 整片重畫會把焦點所在的節點拿掉(送出後鈕變「已送出」、回合結束舊結果回來):原本焦點在分頁裡的,交給呼叫端放到樣本外驗證那顆分頁鈕,
     不讓它掉到 <body>(設計稽核 S2) */
  function renderWf(container, data, opts) {
    opts = opts || {};
    const had = container.contains(document.activeElement);
    paint(container, data, opts);
    if (had && !container.contains(document.activeElement) && typeof opts.refocus === "function") opts.refocus();
  }
  function paint(container, data, opts) {
    if (typeof opts.t !== "function") opts.t = (k) => k;
    data = data && typeof data === "object" ? data : {};
    hideTip();
    const prev = observers.get(container);
    if (prev) { prev.disconnect(); observers.delete(container); }
    container.textContent = "";
    const stats = data.stats && typeof data.stats === "object" ? data.stats : null;
    const st = { data, sent: isSent(data, opts), gate: opts.gate, knobs: null };
    shown.set(container, st);
    holdArm(container, st, opts);
    if (!stats) return;   // 沒回測:分頁本身是停用的(app.js rpShowTab)
    let w = null;
    try { w = sanitizeWf(data.wf, data.code); } catch (e) { console.warn("[wf]", e); }
    if (!w) {
      const e = buildEmpty(container, data, stats, opts);
      st.knobs = e.knobs;
      container.appendChild(e.node);
      return;
    }
    const root = el("div", "bt wf");
    let meta = null;
    try { meta = typeof opts.buildMeta === "function" ? opts.buildMeta(stats) : null; } catch (e) { console.warn("[wf]", e); }
    if (meta) root.appendChild(meta);
    // meta 只留資料:這次用的窗長與輪數由下一行的旋鈕(預填這次的值)兼任
    const k = buildKnobs(container, data, stats, w, opts, true);
    st.knobs = k;
    root.appendChild(k.box);
    container.appendChild(root);
    // 已送出:舊結果整塊拿掉、下方留空,不淡化(canon 不用 opacity 表示失效);回合結束沒有新結果時 wfSync 重畫、舊結果回來
    if (st.sent) return;
    let chart = null;
    // 每一塊各自 try:wf.json 是 agent 寫的,一塊壞掉不該拖垮整頁
    const se = sent.get(sentKey(opts, data.name)), timedOut = !!(se && se.timedOut && se.sig === sentSig(data));
    [() => buildCard(w, opts.t, timedOut), () => { chart = buildChart(w, opts.t); return chart && chart.node; }, () => buildDrift(w, opts.t), () => buildRuns(w, opts.t)].forEach((fn) => {
      try { const node = fn(); if (node) root.appendChild(node); } catch (e) { console.warn("[wf]", e); }
    });
    if (chart) {
      const redraw = () => { try { drawChart(chart.canvas, w); } catch (e) { console.warn("[wf]", e); } };
      if (typeof ResizeObserver === "function") {
        // 觀察 container:分頁從 hidden 切回來時尺寸從 0 變回來,這一下就是第一次真正畫的時機
        const ro = new ResizeObserver(redraw);
        ro.observe(container);
        observers.set(container, ro);
      }
      redraw();
    }
  }
  // 呼叫端在回合開始 / 結束、雲端版本旗標翻面時叫:已送出態或閘門翻了 → 整片重畫;否則只就地換鈕態
  function wfSync(container, opts) {
    const st = shown.get(container);
    if (!st || !container.isConnected) return;
    opts = opts || {};
    // 閘門只有「是不是 false」會改畫面(落後態 ↔ 旋鈕);null ↔ true 只影響確認框那一句,不重建——打到一半的窗長不被洗掉(設計稽核 L4)
    if (isSent(st.data, opts) !== st.sent || (opts.gate === false) !== (st.gate === false)) { renderWf(container, st.data, opts); return; }
    holdArm(container, st, opts);   // 回合剛結束、雲端結果還沒到:畫面不動(舊結果不閃回來),只把上限與重抓的計時掛上
    if (st.sent && st.knobs && st.knobs.setWait) st.knobs.setWait(holdLeft(sent.get(sentKey(opts, st.data.name)), opts, nowOf(opts)) !== null);   // 鈕上的字就地換成「結果傳回中」(A1)
    if (st.knobs && st.knobs.btn.isConnected) st.knobs.setBusy(opts.busy);
  }

  window.BlaveReport = window.BlaveReport || {};
  window.BlaveReport.renderWf = renderWf;
  window.BlaveReport.wfSync = wfSync;
  window.BlaveReport.wfTurnEnded = wfTurnEnded;
  window.BlaveReport.wfAwaiting = wfAwaiting;
  window.BlaveReport.wfSig = sentSig;
  // 純計算函式掛出來給核對腳本用(tests/check_shell_wf.js);畫面不靠這個
  window.BlaveReport._wf = { sanitizeWf, wfBand, wfPreset, wfRunsOf, wfTotalDays, wfDays, wfMarkMode, wfRunMarks, wfTicks, wfTickLabel, drawChart, sentSig, sentNow, holdLeft, holdArm, holdClear, wfTurnEnded, wfAwaiting,
    WF_MIN_RUNS, WF_MAX_RUNS, WF_CLOUD_HOLD_MS, WF_CLOUD_REFETCH_MS, _sent: sent, _shown: shown };
})();
