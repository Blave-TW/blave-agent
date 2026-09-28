// 在分頁的 isolated world 裡跑的函式(cdp.js 用 Runtime.callFunctionOn / evaluate 帶 contextId 呼叫)。
// isolated world:跟頁面共用 DOM、不共用 JS 全域——頁面改不到這裡看到的原型與函式,也拿不到這裡的變數。
// 每個函式必須自給自足(會被 toString() 送進頁面),回傳值一律 JSON 可序列化,而且**在頁內先截長**:
// 惡意頁可以塞 100 MB 的字串,等到主行程再截就來不及了。
"use strict";

/* 節點描述(給 gate.js 分級)。this = 目標元素。 */
function describe() {
  const el = this, T = (s, n) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n || 200);
  const tag = (el.tagName || "").toLowerCase();
  const form = el.form || (el.closest && el.closest("form")) || null;
  let label = "";
  try { if (el.labels && el.labels.length) label = el.labels[0].innerText; } catch (_) { /* 不是可標籤元素 */ }
  const lab = el.closest && el.closest("label");
  const labelFor = tag === "label" ? (el.control || null) : null;
  const inputType = (el.getAttribute && (el.getAttribute("type") || "")).toLowerCase();
  const role = (el.getAttribute && el.getAttribute("role")) || "";
  const isSubmit = (tag === "button" && (!inputType || inputType === "submit") && !!form) || (tag === "input" && (inputType === "submit" || inputType === "image"));
  const formMethod = form ? String(form.getAttribute("method") || "get").toLowerCase() : null;
  return {
    tag, role, type: tag === "input" ? (inputType || "text") : inputType,
    // 名稱絕不拿 value:欄位的 value 是用戶打的字(密碼欄預填的值就曾經從這裡漏出來);按鈕型 input 的字另放 value
    name: T(el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("title")) || el.innerText, 120),
    text: T(el.innerText || el.textContent, 120), title: T(el.getAttribute && el.getAttribute("title"), 120),
    hasOnclick: !!(el.getAttribute && el.getAttribute("onclick")), alt: T(el.getAttribute && el.getAttribute("alt"), 120), pageUrl: String(location.href).slice(0, 2000),
    fieldName: T(el.getAttribute && el.getAttribute("name"), 80), id: T(el.id, 80),
    label: T(label || (lab && lab.innerText), 120), placeholder: T(el.getAttribute && el.getAttribute("placeholder"), 120),
    ariaLabel: T(el.getAttribute && el.getAttribute("aria-label"), 120), autocomplete: T(el.getAttribute && el.getAttribute("autocomplete"), 80),
    value: tag === "input" && (inputType === "submit" || inputType === "button") ? T(el.value, 80) : "",
    href: tag === "a" ? String(el.href || "").slice(0, 2000) : "",
    inForm: !!form, formMethod, isSubmit,
    formIsSearch: !!form && (form.getAttribute("role") === "search" || !!form.querySelector("input[type=search],[role=searchbox]")),
    formHasPassword: !!form && !!form.querySelector("input[type=password]"),
    formHasFile: !!form && !!form.querySelector("input[type=file]"),
    withinSearchLandmark: !!(el.closest && el.closest("[role=search],search")),
    isFileInput: tag === "input" && inputType === "file",
    labelForFile: !!(labelFor && labelFor.type === "file") || !!(lab && lab.querySelector("input[type=file]")),
    isSelect: tag === "select", editable: !!el.isContentEditable,
    options: tag === "select" ? Array.from(el.options).slice(0, 100).map((o) => T(o.text, 80)) : [],
  };
}

/* 這些函式以 toString() 送進頁面跑,選擇器只能寫死在函式體內(拿不到模組層變數)。
   code 編輯器容器(Monaco / CodeMirror):打字入口是容器裡的隱藏 textarea,
   value / selection 只是小緩衝區,動它動不到文件本體——清空與焦點都要另外走。 */
/* 清空欄位(fill 之前)。this = 目標元素。回 true = 是可填的欄位;
   false = 編輯器一類,呼叫端改送真鍵盤全選(Cmd/Ctrl+A),接下來的 insertText 蓋掉選取。 */
function clearField() {
  const el = this;
  if (el.closest && el.closest(".monaco-editor, .cm-editor, .CodeMirror")) return false;
  if (el.isContentEditable) { el.focus(); document.getSelection().selectAllChildren(el); return true; }
  if (!("value" in el)) return false;
  el.focus(); try { el.select(); } catch (_) { /* 不支援選取的型別 */ }
  return true;
}

/* fill 之前把焦點對到目標(Input.insertText 打進「有焦點的元素」,不走座標)。this = 目標。
   DOM.focus 對編輯面(view-lines 一類不可聚焦的 div)是 no-op;Monaco / CodeMirror 會把焦點
   轉給編輯器裡的隱藏 textarea——焦點落在同一個編輯器容器裡就算對到。都對不到回 false,
   不然 insertText 會打進頁面上別的欄位。 */
function focusTarget() {
  const el = this, sel = ".monaco-editor, .cm-editor, .CodeMirror";
  const box = (n) => (n && n.closest ? n.closest(sel) : null);
  const ok = () => {
    const f = document.activeElement;
    if (!f || f === document.body || f === document.documentElement) return false;
    if (f === el || el.contains(f) || f.contains(el)) return true;
    const eb = box(el); return !!(eb && box(f) === eb);
  };
  if (ok()) return true;
  if (el.focus) try { el.focus(); } catch (_) { /* 不可聚焦 */ }
  if (ok()) return true;
  const host = box(el);
  if (host) {
    const inp = host.querySelector('textarea, [contenteditable="true"]');
    if (inp) try { inp.focus(); } catch (_) { /* 收不了焦點 */ }
  }
  return ok();
}

/* <select> 以選項文字選。this = select。回選中的文字或 null。 */
function selectOption(text) {
  const el = this, want = String(text).trim().toLowerCase();
  const opts = Array.from(el.options || []);
  const o = opts.find((x) => x.text.trim().toLowerCase() === want) || opts.find((x) => x.text.trim().toLowerCase().includes(want));
  if (!o) return null;
  el.value = o.value;
  el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
  return o.text;
}

/* 讀頁:主文 markdown + 標題大綱(帶在 markdown 裡的位置)+ 連結 + meta。上限 200k 字元。 */
function extract() {
  const MAX = 200000;
  const T = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const abs = (h) => { try { const u = new URL(h, location.href); return /^https?:$/.test(u.protocol) ? u.href : ""; } catch (_) { return ""; } };
  const SKIP = new Set(["script", "style", "noscript", "template", "svg", "canvas", "iframe", "object", "embed", "button", "input", "select", "textarea", "form", "nav", "footer", "aside", "dialog"]);
  const hidden = (el) => { try { const cs = getComputedStyle(el); return cs.display === "none" || cs.visibility === "hidden" || el.hidden || el.getAttribute("aria-hidden") === "true"; } catch (_) { return false; } };

  // 找主文:唯一的 <article> → <main>/[role=main] → 段落文字最多的區塊 → body
  function mainNode() {
    const arts = document.querySelectorAll("article");
    if (arts.length === 1 && T(arts[0].innerText).length > 200) return arts[0];
    const m = document.querySelector("main,[role=main]");
    if (m && T(m.innerText).length > 200) return m;
    let best = null, score = 0; const acc = new Map();
    for (const p of document.querySelectorAll("p")) {
      const par = p.parentElement; if (!par) continue;
      const v = (acc.get(par) || 0) + T(p.innerText).length; acc.set(par, v);
      if (v > score) { score = v; best = par; }
    }
    return best && score > 400 ? best : document.body;
  }
  const root = mainNode();
  let out = "", total = 0;
  const heads = [], links = [], seen = new Set();
  const push = (s) => { if (total >= MAX) return; const t = s.slice(0, MAX - total); out += t; total += t.length; };
  // 每個區塊記下字元起訖與它在文件裡的位置:主行程據此知道「這次讀了哪幾塊」,頁面上的讀取帶畫在真實位置
  const blocks = [], sx0 = window.scrollX, sy0 = window.scrollY;
  const rectOf = (n) => { try { const r = n.getBoundingClientRect(); return { top: Math.round(r.top + sy0), h: Math.round(r.height), left: Math.round(r.left + sx0), w: Math.round(r.width) }; } catch (_) { return null; } };
  const blk = (n, s) => { const at = total; push(s); if (blocks.length < 600 && total > at) { const r = rectOf(n); if (r && r.h > 0) blocks.push(Object.assign({ at, end: total }, r)); } };
  const linkRects = [];
  function inline(el) {
    let s = "";
    for (const n of el.childNodes) {
      if (s.length > 4000) break;
      if (n.nodeType === 3) s += n.nodeValue;
      else if (n.nodeType === 1) {
        const tg = n.tagName.toLowerCase();
        if (SKIP.has(tg) || hidden(n)) continue;
        if (tg === "a") { const h = abs(n.getAttribute("href")); const tx = T(inline(n)); s += h && tx ? "[" + tx + "](" + h + ")" : tx; if (h && tx && !seen.has(h) && links.length < 200) { seen.add(h); links.push({ text: tx.slice(0, 200), url: h.slice(0, 2000) }); if (linkRects.length < 40) { const r = rectOf(n); if (r && r.h > 0 && r.top - sy0 < window.innerHeight && r.top + r.h - sy0 > 0) linkRects.push(r); } } }
        else if (tg === "br") s += "\n";
        else if (tg === "code") s += "`" + T(n.innerText) + "`";
        else if (tg === "strong" || tg === "b") s += "**" + T(inline(n)) + "**";
        else if (tg === "em" || tg === "i") s += "_" + T(inline(n)) + "_";
        else s += inline(n);
      }
    }
    return s;
  }
  function block(el, depth) {
    if (total >= MAX || depth > 40) return;
    for (const n of el.childNodes) {
      if (total >= MAX) return;
      if (n.nodeType === 3) { const tx = T(n.nodeValue); if (tx) blk(el, tx + "\n\n"); continue; }
      if (n.nodeType !== 1) continue;
      const tg = n.tagName.toLowerCase();
      if (SKIP.has(tg) || hidden(n)) continue;
      if (tg === "header" && n !== root && depth > 0 && !n.querySelector("h1,h2")) continue;
      const hm = /^h([1-6])$/.exec(tg);
      if (hm) { const tx = T(n.innerText); if (tx) { heads.push({ id: "h" + (heads.length + 1), level: Number(hm[1]), text: tx.slice(0, 300), at: total, r: rectOf(n) }); blk(n, "#".repeat(Number(hm[1])) + " " + tx + "\n\n"); } continue; }
      if (tg === "p" || tg === "figcaption" || tg === "dd" || tg === "dt") { const tx = T(inline(n)); if (tx) blk(n, tx + "\n\n"); continue; }
      if (tg === "li") { const tx = T(inline(n)); if (tx) blk(n, "- " + tx + "\n"); continue; }
      if (tg === "ul" || tg === "ol") { block(n, depth + 1); push("\n"); continue; }
      if (tg === "pre") { blk(n, "```\n" + String(n.innerText).slice(0, 20000) + "\n```\n\n"); continue; }
      if (tg === "blockquote") { const tx = T(inline(n)); if (tx) blk(n, "> " + tx + "\n\n"); continue; }
      if (tg === "table") {
        const rows = Array.from(n.querySelectorAll("tr")).slice(0, 200).map((r) => Array.from(r.children).slice(0, 20).map((c) => T(c.innerText).replace(/\|/g, "/").slice(0, 200)));
        if (rows.length) { const w = Math.max(...rows.map((r) => r.length)); blk(n, rows.map((r, i) => "| " + r.concat(Array(w - r.length).fill("")).join(" | ") + " |" + (i === 0 ? "\n|" + " --- |".repeat(w) : "")).join("\n") + "\n\n"); }
        continue;
      }
      if (tg === "img") { const alt = T(n.getAttribute("alt")); if (alt) blk(n, "[image: " + alt.slice(0, 200) + "]\n\n"); continue; }
      block(n, depth + 1);
    }
  }
  block(root, 0);
  // 主文區連結太少(列表頁的導覽在主文外)→ 整頁補(扣掉 nav/footer)
  if (links.length < 5) {
    for (const a of document.querySelectorAll("a[href]")) {
      if (links.length >= 200) break;
      if (a.closest("nav,footer") || hidden(a)) continue;
      const h = abs(a.getAttribute("href")), tx = T(a.innerText);
      if (h && tx.length >= 2 && !seen.has(h)) { seen.add(h); links.push({ text: tx.slice(0, 200), url: h.slice(0, 2000) }); }
    }
  }
  // meta:JSON-LD → og/article meta → <time datetime>
  const meta = { title: T(document.title).slice(0, 300), canonical: null, published: null, modified: null, author: null, site: null, description: null, lang: T(document.documentElement.lang).slice(0, 20) || null };
  const mc = (sel) => { const e = document.querySelector(sel); return e ? T(e.getAttribute("content")).slice(0, 500) || null : null; };
  try { const c = document.querySelector("link[rel=canonical]"); if (c) meta.canonical = abs(c.getAttribute("href")) || null; } catch (_) { /* 壞網址 */ }
  for (const s of Array.from(document.querySelectorAll("script[type='application/ld+json']")).slice(0, 10)) {
    try {
      const walk = (o, d) => {
        if (!o || typeof o !== "object" || d > 4) return;
        if (Array.isArray(o)) return o.forEach((x) => walk(x, d + 1));
        if (!meta.published && typeof o.datePublished === "string") meta.published = o.datePublished.slice(0, 40);
        if (!meta.modified && typeof o.dateModified === "string") meta.modified = o.dateModified.slice(0, 40);
        if (!meta.author && o.author) { const a = Array.isArray(o.author) ? o.author[0] : o.author; meta.author = T(typeof a === "string" ? a : a && a.name).slice(0, 200) || null; }
        if (o["@graph"]) walk(o["@graph"], d + 1);
      };
      walk(JSON.parse(String(s.textContent).slice(0, 200000)), 0);
    } catch (_) { /* 壞 JSON-LD */ }
  }
  meta.published = meta.published || mc("meta[property='article:published_time']") || mc("meta[name='pubdate']") || mc("meta[itemprop=datePublished]") || (document.querySelector("time[datetime]") ? T(document.querySelector("time[datetime]").getAttribute("datetime")).slice(0, 40) : null);
  meta.modified = meta.modified || mc("meta[property='article:modified_time']");
  meta.author = meta.author || mc("meta[name=author]");
  meta.site = mc("meta[property='og:site_name']");
  meta.description = mc("meta[name=description]") || mc("meta[property='og:description']");
  return { markdown: out, truncated: total >= MAX, headings: heads.slice(0, 200), links, meta, blocks, linkRects,
    view: { sy: Math.round(sy0), vh: window.innerHeight, vw: window.innerWidth, docH: document.documentElement.scrollHeight } };
}

/* 搜尋結果頁:Google / DuckDuckGo html 版。不靠 Google 的 class 名(混淆、常換):主結果區裡「含 h3 的連結」就是一筆。
   vf = 這個引擎的驗證頁標記(verify.js 的表):只讀——看網址、找標記、比字,不點不填。認出是驗證頁就到此為止,不往下讀結果 */
function serp(engine, vf) {
  const T = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const text = T(document.body ? document.body.innerText : "").slice(0, 5000).toLowerCase();
  const out = { items: [], captcha: false, consent: false, url: location.href };
  if (vf) {
    const result = !!(vf.unless && document.querySelector(vf.unless));
    out.captcha = new RegExp(vf.path).test(location.pathname) || (!result && (!!document.querySelector(vf.marks) || new RegExp(vf.text).test(text)));
    if (out.captcha) return out;
  }
  if (engine === "google") {
    out.consent = /(^|\.)consent\.google\./.test(location.hostname) || !!document.querySelector("form[action*='consent.google']");
    const area = document.querySelector("#rso") || document.querySelector("#search") || document.querySelector("[role=main]") || document.body;
    for (const a of area.querySelectorAll("a[href]")) {
      const h3 = a.querySelector("h3"); if (!h3) continue;
      let snip = "", p = a;
      for (let i = 0; i < 7 && p && p !== area; i++) { p = p.parentElement; const tx = T(p && p.innerText); if (tx.length > T(a.innerText).length + 40) { snip = tx.replace(T(a.innerText), "").slice(0, 400); break; } }
      const ad = !!a.closest("#tads,#tadsb,#bottomads,[data-text-ad]");
      out.items.push({ href: a.href, title: T(h3.innerText).slice(0, 300), snippet: snip, ad });
      if (out.items.length >= 30) break;
    }
  } else {
    for (const a of document.querySelectorAll("a.result__a")) {
      const box = a.closest(".result");
      const s = box && box.querySelector(".result__snippet");
      out.items.push({ href: a.href, title: T(a.innerText).slice(0, 300), snippet: T(s && s.innerText).slice(0, 400), ad: !!(box && box.classList.contains("result--ad")) });
      if (out.items.length >= 30) break;
    }
  }
  return out;
}

/* 讀得到了沒(主文件解析完、而且有一段像樣的正文):回正文字數。只數 40 字以上的段落——導覽列、按鈕、頁尾的短字不算。
   廣告多的新聞站永遠等不到 load,但正文早就在了(index.js early) */
function readable() {
  if (document.readyState === "loading" || !document.body) return 0;
  let n = 0;
  for (const p of document.querySelectorAll("p, li, blockquote, pre, td, dd")) { const s = String(p.innerText || "").trim().length; if (s >= 40) n += s; if (n > 100000) break; }
  return n;
}

/* 頁面上找字(browser_wait until=text)。 */
function hasText(s) { return String(document.body ? document.body.innerText : "").slice(0, 2000000).includes(String(s)); }

/* 捲動。回捲完後的位置。 */
/* smoothMs > 0:展開在看的那一頁有過程地捲(rAF),捲完才回;否則瞬間。 */
function scrollPage(dir, amount, smoothMs) {
  const h = window.innerHeight * (amount === "half" ? 0.5 : 0.9);
  const done = () => ({ y: Math.round(window.scrollY), max: Math.round(document.documentElement.scrollHeight - window.innerHeight) });
  if (!smoothMs) { window.scrollBy(0, dir === "up" ? -h : h); return done(); }
  const y0 = window.scrollY, dy = dir === "up" ? -h : h, t0 = performance.now();
  return new Promise((res) => {
    const step = (now) => { const k = Math.min(1, (now - t0) / smoothMs), e = 1 - Math.pow(1 - k, 3); window.scrollTo(0, y0 + dy * e); if (k < 1) requestAnimationFrame(step); else res(done()); };
    requestAnimationFrame(step);
  });
}

/* 讀取進度(畫面的「讀取中 n/N」):主文段落數,與目前可視區在第幾段。 */
function progress() {
  const ps = document.querySelectorAll("article p, main p, p");
  const n = ps.length; let at = 0;
  for (let i = 0; i < n; i++) { const r = ps[i].getBoundingClientRect(); if (r.top > window.innerHeight * 0.4) break; at = i + 1; }
  return { n: Math.min(at, n), total: n };
}

/* 暫停自動播放的影音、靜音(省資源)。 */
function quiet() { for (const m of document.querySelectorAll("video,audio")) { try { m.pause(); m.muted = true; m.autoplay = false; } catch (_) { /* 不是媒體 */ } } return true; }

/* 頁面上的 agent 動作標記(canon 電腦版內建瀏覽器 第 4、9 條;定案 A「跟著走」,.claude/output/designer/mockup-desktop-browser-agent-cursor-2026-09-26.html)。
   WebContentsView 是原生層,畫在 app 的 DOM 上會被頁面蓋住,所以畫進頁面裡:一個 closed shadow root(頁面的 CSS 進不來),
   pointer-events:none(不擋用戶點)。顏色寫死墨/白:第三方頁面裡沒有我們的 CSS 變數;每樣都有 1px 白描邊,暗色網站也看得見。
   座標一律文件座標(可視區座標 + 捲動量),跟著頁面捲。只畫真的發生的事:沒點就不畫點擊環。
   kind:
     "ref"  { box, label }            目標框 + ref 小標
     "need" { box, label }            「由你按」框
     "move" { x, y, ms }              agent 游標從上次位置滑到 (x,y)(可視區座標),ms = 滑行時間;閒置 1.2 秒淡出
     "click"{ x, y }                  到點的點擊環(reduced 時不畫)
     "read" { rects, per, follow }    讀取帶依文件順序掃過這次讀進來的區塊(每塊 per ms),讀完留已讀線與捲軸軌標記;follow = 跟著捲
     "frames" { rects, stagger, hold } 看大綱 / 讀連結:被抽到的元素依序框一下
     "unframe"                         收掉目標框與小標(擷取落地)
     "clear"
     "settle"                          密集判定(pace.js)切到瞬間模式:正在播的標記全部跳終態
   click 帶 instant = 靜止單幀環(22px 2px 墨環,不放大不淡出;canon 第 9 條瞬間模式)。
   新的 read / frames 進來時,正在播的那一段直接跳終態。 */
function mark(kind, data, reduced) {
  const ID = "__blave_agent_marks";
  let host = document.getElementById(ID), root = host && host.__r;
  if (host && !root) { host.remove(); host = null; }   // 別的 world 建的(拿不到它的 shadow root):重建
  if (kind === "clear") { if (host) host.remove(); return true; }
  if (!host) {
    host = document.createElement("div"); host.id = ID;
    host.style.cssText = "position:absolute!important;left:0!important;top:0!important;width:0!important;height:0!important;z-index:2147483647!important;pointer-events:none!important;";
    root = host.attachShadow({ mode: "closed" }); host.__r = root; host.__g = 0;
    const st = document.createElement("style");
    st.textContent = ".o{position:absolute;outline:1.5px solid #111;outline-offset:2px;border-radius:2px;box-shadow:0 0 0 1px #fff}.o.need{outline:2px solid #111;box-shadow:0 0 0 2px #fff}"
      + ".t{position:absolute;font:600 10px/14px ui-monospace,Menlo,monospace;background:#111;color:#fff;padding:0 4px;border-radius:2px;white-space:nowrap;transform:translateY(-100%);box-shadow:0 0 0 1px #fff}"
      + ".r{position:absolute;width:22px;height:22px;margin:-11px 0 0 -11px;border:2px solid #111;border-radius:50%;box-shadow:0 0 0 1px #fff,inset 0 0 0 1px #fff;animation:k .45s cubic-bezier(.23,1,.32,1) forwards}"
      + "@keyframes k{from{transform:scale(.6);opacity:1}to{transform:scale(1.6);opacity:0}}"
      + ".r.s{animation:none;transform:scale(1);opacity:1}"
      + ".c{position:absolute;left:0;top:0;display:flex;align-items:flex-start;opacity:0;transition:opacity .18s cubic-bezier(.23,1,.32,1);will-change:transform}.c.on{opacity:1}"
      + ".c svg{display:block}.c span{margin:10px 0 0 2px;padding:0 4px;border-radius:2px;background:#111;color:#fff;box-shadow:0 0 0 1px #fff;font:600 10px/14px ui-monospace,Menlo,monospace}"
      + ".b{position:absolute;background:rgba(128,128,128,.16);border-left:2px solid #111;box-shadow:-1px 0 0 #fff;opacity:0;transition:opacity .18s cubic-bezier(.23,1,.32,1),top .26s cubic-bezier(.23,1,.32,1),height .26s cubic-bezier(.23,1,.32,1)}.b.on{opacity:1}"
      + ".l{position:absolute;width:2px;background:#111;box-shadow:0 0 0 1px #fff}"
      + ".k{position:fixed;right:1px;width:5px;background:#111;box-shadow:0 0 0 1px #fff;border-radius:1px}"
      + ".f{position:absolute;outline:1.5px solid #111;outline-offset:2px;box-shadow:0 0 0 2px #fff;border-radius:2px;transition:opacity .18s cubic-bezier(.23,1,.32,1)}";
    root.appendChild(st);
    (document.body || document.documentElement).appendChild(host);
  }
  const sx = window.scrollX, sy = window.scrollY;
  const el = (cls, css, text) => { const e = document.createElement("div"); e.className = cls; e.style.cssText = css; if (text) e.textContent = text; root.appendChild(e); return e; };
  const px = (r) => "left:" + r.left + "px;top:" + r.top + "px;width:" + r.w + "px;height:" + r.h + "px";
  const cursor = () => {
    let c = root.querySelector(".c");
    if (!c) { c = el("c", ""); c.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M2 1l11 7-5 1-2 5z" fill="#111" stroke="#fff" stroke-width="1"/></svg><span>agent</span>'; c.__x = sx + window.innerWidth / 2; c.__y = sy + window.innerHeight / 2; c.style.transform = "translate(" + c.__x + "px," + c.__y + "px)"; }
    return c;
  };
  const idle = (c) => { clearTimeout(c.__idle); c.__idle = setTimeout(() => c.classList.remove("on"), 1200); };
  if (kind === "settle") {
    // 密集觸發:前一動作還在播的標記跳終態(讀取帶 → 已讀線+捲軌;環/框收掉;游標跳到目標)
    host.__g++;
    if (host.__fin) { const f = host.__fin; host.__fin = null; f(); }
    for (const n of Array.from(root.querySelectorAll(".b,.f,.r"))) n.remove();
    const c0 = root.querySelector(".c");
    if (c0) { c0.style.transition = "opacity .18s cubic-bezier(.23,1,.32,1)"; c0.style.transform = "translate(" + c0.__x + "px," + c0.__y + "px)"; }
    return true;
  }
  if (kind === "ref" || kind === "need") {
    for (const n of Array.from(root.querySelectorAll(".o,.t"))) n.remove();
    const b = data.box;
    el(kind === "need" ? "o need" : "o", "left:" + (b.x + sx) + "px;top:" + (b.y + sy) + "px;width:" + b.w + "px;height:" + b.h + "px");
    // canon 第 4 條裁定:@eN 小標對用戶不顯示,只留目標 outline;開發旗標(data.tag)開才畫。
    // 「由你按」(need)照舊——那是給用戶的指示,不是內部定位代號
    if (kind === "need" || data.tag) {
      // 元素貼在可視區頂端、上方放不下 16px 的小標 → 改貼在元素下方
      const above = b.y >= 18;
      // 翻到下方時貼元素左下(游標的「agent」小標在元素中心偏右下,不疊在一起)
      const tag = el("t", "left:" + (above ? b.x + b.w + sx - 2 : b.x + sx) + "px;top:" + (above ? b.y + sy - 2 : b.y + b.h + sy + 2) + "px", String(data.label || "").slice(0, 40));
      if (!above) tag.style.transform = "none";
    }
    return true;
  }
  if (kind === "move") {
    const c = cursor(), x = data.x + sx, y = data.y + sy, ms = reduced ? 0 : Math.max(0, data.ms || 0);
    c.style.transition = "opacity .18s cubic-bezier(.23,1,.32,1),transform " + ms + "ms cubic-bezier(.23,1,.32,1)";
    c.classList.add("on"); void c.offsetWidth;
    c.style.transform = "translate(" + x + "px," + y + "px)"; c.__x = x; c.__y = y;
    idle(c); return true;
  }
  if (kind === "unframe") { for (const n of Array.from(root.querySelectorAll(".o,.t"))) n.remove(); return true; }   // 擷取落地:收框
  if (kind === "click") {
    for (const n of Array.from(root.querySelectorAll(".o,.t"))) n.remove();   // 點擊落地:收框
    const c = root.querySelector(".c"); if (c) idle(c);
    if (reduced) return true;   // 減少動態優先:連靜止單幀環都不出
    const r = el(data.instant ? "r s" : "r", "left:" + (data.x + sx) + "px;top:" + (data.y + sy) + "px");
    setTimeout(() => r.remove(), 600);
    return true;
  }
  const g = ++host.__g;
  host.__fin = null;   // 舊讀取帶的落定收尾跟著作廢(新的 read / frames 接手畫面)
  for (const n of Array.from(root.querySelectorAll(".b,.f"))) n.remove();
  if (kind === "read") {
    const rects = (data.rects || []).slice(0, 400);
    if (!rects.length) return true;
    const top = Math.min(...rects.map((r) => r.top)), bot = Math.max(...rects.map((r) => r.top + r.h)), left = Math.min(...rects.map((r) => r.left));
    const finish = (force) => {
      if (!force && host.__g !== g) return;
      host.__fin = null;
      const b = root.querySelector(".b"); if (b) b.remove();
      el("l", "left:" + (left - 12) + "px;top:" + top + "px;height:" + (bot - top) + "px");   // 已讀線:跟讀取帶的左線同一個 x
      const dh = Math.max(document.documentElement.scrollHeight, 1), vh = window.innerHeight;   // 捲軸軌上標已讀範圍
      el("k", "top:" + Math.round(top / dh * vh) + "px;height:" + Math.max(3, Math.round((bot - top) / dh * vh)) + "px");
    };
    if (reduced || !data.per) { finish(); return true; }
    host.__fin = () => finish(true);   // settle(密集切換)把這一段帶落定
    const band = el("b", ""); let i = 0;
    const scrollTo = (y) => {   // 跟著捲:--motion-travel 近似的 rAF 平滑捲
      const y0 = window.scrollY, dy = y - y0, t0 = performance.now();
      const step = (now) => { if (host.__g !== g) return; const k = Math.min(1, (now - t0) / 260), e = 1 - Math.pow(1 - k, 3); window.scrollTo(window.scrollX, y0 + dy * e); if (k < 1) requestAnimationFrame(step); };
      requestAnimationFrame(step);
    };
    const next = () => {
      if (host.__g !== g) return;
      if (i >= rects.length) return finish();
      const r = rects[i++];
      band.style.cssText = "left:" + (left - 12) + "px;top:" + r.top + "px;width:" + (r.left + r.w + 12 - (left - 12)) + "px;height:" + r.h + "px";
      band.classList.add("on");
      if (data.follow && (r.top < window.scrollY + 40 || r.top + r.h > window.scrollY + window.innerHeight - 40)) scrollTo(Math.max(0, r.top - window.innerHeight * 0.35));
      setTimeout(next, data.per);
    };
    next();
    return true;
  }
  if (kind === "frames") {
    const rects = (data.rects || []).slice(0, 40), hold = reduced ? 600 : (data.hold || 600), stagger = reduced ? 0 : (data.stagger || 0);
    rects.forEach((r, j) => setTimeout(() => {
      if (host.__g !== g) return;
      const f = el("f", px(r));
      setTimeout(() => { if (reduced) f.remove(); else { f.style.opacity = "0"; setTimeout(() => f.remove(), 200); } }, hold);
    }, j * stagger));
    return true;
  }
  return true;
}

/* 截圖前遮敏感欄位(稽核 S2):列出「有值」的輸入欄位給主行程用 gate.sensitiveField 判,再把判中的蓋掉。
   欄位描述只含判斷要的那幾項,不含值本身。 */
function fieldCandidates() {
  const T = (x, n) => String(x == null ? "" : x).replace(/\s+/g, " ").trim().slice(0, n || 120);
  const out = [];
  const els = Array.from(document.querySelectorAll("input, textarea, [contenteditable=''], [contenteditable=true]"));
  for (let i = 0; i < els.length && out.length < 400; i++) {
    const el = els[i];
    const val = el.isContentEditable ? el.textContent : el.value;
    if (!val) continue;
    let label = ""; try { if (el.labels && el.labels.length) label = el.labels[0].innerText; } catch (_) { /* 不是可標籤元素 */ }
    out.push({ i, tag: el.tagName.toLowerCase(), type: T(el.getAttribute("type"), 40).toLowerCase(), autocomplete: T(el.getAttribute("autocomplete"), 80),
      fieldName: T(el.getAttribute("name"), 80), id: T(el.id, 80), label: T(label), placeholder: T(el.getAttribute("placeholder")), ariaLabel: T(el.getAttribute("aria-label")) });
  }
  return out;
}
/* 蓋掉第 idx 個欄位(fieldCandidates 的編號)與金流商的 iframe(卡號欄常在第三方 iframe 裡,我們看不進去)。
   回實際蓋掉幾個欄位;主行程比對數量,對不上就不拍。 */
function maskFields(idx, payHostRe) {
  const ID = "__blave_mask";
  const old = document.getElementById(ID); if (old) old.remove();
  const host = document.createElement("div"); host.id = ID;
  host.style.cssText = "position:absolute!important;left:0!important;top:0!important;width:0!important;height:0!important;z-index:2147483647!important;pointer-events:none!important;";
  const root = host.attachShadow({ mode: "closed" });
  const els = Array.from(document.querySelectorAll("input, textarea, [contenteditable=''], [contenteditable=true]"));
  const sx = window.scrollX, sy = window.scrollY, re = new RegExp(payHostRe, "i");
  const box = (r) => { const b = document.createElement("div"); b.style.cssText = "position:absolute;left:" + (r.left + sx - 2) + "px;top:" + (r.top + sy - 2) + "px;width:" + (r.width + 4) + "px;height:" + (r.height + 4) + "px;background:#111;border:1px solid #fff"; root.appendChild(b); };
  let n = 0;
  for (const i of idx) { const el = els[i]; if (!el) continue; box(el.getBoundingClientRect()); n++; }
  for (const f of Array.from(document.querySelectorAll("iframe"))) {
    let h = ""; try { h = new URL(f.src, location.href).hostname; } catch (_) { /* 沒有 src */ }
    if (h && re.test(h)) box(f.getBoundingClientRect());
  }
  (document.body || document.documentElement).appendChild(host);
  return n;
}
function unmaskFields() { const h = document.getElementById("__blave_mask"); if (h) h.remove(); return true; }

/* 拍縮圖 / 來源快照 / 截圖前把頁面裡的 agent 標記藏起來(縮圖上的標記只由 app 那一層畫,不然會出現兩個游標) */
/* 元素(this)自己或裡面還沒載完的圖有幾張(擷取用)。loading="lazy" 的圖捲進畫面才開始抓,PNG 由上往下解:
   沒載完就拍,拿到的是上半張圖、下半是頁面底色。沒有來源的、看不見的(追蹤像素)不算;載失敗的(complete 但沒有尺寸)不會再來,也不算。
   還沒載完的 lazy 圖順手改成 eager:lazy 要等頁面出畫面才判「進了可視區」,停在視窗外的分頁不出畫面,等再久也不會開始抓(實測) */
function pendingPictures() {
  const el = this, list = [];
  if (el.tagName === "IMG") list.push(el);
  if (el.querySelectorAll) for (const im of el.querySelectorAll("img")) { list.push(im); if (list.length >= 200) break; }
  let n = 0;
  for (const im of list) {
    if (im.complete || !(im.currentSrc || im.getAttribute("src") || im.getAttribute("srcset"))) continue;
    const r = im.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (im.loading === "lazy") im.loading = "eager";
    n++;
  }
  return n;
}
function marksVisible(on) { const h = document.getElementById("__blave_agent_marks"); if (h) h.style.setProperty("visibility", on ? "visible" : "hidden", "important"); return true; }

module.exports = { mark, marksVisible, pendingPictures, describe, fieldCandidates, maskFields, unmaskFields, clearField, focusTarget, selectOption, extract, serp, hasText, readable, scrollPage, progress, quiet };
