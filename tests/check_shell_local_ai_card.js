// 登入額度用完卡片的〔改用 Claude Code 或 Codex〕＋連結本機 AI 的 modal(0.1.36;spec free-credit-usedup-local-ai)。
//   ① 卡片按鈕組合:pre_free／turn_free 第二顆是文字鈕〔改用 Claude Code 或 Codex〕、回合卡的〔再送一次〕讓位;其他卡不動
//   ② modal 每一列的狀態(laiRows):已登入〔使用〕／已裝沒登入〔登入〕／沒裝〔怎麼安裝〕,加偵測中、等瀏覽器、登入沒完成、跑不起來
//   ③ 換成功後卡片換字(acctLocalSwap):預檢卡換字留著不拿掉、回合卡換成〔再送一次〕(本機兩個 CLI 與 API 金鑰都是)
//   ④ 換成本機以後帳號重查不把卡畫回「額度用完」(acctPaint 只在 cur === "blave" 時畫這兩種卡)
//   ⑤ 擋著的 *_free 卡還在時,輸入框焦點／第一次按鍵補一次重查(15 秒限頻)
//   ⑥ 真的 index.html(隨包 Electron、offscreen、window.blave 換成假的):兩條完整流程 + 鍵盤
// 不打 api、不跑 CLI 登入。跑法:node tests/check_shell_local_ai_card.js(Electron 那段要 BLAVE_TEST_WINDOW=1)
const fs = require("fs"), path = require("path");
const SHELL = path.join(__dirname, "..", "shell");
const GATE = require("./_electron_gate");
const app = fs.readFileSync(path.join(SHELL, "renderer", "app.js"), "utf8");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  " + JSON.stringify(d))); if (!c) red++; };

if (!process.versions.electron) (async () => {
  const fn = (name) => { const i = app.indexOf("function " + name + "("); if (i < 0) throw new Error("找不到 " + name); let d = 0; for (let k = app.indexOf("{", app.indexOf(")", i)); k < app.length; k++) { if (app[k] === "{") d++; else if (app[k] === "}" && --d === 0) return app.slice(i, k + 1); } throw new Error("切不出 " + name); };
  const line = (re) => { const m = app.match(re); if (!m) throw new Error("找不到 " + re); return m[0]; };
  const mk = (connected = true) => { const c = { sets: 0, el: { isConnected: connected } }; c.set = (s) => { c.last = s; c.sets++; }; return c; };

  // ① ④ 真的跑 acctPaint(cur 由外面給),鈕的 handler 換成記錄器
  const P = new Function("t", "acct", "acctCard", "creditCards", "cur", "log", `let acctGone = null, dataCardSync = () => {}, mpBillPaint = undefined, planWatch = () => {}, libIdeaPaint = undefined, wdPaint = undefined, $ = () => null;
    const acctSub = () => null, resendSecond = () => ({ label: "fault.resend" }), resendState = (c, x) => ({ text: x, label: "fault.resend" }), acctShown = () => {}, acctBackTrack = () => {},
      acctCrypto = (s) => (s && s.reason === "NO_CARD" ? { label: "acct.cryptoTopup" } : null), acctFreeUpText = (w) => w + ".freeUp", acctBuiltText = () => "", RP = { list: [] },
      acctAction = (s) => ({ label: s && s.reason === "NO_CARD" ? "acct.addCard" : "fault.noCreditBtn", on: () => log.push("bind") }), laiOpen = (card) => log.push(card);
    ${fn("acctCardKind")}\n${fn("laiSecond")}\n${fn("acctPaint")}\nacctPaint();`);
  const paint = (acct, cur) => { const pre = mk(), turn = mk(), log = []; P((k) => k, acct, pre, [turn], cur || "blave", log); return { pre, turn, log }; };
  const shape = (s) => s ? [s.label, s.second ? s.second.label + (s.second.quiet ? "(quiet)" : "") : "-", s.third ? s.third.label : "-"].join(" | ") : "none";
  const UP = { can_run: false, reason: "NO_CARD", free_ai_credit_used_up: true };
  {
    const r = paint(UP);
    ok("① 預檢卡 pre_free:〔前往綁卡〕實心 →〔改用 Claude Code 或 Codex〕文字鈕 →〔用加密貨幣轉帳儲值〕", shape(r.pre.last) === "acct.addCard | acct.useLocal(quiet) | acct.cryptoTopup" && !r.pre.last.quiet && !r.pre.last.out, shape(r.pre.last));
    ok("① 回合卡 turn_free:同一組,〔再送一次〕讓位", shape(r.turn.last) === "acct.addCard | acct.useLocal(quiet) | acct.cryptoTopup", shape(r.turn.last));
    ok("① 兩張卡都記成 _free(重查點用)", r.pre._free === true && r.turn._free === true);
    r.turn.last.second.on(); r.pre.last.second.on();
    ok("① 按第二顆開 modal、帶著是哪張卡(收尾放焦點用);不走綁卡那條(acctAction 的 on 沒被叫)", r.log.length === 2 && r.log[0] === r.turn && r.log[1] === r.pre, r.log.length);
    const c = paint({ can_run: false, reason: "NO_CARD" });
    ok("① 沒用過額度的 pre_card／turn_card 不動:預檢卡沒有第二顆、回合卡第二顆仍是〔再送一次〕", shape(c.pre.last) === "acct.addCard | - | acct.cryptoTopup" && shape(c.turn.last) === "acct.addCard | fault.resend | acct.cryptoTopup" && !c.pre._free && !c.turn._free, [shape(c.pre.last), shape(c.turn.last)]);
    const n = paint({ can_run: false, reason: "NO_CREDIT", free_ai_credit_used_up: true });
    ok("① 有卡沒餘額 turn_credit 不動:〔儲值〕+〔再送一次〕,不出本機鈕", shape(n.turn.last) === "fault.noCreditBtn | fault.resend | -" && shape(n.pre.last) === "fault.noCreditBtn | - | -", [shape(n.pre.last), shape(n.turn.last)]);
    const g = paint({ can_run: true, free_ai_credit_used_up: true });
    ok("① 能跑了:預檢卡「可以開始了」、回合卡〔再送一次〕;_free 清掉", g.pre.last.text === "acct.ready" && g.turn.last.text === "acct.creditIn" && !g.pre._free && !g.turn._free);
    for (const k of ["claude", "codex", "apikey", null]) {
      const x = paint(UP, k || "x");
      if (k) ok("④ 換成 " + k + " 以後重查(can_run 還是 false):兩種卡一次都不重畫", x.pre.sets === 0 && x.turn.sets === 0, [x.pre.sets, x.turn.sets]);
    }
    ok("④ acctCheck 查不到帳號時的退路卡(fault.noCredit)也只在 Blave AI 時畫", /if \(!acct && cur === "blave"\) creditCards\.forEach/.test(fn("acctCheck")));
  }

  // ② modal 列的狀態:真的跑 laiRows(底下是設定 › 模型接入那份 mdlOptions)
  {
    const R = new Function(`${line(/^const whyState = .*$/m)}\n${fn("mdlOptions")}\n${fn("laiRows")}\nreturn laiRows;`)();
    const sh = (rows) => rows.map((r) => [r.kind, r.act || "-", r.st || "-", r.sub || "-", r.off ? "off" : "", r.fill ? "fill" : ""].join(":")).join(" / ");
    const D = (c, x) => ({ claude: c, codex: x, apikey: { saved: "openrouter" } });
    const IN = { installed: true, loggedIn: true }, OUT = { installed: true, loggedIn: false }, NONE = { installed: false };
    let r = R(D(IN, NONE), "blave", null, {});
    ok("② 已登入〔使用〕(只有這列能用 → 實心)、沒裝〔怎麼安裝〕(名字灰、沒有狀態字);只有兩列(沒有 Blave、API 金鑰)", sh(r) === "claude:cn.use:-:-::fill / codex:lai.install:-:-:off:", sh(r));
    r = R(D(IN, IN), "blave", null, {});
    ok("② 兩列都能用:兩顆〔使用〕都描邊", sh(r) === "claude:cn.use:-:-:: / codex:cn.use:-:-::", sh(r));
    r = R(D(OUT, { installed: true, loggedIn: false, authOutside: true }), "blave", null, {});
    ok("② 已裝沒登入〔登入〕;金鑰設在讀不到的地方 → 名字下面 row.keyOff", sh(r) === "claude:cn.signIn:-:-:: / codex:cn.signIn:-:row.keyOff::", sh(r));
    r = R(null, "blave", null, {});
    ok("② 偵測中:兩列都「偵測中…」、沒有動作、名字灰(列數不變)", sh(r) === "claude:-:cn.detecting:-:off: / codex:-:cn.detecting:-:off:", sh(r));
    r = R(D(OUT, OUT), "blave", "claude", { claude: "opened" });
    ok("② 等瀏覽器:那一列〔取消等待〕+「已在瀏覽器開啟登入頁」;另一列照舊〔登入〕(鎖鈕在 laiPaint)", sh(r) === "claude:login.cancel:-:row.opened:: / codex:cn.signIn:-:-::", sh(r));
    r = R(D(OUT, OUT), "blave", "claude", {});
    ok("② 等瀏覽器、還沒過 1 秒:只換成〔取消等待〕,不先講已開啟", sh(r).startsWith("claude:login.cancel:-:-::"), sh(r));
    r = R(D(OUT, NONE), "blave", null, { claude: "failed" });
    ok("② 登入沒完成:〔再試一次〕+ row.failed(畫的時候接 cmdLine)", sh(r) === "claude:login.retry:-:row.failed:: / codex:lai.install:-:-:off:", sh(r));
    r = R(D({ installed: true, loggedIn: false, why: "claude_cantrun" }, { installed: true, loggedIn: false, why: "codex_timeout" }), "blave", null, {});
    ok("② 跑不起來／沒回應:名字灰、狀態字、沒有鈕;跑不起來另寫 row.reinstall", sh(r) === "claude:-:st.cantRun:row.reinstall:off: / codex:-:st.noResp:-:off:", sh(r));
    r = R(D(IN, NONE), "claude", null, {});
    ok("② 已經在用的那一列:沒有鈕、記成 isCur(畫「目前使用」)", r[0].act === null && r[0].isCur === true);
    const lp = fn("laiPaint");
    ok("② laiPaint:等登入中只有〔取消等待〕能按;腳只在有一列不能用時出(mdlNeedsRedetect)、偵測中或等待中鎖住;〔怎麼安裝〕是文字鈕",
      /if \(b && waiting && r\.act !== "login\.cancel"\) b\.disabled = true;/.test(lp) && /\$\("lai-foot"\)\.hidden = !mdlNeedsRedetect\(lastDetect\);/.test(lp) && /\$\("lai-redetect"\)\.disabled = MDL\.busy \|\| waiting;/.test(lp) && /r\.act === "lai\.install" \? "btn-quiet"/.test(lp));
  }

  // ③ 換好以後卡片換字
  {
    const S = new Function("t", "st", "acctCardIn", "creditCards", `let acctCard = acctCardIn; const resendState = (c, x) => ({ calm: true, text: x, label: "fault.resend" }), AK = { info: st.ak || null };
      ${fn("acctLocalName")}\n${fn("acctLocalSwap")}\nacctLocalSwap(st.kind); return acctCard;`);
    const tt = (k, v) => k + (v && v.name ? "{" + v.name + "}" : "");
    const pre = mk(), t1 = mk(), t2 = mk(), tGone = mk(false), tCard = mk(); t1._free = t2._free = tGone._free = true;
    const cards = [t1, tCard, t2, tGone];
    const left = S(tt, { kind: "codex" }, pre, cards);
    ok("③ 預檢卡:換成「已改用 Codex,可以開始了。」、沒有鈕,而且不再歸 acctPaint 管(acctCard = null)", pre.last.text === "acct.localReady{Codex}" && pre.last.calm && !pre.last.label && left === null, pre.last);
    ok("③ 額度用完的回合卡:換成「已改用 Codex,可以再送了。」+〔再送一次〕,從 creditCards 拿掉;已不在畫面上的只拿掉不畫", t1.last.text === "acct.localResend{Codex}" && t1.last.label === "fault.resend" && t2.last.text === "acct.localResend{Codex}" && tGone.sets === 0 && cards.length === 1 && cards[0] === tCard && tCard.sets === 0);
    const p2 = mk(), c2 = mk(); c2._free = true; const cs2 = [c2];
    ok("③ Claude Code 同一組字", S(tt, { kind: "claude" }, p2, cs2) === null && p2.last.text === "acct.localReady{Claude Code}" && c2.last.text === "acct.localResend{Claude Code}");
    for (const k of ["blave", null]) { const p = mk(), c = mk(); c._free = true; const cs = [c]; const back = S(tt, { kind: k }, p, cs); ok("③ 換成 " + k + ":不動", back === p && p.sets === 0 && c.sets === 0 && cs.length === 1); }
    { const p = mk(), c = mk(), keep = mk(); c._free = true; const cs = [c, keep];
      const back = S(tt, { kind: "apikey", ak: { saved: "openrouter", presets: [{ id: "deepseek", name: "DeepSeek" }, { id: "openrouter", name: "OpenRouter" }] } }, p, cs);
      ok("③ 換成 API 金鑰:同一組字,{name} 是存的那家供應商;預檢卡換字留著、額度用完的回合卡有〔再送一次〕(spec §4 cur !== \"blave\")",
        back === null && p.last.text === "acct.localReady{OpenRouter}" && c.last.text === "acct.localResend{OpenRouter}" && c.last.label === "fault.resend" && cs.length === 1 && cs[0] === keep && keep.sets === 0, [p.last, c.last]);
      const p2 = mk(), c2 = mk(); c2._free = true;
      S((k, v) => k === "ak.row" ? "API 金鑰" : tt(k, v), { kind: "apikey", ak: null }, p2, [c2]);
      ok("③ API 金鑰、查不到是哪一家:{name} 退成「API 金鑰」", p2.last.text === "acct.localReady{API 金鑰}" && c2.last.text === "acct.localResend{API 金鑰}", [p2.last, c2.last]); }
    ok("③ acctPrecheck 第一件事就是 acctLocalSwap(cur),在拿掉預檢卡那行之前(enterWorkspace 每次都叫,設定 › 模型接入換過去也走)", /^function acctPrecheck\(\) \{\n  acctLocalSwap\(cur\);[^\n]*\n  if \(acctCard && acctCard\.el\.isConnected\) acctCard\.el\.remove\(\);/m.test(fn("acctPrecheck")));
  }

  // ⑤ 補的重查點
  {
    const F = new Function("st", `let cur = st.cur, hasToken = st.tok, acctPending = st.pend || 0, acctAt = st.at, acctCard = st.card || null; const creditCards = st.cards || [];
      ${line(/^const ACCT_FREE_GAP_MS = .*$/m)}\n${fn("acctFreeDue")}\nreturn acctFreeDue(st.now);`);
    const free = mk(); free._free = true; const plain = mk(); const gone = mk(false); gone._free = true;
    const base = { cur: "blave", tok: true, at: 0, now: 20000 };
    ok("⑤ 擋著的 *_free 卡(預檢卡或回合卡)還在、距上次查超過 15 秒 → 查", F({ ...base, card: free }) && F({ ...base, cards: [plain, free] }));
    ok("⑤ 15 秒內不查;不是 Blave AI、沒登入、上一次還在途都不查", !F({ ...base, card: free, at: 6000 }) && !F({ ...base, cur: "claude", card: free }) && !F({ ...base, tok: false, card: free }) && !F({ ...base, pend: 1, card: free }));
    ok("⑤ 沒有 *_free 卡、或那張已不在畫面上 → 不查", !F({ ...base, card: plain, cards: [plain] }) && !F({ ...base, cards: [gone] }));
    ok("⑤ 掛在輸入框:拿到焦點查一次、焦點已在框裡的第一次按鍵查一次;這兩次不重開重試鏈(noRetry)", /\$\("ta"\)\.addEventListener\("focus", \(\) => \{ taKeyed = false; if \(acctFreeDue\(Date\.now\(\)\)\) acctCheck\(\{ noRetry: true \}\); \}\);/.test(app) && /\$\("ta"\)\.addEventListener\("keydown", \(\) => \{ if \(taKeyed\) return; taKeyed = true; if \(acctFreeDue\(Date\.now\(\)\)\) acctCheck\(\{ noRetry: true \}\); \}\);/.test(app));
  }

  // ⑤ 輸入框補的那次不重開重試鏈:真的跑 acctCheck,setTimeout 換成記錄器(不等真的時間;Windows 慢時舊的重試計時器不會混進來)
  {
    const C = new Function("st", `let hasToken = true, acct = null, acctAt = 0, acctPending = 0, acctSettled = false, acctRetry = st.retry, acctCard = { _free: true }, cur = st.cur;
      const creditCards = [], AUTH = { revoked: false }, armed = [], window = { blave: { accountStatus: async () => ({ can_run: false, reason: "NO_CARD", free_ai_credit_used_up: true }) } };
      const setTimeout = (f, ms) => { armed.push(ms); return 0; }, planWatchIdle = () => {}, authSync = async () => {}, acctSet = (x) => { acct = x; }, acctPaint = () => {}, acctBackTrack = () => {};
      async ${fn("acctCheck")}
      return acctCheck(st.o).then(() => ({ armed, retry: acctRetry }));`);
    const runs = await Promise.all([C({ retry: 0, cur: "blave", o: { noRetry: true } }), C({ retry: 2, cur: "blave", o: { noRetry: true } }), C({ retry: 0, cur: "blave" }), C({ retry: 3, cur: "blave" }), C({ retry: 0, cur: "codex" })]);
    ok("⑤ noRetry:不排計時器、也不動進行中那一輪的重試次數", runs[0].armed.length === 0 && runs[0].retry === 0 && runs[1].armed.length === 0 && runs[1].retry === 2, runs.slice(0, 2));
    ok("⑤ 一般那次照舊:還不能跑就 5 秒後再查(次數 +1)、滿 3 次歸零不再排;不是 Blave AI 不排", JSON.stringify(runs[2].armed) === "[5000]" && runs[2].retry === 1 && runs[3].armed.length === 0 && runs[3].retry === 0 && runs[4].armed.length === 0, runs.slice(2));
  }

  // 接線
  {
    const trade = fs.readFileSync(path.join(SHELL, "renderer", "trade.js"), "utf8"), html = fs.readFileSync(path.join(SHELL, "renderer", "index.html"), "utf8");
    const mainSrc = fs.readFileSync(path.join(SHELL, "main.js"), "utf8");
    ok("接線:mdlPaint 第一行畫 modal(detect／偵測中／paintRows／setHint 都經過它)", /^function mdlPaint\(\) \{\n  laiPaint\(\);/m.test(app));
    ok("接線:localLogin 的第三個表面(modal 列):先判 #lai-rows,成功一樣直接 connect、字寫在列上", /const inLai = !!b\.closest\("#lai-rows"\), inRow = !inLai && !b\.closest\("\.cn-opts"\);/.test(app) && /if \(\(inRow \|\| inLai\) && r\.ok && x\.installed && x\.loggedIn\) \{\n    if \(inLai && !laiOn\(\)\) LAI\.late = kind;[^\n]*\n    return connect\(kind, x\);/.test(app) && /if \(inLai\) \{ LAI\.msg\[kind\] = "failed"; laiPaint\(\);/.test(app));
    ok("接線:enterWorkspace 換好後先給 laiDone 收框與放焦點,沒開才給輸入框", /  if \(laiDone\(kind\)\) return;[^\n]*\n  \$\("ta"\)\.focus\(\);\n\}/.test(fn("enterWorkspace")));
    ok("接線:Esc 由 escTop 關(跟其他同層的框並列,排在連接交易所之後);切視角守門算它", /\? cxDismiss : !\$\("lai-scrim"\)\.hidden \? laiClose :/.test(fn("escTop")) && /\$\("lai-scrim"\)\.hidden/.test(trade));
    ok("接線:回前景重偵測把這個 modal 算進去(裝完回來不用按重新偵測)", /\|\| onModel \|\| laiOn\(\)\)/.test(fn("focusRedetect")));
    ok("接線:開框送 acct_local_open、換成功送 acct_local_use;不送 acct_card_click、不設 acctGone", /trackFeature\("acct_local_open"\)/.test(fn("laiOpen")) && /trackFeature\("acct_local_use"\)/.test(fn("laiDone")) && !/acctClicked|acctGone/.test(fn("laiOpen") + fn("laiDone") + fn("laiAct")));
    ok("接線:✕／Esc 關掉時正在等瀏覽器就一起取消、焦點回卡上的〔改用 Claude Code 或 Codex〕", /if \(loginPending && loginPending === LAI\.login\) window\.blave\.cancelAgentLogin\(\);/.test(fn("laiClose")) && /c\.b2\.focus\(\)/.test(fn("laiClose")));
    ok("index.html:自己的 .scrim(不借 set-scrim)、440 的 del-modal 外框、標題沿用 cn.local.label、第一行 lai.lede、腳只有〔重新偵測〕",
      /<div class="scrim" id="lai-scrim" role="dialog" aria-modal="true"[^>]*hidden>\s*<div class="set-modal del-modal" id="lai-modal">/.test(html) && /id="lai-title" data-i18n="cn\.local\.label"/.test(html) && /id="lai-lede" data-i18n="lai\.lede"/.test(html)
      && /<div class="modal-foot lai-foot" id="lai-foot" hidden>\s*<button type="button" class="btn-quiet" id="lai-redetect" data-i18n="cn\.redetect"><\/button>\s*<\/div>/.test(html) && !/lai-[a-z]*cancel/.test(html));
    ok("疊層:#lai-scrim 在 DOM 裡排在 #del-scrim 前面(同 z-index,確認框才疊得到它上面);confirmBox 開框時把它鎖住、delClose 解鎖時工作頁仍歸它鎖",
      html.indexOf('id="lai-scrim"') > 0 && html.indexOf('id="lai-scrim"') < html.indexOf('id="del-scrim"') && /\$\("lai-scrim"\)\.inert = true;/.test(fn("confirmBox")) && /\$\("view-ws"\)\.inert = laiOn\(\);/.test(fn("delClose")));
    // 安裝頁走 open-external IPC(main.js webUrl:任何 https、不帶帳密),不走 window.open 的 EXTERNAL_HOSTS
    const cutMain = (name) => { const i = mainSrc.indexOf("function " + name + "("); let d = 0; for (let k = mainSrc.indexOf("{", i); k < mainSrc.length; k++) { if (mainSrc[k] === "{") d++; else if (mainSrc[k] === "}" && --d === 0) return mainSrc.slice(i, k + 1); } return ""; };
    const webUrl = new Function("return (" + cutMain("webUrl") + ")")();
    const urls = new Function(line(/^const LAI_INSTALL = .*$/m) + "; return LAI_INSTALL;")();
    ok("安裝頁:官方兩頁、https;外開走 open-external(webUrl 放行原網址)", urls.claude === "https://code.claude.com/docs/en/setup" && urls.codex === "https://developers.openai.com/codex/cli" && webUrl(urls.claude) === urls.claude && webUrl(urls.codex) === urls.codex
      && /window\.blave\.openExternal\(LAI_INSTALL\[r\.kind\]\)/.test(fn("laiAct")) && /openExternal: \(url\) => ipcRenderer\.invoke\("open-external", url\)/.test(fs.readFileSync(path.join(SHELL, "preload.js"), "utf8")));
    const { en, zh } = new Function(fs.readFileSync(path.join(SHELL, "renderer", "strings.js"), "utf8") + "; return STRINGS;")();
    ok("字串:五條新字、產品名純文字;不寫免費／推薦", zh["acct.useLocal"] === "改用 Claude Code 或 Codex" && en["acct.useLocal"] === "Use Claude Code or Codex" && zh["lai.lede"] === "走你自己的帳號，Blave 不收 AI 費用。" && en["lai.lede"] === "Runs on your own account. No AI charges from Blave."
      && zh["lai.install"] === "怎麼安裝" && en["lai.install"] === "How to install" && zh["acct.localResend"] === "已改用 {name}，可以再送了。" && en["acct.localResend"] === "Switched to {name}. You can send again." && zh["acct.localReady"] === "已改用 {name}，可以開始了。" && en["acct.localReady"] === "Switched to {name}. Ready to go."
      && !/免費|推薦|free|recommend/i.test(["acct.useLocal", "lai.lede", "lai.install", "acct.localResend", "acct.localReady"].map((k) => zh[k] + en[k]).join()));
  }

  const bin = GATE.bin(SHELL, "⑥");
  if (!bin) { console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0); }
  const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit" });
  if (r.status !== 0) red++;
  console.log(red ? `\n${red} 紅` : "\nALL PASS");
  process.exit(red ? 1 : 0);
})().catch((e) => { console.log("FAIL  " + (e && e.stack || e)); process.exit(1); });
else {

// ⑥ Electron:真的 index.html,window.blave 換成假的(偵測結果、帳號狀態、登入結果都由 window.__S 給)
const { app: eapp, BrowserWindow } = require("electron");
const os = require("os");
eapp.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "blave-lai-")));
const STUB = `window.__log = []; window.__S = {
    getLocale: "zh-TW", hasBlaveToken: true, loadConnection: { kind: "blave" }, saveConnection: true,
    accountStatus: { can_run: false, reason: "NO_CARD", has_card: false, free_ai_credit_used_up: true },
    detectAgents: { claude: { installed: true, loggedIn: true, path: "/x/claude" }, codex: { installed: false } },
    listStrategies: [], listSessions: [], loadSession: [], loadSessionImages: [], updateState: { phase: "idle", current: "0.0.0" } };
  window.blave = new Proxy({}, { get: (_, k) => typeof k !== "string" ? undefined
    : k === "onAgentLoginSpawned" ? (cb) => { window.__spawned = cb; }
    : k.startsWith("on") ? () => {} : k === "tradeLabels" ? () => {}
    : k === "trackFeature" ? (n) => { window.__log.push("f:" + n); }
    : k === "openExternal" ? async (u) => { window.__log.push("o:" + u); return true; }
    : k === "cancelAgentLogin" ? async () => { window.__log.push("cancel"); if (window.__loginDone && !window.__noCancel) window.__loginDone({ ok: false, cancelled: true }); }
    : k === "agentLogin" ? (kind) => { window.__log.push("login:" + kind); setTimeout(() => window.__spawned && window.__spawned(), 10); return new Promise((res) => { window.__loginDone = res; }); }
    : k === "saveConnection" ? async (c) => { window.__log.push("save:" + c.kind); return window.__S.saveConnection; }
    : async () => window.__S[k] });`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
eapp.whenReady().then(async () => {
  const pre = path.join(eapp.getPath("userData"), "stub.js"); fs.writeFileSync(pre, STUB);
  const w = new BrowserWindow({ width: 1024, height: 760, show: false, webPreferences: { offscreen: true, preload: pre, contextIsolation: false, sandbox: false } });
  await w.loadFile(path.join(SHELL, "renderer", "index.html"));
  await wait(1500);
  const js = (s) => w.webContents.executeJavaScript(s, true);
  const key = async (k) => { w.webContents.focus(); w.webContents.sendInputEvent({ type: "keyDown", keyCode: k }); w.webContents.sendInputEvent({ type: "keyUp", keyCode: k }); await wait(200); };
  const card = (sel) => js(`(() => { const el = ${sel}; if (!el) return null; const b = [...el.querySelectorAll(".fault-act button")].filter((x) => !x.hidden);
    return { text: el.querySelector(".fault-body > div").textContent, btns: b.map((x) => x.className + ":" + x.textContent), gap: getComputedStyle(el.querySelector(".fault-act")).columnGap, rowGap: getComputedStyle(el.querySelector(".fault-act")).rowGap, connected: el.isConnected }; })()`);
  const modal = () => js(`(() => ({ open: !$("lai-scrim").hidden, title: $("lai-title").textContent, lede: $("lai-lede").textContent,
    rows: [...$("lai-rows").children].map((r) => [r.dataset.kind, r.classList.contains("off") ? "off" : "", r.querySelector(".n").firstChild.textContent, (r.querySelector("small.msg") || {}).textContent || "", (r.querySelector(".cn-st") || {}).textContent || "",
      [...r.querySelectorAll("button")].map((b) => b.className + ":" + b.textContent + (b.disabled ? "(x)" : "")).join(",")].join("|")),
    foot: !$("lai-foot").hidden, active: document.activeElement && (document.activeElement.id || document.activeElement.textContent) }))()`);

  // A. 預檢卡(進工作頁就查到額度用完)→ 已登入的 Claude Code〔使用〕→ 卡換字、焦點回輸入框
  const pc = await card(`document.querySelector("#chat-scroll .msg.fault")`);
  ok("⑥ A 預檢卡:三顆照順序(實心綁卡、文字鈕本機、文字鈕加密);兩顆文字鈕同列 column-gap 16、行距 8", pc && JSON.stringify(pc.btns) === JSON.stringify(["btn-fill:前往綁卡", "btn-quiet:改用 Claude Code 或 Codex", "btn-quiet:用加密貨幣轉帳儲值"]) && pc.gap === "16px" && pc.rowGap === "8px", pc);
  await js(`document.querySelector("#chat-scroll .msg.fault .fault-act button:nth-child(2)").click()`); await wait(400);
  let m = await modal();
  ok("⑥ A 開 modal:標題「用你自己的 AI」、第一行誠實句;兩列(Claude Code〔使用〕實心、Codex 沒裝〔怎麼安裝〕);有一列不能用 → 腳有〔重新偵測〕",
    m.open && m.title === "用你自己的 AI" && m.lede === "走你自己的帳號，Blave 不收 AI 費用。" && JSON.stringify(m.rows) === JSON.stringify(["claude||Claude Code|||btn-fill:使用", "codex|off|Codex|||btn-quiet:怎麼安裝"]) && m.foot, m);
  ok("⑥ A 埋點:開框記 acct_local_open;沒有 acct_card_click", await js(`window.__log.includes("f:acct_local_open")`));
  ok("⑥ A 焦點進 modal(第一顆能按的鈕)", m.active === "使用", m.active);
  await js(`$("lai-rows").querySelector('[data-kind="codex"] button').click()`); await wait(100);
  ok("⑥ A〔怎麼安裝〕外開 Codex 官方頁、modal 留著", (await js(`window.__log.includes("o:https://developers.openai.com/codex/cli")`)) && (await modal()).open);
  await js(`$("lai-rows").querySelector('[data-kind="claude"] button').click()`); await wait(500);
  m = await modal(); const pc2 = await card(`document.querySelector("#chat-scroll .msg.fault")`);
  ok("⑥ A〔使用〕→ 換成 Claude Code、modal 關掉、記 acct_local_use", !m.open && (await js(`cur === "claude" && window.__log.includes("save:claude") && window.__log.includes("f:acct_local_use")`)), m);
  ok("⑥ A 預檢卡沒被拿掉,換成「已改用 Claude Code，可以開始了。」、沒有鈕;焦點回輸入框", pc2 && pc2.text === "已改用 Claude Code，可以開始了。" && pc2.btns.length === 0 && (await js(`document.activeElement === $("ta")`)), pc2);
  await js(`acctAt = 0; acctCheck()`); await wait(400);
  const pc3 = await card(`document.querySelector("#chat-scroll .msg.fault")`);
  ok("⑥ A 之後帳號重查(can_run 還是 false):卡不被畫回「額度用完」", pc3 && pc3.text === "已改用 Claude Code，可以開始了。", pc3);

  // B. 回合卡(切回 Blave AI、402)→ Codex 已裝沒登入〔登入〕→ 等瀏覽器 → 成功直接換過去 → 卡換成〔再送一次〕、焦點在它上面
  await js(`(async () => { window.__S.detectAgents = { claude: { installed: false }, codex: { installed: true, loggedIn: false, via: "cli", path: "/x/codex" } }; await window.blave.saveConnection({ kind: "blave" }); enterWorkspace("blave", {}); })()`); await wait(500);
  await js(`lastUserText = "hi"; detectAt = 0; addFault({ flow: "credit" })`); await wait(600);
  const tc = await card(`[...document.querySelectorAll("#chat-scroll .msg.fault")].pop()`);
  ok("⑥ B 回合卡:「額度用完」那組、〔再送一次〕讓位給〔改用 Claude Code 或 Codex〕", tc && JSON.stringify(tc.btns) === JSON.stringify(["btn-fill:前往綁卡", "btn-quiet:改用 Claude Code 或 Codex", "btn-quiet:用加密貨幣轉帳儲值"]), tc);
  await js(`[...document.querySelectorAll("#chat-scroll .msg.fault")].pop().querySelector(".fault-act button:nth-child(2)").click()`); await wait(500);
  m = await modal();
  ok("⑥ B 超過 15 秒沒偵測過 → 開框重偵測一次:Claude Code 沒裝、Codex〔登入〕", JSON.stringify(m.rows) === JSON.stringify(["claude|off|Claude Code|||btn-quiet:怎麼安裝", "codex||Codex|||btn-out:登入"]), m.rows);
  await key("Escape"); m = await modal();
  ok("⑥ B Esc 關掉、卡不變、焦點回卡上的〔改用 Claude Code 或 Codex〕", !m.open && (await js(`document.activeElement.textContent === "改用 Claude Code 或 Codex"`)) && (await card(`[...document.querySelectorAll("#chat-scroll .msg.fault")].pop()`)).btns.length === 3);
  await js(`document.activeElement.click()`); await wait(300);
  await js(`$("lai-rows").querySelector('[data-kind="codex"] button').click()`); await wait(1300);
  m = await modal();
  ok("⑥ B 等瀏覽器:那一列〔取消等待〕+「已在瀏覽器開啟登入頁」,另一列與〔重新偵測〕鎖住", (await js(`window.__log.includes("login:codex")`)) && m.rows[1] === "codex||Codex|已在瀏覽器開啟登入頁||btn-out:取消等待" && m.rows[0].endsWith("btn-quiet:怎麼安裝(x)") && (await js(`$("lai-redetect").disabled`)), m.rows);
  await js(`window.__S.detectAgents = { claude: { installed: false }, codex: { installed: true, loggedIn: true, via: "cli", path: "/x/codex" } }; window.__loginDone({ ok: true })`); await wait(700);
  m = await modal(); const tc2 = await card(`[...document.querySelectorAll("#chat-scroll .msg.fault")].pop()`);
  ok("⑥ B 登入成功直接換成 Codex、modal 關掉、記 codex_login_ok 與 acct_local_use", !m.open && (await js(`cur === "codex" && window.__log.includes("f:codex_login_ok") && window.__log.filter((x) => x === "f:acct_local_use").length === 2`)), m);
  ok("⑥ B 回合卡換成「已改用 Codex，可以再送了。」+〔再送一次〕(主鈕),焦點在〔再送一次〕", tc2 && tc2.text === "已改用 Codex，可以再送了。" && JSON.stringify(tc2.btns) === JSON.stringify(["btn-fill:再送一次"]) && (await js(`document.activeElement.textContent === "再送一次"`)), tc2);
  await js(`acctAt = 0; acctCheck()`); await wait(400);
  ok("⑥ B 換過去以後帳號重查:回合卡不被畫回「額度用完」", (await card(`[...document.querySelectorAll("#chat-scroll .msg.fault")].pop()`)).text === "已改用 Codex，可以再送了。");

  // C. 存連線失敗(CLI 剛被移掉):modal 留著、重偵測;登入中按 ✕ 會一起取消
  await js(`window.__S.detectAgents = { claude: { installed: true, loggedIn: true, path: "/x/claude" }, codex: { installed: true, loggedIn: false, via: "cli" } }; enterWorkspace("blave", {})`); await wait(500);
  await js(`detectAt = 0; addFault({ flow: "credit" })`); await wait(600);
  await js(`[...document.querySelectorAll("#chat-scroll .msg.fault")].pop().querySelector(".fault-act button:nth-child(2)").click()`); await wait(500);
  await js(`window.__S.saveConnection = false; $("lai-rows").querySelector('[data-kind="claude"] button').click()`); await wait(500);
  ok("⑥ C 存連線失敗:modal 留著、cur 不變、不記 acct_local_use", (await modal()).open && (await js(`cur === "blave" && window.__log.filter((x) => x === "f:acct_local_use").length === 2`)));
  await js(`window.__S.saveConnection = true; window.__log.length = 0; $("lai-rows").querySelector('[data-kind="codex"] button').click()`); await wait(1300);
  await js(`$("lai-close").click()`); await wait(400);
  ok("⑥ C 等瀏覽器時按 ✕:一起取消等待、modal 關掉、卡不變", !(await modal()).open && (await js(`window.__log.includes("cancel") && cur === "blave"`)) && (await card(`[...document.querySelectorAll("#chat-scroll .msg.fault")].pop()`)).btns.length === 3);

  // E. 回合進行中按〔使用〕:「先停下」確認框疊在這個框上面,Esc 先關確認框,框還在、工作頁仍鎖著
  await js(`window.__S.detectAgents = { claude: { installed: true, loggedIn: true, path: "/x/claude" }, codex: { installed: false } }; detectAt = 0; [...document.querySelectorAll("#chat-scroll .msg.fault")].pop().querySelector(".fault-act button:nth-child(2)").click()`); await wait(500);
  const hit = await js(`(() => { const r = $("lai-rows").querySelector('[data-kind="codex"] button'), b = r.getBoundingClientRect(), pb = getComputedStyle(r, "::before"); return { h: b.height, top: parseFloat(pb.top), bottom: parseFloat(pb.bottom) }; })()`);
  ok("⑥ E〔怎麼安裝〕熱區補到整列 44 高(視覺不動)", Math.abs(hit.h - hit.top - hit.bottom - 44) < 0.5, hit);
  await js(`running = true; $("lai-rows").querySelector('[data-kind="claude"] button').click()`); await wait(400);
  const top = await js(`(() => { const m = $("del-modal").getBoundingClientRect(), e = document.elementFromPoint(m.left + m.width / 2, m.top + m.height / 2);
    return { del: !$("del-scrim").hidden, lai: !$("lai-scrim").hidden, onTop: !!e && $("del-modal").contains(e), laiInert: $("lai-scrim").inert, title: $("del-title").textContent }; })()`);
  ok("⑥ E 回合中按〔使用〕:「先停下」確認框在最上層(畫面中點點得到它),底下這個框被鎖住", top.del && top.lai && top.onTop && top.laiInert, top);
  await key("Escape");
  const after = await js(`({ del: !$("del-scrim").hidden, lai: !$("lai-scrim").hidden, wsInert: $("view-ws").inert, laiInert: $("lai-scrim").inert, cur })`);
  ok("⑥ E Esc 關的是確認框:這個框還開著、工作頁仍鎖著、沒有換過去", !after.del && after.lai && after.wsInert && !after.laiInert && after.cur === "blave", after);
  await key("Escape"); await js(`running = false`);
  ok("⑥ E 再按一次 Esc 才關這個框", !(await modal()).open && !(await js(`$("view-ws").inert`)));

  // F. 這個框起的登入,完成的同一刻按 ✕:照樣換過去、照樣記 acct_local_use
  await js(`window.__S.detectAgents = { claude: { installed: false }, codex: { installed: true, loggedIn: false, via: "cli", path: "/x/codex" } }; enterWorkspace("blave", {})`); await wait(500);
  await js(`detectAt = 0; addFault({ flow: "credit" })`); await wait(600);
  await js(`[...document.querySelectorAll("#chat-scroll .msg.fault")].pop().querySelector(".fault-act button:nth-child(2)").click()`); await wait(500);
  await js(`window.__log.length = 0; $("lai-rows").querySelector('[data-kind="codex"] button').click()`); await wait(1200);
  await js(`window.__noCancel = true; laiClose(); window.__S.detectAgents = { claude: { installed: false }, codex: { installed: true, loggedIn: true, via: "cli", path: "/x/codex" } }; window.__loginDone({ ok: true })`); await wait(700);
  ok("⑥ F 登入剛完成就按 ✕:照樣換成 Codex、記 acct_local_use、焦點回輸入框", (await js(`cur === "codex" && window.__log.includes("f:acct_local_use") && document.activeElement === $("ta")`)), await js(`({ cur, log: window.__log })`));
  await js(`window.__noCancel = false`);

  // G. 設定裡起的登入還在等時開這個框,Esc 只關框、不取消那次登入
  await js(`window.__S.detectAgents = { claude: { installed: true, loggedIn: false, path: "/x/claude" }, codex: { installed: false } }; enterWorkspace("blave", {})`); await wait(500);
  await js(`detectAt = 0; addFault({ flow: "credit" })`); await wait(600);
  await js(`loginPending = "claude"; window.__log.length = 0; [...document.querySelectorAll("#chat-scroll .msg.fault")].pop().querySelector(".fault-act button:nth-child(2)").click()`); await wait(400);
  await key("Escape");
  ok("⑥ G 別處起的登入:Esc 關框、不送取消", !(await modal()).open && !(await js(`window.__log.includes("cancel")`)), await js(`window.__log`));
  await js(`loginPending = null`);

  // H. 別處正在偵測時開框:焦點先在 ✕,列畫出鈕以後移到第一顆能按的
  await js(`MDL.busy = true; [...document.querySelectorAll("#chat-scroll .msg.fault")].pop().querySelector(".fault-act button:nth-child(2)").click()`); await wait(300);
  const h1 = await js(`document.activeElement === $("lai-close")`);
  await js(`paintRows(lastDetect)`); await wait(200);
  ok("⑥ H 別處偵測中開框:先放 ✕,偵測完焦點移到第一顆能按的鈕", h1 && (await js(`document.activeElement === [...$("lai-rows").querySelectorAll("button")].find((x) => !x.disabled)`)), await js(`document.activeElement.id || document.activeElement.textContent`));
  await key("Escape");

  // D. 英文:鈕字照 Title Case、modal 的〔怎麼安裝〕sentence case
  await js(`(async () => { setLang("en"); applyStatic(); acctAt = 0; await acctCheck(); })()`); await wait(400);
  await js(`[...document.querySelectorAll("#chat-scroll .msg.fault")].pop().querySelector(".fault-act button:nth-child(2)").click()`); await wait(400);
  const en = await js(`({ card: [...[...document.querySelectorAll("#chat-scroll .msg.fault")].pop().querySelectorAll(".fault-act button")].filter((b) => !b.hidden).map((b) => b.textContent), lede: $("lai-lede").textContent, title: $("lai-title").textContent })`);
  ok("⑥ D en:卡上〔Use Claude Code or Codex〕、modal 標題與第一行換語言", en.card[1] === "Use Claude Code or Codex" && en.lede === "Runs on your own account. No AI charges from Blave." && en.title === "Use your own AI", en);
  await key("Escape");

  console.log(red ? `\n${red} 紅(Electron 段)` : "\nElectron 段 ALL PASS");
  eapp.exit(red ? 1 : 0);
});
}
