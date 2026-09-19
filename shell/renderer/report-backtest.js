/* window.BlaveReport.renderBacktest(container, stats) — 報告頁「回測」分頁。
 *
 * 移植自雲端工作頁(web/.../agent/workspace.html 的 buildBtMeta / buildEquity /
 * renderBtChart / buildBtHeatmap),視覺語言照抄、不自創。差別只有一個:雲端的 bt
 * 經 api 轉過一手,這裡直接吃機器上的 stats.json,所以**每個欄位都當成可能不在**
 * ——Type C(投資組合)的形狀跟 Type A 不同,缺了就那一塊不畫,不丟例外。
 *
 * stats.json 是 agent 寫出來的檔,不是我們的程式寫的:一律型別檢查後才用,
 * 文字只進 textContent。
 */
(function () {
  "use strict";

  const MINUS = "−"; // canon › Copy:負號用 U+2212,不用連字號(寬度跟 + 對不齊)
  const DASH = "—";  // 缺值

  const isNum = (v) => typeof v === "number" && isFinite(v);

  // ---------------------------------------------------------------- 純計算

  /* 單日報酬超過 ±100% 不是行情,是髒資料。留著它會把累乘炸掉、連帶把圖的
   * 刻度拉到看不見正常區段,所以當 0(雲端同一條規則)。 */
  function sanitizeDailyReturn(r) {
    return isNum(r) && Math.abs(r) <= 1 ? r : 0;
  }

  /* 權益與回撤一次算完:兩條線必須出自同一個累乘、同一組索引,
   * 畫在共用時間軸上才不可能錯位。equity 以 100 起算,drawdown 是 ≤0 的百分比。 */
  function buildSeries(stats) {
    const dates = Array.isArray(stats && stats.daily_dates) ? stats.daily_dates : [];
    const rets = Array.isArray(stats && stats.daily_returns) ? stats.daily_returns : [];
    const n = Math.min(dates.length, rets.length);
    const out = { dates: [], equity: [], drawdown: [] };
    let cum = 1;
    let peak = 1;
    for (let i = 0; i < n; i++) {
      cum *= 1 + sanitizeDailyReturn(rets[i]);
      if (cum > peak) peak = cum;
      if (typeof dates[i] !== "string") continue; // 報酬照樣累進去,只是這天不落點
      out.dates.push(dates[i]);
      out.equity.push(100 * cum);
      out.drawdown.push(100 * (cum / peak - 1));
    }
    return out;
  }

  /* 月報酬 = 當月 (1+r) 累乘 − 1。回傳 { "YYYY-MM": pct },沒有任何合法日期回 null。
   * 雲端版另外要求「至少一個完整月」才畫;桌面版的回測常常只跑幾週,
   * 那條閘門會讓熱圖整塊消失,所以這裡只要求有資料。 */
  function buildMonthly(stats) {
    const dates = Array.isArray(stats && stats.daily_dates) ? stats.daily_dates : [];
    const rets = Array.isArray(stats && stats.daily_returns) ? stats.daily_returns : [];
    const n = Math.min(dates.length, rets.length);
    const growth = {};
    let any = false;
    for (let i = 0; i < n; i++) {
      const d = dates[i];
      if (typeof d !== "string" || !/^\d{4}-(0[1-9]|1[0-2])-\d{2}/.test(d)) continue;
      const ym = d.slice(0, 7);
      if (!(ym in growth)) growth[ym] = 1;
      growth[ym] *= 1 + sanitizeDailyReturn(rets[i]);
      any = true;
    }
    if (!any) return null;
    const out = {};
    Object.keys(growth).forEach(function (ym) { out[ym] = 100 * (growth[ym] - 1); });
    return out;
  }

  /* 年度合計 = 把該年「有資料的月」複利起來。缺的月跳過、不當 0——
   * 當 0 在數學上一樣,但語意上是在宣稱那個月有交易而且打平。 */
  function buildYearly(monthly) {
    const g = {};
    Object.keys(monthly).forEach(function (ym) {
      const y = ym.slice(0, 4);
      g[y] = (y in g ? g[y] : 1) * (1 + monthly[ym] / 100);
    });
    const out = {};
    Object.keys(g).forEach(function (y) { out[y] = 100 * (g[y] - 1); });
    return out;
  }

  /* 以下三個 stats.json 沒有,照雲端工作頁的算法由 daily_returns 推(不自己挑常數):
   * 日序列是 calendar-daily(非交易日補 0),所以年化一律 365,不分商品。 */

  // 日勝率:分母只算報酬 ≠ 0 的天——持平與空倉日不算輸贏,算進去會把低頻策略的勝率壓到沒意義
  function dailyWinRate(rets) {
    if (!Array.isArray(rets)) return null;
    let wins = 0, nonzero = 0;
    for (let i = 0; i < rets.length; i++) {
      if (!isNum(rets[i])) continue;
      if (rets[i] > 0) wins++;
      if (rets[i] !== 0) nonzero++;
    }
    return nonzero ? (100 * wins) / nonzero : null;
  }

  // 年化波動率:樣本標準差(ddof=1)× √365;不到 30 個點的標準差不值得印出來
  function annualVol(rets) {
    if (!Array.isArray(rets)) return null;
    const xs = rets.filter(isNum);
    const n = xs.length;
    if (n < 30) return null;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += xs[i];
    mean /= n;
    let ss = 0;
    for (let i = 0; i < n; i++) ss += (xs[i] - mean) * (xs[i] - mean);
    return Math.sqrt(ss / (n - 1)) * Math.sqrt(365) * 100;
  }

  // 用正則拆年月日再 Date.UTC:new Date("YYYY-MM-DD") 的時區解讀會讓天數差一天
  function parseDay(s) {
    const m = typeof s === "string" && /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
  }

  /* 年化報酬:Type C 的 stats 自帶 `Ann. Return [%]` 就用它;Type A 沒有,
   * 由總報酬與回測天數推——(1 + 總報酬)^(365/天數) − 1。天數先取 start/end 的差,
   * 算不出來退回 daily_dates 的筆數。總報酬 ≤ −100% 時底數不為正,回 null。 */
  function annualReturn(stats) {
    const given = stats["Ann. Return [%]"];
    if (isNum(given)) return given;
    const tr = stats["Total Return [%]"];
    if (!isNum(tr)) return null;
    const s = parseDay(stats.start), e = parseDay(stats.end);
    let days = s !== null && e !== null ? Math.round((e - s) / 86400000) : null;
    if (!(days > 0)) days = Array.isArray(stats.daily_dates) ? stats.daily_dates.length : 0;
    const base = 1 + tr / 100;
    if (!(days > 0) || !(base > 0)) return null;
    const ann = (Math.pow(base, 365 / days) - 1) * 100;
    return isFinite(ann) ? ann : null;
  }

  /* MCPT 兩欄都在且合理才算有跑。沒跑的策略整列不出現(雲端同):
   * 「—」的意思是該有而沒有,而 MCPT 是選跑的檢定,沒跑不是缺值。 */
  function readMcpt(stats) {
    const p = stats && stats["MCPT p-value"];
    if (!isNum(p) || p < 0 || p > 1) return null;
    const n = stats["MCPT Permutations"];
    if (!Number.isInteger(n) || n < 1) return null;
    return { p: p, n: n };
  }

  /* "MCPT Distribution":{edges[k+1] 遞增, counts[k] 非負整數, actual}。任何一項不合
   * 就整塊不畫——舊回測沒這欄也走這裡。bin 上限是防 agent 寫出幾萬個 bin 把畫面拖死。 */
  const MCPT_MAX_BINS = 200;
  function readMcptDist(stats) {
    const d = stats && stats["MCPT Distribution"];
    if (!d || typeof d !== "object") return null;
    const edges = d.edges, counts = d.counts;
    if (!Array.isArray(edges) || !Array.isArray(counts)) return null;
    if (counts.length < 1 || counts.length > MCPT_MAX_BINS || edges.length !== counts.length + 1) return null;
    if (!isNum(d.actual)) return null;
    for (let i = 0; i < edges.length; i++) {
      if (!isNum(edges[i]) || (i > 0 && edges[i] <= edges[i - 1])) return null;
    }
    for (let i = 0; i < counts.length; i++) {
      if (!Number.isInteger(counts[i]) || counts[i] < 0) return null;
    }
    return { edges: edges, counts: counts, actual: d.actual };
  }

  // 軸刻度:1/2/5 × 10^k 的步距,目標 ~target 格
  function niceStep(span, target) {
    if (!(span > 0)) return 1;
    const raw = span / target;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / mag;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * mag;
  }

  // ---------------------------------------------------------------- 格式

  function fmtSignedPct(v, dp) {
    if (!isNum(v)) return null;
    const d = dp === undefined ? 2 : dp;
    const abs = Math.abs(v).toFixed(d);
    // 四捨五入後是 0 就不帶號:「−0.00%」讀起來像虧了
    const sign = Number(abs) === 0 ? "" : v > 0 ? "+" : MINUS;
    return sign + abs + "%";
  }
  function fmtFixed(v, dp) {
    if (!isNum(v)) return null;
    const s = Math.abs(v).toFixed(dp === undefined ? 2 : dp);
    return (v < 0 && Number(s) !== 0 ? MINUS : "") + s;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  // canvas 讀不到 CSS 變數:畫的當下現讀,token 改了不必動這支
  function token(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  // 熱圖格的淡色階:token 沒有紅綠的淡階,用 token 色 + alpha 現算(雲端同做法)
  function rgbaToken(name, a) {
    const h = token(name).replace("#", "");
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return "";
    const v = parseInt(h, 16);
    return "rgba(" + ((v >> 16) & 255) + "," + ((v >> 8) & 255) + "," + (v & 255) + "," + a + ")";
  }

  // ---------------------------------------------------------------- 1. meta

  function buildMeta(stats) {
    // 數值片段進 .mono;「手續費」這種要翻譯的字留在 sans——漢字不進 mono(canon › Type)
    const parts = [];
    const mono = (text, cls) => el("span", "mono" + (cls ? " " + cls : ""), text);
    if (typeof stats.symbol === "string" && stats.symbol) parts.push([mono(stats.symbol, "bt-sym")]);
    if (typeof stats.interval === "string" && stats.interval) parts.push([mono(stats.interval)]);
    const start = typeof stats.start === "string" && stats.start ? stats.start : null;
    const end = typeof stats.end === "string" && stats.end ? stats.end : null;
    if (start || end) parts.push([mono((start || DASH) + " \u2192 " + (end || DASH))]);
    const fee = fmtFixed(stats["fee [%]"]);
    if (fee !== null) parts.push([el("span", "", t("bt.fee")), mono(fee + "%")]);
    if (!parts.length) return null;
    const meta = el("div", "bt-meta");
    parts.forEach(function (nodes, i) {
      if (i) {
        const sep = el("span", "bt-sep", "\u00b7");
        sep.setAttribute("aria-hidden", "true");
        meta.appendChild(sep);
      }
      const group = el("span", "bt-mpart"); // 標籤跟它的值綁在一起,換行時不拆開
      nodes.forEach(function (nd) { group.appendChild(nd); });
      meta.appendChild(group);
    });
    return meta;
  }

  // ---------------------------------------------------------------- 2. 三組條列

  let tipSeq = 0;

  /* tearsheet 慣例(雲端 buildBtStats 同構):報酬 / 風險 / 交易三組,左標籤右數字。
   * 總報酬是這一頁的主角,字大一階;不另外做 hero 區塊。 */
  function buildMetrics(stats) {
    const rets = Array.isArray(stats.daily_returns) ? stats.daily_returns : null;
    const pct1 = (v) => (isNum(v) ? v.toFixed(1) + "%" : null);
    // 每個指標的標籤都帶一句白話說明(Wei):定義照 lib/analysis.py 與 lib/runner.py 的算法寫,
    // 不是教科書版——例如 Omega 這裡是「賺的總和 ÷ 賠的總和」、交易次數是「部位變動的次數」。
    const tip = (v, key) => Object.assign(v, { tip: t(key) });
    const signed = (v) => ({ text: fmtSignedPct(v), tone: isNum(v) && v > 0 ? "pos" : isNum(v) && v < 0 ? "neg" : "" });
    const plain = (text) => ({ text: text, tone: "" });

    /* 基準報酬是比較對象、不是這支策略的損益,所以不上紅綠——上了會讀成
     * 「策略也賺了這麼多」。Type C 沒有單一標的可比,改用隨機投組的百分位。 */
    const br = stats["Benchmark Return [%]"];
    const rank = stats["benchmark_strategy_ret_pct"];
    const bench = !isNum(br) && isNum(rank)
      ? { text: t("bt.benchmarkRank", { n: String(Math.round(rank)) }), tone: "", prose: true }
      : plain(fmtSignedPct(br));

    const fees = fmtFixed(stats["Total Fees Paid [%]"]);
    const n = stats["Trades"];
    const groups = [
      [t("bt.grpReturns"), [
        [t("bt.totalReturn"), tip(Object.assign(signed(stats["Total Return [%]"]), { hero: true }), "bt.tip.totalReturn")],
        [t("bt.annReturn"), tip(signed(annualReturn(stats)), "bt.tip.annReturn")],
        [t("bt.benchmark"), tip(bench, bench.prose ? "bt.tip.benchmarkRank" : "bt.tip.benchmark")],
        [t("bt.annVol"), tip(plain(pct1(annualVol(rets))), "bt.tip.annVol")],
      ]],
      [t("bt.grpRisk"), [
        [t("bt.maxDrawdown"), tip(signed(stats["Max Drawdown [%]"]), "bt.tip.maxDrawdown")],
        [t("bt.sharpe"), tip(plain(fmtFixed(stats["Sharpe Ratio"])), "bt.tip.sharpe")],
        [t("bt.sortino"), tip(plain(fmtFixed(stats["Sortino Ratio"])), "bt.tip.sortino")],
        [t("bt.omega"), tip(plain(fmtFixed(stats["Omega Ratio"])), "bt.tip.omega")],
      ]],
      [t("bt.grpTrading"), [
        [t("bt.trades"), tip(plain(isNum(n) ? String(Math.round(n)) : null), "bt.tip.trades")],
        [t("bt.winRate"), tip(plain(pct1(dailyWinRate(rets))), "bt.tip.winRate")],
        [t("bt.totalFees"), tip(plain(fees === null ? null : fees + "%"), "bt.tip.totalFees")],
      ]],
    ];

    /* p 值單看是一個沒學過統計就讀不懂的數字,所以判讀一定要跟著它走——
     * 目前放在標籤的 tooltip(hover 與鍵盤 focus 都會出)。`sig` 留在列資料上:
     * 之後若要把「顯著 / 未達顯著」印回畫面,從這裡接,不必重寫判讀。
     * 沒過門檻不上紅:紅只留給虧損,「分不出實力或運氣」不是虧。 */
    const mcpt = readMcpt(stats);
    if (mcpt) {
      const sig = mcpt.p < 0.05;
      groups[1][1].push([t("bt.mcpt"), {
        text: mcpt.p.toFixed(3),
        tone: sig ? "pos" : "",
        sig: sig,
        tip: t(sig ? "bt.mcptTipSig" : "bt.mcptTipNs", { n: String(mcpt.n), pct: (mcpt.p * 100).toFixed(1) + "%" }),
      }]);
    }

    const cols = el("div", "bt-cols");
    groups.forEach(function (g) {
      const col = el("div", "bt-col");
      col.appendChild(el("div", "bt-group", g[0]));
      g[1].forEach(function (r) {
        const v = r[1];
        const row = el("div", "bt-mrow");
        const mk = el("div", "bt-mk");
        if (v.tip) {
          // 觸發點與泡泡直接用 app.css 現成的 .mp-tip / .tip(相鄰兄弟選擇器帶顯示),不另寫一份
          const id = "bt-tip-" + ++tipSeq;
          const btn = el("button", "mp-tip", r[0]);
          btn.type = "button";
          btn.setAttribute("aria-describedby", id);
          const bubble = el("span", "tip", v.tip);
          bubble.id = id;
          bubble.setAttribute("role", "tooltip");
          mk.appendChild(btn);
          mk.appendChild(bubble);
        } else {
          mk.textContent = r[0];
        }
        const cls = v.text === null ? " na" : (v.tone ? " " + v.tone : "") + (v.hero ? " hero" : "") + (v.prose ? " prose" : " mono");
        row.appendChild(mk);
        row.appendChild(el("div", "bt-mv" + cls, v.text === null ? DASH : v.text));
        col.appendChild(row);
      });
      cols.appendChild(col);
    });
    return cols;
  }

  // ---------------------------------------------------------------- 3. 權益 + 回撤

  const EQ_MULTS = [0.1, 0.2, 0.5, 1, 2, 3, 5, 10, 20, 50, 100, 200, 500];
  const DD_STEPS = [0.5, 1, 2, 5, 10, 20, 25, 50];

  /* 一張 canvas、上下兩區、共用同一個 xAt:兩張圖各畫各的遲早會在某個寬度差一個像素。 */
  function drawChart(canvas, series) {
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    const n = series.equity.length;
    if (!W || !H || n < 2) return; // 分頁藏著的時候量到 0,等 ResizeObserver 再叫
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.font = "10px " + (getComputedStyle(canvas).fontFamily || "sans-serif");

    const cLine = token("--color-primary"); // 同雲端版:權益線是這張圖唯一的品牌色
    const cDown = token("--color-red");
    const cGrid = token("--border-hairline");
    const cText = token("--ink-3");

    const padL = 38, padR = 10, padT = 12, padB = 22, gap = 4;
    const plotW = W - padL - padR;
    const xAt = (i) => padL + (plotW * i) / (n - 1);
    const availH = H - padT - padB - gap;
    const ddH = Math.max(1, Math.round(availH / 3.2)); // 權益是主角,回撤條 ≤ 它的一半
    const eqH = availH - ddH;
    const eqTop = padT;
    const ddTop = eqTop + eqH + gap;

    function hline(y, dashed) {
      ctx.strokeStyle = cGrid;
      ctx.lineWidth = 1;
      ctx.setLineDash(dashed ? [3, 3] : []);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(W - padR, y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    function ylabel(text, y) {
      ctx.fillStyle = cText;
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillText(text, padL - 6, y);
    }
    function path(vals, yOf) {
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        if (i === 0) ctx.moveTo(xAt(i), yOf(vals[i]));
        else ctx.lineTo(xAt(i), yOf(vals[i]));
      }
    }

    // ---- 權益(對數軸:+100% 與 −50% 在圖上等距,才不會把後段的波動誇大)----
    let min = 100, max = 100; // 100 = 損益兩平,永遠留在視野內
    for (let i = 0; i < n; i++) {
      if (series.equity[i] < min) min = series.equity[i];
      if (series.equity[i] > max) max = series.equity[i];
    }
    if (!(min > 0) || min === max) { min = Math.max(min * 0.9, 1e-6); max = max * 1.1 || 1; }
    let lo = Math.log(min), hi = Math.log(max);
    const pad = (hi - lo) * 0.06 || 0.1;
    lo -= pad; hi += pad;
    const yEq = (v) => eqTop + eqH * (1 - (Math.log(Math.max(v, 1e-6)) - lo) / (hi - lo));
    EQ_MULTS.forEach(function (m) {
      const v = m * 100;
      if (v < min || v > max) return;
      hline(yEq(v), m === 1);
      ylabel((m < 1 ? m.toFixed(1) : String(m)) + "×", yEq(v));
    });
    ctx.strokeStyle = cLine;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    path(series.equity, yEq);
    ctx.stroke();

    // ---- 回撤(線性 %,0 貼上緣往下掛)----
    let minV = 0;
    for (let i = 0; i < n; i++) if (series.drawdown[i] < minV) minV = series.drawdown[i];
    if (minV === 0) minV = -1; // 全程沒回撤:留一個真刻度,不要 0/0
    const ddLo = minV * 1.06;
    const yDd = (v) => ddTop + ddH * (v / ddLo);
    let step = DD_STEPS[DD_STEPS.length - 1];
    for (let i = 0; i < DD_STEPS.length; i++) {
      if (-ddLo / DD_STEPS[i] <= 4) { step = DD_STEPS[i]; break; }
    }
    for (let v = 0, k = 0; v >= ddLo - 1e-9 && k < 24; v -= step, k++) { // 24:髒資料也不會畫到當機
      hline(yDd(v), v === 0);
      const a = Math.abs(v);
      ylabel(v === 0 ? "0%" : MINUS + (a % 1 ? a.toFixed(1) : String(a)) + "%", yDd(v));
    }
    ctx.beginPath();
    ctx.moveTo(xAt(0), yDd(0));
    for (let i = 0; i < n; i++) ctx.lineTo(xAt(i), yDd(series.drawdown[i]));
    ctx.lineTo(xAt(n - 1), yDd(0));
    ctx.closePath();
    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = cDown;
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = cDown;
    ctx.lineWidth = 1.5;
    path(series.drawdown, yDd);
    ctx.stroke();

    // ---- 共用時間軸:頭/中/尾;窄到三個日期會相撞時只留頭尾 ----
    const idx = W < 300 ? [0, n - 1] : [0, Math.floor((n - 1) / 2), n - 1];
    ctx.fillStyle = cText;
    ctx.textBaseline = "alphabetic";
    idx.forEach(function (i) {
      ctx.textAlign = i === 0 ? "left" : i === n - 1 ? "right" : "center";
      ctx.fillText(series.dates[i].slice(0, 10), xAt(i), H - 6);
    });
  }

  function buildChart(series) {
    const wrap = el("div", "bt-block");
    const head = el("div", "bt-label");
    head.appendChild(el("span", "bt-legend", t("bt.equity")));
    head.appendChild(el("span", "bt-legend dd", t("bt.drawdown")));
    wrap.appendChild(head);
    const frame = el("div", "bt-frame");
    const canvas = el("canvas", "bt-canvas");
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", t("bt.chartAria"));
    frame.appendChild(canvas);
    wrap.appendChild(frame);
    return { node: wrap, canvas: canvas };
  }

  // ---------------------------------------------------------------- 4. 月報酬熱圖

  /* 深淺 = |v| / cap。月格與年度欄各用各的 cap:年度報酬天生比單月大,
   * 共用一個 cap 會把整片月格洗成同一個淡色。 */
  function heatBg(v, cap) {
    const a = cap > 0 ? Math.min(Math.abs(v) / cap, 1) : 0;
    if (a < 0.06) return token("--surface-muted"); // 接近 0:中性,不硬分紅綠
    return rgbaToken(v >= 0 ? "--color-green" : "--color-red", +(0.1 + a * 0.45).toFixed(2));
  }
  // 格子只有 ~40px 寬,印整數;要兩位小數的人看 title
  function fmtHeat(v) {
    const r = Math.round(Math.abs(v));
    return (r === 0 ? "" : v > 0 ? "+" : MINUS) + r + "%";
  }

  function buildHeatmap(stats) {
    const monthly = buildMonthly(stats);
    if (!monthly) return null;
    const yearly = buildYearly(monthly);
    const years = Object.keys(yearly).sort();
    let cap = 0, ycap = 0;
    Object.keys(monthly).forEach(function (k) { cap = Math.max(cap, Math.abs(monthly[k])); });
    years.forEach(function (y) { ycap = Math.max(ycap, Math.abs(yearly[y])); });

    const wrap = el("div", "bt-block");
    wrap.appendChild(el("div", "bt-label", t("bt.monthly")));
    const frame = el("div", "bt-frame bt-heat-frame");
    const table = el("table", "bt-heat");
    const thead = el("thead");
    const hr = el("tr");
    const corner = el("th");
    corner.scope = "col";
    hr.appendChild(corner);
    for (let m = 1; m <= 12; m++) {
      const th = el("th", "", (m < 10 ? "0" : "") + m);
      th.scope = "col";
      hr.appendChild(th);
    }
    const yth = el("th", "yr", t("bt.year"));
    yth.scope = "col";
    hr.appendChild(yth);
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = el("tbody");
    function heatCell(v, c, cls) {
      const td = el("td", cls || "");
      if (isNum(v)) {
        td.style.background = heatBg(v, c);
        td.textContent = fmtHeat(v);
        td.title = fmtSignedPct(v);
      }
      return td;
    }
    years.forEach(function (y) {
      const tr = el("tr");
      const th = el("th", "", y);
      th.scope = "row";
      tr.appendChild(th);
      for (let m = 1; m <= 12; m++) tr.appendChild(heatCell(monthly[y + "-" + (m < 10 ? "0" : "") + m], cap));
      tr.appendChild(heatCell(yearly[y], ycap, "yr"));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    frame.appendChild(table);
    wrap.appendChild(frame);
    return wrap;
  }

  // ---------------------------------------------------------------- 5. MCPT 分佈

  /* 直方圖 = 把進出場隨機打亂 N 次得到的 Sharpe 分佈;虛線 = 這支策略實際的 Sharpe。
   * 線右邊剩多少面積就是 p 值——這張圖的用處是讓人「看見」p 值,不是再給一個數字。
   * 幾何照雲端 report_blocks.js 的 histogram block(bin 間 2px 縫、線落在分佈外時延軸)。 */
  function drawMcpt(canvas, dist, labels) {
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    if (!W || !H) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.font = "10px " + (getComputedStyle(canvas).fontFamily || "sans-serif");

    const cBar = token("--color-primary"); // 單一分佈 = 一個序列,用主序列色;不用漲跌色
    /* 實際值的線用中性虛線、不用紅:p < 0.05 時線落在右尾是「好結果」,紅會被讀成虧 */
    const cRef = token("--ink-3");
    const cGrid = token("--border-hairline");
    const cText = token("--ink-3");
    const cInk = token("--ink-2");

    // 右邊讓出 x 軸單位的寬度:單位跟刻度同一列,不讓的話會壓到最後一個刻度(雲端 xUnitPad)
    const padL = 38, padT = 30, padB = 22;
    const padR = 10 + Math.ceil(ctx.measureText(labels.xUnit).width) + 8;
    const n = dist.counts.length;
    const lo = Math.min(dist.edges[0], dist.actual);
    const hi = Math.max(dist.edges[n], dist.actual);
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const bottom = padT + plotH;
    const xAt = (v) => padL + ((v - lo) / (hi - lo || 1)) * plotW;

    let maxC = 0;
    for (let i = 0; i < n; i++) if (dist.counts[i] > maxC) maxC = dist.counts[i];
    const yStep = Math.max(1, niceStep(maxC || 1, 4)); // 次數是整數,步距不小於 1
    const yMax = Math.max(yStep, Math.ceil(maxC / yStep) * yStep);
    const yAt = (c) => bottom - (c / yMax) * plotH;

    // ---- y 格線 + 次數刻度;單位標在軸頂 ----
    ctx.lineWidth = 1;
    ctx.textBaseline = "middle";
    ctx.textAlign = "right";
    for (let c = 0, k = 0; c <= yMax + 1e-9 && k < 12; c += yStep, k++) {
      ctx.strokeStyle = cGrid;
      ctx.beginPath();
      ctx.moveTo(padL, yAt(c));
      ctx.lineTo(W - padR, yAt(c));
      ctx.stroke();
      ctx.fillStyle = cText;
      ctx.fillText(String(Math.round(c)), padL - 6, yAt(c));
    }
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = cText;
    ctx.fillText(labels.unit, 0, 10);

    // ---- bars ----
    ctx.fillStyle = cBar;
    for (let i = 0; i < n; i++) {
      const bx = xAt(dist.edges[i]);
      const bw = Math.max(1, xAt(dist.edges[i + 1]) - bx - 2);
      const h = (dist.counts[i] / yMax) * plotH;
      if (h > 0) ctx.fillRect(bx, bottom - h, bw, h);
    }

    // ---- 實際值 ----
    const rx = xAt(dist.actual);
    ctx.strokeStyle = cRef;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(rx, padT);
    ctx.lineTo(rx, bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = cInk;
    ctx.textBaseline = "alphabetic";
    // 標籤置中在線上,但貼邊時會伸出畫布:夾回來
    const tw = ctx.measureText(labels.actual).width;
    ctx.textAlign = "left";
    ctx.fillText(labels.actual, Math.min(Math.max(rx - tw / 2, padL), W - tw), padT - 6);

    // ---- x 刻度(Sharpe);窄欄少放幾個,不然數字相撞 ----
    const xStep = niceStep(hi - lo, W < 420 ? 4 : 7);
    const dp = xStep >= 1 ? 0 : xStep >= 0.1 ? 1 : 2;
    ctx.fillStyle = cText;
    ctx.textAlign = "center";
    for (let v = Math.ceil(lo / xStep) * xStep, k = 0; v <= hi + 1e-9 && k < 24; v += xStep, k++) {
      const r = Math.abs(v) < xStep / 1e6 ? 0 : v; // 浮點累加出來的 −0.0
      ctx.fillText((r < 0 ? MINUS : "") + Math.abs(r).toFixed(dp), xAt(r), H - 6);
    }
    ctx.textAlign = "right";
    ctx.fillText(labels.xUnit, W, H - 6);
  }

  /* 樣板裡的 {數字} 包進 .mono——數字與漢字不共用字體(雲端 fillTpl 同做法) */
  function fillMono(node, tpl, vars) {
    String(tpl).split(/(\{\w+\})/).forEach(function (part) {
      const m = /^\{(\w+)\}$/.exec(part);
      if (m && m[1] in vars) node.appendChild(el("span", "mono", vars[m[1]]));
      else if (part) node.appendChild(document.createTextNode(part));
    });
    return node;
  }

  // p 值或次數缺一,標題那句就寫不出來 → 整塊不畫(跟 MCPT 那一列同一條規矩)
  function buildMcptDist(stats) {
    const dist = readMcptDist(stats);
    const m = readMcpt(stats);
    if (!dist || !m) return null;
    const wrap = el("div", "bt-block");
    const head = el("div", "bt-label bt-label-prose");
    fillMono(head, t("bt.mcptDistTitle"), { n: m.n.toLocaleString("en-US"), p: m.p.toFixed(3) });
    wrap.appendChild(head);
    const frame = el("div", "bt-frame");
    const canvas = el("canvas", "bt-canvas bt-canvas-mcpt");
    const actual = t("bt.mcptDistActual", { v: fmtFixed(dist.actual) });
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", head.textContent + " \u00b7 " + actual);
    frame.appendChild(canvas);
    wrap.appendChild(frame);
    return { node: wrap, canvas: canvas, dist: dist,
             labels: { actual: actual, unit: t("bt.mcptDistUnit"), xUnit: "Sharpe" } };
  }

  // ---------------------------------------------------------------- 入口

  /* 上一次的 observer 綁在 container 上帶著走:換策略重畫時舊的要斷掉,
   * 不然每看一支策略就多一個 observer 在重畫已經不在畫面上的 canvas。 */
  const observers = new WeakMap();

  function renderBacktest(container, stats) {
    const prev = observers.get(container);
    if (prev) { prev.disconnect(); observers.delete(container); }
    container.textContent = "";
    if (!stats || typeof stats !== "object") {
      container.appendChild(el("div", "bt-empty", t("bt.empty")));
      return;
    }
    const root = el("div", "bt");
    // 每一塊各自 try:stats.json 是 agent 寫的,一塊壞掉不該拖垮整頁
    function section(fn) {
      try {
        const node = fn();
        if (node) root.appendChild(node);
      } catch (e) {
        console.warn("[backtest]", e);
      }
    }
    section(function () { return buildMeta(stats); });
    section(function () { return buildMetrics(stats); });

    let chart = null;
    let series = null;
    section(function () {
      series = buildSeries(stats);
      if (series.equity.length < 2) return null;
      chart = buildChart(series);
      return chart.node;
    });
    section(function () { return buildHeatmap(stats); });
    let mcptChart = null;
    section(function () {
      mcptChart = buildMcptDist(stats);
      return mcptChart && mcptChart.node;
    });
    container.appendChild(root);

    if (chart || mcptChart) {
      // 兩張圖各自 try:一張畫壞不該讓另一張跟著空白
      const redraw = function () {
        if (chart) try { drawChart(chart.canvas, series); } catch (e) { console.warn("[backtest]", e); }
        if (mcptChart) try { drawMcpt(mcptChart.canvas, mcptChart.dist, mcptChart.labels); } catch (e) { console.warn("[backtest]", e); }
      };
      if (typeof ResizeObserver === "function") {
        // 觀察 container 而不是 canvas:分頁從 hidden 切回來時 container 的尺寸從 0 變回來,
        // 這一下就是第一次真正畫的時機。兩張圖共用這一個 observer
        const ro = new ResizeObserver(redraw);
        ro.observe(container);
        observers.set(container, ro);
      }
      redraw();
    }
  }

  window.BlaveReport = window.BlaveReport || {};
  window.BlaveReport.renderBacktest = renderBacktest;
  // 純計算函式掛出來給一次性的核對腳本用;畫面不靠這個
  window.BlaveReport._bt = {
    buildSeries: buildSeries, buildMonthly: buildMonthly, buildYearly: buildYearly,
    readMcpt: readMcpt, fmtSignedPct: fmtSignedPct,
    readMcptDist: readMcptDist, annualReturn: annualReturn, annualVol: annualVol, dailyWinRate: dailyWinRate,
  };
})();
