// 電腦版 0.0.5 視覺修(設計師 spec-desktop-005-polish + audit-desktop-005),要真的排出來 / 真的跑 DOM 才驗得到的幾條。
// 用隨包的 Electron 開真的 index.html + CSS,window.blave 換成假的(不起主行程、不碰 workspace、不連網):
//   ① §3 自動下單的內容上限 760、靠左;頁首跟著收到同一條右緣(〔啟動下單〕對齊表格右緣);窄的時候不受影響;引導畫面不套
//   ② §2 雲端視角的輸入框跟這台電腦一樣:底色、框線、placeholder 色(--ink-3)都相同
//   ③ 稽核 12 出錯的回合:工具收據自己攤開,思考文字收著、下面一顆「顯示思考內容」;正常回合照舊收起
// 跑法:node tests/check_shell_polish005.js(找不到 shell/node_modules 的 Electron 就 SKIP)
const path = require("path"), fs = require("fs");
const SHELL = path.join(__dirname, "..", "shell");

if (!process.versions.electron) {
  const bin = path.join(SHELL, "node_modules", ".bin", "electron");
  if (!fs.existsSync(bin)) { console.log("SKIP  找不到 shell/node_modules 的 Electron(先 cd shell && npm install)"); process.exit(0); }
  const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit" });
  process.exit(r.status == null ? 1 : r.status);
}

const { app, BrowserWindow } = require("electron");
const os = require("os");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "blave-p005-")));
const STUB = `window.blave = new Proxy({}, { get: (_, k) => typeof k !== "string" ? undefined
  : k.startsWith("on") ? () => {} : k === "tradeLabels" ? () => {}
  : async () => ({ getLocale: "zh-TW", loadConnection: { kind: "claude" }, detectAgents: { claude: { installed: true, loggedIn: true }, codex: { installed: false } },
      listStrategies: [], listSessions: [], loadSession: [], loadSessionImages: [], updateState: { phase: "idle", current: "0.0.0" } })[k] });`;
let red = 0; const ok = (n, c) => { console.log((c ? "PASS  " : "FAIL  ") + n); if (!c) red++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log("FAIL  逾時(60 秒)"); process.exit(1); }, 60000).unref();

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  const pre = path.join(app.getPath("userData"), "stub.js"); fs.writeFileSync(pre, STUB);
  const w = new BrowserWindow({ width: 1800, height: 900, show: false, webPreferences: { offscreen: true, preload: pre, contextIsolation: false, sandbox: false } });
  await w.loadFile(path.join(SHELL, "renderer", "index.html"));
  await wait(1200);
  const js = (s) => w.webContents.executeJavaScript(s, true);

  // ① 放一張部位表進 #tr-pos(真的 class:.pf-scroll > table.pf-tbl)、頁首右上一顆鈕,量位置
  const MEASURE = `(() => {
    ["rp", "main-empty", "cv-empty"].forEach((id) => { $(id).hidden = true; }); $("tr").hidden = false; $("tr-tabs").hidden = false;
    ["tr-over", "tr-assets", "tr-hist", "tr-set", "tr-onboard"].forEach((id) => { $(id).hidden = true; }); $("tr-pos").hidden = false;
    $("tr-pos").textContent = ""; const sc = document.createElement("div"); sc.className = "pf-scroll";
    const tb = document.createElement("table"); tb.className = "pf-tbl"; tb.innerHTML = "<tbody><tr><td>BTCUSDT</td><td class='n'>+1,000</td><td class='n'>+1,000</td><td class='n'>0</td></tr></tbody>";
    sc.appendChild(tb); $("tr-pos").appendChild(sc);
    $("tr-act").textContent = ""; const b = document.createElement("button"); b.className = "btn-fill"; b.textContent = "啟動下單"; $("tr-act").appendChild(b);
    const r = (e) => e.getBoundingClientRect(), pos = r($("tr-pos")), t = r(tb), btn = r(b), tabs = r($("tr-tabs"));
    const pad = parseFloat(getComputedStyle($("tr-pos")).paddingLeft);
    return { col: Math.round(pos.width), tblW: Math.round(t.width), tblL: Math.round(t.left - pos.left - pad), tblR: Math.round(t.right), btnR: Math.round(btn.right), tabsW: Math.round(tabs.width), sbR: Math.round(pos.right), pad };
  })()`;
  await js(`paneToggle("chat", true)`); await wait(200);
  const wide = await js(MEASURE);
  ok(`① 寬欄(內容欄 ${wide.col}px、聊天欄收起):表格上限 760、靠左(左緣 = 內容欄起點)`, wide.col > 900 && wide.tblW === 760 && wide.tblL === 0);
  ok(`① 頁首跟著收:〔啟動下單〕右緣 = 表格右緣(${wide.btnR} vs ${wide.tblR})`, Math.abs(wide.btnR - wide.tblR) <= 1);
  ok("① 分頁列不收(底線跨滿整欄);捲動容器本身照舊整欄寬(捲軸在欄的右緣)", wide.tabsW >= wide.col - 1 && wide.sbR - wide.tblR > 100);
  await js(`paneToggle("chat", false)`); w.setSize(1100, 900); await wait(300);
  const narrow = await js(MEASURE);
  ok(`① 窄的時候不受影響:內容欄 ${narrow.col}px → 表格照舊撐滿(扣掉左右內距 ${narrow.pad})、頁首的鈕照舊對齊`, narrow.tblW < 760 && narrow.tblW === narrow.col - 2 * narrow.pad && Math.abs(narrow.btnR - narrow.tblR) <= 1);
  w.setSize(1800, 900); await js(`paneToggle("chat", true)`); await wait(200);
  const ob = await js(`(() => { $("tr-pos").hidden = true; const o = $("tr-onboard"); o.hidden = false; o.innerHTML = "<div class='pf-onboard'><p>x</p></div>";
    const r = o.getBoundingClientRect(), c = o.firstChild.getBoundingClientRect(); return { mid: Math.round((c.left + c.right) / 2), colMid: Math.round((r.left + r.right) / 2) }; })()`);
  ok("① 還沒連交易所的引導畫面不套上限:照舊在整欄置中", Math.abs(ob.mid - ob.colMid) <= 1);
  await js(`paneToggle("chat", false)`);

  // ② 兩個視角的輸入框
  const look = `(() => { const ci = document.querySelector(".chat-input"), ta = $("ta"), cs = getComputedStyle(ci);
    return [cs.backgroundColor, cs.borderTopColor, getComputedStyle(ta, "::placeholder").color, getComputedStyle(document.documentElement).getPropertyValue("--ink-3").trim()]; })()`;
  await js(`document.documentElement.dataset.env = "local"`); const lo = await js(look);
  await js(`document.documentElement.dataset.env = "cloud"`); const cl = await js(look);
  ok(`② 雲端輸入框跟這台電腦一樣:底色、框線、placeholder(${cl[2]})`, JSON.stringify(lo.slice(0, 3)) === JSON.stringify(cl.slice(0, 3)));
  const ink3 = await js(`(() => { const d = document.createElement("span"); d.style.color = "var(--ink-3)"; document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return c; })()`);
  ok("② placeholder 是 --ink-3", cl[2] === ink3);
  await js(`document.documentElement.dataset.env = "local"`);

  // ③ 出錯的回合 / 正常的回合
  const turn = (faulted, reason) => js(`(() => {
    busyStart(); busyStep({ tool: "Bash", summary: "python strategy.py", id: "s1" }); busyStepDone({ id: "s1", error: true, ms: 1200 });
    ${reason ? `busyReason("The user wants me to run the backtest first.");` : ""}
    const el = busy.el; busyEnd(${faulted});
    const rs = el.querySelector(".think-reason"), show = el.querySelector(".think-reason-show");
    return { open: el.classList.contains("is-open"), aria: el.querySelector(".think-head").getAttribute("aria-expanded"),
      stepsShown: el.querySelector(".think-steps").getBoundingClientRect().height > 0, reasonShown: rs.getBoundingClientRect().height > 0,
      show: show ? show.textContent : null, id: (el.id = "turn" + Math.random().toString(36).slice(2)) };
  })()`);
  await wait(50);
  const f = await turn(true, true); await wait(400);
  const f2 = await js(`(() => { const el = $("${f.id}"); return { stepsShown: el.querySelector(".think-steps").getBoundingClientRect().height > 0, reasonShown: el.querySelector(".think-reason").getBoundingClientRect().height > 0 }; })()`);
  ok("③ 出錯的回合:整塊自己攤開(is-open、aria-expanded=true),工具收據看得到", f.open && f.aria === "true" && f2.stepsShown);
  ok("③ …思考文字收著,下面一顆「顯示思考內容」", !f2.reasonShown && f.show === (await js(`t("turn.showReason")`)));
  const g = await js(`(() => { const el = $("${f.id}"); el.querySelector(".think-reason-show").click();
    return { reasonShown: el.querySelector(".think-reason").getBoundingClientRect().height > 0, gone: !el.querySelector(".think-reason-show"), focus: document.activeElement === el.querySelector(".think-reason") }; })()`);
  ok("③ 按了才出思考文字;鈕收掉、焦點接到那段字", g.reasonShown && g.gone && g.focus);
  const n = await turn(false, true);
  ok("③ 正常的回合:照舊收起(不自己攤開、沒有那顆鈕)", !n.open && n.aria === "false" && n.show === null);
  const e = await turn(true, false);
  ok("③ 出錯但沒有思考文字:攤開收據、不多一顆鈕", e.open && e.show === null);
  const src = fs.readFileSync(path.join(SHELL, "renderer", "app.js"), "utf8");
  ok("③ 接線:turn-end 算出 faulted(同 upTurnEnded 的判準)交給 busyEnd", /const faulted = r\.code !== 0 \|\| turnFaulted \|\| turnErrored \|\| !turnGotReply \|\| loggedOut;[^\n]*\n\s*busyEnd\(faulted\);/.test(src));

  console.log(red ? `\n${red} 紅` : "\nALL PASS");
  app.exit(red ? 1 : 0);
});
