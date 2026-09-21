// shell/datasrc.js:自帶資料來源的金鑰(設定 › 資料來源)。
// 守的東西:名稱白名單、值進不了第二行(.env 注入)、名字落不進交易所的命名空間(永遠不會拿去下單)、
// list 不含值、讀-改-寫拿 .env.lock、只動自己那一塊、IPC 只收自家頁面。邏輯壞掉這裡就紅。
// 一律用暫存 workspace,不碰 repo 根與 ~/Blave。跑法:node tests/check_shell_datasrc.js
const fs = require("fs"), os = require("os"), path = require("path"), cp = require("child_process");
const D = require("../shell/datasrc.js");
const WS = fs.mkdtempSync(path.join(os.tmpdir(), "blave-src-")), ENVF = path.join(WS, ".env");
let red = 0; const t = (n, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) red++; };
const rd = () => { try { return fs.readFileSync(ENVF, "utf8"); } catch (_) { return null; } };
const SECRET = "sk_live_Abc123-XYZ.789#frag=1";
let locks = 0, held = false, overlap = false;
const lock = () => { locks++; if (held) overlap = true; held = true; return Promise.resolve(() => { held = false; }); };
let TRADING = { live: false, amounts: {} };
const STRATS = [{ name: "btc_funding", displayName: "BTC 資金費率反轉", file: path.join(WS, "s1.py") }, { name: "spy_vol", displayName: null, file: path.join(WS, "s2.py") }];
fs.writeFileSync(STRATS[0].file, 'import os\nKEY = os.environ["DATA_COINGLASS_KEY"]\n');
fs.writeFileSync(STRATS[1].file, "# nothing here\n");
const ds = D.createDataSrc({ envFile: ENVF, lock, strategies: () => STRATS, trading: () => TRADING, now: () => 1790000000 });

(async () => {
  // ---- 名稱與欄位 ----
  t("名稱:合法的過", D.checkName("FRED") === null && D.checkName("BINANCE") === null && D.checkName("A1") === null);
  t("名稱:空 / 小寫 / 底線 / 太長 / 非字串 都擋", ["", "fred", "A_B", "A".repeat(25), "A B", "A\nB", null, 5, {}].every((n) => D.checkName(n) !== null));
  t("名稱:DATA 開頭擋(前綴已經是 DATA_)", D.checkName("DATA") === "NAME_RESERVED" && D.checkName("DATAFEED") === "NAME_RESERVED");
  t("欄位:合法的過、其餘擋", D.checkField("FRED", "KEY") === null && D.checkField("FRED", "API_KEY") === null
    && ["", "key", "1KEY", "_KEY", "K-EY", "K EY", "K=1", "K\nX", "A".repeat(33), null].every((f) => D.checkField("FRED", f) !== null));

  // ---- 永遠不會拿去下單:名字落不進交易所的命名空間 ----
  t("DATA_API_KEY / DATA_SECRET_KEY 是「名叫 DATA 的交易所」的金鑰名:擋", D.checkField("API", "KEY") === "FIELD_RESERVED" && D.checkField("SECRET", "KEY") === "FIELD_RESERVED");
  t("一般的成對金鑰(DATA_POLYGON_API_KEY + _SECRET_KEY)id 是 DATA_POLYGON:機器端會跳過,放行", D.checkField("POLYGON", "API_KEY") === null && D.checkField("POLYGON", "SECRET_KEY") === null);
  { // 對照機器端的口徑(runtime/command_listener.py):id = 去掉尾碼;DATA_ 開頭的 id 不是交易所
    const SUF = ["_API_KEY", "_SECRET_KEY", "_PASSWORD", "_PASSPHRASE"];
    const idOf = (n) => { const s = SUF.find((x) => n.endsWith(x)); return s ? n.slice(0, -s.length) : null; };
    let leak = null;
    for (const src of ["API", "SECRET", "PASSWORD", "A", "BINANCE", "OKX", "X9"]) for (const f of ["KEY", "API_KEY", "SECRET_KEY", "PASSWORD", "PASSPHRASE", "TOKEN", "A_API_KEY"]) {
      if (D.checkName(src) || D.checkField(src, f)) continue;
      const id = idOf(D.envName(src, f)); if (id !== null && !id.startsWith("DATA_")) leak = D.envName(src, f);
    }
    t("放行的每一個變數名,在機器端都讀不成交易所金鑰", leak === null);
  }
  t("交易所的名字可以當來源名(不同命名空間)", (await ds.save({ name: "BINANCE", isNew: true, fields: [{ name: "KEY", value: "abc12345" }] })).ok === true
    && !/^BINANCE_/m.test(rd()) && /^DATA_BINANCE_KEY='abc12345'$/m.test(rd()));
  await ds.remove("BINANCE");
  t("最後一個來源刪掉、檔裡沒有別的東西 → 不留空檔", rd() === null);

  // ---- .env 注入 ----
  t("值:一般金鑰(含 # . = - _ / +)過", D.cleanValue(SECRET) === SECRET && D.cleanValue("a/b+c==") === "a/b+c==");
  t("值:頭尾空白與換行去掉(貼上常帶)", D.cleanValue("  abc123\n") === "abc123");
  t("值:中間有換行 / CR / NUL / 空白 / 單引號 / 雙引號在單引號外無妨但單引號擋 / 反斜線 / ${ / 非 ASCII / 空 / 太長 都擋",
    ["a\nB=1", "a\rB=1", "a\u0000b", "a b", "a'b", "a\\b", "a${HOME}", "金鑰", "", "   ", "x".repeat(513), null, 7, ["a"]].every((v) => D.cleanValue(v) === null));
  fs.writeFileSync(ENVF, "BINANCE_API_KEY=real\nBINANCE_SECRET_KEY=real2\n", { mode: 0o644 });
  const inj = await ds.save({ name: "FRED", isNew: true, fields: [{ name: "KEY", value: "abc\nBINANCE_API_KEY=evil" }] });
  t("帶換行的值整筆拒收,.env 一個字都沒動", inj.ok === false && inj.error === "BAD_VALUE" && rd() === "BINANCE_API_KEY=real\nBINANCE_SECRET_KEY=real2\n");
  const injName = await ds.save({ name: "FRED\nX=1", isNew: true, fields: [{ name: "KEY", value: "abc" }] });
  const injField = await ds.save({ name: "FRED", isNew: true, fields: [{ name: "KEY=1\nX", value: "abc" }] });
  t("名稱 / 欄位名帶換行或等號:拒收,.env 沒動", !injName.ok && !injField.ok && rd() === "BINANCE_API_KEY=real\nBINANCE_SECRET_KEY=real2\n");

  // ---- 寫入:只動自己那一塊、0600、拿鎖 ----
  locks = 0;
  const ok1 = await ds.save({ name: "FRED", isNew: true, fields: [{ name: "KEY", value: "  " + SECRET + "\n" }, { name: "SECRET", value: "s3cr3t-value" }] });
  const want = "BINANCE_API_KEY=real\nBINANCE_SECRET_KEY=real2\n" + D.BEGIN + "\n# source FRED added=1790000000\nDATA_FRED_KEY='" + SECRET + "'\nDATA_FRED_SECRET='s3cr3t-value'\n" + D.END + "\n";
  t("存成功:交易所金鑰原樣、我們那塊接在後面、值用單引號包(# 不會被讀成註解)", ok1.ok === true && rd() === want);
  t("權限收成 0600", (fs.statSync(ENVF).mode & 0o777) === 0o600);
  t("讀-改-寫有拿鎖,而且放了", locks === 1 && held === false);
  t("沒留暫存檔", !fs.existsSync(ENVF + ".blave-src-tmp"));
  { // python-dotenv 讀回來的值一字不差(有裝才驗;沒裝就 SKIP,不假綠)
    const py = path.join(__dirname, "..", ".venv", "bin", "python");
    const r = fs.existsSync(py) ? cp.spawnSync(py, ["-c", "import sys,json\nfrom dotenv import dotenv_values\nprint(json.dumps(dotenv_values(sys.argv[1])))", ENVF], { encoding: "utf8" }) : null;
    if (!r || r.status !== 0) console.log("SKIP  python-dotenv 讀回驗證(找不到 .venv 或沒裝 dotenv)");
    else { const v = JSON.parse(r.stdout); t("python-dotenv 讀回來的值一字不差,交易所金鑰也還在", v.DATA_FRED_KEY === SECRET && v.DATA_FRED_SECRET === "s3cr3t-value" && v.BINANCE_API_KEY === "real"); }
  }

  // ---- list 不含值 ----
  const l1 = ds.list();
  t("list:名稱、欄位名、建立時間", l1.ok && l1.sources.length === 1 && l1.sources[0].name === "FRED" && l1.sources[0].fields.join() === "KEY,SECRET" && l1.sources[0].added === 1790000000);
  t("list 的回傳裡找不到任何一個值", !JSON.stringify(l1).includes(SECRET) && !JSON.stringify(l1).includes("s3cr3t") && !JSON.stringify(l1).includes("real"));
  const errs = JSON.stringify([inj, injName, injField, ok1]);
  t("save 的回傳裡也沒有值", !errs.includes(SECRET) && !errs.includes("evil") && !errs.includes("s3cr3t"));

  // ---- 修改:null = 留著已存的;沒列到的舊欄位拿掉;不存在的欄位不能留 ----
  t("同名再新增 → NAME_DUP", (await ds.save({ name: "FRED", isNew: true, fields: [{ name: "KEY", value: "zzz" }] })).error === "NAME_DUP");
  t("修改不存在的來源 → NOT_FOUND", (await ds.save({ name: "NOPE", isNew: false, fields: [{ name: "KEY", value: "zzz" }] })).error === "NOT_FOUND");
  t("留著一個沒存過的欄位 → 拒收", (await ds.save({ name: "FRED", isNew: false, fields: [{ name: "TOKEN", value: null }] })).error === "BAD_VALUE");
  t("新增時不能有 null 的值", (await ds.save({ name: "NEWONE", isNew: true, fields: [{ name: "KEY", value: null }] })).error === "BAD_VALUE");
  const ed = await ds.save({ name: "FRED", isNew: false, fields: [{ name: "KEY", value: null }, { name: "TOKEN", value: "tok-1" }] });
  t("修改:KEY 原樣留著、SECRET 拿掉、TOKEN 加上、建立時間不變", ed.ok && new RegExp("^DATA_FRED_KEY='" + SECRET.replace(/[.$#+]/g, "\\$&") + "'$", "m").test(rd()) && !/DATA_FRED_SECRET/.test(rd()) && /^DATA_FRED_TOKEN='tok-1'$/m.test(rd()) && /# source FRED added=1790000000/.test(rd()));
  t("欄位重複 / 沒有欄位 / 太多欄位 / 形狀不對 → 拒收", (await ds.save({ name: "X1", isNew: true, fields: [{ name: "KEY", value: "a1" }, { name: "KEY", value: "b1" }] })).error === "FIELD_DUP"
    && (await ds.save({ name: "X1", isNew: true, fields: [] })).error === "BAD_ARGS" && (await ds.save({ name: "X1", isNew: true, fields: Array.from({ length: 9 }, (_, i) => ({ name: "K" + i, value: "v1" })) })).error === "BAD_ARGS"
    && (await ds.save({ name: "X1", isNew: true, fields: "KEY" })).error === "BAD_ARGS" && (await ds.save({ name: "X1", isNew: true, fields: [null] })).error === "BAD_ARGS" && (await ds.save(null)).ok === false);

  // ---- 不可信的 .env:agent 寫得到 ----
  fs.writeFileSync(ENVF, ["KEEP=1", D.BEGIN, "# source evil<img> added=1", "DATA_bad_KEY='x'", "DATA_API_KEY='venue'", "# source OKSRC added=5", "DATA_OKSRC_KEY='v'", "HANDPLACED=keepme", "# a comment", D.END, "TAIL=2", ""].join("\n"));
  const l2 = ds.list();
  t("塊裡不合白名單的名稱不往上交(含會撞交易所命名空間的)", l2.sources.length === 1 && l2.sources[0].name === "OKSRC" && l2.sources[0].added === 5);
  await ds.save({ name: "NEW1", isNew: true, fields: [{ name: "KEY", value: "v2" }] });
  t("重寫時:塊外的行原樣、塊裡認不得的非註解行搬到塊外留著(不丟別人的金鑰)", /^KEEP=1$/m.test(rd()) && /^TAIL=2$/m.test(rd()) && /^HANDPLACED=keepme$/m.test(rd()) && /^DATA_API_KEY='venue'$/m.test(rd())
    && rd().indexOf("HANDPLACED") < rd().indexOf(D.BEGIN) && rd().indexOf("DATA_API_KEY") < rd().indexOf(D.BEGIN));
  fs.writeFileSync(ENVF, "A=1\r\n" + D.BEGIN + "\r\n# source CR added=9\r\nDATA_CR_KEY='v'\r\n" + D.END + "\r\n");
  t("CRLF 檔也讀得懂", ds.list().sources.map((s) => s.name).join() === "CR");

  // ---- 誰用到、刪除被擋 ----
  fs.writeFileSync(ENVF, "");
  await ds.save({ name: "COINGLASS", isNew: true, fields: [{ name: "KEY", value: "cg-1" }] });
  await ds.save({ name: "POLYGON", isNew: true, fields: [{ name: "KEY", value: "pg-1" }] });
  const l3 = ds.list();
  t("usedBy:程式碼裡出現 DATA_<來源>_ 的策略(用顯示名)", l3.sources.find((s) => s.name === "COINGLASS").usedBy.join() === "BTC 資金費率反轉" && l3.sources.find((s) => s.name === "POLYGON").usedBy.length === 0);
  TRADING = { live: true, amounts: { btc_funding: 0 } };
  t("正在下單但這支金額是 0 → 可以刪", ds.blockers("COINGLASS").length === 0);
  TRADING = { live: false, amounts: { btc_funding: 1000 } };
  t("有金額但沒在下單 → 可以刪", ds.blockers("COINGLASS").length === 0);
  TRADING = { live: true, amounts: { btc_funding: 1000 } };
  const blocked = await ds.remove("COINGLASS");
  t("正在下單、有金額、用到它 → IN_USE,.env 沒動", blocked.ok === false && blocked.error === "IN_USE" && blocked.names.join() === "BTC 資金費率反轉" && /DATA_COINGLASS_KEY/.test(rd()));
  t("同一時間別的來源照樣刪得掉", (await ds.remove("POLYGON")).ok === true && !/POLYGON/.test(rd()));
  t("刪不存在的 / 名稱不合法 → 不動檔", (await ds.remove("POLYGON")).error === "NOT_FOUND" && (await ds.remove("a b")).error === "BAD_ARGS");
  t("全程沒有兩個讀-改-寫同時拿著鎖", overlap === false);

  // ---- 鎖 ----
  const busy = D.createDataSrc({ envFile: ENVF, lock: () => Promise.reject(new Error("BUSY")) });
  const before = rd(), b = await busy.save({ name: "LATE", isNew: true, fields: [{ name: "KEY", value: "v9" }] });
  t("拿不到鎖 → BUSY,不硬寫", b.ok === false && b.error === "BUSY" && rd() === before);
  t("pyLock:沒有 python(還沒有 venv)= 沒有人搶,直接過", typeof (await D.pyLock({ python: path.join(WS, "nope"), lockFile: path.join(WS, ".env.lock") })()) === "function");
  { // 真的 flock:第一個拿著的時候第二個要等;放了才拿得到(用系統 python3;沒有就 SKIP)
    const py = ["/usr/bin/python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3"].find((p) => fs.existsSync(p));
    if (!py) console.log("SKIP  真的 flock(找不到 python3)");
    else {
      const lf = path.join(WS, ".env.lock"), mk = (ms) => D.pyLock({ python: py, lockFile: lf, timeoutMs: ms });
      const rel1 = await mk(5000)();
      let second = null; try { await mk(600)(); second = "got"; } catch (e) { second = e.message; }
      t("pyLock:別人拿著 .env.lock 的時候等不到 → BUSY", second === "BUSY");
      rel1(); await new Promise((r) => setTimeout(r, 300));
      let third = null; try { const rel3 = await mk(3000)(); third = "got"; rel3(); } catch (e) { third = e.message; }
      t("pyLock:放了之後拿得到", third === "got");
      t("pyLock:鎖檔 0600", (fs.statSync(lf).mode & 0o777) === 0o600);
    }
  }

  // ---- IPC 只收自家頁面;值不進 log / argv / userData ----
  const main = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8");
  // 走 main.js 的 handle(channel, fn, denied):預設就過 fromOurPage,拒絕時回各自的形狀(第三個參數)
  const handlers = [...main.matchAll(/^  handle\("(datasrc-[a-z]+)",[^\n]*$/gm)].map((m) => m[0] + "\n");
  t("四支 datasrc IPC 都在,都走 handle()(預設過 fromOurPage),而且各自帶拒絕時的回傳形狀;沒有直接 ipcMain.handle 的", handlers.length === 4 && !/ipcMain\.handle\("datasrc-/.test(main)
    && /const handle = \(channel, fn, denied = null\) => ipcMain\.handle\(channel, \(e, \.\.\.a\) => \(fromOurPage\(e\) \? fn\(e, \.\.\.a\) : denied\)\);/.test(main)
    && handlers.filter((l) => /\{ ok: false, error: "NOT_ALLOWED"[^}]*\}\);\n$/.test(l)).length === 3 && handlers.some((l) => /"datasrc-blockers"[^\n]*, \[\]\);\n$/.test(l)));
  const mod = fs.readFileSync(path.join(__dirname, "..", "shell", "datasrc.js"), "utf8");
  t("datasrc.js 不 log、不 require electron、spawn 的 argv 裡只有鎖檔路徑", !/console\.|require\("electron"\)/.test(mod) && /spawnFn\(python, \["-c", LOCK_PY, lockFile\]/.test(mod));
  const rjs = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "datasrc.js"), "utf8");
  t("renderer 那一半不用 innerHTML / insertAdjacentHTML / localStorage", !/innerHTML|insertAdjacentHTML|outerHTML|localStorage|sessionStorage/.test(rjs));
  const cfg = fs.readFileSync(path.join(__dirname, "..", "shell", "electron-builder.config.js"), "utf8");
  t("datasrc.js 在打包的 files 清單裡", /files:\s*\[[^\]]*"datasrc\.js"/.test(cfg));

  fs.rmSync(WS, { recursive: true, force: true });
  console.log(red ? `\n${red} 項失敗` : "\nAll checks passed.");
  process.exit(red ? 1 : 0);
})().catch((e) => { console.log("FAIL  測試本身丟例外:" + (e && e.stack)); process.exit(1); });
