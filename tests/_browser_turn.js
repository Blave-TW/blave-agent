// 測試用(瀏覽器測試共用):開一輪並當場拿下內建瀏覽器的租約。正式路徑上租約在第一次工具呼叫時由 mcp.js 的 acquire 拿;
// 直接呼叫 _call 的測試沒有經過 MCP,所以在這裡先拿。end = 收掉拿著租約的那一輪(正式路徑上 main.js 一律帶 beginTurn 回的 key)
exports.begin = async (Br, ...args) => { const m = await Br.beginTurn(...args); if (m) await Br._acquire(m.key, {}); return m; };
exports.end = (Br) => { const c = Br._cur(); if (c) Br.endTurn(c.turnKey); };
