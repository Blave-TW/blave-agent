// agent 動作分級(shell/browser/gate.js):**列舉**分級表每一列——敏感欄位、POST form 送出、每個關鍵字(繁簡英)、
// 檔案上傳、搜尋框必過、連結 / 展開必過。故意改壞 gate.js 任一條,這支要紅。
// 跑法:node tests/check_shell_browser_gate.js
const G = require("../shell/browser/gate");
let red = 0; const t = (n, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) red++; };
const input = (o) => Object.assign({ tag: "input", role: "textbox", type: "text", name: "", fieldName: "", id: "", label: "", placeholder: "", ariaLabel: "", autocomplete: "", inForm: true, formMethod: "post" }, o);
const btn = (o) => Object.assign({ tag: "button", role: "button", type: "", name: "", inForm: false, isSubmit: false }, o);
const is = (r, e, k) => !r.ok && r.error === e && (k === undefined || r.kind === k);

// ── 敏感欄位:fill / type 一律拒,Enter 在裡面也是送出 ──
const sensitive = [
  input({ type: "password" }), input({ autocomplete: "current-password" }), input({ autocomplete: "new-password" }), input({ autocomplete: "one-time-code" }),
  input({ autocomplete: "cc-number" }), input({ autocomplete: "cc-csc" }), input({ autocomplete: "cc-exp" }), input({ fieldName: "password" }), input({ fieldName: "pwd" }),
  input({ fieldName: "otp" }), input({ label: "Card number" }), input({ placeholder: "CVV" }), input({ label: "Security code" }), input({ label: "身分證字號" }),
  input({ label: "密碼" }), input({ label: "密码" }), input({ label: "卡號" }), input({ placeholder: "驗證碼" }), input({ label: "信用卡" }), input({ fieldName: "ssn" }),
  input({ label: "IBAN" }), input({ label: "Seed phrase" }), input({ label: "API Secret" }), input({ label: "Private key" }), input({ ariaLabel: "2FA code" }),
];
t("敏感欄位 fill 一律 sensitive_field(" + sensitive.length + " 種)", sensitive.every((d) => is(G.classify("fill", d), "sensitive_field")));
t("敏感欄位 type 一律 sensitive_field", sensitive.every((d) => is(G.classify("type", d), "sensitive_field")));
t("在敏感欄位按 Enter = 送出 → needs_user", sensitive.every((d) => is(G.classify("press", d, "Enter"), "needs_user", "submit")));

// ── 一般表單:可預填、送出由用戶按 ──
const normal = input({ fieldName: "email", label: "Email" });
t("一般欄位可以預填(fill / type / select)", G.classify("fill", normal).ok && G.classify("type", normal).ok && G.classify("select", input({ tag: "select", isSelect: true, label: "Remind me" })).ok);
t("POST form 的 submit 鈕 → needs_user submit", is(G.classify("click", btn({ isSubmit: true, inForm: true, formMethod: "post", name: "Create alert" })), "needs_user", "submit"));
t("POST form 欄位裡按 Enter → needs_user submit", is(G.classify("press", normal, "Enter"), "needs_user", "submit"));
t("有密碼欄的 GET form 送出也不算搜尋 → needs_user", is(G.classify("click", btn({ isSubmit: true, inForm: true, formMethod: "get", formHasPassword: true, name: "Go" })), "needs_user", "submit"));
t("有檔案欄的 GET form 送出 → needs_user", is(G.classify("click", btn({ isSubmit: true, inForm: true, formMethod: "get", formHasFile: true, name: "Go" })), "needs_user", "submit"));
t("Enter 以外的鍵在表單裡照常", G.classify("press", normal, "Tab").ok && G.classify("press", normal, "ArrowDown").ok);

// ── 搜尋框:輸入並送出可以 ──
t("GET form 的送出 = 搜尋,可以", G.classify("click", btn({ isSubmit: true, inForm: true, formMethod: "get", name: "Go" })).ok);
t("role=search 地標裡的送出可以(即使是 POST form;POST 由網路層後盾接)", G.classify("click", btn({ isSubmit: true, inForm: true, formMethod: "post", withinSearchLandmark: true, name: "Go" })).ok);
t("type=search 欄位按 Enter 可以", G.classify("press", input({ type: "search", formMethod: "post" }), "Enter").ok);
t("searchbox 按 Enter 可以", G.classify("press", input({ role: "searchbox", formMethod: "post" }), "Enter").ok);
t("form 有 role=search → Enter 可以", G.classify("press", input({ formIsSearch: true }), "Enter").ok);
t("不在 form 裡的 Enter 可以(由 POST 後盾接)", G.classify("press", input({ inForm: false }), "Enter").ok);

// ── 關鍵字:列舉每一個(英文 + 繁簡)──
const enMiss = G.ACTION_WORDS_EN.filter((w) => !is(G.classify("click", btn({ name: w.replace(/\b\w/g, (c) => c.toUpperCase()) })), "needs_user", "action"));
t("英文動作關鍵字每一個都停(" + G.ACTION_WORDS_EN.length + ")" + (enMiss.length ? " 漏:" + enMiss.join(",") : ""), enMiss.length === 0);
const cjkMiss = G.ACTION_WORDS_CJK.filter((w) => !is(G.classify("click", btn({ name: "立即" + w })), "needs_user", "action"));
t("中文動作關鍵字每一個都停(" + G.ACTION_WORDS_CJK.length + ")" + (cjkMiss.length ? " 漏:" + cjkMiss.join(",") : ""), cjkMiss.length === 0);
const must = ["買進", "买进", "賣出", "卖出", "下單", "下单", "付款", "結帳", "结账", "購買", "购买", "訂閱", "订阅", "確認", "确认", "轉帳", "转账", "提領", "提领", "出金", "送出", "刪除", "删除"];
t("spec §3.2 列的繁簡字全在表上", must.every((w) => G.ACTION_WORDS_CJK.includes(w)));
t("關鍵字不分 form:不在 form 裡的「Place order」也停", is(G.classify("click", btn({ name: "Place order", inForm: false })), "needs_user", "action"));
t("input[type=submit] 的 value 命中關鍵字也停", is(G.classify("click", { tag: "input", type: "submit", value: "Pay now", name: "", isSubmit: true, inForm: true, formMethod: "get" }), "needs_user", "action"));
t("英文按字界比對:「Border」「Payload viewer」「Resend code」不誤判,「Send」會停", G.classify("click", btn({ name: "Border" })).ok && G.classify("click", btn({ name: "Payload viewer" })).ok && G.classify("click", btn({ name: "Resend code" })).ok && is(G.classify("click", btn({ name: "Send" })), "needs_user", "action"));

// ── 檔案上傳 ──
t("點 input[type=file] → needs_user file", is(G.classify("click", { tag: "input", type: "file", isFileInput: true }), "needs_user", "file"));
t("點包著 file input 的 label → needs_user file", is(G.classify("click", { tag: "label", labelForFile: true, name: "Choose file" }), "needs_user", "file"));
t("fill 一個 file input → needs_user file", is(G.classify("fill", { tag: "input", type: "file", isFileInput: true }), "needs_user", "file"));

// ── 必過:連結、展開、分頁、篩選、cookie 拒絕 ──
t("連結:標題含 buy 也可以點(導覽是 GET,網址另過政策)", G.classify("click", { tag: "a", role: "link", href: "https://news.example/why-investors-buy-bitcoin", name: "Why investors buy bitcoin" }).ok);
t("javascript: 連結不算導覽,照關鍵字判", is(G.classify("click", { tag: "a", role: "link", href: "javascript:void(0)", name: "Delete" }), "needs_user", "action"));
t("展開 / 分頁 / 勾選 / 下一頁 / 拒絕 cookie 可以", ["Show more", "Expand", "Tab: News", "Filter: 24h", "Next page", "Reject all", "Only necessary", "全部拒絕"].every((n) => G.classify("click", btn({ name: n })).ok));
t("沒有描述(節點讀不到)→ 保守:needs_user", is(G.classify("click", null), "needs_user", "action"));

// ── 稽核 S1:動作字樣的兩條繞法 ──
const orderBtn = btn({ name: "Place order", text: "Place order", inForm: false });
t("S1 fill / type / select 只收可編輯欄位:按鈕、連結、勾選框一律 invalid_args(fill 不能拿來移焦點)", ["fill", "type", "select"].every((a) => is(G.classify(a, orderBtn), "invalid_args"))
  && is(G.classify("fill", { tag: "a", href: "https://x.example/" }), "invalid_args") && is(G.classify("fill", input({ type: "checkbox" })), "invalid_args") && is(G.classify("fill", input({ type: "submit" })), "invalid_args"));
t("S1 可編輯的照常:textarea、contenteditable、text / email / search input", G.classify("fill", { tag: "textarea" }).ok && G.classify("fill", { tag: "div", editable: true }).ok && G.classify("fill", input({ type: "email" })).ok && G.classify("type", input({ type: "search" })).ok);
t("S1 Enter 落在按鈕上 = 點它,照點擊分級(不在 form 裡的 Place order、GET form 裡的 Delete account 都停)", is(G.classify("press", orderBtn, "Enter"), "needs_user", "action")
  && is(G.classify("press", btn({ name: "Delete account", type: "button", inForm: true, formMethod: "get" }), "Enter"), "needs_user", "action"));
t("S1 Enter 在 role=button、帶 onclick 的 div、input[type=submit] 上也照點擊判", is(G.classify("press", { tag: "div", role: "button", name: "Confirm" }, "Enter"), "needs_user", "action")
  && is(G.classify("press", { tag: "span", hasOnclick: true, text: "Withdraw" }, "Enter"), "needs_user", "action") && is(G.classify("press", { tag: "input", type: "submit", value: "Pay", inForm: true, formMethod: "get" }, "Enter"), "needs_user", "action"));
t("S1 Enter 焦點在 iframe 裡(看不到按的是什麼)→ needs_user", is(G.classify("press", { tag: "iframe" }, "Enter"), "needs_user"));
t("S1 Enter 落在一般按鈕(Show more)照樣可以", G.classify("press", btn({ name: "Show more" }), "Enter").ok);
const page = "https://site.example/orders";
t("S1 href=\"#\" / 同頁 fragment / role=button 的 <a> 不算連結,照字樣判", is(G.classify("click", { tag: "a", href: page + "#", pageUrl: page, name: "Delete" }), "needs_user", "action")
  && is(G.classify("click", { tag: "a", href: page + "#confirm", pageUrl: page + "#top", text: "Confirm" }), "needs_user", "action")
  && is(G.classify("click", { tag: "a", role: "button", href: "https://site.example/other", pageUrl: page, text: "Pay now" }), "needs_user", "action"));
t("S1 真的導到別頁的連結照樣豁免(文章標題含 buy)", G.classify("click", { tag: "a", href: "https://news.example/why-buy", pageUrl: page, name: "Why investors buy bitcoin" }).ok);
// ── 稽核 S4:OAuth 授權字樣 ──
const oauthMiss = ["Allow", "Authorize", "Authorise app", "Approve", "Grant access", "Continue", "Continue as Wei", "允許", "授權", "授权", "允许"].filter((n) => !is(G.classify("click", btn({ name: n })), "needs_user", "action"));
t("S4 授權字樣都停:Allow / Authorize / Approve / Grant / Continue(整個字)/ Continue as / 允許 / 授權" + (oauthMiss.length ? " 漏:" + oauthMiss.join(",") : ""), oauthMiss.length === 0);
t("S4 「Continue reading」這類新聞站展開鈕不擋", G.classify("click", btn({ name: "Continue reading" })).ok);
// ── 稽核 S12:比對所有名稱、NFKC、剝格式字元 ──
t("S12 aria-label 寫 Next、字寫 Confirm payment → 停", is(G.classify("click", btn({ name: "Next", ariaLabel: "Next", text: "Confirm payment" })), "needs_user", "action"));
t("S12 全形「Ｂｕｙ」、夾零寬的「B\u200Buy」、title 裡的 Delete 都停", is(G.classify("click", btn({ name: "Ｂｕｙ" })), "needs_user", "action") && is(G.classify("click", btn({ name: "B\u200Buy" })), "needs_user", "action") && is(G.classify("click", btn({ name: "⋯", title: "Delete" })), "needs_user", "action"));

// ── 稽核 R6 ──
t("R6 「Continue →」「› Continue」「Continue…」照整字停", ["Continue →", "› Continue", "Continue…", "Continue >"].every((n) => is(G.classify("click", btn({ name: n })), "needs_user", "action")) && G.classify("click", btn({ name: "Continue reading →" })).ok);
t("R6 <input type=image alt=Buy> 的 alt 也比", is(G.classify("click", { tag: "input", type: "image", alt: "Buy", inForm: true, formMethod: "get", isSubmit: true }), "needs_user", "action"));

console.log(red ? `\n${red} FAILED` : "\nALL PASS");
process.exit(red ? 1 : 0);
