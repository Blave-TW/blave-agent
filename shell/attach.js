// 聊天附件(0.1.17):跟雲端同一條契約,不另創協定——
//   web 工作頁把單一檔案 base64 放進 /send JSON({ name, mime, data }),機器端 runtime/web_bridge.py
//   save_attachment 落地到 workspace/tmp/inbound/<name>(撞名加 `<秒>_` 前綴),再在使用者訊息尾端補一行
//   「[用戶傳了檔案:tmp/inbound/<name>,請先讀取檔案內容再回應]」交給引擎;存失敗也照跑回合、改補「接收失敗」那行。
//   電腦版沒有 api 與 VM 那兩層:renderer 把同形狀的 { name, mime, data } 交給主行程,主行程在這裡做 api 的消毒
//   (basename、去控制字元、檔名 ≤128、base64 上限)與 VM 的落地,兩段字逐位元組同 web_bridge.py
//   (tests/check_shell_attach.js 釘住)。renderer 從頭到尾拿不到路徑:它只交得出自己手上的位元組,
//   主行程不接「某個路徑」去抄——不然被攻破的畫面可以把這台電腦上任何檔抄進 agent 讀得到的地方。
// 多檔(0.1.25):一則最多 ATTACH_MAX_FILES 個、合計 ATTACH_TOTAL_BYTES;一個檔一行,字跟單檔那行一樣(三處逐字同)。
// 內容不進 log、不進 telemetry:這裡的錯誤只回代號。
const fs = require("fs"), path = require("path");

const ATTACH_MAX_BYTES = 5 * 1024 * 1024;   // 原檔上限,同 web 工作頁 ATTACH_MAX_BYTES
const ATTACH_DATA_MAX = 7_000_000;          // base64 字數上限,同 api openclaw/webchat.py ATTACH_DATA_MAX
const ATTACH_NAME_MAX = 128;                // 同 api ATTACH_NAME_MAX
const ATTACH_MIME_MAX = 64;                 // 同 api ATTACH_MIME_MAX
const ATTACH_MAX_FILES = 4;                 // 同 api ATTACH_MAX_FILES
const ATTACH_TOTAL_BYTES = 15 * 1024 * 1024;   // 原檔合計,同畫面 ATTACH_TOTAL_BYTES
const ATTACH_TOTAL_DATA_MAX = 21_000_000;   // base64 合計:15 MiB 編碼後是 20,971,520 字,低於這個數畫面收得下的主行程會拒收
const COLLIDE_TRIES = 5;                    // 撞名加 `<秒>_` 仍撞(同一秒重送)時秒數往後推幾次
const INBOUND = ["tmp", "inbound"];         // workspace 底下的落地位置,同 runtime INBOUND_DIR
// 交給引擎的兩行,逐字同 runtime/web_bridge.py(那邊是 f-string;這裡 {name} 代入)
const NOTE_OK = "[用戶傳了檔案：tmp/inbound/{name}，請先讀取檔案內容再回應]";
const NOTE_FAIL = "[用戶附了一個檔案但接收失敗，請告知用戶重傳]";
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const INBOUND_KEEP_MS = 7 * 24 * 3600 * 1000;   // 同 runtime/prune_job.py INBOUND_RETENTION_DAYS

/* api 那一段的消毒:basename、去掉控制字元(< 32)、空的或太長就不收。回 null = 不合法。
   `[`、`]` 換成 `_`:給引擎那一行用 [ ] 包住,檔名帶 `]` 能提早收尾、把後面的字偽裝成指示 */
function sanitizeName(raw) {
  if (typeof raw !== "string") return null;
  const base = raw.split(/[\\/]/).pop() || "";
  let out = "";
  for (const c of base) if (c.charCodeAt(0) >= 32) out += c === "[" || c === "]" ? "_" : c;
  // basename 之後仍可能是 . / ..(web 的 os.path.basename 一樣會放過;落地時會指到目錄本身)
  if (!out || out === "." || out === ".." || out.length > ATTACH_NAME_MAX) return null;
  return out;
}

/* renderer 交來的附件驗形狀(檔名、大小、base64 同 api /send 的檢查):不合法回 null,合法回只含三個驗過欄位的新物件。
   mime 跟 api 不同、不拿來拒收:電腦版落地只寫位元組,之後沒有任何地方讀它,太長或不是字串就當沒給——
   xlsx / docx / pptx 的 MIME 是 65 / 71 / 73 字,超過 ATTACH_MIME_MAX;拒收的話 send-message 已經回了 started,畫面只剩「bad attachment」 */
function validate(att) {
  if (!att || typeof att !== "object" || Array.isArray(att)) return null;
  const name = sanitizeName(att.name);
  if (!name) return null;
  const data = att.data;
  if (typeof data !== "string" || data.length > ATTACH_DATA_MAX || data.length % 4 !== 0 || !B64_RE.test(data)) return null;
  const mime = typeof att.mime === "string" && att.mime.length <= ATTACH_MIME_MAX ? att.mime : null;
  const bytes = Buffer.from(data, "base64");
  if (!bytes.length || bytes.length > ATTACH_MAX_BYTES) return null;
  return { name, mime, bytes };
}

/* 一則的整份清單:先看個數與 base64 字數合計(還沒解碼),再逐個 validate,最後看原檔合計與消毒後檔名不重複。
   任何一個不合法整份回 null(整輪不跑,同單檔「形狀不對」);不做部分接受 */
function validateAll(list) {
  if (!Array.isArray(list) || !list.length || list.length > ATTACH_MAX_FILES) return null;
  let chars = 0;
  for (const a of list) { if (!a || typeof a.data !== "string") return null; chars += a.data.length; }
  if (chars > ATTACH_TOTAL_DATA_MAX) return null;
  const out = [], names = new Set();
  let bytes = 0;
  for (const a of list) {
    const v = validate(a);
    if (!v || names.has(v.name)) return null;
    names.add(v.name); bytes += v.bytes.length; out.push(v);
  }
  return bytes > ATTACH_TOTAL_BYTES ? null : out;
}

/* VM 那一段的落地:workspace/tmp/inbound/<name>,撞名加 `<秒>_` 前綴(同 web_bridge.save_attachment)。
   回最終檔名;寫不進去回 null(呼叫端照樣跑回合、補「接收失敗」那行)。`wx` = 不覆寫:exists() 之後才建檔的
   競態與懸空 symlink 都擋在這一步。 */
function save(workspace, att, pruned) {
  const v = validate(att);
  if (!v) return null;
  try {
    const dir = path.join(workspace, ...INBOUND);
    fs.mkdirSync(dir, { recursive: true });
    if (!pruned) prune(workspace);
    const sec = Math.floor(Date.now() / 1000);
    for (let i = -1; i < COLLIDE_TRIES; i++) {
      const name = i < 0 ? v.name : `${sec + i}_${v.name}`;
      if (fs.existsSync(path.join(dir, name))) continue;
      try { fs.writeFileSync(path.join(dir, name), v.bytes, { mode: 0o600, flag: "wx" }); return name; }
      catch (e) { if (e.code !== "EEXIST") return null; }
    }
    return null;
  } catch (_) { return null; }
}
/* 整份清單照順序落地,回每個的最終檔名(失敗的位置是 null);七天清掃只跑一次 */
function saveAll(workspace, list) {
  prune(workspace);
  return list.map((a) => save(workspace, a, true));
}

/* 七天清掃:雲端是 runtime/prune_job.py 的排程在清,電腦版不跑那支,由外殼啟動時與每次落地前清。
   只清 workspace/tmp/inbound 這一層、放超過七天的一般檔案:lstat 不跟 symlink(連結與子目錄都不動);
   tmp 或 inbound 被換成連到別處的 symlink(agent 寫得到 workspace)就整個不清。回刪掉幾個。 */
function prune(workspace, now) {
  let removed = 0;
  try {
    const dir = path.join(workspace, ...INBOUND);
    if (fs.realpathSync(dir) !== path.join(fs.realpathSync(workspace), ...INBOUND)) return 0;
    const cutoff = (now == null ? Date.now() : now) - INBOUND_KEEP_MS;
    for (const name of fs.readdirSync(dir)) {
      try {
        const p = path.join(dir, name), st = fs.lstatSync(p);
        if (st.isFile() && st.mtimeMs < cutoff) { fs.unlinkSync(p); removed++; }
      } catch (_) { /* 這一個刪不掉:下次再清 */ }
    }
  } catch (_) { /* 目錄不存在 = 沒收過檔 */ }
  return removed;
}

/* 使用者訊息 + 給引擎那一行(同 web_bridge:純附件時只有那一行) */
function withNote(message, savedName) {
  const note = savedName ? NOTE_OK.replace("{name}", savedName) : NOTE_FAIL;
  return message ? `${message}\n${note}` : note;
}
/* 多檔:一個檔一行、順序同清單;失敗的那個補「接收失敗」那行 */
function withNotes(message, savedNames) {
  return savedNames.reduce((m, n) => withNote(m, n), message);
}

module.exports = { ATTACH_MAX_BYTES, ATTACH_DATA_MAX, ATTACH_NAME_MAX, ATTACH_MIME_MAX, ATTACH_MAX_FILES, ATTACH_TOTAL_BYTES, ATTACH_TOTAL_DATA_MAX,
  NOTE_OK, NOTE_FAIL, sanitizeName, validate, validateAll, save, saveAll, prune, withNote, withNotes };
