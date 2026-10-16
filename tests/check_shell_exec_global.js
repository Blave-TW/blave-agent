// 電腦版 自動下單 › 設定 › 下單方式(0.1.26;整個組合一種,機器端 runtime/exec_style.py)。不起 Electron:
//   ① 允許清單:execution 在 daemon.js UI_COMMANDS、ENV_CLOUD_CMDS、main.js CLOUD_SHIPPED;argsOk 只收 execution_default
//      (+ 每一項都等於它的展開 map),時長整數 1–1440、bool 不收、custom 模組名同機器端
//   ② 純函式:spec ↔ 鍵、送出的兩份(市價 = 空 map)、時長輸入、現值讀報告的 execution_effective(沒有才讀 config)
//   ③ 畫面(假 DOM):三選一;TWAP 多時長格;custom 是現值才列;統一／群益 → 停用、顯示市價、那一行說明;設定檔讀不到不給改
//   ④ 互動:選單改了立即送、時長格看不懂不送並講一行;送出失敗退回並講原因;成功記 exec_set
//   ⑤ 文案:「每支策略的下單方式在網頁」那兩句不在了
// 跑法:node tests/check_shell_exec_global.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const SHELL = path.join(__dirname, "..", "shell"), R = path.join(SHELL, "renderer");
let red = 0; const ok = (name, c, info) => { console.log((c ? "PASS  " : "FAIL  ") + name + (c || !info ? "" : "\n      " + info)); if (!c) red++; };
const J = JSON.stringify;
const read = (f) => fs.readFileSync(f, "utf8");
const cutF = (s, n) => { const i = s.indexOf("function " + n + "("); if (i < 0) throw new Error("no " + n); let d = 0; for (let k = s.indexOf("{", i); k < s.length; k++) { if (s[k] === "{") d++; else if (s[k] === "}" && --d === 0) return (s.slice(Math.max(0, i - 6), i) === "async " ? "async " : "") + s.slice(i, k + 1); } throw new Error("unclosed " + n); };
const trade = read(path.join(R, "trade.js")), main = read(path.join(SHELL, "main.js")), S = read(path.join(R, "strings.js"));

// ── ① 允許清單 ──
const { UI_COMMANDS, argsOk } = require(path.join(SHELL, "daemon.js"));
ok("① daemon.js UI_COMMANDS、ENV_CLOUD_CMDS、CLOUD_SHIPPED 都有 execution", UI_COMMANDS.has("execution")
  && /const ENV_CLOUD_CMDS = \[[^\]]*"execution"/.test(trade) && /const CLOUD_SHIPPED = \[[^\]]*"execution"/.test(main));
const TW = { type: "twap", duration_min: 30 };
const GOOD = [{ execution_default: { type: "market" } }, { execution_default: { type: "market" }, execution: {} },
  { execution_default: { type: "chase" }, execution: { a: { type: "chase" }, "b-2_x": { type: "chase" } } },
  { execution_default: TW, execution: { a: TW } }, { execution_default: { type: "twap", duration_min: 1 } }, { execution_default: { type: "twap", duration_min: 1440 } }];
ok("① argsOk 收:市價／追價／TWAP 1 與 1440 分,展開 map 選填", GOOD.every((a) => argsOk("execution", a)));
const BAD = [{}, { execution: { a: TW } }, { execution_default: { type: "custom", module: "my_exec" } }, { execution_default: null }, { execution_default: "market" }, { execution_default: { type: "limit" } },
  { execution_default: { type: "market", x: 1 } }, { execution_default: { type: "twap" } }, { execution_default: { type: "twap", duration_min: 0 } },
  { execution_default: { type: "twap", duration_min: 1441 } }, { execution_default: { type: "twap", duration_min: 30.5 } },
  { execution_default: { type: "twap", duration_min: "30" } }, { execution_default: { type: "twap", duration_min: true } },
  { execution_default: { type: "custom", module: "../x" } }, { execution_default: { type: "custom", module: "Mod" } },
  { execution_default: TW, execution: { a: { type: "market" } } }, { execution_default: TW, execution: { a: { duration_min: 30, type: "twap" } } },
  { execution_default: TW, execution: { "../x": TW } }, { execution_default: TW, execution: ["a"] }, { execution_default: TW, x: 1 },
  { execution_default: { type: "chase" }, execution: Object.fromEntries(Array.from({ length: 201 }, (_, i) => ["s" + i, { type: "chase" }])) }, null, []];
ok("① argsOk 拒:custom(只能跟 agent 設)、少 execution_default、壞型別／時長／模組名、map 跟 execution_default 不一樣、多欄位、超過 200 支", BAD.every((a) => !argsOk("execution", a)),
  J(BAD.filter((a) => argsOk("execution", a))));

// ── ② 純函式 ──
const pure = vm.createContext({});
["trExecKey", "trExecSpec", "trExecArgs", "trExecMinutes", "trExecStored"].forEach((n) => vm.runInContext(cutF(trade, n), pure));
const P = (expr) => vm.runInContext(expr, pure);
ok("② trExecKey:twap 時長 Number() 後取整、clamp 到 1440;轉不出數字 / 不認得的型別 = 市價;custom 模組名不合法 = 市價",
  P(`[trExecKey({type:"twap",duration_min:"30"}), trExecKey({type:"twap",duration_min:2000}), trExecKey({type:"twap",duration_min:"x"}), trExecKey({type:"chase"}),
     trExecKey({type:"custom",module:"my_exec"}), trExecKey({type:"custom",module:"../x"}), trExecKey({type:"limit"}), trExecKey(null)].join()`)
  === "twap:30,twap:1440,market,chase,custom:my_exec,market,market,market");
const keys = ["market", "twap:15", "twap:1440", "chase"];
ok("② trExecArgs:每一個鍵送出的兩份都過 argsOk;市價的展開 map 是空的,其餘每支成員一份",
  keys.every((k) => argsOk("execution", JSON.parse(J(P(`trExecArgs(${J(k)}, {a: 100, b: 0})`)))))
  && J(P(`trExecArgs("market", {a: 1})`)) === J({ execution_default: { type: "market" }, execution: {} })
  && J(P(`trExecArgs("twap:15", {a: 1, b: 0})`)) === J({ execution_default: { type: "twap", duration_min: 15 }, execution: { a: { type: "twap", duration_min: 15 }, b: { type: "twap", duration_min: 15 } } })
  && J(P(`trExecArgs("chase", null)`)) === J({ execution_default: { type: "chase" }, execution: {} }));
ok("② trExecMinutes:只收 1–1440 的整數(可帶前後空白)", P(`[trExecMinutes("15"), trExecMinutes(" 90 "), trExecMinutes("1440"), trExecMinutes("0"), trExecMinutes("1441"),
  trExecMinutes("1.5"), trExecMinutes("-3"), trExecMinutes(""), trExecMinutes("abc"), trExecMinutes(null)].map(String).join()`) === "15,90,1440,null,null,null,null,null,null,null");
ok("② trExecStored:讀 execution_effective;沒有這欄(舊 runtime)讀 config.execution_default;設定檔讀不到 = null",
  P(`[trExecStored({config:{}, execution_effective:{type:"chase"}}), trExecStored({config:{execution_default:{type:"twap",duration_min:20}}}),
      trExecStored({config:{}}), trExecStored({config:null, execution_effective:null}), trExecStored(null)].map(String).join()`) === "chase,twap:20,market,null,null");

// ── ③④ 畫面與互動(假 DOM)──
function mk(tag) {
  return { tag, children: [], attrs: {}, on: {}, textContent: "", value: "", disabled: false, className: "", id: "",
    appendChild(c) { this.children.push(c); return c; }, append(...cs) { cs.forEach((c) => this.children.push(typeof c === "string" ? { tag: "#text", textContent: c, children: [] } : c)); },
    setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(e, f) { this.on[e] = f; } };
}
const all = (n) => [n].concat(...(n.children || []).map(all));
const find = (root, id) => all(root).find((n) => n.id === id);
const text = (root) => all(root).map((n) => n.textContent || "").join("|");
const sent = [], said = [], tracked = [];
const ctx = vm.createContext({ LANG: "zh", J, document: { createElement: mk }, sent, said, tracked,
  t: (k, p) => k + (p ? J(p) : ""), srSay: (m) => said.push(m), trackFeature: (n) => tracked.push(n), trPollSoon() {}, trPaint() {}, trPaintSet() {},
  trTwBroker: (id) => id === "capital" || id === "president", ENV: { cur: "local" }, trSendError: (res) => "ERR:" + (res && res.error),
  trSec: (label) => { const s = mk("div"); s.appendChild(label); return s; } });
const TA = { value: "", focused: 0, sel: null, focus() { this.focused++; }, setSelectionRange(a, b) { this.sel = [a, b]; } };
Object.assign(ctx, { $: (id) => (id === "ta" ? TA : null), autosize() {}, paneSt: { chat: { off: true } }, paneToggle(n, off) { ctx.paneSt.chat.off = off; } });
["trEl", "trExecKey", "trExecSpec", "trExecArgs", "trExecMinutes", "trExecStored", "trExecCurrent", "trCatchHow", "trExecSection", "trExecSend", "trExecAskCustom"].forEach((n) => vm.runInContext(cutF(trade, n), ctx));
vm.runInContext(`var TR_TWAP_DEFAULT_MIN = 15; var REP = null; var VID = "binance"; function trReport() { return REP; } function trVenueId() { return VID; }
  var TR = { env: "local", open: true, sig: {}, sending: {}, exec: { edit: null, err: null, raw: null },
    api: { tradeSend: async (cmd, args) => { sent.push([cmd, args]); return globalThis.NEXT || { ok: true }; } } };
  async function trSend(S, cmd, args) { return S.api.tradeSend(cmd, args); }`, ctx);
const paint = (rep, id) => { ctx.REP = rep; const box = mk("div"); vm.runInContext("(b, r, id) => trExecSection(b, r, id)", ctx)(box, rep, id); return box; };
const rep = (eff, cfg) => ({ config: Object.assign({ amounts: { a: 100, b: 0 } }, cfg || {}), execution_effective: eff });

let box = paint(rep({ type: "market" }), "okx"), sel = find(box, "tr-exec-sel");
ok("③ 市價:三個選項 + 常駐的「自訂——跟 agent 說」入口、選中市價、沒有時長格、說明只有「組合裡每一筆單都用這個方式下」",
  !!sel && J(sel.children.map((o) => o.value)) === J(["market", "twap", "chase", "custom-ask"]) && sel.children[3].textContent === "tr.exec.customAsk" && sel.value === "market" && !sel.disabled
  && !find(box, "tr-exec-min") && /tr\.exec\.all/.test(text(box)) && !/noteTwap|noteChase|tr\.exec\.tw\b/.test(text(box)));
box = paint(rep({ type: "twap", duration_min: 45 }), "binance"); sel = find(box, "tr-exec-sel");
let min = find(box, "tr-exec-min");
ok("③ TWAP 45 分:選單停在 TWAP、時長格是 45、說明多 TWAP 那句", sel.value === "twap" && !!min && min.value === "45" && /tr\.exec\.noteTwap/.test(text(box)));
box = paint(rep({ type: "custom", module: "my_exec" }), "okx"); sel = find(box, "tr-exec-sel");
ok("③ custom 是現值:列成第四個選項並選中(只能跟 agent 建,這裡不新增),入口項排最後", sel.children.length === 5 && sel.value === "custom:my_exec" && sel.children[4].value === "custom-ask");
for (const tw of ["president", "capital"]) {
  box = paint(rep({ type: "twap", duration_min: 30 }), tw); sel = find(box, "tr-exec-sel");
  ok(`③ ${tw}:選單停用、顯示市價、沒有時長格、不列「自訂——跟 agent 說」(同網頁)、那一行講統一／群益一律市價`, sel.disabled && sel.value === "market" && !find(box, "tr-exec-min")
    && J(sel.children.map((o) => o.value)) === J(["market", "twap", "chase"])
    && /tr\.exec\.tw\b/.test(text(box)) && !/tr\.exec\.all/.test(text(box)));
}
box = paint({ config: null }, "okx");
ok("③ 設定檔讀不到:沒有選單,一行說明", !find(box, "tr-exec-sel") && /tr\.exec\.unread/.test(text(box)));

(async () => {
  const flush = () => new Promise((r) => setImmediate(r));
  box = paint(rep({ type: "market" }), "okx"); sel = find(box, "tr-exec-sel");
  sel.value = "chase"; sel.on.change(); await flush();
  ok("④ 選追價:立即送 execution,兩份(execution_default + 每支成員),成功記 exec_set",
    sent.length === 1 && sent[0][0] === "execution" && J(sent[0][1]) === J({ execution_default: { type: "chase" }, execution: { a: { type: "chase" }, b: { type: "chase" } } })
    && tracked.join() === "exec_set");
  ctx.TR.exec = { edit: null, err: null, raw: null }; sent.length = 0;
  box = paint(rep({ type: "market" }), "okx"); sel = find(box, "tr-exec-sel");
  sel.value = "twap"; sel.on.change(); await flush();
  ok("④ 從市價選 TWAP:用預設 15 分送", sent.length === 1 && J(sent[0][1].execution_default) === J({ type: "twap", duration_min: 15 }));
  ctx.TR.exec = { edit: null, err: null, raw: null }; sent.length = 0;
  box = paint(rep({ type: "twap", duration_min: 15 }), "okx"); min = find(box, "tr-exec-min");
  min.value = "abc"; min.on.change(); await flush();
  ok("④ 時長格打 abc:不送、記下原字、講一行", sent.length === 0 && ctx.TR.exec.raw === "abc" && ctx.TR.exec.err === "tr.exec.badMin" && said.includes("tr.exec.badMin"));
  box = paint(rep({ type: "twap", duration_min: 15 }), "okx"); min = find(box, "tr-exec-min");
  { const errP = find(box, "tr-exec-err");
    ok("④ 重畫時時長格放回看不懂的原字;欄位錯誤:aria-invalid + aria-describedby 指向欄位下那一行紅字(.pf-note.err,不是 .plan-err)",
      min.value === "abc" && min.attrs["aria-invalid"] === "true" && min.attrs["aria-describedby"] === "tr-exec-err"
      && !!errP && errP.className === "pf-note err" && errP.textContent === "tr.exec.badMin" && !all(box).some((n) => n.className === "plan-err")); }
  min.value = "90"; min.on.change(); await flush();
  ok("④ 改成 90:送 TWAP 90 分、錯誤清掉", sent.length === 1 && J(sent[0][1].execution_default) === J({ type: "twap", duration_min: 90 }) && !ctx.TR.exec.err);
  ok("④ 報告還沒對上之前顯示送出的值;對上就放掉", (() => { box = paint(rep({ type: "twap", duration_min: 15 }), "okx"); const a = find(box, "tr-exec-min").value === "90";
    box = paint(rep({ type: "twap", duration_min: 90 }), "okx"); return a && ctx.TR.exec.edit === null; })());
  sent.length = 0; ctx.TR.exec = { edit: null, err: null, raw: null };
  box = paint(rep({ type: "market" }), "okx"); sel = find(box, "tr-exec-sel");
  sel.value = "chase"; sel.on.change(); sel.on.change();
  ok("④ 本機在途時再選一次:不送第二次", sent.length === 1 && !!ctx.TR.sending.execution);
  await flush();
  ok("④ 回來之後放開在途", !ctx.TR.sending.execution);
  sent.length = 0; tracked.length = 0; ctx.NEXT = { ok: false, error: "BUSY", kind: "rejected" };
  box = paint(rep({ type: "market" }), "okx"); sel = find(box, "tr-exec-sel");
  sel.value = "chase"; sel.on.change(); await flush();
  ok("④ 送出失敗:退回存的值、講原因、不記 exec_set", ctx.TR.exec.edit === null && ctx.TR.exec.err === "ERR:BUSY" && !tracked.length
    && find(paint(rep({ type: "market" }), "okx"), "tr-exec-sel").value === "market");
  { const b2 = paint(rep({ type: "market" }), "okx");
    ok("④ 送出失敗那一句是 .plan-err(整段操作失敗的長相),不是欄位紅字", all(b2).some((n) => n.className === "plan-err") && !find(b2, "tr-exec-err")); }
  ctx.NEXT = null;

  // ── ④b「自訂——跟 agent 說」(同網頁 chatAskCustomExec)──
  sent.length = 0; ctx.TR.exec = { edit: null, err: null, raw: null }; ctx.TR.env = "local";
  box = paint(rep({ type: "twap", duration_min: 45 }), "okx"); sel = find(box, "tr-exec-sel");
  sel.value = "custom-ask"; sel.on.change(); await flush();
  ok("④b 選入口:不送任何指令、選單彈回原值(TWAP)、聊天欄展開、空的輸入框放那一句、焦點與游標在句尾",
    sent.length === 0 && sel.value === "twap" && ctx.paneSt.chat.off === false && TA.value === "tr.exec.customPrefill" && TA.focused === 1 && J(TA.sel) === J([TA.value.length, TA.value.length]));
  TA.value = "我自己的草稿"; sel.value = "custom-ask"; sel.on.change();
  ok("④b 框裡已經有草稿:不覆蓋、只聚焦", TA.value === "我自己的草稿" && TA.focused === 2 && sent.length === 0);
  TA.value = "  "; ctx.TR.env = "cloud"; sel.value = "custom-ask"; sel.on.change();
  ok("④b 雲端視角:填本機聊天框的雲端版那一句(不送進雲端)", TA.value === "tr.exec.customPrefillCloud" && sent.length === 0);
  ctx.TR.env = "local";

  // ── ④c 樣式(設計稽核 A1／A2／P2)──
  { const css = read(path.join(R, "trade.css"));
    ok("④c .f-input:disabled 灰階(ink-3 字、hairline 框、not-allowed)、opacity 明寫 1 蓋掉 Chromium 內建 select:disabled 的 .7(0.1.26 稽核 M2)、chevron 一起退色",
      /\.f-input:disabled \{ color: var\(--ink-3\); border-color: var\(--border-hairline\); cursor: not-allowed; opacity: 1; \}/.test(css)
      && /\.f-selw:has\(\.f-input:disabled\)::after \{ border-color: var\(--border-hairline\); \}/.test(css) && !/\.f-input:disabled[^}]*opacity: (?!1;)/.test(css));
    ok("④c 分鐘格填錯紅框(聚焦也紅);下單方式選單長名出省略號",
      /\.tr-exec \.f-input\[aria-invalid="true"\], \.tr-exec \.f-input\[aria-invalid="true"\]:focus \{ border-color: var\(--color-redText\); \}/.test(css)
      && /\.tr-exec \.f-input \{ overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/.test(css)); }

  // ── ⑤ 文案 ──
  const zh = S.slice(S.indexOf("\n  zh: {"));
  const en = S.slice(0, S.indexOf("\n  zh: {"));
  const KEYS = ["tr.exec", "tr.exec.market", "tr.exec.twap", "tr.exec.chase", "tr.exec.custom", "tr.exec.customAsk", "tr.exec.customPrefill", "tr.exec.customPrefillCloud", "tr.exec.minLabel", "tr.exec.minUnit", "tr.exec.badMin",
    "tr.exec.all", "tr.exec.noteTwap", "tr.exec.noteChase", "tr.exec.tw", "tr.exec.unread"];
  ok("⑤ tr.exec.* 中英兩份都有,而且來源是 .po(strings.js 是產生的)", KEYS.every((k) => en.indexOf(`"${k}":`) >= 0 && zh.indexOf(`"${k}":`) >= 0)
    && ["en", "zh"].every((l) => { const po = read(path.join(SHELL, "i18n", l + ".po")); return KEYS.every((k) => po.indexOf(`msgid "${k}"\n`) >= 0) && !/onlyWebExec/.test(po); }));
  ok("⑤ 入口那一句照網頁的字(workspace_pf_exec_custom_ask / _prefill)", /"tr\.exec\.customAsk": "自訂——跟 agent 說"/.test(zh) && /"tr\.exec\.customPrefill": "我想自訂下單方式："/.test(zh)
    && /"tr\.exec\.customAsk": "Custom — tell the agent"/.test(en) && /"tr\.exec\.customPrefill": "I want a custom execution style: "/.test(en));
  ok("⑤「每支策略的下單方式在網頁」那兩句不在了(tr.cloud.onlyWebExec 拿掉、pv.inc.web 改寫)",
    !/onlyWebExec/.test(S + trade) && !/每支策略的下單方式|per-strategy order handling/.test(S));
  // ── ⑥ 啟動框「補齊部位」說明跟著下單方式走(spec portfolio-help-icon §4;同網頁 pfCatchHow):讀值跟設定分頁同一條 ──
  { const how = (eff, real, o) => { o = o || {}; ctx.VID = o.vid || "binance"; vm.runInContext("TR.exec.edit = " + J(o.edit == null ? null : o.edit), ctx);
      const r = o.rep || rep(eff); return vm.runInContext("(r, real) => trCatchHow(r, real)", ctx)(r, real); };
    const cases = [
      ["市價(模擬)", how({ type: "market" }, false), "tr.opt.catchHow.market"], ["市價(真錢)", how({ type: "market" }, true), "tr.opt.catchHow.marketReal"],
      ["TWAP 30(模擬)", how({ type: "twap", duration_min: 30 }, false), 'tr.opt.catchHow.twap{"min":"30"}'], ["TWAP 30(真錢)", how({ type: "twap", duration_min: 30 }, true), 'tr.opt.catchHow.twapReal{"min":"30"}'],
      ["限價追價(模擬)", how({ type: "chase" }, false), "tr.opt.catchHow.chase"], ["限價追價(真錢)", how({ type: "chase" }, true), "tr.opt.catchHow.chaseReal"],
      ["自訂(模擬)", how({ type: "custom", module: "my_exec" }, false), 'tr.opt.catchHow.custom{"module":"my_exec"}'], ["自訂(真錢)", how({ type: "custom", module: "my_exec" }, true), 'tr.opt.catchHow.customReal{"module":"my_exec"}'],
      ["綁統一:一律市價", how({ type: "twap", duration_min: 30 }, true, { vid: "president" }), "tr.opt.catchHow.marketReal"],
      ["綁群益:一律市價(送出中的也不算)", how({ type: "chase" }, true, { vid: "capital", edit: "twap:5" }), "tr.opt.catchHow.marketReal"],
      ["送出中的值優先於報告", how({ type: "market" }, false, { edit: "twap:45" }), 'tr.opt.catchHow.twap{"min":"45"}'],
      ["舊 runtime(沒有 execution_effective)讀 config.execution_default", how(null, false, { rep: { config: { amounts: {}, execution_default: { type: "chase" } } } }), "tr.opt.catchHow.chase"],
      ["設定讀不到:當市價", how(null, true, { rep: { config: null } }), "tr.opt.catchHow.marketReal"],
    ];
    vm.runInContext("TR.exec.edit = null", ctx);
    const bad = cases.filter((c) => c[1] !== c[2]).map((c) => c[0] + " 得 " + c[1]);
    ok("⑥ 補齊部位的「怎麼下」:四種 × 模擬／真錢、統一／群益一律市價、送出中優先、舊 runtime、讀不到設定", !bad.length, bad.join(";"));
    const ST = new Function(S + "\nreturn STRINGS;")(), fill = (s, v) => Object.keys(v).reduce((a, k) => a.split("{" + k + "}").join(v[k]), s);
    ok("⑥ 市價那句與改前逐字相同(兩語、模擬／真錢);TWAP 句子接得通",
      fill(ST.zh["tr.opt.catchDesc"], { how: ST.zh["tr.opt.catchHow.market"] }) === "現在就用市價下單，把部位調到策略目前的訊號，可能一次調整多個部位。策略已經在場內的話，等於中途上車。"
      && fill(ST.zh["tr.opt.catchDescReal"], { how: ST.zh["tr.opt.catchHow.marketReal"] }) === "現在就用市價送出真實委託，把部位調到策略目前的訊號，可能一次調整多個部位。策略已經在場內的話，等於中途上車。"
      && fill(ST.en["tr.opt.catchDesc"], { how: ST.en["tr.opt.catchHow.market"] }) === "Places market orders now to bring each position to the strategy’s current signal; several positions may move at once. If a strategy is already in a trade, you join it mid-trade."
      && fill(ST.en["tr.opt.catchDescReal"], { how: ST.en["tr.opt.catchHow.marketReal"] }) === "Sends real market orders now to bring each position to the strategy’s current signal; several positions may move at once. If a strategy is already in a trade, you join it mid-trade."
      && fill(ST.zh["tr.opt.catchDesc"], { how: fill(ST.zh["tr.opt.catchHow.twap"], { min: 30 }) }).startsWith("現在就用 TWAP 30 分鐘分批下單，把部位")
      && /desc: t\("tr\.opt\.catchDesc" \+ money, \{ how: trCatchHow\(r, real\) \}\)/.test(trade)); }
  console.log(red ? `\n${red} 紅` : "\nALL PASS");
  process.exit(red ? 1 : 0);
})();
