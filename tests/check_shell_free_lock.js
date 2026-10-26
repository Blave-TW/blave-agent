// 綁卡前的 30 TWD 只能用 DeepSeek V4 Pro 的型號選單(0.1.33;spec desktop-free-credit-deepseek-only v3 S1–S3、T2)。
// 不打 api、不開 Electron:app.js 的 mpInit / mpFreeSync / acctSet / mpSave / mpPaint / mpPickModel / classifyFault 照原文切出來,DOM 換假的。
//   1. 存起來的型號被鎖:換回預設、prefs 的 model 不變;鎖住期間改 effort,prefs 的 model 也不變
//   2. 鎖住的列照列、aria-disabled、右邊小字;點了選擇不變、送 mp_locked_click;方向鍵跳過它、不送
//   3. free_only true → false:換回原本的型號、unavailable 清掉;一開始就是 false 也清(複審 P2);欄位不存在不鎖不清
//   4. 型錄先回、帳號狀態後回:還是會上鎖(反過來也一樣)
//   5. 撞到 404 且 freeOnly:走暫換、fault.freeLocked、鈕是綁卡,不呼叫 mpMarkUnavailable;freeOnly 未知照舊標記
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
  const e = { tag, children: [], attrs: {}, cls: new Set(), listeners: {}, textContent: "", hidden: false, tabIndex: 0,
    classList: { add: (c) => e.cls.add(c), remove: (c) => e.cls.delete(c), toggle: (c, on) => (on ? e.cls.add(c) : e.cls.delete(c)) },
    setAttribute(k, v) { e.attrs[k] = String(v); }, getAttribute(k) { return k in e.attrs ? e.attrs[k] : null; },
    appendChild(c) { c.parent = e; e.children.push(c); return c; },
    addEventListener(ev, f) { (e.listeners[ev] = e.listeners[ev] || []).push(f); },
    click(detail = 0) { (e.listeners.click || []).forEach((f) => f({ detail })); },
    focus() {}, closest(sel) { let x = e; while (x) { if (sel === '[role="radiogroup"]' && x.radiogroup) return x; x = x.parent; } return null; },
    querySelector(sel) { return e.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) { return e.children.filter((c) => (sel === '[role="radio"]' ? c.attrs.role === "radio" : sel === '[aria-checked="true"]' ? c.attrs["aria-checked"] === "true" : false)); },
  };
  Object.defineProperty(e, "textContent", { get() { return e._t || ""; }, set(v) { e._t = v; if (v === "") e.children = []; } });
  return e;
}

function world(o = {}) {
  const els = {}; const $ = (id) => els[id] || (els[id] = Object.assign(el("div"), { id, radiogroup: id === "mp-models" || id === "mp-rail" }));
  const saved = [], tracked = [], marked = [], binds = [];
  const prefs = o.prefs || { blave: { model: o.saved || SONNET, efforts: {}, ...(o.unavailable ? { unavailable: o.unavailable.slice() } : {}) } };
  let resolveOpt; const optP = new Promise((r) => { resolveOpt = r; });
  const window = { blave: { modelOptions: async () => (o.lateCatalog ? optP : CATALOG), loadModelPrefs: async () => prefs, saveModelPrefs: (p) => saved.push(JSON.parse(JSON.stringify(p))), openExternal() {} } };
  const STR = { "mp.locked": "綁卡或儲值後可用", "mp.na": "你的方案沒有", "mp.default": "預設", "fault.freeLocked": "「{model}」要綁卡或儲值才能用。已換回「{to}」。",
    "fault.noModelSwitched": "你的帳號用不了「{model}」，這一輪沒有跑。已換回「{to}」。", "acct.addCard": "前往綁卡", "fault.noModelBtn": "選別的模型" };
  const t = (k, v) => { let s = STR[k] || k; if (v) for (const x in v) s = s.split("{" + x + "}").join(v[x]); return s; };
  const panelKey = block('$("mp-panel").addEventListener("keydown", (e) => {');
  const M = new Function("$", "window", "document", "t", "trackFeature", "bindGo", "markHook", `
    const MP = { kind: null, models: [], prefs: {}, model: null, freeOnly: false, displaced: null };
    let acct = null, cur = "blave", turnModel = null;
    const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
    const NO_MODEL_RE = ${line(/^const NO_MODEL_RE = .*$/m).replace(/^const NO_MODEL_RE = /, "").replace(/;$/, "")};
    const limitMatch = () => null, mpBillPaint = () => {}, attachHintPaint = () => {}, mpOpen = () => {};
    const mpMarkUnavailable = (id) => markHook(id);
    ${line(/^const mpLocked = .*$/m)}
    ${fn("mpLevel")}\n${fn("mpCur")}\n${fn("mpEffort")}\n${fn("mpSave")}\n${fn("mpFreeSync")}\n${fn("acctSet")}
    async ${fn("mpInit")}\n${fn("mpPaint")}\n${fn("mpPickModel")}\n${fn("mpPickEffort")}\n${fn("classifyFault")}
    const panelKey = (e) => ${panelKey};
    return { MP, mpInit, acctSet, mpPickEffort, mpPickModel, classifyFault, panelKey,
      setTurn: (m) => { turnModel = m; } };`)($, window, { createElement: el }, t, (n) => tracked.push(n), (n) => binds.push(n), (id) => marked.push(id));
  return { M, $, saved, tracked, marked, binds, prefs, resolveOpt };
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
    ok("2. 鎖住的列照列:aria-disabled、is-locked、右邊小字「綁卡或儲值後可用」;Pro 不鎖",
      rows(w).length === 3 && s.attrs["aria-disabled"] === "true" && s.cls.has("is-locked") && s.children[1].textContent === "綁卡或儲值後可用"
      && f.attrs["aria-disabled"] === "true" && !("aria-disabled" in p.attrs), rows(w).map((r) => r.attrs));
    s.click(1);
    ok("2. 滑鼠點鎖住的列:選擇不變、送 mp_locked_click", w.M.MP.model === PRO && w.tracked.join() === "mp_locked_click", [w.M.MP.model, w.tracked]);
    w.tracked.length = 0;
    s.click(0);
    ok("2. 停在鎖住的列按 Enter / Space(detail 0):選擇不變、也送", w.M.MP.model === PRO && w.tracked.join() === "mp_locked_click", w.tracked);
    w.tracked.length = 0;
    w.M.mpPickModel(SONNET, true);
    ok("2. mpPickModel 直接叫鎖住的 id:不換", w.M.MP.model === PRO);
    w.M.panelKey({ key: "ArrowDown", target: row(w, "DeepSeek V4 Pro"), preventDefault() {} });
    ok("2. 方向鍵從 Pro 往下:Flash、Sonnet 都鎖 → 繞回 Pro 不動、沒送事件", w.M.MP.model === PRO && w.tracked.length === 0, [w.M.MP.model, w.tracked]);

    // 3. 解鎖:換回原本的 Sonnet
    w.M.acctSet(STATUS(false));
    ok("3. free_only true → false:換回 Sonnet、displaced 清掉、列不再鎖",
      w.M.MP.model === SONNET && w.M.MP.displaced === null && !("aria-disabled" in row(w, "Claude Sonnet 5.5").attrs), [w.M.MP.model, w.M.MP.displaced]);
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
      && f.text === "「Claude Sonnet 5.5」要綁卡或儲值才能用。已換回「DeepSeek V4 Pro」。" && f.label === "前往綁卡", [w.marked, w.M.MP.model, f]);
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
  console.log(red ? `\n${red} FAILED` : "\nALL PASS"); process.exit(red ? 1 : 0);
})();
