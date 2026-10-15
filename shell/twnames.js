// 台股代號 → 名字(1438 → 三地開發):策略組合 › 配置的總訊號部位表、自動下單 › 部位表在代號後面補名字(0.1.25,同網頁)。
// 外殼原本沒有這張表;來源是 api 的公開台股清單 /studio/charts/twstock/stock_list(token_optional,不用金鑰,網頁台股頁也讀這支),
// 本機快取一天(userData/tw_names.json):清單一天變一次,而且只是顯示用——問不到就用上一份,沒有就只顯示代號。
const fs = require("fs"), path = require("path");

const TTL_MS = 24 * 3600 * 1000, RETRY_MS = 10 * 60 * 1000;
const ID_RE = /^[0-9]{4,6}[A-Z]?$/, NAME_MAX = 40;   // 代號同畫面 TR_TWSTOCK_RE(去掉 .TW / .TWO);名字只是顯示用,超長的不收
const FILE = "tw_names.json";

/* api 回的 { data: [{ stock_id, name, ... }] } → { id: name };形狀不對的列略過。純函式 */
function parseList(body) {
  const rows = body && Array.isArray(body.data) ? body.data : [], out = {};
  for (const x of rows) {
    if (!x || typeof x.stock_id !== "string" || typeof x.name !== "string") continue;
    const id = x.stock_id.trim().toUpperCase(), name = x.name.trim();
    if (ID_RE.test(id) && name && name.length <= NAME_MAX) out[id] = name;
  }
  return out;
}

function createTwNames({ dir, get, apiBase, now }) {
  const clock = now || Date.now, file = path.join(dir, FILE);
  let mem = null, failAt = 0, inflight = null;
  const load = () => {
    try { const j = JSON.parse(fs.readFileSync(file, "utf8")); if (j && typeof j.at === "number" && j.names && typeof j.names === "object") return j; } catch (_) { /* 沒有或壞了 = 重抓 */ }
    return null;
  };
  const save = (j) => {
    try { const tmp = file + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(j)); fs.renameSync(tmp, file); } catch (_) { /* 存不進去:這次照用記憶體那份 */ }
  };
  /* 回 { 代號: 名字 };拿不到回上一份,連上一份都沒有回 {}(畫面只顯示代號)。失敗後 10 分鐘內不再問 */
  function names() {
    if (!mem) mem = load();
    const t = clock();
    if (mem && t - mem.at < TTL_MS) return Promise.resolve(mem.names);
    if (t - failAt < RETRY_MS) return Promise.resolve(mem ? mem.names : {});
    if (inflight) return inflight;
    inflight = Promise.resolve().then(() => get(`${apiBase}/studio/charts/twstock/stock_list`, {})).then((r) => {
      const m = r && r.status === 200 ? parseList(r.body) : {};
      if (!Object.keys(m).length) throw new Error("empty list");
      mem = { at: clock(), names: m }; save(mem);
      return m;
    }).catch(() => { failAt = clock(); return mem ? mem.names : {}; }).finally(() => { inflight = null; });
    return inflight;
  }
  return { names };
}

module.exports = { createTwNames, parseList, TTL_MS, RETRY_MS };
