/* 「送上雲端 / 拉回這台電腦」(設計:blave-canon output/designer/spec-desktop-cloud-handoff-buttons.md;0.1.47 起
   output/backend/strategy-transfer-desktop-spec-2026-11-05.md)。
   互動 = 按鈕(頁首、側欄列選單、對話動作卡)→ 確認框(confirmBox:.cf-*;目的地同名一律改存新名字、不擋不覆蓋)→ 按「確認」由 app 直接搬:
   主行程送 strategy_import／strategy_export(shell/transfer.js),不經 agent、不切到聊天、不碰輸入框裡的草稿。
   進度與結果寫在策略頁說明下一行(#rp-ho-note),跟著來源那一支(HO.jobs);完成後兩邊數字並排(hoCompare)。
   - **功能預設關**(主行程的 CLOUD_HANDOFF;先修 sshd 才上線):HO.on 是 false 時兩顆鈕都不畫、整個檔等於不存在。
   - 送給 agent 的那句話裡只放**策略資料夾名**,而且要過 HO_ID_RE:不放顯示名稱——那是 workspace / 雲端回報裡的自由文字,
     放進「用戶說的話」等於讓不可信內容冒充用戶指令(用戶在確認框裡看不到這句全文)。不符合的策略,鈕不畫。
   用到 app.js 的 $ / t / confirmBox / RP / RPC / stratSelect / rpCloudSelect / stratRefresh / turnAiBubbles / sessionId、trade.js 的 ENV / TR_BAGS / env* / trSendError——都在呼叫時才取。 */
// pending = { id }:未登入 / 沒主機時按過「送上雲端」的那一支。jobs = 直接搬的進度,key "dir:id"(來源那一支);cards = 對話動作卡,key 對話 id。
// 三個都只在記憶體,重開 app 就沒了
const HO = { on: false, pending: null, jobs: new Map(), cards: new Map() };
// 名字閘門 = shell/transfer.js NAME_RE = runtime strategy_transfer.NAME_RE(含 Windows 保留名;tests/check_transfer_parity.py 用同一批名字比三邊)
const HO_ID_RE = /^(?!(?:[cC][oO][nN]|[pP][rR][nN]|[aA][uU][xX]|[nN][uU][lL]|[cC][oO][mM][0-9]|[lL][pP][tT][0-9])(?:\.|$))[A-Za-z0-9_-]{1,64}$/;
const HO_ICONS = { up: ["M12 13v8", "M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242", "m8 17 4-4 4 4"], down: ["M12 13v8l-4-4", "m12 21 4-4", "M4.393 15.269A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.436 8.284"] };

/* ── 純邏輯(tests/check_shell_handoff_msg.js 從原文切出來跑;這一段不准碰 DOM)── */
/* 「會搬」那一列講哪一句。回 i18n key 與代入值。三種:
     up  + 掃到來源 → 講金鑰,並列出是哪幾個(主行程掃資料夾內所有 .py,同 references/cloud-handoff.md §5 的 grep 範圍;shell/transfer.js 照這份送)
     up  + 沒掃到   → 只講程式碼(這支確定用不到)
     down          → 只講程式碼:0.1.47 起由 app 直接拉回,第一版不搬金鑰(「不會搬」那一列講資料來源金鑰) */
function hoMovesRow(dir, data) {
  if (dir !== "up") return ["ho.row.movesV", null];
  const list = (k) => (Array.isArray(data && data[k]) ? data[k].filter((x) => typeof x === "string" && x) : []);
  const miss = list("missingSources"), srcs = list("dataSources").filter((x) => miss.indexOf(x) < 0);
  return srcs.length ? ["ho.row.movesKeys", { sources: srcs.join(LANG === "zh" ? "、" : ", ") }] : ["ho.row.movesV", null];
}
// 「不會搬」那一列:這台電腦沒有的金鑰(missingSources;transfer.js 送出時會歸到 missing)列在這裡,不說它會搬
function hoStaysRow(dir, data) {
  if (dir !== "up") return ["ho.row.staysVDown", null];
  const miss = Array.isArray(data && data.missingSources) ? data.missingSources.filter((x) => typeof x === "string" && x) : [];
  return miss.length ? ["ho.row.staysVMissing", { sources: miss.join(LANG === "zh" ? "、" : ", ") }] : ["ho.row.staysV", null];
}
/* 目的地同名時提議的新名字:第一個沒被占的 <id>_2、_3…;超過 64 字就從右邊截 <id>(規則同 references/cloud-handoff.md step 4a 的 free)。
   taken(name) = 目的地有沒有這個名字。壞 id 回 null */
function hoFreeName(id, taken) {
  if (typeof id !== "string" || !HO_ID_RE.test(id)) return null;
  for (let k = 2; k < 10000; k++) { const sfx = "_" + k, n = id.slice(0, 64 - sfx.length) + sfx; if (!taken(n)) return n; }
  return null;
}
/* 策略頁頭的動作槽(spec strategy-page-autotrade §4):「狀態 → 鈕態」常數表,web 工作頁照同一張表做(cross-surface-parity 規則三)。
   btn = 主鈕 { key, kind: 填色 fill／描邊 out, act, off: 真 disabled }:key "$base" = 看市場(加密、台指期「自動下單」,台股「加到策略組合」),
   "$go" = 自動下單頁 #tr-go 同一個鈕字(trGoView:啟動下單／確認帳戶…);word = 鈕旁 ≤6 字的狀態詞;note = 說明下一行的整句原因;
   mark = 只放「自動下單中・模擬／真錢」記號。態的名字與 web 工作頁 workspace.html 的 SP_HEAD 同一份(tests/check_web_desktop_parity.js 逐態比對)。act:amt 開金額框、pick 到選擇策略框、cx 開連接框、go 走 trGoClick、route 〔儲存〕直送、po 到策略組合、pres 統一的〔繼續〕 */
const SP_HEAD = {
  none: { btn: null },
  us: { btn: null, word: "tr.mkt.noAuto" },
  unread: { btn: { key: "$base", kind: "fill", act: null, off: true } },
  fail: { btn: { key: "$base", kind: "fill", act: null, off: true }, note: "$fail" },
  locked: { btn: { key: "$base", kind: "fill", act: "pick" } },
  add: { btn: { key: "$base", kind: "fill", act: "amt" } },
  setup: { btn: { key: "cap.continue", kind: "fill", act: "pres" }, word: "cap.pending" },
  setupWait: { btn: null, word: "cap.pending" },
  connecting: { btn: { key: "sp.connecting", kind: "fill", act: null, off: true } },
  noAcct: { btn: { key: "sp.cx", kind: "fill", act: "cx" }, word: "sp.noAcct" },
  twNoAcct: { btn: { key: "po.addGo", kind: "out", act: "po" } },
  unsaved: { btn: { key: "po.addGo", kind: "out", act: "po" }, note: "sp.unsaved" },
  route: { btn: { key: "tr.save", kind: "fill", act: "route" }, note: "tr.routeSave" },
  off: { btn: { key: "$go", kind: "fill", act: null, off: true }, note: "$off" },
  running: { btn: null, mark: true },
  acct: { btn: { key: "tr.acct.btn", kind: "fill", act: "go" } },
  start: { btn: { key: "$go", kind: "fill", act: "go" }, note: "$go" },
};
/* §4 的優先序(同時命中取前者):沒回測／Type B → 美股 → 讀不到 → 金鑰被拒(fail)→ 鎖住 → 沒配(含統一開通中沒配)→ 統一開通中已配 → 連接中 → 讀帳失敗(fail)→
   沒接帳戶 → 有帳戶沒路由 → 綁的那家下不了 → 在跑 → 已連接・尚未啟動／暫停中。重綁後 halted＋路由空落「沒路由」(HALT 那列要路由齊);
   setup＋路由空落統一那列(〔繼續〕才是出口)。x 全是算好的值(portfolio.js spCtx),這裡不碰 DOM、不讀全域 */
function spHead(x) {
  const st = x.noBt || x.typeB ? "none" : x.market === "us" ? "us" : x.unread ? "unread" : x.failKey ? "fail" : x.locked && !x.configured ? "locked"
    : !x.configured ? "add" : x.setup ? (x.presContinue ? "setup" : "setupWait") : x.connecting ? "connecting" : x.failRead ? "fail"
    : !x.hasAcct ? (x.market === "tw" ? "twNoAcct" : "noAcct") : x.routeDirty ? (x.unsaved ? "unsaved" : "route")
    : x.zvOff ? "off" : x.firing ? "running" : x.goKey === "tr.acct.btn" ? "acct" : "start";
  const d = SP_HEAD[st], b = d.btn ? Object.assign({}, d.btn) : null;
  if (b && b.key === "$base") b.key = x.market === "tw" ? "po.add" : "sp.btn";
  if (b && b.key === "$go") b.key = x.goKey || "tr.start";
  if (b && (st === "start" || st === "acct") && x.goOff) b.off = true;   // 指令通道不通(同 #tr-go 的 usable)
  const note = d.note === "$fail" ? x.failNote || null : d.note === "$off" ? x.offNote || null : d.note === "$go" ? x.goNote || null : d.note ? { key: d.note } : null;
  return { st, btn: b, word: d.word || null, note, mark: !!d.mark };
}
/* 並排比較的狀態(references/cloud-handoff.md §7 的機械規則,不經 agent):src／dst = 兩邊的 stats(回測結果)。
   match = Trades、start、end 都相同;differs = 有一個不同(period:start 或 end 不同,要先講);none = 目的地沒有新的回測;
   nosrc = 來源沒有回測,只填目的地那欄、不判狀態 */
function hoCompare(src, dst) {
  if (!dst || typeof dst !== "object") return { state: "none", period: false };
  if (!src || typeof src !== "object") return { state: "nosrc", period: false };
  const same = (k) => String(src[k]) === String(dst[k]);
  const period = !same("start") || !same("end");
  return { state: !period && same("Trades") ? "match" : "differs", period };
}
const HO_CMP_ROWS = [["ho.cmp.ret", "Total Return [%]"], ["ho.cmp.sharpe", "Sharpe Ratio"], ["ho.cmp.mdd", "Max Drawdown [%]"], ["ho.cmp.trades", "Trades"], ["ho.cmp.start", "start"], ["ho.cmp.end", "end"]];
// 數字照讀到的寫:小數兩位、負號 U+2212、百分比帶 + 與 %、缺值「—」;日期與次數原樣
function hoCell(k, v) {
  if (v == null || v === "" || (typeof v === "number" && !isFinite(v))) return "—";
  if (typeof v !== "number") return String(v).slice(0, 24);
  if (k === "Trades") return String(Math.round(v));
  const pct = /\[%\]$/.test(k), s = Math.abs(v).toFixed(2) + (pct ? "%" : "");
  return (v < 0 ? "\u2212" : pct && v > 0 ? "+" : "") + s;   // 同回測數據:百分比帶正負號與 %
}
/* 機器／主行程的拒絕 → { key, vars }(字串表的 key)。r = transferUp／transferDown 的回應:
   kind "local" = 這台電腦讀檔就擋下(代碼在 error、檔名在 detail);"rejected" = 機器的 ack "<例外類別>: <CODE>: <detail>"
   (runtime _run_deferred／local_daemon 都是 f"{type(e).__name__}: {e}",搬家的拒絕類別是 strategy_transfer.Refused);
   "unknown" = 送出了沒收到回條;"undelivered" = 沒送出去,畫面走 trSendError(key "$send")。detail 只會是檔名或模組名 */
const HO_REFUSE = { NOT_PORTABLE: "ho.err.portable", NAME_MISMATCH: "ho.err.name", NO_STRATEGY_NAME: "ho.err.nameOnce", TOO_LARGE: "ho.err.files",
  BAD_FILES: "ho.err.files", NOT_UTF8: "ho.err.files", NO_SOURCE: "ho.err.noSource" };
/* NO_STRATEGY_NAME 的 detail = "<why>: <檔名, 檔名>"(runtime strategy_transfer.check_name):依原因各一句,{x} 只放檔名。
   1.1.159 以前的雲端 runtime 送英文句子:照它的字樣歸到同三類、檔名從括號或句尾取 */
const HO_NAME_WHY = { helpers: "ho.err.nameOnce", wildcard: "ho.err.nameStar", literal: "ho.err.nameLiteral" };
function hoNameWhy(detail) {
  const m = /^(helpers|wildcard|literal):\s*([\s\S]*)$/.exec(detail);
  if (m) return { key: HO_NAME_WHY[m[1]], x: m[2] };
  const old = /also (?:found|set) in (.+)$/.exec(detail), star = /^`import \*`[^(]*\(([^)]*)\)/.exec(detail);
  if (old) return { key: "ho.err.nameOnce", x: old[1] };
  if (star) return { key: "ho.err.nameStar", x: star[1] };
  return { key: "ho.err.nameLiteral", x: "strategy.py" };
}
function hoErr(r) {
  if (!r || typeof r !== "object") return { key: "ho.err.retry" };
  const e = String(r.error || "");
  if (r.kind === "unknown") return { key: "ho.err.unknown" };
  if (e === "UNKNOWN_COMMAND" || e === "BAD_COMMAND" || /unknown command/i.test(e)) return { key: "ho.err.old" };
  const m = /^(?:[A-Za-z]\w*:\s*)?([A-Z_]{3,24}):\s*([\s\S]*)$/.exec(e);
  const code = r.kind === "local" ? e : m ? m[1] : null, detail = r.kind === "local" ? String(r.detail || "") : m ? m[2] : "";
  if (code === "NO_STRATEGY_NAME") { const w = hoNameWhy(detail.replace(/[\r\n]+/g, " ")); return { key: w.key, vars: { x: w.x.slice(0, 80) } }; }
  if (code && HO_REFUSE[code]) return { key: HO_REFUSE[code], vars: { x: detail.replace(/[\r\n]+/g, " ").slice(0, 80) } };
  if (r.kind === "undelivered") return { key: "$send" };
  return { key: "ho.err.retry" };
}
/* ── 純邏輯到此 ── */

/* Type B(警示、選股、網格…)沒有回測:搬過去之後是「確認它跑得起來」(會下單的不試跑、只檢查),確認框與送出去的那句都不提回測(e2e 0.1.8:框寫「重跑一次回測」、
   agent 回「Type B 不做搬移」)。判別跟轉出選單、程式碼分頁同一支(export.js xpIsTypeB:檔頭 `# Type: B`);回 "B" 或 ""(字串 key 的一段) */
function hoKind(d) {
  return typeof xpIsTypeB === "function" && xpIsTypeB(d) ? "B" : "";
}
const HO_NOTE = { "": ["ho.note.up", "ho.note.down"], B: ["ho.noteB.up", "ho.noteB.down"] };
function hoIcon(dir) {
  const NS = "http://www.w3.org/2000/svg", svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "ic"); svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
  for (const d of HO_ICONS[dir]) { const p = document.createElementNS(NS, "path"); p.setAttribute("d", d); svg.appendChild(p); }
  return svg;
}
// 雲端那一邊「看得到現況而且在運行」:送上雲端要它、拉回那顆鈕也要它(讀不到 / 逾 1 小時沒同步就不畫)
function hoCloudLive() { const st = TR_BAGS.cloud.st; return envCloudKind(st) === "running" && envHeadState(st, Date.now()) !== "unknown"; }

/* agent 正在回覆時頁首那顆是 aria-disabled(不是原生 disabled:鍵盤停得上去、讀屏唸得到原因)。app.js 在上鎖 / 解鎖的同一處叫它 */
function hoBusy() {
  const busy = false;   // 0.1.37 起不因回合上鎖;0.1.47 起由 app 直接搬,跟對話無關
  document.querySelectorAll("#rp-ho").forEach((b) => {
    if (busy) { b.setAttribute("aria-disabled", "true"); b.dataset.title = b.dataset.title || b.title || ""; b.title = t("turn.busy"); }
    else { b.removeAttribute("aria-disabled"); if (b.dataset.title !== undefined) { b.title = b.dataset.title; delete b.dataset.title; } }
  });
}
// 有程式碼就能搬(Wei 09-22:不要求回測過——搬過去之後 agent 會在那邊重跑一次回測)
function hoHasCode(d) { return !!(d && typeof d.code === "string" && d.code.trim()); }
/* 策略報告頁首右側那一顆(spec-desktop-cloud-strategy-row-delete-pullback §4):
   這台電腦那支 =「送上雲端」(up);雲端那支 =「拉回這台電腦」(down,同一個位置、同一個 id,data-dir 分方向)。
   功能關、沒有程式碼、資料夾名不合規 → 不畫(.act 整個藏起來,頁首高度由 .txt 決定、不跳)。
   拉回另外要雲端看得到現況而且在運行(讀不到 / 逾 1 小時沒同步就不畫)。 */
function hoPaint() {
  const act = $("rp-act"); if (!act) return;
  hoNote(null);                                       // 換了策略 / 重畫頁首 → 上一次那句「送不上去」不留在新的那一頁
  const cloud = ENV.cur === "cloud";
  const B = cloud ? RPC : RP, dir = cloud ? "down" : "up";
  const show = HO.on && !!B.name && HO_ID_RE.test(B.name) && hoHasCode(B.data) && (!cloud || hoCloudLive());
  // 策略頁頭的主鈕／狀態詞／記號(renderer/portfolio.js spView,spec strategy-page-autotrade §4)跟這顆同一排、不受 cloudHandoff 旗標管
  const sv = typeof spView === "function" ? spView(cloud) : null;
  // 時光機裡、還原後重跑中不畫:作用在現在那份檔,不是正在看的那一版 / 還沒跑完的那一版(renderer/versions.js)
  const verHide = typeof verHidesAct === "function" && verHidesAct();
  const has = show || !!(sv && (sv.btn || sv.word || sv.mark));
  // 重畫時焦點留在原來那顆(同一個 id 就地換字);那顆不在了交給策略名,不掉到 BODY。#rp-go／#rp-ho 節點沿用:確認框關掉要還焦點給它
  const had = act.contains(document.activeElement) ? document.activeElement.id : null, ho0 = $("rp-ho");
  const keep = { go: $("rp-go"), ho: ho0 && ho0.dataset.dir === dir ? ho0 : null };   // 換了視角(雲朵 icon ↔「拉回」文字鈕)就重建,不沿用另一種的節點
  act.hidden = !has || verHide; act.textContent = "";
  if (typeof spPaintNote === "function") spPaintNote(act.hidden ? null : sv && sv.note);
  // 搬家那一行最後畫:那一格的優先序是搬家 ＞ 主鈕原因句(spPaintNote 剛寫的)＞ 停機句
  if (act.hidden) { hoJobPaint(); if (had) $("rp-name").focus(); return; }
  if (sv && typeof spPaintAct === "function") spPaintAct(act, sv, keep.go);
  if (show) {
    // 這台電腦這邊是無底的雲朵 icon 鈕(spec §4 icon 鈕:只有「送上雲端」一態),tooltip 跟 aria-label 同字;雲端那邊的「拉回這台電腦」維持文字鈕
    const b = keep.ho || document.createElement("button"); b.type = "button"; b.id = "rp-ho"; b.dataset.dir = dir; b.dataset.id = B.name; b.textContent = "";
    if (!keep.ho) b.addEventListener("click", () => { if (b.dataset.dir === "up") trackFeature("sp_cloud_icon"); hoAsk(b.dataset.dir, b.dataset.id, b); });
    if (cloud) {
      b.className = "btn-out has-ic"; const l = document.createElement("span"); l.textContent = t("ho.down.btn"); b.append(hoIcon(dir), l);
      const full = t("ho.down.aria") + (LANG === "zh" ? "：" : ": ") + hoLabel(B.name, envCloudList(TR_BAGS.cloud.st)); b.title = full; b.setAttribute("aria-label", full); b.removeAttribute("aria-describedby");
      act.appendChild(b);
    } else {
      b.className = "rp-ic"; b.title = ""; b.setAttribute("aria-label", t("ho.up.btn")); b.setAttribute("aria-describedby", "rp-ho-tip"); b.appendChild(hoIcon(dir));
      const w = document.createElement("span"); w.className = "rp-icw";
      const tip = document.createElement("span"); tip.className = "tip"; tip.id = "rp-ho-tip"; tip.setAttribute("role", "tooltip"); tip.textContent = t("ho.up.btn");
      w.append(b, tip); act.appendChild(w);
    }
    hoBusy();
  }
  hoJobPaint();
  if (had) { const n = $(had); if (n && act.contains(n) && !n.disabled) n.focus(); else $("rp-name").focus(); }
}

/* 還在等著送上雲端的那一支(雲端中欄的「準備好了」卡與它的 gate 都要它)。回 id 或 null。
   **不可以再讀 RP.name**(承重牆,規格 §2):人在雲端等的時候本機那一邊會自己動——選中的那支被刪掉
   stratRefresh 會 stratSelect(null)、人切回來也可能改選別支,RP.name 就換人了。在這裡判等於偶發地把卡拆掉。
   「那支還在不在」改到按主鈕那一刻才判(hoBack)。 */
function hoPendingId() { return HO.on && HO.pending ? HO.pending.id : null; }
/* 「準備好了」卡的主鈕:把人送回這台電腦那顆「送上雲端」。
   不自動切視角、不自動開框——這是一顆人按的文字鈕(規格 §1.4-1 的「畫面上的文字鈕」)。
   回合進行中不擋:切視角本來就可以(§1.4-5),而 #rp-ho 那顆自己是 aria-disabled + turn.busy。 */
async function hoBack(id) {
  if (!envCanSwitch()) return;                                         // 守門同切換器那一份:組字中切過去會把組到一半的字丟掉
  const has = typeof RP !== "undefined" && RP.list.some((x) => x.name === id);
  envSwitch("local", "link");                                          // 它自己會清掉 pending
  // 在雲端等的時候被刪了:只切視角、不報錯(清單上沒有那一列,人自己看得到)。焦點照一般文字鈕給中欄標題——
  // envSwitch 的 head() 只認 #tr-h / #cv-h,中欄是策略報告頁時兩顆都藏著、誰都不 focus,所以這裡自己給
  if (!has) { const h = $("rp-name"); if (h && h.offsetParent) h.focus(); return; }
  if (RP.name !== id) await stratSelect(id);                           // 鈕上寫的是「把 {id} 送上來」,就要落在 {id},不是碰巧選中的別支
  const up = $("rp-ho"); if (up && up.offsetParent) up.focus();        // 焦點給那顆鈕本人(不是中欄標題):按 Enter 就開框。切完、選完才取:那幾輪重畫會換掉節點
}
/* 「留在雲端」:放棄這個意圖 → gate 變 false → 落到雲端自動下單頁。他自己選的。
   立刻重畫、不等下一輪輪詢:那顆鈕連同整張卡會被藏起來,焦點得在重畫完成之後交給落地那一頁的標題,不然掉回 body。 */
function hoStay() {
  HO.pending = null;
  // 雲端第一次的落點(trade.js trCloudLand)在這裡由人決定了:自動下單頁,不改落歡迎頁(焦點要交給那一頁的標題)
  const C = TR_BAGS.cloud; C.landDone = true; C.open = true; C.view = "tr";
  trPaint();
  const h = $("tr-h"); if (h && h.offsetParent) h.focus();
}
/* 報告頁首描述下面那一行(#rp-ho-note):雲端停機 / 讀不到時**不切視角**,在原地講一句 + 一顆人按的「去雲端看」。
   key 給 null 就收起來。這個位置只為那兩句存在(規格 §2)。 */
function hoNote(key) {
  const n = $("rp-ho-note"); if (!n) return;
  if (key && hoJobOwns()) { srSay(t(key)); return; }   // 這一格正在講搬家那一行:停機句讓位,只唸
  delete n.dataset.busy; n.textContent = ""; n.hidden = !key; if (!key) return;
  const b = document.createElement("button"); b.type = "button"; b.className = "btn-quiet"; b.textContent = t("ho.block.goCloud");
  b.addEventListener("click", () => { hoNote(null); envSwitchGuarded("cloud"); });   // 不記 pending:記了雲端那邊就會出「準備好了」卡,按幾次都繞回同一張
  n.append(t(key) + " ", b);
}

// 雲端主機正在更新(搬檔與重跑回測會撞上換 lib/):講一句＋〔查看〕帶去更新那條
function hoOnceTell(a) {
  const n = $("rp-ho-note"); if (!n) return;
  n.textContent = t(a.key); n.dataset.sid = a.sid; n.hidden = false;
  busyFixLink(n, "view");
}
// 還能不能送:同一支同方向還在搬(講在那一行,進度本來就在那裡),或雲端主機正在更新
function hoBlocked(dir, id) {
  const j = HO.jobs.get(dir + ":" + id);
  if (j && (j.phase === "send" || j.phase === "run")) return { key: "ho.busy" };
  return UPD.cloudSid && csTabRunning(UPD.cloudSid) ? { key: "ho.updating", sid: UPD.cloudSid } : null;
}
function hoTellBlocked(b) { if (b.sid) hoOnceTell(b); else { hoJobPaint(); srSay(t(b.key)); } }
function hoAsk(dir, id, opener) {
  if (!HO.on || !HO_ID_RE.test(id)) return;
  if (!envCanSwitch()) return;                                           // IME 選字中、別的框開著
  const once = hoBlocked(dir, id);
  if (once) { hoTellBlocked(once); return; }
  // 雲端沒在運行(沒登入、沒綁卡、沒主機、啟動中):切過去,那一頁自己會講。
  // 記下要送哪一支:那一頁通完(登入 / 啟動好)之後,雲端中欄會留一格「準備好了」卡,主鈕把人送回來按這顆鈕。
  // **切完才記**:envSwitch 自己會清 pending(人自己切視角 = 放棄這個意圖),先記會被那一行洗掉。
  // 另外兩態**不切視角**(規格 §2):停機切過去只是落在自動下單頁的紅字;「running 但讀不到」切過去還會
  // 記下 pending → gate 又開 → 又是同一張卡,按幾次都繞不出去。攔在本機講一句就沒有迴圈
  if (dir === "up" && !hoCloudLive()) {
    const kind = envCloudKind(TR_BAGS.cloud.st);                         // !hoCloudLive() 而 kind 還是 running = 逾 1 小時沒同步那一態
    if (kind === "running" || kind === "stopped") { hoNote(kind === "running" ? "ho.gate.stale" : "ho.gate.stopped"); return; }
    if (envSwitchGuarded("cloud")) HO.pending = { id };
    return;
  }
  // 走到這裡 = 框真的開得起來(接著按確認就送出):意圖已經達成,那條回頭路不必再留。
  // 另外三個清的時機:人自己切視角(envSwitch)、按了「留在雲端」(hoStay)、重開 app(只在記憶體、不寫檔)
  if (dir === "up") { HO.pending = null; hoNote(null); }
  // 來源在它那一邊的下單設定裡(判準同雲端刪除 cdelInUse,金額 0 也算)照樣能搬(Wei 09-27):搬的只有程式碼與 DATA_ 金鑰,
  // 金額與下單狀態不搬,目的地那份要用戶在那邊給金額才會下單——所以只多講一句,不擋
  const srcSt = dir === "up" ? TR_BAGS.local.st : TR_BAGS.cloud.st;
  const srcLive = cdelInUse(srcSt && srcSt.report ? srcSt.report.config : null, id) === true;
  const destSt = dir === "up" ? TR_BAGS.cloud.st : TR_BAGS.local.st;
  // 目的地同名一律不覆蓋、改存新名字(Wei 09-28)。占用 = 清單有、或下單設定有(資料夾不在但設定還掛著那個名字,新資料夾一放進去就會被排程)。
  // 拉回:這台電腦的清單是現況。送上雲端:雲端清單是 24 小時快取的索引,沒看到不等於沒有——用中性那句,由 agent 實查定案
  const destCfg = destSt && destSt.report ? destSt.report.config : null;
  const names = (dir === "up" ? envCloudList(destSt) : RP.list).map((x) => x.name);
  const taken = (n) => names.indexOf(n) >= 0 || cdelInUse(destCfg, n) === true;
  const destHas = taken(id) ? true : dir === "up" ? null : false;
  const to = destHas ? hoFreeName(id, taken) : id;
  if (!to) return;
  const mk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const extra = document.createDocumentFragment(), dl = mk("dl", "cf-rows kv");
  const row = (k, v) => { const r = mk("div", "cf-row"); r.append(mk("dt", "", k), mk("dd", "", v)); return r; };
  const mv = hoMovesRow(dir, dir === "up" ? RP.data : null);
  const st = hoStaysRow(dir, dir === "up" ? RP.data : null);
  dl.append(row(t("ho.row.moves"), t(mv[0], mv[1] || undefined)), row(t("ho.row.stays"), t(st[0], st[1] || undefined)));
  extra.appendChild(dl);
  if (destHas) extra.appendChild(mk("p", "cf-removed", t(dir === "up" ? "ho.rename.up" : "ho.rename.down", { id, to })));
  else if (destHas === null) extra.appendChild(mk("p", "cf-removed", t("ho.rename.maybeUp")));
  if (srcLive) extra.appendChild(mk("p", "cf-note", dir === "up" ? t("ho.srcLive.up") : t("ho.srcLive.down")));
  // 講清楚按下去之後會發生什麼:搬過去、在那邊重跑一次回測、兩邊數字並排;Type B 沒有回測,講確認它跑得起來
  const B0 = dir === "up" ? RP : RPC, tb = hoKind(B0.name === id ? B0.data : null);
  extra.appendChild(mk("p", "cf-note", t(HO_NOTE[tb][dir === "up" ? 0 : 1])));
  const name = hoLabel(id, dir === "up" ? RP.list : envCloudList(srcSt));
  const title = dir === "up" ? t("ho.up.title", { id: name }) : t("ho.down.title", { id: name });
  confirmBox({
    title, lines: [], extra, ok: dir === "up" ? t("ho.ok.up") : t("ho.ok.down"), opener,
    onOk: () => {
      const again = hoBlocked(dir, id); if (again) { hoTellBlocked(again); return; }   // 框開著的期間已經按過一次
      hoRun(dir, id, to, tb === "B", B0 && B0.name === id ? B0.data : null);
    },
  });
  $("del-title").title = title;                                         // 標題單行截尾,全文放 title
}
/* ── 直接搬:送出、等目的地跑完、畫結果 ──
   job = { dir, id, to, typeB, phase, src, dest?, res?, err?, dst?, trial?, missing, left, cmpOpen }
   phase:send 送出中 → run 目的地在跑 → done | fail | unknown(送出了沒回條)| keys(金鑰沒搬到)| notrun(Type B 沒試跑) */
const HO_POLL_MS = 6000, HO_POLL_MAX_MS = 20 * 60 * 1000;
// 字串 key 一律是 t 的字面參數(tests/check_shell_strings.js 只認得這種寫法):表裡放的是取字的函式
const HO_K = {
  up: { send: (v) => t("ho.p.send.up", v), run: (v) => t("ho.p.run.up", v), trial: (v) => t("ho.p.trial.up", v), go: (v) => t("ho.goDest.up", v) },
  down: { send: (v) => t("ho.p.send.down", v), run: (v) => t("ho.p.run.down", v), trial: (v) => t("ho.p.trial.down", v), go: (v) => t("ho.goDest.down", v) },
};
const HO_WHY = { REFUSED: (v) => t("ho.why.REFUSED", v), DATA: (v) => t("ho.why.DATA", v), TIMEOUT: (v) => t("ho.why.TIMEOUT", v), EXIT: (v) => t("ho.why.EXIT", v) };
// 完成句 = 存到哪 + 比較結論(一句);period 優先(開始或結束不同時先講)
const HO_DONE = { match: (v) => t("ho.done.match", v), differs: (v) => t("ho.done.differs", v), period: (v) => t("ho.done.period", v), nosrc: (v) => t("ho.done.nosrc", v), none: (v) => t("ho.done.none", v) };
async function hoRun(dir, id, to, typeB, srcData) {
  const key = dir + ":" + id, job = { dir, id, to, typeB, phase: "send", src: srcData && srcData.stats ? srcData.stats : null, missing: [], left: [], cmpOpen: false, t0: Date.now() };
  HO.jobs.set(key, job); hoJobPaint();
  let r = null;
  try { r = dir === "up" ? await window.blave.transferUp(id, to) : await window.blave.transferDown(id, to); } catch (_) { r = null; }
  if (HO.jobs.get(key) !== job) return;
  if (!r || !r.ok) { job.phase = r && r.kind === "unknown" ? "unknown" : "fail"; job.err = hoErr(r); job.res = r; hoJobPaint(); return; }
  trackFeature(dir === "up" ? "handoff_cloud" : "handoff_pull");   // ack 成功才算用過
  const res = r.result && typeof r.result === "object" ? r.result : {};
  job.dest = HO_ID_RE.test(String(res.dest)) ? res.dest : to; job.res = res;
  if (res.run === "trial" || res.type === "B") job.typeB = true; else if (res.run === "backtest") job.typeB = false;   // 機器判的型別為準
  job.missing = Array.isArray(r.missing) ? r.missing.filter((x) => typeof x === "string").slice(0, 8) : [];
  job.left = r.exported && Array.isArray(r.exported.left_behind) ? r.exported.left_behind.filter((x) => typeof x === "string").slice(0, 8) : [];
  if (dir === "down") stratRefresh(false);                          // 新的那支出現在這台電腦的清單
  job.phase = res.run === "keys_failed" || job.missing.length ? "keys" : res.run === "not_run" ? "notrun" : "run";
  hoJobPaint();
  // 有背景跑才等:缺金鑰的那一跑多半會以 DATA 失敗,畫面照「金鑰沒搬」講,跑完照樣收結果;金鑰寫失敗(keys_failed)與 not_run 沒有那一跑
  if (res.run === "backtest" || res.run === "trial") hoPoll(job);
}
// 等目的地那一跑:雲端讀 /cloud/strategy(不帶 lite)的 transfer／backtest,本機讀 loadStrategy;transfer 不見了而且有回測 = 完成
async function hoPoll(job) {
  const key = job.dir + ":" + job.id;
  while (HO.jobs.get(key) === job && (job.phase === "run" || job.phase === "keys")) {
    await new Promise((r) => setTimeout(r, HO_POLL_MS));
    if (HO.jobs.get(key) !== job) return;
    let d = null;
    try {
      if (job.dir === "up") { const r = await window.blave.cloudStrategy(job.dest); d = r && r.code === "OK" ? r.strategy : null; }
      else d = await window.blave.loadStrategy(job.dest);
    } catch (_) { d = null; }
    const tr = d && d.transfer && typeof d.transfer === "object" ? d.transfer : null;
    const keys = job.phase === "keys";
    if (d && job.typeB && tr && tr.status !== "running") { if (!keys) { job.phase = "done"; job.trial = tr; } else return; }   // 試跑出錯也是結果(exit 不是 0)
    else if (d && tr && tr.status === "failed") { if (!keys) { job.phase = "fail"; job.err = { key: "ho.err.run", vars: { dest: job.dest, why: (HO_WHY[tr.err] || HO_WHY.EXIT)() } }; } else return; }
    else if (d && !job.typeB && !tr && d.stats) { job.phase = "done"; job.dst = d.stats; }
    else if (Date.now() - job.t0 > HO_POLL_MAX_MS) { if (!keys) { job.phase = "fail"; job.err = { key: "ho.err.slow", vars: { dest: job.dest } }; } else return; }
    else continue;
    hoJobPaint();
  }
}
// 正在看的這一支有沒有搬家紀錄(來源那一支:這台電腦 = 送上雲端,雲端 = 拉回)
function hoJobOwns() {
  const cloud = ENV.cur === "cloud", B = cloud ? RPC : RP;
  return B.name ? HO.jobs.get((cloud ? "down" : "up") + ":" + B.name) || null : null;
}
/* 搬家那一行要講什麼 → { text, spin, acts:[動作代號], cmp:hoCompare 的結果或 null }。只算、不碰 DOM(hoJobPaint 畫)。
   句子帶存到哪一邊({at});「兩邊資料來源不同」只在結論不一致時講;動作代號:cmp 看兩邊數字、src 去資料來源、dest 到那一邊看、dismiss 收起 */
function hoJobView(j) {
  const d = j.dir, K = HO_K[d], v = { dest: j.dest || j.to, to: j.to, at: d === "up" ? t("ho.at.up") : t("ho.at.down") };
  const end = ["send", "run"].indexOf(j.phase) < 0, out = { text: "", spin: !end, acts: [], cmp: null };
  const sep = LANG === "zh" ? "" : " ";   // 兩句相接:中文句號後不加半形空格
  if (j.phase === "send") out.text = K.send();
  else if (j.phase === "run") out.text = (j.typeB ? K.trial : K.run)(v);
  else if (j.phase === "unknown") out.text = t("ho.err.unknown", v);
  else if (j.phase === "fail") out.text = j.err && j.err.key === "$send" ? trSendError(j.res, "handoff", "cloud") || t("ho.err.retry") : t((j.err && j.err.key) || "ho.err.retry", Object.assign({}, v, (j.err && j.err.vars) || {}));
  else if (j.phase === "keys") {
    const src = j.missing.length ? j.missing.join(LANG === "zh" ? "、" : ", ") : "";
    out.text = j.missing.length ? t(j.typeB ? "ho.keys.noneB" : "ho.keys.none", Object.assign({ src }, v)) : t(j.typeB ? "ho.keys.failedB" : "ho.keys.failed", v);
    if (j.missing.length) out.acts.push("src");
  } else if (j.phase === "notrun") {
    const r = j.res || {}, bad = Array.isArray(r.syntax_errors) ? r.syntax_errors.filter((x) => typeof x === "string").slice(0, 3) : [];
    out.text = bad.length ? t("ho.notrun.syntax", Object.assign({ x: bad.join(", ") }, v)) : t("ho.notrun.order", v);
  } else if (j.phase === "done" && j.typeB) {
    const tr = j.trial || {};
    out.text = t(tr.stopped_after_s ? "ho.trial.stopped" : tr.exit === 0 ? "ho.trial.ok" : "ho.trial.fail", v);
  } else if (j.phase === "done") {
    const c = hoCompare(j.src, j.dst);
    out.text = (c.period ? HO_DONE.period : HO_DONE[c.state])(v) + (c.state === "differs" ? sep + t("ho.cmp.noise") : "");
    if (c.state !== "none") { out.cmp = c; out.acts.push("cmp"); }
  }
  if (j.left.length) out.text += sep + t("ho.left", { x: j.left.join(", ") });
  if (end && j.dest) out.acts.push("dest");
  if (end) out.acts.push("dismiss");
  return out;
}
/* 搬家那一行:句子進 #rp-ho-note(role=status,內容沒變就不重寫:輪詢與頁首重畫不讓讀屏重唸)、文字鈕進 #rp-ho-acts、
   並排表進 #rp-ho-cmp(兩個都不是 live region)。沒有紀錄時只收自己那兩個容器,句子那格留給主鈕原因句／停機句。回 true = 畫了 */
function hoJobPaint() {
  const n = $("rp-ho-note"), acts = $("rp-ho-acts"), cmp = $("rp-ho-cmp"); if (!n || !acts || !cmp) return false;
  const j = hoJobOwns();
  if (!j) {
    acts.hidden = true; acts.textContent = ""; delete acts.dataset.sig;
    cmp.hidden = true; cmp.textContent = ""; delete cmp.dataset.sig;
    return false;
  }
  const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const view = hoJobView(j);
  if (n.hidden || n.textContent !== view.text || !!n.querySelector(".spin16") !== view.spin) {
    delete n.dataset.busy; n.classList.remove("err"); n.textContent = ""; n.hidden = false;
    if (view.spin) { const sp = mk("span", "spin16"); sp.setAttribute("aria-hidden", "true"); n.appendChild(sp); }
    n.append(view.text);
  }
  const sig = view.acts.join() + "|" + j.dir + ":" + j.id;
  if (acts.dataset.sig !== sig) {
    acts.dataset.sig = sig; acts.textContent = "";
    const K = HO_K[j.dir];
    const btn = (label, fn) => { const b = mk("button", "btn-quiet", label); b.type = "button"; b.addEventListener("click", fn); acts.appendChild(b); return b; };
    for (const a of view.acts) {
      if (a === "cmp") {
        const b = btn(t("ho.cmp.show"), () => {
          j.cmpOpen = !j.cmpOpen; if (j.cmpOpen) trackFeature("handoff_compare");
          b.textContent = t(j.cmpOpen ? "ho.cmp.hide" : "ho.cmp.show"); b.setAttribute("aria-expanded", j.cmpOpen ? "true" : "false"); cmp.hidden = !j.cmpOpen;
        });
        b.dataset.k = "cmp"; b.setAttribute("aria-controls", "rp-ho-cmp");
      } else if (a === "src") btn(t("ho.keys.go"), () => rpGoDataSrc());
      else if (a === "dest") btn(K.go(), () => hoGoDest(j));
      else if (a === "dismiss") btn(t("ho.dismiss"), () => { HO.jobs.delete(j.dir + ":" + j.id); n.hidden = true; n.textContent = ""; hoJobPaint(); const h = $("rp-name"); if (h) h.focus(); });
    }
  }
  acts.hidden = !view.acts.length;
  const tg = acts.querySelector('[data-k="cmp"]');
  if (tg) { tg.textContent = t(j.cmpOpen ? "ho.cmp.hide" : "ho.cmp.show"); tg.setAttribute("aria-expanded", j.cmpOpen ? "true" : "false"); }
  const csig = view.cmp ? JSON.stringify([j.dir, j.id, j.dest, view.cmp]) : "";
  if (cmp.dataset.sig !== csig) { cmp.dataset.sig = csig; cmp.textContent = ""; if (view.cmp) cmp.appendChild(hoCmpTable(j, view.cmp)); }
  cmp.hidden = !(view.cmp && j.cmpOpen);
  return true;
}
function hoCmpTable(j, c) {
  const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const th = (text, scope) => { const e = mk("th", "", text); e.setAttribute("scope", scope); return e; };
  const tb = mk("table", "ho-cmp"), thead = mk("thead"), body = mk("tbody"), head = mk("tr");
  const here = j.dir === "up" ? j.src : j.dst, there = j.dir === "up" ? j.dst : j.src, show = (x) => c.state !== "nosrc" || x === j.dst;
  head.append(th("", "col"), th(t("ho.cmp.here"), "col"), th(t("ho.cmp.cloud"), "col"));
  thead.appendChild(head); tb.append(thead, body);
  for (const [k, f] of HO_CMP_ROWS) {
    const tr = mk("tr"); tr.append(th(t(k), "row"), mk("td", "num", show(here) ? hoCell(f, here && here[f]) : "—"), mk("td", "num", show(there) ? hoCell(f, there && there[f]) : "—"));
    body.appendChild(tr);
  }
  const ds = mk("tr");
  ds.append(th(t("ho.cmp.data"), "row"), mk("td", "wrap", t(typeof hasData === "function" && hasToken && hasData(acct) ? "ho.cmp.dataHereBlave" : "ho.cmp.dataHere")), mk("td", "wrap", t("ho.cmp.dataCloud")));
  body.appendChild(ds);
  return tb;
}
// 結果句尾〔去看 {dest}〕:切到目的地那一邊、選中那一支
async function hoGoDest(j) {
  if (!envCanSwitch()) return;
  if (j.dir === "up") { if (ENV.cur !== "cloud" && !envSwitchGuarded("cloud")) return; await rpCloudSelect(j.dest); }
  else { if (ENV.cur !== "local" && !envSwitchGuarded("local")) return; await stratSelect(j.dest); }
  const h = $("rp-name"); if (h && h.offsetParent) h.focus();
}
/* 講「哪一支要搬」的地方(確認框標題、準備好卡、對話動作卡)寫策略名稱:規則照 canon notifications §3.1(trade.js trStratLabel),
   過不了規則或清單裡沒有才寫代號;同一份清單裡別支也叫這個名字時補「（代號）」。
   講「存成哪個資料夾」的句子({to}/{dest})照舊寫代號:撞名改存的新資料夾跟來源同名,只有代號分得出來 */
function hoLabel(id, list) {
  const L = Array.isArray(list) ? list : [], lab = (x) => (x && typeof trStratLabel === "function" ? trStratLabel(x.displayName, x.name) : null);
  const name = lab(L.find((x) => x && x.name === id));
  if (!name) return id;
  return L.some((x) => x && x.name !== id && lab(x) === name) ? name + "（" + id + "）" : name;   // 包法同 api strategy_names.labeler,兩語一樣
}
/* 側欄列選單(stratflags.js sfPopOpen 問):這一列給哪個方向,不給回 null。本機清單 = 送上雲端、雲端清單 = 拉回(雲端要看得到現況)。
   畫不出頁首鈕的情況同樣不給:功能關、名字過不了閘門、時光機或重跑中(只對正在看的那一支判得出來) */
function hoMenuDir(cloudList, name) {
  if (!HO.on || !HO_ID_RE.test(String(name))) return null;
  if (cloudList && !hoCloudLive()) return null;
  const B = cloudList ? RPC : RP;
  if (B.name === name && typeof verHidesAct === "function" && verHidesAct()) return null;
  return cloudList ? "down" : "up";
}
/* 選單列與對話卡共用:先落到那一支的報告頁(確認框要讀它的程式碼判 Type B、進度也畫在那一頁),再開同一個確認框 */
async function hoGo(dir, id, opener, ev) {
  if (!HO.on || !HO_ID_RE.test(String(id)) || !envCanSwitch()) return;
  if (ev === "menu") trackFeature("handoff_menu"); else if (ev === "card") trackFeature("handoff_card");
  if (dir === "up") {
    if (ENV.cur !== "local" && !envSwitchGuarded("local")) return;
    if (!RP.list.some((x) => x.name === id)) return;
    if (RP.name !== id) await stratSelect(id);
  } else {
    if (ENV.cur !== "cloud" && !envSwitchGuarded("cloud")) return;
    if (RPC.name !== id) await rpCloudSelect(id);
  }
  hoAsk(dir, id, opener && document.contains(opener) ? opener : $("rp-ho") || opener);
}
/* 對話動作卡(runtime agent_turn extract_handoff 的 {type:"handoff", dir, name}):先收著,回合正常結束才畫在這一輪最後一則回覆下面。
   按鈕只開確認框;是否同意只認用戶在框裡按「確認」。只在記憶體,重載不畫 */
function hoChunk(c) {
  if (!c || (c.session_id && c.session_id !== sessionId) || (c.dir !== "up" && c.dir !== "down") || !HO_ID_RE.test(String(c.name))) return;
  HO.cards.set(sessionId, { dir: c.dir, name: c.name });
}
function hoCardTurnEnd(ok) {
  const p = HO.cards.get(sessionId); HO.cards.delete(sessionId);
  if (!ok || !p || !HO.on) return;
  const host = turnAiBubbles.filter((b) => b.parentNode).pop(); if (!host) return;
  const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const label = hoLabel(p.name, p.dir === "up" ? RP.list : envCloudList(TR_BAGS.cloud.st));
  const card = mk("div", "ho-card"), ic = hoIcon(p.dir), txt = mk("span", "ho-card-t", label); txt.title = label;
  const b = mk("button", "btn-out", t(p.dir === "up" ? "ho.card.upBtn" : "ho.card.downBtn")); b.type = "button";
  b.setAttribute("aria-label", t(p.dir === "up" ? "ho.card.up" : "ho.card.down", { name: label }));   // 卡上只放名字,鈕的可及名稱講全句
  b.addEventListener("click", () => hoGo(p.dir, p.name, b, "card"));
  card.append(ic, txt, b); host.appendChild(card);
}
async function hoInit() {
  try { const f = await window.blave.featureFlags(); HO.on = !!(f && f.cloudHandoff === true); } catch (_) { HO.on = false; }
  document.documentElement.dataset.handoff = HO.on ? "on" : "off";
  if (HO.on) { hoPaint(); ENV.sig.side = null; if (typeof trPaint === "function") trPaint(); }
}
