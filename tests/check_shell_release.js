// shell/tools/release.js 的不變量:yml 之前的失敗不影響線上、帶版號的檔不覆寫、yml 之後的失敗不報成發版失敗、不自動動 git。
// 跑法:node tests/check_shell_release.js
const fs = require("fs"), path = require("path");
const { uploadPlan, publish, newer, semver, mayRelease, resolveTrack, lockDecision } = require("../shell/tools/release.js");
let red = 0; const t = (n, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) red++; };
(async () => {
  const plan = uploadPlan("0.4.0", "universal"), keys = plan.map((p) => p.key), iLive = plan.findIndex((p) => p.goLive);
  t("對外生效的只有一個點:latest-mac.yml;它之前全是帶版號的檔", plan.filter((p) => p.goLive).length === 1 && keys[iLive] === "desktop/mac/latest-mac.yml" && plan.slice(0, iLive).every((p) => p.versioned));
  t("下載頁的固定檔名 dmg 排在 yml 之後(前面中止 → 下載頁還是舊版)", plan.findIndex((p) => p.key === "desktop/mac/Blave-universal.dmg") > iLive);
  t("zip 排第一(換 yml 前拿它去正式網址比 sha512)", plan[0].key === "desktop/mac/Blave-0.4.0-universal-mac.zip");
  t("帶版號的檔長期快取;yml 與固定檔名的 dmg 不快取", plan.filter((p) => p.versioned).every((p) => /immutable/.test(p.cache)) && plan.filter((p) => !p.versioned).every((p) => p.cache === "no-cache"));
  t("全部落在 desktop/mac/ 底下(發版金鑰只該碰這裡)", keys.every((k) => k.startsWith("desktop/mac/")));
  t("版號比較:只收嚴格 A.B.C、要比現在大", newer("0.0.2", "0.0.1") && newer("0.1.0", "0.0.9") && newer("1.0.0", "0.9.9") && newer("0.0.10", "0.0.9") && !newer("0.0.1", "0.0.1") && !newer("0.0.1", "0.0.2")
    && semver("1.2").length === 0 && semver("1.2.3-beta.1").length === 0 && semver("v1.2.3").length === 0);
  // 「版號跟 code 同一個 commit」是 mayRelease + 工作樹乾淨(release.js)守的,不是 check_version_matrix_shell:同版號只在 HEAD 已 commit 時放行,而且不寫
  const MR = (v, c, h) => JSON.stringify(mayRelease(v, c, h));
  t("比現在大 → 放行、腳本自己寫版號(HEAD 是什麼都不管)", MR("0.0.6", "0.0.5", "0.0.5") === '{"bump":true}' && MR("0.0.6", "0.0.5", "0.0.4") === '{"bump":true}');
  t("同版號且 HEAD 的 package.json 已是這版 → 放行、不寫版號", MR("0.0.5", "0.0.5", "0.0.5") === '{"bump":false}');
  t("同版號但 HEAD 的 package.json 不是這版(改了沒 commit)→ 擋", !!mayRelease("0.0.5", "0.0.5", "0.0.4").error && !!mayRelease("0.0.5", "0.0.5", undefined).error);
  t("比現在小 → 擋,HEAD 是什麼都救不了", !!mayRelease("0.0.4", "0.0.5", "0.0.4").error && !!mayRelease("0.0.4", "0.0.5", "0.0.5").error);
  { const rel = fs.readFileSync(path.join(__dirname, "..", "shell", "tools", "release.js"), "utf8");
    t("接線:HEAD 的版號用 git show 讀;不 bump 時不跑 npm version、不還原", /"show", "HEAD:shell\/package\.json"/.test(rel) && /if \(gate\.bump\) execFileSync\("npm", \["version"/.test(rel)); }

  // 測試軌(BLAVE_RELEASE_PREFIX):整條發到另一個前綴,正式的 latest-mac.yml 一個 byte 都不碰
  const PROD = "https://download.blave.org/desktop/mac", J = JSON.stringify;
  t("沒設(或空字串)= 正式軌,跟以前一模一樣;自訂的 BLAVE_UPDATE_URL 照用", J(resolveTrack({})) === J({ prefix: "desktop/mac", url: PROD, test: false }) && J(resolveTrack({ BLAVE_RELEASE_PREFIX: "" })) === J(resolveTrack({}))
    && J(resolveTrack({ BLAVE_UPDATE_URL: "https://x.example/y" })) === J({ prefix: "desktop/mac", url: "https://x.example/y", test: false }) && J(uploadPlan("0.4.0", "universal", "desktop/mac")) === J(plan));
  const tt = resolveTrack({ BLAVE_RELEASE_PREFIX: "mac-test/" }), tplan = uploadPlan("0.4.0", "universal", tt.prefix);
  t("mac-test/ → 檔案全在 desktop/mac-test/、更新網址跟著指過去(https)、沒有任何 key 落在正式前綴", tt.test === true && tt.prefix === "desktop/mac-test" && tt.url === "https://download.blave.org/desktop/mac-test"
    && tplan.every((p) => p.key.startsWith("desktop/mac-test/")) && !tplan.some((p) => p.key.startsWith("desktop/mac/")) && tplan.length === plan.length);
  t("前綴只認 ^[a-z0-9-]+/$;不能是正式那一條", ["mac/", "mac-test", "/mac-test/", "a/b/", "../mac/", "Mac-test/", "mac test/", "mac-test//", ".", 5, null].every((v) => !!resolveTrack({ BLAVE_RELEASE_PREFIX: v }).error));
  t("同時設了對不上的 BLAVE_UPDATE_URL → 拒絕(不然檔案在測試軌、app 卻去正式軌找更新)", !!resolveTrack({ BLAVE_RELEASE_PREFIX: "mac-test/", BLAVE_UPDATE_URL: PROD }).error
    && resolveTrack({ BLAVE_RELEASE_PREFIX: "mac-test/", BLAVE_UPDATE_URL: PROD + "-test" }).test === true);
  { const rel = fs.readFileSync(path.join(__dirname, "..", "shell", "tools", "release.js"), "utf8");
    t("接線:打包讀到的更新網址 = 這條軌的網址;上傳計畫、清快取、演練輸出都用這條軌的前綴", /process\.env\.BLAVE_UPDATE_URL = track\.url;/.test(rel) && /uploadPlan\(version, arch, track\.prefix\)/.test(rel)
      && /`\/\$\{track\.prefix\}\/latest-mac\.yml`/.test(rel) && !/`\/\$\{PREFIX\}\/latest-mac\.yml`/.test(rel) && /演練模式:會上傳這些[^`]*\$\{track\.test \? "測試軌" : "正式軌"\}/.test(rel)); }

  // 上傳迴圈用假的 io 真的跑
  const mkio = (o = {}) => { const up = []; return { up, io: { say: () => {}, exists: async (k) => (o.existing || []).includes(k), upload: async (p) => { if ((o.failOn || []).includes(p.key)) throw new Error("boom"); up.push(p.key); },
    localSha512: () => "AAA", fetchSha512: async () => (o.remoteSha || "AAA") } }; };
  let x = mkio(); let r = await publish(plan, x.io);
  t("正常:照計畫順序全傳、live=true、沒有警告", x.up.join() === keys.join() && r.live === true && r.warnings.length === 0);
  x = mkio({ existing: ["desktop/mac/Blave-0.4.0-universal-mac.zip"] }); let err = null; try { await publish(plan, x.io); } catch (e) { err = e; }
  t("帶版號的檔已經在 bucket:整個拒絕、一個檔都沒傳(不覆寫 immutable 快取的檔)", !!err && x.up.length === 0);
  x = mkio({ remoteSha: "BBB" }); err = null; try { await publish(plan, x.io); } catch (e) { err = e; }
  t("正式網址上的 zip sha512 不符:yml 沒被上傳、下載頁的 dmg 也沒換", !!err && !x.up.includes("desktop/mac/latest-mac.yml") && !x.up.includes("desktop/mac/Blave-universal.dmg"));
  x = mkio({ failOn: ["desktop/mac/Blave-0.4.0-universal.dmg"] }); err = null; try { await publish(plan, x.io); } catch (e) { err = e; }
  t("yml 之前的上傳失敗:丟例外、yml 沒換", !!err && !x.up.includes("desktop/mac/latest-mac.yml"));
  x = mkio({ failOn: ["desktop/mac/Blave-universal.dmg"] }); r = await publish(plan, x.io);
  t("yml 之後的失敗:不丟例外、live=true、記成警告(不能報成發版失敗)", r.live === true && r.warnings.length === 1 && x.up.includes("desktop/mac/latest-mac.yml"));

  const src = fs.readFileSync(path.join(__dirname, "..", "shell", "tools", "release.js"), "utf8");
  const gitCalls = [...src.matchAll(/run\("git",\s*\[([^\]]*)\]/g)].map((m) => m[1]);
  t("git 只用來讀(status / rev-parse / show);沒有任何地方呼叫 commit / push / tag / add", gitCalls.length === 3 && gitCalls.every((a) => /"status"|"rev-parse"|"show"/.test(a)) && !/git["' ,]+(commit|push|tag|add)\b/.test(src) && !/execSync\(/.test(src));
  t("AWS 身分釘死:一律 --profile、清掉環境裡的金鑰、斷言是發版專用那一把", /\[\.\.\.args, "--profile", PROFILE\]/.test(src) && /AWS_\(ACCESS_KEY_ID\|SECRET_ACCESS_KEY/.test(src) && /user\\\/blave-desktop-release\$/.test(src));
  t("只在 arm64 打包機發(擋 Rosetta 下的 node);產物檔名一律 universal", /process\.arch !== "arm64"/.test(src) && /arch = "universal"/.test(src) && !/arch = process\.arch/.test(src));
  t("yml 換掉之前失敗會還原版號、之後絕不還原;Ctrl-C 也還原;沒寫過版號就不還原", /restore = \(\) => \{ if \(wentLive \|\| !gate\.bump\) return;/.test(src) && /\["SIGINT", 130\], \["SIGTERM", 143\]\]\) process\.on\(sig, \(\) => \{ restore\(\); process\.exit\(code\); \}\)/.test(src));

  // 鎖檔(2026-09-23 兩支 release.js 相撞、白做兩次公證):同一台打包機同時只准一支
  const LD = (e, alive) => JSON.stringify(lockDecision(e, () => alive));
  t("沒有鎖 → 直接拿", LD(null, true) === '{"take":true}' && LD(undefined, false) === '{"take":true}');
  t("鎖在、pid 活著 → 拒跑,訊息帶 pid / 版號 / 起跑時間", (() => { const d = lockDecision({ pid: 4242, version: "0.1.1", startedAt: "2026-09-24T01:02:03Z" }, (p) => p === 4242);
    return !!d.error && !d.take && /4242/.test(d.error) && /0\.1\.1/.test(d.error) && /2026-09-24T01:02:03Z/.test(d.error); })());
  t("殘留鎖(pid 死了、或鎖檔讀不出 pid)→ 接手並標 stale", LD({ pid: 4242, version: "0.1.1" }, false) === '{"take":true,"stale":true}' && LD({}, true) === '{"take":true,"stale":true}' && LD({ pid: "x" }, true) === '{"take":true,"stale":true}');
  { const body = src.slice(src.indexOf("async function main()")), at = (s) => body.indexOf(s);
    t("接線:main() 任何檢查之前先 takeLock(演練也上);O_EXCL 建檔、內容 pid+版號+時間;pid 活著用 kill(pid,0) 判(EPERM 也算活)",
      at("takeLock(version)") > 0 && [at("loadEnvFile()"), at("mayRelease(version"), at('"status", "--porcelain"'), at("process.arch !== ")].every((i) => i > at("takeLock(version)"))
      && /fs\.openSync\(LOCK, "wx"\)/.test(src) && /JSON\.stringify\(\{ pid: process\.pid, version, startedAt:/.test(src) && /process\.kill\(pid, 0\)/.test(src) && /e\.code === "EPERM"/.test(src)
      && /if \(d\.error\) die\(d\.error\)/.test(src) && /殘留鎖\(pid \$\{existing\.pid\} 已不在\),接手/.test(src));
    t("接線:每條出口都刪鎖——exit 事件(正常結束 / die / 沒接到的例外)、SIGINT、SIGTERM 都轉成 process.exit;只刪自己拿到的鎖;清 dist 時鎖要留著",
      /process\.on\("exit", releaseLock\)/.test(src) && /if \(!lockHeld\) return; lockHeld = false; try \{ fs\.unlinkSync\(LOCK\); \}/.test(src) && /lockHeld = true;/.test(src)
      && /const die = \(m\) => \{[^}]*process\.exit\(1\)/.test(src) && /main\(\)\.catch\(\(e\) => die\(/.test(src) && !/fs\.rmSync\(dist,/.test(src) && /!== LOCK\) fs\.rmSync\(path\.join\(dist, e\)/.test(src)); }
  t("線上讀不到 yml 就停,只有 --first-release 放行", /--first-release/.test(src) && /讀不到線上的 latest-mac\.yml/.test(src));
  t("驗 zip 解出來的那一份 app、dmg 的 staple、包裡的更新網址", /ditto/.test(src) && /stapler", "validate"/.test(src) && /asarPkg\.blaveUpdateUrl !== URL_BASE/.test(src));
  t("不寫死任何金鑰;憑證檔權限太寬會拒絕", !/AKIA[0-9A-Z]{16}/.test(src) && /mode & 0o077/.test(src));
  console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
})();
