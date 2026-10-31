/* 下載官方檔(統一憑證e總管、群益憑證精靈進記憶體;Codex 引擎套件串到磁碟):redirect 最多 3 跳且只准 https。
   headers 每一跳都帶(群益的下載點不帶 Referer 回 403);host 給了(字串或陣列)就不准跳出那些網域。不依賴 electron。 */
const https = require("https");

function hostOk(url, host) {
  if (!host) return true;
  const h = new URL(url).hostname.toLowerCase();
  return (Array.isArray(host) ? host : [host]).some((x) => h === x || h.endsWith("." + x));
}
/* 走到 200 那一跳,把原生的 res 與 req 交給 take,回 take 的 Promise。take 在 https.get 的回呼裡同步叫:
   掛 data／end 不能晚一個 microtask(tests/check_shell_capital_local.js 的假 res 一回呼就同步送完)。
   timeout 是 socket 閒置逾時,body 讀到一半停住也算 */
function fetchStream(url, opts, take, hops = 3) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: o.timeout || 30000, headers: o.headers || {} }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        if (!next.startsWith("https://") || !hostOk(next, o.host)) { reject(new Error("REDIRECT")); return; }
        fetchStream(next, o, take, hops - 1).then(resolve, reject); return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error("HTTP_" + res.statusCode)); return; }
      take(res, req).then(resolve, reject);
    });
    req.on("timeout", () => req.destroy(new Error("TIMEOUT")));
    req.on("error", reject);
  });
}
function fetchBuffer(url, max, opts, hops = 3) {
  return fetchStream(url, opts, (res, req) => new Promise((resolve, reject) => {
    const parts = []; let n = 0;
    req.on("error", reject);
    res.on("data", (d) => { n += d.length; if (n > max) { const e = new Error("TOO_LARGE"); reject(e); req.destroy(e); return; } parts.push(d); });
    res.on("end", () => resolve(Buffer.concat(parts)));
    res.on("error", reject);
  }), hops);
}
/* 大檔串到磁碟、邊寫邊算 sha256(Codex 引擎套件 170–200 MB,不進記憶體)。o.idleMs = 多久沒有資料就停(socket 閒置逾時);
   o.totalMs(len) = 整條的上限,len 是 Content-Length(沒給是 null);o.max = 位元組上限;o.onBytes(n, len);
   o.onReq(req) 把 req 交給呼叫端(結束 app 時關 socket)。回 { sha256, bytes, totalMs } */
function fetchToFile(url, file, o, fsx = require("fs")) {
  return fetchStream(url, { timeout: o.idleMs, headers: o.headers, host: o.host }, (res, req) => new Promise((resolve, reject) => {
    if (o.onReq) o.onReq(req);
    const len = Number(res.headers["content-length"]) > 0 ? Number(res.headers["content-length"]) : null;
    const totalMs = typeof o.totalMs === "function" ? o.totalMs(len) : o.totalMs;
    const hash = require("crypto").createHash("sha256"), ws = fsx.createWriteStream(file);
    let n = 0, settled = false;
    const tm = totalMs ? setTimeout(() => req.destroy(new Error("TIMEOUT")), totalMs) : null;
    const fail = (e) => { if (settled) return; settled = true; clearTimeout(tm); res.unpipe(ws); ws.destroy(); reject(e); };
    req.on("error", fail); res.on("error", fail); ws.on("error", fail);
    res.on("aborted", () => fail(new Error("ABORTED")));
    res.on("data", (d) => {
      if (settled) return;
      n += d.length; hash.update(d);
      if (o.max && n > o.max) { const e = new Error("TOO_LARGE"); fail(e); req.destroy(e); return; }
      if (o.onBytes) o.onBytes(n, len);
    });
    ws.on("finish", () => { if (settled) return; settled = true; clearTimeout(tm); resolve({ sha256: hash.digest("hex"), bytes: n, totalMs }); });
    res.pipe(ws);
  }));
}
module.exports = { fetchBuffer, fetchStream, fetchToFile, hostOk };
