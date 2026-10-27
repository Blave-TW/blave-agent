/* window.BlaveReport.renderXt(el, { stats, name, market }, opts)
 * — 報告頁「成交測試」分頁(雲端工作頁 data-tab="xt" 那一段的移植,spec .claude/output/specs/lag-test-tab-2026-10-26.md §0、§3.5)。
 *
 * 按了才算(10-27):沒測過是空狀態一顆〔開始測試〕,有結果時 meta 列右側〔重新測試〕(新鮮描邊、過時填色,同參數掃描)。
 * 鈕送的是機器指令 stats_refresh {names:[name], exec_test:true}——不開對話回合、沒有確認框;鈕、疊層、失敗行由 perf.js 經 opts.rerun 交進來,
 * 跟回測數據分頁的〔更新績效〕共用同一份 perf 狀態。判讀句只陳述數字:門檻只決定挑哪幾個數字講,不產生任何結論字。
 * 純邏輯那一段(含兩層畫面狀態 xtPageOf / xtCellOf)跟 web 逐字同一份(tests/check_web_desktop_parity.js 切兩邊比)。
 *
 * 這支**不依賴桌面版的全域**,環境全在 opts:`t` = i18n;`buildMeta(o)` = 回測那一行 meta(只交標的 / 週期 / 期間,全頁叫交易成本、
 * 費率由成本段標題列講);`old` = 時光機看舊版本(版本不存 exec_test:只一句 vpanel-note、不給鈕);`behind` = 主機的 lib 確定不算 exec_test
 * (鈕那一格換成〔去更新〕+ 一句先更新,`onUpdate(btn)`;結果照畫);`ui()` = 這支的 perf 狀態 { perf: idle|running|failed, mine: 這頁按的那次 run|busy|fail|null }(perf.js perfXtInfo);
 * `turn` = agent 回合中;`rerun(kind)` = 鈕那一格,kind = empty|fresh|stale(回 null = 這支不能更新績效,不出鈕);
 * `onMetric()` = 表頭換了指標(值有變才叫;埋點在 app.js,這支不碰 telemetry)。
 *
 * SECURITY: exec_test 是 VM 端未信任輸入(雲端那份又經 api 轉過一手)——xtSanitize 逐格型別檢查,文字一律 textContent。 */
(function () {
  "use strict";

  const xtPick = { lag: "sharpe", cost: "sharpe" }; // 兩段各自記,不連動
  const XT_METRICS = ["sharpe", "ann", "mdd"]; // = [S, A, M] 的位置
  // 字串 key 寫全名(tests/check_shell_strings.js 只認字面)
  const XT_METRIC_KEY = { sharpe: "xt.m.sharpe", ann: "xt.m.ann", mdd: "xt.m.mdd" };
  const XT_UNIT_KEY = { m: "xt.unit.m", h: "xt.unit.h", d: "xt.unit.d", td: "xt.unit.td", w: "xt.unit.w" };

  // ---- 成交測試純邏輯(與 web workspace.html 同名標記行之間逐字同一份;tests/check_shell_xt.js 照這行與 end 那行切出來跑)----
  const XT_LAGS = ["0", "1", "2", "3", "5", "10"];
  const XT_COSTS = ["0.01", "0.02", "0.05", "0.1", "0.2", "0.5"];
  const XT_COST_SAY = ["0.01", "0.02", "0.05"]; // 判讀句只從這三檔挑
  const XT_TH = {
    flat: 0.12, // 晚 1–10 根都在現行 ±12% 內 → 講區間
    oneBig: 0.15, // 晚一根變動 ≥15% → 只講晚一根
    oneSmall: 0.05, // 晚一根 5–15% → 加講晚五根
    costDrop: 0.25, // 成本:第一個讓 Sharpe 掉 ≥25% 的那檔
    lowSharpe: 0.3, // 現行 Sharpe 低於這個不講百分比
    fewChanges: 20, // 換倉少於這個 → 只出「交易太少」
    closeFill: 0.02, // 本根收盤成交與現行差 ≥2% 才講
  };
  function xtTrip(v) {
    if (!Array.isArray(v) || v.length !== 3) return null;
    return v.map(function (c) {
      return typeof c === "number" && isFinite(c) ? c : null;
    });
  }
  function xtSanitize(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const lagIn = raw.lag && typeof raw.lag === "object" ? raw.lag : null;
    const costIn = raw.cost && typeof raw.cost === "object" ? raw.cost : null;
    if (!lagIn || !costIn) return null;
    const lag = {};
    for (let i = 0; i < XT_LAGS.length; i++) {
      const t = xtTrip(lagIn[XT_LAGS[i]]);
      if (!t) return null;
      lag[XT_LAGS[i]] = t;
    }
    if (lag["0"][0] === null) return null; // 沒有現行就沒得比
    const cost = { free: xtTrip(costIn.free) };
    if (!cost.free) return null;
    for (let i = 0; i < XT_COSTS.length; i++) {
      const t = xtTrip(costIn[XT_COSTS[i]]);
      if (!t) return null;
      cost[XT_COSTS[i]] = t;
    }
    const fin = function (v, lo, hi) {
      return typeof v === "number" && isFinite(v) && v >= lo && v <= hi ? v : null;
    };
    const fee = fin(raw.fee_per_side_pct, 0, 100);
    const changes = Number.isInteger(raw.position_changes) && raw.position_changes >= 0
      ? raw.position_changes
      : null;
    if (fee === null || changes === null) return null;
    const be = fin(raw.breakeven_pct_per_side, 0, 1e6);
    return {
      lag: lag,
      cost: cost,
      close: xtTrip(raw.close_fill),
      fee: fee,
      be: be !== null && be > 0 ? be : null,
      turnover: fin(raw.turnover_per_year, 0, 1e9),
      changes: changes,
    };
  }
  // 挑哪幾個數字講(spec §3.1)。回傳模板代號與原始數字,格式化與 i18n 在顯示端
  function xtVerdict(x) {
    if (x.changes < XT_TH.fewChanges) return { few: x.changes };
    const s = XT_LAGS.map(function (k) {
      return x.lag[k][0];
    });
    const s0 = s[0];
    const all = s.every(function (v) {
      return v !== null;
    });
    if (!(s0 >= XT_TH.lowSharpe) || !all) {
      return {
        lag: { k: "low", s0: s0, s1: s[1], s10: s[5] },
        cost: { k: "to", x: "0.05", s0: s0, s1: x.cost["0.05"][0] },
      };
    }
    const r = s.map(function (v) {
      return v / s0 - 1;
    });
    const mn = function (a) { return Math.min.apply(null, a); };
    const mx = function (a) { return Math.max.apply(null, a); };
    let lag;
    if (r.slice(1).every(function (v) { return Math.abs(v) <= XT_TH.flat; }))
      lag = { k: "flat", lo: mn(s), hi: mx(s) };
    else if (Math.abs(r[1]) >= XT_TH.oneBig) lag = { k: "one", r1: r[1] };
    else if (Math.abs(r[1]) >= XT_TH.oneSmall) lag = { k: "oneFive", r1: r[1], r5: r[4] };
    else lag = { k: "mixed", lo: mn(s.slice(0, 5)), hi: mx(s.slice(0, 5)), v10: s[5] };
    const q =
      XT_COST_SAY.find(function (c) {
        const v = x.cost[c][0];
        return v !== null && 1 - v / s0 >= XT_TH.costDrop;
      }) || "0.05";
    const sq = x.cost[q][0];
    return { lag: lag, cost: { k: sq !== null && sq < s0 ? "down" : "to", x: q, s0: s0, s1: sq } };
  }
  // 本根收盤成交那句:現行 Sharpe 太小時相對差沒意義,不講
  function xtCloseFill(x) {
    const s0 = x.lag["0"][0];
    const cf = x.close ? x.close[0] : null;
    if (cf === null || !(s0 >= XT_TH.lowSharpe)) return null;
    const d = cf / s0 - 1;
    return Math.abs(d) >= XT_TH.closeFill ? { cf: cf, s0: s0, d: d } : null;
  }
  // y 軸至少要涵蓋的範圍(spec §3.2/§3.3):不自動縮放,2% 的晃動不畫成大起伏。mi = 0 Sharpe、1 年化、2 最大回撤
  function xtLagRange(mi, v0) {
    const v = v0 === null ? 0 : v0;
    const a = Math.abs(v) * 0.3;
    if (mi === 2) return { lo: v * 1.3, hi: 0 };
    if (mi === 1) return { lo: Math.min(0, v - a), hi: Math.max(0, v + a) };
    return { lo: v - a, hi: v + a };
  }
  function xtCostRange(mi, v0) {
    const v = v0 === null ? 0 : v0;
    const a = Math.abs(v) * 0.3;
    if (mi === 2) return { lo: 0, hi: 0, floor: -100 };
    return {
      lo: Math.min(0, v - a),
      hi: Math.max(0, v + a),
      floor: -Math.max(Math.abs(v), mi === 0 ? 0.5 : 10),
    };
  }
  // Sharpe 歸零在成本軸上的位置:軸是 不計／現行／+0.01…+0.5(每邊多加的 %),落在兩點之間就內插。
  // 回傳 { at: 類別軸上的小數位置 | null, out: 超出軸 };現行 Sharpe 太小或沒有值 → null
  function xtBreakeven(x) {
    if (x.be === null || !(x.lag["0"][0] >= XT_TH.lowSharpe)) return null;
    const adds = [-x.fee, 0].concat(XT_COSTS.map(Number));
    const add = x.be - x.fee;
    for (let i = 0; i < adds.length - 1; i++) {
      if (add >= adds[i] && add <= adds[i + 1])
        return { at: i + (add - adds[i]) / (adds[i + 1] - adds[i]), out: false };
    }
    return { at: null, out: true };
  }
  // 費率欄的小數位:同一張表同一個位數(至少 2、最多 4,同 runner 的 round(…, 4))
  function xtFeeDp(fee) {
    let dp = 2;
    [fee].concat(XT_COSTS.map(function (c) { return fee + Number(c); })).forEach(function (v) {
      const t = String(Math.round(v * 1e4) / 1e4);
      dp = Math.max(dp, (t.split(".")[1] || "").length);
    });
    return Math.min(dp, 4);
  }
  // 過時的判準只有一條:現行那列的 Sharpe 跟目前 stats.json 的不相等(兩邊都是 4 位小數,構造上同一個數)
  function xtStale(x, sharpe) {
    return !!x && x.lag["0"][0] !== sharpe;
  }
  // 狀態分兩層(spec §3.5,電腦版同兩支,parity 測試餵同一組情境),各自命中就停。
  // 頁面層 o = {verActive, restoring, x: xtSanitize 後, sharpe: stats 的 Sharpe Ratio} → 1 時光機、2 還原重跑中、
  // 4 空狀態、7 過時、6 新鮮
  function xtPageOf(o) {
    if (o.verActive) return 1;
    if (o.restoring) return 2;
    if (!o.x) return 4;
    return xtStale(o.x, o.sharpe) ? 7 : 6;
  }
  // 鈕那一格 o = {cfg: config_supports_exec_test, perf: idle|running|failed, mine: 這頁按的那次 run|busy|fail|null,
  // turn: 有 agent 回合} → 3 lib 太舊、5 跑的期間、8 這頁按的失敗、9 回合中、0 一般〔開始測試〕／〔重新測試〕。
  // lib 太舊只換這一格:沒回報版本的機器旗標也是 false,stats.json 裡的結果照樣是對的
  function xtCellOf(o) {
    if (o.cfg !== true) return 3;
    if (o.perf === "running") return 5;
    if (o.perf === "failed" && !!o.mine && o.mine !== "busy") return 8;
    if (o.turn) return 9;
    return 0;
  }
  // ---- 成交測試純邏輯 end ----

  const R = () => window.BlaveReport || {};
  const fx = (v) => (R().fmtFixed ? R().fmtFixed(v) : null);
  const fsp = (v) => (R().fmtSignedPct ? R().fmtSignedPct(v) : null);
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  // 「…{key}…」樣板 → 文字節點 + 佈位;vars[key] 是節點就直接放,是字串就包 .mono(同 web fillTpl)
  function fillTpl(tpl, vars) {
    const frag = document.createDocumentFragment(), str = String(tpl), re = /\{(\w+)\}/g;
    let last = 0, m;
    while ((m = re.exec(str))) {
      if (m.index > last) frag.appendChild(document.createTextNode(str.slice(last, m.index)));
      const v = vars[m[1]];
      if (v instanceof Node) frag.appendChild(v);
      else frag.appendChild(el("span", "mono", v == null ? "—" : String(v)));
      last = re.lastIndex;
    }
    if (last < str.length) frag.appendChild(document.createTextNode(str.slice(last)));
    return frag;
  }

  // 「1 根＝1 小時，晚 10 根＝10 小時」:日線分曆日(加密)與交易日(股、期);讀不出來就不寫
  function xtBarSpan(bt, n, market, t) {
    const m = /^(\d*)\s*([mhdw])$/i.exec(typeof bt.interval === "string" ? bt.interval.trim() : "");
    if (!m) return null;
    const k = m[2].toLowerCase();
    let u = k;
    if (k === "d") {
      const mk = market || (/USD[TC]$/.test(String(bt.symbol || "")) ? "crypto" : null);
      if (!mk) return null;
      u = mk === "crypto" ? "d" : "td";
    }
    return fillTpl(t(XT_UNIT_KEY[u]), { n: String((parseInt(m[1], 10) || 1) * n) });
  }
  const xtPct = (r) => Math.round(Math.abs(r) * 100) + "%";
  const xtMove = (r, t) => fillTpl(t(r < 0 ? "xt.down" : "xt.up"), { p: xtPct(r) });
  const xtSh = (v) => fx(v) || "—";
  function xtVerdictNode(v, t) {
    if (v.few != null) return fillTpl(t("xt.few"), { n: String(v.few) });
    const L = v.lag;
    let lag;
    if (L.k === "flat") lag = fillTpl(t("xt.lagFlat"), { lo: xtSh(L.lo), hi: xtSh(L.hi) });
    else if (L.k === "one") lag = fillTpl(t("xt.lagOne"), { m1: xtMove(L.r1, t) });
    else if (L.k === "oneFive") lag = fillTpl(t("xt.lagOneFive"), { m1: xtMove(L.r1, t), m5: xtMove(L.r5, t) });
    else if (L.k === "mixed") lag = fillTpl(t("xt.lagMixed"), { lo: xtSh(L.lo), hi: xtSh(L.hi), v10: xtSh(L.v10) });
    else lag = fillTpl(t("xt.lagLow"), { s0: xtSh(L.s0), s1: xtSh(L.s1), s10: xtSh(L.s10) });
    const C = v.cost;
    const cost = fillTpl(t(C.k === "down" ? "xt.costDown" : "xt.costTo"), { x: C.x + "%", s0: xtSh(C.s0), s1: xtSh(C.s1) });
    return fillTpl(t("xt.verdict"), { lag: lag, cost: cost });
  }

  // 主機太舊(第二層 #3):那一格換成〔去更新〕＋一句;空狀態時這句當 lead 放在鈕上面(同樣本外驗證空狀態落後態),結果頁放鈕下
  function xtBehindCell(opts, lead) {
    const box = el("div", "xt-upd");
    const go = el("button", "btn-fill", opts.t("minv.btn"));
    go.type = "button";
    go.addEventListener("click", () => { if (typeof opts.onUpdate === "function") opts.onUpdate(go); });
    const line = el("p", lead ? "rob-empty-txt" : "xt-busy-line", opts.t("xt.behind"));
    if (lead) box.append(line, go); else box.append(go, line);
    return box;
  }
  // 鈕那一格:落後由這裡畫,其餘由 perf.js 給(opts.rerun;回 null = 這支不能更新績效,不出鈕)
  function xtCell(opts, cell, kind) {
    if (cell === 3) return xtBehindCell(opts, kind === "empty");
    return typeof opts.rerun === "function" ? opts.rerun(kind) : null;
  }

  // 表頭選指標:點了只換這一段的圖(判讀句永遠用 Sharpe);重畫後焦點留在同一顆
  function xtPickTable(sec, head, rows, ctx) {
    const t = ctx.opts.t, tb0 = el("table", "xt-tbl xt-pick" + (sec === "cost" ? " xt-cost" : ""));
    const thead = el("thead"), hr = el("tr");
    hr.appendChild(el("th", null, head));
    XT_METRICS.forEach((key) => {
      const on = xtPick[sec] === key;
      const th = el("th", "pickable" + (on ? " is-on" : ""));
      const b = el("button", "pick", t(XT_METRIC_KEY[key]));
      b.type = "button";
      b.dataset.xtSec = sec;
      b.dataset.xtKey = key;
      b.setAttribute("aria-pressed", on ? "true" : "false");
      b.setAttribute("aria-describedby", "xt-lag-how"); // 「點表頭換圖上的指標」那句
      b.addEventListener("click", () => {
        if (xtPick[sec] === key) return;
        xtPick[sec] = key;
        if (typeof ctx.opts.onMetric === "function") ctx.opts.onMetric();
        paint(ctx.container, ctx.data, ctx.opts);
        const nb = ctx.container.querySelector('button[data-xt-sec="' + sec + '"][data-xt-key="' + key + '"]');
        if (nb) nb.focus();
      });
      th.appendChild(b);
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    tb0.appendChild(thead);
    const tb = el("tbody");
    rows.forEach((r) => {
      const tr = el("tr"), td0 = el("td", null, r.label);
      if (r.sub) td0.appendChild(el("span", "xt-rsub")).appendChild(r.sub);
      tr.appendChild(td0);
      XT_METRICS.forEach((key, mi) => {
        const txt = mi === 0 ? fx(r.v[mi]) : fsp(r.v[mi]);
        tr.appendChild(el("td", "num" + (xtPick[sec] === key ? " is-on" : "") + (txt === null ? " na" : ""), txt || "—"));
      });
      tb.appendChild(tr);
    });
    tb0.appendChild(tb);
    return tb0;
  }
  function xtChart(spec) {
    const frame = el("div", "xt-chart"), scope = el("div", "rb-report");
    if (typeof window.renderReportLevels === "function") scope.appendChild(window.renderReportLevels(spec));
    frame.appendChild(scope);
    return frame;
  }
  function xtHead(title, sub) {
    const row = el("div", "xt-hrow");
    row.appendChild(el("h6", "xt-h", title));
    if (sub) { const sp = el("span", "xt-sub"); sp.appendChild(sub); row.appendChild(sp); }
    return row;
  }

  function xtBuildLag(x, bt, ctx) {
    const t = ctx.opts.t, sec = el("section", "xt-sec");
    const one = xtBarSpan(bt, 1, ctx.data.market, t), ten = xtBarSpan(bt, 10, ctx.data.market, t);
    sec.appendChild(xtHead(t("xt.lagH"), one && ten ? fillTpl(t("xt.lagSub"), { one: one, ten: ten }) : null));
    const key = xtPick.lag, mi = XT_METRICS.indexOf(key);
    const lbl = t("xt.lagLbl", { metric: t(XT_METRIC_KEY[key]) });
    sec.appendChild(el("div", "bt-label", lbl));
    const vals = XT_LAGS.map((k) => x.lag[k][mi]);
    const rg = xtLagRange(mi, vals[0]);
    sec.appendChild(xtChart({
      labels: XT_LAGS.map((k) => (k === "0" ? t("xt.cur") : "+" + k)),
      values: vals, cur: 0, lo: rg.lo, hi: rg.hi, base: vals[0], unit: mi === 0 ? "" : "%", aria: lbl,
    }));
    sec.appendChild(xtPickTable("lag", t("xt.colLag"), XT_LAGS.map((k) => ({ label: k === "0" ? t("xt.cur") : "+" + k, v: x.lag[k] })), ctx));
    const cf = xtCloseFill(x);
    if (cf) sec.appendChild(el("p", "xt-sub xt-cf")).appendChild(fillTpl(t(cf.d > 0 ? "xt.closeAte" : "xt.closeGain"), { a: xtSh(cf.cf), b: xtSh(cf.s0), c: xtPct(cf.d) }));
    const how = el("p", "xt-how", t("xt.lagHow"));
    how.id = "xt-lag-how";
    sec.appendChild(how);
    return sec;
  }

  function xtBuildCost(x, ctx) {
    const t = ctx.opts.t, sec = el("section", "xt-sec"), dp = xtFeeDp(x.fee);
    const fee = (v) => v.toFixed(dp) + "%";
    sec.appendChild(xtHead(t("xt.costH"), fillTpl(t("xt.costSub"), { fee: fee(x.fee), n: x.turnover === null ? "—" : String(Math.round(x.turnover)) })));
    const key = xtPick.cost, mi = XT_METRICS.indexOf(key);
    const lbl = t("xt.costLbl", { metric: t(XT_METRIC_KEY[key]) });
    sec.appendChild(el("div", "bt-label", lbl));
    const rows = [
      { label: t("xt.free"), v: x.cost.free },
      { label: t("xt.cur"), sub: fillTpl(t("xt.perSide"), { fee: fee(x.fee) }), v: x.lag["0"] },
    ].concat(XT_COSTS.map((c) => ({ label: "+" + c + "%", sub: fillTpl(t("xt.perSide"), { fee: fee(x.fee + Number(c)) }), v: x.cost[c] })));
    const vals = rows.map((r) => r.v[mi]);
    const rg = xtCostRange(mi, vals[1]), be = xtBreakeven(x), beTxt = be ? fee(x.be) : null;
    const clip = el("p", "xt-sub xt-clip");
    clip.hidden = true;
    sec.appendChild(xtChart({
      labels: [t("xt.freeAx"), t("xt.cur")].concat(XT_COSTS),
      values: vals, cur: 1, lo: rg.lo, hi: rg.hi, floor: rg.floor, base: vals[1],
      vx: be && !be.out ? be.at : null,
      vxLabel: beTxt ? t("xt.beLine", { fee: beTxt }) : null,
      vxOut: be && be.out ? t("xt.beOut", { fee: beTxt }) : null,
      unit: mi === 0 ? "" : "%", aria: lbl,
      onDraw: (cut) => { clip.textContent = cut ? t("xt.clip", { v: cut }) : ""; clip.hidden = !cut; },
    }));
    sec.appendChild(clip);
    sec.appendChild(xtPickTable("cost", t("xt.colCost"), rows, ctx));
    const kpi = el("div", "xt-kpi");
    kpi.appendChild(el("div", "k", t("xt.beK")));
    kpi.appendChild(el("div", "v")).appendChild(beTxt ? fillTpl(t("xt.perSide"), { fee: beTxt }) : el("span", "mono", "—"));
    sec.appendChild(kpi);
    sec.appendChild(el("p", "xt-how", t("xt.costHow")));
    return sec;
  }

  function paint(container, data, opts) {
    if (typeof opts.t !== "function") opts.t = (k) => k;
    data = data && typeof data === "object" ? data : {};
    container.textContent = "";
    const root = el("div", "bt xt");
    container.appendChild(root);
    // 時光機看舊版本:版本只存六個數字,重跑也補不回,不給鈕(橫幅已有「回到目前版本」)
    if (opts.old) { root.appendChild(el("p", "vpanel-note", opts.t("xt.fogOld"))); return; }
    const bt = data.stats && typeof data.stats === "object" ? data.stats : null;
    if (!bt) return;
    const x = xtSanitize(bt.exec_test);
    const ui = (typeof opts.ui === "function" && opts.ui()) || {};
    const o = { verActive: false, restoring: false, cfg: opts.behind !== true, x, sharpe: bt["Sharpe Ratio"],
      perf: ui.perf || "idle", mine: ui.mine || null, turn: opts.turn === true };
    const page = xtPageOf(o), cell = xtCellOf(o);
    // 這頁按的那次在跑:舊結果整塊收掉、只留頂列(同掃描／驗證,不用淡化表示失效;落後那格蓋過時不收)。
    // perf.js perfXtSync 比的是輸入(這頁按的那次在不在跑),不是收不收——兩邊各算一次決定會對不上、無限重畫
    const mineRun = ui.perf === "running" && ui.mine === "run", collapsed = cell === 5 && mineRun;
    root.dataset.xtMineRun = String(mineRun);
    if (page === 4) {
      const box = el("div", "rob-empty"), c = xtCell(opts, cell, "empty");
      if (c) box.appendChild(c);
      root.appendChild(box);
      return;
    }
    const stale = page === 7;
    const top = el("div", "rob-top");
    try { const meta = typeof opts.buildMeta === "function" ? opts.buildMeta({ symbol: bt.symbol, interval: bt.interval, start: bt.start, end: bt.end }) : null; if (meta) top.appendChild(meta); } catch (e) { console.warn("[xt]", e); }
    const c = xtCell(opts, cell, stale ? "stale" : "fresh");
    if (c) top.appendChild(c);
    root.appendChild(top);
    if (collapsed) return;
    const v = xtVerdict(x), ctx = { container, data, opts };
    const card = el("div", "rob-card xt-card");
    if (stale) card.appendChild(el("p", "rob-verdict xt-stale", opts.t("xt.verdictStale")));
    card.appendChild(el("p", "rob-verdict")).appendChild(xtVerdictNode(v, opts.t));
    root.appendChild(card);
    if (v.few != null) return; // 交易太少:兩段都測不出東西,不畫
    [() => xtBuildLag(x, bt, ctx), () => xtBuildCost(x, ctx)].forEach((fn) => {
      try { root.appendChild(fn()); } catch (e) { console.warn("[xt]", e); }
    });
  }

  window.BlaveReport = window.BlaveReport || {};
  window.BlaveReport.renderXt = function (container, data, opts) { paint(container, data, opts || {}); };
  // 純計算函式掛出來給核對腳本用(tests/check_shell_xt.js);畫面不靠這個
  window.BlaveReport._xt = { XT_TH, XT_LAGS, XT_COSTS, XT_COST_SAY, xtSanitize, xtVerdict, xtCloseFill, xtLagRange, xtCostRange, xtBreakeven, xtFeeDp, xtStale, xtPageOf, xtCellOf };
})();
