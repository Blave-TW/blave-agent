// OAuth 登入子視窗:頁面 window.open 到「已知身分提供者」時放行成受控視窗跑第三方登入
// (Wei 實測:TradingView 的 Google 登入按下去沒反應——popup 全 deny 把 OAuth 擋死了)。
// 走 allow 路線(稽核 B-P1-2):deny+另開視窗會讓 opener 拿到 window.open()===null(GSI 型
// 流程直接判 popup 被擋)、子視窗沒有 window.opener(靠 opener.postMessage 交 code 的流程必死)。
// setWindowOpenHandler 回 {action:"allow", overrideBrowserWindowOptions},did-create-window 接管。
// 邊界:
//   - 只認「用戶手勢」(takeover 中的分頁;稽核 B-P3:agent 的 3 秒窗不開——gate.js 本來就不讓
//     agent 按登入鈕,走到這裡的多半是頁面腳本趁窗口 window.open)
//   - 只有白名單身分提供者放行,其餘 window.open 照舊(分頁或 deny,index.js 原路)
//   - 同 partition(allow 路線繼承 opener 的 session):cookie 落得回主頁;session 層政策
//     (內網擋、下載擋、權限全拒)自動繼承。agent 之後導 IdP 帳戶面由 policy.js 擋(B-P1-1)
//   - 只有用戶能操作:視窗不進 tabs / views,agent 工具沒有 ref 打得進去;不掛 CDP
//   - 「網址列」:allow 路線下 popup 的 webContents 就是視窗本體,做不了子 view 網址列——
//     改用視窗標題常駐顯示 host(page-title-updated preventDefault,頁面蓋不掉;用戶要看得到
//     自己在哪裡輸入密碼)
//   - 結束:頁面自我 window.close()(OAuth 正常收尾;已實測可行),或導回 opener 網域
//     did-finish-load 後寬限 2.5s 仍沒自我關閉就代關(callback 要先跑完 postMessage);
//     再導離 opener 網域(帳號選擇/再同意)取消倒數;opener=IdP 同 registrable 不啟動(B-P2-1)
"use strict";

// 身分提供者白名單(host 全等或其子網域;facebook 只認登入/授權路徑,別的 facebook 頁不算)
const IDP = [
  { host: "accounts.google.com" },
  { host: "appleid.apple.com" },
  { host: "login.microsoftonline.com" },
  { host: "facebook.com", path: /^\/(login|[^/]+\/dialog\/oauth|dialog\/oauth)/ },
];

function createOauth(o) {
  // o: { electron, session() → 共用 partition 的 Session, getWin() → 主視窗, registrable(host) }
  const E = o.electron;
  let win = null, wc = null, openerReg = "", graceTimer = null;

  function isIdp(url) {
    let u; try { u = new URL(String(url || "")); } catch (_) { return false; }
    if (u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    return IDP.some((d) => (h === d.host || h.endsWith("." + d.host)) && (!d.path || d.path.test(u.pathname)));
  }

  /** setWindowOpenHandler 的 IdP 分支要回的 allow 選項(index.js 用)。一次一個:已開著回 null(照舊 deny)。 */
  function allowOptions() {
    if (win && !win.isDestroyed()) { try { win.focus(); } catch (_) { /* 關到一半 */ } return null; }
    const parent = o.getWin();
    return {
      action: "allow",
      outlivesOpener: false,   // opener 分頁關了,登入視窗跟著收
      overrideBrowserWindowOptions: {
        width: 480, height: 680, parent: parent && !parent.isDestroyed() ? parent : undefined,
        autoHideMenuBar: true, minimizable: false, fullscreenable: false,
        // webPreferences 繼承 opener 的 view(sandbox / contextIsolation / no nodeIntegration /
        // devTools:false / 同 session),這裡只補視窗形狀;不開任何額外能力
      },
    };
  }

  function title() {
    if (!win || win.isDestroyed() || !wc) return;
    let host = ""; try { host = new URL(wc.getURL() || "").host; } catch (_) { /* 還沒導 */ }
    try { win.setTitle(host ? "\u{1F512} " + host : "Sign in"); } catch (_) { /* 關到一半 */ }
  }

  function close() {
    if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
    const w = win, c = wc; win = null; wc = null; openerReg = "";
    if (c && !c.isDestroyed()) try { c.close(); } catch (_) { /* 已關 */ }   // 稽核 B-P2-4:先關 wc,頁面 JS 不留活口
    if (w && !w.isDestroyed()) try { w.close(); } catch (_) { /* 已關 */ }
  }

  /** did-create-window 接管(index.js 在 allow 之後呼叫)。 */
  function adopt(childWin, url, openerUrl) {
    win = childWin; wc = childWin.webContents;
    try { openerReg = o.registrable(new URL(String(openerUrl || "")).hostname); } catch (_) { openerReg = ""; }
    win.setMenuBarVisibility(false);
    // 標題=唯讀網址列(host 常駐,頁面蓋不掉):用戶要看得到自己在哪裡輸入密碼
    wc.on("page-title-updated", (e) => { e.preventDefault(); title(); });
    wc.on("did-navigate", (_e, u) => { title(); onNav(u); });
    wc.on("did-navigate-in-page", (_e, u) => { title(); onNav(u); });
    wc.on("did-finish-load", () => { title(); maybeFinish(wc.getURL()); });
    // 登入流程用不到第二層 popup
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    wc.on("will-attach-webview", (e) => e.preventDefault());
    win.on("closed", () => { win = null; wc = null; openerReg = ""; if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; } });
    title();
  }

  // 導航層:再導離 opener 網域(帳號選擇 / 再同意)取消收尾倒數(稽核 B-P2-1 第 2 點)
  function onNav(u) {
    if (!graceTimer) return;
    let reg = ""; try { reg = o.registrable(new URL(String(u || "")).hostname); } catch (_) { return; }
    if (reg !== openerReg) { clearTimeout(graceTimer); graceTimer = null; }
  }

  // 導回 opener 網域=流程走完:did-finish-load 後給 callback 頁 2.5s 跑它的 postMessage /
  // 自我關閉,沒關再代關。opener 本身就是 IdP(facebook 頁上開 facebook 登入)不啟動(B-P2-1 第 1 點)。
  function maybeFinish(u) {
    if (!openerReg || graceTimer) return;
    if (isIdp(u)) return;
    let reg = ""; try { reg = o.registrable(new URL(String(u || "")).hostname); } catch (_) { return; }
    if (reg !== openerReg) return;
    graceTimer = setTimeout(() => { graceTimer = null; close(); }, 2500);
  }

  /** DNS rebinding 回應層後盾(稽核 B-P2-2):子視窗不在 wcTab,index.js 用這兩個接。 */
  function owns(webContentsId) { return !!(wc && !wc.isDestroyed() && wc.id === webContentsId); }
  function abortPrivate() { if (wc && !wc.isDestroyed()) { try { wc.stop(); wc.loadURL("about:blank"); } catch (_) { /* 已關 */ } } close(); }

  return { isIdp, allowOptions, adopt, close, owns, abortPrivate, _test: { IDP, get win() { return win; }, get wc() { return wc; } } };
}

module.exports = { createOauth };
