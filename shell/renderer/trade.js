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
/* 保證金列(台灣期貨帳戶;同雲端 buildAccountBlock):帳戶讀取器只在 lib 有給時才塞 key——
   key 存在但 null = 那列畫「—」;key 不存在 = 整列不畫;三個都不存在 = 整塊不畫(加密所畫面不變)。
   風險指標 = 權益數 ÷ 原始保證金(券商 app 的口徑,用戶拿來對);門檻只看維持保證金:權益數低於它才是事實句。
   更新時間:margin_updated_at(統一 worker 解析 update_date/time)→ 退回帳戶讀取器那輪的 read_at */
const TR_MARGIN_KEYS = ["available", "initial_margin", "maintenance_margin"];
function trMarginModel(e, readAt) {
  if (!e || typeof e !== "object" || e.ok !== true) return null;
  const has = (k) => Object.prototype.hasOwnProperty.call(e, k), num = (v) => (typeof v === "number" && isFinite(v) ? v : null);
  if (!TR_MARGIN_KEYS.some(has)) return null;
  const rows = TR_MARGIN_KEYS.filter(has).map((k) => ({ key: k, value: num(e[k]) }));
  // 分子是期貨帳的權益數 accounts.futures(保證金四個 key 都對應它;群益之後證券估值進 accounts 時總額會蓋掉保證金缺口),沒有才退 equity
  const fut = e.accounts && typeof e.accounts === "object" ? num(e.accounts.futures) : null, eq = fut != null ? fut : num(e.equity);
  const im = num(e.initial_margin), mm = num(e.maintenance_margin);
  const risk = has("initial_margin") ? { ratio: eq != null && im != null && im > 0 ? eq / im * 100 : null, below: eq != null && mm != null && mm > 0 && eq < mm } : null;
  const at = num(e.margin_updated_at) > 0 ? e.margin_updated_at : num(readAt) > 0 ? readAt : null;
  return { rows, risk, at };
}
// TWD 金額:整數、千分位、負值 U+2212(同網頁 fmtAmount);不是數字回 null
function trTwd(v) { if (typeof v !== "number" || !isFinite(v)) return null; return (v < 0 ? "−" : "") + Math.round(Math.abs(v)).toLocaleString("en-US"); }
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
// 停掉的那一種是登入失敗(runtime 寫 worker.error = LOGIN_FAILED:<類別>;其他失敗是沒寫出快照那類):設定 › 帳戶 那一列講「登入已停止」而不是讀帳原文
function trPresLoginStopped(r, id) { return trPresStopped(r, id) && String(r.president_connect.worker.error || "").indexOf("LOGIN_FAILED") === 0; }
/* 統一下單程式剛起來(worker ok、或 wanted 著還在 running)、帳戶讀取器還沒讀到它之後的那一輪(account.read_at 早於那一刻、或還沒有 account):
   這時掛著的是上一輪的舊失敗,不是串接失敗(10-13 乾淨機模擬 發現 2:開通成功回到頁面頭幾秒紅字「串接失敗」)。
   超過 TR_PRES_BOOT_MS 還沒讀到就照舊講失敗;worker 明確失敗(status failed)不走這裡 */
const TR_PRES_BOOT_MS = 60000;
function trPresBooting(r, nowMs) {
  const c = r && r.president_connect, w = c && typeof c === "object" ? c.worker : null;
  if (!w || typeof w !== "object") return false;
  const since = w.status === "ok" ? w.ok_at : w.status === "running" && w.wanted === true ? w.at : null;
  if (typeof since !== "number" || nowMs - since * 1000 > TR_PRES_BOOT_MS) return false;
  const readAt = r.account && typeof r.account.read_at === "number" ? r.account.read_at : 0;
  return readAt < since;
}
/* 台指期實盤行情來源那一句(設計 spec desktop-live-source-line;lib/data 在每次 live tick 寫 state/twfutures_live_source.json,reporter 原樣帶出)。
   四個條件同時成立才出:這台電腦且綁統一、回報有那一欄(還沒 tick 過就沒有,不出佔位句)、至少一個台指期口數列 > 0(`lots`;
   全 0 時沒有 live tick,檔案是舊的)、狀態在跑 / 已暫停 / 沒停住(過場中、死掉、開通中都不出)。
   `paused`(市場沒開、worker 在時段外重蓋快照)不是退路,照正常句;退路時先用 president_connect 判「統一還沒登入」
   (後端沒有獨立代碼:worker 沒登入只是不寫檔,落 stale / no_file),再看 reason;
   `empty` 併進 noFile。fallback = 退路句(顏色升一階,trPaintQuote) */
const TR_QUOTE_WHY = { stale: "tr.quote.why.stale", not_enabled: "tr.quote.why.notEnabled", no_overlap: "tr.quote.why.noOverlap" };
const TR_QUOTE_STATES = ["running", "halted", "unconfirmed"];
function trQuoteLine(r, env, id, state, lots) {
  const q = env === "local" && id === "president" && lots && TR_QUOTE_STATES.indexOf(state) >= 0 && r && r.twfutures_live_source;
  if (!q || typeof q !== "object") return null;
  // paused = 市場沒開(worker 在時段外重蓋快照):不是退路,照正常句
  if (q.source === "president" || q.reason === "paused") return { key: "tr.quote.pres", why: null, fallback: false };
  const w = r.president_connect && r.president_connect.worker, why = String(q.reason || "");
  const k = w && w.status && w.status !== "ok" ? "tr.quote.why.noLogin"
    : TR_QUOTE_WHY[why] || (why.indexOf("not_ok") === 0 ? "tr.quote.why.notOk" : "tr.quote.why.noFile");
  return { key: "tr.quote.blave", why: k, fallback: true };
}
// 讀帳失敗的原因:多數 lib 回「stage: msg」字串;統一的是物件 {stage, type, msg}(10-08 e2e 畫成 [object Object])
function trAcctErr(err) {
  if (err && typeof err === "object") return { stage: String(err.stage || "—"), msg: String(err.msg || err.message || "") };
  const m = /^([a-z_]+):\s*(.*)$/i.exec(String(err || ""));
  return m ? { stage: m[1], msg: m[2] } : { stage: "—", msg: String(err || "") };
}
function trFailedIds(r) { return trVenueIds(r).filter((id) => { const e = trLiveEntry(r, id); return !!e && !e.ok && !trCapWip(r, id) && !trPresWip(r, id) && !(id === "president" && trPresBooting(r, Date.now())); }); }
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
/* 0.1.27 起的 lib:HALT = 完全凍結(runtime 帶 halt.freeze,沒暫停時也帶,給暫停框用)。true = 暫停期間什麼單都不送,
   平倉、減碼、停損停利都算;缺欄位(舊 runtime)或 false(機器上的 lib 還沒更新)= 舊講法(不開新倉、平倉停損照走) */
function trHaltFreeze(r) { return !!(r && r.halt && r.halt.freeze === true); }
/* 用戶自己按的暫停(含沒有 source 的手動 HALT):凍結時講「什麼單都不送」,不講「問題處理好之後」那句(那是自動暫停的) */
const TR_HALT_USER = ["web", "user", "flatten", "desktop"];
function trHaltByUser(h) { const src = h && h.source; return !src || TR_HALT_USER.indexOf(src) >= 0; }
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
  if (H && !bh && done && (done.outcome === "kept" || done.outcome === "reset")) return t(done.outcome === "kept" ? (trHaltFreeze(r) ? "tr.acct.doneSameFreeze" : "tr.acct.doneSame") : "tr.acct.doneDiff", { v: vl(done.venue) });
  // 照 HALT 的實際原因講(Mac e2e 10-14:解綁造成的暫停被講成「Blave 重開過」)。主機重開停住(machine)那一種最根本,照舊優先;
  // 解綁那一種再分下單程式在不在跑:沒在跑就什麼單都不下,在跑照 A 的規則(不開新倉、平倉照常)
  // 「平倉與停損停利照常執行」只有對帳器真的活著才成立(從沒啟動過、自己掛了、解綁時被停掉都不成立;稽核 r4 P1-2)
  if (H && rk !== "machine" && /^exchange unbound/.test(String((r.halt && r.halt.reason) || ""))) {
    const sup = r.daemon && r.daemon.reconciler, alive = !!(r.reconciler && r.reconciler.alive) && !(sup && sup.running === false);
    return t(alive ? (trHaltFreeze(r) ? "tr.haltUnboundFreeze" : "tr.haltUnbound") : "tr.haltUnboundOff");
  }
  // ZH(「新倉也被擋著——包含你自己的策略程式下的單」)只在真的有自己下單的策略時講;沒有就退回 Z 那一句
  return rk === "machine" ? t(z ? "tr.cloud.restartStoppedZ" : "tr.cloud.restartStopped")
    : rk === "app" ? t(z ? (H && trSelfOrdering(r) ? "tr.restartStoppedLocalZH" : "tr.restartStoppedLocalZ") : "tr.restartStoppedLocal")
    : trHaltFreeze(r) && trHaltByUser(r.halt) && !trRestartUnconfirmed(r) ? t("tr.haltReasonFreeze")
    : trHaltStopsAll(r && r.halt) ? (trRestartUnconfirmed(r) ? t("tr.cloud.haltReasonUnconfirmed") : t(z ? "tr.haltReasonAllZ" : "tr.haltReasonAll")) : t("tr.haltReason");
}
/* ── 沒有策略設金額(spec-desktop-update-experience-v2 §8,Wei 09-23)──
   Z = 沒有任何一條策略的金額 > 0。讀不到設定檔(config: null)不算 Z:不知道有沒有金額,照現行、不猜。
   Z 時「啟動下單」停用(沒有東西可以啟動),暫停中(HALT 或重開停止)另給「解除暫停」:只送 resume,不啟動對帳器 */
function trNoAmounts(r) {
  if (!r || typeof r !== "object" || r.config === null) return false;
  return trTradableFunded(r) === 0 || trUnrouted(r).length > 0;   // 有金額卻沒有路由的成員:runtime 啟動時拒絕(NEEDS_ROUTING),畫面先停用、叫人去存一次
}
/* 解除綁定後重新綁定(runtime 10-14 起解綁保留成員與金額、只清路由):有交易所綁著、金額 > 0 的成員路由是空的 → 還沒有對應的交易所,
   要先到策略組合存一次下單設定(runtime 存的時候繼承唯一綁著的那家)。舊 runtime 沒有 config.exchanges = 不判。回那幾支的名字。
   金額 0 的成員也算(runtime 的 NEEDS_ROUTING 閘門任何沒路由的成員都擋) */
function trUnrouted(r) {
  const c = r && r.config, a = c && c.amounts, ex = c && c.exchanges;
  if (!a || typeof a !== "object" || !ex || typeof ex !== "object" || !trVenueIds(r).length) return [];
  return Object.keys(a).filter((n) => !ex[n]);
}
// 配置的路由跟現在綁的那家不同(含空的):存檔鈕要能按,存一次讓 runtime 改走現在這家(它存的時候自己繼承,不必另帶)
function trRouteDirty(r) {
  const c = r && r.config, a = c && c.amounts, ex = c && c.exchanges, vid = trVenueIds(r || {})[0] || null;
  if (!vid || !a || typeof a !== "object" || !ex || typeof ex !== "object") return false;
  return Object.keys(a).some((n) => ex[n] !== vid);
}
/* 這家能下的金額(post-connect-flow 第 1／5′ 列):金額 > 0 的策略裡,扣掉 trPickRows 同一套規則會鎖的——統一的非台指期、
   模擬交易的台股(台指期照機器支援)。回幾支。加密策略有金額、改綁統一 = 0:Z,「啟動下單」停用,原因行叫人先去策略組合。
   規則跟 runtime 存金額時的 NOT_TXF 同一條(command_listener):標的看得出來、而且確定不是台指期才不算;看不出來(清單與回報都沒有)算能下 */
function trTradableFunded(r) {
  const a = r && r.config && r.config.amounts; if (!a || typeof a !== "object") return 0;
  const vid = trVenueIds(r)[0] || null, list = typeof TR !== "undefined" && TR && Array.isArray(TR.list) ? TR.list : [], st = r.states || {};
  return Object.keys(a).filter((n) => {
    if (!(Number(a[n]) > 0)) return false;
    const exm = r.config && r.config.exchanges;
    if (vid && exm && typeof exm === "object" && !exm[n]) return false;   // 有綁交易所、這支卻沒有路由(解綁後重新綁定、還沒存):這家下不了它
    const x = list.find((y) => y.name === n) || {}, sym = String(x.symbol || (st[n] && st[n].symbol) || "").trim().toUpperCase();
    if ((vid === "president" || vid === "capital") && (x.portfolio === true || !!(st[n] && st[n].weights))) return false;   // 投資組合:成分統一下不了(同網頁 pfTxfOnly)
    if (!sym) return true;   // 標的看不出來:不判(同 runtime NOT_TXF 的 fail-open)
    if (vid === "president" || vid === "capital") return !!trTxfSpec(sym);   // 群益同一條(runtime MARKET_VENUE)   // 不去 R1:runtime 存的時候 TXFR1 不算台指期
    if (vid === "paper" && r.can_paper_twstock !== true) return !(x.twd === true || /^(?:TXF|MXF|TMF|\d{4,6}[A-Z]?(?:\.TWO?)?)$/.test(sym)) || !!trTxfSpec(sym);   // 同 TR_TWD_RE
    return true;
  }).length;
}
/* 剛綁好的頁首(第 5 列):Blave 重開過(rk app)但沒有金額、帳本上也沒有 Blave 的部位、也不是 ZH(暫停中又有自己會下單的策略程式)——
   「重開過」不影響任何決定,狀態行寫「尚未啟動下單」 */
function trAppRestartQuiet(r) {
  const sup = r && r.daemon && r.daemon.reconciler, H = !!(r && r.halt && r.halt.halted);
  const app = !trRestartUnconfirmed(r) && !trRestartStopped(r) && !!sup && sup.running === false && sup.wanted !== true && !!(r.reconciler && r.reconciler.heartbeat_at);
  return app && trNoAmounts(r) && !trBookRows(r).length && !(H && trSelfOrdering(r));
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
  /* 帳本上還有機器人的部位(0.1.20,Wei 10-08):Z 不再等於「沒有東西可以啟動」——HALT 只擋新倉腿,對帳器活著第一輪就會
     照金額 0 把帳本上的倉平掉;死角是對帳器沒在跑(dead / 重開停著 / 沒有自己下單的策略所以連「解除暫停」都不出)。
     這時主鈕照常是可按的「啟動下單」(走既有 resume ＋ restart_reconciler),原因行換成講帳本上有多少、按下去會先平掉;
     「解除暫停」不另出(同非 Z 的 halted:啟動下單已經是那顆鈕的超集)。book 給畫面算口數／數量 */
  // 沒有路由(解綁後重新綁定、還沒存):runtime 啟動時拒絕 NEEDS_ROUTING——帳本上有部位也一樣,鈕停用、講要先存(稽核 r4 P2)
  if (trUnrouted(r).length && (state === "dead" || state === "halted")) return { off: true, release: false, reason: "tr.startOffNoAmt" };
  const book = trBookRows(r);
  if (book.length && (state === "dead" || state === "halted")) return { off: false, release: false, reason: "tr.startOnBook", book };
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
/* 還沒選策略／還沒設金額時缺的是哪一步(spec-autotrade-empty v3 §2)。只在「沒有任何金額 > 0、沒有沒路由的成員、讀得到設定」時成立;
   有金額但這家下不了、重新綁定後沒路由的照 0.1.24(回 null)。rows = 選擇策略框會列的候選(trPickRows,鎖照套),null = 清單還沒載入。
   "pick" 有能勾的 /"noStrat" 沒有回測完成的 /"noVenue" 有、但這家全鎖住 /"amt" 選了、金額全是 0 /
   "draft" 已存一支都沒有、選擇策略框有還沒儲存的草稿(draft = trZDraft();已存有成員時草稿不改判斷,照 "amt") */
function trZCase(r, rows, draft) {
  if (!r || typeof r !== "object" || r.config === null || trCfgUnread(r)) return null;
  const c = r.config && typeof r.config === "object" ? r.config : {}, a = c.amounts && typeof c.amounts === "object" && !Array.isArray(c.amounts) ? c.amounts : {};
  if (trUnrouted(r).length || Object.keys(a).some((n) => Number(a[n]) > 0)) return null;
  if (Object.keys(a).length) return "amt";
  if (draft) return "draft";
  if (!rows) return "pick";
  return rows.some((x) => !x.locked) ? "pick" : rows.length ? "noVenue" : "noStrat";
}
const TR_ZCASE_LINE = { pick: "tr.startOffNoPick", noStrat: "tr.startOffNoStrat", noVenue: "tr.startOffNoVenueStrat", amt: "tr.startOffZeroAmt", draft: "tr.startOffDraft" };
const TR_ZCASE_BTN = { pick: "tr.pick", noStrat: "ns.chip", noVenue: "ns.chip", amt: "po.goAmounts", draft: "po.goAmounts" };
/* 頁首與部位分頁在這一格怎麼畫(spec §2–§4、§6-1:一個畫面一句導引、一顆實心鈕)。
   o.zc = trZCase;o.pure = 純 Z(trZView 回 tr.startOffNoAmt、沒有解除暫停、有啟動鈕);o.dead = 狀態行原本是「尚未啟動下單」(不是異常停止);
   o.pend = 等回報那一句的 key;o.wait = 等待中(canon:等待中絕不出霧);o.tab = 自動下單頁目前的分頁。
   回 fog = 部位要上的霧("pick" / "noStrat" / "noVenue" / "draft",null 不上);fogOn = 霧正在眼前;btn / fill = 頁首鈕字與實心(null = 不畫);
   status = 取代狀態行的 key(""= 空著留高度,null = 照舊);reason = 原因行的 key(undefined = 照舊 zv.reason 那條);desc = 停用的啟動下單 aria-describedby */
function trZGuide(o) {
  const zc = o.zc || null, fog = !o.wait && (zc === "pick" || zc === "noStrat" || zc === "noVenue" || zc === "draft") ? zc : null, fogOn = !!fog && o.tab === "pos";
  const line = zc ? TR_ZCASE_LINE[zc] : null, moved = !!(o.pure && o.dead && zc), pend = o.pend || null;
  return {
    fog, fogOn,
    btn: o.pure && !pend && !fogOn ? (zc ? TR_ZCASE_BTN[zc] : "po.goCfg") : null,
    fill: !!zc,
    status: moved ? (fogOn || pend ? "" : line) : null,
    reason: o.pure && zc ? (pend || (fogOn || moved ? null : line)) : undefined,
    desc: o.pure && fogOn ? "tr-pos-fog-msg" : moved && !pend ? "tr-desc" : "tr-noamt",
  };
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
/* 帳本(last_reconcile.ledger,lib/portfolio.ledger_positions)上機器人還持有的部位:size ≠ 0 的每一列(現貨也算——
   對帳器平的是整本帳,不只合約)。沒有快照 / 沒有帳本 = 空。列的形狀同 trReleaseRows */
function trBookRows(r) {
  const last = r && typeof r.last_reconcile === "object" ? r.last_reconcile : null, led = last && last.ledger;
  if (!led || typeof led !== "object") return [];
  return Object.keys(led).filter((k) => led[k] && typeof led[k] === "object" && Number(led[k].size || led[k].qty || 0) !== 0)
    .map((k) => ({ sym: trCanonKey(k), v: trSigned(led[k]) || Number(led[k].size || led[k].qty), lots: led[k].unit === "contracts" || !!trTxfSpec(trCapitalCanon(k)) }));
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
/* 存金額後機器可能真的下單嗎(確認框標「平倉」「移出 · 平倉」的依據;同網頁 pfMayFire):在跑、重開沒停住、剛按啟動;
   已暫停只有單純 HALT(平倉停損照走)算;trExecState 的 halted 也包含重開停止(對帳器整個停著,HALT 疊在上面也一樣),那一種不算 */
function trMayFire(st, pending) {
  const s = trExecState(st), r = st && st.report, h = r && r.halt;
  return s === "running" || s === "unconfirmed" || (s === "halted" && !trRestartKind(r) && !trHaltStopsAll(h)) || trStartPending(pending);
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
   勾了還沒存的草稿也靠這一份一起寫進去)。移出組合只剩「picker 取消勾選」一條路(spec-desktop-strategy-picker §12-5)——
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
   sent = 送出的整份;report = 報告裡的 config.amounts;ageMs = 從 ack 到現在多久。
   回 "same"(對上了:收斂)| "timeout"(30 秒(同網頁 PF_SAVE_PIN_MS)到了還不符:改顯示報告值、提示「主機還沒套用」)| "wait"。
   **不拿報告時間放行**(同網頁 2149bbe8):主機會在指令套用前先送一份快照——reported_at 跟按儲存同一秒、甚至在 ack 之後才到,
   金額卻還是舊的;以前「比 ack 當下那份新就算數」會在主機套用前放行,格子跳回舊值。
   兩邊都取到小數兩位(runtime _cmd_amounts 只做 round(f, 2))後要完全相等;key 集合不同也算不同(amounts 是整份覆蓋,少一個 key = 移出組合)。 */
function trSentSettled(sent, report, ageMs, before, ctOk) {
  const r2 = (v) => Math.round((Number(v) || 0) * 100);
  const eq = (a, b) => { const x = a && typeof a === "object" ? a : {}, y = b && typeof b === "object" ? b : {}, kx = Object.keys(x), ky = Object.keys(y);
    return kx.length === ky.length && kx.every((k) => k in y && r2(x[k]) === r2(y[k])); };
  // 金額對上、但送出的合約回報還沒換過來(只換合約、口數不變):還沒套用,繼續等(同網頁 987321f9)
  if (eq(sent, report)) return ctOk === false ? (typeof ageMs === "number" && ageMs >= 30000 ? "timeout" : "wait") : "same";
  /* 存之前的值(before,存檔那一刻手上那份):回報還是它 = 主機還沒套用,繼續等(30 秒到了 timeout);
     跟兩者都不同 = 有人從別處(網頁／聊天)改了 → 立刻放開、照主機上的值畫,不講「主機還沒套用」。before 不知道(null)= 只能等 */
  // before 可以是一串:存之前的值 + 分兩步存(換合約又改口數)時第一步送出的中間值——回報等於其中任何一個都還是「主機還沒套用完」
  const waits = (Array.isArray(before) ? before : [before]).filter((x) => x && typeof x === "object");
  if (waits.length && report && typeof report === "object" && !waits.some((w) => eq(w, report))) return "changed";
  return typeof ageMs === "number" && ageMs >= 30000 ? "timeout" : "wait";
}
/* 台指期口數列(同 runtime command_listener._TXF_ASSET_SPECS、網頁 TXF_SPECS):機器把這一格當**目標口數**下單,不是錢。
   跟網頁一樣看策略的標的、不看綁哪家:runtime 第一次撥款時只看 SYMBOL 就寫 futures_contracts */
/* 口數換出來的參考金額的幣別:點值 × 加權指數本來就是台幣,固定標 TWD、不跟帳戶幣——讀帳失敗時帳戶幣會退成 USDT,
   台幣數字標成 USDT 等於把曝險放大約 30 倍(設計稽核第二輪 R2-S2)。群益主機只接這一家,表上不會混別的幣別 */
const TR_TXF_CCY = "TWD";
const TR_TXF_SPECS = { TMF: { cv: 10, prod: "tr.txfProd.tmf" }, MXF: { cv: 50, prod: "tr.txfProd.mxf" }, TXF: { cv: 200, prod: "tr.txfProd.txf" } };
// 淨值倍數:千分位、兩位小數(4,494.68×;同網頁)
function trMultFmt(x) { return x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
/* 金額表「訊號」欄(units spec §3.3、§8.2,同網頁 pfSignalText):×1.00 / ×−1.00(U+2212);拿不到、沒部位都是 ×0。
   tc = trTypeC(state):投資組合的訊號是持有權重合計——只做空帶負號,多空混合寫 Σ|w'| 不帶號 */
function trSignalText(pos, tc) {
  const v = tc ? (tc.long && tc.short ? tc.long + tc.short : tc.long - tc.short) : pos;
  if (typeof v !== "number" || !isFinite(v) || v === 0) return "×0";
  return "×" + (v < 0 ? "\u2212" : "") + Math.abs(v).toFixed(2);
}
/* 部位表「N 支策略」拆解(§2.2):跟 trClientTargets 同一套算法,但逐支留著,不只留加總。只算金額 > 0 的策略。
   回 { 標的 key: [{ name, amount, x, v, w }] }(x = 訊號或權重、v = 貢獻、w = 是不是投資組合的權重) */
function trContribs(amounts, states, contracts) {
  const out = {}, add = (k, row) => { (out[k] = out[k] || []).push(row); };
  Object.keys(amounts || {}).forEach((n) => {
    const a = Number(amounts[n]) || 0, s = (states || {})[n], paperTw = trPaperOf(n), off = trRouteBlank(n);
    if (!(a > 0) || !s) return;
    if (s.weights && typeof s.weights === "object") {
      Object.keys(s.weights).forEach((sym) => {
        let w = Number(s.weights[sym]); if (!isFinite(w)) w = 0;
        const spot = s.market === "spot" || trTwCash(sym, paperTw);
        if (spot && w < 0) w = 0;
        if (!w) return;   // 權重 0 的候選不是持有(units spec §8.3):上表「N 檔」與下表列數同一個篩選
        add(trCanonSym(sym) + (spot ? "@spot" : ""), { name: n, amount: a, x: w, v: off ? 0 : a * w, w: true });
      });
      return;
    }
    if (!s.symbol) return;
    const sym = trCanonSym(trEffSym(n, s.symbol, contracts)), cash = trTwCash(sym, paperTw);
    let pos = typeof s.position === "number" ? s.position : 0;
    if (cash && pos < 0) pos = 0;
    add(sym + (s.market === "spot" || cash ? "@spot" : ""), { name: n, amount: a, x: pos, v: off ? 0 : a * pos, w: false, notYet: s.notYet === true });
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
/* 生效合約(契約 txf-contract-switch §2):主機回報 config.contracts[name] 是台指期家族代號、策略的 SYMBOL(去掉 R1)也是台指期家族才換,
   其餘照 SYMBOL。訊號仍跑 TXF K 線,換的是下哪個合約——每點價值、商品名、對帳快照的 key(target／gates)都跟著它 */
function trEffSym(n, sym, contracts) {
  const c = contracts && typeof contracts === "object" && Object.prototype.hasOwnProperty.call(contracts, n) ? contracts[n] : null;
  return typeof c === "string" && Object.prototype.hasOwnProperty.call(TR_TXF_SPECS, c) && trTxfSpec(String(sym || "").replace(/R1$/i, "")) ? c : sym;
}
/* 台指期報價(主行程 txfQuote,5 分鐘快取):沒問到 = null。trTxfWant 在背景補問,回來的值靠金額表簽章含報價、下一輪輪詢重畫 */
const TR_TXF = { price: null, at: 0, busy: false }, TR_TXF_MS = 300000, TR_TXF_RETRY_MS = 60000;
// 台股代號 → 名字的表(trTwNamesWant 填;v = 拿到第幾次,進重畫簽章)
const TR_TWN = { names: null, busy: false, at: 0, v: 0 }, TR_TWN_RETRY_MS = 600000;
function trTxfPrice() { return TR_TXF.price; }
// 口數 → 參考金額(TWD;同網頁 txfRefMoney):0 口 = 0;沒有報價 = null,呼叫端畫「—」,不拿口數硬乘出一個像金額的數
function trTxfRefMoney(spec, lots, price) { if (!(lots > 0)) return 0; return typeof price === "number" && price > 0 ? lots * spec.cv * price : null; }
/* 下單紀錄這一筆是不是口數單(同網頁下單紀錄 / reconciler is_lot_based):asset_spec 是 futures_contracts、交易所是群益／統一,
   或標的本身是台指期(TXF／MXF／TMF:舊的平倉列沒有 asset_spec,看標的不看綁哪家)——這時 signed_diff 是口數,不是錢 */
function trOrderLots(o) {
  return !!o && ((!!o.asset_spec && o.asset_spec.type === "futures_contracts") || o.exchange === "capital" || o.exchange === "president"
    || !!trTxfSpec(trCapitalCanon(o.symbol)));
}
/* 下單紀錄與總覽事件列的下單:只列目前連著的交易所那些——這台電腦綁了統一之後,之前模擬交易的單不混進同一張表。
   沒寫交易所的舊列照列;沒綁任何交易所時沒有「目前」可言,全列 */
function trOrdersShown(r) {
  const orders = (Array.isArray(r && r.orders) ? r.orders : []).filter((o) => o && typeof o === "object"), ids = trVenueIds(r || {});
  return ids.length ? orders.filter((o) => !o.exchange || ids.includes(String(o.exchange))) : orders;
}
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
/* 留空的口數格(7-2):空字串存成 0、這支不會下單,確認框點名提醒(不擋)。raw = 表上留著的原字(settle 把留空記成 "");
   skip = 不用再講的那幾支(原本 > 0 改成 0 的已有「改成 0」那句) */
function trBlankLots(names, raw, isLot, skip) {
  const s = skip || [];
  return (names || []).filter((n) => isLot(n) && !!raw && raw[n] === "" && s.indexOf(n) < 0);
}
/* en 的單複數(spec-0.1.13 #4):畫面上那個數字的絕對值是 1 用單數,其餘(含 0、0.5)用複數——呼叫端傳的是取整後要顯示的數。
   zh 兩個 key 同一個字。兩個 key 都寫成字面值傳進來(字串漂移閘門只認字面值) */
function trLotsKey(n, many, one) { return typeof n === "number" && Math.abs(n) === 1 ? one : many; }
/* ── 依計價分區(designer 0124-review units spec §9;同網頁 pfRowUnit / pfSuffixUnit / pfRoundLots)──
   金額表、部位表、確認框一區一種計價,單位只寫在區標題;整表只有一區時不畫區標題、單位回欄頭。
   分區只看列自己的計價,帳戶幣不參與——它只決定哪幾區排前面 */
const TR_ZONE_LOTS = "lots", TR_ZONE_UNKNOWN = "?";
// 白名單精確尾碼,長的先比(FDUSD 不會被讀成 USD);單寫 USD 不推(BTCUSD 可能是幣本位,以 BTC 計)
const TR_QUOTE_SUFFIX = ["FDUSD", "BUSD", "TUSD", "USDT", "USDC"];
const TR_TWSTOCK_RE = /^\d{4,6}[A-Z]?(?:\.TWO?)?$/;
function trSuffixZone(sym) {
  const s = trCanonSym(String(sym || "").trim().replace(/@spot$/i, ""));
  if (TR_TWSTOCK_RE.test(s)) return TR_TXF_CCY;
  const q = TR_QUOTE_SUFFIX.find((x) => s.length > x.length && s.slice(-x.length) === x);
  return q || null;
}
/* 投資組合(Type C)的持有權重(§8.2):現貨負權重先壓 0、壞值當 0,「持有」= w' ≠ 0。n 只數持有的。
   n = 策略名:路由到模擬交易的台股(trPaperOf)不管 MARKET 一律現股,負權重同樣壓 0(同 trClientTargets、lib/portfolio.aggregate_portfolio、網頁 pfHeldWeight)。
   keys = 全部成分(推計價、列成分用):回報的 weights 丟掉 0 權重,runtime 另帶 st.universe(含 0);舊 runtime 沒這欄,
   空手時 keys 就是空的(照舊)。不是投資組合回 null */
function trTypeC(st, n) {
  const w = st && st.weights && typeof st.weights === "object" && !Array.isArray(st.weights) ? st.weights : null;
  if (!w) return null;
  const out = { n: 0, long: 0, short: 0, keys: Object.keys(w), held: [] }, paperTw = n != null && trPaperOf(n);
  (Array.isArray(st.universe) ? st.universe : []).forEach((k) => { if (typeof k === "string" && k && out.keys.indexOf(k) < 0) out.keys.push(k); });
  out.keys.forEach((k) => { let x = Number(w[k]); if (!isFinite(x) || (x < 0 && (st.market === "spot" || (paperTw && trTwCash(k, true))))) x = 0;
    if (!x) return; out.n++; out.held.push(k); if (x > 0) out.long += x; else out.short -= x; });
  return out;
}
/* 金額表 Type C 列的標的格(Wei 10-16):3 檔以內直接列,超過寫「前 3 檔 等 N 檔」。
   數什麼(實機 10-18:同一支依序寫過 283／30／112 檔):有持股 = 持有的檔數(hover「持有：」列持有的);空手或還沒跑過 = 策略檔的 UNIVERSE
   (universe = 清單 trUniverse 解出來的全長),讀不到 UNIVERSE 才退回回報的成分(state 的 weights ∪ universe,那是策略那一輪輸出的候選,會隨每輪變)。
   台股寫名字(nameOf = trTwName,查不到退回代號),其餘去掉計價尾碼(同部位表 short)。hover 台股寫「名字（代號）」。
   keys 空(舊 runtime 的空手列)照舊寫「0 檔」。tf = t;nameOf 由呼叫端傳,這段純邏輯不碰名字表 */
function trShortSym(sym) { const s = String(sym || "").replace(/@spot$/i, ""); return s.replace(/(USDT|USDC|BUSD|FDUSD|USD)$/i, "") || s; }
function trTypeCLabel(tc, tf, nameOf, universe) {
  const held = tc.n > 0 && Array.isArray(tc.held) && tc.held.length ? tc.held : null;
  const keys = held || (Array.isArray(universe) && universe.length ? universe : tc.keys);
  if (!keys.length) return { text: tf("tr.nSyms", { n: tc.n }), tip: "" };
  const sep = tf("ak.sep"), codes = keys.map(trShortSym), names = keys.map((k) => (typeof nameOf === "function" && nameOf(k)) || "");
  const shown = codes.map((c, i) => names[i] || c), list = codes.map((c, i) => (names[i] ? tf("tr.twNameCode", { name: names[i], code: c }) : c)).join(sep);
  const text = shown.length <= 3 ? shown.join(sep) : tf("tr.typecSymsMore", { list: shown.slice(0, 3).join(sep), n: shown.length, k: shown.length - 3 });
  return { text, tip: held ? tf("tr.typecHeld", { list }) : tc.n ? tf("tr.typecMembers", { list }) : tf("tr.typecMembersFlat", { list }) };
}
// 台指期目標口數取整 = 機器對帳器的規則 sign(x)·floor(|x|+0.5)(−0.5 → −1;Math.round(−0.5) 是 −0,會差一口)
function trRoundLots(x) { return (x < 0 ? -1 : 1) * Math.floor(Math.abs(x) + 0.5 + 1e-9); }   // 1e-9 = 機器 lib/portfolio 與網頁 pfRoundLots 同一個:浮點加總的 2.4999… 歸到 3
/* 金額表一列的區(§9.2)。sym = 單一標的(states 的 symbol,沒有就清單的);tc = trTypeC(state);portfolio = 清單說它是投資組合;
   qmap = 回報頂層 quote_ccy({策略: 幣別 | null},舊 runtime 沒這欄)。順序:台指期 → quote_ccy(有值就照用;null = runtime 判不出市場,
   往下推)→ 台股代號 TWD／白名單尾碼 → 投資組合成分全同一種已知幣別 → 未定 */
function trRowZone(n, sym, tc, portfolio, qmap) {
  const isC = !!tc || portfolio === true;
  if (!isC && trTxfSpec(sym)) return TR_ZONE_LOTS;
  if (qmap && typeof qmap === "object" && Object.prototype.hasOwnProperty.call(qmap, n)) {
    const q = qmap[n];
    if (typeof q === "string" && q.trim()) return q.trim().toUpperCase();
  }
  if (!isC) return trSuffixZone(sym) || TR_ZONE_UNKNOWN;
  // 還沒算出權重的投資組合退回清單的標的(可能是「2330,2454」一串),逐檔推
  const syms = tc && tc.keys.length ? tc.keys : String(sym || "").split(/[\s,;|/]+/).filter(Boolean);
  const zs = new Set(syms.map((x) => (trTxfSpec(trCanonSym(x)) ? null : trSuffixZone(x))));
  return zs.size === 1 && !zs.has(null) ? [...zs][0] : TR_ZONE_UNKNOWN;
}
/* 部位表一個標的的區:台指期 → 口數區;台股代號 → TWD;其餘看貢獻這一檔的策略的 quote_ccy(全部同一個才算),再退尾碼,
   最後退策略市場:貢獻策略全是 us_stock → USD(quote_ccy 是 null 的舊 runtime、或 runtime 判不出的,AMZN 沒有尾碼可推)。
   quotes = 貢獻策略各自的 quote_ccy 值(沒有就空陣列);markets = 各自的 trSrcMarket */
function trSymZone(sym, quotes, markets) {
  const s = trCanonSym(String(sym || "").replace(/@spot$/i, ""));
  if (trTxfSpec(s)) return TR_ZONE_LOTS;
  if (TR_TWSTOCK_RE.test(s)) return TR_TXF_CCY;
  const q = new Set((quotes || []).filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim().toUpperCase()));
  if (q.size === 1) return [...q][0];
  const z = trSuffixZone(s);
  if (z) return z;
  return Array.isArray(markets) && markets.length && markets.every((m) => m === "us_stock") ? "USD" : TR_ZONE_UNKNOWN;
}
// 策略的市場:雲端讀清單的 srcMarket,本機讀回報 r 的 strategy_kinds(同 trZoneOf)
function trSrcMarket(r, n) {
  const list = typeof TR !== "undefined" && TR && Array.isArray(TR.list) ? TR.list : [], x = list.find((y) => y.name === n) || {};
  const k = r && r.strategy_kinds && typeof r.strategy_kinds === "object" ? r.strategy_kinds[n] : null;
  return x.srcMarket || (k && k.market) || null;
}
/* 美股純代號(AMZN):沒有交易所尾碼、不是台指期／台股,貢獻的策略全是 us_stock。不分交易所(模擬交易也是)都不會自動下單——
   lib/data._us_require_desktop 擋掉實盤 tick。sym 沒有(草稿還沒有標的)只看市場。標籤、帳上／差額、會送單共用這一條 */
function trUsNoAuto(r, sym, names) {
  if (!Array.isArray(names) || !names.length || !names.every((n) => trSrcMarket(r, n) === "us_stock")) return false;
  if (sym == null || sym === "") return true;
  const s = trCanonSym(String(sym).replace(/@spot$/i, ""));
  return !trTxfSpec(s) && !TR_TWSTOCK_RE.test(s) && !trSuffixZone(s);
}
/* 帳戶幣那一區(§9.3 排序用):台灣期貨券商 → 口數區;加密所 → 帳戶幣那一區。
   OKX 回的帳戶幣是 USD(totalEq 以美元計)而交易對是 USDT:平台匯率表 USDT 與 USD 同為 1,USD 帳戶當 USDT 區。
   沒綁、帳戶幣未知 = null;加密帳戶的幣是 TWD(讀帳退路錯了)也 null——TWD 區是台股,不在這個帳戶上 */
function trMultZone(venueId, acct, keys) {
  if (!venueId) return null;
  if (venueId === "capital" || venueId === "president") return acct === TR_TXF_CCY ? TR_ZONE_LOTS : null;
  if (!acct || acct === TR_TXF_CCY) return null;
  return acct === "USD" && keys.indexOf("USDT") >= 0 ? "USDT" : acct;
}
/* 區的順序(§9.3):固定 USDT → USDC → 其他(字母序)→ TWD → 台指期(口)→ 幣別未定;綁定的交易所交易的區移到最前面,
   帳戶幣那一區第一。台灣期貨券商只交易口數區;加密所交易台幣以外的已知區 */
function trZoneOrder(keys, venueId, acctZone) {
  const tw = venueId === "capital" || venueId === "president";
  const bound = (k) => !!venueId && (tw ? k === TR_ZONE_LOTS : k !== TR_TXF_CCY && k !== TR_ZONE_LOTS && k !== TR_ZONE_UNKNOWN && k !== "USD");
  const rank = (k) => (k === "USDT" ? 0 : k === "USDC" ? 1 : k === TR_TXF_CCY ? 3 : k === TR_ZONE_LOTS ? 4 : k === TR_ZONE_UNKNOWN ? 5 : 2);
  const head = (k) => (!bound(k) ? 2 : k === acctZone ? 0 : 1);
  return [...new Set(keys)].sort((a, b) => head(a) - head(b) || rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}
/* 綁定的交易所交不交易這個標的(§9.1、§9.6;同網頁 pfRowCovered):只認「確定不交易」的兩種——台灣期貨券商(kind "tw")的非台指期、
   加密所與模擬交易(kind "crypto")的台指期與台股。認不得的交易所(kind null)一律當有交易:不能藏掉它的差額與拒單 */
function trTradesSym(kind, sym) {
  const s = trCanonSym(String(sym || "").replace(/@spot$/i, ""));
  // 模擬交易(lib/order_paper):台指期以口數成交、保證金對淨值檢查;台股要機器的 lib 會換匯(回報 can_paper_twstock),否則外殼鎖住(同 trPaperTw)
  return kind === "tw" ? !!trTxfSpec(s) : !((kind === "crypto" || kind === "paper") && TR_TWD_RE.test(s) && !(kind === "paper" && (trTxfSpec(s) || trPaperTwOk())));
}
// 1 USD 換多少該幣(api get_fx_rates;USD 本身 1);拿不到 = null
function trFxRate(fx, ccy) {
  if (ccy === "USD") return 1;
  const r = fx && typeof fx === "object" && Object.prototype.hasOwnProperty.call(fx, ccy) ? fx[ccy] : null;
  return typeof r === "number" && isFinite(r) && r > 0 ? r : null;
}
/* 每區小計與表底合計(§9.4、§9.7)。amounts {策略: 金額或口數};zoneOf(name) → 區;
   money(name, v) → 錢(口數列換名目 TWD,沒報價 = null);fx / base = 匯率表與顯示幣別。回:
   - zones {區: { rows, sum, money }}:sum = 原單位加總(錢區的小計),money = 換成錢(口數區是名目 TWD;換不了 null)
   - total { v, ccy, approx, parts, skipped }:只有一區 = 那一區的錢(口數區是 ≈ 名目 TWD,未定區沒有幣別);兩區以上 = 換成顯示幣別的 ≈,
     未定區不算(skipped 列名),缺匯率或缺報價 v = null */
function trZoneTotals(amounts, zoneOf, money, fx, base) {
  const zones = {}, order = [];
  Object.keys(amounts || {}).forEach((n) => {
    const a = Number(amounts[n]) || 0, z = zoneOf(n);
    if (!Object.prototype.hasOwnProperty.call(zones, z)) { zones[z] = { rows: 0, sum: 0, money: 0 }; order.push(z); }
    const Z = zones[z], m = money ? money(n, a) : a;
    Z.rows++; Z.sum += a; Z.money = Z.money == null || m == null ? null : Z.money + m;
  });
  const ccyOf = (z) => (z === TR_ZONE_LOTS ? TR_TXF_CCY : z === TR_ZONE_UNKNOWN ? null : z);
  const total = { v: null, ccy: null, approx: false, parts: [], skipped: [] };
  if (order.length <= 1) {
    const z = order[0];
    total.v = z == null ? 0 : zones[z].money; total.ccy = z == null ? null : ccyOf(z); total.approx = z === TR_ZONE_LOTS;
  } else {
    const b = base && trFxRate(fx, base) ? base : "USD", rb = trFxRate(fx, b);
    let v = 0;
    order.forEach((z) => {
      if (z === TR_ZONE_UNKNOWN) { Object.keys(amounts).forEach((n) => { if (zoneOf(n) === z && Number(amounts[n]) > 0) total.skipped.push(n); }); return; }
      const m = zones[z].money, r = trFxRate(fx, ccyOf(z));
      total.parts.push({ zone: z, ccy: ccyOf(z), v: m });
      v = v == null || m == null || r == null ? null : v + (m / r) * rb;
    });
    total.v = v == null ? null : Math.round(v); total.ccy = b; total.approx = true;
  }
  return { zones, order, total };
}
/* 淨值倍數(表底合計後面那一個):綁定的交易所會下單的列全部換成帳戶幣加總 ÷ 淨值。
   台灣期貨券商 = 口數列的名目 TWD ÷ TWD 淨值(缺報價 = null)。其他(加密所、模擬、認不得的交易所)= 台股與口數列以外的每一列,
   含幣別未定的(多算比漏算安全);換帳戶幣用平台匯率,缺任一邊匯率或幣別未定就當 1:1——穩定幣之間這就是實際值,丟掉那一列才會把倍數講小。
   模擬交易會下台股時(paperTw = 機器回報 can_paper_twstock)台股列也算:台幣換帳戶幣,缺匯率 = null。
   沒綁、帳戶幣未知、加密帳戶讀成 TWD、沒有淨值、一列都沒算進去 = null(不寫 0.00×) */
function trEquityMult(amounts, zoneOf, money, venueId, acct, equity, fx, paperTw) {
  if (!venueId || !acct || !(typeof equity === "number" && isFinite(equity) && equity > 0)) return null;
  const tw = venueId === "capital" || venueId === "president";
  if (tw !== (acct === TR_TXF_CCY)) return null;
  const rA = trFxRate(fx, acct);
  let v = 0, any = false;
  for (const n of Object.keys(amounts || {})) {
    const a = Number(amounts[n]) || 0, z = zoneOf(n);
    if (tw) {
      if (z !== TR_ZONE_LOTS) continue;
      const m = money ? money(n, a) : a;
      if (m == null) return null;
      v += m; any = true;
    } else {
      if (z === TR_TXF_CCY && venueId === "paper" && paperTw) { if (!a) continue; const rT = trFxRate(fx, TR_TXF_CCY); if (!rA || !rT) return null; v += (a * rA) / rT; any = true; continue; }
      // 模擬交易以口數成交台指期、保證金對淨值檢查:口數列的名目(TWD)也算進倍數(Windows e2e 10-14);缺報價或匯率 = 不知道
      if (z === TR_ZONE_LOTS && venueId === "paper") { const m = money ? money(n, a) : null; if (!a) continue; const rT = trFxRate(fx, TR_TXF_CCY); if (m == null || !rA || !rT) return null; v += (m * rA) / rT; any = true; continue; }
      if (z === TR_ZONE_LOTS || z === TR_TXF_CCY) continue;
      const rZ = z === TR_ZONE_UNKNOWN ? null : trFxRate(fx, z);
      v += rA && rZ ? (a * rA) / rZ : a; any = true;
    }
  }
  return any ? v / equity : null;
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
/* 換合約的口數換算:曝險不變——基準(口數 × 每點價值)÷ 新合約每點價值,half-up;不足一口就是 0(不自動補成 1 口——
   微台 1 口 → 大台補 1 口 → 再換回微台變 20 口,曝險放大 20 倍;Windows e2e 10-14)。畫面講「0 口(不足一口)」、讓用戶自己決定 */
function trCtConv(basis, cv) { return basis > 0 ? Math.floor(basis / cv + 0.5) : 0; }
/* 分兩步存檔的第一步(換合約又改口數)照舊「最少 1 口」:runtime 的曝險檢查允許 1 口代表不到 1.5 口;第一步送 0 口的話,
   對帳器可能在兩步之間先平倉、再開回來(同網頁)。只用在 trCtSteps,畫面與用戶看得到的口數一律 trCtConv */
function trCtConvStep(basis, cv) { return basis > 0 ? Math.max(1, Math.floor(basis / cv + 0.5)) : 0; }
/* 機器有曝險檢查(CONTRACT_EXPOSURE_MISMATCH):同一次存檔換了合約、口數又不是單純換算的會被拒。這種拆兩步:
   先送「換合約 + 從存著的口數換算的口數」,ack 成功再送真正的口數(同網頁 pfCtSteps)。ctStored(n) = 存著的生效合約 */
function trCtSteps(amounts, storedNow, ct, ctStored) {
  if (!ct) return [{ amounts }];
  const first = Object.assign({}, amounts); let split = false;
  Object.keys(ct).forEach((n) => {
    const from = ctStored(n), old = storedNow[n] || 0, nx = amounts[n] || 0;
    if (!from || from === ct[n] || !(old > 0 && nx > 0)) return;
    const conv = trCtConvStep(old * TR_TXF_SPECS[from].cv, TR_TXF_SPECS[ct[n]].cv);
    if (conv !== nx) { first[n] = conv; split = true; }
  });
  const last = { amounts, contracts: ct };
  return split ? [{ amounts: first, contracts: ct }, last] : [last];
}
// 機器拒絕換合約的原因(ack error「ValueError: CODE: 中文」)→ 字串表的 key;認不得回 null(同網頁 pfCtErrText)
function trCtErrKey(err, running) {
  const m = /^(?:\w+Error: )?([A-Za-z_ ]+?)(?::|$)/.exec(String(err || "").trim()), code = m ? m[1] : "";
  if (code === "CONTRACT_NEEDS_UPDATE" || code === "CONTRACT_SWITCH_UNSUPPORTED") return running ? "ct.errUpdate" : "ct.errRun";
  return { CONTRACT_HALTED: "ct.errRun", CONTRACT_EXPOSURE_MISMATCH: "ct.errSplit", CONTRACT_GATED: "ct.errGated", CONTRACT_PARKED: "ct.errParked",
    NOT_TXF_FAMILY: "ct.errNotTxf", CONTRACT_TYPE: "ct.errNotTxf", BAD_CONTRACT: "ct.errBad", "bad contracts": "ct.errBad" }[code] || null;
}
// 總訊號部位表的口數目標(同網頁 pfLotsTarget):多支策略加總後取整(同對帳器 half-up);跟原值不同才留 raw(進 tooltip)
function trLotsTarget(raw) { const lots = trRoundLots(raw) || 0; return { lots, raw: lots === raw ? null : raw }; }
function trDirty(names, stored, edits) { return names.some((n) => edits[n] != null && edits[n] !== (stored[n] || 0)); }
/* ── 選擇策略 picker(spec-desktop-strategy-picker;照雲端工作頁 psOpen / psApply)──
   候選 = 有回測的 ∪ 目前在表裡的(names)。checked = 在表裡(不看金額,$0 也算);gone = 清單找不到(已存殘留,
   留在清單裡唯一用途是讓人取消勾選——雲端的 names 已把讀不到的濾掉,所以只有這台電腦會出);
   locked = Type C、不在表裡、機器端不支援(判的是「能不能加進來」,跟表列的 `stored[n] > 0` 是「能不能從 0 撥錢」不同;
   已在表裡的存量不鎖,不然存不回去)。順序 = 側欄的順序(0.1.23 Wei:呼叫端先把 list 過 sfApplyOrder,這裡照 list 序、不再照顯示名排;
   gone 的在最底)。flags = 側欄的旗標表 {內部名: 1–3}(這台電腦 SF.flags、雲端 strat_flags),列帶 flag(1–3,其餘 null,同 sfFlagId)。 */
function trPickRows(list, names, canTrade, paper, txfOnly, flags) {
  const by = {}; list.forEach((x) => { by[x.name] = x; });
  const fl = flags && typeof flags === "object" && !Array.isArray(flags) ? flags : {};
  const seen = new Set(); list.forEach((x) => { if (x.hasBacktest || names.indexOf(x.name) >= 0) seen.add(x.name); }); names.forEach((n) => seen.add(n));
  return [...seen].map((n) => { const x = by[n], inCur = names.indexOf(n) >= 0, f = x ? fl[n] : null;
    // 模擬交易是 USDT 帳戶:台幣計價的標的(台指期、台股)進不來(e2e 0.1.8 #91:台指期那一列的金額其實是口數、畫面寫 USDT)。
    // 統一期貨只下台指期:標的不是 TXF / MXF / TMF 的(BTCUSDT、台股、組合)進不來——runtime _cmd_amounts 存的時候也擋(NOT_TXF)。
    // 已在表裡的存量不鎖(鎖住就取消不了),只帶原因;跟 Type C 同時成立時只講這一條——它是更根本的原因
    // 統一:跟 runtime NOT_TXF 同一條——標的看得出來、而且不是 TXF／MXF／TMF(不去 R1:TXFR1 runtime 存的時候也拒)才鎖;看不出來不判(fail-open)。
    // 投資組合例外(稽核第三輪 P1-A,同網頁 pfTxfOnly):成分不是台指期,統一下不了——鎖
    const twd = paper === true && !!x && x.twd === true && !trTxfSpec(x.symbol), txf = txfOnly === true && !!x && (x.portfolio === true || (!!x.symbol && !trTxfSpec(x.symbol))), typeC = !!x && !!x.portfolio && !inCur && !canTrade;
    // 已勾的(在表裡)一律不鎖:runtime 會擋「路由到統一／群益的 Type C」存任何金額,出路只有取消勾選——鎖了就卡死(稽核)。只擋新勾
    return { name: n, display: x && x.displayName ? x.displayName : n, checked: inCur, gone: !x, locked: !inCur && (typeC || twd || txf),
      note: twd ? (inCur ? "twdKeep" : "twd") : txf ? (inCur ? "txfKeep" : "txf") : typeC ? "typeC" : null, flag: Number.isInteger(f) && f >= 1 && f <= 3 ? f : null }; });
}
// picker 的側欄偏好:雲端 = api 回的 strat_order / strat_flags(同 envPaintSide);這台電腦 = stratflags.js 的 SF(還沒載入就沒有:原序、無旗標)
function trPickPrefs(S, sf) {
  const c = S && S.env === "cloud" ? (S.st && S.st.cloud) || {} : null;
  const o = c ? c.strat_order : sf && sf.order, f = c ? c.strat_flags : sf && sf.flags;
  return { order: Array.isArray(o) ? o : [], flags: f && typeof f === "object" && !Array.isArray(f) ? f : {} };
}
/* 這支策略的標的是不是台幣計價:台指期(TXF / MXF / TMF,runtime command_listener._TXF_ASSET_SPECS 那三個)或台股代號
   (4–6 位數字,可帶一個英文字尾:2330、00878、00631L;帶 .TW / .TWO 也算)。syms = 單一標的與組合的標的清單;看不出來 = 不是(不擋) */
const TR_TWD_RE = /^(?:TXF|MXF|TMF|\d{4,6}[A-Z]?(?:\.TWO?)?)$/;
function trIsTwd(syms) { return (Array.isArray(syms) ? syms : [syms]).some((s) => typeof s === "string" && TR_TWD_RE.test(s.trim().toUpperCase())); }
// 每一檔都是台股(至少一檔):Type C 推不出區時退回幣別只認這個——「有一檔台股」(trIsTwd)混了加密也是 true
function trAllTwd(syms) { const v = (Array.isArray(syms) ? syms : [syms]).filter((s) => typeof s === "string" && s.trim()); return v.length > 0 && v.every((s) => TR_TWD_RE.test(s.trim().toUpperCase())); }
// 程式碼頂層的 UNIVERSE = [...](Type C 的標的清單;stats.json 不帶)。只收字面字串,動態組出來的讀不到 = 空陣列。
// 先去掉 # 註解(同一行引號裡的 # 不算),同 lib/portfolio _strip_py_comments:註解裡的代號或 ] 不能多算、也不能截斷
function trUniverse(code) {
  const strip = (line) => { let q = null, esc = false;
    for (let i = 0; i < line.length; i++) { const ch = line[i];
      if (esc) esc = false; else if (q) { if (ch === "\\") esc = true; else if (ch === q) q = null; }
      else if (ch === '"' || ch === "'") q = ch; else if (ch === "#") return line.slice(0, i); }
    return line; };
  const m = /^UNIVERSE\s*=\s*\[([^\]]*)\]/m.exec((typeof code === "string" ? code : "").split("\n").map(strip).join("\n"));
  return m ? (m[1].match(/["'][^"']{1,32}["']/g) || []).map((s) => s.slice(1, -1)) : [];
}
/* picker 的勾選是草稿(0.1.26 Wei):按「確定」只改表上列哪些,按「儲存」才連金額一起寫進 amounts(進排程、亮呼吸點、算訊號)。
   回草稿跟已存的差在哪:added = 勾了、不在 stored;removed = 在 stored、被取消勾選(金額多少都算)。picked 為 null = 跟著 stored 走,沒有差。
   keep = 雲端讀不到的存量(trPickKeep):框裡沒列、用戶沒看到,不算移出,儲存時原樣帶著送(同 trAmountsToSend 的 keep)。 */
function trPickDiff(picked, stored, keep) {
  const k = Array.isArray(keep) ? keep : [], st = stored || {};
  if (!picked) return { added: [], removed: [] };
  return { added: [...picked].filter((n) => !(n in st)), removed: Object.keys(st).filter((n) => !picked.has(n) && k.indexOf(n) < 0) };
}
function trPickDirty(picked, stored, keep) { const d = trPickDiff(picked, stored, keep); return d.added.length + d.removed.length > 0; }
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
// 模擬交易的台股(機器的 lib 回報 can_paper_twstock):現股帳戶——不管 MARKET 一律 @spot、每支策略自己的空頭壓 0 再加總,不抵掉別支的多單
// (同 lib/portfolio.aggregate_portfolio 的 _paper_tw_market 與空頭歸零;網頁 pfClientTargets 同一條)。照目標分列的地方都要用同一條,key 才對得上。
// 逐支看 config.exchanges[名](同 lib 與 runtime portfolio_reporter.tw_lots),不看整台第一家:多家同綁時路由到別家的那支不併進 @spot。
// 這支還沒有路由紀錄(剛加、還沒存;舊 runtime 沒有 exchanges)= runtime 存的時候繼承唯一綁著的那家:只綁模擬交易一家才算,
// 同時綁多家時 runtime 不知道要繼承誰,不當模擬交易(同網頁 pfPaperOf);空字串 = 沒路由,不算
function trPaperOf(n) {
  if (typeof PAPER === "undefined" || typeof trPaperTwOk !== "function" || !trPaperTwOk()) return false;
  const r = (typeof trReport === "function" && trReport()) || {}, ex = r.config && typeof r.config.exchanges === "object" ? r.config.exchanges : null;
  if (ex && Object.prototype.hasOwnProperty.call(ex, n)) return ex[n] === PAPER;
  const ids = trVenueIds(r);
  return ids.length === 1 && ids[0] === PAPER;
}
// 有交易所綁著、路由卻是 ""(解除綁定後還沒重存下單設定):對帳器不交易它(lib/portfolio 標 unrouted、原樣持有),目標與拆解都貢獻 0
// (同網頁 pfUnrouted、runtime tw_lots;整台那支 trUnrouted 回的是名單,閘門同一條)。一家都沒綁時 runtime 沒有可繼承的,每支都是 "":
// 那是「只看訊號」,照訊號算目標與張數,不當沒路由
function trRouteBlank(n) {
  const r = (typeof trReport === "function" && trReport()) || {}, c = r.config, ex = c && typeof c.exchanges === "object" ? c.exchanges : null;
  return !!ex && Object.prototype.hasOwnProperty.call(ex, n) && ex[n] === "" && trVenueIds(r).length > 0;
}
function trTwCash(sym, paper) { return !!paper && TR_TWSTOCK_RE.test(trCanonSym(sym)); }
// 目標部位 = 已存金額 × 訊號,按標的加總(同機器端 aggregate;現貨不能做空,負的壓 0)
function trClientTargets(amounts, states, contracts) {
  const out = {};
  Object.keys(amounts || {}).forEach((n) => {
    const s = (states || {})[n], paperTw = trPaperOf(n), twCash = (sym) => trTwCash(sym, paperTw), a = trRouteBlank(n) ? 0 : amounts[n];
    // 投資組合(Type C,lib/runner.typec_live_state):每個資產 金額 × 權重,現貨的負權重壓 0(同 lib/portfolio.aggregate_portfolio)
    if (s && s.weights && typeof s.weights === "object") {
      Object.keys(s.weights).forEach((sym) => {
        let w = Number(s.weights[sym]); if (!isFinite(w)) w = 0;
        const spot = s.market === "spot" || twCash(sym);
        if (spot && w < 0) w = 0;
        if (!w) return;   // 0 權重的候選不開一列目標 0(§8.3);帳戶上還有部位時,那一列由「實際」帶出來
        const k = trCanonSym(sym) + (spot ? "@spot" : "");
        out[k] = (out[k] || 0) + a * w;
      });
      return;
    }
    if (!s || !s.symbol) return;
    let pos = typeof s.position === "number" ? s.position : 0;
    const sym = trCanonSym(trEffSym(n, s.symbol, contracts)), cash = twCash(sym);
    if (cash && pos < 0) pos = 0;
    const k = sym + (s.market === "spot" || cash ? "@spot" : "");
    out[k] = (out[k] || 0) + a * pos;
  });
  Object.keys(out).forEach((k) => { if (/@spot$/.test(k) && out[k] < 0) out[k] = 0; });
  return out;
}
/* 台股列的股數(0.1.27,= runtime portfolio_reporter.tw_lots,網頁同一條):每支策略自己的部分除以它 state 的 raw_closes[SYM]
   (目標最後變動那一輪的未還原收盤價,目標沒變不重算)再加總。券商(含沒綁交易所、照著去下單):整股單＋零股單,lots = 整張、odd = 零股(= runtime odd_shares);
   路由到模擬交易的策略(trPaperOf,逐支)照模擬盤的成交規則整股下單(lib/order_paper._tw_signed):不管 MARKET 都當現股(@spot、自己的空頭壓 0,同 trClientTargets);
   這一列每支貢獻策略都是模擬交易才寫 unit "shares"(捨去到整股),否則 "lots"。trRouteBlank 的策略(有綁交易所、路由空字串)不算:對帳器不交易沒路由的策略(lib 跳過)。
   有金額的貢獻策略只要一支沒有價格(舊 lib、那一輪抓價失敗)就回 null:那一列照舊寫 TWD */
const TW_LOT_SHARES = 1000;
function trTwLots(key, amounts, states) {
  const spotKey = /@spot$/.test(key), sym = key.replace(/@spot$/, "");
  if (!TR_TWSTOCK_RE.test(sym)) return null;
  let twd = 0, shares = 0, date = null, est = false, any = false, allPaper = true;
  for (const n of Object.keys(amounts || {})) {
    if (trRouteBlank(n)) continue;
    const s = (states || {})[n], a = Number(amounts[n]), paperTw = trPaperOf(n), spot = !!s && (s.market === "spot" || paperTw);
    if (!s || !a || !isFinite(a) || spot !== spotKey) continue;
    let w;
    if (s.weights && typeof s.weights === "object") {
      const k0 = Object.keys(s.weights).find((k) => trCanonSym(k) === sym);
      w = k0 === undefined ? 0 : Number(s.weights[k0]);
      if (spotKey && w < 0) w = 0;
    } else if (s.symbol && trCanonSym(s.symbol) === sym) {
      w = typeof s.position === "number" ? s.position : 0;
      if (paperTw && w < 0) w = 0;
    } else continue;
    if (!w || !isFinite(w)) continue;
    const px = s.raw_closes && typeof s.raw_closes === "object" ? Number(s.raw_closes[sym]) : NaN;
    if (!(px > 0) || !isFinite(px)) return null;
    any = true; allPaper = allPaper && paperTw; twd += a * w; shares += (a * w) / px;
    const d = s.raw_close_dates && s.raw_close_dates[sym];
    if (typeof d === "string" && (!date || d > date)) date = d;
    if (Array.isArray(s.raw_closes_est) && s.raw_closes_est.indexOf(sym) >= 0) est = true;
  }
  if (!any) return null;
  if (spotKey && twd < 0) twd = shares = 0;
  const sg = shares < 0 ? -1 : 1, whole = Math.floor(Math.abs(shares) + 1e-9), lots = Math.floor(Math.abs(shares) / TW_LOT_SHARES + 1e-9) * sg;
  return { lots, odd: (whole - Math.abs(lots) * TW_LOT_SHARES) * sg, shares: whole * sg, unit: allPaper ? "shares" : "lots", twd, price: shares ? Math.abs(twd) / Math.abs(shares) : null, date, est };
}
/* 啟動框「補齊部位」台股那一筆的股數:模擬盤整股成交(tw.unit "shares",trTwLots),差額 d(TWD)÷ 價格捨去到整股;
   帳上還沒有部位時就是部位表那一格的 tw.shares。不是 "shares"(真實券商、舊 lib 沒價格)= null,照舊寫 TWD */
function trCatchShares(d, tw) {
  if (!tw || tw.unit !== "shares" || !(tw.price > 0)) return null;
  return Math.floor(Math.abs(d) / tw.price + 1e-9);
}
/* 台股一般交易時段(台北 09:00–13:30、週一到週五;台灣沒有日光節約,直接 +8 小時)。
   跟 lib/paper_data.tw_session_open 同一個時段;假日表借機器已查到的今天那一筆(回報 tw_trading_day,
   lib 寫在 state/paper_tw_day.json)。沒有那一筆(還沒查過、查不到假日表)時只看星期,國定假日會講成開盤 */
function trTwSessionOpen(ms, day) {
  const d = new Date(ms + 8 * 3600000), wd = d.getUTCDay(), m = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (day && day.date === d.toISOString().slice(0, 10) && day.trading === false) return false;
  return wd >= 1 && wd <= 5 && m >= 540 && m < 810;
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
/* 第一次讀帳還沒回來:沒有對帳快照、綁定的交易所也都還沒有任何讀帳結果(成功或失敗都算讀到)。這時「實際」是不知道,不是 0 */
function trFirstReadPending(r) { return !r.last_reconcile && !trVenueIds(r).some((id) => !!trLiveEntry(r, id)); }
/* 拒單要掛哪幾筆:`order_errors` 是「最近 5 筆下單失敗」,機器端**從來不清**(lib/portfolio._record_order_error 只 append),
   照最新那一筆畫 = 把歷史當現況(Wei 在 Electron 44 實機看到 22:26 那句掛在已經改好的表下面)。規則:只掛標的現在**仍欠著一張會觸發下單的差額**的;
   改了金額或補成交 → 差額進門檻內 → 那筆是歷史(總覽事件照舊逐筆列) */
/* 台灣期貨那條腿的代號 → 列用的家族代號(群益平倉的 TM2610、統一的 TXFJ6 / MXFJ6)。"*" = 整台機器,原樣 */
function trTwFutCanon(sym) { const s = trCanonSym(String(sym || "")); if (s === "*") return s; const m = /^(TXF|MXF|TMF)/.exec(s); return m ? m[1] : trCapitalCanon(s); }
/* 市場小標:台指期 = 期貨、台股代號 = 現貨(券商現股沒有永續);其餘才看 @spot／market 分現貨與合約。
   runtime 對沒宣告 MARKET 的策略一律回 swap,台股、台指期也是——不能只看那一個值。fut = 呼叫端已知是口數列。
   合約代碼只認完整形狀:trCapitalCanon 的前綴比對會把 TX 開頭的加密幣也當台指期 */
const TR_TWFUT_RE = /^(?:(?:TXF|MXF|TMF)(?:[A-Z]\d)?(?:R1)?|(?:MTX|TX|TM)\d{4})$/;
function trMktKey(sym, spot, fut) {
  const s = trCanonSym(String(sym || "").trim().replace(/@spot$/i, ""));
  if (fut || TR_TWFUT_RE.test(s)) return "tr.mkt.fut";
  if (TR_TWSTOCK_RE.test(s)) return "tr.mkt.spot";
  return spot || /@spot$/i.test(String(sym || "")) ? "tr.mkt.spot" : "tr.mkt.swap";
}
/* 每個還欠著單的標的各掛它最新的一筆(同網頁 pfLiveOrderErrs;兩檔同時被拒兩列都要看得到)。回 Map(列 key → 那一筆)。
   close-all(全部平倉沒做成,error 以「close-all:」開頭)例外:只在沒在跑時掛——按了啟動那口部位就歸對帳器管——而且該列實際不是 0;
   "*"(整台機器,呼叫端畫在表底)只認台灣期貨券商那筆、看還有沒有台指期部位。ctx = { open: Set(實際不是 0 的列), twOpen, running };缺 = close-all 一律不掛 */
function trLiveOrderErrs(errs, pending, ctx) {
  const out = new Map();
  if (!Array.isArray(errs)) return out;
  const pendSet = pending || new Set();
  /* 之後同一個標的已經有成交的單:那一筆失敗已經過去了,不再掛(Windows e2e 10-14:成功下單、平倉之後還掛著「上次下單失敗」)。
     orders = 報告的下單紀錄;有任何一條腿 executed_qty > 0 才算成交 */
  const okAt = {};
  (ctx && Array.isArray(ctx.orders) ? ctx.orders : []).forEach((o) => {
    if (!o || typeof o !== "object" || !o.symbol || !(Array.isArray(o.legs) && o.legs.some((l) => l && Number(l.executed_qty) > 0))) return;
    const tw = o.exchange === "capital" || o.exchange === "president", k = tw ? trTwFutCanon(o.symbol) : trCanonKey(o.symbol), at = trMs(o.ts) || 0;
    if (!okAt[k] || at > okAt[k]) okAt[k] = at;
  });
  errs.forEach((e) => {
    if (!e || typeof e !== "object") return;
    const closeAll = String(e.error || "").indexOf("close-all:") === 0, tw = e.exchange === "capital" || e.exchange === "president";
    const k = tw && (closeAll || e.exchange !== "capital") ? trTwFutCanon(e.symbol) : trCanonKey(e.symbol);
    if (closeAll) {
      if (!ctx || ctx.running) return;
      if (k === "*" ? !(tw && ctx.twOpen) : !ctx.open.has(k)) return;
    } else if (!pendSet.has(k)) return;
    if (okAt[k] && okAt[k] > (trMs(e.ts) || 0)) return;
    const prev = out.get(k);
    if (!prev || (trMs(e.ts) || 0) >= (trMs(prev.ts) || 0)) out.set(k, e);
  });
  return out;
}
/* 列下面那一句(白話不帶標的:它就掛在那個標的的列下面;同網頁 pfOrderErrPlain / pfOrderErrRaw)。認得的原因 = 在地化句去掉開頭的標的;
   認不得 = 原文拿掉機器端的分類前綴、截 200 */
function trOrderErrRaw(err) { return String(err == null ? "" : err).replace(/^close-all: /, "").replace(/^\s*\[order_reject:[a-z_]+\]\s*/, "").slice(0, 200); }
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
function trRejectCode(err) {
  const s = String(err == null ? "" : err), m = TR_REJECT_CODE_RE.exec(s); if (!m) return null;
  // runtime 可能一次點名好幾支(NEEDS_ROUTING:「a」、「b」…):全部收進 names,句子最多列三支
  const names = [m[2]], rest = s.slice(m.index + m[0].length), re = /^\u3001\u300c([A-Za-z0-9_-]{1,64})\u300d/;
  let k = rest, x; while ((x = re.exec(k))) { names.push(x[1]); k = k.slice(x[0].length); }
  const mk = /\u662f(\u53f0\u6307\u671f|\u500b\u80a1\u671f\u8ca8|\u53f0\u80a1)\u7b56\u7565/.exec(rest);   // MARKET_VENUE 反方向:「是台指期／個股期貨／台股策略」
  return { code: m[1], name: m[2], names, market: mk ? mk[1] : null, crypto: /\u52a0\u5bc6\u8ca8\u5e63\u4ea4\u6613\u6240/.test(rest) };
}
// 其餘拒絕照原文放進「沒有接受這個指令(…)」:去掉 Python 的例外名與開頭的代碼(同 trAskAccount、網頁)
function trRejectText(err) {
  const s = String(err == null ? "" : err).replace(/^(?:[A-Za-z]*Error: )?(?:[A-Z][A-Z0-9_]+: )?/, "");
  // 檔案被鎖(Windows 防毒／備份／索引開著)那一類:講成人話,不把 WinError 與完整路徑丟給用戶(Windows e2e 10-14)
  if (/\[WinError (5|32|33)\]|Access is denied|PermissionError|EACCES|EBUSY|being used by another process/i.test(s)) return t("tr.err.fileLocked");
  // 路徑一律遮掉:引號包住的(Windows 磁碟機、絕對路徑、~/)、沒引號的 C:\…、~/…、/Users /home /opt /tmp /var /private /Library /Volumes /Applications 開頭的
  return s.replace(/'(?:[A-Za-z]:\\|\/|~\/)[^']*'/g, "…").replace(/"(?:[A-Za-z]:\\|\/|~\/)[^"]*"/g, "…")
    .replace(/(?:[A-Za-z]:\\[^\s,;)'"]+|~\/[^\s,;)'"]+|\/(?:Users|home|opt|tmp|var|private|Library|Volumes|Applications)\/[^\s,;)'"]+)/g, "…");
}
/* 部位表點策略名的落點(spec-0.1.12-pf-strategy-link §2):Type C 的進出場紀錄只有一句叫人去看回測數據,直接落那裡。
   沒有回測退程式碼、時光機退回測數據,由 rpTab / verShowTab 自己處理 */
function trStratTab(x) { return x && x.portfolio ? "bt" : "tr"; }
/* ── 存金額的確認框(canon design-system › Components「確認 modal(存金額與下單)」;spec tw-holdings-a1-save-preview §1-3、§7)──
   框上只判斷一件事:按下去會不會送單(trCfFiring)。會送 = 「儲存並下單」+ 模擬／真錢記號 + 下一輪要送的單;
   不送 = 「儲存金額」+ 目標有變的標的「原 → 新」。表只列會變的,時間只在表頭講一次。
   新策略(草稿)沒有 live 訊號:拿機器回報的回測最後一期(r.backtest_previews,runtime portfolio_reporter.backtest_previews)當它的訊號;
   已存的照 live(r.states),沒有 live 的也退回預覽。都沒有 = 算不出,這支不進表,表下一句講是哪一支、為什麼。 */
// 暫停中(HALT)一律走「儲存金額」框、不列單(§7-2):暫停語意改成完全凍結另案處理,上線前沿用 tr.saveWarnHalted 那句
// 剛按啟動(HALT 馬上要解除)算會送單:框寫「儲存並下單」,不照暫停中的「儲存金額」
function trCfFiring(st, pending) { return trMayFire(st, pending) && (trExecState(st) !== "halted" || trStartPending(pending)); }
// 一支策略撐的標的(部位表的 key):訊號／預覽的權重或 SYMBOL,沒有就退清單的 UNIVERSE／SYMBOL;判不出回 null
function trCfSymsOf(n, s, contracts) {
  // 模擬交易的台股不管 MARKET 一律現股(同 trClientTargets、lib/portfolio._paper_tw_market)
  const x = TR.list.find((y) => y.name === n) || {}, spot = ((s && s.market) || x.market) === "spot", paper = trPaperOf(n);
  const key = (k) => { const c = trCanonSym(k); return c + (spot || trTwCash(c, paper) ? "@spot" : ""); };
  if (s && s.weights && typeof s.weights === "object") return Object.keys(s.weights).map(key);
  const sym = (s && s.symbol) || (!x.portfolio && x.symbol);
  if (sym) return [key(trEffSym(n, sym, contracts))];
  return Array.isArray(x.universe) && x.universe.length ? x.universe.map(key) : null;
}
/* 存了這支,下單程式會不會替它送單:在跑(不是暫停中)、有連交易所、它至少有一個標的這家下得了;標的判不出算會。
   草稿列「存了就會下單」與存金額框的保守判斷(第一次讀帳前、預覽不是最新那根)共用這一條 */
function trCfWillOrder(n, s, contracts) {
  if (!trCfFiring(TR.st, TR.pending) || !trHasAccount(trReport() || {})) return false;
  const syms = trCfSymsOf(n, s, contracts), vk = trVenueKind(trVenueId()), r = trReport() || {};
  if (!syms) return !trUsNoAuto(r, null, [n]);
  return syms.some((k) => trTradesSym(vk, k) && !trUsNoAuto(r, k, [n]));
}
// 這台主機會回報所有回測過的策略的預覽嗎(runtime 1.1.134 起帶 backtest_previews):沒有 = 舊主機,草稿永遠等不到,不等
function trPvHost(r) { return !!r && !!r.backtest_previews && typeof r.backtest_previews === "object" && !Array.isArray(r.backtest_previews); }
/* 一支策略的預覽 → 狀態形狀(trClientTargets 吃的那種)+ 換算股數用的收盤價。舊主機只有 r.previews(投資組合、已存、最新那根) */
function trPvOf(r, n) {
  const src = trPvHost(r) ? r.backtest_previews : r && r.previews && typeof r.previews === "object" ? r.previews : {};
  const p = Object.prototype.hasOwnProperty.call(src, n) ? src[n] : null;
  if (!p || typeof p !== "object") return null;
  const at = typeof p.bar_at === "number" && isFinite(p.bar_at) ? p.bar_at : null, base = { raw_closes: p.raw_closes && typeof p.raw_closes === "object" && !Array.isArray(p.raw_closes) ? p.raw_closes : null, market: p.market, bar_at: at, bar_date: typeof p.bar_date === "string" && /^\d{4}-\d\d-\d\d$/.test(p.bar_date) ? p.bar_date : null, daily_tw: p.daily_tw === true, latest: trPvHost(r) ? p.latest === true : true };   // 舊主機的 previews 本來就只送最新那根;新主機沒寫 latest = 判不出,當不是最新
  if (p.weights && typeof p.weights === "object" && !Array.isArray(p.weights)) {
    const closes = p.closes && typeof p.closes === "object" && !Array.isArray(p.closes) ? p.closes : {};
    return Object.assign(base, { type: "portfolio", weights: p.weights, closes });
  }
  if (typeof p.symbol === "string" && p.symbol && typeof p.position === "number" && isFinite(p.position))
    return Object.assign(base, { symbol: p.symbol, position: p.position, close: typeof p.close === "number" && isFinite(p.close) && p.close > 0 ? p.close : null });
  return null;
}
// 數量(加密顆數):千以上取整、1 以上最多 4 位小數、1 以下 4 位有效數字;尾端的 0 拿掉
function trQtyFmt(v) {
  const a = Math.abs(v);
  if (!(a > 0) || !isFinite(a)) return "0";
  if (a >= 1000) return Math.round(a).toLocaleString("en-US");
  const s = a >= 1 ? a.toFixed(4) : a.toPrecision(4);
  return s.indexOf(".") >= 0 ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}
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
const ENV_CLOUD_CMDS = ["halt", "close_all", "resume", "resume_wait", "amounts", "execution", "delete_strategy", "credentials_remove", "retest_accounts", "book_account_confirm", "version_restore", "stats_refresh", "manage_optimize", "manage_backtest", "manage_cancel"];
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
    // 只有 { name, perf }(雲端沒有這一份 = null);讀不到就拋出——等更新績效的輪詢要分得出「讀不到」與「不在了」。不能拿去畫報告
    loadStrategyLite: async (name) => { const r = await host.cloudStrategyLite(name); if (r && r.code === "OK") return r.strategy || null; throw new Error("UNREACH"); },
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
    symbol: typeof x.symbol === "string" && x.symbol ? x.symbol : null, portfolio: x.is_portfolio === true, srcMarket: typeof x.market === "string" ? x.market : null }));
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
  if (kind === "signedOut" || pv === "revoked") return "relogin";   // 帳號那一支說登入失效(authState)也算:跟設定 › 帳號與方案同一個狀態
  if (pv === "offer" || pv === "noTrial") return "card";
  if (pv === "payFail") return "repay";
  if (pv === "planOn") return "web";
  return pv === "trial" || pv === "plan" || pv === "included" ? "start" : "unknown";
}
/* 側欄策略列名字前的綠呼吸點——照網頁 stratRunState(Wei 10-14,web 9c1d768c):點 = 這支在配置裡、主機照 K 線週期在算它的訊號。
   ① 剛存進組合的 5 分鐘內先亮(排程 / 首跑 / 回報還在路上);剛移出的 5 分鐘內先熄(回報要下一輪才少掉這個名字)
   ② 在策略組合裡(amounts 有這個 key,金額 0 也算;Wei 10-14)且主機回報有排程(scheduled 讀不到 = 不擋,不把整台的點都熄掉)。不看訊號多久前更新:日線、4h 一天大半時間
      本來就不會動;沒綁交易所也照亮(0.1.24 起訊號照跑)。
   ③ 主機凍結訊號(signals_frozen)期間整個配置都不亮:訊號不會動,亮著就是說謊;舊版沒這欄 = 沒凍結。
   選擇策略框的名字前同一顆點、同一個判定。just = { picked: {name: ms}, removed: {name: ms} }(envJustMark 記) */
const ENV_JUST_MS = 300000;
function envRunDot(name, st, nowMs, just) {
  const g = just && just.picked && just.picked[name];
  if (g && nowMs - g < ENV_JUST_MS) return true;
  const x = just && just.removed && just.removed[name];
  if (x && nowMs - x < ENV_JUST_MS) return false;
  const r = st && st.report;
  if (!r || typeof r !== "object") return false;
  const a = r.config && r.config.amounts;
  // 在策略組合裡就亮(Wei 10-14):amounts 有這個 key 就算,金額 0 也算——runtime 本來就排程金額 0 的成員(_deployed_names「amount 0 included」)
  if (!a || typeof a !== "object" || !Object.prototype.hasOwnProperty.call(a, name)) return false;
  if (r.signals_frozen && typeof r.signals_frozen === "object") return false;
  return Array.isArray(r.scheduled) ? r.scheduled.indexOf(name) >= 0 : true;
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
/* 收回 envJustMark 那一次(雲端存檔 ack 回 ok、之後回報卻是 timeout(主機沒套用)或 changed(別處改過)):那一份沒有生效,
   剛加入的不能強制亮、剛移出的不能強制熄,改回照主機回報判(稽核 v026 M2)。before 讀不到(null)= 送出的都當剛加入 */
function envJustUndo(just, before, sent) {
  Object.keys(sent || {}).forEach((n) => { if (!before || !(n in before)) delete just.picked[n]; });
  Object.keys(before || {}).forEach((n) => { if (!(n in (sent || {}))) delete just.removed[n]; });
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
    view: "tr", poTab: null,       // open 時看得見的是自動下單頁(tr)還是策略組合頁(po;配置 cfg／優化 opt,portfolio.js)
    ct: { edits: {}, basis: {}, sent: null },   // 台指期換執行合約的待存值(trCtPick)/ 換算基準(口數 × 每點價值)/ 雲端送出、報告還沒對上的那一份
    flash: {},                     // 從優化套用金額後剛改過的格子(配置分頁閃一下)
    mg: null,                      // 優化分頁自己的狀態(portfolio.js mgBag)
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
    exec: { edit: null, err: null, raw: null },   // 下單方式:送出、報告還沒對上的那個值 / 一行錯誤 / TWAP 時長格裡看不懂的原字
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
   由 command_listener._local_real_key_gate 在寫入前讀一次帳戶)。 */
/* ccy = 那家 lib/account_*.py get_equity 回的幣別(字面值;BingX 是動態 row.asset,這裡是它的預設值)。
   讀帳失敗時 runtime 寫 currency: null,畫面靠它推幣別(tests/check_venue_ccy.py 逐支對 lib) */
const CX_VENUES = { binance: { label: "Binance", env: "BINANCE", ccy: "USDT" }, okx: { label: "OKX", env: "OKX", pass: true, ccy: "USD" },
  bingx: { label: "BingX", env: "BINGX", ccy: "USDT" }, gateio: { label: "Gate.io", env: "GATEIO", ccy: "USDT" }, bybit: { label: "Bybit", env: "BYBIT", ccy: "USDT" } };
const CX_LOCAL_REAL = ["binance", "okx", "bingx", "gateio", "bybit"];
const cxVenuesFor = (env) => Object.keys(CX_VENUES).filter((id) => env === "cloud" || CX_LOCAL_REAL.indexOf(id) >= 0);
/* 統一期貨入口:0.1.18 藏、統一行情(lib/president_quote 實盤 tick)驗過後開。關著時只藏連接框的下拉那一項,其餘(帳戶列、
   部位頁、狀態句、開通中／開通過的「繼續」鈕)對已綁定的機器照舊。tests/check_shell_connect_venues 讀這個值決定期望清單 */
const PRES_LOCAL_ON = true;
// 這台電腦的下拉列不列統一:旗標開、或這個框是「繼續」帶著 president 進來的(少了那一項 select 會變空白)
const cxPresListed = () => PRES_LOCAL_ON || CXF.venue === "president";
// 不在連接框那五家裡的帳戶(lib/account_paper.py、account_capital.py、account_president.py、account_stockcoin.py)
const TR_VENUE_CCY_OTHER = { paper: "USDT", capital: "TWD", president: "TWD", stockcoin: "USDT" };
// 讀不到帳戶幣時的退路:那家的固定幣別;自訂交易所查不到 = null(畫面不帶幣別、不出倍數,改講 tr.ccyUnknown)
function trVenueCcy(id) {
  if (Object.prototype.hasOwnProperty.call(TR_VENUE_CCY_OTHER, id)) return TR_VENUE_CCY_OTHER[id];
  return Object.prototype.hasOwnProperty.call(CX_VENUES, id) && CX_VENUES[id].ccy ? CX_VENUES[id].ccy : null;
}

function trEl(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
function trReport() { return (TR.st && TR.st.report) || null; }
/* 主機存的換合約設定(只列跟 SYMBOL 不同的);舊 runtime 沒這欄 = 照 SYMBOL */
function trContracts() { const c = ((trReport() || {}).config || {}).contracts; return c && typeof c === "object" && !Array.isArray(c) ? c : null; }
function trVenueId() { return trVenueIds(trReport())[0] || null; }
function trTwBroker(id) { return id === "capital" || id === "president"; }   // 台灣期貨券商(同 trOrderLots 認的那兩家)
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
// 部位表判斷交不交易用(trTradesSym):台灣期貨券商 "tw"、連接框那五家與模擬交易 "crypto"、其他(自訂交易所、沒綁)null
function trVenueKind(id) { return !id ? null : trTwBroker(id) ? "tw" : id === PAPER ? "paper" : Object.prototype.hasOwnProperty.call(CX_VENUES, id) ? "crypto" : null; }
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
// 口數字串:整數(取整同機器對帳器 trRoundLots)、負號 U+2212(同 trTwd;輸入框那邊仍走 trFmt 的 hyphen,parse 認的是它);不是數字 null
function trLotsFmt(v, signed) { const s = typeof v === "number" && isFinite(v) ? trFmt(trRoundLots(v), signed) : null; return s == null ? null : s.replace(/^-/, "−"); }
/* 口數「目標」(部位表目標格與「N 支策略」拆解):不取整、最多兩位小數。對帳器取整的是差額(manager/reconciler.py round-half-up),
   不是目標——目標 0.5、實際 1 時差額 −0.5 會賣 1 口,目標格若也取整成 1 就跟差額對不起來(稽核 integ-0124 P2-3) */
function trLotsTgtFmt(v, signed) {
  if (typeof v !== "number" || !isFinite(v)) return null;
  const a = Math.round(Math.abs(v) * 100) / 100;
  return (a === 0 ? "" : v < 0 ? "\u2212" : signed ? "+" : "") + a.toLocaleString("en-US", { maximumFractionDigits: 2 });
}
// 口數格(同網頁 paintVenueLots):整數、可帶正負號、後綴「口」不跟帳戶幣;不是數字 = 「—」
function trLotsInto(node, v, signed) {
  const s = trLotsFmt(v, signed);
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
// cols = [[字, class, 單位?, title?]]:整表只有一區時單位寫在欄頭(units spec §9.4);title = 欄頭的原生說明(th 在橫捲容器裡,氣泡會被裁)
function trHead(cols) {
  const thead = document.createElement("thead"), row = document.createElement("tr");
  // 單位放欄名後的括號裡、跟欄名同一個字樣(「金額（USDT）」;zh 全形、en 半形,Wei 10-15)。
  // 有說明的欄頭:字畫虛線底線(停上去看得到原生 title);只剩帳上與優化表的金額兩處,等定案放哪裡
  cols.forEach((c) => { const label = c[2] ? t("tr.colUnit", { label: c[0], unit: c[2] }) : c[0];
    const th = trEl("th", c[1], c[3] ? "" : label); th.scope = "col"; if (c[3]) { const sp = th.appendChild(trEl("span", "th-tip", label)); sp.title = c[3]; }
    row.appendChild(th); });
  thead.appendChild(row); return thead;
}
let trTipSeq = 0;
// 區段標籤上的解釋:觸發點是一顆鈕(鍵盤到得了),氣泡是 app.css 的 .tip
function trTipLabel(cls, text, tip) {
  const frag = document.createDocumentFragment();
  if (!text) { frag.appendChild(document.createTextNode("")); return frag; }   // 沒有字就不畫鈕:空鈕畫不出字,只剩一條孤立的點線底線
  const b = trEl("button", cls + " tr-tipb", text); b.type = "button"; b.dataset.fk = "tip:" + text;   // 重畫後找回同一顆(trPosFocusBack)
  const box = trEl("span", "tip", tip); box.setAttribute("role", "tooltip"); box.id = "tr-tip-" + (++trTipSeq);
  b.setAttribute("aria-describedby", box.id);
  frag.append(b, box); return frag;
}
function trSec(labelNode, acts) { const s = trEl("div", "pf-sec"); s.appendChild(labelNode); if (acts) s.appendChild(acts); return s; }
/* 策略組合區段標籤旁的問號:外開教學頁的那一段(spec portfolio-help-icon §1)。氣泡跟 aria-label 是同一句,
   不掛 aria-describedby、不加 title(讀屏會念兩次)。feature_used 只有 name 一格,哪一顆寫進名字(網頁 GA 改帶 tab) */
function poHelpGroup(label, anchor, fk) {
  const g = trEl("span", "lbl-grp"), hb = trEl("button", "pf-help"); hb.type = "button"; hb.dataset.fk = fk;
  hb.setAttribute("aria-label", t("po.help"));
  const NS = "http://www.w3.org/2000/svg", ic = document.createElementNS(NS, "svg");   // Lucide circle-help
  ic.setAttribute("class", "ic"); ic.setAttribute("viewBox", "0 0 24 24"); ic.setAttribute("aria-hidden", "true");
  const c = document.createElementNS(NS, "circle"); c.setAttribute("cx", "12"); c.setAttribute("cy", "12"); c.setAttribute("r", "10"); ic.appendChild(c);
  ["M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3", "M12 17h.01"].forEach((d) => { const p = document.createElementNS(NS, "path"); p.setAttribute("d", d); ic.appendChild(p); });
  hb.appendChild(ic);
  const tip = hb.appendChild(trEl("span", "pf-help-tip", t("po.help"))); tip.setAttribute("aria-hidden", "true");
  hb.addEventListener("click", () => { window.blave.openExternal(docsUrl("portfolio") + "#" + anchor); trackFeature(fk === "po-help-opt" ? "po_help_opt" : "po_help_cfg"); });
  g.append(label, hb); return g;
}
function poCfgSec() { return trSec(poHelpGroup(trTipLabel("label", t("po.secAmounts"), t("tr.zeroMeansOff")), "amounts", "po-help-cfg"), trPickBtn()); }
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
    unsavedTitle: t("tm.unsavedTitle"), unsavedBody: t("tm.unsavedBody"), unsavedGo: t("tm.unsavedGo"), unsavedNote: t("tm.unsavedNote"),   // 結束 / 關窗攔截:策略組合有還沒儲存的變更
    presQuitTitle: t("pres.quit.title"), presQuitBody: t("pres.quit.body", { lots: "{lots}" }),   // 結束攔截:統一還有部位(主行程填口數)
    updateBody: t("tm.updateBody"), moveTitle: t("tm.move.title"), moveBody: t("tm.move.body"), moveGo: t("tm.move.go"), moveNo: t("tm.move.no"),   // 下單中重新啟動更新的確認框、搬到「應用程式」那一問
    moveAuthExists: t("tm.move.authExists"), moveAuthApps: t("tm.move.authApps"), gotIt: t("src.gotIt"),   // 搬移要系統授權時的提示框(只有「知道了」)
    // 本機 P1 通知的字:跟總覽時間軸同一組(trEventText),只有拒單的註解是通知專用
    ev_halt: t("tr.ov.evHaltAuto"), ev_halt_n: t("tr.ov.evRestartStoppedNote"),   // 本機的 lib 隨 app 出貨:0.1.27 起 HALT 是完全凍結
    ev_order_error: t("tr.ov.evErr"), ev_order_error_n: t("tm.evOrderErrNote"),
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
  // 策略組合:再點一次同自動下單(這台電腦收掉回 welcome;雲端沒有 welcome,落回自動下單頁)
  $("po-nav").addEventListener("click", () => {
    if (!$("po-nav").hasAttribute("aria-current")) poOpen();
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
        if (typeof ccyPaint === "function" && !$("set-scrim").hidden) ccyPaint();   // 設定 › 顯示幣別:新的那份信封到了就換上
        if (envCloudKind(C.st) === "signedOut") { C.edits = {}; C.picked = null; C.ov.curve = null; C.ov.ui = []; C.ov.uiErr = false; C.ov.curveErr = false; C.ov.perf = null; C.ov.perfErr = false; }   // ui 與 uiErr、curve 與 curveErr 各是一組,一起清
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
    trCfTick();   // 存金額的框開著:草稿的預覽到了／數字變了就換上
    if (typeof poAddSync === "function") poAddSync();   // 策略頁首「加到策略組合」↔「到策略組合」
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
    C.sent = null; C.sentRep = null; C.sentBefore = null; C.notApplied = null; C.save = null; C.saveErr = null; C.saveUnknownAt = 0; C.reqIds = {}; C.reqFor = {}; C.sig.cfg = null; C.picked = null; C.ct = { edits: {}, basis: {}, sent: null }; C.mg = null;
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
// 主機回報的這支台指期策略現在下哪個合約:config.contracts 有寫就照它,沒寫就是 SYMBOL 自己的(去 R1);不是台指期 = null
function trCtReported(rep, n, list) {
  const c = rep && rep.config && rep.config.contracts && rep.config.contracts[n];
  if (typeof c === "string" && Object.prototype.hasOwnProperty.call(TR_TXF_SPECS, c)) return c;
  const st = (rep && rep.states && rep.states[n]) || {}, x = (list || []).find((y) => y.name === n) || {};
  const sym = String(x.symbol || st.symbol || "").trim().toUpperCase().replace(/R1$/, "");
  return trTxfSpec(sym) ? sym : null;
}
// 存檔那一刻主機回報的金額(「存之前的值」);讀不到 = null(放行規則退回只看相符與 30 秒)
function trSentBeforeOf(S) { const a = S && S.st && S.st.report && S.st.report.config && S.st.report.config.amounts; return a && typeof a === "object" ? Object.assign({}, a) : null; }
function trSentCheck(C, now) {
  if (C.saveUnknownAt && now - C.saveUnknownAt > TR_CONFIRM_CLOUD_MS) { delete C.reqIds.amounts; C.saveUnknownAt = 0; }
  // 「主機還沒套用」那一句:金額對上、而且(只換合約那種)合約也真的換過來了才收(稽核:只比金額會在下一輪就被收掉)
  if (C.notApplied) { const rep0 = (C.st || {}).report || {}, nc = C.notAppliedCt;
    const ctOk0 = !nc || Object.keys(nc).every((n) => trCtReported(rep0, n, C.list) === nc[n]);
    if (trSentSettled(C.notApplied, (rep0.config || {}).amounts, 0, null, ctOk0) === "same") { C.notApplied = null; C.notAppliedCt = null; C.sig.cfg = null; srSay(t("tr.cloud.pendDone")); } }
  if (!C.sent) return;
  const amts = (((C.st || {}).report || {}).config || {}).amounts;
  /* 報告又是真相:picker 的草稿交回 stored。比的是送出的那一份(不是報告):那一份就是存的時候的草稿,
     主機沒套用(timeout / 別處改了)時也要放掉,表才會照主機上的值畫;存完之後又勾了別的才留著 */
  const done = () => { const sent = C.sent; C.sent = null; if (C.ct) C.ct.sent = null; if (C.save === "sent") C.save = null; C.sig.cfg = null; if (!trPickDirty(C.picked, sent, trPickKeep("cloud", C.picked, sent, (C.list || []).map((x) => x.name)))) C.picked = null; };
  if (envCloudKind(C.st) !== "running") { done(); return; }
  const rep = (C.st || {}).report || {}, ctSent = C.ct && C.ct.sent;
  const ctOk = !ctSent || Object.keys(ctSent).every((n) => trCtReported(rep, n, C.list) === ctSent[n]);
  const v = trSentSettled(C.sent, amts, now - (C.sentAt || now), C.sentBefore, ctOk);
  if (v === "wait") return;
  // 30 秒到了還不符:改顯示主機上的值,儲存列那一格講「主機還沒套用」;之後報告對上剛存的那份就收掉那一句
  const pinned = C.sent, pinnedCt = ctSent ? Object.assign({}, ctSent) : null;
  done();
  if (v === "same") { srSay(t("tr.cloud.pendDone")); return; }
  if (v === "timeout") { C.notApplied = pinned; C.notAppliedCt = pinnedCt; }   // "changed":別處改了,照主機上的值畫,不講主機還沒套用
  // 兩種都不算存成功:ack 那一刻點的燈收回,側欄改照主機回報畫
  if (C.just) { envJustUndo(C.just, C.sentBefore, pinned); ENV.sig.side = null; }
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
            universe: x.remote ? [] : trUniverse(d && d.code) };   // 雲端清單不帶組合的標的:雲端的 Type C 看不出來
      m.twd = trIsTwd([sym].concat(m.universe)); m.twdAll = trAllTwd([sym].concat(m.universe));
      S.meta.set(x.name, m);
    }
    out.push({ name: x.name, displayName: x.displayName || x.name, hasBacktest: !!x.hasBacktest, symbol: m.symbol, market: m.market, portfolio: m.portfolio, twd: m.twd === true, twdAll: m.twdAll === true, universe: m.universe || [], srcMarket: x.srcMarket || null });
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
  return base ? trDirty(trNames(), base, TR.edits) || Object.keys(TR.bad).length > 0 || trPickDirty(TR.picked, base, trPickKeep(TR.env, TR.picked, base, trListNames())) : false;
}
/* 金額表的底稿。雲端存完、報告還沒對上時是送出的那一份(S.sent):報告還是舊的,拿它當底會把剛存的那幾格送回舊值 */
function trBase() { return TR.env === "cloud" && TR.sent ? TR.sent : trStored(); }
/* 結束 / 關窗前主行程來問(main.js draftGate,executeJavaScript):兩個視角裡有沒有還沒儲存的策略組合變更——勾選草稿、金額、換合約。
   草稿只在記憶體裡,不另外存(Wei 0.1.26):有就先問一聲再走 */
function trUnsavedAny() { return Object.keys(TR_BAGS).some((k) => trWith(TR_BAGS[k], () => trAmountsEdited() || trCtDirty(trNames()))); }
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
  S.open = true; S.view = "tr"; S.sig = {}; ENV.sig.tb = null;
  envShowMain();
  trPaint();
  if (tab && !$("tr-tabs").hidden) trSetTab(tab);   // 指定分頁的入口(之後的通知、狀態帶)一律走 trSetTab:底線、tabindex、面板三件事一起換
  trPollSoon(0);
}
// app.js 選了策略時叫的:離開的是「這台電腦」的自動下單頁(雲端視角的那一頁不歸它管)
function trLeave() {
  const L = TR_BAGS.local;
  if (!L.open) return;
  L.open = false;
  if (ENV.cur === "local") { $("tr").hidden = true; $("po").hidden = true; $("tr-nav").removeAttribute("aria-current"); $("po-nav").removeAttribute("aria-current"); ENV.sig.tb = null; trPaintHead(); }   // 離開這頁:頂列換成短狀態詞
}
function trRepaint() { TR.sig = {}; TR_BAGS.local.sig = {}; ENV.sig = {}; ENV.cells = {}; trPaint(); if (!$("cx-scrim").hidden) cxModalPaint(); }

/* ── 標題列 / 狀態帶 ───────────────────────────────────────── */
/* 這台電腦還在等狀態檔時,講清楚在等什麼:第一次安裝引擎(daemon 要等它裝完才起得來)/ 更新引擎,其餘「載入中…」。
   讀 engine.js 的主行程安裝快照(ENG.snap,enginesetup.js);字要少 */
function trLoadingText() {
  const s = TR.env === "local" && typeof ENG !== "undefined" ? ENG.snap : null;
  if (s && s.phase === "run") return t(s.kind === "first" ? "tr.loadingEngine" : "tr.loadingEngineUpd");
  return t("tr.loading");
}
/* 空狀態導引這一刻的判斷(trZGuide 的輸入在這裡湊齊):頁首、部位、總覽三處同一份。zv / pend 沒給就照 trPaintHead 同一條算 */
// 選擇策略框有沒存的勾選(Z-draft 的輸入):底稿與 keep 同金額表的 dirty(trAmountsEdited)
function trZDraft() { const base = trBase(); return !!base && trPickDirty(TR.picked, base, trPickKeep(TR.env, TR.picked, base, trListNames())); }
function trZRows(r) { return TR.listLoaded ? trPickRows(TR.list, [], (r || {}).can_trade_portfolio === true, trVenueId() === PAPER && !trPaperTwOk(), trTwBroker(trVenueId()), {}) : null; }
function trZNow(state, zv, pend) {
  const r = trReport() || {};
  if (!zv) { zv = trZView(state, r); pend = trAmountsEdited() ? null : trPendKey(TR, Date.now(), zv.off && !zv.noStart); }
  const zc = trZCase(trReport(), trZRows(r), trZDraft());
  const wait = !trReport() || !TR.listLoaded || trFirstReadPending(r) || trPickOff() || !!pend;
  const g = trZGuide({ zc, pure: zv.reason === "tr.startOffNoAmt" && !zv.release && !zv.noStart, dead: state === "dead" && trDeadKind(r) !== "died", pend, wait, tab: TR.view === "tr" ? TR.tab : null });
  g.zc = zc; return g;
}
function trZVars(key) { return key === "tr.startOffNoVenueStrat" ? { venue: trVenueLabel(trVenueId(), true) } : null; }
// 下單程式在跑、沒有金額(spec §6-2):缺的是策略還是金額分開講;有金額但這家下不了、沒路由的照舊那一句
function trRunZText(r) {
  const zc = trZCase(r, trZRows(r), trZDraft());
  return zc === "draft" ? t("tr.runningZDraft") : zc === "pick" ? t("tr.runningZPick") : zc === "noStrat" ? t("tr.runningZNoStrat") : zc === "noVenue" ? t("tr.runningZNoVenue", { venue: trVenueLabel(trVenueId(), true) })
    : zc === "amt" ? t("tr.runningZZero") : t("tr.runningZ");
}
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
  if (state === "loading") return TR.env === "cloud" ? t("tr.cloud.hdFetching") : trLoadingText();
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
    s = !ask && !done && trAppRestartQuiet(r) ? t("tr.notStarted")
      : (ask ? t("env.st.autoPaused") : done || rk || envHeadWord(state, TR.st) !== "env.st.autoPaused" ? t("tr.halted") : t("env.st.autoPaused")) + " · "
      + trHaltReasonText(r, TR.acctDone); }
  // 「尚未啟動下單」講的是狀態、不是叫人按鈕(§12:不需要 Z 變體);「停了、不是你按的」在 Z 時去掉尾巴
  else if (state === "dead") s = trDeadKind(r) === "died" ? t(zS ? "tr.diedZ" : "tr.died", { t: rec.heartbeat_at ? trStamp(rec.heartbeat_at) : "—" })
    : rec.heartbeat_at ? t("tr.notStarted") + " · " + t("tr.lastRun", { t: trStamp(rec.heartbeat_at) }) : t("tr.notStarted");
  // 在跑、統一有口在倉(只在這台電腦、Windows):同一句尾接「電腦保持清醒」——設計師裁定 A,不另立橫幅、不講「不會平倉」
  else if (!trNoAmounts(r) && TR.env === "local" && window.blave.platform === "win32") { const lots = presHeldLots(r); if (lots > 0) s += " · " + t("tr.presAwake", { n: lots }); }
  // 統一下單程式剛起來、第一筆帳戶回報還沒回來:中性句,不講失敗也不講「尚未啟動」(讀到帳戶或 60 秒後照舊;對帳器自己掛了的照講)
  if (state === "dead" && trDeadKind(r) !== "died" && trPresBooting(r, Date.now())) return t("tr.presBooting");
  // 讀帳失敗標在狀態行最前面(細節在 設定 分頁的帳戶段);頁面與暫停鈕照常在
  // 失敗而且下單程式沒在跑:整句換成帶出口的那一句(到「設定」),不把三個狀態串成一串(設計稽核 desktop-10-08 #7)
  if (trFailStopped(state, r)) return t("cx.failStopped");
  return trFailedIds(r).length || trKeyBad(TR.env) ? cxFailWord(TR.env) + " · " + s : s;
}
/* 標題下那一行 = trStateText 再換兩處(spec-autotrade-empty;trStateText 本身照舊,其餘各態不受影響):
   ① 下單程式在跑、沒有金額:「還沒有策略設定金額」換成缺的那一步(§6-2);
   ② 純 Z 還沒啟動:「尚未啟動下單(· 上次執行)」不寫,缺哪一步那句搬到這一行;霧開著或等回報時空著(v2 §2)。
   只認 dead 分支自己那句(異常停止、統一開機中、串接失敗停著、過場、常駐程式不在跑都是別的字,照舊) */
function trHeadText(state, zg) {
  const s = trStateText(state), r = trReport() || {}, rz = t("tr.runningZ"), ns = t("tr.notStarted");
  if (s.length >= rz.length && s.slice(s.length - rz.length) === rz) return s.slice(0, s.length - rz.length) + trRunZText(r);
  if (state === "dead" && zg && zg.status !== null && (s === ns || s.indexOf(ns + " · ") === 0)) return zg.status ? t(zg.status, trZVars(zg.status)) : "";
  return s;
}
/* 讀帳失敗 + 下單程式沒在跑(停著、或 HALT 但對帳器不在):統一登入失敗停掉就是這一型。HALT 中對帳器還活著的不算(它在跑) */
function trFailStopped(state, r) { return (trFailedIds(r).length > 0 || trKeyBad(TR.env)) && (state === "dead" || (state === "halted" && !trRecRunning(TR.st))); }
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
/* runtime 存金額時點名拒絕的那支(「CODE: 「名」…」)→ 句子(同網頁 pfRejectText df9f96df)。NOT_TXF = 統一只下台指期(碼是統一的);
   MARKET_VENUE = 策略的市場跟交易所不符(群益只下台指期、台指期／台股策略綁到加密交易所)。交易所名寫各語言自己的,不用選單的雙語標籤 */
function trTwVenueName(id) { return id === "capital" ? t("tr.venueCapitalFull") : t("pres.venue"); }
function trRejectSentence(rc) {
  // 點名好幾支時最多列三支,其餘「等 N 支」(句子裡的名字寫顯示名;引號在字串裡,多的那段接在引號外)
  const ns = (rc.names && rc.names.length ? rc.names : [rc.name]).map(trDisplay), name = ns.slice(0, 3).join(t("tr.rejNameSep")), more = ns.length > 3 ? t("tr.rejMore", { n: ns.length - 3 }) : "";
  if (rc.code === "TYPE_B") return t("tr.typeB.rejected", { name, more });
  if (rc.code === "NOT_TXF") return t("tr.notTxf.rejected", { name, more, venue: trTwVenueName("president") });
  if (rc.code === "NEEDS_ROUTING") return t("tr.needsRouting.rejected", { name, more });
  if (rc.code === "SAVE_FAILED") return t("tr.saveFailed.rejected");   // runtime:存設定時檔案被占用,這次什麼都沒改   // runtime 拒絕啟動:解綁後重新綁定、還沒存過下單設定
  // 台指期／個股期貨／台股策略綁到加密交易所:講到它是哪個市場(稽核 r4 P2:原句只講台指期)
  if (rc.code === "MARKET_VENUE" && rc.crypto && rc.market) return t("tr.marketVenue.crypto", { name, more, market: t({ "\u53f0\u6307\u671f": "tr.mktName.txf", "\u500b\u80a1\u671f\u8ca8": "tr.mktName.stockFut", "\u53f0\u80a1": "tr.mktName.twStock" }[rc.market]) });
  if (rc.code === "MARKET_VENUE") return t("tr.marketVenue.rejected", { name, more, president: trTwVenueName("president"), capital: trTwVenueName("capital") });
  return null;
}
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
      mine.acked = true; mine.ackedAt = Date.now();
      if (want === "running" && typeof presFirstDone === "function") presFirstDone();   // 第一次真錢啟動的說明:啟動 ack 成功才記成看過   // 機器收下了(「暫停中…」照樣停用到收斂或逾時,trHaltInFlight)
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
  const state = envHeadState(TR.st, Date.now()), text = trHeadText(state, trZNow(state)), ro = TR.env === "cloud";
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
  const inkReason = state === "halted" && (trRestartKind(hr) || (trHaltStopsAll(hr.halt) && !(trHaltFreeze(hr) && trHaltByUser(hr.halt))) || trAcctAsk(hr)) ? trHaltReasonText(hr, TR.acctDone) : state === "noaccount" && trNoAccountStopped(hr) ? t("tr.cloud.restartNoAccountZ") : "";
  const inkAt = inkReason ? full.indexOf(inkReason) : -1;
  /* 「可能仍在下單」那一條原因行用紅字(錢可能還在外面暴露、而用戶以為停了);狀態詞本身一般墨色。
     紅的只有原因那一句本身:前面可能有「串接失敗 · 」、後面可能接「 · 最後更新…」(回報過舊),兩種都不能讓紅字消失 */
  const ucReason = state === "unconfirmed" ? t("tr.cloud.restartUnconfirmed") : "", ucAt = ucReason ? full.indexOf(ucReason) : -1;
  if (cutAt > 0) tx.append(trEl("span", "up", full.slice(0, cutAt)), full.slice(cutAt));
  else if (ucAt > 0) tx.append(full.slice(0, ucAt), trEl("span", "danger", ucReason), full.slice(ucAt + ucReason.length));
  else if (inkAt > 0) tx.append(full.slice(0, inkAt), trEl("span", "ink", inkReason), full.slice(inkAt + inkReason.length));
  else tx.textContent = full;
  // 串接失敗停著:帶設定分頁同一個紅記號(眼睛才不會先落在標題與灰鈕上,把失敗漏掉)
  const failStop = trFailStopped(state, hr);
  if (failStop) { const m = trEl("span", "fault-mark"); m.setAttribute("aria-hidden", "true"); desc.appendChild(m); }
  desc.classList.toggle("fail", failStop);
  desc.appendChild(tx); desc.title = full;   // 單行截斷,全文放 title
  // 帶著出口的句子(「請重開 Blave」「按『啟動下單』重新開始」)不能被截斷:這時候狀態行可以換行
  /* 狀態句換行。**Z 一律換行**:標頭改成三列之後這一行跨滿寬,沒有 .wrap 的狀態會被截成一行、而且看起來很正常——
     被藏掉的正是「部位現在沒有人在管」那半句(設計師在 V2b 點名的陷阱)。running + Z 與「尚未啟動下單 · 最後執行」
     這兩種以前沒有 .wrap,現在靠 trNoAmounts 一起接住 */
  desc.classList.toggle("wrap", !!trHostDown(TR.st, Date.now()) || (ro && state === "unknown") || died || failStop || state === "halted" || state === "unconfirmed" || trNoAmounts(trReport()) || (state === "noaccount" && trNoAccountStopped(trReport())));   // 帶出口 / 原因行的句子不截(已暫停的原因行常駐,不可以被省略號吃掉)
  // 狀態變了講一次(輪詢每幾秒重畫,不能每次都講)
  if (TR.lastSaid !== null && TR.lastSaid !== text && text && TR.open && TR.view !== "po" && state !== "loading") srSay(text);
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
  const pageOpen = TR_BAGS[ENV.cur].open === true && TR_BAGS[ENV.cur].view !== "po", tbState = has && !pageOpen ? trShortState(state) : "";
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
  trPaintQuote(TR.pending ? null : state);
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
  if (failStop) zv.reason = null;   // 狀態句已帶出口(到「設定」):此刻該處理的是登入,不叫人去配金額(鈕照樣停用)
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
      // 停機原因(planStopKind):扣款失敗 → 重新付款;切換前低餘額 → 加值;取消到期 → 網站恢復;自己停的 → 網站方案頁
      if (TR.env === "cloud" && envCloudKind(TR.st) === "stopped") { const k = planStopKind(); if (k === "fail") planRepay(); else if (k === "hourly") bindGo("topup_cloud"); else planWebGo(); return; }
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
    b.textContent = t({ fail: "plan.repay", ended: "plan.resumeWeb", self: "plan.manageStopped" }[planStopKind()] || "plan.addCredit");
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
  // 空狀態導引(spec-autotrade-empty):純 Z 時原因行、頁首鈕字與停用鈕的說明跟著缺的那一步換;其餘照 zv
  const zg = trZNow(state, zv, pend);
  if (zg.reason !== undefined) trPaintNoAmt(zg.reason, trZVars(zg.reason));
  else trPaintNoAmt(pend || zv.reason, zv.book ? { n: trBookQty(zv.book) } : null);
  trPaintGoRel(zv.release, zv.noStart, zv.close);
  trPaintGoCfg(zg.btn, zg.fill, zg.zc);
  if (zv.off || zv.book) b.setAttribute("aria-describedby", zg.desc);   // 帳本非空那句講的是按下去會發生什麼,讀屏也要聽到
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
/* 備案 B(post-connect-flow;設計稽核 review-post-connect-b 必改 1):純 Z(沒有能下的金額、沒有「解除暫停」)時,動作列多一顆鈕,
   放在停用的「啟動下單」左邊——同 Z＋暫停時「解除暫停」的排法;原因行只留一句話,頁首高度不跳(#108)。
   spec-autotrade-empty v3:缺的是哪一步(zc)就寫那件事、按了直接做,而且實心(它是畫面上唯一能按的鈕);
   沒路由、這家下不了(zc = null)照舊描邊「到策略組合」。部位上霧時由 trZGuide 收掉(卡上那顆是唯一的鈕) */
function trPaintGoCfg(key, fill, zc) {
  let u = $("tr-go-cfg");
  TR.zBridge = !!key;
  if (!key) { if (u) { if (document.activeElement === u) $("tr-h").focus(); u.remove(); } return; }
  if (!u) { u = trEl("button", "btn-out", ""); u.type = "button"; u.id = "tr-go-cfg"; u.addEventListener("click", () => trZGo(u.dataset.go, u)); $("tr-act").insertBefore(u, $("tr-go")); }
  u.dataset.go = zc || "cfg"; u.dataset.fk = "go-" + u.dataset.go;
  u.classList.toggle("btn-fill", !!fill); u.classList.toggle("btn-out", !fill);
  if (u.textContent !== t(key)) u.textContent = t(key);
}
/* 頁首鈕與部位霧卡上的鈕按下去(spec §4):選擇策略 = 到配置頁、開選擇策略框(opener 是配置頁的 #tr-pick,確定後焦點落在第一個金額格);
   設定金額 = 到配置頁、焦點在第一個金額格;新增策略 = 側欄＋同一個新增策略框 */
async function trZGo(kind, from) {
  if (kind === "noStrat" || kind === "noVenue") { if (typeof nsOpen === "function") nsOpen(from); return; }
  if (kind !== "pick" && kind !== "amt" && kind !== "draft") { poOpen("cfg", true); return; }
  await poOpen("cfg");
  if (TR.view !== "po") return;
  if (kind === "amt" || kind === "draft") { trFocusFirstAmt(); return; }
  const b = $("tr-pick");
  if (b && b.isConnected && !b.disabled) { psToAmt = true; psOpen(b); if ($("ps-scrim").hidden) psToAmt = false; } else $("po-h").focus();
}
function trFocusFirstAmt() { const i = $("po-cfg").querySelector(".amt-in:not(:disabled)"); if (i && i.offsetParent) i.focus(); else psRefocus(); }
/* 鈕旁的原因行(Z 時常駐,--ink-3 12px,在狀態行下面自己一行)。句子裡的「部位」做成連結,點了切到部位分頁。
   **節點常駐、只換內容**(e2e 0.1.8 #108):原本沒有原因就把節點拿掉,連續操作時頁首高度一下多 22px 一下少 22px,
   分頁列跟著跳、容易點錯。沒有原因時清空內容,高度由 CSS 的 min-height 佔著 */
/* 帳本上機器人部位的總量,給原因行那一句:口數 venue 寫「3 口」(Σ|口數|),加密寫「300 USDT」(帳本的 size 是成本,同 trReleaseRows 的列)。
   一台機器一個 venue,整本同一種單位;混到的話以口數為準(口數那幾列才是會被平掉的合約) */
function trBookQty(rows) {
  const lots = rows.filter((x) => x.lots), sum = (a) => a.reduce((s, x) => s + Math.abs(x.v), 0);
  if (lots.length) { const n = sum(lots); return trLotsFmt(n) + " " + t(trLotsKey(Math.round(n), "tr.lotsUnit", "tr.lotUnit")); }
  return trWithUnit(trFmt(sum(rows)));
}
function trPaintNoAmt(key, vars) {
  let p = $("tr-noamt");
  if (!p) { p = trEl("p", "tr-noamt", ""); p.id = "tr-noamt"; $("tr-quote").after(p); }   // 行情句之後:狀態句 → 行情句 → Z 佔位行
  // 這一行裡有可 Tab 的「部位」連結:清空 / 重建之前焦點在它身上的話先交給標題,不然會掉到 BODY
  const hadFocus = p.contains(document.activeElement);
  TR.noAmtLink = !!key && t(key, vars).toLowerCase().indexOf(t("po.nav").toLowerCase()) >= 0;
  if (!key) { if (hadFocus) $("tr-h").focus(); p.textContent = ""; p.classList.remove("cx-wait"); delete p.dataset.key; return; }
  if (p.dataset.key === key + "|" + LANG + (vars ? "|" + JSON.stringify(vars) : "")) return;   // vars(帳本口數)變了也要重畫
  if (hadFocus) $("tr-h").focus();
  p.dataset.key = key + "|" + LANG + (vars ? "|" + JSON.stringify(vars) : ""); p.textContent = "";
  /* 等回報那一句前面加 16/2 圓環 spinner(§2-3c):讓「正在發生某件事」出現在停用的鈕正下方、
     離接觸點幾個 px,而不是讓一顆靜止的灰鈕自己解釋。**spinner 只放在句子上,不放進鈕裡**——
     放進鈕裡就是規則 6 要避免的那個誤讀(用戶按的是儲存,不是啟動下單)。沿用 §5 的 .cx-wait,不新做元件。
     句子整段包在一個 span 裡:.cx-wait 是 flex,不包的話每個文字節點都會變成一個 flex item,句子會被切成好幾欄 */
  const wait = key === "tr.cloud.startPendAmounts" || key === "tr.cloud.startPendAmountsStale" || key === "tr.cloud.startPendSlow";
  p.classList.toggle("cx-wait", wait);
  if (wait) { const sp = trEl("span", "spin16"); sp.setAttribute("aria-hidden", "true"); p.appendChild(sp); }
  const line = wait ? trEl("span", "") : p;
  const text = t(key, vars), word = t("po.nav"), at = text.toLowerCase().indexOf(word.toLowerCase());   // 句子裡的「策略組合」是連結(兩頁之間唯一的一條);不分大小寫才兩語都接
  // 備案 B:Z 時出口是動作列的「到策略組合」(trPaintGoCfg),原因行只留一句話。有金額、但這家都下不了(加密策略、改綁統一)講成「還沒有{venue}能下的策略金額」
  if (key === "tr.startOffNoAmt") {
    const rr = trReport() || {}, a = (rr.config || {}).amounts || {}, any = Object.keys(a).some((k) => Number(a[k]) > 0);
    line.append(trUnrouted(rr).length ? t("tr.startOffNoRoute") : any ? t("tr.startOffNoVenueAmt", { venue: trVenueLabel(trVenueId(), true) }) : t("tr.cfgNull"));   // 沒有金額、讀得到設定的那幾格由 trZGuide 換成缺哪一步;剩下的是設定讀不到
  } else if (at < 0) line.append(text);
  else {
    const a = trEl("button", "btn-quiet tr-noamt-link", text.slice(at, at + word.length)); a.type = "button"; a.addEventListener("click", () => poOpen("cfg", true));
    line.append(text.slice(0, at), a, text.slice(at + word.length));
  }
  if (wait) p.appendChild(line);
}
/* 配置頁儲存列格位的「去啟動」(post-connect-flow 第 4 列):envHeadState 每個值都列舉,新增狀態時這裡要跟著決定。
   running／unconfirmed → 不畫(在下單,或可能仍在下單);dead → 還沒開始下單;halted → 下單已暫停;
   loading／unknown／setup／noaccount → 不畫(還沒有可以啟動的東西,自動下單頁會講原因)。沒有這家能下的金額也不畫 */
function trGoStartKey(state, r) {
  const M = { running: null, unconfirmed: null, dead: "po.goIdle", halted: "po.goHalt", loading: null, unknown: null, setup: null, noaccount: null };
  if (!Object.prototype.hasOwnProperty.call(M, state)) return null;
  return M[state] && trTradableFunded(r || {}) > 0 ? M[state] : null;
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
    const auto = !!(r.halt && r.halt.halted) && trHaltStopsAll(r.halt) && !(trHaltFreeze(r) && trHaltByUser(r.halt));
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
// 台指期實盤行情來源那一句(trQuoteLine):狀態句正下方自己一行、.tr-ro-note 的字級;退路句 .is-fallback 升一階;不播讀屏(是事實不是事件)
function trPaintQuote(state) {
  const stored = trStored() || {}, lots = Object.keys(stored).some((n) => stored[n] > 0 && trRowIsLot(n));
  const n = $("tr-quote"), q = trQuoteLine(trReport(), TR.env, trVenueId(), state, lots), sig = LANG + "|" + (q ? q.key + "|" + q.why : "");
  if (ENV.sig.quote === sig) return;
  ENV.sig.quote = sig; n.hidden = !q; n.classList.toggle("is-fallback", !!(q && q.fallback));
  n.textContent = q ? t(q.key, { why: q.why ? t(q.why) : "" }) : "";
}
// 停機:紅記號 + 一段話(數字來自方案頁同一個來源;拿不到數字就用不帶數字的那句,不寫死)
function trPaintVerdict(on) {
  const box = $("tr-verdict"), v = on ? planVars() : null, k = on ? planStopKind() : "", sig = LANG + "|" + (on ? v.m + "|" + v.h + "|" + k + "|" + v.gu : "");
  box.hidden = !on;
  if (ENV.sig.verdict === sig) return;
  ENV.sig.verdict = sig; box.textContent = "";
  if (!on) return;
  const row = trEl("div", "verdict"), mark = trEl("span", "fault-mark"); mark.setAttribute("aria-hidden", "true");
  // 方案制:扣款失敗與取消到期都講刪機日(grace_until);用戶自己停的講方案照常;都不講餘額
  const gu = (key) => t(v.gu ? key : key + "NoNum", v);
  row.append(mark, trEl("span", "", k === "fail" ? gu("tr.cloud.stoppedPlan") : k === "ended" ? gu("tr.cloud.stoppedEnded") : k === "self" ? t("tr.cloud.stoppedPlanOk") : v.m && v.h ? t("tr.cloud.stoppedBody", v) : t("tr.cloud.stoppedBody0")));
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
    lines: [t((r.self_ledger === true ? "tr.stopChoiceSelf" : "tr.stopChoice") + (trHaltFreeze(r) ? "Freeze" : "")), trRestartUnconfirmed(r) ? t("tr.cloud.closeAllWarn2Unconfirmed") : t("tr.closeAllWarn2")],
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
   這台電腦:常駐只有 venue 通用的「只調整 Blave 自己那一份」;電腦醒著才跑 / 睡眠關機不平倉 / 重開要再按啟動 / 交易所端停損單(真錢;
   模擬帳戶沒有交易所端的停損單,那句在那裡是假的)四點全在「細節」——同一件事不在常駐與細節各講一次(設計稽核 desktop-10-08 #3)。
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
    // 方案制(o.mo)沒有時價與「餘額低於 N 停機」:停機的原因是方案沒付款
    if (o.mo) keep.push(t("tr.cloud.means.3m"));
    else if (o.v && o.v.h && o.v.m) keep.push(t("tr.cloud.means.3", o.v));
    items.push(t("tr.cloud.means.1"), t("tr.cloud.means.4"));
  } else {
    // awake = 設定 › 一般「自動下單時不讓電腦睡」開著:閒置不會睡,停的只剩闔蓋、沒電、手動睡眠、關機、結束 Blave;關著照舊版
    const a = o.awake ? "a" : "";
    items.push(t(o.awake && o.win ? "tr.means.1aWin" : "tr.means.1" + a), o.paper ? t("tr.means.2p" + a) : t("tr.means.2" + a, { venue: o.venue }), t("tr.means.3"));
    // 台灣期貨券商(群益／統一)沒有券商端停損單型(lib/order_president place_stop_order 是 NotImplementedError):「建議掛上」那句在那裡是假的
    if (o.real) items.push(o.tw ? t("tr.means.twStop", { venue: o.venue }) : t("tr.means.4"));
    if (o.pres) items.push(t("tr.means.presNight"));   // 台指期夜盤也會下單、電腦要一直開著
  }
  return { keep, details: details.concat([{ label: t(o.cloud ? "tr.det.cloud" : "tr.det.local"), items }]) };
}
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
  const paper = trIsPaper(), real = envMoney(TR.st) === "real";
  const trRunStart = (cmd) => trRun("running", cloud ? [(S) => trSend(S, cmd, {})] : [
    (S) => trSend(S, cmd, {}),
    (S) => { return trRecRunning(S.st) ? { ok: true } : trSend(S, "restart_reconciler", {}); },
  ], cmd);
  const recomputing = trRecomputing(r), rkS = trRestartKind(r);
  const notes = trStartNotes({ awake: typeof AWAKE === "undefined" || AWAKE !== false, cloud, paper, real, own: r.self_ledger === true, book: trBookBaseline(r), v: cloud ? planVars() : null, mo: cloud && planMo(), venue: paper ? "" : trPadLatin(trVenueLabel(trVenueId(), true)), tw: trTwBroker(trVenueId()), pres: !cloud && trVenueId() === "president", win: window.blave.platform === "win32" });
  if (!cloud) notes.details[notes.details.length - 1].items.push(trAwakeCloudGo());   // 要 24 小時跑:去雲端那一袋(K4)
  const catchUp = () => { if (!trRecomputing(trReport())) go("resume"); };   // 框開著的時候不會跟著回報翻:要等重算完,關掉重開一次
  const money = real ? "Real" : "";
  // 補齊會送出的單(post-connect-flow 第 8 列):口數或金額取自部位表的差額,最多三檔,其餘「等 N 檔」
  const will = trCatchWill(r);
  const stranded = trWaitStranded(r);
  // 照什麼、多少錢下單(設計 A6):跟自動下單 › 部位表底合計同一個格式(trPlanTotal),讀已存配置
  const pl = trPlanLine(trStored()), plan = pl ? [pl] : [], dc = trDeferredCloseLine(r), dcl = dc ? [dc] : [];
  confirmBox(trCloudBox(Object.assign({
    title: t("tr.start"), mark: paper ? t("tr.mode.paper") : real ? t("tr.mode.real") : null, markKind: real ? "real" : "paper", opener,
    lead: trBothReal(),
    keep: notes.keep, details: notes.details,   // 細節一律收合:展開時整框在 1366 寬就出捲軸(設計稽核 desktop-10-08 #3)
  }, canWait ? {
    // 重開過(主機 / Blave):到現在都沒有下單,部位可能跟訊號對不上——最上面的狀態句,在選「補齊 / 等新訊號」之前講
    lines: plan.concat(rkS === "machine" ? [t("tr.cloud.restartStartLine")] : rkS === "app" ? [t("tr.restartStartLineLocal")] : []).concat(dcl),
    choicesLabel: t("tr.opt.legend"),
    choices: [
      // Blave 重開(本機):關著的時候策略沒跑,現在補齊用的可能是舊訊號——掛在它影響的那個選項裡。主機重開(B)由重算那一句與閘門講
      { id: "catch", title: t("tr.opt.catch"), desc: t("tr.opt.catchDesc" + money, { how: trCatchHow(r, real) }) + (will ? " " + will : ""), warn: rkS === "app" ? t("tr.opt.catchStale") : null,
        disabled: recomputing, why: t("tr.cloud.recomputing"), ok: t("tr.startCatchUp"), onOk: catchUp },
      { id: "wait", title: t("tr.opt.wait"), desc: t("tr.opt.waitDesc" + money), warn: stranded ? t("tr.opt.waitStranded", { n: stranded }) : null,
        ok: t("tr.startWait"), onOk: () => go("resume_wait") },
    ],
    ok: t("tr.start"),
  } : {
    // 機器端只有一種啟動方式(舊 lib,沒有 can_wait_start):沒有東西可選,照舊一顆主鈕
    lines: plan.concat(rkS === "machine" ? [t("tr.cloud.restartStartLine")] : rkS === "app" ? [t("tr.restartStartLineLocal")] : []).concat(dcl)
      .concat(recomputing ? [t("tr.cloud.recomputing")] : []).concat([t("tr.startWarn1")]).concat(will ? [will] : []),
    ok: t("tr.startCatchUp"), okDisabled: recomputing, okWhy: recomputing ? t("tr.cloud.recomputing") : null, onOk: catchUp,
  })));
}

/* 休市時按的全部平倉延到開盤、還沒執行(回報 deferred_close,lib/portfolio.defer_paper_tw_close):啟動下單(補齊、等新訊號都是)
   會取消它、改照策略目標下單(lib/portfolio._paper_tw_deferred),框裡先講、列出是哪幾檔。沒有就 null */
function trDeferredCloseLine(r) {
  const keys = Array.isArray(r && r.deferred_close) ? r.deferred_close.filter((k) => typeof k === "string" && k) : [];
  if (!keys.length) return null;
  const labs = keys.slice(0, 3).map((k) => { const s = k.replace(/@spot$/, ""), n = trTwName(s); return n ? s + " " + n : s; });
  const syms = labs.join(LANG === "zh" ? "、" : ", ") + (keys.length > 3 ? (LANG === "zh" ? "" : " ") + t("tr.opt.catchMore", { n: keys.length - 3 }) : "");
  return t("tr.deferredClose", { syms });
}

/* 啟動確認框「細節」最後一行:這台電腦醒著才跑,要 24 小時就到雲端那一袋(開主機、登入都在那一頁自己講;app 內閉環,不外開網頁)。
   先收框再切:框開著時 envCanSwitch 不放行 */
function trAwakeCloudGo() {
  const span = document.createElement("span"), b = document.createElement("button");
  b.type = "button"; b.className = "btn-quiet"; b.textContent = t("tr.means.cloudGo");
  b.addEventListener("click", () => { trackFeature("awake_cloud_go"); delClose(false); envSwitchGuarded("cloud"); });
  span.append(t("tr.means.cloud") + " ", b);
  return span;
}
/* 補齊部位那一刻會送出的單:部位表同一套(目標 − 帳上 Blave 那份;口數列取整;金額列過平台門檻或機器回報的 gates;交易所不交易的不算)。
   第一次讀帳前不知道帳上,不講。回一句話或 null */
function trCatchWill(r) {
  if (!trHasAccount(r) || trFirstReadPending(r)) return null;
  const stored = trStored() || {}, st2 = poPartStates(stored, r.states || {}), target = trClientTargets(stored, st2, trContracts()), bk = trBook(r, target);
  const vk = trVenueKind(trVenueId()), gates = ((bk.last || {}).gates) || {}, contribs = trContribs(stored, st2, trContracts());
  // 列在前三筆的是現在就會成交的:休市中的台股要等開盤(lib/order_paper._check_session),排最後,不把唯一現在會下的那筆藏進「另外 N 檔」
  const out = [], later = [], twShut = !trTwSessionOpen(Date.now(), r.tw_trading_day);
  let anyTw = false;
  Object.keys(target).concat(Object.keys(bk.mine).filter((k) => !(k in target))).sort().forEach((sym) => {
    if (!trTradesSym(vk, sym) || trUsNoAuto(r, sym, (contribs[sym] || []).map((c) => c.name)) || (contribs[sym] || []).some((c) => c.notYet)) return;   // 訊號還沒算出來:會下什麼單不知道,不講
    const spec = trTxfSpec(trCapitalCanon(sym.replace(/@spot$/, ""))), raw = target[sym] || 0, ts = spec ? trLotsTarget(raw).lots : raw, as = bk.mine[sym] || 0, d = ts - as;
    const gs = spec ? null : trGateSide(gates[sym], ts, as);
    if (spec ? !Math.round(Math.abs(d)) : Math.abs(d) < (gs ? gs.usd : 10)) return;
    // 台股的差額是台幣(模擬交易以台幣計價、帳戶幣是 USDT):照標的的幣別寫,不寫帳戶幣;模擬盤寫股數(同策略組合表)
    const sym0 = sym.replace(/@spot$/, ""), twStock = !spec && TR_TWSTOCK_RE.test(trCanonSym(sym0)), u = twStock ? TR_TXF_CCY : trUnit();
    const sh = twStock ? trCatchShares(d, trTwLots(sym, stored, st2)) : null;
    if (sh === 0) return;   // 不足 1 股:模擬盤整股成交,這一筆不會下
    const n = spec ? trLotsFmt(Math.abs(d)) + " " + t(trLotsKey(Math.abs(d), "tr.lotsUnit", "tr.lotUnit"))
      : sh != null ? t(sh === 1 ? "po.twShare" : "po.twShares", { n: trFmt(sh) }) : trFmt(Math.round(Math.abs(d))) + (u ? " " + u : "");
    const twn = twStock ? trTwName(sym0) : "", lab = spec ? t(spec.prod) : twn ? sym0 + " " + twn : sym0;
    if (twStock) anyTw = true;
    (twStock && twShut ? later : out).push(t("tr.opt.catchWill", { side: t(d > 0 ? "tr.opt.buy" : "tr.opt.sell"), sym: (LANG === "zh" && /^[\x21-\x7e]/.test(lab) ? " " : "") + lab, n }));
  });
  out.push(...later);
  if (!out.length) return null;
  // 模擬盤休市不收台股的單(lib/order_paper._check_session),對帳器留到開盤:「現在就下單」對台股那幾筆不成立
  const closed = anyTw && twShut ? " " + t("tr.opt.catchTwClosed") : "";
  return out.slice(0, 3).join(LANG === "zh" ? "、" : "; ") + (out.length > 3 ? (LANG === "zh" ? "" : " ") + t("tr.opt.catchMore", { n: out.length - 3 }) : "") + (LANG === "zh" ? "。" : ".") + closed;
}

/* 選「等新訊號」會一直開著的部位(Wei 10-17):帳上有 Blave 的部位、策略的目標已經比它小(平倉、減碼、翻向)。
   resume_wait 把每條有金額策略的現在訊號記成基準,它的標的兩邊都不動,直到訊號方向再變——暫停中已經想平的部位就一直開著。
   標的範圍照機器端的 gate:有金額的策略碰到的每個標的(投資組合權重 0 的成分也算);還沒算出訊號的不算;差額過門檻的才算(同 trCatchWill)。回幾檔 */
function trWaitStranded(r) {
  if (!trHasAccount(r) || trFirstReadPending(r)) return 0;
  const stored = trStored() || {}, st2 = poPartStates(stored, r.states || {}), contracts = trContracts();
  const target = trClientTargets(stored, st2, contracts), bk = trBook(r, target), vk = trVenueKind(trVenueId()), gates = ((bk.last || {}).gates) || {};
  const keys = new Set(), notYet = new Set(), names = {}, add = (k, n) => { keys.add(k); (names[k] = names[k] || []).push(n); };
  Object.keys(stored).forEach((n) => {
    const s = st2[n], paperTw = trPaperOf(n);
    if (!(Number(stored[n]) > 0) || !s) return;
    if (s.weights && typeof s.weights === "object") { Object.keys(s.weights).forEach((sym) => add(trCanonSym(sym) + (s.market === "spot" || trTwCash(sym, paperTw) ? "@spot" : ""), n)); return; }
    if (!s.symbol) return;
    const sym = trCanonSym(trEffSym(n, s.symbol, contracts)), k = sym + (s.market === "spot" || trTwCash(sym, paperTw) ? "@spot" : "");
    add(k, n); if (s.notYet === true) notYet.add(k);
  });
  let n = 0;
  keys.forEach((sym) => {
    const as = bk.mine[sym] || 0;
    if (!as || notYet.has(sym) || !trTradesSym(vk, sym) || trUsNoAuto(r, sym, names[sym])) return;
    const spec = trTxfSpec(trCapitalCanon(sym.replace(/@spot$/, ""))), raw = target[sym] || 0, ts = spec ? trLotsTarget(raw).lots : raw, d = ts - as;
    if (!(ts * as < 0 || Math.abs(ts) < Math.abs(as))) return;
    const gs = spec ? null : trGateSide(gates[sym], ts, as);
    if (spec ? !Math.round(Math.abs(d)) : Math.abs(d) < (gs ? gs.usd : 10)) return;
    n++;
  });
  return n;
}

/* ── 分頁 ───────────────────────────────────────────── */
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
  trPaintHead();   // 部位上霧時頁首那顆導引鈕收起、狀態行空著(spec-autotrade-empty §3):頁首跟著分頁換
  trPaintTab();
}
function trPaint() {
  if (!envPaint()) return;                         // 雲端沒有主機可看(沒主機 / 未登入 / 啟動中 / 讀不到):中欄是空態,這一頁不畫
  trPaintHead();
  if (!TR.open) return;
  if (TR.view === "po") { poPaint(); return; }   // 策略組合頁(portfolio.js):不看 noaccount,沒連交易所也能設金額
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
  // 落點一律總覽(同網頁):金額在策略組合頁設,部位分頁只列帳戶持倉;手動選過就不再蓋台
  if (!TR.landed || !TR.tab) { trSetTab("over"); return; }
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
  if (state === "loading") return;   // 等狀態檔:標題下那一行已經講了在等什麼(trLoadingText),內容區不再出第二個「載入中…」
  // 「要停就按暫停下單」只在那顆鈕真的能按的時候才講(下單機不在跑時鈕是 disabled,那句就是假話)
  if (state === "unknown") { box.appendChild(trEl("div", "pf-state", TR.env === "cloud" ? t("env.empty.unreach") : t("tr.unknownBody") + (TR.st && TR.st.alive ? t("tr.unknownStop") : ""))); return; }
  // 還沒連交易所(沒有在等回報、不是沒有交易所的重開停止):Setup fog,示意底是總覽(設計 desktop-portfolio-spec §4.6)
  if (!saved && !trNoAccountStopped(trReport())) { box.appendChild(poFog("connect")); return; }
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

/* ── 策略組合 › 配置:策略與金額 + 各商品的總訊號部位(同網頁 renderPosTab;分頁殼與霧在 portfolio.js 的 poPaint)──
   顯示判斷不看 noaccount(設計 desktop-portfolio-spec §3.2):沒連交易所也能設金額,只有清單沒載入、設定讀不到會擋 */
function poPaintCfg() {
  const box = $("po-cfg"), r = trReport() || {};
  if (TR.view !== "po" || box.hidden) return;
  const names = trNames(), stored = trBase(), states = poCfgStates(r);
  // 灰字的時間戳滿 24 小時才帶日期:dead 時快照凍住、app 一直開著,沒有別的資料會變——每一筆失敗的時間戳本身進簽章,跨過那一刻才會重畫
  const now = Date.now(), stamps = (Array.isArray(r.order_errors) ? r.order_errors : []).map((e) => e && typeof e === "object" ? trErrStamp(e.last_at || e.ts, now) : null);
  const data = [TR.env, TR.listLoaded, names, TR.list, stored, states, trEquity(), trUnit(), TR.save, TR.saveErr, r.last_reconcile, r.account, r.self_ledger, r.order_errors, stamps, trExecState(TR.st), envHeadState(TR.st, now), !!TR.sent, !!TR.notApplied, !!(TR.st && TR.st.alive),
    TR.picked ? [...TR.picked].sort() : null, trCfgUnread(r), trTxfPrice(),   // 報價回來了:口數列的名目、合計、倍數要換上
    r.quote_ccy, r.signals_frozen, trFxView(),   // 分區與「還沒有訊號」;匯率／顯示幣別換了,多區合計要換上
    trContracts(), TR.ct, r.can_switch_contract, (r.last_reconcile || {}).rollovers, r.scheduled, Object.keys(TR.flash || {}), trLoadingText(), trVenueId(), r.config, TR_TWN.v];   // TR_TWN.v:台股名字表拿到了   // 合約下拉、換倉中、呼吸點;綁哪家與已存金額(「去啟動」那一列)
  if (!trShould("cfg", box, data)) return;
  const refocus = trPosFocusOf(box);
  box.textContent = "";
  // 「選擇策略」三個分支都在(後兩個停用):鈕不在不在之間跳,位置穩定(picker §2)
  if (!TR.listLoaded || !trReport()) {
    // 策略清單還沒回來(或讀失敗):不畫金額表、更不畫儲存列——「清單是空的」在這時候不是事實,不能邀請人把策略移出組合
    box.appendChild(poCfgSec());
    box.appendChild(trEl("div", "pf-state", trLoadingText()));   // 策略組合頁頁首沒有狀態行:等什麼寫在這裡(只此一處)
  } else if (stored === null) {
    // 主機讀不到設定檔:金額不畫(畫 0 是假話)、不給存,下一份報告讀到就自己恢復
    box.appendChild(poCfgSec());
    box.appendChild(trEl("div", "pf-state", t("tr.cfgNull")));
  } else if (!names.length && !trPickDirty(TR.picked, stored, trPickKeep(TR.env, TR.picked, stored, trListNames())) && !Object.keys(TR.bad).length) {
    // 一支都沒選(或連可選的都沒有):Setup fog(canon › Components › Setup fog);草稿把策略都取消勾選、等著儲存時不上霧(儲存列是唯一的出口)
    box.appendChild(poFog("pick"));
  } else {
    box.appendChild(trAmountTable(names, stored, states));
    box.appendChild(poSigTable(r, stored, states, "cfg"));
  }
  trPosFocusBack(box, refocus, $("po-h"));
}
/* 策略組合 › 配置才用:投資組合還沒有實盤權重時,畫機器回報的回測最後一期(r.previews,機器端 portfolio_reporter.typec_previews)。
   自動下單 › 部位不用:對帳器只照實盤的 state.json 下單,拿預覽算差額會畫出一筆不會發生的單 */
function poCfgStates(r) {
  const out = Object.assign({}, r.states || {}), pv = r.previews;
  if (pv && typeof pv === "object") Object.keys(pv).forEach((n) => { const p = pv[n], cur = out[n];
    if (cur && cur.weights && typeof cur.weights === "object") return;
    if (p && p.weights && typeof p.weights === "object" && !Array.isArray(p.weights)) out[n] = p; });
  return out;
}
/* ── 自動下單 › 部位:唯讀的策略組合配置對照帳上(設計 autotrade-bridge-mockup A 案;同網頁 buildPositionsSection → buildSigTargets("trade"))──
   讀機器回報的已存配置(不是策略組合頁上未儲存的修改):按下啟動會照的就是這一份 */
function trPaintPos() {
  const box = $("tr-pos"), r = trReport() || {}, now = Date.now(), fog = trZNow(envHeadState(TR.st, now)).fog;
  const stamps = (Array.isArray(r.order_errors) ? r.order_errors : []).map((e) => e && typeof e === "object" ? trErrStamp(e.last_at || e.ts, now) : null);
  const data = [TR.env, TR.list, r.account, r.last_reconcile, r.self_ledger, r.config, r.states, r.order_errors, stamps, r.quote_ccy, r.signals_frozen, r.can_trade_portfolio,
    trEquity(), trUnit(), trTxfPrice(), trFxView(), trExecState(TR.st), envHeadState(TR.st, now), TR.startAt || 0, !!TR.noAmtLink, !!TR.zBridge, fog, TR_TWN.v];
  if (!trShould("pos", box, data)) return;
  const refocus = trPosFocusOf(box);
  box.textContent = "";
  // 還沒選策略(或沒有能勾的):部位是唯一真的空著的一格,上霧＋卡(spec-autotrade-empty §4);選了、金額 0 照畫表
  if (fog) box.appendChild(poFog(fog === "pick" ? "pos-pick" : fog === "draft" ? "pos-draft" : "pos-new"));
  else box.appendChild(poSigTable(r, trStored() || {}, r.states || {}, "trade"));
  trPosFocusBack(box, refocus, $("tr-tab-pos"));
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
function trRowTxf(n) { const st = ((trReport() || {}).states || {})[n] || {}, x = TR.list.find((y) => y.name === n) || {}, s = trCtPend() ? trCtStored(n) : null; return s ? trTxfSpec(s) : trTxfSpec(trEffSym(n, st.symbol || x.symbol, trContracts())); }
function trRowIsLot(n) { return !!trRowTxf(n); }
/* 台指期換執行合約(契約 txf-contract-switch;同網頁 pfCtStored / pfCt / pfCtGate)。存著的生效合約:主機回報 config.contracts 蓋過策略的 SYMBOL;
   不是台指期 = null。trCt = 這一頁待存的那一個(下拉剛選的、雲端送出還沒對上的),沒有就是存著的 */
/* 「存著的」合約要跟「存著的」口數(trBase)出自同一份快照:雲端存完、報告還沒對上時 trBase 是送出的那一份(新合約的口數),
   合約也要讀送出的那一份(ct.sent),不然換算基準 = 新合約口數 × 舊合約點值,第一步會送出放大的口數(稽核 P0-1)。
   不認 R1(同網頁 pfCtStored;runtime 沒覆寫時 TXFR1 也不是口數列) */
function trCtPend() { return TR.env === "cloud" && !!TR.sent; }
function trCtStored(n) {
  const st = ((trReport() || {}).states || {})[n] || {}, x = TR.list.find((y) => y.name === n) || {};
  const sym = String(x.symbol || st.symbol || "").trim().toUpperCase();
  if (!trTxfSpec(sym) || x.portfolio === true) return null;
  const sent = trCtPend() && TR.ct && TR.ct.sent ? TR.ct.sent[n] : null;
  if (typeof sent === "string" && trTxfSpec(sent)) return sent;
  const c = (trContracts() || {})[n];
  return typeof c === "string" && trTxfSpec(c) ? c : sym;
}
function trCt(n) { const s = trCtStored(n); if (!s) return null; const e = TR.ct && TR.ct.edits ? TR.ct.edits[n] : null; return e && trTxfSpec(e) ? e : s; }
// 畫下拉 = 機器回報 can_switch_contract === true(下單停著、對帳器沒在跑也可能是 true;只看這一欄,契約 §7)。其餘一律純文字
function trCtGate(n) { return !!trCtStored(n) && !trCtPend() && (trReport() || {}).can_switch_contract === true; }   // 雲端存完待對上期間純文字(稽核 P0-1 第二道)
// 這一列「新」那一側的每點價值與商品名(金額表、確認框的新值、口數換算);總訊號部位與確認框的「原」讀 trRowTxf
function trRowTxfNew(n) { const c = trCtStored(n) ? trCt(n) : null; return c ? trTxfSpec(c) : trRowTxf(n); }
function trCtDirty(names) { const ed = (TR.ct && TR.ct.edits) || {}; return names.some((n) => { const s = trCtStored(n); return !!s && !!ed[n] && ed[n] !== s; }); }
// 換合約 = 待存:口數照基準(口數 × 每點價值)換算寫進 edits,切回存著的合約且口數回到原值就不算改動(同網頁 pfCtPick)
function trCtPick(n, root) {
  const cur = trCt(n), sp = trTxfSpec(root);
  if (!cur || !sp || root === cur || trCtPend()) return;
  const stored = (trBase() || {})[n] || 0, lots = TR.edits[n] != null ? TR.edits[n] : stored;
  /* 換算基準 = 用戶原本的名目價值(口數 × 每點價值),存檔後也留著:連續來回切換不拿取整後的口數再換回去、不累積誤差。
     基準跟手上這個合約的口數對不上了(別處改過口數)就重算 */
  if (TR.ct.basis[n] == null || trCtConv(TR.ct.basis[n], TR_TXF_SPECS[cur].cv) !== lots) TR.ct.basis[n] = lots * TR_TXF_SPECS[cur].cv;
  const nx = trCtConv(TR.ct.basis[n], sp.cv);
  if (root === trCtStored(n)) delete TR.ct.edits[n]; else TR.ct.edits[n] = root;
  if (nx === stored) delete TR.edits[n]; else TR.edits[n] = nx;
  delete TR.bad[n]; if (TR.raw) delete TR.raw[n];
  if (TR.save === "failed" || TR.save === "saved") { TR.save = TR.sent && TR.env === "cloud" ? "sent" : null; TR.saveErr = null; }
  delete TR.reqIds.amounts;
  trackFeature("contract_switch");
  TR.sig.cfg = null; poPaintCfg(); ctFocus("cfg", n);
}
// 金額表選單每個合約後面寫的口數(同 trCtPick 的換算)
function trCtLotsFor(n) {
  return (root) => { const cur = trCt(n), lots = TR.edits[n] != null ? TR.edits[n] : (trBase() || {})[n] || 0;
    const b0 = TR.ct.basis[n], basis = b0 != null && trCtConv(b0, TR_TXF_SPECS[cur].cv) === lots ? b0 : lots * TR_TXF_SPECS[cur].cv; return trCtConv(basis, TR_TXF_SPECS[root].cv); };
}
// 這次要送的 contracts:機器回報能換、而且有合約真的變了才帶;帶就帶整份(每支台指期成員的生效合約)
function trCtPayload(names) {
  if ((trReport() || {}).can_switch_contract !== true) return null;
  const out = {}; let ch = false;
  names.forEach((n) => { const s = trCtStored(n); if (!s) return; out[n] = trCt(n); if (out[n] !== s) ch = true; });
  return ch ? out : null;
}
// 換倉中(機器回報 last_reconcile.rollovers):標的旁一個小標,原因放 title(卡住時用戶唯一看得到的線索)
function trCtRollTag(n) {
  const list = ((trReport() || {}).last_reconcile || {}).rollovers, r = Array.isArray(list) ? list.find((x) => x && x.strategy === n) : null;
  if (!r) return null;
  const prod = (c) => { const sp = trTxfSpec(c); return sp ? t(sp.prod) : "—"; };
  const why = { closing: "ct.rollClosing", waiting_gate: "ct.rollGate", waiting_pending: "ct.rollPending", halted: "ct.rollHalted" }[r.state];
  const tag = trEl("span", "ct-roll", t("ct.rolling"));
  if (why) { const w = t(why, { from: prod(r.from), to: prod(r.to) }); tag.title = w; tag.setAttribute("aria-label", t("ct.rolling") + " — " + w); }
  return tag;
}
/* 依計價分區(units spec §9)的資料:回報頂層 quote_ccy 與 signals_frozen(舊 runtime 沒有這兩欄 = 照尾碼推、沒有 pending) */
function trQuoteMap() { const q = (trReport() || {}).quote_ccy; return q && typeof q === "object" && !Array.isArray(q) ? q : null; }
// 沒連交易所而舊的下單程式還活著時訊號凍住:之後才勾的策略完全沒有 state.json,畫「還沒有訊號」,不畫成 0
/* 「等下次執行」在這兩種情況是假話,改講「主機版本較舊，更新後才會算」(同網頁 pfHostOld,Wei 10-14):訊號被凍住(signals_frozen),
   或主機的 lib 不會算投資組合(can_trade_portfolio 不是 true;缺席 = 更舊的 runtime) */
function trHostOld() { const r = trReport() || {}; return !!(r.signals_frozen && typeof r.signals_frozen === "object") || r.can_trade_portfolio !== true; }
function trNoSignalYet(n) { const f = (trReport() || {}).signals_frozen; return !!f && typeof f === "object" && Array.isArray(f.pending) && f.pending.indexOf(n) >= 0; }
/* 推不出區、也還沒有成分的列(剛勾進、還沒存也還沒跑過的投資組合:回報沒有它的 quote_ccy)退回策略本身的市場。
   先看 runtime strategy_market(本機在 strategy_kinds;雲端讀 /oauth/desktop/cloud/state 的 strategies_summary[].market,同網頁 stratMarket——
   api 從策略索引的 summary 帶出來(651fb09e),機器 runtime 要會回報 market(11593e0 起)才有;"mixed" 就是未定),沒有才看清單的 twdAll——UNIVERSE 每一檔都是台股才算(twd 是「有一檔台股」,
   混了加密的也是 true,不能拿來當幣別;稽核 S2)。只認台股 → TWD,同網頁 pfRowUnit;加密的幣別要看成分,不拿帳戶幣猜(§9.2) */
function trZoneOf(n) {
  const r = trReport() || {}, st = (r.states || {})[n] || {}, x = TR.list.find((y) => y.name === n) || {}, tc = trTypeC(st, n);
  const z = trRowZone(n, st.symbol || x.symbol, tc, x.portfolio === true, trQuoteMap());
  if (z !== TR_ZONE_UNKNOWN) return z;
  const mk = trSrcMarket(r, n);
  // 美股(同 trSymZone):成分是 AMZN 這種沒有尾碼的代號,有成分也推不出,市場說 us_stock 就是 USD
  if (mk === "us_stock") return "USD";
  if (tc && tc.keys.length) return z;
  return (mk ? mk === "tw_stock" : x.twdAll === true) ? TR_TXF_CCY : z;
}
// 幣別未定的原因:全是還沒回報的投資組合 = 跑過一次、算出成分就知道;單一標的(BTCUSD 這種)或跑過還未定 = 混了幣別或看不出計價,再跑也不會變
function trUnknownWhy(ns, states) { return ns.some((n) => (states && states[n]) || !(TR.list.find((y) => y.name === n) || {}).portfolio) ? t("tr.ccyMixed") : t("tr.ccyAfterRun"); }
function trZoneLabel(z) { return z === TR_ZONE_LOTS ? t("tr.grpLots") : z === TR_ZONE_UNKNOWN ? t("tr.grpUnknown") : z; }
// 整表只有一區時寫在欄頭的單位:口數區寫「口」,未定區不寫
function trZoneUnit(z) { return z === TR_ZONE_LOTS ? t("tr.lotsUnit") : z === TR_ZONE_UNKNOWN ? null : z; }
/* 匯率與顯示幣別是 api 的信封欄位(不依交易所):兩個視角都讀雲端那一份。沒登入 / 還沒讀到 = 沒有匯率,多區合計畫「—」 */
function trFxView() {
  const c = typeof TR_BAGS !== "undefined" && TR_BAGS.cloud.st ? TR_BAGS.cloud.st.cloud : null;
  const fx = c && c.fx_rates && typeof c.fx_rates === "object" ? c.fx_rates : null, base = c && typeof c.currency === "string" && c.currency ? c.currency.toUpperCase() : "USD";
  const ls = typeof localStorage !== "undefined" ? localStorage : null;
  if (fx) {
    // 記住這一份(換了才寫):登入失效時的退路
    const sig = JSON.stringify([fx, base]);
    if (trFxView.last !== sig) { trFxView.last = sig; try { if (ls) ls.setItem("ws_fx_cache", JSON.stringify({ fx, base, at: Date.now() })); } catch (_) { /* noop */ } }
    return { fx, base };
  }
  /* 退路(Mac e2e 10-14):登入失效／沒連上時雲端那份沒有匯率,台指期口數換算整個停擺。用上次拿到的那一份(這台電腦 localStorage),
     標 cached = 拿到的時間——數字是 ≈ 的換算,畫面要講是哪一天的匯率;一次都沒拿過才是 null */
  let k = null;
  try { k = ls ? JSON.parse(ls.getItem("ws_fx_cache") || "null") : null; } catch (_) { k = null; }
  // 超過 30 天不用(USD/TWD 一年可能漂 5–10%,台指期口數會差):回到「沒有匯率」,原因另講(稽核 r4 P2);7 天以上確認框提醒日期
  if (k && k.fx && typeof k.fx === "object" && typeof k.at === "number") {
    if (Date.now() - k.at > 30 * 86400000) return { fx: null, base, expired: k.at };
    return { fx: k.fx, base: typeof k.base === "string" ? k.base : "USD", cached: k.at };
  }
  return { fx: null, base };
}
// 金額表與確認框共用的分區合計與淨值倍數(分母是畫面上那一份淨值);acctZone 只給區的排序用
function trZoneSum(amounts, eq, money) {
  const fv = trFxView(), vid = trVenueId(), acct = trUnit(), mf = money || trRowMoney;
  const mult = trEquityMult(amounts, trZoneOf, mf, vid, acct, eq, fv.fx, trPaperTwOk());
  // 倍數那一段的字:綁了交易所但淨值還沒讀到寫「淨值 —」(不寫 0.00×);沒綁、或這個帳戶不交易這些列,整段不出
  const multText = mult != null ? t("tr.equityMult", { x: trMultFmt(mult) }) : vid && !(typeof eq === "number" && isFinite(eq) && eq > 0) ? t("tr.equityMultNa") : "";
  return { ...trZoneTotals(amounts, trZoneOf, mf, fv.fx, fv.base), mult, multText,
    acctZone: trMultZone(vid, acct, Object.keys(amounts).map(trZoneOf)) };
}
// 合計那個數:換算出來的(≈)取整、不帶小數;null = 「—」。逐幣別的 tooltip 退場(同網頁 63b7b5fe)
function trTotalText(tt) { return tt.v == null ? "—" : tt.approx ? "≈ " + trFmt(Math.round(tt.v)) : trFmt(tt.v); }
// 這一列的錢:口數列換成參考金額(沒有報價 = null),其他照原值
function trRowMoney(n, v) { const sp = trRowTxfNew(n); return sp ? trTxfRefMoney(sp, v, trTxfPrice()) : v; }
function trRowMoneyStored(n, v) { const sp = trRowTxf(n); return sp ? trTxfRefMoney(sp, v, trTxfPrice()) : v; }
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
/* 台股代號後面的名字(1438 三地開發;0.1.25,同網頁):總訊號部位表(配置與自動下單 › 部位)與「N 支策略」拆解句。
   表在主行程(twnames.js,本機快取一天);每個視窗拿到一份就不再問,拿到時 TR_TWN.v +1 讓兩張表的簽章變、重畫一次。拿不到只顯示代號 */
function trTwNamesWant(now) {
  const t0 = now == null ? Date.now() : now;
  if (TR_TWN.names || TR_TWN.busy || t0 - TR_TWN.at < TR_TWN_RETRY_MS) return false;
  if (typeof window === "undefined" || !window.blave || typeof window.blave.twNames !== "function") return false;
  TR_TWN.busy = true;
  Promise.resolve(window.blave.twNames()).then((m) => { if (m && typeof m === "object" && Object.keys(m).length) { TR_TWN.names = m; TR_TWN.v++; trPaint(); } })
    .catch(() => {}).finally(() => { TR_TWN.busy = false; TR_TWN.at = Date.now(); });
  return true;
}
/* 列的 key(1438@spot / 2330.TW)→ 名字;不是台股、或還沒拿到表 → ""。台指期(TXF…)不是數字代號,不會進來 */
function trTwName(sym) {
  const s = String(sym || "").trim().replace(/@spot$/i, "").toUpperCase();
  if (!TR_TWSTOCK_RE.test(s)) return "";
  trTwNamesWant();
  return (TR_TWN.names && TR_TWN.names[s.replace(/\.TWO?$/, "")]) || "";
}
/* 券商台股列(沒綁交易所、照著去券商下單):整股單＋零股單 →「2 張 340 股」;不足一張「340 股」;剛好整張「2 張」;不足一股「0 股」 */
function trTwLotsText(lots, odd) {
  const L = Math.abs(lots || 0), O = Math.abs(odd || 0), parts = [];
  if (L) parts.push(t(L === 1 ? "po.twLot" : "po.twLots", { n: trFmt(L) }));
  if (O || !L) parts.push(t(O === 1 ? "po.twShare" : "po.twShares", { n: trFmt(O) }));
  return (lots < 0 || odd < 0 ? "-" : "") + parts.join(" ");
}
/* 代號格裡的名字:截尾(.tw-name 有寬度上限),全名在 title */
function trTwNameEl(sym) {
  const nm = trTwName(sym);
  if (!nm) return null;
  const el = trEl("span", "tw-name", nm); el.title = nm;
  return el;
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
function trPosFocusBack(box, key, fallback) {
  if (key == null) return;
  const b = [...box.querySelectorAll(".pf-strat, [data-fk]")].find((x) => trPosKey(x) === key && !x.disabled && !x.closest("[hidden]")) || fallback || $("po-h");
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
      await poOpen("cfg"); srSay(t("res.gone.strat"));
      const tb = $("po-h"); if (tb && tb.offsetParent) tb.focus();
      return;
    }
    if (RP.name !== n || !RP.data) return;   // 等的時候點了別支
    trackFeature("trade_strat_open");
  }
  resFocusHead();
}
/* 配置表「部位」格(spec portfolio-help-icon §2,同網頁 pfPaintPosCell):主行方向字＋不帶號的數字,副行訊號倍數／投資組合持倉檔數,
   副行只在有方向時畫。判斷順序:主機版本較舊 → 還沒有訊號 → 金額 0 不下單 → 空手 → 多／空。
   口數列取整同機器對帳器(trRoundLots),取整前的原值與名目台幣掛在數字上;取整後 0 口是空手,原值照樣掛著。
   雲端等回報(sentOn):數字是拿舊金額算的,整格灰一階;部位是 0 時畫金額欄同一種短線 */
function trPaintPosCell(td, a, pos, tc, f) {
  const pc = f.sentOn ? " pend-col" : "";
  td.textContent = ""; td.title = ""; td.className = "n pos" + pc;
  if (f.noSig) { td.className = "n pos na pending" + pc; td.textContent = t("po.hostOld"); return; }
  if (f.notYet) { td.className = "n pos na" + pc; td.textContent = "—"; td.title = t("tr.sigNotYet"); return; }
  const raw = a * pos, lots = f.txf ? trRoundLots(raw) : null;
  const zero = !a || (f.txf ? !lots : tc ? !tc.long && !tc.short : !pos);
  if (zero && f.sentOn) { td.appendChild(trEl("span", "amt-dash")); return; }
  const word = (k) => td.appendChild(trEl("span", "pos-word", t(k)));
  if (!a) { word("tr.amtOff"); return; }
  const rawTip = f.txf && raw !== lots ? t("po.lotsRawTip", { n: trLotsTgtFmt(raw) }) : "";
  if (zero) { const w = word("tr.flat"); if (rawTip) w.title = rawTip; return; }
  const leg = (v, num) => { const g = trEl("span", "pos-leg"); g.append(trEl("span", "dir " + (v > 0 ? "buy" : "sell"), t(v > 0 ? "tr.rel.long" : "tr.rel.short")), " ", num); return g; };
  const money = (v) => trEl("span", "num", trFmt(Math.abs(v)));
  const main = trEl("span", "pos-main");
  let sub;
  if (f.txf) {
    const num = trEl("span", "num", trLotsFmt(Math.abs(lots))), m = trTxfRefMoney(f.txf, Math.abs(lots), trTxfPrice());
    num.title = [rawTip, m != null ? t("tr.lotsNotionalTip", { amt: trFmt(Math.round(m)) }) : ""].filter(Boolean).join("\n");
    main.appendChild(leg(lots, num)); sub = t("tr.sigLine", { x: trSignalText(pos, null) });
  } else if (tc) {
    if (tc.long && tc.short) { main.classList.add("split"); main.append(leg(1, money(a * tc.long)), trEl("span", "sep", "·"), leg(-1, money(a * tc.short))); }
    else main.appendChild(leg(tc.long - tc.short, money(a * (tc.long - tc.short))));
    sub = t("tr.typeCHold", { n: tc.n });
  } else { main.appendChild(leg(pos, money(a * pos))); sub = t("tr.sigLine", { x: trSignalText(pos, null) }); }
  const box = trEl("span", "cell2"); box.append(main, trEl("span", "pos-sub", sub)); td.appendChild(box);
}
function trAmountTable(names, stored, states) {
  const frag = document.createDocumentFragment();
  frag.appendChild(poCfgSec());
  const total = trEl("div", "pf-total"), bar = trEl("div", "pf-savebar"), cloud = TR.env === "cloud";
  /* 雲端(spec-desktop-cloud-s4):跟本機同一張表、同一套驗證,只差三件——讀不到新狀態不給存(amounts 是整份覆蓋,
     拿舊報告當底會蓋掉別處剛改的)、存完要等主機回報才對得上(.pend 記號)、送出走 trSend(單飛 + request_id 沿用)。 */
  // 讀不到金額設定:兩個視角都擋(本機的回報也是 build_report(),amounts 一樣是整份覆蓋)
  const cfgBad = trCfgUnread(trReport());
  const stale = cloud && (!(TR.st && TR.st.alive) || cfgBad), sentOn = cloud && !!TR.sent;
  const hidden = cloud ? trHidden(names, stored, trListNames()) : [];
  const gates = ((trReport() || {}).last_reconcile || {}).gates || {};
  const grpCells = {};   // 區標題列的小計格(打字時跟著合計重畫)
  const paintTotal = () => {
    // 雲端:合計跟確認框同一個口徑——表上沒列出、但照原樣帶著送的那幾支也算進去(稽核 L3)
    // 淨值快照:確認框用這裡顯示的那一個(不再自己讀一次),同一組金額兩處的倍數才會一樣(0.0.3 實機 989.95x / 988.37x)
    const eq = trEquity();
    const am = cloud ? trSendAmounts("cloud", names, stored, TR.edits, trListNames()) : trCurrentAmounts(names, stored, TR.edits);
    const zt = trZoneSum(am, eq);
    // 區標題(§9.4):小計只在錢的區有兩列以上時出(一列就等於那一列);口數區不加口數、未定區沒有幣別,都不出
    Object.keys(grpCells).forEach((z) => { const g = grpCells[z], Z = zt.zones[z];
      g.sub.textContent = Z && Z.rows >= 2 && z !== TR_ZONE_LOTS && z !== TR_ZONE_UNKNOWN ? trFmt(Z.sum) : ""; });
    /* 表底合計:只有一區 = 那一區的數(口數區是 ≈ 名目 TWD)+ 單位;兩區以上 = 換算成顯示幣別的 ≈ 整數。淨值倍數只有一個,接在合計後面。
       全是口數列也出(推翻 desktop-10-08 #4:名目 ≈ TWD 是期貨帳戶唯一看得到淨值倍數的地方,units spec §5 電腦版 #4) */
    total.textContent = "";
    total.appendChild(trEl("span", "", t("tr.total")));
    const tn = trEl("span", "n", trTotalText(zt.total));   // 逐幣別的 title 拿掉(同網頁 63b7b5fe)
    if (zt.total.v != null && zt.total.ccy) tn.appendChild(trEl("span", "ccy", zt.total.ccy));
    total.appendChild(tn);
    // 淨值倍數搬到自動下單 › 部位的合計列(設計 autotrade-bridge A7:跟著帳上走)
  };
  const anyBad = () => Object.keys(TR.bad).length > 0;
  const settles = [];   // 每一格的離開欄位驗證:按「儲存」時全部重跑一次,不靠 blur 有沒有先發生(稽核 audit-0.1.13-web S1)
  let svBtn = null;   // 儲存鈕:blur 時只更新它的 disabled,不重建整列——打完直接點「儲存」時,mousedown 要落在還活著的那顆鈕上(稽核 R3)
  const paintBar = () => {
    bar.textContent = ""; bar.hidden = false;
    if (TR.save === "saving") { bar.appendChild(trEl("span", "txt", t("tr.saving"))); return; }
    if (TR.save === "saved") { const ok = trEl("span", "txt ok", t("tr.saved")); ok.setAttribute("role", "status"); bar.appendChild(ok); return; }
    // dirty 含 picker 的草稿(0.1.26:新勾的、被取消勾選的,金額 0 也算):被取消勾選的那列已經從表上消失,儲存列是它唯一的出口;換了合約也算
    const dirty = trDirty(names, stored, TR.edits) || anyBad() || trPickDirty(TR.picked, stored, hidden) || trCtDirty(names);
    const routeDirty = !dirty && !sentOn && trRouteDirty(trReport());   // 路由跟現在綁的那家不同:沒改金額也要能存一次
    // 雲端存完、還沒對上、而且沒再改:只有一句等回報的話,沒有鈕(不出「已儲存 ✓」:這台電腦沒有套用任何東西)
    if (sentOn && !dirty && TR.save !== "failed") { bar.appendChild(trEl("span", "txt", t("tr.cloud.pendAmounts"))); return; }
    // 等了 30 秒主機還沒套用剛存的那份:畫面已改顯示主機上的值,這一格講清楚(套用後自動收掉)
    if (cloud && TR.notApplied && !dirty && TR.save !== "failed") { bar.appendChild(trEl("span", "txt", t("tr.cloud.notApplied"))); return; }
    // 存好了、還沒在下單(post-connect-flow 第 4 列):儲存列的位置換成「還沒開始下單／下單已暫停 ·〔到自動下單啟動〕」
    // 過場中(剛按了啟動／暫停)、要確認帳戶、金鑰被拒:自動下單頁的出口不是「啟動下單」,不畫(稽核 audit-post-connect-b)
    const goKey = !dirty && !routeDirty && TR.save !== "failed" && !cfgBad && !TR.pending && !trAcctAsk(trReport()) && !trKeyBad(TR.env) ? trGoStartKey(envHeadState(TR.st, Date.now()), trReport()) : null;
    if (goKey) {
      const gb = trEl("button", "btn-fill", t("po.goBtn")); gb.type = "button"; gb.dataset.fk = "go-start";
      gb.addEventListener("click", () => { trackFeature("cfg_go_start"); trOpen("pos").then(() => { const g = $("tr-go"); if (g && !g.hidden) g.focus(); }); });
      bar.append(trEl("span", "txt", t(goKey)), gb); return;
    }
    if (TR.save === "failed") bar.appendChild(trEl("span", "txt err", TR.saveErr || t("tr.cmdFailed")));
    else { bar.hidden = !dirty && !routeDirty; bar.appendChild(trEl("span", "txt", cfgBad ? (cloud ? t("tr.cloud.cfgUnread") : t("tr.cfgUnreadLocal")) : stale ? t("tr.cloud.saveStale") : routeDirty ? t("tr.routeSave") : "")); }   // 有改動時只放兩顆鈕(同網頁):「尚未儲存」那句退場
    const rv = trEl("button", "pf-cancel", t("tr.revert")); rv.type = "button"; rv.dataset.fk = "revert";
    // 還原 = 回到底稿(雲端存完還沒對上時是送出的那一份);picker 的草稿一起放掉(新勾的列消失、被取消勾選的列帶原金額回來);內容變了,request_id 也跟著換(S4 §4)
    rv.addEventListener("click", () => { TR.edits = {}; TR.bad = {}; TR.raw = {}; TR.picked = null; TR.a1 = null; TR.ct.edits = {}; TR.ct.basis = {}; delete TR.reqIds.amounts; TR.saveUnknownAt = 0; TR.save = TR.sent && cloud ? "sent" : null; TR.saveErr = null; TR.sig.cfg = null; poPaintCfg(); $("po-h").focus(); });
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
  // 機器凍結訊號(signals_frozen)期間:表上的訊號不會動,表頭上面一句(同網頁 pfSignalsPaused)
  const frozen = (trReport() || {}).signals_frozen;
  if (frozen && typeof frozen === "object") frag.appendChild(trEl("p", "pf-frozen", t("po.signalsPaused")));
  // 換倉紀錄讀不出來(rollovers 一列 strategy null、state record_unreadable):整個台指期家族暫停下單,有台指期列就在表上面講一句
  const rolls = ((trReport() || {}).last_reconcile || {}).rollovers;
  if (Array.isArray(rolls) && rolls.some((x) => x && x.state === "record_unreadable") && names.some((n) => !!trRowTxf(n))) frag.appendChild(trEl("p", "pf-frozen err", t("ct.recordUnreadable")));
  const scroll = trEl("div", "pf-scroll"), tbl = trEl("table", "pf-tbl zoned");
  /* 依計價分區(units spec §9):一區一個 tbody,區標題寫單位;只有一區時不畫區標題,單位回欄頭 */
  const zoneOf = {}; names.forEach((n) => { zoneOf[n] = trZoneOf(n); });
  const zoneKeys = Object.keys(zoneOf).map((n) => zoneOf[n]), zones = trZoneOrder(zoneKeys, trVenueId(), trMultZone(trVenueId(), trUnit(), zoneKeys));
  // 整表都是未定區:欄頭寫「幣別未定」、停上去講原因(單位回欄頭的規則照舊,只是未定區也要有字)
  const oneUnknown = zones.length === 1 && zones[0] === TR_ZONE_UNKNOWN;
  const oneUnit = oneUnknown ? t("tr.grpUnknown") : zones.length === 1 ? trZoneUnit(zones[0]) : null;
  const head = trHead([[t("tr.col.strategy"), ""], [t("tr.col.symbol"), "c-sym"], [t("tr.col.amount"), "n", oneUnit, oneUnknown ? trUnknownWhy(names, states) : ""], [t("tr.col.pos"), "n" + (sentOn ? " pend-col" : ""), oneUnit]]);
  if (sentOn) head.querySelector("th:last-child").title = t("tr.cloud.pendTarget");
  tbl.appendChild(head);
  // 排序鍵跟顯示同一套換算(同網頁 sortVal):口數列換成參考金額,換不了當 0
  const sortVal = (n) => { const m = trRowMoney(n, stored[n] || 0); return m == null ? 0 : m; };
  zones.forEach((z) => {
    const tb = document.createElement("tbody");
    if (zones.length > 1) {
      // 區標題列(§9.4):不加框線、不加底色,區與區之間靠間距;每一格照欄位排(窄欄收掉標的欄時對齊不跑)
      const g = trEl("tr", "grp"), sub = trEl("span", "");
      const c0 = trEl("td", "grp-l" + (z === TR_ZONE_LOTS || z === TR_ZONE_UNKNOWN ? " cjk" : ""), trZoneLabel(z)), c3 = trEl("td", "n"), c4 = trEl("td", "n");
      if (z === TR_ZONE_UNKNOWN) c0.title = trUnknownWhy(names.filter((n) => zoneOf[n] === z), states);
      c3.appendChild(sub);
      g.append(c0, trEl("td", "c-sym"), c3, c4); tb.appendChild(g);
      grpCells[z] = { sub };
    }
    names.filter((n) => zoneOf[n] === z).sort((a, b) => sortVal(b) - sortVal(a)).forEach((n) => {
      const x = TR.list.find((y) => y.name === n) || {}, st = states[n] || {};
      const sym = trEffSym(n, st.symbol || x.symbol, trContracts()), market = st.market || x.market, tc = trTypeC(st, n), isC = !!tc || x.portfolio === true, noSig = trNoSignalYet(n);
      // 回報的 states 裡還沒有這支(還沒跑出第一次 live tick;選擇策略框新勾、還沒存的也是):部位寫「—」,不是空手
      const notYet = !isC && !noSig && !(states && states[n]);
      // 台指期列:這一格是口數;標的欄寫商品名(微台／小台／大台,同網頁)。換了合約(待存)就照新的那一個
      const txf = isC ? null : trRowTxfNew(n), ctOn = !isC && trCtGate(n);
      if (txf) trTxfWant();   // 口數列的參考金額要報價:統一與模擬交易在這台電腦也下台指期
      // 投資組合(§8):標的列成分代號(trTypeCLabel);還沒算過權重寫「—」並說下次執行後才有。持有多少看下表(一檔一列)
      // 還沒跑過、回報沒有成分(選擇策略框剛勾進的草稿也是)的,先列策略檔的 UNIVERSE(Wei 10-16:≤3 檔全列、>3 檔「等 N 檔」、hover 全列);
      // 動態組出來讀不到 UNIVERSE 的才寫「—」
      const draftTc = isC && !tc && Array.isArray(x.universe) && x.universe.length ? { n: 0, long: 0, short: 0, keys: x.universe.slice() } : null;
      const tcl = isC && (tc || draftTc) ? trTypeCLabel(tc || draftTc, t, trTwName, x.universe) : null;
      const symText = isC ? (tcl ? tcl.text : "—") : txf ? t(txf.prod) : sym || "—";
      const symTip = isC && !tcl ? t("tr.typecPending") : tcl ? tcl.tip : "";
      // 美股純代號(trUsNoAuto):A 型取代市場標籤,投資組合在「投資組合」後面再接一個
      const usNo = isC ? trUsNoAuto(trReport(), null, [n]) && (!(tc || draftTc) || (tc || draftTc).keys.every((k) => trUsNoAuto(trReport(), k, [n])))
        : !txf && trUsNoAuto(trReport(), sym || null, [n]);
      const row = document.createElement("tr");
      const first = trEl("td", "key");
      first.appendChild(trStratName(n));
      // 市場標籤:剛選進、還沒回報、清單也沒寫市場的不猜(不先標「合約」)
      if (isC || market) first.appendChild(trEl("span", "mkt-tag", isC ? t("po.mktPortfolio") : usNo ? t("tr.mkt.noAuto") : t(trMktKey(sym, market === "spot", !!txf))));
      if (usNo && isC) first.appendChild(trEl("span", "mkt-tag", t("tr.mkt.noAuto")));
      // 草稿列(選擇策略框或策略頁「加到策略組合」勾進來、還沒存):標「未儲存」;存了會送單時下面再一句(spec F4)
      if (!(n in stored)) { first.appendChild(trEl("span", "mkt-tag unsaved", t("po.unsaved"))); if (trCfWillOrder(n, trPvOf(trReport(), n) || st, trContracts())) first.appendChild(trEl("span", "pf-note live", t("po.willOrder"))); }
      // 標的格:台指期列可以換合約(安靜觸發器,canon › Dropdown menu);換倉中掛小標。窄欄時同一份在策略名下那行
      const symInto = (host) => {
        if (ctOn) host.appendChild(ctTrigger("cfg", n, trCt(n), (root) => trCtPick(n, root), trCtLotsFor(n)));
        else { host.append(symText); const tw = isC || txf ? null : trTwNameEl(sym); if (tw) host.appendChild(tw); }
        const roll = txf ? trCtRollTag(n) : null; if (roll) host.appendChild(roll);
        // 換合約換算不足一口:這一格是 0 口(不下單),講出來讓用戶自己決定要不要填口數
        if (txf && TR.ct && TR.ct.basis[n] > 0 && (TR.edits[n] != null ? TR.edits[n] : stored[n] || 0) === 0) host.appendChild(trEl("span", "pf-note ct-under", t("ct.underLot")));
        return host;
      };
      const sub = symInto(trEl("span", "sub-sym" + (isC || txf ? "" : " mono"))); if (symTip) sub.title = symTip;
      first.appendChild(sub);
      // 投資組合策略沒有實盤路徑:0 → >0 是機器端必拒的轉換,從源頭鎖掉並講原因;已經 >0 的存量不鎖
      // 機器端的 lib 能讓投資組合自動下單(回報 can_trade_portfolio)就不鎖
      const locked = !!x.portfolio && !(stored[n] > 0) && !((trReport() || {}).can_trade_portfolio === true);
      // 雲端其實支援投資組合策略(已撥款的照跑),只是 app 不能從 0 開始撥(機器會拒):講真話,不沿用本機那句
      if (locked) first.appendChild(trEl("span", "pf-note", cloud ? t("tr.typeCHost") : t("tr.typeC")));   // 真正的原因是機器的 lib 太舊(spec-0.1.13-order-copy #12);出口在選擇策略框
      // 模擬交易裡的台幣計價存量(擋之前加進來的):照常列、講原因、可以減可以移出,不能再加(這一格其實是口數)
      const twdRow = trPaperTw(n);
      if (twdRow) first.appendChild(trEl("span", "pf-note", t("tr.pick.twd")));
      row.appendChild(first);
      const symTd = symInto(trEl("td", (txf || isC ? "sname" : "sym") + " c-sym")); if (symTip) symTd.title = symTip;   // 商品名與「等 N 檔」是漢字:不進等寬
      row.appendChild(symTd);
      const c = trEl("td", "n"), wrap = trEl("span", "amt-inw"), inp = trEl("input", "amt-in");
      inp.type = "text"; inp.inputMode = txf ? "numeric" : "decimal"; inp.dataset.amt = n;   // 選擇策略確定後的焦點靠它找到新列(psApply)
      // 送出中:本機照舊 disabled;雲端用唯讀(ack 最長約 20 秒,disabled 會把焦點丟到 BODY)
      if (cloud) { inp.disabled = locked; inp.readOnly = TR.save === "saving"; } else inp.disabled = locked || TR.save === "saving";
      inp.setAttribute("aria-label", trDisplay(n) + " — " + (txf ? t("tr.lotsAria") : zoneOf[n] !== TR_ZONE_UNKNOWN ? t("tr.amountAria", { ccy: zoneOf[n] }) : t("tr.col.amount")));
      inp.value = TR.raw && TR.raw[n] != null ? TR.raw[n] : trFmt(TR.edits[n] != null ? TR.edits[n] : stored[n] || 0);
      if (TR.flash && TR.flash[n]) { inp.classList.add("flash"); delete TR.flash[n]; }   // 從優化套用過來、這一格剛改過
      // 格子只放數字:單位在區標題(或只有一區時在欄頭),units spec §9.6
      wrap.append(inp);
      // 雲端存完還沒對上:這一格是送出的值 → .pend(灰一階 + 短線);再改就拿掉(它現在是用戶打的值)。短線那格一律留位,欄不跳
      const dash = sentOn ? trEl("span", "amt-dash") : null;
      const setPend = (on) => { inp.classList.toggle("pend", on); if (dash) dash.classList.toggle("off", !on); };
      if (dash) { dash.setAttribute("aria-hidden", "true"); wrap.appendChild(dash); setPend(TR.edits[n] == null); }
      c.appendChild(wrap); row.appendChild(c);
      // 投資組合還沒算出成分(沒有權重):一樣是「—」,不是空手(同網頁 3b67fa10)
      const cNotYet = isC && !tc && !noSig;
      const tgt = trEl("td", "n pos");
      const pos = typeof st.position === "number" ? st.position : 0;
      // 最小進場額:機器端只在門檻大於平台那顆 10 時才回報;填得比它小就永遠不會進場,而且完全靜音
      const g0 = sym ? gates[trCanonSym(sym) + (market === "spot" || trTwCash(sym, trPaperOf(n)) ? "@spot" : "")] : null;
      const gate = g0 && typeof g0.entry_usd === "number" ? g0.entry_usd : g0 && g0.side !== "reduce" && typeof g0.usd === "number" ? g0.usd : null;
      let gateRow = null;
      if (gate != null && !txf) {   // 口數列不掛(同網頁:門檻是錢,這一格是口)
        gateRow = document.createElement("tr");
        const ntd = trEl("td", "note"); ntd.colSpan = 4;
        ntd.appendChild(trEl("span", "pf-note", t("tr.gateHint", { m: trFmt(gate), c: trUnit() || "" }).replace(/ {2,}/g, " ").replace(/ (?=，)/g, "")));
        gateRow.appendChild(ntd);
      }
      const repaint = () => {
        const a = TR.edits[n] != null ? TR.edits[n] : stored[n] || 0;
        trPaintPosCell(tgt, a, pos, tc, { noSig, notYet: notYet || cNotYet, txf, sentOn });
        if (gateRow) {
          const show = a > 0 && a < gate;
          if (show && !gateRow.parentNode) row.insertAdjacentElement("afterend", gateRow);
          else if (!show && gateRow.parentNode) gateRow.remove();
          row.classList.toggle("has-note", show || !!badRow.parentNode);
        }
      };
      const badRow = document.createElement("tr"), btd = trEl("td", "note"); btd.colSpan = 4;
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
      // 進欄位時把千分位拿掉(同網頁 d0a249ef):blur 回寫成「1,999」後再補一個 0 會變「1,9990」,解析器只認逗號後三位而整格變紅。
      // 不記進 raw:這不是用戶打的字,沒改的值重畫時照舊畫成帶千分位、也不會被當成改過;重畫後焦點交回來會再走一次這裡
      inp.addEventListener("focus", () => { if (inp.value.indexOf(",") < 0) return; const v = parse(inp.value); if (v != null) inp.value = String(v); });
      inp.addEventListener("input", () => {
        const v = parse(inp.value);
        // 看不懂的字不進 edits(上一個看得懂的值留著);整格標成無效、儲存鈕鎖住(稽核 S11)
        if (v != null) { TR.edits[n] = v; if (txf && TR.ct) TR.ct.basis[n] = v * txf.cv; }   // 手打的口數是之後換合約的換算基準
        if (TR.raw) TR.raw[n] = inp.value;   // 原字跟著記:重畫時放回去(「2.」打到一半被重畫,不能變回「2」)
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
        // 口數格留空不換成「0」:留著空、記在 raw,確認框那一句才知道這一格是留空的(7-2);錢的格照舊正規化
        const blank = txf && !String(inp.value).trim();
        markBad(why); if (!why) { inp.value = blank ? "" : trFmt(parse(inp.value)); if (TR.raw) { if (blank) TR.raw[n] = ""; else delete TR.raw[n]; } } if (svBtn && svBtn.isConnected) svBtn.disabled = anyBad() || stale || cfgBad; else paintBar(); };
      inp.addEventListener("blur", settle); settles.push(settle);
      inp.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); settle(); } });
      row.appendChild(tgt); tb.appendChild(row); repaint();
      // 整張表重畫:打錯的那格留著原字與紅字(設計稽核 B7,同網頁);只有打到一半、還沒驗過的照舊不標紅
      if (TR.bad[n]) { delete TR.bad[n]; if (TR.raw && TR.raw[n] != null) settle(); }
    });
    tbl.appendChild(tb);
  });
  scroll.appendChild(tbl); frag.appendChild(scroll);
  // 等回報時把表頭那句 hover 才看得到的說明放成表下常駐的一行(spec §2-3b):待回報的記號才有人解釋
  if (sentOn) frag.appendChild(trEl("div", "pf-foot", t("tr.cloud.pendTarget")));
  if (hidden.length) frag.appendChild(trEl("div", "pf-foot", t("tr.cloud.hidden", { n: hidden.length })));
  paintTotal(); frag.appendChild(total);
  paintBar(); frag.appendChild(bar);
  return frag;
}
/* 確認框的兩種小標(配置的確認框與套用金額的確認框共用一份;同網頁 pfCloseTag / pfCtCloses)。
   「平倉」:原本有金額、這次歸 0,而且這次存檔可能立即下單 */
function trCloseTag(old, now, running, held) { return running && old > 0 && !(now > 0) && held !== false ? t("tr.cfTagClose") : null; }
/* 這支策略的標的帳上(Blave 自己那份)有沒有部位:沒有就不標「平倉」——存成 0 不會送任何單。
   讀不到(沒連交易所、第一次讀帳前、投資組合)回 null = 不知道,照舊標 */
function trStratHeld(n) {
  const r = trReport() || {}, st = r.states || {}, s = st[n];
  const x = TR.list.find((y) => y.name === n);
  if (!trHasAccount(r) || trFirstReadPending(r) || !s || !s.symbol || s.weights || (x && x.portfolio === true)) return null;   // 投資組合一律當讀不到帳,照舊標
  /* 只有**確定**帳上沒有才回 false(同網頁 pfStratHeld 00825f03)。判不出來一律 null(照舊標):任一家讀帳失敗、讀數過期(超過 6 分鐘)、
     同標的另有策略(淨部位 0 可能是多空互抵)、台指期家族裡別的合約還有部位(剛換合約,平的是它)、換合約還沒存 */
  if (trVenueIds(r).some((id) => { const e = trLiveEntry(r, id); return !!e && e.ok === false; })) return null;
  const at = r.account ? trMs(r.account.read_at) : null; if (at != null && Date.now() - at > 6 * 60 * 1000) return null;
  const stored = trStored() || {}, st2 = poPartStates(stored, st), bk = trBook(r, trClientTargets(stored, st2, trContracts()));
  const keyOf = (m) => { const q = st2[m]; if (!q || !q.symbol || q.weights) return null; const y = trCanonSym(trEffSym(m, q.symbol, trContracts())); return y + (q.market === "spot" || trTwCash(y, trPaperOf(m)) ? "@spot" : ""); };
  const key = keyOf(n);
  if (Object.keys(stored).some((m) => m !== n && keyOf(m) === key)) return null;
  if (bk.mine[key]) return true;
  if (trTxfSpec(key) && (trCtStored(n) !== trCt(n) || Object.keys(TR_TXF_SPECS).some((k) => k !== key && bk.mine[k]))) return null;
  return false;
}
/* 帳本模式下同標的的手動部位(同網頁 pfManualPart 00825f03)。回帶正負號的量;0 = 沒有;null = 判不出來(不畫那一行、不註「含手動」、那一列照常進合計)。
   帳本的 size 是**成本**、讀帳的 size 是**市值**(數量 × 現價),不能直接相減:金額列比**數量**——帳本 ledger[sym].qty(方向看 side)對讀帳 size ÷ mark_price,
   差超過較大那個的 0.5% 才算,顯示 = 差的數量 × mark_price。帳本沒有這一檔、帳戶有:整份帳戶部位都是手動(市值,不必換算)。
   判不出來:對帳快照比讀帳新或沒有讀帳結果、帳本列 legacy 或沒有 qty、讀帳沒有 mark_price、同標的兩列讀帳或兩列帳本、快照沒有 ledger、帳本有而讀帳沒有。口數列直接比口數 */
function trManualPart(r, sym, lot, bk) {
  if (r.self_ledger !== true) return 0;
  if (lot) return (bk.actual[sym] || 0) - (bk.mine[sym] || 0);
  // 對帳快照比讀帳新(下單那一輪剛寫完帳本,讀帳還是上一輪的)、或根本沒有讀帳結果:兩邊不是同一刻,比出來的差是成交、不是手動 → 判不出來(同網頁 30ea6d23)
  const acctMs = r.account && r.account.venues ? trMs(r.account.read_at) : null, lastMs = bk.last ? trMs(bk.last.ts) : null;
  if (acctMs == null || (lastMs != null && lastMs > acctMs)) return null;
  const led = bk.last && bk.last.ledger; if (!led || typeof led !== "object") return null;
  let row = null, rows = 0;
  Object.keys(led).forEach((k0) => { if (trCanonKey(k0) === sym) { row = led[k0] || {}; rows++; } });
  if (rows > 1 || (row && (row.legacy || typeof row.qty !== "number" || !isFinite(row.qty)))) return null;
  const bookQty = row ? (row.side === "short" || row.side === "sell" ? -1 : 1) * Math.abs(row.qty) : 0;
  let pos = null, n = 0;
  if (!/@spot$/.test(sym)) trVenueIds(r).forEach((id) => { const e = trLiveEntry(r, id); if (!e || !e.ok || !e.positions) return;
    Object.keys(e.positions).forEach((k0) => { if (trCanonSym(k0) === sym) { pos = e.positions[k0] || {}; n++; } }); });
  if (n > 1) return null;
  if (!pos) return bookQty ? null : 0;
  if (!bookQty) return trSigned(pos);
  const mark = pos.mark_price; if (typeof mark !== "number" || !(mark > 0)) return null;
  const acctQty = trSigned(pos) / mark, d = acctQty - bookQty;
  return Math.abs(d) <= 0.005 * Math.max(Math.abs(acctQty), Math.abs(bookQty)) ? 0 : d * mark;
}
/* 機器的 lib 會在模擬交易裡下台股(台幣換美元記帳、休市不下單;runtime 回報 can_paper_twstock)。缺這欄 = 舊 runtime,照舊鎖 */
function trPaperTwOk() { return ((typeof trReport === "function" && trReport()) || {}).can_paper_twstock === true; }
/* 模擬交易下不了的台幣標的(台股,機器的 lib 太舊時;台指期照機器支援):金額不能往上加——配置分頁的輸入格與套用金額走同一道(trSaveAmounts) */
function trPaperTw(n) { const x = TR.list.find((y) => y.name === n); return trVenueId() === PAPER && !!x && x.twd === true && !trTxfSpec(x.symbol) && !trPaperTwOk(); }
/* 「{舊合約}平倉」:這支換了合約、舊合約上別的策略加起來取整是 0(沒人撐了)、而且帳上那個合約真的還有部位才標;其他策略還撐著就只是減倉,不標 */
function trCtCloseTag(n, sending, stored) {
  const from = trCtStored(n), r = trReport() || {};
  if (!from || from === trCt(n) || !((Number(stored[n]) || 0) > 0) || !trHasAccount(r)) return null;
  const st = r.states || {}; let net = 0;
  Object.keys(sending).forEach((m) => { if (m !== n && trCt(m) === from) net += (sending[m] || 0) * (st[m] && typeof st[m].position === "number" ? st[m].position : 0); });
  if (trRoundLots(net)) return null;
  const bk = trBook(r, trClientTargets(stored, poPartStates(stored, st), trContracts()));
  return bk.mine[from] ? t("ct.tagClose", { prod: t(TR_TXF_SPECS[from].prod) }) : null;
}
/* 框用的訊號。stored = 已存;sending = 要存的。回 { states, px: {標的: 收盤價}, pv: {用預覽的策略: { at, date, dailyTw }}, missing: [算不出的策略],
   stale: [預覽不是最新那根的草稿](背景重算它), old: [用到的預覽不是最新那根的,含已存的](框判會不會送單用) }。
   草稿(不在 stored)一律用預覽:它手上的 state.json 是以前上線時留下的,排程現在沒在算它 */
function trCfStates(r, stored, sending, contracts) {
  const live = (r && r.states) || {}, states = {}, px = {}, pvs = {}, missing = [], stale = [], old = [];
  Object.keys(sending).concat(Object.keys(stored)).forEach((n) => {
    if (n in states || missing.indexOf(n) >= 0) return;
    const s = live[n], hasLive = !!s && (!!s.symbol || (!!s.weights && typeof s.weights === "object")), draft = !(n in stored);
    if (hasLive && !draft && !trNoSignalYet(n)) { states[n] = s; return; }
    const pv = trPvOf(r, n);
    if (!pv) { missing.push(n); return; }
    states[n] = pv; pvs[n] = { at: pv.bar_at, date: pv.bar_date, dailyTw: pv.daily_tw };
    if (!pv.latest) { old.push(n); if (draft) stale.push(n); }
    if (pv.weights) Object.keys(pv.closes || {}).forEach((k) => { const v = Number(pv.closes[k]); if (v > 0) px[trCanonSym(k)] = v; });
    else if (pv.close) px[trCanonSym(trEffSym(n, pv.symbol, contracts))] = pv.close;
    // 台股:預覽帶的未還原收盤(runtime 1.1.134 起)蓋掉還原價
    if (pv.raw_closes && typeof pv.raw_closes === "object") Object.keys(pv.raw_closes).forEach((k) => { const v = Number(pv.raw_closes[k]), c = trCanonSym(k); if (v > 0 && isFinite(v) && TR_TWSTOCK_RE.test(c)) px[c] = v; });
  });
  /* 台股換股數用未還原收盤:實盤 state 的 raw_closes(目標最後變動那一根,同 trTwLots 與總訊號部位表)優先,任一支 live 策略查到的同一檔都算;
     草稿用預覽的 raw_closes;都沒有才用預覽的還原價(0.1.27 以前的 lib 寫的預覽沒有 closes) */
  Object.keys(live).forEach((n) => { const rc = live[n] && live[n].raw_closes;
    if (rc && typeof rc === "object") Object.keys(rc).forEach((k) => { const v = Number(rc[k]), c = trCanonSym(k); if (v > 0 && isFinite(v) && TR_TWSTOCK_RE.test(c)) px[c] = v; }); });
  return { states, px, pv: pvs, missing, stale, old };
}
/* 下一輪對帳器先不動的部分(lib/portfolio 的 first_signal_wait 與訊號閘)。快照 caps 沒有 first_signal_wait = 舊 lib,前一種不算。
   還沒算出第一個訊號的成員:草稿一律算(存檔時 runtime 移走它的舊 state.json;當根的 state 會留著、對帳器就不等,框照等算,只差那句說明);
   已存的看快照 awaiting 還在窗內(過了窗它照常對帳,沒貢獻的部位照賣)。標的同對帳器:SYMBOL,組合看 UNIVERSE,都沒有看預覽。
   等第一個訊號只凍「被換掉、帳上還撐著的那段」:對帳器第一輪看上一輪快照(= 現在這份),這次不再有貢獻的成員(移出／歸 0、或自己又在等)
   各取它在快照的貢獻,但不超過帳上扣掉留下成員那份之後還有的(閘中的取剩下的,見 trCfRows 的 trCfHold);窗內目標 = 其他成員現在要的 + 那段,
   而且永遠落在 [帳上, 其他成員現在要的] 之間——別支的減碼(停損)照送,加碼先抵掉那段、窗結束才送。
   同一檔兩支以上新成員:先算出來的那支(快照列 cohort)等最後一支算出來才算進去;算過的成員又在等不算新成員。快照那一列已在窗內(帶 awaiting 與 frozen)就沿用它的 frozen;
   基準還沒寫(needs_baseline)或那一檔在等 pending,對帳器整檔不動,不給 anchor。
   訊號閘:快照那一列 gated,而且撐它的閘中策略這次還有金額。回 { wait: {標的: [策略]}, gate: [標的], anchor: {標的: {frozen, contributors, cohort}} } */
function trCfHolds(r, stored, sending, contracts, st) {
  const last = (r && r.last_reconcile) || {}, tg = last.target && typeof last.target === "object" ? last.target : {}, live = (r && r.states) || {};
  const wait = {}, gate = [], now = Date.now() / 1000, funded = (n) => Number(sending[n]) > 0;
  const add = (k, n) => { const a = (wait[k] = wait[k] || []); if (a.indexOf(n) < 0) a.push(n); };
  const newLib = Array.isArray(last.caps) && last.caps.indexOf("first_signal_wait") >= 0;
  if (newLib) {
    Object.keys(sending).forEach((n) => {
      if (!funded(n) || n in stored) return;
      const x = TR.list.find((y) => y.name === n) || {}, paper = trPaperOf(n), pv = (st && st.states[n]) || null;
      const keys = !x.portfolio && x.symbol ? [trEffSym(n, x.symbol, contracts)] : (x.universe || []).length ? x.universe
        : pv && pv.weights ? Object.keys(pv.weights) : pv && pv.symbol ? [trEffSym(n, pv.symbol, contracts)] : [];
      keys.forEach((k) => { const c = trCanonSym(k); add(c + (x.market === "spot" || trTwCash(c, paper) ? "@spot" : ""), n); });
    });
    Object.keys(tg).forEach((k) => { const a = (tg[k] || {}).awaiting; if (!a || typeof a !== "object") return;
      Object.keys(a).forEach((n) => { const s = live[n];
        if (n in stored && funded(n) && Number(a[n]) > now && !(s && (s.symbol || (s.weights && typeof s.weights === "object")))) add(trCanonKey(k), n); }); });
  }
  const anchor = {}, pend = Array.isArray(last.baseline_pending) ? last.baseline_pending.map(trCanonKey) : [];
  if (newLib && last.needs_baseline == null) Object.keys(wait).forEach((k) => { if (pend.indexOf(k) < 0) anchor[k] = { frozen: 0, contributors: [], cohort: [] }; });
  Object.keys(tg).forEach((k) => { const row = tg[k] || {}, cs = Array.isArray(row.contributors) ? row.contributors : [], an = anchor[trCanonKey(k)];
    if (an) { const inWin = !!row.awaiting && typeof row.frozen === "number" && isFinite(row.frozen);
      an.contributors = cs; an.inWin = inWin; if (inWin) { an.frozen = row.frozen; an.cohort = Array.isArray(row.cohort) ? row.cohort : []; } }
    if (row.gated !== true) return;
    // 閘中的那支貢獻列帶 gated: true(同一個 lib 起);舊 lib 沒有這欄:沒綁交易所以外的 gated 列都當閘中,撐它的還有金額就算
    if (cs.some((c) => c && funded(c.strategy) && (newLib ? c.gated === true : !row.unrouted))) gate.push(trCanonKey(k)); });
  return { wait, gate, anchor };
}
/* 表頭的「依哪一根算」:只看真的撐到框裡某一列的預覽(names = 那幾列的貢獻策略)。回 { at, date, dailyTw } 取最舊那根;沒有一列用到預覽回 null */
function trCfAsof(st, names) {
  let out = null, daily = true;
  names.forEach((n) => { const p = st.pv[n]; if (!p) return; if (!p.dailyTw) daily = false; if (p.at != null && (!out || p.at < out.at)) out = { at: p.at, date: p.date }; });
  return out ? Object.assign(out, { dailyTw: daily }) : null;
}
// 帳上各標的的現價(交易所回報的 mark_price):只有 live 策略持有、沒有預覽收盤價的標的,用它換算數量
function trMarks(r) {
  const out = {};
  trVenueIds(r).forEach((id) => { const e = trLiveEntry(r, id); if (!e || !e.ok || !e.positions) return;
    Object.keys(e.positions).forEach((s) => { const p = e.positions[s] || {}, k = trTwBroker(id) ? trTwFutCanon(s) : trCanonSym(s);
      if (typeof p.mark_price === "number" && isFinite(p.mark_price) && p.mark_price > 0) out[k] = p.mark_price; }); });
  return out;
}
/* 一個標的的錢 → 下單單位:台指期列本來就是口;台股以「股」、不足 1 股捨去(買不起的那一股不算);其餘以顆。
   沒有價格 = null(呼叫端照錢寫,不湊一個像數量的數) */
function trCfQty(sym, money, px) {
  const k = trCanonSym(String(sym).replace(/@spot$/i, ""));
  if (!(px > 0)) return null;
  const q = Math.abs(money) / px;
  if (TR_TWSTOCK_RE.test(k)) { const sh = Math.floor(q + 1e-9); return { n: sh, text: trFmt(sh), unit: "tr.cf.unitShares" }; }
  return { n: q, text: trQtyFmt(q), unit: "tr.cf.unitCoins" };
}
/* 框的內容(純計算,畫面在 trSaveAmounts)。o = { r, stored, sending, firing, contractsBefore, contractsAfter, mine, gates, covered(sym), lot(sym), lastAt }
   回 { kind: "orders" | "changes", rows: [...], zones: [...], st }:
     orders  = [{ sym, side: "buy"|"sell", lots?, qty?, money, z, by }](會送單:新目標 − 帳上,過了下單門檻才列;門檻同部位表 sigRow)
     changes = [{ sym, was, now, lots, qty?, z, by }](目標有變的,口數列比取整後的口數);by = 撐這一列的策略
   下一輪對帳器先不動的標的(trCfHolds)照它:等新訊號的不列單;等第一個訊號、又算不出(沒有預覽)的那幾檔目標不知道,兩種都不列。
   其他算不出的(過了等待窗、舊 lib)沒有貢獻:對帳器只算有 state.json 的,帳上那些檔下一輪照樣賣,照列。
   回傳另帶 held = {wait: [這一輪不動、沒列單的標的], names: [在等的策略], gate: [被訊號閘擋下的標的], unknown: 目標不知道的那檔這次有動}(框的說明句與標題用) */
function trCfRows(o) {
  /* 被換掉、帳上還撐著的那段(同 lib/portfolio _first_signal_targets):離開的成員(沒金額、或自己又在等)只算帳上 as 扣掉留下成員那份之後
     還有的,同號且不超過;閘中的離開成員自己的目標沒到帳,取剩下的全部。快照已在窗內(an.inWin)就從它的 frozen 接著扣這次才離開的 */
  function trCfHold(an, sending, ws, as, acct) {
    const within = (v, room) => (v * room <= 0 ? 0 : Math.abs(v) <= Math.abs(room) ? v : room), val = (c) => (isFinite(Number(c.contribution)) ? Number(c.contribution) : 0);
    const cs = an.contributors.filter((c) => c && c.strategy != null && an.cohort.indexOf(c.strategy) < 0).sort((a, b) => (String(a.strategy) < String(b.strategy) ? -1 : 1));
    const back = (c) => ws.indexOf(c.strategy) >= 0, leaving = (c) => !(Number(sending[c.strategy]) > 0) || back(c);
    if (an.inWin) {
      // 讀帳模式:帳上少了(手動平倉、標記價)那段跟著縮,只縮不長(同 lib 每輪以上一輪其他成員那份夾)
      const f0 = acct ? within(an.frozen, as - cs.reduce((a, c) => a + val(c), 0)) : an.frozen;
      let room = as - cs.reduce((a, c) => a + val(c), 0) - f0, hold = f0;
      cs.filter(leaving).forEach((c) => { room += val(c); const x = within(val(c), room); room -= x; hold += x; });
      return hold;
    }
    let room = as - cs.filter((c) => !leaving(c)).reduce((a, c) => a + val(c), 0), hold = 0;
    const take = (v) => { const x = within(v, room); room -= x; hold += x; };
    take(cs.filter((c) => leaving(c) && !back(c) && c.gated !== true).reduce((a, c) => a + val(c), 0));
    cs.filter((c) => back(c) && c.gated !== true).forEach((c) => take(val(c)));
    if (cs.some((c) => leaving(c) && c.gated === true)) { hold += room; room = 0; }
    return hold;
  }
  const st = trCfStates(o.r, o.stored, o.sending, o.contractsAfter);
  const known = (am) => { const x = {}; Object.keys(am).forEach((n) => { if (st.missing.indexOf(n) < 0) x[n] = am[n]; }); return x; };
  const before = trClientTargets(known(o.stored), st.states, o.contractsBefore), after = trClientTargets(known(o.sending), st.states, o.contractsAfter);
  const holds = trCfHolds(o.r, o.stored, o.sending, o.contractsAfter, st), gated = new Set(holds.gate), blind = new Set();
  Object.keys(holds.wait).forEach((k) => { if (holds.wait[k].some((n) => st.missing.indexOf(n) >= 0)) blind.add(k); });
  const held = { wait: [], names: [], gate: [] }, hit = (a, k) => { if (a.indexOf(k) < 0) a.push(k); };
  // 區(單位)跟部位表同一個判法:只看撐這個標的的那幾支策略的計價(trContribs)
  const qmap = trQuoteMap() || {}, cs0 = trContribs(known(o.stored), st.states, o.contractsBefore), cs1 = trContribs(known(o.sending), st.states, o.contractsAfter);
  const zoneOf = (sym) => { const cs = (cs1[sym] || []).concat(cs0[sym] || []); return trSymZone(sym, cs.map((c) => qmap[c.name]), cs.map((c) => trSrcMarket(o.r, c.name))); };
  // 每列的貢獻策略(移出的只在 cs0):表頭時間只看這幾支用的預覽
  const by = (sym) => (cs1[sym] || []).concat(cs0[sym] || []).map((c) => c.name);
  const marks = trMarks(o.r || {}), priceOf = (sym) => { const k = trCanonSym(sym.replace(/@spot$/i, "")); return st.px[k] || marks[k] || marks[trCanonSym(sym)] || null; };
  const rows = [];
  if (o.firing) {
    /* 休市中的台股:對帳器留到開盤(lib/portfolio._paper_tw_closed_keys、lib/order_paper._check_session),同部位表的 trTwClosedKeys 與補齊那句的 trTwSessionOpen。
       照列但標 closed、排最後,不算進「下一輪要送的 N 筆」 */
    const r0 = o.r || {}, twShut = !trTwSessionOpen(Date.now(), r0.tw_trading_day), twHeld = trTwClosedKeys(r0.last_reconcile);
    const twClosed = (sym) => TR_TWSTOCK_RE.test(trCanonSym(sym.replace(/@spot$/i, ""))) && (twShut || twHeld.has(sym));
    const syms = Object.keys(after).concat(Object.keys(o.mine).filter((k) => o.mine[k])).filter((k, i, a) => a.indexOf(k) === i && o.covered(k) && !trUsNoAuto(o.r, k, by(k)));
    syms.forEach((sym) => {
      // 新成員算不出(沒預覽):下一輪 = 其他成員這次存的 + 被換掉的那段,照算。基準未寫／pending 時對帳器整檔不動(沒有 anchor),
      // 目標不知道:這次又動到它已知的那一半,等它算出來可能就有單(框照「儲存並下單」)
      const an0 = holds.wait[sym] ? holds.anchor[sym] : null, an = blind.has(sym) ? an0 : null, ws = holds.wait[sym] || [], lot = o.lot(sym);
      if (blind.has(sym) && !an) { if (o.mine[sym] || after[sym]) { hit(held.wait, sym); ws.forEach((n) => hit(held.names, n)); } if (Math.round(before[sym] || 0) !== Math.round(after[sym] || 0)) held.unknown = true; return; }
      const as = o.mine[sym] || 0, frozen = an0 ? trCfHold(an0, o.sending, ws, as, !(o.r && o.r.self_ledger === true)) : 0, froze = lot ? Math.round(Math.abs(frozen)) > 0 : Math.abs(frozen) >= 1;
      const others = an ? (cs1[sym] || []).filter((c) => ws.indexOf(c.name) < 0 && an.cohort.indexOf(c.name) < 0).reduce((a, c) => a + c.v, 0) : 0;
      // 窗內目標夾在 [帳上, 其他成員要的] 與 [帳上, 同一輪沒有等待時的目標(after)] 之間:不會比沒有它時多買或反向
      const settle = (x) => { const y = /@spot$/.test(sym) ? Math.max(0, x) : x; return lot ? trLotsTarget(y).lots : y; }, base = an ? settle(others) : 0;
      const full = after[sym] || 0, clamp = (x, lo, hi) => Math.min(Math.max(x, Math.min(lo, hi)), Math.max(lo, hi));
      const raw = an ? clamp(clamp(settle(others + frozen), base, as), full, as) : full;
      const ts = lot ? trLotsTarget(raw).lots : raw, d = ts - as;
      const gs = lot ? null : trGateSide(o.gates[sym], ts, as), acts = lot ? Math.round(Math.abs(d)) > 0 : Math.abs(d) >= (gs ? gs.usd : 10);
      if (acts && gated.has(sym)) { hit(held.gate, sym); return; }
      if (!acts) { if (ws.length && o.mine[sym] && (froze || !an0)) { hit(held.wait, sym); ws.forEach((n) => hit(held.names, n)); } return; }
      const row = { sym, side: d > 0 ? "buy" : "sell", money: Math.abs(d), z: zoneOf(sym), by: by(sym) };
      if (lot) row.lots = Math.round(Math.abs(d));
      else { const q = trCfQty(sym, d, priceOf(sym)); if (q && q.n === 0) return; row.qty = q; }
      if (twClosed(sym)) row.closed = true;
      rows.push(row);
    });
    rows.sort((a, b) => ((a.closed ? 1 : 0) - (b.closed ? 1 : 0)) || (a.side === b.side ? 0 : a.side === "buy" ? -1 : 1) || (a.sym < b.sym ? -1 : a.sym > b.sym ? 1 : 0));
    return { kind: "orders", rows, st, held };
  }
  Object.keys(before).concat(Object.keys(after)).filter((k, i, a) => a.indexOf(k) === i && !blind.has(k)).forEach((sym) => {
    const lot = o.lot(sym), was = before[sym] || 0, now = after[sym] || 0;
    const same = lot ? trRoundLots(was) === trRoundLots(now) : Math.round(was) === Math.round(now);
    if (same) return;
    const row = { sym, was: lot ? trRoundLots(was) || 0 : was, now: lot ? trRoundLots(now) || 0 : now, lots: lot, z: zoneOf(sym), by: by(sym), held: !!o.mine[sym] };
    // 不會自動下單的美股列只寫金額:不換數量、也不算預覽撐的列(表頭不寫依哪一根),同網頁 pfUsNoAuto
    if (trUsNoAuto(o.r, sym, by(sym))) row.noAuto = true;
    else if (!lot) row.qty = now > 0 ? trCfQty(sym, now, priceOf(sym)) : null;
    rows.push(row);
  });
  rows.sort((a, b) => ((b.was ? 1 : 0) - (a.was ? 1 : 0)) || (a.sym < b.sym ? -1 : a.sym > b.sym ? 1 : 0));
  return { kind: "changes", rows, st, held };
}
// 開著的存金額框(trCfTick 重算它);草稿等預覽的上限:台股日線 2 分、其他 5 分(spec §5)
const TR_CF = { cur: null }, TR_CF_WAIT_MS = 300000, TR_CF_WAIT_TW_MS = 120000;
/* o.source === "optimize"(優化分頁「套用金額」;portfolio.js mgApply 先把建議寫進 edits 再叫這裡):同一個框、同一條規則(§7-3);
   取消時 o.onCancel 把 edits 放回去。存好之後 o.onSaved(sending) */
function trSaveAmounts(names, stored, opener, o) {
  const S = TR, cloud = S.env === "cloud", opt = o || {};
  if (!TR.listLoaded || Object.keys(TR.bad).length) return;
  if (!stored || trStored() === null || trCfgUnread(trReport())) return;   // 讀不到金額設定:兩邊都不給存
  if (cloud && (!(S.st && S.st.alive) || trCfgUnread(trReport()))) return;   // 讀不到新狀態 / 設定不給存(儲存鈕已經 disabled;這裡是第二道)
  const sending = trSendAmounts(S.env, names, stored, TR.edits, trListNames()), removed = trRemoved(stored, sending);
  const ctAll = trCtPayload(Object.keys(sending)), ctPending = Object.keys(sending).some((n) => { const c = trCtStored(n); return !!c && trCt(n) !== c; });
  const mayFire = trMayFire(S.st, S.pending), old = (n) => Number(stored[n]) || 0;
  const joined = Object.keys(sending).filter((n) => !(n in stored));
  const swappedNs = Object.keys(sending).filter((n) => { const f = trCtStored(n); return !!f && f !== trCt(n); });
  const arrow = (dd, was) => { dd.append(trEl("span", "was", was), trEl("span", "arr", "→")); };
  const cfRow = (cls, label, dd) => { const r = trEl("div", "cf-row" + (cls ? " " + cls : "")); r.append(trEl("dt", "", label), dd); return r; };
  // 口數列:下方小字寫商品名與名目(框裡沒有標的欄,商品名只能放這裡;§9.8)。0 口只寫商品名
  const lotsRef = (sp, v, from) => { const m = v > 0 ? trTxfRefMoney(sp, v, trTxfPrice()) : null, ref = trEl("span", "cf-ref");
    if (from) ref.append(trEl("span", "", t(from.prod)), trEl("span", "arr", "→"));
    ref.append(m == null ? t(sp.prod) : t("tr.txfConfirmRef", { prod: t(sp.prod), amt: trFmt(Math.round(m)) })); return ref; };
  const list = (ns) => ns.map(trDisplay).join(LANG === "zh" ? "、" : ", ");
  /* 不隨報告變的那一段(表下):策略層的變動與擋下的原因。改金額的列已經在上面那張標的表,這裡只放標的表講不出來的——
     移出(· 平倉)、加入但金額 0、換合約(大台 → 微台 · 舊合約平倉)。口數格留空、模擬交易台股往上加、雲端讀不到／壞值、匯率舊 */
  const extra = document.createDocumentFragment();
  // 這支的標的這一輪全被對帳器先不動(等新成員的第一個訊號、或等新訊號):存了不會平倉,不標
  const hold0 = (() => { if (!mayFire) return null; const r0 = trReport() || {}, ct = Object.assign({}, trContracts(), ctAll || {});
    const h = trCfHolds(r0, stored, sending, ct, trCfStates(r0, stored, sending, ct)); return { keys: Object.keys(h.wait).concat(h.gate), ct, r0 }; })();
  const keepsPos = (n) => { if (!hold0) return false; const ks = trCfSymsOf(n, (hold0.r0.states || {})[n], hold0.ct);
    return !!ks && ks.length > 0 && ks.every((k) => hold0.keys.indexOf(k) >= 0); };
  const stratRows = removed.concat(joined.filter((n) => !(Number(sending[n]) > 0)), swappedNs.filter((n) => removed.indexOf(n) < 0));
  if (stratRows.length) {
    const dl = trEl("dl", "cf-rows cf-amt cf-strat");
    stratRows.filter((n, i, a) => a.indexOf(n) === i).forEach((n) => {
      const dd = document.createElement("dd"), was = old(n);
      if (removed.indexOf(n) >= 0) {
        if (was > 0) arrow(dd, trFmt(was));
        dd.appendChild(trEl("span", "tag", mayFire && was > 0 && trStratHeld(n) !== false && !keepsPos(n) ? t("tr.cfTagRemove") + " · " + t("tr.cfTagClose") : t("tr.cfTagRemove")));
        dl.appendChild(cfRow("", trDisplay(n), dd)); return;
      }
      const now = Number(sending[n]) || 0, from = trCtStored(n), sp = trRowTxfNew(n), swapped = !!from && from !== trCt(n);
      dd.append(trEl("span", "n", trFmt(now)));
      if (!(n in stored)) dd.appendChild(trEl("span", "tag", t("tr.cfTagAdd")));
      const close = trCloseTag(was, now, mayFire && !keepsPos(n), trStratHeld(n)); if (close) dd.appendChild(trEl("span", "tag", close));
      const ctClose = trCtCloseTag(n, sending, stored); if (ctClose) dd.appendChild(trEl("span", "tag", ctClose));
      if (sp) dd.appendChild(lotsRef(sp, now, swapped ? TR_TXF_SPECS[from] : null));
      dl.appendChild(cfRow("", trDisplay(n), dd));
    });
    extra.appendChild(dl);
  }
  // 口數格留空(7-2):會存成 0、這支不會下單——點名講一次,不擋
  const zeroed = Object.keys(sending).filter((n) => !(sending[n] > 0) && Number(stored[n]) > 0);
  const blank = trBlankLots(Object.keys(sending), TR.raw, trRowTxfNew, zeroed);
  if (blank.length) extra.appendChild(trEl("p", "cf-zeroed", t("tr.saveBlankLots", { names: blank.map(trDisplay).join(LANG === "zh" ? "、" : ", ") })));
  const hid = cloud ? trHidden(names, stored, trListNames()) : [], badStored = cloud ? trBadStored(sending) : [];
  if (hid.length) extra.appendChild(trEl("p", "cf-note", t("tr.cloud.hidden", { n: hid.length })));
  if (badStored.length) extra.appendChild(trEl("p", "cf-block", t("tr.cloud.badStored", { names: list(badStored) })));
  // 模擬交易不支援的台股:不能往上加(配置分頁的輸入格擋一道;套用金額走這裡,同一道)
  const paperTw = Object.keys(sending).filter((n) => trPaperTw(n) && (Number(sending[n]) || 0) > old(n));
  if (paperTw.length) extra.appendChild(trEl("p", "cf-block", t("tr.pick.twd") + (LANG === "zh" ? "：" : ": ") + list(paperTw)));
  const blocked = badStored.length > 0 || paperTw.length > 0;   // 存不進去(模擬帳戶超過 10 倍不再擋,#13)
  // 換算用的是 7 天以上前存下的台幣匯率(登入失效／讀不到雲端):確認框講是哪一天的(稽核 r4 P2)
  { const fv = trFxView(); if (fv.cached && Date.now() - fv.cached > 7 * 86400000) extra.appendChild(trEl("p", "cf-note", t("tr.fxOld", { d: new Date(fv.cached).toISOString().slice(0, 10) }))); }
  // 暫停中(HALT,下單程式在跑):不開新倉,但減碼與平倉存了就會執行(§7-2),標題「儲存金額」藏住這件事,要講。
  // 凍結(halt.freeze)時什麼都不送,標題已經講完,不出句(稽核 0.1.27 batch2);那句減碼平倉照走在凍結時是假話。剛按啟動也不出
  const pausedNow = trExecState(S.st) === "halted" && !trStartPending(S.pending), frozen = pausedNow && trHaltFreeze(S.st && S.st.report);
  if (!blocked && mayFire && pausedNow && !frozen) extra.appendChild(trEl("p", "cf-note", t("tr.saveWarnHalted")));

  /* 會隨報告變的那一段:標的表。草稿沒有預覽時先寫「計算中…」、主鈕停用,報告帶來預覽就換上表(trCfTick);逾時講一句、主鈕恢復 */
  const body = trEl("div", "cf-live"), cf = { S, sending, stored, body, blocked, sig: null, until: 0 };
  const relevant = (n) => (!(n in stored) && Number(sending[n]) > 0) || ((n in stored) && Number(sending[n]) !== old(n));
  const pvReq = (S.pvReq = S.pvReq || {});
  // 框開著時 trCfTick 可能在另一個視角是 TR 的時候叫進來:那時借 trWith 換過去算
  const paintBody = () => (TR === S ? (f) => f() : (f) => trWith(S, f))(() => {
    const r = trReport() || {}, firing = trCfFiring(S.st, S.pending), recon = trHasAccount(r);
    const ctBefore = trContracts(), ctAfter = Object.assign({}, ctBefore, ctAll || {});
    const tgt0 = trClientTargets(sending, poPartStates(sending, r.states || {}), ctAfter);
    const bk = recon ? trBook(r, tgt0) : null, last = bk ? bk.last : null, vk = trVenueKind(trVenueId());
    const args = { r, stored, sending, contractsBefore: ctBefore, contractsAfter: ctAfter,
      mine: bk ? bk.mine : {}, gates: (last || {}).gates || {}, covered: (sym) => !recon || trTradesSym(vk, sym),
      lot: (sym) => trIsLot(last, sym) || !!trTxfSpec(trCapitalCanon(sym.replace(/@spot$/, ""))) };
    // 會送單:列下一輪要送的單。草稿還在算也照會送單那一種開(標題「儲存並下單」),表的位置先寫計算中
    const firstRead = firing && recon && trFirstReadPending(r);
    let m = firing && recon && !firstRead ? trCfRows(Object.assign({ firing: true }, args)) : null;
    const held = m ? m.held : { wait: [], names: [], gate: [] };
    const orders = !!m && (m.rows.length > 0 || m.st.missing.filter(relevant).length > 0 || !!held.unknown);
    // 列不出單(沒有一筆過門檻、或第一次讀帳還沒回來、帳上是空的不能拿來減)就列目標「原 → 新」
    if (!orders) m = trCfRows(Object.assign({ firing: false }, args));
    /* 列不出單不等於不會送單,下面兩種一律寫「儲存並下單」(canon:會送就必須寫「下單」):
       第一次讀帳還沒回來(下一輪照目標補齊);用到的預覽不是最新那根(下一輪照最新那根算,可能就有單) */
    const willOrder = (n) => trCfWillOrder(n, m.st.states[n] || (r.states || {})[n], ctAfter);
    const oldPv = firing && recon && !firstRead ? m.st.old.filter((n) => relevant(n) && willOrder(n)) : [];
    const unread = !orders && firstRead && Object.keys(sending).concat(Object.keys(stored)).some((n) => relevant(n) && willOrder(n));
    const fire = orders || unread || oldPv.length > 0;
    const amtOnly = Object.keys(sending).filter((n) => (n in stored) && Number(sending[n]) !== old(n));
    // 只等存了還有金額的:移出／歸 0 的成員存了就沒有貢獻,它的預覽可能永遠不來(沒回測過、fetch 壞掉)
    const host = trPvHost(r), now = Date.now(), miss = m.st.missing.filter((n) => relevant(n) && Number(sending[n]) > 0);
    const codeChanged = miss.filter((n) => pvReq[n] && pvReq[n].code === "CODE_CHANGED"), hostOld = host ? [] : miss;
    const waiting = host ? miss.filter((n) => codeChanged.indexOf(n) < 0) : [];
    if (waiting.length && !cf.until) cf.until = now + (waiting.every((n) => { const x = TR.list.find((y) => y.name === n) || {}; return x.twdAll === true && !trTxfSpec(x.symbol); }) ? TR_CF_WAIT_TW_MS : TR_CF_WAIT_MS);
    const late = waiting.length > 0 && now >= cf.until, wait = waiting.length > 0 && !late;
    const sig = JSON.stringify([fire, m, held, waiting, late, codeChanged, hostOld, unread, oldPv, TR_TWN.v, trTxfPrice()]);
    if (sig === cf.sig) return; cf.sig = sig;
    body.textContent = "";
    const sub = trEl("p", "cf-sub");
    if (wait) { const p = trEl("p", "cf-wait"); p.setAttribute("role", "status"); p.textContent = t("tr.typecPending"); body.appendChild(p); }
    else {
      const zones = m.rows.map((x) => x.z).filter((z, i, a) => a.indexOf(z) === i), multi = zones.length > 1;
      const ccys = zones.map((z) => (z === TR_ZONE_LOTS ? t("tr.lotsUnit") : z === TR_ZONE_UNKNOWN ? t("tr.grpUnknown") : z)).join(LANG === "zh" ? "、" : ", ");
      // 時間只講一次(canon):框裡任何一列(口數列、照金額寫的列、只改金額的列都算)是預覽撐的、或表下點名了舊預覽(oldPv),表頭寫是哪一根;台股日線寫「收盤」
      const pvAt0 = trCfAsof(m.st, m.rows.length ? [].concat(...m.rows.map((x) => (x.noAuto ? [] : x.by || [])), oldPv) : amtOnly);
      // 「依 MM/DD 收盤算」讀起來像列上有價格:列出的標的一個都沒有數量(股、口)時不寫。不是台股日線的「依那根算」照寫(B2)
      const pvAt = pvAt0 && pvAt0.dailyTw && m.rows.length && !m.rows.some((x) => x.lots || (x.qty && x.qty.n > 0)) ? null : pvAt0;
      // 台股日線照機器給的交易日(bar_date,UTC+8 換好的),不拿本機時區換 bar_at
      const asof = !pvAt ? "" : pvAt.dailyTw && pvAt.date ? t("tr.cf.asofClose", { d: pvAt.date.slice(5).replace("-", "/") }) : t("tr.cf.asofBar", { d: trCfMD(pvAt.at, true) });
      if (m.rows.length) {
        const nOpen = m.rows.filter((x) => !x.closed).length, asofTail = asof ? (LANG === "zh" ? "，" : ", ") + asof : "";
        // 全部台股都留到開盤(這一輪一筆都不送):表頭講開盤後要送,逐列不再標休市(稽核 0.1.27 batch2 P2-2)
        sub.textContent = (m.kind === "orders" ? t(nOpen ? "tr.cf.capOrders" : "tr.cf.capOrdersOpen", { n: String(nOpen || m.rows.length) }) : t(m.rows.length === 1 ? "tr.cf.capChangesOne" : "tr.cf.capChanges", { n: String(m.rows.length), ccy: ccys })) + asofTail;
        if (sub.textContent) body.appendChild(sub);
        const dl = trEl("dl", "cf-rows cf-amt");
        m.rows.forEach((x) => {
          const label = trEl("dt", ""), dd = document.createElement("dd"), sp = x.lots != null && x.lots !== false ? trTxfSpec(trCapitalCanon(x.sym.replace(/@spot$/, ""))) : null;
          const symText = sp ? t(sp.prod) : x.sym.replace(/@spot$/, ""), tw = sp ? "" : trTwName(x.sym);
          if (m.kind === "orders") label.appendChild(trEl("span", "side " + x.side, t(x.side === "buy" ? "tr.cf.buy" : "tr.cf.sell")));
          label.append(symText + (tw ? " " + tw : ""));
          const unit = (k, n) => " " + t(k === "lots" ? trLotsKey(n, "tr.lotsUnit", "tr.lotUnit") : k);
          if (m.kind === "orders") {
            dd.append(trEl("span", "n", x.lots != null ? trFmt(x.lots) + unit("lots", x.lots) : x.qty ? x.qty.text + unit(x.qty.unit) : trFmt(Math.round(x.money)) + (x.z && x.z !== TR_ZONE_UNKNOWN ? " " + x.z : "")));
            if (x.closed && nOpen) dd.appendChild(trEl("span", "tag", t("po.twClosedHold")));
          } else {
            const f = (v) => (x.lots ? trLotsFmt(v) : trFmt(Math.round(v)));
            if (x.was) arrow(dd, f(x.was));
            dd.append(trEl("span", "n", f(x.now)));
            // 讀過帳:只有這家下得了、帳上真的有部位的才標平倉;第一次讀帳前不知道,照標
            const close = trCloseTag(x.was, x.now, fire, recon && !firstRead ? x.held : null); if (close) dd.appendChild(trEl("span", "tag", close));
            if (multi && !x.lots && x.z !== TR_ZONE_UNKNOWN) dd.appendChild(trEl("span", "ccy", x.z));
            if (x.lots) { if (sp) dd.appendChild(lotsRef(sp, x.now, null)); }
            else if (x.qty && x.qty.n > 0) dd.appendChild(trEl("span", "cf-ref", x.qty.text + unit(x.qty.unit)));
          }
          const row = trEl("div", "cf-row"); row.append(label, dd); dl.appendChild(row);
        });
        body.appendChild(dl);
      } else if (amtOnly.length) {
        // 金額改了、但這一刻沒有一個標的的目標跟著變(訊號 0、或改的那支算不出):表上改列金額的「原 → 新」,不出一個空框
        sub.textContent = t(amtOnly.length === 1 ? "tr.cf.capAmountsOne" : "tr.cf.capAmounts", { n: String(amtOnly.length) }); body.appendChild(sub);
        const dl = trEl("dl", "cf-rows cf-amt");
        amtOnly.forEach((n) => { const dd = document.createElement("dd"), sp = trRowTxfNew(n), now = Number(sending[n]) || 0;
          arrow(dd, trFmt(old(n))); dd.append(trEl("span", "n", trFmt(now))); if (sp) dd.appendChild(lotsRef(sp, now, null));
          dl.appendChild(cfRow("", trDisplay(n), dd)); });
        body.appendChild(dl);
      }
    }
    // 例外才有說明句(canon:不寫否定句、框底不放常駐的後果句)
    if (codeChanged.length) body.appendChild(trEl("p", "cf-note", t("tr.cf.codeChanged", { names: list(codeChanged) })));
    if (hostOld.length) body.appendChild(trEl("p", "cf-note", t(cloud ? "tr.cf.hostOldCloud" : "tr.cf.hostOld", { names: list(hostOld) })));
    if (late) body.appendChild(trEl("p", "cf-note", t("tr.cf.late", { names: list(waiting) })));
    if (unread) body.appendChild(trEl("p", "cf-note", t("tr.cf.firstRead")));
    if (oldPv.length) body.appendChild(trEl("p", "cf-note", t("tr.cf.oldPv", { names: list(oldPv) })));
    // 一句最多點名三檔,其餘「和另外 N 檔」(同補齊那句 trCatchWill)
    const syms = (ks) => { const ns = ks.map((k) => { const b = k.replace(/@spot$/, ""), sp = trTxfSpec(trCapitalCanon(b)), tw = sp ? "" : trTwName(k); return sp ? t(sp.prod) : b + (tw ? " " + tw : ""); });
      return ns.slice(0, 3).join(LANG === "zh" ? "、" : ", ") + (ns.length > 3 ? (LANG === "zh" ? "" : " ") + t("tr.opt.catchMore", { n: ns.length - 3 }) : ""); };
    if (held.wait.length) body.appendChild(trEl("p", "cf-note", t("tr.cf.held", { syms: syms(held.wait), names: list(held.names) })));
    if (held.gate.length) body.appendChild(trEl("p", "cf-note", t("tr.cf.gated", { syms: syms(held.gate) })));
    const title = t(fire ? "tr.cf.titleFire" : "tr.cf.title");
    if (cf.ctx && delCtx === cf.ctx) {
      $("del-title").textContent = title; $("del-ok").textContent = t(fire ? "tr.cf.titleFire" : "tr.save"); $("del-ok").disabled = blocked || wait;
      const mk = $("del-mark"), paper = trIsPaper(); mk.hidden = !fire; mk.className = "mode " + (paper ? "paper" : "real"); mk.textContent = fire ? t(paper ? "tr.mode.paper" : "tr.mode.real") : "";
    }
    cf.title = title; cf.firing = fire; cf.wait = wait; cf.rows = m.rows.length + amtOnly.length; cf.notes = codeChanged.length + hostOld.length + (late ? 1 : 0) + (wait ? 1 : 0) + (unread ? 1 : 0) + (oldPv.length ? 1 : 0) + (held.wait.length ? 1 : 0) + (held.gate.length ? 1 : 0);
    if (wait && cf.timer == null) cf.timer = setTimeout(() => { cf.timer = null; trCfTick(); }, Math.max(0, cf.until - Date.now()) + 50);
  });
  // 草稿的預覽不是最新那一根(按 A1 之後過了一根 K 棒或收盤):背景再算一次,框不等它;完全沒有預覽的也在這裡請(§3-2、§3-3)
  { const r = trReport() || {}; if (trPvHost(r)) { const m0 = trCfStates(r, stored, sending, Object.assign({}, trContracts(), ctAll || {}));
      m0.stale.concat(m0.missing.filter(relevant)).forEach((n) => trPvRequest(S, n)); } }
  paintBody();
  const frag = document.createDocumentFragment(); frag.append(body, extra);
  const anyChange = cf.rows > 0 || cf.notes > 0 || cf.wait || stratRows.length > 0 || blank.length > 0 || Object.keys(sending).some((n) => Number(sending[n]) !== old(n));
  const box = trCloudBox({
    title: cf.title, mark: cf.firing ? t(trIsPaper() ? "tr.mode.paper" : "tr.mode.real") : null, markKind: trIsPaper() ? "paper" : "real", lines: [], extra: frag,
    okDisabled: blocked || cf.wait, ok: cf.firing ? t("tr.cf.titleFire") : t("tr.save"), opener,
    onCancel: () => { TR_CF.cur = null; clearTimeout(cf.timer); if (opt.onCancel) opt.onCancel(); },
    onOk: async () => {
      TR_CF.cur = null; clearTimeout(cf.timer);
      const firedAt = cf.firing;
      const mine = () => TR === S && S.open && S.view === "po";   // 等回應的時候可能已經切到另一邊:那時不碰畫面
      const repaint = () => { S.sig.cfg = null; if (mine()) poPaintCfg(); };
      // 框開著的時候報告可能變成 config: null(主機讀不到設定):底稿已經不可信,不送(開框前那一道擋不到這段)
      if (trWith(S, () => trStored() === null || trCfgUnread(trReport()))) { repaint(); return; }
      // 框開著時旗標可能被輪詢翻成 false(下單停了、主機程式舊):有待存的合約就不送,講原因
      if (ctPending && !ctAll) { S.save = "failed"; S.saveErr = t(trCtErrKey("CONTRACT_SWITCH_UNSUPPORTED", trExecState(S.st) === "running")); repaint(); return; }
      // 雲端存完、報告還沒對上:換合約的存檔一律擋(底稿那一份還沒被主機確認,換算基準不可信;稽核 P0-1)
      if (ctAll && trWith(S, trCtPend)) { S.save = "failed"; S.saveErr = t("ct.waitReport"); repaint(); return; }
      S.save = "saving"; S.saveErr = null; repaint();
      // 只送 amounts(+ 換了合約時的 contracts);下單方式是設定分頁的另一個指令(trExecSend)。
      // 雲端走 trSend:單飛 + request_id 沿用(沒送到 / 結果不明之後同一份內容重按 = 同一顆);本機照舊直送
      const steps = trCtSteps(sending, stored, ctAll, (n) => trWith(S, () => trCtStored(n)));
      // 「存之前的值」在送出前記(ack 回來時手上的回報可能已經是第一步的中間值);分兩步時第一步的值也算「還沒套用完」(同網頁稽核 r5 P1-A)
      const before = [trSentBeforeOf(S)].concat(steps.slice(0, -1).map((x) => Object.assign({}, x.amounts)));
      let res = null, done = 0;
      for (const step of steps) {
        if (cloud) { const key = trAmountsKey(step.amounts) + JSON.stringify(step.contracts || null); if (S.reqFor.amounts !== key) delete S.reqIds.amounts; S.reqFor.amounts = key; }
        res = cloud ? await trSend(S, "amounts", step) : await S.api.tradeSend("amounts", step);
        if (!(res && res.ok)) break;
        done++;
        if (done < steps.length && cloud) delete S.reqIds.amounts;   // 第二步是新內容:不沿用第一步那顆 request_id
      }
      clearTimeout(S.saveTimer);
      if (res && res.ok) { if (!S.just) S.just = { picked: {}, removed: {} }; envJustMark(S.just, stored, sending, Date.now()); if (!cloud) envPaintLocalDots(); else ENV.sig.side = null; trackFeature("portfolio_save"); }
      // 從策略頁「加到策略組合」進來的草稿存成功了(§9);按的是「儲存並下單」另記一筆
      if (res && res.ok) { if (S.a1 && joined.some((n) => S.a1.has(n))) trackFeature("po_add_saved"); if (firedAt) trackFeature("po_save_orders"); if (S.a1) joined.forEach((n) => S.a1.delete(n)); }
      if (res && res.ok && cloud) {
        // ack ok = 主機已經寫進設定檔,不是「已套用」:格子畫送出的值 + .pend,等報告對上(trPoll 裡的 trSentSettled)
        const rc = S.st && S.st.cloud;
        S.notApplied = null; S.sentBefore = before; S.save = "sent"; S.sent = sending; S.sentAt = Date.now(); S.sentRep = rc && typeof rc.reported_at === "number" ? rc.reported_at : null; S.edits = {}; S.raw = {}; S.saveUnknownAt = 0;
        S.ct.sent = ctAll; S.ct.edits = {};   // 換算基準(ct.basis)留著:之後再切回來照原本的名目換,不拿取整後的口數
        srSay(t("tr.cloud.pendAmounts"));
      } else if (res && res.ok) {
        S.save = "saved"; S.edits = {}; S.raw = {}; S.picked = null; S.ct.edits = {};   // 存進去了:stored 又是真相,picker 的選擇交回去(雲端在報告對上時清,trSentCheck)
        srSay(t("tr.saved"));
        S.saveTimer = setTimeout(() => { if (S.save === "saved") { S.save = null; repaint(); } }, 4000);
      } else {
        // 沒送到 / 結果不明 / 被拒絕(拒絕原因是不可信輸入,包在本地化前導裡、走 textContent)。換合約被拒講人話;
        // 兩步存檔第一步成功、第二步出事:合約已換、口數停在換算值
        const ck = res && res.error ? trCtErrKey(res.error, trExecState(S.st) === "running") : null;
        const half = done > 0 && steps.length > 1 ? (() => { const n = Object.keys(ctAll).find((k) => steps[0].amounts[k] !== sending[k]); return n ? t("ct.half", { prod: t(TR_TXF_SPECS[ctAll[n]].prod), n: trFmt(steps[0].amounts[n]) }) : null; })() : null;
        S.save = "failed"; S.saveErr = half || (ck ? t(ck) : trSendError(res, "save", S.env)); srSay(S.saveErr);
        // 結果不明:同一份內容再按沿用同一顆 id;過了收斂窗口才算新的意圖(trPoll 到時清掉 reqIds.amounts)
        S.saveUnknownAt = cloud && trKindOf(res) === "unknown" ? Date.now() : 0;
      }
      S.sig.cfg = null;
      try { S.st = await S.api.tradeStatus(); } catch (_) { }   // 下一輪輪詢會補
      if (mine()) { poPaintCfg(); $("po-h").focus(); }   // 儲存列可能收掉了:焦點不能掉到 BODY
      if (res && res.ok && typeof opt.onSaved === "function") opt.onSaved(sending, stored);   // 套用金額:回配置分頁、剛改的格子閃一下(要在上面那次重畫之後)
      trPollSoon(1500);
    },
  });
  // 只有記號在會送單時才出(canon):雲端的 trCloudBox 一律帶「模擬／真錢」,不送單時拿掉
  if (!cf.firing) box.mark = null;
  // 什麼都沒變(例如只是把空格改成 0)才直接存;有變就一律開框(Wei 10-17 推翻「沒連交易所不跳框」)。存不進去的照樣開框講原因
  if (!anyChange && !blocked) { box.onOk(); return; }
  confirmBox(box);
  cf.ctx = delCtx; TR_CF.cur = cf; cf.paint = paintBody;
}
/* 開著的存金額框:新報告到了(trPoll)就重算那張表——預覽到了換上表、數字變了跟著換、逾時講一句。框收掉就停 */
function trCfTick() {
  const cf = TR_CF.cur;
  if (!cf || delCtx !== cf.ctx || $("del-scrim").hidden) { TR_CF.cur = null; return; }
  cf.paint();
}
// 表頭的「MM/DD」／「MM/DD HH:MM」(本機時區)
function trCfMD(sec, hm) { const d = new Date(sec * 1000), p = (x) => String(x).padStart(2, "0"); return p(d.getMonth() + 1) + "/" + p(d.getDate()) + (hm ? " " + p(d.getHours()) + ":" + p(d.getMinutes()) : ""); }
/* 請機器背景重算這支的回測到最新資料(stats_refresh,同「更新績效」那條;同碼不定版):只為了拿到最新那一根的預覽。
   一分鐘內請過就不再請;ack 的 CODE_CHANGED(程式改過還沒回測)記下來,框上講那一句、不等它 */
function trPvRequest(S, name) {
  const q = (S.pvReq = S.pvReq || {}), prev = q[name], now = Date.now();
  if (prev && now - prev.at < 60000) return;
  const rec = { at: now, code: prev && prev.code === "CODE_CHANGED" ? prev.code : null };
  q[name] = rec;
  Promise.resolve().then(() => S.api.tradeSend("stats_refresh", { names: [name] })).then((r) => {
    const res = r && r.ok && r.result && typeof r.result === "object" ? r.result : null, code = res && res.skipped ? res.skipped[name] : null;
    rec.code = code === "CODE_CHANGED" ? code : res && Array.isArray(res.started) && res.started.indexOf(name) >= 0 ? null : rec.code;
    if (code === "CODE_CHANGED") trCfTick();
  }, () => {});
}
/* 部位表同一個標的有兩支以上有金額的策略(ux-order-1-4-5 §2.2 方案 A):標的格放一顆「N 支策略」mini tag,
   點開下面一列拆解(每支策略的 金額 × 訊號 = 貢獻,最後一句是合計)。展開狀態只在記憶體(TR.netOpen),重畫保留、切走分頁清掉 */
function trNetRows(sym, cs, cell, tb, lot, unit, cols) {
  const id = "tr-net-" + sym.replace(/[^A-Za-z0-9]/g, "_"), open = TR.netOpen.has(sym);
  const b = trEl("button", "net-tag", t("tr.net.tag", { n: cs.length })), cv = trEl("span", "cv7");
  b.type = "button"; b.dataset.fk = "net:" + sym; cv.setAttribute("aria-hidden", "true"); b.appendChild(cv);
  b.setAttribute("aria-expanded", String(open)); b.setAttribute("aria-controls", id);
  cell.appendChild(b);
  // 拆解句裡的數帶這一區的單位(句子會被單獨讀到);每一行的貢獻只放數字,單位在區標題
  const x2 = (x) => (x < 0 ? "\u2212" : "") + Math.abs(x).toFixed(2), withU = (s) => (unit ? s + " " + unit : s);
  const lotsU = (v, signed) => trLotsTgtFmt(v, signed) + " " + t(trLotsKey(Math.round(Math.abs(v) * 100) / 100, "tr.lotsUnit", "tr.lotUnit"));
  const amt = (v) => (lot ? lotsU(v) : withU(trFmt(v)));
  const row = document.createElement("tr"), td = trEl("td", "note"), box = trEl("div", "net-box");
  row.id = id; row.className = "net-row"; row.hidden = !open; td.colSpan = cols || 4;
  cs.forEach((c) => {
    const line = trEl("div", "net-line"), v = trEl("span", "v mono " + (c.v > 0 ? "buy" : c.v < 0 ? "sell" : ""), lot ? trLotsTgtFmt(c.v, true) : trFmt(c.v, true));
    if (c.notYet) { v.textContent = "—"; v.className = "v mono na"; v.title = t("tr.sigNotYet"); }
    line.append(trEl("span", "nm", trDisplay(c.name)), trEl("span", "f mono", trFmt(c.amount) + " × " + (c.notYet ? "—" : x2(c.x))), v);
    box.appendChild(line);
  });
  const ns = trNetSum(cs), twn = trTwName(sym), base0 = sym.replace(/@spot$/i, "").replace(/(USDT|USDC|BUSD|FDUSD|USD)$/i, "") || sym, base = twn ? base0 + " " + twn : base0;
  box.appendChild(trEl("div", "net-sum", ns.kind === "sumOffZero" ? t("tr.net.sumOffZero", { l: amt(ns.l), s: amt(ns.s), base })
    : t(ns.kind === "sumOff" ? "tr.net.sumOff" : "tr.net.sum", { t: lot ? lotsU(ns.t, true) : withU(trFmt(ns.t, true)), l: amt(ns.l), s: amt(ns.s), m: amt(ns.m) })));
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
    // 群益讀帳回的是解析後的合約代碼(TM2608 / TX2608 / MTX2608):要轉回列用的 TMF / TXF / MXF,不然跟目標對不上(誤報「另有手動」、多一列幻影策略外;同 trPosDetail)
    Object.keys(e.positions).forEach((s) => { const k = trTwBroker(id) ? trTwFutCanon(s) : trCanonSym(s); out[k] = (out[k] || 0) + trSigned(e.positions[s]); });
  });
  return out;
}
/* 帳戶的「實際」與 Blave 的帳本(同網頁 pfBookState;兩頁共用一份,數字才不會各說各話)。
   實際 = 兩個真值來源取較新的:下單那一輪對帳器會立刻重讀持倉寫進快照,帳戶讀取器要等自己的下一輪 */
function trBook(r, target) {
  const last = r.last_reconcile || null, live = trLivePositions(r), acct = r.account && r.account.venues ? r.account : null, actual = {};
  const lastMs = last ? trMs(last.ts) : null, acctMs = acct ? trMs(acct.read_at) : null;
  const reconNewer = last && (!acct || (lastMs || 0) > (acctMs || 0));
  if (acct && !reconNewer) {
    Object.keys(live).forEach((k) => { actual[k] = live[k]; });
    if (last && lastMs != null && Date.now() - lastMs < TR_STALE_MS) {
      Object.keys(last.actual || {}).forEach((k0) => { const k = trCanonKey(k0); if (/@spot$/.test(k)) actual[k] = trSigned(last.actual[k0]); });
    }
  } else if (last) Object.keys(last.actual || {}).forEach((k0) => { actual[trCanonKey(k0)] = trSigned(last.actual[k0]); });
  // 只管自己的部位時,「實際」是 Blave 的帳本(對帳器拿它比目標);帳本完全沒有的帳戶部位是「策略外」(自動下單 › 部位標小標)
  const own = r.self_ledger === true ? trOwnBook(last, actual, target) : null;
  return { last, actual, mine: own ? own.book : actual, unmanaged: own ? own.unmanaged : {} };
}
/* 休市中對帳器兩邊都不動的模擬盤台股鍵(對帳快照 last_reconcile.market_closed,lib/portfolio._paper_tw_closed_keys;同網頁 pfTwClosedKeys):
   這些列的差額不上買賣色、不算「會下單」。快照過舊(TR_STALE_MS)時不用:那一輪的休市判斷可能早就不成立 */
function trTwClosedKeys(last) {
  const ms = last ? trMs(last.ts) : null;
  if (ms == null || Date.now() - ms >= TR_STALE_MS || !Array.isArray(last.market_closed)) return new Set();
  return new Set(last.market_closed.filter((k) => typeof k === "string").map(trCanonKey));
}
/* 對帳快照 target 裡標 gated: true 的列(lib/portfolio:「等新訊號」啟動、或對執行中的組合加了策略,下一個訊號之前不送單;同網頁 pfGatedKeys):
   這一輪不會下單——差額灰、不算待下單、不掛拒單。舊 runtime 沒這欄 = 空;快照過舊(TR_STALE_MS)不用 */
function trGatedKeys(last) {
  const ms = last ? trMs(last.ts) : null, tg = last && last.target && typeof last.target === "object" ? last.target : null;
  if (ms == null || Date.now() - ms >= TR_STALE_MS || !tg) return new Set();
  return new Set(Object.keys(tg).filter((k) => !!tg[k] && tg[k].gated === true).map(trCanonKey));
}
/* 對帳快照 target 裡還在等第一個訊號的列(lib/portfolio._first_signal_targets:帶 awaiting,目標已換成窗內目標):
   回 Map(列 → { signed: 對帳器這一輪往哪走, names: [還在等的策略] })。舊 lib(caps 沒有 first_signal_wait)、快照過舊、awaiting 全過期 = 空 */
function trAwaitKeys(last) {
  const out = new Map(), ms = last ? trMs(last.ts) : null, tg = last && last.target && typeof last.target === "object" ? last.target : null;
  if (ms == null || Date.now() - ms >= TR_STALE_MS || !tg || !Array.isArray(last.caps) || last.caps.indexOf("first_signal_wait") < 0) return out;
  const now = Date.now() / 1000;
  Object.keys(tg).forEach((k) => { const row = tg[k] || {}, a = row.awaiting; if (!a || typeof a !== "object") return;
    const names = Object.keys(a).filter((n) => Number(a[n]) > now); if (!names.length) return;
    const size = Number(row.size) || 0;
    out.set(trCanonKey(k), { signed: row.side === "long" ? size : row.side === "short" ? -size : 0, names }); });
  return out;
}
/* 還沒跑過(沒有狀態檔)的策略也要在總訊號部位表列商品寫 0(同網頁 pfTargetParts,Wei 10-13):標的退回回測的 symbol、訊號 0 */
function poPartStates(stored, states) {
  const out = Object.assign({}, states || {});
  Object.keys(stored || {}).forEach((n) => {
    if (out[n] && (out[n].symbol || out[n].weights)) return;
    const x = TR.list.find((y) => y.name === n);
    // notYet:還沒跑出第一次 live tick(回報的 states 裡沒有這支)——訊號不是 0,是還沒算;畫「—」不畫 ×0(post-connect-flow 第 7 列)
    if (x && x.symbol && x.portfolio !== true) out[n] = { symbol: x.symbol, market: x.market, position: 0, notYet: true };
  });
  return out;
}
/* 各商品的總訊號部位(同網頁 buildSigTargets(mode);設計 autotrade-bridge-mockup A 案):同一標的的各檔策略「金額 × 訊號」加總,一標的一列。兩個地方用同一個列函式:
   - mode "cfg"(策略組合 › 配置):只有「標的｜目標」,目標上色;多支策略的標的用「N 支策略」展開。不管連沒連交易所都一樣
   - mode "trade"(自動下單 › 部位):讀機器回報的已存配置,「標的｜目標｜帳上｜差額」;標的格只寫標的(貢獻的策略與金額在策略組合頁,Wei 10-15 拿掉);帳上有、策略沒要的部位在區尾標「策略外」;
     差額只在下單執行中上色、拒單掛在那一列底下;門檻腳注與淨值倍數在表底合計列。帳上、差額、拒單、門檻、淨值×只在這一頁(同一個差額不在兩頁出現)
   投資組合每個持有的成分一列,權重 0 的不列;還沒算過的投資組合在它的計價區尾列一列講原因 */
function poSigTable(r, stored, states, mode) {
  const frag = document.createDocumentFragment(), trade = mode === "trade";
  const st2 = poPartStates(stored, states), target = trClientTargets(stored, st2, trContracts()), contribs = trContribs(stored, st2, trContracts());
  const recon = trade && trHasAccount(r), bk = recon ? trBook(r, target) : null, mine = bk ? bk.mine : {}, last = bk ? bk.last : null, gates = (last || {}).gates || {};
  const twClosed = recon ? trTwClosedKeys(last) : new Set(), gatedK = recon ? trGatedKeys(last) : new Set(), awaitK = recon ? trAwaitKeys(last) : new Map();
  // 綁了但第一次讀帳還沒回來(沒有對帳快照、綁定的交易所也還沒有任何讀帳結果):帳上與差額寫「—」,不畫一個手上沒有的 0(帳上本來有部位的人會以為要整筆下單)
  const firstRead = recon && trFirstReadPending(r);
  // Blave 帳本上有、已經沒有策略要的(對帳器會平掉):列成目標 0。帳上有、帳本沒有的(用戶自己的):區尾「策略外」,目標與差額「—」
  const extra = recon ? Object.keys(mine).filter((k) => mine[k] && !(k in target)) : [];
  const outside = recon && !firstRead ? Object.keys(bk.unmanaged).filter((k) => bk.unmanaged[k] && !/@spot$/.test(k) && !(k in target)) : [];   // 策略要的標的不另列「策略外」:那一列底下寫「另有手動 N」
  const waiting = Object.keys(stored).filter((n) => { const x = TR.list.find((y) => y.name === n) || {}, st = (states || {})[n];
    return x.portfolio === true && !(st && st.weights && typeof st.weights === "object") && !(TR.just && TR.just.removed && TR.just.removed[n] && Date.now() - TR.just.removed[n] < ENV_JUST_MS); });
  const fundedN = Object.keys(stored).filter((n) => stored[n] > 0).length, picked = Object.keys(stored).length > 0;
  const syms = Object.keys(target).concat(extra).filter((k, i, a) => a.indexOf(k) === i).sort();
  // 沒有任何金額、也沒有要平、沒有策略外的部位:整段不出(連標題都不印;自動下單頁由原因行那條連結當出口)。下單頁「選了策略、金額全 0」照畫,目標 0 灰
  if (!((trade ? picked : fundedN) && (syms.length || waiting.length)) && !extra.length && !outside.length) return frag;
  const showPlan = trade ? picked : true;
  const namesOf = {};
  Object.keys(stored).forEach((n) => { const s = st2[n]; if (!s || !s.symbol || s.weights) return; const sym = trCanonSym(trEffSym(n, s.symbol, trContracts())), k = sym + (s.market === "spot" || trTwCash(sym, trPaperOf(n)) ? "@spot" : ""); (namesOf[k] = namesOf[k] || []).push(n); });
  const usNo = (sym) => trUsNoAuto(r, sym, (contribs[sym] || []).map((c) => c.name));
  const vid = trVenueId(), vk = trVenueKind(vid), covered = (sym) => recon && trTradesSym(vk, sym) && !usNo(sym);
  const hs = envHeadState(TR.st, Date.now()), running = hs === "running" || hs === "unconfirmed";
  const det = recon ? trPosDetail(r) : {}, detRows = [];   // 持倉細節(均價、未實現、保證金、槓桿):帳上不是 0 的列底下一行小字
  if (trade) {
    // 區段標題「策略組合」+ 右上「到策略組合修改」:頁首原因行**實際畫出**連結(TR.noAmtLink)或動作列有導引鈕(TR.zBridge)時藏——一個畫面一條橋
    const sec = trSec(trEl("span", "label", t("po.nav")));
    if (!TR.noAmtLink && !TR.zBridge) { const acts = trEl("div", "pf-acts"), lk = trEl("button", "btn-quiet po-bridge", t("po.bridgeEdit")); lk.type = "button"; lk.dataset.fk = "po-bridge"; lk.addEventListener("click", () => poOpen("cfg", true)); acts.appendChild(lk); sec.appendChild(acts); }
    frag.appendChild(sec);
  } else frag.appendChild(trSec(trTipLabel("label", t("po.sigTargets"), t("po.sigTargetsTip"))));
  const qmap = trQuoteMap() || {};
  const zoneOfSym = {}; syms.concat(outside).forEach((sym) => { const cs = contribs[sym] || []; zoneOfSym[sym] = trSymZone(sym, cs.map((c) => qmap[c.name]), cs.map((c) => trSrcMarket(r, c.name))); });
  const items = (showPlan ? syms.map((sym) => ({ sym, z: zoneOfSym[sym] })).concat(waiting.map((n) => ({ wait: n, z: trZoneOf(n) }))) : extra.map((sym) => ({ sym, z: zoneOfSym[sym] })))
    .concat(outside.map((sym) => ({ out: sym, z: zoneOfSym[sym] })));
  const zoneKeys = items.map((it) => it.z), zones = trZoneOrder(zoneKeys, vid, trMultZone(vid, trUnit(), zoneKeys));
  // 配置表的台股列寫整張數、單位在格子裡(「N 張」＋小字 TWD):整表只有台股那一區時,欄頭不再掛「（TWD）」
  const twLots = {};
  if (!trade) syms.forEach((sym) => { if (zoneOfSym[sym] === TR_TXF_CCY) { const x = trTwLots(sym, stored, st2); if (x) twLots[sym] = x; } });
  const oneUnit = zones.length === 1 && !(zones[0] === TR_TXF_CCY && !trade) ? trZoneUnit(zones[0]) : null, cols = trade ? 4 : 2;
  const scroll = trEl("div", "pf-scroll"), tbl = trEl("table", "pf-tbl zoned pf-sig");
  const venueName = vid ? trVenueLabel(vid, true) : "";
  tbl.appendChild(trHead(trade ? [[t("tr.col.symbol"), ""], [t("tr.col.target"), "n", oneUnit], [t("tr.col.held"), "n", null, t("po.actualTip", { venue: venueName })], [t("tr.col.diff"), "n"]]
    : [[t("tr.col.symbol"), ""], [t("tr.col.target"), "n", oneUnit]]));
  const lotRow = (sym) => trIsLot(last, sym) || !!trTxfSpec(trCapitalCanon(sym.replace(/@spot$/, "")));
  const numText = (lot, v) => (lot ? trLotsFmt(v, true) : trFmt(v, true));
  const symCell = (sym) => { const sp = lotRow(sym) ? trTxfSpec(trCapitalCanon(sym)) : null;
    const c = trEl("td", sp ? "sname" : "sym", sp ? t(sp.prod) : sym.replace(/@spot$/, ""));
    const tw = sp ? null : trTwNameEl(sym); if (tw) c.appendChild(tw);
    // 這個標的只有剛選進、還沒回報、清單也沒寫市場的策略:不猜「合約」
    const guess = !/@spot$/.test(sym) && (namesOf[sym] || []).length > 0 && namesOf[sym].every((n) => st2[n] && st2[n].notYet === true && !st2[n].market);
    if (!sp && usNo(sym)) c.appendChild(trEl("span", "mkt-tag", t("tr.mkt.noAuto")));
    else if (!guess) c.appendChild(trEl("span", "mkt-tag", t(trMktKey(sym, false, !!sp)))); return c; };
  const dash = (tip) => { const c = trEl("td", "n na", "—"); if (tip) c.title = t("po.notTradedTip", { venue: venueName }); return c; };
  const pending = new Set(), rowOf = {};
  zones.forEach((z) => {
    const tb = document.createElement("tbody");
    if (zones.length > 1) { const g = trEl("tr", "grp"), c0 = trEl("td", "grp-l" + (z === TR_ZONE_LOTS || z === TR_ZONE_UNKNOWN ? " cjk" : ""), trZoneLabel(z)); c0.colSpan = cols; g.appendChild(c0); tb.appendChild(g); }
    // 區內可對帳的在前,再照代號;還沒算過的投資組合、策略外排區尾
    const zs = items.filter((it) => it.z === z && it.sym).sort((a, b) => (covered(b.sym) ? 1 : 0) - (covered(a.sym) ? 1 : 0) || (a.sym < b.sym ? -1 : a.sym > b.sym ? 1 : 0));
    zs.forEach((it) => sigRow(it.sym, z, tb));
    items.filter((it) => it.z === z && it.wait).forEach((it) => {
      const row = document.createElement("tr"), nc = trEl("td", "sname", trDisplay(it.wait));
      nc.appendChild(trEl("span", "mkt-tag", t("po.mktPortfolio")));
      row.append(nc, trEl("td", "n na pending", trHostOld() ? t("po.hostOld") : t("tr.typecPending")));
      for (let i = 2; i < cols; i++) row.appendChild(trEl("td", "n"));
      tb.appendChild(row);
    });
    items.filter((it) => it.z === z && it.out).forEach((it) => {
      const lot = lotRow(it.out), row = document.createElement("tr"), sc = symCell(it.out);
      sc.appendChild(trEl("span", "mkt-tag own-tag", t("tr.unmanagedTag")));
      row.append(sc, trEl("td", "n na", "—"), trEl("td", "n", numText(lot, bk.unmanaged[it.out])), trEl("td", "n na", "—"));
      tb.appendChild(row); detRow(it.out, tb, lot, bk.unmanaged[it.out], 0);
    });
    tbl.appendChild(tb);
  });
  function sigRow(sym, z, tb) {
    const lot = lotRow(sym), row = document.createElement("tr"), sc = symCell(sym);
    // 口數列照對帳器的規則:多支策略加總後才取整,目標與差額都是機器真的會下的整數口;取整前的值與名目放 tooltip
    const raw = target[sym] || 0, lt = lot ? trLotsTarget(raw) : null, ts = lt ? lt.lots : raw;
    const noSig = (namesOf[sym] || []).length > 0 && namesOf[sym].every((n) => trNoSignalYet(n));
    // 有一支還沒跑出第一次 live tick(states 裡沒有):這個標的的目標算不出來,目標與差額寫「—」(post-connect-flow 第 7 列)
    const notYet = !noSig && (namesOf[sym] || []).some((n) => st2[n] && st2[n].notYet === true && Number(stored[n]) > 0);
    const tc = trEl("td", "n" + (trade ? (ts ? "" : " na") : " " + (ts > 0 ? "buy" : ts < 0 ? "sell" : "na")), noSig ? t("po.hostOld") : notYet ? "—" : numText(lot, ts));
    if (noSig) tc.className = "n na pending";
    if (notYet) { tc.className = "n na"; tc.title = t("tr.sigNotYet"); }
    const tw = !trade && !noSig && !notYet && z === TR_TXF_CCY ? twLots[sym] : null;
    if (!trade && !noSig && !notYet && z === TR_TXF_CCY) {
      if (tw) {
        // 模擬交易寫股數(模擬盤整股成交),其他寫整張(真實券商整張下單)
        const sh = tw.unit === "shares", q = tw.shares, d = tw.date ? tw.date.slice(5).replace("-", "/") : null;
        tc.className = "n " + (q > 0 ? "buy" : q < 0 ? "sell" : "na");
        tc.textContent = sh ? t(Math.abs(q) === 1 ? "po.twShare" : "po.twShares", { n: trFmt(q) }) : trTwLotsText(tw.lots, tw.odd);
        tc.appendChild(trEl("span", "sub", trFmt(tw.twd) + " " + TR_TXF_CCY));
        // 「0」為什麼是 0 寫在格子裡(td 不能聚焦,title 鍵盤與觸控都看不到):買不起一股(券商也收零股,不足一張不再是 0)
        if (!q && tw.twd > 0 && tw.price) tc.appendChild(trEl("span", "sub", t("po.twSharesZero", { px: trFmt(tw.price) })));
        if (tw.price && d) tc.title = sh ? t(tw.est ? "po.twSharesTipEst" : "po.twSharesTip", { d, px: trFmt(tw.price) })
          : t(tw.est ? "po.twLotsTipEst" : "po.twLotsTip", { d, px: trFmt(tw.price), l: trFmt(Math.abs(tw.lots)), s: trFmt(Math.abs(tw.odd)) });
      } else if (zones.length === 1) tc.textContent = numText(lot, ts) + " " + TR_TXF_CCY;
    }
    if (lt && !noSig && !notYet) { const sp = trTxfSpec(trCapitalCanon(sym)), m = ts && sp ? trTxfRefMoney(sp, Math.abs(ts), trTxfPrice()) : null;
      tc.title = [lt.raw !== null ? t("po.lotsRawTip", { n: trLotsTgtFmt(lt.raw) }) : "", m != null ? t("tr.lotsNotionalTip", { amt: trFmt(Math.round(m)) }) : ""].filter(Boolean).join("\n"); }
    row.append(sc, tc);
    if (trade) {
      if (!covered(sym)) { const tip = !usNo(sym); row.append(dash(tip), dash(tip)); }
      else if (firstRead) row.append(dash(false), dash(false));
      else if (notYet) { row.append(trEl("td", "n", numText(lot, mine[sym] || 0))); const dd = row.appendChild(trEl("td", "n na", "—")); dd.title = t("tr.sigNotYet"); }
      else {
        // 沒回報這個標的 = 帳上就是 0:畫成「—」會把「差額正等著下單」這個最重要的事實藏掉
        const as = mine[sym] || 0, d = ts - as;
        // 上色對齊真正觸發下單的門檻:平台 10,或該標的在交易所的最小下單量(gates);口數列差 1 口就送單。沒在下單時不上色(上色 = 機器會去買／賣)
        // 休市中的模擬盤台股:兩邊都不下(market_closed),過門檻的差額也灰、不算會下單,原因寫「休市中，開盤後下單」
        const gs = lot ? null : trGateSide(gates[sym], ts, as), willTrade = lot ? Math.round(Math.abs(d)) > 0 : Math.abs(d) >= (gs ? gs.usd : 10);
        /* 等第一個訊號(快照列帶 awaiting):對帳器這一輪往窗內目標走,不是整個目標——差額照那一段算會不會下單,夾在 [帳上, 目標] 之間
           (同 lib 與存金額框 trCfRows 的夾法;快照是上一輪的,金額改過時不超出現在的目標)。被留住的那段灰 */
        const aw = awaitK.get(sym), wt = aw ? Math.min(Math.max(aw.signed, Math.min(ts, as)), Math.max(ts, as)) : ts, dw = wt - as;
        const winTrade = !aw ? willTrade : lot ? Math.round(Math.abs(dw)) > 0 : Math.abs(dw) >= (gs ? gs.usd : 10);
        // 優先序:等新訊號(快照 target gated,開盤也不下)> 等第一個訊號 > 休市
        const gated = gatedK.has(sym), awaiting = !gated && !!aw && !winTrade, closed = !gated && !awaiting && twClosed.has(sym), acts = willTrade && winTrade && !closed && !gated;
        const held = !acts && Math.round(Math.abs(d)) > 0;
        const dc = trEl("td", "n " + (acts && running ? (d > 0 ? "buy" : "sell") : acts || held ? "hold" : "na"), numText(lot, d));
        // 灰色差額 = 低於下單門檻、這輪不下單:「這輪不下單:」+ 原因放這一格的 tooltip(門檻腳注不再佔合計列);減倉／平倉門檻等於平坦的 10 時沒有要解釋的(同網頁)
        const short = sym.replace(/@spot$/i, "").replace(/(USDT|USDC|BUSD|FDUSD|USD)$/i, "") || sym;
        const why = !held ? null : gated ? t(trIsPaper() ? "tr.opt.waitDesc" : "tr.opt.waitDescReal")
          : awaiting ? t("tr.cf.held", { syms: short, names: aw.names.map(trDisplay).join(LANG === "zh" ? "、" : ", ") }) : closed ? (willTrade ? t("po.twClosedHold") : null) : lot ? t("tr.gateFootReduce", { sym: short })
          : gs && !((gs.reduce || gs.close) && gs.usd <= 10) ? (gs.band ? t("tr.gateFootBand", { sym: short, m: trFmt(gs.usd) }) : gs.reduce ? t("tr.gateFootReduce", { sym: short }) : t("tr.gateFootEntry", { sym: short, m: trFmt(gs.usd) })) : null;
        if (why) dc.title = closed || gated || awaiting ? why : t("tr.gateFootLead") + why;
        row.append(trEl("td", "n", numText(lot, as)), dc);
        if (acts) pending.add(sym);   // 不看 running:沒在跑時灰字「上次下單失敗」也要掛得上(丙案)
      }
    }
    tb.appendChild(row); rowOf[sym] = row;
    /* 只管自己的部位(帳本模式)時,同一標的帳戶比帳本多出來的是手動部位(Wei 10-14,同網頁 5d93c656):帳上、差額照舊只算策略那份,
       這一列底下多一行「另有手動 N」(tooltip:對帳不會動它)。交易所的均價／未實現／保證金是整個帳戶那一檔的,拆不出策略那份——
       細節行尾註明「含手動」,這一列也不進表底合計 */
    if (trade && !firstRead && covered(sym)) { const as = mine[sym] || 0; detRow(sym, tb, lot, as, trManualPart(r, sym, lot, bk) || 0); }
    if (!trade && contribs[sym] && contribs[sym].length >= 2) trNetRows(sym, contribs[sym], sc, tb, lot, trZoneUnit(z), cols);
  }
  // 帳上不是 0 的列底下:均價 · 未實現 · 保證金(槓桿),只寫讀得到的那幾樣;一樣都沒有就不加這一行。未實現與保證金取整到元、未實現帶正負號(同網頁 pfFmtSignedAmt)
  // 口數列(台指期)的未實現與保證金是台幣(TAIFEX 保證金、點值 × 指數),跟帳戶幣不同:數字後面寫幣別,表底也不跟別的幣別加在一起。
  // 帳上不為 0 的每一列都進表底合計的分母(沒有細節的、含手動的以空物件記):缺一列,那一項就不畫(缺一列的和是低估)
  function detRow(sym, tb, lot, as, manual) {
    const hasManual = Math.abs(manual) > 1e-9, x = as ? det[sym] || {} : null, has = !!x && Object.keys(x).length > 0;
    const unit = trUnit(), rowCcy = lot || zoneOfSym[sym] === TR_TXF_CCY ? TR_TXF_CCY : unit, ccy = rowCcy !== unit ? rowCcy : null, money = (v) => (ccy ? v + " " + ccy : v);
    if (x) detRows.push(Object.assign({ ccy: rowCcy || "" }, hasManual ? {} : x));
    if (!has && !hasManual) return;
    const td = trEl("td", "note po-det"), seg = (node) => { if (segN++) td.append(" · "); td.append(node); }; let segN = 0;
    if (hasManual) { const ml = trEl("span", "po-manual", t("po.manualPart", { n: lot ? trLotsFmt(manual, true) + " " + t(trLotsKey(Math.abs(manual), "tr.lotsUnit", "tr.lotUnit")) : trFmt(manual, true) })); ml.title = t("tr.unmanagedTip"); seg(ml); }
    if (has && "entry_price" in x) seg(t("po.dEntry", { v: trFmtPrice(x.entry_price) }));
    if (has && "unrealized_pnl" in x) seg(t("po.dUpnl", { v: money(trFmt(Math.round(x.unrealized_pnl) || 0, true)) }));   // 取整後是 0 寫「0」、不帶正負號
    if (has && "margin" in x) seg(t("po.dMargin", { v: money(trFmt(Math.round(x.margin))) }) + ("leverage" in x ? t("po.dLev", { x: x.leverage.toLocaleString("en-US", { maximumFractionDigits: 2 }) }) : ""));
    if (hasManual && has) td.append(t("po.detInclManual"));
    const row = document.createElement("tr"); td.colSpan = cols; row.appendChild(td);
    const host = tb.lastChild; if (host && host.classList) host.classList.add("has-note");
    tb.appendChild(row); rowOf[sym] = row;   // 拒單接在細節行底下(列 → 細節 → 拒單,同網頁)
  }
  scroll.appendChild(tbl); frag.appendChild(scroll);
  if (!trade) return frag;
  /* 表底合計列:左邊未實現與保證金的合計(有細節的列全部都有才加,缺一列的和是低估),右邊「合計 ≈ X · 淨值 N×」(跟金額表、啟動框同一個格式 trPlanTotal) */
  const foot = trEl("div", "pf-total po-foot"); let footN = 0;
  const oneCcy = detRows.every((x) => x.ccy === (detRows[0] || {}).ccy);   // 台幣(口數列)與帳戶幣不相加
  const sumOf = (f) => (oneCcy && detRows.length && detRows.every((x) => f in x) ? detRows.reduce((s, x) => s + x[f], 0) : null);
  const su = sumOf("unrealized_pnl"), sm = sumOf("margin");
  if (su !== null || sm !== null) {
    const left = trEl("span", "po-gate");
    left.textContent = [su !== null ? t("po.dUpnl", { v: trFmt(Math.round(su) || 0, true) }) : "", sm !== null ? t("po.dMargin", { v: trFmt(Math.round(sm)) }) : ""].filter(Boolean).join(" · ");
    foot.appendChild(left); footN++;
  }
  // 右邊:合計算不出來(缺報價／匯率)時整段不畫——淨值×只拿帳戶幣那部分算,跟「—」放在一起互相矛盾(設計稽核電腦版必改 1)
  const pt = fundedN ? trPlanTotal(stored) : null;
  if (pt && pt.ok) {
    foot.appendChild(trEl("span", "", t("tr.total")));
    const tn = trEl("span", "n", pt.text); if (pt.ccy) tn.appendChild(trEl("span", "ccy", pt.ccy)); foot.appendChild(tn);
    if (pt.mult) foot.append(trEl("span", "", "·"), trEl("span", "n mult", pt.mult));
    footN++;
  }
  if (footN) frag.appendChild(foot);
  if (outside.length) frag.appendChild(trEl("div", "pf-foot", t("tr.unmanagedTip")));
  /* 下單失敗:每個還欠著單的標的各掛它最新的那一筆(trLiveOrderErrs,同網頁),掛在那一列底下(靠右,跟著差額);整台機器的平倉沒做成("*")放表底。
     音量各筆自己算(spec 丙案):對帳器在跑、而且是最近一輪的失敗 = 紅字「下單失敗:…」;否則降成灰字「上次下單失敗:…」帶時間。
     狀態跟頁頭同一個來源(envHeadState):雲端讀不到新狀態時兩處才不會一紅一灰 */
  const openSet = new Set(syms.filter((k) => (mine[k] || 0) !== 0));
  const errs = firstRead ? new Map() : trLiveOrderErrs(r.order_errors, pending, { open: openSet, twOpen: [...openSet].some((k) => !!trTxfSpec(k)), running, orders: r.orders });
  errs.forEach((le, key) => {
    const sym = String(le.symbol || "—").replace(/@spot$/, ""), err = String(le.error || le.message || ""), closeAll = err.indexOf("close-all:") === 0;
    const plain = trOrderErrParse(err) ? trOrderErrText("", err).replace(/^[\s:：—-]+/, "").replace(/^[a-z]/, (c) => c.toUpperCase()) : null;
    const loud = !closeAll && trErrLoud(le, hs, TR.startAt, r.last_reconcile);
    const line = trEl("span", loud ? "pf-note err" : "pf-note past");
    // 節流中的重複失敗只更新那一列的 last_at／count(4647a2e):時間寫最後一次失敗;哪一筆還在失敗照舊看 ts(trLiveOrderErrs)
    if (!loud) { const stamp = trErrStamp(le.last_at || le.ts, Date.now()); if (stamp) line.appendChild(trEl("span", "ts mono", stamp)); }
    // 不可信輸入(機器回報的原文):截長、走文字節點
    line.append(plain || (loud ? t("po.orderFailedRow", { err: trOrderErrRaw(err) }) : t("po.orderFailedLast", { err: trOrderErrRaw(err) })));
    // 「請 agent 查原因」:只把一句話填進本機聊天框、不送出(聊天框那一句離開了這一列,照舊帶標的);平倉失敗的答案就是那行字,不問
    if (!closeAll) { const b = trEl("button", "btn-quiet tr-err-ask", t("tr.err.ask")); b.type = "button"; b.dataset.fk = "errask:" + key; b.addEventListener("click", () => trErrAsk(sym, err)); line.append(" ", b); }
    const host = rowOf[key];
    if (host) {
      const er = document.createElement("tr"), td = trEl("td", "note po-err"); td.colSpan = cols; td.appendChild(line); er.appendChild(td);
      host.classList.add("has-note");
      host.parentNode.insertBefore(er, host.nextSibling);
    } else { const f2 = trEl("div", "pf-foot"); f2.appendChild(line); frag.appendChild(f2); }
  });
  return frag;
}
/* 帳戶回報的持倉細節(機器 v024 起;同網頁 pfLiveDetail):{ 列 key: { entry_price, unrealized_pnl, margin, leverage } },沒有 key 或不是有限值就不放;
   同一個 key 有兩列回報(兩家、群益兩個月份)對不準是哪一份,整列不給 */
function trPosDetail(r) {
  const out = {}, dup = {}, F = ["entry_price", "unrealized_pnl", "margin", "leverage"];
  trVenueIds(r).forEach((id) => { const e = trLiveEntry(r, id); if (!e || !e.ok || !e.positions) return;
    Object.keys(e.positions).forEach((s) => { const k = id === "capital" || id === "president" ? trTwFutCanon(s) : trCanonSym(s); if (k in out) dup[k] = true;
      const p = e.positions[s] || {}, d = {}; F.forEach((f) => { if (typeof p[f] === "number" && isFinite(p[f])) d[f] = p[f]; }); out[k] = d; }); });
  Object.keys(dup).forEach((k) => { out[k] = {}; });
  return out;
}
/* 自動下單 › 部位的合計與啟動框那一句用同一個格式(設計 A6:數字不會兩樣)。stored = 機器回報的已存金額;
   回 { text: "≈ 142,368" | "62,286" | "—", ccy, mult: "淨值 1.42×" | "", n: 有金額的策略數 } */
function trPlanTotal(stored) {
  /* 雲端換合約後待對上:trRowMoneyStored 的每點價值讀 ct.sent(新合約),口數就要配同一份(S.sent = trBase()),不能拿回報裡的舊口數——
     1 大台 → 20 微台那幾秒會把合計講成 1/20(稽核 P1-2)。ack 在機器寫檔之後才回,機器手上已經是那一份 */
  if (trCtPend()) stored = trBase() || stored;
  const zt = trZoneSum(stored || {}, trEquity(), trRowMoneyStored);
  return { ok: zt.total.v != null, text: trTotalText(zt.total), ccy: zt.total.v != null ? zt.total.ccy : null, mult: zt.multText,
    n: Object.keys(stored || {}).filter((k) => stored[k] > 0).length };
}
/* 啟動確認框最上面那一句:「照策略組合 N 支策略，合計 ≈ X 下單。」沒有金額就不出。
   合計包成 .plan-tot:句子裡的半形空格在 CJK 字旁只剩一條縫,「合計 ≈」要跟表底一樣分得開(同網頁 01b51a54);
   不是 ≈ 的合計不補(數字前面那一格空格就夠,補了變成兩格寬) */
function trPlanLine(stored) {
  const p = trPlanTotal(stored); if (!p.n) return null;
  if (!p.ok) return t(p.n === 1 ? "tr.startPlanNOne" : "tr.startPlanN", { n: String(p.n) });   // 合計算不出來:句子裡不夾「—」
  const mark = "\u0000", parts = t(p.n === 1 ? "tr.startPlanOne" : "tr.startPlan", { n: String(p.n), total: mark }).split(mark), frag = document.createDocumentFragment();
  frag.append(parts[0], trEl("span", "plan-tot" + (p.text.indexOf("≈") === 0 ? " approx" : ""), p.text + (p.ccy ? " " + p.ccy : "")), parts.slice(1).join(""));
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
    const ccy = (e && e.currency) || trUnit(), twd = ccy === "TWD";   // TWD 不給小數(canon Numbers:價格 = 整數 + 幣別後綴;同網頁 fmtAmount)
    const v = e && e.ok ? (twd ? trTwd(trLiveTotal(e)) : trFmt2(trLiveTotal(e))) : null;
    amt.appendChild(document.createTextNode(v == null ? "—" : v));
    if (v != null && ccy) amt.appendChild(trEl("span", "ccy", ccy));
    row.appendChild(amt); box.appendChild(row);
    // 錢包分佈(同雲端 buildAccountBlock):這份清單就是「錢在哪」的答案,常駐展開
    const wallets = e && e.ok ? trWalletRows(e) : [];
    if (wallets.length) {
      box.appendChild(trEl("div", "pf-wallets-cap", t("tr.acctBreakdown")));
      const list = trEl("div", "pf-wallets");
      wallets.forEach((w) => {
        const wr = trEl("div", "pf-wallet-row"), wa = trEl("span", "w-amt", trFmt2(w.amount));
        if (trUnit()) wa.appendChild(trEl("span", "ccy", trUnit()));
        wr.append(trEl("span", "w-name", trAcctLabel(w.key)), wa); list.appendChild(wr);
      });
      box.appendChild(list);
    }
    trPaintMargin(box, trMarginModel(e, r.account && r.account.read_at), ccy, twd);
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
// 保證金區塊(trMarginModel 的畫法):caption 右側掛更新時間;風險指標的 label 掛解釋 tip,低於維持保證金 = 紅字 + mini tag(顏色不是唯一載體)
function trPaintMargin(box, m, ccy, twd) {
  if (!m) return;
  const cap = trEl("div", "pf-wallets-cap margin"); cap.appendChild(trEl("span", "", t("tr.margin")));
  if (m.at != null) { const u = trEl("span", "upd", t("tr.marginUpdated") + " "); u.appendChild(trEl("span", "ts", trStamp(m.at))); cap.appendChild(u); }   // 漢字不進 mono,只有時間
  box.appendChild(cap);
  const list = trEl("div", "pf-wallets"), L = { available: "tr.marginAvail", initial_margin: "tr.marginInitial", maintenance_margin: "tr.marginMaint" };
  const money = (v) => { const s = twd ? trTwd(v) : trFmt2(v), wa = trEl("span", "w-amt", s == null ? "—" : s); if (s != null && ccy) wa.appendChild(trEl("span", "ccy", ccy)); return wa; };
  m.rows.forEach((x) => { const wr = trEl("div", "pf-wallet-row"); wr.append(trEl("span", "w-name", t(L[x.key])), money(x.value)); list.appendChild(wr); });
  if (m.risk) {
    const wr = trEl("div", "pf-wallet-row risk"), nm = trEl("span", "w-name"); nm.appendChild(trTipLabel("", t("tr.riskRatio"), t("tr.riskRatioTip")));
    if (m.risk.below) nm.appendChild(trEl("span", "mini_tag danger", t("tr.belowMaint")));
    const pct = m.risk.ratio == null ? "—" : (m.risk.ratio < 0 ? "−" : "") + Math.abs(m.risk.ratio).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "%";
    wr.append(nm, trEl("span", "w-amt" + (m.risk.below ? " danger" : ""), pct)); list.appendChild(wr);
  }
  box.appendChild(list);
}
function trPaintHist() {
  const box = $("tr-hist"), r = trReport() || {};
  const orders = trOrdersShown(r).slice().reverse();
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
    if (!(trOrderLots(o) && trTxfSymInto(ss, trOrderContract(o)))) { ss.className = "mono"; ss.textContent = sym.replace(/@spot$/, ""); const tw = trTwNameEl(sym); if (tw) ss.appendChild(tw); }
    ss.appendChild(trEl("span", "mkt-tag", t(trMktKey(sym, false, !!o.asset_spec && o.asset_spec.type === "futures_contracts"))));
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
  const box = $("tr-set"), r = trReport(), id = trVenueId(), ro = TR.env === "cloud";
  // 統一下單程式剛起來那幾秒:上一輪的舊失敗當「還沒讀過」畫(圓環 + 串接中…),同標題下那一行不講失敗
  const e = id && !(!ro && id === "president" && trPresBooting(r, Date.now())) ? trLiveEntry(r, id) : null;
  const bn = !ro && id === BINANCE ? CXF.bn : null;   // Binance 金鑰重查的結果(主行程 binance_link 的 state;只有這台電腦)
  // 雲端:按過重新測試 / 解除之後,那一列灰字「已送出,等回報」直到報告跟上(帳戶讀取時間比送出新 / 這一家消失)
  const pend = ro && TR.cxPend ? TR.cxPend : null;
  if (!trShould("set", box, [id, TR.unbinding, ro, TR.cx.retest, TR.cx.err, e && [e.ok, e.error], bn && [bn.verdict, bn.last && [bn.last.code, bn.last.detail]], pend && pend.what, ro && trCapWip(r, id), trExecStored(r), TR.exec, !!TR.sending.execution, !ro && id === "president" && [presWip(r), trPresStopped(r, id)]])) return;
  const hadFocus = box.contains(document.activeElement) ? document.activeElement.id : null;
  box.textContent = "";
  box.appendChild(trSec(trEl("span", "label", t("tr.account"))));
  // 一列:交易所名 + 錢記號 + 連線狀態;右邊兩顆動作。雲端第一刀唯讀:兩顆都不能按(說明在標題下那一行)
  const row = trEl("div", "cx-row");
  const nm = trEl("span", "n", trVenueLabel(id, true)); nm.title = nm.textContent; row.appendChild(nm);
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
    const ae = trAcctErr(e.error);
    // 統一登入失敗停掉:出口是「繼續」→ 開通框的「確認登入」,講這個就好,讀帳原文(worker error 的轉述)不出
    if (!ro && trPresLoginStopped(r, id)) box.appendChild(errLine(t("cx.presStopped")));
    // 帳戶模式不支援合約(OKX):讀帳戶就會擋,講怎麼改,不出原文
    else if (trErrToken(ae.msg) === "okx_account_mode") box.appendChild(errLine(t("cx.err.okxMode")));
    // 列上已有「串接失敗」記號與交易所名:這一行只留原因,有階段代碼才帶括號(設計稽核 desktop-10-08 #5)
    else box.appendChild(errLine(ae.stage === "—" ? ae.msg.slice(0, 200) : t("cx.fail", { stage: ae.stage, msg: ae.msg.slice(0, 200) })));
  }
  if (TR.cx.err) box.appendChild(errLine(TR.cx.err));
  // 解除綁定的後果只在確認框講(同畫面不講兩次,雲端視角也一樣);模擬帳戶那句是模擬→真實唯一的路標,確認框沒講,照留
  if (id === PAPER) box.appendChild(trEl("div", "pf-foot", t("tr.unbindDescPaper")));
  trExecSection(box, r, id);
  const back = hadFocus && $(hadFocus); if (back && !back.disabled) back.focus(); else if (hadFocus) $("tr-tab-set").focus();
}
/* ── 設定 › 下單方式:整個組合一種(0.1.26;機器端 runtime/exec_style.py)───────────────
   對帳器把每個標的各策略的部位加總後只下一筆,所以下單方式是組合層級的一個設定,不分策略。
   選單三項:市價 / TWAP / 限價追價。TWAP 多一格時長(整數分鐘 1–1440 = runtime _exec_spec_strict 的範圍;範圍外不送、講一行),
   片數由機器依金額與交易所最小單量算,不是設定。追價沒有參數(機器端 45 秒追不到轉市價)。
   自訂(custom)只能跟 agent 說:是現值時列成選項,改選別的 = 放棄自訂。
   改了立即送(同網頁),送出帶兩份:execution_default(runtime 1.1.127 起)+ 展開到每支成員的舊 map(更舊的 runtime 只認它)。
   現值讀報告的 execution_effective(runtime 依同一條遷移規則算好的);沒有這欄 = 舊 runtime,讀 config.execution_default。
   台灣期貨券商(統一、群益)的下單程式不經這一層、只下市價單:選單停用、固定顯示市價,下面一行講為什麼。 */
const TR_TWAP_DEFAULT_MIN = 15;   // = 網頁 TWAP_MINS 唯一的固定選項
function trExecKey(spec) {
  if (!spec || typeof spec !== "object") return "market";
  if (spec.type === "twap") { const n = Math.round(Number(spec.duration_min)); return Number.isFinite(n) && n >= 1 ? "twap:" + Math.min(n, 1440) : "market"; }
  if (spec.type === "chase") return "chase";
  if (spec.type === "custom" && typeof spec.module === "string" && /^[a-z0-9_]{1,64}$/.test(spec.module)) return "custom:" + spec.module;
  return "market";
}
function trExecSpec(key) {
  if (key.indexOf("twap:") === 0) return { type: "twap", duration_min: parseInt(key.slice(5), 10) };
  if (key === "chase") return { type: "chase" };
  if (key.indexOf("custom:") === 0) return { type: "custom", module: key.slice(7) };
  return { type: "market" };
}
function trExecArgs(key, amounts) {
  const spec = trExecSpec(key), map = {};
  if (spec.type !== "market") Object.keys(amounts && typeof amounts === "object" ? amounts : {}).forEach((n) => { map[n] = Object.assign({}, spec); });
  return { execution_default: spec, execution: map };
}
function trExecMinutes(text) {
  const v = String(text == null ? "" : text).trim();
  if (!/^\d{1,4}$/.test(v)) return null;
  const n = parseInt(v, 10); return n >= 1 && n <= 1440 ? n : null;
}
// null = 設定檔讀不到(不給改)
function trExecStored(r) {
  if (!r || r.config === null) return null;
  return trExecKey("execution_effective" in r ? r.execution_effective : (r.config || {}).execution_default);
}
// 現在生效的下單方式:台灣期貨券商一律市價;其餘是送出中的那個 → 報告的(讀不到設定時當市價,同網頁 execCurrent)
function trExecCurrent(r, id) { return trTwBroker(id) ? "market" : TR.exec.edit != null ? TR.exec.edit : trExecStored(r) || "market"; }
// 啟動框「補齊部位」說明的「怎麼下」(spec portfolio-help-icon §4):跟設定分頁同一個值。real = 連的是真的交易所(同 tr.opt.catchDesc 的 Real 後綴)
function trCatchHow(r, real) {
  const k = trExecCurrent(r, trVenueId()), sfx = real ? "Real" : "";
  if (k.indexOf("twap:") === 0) return t("tr.opt.catchHow.twap" + sfx, { min: k.slice(5) });
  if (k === "chase") return t("tr.opt.catchHow.chase" + sfx);
  if (k.indexOf("custom:") === 0) return t("tr.opt.catchHow.custom" + sfx, { module: k.slice(7) });
  return t("tr.opt.catchHow.market" + sfx);
}
function trExecSection(box, r, id) {
  const S = TR, stored = trExecStored(r);
  if (stored === null) { box.append(trSec(trEl("span", "label", t("tr.exec"))), trEl("div", "pf-foot", t("tr.exec.unread"))); return; }
  if (S.exec.edit != null && S.exec.edit === stored) S.exec.edit = null;   // 報告對上了
  const tw = trTwBroker(id), cur = trExecCurrent(r, id);
  const isTwap = cur.indexOf("twap:") === 0, busy = !!S.sending.execution;
  // TWAP／限價追價的原理收進區段標籤的 tooltip(稽核 W3)
  const how = tw ? null : isTwap ? t("tr.exec.noteTwap") : cur === "chase" ? t("tr.exec.noteChase") : null;
  box.appendChild(trSec(how ? trTipLabel("label", t("tr.exec"), how) : trEl("span", "label", t("tr.exec"))));
  const row = trEl("div", "tr-exec"), w = trEl("span", "f-selw"), sel = trEl("select", "f-input"); sel.id = "tr-exec-sel";
  sel.setAttribute("aria-label", t("tr.exec"));
  const opts = ["market", "twap", "chase"].concat(cur.indexOf("custom:") === 0 ? [cur] : [], tw ? [] : ["custom-ask"]);   // 統一／群益不列入口(同網頁)
  opts.forEach((k) => { const o = trEl("option", "", k === "market" ? t("tr.exec.market") : k === "twap" ? t("tr.exec.twap") : k === "chase" ? t("tr.exec.chase")
    : k === "custom-ask" ? t("tr.exec.customAsk") : t("tr.exec.custom", { module: k.slice(7) })); o.value = k; sel.appendChild(o); });
  sel.value = isTwap ? "twap" : cur; sel.disabled = tw || busy;
  w.appendChild(sel); row.appendChild(w);
  let min = null;
  if (isTwap) {
    min = trEl("input", "f-input txt"); min.id = "tr-exec-min"; min.type = "text"; min.inputMode = "numeric"; min.maxLength = 4;
    min.setAttribute("aria-label", t("tr.exec.minLabel"));
    min.value = S.exec.raw != null ? S.exec.raw : cur.slice(5); min.disabled = busy;
    if (S.exec.raw != null && S.exec.err) { min.setAttribute("aria-invalid", "true"); min.setAttribute("aria-describedby", "tr-exec-err"); }
    row.append(min, trEl("span", "u", t("tr.exec.minUnit")));
    min.addEventListener("change", () => {
      const n = trExecMinutes(min.value);
      if (n == null) { S.exec.raw = min.value; S.exec.err = t("tr.exec.badMin"); S.sig.set = null; trPaintSet(); srSay(S.exec.err); return; }
      trExecSend("twap:" + n);
    });
  }
  sel.addEventListener("change", () => {
    // 「自訂——跟 agent 說」是入口不是狀態(同網頁 chatAskCustomExec):不改設定,選單彈回原值,帶一句話進聊天框
    if (sel.value === "custom-ask") { sel.value = isTwap ? "twap" : cur; trExecAskCustom(); return; }
    if (sel.value === "twap") { const n = min ? trExecMinutes(min.value) : null; trExecSend("twap:" + (n || TR_TWAP_DEFAULT_MIN)); }
    else trExecSend(sel.value);
  });
  box.appendChild(row);
  // 分鐘格填錯 = 欄位錯誤:欄位下一行紅字(canon › States › Error,同網頁 .pf-note.err);送出失敗才是 .plan-err 那一行
  if (S.exec.err && S.exec.raw != null) { const p = trEl("p", "pf-note err", S.exec.err); p.id = "tr-exec-err"; box.appendChild(p); }
  else if (S.exec.err) { const p = trEl("p", "plan-err"), m = trEl("span", "fault-mark"); m.setAttribute("aria-hidden", "true"); p.append(m, trEl("span", "", S.exec.err)); box.appendChild(p); }
  else if (S.env === "cloud" && S.exec.edit != null) box.appendChild(trEl("p", "pf-note", t("tr.cloud.pendRow")));
  // 選單停用要講原因;其餘不掛說明行(設定分頁本身就是組合層級)
  if (tw) box.appendChild(trEl("div", "pf-foot tr-exec-note", t("tr.exec.tw")));
}
/* 同網頁 chatAskCustomExec:框是空的才放那一句,已有草稿就不覆蓋、只聚焦;**不送出**。
   雲端視角也填本機聊天框(本機 agent 經 blave 工具去改雲端主機),絕不送進雲端——同 trErrAsk */
function trExecAskCustom() {
  const ta = $("ta"); if (!ta) return;
  if (typeof paneSt !== "undefined" && paneSt.chat.off) paneToggle("chat", false);
  if (!ta.value.trim()) ta.value = t(TR.env === "cloud" ? "tr.exec.customPrefillCloud" : "tr.exec.customPrefill");
  autosize(); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
}
async function trExecSend(key) {
  const S = TR, cloud = S.env === "cloud", r = trReport();
  if (!r || r.config === null || S.sending.execution || ENV.cur !== S.env || key.indexOf("custom:") === 0) return;   // custom 只能跟 agent 設(宿主也拒收)
  const args = trExecArgs(key, (r.config || {}).amounts);
  // 在途時選單停用(trSend 自己掛 S.sending;本機那條這裡掛,連點不送第二次)
  const flight = cloud ? trSend(S, "execution", args) : (S.sending.execution = S.api.tradeSend("execution", args));
  S.exec = { edit: key, err: null, raw: null }; S.sig.set = null; trPaintSet();
  let res = null;
  try { res = await flight; } catch (_) { } finally { if (!cloud) delete S.sending.execution; }
  if (!res || !res.ok) { S.exec = { edit: null, err: trSendError(res, "save", S.env) || t("tr.cmdFailed"), raw: null }; srSay(S.exec.err); }
  else trackFeature("exec_set");
  S.sig.set = null; if (TR === S && S.open) trPaintSet();
  trPollSoon(cloud ? 1500 : 300);
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
  // 還沒選策略／金額全 0(spec-autotrade-empty §3):權益曲線、事件沒有資料時整區不畫,不印空狀態句——頁首那一句是這一頁唯一的導引
  const z = !!trZCase(trReport(), trZRows(r), trZDraft());
  const data = [TR.env, trEquity(), trUnit(), TR.ov.mode, TR.ov.days, TR.ov.curve, TR.ov.curveErr, TR.ov.perf, TR.ov.perfErr, TR.ov.ui, TR.ov.uiErr, r.orders, r.halt, r.events, r.order_errors, z];
  if (!trShould("over", box, data)) return;
  box.textContent = "";
  box.appendChild(trOvStats());
  box.appendChild(trOvPerf());   // 績效條:PnL 條與曲線之間(同網頁 mockup 序);沒有這一份就是空的
  box.appendChild(trOvCurve(z));
  box.appendChild(trOvEvents(r, z));
  trEvListFocus(box);
  if (trIsPaper()) box.appendChild(trEl("div", "pf-foot", t("cx.perfNote")));
}
function trStatCell(label, value, cls, sub, tip) {
  const c = trEl("div", "stat" + (cls.hero ? " hero" : " wide"));
  const sl = trEl("div", "sl" + (tip ? " sl-tip" : ""));
  if (tip) sl.appendChild(trTipLabel("", label, tip)); else sl.textContent = label;
  c.appendChild(sl);
  // 四捨五入後是 0 就寫「0.00」、不帶號不上色(模擬帳戶的手續費很容易出現紅色的「-0.00」)
  // TWD 帳戶整數(同資產分頁 trTwd;設計稽核 desktop-10-08 #1),其他幣兩位
  const twd = trUnit() === TR_TXF_CCY, zero = typeof value === "number" && (twd ? Math.round(value) === 0 : Math.round(value * 100) === 0);
  const s = twd ? (typeof value === "number" && isFinite(value) ? (cls.signed && !zero && value > 0 ? "+" : "") + trTwd(zero ? 0 : value) : null)
    : cls.signed ? trFmt2(zero ? 0 : value, !zero) : trFmt2(value);
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
function trOvCurve(z) {
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
  /* 資金異動(換綁一個所)前後常差好幾個數量級,擠同一個 Y 軸後段會被壓成平線(Wei 0.1.28):雲端權益也只畫最後一段。
     這台電腦的口徑換過照舊兩段並畫(basisNote 講的就是前後兩段) */
  const flow = Array.isArray(TR.ov.curve.anomalies) && cut > 0;
  const pts = srv ? srv.pts : isPnl || flow ? all.slice(cut) : all;
  if (z && pts.length < 2 && all.length < 2 && ((trPnlServerPoints() || {}).pts || []).length < 2) return document.createDocumentFragment();   // 另一個模式畫得出來就照舊(切換鈕要留著)
  if (pts.length < 2) {
    // 剛換綁、新段只有一筆:一行講清楚前面的線為什麼不見了(不疊 emptyBaseline + flowNote 兩行)
    if (flow && !isPnl) { const st = trEl("div", "pf-state"); st.appendChild(trTipLabel("", t("tr.ov.flowWait"), t("tr.ov.flowTip"))); frag.appendChild(st); return frag; }
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
  if (flow && !isPnl) { const ft = trEl("div", "pf-foot"); ft.appendChild(trTipLabel("", t("tr.ov.flowNote"), t("tr.ov.flowTip"))); frag.appendChild(ft); }
  else if (cut > 0 && !isPnl) frag.appendChild(trEl("div", "pf-foot", t("tr.ov.basisNote")));
  if (srv && srv.anom) frag.appendChild(trEl("div", "pf-foot", t("tr.ov.pnlAnom")));   // 平台那條:異動點的跳變已剔除,講一句
  requestAnimationFrame(() => trDrawCurve(canvas, series, isPnl));
  const onTheme = () => { if (!canvas.isConnected) { window.removeEventListener("blave:theme", onTheme); return; } trDrawCurve(canvas, series, isPnl); };
  if (typeof window !== "undefined" && window.addEventListener) window.addEventListener("blave:theme", onTheme);
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
    ctx.strokeStyle = trToken("--border-frame"); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(Math.round(px) + 0.5, g.padT); ctx.lineTo(Math.round(px) + 0.5, g.padT + g.ih); ctx.stroke();
    ctx.fillStyle = trToken(isPnl ? (p.v >= 0 ? "--color-greenText" : "--color-redText") : "--color-data-1");   // 點色跟線段同色
    ctx.beginPath(); ctx.arc(px, py, 3, 0, Math.PI * 2); ctx.fill();
    tipD.textContent = trStamp(p.t); tipV.textContent = trWithUnit(trFmt2(p.v, isPnl));
    // 權益模式第三行:相對「同一個 basis 段」的起點(跨過斷點相減等於把入金算成獲利;沒有斷點時就是區間起點)
    let s = bi; while (s > 0 && series[s - 1].b === p.b) s--;
    tipS.hidden = isPnl; tipS.textContent = isPnl ? "" : trWithUnit(trFmt2(p.v - series[s].v, true)) + " " + t(flow ? "tr.ov.vsSeg" : s > 0 ? "tr.ov.vsBasis" : "tr.ov.vsStart");   // 資金異動 / 這台電腦口徑換過 / 沒斷點
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
/* 事件級別,鏡射 api agent_events.SPECS + level_for(halt 看 source、主機重開看 trigger),同網頁 ovEvLevel;
   不在表裡的當 P3。之後 api 每筆帶級別時改讀那個欄位。標題顏色只看它:1 紅、2 強調、3 一般字 */
const TR_EV_P1 = ["order_error", "manual_close_required", "execution_interrupted", "execution_fallback_market", "execution_stuck",
  "market_hold", "settings_unsafe", "machine_restart_stop_failed", "downtime_paused"];
const TR_EV_P2 = ["reconciler_dead", "venue_disconnected", "strategy_failed", "bar_stale", "target_stale", "dead_members", "scheduler_error",
  "venue_unbound", "market_check_off", "ui_override", "settings_rollback_failed", "report_degraded", "exchange_unreachable",
  "machine_silent", "disk_full", "memory_low", "report_rejected"];
function trEvLevel(type, d) {
  d = d || {};
  if (type === "halt" || type === "halt_close") return d.source === "reconciler" || d.source === "portfolio" ? 1 : 3;
  if (type === "machine_restart_stopped") return d.trigger === "resume" ? 2 : d.trigger === "upgrade" ? 3 : 1;
  return TR_EV_P1.includes(type) ? 1 : TR_EV_P2.includes(type) ? 2 : 3;
}
const trEvClass = (lv) => (lv === 1 ? "err" : lv === 2 ? "hl" : "");
// 說明要帶的值缺一個就整句不出(同網頁 evNote):半句「已經 分鐘沒有回報」比沒有更糟
function trEvNote(key, vars) {
  const s = t(key), need = s.match(/\{[a-z_]+\}/g) || [];
  if (need.some((p) => { const x = (vars || {})[p.slice(1, -1)]; return x == null || x === ""; })) return null;
  return t(key, vars);
}
const trEvNum = (x) => (typeof x === "number" && isFinite(x) ? String(Math.round(x * 100) / 100) : null);
/* 機器／平台事件 → [標題, 後果註解, 級別, 註解的 tooltip]。白名單:不認得的型別回 null 不畫。desktop_action(用戶自己按的指令回音)
   整類不畫(Wei 10-20,designer events-list-audit-2026-10-20);bar_stale 帶 computed=true 時訊號已準時算出,不畫 */
function trEventText(type, d) {
  const v = { venue: trVenueLabel(String(d.venue || ""), true), minutes: d.minutes };
  const lv = trEvLevel(type, d), str = (x) => (typeof x === "string" ? x : "");
  const out = (head, note, tip) => [head, note == null ? null : note, lv, tip || null];
  if (type === "exchange_unreachable") return out(t("tr.ov.evExUnreach", v), t("tr.ov.evExUnreachNote"), t("tr.ov.evExUnreachTip"));
  if (type === "exchange_recovered") return out(t("tr.ov.evExBack", v), null);
  if (type === "bar_stale") return d.computed === true ? null : out(t("tr.ov.evBarStale"), d.minutes == null ? null : t("tr.ov.evBarStaleNote", v));
  // 目標部位過久沒更新(同網頁 workspace_ov_ev_target_stale):換算門檻同 api notify._age_text;沒 age_s 用不帶時間那句
  if (type === "target_stale") {
    const s = d.age_s, m = typeof s === "number" && isFinite(s) && s >= 0 ? Math.floor(s / 60) : null, h = m == null ? 0 : Math.floor(m / 60);
    const name = str(d.strategy);
    return out(t("tr.ov.evTargetStale") + (name ? " · " + name : ""),
      m == null ? t("tr.ov.evTargetStaleNote") : m < 120 ? t("tr.ov.evTargetStaleMin", { n: m }) : h < 48 ? t("tr.ov.evTargetStaleHour", { n: h }) : t("tr.ov.evTargetStaleDay", { n: Math.floor(h / 24) }));
  }
  // 成分股停止更新:列前 10 檔,其餘「等 N 檔」——{total}/{more} 兩個都給,語系自己挑
  if (type === "dead_members") {
    const syms = (Array.isArray(d.symbols) ? d.symbols : []).filter((x) => typeof x === "string" && x).map((x) => x.replace(/@spot$/, ""));
    const list = syms.slice(0, 10).join(", ") + (syms.length > 10 ? " " + t("tr.ov.evDeadMore", { total: syms.length, more: syms.length - 10 }) : "");
    return out(t("tr.ov.evDeadMembers") + (list ? " · " + list : ""), t("tr.ov.evDeadMembersNote"));
  }
  if (type === "execution_fallback_market") return out(t("tr.ov.evExecFallback"), t("tr.ov.evExecFallbackNote"));
  if (type === "execution_interrupted") return out(t("tr.ov.evExecInterrupted"), t("tr.ov.evExecInterruptedNote"));
  // kind 只有 overdue/abandoned;認不得的照樣是通用句(同網頁)
  if (type === "execution_stuck") return d.kind === "abandoned" ? out(t("tr.ov.evExecAbandoned"), t("tr.ov.evExecAbandonedNote"))
    : out(t(d.kind === "overdue" ? "tr.ov.evExecOverdue" : "tr.ov.evExecStuck"), t("tr.ov.evExecStuckNote"));
  if (type === "scheduler_error") return out(t("tr.ov.evSchedErr"), t("tr.ov.evSchedErrNote"));
  if (type === "strategy_failed") return out(t("tr.ov.evStrategyFailed"), t("tr.ov.evStrategyFailedNote"));
  // 主機重開、對帳那支程式停著:標題已暫停,說明講「什麼單都不下」——跟 HALT 那列(平倉停損照常)並排時要分得出來;顏色跟 trigger
  if (type === "machine_restart_stopped") return out(t("tr.ov.evRestartStopped"), t("tr.ov.evRestartStoppedNote"));
  if (type === "machine_restart_stop_failed") return out(t("tr.ov.evRestartStopFailed"), t("tr.ov.evRestartStopFailedNote"));
  // 群益部位要人手動平:symbols 是逗號分隔的帳本 key,讀不到快照時是空字串 → 只講那一句、不帶標的
  if (type === "manual_close_required") {
    const syms = String(d.symbols || "").split(",").map((x) => x.trim()).filter(Boolean).join(", ");
    return out(t("tr.ov.evManualClose") + (syms ? " · " + syms : ""), t("tr.ov.evManualCloseNote"));
  }
  if (type === "downtime_paused") return out(t("tr.ov.evHaltAuto"), t("tr.ov.evDowntimeNote"));   // 不是 HALT:連平倉都凍結,不能用 evHaltNote 那句
  // 以下同網頁 ovEventRow(網頁原本就有、電腦版補上的 8 種,加稽核補畫的 5 種)
  if (type === "reconciler_dead") return out(t("tr.ov.evRecDead"), null);
  if (type === "reconciler_recovered") return out(t("tr.ov.evRecBack"), null);
  if (type === "venue_unbound") return out(t("tr.ov.evVenueUnbound", v), t("tr.ov.evVenueUnboundNote"));
  if (type === "ui_override") return out(t("tr.ov.evUiOverride"), t("tr.ov.evUiOverrideNote"));
  if (type === "machine_silent") return out(t("tr.ov.evMachineSilent"), trEvNote("tr.ov.evMachineSilentNote", { minutes: trEvNum(d.minutes) }));
  if (type === "machine_recovered") return out(t("tr.ov.evMachineBack"), null);
  if (type === "disk_full") { const p = trEvNum(d.disk_pct); return out(t("tr.ov.evDiskFull"), trEvNote("tr.ov.evDiskFullNote", { disk_pct: p && p + "%" })); }
  if (type === "memory_low") {
    const a = trEvNum(d.mem_avail_mb), tot = trEvNum(d.mem_total_mb);
    return out(t("tr.ov.evMemLow"), trEvNote("tr.ov.evMemLowNote", { mem_avail: a && a + "MB", mem_total: tot && tot + "MB" }));
  }
  if (type === "report_rejected" || type === "report_degraded") {
    const rej = type === "report_rejected", full = str(d.title) || (rej ? str(d.report_id) : ""), chars = Array.from(full);
    const title = chars.length > 40 ? chars.slice(0, 40).join("") + "…" : full;
    const key = rej ? "tr.ov.evReportRejected" : "tr.ov.evReportDegraded";
    const head = full ? t(key, { title }) : t(key).replace(/\s?[「“]\{title\}[」”]/, "");   // 標題全空時連引號一起拿掉
    if (rej) return out(head, trEvNote("tr.ov.evReportRejectedNote", { field: str(d.field) || null }));
    const n = typeof d.count === "number" && isFinite(d.count) && d.count >= 1 ? Math.floor(d.count) : null;
    return out(head, n == null ? t("tr.ov.evReportDegradedNoteNoCount") : t("tr.ov.evReportDegradedNote", { count: n }));
  }
  if (type === "market_hold") { const name = str(d.strategy); return out(t("tr.ov.evMarketHold") + (name ? " · " + name : ""), t("tr.ov.evMarketHoldNote")); }
  if (type === "settings_unsafe") return out(t("tr.ov.evSettingsUnsafe"), t("tr.ov.evSettingsUnsafeNote"));
  if (type === "settings_rollback_failed") return out(t("tr.ov.evSettingsRollbackFailed"), t("tr.ov.evSettingsRollbackFailedNote"));
  if (type === "market_check_off") return out(t("tr.ov.evMarketCheckOff"), t("tr.ov.evMarketCheckOffNote"));
  return null;
}
// 一列事件的內容:標題(級別色)→ api 合併同因時的 ×N → 「— 說明」(說明的 tooltip 掛 title)
function trEvBody(body, head, note, lv, tip, count) {
  body.appendChild(trEl("span", trEvClass(lv), head));
  if (typeof count === "number" && isFinite(count) && count >= 2) body.append(" ", trEl("span", "mono", "×" + Math.floor(count)));
  if (note) { const n = trEl("span", "dim", "— " + note); if (tip) n.title = tip; body.append(" ", n); }
}
/* 事件 = 狀態改變或要人看的事;成交不是事件(spec-0.1.19 §1.1)——買進／賣出列只在交易歷史分頁,
   這裡標題列右側數同一區間的成交筆數帶路過去。0 筆整行不出 */
function trOvFills(r, from) {
  const n = trOrdersShown(r).filter((o) => { const ms = trMs(o.ts); return ms != null && ms >= from; }).length;
  if (!n) return null;
  const acts = trEl("div", "pf-acts ev-fills"), cnt = trEl("span", "");
  const parts = t(n === 1 ? "tr.ov.evFillsOne" : "tr.ov.evFills").split("{n}");   // 數字單獨一個 .mono,字串自己決定數字落在哪
  cnt.append(parts[0], trEl("span", "mono", String(n)), parts.slice(1).join("{n}"));
  const go = trEl("button", "btn-quiet", t("tr.ov.evFillsLink")); go.type = "button";
  go.addEventListener("click", () => trSetTab("hist", true));
  acts.append(cnt, go); return acts;
}
function trOvEvents(r, z) {
  const frag = document.createDocumentFragment(), label = trEl("span", "label", t("tr.ov.events")); label.id = "tr-ev-label";
  const from = Date.now() - TR.ov.days * 86400000, rows = [];
  frag.appendChild(trSec(label, trOvFills(r, from)));
  const push = (ms, build) => { if (ms != null && ms >= from) rows.push({ ms, build }); };
  /* 這台電腦:從這個 app 的畫面做的動作(宿主在指令 ack 成功時記的;聊天裡做的不會有)。
     雲端:平台的事件流(/cloud/events),欄位包在 data 裡、型別也多得多——認不得的型別不畫(沒有文案就是一行代號)。
     有了它,「已暫停下單」那一列在恢復之後不會消失,也才有「已恢復下單 / 已連接 / 已解除」。 */
  // 照時間排:「啟動」還是「恢復」看前一筆暫停／啟動是哪一個(稽核 0127b1 P1-6)
  const ui = (Array.isArray(TR.ov.ui) ? TR.ov.ui : []).slice().sort((a, b) => ((a && a.ts) || 0) - ((b && b.ts) || 0)), uiHalts = [];
  // 主機重開後停住(machine_restart_stopped)也是暫停(那一列寫「已暫停下單」,同網頁):機器事件在 r.events,不在 ui 裡,照時間插進來只拿來判前一筆
  const stops = (Array.isArray(r.events) ? r.events : []).filter((ev) => ev && ev.type === "machine_restart_stopped").map((ev) => ({ ms: trMs(ev.ts), stop: true })).filter((x) => x.ms != null);
  const seq = ui.filter((ev) => ev && typeof ev.ts === "number").map((ev) => ({ ms: ev.ts * 1000, ev })).concat(stops).sort((a, b) => a.ms - b.ms);
  let lastRun = null;
  seq.forEach(({ ev, stop }) => {
    if (stop) { lastRun = "halt"; return; }
    if (!ev || typeof ev.ts !== "number" || typeof ev.type !== "string") return;
    const d = ev.data && typeof ev.data === "object" ? ev.data : ev;   // 平台格式的欄位在 data;這台電腦那一份直接放最外層
    const venue = trVenueLabel(String(d.venue || ""), true);
    let head = null, note = null, lv = 3, tip = null;
    // 誰按的看 source(鏡射平台的 _HALT_AUTO_SOURCES);這台電腦記的那一筆沒有 source = 人按的
    if (ev.type === "halt" || ev.type === "halt_close") { lv = trEvLevel(ev.type, d); head = t(lv === 1 ? "tr.ov.evHaltAuto" : "tr.ov.evHalt"); note = trHaltStopsAll(d) || trHaltFreeze(r) ? t("tr.ov.evRestartStoppedNote") : t("tr.ov.evHaltNote"); uiHalts.push(ev.ts * 1000); lastRun = "halt"; }
    // 前一筆是暫停才叫「恢復」;第一次啟動(或之前的暫停不在紀錄裡,例如對帳器自動暫停)寫「已啟動下單」。標題已經講完,不帶說明
    else if (ev.type === "resume" || ev.type === "resume_wait") { head = t(lastRun === "halt" ? "tr.ov.evResume" : "tr.ov.evStart"); lastRun = "resume"; }
    else if (ev.type === "venue_connected" && venue) head = t("tr.ov.evConnected", { venue });
    else if (ev.type === "machine_restart_stopped") { const txt = trEventText(ev.type, d); if (txt) [head, note, lv, tip] = txt; lastRun = "halt"; }
    // 雲端格式(欄位在 data)才是平台記的「被解除」(P2);這台電腦記的那筆是用戶自己按的,一般字
    else if (ev.type === "venue_disconnected" && venue) { head = t("tr.ov.evDisconnected", { venue }); lv = d !== ev ? 2 : 3; }
    else { const txt = trEventText(ev.type, d); if (txt) [head, note, lv, tip] = txt; }   // 雲端才有的型別(交易所連不上…);desktop_action 回 null 不畫
    if (!head) return;
    push(ev.ts * 1000, (body) => trEvBody(body, head, note, lv, tip, ev.count));
  });
  // 目前的 HALT(狀態檔的現況):畫面上按的那一次已經在上面了,兩分鐘內的同一件事不重複列;自動暫停、聊天裡的暫停只有這裡看得到
  const halt = r.halt || {}, haltMs = trMs(halt.at);
  if (halt.halted && !uiHalts.some((x) => haltMs != null && Math.abs(x - haltMs) < 120000)) push(haltMs, (body) => {
    // 顏色照級別(execute / settings 的暫停由 execution_interrupted / settings_unsafe 那列當 P1,這列不再紅一次);字照舊
    const auto = !!halt.source && halt.source !== "web";
    body.appendChild(trEl("span", trEvClass(trEvLevel("halt", halt)), auto ? t("tr.ov.evHaltAuto") : t("tr.ov.evHalt")));
    body.append(" ", trEl("span", "dim", "— " + (trHaltStopsAll(halt) ? t("tr.ov.evRestartStoppedNote") : t("tr.ov.evHaltNote"))));   // A′:什麼單都不下,同重開那一句
  });
  (Array.isArray(r.order_errors) ? r.order_errors : []).forEach((e) => {
    if (!e || typeof e !== "object") return;
    push(trMs(e.ts), (body) => {
      body.appendChild(trEl("span", "err", t("tr.ov.evErr")));
      const sym = String(e.symbol || "").replace(/@spot$/, ""), raw = String(e.error || e.message || ""), twn = trTwName(sym), tw = trTwNameEl(sym);
      if (trOrderErrParse(raw)) body.append(" ", trEl("span", "dim", "— " + trOrderErrText(twn ? sym + " " + twn : sym, raw)));   // 認得的原因:整句在地化(句子自己帶標的;台股帶名字)
      else { body.append(" ", trEl("span", "mono", sym)); if (tw) body.appendChild(tw); body.append(" ", trEl("span", "dim", "— " + raw.slice(0, 160))); }
    });
  });
  (Array.isArray(r.events) ? r.events : []).forEach((ev) => {
    if (!ev || typeof ev.type !== "string") return;
    const evd = ev.payload && typeof ev.payload === "object" ? ev.payload : ev.data && typeof ev.data === "object" ? ev.data : ev;   // 機器事件的欄位叫 payload(runtime/events.py);data 是平台格式
    const txt = trEventText(ev.type, evd);
    if (!txt) return;
    push(trMs(ev.ts), (body) => trEvBody(body, txt[0], txt[1], txt[2], txt[3], ev.count));
  });
  /* 讀不到就說讀不到:絕不可以把「這一輪沒讀到」畫成「這段期間沒有事件」(同權益曲線的先例——讀不到就不畫,不斷言)。
     報告裡的那幾種(下單、現在的 HALT、下單失敗)是另一個來源,讀得到就照列,所以這一句是加在清單上面、不取代清單。 */
  if (TR.ov.uiErr) frag.appendChild(trEl("div", "pf-state", t("tr.ov.evUnreach")));
  if (!rows.length && z && !TR.ov.uiErr) return document.createDocumentFragment();
  if (!rows.length) { if (!TR.ov.uiErr) frag.appendChild(trEl("div", "pf-state", t("tr.ov.evEmpty"))); return frag; }
  rows.sort((a, b) => b.ms - a.ms);
  // 240px 的捲動容器;一天一組 .ev-group,日期標 sticky 只釘在自己那組的範圍內(trade.css)。tabindex 由 trEvListFocus 在畫完後決定
  const list = trEl("div", "ev-list"); list.setAttribute("role", "region"); list.setAttribute("aria-labelledby", "tr-ev-label"); frag.appendChild(list);
  const today = new Date().toDateString(), yest = new Date(Date.now() - 86400000).toDateString();
  let curKey = null, group = null;
  rows.slice(0, 200).forEach((x) => {
    const d = new Date(x.ms), key = d.toDateString();
    if (key !== curKey) {
      curKey = key; group = trEl("div", "ev-group"); list.appendChild(group);
      const head = trEl("div", "ev-day"), human = key === today ? t("tr.ov.today") : key === yest ? t("tr.ov.yesterday") : null;
      if (human) head.append(human + " · ");
      head.appendChild(trEl("span", "mono", trMD(d)));
      group.appendChild(head);
    }
    const row = trEl("div", "ev-row"), body = trEl("span", "body");
    row.append(trEl("span", "ts mono", trHM(x.ms)), body); x.build(body);
    group.appendChild(row);
  });
  return frag;
}
// 清單真的溢出才是一個 tab 停留點;不溢出的清單不該被 Tab 停到(spec-0.1.19 §1.3)
function trEvListFocus(box) {
  const list = box.querySelector(".ev-list"); if (!list) return;
  if (list.scrollHeight > list.clientHeight) list.tabIndex = 0; else list.removeAttribute("tabindex");
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
   NO_CHECK = 這台的 lib 還沒有那一家的帳戶讀取器(更新之前);LIB_BROKEN = 那支 lib 在、但載入失敗(這台電腦的程式壞了,
   不歸咎交易所,叫人回報) */
function cxChkTextVenue(r) {
  const c = r && r.code, name = trVenueLabel(CXF.venue, true), d = (r && r.detail) || {};
  if (c === "BAD_KEY_FORMAT") return t("cx.chk.keyFormatV", { venue: name });
  if (c === "INCOMPLETE_PAIR") return CX_VENUES[CXF.venue] && CX_VENUES[CXF.venue].pass ? t("cx.chk.incompletePass") : t("cx.chk.incomplete");
  if (c === "REJECTED") return trErrToken(d.reason) === "okx_account_mode" ? t("cx.err.okxMode") : t("cx.chk.rejectedV", { venue: name, reason: String(d.reason || "—").slice(0, 200) });
  if (c === "UNKNOWN") return t("cx.chk.unknownV", { venue: name });
  if (c === "NO_CHECK") return t("cx.chk.noCheckV", { venue: name });
  if (c === "LIB_BROKEN") return t("cx.chk.libBrokenV", { venue: name, reason: String(d.reason || "—").slice(0, 200) });
  return null;
}
function cxChkText(r) {
  const c = r && r.code;
  // 雲端的 REJECTED 是**主機**拒絕這個指令(例如主機的 runtime 太舊、還不認得這家),帶的是 detail.error,不是交易所拒絕金鑰:
  // 不走 cxChkTextVenue 那句「{venue} 沒有接受這把金鑰：{reason}」(那條只有本機才有 reason,雲端會永遠是「：—」,設計稽核 005 第 2 條)
  if (CXF.venue !== BINANCE && CXF.venue !== PAPER && !(CXF.env === "cloud" && c === "REJECTED")) { const v = cxChkTextVenue(r); if (v) return v; }
  if (CXF.env === "cloud") return cxChkTextCloud(r);
  return c === "TRADING_DISABLED" ? (CXF.ip ? t("cx.chk.trading") : t("cx.chk.tradingNoIp"))
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
/* 雲端連接的結果 → 那一句(spec-desktop-cloud-s5 §4)。
   本機那組寫死「這台電腦」的(時間、網路、限速)另寫雲端版;「上面這個 IP」在雲端就是主機的 IP,沿用。 */
function cxChkTextCloud(r) {
  const c = r && r.code, d = (r && r.detail) || {};
  return c === "TRADING_DISABLED" ? (cxCloudIp() ? t("cx.chk.trading") : t("cx.chk.tradingNoIp"))
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
  // (雲端的開通在網頁;設計稿 §5 電腦版雲端視角 v1 不做)。Mac 也列統一,選了講一句(d-mac)。統一那一項受 PRES_LOCAL_ON 管
  if (CXF.env !== "local" || cxPresListed()) { const g2 = document.createElement("optgroup"); g2.label = t("cap.group.tw");
    const o2 = trEl("option", "", CXF.env === "local" ? t("pres.venue") : t("cap.venue")); o2.value = CXF.env === "local" ? "president" : CAPITAL; g2.appendChild(o2);
    sel.appendChild(g2); }
  sel.value = CXF.venue; sel.disabled = !!L.cx.busy || (CXF.venue === CAPITAL && typeof CAP !== "undefined" && CAP.busy);
  sel.addEventListener("change", () => {
    CXF.venue = cxVenuesFor(CXF.env).indexOf(sel.value) >= 0 || (sel.value === CAPITAL && CXF.env === "cloud") || (sel.value === "president" && CXF.env === "local" && cxPresListed()) ? sel.value : PAPER;
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
   殼同 cx 框(.scrim > .set-modal);兩個視角共用,雲端視角 head 灰底 + 「雲端」記號;「確定」不寫主機(0.1.26 起只改草稿),所以沒有目的地行——目的地寫在儲存的確認框。
   候選集合在開框時算一次,框開著不隨輪詢重建(打勾到一半被洗掉比名單慢幾秒更糟)。
   Esc 與 Tab 圈都在這裡自己接(app.js 的 escTop / trapTab 不動):escTop 沒認得這個框時回 null、不會 preventDefault,
   這裡就補上;它先關了別層(defaultPrevented)這裡就不再關第二層。 */
// 同一個框兩種用途:配置(勾選改表上的草稿,儲存才寫 amounts)與優化(只改優化自己的清單,portfolio.js)。psToAmt = 從自動下單頁的導引開的(spec-autotrade-empty §4)
let psOpener = null, psMode = "amounts", psToAmt = false;
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
// 名字前的旗標色塊(.ps-flag)每列都有、沒旗標就空著(名字才對得齊);色跟側欄同一條 [data-flag] → --flag。色不是唯一管道:有旗標的勾選框 accessible name 同側欄(side.flagAria)
function psRow(r, cloud, i) {
  const row = trEl("label", "ps-row" + (r.locked ? " is-locked" : "")), cb = trEl("input", "ps-cb"), fg = trEl("span", "ps-flag");
  cb.type = "checkbox"; cb.value = r.name; cb.checked = r.checked; cb.disabled = r.locked; fg.setAttribute("aria-hidden", "true");
  if (r.flag) { row.dataset.flag = String(r.flag); if (typeof SF_COLORS !== "undefined") cb.setAttribute("aria-label", t("side.flagAria", { name: r.display, color: t(SF_COLORS[r.flag]) })); }
  const nm = trEl("span", "ps-name", r.display);
  if (r.live) { const d = trEl("span", "run-dot live"); d.setAttribute("aria-hidden", "true"); nm.insertBefore(d, nm.firstChild); }   // 正在配置裡跑:同側欄那顆呼吸點、同一個判定
  if (r.gone) nm.appendChild(trEl("span", "ps-gone", t("tr.pick.gone")));
  let note = null;
  if (r.note === "twd" || r.note === "twdKeep") note = nm.appendChild(trEl("span", "ps-note", r.note === "twd" ? t("tr.pick.twd") : t("tr.pick.twdKeep")));
  else if (r.note === "txf" || r.note === "txfKeep") note = nm.appendChild(trEl("span", "ps-note", t(r.note === "txf" ? "tr.pick.txf" : "tr.pick.txfKeep", { venue: trTwVenueName(trVenueId()) })));
  else if (r.locked) note = nm.appendChild(trEl("span", "ps-note", cloud ? t("tr.typeCHost") : t("tr.typeC")));
  if (note) { note.id = "ps-why-" + i; note.setAttribute("aria-hidden", "true"); cb.setAttribute("aria-describedby", note.id); }
  row.append(cb, fg, nm); return row;
}
function psOpen(opener, mode) {
  const S = TR, mg = mode === "mg";
  if (S !== TR_BAGS[ENV.cur] || !$("ps-scrim").hidden || (!mg && trPickOff())) return;
  psMode = mg ? "mg" : "amounts";
  if (!mg) trackFeature("strategy_picker");
  const cloud = S.env === "cloud", names = mg ? mgMembers() : trNames(), prefs = trPickPrefs(S, typeof SF !== "undefined" ? SF : null);
  // 優化只是試算、不下單:下單才有的鎖(模擬交易的台幣標的、統一只下台指期、舊 lib 的投資組合)不套
  const rows = mg ? trPickRows(typeof sfApplyOrder === "function" ? sfApplyOrder(S.list, prefs.order) : S.list, names, true, false, false, prefs.flags)
    : trPickRows(typeof sfApplyOrder === "function" ? sfApplyOrder(S.list, prefs.order) : S.list, names, (trReport() || {}).can_trade_portfolio === true, trVenueId() === PAPER && !trPaperTwOk(), trTwBroker(trVenueId()), prefs.flags);   // 台灣期貨券商(統一、群益)只下台指期:非台指期的列鎖住,已勾的可以取消
  const dotsUp = envDotsUp(S.env, S.st), now = Date.now();
  rows.forEach((r) => { r.live = dotsUp && envRunDot(r.name, S.st, now, S.just); });
  psOpener = opener || null;
  $("ps-modal").querySelector(".modal-head").classList.toggle("cloud", cloud);
  $("ps-env").hidden = !cloud; $("ps-env").textContent = cloud ? t("env.cloud") : "";
  const list = $("ps-list"); list.textContent = "";
  if (!rows.length) list.appendChild(trEl("div", "pf-state", t("tr.pick.empty")));
  else rows.forEach((r, i) => list.appendChild(psRow(r, cloud, i)));
  // 統一而且每一列都被「只下台指期」鎖住(post-connect-flow 第 9 列):清單底下一行出口,到策略庫(有官方的台指期策略)
  if (!mg && rows.length && rows.every((r) => r.note === "txf")) {
    const p = trEl("p", "ps-next", t("tr.pick.noTxf") + " "), b = trEl("button", "btn-quiet", t("lib.nav")); b.type = "button"; b.dataset.fk = "pick-notxf";
    b.addEventListener("click", () => { psClose(); if (typeof libOpen === "function") libOpen(); });
    p.appendChild(b); list.appendChild(p);
  }
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
  const o = psOpener; psOpener = null; psToAmt = false;
  if (o && o.isConnected && !o.disabled) o.focus(); else psRefocus();
}
// 確定之後表重畫、開框那顆鈕已經是新的一顆:焦點落回它;沒有(讀不到設定那一態鈕停用)就退到分頁鈕,不能掉到 BODY
function psRefocus() { const b = $("tr-pick"); if (b && b.isConnected && !b.disabled && b.offsetParent) b.focus(); else $("po-h").focus(); }
/* 「確定」(picker §6;0.1.26 Wei 改成草稿):勾的集合成為 picked、表只列這些,什麼都不送——加入與移出(金額 0 也一樣)
   都等「儲存」連金額一起寫(trSaveAmounts,同一份原子寫入);呼吸點、主機排程與總訊號部位都只看已存的那一份,所以存之前不會動。還原把 picked 丟掉 */
function psApply() {
  const S = TR;
  const sel = new Set([...$("ps-list").querySelectorAll(".ps-cb")].filter((c) => c.checked).map((c) => c.value));
  const refocus = psToAmt ? trFocusFirstAmt : psRefocus;
  if (psMode === "mg") { psOpener = null; psClose(); mgSetMembers(S, [...sel]); return; }   // 只改優化分頁自己的清單,不送任何指令
  psClose();
  const mine = () => TR === S && S.open && S.view === "po";
  // 框開著期間報告變成 config: null / 讀不到設定:底稿已不可信,不記草稿(儲存列那句由 trAmountTable 講)
  let added = [];
  if (trStored() !== null && !trCfgUnread(trReport())) {
    added = trPickDiff(sel, trBase() || {}, []).added;
    S.picked = trSetEq(sel, trNamesOf(null)) ? null : sel;   // 跟已存的一模一樣 = 沒改:stored 照舊是真相
    if (S.save === "saved") { clearTimeout(S.saveTimer); S.save = null; }   // 「已儲存」那一行會蓋掉儲存列:又改了就收起來
  }
  S.sig.cfg = null;
  if (!mine()) return;
  poPaintCfg();
  // 新勾了:下一步是填金額,焦點落在第一支新列的金額格(同網頁;勾選順序 = 框裡的順序);沒有新勾的或那格停用就回〔選擇策略〕
  const inp = added.length ? [...$("po-cfg").querySelectorAll(".amt-in")].find((x) => x.dataset.amt === added[0]) : null;
  if (inp && !inp.disabled && inp.offsetParent) inp.focus(); else refocus();
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
function envCanSwitch() { return !ENV_COMPOSING && !$("view-ws").hidden && $("del-scrim").hidden && $("cx-scrim").hidden && $("ps-scrim").hidden && $("lb-scrim").hidden && $("ns-scrim").hidden && $("idea-scrim").hidden && $("rpn-scrim").hidden && $("shr-scrim").hidden && $("mgm-scrim").hidden && $("mgs-scrim").hidden; }   // 兩個表單 modal(新增策略 / 新增報告)開著也不切:送出時才讀視角,切了會送去另一台;分享框同理(公開的是開框那一袋的那一份)
function envSwitchGuarded(env) {
  if ((env !== "local" && env !== "cloud") || !envCanSwitch()) return false;
  envSwitch(env); return true;
}
function envSwitch(env, via) {
  if (env !== "local" && env !== "cloud") return;
  const head = () => { const h = !$("cv-empty").hidden ? $("cv-h") : !$("po").hidden ? $("po-h") : $("tr-h"); if (h && h.offsetParent) h.focus(); };
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
  const fromPane = from.view === "po" ? $(from.poTab === "opt" ? "po-opt" : "po-cfg") : from.tab ? $("tr-" + from.tab) : null;
  from.scroll = { list: list.scrollTop, tab: fromPane && !fromPane.hidden ? fromPane.scrollTop : 0 };
  // 焦點在面板裡的輸入框時 trShould 會跳過重畫(打到一半不能被輪詢洗掉)——切視角不是輪詢:先放掉焦點,
  // 不然另一邊的金額表(含輸入框、儲存列)會留在這一邊的標題底下(稽核 N4)
  const ae = document.activeElement; if (ae && ae.tagName === "INPUT" && ($("tr").contains(ae) || $("po").contains(ae))) ae.blur();
  const prev = ENV.cur;
  ENV.cur = env; TR = TR_BAGS[env]; TR.sig = {}; ENV.sig = {};
  document.documentElement.dataset.env = env;
  if (env === "cloud") { ENV.cloudDirty = true; TR.open = true; }
  envShowMain();
  trPaint(); trAlertShow();
  if (TR.open && TR.view !== "po" && TR.tab && !$("tr-tabs").hidden) trSetTab(TR.tab);   // 分頁列是共用的 DOM:底線與 tabindex 換成這一邊的
  // 策略報告是共用的 DOM,兩邊各自選中一支:頁首與程式碼換成這一邊的;圖若是在看另一邊時畫的(容器藏著、量不到寬)也重畫一次
  rpRepaint();
  // 對話裡插一條「切到 …」系統行(A′ 四層標示的 ③;只在對話有內容時,連續切只留最後一條)
  chatSwitched(prev, env);
  // 每邊各自的捲動位置(面板是共用的 DOM,剛重畫完)
  const to = $(env === "cloud" ? "strat-list-cloud" : "strat-list"); to.scrollTop = (TR.scroll && TR.scroll.list) || 0;
  const toPane = TR.view === "po" ? $(TR.poTab === "opt" ? "po-opt" : "po-cfg") : TR.tab ? $("tr-" + TR.tab) : null;
  if (TR.open && toPane && !toPane.hidden) toPane.scrollTop = (TR.scroll && TR.scroll.tab) || 0;
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
    const po = TR_BAGS.cloud.view === "po";
    $("rp").hidden = !rp; $("main-empty").hidden = true; $("tr").hidden = gate || rp || po; $("po").hidden = gate || rp || !po;
    envNavMark(rp ? null : po ? "po" : "tr");
    if (typeof libShowMain === "function") libShowMain(gate);   // 策略庫(第五個視圖)開著就蓋掉上面那幾個;開通頁開著時跟側欄入口一起收
    if (typeof rptShowMain === "function") rptShowMain(gate);   // 報告(第六個視圖;renderer/reports.js)同一條
    return;
  }
  const L = TR_BAGS.local, rp = !L.open && !!(RP.name && RP.data);
  $("rp").hidden = !rp;
  $("main-empty").hidden = L.open || rp;
  $("tr").hidden = !L.open || L.view === "po"; $("po").hidden = !L.open || L.view !== "po";
  envNavMark(!L.open ? null : L.view === "po" ? "po" : "tr");
  if (typeof libShowMain === "function") libShowMain(false);
  if (typeof rptShowMain === "function") rptShowMain(false);
}
// 側欄「策略組合」「自動下單」兩顆的選中態互斥(aria-current);null = 兩顆都沒選
function envNavMark(which) {
  [["po", "po-nav"], ["tr", "tr-nav"]].forEach(([k, id]) => { if (which === k) $(id).setAttribute("aria-current", "page"); else $(id).removeAttribute("aria-current"); });
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
    alt: { label: t("cdel.goPos"), onOk: () => poOpen("cfg") }, onOk: () => {} });
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
  const shown = all.filter((x) => !CDEL.gone.has(x.name));   // 已刪、清單還沒跟上的先不畫
  // 側欄偏好:web 工作頁設的順序與旗標(api /cloud/state 的 strat_order / strat_flags;cloud.js 清過)。這裡只讀:不給拖、不給掛(renderer/stratflags.js)
  const prefs = { order: st && st.cloud && Array.isArray(st.cloud.strat_order) ? st.cloud.strat_order : [], flags: st && st.cloud && st.cloud.strat_flags && typeof st.cloud.strat_flags === "object" ? st.cloud.strat_flags : {} };
  const list = typeof sfApplyOrder === "function" ? sfApplyOrder(shown, prefs.order) : shown;
  const ho = typeof HO !== "undefined" && HO.on && typeof hoCloudLive === "function" && hoCloudLive();
  // 列尾的刪除:機器停著 / 名字不合規 / 刪除中 → 不畫(跟 HO 旗標無關)。agent 回合中照畫、是鎖(busy.js),點了講原因
  const canDel = kind === "running";
  // 側欄**不放任何 handoff 提示**(Wei 看實機後拍板):等著送上來的那條回頭路住在中欄的「準備好了」卡(規格 §2)
  const sel = typeof RPC !== "undefined" ? RPC.name : null, dotsUp = envDotsUp("cloud", st);
  const sig = LANG + "|" + JSON.stringify([kind, ho, canDel, sel, [...CDEL.busy.keys()], prefs.flags, list.map((x) => [x.name, x.displayName, envStratWord(x.name, st), dotsUp && envRunDot(x.name, st, Date.now(), TR_BAGS.cloud.just)])]);
  if (ENV.sig.side === sig) return;
  ENV.sig.side = sig;
  // 點一支 → 中欄畫雲端那一份的報告(app.js 的 rpCloudSelect;資料走主行程的 cloudStrategy)。鈕不能包鈕,刪除鈕放在同一個 wrap 裡(同本機清單)
  const box = $("strat-list-cloud"); box.textContent = ""; box.removeAttribute("role");
  if (!list.length) { box.appendChild(trEl("p", "pf-state", ho ? t("ho.emptyHint") : t("side.cloud.emptyCut1"))); return; }
  list.forEach((x) => {
    const wrap = trEl("div", "strat-wrap cs-row"), row = trEl("button", "strat-row"); row.type = "button"; row.dataset.name = x.name; wrap.dataset.name = x.name;
    if (x.name === sel) row.setAttribute("aria-current", "true");
    const nm = trEl("span", "strat-name"); stratNameFill(nm, x.displayName); nm.title = typeof stratTip === "function" ? stratTip(x.displayName, x.name) : x.name; row.appendChild(nm);
    if (typeof sfFlagMeta === "function") sfFlagMeta(wrap, row, nm.title, prefs.flags[x.name]);
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
    if (canDel && !deleting && /^[A-Za-z0-9_-]{1,64}$/.test(x.name) && typeof armedDelete === "function") {
      const d = armedDelete(wrap, t("cdel.aria", { name: x.displayName || x.name }), (btn) => cdelAsk(x, btn), true);
      busyLock(d, busyOn()); d.onBusy = () => stratDelBusy(wrap); wrap.appendChild(d);
    }
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
  const sig = LANG + "|" + JSON.stringify([view, pid || null, v.p, v.h, v.y, planMo(), v.d, v.t, v.q, v.v, slow, err && err.key, planLoginBusy, cur]);
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
    // 扣款規則(存在就扣、停機照扣、刪除才停)不在這一頁:啟動確認框一定會經過、三句直接顯示,設定頁的底列(pv.f.*)也講(spec-0.1.10 §2.3)
    // 方案制:電腦版只開方案、主機到網站開——這一頁不印開通價(印了會被讀成按下去要付這筆);切換前照舊
    if (v.p && !planMo()) page.appendChild(planPriceEl(trEl, v));
  }
  // 鈕上方那一行:錯誤(方案頁同一組 plan.err.*)優先;否則這顆鈕會帶來的錢 / 好消息
  if (err) { const e = trEl("p", "plan-err" + (err.calm ? " is-calm" : "")); e.setAttribute("role", "status"); const m = trEl("span", "fault-mark"); m.setAttribute("aria-hidden", "true"); e.append(m, trEl("span", "", t(err.key))); page.appendChild(e); }
  else if (slow) { const e = trEl("p", "plan-err is-calm"); const m = trEl("span", "fault-mark"); m.setAttribute("aria-hidden", "true"); e.append(m, trEl("span", "", t("plan.err.slow"))); page.appendChild(e); }
  else if (view === "relogin") page.appendChild(trEl("p", "cv-above up", t("env.empty.relogin")));
  else if (view === "card") page.appendChild(trEl("p", "cv-above", planView() === "noTrial" ? t("pv.f.noTrial", v) : t("pv.f.offer", v)));
  else if (view === "start" && v.d) page.appendChild(trEl("p", "cv-above up", t("plan.trialFree", v)));
  const act = trEl("div", "cv-act"), more = () => btn("btn-quiet", t("env.open.more"), () => planOpen(), "more");
  const after = () => { ENV.sig.empty = null; ENV.cloudDirty = true; trPollSoon(0); };
  let main = null, side = null;
  if (err && err.key === "plan.err.relogin") main = btn("btn-fill", t("plan.relogin"), () => Promise.resolve(planRelogin()).then(after), "main");
  else if (err && (err.key === "plan.err.nocard" || err.key === "plan.err.nocard.m")) main = btn("btn-fill", t("plan.addCard"), () => bindGo("bind_cloud"), "main");
  else if (err && err.key === "plan.err.credit") main = btn("btn-fill", t("plan.addCredit"), () => bindGo("topup_cloud"), "main");
  else if (err && err.key === "plan.err.charge") { main = btn("btn-fill", t("plan.changeCard"), planWebGo, "main"); side = btn("btn-quiet", t("plan.addCredit"), () => bindGo("topup_cloud"), "more"); }
  else if (err && err.key === "plan.err.web") main = btn("btn-fill", t("plan.onWeb"), planWebGo, "main");
  // 主鈕的 data-k 照樣是 "main":登入前按的那顆也是 main,所以人回來時焦點正好落在它身上(下面那段依 data-k 還原焦點),按 Enter 就走
  else if (view === "ready") { main = btn("btn-fill", t("ho.back.btn"), () => hoBack(pid), "main"); side = btn("btn-quiet", t("ho.ready.stay"), () => { hoStay(); after(); }, "stay"); }
  else if (view === "out") { main = planLoginBusy ? btn("btn-out", t("oauth.cancel"), planLogin, "main") : btn("btn-fill", t("cn.blave.btn"), () => Promise.resolve(planLogin()).then(after), "main"); side = trEl("span", "wait", planLoginBusy ? t("pv.w.waiting") : t("pv.w.out.cli")); }
  else if (view === "relogin") main = btn("btn-fill", t("plan.relogin"), () => Promise.resolve(planRelogin()).then(after), "main");
  else if (view === "card") { main = btn("btn-fill", t("plan.addCard"), () => bindGo("bind_cloud"), "main"); side = more(); }
  // 方案制要雲端主機:到網站開(電腦版的開通只開方案、不建主機);切換前照舊在 app 內啟動
  else if (view === "start" && planMo()) { main = btn("btn-fill", t("plan.cloudWeb"), cloudWebGo, "main"); side = more(); }
  else if (view === "start") { main = btn("btn-fill", t("plan.start"), planAsk, "main"); main.disabled = !planPriceOk(v); side = more(); }
  else if (view === "repay") { main = btn("btn-fill", t("plan.repay"), planRepay, "main"); side = more(); }
  else if (view === "web") { main = btn("btn-fill", t("plan.cloudWeb"), cloudWebGo, "main"); side = more(); }
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
