/* 建議下一步 v2(spec suggest-next-step-v2 §0、§1):輸入框裡的單行灰字,Tab 或 → 填入、Enter 才送,一打字就藏。
   在 app.js 之後載入(用它的 $、sessionId、running、composing、attachedFiles、autosize、srSay、trackFeature、motionBaseMs、escTop、lsGet、lsSet)。
   runtime 回合收尾把 <suggest> 剝成 {type:"suggestions", items, kind};這裡先收著,回合結束(沒出錯、沒被停)停一拍才畫。
   句子只在記憶體:重開 app、換對話都不留——同雲端(逐字稿裡沒有這段)。開關與兩個計數在 localStorage,各台電腦各自計。 */
const SUG = { pending: null, timer: null, text: null, kind: null, shownOnce: false, used: false, filledText: null, inflight: null };
// 下面七個跟網頁工作頁同名同值(web tests/check_suggest_v2.js 與 tests/check_web_desktop_parity.js 逐字比對原文)
const SUG_MAX_CHARS = 200;
const SUG_MISS_LIMIT = 5;
const SUG_TAB_LEARNED = 3;
const SUG_NAV_PREFIXES = ["帶我看怎麼", "带我看怎么", "show me how"];   // 同 runtime _SUGGEST_NAV_HEADS:舊 runtime 不帶 kind 時自己判
const SUG_KEY_ON = "ws_sug_on";
const SUG_KEY_MISS = "ws_sug_miss";
const SUG_KEY_TAB = "ws_sug_tab";

const sugOn = () => lsGet(SUG_KEY_ON) !== "0";
const sugNum = (k) => { const n = parseInt(lsGet(k), 10); return n > 0 ? n : 0; };
const sugReduced = () => sugNum(SUG_KEY_MISS) >= SUG_MISS_LIMIT;
// 送出時帶給 runtime(--suggest-mode):畫不出來的那一句改寫進正文
function sugMode() { return !sugOn() ? "off" : sugReduced() ? "reduced" : "normal"; }

/* 純函式(tests/check_shell_suggest.js 跑網頁那份 web/tests/suggest_vectors.json):chunk → { text, kind } 或 null。
   VM 寫的字是不可信輸入:只看 items[0](舊 runtime 一次給 3 句),非字串、空白、超過 200 字整句丟,不往後找 */
function sugKindOf(text) {
  const head = String(text).replace(/^\s+/, "").toLowerCase();
  return SUG_NAV_PREFIXES.some((p) => head.startsWith(p.toLowerCase())) ? "nav" : "step";
}
function sugPick(c) {
  const s = Array.isArray(c && c.items) ? c.items[0] : null;
  if (typeof s !== "string" || !s.trim() || s.length > SUG_MAX_CHARS) return null;
  return { text: s.trim(), kind: c.kind === "nav" || c.kind === "step" ? c.kind : sugKindOf(s) };
}
function sugChunk(c) {
  if (c && c.session_id && c.session_id !== sessionId) return;
  const p = sugPick(c);
  SUG.pending = null;
  if (!p || !sugOn()) return;
  if (p.kind === "step" && sugReduced()) return;   // 後備:新 runtime 收到 reduced 本來就不出 step 句
  SUG.pending = p;
}
function sugTurnEnd(ok) {
  const p = SUG.pending;
  SUG.pending = null;
  if (!ok || !p) return;
  clearTimeout(SUG.timer);
  SUG.timer = setTimeout(() => {
    SUG.timer = null;
    if (running) return;   // 停一拍之間又送出了一句:這句已經過期
    Object.assign(SUG, { text: p.text, kind: p.kind, shownOnce: false, used: false, filledText: null });
    sugPaint();
  }, motionBaseMs());
}
// 在場 = 有一句沒作廢、沒用過,輸入框是空的、沒有附件、不在組字中、沒有回合在跑。不在場就先等,等到在場那一刻才畫
function sugPresent() {
  return !!SUG.text && !SUG.used && !running && !composing && $("ta").value === "" && !attachedFiles.length;
}
function sugPaint() {
  const show = sugPresent(), field = $("ta-field"), ta = $("ta");
  field.classList.toggle("has-ghost", show);
  if (!show) { ta.removeAttribute("aria-describedby"); return; }
  $("sug-ghost-t").textContent = SUG.text;
  $("sug-kbd").hidden = sugNum(SUG_KEY_TAB) >= SUG_TAB_LEARNED;
  $("sug-desc").textContent = t("ws.sugDesc", { s: SUG.text });
  ta.setAttribute("aria-describedby", "sug-desc");
  if (SUG.shownOnce) return;
  SUG.shownOnce = true;
  trackFeature("suggest_shown");
  srSay(t("ws.sugSay", { s: SUG.text }));
}
// 作廢:送出(任何入口)、出錯、換對話、Esc、關掉開關。不動 inflight——送出那一句要等回合真的跑起來才結算
function sugCollapse() {
  clearTimeout(SUG.timer); SUG.timer = null; SUG.pending = null;
  SUG.text = null; SUG.filledText = null;
  sugPaint();
}
function sugFill(byKey) {
  const ta = $("ta"), text = SUG.text;
  SUG.used = true; SUG.filledText = text;
  ta.value = text; autosize();
  ta.setSelectionRange(text.length, text.length);
  lsSet(SUG_KEY_MISS, "0");   // 用一次就解除減少狀態
  if (byKey) lsSet(SUG_KEY_TAB, String(sugNum(SUG_KEY_TAB) + 1));
  trackFeature("suggest_filled");
  sugPaint();
}
$("ta").addEventListener("keydown", (e) => {
  if (e.isComposing || e.keyCode === 229 || !sugPresent()) return;
  const bare = !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;
  if ((e.key === "Tab" || e.key === "ArrowRight") && bare) { e.preventDefault(); sugFill(true); return; }
  // Esc 掛在輸入框本身(比 document 層的 escTop 與 browser.js 先跑):有 modal / 選單、內建瀏覽器展開層開著讓它們先收;
  // 作廢了就 preventDefault,browser.js 看到便不收瀏覽器
  if (e.key !== "Escape" || e.defaultPrevented || escTop() || (typeof BR !== "undefined" && BR.exp)) return;
  e.preventDefault();
  sugCollapse();
});
// 打字就藏、刪回空白再出現(用過的那句不會回來);組字開始先藏,結束再看(composing 由 app.js 先更新)
["input", "compositionstart", "compositionend"].forEach((k) => $("ta").addEventListener(k, sugPaint));

/* 送出的結算(§1.4):sendDraft 清空輸入框之前先存快照,回合真的跑起來(app.js r.started)才算。
   沒經過 sendDraft 的入口(重送、卡片、策略庫)沒有快照,不算沒用 */
function sugSnap(msg) {
  SUG.inflight = { msg, filled: SUG.filledText, counts: !!SUG.text && SUG.shownOnce && !SUG.filledText };
}
function sugSettle(msg) {
  const inf = SUG.inflight;
  SUG.inflight = null;
  if (!inf || inf.msg !== msg) return;
  if (inf.filled) { trackFeature(msg === inf.filled.trim() ? "suggest_sent" : "suggest_sent_ed"); return; }
  if (!inf.counts) return;
  const n = sugNum(SUG_KEY_MISS) + 1;
  lsSet(SUG_KEY_MISS, String(n));
  trackFeature("suggest_missed");
  if (n === SUG_MISS_LIMIT) trackFeature("suggest_reduced");
}
// 沒送出去(busy、版本閘、暖機中停止、引擎起不來、讀不到附件):字由 stopRestore 放回輸入框,填入狀態跟著還原,不算沒用
function sugUnsend() {
  const inf = SUG.inflight;
  SUG.inflight = null;
  if (inf && inf.filled) { SUG.filledText = inf.filled; SUG.used = true; }
}

/* 設定 › 一般 › 輸入框建議 */
function sugSwPaint() {
  const on = sugOn(), sw = $("set-sug-sw");
  sw.classList.toggle("off", !on); sw.setAttribute("aria-checked", on ? "true" : "false");
}
$("set-sug-sw").addEventListener("click", () => {
  const on = !sugOn();
  if (on) { lsSet(SUG_KEY_ON, "1"); lsSet(SUG_KEY_MISS, "0"); }
  else { lsSet(SUG_KEY_ON, "0"); sugCollapse(); }
  trackFeature(on ? "suggest_on" : "suggest_off");
  sugSwPaint();
});
sugSwPaint();
