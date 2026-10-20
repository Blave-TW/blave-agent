/* 下載一個官方檔進記憶體(統一憑證e總管、群益憑證精靈共用):大小上限、逾時、redirect 最多 3 跳且只准 https。
   headers 每一跳都帶(群益的下載點不帶 Referer 回 403);host 給了就不准跳出那個網域。不依賴 electron。 */
const https = require("https");

function hostOk(url, host) {
  if (!host) return true;
  const h = new URL(url).hostname.toLowerCase();
  return h === host || h.endsWith("." + host);
}
function fetchBuffer(url, max, opts, hops = 3) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 30000, headers: o.headers || {} }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        if (!next.startsWith("https://") || !hostOk(next, o.host)) { reject(new Error("REDIRECT")); return; }
        fetchBuffer(next, max, o, hops - 1).then(resolve, reject); return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error("HTTP_" + res.statusCode)); return; }
      const parts = []; let n = 0;
      res.on("data", (d) => { n += d.length; if (n > max) { const e = new Error("TOO_LARGE"); reject(e); req.destroy(e); return; } parts.push(d); });
      res.on("end", () => resolve(Buffer.concat(parts)));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("TIMEOUT")));
    req.on("error", reject);
  });
}
module.exports = { fetchBuffer, hostOk };
