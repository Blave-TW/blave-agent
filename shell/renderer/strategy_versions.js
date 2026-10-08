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

  // 入口要不要存在:名字過閘門,而且至少有一版。零版不出、也不出佔位字 ——
  // Type B 與名字過不了閘門的策略永遠不會有版本,寫「尚無」就是假話。
  function usable(name, versions) {
    return NAME_RE.test(String(name == null ? "" : name)) && entries(versions).length >= 1;
  }

  // 比較要兩版才有意義。選單的「比較兩個版本…」與比較框的入口都問這一支。
  function canCompare(versions) {
    return entries(versions).length >= 2;
  }

  // 下一版的版號(只有一版時的引導句用)。runner 用 counter + 1;
  // counter 缺或比最新一版小時退回最新版號。零版 → null。
  function nextN(versions) {
    var e = entries(versions);
    if (!e.length) return null;
    var c = versions && typeof versions.counter === "number" && isFinite(versions.counter) ? versions.counter : 0;
    return Math.max(c, e[0].n) + 1;
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
    // MCPT 的排列次數有限,p 不會真的是 0:四捨五入成 0.000 是假象,不到半個最小刻度就寫 <0.001
    if (key === "mcpt_p" && n < 0.0005) return "<0.001";
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

  // 「目前」那一列要不要說明資料期間不同(回傳要顯示的兩個日期),不用就回 null。
  // 版本存的是回測當下的結果;策略上線後 live tick 每根 K 棒重寫 stats.json(canon §2),
  // 頁面那一份的終點會往後延,兩邊的數字就不一樣 —— 兩個都對,只是算到的日期不同。
  //   n        這一列的版號
  //   versions 摘要清單
  //   pageEnd  頁面那一份回測的終點(stats.json 的 end,"YYYY-MM-DD")
  //   viewing  頁面正在顯示的版號(時光機裡是舊版號;看目前版時傳 versions.current)
  var DAY_RE = /^(\d{4})-(\d{2})-(\d{2})/;
  function day(v) {
    var m = typeof v === "string" ? DAY_RE.exec(v) : null;
    return m ? { y: m[1], md: m[2] + "/" + m[3], key: m[1] + m[2] + m[3] } : null;
  }
  function windowNote(n, versions, pageEnd, viewing) {
    // 重跑中 / 沒完成:頁面畫的就是這一版存的結果(或 stats.json 已移開),沒有第二組數字可比
    if (pending(versions)) return null;
    var cur = versions && typeof versions.current === "number" ? versions.current : null;
    if (cur === null || n !== cur || viewing !== cur) return null;
    var e = entries(versions), it = null;
    for (var i = 0; i < e.length; i++) if (e[i].n === n) it = e[i];
    var a = it ? day(it.end) : null;
    var b = day(pageEnd);
    if (!a || !b || !(b.key > a.key)) return null;
    var withYear = a.y !== b.y;
    return {
      saved: (withYear ? a.y + "/" : "") + a.md,
      page: (withYear ? b.y + "/" : "") + b.md
    };
  }

  // 還原後背景重跑的狀態(canon §5)。摘要清單的 rerun 指的是 current、狀態是 running / failed 才算;
  // 其他情況(沒在重跑、rerun 指的不是 current)回 null。
  function pending(versions) {
    var r = versions && versions.rerun;
    var cur = versions && typeof versions.current === "number" ? versions.current : null;
    if (!r || typeof r !== "object" || cur === null || r.n !== cur) return null;
    if (r.status !== "running" && r.status !== "failed") return null;
    return { n: r.n, status: r.status, err: typeof r.err === "string" ? r.err : null };
  }

  // 這台主機的 lib 會不會就地還原(canon §9 的 inplace;沒有這個 key = 不會)
  function canRestoreInPlace(versions) {
    return !!versions && versions.inplace === true;
  }

  // 徽章語意(canon §7)。「目前」= index.json 的 current 指的那一版(還原後可以是較舊的號);
  // 「上線中」= 目前版 且 amounts > 0;drift 為 true 時不得畫乾淨的「上線中」。
  // amount 為 null(pfData 還沒載到)時只回 "current" —— 不猜。
  function badge(n, versions, amount, drift) {
    var cur = versions && typeof versions.current === "number" ? versions.current : null;
    if (cur === null || n !== cur) return null;
    if (typeof amount === "number" && amount > 0) return drift === true ? "drift" : "live";
    return "current";
  }

  // 送給 agent 的固定訊息裡的顯示名稱(稽核 S4):DISPLAY_NAME 是策略檔裡的自由文字
  // (下載來的策略也有),原樣插進去等於讓策略作者替用戶說話。規則同電腦版
  // shell/renderer/versions.js › verSafeName;清完是空的由呼叫端改用資料夾名。
  var UNSAFE_NAME_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029"'`“”‘’「」『』《》〈〉【】()（）\[\]{}<>]/g;
  function safeName(s) {
    var clean = String(s || "").replace(UNSAFE_NAME_RE, " ").replace(/\s+/g, " ").trim();
    return Array.from(clean).slice(0, 40).join("").trim();
  }

  global.blaveVersions = {
    DASH: DASH,
    safeName: safeName,
    NAME_RE: NAME_RE,
    entries: entries,
    usable: usable,
    canCompare: canCompare,
    nextN: nextN,
    fmt: fmt,
    delta: delta,
    windowsDiffer: windowsDiffer,
    windowNote: windowNote,
    pending: pending,
    canRestoreInPlace: canRestoreInPlace,
    badge: badge
  };
})(typeof window !== "undefined" ? window : globalThis);
