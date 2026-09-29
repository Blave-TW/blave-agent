// Blave 電腦版 — 設定 › Agent 規則:這台電腦的常駐規則(state/preferences.md)與回覆語言(state/reply_lang)(主行程用)。
// 設計:blave-canon output/designer/spec-desktop-agent-rules-0.1.9.md(只做本機;跟雲端同步先擱置)。
//
// 為什麼長這樣:
//   - 讀跑 python:規則的解析要跟 api agent_strategies._parse_rules 逐字同義(同一條 regex、同一個 splitlines),
//     回覆語言直接用 runtime 的 strategy_reporter.read_reply_lang_setting()。畫面的清單要等於 agent 每一輪讀到的那一份。
//   - 寫走 daemon 的 preferences_set / reply_lang_set(runtime command_listener 那兩支):組 `- ` 條列、剝鷹架行、原子換檔
//     都只有那一份實作,ack 的 result 就是真正落檔的內容。
//   - 讀不到 ≠ 空:規則檔讀不動 / 不是 UTF-8 / 超過 16000 字 → rules: null,畫面不畫成 0 條、存檔一律拒絕——
//     覆蓋它等於把 agent 記的東西換成畫面上看不到的那份。
//   - 一次一筆寫入:兩筆整份覆寫會互蓋。
//   - 規則比對後才寫:畫面送來它編輯時依據的那份(base),寫之前重讀,跟磁碟上的不一樣 = agent 在這段時間改過 →
//     不寫,回 RULES_CHANGED 帶新內容讓畫面重畫、用戶再按一次。重讀到寫入之間的幾秒仍是 last-write-wins(同 web)。
//
// 這個檔不 require electron;python 與 daemon 由呼叫端注入(測試用假的)。
const { execFile } = require("child_process");

const REPLY_LANGS = ["zh", "cn", "en", "es", "pt", "vi", "ja"];
const REPLY_LANG_CUSTOM_MAX = 40;

/* -I -B:不吃 PYTHON* 環境、不寫 __pycache__(打包版的 runtime/ 在簽過章的 .app 裡)。
   規則:沒有檔 = [];讀不動 / 不是 UTF-8 / 超過 16000 字 = null(不截斷,截一半會被當成「規則被刪掉了」)。
   utf-8-sig 是刻意跟 api _parse_rules 不同的一處:PowerShell Set-Content 寫的檔帶 BOM,不認的話第一條看不到、存一次就被刪掉。
   回覆語言:照 runtime 讀;讀出來是「自動」但檔案裡其實有東西(壞檔)→ langReadable false。 */
const READ_PY = String.raw`
import json, os, re, sys
sys.path.insert(0, sys.argv[1])
import strategy_reporter as sr
BULLET = re.compile(r"^ {0,3}(?:[-*+]|\d{1,3}[.)])\s+(.*\S)\s*$")
rules = None
try:
    with open(os.path.join(sr.WORKSPACE, "state", "preferences.md"), encoding="utf-8-sig") as f:
        text = f.read(16001)
    if len(text) <= 16000:
        rules = [m.group(1) for m in map(BULLET.match, text.splitlines()) if m]
except FileNotFoundError:
    rules = []
except (OSError, UnicodeDecodeError):
    rules = None
lang, custom = sr.read_reply_lang_setting()
readable = True
if not (lang or custom):
    try:
        with open(sr.REPLY_LANG_PATH, "rb") as f:
            readable = not f.read(4096).strip()
    except FileNotFoundError:
        pass
    except OSError:
        readable = False
json.dump({"rules": rules, "lang": lang, "custom": custom, "langReadable": readable}, sys.stdout)
`;

const UNREADABLE = () => ({ rules: null, replyLang: { lang: "", custom: "" }, langReadable: false });
function readLocal({ python, runtimeDir, workspace, env, timeout = 15000 }) {
  return new Promise((resolve) => {
    execFile(python, ["-I", "-B", "-c", READ_PY, runtimeDir], { timeout, windowsHide: true, maxBuffer: 1 << 20,
      env: { ...env, BLAVE_AGENT_WORKSPACE: workspace } }, (err, stdout) => {
      let d = null;
      try { d = err ? null : JSON.parse(String(stdout)); } catch (_) { d = null; }
      if (!d || typeof d !== "object") return resolve(UNREADABLE());
      const rules = Array.isArray(d.rules) && d.rules.every((r) => typeof r === "string") ? d.rules : null;
      const lang = REPLY_LANGS.indexOf(d.lang) >= 0 ? d.lang : "";
      const custom = !lang && typeof d.custom === "string" && Array.from(d.custom).length <= REPLY_LANG_CUSTOM_MAX ? d.custom : "";
      resolve({ rules, replyLang: { lang, custom }, langReadable: d.langReadable === true });
    });
  });
}

/* deps:{ readLocal() → Promise<{rules, replyLang, langReadable}>, writeLocal(cmd, args) → Promise<daemon send 的回傳>,
          argsOk(cmd, args) → boolean(daemon.argsOk)} */
function createAgentRules(deps) {
  let tail = Promise.resolve();
  const enqueue = (fn) => { const p = tail.then(fn, fn); tail = p.then(() => {}, () => {}); return p; };
  return {
    read: () => deps.readLocal(),
    // → daemon 的回傳({ ok, result } / { ok: false, error })。preferences_set 收 { rules, base }:
    //   規則檔讀不到 → RULES_UNREADABLE;磁碟上 ≠ base → { RULES_CHANGED, state: 新讀數 }。兩種都不寫
    save: (cmd, args) => enqueue(async () => {
      if (cmd !== "preferences_set" && cmd !== "reply_lang_set") return { ok: false, error: "NOT_ALLOWED" };
      if (cmd === "reply_lang_set") return deps.argsOk(cmd, args) ? deps.writeLocal(cmd, args) : { ok: false, error: "BAD_ARGS" };
      const { base, ...rest } = args && typeof args === "object" ? args : {};
      if (!Array.isArray(base) || !base.every((r) => typeof r === "string") || !deps.argsOk(cmd, rest)) return { ok: false, error: "BAD_ARGS" };
      const cur = await deps.readLocal();
      if (cur.rules === null) return { ok: false, error: "RULES_UNREADABLE" };
      if (JSON.stringify(cur.rules) !== JSON.stringify(base)) return { ok: false, error: "RULES_CHANGED", state: cur };
      return deps.writeLocal(cmd, rest);
    }),
  };
}

module.exports = { createAgentRules, readLocal, READ_PY, REPLY_LANGS };
