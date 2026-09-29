// 設定 › Agent 規則的畫面競態:真的 renderer/rules.js 接真的 shell/agentrules.js + daemon.argsOk,只有磁碟、DOM、python 是假的。
// 讀取(python)可以按順序手動放行,用來排出「讀取送出後、回來前發生了寫入」這類時序。
// 守:存檔後畫面等於落檔內容、不跳假的「agent 也改了」(稽核 P1-1);重開設定時不能拿舊清單改(P1-2 畫面);
// agent 在編輯期間改了檔 → 不寫、換上新清單、保留用戶打的字(P1-2 主行程);P2 的讀取合併、讀不出的回覆語言、Enter 斷行;
// 以及頂端沒有範圍說明那一行(Wei 看過實機:不用寫)。
// 跑法:node tests/check_shell_rules_races.js(不需要 python、不開視窗)
const fs = require("fs"), path = require("path"), vm = require("vm");
const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "shell", "renderer", "rules.js"), "utf8");
const AR = require(path.join(ROOT, "shell", "agentrules.js")), { argsOk } = require(path.join(ROOT, "shell", "daemon.js"));
let red = 0; const t = (n, ok, extra) => { console.log((ok ? "PASS  " : "FAIL  ") + n + (ok || extra === undefined ? "" : "  → " + JSON.stringify(extra))); if (!ok) red++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const tick = () => new Promise((r) => setImmediate(r));

function node(tag) {
  const n = { tag, children: [], attrs: {}, on: {}, style: {}, dataset: {}, classList: { toggle() {}, add() {}, remove() {} },
    append(...c) { this.children.push(...c); }, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(k, f) { (this.on[k] = this.on[k] || []).push(f); },
    focus() {}, setSelectionRange() {}, querySelector() { return null; }, querySelectorAll() { return []; }, contains() { return true; },
    set textContent(v) { this.children = []; this._t = v; }, get textContent() { return this._t; }, set innerHTML(v) { this._h = v; } };
  return n;
}
const find = (n, pred) => { if (!n || typeof n !== "object") return null; if (pred(n)) return n; for (const c of n.children || []) { const f = find(c, pred); if (f) return f; } return null; };

// 一台假的電腦:磁碟 + 主行程(真的 agentrules)+ preload + 畫面
function machine({ rules = ["A", "B"], lang = { lang: "", custom: "" }, langReadable = true } = {}) {
  const m = { disk: rules.slice(), lang: { ...lang }, langReadable, reads: [], stateCalls: 0, saves: [] };
  const snap = () => ({ rules: m.disk.slice(), replyLang: { ...m.lang }, langReadable: m.langReadable });
  const main = AR.createAgentRules({
    readLocal: async () => snap(), argsOk,
    writeLocal: async (cmd, args) => {
      if (cmd === "preferences_set") { m.disk = args.rules.map((r) => r.trim()); return { ok: true, result: { rules: m.disk.slice() } }; }
      m.lang = { lang: args.lang, custom: args.custom || "" }; m.langReadable = true; return { ok: true, result: { ...m.lang } };
    },
  });
  const els = {}, winOn = {};
  const ctx = { console, Array, JSON, String, Promise, Object,
    document: { createElement: node, activeElement: null, body: {}, createTextNode: (s) => ({ s }), querySelector: () => null },
    window: { addEventListener: (k, f) => { winOn[k] = f; }, blave: {
      // 讀取 = python 當下看到的磁碟,回來的時間由測試決定(m.release)
      rulesState: () => { m.stateCalls++; const v = snap(); return new Promise((res) => m.reads.push(() => res(v))); },
      // = main.js 的 rules-save handler(沒帶 base 就不帶,讓修正前的畫面也照它當時的契約跑)
      rulesSave: (r, base) => { m.saves.push(r); return main.save("preferences_set", base === undefined ? { rules: r } : { rules: r, base: Array.isArray(base) ? base : null }); },
      replyLangSave: (l, c) => main.save("reply_lang_set", { lang: typeof l === "string" ? l : null, custom: typeof c === "string" ? c : "" }),
    } },
    $: (id) => els[id] || (els[id] = node("div")), t: (k) => k, setFocusGuard() {}, srSay() {}, trackFeature() {},
    trSendError: (r) => "err:" + (r && r.error), trKindOf: () => "rejected" };
  vm.createContext(ctx);
  vm.runInContext(SRC + "\n;this.RS = RS;", ctx);
  m.ctx = ctx; m.RS = ctx.RS; m.focus = () => winOn.focus && winOn.focus();
  m.release = async () => { const f = m.reads.shift(); if (f) f(); await tick(); await tick(); };
  m.releaseAll = async () => { while (m.reads.length) await m.release(); };
  m.shown = () => m.RS.v && m.RS.v.rules;
  m.sel = () => find(els["set-rules"], (n) => n.id === "rules-rl-sel");
  return m;
}

(async () => {
  // ---- P1-1:編輯中讀回來的舊內容被暫存,存檔成功後又被套回去 ----
  {
    const m = machine(), { RS, ctx } = m;
    ctx.rulesOpen(); await m.release();
    ctx.rulesAddRow(); RS.edit.text = "C";
    m.focus(); await m.release();              // 切到別的 app 再回來:讀回存檔前的 [A,B]
    await ctx.rulesSave("C"); await m.releaseAll();
    t("編輯中切出去再回來、存檔:畫面 = 磁碟 = [A,B,C],不跳「agent 也改了」", eq(m.shown(), ["A", "B", "C"]) && eq(m.disk, ["A", "B", "C"]) && RS.note !== "rules",
      { disk: m.disk, shown: m.shown(), note: RS.note });
    RS.confirm = { index: 0, busy: false, err: null }; await ctx.rulesDelete(); await m.releaseAll();
    t("接著刪第一條:剛存的 C 還在", eq(m.disk, ["B", "C"]), m.disk);
  }
  {
    const m = machine(), { RS, ctx } = m;
    ctx.rulesOpen(); await m.release();
    m.focus();                                 // 讀取送出(看到 [A,B]),還沒回來
    ctx.rulesAddRow(); await ctx.rulesSave("C");
    await m.releaseAll();                      // 那筆舊讀取在 ack 之後、沒有東西在忙時才回來
    t("寫入前送出的讀取在 ack 之後才回來:丟掉,畫面仍是 [A,B,C]", eq(m.shown(), ["A", "B", "C"]) && RS.note !== "rules", { shown: m.shown(), note: RS.note });
  }
  {
    const m = machine(), { RS, ctx } = m;
    ctx.rulesOpen(); await m.release();
    m.focus();
    const w = ctx.rlWrite({ lang: "en", custom: "" });
    await m.release();                         // 語言寫入在途時讀回的舊值(自動)進了暫存
    await w; await m.releaseAll();
    t("回覆語言:寫入後不被暫存的舊值撥回、不跳「在機器上改了」", RS.v.replyLang.lang === "en" && m.lang.lang === "en" && RS.note !== "rlang", { v: RS.v.replyLang, note: RS.note });
  }

  // ---- P1-2(畫面):重開設定時先畫上一次的舊清單 ----
  {
    const m = machine(), { RS, ctx } = m;
    ctx.rulesOpen(); await m.release(); ctx.rulesClear();
    m.disk = ["A", "B", "C"];                  // 關著的時候 agent 記了一條
    ctx.rulesOpen();
    ctx.rulesAddRow();
    t("重開設定、讀回來之前:只有骨架,按不了新增", RS.v === null && RS.edit === null, { v: RS.v, edit: RS.edit });
    if (RS.edit) RS.edit.text = "D";
    await m.release();
    if (!RS.edit) ctx.rulesAddRow();
    await ctx.rulesSave("D"); await m.releaseAll();
    t("重開後新增:agent 記的 C 沒被蓋掉,畫面 = 磁碟", eq(m.disk, ["A", "B", "C", "D"]) && eq(m.shown(), m.disk), { disk: m.disk, shown: m.shown() });
  }

  // ---- P1-2(主行程):編輯期間 agent 改了檔 ----
  {
    const m = machine(), { RS, ctx } = m;
    ctx.rulesOpen(); await m.release();
    ctx.rulesAddRow(); RS.edit.text = "D";
    m.disk = ["A", "B", "C"];                  // 沒有任何讀取:畫面不知道
    await ctx.rulesSave("D"); await m.releaseAll();
    t("存檔時磁碟已經不是畫面那份:不寫(C 還在)", eq(m.disk, ["A", "B", "C"]), m.disk);
    t("…畫面換上新清單、跳「agent 也改了」、用戶打的字留著可以再按", eq(m.shown(), ["A", "B", "C"]) && RS.note === "rules" && RS.edit && RS.edit.text === "D" && !RS.edit.busy && RS.edit.index === null,
      { shown: m.shown(), note: RS.note, edit: RS.edit });
    if (RS.edit) { await ctx.rulesSave(RS.edit.text); await m.releaseAll(); }
    t("…再按一次:[A,B,C,D]", eq(m.disk, ["A", "B", "C", "D"]), m.disk);
  }
  {
    const m = machine(), { RS, ctx } = m;
    ctx.rulesOpen(); await m.release();
    RS.edit = { index: 1, text: "B2", busy: false, err: null };
    m.disk = ["X", "A", "B"];
    await ctx.rulesSave("B2"); await m.releaseAll();
    t("編輯既有那條時 agent 在前面插了一條:編輯跟著原本那條走", RS.edit && RS.edit.index === 2 && eq(m.disk, ["X", "A", "B"]), { edit: RS.edit, disk: m.disk });
    if (RS.edit) { await ctx.rulesSave(RS.edit.text); await m.releaseAll(); }
    t("…再按一次:改到的是 B,不是 A", eq(m.disk, ["X", "A", "B2"]), m.disk);
    RS.confirm = { index: 1, busy: false, err: null }; m.disk = ["X", "B2"];   // 要刪的 A 已經被 agent 刪了
    await ctx.rulesDelete(); await m.releaseAll();
    t("要刪的那條已經不在了:不寫、確認列收掉", eq(m.disk, ["X", "B2"]) && RS.confirm === null && eq(m.shown(), ["X", "B2"]), { disk: m.disk, confirm: RS.confirm });
  }

  // ---- P2 ----
  {
    const m = machine(), { ctx } = m;
    ctx.rulesOpen(); await m.release();
    const n0 = m.stateCalls; m.focus(); m.focus(); m.focus();
    t("視窗連續回到前景三次:只讀一次(共用在途那一筆)", m.stateCalls - n0 === 1, m.stateCalls - n0);
    ctx.rulesAddRow(); await ctx.rulesSave("C");
    t("…但寫入之後一定重讀,不共用寫入前那筆", m.stateCalls - n0 === 2, m.stateCalls - n0);
    await m.releaseAll();
  }
  {
    const m = machine({ lang: { lang: "", custom: "" }, langReadable: false }), { RS, ctx } = m;
    ctx.rulesOpen(); await m.release();
    const sel = m.sel(), picked = sel && sel.children.find((o) => o.selected);
    t("回覆語言檔讀不出來:顯示「—」,不假裝是「自動」", picked && picked.value === "-", picked && picked.value);
    if (sel) { sel.value = ""; sel.on.change.forEach((f) => f()); }
    await tick(); await m.releaseAll();
    t("…選「自動」會真的寫(把壞檔清掉)", m.langReadable === true && RS.v.langReadable === true, { machine: m.langReadable, v: RS.v.langReadable });
  }
  {
    const m = machine(), { RS, ctx } = m;
    ctx.rulesOpen(); await m.release();
    ctx.rulesAddRow(); await ctx.rulesSave("回測至少\n三年 以上"); await m.releaseAll();
    t("在編輯框按 Enter 的斷行:存成一行,不被 BAD_ARGS 擋掉", eq(m.disk, ["A", "B", "回測至少 三年 以上"]), m.disk);
    ctx.rulesAddRow(); await ctx.rulesSave("\x1f"); await m.releaseAll();
    t("只有 Python 會當空白剝掉的字元(\\x1f):當成空的,不送", eq(m.disk, ["A", "B", "回測至少 三年 以上"]) && m.saves.length === 1 && RS.edit && !RS.edit.busy, { disk: m.disk, saves: m.saves.length });
  }

  // ---- 頂端不放範圍說明(Wei 看過實機:不用寫)----
  {
    const m = machine(); m.ctx.rulesOpen(); await m.release();
    const lead = find(m.ctx.$("set-rules"), (n) => /rules-lead|rules-local/.test(n.className || "") || /^rules\.(lead|localOnly)$/.test(n._t || ""));
    t("設定 › Agent 規則頂端沒有範圍說明那一行(畫面、字串、樣式都拿掉了)", !lead
      && !/rules\.lead|rules\.localOnly|envCloudKind|TR_BAGS/.test(SRC)
      && !/rules-lead|rules-local/.test(fs.readFileSync(path.join(ROOT, "shell", "renderer", "rules.css"), "utf8"))
      && !/rules\.lead|rules\.localOnly/.test(fs.readFileSync(path.join(ROOT, "shell", "renderer", "strings.js"), "utf8")));
  }

  console.log(red ? `\n${red} FAILED` : "\nALL PASS");
  process.exit(red ? 1 : 0);
})();
