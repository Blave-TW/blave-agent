/* 設定 › 資料來源(自帶資料來源,BYO Data)。主行程那一半在 shell/datasrc.js。
   設計:blave-canon output/designer/mockup-desktop-telemetry-and-datasrc-2026-09.html 的 B;字串 src.*。
   - 清單只有名稱與欄位名:主行程從不把金鑰的值交回來,這裡也沒有地方顯示它。
   - 值只活在輸入框裡:按儲存時讀一次、經 IPC 送出,不管成不成功都不留在這個檔的任何變數裡。
   - 名稱來自 .env(agent 寫得到的檔)與策略檔:一律 textContent。
   - 雲端視角:只列雲端主機回報的名稱,不能加也不能刪(這一版沒有把金鑰送上雲端的路)。
   用到 app.js 的 $ / t / confirmBox / setFocusGuard / srSay 與 trade.js 的 ENV——都在呼叫時才取,載入順序不拘。 */
const SRC = { view: "list", items: [], cloud: null, edit: null, rows: [], err: null, busy: false, loaded: false };
const SRC_NAME_MAX = 24, SRC_FIELD_MAX = 32, SRC_MAX_FIELDS = 8, SRC_CHIPS = ["KEY", "SECRET", "TOKEN"];
const SRC_ERR = { NAME_EMPTY: "src.errName", NAME_FORMAT: "src.errName", NAME_RESERVED: "src.errReserved", NAME_DUP: "src.errDup",
  FIELD_FORMAT: "src.errField", FIELD_RESERVED: "src.errFieldReserved", FIELD_DUP: "src.errFieldDup", BAD_VALUE: "src.errValue", BUSY: "src.errBusy" };
const srcMk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const srcBtn = (cls, text, fn) => { const b = srcMk("button", cls, text); b.type = "button"; b.addEventListener("click", fn); return b; };
const srcIsCloud = () => typeof ENV === "object" && ENV && ENV.cur === "cloud";
const srcUpper = (v, re, max) => String(v || "").toUpperCase().replace(re, "").slice(0, max);

async function srcLoad() {
  SRC.view = "list"; SRC.err = null;
  if (srcIsCloud()) {
    try { const st = await window.blave.cloudStatus(); const c = st && st.cloud; SRC.cloud = c && c.code === "OK" && Array.isArray(c.data_sources) ? c.data_sources : []; }
    catch (_) { SRC.cloud = []; }
  } else {
    SRC.cloud = null;
    try { const r = await window.blave.dataSrcList(); SRC.items = r && r.ok && Array.isArray(r.sources) ? r.sources : []; } catch (_) { SRC.items = []; }
  }
  SRC.loaded = true; srcPaint();
}
function srcPaint() {
  const box = $("set-src"); if (!box) return;
  box.textContent = "";
  if (SRC.view === "form") srcPaintForm(box); else srcPaintList(box);
  setFocusGuard();
}
function srcPaintList(box) {
  const cloud = SRC.cloud != null;
  const names = cloud ? SRC.cloud.filter((n) => /^[A-Z0-9]{1,24}$/.test(n)) : SRC.items;
  const head = srcMk("div", "src-head");
  head.append(srcMk("p", "priv-lead", t(cloud ? "src.cloudLead" : "src.lead")));
  if (!cloud && names.length) head.append(srcBtn("btn-out", t("src.add"), () => srcOpenForm(null)));
  box.append(head);
  if (!SRC.loaded) return;
  if (!names.length) {
    const e = srcMk("div", "src-empty");
    if (cloud) e.append(srcMk("p", "", t("src.cloudEmpty")));
    else { e.append(srcMk("p", "", t("src.empty1")), srcMk("p", "", t("src.empty2", { ex: "fred" })), srcBtn("btn-out", t("src.add"), () => srcOpenForm(null))); }
    box.append(e); return;
  }
  const rows = srcMk("div", "src-rows");
  names.forEach((it) => {
    const row = srcMk("div", "src-row"), n = srcMk("div", "n");
    n.append(srcMk("b", "mono", cloud ? it : it.name));
    if (!cloud) {
      const cnt = it.fields.length, used = it.usedBy && it.usedBy.length ? it.usedBy.join("、") : null;
      const key = (used ? "src.rowLocal" : "src.rowLocalNone") + (cnt === 1 ? ".one" : ".other");
      const small = srcMk("small", "", t(key, { n: cnt, names: used || "" })); small.title = small.textContent;
      n.append(small);
    }
    row.append(n);
    if (!cloud) {
      const acts = srcMk("div", "acts");
      acts.append(srcBtn("btn-quiet", t("src.edit"), () => srcOpenForm(it)), srcBtn("btn-quiet", t("src.del"), (e) => srcDelete(it, e.currentTarget)));
      row.append(acts);
    }
    rows.append(row);
  });
  box.append(rows);
}

function srcOpenForm(it) {
  SRC.view = "form"; SRC.edit = it ? it.name : null; SRC.err = null; SRC.busy = false;
  SRC.rows = it ? it.fields.map((f) => ({ name: f, stored: true })) : [{ name: "KEY", stored: false }];
  srcPaint();
  const first = $("set-src").querySelector(it ? ".src-val .btn-quiet" : "#src-name"); if (first) first.focus();
}
function srcBack() { SRC.view = "list"; SRC.edit = null; SRC.rows = []; SRC.err = null; srcPaint(); const b = $("set-src").querySelector(".btn-out, .btn-quiet"); if (b) b.focus(); }
function srcVars(name, rows) { return rows.filter((r) => r.name).map((r) => `DATA_${name || "…"}_${r.name}`).join("、"); }
function srcPaintForm(box) {
  const editing = SRC.edit != null;
  box.append(srcBtn("btn-quiet src-back", "‹ " + t("src.back"), srcBack));
  const form = srcMk("div", "src-form");
  const nameL = srcMk("label", "src-l", t(editing ? "src.nameLocked" : "src.name")); nameL.htmlFor = "src-name";
  const name = srcMk("input", "f-input mono"); name.id = "src-name"; name.type = "text"; name.maxLength = SRC_NAME_MAX;
  name.autocomplete = "off"; name.spellcheck = false; name.value = SRC.edit || ""; name.readOnly = editing;
  const howto = srcMk("p", "cx-manual-note");
  const paintHowto = () => { howto.textContent = t("src.howto", { vars: srcVars(name.value, SRC.rows), name: (name.value || "…").toLowerCase() }); };
  name.addEventListener("input", () => { const v = srcUpper(name.value, /[^A-Z0-9]/g, SRC_NAME_MAX); if (v !== name.value) name.value = v; srcSetErr(null); paintHowto(); srcGate(); });
  name.addEventListener("blur", () => { if (!editing) srcSetErr(srcNameErr(name.value)); });
  form.append(nameL, name);
  const errName = srcMk("p", "plan-err"); errName.id = "src-err-name"; errName.hidden = true; errName.setAttribute("role", "status"); form.append(errName);

  form.append(srcMk("span", "src-l", t("src.fields")));
  const list = srcMk("div", "src-fields"); form.append(list);
  SRC.rows.forEach((r, i) => list.append(srcFieldRow(r, i, paintHowto)));
  const chips = srcMk("div", "src-chips"); chips.append(srcMk("span", "", t("src.common")));
  SRC_CHIPS.forEach((c) => chips.append(srcBtn("src-chip mono", c, () => {
    const inputs = list.querySelectorAll(".src-fname:not([readonly])"); const target = [...inputs].find((x) => !x.value) || inputs[inputs.length - 1];
    if (target) { target.value = c; target.dispatchEvent(new Event("input")); target.focus(); }
  })));
  const add = srcBtn("btn-quiet", t("src.addField"), () => { if (SRC.rows.length >= SRC_MAX_FIELDS) return; srcSyncRows(); SRC.rows.push({ name: "", stored: false }); srcRepaintKeepValues(); });
  add.hidden = SRC.rows.length >= SRC_MAX_FIELDS; chips.append(add); form.append(chips);

  paintHowto(); form.append(howto);
  const err = srcMk("p", "plan-err"); err.id = "src-err"; err.hidden = true; err.setAttribute("role", "status"); form.append(err);
  const foot = srcMk("div", "src-foot");
  const save = srcBtn("btn-fill", t("src.save"), srcSave); save.id = "src-save";
  foot.append(srcBtn("btn-out", t("del.cancel"), srcBack), save); form.append(foot);
  box.append(form);
  srcGate();
}
function srcFieldRow(r, i, paintHowto) {
  const row = srcMk("div", "src-f2");
  const fname = srcMk("input", "f-input mono src-fname"); fname.type = "text"; fname.maxLength = SRC_FIELD_MAX; fname.autocomplete = "off"; fname.spellcheck = false;
  fname.value = r.name; fname.readOnly = !!r.stored; fname.setAttribute("aria-label", t("src.fieldName"));
  fname.addEventListener("input", () => { const v = srcUpper(fname.value, /[^A-Z0-9_]/g, SRC_FIELD_MAX); if (v !== fname.value) fname.value = v; r.name = v; srcSetErr(null); paintHowto(); srcGate(); });
  const wrap = srcMk("div", "src-val");
  if (r.stored && !r.replacing) {
    wrap.append(srcMk("span", "src-saved", t("src.saved")), srcBtn("btn-quiet", t("src.replace"), () => { srcSyncRows(); r.replacing = true; srcRepaintKeepValues(); const el = $("set-src").querySelectorAll(".src-f2")[i]; const inp = el && el.querySelector(".src-value"); if (inp) inp.focus(); }));
  } else {
    const val = srcMk("input", "f-input mono src-value"); val.type = "password"; val.autocomplete = "off"; val.spellcheck = false; val.placeholder = t("src.value"); val.maxLength = 600;
    val.addEventListener("input", () => { srcSetErr(null); srcGate(); });
    const tog = srcBtn("btn-quiet src-tog", t("src.show"), () => { const show = val.type === "password"; val.type = show ? "text" : "password"; tog.textContent = t(show ? "src.hide" : "src.show"); });
    wrap.append(val, tog);
  }
  const rm = srcBtn("btn-quiet src-rm", "✕", () => { if (SRC.rows.length <= 1) return; srcSyncRows(); SRC.rows.splice(i, 1); srcRepaintKeepValues(); });
  rm.setAttribute("aria-label", t("src.rmField")); rm.disabled = SRC.rows.length <= 1;
  row.append(fname, wrap, rm);
  return row;
}
// 加一列 / 拿掉一列 / 按取代會重畫整張表:輸入框裡還沒送出的值要原地搬過去(只在這個函式的區域變數裡待一下,不進 SRC)
function srcSyncRows() { $("set-src").querySelectorAll(".src-f2").forEach((el, i) => { if (SRC.rows[i]) SRC.rows[i].el = el; }); }
function srcRepaintKeepValues() {
  const keep = new Map(); SRC.rows.forEach((r) => { const v = r.el && r.el.querySelector(".src-value"); if (v && v.value) keep.set(r, v.value); delete r.el; });
  const name = $("src-name") ? $("src-name").value : "";
  srcPaint();
  if ($("src-name") && !SRC.edit) $("src-name").value = name;
  $("set-src").querySelectorAll(".src-f2").forEach((el, i) => { const v = el.querySelector(".src-value"); if (v && keep.has(SRC.rows[i])) v.value = keep.get(SRC.rows[i]); });
  keep.clear(); srcGate();
}
function srcNameErr(v) {
  if (!v) return { key: "src.errName" };
  if (v.startsWith("DATA")) return { key: "src.errReserved" };
  if (SRC.items.some((x) => x.name === v)) return { key: "src.errDup", vars: { name: v } };
  return null;
}
function srcSetErr(e, general) {
  const a = $("src-err-name"), b = $("src-err"); if (!a || !b) return;
  [a, b].forEach((n) => { n.hidden = true; n.textContent = ""; });
  const name = $("src-name"); if (name) name.classList.remove("is-err");
  if (!e) return;
  const n = general ? b : a; n.hidden = false; n.append(srcMk("span", "fault-mark"), srcMk("span", null, t(e.key, e.vars)));
  if (!general && name) name.classList.add("is-err");
  srSay(t(e.key, e.vars));
}
// 名稱與每一列的欄名、值都合法才給按(已存、沒按取代的欄位不需要值)
function srcGate() {
  const save = $("src-save"); if (!save) return;
  const name = $("src-name").value, rows = [...$("set-src").querySelectorAll(".src-f2")];
  const names = rows.map((el) => el.querySelector(".src-fname").value);
  const ok = !SRC.busy && (SRC.edit != null || !srcNameErr(name)) && rows.length > 0 && new Set(names).size === names.length
    && rows.every((el) => /^[A-Z][A-Z0-9_]{0,31}$/.test(el.querySelector(".src-fname").value) && (!el.querySelector(".src-value") || el.querySelector(".src-value").value.trim()));
  save.setAttribute("aria-disabled", ok ? "false" : "true"); save.classList.toggle("is-busy", !ok);
}
async function srcSave() {
  const save = $("src-save"); if (!save || save.getAttribute("aria-disabled") === "true") return;
  const name = $("src-name").value, inputs = [...$("set-src").querySelectorAll(".src-f2")];
  SRC.busy = true; save.textContent = t("src.saving"); srcGate();
  let res = null;
  try {
    res = await window.blave.dataSrcSave({ name, isNew: SRC.edit == null,
      fields: inputs.map((el) => { const v = el.querySelector(".src-value"); return { name: el.querySelector(".src-fname").value, value: v ? v.value : null }; }) });
  } catch (_) { res = null; }
  SRC.busy = false;
  if (res && res.ok) { inputs.forEach((el) => { const v = el.querySelector(".src-value"); if (v) v.value = ""; }); await srcLoad(); srSay(t("src.saved")); return; }
  if ($("src-save")) $("src-save").textContent = t("src.save");
  const code = res && res.error, key = SRC_ERR[code] || "src.errSave";
  srcSetErr({ key, vars: { name, field: (res && res.field) || "" } }, !/^NAME_/.test(code || ""));
  srcGate();
}

async function srcDelete(it, opener) {
  let by = []; try { by = await window.blave.dataSrcBlockers(it.name); } catch (_) { by = []; }
  if (Array.isArray(by) && by.length) return srcBlocked(it, by, opener);
  const lines = [t("src.delBody1", { source: it.name })];
  if (it.usedBy && it.usedBy.length) lines.push(t("src.delBody2", { names: it.usedBy.join("、") }));
  confirmBox({ title: t("src.delTitle", { source: it.name }), lines, ok: t("src.del"), opener, onOk: async () => {
    let r = null; try { r = await window.blave.dataSrcRemove(it.name); } catch (_) { r = null; }
    if (r && !r.ok && r.error === "IN_USE") { srcBlocked(it, r.names || [], opener); return; }   // 按下去之前的那一刻開始下單了
    await srcLoad();
    if (!r || !r.ok) { const b = $("set-src"); const e = srcMk("p", "plan-err"); e.setAttribute("role", "status"); e.append(srcMk("span", "fault-mark"), srcMk("span", null, t(r && r.error === "BUSY" ? "src.errBusy" : "src.errSave"))); b.append(e); }
  } });
}
// 正在下單的策略用到它:同一個框,只有一顆「知道了」。第一句粗體由程式包(字串裡不放標籤)
function srcBlocked(it, names, opener) {
  const text = t("src.delBlocked", { name: names.join("、"), source: it.name }), cut = text.search(/[。.]/) + 1;
  const v = srcMk("div", "verdict"), body = srcMk("div");
  body.append(srcMk("b", "", cut > 0 ? text.slice(0, cut) : ""), document.createTextNode(cut > 0 ? text.slice(cut) : text));
  v.append(srcMk("span", "fault-mark"), body);
  confirmBox({ title: t("src.delTitle", { source: it.name }), lines: [], extra: v, ok: t("src.gotIt"), opener, onOk: () => {} });
  $("del-cancel").hidden = true; $("del-ok").focus();
  srcRestoreBox(() => { $("del-cancel").hidden = false; });
}
// 確認框是共用的:我們動過的地方在它關掉時還原(Esc / ✕ / 點框外都不經過 onOk,所以看 hidden 屬性)
function srcRestoreBox(undo) {
  const sc = $("del-scrim"), mo = new MutationObserver(() => { if (sc.hidden) { mo.disconnect(); undo(); } });
  mo.observe(sc, { attributes: true, attributeFilter: ["hidden"] });
}
