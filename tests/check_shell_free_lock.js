// 綁卡前的 30 TWD 只能用 DeepSeek V4 Pro 的型號選單(0.1.33;spec desktop-free-credit-deepseek-only v3 S1–S3、T2)。
// 不打 api、不開 Electron:app.js 的 mpInit / mpFreeSync / acctSet / mpSave / mpPaint / mpPickModel / classifyFault 照原文切出來,DOM 換假的。
//   1. 存起來的型號被鎖:換回預設、prefs 的 model 不變;鎖住期間改 effort,prefs 的 model 也不變
//   2. 鎖住的列照列、aria-disabled;#mp-lock-note(sr-only)一直有完整原因給讀屏;點了(滑鼠或 Enter / Space)才在那一列右邊出短句、念一次,
//      同時只有一列帶、換列搬移、關掉清除;選擇不變、送 mp_locked_click;方向鍵跳過它、不送事件,越過時短句出在越過的第一列(每次打開只念一次)
//   3. free_only true → false:換回原本的型號、unavailable 清掉;一開始就是 false 也清(複審 P2);欄位不存在不鎖不清
//   4. 型錄先回、帳號狀態後回:還是會上鎖(反過來也一樣)
//   5. 撞到 404 且 freeOnly:走暫換、fault.freeLocked、鈕是綁卡,不呼叫 mpMarkUnavailable;freeOnly 未知照舊標記
//   6. 型錄空 + free-only:畫面送 null,主行程 fallback 送 V4 Pro(整合稽核 P2-1)
// 跑法:node tests/check_shell_free_lock.js
const fs = require("fs"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "app.js"), "utf8");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };
const fn = (name) => { const i = src.indexOf("function " + name + "("); if (i < 0) throw new Error("找不到 " + name); let d = 0; for (let k = src.indexOf("{", src.indexOf(")", i)); k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}" && --d === 0) return src.slice(i, k + 1); } throw new Error("切不出 " + name); };
const line = (re) => { const m = src.match(re); if (!m) throw new Error("找不到 " + re); return m[0]; };
const block = (head) => { const i = src.indexOf(head); if (i < 0) throw new Error("找不到 " + head); let d = 0; for (let k = src.indexOf("{", i + head.length - 1); k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}" && --d === 0) return src.slice(src.indexOf("{", i + head.length - 1), k + 1); } throw new Error("切不出 " + head); };

const PRO = "deepseek/deepseek-v4-pro", FLASH = "deepseek/deepseek-v4-flash", SONNET = "anthropic/claude-sonnet-5-5";
const CATALOG = { models: [
  { id: SONNET, name: "Claude Sonnet 5.5", efforts: ["low", "high"], defaultEffort: "high", free_credit: false },
  { id: PRO, name: "DeepSeek V4 Pro", efforts: ["high"], defaultEffort: "high", free_credit: true },
  { id: FLASH, name: "DeepSeek V4 Flash", efforts: ["high"], defaultEffort: "high", free_credit: false },
], defaultModel: PRO };

// 假 DOM:mpPaint 用到的節點與 createElement 出來的列
function el(tag) {
  const e = { tag, children: [], attrs: {}, cls: new Set(), dataset: {}, listeners: {}, textContent: "", hidden: false, tabIndex: 0,
    classList: { add: (c) => e.cls.add(c), remove: (c) => e.cls.delete(c), toggle: (c, on) => (on ? e.cls.add(c) : e.cls.delete(c)) },
    setAttribute(k, v) { e.attrs[k] = String(v); }, getAttribute(k) { return k in e.attrs ? e.attrs[k] : null; },
    appendChild(c) { c.parent = e; e.children.push(c); return c; },
    addEventListener(ev, f) { (e.listeners[ev] = e.listeners[ev] || []).push(f); },
    click(detail = 0) { (e.listeners.click || []).forEach((f) => f({ detail })); },
    focus() {}, closest(sel) { let x = e; while (x) { if (sel === '[role="radiogroup"]' && x.radiogroup) return x; x = x.parent; } return null; },
    querySelector(sel) { return e.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) {
      if (sel[0] === ".") { const out = []; const walk = (n) => n.children.forEach((c) => { if (c.cls && c.cls.has(sel.slice(1))) out.push(c); walk(c); }); walk(e); return out; }
      return e.children.filter((c) => (sel === '[role="radio"]' ? c.attrs.role === "radio" : sel === '[aria-checked="true"]' ? c.attrs["aria-checked"] === "true" : false)); },
    remove() { if (e.parent) e.parent.children = e.parent.children.filter((c) => c !== e); },
  };
  Object.defineProperty(e, "className", { get() { return [...e.cls].join(" "); }, set(v) { e.cls = new Set(String(v).split(/\s+/).filter(Boolean)); } });
  Object.defineProperty(e, "textContent", { get() { return e._t || ""; }, set(v) { e._t = v; if (v === "") e.children = []; } });
  return e;
}

function world(o = {}) {
  const els = {}; const $ = (id) => els[id] || (els[id] = Object.assign(el("div"), { id, radiogroup: id === "mp-models" || id === "mp-rail" }));
  const saved = [], tracked = [], marked = [], binds = [], said = [];
  const prefs = o.prefs || { blave: { model: o.saved || SONNET, efforts: {}, ...(o.unavailable ? { unavailable: o.unavailable.slice() } : {}) } };
  let resolveOpt; const optP = new Promise((r) => { resolveOpt = r; });
  const window = { blave: { modelOptions: async () => (o.lateCatalog ? optP : o.catalog || CATALOG), loadModelPrefs: async () => prefs, saveModelPrefs: (p) => saved.push(JSON.parse(JSON.stringify(p))), openExternal() {} } };
  const STR = { "mp.locked": "其他模型綁卡或儲值後可用", "mp.na": "你的方案沒有", "mp.default": "預設", "fault.freeLocked": "「{model}」要綁卡或儲值才能用，這一輪沒有跑。已換回「{to}」。",
    "mp.lockedRow": "綁卡或儲值後可用", "fault.noModelSwitched": "你的帳號用不了「{model}」，這一輪沒有跑。已換回「{to}」。", "acct.addCard": "前往綁卡", "fault.noModelBtn": "選別的模型" };
  const t = (k, v) => { let s = STR[k] || k; if (v) for (const x in v) s = s.split("{" + x + "}").join(v[x]); return s; };
  const panelKey = block('$("mp-panel").addEventListener("keydown", (e) => {');
  const M = new Function("$", "window", "document", "t", "trackFeature", "bindGo", "markHook", "srSay", `
    const MP = { kind: null, models: [], prefs: {}, model: null, freeOnly: false, displaced: null };
    let acct = null, cur = "blave", turnModel = null, hasToken = false;
    const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
    const NO_MODEL_RE = ${line(/^const NO_MODEL_RE = .*$/m).replace(/^const NO_MODEL_RE = /, "").replace(/;$/, "")};
    const limitMatch = () => null, mpBillPaint = () => {}, attachHintPaint = () => {}, balLoad = () => {};
    const mpMarkUnavailable = (id) => markHook(id);
    ${line(/^const mpLocked = .*$/m)}
    ${fn("mpLevel")}\n${fn("mpCur")}\n${fn("mpEffort")}\n${fn("mpSave")}\n${fn("mpFreeSync")}\n${fn("acctSet")}
    async ${fn("mpInit")}\n${fn("mpLockRowPaint")}\n${fn("mpLockSay")}\n${fn("mpOpen")}\n${fn("mpClose")}\n${fn("mpPaint")}\n${fn("mpPickModel")}\n${fn("mpPickEffort")}\n${fn("classifyFault")}
    const panelKey = (e) => ${panelKey};
    return { MP, mpInit, mpOpen, mpClose, mpPaint, acctSet, mpPickEffort, mpPickModel, classifyFault, panelKey,
      setTurn: (m) => { turnModel = m; } };`)($, window, { createElement: el }, t, (n) => tracked.push(n), (n) => binds.push(n), (id) => marked.push(id), (x) => said.push(x));
  return { M, $, saved, tracked, marked, binds, said, prefs, resolveOpt };
}
const rows = (w) => w.$("mp-models").children;
const row = (w, name) => rows(w).find((r) => r.children[0].textContent === name);
const STATUS = (free_only) => (free_only === undefined ? { can_run: true } : { can_run: true, free_only });

(async () => {
  // 1. 存著 Sonnet、帳號狀態先到(free_only true)→ mpInit 讀到就鎖
  {
    const w = world();
    w.M.acctSet(STATUS(true));
    await w.M.mpInit("blave");
    ok("1. 存著的 Sonnet 被鎖:換回預設 Pro、記在 displaced、prefs 的 model 不變",
      w.M.MP.model === PRO && w.M.MP.displaced === SONNET && w.prefs.blave.model === SONNET && w.saved.length === 0, [w.M.MP.model, w.M.MP.displaced, w.saved]);
    w.M.mpPickEffort("high");
    ok("1. 鎖住期間改 effort:存檔的 model 還是 Sonnet", w.saved.length === 1 && w.saved[0].blave.model === SONNET && w.saved[0].blave.efforts[PRO] === "high", w.saved);

    // 2. 列與點擊
    const s = row(w, "Claude Sonnet 5.5"), f = row(w, "DeepSeek V4 Flash"), p = row(w, "DeepSeek V4 Pro");
    ok("2. 鎖住的列照列、只留名字:aria-disabled、is-locked、aria-describedby 指清單下那一行;Pro 不鎖",
      rows(w).length === 3 && s.attrs["aria-disabled"] === "true" && s.cls.has("is-locked") && s.children.length === 1
      && s.attrs["aria-describedby"] === "mp-lock-note" && f.attrs["aria-disabled"] === "true" && !("aria-disabled" in p.attrs) && !("aria-describedby" in p.attrs), rows(w).map((r) => r.attrs));
    const note = w.$("mp-lock-note"), LOCKED = "其他模型綁卡或儲值後可用", ROW = "綁卡或儲值後可用";
    const tagged = () => rows(w).filter((r) => r.children.some((c) => c.cls.has("mp-lockrow")));
    const shape = () => JSON.stringify([w.$("mp-models").children.length, rows(w).map((r) => r.dataset.id), w.$("mp-models").children.map((r) => r.children.filter((c) => !c.cls.has("mp-lockrow")).length)]);
    ok("2. #mp-lock-note 一開始就有完整那句(畫面上是 sr-only,讀屏從鎖住列的 aria-describedby 念得到);列上沒有短句、沒念",
      note.textContent === LOCKED && note.hidden !== true && tagged().length === 0 && w.said.length === 0, [note.textContent, w.said]);
    const before = shape();
    s.click(1);
    const sTag = s.children.find((c) => c.cls.has("mp-lockrow"));
    ok("2. 滑鼠點鎖住的 Sonnet:選擇不變、送 mp_locked_click;短句「綁卡或儲值後可用」出在 Sonnet 那一列右邊(同「預設」的 .mp-def)、念完整那句一次",
      w.M.MP.model === PRO && w.tracked.join() === "mp_locked_click" && !!sTag && sTag.textContent === ROW && sTag.cls.has("mp-def") && tagged().length === 1 && w.said.join() === LOCKED,
      [w.M.MP.model, w.tracked, tagged().length, w.said]);
    const css = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "app.css"), "utf8");
    ok("2. 最窄寬度不折行:每列第一個節點是型號名、title 帶全名;右邊小字(預設／短句)都是 .mp-def;CSS 截名字(nowrap + ellipsis + min-width 0)、.mp-def 不縮(flex: none)、nowrap",
      rows(w).every((r) => r.children[0].title === r.children[0].textContent && !r.children[0].cls.has("mp-def") && r.children.slice(1).every((c) => c.cls.has("mp-def")))
      && /\.mp-row > span:first-child \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/.test(css)
      && /\.mp-row > \.mp-def \{ flex: none; \}/.test(css) && /\.mp-def \{[^}]*white-space: nowrap;/.test(css), rows(w).map((r) => [r.children[0].title, r.children.map((c) => [...c.cls].join("."))]));
    ok("2. 點擊前後清單結構不變:列數、順序一樣,清單下沒有多出任何節點(高度不變靠這個;實際 px 在開發版量)", shape() === before && w.$("mp-models").children.every((c) => c.attrs.role === "radio"), [before, shape()]);
    w.said.length = 0; w.tracked.length = 0;
    f.click(1);
    ok("2. 再點另一個鎖住的 Flash:短句搬到 Flash、Sonnet 那句拿掉(同時只有一列帶);點了照念", tagged().length === 1 && tagged()[0] === f && w.said.join() === LOCKED && w.tracked.join() === "mp_locked_click", tagged().map((r) => r.dataset.id));
    w.M.mpPaint();
    ok("2. 重畫選單(例如回合結束):短句留在 Flash", tagged().length === 1 && tagged()[0].dataset.id === FLASH);
    w.M.mpClose(false);
    ok("2. 關掉選單:短句清掉", tagged().length === 0 && w.M.MP.lockRow === null);
    w.M.mpOpen(true);
    ok("2. 重新打開:不帶短句", tagged().length === 0);
    w.tracked.length = 0; w.said.length = 0;
    row(w, "Claude Sonnet 5.5").click(0);
    ok("2. 停在鎖住的列按 Enter / Space(detail 0):跟點擊同一行為(選擇不變、送事件、那一列出短句、念一次)",
      w.M.MP.model === PRO && w.tracked.join() === "mp_locked_click" && tagged().length === 1 && tagged()[0].dataset.id === SONNET && w.said.join() === LOCKED, [w.tracked, w.said]);
    w.tracked.length = 0;
    w.M.mpPickModel(SONNET, true);
    ok("2. mpPickModel 直接叫鎖住的 id:不換", w.M.MP.model === PRO);
    w.M.mpOpen(false); w.said.length = 0;
    w.M.panelKey({ key: "ArrowDown", target: row(w, "DeepSeek V4 Pro"), preventDefault() {} });
    ok("2. 方向鍵從 Pro 往下:Flash、Sonnet 都鎖 → 繞回 Pro 不動;短句出在越過的第一列(Flash)、念一次、不送 mp_locked_click",
      w.M.MP.model === PRO && tagged().length === 1 && tagged()[0].dataset.id === FLASH && w.said.join() === LOCKED && w.tracked.length === 0, [w.M.MP.model, tagged().map((r) => r.dataset.id), w.said, w.tracked]);
    w.M.panelKey({ key: "ArrowUp", target: row(w, "DeepSeek V4 Pro"), preventDefault() {} });
    ok("2. 同一次打開再按方向鍵(往上越過 Sonnet):短句搬到 Sonnet、不重念", tagged().length === 1 && tagged()[0].dataset.id === SONNET && w.said.length === 1, [tagged().map((r) => r.dataset.id), w.said]);
    w.M.mpOpen(false); w.said.length = 0;
    w.M.panelKey({ key: "ArrowRight", target: w.$("mp-rail").children[0], preventDefault() {} });
    ok("2. 思考深度那一排的方向鍵不出短句、不念(只認型號清單)", w.said.length === 0 && tagged().length === 0, w.said);

    // 讀不到帳號狀態(accountStatus 回 null):不等於沒鎖,沿用上一次(設計稽核 #4)
    w.M.acctSet(null);
    ok("2. acctSet(null) 不解鎖:還是 Pro、Sonnet 照鎖、displaced 留著、沒存檔蓋掉用戶的型號",
      w.M.MP.model === PRO && w.M.MP.freeOnly === true && w.M.MP.displaced === SONNET && row(w, "Claude Sonnet 5.5").attrs["aria-disabled"] === "true"
      && w.saved.every((x) => x.blave.model === SONNET), [w.M.MP.model, w.M.MP.freeOnly, w.saved]);

    // 3. 解鎖:換回原本的 Sonnet
    w.M.acctSet(STATUS(false));
    ok("3. free_only true → false:換回 Sonnet、displaced 清掉、列不再鎖",
      w.M.MP.model === SONNET && w.M.MP.displaced === null && !("aria-disabled" in row(w, "Claude Sonnet 5.5").attrs) && w.$("mp-lock-note").textContent === "", [w.M.MP.model, w.M.MP.displaced]);
    w.M.panelKey({ key: "ArrowDown", target: row(w, "Claude Sonnet 5.5"), preventDefault() {} });
    ok("3. 解鎖後方向鍵照常走到下一列(Pro)", w.M.MP.model === PRO, w.M.MP.model);
  }
  // 3. 一開始就是 false、prefs 帶著 0.1.32 撞鎖留下的 unavailable(複審 P2);非 free_credit=false 的標記留著
  {
    const w = world({ saved: PRO, unavailable: [SONNET, "anthropic/claude-opus-5-5"] });
    await w.M.mpInit("blave");
    ok("3. 型錄先到、還沒帳號狀態:標記不動", w.prefs.blave.unavailable.length === 2, w.prefs.blave.unavailable);
    w.M.acctSet(STATUS(false));
    ok("3. 第一次 acctSet 就是 false:Sonnet 的標記清掉並存檔;型錄外的 id 不動",
      w.prefs.blave.unavailable.join() === "anthropic/claude-opus-5-5" && w.saved.length === 1 && w.saved[0].blave.unavailable.join() === "anthropic/claude-opus-5-5", w.prefs.blave);
  }
  {
    const w = world({ saved: PRO, unavailable: [SONNET] });
    w.M.acctSet(STATUS(false));
    await w.M.mpInit("blave");
    ok("3. 帳號狀態先到(false)、mpInit 後到:也清", w.prefs.blave.unavailable.length === 0, w.prefs.blave.unavailable);
  }
  {
    const w = world({ unavailable: [SONNET] });
    w.M.acctSet(STATUS(undefined));
    await w.M.mpInit("blave");
    ok("3. 舊 api 沒有 free_only:不鎖、不清", w.M.MP.model === SONNET && w.prefs.blave.unavailable.join() === SONNET && w.saved.length === 0, [w.M.MP.model, w.prefs.blave]);
  }
  // 4. 型錄先回、帳號狀態後回
  {
    const w = world();
    await w.M.mpInit("blave");
    ok("4. 型錄先到、還沒帳號狀態:照存的 Sonnet", w.M.MP.model === SONNET);
    w.M.acctSet(STATUS(true));
    ok("4. 帳號狀態後到(true):上鎖、換回 Pro、記 displaced", w.M.MP.model === PRO && w.M.MP.displaced === SONNET
      && row(w, "Claude Sonnet 5.5").attrs["aria-disabled"] === "true", [w.M.MP.model, w.M.MP.displaced]);
    w.M.mpPickModel(PRO, true);
    w.M.acctSet(STATUS(true));
    ok("4. 已經在 Pro:再收到同一份狀態不重畫不存檔", w.saved.length === 0, w.saved);
  }
  // 5. classifyFault 撞到 A3 的 404
  {
    const w = world({ saved: PRO });
    await w.M.mpInit("blave");
    w.M.acctSet(STATUS(true));
    w.M.MP.model = SONNET; w.M.setTurn(SONNET);   // 0.1.32 存的、或鎖之前就送出去的那一輪
    const f = w.M.classifyFault("There's an issue with the selected model (claude-sonnet-5-5). It may not exist or you may not have access to it.");
    ok("5. freeOnly + 撞到 404:暫換回 Pro、fault.freeLocked、鈕是綁卡,不呼叫 mpMarkUnavailable",
      w.marked.length === 0 && w.M.MP.model === PRO && w.M.MP.displaced === SONNET
      && f.text === "「Claude Sonnet 5.5」要綁卡或儲值才能用，這一輪沒有跑。已換回「DeepSeek V4 Pro」。" && f.label === "前往綁卡", [w.marked, w.M.MP.model, f]);
    f.act();
    ok("5. 鈕送 bind_model", w.binds.join() === "bind_model", w.binds);
  }
  {
    const w = world({ saved: SONNET });
    await w.M.mpInit("blave");
    w.M.setTurn(SONNET);
    w.M.classifyFault("There's an issue with the selected model (claude-sonnet-5-5). It may not exist or you may not have access to it.");
    ok("5. 還不知道 free_only:照舊 mpMarkUnavailable(回合結束重讀後由 mpFreeSync 清)", w.marked.join() === SONNET, w.marked);
  }
  // 6. 型錄空(抓失敗或還沒回來)+ free-only:畫面送 null,主行程的 fallback 要是 V4 Pro,不是 Sonnet(整合稽核 P2-1)
  {
    const mainSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8");
    const mfn = (name) => { const i = mainSrc.indexOf("function " + name + "("); let d = 0; for (let k = mainSrc.indexOf("{", mainSrc.indexOf(")", i)); k < mainSrc.length; k++) { if (mainSrc[k] === "{") d++; else if (mainSrc[k] === "}" && --d === 0) return mainSrc.slice(i, k + 1); } };
    const lit = (n) => mainSrc.match(new RegExp("^const " + n + " = [^\\n]*$", "m"))[0];
    const args = new Function(`${lit("CLAUDE_DEFAULT")}\n${lit("BLAVE_DEFAULT")}\n${mfn("turnModelArgs")}\n return turnModelArgs;`)();
    const w = world({ saved: SONNET, catalog: { models: [], defaultModel: null } });
    w.M.acctSet(STATUS(true));
    let err = null; try { await w.M.mpInit("blave"); w.M.acctSet(STATUS(true)); } catch (e) { err = String(e); }
    ok("6. 型錄空 + free-only:mpInit / acctSet 不炸、選擇是 null(交給主行程的 fallback)", err === null && w.M.MP.model === null, [err, w.M.MP.model]);
    const sent = args({ relayPreset: null, model: w.M.MP.model, useCodex: false, useBlave: true });
    ok("6. 主行程對 Blave 線的 null 送 deepseek/deepseek-v4-pro(free-only 也放行、不撞 404)", sent.join(" ") === "--model " + PRO, sent);
    ok("6. 自己的 Claude 線照舊送 Sonnet、Codex 不帶、選了就送選的、自帶金鑰照它的表",
      args({ model: null, useCodex: false, useBlave: false }).join(" ") === "--model claude-sonnet-5-5"
      && args({ model: null, useCodex: true, useBlave: false }).length === 0
      && args({ model: SONNET, useBlave: true }).join(" ") === "--model " + SONNET
      && args({ relayPreset: { models: ["a"], defaultModel: "a" }, model: "x" }).join(" ") === "--model a");
  }
  // 換引擎再切回 Blave、這時帳號狀態讀不到:鎖照舊(mpInit 不重設 freeOnly)
  {
    const w = world();
    w.M.acctSet(STATUS(true));
    await w.M.mpInit("blave");
    await w.M.mpInit("codex");
    w.M.acctSet(null);
    await w.M.mpInit("blave");
    ok("7. 切到 Codex 再切回 Blave + acctSet(null):仍鎖、送 Pro、Sonnet 列鎖住、存的型號還是 Sonnet",
      w.M.MP.freeOnly === true && w.M.MP.model === PRO && w.M.MP.displaced === SONNET
      && row(w, "Claude Sonnet 5.5").attrs["aria-disabled"] === "true" && w.prefs.blave.model === SONNET, [w.M.MP.freeOnly, w.M.MP.model, w.M.MP.displaced]);
  }
  // 登出才清鎖(acctSignOut;那支要整個登入流程,只釘接線)
  ok("7. 登出:acctSignOut 把 freeOnly 清掉並收斂(換回被鎖前的型號)", /hasToken = false; acct = null;[^\n]*\n[^\n]*wdPaint\(\);[^\n]*\n\s*MP\.freeOnly = false; if \(mpFreeSync\(\)\) mpPaint\(\);/.test(src));
  // 鎖住列沒有 hover、游標 not-allowed(canon › Disabled;設計稽核 #1)
  const css = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "app.css"), "utf8");
  ok("7. CSS:.mp-row.is-locked 游標 not-allowed、:hover 不鋪底", /\.mp-row\.is-locked \{[^}]*cursor: not-allowed;/.test(css) && /\.mp-row\.is-locked:hover \{ background: none; \}/.test(css));
  console.log(red ? `\n${red} FAILED` : "\nALL PASS"); process.exit(red ? 1 : 0);
})();
