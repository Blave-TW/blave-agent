/* 內建瀏覽器的畫面(主行程 shell/browser/ 的事件 → 聊天瀏覽區塊、中欄展開層)。
   canon:design-system.md › Components ›「電腦版內建瀏覽器(agent 瀏覽)」九條;spec:.claude/output/designer/spec-desktop-browser-2026-09-26.md。
   這一層不持有任何頁面物件:只收 browser-event、只送分頁 id 與中欄的 bounds。頁面來的字(網址、標題、擷取句)一律 textContent。
   在 app.js 之後載入(用它的 $、t、sessionId、scrollChat、busyPin、trackFeature)。 */

const BR = {
  tabs: new Map(),     // id → { id, url, title, ph, foot, prog, thumb, snap, need, dl, blocked, fail, user, by }
  blocks: [],          // 這條對話畫出來的區塊:{ el, ids: [], live, sum }
  cur: null,           // 這一輪正在長的區塊
  exp: null,           // null | { mode: "one", id } | { mode: "wall", block } | { mode: "snap", id?, snap, url, title }
  bw: null,            // 中欄展開層
  io: null, ro: null,
};
const BR_ICON = {
  check: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
  lock: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  warn: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
  ban: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/></svg>',
  reload: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>',
  hand: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v2"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>',
  win: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 8h20"/><path d="M6 4v4"/><path d="M10 4v4"/></svg>',
  ext: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>',
};
const BR_SERP = /^https:\/\/(?:www\.google\.com\/search\?|html\.duckduckgo\.com\/html\/)/;   // 主行程 doSearch 開的那兩種網址
const BR_MULTI = /\.(co|com|net|org|gov|edu|ac|or|ne|idv)\.[a-z]{2}$/;

function brEl(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
function brIcon(name) { const s = document.createElement("span"); s.innerHTML = BR_ICON[name]; return s.firstChild; }
function brHost(url) { try { return new URL(url).hostname.toLowerCase(); } catch (_) { return ""; } }
/** 可註冊網域(格上只顯示這一段;近似,不帶 PSL)。 */
function brReg(host) {
  if (!host || /^[\d.]+$/.test(host) || host.includes(":")) return host;
  const p = host.split("."); return p.slice(BR_MULTI.test(host) ? -3 : -2).join(".");
}
/* 網站圖示:有主行程給的 favicon(已驗過 mime 與大小的 data URL)就用,沒有才退回字母格。不接受任何遠端網址 */
const BR_FAV_RE = /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/i;
const BR_FAVS = new Map();   // host → { src: data URL, plate: 深色圖要墊淺底 }(這條對話看過的)
function brFav(url, fav, plate) {
  const host = brHost(url), known = BR_FAVS.get(host), src = fav || (known && known.src), pl = fav ? !!plate : !!(known && known.plate);
  const box = brEl("span", "fav");
  if (src && BR_FAV_RE.test(src)) {
    const im = document.createElement("img"); im.alt = ""; im.src = src;
    im.addEventListener("error", () => { box.textContent = (brReg(host) || "?").charAt(0); box.classList.remove("has-img", "plate"); });
    box.classList.add("has-img"); if (pl) box.classList.add("plate"); box.append(im);
  } else box.textContent = (brReg(host) || "?").charAt(0);
  return box;
}
function brNoteFav(url, fav, plate) { if (fav && BR_FAV_RE.test(fav)) { const h = brHost(url); if (h) BR_FAVS.set(h, { src: fav, plate: !!plate }); } }
const brReduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// ── 分頁狀態 → 一格 ──────────────────────────────────────────
function brTab(id) { let x = BR.tabs.get(id); if (!x) { x = { id, url: "", title: "", ph: "load" }; BR.tabs.set(id, x); } return x; }
const BR_NOTE_KINDS = ["outline", "links", "meta", "snapshot", "press"];
/* 「你在操作」回答的是「agent 現在會不會動這一頁」:只有 agent 開的分頁被用戶接手時才有這個問題。用戶自己開的分頁
   (送進 TradingView、開即時頁、重試;by === "user")agent 本來就碰不到,照一般分頁畫。純函式 */
const brUserOp = (x) => !!x && !!x.user && x.by !== "user";
/* 讀不了(頁面那一邊的原因):打不開、agent 不開這個網站、只停在轉址頁 */
const brBad = (x) => !!x && !!(x.fail || x.blocked || x.relay) && !x.need;
/* 未讀:開了、載入正常、agent 沒讀。回合結束時還在載入的頁也算(頁面沒有壞,是 agent 沒等它)。
   agent 拿來操作(點、打字、按鍵)的頁不算——那種頁本來就不是拿來讀的,摘要寫的是「用了 N 頁」。
   用戶自己開的分頁(by === "user")也不算:「未讀」講的是 agent 讀了沒有,那一頁 agent 本來就碰不到(e2e #186:送進
   TradingView 的那一頁被標成未讀)——照一般分頁畫,狀態句是頁面標題。純函式 */
const brUnread = (x) => !!x && x.by !== "user" && !x.search && !x.readEver && !x.used && !brBad(x) && !x.need && !brUserOp(x) && (x.ph === "open" || !!x.ended);
function brFoot(x) {
  if (x.need) return t(x.need.kind === "login" ? "br.need.login" : x.need.kind === "captcha" ? "br.need.captcha" : x.need.kind === "file" ? "br.need.file" : x.need.kind === "confirm" ? "br.need.confirm" : "br.need.submit");
  if (brUserOp(x)) return t("br.userOp");
  if (x.blocked) return t(x.blocked.kind === "addr" ? "br.blk.addr.h" : "br.row.blocked");   // 可疑網址 / 相似網域那一列跟擋下頁同一句
  if (x.fail) return t("br.failed", { why: t("br.fail." + x.fail).replace(/[。.]$/, "") });   // 訊息槽不帶句尾句號;失敗頁說明句照留
  if (x.relay) return t("br.relay");   // 只停在中繼頁(轉址、Loading…、Cloudflare):開了但沒讀到內容
  if (x.note && Date.now() - x.note.at < 2500) return x.note.kind === "press" ? t("br.pressing", { key: x.note.text || "" }) : t("br.act." + x.note.kind);
  if (x.ended && x.ph !== "done") return x.title || brReg(brHost(x.url));   // 回合結束時沒讀完的頁:不再說「讀取中」,留標題(沒有就網域)
  if (x.ph === "queued") return t("br.queuedOne");
  if (x.ph === "load") return t("br.loading");
  // ph "act"(點擊 / 打字)不做動作旁白(Wei:狀態列已經講了 agent 在做什麼)——落到最後的標題;
  // ph 本身照舊,縮圖上的游標(.tc)與 pulse 都靠它
  if (x.ph === "read") return x.prog ? t("br.reading") + " " + x.prog.n + "/" + x.prog.total : t("br.reading");
  if (x.ph === "done") return x.search ? t("br.search") : x.line || x.title || brReg(brHost(x.url));   // 搜尋分頁(過完驗證還開在中欄的那一頁):講「搜尋結果」,不念搜尋字串
  return x.title || "";
}
function brStatusNode(x) {
  if (x.need) return brEl("span", "need-dot");   // 「由你按」只留在中欄那顆要按的鈕旁;「等你操作」由狀態列講
  if (brUserOp(x)) return brIcon("hand");
  if (x.blocked) return brIcon("ban");
  if (brUnread(x)) return brEl("span", "st-t", t("br.unread"));   // 跟「已讀」成對的兩個字,放在狀態位(條頭),不疊在縮圖上
  if (x.ended && x.ph !== "done" && !x.fail) return null;   // 回合結束:沒讀完的頁狀態位留空,pulse 停
  if (x.fail) return brIcon("warn");
  if (x.ph === "load" || x.ph === "queued") return brEl("span", "br-spin");
  if (x.ph === "read" || x.ph === "act") return brEl("span", "br-pulse");
  if (x.relay) return brIcon("warn");
  if (x.ph === "done") return x.search ? null : brIcon("check");   // 搜尋結果頁列出來但不打「已讀」
  return null;
}
function brPh(x) { return x.need ? "wait" : brUserOp(x) ? "user" : x.blocked ? "blocked" : x.fail ? "fail" : brUnread(x) ? "unread" : x.ph; }
function brTile(id) {
  const x = brTab(id);
  const b = brEl("button", "pt"); b.type = "button"; b.dataset.id = id;
  const bar = brEl("span", "pt-bar"), dom = brEl("span", "dom mono");
  bar.append(brFav(x.url), dom, brEl("span", "pt-st"));
  // 縮圖上那一層(app 自己畫,走 token):讀取帶、12px 游標、16px 點擊環,位置取自真實事件,不等截圖。
  // 這一層跟截圖同比例(可視區寬高),百分比座標才對得上
  const pg = brEl("span", "pg"), layer = brEl("span", "pg-layer");
  const cur = brEl("span", "tc"); cur.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 1l11 7-5 1-2 5z"/></svg>';
  layer.append(brEl("span", "pg-band"), cur); pg.append(layer);
  b.append(bar, pg, brEl("span", "pt-foot"), brEl("span", "pt-prog"));
  b.addEventListener("click", (e) => { if (e.isTrusted) brRowClick(id); });   // 只有用戶真的點才展開:中欄不能被任何程式路徑搶走(canon 第 6 條)
  brPaintTile(b, x);
  return b;
}
function brPaintTile(el, x) {
  el.dataset.ph = brPh(x);
  if (x.ended) el.dataset.ended = ""; else delete el.dataset.ended;   // 回合結束後未讀格的縮圖也降到 45%(整面牆亮度一致,狀態只從條頭讀)
  el.setAttribute("aria-current", BR.exp && BR.exp.mode === "one" && BR.exp.id === x.id ? "true" : "false");
  const dom = el.querySelector(".dom"); dom.textContent = ""; dom.append(brEl("b", "", brReg(brHost(x.url)) || x.url));
  const fk = BR_FAVS.get(brHost(x.url)), fv = el.querySelector(".pt-bar .fav"), want = fk ? fk.src + (fk.plate ? "|p" : "") : "";
  if (fv && fv.__src !== want) { const nf = brFav(x.url); nf.__src = want; fv.replaceWith(nf); }
  const st = el.querySelector(".pt-st"); st.textContent = ""; const n = brStatusNode(x); if (n) st.append(n);
  const foot = el.querySelector(".pt-foot"); foot.textContent = ""; foot.append(brEl("span", "", brFoot(x)));
  const pr = el.querySelector(".pt-prog"); pr.style.transform = "scaleX(" + (x.ph === "read" && x.prog && x.prog.total ? Math.min(1, x.prog.n / x.prog.total) : 0) + ")";
  const pg = el.querySelector(".pg"); let img = pg.querySelector("img");
  if (x.thumb) { if (!img) { img = document.createElement("img"); img.alt = ""; pg.prepend(img); } if (img.src !== x.thumb) img.src = x.thumb; }
  const layer = pg.querySelector(".pg-layer");
  if (layer) {
    const vw = x.vw || 1280, vh = x.vh || 800; layer.style.aspectRatio = vw + " / " + vh;
    const band = layer.querySelector(".pg-band"); band.hidden = !!x.ended; band.style.top = x.band != null ? (x.band * 100).toFixed(1) + "%" : "";   // 讀取帶在真實位置;沒有位置才用預設
    const c = layer.querySelector(".tc"), a = x.act && x.act.box && (x.act.kind === "click" || x.act.kind === "type") ? x.act : null;
    if (a) { c.style.left = ((a.box.x + a.box.w / 2) / vw * 100).toFixed(1) + "%"; c.style.top = ((a.box.y + a.box.h / 2) / vh * 100).toFixed(1) + "%"; }
    c.classList.toggle("on", !!a && x.ph === "act");
    if (a && a.kind === "click" && a.at && a.at !== el.__ring && !brReduced()) {   // 點擊環:每次點擊畫一次
      el.__ring = a.at; const r = brEl("span", "tr"); r.style.left = c.style.left; r.style.top = c.style.top; layer.append(r); setTimeout(() => r.remove(), 600);
    }
  }
  el.setAttribute("aria-label", brReg(brHost(x.url)) + " — " + (brUnread(x) ? t("br.unread") + " — " : "") + brFoot(x));
}
function brPaint(id) {
  const x = BR.tabs.get(id); if (!x) return;
  document.querySelectorAll(".pt").forEach((el) => { if (el.dataset.id === id) brPaintTile(el, x); });
  const b = BR.blocks.find((k) => k.ids.includes(id)); if (b) brPaintHead(b);
  if (BR.exp && (BR.exp.mode === "wall" || (BR.exp.mode === "one" && BR.exp.id === id) || (BR.exp.mode === "one" && b && b.ids.includes(BR.exp.id)))) brPaintOverlay();
}

// ── 聊天瀏覽區塊 ─────────────────────────────────────────────
/* 縮圖只在頁面活著時拍、只存在記憶體:歷史的區塊每一格都沒有圖 → 整塊不畫縮圖欄(.no-thumb)。
   進行中的照舊留著那一格(圖馬上會來,先佔位才不跳);有的有圖有的沒有也不加(整塊左緣要對齊)。純函式,測試切出來跑 */
function brNoThumb(live, thumbs, onlyVerify) { return (!live || !!onlyVerify) && thumbs.length > 0 && thumbs.every((x) => !x); }
/* 這張卡的清單裡只有「搜尋在等你過驗證」的那一列(那一頁不拍縮圖,永遠不會有圖):卡頭不畫、縮圖欄收掉 */
function brOnlyVerify(b) { return b.ids.length > 0 && b.ids.every((id) => !!(BR.tabs.get(id) || {}).verify); }
function brThumbClass(b, el) { el.classList.toggle("no-thumb", brNoThumb(b.live, b.ids.map((id) => (BR.tabs.get(id) || {}).thumb), brOnlyVerify(b))); }
function brBlockNew(live) {
  const el = brEl("div", "bblk"), head = brEl("div", "bblk-head"), wall = brEl("div", "wall");
  el.append(head, wall);
  const b = { el, head, wall, ids: [], live, queued: 0 };
  BR.blocks.push(b);
  return b;
}
function brStat(b, withSegs) {
  // 已讀 / 總數跟摘要列同一個口徑:真的讀過(browser_read)的頁才算已讀;搜尋結果頁列出來但不算在內
  const all = b.ids.map((id) => BR.tabs.get(id)).filter(Boolean), xs = all.filter((x) => !x.search);
  const d = xs.filter((x) => x.readEver).length, n = xs.length;
  const frag = document.createDocumentFragment();
  if (!b.live) {
    // 回合結束後不再寫分數(「3/7 已讀」讓人去算剩下 4 頁怎麼了):三個數直接講完,是 0 的不出。口徑同摘要列(brPaintSum)
    const read = b.sourceCount != null ? b.sourceCount : xs.filter(brIsRead).length, used = xs.filter((x) => !brBad(x)).length;
    const sum = brEl("span", "st-sum"), item = (pre, k, post) => { const c = brEl("span"); c.append(pre, brEl("b", "", String(k)), post || ""); sum.append(c); };
    if (read === 0 && used > 0) item(t("br.summaryUsedPre"), used, t("br.summaryPost"));
    else { if (read) item(t("br.summaryPre"), read, t("br.summaryPost")); const un = xs.filter(brUnread).length; if (un) item(t("br.unread") + " ", un); }
    const bad = xs.filter(brBad).length; if (bad) item(t("br.cantRead") + " ", bad);
    if (sum.childNodes.length) frag.append(sum);
    return frag;
  }
  const need = all.some((x) => x.need), active = b.live && all.some((x) => ["load", "read", "act", "queued"].includes(x.ph));
  // 等你操作只換掉狀態段;已讀 / 總數、進度格、排隊數照樣在(canon 第 1 條:狀態+已讀/總數)
  if (need) frag.append(brEl("span", "", t("br.waiting")));
  else if (b.writing && b.live) frag.append(brEl("span", "br-spin"), brEl("span", "", t("br.compiling")));   // 只在這一輪真的有報告寫入事件時
  else if (active) frag.append(brEl("span", "br-pulse"), brEl("span", "", t("br.browsing")));
  if (withSegs && (active || need) && n > 1) { const s = brEl("span", "segs"); s.setAttribute("aria-hidden", "true"); xs.forEach((x) => s.append(brEl("i", x.readEver ? "ok" : "on"))); frag.append(s); }
  if (n) { const c = brEl("span", "mono"); c.append(brEl("b", "", String(d)), "/" + n + " " + t("br.readWord")); frag.append(c); }
  if (b.queued) frag.append(brEl("span", "", t("br.queued", { n: b.queued })));
  return frag;
}
/* 真的讀到內容的頁(進圖示疊、算「已讀」):讀過、不是搜尋結果頁、不是只停在中繼頁 */
const brIsRead = (x) => !!x && x.readEver && !x.search && !x.relay;
/* 進行中的卡:一行——圖示疊＋已讀 d/n＋「看網頁」。卡頭不放任何狀態字(瀏覽中／等你操作／匯整成報告都由回合狀態列講);
   進行中不給展開(Wei 0928 第 2a 點 A 案:開了哪幾頁、讀到哪,狀態列與中欄分頁牆都講了),清單留到回合結束當來源紀錄(摘要列);
   要你操作的那一頁永遠攤在這一行下面(CSS) */
function brLine(b) {
  const frag = document.createDocumentFragment();
  const xs = b.ids.map((id) => BR.tabs.get(id)).filter((x) => x && !x.search), read = xs.filter(brIsRead);
  if (read.length) {
    const favs = brEl("span", "favs");
    read.slice(0, 4).forEach((x, i) => { const f = brFav(x.url); f.style.zIndex = String(4 - i); favs.append(f); });
    frag.append(favs);
    if (read.length > 4) frag.append(brEl("span", "more", "+" + (read.length - 4)));
  }
  if (xs.length) { const c = brEl("span", "cnt"); const n = brEl("span", "mono"); n.append(brEl("b", "", String(read.length)), "/" + xs.length); c.append(n, " " + t("br.readWord")); frag.append(c); }
  return frag;
}
/* 讀不了的頁(打不開、被擋、只停在中繼頁)排在最下面,上面一條細線＋「讀不了」(原因由每一格自己的訊息槽講)。
   回合結束時再排一次:已讀 → 未讀 → 細線 → 讀不了,同一組內照開啟順序;進行中不重排(格子不能在用戶眼前跳) */
function brRank(x, ended) { return brBad(x) ? 2 : ended && brUnread(x) ? 1 : 0; }
function brOrder(b) {
  const tiles = [...b.wall.querySelectorAll(":scope > .pt")], rank = (el) => brRank(BR.tabs.get(el.dataset.id), !b.live);
  const ok = tiles.filter((el) => rank(el) < 2).sort((p, q) => rank(p) - rank(q)), ng = tiles.filter((el) => rank(el) === 2);
  let sep = b.wall.querySelector(":scope > .bsep");
  if (!ng.length) { if (sep) sep.remove(); sep = null; }
  else if (!sep) sep = brEl("div", "bsep", t("br.cantRead"));
  const want = ok.concat(sep ? [sep] : [], ng);
  if (want.some((el, i) => b.wall.children[i] !== el)) want.forEach((el) => b.wall.append(el));
}
/* 中欄分頁牆的順序:回合結束後同一套(已讀 → 未讀 → 讀不了);牆上每一格自己有 icon 與原因,不補細線與小標 */
function brWallOrder(b, wall) {
  if (b.live) return;
  const tiles = [...wall.querySelectorAll(":scope > .pt")], rank = (el) => brRank(BR.tabs.get(el.dataset.id), true);
  const want = tiles.slice().sort((p, q) => rank(p) - rank(q));
  if (want.some((el, i) => tiles[i] !== el)) want.forEach((el) => wall.append(el));
}
function brPaintHead(b) {
  brThumbClass(b, b.el);
  if (b.sum) { brPaintSum(b); brOrder(b); return; }   // 回合結束後的清單:已讀 → 未讀 → 讀不了
  const h = b.head; h.textContent = "";
  const inWall = BR.exp && BR.exp.mode === "wall" && BR.exp.block === b;
  b.el.classList.toggle("is-out", !!inWall);
  b.el.classList.toggle("is-empty", !b.ids.length && !inWall);   // 這一輪只搜尋過、還沒開任何頁:卡先不出現
  b.el.classList.toggle("only-need", brOnlyVerify(b));
  h.append(brLine(b));
  // 一列一個控件:進行中只有「看網頁」(中欄沒有這一輪的頁才放;已經在中欄就不放——收回靠中欄標題列的 ✕、Esc
  // 或再點一次選中的列),回合結束後只有摘要列的 chevron;兩者不同時出現
  const act = brEl("span", "bblk-act");
  const mine = BR.exp && ((BR.exp.mode === "one" && b.ids.includes(BR.exp.id)) || inWall);
  if (!mine && b.ids.length) { const all = brEl("button", "br-open"); all.type = "button"; all.append(brIcon("win"), t("br.openPanel")); all.addEventListener("click", (e) => { e.stopPropagation(); brWall(b); }); act.append(all); }
  h.append(act);
  brOrder(b);
}
/* 回合狀態列(app.js actApply)問:這一輪有沒有頁在等用戶操作 */
function brNeedsUser() {
  // 搜尋驗證這一種,用戶動手之後仍然算在等:他還在過驗證,agent(那一次搜尋)確實還在等
  const b = BR.cur; return !!(b && b.live && b.ids.some((id) => { const x = BR.tabs.get(id); return x && x.need && (!x.user || x.need.kind === "captcha"); }));
}
/* 搜尋分頁平常不進清單;在等用戶過驗證的期間當成一列 need 攤開(不算頁數、不進圖示疊——x.search 照舊是 true),
   驗證結束(過了、逾時、按了出口)就離開清單 */
function brVerifyRow(id, on) {
  const x = brTab(id);
  if (on) {
    x.search = true; x.verify = true;   // 驗證只會出現在搜尋分頁(主行程 doSearch 才發 captcha)
    if (!BR.cur || !BR.cur.live) { BR.cur = brBlockNew(true); brAppend(BR.cur.el); brObserve(); }
    brAddRow(BR.cur, id); scrollChat(); return;
  }
  if (!x.verify) return;
  x.verify = false;
  BR.blocks.forEach((b) => { const i = b.ids.indexOf(id); if (i < 0 || b.sum) return; b.ids.splice(i, 1); b.wall.querySelectorAll(".pt").forEach((el) => { if (el.dataset.id === id) el.remove(); }); brPaintHead(b); });
}
function brAppend(el) { $("chat-scroll").appendChild(el); if (typeof busyPin === "function") busyPin(); scrollChat(); }
function brAddRow(b, id) {
  if (b.ids.includes(id)) return;
  b.ids.push(id);
  const tile = brTile(id); tile.style.animationDelay = (Math.min(b.ids.length - 1, 7) * 70) + "ms";
  b.wall.append(tile); brPaintHead(b);
}
/* 一輪結束:進行中的卡本來就是一行,直接換成摘要列(`<details>`,點開是這一輪的那組格子) */
function brFinish(b) {
  if (!b || b.sum) return;
  b.live = false;
  if (!b.ids.length) { b.el.remove(); BR.blocks.splice(BR.blocks.indexOf(b), 1); return; }
  const d = brEl("details", "bblk sum"), s = brEl("summary");
  b.wall.querySelectorAll(".pt").forEach((p) => { p.style.animationDelay = "0ms"; });
  d.append(s, b.wall);
  d.addEventListener("toggle", () => { if (d.open) trackFeature("browser_sum"); brObserve(); });
  b.el.replaceWith(d); b.el = d; b.sum = s; brPaintHead(b);
}
function brPaintSum(b) {
  const s = b.sum; s.textContent = "";
  const favs = brEl("span", "favs");
  // 疊圖由左到右 z-index 遞減:左邊那格永遠在上,後面的只露出右半邊
  b.ids.map((id) => BR.tabs.get(id)).filter(brIsRead).slice(0, 4).forEach((x, i) => { const f = brFav(x.url); f.style.zIndex = String(4 - i); favs.append(f); });
  // 讀了幾頁 = 這一輪真的 browser_read 過的頁(讀過就算,之後導覽也不收回);回合結束後以主行程的來源紀錄為準(brTakeSources)
  const read = b.sourceCount != null ? b.sourceCount : b.ids.filter((id) => brIsRead(BR.tabs.get(id))).length;
  // 整輪都在操作、一頁都沒讀(Wei 實測 TradingView:貼 Pine、切週期,沒有 browser_read):
  // 「讀了 0 頁」字面不對——改講「用了 N 頁」。N = 真的開起來的頁(搜尋頁/被擋/打不開/只停中繼頁照舊不算);
  // canon 第 1 條的「已讀」口徑不動:格子照樣不打勾、圖示疊照樣只疊已讀
  const used = b.ids.map((id) => BR.tabs.get(id)).filter((x) => x && !x.search && !x.blocked && !x.fail && !x.relay).length;
  const txt = brEl("span");
  if (read === 0 && used > 0) txt.append(t("br.summaryUsedPre"), brEl("b", "", String(used)), t("br.summaryPost"));
  else txt.append(t("br.summaryPre"), brEl("b", "", String(read)), t("br.summaryPost"));
  const chev = brEl("span", "cv7"); chev.setAttribute("aria-hidden", "true");   // 跟回合狀態列同一顆(app.css .cv7)
  s.append(favs, txt, chev);
}
/* 區塊看得到才拍縮圖(主行程每 2 秒一輪):看不到的格子不花 CPU */
function brObserve() {
  if (!("IntersectionObserver" in window)) return;
  if (BR.io) BR.io.disconnect();
  const live = BR.cur && BR.cur.el;
  const wall = BR.exp && BR.exp.mode === "wall";
  if (!live && !wall) { window.blave.browserBlockVisible(false); return; }
  if (wall) { window.blave.browserBlockVisible(true); return; }
  BR.io = new IntersectionObserver((es) => window.blave.browserBlockVisible(es.some((e) => e.isIntersecting)), { root: $("chat-scroll") });
  BR.io.observe(live);
}

/* 回合結束收主行程的來源紀錄(一筆＝真的讀到正文的一頁;即時與重開 app 共用):來源那一格標成已讀;
   同一格讀過又導覽到別頁時,格子只剩最後一頁——前面讀過的頁補成一列(點開照樣開即時頁、開不了退快照),
   摘要列展開才看得到每一頁。讀了幾頁＝來源筆數扣掉搜尋結果頁,跟清單裡已讀的列數一致 */
function brTakeSources(b, tabs, sources) {
  const rows = (tabs || []).filter(Boolean), rowSnap = new Map(rows.map((r) => [r.id, r.snapshot_id || null]));
  const search = new Set(rows.filter((r) => r.search).map((r) => r.id));
  const srcs = (sources || []).filter((s) => s && s.snapshot_id && !search.has(s.id) && !(BR.tabs.get(s.id) || {}).search);
  // 那一格現在停在的就是這一頁:主行程每格紀錄的快照說了算(導覽走會換新快照);沒有紀錄才看這一格在不在清單裡
  const shown = (s) => (rowSnap.has(s.id) ? rowSnap.get(s.id) === s.snapshot_id : b.ids.includes(s.id));
  const moved = new Set(), readSnaps = new Set(srcs.map((s) => s.snapshot_id));
  for (const s of srcs) {
    if (shown(s)) { const y = BR.tabs.get(s.id); if (y) { y.readEver = true; y.relay = false; } continue; }
    const id = "src_" + s.snapshot_id;
    Object.assign(brTab(id), { url: String(s.url || ""), title: String(s.title || ""), snap: s.snapshot_id, ph: "done", readEver: true, ended: true });
    brAddRow(b, id); moved.add(s.id);
  }
  // 讀完才導覽走、新的那一頁沒讀:讀過的算在補上的那一列,這一格本身不再算已讀(不然同一頁數兩次)
  moved.forEach((id) => { const y = BR.tabs.get(id); if (y && rowSnap.has(id) && !readSnaps.has(rowSnap.get(id))) { y.readEver = false; if (y.ph === "done" && !y.relay) y.ph = "open"; } });
  b.sourceCount = srcs.length;
  b.wall.querySelectorAll(".pt").forEach((el) => { const x = BR.tabs.get(el.dataset.id); if (x) brPaintTile(el, x); });
}

// ── 中欄展開層 ───────────────────────────────────────────────
function brOverlay() {
  if (BR.bw) return BR.bw;
  const bw = brEl("div", "bw"); bw.id = "bw"; bw.hidden = true;
  document.querySelector(".pane-main").append(bw);
  BR.bw = bw;
  BR.ro = new ResizeObserver(brSyncSoon);
  // 中欄換成別的畫面(報告自動打開、點側欄)= 瀏覽器收回;原生 view 蓋在最上層,不收會擋住那個畫面
  // 只認「展開時沒在畫面上的那個畫面冒出來了」:回合結束時既有畫面自己重畫(藏了又放出來)不算
  new MutationObserver((ms) => {
    if (!BR.exp || !BR.shown) return;
    if (ms.some((m) => m.target !== bw && m.target.parentNode === bw.parentNode && !m.target.hidden && !BR.shown.has(m.target))) brCollapse(false);
  }).observe(bw.parentNode, { attributes: true, attributeFilter: ["hidden"], subtree: true });
  // 任何 modal(設定、確認框、燈箱)開著時原生 view 先停到視窗外:它是原生層,會蓋在 modal 上面
  new MutationObserver(brSyncSoon).observe(document.body, { attributes: true, attributeFilter: ["hidden"], subtree: true });
  window.addEventListener("resize", brSyncSoon);
  return bw;
}
function brModalOpen() { return !!document.querySelector(".scrim:not([hidden])") || $("view-ws").hidden; }
function brPageEl() { return BR.bw && !BR.bw.hidden ? BR.bw.querySelector(".bv-page[data-live='1']") : null; }
let brSyncQueued = false, brLastBounds = "";
/* 所有送 bounds 的地方都經過這裡,去重的快取才會跟實際狀態一致(稽核 B1:直接送 null 沒更新快取,之後同一個位置就不再送,view 停在視窗外) */
function brSendBounds(b) { const key = JSON.stringify(b); if (key === brLastBounds) return; brLastBounds = key; window.blave.browserBounds(b); }
function brSyncSoon() { if (brSyncQueued) return; brSyncQueued = true; requestAnimationFrame(() => { brSyncQueued = false; brSync(); }); }
function brSync() {
  const p = brPageEl();
  let b = null;
  if (p && !brModalOpen()) { const r = p.getBoundingClientRect(); b = { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }; }
  brSendBounds(b);   // 沒變不送:主行程 setBounds 會打斷觸控板捲動
}
function brStatLine(host) {
  host.textContent = "";
  const exp = BR.exp;
  const x = exp && exp.mode === "one" ? BR.tabs.get(exp.id) : null;
  if (x && typeof tvStat === "function" && tvStat(host, x)) return;   // 「送進 TradingView」那一頁:狀態句由 pine-install.js 畫
  if (brUserOp(x)) {
    host.append(brIcon("hand"), brEl("span", "t", t("br.userOp")));
    const hb = brEl("button", "btn-quiet", t("br.handback")); hb.type = "button";
    hb.addEventListener("click", () => { if (x.need) trackFeature("browser_handoff"); window.blave.browserHandback(x.id); });
    host.append(hb); return;
  }
  // 單頁:講「這一頁」的狀態,跟分頁格訊息槽同一組字(讀取中 2/5、已讀完、打不開、要登入);已讀 d/n 只在聊天卡頭講一次。
  // 太長只截文字那一段(.t);icon、進度格、文字鈕不縮
  // 回合結束後點進一格未讀的頁:多半就是想知道「它怎麼了」——講完整的一句,前面不放狀態節點(不然「未讀」講兩次)
  if (x && x.ended && brUnread(x)) { host.append(brEl("span", "t", t("br.unread.stat"))); return; }
  if (x) { const n = brStatusNode(x); if (n) host.append(n); host.append(brEl("span", "t", x.ph === "done" && brIsRead(x) ? t("br.readDone") : brFoot(x))); return; }
  const b = exp && exp.mode === "wall" ? exp.block : null;
  if (b) host.append(brStat(b, true));
}
async function brExpand(id, reopened) {
  brLastBounds = ""; BR.sig = null; BR.wallBlock = null;
  const bw = brOverlay();
  const res = await window.blave.browserExpand(id, null);
  // 點開就是要看即時頁(Wei):分頁不在了(收成快照、關掉、重開 app)→ 重新導覽到那個網址,快照只當縮圖;
  // 重開失敗(政策後來擋了)才落到下面的快照 / 系統瀏覽器退路頁
  if (res && !res.live && !reopened) {
    const x0 = BR.tabs.get(id), url = String((res && res.url) || (x0 && x0.url) || "");
    if (url) {
      const r = await window.blave.browserShowLive(url);
      if (r && r.id) {
        const y = brTab(r.id); y.url = url;
        if (x0) { y.title = y.title || x0.title; y.snap = y.snap || x0.snap; }
        if (!r.existing) y.ph = "load";
        return brExpand(r.id, true);
      }
    }
  }
  BR.exp = { mode: "one", id, live: !!(res && res.live), res };
  if (res && res.user) brTab(id).user = true;
  if (res && (res.by === "user" || res.by === "agent")) brTab(id).by = res.by;
  bw.hidden = false;
  brPaintOverlay();
  BR.blocks.forEach(brPaintHead);
  document.querySelectorAll(".pt").forEach((el) => { const x = BR.tabs.get(el.dataset.id); if (x) brPaintTile(el, x); });
  brObserve();
  if (typeof tvRepaintSlots === "function") tvRepaintSlots();
}
function brWall(b) {
  brLastBounds = ""; BR.sig = null; BR.wallBlock = null;
  trackFeature("browser_wall");
  brOverlay().hidden = false;
  window.blave.browserCollapse();
  BR.exp = { mode: "wall", block: b };
  brPaintOverlay(); BR.blocks.forEach(brPaintHead); brObserve();
}
async function brSnap(s, block) {
  brLastBounds = ""; BR.sig = null; BR.wallBlock = null;
  const snap = s.snapshot_id ? await window.blave.browserSnapshot(sessionId, s.snapshot_id) : null;
  window.blave.browserCollapse();
  BR.exp = { mode: "snap", src: s, snap, block };
  brOverlay().hidden = false;
  brPaintOverlay(); BR.blocks.forEach(brPaintHead); brObserve();
}
function brCollapse(byUser) {
  brLastBounds = ""; BR.sig = null; BR.wallBlock = null;
  if (!BR.exp) return;
  if (byUser) trackFeature("browser_back");
  BR.exp = null; BR.shown = null; BR.sig = null;
  if (BR.bw) { BR.bw.hidden = true; BR.bw.textContent = ""; }
  if (BR.ro) BR.ro.disconnect();
  window.blave.browserCollapse();
  BR.blocks.forEach(brPaintHead);
  document.querySelectorAll(".pt").forEach((el) => { const x = BR.tabs.get(el.dataset.id); if (x) brPaintTile(el, x); });
  brObserve();
  if (typeof tvRepaintSlots === "function") tvRepaintSlots();
}
/* Esc = 收回展開層(brCollapse,不關分頁、不打斷 agent)。排在 app.js escTop 那些框後面(它們關了一層就 preventDefault);網址列編輯中的 Esc 是取消編輯。
   焦點在網頁裡(原生 view)時按鍵不會到這裡——那是頁面自己的 Esc */
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.isComposing || e.keyCode === 229 || e.defaultPrevented || !BR.exp) return;
  if (e.target && e.target.closest && e.target.closest(".bv-addr input")) return;
  e.preventDefault(); brCollapse(true);
});
/* 收回之後焦點回哪:聊天裡選中的那一列(看得到才算);牆、快照、或那一列收著 → 那張卡的「看網頁」/ 摘要列 */
function brFocusBack() {
  const exp = BR.exp; if (!exp) return null;
  const b = exp.mode === "one" ? BR.blocks.find((k) => k.ids.includes(exp.id)) : exp.block;
  if (!b || !b.el) return null;
  const row = exp.mode === "one" ? [...b.el.querySelectorAll(".pt")].find((el) => el.dataset.id === exp.id && el.offsetParent) : null;
  return row || b.el.querySelector(".br-open") || b.sum || null;
}
function brRowClick(id) {
  if (BR.exp && BR.exp.mode === "one" && BR.exp.id === id) { brCollapse(true); return; }
  trackFeature("browser_read");
  brExpand(id);
}
/* 網址列:scheme 與子網域、路徑 --ink-3,可註冊網域加粗;punycode 原樣(URL 物件本來就不解碼) */
function brAddr(url, warn, withHash) {
  const box = brEl("div", "url" + (warn ? " warn" : ""));
  let u = null; try { u = new URL(url); } catch (_) { /* 不是網址 */ }
  box.append(brIcon(warn || !u || u.protocol !== "https:" ? "warn" : "lock"));
  const txt = brEl("span", "u mono");
  if (u) { const host = u.hostname, reg = brReg(host), sub = host.slice(0, host.length - reg.length); txt.append(u.protocol + "//" + sub, brEl("b", "", reg), (u.port ? ":" + u.port : "") + u.pathname + u.search + (withHash ? u.hash : "")); }
  else txt.textContent = url || "";
  box.append(txt);
  return box;
}
/* 這一頁能不能交給系統瀏覽器(畫面上的鈕停不停用;主行程自己再判一次,這裡只是不擺一顆按了沒反應的鈕):
   要有 http(s) 網址;等用戶確認的網址還沒放行 → 不行;被擋下的:有危害的網站名單、可疑網址(相似網域、本機位址、非 http(s))→ 不行,
   敏感網域(交易所與券商後台、銀行、登入授權頁)→ 可以(那是用戶自己的瀏覽器)。純函式 */
function brCanOpenExt(x) {
  if (!x || !/^https?:\/\//i.test(String(x.url || ""))) return false;
  if (x.need && (x.need.kind === "confirm" || x.need.kind === "captcha")) return false;   // 驗證頁:在外面的瀏覽器過驗證對內建瀏覽器沒有用
  if (x.verify) return false;
  if (x.blocked && (x.blocked.kind !== "domain" || x.blocked.reason === "blocklist")) return false;
  return true;
}
function brAddrEditable(box, id) {
  box.addEventListener("click", () => {
    if (box.querySelector("input")) return;
    const cur = box.querySelector(".u"); const inp = document.createElement("input");
    inp.value = cur ? cur.textContent : ""; inp.spellcheck = false; inp.setAttribute("aria-label", t("br.url.aria"));
    if (cur) cur.replaceWith(inp); inp.focus(); inp.select();
    inp.addEventListener("keydown", async (e) => {
      if (e.key === "Escape") { brPaintOverlay(); return; }
      if (e.key !== "Enter" || e.isComposing) return;
      const r = await window.blave.browserNavigate(id, inp.value.trim());
      if (r && r.ok) trackFeature("browser_url");
      brPaintOverlay();
    });
    inp.addEventListener("blur", () => setTimeout(() => { if (inp.isConnected) brPaintOverlay(); }, 150));
  });
}
function brAsk(x) {
  const k = x.need.kind;
  const box = brEl("div", "ask"), txt = brEl("div", "txt"), act = brEl("div", "act");
  const H = { login: "br.ask.login.h", submit: "br.ask.submit.h", action: "br.ask.action.h", file: "br.ask.file.h", captcha: "br.ask.captcha.h", consent: "br.ask.consent.h", confirm: "br.ask.confirm.h" };
  // 說明句依型別:只有登入講「帳密由你輸入」;送出 / 動作畫 agent 給的 summary(主行程已 scrub)再接「按之前再看一次」
  const sum = String(x.need.summary || "").trim();
  // 搜尋驗證:summary 是搜尋引擎的名字(主行程給的)。出口鈕的字跟著「按了會發生什麼」走——還有引擎可以退就寫它的名字,沒有了就寫「這次不搜尋」
  const lastEngine = k === "captcha" && /duckduckgo/i.test(sum);
  const P = { login: t("br.ask.p"), captcha: t("br.ask.captcha.p", { engine: sum || "Google" }), file: t("br.ask.p.file"), consent: t("br.ask.p.consent"), confirm: t("br.ask.p.confirm") };
  const sumEnd = sum && !/[。．.!！?？]$/.test(sum) ? sum + "。" : sum;   // summary 沒有句尾標點就補一個,不跟下一句黏在一起
  const line = P[k] || (sum ? sumEnd + t("br.ask.p.check") : t("br.ask.p.pause"));
  txt.append(brEl("h6", "", t(H[k] || H.action)), brEl("p", "", line));
  const skip = brEl("button", "btn-out", t(k !== "captcha" ? "br.ask.skip" : lastEngine ? "br.ask.noSearch" : "br.ask.ddg")); skip.type = "button";
  skip.addEventListener("click", () => window.blave.browserUserDone(x.id, k === "captcha" && !lastEngine ? "ddg" : "skip"));
  const me = brEl("button", "btn-fill", t(k === "login" ? "br.ask.meLogin" : k === "captcha" ? "br.ask.meVerify" : k === "file" ? "br.ask.meFile" : k === "confirm" ? "br.ask.openAnyway" : "br.ask.meSubmit")); me.type = "button";
  // 外送檢查(確認網址):不是接手操作,是這個網址放行一次;網址本身在上面的網址列看得到
  if (k === "confirm") me.addEventListener("click", () => window.blave.browserUserDone(x.id, "open"));
  else me.addEventListener("click", () => { trackFeature("browser_takeover"); window.blave.browserTakeover(x.id); });
  act.append(skip, me); box.append(txt, act);
  return box;
}
/* 純文字快照:把 markdown 標記剝掉只留字(圖片佔位整行拿掉、連結只留文字、表格分隔列拿掉) */
function brPlain(md) {
  return String(md).split("\n")
    .filter((l) => !/^\s*\[image: [^\]]*\]\s*$/.test(l) && !/^\s*\|?\s*(---\s*\|\s*)+(---)?\s*$/.test(l) && !/^```/.test(l))
    .map((l) => l.replace(/^#{1,6}\s+/, "").replace(/^>\s?/, "").replace(/^\s*-\s+/, "・").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1").replace(/(^|\W)_([^_]+)_(?=\W|$)/g, "$1$2").replace(/`([^`]*)`/g, "$1").replace(/^\|\s*|\s*\|$/g, "").replace(/\s*\|\s*/g, "   "))
    .join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
function brEmptyPage(page, icon, h, p, btn) {
  const e = brEl("div", "pg-empty"); e.append(brIcon(icon), brEl("h6", "", h), brEl("p", "", p));
  if (btn) { const b = brEl("button", "btn-out", btn.label); b.type = "button"; b.addEventListener("click", btn.on); e.append(b); }
  page.append(e);
}
function brPaintOverlay() {
  const bw = BR.bw, exp = BR.exp; if (!bw || !exp) return;
  if (!BR.shown) BR.shown = new Set([...bw.parentNode.children].filter((c) => c !== bw && !c.hidden));
  const had = bw.contains(document.activeElement) && document.activeElement.tagName === "INPUT";
  if (had) return;   // 用戶在網址列打字時不重畫
  // 同一頁、狀態結構沒變(縮圖、讀取進度、擷取句這類):只更新狀態句與分頁列,頁面框不重建——
  // 重建會讓原生 view 重新定位,捲動手勢被打斷
  // 全部展開:格子不重建(重建會重播進場、四格一起閃);只重畫每一格、更新狀態句,有新的頁才 append 新格
  if (exp.mode === "wall" && BR.wallBlock === exp.block && bw.querySelector(".bw-body .wall")) {
    const wall = bw.querySelector(".bw-body .wall"), have = new Set([...wall.querySelectorAll(".pt")].map((el) => el.dataset.id));
    exp.block.ids.forEach((id) => { if (!have.has(id)) wall.append(brWallTile(id)); });
    brThumbClass(exp.block, wall);
    wall.querySelectorAll(".pt").forEach((el) => { const x = BR.tabs.get(el.dataset.id); if (x) brPaintTile(el, x); });
    brWallOrder(exp.block, wall);
    brStatLine(bw.querySelector(".bw-stat"));
    return;
  }
  const sig = brOverlaySig(exp);
  if (sig && sig === BR.sig && bw.querySelector(".bw-stat")) { brStatLine(bw.querySelector(".bw-stat")); brPaintTabStrip(bw); return; }
  BR.sig = sig;
  const onClose = !!document.activeElement && bw.contains(document.activeElement) && document.activeElement.classList.contains("bw-close");
  bw.textContent = "";
  const head = brEl("div", "bw-head"), txt = brEl("div", "txt"), stat = brEl("div", "bw-stat");
  // 牆沒有「選中的列」可以再點、焦點在網頁裡時 Esc 到不了這裡:這顆 ✕ 是永遠在的出口,不藏、不停用。只收展開層
  const x0 = brEl("button", "modal-close bw-close", "✕"); x0.type = "button"; x0.setAttribute("aria-label", t("set.close"));
  x0.addEventListener("click", () => { const back = brFocusBack(); brCollapse(true); if (back && back.isConnected) back.focus(); });
  txt.append(brEl("h5", "", t("br.h")), stat); head.append(txt, x0); bw.append(head);
  if (onClose) x0.focus();   // 整層重畫把原本那顆換掉了:焦點放回新的,不掉到 body
  if (BR.ro) BR.ro.disconnect();
  if (exp.mode === "wall") {
    brStatLine(stat);
    BR.wallBlock = exp.block;
    const body = brEl("div", "bw-body"), wall = brEl("div", "wall");
    exp.block.ids.forEach((id) => wall.append(brWallTile(id)));
    brThumbClass(exp.block, wall); brWallOrder(exp.block, wall);
    body.append(wall); bw.append(body); brSendBounds(null); return;
  }
  const bv = brEl("div", "bv");
  if (exp.mode === "snap") {
    const s = exp.src, snap = exp.snap;
    const addr = brEl("div", "bv-addr"); addr.append(brAddr(s.url));
    const live = brEl("button", "btn-quiet bv-live", t("br.openLive")); live.type = "button";
    live.addEventListener("click", async () => { const id = await window.blave.browserOpenLive(sessionId, s.snapshot_id); if (id) { const x = brTab(id); x.url = s.url; x.title = s.title; x.ph = "load"; brExpand(id); } });
    addr.append(live);
    const page = brEl("div", "bv-page");
    if (snap) {
      const when = new Date(snap.at); const stamp = String(when.getMonth() + 1).padStart(2, "0") + "-" + String(when.getDate()).padStart(2, "0") + " " + String(when.getHours()).padStart(2, "0") + ":" + String(when.getMinutes()).padStart(2, "0");
      page.append(brEl("div", "snap-meta mono", t("br.snapMeta", { time: stamp })));
      if (snap.image) { const im = document.createElement("img"); im.className = "snap-img"; im.alt = snap.title || ""; im.src = snap.image; page.append(im); }
      else page.append(brEl("div", "snap-txt", brPlain(snap.markdown || "")));
    } else brEmptyPage(page, "warn", t("br.snapGone.h"), t("br.snapGone.p"), { label: t("br.openSystem"), on: () => window.blave.openExternal(s.url) });
    stat.append(brEl("span", "t", s.title || ""));
    bv.append(addr, page); bw.append(bv); brSendBounds(null); return;
  }
  const x = BR.tabs.get(exp.id) || brTab(exp.id);
  brStatLine(stat);
  const b = BR.blocks.find((k) => k.ids.includes(x.id));
  if (b && b.ids.length > 1) {
    const tabs = brEl("div", "bv-tabs"); tabs.setAttribute("role", "tablist");
    b.ids.forEach((id) => {
      const y = BR.tabs.get(id); if (!y) return;
      const tb = brEl("button", "bv-tab"); tb.type = "button"; tb.dataset.id = id; tb.setAttribute("role", "tab"); tb.setAttribute("aria-selected", id === x.id ? "true" : "false");
      const st = brEl("span", "pt-st"), n = y.need ? brEl("span", "need-dot") : brStatusNode(y); if (n) st.append(n);
      const host = brReg(brHost(y.url)); tb.title = host; tb.setAttribute("aria-label", host + (y.need ? " — " + t("br.youPress") : ""));
      tb.append(brFav(y.url), brEl("span", "dom mono", host), st);   // 沒選中的分頁 CSS 把網域藏起來,只留字母格+狀態
      tb.addEventListener("click", () => { if (id !== x.id) { trackFeature("browser_read"); brExpand(id); } });
      tabs.append(tb);
    });
    bv.append(tabs);
  }
  const addr = brEl("div", "bv-addr");
  const rl = brEl("button", "ibtn"); rl.type = "button"; rl.setAttribute("aria-label", t("br.reload")); rl.title = t("br.reload"); rl.append(brIcon("reload"));
  rl.disabled = !exp.live && !x.fail && !(exp.res && exp.res.status === "discarded");
  rl.addEventListener("click", async () => {
    const r = await window.blave.browserReload(x.id);
    if (typeof r === "string") { const y = brTab(r); y.url = x.url; y.title = x.title; brExpand(r); }
    else if (r) { x.fail = null; x.ph = "load"; brExpand(x.id); }
  });
  // 確認網址:網址列顯示被擋下的那個網址(含 # 之後),換警示三角(canon 第 3 條:被擋／可疑時)
  const held = x.need && x.need.kind === "confirm" && x.need.url;
  const url = held ? brAddr(x.need.url, true, true) : brAddr(x.url, x.blocked);
  if (exp.live && !held) brAddrEditable(url, x.id);
  /* 「用系統瀏覽器開」:對這一頁做的事,跟重新載入同一列(標題列只有一顆 ✕)。只送分頁 id——網址由主行程從那個分頁自己拿、自己檢查。
     內建那一頁留著不關、不收回展開層;不加回饋(系統瀏覽器跳到前面就是回饋),焦點留在這顆鈕上。停用不隱藏:藏起來網址欄寬度會跳 */
  const ext = brEl("button", "ibtn ext"); ext.type = "button"; ext.setAttribute("aria-label", t("br.openSystem")); ext.title = t("br.openSystem.tip"); ext.append(brIcon("ext"));
  ext.disabled = !brCanOpenExt(x);
  ext.addEventListener("click", (e) => { if (!e.isTrusted || ext.disabled) return; trackFeature("browser_open_ext"); window.blave.browserOpenExternal(x.id); });
  addr.append(rl, url, ext);
  const slot = brEl("div", "bv-slot");
  const tvn = typeof tvSlot === "function" ? tvSlot(x) : null;
  if (tvn) slot.append(tvn);
  else if (x.need && !x.user) slot.append(brAsk(x));
  else if (x.dl) { const l = brEl("div", "slot-line"); l.append(brIcon("ban"), brEl("span", "", t("br.dl", { name: x.dl }))); slot.append(l); }
  const page = brEl("div", "bv-page");
  if (x.blocked) {
    const sens = x.blocked.kind === "domain", r = x.blocked.reason;
    const why = sens
      ? t(r === "blocklist" ? "br.blk.list.p" : r === "blave" ? "br.blk.blave.p" : r === "oauth" ? "br.blk.oauth.p" : "br.blk.domain.p")
      : r === "lookalike" ? (x.blocked.like ? t("br.blk.like.p", { host: x.blocked.host || brHost(x.url), like: x.blocked.like }) : t("br.blk.mixed.p", { host: x.blocked.host || brHost(x.url) })) : t("br.blk.addr.p");
    brEmptyPage(page, "ban", t(sens ? "br.blk.domain.h" : "br.blk.addr.h"), why,
      // 有危害的網站名單不往系統瀏覽器送(同網址列那顆 icon 鈕的規則)
      brCanOpenExt(x) ? { label: t("br.openSystem"), on: () => { trackFeature("browser_open_ext"); window.blave.browserOpenExternal(x.id); } } : { label: t("br.back"), on: () => brCollapse(true) });
  } else if (x.fail) {
    brEmptyPage(page, "warn", t("br.fail.h", { host: brReg(brHost(x.url)) }), t("br.fail." + x.fail), { label: t("br.retry"), on: () => rl.click() });
  } else if (!exp.live) {
    const hasSnap = !!x.snap;
    brEmptyPage(page, "warn", t(hasSnap ? "br.gone.snap.h" : "br.gone.h"), t(hasSnap ? "br.gone.snap.p" : "br.gone.p"),
      hasSnap ? { label: t("br.openSnap"), on: () => brSnap({ url: x.url, title: x.title, snapshot_id: x.snap }, b) } : { label: t("br.openSystem"), on: () => window.blave.openExternal(x.url) });
  } else page.dataset.live = "1";
  bv.append(addr, slot, page); bw.append(bv);
  if (page.dataset.live) { BR.ro.observe(page); brSyncSoon(); } else brSendBounds(null);
}

function brWallTile(id) {
  const tile = brTile(id);
  tile.addEventListener("click", (e) => { e.stopImmediatePropagation(); if (!e.isTrusted) return; trackFeature("browser_read"); brExpand(id); }, { capture: true });
  return tile;
}
function brOverlaySig(exp) {
  if (exp.mode !== "one") return null;
  const x = BR.tabs.get(exp.id) || {};
  return JSON.stringify([exp.id, !!exp.live, !!x.need && x.need.kind, x.need ? x.need.summary : "", x.need ? x.need.url || "" : "", !!x.user, x.by || "", x.dl || "", !!x.blocked, x.blocked ? x.blocked.reason || "" : "", x.fail || "", x.url || "", typeof tvSig === "function" ? tvSig(exp.id) : ""]);
}
function brPaintTabStrip(bw) {
  bw.querySelectorAll(".bv-tab").forEach((tb) => {
    const y = BR.tabs.get(tb.dataset.id); if (!y) return;
    const st = tb.querySelector(".pt-st"); st.textContent = ""; const n = y.need ? brEl("span", "need-dot") : brStatusNode(y); if (n) st.append(n);
    // favicon 後到也要換上(分頁列不重建,這裡就地換)
    const fk = BR_FAVS.get(brHost(y.url)), want = fk ? fk.src + (fk.plate ? "|p" : "") : "", fv = tb.querySelector(".fav");
    if (fv && fv.__src !== want) { const nf = brFav(y.url); nf.__src = want; fv.replaceWith(nf); }
  });
}

// ── 事件 ─────────────────────────────────────────────────────
function brOnEvent(ev) {
  if (!ev || typeof ev !== "object") return;
  if (ev.session_id && typeof sessionId !== "undefined" && ev.session_id !== sessionId) return;
  const id = typeof ev.id === "string" ? ev.id : null;
  const x = id ? brTab(id) : null;
  switch (ev.type) {
    case "block_open":
      if (!BR.cur || !BR.cur.live) { BR.cur = brBlockNew(true); brAppend(BR.cur.el); brPaintHead(BR.cur); brObserve(); }
      return;
    case "pine_open": BR.pineNext = true; return;   // 下一個 user 分頁是「送進 TradingView」開的:回合進行中也不進 agent 的瀏覽卡
    case "pine_step": case "pine_result": if (typeof tvOnEvent === "function") tvOnEvent(ev); return;
    case "page_open":
      if (ev.by === "user" || ev.by === "agent") x.by = ev.by;
      if (ev.by === "user" && (BR.pineNext === true || !BR.cur || !BR.cur.live)) { BR.pineNext = false; x.url = String(ev.url || ""); x.ph = ev.queued ? "queued" : "load"; break; }   // 用戶自己開的(開即時頁、重試):不長區塊,展開層直接顯示
      if (!BR.cur || !BR.cur.live) { BR.cur = brBlockNew(true); brAppend(BR.cur.el); brObserve(); }
      if (BR_SERP.test(String(ev.url || ""))) { x.url = String(ev.url); x.search = true; x.ph = "load"; return; }   // 搜尋結果頁:不進清單(search 事件晚到,開頁當下就先認)
      if (!ev.queued && x.ph === "queued" && BR.cur.queued) BR.cur.queued--;   // 排隊的那頁輪到了
      x.url = String(ev.url || ""); x.ph = ev.queued ? "queued" : "load";
      if (typeof ev.alias === "string") x.alias = ev.alias;   // 狀態列用 kind_tab(alias)查網域
      if (ev.queued) BR.cur.queued++;
      brAddRow(BR.cur, id); scrollChat(); break;
    case "page_loaded": x.ph = x.ph === "done" ? "done" : "open"; if (ev.title) x.title = ev.title; if (ev.url) x.url = ev.url; break;
    case "page_nav": if (ev.url) x.url = ev.url; x.fail = null; x.blocked = null; x.dl = null; if (x.ph !== "queued") x.ph = "load"; break;
    case "page_title": x.title = ev.title || x.title; break;
    case "page_act": {
      const box = ev.box && [ev.box.x, ev.box.y, ev.box.w, ev.box.h].every(Number.isFinite) ? ev.box : null;
      x.act = { kind: String(ev.kind || ""), ref: ev.ref, text: ev.text, box, at: Date.now() };
      if (Number(ev.vw) > 0 && Number(ev.vh) > 0) { x.vw = Number(ev.vw); x.vh = Number(ev.vh); }
      if (["click", "type", "press"].includes(x.act.kind)) x.used = true;   // 拿來操作的頁:不標「未讀」
      if (BR_NOTE_KINDS.includes(x.act.kind)) { x.note = x.act; setTimeout(() => brPaint(id), 2600); }   // 看大綱 / 讀連結 / 讀標題與日期 / 看頁面結構 / 按鍵:訊息槽寫一下就回去
      else x.ph = x.act.kind === "scroll" ? "read" : "act";
      break;
    }
    case "page_progress": x.ph = "read"; x.prog = { n: Number(ev.n) || 0, total: Number(ev.total) || 0 }; x.band = Number.isFinite(ev.pos) ? ev.pos : x.band; break;
    case "page_extract": x.line = String(ev.line || ""); break;
    case "page_done": x.ph = "done"; if (ev.snapshot_id) x.snap = ev.snapshot_id; if (ev.relay) x.relay = true; if (ev.read && !ev.relay) x.readEver = true; break;
    case "page_favicon": brNoteFav(x.url, ev.dataURI, ev.plate); break;
    case "page_fail": x.fail = ["timeout", "dns", "http_4xx", "http_5xx"].includes(ev.reason) ? ev.reason : "network"; break;
    case "page_blocked":
      if (ev.kind === "download") x.dl = String(ev.detail || "");
      else { x.blocked = { kind: ev.kind === "domain" ? "domain" : "addr", reason: ev.reason || null, like: typeof ev.like === "string" ? ev.like : null, host: String(ev.detail || "") }; }
      break;
    case "page_discarded": if (ev.snapshot_id) x.snap = ev.snapshot_id; if (BR.exp && BR.exp.mode === "one" && BR.exp.id === id) brExpand(id); return;
    case "page_closed": return;
    case "need_user": x.need = { kind: String(ev.kind || "action"), summary: String(ev.summary || ""), url: typeof ev.url === "string" ? ev.url : "" }; if (x.need.kind === "captcha") brVerifyRow(id, true); srSay(t("br.waiting")); if (typeof actApply === "function") setTimeout(() => actApply(true), 0); break;
    case "need_clear": x.need = null; brVerifyRow(id, false); if (typeof actApply === "function") setTimeout(() => actApply(true), 0); break;
    case "user_takeover": x.user = true; if (!x.tracked) { x.tracked = true; trackFeature("browser_takeover"); } if (typeof tvOnEvent === "function") tvOnEvent(ev); break;
    case "handback": x.user = false; x.need = null; brVerifyRow(id, false); if (typeof actApply === "function") setTimeout(() => actApply(true), 0); break;
    case "thumb": if (typeof ev.dataURI === "string" && /^[A-Za-z0-9+/=]+$/.test(ev.dataURI)) x.thumb = "data:image/jpeg;base64," + ev.dataURI; break;
    case "search": if (x) {   // 搜尋結果頁不進清單、不算頁數、不進圖示疊(狀態列已經說了「正在搜尋:…」)
      x.search = true; if (!x.title) x.title = t("br.search");
      BR.blocks.forEach((b) => { const i = b.ids.indexOf(id); if (i >= 0 && !b.sum) { b.ids.splice(i, 1); b.wall.querySelectorAll(".pt").forEach((el) => { if (el.dataset.id === id) el.remove(); }); brPaintHead(b); } });
    } return;
    case "report_write": if (BR.cur && BR.cur.live) { BR.cur.writing = true; brPaintHead(BR.cur); if (BR.exp && BR.exp.mode === "wall") brPaintOverlay(); } return;
    case "turn_sources": {
      const b = BR.cur; BR.cur = null;
      for (const r of (ev.tabs || []).concat(ev.sources || [])) if (r) brNoteFav(r.url, r.fav, r.plate);
      if (b) { b.ids.slice().forEach((id) => brVerifyRow(id, false)); b.ids.forEach((id) => { const y = BR.tabs.get(id); if (y) { y.ended = true; brPaint(id); } }); brTakeSources(b, ev.tabs, ev.sources); brFinish(b); }
      brObserve(); return;
    }
    default: return;
  }
  if (id) brPaint(id);
}
window.blave.onBrowserEvent(brOnEvent);

// ── 舊對話:照時間把每一輪的摘要列插回逐字稿(app.js csOpen 用) ──
async function brHistoryItems(sid) {
  let rows = []; try { rows = await window.blave.browserHistory(sid); } catch (_) { return []; }
  const out = [];
  for (const r of rows || []) {
    if (!r || !Array.isArray(r.tabs) || !r.tabs.length) continue;
    out.push({ ts: Number(r.ts) || 0, br: { kind: "block", row: r } });
  }
  return out;
}
function brRestore(item) {
  const r = item.row;
  if (item.kind !== "block") return;
  const b = brBlockNew(false);
  // 整輪只操作沒讀的那一種(摘要寫「用了 N 頁」):紀錄裡分不出哪一頁被操作過,這一輪的頁都不標「未讀」
  const anyRead = r.tabs.some((tb) => tb && tb.status === "done" && !tb.search) || (Array.isArray(r.sources) && r.sources.length > 0);
  r.tabs.forEach((tb) => {
    if (!tb || typeof tb.id !== "string" || tb.search) return;   // 搜尋結果頁不進清單
    const x = brTab(tb.id); x.url = String(tb.url || ""); x.title = String(tb.title || ""); x.snap = tb.snapshot_id || null;
    x.ended = true; x.used = !anyRead;   // 舊對話:回合早就結束了——沒讀、也沒壞的頁就是「未讀」
    x.ph = tb.status === "done" ? "done" : "open"; x.search = !!tb.search; x.readEver = tb.status === "done"; brNoteFav(tb.url, tb.fav, tb.plate);
    if (tb.status === "blocked") x.blocked = { kind: "domain" }; else if (tb.status === "failed") x.fail = "network";
    brAddRow(b, tb.id);
  });
  const srcs = Array.isArray(r.sources) ? r.sources : [];
  srcs.forEach((s) => s && brNoteFav(s.url, s.fav, s.plate));
  brTakeSources(b, r.tabs, srcs);
  $("chat-scroll").appendChild(b.el);
  brFinish(b);
}
/* 換對話 / 新對話:區塊跟著聊天欄一起清掉;展開在中欄的收回 */
function brReset() { if (typeof tvReset === "function") tvReset(); brCollapse(false); BR.blocks = []; BR.cur = null; BR.tabs.clear(); if (BR.io) BR.io.disconnect(); }
function brRepaint() { BR.sig = null; BR.blocks.forEach((b) => { brPaintHead(b); b.ids.forEach((id) => { const x = BR.tabs.get(id); if (x) b.wall.querySelectorAll(".pt").forEach((el) => { if (el.dataset.id === id) brPaintTile(el, x); }); }); }); brPaintOverlay(); }

// ── 設定 › 隱私:內建瀏覽器開關 + 清除瀏覽資料(app.js privPaint 呼叫) ──
async function brPrivPaint(box) {
  let p = null; try { p = await window.blave.browserPrefs(); } catch (_) { return; }
  if (!box.isConnected || box.querySelector("#br-sw")) return;
  const row = brEl("div", "sw-row"); row.append(brEl("span", "sw-l", t("br.set.switch")));
  const sw = brEl("button", "sw" + (p && p.enabled ? "" : " off")); sw.type = "button"; sw.id = "br-sw";
  sw.setAttribute("role", "switch"); sw.setAttribute("aria-checked", p && p.enabled ? "true" : "false"); sw.setAttribute("aria-label", t("br.set.switch"));
  const lead = brEl("p", "priv-lead", t(p && p.enabled ? "br.set.lead" : "br.set.leadOff"));   // 隨開關換字(同頁「傳送使用資料」那顆的做法)
  sw.addEventListener("click", async () => { const on = sw.getAttribute("aria-checked") !== "true"; const r = await window.blave.browserPrefsSet({ enabled: on }); const v = !!(r && r.enabled); sw.classList.toggle("off", !v); sw.setAttribute("aria-checked", v ? "true" : "false"); lead.textContent = t(v ? "br.set.lead" : "br.set.leadOff"); if (typeof tvPrefs === "function") tvPrefs(); });
  row.append(sw);
  const clr = brEl("button", "btn-quiet", t("br.set.clear")); clr.type = "button";
  clr.addEventListener("click", async () => { const ok = await window.blave.browserClear(); if (ok) BR_FAVS.clear(); clr.textContent = t(ok ? "br.set.cleared" : "br.set.busy"); srSay(clr.textContent); setTimeout(() => { if (clr.isConnected) clr.textContent = t("br.set.clear"); }, 2500); });
  const legal = box.querySelector(".set-legal");
  const wrap = brEl("div", "br-set"); wrap.append(row, lead, clr);
  if (legal) box.insertBefore(wrap, legal); else box.append(wrap);
}
