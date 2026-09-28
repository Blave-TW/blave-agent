// 開發版專用:假的驗證頁(BLAVE_DEV_FAKE_VERIFY=1),用來實機走一遍「搜尋被要求機器人驗證 → 交給用戶 → 過了自動重搜」。
// 真的驗證頁不能拿來測(不去觸發它),所以每一輪的第一次 browser_search 先落在外殼自己帶的一頁靜態 HTML 上。
//
// 只接兩個點,正式流程(index.js 的 searchOnce / handVerify、verify.js 的 waitVerify)一行都不為它改:
//   ① 判別表:Google 那一列多認一個網域 FAKE_HOST(網址仍是 /sorry/…,所以照正式的規則就是驗證頁,agent 的工具一律被拒)
//   ② 第一次搜尋導去哪:Google 那一列的 url() 在 arm() 之後的第一次回假頁的網址,之後照常
// 假頁從哪來:FAKE_HOST 是 .test 保留網域(RFC 6761),正式網路上不存在;開關開著時這個 partition 多一條 PAC——只有 FAKE_HOST
// 走本機(127.0.0.1、隨機埠)那支只會回這一頁的伺服器,其他網域一律 DIRECT。網址政策沒有放寬:它是一個 http 80 埠的公開網域名。
// 不收任何網址當參數:環境變數只有開 / 關;假頁上的按鈕只會去 https://www.google.com/search,q / hl / num 取自它自己的網址。
// 打包後的 app 一律沒有這個功能:on() 看 isPackaged,main.js 在打包版不 require 這支,electron-builder 也不把這支與那一頁收進包。
"use strict";
const path = require("path"), fs = require("fs"), http = require("http");
const VF = require("./verify");

const FAKE_HOST = "fake-verify.test";
const PAGE = path.join(__dirname, "devverify.html");
const on = (env, isPackaged) => !isPackaged && !!env && env.BLAVE_DEV_FAKE_VERIFY === "1";

/** o: { env, isPackaged } → null(沒開、或是打包版)| { engines, arm(), serve(session) → Promise, close() } */
function create(o) {
  if (!on(o && o.env, !o || o.isPackaged !== false)) return null;
  const g = VF.ENGINES.google;
  let armed = false, srv = null;
  const google = Object.assign({}, g, {
    host: new RegExp(g.host.source + "|^" + FAKE_HOST.replace(/\./g, "\\.") + "$"),
    url: (q, hl, n) => {
      if (!armed) return g.url(q, hl, n);
      armed = false;
      return "http://" + FAKE_HOST + "/sorry/fake?hl=" + encodeURIComponent(hl) + "&num=" + encodeURIComponent(n) + "&q=" + encodeURIComponent(q);
    },
  });
  return {
    engines: Object.assign({}, VF.ENGINES, { google }),
    arm() { armed = true; },
    async serve(ses) {
      if (srv) return;
      const html = fs.readFileSync(PAGE);
      srv = http.createServer((req, res) => {
        const ok = req.method === "GET" && String(req.headers.host || "").toLowerCase() === FAKE_HOST && /^http:\/\/fake-verify\.test\/sorry\/fake(\?|$)/.test(req.url);
        res.writeHead(ok ? 200 : 404, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(ok ? html : "");
      });
      srv.on("connect", (_req, sock) => sock.destroy());
      await new Promise((r) => srv.listen(0, "127.0.0.1", r));
      const pac = 'function FindProxyForURL(url, host) { return host === "' + FAKE_HOST + '" ? "PROXY 127.0.0.1:' + srv.address().port + '" : "DIRECT"; }';
      await ses.setProxy({ mode: "pac_script", pacScript: "data:application/x-ns-proxy-autoconfig;base64," + Buffer.from(pac).toString("base64") });
    },
    close() { try { if (srv) srv.close(); } catch (_) { /* 已關 */ } srv = null; },
  };
}

module.exports = { FAKE_HOST, PAGE, on, create };
