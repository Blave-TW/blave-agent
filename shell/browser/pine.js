// 「送進 TradingView」(spec .claude/output/designer/spec-desktop-pine-install-0.1.8.md):外殼自己在內建瀏覽器
// 開圖表 → 開 Pine 編輯器 → 開新腳本 → 貼上 → 讀回比對,停在「加到圖表」由用戶按。不經 agent、不花額度。
// 這裡永遠不按「加到圖表」、不按存檔、不碰登入;用戶操作時不讀頁面——只在他按「檢查結果」/「回傳回測結果」時讀一次。
// 元素定位走無障礙樹的 role + name(真站 2026-09-28 匿名實測:www / tw / cn 三種語言的名字)。
// 每次結果(成功或失敗)由 index.js 寫一行到本機 log(d.log):卡在哪一步、當時看到的候選元素 role / name——不含頁面內容、編輯器文字與網址路徑。
"use strict";
const IP = require("./inpage");

/* ── 純邏輯(tests/check_shell_pine_install.js)── */
const TV_CHART = "https://www.tradingview.com/chart/";
// interval= 實測生效的值;360 這類不在清單上的會被 TradingView 默默換成日線,所以不收
const TV_MINUTES = [1, 3, 5, 15, 30, 45, 60, 120, 180, 240];
// 對應表只收確定的:用 fetch_kline(Binance USDT-M 永續)而且代號是 …USDT。台股、台指期、其他交易所 → 不帶
function tvSymbol(job) {
  const s = job && typeof job.symbol === "string" ? job.symbol.trim().toUpperCase() : "";
  return job && job.cryptoKline === true && /^[A-Z0-9]{2,20}USDT$/.test(s) ? "BINANCE:" + s + ".P" : null;
}
function tvInterval(ivl) {
  const m = /^(\d{1,4})\s*(m|min|h|H|d|D|w|W)$/.exec(String(ivl || "").trim()); if (!m) return null;   // 大寫 M 是月線,不收
  const n = Number(m[1]), u = m[2].toLowerCase();
  if (!n) return null;
  if (u === "m" || u === "min" || u === "h") { const min = u === "h" ? n * 60 : n; return TV_MINUTES.includes(min) ? String(min) : null; }
  if (n !== 1) return null;
  return u === "d" ? "D" : "W";
}
// 商品對不上就整個不帶(猜錯商品比沒帶更糟);商品對得上、週期對不上只帶商品
function chartUrl(job) {
  const symbol = tvSymbol(job); if (!symbol) return { url: TV_CHART, symbol: null, interval: null };
  const interval = tvInterval(job.interval), u = new URL(TV_CHART);
  u.searchParams.set("symbol", symbol); if (interval) u.searchParams.set("interval", interval);
  return { url: u.href, symbol, interval };
}
const onTv = (url) => { try { const u = new URL(String(url)); return u.protocol === "https:" && /(^|\.)tradingview\.com$/i.test(u.hostname); } catch (_) { return false; } };

const NAMES = {
  pine: /^Pine$/,
  add: /^(Add to chart|新增到圖表|添加到图表)$/,
  createNew: /^(Create new|建立新的|创建新的)$/,
  strategy: /^(Strategy|策略)$/,
  untitled: /^(Untitled|未命名|无标题)/,   // 只認開頭:窄面板會把名字截短
  editor: /^Editor content/,
};
const SNAP_LINE = /^\s*- (\S+)(?: ("(?:[^"\\]|\\.)*"))? \[(@e\d+)\](.*)$/;
function parseSnap(text) {
  const out = [];
  for (const l of String(text || "").split("\n")) {
    const m = SNAP_LINE.exec(l); if (!m) continue;
    let name = ""; try { name = m[2] ? JSON.parse(m[2]) : ""; } catch (_) { name = ""; }
    out.push({ role: m[1], name, ref: m[3], rest: m[4] || "" });
  }
  return out;
}
const STATE_RE = /\b(collapsed|expanded)\b/;
/* 腳本名稱鈕沒有固定名字(就是用戶那支腳本的名字,窄面板還會截短):認 role + 展開狀態 + 位置——「加到圖表」往前三顆以內、帶展開狀態的 button */
function locate(nodes) {
  const by = (role, re) => nodes.find((n) => n.role === role && re.test(n.name)) || null;
  const add = by("button", NAMES.add), i = add ? nodes.indexOf(add) : -1;
  let title = null;
  for (let k = i - 1; k >= 0 && k >= i - 3 && !title; k--) if (nodes[k].role === "button" && STATE_RE.test(nodes[k].rest)) title = nodes[k];
  return {
    pine: by("button", NAMES.pine), add, editor: by("textbox", NAMES.editor), title,
    createNew: by("menuitem", NAMES.createNew), strategy: by("menuitem", NAMES.strategy),
  };
}
const lines = (s) => String(s == null ? "" : s).replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim());
/* 讀回比對:編輯器的輸入區只放游標所在那一頁(實測 10 行一頁),所以分兩次讀——貼完游標在文件尾(tail)、移到文件頭再讀一次(head)。
   第一行與最後一行逐字相符(含縮排)才算貼對;尾巴後面還有別的字 = 沒蓋掉原本的內容 */
function pasteOk(content, head, tail) {
  const want = lines(content), h = lines(head), t = lines(tail);
  if (!want.length || !h.length || !t.length) return false;
  return h[0] === want[0] && t[t.length - 1] === want[want.length - 1];
}
// strategy("名稱", …) 的名稱:檢查「圖上有沒有這支」時對圖例用
function pineTitle(content) {
  const m = /^\s*strategy\s*\(\s*(?:title\s*=\s*)?(["'])((?:(?!\1)[^\\\n]|\\.){1,120})\1/m.exec(String(content || ""));
  return m ? m[2].trim() : null;
}
/* 網頁來的字當資料、不當指令:剝控制字元與格式字元(零寬、bidi 覆寫)、壓空白、截長 */
function clean(s, max) {
  return String(s == null ? "" : s).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, " ").replace(/\p{Cf}/gu, "").replace(/\s+/g, " ").trim().slice(0, max);
}
/* 失敗時記下來的候選元素:只有 role、名字前 80 字、狀態。欄位的值(編輯器文字)與連結網址不記 */
function candidates(nodes) {
  const list = Array.isArray(nodes) ? nodes : [], i = list.findIndex((n) => n.role === "button" && NAMES.add.test(n.name));
  return list.filter((n, k) => n.role === "menuitem" || n.role === "textbox" || (n.role === "button" && (STATE_RE.test(n.rest) || NAMES.pine.test(n.name)))
    || (i >= 0 && Math.abs(k - i) <= 4) || (n.role === "button" && k >= list.length - 6))
    .slice(0, 30).map((n) => { const st = /\b(collapsed|expanded|disabled)\b/.exec(n.rest); return { role: n.role, name: clean(n.name, 80), state: st ? st[1] : "" }; });
}
const ERR_RE = /\berrors?\b|錯誤|错误/i;
function errLines(rows) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || !(r.err === true || ERR_RE.test(String(r.text || "")))) continue;
    const l = clean(r.text, 200); if (l && !out.includes(l)) out.push(l);
  }
  return out.slice(-5);   // 最新的五行
}
function statRows(stats) {
  const out = [], seen = new Set();
  for (const s of Array.isArray(stats) ? stats : []) {
    const label = clean(s && s.label, 120), value = clean(s && s.value, 120);
    if (!label || !value || seen.has(label)) continue;
    seen.add(label); out.push({ label, value }); if (out.length >= 40) break;
  }
  return out;
}
/* 讀到的東西 → 狀態。圖上有策略(測試器有數字、或圖例裡有這支)優先於主控台裡的舊錯誤 */
function classify(raw, title) {
  const stats = statRows(raw && raw.stats), errors = errLines(raw && raw.logs);
  const legend = (raw && Array.isArray(raw.legend) ? raw.legend : []).map((l) => clean(l, 200));
  const onChart = stats.length > 0 || (!!title && legend.some((l) => l.includes(title)));
  return { state: onChart ? "done" : errors.length ? "compile" : "notyet", stats, errors: onChart ? [] : errors };
}
/* ── 純邏輯到此 ── */

/* 送進頁面跑的函式(以 toString 送,自含)。
   測試器的數字格照 web 擴充套件的讀法(class 前綴 containerCell-:每格 label 在前、value 在後;值是空的 = 不在畫面上,不送);
   Pine 主控台是編輯器下方那張表(class 前綴 consoleWrapper-,一列 = 時間 + 訊息)。只讀摘要,不讀逐筆成交 */
function readTv() {
  const T = (x) => String(x == null ? "" : x).replace(/\s+/g, " ").trim();
  const stats = [];
  for (const c of Array.from(document.querySelectorAll('[class*="containerCell-"]')).slice(0, 200)) {
    const k = c.children, label = T(k[0] && k[0].innerText).slice(0, 200), value = T(k[1] && k[1].innerText).slice(0, 200);
    if (label && value) stats.push({ label, value });
  }
  const logs = Array.from(document.querySelectorAll('[class*="consoleWrapper-"] tr, [role="log"] > *')).slice(-60)
    .map((r) => ({ text: T(r.innerText || r.textContent).slice(0, 400), err: /error/i.test(String(r.className && r.className.baseVal !== undefined ? r.className.baseVal : r.className)) }))
    .filter((r) => r.text);
  const legend = Array.from(document.querySelectorAll('[data-qa-id="legend-source-item"]')).slice(0, 20).map((e) => T(e.innerText).slice(0, 200));
  return { stats: stats.slice(0, 80), logs, legend };
}
// 視窗不在前景時真滑鼠送不進去,直接 click() 打不開靠 hover 展開的子選單:補一組 hover 事件
function hoverEl() {
  const r = this.getBoundingClientRect(), o = { bubbles: true, cancelable: true, clientX: r.left + 8, clientY: r.top + 4, view: window };
  for (const t of ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"]) this.dispatchEvent(new (t.indexOf("pointer") === 0 ? PointerEvent : MouseEvent)(t, o));
  return true;
}
/* 「Create new」之後跳出來的確認框(目前的腳本有未存的變更;真站 2026-09-28 匿名實測:data-name="warning-dialog",沒有 role)。
   warn = 那一種;other = 別的對話框(只記進診斷) */
function dialogUp() {
  const on = (sel) => Array.from(document.querySelectorAll(sel)).some((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  return on('[data-name="warning-dialog"]') ? "warn" : on('[role="dialog"], [data-dialog-name]') ? "other" : null;
}
function fieldValue() { return String(this.value == null ? "" : this.value).slice(0, 20000); }

const STOP = new Error("interrupted"), OFF = new Error("off_site");
// 每一步的上限。GRACE:登入態的版面會自己把編輯器開回來(比 Pine 鈕晚出現),先等這麼久,真的沒開才按;STEP2:「正在開 Pine 編輯器」整段的上限
const LOAD_MS = 20000, SYMBOL_MS = 6000, FIND_MS = 6000, GRACE_MS = 1500, OPEN_MS = 8000, MENU_MS = 3000, NEW_MS = 6000, STEP2_MS = 15000;

/**
 * d: { open(url) → { tab } | { error } | { blocked }, tab(id), view(id), waitLoaded(t, ms), visible(t, v) → Promise<bool>,
 *      input(v, fn), arm(t) → Promise<bool>, disarm(t), emit(type, payload), sensitive(desc), enabled(), lang(), reduced(), sleep(ms), log(entry)? }
 * 事件:pine_open(下一個 user 分頁是這條流程開的)、pine_step { id, step: 1|2|3, sym }、pine_result { id, state, … }
 */
function createPine(d) {
  const runs = new Map();   // 分頁 id → { strategy, filename, title }(只在記憶體:重開 app 不記,spec Q6)
  let busy = false;
  const sleep = d.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let x = null;   // 這一次流程的診斷:{ t0, step, nodes(最後一次看到的), dialog, end(這一步的期限) }
  const snap = async (v) => { const s = await v.page.snapshot({ interactive_only: true }, d.sensitive); const n = parseSnap(s && s.text); if (x) x.nodes = n; return n; };
  const mark = (v, args) => v.page.run(IP.mark, args).catch(() => {});
  async function until(fn, ms, every) {
    const end = Math.min(Date.now() + ms, x && x.end ? x.end : Infinity);
    for (;;) { const r = await fn(); if (r) return r; if (Date.now() >= end) return null; await sleep(every || 400); }
  }
  // 每次動手前:用戶在頁面上動手了就讓開;流程中途被導到別的站(登入轉址、頁面自己跳走)就停,不點、不貼
  const guardSite = (t, v) => { if (t.userControl) throw STOP; if (!onTv(v.wc.getURL())) throw OFF; };
  async function click(t, v, node, hover) {
    guardSite(t, v);
    const b = v.page.node(node.ref); if (b === null) return false;
    const on = await d.visible(t, v);
    let pos; try { pos = await v.page.center(b, on); } catch (_) { return false; }
    if (!pos || pos.error) return false;
    // 動手的是外殼不是 agent:只畫目標外框與點擊環,不畫 agent 游標(spec §3)
    if (on) await mark(v, ["ref", { box: pos.box, label: "", tag: false }, d.reduced()]);
    if (!(await d.arm(t))) return false;
    const c = await d.input(v, () => v.page.click(b, pos, 0));
    if (c && c.error) { await d.disarm(t); await mark(v, ["clear"]); return false; }
    if (on) await mark(v, ["click", { x: pos.x, y: pos.y, instant: false }, d.reduced()]);
    if (hover && !on) await v.page.callOn(b, hoverEl).catch(() => {});
    return true;
  }
  const value = (v, node) => { const b = v.page.node(node.ref); return b === null ? Promise.resolve("") : v.page.callOn(b, fieldValue).catch(() => ""); };

  async function flow(job, t, v, target) {
    const step = (n) => { x.step = n; d.emit("pine_step", { id: t.id, step: n, sym: target.symbol ? target.symbol.replace(/^BINANCE:/, "") : null }); };
    step(1);
    await d.waitLoaded(t, LOAD_MS);
    if (t.status !== "ready" || !onTv(v.wc.getURL())) return { state: "fail" };
    // 商品有沒有真的帶到:分頁標題是「代號 價格 …」;不存在的代號 TradingView 照樣顯示代號但沒有價格
    let symbolOk = false;
    if (target.symbol) {
      const sym = target.symbol.replace(/^BINANCE:/, "");
      symbolOk = !!(await until(() => { const ti = String(v.wc.getTitle() || ""); return ti.indexOf(sym + " ") === 0 && /\d/.test(ti.slice(sym.length)); }, SYMBOL_MS));
    }
    const set = symbolOk && !!target.interval;

    step(2); x.end = Date.now() + STEP2_MS;
    const look = async () => locate(await snap(v));
    const ready = (l) => (l.add && l.editor && l.title ? l : null), some = (l) => (l.add || l.editor ? l : null);
    let loc = await until(async () => { const l = await look(); return l.pine || some(l) ? l : null; }, FIND_MS);
    if (!loc) return { state: "nf", why: "pine_button" };
    if (!ready(loc)) {
      // 面板已經在(或正在自己開回來)就只等、不按:Pine 那顆鈕這時被面板蓋住,按了也不是「打開」
      const panel = some(loc) || await until(async () => some(await look()), GRACE_MS);
      if (!panel && (!loc.pine || !(await click(t, v, loc.pine)))) return { state: "nf", why: "pine_button" };
      let last = panel || loc;
      loc = ready(last) || await until(async () => ready(last = await look()), OPEN_MS);
      if (!loc) return { state: "nf", why: last.add && last.editor ? "title" : "editor" };
    }
    // 開新腳本再貼:不蓋用戶原本那一支。開不出來就停
    const before = { name: loc.title.name, node: v.page.node(loc.editor.ref), value: await value(v, loc.editor) };
    let m = loc.createNew ? loc : null;   // 選單本來就開著:不按名稱鈕(那顆也是開合)
    if (!m) {
      if (!(await click(t, v, loc.title))) return { state: "nf", why: "title" };
      m = await until(async () => { const l = await look(); return l.createNew ? l : null; }, MENU_MS);
      if (!m) return { state: "nf", why: "create_new" };
    }
    if (!m.strategy) {
      if (!(await click(t, v, m.createNew, true))) return { state: "nf", why: "create_new" };
      m = await until(async () => { const l = await look(); return l.strategy ? l : null; }, MENU_MS);
      if (!m) return { state: "nf", why: "submenu" };
    }
    if (!(await click(t, v, m.strategy))) return { state: "nf", why: "strategy" };
    let val = "";
    loc = await until(async () => {
      // 目前的腳本有未存的變更 → TradingView 跳確認框。存檔或放棄是用戶的決定:不按,交給他
      x.dialog = await v.page.run(dialogUp).catch(() => null);
      if (x.dialog === "warn") { await look().catch(() => {}); return { unsaved: true }; }   // 再看一次只為了診斷(記下框上的鈕)
      const l = ready(await look()); if (!l || l.createNew || !NAMES.untitled.test(l.title.name)) return null;
      val = await value(v, l.editor);
      return v.page.node(l.editor.ref) !== before.node || val !== before.value || l.title.name !== before.name ? l : null;
    }, NEW_MS);
    if (loc && loc.unsaved) return { state: "needs_user", why: "unsaved" };
    if (!loc) return { state: "nf", why: "new_script" };

    step(3); x.end = 0;
    guardSite(t, v);
    // 全選與貼上都要真鍵盤:頁面不在畫面上(視窗被蓋住、縮小)時送不進去,不硬貼
    if (!(await d.visible(t, v))) return { state: "fail", why: "hidden" };
    const b = v.page.node(loc.editor.ref); if (b === null) return { state: "nf", why: "editor" };
    let desc; try { desc = await v.page.describe(b); } catch (_) { return { state: "nf", why: "editor" }; }
    if (!(await d.arm(t))) return { state: "fail", why: "guard" };
    guardSite(t, v);
    const f = await d.input(v, () => v.page.fill(b, job.content, desc, { clear: true, perChar: false }));
    if (f && f.error) return { state: "nf", why: "paste" };
    await sleep(300);
    const tail = await value(v, loc.editor);
    const top = process.platform === "darwin" ? ["ArrowUp", 4] : ["Home", 2];   // Monaco 的「到文件開頭」:mac 是 Cmd+↑,其餘 Ctrl+Home
    await d.input(v, () => v.page.press(top[0], true, top[1])).catch(() => {});
    await sleep(300);
    const head = await value(v, loc.editor);
    if (!pasteOk(job.content, head, tail)) return { state: "nf", why: "readback" };

    // 交接:「加到圖表」掛「由你按」,外殼到此為止
    await mark(v, ["clear"]);
    if (t.visible) {
      const l = locate(await snap(v)), ab = l.add ? v.page.node(l.add.ref) : null;
      if (ab !== null) { try { const p = await v.page.center(ab, false); if (p && !p.error) await mark(v, ["need", { box: p.box, label: d.lang() === "zh" ? "由你按" : "Your turn" }]); } catch (_) { /* 框不到就不框 */ } }
    }
    return { state: "handover", set };
  }

  // 網址只記主機名與「是不是用戶存過的版面」:版面代號跟著帳號,不寫進 log
  function logEntry(res, v) {
    let host = "", layout = false;
    try { const u = new URL(String(v.wc.getURL())); host = u.hostname; layout = /^\/chart\/[^/]+\//.test(u.pathname); } catch (_) { /* 分頁沒開成 */ }
    return { ts: new Date().toISOString(), state: res.state, why: res.why || null, step: res.diag.step, ms: res.diag.ms, host, layout, dialog: res.diag.dialog, seen: res.diag.seen };
  }

  /** job: { content, strategy, filename, symbol, interval, cryptoKline } */
  async function install(job) {
    if (!d.enabled()) return { state: "off" };
    if (busy) return { state: "busy" };
    if (!job || typeof job.content !== "string" || !job.content.trim()) return { state: "fail", why: "no_file" };
    busy = true;
    let t = null, v = null, out;
    x = { t0: Date.now(), step: 0, nodes: [], dialog: null, end: 0 };
    try {
      const target = chartUrl(job);
      d.emit("pine_open", {});
      const r = d.open(target.url);
      t = r && r.tab && !r.blocked && !r.error ? r.tab : null;
      v = t ? d.view(t.id) : null;
      if (!t || !v) out = { state: "fail", why: "open" };
      else {
        runs.set(t.id, { strategy: job.strategy, filename: job.filename, title: pineTitle(job.content) });
        if (runs.size > 8) runs.delete(runs.keys().next().value);
        out = await flow(job, t, v, target);
      }
    } catch (e) { out = { state: "fail", why: e === STOP ? "interrupted" : e === OFF ? "off_site" : "error" }; }
    finally { busy = false; if (t) await Promise.resolve(d.disarm(t)).catch(() => {}); }
    if (v && out.state !== "handover") await mark(v, ["clear"]);
    const res = Object.assign({ id: t ? t.id : null }, out);
    const ok = out.state === "handover";
    res.diag = { step: x.step, ms: Date.now() - x.t0, dialog: x.dialog, seen: ok ? [] : candidates(x.nodes) };
    if (d.log) try { d.log(logEntry(res, v)); } catch (_) { /* log 寫不進去不影響流程 */ }
    x = null;
    d.emit("pine_result", res);
    return res;
  }

  async function look(id) {
    const run = runs.get(String(id || "")), t = d.tab(String(id || "")), v = t ? d.view(t.id) : null;
    if (!run || !t || !v || (t.status !== "ready" && t.status !== "loading") || !onTv(v.wc.getURL())) return null;
    let raw; try { raw = await v.page.run(readTv); } catch (_) { return null; }
    return Object.assign({ filename: run.filename, strategy: run.strategy }, classify(raw, run.title));
  }
  /** 「檢查結果」:讀一次,回 done | compile | notyet | gone */
  async function check(id) {
    if (!d.enabled()) return { state: "off" };
    const r = await look(id);
    const res = r ? { id: String(id), state: r.state, errors: r.errors, filename: r.filename } : { id: String(id || ""), state: "gone" };
    d.emit("pine_result", res);
    return res;
  }
  /** 「回傳回測結果」:讀一次摘要數字。回 ok(帶 stats)| compile | closed | gone */
  async function read(id) {
    if (!d.enabled()) return { state: "off" };
    d.emit("pine_result", { id: String(id || ""), state: "reading" });
    const r = await look(id);
    const res = !r ? { id: String(id || ""), state: "gone" }
      : r.stats.length ? { id: String(id), state: "ok", stats: r.stats, filename: r.filename }
        : r.state === "compile" ? { id: String(id), state: "compile", errors: r.errors, filename: r.filename }
          : { id: String(id), state: "closed", filename: r.filename };
    d.emit("pine_result", res);
    return res;
  }
  return { install, check, read, busy: () => busy };
}

module.exports = { createPine, chartUrl, tvSymbol, tvInterval, parseSnap, locate, candidates, pasteOk, pineTitle, clean, errLines, statRows, classify, onTv, readTv, dialogUp, NAMES };
