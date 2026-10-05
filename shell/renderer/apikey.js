/* 自帶 API 金鑰(0.1.16):連結畫面的第三列、表單,設定 › 模型接入的子頁,回合失敗的分類。主行程那一半在 main.js(llmKey*)與 shell/llmrelay.js。
   規格:blave-canon output/designer/audit-desktop-other-models.md §2 + mockup-desktop-other-models.html 方案一(A1–A4、C2、C3)。
   - 金鑰值只活在輸入框裡:按「測試並…」時讀一次、經 apikeySet 送出,不進這個檔的任何狀態;離開表單就清掉輸入框、丟掉節點(同資料來源,稽核 S3)。
   - 主行程從不把金鑰交回來:畫面只知道存了哪一家(AK.info.saved)與上架清單(名字、申請金鑰的網址)。
   用到 app.js 的 $ / t / cur / connect / enterWorkspace / mdlPaint / setOpen / setCat / setClose / confirmBox / srSay / trackFeature / detect /
   paintBlaveBtn / submitMessage / mpOpen / running / lastUserText——都在呼叫時才取,載入順序不拘。 */
const AK = { info: null, form: null };   // info = { saved: preset id | null, presets: [{ id, name, keysUrl }] };form = 開著的那張表單
const akMk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const akBtn = (cls, text, fn) => { const b = akMk("button", cls, text); b.type = "button"; b.addEventListener("click", fn); return b; };
function akSetInfo(i) { AK.info = i && typeof i === "object" && Array.isArray(i.presets) ? { saved: typeof i.saved === "string" ? i.saved : null, presets: i.presets } : AK.info; }
const akPresets = () => (AK.info && AK.info.presets) || [];
const akSaved = () => (AK.info && AK.info.saved ? akPresets().find((p) => p.id === AK.info.saved) || null : null);
/* 回合裡用的那一家:型錄回來時主行程給的 provider 最準(開 app 直接進工作頁時還沒偵測過、AK.info 是空的) */
const akTurnProvider = () => (typeof MP === "object" && MP.provider) || (akSaved() || {}).name || "";

/* ── 連結畫面的第三列(A1 / A1′)。沒有上架的供應商就不出這一列(不做 fake door,稽核 G6) ── */
function akConnRow() {
  if (!akPresets().length) return null;
  const s = akSaved(), on = s && cur === "apikey";
  const row = akMk("div", "cn-row" + (on ? " is-cur" : "")); row.dataset.kind = "apikey";
  const n = akMk("span", "n", s ? s.name : t("ak.row"));
  n.append(akMk("small", null, s ? t("ak.yours") : akPresets().map((p) => p.name).join(t("ak.sep"))));
  row.append(n);
  if (s) { const st = akMk("span", "cn-st on"); st.append(akMk("span", "dot"), document.createTextNode(t("ak.saved"))); row.append(st); }
  if (on) { row.setAttribute("aria-current", "true"); row.append(akMk("span", "cn-cur", t("cn.current"))); }
  else row.append(akBtn("btn-out", t(s ? "cn.connect" : "ak.setup"), s ? () => connect("apikey", {}) : () => akOpen("cn")));
  return row;
}

/* ── 表單(連結畫面 = 卡片原地換掉;設定 = 模型接入 pane 裡的子頁)。節點建一次、狀態改節點,不整張重畫:重畫會吃掉輸入框裡的字 ── */
function akOpen(where) {
  if (!akPresets().length || (AK.form && AK.form.busy)) return;
  trackFeature("apikey_setup");
  AK.form = { where, busy: false, replacing: false, preset: (akSaved() || akPresets()[0]).id, node: null, el: {} };
  akMount();
}
function akMount(keep) {
  const f = AK.form; if (!f) return;
  const old = f.node; f.node = akFormNode(f);
  if (keep && f.el.input) f.el.input.value = keep;
  if (old) old.replaceWith(f.node);
  else if (f.where === "cn") { const card = document.querySelector("#view-connect .cn-card"); card.querySelectorAll(":scope > .cn-sec").forEach((s) => { s.hidden = true; }); card.append(f.node); }
  else mdlPaint();
  akGate();
  const first = f.el.input || f.el.primary; if (first) first.focus();
}
/* 設定那一頁由 mdlPaint 畫:表單開著時交給這裡(回 true),而且是同一個節點——setHint、detect 觸發的重畫不會清掉剛貼的金鑰 */
function akSetForm(box) {
  const f = AK.form; if (!f || f.where !== "set" || !f.node) return false;
  if (f.node.parentNode !== box) { box.textContent = ""; box.append(f.node); }
  return true;
}
function akFormNode(f) {
  const set = f.where === "set", saved = akSaved(), p = akPresets().find((x) => x.id === f.preset) || akPresets()[0];
  const storedOk = set && saved && saved.id === f.preset && !f.replacing;   // 用已存那把重驗:不用再貼
  const root = akMk("div", set ? "ak-sub" : "kf");
  if (set) root.append(akBtn("btn-quiet src-back", "‹ " + t("set.cat.model"), () => akClose()));
  root.append(akMk("h6", null, t(set ? "ak.titleSet" : "ak.titleCn")));
  // 只有一家:「供應商」是靜態文字,不畫只有一個選項的下拉(設計師稽核);兩家以上才用 select
  const pf = akMk("div", "fld"), multi = akPresets().length > 1;
  let sel = null;
  if (multi) {
    const pl = akMk("label", "fld-l", t("ak.provider")), pw = akMk("span", "f-selw"); sel = akMk("select", "f-input");
    sel.id = "ak-provider"; pl.htmlFor = "ak-provider";
    akPresets().forEach((x) => { const o = akMk("option", null, x.name); o.value = x.id; sel.append(o); });
    sel.value = p.id;
    sel.addEventListener("change", () => { const v = f.el.input ? f.el.input.value : ""; f.preset = sel.value; akMount(v); });
    pw.append(sel); pf.append(pl, pw);
  } else pf.append(akMk("span", "fld-l", t("ak.provider")), akMk("span", "ak-prov", p.name));
  const kfld = akMk("div", "fld"), kl = akMk(storedOk ? "span" : "label", "fld-l", t("ak.key")), val = akMk("span", "src-val");
  let input = null;
  if (storedOk) val.append(akMk("span", "src-saved", t("src.saved")), akBtn("btn-quiet", t("src.replace"), () => { f.replacing = true; akMount(); }));
  else {
    input = akMk("input", "f-input mono"); input.id = "ak-key"; kl.htmlFor = "ak-key";
    input.type = "password"; input.autocomplete = "off"; input.spellcheck = false; input.maxLength = 400; input.placeholder = t("ak.paste");
    input.addEventListener("input", () => { akErr(null); akGate(); });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !f.el.primary.disabled) akSubmit(); });
    const tog = akBtn("btn-quiet src-tog", t("src.show"), () => { const show = input.type === "password"; input.type = show ? "text" : "password"; tog.textContent = t(show ? "src.hide" : "src.show"); });
    val.append(input, tog);
  }
  kfld.append(kl, val);
  const err = akMk("div", "ak-slot"); err.hidden = true; err.setAttribute("role", "status");
  const note = akMk("p", "ak-note", t("ak.payg"));
  const link = akMk("p", "kf-link"); link.append(akBtn("btn-quiet", t("ak.getKey", { p: p.name }), () => window.blave.openExternal(p.keysUrl)));
  // 誠實句在主鈕正上方(Copy rules › 文案密度第 4 條)。Windows 的 DPAPI 同一個系統用戶解得開,不能講「agent 讀不到」
  const rule = akMk("p", "plan-rule", t(window.blave.platform === "darwin" ? "ak.ruleMac" : "ak.ruleWin", { p: p.name }));
  const act = akMk("div", "kf-act");
  const rm = set && saved ? akBtn("btn-quiet", t("ak.remove"), (e) => akRemoveAsk(e.currentTarget)) : null;
  const cancel = akBtn("btn-out", t("del.cancel"), () => akClose());
  const primary = akBtn("btn-fill", t(set ? "ak.testSave" : "ak.testConnect"), akSubmit);
  if (rm) act.append(rm);
  act.append(cancel, primary);
  root.append(pf, kfld, err, note, link, rule, act);
  f.el = { sel, input, err, primary, cancel, rm, link: link.firstChild, primaryText: primary.textContent };
  return root;
}
// 金鑰欄空著時主鈕是真 disabled(mockup A2);等待中只有主鈕(變「取消等待」)能按
function akGate() {
  const f = AK.form; if (!f || !f.el.primary) return;
  const e = f.el;
  [e.sel, e.input, e.cancel, e.rm, e.link].forEach((x) => { if (x) x.disabled = f.busy; });
  if (f.node) f.node.querySelectorAll(".src-tog, .src-back, .src-val .btn-quiet").forEach((x) => { x.disabled = f.busy; });
  e.primary.textContent = "";
  if (f.busy) { e.primary.className = "btn-out"; e.primary.append(akMk("span", "spin16"), document.createTextNode(" " + t("login.cancel"))); e.primary.disabled = false; }
  else { e.primary.className = "btn-fill"; e.primary.textContent = e.primaryText; e.primary.disabled = !!e.input && !e.input.value.trim(); }
}
const AK_ERR = { KEY: "ak.e.key", CREDIT: "ak.e.credit", RATE: "ak.e.rate", NET: "ak.e.net", NO_SEAL: "ak.e.seal" };
/* 驗證結果的代號 → 句子(純;tests/check_shell_apikey_ui.js 切出來跑)。null = 不出句子(成功、取消、同時按兩次) */
function akErrText(r, p) {
  if (r && (r.ok || r.code === "CANCELED" || r.code === "BUSY")) return null;
  const code = r && r.code, s = r && r.status ? String(r.status) : "";
  if (code === "KEY") return s ? t("ak.e.key", { p, s }) : t("ak.e.shape");
  if (AK_ERR[code]) return t(AK_ERR[code], { p });
  return s ? t("ak.e.other", { p, s }) : t("ak.e.unknown", { p });   // 沒有狀態碼(IPC 沒回、主行程拋了)就不寫一個假的括號
}
function akErr(r) {
  const f = AK.form; if (!f) return;
  const slot = f.el.err, text = r ? akErrText(r, (akPresets().find((x) => x.id === f.preset) || {}).name || "") : null;
  slot.textContent = ""; slot.hidden = !text;
  // 只有金鑰本身的問題才把欄框變紅;餘額、限流、網路不是欄位填錯(mockup A2 註)
  if (f.el.input) f.el.input.classList.toggle("is-err", !!text && r.code === "KEY");
  if (!text) return;
  const pe = akMk("p", "plan-err"); pe.append(akMk("span", "fault-mark"), akMk("span", null, text)); slot.append(pe);
  srSay(text);
}
async function akSubmit() {
  const f = AK.form; if (!f) return;
  if (f.busy) { window.blave.apikeyCancel(); return; }
  const input = f.el.input;
  if (input && !input.value.trim()) return;
  f.busy = true; akErr(null); akGate();
  let r = null;
  try { r = input ? await window.blave.apikeySet({ preset: f.preset, key: input.value, connect: f.where === "cn" }) : await window.blave.apikeyTest(); }
  catch (_) { r = null; }
  if (AK.form !== f) return;   // 等待中表單被收掉了(關設定)
  f.busy = false; akGate();
  if (!(r && r.ok)) { akErr(r || { code: "OTHER", status: 0 }); return; }
  if (input) input.value = "";
  AK.info = { ...(AK.info || { presets: akPresets() }), saved: f.preset };
  akClose(true);
  if (f.where === "cn") { cur = "apikey"; enterWorkspace("apikey", {}); return; }
  if (cur === "apikey" && typeof mpInit === "function") mpInit("apikey");   // 換了一把(可能換了一家):型錄跟著重拿
  srSay(t("ak.savedDone"));
}
/* 收掉表單:輸入框先清空再丟節點。quiet = 成功或移除後收(焦點由呼叫端決定) */
function akClose(quiet) {
  const f = AK.form; if (!f) return;
  if (f.busy) window.blave.apikeyCancel();
  if (f.el.input) f.el.input.value = "";
  AK.form = null;
  if (f.node) f.node.remove();
  if (f.where === "cn") document.querySelectorAll("#view-connect .cn-card > .cn-sec").forEach((s) => { s.hidden = false; });
  else mdlPaint();
  if (quiet) return;
  const b = document.querySelector((f.where === "cn" ? "#agent-rows" : "#set-model") + ' [data-kind="apikey"] button'); if (b) b.focus();
}
// 關設定、切到別的分類:沒存的金鑰不留在輸入框裡(同 srcClear)
function akClear() { if (AK.form && AK.form.where === "set") akClose(true); }
// 換介面語言:表單照新語言重建,輸入框裡的字搬過去
function akRelang() { const f = AK.form; if (f && !f.busy) akMount(f.el.input ? f.el.input.value : ""); }

function akRemoveAsk(opener) {
  const s = akSaved(); if (!s) return;
  confirmBox({ title: t("ak.rmTitle", { p: s.name }), lines: [t(cur === "apikey" ? "ak.rmBodyCur" : "ak.rmBody")], ok: t("ak.remove"), opener, onOk: akRemove });
}
async function akRemove() {
  try { await window.blave.apikeyRemove(); } catch (_) { /* 主行程那邊刪不掉也照樣收表單;下一次偵測會講實話 */ }
  if (AK.info) AK.info.saved = null;
  akClose(true);
  // 正在用這把:主行程已經把連結一起清掉,回連結畫面重選(同登出 Blave)
  if (cur === "apikey") { cur = null; setClose(); $("view-ws").hidden = true; $("view-connect").hidden = false; paintBlaveBtn(); detect(); return; }
  const b = document.querySelector('#set-model [data-kind="apikey"] button'); if (b) b.focus();
}

/* ── 回合失敗(mockup C3)。text = 引擎吐的那段;capped = 這一輪轉送口回報過每輪上限(llm_cap,先於 CLI 的 429 到)。
   回 null = 不是這條路認得的錯,照通用流程。不內嵌「改用 Blave AI」:「切換 AI」開 設定 › 模型接入 ── */
const AK_FAULT_RE = /^(?:Failed to authenticate\. )?API Error: (\d{3})\b/;
const AK_NET_RE = /^API Error: (?:Connection error|Request timed out)/i;
function akFault(text, capped) {
  const m = AK_FAULT_RE.exec(text || ""), net = AK_NET_RE.test(text || "");
  if (!m && !net) return null;
  const p = akTurnProvider(), s = m ? m[1] : "";
  const resend = () => { if (!running && lastUserText) submitMessage(lastUserText); };
  const toModels = () => setOpen().then(() => setCat("model"));
  if (s === "429" && capped) return { cap: true, text: t("ak.f.cap"), label: t("fault.resend"), act: resend };
  if (s === "401" || s === "403") return { text: t("ak.f.key", { p, s }), label: t("ak.f.keyBtn"), act: () => toModels().then(() => akOpen("set")) };
  if (s === "402") return { text: t("ak.f.credit", { p }), label: t("fault.resend"), act: resend, second: { label: t("fault.limitBtn"), on: toModels } };
  if (s === "429") return { text: t("ak.f.rate", { p }), label: t("fault.resend"), act: resend };
  if (s === "400") return { text: t("ak.f.compat", { p }), label: t("fault.noModelBtn"), act: () => mpOpen() };
  if (net || s === "502" || s === "503" || s === "504") return { text: t("ak.f.net", { p }), label: t("fault.resend"), act: resend };
  return null;
}
