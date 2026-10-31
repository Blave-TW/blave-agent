// 電腦版對話分頁的畫面核心(0.1.37;renderer/chattabs.js、技術方案 chat-tabs-parallel-tech §1.2)。
//   1. 列舉一:app.js 每一個頂層 let 都歸類——每個分頁一份(TAB_KEYS,切分頁整組換)或全 app 一份(GLOBAL_OK,寫明為什麼);
//      每輪模組(suggest／export／results／reports／browser)的每輪欄位也在 TAB_KEYS。多一個沒歸類的就紅
//   2. 列舉二:renderer 每一處讀「有沒有回合」的地方(識別字 running、busyOn()、csAnyTurn())都歸類——眼前這一條(TAB)、
//      任何回合(ANY,機器層級的鎖)、或不是回合狀態(LOCAL:同名的區域變數／參數)。多一處、少一處都紅
//   3. withTab:背景分頁換進來同步跑、換回;巢狀;跑完把它自己那份存回;tabBound 捕住當時的分頁;csAnyTurn 看每一條
// 跑法:node tests/check_shell_chat_tabs.js
const fs = require("fs"), path = require("path");
const R = path.join(__dirname, "..", "shell", "renderer");
const read = (f) => fs.readFileSync(path.join(R, f), "utf8");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  " + JSON.stringify(d).slice(0, 900))); if (!c) red++; };
const ct = read("chattabs.js"), app = read("app.js");

// ── 1. 頂層狀態 ──
const lets = [];
for (const m of app.matchAll(/^let ([^\n]*)/gm)) {
  let d = 0, cur = ""; const parts = [];
  for (const ch of m[1]) { if ("([{".includes(ch)) d++; else if (")]}".includes(ch)) d--; if (ch === "," && d === 0) { parts.push(cur); cur = ""; continue; } if (ch === ";" && d === 0) break; cur += ch; }
  parts.push(cur);
  for (const p of parts) { const n = (p.trim().match(/^([A-Za-z_$][\w$]*)/) || [])[1]; if (n) lets.push(n); }
}
const tabKeys = [...ct.matchAll(/^  \["([\w.]+)", \(\) =>/gm)].map((m) => m[1]);
const GLOBAL_OK = {
  localReady: "本機引擎偵測", lastDetect: "本機 AI 偵測結果", detectAt: "同上", HINT: "連結畫面提示", loginSpawned: "登入行程", cur: "連的是哪個 AI(全 app 一個)",
  hasToken: "Blave 登入", csReady: "對話清單第一次載入", acctOutBusy: "登出中", oauthPending: "登入中", SHL_SCROLL: "設定頁捲動", PRIV: "隱私設定", MV: "手機查看",
  MV_BUSY: "同上", PRIV_BUSY: "同上", RN: "回覆通知設定", rsCtx: "回覆音 AudioContext", rsLast: "回覆音 2 秒內只響一次(全 app)", composing: "輸入法組字(共用輸入框)",
  attachedFiles: "共用輸入框的附件;切分頁時由 tabShow 換成那個分頁的 composer.files", rpWaitShownAt: "中欄報告", rpcSeq: "中欄雲端報告", rpcOwed: "中欄雲端報告欠的重抓(任何回合結束才補)",
  csItems: "歷史清單", delCtx: "確認框", csSearched: "歷史搜尋埋點", turnSeq: "全 app 回合流水號(每個分頁另記 turnSeqMine)", lbOpener: "圖片放大框",
  thinkFoldSeq: "aria-controls 流水號", stepCharW: "量字寬的快取", loginPending: "本機 AI 登入中", acct: "帳號狀態", acctAt: "同上", acctRetry: "同上", balLast: "餘額",
  balSeq: "同上", acctGone: "去瀏覽器綁卡", acctPending: "帳號重查", acctSettled: "同上", taKeyed: "輸入框打過字(帳號卡)", planSlowSaid: "方案開通", planBusyPlan: "同上",
  planErr: "同上", planBusy: "同上", planSince: "同上", planTimer: "同上", planWas: "同上", planDoneSaid: "同上", planDonePending: "方案開好了那句:等眼前分頁閒著才講",
  pub: "公開資訊", pubAt: "同上", planLoginBusy: "方案登入", planLastView: "同上", planLoginOut: "同上",
};
const unclassified = lets.filter((n) => !tabKeys.includes(n) && !(n in GLOBAL_OK));
ok("app.js 每一個頂層 let 都歸類:每個分頁一份(TAB_KEYS)或全 app 一份(GLOBAL_OK)", unclassified.length === 0, unclassified);
const both = lets.filter((n) => tabKeys.includes(n) && n in GLOBAL_OK);
ok("沒有一個名字兩邊都列", both.length === 0, both);
const stale = Object.keys(GLOBAL_OK).filter((n) => !lets.includes(n)).concat(tabKeys.filter((k) => !k.includes(".") && !lets.includes(k) && k !== "SUG"));
ok("清單上的名字都還在(拿掉的變數要從清單拿掉)", stale.length === 0, stale);
ok("每輪模組的每輪欄位也進 TAB_KEYS:SUG(托盤跟著分頁)、XP.pending、RES.turn、RPT.turnAt／cloudTurn、BR.blocks／cur、UPD.turnCloud",
  ["SUG", "XP.pending", "RES.turn", "RPT.turnAt", "RPT.cloudTurn", "BR.blocks", "BR.cur", "UPD.turnCloud"].every((k) => tabKeys.includes(k)) && /^let SUG = /m.test(read("suggest.js")) && /^let ACT = /m.test(app) && /^let creditCards = /m.test(app));
ok("物件型的初值是工廠(每個分頁各一份,不共用同一個 Map／陣列)", /\["ACT", [^\n]*\(\) => \(\{ running: new Map\(\)/.test(ct) && /\["creditCards", [^\n]*\(\) => \[\]\]/.test(ct) && /\["SUG", [^\n]*\(\) => \(\{ pending: null/.test(ct));

// 1b. 其他 renderer 檔的模組層 let／var,以及每輪模組物件(LIB／RPT／XP／RES／BR／UPD)的每一個欄位:
//     TAB = 每個分頁一份(TAB_KEYS);SID = 記著發起那一條的 sid／序號,收尾只認那一條;GLOBAL = 全 app 一份(寫明為什麼)
const MOD_GLOBAL = {
  "browser.js": { brTipOn: "tooltip", brSyncQueued: "版面同步節流", brLastBounds: "內建瀏覽器的框(全 app 一個)" },
  "busy.js": { BUSY_PENDING: "原因句的一次性提示" }, "capital.js": { CAP: "群益交接頁" }, "capital_local.js": { CAPL: "群益本機", caplTimer: "同上" },
  "chattabs.js": { tabsK: "分頁列 tick 第幾格(全列一起)", tabsSaid: "讀屏播報合併" }, "i18n.js": { LANG: "語言" },
  "portfolio.js": { PO_ADD_SIG: "策略組合", ctMenu: "同上", ctOpen: "同上", mgmPend: "同上", mgmOpener: "同上", mgsDraft: "同上", mgsOpener: "同上" },
  "president.js": { PRES: "統一期貨", presTimer: "同上", PRES_FIRST_ARMED: "同上" }, "report-sharelist.js": { SHL_IO: "分享清單" }, "stratflags.js": { sfPop: "彈出層" },
  "suggest.js": { SUG: "TAB_KEYS 整個換(托盤跟著分頁)" },
  "trade.js": { TR_AS_SAVED: "自動下單頁", TR: "同上", trTipSeq: "同上", trHistTipEl: "同上", trHistTipAt: "同上", trHistTipOpened: "同上", trHistTipQuiet: "同上", trCvHide: "同上", trCvEscN: "同上", cxOpener: "同上", psOpener: "同上", psMode: "同上", psToAmt: "同上", psLoading: "同上", ENV_COMPOSING: "輸入法" },
  "versions.js": { vcSeq: "版本頁", vcSide: "同上" },
};
const FIELDS = {
  LIB: { pending: "SID", seq: "GLOBAL 清單請求流水號(丟掉晚到的舊回應)", noNew: "GLOBAL 灰字掛在那一支卡上", cloudWait: "GLOBAL 一次只等一支(換一支就放掉)" },
  RPT: { pending: "SID", seq: "GLOBAL 清單請求流水號", readSeq: "GLOBAL 閱讀頁請求流水號", turnAt: "TAB", cloudTurn: "TAB", cloudRes: "GLOBAL 每筆帶 rt(那一輪)", noNew: "GLOBAL 灰字掛在框上", poll: "GLOBAL 一次一個輪詢" },
  XP: { pending: "TAB" }, RES: { turn: "TAB", cw: "GLOBAL 一次等一輪,帶 rt" }, BR: { blocks: "TAB", cur: "TAB" },
  UPD: { cloudSid: "SID", turnCloud: "TAB", session: "GLOBAL 更新期間,只由 cloudSid 那一條的結束收", lagCv: "GLOBAL", done: "GLOBAL" },
};
const OBJ_FILE = { LIB: "library.js", RPT: "reports.js", XP: "export.js", RES: "results.js", BR: "browser.js", UPD: "app.js" };
const topNames = (src) => { const out = []; for (const m of src.matchAll(/^(?:let|var) ([^\n]*)/gm)) { let d = 0, cur = ""; const parts = [];
  for (const ch of m[1]) { if ("([{".includes(ch)) d++; else if (")]}".includes(ch)) d--; if (ch === "," && d === 0) { parts.push(cur); cur = ""; continue; } if (ch === ";" && d === 0) break; cur += ch; }
  parts.push(cur); for (const q of parts) { const n = (q.trim().match(/^([A-Za-z_$][\w$]*)/) || [])[1]; if (n) out.push(n); } } return out; };
{ const miss = [];
  for (const f of fs.readdirSync(R).filter((n) => n.endsWith(".js") && !["strings.js", "app.js"].includes(n)).sort())
    for (const n of topNames(read(f))) if (!(MOD_GLOBAL[f] && n in MOD_GLOBAL[f])) miss.push(f + ":" + n);
  ok("其他 renderer 檔的模組層 let／var 都歸類(沒有每輪狀態藏在全 app 一份裡)", miss.length === 0, miss);
  const appVars = topNames(app).filter((n) => /^var /m.test(app) && new RegExp("^var " + n + "\\b", "m").test(app));
  ok("app.js 的 var 也在清單(GLOBAL_OK 或 UPD 欄位表)", appVars.every((n) => n in GLOBAL_OK || n === "UPD" || /^UP|^CS_BOOTED$|^INSTALL_ID|^AWAKE$|^THEME$/.test(n)), appVars);
  const fbad = [];
  for (const [O, f] of Object.entries(OBJ_FILE)) {
    const src = read(f), m = src.match(new RegExp("^(?:const|let|var) " + O + " = \\{", "m"));
    if (!m) { fbad.push(O + " 找不到"); continue; }
    let i = m.index + m[0].length - 1, d = 0, j = i; for (; j < src.length; j++) { const c = src[j]; if (c === "{") d++; else if (c === "}") { d--; if (!d) break; } }
    let dd = 0, cur = ""; const keys = [];
    for (const c of src.slice(i + 1, j).replace(/\/\/[^\n]*/g, "")) { if ("([{".includes(c)) dd++; else if (")]}".includes(c)) dd--; if (c === "," && dd === 0) { keys.push(cur); cur = ""; continue; } cur += c; }
    keys.push(cur);
    for (const k of keys.map((x) => (x.trim().match(/^([A-Za-z_$][\w$]*)/) || [])[1]).filter(Boolean)) {
      const cls = FIELDS[O][k];
      if (cls === "TAB" && !tabKeys.includes(O + "." + k)) fbad.push(O + "." + k + " 標 TAB 卻不在 TAB_KEYS");
      if (cls === undefined && /pending|turn|Turn|sid|Sid|seq|wait|Wait/.test(k)) fbad.push(O + "." + k + " 看起來是每輪狀態、沒有歸類");
    }
  }
  ok("每輪模組物件裡看起來是「這一輪」的欄位(pending／turn／sid／seq／wait)都歸類;標 TAB 的真的在 TAB_KEYS", fbad.length === 0, fbad);
  ok("SID 類的收尾只認發起那一條:策略庫〔使用〕、新增報告、更新雲端主機、方案開好那句、掃描／樣本外的「已送出」序號",
    /if \(p\.sid && p\.sid !== sessionId\) return;/.test(read("library.js")) && /LIB\.pending = \{ id: s\.id, env, before, sid: at\.sid \}/.test(read("library.js")) && /if \(LIB\.pending\) LIB\.pending\.sid = at\.sid;/.test(read("library.js"))
    && /const mine = \(q\) => !!q && \(!q\.sid \|\| q\.sid === sessionId\);/.test(read("reports.js")) && /RPT\.pending\[env\] = \{ env, before, sid: at && at\.sid \}/.test(read("reports.js"))
    && /if \(UPD\.cloudSid && UPD\.cloudSid !== sessionId\) return;/.test(app) && /UPD\.cloudSid = sid;/.test(app)
    && /planDonePending = sessionId;/.test(app) && /if \(planDonePending && planDonePending === sessionId\) planSayDone\(\);/.test(app)
    && (app.match(/resolve\(ok \? at\.seq : false\)/g) || []).length === 2 && !/resolve\(ok \? turnSeq : false\)/.test(app)
    && /CS\.away = \{ sid: T \? T\.sid : sessionId, seq: turnSeqMine \};/.test(ct));
}

// ── 2. 「有沒有回合」的每一處 ──
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
const TAB = [   // 眼前這一條(分頁自己的 running;切分頁時整組換)
  ["app.js", /addEventListener\("click", \(\) => \(running \? stopTurn\(\) : sendDraft\(\)\)\)/, "送出鈕＝停止鈕"],
  ["app.js", /if \(running && \$\("ta"\)\.value\.trim\(\)\) \{ busySendTell\(\); return; \}/, "Enter:這條回覆完才能送出"],
  ["app.js", /if \(C && !csTitle && !running && !\(o && o\.force\)\)/, "眼前那條空著又閒著就用它"],
  ["app.js", /const live = running \? \[\.\.\.chatEl\(\)\.childNodes\] : \[\];/, "背景開的那條已在跑:即時那段接在歷史後面"],
  ["app.js", /b\.classList\.toggle\("is-stop", running\);/, "送出鈕"], ["app.js", /b\.classList\.toggle\("is-stopping", running && turnStopping\);/, "送出鈕"],
  ["app.js", /const queued = running && !!\(CS\.loaded && CS\.loaded\.queued\);/, "送出鈕:排隊中的停止 = 取消排隊"], ["app.js", /b\.dataset\.i18nAria = queued \? "tabs\.queueCancel" : running \? "ws\.stop" : "ws\.send";/, "送出鈕"], ["app.js", /if \(!running\) taWaitShow\(false\);/, "輸入框上方那行"],
  ["app.js", /if \(!running \|\| turnStopping\) return;/, "stopTurn"], ["app.js", /if \(!ok && !engineWait && running\)/, "stopTurn 沒送到"],
  ["app.js", /if \(\(!msg && !attachments\.length\) \|\| running\) return;/, "sendDraft"], ["app.js", /if \(\(!msg && !attachments\.length\) \|\| running\) return false;/, "submitMessage"],
  ["app.js", /running = true; turnSeqMine = turnSeq;/, "開跑"], ["app.js", /sugUnsend\(\); running = false;/, "沒送出去"], ["app.js", /^\s*running = false; turnStopping = false; turnUiSync\(\);/, "回合結束"],
  ["app.js", /if \(running === true\) \{ swHeld = \{ from, to \}; return; \}/, "切視角的系統行等這一輪結束"],
  ["app.js", /function canResend\(\) \{ return !running/, "重送"], ["app.js", /if \(running\) \{ busySendTell\(\); return; \}   \/\/ 卡上的鈕回合中照畫/, "錯誤卡的重送"],
  ["app.js", /st\.on = async \(\) => \{ if \(running\) \{ busySendTell\(\); return; \}/, "資料卡的重送"],
  ["app.js", /if \(running\) planDonePending = sessionId; else planSayDone\(\);/, "方案開好了那句不插進眼前這條的串流,記是哪一條"],
  ["app.js", /if \(ph\) withTab\(T, \(\) => \{ running = true; turnSeq\+\+; turnSeqMine = turnSeq;/, "開成分頁時主行程那邊已在跑(手機來的):記成回合中"],
  ["app.js", /const keep = running \? \{ busy, liveBubble,/, "畫歷史時那一條在跑:狀態列與串流泡泡留著"],
  ["chattabs.js", /withTab\(T, \(\) => \{ if \(!running\) \{ running = true; turnSeq\+\+; turnSeqMine = turnSeq; \} busyStart\(\); \}\);/, "started:不是這個畫面送出的那一輪也記成回合中"],
  ["app.js", /^let running = false;/, "宣告"],
  ["chattabs.js", /\["running", \(\) => running, \(v\) => \{ running = v; \}/, "TAB_KEYS"],
  ["chattabs.js", /function csAway\(\) \{ if \(csTitle \|\| running\)/, "從別處送一句話:眼前這條在跑就另開"],
  ["chattabs.js", /function csShowRunning\(\) \{ if \(running\) return;/, "查看:眼前這條在跑就看它"],
  ["chattabs.js", /const lone = order\.length === 1 && [^\n]*!running;/, "只有一條空的:列上不畫分頁"],
  ["chattabs.js", /const lone = CS\.order\.length <= 1 && !csTitle && !running;/, "⌘W 最後一個分頁"],
  ["chattabs.js", /\(T === CS\.loaded \? running : T\.st\.running\)/, "載入中那條讀全域、其他讀它自己那份(csAnyTurn／csTurnCount／csTabRunning／tabRun)"],
  ["chattabs.js", /const was = running;/, "withTab:這一條 running 翻面才重畫共用畫面"], ["chattabs.js", /const flipped = running !== was;/, "同上"],
  ["engine.js", /h\.sessionId === sessionId && running\)/, "安裝失敗留著的那句:那條在跑就只重裝"],
  ["suggest.js", /^\s*if \(running\) return;   \/\/ 停一拍之間又送出了一句/, "托盤:這條又送了一句"], ["suggest.js", /!SUG\.gone && !running && !composing/, "托盤在不在場(眼前這條)"],
];
const ANY = [   // 任何回合(機器層級的鎖;busyOn() = csAnyTurn())
  ["apikey.js", /const cut = cur === "apikey" && busyOn\(\);/, "移除自帶金鑰會中斷回合"],
  ["app.js", /if \(busyOn\(\)\) \{ busyCut\(null, \(\) => connectNow\(kind, info\)\); return; \}/, "換 AI"], ["app.js", /const lines = \(busyOn\(\) \? \[t\("busy\.cut\.out"\)\]/, "登出"],
  ["app.js", /if \(busyOn\(\)\) \{ busyCut\(b, \(\) => blaveGoNow\(b\)\); return; \}/, "換成 Blave AI"],
  ["app.js", /function upLocalTurn\(\) \{ try \{ return typeof csAnyTurn === "function" \? csAnyTurn\(\) : running === true;/, "更新會重開 app"],
  ["app.js", /busyLock\(d, csAnyTurn\(\)\)\); \}\); \}/, "刪策略"], ["app.js", /busyLock\(del, csAnyTurn\(\)\); del\.onBusy = \(\) => busyHit\("del"\);/, "刪策略"],
  ["app.js", /if \(csAnyTurn\(\)\) \{ rpcOwed = true; return; \}/, "雲端報告重抓等所有回合結束"],
  ["app.js", /turn: csAnyTurn\(\), onMetric:/, "成交測試"], ["app.js", /return \{ t, busy: csAnyTurn\(\), turn: turnSeq, scope:/, "參數掃描／樣本外驗證"],
  ["busy.js", /function busyOn\(\) \{ return typeof csAnyTurn === "function" \? csAnyTurn\(\) : typeof running !== "undefined" && running === true; \}/, "鎖本身"],
  ["busy.js", /if \(!busyOn\(\)\) \{ fn\(\); return; \}/, "停了再做"], ["busy.js", /if \(!busyOn\(\)\) \{ go\(\); return; \}/, "busyCut"], ["busy.js", /const on = busyOn\(\);/, "busySync"],
  ["chattabs.js", /if \(!csAnyTurn\(\)\) return;/, "回覆中的時長每秒進一格"], ["chattabs.js", /function csAnyTurn\(\) \{/, "定義"],
  ["intro.js", /running: \(typeof csAnyTurn === "function" \? csAnyTurn\(\) : typeof running !== "undefined" && running === true\)/, "第一次對話 modal 不在任何回合中彈"],
  ["library.js", /if \(!csAnyTurn\(\)\) LIB\.busyTold = null;/, "原因句"], ["perf.js", /const lock = csAnyTurn\(\);/, "更新績效"],
  ["reports.js", /if \(!csAnyTurn\(\)\) RPT\.busyTold = false;/, "原因句"], ["trade.js", /busyLock\(d, busyOn\(\)\); d\.onBusy = \(\) => busyHit\("del"\);/, "雲端刪策略"],
  ["versions.js", /const busy = csAnyTurn\(\);/, "還原／再跑一次改策略檔"], ["versions.js", /if \(!S\.data \|\| S\.open === null \|\| csAnyTurn\(\)\) return;/, "還原"],
  ["versions.js", /if \(!pd \|\| pd\.status !== "failed" \|\| csAnyTurn\(\)\) return false;/, "重試"],
];
const LOCAL = [   // 同名但不是回合狀態
  ["app.js", /function phasesPaint\(ol, rows, now, running\)|\[running, rows\.map|tm && running && r\.start|running && i === rows\.length - 1/, "phasesPaint 的參數"],
  ["portfolio.js", /running/, "跑回測的工作狀態(區域變數)"],
  ["trade.js", /function trCtErrKey\(err, running\)|return running \? "ct\.errUpdate"|running = hs === "running"|acts && running \?|trLiveOrderErrs\([^\n]*running, orders|function trCloseTag\(old, now, running, held\)|return running && old > 0/, "下單程式在跑(參數／區域變數)"],
];
const hits = [];
for (const f of fs.readdirSync(R).filter((n) => n.endsWith(".js") && n !== "strings.js").sort()) {
  strip(read(f)).split("\n").forEach((l, i) => {
    const s = l.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
    if (/(?<![.\w$])running\b(?!:)/.test(s) || /\bbusyOn\(|\bcsAnyTurn\(\)/.test(s)) hits.push({ f, n: i + 1, l: read(f).split("\n")[i] });
  });
}
const all = TAB.concat(ANY, LOCAL), used = new Set();
const miss = hits.filter((h) => { const e = all.find(([f, re]) => f === h.f && re.test(h.l)); if (e) used.add(e); return !e; });
ok("renderer 每一處讀「有沒有回合」都歸類(眼前這一條 / 任何回合 / 不是回合狀態)— 共 " + hits.length + " 處", miss.length === 0, miss.map((h) => h.f + ":" + h.n + "  " + h.l.trim().slice(0, 140)));
const unusedE = all.filter((e) => !used.has(e)).map(([f, , why]) => f + " " + why);
ok("清單上每一條都還對得到原文", unusedE.length === 0, unusedE);
ok("切換對話、開新對話、從別處送一句話不再上鎖:busy.js 沒有 switch／new／sendAway;sendAway 的入口全走 csSendAway",
  !/\b(switch|new|sendAway):/.test(read("busy.js").slice(read("busy.js").indexOf("const BUSY = {"), read("busy.js").indexOf("};"))) && !/if \(csTitle\) csStartNew\(\);/.test(fs.readdirSync(R).filter((n) => n.endsWith(".js")).map(read).join("\n"))
  && ["intro.js", "handoff.js", "capital.js", "export.js", "library.js", "pine-install.js", "newstrategy.js", "reports.js", "versions.js"].every((f) => /csSendAway\(/.test(read(f)) && !/\bsubmitMessage\(/.test(strip(read(f)))));

// ── 3. withTab 的換進換出 ──
{ const core = ct.slice(ct.indexOf("const CS = {"), ct.indexOf("/* ── 機器層級"));
  const sandbox = `let running = false, sessionId = null, csTitle = "", liveBubble = null, chatStick = true, chatTop = 0, busy = null, ACT = null, swLine = null, swHeld = null,
    turnStopping = false, turnStopped = false, engineWait = false, engineAbort = null, engineSeq = 0, lastUserTyped = false, lastUserNote = null, lastUserText = "", lastUserAttachments = [],
    faultShown = false, acctCard = null, creditCards = [], dataCard = null, draft = "", turnFail = null, turnFailSrc = null, turnModel = null, turnGotReply = false, turnErrored = false,
    turnFaulted = false, turnLimit = false, turnChanged = false, turnCap = false, turnBubble = null, turnHadTool = false, turnCards = [], pendingErr = [], turnAiBubbles = [], turnFaultEl = null, turnSeqMine = 0,
    SUG = {}; const UPD = {}, XP = {}, RES = {}, RPT = {}, BR = { blocks: [], cur: null }, synced = [];
    const document = { createElement: () => ({ hidden: false, className: "" }) }, $ = () => ({ appendChild() {} });
    function turnUiSync() { if (CS.bg) { CS.dirtyUi = true; return; } synced.push(sessionId); }
    ${core}
    ${ct.slice(ct.indexOf("function csAnyTurn() {"), ct.indexOf("function csTurnCount()"))}
    return { CS, withTab, tabBound, tabMake, tabLoad, tabSave, csAnyTurn, synced, get: () => ({ running, sessionId, liveBubble }), set: (o) => { if ("running" in o) running = o.running; if ("liveBubble" in o) liveBubble = o.liveBubble; } };`;
  const X = new Function(sandbox)();
  const A = X.tabMake("desktop-aaaa1111"), B = X.tabMake("desktop-bbbb2222");
  X.CS.cur = A; X.tabLoad(A); X.CS.order = [A.sid, B.sid];
  X.set({ liveBubble: "A-bubble" });
  const inB = X.withTab(B, () => { const s = X.get(); X.set({ running: true, liveBubble: "B-bubble" }); return s; });
  ok("withTab:背景那條換進來時全域是它那份(sid、bubble 沒有沾到眼前那條)", inB.sessionId === B.sid && inB.liveBubble === null && X.CS.bg === false);
  ok("…換回後眼前那條原封不動,背景那條改的存回它自己那份", X.get().sessionId === A.sid && X.get().liveBubble === "A-bubble" && B.st.liveBubble === "B-bubble" && B.st.running === true);
  ok("…背景那條 running 翻面:共用畫面照眼前那條重畫一次", X.synced.length === 1 && X.synced[0] === A.sid);
  X.synced.length = 0; X.withTab(B, () => { X.set({ liveBubble: "B2" }); });
  ok("…沒翻面(背景每秒的計時器):不重畫共用畫面", X.synced.length === 0);
  ok("csAnyTurn:看每一條(背景在跑也算),載入中那條讀全域", X.csAnyTurn() === true && (X.set({ running: false }), X.csAnyTurn()) === true && X.withTab(B, () => X.csAnyTurn()) === true);
  const nested = X.withTab(B, () => X.withTab(A, () => X.get().sessionId) + "|" + X.get().sessionId);
  ok("巢狀:B 裡面再換 A 再換回 B", nested === A.sid + "|" + B.sid && X.get().sessionId === A.sid);
  let fired = null; const cb = X.withTab(B, () => X.tabBound(() => { fired = X.get().sessionId; }));
  cb();
  ok("tabBound:延後才跑的 callback 換回當時那條(B),不是跑的那一刻眼前那條(A)", fired === B.sid && X.get().sessionId === A.sid);
  B.dead = true; fired = null; cb();
  ok("…那條已關掉收掉:不跑", fired === null);
}
ok("事件照 sid 找分頁:turn-event／turn-end／瀏覽器事件都經 withTab;沒開著的只記清單狀態", /function tabsOnEvent\(c\) \{[\s\S]*?withTab\(T, \(\) => turnEventIn\(c\)\);/.test(ct) && /window\.blave\.onTurnEvent\(tabsOnEvent\);/.test(ct)
  && /const pre = withTab\(T, \(\) => turnEndPre\(r\)\);[\s\S]*?await window\.blave\.detectAgents\(\)[\s\S]*?withTab\(T, \(\) => turnEndPost\(r, pre, d\)\)/.test(ct)
  && /onBrowserEvent\(\(ev\) => \{ const T = [^\n]*CS\.tabs\.get\(ev\.session_id\)[^\n]*withTab\(T, \(\) => brOnEvent\(ev\)\)/.test(read("browser.js")));
ok("submitMessage:進門抓住分頁,每一個 await 之後都換回它再動(ensureEngine／engineState／附件兩層／sendMessage;多一個 await 就紅,要補 inT)",
  /const T = CS\.loaded, inT = \(fn\) => withTab\(T, fn\);/.test(app) && (strip(app.slice(app.indexOf("async function submitMessage("), app.indexOf("/* ── A′ 的標示"))).match(/\bawait /g) || []).length === 5
  && /const step1 = inT\(/.test(app) && /return inT\(\(\) => \{\n\s*if \(es && typeof engOnState/.test(app) && /const r = await window\.blave\.sendMessage\(payload\);\n\s*return inT\(/.test(app));
ok("延後才跑的回合計時器都捕住分頁:狀態列每秒、動詞停留、當下動作、托盤停一拍",
  /busy\.timer = setInterval\(tabBound\(/.test(app) && /ACT\.timer = setTimeout\(tabBound\(/.test(app) && /b\.subTimer = setTimeout\(tabBound\(subApply\)/.test(app) && /SUG\.timer = setTimeout\(tabBound\(/.test(read("suggest.js"))
  && /stratRefresh\(true\)\.catch\(\(\) => \{\}\)\.then\(tabBound\(/.test(app));
ok("共用畫面背景期間不畫:捲動、讀屏、送出鈕、托盤;輸入框的字放回那個分頁自己的草稿", /if \(tabBg\(\)\) return;   \/\/ 背景分頁的事件:捲動容器/.test(app) && /function srSay\(text\) \{ if \(tabBg\(\)\) return;/.test(app)
  && /if \(tabBg\(\)\) \{ CS\.dirtyUi = true; return; \}   \/\/ 送出鈕/.test(app) && /function sugPaint\(\) \{\n  if \(typeof tabBg === "function" && tabBg\(\)\) return;/.test(read("suggest.js")) && /if \(tabBg\(\)\) \{   \/\/ 背景分頁:輸入框是眼前那條的/.test(app));
// 設計稽核(v037-tabs-design-audit)P2 的落點
{ const css = read("app.css");
  ok("tick 建元素就帶目前那一格(重畫不閃);減少動態固定第 3 格亮;排隊是 8×2 短劃不是 tick", /const tabsTickK = \(\) => \(reducedMotion\(\) \? "2" : String\(tabsK\)\);/.test(ct) && /k\.className = "tab-ticks"; k\.dataset\.k = tabsTickK\(\);/.test(ct)
    && /d\.className = "tab-dash";/.test(ct) && !/is-queued/.test(ct + css) && css.includes(".tab-dash { display: block; width: 8px; height: 2px; background: var(--ink-3); }"));
  ok("tick 間距 4、亮格 ink、暗格 .2", css.includes(".tab-ticks { display: flex; gap: var(--space-4); align-items: center; }") && /\.tab-ticks i \{[^}]*background: var\(--ink\); opacity: \.2; \}/.test(css));
  ok("+N:有一條真的在跑才放 tick,全是排隊放短劃", /sts\.includes\("run"\) \? tabsLead\("run"\) : run \? tabsLead\("queued"\) : null/.test(ct));
  ok("歷史搜尋格的焦點是灰階框(不吃系統強調色)", css.includes(".cs-search:focus { outline: none; border-color: var(--ink); }"));
  ok("歷史列:等你回覆／沒做完／做完還沒看接「· 時間」(mono)", /if \(st\.kind !== "run" && st\.kind !== "queued"\) \{ item\.classList\.add\("is-attn"\); const at = document\.createElement\("span"\); at\.className = "mono"; at\.textContent = csTime\(m\.last\); meta\.append\(" · ", at\); \}/.test(app));
  ok("分頁名稱(讀屏)不帶會凍住的時長;tooltip 每秒跟著跳、Esc 隨時收得掉、離分頁 6px;× 熱區 28×44", /const word = st === "run" \? t\("tabs\.st\.running"\) : tabsStateWord\(T, st\);/.test(ct) && /tabsTipTick\(\);\n\}, 1000\);/.test(ct)
    && /window\.addEventListener\("keydown", \(e\) => \{\n  if \(e\.key !== "Escape" \|\| e\.isComposing \|\| e\.keyCode === 229\) return;\n  const tip = \$\("tabs-tip"\); if \(!tip \|\| tip\.hidden\) return;\n  tip\.hidden = true; tip\.dataset\.off = "1"; e\.preventDefault\(\); e\.stopPropagation\(\);\n\}, true\);/.test(ct) && css.includes(".tabs-tip { top: 48px;") && /\.cs-tabs \{[^}]*height: 44px;[^}]*align-items: center;/.test(css) && css.includes("inset: -12px -4px;"));
}
// 程式稽核 s2 P3
ok("+N 選單開著:每秒只換時長字,不重建(焦點不掉);整列重建時照 sid 把焦點還回分頁或選單列", /if \(!\$\("cs-menu"\)\.hidden\) tabsMenuTick\(\);/.test(ct) && /function tabsMenuTick\(\) \{/.test(ct)
  && /it\.dataset\.sid = sid;/.test(ct) && /function tabsPaint\(\) \{[\s\S]{0,900}try \{ tabsPaintIn\(bar\); \}\n  finally \{\n    if \(fSid\)/.test(ct));
ok("結果卡:那一輪的分頁還開著就到它的容器裡找落點(背景分頁沒有回覆文字的那一輪也出卡)", /const T = typeof CS !== "undefined" && rt\.sid \? CS\.tabs\.get\(rt\.sid\) : null;\n  if \(T && T\.el\) return withTab\(T, \(\) => resHostIn\(rt\)\);/.test(read("results.js")));
ok("送出第一句就存分頁記憶", /csRemember\(\); if \(CS\.loaded\) CS\.loaded\.title = csTitle; tabsSave\(\); \}/.test(app));
ok("queue_cancel 只由主行程記一次;排隊中按停止畫面不記", /if \(!\(T && T\.queued\)\) trackFeature\("chat_stop"\);/.test(app) && !/trackFeature\("queue_cancel"\)/.test(fs.readdirSync(R).filter((n) => n.endsWith(".js")).map(read).join("\n")));
// 整合稽核 P3:分頁 tooltip 開著按 Esc 只收 tooltip,不讓 app.js escTop(document 冒泡)再關一層;沒開不攔。
// 把 chattabs.js 那一支監聽原樣拿出來,掛到假的 window／document,照真的順序派送(window capture → document → window 冒泡,stopPropagation 就停)
{ const m = ct.match(/\/\/ Esc 收 tooltip[^\n]*\n([\s\S]*?)\n\$\("cs-more"\)/);
  const run = (shown) => {
    const L = [], reg = (node) => (type, fn, cap) => L.push({ node, type, fn, cap: cap === true || !!(cap && cap.capture) });
    const tip = { hidden: !shown, dataset: {} }; let escTop = 0;
    L.push({ node: "document", type: "keydown", cap: false, fn: (e) => { if (e.key === "Escape") { escTop++; e.preventDefault(); } } });
    new Function("window", "document", "$", m ? m[1] : "")({ addEventListener: reg("window") }, { addEventListener: reg("document") }, (id) => (id === "tabs-tip" ? tip : null));
    let stop = false; const e = { key: "Escape", keyCode: 27, isComposing: false, preventDefault() {}, stopPropagation() { stop = true; } };
    for (const [node, cap] of [["window", true], ["document", true], ["document", false], ["window", false]]) {
      for (const x of L) if (!stop && x.node === node && x.cap === cap && x.type === "keydown") x.fn(e);
      if (stop) break;
    }
    return { tipHidden: tip.hidden, escTop };
  };
  const a = m && run(true), b = m && run(false);
  ok("分頁 tooltip 開著:Esc 只收 tooltip、escTop 收不到這一下;沒開時 Esc 照給 escTop", !!m && a.tipHidden && a.escTop === 0 && b.escTop === 1, { a, b });
}
// ── 分頁列蓋在 52px 拖曳條(.ws-bar,drag)底下:只有 button/textarea/input/a 有全域 no-drag,其他可點的元素自己要帶,
//    否則打包版點下去變成拖視窗(開發版看不出來;開窗段測不到 drag region,只能靜態查)。
//    列舉:#cs-head 裡的靜態元素 + chattabs.js 每個函式裡 createElement 出來、掛了 click／auxclick／mousedown 的元素
{ const css = read("app.css"), html = read("index.html"), js = ["chattabs.js", "app.js"].map(read).join("\n");
  const NATIVE = new Set(["button", "textarea", "input", "a"]);
  const noDrag = [];
  for (const m of css.matchAll(/([^{}]+)\{[^}]*-webkit-app-region: no-drag/g)) for (const sel of m[1].replace(/\/\*[\s\S]*?\*\//g, "").split(",")) noDrag.push(sel.trim().split(/\s+/).pop());
  const covered = (cls) => noDrag.includes("." + cls);
  const clickable = [];
  const head = html.slice(html.indexOf('<div class="chat-head" id="cs-head">'), html.indexOf('id="tabs-tip"'));
  for (const m of head.matchAll(/<(\w+) class="([^"]+)"(?: id="([\w-]+)")?/g)) {
    const [, tag, cls, id] = m;
    if (id && new RegExp('\\$\\("' + id + '"\\)\\.addEventListener\\("(click|auxclick|mousedown)"').test(js)) clickable.push({ where: "index.html#" + id, tag, cls: cls.split(" ")[0] });
  }
  for (const fn of ct.split(/\nfunction /)) {
    const made = {};
    for (const m of fn.matchAll(/(?:const|let) (\w+) = document\.createElement\("(\w+)"\); \1\.className = "([\w-]+)/g)) made[m[1]] = { tag: m[2], cls: m[3] };
    for (const m of fn.matchAll(/\b(\w+)\.addEventListener\("(click|auxclick|mousedown)"/g)) if (made[m[1]]) clickable.push({ where: "chattabs.js " + fn.slice(0, fn.indexOf("(")), ...made[m[1]] });
  }
  const bad = clickable.filter((c) => !NATIVE.has(c.tag) && !covered(c.cls));
  ok("列舉到分頁列的可點元素(分頁、×、☰ 提示、+N、新對話都在)", ["tab", "tab-x", "cs-hint", "cs-more", "cs-btn"].every((c) => clickable.some((x) => x.cls === c)), clickable);
  ok("分頁列裡不是 button/textarea/input/a 的可點元素都帶 no-drag(不然打包版點不動)", bad.length === 0, bad);
  ok("分頁與 × 的熱區(::before)帶 no-drag;+N 選單整塊也是", covered("tab") && covered("tab-x") && noDrag.includes(".tab-x::before") && covered("cs-menu"));
}
console.log(red ? `\n${red} 紅` : "\nALL PASS");
process.exit(red ? 1 : 0);
