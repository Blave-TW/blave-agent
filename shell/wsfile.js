/* 主行程寫 workspace 裡的檔:那裡的檔名 agent 都能預先放成 symlink(Codex 的沙箱只擋沙箱外,workspace 裡隨它建),
   照抄路徑寫就會被帶到沙箱外(稽核 2026-10-02 P2-1／N1)。
   replace:隨機檔名 + wx(O_EXCL 不跟隨 symlink)寫好再 rename;rename 換掉的是目錄項本身,同名 symlink 不會被寫穿。
   append:O_NOFOLLOW 開檔,最後一段是 symlink 就 ELOOP。Windows 沒有 O_NOFOLLOW;那邊建 symlink 本來就要權限。 */
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");

function replace(file, data) {
  const part = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(6).toString("hex")}`);
  let fd = null, made = false;
  try {
    fd = fs.openSync(part, "wx", 0o600); made = true;
    fs.writeFileSync(fd, data); fs.closeSync(fd); fd = null;
    fs.renameSync(part, file);
  } catch (e) {
    if (fd !== null) try { fs.closeSync(fd); } catch (_) { /* 關不掉也要往下清 */ }
    // 只清自己建的(裡面可能是明文金鑰);名字被別人先佔走(EEXIST)那個不是我們的,不動
    if (made) try { fs.unlinkSync(part); } catch (_) { /* 已經不在 */ }
    throw e;
  }
}

function append(file, data) {
  const K = fs.constants;
  const fd = fs.openSync(file, K.O_WRONLY | K.O_APPEND | K.O_CREAT | (K.O_NOFOLLOW || 0), 0o600);
  try { fs.writeSync(fd, data); } finally { fs.closeSync(fd); }
}

module.exports = { replace, append };
