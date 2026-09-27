// 動態收斂(canon 電腦版內建瀏覽器 第 9 條「密集判定」;pace.js):
//   進門檻:下一動作在前一動作結束後 1.2s 內(或前一動作還沒結束)到達=密集,該動作起瞬間模式
//   第一動作永遠完整;瞬間模式維持到結束後 3s 沒新動作;密集觸發時前一動作還在播的標記跳終態
//   瞬間模式:讀取帶直接落定、游標直接出現、環只留靜止單幀、字一次填入、捲動瞬間;讀也算動作
//   reduced-motion 優先(連單幀環都不出)。全在 app 端自己的時鐘判,不加 runtime 欄位。
// 跑法:node tests/check_shell_browser_pace.js(找不到 Electron 只跑純函式+接線段)
const path = require("path"), fs = require("fs"), os = require("os");
const SHELL = path.join(__dirname, "..", "shell");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };

// ---- 純函式:進退門檻
{
  const { createPace, DENSE_GAP_MS, EXIT_IDLE_MS } = require(path.join(SHELL, "browser", "pace"));
  ok("門檻值照 canon(1.2s 進、3s 退)", DENSE_GAP_MS === 1200 && EXIT_IDLE_MS === 3000);
  let t = 0; const p = createPace(() => t);
  ok("第一動作永遠完整", p.arrive().mode === "full");
  t = 500; p.end();                                  // 0.5s 做完
  t = 1600; ok("結束後 1.1s 內到達 → 密集(瞬間模式)", p.arrive().mode === "instant");
  t = 1650; p.end();
  t = 4500; ok("瞬間模式:結束後 2.85s 到達 → 續留瞬間", p.arrive().mode === "instant");
  t = 4550; p.end();
  t = 7650; ok("結束後 3.1s 沒新動作 → 回完整效果", p.arrive().mode === "full");
  t = 7700; p.end();
  t = 9000; const a1 = p.arrive();                   // 新的一串:完整
  ok("新一串第一動作完整", a1.mode === "full");
  const a2 = p.arrive();                             // 前一動作還沒 end 就到 → 密集+跳終態
  ok("前一動作還在播 → 密集,而且要把它的標記跳終態(cut)", a2.mode === "instant" && a2.cut === true);
  p.end(); p.end();
  t = 9100; ok("完整模式下 1.2s 內接著來(前一個已結束)→ 密集但不用跳終態", JSON.stringify(p.arrive()) === '{"mode":"instant","cut":false}');
}

// ---- 接線(index.js 四種動作)與 inpage 的 settle / 靜止環
{
  const idx = fs.readFileSync(path.join(SHELL, "browser", "index.js"), "utf8");
  const ip = fs.readFileSync(path.join(SHELL, "browser", "inpage.js"), "utf8");
  ok("每個分頁自己的 pace(v.pace = createPace())", /pace: createPace\(\),/.test(idx));
  ok("讀:密集=per 0(帶直接落定)、不跟著捲、cut 先 settle;結束=帶落定(完整模式排時間)",
    /const per = inst \? 0 : Math\.min\(240, Math\.floor\(1600 \/ read\.length\)\);/.test(idx)
    && /const follow = !reduced && !inst &&/.test(idx)
    && /if \(pace\.cut\) v\.page\.run\(IP\.mark, \["settle"\]\)/.test(idx)
    && /if \(inst \|\| reduced \|\| !per\) v\.pace\.end\(\);\n\s*else setTimeout\(\(\) => v\.pace\.end\(\), Math\.min\(1600, read\.length \* per\) \+ 60\);/.test(idx));
  ok("捲:密集=瞬間完成;捲完=結束", /paceS\.mode === "instant" \? 0 : spend\(t, 300\) \? 300 : 0\);/.test(idx) && /v\.pace\.end\(\);   \/\/ 捲完=結束/.test(idx));
  ok("點/填共用:cut 先 settle、密集不滑行", /if \(pace\.cut\) await v\.page\.run\(IP\.mark, \["settle"\]\)/.test(idx) && /const glide = !inst && onScreen && spend\(t, 300\) \? 260 : 0;/.test(idx));
  ok("點:落地=結束(不含環 0.45s;沒按下去也收);環帶 instant 旗標", /v\.pace\.end\(\);   \/\/ 點擊落地=結束/.test(idx) && /\["click", \{ x: pos\.x, y: pos\.y, instant: inst \}, reduced\]/.test(idx));
  ok("填:密集=字一次填入;填完=結束", /const perChar = !inst && text\.length <= 40/.test(idx) && /v\.pace\.end\(\);   \/\/ 填完=結束/.test(idx));
  ok("inpage settle:讀取帶落定(__fin force)、環/框收掉、游標跳到目標",
    /if \(kind === "settle"\) \{/.test(ip) && /if \(host\.__fin\) \{ const f = host\.__fin; host\.__fin = null; f\(\); \}/.test(ip)
    && /querySelectorAll\("\.b,\.f,\.r"\)/.test(ip) && /const finish = \(force\) => \{\n      if \(!force && host\.__g !== g\) return;/.test(ip));
  ok("新的 read / frames 進來,舊的落定收尾作廢", /host\.__fin = null;   \/\/ 舊讀取帶的落定收尾跟著作廢/.test(ip));
  ok("靜止單幀環(.r.s:不放大不淡出);reduced 優先連單幀都不出",
    /\.r\.s\{animation:none;transform:scale\(1\);opacity:1\}/.test(ip)
    && /if \(reduced\) return true;   \/\/ 減少動態優先/.test(ip)
    && /el\(data\.instant \? "r s" : "r",/.test(ip));
  ok("不加 runtime 欄位(pace 只活在 shell/browser)", !/createPace|v\.pace|tool_pace/.test(fs.readFileSync(path.join(SHELL, "..", "runtime", "agent_turn.py"), "utf8")));
}

if (!process.versions.electron) {
  const bin = path.join(SHELL, "node_modules", ".bin", "electron");
  if (!fs.existsSync(bin)) { console.log("SKIP  真 Electron 那段(行為:連續打字第二次起一次填入、3s 後回逐字)"); process.exit(red ? 1 : 0); }
  const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit" });
  process.exit(red || r.status ? 1 : 0);
}

// ---- 行為(真 Electron):連續 type 的 input 事件數——第一次逐字(N 次)、緊接著的一次填入(1 次)、3s 後回逐字
const electron = require("electron");
const { app, BrowserWindow, session } = electron;
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "blave-pace-")));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.on("unhandledRejection", (e) => { console.log("UNHANDLED:", String(e)); app.exit(3); });
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1200, height: 800, show: true });
  await win.loadURL("data:text/html,<p>host</p>");
  const srv = require("http").createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end('<title>p</title><article><p>' + "Words here. ".repeat(40) + '</p><input aria-label="note"><button>go</button></article><script>window.__ev=[];document.querySelector("input").addEventListener("input",()=>window.__ev.push(Date.now()));</script>');
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const ses = session.fromPartition("persist:agent-browser");
  await ses.setProxy({ proxyRules: "http=127.0.0.1:" + srv.address().port, proxyBypassRules: "<-loopback>" });
  const B = require(path.join(SHELL, "browser")).createBrowser({ electron, stateDir: path.join(app.getPath("userData"), "s"), getWin: () => win, uiLang: () => "en", track: () => {}, version: "test" });
  await B.beginTurn(win, "desktop-pace");
  const ctx = { live: () => true };
  const call = async (n, a) => JSON.parse((await B._call(n, a || {}, ctx)).content[0].text);
  const r = await call("browser_open", { url: "http://pace.test/a" });
  await call("browser_wait", { tab: r.tab });
  B.expand(B._tabs.byAlias(r.tab).id, { x: 20, y: 60, width: 900, height: 600 });
  await sleep(600);
  const kid = win.contentView.children.find((c) => c.webContents && c.webContents.getURL().includes("pace.test"));
  const evCount = async () => kid.webContents.executeJavaScript("(() => { const n = (window.__ev || []).length; window.__ev = []; return n; })()").catch((e) => "ERR:" + e);
  let ref = null;
  for (let i = 0; i < 5 && !ref; i++) {   // 頁面偶爾還在畫:重拍到看得到輸入欄
    const snap = await call("browser_snapshot", { tab: r.tab, interactive_only: true });
    const line = String(snap.untrusted_content).split("\n").find((l) => /textbox/.test(l));
    if (line) ref = line.match(/\[(@e\d+)\]/)[1]; else await sleep(700);
  }
  ok("找得到輸入欄", !!ref);
  if (!ref) { console.log(red + " FAILED"); app.exit(1); return; }
  await call("browser_type", { tab: r.tab, ref, text: "abcdefgh" });
  const n1 = await evCount();
  ok("第一動作完整:逐字(8 字 → 多次 input 事件)", n1 >= 6, n1);
  await call("browser_type", { tab: r.tab, ref, text: "abcdefgh" });   // 緊接著=密集
  const n2 = await evCount();
  ok("密集:一次填入(1 次 input 事件)", n2 === 1, n2);
  await sleep(3300);   // 結束後 3s 沒新動作 → 回完整
  await call("browser_type", { tab: r.tab, ref, text: "abcdefgh" });
  const n3 = await evCount();
  ok("3s 沒動作:回完整(又逐字)", n3 >= 6, n3);
  console.log(red ? `\n${red} FAILED` : "\nALL PASS");
  app.exit(red ? 1 : 0);
});
