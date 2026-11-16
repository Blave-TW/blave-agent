/* 主行程 log(userData/logs/main.log;Windows 是 %APPDATA%\Blave\logs\main.log)。
   打包版的 Windows 沒有主控台,console.error 以前全丟,用戶回報「第一次開黑畫面」時什麼都撈不到。
   一則一行、時間戳開頭;多行訊息(pip 的 stderr)接續行縮兩格。每一行各自過 redact.js(家目錄換成 ~、金鑰樣式遮掉):
   整段一起遮的話,pip stderr 裡的 hash 一多就超過 MAX_MASKS,整則變成 EXCLUDED。
   大小上限 MAX_BYTES,滿了輪替成 .1 / .2(最多 KEEP 份);寫檔與輪替永遠不拋(第二份 app 開著檔時 Windows 的 rename 會失敗)。
   純模組,不依賴 Electron;tests/check_shell_mainlog.js */
"use strict";
const path = require("path");
const util = require("util");

const MAX_BYTES = 1024 * 1024, KEEP = 3, LINE_MAX = 2000, LINES_MAX = 80;

function createMainLog(o) {
  const fs = o.fs || require("fs");
  const now = o.now || Date.now;
  const max = o.maxBytes || MAX_BYTES, keep = o.keep || KEEP;
  const redact = o.redact || ((s) => require("./redact").redact(s));
  let dir = null, file = null, size = -1;
  function open() {
    if (file) return true;
    dir = typeof o.dir === "function" ? o.dir() : o.dir;
    if (!dir) return false;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    file = path.join(dir, "main.log");
    try { size = fs.statSync(file).size; } catch (_) { size = 0; }
    return true;
  }
  function rotate() {
    for (let i = keep - 1; i >= 1; i--) { try { fs.renameSync(i === 1 ? file : `${file}.${i - 1}`, `${file}.${i}`); } catch (_) { /* 那一份不在 */ } }
    try { size = fs.statSync(file).size; } catch (_) { size = 0; }   // rename 失敗(被別的行程開著):照舊接在後面寫,不拋
  }
  // 太長的訊息(pip 整段 log)留最後 LINES_MAX 行:死因在 traceback 的結尾
  function format(msg) {
    let lines = String(msg).split(/\r?\n/).filter((l) => l.trim());
    if (lines.length > LINES_MAX) lines = [`(${lines.length - LINES_MAX} lines omitted)`, ...lines.slice(-LINES_MAX)];
    const safe = lines.map((l) => { try { return redact(l.slice(0, LINE_MAX)); } catch (_) { return "(unloggable line)"; } });
    return safe.map((l, i) => (i === 0 ? `${new Date(now()).toISOString()} ${l}` : `  ${l}`)).join("\n") + "\n";
  }
  function write(msg) {
    try {
      if (!open()) return false;
      const out = format(msg), n = Buffer.byteLength(out);
      if (size > 0 && size + n > max) rotate();
      fs.appendFileSync(file, out, { mode: 0o600 });
      size += n;
      return true;
    } catch (_) { return false; }
  }
  // console.error 照舊印(開發版終端機看得到),另寫一份進檔。多參數的呼叫(console.error("[mobile]", m))照 util.format 接成一行
  function hook(con) {
    const orig = con.error.bind(con);
    con.error = (...a) => { orig(...a); try { write(util.format(...a)); } catch (_) { /* log 永遠不能炸 */ } };
  }
  return { write, hook, file: () => file };
}

module.exports = { createMainLog, MAX_BYTES, KEEP, LINE_MAX, LINES_MAX };
