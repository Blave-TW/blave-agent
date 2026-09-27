// @eN ref 標籤退開發旗標(canon 電腦版內建瀏覽器 第 4 條裁定):用戶只看到 1.5px 墨色目標
// outline;標籤只在 BLAVE_BROWSER_DEV_MARKS=1 才畫(預設關)。「由你按」(need)照舊——那是給
// 用戶的指示。點擊落地收框時標籤同收(本來就跟 .o 一起清)。
// 跑法:node tests/check_shell_browser_ref_label_dev.js(找不到 Electron 只跑靜態段)
const path = require("path"), fs = require("fs"), os = require("os");
const SHELL = path.join(__dirname, "..", "shell");
const GATE = require("./_electron_gate");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };

if (!process.versions.electron) {
  const idx = fs.readFileSync(path.join(SHELL, "browser", "index.js"), "utf8");
  const ip = fs.readFileSync(path.join(SHELL, "browser", "inpage.js"), "utf8");
  ok("旗標=環境變數 BLAVE_BROWSER_DEV_MARKS,預設關", /const DEV_MARKS = process\.env\.BLAVE_BROWSER_DEV_MARKS === "1";/.test(idx));
  ok("ref 標記把旗標帶進頁面(tag: DEV_MARKS)", /\["ref", \{ box: pos\.box, label, tag: DEV_MARKS \}, reduced\]/.test(idx));
  ok("按鍵小標(press 的「Enter」)照常顯示、不掛旗標(canon 裁定:那不是 @eN 內部代號)", /\["ref", \{ box: q\.box, label: key, tag: true \}, false\]/.test(idx));
  ok("inpage:outline 一律畫、小標只在 need 或 data.tag", /if \(kind === "need" \|\| data\.tag\) \{/.test(ip));
  ok("點擊落地收框連小標一起(原本的 .o,.t 同清)", /if \(kind === "click"\) \{\n    for \(const n of Array\.from\(root\.querySelectorAll\("\.o,\.t"\)\)\) n\.remove\(\);/.test(ip));
  const bin = GATE.bin(SHELL);
  if (!bin) { process.exit(red ? 1 : 0); }
  const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit" });
  process.exit(red || r.status ? 1 : 0);
}

// ---- 行為:把真的 mark() 丟進頁面跑(closed shadow 的 root 存在 host.__r,同 world 拿得到)
const electron = require("electron");
const { app, BrowserWindow } = electron;
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "blave-refdev-")));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 800, height: 600, show: false });
  await win.loadURL("data:text/html,<p>x</p>");
  const IP = require(path.join(SHELL, "browser", "inpage"));
  const boot = "window.__mark = " + IP.mark.toString() + ";";
  await win.webContents.executeJavaScript(boot + "0");
  const q = (expr) => win.webContents.executeJavaScript(expr);
  const state = () => q(`(() => { const h = document.getElementById("__blave_agent_marks"); if (!h) return null;
    const r = h.__r; return { o: r.querySelectorAll(".o").length, t: [...r.querySelectorAll(".t")].map((e) => e.textContent) }; })()`);
  await q(`__mark("ref", { box: { x: 30, y: 40, w: 100, h: 20 }, label: "@e7", tag: false }, false)`);
  ok("預設(旗標關):只有 outline、沒有 @eN 小標", JSON.stringify(await state()) === '{"o":1,"t":[]}', await state());
  await q(`__mark("ref", { box: { x: 30, y: 40, w: 100, h: 20 }, label: "@e7", tag: true }, false)`);
  ok("旗標開:小標畫出來(@e7)", JSON.stringify(await state()) === '{"o":1,"t":["@e7"]}', await state());
  await q(`__mark("click", { x: 80, y: 50 }, false)`);
  ok("點擊落地:框與小標同收", JSON.stringify(await state()) === '{"o":0,"t":[]}', await state());
  await q(`__mark("need", { box: { x: 30, y: 40, w: 100, h: 20 }, label: "由你按" }, false)`);
  const st = await state();
  ok("need(由你按)照舊有小標", st.o === 1 && st.t[0] === "由你按", st);
  await q(`__mark("ref", { box: { x: 30, y: 40, w: 100, h: 20 }, label: "Enter", tag: true }, false)`);
  const st2 = await state();
  ok("按鍵小標(tag:true,預設就畫):旗標關著「Enter」也在", st2.o === 1 && st2.t[0] === "Enter", st2);
  console.log(red ? `\n${red} FAILED` : "\nALL PASS");
  app.exit(red ? 1 : 0);
});
