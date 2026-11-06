/* 側欄策略改名(spec .claude/output/designer/spec-strategy-rename-2026-11-05;參照面 = 電腦版,網頁工作頁照這份)。
   在 stratgroups.js 之後載入(用 SF_* / SG / sgEditEnd / sfFlushWaiters / busyOn / confirmBox / stratRefresh / TR_BAGS)。
   旗標面板的〔改名〕→ 那一列原地換成名稱框,做法同資料夾改名:Enter／失焦存、Esc 取消、空字串等於取消、不合規則時框紅、Enter 不送。
   兩個視角都走機器的 rename_strategy(runtime → lib.strategy.rename):規則、改寫 DISPLAY_NAME、版本 hash 都只有那一份實作,
   本機視角不在主行程寫檔(spec §5 原寫主行程寫;改走 daemon 是為了跟回測共用版本鎖、用 ast 判「一行字串」,同一支策略兩個視角結果一樣)。
   開著時 SRN.edit 跟 SG.editing 一樣擋住三條重建路(stratflags.js sgEditing)。 */
const SRN = { edit: null, over: new Map() };
// 三個規則常數:web 工作頁同一份(tests/check_web_desktop_parity.js 比),機器端 lib.strategy.name_problem 再判一次
const SRN_NAME_MAX = 60;                       // 字數按 code point(同 runtime _display_name 的 v[:60])
const SRN_NAME_BAD = /[、;:；：「」"\\]/;
const srnWrapped = (v) => { const s = v.trim(); return s.length > 1 && s.startsWith("[") && s.endsWith("]"); };
// 機器回的錯誤碼 → 框下那一句(null = 照本地規則重判那一句;NOT_FOUND 收掉編輯列另開框)。沒列的碼與沒回應一律 strat.renameFail
const SRN_ERR_KEYS = { BAD_NAME: null, DUPLICATE: "strat.nameDup", TURN_RUNNING: "strat.renameFail", JOB_RUNNING: "strat.renameJob",
  NOT_LITERAL: "strat.renameNoLiteral", NOT_FOUND: "strat.renameGone" };
const SRN_RING_MS = 400;     // 存檔超過這麼久才出轉圈(本機幾乎瞬間完成,不閃一下)
const SRN_OVER_MS = 120000;  // 雲端:新名字等 api 的清單跟上;最多撐這麼久,之後以清單為準
const srnCp = (v) => Array.from(v).length;
const srnFold = (v) => String(v || "").trim().normalize("NFKC").toLowerCase();

// 雲端清單在 api 跟上之前先顯示剛改好的名字(trade.js envCloudList 叫)
function srnShown(name, display) {
  const o = SRN.over.get(name);
  if (!o) return display;
  if (display === o.v || Date.now() - o.at > SRN_OVER_MS) { SRN.over.delete(name); return display; }
  return o.v;
}
// 〔改名〕出不出:機器的 lib 會改名(本機 = workspace 的 lib;雲端 = runtime 報告的 renamable)
const srnAvailable = (x) => !!x && x.renamable === true;
/* 停用時那一句的 key;null = 可以改。任何回合進行中都擋(同 ✕ 的 busyLock):機器的 rename_strategy 自己也是任何回合都回 TURN_RUNNING
   (runtime command_listener._chat_turn_running),分不出那一輪碰了哪一支,這邊只鎖一支等於讓別支按了才失敗。
   或這支正在背景重跑(還原後的重跑、更新績效;本機清單每支帶 jobRunning,雲端只看得到開著的那支)。
   跟 ✕ 不同,這裡講原因(Wei 11-06:ZEC 回測時別支的〔改名〕也灰、滑過去沒說為什麼) */
function srnLockKey(sc, x) {
  if (typeof busyOn === "function" && busyOn()) return "strat.renameLockTurn";
  if (x.jobRunning === true) return "strat.renameLockJob";
  const B = sc.env === "cloud" ? (typeof RPC !== "undefined" ? RPC : null) : RP, d = B && B.name === x.name ? B.data : null;
  const run = (o) => !!o && o.status === "running";
  return d && (run(d.versions && d.versions.rerun) || run(d.perf && d.perf.refresh)) ? "strat.renameLockJob" : null;
}
const srnLocked = (sc, x) => !!srnLockKey(sc, x);
function srnOthers(sc, name) {
  const list = sc.env === "cloud" ? (typeof envCloudList === "function" ? envCloudList(TR_BAGS.cloud.st) : []) : RP.list;
  return (list || []).filter((s) => s && s.name !== name).map((s) => srnFold(s.displayName || s.name));
}
// 本地規則:{ key, c?, hint? };null = 沒問題。打到 60 字是提示(灰字),不算錯
function srnProblem(sc, name, v) {
  const m = SRN_NAME_BAD.exec(v);
  if (m) return { key: "strat.nameBad", c: m[0] };
  if (srnWrapped(v)) return { key: "strat.nameWrapped" };
  const f = srnFold(v);
  if (f && srnOthers(sc, name).indexOf(f) >= 0) return { key: "strat.nameDup" };
  if (srnCp(v) >= SRN_NAME_MAX) return { key: "strat.nameMax", hint: true };
  return null;
}
// p.hint = 灰字提示;p.machine = 機器那邊的拒絕,只寫一行字、框不變紅(紅框只給名稱規則)
function srnPaintErr(ed, p) {
  const err = ed.err, bad = !!p && !p.hint && !p.machine;
  err.textContent = "";
  if (p && p.c) {   // {c} 換成 mono 的那個字
    const parts = t(p.key, { c: "\u0000" }).split("\u0000"), ch = document.createElement("span");
    ch.className = "srn-ch"; ch.textContent = p.c;
    err.append(parts[0] || "", ch, parts[1] || "");
  } else if (p) err.textContent = t(p.key);
  err.hidden = !p;
  err.classList.toggle("is-hint", !!p && !!p.hint);
  ed.input.classList.toggle("is-bad", bad);
  ed.input.setAttribute("aria-invalid", bad ? "true" : "false");
  return bad;
}
function srnCheck(ed) {
  if (srnCp(ed.input.value) > SRN_NAME_MAX) ed.input.value = Array.from(ed.input.value).slice(0, SRN_NAME_MAX).join("");
  ed.failed = null;
  return srnPaintErr(ed, srnProblem(ed.sc, ed.x.name, ed.input.value));
}

function srnOpen(sc, wrap, x) {
  if (!wrap || !wrap.isConnected || !srnAvailable(x) || srnLocked(sc, x)) return;
  if (typeof SG !== "undefined" && SG.editing && typeof sgEditEnd === "function") sgEditEnd(true);   // 資料夾編輯列照它的失焦規則收
  if (SRN.edit) srnEnd(false);
  if (!wrap.isConnected) return;   // 收資料夾編輯列時清單重排過:這一列已經不在
  const node = document.createElement("div"); node.className = "srn-edit";
  const input = document.createElement("input"); input.type = "text"; input.className = "srn-input"; input.spellcheck = false;
  input.setAttribute("aria-label", t("strat.nameAria"));
  const err = document.createElement("p"); err.className = "srn-err"; err.id = "srn-err"; err.setAttribute("role", "status"); err.hidden = true;
  input.setAttribute("aria-describedby", err.id);
  const orig = x.displayName || x.name;
  input.value = orig;
  node.append(input);
  wrap.before(node); node.after(err); wrap.hidden = true;
  const ed = SRN.edit = { sc, wrap, x, node, input, err, orig, saving: false, failed: null, ring: 0 };
  input.addEventListener("input", () => srnCheck(ed));
  input.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;   // 輸入法組字中:Enter 選字、Esc 取消選字
    if (e.key === "Enter") { e.preventDefault(); if (!ed.saving && !srnCheck(ed)) srnSave(ed); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (!ed.saving) srnEnd(false); }
  });
  input.addEventListener("blur", () => {
    if (SRN.edit !== ed || ed.saving) return;
    if (ed.failed) { srnEnd(false); return; }        // 存失敗後離開:字就不要了,錯誤那行打字時一直看得到
    if (srnCheck(ed)) srnEnd(false); else srnSave(ed);
  });
  input.focus(); input.select();
}
// 收掉編輯列、列回來;焦點本來在框裡才還給那一列
function srnEnd(saved) {
  const ed = SRN.edit;
  if (!ed) return;
  SRN.edit = null; clearTimeout(ed.ring);
  const had = ed.node.contains(document.activeElement) || document.activeElement === document.body;
  ed.node.remove(); ed.err.remove(); ed.wrap.hidden = false;
  if (had && !saved) { const b = ed.wrap.querySelector(".strat-row"); if (b && ed.wrap.isConnected) b.focus(); }
  if (typeof sfFlushWaiters === "function") sfFlushWaiters();
}
// 回合結束(app.js onTurnEnd,跟 sgEditCommit 並排):照失焦規則收
function srnCommit() { const ed = SRN.edit; if (ed && !ed.saving) { if (ed.failed || srnCheck(ed)) srnEnd(false); else srnSave(ed); } }

// unknown = 指令可能已經執行(本機 UNKNOWN_RESULT、雲端 kind unknown、主行程沒回);TIMEOUT／DAEMON_DOWN 是確定沒執行(trade.js 檔頭)
function srnAck(r) {
  if (r && r.ok) return { ok: true, result: r.result && typeof r.result === "object" ? r.result : {} };
  const e = r && typeof r.error === "string" ? r.error : "";
  if (!r || r.kind === "unknown" || e === "UNKNOWN_RESULT") return { ok: false, unknown: true, code: null };
  const m = /^\s*\w+:\s*([A-Z_]+):/.exec(e);
  return { ok: false, code: m ? m[1] : null };
}
// 重讀一次:這支現在顯示的名字是不是已經是 v
async function srnLanded(sc, name, v) {
  try {
    const list = sc.env === "cloud" ? envCloudList(await TR_BAGS.cloud.api.tradeStatus()) : await window.blave.listStrategies();
    const x = (list || []).find((s) => s && s.name === name);
    return !!x && String(x.displayName || "").trim() === v;
  } catch (_) { return false; }
}
async function srnSave(ed) {
  const v = ed.input.value.trim();
  if (!v || v === ed.orig.trim()) { srnEnd(false); return; }   // 空的、沒改:當取消
  ed.saving = true; ed.input.readOnly = true; ed.node.classList.add("is-saving");
  ed.ring = setTimeout(() => { if (ed.saving) { const sp = document.createElement("span"); sp.className = "spin16 srn-ring"; sp.setAttribute("aria-hidden", "true"); ed.node.append(sp); } }, SRN_RING_MS);
  let r = null;
  try { r = await TR_BAGS[ed.sc.env === "cloud" ? "cloud" : "local"].api.tradeSend("rename_strategy", { name: ed.x.name, display_name: v }); } catch (_) { r = null; }
  const a = srnAck(r);
  // 結果不明(已送出、沒等到回覆):可能已經改好了,先重讀一次名字(還在存檔中,轉圈照轉)再照實講
  const landed = a.unknown && await srnLanded(ed.sc, ed.x.name, v);
  clearTimeout(ed.ring); const sp = ed.node.querySelector(".srn-ring"); if (sp) sp.remove();
  ed.saving = false; ed.input.readOnly = false; ed.node.classList.remove("is-saving");
  if (SRN.edit !== ed) return;
  if (a.ok || landed) { await srnDone(ed, a.ok && typeof a.result.display_name === "string" ? a.result.display_name : v); return; }
  if (a.code === "NOT_FOUND") { await srnGone(ed); return; }
  let p = a.code === "BAD_NAME" ? srnProblem(ed.sc, ed.x.name, v) : null;   // 機器另外不收看不見的字元:本地規則判不出來就講沒改成
  if (!p || p.hint) p = { key: SRN_ERR_KEYS[a.code] || "strat.renameFail", machine: true };
  ed.failed = p.key;
  srnPaintErr(ed, p);
  ed.input.focus();
}
async function srnDone(ed, v) {
  const sc = ed.sc, name = ed.x.name;
  // 走到這裡新名字一定跟打開時不同(沒改就當取消):機器回 changed:false 只會是上一次其實已經改成,一樣算一次改名。不帶名字
  trackFeature("strat_rename");
  // 焦點還在編輯列(按 Enter 存)或掉到 body 才交還那一列;用戶已經點到別處(對話框、另一支)就不搶(設計 recheck 2026-11-05 §3)
  const ae = document.activeElement, back = ed.node.contains(ae) || ae === document.body || !ae;
  srnEnd(true);
  if (sc.env === "cloud") {
    SRN.over.set(name, { v, at: Date.now() });
    if (typeof RPC !== "undefined" && RPC.name === name && RPC.data) { RPC.data.displayName = v; if (rpBag() === RPC && !$("rp").hidden) rpPaintHead(RPC); }
    if (typeof ENV !== "undefined" && ENV.sig) ENV.sig.side = null;
    if (typeof trPaint === "function") trPaint();
  } else {
    await stratRefresh(false);
    if (RP.name === name) await stratReload(name);
  }
  const w = [...sc.box().querySelectorAll(":scope > .strat-wrap")].find((n) => n.dataset.name === name), b = w && w.querySelector(".strat-row");
  if (b && back) b.focus();
  srSay(t("strat.renamed", { name: v }));
}
// 資料夾不見了:收掉編輯列、重讀清單,開框講;焦點照 stratRefreshAt 的規則
async function srnGone(ed) {
  const sc = ed.sc, name = ed.x.name;
  srnEnd(true);
  let opener = null;
  if (sc.env === "cloud") { if (typeof ENV !== "undefined" && ENV.sig) ENV.sig.side = null; if (typeof trPaint === "function") trPaint(); }
  else opener = await stratRefreshAt(name);
  confirmBox({ title: Array.from(ed.orig).slice(0, 40).join(""), lines: [t("strat.renameGone")], ok: t("cdel.gotIt"), opener, single: true, onOk: () => {},
    env: sc.env === "cloud" ? "cloud" : undefined });
}
