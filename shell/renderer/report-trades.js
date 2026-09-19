/* window.BlaveReport.renderTrades(container, stats) — 策略報告的「進出場」分頁。
 *
 * 從雲端工作頁(web/app/main/templates/agent/workspace.html 的 renderExecChart /
 * buildPositionTracks / buildExecMarkers / buildExecList)移植,資料轉換的規則
 * 一條不改,兩邊看同一支策略才會是同一張圖。差別只有三個:
 *   1. 資料整包在 stats.json 裡,沒有分塊載入/往前補抓/自動更新那一整層。
 *   2. 顏色在建圖當下從 tokens.css 讀(LWC 吃顏色字串,讀不到 CSS 變數)。
 *   3. 沒有全螢幕鈕、blave.org 浮水印(這一版的核准範圍沒有)。
 *
 * stats.json 是機器端策略碼的產物,一律當未信任輸入逐欄防禦:缺欄位、型別不對
 * 都不能丟例外——Type C(投資組合)本來就沒有 candles / trades。 */
(function () {
  "use strict";

  // ───────────────────────── 純資料轉換(不碰 DOM,scratchpad 的 node 腳本直接驗)

  // [[ts 秒, o, h, l, c, volume], …] → LWC 的 candle 物件。LWC 要求時間嚴格遞增,
  // 亂序或重複會直接丟例外,所以排序+去重在這裡做完,不指望上游
  function sanitizeCandles(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    raw.forEach(function (row) {
      // 雲端版要求 6 欄;volume 這裡用不到,只要 OHLC 在就收(舊 runner 可能沒有 volume)
      if (!Array.isArray(row) || row.length < 5) return;
      const ts = row[0];
      if (!Number.isInteger(ts)) return;
      for (let i = 1; i <= 4; i++) {
        if (typeof row[i] !== "number" || !isFinite(row[i])) return;
      }
      out.push({ time: ts, open: row[1], high: row[2], low: row[3], close: row[4] });
    });
    out.sort(function (a, b) {
      return a.time - b.time;
    });
    return out.filter(function (c, i) {
      return i === 0 || c.time !== out[i - 1].time;
    });
  }

  function sanitizeTrades(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(function (tr) {
        return (
          tr &&
          typeof tr.ts === "number" &&
          isFinite(tr.ts) &&
          typeof tr.price === "number" &&
          isFinite(tr.price) &&
          tr.price > 0 &&
          typeof tr.delta === "number" &&
          isFinite(tr.delta) &&
          tr.delta !== 0 &&
          (tr.direction === "buy" || tr.direction === "sell")
        );
      })
      .sort(function (a, b) {
        return a.ts - b.ts;
      });
  }

  // 上限照雲端版:最多 4 條線(= 類別色階長度,同圖的線才保證不同色)。
  // 點數上限不照抄 20,000——那是雲端內嵌視窗的大小;這裡 candles 整包都在,
  // 指標線砍到 20,000 點會比 K 線短一截
  const MAX_PANES = 4;
  function sanitizePanes(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    raw.forEach(function (p) {
      if (out.length >= MAX_PANES) return;
      if (!p || typeof p !== "object") return;
      if (typeof p.name !== "string" || !p.name.trim()) return;
      if (!Array.isArray(p.points)) return;
      const pts = [];
      p.points.forEach(function (pt) {
        if (!Array.isArray(pt) || pt.length < 2) return;
        if (typeof pt[0] !== "number" || !isFinite(pt[0])) return;
        if (typeof pt[1] !== "number" || !isFinite(pt[1])) return;
        pts.push({ time: pt[0], value: pt[1] });
      });
      pts.sort(function (a, b) {
        return a.time - b.time;
      });
      const dedup = pts.filter(function (c, i) {
        return i === 0 || c.time !== pts[i - 1].time;
      });
      if (dedup.length < 2) return; // 不到兩點畫不成線
      const levels = [];
      if (Array.isArray(p.levels)) {
        p.levels.forEach(function (lv) {
          if (levels.length >= 4) return;
          if (!lv || typeof lv.value !== "number" || !isFinite(lv.value)) return;
          levels.push(lv.value);
        });
      }
      out.push({
        name: p.name.trim().slice(0, 64),
        overlay: p.overlay === true,
        pane: typeof p.pane === "string" ? p.pane.trim().slice(0, 32) : "",
        points: dedup,
        levels: levels,
      });
    });
    return out;
  }

  // pane 分配(保序):overlay 恆疊主圖(0);帶分組 id 的同 id 進同一個子面板;
  // 其餘各開一個。Map 不是 plain object——id 是未信任字串,plain object 的查表
  // 會沿原型鏈命中 "constructor" 之類的 key
  function assignPanes(panes) {
    const byId = new Map();
    let cursor = 0;
    const index = panes.map(function (p) {
      if (p.overlay) return 0;
      if (p.pane) {
        if (!byId.has(p.pane)) byId.set(p.pane, ++cursor);
        return byId.get(p.pane);
      }
      return ++cursor;
    });
    return { index: index, subCount: cursor };
  }

  function startPosition(stats) {
    const v = stats && stats.trades_start_position;
    if (typeof v === "number" && isFinite(v)) return { value: v, known: true };
    return { value: 0, known: false };
  }

  // 每筆成交分類:開倉(0→非0)/平倉(→0)/翻向(符號改變)/其餘=調倉,
  // 並切成一段一段部位(0 → 非 0 → … → 0),點一列時圖要框住的就是「這一段」。
  // 事件後部位兩種來源不混用:每筆都帶 position 就直接採用(4dp,真平倉是字面 0);
  // 任一筆缺就整條退回 cumsum——4dp delta 的量化殘差遠大於歸零閾值,混用會讓
  // 連續權重策略永遠判不到 0
  function buildTracks(trades, start) {
    const hasPositions = trades.every(function (tr) {
      return typeof tr.position === "number" && isFinite(tr.position);
    });
    const tracks = [];
    let cur = null;
    let anyClose = false;
    // partial:這段從非 0(或未知)部位接手——進場成本不在紀錄裡,只在開新段時採用
    function push(tr, after, kind, partial) {
      if (!cur) cur = { points: [], closed: false, partial: partial };
      cur.points.push({
        ts: tr.ts,
        price: tr.price,
        direction: tr.direction,
        delta: tr.delta,
        posAfter: after,
        kind: kind,
      });
      if (after === 0) {
        anyClose = true;
        cur.closed = true;
        tracks.push(cur);
        cur = null;
      }
    }
    if (hasPositions) {
      // 起點未知(null)時開倉/翻向推不定 → 調倉;但 after === 0 必是平倉
      let prev = start.known ? start.value : null;
      trades.forEach(function (tr) {
        const after = tr.position;
        let kind;
        if (after === 0) kind = "close";
        else if (prev === null) kind = "adjust";
        else if (prev === 0) kind = "open";
        else if (prev > 0 !== after > 0) kind = "flip";
        else kind = "adjust";
        push(tr, after, kind, prev !== 0);
        prev = after;
      });
    } else {
      // 「視為 0」用相對閾值:上萬筆微調的浮點殘渣不該被當成持倉
      let scan = start.value;
      let maxAbs = Math.abs(scan);
      trades.forEach(function (tr) {
        scan += tr.delta;
        if (Math.abs(scan) > maxAbs) maxAbs = Math.abs(scan);
      });
      const eps = maxAbs > 0 ? maxAbs * 1e-6 : 1e-9;
      const isZero = function (x) {
        return Math.abs(x) <= eps;
      };
      let pos = start.value;
      trades.forEach(function (tr) {
        const before = pos;
        pos += tr.delta;
        if (isZero(pos)) pos = 0; // 收殘渣,漂移不積到下一段
        let kind;
        if (isZero(before) && pos !== 0) kind = "open";
        else if (!isZero(before) && pos === 0) kind = "close";
        else if (!isZero(before) && pos !== 0 && before > 0 !== pos > 0) kind = "flip";
        else kind = "adjust";
        push(tr, pos, kind, !isZero(before));
      });
    }
    if (cur) tracks.push(cur);
    // cumsum 路徑、起點未知、全程沒回過 0:「從 0 起算」沒被任何一次歸零驗證過,
    // 標出來的開倉/翻向很可能是截斷造出的假事件 → 全退回調倉,不編造
    if (!hasPositions && !start.known && !anyClose) {
      tracks.forEach(function (track) {
        track.points.forEach(function (p) {
          p.kind = "adjust";
        });
      });
    }
    return tracks;
  }

  // 成交時間對齊到「這根之前(含)最新一根」K 棒——marker 的 time 必須是 series
  // 裡真的存在的時間點。回測成交理論上落在棒界,但不假設
  function snapIndex(ts, candles) {
    let lo = 0;
    let hi = candles.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (candles[mid].time <= ts) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  }

  // 買=K 棒下方朝上、賣=上方朝下;方向由形狀+位置承擔,顏色買賣同一個墨色
  // (雲端版拍板:綠紅箭頭疊在同色 K 棒上難讀)。第一根 K 棒之前的事件不上圖
  // ——snap 會把它們全堆到第一根,比不畫更誤導;清單照列
  function buildMarkers(tracks, candles, color) {
    const out = [];
    if (!candles.length) return out;
    tracks.forEach(function (track) {
      track.points.forEach(function (p) {
        if (p.ts < candles[0].time) return;
        const isBuy = p.direction === "buy";
        out.push({
          time: candles[snapIndex(p.ts, candles)].time,
          position: isBuy ? "belowBar" : "aboveBar",
          color: color,
          shape: isBuy ? "arrowUp" : "arrowDown",
          size: 1,
        });
      });
    });
    out.sort(function (a, b) {
      return a.time - b.time;
    });
    return out;
  }

  // 倉位連線:每個部位一條線,進場點 → 出場點,中間加減碼不串(全事件串起在高頻
  // 策略上比訊號還吵)。win = 這個部位最終賺賠;未平倉不畫——還沒做完的交易沒有
  // 終點。track 是「0 → … → 0」一整段、翻向不切段,線要的卻是「一個方向的部位」,
  // 所以沿翻向點再切:舊部位的終點 = 新部位的起點 = 翻向那筆,兩條線自然相接。
  // 翻向那筆的 delta 拆兩半算損益:先把舊部位沖到 0(−before),剩下的(= posAfter)
  // 是新部位的起始成本。partial(從非 0 部位接手,進場成本不在紀錄裡)的第一個部位
  // 不畫;翻向之後起點已知,照畫。兩端落在同一根 K 棒的畫不成線段,略過;起點在
  // 第一根 K 棒之前的與 marker 同規則不上圖(snap 到首根會畫出假斜線)
  function buildSegments(tracks, candles) {
    const segs = [];
    if (!candles.length) return segs;
    function pushSeg(from, toTs, toPrice, pnl) {
      if (from.ts < candles[0].time) return;
      const t0 = candles[snapIndex(from.ts, candles)].time;
      const t1 = candles[snapIndex(toTs, candles)].time;
      if (t1 <= t0) return;
      segs.push({ t0: t0, p0: from.price, t1: t1, p1: toPrice, win: pnl >= 0 });
    }
    tracks.forEach(function (track) {
      let start = null;
      let cash = 0;
      let known = !track.partial;
      track.points.forEach(function (p) {
        const before = p.posAfter - p.delta;
        if (p.kind === "flip" || p.posAfter === 0) {
          cash += -before * p.price;
          if (start && known) pushSeg(start, p.ts, p.price, -cash);
          start = p.kind === "flip" ? p : null;
          cash = p.kind === "flip" ? p.posAfter * p.price : 0;
          known = true;
          return;
        }
        if (!start) start = p;
        cash += p.delta * p.price;
      });
    });
    return segs;
  }

  // 清單列:新的在上(使用者最想看的是最近發生什麼)
  function buildRows(tracks) {
    const rows = [];
    tracks.forEach(function (track) {
      track.points.forEach(function (p) {
        rows.push({ track: track, point: p });
      });
    });
    rows.sort(function (a, b) {
      return b.point.ts - a.point.ts;
    });
    return rows;
  }

  // 點一列要框住的 K 棒索引範圍:整段部位(進場→出場),未平倉的延伸到最後一根。
  // 雲端版是貼邊的 setVisibleRange;這裡兩側各留一點,不然進出場那兩根的箭頭
  // 正好壓在圖的邊緣被裁掉
  function trackBarRange(track, candles) {
    let from = Infinity;
    let to = -Infinity;
    track.points.forEach(function (p) {
      const i = snapIndex(p.ts, candles);
      if (i < from) from = i;
      if (i > to) to = i;
    });
    if (!track.closed) to = candles.length - 1;
    const pad = Math.max(5, Math.round((to - from) * 0.15));
    return { from: from - pad, to: to + pad };
  }

  // ───────────────────────── 格式

  function pad2(n) {
    return String(n).padStart(2, "0");
  }
  // canon › Copy:時間 = MM/DD HH:mm(本地時間,跟時間軸同一個時區)。
  // 回測清單常跨好幾年,只印月日會分不出是哪一年——只要有任何一筆不在今年,
  // 整張清單(與十字線)一律帶年份;全在今年才用短格式。整欄同一種格式,欄寬才齊
  function fmtTime(ts, withYear) {
    const d = new Date(ts * 1000);
    const md = pad2(d.getMonth() + 1) + "/" + pad2(d.getDate()) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
    return withYear ? d.getFullYear() + "/" + md : md;
  }
  function needsYear(trades, nowMs) {
    const y = new Date(nowMs).getFullYear();
    return trades.some(function (tr) {
      return new Date(tr.ts * 1000).getFullYear() !== y;
    });
  }
  // 價格小數位跟著量級走(同雲端版共用圖表設定的 priceFormatter),清單與右軸同一套
  function fmtPrice(v) {
    const n = Number(v);
    if (!isFinite(n)) return String(v);
    if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
    if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
    if (n >= 0.01) return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
    // 雲端版這一支是 Number(toPrecision(4)).toLocaleString():toLocaleString 預設最多
    // 3 位小數,0.000123 會印成 "0"。這裡直接要 4 位有效數字
    return n.toLocaleString("en-US", { maximumSignificantDigits: 4 });
  }

  // ───────────────────────── 畫面

  // 上一次建的圖。換策略時 container 被清空重用,但 LWC 的 canvas、它內建的
  // ResizeObserver、我們等尺寸用的那顆都還活著——不先釋放就是漏
  let live = null;
  function dispose() {
    if (!live) return;
    if (live.cancelSized) live.cancelSized();
    try {
      live.chart.remove();
    } catch (e) {
      /* 節點已經被外面清掉時 remove 可能抱怨,要的只是釋放 */
    }
    live = null;
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function token(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  // 類別色階 --color-data-2..4 還沒進 tokens.css(已回報要加)。補上之前退到
  // 現有的墨階 token,不在這裡寫死顏色;補上之後這個 fallback 自動失效
  const LINE_TOKENS = [
    ["--color-data-1", "--color-primary"],
    ["--color-data-2", "--ink-2"],
    ["--color-data-3", "--ink-3"],
    ["--color-data-4", "--ink"],
  ];
  function lineColor(i) {
    const pair = LINE_TOKENS[i % LINE_TOKENS.length];
    return token(pair[0]) || token(pair[1]);
  }

  // 與 LWC 內建 tick 格式同一張表(TickMarkType:0 年/1 月/2 日/3 時分/4 時分秒)。
  // LWC 預設軸標印的是 UTC 牆上時間,但清單與十字線是本地時間——同一根 K 棒差一個
  // 時區。照它的表重印,只把時區換成本地;粒度仍由 LWC 決定
  const TICK_FORMATS = [
    { year: "numeric" },
    { month: "short" },
    { day: "numeric" },
    { hour12: false, hour: "2-digit", minute: "2-digit" },
    { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" },
  ];

  const VIEW_BARS = 130; // 初始只看最近這麼多根:這個密度 K 棒與箭頭都還清楚可辨
  const MAIN_STRETCH = 7; // 主:子 = 7:2(雲端版實測後的比例)
  const SUB_STRETCH = 2;
  const LABEL_SIZE = 11;
  const LABEL_TOP_GAP = 8;

  // 連線的畫法:LWC Series Primitive 掛在 K 線 series 上,一個 canvas pass 畫完全部
  // 段(雲端版試過每段一條 LineSeries:上千段就卡、一萬段頁面掛掉)。每幀只把與
  // 可視範圍有交集的段換算成座標。虛線底下先墊一層卡面色實線(寬 4)、主虛線(寬 2)
  // 疊上——同色 K 棒上才切得出邊界。先全部墊底、再全部主線,翻向接點上後一段的
  // 墊底才不會蓋掉前一段的端點。段端點時間都已 snap 到 K 棒,timeToCoordinate 精確
  // 命中;價格走 K 線的 price scale,縮放/平移都跟著 K 棒
  const SEG_HALO_W = 4;
  const SEG_LINE_W = 2;
  function SegmentsPrimitive(segs, colors) {
    const self = this;
    this._segs = segs;
    this._colors = colors;
    this._chart = null;
    this._series = null;
    this._renderer = {
      draw: function (target) {
        self._draw(target);
      },
    };
    this._view = {
      renderer: function () {
        return self._renderer;
      },
    };
  }
  SegmentsPrimitive.prototype.attached = function (params) {
    this._chart = params.chart;
    this._series = params.series;
  };
  SegmentsPrimitive.prototype.detached = function () {
    this._chart = null;
    this._series = null;
  };
  SegmentsPrimitive.prototype.paneViews = function () {
    return [this._view];
  };
  SegmentsPrimitive.prototype._draw = function (target) {
    const chart = this._chart;
    const series = this._series;
    const segs = this._segs;
    const colors = this._colors;
    if (!chart || !series || !segs.length) return;
    const timeScale = chart.timeScale();
    target.useBitmapCoordinateSpace(function (scope) {
      const ctx = scope.context;
      const hr = scope.horizontalPixelRatio;
      const vr = scope.verticalPixelRatio;
      const width = scope.bitmapSize.width;
      const win = [];
      const loss = [];
      for (let i = 0; i < segs.length; i++) {
        const sg = segs[i];
        const x0 = timeScale.timeToCoordinate(sg.t0);
        const x1 = timeScale.timeToCoordinate(sg.t1);
        if (x0 === null || x1 === null) continue;
        if (x1 * hr < 0 || x0 * hr > width) continue; // t0 < t1 恆成立:整段在可視範圍外
        const y0 = series.priceToCoordinate(sg.p0);
        const y1 = series.priceToCoordinate(sg.p1);
        if (y0 === null || y1 === null) continue;
        (sg.win ? win : loss).push(x0 * hr, y0 * vr, x1 * hr, y1 * vr);
      }
      if (!win.length && !loss.length) return;
      function strokeAll(coords) {
        if (!coords.length) return;
        ctx.beginPath();
        for (let i = 0; i < coords.length; i += 4) {
          ctx.moveTo(coords[i], coords[i + 1]);
          ctx.lineTo(coords[i + 2], coords[i + 3]);
        }
        ctx.stroke();
      }
      ctx.save();
      ctx.lineCap = "butt";
      ctx.lineJoin = "round";
      ctx.lineWidth = SEG_HALO_W * vr;
      ctx.setLineDash([]);
      ctx.strokeStyle = colors.halo;
      strokeAll(win);
      strokeAll(loss);
      const w = SEG_LINE_W * vr;
      ctx.lineWidth = w;
      ctx.setLineDash([2 * w, 2 * w]);
      ctx.strokeStyle = colors.win;
      strokeAll(win);
      ctx.strokeStyle = colors.loss;
      strokeAll(loss);
      ctx.restore();
    });
  };

  function buildChart(host, candles, tracks, panes) {
    const LWC = LightweightCharts;
    const lang = document.documentElement.lang || "en";
    const inkMuted = token("--ink-3");
    const chart = LWC.createChart(host, {
      // autoSize = LWC 內建 ResizeObserver 追容器尺寸;chart.remove() 時一起釋放
      autoSize: true,
      layout: {
        textColor: inkMuted,
        background: { type: "solid", color: token("--surface-card") },
        // 子面板分隔線:LWC 的預設是給亮底用的淺灰,在暗卡面上是一條白線。
        // hover 是蓋在拖曳把手那一條帶上的填色,用卡面的提亮填色(canon › Terminal › Cards)
        panes: { separatorColor: token("--border-hairline"), separatorHoverColor: token("--surface-muted") },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderVisible: false, // 容器無外框,軸邊線一起關,不然圖內還留一圈線
        tickMarkFormatter: function (time, type) {
          if (typeof time !== "number") return null;
          const f = TICK_FORMATS[type];
          return f ? new Date(time * 1000).toLocaleString(lang, f) : null;
        },
      },
      rightPriceScale: { borderVisible: false },
      localization: {
        timeFormatter: function (time) {
          return typeof time === "number" ? fmtTime(time, true) : String(time);
        },
        priceFormatter: fmtPrice,
      },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
    });
    // 從這裡開始任何一步丟例外都要把 chart 收掉,不然 canvas 與 observer 留在外面
    try {
      const up = token("--color-green");
      const down = token("--color-red");
      const series = chart.addSeries(LWC.CandlestickSeries, {
        upColor: up,
        downColor: down,
        borderVisible: false,
        wickUpColor: up,
        wickDownColor: down,
      });
      series.setData(candles);

      const assign = assignPanes(panes);
      const members = new Map(); // 子面板 index → [{name, color}],畫面板標籤用
      panes.forEach(function (p, i) {
        const paneIndex = assign.index[i];
        const color = lineColor(i);
        const line = chart.addSeries(
          LWC.LineSeries,
          { color: color, lineWidth: 2, priceLineVisible: false, lastValueVisible: false },
          paneIndex
        );
        line.setData(p.points);
        // 門檻水平線(如 RSI 30/70):中性虛線+右軸數值,不做進/出語意配色
        p.levels.forEach(function (value) {
          line.createPriceLine({
            price: value,
            color: inkMuted,
            lineWidth: 1,
            lineStyle: LWC.LineStyle.Dashed,
            axisLabelVisible: true,
            title: "",
          });
        });
        if (!p.overlay) {
          if (!members.has(paneIndex)) members.set(paneIndex, []);
          members.get(paneIndex).push({ name: p.name, color: color });
        }
      });
      // 子面板標籤:LWC 的 pane 沒有原生標題,用 canvas 文字浮水印——未信任的
      // name 不進 HTML。首行空白是頂部間距(text watermark 沒有 padding 選項)
      members.forEach(function (list, paneIndex) {
        const lines = [{ text: " ", color: "transparent", fontSize: LABEL_SIZE, lineHeight: LABEL_TOP_GAP }];
        list.forEach(function (m) {
          lines.push({ text: m.name, color: list.length > 1 ? m.color : inkMuted, fontSize: LABEL_SIZE });
        });
        LWC.createTextWatermark(chart.panes()[paneIndex], { horzAlign: "left", vertAlign: "top", lines: lines });
      });
      if (assign.subCount) {
        const all = chart.panes();
        all[0].setStretchFactor(MAIN_STRETCH);
        for (let k = 1; k <= assign.subCount && k < all.length; k++) all[k].setStretchFactor(SUB_STRETCH);
      }

      LWC.createSeriesMarkers(series, buildMarkers(tracks, candles, token("--ink")));
      // 賺綠賠紅(箭頭刻意不上紅綠,賺賠由這條線承擔)
      series.attachPrimitive(
        new SegmentsPrimitive(buildSegments(tracks, candles), {
          halo: token("--surface-card"),
          win: up,
          loss: down,
        })
      );

      // 初始視野:定位到最近 ~130 根,更早的自己往左拉;按根數不按天數(分鐘線按
      // 天數會爆)。指標線的點可能落在 K 線範圍外(warmup),共用時間軸的 logical
      // 索引會位移,所以尾端索引由最後一根 K 棒反查,不假設 logical == 陣列索引
      const applyInitialView = function () {
        let tail = chart.timeScale().timeToIndex(candles[candles.length - 1].time, true);
        if (tail === null || tail === undefined) tail = candles.length - 1;
        chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, tail + 1 - VIEW_BARS), to: tail + 4 });
      };
      applyInitialView();
      // 縮放下限放寬到整段歷史裝得進一屏(預設 0.5px/根,幾千根就卡住);
      // enableConflation:縮到每根不到 1px 時自動合併著畫,不會一次畫幾十萬根
      chart.timeScale().applyOptions({ minBarSpacing: 0.002, enableConflation: true });
      return { chart: chart, applyInitialView: applyInitialView };
    } catch (e) {
      chart.remove();
      throw e;
    }
  }

  // 建圖當下初始視野可能套不住:容器 0 寬(分頁還沒排版),或容器有寬、但 autoSize
  // 的圖要等它自己的 ResizeObserver 第一次回呼才有內部寬度。所以不看 clientWidth,
  // 一律等第一次量到寬度再補套一次——observer 依建立順序回呼,LWC 的那顆先建,
  // 輪到這顆時圖已經有尺寸。只補一次(使用者還來不及操作,不會蓋掉他的縮放)。
  // 回傳取消函式
  const SIZED_GIVE_UP_MS = 60000;
  function whenSized(host, fn) {
    if (typeof ResizeObserver !== "function") return null;
    let ro = null;
    let giveUp = 0;
    const cancel = function () {
      clearTimeout(giveUp);
      if (ro) ro.disconnect();
    };
    giveUp = setTimeout(cancel, SIZED_GIVE_UP_MS);
    ro = new ResizeObserver(function () {
      if (!host.clientWidth) return;
      cancel();
      fn();
    });
    ro.observe(host);
    return cancel;
  }

  // 清單可達上萬筆,一次全塞 DOM 首繪會卡;捲近底部再補下一批
  const CHUNK = 500;
  function buildList(listEl, rows, withYear, onPick) {
    const kindKey = { open: "tr.kind.open", close: "tr.kind.close", flip: "tr.kind.flip" };
    function buildRow(entry) {
      const p = entry.point;
      const isBuy = p.direction === "buy";
      // 真的 button:鍵盤走得到、Enter/Space 會觸發,不必自己補 role 與 keydown
      const row = el("button", "tr-row");
      row.type = "button";
      row.appendChild(el("span", "tr-ts", fmtTime(p.ts, withYear)));
      row.appendChild(
        el("span", isBuy ? "tr-side is-buy" : "tr-side is-sell", t(isBuy ? "tr.buy" : "tr.sell") + " " + Math.abs(p.delta).toFixed(4))
      );
      // 種類小標只掛方向性事件;調倉列不加,整片同向微調裡才一眼挑得出開平倉
      if (kindKey[p.kind]) row.appendChild(el("span", "tr-kind", t(kindKey[p.kind])));
      row.appendChild(el("span", "tr-px", fmtPrice(p.price)));
      row.appendChild(el("span", "tr-pos", t("tr.position", { n: p.posAfter.toFixed(4) })));
      row.addEventListener("click", function () {
        const prev = listEl.querySelector('.tr-row[aria-current="true"]');
        if (prev) prev.removeAttribute("aria-current");
        row.setAttribute("aria-current", "true");
        onPick(entry.track);
      });
      return row;
    }
    let next = 0;
    function renderChunk() {
      const frag = document.createDocumentFragment();
      const end = Math.min(next + CHUNK, rows.length);
      for (; next < end; next++) frag.appendChild(buildRow(rows[next]));
      listEl.appendChild(frag);
    }
    renderChunk();
    if (next < rows.length) {
      listEl.addEventListener("scroll", function () {
        if (next >= rows.length) return;
        if (listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 200) renderChunk();
      });
    }
  }

  function renderTrades(container, stats) {
    dispose();
    container.textContent = "";
    const trades = sanitizeTrades(stats && stats.trades);
    if (!trades.length) {
      container.appendChild(el("div", "pf-state", t("tr.empty")));
      return;
    }
    const candles = sanitizeCandles(stats.candles);
    const tracks = buildTracks(trades, startPosition(stats));
    const withYear = needsYear(trades, Date.now());

    const root = el("div", "tr-root");
    container.appendChild(root);

    let built = null;
    if (candles.length) {
      const host = el("div", "tr-chart");
      root.appendChild(host);
      try {
        if (typeof LightweightCharts === "undefined") throw new Error("LWC_MISSING");
        built = buildChart(host, candles, tracks, sanitizePanes(stats.panes));
        live = { chart: built.chart, cancelSized: whenSized(host, built.applyInitialView) };
      } catch (e) {
        // 圖壞了清單還是有用:不讓一個 LWC 例外把整個分頁變成空白
        console.error("[report-trades]", e);
        built = null;
        host.textContent = "";
        host.classList.add("is-error");
        host.appendChild(el("div", "pf-state", t("tr.chartError")));
      }
    }

    const head = el("div", "tr-head");
    head.appendChild(el("span", "tr-label", t("tr.list")));
    head.appendChild(el("span", "tr-count", t("tr.count", { n: trades.length })));
    root.appendChild(head);

    const listEl = el("div", "tr-list");
    root.appendChild(listEl);
    buildList(listEl, buildRows(tracks), withYear, function (track) {
      if (!built) return;
      // 陣列索引 → logical 索引的位移(指標線 warmup 點落在首根 K 棒之前時不為 0)
      let base = built.chart.timeScale().timeToIndex(candles[0].time, true);
      if (base === null || base === undefined) base = 0;
      const r = trackBarRange(track, candles);
      built.chart.timeScale().setVisibleLogicalRange({ from: base + r.from, to: base + r.to });
    });
  }

  window.BlaveReport = window.BlaveReport || {};
  window.BlaveReport.renderTrades = renderTrades;
  // 純函式另外掛出來,只為了讓 node 腳本能不靠 DOM 直接驗;app 本身不用
  window.BlaveReport._tradesPure = {
    sanitizeCandles: sanitizeCandles,
    sanitizeTrades: sanitizeTrades,
    sanitizePanes: sanitizePanes,
    assignPanes: assignPanes,
    startPosition: startPosition,
    buildTracks: buildTracks,
    buildMarkers: buildMarkers,
    buildRows: buildRows,
    buildSegments: buildSegments,
    trackBarRange: trackBarRange,
    fmtTime: fmtTime,
    needsYear: needsYear,
    fmtPrice: fmtPrice,
  };
})();
