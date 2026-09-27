// 編輯器真貼上的剪貼簿紀律(稽核 A-P1-1 / A-P2-3):
//   - 全域序列化:兩個 fill 並行不互踩(module 層 pasteChain;之前實證用戶剪貼簿最後留的是策略碼)
//   - 完整格式存/還:用戶剪貼簿是圖片時不再被 clear 掉(readText 得空 ≠ 剪貼簿是空的)
// 跑法:node tests/check_shell_browser_clipboard_paste.js(找不到 Electron 只跑靜態段)
const path = require("path"), fs = require("fs"), os = require("os");
const SHELL = path.join(__dirname, "..", "shell");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };

if (!process.versions.electron) {
  const src = fs.readFileSync(path.join(SHELL, "browser", "cdp.js"), "utf8");
  ok("module 層 pasteChain 串起整段「存 → 寫 → paste → 還原」(一個失敗不卡死後面)",
    /let pasteChain = Promise\.resolve\(\);/.test(src)
    && /const job = pasteChain\.then\(async \(\) => \{/.test(src)
    && /pasteChain = job\.catch\(\(\) => \{\}\);/.test(src));
  ok("async-aware 存/還(這條 runtime 的 clipboard 回 Promise);classic 版仍完整格式;讀到空 → 不 clear、不還原(A 案)",
    /const saved = await clipboardSnapshot\(clipboard\);/.test(src)
    && /await clipboard\.writeText\(String\(text\)\);/.test(src)
    && /finally \{ await clipboardRestore\(clipboard, saved\); \}/.test(src)
    && /if \(clipboard\.readImage\)/.test(src)
    && !/clipboard\.clear\(\)/.test((src.match(/async function clipboardRestore[\s\S]*?\n\}/) || ["X clipboard.clear()"])[0]));
  const bin = path.join(SHELL, "node_modules", ".bin", "electron");
  if (!fs.existsSync(bin)) { console.log("SKIP  真 Electron 那段"); process.exit(red ? 1 : 0); }
  const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit" });
  process.exit(red || r.status ? 1 : 0);
}

const electron = require("electron");
const { app, clipboard, nativeImage } = electron;
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "blave-clip-")));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.on("unhandledRejection", (e) => { console.log("UNHANDLED:", String(e).slice(0, 200)); app.exit(3); });
app.whenReady().then(async () => {
  // 抽真的 fill(editor 分支)跑:mock send/callOn/IP,wc.paste 記次序;剪貼簿用真的
  const src = fs.readFileSync(path.join(SHELL, "browser", "cdp.js"), "utf8");
  const head = src.slice(0, src.indexOf("const KEEP_ROLES"));   // pasteChain + snapshot/restore helpers
  const fillSrc = (src.match(/async function fill\(b, text, d, opt\) \{[\s\S]*?\n  \}/) || [""])[0];
  const events = [];
  const mkFill = (name, pasteMs) => {
    const env = {
      require: (m) => (m === "electron" ? { clipboard } : require(m)),
      send: async () => ({}),
      callOn: async (b, fn) => (String(fn).includes("closest") ? true : fn && fn.name === "focusTarget" ? true : fn && fn.name === "clearField" ? true : true),
      IP: { focusTarget: function focusTarget() {}, clearField: function clearField() {}, selectOption: function selectOption() {} },
      sleep, process,
      wc: { paste: () => { events.push([name, "paste", clipboard.readText()]); } },
    };
    // pasteChain 是 module 狀態:兩個 fill 共用同一份 head 環境才會互斥 → 用同一個 Function scope
    return env;
  };
  // 共用 module scope:一次建好 head,回傳可多次呼叫的 fill(env 換 wc 名字)
  const build = new Function("require", "process", "sleepOuter", head + `
    const sleep = sleepOuter;
    return function makeFill(env) {
      const send = env.send, callOn = env.callOn, IP = env.IP, wc = env.wc;
      return (${fillSrc.replace(/^async function fill/, "async function")});
    };`);
  const req = (m) => (m === "electron" ? { clipboard } : m === "./inpage" ? require(path.join(SHELL, "browser", "inpage")) : require(m));
  const makeFill = build(req, process, sleep);

  // 場景 1:readText 得空(這版 runtime 沒有 image API;圖片/空剪貼簿同一路)→ 貼完不 clear、不還原
  const hasImageApi = typeof clipboard.readImage === "function";
  console.log("這版 clipboard 有 image API:", hasImageApi);
  await Promise.resolve(clipboard.clear ? clipboard.clear() : clipboard.writeText("")).catch(() => {});
  await Promise.resolve(clipboard.writeText(""));
  const fillA = makeFill({ send: async () => ({}), callOn: async () => true, IP: {}, wc: { paste: () => events.push(["A", "paste", clipboard.readText()]) } });
  await fillA(1, "STRATEGY-CODE-A", { isSelect: false }, { clear: false, perChar: false });
  const evA = await Promise.all(events.map(async ([n, k, t]) => [n, k, await Promise.resolve(t)]));
  ok("貼上當下剪貼簿是策略碼(paste 真的貼得到字)", evA.some(([n, , t]) => n === "A" && t === "STRATEGY-CODE-A"), evA);
  ok("讀到空:不 clear、不還原(剪貼簿留著貼文;API 讀不到的內容絕不被我們 clear 掉)", (await Promise.resolve(clipboard.readText())) === "STRATEGY-CODE-A");

  // 場景 2:並行兩個 fill → 序列化,最後用戶剪貼簿=原文字(A-P1-1)
  await Promise.resolve(clipboard.writeText("USER-CLIP"));
  events.length = 0;
  const slowPaste = { paste: () => { events.push(["A", "paste", clipboard.readText()]); } };
  const fastPaste = { paste: () => { events.push(["B", "paste", clipboard.readText()]); } };
  const f1 = makeFill({ send: async () => ({}), callOn: async () => true, IP: {}, wc: slowPaste });
  const f2 = makeFill({ send: async () => ({}), callOn: async () => true, IP: {}, wc: fastPaste });
  const p1 = f1(1, "CODE-A", { isSelect: false }, { clear: false, perChar: false });
  await sleep(30);
  const p2 = f2(1, "CODE-B", { isSelect: false }, { clear: false, perChar: false });
  await Promise.all([p1, p2]);
  const evB = await Promise.all(events.map(async ([n, k, t]) => [n, k, await Promise.resolve(t)]));
  ok("並行 fill:各自貼到自己的 code(序列化,不互踩)",
    evB.filter(([, , t]) => t === "CODE-A").length === 1 && evB.filter(([, , t]) => t === "CODE-B").length === 1
    && evB[0][2] === "CODE-A" && evB[1][2] === "CODE-B", evB);
  ok("最後用戶剪貼簿=原內容(USER-CLIP,不是策略碼)", (await Promise.resolve(clipboard.readText())) === "USER-CLIP");

  console.log(red ? `\n${red} FAILED` : "\nALL PASS");
  app.exit(red ? 1 : 0);
});
