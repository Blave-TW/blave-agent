// 電腦版 UI 文案語氣與標點閘門:shell/i18n/zh.po 每句 msgstr,新字串就擋、舊帳放行。
// 規則來源:canon design-system/copy.md › 介面標點（繁中）、文案密度 #7;前 6 條照搬 web tests/check_copy_tone.py 的 ZH_RULES,
// 改那邊的規則要一起改這裡。只抓機制判得出的;頓號與逗號、句尾句號、標籤冒號、冒號數量、引號多寡要懂語意,靠稽核讀。
//
// 舊帳在 check_shell_copy_tone.baseline.json(key → msgstr 的 sha256 前 16 碼),跟 check_shell_copy_length 同一套:
//   msgstr 沒變就放行;改了且仍中就紅;--prune 只刪不加;多出 git HEAD 那份沒有的 key 就紅。
//
//   node tests/check_shell_copy_tone.js           # 檢查(連同自測)
//   node tests/check_shell_copy_tone.js --prune   # 縮 baseline
//   node tests/check_shell_copy_tone.js --init    # 只在 baseline 不存在時建第一份
const fs = require("fs"), path = require("path"), crypto = require("crypto"), { execFileSync } = require("child_process");

const REPO = path.join(__dirname, "..");
const PO = path.join(REPO, "shell", "i18n", "zh.po");
const BASELINE = path.join(__dirname, "check_shell_copy_tone.baseline.json");
const CANON = ".claude/docs/design-system/copy.md › 介面標點（繁中）、文案密度 #7";

// 讀者不是用戶、或措辭由別的義務決定的字串不量(同 check_shell_copy_length 的法遵與提示詞兩類)
const EXEMPT = [
  [/^pdf\.disc/, "匯出 PDF 的法遵免責聲明"],
  [/(^|\.)msg(?!\w*(Label|Title)$)/, "送給 agent 的提示詞(*.msg*,不含畫面上的 Label/Title)"],
  [/^cap\.ho\.prompt|^tr\.err\.askPrompt/, "送給 agent 的提示詞(群益開通交接、下單失敗請 agent 查)"],
  [/^rpt\.new\.tpl\./, "新報告範本,填進描述欄後送給 agent"],
];

// 官方產品名照原名(canon 介面標點 13)
const NAME_OK = ["憑證e總管"];

const HAN = "一-鿿";
// [規則名, regex, 怎麼改, 看哪一層] 層:raw＝原文;text＝標籤換成佔位字元(不是刪,刪了會造出假空格或假相鄰)
const RULES = [
  ["破折號", /——|—|──/, "拆成兩句,或用逗號", "text"],
  ["全形分號", /；/, "介面不用分號,拆成兩句", "text"],
  ["不是…而是", /不是[^，。；！？]{1,20}，?\s*而(是|在於)|不只是|不僅是|不僅僅|不光是|不單是/, "對比句式;直接講它是什麼", "text"],
  ["填充開場", /值得注意的是|換句話說|也就是說|簡單來說|總結來說|總的來說|更重要的是|關鍵在於|想像一下|這意味著|別擔心|說到底|歸根結柢|本質上|毫無疑問/, "刪掉,直接講", "text"],
  ["粗體開頭", /^\s*(?:<(?!strong|b)[^>]+>\s*)*<(?<t>strong|b)>(?:[^<:：]{1,14}[：:]\s*<\/\k<t>>|[^<:：]{1,14}<\/\k<t>>\s*[：:])/, "粗體標題加冒號的條列;寫成句子", "raw"],
  ["半形標點", new RegExp(`[${HAN}] ?[,;:!?]|[,;:!?] ?[${HAN}]|[${HAN}][()]|[()][${HAN}]`), "中文旁的標點用全形(含括號)", "text"],
  ["entity 被全形分號打壞", /&#?\w+；/, "HTML entity 結尾是半形「;」", "raw"],
  ["三個英文句點", /\.\.\./, "介面用單個「…」", "han"],
  ["中點字形", /[・‧•]/, "meta 欄位之間用「 · 」(U+00B7),子句之間用逗號", "text"],
  ["「·」沒空格", /[^ ]·|·[^ ]/, "「·」前後各一個半形空格,只放在單行 meta 列的欄位之間", "text"],
  ["中文旁半形斜線", new RegExp(`[${HAN}]/|/[${HAN}]`), "中文之間用全形「／」", "nourl"],
  ["全形標點旁空格", / [，。、；：？！」）]|[，。、；：？！「（] /, "全形標點旁不加空格", "text"],
  ["範圍用「～」", /\d～\d/, "數字範圍用「–」(前後不空格)", "text"],
  ["中英數沒空格", new RegExp(`[${HAN}][A-Za-z0-9]|[A-Za-z0-9][${HAN}]`), "中文與英文、數字之間加一個半形空格", "spaced"],
];

const MARK = "￼";
function layers(s) {
  const text = s.replace(/<[^>]*>/g, MARK).replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  const noCode = text.replace(/`[^`]*`/g, MARK);
  const nourl = noCode.replace(/https?:\/\/\S+|[\w.-]+\.(?:com|org|io|tw|app)\/\S*/g, MARK);
  let spaced = nourl.replace(/\{[^}]*\}/g, " ");
  for (const n of NAME_OK) spaced = spaced.split(n).join(MARK);
  return { raw: s, text, nourl, spaced, han: new RegExp(`[${HAN}]`).test(s) ? s.replace(/<code>[\s\S]*?<\/code>/g, MARK) : "" };
}

function hits(s) {
  const L = layers(s), bare = s.trim(), out = [];
  for (const [name, rx, , layer] of RULES) {
    if (name === "破折號") {
      // canon Em-dash 僅此兩用:缺值(單獨一個,或接在標籤後當值,如「淨值 —」)與條列起頭的「— 」。web 的 lint 只放行前兩種
      const d = L.text.trim().replace(/\s—$/, "");
      if (d === "—" || !/——|—|──/.test(d) || (d.startsWith("— ") && !d.slice(2).includes("—"))) continue;
      out.push(name);
      continue;
    }
    if (rx.test(L[layer])) out.push(name);
  }
  return out;
}

function parsePo(text) {
  const out = new Map();
  let id = null, field = null, cur = { id: "", str: "" };
  const flush = () => { if (id !== null && cur.id) out.set(cur.id, cur.str); };
  for (const line of text.split("\n")) {
    let m;
    if ((m = line.match(/^msgid (".*")$/))) { flush(); id = 1; cur = { id: JSON.parse(m[1]), str: "" }; field = "id"; }
    else if ((m = line.match(/^msgstr (".*")$/))) { cur.str = JSON.parse(m[1]); field = "str"; }
    else if ((m = line.match(/^(".*")$/)) && field) cur[field] += JSON.parse(m[1]);
  }
  flush();
  return out;
}

const hash = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
const exempt = (key) => EXEMPT.some(([re]) => re.test(key));

function headBaselineKeys() {
  try {
    const rel = path.relative(REPO, BASELINE).split(path.sep).join("/");
    const txt = execFileSync("git", ["show", "HEAD:" + rel], { cwd: REPO, stdio: ["ignore", "pipe", "ignore"] }).toString();
    return new Set(Object.keys(JSON.parse(txt)));
  } catch { return null; }
}

// 紅項 [key, msgstr, 原因]
function check(entries, baseline, headKeys) {
  const red = [];
  for (const [key, str] of entries) {
    if (exempt(key)) continue;
    const h = hits(str);
    if (!h.length) continue;
    if (!(key in baseline)) red.push([key, str, h.join("、")]);
    else if (baseline[key] !== hash(str)) red.push([key, str, h.join("、") + "(舊帳句改過了,改了就要改乾淨)"]);
  }
  for (const key of Object.keys(baseline)) {
    const str = entries.get(key);
    if (str === undefined || exempt(key) || !hits(str).length) red.push([key, str || "", "baseline 這列已不需要,跑 --prune 縮掉"]);
    if (headKeys && !headKeys.has(key)) red.push([key, str || "", "baseline 只能縮不能長:git HEAD 那份沒有這個 key"]);
  }
  return red;
}

function prune(entries, baseline) {
  const out = {};
  for (const [key, h] of Object.entries(baseline)) {
    const str = entries.get(key);
    if (str !== undefined && !exempt(key) && hits(str).length && hash(str) === h) out[key] = h;
  }
  return out;
}

const writeBaseline = (b) => fs.writeFileSync(BASELINE, JSON.stringify(Object.fromEntries(Object.entries(b).sort()), null, 2) + "\n");

function selfTest() {
  let bad = 0;
  const t = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    console.log((ok ? "PASS  " : "FAIL  ") + "自測:" + name + (ok ? "" : "  得到 " + JSON.stringify(got)));
    if (!ok) bad++;
  };
  t("破折號", hits("自訂——跟 agent 說"), ["破折號"]);
  t("缺值「—」、標籤後的缺值、條列起頭放行", [hits("—"), hits("淨值 —"), hits("— 沒有交易")], [[], [], []]);
  t("夾在中間的「—」照擋", hits("{where} — {x}"), ["破折號"]);
  t("全形分號", hits("A 是這樣；B 是那樣。"), ["全形分號"]);
  t("不是…而是", hits("它不是在學規則，而是在記憶過去。"), ["不是…而是"]);
  t("填充開場", hits("值得注意的是，這裡有雜訊。"), ["填充開場"]);
  t("粗體開頭", hits("<strong>經驗法則：</strong>每多一個參數。"), ["粗體開頭"]);
  t("半形括號貼中文", hits("累積報酬(扣入金)"), ["半形標點"]);
  t("code 括號放行", hits("SMA(100) 這樣的指標"), []);
  t("entity 被全形分號打壞", hits("1&#37； 現金回饋"), ["全形分號", "entity 被全形分號打壞", "全形標點旁空格"]);
  t("三個英文句點", hits("正在呼叫 Blave AI..."), ["三個英文句點"]);
  t("英文句子裡的三個點不管", hits("Loading..."), []);
  t("片假名中點", hits("自動下單中・模擬"), ["中點字形"]);
  t("「·」沒空格", hits("偏高·留意軋空"), ["「·」沒空格"]);
  t("meta 列「 · 」放行", hits("11/06 14:32 · 研究報告"), []);
  t("中文旁半形斜線", hits("主流/山寨"), ["中文旁半形斜線"]);
  t("數字斜線與網址放行", hits("10/06、https://blave.org/zh/docs 看說明"), []);
  t("全形標點旁空格", hits("看這裡 ，再按"), ["全形標點旁空格"]);
  t("範圍用「～」", hits("08:45～13:45"), ["範圍用「～」"]);
  t("中英數沒空格", hits("作多後24小時"), ["中英數沒空格"]);
  t("產品名、佔位符、% 放行", hits("用憑證e總管匯出，報酬 +5%，{n}筆"), []);
  t("標籤換成佔位字元不造假空格", hits("<b>改好</b>，繼續"), []);
  const old = "舊——帳", base = { "a.old": hash(old) };
  t("新 key 中 → 紅", check(new Map([["a.new", old]]), {}, null).length, 1);
  t("舊帳沒改 → 綠", check(new Map([["a.old", old]]), base, null).length, 0);
  t("舊帳改了仍中 → 紅", check(new Map([["a.old", "改——帳"]]), base, null).length, 1);
  t("舊帳改好了 → 要 --prune", check(new Map([["a.old", "改好了"]]), base, null).length, 1);
  t("baseline 多出 HEAD 沒有的 key → 紅", check(new Map([["a.old", old]]), base, new Set()).length, 1);
  t("豁免的 key 放行", check(new Map([["pdf.disc1", old], ["x.msgFoo", old]]), {}, null).length, 0);
  t("--prune 只刪不加", JSON.stringify(prune(new Map([["a.old", "好"], ["b.new", old]]), base)), "{}");
  return bad;
}

function main() {
  const entries = parsePo(fs.readFileSync(PO, "utf8"));
  const arg = process.argv[2];
  if (arg === "--init") {
    if (fs.existsSync(BASELINE)) { console.error("baseline 已存在;要縮用 --prune,不能重建"); return 1; }
    const b = {};
    for (const [key, str] of entries) if (!exempt(key) && hits(str).length) b[key] = hash(str);
    writeBaseline(b);
    console.log("baseline 建好:" + Object.keys(b).length + " 列");
    return 0;
  }
  const baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
  if (arg === "--prune") {
    const b = prune(entries, baseline);
    writeBaseline(b);
    console.log("baseline " + Object.keys(baseline).length + " → " + Object.keys(b).length + " 列");
    return 0;
  }
  const bad = selfTest();
  const red = check(entries, baseline, headBaselineKeys());
  const fixes = Object.fromEntries(RULES.map(([n, , how]) => [n, how]));
  for (const [key, str, why] of red) {
    const how = why.split(/、|\(/).map((n) => fixes[n]).filter(Boolean).join(";");
    console.log("FAIL  " + key + "  「" + [...str.replace(/\s+/g, " ")].slice(0, 28).join("") + "…」  " + why + (how ? "  → " + how : ""));
  }
  if (red.length) console.log("\n規則見 " + CANON + "。");
  else console.log("PASS  zh.po " + entries.size + " 句,舊帳 " + Object.keys(baseline).length + " 句未改、豁免 " + EXEMPT.length + " 條");
  return bad + red.length ? 1 : 0;
}

process.exit(main());
