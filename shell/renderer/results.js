/* 聊天結果卡(blave-canon output/designer/spec-desktop-result-card-0.1.8.md,mockup A)。
   回合結束中欄一律不動:這一輪做出來的報告 / 策略,在那一則 agent 回覆的文字之後各出一張卡,用戶按了才換中欄。
   殼同 web 工作頁的轉出卡 .xp(bg-body、md、內距 12、無框無陰影、右邊一顆實心鈕);一輪超過 3 張收在「還有 N 個」。
   卡是那一輪的紀錄:存在主行程 state/chat-results/<session>/(每輪一列 { ts, items }),重開 app 照時間插回那一輪,
   畫之前對一次現況——不在了畫成無鈕的已刪除態、之後又改過加「之後有更新」。
   一輪的生命週期(app.js 接線):submitMessage → resTurnStart(記策略快照)→ onTurnEnd 開頭 resTurnClose()
   → stratRefresh / rptTurnEnd 之後 resTurnParts(rt, 報告)→ onTurnEnd 最後 resTurnEnd(rt, 碰過雲端)——那時回覆泡泡已定稿,卡才掛上去。
   雲端的報告 / 策略晚到(平台入庫最多 10 分鐘):resAdd(rt, items) 插回那一輪,不追加到對話最底。
   用到 app.js 的 $ / t / LANG / sessionId / RP / addMsg / scrollChat / srSay / trackFeature / stratSelect / rpShowTab / rpCloudSelect、
   reports.js 的 RPT / rptOpen / rptLoad / rptBag / rptShowRead / rptKey / rptFmtStamp / rptTypeKey、library.js 的 libEnv、
   trade.js 的 ENV / TR_BAGS / envCloudList / envSwitchGuarded、browser.js 的 BR / brCollapse——都在呼叫時才取(這支比它們先載)。 */

/* ── 純邏輯(tests/check_shell_results.js 從原文切出來跑;這一段不准碰 DOM / 全域)── */
const RES_CAP = 3;
const RES_CLOUD_POLL_MS = 30 * 1000, RES_CLOUD_WAIT_MS = 10 * 60 * 1000, RES_CLOUD_SLACK_S = 120;
/* 一支策略的三個簽章。回測 = stats.json 的 Generated At:只有明確回測會重蓋,live tick 每根 K 重寫 stats.json 但不動它
   (lib/runner.py _carry_over)——拿 stats 的 mtime 會把跑著的策略每輪都認成「回測」。舊檔沒有這欄才退回 mtime */
function resSig(x) { return { bt: typeof x.generatedAt === "number" ? x.generatedAt : x.statsMtime || 0, scan: x.scanMtime || 0, code: x.codeMtime || 0 }; }
function resStratVer(x) { const s = resSig(x); return s.bt + "|" + s.scan + "|" + s.code; }
function resSnapOf(list) { return new Map((Array.isArray(list) ? list : []).filter((x) => x && typeof x.name === "string").map((x) => [x.name, x])); }
// 這一輪對這支做了什麼(一支只出一張):新策略 > 回測 > 參數掃描 > 只改程式碼;沒動 = null
function resStratSub(prev, x) {
  if (!prev) return "new";
  const a = resSig(prev), b = resSig(x);
  if (b.bt && b.bt !== a.bt) return "backtest";
  if (b.scan && b.scan !== a.scan) return "scan";
  if (b.code !== a.code) return "code";
  return null;
}
const resNum = (v) => (typeof v === "number" && isFinite(v) ? v : null);
function resStratItem(x, prev, sub) {
  const f = { has_bt: !!x.hasBacktest };
  if ((sub === "new" || sub === "backtest") && x.hasBacktest) { f.total_return = resNum(x.totalReturn); f.max_dd = resNum(x.maxDrawdown); }
  // 版號只在這一輪真的定了新版才帶(lib/runner.py 只在明確回測時 mint);沒定版的回測寫「回測更新」
  if (sub === "backtest" && Number.isInteger(x.version) && (!prev || x.version !== prev.version)) f.version = x.version;
  const at = sub === "code" ? x.codeMtime : sub === "scan" ? x.scanMtime : Math.max(x.statsMtime || 0, x.codeMtime || 0);
  return { kind: "strategy", env: "local", ref: x.name, ver: resStratVer(x), sub, title: x.displayName || x.name, facts: f, at: at || 0 };
}
// snap = 回合開始時的清單(name → 摘要);沒有快照就不下結論(分不出新舊,寧可不出卡)
function resStratItems(snap, list) {
  if (!snap) return [];
  const out = [];
  for (const x of Array.isArray(list) ? list : []) {
    if (!x || typeof x.name !== "string") continue;
    const prev = snap.get(x.name), sub = resStratSub(prev, x);
    if (sub) out.push(resStratItem(x, prev, sub));
  }
  return out;
}
// key = 報告的版本鍵(reports.js rptKey:id + mtime / stored_at),重開時拿來比「之後有更新」。
// label = 閱讀頁類型標籤的那個字(meta.report_type;主行程從本機檔讀。雲端清單 api 沒給這一欄 → null)
function resReportItem(r, env, key) {
  return { kind: "report", env, ref: r.id, ver: key, sub: "report", title: r.title,
    facts: { created_at: resNum(r.created_at), type: typeof r.type === "string" ? r.type.slice(0, 32) : null, label: typeof r.label === "string" && r.label ? r.label.slice(0, 40) : null },
    at: env === "cloud" ? (resNum(r.stored_at) || 0) * 1000 : resNum(r.mtime) || 0 };
}
/* 雲端策略:清單只有 updated_at、沒有數字,卡上就沒有數字(spec §11-3)。
   updated_at 是平台收到內容換過的時間:跑著的策略每根 K 都重送績效,它一直在變——組合裡的那幾支只認「新出現」,不認「更新」。
   snap = 回合開始時的 name → updated_at(null = 那時還沒讀到雲端清單,只能講「更新」、不能講「新策略」) */
function resCloudItems(snap, list, sinceMs, live, seen) {
  const out = [], since = Math.floor(sinceMs / 1000) - RES_CLOUD_SLACK_S;
  for (const x of Array.isArray(list) ? list : []) {
    if (!x || typeof x.name !== "string" || seen.has(x.name)) continue;
    const isNew = !!snap && !snap.has(x.name), fresh = typeof x.mtime === "number" && x.mtime >= since;
    if (isNew ? !(x.mtime == null || fresh) : !(fresh && (!snap || x.mtime !== snap.get(x.name)) && !live.has(x.name))) continue;
    seen.add(x.name);
    out.push({ kind: "strategy", env: "cloud", ref: x.name, ver: typeof x.mtime === "number" ? x.mtime : null, sub: "cloud", title: x.displayName || x.name,
      facts: { is_new: isNew }, at: (typeof x.mtime === "number" ? x.mtime : since) * 1000 });
  }
  return out;
}
/* 報告卡第二行的類型字:跟閱讀頁的類型標籤同一個來源(label)。三種情況退回清單用的類型詞(f.typeKey):沒有 label(雲端、舊卡)、
   標題已經含那個字(閱讀頁這時不畫標籤)、label 只是 type 代號(lib/report.py 沒給 report_type 時的預設,不是給人看的字) */
function resTypeText(item, f) {
  const x = item.facts || {}, lb = typeof x.label === "string" ? x.label : "";
  if (lb && lb !== x.type && String(item.title || "").indexOf(lb) < 0) return lb;
  const tk = f.typeKey(x.type);
  return tk ? f.t(tk) : "";
}
const resSame = (a, b) => a.kind === b.kind && a.env === b.env && a.ref === b.ref;
// 依產出時間由舊到新(報告與策略混排,跟回覆敘事的先後一致);同時間照原順序
function resOrder(items) { return items.map((x, i) => [x, i]).sort((p, q) => (p[0].at - q[0].at) || (p[1] - q[1])).map((p) => p[0]); }
/* 重開時對現況:cur = undefined(那份清單沒讀到,不知道)/ null(清單上沒有)/ { ver }。雲端策略沒有數字,不講「之後有更新」 */
function resState(item, cur) {
  if (cur === undefined) return "ok";
  if (cur === null) return "gone";
  if (item.kind === "strategy" && item.env === "cloud") return "ok";
  return cur.ver !== item.ver ? "later" : "ok";
}
function resTab(item) { return item.sub === "scan" ? "rob" : item.sub === "code" || !item.facts.has_bt ? "code" : "bt"; }
function resBtnKey(item) {
  if (item.kind === "report") return "res.open.report";
  if (item.env === "cloud") return "res.open.strat";
  return { rob: "res.open.scan", code: "res.open.code", bt: "res.open.bt" }[resTab(item)];
}
/* 卡的第二行:一組一組([段, 段…]),組與組之間才換行(不用「·」分項:窄寬時會掛在行尾)。段 = { text, cls }:
   cls "v" = 數字(mono、ink-2)/ "mono" / "tag" = 雲端記號;缺值的那一組整組不放。
   f = { t, pct, stamp, typeKey }:i18n 與格式由呼叫端交進來(回測頁同一支 fmtSignedPct、報告清單同一支時間 / 類型) */
function resFacts(item, state, f) {
  const x = item.facts || {}, W = (text, cls) => ({ text, cls: cls || "" });
  if (state === "gone") return [[W(f.t(item.kind === "report" ? "res.gone.report" : "res.gone.strat"))]];
  const g = [];
  const kv = (label, v) => { const s = typeof v === "number" ? f.pct(v) : null; if (s) g.push([W(f.t(label) + " "), W(s, "v")]); };
  if (item.kind === "report") {
    const one = item.env === "cloud" ? [W(f.t("env.cloud"), "tag")] : [], stamp = f.stamp(x.created_at), kind = resTypeText(item, f);
    if (stamp) one.push(W(stamp, "mono"));
    if (kind) one.push(W((stamp ? " · " : "") + kind));
    if (!stamp && !kind) one.push(W(f.t("rpt.nav")));
    g.push(one);
  } else if (item.env === "cloud") {
    g.push([W(f.t("env.cloud"), "tag"), W(f.t(x.is_new ? "res.kind.new" : "res.kind.cloudUpd"))]);
  } else if (item.sub === "scan") {
    g.push([W(f.t("res.kind.scan"))]);
    if (Number.isInteger(x.grid_rows) && Number.isInteger(x.grid_cols)) g.push([W(x.grid_rows + "×" + x.grid_cols, "mono")]);
    if (typeof x.tag === "string" && /^rob\.tag\.[A-Za-z]+$/.test(x.tag)) g.push([W(f.t(x.tag))]);
  } else if (item.sub === "code") {
    g.push([W(f.t("res.kind.code"))]);
    if (x.has_bt) g.push([W(f.t("res.notRerun"))]);
  } else {
    if (item.sub === "new") g.push([W(f.t("res.kind.new"))]);
    else if (Number.isInteger(x.version)) { const [a, b] = f.t("res.kind.bt").split("{v}"); g.push([W(a), W("v" + x.version, "mono"), W(b || "")].filter((s) => s.text)); }
    else g.push([W(f.t("res.kind.btUpd"))]);
    if (x.has_bt) { kv("bt.totalReturn", x.total_return); kv("bt.maxDrawdown", x.max_dd); }
    else g.push([W(f.t("res.noBt"))]);
  }
  if (state === "later") g.push([W(f.t("res.later"))]);
  return g;
}
/* ── 純邏輯到此 ── */

const RES = { turn: null, cw: null };
const RES_ICON = {   // Lucide file-text / chart-line(stroke 2,同轉出卡與 .ic 的畫法)
  report: ["M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", "M14 2v4a2 2 0 0 0 2 2h4", "M16 13H8", "M16 17H8", "M10 9H8"],
  strategy: ["M3 3v16a2 2 0 0 0 2 2h16", "m19 9-5 5-4-4-3 3"],
};
function resEl(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
function resIcon(kind) {
  const NS = "http://www.w3.org/2000/svg", s = document.createElementNS(NS, "svg");
  s.setAttribute("class", "ic"); s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("aria-hidden", "true");
  (RES_ICON[kind] || RES_ICON.strategy).forEach((d) => { const p = document.createElementNS(NS, "path"); p.setAttribute("d", d); s.appendChild(p); });
  return s;
}
function resFmt() {
  const R = window.BlaveReport || {};
  return { t, pct: (v) => (R.fmtSignedPct ? R.fmtSignedPct(v) : null), stamp: rptFmtStamp, typeKey: rptTypeKey };
}

/* ── 一輪的生命週期 ── */
// submitMessage:記下回合開始與本機策略快照(當下重讀一次,不拿上一輪結束時的清單——那之後 live tick / 刪除都可能動過)
function resTurnStart(viewing) {
  const rt = { sid: sessionId, at: Date.now(), ts: 0, env: viewing && viewing.env === "cloud" ? "cloud" : "local", snap: null, cloudSnap: resCloudSnap(),
    items: [], host: null, anchor: null, cloud: false, ready: null, go: null };
  rt.ready = new Promise((r) => { rt.go = r; });
  rt.snapP = window.blave.listStrategies().then((l) => { rt.snap = resSnapOf(l); }, () => { rt.snap = resSnapOf(RP.list); });
  RES.turn = rt;
}
function resTurnClose() { const rt = RES.turn; RES.turn = null; if (rt) rt.ts = Date.now() / 1000; return rt; }
// onTurnEnd 最後一步(回覆定稿、轉出卡都掛好之後):卡掛在哪一則由這一刻決定
function resTurnEnd(rt, cloudTouched) {
  if (!rt) return;
  rt.host = resHostNow(); rt.anchor = $("chat-scroll").lastElementChild; rt.cloud = !!cloudTouched;
  rt.go();
}
// stratRefresh + rptTurnEnd 回來之後:兩份產出到齊、回覆也定稿了才一次出(同 turnCards:回合結束才出卡,不插在串流中間)
async function resTurnParts(rt, reportsP) {
  if (!rt) return;
  await rt.snapP;
  let items = resStratItems(rt.snap, RP.list), reps = [];
  try { reps = (await reportsP) || []; } catch (_) { reps = []; }
  items = items.concat(reps);
  await rt.ready;
  for (const it of items) if (it.sub === "scan") await resScanFacts(it);   // 格數與落點要掃描本體:只對掃描卡讀
  resAdd(rt, items);
  if (rt.cloud) resCloudWatch(rt);
}
async function resScanFacts(it) {
  let d = null; try { d = await window.blave.loadStrategy(it.ref); } catch (_) { return; }
  const R = window.BlaveReport || {}, s = d && R.scanTag ? R.scanTag(d) : null;
  if (!s) return;
  it.facts.grid_rows = s.rows; it.facts.grid_cols = s.cols;
  if (s.tag) it.facts.tag = s.tag;
}
// 這一輪的回覆泡泡:往回找到上一句用戶的話為止的最後一則回覆(同 export.js xpHost);沒有就回 null,真的要出卡才起一則
function resHostNow() {
  for (let n = $("chat-scroll").lastElementChild; n && !n.classList.contains("you"); n = n.previousElementSibling)
    if (n.classList.contains("msg") && n.classList.contains("ai")) return n;
  return null;
}
function resHostFor(rt) {
  if (rt.host && rt.host.isConnected) return rt.host;
  if (rt.sid !== sessionId) return null;
  const again = [...$("chat-scroll").querySelectorAll(".msg.ai")].find((n) => n.dataset.resTs === String(rt.ts));   // 切走又切回來(csOpen 重畫過)
  if (again) return again;
  if (rt.host || !rt.anchor || !rt.anchor.isConnected) return null;   // 原本那則被重畫掉了:不猜位置,紀錄已存,下次打開就在
  // 這一輪沒有回覆文字(出錯、被停止)但有產出:自己起一個 .msg.ai,接在回合結束時的最後一個東西後面
  const el = resEl("div", "msg ai"); rt.anchor.after(el); rt.host = el;
  return el;
}
/* 加卡(當場那一批,或雲端晚到的):去重、存檔、畫。晚到的插回那一輪;人停在對話底部才捲,不在底部不捲、不搶焦點 */
function resAdd(rt, items) {
  const add = items.filter((it) => !rt.items.some((x) => resSame(x, it)));
  if (!add.length) return;
  rt.items = resOrder(rt.items.concat(add));
  try { window.blave.saveTurnResults(rt.sid, { ts: rt.ts, items: add }).catch(() => {}); } catch (_) { /* 存不了:這一輪照畫,重開不回來 */ }
  const host = resHostFor(rt);
  if (!host) return;
  const sc = $("chat-scroll"), atBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 24;
  const prev = host._res, states = prev ? rt.items.map((it) => { const i = prev.items.findIndex((x) => resSame(x, it)); return i >= 0 ? prev.states[i] : "ok"; }) : null;
  resPaint(host, rt.items, states, add, rt.ts);
  if (atBottom) scrollChat();
}

/* ── 畫 ── */
function resPaint(host, items, states, fresh, ts) {
  host.dataset.resTs = String(ts);
  host._res = { items, states: items.map((_, i) => (states && states[i]) || "ok") };
  const old = host.querySelector(":scope > .res-group"), all = !!old && old.classList.contains("all");   // 晚到的卡重畫整組:展開過的保持展開
  const g = resEl("div", "res-group" + (all ? " all" : ""));
  items.forEach((it, i) => {
    const c = resCard(it, host._res.states[i], !(fresh && fresh.includes(it)));
    if (i >= RES_CAP) c.classList.add("extra");
    g.appendChild(c);
  });
  if (items.length > RES_CAP) {
    const more = resEl("button", "btn-quiet res-more", t("res.more", { n: String(items.length - RES_CAP) })); more.type = "button";
    more.addEventListener("click", () => {
      g.classList.add("all");
      const first = g.querySelector(".res.extra"), b = first && first.querySelector("button");   // 焦點給第一張新露出的卡的鈕(已刪除的沒有鈕:給卡本身)
      if (b) b.focus(); else if (first) { first.setAttribute("tabindex", "-1"); first.focus(); }
    });
    g.appendChild(more);
  }
  if (old) old.replaceWith(g); else host.appendChild(g);
}
function resCard(it, state, still) {
  const card = resEl("div", "res" + (state === "gone" ? " is-gone" : "") + (still ? " is-still" : ""));
  const f = resEl("div", "f"), tx = resEl("div", "tx"), tt = resEl("div", "t", it.title), m = resEl("div", "m");
  tt.title = it.title;
  resFacts(it, state, resFmt()).forEach((grp) => {
    const kv = resEl("span", "kv");
    grp.forEach((s) => {
      if (s.cls === "tag") kv.appendChild(resEl("span", "wtag cloud", s.text));
      else if (s.cls) kv.appendChild(resEl("span", s.cls === "v" ? "v mono" : s.cls, s.text));
      else kv.append(s.text);
    });
    m.appendChild(kv);
  });
  tx.append(tt, m); f.append(resIcon(it.kind), tx); card.appendChild(f);
  if (state !== "gone") {   // 已刪除:不可點(不讓人點進死路)
    const label = t(resBtnKey(it)), b = resEl("button", "btn-fill", label); b.type = "button";
    b.setAttribute("aria-label", label + (LANG === "zh" ? "：" : ": ") + it.title);   // 一欄多顆「看回測」時讀屏分得出是哪一支
    b.addEventListener("click", () => resGo(it, card));
    card.appendChild(b);
  }
  return card;
}
// 按了才發現不在(檔案剛被刪):卡原地換成已刪除態,唸一句;中欄停在按下去之後到的地方(報告清單 / 歡迎頁)
function resGone(it, card) {
  const host = card.closest(".msg.ai"), g = resCard(it, "gone", true);
  if (card.classList.contains("extra")) g.classList.add("extra");
  card.replaceWith(g);
  if (host && host._res) { const i = host._res.items.findIndex((x) => resSame(x, it)); if (i >= 0) host._res.states[i] = "gone"; }
  srSay(t(it.kind === "report" ? "res.gone.report" : "res.gone.strat"));
}

/* ── 按了之後(spec §5)── */
async function resGo(it, card) {
  // 展開層蓋在中欄最上層,它自己只在「藏著的畫面冒出來」時才收——目標畫面本來就開著時看不到變化,這裡先收
  if (typeof BR !== "undefined" && BR.exp && typeof brCollapse === "function") brCollapse(false);
  const now = typeof ENV !== "undefined" ? ENV.cur : "local";
  if (it.env !== now && !envSwitchGuarded(it.env)) return;   // 別的框開著 / 選字中:切不了就不動
  trackFeature(it.kind === "report" ? "result_report" : "result_strategy");
  const r = it.kind === "report" ? await resOpenReport(it) : await resOpenStrat(it);
  if (r === false) resGone(it, card);
}
// 回 true = 開了;false = 確定不在了;null = 等的時候切走了,不下結論
async function resOpenReport(it) {
  const env = it.env;
  if (!(await rptOpen())) return null;
  let list = RPT.data[env];
  if (!list || !list.some((r) => r.id === it.ref)) { await rptLoad(env, true); list = RPT.data[env]; }   // 這一輪剛寫的可能還不在手上那份清單裡
  if (libEnv() !== env || !rptBag(env).open) return null;
  if (list && !RPT.failed[env] && !list.some((r) => r.id === it.ref)) return false;
  rptShowRead(it.ref);   // 清單讀不到(雲端停機、斷線):照開,閱讀層自己講「讀不到這份報告」+ 重新查看
  return true;
}
async function resOpenStrat(it) {
  if (it.env === "cloud") {
    const st = typeof TR_BAGS !== "undefined" && TR_BAGS.cloud ? TR_BAGS.cloud.st : null;
    if (st && st.cloud && st.cloud.code === "OK" && !envCloudList(st).some((x) => x.name === it.ref)) return false;
    await rpCloudSelect(it.ref, true);
    resFocusHead();
    return true;
  }
  if (!RP.list.some((x) => x.name === it.ref)) return false;
  await stratSelect(it.ref, true);
  if (RP.name !== it.ref || !RP.data) return RP.name === null ? false : null;
  rpShowTab(RP.data.stats ? resTab(it) : "code");
  resFocusHead();
  return true;
}
function resFocusHead() {
  const h = $("rp-name");
  if (!h.hasAttribute("tabindex")) h.setAttribute("tabindex", "-1");   // 同 #tr-h:標題可被程式聚焦、不進 Tab 序
  if (h.offsetParent) h.focus();
}

/* ── 雲端策略:回合結束後跟著雲端清單等(清單是 trade.js 的輪詢在更新;最多 10 分鐘,新的一輪碰雲端就換它等)── */
function resCloudSnap() {
  const st = typeof TR_BAGS !== "undefined" && TR_BAGS.cloud ? TR_BAGS.cloud.st : null;
  return st && st.cloud && st.cloud.code === "OK" ? new Map(envCloudList(st).map((x) => [x.name, x.mtime])) : null;
}
// 雲端組合裡的那幾支(amounts / weights / exchanges 三張表的 key,同主行程 inPortfolio):跑著的,updated_at 每根 K 都在變
function resCloudLive(st) {
  const c = st && st.report && st.report.config, out = new Set();
  if (c) ["amounts", "weights", "exchanges"].forEach((k) => { if (c[k] && typeof c[k] === "object") Object.keys(c[k]).forEach((n) => out.add(n)); });
  return out;
}
function resCloudWatch(rt) {
  if (RES.cw) clearTimeout(RES.cw.timer);
  const w = RES.cw = { rt, until: Date.now() + RES_CLOUD_WAIT_MS, seen: new Set(rt.items.filter((x) => x.env === "cloud" && x.kind === "strategy").map((x) => x.ref)), timer: null };
  const tick = () => {
    if (RES.cw !== w) return;
    const st = typeof TR_BAGS !== "undefined" && TR_BAGS.cloud ? TR_BAGS.cloud.st : null;
    if (st && st.cloud && st.cloud.code === "OK") {
      const items = resCloudItems(rt.cloudSnap, envCloudList(st), rt.at, resCloudLive(st), w.seen);
      if (items.length) resAdd(rt, items);
    }
    if (Date.now() > w.until) { RES.cw = null; return; }
    try { window.blave.cloudRefresh().catch(() => {}); } catch (_) { /* 下一輪輪詢會補 */ }
    w.timer = setTimeout(tick, RES_CLOUD_POLL_MS);
  };
  tick();
}

/* ── 重開 app / 切回舊對話(app.js csOpen):照時間跟逐字稿交錯,ts = 回合結束 → 排在那一輪回覆之後 ── */
async function resHistoryItems(sid) {
  let rows = []; try { rows = await window.blave.loadTurnResults(sid); } catch (_) { return []; }
  if (!Array.isArray(rows) || !rows.length) return [];
  const all = rows.flatMap((r) => r.items), need = (k, e) => all.some((x) => x.kind === k && x.env === e);
  const cur = {};   // `${kind}|${env}` → Map ref → ver;沒有這一格 = 那份清單不在手上(不知道)
  if (need("strategy", "local")) { try { cur["strategy|local"] = new Map((await window.blave.listStrategies()).map((x) => [x.name, resStratVer(x)])); } catch (_) { /* 不知道 */ } }
  if (need("report", "local")) {
    let d = RPT.data.local;
    if (!d) { try { const r = await window.blave.reportsList(); d = r && Array.isArray(r.reports) ? r.reports : null; } catch (_) { d = null; } }
    if (d) cur["report|local"] = new Map(d.filter((r) => r && typeof r.id === "string").map((r) => [r.id, rptKey(r)]));
  }
  const st = typeof TR_BAGS !== "undefined" && TR_BAGS.cloud ? TR_BAGS.cloud.st : null;   // 雲端:手上有成功讀過的清單才對,不另外去問
  if (st && st.cloud && st.cloud.code === "OK") cur["strategy|cloud"] = new Map(envCloudList(st).map((x) => [x.name, null]));
  if (RPT.data.cloud && !RPT.failed.cloud) cur["report|cloud"] = new Map(RPT.data.cloud.map((r) => [r.id, rptKey(r)]));
  const now = (it) => { const m = cur[it.kind + "|" + it.env]; return !m ? undefined : m.has(it.ref) ? { ver: m.get(it.ref) } : null; };
  return rows.map((r) => ({ ts: r.ts, res: { ts: r.ts, items: r.items, states: r.items.map((it) => resState(it, now(it))) } }));
}
function resRestore(e) {
  const host = resHostNow() || addMsg("ai", "");
  resPaint(host, e.items, e.states, null, e.ts);
}
