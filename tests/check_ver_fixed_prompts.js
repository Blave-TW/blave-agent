// 策略版本的固定訊息(用 vN 建立新策略)三處逐字一致:references/strategy-code.md(agent 認的三種形式)、
// 電腦版 shell/i18n/{zh,en}.po 的 ver.msgFork、web 七個語系 po 的 workspace_ver_msg_fork。
// 還原在 0.1.9 改成直接指令(version_restore),電腦版不再有 ver.msgRestore;references 仍列還原那三種形式,
// 是給還在送舊句的 0.1.8 電腦版與未更新的網頁認的過渡辨識(只驗 references 那一側)。
// agent 靠逐字認出固定訊息才會免確認照做;哪一邊改了一個標點,那一邊送出的就變成一般訊息(0.1.8 稽核 W1)。
// 跑法:node tests/check_ver_fixed_prompts.js(沒有 monorepo 版面的 web/ 時,web 那段 SKIP)
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, ".."), WEB = process.env.BLAVE_WEB_DIR || path.join(ROOT, "..", "web");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "\n      " + String(d).slice(0, 900))); if (!c) red++; };
const po = (file, id) => {
  const m = new RegExp('^msgid "' + id.replace(/\./g, "\\.") + '"\\n((?:msgstr )?"(?:[^"\\\\]|\\\\.)*"\\n)+', "m").exec(fs.readFileSync(file, "utf8"));
  if (!m) return null;
  return [...m[0].split("\n").slice(1).join("\n").matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]).join("").replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
};
const ref = fs.readFileSync(path.join(ROOT, "references", "strategy-code.md"), "utf8");
const section = (head) => { const i = ref.indexOf("### " + head); if (i < 0) return ""; const j = ref.indexOf("\n### ", i + 4); return ref.slice(i, j < 0 ? undefined : j); };
// 一節裡的三種形式:zh (traditional)「…」、zh (simplified)「…」、en "…"(英文那句在 md 裡會折行)
const forms = (sec) => {
  const g = (re) => { const m = re.exec(sec); return m ? m[1].replace(/\s*\n\s*/g, " ") : null; };
  return { zh: g(/^- zh \(traditional\)「([\s\S]*?)」\n/m), cn: g(/^- zh \(simplified\)「([\s\S]*?)」\n/m), en: g(/^- en "([\s\S]*?)"\n/m) };
};
const REF = { restore: forms(section("Restoring a version")), fork: forms(section("Forking from a version")) };
ok("references 兩節各有三種形式,都帶 {display_name} {name} {n} 與免確認那句", ["restore", "fork"].every((k) => ["zh", "cn", "en"].every((l) => REF[k][l] && ["{display_name}", "{name}", "{n}"].every((v) => REF[k][l].includes(v))))
  && /不用再確認$/.test(REF.fork.zh) && /不用再确认$/.test(REF.fork.cn) && /no further confirmation needed\.$/.test(REF.fork.en) && /不用再確認$/.test(REF.restore.zh) && /no further confirmation needed\.$/.test(REF.restore.en), JSON.stringify(REF));
ok("電腦版不再有還原的固定訊息(ver.msgRestore 兩語都刪了)", ["zh", "en"].every((l) => po(path.join(ROOT, "shell", "i18n", l + ".po"), "ver.msgRestore") === null));
for (const [kind, key] of [["fork", "ver.msgFork"]]) for (const l of ["zh", "en"]) {
  const got = po(path.join(ROOT, "shell", "i18n", l + ".po"), key);
  ok("電腦版 " + l + " " + key + " = references", got === REF[kind][l], JSON.stringify([got, REF[kind][l]]));
}
const tr = path.join(WEB, "app", "translations");
if (!fs.existsSync(tr)) console.log("SKIP  web 七個語系(找不到 " + tr + ";可設 BLAVE_WEB_DIR)");
else {
  const langs = fs.readdirSync(tr).filter((d) => fs.existsSync(path.join(tr, d, "LC_MESSAGES", "messages.po"))).sort();
  ok("web 有七個語系", langs.join() === "en,es,ja,pt,vi,zh,zh_Hans_CN", langs.join());
  for (const [kind, id] of [["fork", "workspace_ver_msg_fork"]]) for (const d of langs) {
    const want = REF[kind][d === "zh" ? "zh" : d === "zh_Hans_CN" ? "cn" : "en"], got = po(path.join(tr, d, "LC_MESSAGES", "messages.po"), id);
    ok("web " + d + " " + id + " = references", got === want, JSON.stringify([got, want]));
  }
  // 過渡期:web 還沒上線就地還原時仍送還原句,references 靠逐字認它 → 還在就要逐字相同;
  // web 那批刪掉這個 msgid 之後這段自動不驗,references 的過渡行照 canon 一起收掉
  for (const d of langs) {
    const got = po(path.join(tr, d, "LC_MESSAGES", "messages.po"), "workspace_ver_msg_restore");
    if (got === null) continue;
    const want = REF.restore[d === "zh" ? "zh" : d === "zh_Hans_CN" ? "cn" : "en"];
    ok("web " + d + " workspace_ver_msg_restore(過渡期還在)= references", got === want, JSON.stringify([got, want]));
  }
}
console.log(red ? `\n${red} FAILED` : "\nALL PASS"); process.exit(red ? 1 : 0);
