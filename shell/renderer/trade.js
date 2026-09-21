/* 自動下單頁、設定 › 連線、常駐狀態帶(模擬交易版)。
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
const TR_UNDELIVERED = ["NOT_ALLOWED", "DAEMON_DOWN", "TIMEOUT", "TOO_LARGE", "WRITE_FAILED", "BAD_ARGS"];
function trErrorKind(error) {
  const e = error ? String(error) : "";
  if (e === "UNKNOWN_RESULT") return "unknown";
  return !e || TR_UNDELIVERED.indexOf(e) >= 0 ? "undelivered" : "rejected";
}
const TR_AMOUNT_MAX = 1e9;            // 同主行程 argsOk 的上限
const TR_HOST_RETRY_MS = 90 * 1000;   // 宿主退避重啟 2+4+8+16+30 秒 = 60 秒內會試完;超過還沒起來就是起不來
const TR_STALE_MS = 10 * 60 * 1000;   // 對帳快照超過這個年紀就不拿來當「實際」(同雲端 REPORT_STALE_MS 的用途)

// 已綁定的交易所 id:金鑰成對、下單與讀帳兩支 lib 都在(同雲端 pfHasAccount 的 venues 分支)。
// 宿主 daemon.js 的 liveAccount 判準比這寬(不看 pair / order)——它只決定「權益記在哪一家名下」;畫面以這裡為準。
function trVenueIds(r) {
  const v = (r && r.venues) || {};
  return Object.keys(v).filter((id) => v[id] && v[id].credentials && v[id].pair && v[id].order && v[id].account).sort();
}
// 帳戶讀取器對這家的最新結果;還沒讀過 = null(剛連上的那幾秒)
function trLiveEntry(r, id) {
  const a = r && r.account && r.account.venues;
  return (a && a[id]) || null;
}
// 讀過而且失敗的 = 串接失敗;還沒讀過的不算失敗
function trFailedIds(r) { return trVenueIds(r).filter((id) => { const e = trLiveEntry(r, id); return !!e && !e.ok; }); }
// 有沒有帳戶 = 有沒有綁定,不看這一輪讀帳成不成功(稽核 S5):交易所讀帳 API 暫時失敗時對帳器可能還在下單,
// 這時把整頁換成 onboard、把「暫停下單」拿掉,等於在最需要出口的時候拿走出口。讀帳失敗另外標在狀態行上。
function trHasAccount(r) { return trVenueIds(r).length > 0; }

/* 狀態字判定(雲端 pfExecState 的移植)。順序有意義:沒帳戶最先——對帳器本來就不該在跑,說它「死了」是假話。
   電腦版多三件事:狀態檔還沒寫出來 = loading;狀態檔這一輪 build 失敗(只有 error、沒有 venues)= unknown——
   不是「沒帳戶」,不能畫 onboard;常駐程式不在(st.alive 為 false)時狀態檔是舊的,裡面的「對帳器活著」不能信。 */
function trExecState(st) {
  const r = st && st.report;
  if (!r) return "loading";
  if (r.error || !r.venues || typeof r.venues !== "object") return "unknown";
  if (!trHasAccount(r)) return "noaccount";
  if (r.halt && r.halt.halted) return "halted";
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
   回 null(在跑,或從來沒起過=引擎還沒裝)/ "retry"(剛死,宿主還在試)/ "down"(試完了還是沒起來,只剩重開 Blave)。 */
function trHostDown(st, nowMs) {
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
/* 要送出去的 amounts。key 在不在 = 在不在組合裡(runtime 的 _cmd_amounts):
   金額 > 0 才新加入;已經在組合裡的就算改成 0 也要留著 key(0 = 收斂到空手,拿掉 key 反而會讓對帳器失去路由);
   策略已經不在這台電腦上的(names 裡沒有)= 移出組合——**但只有在策略清單真的載入過(loaded)才算數**(稽核 S4):
   清單還沒回來、或讀清單失敗時 names 是空的,那不是「策略都不見了」,已存的 key 原樣帶著,一個都不准移出。 */
function trAmountsToSend(names, stored, edits, loaded) {
  const cur = trCurrentAmounts(names, stored, edits), out = {};
  names.forEach((n) => { if (cur[n] > 0 || n in stored) out[n] = cur[n]; });
  if (!loaded) Object.keys(stored).forEach((n) => { if (!(n in out)) out[n] = stored[n]; });
  return out;
}
function trRemoved(stored, sending) { return Object.keys(stored).filter((n) => !(n in sending)); }
// 合計與「你淨值的幾倍」。沒有淨值就沒有倍數(不拿 0 去除)
function trTotals(amounts, equity) {
  let total = 0;
  Object.keys(amounts).forEach((n) => { total += amounts[n] || 0; });
  const mult = typeof equity === "number" && equity > 0 ? total / equity : null;
  return { total, mult };
}
function trDirty(names, stored, edits) { return names.some((n) => edits[n] != null && edits[n] !== (stored[n] || 0)); }
function trCanonSym(s) { return String(s || "").replace(/-/g, "").toUpperCase(); }
function trCanonKey(k) { k = String(k || ""); const spot = /@spot$/i.test(k); return trCanonSym(k.replace(/@spot$/i, "")) + (spot ? "@spot" : ""); }
function trSigned(p) {
  const size = p && typeof p.size === "number" ? p.size : 0;
  if (p && (p.side === "long" || p.side === "buy")) return size;
  if (p && (p.side === "short" || p.side === "sell")) return -size;
  return 0;
}
// 目標部位 = 已存金額 × 訊號,按標的加總(同機器端 aggregate;現貨不能做空,負的壓 0)
function trClientTargets(amounts, states) {
  const out = {};
  Object.keys(amounts || {}).forEach((n) => {
    const s = (states || {})[n];
    if (!s || !s.symbol) return;
    const pos = typeof s.position === "number" ? s.position : 0;
    const k = trCanonSym(s.symbol) + (s.market === "spot" ? "@spot" : "");
    out[k] = (out[k] || 0) + amounts[n] * pos;
  });
  Object.keys(out).forEach((k) => { if (/@spot$/.test(k) && out[k] < 0) out[k] = 0; });
  return out;
}
// 這一列現在走哪一側的門檻(雲端 pfGateSide):減倉腿 = |實際| > |目標|
function trGateSide(g, tgt, act) {
  if (!g) return null;
  if (typeof g.entry_usd === "number" && typeof g.reduce_usd === "number") {
    const reduce = Math.abs(act) > Math.abs(tgt);
    return { usd: reduce ? g.reduce_usd : g.entry_usd, reduce };
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
/* ── 純邏輯到此 ─────────────────────────────────────────────── */

/* ── 視角純邏輯(「這台電腦｜雲端」;tests/check_shell_envsw.js 從原文切出來跑,這一段不准碰 DOM / window)──────
   傳輸層:每個視角一份**同介面**的 api,自動下單頁換一個來源就能畫(雲端回的形狀跟本機 status() 相同)。
   雲端那份第一刀**唯讀**:tradeSend 在這一層就擋掉(回 NOT_ALLOWED,跟主行程拒絕同一個代碼),完全不碰 host 的 tradeSend——
   鈕的 aria-disabled 只是畫面,這裡才是「雲端視角下任何寫入指令都送不出去」的那道牆。權益曲線、畫面事件、單支策略的端點還沒做:回空的,
   **不可以**退回去打本機的(那會把這台電腦的數字畫在雲端那一頁)。 */
const ENV_API = ["tradeStatus", "listStrategies", "loadStrategy", "tradeEquity", "tradeEvents", "tradeSend"];
function envApi(env, host) {
  if (env !== "cloud") { const o = { env: "local" }; ENV_API.forEach((k) => { o[k] = (...a) => host[k](...a); }); return o; }
  let last = null;
  return {
    env: "cloud",
    tradeStatus: async () => { last = await host.cloudStatus(); return last; },
    listStrategies: async () => envCloudList(last),
    loadStrategy: async () => null,
    tradeEquity: async () => ({ curve: [] }),
    tradeEvents: async () => [],
    tradeSend: async () => ({ ok: false, error: "NOT_ALLOWED" }),
  };
}
// 雲端策略清單(strategies_summary)→ 跟本機 listStrategies 同形狀;標的與是不是投資組合直接帶著(沒有 loadStrategy 可問)
function envCloudList(st) {
  const a = st && st.cloud && Array.isArray(st.cloud.strategies) ? st.cloud.strategies : [];
  return a.filter((x) => x && typeof x.name === "string" && x.name).map((x) => ({
    name: x.name, displayName: typeof x.display_name === "string" && x.display_name ? x.display_name : x.name,
    hasBacktest: x.has_backtest === true, mtime: x.updated_at == null ? null : x.updated_at, remote: true,
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
function envCell(env, st, pending) {
  const kind = env === "cloud" ? envCloudKind(st) : "running";
  const out = { money: null, run: false, dot: null, word: null, sig: null };
  if (kind === "loading" || kind === "unreach") return out;
  if (kind === "signedOut") { out.word = "env.st.signedOut"; return out; }
  if (kind === "none") { out.word = "env.st.none"; return out; }
  if (kind === "starting") { out.dot = "busy"; out.word = "side.starting"; return out; }
  out.money = envMoney(st);
  if (kind === "stopped") { out.dot = "bad"; out.word = "side.stopped"; out.sig = "stopped"; return out; }
  const state = trExecState(st);
  if (state === "halted" && envAutoHalt(st)) { out.dot = "bad"; out.word = "env.st.autoPaused"; out.sig = "halt:" + String(st.report.halt.at || ""); return out; }
  out.run = state === "running" && !pending && !trFailedIds(st.report).length;
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
// 側欄雲端清單列尾的狀態字:有投入金額的才講(下單中 / 已停);其餘不講
function envStratWord(name, st) {
  const r = st && st.report, a = r && r.config && r.config.amounts;
  if (!a || !(a[name] > 0)) return null;
  const state = trExecState(st);
  return state === "running" ? "side.cloud.st.trading" : state === "halted" ? "side.cloud.st.halted" : null;
}
/* ── 視角純邏輯到此 ───────────────────────────────────────────── */

/* 每個視角各一份狀態(spec §1.3):分頁、權益曲線的區間與模式、打到一半的金額、過場…各記各的;TR 指向「現在看得見的那一份」。
   跨 await 的流程(送指令、儲存、連接)開頭先 `const S = TR` 抓住自己那一份——等回應的時候用戶可能已經切到另一邊,
   回來的結果不可以寫進另一邊的狀態。 */
function trNewBag(env) {
  return {
    env, api: null, st: null, open: false, tab: null, landed: false,
    pending: null,                 // { want, until }:按了啟動/暫停之後,等狀態檔自己說它變了
    list: [], listLoaded: false, meta: new Map(),     // 回測過的策略與它們的 symbol / market / 是不是 Type C
    edits: {}, save: null, saveErr: null, saveTimer: null,
    sig: {},                       // 各面板上次畫的資料指紋:沒變就不重畫(輸入框的焦點、捲動位置都留著)
    cx: { busy: false, err: null, retest: false }, unbinding: false,
    ov: { mode: "equity", days: 30, curve: null, ui: [], geo: null, at: 0 },
    bad: {},                       // 金額輸入框裡看不懂的字(name → true):有任何一格就不給儲存
    alertText: "", alertWant: null, lastSaid: null, scroll: {},
  };
}
let TR = trNewBag("local");
const TR_BAGS = { local: TR, cloud: trNewBag("cloud") };
const TRP = { started: false, timer: null, polling: false, again: false };
const ENV = { cur: "local", cloudAt: 0, cloudDirty: true, seen: {}, cells: {}, said: {}, sig: {} };
const ENV_POLL_SEEN = 15000, ENV_POLL_OTHER = 60000;
// 字串表的漂移閘門(check_shell_strings.js)只認得寫成字面值的 key:會變的 key 走這兩支,每個 key 都以字面值出現一次
const envName = (env) => (env === "cloud" ? t("env.cloud") : t("env.local"));
const envMoneyText = (m) => (m === "real" ? t("tr.mode.real") : m === "paper" ? t("tr.mode.paper") : "");
// 同步的畫面函式借另一邊的狀態跑一次(設定 › 連線這一刀永遠是這台電腦的;過場檢查永遠看本機那一份)
function trWith(bag, fn) { const prev = TR; TR = bag; try { return fn(); } finally { TR = prev; } }
const TR_POLL_OPEN = 4000, TR_POLL_IDLE = 15000, TR_POLL_PENDING = 2500, TR_CONFIRM_MS = 60000;
const TR_TABS = ["over", "pos", "assets", "hist", "set"];
const PAPER = "paper";

function trEl(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
function trReport() { return (TR.st && TR.st.report) || null; }
function trVenueId() { return trVenueIds(trReport())[0] || null; }
// 給人看的交易所名:這一版只有模擬交易;其餘 id 首字大寫(同雲端 venueLabel 的退路)
function trVenueLabel(id, short) {
  if (!id) return "";
  if (id === PAPER) return short ? t("cx.paperShort") : t("cx.paper");
  return id.charAt(0).toUpperCase() + id.slice(1);
}
function trIsPaper() { return trVenueId() === PAPER; }
function trCcy() { const e = trLiveEntry(trReport(), trVenueId()); return (e && e.currency) || "USDT"; }
// 單位:模擬帳戶寫「模擬 USDT」(三通道之一:記號、外框、單位)
function trUnit() { return trIsPaper() ? t("tr.paperCcy", { c: trCcy() }) : trCcy(); }
function trEquity() { const e = trLiveEntry(trReport(), trVenueId()); return e && e.ok && typeof e.equity === "number" ? e.equity : null; }
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
function trStamp(ts) { const ms = trMs(ts); if (ms == null) return "—"; const d = new Date(ms); return tr2(d.getMonth() + 1) + "-" + tr2(d.getDate()) + " " + tr2(d.getHours()) + ":" + tr2(d.getMinutes()); }
function trHM(ms) { const d = new Date(ms); return tr2(d.getHours()) + ":" + tr2(d.getMinutes()); }
function trMoneyInto(node, v, signed) {
  const s = trFmt(v, signed);
  node.textContent = s == null ? "—" : s;
  if (s != null) node.appendChild(trEl("span", "ccy", trUnit()));
}
function trHead(cols) {
  const thead = document.createElement("thead"), row = document.createElement("tr");
  cols.forEach((c) => { const th = trEl("th", c[1], c[0]); th.scope = "col"; row.appendChild(th); });
  thead.appendChild(row); return thead;
}
let trTipSeq = 0;
// 區段標籤上的解釋:觸發點是一顆鈕(鍵盤到得了),氣泡是 app.css 的 .tip
function trTipLabel(cls, text, tip) {
  const frag = document.createDocumentFragment();
  const b = trEl("button", cls + " tr-tipb", text); b.type = "button";
  const box = trEl("span", "tip", tip); box.setAttribute("role", "tooltip"); box.id = "tr-tip-" + (++trTipSeq);
  b.setAttribute("aria-describedby", box.id);
  frag.append(b, box); return frag;
}
function trSec(labelNode) { const s = trEl("div", "pf-sec"); s.appendChild(labelNode); return s; }
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
  trWire(); envWire(); trPoll();
}
/* 選單列 / Dock / 結束攔截的字:主行程沒有翻譯表,由這裡依目前語言交過去(換語言時 app.js 的 applyStatic 會再叫一次) */
function trPushLabels() {
  if (typeof window.blave.tradeLabels !== "function") return;
  window.blave.tradeLabels({ running: t("tr.autoOn"), paperVenue: t("cx.paperShort"), pause: t("tm.pause"), open: t("tm.open"), quit: t("tm.quit"),
    notifTitle: t("tm.notifTitle"), notifBody: t("tm.notifBody"), pauseFail: t("tm.pauseFail"), pauseUnknown: t("tr.cmdUnknown"), quitTitle: t("tm.quitTitle"), quitBody: t("tm.quitBody"),
    quitGo: t("tm.quitGo"), quitStay: t("tm.quitStay"), hidden: t("tm.hidden"), updateReady: t("tm.updateReady"),
    // 本機 P1 通知的字:跟總覽時間軸同一組(trEventText),只有拒單的註解是通知專用
    ev_halt: t("tr.ov.evHaltAuto"), ev_halt_n: t("tr.ov.evHaltNote"), ev_order_error: t("tr.ov.evErr"), ev_order_error_n: t("tm.evOrderErrNote"),
    ev_execution_interrupted: t("tr.ov.evExecInterrupted"), ev_execution_interrupted_n: t("tr.ov.evExecInterruptedNote"),
    ev_execution_fallback_market: t("tr.ov.evExecFallback"), ev_execution_fallback_market_n: t("tr.ov.evExecFallbackNote"),
    ev_execution_stuck: t("tr.ov.evExecStuck"), ev_execution_stuck_n: t("tr.ov.evExecStuckNote"),
    ev_downtime_paused: t("tr.ov.evHaltAuto"), ev_downtime_paused_n: t("tr.ov.evDowntimeNote") });
}
function trWire() {
  $("tr-tabs").addEventListener("click", (e) => { const b = e.target.closest(".main-tab"); if (b) trSetTab(b.dataset.tab); });
  $("tr-tabs").addEventListener("keydown", (e) => {
    const i = TR_TABS.indexOf(TR.tab);
    const j = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? TR_TABS.length - 1 : -1;
    if (j < 0 || j >= TR_TABS.length || j === i) return;
    e.preventDefault(); trSetTab(TR_TABS[j], true);
  });
  $("tr-nav").addEventListener("click", () => trOpen());

  window.addEventListener("resize", () => { if (TR.open && TR.tab === "over") { TR.sig.over = null; trPaintOver(); } });
}
async function trPoll() {
  clearTimeout(TRP.timer);
  if (TRP.polling) { TRP.again = true; return; }   // 在途那一輪結束後立刻再跑一次(剛切視角:新的那一邊不必多等一輪才載入清單)
  TRP.polling = true; TRP.again = false;
  const L = TR_BAGS.local, C = TR_BAGS.cloud, S = TR_BAGS[ENV.cur], now = Date.now();
  try {
    try { L.st = await L.api.tradeStatus(); } catch (_) { }   // 主行程沒回:下一輪再問,畫面維持上一份
    /* 雲端:這裡問的是主行程手上那一份(不打網路;主行程自己輪詢、自己節流)。看得見雲端時每 15 秒問一次;
       看這台電腦時靠主行程的推送(onCloudState → cloudDirty)+ 60 秒一次,只為了更新切換器那一格。
       app 一開就問第一次:主行程是懶啟動,有人問了才開始輪詢。 */
    if (ENV.cloudDirty || now - ENV.cloudAt >= (ENV.cur === "cloud" ? ENV_POLL_SEEN : ENV_POLL_OTHER)) {
      ENV.cloudDirty = false; ENV.cloudAt = now;
      try {
        C.st = await C.api.tradeStatus();
        // 雲端的清單就在那份狀態裡(沒有 I/O):不管現在看哪一邊都跟著換——登出 / 換帳號之後切過去的第一幀不可以是上一個人的策略名(稽核 N5)
        await trLoadStrategies(C); C.listLoaded = true;
        if (envCloudKind(C.st) === "signedOut") { C.edits = {}; C.ov.curve = null; C.ov.ui = []; }
      } catch (_) { }
    }
    // 策略清單另外接:它失敗不能連累狀態,也不能把「沒載入」當成「一支都沒有」(listLoaded 只有成功才會變 true)
    if (S === L && S.open) { try { await trLoadStrategies(S); S.listLoaded = true; } catch (_) { } }
    trWith(L, trPendingCheck);
    trPaint();
    if (!$("set-scrim").hidden && !$("set-conn").hidden) cxPaint();
  } finally {
    // 排下一輪放在 finally(稽核 N7):畫面函式就算丟例外,輪詢鏈也不能斷——斷了本機的狀態帶與綠點會凍在舊值
    TRP.polling = false;
    const cxOn = !$("set-scrim").hidden && !$("set-conn").hidden;   // 連線頁開著也算「在看」:剛連上要幾秒內看到已連接
    clearTimeout(TRP.timer); TRP.timer = setTimeout(trPoll, TRP.again ? 0 : L.pending ? TR_POLL_PENDING : TR_BAGS[ENV.cur].open || cxOn ? TR_POLL_OPEN : TR_POLL_IDLE);
  }
}
function trPollSoon(ms) { clearTimeout(TRP.timer); TRP.timer = setTimeout(trPoll, ms || 0); }

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
            portfolio: x.remote ? !!x.portfolio : !sym && Object.keys(s).some((k) => k.indexOf("benchmark_") === 0) };
      S.meta.set(x.name, m);
    }
    out.push({ name: x.name, displayName: x.displayName || x.name, hasBacktest: !!x.hasBacktest, symbol: m.symbol, market: m.market, portfolio: m.portfolio });
  }
  S.list = out;
}
function trStored() { const c = (trReport() || {}).config || {}; return c.amounts && typeof c.amounts === "object" ? c.amounts : {}; }
// 表上列哪些:回測過的全列(這一版沒有「選擇策略」),加上已經在組合裡、而且還在這台電腦上的
function trNames() { const st = trStored(); return TR.list.filter((x) => x.hasBacktest || x.name in st).map((x) => x.name); }
function trDisplay(n) { const x = TR.list.find((y) => y.name === n); return x ? x.displayName : n; }

/* ── 開/關視圖 ─────────────────────────────────────────── */
async function trOpen(tab) {
  const S = TR;
  if (S.env === "local") await stratSelect(null);   // 中欄一次只有一個視圖:先把策略報告收掉(雲端視角不動這台電腦選中的那支)
  if (S !== TR_BAGS[ENV.cur]) { S.open = true; return; }   // 等的時候切走了:只記下這一邊是開著的,不碰另一邊的畫面
  $("main-empty").hidden = true; $("tr").hidden = false;
  $("tr-nav").setAttribute("aria-current", "page");
  S.open = true; S.sig = {};
  trPaint();
  if (tab && !$("tr-tabs").hidden) trSetTab(tab);   // 指定分頁的入口(之後的通知、狀態帶)一律走 trSetTab:底線、tabindex、面板三件事一起換
  trPollSoon(0);
}
// app.js 選了策略時叫的:離開的是「這台電腦」的自動下單頁(雲端視角的那一頁不歸它管)
function trLeave() {
  const L = TR_BAGS.local;
  if (!L.open) return;
  L.open = false;
  if (ENV.cur === "local") { $("tr").hidden = true; $("tr-nav").removeAttribute("aria-current"); }
}
function trRepaint() { TR.sig = {}; TR_BAGS.local.sig = {}; ENV.sig = {}; ENV.cells = {}; trPaint(); if (!$("set-conn").hidden) cxPaint(); }

/* ── 標題列 / 狀態帶 ───────────────────────────────────────── */
function trStateText(state) {
  const r = trReport() || {}, rec = r.reconciler || {};
  // 雲端:主機停機就講停機(心跳那一句在這裡沒有意義);主機那一輪沒回報成功 = 讀不到,不沿用寫死「這台電腦」的那兩句
  if (TR.env === "cloud") {
    if (envCloudKind(TR.st) === "stopped") return t("side.stopped");
    if (state === "unknown") return t("tr.cloud.unknown");
  }
  // 過場中講過場(設計師 A-2):不能一邊亮綠點一邊寫「對帳沒有在跑」
  if (TR.pending) return TR.pending.want === "halted" ? t("tr.stopping") : t("tr.starting");
  // 常駐程式不在跑:誠實講,並給出口(重試中 / 起不來請重開 Blave)。灰字,同其他故障
  const down = trHostDown(TR.st, Date.now());
  if (down) return down === "retry" ? t("tr.hostRetry") : t("tr.hostDown");
  if (state === "loading") return t("tr.loading");
  if (state === "unknown") return t("tr.unknown");
  if (state === "noaccount") return t("tr.noAccount");
  let s = t("tr.autoOn");
  if (state === "halted") s = envHeadWord(state, TR.st) === "env.st.autoPaused" ? t("env.st.autoPaused") : t("tr.halted");
  else if (state === "dead") s = rec.heartbeat_at ? t("tr.recDead") + " · " + t("tr.lastBeat", { t: trStamp(rec.heartbeat_at) }) : t("tr.notStarted");
  // 讀帳失敗標在狀態行最前面(細節在 設定 › 連線);頁面與暫停鈕照常在
  return trFailedIds(r).length ? t("cx.failShort") + " · " + s : s;
}
// 全頁唯一的紅字槽。want = 這句話在狀態變成什麼的時候就不成立了(例:「它還在交易」在已暫停之後是假話)→ 到了就自己清掉
function trAlert(text, want, bag) {
  const S = bag || TR, was = S.alertText;
  S.alertText = text || ""; S.alertWant = text ? want || null : null;
  if (S !== TR_BAGS[ENV.cur]) return;              // 另一邊的事:記著,切過去才出現
  trAlertShow();
  if (text && text !== was) srSay(text);
}
function trAlertShow() { const S = TR_BAGS[ENV.cur], a = $("tr-alert"); a.hidden = !S.alertText; a.textContent = S.alertText; }
// kind:"stop" = 暫停那兩個指令(沒送到 = 它還在交易,要講撤 API key 那句);其餘一般失敗不講那句(稽核 S2-B)
function trSendError(res, kind) {
  const e = res && res.error ? String(res.error) : "", k = trErrorKind(e);
  if (k === "unknown") return t("tr.cmdUnknown");
  if (k === "rejected") return t("tr.cmdRejected", { err: e.slice(0, 200) });
  return kind === "stop" ? t("tr.cmdNotDelivered") : t("tr.cmdFailed");
}
function trPendingCheck() {
  const state = trExecState(TR.st);
  if (TR.alertWant && state === TR.alertWant) trAlert("");
  const p = TR.pending; if (!p) return;
  if (state === p.want) { TR.pending = null; trAlert(""); }
  else if (Date.now() > p.until) { TR.pending = null; trAlert(p.unknown ? t("tr.cmdUnknown") : p.want === "halted" ? t("tr.cmdNotDelivered") : t("tr.cmdFailed"), p.want); }
}
/* 送「會改變執行狀態」的指令(稽核 S3):一進來就掛 pending——確認框一關、ack 還沒回來的那段時間鈕就已經是過場態,
   不會再開第二個確認框、送第二個 close_all / restart_reconciler。失敗才把 pending 拿掉。 */
async function trRun(want, steps) {
  const S = TR;
  if (S.env === "cloud" || S.pending) return;      // 雲端第一刀唯讀:任何會改變執行狀態的指令都不從這裡出去
  S.pending = { want, until: Date.now() + TR_CONFIRM_MS };
  trAlert("", null, S); trPaint();
  let res = null;
  for (const step of steps) { res = await step(S); if (!res || !res.ok) break; }
  const kind = want === "halted" ? "stop" : "start";
  if (res && res.ok) {
    // 常駐程式沒在跑時的 halt 只是排進佇列(下次啟動才吃):沒有東西在交易,不必等狀態
    if (res.result && res.result.queued) S.pending = null;
  } else if (trErrorKind(res && res.error) === "unknown") {
    // 可能已經執行:不說「沒送到」、不叫人重按;留著 pending 看狀態檔,到了就自己清
    if (S.pending) S.pending.unknown = true;
    trAlert(t("tr.cmdUnknown"), want, S);
  } else { S.pending = null; trAlert(trSendError(res, kind), want, S); }
  trPaint(); trPollSoon(800);
}

function trPaintHead() {
  // state = 文字與鈕字用的(雲端讀不到新狀態時 = 上一份回報自己說的,見 envHeadState);綠點另外看保守的 trExecState
  const state = envHeadState(TR.st, Date.now()), text = trStateText(state), ro = TR.env === "cloud";
  const kind = ro ? envCloudKind(TR.st) : null, stopped = kind === "stopped";
  // 綠點 = 一切正常在下單:過場中、下單機不在跑、讀不到帳戶、雲端讀不到新狀態時都不成立(設計師複查 R3-1)
  const live = trExecState(TR.st) === "running" && !TR.pending && !trHostDown(TR.st, Date.now()) && !trFailedIds(trReport()).length;
  // 標題列狀態行。雲端讀不到新狀態時,後面接「最後更新」(保留上一次的數字,但要講它不是現況)
  const c = (ro && TR.st && TR.st.cloud) || null;
  const staleAt = c && (c.transient ? c.last_ok_at : c.stale && !stopped && c.reported_at ? c.reported_at * 1000 : !TR.st.alive && !stopped && kind === "running" ? c.last_ok_at : 0);
  const full = staleAt ? text + " · " + t("tr.cloud.stale", { t: trStamp(staleAt / 1000) }) : text;
  const desc = $("tr-desc"); desc.textContent = "";
  if (live) { const d = trEl("span", "run-dot live"); d.setAttribute("aria-hidden", "true"); desc.appendChild(d); }
  desc.appendChild(trEl("span", "txt", full)); desc.title = full;   // 單行截斷,全文放 title
  // 常駐程式不在跑的那兩句帶著出口(「請重開 Blave」),不能被截斷:這時候狀態行可以換行
  desc.classList.toggle("wrap", !!trHostDown(TR.st, Date.now()) || (ro && state === "unknown"));
  // 狀態變了講一次(輪詢每幾秒重畫,不能每次都講)
  if (TR.lastSaid !== null && TR.lastSaid !== text && TR.open && state !== "loading") srSay(text);
  TR.lastSaid = text;
  // 雲端連續讀不到:全頁唯一的紅字槽(讀得到了就自己收掉;這一刀雲端沒有別的東西會用這一格)
  if (ro) trAlert(envUnreachAlert(c, Date.now()) ? t("tr.cloud.unreach", { t: trStamp((c.last_ok_at || 0) / 1000) }) : "");
  trAlertShow();
  // 切換器右邊那一句:這一邊的狀態。沒連接交易所時是空的
  const id = trVenueId(), has = state !== "noaccount" && state !== "loading" && state !== "unknown" && !!id;
  // 44px 的狀態帶放不下「下單機停了…請重開 Blave」那種長句(出口會被截掉):這裡用短句,完整句在標題列
  const tbState = trHostDown(TR.st, Date.now()) ? t("tr.hostShort") : text;
  // 出事(這一格有紅短劃那種事)時,狀態詞那一段加重;其餘整句灰字。句型照 tr.tb,只把 {state} 那一段換成節點
  const txt = $("tr-tb-txt"), tbFull = has ? t("tr.tb", { state: tbState, venue: trVenueLabel(id, true) }) : "";
  const tbUp = has && envCell(TR.env, TR.st, !!TR.pending).dot === "bad", tsig = LANG + "|" + tbFull + "|" + tbUp;
  if (ENV.sig.tb !== tsig) {
    ENV.sig.tb = tsig; txt.textContent = ""; txt.title = tbFull;
    if (tbUp) { const parts = t("tr.tb", { state: "\u0000", venue: trVenueLabel(id, true) }).split("\u0000"); txt.append(parts[0] || "", trEl("span", "up", tbState), parts[1] || ""); }
    else txt.textContent = tbFull;
  }
  // 錢記號排在這一句的最前面(切換器格內不放):看得見的這一邊用的是模擬還是真錢
  const mny = has ? envMoney(TR.st) : null, tm = $("tr-tb-mode");
  tm.hidden = !mny; tm.className = "mode " + (mny || "paper"); tm.textContent = envMoneyText(mny);
  // 雲端第一刀唯讀:全頁唯一的說明(不能按的鈕都用 aria-describedby 指到它)。停機時那顆鈕是可按的「加值」,說明不出
  trPaintRoNote(ro && state === "noaccount" ? "tr.ro.noteEmpty" : ro && !stopped ? "tr.ro.note" : null);
  trPaintVerdict(stopped);
  // 執行鈕:沒帳戶時不放(那顆「連接交易所」在 onboard 裡,同畫面不出現兩顆主要鈕)。
  // 同一顆鈕就地更新、不重建:確認框關掉之後焦點要回得到它,輪詢重畫也不能把焦點洗掉。
  const act = $("tr-act");
  let b = $("tr-go");
  // 雲端而且不知道現況:不放主鈕——「暫停下單」「啟動下單」哪一個字都是在替它下結論(這一刀的鈕本來就不能按,說明行還在)
  if (!stopped && (state === "noaccount" || state === "loading" || (ro && state === "unknown"))) { if (b) b.remove(); return; }
  if (!b) {
    b = trEl("button", "btn-fill"); b.type = "button"; b.id = "tr-go";
    b.addEventListener("click", () => {
      // 雲端:停機時這顆是「加值」(外開瀏覽器,不是寫雲端);其餘時候是唯讀的,點了無動作
      if (TR.env === "cloud") { if (envCloudKind(TR.st) === "stopped") window.blave.openExternal(acctUrl()); return; }
      if (TR.pending) return; if (trStopSide(envHeadState(TR.st, Date.now()))) trAskStop(b); else trAskStart(b);
    });
    act.appendChild(b);
  }
  if (ro) {
    // aria-disabled(不是 disabled):鍵盤要停得上去、讀屏要唸得到原因
    b.textContent = stopped ? t("plan.addCredit") : trStopSide(state) ? t("tr.stop") : t("tr.start");
    b.disabled = false; b.title = ""; b.classList.remove("is-busy"); b.classList.toggle("is-ro", !stopped);
    b.setAttribute("aria-disabled", stopped ? "false" : "true");
    if (stopped) b.removeAttribute("aria-describedby"); else b.setAttribute("aria-describedby", "tr-ro-note");
    return;
  }
  b.classList.remove("is-ro"); b.removeAttribute("aria-describedby");
  const up = trChannelUp(TR.st);
  b.textContent = TR.pending ? (TR.pending.want === "halted" ? t("tr.stopping") : t("tr.starting")) : trStopSide(state) ? t("tr.stop") : t("tr.start");
  // 過場中用 aria-disabled(不是 disabled):disabled 的鈕會把焦點丟到 BODY
  const busy = !!TR.pending;
  b.setAttribute("aria-disabled", busy ? "true" : "false"); b.classList.toggle("is-busy", busy);
  // 狀態不明時鈕照給、而且不看狀態檔裡的 listener 旗標(那份檔就是不能信的那個):暫停是安全方向
  const usable = state === "unknown" ? !!(TR.st && TR.st.alive) : up;
  b.disabled = !busy && !usable; b.title = !busy && !usable ? t("tr.cmdUnavailable") : "";
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
// 這個狀態下鈕是「暫停」那一側嗎。狀態不明時給暫停:不知道有沒有在跑,就給安全方向的那顆(稽核 S5)
function trStopSide(state) { return state === "running" || state === "unknown"; }

function trAskStop(opener) {
  if (TR.env !== "local") return;
  const r = trReport() || {};
  confirmBox({
    title: t("tr.stop"), mark: trIsPaper() ? t("tr.mode.paper") : null, opener,
    lines: [r.self_ledger === true ? t("tr.stopChoiceSelf") : t("tr.stopChoice"), t("tr.closeAllWarn2")],
    ok: t("tr.stopKeep"), onOk: () => trRun("halted", [(S) => S.api.tradeSend("halt", { reason: "desktop ui" })]),
    // 沒有平倉層的 workspace 不給「看起來成功但沒平」的鈕(同雲端 can_flatten)
    alt: r.can_flatten === true ? { label: t("tr.stopFlat"), danger: true, onOk: () => trRun("halted", [(S) => S.api.tradeSend("close_all", {})]) } : null,
  });
}
// 中文句子裡夾英文名(Binance)前後要空一格;英文句子本來就有空格
function trPadLatin(name) { return LANG === "zh" && /^[\x20-\x7e]+$/.test(name) ? " " + name + " " : name; }
function trMeans() {
  const box = trEl("div", "means"), paper = trIsPaper();
  box.appendChild(trEl("span", "lbl", t("tr.means.l")));
  const ul = document.createElement("ul");
  // 模擬帳戶:第 2 點走自己那句(不代入交易所名),第 4 點整點不出——模擬帳戶沒有交易所端的停損單,那句在這裡是假的
  const pts = [t("tr.means.1"), paper ? t("tr.means.2p") : t("tr.means.2", { venue: trPadLatin(trVenueLabel(trVenueId(), true)) }), t("tr.means.3")];
  if (!paper) pts.push(t("tr.means.4"));
  pts.forEach((x) => ul.appendChild(trEl("li", "", x)));
  box.appendChild(ul); return box;
}
function trAskStart(opener) {
  if (TR.env !== "local") return;
  const r = trReport() || {}, canWait = r.can_wait_start === true;
  // 順序照雲端:先送所選指令(resume_wait 的 gate 要先落地),對帳器沒在跑再叫它起來
  const go = (cmd) => trRun("running", [
    (S) => S.api.tradeSend(cmd, {}),
    (S) => { return trRecRunning(S.st) ? { ok: true } : S.api.tradeSend("restart_reconciler", {}); },
  ]);
  confirmBox({
    title: t("tr.start"), mark: trIsPaper() ? t("tr.mode.paper") : null, opener,
    lines: canWait ? [t("tr.startChoice"), t("tr.startWarn2")] : [t("tr.startWarn1"), t("tr.startWarn2")],
    extra: trMeans(),
    ok: t("tr.startCatchUp"), onOk: () => go("resume"),
    alt: canWait ? { label: t("tr.startWait"), onOk: () => go("resume_wait") } : null,
  });
}

/* ── 分頁 ───────────────────────────────────────────── */
function trNeedsSetup() {
  const a = trStored();
  return !Object.keys(a).some((n) => a[n] > 0);
}
function trSetTab(tab, focus) {
  TR.tab = tab; TR.landed = true;
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
  if (!TR.open) return;
  // unknown(狀態檔這一輪沒寫出來)也走這個版面,但畫的是一段說明、不是 onboard——標題列的暫停鈕還在
  const state = trExecState(TR.st), bare = state === "noaccount" || state === "loading" || state === "unknown";
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
  if (!trShould("onboard", box, [state, fails, TR.env])) return;
  box.textContent = "";
  if (state === "loading") { box.appendChild(trEl("div", "pf-state", t("tr.loading"))); return; }
  // 「要停就按暫停下單」只在那顆鈕真的能按的時候才講(下單機不在跑時鈕是 disabled,那句就是假話)
  if (state === "unknown") { box.appendChild(trEl("div", "pf-state", TR.env === "cloud" ? t("env.empty.unreach") : t("tr.unknownBody") + (TR.st && TR.st.alive ? t("tr.unknownStop") : ""))); return; }
  const ob = trEl("div", "pf-onboard");
  ob.appendChild(trEl("p", "", t("tr.onboard")));
  const b = trEl("button", "btn-fill", t("cx.connect")); b.type = "button"; b.id = "tr-connect";
  // 雲端第一刀:連接交易所要到網頁做(說明在標題下那一行);鈕留著但不能按
  if (TR.env === "cloud") { b.classList.add("is-ro"); b.setAttribute("aria-disabled", "true"); b.setAttribute("aria-describedby", "tr-ro-note"); }
  else b.addEventListener("click", cxOpen);
  ob.appendChild(b); box.appendChild(ob);
}

/* ── 部位分頁:策略金額表 + 交易所部位表 ─────────────────────────── */
function trPaintPos() {
  const box = $("tr-pos"), r = trReport() || {};
  const names = trNames(), stored = trStored(), states = r.states || {};
  const data = [TR.env, TR.listLoaded, names, TR.list, stored, states, trEquity(), trUnit(), TR.save, TR.saveErr, r.last_reconcile, r.account, r.order_errors, trExecState(TR.st)];
  if (!trShould("pos", box, data)) return;
  box.textContent = "";
  if (!TR.listLoaded) {
    // 策略清單還沒回來(或讀失敗):不畫金額表、更不畫儲存列——「清單是空的」在這時候不是事實,不能邀請人把策略移出組合
    box.appendChild(trSec(trTipLabel("label", t("tr.strategies"), t("tr.zeroMeansOff"))));
    box.appendChild(trEl("div", "pf-state", t("tr.loading")));
  } else box.appendChild(trAmountTable(names, stored, states));
  box.appendChild(trPositions(r, stored, states));
  if (trIsPaper()) box.appendChild(trEl("div", "pf-foot", t("cx.perfNote")));
}
function trAmountTable(names, stored, states) {
  const frag = document.createDocumentFragment();
  frag.appendChild(trSec(trTipLabel("label", t("tr.strategies"), t("tr.zeroMeansOff"))));
  const total = trEl("div", "pf-total"), bar = trEl("div", "pf-savebar"), ro = TR.env === "cloud";
  const gates = ((trReport() || {}).last_reconcile || {}).gates || {};
  const paintTotal = () => {
    const tt = trTotals(trCurrentAmounts(names, stored, TR.edits), trEquity());
    total.textContent = "";
    total.appendChild(trEl("span", "", t("tr.total")));
    const tn = trEl("span", "n", trFmt(tt.total)); tn.appendChild(trEl("span", "ccy", trUnit())); total.appendChild(tn);
    if (tt.mult != null) { total.append(trEl("span", "", "·"), trEl("span", "", t("tr.ofEquity")), trEl("span", "n", tt.mult.toFixed(2) + "x")); }
  };
  const anyBad = () => Object.keys(TR.bad).length > 0;
  const paintBar = () => {
    bar.textContent = ""; bar.hidden = false;
    if (TR.save === "saving") { bar.appendChild(trEl("span", "txt", t("tr.saving"))); return; }
    if (TR.save === "saved") { bar.appendChild(trEl("span", "txt ok", "✓ " + t("tr.saved"))); return; }
    if (TR.save === "failed") bar.appendChild(trEl("span", "txt err", TR.saveErr || t("tr.cmdFailed")));
    else { bar.hidden = !trDirty(names, stored, TR.edits) && !anyBad(); bar.appendChild(trEl("span", "txt", t("tr.unsaved"))); }
    const rv = trEl("button", "pf-cancel", t("tr.revert")); rv.type = "button";
    rv.addEventListener("click", () => { TR.edits = {}; TR.bad = {}; TR.save = null; TR.saveErr = null; TR.sig.pos = null; trPaintPos(); $("tr-tab-pos").focus(); });
    const sv = trEl("button", "btn-fill", t("tr.save")); sv.type = "button";
    sv.disabled = anyBad();                        // 有一格看不懂就不給存:確認框列的必須是用戶打的那個數
    sv.addEventListener("click", () => trSaveAmounts(names, stored, sv));
    bar.append(rv, sv);
  };
  if (!names.length) {
    frag.appendChild(trEl("div", "pf-state", ro ? t("side.cloud.emptyCut1") : t("tr.noStrategies")));
    if (ro) return frag;
    paintBar(); frag.appendChild(bar);             // 空狀態也可能有「移出組合」等著儲存(策略被刪了)
    if (trRemoved(stored, {}).length && !TR.save) bar.hidden = false;   // 走得到這裡 = 清單已載入而且真的空了
    return frag;
  }
  const scroll = trEl("div", "pf-scroll"), tbl = trEl("table", "pf-tbl");
  tbl.appendChild(trHead([[t("tr.col.strategy"), ""], [t("tr.col.symbol"), "c-sym"], [t("tr.col.amount"), "n"], [t("tr.col.targetPos"), "n"]]));
  const tb = document.createElement("tbody");
  names.slice().sort((a, b) => (stored[b] || 0) - (stored[a] || 0)).forEach((n) => {
    const x = TR.list.find((y) => y.name === n) || {}, st = states[n] || {};
    const sym = st.symbol || x.symbol, market = st.market || x.market;
    const row = document.createElement("tr");
    const first = trEl("td", "key");
    first.appendChild(trEl("span", "", trDisplay(n)));
    first.appendChild(trEl("span", "mkt-tag", market === "spot" ? t("tr.mkt.spot") : t("tr.mkt.swap")));
    first.appendChild(trEl("span", "sub-sym mono", sym || "—"));
    // 投資組合策略沒有實盤路徑:0 → >0 是機器端必拒的轉換,從源頭鎖掉並講原因;已經 >0 的存量不鎖
    const locked = !!x.portfolio && !(stored[n] > 0);
    if (locked && !ro) first.appendChild(trEl("span", "pf-note", t("tr.typeC")));
    row.appendChild(first);
    row.appendChild(trEl("td", "sym c-sym", sym || "—"));
    if (ro) {
      // 唯讀:金額畫成純數字(同「目標部位」欄),不畫輸入框——看起來不能改的東西就不要長得像能改
      const ac = trEl("td", "n"), tc = trEl("td", "n na", "—"), v = (stored[n] || 0) * (typeof st.position === "number" ? st.position : 0);
      trMoneyInto(ac, stored[n] || 0);
      if (v !== 0) { tc.className = "n " + (v > 0 ? "buy" : "sell"); trMoneyInto(tc, v, true); }
      row.append(ac, tc); tb.appendChild(row); return;
    }
    const c = trEl("td", "n"), wrap = trEl("span", "amt-inw"), inp = trEl("input", "amt-in");
    inp.type = "text"; inp.inputMode = "decimal"; inp.disabled = locked || TR.save === "saving";
    inp.setAttribute("aria-label", trDisplay(n) + " — " + t("tr.amountAria", { ccy: trUnit() }));
    inp.value = trFmt(TR.edits[n] != null ? TR.edits[n] : stored[n] || 0);
    wrap.append(inp, trEl("span", "amt-unit", trUnit())); c.appendChild(wrap); row.appendChild(c);
    const tgt = trEl("td", "n na", "—");
    const pos = typeof st.position === "number" ? st.position : 0;
    // 最小進場額:機器端只在門檻大於平台那顆 10 時才回報;填得比它小就永遠不會進場,而且完全靜音
    const g0 = sym ? gates[trCanonSym(sym) + (market === "spot" ? "@spot" : "")] : null;
    const gate = g0 && typeof g0.entry_usd === "number" ? g0.entry_usd : g0 && g0.side !== "reduce" && typeof g0.usd === "number" ? g0.usd : null;
    let gateRow = null;
    if (gate != null) {
      gateRow = document.createElement("tr");
      const ntd = trEl("td", "note"); ntd.colSpan = 4;
      ntd.appendChild(trEl("span", "pf-note", t("tr.gateHint", { m: trFmt(gate), c: trUnit() })));
      gateRow.appendChild(ntd);
    }
    const repaint = () => {
      const a = TR.edits[n] != null ? TR.edits[n] : stored[n] || 0, v = a * pos;
      tgt.className = "n " + (v > 0 ? "buy" : v < 0 ? "sell" : "na");
      if (v === 0) tgt.textContent = "—"; else trMoneyInto(tgt, v, true);
      if (gateRow) {
        const show = a > 0 && a < gate;
        if (show && !gateRow.parentNode) row.insertAdjacentElement("afterend", gateRow);
        else if (!show && gateRow.parentNode) gateRow.remove();
        row.classList.toggle("has-note", show || !!badRow.parentNode);
      }
    };
    const badRow = document.createElement("tr"), btd = trEl("td", "note"); btd.colSpan = 4;
    const bmsg = trEl("span", "pf-note err", t("tr.badAmount")); bmsg.id = "tr-bad-" + n;
    btd.appendChild(bmsg); badRow.appendChild(btd);
    const markBad = (bad) => {
      if (bad) TR.bad[n] = true; else delete TR.bad[n];
      inp.setAttribute("aria-invalid", bad ? "true" : "false");
      if (bad) inp.setAttribute("aria-describedby", bmsg.id); else inp.removeAttribute("aria-describedby");
      if (bad && !badRow.parentNode) { row.insertAdjacentElement("afterend", badRow); srSay(t("tr.badAmount")); }
      else if (!bad && badRow.parentNode) badRow.remove();
      row.classList.toggle("has-note", bad || !!(gateRow && gateRow.parentNode));
    };
    inp.addEventListener("input", () => {
      const v = trParseAmount(inp.value);
      // 看不懂的字不進 edits(上一個看得懂的值留著);整格標成無效、儲存鈕鎖住(稽核 S11)
      if (v != null) TR.edits[n] = v;
      if (TR.save === "failed" || TR.save === "saved") { TR.save = null; TR.saveErr = null; }
      markBad(v == null); paintTotal(); repaint(); paintBar();
    });
    // 離開輸入框時回寫正規化後的值:用戶看到的就是會送出去的那個數(「1500.5」→「1,500.50」)
    inp.addEventListener("blur", () => { const v = trParseAmount(inp.value); if (v != null) inp.value = trFmt(v); });
    row.appendChild(tgt); tb.appendChild(row); repaint();
    if (TR.bad[n]) delete TR.bad[n];               // 整張表重畫 = 輸入框回到看得懂的值
  });
  tbl.appendChild(tb); scroll.appendChild(tbl); frag.appendChild(scroll);
  frag.appendChild(trEl("div", "pf-foot unit-note", t("tr.unitNote", { c: trUnit() })));
  paintTotal(); frag.appendChild(total);
  if (!ro) { paintBar(); frag.appendChild(bar); }
  return frag;
}
function trSaveAmounts(names, stored, opener) {
  const S = TR;
  if (S.env !== "local" || !TR.listLoaded || Object.keys(TR.bad).length) return;
  const sending = trAmountsToSend(names, stored, TR.edits, TR.listLoaded), removed = trRemoved(stored, sending);
  const lines = [];
  Object.keys(sending).forEach((n) => { if (sending[n] > 0) lines.push(t("tr.saveLine", { name: trDisplay(n), amt: trFmt(sending[n]) + " " + trUnit() })); });
  const tt = trTotals(sending, trEquity());
  lines.push(t("tr.total") + " " + trFmt(tt.total) + " " + trUnit() + (tt.mult != null ? " · " + t("tr.ofEquity") + " " + tt.mult.toFixed(2) + "x" : ""));
  if (removed.length) lines.push(t("tr.saveRemoved", { names: removed.map(trDisplay).join(LANG === "zh" ? "、" : ", ") }));
  lines.push(t("tr.saveWarn"));
  confirmBox({
    title: t("tr.saveTitle"), mark: trIsPaper() ? t("tr.mode.paper") : null, lines, ok: t("tr.save"), opener,
    onOk: async () => {
      const mine = () => TR === S && S.open && S.tab === "pos";   // 等回應的時候可能已經切到另一邊:那時不碰畫面
      S.save = "saving"; S.saveErr = null; S.sig.pos = null; if (mine()) trPaintPos();
      // 這一版沒有「下單方式」欄(一律市價),所以只送 amounts,不送 execution
      const res = await S.api.tradeSend("amounts", { amounts: sending });
      clearTimeout(S.saveTimer);
      if (res && res.ok) {
        S.save = "saved"; S.edits = {};
        srSay(t("tr.saved"));
        S.saveTimer = setTimeout(() => { if (S.save === "saved") { S.save = null; S.sig.pos = null; if (mine()) trPaintPos(); } }, 4000);
      } else {
        // 沒送到 / 結果不明 / 被拒絕(拒絕原因是不可信輸入,包在本地化前導裡、走 textContent)
        S.save = "failed"; S.saveErr = trSendError(res, "save"); srSay(S.saveErr);
      }
      S.sig.pos = null;
      try { S.st = await S.api.tradeStatus(); } catch (_) { }   // 下一輪輪詢會補
      if (mine()) { trPaintPos(); $("tr-tab-pos").focus(); }   // 儲存列可能收掉了:焦點不能掉到 BODY
      trPollSoon(1500);
    },
  });
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
  frag.appendChild(trSec(trTipLabel("label", t("tr.exchPositions"), t("tr.threshold", { amt: "10 " + trUnit() }))));
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
  const syms = Object.keys(target);
  Object.keys(actual).forEach((s) => { if (syms.indexOf(s) < 0) syms.push(s); });
  syms.sort();
  if (!syms.length) {
    const dead = trExecState(TR.st) === "dead";
    frag.appendChild(trEl("div", "pf-state", dead && !last ? t("tr.posEmpty") : last ? t("tr.noPositions") : t("tr.noReconcile")));
    return frag;
  }
  const scroll = trEl("div", "pf-scroll"), tbl = trEl("table", "pf-tbl");
  tbl.appendChild(trHead([[t("tr.col.symbol"), ""], [t("tr.col.target"), "n"], [t("tr.col.actual"), "n"], [t("tr.col.diff"), "n"]]));
  const tb = document.createElement("tbody"), gated = [];
  syms.forEach((sym) => {
    const ts = target[sym] || 0, as = actual[sym] || 0, d = ts - as;
    const row = document.createElement("tr");
    const sc = trEl("td", "sym", sym.replace(/@spot$/, ""));
    sc.appendChild(trEl("span", "mkt-tag", /@spot$/.test(sym) ? t("tr.mkt.spot") : t("tr.mkt.swap")));
    const tc = trEl("td", "n"), ac = trEl("td", "n");
    trMoneyInto(tc, ts, true); trMoneyInto(ac, as, true);
    // 上色要對齊真正觸發下單的門檻:平台 10,或該標的在交易所的最小下單量(機器端回報的 gates)
    const gs = trGateSide(gates[sym], ts, as), acts = Math.abs(d) >= (gs ? gs.usd : 10);
    const held = !acts && Math.round(Math.abs(d)) > 0;
    const dc = trEl("td", "n " + (acts ? (d > 0 ? "buy" : "sell") : "hold"));   // 0 是有意義的值(對上了),不用佔位符那階灰
    trMoneyInto(dc, d, true);
    row.append(sc, tc, ac, dc); tb.appendChild(row);
    if (gs && held && !(gs.reduce && gs.usd <= 10)) gated.push({ sym, gs });
  });
  tbl.appendChild(tb); scroll.appendChild(tbl); frag.appendChild(scroll);
  if (gated.length) {
    const short = (k) => { const f = k.replace(/@spot$/i, ""), b = f.replace(/(USDT|USDC|BUSD|FDUSD|USD)$/i, ""); return b && b !== f ? b : f; };
    frag.appendChild(trEl("div", "pf-foot", t("tr.gateFootLead") + gated.map((g) =>
      g.gs.reduce ? t("tr.gateFootReduce", { sym: short(g.sym) }) : t("tr.gateFootEntry", { sym: short(g.sym), m: trFmt(g.gs.usd) })).join(" · ")));
  }
  // 下單失敗不能靜悄悄:最新一筆掛在表底(紅字腳注,同雲端)
  const errs = Array.isArray(r.order_errors) ? r.order_errors : [];
  const le = errs[errs.length - 1];
  if (le && typeof le === "object") {
    frag.appendChild(trEl("div", "pf-foot err", t("tr.orderFailed", { sym: String(le.symbol || "—").replace(/@spot$/, ""), err: String(le.error || le.message || "").slice(0, 200) })));
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
    row.appendChild(trEl("span", "who", trVenueLabel(id)));
    if (id === PAPER) row.appendChild(trEl("span", "mode paper", t("tr.mode.paper")));
    const amt = trEl("span", "amt"); amt.appendChild(trEl("span", "lbl", t("tr.equity")));
    const v = e && e.ok ? trFmt2(e.equity) : null;
    amt.appendChild(document.createTextNode(v == null ? "—" : v));
    if (v != null) amt.appendChild(trEl("span", "ccy", trUnit()));
    row.appendChild(amt); box.appendChild(row);
  });
  if (trIsPaper()) box.appendChild(trEl("div", "pf-foot", t("cx.perfNote")));
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
    const sym = String(o.symbol || ""), ss = trEl("span", "mono", sym.replace(/@spot$/, ""));
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
    const amt = trEl("span", "amt mono"), val = trFmt(hasFill ? fill : target);
    amt.textContent = val == null ? "—" : val;
    if (val != null) {
      amt.appendChild(trEl("span", "ccy", trUnit()));
      if (hasFill && target > 0 && trFmt(target) !== val) amt.title = t("tr.orderTarget", { amount: trFmt(target) + " " + trUnit() });
    }
    row.appendChild(amt);
    const px = legs.map((l) => trFmtPrice(l && l.fill_price)).filter(Boolean);
    row.appendChild(trEl("span", "px mono", px.length ? "@ " + px.join(" → ") : ""));
    row.appendChild(trEl("span", "ex mono", trVenueLabel(String(o.exchange || ""), true)));
    log.appendChild(row);
  });
  box.appendChild(log);
  box.appendChild(trEl("div", "pf-foot unit-note", t("tr.unitNote", { c: trUnit() })));   // 窄欄(<520)時列內的單位收到這一行
  if (trIsPaper()) box.appendChild(trEl("div", "pf-foot", t("cx.perfNote")));
}
function trPaintSet() {
  const box = $("tr-set"), id = trVenueId();
  const ro = TR.env === "cloud";
  if (!trShould("set", box, [id, TR.unbinding, ro])) return;
  box.textContent = "";
  const sec = trSec(trEl("span", "label", t("tr.account")));
  const acts = trEl("span", "pf-acts"), b = trEl("button", "pf-act", TR.unbinding ? t("tr.unbinding") : t("tr.unbind"));
  b.type = "button";
  if (ro) { b.classList.add("is-ro"); b.setAttribute("aria-disabled", "true"); b.setAttribute("aria-describedby", "tr-ro-note"); }
  else { b.disabled = !!TR.unbinding || !id || !trEnvNames(id).length; b.addEventListener("click", () => trUnbind(b)); }
  acts.appendChild(b); sec.appendChild(acts); box.appendChild(sec);
  box.appendChild(trEl("div", "pf-foot", ro ? t("tr.cloud.unbindDesc") : t("tr.unbindDesc")));
}
// 解除綁定要移掉的環境變數名。宿主(daemon.js argsOk)只放行這一版認得的 key,多送一個就整包 BAD_ARGS;
// Binance 那批上線時跟宿主的白名單一起加。
function trEnvNames(id) { return id === PAPER ? ["PAPER_API_KEY", "PAPER_SECRET_KEY", "PAPER_BOUND_TS"] : []; }
function trUnbind(opener) {
  const S = TR, id = trVenueId(); if (S.env !== "local" || !id) return;
  confirmBox({
    title: t("tr.unbind"), mark: id === PAPER ? t("tr.mode.paper") : null, lines: [t("tr.unbindWarn")], ok: t("tr.unbind"), opener,
    onOk: async () => {
      const mine = () => TR === S && S.open;
      S.unbinding = true; if (mine()) trPaintSet();
      const res = await S.api.tradeSend("credentials_remove", { env: trEnvNames(id) });
      S.unbinding = false; S.sig = {};
      if (!res || !res.ok) { trAlert(trSendError(res, "unbind"), "noaccount", S); if (mine()) { trPaintSet(); $("tr-tab-set").focus(); } trPollSoon(1500); return; }
      trAlert("", null, S); S.edits = {};
      if (mine()) $("tr-nav").focus();             // 這個分頁馬上會整個換成 onboard:焦點先停在入口
      trPollSoon(300);
    },
  });
}

/* ── 總覽:PnL 條 + 權益曲線 + 事件時間軸 ─────────────────────────
   雲端這一頁吃平台的兩支 api(每小時權益快照、事件流)。電腦版沒有平台那一層,由宿主(daemon.js)代勞:
   tradeEquity = app 開著時每個整點記一筆的權益(依「這次綁定」切段);tradeEvents = 從這個 app 的畫面做的暫停/恢復/連接/解除。
   本機沒有「未實現損益」這個數字,所以 PnL 條只有兩格(設計師裁定 8:MVP 只少不改;數字有了再放回第三格)。 */
const TR_RANGES = [["1D", 1], ["1W", 7], ["1M", 30], [null, 90]];
const TR_GAP_S = 7200;            // 每個整點一筆:相鄰點超過 2 小時 = Blave 沒開著,斷線不連(不插值)
async function trLoadCurve() {
  const S = TR;
  try { S.ov.curve = (await S.api.tradeEquity({ days: S.ov.days })) || { curve: [] }; } catch (_) { S.ov.curve = { curve: [] }; }
  try { const ev = await S.api.tradeEvents({ days: S.ov.days }); S.ov.ui = Array.isArray(ev) ? ev : []; } catch (_) { S.ov.ui = []; }
  S.sig.over = null; if (TR === S && S.open && S.tab === "over") trPaintOver();
}
function trCurvePoints() {
  const raw = TR.ov.curve && Array.isArray(TR.ov.curve.curve) ? TR.ov.curve.curve : [];
  const pts = raw.filter((p) => p && typeof p.ts === "number" && isFinite(p.ts) && typeof p.equity === "number" && isFinite(p.equity))
    .map((p) => ({ t: p.ts, v: p.equity })).sort((a, b) => a.t - b.t);
  const from = Date.now() / 1000 - TR.ov.days * 86400;
  return pts.filter((p) => p.t >= from);
}
function trPaintOver() {
  const box = $("tr-over"), r = trReport() || {};
  if (!TR.ov.curve || (TR.ov.at || 0) < Date.now() - 60000) { TR.ov.at = Date.now(); trLoadCurve(); }
  const data = [TR.env, trEquity(), trUnit(), TR.ov.mode, TR.ov.days, TR.ov.curve, TR.ov.ui, r.orders, r.halt, r.events, r.order_errors];
  if (!trShould("over", box, data)) return;
  box.textContent = "";
  box.appendChild(trOvStats());
  // 雲端第一刀:每小時權益的端點還沒做,不畫曲線(也不畫「還沒有紀錄」——紀錄是有的,只是這一版讀不到)
  if (TR.env !== "cloud") box.appendChild(trOvCurve());
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
  if (s != null) sv.appendChild(trEl("span", "unit", trUnit()));
  c.appendChild(sv);
  if (sub) c.appendChild(trEl("div", "sub mono", sub));
  return c;
}
// 百分比:四捨五入後是 0 就寫「0.00%」,不帶正負號(不出現「-0.00%」)
function trPct(p) { const r = Math.round(p * 100) / 100; return (r > 0 ? "+" : r < 0 ? "-" : "") + Math.abs(r).toFixed(2) + "%"; }
function trOvStats() {
  const grid = trEl("div", "bt-stats ov-stats"), cv = TR.ov.curve || {};
  grid.appendChild(trStatCell(t("tr.ov.equity"), trEquity(), { hero: true }, null, t("tr.ov.equityTip")));
  if (TR.env === "cloud") return grid;             // 當日損益要有每小時權益才算得出來:同上,這一版不畫
  // today = null:沒有夠新的基準(app 好幾天沒開)→「—」,不拿好幾天前的點冒充「當日」
  const today = cv.today && typeof cv.today === "object" ? cv.today : {};
  const dp = typeof today.pnl === "number" && isFinite(today.pnl) ? today.pnl : null;
  const pct = dp != null && typeof today.start_equity === "number" && today.start_equity > 0 ? (dp / today.start_equity) * 100 : null;
  grid.appendChild(trStatCell(t("tr.ov.day"), dp, { signed: true }, pct == null ? null : trPct(pct)));
  return grid;
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
  const pts = trCurvePoints();
  if (pts.length < 2) {
    frag.appendChild(trEl("div", "pf-state", pts.length ? t("tr.ov.emptyBaseline") : t("tr.ov.empty")));
    return frag;
  }
  const isPnl = TR.ov.mode === "pnl";
  const series = isPnl ? pts.map((p) => ({ t: p.t, v: p.v - pts[0].v })) : pts;
  const frame = trEl("div", "ov-frame"), canvas = trEl("canvas", "ov-canvas"), hover = trEl("div", "ov-hover");
  // 圖本身沒有可讀的數字:起訖值與筆數放進 label
  const first = series[0], last = series[series.length - 1];
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", t("tr.ov.curveAria", { a: trFmt2(first.v, isPnl) + " " + trUnit(), b: trFmt2(last.v, isPnl) + " " + trUnit(), n: series.length }));
  frame.append(canvas, hover); frag.appendChild(frame);
  if (series.some((p, i) => i > 0 && p.t - series[i - 1].t > TR_GAP_S)) frag.appendChild(trEl("div", "pf-foot", t("tr.ov.gapNote")));
  requestAnimationFrame(() => trDrawCurve(canvas, series, isPnl));
  canvas.addEventListener("mousemove", (e) => {
    const g = TR.ov.geo; if (!g) return;
    const x = e.offsetX; let best = null;
    series.forEach((p) => { const d = Math.abs(g.xAt(p.t) - x); if (!best || d < best.d) best = { d, p }; });
    if (best) hover.textContent = trStamp(best.p.t) + "  " + trFmt2(best.p.v, isPnl) + " " + trUnit();
  });
  canvas.addEventListener("mouseleave", () => { hover.textContent = ""; });
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
  TR.ov.geo = { xAt };
  ctx.font = "10px " + (getComputedStyle(canvas).fontFamily || "sans-serif");
  ctx.fillStyle = trToken("--ink-3"); ctx.strokeStyle = trToken("--border-hairline"); ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const v = lo + ((hi - lo) * i) / 3, y = Math.round(yAt(v)) + 0.5;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.fillText(trFmt2(v, isPnl) || "", W - padR + 6, y + 3);
  }
  ctx.fillText(trStamp(t0), padL, H - 6);
  const endLabel = trStamp(t1); ctx.fillText(endLabel, W - padR - ctx.measureText(endLabel).width, H - 6);
  // 線色固定用主資料序列色(同雲端):賺賠訊號歸 PnL 條的數字,曲線不隨賺賠變色
  ctx.strokeStyle = trToken("--color-data-1"); ctx.lineWidth = 1.5; ctx.lineJoin = "round";
  ctx.beginPath();
  pts.forEach((p, i) => { const gap = i === 0 || p.t - pts[i - 1].t > TR_GAP_S; if (gap) ctx.moveTo(xAt(p.t), yAt(p.v)); else ctx.lineTo(xAt(p.t), yAt(p.v)); });
  ctx.stroke();
  // 電腦版的常態是每天開一小段:點與點之間幾乎都是缺口。只連線的話孤立點完全不出現、整張圖只剩格線(設計師 A-1)。
  // 每一段(含只有一個點的段)的兩個端點畫實心圓點;不跨缺口連線、不插值。
  ctx.fillStyle = trToken("--color-data-1");
  pts.forEach((p, i) => {
    const gapBefore = i === 0 || p.t - pts[i - 1].t > TR_GAP_S, gapAfter = i === pts.length - 1 || pts[i + 1].t - p.t > TR_GAP_S;
    if (!gapBefore && !gapAfter) return;
    ctx.beginPath(); ctx.arc(xAt(p.t), yAt(p.v), 2, 0, Math.PI * 2); ctx.fill();
  });
}
// 機器側事件 → 兩段字(標題、後果註解)。白名單:不認得的型別不畫
function trEventText(type, d) {
  const v = { venue: trVenueLabel(String(d.venue || ""), true), minutes: d.minutes };
  if (type === "exchange_unreachable") return [t("tr.ov.evExUnreach", v), t("tr.ov.evExUnreachNote")];
  if (type === "exchange_recovered") return [t("tr.ov.evExBack", v), null];
  if (type === "bar_stale") return [t("tr.ov.evBarStale"), d.minutes == null ? null : t("tr.ov.evBarStaleNote", v)];
  if (type === "execution_fallback_market") return [t("tr.ov.evExecFallback"), t("tr.ov.evExecFallbackNote")];
  if (type === "execution_interrupted") return [t("tr.ov.evExecInterrupted"), t("tr.ov.evExecInterruptedNote")];
  if (type === "execution_stuck") return [t("tr.ov.evExecStuck"), t("tr.ov.evExecStuckNote")];
  if (type === "scheduler_error") return [t("tr.ov.evSchedErr"), t("tr.ov.evSchedErrNote")];
  if (type === "strategy_failed") return [t("tr.ov.evStrategyFailed"), t("tr.ov.evStrategyFailedNote")];
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
      body.append(" ", trEl("span", "mono", sym.replace(/@spot$/, "")), " ", trEl("span", "dim", /@spot$/.test(sym) ? t("tr.mkt.spot") : t("tr.mkt.swap")));
      const legs = Array.isArray(o.legs) ? o.legs : [], px = legs.map((l) => trFmtPrice(l && l.fill_price)).filter(Boolean);
      const amt = trFmt(Math.abs(typeof o.signed_diff === "number" ? o.signed_diff : NaN));
      if (amt != null) {
        const m = trEl("span", "mono", amt); m.appendChild(trEl("span", "ccy", trUnit())); body.append(" ", m);
        if (px.length) body.append(" ", trEl("span", "mono", "@ " + px.join(" → ")));
      }
    });
  });
  /* 從這個 app 的畫面做的動作(宿主在指令 ack 成功時記的;聊天裡做的不會有)。用雲端既有的事件句。
     有了它,「已暫停下單」那一列在恢復之後不會消失,也才有「已恢復下單 / 已連接 / 已解除」。 */
  const ui = Array.isArray(TR.ov.ui) ? TR.ov.ui : [], uiHalts = [];
  ui.forEach((ev) => {
    if (!ev || typeof ev.ts !== "number" || typeof ev.type !== "string") return;
    const venue = trVenueLabel(String(ev.venue || ""), true);
    let head = null, note = null;
    if (ev.type === "halt" || ev.type === "halt_close") { head = t("tr.ov.evHalt"); note = t("tr.ov.evHaltNote"); uiHalts.push(ev.ts * 1000); }
    else if (ev.type === "resume" || ev.type === "resume_wait") { head = t("tr.ov.evResume"); note = t("tr.ov.evResumeNote"); }
    else if (ev.type === "venue_connected" && venue) head = t("tr.ov.evConnected", { venue });
    else if (ev.type === "venue_disconnected" && venue) head = t("tr.ov.evDisconnected", { venue });
    if (!head) return;
    push(ev.ts * 1000, (body) => { body.appendChild(trEl("span", "hl", head)); if (note) body.append(" ", trEl("span", "dim", "— " + note)); });
  });
  // 目前的 HALT(狀態檔的現況):畫面上按的那一次已經在上面了,兩分鐘內的同一件事不重複列;自動暫停、聊天裡的暫停只有這裡看得到
  const halt = r.halt || {}, haltMs = trMs(halt.at);
  if (halt.halted && !uiHalts.some((x) => haltMs != null && Math.abs(x - haltMs) < 120000)) push(haltMs, (body) => {
    body.appendChild(trEl("span", "hl", halt.source && halt.source !== "web" ? t("tr.ov.evHaltAuto") : t("tr.ov.evHalt")));
    body.append(" ", trEl("span", "dim", "— " + t("tr.ov.evHaltNote")));
  });
  (Array.isArray(r.order_errors) ? r.order_errors : []).forEach((e) => {
    if (!e || typeof e !== "object") return;
    push(trMs(e.ts), (body) => {
      body.appendChild(trEl("span", "sell", t("tr.ov.evErr")));
      body.append(" ", trEl("span", "mono", String(e.symbol || "").replace(/@spot$/, "")), " ", trEl("span", "dim", "— " + String(e.error || e.message || "").slice(0, 160)));
    });
  });
  (Array.isArray(r.events) ? r.events : []).forEach((ev) => {
    if (!ev || typeof ev.type !== "string") return;
    const evd = ev.payload && typeof ev.payload === "object" ? ev.payload : ev.data && typeof ev.data === "object" ? ev.data : ev;   // 機器事件的欄位叫 payload(runtime/events.py);data 是平台格式
    const txt = trEventText(ev.type, evd);
    if (!txt) return;
    push(trMs(ev.ts), (body) => { body.appendChild(trEl("span", "hl", txt[0])); if (txt[1]) body.append(" ", trEl("span", "dim", "— " + txt[1])); });
  });
  if (!rows.length) { frag.appendChild(trEl("div", "pf-state", t("tr.ov.evEmpty"))); return frag; }
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
      head.appendChild(trEl("span", "mono", tr2(d.getMonth() + 1) + "-" + tr2(d.getDate())));
      list.appendChild(head);
    }
    const row = trEl("div", "ev-row"), body = trEl("span", "body");
    row.append(trEl("span", "ts mono", trHM(x.ms)), body); x.build(body);
    list.appendChild(row);
  });
  return frag;
}

/* ── 設定 › 連線:交易帳戶(這一版只有模擬交易;資料來源那一段這批不做、也不放預告)────────── */
function cxOpen() { setOpen().then(() => { setCat("conn"); const b = document.querySelector('.set-cat[data-set-cat="conn"]'); if (b) b.focus(); }); }
function cxPaint() { return trWith(TR_BAGS.local, cxPaint0); }
function cxPaint0() {
  const box = $("set-conn"), r = trReport();
  const ids = trVenueIds(r), id = ids[0] || null, e = id ? trLiveEntry(r, id) : null;
  const data = [!!r, TR.st && TR.st.alive, ids, e && [e.ok, e.error, e.equity], TR.cx];
  const sig = LANG + "|" + JSON.stringify(data);
  if (TR.sig.cx === sig && box.firstChild) return;
  TR.sig.cx = sig;
  const hadFocus = box.contains(document.activeElement) ? document.activeElement.id : null;
  box.textContent = ""; box.classList.add("cx");
  box.appendChild(trEl("p", "keys-lead", t("cx.lead")));
  const head = trEl("p", "cn-head");
  head.append(trEl("span", "cn-ttl", t("cx.acct.title")), trEl("span", "cn-meta", t("cx.acct.meta")));
  box.appendChild(head);
  if (id) cxPaintBound(box, id, e); else cxPaintForm(box);
  if (TR.cx.err) box.appendChild(trEl("p", "pf-alert", TR.cx.err));
  const back = hadFocus && $(hadFocus); if (back && !back.disabled) back.focus();
  else if (hadFocus) { const b = document.querySelector('.set-cat[data-set-cat="conn"]'); if (b) b.focus(); }
}
function cxPaintForm(box) {
  const lab = trEl("label", "fld"); lab.appendChild(trEl("span", "fld-l", t("cx.venue")));
  const w = trEl("span", "f-selw"), sel = trEl("select", "f-input"); sel.id = "cx-venue";
  const o = trEl("option", "", t("cx.paper")); o.value = PAPER; sel.appendChild(o);
  w.appendChild(sel); lab.appendChild(w); box.appendChild(lab);
  box.appendChild(trEl("p", "cx-manual-note", t("cx.paperNote")));
  const act = trEl("div", "form-act");
  const b = trEl("button", "btn-fill", TR.cx.busy ? t("cx.connecting") : t("cx.connect")); b.type = "button"; b.id = "cx-go";
  b.disabled = TR.cx.busy;
  b.addEventListener("click", cxConnect);
  act.appendChild(b); box.appendChild(act);
}
function cxPaintBound(box, id, e) {
  const row = trEl("div", "cx-row");
  row.appendChild(trEl("span", "n", trVenueLabel(id)));
  if (id === PAPER) row.appendChild(trEl("span", "mode paper", t("tr.mode.paper")));
  const failed = !!e && !e.ok;
  const st = trEl("span", "cn-st" + (failed ? "" : " on"));
  if (e && e.ok) st.appendChild(trEl("i", "dot"));   // 綠點 = 讀得到帳戶;「串接中…」還沒有
  st.appendChild(trEl("span", "", failed ? t("cx.failShort") : e ? t("cx.connected") : t("cx.connecting")));
  row.appendChild(st); box.appendChild(row);
  if (failed) {
    const m = /^([a-z_]+):\s*(.*)$/i.exec(String(e.error || ""));
    box.appendChild(trEl("p", "pf-alert", t("cx.fail", { id: trVenueLabel(id, true), stage: m ? m[1] : "—", msg: (m ? m[2] : String(e.error || "")).slice(0, 200) })));
  }
  if (id === PAPER) box.appendChild(trEl("p", "cx-manual-note", t("cx.perfNote")));
  const act = trEl("div", "row-act");
  const b = trEl("button", "btn-out", TR.cx.retest ? t("cx.retesting") : t("cx.retest")); b.type = "button"; b.id = "cx-retest";
  b.disabled = TR.cx.retest;
  b.addEventListener("click", cxRetest);
  act.appendChild(b); box.appendChild(act);
  // 指路那一句裡的「自動下單 › 設定」是可按的:關設定、直接開到那個分頁
  const hint = trEl("p", "cx-manual-note"), parts = t("cx.unbindHint").split("{link}");
  const go = trEl("button", "btn-quiet", t("cx.unbindLink")); go.type = "button"; go.id = "cx-to-set";
  go.addEventListener("click", () => { setClose(); envSwitch("local", "link"); trOpen("set").then(() => $("tr-tab-set").focus()); });
  hint.append(parts[0] || "", go, parts[1] || ""); box.appendChild(hint);
}
function cxSendFail(res) {
  const e = res && res.error ? String(res.error) : "", k = trErrorKind(e), L = TR_BAGS.local;
  if (k === "unknown") return t("tr.cmdUnknown");
  if (e === "DAEMON_DOWN" || !L.st || !L.st.alive) return t("cx.down");
  return k === "rejected" ? t("tr.cmdRejected", { err: e.slice(0, 200) }) : t("cx.sendFail", { err: e.slice(0, 200) || "—" });
}
async function cxConnect() {
  const L = TR_BAGS.local;
  if (L.cx.busy) return;
  L.cx = { busy: true, err: null, retest: false }; cxPaint();
  // 模擬交易的綁定:同雲端,寫一組固定值的 PAPER_* 進 workspace 的 .env(不是金鑰,是「已啟用」的記號)
  const res = await L.api.tradeSend("credentials", { env: { PAPER_API_KEY: "paper", PAPER_SECRET_KEY: "paper", PAPER_BOUND_TS: String(Math.floor(Date.now() / 1000)) } });
  L.cx.busy = false;
  if (!res || !res.ok) { L.cx.err = cxSendFail(res); srSay(L.cx.err); cxPaint(); return; }
  srSay(t("cx.connected"));
  try { L.st = await L.api.tradeStatus(); } catch (_) { }   // 輪詢會補
  L.sig = {}; cxPaint(); trPaint(); trPollSoon(1500);
}
async function cxRetest() {
  const L = TR_BAGS.local;
  if (L.cx.retest) return;
  L.cx = { busy: false, err: null, retest: true }; cxPaint();
  const res = await L.api.tradeSend("retest_accounts", {});
  L.cx.retest = false;
  if (!res || !res.ok) { L.cx.err = cxSendFail(res); srSay(L.cx.err); }
  cxPaint(); trPollSoon(1500);
}

/* ── 視角:「這台電腦｜雲端」切換器、頂列灰底、雲端側欄、雲端空態(spec-desktop-local-and-cloud §1–§4.1)────────
   除了切換器、⌘1/⌘2 與畫面上的文字鈕,沒有任何東西會自己切視角;重開 app 一律回到這台電腦(雲端可能是真錢,開場不該落在那裡)。
   雲端來的字串(策略名)一律 textContent。 */
function envWire() {
  $("envsw").addEventListener("click", (e) => { const b = e.target.closest("button[data-env]"); if (b) envSwitch(b.dataset.env); });
  // ⌘1 / ⌘2:輸入框有焦點時也生效;確認框、圖片放大開著時不生效(先讓人處理眼前那個框),設定開著可以
  document.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;   // 輸入法組字中:不搶(搬焦點會把組到一半的字提交或丟掉)
    if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || (e.key !== "1" && e.key !== "2")) return;
    if ($("view-ws").hidden || !$("del-scrim").hidden || !$("lb-scrim").hidden) return;
    e.preventDefault(); envSwitch(e.key === "1" ? "local" : "cloud");
  });
  // 主行程說雲端那邊變了(另一邊出事、登入登出):下一輪就去拿新的那一份
  if (typeof window.blave.onCloudState === "function") window.blave.onCloudState(() => { ENV.cloudDirty = true; trPollSoon(0); });
  document.documentElement.dataset.env = "local";
}
function envSwitch(env, via) {
  if (env !== "local" && env !== "cloud") return;
  const head = () => { const h = $("cv-empty").hidden ? $("tr-h") : $("cv-h"); if (h && h.offsetParent) h.focus(); };
  if (env === ENV.cur) { if (via === "link") head(); return; }
  // 順序(spec §1.4):關確認框(等同取消,焦點不回 opener)→ 存這一邊 → 換 → 畫 → 標題 → 播報
  // 關確認框這一行**目前走不到**:確認框開著時 ⌘1/⌘2 不生效、#view-ws 是 inert(切換器點不到)。留著當保險——
  // 批次 ② 選單列的「顯示」兩項進來之後,才有確認框開著也能切視角的入口。
  if (!$("del-scrim").hidden) { if (delCtx) delCtx.opener = null; delClose(false); }
  const from = TR_BAGS[ENV.cur], list = $(ENV.cur === "cloud" ? "strat-list-cloud" : "strat-list");
  from.scroll = { list: list.scrollTop, tab: from.tab && !$("tr-" + from.tab).hidden ? $("tr-" + from.tab).scrollTop : 0 };
  // 焦點在面板裡的輸入框時 trShould 會跳過重畫(打到一半不能被輪詢洗掉)——切視角不是輪詢:先放掉焦點,
  // 不然另一邊的金額表(含輸入框、儲存列)會留在這一邊的標題底下(稽核 N4)
  const ae = document.activeElement; if (ae && ae.tagName === "INPUT" && $("tr").contains(ae)) ae.blur();
  ENV.cur = env; TR = TR_BAGS[env]; TR.sig = {}; ENV.sig = {};
  document.documentElement.dataset.env = env;
  if (env === "cloud") { ENV.cloudDirty = true; TR.open = true; }
  envShowLocalMain();
  trPaint(); trAlertShow();
  if (TR.open && TR.tab && !$("tr-tabs").hidden) trSetTab(TR.tab);   // 分頁列是共用的 DOM:底線與 tabindex 換成這一邊的
  // 策略報告的圖若是在看雲端時畫的(agent 那一輪剛改了策略),那時容器是藏著的、量不到寬:切回來重畫一次
  if (env === "local" && !$("rp").hidden && RP.data) { RP.drawn = {}; rpShowTab(RP.data.stats ? RP.tab : "code"); }
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
// 這台電腦的中欄三個視圖(自動下單 / 策略報告 / welcome)誰該出現;雲端視角時三個都收起來(各自的狀態不動,切回來原樣)
function envShowLocalMain() {
  const L = TR_BAGS.local, cloud = ENV.cur === "cloud", rp = !L.open && !!(RP.name && RP.data);
  $("rp").hidden = cloud || !rp;
  $("main-empty").hidden = cloud || L.open || rp;
  if (!cloud) { $("tr").hidden = !L.open; if (L.open) $("tr-nav").setAttribute("aria-current", "page"); else $("tr-nav").removeAttribute("aria-current"); }
}
/* 每一輪都叫(trPaint 的第一步):切換器兩格、側欄、視窗標題、雲端空態。回 false = 中欄現在是雲端空態,自動下單頁不必畫。
   每一塊都有自己的指紋,沒變就不碰 DOM(焦點與 hover 不被輪詢洗掉)。 */
function envPaint() {
  const cloud = ENV.cur === "cloud", C = TR_BAGS.cloud, kind = envCloudKind(C.st);
  const cells = { local: envCell("local", TR_BAGS.local.st, !!TR_BAGS.local.pending), cloud: envCell("cloud", C.st, false) };
  ["local", "cloud"].forEach((env) => envPaintCell(env, cells[env]));
  // 側欄
  const gate = cloud && kind !== "running" && kind !== "stopped";
  $("side-nav").hidden = gate; $("strat-head").hidden = gate;
  $("strat-list").hidden = cloud; $("strat-list-cloud").hidden = !cloud || gate;
  $("chat-tgt").hidden = !cloud;
  if (cloud) envPaintSide(kind, C.st);
  const cur = cells[ENV.cur];
  $("tr-nav-mode").hidden = !cur.money; $("tr-nav-mode").className = "mode " + (cur.money || "paper"); $("tr-nav-mode").textContent = envMoneyText(cur.money);
  $("tr-nav-dot").hidden = !cur.run;
  // 視窗標題:{money} 是空的就連同前面的「 · 」一起省略
  const money = envMoneyText(cur.money);
  document.title = money ? t("env.winTitle", { where: envName(ENV.cur), money }) : t("env.winTitle0", { where: envName(ENV.cur) });
  // 中欄
  $("cv-empty").hidden = !gate;
  if (gate) { $("tr").hidden = true; $("tr-tb-txt").textContent = ""; ENV.sig.tb = null; $("tr-tb-mode").hidden = true; envPaintEmpty(kind); return false; }
  if (cloud) { TR.open = true; $("tr").hidden = false; $("tr-nav").setAttribute("aria-current", "page"); }
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
function envPaintSide(kind, st) {
  // 側欄頂不寫「雲端 / 這台電腦」(Wei:最上面的切換器已經有了);這裡只畫雲端那幾份策略
  const list = kind === "running" || kind === "stopped" ? envCloudList(st) : [];
  const sig = LANG + "|" + JSON.stringify([kind, list.map((x) => [x.name, x.displayName, envStratWord(x.name, st)])]);
  if (ENV.sig.side === sig) return;
  ENV.sig.side = sig;
  // 第一刀:只當清單看(單支策略的端點還沒做)——不是鈕、沒有 hover、Tab 不會停
  const box = $("strat-list-cloud"); box.textContent = ""; box.setAttribute("role", "list");
  if (!list.length) { box.appendChild(trEl("p", "pf-state", t("side.cloud.emptyCut1"))); return; }
  list.forEach((x) => {
    const row = trEl("div", "strat-row is-static"); row.setAttribute("role", "listitem");
    const nm = trEl("span", "strat-name", x.displayName); nm.title = x.name; row.appendChild(nm);
    const w = envStratWord(x.name, st); if (w) row.appendChild(trEl("span", "stx", t(w)));
    box.appendChild(row);
  });
}
function envPaintEmpty(kind) {
  // 有 token 卻被當成沒登入 = 舊登入沒有 app 專用密鑰,或憑證被撤銷:請他重新登入一次(不是「登入」)
  const relogin = kind === "signedOut" && hasToken;
  const sig = LANG + "|" + kind + "|" + relogin + "|" + (kind === "signedOut" ? oauthPending : "");
  if (ENV.sig.empty === sig) return;
  ENV.sig.empty = sig;
  $("cv-desc").textContent = kind === "starting" ? t("side.cloud.starting") : kind === "loading" || kind === "unreach" ? "" : t("env.empty.desc");
  const box = $("cv-body"); box.textContent = "";
  if (kind === "loading") { box.appendChild(trEl("div", "pf-state", t("tr.loading"))); return; }
  const ob = trEl("div", "pf-onboard");
  const body = kind === "none" ? "env.empty.p1" : kind === "starting" ? "env.empty.starting" : kind === "unreach" ? "env.empty.unreach" : relogin ? "env.empty.relogin" : "env.empty.signedOut";
  ob.appendChild(trEl("p", "", t(body)));
  let b = null;
  if (kind === "none") { b = trEl("button", "btn-out", t("env.empty.plan")); b.addEventListener("click", () => planOpen()); }
  else if (kind === "signedOut") {
    b = trEl("button", "btn-out", relogin ? t("plan.relogin") : t("cn.blave.btn"));
    // 登入成功後主行程會自己重問雲端並推送過來;這裡只要把這一頁重畫
    b.addEventListener("click", () => Promise.resolve(relogin ? planRelogin() : planLogin()).then(() => { ENV.sig.empty = null; ENV.cloudDirty = true; trPollSoon(0); }));
  }
  if (b) { b.type = "button"; ob.appendChild(b); }
  box.appendChild(ob);
}
