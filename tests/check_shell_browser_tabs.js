// 分頁名額 8 + 排隊 + 速率上限(shell/browser/tabs.js)。
// 跑法:node tests/check_shell_browser_tabs.js
const { createTabs, LIMITS, MAX_LIVE } = require("../shell/browser/tabs");
let red = 0; const t = (n, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) red++; };
const world = () => { const w = { now: 1e12, created: [], destroyed: [], events: [] };
  w.tabs = createTabs({ now: () => w.now, create: (x) => w.created.push(x.id), destroy: (x, keep) => w.destroyed.push([x.id, keep]), emit: (type, p) => w.events.push([type, p]) }); w.tabs.newTurn(); return w; };

t("上限是 8(Wei 拍板,不給 agent 調)", MAX_LIVE === 8);
{ const w = world(); const opened = [];
  for (let i = 0; i < 10; i++) { w.now += 1000; opened.push(w.tabs.open("https://s" + i + ".example/", "s" + i + ".example", "agent").tab); }
  t("前 8 頁立刻建、第 9、10 頁排隊", w.created.length === 8 && opened[8].status === "queued" && opened[9].status === "queued" && w.tabs.queued() === 2 && w.tabs.liveCount() === 8);
  t("排隊的頁在畫面上標 queued(區塊頭「排隊 n」)", w.events.filter((e) => e[0] === "page_open" && e[1].queued).length === 2);
  t("alias 是本回合的 t1…t10", opened.map((x) => x.alias).join() === Array.from({ length: 10 }, (_, i) => "t" + (i + 1)).join());
  w.tabs.loaded(opened[0].id); w.tabs.loaded(opened[1].id);
  t("載完但還沒讀的頁不讓位(agent 還要讀)", w.tabs.queued() === 2 && w.created.length === 8);
  w.tabs.markRead(opened[0].id);
  t("讀完一頁 → 最舊的讀完頁收成快照讓位,第 9 頁開始載", w.destroyed.length === 1 && w.destroyed[0][0] === opened[0].id && w.destroyed[0][1] === true && opened[8].status === "loading" && w.tabs.queued() === 1);
  w.tabs.setVisible(opened[1].id, true); w.tabs.markRead(opened[1].id);
  t("用戶正在看的那頁不收", !w.destroyed.some((d) => d[0] === opened[1].id) && w.tabs.queued() === 1);
  w.tabs.close(opened[2].id);
  t("關一頁 → 排隊的下一頁補上(FIFO)", opened[9].status === "loading" && w.tabs.queued() === 0 && w.tabs.liveCount() === 8);
  w.tabs.failed(opened[3].id, "dns");
  t("失敗的頁釋放名額", w.tabs.liveCount() === 7);
  w.tabs.newTurn();
  t("新回合:代號不重編——還活著的舊分頁照同一個代號指得到,關掉的指不到(第十三批 #200)", w.tabs.byAlias("t5") === opened[4] && w.tabs.byAlias("t3") === null && w.tabs.thisTurn().length === 0
    && w.tabs.reachable().every((x) => x.status === "loading" || x.status === "ready") && !w.tabs.reachable().includes(opened[0]) && w.tabs.reachable().includes(opened[4]));
  t("新回合開的分頁接著編號,不重用舊代號", w.tabs.open("https://n.example/", "n.example", "agent").tab.alias === "t11");
}
{ const w = world();
  for (let i = 0; i < LIMITS.pagesPerMin; i++) w.tabs.open("https://h" + i + ".example/", "h" + i + ".example", "agent");
  const r = w.tabs.open("https://x.example/", "x.example", "agent");
  t("每分鐘 20 頁,第 21 頁 rate_limited + 剩幾秒", r.error === "rate_limited" && r.retry_in_s > 0 && r.retry_in_s <= 60);
  w.now += 61000;
  t("一分鐘後又可以開", !w.tabs.open("https://x.example/", "x.example", "agent").error);
  const u = w.tabs.open("https://y.example/", "y.example", "user");
  t("用戶自己開的頁不計入 agent 的速率", !u.error);
}
{ const w = world(); let last;
  for (let i = 0; i < LIMITS.sameHostPerMin + 1; i++) last = w.tabs.open("https://same.example/" + i, "same.example", "agent");
  t("同網域每分鐘 6 頁", last.error === "rate_limited");
}
{ const w = world(); let last;
  for (let i = 0; i < LIMITS.pagesPerTurn + 1; i++) { w.now += 61000; last = w.tabs.open("https://p" + i + ".example/", "p" + i + ".example", "agent"); }
  t("每回合 40 頁", last.error === "rate_limited" && last.scope === "turn");
}
{ const w = world();
  let n = 0; for (let i = 0; i < 70; i++) if (w.tabs.action() === 0) n++;
  t("動作每分鐘 60 次", n === LIMITS.actionsPerMin);
  let g = 0; for (let i = 0; i < 6; i++) if (!w.tabs.search("google")) g++;
  t("Google 每分鐘 4 次", g === LIMITS.googlePerMin);
  const got = [w.tabs.readBudget(100000), w.tabs.readBudget(30000), w.tabs.readBudget(10)];
  t("讀取預算 120k:100k → 20k → 0", got.join() === "100000,20000,0");
}
{ const w = world(); const b = w.tabs.addBlocked("https://www.binance.com/en/my", "binance.com", "agent", "sensitive_domain");
  t("被擋的網址有一格(打不開)、不佔名額", b.status === "blocked" && w.tabs.liveCount() === 0 && w.created.length === 0 && w.tabs.byAlias(b.alias) === b);
}

console.log(red ? `\n${red} FAILED` : "\nALL PASS");
process.exit(red ? 1 : 0);
