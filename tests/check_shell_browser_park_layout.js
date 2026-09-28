// 背景(parked)分頁的桌機排版(Wei 實測:agent 開的 TradingView 是行動版,連 Pine Editor 入口都沒有):
// 視窗外的 view 會被 macOS 裁到 0 寬(實測 innerWidth = 0),頁面用 0 視口排版就出行動版、SPA 路由也會壞。
// 修法:parked 分頁常駐 1280×800 的 Emulation.setDeviceMetricsOverride——設一次不再動(不閃,跟擷取路徑
// 每次切 override 的舊閃爍問題不同);進中欄時 bounds() 的 unEmulate 清掉、用真實大小。
// 跑法:node tests/check_shell_browser_park_layout.js
const fs = require("fs");
const path = require("path");
const SHELL = path.join(__dirname, "..", "shell");
const src = fs.readFileSync(path.join(SHELL, "browser", "index.js"), "utf8");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---- 接線
ok("park() 每次停靠都補常駐 override", /function park\(v, i\) \{[^\n]*parkEmulate\(v\);/.test(src));
// 首次 override 下在 did-start-navigation:renderer 已在、文件還沒解析;createView 當下就下會
// SIGSEGV(沒載過東西的 webContents 碰 emulation 會炸,實測)
ok("首次 override 在 did-start-navigation(非展開的分頁)", /did-start-navigation[\s\S]{0,600}if \(!t\.visible\) parkEmulate\(v\);/.test(src));
ok("進中欄(bounds → setBounds)清 override 用真實大小", /v\.view\.setBounds\(nb\); unEmulate\(v\);/.test(src));
ok("unEmulate 同時清 flag(下次 park 才會重設);寬版面排版中(第七批 #6)不清,改成重算寬版面", /function unEmulate\(v\) \{ if \(v\.wide\) \{ wideEmulate\(v\); return; \} v\.parkEmu = false;/.test(src));
ok("endTurn 整頁擷取後把非展開的分頁補回 park override", /if \(expanded !== r\.id\) parkEmulate\(v\);/.test(src));

// ---- parkEmulate 行為(抽真函式):成功才設 flag;失敗可重試(race 修正);設過就不再送(不閃)
const fnCut = (name) => { const a = src.indexOf("  function " + name + "("); return src.slice(a, src.indexOf("\n  }\n", a) + 4); };
const mk = (behave) => { const calls = []; return { calls, v: { wc: { debugger: { sendCommand: (m, p) => { calls.push([m, p]); return behave(); } } } } }; };
const parkSize = { width: 1280, height: 800 };
const run = new Function("parkSize", fnCut("parkEmulate") + fnCut("unEmulate") + "; return { parkEmulate, unEmulate };")(parkSize);
(async () => {
  const okCase = mk(() => Promise.resolve({}));
  run.parkEmulate(okCase.v); await tick();
  ok("成功:送 1280×800 desktop override、flag 設起來", okCase.v.parkEmu === true && okCase.calls.length === 1
    && okCase.calls[0][0] === "Emulation.setDeviceMetricsOverride"
    && okCase.calls[0][1].width === 1280 && okCase.calls[0][1].height === 800 && okCase.calls[0][1].mobile === false, okCase.calls);
  run.parkEmulate(okCase.v);
  ok("設過就不再送(常駐一次,不會像舊擷取路徑那樣反覆切)", okCase.calls.length === 1, okCase.calls.length);
  run.unEmulate(okCase.v); await tick();
  ok("unEmulate 清 flag+送 clearDeviceMetricsOverride,之後 park 會重設", okCase.v.parkEmu === false
    && okCase.calls.some(([m]) => m === "Emulation.clearDeviceMetricsOverride")
    && (run.parkEmulate(okCase.v), await tick(), okCase.v.parkEmu === true), okCase.calls);

  // race 修正:debugger 還沒掛 → reject → flag 不能先設(先設再清會讓 attach 後那次補設提前 return)
  const failCase = mk(() => Promise.reject(new Error("not attached")));
  run.parkEmulate(failCase.v);
  ok("失敗中途 flag 不先設(同步視角)——attach 後的補設不會被擋", failCase.v.parkEmu !== true);
  await tick();
  failCase.v.wc.debugger.sendCommand = (m, p) => { failCase.calls.push([m, p]); return Promise.resolve({}); };
  run.parkEmulate(failCase.v); await tick();
  ok("失敗後可重試成功", failCase.v.parkEmu === true && failCase.calls.length === 2, failCase.calls.length);

  // 世代計數(稽核 A-P2-1):override 送出後、resolve 前 unEmulate → resolve 不得把 flag 設回 true
  let resolveLate; const raceCase = mk(() => new Promise((res) => { resolveLate = res; }));
  run.parkEmulate(raceCase.v);         // override 在路上
  run.unEmulate(raceCase.v);           // 用戶展開:清 override、bump 世代
  resolveLate({}); await tick();
  ok("race:晚到的 resolve 不把 flag 設回 true(CDP 端是 clear,flag 不能是 true)", raceCase.v.parkEmu !== true, raceCase.v.parkEmu);
  run.parkEmulate(raceCase.v); await tick();   // pending promise 已耗掉,重新 park 要再送
  ok("race 之後再 park:照常重設 override", raceCase.calls.filter(([m]) => m === "Emulation.setDeviceMetricsOverride").length === 2);

  console.log(red ? "\n" + red + " FAILED" : "\nALL PASS");
  process.exit(red ? 1 : 0);
})();
