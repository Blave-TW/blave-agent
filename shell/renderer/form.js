/* 聊天裡的澄清表單(spec agent-clarify-form-2026-10-31 §2):要做台指期回測、缺兩個以上設定時,runtime 把回覆尾端的
   <form id="…" …/> 剝成 {type:"form", id, questions};這裡先收著,回合結束(沒出錯、沒被停)才畫在這一輪最後一則回覆的正文之後。
   改選項什麼都不送;「用這些設定」組一句話填進輸入框、不送;「我自己打」焦點回輸入框。回合真的送出去(started／queued)表單整張收掉。
   題目、選項、預設、年份都由 runtime 的型錄決定,這裡只畫 chunk 帶來的、字串表查得到的。
   只在記憶體(重開 app 不還原:用戶可能已在別台回過);FORM 進 chattabs.js 的 TAB_KEYS,跟著分頁走。
   在 suggest.js 之後、chattabs.js 之前載入(TAB_KEYS 建表時 FORM 要已存在)。 */
let FORM = { pending: null, live: null, filled: null, shown: false, inflight: null };
let formSeq = 0;
// 下面四個跟網頁工作頁同名同值(tests/check_web_desktop_parity.js 逐字比對原文)
const FORM_IDS = ["txf_backtest"];
const FORM_MAX_QUESTIONS = 5;
const FORM_MAX_OPTIONS = 7;
const FORM_MAX_SENTENCE_CHARS = 120;   // zh 預設句 40、en 預設句 96、en 最長組合 97(Array.from 計),兩語共用
const FORM_NOTES = ["nodata", "nodata_signed_out"];

const formKey = (...parts) => ["form"].concat(parts).join(".");
const formHas = (k) => t(k) !== k;
const formRaw = (k) => (STRINGS[LANG] && STRINGS[LANG][k]) || STRINGS.en[k] || "";

/* 純函式(tests/check_shell_form.js 跑兩份測資:自己的與網頁 web/tests/form_vectors.json):chunk → 正規化的表單或 null。
   VM 送來的是不可信輸入:任何一項不合整張丟,不畫半張 */
function formPick(c) {
  if (!c || typeof c !== "object" || FORM_IDS.indexOf(c.id) < 0 || !Array.isArray(c.questions)) return null;
  if (c.questions.length < 1 || c.questions.length > FORM_MAX_QUESTIONS) return null;
  const out = [], seen = new Set();
  for (const q of c.questions) {
    if (!q || typeof q.key !== "string" || !/^[a-z_]{1,16}$/.test(q.key) || seen.has(q.key)) return null;
    seen.add(q.key);
    if (!formHas(formKey(c.id, "q", q.key))) return null;
    const o = q.options;
    if (!Array.isArray(o) || o.length < 1 || o.length > FORM_MAX_OPTIONS) return null;
    if (!o.every((x) => typeof x === "string" && formHas(formKey(c.id, q.key, x))) || o.indexOf(q.value) < 0) return null;
    const n = { key: q.key, options: o.slice(), value: q.value };
    if (q.note !== undefined) { if (FORM_NOTES.indexOf(q.note) < 0) return null; n.note = q.note; }
    if (q.years !== undefined) {
      if (!q.years || typeof q.years !== "object" || Array.isArray(q.years)) return null;
      n.years = {};
      for (const [k, y] of Object.entries(q.years)) { if (!Number.isInteger(y) || y < 1900 || y > 2100) return null; n.years[k] = y; }
    }
    out.push(n);
  }
  // 帶 {year} 的選項(全部可用資料)要每個商品都查得到年份,不然字會露出 {year}(同網頁 formPick)
  const prod = out.find((q) => q.key === "prod");
  for (const q of out) {
    if (!q.options.some((x) => formRaw(formKey(c.id, q.key, x)).indexOf("{year}") >= 0)) continue;
    if (!prod || !q.years || prod.options.some((p) => !q.years[p])) return null;
  }
  return { id: c.id, questions: out };
}
const formOptText = (id, key, opt, year) => t(formKey(id, key, opt), { year });
/* 純函式:state = { id, values: { prod, tf, per, st }, years } → 填進輸入框的那一句。代入字直接用選項字;
   en 把代入字首字母轉小寫(第一個字全大寫的 MA、TXF、1-min 不轉),策略類型前補冠詞(MA 開頭 an,其餘 a) */
function formSentence(s, lang) {
  const tl = (k, v) => { let x = (STRINGS[lang] && STRINGS[lang][k]) || STRINGS.en[k] || k; for (const n in v || {}) x = x.split("{" + n + "}").join(v[n]); return x; };
  const v = s.values, year = s.years ? s.years[v.prod] : "";
  const word = (key) => {
    const w = tl(formKey(s.id, key, v[key]), { year });
    if (lang !== "en") return w;
    const first = w.split(" ")[0];
    return first === first.toUpperCase() ? w : w.charAt(0).toLowerCase() + w.slice(1);
  };
  const st = word("st");
  return tl(formKey(s.id, v.st === "other" ? "sentence_other" : "sentence"), {
    code: String(v.prod).toUpperCase(), tf: word("tf"), per: word("per"),
    st: lang === "en" ? (st.startsWith("MA") ? "an " : "a ") + st : st,
  });
}

function formChunk(c) {
  if (c && c.session_id && c.session_id !== sessionId) return;
  FORM.pending = formPick(c);
}
/* app.js turnEndPost 叫(已在那個分頁的 withTab 裡、最後一次 paintAi 之後):ok 才畫。
   落點是這一輪最後一則還在 DOM 的回覆(旁白泡泡被拿掉後還留在 turnAiBubbles 裡),不是 chat-scroll——背景分頁回合結束時那是別條的 */
function formTurnEnd(ok) {
  const p = FORM.pending;
  FORM.pending = null;
  if (!ok || !p) return;
  const host = turnAiBubbles.filter((b) => b.parentNode).pop();
  if (!host) return;
  if (FORM.live) FORM.live.remove();
  const el = formBuild(p);
  host.appendChild(el);
  Object.assign(FORM, { live: el, shown: true, filled: null });
  trackFeature("clarify_shown");
  srSay(t("form.say"));
}
function formBuild(p) {
  const n = ++formSeq;
  const mk = (tag, cls, key) => { const e = document.createElement(tag); if (cls) e.className = cls; if (key) { e.textContent = t(key); e.dataset.i18n = key; } return e; };
  const el = mk("div", "cform");
  el._form = { id: p.id, inputs: {}, years: null, yearEl: null };
  for (const q of p.questions) {
    const fs = mk("fieldset"), opts = mk("div", "cform-opts");
    fs.appendChild(mk("legend", "", formKey(p.id, "q", q.key)));
    const noteId = q.note ? "cform-" + n + "-" + q.key + "-note" : null;
    el._form.inputs[q.key] = [];
    if (q.years) el._form.years = q.years;
    for (const o of q.options) {
      const row = mk("label", "cform-opt"), r = mk("input"), k = formKey(p.id, q.key, o);
      r.type = "radio"; r.name = "cform-" + n + "-" + q.key; r.value = o; r.checked = o === q.value;
      if (noteId && /^m\d/.test(o)) r.setAttribute("aria-describedby", noteId);   // 只有分 K 要 Blave 資料
      const tx = formRaw(k).indexOf("{year}") >= 0 ? mk("span") : mk("span", "", k);
      if (!tx.dataset.i18n) el._form.yearEl = tx;
      r.addEventListener("change", () => formYearPaint(el));
      row.append(r, tx); opts.appendChild(row);
      el._form.inputs[q.key].push(r);
    }
    fs.appendChild(opts);
    if (noteId) { const nt = mk("p", "cform-note", formKey("note", q.note)); nt.id = noteId; fs.appendChild(nt); }
    el.appendChild(fs);
  }
  const acts = mk("div", "cform-acts"), use = mk("button", "btn-fill", "form.use"), self = mk("button", "btn-quiet cform-self", "form.self");
  use.type = "button"; self.type = "button";
  use.addEventListener("click", () => formFill(el));
  self.addEventListener("click", () => formSelf(el));
  acts.append(use, self); el.appendChild(acts);
  formYearPaint(el);
  return el;
}
function formVals(el) {
  const v = {};
  for (const [k, rs] of Object.entries(el._form.inputs)) { const r = rs.find((x) => x.checked); v[k] = r ? r.value : null; }
  return v;
}
// 「全部可用資料（{year} 起）」:年份跟著選中的商品換。換語言時 formRepaint 也走這裡(這一格不掛 data-i18n)
function formYearPaint(el) {
  const f = el._form;
  if (f.yearEl) f.yearEl.textContent = formOptText(f.id, "per", "all", f.years ? f.years[formVals(el).prod] : "");
}
function formRepaint() { document.querySelectorAll(".cform").forEach((el) => { if (el._form) formYearPaint(el); }); }

function formFill(el) {
  if (FORM.live !== el) return;
  const f = el._form, text = formSentence({ id: f.id, values: formVals(el), years: f.years }, LANG);
  if (!text || Array.from(text).length > FORM_MAX_SENTENCE_CHARS) return;
  const ta = $("ta");
  ta.value = text; autosize();
  ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
  FORM.filled = text;
  trackFeature("clarify_filled");
  if (typeof sugPaint === "function") sugPaint();   // 輸入框有字了:建議托盤收起
}
function formSelf(el) {
  if (FORM.live !== el) return;
  const ta = $("ta");
  if (FORM.filled !== null && ta.value === FORM.filled) { ta.value = ""; autosize(); }
  FORM.filled = null;
  ta.focus();
  trackFeature("clarify_self");
  if (typeof sugPaint === "function") sugPaint();
}

/* 送出的結算(同 suggest 的三段式):sendDraft 清空輸入框之前記快照(不動 DOM),回合真的送出去(app.js r.started／r.queued)才收掉並記。
   沒經過 sendDraft 的入口(重送、卡片)沒有快照:表單照收,不記 */
function formSnap(msg) { FORM.inflight = { msg, filled: FORM.filled, shown: FORM.shown }; }
function formSettle(msg) {
  const inf = FORM.inflight;
  FORM.inflight = null;
  if (FORM.live) FORM.live.remove();
  Object.assign(FORM, { live: null, shown: false, filled: null });
  if (!inf || inf.msg !== msg || !inf.shown) return;
  if (inf.filled) trackFeature(msg === inf.filled.trim() ? "clarify_sent" : "clarify_sent_ed");
  else trackFeature("clarify_missed");
}
// 沒送出去(busy、版本閘、暖機中停止、引擎起不來、讀不到附件):字由 stopRestore 放回輸入框,表單本來就沒拆,填入狀態跟著還原
function formUnsend() {
  const inf = FORM.inflight;
  FORM.inflight = null;
  if (inf && inf.filled) FORM.filled = inf.filled;
}
