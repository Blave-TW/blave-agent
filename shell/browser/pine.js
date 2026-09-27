// 「送進 TradingView」(spec .claude/output/designer/spec-desktop-pine-install-0.1.8.md):外殼自己在內建瀏覽器
// 開圖表 → 開 Pine 編輯器 → 開新腳本 → 貼上 → 讀回比對,停在「加到圖表」由用戶按。不經 agent、不花額度。
// 這裡永遠不按「加到圖表」、不按存檔、不碰登入;用戶操作時不讀頁面——只在他按「檢查結果」/「回傳回測結果」時讀一次。
// 元素定位走無障礙樹的 role + name(真站 2026-09-28 匿名實測:www / tw / cn 三種語言的名字)。
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
  untitled: /^(Untitled script|未命名腳本|无标题脚本)$/,
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
/* 腳本名稱鈕沒有固定名字(就是用戶那支腳本的名字):認位置——「加到圖表」前一顆、帶展開狀態的 button */
function locate(nodes) {
  const by = (role, re) => nodes.find((n) => n.role === role && re.test(n.name)) || null;
  const add = by("button", NAMES.add), i = add ? nodes.indexOf(add) : -1, prev = i > 0 ? nodes[i - 1] : null;
  return {
    pine: by("button", NAMES.pine), add, editor: by("textbox", NAMES.editor),
    title: prev && prev.role === "button" && /\b(collapsed|expanded)\b/.test(prev.rest) ? prev : null,
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
function fieldValue() { return String(this.value == null ? "" : this.value).slice(0, 20000); }

const STOP = new Error("interrupted");
const LOAD_MS = 25000, FIND_MS = 12000, MENU_MS = 4000, NEW_MS = 8000;

/**
 * d: { open(url) → { tab } | { error } | { blocked }, tab(id), view(id), waitLoaded(t, ms), visible(t, v) → Promise<bool>,
 *      input(v, fn), arm(t) → Promise<bool>, disarm(t), emit(type, payload), sensitive(desc), enabled(), lang(), reduced(), sleep(ms) }
 * 事件:pine_open(下一個 user 分頁是這條流程開的)、pine_step { id, step: 1|2|3, sym }、pine_result { id, state, … }
 */
function createPine(d) {
  const runs = new Map();   // 分頁 id → { strategy, filename, title }(只在記憶體:重開 app 不記,spec Q6)
  let busy = false;
  const sleep = d.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const snap = async (v) => { const s = await v.page.snapshot({ interactive_only: true }, d.sensitive); return parseSnap(s && s.text); };
  const mark = (v, args) => v.page.run(IP.mark, args).catch(() => {});
  async function until(fn, ms, every) {
    const end = Date.now() + ms;
    for (;;) { const r = await fn(); if (r) return r; if (Date.now() >= end) return null; await sleep(every || 400); }
  }
  async function click(t, v, node, hover) {
    if (t.userControl) throw STOP;   // 用戶在頁面上動手了:這條流程讓開
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
    const step = (n) => d.emit("pine_step", { id: t.id, step: n, sym: target.symbol ? target.symbol.replace(/^BINANCE:/, "") : null });
    step(1);
    await d.waitLoaded(t, LOAD_MS);
    if (t.status !== "ready" || !onTv(v.wc.getURL())) return { state: "fail" };
    // 商品有沒有真的帶到:分頁標題是「代號 價格 …」;不存在的代號 TradingView 照樣顯示代號但沒有價格
    let symbolOk = false;
    if (target.symbol) {
      const sym = target.symbol.replace(/^BINANCE:/, "");
      symbolOk = !!(await until(() => { const ti = String(v.wc.getTitle() || ""); return ti.indexOf(sym + " ") === 0 && /\d/.test(ti.slice(sym.length)); }, 8000));
    }
    const set = symbolOk && !!target.interval;

    step(2);
    let loc = await until(async () => { const l = locate(await snap(v)); return l.pine || l.add ? l : null; }, FIND_MS);
    if (!loc) return { state: "nf", why: "pine_button" };
    if (!loc.add || !loc.editor) {   // 編輯器還沒開(已經開著就不按:那顆鈕是開合)
      if (!(await click(t, v, loc.pine))) return { state: "nf", why: "pine_button" };
      loc = await until(async () => { const l = locate(await snap(v)); return l.add && l.editor && l.title ? l : null; }, FIND_MS);
      if (!loc) return { state: "nf", why: "editor" };
    }
    if (!loc.title) return { state: "nf", why: "title" };
    // 開新腳本再貼:不蓋用戶原本那一支。開不出來就停
    const before = { name: loc.title.name, node: v.page.node(loc.editor.ref), value: await value(v, loc.editor) };
    if (!(await click(t, v, loc.title))) return { state: "nf", why: "title" };
    let m = await until(async () => { const l = locate(await snap(v)); return l.createNew ? l : null; }, MENU_MS);
    if (!m) return { state: "nf", why: "create_new" };
    if (!m.strategy) {
      if (!(await click(t, v, m.createNew, true))) return { state: "nf", why: "create_new" };
      m = await until(async () => { const l = locate(await snap(v)); return l.strategy ? l : null; }, MENU_MS);
      if (!m) return { state: "nf", why: "create_new" };
    }
    if (!(await click(t, v, m.strategy))) return { state: "nf", why: "strategy" };
    let val = "";
    loc = await until(async () => {
      const l = locate(await snap(v)); if (!l.add || !l.editor || !l.title || !NAMES.untitled.test(l.title.name)) return null;
      val = await value(v, l.editor);
      return v.page.node(l.editor.ref) !== before.node || val !== before.value || l.title.name !== before.name ? l : null;
    }, NEW_MS);
    if (!loc) return { state: "nf", why: "new_script" };

    step(3);
    if (t.userControl) throw STOP;
    // 全選與貼上都要真鍵盤:頁面不在畫面上(視窗被蓋住、縮小)時送不進去,不硬貼
    if (!(await d.visible(t, v))) return { state: "fail", why: "hidden" };
    const b = v.page.node(loc.editor.ref); if (b === null) return { state: "nf", why: "editor" };
    let desc; try { desc = await v.page.describe(b); } catch (_) { return { state: "nf", why: "editor" }; }
    if (!(await d.arm(t))) return { state: "fail", why: "guard" };
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

  /** job: { content, strategy, filename, symbol, interval, cryptoKline } */
  async function install(job) {
    if (!d.enabled()) return { state: "off" };
    if (busy) return { state: "busy" };
    if (!job || typeof job.content !== "string" || !job.content.trim()) return { state: "fail", why: "no_file" };
    busy = true;
    let t = null, v = null, out;
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
    } catch (e) { out = { state: "fail", why: e === STOP ? "interrupted" : "error" }; }
    finally { busy = false; if (t) await Promise.resolve(d.disarm(t)).catch(() => {}); }
    if (v && out.state !== "handover") await mark(v, ["clear"]);
    const res = Object.assign({ id: t ? t.id : null }, out);
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

module.exports = { createPine, chartUrl, tvSymbol, tvInterval, parseSnap, locate, pasteOk, pineTitle, clean, errLines, statRows, classify, onTv, readTv, NAMES };
