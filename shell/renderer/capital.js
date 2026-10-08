/* 群益開通 — 雲端視角(設計 spec-capital-connect-v2 §2;契約 blave-canon output/backend/capital-cloud-progress-2026-09-26.md)。
   連接交易所框(#cx-scrim,trade.js)在雲端視角選到群益時,整個框交給這個檔畫:表單 → 開通清單 → 完成。
   - 狀態只有一個來源:主機回報的 `capital_connect`(TR_BAGS.cloud.st.report.capital_connect),網頁與電腦版讀同一份。
     長步驟在主機上跑幾十秒到幾分鐘,回條常常等不到(cloud_capital.js 的 SENT)——畫面一律看狀態走,不看回條。
   - 身分證字號、交易密碼、匯出密碼只在這個框的欄位裡,送出後就清掉;pfx 不經過這裡(主行程開對話框、讀、封裝)。
   - **過渡期(暫時,主機 runtime 全面有 capital_* 指令那一版拿掉)**:主機回 unknown command → 帳密照舊存好,剩下交給 agent
     (本機 agent 經 blave MCP 帶用戶走 RDP 流程;本機 app 不觸發雲端 agent 回合)。
   - 申請新憑證(主機代跑精靈 + 簡訊驗證碼)這版不做:選做法只有「匯入已有的憑證檔」與遠端桌面(交給 agent)。
   用到 trade.js 的 CAPITAL / $ / t / trEl / CXF / TR_BAGS / envCloudKind / trSendError / cxModalClose / cxVenueField / trBurstBump、
   app.js 的 submitMessage / running / paneSt / paneToggle / trackFeature / srSay——都在呼叫時才取。 */
const CAP_SIGN_URL = "https://tradeweb.capital.com.tw/TSWEB/agreeList.aspx";   // references/capital-broker.md Step 3
// 憑證精靈沒有固定下載網址(每次由憑證專區動態產生,references/capital-broker.md Step 2):只能帶到群益期貨官網
const CAP_CERT_URL = "https://www.capitalfutures.com.tw/";
const CAP_VERIFY_URL = "https://www.capital.com.tw/Service2/download/api_zip/CapitalAPI_v5.0_SKCOMVerifyDJ.zip";   // references/capital-broker.md Step 1
const CAP_NO_MOVE_MS = 90000;          // 送出之後主機回報一直沒動:回報鏈最壞約 20 秒(主機一有進度就推),給足
const CAP_STUCK_MS = 25 * 60 * 1000;   // 「跑中」的段落超過這麼久沒更新 = 主機重開時被打斷(下一個指令才會清)
const CAP_STEP_OF_BUSY = { capital_setup: "setup", capital_pfx: "pfx", capital_probe: "probe", capital_finish: "finish" };
const CAP_PFX_FILE_ERR = { PFX_INVALID: "cap.pfx.errFile", PFX_TOO_LARGE: "cap.pfx.errFile", PFX_NOT_CAPITAL: "cap.pfx.errIssuer", PFX_EXPIRED: "cap.pfx.errExpired", PFX_OLDER: "cap.pfx.errOlder", READ_FAILED: "cap.pfx.errRead" };
const CAP_PROBE_ERR = { cert_old: "cap.err.certOld", cert_unusable: "cap.err.certUnusable", cert_expired: "cap.err.certExpired",
  timeout: "cap.err.timeout", vehicle_failed: "cap.err.vehicle", api_version: "cap.err.apiVersion", no_credentials: "cap.err.noCreds" };

const capBlank = () => ({ credsUpd: undefined, base: null, phase: "form", id: "", pw: "", ppw: "", file: null, fileErr: null, route: null, sent: null, busy: false, msg: null, notCapable: false,
  setupSent: false, finishSent: false, signOpened: false, signChecked: false, unlockUsed: false, recheck: false, storeOpen: false, seen: {}, sig: null });
let CAP = capBlank();

/* ── 純邏輯(tests/check_shell_capital_view.js 從原文切出來跑;這一段不准碰 DOM)── */
const capSec = (cc, k) => (cc && cc[k] && typeof cc[k] === "object" ? cc[k] : {});
// 主機是不是 Windows:true / false / null(還不知道 → 不擋)。報告的 platform 是 Python platform.system()
function capIsWindows(report, cloud) {
  const p = report && typeof report.platform === "string" ? report.platform : null;
  if (p) return p === "Windows";
  const o = cloud && cloud.machine && typeof cloud.machine.os_type === "string" ? cloud.machine.os_type.toLowerCase() : null;
  return o ? o.indexOf("win") === 0 : null;
}
/* 哪一步在跑:主機寫的 busy / 段落 running 為準;剛送出、回報還沒動的那幾秒用 sent 墊。
   段落卡在 running 超過 CAP_STUCK_MS 不算(主機發版重開打斷,下一個指令才會被清成 INTERRUPTED) */
function capRunning(cc, sent, now) {
  const fresh = (sec) => typeof sec.at !== "number" || now - sec.at * 1000 < CAP_STUCK_MS;
  const upd = cc && typeof cc.updated_at === "number" ? now - cc.updated_at * 1000 < CAP_STUCK_MS : true;
  // 段落先看(上傳那一步的後半就是確認帳密:busy 還是 capital_pfx,但在跑的是 probe);busy 墊在段落還沒寫的那一瞬間
  const s = (k, v) => capSec(cc, k).status === v && fresh(capSec(cc, k));
  if (s("probe", "running")) return "probe";
  if (s("worker", "running")) return "finish";
  if (s("cert", "importing")) return "pfx";
  if (s("setup", "running")) return "setup";
  if (cc && typeof cc.busy === "string" && CAP_STEP_OF_BUSY[cc.busy] && upd) return CAP_STEP_OF_BUSY[cc.busy];
  if (sent) return sent.step === "unlock" ? "probe" : sent.step;
  return null;
}
// 確認帳密那一步掛在哪一列跑:上一次的結果是哪一列的事,重查就在那一列轉圈
function capProbeRow(cc) {
  const st = capSec(cc, "probe").state;
  return st === "no_accounts" ? "sign" : st === "verify_needed" ? "verify" : st === "pw_wrong" || st === "pw_locked" || st === "no_credentials" ? "pw" : "cert";
}
/* (capital_connect, 畫面自己的狀態, { win, now }) → 態的名字(spec 的 c-* 家族 + 這版補的幾個)。順序有意義:
   在跑的最先(按鈕全鎖)、再來是要用戶做事的、最後是選做法 */
function capView(cc, ui, ctx) {
  if (ctx.win === false) return "c-win";
  if (ui.notCapable) return "c-handoff";
  if (ui.phase === "form") return "c-form";
  const setup = capSec(cc, "setup"), cert = capSec(cc, "cert"), probe = capSec(cc, "probe"), worker = capSec(cc, "worker");
  const run = capRunning(cc, ui.sent, ctx.now);
  if (run === "finish") return "c-finish";
  if (run === "probe") return "c-probe";
  if (run === "pfx") return "c-importing";
  if (ui.recheck) return ui.unlockUsed ? "c-pw-change" : "c-pw-err";
  if (run !== "setup" && setup.status === "failed") return "c-setup-fail";
  /* 這次開框重存過帳密(credsUpd = 送出前主機那份的 updated_at,主機時鐘):之前那次確認帳密與下單程式都是舊帳密的結果,
     不算數——解綁再重綁不能直接講「已連接」,也不能拿舊的 probe ok 去送 finish */
  const since = ui.credsUpd, fresh = (sec) => since === undefined || (typeof sec.at === "number" && sec.at > (since || 0));
  if (fresh(worker) && worker.status === "ok") return probe.futures === false ? "c-done-ts" : "c-done";
  if (fresh(worker) && worker.status === "failed") return "c-finish-fail";
  // 上一次上傳失敗、而且比上一次確認帳密新:先講上傳的錯(主機上原本那張還在,但用戶剛做的事沒成)
  const pfxNewer = cert.status === "failed" && (typeof probe.at !== "number" || (typeof cert.at === "number" && cert.at >= probe.at));
  if (!pfxNewer && fresh(probe) && (probe.status === "ok" || probe.status === "failed") && typeof probe.state === "string") {
    switch (probe.state) {
      case "ok": return "c-finish";
      case "no_accounts": return ui.signChecked ? "c-sign-none" : ui.signOpened ? "c-sign-wait" : "c-sign";
      case "pw_wrong": case "no_credentials": return "c-pw-err";
      case "pw_locked": return ui.unlockUsed ? "c-pw-change" : "c-pw-locked";
      case "verify_needed": return "c-verify";
      case "cert_old": case "cert_unusable": case "cert_expired": return "c-cert-bad";
      case "api_version": return "c-setup-fail";
      default: return "c-probe-fail";
    }
  }
  if (cert.status === "failed") return "c-pfx";
  if (cert.status === "ok" || (!fresh(probe) && probe.status !== "idle" && probe.status)) return "c-probe-idle";
  return ui.route === "pfx" ? "c-pfx" : ui.route === "rdp" ? "c-rdp" : "c-pick";
}
// ISO 到期時間 → 本地日期 YYYY/MM/DD(讀不懂就 null,不畫)
function capDate(iso) {
  const d = typeof iso === "string" ? new Date(iso) : null;
  if (!d || isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
}
/* ── 純邏輯到此 ── */

const capCC = () => { const r = TR_BAGS.cloud.st && TR_BAGS.cloud.st.report; const c = r && r.capital_connect; return c && typeof c === "object" ? c : null; };
const capCtx = () => ({ win: capIsWindows(TR_BAGS.cloud.st && TR_BAGS.cloud.st.report, TR_BAGS.cloud.st && TR_BAGS.cloud.st.cloud), now: Date.now() });
const capDown = () => envCloudKind(TR_BAGS.cloud.st) !== "running";
// 埋點(feature_used 白名單,api 與 shell/telemetry.js 同一份):每開一次框每個名字最多一次;失敗不埋、不帶任何內容
const CAP_FEATURE = { form: "cap_form_saved", setup: "cap_setup_done", pfx: "cap_pfx_upload", sign: "cap_sign_open", ready: "cap_ready", rdp: "cap_rdp_open" };
function capTrack(k) { if (CAP_FEATURE[k] && !CAP.seen[k]) { CAP.seen[k] = true; trackFeature(CAP_FEATURE[k]); } }

// 開框 / 換交易所 / 關框:欄位與流程狀態全丟,主行程那份 pfx 也歸零。重開時從主機回報的 capital_connect 接回來
function capForget() {
  CAP = capBlank();
  if (window.blave && typeof window.blave.capitalForget === "function") window.blave.capitalForget().catch(() => {});
}
// 開框時決定從哪裡開始:主機上開始過(有 capital_connect)而且帳密已經存了 → 直接回到清單
function capResume() {
  const cc = capCC(), r = TR_BAGS.cloud.st && TR_BAGS.cloud.st.report, v = r && r.venues && r.venues[CAPITAL];
  if (cc && v && v.credentials) CAP.phase = "flow";
}

/* 送一步(setup / probe / unlock / finish):回條大多等不到,記下 sent,等回報動了才收。
   同步拒收的代號當場講(BUSY、PW_RECHECK_NEEDED…);NOT_CAPABLE = 主機 runtime 還不認得 → 交給 agent */
async function capStep(name) {
  if (CAP.busy || capDown()) return;
  const cc = capCC();
  CAP.busy = true; CAP.msg = null; capPaint();
  let r = null; try { r = await window.blave.capitalStep(name); } catch (_) { }
  CAP.busy = false;
  const code = r && r.code;
  if (code === "OK" || code === "SENT") CAP.sent = { step: name, at: Date.now(), upd: cc ? cc.updated_at : null };
  else if (code === "NOT_CAPABLE") CAP.notCapable = true;
  else if (code === "PW_RECHECK_NEEDED") { CAP.recheck = true; if (name === "unlock") CAP.unlockUsed = true; }
  else CAP.msg = r || { code: "UNDELIVERED" };
  if (name === "unlock" && (code === "OK" || code === "SENT")) CAP.unlockUsed = true;
  capBurst(); capPaint();
}
function capBurst() { ENV.burst = trBurstBump(ENV.burst, Date.now(), TR_BURST_MS, TR_BURST_MAX_MS); trPollSoon(1500); }

// 表單 / 重填帳密 → credentials;成功後照順序往下(第一次:裝元件;重填:重新確認帳密)
async function capSaveCreds(then) {
  if (CAP.busy || capDown()) return;
  const before = capCC(), upd = before ? before.updated_at || 0 : null;
  CAP.busy = true; CAP.msg = null; capPaint();
  let r = null; try { r = await window.blave.capitalCreds(CAP.id, CAP.pw); } catch (_) { }
  CAP.busy = false;
  if (!r || r.code !== "OK") {
    CAP.msg = r && r.code === "NOT_CAPABLE" ? { code: "UNDELIVERED", error: "UNKNOWN_COMMAND" } : r || { code: "UNDELIVERED" };
    capPaint(); return false;
  }
  CAP.id = ""; CAP.pw = ""; CAP.recheck = false; CAP.unlockUsed = false; CAP.credsUpd = upd; CAP.finishSent = false;
  capTrack("form");
  if (then) await then();
  return true;
}
async function capGo() {
  if (CAP.phase !== "form" || !CAP.id.trim() || !CAP.pw) return;
  await capSaveCreds(async () => {
    CAP.phase = "flow";
    const cc = capCC();
    if (capSec(cc, "setup").status === "ok") {
      // 主機上確認過帳密、或匯過憑證(解綁再重綁、改密碼):用新帳密重新確認一次;從沒到過那一步的照舊停在選做法
      const probe = capSec(cc, "probe"), had = capSec(cc, "cert").status === "ok" || probe.status === "ok" || probe.status === "failed";
      if (had) await capStep("probe"); else capPaint();
      return;
    }
    CAP.setupSent = true;
    await capStep("setup");   // 主機回 unknown command → notCapable:帳密已經存好,剩下交給 agent(過渡期)
  });
}

async function capPick() {
  if (CAP.busy) return;
  CAP.busy = true; capPaint();
  let r = null; try { r = await window.blave.capitalPick(); } catch (_) { }
  CAP.busy = false;
  if (r && r.code === "OK") { CAP.file = { name: String(r.name || "").slice(-80), size: r.size }; CAP.fileErr = null; }
  else if (r && r.code !== "CANCELED") { CAP.file = null; CAP.fileErr = r.code; }
  capPaint();
  const f = $("cap-pick"); if (f) f.focus();
}
async function capUpload() {
  if (CAP.busy || capDown() || !CAP.file || !CAP.ppw) return;
  const cc = capCC();
  CAP.busy = true; CAP.msg = null; capPaint();
  let r = null; try { r = await window.blave.capitalUpload(CAP.ppw); } catch (_) { }
  CAP.busy = false;
  const code = r && r.code;
  if (code === "OK" || code === "SENT") {
    CAP.ppw = ""; CAP.route = "pfx";
    CAP.sent = { step: "pfx", at: Date.now(), upd: cc ? cc.updated_at : null };
    capTrack("pfx");
  } else if (code === "NOT_CAPABLE") CAP.notCapable = true;
  else CAP.msg = r || { code: "UNDELIVERED" };
  capBurst(); capPaint();
}
/* 交給 agent(過渡期與遠端桌面後備):本機 agent 經 blave MCP 帶用戶走 RDP 流程。聊天欄收著就先展開(過程在那裡);
   回合在跑時鈕是停用的(submitMessage 也會擋) */
async function capHandoff(which) {
  if (typeof running !== "undefined" && running) return;
  if (typeof paneSt !== "undefined" && paneSt.chat.off) paneToggle("chat", false);
  const ok = await submitMessage(t(which === "rdp" ? "cap.ho.promptRdp" : which === "verify" ? "cap.ho.promptVerify" : which === "read" ? "cap.ho.promptRead" : "cap.ho.prompt"), { viewing: { env: "cloud" } });
  if (ok) { capTrack("rdp"); cxModalClose(true); }
}
function capSign() { window.blave.openExternal(CAP_SIGN_URL); CAP.signOpened = true; capTrack("sign"); capPaint(); }

/* 看回報推進:sent 在回報動了就收;逾時不收(改講「主機還沒回報」)。自動的兩步:
   ① 進了清單、元件沒裝好也沒在裝 → 送 setup(每開一次框一次)
   ② 帳密確認過(probe ok)→ 送 finish 起下單程式(每開一次框一次;失敗就停下來給「再試一次」) */
function capAdvance(view, cc) {
  if (CAP.sent && cc && cc.updated_at !== CAP.sent.upd) {
    if (CAP.sent.step === "probe" && (CAP.signOpened || view === "c-sign-wait")) CAP.signChecked = true;
    CAP.sent = null;
  }
  const setup = capSec(cc, "setup"), worker = capSec(cc, "worker");
  // 埋點只記這次開框真的看到它完成(開框時已經完成的不算;主行程另有同日同名去重)
  if (!CAP.base) CAP.base = { setup: setup.status || null, worker: worker.status || null };
  if (setup.status === "ok" && CAP.base.setup !== "ok") capTrack("setup");
  if (CAP.busy || CAP.sent || capDown() || CAP.phase !== "flow" || CAP.notCapable || (cc && cc.busy)) return;
  if (!CAP.setupSent && setup.status !== "ok" && setup.status !== "running" && setup.status !== "failed") { CAP.setupSent = true; capStep("setup"); return; }
  if (view === "c-finish" && !CAP.finishSent && worker.status !== "running") { CAP.finishSent = true; capStep("finish"); }
}

// ── DOM ────────────────────────────────────────────────────────────────────
const CAP_CHECK = [["path", { d: "M20 6 9 17l-5-5" }]];
function capMark(st) {
  const mk = trEl("span", "cap-mk"); mk.setAttribute("aria-hidden", "true");
  if (st === "done") { const NS = "http://www.w3.org/2000/svg", svg = document.createElementNS(NS, "svg"); svg.setAttribute("class", "ic"); svg.setAttribute("viewBox", "0 0 24 24");
    CAP_CHECK.forEach(([tag, a]) => { const n = document.createElementNS(NS, tag); Object.keys(a).forEach((k) => n.setAttribute(k, a[k])); svg.appendChild(n); }); mk.appendChild(svg); }
  else mk.appendChild(trEl("span", st === "run" ? "spin16" : st === "cur" ? "cur" : st === "bad" ? "fault-mark" : "todo"));
  return mk;
}
// 清單一列:st = done | run | cur | todo | bad;right = 右側短結果(字串,或已經排好字體的節點);x = 展開內容(只有目前那一列)
function capRow(st, name, right, x) {
  const li = trEl("li", "cap-step" + (st === "cur" || (st === "bad" && x) ? " is-cur" : st === "todo" ? " is-todo" : ""));
  const r = trEl("span", "cap-r"); if (right && typeof right === "object") r.appendChild(right); else r.textContent = right || "";
  li.append(capMark(st), trEl("span", "cap-n", name), r);
  if (x) { const w = trEl("div", "cap-x"); w.appendChild(x); li.appendChild(w); }
  return li;
}
const capFrag = (...kids) => { const f = document.createDocumentFragment(); kids.filter(Boolean).forEach((k) => f.appendChild(k)); return f; };
const capDo = (text, dim) => trEl("p", "cap-do" + (dim ? " is-dim" : ""), text);
function capErr(text, calm) {
  const p = trEl("p", "plan-err" + (calm ? " is-calm" : "")), m = trEl("span", "fault-mark"); m.setAttribute("aria-hidden", "true");
  p.setAttribute("role", "status"); p.append(m, trEl("span", "", text)); return p;
}
function capBtn(cls, text, on, id, off) {
  const b = trEl("button", cls, text); b.type = "button"; if (id) b.id = id;
  if (off) { if (cls === "btn-quiet") b.disabled = true; else b.setAttribute("aria-disabled", "true"); }
  b.addEventListener("click", () => { if (b.getAttribute("aria-disabled") === "true") return; on(); });
  return b;
}
const capActs = (...btns) => { const d = trEl("div", "cap-acts"); btns.filter(Boolean).forEach((b) => d.appendChild(b)); return d; };
function capField(id, label, key, opts) {
  const o = opts || {}, l = trEl("label", "fld"); l.appendChild(trEl("span", "fld-l", label));
  // 身分證字號明碼(打錯會回 300,再錯可能被鎖 307:看得到自己打了什麼比遮住更要緊);交易密碼照樣遮住
  const i = trEl("input", "f-input txt" + (o.plain ? " cap-idf" : "") + (o.err ? " is-err" : "")); i.id = id; i.type = o.plain ? "text" : "password"; i.autocomplete = "off"; i.spellcheck = false; i.setAttribute("autocapitalize", "off");
  i.value = CAP[key]; i.readOnly = !!o.ro;
  i.addEventListener("input", () => { if (o.plain && i.value !== i.value.toUpperCase()) { const p = i.selectionStart; i.value = i.value.toUpperCase(); i.setSelectionRange(p, p); } CAP[key] = i.value; capSyncGo(); });
  i.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing && o.enter) { e.preventDefault(); o.enter(); } });
  l.appendChild(i);
  const d = [];
  if (o.hint) { const h = trEl("p", "cx-hint", o.hint); h.id = id + "-hint"; d.push(h.id); l.appendChild(h); }
  if (o.err) { const e = trEl("p", "cap-err", o.err); e.id = id + "-err"; e.setAttribute("role", "status"); d.push(e.id); l.appendChild(e); }
  if (d.length) i.setAttribute("aria-describedby", d.join(" "));
  return l;
}
// 「帳密存在哪?」:只有主機確定把帳密放進獨立檔(vault:true)才講那一句(Wei 拍板的誠實版);不確定就不講
function capStore(cc) {
  if (!cc || cc.vault !== true) return null;
  const note = trEl("div", "cx-note"), disc = trEl("button", "cx-disc", t("cap.store.q")), p = trEl("p", "cx-disc-p", t("cap.storeCloud"));
  disc.type = "button"; disc.id = "cap-store-q"; p.id = "cap-store"; disc.setAttribute("aria-controls", "cap-store");
  disc.setAttribute("aria-expanded", CAP.storeOpen ? "true" : "false"); p.hidden = !CAP.storeOpen;
  disc.addEventListener("click", () => { CAP.storeOpen = !CAP.storeOpen; disc.setAttribute("aria-expanded", CAP.storeOpen ? "true" : "false"); p.hidden = !CAP.storeOpen; });
  note.append(disc, p); return note;
}
// 同步拒收 / 沒送到那一句(BUSY、主機沒在跑…);沒送到的沿用雲端那組句子
function capMsgText(m) {
  if (!m) return null;
  const c = m.code;
  if (c === "BUSY") return t("cap.err.busy");
  if (c === "UNKNOWN_RESULT") return t("cap.err.credsUnknown");
  if (c === "BAD_FORMAT") return t("cap.err.idFormat");
  if (c === "KEY_TIMEOUT" || c === "KEY_EXPIRED" || c === "KEY_INVALID") return t("cap.pfx.errKey");
  if (c === "CRYPTO_MISSING") return t("cap.err.notReady");
  if (c === "UNDELIVERED") return trSendError({ error: m.error, kind: m.kind || "undelivered", machineState: m.machineState }, "connect", "cloud") || t("side.stopped");
  return t("cap.err.generic");
}
// 送出之後回報一直沒動:灰記號 + 再按一次(新的 request_id;主機那邊同一步在跑的話會回 BUSY,不會跑兩次)
function capNoMove() {
  if (!CAP.sent || Date.now() - CAP.sent.at < CAP_NO_MOVE_MS) return null;
  const step = CAP.sent.step;   // 「我已解鎖」主機只放行一次:逾時重按改送一般的確認帳密(被擋就回 PW_RECHECK_NEEDED → 重填)
  return capFrag(capDo(t("cap.err.noMove")), capActs(capBtn("btn-out", t("cap.tryAgain"), () => { CAP.sent = null; if (step === "pfx") { CAP.route = "pfx"; capPaint(); } else capStep(step === "unlock" ? "probe" : step); })));
}

function capPfxBody(cc, view) {
  const cert = capSec(cc, "cert"), code = view === "c-pfx" && cert.status === "failed" ? cert.error : null;
  const fileErrKey = CAP.fileErr ? CAP_PFX_FILE_ERR[CAP.fileErr] || "cap.pfx.errRead" : code && CAP_PFX_FILE_ERR[code];
  const pwErr = code === "PFX_PASSWORD" ? t("cap.pfx.errPw") : null;
  const setupOk = capSec(cc, "setup").status === "ok", off = CAP.busy || capDown() || !setupOk || !!(cc && cc.busy);
  const f = document.createDocumentFragment();
  if (view === "c-cert-bad") f.appendChild(capDo(t(CAP_PROBE_ERR[capSec(cc, "probe").state] || "cap.err.certUnusable")));   // 列已經是紅短劃:這句不再加記號
  const how = trEl("p", "cap-do", t("cap.pfx.how") + " ");
  how.appendChild(capBtn("btn-quiet", t("cap.pfx.dl"), () => window.blave.openExternal(CAP_CERT_URL)));
  f.appendChild(how);
  const fl = trEl("div", "fld"); fl.appendChild(trEl("span", "fld-l", t("cap.pfx.file")));
  const row = trEl("div", "cap-file");
  row.appendChild(capBtn("btn-out", t("cap.pfx.pick"), capPick, "cap-pick", CAP.busy));
  if (CAP.file) { const chip = trEl("span", "cx-chip"); chip.appendChild(trEl("span", "v", CAP.file.name)); row.appendChild(chip); }
  fl.appendChild(row);
  if (fileErrKey) { const e = trEl("p", "cap-err", t(fileErrKey)); e.setAttribute("role", "status"); fl.appendChild(e); }
  f.appendChild(fl);
  f.appendChild(capField("cap-ppw", t("cap.pfx.pw"), "ppw", { hint: t("cap.pfx.pwHint"), err: pwErr, ro: CAP.busy, enter: capUpload }));
  if (code && !fileErrKey && !pwErr) f.appendChild(capErr(t(code === "INTERRUPTED" || code === "KEY_EXPIRED" ? "cap.pfx.errKey" : "cap.pfx.errImport")));
  f.appendChild(trEl("p", "cx-manual-note", t("cap.pfx.replace")));   // 不可逆的後果放在誠實句與鈕正上方
  f.appendChild(trEl("p", "cx-manual-note cap-e2e", t("cap.pfx.e2e")));
  const go = capBtn("btn-fill", t("cap.pfx.go"), capUpload, "cap-upload", off || !CAP.file || !CAP.ppw);
  go.dataset.need = "file,ppw";
  f.appendChild(capActs(go, capBtn("btn-quiet", t("cap.c.other"), () => { CAP.route = null; CAP.fileErr = null; capPaint(); }, "cap-other")));
  return f;
}
function capPickBody() {
  const opts = trEl("div", "cap-opts"), o = trEl("button", "cap-opt"); o.type = "button"; o.id = "cap-opt-pfx";
  const tx = trEl("span", "t"); tx.append(trEl("p", "n", t("cap.c.pfx")), trEl("p", "m", t("cap.c.pfxM")));
  o.append(tx, trEl("span", "chev")); o.addEventListener("click", () => { CAP.route = "pfx"; capPaint(); const b = $("cap-pick"); if (b) b.focus(); });
  opts.appendChild(o);
  return capFrag(opts, capActs(capBtn("btn-quiet", t("cap.c.rdp"), () => { CAP.route = "rdp"; capPaint(); }, "cap-opt-rdp")));
}
const capReadHo = () => capBtn("btn-quiet", t("cap.ho.go"), () => capHandoff("read"), "cap-ho", typeof running !== "undefined" && running);
const capHoBtn = (which, id) => capBtn("btn-fill", t("cap.ho.go"), () => capHandoff(which), id, typeof running !== "undefined" && running);
function capRdpBody() {
  return capFrag(capDo(t("cap.c.rdpDo")), capActs(capHoBtn("rdp", "cap-ho"), capBtn("btn-quiet", t("cap.c.other"), () => { CAP.route = null; capPaint(); }, "cap-other")));
}

/* 態 → 清單各列。列固定四列(安裝元件、憑證、簽署、讀取帳戶),「確認帳密」「連線檢核」只在那一態插入 */
function capRows(view, cc) {
  const setup = capSec(cc, "setup"), cert = capSec(cc, "cert"), probe = capSec(cc, "probe");
  const run = capRunning(cc, CAP.sent, Date.now()), off = CAP.busy || capDown() || !!(cc && cc.busy);
  const exp = capDate(cert.not_after), certDoneRight = exp ? t("cap.s.certExp", { date: exp }) : "";
  const rows = [], nm = capNoMove();
  // 在跑的那一列:主機一直沒回報(nm)就不轉圈了,改成「輪到你」的靜態點 + 一句 + 再試一次(一列只有一個記號)
  const runRow = (name, right) => (nm ? capRow("cur", name, "", nm) : capRow("run", name, right));
  // 1 安裝群益元件
  if (setup.status === "ok") rows.push(capRow("done", t("cap.s.setup")));
  else if (view === "c-setup-fail") {
    const api = probe.state === "api_version" && setup.status !== "failed";
    rows.push(capRow("bad", t("cap.s.setup"), "", capFrag(capDo(t(api ? "cap.err.apiVersion" : "cap.s.setupFail")), capActs(capBtn("btn-out", t("cap.tryAgain"), () => capStep("setup"), "cap-retry", off)))));
  } else rows.push(run === "setup" ? runRow(t("cap.s.setup"), t("cap.s.setupRun")) : capRow("run", t("cap.s.setup"), t("cap.s.setupRun")));
  // 2 憑證
  const certName = view === "c-rdp" ? t("cap.c.rdp") : view === "c-pfx" || view === "c-cert-bad" || view === "c-importing" ? t("cap.c.pfx") : t("cap.c.pick");
  const probeRow = capProbeRow(cc);
  // 確認帳密失敗(載具、逾時、未知碼)掛哪一列:憑證已匯入 = 失敗在讀帳戶那一步;還沒有憑證紀錄 = 憑證列
  const failRow = cert.status === "ok" ? "read" : "cert";
  const certDone = cert.status === "ok" || (probe.state && ["cert_old", "cert_unusable", "cert_expired", "api_version"].indexOf(probe.state) < 0 && view !== "c-pfx" && view !== "c-importing");
  if (view === "c-setup-fail") rows.push(capRow("todo", certName));
  else if (view === "c-importing") rows.push(runRow(certName, t("cap.pfx.importing")));
  else if (view === "c-probe" && probeRow === "cert") rows.push(runRow(certName, t("cap.s.probe")));
  else if (view === "c-pick") rows.push(capRow("cur", certName, "", capPickBody()));
  else if (view === "c-pfx" || view === "c-cert-bad") rows.push(capRow(view === "c-cert-bad" ? "bad" : "cur", certName, "", capPfxBody(cc, view)));
  else if (view === "c-rdp") rows.push(capRow("cur", certName, "", capRdpBody()));
  else if (view === "c-probe-idle") rows.push(capRow("cur", certName, certDoneRight, capFrag(capDo(t("cap.s.probeIdle")), capActs(capBtn("btn-fill", t("cap.recheck"), () => capStep("probe"), "cap-probe", off)))));
  else if (view === "c-probe-fail" && failRow === "cert") {
    const st = probe.state, txt = CAP_PROBE_ERR[st] ? t(CAP_PROBE_ERR[st]) : t("cap.err.unknownCode", { code: probe.code == null ? "—" : String(probe.code) });
    rows.push(capRow("bad", certName, "", capFrag(capDo(txt), capActs(capBtn("btn-fill", t("cap.retry"), () => capStep("probe"), "cap-probe", off)))));
  } else rows.push(capRow(certDone ? "done" : "todo", certName, certDone ? certDoneRight : ""));
  // 2′ 確認帳密(300 / 307 / 讀不到帳密 才出現)
  if (view === "c-pw-err" || view === "c-pw-change") {
    // 列已經掛紅短劃:原因句不再加第二個記號(spec §1.2)——密碼的錯寫在密碼欄下,讀不到帳密是一句說明
    const noCreds = view === "c-pw-err" && probe.state === "no_credentials" && !CAP.recheck;
    const pwErr = noCreds ? null : view === "c-pw-change" ? t("cap.err.pwChange") : t("cap.err.pw");
    const ready = CAP.id.trim() && CAP.pw && !off;
    const go = capBtn("btn-fill", t("cap.recheck"), () => capSaveCreds(() => capStep("probe")), "cap-recheck", !ready); go.dataset.need = "id,pw";
    rows.push(capRow("bad", t("cap.s.pw"), "", capFrag(noCreds ? capDo(t("cap.err.noCreds")) : null, capField("cap-id", t("cap.id"), "id", { plain: true, ro: CAP.busy }),
      capField("cap-pw", t("cap.pw"), "pw", { ro: CAP.busy, err: pwErr, enter: () => { if (CAP.id.trim() && CAP.pw) capSaveCreds(() => capStep("probe")); } }), capActs(go), capStore(cc))));   // 揭露句在鈕之後:不把欄位和它的鈕拆開
  } else if (view === "c-pw-locked") {
    rows.push(capRow("bad", t("cap.s.pw"), "", capFrag(capDo(t("cap.err.pwLocked")), capDo(t("cap.c.unlockDo"), true), capActs(capBtn("btn-fill", t("cap.unlocked"), () => capStep("unlock"), "cap-unlock", off)))));
  } else if (view === "c-probe" && probeRow === "pw") rows.push(runRow(t("cap.s.pw"), t("cap.s.probe")));
  // 2″ 連線檢核(321 才出現)
  if (view === "c-verify") {
    // 先下載檢核工具,按過就翻成「再查一次」(同簽署列);再查過還是 321 → 列頭一句「還沒記到」
    const dl = () => { window.blave.openExternal(CAP_VERIFY_URL); CAP.verifyDl = true; capPaint(); };
    const again = () => { CAP.verifyChecked = true; capStep("probe"); };
    const ho = capBtn("btn-quiet", t("cap.ho.go"), () => capHandoff("verify"), "cap-ho", typeof running !== "undefined" && running);
    rows.push(capRow("cur", t("cap.s.verify"), "", capFrag(CAP.verifyChecked ? capErr(t("cap.s.verifyNot")) : null, capDo(t("cap.c.verifyDo")),
      CAP.verifyDl || CAP.verifyChecked ? capActs(capBtn("btn-fill", t("cap.retry"), again, "cap-probe", off), capBtn("btn-quiet", t("cap.c.verifyDl"), dl, "cap-verify-dl"), ho)
        : capActs(capBtn("btn-fill", t("cap.c.verifyDl"), dl, "cap-verify-dl"), ho))));
  }
  else if (view === "c-probe" && probeRow === "verify") rows.push(runRow(t("cap.s.verify"), t("cap.s.querying")));
  // 3 簽署 API 聲明書
  const signDo = capDo(t("cap.s.signDo"));
  if (view === "c-sign") rows.push(capRow("cur", t("cap.s.sign"), "", capFrag(signDo, capActs(capBtn("btn-fill", t("cap.s.signOpen"), capSign, "cap-sign")))));
  else if (view === "c-sign-wait") rows.push(capRow("cur", t("cap.s.sign"), "", capFrag(signDo, capActs(capBtn("btn-fill", t("cap.s.signDone"), () => capStep("probe"), "cap-probe", off), capBtn("btn-quiet", t("cap.s.signOpen"), capSign)))));
  else if (view === "c-sign-none") rows.push(capRow("cur", t("cap.s.sign"), "", capFrag(capErr(t("cap.s.signNone"), true), capActs(capBtn("btn-fill", t("cap.retry"), () => capStep("probe"), "cap-probe", off), capBtn("btn-quiet", t("cap.s.signOpen"), capSign)))));
  else if (view === "c-probe" && probeRow === "sign") rows.push(runRow(t("cap.s.sign"), t("cap.s.querying")));
  else rows.push(capRow(view === "c-finish" || view === "c-finish-fail" ? "done" : "todo", t("cap.s.sign")));
  // 4 讀取帳戶(起下單程式、等第一份快照)
  if (view === "c-finish") rows.push(runRow(t("cap.s.read"), t("cap.s.readRun")));
  // 讀取失敗掛在「讀取帳戶」列(失敗發生的那一步,同 web);載具起不來、未知碼、快照錯誤按重試解不掉 → 另給交給 agent
  else if (view === "c-probe-fail" && failRow === "read") {
    const st = probe.state, txt = CAP_PROBE_ERR[st] ? t(CAP_PROBE_ERR[st]) : t("cap.err.unknownCode", { code: probe.code == null ? "—" : String(probe.code) });
    rows.push(capRow("bad", t("cap.s.read"), "", capFrag(capDo(txt), capActs(capBtn("btn-fill", t("cap.retry"), () => capStep("probe"), "cap-probe", off), capReadHo()))));
  } else if (view === "c-finish-fail") {
    const code = String(capSec(cc, "worker").error || "");
    const txt = code === "SNAPSHOT_ERROR" ? t("cap.err.snapshot") : code === "PROBE_NOT_OK" ? t("cap.err.probeNotOk") : t("cap.err.worker");
    rows.push(capRow("bad", t("cap.s.read"), "", capFrag(capDo(txt), capActs(capBtn("btn-out", t("cap.tryAgain"), () => { CAP.finishSent = true; capStep("finish"); }, "cap-retry", off), capReadHo()))));
  } else rows.push(capRow("todo", t("cap.s.read")));
  const ol = trEl("ol", "cap-steps"); rows.forEach((r) => ol.appendChild(r));
  return ol;
}
function capDoneBody(cc, view) {
  const probe = capSec(cc, "probe"), exp = capDate(capSec(cc, "cert").not_after);
  const f = document.createDocumentFragment(), row = trEl("div", "cx-row");
  const st = trEl("span", "cn-st"); st.append(trEl("i", "dot"), trEl("span", "", t("cx.connected")));
  row.append(trEl("span", "n", t("cap.venue")), trEl("span", "mode real", t("tr.mode.real")), st);
  f.appendChild(row);
  const dl = trEl("dl", "cap-acct"), kv = (k, v, cls) => { const d = trEl("div", ""); d.append(trEl("dt", "", k), trEl("dd", cls || "", v)); dl.appendChild(d); };
  kv(t("cap.acct.ts"), probe.securities ? t("cap.acct.read") : "—", probe.securities ? "" : "none");
  kv(t("cap.acct.tf"), probe.futures ? t("cap.acct.read") : "—", probe.futures ? "" : "none");
  if (exp) kv(t("cap.acct.exp"), exp, "mono");
  f.appendChild(dl);
  if (view === "c-done-ts") { const p = trEl("p", "cx-manual-note", t("cap.tfMissing") + " "); p.appendChild(capBtn("btn-quiet", t("cap.s.signOpen"), capSign)); f.appendChild(p); }
  return f;
}
function capHandoffBody() {
  const f = document.createDocumentFragment();
  f.appendChild(trEl("p", "cap-lead", t("cap.ho.saved")));
  f.appendChild(trEl("p", "cap-lead", t("cap.ho.left")));
  const ol = trEl("ol", "cap-ol"); ["cap.ho.s1", "cap.ho.s2", "cap.ho.s3"].forEach((k) => ol.appendChild(trEl("li", "", t(k)))); f.appendChild(ol);
  return f;
}

// 腳:表單 = 一句「會在主機裝元件」+ 取消 + 開始開通;清單 = 目的地 + 關閉;完成 = 目的地 + 完成;交給 agent = 取消 + 交給 agent
function capFoot(view) {
  const go = $("cx-go"), cancel = $("cx-cancel"), foot = go.parentNode, where = $("cx-where");
  let msg = $("cap-foot-msg");
  if (view === "c-form") { if (!msg) { msg = trEl("span", "foot-msg"); msg.id = "cap-foot-msg"; foot.insertBefore(msg, foot.firstChild); } msg.textContent = t("cap.beforeC"); }
  else if (msg) msg.remove();
  const flow = view !== "c-form" && view !== "c-win" && view !== "c-handoff";
  where.hidden = view === "c-win"; where.textContent = view === "c-win" ? "" : t("tr.cloud.footWhere", { where: t("env.cloud"), money: envMoneyText("real"), venue: t("cap.venue") });
  cancel.hidden = view === "c-done" || view === "c-done-ts";
  cancel.textContent = flow || view === "c-handoff" ? t("set.close") : t("del.cancel");
  const done = view === "c-done" || view === "c-done-ts", label = view === "c-form" ? (CAP.busy ? t("cx.connecting") : t("cap.go")) : done ? t("cap.finish") : view === "c-handoff" ? t("cap.ho.go") : null;
  go.hidden = !label;
  if (label && (go.textContent.trim() !== label || !!go.querySelector(".spin16") !== (view === "c-form" && CAP.busy))) {
    go.textContent = "";
    if (view === "c-form" && CAP.busy) { const sp = trEl("span", "spin16"); sp.setAttribute("aria-hidden", "true"); go.append(sp, " "); }
    go.append(label);
  }
  go.classList.toggle("is-busy", view === "c-form" && CAP.busy);
  capSyncGo(view);
}
// 主鈕能不能按(打字時不重畫整個框,只改這個)
function capSyncGo(view) {
  const v = view || CAP.view, go = $("cx-go"), down = capDown();
  let off = down || CAP.busy;
  if (v === "c-form") off = off || !CAP.id.trim() || !CAP.pw;
  if (v === "c-handoff") off = off || (typeof running !== "undefined" && running);
  go.setAttribute("aria-disabled", off ? "true" : "false");
  document.querySelectorAll("#cx-body [data-need]").forEach((b) => {
    const need = b.dataset.need.split(","), miss = need.some((k) => (k === "file" ? !CAP.file : !String(CAP[k] || "").trim()));
    const busyOff = CAP.busy || down || (b.id === "cap-upload" && capSec(capCC(), "setup").status !== "ok");
    b.setAttribute("aria-disabled", miss || busyOff ? "true" : "false");
  });
}
// 換回別的交易所:把群益改過的標題與腳還回去(trade.js 的 cxModalPaint 每次先叫)
function capFootRestore() {
  const msg = $("cap-foot-msg"); if (msg) msg.remove();
  $("cx-title").textContent = t("cx.connect");
  $("cx-go").hidden = false; $("cx-cancel").hidden = false; $("cx-cancel").textContent = t("del.cancel");
  $("cx-body").removeAttribute("aria-busy");
}
// cx-go 按下(trade.js 的 cxConnect 交過來)
function capPrimary() {
  if ($("cx-go").getAttribute("aria-disabled") === "true") return;
  if (CAP.view === "c-form") return capGo();
  if (CAP.view === "c-done" || CAP.view === "c-done-ts") return cxModalClose(true);
  if (CAP.view === "c-handoff") return capHandoff("setup");
}

function capPaint() {
  if ($("cx-scrim").hidden || CXF.venue !== CAPITAL || CXF.env !== "cloud") return;
  const cc = capCC(), ctx = capCtx();
  let view = capView(cc, CAP, ctx);
  capAdvance(view, cc);
  view = capView(cc, CAP, ctx);
  CAP.view = view;
  if ((view === "c-done" || view === "c-done-ts") && CAP.base && (CAP.base.worker !== "ok" || CAP.finishSent)) capTrack("ready");
  const box = $("cx-body"), down = capDown();
  $("cx-title").textContent = view === "c-form" || view === "c-win" ? t("cx.connect") : t("cap.title");
  capFoot(view);
  box.setAttribute("aria-busy", CAP.busy || view === "c-finish" || view === "c-probe" || view === "c-importing" ? "true" : "false");
  const sig = LANG + "|" + JSON.stringify([view, cc, CAP.route, CAP.busy, CAP.msg, CAP.file, CAP.fileErr, CAP.signOpened, CAP.unlockUsed, CAP.verifyDl, CAP.verifyChecked, down,
    CAP.sent && Date.now() - CAP.sent.at >= CAP_NO_MOVE_MS, typeof running !== "undefined" && running]);
  if (CAP.sig === sig && box.firstChild) return;
  CAP.sig = sig;
  const hadId = box.contains(document.activeElement) ? document.activeElement.id : null;
  box.textContent = "";
  if (view === "c-form" || view === "c-win") {
    box.appendChild(cxVenueField(TR_BAGS.cloud));
    if (view === "c-win") box.appendChild(trEl("p", "cap-lead", t("cap.needWin")));
    else {
      box.appendChild(trEl("p", "cx-manual-note", t("cap.meta")));
      box.appendChild(capField("cap-id", t("cap.id"), "id", { plain: true, ro: CAP.busy, enter: capPrimary }));
      box.appendChild(capField("cap-pw", t("cap.pw"), "pw", { ro: CAP.busy, enter: capPrimary }));
      const st = capStore(cc); if (st) box.appendChild(st);
    }
  } else if (view === "c-handoff") box.appendChild(capHandoffBody());
  else if (view === "c-done" || view === "c-done-ts") box.appendChild(capDoneBody(cc, view));
  else box.appendChild(capRows(view, cc));
  const slot = trEl("div", ""); slot.setAttribute("role", "status"); box.appendChild(slot);
  const m = down ? t("side.stopped") : capMsgText(CAP.msg);
  if (m) slot.appendChild(capErr(m, !down && CAP.msg && CAP.msg.code === "BUSY"));
  capSyncGo(view);
  const back = hadId && $(hadId);
  if (back && !back.disabled) back.focus();
  else if (hadId || !box.contains(document.activeElement)) { const f = box.querySelector("input:not([readonly]), .cap-step.is-cur button:not([disabled]):not([aria-disabled='true']), select"); if (f && hadId) f.focus(); }
}
// 設定 › 帳戶 的解除綁定(群益的兩個名字由主行程決定)→ trade.js trSendError 認得的形狀
async function capUnbindSend() {
  let r = null; try { r = await window.blave.capitalUnbind(); } catch (_) { }
  const c = r && r.code;
  if (c === "OK") return { ok: true };
  if (c === "SENT") return { ok: false, error: "UNKNOWN_RESULT", kind: "unknown" };
  if (c === "UNDELIVERED") return { ok: false, error: r.error, kind: r.kind || "undelivered", machineState: r.machineState };
  return { ok: false, error: c || "OFFLINE", kind: "rejected" };
}
