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
   - 寬 ≥90% 且高 ≥85% 可視區:等於截整個畫面。只看單一方向不擋——滿版寬的圖表很常見
   - 捲過之後仍有一部分在可視區外(橫向捲動容器裡):裁出來會是半張圖 */
const CAPTURE_MIN_W = 80, CAPTURE_MIN_H = 50, CAPTURE_VIEW_W = 0.9, CAPTURE_VIEW_H = 0.85;
function captureFit(box, view) {
  if (box.w < CAPTURE_MIN_W || box.h < CAPTURE_MIN_H) return "too_small";
  if (box.w > view.w + 1 || box.h > view.h + 1) return "too_large";
  if (box.w >= CAPTURE_VIEW_W * view.w && box.h >= CAPTURE_VIEW_H * view.h) return "too_large";
  if (box.x < -1 || box.y < -1 || box.x + box.w > view.w + 1 || box.y + box.h > view.h + 1) return "not_visible";
  return null;
}

module.exports = { classify, captureFit, sensitiveField, actionWord, searchContext, editableField, buttonLike, realLink, ACTION_WORDS_EN, ACTION_WORDS_CJK };
