/* window.BlaveReport.renderRobust(el, { stats, scan, code, name }, opts)
 * window.BlaveReport.robSync(el, opts) — 回合開始 / 結束時就地換空狀態的鈕態(不重畫)
 * — 報告頁「參數掃描」分頁(雲端工作頁 data-tab="robust" 那一段的移植)。
 *
 * 純函式(sanitizeScan / robWhere / constFromCode…)與 DOM 結構照抄 workspace.html 的
 * robust 段,規則一條不改——兩邊看同一份 scan.json 要得出同一個結論。
 *
 * 這支**不依賴桌面版的全域**,環境全在 opts:`t` = i18n;`onScan(name, opener)` = 掃描鈕的送出
 * (回 Promise<turn|false>:跑起來的那一回合的序號,送出成功才鎖成「已送出」);`busy` = 回合進行中;
 * `turn` = 目前回合序號(「已送出」只認送出那一輪);`scope` = 這一袋是哪一邊(本機 / 雲端同名策略不互相污染);
 * `buildMeta(stats)` = 回測那一行 meta 的節點(沒給就只寫「掃描 R×C」)。之後 web 也能載同一支。
 *
 * scan.json 是機器端 lib/param_scan.write_scan 寫的、雲端那份又經 api 轉過一手:兩邊都
 * 當未信任輸入——逐欄型別檢查、每軸 ≤40、索引在網格內、參數名 ≤64 字;文字只進 textContent。 */
(function () {
  "use strict";

  const MINUS = "−";
  const DASH = "—";
  const ROB_MAX_DIM = 40;          // 每軸格數上限(同 api 的 _clean_scan);再大不是給人看的,也防 DOM 爆量
  const ROB_STEPS = [0.5, 1.0, 1.75];   // |Sharpe| 四階色深門檻(同雲端)
  const ROB_ALPHA = [0.12, 0.23, 0.34, 0.45];   // 四階 alpha = 雲端 color-mix 的 12/23/34/45%

  const isNum = (v) => typeof v === "number" && isFinite(v);

  // ---------------------------------------------------------------- 純計算(照抄雲端)

  function numList(a) {
    if (!Array.isArray(a) || !a.length || a.length > ROB_MAX_DIM) return null;
    for (let i = 0; i < a.length; i++) if (!isNum(a[i])) return null;
    return a.slice();
  }
  // R×C 數值網格;沒交易的格是 null(NaN 經 JSON 也成 null),其餘非有限值同樣視為缺
  function numGrid(g, R, C) {
    if (!Array.isArray(g) || g.length !== R) return null;
    const out = [];
    for (let i = 0; i < R; i++) {
      if (!Array.isArray(g[i]) || g[i].length !== C) return null;
      out.push(g[i].map((v) => (isNum(v) ? v : null)));
    }
    return out;
  }
  /* 目前參數以策略碼裡的常數為準:scan.json 的 current 是「掃描當下」檔案裡的常數,採用穩健參數
   * 重跑回測後就舊了。只認頂層 `NAME = 數字`;數字寫成無歧義的 \d+(?:\.\d*)?(不用 \d+\.?\d*,
   * 長數字串失敗時會二次回溯);取最後一個頂層指定(Python 語意是後者蓋前者)。 */
  function constFromCode(code, name) {
    if (typeof code !== "string" || typeof name !== "string" || !/^[A-Za-z_]\w*$/.test(name)) return null;
    const re = new RegExp("^" + name + "[ \\t]*=[ \\t]*(-?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][-+]?\\d+)?)[ \\t]*(?:#.*)?\\r?$", "gm");
    let m = null, last = null;
    while ((m = re.exec(code)) !== null) last = m[1];
    if (last === null) return null;
    const v = Number(last);
    return isFinite(v) ? v : null;
  }
  // 軸上找值(同 lib/param_scan._locate 的容差精神:相對 1e-9),找不到 -1
  function locate(vals, v) {
    for (let i = 0; i < vals.length; i++) if (Math.abs(vals[i] - v) <= 1e-9 * Math.max(1, Math.abs(v))) return i;
    return -1;
  }
  function cellIdx(o, R, C) {
    if (!o || typeof o !== "object") return null;
    const i = o.i, j = o.j;
    return Number.isInteger(i) && Number.isInteger(j) && i >= 0 && i < R && j >= 0 && j < C ? { i: i, j: j } : null;
  }
  // (2w+1)² 鄰域平均、略過 null——與機器端 find_plateau 同定義。只在 scan 缺 nbr_mean 時退而自算
  function nbrMean(grid, w) {
    const R = grid.length, C = grid[0].length, out = [];
    for (let i = 0; i < R; i++) {
      const row = [];
      for (let j = 0; j < C; j++) {
        if (grid[i][j] === null) { row.push(null); continue; }
        let sum = 0, n = 0;
        for (let a = Math.max(0, i - w); a <= Math.min(R - 1, i + w); a++) {
          for (let b = Math.max(0, j - w); b <= Math.min(C - 1, j + w); b++) {
            if (grid[a][b] === null) continue;
            sum += grid[a][b]; n++;
          }
        }
        row.push(n ? sum / n : null);
      }
      out.push(row);
    }
    return out;
  }
  function argmax(m) {
    let best = null;
    m.forEach((row, i) => row.forEach((v, j) => { if (v !== null && (best === null || v > best.v)) best = { i: i, j: j, v: v }; }));
    return best && { i: best.i, j: best.j };
  }
  // 同一軸的參數值用同一個小數位數(0.7 與 0.85 並排要印 0.70 / 0.85),上限 4
  function decimals(vals) {
    let d = 0;
    vals.forEach((v) => {
      const s = String(v), k = s.indexOf(".");
      if (k >= 0 && s.indexOf("e") < 0) d = Math.max(d, Math.min(4, s.length - k - 1));
    });
    return d;
  }
  /* stats = 同一支策略的回測:採用穩健參數重跑回測後 scan.current 會過時——兩邊的時間戳都在且
   * scan 早於回測(stats.json 的 "Generated At")→ current 視為未知、結論句換「回測已重跑」 */
  function sanitizeScan(raw, stats, code) {
    if (!raw || typeof raw !== "object") return null;
    if (typeof raw.row_param !== "string" || !raw.row_param || raw.row_param.length > 64) return null;
    if (typeof raw.col_param !== "string" || !raw.col_param || raw.col_param.length > 64) return null;
    const rows = numList(raw.row_vals), cols = numList(raw.col_vals);
    if (!rows || !cols) return null;
    const R = rows.length, C = cols.length;
    const grid = numGrid(raw.grid, R, C);
    if (!grid) return null;
    const w = Number.isInteger(raw.window) && raw.window >= 1 && raw.window <= ROB_MAX_DIM ? raw.window : 1;   // 上限同軸長:再大鄰域就是整張表
    const nbr = numGrid(raw.nbr_mean, R, C) || nbrMean(grid, w);
    const peak = cellIdx(raw.peak, R, C) || argmax(grid);
    const plateau = cellIdx(raw.plateau, R, C) || argmax(nbr);
    if (!peak || !plateau) return null;   // 全格沒交易,沒東西可講
    // cur:null=未知;{i,j}=在網格上;{i:null,j:null,vals}=在掃描範圍外
    let cur = null, stale = false;
    const rvNow = constFromCode(code, raw.row_param), cvNow = constFromCode(code, raw.col_param);
    if (rvNow !== null && cvNow !== null) {
      const i = locate(rows, rvNow), j = locate(cols, cvNow);
      cur = i >= 0 && j >= 0 ? { i: i, j: j } : { i: null, j: null, vals: [rvNow, cvNow] };
    } else {
      if (raw.current && typeof raw.current === "object") {
        cur = cellIdx(raw.current, R, C);
        if (!cur) {
          const vals = numList(raw.current.vals);
          if (vals && vals.length === 2) cur = { i: null, j: null, vals: vals };
        }
      }
      const sg = raw.generated_at, bg = stats && typeof stats === "object" ? stats["Generated At"] : undefined;
      stale = isNum(sg) && isNum(bg) && sg < bg;
      if (stale) cur = null;
    }
    return { stale, rowParam: raw.row_param, colParam: raw.col_param, rows, cols, grid, nbr, w, peak, plateau, cur, rd: decimals(rows), cd: decimals(cols) };
  }
  // 目前參數的落點:穩健格本身優先於尖峰(兩者同格時不是風險),再看是否在 plateau 的鄰域內
  function robWhere(sc) {
    const c = sc.cur;
    if (sc.stale) return "stale";
    if (!c || c.i === null) return "outscan";
    if (c.i === sc.plateau.i && c.j === sc.plateau.j) return "inside";
    if (c.i === sc.peak.i && c.j === sc.peak.j) return "peak";
    if (Math.abs(c.i - sc.plateau.i) <= sc.w && Math.abs(c.j - sc.plateau.j) <= sc.w) return "inside";
    return "outside";
  }
  /* 「已送出」的簽章:只認掃描結果 / 程式碼 / 明確回測(stats.json 的 Generated At)三者——
   * 不拿整份 stats,live 策略每根 K 重寫績效指標,整份會逐根變、剛送出就解鎖 */
  function sentSig(data) {
    const st = data.stats && typeof data.stats === "object" ? data.stats : null;
    return JSON.stringify([data.scan, data.code, st ? st["Generated At"] : null]);
  }

  // ---------------------------------------------------------------- 格式

  function pv(v, d) {
    const s = String(v);
    if (s.indexOf("e") >= 0) return s.replace("-", MINUS);   // 科學記號:toFixed 會印成一串 0
    return (v < 0 ? MINUS : "") + Math.abs(v).toFixed(d);
  }
  function pair(sc, i, j) { return pv(sc.rows[i], sc.rd) + " / " + pv(sc.cols[j], sc.cd); }
  function f2(v) {
    if (!isNum(v)) return DASH;
    const s = Math.abs(v).toFixed(2);
    return (v < 0 && Number(s) !== 0 ? MINUS : "") + s;
  }
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  // 樣板裡的 {數字} 包進 .mono——數字與漢字不共用字體(雲端 fillTpl 同做法)
  function fillMono(node, tpl, vars) {
    String(tpl).split(/(\{\w+\})/).forEach((part) => {
      const m = /^\{(\w+)\}$/.exec(part);
      if (m && m[1] in vars) node.appendChild(el("span", "mono", vars[m[1]]));
      else if (part) node.appendChild(document.createTextNode(part));
    });
    return node;
  }
  function token(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  // 熱圖格的淡色階:token 沒有紅綠的淡階,用 token 色 + alpha 現算(report-backtest 月熱圖同做法)
  function rgbaToken(name, a) {
    const h = token(name).replace("#", "");
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return "";
    const v = parseInt(h, 16);
    return "rgba(" + ((v >> 16) & 255) + "," + ((v >> 8) & 255) + "," + (v & 255) + "," + a + ")";
  }
  function heatBg(v) {
    const a = Math.abs(v);
    const step = a < ROB_STEPS[0] ? 0 : a < ROB_STEPS[1] ? 1 : a < ROB_STEPS[2] ? 2 : 3;
    return rgbaToken(v < 0 ? "--color-red" : "--color-green", ROB_ALPHA[step]);
  }
  // ▲ / ● 是 CSS 幾何(.rob-glyph),不是 Unicode:Roboto Mono 沒有這兩個字,fallback 字型寬高基線都對不齊
  function glyph(kind) {
    const g = el("span", "rob-glyph " + kind);
    g.setAttribute("aria-hidden", "true");
    return g;
  }
  /* tooltip:一顆 body 層級的 fixed 單例(材質是 app.css 的 .tip,只改定位)。熱圖格與比較表欄頭共用——
   * 格子 overflow:hidden、比較表 overflow-x:auto(288 寬要能橫捲)都會裁掉行內氣泡。hover 與鍵盤 focus 都開;leave / blur / Esc 收 */
  let tipEl = null;
  function tipBox() {
    if (tipEl) return tipEl;
    tipEl = el("div", "tip rob-tip");
    tipEl.id = "rob-tip";
    tipEl.setAttribute("role", "tooltip");
    tipEl.setAttribute("aria-hidden", "true");
    document.body.appendChild(tipEl);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideTip(); });
    return tipEl;
  }
  // 錨點下方 6px、不探出視窗右緣;fill(tip) 負責放內容
  function showTip(anchor, fill) {
    const tip = tipBox();
    tip.textContent = "";
    fill(tip);
    const r = anchor.getBoundingClientRect();
    tip.style.left = Math.max(0, Math.min(r.left, window.innerWidth - 272)) + "px";
    tip.style.top = r.bottom + 6 + "px";
    tip.classList.add("is-on");
    tip.setAttribute("aria-hidden", "false");
  }
  function hideTip() {
    if (!tipEl) return;
    tipEl.classList.remove("is-on");
    tipEl.setAttribute("aria-hidden", "true");
    document.querySelectorAll(".rob-tbl td.is-hover").forEach((td) => td.classList.remove("is-hover"));
  }
  // 有說明的標籤:觸發點用 app.css 的 .mp-tip 樣式(點線底線),泡泡走上面的單例;內容鏡射在 aria-describedby 指到的單例上
  function tipLabel(text, tip) {
    const btn = el("button", "mp-tip", text);
    btn.type = "button";
    btn.setAttribute("aria-describedby", "rob-tip");
    const open = () => showTip(btn, (box) => { box.textContent = tip; });
    btn.addEventListener("mouseenter", open);
    btn.addEventListener("focus", open);
    btn.addEventListener("mouseleave", hideTip);
    btn.addEventListener("blur", hideTip);
    return btn;
  }

  // ---------------------------------------------------------------- 1. meta

  function buildMeta(stats, sc, opts) {
    let meta = null;
    try { meta = typeof opts.buildMeta === "function" ? opts.buildMeta(stats) : null; } catch (e) { console.warn("[robust]", e); }
    if (!meta) meta = el("div", "bt-meta rob-meta");
    if (meta.childNodes.length) {
      const sep = el("span", "bt-sep", "·");
      sep.setAttribute("aria-hidden", "true");
      meta.appendChild(sep);
    }
    const group = el("span", "bt-mpart");
    group.append(el("span", "", opts.t("rob.metaScan")), el("span", "mono", sc.rows.length + "×" + sc.cols.length));
    meta.appendChild(group);
    return meta;
  }

  // ---------------------------------------------------------------- 2. 結論卡

  /* 狀態 tag 說「在哪」、結論句只說「所以呢」,兩者不重複主詞。「就是穩健格」與「穩健區內」分開——
   * 共用句會變成拿自己跟自己比。只有尖峰上才上風險色,其餘落點是陳述 */
  function buildCard(sc, t) {
    const card = el("div", "rob-card");
    const where = robWhere(sc), pk = sc.peak, pl = sc.plateau;
    const atPlateau = !sc.stale && !!sc.cur && sc.cur.i === pl.i && sc.cur.j === pl.j;
    const TAG = atPlateau ? ["is-neutral", t("rob.tag.atPlateau")] : {
      peak: ["is-risk", t("rob.tag.peak")],
      inside: ["is-neutral", t("rob.tag.inside")],
      outside: ["is-neutral", t("rob.tag.outside")],
      outscan: ["is-neutral", t("rob.tag.outscan")],
    }[where];
    const status = el("div", "rob-status");
    if (TAG) status.appendChild(el("span", "rob-tag " + TAG[0], TAG[1]));   // 過時態沒有落點可標
    card.appendChild(status);
    card.appendChild(el("p", "rob-verdict", atPlateau ? t("rob.verdict.atPlateau") : {
      peak: t("rob.verdict.peak"),
      inside: t("rob.verdict.inside"),
      outside: t("rob.verdict.outside"),
      outscan: t("rob.verdict.outscan"),
      stale: t("rob.verdict.stale"),
    }[where]));

    // 候選比較表:一列一候選、一欄一指標;「目前」列只在它不是上面某一列時出現
    const tbl = el("table", "rob-cmp-tbl");
    const thead = el("thead"), hr = el("tr");
    hr.appendChild(el("th"));
    hr.appendChild(el("th", "prm mono", sc.rowParam + " / " + sc.colParam));
    hr.appendChild(el("th", null, t("rob.cmp.sharpe")));
    const thN = el("th");
    thN.appendChild(tipLabel(t("rob.cmp.nbr"), t("rob.cmp.nbrTip", { k: String(2 * sc.w + 1) })));
    hr.appendChild(thN);
    thead.appendChild(hr);
    tbl.appendChild(thead);
    const tbody = el("tbody");
    function row(kind, name, prm, a, b) {
      const tr = el("tr");
      const who = el("span", "who");
      if (kind) who.appendChild(glyph(kind));
      who.appendChild(document.createTextNode(name));
      const td0 = el("td");
      td0.appendChild(who);
      tr.appendChild(td0);
      tr.appendChild(el("td", "num prm mono", prm));
      [a, b].forEach((v) => { const s = f2(v); tr.appendChild(el("td", "num mono" + (s === DASH ? " na" : ""), s)); });
      return tr;
    }
    tbody.appendChild(row("peak", t("rob.cmp.peak"), pair(sc, pk.i, pk.j), sc.grid[pk.i][pk.j], sc.nbr[pk.i][pk.j]));
    tbody.appendChild(row("plateau", t("rob.cmp.plateau"), pair(sc, pl.i, pl.j), sc.grid[pl.i][pl.j], sc.nbr[pl.i][pl.j]));
    if (sc.cur && !atPlateau && where !== "peak") {
      const c = sc.cur;
      if (c.i === null) tbody.appendChild(row(null, t("rob.cmp.cur"), pv(c.vals[0], sc.rd) + " / " + pv(c.vals[1], sc.cd), null, null));
      else tbody.appendChild(row(null, t("rob.cmp.cur"), pair(sc, c.i, c.j), sc.grid[c.i][c.j], sc.nbr[c.i][c.j]));
    }
    tbl.appendChild(tbody);
    const cmp = el("div", "rob-cmp");
    cmp.appendChild(tbl);
    card.appendChild(cmp);
    return card;
  }

  // ---------------------------------------------------------------- 3. 熱圖

  // 真 <table>(th scope):原始 Sharpe / 鄰域平均切換、▲ 尖峰 ● 穩健、目前參數(虛線框)、tooltip、legend
  function buildHeat(sc, t) {
    const wrap = el("div", "rob-heat");
    const head = el("div", "rob-heat-head");
    const label = el("div", "bt-label rob-heat-label", t("rob.heatRaw"));
    head.appendChild(label);
    const seg = el("div", "rob-seg");
    seg.setAttribute("role", "group");
    seg.setAttribute("aria-label", t("rob.segLabel"));
    const bRaw = el("button", null, t("rob.segRaw")), bNbr = el("button", null, t("rob.segNbr"));
    bRaw.type = bNbr.type = "button";
    bRaw.setAttribute("aria-pressed", "true");
    bNbr.setAttribute("aria-pressed", "false");
    seg.append(bRaw, bNbr);
    head.appendChild(seg);
    wrap.appendChild(head);

    const frame = el("div", "rob-frame");
    const tbl = el("table", "rob-tbl");
    tbl.setAttribute("aria-label", t("rob.heatAria", { rp: sc.rowParam, cp: sc.colParam }));
    // 每欄 52px 的可讀下限放在 table 的 min-width(同 .bt-heat):欄數多才撐過 frame 橫捲,不縮字。
    // fixed layout 先扣掉 border-spacing 再分欄:角落欄 + cols 共 cols+1 欄,spacing 是 cols+2 個
    tbl.style.minWidth = Math.max(340, 84 + sc.cols.length * 52 + (sc.cols.length + 2) * 4) + "px";
    const thead = el("thead"), hr = el("tr");
    const corner = el("th", "corner");
    corner.append(el("span", "r mono", sc.rowParam + " ↓"), el("span", "mono", sc.colParam + " →"));
    hr.appendChild(corner);
    sc.cols.forEach((c) => { const th = el("th", null, pv(c, sc.cd)); th.scope = "col"; hr.appendChild(th); });
    thead.appendChild(hr);
    tbl.appendChild(thead);

    const ROLE = { peak: t("rob.role.peak"), plateau: t("rob.role.plateau"), cur: t("rob.role.cur") };
    const cells = [];
    const tbody = el("tbody");
    sc.rows.forEach((r, i) => {
      const tr = el("tr");
      const th = el("th", null, pv(r, sc.rd));
      th.scope = "row";
      tr.appendChild(th);
      sc.cols.forEach((c, j) => {
        const td = el("td");
        const isPk = i === sc.peak.i && j === sc.peak.j, isPl = i === sc.plateau.i && j === sc.plateau.j;
        const isCur = !!sc.cur && i === sc.cur.i && j === sc.cur.j;
        if (isCur) td.classList.add("is-current");
        const roles = [];
        if (isPk) roles.push(ROLE.peak);
        if (isPl) roles.push(ROLE.plateau);
        if (isCur) roles.push(ROLE.cur);
        td.dataset.i = i; td.dataset.j = j;
        td.dataset.roles = roles.join(" · ");
        td.dataset.glyph = isPl ? "plateau" : isPk ? "peak" : "";
        const raw = sc.grid[i][j];
        const val = raw === null ? t("rob.tipNa") : t("rob.tipSharpe", { s: f2(raw), n: f2(sc.nbr[i][j]) });
        td.setAttribute("aria-label", sc.rowParam + " " + pv(r, sc.rd) + " · " + sc.colParam + " " + pv(c, sc.cd) + ": " + val + (roles.length ? "(" + roles.join(" · ") + ")" : ""));
        if (roles.length) td.tabIndex = 0;
        tr.appendChild(td);
        cells.push(td);
      });
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    frame.appendChild(tbl);
    wrap.appendChild(frame);

    const legend = el("div", "rob-legend");
    function item(sw, frag) {
      const it = el("span", "it");
      if (sw) it.appendChild(sw);
      it.appendChild(frag);
      return it;
    }
    function sw(kind, dash) {
      const s = el("span", "rob-sw" + (dash ? " dash" : ""));   // 不叫 .sw:app.css 的 toggle 開關用掉了
      if (kind) s.appendChild(glyph(kind));
      return s;
    }
    legend.appendChild(item(sw("peak"), fillMono(el("span"), t("rob.legend.peak"), { prm: pair(sc, sc.peak.i, sc.peak.j) })));
    legend.appendChild(item(sw("plateau"), fillMono(el("span"), t("rob.legend.plateau"), { prm: pair(sc, sc.plateau.i, sc.plateau.j) })));
    if (sc.cur && sc.cur.i !== null) {
      const c = sc.cur;
      if (c.i === sc.plateau.i && c.j === sc.plateau.j) legend.appendChild(item(sw("plateau", true), document.createTextNode(t("rob.legend.curPlateau"))));
      else legend.appendChild(item(sw(null, true), document.createTextNode(c.i === sc.peak.i && c.j === sc.peak.j ? t("rob.legend.curPeak") : t("rob.legend.cur"))));
    } else if (sc.cur) {
      legend.appendChild(item(null, fillMono(el("span"), t("rob.legend.curOff"), { prm: pv(sc.cur.vals[0], sc.rd) + " / " + pv(sc.cur.vals[1], sc.cd) })));
    }
    legend.appendChild(item(null, document.createTextNode(t("rob.legend.na"))));
    wrap.appendChild(legend);

    // 切到鄰域平均:值換 nbr、色階重算、標記不動——find_plateau 的可視化(尖峰格掉下去、平原留下)
    function paint(mode) {
      cells.forEach((td) => {
        const v = (mode === "nbr" ? sc.nbr : sc.grid)[+td.dataset.i][+td.dataset.j];
        td.classList.remove("is-na");
        td.textContent = "";
        td.style.background = "";
        if (v === null) { td.classList.add("is-na"); td.textContent = DASH; return; }
        td.style.background = heatBg(v);
        if (td.dataset.glyph) td.appendChild(glyph(td.dataset.glyph));
        td.appendChild(document.createTextNode(f2(v)));
      });
    }
    paint("raw");
    function setMode(mode) {
      bRaw.setAttribute("aria-pressed", mode === "raw" ? "true" : "false");
      bNbr.setAttribute("aria-pressed", mode === "nbr" ? "true" : "false");
      label.textContent = "";
      if (mode === "raw") label.textContent = t("rob.heatRaw");
      else fillMono(label, t("rob.heatNbr"), { k: String(2 * sc.w + 1) });
      paint(mode);
    }
    bRaw.addEventListener("click", () => setMode("raw"));
    bNbr.addEventListener("click", () => setMode("nbr"));

    // tooltip 內容鏡射在 aria-label;事件委派在 tbody(大掃描上千格,不逐格綁)
    function show(td) {
      const i = +td.dataset.i, j = +td.dataset.j, raw = sc.grid[i][j];
      showTip(td, (tip) => {
        const l1 = el("div");
        l1.append(el("span", "mono", sc.rowParam + " " + pv(sc.rows[i], sc.rd)), el("span", "tl", " · "), el("span", "mono", sc.colParam + " " + pv(sc.cols[j], sc.cd)));
        tip.appendChild(l1);
        const l2 = el("div");
        if (raw === null) l2.textContent = t("rob.tipNa");
        else fillMono(l2, t("rob.tipSharpe"), { s: f2(raw), n: f2(sc.nbr[i][j]) });
        tip.appendChild(l2);
        if (td.dataset.roles) tip.appendChild(el("div", "", td.dataset.roles));   // 吃 .tip 預設 --ink-2:--ink-3 壓 --surface-muted 不過 AA(設計師複核 09-25)
      });
      td.classList.add("is-hover");
    }
    function cellOf(e) {
      const td = e.target && e.target.closest ? e.target.closest("td") : null;
      return td && tbody.contains(td) ? td : null;
    }
    tbody.addEventListener("mouseover", (e) => { const td = cellOf(e); if (td && !td.classList.contains("is-hover")) show(td); });
    tbody.addEventListener("mouseout", (e) => { const td = cellOf(e); if (td && !(e.relatedTarget && td.contains(e.relatedTarget))) hideTip(); });
    tbody.addEventListener("focusin", (e) => { const td = cellOf(e); if (td) show(td); });
    tbody.addEventListener("focusout", hideTip);
    return { node: wrap, frame };
  }
  /* 欄數多到 frame 橫捲時,把有標記的格帶進可視範圍(第一個標記靠著釘住的列標,右邊的標記放得下就一起進來);
   * 不縮格、不加漸層——半切的格就是「還能往右捲」的提示。要等進了 DOM 才量得到 */
  function scrollMarksIntoView(frame) {
    const marks = frame.querySelectorAll("td[tabindex]");
    if (!marks.length || !frame.clientWidth) return;
    const f = frame.getBoundingClientRect();
    let lo = Infinity, hi = 0;
    marks.forEach((td) => {
      const r = td.getBoundingClientRect();
      lo = Math.min(lo, r.left - f.left + frame.scrollLeft);
      hi = Math.max(hi, r.right - f.left + frame.scrollLeft);
    });
    if (hi <= frame.clientWidth) return;
    const pitch = (() => { const c = frame.querySelectorAll("tbody tr:first-child td"); return c.length > 1 ? c[1].getBoundingClientRect().left - c[0].getBoundingClientRect().left : 0; })();
    let want = Math.max(0, Math.min(lo - 84 - 24, hi - frame.clientWidth + 16));   // 84 = 釘住的列標欄、24 = 它的間距 + frame 內距
    if (pitch > 0) want = Math.floor(want / pitch) * pitch;   // 對齊欄距:第一欄不要半切(設計師複核 09-25 建議 N4)
    frame.scrollLeft = want;
  }

  // ---------------------------------------------------------------- 4. 空狀態 + 掃描鈕

  /* scope:name → { sig, turn }(送出當下的 sentSig 與那一回合的序號)。鈕維持「已送出」的條件:回合還在跑、
   * 而且就是送出的那一回合、而且掃描結果 / 程式碼 / 明確回測沒變——三者缺一就回「開始掃描」:新結果到了 sig 變;
   * 掃描回合結束沒產出、之後任何無關回合開始時 turn 對不上;scope 讓本機 / 雲端的同名策略不互相污染 */
  const sent = new Map();
  const shown = new WeakMap();   // container → 這一次畫的空狀態(robSync 就地改鈕、onScan 回來時對一下容器沒換成別支)
  const sentKey = (opts, name) => (opts.scope || "") + ":" + name;

  // 就地把鈕與那一行說明對到現在的回合狀態;不重建節點(焦點留在鈕上)
  function syncEmpty(st, opts) {
    const s = sent.get(sentKey(opts, st.name));
    const isSent = !!opts.busy && !!s && s.sig === st.sig && s.turn === opts.turn;
    st.btn.disabled = !!opts.busy;
    st.btn.textContent = opts.t(isSent ? "rob.btnSent" : "rob.btnScan");
    const wantCap = !!opts.busy && !isSent;   // 回合進行中 submit 會直接回 false,按了沒反應像壞掉:鎖鈕 + 一行說明
    if (wantCap && !st.cap) { st.cap = el("p", "rob-cap", opts.t("rob.busy")); st.box.appendChild(st.cap); }
    else if (!wantCap && st.cap) { st.cap.remove(); st.cap = null; }
  }
  function renderEmpty(el0, data, sig, opts) {
    const box = el("div", "rob-empty");
    box.appendChild(el("p", "rob-empty-txt", opts.t("rob.empty")));
    const btn = el("button", "btn-fill");
    btn.type = "button";
    box.appendChild(btn);
    const st = { name: data.name, sig, box, btn, cap: null };
    btn.addEventListener("click", () => {
      if (typeof opts.onScan !== "function") return;
      Promise.resolve(opts.onScan(data.name, btn)).then((turn) => {
        if (!turn && turn !== 0) return;
        sent.set(sentKey(opts, data.name), { sig, turn });
        if (shown.get(el0) === st) syncEmpty(st, { ...opts, busy: true, turn });   // 送出成功 = 那一回合已開
      });
    });
    shown.set(el0, st);
    syncEmpty(st, opts);
    el0.textContent = "";
    el0.appendChild(box);
  }
  // 呼叫端在回合開始 / 結束時叫:空狀態就地換鈕態;有掃描結果的頁沒有鈕,什麼都不做
  function robSync(container, opts) {
    const st = shown.get(container);
    if (!st || !st.btn.isConnected) return;
    syncEmpty(st, opts || {});
  }

  // ---------------------------------------------------------------- 入口

  function renderRobust(container, data, opts) {
    opts = opts || {};
    if (typeof opts.t !== "function") opts.t = (k) => k;
    data = data && typeof data === "object" ? data : {};
    hideTip();
    shown.delete(container);
    container.textContent = "";
    const stats = data.stats && typeof data.stats === "object" ? data.stats : null;
    let sc = null;
    try { sc = sanitizeScan(data.scan, stats, data.code); } catch (e) { console.warn("[robust]", e); }
    if (!sc) { renderEmpty(container, data, sentSig(data), opts); return; }
    const root = el("div", "bt rob");
    let heat = null;
    // 每一塊各自 try:scan.json 是 agent 寫的,一塊壞掉不該拖垮整頁
    [() => buildMeta(stats, sc, opts), () => buildCard(sc, opts.t), () => { heat = buildHeat(sc, opts.t); return heat.node; }].forEach((fn) => {
      try { const node = fn(); if (node) root.appendChild(node); } catch (e) { console.warn("[robust]", e); }
    });
    container.appendChild(root);
    if (heat) try { scrollMarksIntoView(heat.frame); } catch (e) { console.warn("[robust]", e); }
  }

  window.BlaveReport = window.BlaveReport || {};
  window.BlaveReport.renderRobust = renderRobust;
  window.BlaveReport.robSync = robSync;
  // 純計算函式掛出來給核對腳本用(tests/check_shell_robust.js);畫面不靠這個
  window.BlaveReport._rob = { sanitizeScan, robWhere, constFromCode, locate, nbrMean, argmax, decimals, sentSig, pv, f2, ROB_MAX_DIM };
})();
