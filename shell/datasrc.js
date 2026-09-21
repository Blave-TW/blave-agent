// Blave 電腦版 — 自帶資料來源(BYO Data)的金鑰(主行程用)。設定 › 資料來源 那一頁的後半。
// 設計:blave-canon output/designer/mockup-desktop-telemetry-and-datasrc-2026-09.html 的 B;字串 src.*。
//
// 為什麼長這樣:
//   - 金鑰寫進 workspace 的 `.env`,名字是 DATA_<來源>_<欄位>——agent 和策略程式本來就要讀得到(這是給它們抓資料用的)。
//     機器端(runtime/command_listener.py 的 _is_data_cred_id)把 DATA_ 開頭的 id 一律當「不是交易所」:不驅逐、不進綁定清單、
//     不排程、不讀帳戶。所以這裡的東西**永遠不會被拿去下單**——前提是名字真的落在那個命名空間裡,見 venueShaped()。
//   - 只動自己那一塊(前後兩行標記包起來),同 main.js 的 syncDataEnv:交易所金鑰、用戶手放的東西一律原樣保留。
//   - `.env` 是 agent 寫得到的檔:這裡讀回來的名稱是不可信輸入,過了白名單才往上交;**值永遠不往上交**(連長度都不交)。
//   - 讀-改-寫要拿 `.env.lock`(同 command_listener._env_lock 的 flock):常駐程式綁交易所時也在改同一個檔。Node 沒有 flock,
//     所以借 venv 的 python 拿著鎖、我們在它拿著的期間同步做完讀-改-寫;python 的 stdin 一關就放鎖(主行程死了也會放)。
//     還沒有 venv = 還沒有常駐程式 = 沒有人跟我們搶,不拿鎖。
//
// 這個檔不 require electron;檔案系統、鎖、策略清單、下單狀態都由呼叫端注入(測試用假的)。
const fs = require("fs"), path = require("path"), { spawn } = require("child_process");

const BEGIN = "# >>> blave desktop data sources (managed, do not edit) >>>";
const END = "# <<< blave desktop data sources <<<";
const SRC_RE = /^[A-Z0-9]{1,24}$/, FIELD_RE = /^[A-Z][A-Z0-9_]{0,31}$/;
const MAX_SOURCES = 32, MAX_FIELDS = 8, VALUE_MAX = 512, CODE_MAX = 512 * 1024;
// 交易所金鑰的形狀是 {ID}_API_KEY + {ID}_SECRET_KEY / _PASSWORD / _PASSPHRASE(command_listener._CRED_ENV_RE)
const VENUE_SUFFIX = ["_API_KEY", "_SECRET_KEY", "_PASSWORD", "_PASSPHRASE"];

const envName = (src, field) => `DATA_${src}_${field}`;
/* 這個變數名會不會被機器端讀成交易所金鑰:去掉金鑰尾碼之後的 id 不是 DATA_ 開頭就會。
   來源 API + 欄位 KEY = DATA_API_KEY,那是「名叫 DATA 的自訂交易所」的金鑰名;配上 DATA_SECRET_KEY 就成了一個綁定。 */
function venueShaped(name) {
  const suf = VENUE_SUFFIX.find((s) => name.endsWith(s));
  return !!suf && !name.slice(0, -suf.length).startsWith("DATA_");
}
// 回 null = 合法;否則回錯誤代號(renderer 對到 src.err*)
function checkName(name) {
  if (typeof name !== "string" || !name) return "NAME_EMPTY";
  if (!SRC_RE.test(name)) return "NAME_FORMAT";
  if (name.startsWith("DATA")) return "NAME_RESERVED";
  return null;
}
function checkField(src, field) {
  if (typeof field !== "string" || !FIELD_RE.test(field)) return "FIELD_FORMAT";
  if (venueShaped(envName(src, field))) return "FIELD_RESERVED";
  return null;
}
/* 值:頭尾空白去掉(貼上常帶換行)之後,只收看得見的 ASCII,而且不含會讓 python-dotenv 讀出別的東西的字——
   單引號(我們用單引號包)、反斜線(單引號裡唯一的跳脫字元)、`${`(dotenv 會代換變數)。一個換行就能在 .env 多塞一行設定。 */
function cleanValue(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s.length > VALUE_MAX || !/^[\x21-\x7e]+$/.test(s) || /['\\]/.test(s) || s.includes("${")) return null;
  return s;
}

/* .env 全文 → { outside: 我們那塊以外的行, sources: Map<來源, { added, fields: Map<欄位, 原樣的那一行> }> }。
   塊裡認不得的非註解行不丟(可能是別人手放進去的金鑰):搬到塊外面原樣留著。 */
function parse(text) {
  const outside = [], sources = new Map();
  let inBlock = false;
  for (const l of String(text || "").split(/\r?\n/)) {
    const s = l.trim();
    if (s === BEGIN) { inBlock = true; continue; }
    if (s === END) { inBlock = false; continue; }
    if (!inBlock) { outside.push(l); continue; }
    const meta = /^# source ([A-Z0-9]{1,24}) added=(\d{1,12})$/.exec(s);
    if (meta) { if (!checkName(meta[1])) touch(sources, meta[1]).added = Number(meta[2]); continue; }
    const kv = /^DATA_([A-Z0-9]{1,24})_([A-Z][A-Z0-9_]{0,31})=/.exec(s);
    if (kv && !checkName(kv[1]) && !checkField(kv[1], kv[2])) { touch(sources, kv[1]).fields.set(kv[2], s); continue; }
    if (s && !s.startsWith("#")) outside.push(l);
  }
  while (outside.length && outside[outside.length - 1] === "") outside.pop();
  for (const [k, v] of sources) if (!v.fields.size) sources.delete(k);   // 只剩一行註解的不算一個來源
  return { outside, sources };
}
function touch(map, name) { if (!map.has(name)) map.set(name, { added: 0, fields: new Map() }); return map.get(name); }
function render({ outside, sources }) {
  const out = outside.slice();
  if (sources.size) {
    out.push(BEGIN);
    for (const [name, s] of sources) { out.push(`# source ${name} added=${s.added || 0}`); for (const line of s.fields.values()) out.push(line); }
    out.push(END);
  }
  return out.length ? out.join("\n") + "\n" : "";
}

/* 借 python 拿 .env.lock:拿到才 resolve 一個 release();等太久 = BUSY(不硬寫)。python 起不來(沒有 venv)= 沒有人搶,直接過。 */
const LOCK_PY = "import fcntl,os,sys\nfd=os.open(sys.argv[1],os.O_CREAT|os.O_RDWR,0o600)\nfcntl.flock(fd,fcntl.LOCK_EX)\nsys.stdout.write('L\\n');sys.stdout.flush()\nsys.stdin.read()\n";
function pyLock({ python, lockFile, timeoutMs = 10000, spawnFn = spawn, exists = fs.existsSync }) {
  return () => new Promise((resolve, reject) => {
    if (!python || !exists(python)) return resolve(() => {});
    let done = false, child;
    try { child = spawnFn(python, ["-c", LOCK_PY, lockFile], { stdio: ["pipe", "pipe", "ignore"] }); }
    catch (_) { return reject(new Error("LOCK_FAILED")); }
    const release = () => { try { child.stdin.end(); } catch (_) { /* 已經結束 */ } };
    const fail = (code) => { if (done) return; done = true; clearTimeout(tm); release(); try { child.kill(); } catch (_) {} reject(new Error(code)); };
    const tm = setTimeout(() => fail("BUSY"), timeoutMs);
    child.stdout.on("data", (b) => { if (done || !String(b).includes("L")) return; done = true; clearTimeout(tm); resolve(release); });
    child.on("error", () => fail("LOCK_FAILED"));
    child.on("exit", () => fail("LOCK_FAILED"));   // 還沒拿到鎖就結束了
  });
}

/* opts:{ envFile, lock() → Promise<release>, strategies?() → [{ name, displayName, file }], trading?() → { live, amounts }, now? } */
function createDataSrc(opts) {
  const now = opts.now || (() => Math.floor(Date.now() / 1000));
  const read = () => { try { return fs.readFileSync(opts.envFile, "utf8"); } catch (e) { if (e.code === "ENOENT") return ""; throw e; } };
  function write(next) {
    if (!next) { try { fs.unlinkSync(opts.envFile); } catch (e) { if (e.code !== "ENOENT") throw e; } return; }
    // 先寫暫存檔再 rename:策略可能正在讀;rename 沒成功時暫存檔裡是明文金鑰,不能留著
    const tmp = opts.envFile + ".blave-src-tmp";
    try { fs.writeFileSync(tmp, next, { mode: 0o600 }); fs.chmodSync(tmp, 0o600); fs.renameSync(tmp, opts.envFile); }
    catch (e) { try { fs.unlinkSync(tmp); } catch (_) {} throw e; }
  }
  // 讀-改-寫:拿到鎖之後**同步**做完(中間沒有 await,主行程裡別的 .env 寫入插不進來)
  async function mutate(fn) {
    let release;
    try { release = await opts.lock(); } catch (e) { return { ok: false, error: e && e.message === "BUSY" ? "BUSY" : "SAVE_FAILED" }; }
    try {
      const cur = read(), doc = parse(cur), err = fn(doc);
      if (err) return { ok: false, error: err };
      const next = render(doc);
      if (next !== cur) write(next);
      return { ok: true };
    } catch (_) { return { ok: false, error: "SAVE_FAILED" }; }   // 訊息不往上交:裡面可能有路徑
    finally { release(); }
  }
  // 哪些策略的程式碼裡出現這個來源的變數名(DATA_<來源>_);顯示名來自策略檔,renderer 只能用 textContent 畫
  function usage(names) {
    const out = new Map(names.map((n) => [n, []]));
    let strategies = []; try { strategies = (opts.strategies && opts.strategies()) || []; } catch (_) { /* 讀不到就當沒有人用 */ }
    for (const s of strategies) {
      let code = "";
      try { if (fs.statSync(s.file).size <= CODE_MAX) code = fs.readFileSync(s.file, "utf8"); } catch (_) { continue; }
      for (const n of names) if (code.includes(`DATA_${n}_`)) out.get(n).push({ name: s.name, label: String(s.displayName || s.name).slice(0, 80) });
    }
    return out;
  }
  function tradingNow() {
    try { const t = opts.trading && opts.trading(); return t && t.live ? (t.amounts && typeof t.amounts === "object" ? t.amounts : {}) : null; }
    catch (_) { return null; }
  }
  // 正在下單、而且有投入金額的策略用到它 → 不給刪(刪了它下一輪就抓不到資料)
  function blockers(name) {
    const amounts = tradingNow(); if (!amounts) return [];
    return usage([name]).get(name).filter((s) => Number(amounts[s.name]) > 0).map((s) => s.label);
  }

  return {
    // 只回名稱、欄位名、建立時間、誰用到——**沒有值**
    list() {
      let doc; try { doc = parse(read()); } catch (_) { return { ok: false, error: "READ_FAILED", sources: [] }; }
      const names = [...doc.sources.keys()].slice(0, MAX_SOURCES), use = usage(names);
      return { ok: true, sources: names.map((n) => ({ name: n, fields: [...doc.sources.get(n).fields.keys()], added: doc.sources.get(n).added || null, usedBy: use.get(n).map((s) => s.label) })) };
    },
    /* 新增或修改。fields:[{ name, value }];value 是字串 = 寫入 / 取代,null = 留著已存的那個(只有修改時、而且那個欄位真的存在才行)。
       沒列到的舊欄位 = 拿掉。isNew 時名稱不可已存在;修改時必須已存在。 */
    save(input) {
      const name = input && input.name, isNew = !!(input && input.isNew), fields = input && input.fields;
      const bad = checkName(name); if (bad) return Promise.resolve({ ok: false, error: bad });
      if (!Array.isArray(fields) || !fields.length || fields.length > MAX_FIELDS) return Promise.resolve({ ok: false, error: "BAD_ARGS" });
      const want = new Map();
      for (const f of fields) {
        if (!f || typeof f !== "object") return Promise.resolve({ ok: false, error: "BAD_ARGS" });
        const fe = checkField(name, f.name); if (fe) return Promise.resolve({ ok: false, error: fe, field: typeof f.name === "string" ? f.name.slice(0, 32) : "" });
        if (want.has(f.name)) return Promise.resolve({ ok: false, error: "FIELD_DUP", field: f.name });
        const v = f.value == null ? null : cleanValue(f.value);
        if (f.value != null && v == null) return Promise.resolve({ ok: false, error: "BAD_VALUE", field: f.name });
        want.set(f.name, v);
      }
      return mutate((doc) => {
        const have = doc.sources.get(name);
        if (isNew && have) return "NAME_DUP";
        if (!isNew && !have) return "NOT_FOUND";
        if (isNew && doc.sources.size >= MAX_SOURCES) return "TOO_MANY";
        const next = new Map();
        for (const [f, v] of want) {
          if (v == null) { if (!have || !have.fields.has(f)) return "BAD_VALUE"; next.set(f, have.fields.get(f)); }
          else next.set(f, `${envName(name, f)}='${v}'`);
        }
        doc.sources.set(name, { added: have ? have.added : now(), fields: next });
        return null;
      });
    },
    blockers: (name) => (checkName(name) ? [] : blockers(name)),
    remove(name) {
      if (checkName(name)) return Promise.resolve({ ok: false, error: "BAD_ARGS" });
      const by = blockers(name);
      if (by.length) return Promise.resolve({ ok: false, error: "IN_USE", names: by });
      return mutate((doc) => (doc.sources.delete(name) ? null : "NOT_FOUND"));
    },
  };
}

module.exports = { createDataSrc, pyLock, parse, render, checkName, checkField, cleanValue, envName, venueShaped, BEGIN, END, MAX_FIELDS, MAX_SOURCES, VALUE_MAX };
