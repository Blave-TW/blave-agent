// 一個分頁的 CDP 操作(webContents.debugger,行程內、逐分頁;**沒有** remote-debugging port)。
// 契約:.claude/output/specs/desktop-browser-agent-tools-2026-09-26.md §2.4。語意照 agent-browser(snapshot + ref)。
// 分級不在這裡判:這裡只負責「讀出節點描述」與「真的去做」,index.js 在兩者之間呼叫 gate.js。
"use strict";
const IP = require("./inpage");

const KEEP_ROLES = new Set([
  "link", "button", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox",
  "menuitemradio", "option", "slider", "spinbutton", "listbox", "heading", "listitem", "img", "image", "navigation", "main",
  "search", "form", "dialog", "alertdialog", "tablist", "menu", "table", "row", "cell", "columnheader", "rowheader", "article",
  "PopUpButton", "DisclosureTriangle",
]);
const INTERACTIVE = new Set(["link", "button", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "tab", "menuitem",
  "menuitemcheckbox", "menuitemradio", "option", "slider", "spinbutton", "listbox", "PopUpButton", "DisclosureTriangle"]);
const VALUE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider"]);
const MAX_NODES = 400, MAX_CHARS = 15000;
const KEYS = {
  Enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" }, Tab: { key: "Tab", code: "Tab", vk: 9 }, Escape: { key: "Escape", code: "Escape", vk: 27 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 38 }, ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 }, ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  PageUp: { key: "PageUp", code: "PageUp", vk: 33 }, PageDown: { key: "PageDown", code: "PageDown", vk: 34 },
  Home: { key: "Home", code: "Home", vk: 36 }, End: { key: "End", code: "End", vk: 35 },
};
const q = (s) => JSON.stringify(String(s).replace(/\s+/g, " ").trim().slice(0, 100));

function createPage(wc) {
  const dbg = wc.debugger;
  // ref 在同一份文件裡是穩定的:同一個節點每次 snapshot 都拿同一個 @eN,新節點才發新號。這樣動作回傳的新 snapshot
  // 不會讓 agent 手上的舊 ref 默默指到別的元素(那是最危險的錯:以為點「下一頁」,點到的是「送出」)。
  // 節點被移除 → describe 失敗 → stale_ref;主 frame 導覽 → 全部作廢、從 @e1 重來。
  let refs = new Map();           // "@eN" → backendDOMNodeId
  let idOf = new Map();           // backendDOMNodeId → "@eN"
  // 每個 CDP 指令都有逾時:頁面卡住(無限迴圈、導覽停在半路)時,工具要回錯誤,不能讓 agent 的呼叫永遠掛著
  const send = (m, p, ms) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("cdp timeout: " + m)), ms || 10000);
    dbg.sendCommand(m, p || {}).then((r) => { clearTimeout(timer); resolve(r); }, (e) => { clearTimeout(timer); reject(e); });
  });

  async function attach() {
    if (!dbg.isAttached()) dbg.attach("1.3");
    await send("DOM.enable"); await send("Page.enable"); await send("Runtime.enable"); await send("Accessibility.enable");
    try { mainFrameId = (await send("Page.getFrameTree")).frameTree.frame.id; } catch (_) { /* 等 frameNavigated */ }
  }
  function detach() { if (guardTimer) clearTimeout(guardTimer); guardTimer = null; decide = null; guardOn = false; try { if (dbg.isAttached()) dbg.detach(); } catch (_) { /* 已經分離 */ } }
  function invalidate() { refs = new Map(); idOf = new Map(); }

  // isolated world 的 context 快取到主 frame 導覽為止(每次都 createIsolatedWorld 會一直長新的 world)
  let ctxCache = null;
  // 導覽守門(spec §3.2 第 6 條的主力):agent 動作後的窗口內,文件請求先停在 Fetch 這一關,decide() 說不行就以 Aborted 取消。
  // 不用 webRequest 取消:那會變成 ERR_BLOCKED_BY_CLIENT 並提交一張錯誤頁,原本那一頁(用戶填到一半的表單)就沒了;
  // Aborted 的導覽不提交任何東西,頁面原封不動。
  let guardOn = false, guardTimer = null, decide = null, mainFrameId = null;
  async function disarm() {
    guardTimer = null; decide = null;
    if (guardOn) { guardOn = false; try { await send("Fetch.disable"); } catch (_) { /* 已分離 */ } }
  }
  async function guard(ms, fn) {
    decide = fn;
    if (guardTimer) clearTimeout(guardTimer);
    guardTimer = setTimeout(() => { disarm(); }, ms);
    if (!guardOn) { guardOn = true; await send("Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }] }); }
  }
  async function onPaused(p) {
    let ok = true;
    try {
      if (decide) {
        // 不在這裡問 Page.getFrameTree:導覽停在 Fetch 時它會卡住,守門窗口過了請求就被放行(實測)
        const main = !mainFrameId || mainFrameId === p.frameId;
        ok = decide({ url: p.request.url, method: p.request.method, main, hasPostData: !!p.request.hasPostData });
      }
    } catch (_) { ok = false; }
    try {
      if (ok) await send("Fetch.continueRequest", { requestId: p.requestId });
      else await send("Fetch.failRequest", { requestId: p.requestId, errorReason: "Aborted" });
    } catch (_) { /* 請求已經不在了 */ }
  }
  dbg.on("message", (_e, method, params) => {
    if (method === "Fetch.requestPaused") { onPaused(params); return; }
    if (method === "Page.frameNavigated" && params && params.frame && !params.frame.parentId) { ctxCache = null; invalidate(); mainFrameId = params.frame.id; }
    else if (method === "Runtime.executionContextsCleared") ctxCache = null;
  });
  async function world() {
    if (ctxCache) return ctxCache;
    const tree = await send("Page.getFrameTree");
    const w = await send("Page.createIsolatedWorld", { frameId: tree.frameTree.frame.id, worldName: "blave", grantUniveralAccess: false });
    ctxCache = w.executionContextId;
    return ctxCache;
  }
  /** 在 isolated world 跑一個 inpage 函式(以值回傳)。 */
  async function run(fn, args) {
    const ctx = await world();
    const expr = "(" + fn.toString() + ").apply(null, " + JSON.stringify(args || []) + ")";
    let r;
    try { r = await send("Runtime.evaluate", { expression: expr, contextId: ctx, returnByValue: true, awaitPromise: true, timeout: 8000 }); }
    catch (e) { ctxCache = null; r = await send("Runtime.evaluate", { expression: expr, contextId: await world(), returnByValue: true, awaitPromise: true, timeout: 8000 }); }
    if (r.exceptionDetails) throw new Error("page script failed");
    return r.result.value;
  }
  async function objectFor(backendNodeId) {
    const ctx = await world();
    const r = await send("DOM.resolveNode", { backendNodeId, executionContextId: ctx });
    return r.object.objectId;
  }
  async function callOn(backendNodeId, fn, args) {
    const objectId = await objectFor(backendNodeId);
    try {
      const r = await send("Runtime.callFunctionOn", { functionDeclaration: fn.toString(), objectId, arguments: (args || []).map((v) => ({ value: v })), returnByValue: true });
      if (r.exceptionDetails) throw new Error("page script failed");
      return r.result.value;
    } finally { send("Runtime.releaseObject", { objectId }).catch(() => {}); }
  }
  const node = (ref) => { const b = refs.get(String(ref || "")); return b === undefined ? null : b; };
  const describe = (b) => callOn(b, IP.describe);

  /** 無障礙樹 → 縮排文字 + ref。sensitive(d) 判定為敏感的欄位,value 顯示為空。 */
  async function snapshot(opts, sensitive) {
    const { nodes } = await send("Accessibility.getFullAXTree");
    const byId = new Map(nodes.map((n) => [n.nodeId, n]));
    let rootId = nodes.length ? nodes[0].nodeId : null;
    if (opts.scope) {
      const b = node(opts.scope); if (b === null) return { error: "stale_ref" };
      const n = nodes.find((x) => x.backendDOMNodeId === b); if (!n) return { error: "stale_ref" };
      rootId = n.nodeId;
    }
    let shown = 0;
    const lines = []; let chars = 0, count = 0, truncated = false, valueChecks = 0;
    async function walk(id, depth) {
      if (truncated) return;
      const n = byId.get(id); if (!n) return;
      const role = n.role && n.role.value, name = (n.name && n.name.value) || "";
      let d = depth;
      const keep = !n.ignored && KEEP_ROLES.has(role) && (!opts.interactive_only || INTERACTIVE.has(role)) && (role !== "listitem" || name) && (role !== "img" && role !== "image" || name);
      if (keep && n.backendDOMNodeId !== undefined) {
        if (count >= MAX_NODES || chars >= MAX_CHARS) { truncated = true; return; }
        let r = idOf.get(n.backendDOMNodeId);
        if (!r) { r = "@e" + (refs.size + 1); refs.set(r, n.backendDOMNodeId); idOf.set(n.backendDOMNodeId, r); }
        shown++;
        let line = "  ".repeat(depth) + "- " + role + (name ? " " + q(name) : "") + " [" + r + "]";
        const props = {}; for (const p of n.properties || []) props[p.name] = p.value && p.value.value;
        if (role === "heading" && props.level) line += " level=" + props.level;
        if (props.checked !== undefined && props.checked !== "false" && props.checked !== false) line += " checked";
        if (props.expanded !== undefined) line += props.expanded ? " expanded" : " collapsed";
        if (props.disabled) line += " disabled";
        if (VALUE_ROLES.has(role)) {
          let v = n.value && n.value.value !== undefined ? String(n.value.value) : "";
          if (v && valueChecks < 60) { valueChecks++; try { if (sensitive(await describe(n.backendDOMNodeId))) v = ""; } catch (_) { v = ""; } }
          else if (v) v = "";
          line += " value=" + q(v);
        }
        if (role === "link" && props.url) line += " url=" + q(String(props.url).slice(0, 200));
        lines.push(line); chars += line.length + 1; count++; d = depth + 1;
      }
      for (const c of n.childIds || []) await walk(c, d);
    }
    if (rootId !== null) await walk(rootId, 0);
    return { text: lines.join("\n"), refs: shown, truncated };
  }

  /** 元素中心點 + 命中檢查(落點必須是目標或其子孫——擋透明覆蓋層把點擊導到別的鈕)。
      onScreen = false(分頁停在視窗外):Chromium 對視窗外的 view 不做命中測試、也不收滑鼠事件(實測 Electron 44),
      所以改成直接對目標元素 click()——點的就是 agent 指定的那個元素,覆蓋層導不走它,命中檢查在這條路上沒有意義。 */
  /** 命中檢查:(x,y) 上最上層的元素是目標本身、它的子孫,或對應的 label。 */
  async function hitOk(b, x, y) {
    const hit = await send("DOM.getNodeForLocation", { x, y, includeUserAgentShadowDOM: false, ignorePointerEventsNone: false }).catch(() => null);
    if (!hit) return false;
    if (hit.backendNodeId === b) return true;
    let hitObj, tgtObj;
    try {
      hitObj = await objectFor(hit.backendNodeId); tgtObj = await objectFor(b);
      const r = await send("Runtime.callFunctionOn", { functionDeclaration: "function(h){return this===h||this.contains(h)||this.control===h||h.control===this||(!!h.closest&&h.closest('label')!==null&&h.closest('label').control===this)}", objectId: tgtObj, arguments: [{ objectId: hitObj }], returnByValue: true });
      return !!r.result.value;
    } catch (_) { return false; } finally {
      if (hitObj) send("Runtime.releaseObject", { objectId: hitObj }).catch(() => {}); if (tgtObj) send("Runtime.releaseObject", { objectId: tgtObj }).catch(() => {});
    }
  }
  async function center(b, onScreen) {
    await send("DOM.scrollIntoViewIfNeeded", { backendNodeId: b }).catch(() => {});
    const { quads } = await send("DOM.getContentQuads", { backendNodeId: b });
    if (!quads || !quads.length) return { error: "not_visible" };
    const qd = quads[0];
    const x = Math.round((qd[0] + qd[2] + qd[4] + qd[6]) / 4), y = Math.round((qd[1] + qd[3] + qd[5] + qd[7]) / 4);
    if (!onScreen) {
      const xs0 = [qd[0], qd[2], qd[4], qd[6]], ys0 = [qd[1], qd[3], qd[5], qd[7]];
      return { x, y, direct: true, box: { x: Math.min(...xs0), y: Math.min(...ys0), w: Math.max(...xs0) - Math.min(...xs0), h: Math.max(...ys0) - Math.min(...ys0) } };
    }
    if (!(await hitOk(b, x, y))) return { error: "obscured" };
    const xs = [qd[0], qd[2], qd[4], qd[6]], ys = [qd[1], qd[3], qd[5], qd[7]];
    return { x, y, direct: !onScreen, box: { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) } };
  }
  let lastPos = null;   // 上一次滑鼠停在哪(可視區座標):下一次點擊從這裡滑過去
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  /** 可見分頁:真的送一串 mouseMoved 沿路徑滑到目標(glideMs 內),到點停 40ms 再按下放開。glideMs = 0 就直接到。 */
  async function click(b, pos, glideMs) {
    const p = pos || await center(b, false);
    if (p.error) return p;
    if (p.direct) { await callOn(b, function () { this.click(); return true; }); return p; }
    if (glideMs > 0) {
      const from = lastPos || { x: p.x - 120, y: p.y - 80 }, steps = Math.max(4, Math.round(glideMs / 30));
      for (let i = 1; i <= steps; i++) {
        const k = i / steps, e = 1 - Math.pow(1 - k, 3);
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(from.x + (p.x - from.x) * e), y: Math.round(from.y + (p.y - from.y) * e) });
        await sleep(glideMs / steps);
      }
      await sleep(40);
    }
    lastPos = { x: p.x, y: p.y };
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y });
    // 稽核 R2:滑行途中 hover 選單展開、版面位移都可能蓋住目標——按下前在同一個座標重做命中檢查,不符就不按
    if (!(await hitOk(b, p.x, p.y))) return { error: "obscured", pressed: false };
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", clickCount: 1 });
    return p;
  }
  /** opt: { clear(fill 先清空;type 接在後面), perChar(逐字送), delay(每字毫秒) } */
  async function fill(b, text, d, opt) {
    if (d.isSelect) { const got = await callOn(b, IP.selectOption, [text]); return got === null ? { error: "invalid_args", message: "no option matches; options: " + d.options.slice(0, 20).join(" | ") } : {}; }
    await send("DOM.focus", { backendNodeId: b });
    if (opt.clear) await callOn(b, IP.clearField);
    if (!opt.perChar) { await send("Input.insertText", { text: String(text) }); return {}; }
    for (const ch of String(text)) { await send("Input.insertText", { text: ch }); await sleep(opt.delay || 35); }
    return {};
  }
  /** 目前有焦點的元素 → { backendNodeId, desc } 或 null。 */
  async function focused() {
    const ctx = await world();
    const r = await send("Runtime.evaluate", { expression: "document.activeElement", contextId: ctx });
    if (!r.result || !r.result.objectId) return null;
    try {
      const dn = await send("DOM.describeNode", { objectId: r.result.objectId });
      const b = dn.node.backendNodeId;
      if (dn.node.nodeName === "BODY" || dn.node.nodeName === "HTML") return { backendNodeId: b, desc: { tag: "body", inForm: false } };
      return { backendNodeId: b, desc: await describe(b) };
    } finally { send("Runtime.releaseObject", { objectId: r.result.objectId }).catch(() => {}); }
  }
  /** onScreen = false:視窗外的 view 收不到 CDP 的鍵盤事件(同滑鼠,實測),改在頁內做同一件事——
      Enter 在 form 裡 = requestSubmit()(會跑 submit 事件與表單驗證,跟按 Enter 一樣;送出分級在呼叫端已判過),
      翻頁鍵 = 捲動,其餘送一個 KeyboardEvent 給有焦點的元素。 */
  async function press(key, onScreen) {
    const k = KEYS[key]; if (!k) return { error: "invalid_args" };
    if (!onScreen) {
      await run(function (key) {
        const el = document.activeElement || document.body;
        if (key === "Enter" && el) {
          // Enter 在按鈕 / 連結上 = 點它(跟畫面上按 Enter 一樣);只有文字欄位才是送出表單(稽核 R4)
          const tag = (el.tagName || "").toLowerCase(), type = String(el.type || "").toLowerCase(), role = el.getAttribute && el.getAttribute("role");
          if (tag === "button" || tag === "a" || tag === "summary" || role === "button" || role === "link" || (tag === "input" && ["submit", "button", "image", "reset"].includes(type))) { el.click(); return true; }
          if (el.form) { el.form.requestSubmit(); return true; }
        }
        const h = window.innerHeight * 0.9;
        if (key === "PageDown") { window.scrollBy(0, h); return true; }
        if (key === "PageUp") { window.scrollBy(0, -h); return true; }
        if (key === "Home") { window.scrollTo(0, 0); return true; }
        if (key === "End") { window.scrollTo(0, document.documentElement.scrollHeight); return true; }
        for (const type of ["keydown", "keyup"]) el.dispatchEvent(new KeyboardEvent(type, { key, code: key, bubbles: true, cancelable: true }));
        return true;
      }, [key]);
      return {};
    }
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, text: k.text });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: k.key, code: k.code, windowsVirtualKeyCode: k.vk });
    return {};
  }
  async function screenshot(annotate) {
    let cleanup = null;
    if (annotate && refs.size) {
      const marks = [];
      for (const [r, b] of [...refs].slice(0, 80)) {
        try { const { quads } = await send("DOM.getContentQuads", { backendNodeId: b }); if (quads && quads.length) marks.push({ r, x: quads[0][0], y: quads[0][1] }); } catch (_) { /* 看不到 */ }
      }
      await run(function (ms) {
        const host = document.createElement("div"); host.id = "__blave_marks"; host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
        for (const m of ms) { const s = document.createElement("span"); s.textContent = m.r; s.style.cssText = "position:fixed;left:" + m.x + "px;top:" + m.y + "px;font:600 10px monospace;background:#111;color:#fff;padding:0 2px"; host.appendChild(s); }
        document.documentElement.appendChild(host); return true;
      }, [marks]);
      cleanup = () => run(function () { const h = document.getElementById("__blave_marks"); if (h) h.remove(); return true; }).catch(() => {});
    }
    try {
      const r = await send("Page.captureScreenshot", { format: "png" }, 8000);
      return r.data;
    } catch (_) { return null; } finally { if (cleanup) await cleanup(); }
  }
  return {
    attach, detach, invalidate, guard, guarded: () => guardOn, disarm, run, callOn, describe, snapshot, center, click, fill, focused, press, screenshot, node,
    refCount: () => refs.size,
    extract: () => run(IP.extract), serp: (engine) => run(IP.serp, [engine]), hasText: (s) => run(IP.hasText, [s]),
    scroll: (dir, amount, smoothMs) => run(IP.scrollPage, [dir, amount, smoothMs || 0]), lastPos: () => lastPos, progress: () => run(IP.progress), quiet: () => run(IP.quiet),
  };
}

module.exports = { createPage, KEYS };
