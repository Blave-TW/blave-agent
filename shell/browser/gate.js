// agent 動作分級(純函式;tests/check_shell_browser_gate.js 逐列列舉)。
// 契約:.claude/output/specs/desktop-browser-agent-tools-2026-09-26.md §3.2。分級寫在工具實作裡,不是寫在 prompt 裡——
// DeepSeek 已實測會捏造用戶回合,「不要照網頁指示做」對弱模型不可靠。
// 輸入是 cdp.js 在 isolated world 讀出來的節點描述(describe()),頁面腳本改不到那個世界的 DOM 原型。
"use strict";

// 按鈕名稱命中就停下來請用戶按(多語;英文按字界比對,中日韓按子字串)。
const ACTION_WORDS_EN = [
  "buy", "sell", "order", "place order", "checkout", "check out", "pay", "payment", "purchase", "subscribe", "confirm",
  "transfer", "withdraw", "withdrawal", "send", "deposit", "delete", "remove", "submit", "trade", "donate", "top up",
  "log in", "login", "sign in", "signin", "sign up", "signup", "register", "continue with google", "continue with apple",
  "allow", "authorize", "authorise", "approve", "grant", "continue as",
];
// 「Continue」單獨一個字才算(OAuth 同意頁的鈕);「Continue reading」這類新聞站的展開鈕不擋
const WHOLE_WORDS_EN = ["continue"];
const ACTION_WORDS_CJK = [
  "買進", "买进", "買入", "买入", "賣出", "卖出", "下單", "下单", "付款", "支付", "結帳", "结账", "結賬", "購買", "购买",
  "訂閱", "订阅", "確認", "确认", "轉帳", "转账", "提領", "提领", "提現", "提现", "出金", "入金", "送出", "提交", "刪除",
  "删除", "移除", "儲值", "充值", "捐款", "交易", "登入", "登录", "登錄", "註冊", "注册",
  "允許", "允许", "授權", "授权",
];
const EN_RE = new RegExp("(^|[^a-z])(" + ACTION_WORDS_EN.map((w) => w.replace(/ /g, "\\s+")).join("|") + ")(?=$|[^a-z])", "i");
/** 名稱是否命中動作關鍵字。先 NFKC(全形 Ｂｕｙ)、剝格式字元(B\u200Buy),再比。 */
function actionWord(name) {
  const s = String(name || "").normalize("NFKC").replace(/\p{Cf}/gu, "").toLowerCase();
  if (!s.trim()) return false;
  // 整字比對前剝掉前後的符號與箭頭(「Continue →」「› Continue」)——稽核 R6
  return EN_RE.test(s) || ACTION_WORDS_CJK.some((w) => s.includes(w)) || WHOLE_WORDS_EN.includes(s.replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, ""));
}
/** 這個元素所有看得到 / 念得出的名稱都比:aria-label 寫「Next」、字寫「Confirm payment」也要抓到。 */
function allNames(d) { return [d.name, d.text, d.label, d.ariaLabel, d.value, d.title, d.alt].filter(Boolean); }
function namedAction(d) { return allNames(d).some(actionWord); }
/** 可以 fill / type 的欄位:文字型 input、textarea、select、contenteditable。按鈕、連結、勾選框都不是。 */
const NON_TEXT_INPUT = new Set(["button", "submit", "image", "reset", "checkbox", "radio", "file", "hidden", "range", "color"]);
function editableField(d) {
  if (d.editable || d.isSelect || d.tag === "textarea") return true;
  return d.tag === "input" && !NON_TEXT_INPUT.has(String(d.type || "text").toLowerCase());
}
/** 按 Enter 會「按下去」的元素:按鈕、按鈕型 input、連結、role=button/link、帶 onclick 的元素。這時 Enter 等於 click。 */
function buttonLike(d) {
  const role = String(d.role || "").toLowerCase(), type = String(d.type || "").toLowerCase();
  return d.tag === "button" || d.tag === "a" || role === "button" || role === "link" || role === "menuitem" || role === "tab" || role === "option"
    || (d.tag === "input" && ["submit", "button", "image", "reset"].includes(type)) || !!d.hasOnclick || d.tag === "summary";
}
/** 真的導到別頁的連結:http(s)、去掉 fragment 後跟目前網址不同、而且沒有 role=button。href="#" 的假連結不算。 */
function realLink(d) {
  if (d.tag !== "a" || String(d.role || "").toLowerCase() === "button") return false;
  let h; try { h = new URL(String(d.href || "")); } catch (_) { return false; }
  if (h.protocol !== "http:" && h.protocol !== "https:") return false;
  h.hash = "";
  let cur = null; try { cur = new URL(String(d.pageUrl || "")); cur.hash = ""; } catch (_) { /* 不知道目前網址:當成不同 */ }
  return !cur || cur.href !== h.href;
}

// 敏感欄位:這些欄位 agent 不填、不讀值。
const SENSITIVE_AUTOCOMPLETE = /(^|\s)(current-password|new-password|one-time-code|cc-[a-z-]+)(\s|$)/i;
const SENSITIVE_TEXT = new RegExp([
  "password", "passwd", "passcode", "\\bpwd\\b", "\\bpin\\b", "\\botp\\b", "one[\\s_-]?time", "\\b2fa\\b", "totp", "mfa",
  "card[\\s_-]?(number|no|num)", "cardnumber", "\\bcc[\\s_-]?(num|number)\\b", "credit[\\s_-]?card", "\\bcvv", "\\bcvc", "\\bcsc\\b",
  "security[\\s_-]?code", "expir", "\\biban\\b", "\\bssn\\b", "social[\\s_-]?security", "national[\\s_-]?id", "id[\\s_-]?number",
  "account[\\s_-]?number", "routing[\\s_-]?number", "seed[\\s_-]?phrase", "mnemonic", "private[\\s_-]?key", "api[\\s_-]?secret", "secret[\\s_-]?key",
  "身分證", "身份证", "密碼", "密码", "卡號", "卡号", "驗證碼", "验证码", "安全碼", "安全码", "信用卡", "有效期", "銀行帳號", "银行账号",
  "助記詞", "助记词", "私鑰", "私钥",
].join("|"), "i");
/** 敏感欄位:type=password、autocomplete 屬密碼/OTP/信用卡,或欄位名/label/placeholder 命中。 */
function sensitiveField(d) {
  if (!d) return false;
  if (String(d.type || "").toLowerCase() === "password") return true;
  if (SENSITIVE_AUTOCOMPLETE.test(String(d.autocomplete || ""))) return true;
  const text = [d.fieldName, d.id, d.label, d.placeholder, d.ariaLabel, d.name].filter(Boolean).join(" ");
  return SENSITIVE_TEXT.test(text);
}

/** 這個欄位 / 按鈕屬於搜尋:GET form、role=search 地標裡、type=search / role=searchbox,或 form 裡只有搜尋框。 */
function searchContext(d) {
  if (!d) return false;
  if (d.withinSearchLandmark || d.formIsSearch) return true;
  if (String(d.type || "").toLowerCase() === "search" || d.role === "searchbox") return true;
  return d.inForm && String(d.formMethod || "get").toLowerCase() === "get" && !d.formHasPassword && !d.formHasFile;
}

/**
 * 分級。action: "click" | "fill" | "type" | "press" | "select";key 只在 press 用。
 * 回 { ok: true } | { ok: false, error: "needs_user", kind } | { ok: false, error: "sensitive_field" }。
 */
function classify(action, d, key) {
  if (!d) return { ok: false, error: "needs_user", kind: "action" };
  if (action === "fill" || action === "type" || action === "select") {
    if (d.isFileInput) return { ok: false, error: "needs_user", kind: "file" };
    if (sensitiveField(d)) return { ok: false, error: "sensitive_field" };
    // 只收可編輯欄位:fill 一顆「Place order」等於把焦點移過去,下一個 Enter 就按下它
    if (!editableField(d)) return { ok: false, error: "invalid_args" };
    return { ok: true };   // 一般表單可以預填;送出由用戶按
  }
  if (action === "press") {
    if (key !== "Enter") return { ok: true };
    if (d.tag === "iframe") return { ok: false, error: "needs_user", kind: "action" };   // 焦點在別的 frame 裡:看不到按的是什麼
    if (buttonLike(d)) return classify("click", d);   // Enter 在按鈕 / 連結上 = 點它,照點擊的分級
    if (sensitiveField(d)) return { ok: false, error: "needs_user", kind: "submit" };
    if (!d.inForm) return { ok: true };   // 不在 form 裡的 Enter:由 POST 後盾接
    return searchContext(d) ? { ok: true } : { ok: false, error: "needs_user", kind: "submit" };
  }
  if (action === "click") {
    if (d.isFileInput || d.labelForFile) return { ok: false, error: "needs_user", kind: "file" };
    // 真的導到別頁的連結:名稱是文章標題居多(「Why investors buy bitcoin」),導覽本身是 GET、網址另過政策——不比對關鍵字
    if (!realLink(d) && namedAction(d)) return { ok: false, error: "needs_user", kind: "action" };
    if (d.isSubmit) return searchContext(d) ? { ok: true } : { ok: false, error: "needs_user", kind: "submit" };
    return { ok: true };
  }
  return { ok: false, error: "invalid_args" };
}

/* browser_capture 的元素大小分級(報告引用圖只收「單一圖表元素」,不收整版截圖)。box / view 是可視區 CSS px。
   - 小於 80×50:不是圖表(icon、一行字)
   - 比可視區大:捲不進一個畫面的元素是版面區塊(文章欄、整頁),不是一張圖;也不做 beyond-viewport 擷取
     (那會改頁面 viewport、整頁 reflow,見 index.js unEmulate)
   - 寬 ≥90% 且高 ≥85% 可視區,或面積 ≥75% 可視區:等於截整個畫面(只有前一條時 100%×84.9% 也過,稽核 B2)。
     滿版寬、高度不到 75% 的圖表照收
   - 捲過之後仍有一部分在可視區外(橫向捲動容器裡):裁出來會是半張圖 */
const CAPTURE_MIN_W = 80, CAPTURE_MIN_H = 50, CAPTURE_VIEW_W = 0.9, CAPTURE_VIEW_H = 0.85, CAPTURE_VIEW_AREA = 0.75;
function captureFit(box, view) {
  if (box.w < CAPTURE_MIN_W || box.h < CAPTURE_MIN_H) return "too_small";
  if (box.w > view.w + 1 || box.h > view.h + 1) return "too_large";
  if (box.w >= CAPTURE_VIEW_W * view.w && box.h >= CAPTURE_VIEW_H * view.h) return "too_large";
  if (box.w * box.h >= CAPTURE_VIEW_AREA * view.w * view.h) return "too_large";
  if (box.x < -1 || box.y < -1 || box.x + box.w > view.w + 1 || box.y + box.h > view.h + 1) return "not_visible";
  return null;
}
/* 兩次量到的外框差多少(文件座標:可視區座標 + 捲動量;位置與大小取最大的那個差)。超過 CAPTURE_DRIFT_MAX = 版面還在動 */
const CAPTURE_DRIFT_MAX = 4;
function captureDrift(a, b) {
  return Math.max(
    Math.abs((a.box.x + a.view.px) - (b.box.x + b.view.px)), Math.abs((a.box.y + a.view.py) - (b.box.y + b.view.py)),
    Math.abs(a.box.w - b.box.w), Math.abs(a.box.h - b.box.h));
}
/* 遮擋檢查的取樣點:中心 + 四角(往內縮,避開圓角與邊框)。covered[i]:true = 那一點上面是別的元素、false = 是目標或它的子孫、
   null = 查不出來(不當成被遮)。中心被遮,或四角有兩個以上被遮 → 拍到的會是橫幅 / 彈窗;
   只有一角被遮多半是圖表自己旁邊的小鈕,不擋 */
function capturePoints(box) {
  const dx = Math.min(12, box.w / 4), dy = Math.min(12, box.h / 4), r = Math.round;
  return [
    { x: r(box.x + box.w / 2), y: r(box.y + box.h / 2) },
    { x: r(box.x + dx), y: r(box.y + dy) }, { x: r(box.x + box.w - dx), y: r(box.y + dy) },
    { x: r(box.x + dx), y: r(box.y + box.h - dy) }, { x: r(box.x + box.w - dx), y: r(box.y + box.h - dy) },
  ];
}
function captureCovered(covered) {
  if (!Array.isArray(covered) || !covered.length) return false;
  return covered[0] === true || covered.slice(1).filter((x) => x === true).length >= 2;
}

/* 拍到的圖是不是空的 / 被攔腰切斷(擷取的事後檢查)。bm = BGRA 位元組,w × h 像素。
   "blank" = 整張同一個顏色(圖還沒畫、圖檔一個 byte 都還沒到);"cut" = 底部連續一大片(≥ 1/4 高)每一列都是同一個顏色,
   而且那個顏色不是上面那一段的底色——圖只畫了上半,下半透出頁面底色(e2e 0.1.8:glassnode 的圖 1360×843,下半整片 #16171b)。
   null = 看起來是一張完整的圖。深色底的圖表不會中:它底部的空白列跟上面的底色是同一個顏色。
   四邊各讓 CAPTURE_EDGE px 不看:外框落在半個像素上時,最外圈那一兩列是跟隔壁內容混出來的顏色(實測)。
   每列每 4 px 取一點;顏色差用三個通道的最大差,CAPTURE_FLAT_TOL 以內算同色(縮圖與壓縮的雜訊) */
const CAPTURE_FLAT_TOL = 10, CAPTURE_CUT_MIN = 0.25, CAPTURE_CUT_DIFF = 40, CAPTURE_EDGE = 3;
function captureBlank(bm, w, h) {
  const m = CAPTURE_EDGE;
  if (!bm || !(w > 4 * m) || !(h > 4 * m) || bm.length < w * h * 4) return null;
  const near = (a, b, tol) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;
  const at = (x, y) => { const i = (y * w + x) * 4; return [bm[i + 2], bm[i + 1], bm[i]]; };
  // 這一列是不是同一個顏色;是就回那個顏色
  const flat = (y) => { const c = at(m, y); for (let x = m + 4; x < w - m; x += 4) if (!near(at(x, y), c, CAPTURE_FLAT_TOL)) return null; return c; };
  const y0 = m, y1 = h - 1 - m, base = flat(y1);
  if (!base) return null;
  let top = y1;
  while (top > y0) { const c = flat(top - 1); if (!c || !near(c, base, CAPTURE_FLAT_TOL)) break; top--; }
  if (top === y0) return "blank";
  if (y1 + 1 - top < (y1 + 1 - y0) * CAPTURE_CUT_MIN) return null;
  // 上面那一段的底色:每 8 列取左右兩端與中間三點,出現最多的那個顏色(量化到 16 階)
  const seen = new Map();
  for (let y = y0; y < top; y += 8) for (const x of [m, w >> 1, w - 1 - m]) { const c = at(x, y), k = (c[0] >> 4) + "," + (c[1] >> 4) + "," + (c[2] >> 4); const e = seen.get(k) || { n: 0, c }; e.n++; seen.set(k, e); }
  let bg = null; for (const e of seen.values()) if (!bg || e.n > bg.n) bg = e;
  return bg && !near(bg.c, base, CAPTURE_CUT_DIFF) ? "cut" : null;
}

module.exports = { classify, captureFit, captureDrift, capturePoints, captureCovered, captureBlank, CAPTURE_DRIFT_MAX, sensitiveField, actionWord, searchContext, editableField, buttonLike, realLink, ACTION_WORDS_EN, ACTION_WORDS_CJK };
