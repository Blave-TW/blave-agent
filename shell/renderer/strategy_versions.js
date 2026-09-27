/* Blave Agent — 策略版本(契約 `.claude/docs/strategy-versions.md`)的純函式層。
 *
 * DOM、i18n 與端點接線全部留在 workspace.html;這裡只放「拿資料算出要顯示什麼」
 * 的判斷與格式化,所以它們跑得起 node、壞掉會被 tests 的最小檢查抓到
 * (20,000 行的 template 裡測不到)。同 js/agent/report_blocks.js 的分工。
 *
 * 數字格式沿用回測分頁的既有慣例(2 位小數、U+2212 減號、缺值 em dash),
 * 不照 mockup 的示意位數 —— mockup 那些數字是假的。
 */
(function (global) {
  "use strict";

  var DASH = "—"; // canon §4/§9:缺值(Type C 的 sortino / mcpt_p)顯示這個,不是 0
  var MINUS = "−"; // U+2212

  // canon §9b:blob 的 S3 key 只收這個字元集,摘要清單必須套同一條。
  // 名字過不了 = 每一版的 blob GET 與比較永遠 404(「永遠在同步」的假象),
  // 所以整個版本 UI 不出現。一致的「沒有這功能」勝過打不開的清單。
  var NAME_RE = /^[A-Za-z0-9_-]{1,128}$/;

  function isEntry(i) {
    return !!i && typeof i === "object" && typeof i.n === "number" && isFinite(i.n);
  }

  // 由新到舊(index.json 是舊→新)。逐筆型別檢查:items 來自使用者機器。
  function entries(versions) {
    if (!versions || !Array.isArray(versions.items)) return [];
    return versions.items.filter(isEntry).sort(function (a, b) {
      return b.n - a.n;
    });
  }

  // 膠囊要不要存在。≥2 版才 render —— 只有一版時整顆不存在(mockup §3 的
  // 「B 比 A 輕」那條),所以 90% 的策略等於沒有這個功能。
  function usable(name, versions) {
    return NAME_RE.test(String(name == null ? "" : name)) && entries(versions).length >= 2;
  }

  function num(v) {
    return typeof v === "number" && isFinite(v) ? v : null;
  }

  // 六個指標:小數位、單位,以及「哪個方向算好」——差值上漲跌色靠 better,
  // 不靠數字正負。回撤是負數,變大(往 0 靠)才是好事;p 值越小越好。
  var SPEC = {
    ret: { dp: 2, unit: "%", signed: true, better: "up", delta: "pp" },
    sharpe: { dp: 2, unit: "", better: "up" },
    sortino: { dp: 2, unit: "", better: "up" },
    mdd: { dp: 2, unit: "%", signed: true, better: "up", delta: "pp" },
    trades: { dp: 0, unit: "", better: "none" },
    mcpt_p: { dp: 3, unit: "", better: "down" }
  };

  function signStr(v) {
    return v > 0 ? "+" : v < 0 ? MINUS : "";
  }

  // 單一指標的顯示值。null / 非有限 → DASH。
  function fmt(key, v) {
    var spec = SPEC[key];
    var n = num(v);
    if (!spec || n === null) return DASH;
    var body = Math.abs(n).toFixed(spec.dp);
    return (spec.signed ? signStr(n) : n < 0 ? MINUS : "") + body + spec.unit;
  }

  // 比較表的「差」欄:{text, tone}。tone 是 "up"(綠)/"down"(紅)/""(中性)。
  // 任一側缺值 → DASH 且無色:拿 0 當缺值會憑空生出一個差。
  function delta(key, a, b) {
    var spec = SPEC[key];
    var x = num(a);
    var y = num(b);
    if (!spec || x === null || y === null) return { text: DASH, tone: "" };
    var d = y - x;
    var text = signStr(d) + Math.abs(d).toFixed(spec.dp) + (spec.delta || "");
    var tone = "";
    if (d !== 0 && spec.better !== "none") {
      var improved = spec.better === "up" ? d > 0 : d < 0;
      tone = improved ? "up" : "down";
    }
    return { text: text, tone: tone };
  }

  // canon §4:各版的資料窗口會隨時間變長,不講的話比較總報酬是不公平的、
  // 而且看不出來。兩側任一端點不同就要在 UI 上說出來。
  function windowsDiffer(a, b) {
    if (!a || !b) return false;
    return String(a.start || "") !== String(b.start || "") ||
      String(a.end || "") !== String(b.end || "");
  }

  // 徽章語意(canon §7)。「目前」= 最新那版(恆為 index.json 的 current);
  // 「上線中」= 目前版 且 amounts > 0;drift 為 true 時不得畫乾淨的「上線中」。
  // amount 為 null(pfData 還沒載到)時只回 "current" —— 不猜。
  function badge(n, versions, amount, drift) {
    var cur = versions && typeof versions.current === "number" ? versions.current : null;
    if (cur === null || n !== cur) return null;
    if (typeof amount === "number" && amount > 0) return drift === true ? "drift" : "live";
    return "current";
  }

  global.blaveVersions = {
    DASH: DASH,
    NAME_RE: NAME_RE,
    entries: entries,
    usable: usable,
    fmt: fmt,
    delta: delta,
    windowsDiffer: windowsDiffer,
    badge: badge
  };
})(typeof window !== "undefined" ? window : globalThis);
