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
  // id 帶段與點的索引:同一根 K 棒常有好幾筆,按時間對不回是哪一列
  function pointId(ti, pi) {
    return "p" + ti + "_" + pi;
  }
  function buildMarkers(tracks, candles, color) {
    const out = [];
    if (!candles.length) return out;
    tracks.forEach(function (track, ti) {
      track.points.forEach(function (p, pi) {
        if (p.ts < candles[0].time) return;
        const isBuy = p.direction === "buy";
        out.push({
          time: candles[snapIndex(p.ts, candles)].time,
          position: isBuy ? "belowBar" : "aboveBar",
          color: color,
          shape: isBuy ? "arrowUp" : "arrowDown",
          size: 1,
          id: pointId(ti, pi),
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
    tracks.forEach(function (track, ti) {
      track.points.forEach(function (p, pi) {
        rows.push({ track: track, trackIdx: ti, point: p, id: pointId(ti, pi) });
      });
    });
    rows.sort(function (a, b) {
      return b.point.ts - a.point.ts;
    });
    return rows;
  }

  // 一段部位的 K 棒索引:進場 → 出場,未平倉的延伸到最後一根
  function trackSpan(track, candles) {
    let from = Infinity;
    let to = -Infinity;
    track.points.forEach(function (p) {
      const i = snapIndex(p.ts, candles);
      if (i < from) from = i;
      if (i > to) to = i;
    });
    if (!track.closed) to = candles.length - 1;
    return { from: from, to: to };
  }
  // 點一列要框住的 K 棒索引範圍:整段部位(進場→出場),未平倉的延伸到最後一根。
  // 雲端版是貼邊的 setVisibleRange;這裡兩側各留一點,不然進出場那兩根的箭頭
  // 正好壓在圖的邊緣被裁掉
  function trackBarRange(track, candles) {
    const s = trackSpan(track, candles);
    const pad = Math.max(5, Math.round((s.to - s.from) * 0.15));
    return { from: s.from - pad, to: s.to + pad };
  }

  // 點一筆要看的範圍(實機 10-18:一直在場、每天微調的策略整段就是 2021–2026,框整段等於縮到看不見):
  // 這段部位框起來不比現在的視野(viewBars 根)寬 → 照舊框整段、墊整段灰帶、同段的列一起亮;
  // 比視野寬 → 以這一筆為中心看 MIN_BARS 根、灰帶只墊這一根、清單只亮這一列
  function pickView(track, candles, ts, viewBars) {
    const whole = trackBarRange(track, candles);
    if (whole.to - whole.from <= Math.max(MIN_BARS, viewBars || 0)) {
      const s = trackSpan(track, candles);
      return { range: whole, band: s, whole: true };
    }
    const i = snapIndex(ts, candles);
    return { range: clampRange(i - MIN_BARS / 2, MIN_BARS, candles.length - 1), band: { from: i, to: i }, whole: false };
  }

  // 這段部位的損益 = Σ賣出金額 − Σ買進金額(同雲端 buildPositionTracks / finalizeOpenTrack):
  // 未平倉的用最後一根收盤價算浮動;partial 的進場成本不在紀錄裡,不給數字
  function trackPnl(track, lastClose) {
    if (track.partial) return null;
    let cash = 0;
    track.points.forEach(function (p) {
      cash += p.delta * p.price;
    });
    if (track.closed) return -cash;
    if (typeof lastClose !== "number" || !isFinite(lastClose)) return null;
    return track.points[track.points.length - 1].posAfter * lastClose - cash;
  }

  // 一打開的範圍(陣列索引),框的是「收進來的成交」,不是整段 K 線(設計稿 trades-tab-range 裁定一～三):
  //  - 名額:從最新一段往回收,收到箭頭平均間距會小於 MARK_GAP 為止。間距用「成交實際佔的寬度」算
  //    (圖寬扣掉兩側留白換成的像素),不拿全寬算。按筆數不按天數;首根 K 棒之前的點不上圖、不佔名額;
  //    最新那一段自己就裝不下(連續調倉、從不歸零)時改逐筆往回數
  //  - 左緣:最早收進來那筆再留 4%,不跨過沒收進來的那根箭頭,也不早於首根(前面的空白交給地圖)
  //  - 右緣:有未平倉部位、或尾端空檔不比成交跨度長 → 最後一根 + RIGHT_PAD(要看得到現在的價格);
  //    否則最後一筆 + 15%(早就空手的策略,箭頭才不會全擠在左緣)
  //  - 最少 MIN_BARS 根優先(稀疏策略不被放大到 K 棒太粗):不足時往兩側補(可以是小數根),不超出資料範圍
  //  - 沒有任何成交落在圖上 → 最近 MIN_BARS 根
  const MARK_GAP = 24;
  const MIN_BARS = 130;
  const RIGHT_PAD = 4; // 右緣多留幾根,未平倉部位與最後的價格不貼邊
  const LEFT_PAD = -2; // 首根左邊留一點空,首根的箭頭不被圖邊裁掉
  function rangeForCap(tracks, candles, cap) {
    const last = candles.length - 1;
    const first = candles[0].time;
    let used = 0;
    let from = null; // 收進來最早那根箭頭
    let newest = null; // 最新一根箭頭
    let older = null; // 沒收進來的最新一根箭頭
    for (let k = tracks.length - 1; k >= 0 && older === null; k--) {
      const pts = tracks[k].points.filter(function (p) {
        return p.ts >= first;
      });
      if (!pts.length) continue;
      if (newest === null) newest = snapIndex(pts[pts.length - 1].ts, candles);
      if (used + pts.length > cap) {
        if (from === null) {
          from = snapIndex(pts[pts.length - cap].ts, candles);
          older = snapIndex(pts[pts.length - cap - 1].ts, candles);
        } else {
          older = snapIndex(pts[pts.length - 1].ts, candles);
        }
        break;
      }
      used += pts.length;
      from = snapIndex(pts[0].ts, candles);
    }
    if (from === null) return null;
    const span = newest - from;
    const flat = tracks[tracks.length - 1].closed;
    const to = flat && last - newest > span ? newest + Math.max(5, Math.round(span * 0.15)) : last + RIGHT_PAD;
    let left = from - Math.max(5, Math.round((to - from) * 0.04));
    // 停在沒收進來那根與最早收進來那根的中間:兩根緊鄰時 +1 會讓最早那顆箭頭貼在圖邊被裁一半(同網頁 execFrameTrades)
    // 名額邊界剛好切在同一根 K 棒的兩筆之間(older 跟 from 同一根):分不開,留半根讓那根的箭頭不貼邊
    if (older !== null) left = older >= from ? from - 0.5 : Math.min(from, Math.max(left, older + 0.5));
    return { from: Math.max(LEFT_PAD, left), to: to, span: span };
  }
  function initialRange(tracks, candles, plotWidth) {
    const last = candles.length - 1;
    const fallback = { from: Math.max(0, last + 1 - MIN_BARS), to: last + RIGHT_PAD };
    if (last < 0 || !(plotWidth > 0)) return fallback;
    // 留白多寬要等範圍框出來才知道:先用全寬的名額框一次,用框出來的留白重算名額,
    // 名額只減不增,收斂為止
    let cap = Math.max(4, Math.floor(plotWidth / MARK_GAP));
    let r = rangeForCap(tracks, candles, cap);
    if (!r) return fallback;
    for (;;) {
      const fit = Math.max(4, Math.floor((plotWidth * r.span) / (r.to - r.from) / MARK_GAP));
      if (fit >= cap) break;
      cap = fit;
      r = rangeForCap(tracks, candles, cap);
    }
    let from = r.from;
    let to = r.to;
    const lo = LEFT_PAD;
    const hi = last + RIGHT_PAD;
    if (to - from < MIN_BARS) {
      if (hi - lo <= MIN_BARS) return { from: lo, to: hi };
      const need = MIN_BARS - (to - from);
      from -= need / 2;
      to += need / 2;
      if (from < lo) {
        to += lo - from;
        from = lo;
      }
      if (to > hi) {
        from -= to - hi;
        to = hi;
      }
    }
    return { from: from, to: to };
  }

  // 交易地圖拖曳/點擊/方向鍵後的範圍:寬度不變,夾在整段回測(含兩側留白)裡
  function clampRange(from, span, last) {
    const lo = LEFT_PAD;
    const hi = last + RIGHT_PAD;
    if (span >= hi - lo) return { from: lo, to: lo + span };
    const f = Math.min(Math.max(from, lo), hi - span);
    return { from: f, to: f + span };
  }

  // 地圖上每段部位一條:a..b 是 K 棒索引;tone 決定顏色(損益推不出來的跟未平倉同色)
  function mapBars(tracks, candles) {
    const out = [];
    if (!candles.length) return out;
    tracks.forEach(function (track) {
      if (track.points[track.points.length - 1].ts < candles[0].time) return;
      const s = trackSpan(track, candles);
      const pnl = track.pnl;
      const tone = !track.closed || typeof pnl !== "number" ? "none" : pnl >= 0 ? "win" : "loss";
      out.push({ a: s.from, b: s.to, tone: tone });
    });
    return out;
  }

  // 游標附近最近的箭頭(LWC 沒有回 hoveredObjectId 時的退路:縮到一根 K 棒不到 1px 時
  // 指不中箭頭本體)。markers 依時間排序;dxOf 回水平像素距離,隨時間單調,超過 tol 就停;
  // okOf 是垂直方向的條件
  function nearestMarker(markers, t, dxOf, okOf, tol) {
    let lo = 0;
    let hi = markers.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (markers[mid].time < t) lo = mid + 1;
      else hi = mid;
    }
    let best = null;
    let bd = tol;
    function scan(i) {
      const d = dxOf(markers[i]);
      if (!(d <= tol)) return false;
      if ((best === null || d < bd) && okOf(markers[i])) {
        bd = d;
        best = markers[i];
      }
      return true;
    }
    for (let i = lo; i < markers.length && scan(i); i++);
    for (let i = lo - 1; i >= 0 && scan(i); i--);
    return best;
  }

  // ───────────────────────── 格式

  function pad2(n) {
    return String(n).padStart(2, "0");
  }
  // canon › Copy:時間 = MM/DD HH:mm(本地時間,跟時間軸同一個時區)。
  // 回測清單常跨好幾年,只印月日會分不出是哪一年——只要有任何一筆不在今年,
  // 整張清單(與十字線)一律帶年份;全在今年才用短格式。整欄同一種格式,欄寬才齊
  // 日線以上(dateOnly)只印日期。日 K 的 ts 是「那一天的午夜」,但兩種寫法並存:UTC 午夜(加密日 K;美股與
  // fetch_twstock_price 是無時區日期,lib/runner .timestamp() 當 UTC)與台北午夜(fetch_twstock_ohlcv / fetch_twfutures_ohlcv 的
  // 1d 帶 Asia/Taipei)。固定用 UTC+8 取日期兩種都落在同一天(00:00 / 08:00);照本地時間印會多一個假的時間,UTC 以西還會退一天,
  // 純 UTC 則把台北午夜那種印成前一天
  const DAY_TZ_SHIFT = 8 * 3600;
  function fmtTime(ts, withYear, dateOnly) {
    if (dateOnly) {
      const u = new Date((ts + DAY_TZ_SHIFT) * 1000);
      const ymd = pad2(u.getUTCMonth() + 1) + "/" + pad2(u.getUTCDate());
      return withYear ? u.getUTCFullYear() + "/" + ymd : ymd;
    }
    const d = new Date(ts * 1000);
    const md = pad2(d.getMonth() + 1) + "/" + pad2(d.getDate()) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
    return withYear ? d.getFullYear() + "/" + md : md;
  }
  // 回測的 INTERVAL(stats.interval)一根 ≥ 1 天 → 進出場時間只印日期。認得 m / min / h / d / w / M(月);認不得就照舊印到分鐘
  const IVL_SEC = { m: 60, min: 60, h: 3600, d: 86400, w: 604800, M: 2592000 };
  function isDailyOrAbove(interval) {
    const m = /^(\d{1,4})\s*(min|m|h|d|w|M)$/.exec(String(interval || "").trim().replace(/[HDW]$/, (c) => c.toLowerCase()));
    return !!m && Number(m[1]) * IVL_SEC[m[2]] >= 86400;
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
  // 損益金額(同雲端 fmtAmount):四捨五入到整數、不掛幣別——計價單位跟著標的走,這裡拿不到
  function fmtAmount(v) {
    return (v < 0 ? "\u2212" : "") + Math.abs(Math.round(v)).toLocaleString("en-US");
  }

  // ───────────────────────── 畫面

  // 上一次建的圖。換策略時 container 被清空重用,但 LWC 的 canvas、它內建的
  // ResizeObserver、我們等尺寸用的那顆都還活著——不先釋放就是漏
  let live = null;
  function dispose() {
    if (!live) return;
    if (live.cancelSized) live.cancelSized();
    if (live.cancelMap) live.cancelMap();
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
    this._requestUpdate = null;
    this._band = null; // 選中那段部位的 K 棒時間 { t0, t1 };null = 沒選
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
    const bandRenderer = {
      draw: function (target) {
        self._drawBand(target);
      },
    };
    // 灰帶墊在 K 棒底下:疊在上面會把 K 棒的紅綠洗淡
    this._bandView = {
      zOrder: function () {
        return "bottom";
      },
      renderer: function () {
        return bandRenderer;
      },
    };
  }
  SegmentsPrimitive.prototype.attached = function (params) {
    this._chart = params.chart;
    this._series = params.series;
    this._requestUpdate = params.requestUpdate;
  };
  SegmentsPrimitive.prototype.detached = function () {
    this._chart = null;
    this._series = null;
    this._requestUpdate = null;
  };
  SegmentsPrimitive.prototype.paneViews = function () {
    return [this._bandView, this._view];
  };
  SegmentsPrimitive.prototype.setBand = function (band) {
    this._band = band;
    if (this._requestUpdate) this._requestUpdate();
  };
  SegmentsPrimitive.prototype._drawBand = function (target) {
    const band = this._band;
    const chart = this._chart;
    if (!band || !chart) return;
    const timeScale = chart.timeScale();
    const x0 = timeScale.timeToCoordinate(band.t0);
    const x1 = timeScale.timeToCoordinate(band.t1);
    if (x0 === null || x1 === null) return;
    // 兩端各外擴半根,頭尾那兩根 K 棒整根都在帶裡
    const half = Math.max(1, timeScale.options().barSpacing / 2);
    const fill = this._colors.band;
    target.useBitmapCoordinateSpace(function (scope) {
      const hr = scope.horizontalPixelRatio;
      scope.context.fillStyle = fill;
      scope.context.fillRect((x0 - half) * hr, 0, (x1 - x0 + 2 * half) * hr, scope.bitmapSize.height);
    });
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

  function buildChart(host, candles, tracks, panes, dateOnly) {
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
          return typeof time === "number" ? fmtTime(time, true, dateOnly) : String(time);
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

      const markers = buildMarkers(tracks, candles, token("--ink"));
      LWC.createSeriesMarkers(series, markers);
      // 賺綠賠紅(箭頭刻意不上紅綠,賺賠由這條線承擔)
      const segments = new SegmentsPrimitive(buildSegments(tracks, candles), {
        halo: token("--surface-card"),
        win: up,
        loss: down,
        band: token("--surface-muted"),
      });
      series.attachPrimitive(segments);

      // 指標線的點可能落在 K 線範圍外(warmup),共用時間軸的 logical 索引會位移:
      // 陣列索引 → logical 一律加這個位移,不假設 logical == 陣列索引
      const base = function () {
        const b = chart.timeScale().timeToIndex(candles[0].time, true);
        return b === null || b === undefined ? 0 : b;
      };
      const setRange = function (r) {
        const b = base();
        chart.timeScale().setVisibleLogicalRange({ from: b + r.from, to: b + r.to });
      };
      const getRange = function () {
        const r = chart.timeScale().getVisibleLogicalRange();
        if (!r) return null;
        const b = base();
        return { from: r.from - b, to: r.to - b };
      };
      // 初始視野見 initialRange。第一次呼叫時圖多半還沒量到寬度(→ 退回最近 130 根),
      // whenSized 會在量到之後再套一次
      const applyInitialView = function () {
        let w = chart.timeScale().width();
        if (!(w > 0)) w = host.clientWidth - chart.priceScale("right").width();
        setRange(initialRange(tracks, candles, w));
      };
      // 縮放下限放寬到整段歷史裝得進一屏(預設 0.5px/根,幾千根就卡住;要在套初始範圍之前,
      // 不然「整段」會被夾回預設下限);enableConflation:縮到每根不到 1px 時自動合併著畫
      chart.timeScale().applyOptions({ minBarSpacing: 0.002, enableConflation: true });
      applyInitialView();
      return {
        chart: chart,
        series: series,
        segments: segments,
        markers: markers,
        base: base,
        setRange: setRange,
        getRange: getRange,
        applyInitialView: applyInitialView,
      };
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

  // 交易地圖:圖正下方一條整段回測的縮圖(設計稿 trades-tab-range 方案三)。每段部位一條
  // (賺綠賠紅、推不出損益的灰),外框是圖現在看的範圍;拖外框平移、點空白處移過去、
  // ←/→ 每次半個範圍。candles 整包都在,不必像雲端版那樣等視窗停住才補抓
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function buildMap(wrap, built, candles, bars, dateOnly) {
    const last = candles.length - 1;
    const colors = {
      rail: token("--surface-muted"),
      frame: token("--ink"),
      win: token("--color-green"),
      loss: token("--color-red"),
      none: token("--ink-3"),
    };
    const cv = document.createElement("canvas");
    wrap.appendChild(cv);
    wrap.tabIndex = 0;
    wrap.setAttribute("role", "slider");
    wrap.setAttribute("aria-label", t("tr.mapAria"));
    wrap.setAttribute("aria-valuemin", "0");
    wrap.setAttribute("aria-valuemax", String(last));
    const at = function (i) {
      return candles[Math.max(0, Math.min(last, Math.round(i)))].time;
    };
    let raf = 0;
    function draw() {
      raf = 0;
      const w = cv.clientWidth;
      const h = cv.clientHeight;
      if (!w || !h) return;
      const dpr = window.devicePixelRatio || 1;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
      }
      const ctx = cv.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const x = function (i) {
        return (i / last) * w;
      };
      ctx.fillStyle = colors.rail;
      roundRect(ctx, 0, 6, w, h - 12, 4);
      ctx.fill();
      // 同色的一次 fill:上萬段也只有三次繪製
      ["none", "loss", "win"].forEach(function (tone) {
        ctx.beginPath();
        bars.forEach(function (b) {
          if (b.tone === tone) ctx.rect(x(b.a), 10, Math.max(2, x(b.b) - x(b.a)), h - 20);
        });
        ctx.fillStyle = colors[tone];
        ctx.fill();
      });
      const r = built.getRange();
      if (!r) return;
      const a = Math.max(0, x(r.from));
      const b = Math.min(w, x(r.to));
      ctx.strokeStyle = colors.frame;
      ctx.lineWidth = 1.5;
      roundRect(ctx, Math.min(a, w - 6) + 0.75, 1.75, Math.max(6, b - a) - 1.5, h - 3.5, 4);
      ctx.stroke();
      wrap.setAttribute("aria-valuenow", String(Math.max(0, Math.min(last, Math.round((r.from + r.to) / 2)))));
      wrap.setAttribute("aria-valuetext", fmtTime(at(r.from), true, dateOnly) + " – " + fmtTime(at(r.to), true, dateOnly));
    }
    function schedule() {
      if (!raf) raf = requestAnimationFrame(draw);
    }
    function barAt(e) {
      const rc = cv.getBoundingClientRect();
      return rc.width ? ((e.clientX - rc.left) / rc.width) * last : 0;
    }
    let drag = null;
    wrap.addEventListener("pointerdown", function (e) {
      if (e.button !== 0) return;
      const r = built.getRange();
      if (!r) return;
      const span = r.to - r.from;
      const b = barAt(e);
      let from = r.from;
      if (b < r.from || b > r.to) {
        const c = clampRange(b - span / 2, span, last);
        built.setRange(c);
        from = c.from;
      }
      // 點空白處 = 範圍移過去了,當下就記;在外框裡按下去要真的拖出位移才記
      const jumped = from !== r.from;
      drag = { off: b - from, span: span, from: from, sent: jumped };
      wrap.setPointerCapture(e.pointerId);
      wrap.focus({ preventScroll: true });
      e.preventDefault();
      if (jumped) trackFeature("trades_map_move");
    });
    wrap.addEventListener("pointermove", function (e) {
      if (!drag) return;
      const next = clampRange(barAt(e) - drag.off, drag.span, last);
      built.setRange(next);
      if (!drag.sent && next.from !== drag.from) {
        drag.sent = true;
        trackFeature("trades_map_move");
      }
    });
    const endDrag = function () {
      drag = null;
    };
    wrap.addEventListener("pointerup", endDrag);
    wrap.addEventListener("pointercancel", endDrag);
    wrap.addEventListener("keydown", function (e) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const r = built.getRange();
      if (!r) return;
      e.preventDefault();
      const span = r.to - r.from;
      const step = (e.key === "ArrowLeft" ? -0.5 : 0.5) * span;
      built.setRange(clampRange(r.from + step, span, last));
      trackFeature("trades_map_move");
    });
    built.chart.timeScale().subscribeVisibleLogicalRangeChange(schedule);
    let ro = null;
    if (typeof ResizeObserver === "function") {
      ro = new ResizeObserver(schedule);
      ro.observe(cv);
    }
    schedule();
    return function () {
      if (raf) cancelAnimationFrame(raf);
      if (ro) ro.disconnect();
    };
  }

  // 清單可達上萬筆,一次全塞 DOM 首繪會卡;捲近底部再補下一批
  const CHUNK = 500;
  // 清單列的 tooltip:這段部位的損益(文字同雲端 buildExecList)
  function rowTip(track) {
    if (track.partial) return t("tr.tip.partial");
    // 沒有 K 棒時未平倉段算不出浮動損益:只講還持有,不給數字
    if (typeof track.pnl !== "number") return t("tr.tip.openNoPx");
    const key = (track.closed ? "tr.tip.closed" : "tr.tip.open") + (track.pnl >= 0 ? "Win" : "Loss");
    return t(key, { n: fmtAmount(Math.abs(track.pnl)) });
  }

  // 回傳控制器:圖那邊選段、hover 箭頭、點箭頭要回頭操作清單。列是分批長出來的,
  // 選中狀態記在這裡,新長出來的列照狀態上 class
  function buildList(listEl, rows, withYear, dateOnly, onPick) {
    const kindKey = { open: "tr.kind.open", close: "tr.kind.close", flip: "tr.kind.flip" };
    const indexOf = new Map(); // point id → rows 索引
    rows.forEach(function (r, i) {
      indexOf.set(r.id, i);
    });
    const els = new Map(); // point id → 已長出來的列
    let selTrack = -1;
    let currentId = null;
    let selOnly = false;
    let hotEl = null;
    const isSel = function (entry) {
      return selOnly ? entry.id === currentId : entry.trackIdx === selTrack;
    };
    function buildRow(entry) {
      const p = entry.point;
      const isBuy = p.direction === "buy";
      // 真的 button:鍵盤走得到、Enter/Space 會觸發,不必自己補 role 與 keydown
      const row = el("button", "tr-row");
      row.type = "button";
      row.appendChild(el("span", "tr-ts", fmtTime(p.ts, withYear, dateOnly)));
      // 兩組:窄框時固定折成「方向+數量 種類」一行、「價格 … 部位」一行(report-trades.css 的 container query);寬框兩組攤平成一行
      const l1 = el("span", "tr-l1"), l2 = el("span", "tr-l2");
      l1.appendChild(
        el("span", isBuy ? "tr-side is-buy" : "tr-side is-sell", t(isBuy ? "tr.buy" : "tr.sell") + " " + Math.abs(p.delta).toFixed(4))
      );
      // 種類小標只掛方向性事件;調倉列不加,整片同向微調裡才一眼挑得出開平倉
      if (kindKey[p.kind]) l1.appendChild(el("span", "tr-kind", t(kindKey[p.kind])));
      l2.appendChild(el("span", "tr-px", fmtPrice(p.price)));
      l2.appendChild(el("span", "tr-pos", t("tr.position", { n: p.posAfter.toFixed(4) })));
      row.append(l1, l2);
      row.title = rowTip(entry.track);
      if (isSel(entry)) row.classList.add("is-sel");
      if (entry.id === currentId) row.setAttribute("aria-current", "true");
      row.addEventListener("click", function () {
        onPick(entry.trackIdx, entry.id, false);
      });
      els.set(entry.id, row);
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
    return {
      pick: onPick,
      // trackIdx = -1 取消選取;id = 被點的那一筆(aria-current 只掛它,同段其他列只是一起亮)
      // onlyRow:這段太長、只亮點的那一列(pickView whole false)
      select: function (trackIdx, id, onlyRow) {
        selTrack = trackIdx;
        currentId = trackIdx < 0 ? null : id;
        selOnly = !!onlyRow;
        els.forEach(function (row, rid) {
          row.classList.toggle("is-sel", isSel(rows[indexOf.get(rid)]));
          if (rid === currentId) row.setAttribute("aria-current", "true");
          else row.removeAttribute("aria-current");
        });
      },
      // 圖上 hover 到的箭頭對應的列;還沒長出來的列不為了 hover 去長(滑鼠一路掃過會把上萬列全長出來)
      hot: function (id) {
        const row = id ? els.get(id) || null : null;
        if (row === hotEl) return;
        if (hotEl) hotEl.classList.remove("is-hot");
        hotEl = row;
        if (row) row.classList.add("is-hot");
      },
      // 點箭頭:長到那一列為止,只在它不在視野裡時才捲
      reveal: function (id) {
        const i = indexOf.get(id);
        if (i === undefined) return;
        while (next <= i) renderChunk();
        const row = els.get(id);
        const L = listEl.getBoundingClientRect();
        const r = row.getBoundingClientRect();
        if (r.top < L.top || r.bottom > L.bottom) listEl.scrollTop += r.top - L.top - (L.height - r.height) / 2;
      },
    };
  }

  function renderTrades(container, stats) {
    dispose();
    container.textContent = "";
    const trades = sanitizeTrades(stats && stats.trades);
    if (!trades.length) {
      // 組合策略(Type C)的回測只有成交次數、沒有逐筆紀錄(lib/runner.py:它調的是一籃子的權重):講這件事,不要講成「沒有進出場」——
      // 回測數據那一頁明明寫著 182 筆。認法同轉出選單:stats 帶隨機投組基準 benchmark_n
      container.appendChild(el("div", "pf-state", t(stats && typeof stats.benchmark_n === "number" ? "tr.emptyPf" : "tr.empty")));
      return;
    }
    const candles = sanitizeCandles(stats.candles);
    const tracks = buildTracks(trades, startPosition(stats));
    const lastClose = candles.length ? candles[candles.length - 1].close : null;
    tracks.forEach(function (track) {
      track.pnl = trackPnl(track, lastClose);
    });
    const withYear = needsYear(trades, Date.now());
    const dateOnly = isDailyOrAbove(stats.interval);

    const root = el("div", "tr-root");
    container.appendChild(root);

    let built = null;
    let host = null;
    if (candles.length) {
      // 圖與交易地圖同一張卡;LWC 的 autoSize 量的是 host,地圖不能塞進 host 裡
      const card = el("div", "tr-card");
      host = el("div", "tr-chart");
      card.appendChild(host);
      root.appendChild(card);
      try {
        if (typeof LightweightCharts === "undefined") throw new Error("LWC_MISSING");
        built = buildChart(host, candles, tracks, sanitizePanes(stats.panes), dateOnly);
        live = { chart: built.chart, cancelSized: whenSized(host, built.applyInitialView) };
        if (candles.length > 1) {
          const wrap = el("div", "tr-map");
          card.appendChild(wrap);
          live.cancelMap = buildMap(wrap, built, candles, mapBars(tracks, candles), dateOnly);
        }
      } catch (e) {
        // 圖壞了清單還是有用:不讓一個 LWC 例外把整個分頁變成空白
        console.error("[report-trades]", e);
        dispose();
        built = null;
        card.textContent = "";
        card.classList.add("is-error");
        card.appendChild(el("div", "pf-state", t("tr.chartError")));
      }
    }

    const head = el("div", "tr-head");
    head.appendChild(el("span", "tr-label", t("tr.list")));
    head.appendChild(el("span", "tr-count", t("tr.count", { n: trades.length })));
    root.appendChild(head);

    const listEl = el("div", "tr-list");
    root.appendChild(listEl);
    let selected = null;
    // 點列與點箭頭同一件事:圖框住那段部位(太長就只看這一筆附近,pickView)、墊灰帶、亮列;再點同一段(長段是同一筆)就取消(範圍不動)
    const list = buildList(listEl, buildRows(tracks), withYear, dateOnly, function pick(trackIdx, id, fromChart) {
      const track = tracks[trackIdx];
      const pi = Number(/_(\d+)$/.exec(id)[1]);
      const cur = built ? built.getRange() : null;
      const v = candles.length ? pickView(track, candles, track.points[pi].ts, cur ? cur.to - cur.from : 0) : { whole: true };
      const key = v.whole ? "t" + trackIdx : id;
      if (key === selected) {
        selected = null;
        list.select(-1);
        if (built) built.segments.setBand(null);
        return;
      }
      selected = key;
      list.select(trackIdx, id, !v.whole);
      if (fromChart) list.reveal(id);
      trackFeature(fromChart ? "trades_mark_pick" : "trades_row_pick");
      if (!built) return;
      built.segments.setBand({ t0: candles[v.band.from].time, t1: candles[v.band.to].time });
      built.setRange(v.range);
    });
    if (built) wireChartToList(built, host, candles, list);
  }

  // 圖 → 表:hover 箭頭亮對應的列,點箭頭等於點那一列。先認 LWC 的 hoveredObjectId(箭頭本體);
  // 沒中再找游標水平 6px 內、垂直落在箭頭那一側的最近一個
  const HIT_PX = 6;
  const HIT_Y = 30;
  function wireChartToList(built, host, candles, list) {
    const byId = new Map();
    built.markers.forEach(function (m) {
      byId.set(m.id, m);
    });
    const ts = built.chart.timeScale();
    function markerAt(param) {
      if (!param.point || param.paneIndex !== 0) return null;
      if (param.hoveredObjectId && byId.has(param.hoveredObjectId)) return byId.get(param.hoveredObjectId);
      if (typeof param.logical !== "number") return null;
      const idx = Math.max(0, Math.min(candles.length - 1, Math.round(param.logical - built.base())));
      const px = param.point.x;
      const py = param.point.y;
      return nearestMarker(
        built.markers,
        candles[idx].time,
        function (m) {
          const x = ts.timeToCoordinate(m.time);
          return x === null ? Infinity : Math.abs(x - px);
        },
        function (m) {
          const c = candles[snapIndex(m.time, candles)];
          const y = built.series.priceToCoordinate(m.position === "aboveBar" ? c.high : c.low);
          if (y === null) return false;
          return m.position === "aboveBar" ? py <= y + 2 && py >= y - HIT_Y : py >= y - 2 && py <= y + HIT_Y;
        },
        HIT_PX
      );
    }
    built.chart.subscribeCrosshairMove(function (param) {
      const m = markerAt(param);
      list.hot(m ? m.id : null);
      host.classList.toggle("is-onmark", !!m);
    });
    built.chart.subscribeClick(function (param) {
      const m = markerAt(param);
      if (!m) return;
      const parts = /^p(\d+)_\d+$/.exec(m.id);
      if (parts) list.pick(Number(parts[1]), m.id, true);
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
    pickView: pickView,
    trackSpan: trackSpan,
    trackPnl: trackPnl,
    initialRange: initialRange,
    clampRange: clampRange,
    mapBars: mapBars,
    nearestMarker: nearestMarker,
    fmtAmount: fmtAmount,
    fmtTime: fmtTime,
    isDailyOrAbove: isDailyOrAbove,
    needsYear: needsYear,
    fmtPrice: fmtPrice,
  };
})();
