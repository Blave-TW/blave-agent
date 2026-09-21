// 「連的是哪個 AI」不可由 agent 寫得到的檔案說了算(shell/connstore.js;稽核 S1)。
// 帳號 token 進不進 agent 的環境只看 kind === "blave":這支測的就是「agent 改檔拿不到這個 kind」。
// 跑法:node tests/check_shell_connstore.js
const fs = require("fs"), os = require("os"), path = require("path");
const { createConnStore, macEq, FILE, KEY_FILE } = require("../shell/connstore");
let red = 0; const t = (n, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) red++; };

// 假的 Keychain:XOR 一個 agent 不知道的位元組(重點只有「沒有它就解不開 / 包不出來」)
const seal = (on = true) => ({ available: () => on, encrypt: (s) => Buffer.from(Buffer.from(s, "utf8").map((b) => b ^ 0x5a)), decrypt: (b) => Buffer.from(Buffer.from(b).map((x) => x ^ 0x5a)).toString("utf8") });
const dirs = [];
const mk = (o = {}) => { const dir = o.dir || fs.mkdtempSync(path.join(os.tmpdir(), "blave-conn-")); if (!o.dir) dirs.push(dir); let tok = "tok" in o ? o.tok : "fpA";
  const store = createConnStore({ dir, seal: o.seal || seal(), tokenFp: () => tok, now: () => "2026-09-21T00:00:00.000Z" }); return { dir, store, setTok: (v) => { tok = v; }, reopen: (p = {}) => mk({ dir, tok, ...p }) }; };
const read = (dir) => JSON.parse(fs.readFileSync(path.join(dir, FILE), "utf8"));
const write = (dir, obj) => fs.writeFileSync(path.join(dir, FILE), JSON.stringify(obj));

{ const a = mk(); t("存 → 重開 app 讀得回來(不含 mac / token 指紋)", JSON.stringify(a.store.save({ kind: "claude", path: "/opt/homebrew/bin/claude", email: "a@b.c" })) === JSON.stringify(a.reopen().store.load())
    && Object.keys(a.reopen().store.load()).join() === "kind,path,email,at");
  t("檔案與金鑰檔都是 0600", (fs.statSync(path.join(a.dir, FILE)).mode & 0o777) === 0o600 && (fs.statSync(path.join(a.dir, KEY_FILE)).mode & 0o777) === 0o600); }

{ const a = mk(); a.store.save({ kind: "claude", path: "/usr/local/bin/claude" });
  const j = read(a.dir); write(a.dir, { ...j, kind: "blave", path: null });
  t("S1:agent 把 kind 改成 blave(沿用原本的 mac)→ 重開後不認,當成還沒連", a.reopen().store.load() === null);
  write(a.dir, { kind: "blave" });
  t("S1:整份換成舊版明文 {kind:blave} → 不認", a.reopen().store.load() === null);
  fs.unlinkSync(path.join(a.dir, KEY_FILE)); write(a.dir, { kind: "blave", at: "x" });
  t("S1:連金鑰檔一起刪掉、再寫明文 blave → 不認(明文只遷移自帶 CLI 的那兩種)", a.reopen().store.load() === null);
  write(a.dir, { kind: "blave", mac: "0".repeat(64), tok: "fpA" });
  t("S1:亂填一個 mac → 不認", a.reopen().store.load() === null); }

/* 稽核 R1 有兩半,各自一格(兩半互相遮蔽:合成一格的話單獨還原任一半都不會紅)
   ①「比 mac 之前先驗形狀」:timingSafeEqual 對長度不同的 Buffer 會拋——64 個非 ASCII 字元「字串長度」是對的、Buffer 長度不對 */
{ const good = "a".repeat(64), bads = ["é".repeat(64), "😀".repeat(32), "G".repeat(64), "0".repeat(63), "0".repeat(65), "", 5, null, undefined, {}, [], "A".repeat(64)];
  let threw = false, allFalse = true;
  for (const m of bads) { try { if (macEq(m, good) !== false) allFalse = false; } catch (_) { threw = true; } }
  t("R1-① macEq:壞形狀的 mac 一律回 false,而且不拋(只還原這一半:這一格會紅)", !threw && allFalse && macEq(good, good) === true && macEq(good, "b".repeat(64)) === false); }

/* ②「load() 整個包 try」:就算裡面有東西拋,也要當成沒連——不然 send-message 的 turnStarting 卡住、之後每次送出都回 busy。
   用一個 macEq 攔不到的拋法:紀錄是合法的 blave(mac 正確),但讀 token 指紋的時候拋 */
{ const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blave-conn-")); dirs.push(dir);
  createConnStore({ dir, seal: seal(), tokenFp: () => "fpA", now: () => "2026-09-21T00:00:00.000Z" }).save({ kind: "blave" });
  const boom = createConnStore({ dir, seal: seal(), tokenFp: () => { throw new Error("keychain"); }, now: () => "2026-09-21T00:00:00.000Z" });
  let threw = false, r = "x"; try { r = boom.load(); } catch (_) { threw = true; }
  t("R1-② load():裡面拋例外也不往外拋,當成沒連(只還原這一半:這一格會紅)", !threw && r === null); }

// 兩半合起來的實際情境:agent 把 mac 換成 64 個非 ASCII 字元
{ const a = mk(); a.store.save({ kind: "claude", path: "/usr/local/bin/claude" }); const j = read(a.dir);
  const bads = ["é".repeat(64), "😀".repeat(32), "G".repeat(64), "0".repeat(63), "0".repeat(65), "", 5, null, {}, []];
  t("壞 mac 各種形狀:重開 app 不拋、一律當成沒連", bads.every((m) => { write(a.dir, { ...j, mac: m }); let r, threw = false; try { r = a.reopen().store.load(); } catch (_) { threw = true; } return !threw && r === null; }));
  write(a.dir, j); t("原本的 mac 放回去 → 照樣讀得回來(形狀檢查沒有誤殺)", (a.reopen().store.load() || {}).kind === "claude"); }

{ const a = mk(); a.store.save({ kind: "claude", path: "/usr/local/bin/claude" });
  write(a.dir, { ...read(a.dir), kind: "blave", path: null });
  t("跑到一半改檔不生效:這個行程裡以記憶體為準", a.store.load().kind === "claude"); }

{ const a = mk({ tok: "fpA" }); a.store.save({ kind: "blave" });
  t("blave:同一顆 token 重開讀得回來", (a.reopen().store.load() || {}).kind === "blave");
  t("回放:紀錄是舊 token 那時存的,現在換了一顆 → 不認", a.reopen({ tok: "fpB" }).store.load() === null);
  t("回放:現在沒登入 → 不認", a.reopen({ tok: null }).store.load() === null);
  a.setTok("fpB"); a.store.reseal();
  t("重新登入(reseal)之後綁到新的這一顆", (a.reopen({ tok: "fpB" }).store.load() || {}).kind === "blave" && a.reopen({ tok: "fpA" }).store.load() === null);
  const b = mk(); b.store.save({ kind: "codex", path: "/x/codex" }); b.store.reseal();
  t("reseal 不碰自帶 CLI 的紀錄", read(b.dir).tok === null && b.reopen().store.load().kind === "codex"); }

{ const a = mk(); write(a.dir, { kind: "codex", path: "/Users/x/.local/bin/codex", email: null, at: "2026-09-01T00:00:00.000Z" });
  const got = a.store.load();
  t("舊版明文的自帶 CLI:認,而且一次補上 mac", got && got.kind === "codex" && typeof read(a.dir).mac === "string" && fs.existsSync(path.join(a.dir, KEY_FILE)));
  write(a.dir, { ...read(a.dir), path: "/tmp/evil" });
  t("補上之後再改 path → 不認(path 會被拿去 spawn)", a.reopen().store.load() === null); }

{ const a = mk(); const bad = [null, 1, "x", [], {}, { kind: "gpt" }, { kind: "claude" }, { kind: "claude", path: "claude" }, { kind: "claude", path: "/a\nb" }, { kind: "codex", path: "/" + "x".repeat(1100) }, { kind: ["blave"] }];
  t("存:kind 只認三個值、自帶 CLI 一定要絕對路徑、不收控制字元與超長", bad.every((c) => a.store.save(c) === null) && !fs.existsSync(path.join(a.dir, FILE)));
  t("blave 不帶 path(畫面多送也丟掉);email 壞值當沒有", JSON.stringify(a.store.save({ kind: "blave", path: "/evil", email: "a\u0000b" })) === JSON.stringify({ kind: "blave", path: null, email: null, at: "2026-09-21T00:00:00.000Z" })); }

{ const a = mk({ seal: seal(false) }); a.store.save({ kind: "claude", path: "/usr/bin/claude" });
  t("拿不到 Keychain:不落地(這個行程照用,重開要再選)", a.store.load().kind === "claude" && !fs.existsSync(path.join(a.dir, FILE)) && a.reopen({ seal: seal(false) }).store.load() === null); }

{ const a = mk(); a.store.save({ kind: "claude", path: "/usr/bin/claude" }); a.store.clear();
  t("clear:記憶體與檔案都清", a.store.load() === null && !fs.existsSync(path.join(a.dir, FILE)) && a.reopen().store.load() === null); }

// 接線(原文列舉):main.js 不再自己讀寫 connect.json;token 進環境的判斷吃的是 connStore 的 kind
{ const mainSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8"), main = mainSrc.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  t("main.js 沒有第二條讀寫 connect.json 的路", !/connect\.json/.test(main) && /const loadConnection = \(\) => connStore\(\)\.load\(\);/.test(main));
  t("save-connection:過 fromOurPage,path 用當下偵測到的、不用畫面送來的", /handle\("save-connection"/.test(main) && /agentPath = \(\(await detectAgents\(\)\)\[kind\] \|\| \{\}\)\.path \|\| null; if \(!agentPath\) return false;/.test(main) && !/save\(\{[^}]*choice\.path/.test(main));
  t("send-message:版本閘那一段拋例外也會還原 turnStarting(不然之後每次送出都回 busy)", /\} catch \(err\) \{ turnStarting = false; throw err; \}/.test(main));
  t("codex 的執行檔用當下偵測到的,不用連結紀錄裡的 path(舊明文檔遷移來的 path 是 agent 寫得到的字)", /const codexBin = conn\.kind === "codex" \? await codexBinNow\(\) : null;/.test(main) && /"--codex-bin", codexBin\]/.test(main) && !/"--codex-bin", conn\.path/.test(main));
  // 稽核 ①:連的是 Codex 卻偵測不到時,**不可以**靜默改跑 Claude(換一家供應商、換一條帳,而畫面還寫著 Codex)
  t("連的是 codex 但偵測不到 → 整輪失敗,不跑 Claude", /if \(conn\.kind === "codex" && !codexBin\) throw new Error\("AGENT_BIN_MISSING"\);/.test(main)
    && main.indexOf('throw new Error("AGENT_BIN_MISSING")') < main.indexOf('const useCodex = !!codexBin;')
    && main.indexOf('const useCodex = !!codexBin;') < main.indexOf('path.join(REPO, "runtime", "agent_turn.py")'));
  t("每一輪只解路徑、不跑 login status(detectAgents 一次開到四個子行程);連 Claude 的人一次都不開", /async function codexBinNow\(\) \{ return codexPath\(await loginShellPath\(\)\); \}/.test(mainSrc)
    && !/detectAgents\(\)/.test(mainSrc.slice(mainSrc.indexOf("async function runTurn("), mainSrc.indexOf('], { env, cwd: WS })'))));
  { const app = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "app.js"), "utf8");
    t("畫面把它講成人話,不丟代碼給用戶看", /AGENT_BIN_MISSING\/\.test\(r\.errTail \|\| ""\) \? t\("AGENT_BIN_MISSING"\)/.test(app)); }
  t("重新登入之後 reseal", /saveToken\(r\.body\.access_token\)[\s\S]{0,600}connStore\(\)\.reseal\(\);/.test(main));
  const unguarded = (main.match(/ipcMain\.handle\("([^"]+)",\s*(?:async\s*)?\(([^)]*)\)\s*=>\s*(\{?[^\n]*)/g) || []).filter((l) => !/fromOurPage\(e\)/.test(l) && !/ipcMain\.handle\(channel,/.test(l));
  // 直接用 ipcMain.handle 的只剩「拒絕時要回特定形狀」的那幾支,每一支第一行就要驗
  const direct = [...main.matchAll(/ipcMain\.handle\("([^"]+)"/g)].map((m) => m[1]);
  const firstLineGuard = direct.every((ch) => { const i = main.indexOf('ipcMain.handle("' + ch + '"'); return /fromOurPage\(e\)/.test(main.slice(i, i + 260)); });
  t("R3:每一支 IPC 都過 fromOurPage(handle() 預設就驗;直接註冊的自己驗)", firstLineGuard && /const handle = \(channel, fn, denied = null\) => ipcMain\.handle\(channel, \(e, \.\.\.a\) => \(fromOurPage\(e\) \? fn\(e, \.\.\.a\) : denied\)\);/.test(main)
    && direct.length <= 14 && (main.match(/\n  handle\("/g) || []).length >= 30); void unguarded; }

for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
