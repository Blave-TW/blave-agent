// 來源快照(shell/browser/snapshots.js):存 / 讀 / 每 session 上限 / 全體容量上限 / 刪對話連刪 / 檔案 0600 / 壞 id 拒收。
// 跑法:node tests/check_shell_browser_snapshots.js
const fs = require("fs"), os = require("os"), path = require("path");
const { createSnapshots } = require("../shell/browser/snapshots");
let red = 0; const t = (n, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) red++; };
const root = fs.mkdtempSync(path.join(os.tmpdir(), "blv-snap-"));
try {
  const S = createSnapshots(root, { perSession: 3, totalBytes: 5000 });
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  const id = S.save("desktop-abcd1234", { url: "https://x.example/a", title: "A", markdown: "# A\n\nbody", image: { data: png, ext: "png" }, turn: 1 });
  t("存一份回 s<16 hex>", /^s[0-9a-f]{16}$/.test(id));
  const got = S.load("desktop-abcd1234", id);
  t("讀回:網址、標題、全文、圖是 data URI", got.url === "https://x.example/a" && got.title === "A" && got.markdown === "# A\n\nbody" && got.image.startsWith("data:image/png;base64,"));
  if (process.platform !== "win32") {
    const mode = fs.statSync(path.join(root, "desktop-abcd1234", id, "page.md")).mode & 0o777;
    t("檔案 0600", mode === 0o600);
  }
  t("壞 session id / 壞 snapshot id(路徑穿越)一律拒", S.save("../x", { url: "u" }) === null && S.load("desktop-abcd1234", "../../etc") === null && S.load("desktop-abcd1234/..", id) === null);
  const ids = [id];
  for (let i = 0; i < 4; i++) { const now = Date.now; Date.now = () => now() - (10 - i) * 1000; ids.push(S.save("desktop-abcd1234", { url: "https://x.example/" + i, title: "T" + i, markdown: "m" })); Date.now = now; }
  const left = fs.readdirSync(path.join(root, "desktop-abcd1234")).filter((n) => /^s/.test(n));
  t("每 session 上限:超過從最舊刪(上限 3)", left.length === 3 && [ids[0], ids[3], ids[4]].every((x) => left.includes(x)) && !left.includes(ids[1]) && !left.includes(ids[2]));
  const big = S.save("desktop-eeee1111", { url: "https://y.example/", title: "Y", markdown: "y".repeat(4700) });
  const size = (d) => fs.readdirSync(d).reduce((n, x) => { const f = path.join(d, x); const st = fs.statSync(f); return n + (st.isDirectory() ? size(f) : st.size); }, 0);
  const snapBytes = ["desktop-abcd1234", "desktop-eeee1111"].reduce((n, sid) => n + fs.readdirSync(path.join(root, sid)).filter((x) => /^s/.test(x)).reduce((m, x) => m + size(path.join(root, sid, x)), 0), 0);
  t("全體容量上限:超過從最舊刪(上限 5000 bytes),新存的留著", snapBytes <= 5000 && fs.existsSync(path.join(root, "desktop-eeee1111", big)) && fs.readdirSync(path.join(root, "desktop-abcd1234")).filter((n) => /^s/.test(n)).length < 3);
  const PNG = "data:image/png;base64,iVBORw0KGgo=";
  t("favicon:只收 data:image/… 的 base64,其他(遠端網址、text/html、帶 script)拒收", S.saveFavicon("desktop-abcd1234", "a.example", PNG) === true && S.saveFavicon("desktop-abcd1234", "b.example", "https://b.example/favicon.ico") === false
    && S.saveFavicon("desktop-abcd1234", "c.example", "data:text/html;base64,PHNjcmlwdD4=") === false && S.saveFavicon("desktop-abcd1234", "d.example", "data:image/png;base64," + "A".repeat(200000)) === false);
  t("favicon:讀回是 host → data URL;檔案在 session 目錄底下", S.favicons("desktop-abcd1234")["a.example"].data === PNG && !S.favicons("desktop-abcd1234")["b.example"]);
  S.logTurn("desktop-abcd1234", { ts: 1, tabs: [{ id: "p1", url: "https://x.example/", status: "done" }] });
  t("每輪紀錄可讀回(重開 app 重建瀏覽區塊)", S.turns("desktop-abcd1234").length === 1 && S.turns("desktop-abcd1234")[0].tabs[0].id === "p1");
  S.removeSession("desktop-abcd1234");
  t("刪對話連快照與紀錄一起刪", !fs.existsSync(path.join(root, "desktop-abcd1234")));
  S.clearAll();
  t("清除瀏覽資料:全部快照刪掉", fs.readdirSync(root).length === 0);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log(red ? `\n${red} FAILED` : "\nALL PASS");
process.exit(red ? 1 : 0);
