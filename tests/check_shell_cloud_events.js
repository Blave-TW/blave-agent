/* 雲端視角的事件清單在畫面上怎麼畫(shell/renderer/trade.js 的事件那一段)。
 * 傳輸層在 tests/check_shell_cloud.js(cloud.js)與 tests/check_shell_envsw.js(envApi),這裡只管「畫成哪一句」:
 *   1. desktop_action(從電腦版送出的指令)有文案、認不得的 action 也留一列、裝置名照樣代得進去
 *   2. 那些 key 兩語都在(缺一邊就會在那個語系露出英文或 key)
 *   3. ui 那一段吃得下平台格式(欄位包在 data 裡)、認不得的型別交給 trEventText、halt 分得出自動與人按的
 * 跑法:node tests/check_shell_cloud_events.js
 */
const fs = require("fs"), path = require("path");
const R = path.join(__dirname, "..", "shell", "renderer");
const src = fs.readFileSync(path.join(R, "trade.js"), "utf8");
let red = 0; const ok = (n, c) => { console.log((c ? "PASS  " : "FAIL  ") + n); if (!c) red++; };

// 用假的 t():回 key + 代進去的值,才看得出「用了哪個 key」而不只是「有字」
const seen = [];
const t = (key, vars) => { seen.push(key); return vars ? key + "|" + JSON.stringify(vars) : key; };
const trVenueLabel = (id) => id || "";
const cut = (from, to) => { const i = src.indexOf(from), j = src.indexOf(to, i); if (i < 0 || j < 0) throw new Error("找不到標記:" + from); return src.slice(i, j); };
eval(cut("const TR_DT_ACTION = {", "\nfunction trOvEvents(").replace(/^const /gm, "var "));

const ev = (d) => trEventText("desktop_action", d);
ok("desktop_action:白名單內的 action 各有自己的句子(close_all 不併進 halt;resume_wait 同 resume)",
  ev({ action: "halt" })[0] === "tr.ov.evDtHalt" && ev({ action: "close_all" })[0] === "tr.ov.evDtCloseAll"
  && ev({ action: "resume_wait" })[0] === "tr.ov.evDtResume" && ev({ action: "credentials_remove" })[0] === "tr.ov.evDtCredentialsRemove");
ok("desktop_action:認不得的 action(這一版比 api 舊)、缺 action、原型上的鍵 → 還是留一列,用籠統那句",
  ["newcmd", "", undefined, "constructor", "toString", "__proto__"].every((a) => ev({ action: a })[0] === "tr.ov.evDtOther") && ev({})[0] === "tr.ov.evDtOther");
ok("desktop_action:裝置名代進註解;沒有 / 空白 / 不是字串就不出那一句",
  ev({ action: "halt", device: " Wei 的 MacBook " })[1] === 'tr.ov.evDtDevice|{"device":"Wei 的 MacBook"}'
  && ev({ action: "halt" })[1] === null && ev({ action: "halt", device: "   " })[1] === null && ev({ action: "halt", device: 7 })[1] === null);
// 裝置名是用戶自己取的字串(雲端來的,不可信):原樣交給 t(),而 t() 用 split/join 代入——
// 哪天改成 String.replace,"$&" 這種裝置名就會被當成替換樣式展開,所以兩頭一起守
ok("desktop_action:裝置名含 $& / {venue} 這類字元原樣交給 t(),而 t() 是 split/join 不是 replace",
  ev({ action: "halt", device: "$&$1{venue}" })[1] === 'tr.ov.evDtDevice|{"device":"$&$1{venue}"}'
  && /s = s\.split\("\{" \+ k \+ "\}"\)\.join\(vars\[k\]\)/.test(fs.readFileSync(path.join(R, "i18n.js"), "utf8")));
ok("desktop_action:payload 只有 action / device 兩欄(契約 §7 不帶值),多塞的欄位畫不出來",
  JSON.stringify(ev({ action: "amounts", device: "Mac", amounts: { a: 999 }, reason: "SECRET" })) === '["tr.ov.evDtAmounts","tr.ov.evDtDevice|{\\"device\\":\\"Mac\\"}"]');
ok("其他型別不受影響(機器事件照舊)", trEventText("exchange_recovered", { venue: "binance" })[0] === 'tr.ov.evExBack|{"venue":"binance"}' && trEventText("nope", {}) === null);

// 兩語齊:缺一邊就會在那個語系露出英文或 key
{ const S = fs.readFileSync(path.join(R, "strings.js"), "utf8");
  const block = (n) => S.split(`  ${n}: {`)[1].split("\n  },")[0];
  const keysOf = (b) => new Set([...b.matchAll(/^\s*"([^"]+)":/gm)].map((m) => m[1]));
  const en = keysOf(block("en")), zh = keysOf(block("zh"));
  const need = [...new Set([...Object.values(TR_DT_ACTION), "tr.ov.evDtOther", "tr.ov.evDtDevice"])];
  const miss = need.filter((k) => !en.has(k) || !zh.has(k));
  ok("desktop_action 的 " + need.length + " 個 key 兩語都在:" + (miss.join() || "無缺"), miss.length === 0);
  const valsOf = (b) => Object.fromEntries([...b.matchAll(/^\s*("(?:[^"\\]|\\.)*"): ("(?:[^"\\]|\\.)*"),?$/gm)].map((m) => [JSON.parse(m[1]), JSON.parse(m[2])]));
  const enV = valsOf(block("en")), zhV = valsOf(block("zh"));
  ok("文案講的是「送出」不是「已生效」(平台收下 ≠ 機器已套用)", need.filter((k) => k !== "tr.ov.evDtDevice").every((k) => /送出/.test(zhV[k]) && /Sent from|sent from/.test(enV[k])));
  ok("裝置名那一句兩語都留著 {device} 這個位置", /\{device\}/.test(zhV["tr.ov.evDtDevice"]) && /\{device\}/.test(enV["tr.ov.evDtDevice"]));
  ok("renderer 不出現中文字面(map 裡放的是 key,不是句子)", !/[一-鿿]/.test(cut("const TR_DT_ACTION = {", "function trEventText(").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""))); }

// ui 那一段(會碰 DOM,只驗寫法)
{ const loop = cut("const ui = Array.isArray(TR.ov.ui)", "// 目前的 HALT");
  ok("ui:平台格式的欄位包在 data 裡,這台電腦那一份在最外層——兩邊同一支迴圈", /const d = ev\.data && typeof ev\.data === "object" \? ev\.data : ev;/.test(loop) && /String\(d\.venue \|\| ""\)/.test(loop));
  ok("ui:認不得的型別交給 trEventText(雲端才有的 desktop_action / 交易所連不上…),還是認不得就不畫", /else \{ const txt = trEventText\(ev\.type, d\); if \(txt\) \{ head = txt\[0\]; note = txt\[1\]; \} \}/.test(loop) && /if \(!head\) return;/.test(loop));
  ok("ui:halt 誰按的看 source(鏡射平台的 _HALT_AUTO_SOURCES);沒有 source = 人按的", /d\.source === "reconciler" \|\| d\.source === "portfolio" \? "tr\.ov\.evHaltAuto" : "tr\.ov\.evHalt"/.test(loop));
  ok("ui:下單失敗不在這一段(雲端的 portfolio 仍帶 order_errors,兩邊都畫會重複)", !/order_error/.test(loop));
  ok("ui:時間仍然是秒(平台與這台電腦同一個單位)", /uiHalts\.push\(ev\.ts \* 1000\)/.test(loop) && /push\(ev\.ts \* 1000,/.test(loop)); }

/* 讀不到 ≠ 沒有事件(這條是硬規則:畫面不可以替資料說「這段期間什麼都沒發生」)。
   三態:讀到了有事件 / 讀到了真的沒有 / 讀不到——各畫各的。 */
{ const load = cut("async function trLoadCurve(", "function trCurvePoints(");
  ok("讀不到:catch 也記成 uiErr(不是靜靜給一個空清單),不往上拋", /catch \(_\) \{ S\.ov\.ui = \[\]; S\.ov\.uiErr = true; \}/.test(load) && /S\.ov\.uiErr = !ev \|\| ev\.code !== "OK";/.test(load));
  const ev = cut("  if (TR.ov.uiErr) frag.appendChild", "  rows.sort(");
  ok("讀不到:畫既有語氣的那一句(pf-state,沒有新元件 / 新 token),而且**不**畫「這段期間沒有事件」",
    /frag\.appendChild\(trEl\("div", "pf-state", t\("tr\.ov\.evUnreach"\)\)\);/.test(ev) && /if \(!rows\.length\) \{ if \(!TR\.ov\.uiErr\) frag\.appendChild\(trEl\("div", "pf-state", t\("tr\.ov\.evEmpty"\)\)\); return frag; \}/.test(ev));
  ok("讀不到:報告來源(下單 / HALT / 下單失敗)仍照列——那一句加在清單上面,不取代清單", ev.indexOf("evUnreach") < ev.indexOf("rows.length"));
  ok("重畫判準吃得到 uiErr(讀不到 → 讀到了要重畫)", /TR\.ov\.ui, TR\.ov\.uiErr,/.test(src) && /ui: \[\], uiErr: false,/.test(src));
  // ui 與 uiErr 是一組:登出 / 換帳號清掉上一個人的清單時,那個「讀不到」也要一起清(不然新帳號第一幀掛著上一個人的錯)
  ok("登出:ui 與 uiErr 一起清", /C\.ov\.curve = null; C\.ov\.ui = \[\]; C\.ov\.uiErr = false;/.test(src)); }

// 那一句兩語都在、語氣跟雲端其他「讀不到」一致(不斷言沒事發生)
{ const S = fs.readFileSync(path.join(R, "strings.js"), "utf8");
  const block = (n) => S.split(`  ${n}: {`)[1].split("\n  },")[0];
  const valsOf = (b) => Object.fromEntries([...b.matchAll(/^\s*("(?:[^"\\]|\\.)*"): ("(?:[^"\\]|\\.)*"),?$/gm)].map((m) => [JSON.parse(m[1]), JSON.parse(m[2])]));
  const enV = valsOf(block("en")), zhV = valsOf(block("zh"));
  ok("tr.ov.evUnreach 兩語都在,而且講「讀不到」不講「沒有事件」",
    /讀不到/.test(zhV["tr.ov.evUnreach"] || "") && !/沒有事件/.test(zhV["tr.ov.evUnreach"] || "")
    && /read/i.test(enV["tr.ov.evUnreach"] || "") && !/no events/i.test(enV["tr.ov.evUnreach"] || "")); }

console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
