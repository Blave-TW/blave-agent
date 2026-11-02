// 回前景重偵測不清列(0.1.41 驗收:Windows〔再試一次〕點三下才動、Mac 第一下〔連結〕被吃)。
// 把視窗叫回前景的那一下,focus 先到、click 後到:以前 focus 就把列換成「偵測中…」,click 落在沒有鈕的列上。
// 這裡用 app.js 原文(detect／detectingRows／focusRedetect／paintRows…)配假的 DOM 與一個不回的 detectAgents,
// 看偵測途中那一列的鈕還在不在、按下去有沒有走到。手動〔重新偵測〕照舊先清列。
// 跑法:node tests/check_shell_focus_redetect.js
const fs = require("fs"), path = require("path");
const SHELL = path.join(__dirname, "..", "shell");
const app = fs.readFileSync(path.join(SHELL, "renderer", "app.js"), "utf8");
const STR = eval(fs.readFileSync(path.join(SHELL, "renderer", "strings.js"), "utf8") + ";STRINGS");
let red = 0; const t = (n, ok, info) => { console.log((ok ? "PASS  " : "FAIL  ") + n + (ok || info === undefined ? "" : "  " + JSON.stringify(info))); if (!ok) red++; };
const grab = (re, name) => { const m = app.match(re); if (!m) { console.log("FAIL  找不到 " + name); process.exit(1); } return m[0]; };
const fnOf = (name) => grab(new RegExp("^(?:async )?function " + name + "\\([^)]*\\) \\{[\\s\\S]*?\\n\\}", "m"), name);
// 舊碼沒有的那幾支換成「照舊碼的行為」,讓舊碼跑得到斷言、紅在行為上而不是紅在切不到原文
const optFn = (name, fallback) => (app.match(new RegExp("^(?:async )?function " + name + "\\(", "m")) ? fnOf(name) : fallback);
const constOf = (name) => grab(new RegExp("^const " + name + " = .*$", "m"), name);

const mkEl = (tag) => {
  const n = { tag, children: [], dataset: {}, className: "", disabled: false, hidden: false, parent: null, _html: "", _txt: "", _click: null,
    append: (...xs) => xs.forEach((x) => { if (typeof x === "string") n.children.push({ text: x }); else { x.parent = n; n.children.push(x); } }),
    appendChild: (x) => { n.append(x); return x; },
    addEventListener: (ev, fn) => { if (ev === "click") n._click = fn; },
    setAttribute: () => {}, focus: () => { S.focused = n; },
    contains: (x) => { for (let p = x; p; p = p.parent) if (p === n) return true; return false; },
    querySelector: (q) => { const k = (q.match(/data-kind="([^"]+)"\] button/) || [])[1]; const r = k && n.children.find((c) => c.dataset && c.dataset.kind === k); return r ? r.children.find((c) => c.tag === "button") || null : null; },
    querySelectorAll: (q) => { const out = []; const walk = (x) => (x.children || []).forEach((c) => { if (q === "button" && c.tag === "button") out.push(c); walk(c); }); walk(n); return out; },
    closest: (q) => { const k = (q.match(/data-kind="([^"]+)"/) || [])[1]; let p = n; while (p) { if (p.dataset && (k ? p.dataset.kind === k : q === "[data-kind]" && p.dataset.kind)) return p; p = p.parent; } return null; } };
  Object.defineProperty(n, "textContent", { get: () => n.children.map((c) => c.text !== undefined ? c.text : c.textContent).join("") + n._txt, set: (v) => { n.children.length = 0; n._txt = String(v); } });
  Object.defineProperty(n, "innerHTML", { get: () => n._html, set: (v) => { n._html = v; n.children.length = 0; if (!v) return; const s = mkEl("span"); s.parent = n; n.children.push(s); n._first = s; } });
  Object.defineProperty(n, "firstChild", { get: () => n._first });
  return n;
};
const dom = {}; const $ = (id) => dom[id] || (dom[id] = mkEl("div"));
const document = { createElement: mkEl, createDocumentFragment: () => mkEl("#frag"), activeElement: null };
const tr = (k, v) => { let s = STR.zh[k] || k; for (const x of Object.keys(v || {})) s = s.split("{" + x + "}").join(v[x]); return s; };

// 主行程那一頭:每次偵測回一個由測試決定何時 resolve 的 promise
const IPC = { calls: 0, pending: [] };
const window = { blave: { detectAgents: () => { IPC.calls++; return new Promise((res) => IPC.pending.push(res)); } } };
const S = { hints: [] };
const R = new Function("document", "$", "t", "window", "S", `
  let loginPending = null, oauthPending = false, cur = null, localReady = false;
  const MDL = { busy: false }, mdlPaint = () => {}, paintBlaveBtn = () => {}, connectLockPaint = () => {}, setHint = (h) => { S.hints.push(h); }, trackEvent = () => {}, laiOn = () => false;
  const connect = (k) => { S.connected = k; }, localLogin = (k) => { S.login = k; }, codexPkgGo = (re) => { S.pkgGo = re; }, codexAutoLogin = () => {};
  ${fnOf("row")}
  ${fnOf("btn")}
  ${fnOf("detectingRows")}
  let lastDetect = null;
  const PKG = { snap: null, redetect: false, auto: null, done: false };
  let detectAt = 0;
  ${constOf("ROWMSG")}
  let detectP = null;
  ${fnOf("detect")}
  ${optFn("detectFresh", "async function detectFresh() { return detect(); }")}
  ${optFn("detectRun", "")}
  ${fnOf("codexPkgOnState")}
  ${constOf("REDETECT_GAP_MS")}
  ${fnOf("focusRedetect")}
  ${constOf("LOCAL_FAULTS")}
  ${fnOf("localFaultsLive")}
  ${fnOf("localFaultsRecheck")}
  ${constOf("whyState")}
  ${constOf("authUnknown")}
  ${fnOf("codexPkgRow")}
  ${fnOf("paintRows")}
  ${fnOf("rowMsg")}
  ${constOf("rowVars")}
  return { detect, detectFresh, codexPkgOnState, focusRedetect, paintRows, PKG, MDL, set: (k, v) => { eval(k + " = v"); }, get: (k) => eval(k) };`)(document, $, tr, window, S);

["view-connect", "set-scrim", "set-model"].forEach((id) => { $(id).hidden = true; });
$("view-connect").hidden = false;
const btnOf = (kind) => { const r = $("agent-rows").children.find((c) => c.dataset.kind === kind); return r ? r.children.find((c) => c.tag === "button") || null : null; };
const stOf = (kind) => { const r = $("agent-rows").children.find((c) => c.dataset.kind === kind); return r ? r._html : ""; };
const D = (claude, codex) => ({ claude: { installed: true, ...claude }, codex: { installed: true, via: "pkg", ...codex } });
const tick = () => new Promise((r) => setTimeout(r, 0));
const answer = (d) => { const f = IPC.pending.shift(); if (f) f(d); };

(async () => {
  const idle = { phase: "idle", fail: null, size: "200 MB" };
  // ⓪ 最常見的一種:Claude 沒登入(〔連結〕)、Codex 已登入。舊碼這裡沒有任何例外,回前景一定先清列
  { const d0 = D({ loggedIn: false, why: "claude_nonzero" }, { loggedIn: true, path: "/x/codex" });
    R.set("lastDetect", d0); R.paintRows(d0); R.set("detectAt", 0); S.login = null;
    const fired = R.focusRedetect(), b = btnOf("claude");
    t("回前景:Claude〔連結〕偵測途中還在、按下去走到 localLogin(舊碼:列先變「偵測中…」,第一下被吃)",
      fired === true && !!b && !b.disabled && (b._click({ currentTarget: b }), S.login === "claude"), { fired, b: b && b.textContent, st: stOf("claude") });
    answer(d0); await tick(); }

  // ① Codex 引擎跑不起來:列上〔再試一次〕。視窗回前景(focus)→ 偵測途中那一顆還在、按得到
  { const d0 = D({ loggedIn: false, why: "claude_nonzero" }, { loggedIn: false, why: "codex_cantrun", path: "/x/codex" });
    R.PKG.snap = idle; R.set("lastDetect", d0); R.paintRows(d0); R.set("detectAt", 0);
    const before = btnOf("codex"), c0 = IPC.calls;
    const fired = R.focusRedetect();
    const during = btnOf("codex");
    t("回前景:Codex 跑不起來那一列照樣重偵測", fired === true && IPC.calls === c0 + 1, { fired, calls: IPC.calls - c0 });
    t("…偵測途中〔再試一次〕還在、沒鎖,列不是「偵測中…」(舊碼先清列:0.1.41 Windows 點三下才動)",
      !!before && !!during && !during.disabled && during.textContent === tr("cn.retry") && !stOf("codex").includes(tr("cn.detecting")), { during: during && during.textContent, st: stOf("codex") });
    if (during) during._click({ currentTarget: during });
    t("…按下去走到重抓(codexPkgGo reinstall)", S.pkgGo === true, S);
    t("…設定 › 模型接入沒被鎖成偵測中(MDL.busy 沒立起來)", R.MDL.busy === false);
    answer(D({ loggedIn: false, why: "claude_nonzero" }, { loggedIn: true, path: "/x/codex" })); await tick();
    t("…結果回來才重畫:Codex 換成已登入", stOf("codex").includes(tr("st.signedIn")), stOf("codex")); }

  // ② 一列沒登入(〔連結〕)、另一列不確定:回前景第一下〔連結〕不被吃(0.1.41 Mac),偵測中按下去照常開登入
  { const d0 = D({ loggedIn: false, why: "claude_nonzero" }, { loggedIn: false, why: "codex_timeout", path: "/x/codex" });
    R.PKG.snap = null; R.set("lastDetect", d0); R.paintRows(d0); R.set("detectAt", 0); S.login = null;
    const fired = R.focusRedetect(), b = btnOf("claude");
    t("回前景:有一列不確定也重偵測,沒登入那一列的〔連結〕偵測途中還在", fired === true && !!b && !b.disabled && b.textContent === tr("cn.connect"), { fired, b: b && b.textContent });
    if (b) b._click({ currentTarget: b });
    t("…偵測中按〔連結〕走到 localLogin", S.login === "claude", S);
    answer(d0); await tick(); }

  // ③ 手動〔重新偵測〕(click 直接掛 detect,收到的是 Event):照舊先清成「偵測中…」
  { const d0 = D({ loggedIn: false, why: "claude_nonzero" }, { loggedIn: true, path: "/x/codex" });
    R.set("lastDetect", d0); R.paintRows(d0);
    const p = R.detect({ type: "click" });
    t("手動〔重新偵測〕:兩列都是「偵測中…」、沒有鈕、MDL.busy", stOf("claude").includes(tr("cn.detecting")) && !btnOf("claude") && R.MDL.busy === true, stOf("claude"));
    answer(d0); await p; }

  // ④ 稽核 P2-1:回前景那一輪還在飛,Codex 引擎就重抓完(〔再試一次〕)。裝好那一刻的重偵測不能共用裝之前起跑的那一輪:
  //    先記著(PKG.redetect),那一輪收尾再起新的
  { const bad = D({ loggedIn: false, why: "claude_nonzero" }, { loggedIn: false, why: "codex_cantrun", path: "/x/codex" });
    R.PKG.snap = idle; R.set("lastDetect", bad); R.paintRows(bad); R.set("detectAt", 0); R.PKG.redetect = false;
    const c0 = IPC.calls; R.focusRedetect();
    R.codexPkgOnState({ phase: "install" }); R.codexPkgOnState({ ...idle });
    const c1 = IPC.calls - c0, flagged = R.PKG.redetect;
    answer(bad); await tick(); await tick();
    const c2 = IPC.calls - c0;
    t("回前景那一輪在飛時引擎裝好:不馬上重偵測(會共用到裝之前那一輪),記 PKG.redetect;那一輪收尾再起新的一輪",
      c1 === 1 && flagged === true && c2 === 2 && R.PKG.redetect === false, { c1, flagged, c2 });
    answer(D({ loggedIn: false, why: "claude_nonzero" }, { loggedIn: true, path: "/x/codex" })); await tick();
    t("…新的那一輪結果畫上去:Codex 已登入,不再是〔再試一次〕", stOf("codex").includes(tr("st.signedIn")), stOf("codex")); }

  // ④b 同一情境,但那一輪在飛時列又被重畫(換語言、主行程推進度快照):旗標不能在重畫時被用掉、補到還在飛的舊那一輪
  { const bad = D({ loggedIn: false, why: "claude_nonzero" }, { loggedIn: false, why: "codex_cantrun", path: "/x/codex" });
    R.PKG.snap = idle; R.set("lastDetect", bad); R.paintRows(bad); R.set("detectAt", 0); R.PKG.redetect = false;
    const c0 = IPC.calls; R.focusRedetect();
    R.codexPkgOnState({ phase: "install" }); R.codexPkgOnState({ ...idle });
    R.paintRows(R.get("lastDetect"));   // 換語言重畫
    const c1 = IPC.calls - c0, kept = R.PKG.redetect;
    answer(bad); await tick(); await tick();
    const c2 = IPC.calls - c0;
    t("在飛時列被重畫:不補偵測、旗標留著;那一輪收尾才起新的一輪",
      c1 === 1 && kept === true && c2 === 2 && R.PKG.redetect === false, { c1, kept, c2 });
    answer(D({ loggedIn: false, why: "claude_nonzero" }, { loggedIn: true, path: "/x/codex" })); await tick(); }

  // ⑤ 稽核 P3-3:回前景那一輪開始時不清提示句(設定頁那句登入失敗),結果回來才清
  { const d0 = D({ loggedIn: false, why: "claude_nonzero" }, { loggedIn: true, path: "/x/codex" });
    R.set("lastDetect", d0); R.paintRows(d0); R.set("detectAt", 0); S.hints.length = 0;
    R.focusRedetect(); const atStart = S.hints.length;
    answer(d0); await tick();
    t("回前景:提示句等結果回來才清(開始時不清)", atStart === 0 && S.hints.length === 1 && S.hints[0] === null, { atStart, hints: S.hints }); }

  // ⑥ 稽核 P3-2:結果回來整列重建,焦點放回原本那一列的鈕
  { const d0 = D({ loggedIn: false, why: "claude_nonzero" }, { loggedIn: true, path: "/x/codex" });
    R.set("lastDetect", d0); R.paintRows(d0); R.set("detectAt", 0);
    R.focusRedetect(); document.activeElement = btnOf("claude"); S.focused = null;
    answer(d0); await tick();
    t("回前景:重畫後焦點回到 Claude 那一列新的〔連結〕", !!S.focused && S.focused === btnOf("claude"), { f: S.focused && S.focused.textContent });
    document.activeElement = null; }

  // ⑦ 稽核 P3-4:登入完那次偵測要「登入之後」的結果:回前景那一輪還在飛就等它跑完再起新的
  { const d0 = D({ loggedIn: false, why: "claude_nonzero" }, { loggedIn: true, path: "/x/codex" });
    R.set("detectAt", 0); R.focusRedetect(); const c0 = IPC.calls;
    const f = R.detectFresh(); await tick(); const c1 = IPC.calls - c0;
    answer(d0); await tick(); await tick(); const c2 = IPC.calls - c0;
    answer(D({ loggedIn: true }, { loggedIn: true, path: "/x/codex" })); await f;
    t("detectFresh:在飛那一輪跑完才起新的一輪(不共用登入前那一輪),結果是新的那份", c1 === 0 && c2 === 1 && R.get("lastDetect").claude.loggedIn === true, { c1, c2 }); }

  console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
})();
