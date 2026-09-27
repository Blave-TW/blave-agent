// 聊天回覆下方的來源卡拿掉了(Wei:上面的瀏覽區塊展開就看得到每一頁與 favicon):
//   1. 不再畫來源卡(即時與重開 app 都沒有),CSS 也清掉
//   2. 「讀了 N 頁」照主行程的來源紀錄算(扣搜尋頁),不是 DOM 裡的卡數;跟清單裡已讀的列數一致
//   3. 同一格讀過又導覽到別頁:前面讀過的頁補成摘要列的一列(有快照),不會因為拿掉來源卡就看不到
//   4. 重開 app:歷史對話只重建摘要列,計數與補列同上
// 跑法:node tests/check_shell_browser_no_source_cards.js
const fs = require("fs"), path = require("path");
const RD = path.join(__dirname, "..", "shell", "renderer");
const src = fs.readFileSync(path.join(RD, "browser.js"), "utf8"), css = fs.readFileSync(path.join(RD, "browser.css"), "utf8");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };

const fnCut = (name) => { let a = src.indexOf("function " + name + "("); if (src.slice(a - 6, a) === "async ") a -= 6; return src.slice(a, src.indexOf("\n}\n", a) + 3); };
function Node() { this.kids = []; this.text = ""; this.style = {}; }
Node.prototype.append = function (...k) { k.forEach((x) => this.kids.push(x)); };
const flat = (n) => (typeof n === "string" ? n : n && n.kids ? [n.text, ...n.kids.map(flat)].join("") : "");
function load(history) {
  const scroll = [], finished = [];
  const env = {
    BR: { tabs: new Map(), blocks: [], exp: null },
    brEl: (tag, cls, txt) => { const n = new Node(); n.text = txt || ""; return n; },
    brFav: () => new Node(), brIcon: () => new Node(), brNoteFav: () => {}, brPaintTile: () => {}, brCollapse: () => {}, trackFeature: () => {},
    t: (k) => "[" + k + "]",
    brBlockNew: () => ({ el: { tag: "block" }, ids: [], wall: { querySelectorAll: () => [] } }),
    brAddRow: (b, id) => { if (!b.ids.includes(id)) b.ids.push(id); },
    brFinish: (b) => finished.push(b),
    $: () => ({ appendChild: (el) => scroll.push(el) }),
    window: { blave: { browserHistory: async () => history || [] } },
  };
  const body = src.match(/function brTab\(id\) \{.*\}\n/)[0] + src.match(/const brIsRead = .*;/)[0] + "\n"
    + ["brTakeSources", "brPaintSum", "brHistoryItems", "brRestore"].map(fnCut).join("\n")
    + "; return { brTakeSources, brPaintSum, brHistoryItems, brRestore };";
  return Object.assign(new Function(...Object.keys(env), body)(...Object.values(env)), { BR: env.BR, scroll, finished });
}
const block = (ids) => ({ ids, wall: { querySelectorAll: () => [] } });
const sum = (F, b) => { const s = new Node(); b.sum = s; F.brPaintSum(b); return flat(s); };
const readRows = (F, b) => b.ids.map((id) => F.BR.tabs.get(id)).filter((x) => x && x.readEver && !x.search && !x.relay).length;

// ---- 1. 來源卡不再畫
ok("renderer 沒有來源卡:brSources / brLive / .srcs 都不在,turn_sources 不 append 卡片", !/brSources|brLive|"srcs"|brEl\("button", "src"\)/.test(src)
  && !/brAppend\(box\)/.test(src) && !/trackFeature\("browser_source"\)/.test(src));
ok("CSS 的 .src / .srcs 規則清掉", !/(^|[\s,])\.srcs?\b/m.test(css));

// ---- 2 + 3. 即時:t1 讀 A → 導覽到 B 又讀;t2 只開沒讀;t3 讀;搜尋頁讀過也不算
{
  const F = load(), T = F.BR.tabs;
  for (const id of ["t1", "t2", "t3"]) T.set(id, { id, url: "https://" + id + ".example/", ph: "done", readEver: id !== "t2" });
  T.set("g", { id: "g", url: "https://www.google.com/search?q=x", search: true, readEver: true });
  const b = block(["t1", "t2", "t3"]);
  F.brTakeSources(b,
    [{ id: "t1", snapshot_id: "SB" }, { id: "t2", snapshot_id: null }, { id: "t3", snapshot_id: "S3" }, { id: "g", snapshot_id: "SG", search: true }],
    [{ id: "t1", url: "https://t1.example/a", title: "A", snapshot_id: "SA" }, { id: "t1", url: "https://t1.example/b", snapshot_id: "SB" },
      { id: "t3", url: "https://t3.example/", snapshot_id: "S3" }, { id: "g", url: "https://www.google.com/search?q=x", snapshot_id: "SG" }]);
  const extra = T.get("src_SA");
  ok("導覽走之前讀過的 A 補成一列(網址、標題、快照都在,點開走 brExpand→即時頁/快照)", b.ids.includes("src_SA") && extra && extra.url === "https://t1.example/a" && extra.title === "A" && extra.snap === "SA" && extra.readEver, b.ids);
  ok("讀了 N 頁 = 來源筆數扣搜尋頁(3),不是 0", b.sourceCount === 3 && /\[br\.summaryPre\]3\[br\.summaryPost\]/.test(sum(F, b)), b.sourceCount);
  ok("清單裡已讀的列數 = 讀了 N 頁", readRows(F, b) === 3, readRows(F, b));
}
// ---- 3b. 讀完導覽走、新頁沒讀:那一格不再算已讀(不重複數)
{
  const F = load(), T = F.BR.tabs;
  T.set("t1", { id: "t1", url: "https://t1.example/b", ph: "done", readEver: true });
  const b = block(["t1"]);
  F.brTakeSources(b, [{ id: "t1", snapshot_id: null, status: "done" }], [{ id: "t1", url: "https://t1.example/a", snapshot_id: "SA" }]);
  ok("讀完導覽走沒再讀:補一列 A、原格不算已讀 → 讀了 1 頁、已讀 1 列", b.ids.length === 2 && !T.get("t1").readEver && readRows(F, b) === 1 && /\[br\.summaryPre\]1\[br\.summaryPost\]/.test(sum(F, b)));
}
// ---- 2c. 主行程記了來源、renderer 沒收到 page_done(沒有分頁紀錄時):認那一格,不補重複的列
{
  const F = load(), T = F.BR.tabs;
  T.set("q1", { id: "q1", url: "https://q1.example/", ph: "open" });
  const b = block(["q1"]);
  F.brTakeSources(b, [], [{ id: "q1", url: "https://q1.example/", snapshot_id: "S1" }]);
  ok("來源的那一格標成已讀,不另補列", b.ids.length === 1 && T.get("q1").readEver && b.sourceCount === 1);
}
// ---- 4. 重開 app:歷史只重建摘要列
(async () => {
  const hist = [{ ts: 1, end: 2, tabs: [{ id: "h1", url: "https://h1.example/b", status: "done", snapshot_id: "HB" }, { id: "h2", url: "https://h2.example/", status: "open", snapshot_id: null }],
    sources: [{ id: "h1", url: "https://h1.example/a", snapshot_id: "HA" }, { id: "h1", url: "https://h1.example/b", snapshot_id: "HB" }] }];
  const F = load(hist);
  const items = await F.brHistoryItems("sid");
  ok("歷史每一輪只回一個摘要列項目(沒有 src 項)", items.length === 1 && items[0].br.kind === "block", items);
  F.brRestore(items[0].br);
  const b = F.finished[0];
  ok("重建後聊天欄只插摘要列一個元素(摘要列照樣收成一行)", F.scroll.length === 1 && F.scroll[0].tag === "block" && F.finished.length === 1, F.scroll);
  ok("歷史的讀了 N 頁 = 來源筆數(2),導覽前那頁補成一列(有快照)、已讀列數一致",
    b.ids.includes("src_HA") && F.BR.tabs.get("src_HA").snap === "HA" && b.sourceCount === 2 && readRows(F, b) === 2 && /\[br\.summaryPre\]2\[br\.summaryPost\]/.test(sum(F, b)), b.ids);
  console.log(red ? "\n" + red + " FAILED" : "\nALL PASS");
  process.exit(red ? 1 : 0);
})();
