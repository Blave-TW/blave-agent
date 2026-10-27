// 電腦版 UI 文案長度閘門:shell/i18n/zh.po 每句 msgstr ≤ 40 字(zh 為基準,canon design-system.md › Copy & content rules)。
// 同頁展開內文(EXPANDED,具名清單)不設上限,同 web tests/check_copy_length.py。
// 只擋新字串:現在已超過的記在旁邊的 check_shell_copy_length.baseline.json(key → msgstr 的 sha256 前 16 碼),
// msgstr 沒變就放行;改了且仍 > 40 就紅。
//
// baseline 只能縮不能長:
//   - --prune 只會刪掉不再需要的列(key 不見了、改到 ≤ 40、改了字、進了白名單),從不新增;
//   - 列上的 hash 對不上現在的字(改過)或已經 ≤ 40 卻還留著 → 紅,逼人跑 --prune 讓縮減落地;
//   - 工作樹的 baseline 若多出 git HEAD 那份沒有的 key → 紅(手改 JSON 塞新 key 在 commit 前就會被擋;
//     檔案還沒進 git 時這條跳過)。
//
// 跑法(不開 Electron,只讀原文):
//   node tests/check_shell_copy_length.js           # 檢查(連同最小自測)
//   node tests/check_shell_copy_length.js --prune   # 縮 baseline
//   node tests/check_shell_copy_length.js --init    # 只在 baseline 不存在時建第一份
const fs = require("fs"), path = require("path"), crypto = require("crypto"), { execFileSync } = require("child_process");

const REPO = path.join(__dirname, "..");
const PO = path.join(REPO, "shell", "i18n", "zh.po");
const BASELINE = path.join(__dirname, "check_shell_copy_length.baseline.json");
const LIMIT = 40;
const CANON = ".claude/docs/design-system.md › Copy & content rules";

// 豁免:這些句子的長度由內容義務決定,砍字就是少講該講的事
const EXEMPT = [
  [/^pdf\.disc/, "匯出 PDF 的法遵免責聲明,措辭照法遵定稿,不為字數改"],
  [/^priv\.collect\./, "隱私設定逐項揭露蒐集了什麼,刪字等於少揭露"],
  [/^(pv\.[df]|cf\.m)\./, "付款牆與方案確認框的扣款條件(金額、何時扣、不退款),誠實句要講全"],
  [/(^|\.)msg(?!\w*(Label|Title)$)/, "送給 agent 的提示詞(*.msg*,不含畫面上的 Label/Title),讀者是模型不是用戶"],
  [/^cap\.ho\.prompt|^tr\.err\.askPrompt/, "送給 agent 的提示詞(群益開通交接、下單失敗請 agent 查)"],
  [/^rpt\.new\.tpl\./, "新報告範本,填進描述欄後送給 agent 的提示詞"],
  [/^cx\.paper\.fill$/, "同頁展開內文(「模擬怎麼成交？」),canon 文案密度 #4 不設字數"],
];

// 同頁展開內文(canon Copy #4／#9):只列確實只出現在收合區塊本體裡的 key;觸發字照 40 檢查。
// 不用 regex 猜——同一個 key 若還在展開外出現就不能列。新增展開內文的人自己加一行。
const _START_DET = "trade.js trStartNotes 的 details → 啟動確認框收合的「細節」(trAskStart,細節一律收合)";
const EXPANDED = {
  "cx.leadCloud": "trade.js 連帳戶表單「金鑰存在哪？」cx-disc 收合段 #cx-store(雲端視角)",
  "tr.det.ownRule": _START_DET + "(帳本未建時的「自己的部位」)",
  "tr.cloud.means.4": _START_DET + "(雲端)",
  "tr.means.1aWin": _START_DET + "(這台電腦、Windows 防睡開著)",
  "tr.means.twStop": _START_DET + "(這台電腦、台灣期貨券商)",
};

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

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
function countChars(s) {
  s = s.replace(/<[^>]*>/g, " ");
  const cjk = (s.match(CJK) || []).length;
  const words = (s.replace(CJK, " ").match(/\{[^}\s]*\}|[\p{L}\p{N}_]+(?:[.,]\p{N}+)*/gu) || []).length;
  return cjk + words;
}

const hash = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
const exemptOf = (key) => EXEMPT.find(([re]) => re.test(key));
const unlimited = (key) => !!exemptOf(key) || key in EXPANDED;

function headBaselineKeys() {
  try {
    const rel = path.relative(REPO, BASELINE).split(path.sep).join("/");
    const txt = execFileSync("git", ["show", "HEAD:" + rel], { cwd: REPO, stdio: ["ignore", "pipe", "ignore"] }).toString();
    return new Set(Object.keys(JSON.parse(txt)));
  } catch { return null; }
}

// 回傳紅項清單;每項 [key, 字數, 原因]
function check(entries, baseline, headKeys) {
  const red = [];
  for (const [key, str] of entries) {
    if (unlimited(key)) continue;
    const n = countChars(str);
    if (n <= LIMIT) continue;
    if (!(key in baseline)) red.push([key, n, str, "新字串超過 " + LIMIT + " 字"]);
    else if (baseline[key] !== hash(str)) red.push([key, n, str, "舊帳句改過了,改了就要改到 ≤ " + LIMIT + " 字"]);
  }
  for (const key of Object.keys(baseline)) {
    const str = entries.get(key);
    if (str === undefined || unlimited(key) || countChars(str) <= LIMIT)
      red.push([key, str === undefined ? 0 : countChars(str), str || "", "baseline 這列已不需要,跑 --prune 縮掉"]);
    if (headKeys && !headKeys.has(key))
      red.push([key, str === undefined ? 0 : countChars(str), str || "", "baseline 只能縮不能長:git HEAD 那份沒有這個 key"]);
  }
  return red;
}

function prune(entries, baseline) {
  const out = {};
  for (const [key, h] of Object.entries(baseline)) {
    const str = entries.get(key);
    if (str !== undefined && !unlimited(key) && countChars(str) > LIMIT && hash(str) === h) out[key] = h;
  }
  return out;
}

const writeBaseline = (b) => fs.writeFileSync(BASELINE, JSON.stringify(Object.fromEntries(Object.entries(b).sort()), null, 2) + "\n");

function selfTest() {
  let bad = 0;
  const t = (name, cond) => { console.log((cond ? "PASS  " : "FAIL  ") + "自測:" + name); if (!cond) bad++; };
  const long52 = "一".repeat(50) + " {sym} BTC";
  t("計字:漢字一個一字、英數詞與 {placeholder} 各一字、標籤標點不算", countChars("<b>買進</b> {sym} BTCUSDT，1.5 倍！") === 6 && countChars(long52) === 52);
  const old = "舊".repeat(45), base = { "a.old": hash(old) };
  t("新 key 52 字 → 紅", check(new Map([["a.old", old], ["a.new", long52]]), base, null).some((r) => r[0] === "a.new"));
  t("改了 baseline 裡的 key 且仍 > 40 → 紅", check(new Map([["a.old", old + "改"]]), base, null).some((r) => r[0] === "a.old"));
  t("baseline 裡的 key 沒改 → 綠", check(new Map([["a.old", old]]), base, null).length === 0);
  t("baseline 多出 HEAD 沒有的 key → 紅", check(new Map([["a.old", old]]), base, new Set()).length === 1);
  t("豁免的 key 再長也綠", check(new Map([["pdf.disc9", long52], ["x.msgFoo", long52]]), {}, null).length === 0);
  t("--prune 只刪不加", JSON.stringify(prune(new Map([["a.old", "短"], ["b.new", long52]]), base)) === "{}");
  t("EXPANDED 的 key 再長也綠,不在清單的同長句照紅", check(new Map([["tr.det.ownRule", long52]]), {}, null).length === 0 && check(new Map([["tr.det.ownRuleX", long52]]), {}, null).length === 1);
  t("EXPANDED 的 key 在 baseline 裡 → 要 --prune 縮掉", prune(new Map([["cx.leadCloud", old]]), { "cx.leadCloud": hash(old) })["cx.leadCloud"] === undefined);
  return bad;
}

function main() {
  const entries = parsePo(fs.readFileSync(PO, "utf8"));
  const arg = process.argv[2];
  if (arg === "--init") {
    if (fs.existsSync(BASELINE)) { console.error("baseline 已存在;要縮用 --prune,不能重建"); return 1; }
    const b = {};
    for (const [key, str] of entries) if (!unlimited(key) && countChars(str) > LIMIT) b[key] = hash(str);
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
  let bad = selfTest();
  // 清單本身:每條都還在 zh.po、不跟豁免重疊(key 改名或刪了就會留下沒人管的死列)
  for (const key of Object.keys(EXPANDED)) {
    if (!entries.has(key)) { console.log("FAIL  EXPANDED 列了 zh.po 沒有的 key:" + key); bad++; }
    if (exemptOf(key)) { console.log("FAIL  EXPANDED 跟豁免重疊:" + key); bad++; }
  }
  const red = check(entries, baseline, headBaselineKeys());
  for (const [key, n, str, why] of red) console.log("FAIL  " + key + "  " + n + " 字  「" + [...str].slice(0, 20).join("") + "…」  " + why);
  if (red.length) console.log("\nzh 一句上限 " + LIMIT + " 字(漢字一字、英數詞一字、標點不算)。規則見 " + CANON + "。");
  else console.log("PASS  zh.po " + entries.size + " 句,舊帳 " + Object.keys(baseline).length + " 句未改、豁免 " + EXEMPT.length + " 條");
  return bad + red.length ? 1 : 0;
}

process.exit(main());
