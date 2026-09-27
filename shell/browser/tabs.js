// 分頁名額與排隊 + 速率上限(純邏輯,不 require electron;tests/check_shell_browser_tabs.js)。
// 契約:.claude/output/specs/desktop-browser-agent-tools-2026-09-26.md §5.1–5.2、§3.4 速率。
//   - 同時最多 8 個活的分頁(有 webContents 的);第 9 個起排隊(FIFO)。不給 agent 調。
//   - 名額釋放:分頁被關、或讀完(done)的分頁被收成快照(discard)。用戶正在看的那頁不收。
//   - 分頁有兩種 id:內部 `p<N>`(整個 app 生命期唯一,畫面用)與本回合給 agent 的 `t<N>`(回合結束作廢)。
"use strict";

const MAX_LIVE = 8;
const LIMITS = { pagesPerTurn: 40, pagesPerMin: 20, sameHostPerMin: 6, actionsPerMin: 60, searchesPerTurn: 10, googlePerMin: 4, readCharsPerTurn: 120000 };

/** 滑動視窗計數器。hit() 回 0 = 放行並記一筆;否則回要等的秒數(不記)。 */
function windowCounter(limit, spanMs, now) {
  const hits = [];
  return {
    hit() {
      const t = now();
      while (hits.length && t - hits[0] >= spanMs) hits.shift();
      if (hits.length >= limit) return Math.max(1, Math.ceil((spanMs - (t - hits[0])) / 1000));
      hits.push(t); return 0;
    },
  };
}

/**
 * opts: { now, create(tab) → void(建 webContents), destroy(tab, keepSnapshot) → void, emit(type, payload), max? }
 * tab 物件:{ id, alias, url, host, by, status, turn, title, visible, read }
 *   status: queued | loading | ready | failed | blocked | discarded | closed
 */
function createTabs(opts) {
  const now = opts.now || (() => Date.now());
  const max = opts.max || MAX_LIVE;
  const tabs = new Map();          // id → tab
  const queue = [];                // 排隊中的 tab id(FIFO)
  // 分頁 id 帶這次啟動的隨機前綴:聊天裡重建的舊回合列拿著上一次啟動的 id,不能撞到這次的分頁
  const run = require("crypto").randomBytes(3).toString("hex");
  let seq = 0, turn = 0, aliasSeq = 0;
  const aliases = new Map();       // 本回合 alias → id
  let counters = null;
  const hostCounters = new Map();
  let turnPages = 0, turnSearches = 0, turnReadChars = 0;

  const live = () => [...tabs.values()].filter((t) => t.status === "loading" || t.status === "ready");
  function newCounters() {
    counters = { pages: windowCounter(LIMITS.pagesPerMin, 60000, now), actions: windowCounter(LIMITS.actionsPerMin, 60000, now), google: windowCounter(LIMITS.googlePerMin, 60000, now) };
    hostCounters.clear(); turnPages = 0; turnSearches = 0; turnReadChars = 0;
  }
  newCounters();

  /** 找一個可以收掉的活分頁:讀完、不是用戶正在看的、最舊的那個。 */
  function evictable() {
    return live().filter((t) => t.read && !t.visible && t.by === "agent").sort((a, b) => a.readAt - b.readAt)[0] || null;
  }
  function start(t) { t.status = "loading"; t.startedAt = now(); opts.create(t); }
  function pump() {
    while (queue.length) {
      if (live().length >= max) { const e = evictable(); if (!e) return; discard(e.id); continue; }
      const id = queue.shift(); const t = tabs.get(id);
      if (!t || t.status !== "queued") continue;
      start(t);
      opts.emit("page_open", { id: t.id, url: t.url, queued: false, by: t.by, alias: t.alias });
    }
  }
  function discard(id) {
    const t = tabs.get(id); if (!t || (t.status !== "loading" && t.status !== "ready")) return;
    t.status = "discarded"; opts.destroy(t, true);
  }

  return {
    LIMITS, max,
    /** 新的一回合:alias 重編、每回合上限歸零。舊分頁留給用戶看,agent 拿不到它們的 alias。 */
    newTurn() { turn++; aliasSeq = 0; aliases.clear(); newCounters(); return turn; },
    turn: () => turn,
    /** 開一頁(url 已過政策)。回 { tab } 或 { error: "rate_limited", retry_in_s }。 */
    /** agent 開一頁(新分頁或在既有分頁導覽)都扣同一組開頁速率:每回合 40、每分鐘 20、同網域每分鐘 6。回 null 或錯誤。 */
    chargePage(host) {
      if (turnPages >= LIMITS.pagesPerTurn) return { error: "rate_limited", retry_in_s: 0, scope: "turn" };
      let hc = hostCounters.get(host); if (!hc) { hc = windowCounter(LIMITS.sameHostPerMin, 60000, now); hostCounters.set(host, hc); }
      const w1 = counters.pages.hit(); if (w1) return { error: "rate_limited", retry_in_s: w1 };
      const w2 = hc.hit(); if (w2) return { error: "rate_limited", retry_in_s: w2 };
      turnPages++; return null;
    },
    open(url, host, by) {
      if (by === "agent") { const e = this.chargePage(host); if (e) return e; }
      const t = { id: "p" + run + "_" + (++seq), alias: null, url, host, by, status: "queued", turn, title: "", visible: false, read: false, readAt: 0 };
      if (by === "agent") { t.alias = "t" + (++aliasSeq); aliases.set(t.alias, t.id); }
      tabs.set(t.id, t);
      let ok = live().length < max;
      if (!ok) { const e = evictable(); if (e) { discard(e.id); ok = true; } }
      if (ok) { start(t); opts.emit("page_open", { id: t.id, url, queued: false, by, alias: t.alias }); }
      else { queue.push(t.id); opts.emit("page_open", { id: t.id, url, queued: true, by, alias: t.alias }); }
      return { tab: t };
    },
    /** 被政策擋下的網址也要有一格(畫面上那一列「打不開」、展開是擋下頁):不佔名額、沒有 webContents。 */
    addBlocked(url, host, by, reason) {
      const t = { id: "p" + run + "_" + (++seq), alias: null, url, host, by, status: "blocked", reason, turn, title: "", visible: false, read: false, readAt: 0 };
      if (by === "agent") { t.alias = "t" + (++aliasSeq); aliases.set(t.alias, t.id); }
      tabs.set(t.id, t); opts.emit("page_open", { id: t.id, url, queued: false, by, alias: t.alias });
      return t;
    },
    /** 本回合的 alias → tab(不是本回合的、關掉的都回 null)。 */
    byAlias(alias) { const id = aliases.get(String(alias || "")); const t = id ? tabs.get(id) : null; return t && t.status !== "closed" ? t : null; },
    get: (id) => tabs.get(id) || null,
    all: () => [...tabs.values()].filter((t) => t.status !== "closed"),
    thisTurn: () => [...aliases.values()].map((id) => tabs.get(id)).filter((t) => t && t.status !== "closed"),
    thisTurnAll: () => [...aliases.values()].map((id) => tabs.get(id)).filter(Boolean),   // 含已關的(回合紀錄:讀過又關掉的頁照樣算讀了)
    queued: () => queue.length,
    liveCount: () => live().length,
    loaded(id, title) { const t = tabs.get(id); if (t && t.status === "loading") { t.status = "ready"; if (title) t.title = title; } },
    failed(id, reason) { const t = tabs.get(id); if (!t) return; const wasLive = t.status === "loading" || t.status === "ready"; t.status = "failed"; t.reason = reason; if (wasLive) opts.destroy(t, false); pump(); },
    /** 讀完:之後可以被收成快照讓位。 */
    markRead(id) { const t = tabs.get(id); if (t && !t.read) { t.read = true; t.readAt = now(); pump(); } },
    setVisible(id, on) { for (const t of tabs.values()) t.visible = false; const t = tabs.get(id); if (t && on) t.visible = true; },
    close(id) {
      const t = tabs.get(id); if (!t) return;
      const i = queue.indexOf(id); if (i >= 0) queue.splice(i, 1);
      const wasLive = t.status === "loading" || t.status === "ready";
      t.status = "closed"; if (wasLive) opts.destroy(t, false);
      pump();
    },
    /** 被收掉的分頁重新開(用戶按「開即時頁」):照樣受名額限制。 */
    revive(id) {
      const t = tabs.get(id); if (!t || t.status !== "discarded") return false;
      t.status = "queued"; t.read = false;
      if (live().length < max || evictable()) { if (live().length >= max) discard(evictable().id); start(t); } else queue.push(t.id);
      return true;
    },
    pump,
    // ── 速率 ──
    action() { return counters.actions.hit(); },
    search(engine) {
      if (turnSearches >= LIMITS.searchesPerTurn) return { error: "rate_limited", retry_in_s: 0, scope: "turn" };
      if (engine === "google") { const w = counters.google.hit(); if (w) return { error: "rate_limited", retry_in_s: w, engine }; }
      turnSearches++; return null;
    },
    /** 讀取預算:回這次能給幾個字(0 = 用完)。 */
    readBudget(want) { const left = LIMITS.readCharsPerTurn - turnReadChars; const give = Math.max(0, Math.min(want, left)); turnReadChars += give; return give; },
  };
}

module.exports = { createTabs, windowCounter, MAX_LIVE, LIMITS };
