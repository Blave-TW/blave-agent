/* 設定 › Agent 規則(常駐規則 + 回覆語言)。主行程那一半在 shell/agentrules.js:讀寫這台電腦的兩個檔。
   設計:blave-canon output/designer/spec-desktop-agent-rules-0.1.9.md(v2 的版式;跟雲端同步先擱置,只做本機)。
   狀態機、閘二、Esc 照 web 工作頁的 renderRules / rlBuild 搬,只換成電腦版的元件(§3)與列內錯誤句(§6.1)。
   - 這一頁永遠顯示、編輯這台電腦那一份(兩種視角的回合都在本機跑、讀同一份)。
   - 列內錯誤只講本機 daemon 的結果(trSendError(res, null, "local")):沒送到 / 送了但沒回覆 / 被拒。
   - 規則與語言名是 agent 或用戶寫的:一律 textContent。
   用到 app.js 的 $ / t / setFocusGuard / srSay / trackFeature / setCat 與 trade.js 的 trSendError / trKindOf——都在呼叫時才取。 */
const RULES_MAX = 10, RULES_LEN = 150, RL_CUSTOM_MAX = 40;
// 語言名是資料不是文案(不進 .po),中文寫成跳脫碼;順序同 web 工作頁的 LANGS
const RL_LANGS = [["zh", "\u7e41\u9ad4\u4e2d\u6587"], ["en", "English"], ["cn", "\u7b80\u4f53\u4e2d\u6587"], ["ja", "\u65e5\u672c\u8a9e"],
  ["pt", "Portugu\u00eas"], ["es", "Espa\u00f1ol"], ["vi", "Ti\u1ebfng Vi\u1ec7t"]];

const RS = {
  v: null,          // 主行程最後一份 { rules: [string]|null(null = 讀不到), replyLang: {lang, custom}, langReadable }
  pending: null,    // 閘二:有列不是唯讀(或語言寫入在途)時進來的那份,回到唯讀再套
  // 閘一:每次寫入結束(不論成敗)與每次開頁 +1。讀取送出時記下當下的值,讀回來時已經不是這個值就整份丟掉——
  // 寫入前送出的讀取可能在 ack 之後才回來,套上去會把畫面退回存檔前、下一個動作再把剛存的刪掉(稽核 P1-1)
  writeGen: 0, readGen: null,
  edit: null,       // { index: number|null(新增), text, busy, err: {text, calm}|null }
  confirm: null,    // { index, busy, err }
  note: null,       // "rules" | "rlang":設定開著時檔案被改了(agent 在背景改的)
  rl: { saving: null, err: null, pick: false, draft: null, building: false },
  open: false, fresh: false, countSaid: null,
};
const rsEl = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const rsBtn = (cls, text, fn) => { const b = rsEl("button", cls, text); b.type = "button"; b.addEventListener("click", fn); return b; };
const rulesLen = (s) => Array.from(String(s)).length;   // 代理對算一個字
const rulesTrunc = (s) => { const cs = Array.from(String(s)); return cs.length > 20 ? cs.slice(0, 20).join("") + "\u2026" : cs.join(""); };
const rulesBusy = () => !!(RS.edit || RS.confirm || RS.rl.saving);
const rlSame = (a, b) => !!a && !!b && a.lang === b.lang && a.custom === b.custom;

// 列內錯誤:本機 daemon 的三種結果。送了但沒回覆是灰色短劃(不是失敗)
function rulesErr(r) {
  const res = r && typeof r === "object" ? r : { ok: false, error: "DAEMON_DOWN" };
  return { text: trSendError(res, null, "local"), calm: trKindOf(res) === "unknown" };
}
function rulesErrLine(err, id) {
  const p = rsEl("p", "plan-err" + (err.calm ? " is-calm" : "")), m = rsEl("span", "fault-mark");
  m.setAttribute("aria-hidden", "true"); p.setAttribute("role", "alert"); if (id) p.id = id;
  p.append(m, rsEl("span", null, err.text));
  return p;
}

/* ── 進出這個分類 ── */
function rulesOpen() {
  RS.open = true; RS.note = null; RS.fresh = true;   // 開頁那一次讀回來的不算「開著時被改了」
  // 上次開頁的清單可能已經被 agent 改過:讀回來之前只畫骨架,不給用舊清單新增 / 刪除(稽核 P1-2)。
  // 還有寫入在途時不清:它的 ack 要寫回 RS.v,寫完也會自己重讀
  if (!rulesBusy()) { RS.v = null; RS.pending = null; RS.countSaid = null; RS.writeGen++; }
  rulesPaint();
  trackFeature("settings_rules");
  rulesReload();
}
// 同一個世代已經有一筆讀取在途就共用它(視窗切來切去不要每次 spawn 一個 python);換了世代一定重讀
function rulesReload() {
  const gen = RS.writeGen;
  if (RS.readGen === gen) return;
  RS.readGen = gen;
  window.blave.rulesState().then((v) => { if (gen === RS.writeGen) rulesAbsorb(v); }).catch(() => {})
    .then(() => { if (RS.readGen === gen) RS.readGen = null; });
}
// 寫入結束:之前讀到的(包括暫存的)都不能信,重讀一份寫入後的
function rulesWrote() { RS.writeGen++; RS.pending = null; rulesReload(); }
// 離開分類或關掉設定:沒送出的編輯 / 確認 / 「其他」的草稿丟掉;已經送出的照常跑完、結果照樣畫回來
function rulesClear() {
  RS.open = false; RS.note = null;
  if (RS.edit && !RS.edit.busy) RS.edit = null;
  if (RS.confirm && !RS.confirm.busy) RS.confirm = null;
  RS.rl.pick = false; RS.rl.draft = null; RS.rl.err = null;
  rulesFlushPending();
  rulesPaint();
}

/* ── 主行程讀回來的內容 ── */
function rulesAbsorb(v) {
  if (!v || typeof v !== "object") return;
  if (rulesBusy()) { RS.pending = v; return; }   // 閘二:用戶打到一半的字不能被洗掉
  rulesApply(v);
}
function rulesApply(v) {
  const prev = RS.v;
  RS.v = { rules: Array.isArray(v.rules) ? v.rules.filter((r) => typeof r === "string") : null,
    replyLang: v.replyLang && typeof v.replyLang === "object" ? { lang: String(v.replyLang.lang || ""), custom: String(v.replyLang.custom || "") } : { lang: "", custom: "" },
    langReadable: v.langReadable !== false };
  const fresh = RS.fresh; RS.fresh = false;
  if (prev && RS.open && !fresh) {
    if (JSON.stringify(prev.rules) !== JSON.stringify(RS.v.rules)) { RS.note = "rules"; srSay(t("rules.agentChanged")); }
    else if (!rlSame(prev.replyLang, RS.v.replyLang)) { RS.note = "rlang"; srSay(t("rlang.changed")); }
  }
  rulesPaint();
}
function rulesFlushPending() {
  if (!RS.pending || rulesBusy()) return;
  const v = RS.pending; RS.pending = null;
  rulesApply(v);
}

/* ── 畫 ── */
function rulesPaint() {
  const box = $("set-rules"); if (!box) return;
  box.textContent = "";
  if (!RS.v) {   // 讀取中:兩組的骨架,控件不畫
    const sk = rsEl("div", "rules-sk"); sk.append(rsEl("div", "sk"), rsEl("div", "sk s"));
    box.append(sk); setFocusGuard(); return;
  }
  const rl = rsEl("div", "rules-grp"); rl.id = "rules-rl"; box.append(rl); rlPaint(rl);
  const grp = rsEl("div", "rules-grp"); grp.id = "rules-grp"; box.append(grp); rulesPaintList(grp);
  setFocusGuard();
}
/* ── 回覆語言(照 web rlBuild / rlCustomRow)── */
function rlPaint(box) {
  if (!box || !RS.v) return;
  const act = document.activeElement, caret = act && act.id === "rules-rl-inp" ? [act.selectionStart, act.selectionEnd] : null;
  RS.rl.building = true; box.textContent = ""; RS.rl.building = false;
  const cur = RS.v.replyLang, saving = RS.rl.saving, shown = saving || cur;
  let pick = null;   // "" 自動 / 七碼 / "custom" 其他 / null = 「—」(機器上的值不在選項裡,不假裝)
  if (RS.rl.pick || shown.custom) pick = "custom";
  else if ((saving || RS.v.langReadable) && (shown.lang === "" || RL_LANGS.some(([c]) => c === shown.lang))) pick = shown.lang;
  const desc = pick === "" ? t("rlang.descAutoLocal") : t("rlang.descLocal");
  const row = rsEl("div", "set-row"), tw = rsEl("span", "rules-tipw");
  const label = rsEl("label", "set-gl rules-tipb", t("rlang.label")); label.id = "rules-rl-lbl"; label.htmlFor = "rules-rl-sel"; label.tabIndex = 0;
  const tip = rsEl("span", "tip", desc); tip.id = "rules-rl-tip"; tip.setAttribute("role", "tooltip");
  label.setAttribute("aria-describedby", "rules-rl-tip");
  tw.append(label, tip); row.append(tw);
  if (saving) { const sp = rsEl("span", "spin16"); sp.setAttribute("aria-hidden", "true"); row.append(sp); }
  const wrap = rsEl("span", "set-selw"), sel = rsEl("select", "set-sel"); sel.id = "rules-rl-sel";
  const opt = (value, text, on) => { const o = rsEl("option", null, text); o.value = value; if (on) o.selected = true; sel.append(o); return o; };
  if (pick === null) opt("-", "\u2014", true).disabled = true;
  opt("", t("rlang.auto"), pick === "");
  RL_LANGS.forEach(([c, name]) => opt(c, name, pick === c));
  opt("custom", t("rlang.other"), pick === "custom");
  sel.disabled = !!saving;
  if (saving) sel.setAttribute("aria-busy", "true");
  sel.setAttribute("aria-describedby", "rules-rl-tip" + (RS.rl.err ? " rules-rl-err" : ""));
  sel.addEventListener("change", () => {
    if (RS.rl.saving) return;
    RS.note = null; RS.rl.draft = null;
    if (sel.value === "custom") {   // 選「其他」當下不寫;焦點直接移進輸入框
      RS.rl.pick = true; rlPaint(box); const inp = $("rules-rl-inp"); if (inp) inp.focus(); return;
    }
    RS.rl.pick = false;
    const next = { lang: sel.value, custom: "" };
    if (RS.v.langReadable && rlSame(next, RS.v.replyLang)) rlPaint(box); else rlWrite(next);   // 讀不出來的檔:選「自動」也要寫(清掉壞檔)
  });
  wrap.append(sel); row.append(wrap); box.append(row);
  if (pick === "custom") {
    const inp = rlCustomRow(box);
    if (caret && !inp.disabled) { inp.focus(); inp.setSelectionRange(caret[0], caret[1]); }
  }
  if (RS.note === "rlang") box.append(rsEl("p", "cn-hint up", t("rlang.changed")));
  if (RS.rl.err) box.append(rulesErrLine(RS.rl.err, "rules-rl-err"));
}
function rlCustomRow(box) {
  const row = rsEl("div", "set-row rules-rl-custom"), inp = rsEl("input", "f-input txt");
  inp.type = "text"; inp.id = "rules-rl-inp"; inp.maxLength = RL_CUSTOM_MAX; inp.autocomplete = "off"; inp.spellcheck = false;
  inp.placeholder = t("rlang.customPh");
  inp.setAttribute("aria-labelledby", "rules-rl-lbl"); inp.setAttribute("aria-describedby", "rules-rl-tip rules-rl-cnt" + (RS.rl.err ? " rules-rl-err" : ""));
  const saving = RS.rl.saving;
  inp.value = saving ? saving.custom : RS.rl.draft !== null ? RS.rl.draft : RS.v.replyLang.custom;
  inp.disabled = !!saving;
  const cnt = rsEl("span", "mono rules-rl-cnt"); cnt.id = "rules-rl-cnt";
  row.append(inp, cnt); box.append(row);
  cnt.textContent = rulesLen(inp.value) + " / " + RL_CUSTOM_MAX;
  // < > 機器端一律拒收:打進來就拿掉,不送出去等被拒
  inp.addEventListener("input", (e) => {
    if (!e.isComposing && /[<>]/.test(inp.value)) {
      const at = inp.selectionStart, cut = inp.value.slice(0, at).replace(/[^<>]/g, "").length;
      inp.value = inp.value.replace(/[<>]/g, ""); inp.setSelectionRange(at - cut, at - cut);
    }
    rlSetInput(inp, inp.value, true);
  });
  // 單行欄位:貼上多行換成一個空白
  inp.addEventListener("paste", (e) => {
    const s = e.clipboardData ? e.clipboardData.getData("text") : "";
    if (!/[\r\n]/.test(s)) return;
    e.preventDefault();
    const a = inp.selectionStart, b = inp.selectionEnd;
    let add = s.replace(/\s*[\r\n]+\s*/g, " ").replace(/[<>]/g, "");
    add = add.slice(0, Math.max(0, RL_CUSTOM_MAX - inp.value.length + (b - a)));
    if (/[\uD800-\uDBFF]$/.test(add)) add = add.slice(0, -1);
    inp.setRangeText(add, a, b, "end");
    rlSetInput(inp, inp.value, true);
  });
  inp.addEventListener("keydown", (e) => { if (e.key !== "Enter" || e.isComposing) return; e.preventDefault(); rlSubmitCustom(inp); });
  inp.addEventListener("blur", () => { if (RS.rl.building || !RS.open) return; rlSubmitCustom(inp); });
  return inp;
}
function rlSetInput(inp, v, keep) {
  if (inp.value !== v) inp.value = v;
  RS.rl.draft = keep ? v : null;
  const cnt = $("rules-rl-cnt"); if (cnt) cnt.textContent = rulesLen(v) + " / " + RL_CUSTOM_MAX;
}
function rlSubmitCustom(inp) {
  if (RS.rl.saving || inp.disabled) return;
  const text = inp.value.replace(/[<>]/g, "").trim();
  if (text && text !== RS.v.replyLang.custom) { rlWrite({ lang: "", custom: text }); return; }
  if (text || RS.v.replyLang.custom) rlSetInput(inp, RS.v.replyLang.custom, false);   // 空值不送:撥回存好的值
}
async function rlWrite(val) {
  const back = val.custom ? "rules-rl-inp" : "rules-rl-sel";
  RS.rl.saving = val; RS.rl.err = null; RS.note = null;
  rlPaint($("rules-rl"));
  let r = null;
  try { r = await window.blave.replyLangSave(val.lang, val.custom); } catch (_) { r = null; }
  RS.rl.saving = null; RS.rl.draft = null; RS.rl.pick = false;
  if (r && r.ok) {
    const res = r.result && typeof r.result === "object" ? r.result : {};
    // 以 ack 為準:機器會清洗自訂文字,剛好是七碼之一的(「ZH」)會正規化成代碼
    RS.v.replyLang = { lang: typeof res.lang === "string" ? res.lang : val.lang, custom: typeof res.custom === "string" ? res.custom : "" };
    RS.v.langReadable = true;
    trackFeature("reply_lang_set");
  } else RS.rl.err = rulesErr(r);   // 撥回上一個真值
  rulesWrote();
  rlPaint($("rules-rl"));
  const act = document.activeElement;
  if (!act || act === document.body || !$("set-modal").contains(act)) { const n = $(back) || $("rules-rl-sel"); if (n && !n.disabled) n.focus(); }
}

/* ── 常駐規則(照 web renderRules / rulesRow / rulesEditRow / rulesConfirmRow)── */
function rulesPaintList(grp) {
  if (!grp || !RS.v) return;
  grp.textContent = "";
  const rules = RS.v.rules;
  if (rules === null) { grp.append(rsEl("p", "cn-hint up rules-readfail", t("rules.readFail"))); return; }   // 讀不到 ≠ 0 條:不給新增
  const n = rules.length, over = n > RULES_MAX, busy = rulesBusy();
  const top = rsEl("div", "rules-top"), tw = rsEl("span", "rules-tipw");
  const head = rsEl("span", "set-gl rules-tipb", t("rules.head")); head.tabIndex = 0; head.setAttribute("aria-describedby", "rules-scope-tip");
  const tip = rsEl("span", "tip", t("rules.scope")); tip.id = "rules-scope-tip"; tip.setAttribute("role", "tooltip");
  tw.append(head, tip); top.append(tw);
  const count = rsEl("span", "mono rules-count" + (over ? " over" : ""), n + " / " + RULES_MAX); top.append(count);
  if (RS.countSaid !== null && RS.countSaid !== n && RS.open) srSay(n + " / " + RULES_MAX);   // 計數變了才播報
  RS.countSaid = n;
  const empty = n === 0 && !RS.edit;
  if (!empty) {
    const add = rsBtn("btn-out rules-add", t("rules.add"), rulesAddRow);
    add.disabled = busy || n >= RULES_MAX;
    if (n >= RULES_MAX) add.setAttribute("aria-describedby", "rules-limit");
    top.append(add);
  }
  grp.append(top);
  if (RS.note === "rules") grp.append(rsEl("p", "cn-hint up rules-note", t("rules.agentChanged")));
  if (empty) {
    const e = rsEl("div", "src-empty rules-empty");
    e.append(rsEl("p", null, t("rules.emptyLead")), rsEl("p", null, t("rules.emptyHow")), rsBtn("btn-fill", t("rules.add"), rulesAddRow));
    grp.append(e); return;
  }
  const list = rsEl("ul", "rules-list"); list.setAttribute("aria-label", t("rules.aria"));
  rules.forEach((text, i) => list.append(rulesRow(text, i)));
  if (RS.edit && RS.edit.index === null) list.append(rulesEditRow());   // 新增列在最後面
  grp.append(list);
  if (n >= RULES_MAX) {
    const p = rsEl("p", "rules-limit" + (over ? " over" : ""), over ? t("rules.over", { n }) : t("rules.full")); p.id = "rules-limit";
    grp.append(p);
  }
}
function rulesRow(text, i) {
  if (RS.edit && RS.edit.index === i) return rulesEditRow();
  if (RS.confirm && RS.confirm.index === i) return rulesConfirmRow(text);
  const busy = rulesBusy(), li = rsEl("li", "rules-row");
  const item = rsBtn("rules-item", text, () => {
    if (rulesBusy()) return;
    RS.note = null; RS.edit = { index: i, text, busy: false, err: null }; rulesPaintList($("rules-grp")); rulesFocus("edit");
  });
  item.disabled = busy;
  const del = rsBtn("rules-del", null, () => {
    if (rulesBusy()) return;
    RS.note = null; RS.confirm = { index: i, busy: false, err: null }; rulesPaintList($("rules-grp")); rulesFocus("confirm");
  });
  del.disabled = busy; del.setAttribute("aria-label", t("rules.delAria", { text: rulesTrunc(text) }));
  del.innerHTML = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';   // 同 .cs-del 的 ✕
  li.append(item, del);
  return li;
}
function rulesEditRow() {
  const st = RS.edit, li = rsEl("li", "rules-row is-edit");
  const ta = rsEl("textarea", "f-area"); ta.rows = 2; ta.value = st.text; ta.placeholder = t("rules.ph"); ta.disabled = st.busy;
  ta.setAttribute("aria-label", t("rules.head"));
  const err = rsEl("p", "plan-err"); err.setAttribute("role", "alert");
  const foot = rsEl("div", "rules-foot"), len = rsEl("span", "mono rules-len"), btns = rsEl("span", "rules-btns");
  const cancel = rsBtn("btn-out", t("del.cancel"), rulesCancel); cancel.disabled = st.busy;
  const save = rsBtn("btn-fill" + (st.busy ? " is-busy" : ""), null, () => rulesSave(ta.value));
  save.disabled = st.busy;
  if (st.busy) { const sp = rsEl("span", "spin16"); sp.setAttribute("aria-hidden", "true"); save.append(sp, document.createTextNode(" " + t("rules.saving"))); }
  else save.textContent = t("rules.save");
  btns.append(cancel, save); foot.append(len, btns);
  li.append(ta, err, foot);
  // 字數 / 超長 / 儲存鈕就地更新,不重畫整列(重畫 = 游標歸零)
  const sync = () => {
    st.text = ta.value;
    const one = rulesOneLine(ta.value), l = rulesLen(one), long = l > RULES_LEN;   // 算的是實際會存的那一行
    len.textContent = l + " / " + RULES_LEN; len.classList.toggle("over", long); ta.classList.toggle("is-err", long);
    const e = long ? { text: t("rules.tooLong", { n: l }), calm: false } : st.err;
    err.textContent = ""; err.className = "plan-err" + (e && e.calm ? " is-calm" : "");
    if (e) { const m = rsEl("span", "fault-mark"); m.setAttribute("aria-hidden", "true"); err.append(m, rsEl("span", null, e.text)); }
    err.hidden = !e;
    if (!st.busy) save.disabled = long || !one;
  };
  ta.addEventListener("input", sync);
  sync();
  return li;
}
function rulesConfirmRow(text) {
  const st = RS.confirm, li = rsEl("li", "rules-row is-confirm");
  const cf = rsEl("div", "rules-cf");
  cf.append(rsEl("span", "rules-cf-t", t("rules.delConfirm", { text: rulesTrunc(text) })), rsEl("span", "rules-cf-q", t("rules.delWarn")));
  li.append(cf);
  if (st.err) li.append(rulesErrLine(st.err));
  const foot = rsEl("div", "rules-foot"), btns = rsEl("span", "rules-btns");
  const cancel = rsBtn("btn-out rules-cf-cancel", t("del.cancel"), rulesCancel); cancel.disabled = st.busy;
  const go = rsBtn("btn-out cf-alt-danger", null, rulesDelete); go.disabled = st.busy;   // 紅字、不做紅色填色鈕
  if (st.busy) { const sp = rsEl("span", "spin16"); sp.setAttribute("aria-hidden", "true"); go.append(sp, document.createTextNode(" " + t("rules.deleting"))); }
  else go.textContent = st.err ? t("rules.delRetry") : t("rules.delOk");
  btns.append(cancel, go); foot.append(btns); li.append(foot);
  return li;
}
function rulesFocus(kind, i) {
  const pane = $("set-rules"); if (!pane) return;
  let el = null;
  if (kind === "edit") {
    el = pane.querySelector("textarea");
    if (el) { el.focus(); const n = el.value.length; try { el.setSelectionRange(n, n); } catch (_) { /* focus already there */ } return; }
  } else if (kind === "confirm") el = pane.querySelector(".rules-cf-cancel");   // 破壞性動作不預設焦點在破壞側
  else if (kind === "row") { const rows = pane.querySelectorAll(".rules-item"); el = rows[Math.min(i, rows.length - 1)] || null; }
  if (!el) el = pane.querySelector(".rules-add") || pane.querySelector(".rules-empty .btn-fill");
  if (!el) el = document.querySelector('.set-cat[data-set-cat="rules"]');
  if (el && el.focus) el.focus();
}
function rulesAddRow() {
  if (rulesBusy() || !RS.v || !RS.v.rules || RS.v.rules.length >= RULES_MAX) return;
  RS.note = null; RS.edit = { index: null, text: "", busy: false, err: null };
  rulesPaintList($("rules-grp")); rulesFocus("edit");
}
function rulesCancel() {
  const back = RS.edit ? RS.edit.index : RS.confirm ? RS.confirm.index : null;
  RS.edit = null; RS.confirm = null;   // 沒存的改動丟掉,不再問
  rulesFlushPending();
  rulesPaintList($("rules-grp"));
  if (back === null) rulesFocus("add"); else rulesFocus("row", back);
}
// Esc(app.js escTop 在 setClose 前問這裡):有列在編輯 / 確認 → 退回唯讀、不關設定;「其他」的輸入框改過 → 撥回;
// 本機寫入在途 → 吞掉這一下(指令已經送出,關掉面板只會讓結果沒人接)。回 null = 照常關設定
function rulesEscFn() {
  const pane = $("set-rules"); if (!pane || pane.hidden) return null;
  if ((RS.edit && RS.edit.busy) || (RS.confirm && RS.confirm.busy) || RS.rl.saving) return () => {};
  if (RS.edit || RS.confirm) return rulesCancel;
  const inp = $("rules-rl-inp");
  if (inp && document.activeElement === inp && RS.v && inp.value !== RS.v.replyLang.custom) return () => rlSetInput(inp, RS.v.replyLang.custom, false);
  return null;
}
// base = 這次編輯依據的那份;主行程存檔前重讀,跟磁碟上的不一樣就不寫、回 RULES_CHANGED 帶新內容(稽核 P1-2)
async function rulesWrite(next, base) {
  let r = null;
  try { r = await window.blave.rulesSave(next, base); } catch (_) { r = null; }
  rulesWrote();
  if (r && r.ok) {
    const res = r.result && Array.isArray(r.result.rules) ? r.result.rules.filter((x) => typeof x === "string") : next;
    return { ok: true, rules: res };   // ack 的 result 就是真正落檔的那份(機器會剝掉不合格的行)
  }
  // 規則檔讀不到(存的當下才發現):不寫,整組換成 readFail
  if (r && r.error === "RULES_UNREADABLE") return { ok: false, unreadable: true };
  if (r && r.error === "RULES_CHANGED" && r.state && Array.isArray(r.state.rules)) return { ok: false, changed: r.state.rules.filter((x) => typeof x === "string") };
  return { ok: false, err: rulesErr(r) };
}
// agent 在用戶編輯時改了檔:換上新清單、跳「agent 也改了」,編輯 / 確認留著讓用戶看過再按一次。
// 只換規則不換語言:語言寫入可能同時在途,由它自己的 ack 與重讀處理
function rulesChanged(rules, base) {
  RS.v.rules = rules; RS.note = "rules"; srSay(t("rules.agentChanged"));
  const at = (i) => (i === null || i >= base.length ? -1 : rules.indexOf(base[i]));
  if (RS.edit && RS.edit.index !== null) { const j = at(RS.edit.index); RS.edit.index = j >= 0 ? j : null; }   // 原本那條不見了 → 當成新增
  if (RS.confirm) { const j = at(RS.confirm.index); if (j >= 0) RS.confirm.index = j; else RS.confirm = null; }   // 要刪的那條已經沒了
}
// 一條規則 = 檔案裡的一行:Enter / 貼上帶進來的斷行(Python splitlines 會切開的那組)換成一個空白;
// 頭尾照 Python strip() 剝(它把 \x1f 當空白、JS trim 不會),免得送出「只有 \x1f」被機器拒收
const rulesOneLine = (s) => String(s).replace(/[\s\x1f]*[\r\n\x0b\x0c\x1c-\x1e\x85\u2028\u2029]+[\s\x1f]*/g, " ").replace(/^[\s\x1f]+|[\s\x1f]+$/g, "");
async function rulesSave(text) {
  const st = RS.edit; if (!st || st.busy) return;
  const v = rulesOneLine(text);
  if (!v || rulesLen(v) > RULES_LEN) return;
  const base = RS.v.rules.slice(), next = base.slice();
  if (st.index === null) next.push(v); else next[st.index] = v;
  st.text = v; st.busy = true; st.err = null;
  rulesPaintList($("rules-grp"));
  const r = await rulesWrite(next, base);
  if (r.ok) {
    const back = st.index === null ? r.rules.length - 1 : st.index;
    RS.edit = null; RS.v.rules = r.rules; trackFeature("rules_save");
    rulesPaintList($("rules-grp")); rulesFocus("row", back);
    return;
  }
  st.busy = false;
  if (r.changed) rulesChanged(r.changed, base);
  else if (r.unreadable) RS.edit = null; else st.err = r.err;   // 不清空、不回滾輸入:就地重試(送了但沒回覆也能直接再存,整份覆寫結果一樣)
  rulesPaintList($("rules-grp")); if (RS.edit) rulesFocus("edit");
}
async function rulesDelete() {
  const st = RS.confirm; if (!st || st.busy) return;
  const at = st.index, base = RS.v.rules.slice(), next = base.slice(); next.splice(at, 1);
  st.busy = true; st.err = null;
  rulesPaintList($("rules-grp"));
  const r = await rulesWrite(next, base);
  if (r.ok) {
    RS.confirm = null; RS.v.rules = r.rules; trackFeature("rules_delete");
    rulesPaintList($("rules-grp")); rulesFocus("row", at);
    return;
  }
  st.busy = false;   // 沒有樂觀移除:失敗時那一列還在,「刪除」換成「重試刪除」
  if (r.changed) rulesChanged(r.changed, base);
  else if (r.unreadable) RS.confirm = null; else st.err = r.err;
  rulesPaintList($("rules-grp")); if (RS.confirm) rulesFocus("confirm");
}

// 設定開著時檔案可能被背景的 agent 改掉(排程報告之類;聊天回合在跑時設定打不開):視窗回到前景時重讀一次
window.addEventListener("focus", () => { if (RS.open) rulesReload(); });
