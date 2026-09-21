// shell/main.js 的 mergePath:登入 shell 解析出的 PATH 後面一律補上已知安裝位置。
// 起因:zsh -lc 不讀 .zshrc,而 Claude Code 安裝器把 ~/.local/bin 寫在 .zshrc → 從 Finder 開 app 偵測不到 claude。
// 跑法:node tests/check_shell_login_path.js
const fs = require("fs"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8");
const m = src.match(/^const mergePath = .*$/m);
if (!m) { console.log("FAIL  找不到 mergePath"); process.exit(1); }
eval(m[0].replace(/^const /, "var "));
let red = 0; const t = (n, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) red++; };
const K = ["/Users/x/.local/bin", "/opt/homebrew/bin", "/usr/bin"];
t("shell 漏掉的補在後面、順序以 shell 為先", mergePath(["/usr/bin", "/bin"], K) === "/usr/bin:/bin:/Users/x/.local/bin:/opt/homebrew/bin");
t("已經有的不重複", mergePath(["/Users/x/.local/bin", "/usr/bin"], K) === "/Users/x/.local/bin:/usr/bin:/opt/homebrew/bin");
t("shell 失敗(空)= 只剩已知位置", mergePath([], K) === K.join(":"));
t("空段不留", mergePath(["", "/bin"], K).split(":").every(Boolean));
t("loginShellPath 真的有用 mergePath", /resolvedPath = mergePath\(got, known\)/.test(src));
console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
