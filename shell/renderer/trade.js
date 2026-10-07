/* 自動下單頁、連接交易所的框、頂列切換器與狀態句(模擬交易版)。
   基準是雲端工作頁的自動下單頁(web/app/main/templates/agent/workspace.html 的 renderPfHead /
   buildExecControl / buildAmountTable / buildPositionsSection / buildOrderLogSection / renderOverTab),
   字串逐字取自雲端翻譯檔(只把「主機」換成「這台電腦」、「停止」統一成「暫停」)。
   資料與指令一律經過 envApi()(下面「視角純邏輯」):這台電腦那份轉給主行程的 tradeStatus / listStrategies / loadStrategy / tradeSend…,
   雲端那份讀主行程的 cloudStatus()、而且寫不出去。這個檔裡不直接叫 window.blave 的那幾支(tests/check_shell_envsw.js 會列舉)。
   這個檔跟 app.js 同一個全域 scope:直接用 $ / t / srSay / confirmBox /
   setOpen / setCat / stratSelect / RP,不另外包一層。
   安全:狀態檔、策略名、handler 的錯誤字串都是不可信輸入——一律 DOM 節點 + textContent,沒有 innerHTML。 */

/* ── 純邏輯(tests/check_shell_trade.js 從原文切出來跑;這一段不准碰 DOM)────────────── */
/* tradeSend 的 error → 三種說法。宿主保證:TIMEOUT / DAEMON_DOWN = 指令檔已收回,**確定沒執行**;
   UNKNOWN_RESULT = 常駐程式已經收走、20 秒內沒回,**可能已執行**(不能說「沒送到」);其餘大寫代碼 = 沒出得了主行程;
   不是代碼的 = handler 自己的拒絕原因(中英混雜的 runtime 字串,畫面包一層本地化前導,不頂替整句)。 */
const TR_UNDELIVERED = ["NOT_ALLOWED", "DAEMON_DOWN", "TIMEOUT", "TOO_LARGE", "WRITE_FAILED", "BAD_ARGS", "UPDATE_REQUIRED"];   // UPDATE_REQUIRED = 最低版本閘在主行程就擋下,沒出得了門
function trErrorKind(error) {
  const e = error ? String(error) : "";
  if (e === "UNKNOWN_RESULT") return "unknown";
  return !e || TR_UNDELIVERED.indexOf(e) >= 0 ? "undelivered" : "rejected";
}
/* 過場中還能不能按 / 還能不能送(規格 §1.3)。**暫停方向永遠放行**:緊急停止不可以被自己的過場態鎖住——
   前一個指令還在路上不是「不能停」的理由。重複送是安全的:`halt` 在 api 有自己的速率桶(不會被別的指令餓死),
   在本機 daemon 沒跑時照樣排隊(daemon.js:149),而同一次動作的重試沿用同一顆 request_id,不會變成兩顆。
   啟動方向照舊鎖住:那個重複送就是真的多開一次倉。 */
function trBtnLocked(pending, stopSide) { return !!pending && !stopSide; }
// 這個狀態下鈕是「暫停」那一側嗎。狀態不明時給暫停:不知道有沒有在跑,就給安全方向的那顆(稽核 S5)
function trStopSide(state) { return state === "running" || state === "unknown" || state === "unconfirmed"; }
/* 「暫停」現在送不送得出去。狀態說在跑 = 是;**有任何過場也算**(spec-desktop-start-pending-stop):
   按下啟動、還沒生效那一段(ack 之前也一樣)機器可能已經在下單,暫停要按得到;暫停在途、報告還沒收斂時也要能再按
   (送的是同一顆 halt,trSend 單飛)。暫停排在啟動後面執行(cloudcmd.js 的 POST 排隊 + 兩邊佇列先進先出),最後一定停在暫停。
   啟動在途時主鈕仍鎖著講實話(「啟動中…」),暫停的出口是旁邊那顆文字鈕(trPaintHead 的 #tr-go-stop)。 */
function trStopSideNow(state, pending) { return trStopSide(state) || !!pending; }
// 按下啟動、還沒收斂:主鈕鎖著寫「啟動中…」,旁邊多一顆「暫停下單」(B 版)
function trStartPending(pending) { return !!pending && pending.want === "running"; }
/* 暫停(或暫停並平倉)還在過場:主鈕「暫停中…」**整段真的停用**(Wei 09-22 選 B,spec-desktop-pausing §1 被取代)——
   ack 之後、結果不明也一樣;收斂或過了收斂上限(trPendingCheck 清掉 pending)才放開,那之後再按是新的一次暫停 */
function trHaltInFlight(pending, nowMs) { return !!pending && pending.want === "halted" && nowMs < pending.until; }
/* 回應落在哪一桶。雲端那條路的 kind 由 cloudcmd.js 判(它知道失敗發生在指令階段還是 ack 階段,那是這裡看不出來的:
   同一個代號在兩個階段的意思不同),有就用它;本機沒有這個欄位,照代號查表。 */
function trKindOf(res) {
  const k = res && res.kind;
  return k === "undelivered" || k === "unknown" || k === "rejected" ? k : trErrorKind(res && res.error);
}
const TR_AMOUNT_MAX = 1e9;            // 同主行程 argsOk 的上限
const TR_HOST_RETRY_MS = 90 * 1000;   // 宿主退避重啟 2+4+8+16+30 秒 = 60 秒內會試完;超過還沒起來就是起不來
const TR_STALE_MS = 10 * 60 * 1000;   // 對帳快照超過這個年紀就不拿來當「實際」(同雲端 REPORT_STALE_MS 的用途)

// 已綁定的交易所 id:金鑰成對、下單與讀帳兩支 lib 都在(同雲端 pfHasAccount 的 venues 分支)。
// 宿主 daemon.js 的 liveAccount 判準比這寬(不看 pair / order)——它只決定「權益記在哪一家名下」;畫面以這裡為準。
// 連上的帳戶:金鑰成對(pair)、lib 在、讀得到帳戶。main.js / traytext.js 同一條
function trVenueIds(r) {
  const v = (r && r.venues) || {};
  return Object.keys(v).filter((id) => v[id] && v[id].credentials && v[id].pair && v[id].order && v[id].account).sort();
}
// 帳戶讀取器對這家的最新結果;還沒讀過 = null(剛連上的那幾秒)
function trLiveEntry(r, id) {
  const a = r && r.account && r.account.venues;
  return (a && a[id]) || null;
}
/* 畫面上的淨值 = 整個帳戶:accounts(各錢包)加總,沒有才退回 equity(同雲端 pfLiveTotal、平台 agent_equity_snapshot)。
   equity 只是下單那個錢包(Binance = U 本位合約的保證金餘額),錢放在現貨 / 資金 / 理財時單看它就像錢不見了 */
function trLiveTotal(e) {
  if (!e || typeof e !== "object") return null;
  const a = e.accounts;
  if (a && typeof a === "object" && !Array.isArray(a)) {
    const vs = Object.keys(a).map((k) => a[k]);
    if (vs.length && vs.every((v) => typeof v === "number" && isFinite(v))) return vs.reduce((s, v) => s + v, 0);
  }
  return typeof e.equity === "number" && isFinite(e.equity) ? e.equity : null;
}
// 錢包分佈:只有一個錢包就不列(同雲端);金額大到小,同額按名稱,重繪不跳動
function trWalletRows(e) {
  const a = e && e.accounts;
  if (!a || typeof a !== "object" || Array.isArray(a)) return [];
  const ks = Object.keys(a).filter((k) => typeof a[k] === "number" && isFinite(a[k]));
  if (ks.length < 2) return [];
  return ks.sort((x, y) => (a[y] - a[x]) || (x < y ? -1 : x > y ? 1 : 0)).map((k) => ({ key: k, amount: a[k] }));
}
// 持幣(現貨 / 資金錢包裡的幣,帳戶讀取器 get_holdings):部位是「倉」、這是「幣」,分表。多家時列上掛交易所
function trHoldingRows(r, ids) {
  const out = [];
  ids.forEach((id) => {
    const e = trLiveEntry(r, id);
    if (!e || !e.ok || !Array.isArray(e.holdings)) return;
    e.holdings.forEach((h) => { if (h && typeof h === "object" && h.asset) out.push({ venue: ids.length > 1 ? id : null, asset: String(h.asset), amount: h.amount, usdt_value: h.usdt_value, wallet: h.wallet }); });
  });
  // 價值大到小(錢最多的在最上面,設計稽核 005 第 9 條);估不出價值的(畫「—」)排最後,彼此照交易所給的順序
  const val = (h) => { const x = Number(h.usdt_value); return h.usdt_value != null && h.usdt_value !== "" && isFinite(x) ? x : null; };
  return out.sort((a, b) => { const x = val(a), y = val(b); return x == null ? (y == null ? 0 : 1) : y == null ? -1 : y - x; });
}
// 讀過而且失敗的 = 串接失敗;還沒讀過的不算失敗
// 群益在雲端開通中(主機回報有 capital_connect、下單程式還沒起來):帳密一存就算綁定,但讀帳要等下單程式寫出第一份快照——
// 那段期間的讀帳失敗是預期的,不算串接失敗(設定 › 帳戶 那一列講「開通中」,標頭不能同時講「串接失敗」)
function trCapWip(r, id) { const c = id === "capital" && r && r.capital_connect; return !!c && typeof c === "object" && !(c.worker && c.worker.status === "ok"); }
/* 統一在這台電腦開通中(狀態檔有 president_connect、worker 從來沒 ok 過;同 president.js presWip、traytext.localLine):讀帳失敗同樣是預期的。
   worker.ok_at = 開通過(runtime 在 worker 第一次 ok 寫、之後登入失敗不清):開通過又停掉的(機器重開落在維護時段、改了密碼)
   只看 status 會被當成開通中,暫停鈕與「部位沒人管」的紅字整個被吞(稽核 integ-0118 B-1) */
function trPresWip(r, id) { const c = id === "president" && r && r.president_connect; return !!c && typeof c === "object" && !(c.worker && (c.worker.status === "ok" || c.worker.ok_at)); }
// 開通過、之後 worker 失敗停掉(登入失敗 / 沒寫出快照):不是開通中,但「確認登入」只在開通框裡——設定 › 帳戶 那一列仍要給「繼續」進框,不然沒有出口
function trPresStopped(r, id) { const c = id === "president" && r && r.president_connect; return !!c && typeof c === "object" && !!c.worker && c.worker.status === "failed" && !trPresWip(r, id); }
function trFailedIds(r) { return trVenueIds(r).filter((id) => { const e = trLiveEntry(r, id); return !!e && !e.ok && !trCapWip(r, id) && !trPresWip(r, id); }); }
/* 綁著的只有開通中的統一、對帳器也沒在跑 = 開通還沒做完(0.1.18 Wei 實測:存了帳密、憑證 ok、probe 還在跑,頁面就講
   「串接失敗 · 已暫停 · Blave 重開過」)。對帳器在跑的不算:開通過、之後 worker 才失敗的那種照一般狀態機走,暫停鈕要在。
   機器重開相關的兩態(停著 / 沒停住)一律優先於 setup:那是真錢警示,開通中也不能藏。
   只有這台電腦視角(st.cloud = 雲端那份):雲端主機的回報也帶 president_connect,但「繼續」開的框只接這台電腦的統一
   (cxModalOpen 在雲端退成模擬),雲端照一般狀態機、開通交給網頁(稽核 integ-0118 B-2) */
function trSetupOnly(st) { const r = st && st.report, ids = trVenueIds(r); return ids.length > 0 && !(st && st.cloud) && ids.every((id) => trPresWip(r, id)) && !trRecRunning(st) && !trRestartStopped(r) && !trRestartUnconfirmed(r); }
// 有沒有帳戶 = 有沒有綁定,不看這一輪讀帳成不成功(稽核 S5):交易所讀帳 API 暫時失敗時對帳器可能還在下單,
// 這時把整頁換成 onboard、把「暫停下單」拿掉,等於在最需要出口的時候拿走出口。讀帳失敗另外標在狀態行上。
function trHasAccount(r) { return trVenueIds(r).length > 0; }

/* 狀態字判定(雲端 pfExecState 的移植)。順序有意義:沒帳戶最先——對帳器本來就不該在跑,說它「死了」是假話。
   電腦版多三件事:狀態檔還沒寫出來 = loading;狀態檔這一輪 build 失敗(只有 error、沒有 venues)= unknown——
   不是「沒帳戶」,不能畫 onboard;常駐程式不在(st.alive 為 false)時狀態檔是舊的,裡面的「對帳器活著」不能信。 */
// 報告的 reconciler.stopped = { reason: "machine_restart", at } | null(機器端記的「為什麼停」)
/* 雲端連交易所「已存到、等回報」那一態等多久(Wei 09-22):過了就換成「主機沒回報」並把鈕還回來。
   畫面上不倒數(S5 §4.1)——這只是上限。3 分鐘 = 回報週期 120–180 秒的上緣 */
const TR_CX_SAVED_MS = 180000;
function trCxSavedStale(saved, nowMs) { return !!saved && typeof saved.at === "number" && nowMs - saved.at >= TR_CX_SAVED_MS; }
/* 模擬帳戶送出去之後直接當成已連接(spec v2 §5 末、稽核 S-1):模擬沒有「金鑰對不對」要等主機驗,等待態只會讓人以為沒接上。
   這段時間畫下單設定的骨架,等主機那份回報把真資料填進來;超過上限(同真實交易所)才退回 onboard 講「主機沒回報」。
   真實交易所不走這裡:權限檢查的結果要等主機確認,照舊走「連接中…」 */
function trCxAssumed(saved, nowMs) { return !!saved && saved.venue === "paper" && !trCxSavedStale(saved, nowMs); }
function trRestartStopped(r) { const x = r && r.reconciler && r.reconciler.stopped; return !!(x && typeof x === "object" && x.reason === "machine_restart"); }
/* 「重開過、什麼單都不下」是哪一種(eval-downtime-behavior-unified;Wei:電腦版結束再打開也算):
   "machine" = 雲端主機重開後對帳器停著;"app" = 這台電腦上次在下單中、Blave 被結束再打開
   (監督者說沒在跑、也沒人要它跑,但對帳器留過心跳 = 以前跑過;從來沒跑過的才叫「尚未啟動下單」);其餘 null */
/* 主機重開、但沒能確認停住(spec-restart-gated-false-display):舊對帳器沒有重開閘門、停止之後又有心跳 = 它在跑、什麼都不擋。
   **嚴格 === false**:缺欄位(舊 runtime)或 true 照現行(已暫停 + B)。只有雲端會有 */
function trRestartUnconfirmed(r) { const x = r && r.reconciler && r.reconciler.stopped; return !!(x && typeof x === "object" && x.reason === "machine_restart" && x.gated === false); }
/* 已暫停的 HALT 是不是「什麼單都不下」(A′,audit-trading-ux 1-2;規則同 api agent_event_copy):
   portfolio / web / user / flatten / desktop 與缺欄位 = A(不開新倉、平倉停損照走);其他自動來源(reconciler、日後新增的)= A′。
   預設保守:不認得的來源寧可講「什麼單都不下」 */
const TR_HALT_KEEP_EXITS = ["portfolio", "web", "user", "flatten", "desktop"];
/* 新 runtime 在 halt 裡帶 holds_all(halt.halted 時一定有):true = 那家交易所什麼單都不下(平倉停損也不跑),false = 單純 HALT。
   有它就只看它——換金鑰後答完「同一個帳戶」,HALT 的 source 還是 reconciler,照來源名單會講成「什麼單都不下」,那時是假話。
   欄位不在(舊 runtime)才退回來源名單 */
function trHaltStopsAll(h) {
  if (h && typeof h.holds_all === "boolean") return h.holds_all;
  const src = h && h.source; return !!(h && typeof src === "string" && src && TR_HALT_KEEP_EXITS.indexOf(src) < 0);
}
/* 換金鑰後讀不到帳戶 id、Blave 在那家還有部位(spec-account-confirm + 機器端契約):report.account_guard.book_hold =
   { venue, reason(英文 runtime 敘述,**不顯示、不解析**), since }——reporter 只在要問用戶時送這一塊,不帶 ask / halted
   (網路類錯誤的暫扣不送,機器自己重試)。所以「這一塊在」就是要問;萬一日後帶了 ask:false,照「不問、只講狀態行」處理 */
function trBookHold(r) {
  const g = r && r.account_guard, h = g && typeof g === "object" ? g.book_hold : null;
  return h && typeof h === "object" && typeof h.venue === "string" && /^[a-z0-9]{2,20}$/.test(h.venue) ? h : null;
}
function trAcctAsk(r) { const h = trBookHold(r); return !!h && h.ask !== false; }
/* 帳戶沒確認時送的 resume / resume_wait:機器回 ok、結果是 "held: <venue> awaits book_account_confirm",HALT 照舊。
   回那一家的 id(給畫面講「還沒確認所以沒恢復」);不是這一種回 null */
function trHeldVenue(res) {
  const m = res && res.ok && typeof res.result === "string" ? /^held: ([a-z0-9]{2,20}) awaits/.exec(res.result) : null;
  return m ? m[1] : null;
}
/* 沒有交易所、但主機重開後停著(audit 2-1):紀錄檔只有「啟動下單」清得掉,連用戶自己策略程式下的單也被擋。
   不能掉進 onboard 沒有出口——狀態行照講、標頭照給「啟動下單」。沒確認停住(gated:false)那一種不在這裡 */
function trNoAccountStopped(r) { return !!r && !!r.venues && !trHasAccount(r) && trRestartStopped(r) && !trRestartUnconfirmed(r); }
/* 重開停著、策略還沒用開機後的資料算完第一輪(runtime 的 stopped.recomputed === false;空集合算 true):
   「補齊部位」會照重開前的訊號下單,先鎖住;「等新訊號」照給。欄位不在(舊 runtime)= 照舊不鎖 */
function trRecomputing(r) { const x = r && r.reconciler && r.reconciler.stopped; return !!(x && typeof x === "object" && x.recomputed === false); }
/* 已暫停那一行的原因句(狀態行與標頭的正文墨色切段共用同一個,不各寫一份):重開過 = B(主機 / Blave 各一句,優先);
   HALT 自動來源 = A′(C 裡沒有啟動鈕,換成指向更新那一句);其他 HALT = A */
/* 沒有策略設金額(Z,v2 §9-1)時不叫人按「啟動下單」(那顆停用了):句子前半照講,尾巴跟著畫面上實際有的鈕——
   看得到「解除暫停」(有 HALT / 重開停止)→ 叫人按它;只有停用的啟動鈕 → 先到「部位」設定金額再啟動。C 不算 Z(照現行) */
/* done = 這一頁剛答完帳戶確認的結果({ venue, outcome: "kept" | "reset" }),只在記憶體、HALT 還在時用(spec §3.2):
   答完之後的暫停句講清楚「同一個」與「從零開始」各自的後果;重新載入就退回一般那句 */
/* 這台電腦上有沒有「自己下單」的策略程式(主行程掃 strategies/<name>/*.py 是否 import lib.order_* / lib.execute,
   寫進 report.selfOrdering)。沒有的話「解除暫停」與「包含你自己的策略程式下的單」那半句都在講一顆不存在的東西(Wei 0.0.6 實測)。
   **嚴格 === false 才算沒有**:雲端的報告沒這個欄位、舊格式也沒有 → 照現行 */
function trSelfOrdering(r) { return !(r && r.selfOrdering === false); }
function trHaltReasonText(r, done) {
  const rk = trRestartKind(r), z = trNoAmounts(r) && !trRestartUnconfirmed(r), H = !!(r && r.halt && r.halt.halted);
  const vl = (v) => (typeof trVenueLabel === "function" ? trVenueLabel(v, true) : v), bh = trBookHold(r);
  if (H && bh && bh.ask !== false) return t("tr.acct.reason", { v: vl(bh.venue) });   // 要回答的那一題優先:它的出口是「確認帳戶」,不是啟動下單
  if (H && !bh && done && (done.outcome === "kept" || done.outcome === "reset")) return t(done.outcome === "kept" ? "tr.acct.doneSame" : "tr.acct.doneDiff", { v: vl(done.venue) });
  // ZH(「新倉也被擋著——包含你自己的策略程式下的單」)只在真的有自己下單的策略時講;沒有就退回 Z 那一句
  return rk === "machine" ? t(z ? "tr.cloud.restartStoppedZ" : "tr.cloud.restartStopped")
    : rk === "app" ? t(z ? (H && trSelfOrdering(r) ? "tr.restartStoppedLocalZH" : "tr.restartStoppedLocalZ") : "tr.restartStoppedLocal")
    : trHaltStopsAll(r && r.halt) ? (trRestartUnconfirmed(r) ? t("tr.cloud.haltReasonUnconfirmed") : t(z ? "tr.haltReasonAllZ" : "tr.haltReasonAll")) : t("tr.haltReason");
}
/* ── 沒有策略設金額(spec-desktop-update-experience-v2 §8,Wei 09-23)──
   Z = 沒有任何一條策略的金額 > 0。讀不到設定檔(config: null)不算 Z:不知道有沒有金額,照現行、不猜。
   Z 時「啟動下單」停用(沒有東西可以啟動),暫停中(HALT 或重開停止)另給「解除暫停」:只送 resume,不啟動對帳器 */
function trNoAmounts(r) {
  if (!r || typeof r !== "object" || r.config === null) return false;
  const a = r.config && r.config.amounts;
  return !(a && typeof a === "object" && Object.keys(a).some((k) => Number(a[k]) > 0));
}
/* Z 時標頭鈕的樣子。off = 啟動下單停用;release = 出「解除暫停」;reason = Z 自己那一句原因。
   有金額 / 重開沒確認停住(C,照現行)/ 其他態 → 全 false。沒有交易所的重開停止(B0)算 R:它的出口也是解除暫停。
   **這裡只決定鈕**:等回報那一行不歸它管(它在 Z 以外也要出),條件在 trPaintHead 的 trPendKey 那一段。 */
function trZView(state, r) {
  const none = { off: false, release: false, reason: null };
  // 沒有交易所 + 重開停止(B0):一定是 Z(沒有交易所就沒有金額可下)。不出啟動鈕,只出「解除暫停」;狀態句自己帶出口,不另畫原因行(v2 §9-1)
  if (state === "noaccount" && trNoAccountStopped(r)) return { off: true, release: true, reason: null, noStart: true };   // B0 沒有停用的啟動鈕,出口寫在狀態句裡(§12)
  if (!trNoAmounts(r) || trRestartUnconfirmed(r)) return none;
  const H = !!(r.halt && r.halt.halted), R = trRestartStopped(r);
  /* 剛存完金額的那一段:鈕**照舊停用**(它作用在機器實際持有的設定上,沒確認就啟動是拿真錢賭);
     畫面上的理由由等回報那一句蓋掉——「還沒有策略設定金額,先到部位設定」在剛設定完的那一刻是假的,
     而且它叫人再去做一次他剛做完的事(spec-desktop-waiting-states §2)。蓋的動作在 trPaintHead。 */
  if (state === "dead") return { off: true, release: false, reason: "tr.startOffNoAmt" };
  if (state === "halted") {
    const rel = (H || R) && trSelfOrdering(r);   // 沒有自己下單的策略程式 → 「解除暫停」沒有東西可解,不出鈕、原因行不叫人按它
    // 會平倉(x1 / x2)時鈕換「平倉並解除暫停」,原因行點名同一顆鈕(ux-order-1-4-5 §3.2)
    const close = rel && trReleaseKind(r).kind !== "x0";
    return close ? { off: true, release: true, reason: "tr.startOffNoAmtReleaseClose", close: true }
      : { off: true, release: rel, reason: rel ? "tr.startOffNoAmtRelease" : "tr.startOffNoAmt" };
  }
  return none;
}
/* 解除暫停會不會開始平倉(§8 確認框):只有重開停止(R)會讓對帳器從「每輪跳過」變回照常跑;單純 HALT 下對帳器本來就在跑。
   **從沒設定過**(portfolio_configured === false)才是「對帳器唯讀、什麼單都不下」——機器端的 portfolio_configured() 是
   「設定檔或 UI 鏡像檔存在」,所以「檔在、但讀不壞」照樣算設定過:對帳器照跑、照平倉。那一種在這裡不能當成安全,
   它由 trNoAmounts 的 `config === null` 擋在更上游(那時整個 Z 不成立,解除暫停鈕根本不存在)。判準與網頁 pfNeverConfigured 逐字相同。
   回 { kind: "x0" | "x1" | "x2", n, rows, at }:x1 = 帳上的合約部位會被平(self_ledger 沒開,n = 幾個;讀不到部位 n = null);
   x2 = self_ledger 開著、帳本上有機器人的部位。rows = [{ sym, v, lots }](v 帶正負號;帳本沒有方向時是正的 size;lots = 這一筆是口數)、
   at = 那份部位的時間(毫秒)。x1 的部位從即時讀帳數(ux-order-1-4-5 §3.1,同網頁 pfOrphanCount):重開停住期間對帳器每輪都跳過,
   last_reconcile 可能停在重開前。讀帳失敗、還沒讀過或超過 TR_STALE_MS 時退回快照,但快照只能證明「有」不能證明「沒有」——
   快照說空的就是不知道(n = null,「可能」那個框),不判成 x0(稽核 audit-0.1.13-web S3)。只數合約(@spot 不算) */
function trReleaseRows(m) {
  return Object.keys(m).filter((k) => !/@spot$/i.test(k) && m[k] && typeof m[k] === "object" && Number(m[k].size || m[k].qty || 0) !== 0)
    .map((k) => ({ sym: trCanonSym(k), v: trSigned(m[k]) || Number(m[k].size || m[k].qty), lots: m[k].unit === "contracts" || !!trTxfSpec(trCapitalCanon(k)) }));
}
function trReleaseLive(r, nowMs) {
  const a = r.account, at = a ? trMs(a.read_at) : null, ids = trVenueIds(r);
  if (!ids.length || at == null || nowMs - at > TR_STALE_MS) return null;
  const rows = [];
  for (const id of ids) {
    const e = trLiveEntry(r, id);
    if (!e || !e.ok || !e.positions || typeof e.positions !== "object") return null;
    rows.push(...trReleaseRows(e.positions));
  }
  return { rows, at };
}
function trReleaseKind(r, nowMs) {
  const x0 = { kind: "x0", n: null, rows: null, at: null };
  if (!r || !trRestartStopped(r) || trRestartUnconfirmed(r)) return x0;
  if (trNoAccountStopped(r)) return x0;   // 沒有交易所 = 沒有部位可平(B0 一律 X0)
  // 判斷順序(v2 §9-3):沒有設定檔 → X0;self_ledger 開 → X2(讀得到、確定帳本空才退回 X0);其他(關、欄位不在、讀不到)→ X1
  if (r.portfolio_configured === false) return x0;
  const last = r.last_reconcile && typeof r.last_reconcile === "object" ? r.last_reconcile : null, self = r.self_ledger === true;
  const snapAt = last ? trMs(last.ts) : null;
  if (self) {
    const book = last && (last.ledger || last.actual);
    if (!book || typeof book !== "object") return { kind: "x2", n: null, rows: null, at: null };
    const rows = trReleaseRows(book);
    if (rows.length) return { kind: "x2", n: rows.length, rows, at: snapAt };
    // 快照在送單**之前**寫(lib/portfolio):那一輪有下單,帳本空不代表現在空(稽核 S4)→ 不知道,不是 x0
    return Array.isArray(last.orders) && last.orders.length ? { kind: "x2", n: null, rows: null, at: null } : x0;
  }
  const live = trReleaseLive(r, nowMs == null ? Date.now() : nowMs);
  if (live) return live.rows.length ? { kind: "x1", n: live.rows.length, rows: live.rows, at: live.at } : x0;
  const act = last && last.actual, rows = act && typeof act === "object" ? trReleaseRows(act) : [];
  return rows.length ? { kind: "x1", n: rows.length, rows, at: snapAt } : { kind: "x1", n: null, rows: null, at: null };   // 讀不到 / 只有舊快照說空:寧可多警告一次
}
function trRestartKind(r) {
  if (trRestartUnconfirmed(r)) return null;   // 不是「什麼單都不下」:B 的原因行、重開後的啟動框那一行都不能帶出來
  if (trRestartStopped(r)) return "machine";
  const sup = r && r.daemon && r.daemon.reconciler;
  return sup && sup.running === false && sup.wanted !== true && r.reconciler && r.reconciler.heartbeat_at ? "app" : null;
}
function trExecState(st) {
  const r = st && st.report;
  if (!r) return "loading";
  if (r.error || !r.venues || typeof r.venues !== "object") return "unknown";
  if (!trHasAccount(r)) return "noaccount";
  if (trSetupOnly(st)) return "setup";   // 統一開通中:不是已暫停、不是死了;鈕換「繼續」,切換器不出事
  if (r.halt && r.halt.halted) return "halted";   // 含「重開沒停住、已按暫停」:舊對帳器認 HALT,已暫停 + A 是真話
  // 重開沒停住、還沒按暫停:可能仍在下單(不是 dead、不是 halted、也不借 running——不能亮綠點)。stopped 期間 alive 一律 false,不看它
  if (trRestartUnconfirmed(r)) return "unconfirmed";
  // 重開過、對帳器整個停著、等人按「啟動下單」(Wei 09-22:已暫停 / 已停止是同一件事,一律「已暫停」):不是「死了」。
  // 電腦版那一種要常駐程式在跑才信(監督者的欄位是它寫的)
  const rk = trRestartKind(r);
  if (rk === "machine" || (rk === "app" && st.alive)) return "halted";
  if (!st.alive || !(r.reconciler && r.reconciler.alive)) return "dead";
  // 心跳檔新鮮期 300 秒:app 重開後那 5 分鐘,上一次的心跳還算「活著」但對帳器沒起來——以常駐程式監督者為準(同 main.js tradeLive)
  if (r.daemon && r.daemon.reconciler && r.daemon.reconciler.running === false) return "dead";
  return "running";
}
/* 對帳器現在真的在跑嗎(啟動下單要不要補一個 restart 靠它)。不能單獨信心跳:心跳檔新鮮期 300 秒,app 重開後那 5 分鐘
   舊心跳還算 alive,略過 restart 的話對帳器永遠起不來(稽核 M2)。監督者有講就聽監督者的,沒講(舊狀態檔)才退回心跳。 */
function trRecRunning(st) {
  const r = st && st.report;
  if (!st || !st.alive || !r) return false;
  const sup = r.daemon && r.daemon.reconciler;
  return sup && typeof sup.running === "boolean" ? sup.running : !!(r.reconciler && r.reconciler.alive);
}
/* 常駐程式不在跑(稽核 S1):宿主會退避重啟、最多 5 次;exit 2/3(環境不對 / 別的行程握著鎖)與 spawn 失敗不重啟。
   回 null(在跑,或從來沒起過=引擎還沒裝)/ "lock"(等上一個下單機放鎖,宿主自動重試中)/ "retry"(剛死,宿主還在試)/ "down"(試完了還是沒起來,只剩重開 Blave)。 */
function trHostDown(st, nowMs) {
  // "lock":上一個下單機還握著 workspace 的鎖(多半還在收工),宿主在等它放(daemon.js lockRetry,最多 4 次約 27 秒)。
  // 重試那支剛起來、還沒撐過 settle 時 running 是 true,所以要排在 running 之前看;重試用完 lockRetry 回 null,落到下面 code 3 = "down"
  if (st && st.lockRetry && typeof st.lockRetry === "object") return "lock";
  if (!st || st.running || !st.lastExit) return null;
  const x = st.lastExit;
  if (x.error || x.code === 2 || x.code === 3 || st.restarts >= 5) return "down";   // 宿主重試 5 次就不再試
  return nowMs - (x.at || 0) <= TR_HOST_RETRY_MS ? "retry" : "down";
}
// 指令通道有沒有在聽:沒在聽的鈕要 disabled,不能讓人以為自己暫停了
function trChannelUp(st) {
  const r = st && st.report;
  return !!(st && st.alive && r && !(r.command_listener && r.command_listener.alive === false));
}
/* 輸入框的字 → 金額(稽核 S11)。空字串 = 0(0 = 不下單);看不懂的回 null,呼叫端不准把 null 寫進 edits。
   只收三種寫法:純數字「1500」「1500.5」「.5」、千分位逗號「1,500.50」(逗號後一定要三位)。
   「1,5」(歐式小數)不能變 15、「1.000,50」不能變 1、「1e5」「12abc」不能靜默接受;超過宿主上限的也拒收。 */
function trParseAmount(s) {
  const x = String(s == null ? "" : s).trim().replace(/^\$\s*/, "");
  if (x === "") return 0;
  if (!/^(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?$/.test(x) || !/\d/.test(x)) return null;
  const v = Math.round(parseFloat(x.replace(/,/g, "")) * 100) / 100;
  return isFinite(v) && v >= 0 && v <= TR_AMOUNT_MAX ? v : null;
}
// 表上每一列現在的金額:改過的用改的,沒改的用已存的
function trCurrentAmounts(names, stored, edits) {
  const out = {};
  names.forEach((n) => { out[n] = edits[n] != null ? edits[n] : (stored[n] || 0); });
  return out;
}
/* 要送出去的 amounts。key 在不在 = 在不在組合裡(runtime 的 _cmd_amounts):表上的每一支都送(同網頁 currentAmounts)——
   表只列已存的 ∪ picker 勾的(trNames),在表上就是在組合裡,$0 也留著 key(0 = 收斂到空手,拿掉 key 反而會讓對帳器失去路由;
   勾了、立即送失敗的那一支也靠這一份補進去)。移出組合只剩「picker 取消勾選」一條路(spec-desktop-strategy-picker §12-5)——
   以前「回測過就進表、金額 > 0 才新加入」「清單載入後不在清單上 = 移出」兩條推論都退役,兩個視角同一套。
   keep = 表上沒列、但要原樣帶著的存量(雲端讀不到的那幾支,trHidden)。 */
function trAmountsToSend(names, stored, edits, keep) {
  const cur = trCurrentAmounts(names, stored, edits), out = {};
  names.forEach((n) => { out[n] = cur[n]; });
  (Array.isArray(keep) ? keep : []).forEach((n) => { if (!(n in out) && n in stored) out[n] = stored[n]; });
  return out;
}
function trRemoved(stored, sending) { return Object.keys(stored).filter((n) => !(n in sending)); }
/* 雲端存量裡、表上沒列出來、**而且清單也找不到**的那幾支(api 讀不到 summary / 清單暫時缺):不是已刪除(稽核 #1,真錢——
   api 讀不到清單時也可能回空陣列),金額照原樣帶著送,表下與確認框講有幾支。清單找得到、只是被取消勾選的 = 移出,不算在這裡。 */
function trHidden(names, stored, list) { const l = Array.isArray(list) ? list : []; return Object.keys(stored || {}).filter((n) => names.indexOf(n) < 0 && l.indexOf(n) < 0); }
// 要送出去的 amounts,依視角:雲端把讀不到的那幾支原樣帶著;這台電腦的清單是本機檔案系統、可信,表上沒列的就是取消勾選的
function trSendAmounts(env, names, stored, edits, list) { return trAmountsToSend(names, stored, edits, env === "cloud" ? trHidden(names, stored, list) : []); }
/* 雲端的策略清單算不算載入:這一份要真的帶了清單,而且「清單是空的、組合卻有金額」不算——那多半是 api 讀不到清單
   (見上),不是策略全被刪了。這時不給存。 */
/* 報告看得出已經有組合(對帳跑過 / 有排程),config 卻沒有 amounts 物件 = 主機那一輪讀設定檔失敗(稽核 L1),不是新機。
   這時拿 {} 當底存,會把主機上的整份組合覆蓋掉:不給存。新機(兩個訊號都沒有)照樣可以第一次存 */
function trCfgUnread(r) {
  if (!r) return false;
  if (r.config === null) return true;   // 報告明寫讀不到設定檔(runtime 讀失敗時回 null,跟「沒有設定檔」的 {} 分開)
  const c = r.config, has = !!(c && c.amounts && typeof c.amounts === "object" && !Array.isArray(c.amounts));
  return !has && (r.last_reconcile != null || (Array.isArray(r.scheduled) && r.scheduled.length > 0));
}
// 主機設定檔裡本來就不合法的值(非數字 / 負數 / 超過上限):原樣帶出去一定被擋,要講明是哪幾支,不是每次存都「沒送到」
function trBadStored(m) { return Object.keys(m || {}).filter((k) => { const v = m[k]; return typeof v !== "number" || !isFinite(v) || v < 0 || v > TR_AMOUNT_MAX; }); }
function trCloudListOk(ok, list, stored) { return !!ok && !(Array.isArray(list) && list.length === 0 && Object.keys(stored || {}).length > 0); }
// request_id 綁內容(S4 §4):同一份內容重送沿用同一顆;內容一變就是新的意圖。key 與順序無關
function trAmountsKey(m) { return JSON.stringify(Object.keys(m || {}).sort().map((k) => [k, Math.round((Number(m[k]) || 0) * 100)])); }
// 收斂 / 逾時 / 停機時換掉的 request_id:只限啟動 / 暫停那一組。金額、更新、重啟對帳器各有各的生命週期,不跟著過場走(稽核 #2)
const TR_RUN_CMDS = ["halt", "close_all", "resume", "resume_wait"];
function trClearRunIds(ids) { TR_RUN_CMDS.forEach((c) => { delete ids[c]; }); }
/* 雲端存完金額(ack ok = 已寫進主機的設定檔)之後,報告的 config.amounts 對上了沒(spec-desktop-cloud-s4 §3.2)。
   sent = 送出的整份;report = 報告裡的 config.amounts;reportedAt = 這份報告的時間;baseAt = ack 當下手上那份報告的時間
   (兩個都是主機寫的秒數:只拿報告對報告比,不跨這台電腦與主機的時鐘,稽核 #7)。
   回 "same"(對上了:收斂)| "changed"(ack 之後來的新報告、值卻不同 = 網頁 / 聊天改過,報告是真相,一樣清掉)| "wait"(還沒有新報告)。
   兩邊都四捨五入到 2 位;key 集合不同也算不同(amounts 是整份覆蓋,少一個 key = 移出組合)。 */
function trSentSettled(sent, report, reportedAt, baseAt) {
  const r = report && typeof report === "object" ? report : {}, r2 = (v) => Math.round((Number(v) || 0) * 100);
  const ks = Object.keys(sent || {}), kr = Object.keys(r);
  if (ks.length === kr.length && ks.every((k) => k in r && r2(sent[k]) === r2(r[k]))) return "same";
  return typeof reportedAt === "number" && (typeof baseAt !== "number" || reportedAt > baseAt) ? "changed" : "wait";
}
/* 台指期口數列(同 runtime command_listener._TXF_ASSET_SPECS、網頁 TXF_SPECS):機器把這一格當**目標口數**下單,不是錢。
   跟網頁一樣看策略的標的、不看綁哪家:runtime 第一次撥款時只看 SYMBOL 就寫 futures_contracts */
/* 口數換出來的參考金額的幣別:點值 × 加權指數本來就是台幣,固定標 TWD、不跟帳戶幣——讀帳失敗時帳戶幣會退成 USDT,
   台幣數字標成 USDT 等於把曝險放大約 30 倍(設計稽核第二輪 R2-S2)。群益主機只接這一家,表上不會混別的幣別 */
const TR_TXF_CCY = "TWD";
/* big = 沒有報價或淨值時,確認框提醒「口數很大」的退路門檻(三個名目大致相同,只為抓 TWD 年代留下的大數字與多打一個 0) */
const TR_TXF_SPECS = { TMF: { cv: 10, prod: "tr.txfProd.tmf", big: 1000 }, MXF: { cv: 50, prod: "tr.txfProd.mxf", big: 200 }, TXF: { cv: 200, prod: "tr.txfProd.txf", big: 50 } };
/* 倍數提醒的三級門檻(合計 ÷ 淨值;ux-order-1-4-5 §1.1,網頁同名同值)。群益口數列「名目太大」的提醒用 LEV_T2,不另開常數 */
const LEV_T1 = 1, LEV_T2 = 5, LEV_T3 = 10;
/* 倍數提醒的級數(§1.2),n = 合計 ÷ 淨值(用畫面上那個兩位小數,字和級數才對得上):0 = ≤ 1 倍、1 = 1–5、2 = 5–10、3 = ≥ 10。
   L = 交易所至少要設幾倍(⌈n⌉);p = 全部反向幾 % 就虧掉全部淨值(⌊100 ÷ n⌋,往下取,不把緩衝講大)。
   模擬帳戶(§1.4)沒有第 1 級(沒有槓桿可設)、也沒有第 3 級的勾選(不是真錢) */
function trLevLevel(n, paper) {
  const none = { level: 0, L: null, p: null };
  if (typeof n !== "number" || !isFinite(n)) return none;
  const x = Math.round(n * 100) / 100;
  if (x <= LEV_T1) return none;
  const level = x >= LEV_T3 ? 3 : x >= LEV_T2 ? 2 : 1;
  if (paper && level === 1) return none;
  return { level: paper ? 2 : level, L: Math.ceil(x), p: Math.floor(100 / x) };
}
// 金額表「訊號」欄(§2.1):×1.00 / ×−1.00(U+2212)/ ×0;拿不到 = 「—」
function trSignalText(pos) {
  if (typeof pos !== "number" || !isFinite(pos)) return "—";
  return pos === 0 ? "×0" : "×" + (pos < 0 ? "\u2212" : "") + Math.abs(pos).toFixed(2);
}
/* 部位表「N 支策略」拆解(§2.2):跟 trClientTargets 同一套算法,但逐支留著,不只留加總。只算金額 > 0 的策略。
   回 { 標的 key: [{ name, amount, x, v, w }] }(x = 訊號或權重、v = 貢獻、w = 是不是投資組合的權重) */
function trContribs(amounts, states) {
  const out = {}, add = (k, row) => { (out[k] = out[k] || []).push(row); };
  Object.keys(amounts || {}).forEach((n) => {
    const a = Number(amounts[n]) || 0, s = (states || {})[n];
    if (!(a > 0) || !s) return;
    if (s.weights && typeof s.weights === "object") {
      Object.keys(s.weights).forEach((sym) => {
        let w = Number(s.weights[sym]); if (!isFinite(w)) w = 0;
        if (s.market === "spot" && w < 0) w = 0;
        add(trCanonSym(sym) + (s.market === "spot" ? "@spot" : ""), { name: n, amount: a, x: w, v: a * w, w: true });
      });
      return;
    }
    if (!s.symbol) return;
    const pos = typeof s.position === "number" ? s.position : 0;
    add(trCanonSym(s.symbol) + (s.market === "spot" ? "@spot" : ""), { name: n, amount: a, x: pos, v: a * pos, w: false });
  });
  return out;
}
// 拆解框最後一句用哪一種(§2.3):同方向 = sum;有多有空、相加為 0 = sumOffZero;部分抵銷 = sumOff。l / s = 多、空各自加總(s 取絕對值)
function trNetSum(rows) {
  let l = 0, s = 0; rows.forEach((r) => { if (r.v > 0) l += r.v; else if (r.v < 0) s -= r.v; });
  const t = l - s, kind = !(l > 0 && s > 0) ? "sum" : Math.abs(t) < 1e-9 ? "sumOffZero" : "sumOff";
  return { kind, t, l, s, m: Math.min(l, s) };
}
function trTxfSpec(sym) { const k = typeof sym === "string" ? sym.trim().toUpperCase() : ""; return Object.prototype.hasOwnProperty.call(TR_TXF_SPECS, k) ? TR_TXF_SPECS[k] : null; }
/* 台指期報價(主行程 txfQuote,5 分鐘快取):沒問到 = null。trTxfWant 在背景補問,回來的值靠金額表簽章含報價、下一輪輪詢重畫 */
const TR_TXF = { price: null, at: 0, busy: false }, TR_TXF_MS = 300000, TR_TXF_RETRY_MS = 60000;
function trTxfPrice() { return TR_TXF.price; }
// 口數 → 參考金額(TWD;同網頁 txfRefMoney):0 口 = 0;沒有報價 = null,呼叫端畫「—」,不拿口數硬乘出一個像金額的數
function trTxfRefMoney(spec, lots, price) { if (!(lots > 0)) return 0; return typeof price === "number" && price > 0 ? lots * spec.cv * price : null; }
/* 下單紀錄這一筆是不是口數單(同網頁下單紀錄 / reconciler is_lot_based):asset_spec 是 futures_contracts 或交易所是群益——
   這時 signed_diff 是口數,不是錢 */
function trOrderLots(o) { return !!o && ((!!o.asset_spec && o.asset_spec.type === "futures_contracts") || o.exchange === "capital"); }
// 群益解析後的代碼(MTX2608 / TX2608 / TM2608)→ 台指期代號,查點值用(同網頁 capitalCanon;MTX 要排在 TX 前面)
const TR_CAPITAL_PREFIX = [["MTX", "MXF"], ["TX", "TXF"], ["TM", "TMF"]];
function trCapitalCanon(sym) { const s = trCanonSym(String(sym || "").replace(/@spot$/i, "")), p = TR_CAPITAL_PREFIX.find((x) => s.indexOf(x[0]) === 0); return p ? p[1] : s; }
// 口數單的點值:單上的 asset_spec.contract_value 優先,舊列沒有就照代號查;查不到 = null(不掛名目市值)
function trOrderCv(o) { const v = o && o.asset_spec && o.asset_spec.contract_value; if (typeof v === "number" && v > 0) return v; const sp = trTxfSpec(trCapitalCanon(o && o.symbol)); return sp ? sp.cv : null; }
/* 口數輸入:只收整數(可帶千分位),空字串 = 0;小數、負數、看不懂的回 null。小數不再截成整數(spec-0.1.13 #2):
   「2.9」默默變 2 是在改曝險,請用戶自己決定幾口 */
const TR_LOTS_RE = /^(\d{1,3}(,\d{3})+|\d+)$/;
function trParseLots(s) {
  const x = String(s == null ? "" : s).trim();
  if (x === "") return 0;
  if (!TR_LOTS_RE.test(x)) return null;
  const v = Number(x.replace(/,/g, ""));
  return v <= TR_AMOUNT_MAX ? v : null;
}
// 口數看不懂的原因(同 trAmountError):null / "bad"(不是整數)/ "big"(超過 TR_AMOUNT_MAX)
function trLotsError(s) {
  if (trParseLots(s) != null) return null;
  return TR_LOTS_RE.test(String(s == null ? "" : s).trim()) ? "big" : "bad";
}
/* en 的單複數(spec-0.1.13 #4):畫面上那個數字的絕對值是 1 用單數,其餘(含 0、0.5)用複數——呼叫端傳的是取整後要顯示的數。
   zh 兩個 key 同一個字。兩個 key 都寫成字面值傳進來(字串漂移閘門只認字面值) */
function trLotsKey(n, many, one) { return typeof n === "number" && Math.abs(n) === 1 ? one : many; }
/* 確認框口數列的提醒(#1):有報價、讀得到 TWD 淨值 → 名目 > K 倍淨值才提醒;缺任何一個 → 退回看口數 ≥ spec.big。
   回 null | { kind: "notional", amt, x } | { kind: "lots" } */
function trTxfBigWarn(spec, lots, price, equity, acctCcy) {
  if (!spec || !(lots > 0)) return null;
  const m = trTxfRefMoney(spec, lots, price);
  if (m != null && acctCcy === TR_TXF_CCY && typeof equity === "number" && isFinite(equity) && equity > 0) {
    return m > LEV_T2 * equity ? { kind: "notional", amt: m, x: m / equity } : null;
  }
  return lots >= spec.big ? { kind: "lots" } : null;
}
/* 合計、它的幣別與「你淨值的幾倍」(表下合計、確認框共用;同網頁 pfRefTotal)。money(name, v) 把一列換成錢(口數列換參考金額),
   isLot(name) = 這一列是不是口數列,acct = 帳戶幣。規則:
   - 任一列換不了(null)→ 整個合計未知、不出倍數(不拿半個未知數湊加總;口數直接加會變成「淨值的 0.00x」)
   - 有錢的口數列 → 合計是 TWD;口數列跟一般列都有錢、帳戶幣又不是 TWD(讀帳失敗退成 USDT)→ 兩種幣不加總,未知
   - 倍數只在合計幣別 = 帳戶幣時才出(不跨幣別相除),沒有淨值就沒有倍數 */
function trTotals(amounts, equity, money, isLot, acct) {
  let total = 0, lot = false, other = false;
  for (const n of Object.keys(amounts)) {
    const m = money ? money(n, amounts[n] || 0) : amounts[n] || 0;
    if (m == null) return { total: null, mult: null, ccy: null };
    total += m;
    if (m) { if (isLot && isLot(n)) lot = true; else other = true; }
  }
  if (lot && other && acct !== TR_TXF_CCY) return { total: null, mult: null, ccy: null };
  const ccy = lot ? TR_TXF_CCY : acct;
  const mult = ccy != null && ccy === acct && typeof equity === "number" && equity > 0 ? total / equity : null;   // 帳戶幣未知(null)不出倍數
  return { total, mult, ccy };
}
/* 累積損益的線段(照雲端 drawOvPnl):相鄰兩點都在 0 的同一側 → 一段,顏色跟著那一側(>= 0 算綠);
   跨過 0 → 在交越點(線性內插的時間)切成兩段,各取各的顏色。回 [{ t0, v0, t1, v1, pos, cut0?, cut1? }] */
function trPnlSegments(pts) {
  const out = [];
  for (let j = 1; j < pts.length; j++) {
    const a = pts[j - 1], b = pts[j];
    if ((a.v >= 0) === (b.v >= 0)) { out.push({ t0: a.t, v0: a.v, t1: b.t, v1: b.v, pos: b.v >= 0 }); continue; }
    const f = Math.abs(a.v) / (Math.abs(a.v) + Math.abs(b.v)), tm = a.t + (b.t - a.t) * f;
    out.push({ t0: a.t, v0: a.v, t1: tm, v1: 0, cut1: true, pos: a.v >= 0 }, { t0: tm, v0: 0, cut0: true, t1: b.t, v1: b.v, pos: b.v >= 0 });
  }
  return out;
}
function trDirty(names, stored, edits) { return names.some((n) => edits[n] != null && edits[n] !== (stored[n] || 0)); }
/* ── 選擇策略 picker(spec-desktop-strategy-picker;照雲端工作頁 psOpen / psApply)──
   候選 = 有回測的 ∪ 目前在表裡的(names)。checked = 在表裡(不看金額,$0 也算);gone = 清單找不到(已存殘留,
   留在清單裡唯一用途是讓人取消勾選——雲端的 names 已把讀不到的濾掉,所以只有這台電腦會出);
   locked = Type C、不在表裡、機器端不支援(判的是「能不能加進來」,跟表列的 `stored[n] > 0` 是「能不能從 0 撥錢」不同;
   已在表裡的存量不鎖,不然存不回去)。顯示名 localeCompare 排序(§13-3:列上畫的是顯示名,照內部名排會像亂的)。 */
function trPickRows(list, names, canTrade, paper, txfOnly) {
  const by = {}; list.forEach((x) => { by[x.name] = x; });
  const seen = new Set(names); list.forEach((x) => { if (x.hasBacktest) seen.add(x.name); });
  return [...seen].map((n) => { const x = by[n], inCur = names.indexOf(n) >= 0;
    // 模擬交易是 USDT 帳戶:台幣計價的標的(台指期、台股)進不來(e2e 0.1.8 #91:台指期那一列的金額其實是口數、畫面寫 USDT)。
    // 統一期貨只下台指期:標的不是 TXF / MXF / TMF 的(BTCUSDT、台股、組合)進不來——runtime _cmd_amounts 存的時候也擋(NOT_TXF)。
    // 已在表裡的存量不鎖(鎖住就取消不了),只帶原因;跟 Type C 同時成立時只講這一條——它是更根本的原因
    const twd = paper === true && !!x && x.twd === true, txf = txfOnly === true && !!x && !trTxfSpec(x.symbol), typeC = !!x && !!x.portfolio && !inCur && !canTrade;
    return { name: n, display: x && x.displayName ? x.displayName : n, checked: inCur, gone: !x, locked: typeC || ((twd || txf) && !inCur),
      note: twd ? (inCur ? "twdKeep" : "twd") : txf ? (inCur ? "txfKeep" : "txf") : typeC ? "typeC" : null }; })
    .sort((a, b) => a.display.localeCompare(b.display));
}
/* 這支策略的標的是不是台幣計價:台指期(TXF / MXF / TMF,runtime command_listener._TXF_ASSET_SPECS 那三個)或台股代號
   (4–6 位數字,可帶一個英文字尾:2330、00878、00631L;帶 .TW / .TWO 也算)。syms = 單一標的與組合的標的清單;看不出來 = 不是(不擋) */
const TR_TWD_RE = /^(?:TXF|MXF|TMF|\d{4,6}[A-Z]?(?:\.TWO?)?)$/;
function trIsTwd(syms) { return (Array.isArray(syms) ? syms : [syms]).some((s) => typeof s === "string" && TR_TWD_RE.test(s.trim().toUpperCase())); }
// 程式碼頂層的 UNIVERSE = [...](Type C 的標的清單;stats.json 不帶)。只收字面字串,動態組出來的讀不到 = 空陣列
function trUniverse(code) {
  const m = /^UNIVERSE\s*=\s*\[([^\]]*)\]/m.exec(typeof code === "string" ? code : "");
  return m ? (m[1].match(/["'][^"']{1,32}["']/g) || []).map((s) => s.slice(1, -1)) : [];
}
/* 「確定」之後立刻送的那一份:$0 的兩個方向——勾了、不在 stored 的以 0 加進去(策略進 cron、呼吸點亮);
   取消勾選、金額 ≤ 0 的拿掉 key(移出、點熄)。**有錢而被取消勾選的還在裡面**:那會平倉,留到儲存的確認框。
   沒有 $0 變動回 null(只關框、什麼都不送)。
   keep = 雲端讀不到的存量(trPickKeep):框裡沒列、用戶沒看到,既不算移出也不算 staged,原樣帶著送(同 trAmountsToSend 的 keep)。 */
function trPickApply(picked, stored, keep) {
  const k = Array.isArray(keep) ? keep : [];
  const added = [...picked].filter((n) => !(n in stored)), removedZero = Object.keys(stored).filter((n) => !picked.has(n) && !(stored[n] > 0) && k.indexOf(n) < 0);
  if (!added.length && !removedZero.length) return null;
  const amounts = {};
  Object.keys(stored).forEach((n) => { if (removedZero.indexOf(n) < 0) amounts[n] = stored[n]; });
  added.forEach((n) => { amounts[n] = 0; });
  return { added, removedZero, amounts };
}
// 有錢、被取消勾選、還沒送出的(儲存列要出、確認框要講平倉)。picked 為 null = 跟著 stored 走,沒有 staged;keep 同上
function trPickStaged(picked, stored, keep) { const k = Array.isArray(keep) ? keep : []; return picked ? Object.keys(stored || {}).filter((n) => stored[n] > 0 && !picked.has(n) && k.indexOf(n) < 0) : []; }
// picker 兩支的 keep:雲端 = trHidden(picked 就是表上的名單:雲端的 names 已濾過清單,結果同);這台電腦的清單可信,沒有
function trPickKeep(env, picked, stored, list) { return env === "cloud" ? trHidden(picked ? [...picked] : [], stored, list) : []; }
function trSetEq(a, b) { const s = new Set(b); return a.size === s.size && [...a].every((n) => s.has(n)); }
function trCanonSym(s) { return String(s || "").replace(/-/g, "").toUpperCase(); }
function trCanonKey(k) { k = String(k || ""); const spot = /@spot$/i.test(k); return trCanonSym(k.replace(/@spot$/i, "")) + (spot ? "@spot" : ""); }
function trSigned(p) {
  const size = p && typeof p.size === "number" ? p.size : 0;
  if (p && (p.side === "long" || p.side === "buy")) return size;
  if (p && (p.side === "short" || p.side === "sell")) return -size;
  return 0;
}
/* 金額表裡投資組合策略(Type C)那一列(設計稽核 005 第 5 條,Wei 選多空合計):標的欄寫「{n} 個標的」,目標部位 = Σ|金額 × 權重|
   (現貨的負權重壓 0,同 trClientTargets)——多空混在一起,不上買賣色;各標的的方向在下面「交易所部位」表。不是投資組合回 null */
function trPortfolioRow(st, amount) {
  const w = st && st.weights && typeof st.weights === "object" && !Array.isArray(st.weights) ? st.weights : null;
  if (!w) return null;
  const syms = Object.keys(w), a = Number(amount) || 0;
  let gross = 0;
  syms.forEach((k) => { let x = Number(w[k]); if (!isFinite(x) || (st.market === "spot" && x < 0)) x = 0; gross += Math.abs(a * x); });
  return { n: syms.length, syms, gross };
}
// 目標部位 = 已存金額 × 訊號,按標的加總(同機器端 aggregate;現貨不能做空,負的壓 0)
function trClientTargets(amounts, states) {
  const out = {};
  Object.keys(amounts || {}).forEach((n) => {
    const s = (states || {})[n];
    // 投資組合(Type C,lib/runner.typec_live_state):每個資產 金額 × 權重,現貨的負權重壓 0(同 lib/portfolio.aggregate_portfolio)
    if (s && s.weights && typeof s.weights === "object") {
      Object.keys(s.weights).forEach((sym) => {
        let w = Number(s.weights[sym]); if (!isFinite(w)) w = 0;
        if (s.market === "spot" && w < 0) w = 0;
        const k = trCanonSym(sym) + (s.market === "spot" ? "@spot" : "");
        out[k] = (out[k] || 0) + amounts[n] * w;
      });
      return;
    }
    if (!s || !s.symbol) return;
    const pos = typeof s.position === "number" ? s.position : 0;
    const k = trCanonSym(s.symbol) + (s.market === "spot" ? "@spot" : "");
    out[k] = (out[k] || 0) + amounts[n] * pos;
  });
  Object.keys(out).forEach((k) => { if (/@spot$/.test(k) && out[k] < 0) out[k] = 0; });
  return out;
}
/* 只管自己的部位(回報 self_ledger === true,lib/portfolio.own_positions_only):對帳器拿目標去比的是 Blave 的帳本,不是交易所整個帳戶。
   帳本在對帳快照的 ledger(size = 成本)。還沒有(新規則的第一輪還沒跑)就照機器端第一輪那條規則先算:
   有金額的策略在交易、同方向 → min(|帳戶|, |目標|),其餘是用戶的(lib/portfolio._auto_baseline)。
   回 { book, unmanaged }:unmanaged = 帳戶上有、帳本上這個標的完全沒有 → 中性的「不歸 Blave 管」列。
   帳本有一部分、帳戶多出來的那一份不另列:成本對市值換不出準確的手動量 */
function trOwnBook(last, account, target) {
  const book = {}, unmanaged = {}, led = last && last.ledger && typeof last.ledger === "object" ? last.ledger : null;
  if (led) Object.keys(led).forEach((k0) => { const v = trSigned(led[k0]); if (v) book[trCanonKey(k0)] = v; });
  else Object.keys(account).forEach((k) => {
    const a = account[k], t = target[k] || 0;
    if (a * t > 0) book[k] = Math.sign(a) * Math.min(Math.abs(a), Math.abs(t));
  });
  Object.keys(account).forEach((k) => { if (account[k] && !book[k]) unmanaged[k] = account[k]; });
  return { book, unmanaged };
}
// 這一列現在走哪一側的門檻(雲端 pfGateSide,兩邊同一條規則):減倉腿 = |實際| > |目標|
function trGateSide(g, tgt, act) {
  if (!g) return null;
  if (typeof g.entry_usd === "number" && typeof g.reduce_usd === "number") {
    const reduce = Math.abs(act) > Math.abs(tgt), side = reduce ? g.reduce_usd : g.entry_usd;
    // 全平或翻向只過平坦地板(lib/portfolio 的 applied = min(該側, close_usd)):拿半口去比,會把一筆真的會送出的平倉畫成「不會動」。
    // 舊 lib 的快照沒有 close_usd:缺席或不是有限正數就照舊用該側——不能讓 min 算出 NaN / 0 把每一列都畫成會成交
    const closes = act !== 0 && (tgt === 0 || tgt * act < 0), cu = g.close_usd;
    const useClose = closes && typeof cu === "number" && isFinite(cu) && cu > 0 && cu < side;
    // 同向且兩邊都有倉:漂移容忍帶是該側門檻之上的第二道地板(lib/portfolio 的 applied = max(該側, band_usd));
    // 帶內的差額只是 mark 在動、不是部位缺口,畫成綠「買/賣」會讓 trLiveOrderErr 把舊拒單當成仍欠著。
    // 與全平/翻向互斥(那邊不看帶);缺 band_usd 或不是有限正數 = 舊快照,照該側
    const bu = g.band_usd, useBand = act !== 0 && tgt * act > 0 && typeof bu === "number" && isFinite(bu) && bu > 0 && bu > side;
    return { usd: useClose ? cu : useBand ? bu : side, reduce, close: useClose, band: useBand };
  }
  if (Math.abs(act) > Math.abs(tgt)) return null;
  return typeof g.usd === "number" ? { usd: g.usd, reduce: false } : null;
}
// epoch 秒或 ISO 字串 → 毫秒;解不了回 null(orders.jsonl 與狀態檔兩種慣例都有)
function trMs(ts) {
  if (typeof ts === "number" && isFinite(ts)) return ts * 1000;
  if (typeof ts !== "string" || !ts) return null;
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : ts + "Z");
  return isNaN(d.getTime()) ? null : d.getTime();
}
/* 金額看不懂的原因(設計 v4 §1)。null = 看得懂;"bad" = 不是數字;"big" = 是數字但超過 TR_AMOUNT_MAX。不改 trParseAmount 的回傳(別處還在用) */
function trAmountError(s) {
  if (trParseAmount(s) != null) return null;
  const x = String(s == null ? "" : s).trim().replace(/^\$\s*/, "");
  return /^(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?$/.test(x) && /\d/.test(x) ? "big" : "bad";
}
/* 去向行「{where} · {money} · {venue}」:沒交易所(B0)時後兩段是空的,不留「雲端 ·  · 」(round-2 稽核 B2) */
function trWhereTidy(s) { return String(s || "").split("·").map((x) => x.trim()).filter(Boolean).join(" · "); }
/* 確認框的淨值:金額表上那行「你淨值的 N x」畫的時候用的那一個(同一個視角才算);沒畫過 / 讀不到才用現在的 */
function trShownEquity(shown, env, now) { return shown && shown.env === env && typeof shown.v === "number" && isFinite(shown.v) ? shown.v : now; }
/* lib 的錯誤訊息帶的 token(lib/account_okx、order_okx 的 [okx_account_mode];order_gateio 的 [gateio_price_deviated])→ 那一種。
   訊息開頭本來就是給人看的中文,token 才是畫面認的東西:en 介面也要有一句,中文介面不出後面那串交易所原文。認不得回 null */
function trErrToken(err) {
  const e = String(err == null ? "" : err);
  // lib/order_reject 的拒單分類(spec-0.1.13-order-copy #14):lib 放在最前面、六種之一;舊 lib 沒有 → 照舊認下面那兩個或原文
  const r = /^\[order_reject:(insufficient_margin|below_min_size|symbol_unavailable|key_permission|reduce_only_rejected|paper_margin)\]/.exec(e);
  if (r) return r[1];
  const m = /\[(okx_account_mode|gateio_price_deviated)\]/.exec(e);
  return m ? m[1] : null;
}
// 拒單分類 → 那一句的 key(每句自己帶標的)
const TR_REJECT_TEXT = { insufficient_margin: "tr.err.margin", below_min_size: "tr.err.minSize", symbol_unavailable: "tr.err.symbol",
  key_permission: "tr.err.key", reduce_only_rejected: "tr.err.reduceOnly", paper_margin: "tr.err.paperMargin" };
/* 拒單原文 → { kind, … }:lib 的 token 先認;lib/order_paper.py 比對英文原文是權宜(之後 order_errors[] 有 code 欄位就改認 code)。比不到回 null */
function trOrderErrParse(err) {
  const tok = trErrToken(err);
  if (tok) return { kind: tok };
  const e = String(err == null ? "" : err), m = /gross notional (\d+(?:\.\d+)?) exceeds (\d+(?:\.\d+)?)× paper equity (\d+(?:\.\d+)?)/.exec(e);
  if (m) return { kind: "paperLev", gross: +m[1], x: m[2], cap: +m[2] * +m[3] };
  return /paper account equity would be <= 0/.test(e) ? { kind: "paperBroke" } : null;
}
/* trExecState 的 "dead" 分兩種(§7):監督者被叫去跑(wanted)卻沒在跑 = 異常("died");否則 = 你還沒按啟動("off")。
   舊狀態檔沒有 wanted、雲端沒有 daemon 區塊 → 都當成正常那一種(寧可少叫一次) */
function trDeadKind(report) {
  const sup = report && report.daemon && report.daemon.reconciler;
  return sup && sup.wanted === true ? "died" : "off";
}
/* 這個標的是不是按**口數**算的(群益 / futures_contracts)。判斷逐字照機器端 lib/portfolio.py:1080-1081:
   target 的 asset_spec.type === "futures_contracts",或 target / actual 任一邊的 exchange 是 capital。
   兩邊都吃是因為快照的 target 與 actual 各自帶 exchange(_write_reconcile_snapshot 寫的是 full_target)。
   **不可以拿「沒有 gate」當口數訊號**(稽核 B0 複查):lib/portfolio.py:1119 是「兩側門檻都等於 flat(預設 10)就不寫 gates」,
   而那是一般加密標的的**常態**——用 !gs 會把每一條加密列都當成口數列。 */
function trIsLot(last, sym) {
  const pick = (o) => { if (!o || typeof o !== "object") return null; const k = Object.keys(o).find((x) => trCanonKey(x) === sym); return k == null ? null : o[k]; };
  const t = pick(last && last.target), a = pick(last && last.actual);
  const spec = t && typeof t === "object" ? t.asset_spec : null;
  return (spec && typeof spec === "object" && spec.type === "futures_contracts")
    || (t && typeof t === "object" && t.exchange === "capital") || (a && typeof a === "object" && a.exchange === "capital");
}
/* 表底那行紅字要不要出。`order_errors` 是「最近 5 筆下單失敗」,機器端**從來不清**(lib/portfolio._record_order_error 只 append、留最後 5 筆),
   所以照最新那一筆畫 = 把一筆歷史當成現況:用戶把金額從 110,000 改成 20,000、單也成交了,22:26 那句「部位要到 110,000…」
   還掛在寫著 20,000 的表下面,兩個數字互相矛盾(Wei 在 Electron 44 實機看到的)。
   規則:**只顯示還沒被解決的那一筆**——它的標的現在仍然有一筆會觸發下單的差額(= 那張沒送出去的單還欠著)。
   單真的沒成交 → 差額還在 → 照樣叫人;改了金額或後來補成交 → 差額進門檻內 / 歸零 → 這筆失敗已經是歷史。
   歷史不會不見:總覽的事件清單照舊逐筆列(那裡每一列都有時間,讀起來就是 log)。
   pending = 這張表上還有可下單差額的標的(canon 過的 key)。回最後一筆還沒解決的,沒有就 null。 */
function trLiveOrderErr(errs, pending) {
  if (!Array.isArray(errs) || !pending || !pending.size) return null;
  for (let i = errs.length - 1; i >= 0; i--) {
    const e = errs[i];
    if (e && typeof e === "object" && pending.has(trCanonKey(e.symbol))) return e;
  }
  return null;
}
/* 掛出來的那一筆用紅字現在式、還是灰字「上次」(帶時間)。紅字要三件都成立(0.0.3 實機:兩天前那筆 110,000 一按啟動就變紅):
   ① 對帳器在跑(或重開沒停住);
   ② 它是**最近一輪對帳**的失敗——lib/portfolio 每一輪先寫 last_reconcile.json 再下單、持續失敗每輪都會再記一筆,
      所以這一輪的失敗 ts ≥ 快照 ts;比快照舊 = 之後又對帳過一輪、沒再失敗在它上面;
   ③ 不是在這個視角這次按「啟動下單」之前發生的(按下到第一輪對帳之間,上一段的失敗還是「最近一輪」那筆)。
   時間讀不出來(舊檔 / 壞欄位)就不降:失敗不能被講小 */
function trErrLoud(e, headState, startAt, lastRec) {
  if (headState !== "running" && headState !== "unconfirmed") return false;
  const em = trMs(e && e.ts), lm = trMs(lastRec && lastRec.ts);
  if (em == null) return true;
  if (lm != null && em < lm) return false;
  return !(startAt && em < startAt);
}
/* 「上次下單失敗」前面的時間(同雲端 pfErrStamp):HH:mm;逾 24 小時帶日期 MM/DD HH:mm——對帳器掛掉的失敗多半已經隔天,
   沒有日期的話 22:26 讀起來像今天。解不了回 null(那一行就不帶時間) */
function trErrStamp(ts, nowMs) {
  const ms = trMs(ts);
  if (ms == null) return null;
  const d = new Date(ms), p = (n) => String(n).padStart(2, "0"), hm = p(d.getHours()) + ":" + p(d.getMinutes());
  return nowMs - ms > 86400000 ? p(d.getMonth() + 1) + "/" + p(d.getDate()) + " " + hm : hm;
}
/* 機器拒絕的格式 `CODE: 「資料夾名」中文句`(runtime command_listener 的 TYPE_B;同綁定錯誤的代碼慣例)→ { code, name }。
   \u300c / \u300d = 「 」。認不得回 null */
const TR_REJECT_CODE_RE = /^(?:[A-Za-z]*Error:\s*)?([A-Z][A-Z0-9_]+): \u300c([A-Za-z0-9_-]{1,64})\u300d/;
function trRejectCode(err) { const m = TR_REJECT_CODE_RE.exec(String(err == null ? "" : err)); return m ? { code: m[1], name: m[2] } : null; }
// 其餘拒絕照原文放進「沒有接受這個指令(…)」:去掉 Python 的例外名與開頭的代碼(同 trAskAccount、網頁)
function trRejectText(err) { return String(err == null ? "" : err).replace(/^(?:[A-Za-z]*Error: )?(?:[A-Z][A-Z0-9_]+: )?/, ""); }
/* 部位表點策略名的落點(spec-0.1.12-pf-strategy-link §2):Type C 的進出場紀錄只有一句叫人去看回測數據,直接落那裡。
   沒有回測退程式碼、時光機退回測數據,由 rpTab / verShowTab 自己處理 */
function trStratTab(x) { return x && x.portfolio ? "bt" : "tr"; }
/* ── 純邏輯到此 ─────────────────────────────────────────────── */

/* ── 視角純邏輯(「這台電腦｜雲端」;tests/check_shell_envsw.js 從原文切出來跑,這一段不准碰 DOM / window)──────
   傳輸層:每個視角一份**同介面**的 api,自動下單頁換一個來源就能畫(雲端回的形狀跟本機 status() 相同)。
   雲端的寫入走主行程的 cloudSend(→ cloudcmd.js → api 的指令佇列),**永遠不碰 host.tradeSend**:那支是寫這台電腦的。
   白名單在這裡再擋一層(主行程也擋一次):`credentials` 不在裡面——金鑰不經過這條通用路,只走專用的連接 IPC。
   權益曲線走主行程的 cloudOverview(平台每小時的快照,/cloud/overview)、組合績效走 cloudPerformance(/cloud/performance);
   讀不到就說讀不到,**不可以**退回去打本機的(那會把這台電腦的數字畫在雲端那一頁)。這台電腦沒有組合績效這一份(tradePerformance 回 null)。
   事件清單走 cloudEvents(平台的事件流);單支策略的報告走 cloudStrategy(點一支打一次、不落地)。 */
const ENV_API = ["tradeStatus", "listStrategies", "loadStrategy", "tradeEquity", "tradeEvents", "tradeSend"];
/* 雲端送得出去的指令:**只開真的有 UI 在用的**(稽核 S-2)。`amounts` = 雲端填金額(S4);`delete_strategy` = 雲端側欄的刪除;
   `credentials_remove` / `retest_accounts` = 雲端設定分頁(S5)。`credentials` 永遠不在這裡:金鑰只走主行程專用的 cloud-connect。
   沒有 `update` / `restart_reconciler`:用本機 app 不觸發雲端 agent 回合(Wei 09-22)。主行程還會再擋一次(CLOUD_SHIPPED,兩份逐項相等)。 */
const ENV_CLOUD_CMDS = ["halt", "close_all", "resume", "resume_wait", "amounts", "delete_strategy", "credentials_remove", "retest_accounts", "book_account_confirm", "version_restore"];
function envApi(env, host) {
  if (env !== "cloud") { const o = { env: "local" }; ENV_API.forEach((k) => { o[k] = (...a) => host[k](...a); });
    /* 事件清單兩個視角同一個形狀 { code, events }。這台電腦永遠是 OK:那是本機檔案,檔不在就是真的沒發生過事
       (daemon.js events() 自己的定義),沒有「讀得到 / 讀不到」這個分別——網路那一邊才有。 */
    const raw = o.tradeEvents; o.tradeEvents = async (...a) => { const ev = await raw(...a); return { code: "OK", events: Array.isArray(ev) ? ev : [] }; };
    // 權益曲線同一個形狀 { code, curve, today, … }:這台電腦是宿主讀自己的檔,同樣永遠 OK(宿主拋出來的才是讀不到,原樣往上拋)
    const rawEq = o.tradeEquity; o.tradeEquity = async (...a) => { const cv = await rawEq(...a); return { code: "OK", ...(cv && typeof cv === "object" ? cv : { curve: [] }) }; };
    o.tradePerformance = async () => null;   // 這台電腦沒有這一份(null = 沒有這個區塊,不是讀不到)
    return o; }
  let last = null;
  return {
    env: "cloud",
    tradeStatus: async () => { last = await host.cloudStatus(); return last; },
    listStrategies: async () => envCloudList(last),
    // 形狀同主行程 loadStrategy({ name, displayName, description, stats, code });讀不到 / 雲端沒有這一份都是 null——報告頁沒有「讀不到」這一態,由呼叫端收掉選取
    loadStrategy: async (name) => { const r = await host.cloudStrategy(name); return r && r.code === "OK" && r.strategy ? r.strategy : null; },
    // 讀不到(同下)就說讀不到,**不可以**當成「還沒有權益紀錄」;主行程已把 api 的形狀對成這台電腦那一份
    tradeEquity: async (q) => { const cv = await host.cloudOverview(q);
      return cv && cv.code === "OK" && cv.curve && Array.isArray(cv.curve.curve) ? { code: "OK", ...cv.curve } : { code: "UNREACH", curve: [] }; },
    // 組合績效六格 + 平台算好的累積損益曲線;讀不到就說讀不到(perfErr),不退回本機推算的數字冒充
    tradePerformance: async (q) => { const pf = await host.cloudPerformance(q);
      return pf && pf.code === "OK" && pf.perf && pf.perf.metrics ? { code: "OK", ...pf.perf } : { code: "UNREACH" }; },
    // 讀不到(401 / 429 / 5xx / 連不上 / 壞回應 / 主行程拒絕)就說讀不到,**不可以**當成「這段期間沒有事件」
    tradeEvents: async (q) => { const ev = await host.cloudEvents(q);
      return ev && ev.code === "OK" && Array.isArray(ev.events) ? { code: "OK", events: ev.events } : { code: "UNREACH", events: [] }; },
    /* requestId:重試時把上一趟回傳那顆原樣帶回來(冪等;不沿用的話 close_all 會跑兩次)。
       回傳形狀同本機的 { ok, error },另外多一個 kind(三桶)與 requestId / machineState——畫面當 optional 讀。 */
    tradeSend: async (cmd, args, requestId, _intent) => (ENV_CLOUD_CMDS.indexOf(cmd) < 0
      ? { ok: false, error: "NOT_ALLOWED", kind: "undelivered" }
      : host.cloudSend(cmd, args && typeof args === "object" ? args : {}, requestId || null)),
  };
}
// 雲端策略清單(strategies_summary)→ 跟本機 listStrategies 同形狀;標的與是不是投資組合直接帶著(沒有 loadStrategy 可問)
function envCloudList(st) {
  const a = st && st.cloud && Array.isArray(st.cloud.strategies) ? st.cloud.strategies : [];
  return a.filter((x) => x && typeof x.name === "string" && x.name).map((x) => ({
    name: x.name, displayName: typeof x.display_name === "string" && x.display_name ? x.display_name : x.name,
    hasBacktest: x.has_backtest === true, mtime: x.updated_at == null ? null : x.updated_at, sig: typeof x.sig === "string" && x.sig ? x.sig : null, remote: true,
    symbol: typeof x.symbol === "string" && x.symbol ? x.symbol : null, portfolio: x.is_portfolio === true }));
}
/* 雲端那一邊現在是哪一種(主行程 cloud.js 的 code + machine.state):
   loading(還沒問到)| signedOut(沒登入 / 舊登入沒有 app 專用密鑰 / 憑證被撤銷——都要登入才看得到)| unreach(還沒成功讀到過)|
   none | starting | stopped | running。「連不上但手上有上一份」不在這裡:那時 code 還是 OK,另外看 cloud.transient。 */
function envCloudKind(st) {
  const c = st && st.cloud;
  if (!c || !c.code) return "loading";
  if (c.code === "NO_LOGIN" || c.code === "NO_APP_SECRET" || c.code === "REVOKED") return "signedOut";
  if (c.code !== "OK" || !c.machine) return "unreach";
  return ["none", "starting", "stopped", "running"].indexOf(c.machine.state) >= 0 ? c.machine.state : "none";
}
// 錢的記號:連了模擬帳戶 = paper,連了真的交易所 = real,沒連 = null
function envMoney(st) { const id = trVenueIds(st && st.report)[0] || null; return !id ? null : id === "paper" ? "paper" : "real"; }
// 不是人按的暫停(對帳器 / 健檢 / 停機保護自己踩的):切換器上要出紅記號叫人
function envAutoHalt(st) {
  const h = st && st.report && st.report.halt;
  return !!(h && h.halted && typeof h.source === "string" && h.source && ["web", "user", "flatten"].indexOf(h.source) < 0);
}
/* 切換器一格的內容。回 { money, run, dot: null | "busy" | "bad", word: i18n key | null, sig }。
   sig = 這個「出事」是哪一件(看過才消:切過去就記下 sig,同一件事不再亮紅記號;換了一件才會再亮)。 */
/* Binance 金鑰重查出事了(主行程 binance_link 的 verdict;只有這台電腦有):真錢、單可能送不出去——標題列不可以還寫「自動下單執行中」、
   切換器不可以還亮綠點(設計師必改 6)。只是沒設白名單不算(那不是 verdict)。細節在設定分頁帳戶那一列。 */
function trKeyBad(env) { return env !== "cloud" && typeof CXF !== "undefined" && !!(CXF.bn && CXF.bn.verdict); }
// 標題下狀態行的「串接失敗」那個詞:IP 換了就把新 IP 講進去(光寫「串接失敗」用戶不知道是去 Binance 改白名單);其他 reason 照舊短詞。
// 只改呈現,判定仍是 binance_link 的 verdict;拿不到 IP(verdict.ip 只收驗過的 IPv4)就退回短詞。頂列(trShortState)不用它:那裡是短詞、en 版會被省略號切掉 IP
function cxFailWord(env) { const v = trKeyBad(env) ? CXF.bn.verdict : null; return v && v.reason === "IP_CHANGED" && v.ip ? t("cx.failIp", { ip: v.ip }) : t("cx.failShort"); }
function envCell(env, st, pending) {
  const kind = env === "cloud" ? envCloudKind(st) : "running";
  const out = { money: null, venue: null, run: false, dot: null, word: null, sig: null };
  if (kind === "loading" || kind === "unreach") return out;
  if (kind === "signedOut") { out.word = "env.st.signedOut"; return out; }
  if (kind === "none") { out.word = "env.st.none"; return out; }
  if (kind === "starting") { out.dot = "busy"; out.word = "side.starting"; return out; }
  out.money = envMoney(st); out.venue = trVenueIds(st && st.report)[0] || null;   // venue:視窗標題寫交易所名(Wei 0.0.6:不寫「真錢」)
  if (kind === "stopped") { out.dot = "bad"; out.word = "side.stopped"; out.sig = "stopped"; return out; }
  const state = trExecState(st);
  if (state === "setup") { out.word = "cap.pending"; return out; }   // 統一開通中:不是出事、不是在跑
  // 重開沒停住:錢可能正在外面跑,人在另一邊也要看得到(紅短劃 + 詞;看過一次就消,同其他出事)
  if (state === "unconfirmed") { out.dot = "bad"; out.word = "tr.cloud.mayTrade"; out.sig = "unconfirmed:" + String(st.report.reconciler.stopped.at || ""); return out; }
  // 重開停著(B):不是人按的、部位沒人管——同「下單停了,不是你按的」那一級
  if (state === "halted" && trRestartKind(st.report) === "machine") { out.dot = "bad"; out.word = "tr.halted"; out.sig = "restart:" + String(st.report.reconciler.stopped.at || ""); return out; }
  if (state === "halted" && envAutoHalt(st)) { out.dot = "bad"; out.word = "env.st.autoPaused"; out.sig = "halt:" + String(st.report.halt.at || ""); return out; }
  if (state === "dead" && !pending && trDeadKind(st.report) === "died") { out.dot = "bad"; out.word = "tr.s.died"; out.sig = "died:" + String((st.report.reconciler || {}).heartbeat_at || ""); return out; }
  // 雲端有在途的指令:切走也看得到(規格 §1.3)。排在紅短劃後面——出事比「我按的還在路上」更該先講。
  // 詞不可沿用 side.starting(那是主機在開機,不是指令在路上)
  if (env === "cloud" && pending) { out.dot = "busy"; out.word = "env.st.sending"; return out; }
  out.run = state === "running" && !pending && !trFailedIds(st.report).length && !trKeyBad(env);
  return out;
}
/* 標題列的狀態字與主鈕的字用哪個狀態(稽核 N1)。雲端的 alive=false 只代表「我不知道現在怎樣」(連不上、回報過舊),
   不是本機那種「常駐程式不在 = 真的沒在跑」:主機還在運行時,文字用上一份回報**自己說的**狀態(後面由畫面接「最後更新」),
   不可以翻成肯定句「對帳沒有在跑」、把鈕字換成「啟動下單」——用戶會以為雲端沒在下單。
   綠點、切換器的 run、側欄列尾一律不走這裡,維持保守判定(trExecState:不知道就不亮)。 */
const ENV_TRUST_MS = 60 * 60 * 1000;
function envHeadState(st, nowMs) {
  const c = st && st.cloud;
  // 看 !st.alive 而不是 transient/stale:睡眠醒來的那幾秒,主行程已經因為太久沒同步把 alive 壓成 false,但 snapshot 上兩個旗標都還沒立
  if (c && envCloudKind(st) === "running" && !st.alive) {
    // 上一份回報說的話最多信 1 小時(Wei):超過就不再用肯定句,退成「不知道」——數字照留、時間照標,但不說它在下單、也不說它停了。
    // 從來沒成功同步過(last_ok_at 為 0)= 沒有可以信的東西,同樣是不知道
    const link = c.last_ok_at > 0 ? nowMs - c.last_ok_at : Infinity;
    // 連得上、但主機上的回報器停了(stale、非連不上):last_ok_at 每一輪都是新的,量不到「那份回報本身多舊」(稽核 R3)。
    // 回報的年紀用伺服器自己的兩個時間相減(避開這台電腦與伺服器的時鐘差),再加上拿到之後過了多久;兩個年紀取較舊的
    const rep = c.stale && c.reported_at > 0 && c.server_time > 0 ? (c.server_time - c.reported_at) * 1000 + (c.fetched_at > 0 ? Math.max(0, nowMs - c.fetched_at) : 0) : 0;
    const age = link < 0 ? link : Math.max(link, rep);
    return age >= 0 && age <= ENV_TRUST_MS ? trExecState({ ...st, alive: true }) : "unknown";
  }
  return trExecState(st);
}
/* 「連續讀不到」的紅字要不要出(稽核 N2):看離上一次成功同步多久,不是數畫面讀了幾次——主行程失敗後 60 秒才重試,
   畫面每十幾秒讀的是同一份,數次數的話一次網路抖動就會出紅字。三個背景輪詢週期都沒成功才算。 */
const ENV_UNREACH_MS = 3 * 60 * 1000;
function envUnreachAlert(c, nowMs) { return !!(c && c.transient && c.last_ok_at > 0 && nowMs - c.last_ok_at > ENV_UNREACH_MS); }
/* 切換器 A 案(安靜分段):格內只留**一個**記號,掛在圖示右上角。優先序:還沒看過的出事 > 啟動中 > 下單中。
   seenSig = 這一格上次被看過的那件事;同一件事看過就不再亮紅短劃(只消記號,詞還在 title / aria-label 與那一邊的頁面上)。 */
function envCellMark(c, seenSig) {
  if (c.dot === "bad" && c.sig !== seenSig) return "bad";
  if (c.dot === "busy") return "busy";
  return c.run ? "run" : null;
}
// 錢記號與狀態詞不進格內:看得見的那一邊寫在切換器右邊那一句,另一邊的進 title 與 aria-label。回 i18n key(沒有就 null)
function envCellWords(c) { return { money: c.money === "real" ? "tr.mode.real" : c.money === "paper" ? "tr.mode.paper" : null, state: c.word || (c.run ? "tr.autoOn" : null) }; }
/* 標題描述與頂列右邊那一句用的狀態詞,要跟切換器那一格(envCell().word → tooltip / aria-label)是**同一個詞**(設計師 R2-1):
   自動暫停三處都寫「已自動暫停」——只有 tooltip 這樣寫的話,紅短劃一消就看不出它不是人按的。回 i18n key;沒有特別的詞回 null(照原本的句子)。 */
function envHeadWord(state, st) {
  if (st && st.cloud && envCloudKind(st) === "stopped") return "side.stopped";
  return state === "halted" && envAutoHalt(st) ? "env.st.autoPaused" : null;
}
/* 雲端視角、沒有主機可看時的「開通頁」現在是哪一格(規格 §3 的對照表)。兩個來源:主行程 cloud.js 的那一邊(kind)
   與帳號狀態(方案頁的 planView)。剛按下啟動的那幾秒 cloud.js 還說「沒主機」、帳號那邊已經是 starting——任一邊說啟動中就算啟動中。
   回:loading | unreach | starting | out(未登入)| relogin(舊登入要重登)| card(沒綁卡)| start(可以啟動)| unknown(帳號狀態還沒到 / 兩邊對不上) */
function envOpenView(kind, hasTok, pv) {
  if (kind === "loading" || kind === "unreach") return kind;
  if (kind === "starting" || (hasTok && pv === "starting")) return "starting";
  if (!hasTok) return "out";
  if (kind === "signedOut") return "relogin";
  if (pv === "offer" || pv === "noTrial") return "card";
  return pv === "trial" || pv === "plan" || pv === "included" ? "start" : "unknown";
}
/* 側欄策略列名字前的綠呼吸點——逐條照網頁 workspace.html stratRunState(Wei 09-22:照網頁現在的規則):
   點 = 這支的訊號在更新,不是「對帳器在下單」。
   ① 剛存進組合的 5 分鐘內先亮(排程 / 首跑 / 回報還在路上);剛移出的 5 分鐘內先熄(回報要下一輪才少掉這個名字)
   ② 一支交易所都沒綁 = 不亮(機器端同時停掉訊號排程)
   ③ 名字在金額表裡(**不看金額大小**,同網頁 `name in amounts`)、在排程上(排程讀不到 = 不擋)、state.json 兩小時內動過
   已暫停(HALT)照亮——暫停期間訊號照更新;重開停止、可能仍在下單不另外判,交給 state 有沒有在動。
   just = { picked: {name: ms}, removed: {name: ms} }(envJustMark 記) */
const ENV_RUN_FRESH_S = 7200, ENV_JUST_MS = 300000;
function envRunDot(name, st, nowMs, just) {
  const g = just && just.picked && just.picked[name];
  if (g && nowMs - g < ENV_JUST_MS) return true;
  const x = just && just.removed && just.removed[name];
  if (x && nowMs - x < ENV_JUST_MS) return false;
  const r = st && st.report;
  if (!r || typeof r !== "object") return false;
  const vs = r.venues;
  if (vs && typeof vs === "object" && !Object.keys(vs).length) return false;
  const a = r.config && r.config.amounts;
  if (!a || typeof a !== "object" || !(name in a)) return false;
  const onSched = Array.isArray(r.scheduled) ? r.scheduled.indexOf(name) >= 0 : true;
  const s = r.states && r.states[name], at = s && s.updated_at;
  return onSched && typeof at === "number" && isFinite(at) && nowMs / 1000 - at < ENV_RUN_FRESH_S;
}
/* 呼吸點整份的前提:那台機器在跑。這台電腦 = 常駐程式活著(st.alive);雲端 = 主機 running。
   都不成立時不看 ① 的樂觀窗——沒有東西在跑,訊號不會更新 */
function envDotsUp(env, st) { return env === "cloud" ? envCloudKind(st) === "running" : !!(st && st.alive); }
/* 存金額成功後記 ①(同網頁 pfJustPicked / pfJustRemoved):新進組合的名字 = picked(並撤銷它的 removed);移出的 = removed */
function envJustMark(just, stored, sending, nowMs) {
  Object.keys(sending || {}).forEach((n) => { if (!(n in (stored || {}))) just.picked[n] = nowMs; delete just.removed[n]; });
  Object.keys(stored || {}).forEach((n) => { if (!(n in (sending || {}))) { delete just.picked[n]; just.removed[n] = nowMs; } });
  return just;
}
// 側欄雲端清單列尾的狀態字:有投入金額的才講,而且只講出事的(已停 / 可能仍在下單);正常在下單由名字前的呼吸點表示,不再寫「下單中」(Wei 09-26,同網頁側欄只有點)
function envStratWord(name, st) {
  const r = st && st.report, a = r && r.config && r.config.amounts;
  if (!a || !(a[name] > 0)) return null;
  const state = trExecState(st);
  return state === "unconfirmed" ? "tr.cloud.mayTrade" : state === "halted" ? "side.cloud.st.halted" : null;
}
/* ── 視角純邏輯到此 ───────────────────────────────────────────── */

/* 每個視角各一份狀態(spec §1.3):分頁、權益曲線的區間與模式、打到一半的金額、過場…各記各的;TR 指向「現在看得見的那一份」。
   跨 await 的流程(送指令、儲存、連接)開頭先 `const S = TR` 抓住自己那一份——等回應的時候用戶可能已經切到另一邊,
   回來的結果不可以寫進另一邊的狀態。 */
function trNewBag(env) {
  return {
    env, api: null, st: null, open: false, tab: null, landed: false,
    just: { picked: {}, removed: {} },   // 側欄呼吸點的 5 分鐘樂觀窗(envJustMark)
    pending: null,                 // { want, until }:按了啟動/暫停之後,等狀態檔自己說它變了
    reqIds: {},                    // 雲端:cmd → 上一趟的 request_id(重試沿用同一顆;收斂 / 被接受 / 被拒絕就換新的)
    list: [], listLoaded: false, meta: new Map(),     // 回測過的策略與它們的 symbol / market / 是不是 Type C
    edits: {}, save: null, saveErr: null, saveTimer: null,
    netOpen: new Set(),            // 部位表「N 支策略」展開的標的(trNetRows):重畫保留,切走分頁清掉
    picked: null,                  // picker 勾的集合(Set);null = 表跟著已存的走。儲存成功 / 還原 / 換帳號清掉

    sent: null, sentAt: 0, sentRep: null, saveUnknownAt: 0,   // 雲端:存完、報告還沒對上的那一份(只在記憶體)/ ack 當下那份報告的時間 / ack 逾時的時間
    reqFor: {}, epoch: null,       // 雲端:cmd → 那顆 request_id 綁的內容 / 上一次看到的帳號世代(cloud.js 的 epoch)
    cxSaved: null, cxPend: null,   // 雲端(S5):金鑰已存到主機、等回報的那一態 / 設定分頁按過重新測試或解除、等回報
    sig: {},                       // 各面板上次畫的資料指紋:沒變就不重畫(輸入框的焦點、捲動位置都留著)
    cx: { busy: false, err: null, retest: false }, unbinding: false,
    ov: { mode: "equity", days: 30, curve: null, curveErr: false, perf: null, perfErr: false, ui: [], uiErr: false, geo: null, at: 0 },   // curve null = 還沒讀過;curveErr = 這一輪讀不到(不是「沒有紀錄」);perf null = 沒有這一份(這台電腦)或讀不到(看 perfErr)
    bad: {},                       // 金額輸入框裡看不懂的字(name → true):有任何一格就不給儲存
    raw: {},                       // 輸入框裡打到一半 / 打錯的原字(name → 字):報告重畫時放回去,不換回上一個看得懂的值(設計稽核 B7)
    alertText: "", alertWant: null, alertSrc: null, lastSaid: null, scroll: {},
    sending: {},                   // cmd → 還在飛的那一趟(第二次按不重複送:本機寫指令檔每次都鑄新 id、close_all 不冪等)
  };
}
let TR = trNewBag("local");
const TR_BAGS = { local: TR, cloud: trNewBag("cloud") };
const TRP = { started: false, timer: null, polling: false, again: false };
const ENV = { cur: "local", cloudAt: 0, cloudDirty: true, burst: null, seen: {}, cells: {}, said: {}, sig: {} };
const ENV_POLL_SEEN = 15000, ENV_POLL_OTHER = 60000;
/* 動作後的爆發輪詢窗(同網頁 workspace.html:10372)。雲端寫入的結果只會出現在**主機的下一份報告**裡,
   而那份報告機器端一套用就推上去了(web_bridge.on_command_applied → sync_portfolio,幾秒),
   慢的是這台電腦在讀:主行程每 15 秒去要一次 /cloud/state、畫面再 15 秒才撈到手上那一份 → 實測等 15–30 秒。
   窗期間每一輪都叫主行程重抓,等待縮到約 5 秒(主行程 cloud.js 的 MIN_GAP_MS 就是那個地板:
   cloud-refresh 沒帶 force,所以真正發出去的請求最密就是 5 秒一次,畫面催得再快也追不過它)。
   **窗是時間,不是條件**:報告永遠不來也會到期,到期就回到誠實的等待畫面(標頭那句 + spinner),不會一直轉。
   連續存檔只把到期時間往後推,但總長有上限(BURST_MAX_MS):一直改金額不會變成無限快輪詢。 */
const TR_BURST_MS = 30000, TR_BURST_MAX_MS = 90000;
function trBurstBump(burst, now, ms, maxMs) {
  const b = burst && burst.until > now ? burst : { start: now, until: 0 };   // 上一個窗過期了就是新的一次
  const cap = b.start + (maxMs || TR_BURST_MAX_MS);
  return { start: b.start, until: Math.min(Math.max(b.until, now + (ms || TR_BURST_MS)), cap) };
}
function trBurstOn(burst, now) { return !!burst && burst.until > now; }
// 字串表的漂移閘門(check_shell_strings.js)只認得寫成字面值的 key:會變的 key 走這兩支,每個 key 都以字面值出現一次
const envName = (env) => (env === "cloud" ? t("env.cloud") : t("env.local"));
const envMoneyText = (m) => (m === "real" ? t("tr.mode.real") : m === "paper" ? t("tr.mode.paper") : "");
// 頂列記號與視窗標題用的那個詞(Wei 0.0.6):模擬 = 「模擬」記號,真的交易所 = 交易所名(Binance / OKX…),不再寫「真錢」
const envVenueText = (money, venue) => (money === "paper" ? t("tr.mode.paper") : money === "real" ? trVenueLabel(venue, true) : "");
// 同步的畫面函式借另一邊的狀態跑一次(過場檢查永遠看本機那一份)
function trWith(bag, fn) { const prev = TR; TR = bag; try { return fn(); } finally { TR = prev; } }
const TR_POLL_OPEN = 4000, TR_POLL_IDLE = 15000, TR_POLL_PENDING = 2500, TR_CONFIRM_MS = 60000;
/* 雲端版的「等它自己說它變了」要多久才算沒到。本機是讀自己的狀態檔,秒級;雲端這條鏈是
   ack(最多 20 秒)→ 主機下一次回報 → app 這邊的狀態輪詢(前景 15 秒)。
   回報那一段的權威來源是 `api/blave_agent/systemd/blave-agent-portfolio.timer`:`OnUnitActiveSec=120`,
   而且**沒設 `AccuracySec`**(systemd 預設 1 分鐘)→ 實際落在 120–180 秒,再加那一班自己跑掉的時間。
   最壞鏈 ≈ 155–215 秒,所以 180 秒是落在區間**中間**,不是上緣。取 4 分鐘。
   **寧可久也不要早收**:早收的代價是對一個其實已經執行的暫停講假話,而且每一次逾時都會把 reqIds 清掉
   (見 trPendingCheck)、讓下一次重按變成真的再執行一次;晚收的代價只是鈕多轉一會兒。 */
const TR_CONFIRM_CLOUD_MS = 240000;
const TR_TABS = ["over", "pos", "assets", "hist", "set"];
const TR_TAB_FEATURE = { over: "trade_overview", pos: "trade_positions", assets: "trade_assets", hist: "trade_history", set: "trade_settings" };   // 使用追蹤的名字(feature_used)
const PAPER = "paper", BINANCE = "binance", CAPITAL = "capital";   // 群益只在雲端視角(renderer/capital.js)
/* 連接框列得出來的真實交易所(env 名同 cloudcmd.CONNECT_VENUES、網頁 CX_VENUES;群益在 Mac 上跑不起來,不列)。
   pass = 多一格 <ENV>_PASSPHRASE。CX_LOCAL_REAL = 這台電腦綁得了的(runtime local_daemon 放行的那幾家;另外四家的金鑰
   由 command_listener._local_real_key_gate 在寫入前讀一次帳戶)。noWdCheck = 那家的 API 查不到自己有沒有提領權限
   (runtime _WITHDRAW_CHECKED 沒列的那幾家;tests/check_shell_connect_venues 釘兩邊一致),連接框多講一句要用戶自己確認 */
/* ccy = 那家 lib/account_*.py get_equity 回的幣別(字面值;BingX 是動態 row.asset,這裡是它的預設值)。
   讀帳失敗時 runtime 寫 currency: null,畫面靠它推幣別(tests/check_venue_ccy.py 逐支對 lib) */
const CX_VENUES = { binance: { label: "Binance", env: "BINANCE", ccy: "USDT" }, okx: { label: "OKX", env: "OKX", pass: true, ccy: "USD" },
  bingx: { label: "BingX", env: "BINGX", ccy: "USDT" }, gateio: { label: "Gate.io", env: "GATEIO", noWdCheck: true, ccy: "USDT" }, bybit: { label: "Bybit", env: "BYBIT", ccy: "USDT" } };
const CX_LOCAL_REAL = ["binance", "okx", "bingx", "gateio", "bybit"];
const cxVenuesFor = (env) => Object.keys(CX_VENUES).filter((id) => env === "cloud" || CX_LOCAL_REAL.indexOf(id) >= 0);
// 不在連接框那五家裡的三個帳戶(lib/account_paper.py、account_capital.py、account_president.py)
const TR_VENUE_CCY_OTHER = { paper: "USDT", capital: "TWD", president: "TWD" };
// 讀不到帳戶幣時的退路:那家的固定幣別;自訂交易所查不到 = null(畫面不帶幣別、不出倍數,改講 tr.ccyUnknown)
function trVenueCcy(id) {
  if (Object.prototype.hasOwnProperty.call(TR_VENUE_CCY_OTHER, id)) return TR_VENUE_CCY_OTHER[id];
  return Object.prototype.hasOwnProperty.call(CX_VENUES, id) && CX_VENUES[id].ccy ? CX_VENUES[id].ccy : null;
}

function trEl(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
function trReport() { return (TR.st && TR.st.report) || null; }
function trVenueId() { return trVenueIds(trReport())[0] || null; }
// 給人看的交易所名:這一版只有模擬交易;其餘 id 首字大寫(同雲端 venueLabel 的退路)
function trVenueLabel(id, short) {
  if (!id) return "";
  if (id === PAPER) return short ? t("cx.paperShort") : t("cx.paper");
  if (id === "capital") return t("cap.venue");   // 群益(雲端視角,renderer/capital.js)
  if (id === "president") return t("pres.venue");   // 統一期貨(這台電腦視角,renderer/president.js)
  if (Object.prototype.hasOwnProperty.call(CX_VENUES, id)) return CX_VENUES[id].label;   // Gate.io、OKX:首字大寫會寫錯
  return id.charAt(0).toUpperCase() + id.slice(1);
}
function trIsPaper() { return trVenueId() === PAPER; }
function trCcy() { const id = trVenueId(), e = trLiveEntry(trReport(), id); return (e && e.currency) || trVenueCcy(id); }
// 單位:模擬帳戶寫「模擬 USDT」(三通道之一:記號、外框、單位)
function trUnit() { return trCcy(); }   // 「模擬」記號只留頂列與動到錢的確認框標題;單位寫幣別本身(同雲端版)
// 數字後面接帳戶幣;幣別未知(null)就只有數字
function trWithUnit(s) { const c = trUnit(); return c ? s + " " + c : s; }
function trEquity() { const e = trLiveEntry(trReport(), trVenueId()); return e && e.ok ? trLiveTotal(e) : null; }
function trFmt(v, signed) {
  if (typeof v !== "number" || !isFinite(v)) return null;
  const a = Math.abs(v), dp = Math.abs(a - Math.round(a)) < 0.005 ? 0 : 2;
  const s = a.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  if (!signed) return (v < 0 ? "-" : "") + s;
  return (Math.round(a * 100) === 0 ? "" : v > 0 ? "+" : "-") + s;
}
function trFmt2(v, signed) {
  if (typeof v !== "number" || !isFinite(v)) return null;
  const s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (v < 0 ? "-" : signed && v > 0 ? "+" : "") + s;
}
function trFmtPrice(v) {
  if (typeof v !== "number" || !isFinite(v) || v <= 0) return null;
  return v.toLocaleString("en-US", { minimumFractionDigits: v < 10 ? 4 : v < 1000 ? 2 : 1, maximumFractionDigits: v < 10 ? 4 : v < 1000 ? 2 : 1 });
}
const tr2 = (n) => String(n).padStart(2, "0");
const trMD = (d) => tr2(d.getMonth() + 1) + "/" + tr2(d.getDate());
function trStamp(ts) { const ms = trMs(ts); if (ms == null) return "—"; const d = new Date(ms); return trMD(d) + " " + tr2(d.getHours()) + ":" + tr2(d.getMinutes()); }
function trHM(ms) { const d = new Date(ms); return tr2(d.getHours()) + ":" + tr2(d.getMinutes()); }
function trMoneyInto(node, v, signed, ccy) {
  const s = trFmt(v, signed);
  node.textContent = s == null ? "—" : s;
  const c = ccy || trUnit();
  if (s != null && c) node.appendChild(trEl("span", "ccy", c));
}
// 口數格(同網頁 paintVenueLots):整數、可帶正負號、後綴「口」不跟帳戶幣;不是數字 = 「—」
function trLotsInto(node, v, signed) {
  const s = typeof v === "number" && isFinite(v) ? trFmt(Math.round(v), signed) : null;
  node.textContent = s == null ? "—" : s;
  if (s != null) node.appendChild(trEl("span", "ccy lots", t(trLotsKey(Math.round(v), "tr.lotsUnit", "tr.lotUnit"))));
}
/* 群益口數單的標的(#14):商品名(大台／小台／微台,同金額表)+ 括號帶合約代碼——換月時要對得上券商對帳單。
   只給口數單用(trOrderLots):trCapitalCanon 只看前綴,加密代號也可能剛好以 TX / TM 開頭。認不得回 false */
function trTxfSymInto(node, sym) {
  const raw = trCanonSym(String(sym || "").replace(/@spot$/i, "")), canon = trCapitalCanon(raw), sp = trTxfSpec(canon);
  if (!sp) return false;
  node.appendChild(trEl("span", "sname", t(sp.prod)));
  if (raw !== canon) node.append(LANG === "zh" ? "（" : " (", trEl("span", "mono", raw), LANG === "zh" ? "）" : ")");
  return true;
}
// 口數單實際成交的月份合約:orders.jsonl 的 symbol 是帳本 key(TXF),月份代碼在 legs[].resolved_symbol(lib 0.1.13 起);舊列沒有就用 symbol
function trOrderContract(o) { const l = (Array.isArray(o.legs) ? o.legs : []).find((x) => x && typeof x.resolved_symbol === "string" && x.resolved_symbol); return l ? l.resolved_symbol : String(o.symbol || ""); }
function trHead(cols) {
  const thead = document.createElement("thead"), row = document.createElement("tr");
  cols.forEach((c) => { const th = trEl("th", c[1], c[0]); th.scope = "col"; row.appendChild(th); });
  thead.appendChild(row); return thead;
}
let trTipSeq = 0;
// 區段標籤上的解釋:觸發點是一顆鈕(鍵盤到得了),氣泡是 app.css 的 .tip
function trTipLabel(cls, text, tip) {
  const frag = document.createDocumentFragment();
  const b = trEl("button", cls + " tr-tipb", text); b.type = "button"; b.dataset.fk = "tip:" + text;   // 重畫後找回同一顆(trPosFocusBack)
  const box = trEl("span", "tip", tip); box.setAttribute("role", "tooltip"); box.id = "tr-tip-" + (++trTipSeq);
  b.setAttribute("aria-describedby", box.id);
  frag.append(b, box); return frag;
}
function trSec(labelNode, acts) { const s = trEl("div", "pf-sec"); s.appendChild(labelNode); if (acts) s.appendChild(acts); return s; }
// 重畫一個面板之前:資料指紋沒變就跳過;焦點在這個面板裡的輸入框時也跳過(打到一半不能被輪詢洗掉)
function trShould(key, box, data) {
  const sig = LANG + "|" + JSON.stringify(data);
  if (TR.sig[key] === sig) return false;
  const a = document.activeElement;
  if (a && a.tagName === "INPUT" && box.contains(a)) return false;
  TR.sig[key] = sig; return true;
}

/* ── 輪詢 ───────────────────────────────────────────── */
// 這支檔比 app.js 先載入(app.js 的開場一路 await,會在後面的 <script> 載入之前就走到 enterWorkspace),
// 所以載入當下不碰 DOM 與 app.js 的東西:接線全部放在第一次 trInit() 裡。
function trInit() {
  if (TRP.started) return; TRP.started = true;
  TR_BAGS.local.api = envApi("local", window.blave); TR_BAGS.cloud.api = envApi("cloud", window.blave);
  trWire(); envWire(); cxWire(); psWire(); trPoll();
}
/* 選單列 / Dock / 結束攔截的字:主行程沒有翻譯表,由這裡依目前語言交過去(換語言時 app.js 的 applyStatic 會再叫一次) */
function trPushLabels() {
  if (typeof window.blave.tradeLabels !== "function") return;
  window.blave.tradeLabels({ running: t("tr.autoOn"), paperVenue: t("cx.paperShort"), pause: t("tm.pause"), open: t("tm.open"), quit: t("tm.quit"),
    notifTitle: t("tm.notifTitle"), notifBody: t("tm.notifBody"), pauseFail: t("tm.pauseFail"), pauseUnknown: t("tr.cmdUnknown"), quitTitle: t("tm.quitTitle"), quitBody: t("tm.quitBody"),
    quitGo: t("tm.quitGo"), quitStay: t("tm.quitStay"), ok: t("tm.ok"), hidden: t(window.blave.platform === "win32" ? "tm.hiddenWin" : "tm.hidden"), updateReady: t("tm.updateReady"), restarting: t("tm.restarting"),
    quitTurnTitle: t("tm.quitTurnTitle"), quitTurnBody: t("tm.quitTurnBody"),   // 結束攔截:本機 agent 回合還在跑
    presQuitTitle: t("pres.quit.title"), presQuitBody: t("pres.quit.body", { lots: "{lots}" }),   // 結束攔截:統一還有部位(主行程填口數)
    updateBody: t("tm.updateBody"), moveTitle: t("tm.move.title"), moveBody: t("tm.move.body"), moveGo: t("tm.move.go"), moveNo: t("tm.move.no"),   // 下單中重新啟動更新的確認框、搬到「應用程式」那一問
    // 本機 P1 通知的字:跟總覽時間軸同一組(trEventText),只有拒單的註解是通知專用
    ev_halt: t("tr.ov.evHaltAuto"), ev_halt_n: t("tr.ov.evHaltNote"), ev_order_error: t("tr.ov.evErr"), ev_order_error_n: t("tm.evOrderErrNote"),
    ev_execution_interrupted: t("tr.ov.evExecInterrupted"), ev_execution_interrupted_n: t("tr.ov.evExecInterruptedNote"),
    ev_execution_fallback_market: t("tr.ov.evExecFallback"), ev_execution_fallback_market_n: t("tr.ov.evExecFallbackNote"),
    ev_execution_stuck: t("tr.ov.evExecStuck"), ev_execution_stuck_n: t("tr.ov.evExecStuckNote"),
    ev_machine_restart_stopped: t("tr.ov.evRestartStopped"), ev_machine_restart_stopped_n: t("tm.evRestartStoppedNote"),
    // 選單列兩行狀態、app 選單「顯示」兩項與官網、結束攔截多的那一句、通知標題的前綴(主行程:traytext.js / main.js)
    lang: LANG, stLocal: t("tm.stLocal"), stLocalOnly: t("tm.stLocalOnly"), noAccount: t("tr.noAccount"), runningZ: t("tr.runningZ"), stCloud: t("tm.stCloud"), stOn: t("tm.stOn"), stPaused: t("tm.stPaused"), stUnknown: t("tm.stUnknown"), stMayTrade: t("tm.stMayTrade"), stNotStarted: t("tr.notStarted"),
    moneyPaper: t("tr.mode.paper"), moneyReal: t("tr.mode.real"), pauseLocal: t("tm.pauseLocal"), quitCloudNote: t("tm.quitCloudNote"),
    // Binance 金鑰重查的通知(主行程 binanceNotify):這些事件只會來自這台電腦,{where} 在這裡就填好;{ip} 留給主行程填
    key_ipTitle: t("tm.key.ipTitle", { where: t("env.local") }), key_ipBody: t("tm.key.ipBody", { ip: "{ip}" }), key_rejTitle: t("tm.key.rejTitle", { where: t("env.local") }),
    key_rejSameIpBody: t("tm.key.rejSameIpBody"), key_rejUnknownBody: t("tm.key.rejUnknownBody"),
    key_permTitle: t("tm.key.permTitle", { where: t("env.local") }), key_permBody: t("tm.key.permBody"),
    notifPrefixLocal: t("tm.notifPrefixLocal"), notifPrefixCloud: t("tm.notifPrefixCloud"),
    br_captchaTitle: t("br.need.captcha"), br_captcha: t("br.notif.captcha"),   // 內建瀏覽器:搜尋要過驗證、app 不在前景(主行程 browserNotify)
    ...Object.fromEntries(TR_MENU_KEYS.map((k) => ["menu" + k.charAt(5).toUpperCase() + k.slice(6), t(k)])) });
}
// app 選單每一格的字(主行程 main.js appMenuTemplate 的 MENU_EN;字串表 menu.x → tm 的鍵 menuX)
const TR_MENU_KEYS = ["menu.about", "menu.services", "menu.hide", "menu.hideOthers", "menu.showAll", "menu.quit", "menu.file", "menu.close", "menu.edit",
  "menu.undo", "menu.redo", "menu.cut", "menu.copy", "menu.paste", "menu.pasteStyle", "menu.delete", "menu.selectAll", "menu.view", "menu.local", "menu.cloud",
  "menu.actualSize", "menu.zoomIn", "menu.zoomOut", "menu.fullEnter", "menu.fullExit", "menu.window", "menu.minimize", "menu.zoom", "menu.front", "menu.help", "menu.site"];
function trWire() {
  $("tr-tabs").addEventListener("click", (e) => { const b = e.target.closest(".main-tab"); if (b) trSetTab(b.dataset.tab); });
  $("tr-tabs").addEventListener("keydown", (e) => {
    const i = TR_TABS.indexOf(TR.tab);
    const j = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? TR_TABS.length - 1 : -1;
    if (j < 0 || j >= TR_TABS.length || j === i) return;
    e.preventDefault(); trSetTab(TR_TABS[j], true);
  });
  // 選中態看 aria-current(envShowMain 管它):雲端沒有 welcome、自動下單頁就是預設,再點一次只收展開層,其餘照舊 trOpen
  $("tr-nav").addEventListener("click", () => {
    if (!$("tr-nav").hasAttribute("aria-current")) trOpen();
    else sideReclick(ENV.cur === "local" ? trLeave : () => trOpen());
  });

  window.addEventListener("resize", () => { if (TR.open && TR.tab === "over") { TR.sig.over = null; trPaintOver(); } });
}
async function trPoll() {
  clearTimeout(TRP.timer);
  if (TRP.polling) { TRP.again = true; return; }   // 在途那一輪結束後立刻再跑一次(剛切視角:新的那一邊不必多等一輪才載入清單)
  TRP.polling = true; TRP.again = false;
  const L = TR_BAGS.local, C = TR_BAGS.cloud, S = TR_BAGS[ENV.cur], now = Date.now();
  const burst = trBurstOn(ENV.burst, now);
  try {
    /* 爆發窗:叫主行程真的去重抓一次(它自己有 5 秒地板)。**不 await**——那一支會打網路,postJSON 逾時 20 秒,
       await 它等於把整輪輪詢(含本機那一份狀態)卡住 20 秒:網路斷掉時切回這台電腦會看到凍住的狀態帶。
       抓回來的那一份下一輪(2.5 秒)就讀得到,不必這一輪等它(稽核 B-2) */
    if (burst && typeof window.blave.cloudRefresh === "function") window.blave.cloudRefresh().catch(() => {});
    try { L.st = await L.api.tradeStatus(); } catch (_) { }   // 主行程沒回:下一輪再問,畫面維持上一份
    /* 雲端:這裡問的是主行程手上那一份(不打網路;主行程自己輪詢、自己節流)。看得見雲端時每 15 秒問一次;
       看這台電腦時靠主行程的推送(onCloudState → cloudDirty)+ 60 秒一次,只為了更新切換器那一格。
       app 一開就問第一次:主行程是懶啟動,有人問了才開始輪詢。 */
    // 雲端有在途的指令時每一輪都問(這一支只拿主行程手上那一份、不打網路;主行程自己 15 秒去要一次)
    if (ENV.cloudDirty || C.pending || burst || now - ENV.cloudAt >= (ENV.cur === "cloud" ? ENV_POLL_SEEN : ENV_POLL_OTHER)) {
      ENV.cloudDirty = false; ENV.cloudAt = now;
      try {
        C.st = await C.api.tradeStatus();
        // 雲端的清單就在那份狀態裡(沒有 I/O):不管現在看哪一邊都跟著換——登出 / 換帳號之後切過去的第一幀不可以是上一個人的策略名(稽核 N5)
        // 清單缺席 ≠ 空清單(S4 §1.1 ②):只有這一份真的帶了 strategies_summary 才算載入——否則存金額會把整個組合移出
        await trLoadStrategies(C);
        C.listLoaded = trCloudListOk(C.st && C.st.cloud && C.st.cloud.strategies_ok, C.list, ((C.st && C.st.report) || {}).config ? C.st.report.config.amounts : null);
        trCloudOwnerCheck(C);
        trSentCheck(C, now);
        if (envCloudKind(C.st) === "signedOut") { C.edits = {}; C.ov.curve = null; C.ov.ui = []; C.ov.uiErr = false; C.ov.curveErr = false; C.ov.perf = null; C.ov.perfErr = false; }   // ui 與 uiErr、curve 與 curveErr 各是一組,一起清
        if (typeof rpCloudPrune === "function") rpCloudPrune(C.list);   // 看著的那支被雲端刪了 / 換了帳號:報告收掉、回自動下單頁
        if (typeof libCloudChanged === "function") libCloudChanged(C.list);   // 策略庫雲端視角的「已安裝」(renderer/library.js):清單多了那支才算下載完成
        if (typeof rpCloudWatch === "function") rpCloudWatch(C.list);   // 開著那支在平台上換了內容(回合結束後才同步到、或網頁發起的回合):補抓
        if (typeof rpWfSync === "function") rpWfSync();   // 雲端主機的 config_supports_wf 翻面:樣本外驗證分頁跟著換(落後態 ↔ 旋鈕)
      } catch (_) { }
    }
    // 策略清單另外接:它失敗不能連累狀態,也不能把「沒載入」當成「一支都沒有」(listLoaded 只有成功才會變 true)
    if (S === L && S.open) { try { await trLoadStrategies(S); S.listLoaded = true; } catch (_) { } }
    trWith(L, trPendingCheck); trWith(C, trPendingCheck);   // 兩邊各自的過場都要收(切走了照樣收斂)
    /* **不早收窗**(稽核 B-1):早收那一版只認得 C.pending 與 trAmountsPending,而雲端寫入有三種不經過它們——
       連接交易所(只設 cxSaved)、解除綁定、重新測試(只設 cxPend)——窗一開就被下一輪當場關掉,等於沒開。
       要早收就得把每一種寫入的「等到了」訊號逐一列進來,漏一個就是靜默失效。窗本來就有到期日(30 秒 / 上限 90 秒),
       那才是保證;多幾個請求換「每一種寫入都真的被加速」,划算。 */
    trPaint();
    envPaintLocalDots();
    if (typeof upPaint === "function") upPaint();   // 設定 › 關於 的雲端那一行與聊天的更新入口:讀的是這一份雲端狀態
    cxGateSlowSync();
    if (!$("cx-scrim").hidden) cxModalPaint();
  } finally {
    // 排下一輪放在 finally(稽核 N7):畫面函式就算丟例外,輪詢鏈也不能斷——斷了本機的狀態帶與綠點會凍在舊值
    TRP.polling = false;
    const cxOn = !$("cx-scrim").hidden;   // 連接交易所的框開著也算「在看」:剛連上要幾秒內看到已連接
    clearTimeout(TRP.timer); TRP.timer = setTimeout(trPoll, TRP.again ? 0 : L.pending || C.pending || trBurstOn(ENV.burst, Date.now()) ? TR_POLL_PENDING : TR_BAGS[ENV.cur].open || cxOn ? TR_POLL_OPEN : TR_POLL_IDLE);
  }
}
function trPollSoon(ms) { clearTimeout(TRP.timer); TRP.timer = setTimeout(trPoll, ms || 0); }
/* 雲端存完的金額對上了沒(S4 §3.2):對上 / 被別處改掉 → 清掉記號、照報告畫;主機不再 running → 清掉。
   逾時**不清**記號、不出紅字(Wei 拍板:ack 已經明確說寫進去了,沒對上只是回報遲了)。
   ack 逾時(結果不明)那一份:過了收斂窗口,再按就是新的意圖——request_id 在那一刻換掉(Wei 拍板)。 */
// 登出 / 換帳號(cloud.js 的 epoch 變了):上一個人的在途金額、request_id 都不是這個人的(稽核 #8)
function trCloudOwnerCheck(C) {
  const ep = C.st && C.st.cloud ? C.st.cloud.epoch : null;
  if (envCloudKind(C.st) === "signedOut" || (C.epoch != null && ep !== C.epoch)) {
    C.sent = null; C.sentRep = null; C.save = null; C.saveErr = null; C.saveUnknownAt = 0; C.reqIds = {}; C.reqFor = {}; C.sig.pos = null; C.picked = null;
    // 上一個人的過場與在途那一趟也不是這個人的:不清的話,B 按的暫停會併進 A 那一趟(trSend 單飛)而根本沒送出(稽核 M2)
    C.pending = null; C.sending = {}; C.cxSaved = null; C.cxPend = null; trAlert("", null, C);
    C.just = { picked: {}, removed: {} };   // 呼吸點 5 分鐘樂觀標記也是上一個人的
    CDEL.gone.clear(); CDEL.busy.clear(); CDEL.ids = {}; }   // 上一個人的刪除在途 / 壓抑不是這個人的
  // S5 收斂:「已存到」→ 報告裡長出交易所就換成分頁(讀屏播一次);「已送出、等回報」→ 帳戶讀取時間比送出新 / 解除的那一家消失
  const r = C.st && C.st.report;
  // 模擬帳戶在送出當下就念過「已連接」了(畫面也已經是骨架):報告追上時不再念第二次
  if (C.cxSaved && r && trHasAccount(r)) { const said = C.cxSaved.venue === PAPER; C.cxSaved = null; C.sig = {}; if (!said) srSay(t("cx.connected")); }
  if (C.cxSaved && envCloudKind(C.st) !== "running") C.cxSaved = null;
  if (C.cxPend && r) {
    const readAt = r.account && typeof r.account.read_at === "number" ? r.account.read_at * 1000 : 0;
    if ((C.cxPend.what === "retest" && readAt > C.cxPend.at) || (C.cxPend.what === "unbind" && !trHasAccount(r)) || Date.now() - C.cxPend.at > TR_CONFIRM_CLOUD_MS) { C.cxPend = null; C.sig.set = null; }
  }
  C.epoch = ep;
}
function trSentCheck(C, now) {
  if (C.saveUnknownAt && now - C.saveUnknownAt > TR_CONFIRM_CLOUD_MS) { delete C.reqIds.amounts; C.saveUnknownAt = 0; }
  if (!C.sent) return;
  const amts = (((C.st || {}).report || {}).config || {}).amounts;
  // 報告又是真相:picker 的選擇交回 stored——但「取消勾選有錢的 X」只 stage、沒跟著 $0 那趟送出,還在等儲存:對上了也不能丟
  const done = () => { C.sent = null; if (C.save === "sent") C.save = null; C.sig.pos = null; if (!trPickStaged(C.picked, amts, trPickKeep("cloud", C.picked, amts, (C.list || []).map((x) => x.name))).length) C.picked = null; };
  if (envCloudKind(C.st) !== "running") { done(); return; }
  const c = C.st.cloud || {};
  const v = trSentSettled(C.sent, amts, c.reported_at, C.sentRep);
  if (v === "wait") return;
  done();
  if (v === "same") srSay(t("tr.cloud.pendDone"));
}

/* 金額表要的三件事(標的、合約/現貨、是不是投資組合策略)不在 listStrategies 裡,從 loadStrategy 的 stats 與
   程式碼頂層常數讀;照 mtime 快取,策略沒動就不重讀。分類規則同 runtime 的 strategy_reporter.is_portfolio_stats。 */
async function trLoadStrategies(S) {
  const list = await S.api.listStrategies();
  const out = [];
  if (S.env === "cloud") S.meta = new Map();      // 雲端的 meta 全部來自清單本身、重建不花錢:不留上一個帳號同名策略的標的
  for (const x of list) {
    let m = S.meta.get(x.name);
    if (!m || m.mtime !== x.mtime) {
      // 雲端的清單自己帶著標的與類別(沒有單支策略可讀);合約 / 現貨由主機回報的 states 補
      const d = !x.remote && x.hasBacktest ? await S.api.loadStrategy(x.name) : null;
      const s = (d && d.stats) || {};
      const sym = x.remote ? x.symbol : typeof s.symbol === "string" && s.symbol ? s.symbol : null;
      const mk = /^MARKET\s*=\s*["'](spot|swap)["']/m.exec((d && d.code) || "");
      m = { mtime: x.mtime, symbol: sym, market: mk ? mk[1] : "swap",
            portfolio: x.remote ? !!x.portfolio : !sym && Object.keys(s).some((k) => k.indexOf("benchmark_") === 0),
            twd: trIsTwd([sym].concat(x.remote ? [] : trUniverse(d && d.code))) };   // 雲端清單不帶組合的標的:雲端的 Type C 看不出來
      S.meta.set(x.name, m);
    }
    out.push({ name: x.name, displayName: x.displayName || x.name, hasBacktest: !!x.hasBacktest, symbol: m.symbol, market: m.market, portfolio: m.portfolio, twd: m.twd === true });
  }
  S.list = out;
}
/* 已存的金額。**報告明寫 config: null = 主機讀不到設定檔**(可能寫到一半),回 null——不可以退成 {}:
   拿 {} 當底去存,會把主機上的整份組合覆蓋掉。config 是 {}(新機)照常回 {},第一次存要過 */
function trStored() {
  const r = trReport(); if (r && r.config === null) return null;
  const c = (r || {}).config || {}; return c.amounts && typeof c.amounts === "object" ? c.amounts : {};
}
/* 金額已經送到主機、報告還沒把它帶回來(雲端才有這一態:S.sent 只在雲端寫)。
   存檔失敗那一次不算——那時原因行要講失敗,不是講等待(spec-desktop-waiting-states §6)。 */
function trAmountsPending(bag) { const S = bag || TR; return S.env === "cloud" && !!S.sent && S.save !== "failed"; }
/* 等回報等到比平常久:換成帶數字的那一句(照 app.js 的 plan.err.slow + PLAN_SLOW_MS 那個既有形狀,不另造計時器——
   輪詢本來就每 2.5 / 4 秒重畫一次,門檻一過下一輪就換字)。
   常態那一句**不講秒數**:爆發窗之後常態約 5 秒,講了也讀完就結束;而「通常五秒」在兜底那次(推播漏掉、
   等機器自己那班報告)會讓人覺得壞了。數字只在真的慢的時候才相關,那時才出現(spec §2-3)。 */
const TR_PEND_SLOW_MS = 20000;
/* 常態句分兩版(spec §2):Z 那版說「回報進來就能啟動」——鈕真的停用;非 Z 那版只說這一頁的數字還是舊的,
   因為鈕本來就能按、也不擋(按下去機器用的是它手上那一份,那一份已經是新的了:ack 在寫檔之後才送)。
   比平常久的那一句兩版共用。 */
function trPendKey(bag, now, z) {
  const S = bag || TR;
  if (!trAmountsPending(S)) return null;
  if (S.sentAt && (now || Date.now()) - S.sentAt > TR_PEND_SLOW_MS) return "tr.cloud.startPendSlow";
  return z ? "tr.cloud.startPendAmounts" : "tr.cloud.startPendAmountsStale";
}
/* 存完之後又改過了:等回報那一句先收起來(畫面上的數字是他正在打的,不是「舊的」)。
   底稿用 trBase()——等回報期間那是送出的那一份,跟金額表、跟儲存列同一個判準(trAmountTable 的 dirty)。 */
function trAmountsEdited() {
  const base = trBase();
  return base ? trDirty(trNames(), base, TR.edits) || Object.keys(TR.bad).length > 0 || trPickStaged(TR.picked, base, trPickKeep(TR.env, TR.picked, base, trListNames())).length > 0 : false;
}
/* 金額表的底稿。雲端存完、報告還沒對上時是送出的那一份(S.sent):報告還是舊的,拿它當底會把剛存的那幾格送回舊值 */
function trBase() { return TR.env === "cloud" && TR.sent ? TR.sent : trStored(); }
/* 表上列哪些(spec-desktop-strategy-picker §6):已存的 ∪ picker 勾的——picked 是 Set 就照它,null 就是已存的 key。
   不再看 hasBacktest:回測過但沒勾的不進表。這台電腦:已存但清單找不到的名字也列(用內部名畫,要移掉去 picker 取消勾選);
   雲端:清單找不到的走 trHidden(表上不列、原樣帶著送——api 讀不到 ≠ 已刪除)。 */
function trNamesOf(picked) {
  const base = picked ? [...picked] : Object.keys(trBase() || {});
  if (TR.env !== "cloud") return base;
  const list = trListNames(); return base.filter((n) => list.indexOf(n) >= 0);
}
function trNames() { return trNamesOf(TR.picked); }
function trListNames() { return TR.list.map((x) => x.name); }
function trDisplay(n) { const x = TR.list.find((y) => y.name === n); return x ? x.displayName : n; }

/* ── 開/關視圖 ─────────────────────────────────────────── */
async function trOpen(tab) {
  const S = TR;
  // 中欄一次只有一個視圖:先把這一邊的策略報告收掉(各邊各自選中的那支互不影響)
  if (S.env === "local") await stratSelect(null); else if (typeof rpCloudSelect === "function") await rpCloudSelect(null);
  if (typeof libLeave === "function") libLeave(S.env);   // 策略庫也收(renderer/library.js)
  if (typeof rptLeave === "function") rptLeave(S.env);   // 報告也收(renderer/reports.js)
  if (S !== TR_BAGS[ENV.cur]) { S.open = true; return; }   // 等的時候切走了:只記下這一邊是開著的,不碰另一邊的畫面
  $("main-empty").hidden = true; $("tr").hidden = false;
  $("tr-nav").setAttribute("aria-current", "page");
  S.open = true; S.sig = {}; ENV.sig.tb = null;
  trPaint();
  if (tab && !$("tr-tabs").hidden) trSetTab(tab);   // 指定分頁的入口(之後的通知、狀態帶)一律走 trSetTab:底線、tabindex、面板三件事一起換
  trPollSoon(0);
}
// app.js 選了策略時叫的:離開的是「這台電腦」的自動下單頁(雲端視角的那一頁不歸它管)
function trLeave() {
  const L = TR_BAGS.local;
  if (!L.open) return;
  L.open = false;
  if (ENV.cur === "local") { $("tr").hidden = true; $("tr-nav").removeAttribute("aria-current"); ENV.sig.tb = null; trPaintHead(); }   // 離開這頁:頂列換成短狀態詞
}
function trRepaint() { TR.sig = {}; TR_BAGS.local.sig = {}; ENV.sig = {}; ENV.cells = {}; trPaint(); if (!$("cx-scrim").hidden) cxModalPaint(); }

/* ── 標題列 / 狀態帶 ───────────────────────────────────────── */
function trStateText(state) {
  const r = trReport() || {}, rec = r.reconciler || {};
  // 雲端:主機停機就講停機(心跳那一句在這裡沒有意義);主機那一輪沒回報成功 = 讀不到,不沿用寫死「這台電腦」的那兩句
  if (TR.env === "cloud") {
    if (envCloudKind(TR.st) === "stopped") return t("side.stopped");
    if (state === "unknown") return t("tr.cloud.unknown");
  }
  // 過場中講過場(設計師 A-2):不能一邊亮綠點一邊寫「對帳沒有在跑」
  if (TR.pending) return TR.pending.want === "halted" ? t("tr.stopping") : TR.pending.want === "released" ? t("tr.releasing") : TR.pending.want === "acct" ? t("tr.acct.confirming") : t("tr.starting");
  // 常駐程式不在跑:誠實講,並給出口(重試中 / 起不來請重開 Blave)。灰字,同其他故障
  const down = trHostDown(TR.st, Date.now());
  if (down === "lock") { const k = TR.st.lockRetry; return t("tr.hostLock", { n: Math.max(1, Math.min(Number(k.attempt) || 1, 99)), max: Math.max(1, Math.min(Number(k.max) || 4, 99)) }); }
  const zS = trNoAmounts(r) && !trRestartUnconfirmed(r);   // Z:狀態句不叫人按停用的「啟動下單」(v2 §9-1)
  if (down) return down === "retry" ? t(zS ? "tr.hostRetryZ" : "tr.hostRetry") : t("tr.hostDown");
  // 第一份報告還在路上:通用的「載入中…」只有在「不知道在等誰、多久、會不會自己好」時才該用,這裡三件事都知道(spec §1 規則 5)
  if (state === "loading") return TR.env === "cloud" ? t("tr.cloud.hdFetching") : t("tr.loading");
  if (state === "unknown") return t("tr.unknown");
  if (state === "setup") return trVenueLabel("president", true) + " · " + t("cap.pending");   // 開通中:不接「串接失敗」前綴、不講已暫停
  // 雲端剛存了金鑰 / 模擬帳戶、主機還沒回報(S5):標頭不跟內文打架——「連接中…」,過了上限「沒有收到主機確認」(v2 §5)
  if (state === "noaccount" && TR.env === "cloud" && TR.cxSaved) return trCxSavedStale(TR.cxSaved, Date.now()) ? t("tr.cloud.hdNoConfirm")
    : trCxAssumed(TR.cxSaved, Date.now()) ? t("tr.cloud.hdFetching") : t("tr.cloud.hdConnecting");
  if (state === "noaccount") return trNoAccountStopped(r) ? t("tr.halted") + " · " + t("tr.cloud.restartNoAccountZ") : t("tr.noAccount");
  // 下單程式在跑、但沒有任何策略設金額(§8):不寫「自動下單執行中」——那讀起來像在照策略下單
  let s = trNoAmounts(r) ? t("tr.runningZ") : t("tr.autoOn");
  // 主機重開、沒能確認停住:狀態詞「可能仍在下單」+ 紅字原因行(先暫停、再更新)。不提早 return:讀帳失敗的前綴照樣要接
  if (state === "unconfirmed") s = t("tr.cloud.mayTrade") + " · " + t("tr.cloud.restartUnconfirmed");
  /* 已暫停一律帶原因行(常駐、不截斷):重開過 = 什麼單都不下(B,優先);HALT = 不開新倉、平倉停損照走(A)。
     兩者同時成立(先按暫停、之後又重開)講 B——那時「平倉照常」已經不成立 */
  else if (state === "halted") { const rk = trRestartKind(r), ask = trAcctAsk(r), done = !trBookHold(r) && TR.acctDone && (TR.acctDone.outcome === "kept" || TR.acctDone.outcome === "reset");
    s = (ask ? t("env.st.autoPaused") : done || rk || envHeadWord(state, TR.st) !== "env.st.autoPaused" ? t("tr.halted") : t("env.st.autoPaused")) + " · "
      + trHaltReasonText(r, TR.acctDone); }
  // 「尚未啟動下單」講的是狀態、不是叫人按鈕(§12:不需要 Z 變體);「停了、不是你按的」在 Z 時去掉尾巴
  else if (state === "dead") s = trDeadKind(r) === "died" ? t(zS ? "tr.diedZ" : "tr.died", { t: rec.heartbeat_at ? trStamp(rec.heartbeat_at) : "—" })
    : rec.heartbeat_at ? t("tr.notStarted") + " · " + t("tr.lastRun", { t: trStamp(rec.heartbeat_at) }) : t("tr.notStarted");
  // 讀帳失敗標在狀態行最前面(細節在 設定 分頁的帳戶段);頁面與暫停鈕照常在
  return trFailedIds(r).length || trKeyBad(TR.env) ? cxFailWord(TR.env) + " · " + s : s;
}
/* 頂列用的短狀態詞(§6):不帶時間、不帶出口;完整句留給標題下那一行。字面 key 一個一個寫(check_shell_strings 靠字面掃) */
function trShortState(state) {
  const r = trReport() || {};
  if (TR.env === "cloud" && envCloudKind(TR.st) === "stopped") return t("side.stopped");
  if (TR.pending) return TR.pending.want === "halted" ? t("tr.stopping") : TR.pending.want === "released" ? t("tr.releasing") : TR.pending.want === "acct" ? t("tr.acct.confirming") : t("tr.starting");
  if (trHostDown(TR.st, Date.now())) return t("tr.hostShort");
  const s = state === "setup" ? t("cap.pending") : state === "running" ? t("tr.s.on") : state === "unconfirmed" ? t("tr.cloud.mayTrade") : state === "halted" ? (envHeadWord(state, TR.st) === "env.st.autoPaused" ? t("env.st.autoPaused") : t("tr.halted"))
    : state === "dead" ? (trDeadKind(r) === "died" ? t("tr.s.died") : t("tr.s.off")) : "";
  return trFailedIds(r).length || trKeyBad(TR.env) ? t("cx.failShort") + (s ? " · " + s : "") : s;
}
/* 全頁唯一的紅字槽。want = 這句話在狀態變成什麼的時候就不成立了(例:「它還在交易」在已暫停之後是假話)→ 到了就自己清掉。
   src = 這一則是誰寫的。**指令的失敗與「讀不到雲端」共用這一格**,而 trPaintHead 每一輪都會重畫:
   沒有這個標記的話,送完指令那一步的 trPaint() 會把剛寫上去的錯誤當場洗掉,畫面上等於一句話都沒出現過。 */
function trAlert(text, want, bag, src) {
  const S = bag || TR, was = S.alertText;
  S.alertText = text || ""; S.alertWant = text ? want || null : null; S.alertSrc = text ? src || "cmd" : null;
  if (S !== TR_BAGS[ENV.cur]) return;              // 另一邊的事:記著,切過去才出現
  trAlertShow();
  if (text && text !== was) srSay(text);
}
function trAlertShow() { const S = TR_BAGS[ENV.cur], a = $("tr-alert"); a.hidden = !S.alertText; a.textContent = S.alertText; }
/* kind:"stop" = 暫停那兩個指令(沒送到 = 它還在交易,要講撤 API key 那句);其餘一般失敗不講那句(稽核 S2-B)。
   env 由呼叫端帶(跨 await 之後 TR 可能已經是另一邊了)。雲端**不可以**沿用本機那組句子:它們寫死了「這台電腦」。 */
// Type B 的拒絕(TYPE_B: 「名」…)→ 一句完整的話,名字換成顯示名;其他代碼回 null,照原文那句
function trRejectSentence(rc) { return rc.code === "TYPE_B" ? t("tr.typeB.rejected", { name: trDisplay(rc.name) }) : rc.code === "NOT_TXF" ? t("tr.notTxf.rejected", { name: trDisplay(rc.name) }) : null; }
function trSendError(res, kind, env) {
  const e = res && res.error ? String(res.error) : "", k = trKindOf(res);
  const rc = k === "rejected" ? trRejectCode(e) : null, known = rc ? trRejectSentence(rc) : null;
  if (e === "UPDATE_REQUIRED") return t(kind === "release" ? "minv.release" : "minv.trade");   // 最低版本閘:只擋啟動,暫停不受影響;叫人重按沒有用,要講去哪裡更新
  if ((env || TR.env) === "cloud") {
    // 409:api 不排隊、不記稽核 = 真的什麼都沒送出,不可沿用本機 daemon 沒跑時「已排隊」的說法。
    // 已停機那一態不出紅字:整頁會被下一份 state 換成停機態,那裡話講得更完整。machine_state 缺席時不臆測,走通用那句
    if (e === "MACHINE_NOT_RUNNING") { const m = res && res.machineState;
      if (m === "stopped") return "";
      if (m === "starting") return t("tr.cloud.startingNow");
      if (m === "none") return t("tr.cloud.noMachine"); }
    if (e === "RATE_LIMITED") return kind === "stop" ? t("tr.cloud.tooSoonStop") : t("tr.cloud.tooSoon");
    if (e === "AUDIT_UNAVAILABLE") return t("tr.cloud.notSent");
    if (k === "unknown") return t("tr.cloud.cmdUnknown");
    if (known) return known;
    if (k === "rejected") return t("tr.cloud.cmdRejected", { err: trRejectText(e).slice(0, 200) });
    return kind === "stop" ? t("tr.cloud.cmdNotDelivered") : t("tr.cloud.cmdFailed");
  }
  if (k === "unknown") return t("tr.cmdUnknown");
  if (known) return known;
  if (k === "rejected") return t("tr.cmdRejected", { err: trRejectText(e).slice(0, 200) });
  return kind === "stop" ? t("tr.cmdNotDelivered") : t("tr.cmdFailed");
}
function trPendingCheck() {
  const state = trExecState(TR.st), cloud = TR.env === "cloud";
  if (TR.alertWant && state === TR.alertWant) trAlert("");
  // 答完帳戶確認的那一句只活到 HALT 解除(按了啟動下單)為止
  const rp0 = TR.st && TR.st.report; if (TR.acctDone && rp0 && !(rp0.halt && rp0.halt.halted)) TR.acctDone = null;
  const p = TR.pending; if (!p) return;
  // 雲端:等的過程中主機停機了——人要看到的是「它停了」,不是「我按的那個不知道怎樣」(規格 §1.4)
  if (cloud && envCloudKind(TR.st) === "stopped") { TR.pending = null; trClearRunIds(TR.reqIds); trAlert(""); return; }
  // 收斂了 = 這個意圖已經完成:下一次按同一顆鈕是新的意圖,要換一顆 request_id(不換的話 15 分鐘內會被當成重送、整個不執行)
  // 解除暫停:HALT 與重開停止都清掉就算完成(Z 時落到 running 或 dead 都可能,不等某一個狀態)
  const pr = (TR.st && TR.st.report) || {}, relDone = p.want === "released" && !!TR.st && !!TR.st.report && !(pr.halt && pr.halt.halted) && !trRestartStopped(pr);
  // 帳戶確認:報告裡不再有 book_hold 就算答完(兩個答案都拿掉它;HALT 照舊,所以不能等狀態變)
  const acctDone = p.want === "acct" && !!TR.st && !!TR.st.report && !trBookHold(pr);
  if (state === p.want || relDone || acctDone) { TR.pending = null; trClearRunIds(TR.reqIds); trAlert(""); }
  /* 等到逾時還沒對上。本機:ack 代表指令檔已經落地,沒收斂就是真的失敗,照原本那兩句。
     雲端:ack 只代表機器收下了,沒收斂多半是那份回報還沒送出來——**不可以因為沒收斂就說「沒送到」**
     (規格 §1.3);說了就是叫一個暫停其實已經生效的人去交易所撤 key。一律走「結果不明」。
     **逾時 = 這個意圖到此為止**(Wei 拍板):`reqIds` 一起清掉。不清的話下一次按會沿用同一顆,而 api 的
     佔位還在(900 秒)→ 回 duplicate、不再排一次,ack 回條也早過期 → 畫面只說「結果不明」,機器繼續用真錢跑。
     代價:如果其實只是慢,重按會真的執行兩次——halt 冪等無害,close_all 由 in-flight 標記與確認框擋一層。 */
  else if (Date.now() > p.until) { TR.pending = null; trClearRunIds(TR.reqIds);
    /* 雲端收過 ok 回條、回條之後存的回報說對帳器沒起來:結果是知道的,不可以講成「還沒回報」(29026,09-23)。
       讀不到新狀態(!alive)、或手上那份回報不比回條晚,都不下斷言。回條時間換成伺服器時鐘再比(同 envHeadState 避開時鐘差),
       留 20 秒給回條前就開始送、晚到的舊回報 */
    const cs = (TR.st && TR.st.cloud) || {}, repAfterAck = p.ackedAt > 0 && cs.reported_at > 0 && cs.server_time > 0 && cs.fetched_at > 0
      && cs.reported_at * 1000 > p.ackedAt + (cs.server_time * 1000 - cs.fetched_at) + 20000;
    trAlert(cloud ? (p.acked && p.want === "running" && state === "dead" && TR.st.alive && repAfterAck ? t("tr.cloud.startedNotRunning") : t("tr.cloud.cmdUnknown"))
      : p.unknown ? t("tr.cmdUnknown") : p.want === "halted" ? t("tr.cmdNotDelivered") : t("tr.cmdFailed"), p.want); }
}
/* 送一個指令,順便管兩件事。
   ① **同一顆指令同時只飛一趟**(稽核 B-3):暫停側的鈕永遠可按,所以 ack 窗(最長 20 秒)之內按第二次是正常操作。
      那時 `reqIds` 還沒寫進去(要等第一趟回來),再送一次會鑄出**第二顆** request_id,api 的去重完全沒機會生效——
      雲端會排兩筆、本機 daemon.js:128 每次都鑄新 id 根本沒有去重,兩邊都變成 `close_all` 跑兩次
      (`command_listener` 每一筆都另起一支 flatten)。在途時直接把同一趟的結果交給第二個呼叫端:不重複送,鈕照樣可按。
   ② request_id 的沿用(契約 §4):同一個意圖重試沿用同一顆——沒排進佇列的失敗(409/429/503/連不上)與 ack 逾時
      都要沿用,否則「其實前一次已經進去了」會變成同一個動作執行兩次。被接受 / 被主機拒絕 = 這一顆用完了。
   本機那條路沒有 requestId 這個欄位,②等於原樣轉呼。 */
async function trSend(S, cmd, args, intent) {
  if (S.sending[cmd]) return S.sending[cmd];
  const flight = (async () => {
    const res = await S.api.tradeSend(cmd, args, S.reqIds[cmd] || null, intent || null);
    /* 每一個雲端寫入都開窗,不只存金額:halt / resume / close_all 的結果一樣只出現在下一份報告裡,
       而 C.pending 那條路只是叫畫面每 2.5 秒問主行程手上那一份,主行程照舊 15 秒才去抓一次——同一個病。
       trSend 是雲端寫入的唯一出口(envApi 的 tradeSend),掛在這裡一處就全收 */
    if (S.env === "cloud" && res && res.ok) ENV.burst = trBurstBump(ENV.burst, Date.now(), TR_BURST_MS, TR_BURST_MAX_MS);
    /* 指令成功 = 事件流多了一筆(暫停 / 恢復 / 連接…):總覽那份 60 秒快取作廢,下一次畫總覽就重讀。
       不作廢的話剛按完「啟動,等新訊號才進場」,事件清單最新一筆還停在上一次(e2e 0.1.8 #76) */
    if (res && res.ok && S.ov) S.ov.at = 0;
    if ((res && res.ok) || trKindOf(res) === "rejected") delete S.reqIds[cmd];
    else if (res && typeof res.requestId === "string") S.reqIds[cmd] = res.requestId;
    return res;
  })();
  S.sending[cmd] = flight;
  try { return await flight; } finally { delete S.sending[cmd]; }
}
/* 送「會改變執行狀態」的指令(稽核 S3):一進來就掛 pending——確認框一關、ack 還沒回來的那段時間鈕就已經是過場態,
   不會再開第二個確認框、送第二個 close_all / restart_reconciler。失敗才把 pending 拿掉。 */
async function trRun(want, steps, cmd) {
  const S = TR;
  if (trBtnLocked(S.pending, want === "halted")) return;   // 暫停照送(新的意圖蓋掉舊的過場);啟動在過場中不重複送
  S.pending = { want, cmd: cmd || null, until: Date.now() + (S.env === "cloud" ? TR_CONFIRM_CLOUD_MS : TR_CONFIRM_MS) };
  const mine = S.pending;   // 跨 await 抓住自己那一顆意圖(同 N8 的規矩,層級從「袋」下到「意圖」)
  trAlert("", null, S); trPaint();
  let res = null;
  // 每一步之前看自己是不是已經被暫停蓋掉:蓋掉了就不再送下一步(本機啟動的 restart_reconciler)——多一個沒人要的指令,
  // 而且「暫停」之後緊接著冒出「對帳器重新啟動」的事件,讀起來像暫停沒生效
  for (const step of steps) { if (S.pending !== mine) break; res = await step(S); if (!res || !res.ok || trHeldVenue(res)) break; }
  const kind = want === "halted" ? "stop" : want === "released" ? "release" : "start";
  /* 已經被更新的那一次意圖取代了(暫停側可重入:第二次按會蓋掉這一顆),或早就收斂清掉了:結果不歸我寫。
     不守的話,先回來的那一趟會把**還在飛的那一次**的過場態清掉,並寫出「暫停沒送到、去交易所撤 key」——
     而它其實正要執行。
     **唯一的例外:平倉那一趟的結果永遠要講**,不管後來誰蓋了 pending。`close_all` 跟 `halt` 共用 `want:"halted"`
     這個槽:先按平倉、再按暫停 → 暫停收斂、鈕變「啟動」,而平倉其實沒送出去、部位還在——沒有這一句,畫面上零提示。
     want 給 null(不綁現在的 pending,不會被別人的收斂順手清掉)。 */
  if (S.pending !== mine) {
    if (mine.cmd === "close_all" && !(res && res.ok)) trAlert(trSendError(res, "stop", S.env), null, S);
  } else {
    const held = trHeldVenue(res);
    /* 帳戶還沒確認時的啟動:機器收下了、但 HALT 照舊(result "held: …")。當場收掉「啟動中…」(不等逾時、不講沒送到)、
       不補 restart_reconciler。**雲端也照這個 result 收**:偽造它只會讓畫面停在「已暫停」,是安全方向 */
    // 標頭照舊是「已暫停」+「確認帳戶」那一題,不另寫一句(同網頁);讀屏把那一題唸一次(按了啟動卻沒動,不能靜悄悄)
    if (held) { S.pending = null; delete S.reqIds[mine.cmd]; }
    else if (res && res.ok) {
      mine.acked = true; mine.ackedAt = Date.now();   // 機器收下了(「暫停中…」照樣停用到收斂或逾時,trHaltInFlight)
      // 常駐程式沒在跑時的 halt 只是排進佇列(下次啟動才吃):沒有東西在交易,不必等狀態。
      // **只信本機那條路**:雲端的 result 是用戶主機寫的字典,照它清 pending 等於讓策略碼把過場態關掉
      if (S.env === "local" && res.result && res.result.queued) S.pending = null;
    } else if (trKindOf(res) === "unknown") {
      // 可能已經執行:不說「沒送到」、不叫人重按;留著 pending 看狀態檔,到了就自己清
      mine.unknown = true;
      trAlert(t(S.env === "cloud" ? "tr.cloud.cmdUnknown" : "tr.cmdUnknown"), want, S);
    } else { S.pending = null; trAlert(trSendError(res, kind, S.env), want, S); }
  }
  trPaint(); trPollSoon(800);
  // 排在 trPaint 之後:它換狀態句時會自己唸一次,後唸的才留在 live region
  const heldV = S.pending === null && trHeldVenue(res);
  if (heldV) srSay(t("tr.acct.reason", { v: trVenueLabel(heldV, true) }));
}

function trPaintHead() {
  // state = 文字與鈕字用的(雲端讀不到新狀態時 = 上一份回報自己說的,見 envHeadState);綠點另外看保守的 trExecState
  const state = envHeadState(TR.st, Date.now()), text = trStateText(state), ro = TR.env === "cloud";
  const kind = ro ? envCloudKind(TR.st) : null, stopped = kind === "stopped";
  // 綠點只留切換器那一顆(設計 v4 §6):這一行不再畫點,它是這頁狀態的文字載體
  // 標題列狀態行。雲端讀不到新狀態時,後面接「最後更新」(保留上一次的數字,但要講它不是現況)
  const c = (ro && TR.st && TR.st.cloud) || null;
  const staleAt = c && (c.transient ? c.last_ok_at : c.stale && !stopped && c.reported_at ? c.reported_at * 1000 : !TR.st.alive && !stopped && kind === "running" ? c.last_ok_at : 0);
  const full = staleAt ? text + " · " + t("tr.cloud.stale", { t: trStamp(staleAt / 1000) }) : text;
  const desc = $("tr-desc"); desc.textContent = "";
  // 異常停止那一句:「下單停了，不是你按的」那一段加重(句子以第一個「 · 」分段;前面若有「串接失敗 · 」就不拆)
  const died = state === "dead" && !TR.pending && !trHostDown(TR.st, Date.now()) && trDeadKind(trReport()) === "died";
  const cutAt = died && full === text && !trFailedIds(trReport()).length && !trKeyBad(TR.env) ? full.indexOf(" · ") : -1;
  const tx = trEl("span", "txt");
  // 重開那一條原因行升為正文墨色(警示語氣但不用紅字);HALT 那一條照舊次要灰
  // A′(自動暫停、什麼單都不下)與沒有交易所的重開停止(B0)同 B 一級
  // 用原因句本身定位(同下面 C 的紅字):前面有「串接失敗 · 」、後面接「最後更新」都照樣升(新狀態稽核 §3-1)
  const hr = trReport() || {};
  const inkReason = state === "halted" && (trRestartKind(hr) || trHaltStopsAll(hr.halt) || trAcctAsk(hr)) ? trHaltReasonText(hr, TR.acctDone) : state === "noaccount" && trNoAccountStopped(hr) ? t("tr.cloud.restartNoAccountZ") : "";
  const inkAt = inkReason ? full.indexOf(inkReason) : -1;
  /* 「可能仍在下單」那一條原因行用紅字(錢可能還在外面暴露、而用戶以為停了);狀態詞本身一般墨色。
     紅的只有原因那一句本身:前面可能有「串接失敗 · 」、後面可能接「 · 最後更新…」(回報過舊),兩種都不能讓紅字消失 */
  const ucReason = state === "unconfirmed" ? t("tr.cloud.restartUnconfirmed") : "", ucAt = ucReason ? full.indexOf(ucReason) : -1;
  if (cutAt > 0) tx.append(trEl("span", "up", full.slice(0, cutAt)), full.slice(cutAt));
  else if (ucAt > 0) tx.append(full.slice(0, ucAt), trEl("span", "danger", ucReason), full.slice(ucAt + ucReason.length));
  else if (inkAt > 0) tx.append(full.slice(0, inkAt), trEl("span", "ink", inkReason), full.slice(inkAt + inkReason.length));
  else tx.textContent = full;
  desc.appendChild(tx); desc.title = full;   // 單行截斷,全文放 title
  // 帶著出口的句子(「請重開 Blave」「按『啟動下單』重新開始」)不能被截斷:這時候狀態行可以換行
  /* 狀態句換行。**Z 一律換行**:標頭改成三列之後這一行跨滿寬,沒有 .wrap 的狀態會被截成一行、而且看起來很正常——
     被藏掉的正是「部位現在沒有人在管」那半句(設計師在 V2b 點名的陷阱)。running + Z 與「尚未啟動下單 · 最後執行」
     這兩種以前沒有 .wrap,現在靠 trNoAmounts 一起接住 */
  desc.classList.toggle("wrap", !!trHostDown(TR.st, Date.now()) || (ro && state === "unknown") || died || state === "halted" || state === "unconfirmed" || trNoAmounts(trReport()) || (state === "noaccount" && trNoAccountStopped(trReport())));   // 帶出口 / 原因行的句子不截(已暫停的原因行常駐,不可以被省略號吃掉)
  // 狀態變了講一次(輪詢每幾秒重畫,不能每次都講)
  if (TR.lastSaid !== null && TR.lastSaid !== text && TR.open && state !== "loading") srSay(text);
  TR.lastSaid = text;
  /* 雲端連續讀不到:同樣寫在全頁唯一的紅字槽(讀得到了就自己收掉)。
     **這一格現在也裝指令的失敗**(§1.4 那五種話),所以這裡只准動自己那一則:
     不成立時只收自己寫的那句,不可以把剛送完指令寫上去的錯誤一起洗掉。 */
  if (ro) {
    if (envUnreachAlert(c, Date.now())) trAlert(t("tr.cloud.unreach", { t: trStamp((c.last_ok_at || 0) / 1000) }), null, TR, "unreach");
    else if (TR.alertSrc === "unreach") trAlert("");
  }
  trAlertShow();
  // 切換器右邊那一句:這一邊的狀態。沒連接交易所時是空的
  const id = trVenueId(), has = state !== "noaccount" && state !== "loading" && state !== "unknown" && !!id;
  // 頂列(設計 v4 §6,P1=A):自動下單頁開著時只留錢記號、不出字(完整句就在標題下,不重複);離開這頁才出**短狀態詞**。
  // 雲端視角的頁永遠開著 → 永遠只有記號。句子只有短狀態詞:交易所名已經在前面的記號裡(Wei 0.0.6),句尾不再重複
  const pageOpen = TR_BAGS[ENV.cur].open === true, tbState = has && !pageOpen ? trShortState(state) : "";
  const txt = $("tr-tb-txt");
  // 出事(這一格有紅短劃那種事)時,狀態詞加重;其餘灰字
  const tbUp = !!tbState && envCell(TR.env, TR.st, !!TR.pending).dot === "bad", tsig = LANG + "|" + tbState + "|" + tbUp;
  if (ENV.sig.tb !== tsig) {
    ENV.sig.tb = tsig; txt.textContent = ""; txt.title = tbState;
    if (tbUp) txt.append(trEl("span", "up", tbState));
    else txt.textContent = tbState;
  }
  // 記號排在這一句的最前面(切換器格內不放):看得見的這一邊連的是模擬還是哪一家交易所
  const mny = has ? envMoney(TR.st) : null, tm = $("tr-tb-mode");
  tm.hidden = !mny; tm.className = "mode " + (mny || "paper"); tm.textContent = envVenueText(mny, id);
  // 全頁級的「只能看」退場(規格 §6):啟動 / 暫停在雲端按得動之後,那一句就是假話。
  // 金額與連接交易所這一批還沒開,各自在自己的位置講(S4 / S5),不在這裡出一句整頁級的
  trPaintRoNote(null);
  trPaintVerdict(stopped);
  // 執行鈕:沒帳戶時不放(那顆「連接交易所」在 onboard 裡,同畫面不出現兩顆主要鈕)。
  // 同一顆鈕就地更新、不重建:確認框關掉之後焦點要回得到它,輪詢重畫也不能把焦點洗掉。
  const act = $("tr-act");
  let b = $("tr-go");
  /* 存完金額、等主機回報那一行(spec-desktop-waiting-states §2)。條件是 sentOn && 沒再改 && 存檔沒失敗,
     **跟 Z、跟金額、跟 trExecState 都無關**:非 Z(有金額,常見的那一種)也要出,鈕照樣能按、不擋——
     機器拿的是它手上那一份設定,而那一份在 ack 送回來之前就寫好了(runtime/command_listener.py:2387 → :4602),
     所以這一行講的只有「這一頁的數字還是舊的」,不是警告。
     常態句分兩版,判準是**鈕到底能不能按**(zv.off),不是 trNoAmounts:重開沒確認停住(C)+ 沒有金額
     那一格 trZView 回 none(鈕照樣能按,§8 照現行),拿 trNoAmounts 當判準就會一邊說「回報進來就能啟動」
     一邊讓人按得下去——正是這一批在修的那種自相矛盾。noStart(B0)沒有啟動鈕,也不能講「就能啟動」。 */
  // 要回答帳戶確認時(已暫停 + book_hold 在問):主鈕換成「確認帳戶」,Z 的停用與「解除暫停」都不出(spec §1:Z 時也一樣)
  const ask = state === "halted" && trAcctAsk(trReport()), pendingAcct = !!TR.pending && TR.pending.want === "acct";
  const zv = ask ? { off: false, release: false, reason: null } : trZView(state, trReport() || {});
  const pend = trAmountsEdited() ? null : trPendKey(TR, Date.now(), zv.off && !zv.noStart);
  // 雲端而且不知道現況:不放主鈕——「暫停下單」「啟動下單」哪一個字都是在替它下結論(這一刀的鈕本來就不能按,說明行還在)
  // 沒有交易所、但主機重開停著(B0):一定是 Z,不出「啟動下單」,只出「解除暫停」(v2 §9-1;紀錄檔只有 resume 清得掉)
  // 統一開通中(setup,只有這台電腦視角):主鈕換成「繼續」回到開通清單(同設定 › 帳戶那一列);啟動 / 暫停都不出
  const pcBtn = $("tr-pres-continue");
  if (state === "setup" && !stopped && TR.env === "local") {
    if (b) { if (document.activeElement === b) $("tr-h").focus(); b.remove(); }
    trPaintGoStop(false); trPaintNoAmt(null); trPaintGoRel(false, false);
    const go = pcBtn || trEl("button", "btn-fill"); go.textContent = t("cap.continue");
    if (!pcBtn) { go.type = "button"; go.id = "tr-pres-continue"; go.addEventListener("click", () => cxModalOpen(go, "president")); act.appendChild(go); }
    return;
  }
  if (pcBtn) pcBtn.remove();
  const b0 = state === "noaccount" && trNoAccountStopped(trReport());
  if (!stopped && (b0 || state === "noaccount" || state === "loading" || (ro && state === "unknown"))) { if (b) { if (document.activeElement === b) $("tr-h").focus(); b.remove(); } trPaintGoStop(false); trPaintNoAmt(pend); trPaintGoRel(b0, b0); return; }
  if (!b) {
    b = trEl("button", "btn-fill"); b.type = "button"; b.id = "tr-go";
    b.addEventListener("click", () => {
      // 雲端停機時這顆是「加值」(外開瀏覽器):主機不在,送什麼都是 409
      if (TR.env === "cloud" && envCloudKind(TR.st) === "stopped") { bindGo("topup_cloud"); return; }
      if (trStartPending(TR.pending) || trHaltInFlight(TR.pending, Date.now())) return;   // 啟動在途:主鈕講實話、不能按,暫停走旁邊那顆(#tr-go-stop);暫停在途:停用
      // 換金鑰後要回答「還是同一個帳戶嗎」:這顆就是「確認帳戶」(不給啟動下單——機器會回 held、HALT 照舊)
      if (envHeadState(TR.st, Date.now()) === "halted" && trAcctAsk(trReport())) { if (!TR.pending) trAskAccount(b); return; }
      const stopSide = trStopSideNow(envHeadState(TR.st, Date.now()), TR.pending) || trRestartUnconfirmed(trReport());   // 重開沒停住:整段都只給暫停
      if (trBtnLocked(TR.pending, stopSide)) return;   // 過場中只鎖啟動那一側;暫停照按
      if (stopSide) trAskStop(b); else trAskStart(b);
    });
    act.appendChild(b);
  }
  if (ro && stopped) {
    b.textContent = t("plan.addCredit");
    b.disabled = false; b.title = ""; b.classList.remove("is-busy", "is-ro");
    b.setAttribute("aria-disabled", "false"); b.removeAttribute("aria-describedby");
    trPaintGoStop(false); trPaintGoRel(false); trPaintNoAmt(pend);
    return;
  }
  b.classList.remove("is-ro"); b.removeAttribute("aria-describedby");
  // 指令通道通不通:本機看常駐程式;雲端看主機在不在 running(指令是 api 排進佇列、機器自己取,跟本機那支 listener 無關)
  const up = ro ? envCloudKind(TR.st) === "running" : trChannelUp(TR.st);
  // 重開沒停住(含已按暫停之後):主鈕一律「暫停下單」,「啟動下單」不出現——按啟動會清掉重開紀錄、叫起一支還沒確認停下的舊程式;該做的是更新
  b.textContent = ask ? (pendingAcct ? t("tr.acct.confirming") : t("tr.acct.btn"))
    : TR.pending && TR.pending.want !== "released" ? (TR.pending.want === "halted" ? t("tr.stopping") : t("tr.starting")) : trStopSide(state) || trRestartUnconfirmed(trReport()) ? t("tr.stop") : t("tr.start");
  // 啟動過場用 aria-disabled(不是 disabled):disabled 的鈕會把焦點丟到 BODY。暫停過場整段 disabled(下面 flying),兩者都掛 is-busy
  const busy = !!TR.pending, flying = trHaltInFlight(TR.pending, Date.now());
  const locked = ask ? pendingAcct : trBtnLocked(TR.pending, trStopSideNow(state, TR.pending) || trRestartUnconfirmed(trReport())) || trStartPending(TR.pending) || flying;
  b.setAttribute("aria-disabled", locked ? "true" : "false"); b.classList.toggle("is-busy", busy);
  trPaintGoStop(trStartPending(TR.pending));
  // 沒有策略設金額(§8):啟動下單停用、原因行常駐(aria-describedby 指過去);暫停中另給「解除暫停」
  trPaintNoAmt(pend || zv.reason); trPaintGoRel(zv.release, zv.noStart, zv.close);
  if (zv.off) b.setAttribute("aria-describedby", "tr-noamt");
  if (trStartPending(TR.pending)) b.setAttribute("aria-describedby", "tr-go-hint");
  // 狀態不明時鈕照給、而且不看狀態檔裡的 listener 旗標(那份檔就是不能信的那個):暫停是安全方向
  const usable = state === "unknown" ? !!(TR.st && TR.st.alive) : up;
  // disabled 的鈕會把焦點丟到 BODY(確認框關掉時焦點剛還給它):先把焦點交給標題(tabindex=-1),再停用
  if (flying && document.activeElement === b) { $("tr-h").focus(); TR.focusParked = true; }
  b.disabled = flying || zv.off || (!busy && !usable);   // zv.off:沒有策略設金額時啟動下單**永遠**按不了(不變式,tests/check_shell_trade.js 列舉)
  // 暫停收斂(或逾時)放開之後,焦點還回主鈕——停在標題或掉到 body 都等於把鍵盤使用者丟在原地(新狀態稽核 §3-8)
  if (!flying && TR.focusParked) { TR.focusParked = false; const ae = document.activeElement; if (!b.disabled && (!ae || ae === document.body || ae === $("tr-h"))) b.focus(); }
  b.title = zv.off ? "" : !busy && !usable ? t("tr.cmdUnavailable") : "";   // 停用的原因在原因行,不讓「連不上」蓋掉它
}
/* 啟動在途時主鈕右邊那顆「暫停下單」(spec-desktop-start-pending-stop §2 B)。文字鈕、不是第二顆實心鈕;
   只在 want:"running" 的過場出現,收斂或被暫停蓋掉就收。焦點不搬過來:剛按完啟動的人按 Enter 不該變成開暫停框。
   主鈕的 aria-describedby 指向旁邊那句只給讀屏的說明,過場開始時播一次。 */
/* 「解除暫停」(§8):描邊鈕,在主鈕旁。只送 resume——本機不補 restart_reconciler(那是啟動下單才有的第二步);
   雲端重開停止時機器端的 resume 會自己把對帳器叫起來,這一步避不開(後端確認),所以要平倉時確認框先講 */
function trPaintGoRel(on, solid, close) {
  let u = $("tr-go-rel");
  if (!on) { if (u) { if (document.activeElement === u) $("tr-h").focus(); u.remove(); } TR.relParked = false; return; }
  // B0 沒有那顆停用的實心「啟動下單」,這顆就是視窗裡唯一能做的事 → 實心(新狀態視覺稽核 2-5);其餘狀態維持描邊
  if (!u) { u = trEl("button", "btn-out", ""); u.type = "button"; u.id = "tr-go-rel"; u.addEventListener("click", () => { if (!TR.pending) trAskRelease(u); }); $("tr-act").insertBefore(u, $("tr-go")); }
  u.classList.toggle("btn-fill", !!solid); u.classList.toggle("btn-out", !solid);
  const rel = !!TR.pending && TR.pending.want === "released", up = TR.env === "cloud" ? envCloudKind(TR.st) === "running" : trChannelUp(TR.st);
  u.textContent = rel ? t("tr.releasing") : close ? t("tr.releaseClose") : t("tr.release");   // 會平倉時鈕字講出來(§3.2);外觀照舊描邊,不用紅
  // 送出之後這顆會停用:焦點先交給標題,放開再還回來(同主鈕的 focusParked;視覺稽核 2-1)
  const off = !!TR.pending || !up;
  if (off && document.activeElement === u) { $("tr-h").focus(); TR.relParked = true; }
  u.disabled = off; u.classList.toggle("is-busy", rel);
  if (!off && TR.relParked) { TR.relParked = false; const ae = document.activeElement; if (!ae || ae === document.body || ae === $("tr-h")) u.focus(); }
}
/* 鈕旁的原因行(Z 時常駐,--ink-3 12px,在狀態行下面自己一行)。句子裡的「部位」做成連結,點了切到部位分頁。
   **節點常駐、只換內容**(e2e 0.1.8 #108):原本沒有原因就把節點拿掉,連續操作時頁首高度一下多 22px 一下少 22px,
   分頁列跟著跳、容易點錯。沒有原因時清空內容,高度由 CSS 的 min-height 佔著 */
function trPaintNoAmt(key) {
  let p = $("tr-noamt");
  if (!p) { p = trEl("p", "tr-noamt", ""); p.id = "tr-noamt"; $("tr-desc").after(p); }
  // 這一行裡有可 Tab 的「部位」連結:清空 / 重建之前焦點在它身上的話先交給標題,不然會掉到 BODY
  const hadFocus = p.contains(document.activeElement);
  if (!key) { if (hadFocus) $("tr-h").focus(); p.textContent = ""; p.classList.remove("cx-wait"); delete p.dataset.key; return; }
  if (p.dataset.key === key + "|" + LANG) return;
  if (hadFocus) $("tr-h").focus();
  p.dataset.key = key + "|" + LANG; p.textContent = "";
  /* 等回報那一句前面加 16/2 圓環 spinner(§2-3c):讓「正在發生某件事」出現在停用的鈕正下方、
     離接觸點幾個 px,而不是讓一顆靜止的灰鈕自己解釋。**spinner 只放在句子上,不放進鈕裡**——
     放進鈕裡就是規則 6 要避免的那個誤讀(用戶按的是儲存,不是啟動下單)。沿用 §5 的 .cx-wait,不新做元件。
     句子整段包在一個 span 裡:.cx-wait 是 flex,不包的話每個文字節點都會變成一個 flex item,句子會被切成好幾欄 */
  const wait = key === "tr.cloud.startPendAmounts" || key === "tr.cloud.startPendAmountsStale" || key === "tr.cloud.startPendSlow";
  p.classList.toggle("cx-wait", wait);
  if (wait) { const sp = trEl("span", "spin16"); sp.setAttribute("aria-hidden", "true"); p.appendChild(sp); }
  const line = wait ? trEl("span", "") : p;
  const text = t(key), word = t("tr.tab.pos"), at = text.indexOf(word);
  if (at < 0) line.append(text);
  else {
    const a = trEl("button", "btn-quiet tr-noamt-link", word); a.type = "button"; a.addEventListener("click", () => trSetTab("pos", true));
    line.append(text.slice(0, at), a, text.slice(at + word.length));
  }
  if (wait) p.appendChild(line);
}
/* 「確認帳戶」的確認框(spec-account-confirm §2.2):主鈕「同一個帳戶」、次鈕「不同帳戶」(不用紅色:兩個都是正當答案、都不下單);
   預設焦點與 Esc 在取消(confirmBox 本來的行為)。送的是 book_account_confirm {venue, same},沒有任何祕密;
   pending 用 "acct",報告裡 book_hold 不見了才收斂(trPendingCheck)。答完 HALT 照舊,主鈕自己換回「啟動下單」 */
function trAskAccount(opener) {
  const h = trBookHold(trReport()); if (!h) return;
  const venue = h.venue, v = trVenueLabel(venue, true);
  const send = (same) => {
    srSay(t("tr.acct.sent"));
    return trRun("acct", [(S) => trSend(S, "book_account_confirm", { venue, same }).then((res) => {
      if (res && res.ok) S.acctDone = { venue, outcome: res.result && typeof res.result === "object" ? String(res.result.outcome || "") : "" };
      // 機器拒絕(ok:false,"ValueError: …"):過場由 trRun 收掉、講機器的原因,去掉 Python 的例外名(同網頁)
      else if (res && typeof res.error === "string") return Object.assign({}, res, { error: res.error.replace(/^ValueError: /, "") });
      return res;
    })], "book_account_confirm");
  };
  confirmBox(trCloudBox({ title: t("tr.acct.title", { v }), opener, lines: [t("tr.acct.body", { v }), t("tr.acct.ifSame", { v }), t("tr.acct.ifDiff", { v })],
    ok: t("tr.acct.same"), onOk: () => send(true), alt: { label: t("tr.acct.diff"), onOk: () => send(false) } }));
}
function trAskRelease(opener) {
  const r = trReport() || {}, k = trReleaseKind(r);
  // 只送 resume,而且標成 release:主行程照這個旗標不記「開始下單」的遙測、最低版本閘的字也換成解除暫停那句(稽核 B1 / B3)
  const go = () => { srSay(t("tr.releaseHint")); return trRun("released", [(S) => trSend(S, "resume", {}, "release")], "resume"); };
  if (k.kind === "x0") {
    // 自動觸發的 HALT(金鑰被拒、讀帳失敗、帳戶守衛):清 HALT 等於確認那件事處理好了(帳戶守衛那一種就是確認帳戶變更)
    const auto = !!(r.halt && r.halt.halted) && trHaltStopsAll(r.halt);
    confirmBox(trCloudBox({ title: t("tr.relTitle"), opener, lines: [t("tr.relBody")].concat(auto ? [t("tr.relAuto")] : []), ok: t("tr.release"), onOk: go }));
    return;
  }
  // 會平倉:主鈕是安全的「先不要」(焦點與 Esc 都在它),次鈕是破壞性的平掉並解除。逐筆列出要平的部位(§3.3 方案 A)
  const x1 = k.kind === "x1", paper = trIsPaper(), extra = document.createDocumentFragment();
  if (k.rows) {
    if (k.at != null) extra.appendChild(trEl("p", "cf-sub", t("tr.relReadAt", { time: trRelTime(k.at, Date.now()) })));
    const dl = trEl("dl", "cf-rows"), shown = k.rows.length > 6 ? k.rows.slice(0, 5) : k.rows;
    shown.forEach((x) => {
      const row = trEl("div", "cf-row pos"), dt = trEl("dt", "mono", x.sym.replace(/@spot$/, "")), dd = document.createElement("dd");
      if (x.v) dt.appendChild(trEl("span", "side " + (x.v > 0 ? "buy" : "sell"), x.v > 0 ? t("tr.rel.long") : t("tr.rel.short")));
      (x.lots ? trLotsInto : trMoneyInto)(dd, Math.abs(x.v));
      row.append(dt, dd); dl.appendChild(row);
    });
    extra.appendChild(dl);
    if (shown.length < k.rows.length) extra.appendChild(trEl("p", "cf-sub", t("tr.relMore", { n: k.rows.length - shown.length })));
  }
  extra.appendChild(trEl("p", "cf-note", t("tr.relSelfCode")));
  confirmBox(trCloudBox({ title: x1 ? (k.n ? t("tr.relX1Title", { n: k.n }) : t("tr.relX1TitleN")) : k.rows ? t("tr.relX2Title") : t("tr.relX2TitleN"), opener, single: true,
    mark: paper ? t("tr.mode.paper") : t("tr.mode.real"), markKind: paper ? "paper" : "real",
    // 讀不到部位 / 帳本(沒有清單):換成「可能」那一組標題與內文,不接以冒號結尾的引言(設計稽核 M4,同網頁)
    lines: [x1 ? (k.rows ? t("tr.relX1Lead") : t("tr.relX1BodyN")) : k.rows ? t("tr.relX2Lead") : t("tr.relX2BodyN")], extra,
    ok: t("tr.relNotNow"), onOk: () => {}, alt: { label: t("tr.relCloseGo"), danger: true, onOk: go } }));
}
// 「{time} 讀到的部位」的時間:當天只寫 HH:mm,其他天 MM/DD HH:mm
function trRelTime(ms, nowMs) { const d = new Date(ms); return d.toDateString() === new Date(nowMs).toDateString() ? trHM(ms) : trMD(d) + " " + trHM(ms); }
function trPaintGoStop(on) {
  let s = $("tr-go-stop"), hint = $("tr-go-hint");
  if (!on) { if (s) s.remove(); if (hint) hint.remove(); TR.goStopSaid = false; return; }
  if (!s) {
    s = trEl("button", "btn-quiet tr-go-stop", t("tr.stop")); s.type = "button"; s.id = "tr-go-stop";
    // 框的 opener 給主鈕:選了暫停之後這顆會收掉,焦點回到它身上就掉到 BODY 了
    s.addEventListener("click", () => { if (TR.pending) trAskStop($("tr-go") || s); });
    $("tr-act").appendChild(s);
  }
  s.textContent = t("tr.stop");
  if (!hint) { hint = trEl("span", "sr-only", ""); hint.id = "tr-go-hint"; $("tr-act").appendChild(hint); }
  hint.textContent = t("tr.startingHint");
  if (!TR.goStopSaid) { TR.goStopSaid = true; srSay(t("tr.startingHint")); }
}
function trPaintRoNote(key) {
  const n = $("tr-ro-note"), sig = LANG + "|" + key;
  if (ENV.sig.ro === sig) return;
  ENV.sig.ro = sig; n.textContent = ""; n.hidden = !key;
  if (!key) return;
  const go = trEl("button", "btn-quiet", t("plan.openWs")); go.type = "button";
  go.addEventListener("click", () => window.blave.openExternal(planWebUrl()));
  n.append(t(key) + " ", go);
}
// 停機:紅記號 + 一段話(數字來自方案頁同一個來源;拿不到數字就用不帶數字的那句,不寫死)
function trPaintVerdict(on) {
  const box = $("tr-verdict"), v = on ? planVars() : null, sig = LANG + "|" + (on ? v.m + "|" + v.h : "");
  box.hidden = !on;
  if (ENV.sig.verdict === sig) return;
  ENV.sig.verdict = sig; box.textContent = "";
  if (!on) return;
  const row = trEl("div", "verdict"), mark = trEl("span", "fault-mark"); mark.setAttribute("aria-hidden", "true");
  row.append(mark, trEl("span", "", v.m && v.h ? t("tr.cloud.stoppedBody", v) : t("tr.cloud.stoppedBody0")));
  box.appendChild(row);
}

/* 雲端的確認框:標題列的「雲端」記號 + 錢記號,鈕正上方再講一次目的地(規格 §5:同一件事刻意講三次——
   花真錢的動作,人要在按下去的前一秒知道他在動哪一台)。本機不給這兩個參數,框逐位元組不變。 */
function trCloudBox(o) {
  if (TR.env !== "cloud") return o;
  const id = trVenueId(), money = envMoney(TR.st);
  o.env = "cloud"; o.mark = envMoneyText(money) || null; o.markKind = money || null;
  o.footWhere = trWhereTidy(t("tr.cloud.footWhere", { where: t("env.cloud"), money: envMoneyText(money), venue: trVenueLabel(id, true) }));
  return o;
}
/* 啟動還沒生效時按暫停:框最上面講清楚「排在啟動後面、最後停在暫停、中間若已下單部位會留著」。不寫「取消」——做不到 */
function trStopAfterStartLead(canFlatten) {
  const row = trEl("div", "verdict is-calm"), mark = trEl("span", "fault-mark"); mark.setAttribute("aria-hidden", "true");
  row.append(mark, trEl("span", "", t("tr.stopAfterStart") + (canFlatten ? (LANG === "zh" ? "" : " ") + t("tr.stopAfterStartFlat") : "")));
  return row;
}
function trAskStop(opener) {
  const r = trReport() || {};
  confirmBox(trCloudBox({
    title: t("tr.stop"), mark: trIsPaper() ? t("tr.mode.paper") : null, opener,
    lead: trStartPending(TR.pending) ? trStopAfterStartLead(r.can_flatten === true) : null,
    // 重開沒停住(C):沒有啟動鈕,「之後按啟動下單」要先更新(audit S1)
    lines: [r.self_ledger === true ? t("tr.stopChoiceSelf") : t("tr.stopChoice"), trRestartUnconfirmed(r) ? t("tr.cloud.closeAllWarn2Unconfirmed") : t("tr.closeAllWarn2")],
    ok: t("tr.stopKeep"), onOk: () => trRun("halted", [(S) => trSend(S, "halt", { reason: "desktop ui" })], "halt"),
    // 沒有平倉層的 workspace 不給「看起來成功但沒平」的鈕(同雲端 can_flatten)
    alt: r.can_flatten === true ? { label: t("tr.stopFlat"), danger: true, onOk: () => trRun("halted", [(S) => trSend(S, "close_all", {})], "close_all") } : null,
  }));
}
// 中文句子裡夾英文名(Binance)前後要空一格;英文句子本來就有空格
function trPadLatin(name) { return LANG === "zh" && /^[\x20-\x7e]+$/.test(name) ? " " + name + " " : name; }
/* Blave 的帳本基準寫了沒(回報裡的對帳快照 last_reconcile,lib/portfolio._write_reconcile_snapshot):
   "built" = 快照帶 ledger(對帳器已經拿自己的帳本在比)→ 之後啟動不會再把帳戶上的部位算成 Blave 的;
   "none"  = 快照帶 needs_baseline(基準還沒寫)→ 第一次對帳會照 1.5 倍規則收編同方向的現有部位(_auto_baseline,一次定案);
   "unknown" = 沒有快照、兩個欄位都沒有,或原因是 unconfigured(還沒存過金額:新機存第一份金額時 runtime 會寫一份從零開始的基準,
   那時什麼都不收編;舊機則會收編——從這一格看不出是哪一種)。純函式 */
function trBookBaseline(r) {
  const last = r && r.last_reconcile;
  if (!last || typeof last !== "object") return "unknown";
  if (last.ledger && typeof last.ledger === "object") return "built";
  const nb = last.needs_baseline;
  return nb && typeof nb === "object" && nb.reason !== "unconfigured" ? "none" : "unknown";
}
/* 啟動框的句子分兩層(Wei 0928 第 3 點 A 案的逐句分類):keep = 每次都要看的常駐句,details = 看懂一次就好的、收在「細節」裡。
   回 { keep: [句], details: [{ label, items | text }] },純函式(tests/check_shell_start_box.js 切出來跑)。
   這台電腦:常駐「睡眠、關機、結束 Blave 時不下單也不停損」;真錢再加交易所停損單那一句(模擬帳戶沒有交易所端的停損單,那句在那裡是假的)。
   雲端:常駐換成主機費與停機門檻(金額來自方案頁同一個來源;拿不到數字就整句不出——不寫死、也不生一句沒有數字的半套說法)。
   own = 回報證明機器只碰帳本裡的部位(self_ledger);那一句只給真錢(模擬帳戶沒有用戶手動開的部位),而且跟著帳本基準分三種說法(book):
   還沒建 → 「同方向的部位第一次對帳會算進來」＋細節裡 1.5 倍那一段;已建 → 只講「你自己開的不算 Blave 的」(那時沒有東西會被算進來,
   講了會讓人以為手動部位抵掉了目標、實際曝險比預期大);讀不到 → 只講兩種情況都成立的那半句 */
function trStartNotes(o) {
  const keep = [], items = [], details = [];
  if (o.own && o.real) {
    // 統一(這台電腦):同月份手動交易分不清那一句取代加密口吻的三種說法(完成頁那段說明搬過來的,設計師裁定)
    keep.push(t(o.pres ? "tr.keep.pres" : o.book === "none" ? "tr.keep.ownFirst" : o.book === "built" ? "tr.keep.ownBuilt" : "tr.keep.own"));
    if (o.book === "none") details.push({ label: t("tr.det.own"), text: t("tr.det.ownRule") });
  }
  if (o.cloud) {
    if (o.v && o.v.h && o.v.m) keep.push(t("tr.cloud.means.3", o.v));
    items.push(t("tr.cloud.means.1"), t("tr.cloud.means.4"));
  } else {
    keep.push(t("tr.keep.sleep"));
    if (o.real) keep.push(t("tr.means.4"));
    items.push(t("tr.means.1"), o.paper ? t("tr.means.2p") : t("tr.means.2", { venue: o.venue }), t("tr.means.3"));
    if (o.pres) items.push(t("tr.means.presNight"));   // 台指期夜盤也會下單、電腦要一直開著
  }
  return { keep, details: details.concat([{ label: t(o.cloud ? "tr.det.cloud" : "tr.det.local"), items }]) };
}
/* 「細節」真錢第一次預設展開、第二次起收起;模擬一律收起。依視角分開記,啟動指令被機器收下才寫入(這台電腦的偏好,localStorage) */
const trStartSeenKey = (env) => "tr_start_seen_" + (env === "cloud" ? "cloud" : "local") + "_real";
// 兩邊都在用真錢:只知道「都是真錢」,不知道是不是同一個帳戶 → 灰記號的提醒(規格 §3),不是封鎖
function trBothReal() {
  if (TR.env !== "cloud" || envMoney(TR.st) !== "real" || envMoney(TR_BAGS.local.st) !== "real") return null;
  const row = trEl("div", "verdict is-calm"), mark = trEl("span", "fault-mark"); mark.setAttribute("aria-hidden", "true");
  const box = trEl("span", "");
  box.append(trEl("strong", "", t("tr.cloud.bothReal.h")), " " + t("tr.cloud.bothReal.b"));
  row.append(mark, box); return row;
}
function trAskStart(opener, presOk) {
  // 第一次用真錢啟動統一策略(這台電腦):先多一道口數＋權益數的確認(renderer/president.js presFirstGate)
  if (!presOk && typeof presFirstGate === "function") return presFirstGate(() => trAskStart(opener, true), opener);
  const r = trReport() || {}, canWait = r.can_wait_start === true, cloud = TR.env === "cloud";
  if (trZView(envHeadState(TR.st, Date.now()), r).off) return;   // 第二道:沒有策略設金額時啟動下單不送(鈕本來就停用)
  /* 順序照雲端:先送所選指令(resume_wait 的 gate 要先落地),對帳器沒在跑再叫它起來。
     **雲端不順帶送 restart_reconciler**:那份報告可能是一分鐘前的,照它判等於瞎猜;而主機重開後對帳器停著的情況,
     機器端的 resume / resume_wait 自己會把它起來(command_listener._start_after_restart_stop)。
     其他原因死掉的雲端對帳器,電腦版沒有重啟鈕:「對帳器停了」那一態照實講,重啟在網頁工作頁做 */
  const go = (cmd) => { TR.startAt = Date.now(); return trRunStart(cmd); };   // 表底失敗:按下之前的那些不再講成現在式(trErrLoud)
  // real = 連的是真的交易所;沒連交易所(主機重開後停著、只有啟動鈕清得掉)兩個都不是:不掛記號、句子用不講「真實委託」的那一組
  const paper = trIsPaper(), real = envMoney(TR.st) === "real", seenKey = trStartSeenKey(TR.env);
  // 機器收下啟動指令(不是被帳戶確認擋住的 held)才算啟動過一次:真錢的「細節」下次就收著
  const sent = (res) => { if (real && res && res.ok && !trHeldVenue(res)) lsSet(seenKey, "1"); return res; };
  const trRunStart = (cmd) => trRun("running", cloud ? [(S) => trSend(S, cmd, {}).then(sent)] : [
    (S) => trSend(S, cmd, {}).then(sent),
    (S) => { return trRecRunning(S.st) ? { ok: true } : trSend(S, "restart_reconciler", {}); },
  ], cmd);
  const recomputing = trRecomputing(r), rkS = trRestartKind(r);
  const notes = trStartNotes({ cloud, paper, real, own: r.self_ledger === true, book: trBookBaseline(r), v: cloud ? planVars() : null, venue: paper ? "" : trPadLatin(trVenueLabel(trVenueId(), true)), pres: !cloud && trVenueId() === "president" });
  const catchUp = () => { if (!trRecomputing(trReport())) go("resume"); };   // 框開著的時候不會跟著回報翻:要等重算完,關掉重開一次
  const money = real ? "Real" : "";
  confirmBox(trCloudBox(Object.assign({
    title: t("tr.start"), mark: paper ? t("tr.mode.paper") : real ? t("tr.mode.real") : null, markKind: real ? "real" : "paper", opener,
    lead: trBothReal(),
    keep: notes.keep, details: notes.details, detailsOpen: real && lsGet(seenKey) !== "1",
  }, canWait ? {
    // 重開過(主機 / Blave):到現在都沒有下單,部位可能跟訊號對不上——最上面的狀態句,在選「補齊 / 等新訊號」之前講
    lines: rkS === "machine" ? [t("tr.cloud.restartStartLine")] : rkS === "app" ? [t("tr.restartStartLineLocal")] : [],
    choicesLabel: t("tr.opt.legend"),
    choices: [
      // Blave 重開(本機):關著的時候策略沒跑,現在補齊用的可能是舊訊號——掛在它影響的那個選項裡。主機重開(B)由重算那一句與閘門講
      { id: "catch", title: t("tr.opt.catch"), desc: t("tr.opt.catchDesc" + money), warn: rkS === "app" ? t("tr.opt.catchStale") : null,
        disabled: recomputing, why: t("tr.cloud.recomputing"), ok: t("tr.startCatchUp"), onOk: catchUp },
      { id: "wait", title: t("tr.opt.wait"), desc: t("tr.opt.waitDesc" + money), ok: t("tr.startWait"), onOk: () => go("resume_wait") },
    ],
    ok: t("tr.start"),
  } : {
    // 機器端只有一種啟動方式(舊 lib,沒有 can_wait_start):沒有東西可選,照舊一顆主鈕
    lines: (rkS === "machine" ? [t("tr.cloud.restartStartLine")] : rkS === "app" ? [t("tr.restartStartLineLocal")] : [])
      .concat(recomputing ? [t("tr.cloud.recomputing")] : []).concat([t("tr.startWarn1")]),
    ok: t("tr.startCatchUp"), okDisabled: recomputing, okWhy: recomputing ? t("tr.cloud.recomputing") : null, onOk: catchUp,
  })));
}

/* ── 分頁 ───────────────────────────────────────────── */
function trNeedsSetup() {
  const a = trStored() || {};
  return !Object.keys(a).some((n) => a[n] > 0);
}
function trSetTab(tab, focus) {
  TR.tab = tab; TR.landed = true;
  trackFeature(TR_TAB_FEATURE[tab]);   // 每次都記:進到這一頁的落點、人切分頁、切視角後同步都是「這個分頁在他眼前」;api 每日去重,多記無妨
  if (tab !== "pos" && TR.netOpen) TR.netOpen.clear();   // 部位表的拆解展開只活在這一趟
  $("tr-tabs").querySelectorAll(".main-tab").forEach((b) => {
    const on = b.dataset.tab === tab;
    b.setAttribute("aria-selected", on ? "true" : "false"); b.tabIndex = on ? 0 : -1;
    if (on && focus) b.focus();
  });
  TR_TABS.forEach((k) => { $("tr-" + k).hidden = k !== tab; });
  trPaintTab();
}
function trPaint() {
  if (!envPaint()) return;                         // 雲端沒有主機可看(沒主機 / 未登入 / 啟動中 / 讀不到):中欄是空態,這一頁不畫
  trPaintHead();
  if (typeof presBannerPaint === "function") presBannerPaint();
  if (!TR.open) return;
  // unknown(狀態檔這一輪沒寫出來)也走這個版面,但畫的是一段說明、不是 onboard——標題列的暫停鈕還在
  const state = trExecState(TR.st), assumed = TR.env === "cloud" && state === "noaccount" && trCxAssumed(TR.cxSaved, Date.now());
  // 模擬帳戶剛連上、報告還沒帶進來:畫分頁 + 骨架,不畫 onboard(S-1)
  /* 模擬帳戶剛存好、第一份報告還沒到:收掉分頁列(五個分頁在沒有資料時通往五張空畫面),
     內文用 §5 那組 .cx-wait 兩行(做完什麼 + spinner + 在等什麼)。骨架退場:骨架承諾的是「馬上就到,
     形狀先給你」,這裡等的是主機下一班回報,而且填進去那一刻是跳不是補(spec §3-2,設計師收回 §11 的核准) */
  const bare = assumed || state === "noaccount" || state === "loading" || state === "unknown";
  $("tr-tabs").hidden = bare; $("tr-onboard").hidden = !bare;
  if (bare) {
    TR_TABS.forEach((k) => { $("tr-" + k).hidden = true; });
    if (state === "noaccount") TR.landed = false;   // 連上之後重新決定落點(狀態不明只是暫時的,回來要留在原分頁)
    trPaintOnboard(state); return;
  }
  // 落點(同雲端 pfNeedsSetup):金額全 0 → 部位,否則總覽;手動選過就不再蓋台
  if (!TR.landed || !TR.tab) { trSetTab(trNeedsSetup() ? "pos" : "over"); return; }
  TR_TABS.forEach((k) => { $("tr-" + k).hidden = k !== TR.tab; });
  trPaintTab();
}
/* 「等主機」那兩行(spec v2 §5 定稿、waiting-states §3 沿用):第 1 行是已經完成的事,
   第 2 行是 16/2 圓環 spinner + 在等誰 / 多久 / 會自己好 / 不用做事。done = 第 1 行那句的 key */
function trWaitTwoLines(done) {
  const box = document.createDocumentFragment();
  box.appendChild(trEl("p", "cx-saved", t(done)));
  const wait = trEl("p", "cx-saved cx-wait"), sp = trEl("span", "spin16"); sp.setAttribute("aria-hidden", "true");
  wait.append(sp, trEl("span", "", t("tr.cloud.cxWaiting")));
  box.appendChild(wait);
  return box;
}
function trPaintTab() {
  if (TR.tab === "over") trPaintOver();
  else if (TR.tab === "pos") trPaintPos();
  else if (TR.tab === "assets") trPaintAssets();
  else if (TR.tab === "hist") trPaintHist();
  else if (TR.tab === "set") trPaintSet();
}
function trPaintOnboard(state) {
  const box = $("tr-onboard");
  const fails = trFailedIds(trReport());
  const saved = TR.env === "cloud" ? TR.cxSaved : null, savedStale = trCxSavedStale(saved, Date.now());
  const assumed = TR.env === "cloud" && state === "noaccount" && trCxAssumed(saved, Date.now());
  if (!trShould("onboard", box, [state, fails, TR.env, saved && [saved.venue, saved.code, saved.detail], savedStale, TR.env === "cloud" && envCloudKind(TR.st), trNoAccountStopped(trReport())])) return;
  box.textContent = "";
  /* 等主機第一份報告(spec-desktop-waiting-states §3):兩條路同一套——第 1 行講已經完成的事,
     第 2 行圓環 spinner + 在等誰、多久、會自己好、不用做事(§5 定稿的那組字與 .cx-wait,不另寫)。
     標頭已經講了「正在跟你的主機要資料」,所以這裡不再出第二次「載入中…」(§1 規則 4) */
  if (assumed || (state === "loading" && TR.env === "cloud")) { box.appendChild(trWaitTwoLines(assumed ? "tr.cloud.cxSavedPaperDone" : "tr.cloud.machineUp")); return; }
  if (state === "loading") { box.appendChild(trEl("div", "pf-state", t("tr.loading"))); return; }
  // 「要停就按暫停下單」只在那顆鈕真的能按的時候才講(下單機不在跑時鈕是 disabled,那句就是假話)
  if (state === "unknown") { box.appendChild(trEl("div", "pf-state", TR.env === "cloud" ? t("env.empty.unreach") : t("tr.unknownBody") + (TR.st && TR.st.alive ? t("tr.unknownStop") : ""))); return; }
  const cloud = TR.env === "cloud", ob = trEl("div", "pf-onboard");
  // 雲端:只講「還沒接交易所」+「這台電腦連的不會帶過來」(spec-desktop-cloud-writable §6 / §8.4);出口是下面那顆鈕,句子裡不再寫「只能看」
  ob.appendChild(trEl("p", "", cloud ? t("tr.onboard.cloud") + (LANG === "zh" ? "" : " ") + t("tr.cloud.onboardExtra") : t("tr.onboard")));
  /* 雲端(S5):同一顆「連接交易所」。金鑰送出、主機說寫進去了之後,這裡換成「已存到、等回報」:呼吸點 + 一句,沒有鈕、不倒數;
     權限的結果(沒設白名單、現貨/合約沒開)只在這一態講一次——雲端那把 app 不會重查,之後畫出來就是一份永遠不更新的舊判決 */
  if (saved && savedStale) {
    // 等太久主機還沒回報(沒有這一家、也沒有錯):講清楚,鈕還回來(再連一次是安全的:同一把金鑰再查再寫)。不出紅字——不知道是哪裡慢
    ob.textContent = "";
    ob.appendChild(trEl("p", "", t(saved.venue === PAPER ? "tr.cloud.cxSavedStalePaper" : "tr.cloud.cxSavedStale")));   // 模擬帳戶沒有金鑰,不能講「金鑰已經送出」
    const b = trEl("button", "btn-fill", t("cx.connect")); b.type = "button"; b.id = "tr-connect"; b.addEventListener("click", () => cxModalOpen(b)); ob.appendChild(b);
  } else if (saved) {   // 真實交易所(模擬在 trPaint 就走骨架那條)
    // 兩行(v2 §5);這一條只有真實交易所走得到(模擬在上面就被 assumed 接走)
    ob.textContent = "";
    ob.appendChild(trWaitTwoLines("tr.cloud.cxSavedBn"));
    const calm = (text) => { const p = trEl("p", "plan-err is-calm"), m = trEl("span", "fault-mark"); m.setAttribute("aria-hidden", "true"); p.append(m, trEl("span", "", text)); ob.appendChild(p); };
    if (saved.venue === BINANCE) {
      if (saved.code === "NO_IP_RESTRICT") calm(t("cx.chk.noWhitelistCloud"));
      if (saved.detail && saved.detail.futures === false) calm(t("cx.note.noFutures")); else if (saved.detail && saved.detail.spot === false) calm(t("cx.note.noSpot"));
    }
  } else {
    // B0(沒有交易所的重開停止):標頭只有描邊的「解除暫停」,先解停止;這顆同樣是描邊,不跟它搶
    const b = trEl("button", trNoAccountStopped(trReport()) ? "btn-out" : "btn-fill", t("cx.connect")); b.type = "button"; b.id = "tr-connect"; b.addEventListener("click", () => cxModalOpen(b)); ob.appendChild(b); }
  box.appendChild(ob);
}

/* ── 部位分頁:策略金額表 + 交易所部位表 ─────────────────────────── */
function trPaintPos() {
  const box = $("tr-pos"), r = trReport() || {};
  const names = trNames(), stored = trBase(), states = r.states || {};
  // 灰字的時間戳滿 24 小時才帶日期:dead 時快照凍住、app 一直開著,沒有別的資料會變——每一筆失敗的時間戳本身進簽章,跨過那一刻才會重畫
  const now = Date.now(), stamps = (Array.isArray(r.order_errors) ? r.order_errors : []).map((e) => e && typeof e === "object" ? trErrStamp(e.ts, now) : null);
  const data = [TR.env, TR.listLoaded, names, TR.list, stored, states, trEquity(), trUnit(), TR.save, TR.saveErr, r.last_reconcile, r.account, r.self_ledger, r.order_errors, stamps, trExecState(TR.st), envHeadState(TR.st, now), !!TR.sent, !!(TR.st && TR.st.alive),
    TR.picked ? [...TR.picked].sort() : null, trCfgUnread(r), trTxfPrice()];   // 報價回來了:口數列的目標部位、合計、倍數要換上
  if (!trShould("pos", box, data)) return;
  const refocus = trPosFocusOf(box);
  box.textContent = "";
  // 「選擇策略」三個分支都在(後兩個停用):鈕不在不在之間跳,位置穩定(picker §2)
  if (!TR.listLoaded) {
    // 策略清單還沒回來(或讀失敗):不畫金額表、更不畫儲存列——「清單是空的」在這時候不是事實,不能邀請人把策略移出組合
    box.appendChild(trSec(trTipLabel("label", t("tr.strategies"), t("tr.zeroMeansOff")), trPickBtn()));
    box.appendChild(trEl("div", "pf-state", t("tr.loading")));
  } else if (stored === null) {
    // 主機讀不到設定檔:金額不畫(畫 0 是假話)、不給存,下一份報告讀到就自己恢復
    box.appendChild(trSec(trTipLabel("label", t("tr.strategies"), t("tr.zeroMeansOff")), trPickBtn()));
    box.appendChild(trEl("div", "pf-state", t("tr.cfgNull")));
  } else box.appendChild(trAmountTable(names, stored, states));
  box.appendChild(trPositions(r, stored || {}, states));
  trPosFocusBack(box, refocus);
}
/* 「選擇策略」現在開不開得了(picker §2):儲存生命週期中不開(存好了還在等主機回報對上時,底稿是上一份回報,
   這時送出去會把在路上的新金額整包蓋掉)、讀不到設定不開、清單沒載入不開、雲端讀不到新狀態不開(同儲存鈕的 stale) */
function trPickOff() {
  const cloud = TR.env === "cloud";
  return TR.save === "saving" || (cloud && TR.save === "sent") || !TR.listLoaded || trStored() === null || trCfgUnread(trReport()) || (cloud && !(TR.st && TR.st.alive));
}
function trPickBtn() {
  const acts = trEl("div", "pf-acts"), b = trEl("button", "pf-act", t("tr.pick")); b.type = "button"; b.id = "tr-pick"; b.dataset.fk = "pick";
  b.disabled = trPickOff();
  b.addEventListener("click", () => psOpen(b));
  acts.appendChild(b); return acts;
}
/* 這一列是不是台指期口數列:標的看主機回報的 states,沒有就看清單(同金額表那一格的 sym) */
function trRowTxf(n) { const st = ((trReport() || {}).states || {})[n] || {}, x = TR.list.find((y) => y.name === n) || {}; return trTxfSpec(st.symbol || x.symbol); }
function trRowIsLot(n) { return !!trRowTxf(n); }
// 這一列的錢:口數列換成參考金額(沒有報價 = null),其他照原值
function trRowMoney(n, v) { const sp = trRowTxf(n); return sp ? trTxfRefMoney(sp, v, trTxfPrice()) : v; }
/* 金額表畫到口數列時叫(同網頁 renderPosTab 裡的 loadTxfQuote):報價過期才在背景問主行程。
   問不到不清掉手上那一份;失敗後 60 秒再問(同主行程的退避),合計與目標部位在沒有報價時照網頁畫「—」 */
function trTxfWant(now) {
  const t0 = now == null ? Date.now() : now;
  if (TR_TXF.busy || t0 - TR_TXF.at < (TR_TXF.price == null ? TR_TXF_RETRY_MS : TR_TXF_MS)) return false;
  if (typeof window === "undefined" || !window.blave || typeof window.blave.txfQuote !== "function") return false;
  TR_TXF.busy = true;
  Promise.resolve(window.blave.txfQuote()).then((p) => { if (typeof p === "number" && isFinite(p) && p > 0) TR_TXF.price = p; })
    .catch(() => {}).finally(() => { TR_TXF.busy = false; TR_TXF.at = Date.now(); });
  return true;
}
/* 金額表的策略名(spec-0.1.12-pf-strategy-link):清單上有這支才是鈕,點了開它的進出場紀錄;
   不在清單(被刪、資料夾改名)照舊純文字,不帶人進死路。整列不可點:每列都有金額輸入框 */
function trStratName(n) {
  if (!TR.list.some((y) => y.name === n)) return trEl("span", "", trDisplay(n));
  const b = trEl("button", "pf-strat", trDisplay(n)); b.type = "button"; b.dataset.name = n;
  b.addEventListener("click", () => trStratOpen(n, b));
  return b;
}
/* 輪詢重畫(對帳、讀帳每輪都會改簽章)會整張重建,焦點所在的那顆鈕跟著被拆掉、掉到 body。重建前記下是哪一顆
   (策略名認 data-name;選擇策略、還原、儲存、區段標題的說明鈕認 data-fk),重建後還給同一顆;
   找不到或現在按不到(那一列變成文字、儲存列收起、鈕停用)→ 交給「部位」分頁鈕(同還原鈕)。
   不能改成「焦點在鈕上就不重畫」:數字會停住 */
function trPosKey(el) { return el.classList.contains("pf-strat") ? "strat:" + el.dataset.name : el.dataset.fk ? "fk:" + el.dataset.fk : null; }
function trPosFocusOf(box) {
  const a = document.activeElement;
  return a && a !== box && box.contains(a) && a.dataset ? trPosKey(a) : null;
}
function trPosFocusBack(box, key) {
  if (key == null) return;
  const b = [...box.querySelectorAll(".pf-strat, [data-fk]")].find((x) => trPosKey(x) === key && !x.disabled && !x.closest("[hidden]")) || $("tr-tab-pos");
  if (b) b.focus();
}
/* 同結果卡那條「從別處打開策略某個分頁」(results.js resOpenStrat),但分頁要在 select **之前**定:
   stratSelect 自己畫 rpTab(RP),雲端則是資料到了才畫,畫完再補切會閃一下、雲端那條也切不到 */
async function trStratOpen(n, el) {
  const S = TR, x = S.list.find((y) => y.name === n), st = S.st;
  // 焦點在金額格時輪詢不重畫這張表,鈕可能比清單舊;雲端清單沒讀到(不是 OK)不下「已刪除」的結論,照開、讀不到由報告頁講
  const gone = !x || (S.env === "cloud" && st && st.cloud && st.cloud.code === "OK" && !envCloudList(st).some((y) => y.name === n));
  if (gone) {
    // 同結果卡的已刪除態:原地換成純文字並唸一句;焦點留在那個名字上,不掉到 body
    const s = trEl("span", "", el.textContent); s.tabIndex = -1;
    el.replaceWith(s); s.focus(); srSay(t("res.gone.strat"));
    return;
  }
  // 雲端要等資料回來才知道成不成功,讀不到由報告頁自己講:照開就算;本機確定打開了才算
  if (S.env === "cloud") { RPC.tab = trStratTab(x); trackFeature("trade_strat_open"); await rpCloudSelect(n, true); }
  else {
    RP.tab = trStratTab(x); await stratSelect(n, true);
    // 清單說在、檔案卻讀不到(agent 剛從 shell 刪掉):stratSelect 已收到歡迎頁,帶回「部位」並講一句,不靜靜落在歡迎頁
    if (RP.name === null) {
      await trOpen("pos"); srSay(t("res.gone.strat"));
      const tb = $("tr-tab-pos"); if (tb && tb.offsetParent) tb.focus();
      return;
    }
    if (RP.name !== n || !RP.data) return;   // 等的時候點了別支
    trackFeature("trade_strat_open");
  }
  resFocusHead();
}
function trAmountTable(names, stored, states) {
  const frag = document.createDocumentFragment();
  frag.appendChild(trSec(trTipLabel("label", t("tr.strategies"), t("tr.zeroMeansOff")), trPickBtn()));
  const total = trEl("div", "pf-total"), lev = trEl("div", "pf-lev"), bar = trEl("div", "pf-savebar"), cloud = TR.env === "cloud";
  /* 雲端(spec-desktop-cloud-s4):跟本機同一張表、同一套驗證,只差三件——讀不到新狀態不給存(amounts 是整份覆蓋,
     拿舊報告當底會蓋掉別處剛改的)、存完要等主機回報才對得上(.pend 記號)、送出走 trSend(單飛 + request_id 沿用)。 */
  // 讀不到金額設定:兩個視角都擋(本機的回報也是 build_report(),amounts 一樣是整份覆蓋)
  const cfgBad = trCfgUnread(trReport());
  const stale = cloud && (!(TR.st && TR.st.alive) || cfgBad), sentOn = cloud && !!TR.sent;
  const hidden = cloud ? trHidden(names, stored, trListNames()) : [];
  const gates = ((trReport() || {}).last_reconcile || {}).gates || {};
  // 表上有口數列:合計與表下單位那一行的錢是口數換出來的台幣(R2-S2)
  const moneyCcy = () => (names.some((n) => !!trRowTxf(n)) ? TR_TXF_CCY : trUnit());
  const paintTotal = () => {
    // 雲端:合計跟確認框同一個口徑——表上沒列出、但照原樣帶著送的那幾支也算進去(稽核 L3)
    // 淨值快照:確認框用這裡顯示的那一個(不再自己讀一次),同一組金額兩處的倍數才會一樣(0.0.3 實機 989.95x / 988.37x)
    const eq = trEquity(); TR.eqShown = { env: TR.env, v: eq };
    const am = cloud ? trSendAmounts("cloud", names, stored, TR.edits, trListNames()) : trCurrentAmounts(names, stored, TR.edits);
    const tt = trTotals(am, eq, trRowMoney, trRowIsLot, trUnit());
    total.textContent = "";
    total.appendChild(trEl("span", "", t("tr.total")));
    if (tt.total == null) total.appendChild(trEl("span", "n", "—"));
    else { const tn = trEl("span", "n", trFmt(tt.total)), tc = tt.ccy || trUnit(); if (tc) tn.appendChild(trEl("span", "ccy", tc)); total.appendChild(tn); }
    // 倍數一律墨色(spec-0.1.13 #5):真錢、模擬都不上紅,提醒靠下面那塊句子;模擬引擎的 10 倍上限已拿掉(#13)
    if (tt.mult != null) total.append(trEl("span", "", "·"), trEl("span", "", t("tr.ofEquity")), trEl("span", "n", tt.mult.toFixed(2) + "x"));
    paintLev(tt.mult, am);
  };
  /* 合計列下的倍數提醒(ux-order-1-4-5 §1.2):只在有未存的改動時出現(同儲存列的 dirty;存好就收,倍數本身是唯一常駐的提示)。
     槓桿那一句只對合約列講:全是現貨、或只有台指期口數列時不出(券商依口數收保證金,沒有「設幾倍」可做) */
  const swapOn = (am) => Object.keys(am).some((n) => am[n] > 0 && !trRowTxf(n) && ((states[n] || {}).market || (TR.list.find((y) => y.name === n) || {}).market) !== "spot");
  const paintLev = (mult, am) => {
    lev.textContent = "";
    const dirty = (trDirty(names, stored, TR.edits) || anyBad() || trPickStaged(TR.picked, stored, hidden).length > 0) && TR.save !== "saved";
    const paper = trIsPaper(), v = trLevLevel(mult, paper), margin = !paper && swapOn(am);
    lev.hidden = !dirty || !(v.level >= 2 || (v.level === 1 && margin));   // 第 1 級只有槓桿那一句:全現貨時整塊不出
    if (lev.hidden) return;
    if (v.level >= 2) {
      const row = trEl("div", "verdict is-calm"), mk = trEl("span", "fault-mark"); mk.setAttribute("aria-hidden", "true");
      row.append(mk, trEl("span", "", t(paper ? "tr.lev.lossPaper" : "tr.lev.loss", { p: v.p }))); lev.appendChild(row);
    }
    if (margin) {
      const bn = trVenueId() === BINANCE && v.L > 5 ? (LANG === "zh" ? "" : " ") + t("tr.lev.binance5") : "";
      lev.appendChild(trEl("p", "pf-lev-sub", t(v.level === 1 ? "tr.lev.margin" : "tr.lev.marginShort", { L: v.L }) + bn));
    }
  };
  const anyBad = () => Object.keys(TR.bad).length > 0;
  const settles = [];   // 每一格的離開欄位驗證:按「儲存」時全部重跑一次,不靠 blur 有沒有先發生(稽核 audit-0.1.13-web S1)
  let svBtn = null;   // 儲存鈕:blur 時只更新它的 disabled,不重建整列——打完直接點「儲存」時,mousedown 要落在還活著的那顆鈕上(稽核 R3)
  const paintBar = () => {
    bar.textContent = ""; bar.hidden = false;
    if (TR.save === "saving") { bar.appendChild(trEl("span", "txt", t("tr.saving"))); return; }
    if (TR.save === "saved") { bar.appendChild(trEl("span", "txt ok", "✓ " + t("tr.saved"))); return; }
    // dirty 含「有錢的策略被取消勾選還沒送出」(picker §6):那列已經從表上消失,儲存列是它唯一的出口
    const dirty = trDirty(names, stored, TR.edits) || anyBad() || trPickStaged(TR.picked, stored, hidden).length > 0;
    // 雲端存完、還沒對上、而且沒再改:只有一句等回報的話,沒有鈕(不出「已儲存 ✓」:這台電腦沒有套用任何東西)
    if (sentOn && !dirty && TR.save !== "failed") { bar.appendChild(trEl("span", "txt", t("tr.cloud.pendAmounts"))); return; }
    if (TR.save === "failed") bar.appendChild(trEl("span", "txt err", TR.saveErr || t("tr.cmdFailed")));
    else { bar.hidden = !dirty; bar.appendChild(trEl("span", "txt", cfgBad ? (cloud ? t("tr.cloud.cfgUnread") : t("tr.cfgUnreadLocal")) : stale ? t("tr.cloud.saveStale") : t("tr.unsaved"))); }
    const rv = trEl("button", "pf-cancel", t("tr.revert")); rv.type = "button"; rv.dataset.fk = "revert";
    // 還原 = 回到底稿(雲端存完還沒對上時是送出的那一份);picker 的選擇一起放掉(被 staged 移除的列帶原金額回來);內容變了,request_id 也跟著換(S4 §4)
    rv.addEventListener("click", () => { TR.edits = {}; TR.bad = {}; TR.raw = {}; TR.picked = null; delete TR.reqIds.amounts; TR.saveUnknownAt = 0; TR.save = TR.sent && cloud ? "sent" : null; TR.saveErr = null; TR.sig.pos = null; trPaintPos(); $("tr-tab-pos").focus(); });
    const sv = trEl("button", "btn-fill", t("tr.save")); sv.type = "button"; sv.dataset.fk = "save";
    sv.disabled = anyBad() || stale || cfgBad; svBtn = sv;   // 有一格看不懂就不給存:確認框列的必須是用戶打的那個數
    sv.addEventListener("click", () => { settles.forEach((f) => f()); if (!anyBad()) trSaveAmounts(names, stored, sv); });
    bar.append(rv, sv);
  };
  if (!names.length) {
    // 兩句分開(picker §13-1):有回測過的策略、只是一支都沒勾 → 叫人按旁邊那顆「選擇策略」;連候選都沒有才叫人去聊天
    const any = TR.list.some((x) => x.hasBacktest);
    frag.appendChild(trEl("div", "pf-state", any ? t("tr.pick.noneChosen") : cloud ? t("side.cloud.emptyCut1") : t("tr.noStrategies")));
    paintBar(); frag.appendChild(bar);             // 空狀態也可能有「移出組合」等著儲存(全部取消勾選):early return 會把儲存鈕吞掉,移除永遠送不出去
    return frag;
  }
  const scroll = trEl("div", "pf-scroll"), tbl = trEl("table", "pf-tbl");
  const head = trHead([[t("tr.col.strategy"), ""], [t("tr.col.symbol"), "c-sym"], [t("tr.col.amount"), "n"], [t("tr.col.signal"), "n c-sig"], [t("tr.col.targetPos"), "n" + (sentOn ? " pend-col" : "")]]);
  if (sentOn) head.querySelector("th:last-child").title = t("tr.cloud.pendTarget");
  tbl.appendChild(head);
  const tb = document.createElement("tbody");
  // 排序鍵跟顯示同一套換算(同網頁 sortVal):口數列換成參考金額,換不了當 0
  const sortVal = (n) => { const m = trRowMoney(n, stored[n] || 0); return m == null ? 0 : m; };
  names.slice().sort((a, b) => sortVal(b) - sortVal(a)).forEach((n) => {
    const x = TR.list.find((y) => y.name === n) || {}, st = states[n] || {};
    const sym = st.symbol || x.symbol, market = st.market || x.market, pc = trPortfolioRow(st, 0);
    // 台指期列:這一格是口數;標的欄寫商品名(微台／小台／大台,同網頁)
    const txf = pc ? null : trTxfSpec(sym);
    if (txf && cloud) trTxfWant();   // 群益只在雲端視角:本機不去問報價
    const symText = pc ? t("tr.nSyms", { n: pc.n }) : txf ? t(txf.prod) : sym || "—", symTip = pc ? pc.syms.map(trCanonSym).join(", ") : "";
    const row = document.createElement("tr");
    const first = trEl("td", "key");
    first.appendChild(trStratName(n));
    first.appendChild(trEl("span", "mkt-tag", market === "spot" ? t("tr.mkt.spot") : t("tr.mkt.swap")));
    const sub = trEl("span", "sub-sym" + (pc || txf ? "" : " mono"), symText); if (symTip) sub.title = symTip;
    first.appendChild(sub);
    // 投資組合策略沒有實盤路徑:0 → >0 是機器端必拒的轉換,從源頭鎖掉並講原因;已經 >0 的存量不鎖
    // 機器端的 lib 能讓投資組合自動下單(回報 can_trade_portfolio)就不鎖
    const locked = !!x.portfolio && !(stored[n] > 0) && !((trReport() || {}).can_trade_portfolio === true);
    // 雲端其實支援投資組合策略(已撥款的照跑),只是 app 不能從 0 開始撥(機器會拒):講真話,不沿用本機那句
    if (locked) first.appendChild(trEl("span", "pf-note", cloud ? t("tr.typeCHost") : t("tr.typeC")));   // 真正的原因是機器的 lib 太舊(spec-0.1.13-order-copy #12);出口在選擇策略框
    // 模擬交易裡的台幣計價存量(擋之前加進來的):照常列、講原因、可以減可以移出,不能再加(這一格其實是口數)
    const twdRow = x.twd === true && trVenueId() === PAPER;
    if (twdRow) first.appendChild(trEl("span", "pf-note", t("tr.pick.twd")));
    row.appendChild(first);
    const symTd = trEl("td", (txf ? "sname" : "sym") + " c-sym", symText); if (symTip) symTd.title = symTip;   // 商品名是漢字:不進等寬
    row.appendChild(symTd);
    const c = trEl("td", "n"), wrap = trEl("span", "amt-inw"), inp = trEl("input", "amt-in");
    inp.type = "text"; inp.inputMode = txf ? "numeric" : "decimal";
    // 送出中:本機照舊 disabled;雲端用唯讀(ack 最長約 20 秒,disabled 會把焦點丟到 BODY)
    if (cloud) { inp.disabled = locked; inp.readOnly = TR.save === "saving"; } else inp.disabled = locked || TR.save === "saving";
    inp.setAttribute("aria-label", trDisplay(n) + " — " + (txf ? t("tr.lotsAria") : trUnit() ? t("tr.amountAria", { ccy: trUnit() }) : t("tr.col.amount")));
    inp.value = TR.raw && TR.raw[n] != null ? TR.raw[n] : trFmt(TR.edits[n] != null ? TR.edits[n] : stored[n] || 0);
    // 口數列的單位永遠是「口」(不跟帳戶幣、讀帳失敗也一樣);窄寬收單位那條不收它——沒有單位的口數會被讀成錢
    const lotsUnit = txf ? trEl("span", "lots-unit", t(trLotsKey(TR.edits[n] != null ? TR.edits[n] : stored[n] || 0, "tr.lotsUnit", "tr.lotUnit"))) : null;
    wrap.append(inp);
    if (lotsUnit) wrap.appendChild(lotsUnit); else if (trUnit()) wrap.appendChild(trEl("span", "amt-unit", trUnit()));
    // 雲端存完還沒對上:這一格是送出的值 → .pend(灰一階 + 短線);再改就拿掉(它現在是用戶打的值)。短線那格一律留位,欄不跳
    const dash = sentOn ? trEl("span", "amt-dash") : null;
    const setPend = (on) => { inp.classList.toggle("pend", on); if (dash) dash.classList.toggle("off", !on); };
    if (dash) { dash.setAttribute("aria-hidden", "true"); wrap.appendChild(dash); setPend(TR.edits[n] == null); }
    c.appendChild(wrap); row.appendChild(c);
    // 訊號欄(§2.1):目標部位 = 金額 × 這一格;投資組合沒有單一訊號,寫「—」
    row.appendChild(trEl("td", "n sig", pc ? "—" : trSignalText(st.position)));
    const tgt = trEl("td", "n na", "—");
    const pos = typeof st.position === "number" ? st.position : 0;
    // 最小進場額:機器端只在門檻大於平台那顆 10 時才回報;填得比它小就永遠不會進場,而且完全靜音
    const g0 = sym ? gates[trCanonSym(sym) + (market === "spot" ? "@spot" : "")] : null;
    const gate = g0 && typeof g0.entry_usd === "number" ? g0.entry_usd : g0 && g0.side !== "reduce" && typeof g0.usd === "number" ? g0.usd : null;
    let gateRow = null;
    if (gate != null && !txf) {   // 口數列不掛(同網頁:門檻是錢,這一格是口)
      gateRow = document.createElement("tr");
      const ntd = trEl("td", "note"); ntd.colSpan = 5;
      ntd.appendChild(trEl("span", "pf-note", t("tr.gateHint", { m: trFmt(gate), c: trUnit() || "" }).replace(/ {2,}/g, " ").replace(/ (?=，)/g, "")));
      gateRow.appendChild(ntd);
    }
    const repaint = () => {
      // 口數列:目標部位 = 參考金額 × 部位;沒有報價就是未知(null),畫「—」(同網頁 paintTargetCell)
      const a = TR.edits[n] != null ? TR.edits[n] : stored[n] || 0, ref = txf ? trTxfRefMoney(txf, a, trTxfPrice()) : a;
      const v = pc ? trPortfolioRow(st, a).gross : ref == null ? null : ref * pos;
      tgt.className = "n " + (v === 0 || v === null ? "na" : pc ? "" : v > 0 ? "buy" : "sell") + (sentOn ? " pend-col" : "");
      if (pc) tgt.title = t("tr.grossTip");
      /* 「—」在這一欄本來的意思是「策略現在沒有部位」。等回報那段目標部位是拿**舊金額**算的,
         畫成同一條短線就把兩件事混成一個符號(Wei 因此把「等回報」讀成「等訊號」)。
         等回報時改畫跟金額欄同一種待回報記號,表下另有一句常駐說明(spec §2-3b) */
      if (v === null) tgt.textContent = "—";
      else if (v === 0 && sentOn) { tgt.textContent = ""; tgt.appendChild(trEl("span", "amt-dash")); }
      else if (v === 0) tgt.textContent = "—"; else trMoneyInto(tgt, v, !pc, txf ? TR_TXF_CCY : null);   // 多空合計沒有方向:不帶正負號
      if (gateRow) {
        const show = a > 0 && a < gate;
        if (show && !gateRow.parentNode) row.insertAdjacentElement("afterend", gateRow);
        else if (!show && gateRow.parentNode) gateRow.remove();
        row.classList.toggle("has-note", show || !!badRow.parentNode);
      }
    };
    const badRow = document.createElement("tr"), btd = trEl("td", "note"); btd.colSpan = 5;
    const bmsg = trEl("span", "pf-note err", ""); bmsg.id = "tr-bad-" + n;
    btd.appendChild(bmsg); badRow.appendChild(btd);
    const markBad = (why) => {                    // why:null / false = 沒事;"bad" = 不是數字;"big" = 超過上限;"twd" = 模擬交易的台幣標的不能加
      const bad = !!why, msg = why === "big" ? t("tr.amountTooBig") : why === "twd" ? t("tr.pick.twd") : why === "oldLots" ? t("tr.badLotsOld") : txf ? t("tr.badLots") : t("tr.badAmount"), was = bmsg.textContent;
      if (bad) { TR.bad[n] = true; bmsg.textContent = msg; } else delete TR.bad[n];
      inp.setAttribute("aria-invalid", bad ? "true" : "false");
      if (bad) inp.setAttribute("aria-describedby", bmsg.id); else inp.removeAttribute("aria-describedby");
      if (bad && (!badRow.parentNode || was !== msg)) { if (!badRow.parentNode) row.insertAdjacentElement("afterend", badRow); srSay(msg); }
      else if (!bad && badRow.parentNode) badRow.remove();
      row.classList.toggle("has-note", bad || !!(gateRow && gateRow.parentNode));
    };
    const parse = (s) => (txf ? trParseLots(s) : trParseAmount(s));
    inp.addEventListener("input", () => {
      const v = parse(inp.value);
      // 看不懂的字不進 edits(上一個看得懂的值留著);整格標成無效、儲存鈕鎖住(稽核 S11)
      if (v != null) TR.edits[n] = v;
      if (TR.raw) TR.raw[n] = inp.value;   // 原字跟著記:重畫時放回去(「2.」打到一半被重畫,不能變回「2」)
      if (lotsUnit && v != null) lotsUnit.textContent = t(trLotsKey(v, "tr.lotsUnit", "tr.lotUnit"));
      // 內容變了 = 新的意圖:上一趟的 request_id 不能沿用,否則 api 當成重送、新數字永遠不會套用(S4 §4)
      delete TR.reqIds.amounts; TR.saveUnknownAt = 0; setPend(false);
      if (TR.save === "failed" || TR.save === "saved") { TR.save = TR.sent && cloud ? "sent" : null; TR.saveErr = null; }
      // 打到一半不報錯(「100,00」是「100,000」的半路):看不懂就什麼都不標,合計停在上一個看得懂的值。
      // 晚罰早賞:這一格已經是紅的、現在看得懂了 → 立刻消紅
      if (v != null && TR.bad[n]) markBad(null);
      paintTotal(); repaint(); paintBar(); bar.hidden = false;   // 打到一半看不懂時 edits 沒變,儲存列也不能消失
    });
    // 離開(或按 Enter)才驗:看不懂 → 紅框 + 一句原因;看得懂 → 回寫正規化後的值(「1500.5」→「1,500.50」)。Enter 只驗、不送出
    const settle = () => { let why = (txf ? trLotsError(inp.value) : trAmountError(inp.value)) || (twdRow && parse(inp.value) > (stored[n] || 0) ? "twd" : null);
      // 沒動過的舊設定是小數口數(0.1.12 以前存的 2.5):點名是舊設定,不讓人以為是自己剛打錯(稽核建議 2)
      if (txf && why === "bad" && TR.edits[n] == null && !Number.isInteger(Number(stored[n] || 0)) && inp.value === trFmt(stored[n] || 0)) why = "oldLots";
      markBad(why); if (!why) { inp.value = trFmt(parse(inp.value)); if (TR.raw) delete TR.raw[n]; } if (svBtn && svBtn.isConnected) svBtn.disabled = anyBad() || stale || cfgBad; else paintBar(); };
    inp.addEventListener("blur", settle); settles.push(settle);
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); settle(); } });
    row.appendChild(tgt); tb.appendChild(row); repaint();
    // 整張表重畫:打錯的那格留著原字與紅字(設計稽核 B7,同網頁);只有打到一半、還沒驗過的照舊不標紅
    if (TR.bad[n]) { delete TR.bad[n]; if (TR.raw && TR.raw[n] != null) settle(); }
  });
  tbl.appendChild(tb); scroll.appendChild(tbl); frag.appendChild(scroll);
  frag.appendChild(trEl("div", "pf-foot", t("tr.amountFoot")));   // 「金額」的意思(§2.1):有表格就出,放在合計列上面
  // 等回報時把表頭那句 hover 才看得到的說明放成表下常駐的一行(spec §2-3b):待回報的記號才有人解釋
  if (sentOn) frag.appendChild(trEl("div", "pf-foot", t("tr.cloud.pendTarget")));
  // 窄欄時列內的幣別收到這一行:表上只要有一格畫成錢就出(有錢的列,或口數列拿到報價、目標部位換成了台幣;R2-S1);
  // 全是口數列又沒有報價時沒有對象,不出
  // 帳戶幣未知(自訂交易所讀帳失敗)時同一個位置改講為什麼沒有幣別(spec-0.1.13 #3)
  if (names.some((n) => !trRowTxf(n)) && !trUnit()) frag.appendChild(trEl("div", "pf-foot", t("tr.ccyUnknown")));
  else if (names.some((n) => !trRowTxf(n)) || trTxfPrice() != null) frag.appendChild(trEl("div", "pf-foot unit-note", t("tr.unitNote", { c: moneyCcy() })));
  if (hidden.length) frag.appendChild(trEl("div", "pf-foot", t("tr.cloud.hidden", { n: hidden.length })));
  paintTotal(); frag.appendChild(total); frag.appendChild(lev);
  paintBar(); frag.appendChild(bar);
  return frag;
}
function trSaveAmounts(names, stored, opener) {
  const S = TR, cloud = S.env === "cloud";
  if (!TR.listLoaded || Object.keys(TR.bad).length) return;
  if (!stored || trStored() === null || trCfgUnread(trReport())) return;   // 讀不到金額設定:兩邊都不給存
  if (cloud && (!(S.st && S.st.alive) || trCfgUnread(trReport()))) return;   // 讀不到新狀態 / 設定不給存(儲存鈕已經 disabled;這裡是第二道)
  const sending = trSendAmounts(S.env, names, stored, TR.edits, trListNames()), removed = trRemoved(stored, sending);
  const eq = trShownEquity(TR.eqShown, TR.env, trEquity()), tt = trTotals(sending, eq, trRowMoney, trRowIsLot, trUnit());
  const money = (v, ccy) => { const dd = document.createElement("dd"), c = ccy || trUnit(); dd.textContent = trFmt(v); if (c) dd.appendChild(trEl("span", "ccy", c)); return dd; };
  const cfRow = (cls, label, dd) => { const r = trEl("div", "cf-row" + (cls ? " " + cls : "")); r.append(trEl("dt", "", label), dd); return r; };
  const extra = document.createDocumentFragment(), dl = trEl("dl", "cf-rows");
  // 口數列送出的是口數:列「N 口微台」,有報價才補「(≈ M TWD)」(同網頁 pfTxfConfirm / pfTxfConfirmNoQuote)
  const lots = (sp, v) => { const dd = document.createElement("dd"), m = trTxfRefMoney(sp, v, trTxfPrice()), q = { lots: trFmt(v), prod: t(sp.prod) };
    dd.textContent = m == null ? t(trLotsKey(v, "tr.txfConfirmNoQuote", "tr.txfConfirmNoQuote1"), q) : t(trLotsKey(v, "tr.txfConfirm", "tr.txfConfirm1"), { ...q, amt: trFmt(Math.round(m)) }); return dd; };
  /* #1:口數列太大時那一列下面多一句(不擋、確認鈕照常;沒改的舊列也檢查)。名目跟淨值比要同幣:帳戶幣不是 TWD 就退回看口數 */
  const bigWarn = (r, sp, v) => {
    const w = trTxfBigWarn(sp, v, trTxfPrice(), eq, trUnit());
    if (!w) return r;
    const q = { lots: trFmt(v), prod: t(sp.prod) }, dd = trEl("dd", "cf-warn"), mk = trEl("span", "fault-mark");
    mk.setAttribute("aria-hidden", "true");
    dd.append(mk, trEl("span", "", w.kind === "notional"
      ? t(trLotsKey(v, "tr.txfBigNotional", "tr.txfBigNotional1"), { ...q, amt: trFmt(Math.round(w.amt)), x: w.x.toFixed(2) })
      : t("tr.txfBigLots", q)));
    r.classList.add("has-warn"); r.appendChild(dd); return r; };
  const unknown = () => { const dd = document.createElement("dd"); dd.textContent = "—"; return dd; };
  Object.keys(sending).forEach((n) => { if (sending[n] > 0) { const sp = trRowTxf(n), r = cfRow("", trDisplay(n), sp ? lots(sp, sending[n]) : money(sending[n])); dl.appendChild(sp ? bigWarn(r, sp, sending[n]) : r); } });
  /* 原本 > 0、這次改成 0 的那幾支(設計稽核 M5):存下去它那一份會平倉,在金額列與合計之間講一次。移出組合那句照舊另外講 */
  const zeroed = Object.keys(sending).filter((n) => !(sending[n] > 0) && Number(stored[n]) > 0);
  let dlT = dl;
  if (zeroed.length) { extra.appendChild(dl); extra.appendChild(trEl("p", "cf-zeroed", t("tr.saveZeroed", { names: zeroed.map(trDisplay).join(LANG === "zh" ? "、" : ", ") }))); dlT = trEl("dl", "cf-rows"); }
  dlT.appendChild(cfRow("total", t("tr.total"), tt.total == null ? unknown() : money(tt.total, tt.ccy)));
  if (tt.mult != null) { const dd = document.createElement("dd"); dd.textContent = tt.mult.toFixed(2) + "x"; dlT.appendChild(cfRow("lev", t("tr.lev"), dd)); }
  extra.appendChild(dlT);
  if (!trUnit() && Object.keys(sending).some((n) => sending[n] > 0 && !trRowTxf(n))) extra.appendChild(trEl("p", "cf-note", t("tr.ccyUnknown")));
  if (removed.length) extra.appendChild(trEl("p", "cf-removed", t("tr.saveRemoved", { names: removed.map(trDisplay).join(LANG === "zh" ? "、" : ", ") })));
  const hid = cloud ? trHidden(names, stored, trListNames()) : [], badStored = cloud ? trBadStored(sending) : [];
  if (hid.length) extra.appendChild(trEl("p", "cf-note", t("tr.cloud.hidden", { n: hid.length })));
  if (badStored.length) extra.appendChild(trEl("p", "cf-block", t("tr.cloud.badStored", { names: badStored.map(trDisplay).join(LANG === "zh" ? "、" : ", ") })));
  // 被擋下的時候不會存:那句「儲存後…」是假話,不出。雲端不出 saveWarn(暫停中它是假話;正在下單時由最上面那句講得更準)
  // 重開沒停住(unconfirmed)也算在下單:舊對帳器不認重開閘門,下一輪就照新金額調倉(spec §1「在 C 裡對帳器一律當成活著」)
  const live = cloud && (trExecState(S.st) === "running" || trExecState(S.st) === "unconfirmed");
  const blocked = badStored.length > 0;   // 存不進去的時候不講「存了之後怎樣」(模擬帳戶超過 10 倍不再擋,#13)
  // 重開沒停住又已暫停:沒有啟動鈕,「按啟動下單之後」要先更新(audit S1)
  const idle = cloud && trRestartUnconfirmed(S.st && S.st.report) ? t("tr.cloud.saveIdleUnconfirmed") : t("tr.cloud.saveIdle");
  if (!blocked) extra.appendChild(trEl("p", "cf-note", !cloud ? t("tr.saveWarn") : live ? t("tr.cloud.saveLag") : idle + (LANG === "zh" ? "" : " ") + t("tr.cloud.saveLag")));
  /* 第 3 級(真錢 ≥ 10 倍,§1.2):多一列勾選,沒勾「儲存」停用。每次開框都是新的、沒勾的那一顆 */
  const ack = trLevLevel(tt.mult, trIsPaper()).level === 3 ? trEl("label", "cf-ack") : null;
  if (ack) {
    const cb = trEl("input", "ps-cb"), tx = trEl("span", "", t("tr.lev.ack", { p: trLevLevel(tt.mult, false).p }));
    cb.type = "checkbox"; tx.id = "cf-ack-t";
    cb.addEventListener("change", () => { $("del-ok").disabled = !cb.checked || blocked; });
    ack.append(cb, tx); extra.appendChild(ack);
  }
  let lead = null;
  if (live) {
    lead = trEl("div", "verdict is-calm"); const mk = trEl("span", "fault-mark"); mk.setAttribute("aria-hidden", "true");
    const tx = trEl("span", ""); tx.append(trEl("strong", "", t("tr.cloud.saveLive.h")), " " + t("tr.cloud.saveLive.b"));
    lead.append(mk, tx);
  }
  confirmBox(trCloudBox({
    title: t("tr.saveTitle"), mark: trIsPaper() ? t("tr.mode.paper") : null, lines: [], extra, lead, okDisabled: blocked || !!ack, ok: t("tr.save"), opener,
    onOk: async () => {
      const mine = () => TR === S && S.open && S.tab === "pos";   // 等回應的時候可能已經切到另一邊:那時不碰畫面
      // 框開著的時候報告可能變成 config: null(主機讀不到設定):底稿已經不可信,不送(開框前那一道擋不到這段)
      if (trWith(S, () => trStored() === null || trCfgUnread(trReport()))) { S.sig.pos = null; if (mine()) trPaintPos(); return; }
      S.save = "saving"; S.saveErr = null; S.sig.pos = null; if (mine()) trPaintPos();
      // 這一版沒有「下單方式」欄(一律市價),所以只送 amounts,不送 execution。
      // 雲端走 trSend:單飛 + request_id 沿用(沒送到 / 結果不明之後同一份內容重按 = 同一顆);本機照舊直送
      if (cloud) { const key = trAmountsKey(sending); if (S.reqFor.amounts !== key) delete S.reqIds.amounts; S.reqFor.amounts = key; }
      const res = cloud ? await trSend(S, "amounts", { amounts: sending }) : await S.api.tradeSend("amounts", { amounts: sending });
      clearTimeout(S.saveTimer);
      if (res && res.ok) { if (!S.just) S.just = { picked: {}, removed: {} }; envJustMark(S.just, stored, sending, Date.now()); if (!cloud) envPaintLocalDots(); else ENV.sig.side = null; }
      if (res && res.ok && ack) trackFeature("trade_lev_ack");
      if (res && res.ok && cloud) {
        // ack ok = 主機已經寫進設定檔,不是「已套用」:格子畫送出的值 + .pend,等報告對上(trPoll 裡的 trSentSettled)
        const rc = S.st && S.st.cloud;
        S.save = "sent"; S.sent = sending; S.sentAt = Date.now(); S.sentRep = rc && typeof rc.reported_at === "number" ? rc.reported_at : null; S.edits = {}; S.raw = {}; S.saveUnknownAt = 0;
        srSay(t("tr.cloud.pendAmounts"));
      } else if (res && res.ok) {
        S.save = "saved"; S.edits = {}; S.raw = {}; S.picked = null;   // 存進去了:stored 又是真相,picker 的選擇交回去(雲端在報告對上時清,trSentCheck)
        srSay(t("tr.saved"));
        S.saveTimer = setTimeout(() => { if (S.save === "saved") { S.save = null; S.sig.pos = null; if (mine()) trPaintPos(); } }, 4000);
      } else {
        // 沒送到 / 結果不明 / 被拒絕(拒絕原因是不可信輸入,包在本地化前導裡、走 textContent)
        S.save = "failed"; S.saveErr = trSendError(res, "save", S.env); srSay(S.saveErr);
        // 結果不明:同一份內容再按沿用同一顆 id;過了收斂窗口才算新的意圖(trPoll 到時清掉 reqIds.amounts)
        S.saveUnknownAt = cloud && trKindOf(res) === "unknown" ? Date.now() : 0;
      }
      S.sig.pos = null;
      try { S.st = await S.api.tradeStatus(); } catch (_) { }   // 下一輪輪詢會補
      if (mine()) { trPaintPos(); $("tr-tab-pos").focus(); }   // 儲存列可能收掉了:焦點不能掉到 BODY
      trPollSoon(1500);
    },
  }));
  if (ack) $("del-ok").setAttribute("aria-describedby", "cf-ack-t");   // 停用的「儲存」唸得到要先勾哪一句
}
/* 部位表同一個標的有兩支以上有金額的策略(ux-order-1-4-5 §2.2 方案 A):標的格放一顆「N 支策略」mini tag,
   點開下面一列拆解(每支策略的 金額 × 訊號 = 貢獻,最後一句是合計)。展開狀態只在記憶體(TR.netOpen),重畫保留、切走分頁清掉 */
function trNetRows(sym, cs, cell, tb, lot) {
  const id = "tr-net-" + sym.replace(/[^A-Za-z0-9]/g, "_"), open = TR.netOpen.has(sym);
  const b = trEl("button", "net-tag", t("tr.net.tag", { n: cs.length })), cv = trEl("span", "cv7");
  b.type = "button"; b.dataset.fk = "net:" + sym; cv.setAttribute("aria-hidden", "true"); b.appendChild(cv);
  b.setAttribute("aria-expanded", String(open)); b.setAttribute("aria-controls", id);
  cell.appendChild(b);
  const into = lot ? trLotsInto : trMoneyInto, x2 = (x) => (x < 0 ? "\u2212" : "") + Math.abs(x).toFixed(2);
  const amt = (v) => (lot ? trFmt(v) + " " + t(trLotsKey(Math.round(v), "tr.lotsUnit", "tr.lotUnit")) : trWithUnit(trFmt(v)));
  const row = document.createElement("tr"), td = trEl("td", "note"), box = trEl("div", "net-box");
  row.id = id; row.className = "net-row"; row.hidden = !open; td.colSpan = 4;
  cs.forEach((c) => {
    const line = trEl("div", "net-line"), v = trEl("span", "v mono " + (c.v > 0 ? "buy" : c.v < 0 ? "sell" : ""));
    into(v, c.v, true);
    line.append(trEl("span", "nm", trDisplay(c.name)), trEl("span", "f mono", trFmt(c.amount) + " × " + x2(c.x)), v);
    box.appendChild(line);
  });
  const ns = trNetSum(cs), base = sym.replace(/@spot$/i, "").replace(/(USDT|USDC|BUSD|FDUSD|USD)$/i, "") || sym;
  box.appendChild(trEl("div", "net-sum", ns.kind === "sumOffZero" ? t("tr.net.sumOffZero", { l: amt(ns.l), s: amt(ns.s), base })
    : t(ns.kind === "sumOff" ? "tr.net.sumOff" : "tr.net.sum", { t: lot ? trFmt(ns.t, true) + " " + t(trLotsKey(Math.round(ns.t), "tr.lotsUnit", "tr.lotUnit")) : trWithUnit(trFmt(ns.t, true)), l: amt(ns.l), s: amt(ns.s), m: amt(ns.m) })));
  td.appendChild(box); row.appendChild(td); tb.appendChild(row);
  b.addEventListener("click", () => {
    const on = b.getAttribute("aria-expanded") !== "true";
    b.setAttribute("aria-expanded", String(on)); row.hidden = !on;
    if (on) { TR.netOpen.add(sym); trackFeature("trade_net_open"); } else TR.netOpen.delete(sym);
  });
}
/* 把拒單原文({err} 填原文,agent 要的是代碼)填進本機的聊天輸入框、展開聊天欄、焦點放進去;**不送出**。
   雲端視角也填本機聊天框(本機 agent 經 blave 工具去查),絕不送進雲端。框裡原本有字就接在後面另起一行 */
function trErrAsk(sym, err) {
  const ta = $("ta"), text = t(TR.env === "cloud" ? "tr.err.askPromptCloud" : "tr.err.askPrompt", { sym, err: String(err).slice(0, 200) });
  if (typeof paneSt !== "undefined" && paneSt.chat.off) paneToggle("chat", false);
  ta.value = ta.value.trim() ? ta.value.replace(/\s+$/, "") + "\n" + text : text;
  autosize(); ta.focus();
  trackFeature("trade_err_ask");
}
function trLivePositions(r) {
  const out = {};
  trVenueIds(r).forEach((id) => {
    const e = trLiveEntry(r, id);
    if (!e || !e.ok || !e.positions) return;
    Object.keys(e.positions).forEach((s) => { const k = trCanonSym(s); out[k] = (out[k] || 0) + trSigned(e.positions[s]); });
  });
  return out;
}
function trPositions(r, stored, states) {
  const frag = document.createDocumentFragment();
  // tooltip 不提門檻數字:真正的門檻是每個標的在交易所的最小下單量(機器端 gates),前端那顆平坦的 10 只能拿來判斷、不能印出來
  frag.appendChild(trSec(trTipLabel("label", t("tr.exchPositions"), t("tr.threshold"))));
  const last = r.last_reconcile || null, gates = (last || {}).gates || {};
  const live = trLivePositions(r), acct = r.account && r.account.venues ? r.account : null;
  const target = trClientTargets(stored, states), actual = {};
  // 實際 = 兩個真值來源取較新的:下單那一輪對帳器會立刻重讀持倉寫進快照,帳戶讀取器要等自己的下一輪
  const lastMs = last ? trMs(last.ts) : null, acctMs = acct ? trMs(acct.read_at) : null;
  const reconNewer = last && (!acct || (lastMs || 0) > (acctMs || 0));
  if (acct && !reconNewer) {
    Object.keys(live).forEach((k) => { actual[k] = live[k]; });
    if (last && lastMs != null && Date.now() - lastMs < TR_STALE_MS) {
      Object.keys(last.actual || {}).forEach((k0) => { const k = trCanonKey(k0); if (/@spot$/.test(k)) actual[k] = trSigned(last.actual[k0]); });
    }
  } else if (last) Object.keys(last.actual || {}).forEach((k0) => { actual[trCanonKey(k0)] = trSigned(last.actual[k0]); });
  // 只管自己的部位時,「實際」是 Blave 的帳本(對帳器拿它比目標);帳本完全沒有的帳戶部位另列成中性的「不歸 Blave 管」,不上買賣色
  const own = r.self_ledger === true ? trOwnBook(last, actual, target) : null;
  const mine = own ? own.book : actual, unmanaged = own ? own.unmanaged : {};
  const syms = Object.keys(target);
  Object.keys(mine).forEach((s) => { if (syms.indexOf(s) < 0) syms.push(s); });
  Object.keys(unmanaged).forEach((s) => { if (syms.indexOf(s) < 0) syms.push(s); });
  syms.sort();
  if (!syms.length) {
    const dead = trExecState(TR.st) === "dead";
    frag.appendChild(trEl("div", "pf-state", dead && !last ? t("tr.posEmpty") : last ? t("tr.noPositions") : t("tr.noReconcile")));
    return frag;
  }
  const scroll = trEl("div", "pf-scroll"), tbl = trEl("table", "pf-tbl");
  tbl.appendChild(trHead([[t("tr.col.symbol"), ""], [t("tr.col.target"), "n"], [t("tr.col.actual"), "n"], [t("tr.col.diff"), "n"]]));
  const tb = document.createElement("tbody"), gated = [], pending = new Set(), contribs = trContribs(stored, states);
  let anyUnmanaged = false, anyNet = false;
  /* 口數列(群益台指期):目標、實際、差額都是口數,不是錢(同網頁 paintVenueLots)。對帳快照說是口數(trIsLot)就是;
     快照裡沒有這個標的(只在帳戶上、不歸 Blave 管的那一列)就看代號是不是 TXF / MXF / TMF(同網頁 TXF_SPECS[sym]) */
  const lotRow = (sym) => trIsLot(last, sym) || !!trTxfSpec(sym.replace(/@spot$/, ""));
  const cellInto = (lot) => (lot ? trLotsInto : trMoneyInto);
  // 口數列的標的欄寫商品名、不帶合約代碼(#14,同金額表);其他列照舊代號
  const symCell = (extra, sym) => { const sp = lotRow(sym) ? trTxfSpec(trCapitalCanon(sym)) : null;   // 商品名是漢字:不進等寬(.sym 是等寬)
    return trEl("td", (sp ? "sname" : "sym") + extra, sp ? t(sp.prod) : sym.replace(/@spot$/, "")); };
  // 不歸 Blave 管的那一列:標的欄也退一階(同一個標的的兩列一眼分得出主從);目標缺值用 na(同網頁);說明不只放 title(設計稽核 005 第 4 條)
  const unmanagedRow = (sym) => {
    anyUnmanaged = true;
    const row = document.createElement("tr"), sc = symCell(" hold", sym);
    sc.appendChild(trEl("span", "mkt-tag", /@spot$/.test(sym) ? t("tr.mkt.spot") : t("tr.mkt.swap")));
    const tc = trEl("td", "n na", "—"), ac = trEl("td", "n hold"), dc = trEl("td", "n hold unmanaged", t("tr.unmanaged"));
    cellInto(lotRow(sym))(ac, unmanaged[sym], true); dc.title = t("tr.unmanagedTip");
    row.append(sc, tc, ac, dc); tb.appendChild(row);
  };
  syms.forEach((sym) => {
    const managed = !own || sym in target || sym in mine;
    if (!managed) { unmanagedRow(sym); return; }
    const ts = target[sym] || 0, as = mine[sym] || 0, d = ts - as;
    const row = document.createElement("tr");
    const sc = symCell("", sym);
    sc.appendChild(trEl("span", "mkt-tag", /@spot$/.test(sym) ? t("tr.mkt.spot") : t("tr.mkt.swap")));
    const tc = trEl("td", "n"), ac = trEl("td", "n");
    // 上色要對齊真正觸發下單的門檻:平台 10,或該標的在交易所的最小下單量(機器端回報的 gates)
    // 口數列沒有門檻:差 1 口就送單,不可以拿平台那顆 10(USD)去比,不然差額會被畫成「不會動」的灰色
    const lot = lotRow(sym), into = cellInto(lot);
    into(tc, ts, true); into(ac, as, true);
    const gs = trGateSide(gates[sym], ts, as), acts = lot ? Math.round(Math.abs(d)) > 0 : Math.abs(d) >= (gs ? gs.usd : 10);
    const held = !acts && Math.round(Math.abs(d)) > 0;
    const dc = trEl("td", "n " + (acts ? (d > 0 ? "buy" : "sell") : "hold"));   // 0 是有意義的值(對上了),不用佔位符那階灰
    into(dc, d, true);
    // 這一列還欠一張單 = 它會觸發下單(acts 已經把口數列算對了):表底那行失敗紅字只在它的標的還欠著時才出(見 trLiveOrderErr)
    if (acts) pending.add(sym);
    row.append(sc, tc, ac, dc); tb.appendChild(row);
    if (contribs[sym] && contribs[sym].length >= 2) { anyNet = true; trNetRows(sym, contribs[sym], sc, tb, lot); }
    if (own && sym in unmanaged) unmanagedRow(sym);   // 同一個標的:Blave 這一份 0,帳戶上的整份是用戶的
    if (gs && held && !((gs.reduce || gs.close) && gs.usd <= 10)) gated.push({ sym, gs });   // 平坦的 10 是每一列共通的門檻,不另外解釋
  });
  tbl.appendChild(tb); scroll.appendChild(tbl); frag.appendChild(scroll);
  if (anyUnmanaged) frag.appendChild(trEl("div", "pf-foot", t("tr.unmanagedTip")));
  if (anyNet) frag.appendChild(trEl("div", "pf-foot", t("tr.net.foot")));   // 鍵盤與讀屏拿不到 td 的 title:同一句寫在表底
  if (gated.length) {
    const short = (k) => { const f = k.replace(/@spot$/i, ""), b = f.replace(/(USDT|USDC|BUSD|FDUSD|USD)$/i, ""); return b && b !== f ? b : f; };
    // 帶內的列先講「在容忍帶內」:它的 usd 是帶不是半口,套「超出不到半口」會講錯
    frag.appendChild(trEl("div", "pf-foot", t("tr.gateFootLead") + gated.map((g) =>
      g.gs.band ? t("tr.gateFootBand", { sym: short(g.sym), m: trFmt(g.gs.usd) })
        : g.gs.reduce ? t("tr.gateFootReduce", { sym: short(g.sym) }) : t("tr.gateFootEntry", { sym: short(g.sym), m: trFmt(g.gs.usd) })).join(" · ")));
  }
  // 下單失敗不能靜悄悄:掛在表底(腳注,同雲端)。但只掛**還沒被解決**的那一筆——過期的那些已經跟表上的數字對不起來了。
  // 哪一筆要掛不看執行狀態;執行狀態只決定音量(spec 丙案):對帳器在跑 = 這張單會再送、會再失敗,紅字催人;
  // 沒在跑(暫停或掛掉不分)= 同一筆降成灰字「上次下單失敗」留原因與時間,不催人——頁頭那句仍是唯一的狀態句,表裡只放脈絡。
  // 狀態跟頁頭同一個來源(envHeadState):雲端讀不到新狀態時兩處才不會一紅一灰互相打架
  const le = trLiveOrderErr(r.order_errors, pending);
  if (le) {
    const sym = String(le.symbol || "—").replace(/@spot$/, ""), err = String(le.error || le.message || "");
    const hs = envHeadState(TR.st, Date.now());   // 重開沒停住:舊對帳器還在重送、還在失敗,是現在的事,不降成「上次」
    // 「請 agent 查原因」(order-copy #14 §4.4):只把一句話填進本機聊天框,不送出;紅字與降灰兩種都放,總覽事件列不放
    const ask = () => { const b = trEl("button", "btn-quiet tr-err-ask", t("tr.err.ask")); b.type = "button"; b.dataset.fk = "errask"; b.addEventListener("click", () => trErrAsk(sym, err)); return b; };
    if (trErrLoud(le, hs, TR.startAt, r.last_reconcile)) { const foot = trEl("div", "pf-foot err", trOrderErrText(sym, err)); foot.append(" ", ask()); frag.appendChild(foot); }
    else {
      const foot = trEl("div", "pf-foot past"), stamp = trErrStamp(le.ts, Date.now());
      if (stamp) foot.appendChild(trEl("span", "ts mono", stamp));
      // 認得的原因跟事件列同一句在地化(不出英文原文);認不得才照舊帶原文(不可信輸入:截長、走文字節點)
      foot.append(trOrderErrParse(err) ? t("tr.orderFailedLastWhy", { why: trOrderErrText(sym, err) }) : t("tr.orderFailedLast", { sym, err: err.slice(0, 200) }), " ", ask());
      frag.appendChild(foot);
    }
  }
  return frag;
}

/* ── 資產 / 交易歷史 / 設定 ───────────────────────────────────── */
function trPaintAssets() {
  const box = $("tr-assets"), r = trReport() || {};
  const ids = trVenueIds(r);
  if (!trShould("assets", box, [ids, r.account, trUnit()])) return;
  box.textContent = "";
  box.appendChild(trSec(trEl("span", "label", t("tr.account"))));
  ids.forEach((id) => {
    const e = trLiveEntry(r, id), row = trEl("div", "pf-acct");
    row.appendChild(trEl("span", "who", trVenueLabel(id, true)));
    const amt = trEl("span", "amt"); amt.appendChild(trEl("span", "lbl", t("tr.equity")));
    const v = e && e.ok ? trFmt2(trLiveTotal(e)) : null;
    amt.appendChild(document.createTextNode(v == null ? "—" : v));
    if (v != null && trUnit()) amt.appendChild(trEl("span", "ccy", trUnit()));
    row.appendChild(amt); box.appendChild(row);
    // 錢包分佈(同雲端 buildAccountBlock):這份清單就是「錢在哪」的答案,常駐展開
    const wallets = e && e.ok ? trWalletRows(e) : [];
    if (!wallets.length) return;
    box.appendChild(trEl("div", "pf-wallets-cap", t("tr.acctBreakdown")));
    const list = trEl("div", "pf-wallets");
    wallets.forEach((w) => {
      const wr = trEl("div", "pf-wallet-row"), wa = trEl("span", "w-amt", trFmt2(w.amount));
      if (trUnit()) wa.appendChild(trEl("span", "ccy", trUnit()));
      wr.append(trEl("span", "w-name", trAcctLabel(w.key)), wa); list.appendChild(wr);
    });
    box.appendChild(list);
  });
  // 持幣表(同雲端 appendHoldings):估不出價值的幣(下架幣之類)畫「—」但照列,藏起來 = 錢憑空消失
  const holds = trHoldingRows(r, ids);
  if (!holds.length) return;
  box.appendChild(trSec(trEl("span", "label", t("tr.holdings"))));
  const scroll = trEl("div", "pf-scroll"), tbl = trEl("table", "pf-tbl");
  tbl.appendChild(trHead([[t("tr.col.asset"), ""], [t("tr.col.qty"), "n"], [t("tr.col.value"), "n"]]));
  const tb = document.createElement("tbody");
  holds.forEach((h) => {
    const tr = document.createElement("tr"), c = trEl("td", "sym", h.asset);
    const tag = [h.venue ? trVenueLabel(h.venue, true) : "", h.wallet ? trAcctLabel(h.wallet) : ""].filter(Boolean).join(" ");
    if (tag) c.appendChild(trEl("span", "mkt-tag", tag));
    // 數量不再接幣名:第一欄就是那個幣(價值欄的 USDT 是換算單位,留著)
    const n = Number(h.amount), qc = trEl("td", "n", isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 8 }) : "—");
    const val = trFmt2(h.usdt_value), vc = trEl("td", "n", val == null ? "—" : val);
    if (val != null) vc.appendChild(trEl("span", "ccy", "USDT"));   // usdt_value 本身就是 USDT 計價
    tr.append(c, qc, vc); tb.appendChild(tr);
  });
  tbl.appendChild(tb); scroll.appendChild(tbl); box.appendChild(scroll);
}
// 錢包 key → 顯示名(同雲端 acctLabel);沒對到的 key 原樣顯示,交易所新加的錢包不能因為沒翻譯就隱形
function trAcctLabel(k) {
  const L = {
    trading: t("tr.acct.trading"), unified: t("tr.acct.trading"), swap: t("tr.acct.swap"), futures: t("tr.acct.swap"),
    std_futures: t("tr.acct.stdFut"), coinm_perp: t("tr.acct.coinm"), copy_trading: t("tr.acct.copy"),
    spot: t("tr.acct.spot"), fund: t("tr.acct.fund"), funding: t("tr.acct.fund"),
    cross_margin: t("tr.acct.crossMargin"), isolated_margin: t("tr.acct.isoMargin"),
    earn: t("tr.acct.earn"), options: t("tr.acct.options"), trading_bots: t("tr.acct.bots"),
  };
  return Object.prototype.hasOwnProperty.call(L, k) ? L[k] : String(k);
}
function trPaintHist() {
  const box = $("tr-hist"), r = trReport() || {};
  const orders = (Array.isArray(r.orders) ? r.orders : []).slice().reverse();
  if (!trShould("hist", box, [orders, trUnit(), TR.list.map((x) => x.displayName)])) return;
  box.textContent = "";
  box.appendChild(trSec(trEl("span", "label", t("tr.recentOrders"))));
  if (!orders.length) { box.appendChild(trEl("div", "pf-state", t("tr.noOrders"))); return; }
  const log = trEl("div", "pf-log");
  orders.forEach((o) => {
    if (!o || typeof o !== "object") return;
    const row = trEl("div", "pf-log-row");
    row.appendChild(trEl("span", "ts mono", trStamp(o.ts)));
    const sell = o.action === "SELL";
    const act = trEl("span", "act " + (sell ? "sell" : "buy"), sell ? t("tr.sell") : t("tr.buy"));
    // 由哪些策略觸發:除錯用的補充,收進 title(這一列在橫捲容器裡,氣泡會被裁掉)
    const who = (Array.isArray(o.contributors) ? o.contributors : []).map((c) => (typeof c === "string" ? c : c && c.strategy)).filter(Boolean);
    if (who.length) act.title = t("tr.contributors", { names: who.map(trDisplay).join(LANG === "zh" ? "、" : ", ") });
    row.appendChild(act);
    const sym = String(o.symbol || ""), ss = trEl("span", "");
    if (!(trOrderLots(o) && trTxfSymInto(ss, trOrderContract(o)))) { ss.className = "mono"; ss.textContent = sym.replace(/@spot$/, ""); }
    ss.appendChild(trEl("span", "mkt-tag", /@spot$/.test(sym) ? t("tr.mkt.spot") : t("tr.mkt.swap")));
    row.appendChild(ss);
    // 金額 = 交易所實際成交(Σ 數量×成交價);任一腿缺成交資料就整筆退回委託目標(部分和比意圖值更誤導)
    const legs = Array.isArray(o.legs) ? o.legs : [];
    let fill = 0;
    const hasFill = legs.length > 0 && legs.every((l) => {
      const ok = l && typeof l.executed_qty === "number" && l.executed_qty > 0 && typeof l.fill_price === "number" && l.fill_price > 0;
      if (ok) fill += l.executed_qty * l.fill_price; return ok;
    });
    const target = Math.abs(typeof o.signed_diff === "number" ? o.signed_diff : NaN);
    const amt = trEl("span", "amt mono");
    if (trOrderLots(o)) {
      // 口數單(同網頁):欄位寫「N 口」(群益整條鏈的原生單位);TWD 名目市值是推導值,收進 title,算不出就不掛
      const lots = trFmt(target), cv = trOrderCv(o);
      amt.textContent = lots == null ? "—" : lots;
      if (lots != null) {
        amt.appendChild(trEl("span", "ccy lots", t(trLotsKey(target, "tr.lotsUnit", "tr.lotUnit"))));
        if (hasFill && cv) amt.title = t("tr.orderNotional", { amount: trFmt(fill * cv) + " TWD" });
      }
    } else {
      const val = trFmt(hasFill ? fill : target);
      amt.textContent = val == null ? "—" : val;
      if (val != null) {
        if (trUnit()) amt.appendChild(trEl("span", "ccy", trUnit()));
        if (hasFill && target > 0 && trFmt(target) !== val) amt.title = t("tr.orderTarget", { amount: trWithUnit(trFmt(target)) });
      }
    }
    row.appendChild(amt);
    const px = legs.map((l) => trFmtPrice(l && l.fill_price)).filter(Boolean);
    row.appendChild(trEl("span", "px mono", px.length ? "@ " + px.join(" → ") : ""));
    row.appendChild(trEl("span", "ex mono", trVenueLabel(String(o.exchange || ""), true)));
    log.appendChild(row);
  });
  box.appendChild(log);
  // 窄欄(<520)時列內的幣別收到這一行;口數單的「口」留在列內,全是口數單時這一行沒有對象,不出
  if (orders.some((o) => o && typeof o === "object" && !trOrderLots(o))) box.appendChild(trUnit() ? trEl("div", "pf-foot unit-note", t("tr.unitNote", { c: trUnit() })) : trEl("div", "pf-foot", t("tr.ccyUnknown")));
}
function trPaintSet() {
  const box = $("tr-set"), r = trReport(), id = trVenueId(), e = id ? trLiveEntry(r, id) : null;
  const ro = TR.env === "cloud";
  const bn = !ro && id === BINANCE ? CXF.bn : null;   // Binance 金鑰重查的結果(主行程 binance_link 的 state;只有這台電腦)
  // 雲端:按過重新測試 / 解除之後,那一列灰字「已送出,等回報」直到報告跟上(帳戶讀取時間比送出新 / 這一家消失)
  const pend = ro && TR.cxPend ? TR.cxPend : null;
  if (!trShould("set", box, [id, TR.unbinding, ro, TR.cx.retest, TR.cx.err, e && [e.ok, e.error], bn && [bn.verdict, bn.last && [bn.last.code, bn.last.detail]], pend && pend.what, ro && trCapWip(r, id), !ro && id === "president" && [presWip(r), trPresStopped(r, id)]])) return;
  const hadFocus = box.contains(document.activeElement) ? document.activeElement.id : null;
  box.textContent = "";
  box.appendChild(trSec(trEl("span", "label", t("tr.account"))));
  // 一列:交易所名 + 錢記號 + 連線狀態;右邊兩顆動作。雲端第一刀唯讀:兩顆都不能按(說明在標題下那一行)
  const row = trEl("div", "cx-row");
  row.appendChild(trEl("span", "n", trVenueLabel(id, true)));
  if (id && id !== PAPER) row.appendChild(trEl("span", "mode real", t("tr.mode.real")));   // 模擬以外都是真錢
  // 三態:讀得到帳戶 = 綠點;讀過而失敗 = 紅記號;還沒讀過(剛綁上那幾秒)= 圓環 + 「串接中…」(.cx-wait 那組,spec-desktop-006 §1.3 D)
  // 群益在雲端開通中(spec w-row-pending):讀帳失敗是預期的,不畫紅;靜態實心點 +「開通中」+「繼續」回到清單
  // 統一在這台電腦開通中(d-row-pending)同一個長相:讀帳失敗是預期的(worker 還沒寫第一份快照)
  const presW = !ro && id === "president" && presWip(r);
  // 開通過又停掉的(稽核 integ-0118 B-1):畫紅記號「串接失敗」,但「繼續」照給——「確認登入」只在開通框裡
  const presIn = presW || (!ro && trPresStopped(r, id));
  const capWip = (ro && trCapWip(r, id)) || presW;
  const failed = !capWip && ((!!e && !e.ok) || !!(bn && bn.verdict)), st = trEl("span", "cn-st" + (capWip ? " cx-wait" : failed ? "" : e ? " on" : " cx-wait"));
  if (capWip) st.appendChild(trEl("span", "cap-dot"));
  else if (e && e.ok && !failed) st.appendChild(trEl("i", "dot"));
  else if (failed) { const m = trEl("span", "fault-mark"); m.setAttribute("aria-hidden", "true"); st.appendChild(m); }
  else { const sp = trEl("span", "spin16"); sp.setAttribute("aria-hidden", "true"); st.appendChild(sp); }
  st.appendChild(trEl("span", "", capWip ? t("cap.pending") : failed ? t("cx.failShort") : e ? t("cx.connected") : t("cx.connecting")));
  row.appendChild(st);
  const acts = trEl("span", "pf-acts");
  if (capWip && !presW) { const go = trEl("button", "pf-act main-act", t("cap.continue")); go.type = "button"; go.id = "cap-continue"; go.addEventListener("click", () => cxModalOpen(go, CAPITAL)); acts.appendChild(go); }
  // 統一:「繼續」回到清單當下那一步(開通中、或開通過又停掉 → 那一類登入失敗的列與「確認登入」)
  if (presIn) { const go = trEl("button", "pf-act main-act", t("cap.continue")); go.type = "button"; go.id = "pres-continue"; go.addEventListener("click", () => cxModalOpen(go, "president")); acts.appendChild(go); }
  // 兩個視角都按得動(S5):雲端的重新測試 / 解除走雲端指令,吃當下那一袋。
  // 「重新測試」在讀帳失敗 / 金鑰重查出事(紅記號 + 串接失敗)時畫,Binance 重查的灰記號(沒設白名單、現貨 / 合約沒開)也畫——
  // 它是 24 小時自動重查之前唯一能叫 binanceRecheck 的入口(Wei 0.0.6)。乾淨的已連接與串接中都沒有東西要重試;鈕消失時焦點由最後一行交給設定分頁
  const bnD = (bn && bn.last && bn.last.ok && bn.last.detail) || {};
  const bnNote = !!(bn && bn.last && bn.last.ok) && (bn.last.code === "NO_IP_RESTRICT" || bnD.futures === false || bnD.spot === false);
  if (failed || bnNote) {
    const rt = trEl("button", "pf-act", TR.cx.retest ? t("cx.retesting") : t("cx.retest")); rt.type = "button"; rt.id = "cx-retest";
    rt.disabled = TR.cx.retest || !id; rt.addEventListener("click", cxRetest);
    acts.appendChild(rt);
  }
  const ub = trEl("button", "pf-act", TR.unbinding ? t("tr.unbinding") : t("tr.unbind")); ub.type = "button"; ub.id = "tr-unbind";
  ub.disabled = !!TR.unbinding || !id || !trEnvNames(id).length; ub.addEventListener("click", () => trUnbind(ub));
  acts.appendChild(ub); row.appendChild(acts); box.appendChild(row);
  if (pend) box.appendChild(trEl("p", "pf-note", t("tr.cloud.pendRow")));
  // 失敗原因放在這一列下面(紅記號 + 次要字),不佔用標題區那個唯一的紅字槽
  const errLine = (text) => { const p = trEl("p", "plan-err"), m = trEl("span", "fault-mark"); m.setAttribute("aria-hidden", "true"); p.append(m, trEl("span", "", text)); return p; };
  if (bn && bn.verdict) {   // 重查出事(spec §5.4):講哪一種+下一步;IP 換了就把新 IP 連同複製鈕給他
    // 照 reason 講;同一個 reason 底下再照出事那一次的代號講對的原因(存著的金鑰壞了 ≠ 被 Binance 拒絕;合約被關 ≠ 交易權限全關)
    const v = bn.verdict, code = v.code || (bn.last && bn.last.code);
    const text = v.reason === "IP_CHANGED" ? t("cx.re.ipChanged")
      : v.reason === "TRADING_LOST" ? t("cx.re.tradingOff")
      : code === "BAD_SECRET" || code === "BAD_KEY_FORMAT" ? t("cx.re.badKey") : t("cx.re.rejected");
    box.appendChild(errLine(text));
    if (v.reason === "IP_CHANGED" && v.ip) { const w = trEl("div", "cx-re-ip"); w.appendChild(cxIpChip(v.ip)); box.appendChild(w); }   // IP 放句子下面(句子不再夾 {ip}):拿不到 IP 就只有句子
  } else if (bn && bn.last && bn.last.ok) {   // 連得上:沒設白名單、現貨或合約其中一個沒開,如實講(灰記號,不是錯)
    const calm = (text) => { const p = errLine(text); p.classList.add("is-calm"); box.appendChild(p); }, d = bn.last.detail || {};
    if (bn.last.code === "NO_IP_RESTRICT") calm(t("cx.chk.noWhitelist"));
    if (d.futures === false) calm(t("cx.note.noFutures")); else if (d.spot === false) calm(t("cx.note.noSpot"));
  }
  if (e && !e.ok && !capWip) {
    const m = /^([a-z_]+):\s*(.*)$/i.exec(String(e.error || ""));
    // 帳戶模式不支援合約(OKX):讀帳戶就會擋,講怎麼改,不出原文
    if (trErrToken(e.error) === "okx_account_mode") box.appendChild(errLine(t("cx.err.okxMode")));
    else box.appendChild(errLine(t("cx.fail", { id: trVenueLabel(id, true), stage: m ? m[1] : "—", msg: (m ? m[2] : String(e.error || "")).slice(0, 200) })));
  }
  if (TR.cx.err) box.appendChild(errLine(TR.cx.err));
  box.appendChild(trEl("div", "pf-foot", id === PAPER ? t("tr.unbindDescPaper") : ro ? t("tr.cloud.unbindDesc") : t("tr.unbindDesc")));   // 模擬帳戶沒有金鑰可移除
  // 規格 §6:網頁限定的事各自在自己的位置講一行(一句事實 + 一顆「前往工作頁」),不集中成整頁級的免責聲明。
  // 寫法紅線:講「這件事在網頁的雲端工作頁做」,不講「app 做不到」
  if (ro) {
    const p = trEl("div", "pf-foot"), go = trEl("button", "btn-quiet", t("plan.openWs")); go.type = "button";
    go.addEventListener("click", () => window.blave.openExternal(planWebUrl()));
    p.append(t("tr.cloud.onlyWebExec") + " ", go); box.appendChild(p);
  }
  const back = hadFocus && $(hadFocus); if (back && !back.disabled) back.focus(); else if (hadFocus) $("tr-tab-set").focus();
}
// 解除綁定要移掉的環境變數名。宿主(daemon.js argsOk 的 REMOVABLE)只放行這一版認得的 key,多送一個就整包 BAD_ARGS。
function trEnvNames(id) {
  if (id === PAPER) return ["PAPER_API_KEY", "PAPER_SECRET_KEY", "PAPER_BOUND_TS"];
  if (id === CAPITAL) return ["capital_api_key", "capital_password"];   // 只有雲端解得了(capUnbindSend;名字由主行程決定)
  if (id === "president") return ["president_account", "president_password", "president_ca_password", "president_ca_path", "president_url", "president_test_url"];   // = daemon.js PRESIDENT_ENV
  const v = Object.prototype.hasOwnProperty.call(CX_VENUES, id) ? CX_VENUES[id] : null;
  return v ? [v.env + "_API_KEY", v.env + "_SECRET_KEY"].concat(v.pass ? [v.env + "_PASSPHRASE"] : []) : [];
}
function trUnbind(opener) {
  const S = TR, id = trVenueId(), cloud = S.env === "cloud"; if (!id) return;
  confirmBox(trCloudBox({
    title: t("tr.unbind"), mark: id === PAPER ? t("tr.mode.paper") : null, lines: [id === PAPER ? t("tr.unbindWarnPaper") : cloud ? t("tr.cloud.unbindWarn") : t("tr.unbindWarn")], ok: t("tr.unbind"), opener,
    onOk: async () => {
      const mine = () => TR === S && S.open;
      S.unbinding = true; if (mine()) trPaintSet();
      // 統一(這台電腦):機器上的五行與憑證先拿掉,成功了主行程才丟掉它存的帳密(presidentUnbind)
      const res = cloud && id === CAPITAL ? await capUnbindSend() : cloud ? await trSend(S, "credentials_remove", { env: trEnvNames(id) })
        : id === "president" ? await window.blave.presidentUnbind() : await S.api.tradeSend("credentials_remove", { env: trEnvNames(id) });
      S.unbinding = false; S.sig = {};
      // 失敗文案帶 S.env:跨 await 之後 TR 可能已經是另一邊,不帶會拿本機那組「這台電腦」的句子
      if (!res || !res.ok) { trAlert(trSendError(res, "unbind", S.env), "noaccount", S); if (mine()) { trPaintSet(); $("tr-tab-set").focus(); } trPollSoon(1500); return; }
      trAlert("", null, S); S.edits = {};
      if (cloud) { S.cxPend = { what: "unbind", at: Date.now() }; if (mine()) { trPaintSet(); $("tr-tab-set").focus(); } trPollSoon(1500); return; }   // 雲端要等回報:那一列灰字
      if (mine()) $("tr-nav").focus();             // 這個分頁馬上會整個換成 onboard:焦點先停在入口
      trPollSoon(300);
    },
  }));
}

/* ── 總覽:PnL 條 + 權益曲線 + 事件時間軸 ─────────────────────────
   兩邊都是同一組兩支(權益曲線 + 當日損益、事件流),TR.env 只決定來源(envApi):
   tradeEquity:這台電腦 = 宿主(daemon.js)在 app 開著時每個整點記一筆(依「這次綁定」切段);雲端 = 平台每小時的快照
   (主行程 cloudOverview → /cloud/overview,同網頁工作頁 GET /openclaw/agent/overview 那一份);
   tradeEvents:這台電腦 = 宿主記的暫停/恢復/連接/解除,雲端 = 平台的事件流(主行程 cloudEvents → /cloud/events)。
   兩邊都沒有「未實現損益」這個數字,所以 PnL 條只有兩格(設計師裁定 8:MVP 只少不改;數字有了再放回第三格)。
   tradePerformance:雲端 = 組合績效六格 + 平台算好的累積損益曲線(cloudPerformance → /cloud/performance,同網頁 GET /openclaw/agent/performance);
   這台電腦沒有這一份(null,不畫那一條)。累積損益優先用平台那條(異動點的跳變已剔除),沒有才用本機推算(最後一段減首點)。 */
const TR_RANGES = [["1D", 1], ["1W", 7], ["1M", 30], [null, 90]];
async function trLoadCurve() {
  const S = TR, days = S.ov.days;
  // 計價幣釘住帳戶回報的那一個(雲端 api 會折成用戶在網頁選的幣;不釘的話曲線跟上面的總權益單位對不起來)
  // curveErr = 這一輪讀不到(不是「還沒有紀錄」):畫面要說得出是哪一種
  try { const cv = await S.api.tradeEquity({ days, currency: trWith(S, trUnit) }); if (S.ov.days !== days) return;   // 等的期間切了區間:這份是舊區間的
    S.ov.curve = cv && cv.code === "OK" ? cv : { curve: [] }; S.ov.curveErr = !cv || cv.code !== "OK"; }
  catch (_) { if (S.ov.days !== days) return; S.ov.curve = { curve: [] }; S.ov.curveErr = true; }
  // perf null + perfErr false = 這一邊沒有這一份(這台電腦);perfErr = 這一輪讀不到
  try { const pf = await S.api.tradePerformance({ days, currency: trWith(S, trUnit) }); if (S.ov.days !== days) return;
    S.ov.perf = pf && pf.code === "OK" ? pf : null; S.ov.perfErr = !!pf && pf.code !== "OK"; }
  catch (_) { if (S.ov.days !== days) return; S.ov.perf = null; S.ov.perfErr = true; }
  // uiErr = 這一輪讀不到(不是「沒有事件」):畫面要說得出是哪一種
  try { const ev = await S.api.tradeEvents({ days }); if (S.ov.days !== days) return; S.ov.ui = ev && Array.isArray(ev.events) ? ev.events : []; S.ov.uiErr = !ev || ev.code !== "OK"; }
  catch (_) { if (S.ov.days !== days) return; S.ov.ui = []; S.ov.uiErr = true; }
  S.sig.over = null; if (TR === S && S.open && S.tab === "over") trPaintOver();
}
function trCurvePoints() {
  const raw = TR.ov.curve && Array.isArray(TR.ov.curve.curve) ? TR.ov.curve.curve : [];
  const pts = raw.filter((p) => p && typeof p.ts === "number" && isFinite(p.ts) && typeof p.equity === "number" && isFinite(p.equity))
    .map((p) => ({ t: p.ts, v: p.equity, b: p.basis || "equity" })).sort((a, b) => a.t - b.t);
  const from = Date.now() / 1000 - TR.ov.days * 86400;
  return pts.filter((p) => p.t >= from);
}
function trPaintOver() {
  const box = $("tr-over"), r = trReport() || {};
  if (!TR.ov.curve || (TR.ov.at || 0) < Date.now() - 60000) { TR.ov.at = Date.now(); trLoadCurve(); }
  const data = [TR.env, trEquity(), trUnit(), TR.ov.mode, TR.ov.days, TR.ov.curve, TR.ov.curveErr, TR.ov.perf, TR.ov.perfErr, TR.ov.ui, TR.ov.uiErr, r.orders, r.halt, r.events, r.order_errors];
  if (!trShould("over", box, data)) return;
  box.textContent = "";
  box.appendChild(trOvStats());
  box.appendChild(trOvPerf());   // 績效條:PnL 條與曲線之間(同網頁 mockup 序);沒有這一份就是空的
  box.appendChild(trOvCurve());
  box.appendChild(trOvEvents(r));
  if (trIsPaper()) box.appendChild(trEl("div", "pf-foot", t("cx.perfNote")));
}
function trStatCell(label, value, cls, sub, tip) {
  const c = trEl("div", "stat" + (cls.hero ? " hero" : " wide"));
  const sl = trEl("div", "sl" + (tip ? " sl-tip" : ""));
  if (tip) sl.appendChild(trTipLabel("", label, tip)); else sl.textContent = label;
  c.appendChild(sl);
  // 四捨五入後是 0 就寫「0.00」、不帶號不上色(模擬帳戶的手續費很容易出現紅色的「-0.00」)
  const zero = typeof value === "number" && Math.round(value * 100) === 0;
  const s = cls.signed ? trFmt2(zero ? 0 : value, !zero) : trFmt2(value);
  const sv = trEl("div", "sv" + (s == null ? " na" : cls.signed && !zero ? (value > 0 ? " pos" : value < 0 ? " neg" : "") : ""), s == null ? "—" : s);
  if (s != null && trUnit()) sv.appendChild(trEl("span", "unit", trUnit()));
  c.appendChild(sv);
  if (sub) c.appendChild(trEl("div", "sub mono", sub));
  return c;
}
// 百分比:四捨五入後是 0 就寫「0.00%」,不帶正負號(不出現「-0.00%」)
function trPct(p) { const r = Math.round(p * 100) / 100; return (r > 0 ? "+" : r < 0 ? "-" : "") + Math.abs(r).toFixed(2) + "%"; }
function trOvStats() {
  const grid = trEl("div", "bt-stats ov-stats"), cv = TR.ov.curve || {};
  grid.appendChild(trStatCell(t("tr.ov.equity"), trEquity(), { hero: true }, null, t("tr.ov.equityTip")));
  // today = null:沒有夠新的基準(app 好幾天沒開;雲端今天不到兩筆快照、或跨過資金異動)→「—」,不拿好幾天前的點冒充「當日」;讀不到也是「—」,不是 0
  const today = cv.today && typeof cv.today === "object" ? cv.today : {};
  const dp = typeof today.pnl === "number" && isFinite(today.pnl) ? today.pnl : null;
  const pct = dp != null && typeof today.start_equity === "number" && today.start_equity > 0 ? (dp / today.start_equity) * 100 : null;
  grid.appendChild(trStatCell(t("tr.ov.day"), dp, { signed: true }, pct == null ? null : trPct(pct)));
  return grid;
}
/* 組合績效(照網頁 buildOvPerf):六格、表面只有指標名 + 數字,定義 / 口徑 / gating 全在 label 的 tooltip。
   status 由平台判(ok = 顯示數字;estimate = 有數字但樣本不足,印真數字、muted;accumulating = 「資料累積中」),這裡不自算樣本門檻。
   accumulating 帶 reason 時改口講「為什麼還沒有數字」({d} 代入該指標的定義句);estimate 的 reason 另一張表(同一個碼兩種意思)。
   reason 是平台給的字串:只認表上有的(hasOwnProperty,"constructor" 這種撈到原型的不算),不認得就退回概括那句。 */
const TR_PERF_REASON = { insufficient_samples: "tr.ov.perf.reason.insufficientSamples", flow_merged: "tr.ov.perf.reason.flowMerged", zero_volatility: "tr.ov.perf.reason.zeroVolatility" };
const TR_PERF_VOL_EST = { insufficient_samples: "tr.ov.perf.volEst.insufficientSamples", flow_merged: "tr.ov.perf.volEst.flowMerged" };
const trPerfReason = (table, r) => (typeof r === "string" && Object.prototype.hasOwnProperty.call(table, r) ? t(table[r]) : null);
// 值格式器(同網頁:正號 +、負號 U+2212、兩位小數);回 { text, cls }
function trPerfFmt(kind, v) {
  const pct = (x) => Math.abs(x * 100).toFixed(2) + "%";
  if (kind === "pctSigned") return { text: (v > 0 ? "+" : v < 0 ? "−" : "") + pct(v), cls: v > 0 ? "pos" : v < 0 ? "neg" : "" };
  if (kind === "pct") return { text: pct(v), cls: "" };
  if (kind === "drawdown") return v > 0 ? { text: "−" + pct(v), cls: "neg" } : { text: pct(v), cls: "" };   // 回撤是正比例,顯示為負;0 = 沒回撤(中性)
  if (kind === "count") return { text: Math.round(v).toLocaleString("en-US"), cls: "" };
  return { text: (v < 0 ? "−" : "") + Math.abs(v).toFixed(2), cls: "" };
}
function trOvPerf() {
  const frag = document.createDocumentFragment();
  if (!TR.ov.perf && !TR.ov.perfErr) return frag;   // 這一邊沒有這一份(這台電腦)
  frag.appendChild(trSec(trEl("span", "label", t("tr.ov.perf.label"))));
  if (!TR.ov.perf) { frag.appendChild(trEl("div", "pf-state", t("tr.ov.perfUnreach"))); return frag; }
  const m = TR.ov.perf.metrics || {}, grid = trEl("div", "bt-stats ov-stats perf-stats");
  // [名稱, metric, tipOk(met), tipGating | null, 格式, tipEstimate(met) | null]
  const volEst = (met) => {
    const byReason = trPerfReason(TR_PERF_VOL_EST, met.reason); if (byReason) return byReason;
    const h = met.sample_hours; if (typeof h !== "number" || !isFinite(h) || h < 1) return null;   // 講不出樣本量就退回累積中:數字旁標「0 小時」是錯的標注
    return h < 48 ? t("tr.ov.perf.volTipEstHours", { n: String(Math.round(h)) }) : t("tr.ov.perf.volTipEstDays", { n: String(Math.floor(h / 24)) });   // 天數往下取整(168h 才升 ok,round 會講成「只有 7 天」)
  };
  const cells = [
    [t("tr.ov.perf.cum"), m.cumulative_return, () => t("tr.ov.perf.cumTip"), null, "pctSigned", null],
    [t("tr.ov.perf.dd"), m.max_drawdown, (met) => t("tr.ov.perf.ddTipOk", { n: String(typeof met.window_days === "number" ? met.window_days : 0) }), t("tr.ov.perf.ddTipGating"), "drawdown", null],
    [t("tr.ov.perf.ann"), m.annual_return, () => t("tr.ov.perf.annTipOk"), t("tr.ov.perf.annTipGating"), "pctSigned", null],
    [t("tr.ov.perf.vol"), m.volatility, () => t("tr.ov.perf.volTipOk"), t("tr.ov.perf.volTipGating"), "pct", volEst],
    [t("tr.ov.perf.sharpe"), m.sharpe, () => t("tr.ov.perf.sharpeTipOk"), t("tr.ov.perf.sharpeTipGating"), "fixed", null],
    [t("tr.ov.perf.trades"), m.trade_count, () => t("tr.ov.perf.tradesTip"), null, "count", null],
  ];
  cells.forEach(([name, met0, tipOk, tipGate, kind, tipEst]) => {
    const met = met0 && typeof met0 === "object" ? met0 : {};
    const num = typeof met.value === "number" && isFinite(met.value), ok = met.status === "ok" && num;
    // estimate:有數字但樣本不足;講不出「樣本多少」的指標退回累積中(寧可不顯示,不讓數字配到錯的標注)
    const estTip = !ok && met.status === "estimate" && num && tipEst ? tipEst(met) : null;
    const reason = trPerfReason(TR_PERF_REASON, met.reason);
    const tip = ok ? tipOk(met) : estTip ? estTip : reason ? reason.split("{d}").join(tipOk(met)) : tipGate || tipOk(met);
    const cell = trEl("div", "stat"), sl = trEl("div", "sl sl-tip");
    sl.appendChild(trTipLabel("", name, tip)); cell.appendChild(sl);
    if (ok || estTip) { const r = trPerfFmt(kind, met.value); cell.appendChild(trEl("div", "sv" + (r.cls ? " " + r.cls : "") + (estTip ? " est" : ""), r.text)); }
    else cell.appendChild(trEl("div", "sv gating", t("tr.ov.perf.gating")));   // gating:小一號 muted「資料累積中」,不是壞值
    grid.appendChild(cell);
  });
  frag.appendChild(grid);
  return frag;
}
/* 平台算好的累積損益(異動點的跳變已剔除、從 0 起算):{ pts: [{ t, v }], anom } 或 null(這一邊沒有 / 讀不到 → 本機推算)。
   pnl 為 null 的點是資金異動:不畫、只用來出圖下那一句 */
function trPnlServerPoints() {
  const pc = TR.ov.perf && Array.isArray(TR.ov.perf.pnl_curve) ? TR.ov.perf.pnl_curve : null;
  if (!pc) return null;
  const from = Date.now() / 1000 - TR.ov.days * 86400, win = pc.filter((p) => p && typeof p.ts === "number" && isFinite(p.ts) && p.ts >= from);
  return { pts: win.filter((p) => typeof p.pnl === "number" && isFinite(p.pnl)).map((p) => ({ t: p.ts, v: p.pnl })).sort((a, b) => a.t - b.t), anom: win.some((p) => p.pnl == null) };
}
function trOvCurve() {
  const frag = document.createDocumentFragment(), sec = trEl("div", "pf-sec");
  const modes = trEl("span", "ov-modes"); modes.setAttribute("role", "group"); modes.setAttribute("aria-label", t("tr.ov.curve"));
  [["equity", t("tr.ov.modeEquity")], ["pnl", t("tr.ov.modePnl")]].forEach((m) => {
    const b = trEl("button", "rng", m[1]); b.type = "button"; b.setAttribute("aria-pressed", TR.ov.mode === m[0] ? "true" : "false");
    b.addEventListener("click", () => { TR.ov.mode = m[0]; TR.sig.over = null; trPaintOver(); trRefocus("ov-modes", m[1]); });
    modes.appendChild(b);
  });
  const acts = trEl("span", "pf-acts ov-ranges"); acts.setAttribute("role", "group"); acts.setAttribute("aria-label", t("tr.ov.range"));
  TR_RANGES.forEach((x) => {
    const label = x[0] || t("tr.ov.rangeAll");
    const b = trEl("button", "rng", label); b.type = "button"; b.setAttribute("aria-pressed", TR.ov.days === x[1] ? "true" : "false");
    b.addEventListener("click", () => { TR.ov.days = x[1]; TR.ov.at = 0; TR.sig.over = null; trPaintOver(); trRefocus("ov-ranges", label); });
    acts.appendChild(b);
  });
  sec.append(modes, acts); frag.appendChild(sec);
  // 還沒讀過(第一次開這一頁)/ 這一輪讀不到:各說各的,都不是「還沒有紀錄」
  if (!TR.ov.curve) { frag.appendChild(trEl("div", "pf-state", t("tr.loading"))); return frag; }
  if (TR.ov.curveErr) { frag.appendChild(trEl("div", "pf-state", t("tr.ov.curveUnreach"))); return frag; }
  const all = trCurvePoints();
  /* basis 換了就斷:這台電腦 = 口徑換過(0.0.4 只記下單錢包,之後記全帳戶);雲端 = 平台標的資金異動(出入金 / 綁解綁一個所,
     主行程把每個異動之後的點換一個 basis)。線在那裡斷開;累積損益只從最後一段起算,不拿兩段相減(入金不是獲利) */
  let cut = 0;
  all.forEach((p, i) => { if (i && p.b !== all[i - 1].b) cut = i; });
  const isPnl = TR.ov.mode === "pnl", srv = isPnl ? trPnlServerPoints() : null;   // 平台那條優先;沒有才本機推算
  const pts = srv ? srv.pts : isPnl ? all.slice(cut) : all;
  if (pts.length < 2) {
    frag.appendChild(trEl("div", "pf-state", pts.length ? t("tr.ov.emptyBaseline") : t("tr.ov.empty")));
    return frag;
  }
  const series = srv ? pts : isPnl ? pts.map((p) => ({ t: p.t, v: p.v - pts[0].v })) : pts;
  const frame = trEl("div", "ov-frame"), canvas = trEl("canvas", "ov-canvas"), tip = trEl("div", "cv-tip");
  const tipD = trEl("span", "d"), tipV = trEl("span", "v"), tipS = trEl("span", "d"); tip.append(tipD, tipV, tipS); tip.hidden = true;
  // 圖本身沒有可讀的數字:起訖值與筆數放進 label
  const first = series[0], last = series[series.length - 1];
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", t(isPnl ? "tr.ov.curveAriaPnl" : "tr.ov.curveAria", { a: trWithUnit(trFmt2(first.v, isPnl)), b: trWithUnit(trFmt2(last.v, isPnl)), n: series.length }));
  frame.append(canvas, tip); frag.appendChild(frame);
  // 斷在哪一種:資料自己帶 anomalies 的是平台標的資金異動,否則是這台電腦的口徑換過
  if (cut > 0 && !isPnl) frag.appendChild(trEl("div", "pf-foot", t(Array.isArray(TR.ov.curve.anomalies) ? "tr.ov.flowNote" : "tr.ov.basisNote")));
  if (srv && srv.anom) frag.appendChild(trEl("div", "pf-foot", t("tr.ov.pnlAnom")));   // 平台那條:異動點的跳變已剔除,講一句
  requestAnimationFrame(() => trDrawCurve(canvas, series, isPnl));
  /* hover(設計師 spec-desktop-ov-curve-hover-2026-09-25,照網頁 ovHover):重畫底圖再疊垂直指示線 + 線上圓點;小卡跟著點水平走、
     垂直釘在圖框頂(不跟 y 走才不抖),只落在繪圖區 [padL, W−padR](不進右軸欄、chips 在框外碰不到),右邊放不下翻左、都放不下貼 padL */
  canvas.addEventListener("mousemove", (e) => {
    if (!TR.ov.geo) return;   // 還沒畫過(requestAnimationFrame 之前)
    trDrawCurve(canvas, series, isPnl);   // 先重畫(清掉上一條線、幾何跟著目前尺寸)再讀 geo:canvas 剛被拉寬時第一個 mousemove 才不會畫錯位
    const g = TR.ov.geo, x = e.offsetX; let bi = -1, bd = Infinity;
    series.forEach((p, i) => { const d = Math.abs(g.xAt(p.t) - x); if (d < bd) { bd = d; bi = i; } });
    if (bi < 0) return;
    const p = series[bi], px = g.xAt(p.t), py = g.yAt(p.v);
    const ctx = canvas.getContext("2d");
    ctx.strokeStyle = trToken("--color-greyDark"); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(Math.round(px) + 0.5, g.padT); ctx.lineTo(Math.round(px) + 0.5, g.padT + g.ih); ctx.stroke();
    ctx.fillStyle = trToken(isPnl ? (p.v >= 0 ? "--color-greenText" : "--color-redText") : "--color-data-1");   // 點色跟線段同色
    ctx.beginPath(); ctx.arc(px, py, 3, 0, Math.PI * 2); ctx.fill();
    tipD.textContent = trStamp(p.t); tipV.textContent = trWithUnit(trFmt2(p.v, isPnl));
    // 權益模式第三行:相對「同一個 basis 段」的起點(跨過斷點相減等於把入金算成獲利;沒有斷點時就是區間起點)
    let s = bi; while (s > 0 && series[s - 1].b === p.b) s--;
    tipS.hidden = isPnl; tipS.textContent = isPnl ? "" : trWithUnit(trFmt2(p.v - series[s].v, true)) + " " + t(s > 0 ? "tr.ov.vsSeg" : "tr.ov.vsStart");   // 有斷點:字也說是「這一段」
    const right = g.W - g.padR;
    tip.style.maxWidth = (right - g.padL) + "px";   // 卡不得比繪圖區寬(288 欄:貼 padL 後右緣仍會探進右軸欄)
    tip.hidden = false;   // 先顯示才量得到寬
    const tw = tip.offsetWidth;
    let left = px + 16; if (left + tw > right) left = px - 16 - tw; if (left < g.padL) left = g.padL;
    tip.style.left = left + "px";
  });
  canvas.addEventListener("mouseleave", () => { tip.hidden = true; trDrawCurve(canvas, series, isPnl); });
  return frag;
}
// 重畫之後把焦點放回同一顆鈕(整段是重建的,不放回去焦點會掉到 BODY)
function trRefocus(groupCls, label) {
  const g = $("tr-over").querySelector("." + groupCls); if (!g) return;
  const b = [...g.querySelectorAll("button")].find((x) => x.textContent === label); if (b) b.focus();
}
function trToken(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function trDrawCurve(canvas, pts, isPnl) {
  const W = canvas.clientWidth, H = canvas.clientHeight; if (!W || !H) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext("2d"); ctx.scale(dpr, dpr);
  const padL = 8, padR = 72, padT = 12, padB = 22;
  let lo = Infinity, hi = -Infinity;
  pts.forEach((p) => { lo = Math.min(lo, p.v); hi = Math.max(hi, p.v); });
  if (isPnl) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
  const span = hi - lo; lo -= span * 0.08; hi += span * 0.08;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1;
  const xAt = (tt) => padL + ((tt - t0) / Math.max(1, t1 - t0)) * (W - padL - padR);
  const yAt = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
  TR.ov.geo = { xAt, yAt, padL, padR, padT, ih: H - padT - padB, W };   // hover 疊圖與小卡定位用
  ctx.font = "10px " + (getComputedStyle(canvas).fontFamily || "sans-serif");
  ctx.fillStyle = trToken("--ink-3"); ctx.strokeStyle = trToken("--border-hairline"); ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const v = lo + ((hi - lo) * i) / 3, y = Math.round(yAt(v)) + 0.5;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.fillText(trFmt2(v, isPnl) || "", W - padR + 6, y + 3);
  }
  ctx.fillText(trStamp(t0), padL, H - 6);
  const endLabel = trStamp(t1); ctx.fillText(endLabel, W - padR - ctx.measureText(endLabel).width, H - 6);
  ctx.lineWidth = 1.5; ctx.lineJoin = "round"; ctx.lineCap = "round";
  // Blave 沒開著的時段直接連起來(Wei 09-22):不斷線、沒有孤立點;圖下也不另外講(Wei 0.1.8:這不用寫)
  if (!isPnl) {
    // 權益:一條線,主資料序列色(同雲端;賺賠訊號歸 PnL 條的數字)
    ctx.strokeStyle = trToken("--color-data-1");
    ctx.beginPath(); pts.forEach((p, i) => (i && p.b === pts[i - 1].b ? ctx.lineTo(xAt(p.t), yAt(p.v)) : ctx.moveTo(xAt(p.t), yAt(p.v)))); ctx.stroke();
    return;
  }
  /* 累積損益:照雲端工作頁 workspace.html drawOvPnl——0 是水位線(虛線、比格線亮一階 --color-greyMedium),
     線逐段依 0 上下取 --color-greenText / --color-redText,跨過 0 的那一段在交越點切開。不鋪面積(雲端也沒有) */
  const zy = Math.round(yAt(0)) + 0.5;
  ctx.save(); ctx.setLineDash([3, 4]); ctx.strokeStyle = trToken("--color-greyMedium");
  ctx.beginPath(); ctx.moveTo(padL, zy); ctx.lineTo(W - padR, zy); ctx.stroke(); ctx.restore();
  const G = trToken("--color-greenText"), Rd = trToken("--color-redText");
  trPnlSegments(pts).forEach((sg) => {
    ctx.strokeStyle = sg.pos ? G : Rd; ctx.beginPath();
    ctx.moveTo(xAt(sg.t0), sg.v0 === 0 && sg.cut0 ? zy : yAt(sg.v0)); ctx.lineTo(xAt(sg.t1), sg.v1 === 0 && sg.cut1 ? zy : yAt(sg.v1)); ctx.stroke();
  });
}
// 機器側事件 → 兩段字(標題、後果註解)。白名單:不認得的型別不畫
// 拒單原文 → 在地化的那一句;比不到就照舊 tr.orderFailed(原文是不可信輸入:截長、走 textContent)
function trOrderErrText(sym, err) {
  const p = trOrderErrParse(err);
  if (p && p.kind === "paperLev") return t("tr.err.paperLev", { sym, gross: trFmt(p.gross), cap: trFmt(p.cap), x: p.x, c: trCcy() });
  if (p && p.kind === "paperBroke") return t("tr.err.paperBroke", { sym });
  if (p && p.kind === "okx_account_mode") return t("tr.err.okxMode", { sym });
  if (p && p.kind === "gateio_price_deviated") return t("tr.err.gateDeviated", { sym });
  if (p && Object.prototype.hasOwnProperty.call(TR_REJECT_TEXT, p.kind)) return t(TR_REJECT_TEXT[p.kind], { sym });
  return t("tr.orderFailed", { sym, err: String(err == null ? "" : err).slice(0, 200) });
}
/* 從電腦版送出的指令(平台的事件流才有,`{action, device}`,不帶任何值——契約 write-contract §7)。
   記的是「平台收下了指令」不是「機器已套用」,所以文案講「送出」;真的生效由後面的 halt / resume / venue_* 那幾列表達。
   認不得的 action(這一版的白名單比 api 舊)照樣留一列:稽核列消失比講得籠統更糟。 */
const TR_DT_ACTION = { halt: "tr.ov.evDtHalt", close_all: "tr.ov.evDtCloseAll", resume: "tr.ov.evDtResume", resume_wait: "tr.ov.evDtResume",
  amounts: "tr.ov.evDtAmounts", credentials: "tr.ov.evDtCredentials", credentials_remove: "tr.ov.evDtCredentialsRemove",
  restart_reconciler: "tr.ov.evDtRestartReconciler", retest_accounts: "tr.ov.evDtRetestAccounts",
  update: "tr.ov.evDtUpdate", delete_strategy: "tr.ov.evDtDeleteStrategy" };
function trEventText(type, d) {
  const v = { venue: trVenueLabel(String(d.venue || ""), true), minutes: d.minutes };
  if (type === "desktop_action") {
    const act = typeof d.action === "string" ? d.action : "";
    const dev = typeof d.device === "string" ? d.device.trim() : "";   // 裝置名是用戶自己取的:代進句子(t() 用 split/join,不吃正規式的 $)
    return [Object.prototype.hasOwnProperty.call(TR_DT_ACTION, act) ? t(TR_DT_ACTION[act]) : t("tr.ov.evDtOther"),
      dev ? t("tr.ov.evDtDevice", { device: dev }) : null];
  }
  if (type === "exchange_unreachable") return [t("tr.ov.evExUnreach", v), t("tr.ov.evExUnreachNote")];
  if (type === "exchange_recovered") return [t("tr.ov.evExBack", v), null];
  if (type === "bar_stale") return [t("tr.ov.evBarStale"), d.minutes == null ? null : t("tr.ov.evBarStaleNote", v)];
  if (type === "execution_fallback_market") return [t("tr.ov.evExecFallback"), t("tr.ov.evExecFallbackNote")];
  if (type === "execution_interrupted") return [t("tr.ov.evExecInterrupted"), t("tr.ov.evExecInterruptedNote")];
  if (type === "execution_stuck") return [t("tr.ov.evExecStuck"), t("tr.ov.evExecStuckNote")];
  if (type === "scheduler_error") return [t("tr.ov.evSchedErr"), t("tr.ov.evSchedErrNote")];
  if (type === "strategy_failed") return [t("tr.ov.evStrategyFailed"), t("tr.ov.evStrategyFailedNote")];
  // 主機重開、對帳器停著:標題已暫停,說明講「什麼單都不下」——跟 HALT 那列(平倉停損照常)並排時要分得出來
  if (type === "machine_restart_stopped") return [t("tr.ov.evRestartStopped"), t("tr.ov.evRestartStoppedNote")];
  // 主機重開、自動下單可能沒停住(舊對帳器沒有重開閘門):同網頁事件列那一句(先暫停、再更新);歷史不上紅
  if (type === "machine_restart_stop_failed") return [t("tr.ov.evRestartStopFailed"), t("tr.ov.evRestartStopFailedNote")];
  // 群益部位要人手動平(同網頁 workspace_ov_ev_manual_close):symbols 是逗號分隔的帳本 key,讀不到快照時是空字串 → 只講那一句、不帶標的
  if (type === "manual_close_required") {
    const syms = String(d.symbols || "").split(",").map((x) => x.trim()).filter(Boolean).join(", ");
    return [t("tr.ov.evManualClose") + (syms ? " · " + syms : ""), t("tr.ov.evManualCloseNote")];
  }
  if (type === "downtime_paused") return [t("tr.ov.evHaltAuto"), t("tr.ov.evDowntimeNote")];   // 不是 HALT:連平倉都凍結,不能用 evHaltNote 那句
  return null;
}
function trOvEvents(r) {
  const frag = document.createDocumentFragment();
  frag.appendChild(trSec(trEl("span", "label", t("tr.ov.events"))));
  const from = Date.now() - TR.ov.days * 86400000, rows = [];
  const push = (ms, build) => { if (ms != null && ms >= from) rows.push({ ms, build }); };
  (Array.isArray(r.orders) ? r.orders : []).forEach((o) => {
    if (!o || typeof o !== "object") return;
    push(trMs(o.ts), (body) => {
      const sell = o.action === "SELL", sym = String(o.symbol || "");
      body.appendChild(trEl("span", sell ? "sell" : "buy", sell ? t("tr.sell") : t("tr.buy")));
      const sn = trEl("span", "");
      if (!(trOrderLots(o) && trTxfSymInto(sn, trOrderContract(o)))) { sn.className = "mono"; sn.textContent = sym.replace(/@spot$/, ""); }
      body.append(" ", sn, " ", trEl("span", "dim", /@spot$/.test(sym) ? t("tr.mkt.spot") : t("tr.mkt.swap")));
      const legs = Array.isArray(o.legs) ? o.legs : [], px = legs.map((l) => trFmtPrice(l && l.fill_price)).filter(Boolean);
      const amt = trFmt(Math.abs(typeof o.signed_diff === "number" ? o.signed_diff : NaN));
      if (amt != null) {
        // 口數單寫「N 口」(同網頁總覽事件、下單紀錄)
        const m = trEl("span", "mono", amt), lotsN = Math.abs(typeof o.signed_diff === "number" ? o.signed_diff : NaN);
        if (trOrderLots(o)) m.appendChild(trEl("span", "ccy lots", t(trLotsKey(lotsN, "tr.lotsUnit", "tr.lotUnit")))); else if (trUnit()) m.appendChild(trEl("span", "ccy", trUnit()));
        body.append(" ", m);
        if (px.length) body.append(" ", trEl("span", "mono", "@ " + px.join(" → ")));
      }
    });
  });
  /* 這台電腦:從這個 app 的畫面做的動作(宿主在指令 ack 成功時記的;聊天裡做的不會有)。
     雲端:平台的事件流(/cloud/events),欄位包在 data 裡、型別也多得多——認不得的型別不畫(沒有文案就是一行代號)。
     有了它,「已暫停下單」那一列在恢復之後不會消失,也才有「已恢復下單 / 已連接 / 已解除」。 */
  const ui = Array.isArray(TR.ov.ui) ? TR.ov.ui : [], uiHalts = [];
  ui.forEach((ev) => {
    if (!ev || typeof ev.ts !== "number" || typeof ev.type !== "string") return;
    const d = ev.data && typeof ev.data === "object" ? ev.data : ev;   // 平台格式的欄位在 data;這台電腦那一份直接放最外層
    const venue = trVenueLabel(String(d.venue || ""), true);
    let head = null, note = null;
    // 誰按的看 source(鏡射平台的 _HALT_AUTO_SOURCES);這台電腦記的那一筆沒有 source = 人按的
    if (ev.type === "halt" || ev.type === "halt_close") { head = t(d.source === "reconciler" || d.source === "portfolio" ? "tr.ov.evHaltAuto" : "tr.ov.evHalt"); note = trHaltStopsAll(d) ? t("tr.ov.evRestartStoppedNote") : t("tr.ov.evHaltNote"); uiHalts.push(ev.ts * 1000); }
    else if (ev.type === "resume" || ev.type === "resume_wait") { head = t("tr.ov.evResume"); note = t("tr.ov.evResumeNote"); }
    else if (ev.type === "venue_connected" && venue) head = t("tr.ov.evConnected", { venue });
    else if (ev.type === "venue_disconnected" && venue) head = t("tr.ov.evDisconnected", { venue });
    else { const txt = trEventText(ev.type, d); if (txt) { head = txt[0]; note = txt[1]; } }   // 雲端才有的型別(desktop_action、交易所連不上…)
    if (!head) return;
    push(ev.ts * 1000, (body) => { body.appendChild(trEl("span", "hl", head)); if (note) body.append(" ", trEl("span", "dim", "— " + note)); });
  });
  // 目前的 HALT(狀態檔的現況):畫面上按的那一次已經在上面了,兩分鐘內的同一件事不重複列;自動暫停、聊天裡的暫停只有這裡看得到
  const halt = r.halt || {}, haltMs = trMs(halt.at);
  if (halt.halted && !uiHalts.some((x) => haltMs != null && Math.abs(x - haltMs) < 120000)) push(haltMs, (body) => {
    body.appendChild(trEl("span", "hl", halt.source && halt.source !== "web" ? t("tr.ov.evHaltAuto") : t("tr.ov.evHalt")));
    body.append(" ", trEl("span", "dim", "— " + (trHaltStopsAll(halt) ? t("tr.ov.evRestartStoppedNote") : t("tr.ov.evHaltNote"))));   // A′:什麼單都不下,同重開那一句
  });
  (Array.isArray(r.order_errors) ? r.order_errors : []).forEach((e) => {
    if (!e || typeof e !== "object") return;
    push(trMs(e.ts), (body) => {
      body.appendChild(trEl("span", "sell", t("tr.ov.evErr")));
      const sym = String(e.symbol || "").replace(/@spot$/, ""), raw = String(e.error || e.message || "");
      if (trOrderErrParse(raw)) body.append(" ", trEl("span", "dim", "— " + trOrderErrText(sym, raw)));   // 認得的原因:整句在地化(句子自己帶標的)
      else body.append(" ", trEl("span", "mono", sym), " ", trEl("span", "dim", "— " + raw.slice(0, 160)));
    });
  });
  (Array.isArray(r.events) ? r.events : []).forEach((ev) => {
    if (!ev || typeof ev.type !== "string") return;
    const evd = ev.payload && typeof ev.payload === "object" ? ev.payload : ev.data && typeof ev.data === "object" ? ev.data : ev;   // 機器事件的欄位叫 payload(runtime/events.py);data 是平台格式
    const txt = trEventText(ev.type, evd);
    if (!txt) return;
    push(trMs(ev.ts), (body) => { body.appendChild(trEl("span", "hl", txt[0])); if (txt[1]) body.append(" ", trEl("span", "dim", "— " + txt[1])); });
  });
  /* 讀不到就說讀不到:絕不可以把「這一輪沒讀到」畫成「這段期間沒有事件」(同權益曲線的先例——讀不到就不畫,不斷言)。
     報告裡的那幾種(下單、現在的 HALT、下單失敗)是另一個來源,讀得到就照列,所以這一句是加在清單上面、不取代清單。 */
  if (TR.ov.uiErr) frag.appendChild(trEl("div", "pf-state", t("tr.ov.evUnreach")));
  if (!rows.length) { if (!TR.ov.uiErr) frag.appendChild(trEl("div", "pf-state", t("tr.ov.evEmpty"))); return frag; }
  rows.sort((a, b) => b.ms - a.ms);
  const list = trEl("div", "ev-list"); frag.appendChild(list);   // 自成一個容器:最後一列靠 :last-child 收底線
  const today = new Date().toDateString(), yest = new Date(Date.now() - 86400000).toDateString();
  let curKey = null;
  rows.slice(0, 200).forEach((x) => {
    const d = new Date(x.ms), key = d.toDateString();
    if (key !== curKey) {
      curKey = key;
      const head = trEl("div", "ev-day"), human = key === today ? t("tr.ov.today") : key === yest ? t("tr.ov.yesterday") : null;
      if (human) head.append(human + " · ");
      head.appendChild(trEl("span", "mono", trMD(d)));
      list.appendChild(head);
    }
    const row = trEl("div", "ev-row"), body = trEl("span", "body");
    row.append(trEl("span", "ts mono", trHM(x.ms)), body); x.build(body);
    list.appendChild(row);
  });
  return frag;
}

/* ── 連接交易所(模擬交易 / Binance 真錢)────────────────────────────────────
   入口在自動下單頁的 onboard(照雲端版):#tr-connect 直接開 #cx-scrim 這個框;連好之後的「重新測試 / 解除綁定」在 設定 分頁的帳戶段(trPaintSet)。
   設定 modal 不再有「連線」分類(批次 ④ 會以「資料來源」回來)。這個框只連**這台電腦**:狀態固定用 TR_BAGS.local 那一袋,
   雲端視角開不起來(第一刀唯讀)——cxModalOpen 硬擋,不只靠那顆鈕的 aria-disabled。IPC 不變(tradeSend credentials / retest_accounts)。 */
let cxOpener = null;
/* 表單自己的狀態(不放進袋子的 sig:金鑰不該變成一個到處被複製的字串)。ip:undefined = 還沒查 / null = 查不到 / 字串 = IPv4。
   bn = 主行程 binance_link 的 state(重查結果),設定分頁的帳戶那一列用。 */
const CXF = { env: "local", venue: PAPER, apiKey: "", secret: "", passphrase: "", ip: undefined, ipBusy: false, res: null, lockUntil: 0, lockTimer: null, bn: null, storeOpen: false };
const cxBag = () => TR_BAGS[CXF.env === "cloud" ? "cloud" : "local"];
// 雲端主機現在的對外 IP(cloud.js 只在 running 時交出來;停機的主機沒有固定 IP)
function cxCloudIp() { const c = TR_BAGS.cloud.st && TR_BAGS.cloud.st.cloud; const ip = c && c.machine && c.machine.public_ip; return typeof ip === "string" && ip ? ip : null; }
function cxForget() { CXF.apiKey = ""; CXF.secret = ""; CXF.passphrase = ""; CXF.res = null; if (typeof capForget === "function") capForget(); if (typeof presForget === "function") presForget(); }
/* 兩個視角共用這個框(spec-desktop-cloud-s5 §2:只差五處)。雲端只在主機 running 時開得起來。 */
function cxModalOpen(opener, venue) {   // venue:設定分頁群益「繼續」直接帶進群益那條(只有雲端);統一「繼續」只有這台電腦
  const env = ENV.cur;
  if (TR.env !== env || !$("cx-scrim").hidden) return;
  if (env === "cloud" && envCloudKind(TR_BAGS.cloud.st) !== "running") return;
  CXF.env = env;
  const L = cxBag(); L.cx = { busy: false, err: null, retest: false };
  cxOpener = opener || null; cxForget(); CXF.venue = venue === CAPITAL && env === "cloud" ? CAPITAL : venue === "president" && env === "local" ? venue : PAPER; CXF.storeOpen = false;
  if (CXF.venue === CAPITAL && typeof capResume === "function") capResume();
  $("view-ws").inert = true;
  const sc = $("cx-scrim"); sc.hidden = false;
  requestAnimationFrame(() => sc.classList.add("open"));
  L.sig.cxm = null; cxModalPaint();
  const f = $("cx-venue") || $("cx-body").querySelector("input, .cap-step.is-cur button") || $("cx-close"); f.focus();
}
function cxModalClose(connected) {
  const sc = $("cx-scrim"); if (sc.hidden) return;
  sc.classList.remove("open"); sc.hidden = true; $("view-ws").inert = false;
  cxForget(); $("cx-body").textContent = ""; cxBag().sig.cxm = null;   // 欄位連同 DOM 一起丟:關掉的框裡不留金鑰
  const o = cxOpener; cxOpener = null;
  // 連上之後 onboard(連同那顆鈕)會整個換成分頁:焦點退到側欄的入口,不能掉到 BODY
  if (!connected && o && o.isConnected) o.focus(); else $("tr-nav").focus();
}
// 打開表單(選到 Binance)就查一次對外 IP;表單開著期間不自動重查。查不到不擋表單
async function cxIpLookup() {
  if (CXF.env === "cloud") return;   // 雲端用主機回報的 IP,不從這台電腦查
  if (CXF.ipBusy || typeof window.blave.binanceIp !== "function") return;
  CXF.ipBusy = true; CXF.ip = undefined; cxModalPaint();
  let ip = null; try { ip = await window.blave.binanceIp(); } catch (_) { }   // 查不到
  CXF.ipBusy = false; CXF.ip = typeof ip === "string" && /^[0-9.]{7,15}$/.test(ip) ? ip : null;   // 只收 IPv4;主行程已經驗過,這裡再守一次
  if (!$("cx-scrim").hidden) cxModalPaint();
}
/* IP 的複製元件(連接框與設定分頁「IP 換了」共用;設計師規格 v2 方案 C):chip 裡是 IP + 一顆 icon 鈕(視覺 24、熱區 28),
   旁邊一個 status 槽——複製成功才換成勾、講「已複製」2 秒。可及名稱固定講出複製的是什麼。icon 用 DOM 組(這個檔不用 innerHTML)。 */
const CX_ICONS = { copy: [["rect", { width: 14, height: 14, x: 8, y: 8, rx: 2, ry: 2 }], ["path", { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" }]], check: [["path", { d: "M20 6 9 17l-5-5" }]] };
function cxIcon(name) {
  const NS = "http://www.w3.org/2000/svg", svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "ic ic-" + name); svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
  for (const [tag, attrs] of CX_ICONS[name]) { const n = document.createElementNS(NS, tag); Object.keys(attrs).forEach((k) => n.setAttribute(k, String(attrs[k]))); svg.appendChild(n); }
  return svg;
}
function cxIpChip(ip) {
  const w = trEl("div", "cx-chipw"), chip = trEl("span", "cx-chip"), b = trEl("button", "cx-icb"), said = trEl("span", "cx-said");
  b.type = "button"; b.setAttribute("aria-label", t("cx.ip.copyThis")); b.append(cxIcon("copy"), cxIcon("check")); said.setAttribute("role", "status");
  b.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(ip); } catch (_) { return; }
    b.classList.add("is-done"); said.textContent = t("cx.ip.copied");
    setTimeout(() => { if (b.isConnected) { b.classList.remove("is-done"); said.textContent = ""; } }, 2000);
  });
  chip.append(trEl("span", "v", ip), b); w.append(chip, said);
  return w;
}
// 檢查結果 → 那一句(spec §5.3)。字面 key 一個一個寫:check_shell_strings 靠字面掃「用到的 key」
/* Binance 以外的四家:句子不能寫死「Binance」。REJECTED = 那一家拒絕(runtime 讀帳戶失敗,原因已遮過金鑰);UNKNOWN = 回了但不是權益;
   NO_CHECK = 這台的 lib 還沒有那一家的帳戶讀取器(更新之前) */
function cxChkTextVenue(r) {
  const c = r && r.code, name = trVenueLabel(CXF.venue, true), d = (r && r.detail) || {};
  if (c === "BAD_KEY_FORMAT") return t("cx.chk.keyFormatV", { venue: name });
  if (c === "WITHDRAW_ENABLED") return t("cx.chk.withdrawV", { venue: name });
  if (c === "INCOMPLETE_PAIR") return CX_VENUES[CXF.venue] && CX_VENUES[CXF.venue].pass ? t("cx.chk.incompletePass") : t("cx.chk.incomplete");
  if (c === "REJECTED") return trErrToken(d.reason) === "okx_account_mode" ? t("cx.err.okxMode") : t("cx.chk.rejectedV", { venue: name, reason: String(d.reason || "—").slice(0, 200) });
  if (c === "UNKNOWN") return t("cx.chk.unknownV", { venue: name });
  if (c === "NO_CHECK") return t("cx.chk.noCheckV", { venue: name });
  return null;
}
function cxChkText(r) {
  const c = r && r.code;
  // 雲端的 REJECTED 是**主機**拒絕這個指令(例如主機的 runtime 太舊、還不認得這家),帶的是 detail.error,不是交易所拒絕金鑰:
  // 不走 cxChkTextVenue 那句「{venue} 沒有接受這把金鑰：{reason}」(那條只有本機才有 reason,雲端會永遠是「：—」,設計稽核 005 第 2 條)
  if (CXF.venue !== BINANCE && CXF.venue !== PAPER && !(CXF.env === "cloud" && c === "REJECTED")) { const v = cxChkTextVenue(r); if (v) return v; }
  if (CXF.env === "cloud") return cxChkTextCloud(r);
  return c === "WITHDRAW_ENABLED" ? t("cx.chk.withdraw") : c === "TRADING_DISABLED" ? (CXF.ip ? t("cx.chk.trading") : t("cx.chk.tradingNoIp"))
    : c === "IP_OR_KEY" ? t("cx.chk.ipOrKey") : c === "BAD_KEY_FORMAT" ? t("cx.chk.keyFormat")
    : c === "BAD_SECRET" ? t("cx.chk.secret") : c === "CLOCK" ? t(window.blave.platform === "win32" ? "cx.chk.clock.win" : "cx.chk.clock") : c === "RATE_LIMITED" ? t("cx.chk.rate") : c === "NETWORK" ? t("cx.chk.network")
    : c === "SEND_FAILED" ? cxSendFailText(r)
    : t("cx.chk.unknown");
}
/* 20 秒逾時分兩句真話(spec-desktop-006 §1.3 C):TIMEOUT = daemon 沒收走指令、撤回成功、沒存(紅,叫人再連);
   UNKNOWN_RESULT = daemon 收走了還沒回 ack、可能還在查、可能稍後會存(灰,叫人先去 設定 › 帳戶 看)。其餘照舊 */
function cxSendFailText(r) {
  const e = String(r.detail && r.detail.error || "—").slice(0, 200);
  if (e === "TIMEOUT") return t("cx.chk.engineTimeout");
  if (e === "UNKNOWN_RESULT") return t("cx.chk.gateSlow", { venue: trVenueLabel(CXF.venue, true) });
  return TR_BAGS.local.st && TR_BAGS.local.st.alive ? t("cx.chk.sendFail", { err: e }) : t("cx.down");
}
const cxGateSlow = (r) => !!r && r.code === "SEND_FAILED" && !!r.detail && r.detail.error === "UNKNOWN_RESULT";
/* 雲端連接的結果 → 那一句(spec-desktop-cloud-s5 §4;提領開著主機一樣擋,同一句)。
   本機那組寫死「這台電腦」的(時間、網路、限速)另寫雲端版;「上面這個 IP」在雲端就是主機的 IP,沿用。 */
function cxChkTextCloud(r) {
  const c = r && r.code, d = (r && r.detail) || {};
  return c === "WITHDRAW_ENABLED" ? t("cx.chk.withdraw") : c === "TRADING_DISABLED" ? (cxCloudIp() ? t("cx.chk.trading") : t("cx.chk.tradingNoIp"))
    : c === "INCOMPLETE_PAIR" ? t("cx.chk.incomplete") : c === "IP_OR_KEY" ? t("cx.chk.ipOrKey") : c === "BAD_KEY_FORMAT" ? t("cx.chk.keyFormat")
    : c === "BAD_SECRET" ? t("cx.chk.secret") : c === "CLOCK" ? t("cx.chk.clockCloud") : c === "NETWORK" ? t("cx.chk.networkCloud")
    : c === "RATE_LIMITED" ? t("cx.chk.rateCloud") : c === "RATE_BANNED" ? t("cx.chk.bannedCloud") : c === "RATE_BACKOFF" ? t("cx.chk.backoffCloud")
    : c === "REJECTED" ? (trErrToken(d.error) === "okx_account_mode" ? t("cx.err.okxMode") : t("tr.cloud.cmdRejected", { err: String(d.error || "—").slice(0, 200) }))
    : c === "CMD_UNKNOWN" ? t("tr.cloud.cxUnknown")
    : c === "UNDELIVERED" ? (trSendError({ error: d.error, kind: d.kind || "undelivered", machineState: d.machineState }, "connect", "cloud") || t("side.stopped"))
    : t("cx.chk.unknown");
}
// 灰記號(不是錯):限速兩種輕的
const cxCalm = (r) => !!r && (r.code === "RATE_LIMITED" || r.code === "RATE_BACKOFF");
/* 交易所選單(兩個視角共用;群益那條 capital.js 也用):「台股」一組兩個視角各一家——雲端群益(主機是 Windows 才連得上,不是的話選了會講)、這台電腦統一 */
function cxVenueField(L) {
  const lab = trEl("label", "fld"); lab.appendChild(trEl("span", "fld-l", t("cx.venue")));
  const w = trEl("span", "f-selw"), sel = trEl("select", "f-input"); sel.id = "cx-venue";
  const o = trEl("option", "", t("cx.paper")); o.value = PAPER; sel.appendChild(o);   // 模擬交易排最上面(同雲端版),再來「加密貨幣」那一組
  const g = document.createElement("optgroup"); g.label = t("cx.group.crypto");
  cxVenuesFor(CXF.env).forEach((id) => { const ob = trEl("option", "", trVenueLabel(id)); ob.value = id; g.appendChild(ob); });
  sel.appendChild(g);
  // 群益只在雲端(交給 capital.js;電腦版不接群益,這台電腦那條 Wei 0.1.18 拿掉)。統一期貨只在這台電腦視角
  // (雲端的開通在網頁;設計稿 §5 電腦版雲端視角 v1 不做)。Mac 也列統一,選了講一句(d-mac)
  { const g2 = document.createElement("optgroup"); g2.label = t("cap.group.tw");
    const o2 = trEl("option", "", CXF.env === "local" ? t("pres.venue") : t("cap.venue")); o2.value = CXF.env === "local" ? "president" : CAPITAL; g2.appendChild(o2);
    sel.appendChild(g2); }
  sel.value = CXF.venue; sel.disabled = !!L.cx.busy || (CXF.venue === CAPITAL && typeof CAP !== "undefined" && CAP.busy);
  sel.addEventListener("change", () => {
    CXF.venue = cxVenuesFor(CXF.env).indexOf(sel.value) >= 0 || (sel.value === CAPITAL && CXF.env === "cloud") || (sel.value === "president" && CXF.env === "local") ? sel.value : PAPER;
    cxForget(); L.cx.err = null; L.sig.cxm = null; cxModalPaint(); if (CXF.venue !== PAPER && CXF.venue !== CAPITAL && CXF.venue !== "president" && CXF.ip === undefined) cxIpLookup();
  });
  w.appendChild(sel); lab.appendChild(w);
  return lab;
}
function cxModalPaint() {
  if (CXF.venue === CAPITAL && CXF.env === "cloud") return capPaint();   // 群益整個框交給 capital.js
  if (typeof capFootRestore === "function") capFootRestore();
  if (CXF.venue === "president" && CXF.env === "local") {   // 統一整個框交給 president.js;第一次進來先問主行程存了什麼、看 PSCCA
    if (!PRES.started) { PRES.started = true; presResume(); }
    return presPaint();
  }
  if (typeof presFootRestore === "function") presFootRestore();
  const L = cxBag(), box = $("cx-body"), go = $("cx-go"), cloud = CXF.env === "cloud";
  // 雲端:框開著時主機停了 → 框不自己關(可能正在貼金鑰),主鈕鎖住、結果那一格講原因;限速不做 app 端計時鎖(主機自己在冷卻)
  const down = cloud && envCloudKind(TR_BAGS.cloud.st) !== "running";
  const venue = CXF.venue, locked = !cloud && Date.now() < CXF.lockUntil, off = L.cx.busy || (venue === BINANCE && locked) || down;
  const cip = cloud ? cxCloudIp() : null;
  const sig = LANG + "|" + JSON.stringify([CXF.env, venue, L.cx, cloud ? cip : CXF.ip === undefined ? "?" : CXF.ip, CXF.ipBusy, CXF.res && [CXF.res.code, CXF.res.detail], locked, down]);
  // 等的時候圓環在字前(同 app.js 更新鈕);只在字換了才重組——輪詢重畫不能重啟圓環的動畫
  const goLabel = L.cx.busy ? t("cx.connecting") : t("cx.connect");
  if (go.textContent.trim() !== goLabel || !!go.querySelector(".spin16") !== !!L.cx.busy) {
    go.textContent = "";
    if (L.cx.busy) { const sp = trEl("span", "spin16"); sp.setAttribute("aria-hidden", "true"); go.append(sp, " "); }
    go.append(goLabel);
  }
  go.setAttribute("aria-disabled", off ? "true" : "false"); go.classList.toggle("is-busy", !!L.cx.busy);
  box.setAttribute("aria-busy", L.cx.busy ? "true" : "false");
  // 雲端的五處差異之 1、4:標題列灰底 +「雲端」記號;鈕正上方講目的地
  $("cx-modal").querySelector(".modal-head").classList.toggle("cloud", cloud);
  $("cx-env").hidden = !cloud; $("cx-env").textContent = cloud ? t("env.cloud") : "";
  const money = venue === PAPER ? "paper" : "real";
  $("cx-where").hidden = !cloud; $("cx-where").textContent = cloud ? t("tr.cloud.footWhere", { where: t("env.cloud"), money: envMoneyText(money), venue: trVenueLabel(venue, true) }) : "";
  if (L.sig.cxm === sig && box.firstChild) return;
  L.sig.cxm = sig;
  const hadId = box.contains(document.activeElement) ? document.activeElement.id : null;
  box.textContent = "";
  const sel = box.appendChild(cxVenueField(L)).querySelector("select");
  box.appendChild(trEl("p", "cx-manual-note", t("cx.acct.meta")));
  if (venue === PAPER) box.appendChild(trEl("p", "cx-manual-note", t("cx.paperNote")));
  else {
    const fld = (id, label, key, hint) => {
      const l = trEl("label", "fld"); l.appendChild(trEl("span", "fld-l", label));
      const i = trEl("input", "f-input"); i.id = id; i.type = "password"; i.autocomplete = "off"; i.spellcheck = false; i.setAttribute("autocapitalize", "off");
      i.value = CXF[key]; i.readOnly = !!L.cx.busy;
      i.addEventListener("input", () => { CXF[key] = i.value; });
      i.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); cxConnect(); } });
      l.appendChild(i);
      if (hint) { const h = trEl("p", "cx-hint", hint); h.id = id + "-hint"; i.setAttribute("aria-describedby", h.id); l.appendChild(h); }
      box.appendChild(l);
    };
    fld("cx-api", t("cx.apiKey"), "apiKey"); fld("cx-secret", t("cx.secretKey"), "secret");
    // OKX 的 Passphrase 是建立 API 金鑰時自己設的那組:最常見的錯是填成登入密碼(設計稽核 005 第 10 條)
    if (CX_VENUES[venue] && CX_VENUES[venue].pass) fld("cx-pass", t("cx.passphrase"), "passphrase", t("cx.passHint"));
    const note = trEl("div", "cx-note");
    // 子帳戶建議排第一段(ux-order-1-4-5 §3.4):只給加密交易所;機器只管自己的部位(self_ledger)時換成單向持倉那句
    if (CX_VENUES[venue]) note.appendChild(trEl("p", "cx-sub", t((trReport() || {}).self_ledger === true ? "cx.note.subAcctOwn" : "cx.note.subAcct")
      + (venue === BINANCE ? (LANG === "zh" ? "" : " ") + t("tr.lev.binance5") : "")));
    note.appendChild(trEl("p", "", venue === BINANCE ? t("cx.note.one") : t("cx.note.oneV", { venue: trVenueLabel(venue, true) })));
    // 查不到提領權限的那家(runtime _WITHDRAW_CHECKED 沒有它 = Gate.io;本機與雲端主機同一張表):講明 Blave 不會替他擋,要自己確認
    if (CX_VENUES[venue] && CX_VENUES[venue].noWdCheck) note.appendChild(trEl("p", "cx-hint", t("cx.note.wdUnchecked", { venue: trVenueLabel(venue, true) })));
    if (cloud) {   // 雲端的五處差異之 2:主機的 IP,不查、沒有「再查一次」;拿不到不擋(白名單本來就不強制)
      if (cip) note.appendChild(cxIpChip(cip));
      else { const w = trEl("div", "cx-chipw"), chip = trEl("span", "cx-chip is-empty"); chip.appendChild(trEl("span", "v", t("cx.ip.cloudNone"))); w.appendChild(chip); note.appendChild(w); }
      note.appendChild(trEl("p", "cx-hint", t("cx.ip.cloudNote")));
    } else if (CXF.ip) note.appendChild(cxIpChip(CXF.ip));
    else {   // 查詢中 / 查不到:同一個 chip 殼、灰字;查不到才有「再查一次」與一句原因
      const lost = !(CXF.ipBusy || CXF.ip === undefined), w = trEl("div", "cx-chipw"), chip = trEl("span", "cx-chip is-empty");
      chip.appendChild(trEl("span", "v", lost ? t("cx.ip.noneLong") : t("cx.ip.loading"))); w.appendChild(chip);
      if (lost) { const rb = trEl("button", "btn-quiet", t("cx.ip.retry")); rb.type = "button"; rb.id = "cx-ip-retry"; rb.addEventListener("click", cxIpLookup); w.appendChild(rb); }
      note.appendChild(w);
      if (lost) note.appendChild(trEl("p", "cx-hint", t("cx.ip.fail")));
    }
    // 金鑰存在哪、誰讀得到:收進展開列(真的 button + aria-expanded)。「agent 和你的策略程式讀得到」那句在展開內容裡原文保留。
    // 展開狀態記在 CXF:框重畫(查到 IP、出錯)時不會自己收回去;按的時候就地切,不重畫(焦點不掉)
    const disc = trEl("button", "cx-disc", t("cx.store.q")), store = trEl("p", "cx-disc-p", cloud ? t("cx.leadCloud") : t("cx.lead"));   // 雲端的五處差異之 3
    disc.type = "button"; disc.id = "cx-store-q"; store.id = "cx-store"; disc.setAttribute("aria-controls", "cx-store");
    disc.setAttribute("aria-expanded", CXF.storeOpen ? "true" : "false"); store.hidden = !CXF.storeOpen;
    disc.addEventListener("click", () => { CXF.storeOpen = !CXF.storeOpen; disc.setAttribute("aria-expanded", CXF.storeOpen ? "true" : "false"); store.hidden = !CXF.storeOpen; });
    note.append(disc, store);
    box.appendChild(note);
  }
  const slot = trEl("div", ""); slot.setAttribute("role", "status"); box.appendChild(slot);
  const msg = down ? t("side.stopped") : (venue !== PAPER || cloud) && CXF.res ? cxChkText(CXF.res) : L.cx.err;
  const calm = !down && CXF.res && (cloud ? cxCalm(CXF.res) : (CXF.res.code === "RATE_LIMITED" && venue === BINANCE) || cxGateSlow(CXF.res));
  if (msg) { const p = trEl("p", "plan-err" + (calm ? " is-calm" : "")), m = trEl("span", "fault-mark"); m.setAttribute("aria-hidden", "true"); p.append(m, trEl("span", "", msg)); slot.appendChild(p); }
  // 真錢的等待(交易所做簽名讀取要 2–8 秒):同一個槽講在等什麼,不加記號、不加第二個圓環;模擬是本機寫 .env、次秒完成,不放
  else if (L.cx.busy && !cloud && venue !== PAPER) slot.appendChild(trEl("p", "cx-manual-note", t("cx.gate.checking", { venue: trVenueLabel(venue, true) })));
  const back = hadId && $(hadId); if (back && !back.disabled) back.focus(); else if (hadId) sel.focus();
}
function cxWire() {
  $("cx-cancel").addEventListener("click", () => cxModalClose(false));
  $("cx-close").addEventListener("click", () => cxModalClose(false));
  $("cx-go").addEventListener("click", cxConnect);
  $("cx-scrim").addEventListener("mousedown", (e) => { if (e.target === $("cx-scrim")) cxModalClose(false); });
  $("cx-scrim").addEventListener("keydown", (e) => trapTab(e, $("cx-modal")));   // Esc 在 app.js 的 escTop(document 層)
  // 重查結果:開場拿一次,之後主行程有變就推過來(設定分頁帳戶那一列)
  const onBn = (st) => { CXF.bn = st && typeof st === "object" ? st : null; trRepaint(); };   // 標題列、切換器那格、設定分頁帳戶列都看它
  if (typeof window.blave.binanceState === "function") window.blave.binanceState().then(onBn).catch(() => {});
  if (typeof window.blave.onBinanceState === "function") window.blave.onBinanceState(onBn);
}
function cxSendFail(res) {
  const e = res && res.error ? String(res.error) : "", k = trErrorKind(e), L = TR_BAGS.local;
  if (k === "unknown") return t("tr.cmdUnknown");
  if (e === "DAEMON_DOWN" || !L.st || !L.st.alive) return t("cx.down");
  return k === "rejected" ? t("tr.cmdRejected", { err: e.slice(0, 200) }) : t("cx.sendFail", { err: e.slice(0, 200) || "—" });
}
async function cxConnected(say) {
  const L = TR_BAGS.local;
  srSay(say || t("cx.connected"));
  try { L.st = await L.api.tradeStatus(); } catch (_) { }   // 輪詢會補
  L.sig = {}; cxModalClose(true); trPaint(); trPollSoon(1500);
}
/* Binance:金鑰交給主行程查權限(沒有交易權限的 key 不存),過了才由主行程送進 daemon。這裡只拿到代號。
   沒通過 = 沒有儲存;欄位怎麼處理照 spec §5.3(Secret 貼錯才清 Secret,其餘保留內容)。 */
async function cxConnectBinance() {
  const L = TR_BAGS.local;
  if (Date.now() < CXF.lockUntil) return;
  L.cx = { busy: true, err: null, retest: false }; CXF.res = null; cxModalPaint();
  let r = null; try { r = await window.blave.binanceConnect(CXF.apiKey.trim(), CXF.secret.trim()); } catch (_) { }   // 主行程沒回
  L.cx.busy = false;
  if ($("cx-scrim").hidden) { cxForget(); return; }   // 檢查期間用戶關了框:結果不上畫面(存了的話輪詢會帶出已連接)
  if (r && r.ok) { cxForget(); return cxConnected(); }
  CXF.res = r && typeof r.code === "string" ? r : { code: "UNKNOWN" };
  if (CXF.res.code === "BUSY") CXF.res = null;
  if (CXF.res && CXF.res.code === "RATE_LIMITED") {   // 鎖主鈕(429:60 秒 / 418:5 分鐘),不顯示倒數;時間到自己解開
    CXF.lockUntil = Date.now() + Math.min(Math.max(Number(CXF.res.lockMs) || 60000, 1000), 600000);
    clearTimeout(CXF.lockTimer); CXF.lockTimer = setTimeout(() => { if (!$("cx-scrim").hidden) cxModalPaint(); }, CXF.lockUntil - Date.now() + 50);
  }
  if (CXF.res && CXF.res.code === "BAD_SECRET") CXF.secret = "";
  if (CXF.res) srSay(cxChkText(CXF.res));
  L.sig.cxm = null; cxModalPaint();
  const c = CXF.res && CXF.res.code, f = c === "BAD_SECRET" ? $("cx-secret") : c === "IP_OR_KEY" || c === "BAD_KEY_FORMAT" ? $("cx-api") : $("cx-go");
  if (f) f.focus();
}
/* 雲端(S5):兩種都走主行程的 cloud-connect(金鑰只有這一條路;名字與形狀在主行程決定)。**不從這台電腦查 Binance**——
   白名單設成雲端 IP 的好金鑰從這裡查必定被拒;權限由雲端主機寫入前自己查。結果畫在框內那一格,框不關;
   成功才關框,onboard 換成「已存到、等回報」(ack 說的是金鑰寫進去了,帳戶讀不讀得到是下一份報告的事)。 */
async function cxConnectCloud() {
  const C = TR_BAGS.cloud;
  if (envCloudKind(C.st) !== "running") { cxModalPaint(); return; }
  C.cx = { busy: true, err: null, retest: false }; CXF.res = null; cxModalPaint();
  const venue = CXF.venue;
  let r = null;
  try { r = await window.blave.cloudConnect(venue === PAPER ? { venue: "paper" } : { venue, apiKey: CXF.apiKey, secret: CXF.secret, passphrase: CXF.passphrase }); } catch (_) { }
  C.cx.busy = false;
  if ($("cx-scrim").hidden || CXF.env !== "cloud") { cxForget(); return; }   // 等的時候用戶關了框:結果不上畫面(寫進去的話下一份報告會帶出已連接)
  if (r && r.ok) {
    cxForget();
    C.cxSaved = { venue, code: r.code, detail: r.detail || {}, at: Date.now() };
    ENV.burst = trBurstBump(ENV.burst, Date.now(), TR_BURST_MS, TR_BURST_MAX_MS);   // S5 那段等待同一種形狀:連上之後等主機把交易所帶進回報
    // 模擬:直接講已連接(畫面已經是下單設定的骨架);真實交易所講已存、正在等主機確認
    srSay(venue === PAPER ? t("cx.connected") : (venue === BINANCE ? t("tr.cloud.cxSavedBn") : t("tr.cloud.cxSavedV", { venue: trVenueLabel(venue, true) })) + " " + t("tr.cloud.cxWaiting"));
    C.sig = {}; cxModalClose(true); trPaint(); trPollSoon(1500);
    return;
  }
  CXF.res = r && typeof r.code === "string" ? r : { code: "UNKNOWN", detail: {} };
  if (CXF.res.code === "BAD_SECRET") CXF.secret = "";
  srSay(cxChkText(CXF.res));
  C.sig.cxm = null; cxModalPaint();
  const c = CXF.res.code, f = c === "BAD_SECRET" ? $("cx-secret") : c === "IP_OR_KEY" || c === "BAD_KEY_FORMAT" ? $("cx-api") : $("cx-go");
  if (f) f.focus();
}
async function cxConnect() {
  if (CXF.venue === CAPITAL) { if (CXF.env === "cloud" && ENV.cur === "cloud" && !$("cx-scrim").hidden) return capPrimary(); return; }
  if (CXF.venue === "president") { if (CXF.env === "local" && ENV.cur === "local" && !$("cx-scrim").hidden) return presPrimary(); return; }
  if (CXF.env === "cloud") { if (!TR_BAGS.cloud.cx.busy && !$("cx-scrim").hidden && ENV.cur === "cloud") return cxConnectCloud(); return; }
  const L = TR_BAGS.local;
  if (L.cx.busy || ENV.cur !== "local" || $("cx-scrim").hidden) return;
  if (CXF.venue === BINANCE) return cxConnectBinance();
  if (CXF.venue !== PAPER) return cxConnectVenue();
  L.cx = { busy: true, err: null, retest: false }; cxModalPaint();
  // 模擬交易的綁定:同雲端,寫一組固定值的 PAPER_* 進 workspace 的 .env(不是金鑰,是「已啟用」的記號)
  const res = await L.api.tradeSend("credentials", { env: { PAPER_API_KEY: "paper", PAPER_SECRET_KEY: "paper", PAPER_BOUND_TS: String(Math.floor(Date.now() / 1000)) } });
  L.cx.busy = false;
  if (!res || !res.ok) { L.cx.err = cxSendFail(res); srSay(L.cx.err); cxModalPaint(); return; }
  return cxConnected();
}
/* OKX / BingX / Gate.io / Bybit 綁在這台電腦:金鑰交給主行程(venue-connect)送 daemon。runtime 寫入前先用那一家的
   lib/account_* 讀一次帳戶(_local_real_key_gate),讀不到就不寫——所以回來 ok = 讀得到帳戶(交易權限要到下單才確認,字照實講);
   不 ok = 沒有儲存,照那一家的原因講、框留著 */
async function cxConnectVenue() {
  const L = TR_BAGS.local, venue = CXF.venue;
  L.cx = { busy: true, err: null, retest: false }; CXF.res = null; cxModalPaint();
  let r = null; try { r = await window.blave.venueConnect({ venue, apiKey: CXF.apiKey, secret: CXF.secret, passphrase: CXF.passphrase }); } catch (_) { }
  L.cx.busy = false;
  if ($("cx-scrim").hidden || CXF.env !== "local" || CXF.venue !== venue) { cxForget(); return; }   // 等的時候關了框 / 換了一家:結果不上畫面
  if (r && r.ok) {
    cxForget();
    L.api.tradeSend("retest_accounts", {}).catch(() => {});   // 帳戶讀取器馬上讀一輪:設定分頁不用等下一個週期
    return cxConnected(t("cx.linkOk"));
  }
  CXF.res = r && typeof r.code === "string" ? r : { code: "SEND_FAILED", detail: {} };
  srSay(cxChkText(CXF.res)); L.sig.cxm = null; cxModalPaint();
  const c = CXF.res.code, f = c === "BAD_KEY_FORMAT" || c === "INCOMPLETE_PAIR" || c === "REJECTED" ? $("cx-api") : $("cx-go"); if (f) f.focus();
}
/* 灰句(可能還在查)期間輪詢的報告出現了這一家 → 金鑰其實存了、帳戶也讀到了:走 ok 那條路關框。
   不關的話框裡說「可能還在查」、底下帳戶列已經「已連接」是兩套話(spec-desktop-006 §1.3 C)。每輪 trPoll 叫一次 */
function cxGateSlowSync() {
  if ($("cx-scrim").hidden || CXF.env !== "local" || !cxGateSlow(CXF.res)) return;
  const L = TR_BAGS.local;
  if (trVenueIds(L.st && L.st.report).indexOf(CXF.venue) < 0) return;
  // 先關框(連同清金鑰):cxConnected 要等 tradeStatus 回來才關,中間 trPoll 的 cxModalPaint 會把框畫回閒置表單閃一下
  cxModalClose(true); cxConnected(t("cx.linkOk"));
}
async function cxRetest() {
  const S = TR, cloud = S.env === "cloud";   // 吃當下那一袋:雲端的重新測試走雲端指令
  if (S.cx.retest || ENV.cur !== S.env) return;
  S.cx = { busy: false, err: null, retest: true }; S.sig.set = null; trPaint();
  const res = cloud ? await trSend(S, "retest_accounts", {}) : await S.api.tradeSend("retest_accounts", {});
  // Binance:帳戶讀取之外,金鑰的權限與白名單也重查一次(用戶自己按的:結果直接上畫面,不發系統通知)。
  // 雲端沒有這一半:那把金鑰 app 不重查
  if (!cloud && trVenueId() === BINANCE && typeof window.blave.binanceRecheck === "function") try { CXF.bn = await window.blave.binanceRecheck(); } catch (_) { }   // 結果由推送補
  S.cx.retest = false;
  if (!res || !res.ok) { S.cx.err = cloud ? trSendError(res, "retest", "cloud") : cxSendFail(res); srSay(S.cx.err); }
  else if (cloud) S.cxPend = { what: "retest", at: Date.now() };   // 等帳戶讀取時間比送出時間新
  S.sig.set = null; trPaint(); trPollSoon(1500);
}

/* ── 選擇下單策略的框(#ps-scrim;spec-desktop-strategy-picker,照雲端工作頁 psOpen / psApply)────────────
   殼同 cx 框(.scrim > .set-modal);兩個視角共用,雲端視角 head 灰底 + 「雲端」記號 + 鈕上方目的地行(這個框的「確定」會寫主機設定檔)。
   候選集合在開框時算一次,框開著不隨輪詢重建(打勾到一半被洗掉比名單慢幾秒更糟)。
   Esc 與 Tab 圈都在這裡自己接(app.js 的 escTop / trapTab 不動):escTop 沒認得這個框時回 null、不會 preventDefault,
   這裡就補上;它先關了別層(defaultPrevented)這裡就不再關第二層。 */
let psOpener = null;
function psWire() {
  $("ps-cancel").addEventListener("click", () => psClose());
  $("ps-close").addEventListener("click", () => psClose());
  $("ps-ok").addEventListener("click", psApply);
  $("ps-scrim").addEventListener("mousedown", (e) => { if (e.target === $("ps-scrim")) psClose(); });
  $("ps-scrim").addEventListener("keydown", psTrap);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.isComposing || e.keyCode === 229 || e.defaultPrevented || $("ps-scrim").hidden) return;
    e.preventDefault(); psClose();
  });
}
// 焦點圈在框裡(同 app.js trapTab,但 checkbox 也算——那支只抓 button / select)
function psTrap(e) {
  if (e.key !== "Tab") return;
  const f = [...$("ps-modal").querySelectorAll("button, input")].filter((x) => !x.disabled && x.offsetParent);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
// 原因句(.ps-note)是勾選框的 aria-describedby;它本身 aria-hidden,不然包在 label 裡會先被併進名稱、再當描述念第二次。i = 列序,只拿來拼唯一 id
function psRow(r, cloud, i) {
  const row = trEl("label", "ps-row" + (r.locked ? " is-locked" : "")), cb = trEl("input", "ps-cb");
  cb.type = "checkbox"; cb.value = r.name; cb.checked = r.checked; cb.disabled = r.locked;
  const nm = trEl("span", "ps-name", r.display);
  if (r.gone) nm.appendChild(trEl("span", "ps-gone", t("tr.pick.gone")));
  let note = null;
  if (r.note === "twd" || r.note === "twdKeep") note = nm.appendChild(trEl("span", "ps-note", r.note === "twd" ? t("tr.pick.twd") : t("tr.pick.twdKeep")));
  else if (r.note === "txf" || r.note === "txfKeep") note = nm.appendChild(trEl("span", "ps-note", r.note === "txf" ? t("tr.pick.txf") : t("tr.pick.txfKeep")));
  else if (r.locked) note = nm.appendChild(trEl("span", "ps-note", cloud ? t("tr.typeCHost") : t("tr.typeC")));
  if (note) { note.id = "ps-why-" + i; note.setAttribute("aria-hidden", "true"); cb.setAttribute("aria-describedby", note.id); }
  row.append(cb, nm); return row;
}
function psOpen(opener) {
  const S = TR;
  if (S !== TR_BAGS[ENV.cur] || !$("ps-scrim").hidden || trPickOff()) return;
  trackFeature("strategy_picker");
  const cloud = S.env === "cloud", names = trNames();
  const rows = trPickRows(S.list, names, (trReport() || {}).can_trade_portfolio === true, trVenueId() === PAPER, trVenueId() === "president");
  psOpener = opener || null;
  $("ps-modal").querySelector(".modal-head").classList.toggle("cloud", cloud);
  $("ps-env").hidden = !cloud; $("ps-env").textContent = cloud ? t("env.cloud") : "";
  $("ps-where").hidden = !cloud;
  $("ps-where").textContent = cloud ? trWhereTidy(t("tr.cloud.footWhere", { where: t("env.cloud"), money: envMoneyText(envMoney(S.st)), venue: trVenueLabel(trVenueId(), true) })) : "";
  const list = $("ps-list"); list.textContent = "";
  if (!rows.length) list.appendChild(trEl("div", "pf-state", t("tr.pick.empty")));
  else rows.forEach((r, i) => list.appendChild(psRow(r, cloud, i)));
  // 投資組合策略被鎖(機器的 lib 太舊):清單底下一行 + 更新出口,幾支都只出一行(order-copy #12)。
  // 這台電腦 = 設定 › 一般、焦點在「檢查更新」;雲端 = 同一個「更新雲端主機」動作(自動下單可能在跑就先問;不經雲端 agent,走既有的更新例外)
  if (rows.some((r) => r.note === "typeC")) {
    const p = trEl("p", "ps-next", (cloud ? t("tr.typeCNextHost") : t("tr.typeCNext")) + " "), b = trEl("button", "btn-quiet", cloud ? t("up.cloud.go") : t("minv.btn"));
    b.type = "button";
    b.addEventListener("click", () => { const o = psOpener; psClose(); if (cloud) upCloudUpdate(o); else setOpen().then(() => { setCat("display"); const u = $("set-up-btn"); if (u && !u.hidden) u.focus(); }); });
    p.appendChild(b); list.appendChild(p);
  }
  $("view-ws").inert = true;
  const sc = $("ps-scrim"); sc.hidden = false;
  requestAnimationFrame(() => sc.classList.add("open"));
  const first = list.querySelector(".ps-cb:not(:disabled)");
  (first || $("ps-cancel")).focus();
}
function psClose() {
  const sc = $("ps-scrim"); if (sc.hidden) return;
  sc.classList.remove("open"); sc.hidden = true; $("view-ws").inert = false;
  const o = psOpener; psOpener = null;
  if (o && o.isConnected && !o.disabled) o.focus(); else psRefocus();
}
// 確定之後表重畫、開框那顆鈕已經是新的一顆:焦點落回它;沒有(讀不到設定那一態鈕停用)就退到分頁鈕,不能掉到 BODY
function psRefocus() { const b = $("tr-pick"); if (b && b.isConnected && !b.disabled) b.focus(); else $("tr-tab-pos").focus(); }
/* 「確定」(picker §6):勾的集合成為 picked、表只列這些;$0 的加 / 減立刻送一份 amounts(不開確認框——$0 不會下單、也不會平倉);
   有錢的移除只 stage(表上那列消失、儲存列出現,按「儲存」的確認框講會平倉)。走跟儲存同一條送出路。 */
async function psApply() {
  const S = TR, cloud = S.env === "cloud";
  const sel = new Set([...$("ps-list").querySelectorAll(".ps-cb")].filter((c) => c.checked).map((c) => c.value));
  psClose();
  const mine = () => TR === S && S.open && S.tab === "pos";
  // 框開著期間報告變成 config: null / 讀不到設定:底稿已不可信,關框、什麼都不送(儲存列那句由 trAmountTable 講)
  if (trStored() === null || trCfgUnread(trReport())) { S.sig.pos = null; if (mine()) trPaintPos(); psRefocus(); return; }
  const stored = trBase() || {};
  S.picked = trSetEq(sel, trNamesOf(null)) ? null : sel;   // 跟已存的一模一樣 = 沒改:stored 照舊是真相
  const ch = trPickApply(sel, stored, trPickKeep(S.env, sel, stored, trListNames()));
  S.sig.pos = null; if (mine()) trPaintPos();
  if (!ch) { psRefocus(); return; }
  // 呼吸點:新加的立刻亮、$0 移出的立刻熄(同雲端 pfJustPicked / pfJustRemoved)
  envJustMark(S.just, stored, ch.amounts, Date.now());
  if (!cloud) envPaintLocalDots(); else ENV.sig.side = null;
  S.save = "saving"; S.saveErr = null; S.sig.pos = null; if (mine()) trPaintPos();
  if (cloud) { const key = trAmountsKey(ch.amounts); if (S.reqFor.amounts !== key) delete S.reqIds.amounts; S.reqFor.amounts = key; }
  const res = cloud ? await trSend(S, "amounts", { amounts: ch.amounts }) : await S.api.tradeSend("amounts", { amounts: ch.amounts });
  clearTimeout(S.saveTimer);
  if (res && res.ok && cloud) {
    // 同 trSaveAmounts:ack ok = 主機已寫進設定檔,新加那列的 0 帶 .pend、儲存列講存好了等回報。打到一半的金額留著(這一份沒帶它們)
    const rc = S.st && S.st.cloud;
    S.save = "sent"; S.sent = ch.amounts; S.sentAt = Date.now(); S.sentRep = rc && typeof rc.reported_at === "number" ? rc.reported_at : null; S.saveUnknownAt = 0;
    srSay(t("tr.cloud.pendAmounts"));
  } else if (res && res.ok) S.save = null;   // 這台電腦:沒有金額變動,不出「已儲存」那行(講「已套用新金額」是假話)
  else {
    // 失敗:儲存列出錯誤,表上的列不退回(照雲端)——用戶填金額按儲存時整份會再送一次,那一份就包含它
    S.save = "failed"; S.saveErr = trSendError(res, "save", S.env); srSay(S.saveErr);
    S.saveUnknownAt = cloud && trKindOf(res) === "unknown" ? Date.now() : 0;
  }
  S.sig.pos = null;
  try { S.st = await S.api.tradeStatus(); } catch (_) { }
  if (mine()) { trPaintPos(); psRefocus(); }
  trPollSoon(1500);
}

/* ── 視角:「這台電腦｜雲端」切換器、頂列灰底、雲端側欄、雲端空態(spec-desktop-local-and-cloud §1–§4.1)────────
   除了切換器、⌘1/⌘2 與畫面上的文字鈕,沒有任何東西會自己切視角;重開 app 一律回到這台電腦(雲端可能是真錢,開場不該落在那裡)。
   雲端來的字串(策略名)一律 textContent。 */
function envWire() {
  // 切視角的三個入口(切換器、⌘1/⌘2、app 選單「顯示」)都走 envSwitchGuarded:守門規則只有一份
  $("envsw").addEventListener("click", (e) => { const b = e.target.closest("button[data-env]"); if (b) envSwitchGuarded(b.dataset.env); });
  // ⌘1 / ⌘2:輸入框有焦點時也生效;確認框、圖片放大開著時不生效(先讓人處理眼前那個框),設定開著可以
  document.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;   // 輸入法組字中:不搶(搬焦點會把組到一半的字提交或丟掉)
    if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || (e.key !== "1" && e.key !== "2")) return;
    if (envSwitchGuarded(e.key === "1" ? "local" : "cloud")) e.preventDefault();
  });
  if (typeof window.blave.onEnvSwitch === "function") window.blave.onEnvSwitch((env) => { envSwitchGuarded(env); });
  // 主行程說雲端那邊變了(另一邊出事、登入登出):下一輪就去拿新的那一份
  if (typeof window.blave.onCloudState === "function") window.blave.onCloudState(() => { ENV.cloudDirty = true; trPollSoon(0); });
  document.documentElement.dataset.env = "local";
}
/* 現在能不能切視角:還沒進工作頁不行;確認框、連接交易所的框、圖片放大開著不行(先讓人處理眼前那個框)。
   設定開著可以(envSwitch 自己不搬焦點)。回 true = 有切(或本來就在那一邊)。 */
// 組字中不切:app 選單有了 ⌘1/⌘2 之後 macOS 先讓選單吃鍵,keydown 上的 isComposing 守門看不到那一次——
// 所以改成自己記「現在有沒有在組字」,三個入口(點、鍵、選單)都看它。切過去會搬焦點,組到一半的字會丟
let ENV_COMPOSING = false;
document.addEventListener("compositionstart", () => { ENV_COMPOSING = true; }, true);
document.addEventListener("compositionend", () => { ENV_COMPOSING = false; }, true);
// 開通頁看得見嗎(稽核 Q1):從這一頁按「綁卡」外開瀏覽器,回來要重查帳號狀態,不然畫面一直停在「綁卡」
function envOpenVisible() { return ENV.cur === "cloud" && !$("cv-empty").hidden; }
function envCanSwitch() { return !ENV_COMPOSING && !$("view-ws").hidden && $("del-scrim").hidden && $("cx-scrim").hidden && $("ps-scrim").hidden && $("lb-scrim").hidden && $("ns-scrim").hidden && $("idea-scrim").hidden && $("rpn-scrim").hidden && $("shr-scrim").hidden; }   // 兩個表單 modal(新增策略 / 新增報告)開著也不切:送出時才讀視角,切了會送去另一台;分享框同理(公開的是開框那一袋的那一份)
function envSwitchGuarded(env) {
  if ((env !== "local" && env !== "cloud") || !envCanSwitch()) return false;
  envSwitch(env); return true;
}
function envSwitch(env, via) {
  if (env !== "local" && env !== "cloud") return;
  const head = () => { const h = $("cv-empty").hidden ? $("tr-h") : $("cv-h"); if (h && h.offsetParent) h.focus(); };
  if (env === ENV.cur) { if (via === "link") head(); return; }
  if (env === "cloud") trackFeature("view_cloud");
  // 換了一邊 = 放棄「等著送上雲端」那個意圖(承重牆①:沒有 TTL,靠這條收斂)。
  // hoAsk 是切完才記 pending,所以它自己那一次切過去不會被這行洗掉
  if (typeof HO !== "undefined") HO.pending = null;
  // 報告頁首那句「送不上去」講的是按下去那一刻的事:離開又回來時它會讀起來像現況,離開就收掉
  if (env === "local" && typeof hoNote === "function") hoNote(null);
  // 順序(spec §1.4):關確認框(等同取消,焦點不回 opener)→ 存這一邊 → 換 → 畫 → 標題 → 播報
  // 關確認框這一行**目前走不到**:確認框開著時 ⌘1/⌘2 不生效、#view-ws 是 inert(切換器點不到)。留著當保險——
  // 批次 ② 選單列的「顯示」兩項進來之後,才有確認框開著也能切視角的入口。
  if (!$("del-scrim").hidden) { if (delCtx) delCtx.opener = null; delClose(false); }
  const from = TR_BAGS[ENV.cur], list = $(ENV.cur === "cloud" ? "strat-list-cloud" : "strat-list");
  from.scroll = { list: list.scrollTop, tab: from.tab && !$("tr-" + from.tab).hidden ? $("tr-" + from.tab).scrollTop : 0 };
  // 焦點在面板裡的輸入框時 trShould 會跳過重畫(打到一半不能被輪詢洗掉)——切視角不是輪詢:先放掉焦點,
  // 不然另一邊的金額表(含輸入框、儲存列)會留在這一邊的標題底下(稽核 N4)
  const ae = document.activeElement; if (ae && ae.tagName === "INPUT" && $("tr").contains(ae)) ae.blur();
  const prev = ENV.cur;
  ENV.cur = env; TR = TR_BAGS[env]; TR.sig = {}; ENV.sig = {};
  document.documentElement.dataset.env = env;
  if (env === "cloud") { ENV.cloudDirty = true; TR.open = true; }
  envShowMain();
  trPaint(); trAlertShow();
  if (TR.open && TR.tab && !$("tr-tabs").hidden) trSetTab(TR.tab);   // 分頁列是共用的 DOM:底線與 tabindex 換成這一邊的
  // 策略報告是共用的 DOM,兩邊各自選中一支:頁首與程式碼換成這一邊的;圖若是在看另一邊時畫的(容器藏著、量不到寬)也重畫一次
  rpRepaint();
  // 對話裡插一條「切到 …」系統行(A′ 四層標示的 ③;只在對話有內容時,連續切只留最後一條)
  chatSwitched(prev, env);
  // 每邊各自的捲動位置(面板是共用的 DOM,剛重畫完)
  const to = $(env === "cloud" ? "strat-list-cloud" : "strat-list"); to.scrollTop = (TR.scroll && TR.scroll.list) || 0;
  if (TR.open && TR.tab && !$("tr-" + TR.tab).hidden) $("tr-" + TR.tab).scrollTop = (TR.scroll && TR.scroll.tab) || 0;
  // 動效:側欄與中欄內容淡入,無位移(prefers-reduced-motion 時 CSS 直接換)
  document.querySelectorAll(".pane-strategies, .pane-main").forEach((n) => { n.classList.remove("env-fade"); void n.offsetWidth; n.classList.add("env-fade"); });
  srSay(envName(env));
  // 設定開著時不搬焦點(稽核 N3):切換器在遮罩後面,焦點過去之後 Esc 關不掉設定、Tab 在遮罩後面走
  if (!$("set-scrim").hidden) { /* noop */ }
  else if (via === "link") head(); else $("env-" + env).focus();   // 鍵盤使用者可以馬上切回
  trPollSoon(0);
}
/* 中欄誰該出現(兩邊各自的狀態不動,切回來原樣)。這台電腦:自動下單 / 策略報告 / welcome 三選一。
   雲端:自動下單 / 雲端那支策略的報告(#rp 是共用的 DOM,資料來自 app.js 的 RPC 那一袋);沒有主機可看(開通頁 #cv-empty 開著)時兩個都收。
   雲端沒有 welcome——沒選策略就是自動下單頁。 */
function envShowMain() {
  const cloud = ENV.cur === "cloud";
  if (cloud) {
    const gate = !$("cv-empty").hidden, rp = !gate && typeof RPC !== "undefined" && !!(RPC.name && RPC.data);
    $("rp").hidden = !rp; $("main-empty").hidden = true; $("tr").hidden = gate || rp;
    if (rp) $("tr-nav").removeAttribute("aria-current"); else $("tr-nav").setAttribute("aria-current", "page");
    if (typeof libShowMain === "function") libShowMain(gate);   // 策略庫(第五個視圖)開著就蓋掉上面那幾個;開通頁開著時跟側欄入口一起收
    if (typeof rptShowMain === "function") rptShowMain(gate);   // 報告(第六個視圖;renderer/reports.js)同一條
    return;
  }
  const L = TR_BAGS.local, rp = !L.open && !!(RP.name && RP.data);
  $("rp").hidden = !rp;
  $("main-empty").hidden = L.open || rp;
  $("tr").hidden = !L.open; if (L.open) $("tr-nav").setAttribute("aria-current", "page"); else $("tr-nav").removeAttribute("aria-current");
  if (typeof libShowMain === "function") libShowMain(false);
  if (typeof rptShowMain === "function") rptShowMain(false);
}
/* 側欄已選中的那一項再點一次(Wei 09-28)。瀏覽器展開層蓋著中欄時,人眼前看到的是展開層、不是那一頁:這一下先收展開層、露出那一頁
   (那一頁本來就開著,MutationObserver 看不到「新畫面冒出來」,不收就永遠沒反應)。沒蓋著才 leave() 收掉那一頁,
   由 envShowMain 落到這一邊的預設畫面(這台電腦 = welcome,雲端 = 自動下單頁)。守門同切視角:框開著 / 組字中不動 */
function sideReclick(leave) {
  if (!envCanSwitch()) return;
  if (typeof BR !== "undefined" && BR.exp && BR.bw && !BR.bw.hidden) { brCollapse(true); return; }
  leave(); envShowMain();
}
/* 每一輪都叫(trPaint 的第一步):切換器兩格、側欄、視窗標題、雲端空態。回 false = 中欄現在是雲端空態,自動下單頁不必畫。
   每一塊都有自己的指紋,沒變就不碰 DOM(焦點與 hover 不被輪詢洗掉)。 */
/* 側欄雲端列尾:「可能仍在下單」是整台雲端的事、字又長(1024 寬時把名字吃到只剩一個字),改成切換器那個紅短劃,
   完整的字放 title 與 aria-label(新狀態稽核 2-1)。其他詞夠短,照舊寫字 */
function envRowMark(w) {
  if (w !== "tr.cloud.mayTrade") return trEl("span", "stx", t(w));
  const m = trEl("span", "dot bad"); m.setAttribute("role", "img"); m.setAttribute("aria-label", t(w)); m.title = t(w);
  return m;
}
/* 呼吸點放在名字 span 裡面最前面(同網頁:名字是 ellipsis 的那一格,放外面會被擠成獨立一格);裝飾,讀屏不唸 */
function envDotInto(nm, on) {
  let d = nm.querySelector(".run-dot");
  if (!on) { if (d) d.remove(); return; }
  if (!d) { d = trEl("span", "run-dot live"); d.setAttribute("aria-hidden", "true"); nm.insertBefore(d, nm.firstChild); }
}
// 這台電腦的側欄(app.js stratRefresh 建的列):每輪狀態回來、清單重建後各畫一次
function envPaintLocalDots() {
  const st = TR_BAGS.local.st, now = Date.now();
  const L = TR_BAGS.local, up = envDotsUp("local", st);
  $("strat-list").querySelectorAll(".strat-row").forEach((b) => { const nm = b.querySelector(".strat-name"); if (nm) envDotInto(nm, up && envRunDot(b.dataset.name, st, now, L.just)); });
}
function envPaint() {
  const cloud = ENV.cur === "cloud", C = TR_BAGS.cloud, kind = envCloudKind(C.st);
  // 雲端金額只在送出中那幾秒算在途(S4 §3.1):存完等回報那段主機在正常下單,不能讓綠點消失好幾分鐘
  const cells = { local: envCell("local", TR_BAGS.local.st, !!TR_BAGS.local.pending), cloud: envCell("cloud", C.st, !!C.pending || C.save === "saving") };
  ["local", "cloud"].forEach((env) => envPaintCell(env, cells[env]));
  // 側欄
  const pid = typeof hoPendingId === "function" ? hoPendingId() : null;
  /* 雲端通了、但還有一支在等著送上來 → 中欄**不放行**到自動下單頁:留在 #cv-empty,換成「準備好了」卡(規格 §2)。
     用 kind === "running" 判,**不可以**用 hoCloudLive():後者多要求「1 小時內同步過」,
     於是「running 但讀不到」那一態 gate 會是 false、卡不出現、人照樣掉在自動下單頁——正是要修的那一格 */
  const ready = cloud && kind === "running" && !!pid;
  const gate = (cloud && kind !== "running" && kind !== "stopped") || ready;
  $("side-nav").hidden = gate; $("strat-head").hidden = gate;
  /* 側欄那一句只留「準備好了」那一態(有策略正等著送上來)。沒有主機 / 啟動中 / 讀不到那幾態不再寫字(Wei 09-23):
     中欄的 #cv-empty 已經逐態講了同一件事(還沒有雲端主機 / 啟動中約 1 分鐘 / 讀不到狀態),側欄再講一次是重複 */
  const sg = $("side-gate"); sg.hidden = !ready;
  if (ready && sg.dataset.i18n !== "side.cloud.emptyReady") { sg.dataset.i18n = "side.cloud.emptyReady"; sg.textContent = t("side.cloud.emptyReady"); }
  $("strat-list").hidden = cloud; $("strat-list-cloud").hidden = !cloud || gate;
  // 雲端視角的 placeholder。走 dataset:換語言時 applyStatic 會照 data-i18n-ph 重填
  const phKey = cloud ? "chat.ph.cloud" : "ws.placeholder";
  if (ENV.sig.ph !== phKey) { ENV.sig.ph = phKey; $("ta").dataset.i18nPh = phKey; $("ta").placeholder = t(phKey); }
  if (cloud) envPaintSide(kind, C.st);
  const cur = cells[ENV.cur];
  // 視窗標題:{money} 槽放的是交易所名 / 「模擬」(Wei 0.0.6);是空的就連同前面的「 · 」一起省略
  const money = envVenueText(cur.money, cur.venue);
  document.title = money ? t("env.winTitle", { where: envName(ENV.cur), money }) : t("env.winTitle0", { where: envName(ENV.cur) });
  // 中欄
  $("cv-empty").hidden = !gate;
  if (gate) { envShowMain(); $("tr-tb-txt").textContent = ""; ENV.sig.tb = null; $("tr-tb-mode").hidden = true; envPaintEmpty(kind, pid); return false; }
  if (cloud) { TR.open = true; envShowMain(); }
  return true;
}
const ENV_ICONS = {   // lucide monitor / cloud(寫死的常數,不吃任何外來資料)
  local: ["M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M8 21h8", "M12 17v4"],
  cloud: ["M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"],
};
function envIcon(env) {
  const NS = "http://www.w3.org/2000/svg", svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "envsw-ic"); svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
  for (const d of ENV_ICONS[env]) { const p = document.createElementNS(NS, "path"); p.setAttribute("d", d); svg.appendChild(p); }
  return svg;
}
function envPaintCell(env, c) {
  const b = $("env-" + env), on = ENV.cur === env;
  // 看過才消:現在看得見的那一邊 = 看過了;同一件事(sig)之後不再亮紅記號。只消記號,狀態詞留著
  if (c.sig && on) ENV.seen[env] = c.sig;
  if (!c.sig) delete ENV.seen[env];
  const mark = envCellMark(c, ENV.seen[env]), w = envCellWords(c);
  const sig = LANG + "|" + JSON.stringify([c, on, mark]);
  if (ENV.cells[env] === sig) return;
  const first = ENV.cells[env] == null; ENV.cells[env] = sig;
  b.setAttribute("aria-pressed", on ? "true" : "false");
  // 格內 = 圖示 + 至多一個記號(格寬固定 40,不會忽寬忽窄)。名字、錢記號、狀態詞都在 title 與 aria-label:
  // 另一邊的事靠它們讀得到;看得見的這一邊另外寫在切換器右邊那一句
  b.textContent = ""; b.appendChild(envIcon(env));
  if (mark) { const d = trEl("i", mark === "run" ? "run-dot live" : "dot " + mark); d.setAttribute("aria-hidden", "true"); b.appendChild(d); }
  const money = w.money ? envMoneyText(c.money) : "", state = w.state ? t(w.state) : "";
  const where = envName(env), tip = money && state ? t("env.tip", { where, money, state }) : money || state ? t("env.tip1", { where, x: money || state }) : where;
  // 快捷鍵由程式接、不進譯文;只接在 title。讀屏會把符號唸出來,所以 aria-label 不接,改用 aria-keyshortcuts
  b.title = tip + "  " + (env === "cloud" ? "\u23182" : "\u23181");
  b.setAttribute("aria-label", tip); b.setAttribute("aria-keyshortcuts", env === "cloud" ? "Meta+2" : "Meta+1");
  // 狀態詞變了播報一次(例:「雲端：已自動暫停」);第一次畫不算變化
  const word = c.word ? t(c.word) : "";
  if (!first && word && ENV.said[env] !== word) srSay(t("env.cellAria1", { where: envName(env), x: word }));
  ENV.said[env] = word;
}
/* ── 雲端策略的刪除(spec-desktop-cloud-strategy-row-delete-pullback §1–§3)──────────────
   刪雲端是機器端直接移除檔案、救不回來 → 開確認框(本機是進垃圾桶,列內兩段式;分界只有「可不可逆」)。
   CDEL.gone:已刪、清單還沒跟上的(壓抑到清單不再有它或 60 秒,不然列會「長回來」);
   CDEL.busy:送出中 / 結果不明的那幾支(列顯示「刪除中…」、不畫 ✕)。request_id 以「指令+名字」為單位記,兩支並刪不會併成一趟。 */
const CDEL = { gone: new Map(), busy: new Map(), ids: {} };
const CDEL_HOLD_MS = 60000;
// 這支策略還在雲端下單設定的組合裡嗎。規則同機器端 `_cmd_delete_strategy`:amounts / weights / exchanges 的 key 聯集,金額 0 也算。
// config 讀不到(null / 沒有)→ null:不預判,交給機器裁決
function cdelInUse(cfg, name) {
  if (!cfg || typeof cfg !== "object") return null;
  return ["amounts", "weights", "exchanges"].some((k) => cfg[k] && typeof cfg[k] === "object" && Object.prototype.hasOwnProperty.call(cfg[k], name));
}
// 清單更新了:已經不在的就放掉壓抑;逾時的也放掉(結果不明那幾支回到原樣)
function cdelPrune(names, now) {
  for (const [n, at] of CDEL.gone) if (names.indexOf(n) < 0 || now - at > CDEL_HOLD_MS) CDEL.gone.delete(n);
  for (const [n, b] of CDEL.busy) if (b.state === "unknown" && (names.indexOf(n) < 0 || now - b.at > CDEL_HOLD_MS)) { CDEL.busy.delete(n); delete CDEL.ids[n]; }
}
function cdelTitle(x) { return t("cdel.title", { name: String(x.displayName || x.name).slice(0, 40) }); }
function cdelAsk(x, opener) {
  const C = TR_BAGS.cloud, cfg = C.st && C.st.report ? C.st.report.config : null;
  if (cdelInUse(cfg, x.name) === true) return cdelBlocked(x, opener);
  confirmBox({ title: cdelTitle(x), lines: [t("cdel.body"), t("cdel.only")], ok: t("del.ok"), opener, env: "cloud", onOk: () => cdelRun(x, opener) });
  $("del-title").title = String(x.displayName || x.name);
}
function cdelBlocked(x, opener) {
  const p = trEl("p", "cf-block", t("cdel.inUse"));
  confirmBox({ title: cdelTitle(x), lines: [], extra: p, ok: t("del.ok"), okDisabled: true, opener, env: "cloud",
    alt: { label: t("cdel.goPos"), onOk: () => trOpen("pos") }, onOk: () => {} });
}
// 結果的框開不起來(別的框開著、組字中、人已經切回這台電腦):不排隊、不搶焦點——寫進雲端那一份的紅字槽並唸出來
function cdelTell(text, box) {
  if (ENV.cur === "cloud" && envCanSwitch()) { box(); return; }
  trAlert(text, null, TR_BAGS.cloud); srSay(text);
}
async function cdelRun(x, opener) {
  const S = TR_BAGS.cloud, name = x.name;
  if (CDEL.busy.has(name)) return;
  CDEL.busy.set(name, { state: "sending", at: Date.now() }); ENV.sig.side = null; trPaint();
  // ✕ 在刪除中不畫:框關掉時焦點回到它、它又被重畫掉 → 焦點給同一列的 .strat-row,不掉到 BODY
  const ae = document.activeElement; if (!ae || ae === document.body || !ae.isConnected) { const r = cdelRowBtn(name, null); if (r) r.focus(); }
  srSay(t("cdel.sayPending", { name: x.displayName || name }));
  const res = await S.api.tradeSend("delete_strategy", { name }, CDEL.ids[name] || null);
  const k = trKindOf(res);
  if (res && res.ok && /=absent$/.test(String(res.result || ""))) {
    // 主機上本來就沒有這支(清單是 api 的索引,可能比主機舊):不假裝刪了什麼,講明;列交給下一份清單決定
    delete CDEL.ids[name]; CDEL.busy.delete(name); ENV.sig.side = null; trPaint();
    return cdelTell(t("cdel.absent"), () => confirmBox({ title: cdelTitle(x), lines: [t("cdel.absent")], ok: t("cdel.gotIt"), opener: cdelRowBtn(name, opener), env: "cloud", single: true, onOk: () => {} }));
  }
  if (res && res.ok) {
    delete CDEL.ids[name]; CDEL.busy.delete(name); CDEL.gone.set(name, Date.now());
    const wasHere = !!document.activeElement && !!document.activeElement.closest && !!document.activeElement.closest('.strat-wrap[data-name="' + name + '"]');
    const rows = [...$("strat-list-cloud").querySelectorAll(".strat-wrap")], at = rows.findIndex((w) => w.dataset.name === name);
    const next = at >= 0 ? rows[at + 1] || rows[at - 1] : null;
    if (typeof RPC !== "undefined" && RPC.name === name && typeof rpCloudSelect === "function") rpCloudSelect(null);
    ENV.sig.side = null; trPaint();
    srSay(t("cdel.sayDone", { name: x.displayName || name }));
    if (wasHere) { const n = next && $("strat-list-cloud").querySelector('.strat-wrap[data-name="' + next.dataset.name + '"] .strat-row'); if (n) n.focus(); else $("tr-nav").focus(); }
    return;
  }
  if (k === "unknown") {
    // 可能已經刪了:維持「刪除中…」,等清單更新或壓抑窗到期;request_id 留著(同一個意圖)
    if (res && typeof res.requestId === "string") CDEL.ids[name] = res.requestId;
    CDEL.busy.set(name, { state: "unknown", at: Date.now() }); ENV.sig.side = null; trPaint();
    return cdelTell(t("cdel.unknown"), () => confirmBox({ title: cdelTitle(x), lines: [t("cdel.unknown")], ok: t("cdel.gotIt"), opener: cdelRowBtn(name, opener), env: "cloud", single: true, onOk: () => {} }));
  }
  CDEL.busy.delete(name); ENV.sig.side = null; trPaint();
  const back = cdelRowBtn(name, opener);
  if (k === "rejected") {
    delete CDEL.ids[name];   // 機器已經判過:再試是新的意圖
    const err = String((res && res.error) || "");
    if (/remove it there first/.test(err)) return cdelTell(t("cdel.inUse"), () => cdelBlocked(x, back));
    const p = trEl("p", "cf-block", t("cdel.rejected", { err: err.slice(0, 200) }));
    return cdelTell(t("cdel.rejected", { err: err.slice(0, 200) }), () => confirmBox({ title: cdelTitle(x), lines: [], extra: cdelBoth(p, t("cdel.rejectedHint")), ok: t("cdel.retry"), opener: back, env: "cloud", onOk: () => cdelRun(x, back) }));
  }
  // 沒送到:再試一次沿用同一顆 request_id(api 可能其實收到了,不能讓同一個動作變兩次)
  if (res && typeof res.requestId === "string") CDEL.ids[name] = res.requestId;
  const p = trEl("p", "cf-block", t("cdel.failed"));
  cdelTell(t("cdel.failed"), () => confirmBox({ title: cdelTitle(x), lines: [], extra: cdelBoth(p, t("cdel.failedHint")), ok: t("cdel.retry"), opener: back, env: "cloud", onOk: () => cdelRun(x, back) }));
}
function cdelBoth(block, hint) { const f = document.createDocumentFragment(); f.append(block, trEl("p", "", hint)); return f; }
// 框關掉之後焦點回到哪:那一列的 .strat-row(✕ 在刪除中會藏起來);列不在了就回原本的 opener
function cdelRowBtn(name, fallback) { const r = $("strat-list-cloud").querySelector('.strat-wrap[data-name="' + name + '"] .strat-row'); return r || fallback; }

function envPaintSide(kind, st) {
  // 側欄頂不寫「雲端 / 這台電腦」(Wei:最上面的切換器已經有了);這裡只畫雲端那幾份策略
  const all = kind === "running" || kind === "stopped" ? envCloudList(st) : [];
  cdelPrune(all.map((x) => x.name), Date.now());
  const list = all.filter((x) => !CDEL.gone.has(x.name));   // 已刪、清單還沒跟上的先不畫
  const ho = typeof HO !== "undefined" && HO.on && typeof hoCloudLive === "function" && hoCloudLive();
  // 列尾的刪除:機器停著 / agent 回合中 / 名字不合規 / 刪除中 → 不畫(跟 HO 旗標無關)
  const canDel = kind === "running" && !(typeof running !== "undefined" && running === true);
  // 側欄**不放任何 handoff 提示**(Wei 看實機後拍板):等著送上來的那條回頭路住在中欄的「準備好了」卡(規格 §2)
  const sel = typeof RPC !== "undefined" ? RPC.name : null, dotsUp = envDotsUp("cloud", st);
  const sig = LANG + "|" + JSON.stringify([kind, ho, canDel, sel, [...CDEL.busy.keys()], list.map((x) => [x.name, x.displayName, envStratWord(x.name, st), dotsUp && envRunDot(x.name, st, Date.now(), TR_BAGS.cloud.just)])]);
  if (ENV.sig.side === sig) return;
  ENV.sig.side = sig;
  // 點一支 → 中欄畫雲端那一份的報告(app.js 的 rpCloudSelect;資料走主行程的 cloudStrategy)。鈕不能包鈕,刪除鈕放在同一個 wrap 裡(同本機清單)
  const box = $("strat-list-cloud"); box.textContent = ""; box.removeAttribute("role");
  if (!list.length) { box.appendChild(trEl("p", "pf-state", ho ? t("ho.emptyHint") : t("side.cloud.emptyCut1"))); return; }
  list.forEach((x) => {
    const wrap = trEl("div", "strat-wrap cs-row"), row = trEl("button", "strat-row"); row.type = "button"; row.dataset.name = x.name; wrap.dataset.name = x.name;
    if (x.name === sel) row.setAttribute("aria-current", "true");
    const nm = trEl("span", "strat-name"); stratNameFill(nm, x.displayName); nm.title = typeof stratTip === "function" ? stratTip(x.displayName, x.name) : x.name; row.appendChild(nm);
    if (dotsUp && envRunDot(x.name, st, Date.now(), TR_BAGS.cloud.just)) envDotInto(nm, true);
    const deleting = CDEL.busy.has(x.name);
    if (deleting) { wrap.classList.add("is-deleting"); row.setAttribute("aria-busy", "true"); row.appendChild(trEl("span", "stx", t("cdel.pending"))); }
    else { const w = envStratWord(x.name, st); if (w) row.appendChild(envRowMark(w)); }
    // 再點一次選中的那支 = 收掉、回雲端自動下單頁。選取一換整張清單就重建,焦點接回同名那一列(不掉到 BODY)
    row.addEventListener("click", () => {
      if (x.name === RPC.name) sideReclick(() => rpCloudSelect(null)); else rpCloudSelect(x.name);
      const ae = document.activeElement, r = cdelRowBtn(x.name, null);
      if (r && (!ae || ae === document.body)) r.focus();
    });
    wrap.appendChild(row);
    if (canDel && !deleting && /^[A-Za-z0-9_-]{1,64}$/.test(x.name) && typeof armedDelete === "function")
      wrap.appendChild(armedDelete(wrap, t("cdel.aria", { name: x.displayName || x.name }), (btn) => cdelAsk(x, btn), true));
    box.appendChild(wrap);
  });
}
/* 開通頁(規格 §3;Wei 選定 A 案):電腦版把人帶進雲端方案的主要入口。主鈕**直接開已上線的那一套**——登入走 planLogin、
   啟動走 planAsk(花錢的確認框 cf.*,一步不少)、綁卡外開瀏覽器;這裡不另寫一條開通流程。價格數字來自方案頁同一個來源
   (planVars:登入後 account_status、沒登入 public-pricing);拿不到 → 價格段不畫、啟動鈕 disabled,不寫死數字。 */
function envPaintEmpty(kind, pid) {
  // 「準備好了」那一態在 envOpenView 之外另判:它的條件是「還有一支等著送上雲端」,不是帳號狀態
  const ready = kind === "running" && !!pid;
  const view = ready ? "ready" : envOpenView(kind, hasToken, planView()), v = planVars();
  // 這一頁要的數字:登入了但帳號狀態還沒到 → 去查;沒登入 → 公開價目。查回來會經 envPlanChanged 重畫
  // 最多每 30 秒問一次:查不到(離線)時重畫又會走到這裡,不設間隔就是一個空轉的迴圈
  if (((hasToken && !acct && !acctPending) || (!hasToken && !pub)) && Date.now() - (ENV.askedAt || 0) > 30000) {
    ENV.askedAt = Date.now();
    if (hasToken) acctCheck(); else pubLoad().then(envPlanChanged);
  }
  const slow = view === "starting" && planSince && Date.now() - planSince > PLAN_SLOW_MS;
  const err = view === "starting" || view === "loading" || view === "unreach" || view === "ready" ? null : planErr;
  const sig = LANG + "|" + JSON.stringify([view, pid || null, v.p, v.h, v.d, v.t, v.q, v.v, slow, err && err.key, planLoginBusy, cur]);
  if (ENV.sig.empty === sig) return;
  ENV.sig.empty = sig;
  const desc = $("cv-desc"); desc.textContent = "";
  if (view === "starting") { const d = trEl("i", "dot busy"); d.setAttribute("aria-hidden", "true"); desc.append(d, trEl("span", "txt", t("side.cloud.starting"))); }
  // ready 這一態描述**留空**:env.empty.desc「還沒有雲端主機」在這裡是假話,而「運行中」那件事 h4 已經講了
  else if (view !== "loading" && view !== "unreach" && view !== "ready") desc.textContent = t("env.empty.desc");
  const box = $("cv-body"), focusK = box.contains(document.activeElement) ? document.activeElement.dataset.k : null;
  box.textContent = "";
  if (view === "loading") { box.appendChild(trEl("div", "pf-state", t("tr.loading"))); return; }
  const page = trEl("div", "cv-open"); box.appendChild(page);
  const btn = (cls, label, on, k) => { const b = trEl("button", cls, label); b.type = "button"; b.dataset.k = k; if (on) b.addEventListener("click", on); return b; };
  if (view === "unreach") { page.appendChild(trEl("p", "cv-p", t("env.empty.unreach"))); return; }
  // ready:行為同 starting——不畫 env.open.h 那三條賣點、不畫價格。它不是開通頁了,是一句交代
  if (view === "ready") page.append(trEl("h4", "", t("ho.ready.h")), trEl("p", "cv-p", t("ho.ready.body", { id: pid })));
  else if (view === "starting") page.appendChild(trEl("p", "cv-p", t("env.empty.starting")));
  else {
    page.append(trEl("h4", "", t("env.open.h")), trEl("p", "cv-lead", t("env.open.lead")));
    // 扣款規則(存在就扣、停機照扣、刪除才停)不在這一頁:啟動確認框一定會經過、三句直接顯示,設定 › 方案內容與計費也講全(spec-0.1.10 §2.3)
    if (v.p) {
      const pr = trEl("div", "plan-price"); pr.appendChild(trEl("span", "m", t("plan.month", v))); if (v.h) pr.appendChild(trEl("span", "h", t("plan.hour", v)));
      page.appendChild(pr);
    }
  }
  // 鈕上方那一行:錯誤(方案頁同一組 plan.err.*)優先;否則這顆鈕會帶來的錢 / 好消息
  if (err) { const e = trEl("p", "plan-err" + (err.calm ? " is-calm" : "")); e.setAttribute("role", "status"); const m = trEl("span", "fault-mark"); m.setAttribute("aria-hidden", "true"); e.append(m, trEl("span", "", t(err.key))); page.appendChild(e); }
  else if (slow) { const e = trEl("p", "plan-err is-calm"); const m = trEl("span", "fault-mark"); m.setAttribute("aria-hidden", "true"); e.append(m, trEl("span", "", t("plan.err.slow"))); page.appendChild(e); }
  else if (view === "relogin") page.appendChild(trEl("p", "cv-above up", t("env.empty.relogin")));
  else if (view === "card") page.appendChild(trEl("p", "cv-above", planView() === "noTrial" ? t("pv.f.noTrial", v) : t(pvK("pv.f.offer"), v)));
  else if (view === "start" && v.d) page.appendChild(trEl("p", "cv-above up", t("plan.trialFree", v)));
  const act = trEl("div", "cv-act"), more = () => btn("btn-quiet", t("env.open.more"), () => planOpen(), "more");
  const after = () => { ENV.sig.empty = null; ENV.cloudDirty = true; trPollSoon(0); };
  let main = null, side = null;
  if (err && err.key === "plan.err.relogin") main = btn("btn-fill", t("plan.relogin"), () => Promise.resolve(planRelogin()).then(after), "main");
  else if (err && err.key === "plan.err.nocard") main = btn("btn-fill", t("plan.addCard"), () => bindGo("bind_cloud"), "main");
  else if (err && err.key === "plan.err.credit") main = btn("btn-fill", t("plan.addCredit"), () => bindGo("topup_cloud"), "main");
  // 主鈕的 data-k 照樣是 "main":登入前按的那顆也是 main,所以人回來時焦點正好落在它身上(下面那段依 data-k 還原焦點),按 Enter 就走
  else if (view === "ready") { main = btn("btn-fill", t("ho.back.btn"), () => hoBack(pid), "main"); side = btn("btn-quiet", t("ho.ready.stay"), () => { hoStay(); after(); }, "stay"); }
  else if (view === "out") { main = planLoginBusy ? btn("btn-out", t("oauth.cancel"), planLogin, "main") : btn("btn-fill", t("cn.blave.btn"), () => Promise.resolve(planLogin()).then(after), "main"); side = trEl("span", "wait", planLoginBusy ? t("pv.w.waiting") : t("pv.w.out.cli")); }
  else if (view === "relogin") main = btn("btn-fill", t("plan.relogin"), () => Promise.resolve(planRelogin()).then(after), "main");
  else if (view === "card") { main = btn("btn-fill", t("plan.addCard"), () => bindGo("bind_cloud"), "main"); side = more(); }
  else if (view === "start") { main = btn("btn-fill", t("plan.start"), planAsk, "main"); main.disabled = !(v.p && v.h); side = more(); }
  else if (view === "starting") { main = slow ? btn("btn-out", t("plan.recheck"), () => { planSince = Date.now(); acctCheck(); after(); }, "main") : btn("btn-fill", t("plan.starting"), null, "main"); main.disabled = !slow; }
  else { main = btn("btn-out", t("plan.recheck"), () => { acctCheck(); if (typeof window.blave.cloudRefresh === "function") window.blave.cloudRefresh(); after(); }, "main"); side = more(); }
  act.appendChild(main); if (side) act.appendChild(side); page.appendChild(act);
  if (focusK) { const again = [...box.querySelectorAll("button")].find((b) => b.dataset.k === focusK); if (again && !again.disabled) again.focus(); else $("cv-h").focus(); }
}
// 帳號 / 方案狀態變了(app.js 的 planPaint、sidePaint 叫):人在雲端視角就重畫;剛按了啟動 → 請主行程馬上重問雲端,不等下一輪
function envPlanChanged() {
  if (!TRP.started || ENV.cur !== "cloud") return;
  if (planView() === "starting" && envCloudKind(TR_BAGS.cloud.st) === "none" && typeof window.blave.cloudRefresh === "function") { window.blave.cloudRefresh().catch(() => {}); ENV.cloudDirty = true; }
  trPaint();
}
