/* i18n 執行期。字串表在 strings.js(由 shell/tools/po2js.py 從 .po 產生),
   這個檔是手寫的:產生器只會覆蓋 strings.js,不會碰到這裡。 */
// 目前語言。app.js 在開場解析好之後設定;在那之前的任何呼叫都會拿到英文。
let LANG = "en";

function setLang(code) {
  LANG = STRINGS[code] ? code : "en";
  document.documentElement.lang = LANG === "zh" ? "zh-Hant" : "en";
  return LANG;
}

/* 查一個字串。`vars` 用 {name} 取代——不做複數、不做日期格式,這個 app 沒有那些。
 * 查不到的 key 直接回 key 本身:漏翻的字會在畫面上長得很醒目,而不是變成空白。 */
function t(key, vars) {
  let s = (STRINGS[LANG] && STRINGS[LANG][key]) || STRINGS.en[key] || key;
  if (vars) for (const k in vars) s = s.split("{" + k + "}").join(vars[k]);
  return s;
}

/* 系統語系 → 我們有的語系。zh-TW / zh-Hant / zh-CN 一律走 zh,其餘英文。
 * 同意頁的 <lang> 收 en/zh/cn/…,剛好是同一組代號,所以這個值可以直接送過去。 */
function pickLang(locale) {
  return /^zh\b|^zh-/i.test(locale || "") ? "zh" : "en";
}
