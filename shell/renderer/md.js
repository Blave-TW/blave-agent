/* markdown → 結構 → DOM(聊天回覆與報告的 text block 共用;報告的列印頁 report-print.html 也載這一支,所以不能碰 app.js 的全域)。
   規則照網頁工作頁(marked,gfm + breaks):標題、清單(含巢狀)、表格、``` 圍欄、引言、分隔線,行內粗體 / 斜體 / 刪除線 / 程式碼 / 連結 / 換行。
   這裡不解讀 HTML:mdBlocks 只產結構,DOM 由 mdPaint 一個節點一個節點組,字串一律走 textContent。 */
const MD_FENCE = /^( {0,3})(`{3,}|~{3,})([^`]*)$/;
const MD_HEAD = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const MD_HR = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const MD_QUOTE = /^ {0,3}> ?(.*)$/;
const MD_LI = /^( *)([-*+]|\d{1,9}[.)])( +|$)(.*)$/;
const MD_DEPTH = 12;     // 巢狀上限:再深的當純文字,病態輸入(幾萬個 >)不會把堆疊撐爆
const mdIndent = (s) => /^ */.exec(s)[0].length;
function mdCells(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}
/* 表頭 + 分隔列(|---|:--:|)成立、欄數一樣才是表格(GFM);回傳每欄的對齊 */
function mdTableAt(lines, i) {
  if (i + 1 >= lines.length || lines[i].indexOf("|") < 0 || lines[i + 1].indexOf("|") < 0) return null;
  const head = mdCells(lines[i]), delim = mdCells(lines[i + 1]);
  if (head.length !== delim.length || !delim.every((c) => /^:?-+:?$/.test(c))) return null;
  return delim.map((c) => (/^:-+:$/.test(c) ? "center" : /-:$/.test(c) ? "right" : /^:/.test(c) ? "left" : ""));
}
/* 會打斷段落的行(同 marked:清單只有「非空的 - * + 或 1.」才打斷,「2. 」接在段落裡是字) */
function mdStarts(lines, i) {
  const s = lines[i], li = MD_LI.exec(s);
  return MD_FENCE.test(s) || MD_HEAD.test(s) || MD_HR.test(s) || MD_QUOTE.test(s) || !!mdTableAt(lines, i) ||
    (!!li && li[1].length < 4 && li[4].trim() !== "" && (!/\d/.test(li[2]) || /^1[.)]$/.test(li[2])));
}
function mdBlocks(text, depth) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/^\t+/, (t) => "    ".repeat(t.length)));
  if (depth > MD_DEPTH) return [{ p: [{ text: lines.join("\n") }] }];
  const out = [];
  let i = 0, m;
  while (i < lines.length) {
    const s = lines[i];
    if (!s.trim()) { i++; continue; }
    if ((m = MD_FENCE.exec(s))) {
      const ind = m[1].length, fence = m[2], body = [];
      const closes = (l) => { const x = l.trim(); return mdIndent(l) < 4 && x.length >= fence.length && x === fence[0].repeat(x.length); };
      for (i++; i < lines.length && !closes(lines[i]); i++) body.push(lines[i].slice(Math.min(ind, mdIndent(lines[i]))));
      i++;                                                   // 收尾那行;串流中還沒收尾 = 一路到底
      out.push({ code: body.join("\n"), lang: m[3].trim().split(/\s+/)[0] });
    } else if ((m = MD_HEAD.exec(s))) {
      out.push({ h: m[1].length, inl: mdInline(m[2] || "", 0) }); i++;
    } else if (MD_HR.test(s)) {
      out.push({ hr: true }); i++;
    } else if (MD_QUOTE.test(s)) {
      const body = [];
      for (; i < lines.length && lines[i].trim(); i++) {
        const q = MD_QUOTE.exec(lines[i]);
        if (q) body.push(q[1]); else if (!mdStarts(lines, i)) body.push(lines[i]); else break;
      }
      out.push({ quote: mdBlocks(body.join("\n"), depth + 1) });
    } else if (mdTableAt(lines, i)) {
      const align = mdTableAt(lines, i), head = mdCells(s).map((c) => mdInline(c, 0)), rows = [];
      for (i += 2; i < lines.length && lines[i].trim() && !mdStarts(lines, i); i++) {
        const c = mdCells(lines[i]); rows.push(align.map((_a, k) => mdInline(c[k] || "", 0)));
      }
      out.push({ table: { align, head, rows } });
    } else if ((m = MD_LI.exec(s)) && m[1].length < 4) {
      const r = mdList(lines, i, depth); out.push(r.block); i = r.next;
    } else {
      const para = [s];
      let setext = 0;
      for (i++; i < lines.length && lines[i].trim(); i++) {
        if (/^ {0,3}=+[ \t]*$/.test(lines[i])) { setext = 1; i++; break; }
        if (/^ {0,3}-+[ \t]*$/.test(lines[i])) { setext = 2; i++; break; }
        if (mdStarts(lines, i)) break;
        para.push(lines[i]);
      }
      const inl = mdInline(para.map((l) => l.replace(/^ +/, "")).join("\n").replace(/\s+$/, ""), 0);
      out.push(setext ? { h: setext, inl } : { p: inl });
    }
  }
  return out;
}
/* 一份清單:每項的內容 = 縮排到內容欄(記號後面那格)以上的行,去掉縮排後遞迴排版——巢狀清單、項目裡的圍欄都從這裡來。
   換記號(- 換 *、1. 換 1))= 另一份清單,同 CommonMark。 */
function mdList(lines, i, depth) {
  const first = MD_LI.exec(lines[i]), ordered = /\d/.test(first[2]), mark = first[2].slice(-1), items = [];
  const same = (x) => !!x && x[1].length < 4 && x[2].slice(-1) === mark && /\d/.test(x[2]) === ordered;
  while (i < lines.length) {
    const m = MD_LI.exec(lines[i]);
    if (!same(m)) break;
    const sp = m[3].length, col = m[1].length + m[2].length + (sp === 0 || sp > 4 ? 1 : sp), body = [m[4]];
    let j = i + 1;
    while (j < lines.length) {
      const l = lines[j];
      if (!l.trim()) {
        let k = j + 1; while (k < lines.length && !lines[k].trim()) k++;
        if (k < lines.length && mdIndent(lines[k]) >= col) { for (; j < k; j++) body.push(""); continue; }
        break;
      }
      if (mdIndent(l) >= col) { body.push(l.slice(col)); j++; continue; }
      if (body[body.length - 1].trim() && !MD_LI.test(l) && !mdStarts(lines, j)) { body.push(l.trim()); j++; continue; }   // 段落的懶散續行
      break;
    }
    items.push(mdBlocks(body.join("\n"), depth + 1));
    i = j;
    if (i < lines.length && !lines[i].trim()) {           // 項目之間隔空行:下一個非空行是同一種記號才還是這份清單
      let k = i; while (k < lines.length && !lines[k].trim()) k++;
      if (k < lines.length && same(MD_LI.exec(lines[k]))) i = k; else break;
    }
  }
  return { block: { list: { ordered, start: ordered ? parseInt(first[2], 10) : 1, items } }, next: i };
}
/* 行內:最左邊先配到的那個贏;同一個位置照這個順序(程式碼 > 跳脫 > 連結 > 網址 > 粗體 > 斜體 > 刪除線 > 換行) */
const MD_INL = new RegExp([
  /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/.source,                                                           // 1,2 程式碼
  /\\([!-/:-@[-`{-~])/.source,                                                                           // 3 跳脫
  /(!?)\[((?:[^[\]\n]|\[[^[\]\n]*\])*)\]\(\s*<?([^\s<>()]*(?:\([^\s()]*\)[^\s<>()]*)*)>?(?:\s+"[^"\n]*")?\s*\)/.source,  // 4,5,6 連結 / 圖
  /<(https?:\/\/[^\s<>]+)>/.source,                                                                      // 7
  /(https?:\/\/[^\s<>"]*[^\s<>"?!.,:;*_~)'\]}。，、；：！？）」』])/.source,                                 // 8 裸網址
  /\*\*(?=\S)([\s\S]*?\S)\*\*/.source,                                                                   // 9
  /(?<!\w)__(?=\S)([\s\S]*?\S)__(?!\w)/.source,                                                          // 10
  /\*(?=[^\s*])([\s\S]*?[^\s*])\*/.source,                                                               // 11
  /(?<!\w)_(?=[^\s_])([\s\S]*?[^\s_])_(?!\w)/.source,                                                    // 12
  /~~(?=[^\s~])([\s\S]*?[^\s~])~~/.source,                                                               // 13
  /<[bB][rR]\s*\/?>|\n/.source,                                                                         // 換行;表格儲存格裡常見的 <br> 也當換行(其餘 HTML 一律當字)
].join("|"), "g");
/* 連結只收 http(s)。其餘(javascript:、相對路徑)只顯示字。點下去由 #chat-scroll 的委派交給系統瀏覽器(見 addMsg 下面) */
const mdHref = (u) => (/^https?:\/\/[^\s]+$/i.test(u) ? u : null);
function mdInline(s, depth) {
  const out = [];
  if (!s) return out;
  if (depth > MD_DEPTH) return [{ text: s }];
  const re = new RegExp(MD_INL.source, "g");
  let last = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ text: s.slice(last, m.index) });
    last = re.lastIndex;
    const sub = (x) => mdInline(x, depth + 1);
    if (m[1] != null) out.push({ code: /^ [\s\S]*[^ ][\s\S]* $/.test(m[2]) ? m[2].slice(1, -1) : m[2] });
    else if (m[3] != null) out.push({ text: m[3] });
    else if (m[5] != null) {
      const href = mdHref(m[6]), kids = sub(m[5] || m[6]);
      out.push(href ? { a: href, kids } : { span: kids });
    } else if (m[7] != null || m[8] != null) { const u = m[7] || m[8]; out.push({ a: u, kids: [{ text: u }] }); }
    else if (m[9] != null || m[10] != null) out.push({ strong: sub(m[9] != null ? m[9] : m[10]) });
    else if (m[11] != null || m[12] != null) out.push({ em: sub(m[11] != null ? m[11] : m[12]) });
    else if (m[13] != null) out.push({ del: sub(m[13]) });
    else out.push({ br: true });
  }
  if (last < s.length) out.push({ text: s.slice(last) });
  return out;
}
/* 結構 → DOM。一個節點一個節點組:字只經 textContent / createTextNode 進畫面,不經任何「把字串當 HTML 解析」的 API */
const mdEl = (tag) => document.createElement(tag);
function mdPaint(host, blocks) {
  blocks.forEach((b) => {
    let n;
    if (b.p) { n = mdEl("p"); mdPaintInl(n, b.p); }
    else if (b.h) { n = mdEl("h" + b.h); mdPaintInl(n, b.inl); }
    else if (b.hr) n = mdEl("hr");
    else if (b.code != null) { n = mdEl("pre"); const c = mdEl("code"); c.textContent = b.code; n.appendChild(c); }
    else if (b.quote) { n = mdEl("blockquote"); mdPaint(n, b.quote); }
    else if (b.list) {
      n = mdEl(b.list.ordered ? "ol" : "ul");
      if (b.list.ordered && b.list.start !== 1) n.start = b.list.start;
      b.list.items.forEach((it) => { const li = mdEl("li"); mdPaint(li, it); n.appendChild(li); });
    } else if (b.table) {
      // 表格包一層自己的橫向捲動容器(同網頁 .md-tblwrap):欄位多時在表格裡橫捲,不把聊天欄撐寬
      n = mdEl("div"); n.className = "md-tblwrap";
      const tb = mdEl("table"), th = mdEl("thead"), bd = mdEl("tbody");
      const row = (cells, tag) => {
        const tr = mdEl("tr");
        cells.forEach((c, k) => { const x = mdEl(tag); if (b.table.align[k]) x.style.textAlign = b.table.align[k]; mdPaintInl(x, c); tr.appendChild(x); });
        return tr;
      };
      th.appendChild(row(b.table.head, "th"));
      b.table.rows.forEach((r) => bd.appendChild(row(r, "td")));
      tb.appendChild(th); if (b.table.rows.length) tb.appendChild(bd);
      n.appendChild(tb);
    }
    if (n) host.appendChild(n);
  });
}
function mdPaintInl(host, parts) {
  parts.forEach((p) => {
    if (p.text != null) host.appendChild(document.createTextNode(p.text));
    else if (p.code != null) { const c = mdEl("code"); c.textContent = p.code; host.appendChild(c); }
    else if (p.br) host.appendChild(mdEl("br"));
    else if (p.a) {
      const a = mdEl("a"); a.href = p.a; a.target = "_blank"; a.rel = "noopener noreferrer"; a.title = p.a;
      mdPaintInl(a, p.kids); host.appendChild(a);
    } else {
      const x = mdEl(p.strong ? "strong" : p.em ? "em" : p.del ? "del" : "span");
      mdPaintInl(x, p.strong || p.em || p.del || p.span); host.appendChild(x);
    }
  });
}

/* ── 報告的 text block(reports.js 的閱讀頁與 report-print.js 的列印頁共用)── */
const RPT_FN_RE = /\[\^([A-Za-z0-9_-]{1,32})\]/g;   // 契約 §4 的尾註引用(同 report-blocks.js 的 FN_REF)
/* text block 的 markdown → DOM(渲染器的 makeCtx.markdown):接上面的 mdBlocks / mdPaint(一個節點一個節點組,不經 HTML)。
   契約不支援連結:mdPaint 從 [text](url) / 裸網址生出來的 <a> 拆回純文字(同 web)。尾註引用 [^id] → 上標:web 是餵給 marked 之前
   換成 <a> 字串;這裡的 markdown 不解讀 HTML,改在畫好的樹上換(程式碼與連結裡不換)。**粗體不必前置展開**:mdInline 的 ** 沒有
   CommonMark 的 flanking 限制。monoNarrative 由渲染器接手 */
function rptMarkdown(md, ctx) {
  const frag = document.createDocumentFragment();
  mdPaint(frag, mdBlocks(md, 0));
  frag.querySelectorAll("a").forEach((a) => a.replaceWith(document.createTextNode(a.textContent)));
  const walker = document.createTreeWalker(frag, window.NodeFilter.SHOW_TEXT, null), texts = [];
  let n = null;
  while ((n = walker.nextNode())) { const p = n.parentNode; if (p && (p.nodeName === "CODE" || p.nodeName === "A")) continue; RPT_FN_RE.lastIndex = 0; if (RPT_FN_RE.test(n.nodeValue)) texts.push(n); }
  texts.forEach((node) => {
    const s = node.nodeValue, f = document.createDocumentFragment(), re = new RegExp(RPT_FN_RE.source, "g");
    let last = 0, m = null;
    while ((m = re.exec(s))) {
      const k = ctx.footnotes[m[1]];
      if (!k) continue;   // 對不上的引用 api 會 400;真的漏進來就原樣留字面,不做出一個點不到的上標
      if (m.index > last) f.append(s.slice(last, m.index));
      const a = document.createElement("a"); a.className = "rb-fnref"; a.href = "#fn-" + m[1]; a.textContent = String(k);
      a.setAttribute("aria-label", ctx.i18n.footnoteRef + " " + k);
      a.addEventListener("click", rptJumpFn);
      f.append(a); last = re.lastIndex;
    }
    if (last < s.length) f.append(s.slice(last));
    node.replaceWith(f);
  });
  return frag;
}
// 上標跳到尾註列(同 report-blocks.js 的 jumpToFootnote:只做「同頁跳到那條註解」,不導覽)
function rptJumpFn(e) {
  e.preventDefault();
  const id = this.getAttribute("href").slice(1), root = this.closest("article.rb-report");
  const target = root ? [...root.querySelectorAll(".rb-fn")].find((x) => x.id === id) : null;
  if (!target) return;
  target.scrollIntoView({ behavior: "auto", block: "center" });
  target.setAttribute("tabindex", "-1"); target.focus({ preventScroll: true });
}
