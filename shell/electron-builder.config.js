// 打包設定。兩種模式,全由環境變數決定——這個檔不寫任何憑證名、Key ID、Issuer、路徑:
//   npm run pack     沒設 BLAVE_MAC_IDENTITY → identity null:不找憑證、不簽、不翻 fuses(debug port 可用)。
//   npm run release  BLAVE_MAC_IDENTITY="<公司名 (TEAMID)>"(Developer ID Application 冒號後那段)
//                    + APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER(electron-builder 自己讀,公證用)。
//   npm run pack:win Windows x64(NSIS,per-user 裝到 %LOCALAPPDATA%\Programs\Blave)。mac 上要先 brew install --cask wine-stable
//                    (electron-builder 用 Wine 跑一次產生的 uninstaller);簽章與發佈在 Windows runner 上做(B 桶)。
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

/* 這次打包的目標平台看 CLI 旗標(--mac / --win / --linux 與短旗標);沒寫就是打包機自己的平台。
   mac 專用的守門(簽章 / 公證)只在 mac 是目標時才查——不然在 Windows runner 上打 win 包會被要求 Apple 憑證。
   純函式,tests/check_shell_build_config.js 從原文切出來跑。 */
function targets(argv, platform) {
  const has = (...f) => f.some((x) => argv.includes(x));
  const mac = has("--mac", "-m", "--macos"), win = has("--win", "-w", "--windows"), linux = has("--linux", "-l");
  if (!mac && !win && !linux) return { mac: platform === "darwin", win: platform === "win32" };
  return { mac, win };
}
const T = targets(process.argv, process.platform);

const IDENTITY = process.env.BLAVE_MAC_IDENTITY || null;
const RELEASE = process.env.BLAVE_RELEASE === "1";
if (T.mac && RELEASE && !IDENTITY) throw new Error("release 要設 BLAVE_MAC_IDENTITY");
// 反過來也擋:有簽章卻沒翻 fuses、沒 blaveRelease 的產物,外觀與 Gatekeeper 都跟正式版分不出來(稽核 S1)
if (T.mac && IDENTITY && !RELEASE) throw new Error("設了 BLAVE_MAC_IDENTITY 就要走 npm run release(BLAVE_RELEASE=1);不簽的 pack/dist 請先 unset");
// 自動更新的來源(放 latest-mac.yml / latest.yml 與 zip / Setup.exe 的那個網址目錄)。不寫死在 repo:沒設 = 這個包不會自動更新。
// release 必須有——發出去卻不會更新的版本,之後就修不到了。
const UPDATE_URL = process.env.BLAVE_UPDATE_URL || null;
if (UPDATE_URL && !/^https:\/\/[^\s]+$/.test(UPDATE_URL)) throw new Error("BLAVE_UPDATE_URL 要是 https:// 開頭的網址");
if (RELEASE && !UPDATE_URL && process.env.BLAVE_NO_AUTOUPDATE !== "1") throw new Error("release 要設 BLAVE_UPDATE_URL(刻意不帶自動更新:BLAVE_NO_AUTOUPDATE=1)");
const NOTARIZE = !!(process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER);
if (T.mac && RELEASE && !NOTARIZE && process.env.BLAVE_SKIP_NOTARIZE !== "1")
  throw new Error("release 要設 APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER(只簽不公證:BLAVE_SKIP_NOTARIZE=1)");
// Windows:publisherName 是憑證的 CN,electron-updater 拿它驗更新包的 Authenticode——它是 null 時 NsisUpdater 整個跳過驗章,
// 只剩 yml 的 sha512 + HTTPS。所以 release 一定要給;沒憑證的階段要明說。
const WIN_PUBLISHER = process.env.BLAVE_WIN_PUBLISHER || null;
if (T.win && RELEASE && !WIN_PUBLISHER && process.env.BLAVE_WIN_UNSIGNED !== "1")
  throw new Error("release(win)要設 BLAVE_WIN_PUBLISHER(簽章憑證的 CN;刻意不簽:BLAVE_WIN_UNSIGNED=1)");

const REPO = path.join(__dirname, "..");
// 隨包的官方檔案 = main.js 的 OFFICIAL_DIRS / OFFICIAL_FILES + runtime/ + allocators/。
// 只收 **git 追蹤中**的檔(內容取工作樹):repo 目錄同時是開發者自己的 workspace,
// manager/orders.jsonl、examples/**/stats.json、__pycache__ 這些 gitignored 的本機資料不能進包。
const SHIP = [
  "lib", "manager", "references", "examples", "runtime", "allocators",
  "strategies/TEMPLATE_A.py", "strategies/TEMPLATE_C.py", "AGENTS.md", "CLAUDE.md", "VERSION",
];
const tracked = execFileSync("git", ["-C", REPO, "ls-files", "-z", "--", ...SHIP], { maxBuffer: 1 << 24 })
  .toString().split("\0").filter((f) => f && fs.existsSync(path.join(REPO, f)));
const PY_FILTER = ["**/*", "!**/__pycache__{,/**}"];

module.exports = {
  appId: "org.blave.desktop",
  productName: "Blave",
  directories: { output: "dist" },
  asar: true,
  extraMetadata: RELEASE || UPDATE_URL ? { ...(RELEASE ? { blaveRelease: true } : {}), ...(UPDATE_URL ? { blaveUpdateUrl: UPDATE_URL } : {}) } : undefined,   // main.js 靠它認發佈版 / 更新來源
  publish: UPDATE_URL ? [{ provider: "generic", url: UPDATE_URL }] : null,   // 只為了產生 latest-mac.yml / latest.yml;上傳是手動的(--publish never)
  npmRebuild: false,
  files: ["main.js", "daemon.js", "telemetry.js", "updater.js", "cloud.js", "cloudcmd.js", "minversion.js", "traytext.js", "binance_link.js", "binance_check.js", "connstore.js", "datasrc.js", "mcpcode.js", "preload.js", "renderer/**/*", "assets/**/*", "package.json"],
  // 隨包 Python 依目標平台切(tools/fetch-python.sh 三顆都抓):平台區塊的 extraResources 會接在這份後面
  extraResources: [
    { from: "..", to: "agent", filter: tracked },
  ],
  mac: {
    category: "public.app-category.finance",
    // zip 是給自動更新吃的(macOS 的 electron-updater 只認 zip);dmg 是給人下載的。
    // universal:一個 dmg 同時給 Apple Silicon 與 Intel;electron-builder 先各打一份 x64 / arm64 再用 lipo 合併。
    // CLI 明寫 --mac <target> 時 arch 會被 CLI 蓋掉(預設 process.arch),所以 package.json 的 pack / dist 也帶 --universal
    target: [{ target: "dir", arch: ["universal"] }, { target: "dmg", arch: ["universal"] }, ...(UPDATE_URL ? [{ target: "zip", arch: ["universal"] }] : [])],
    // universal 包兩顆 Python 都隨包,main.js 啟動時照 process.arch 挑。
    // 兩個 arch 的中間包各自都收這兩顆:@electron/universal 要求兩邊檔案清單一致、非 Mach-O 檔逐 byte 相同
    extraResources: [
      { from: "vendor/python-arm64", to: "python-arm64", filter: PY_FILTER },
      { from: "vendor/python-x64", to: "python-x64", filter: PY_FILTER },
    ],
    // 合併時兩邊 SHA 相同的 Mach-O 一律要在這個 glob 裡(不然 @electron/universal 直接報錯):
    // 隨包 Python 兩顆各自單一架構、在兩個中間包裡是同一份檔,不能也不需要 lipo
    x64ArchFiles: "Contents/Resources/python-{arm64,x64}/**",
    icon: "build/icon.icns",
    // Electron 44 起不支援 macOS 12。明寫進 Info.plist(LSMinimumSystemVersion):舊系統在 Finder 就說開不了,不是開了才閃退
    minimumSystemVersion: "13.0",
    // 防回滾(稽核 M2):更新包的真偽靠 Squirrel 驗簽章,但「舊的合法簽章包 + yml 謊報新版號」簽章是過的。
    // 這個開關讓 Squirrel 真的比 CFBundleShortVersionString,比現在舊就不裝。代價:版號必須是嚴格的 A.B.C。
    extendInfo: { ElectronSquirrelPreventDowngrades: true },
    identity: IDENTITY,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.inherit.plist",
    // 隨包 Python 由 tools/sign-python.js 自己簽(它要另一份 entitlements)
    signIgnore: ["/Contents/Resources/python-(arm64|x64)/"],
    notarize: NOTARIZE,
  },
  // Windows x64 only(MVP;arm64 另案)。NSIS 而不是 MSI:electron-updater 只有 NSIS 的更新器。
  // Windows 的 python-build-standalone 沒有 bin/,python.exe 在根目錄——main.js 的 BUNDLED_PY 依平台切
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    // 預設是「Blave Setup 0.1.2.exe」(有空白):S3 key 與 mac 慣例(Blave-x.y.z.dmg)都不帶空白
    artifactName: "Blave-Setup-${version}.${ext}",
    icon: "build/icon.ico",
    ...(WIN_PUBLISHER ? { publisherName: WIN_PUBLISHER } : {}),
    extraResources: [{ from: "vendor/python-win-x64", to: "python-x64", filter: PY_FILTER }],
  },
  // oneClick + per-user:裝進 %LOCALAPPDATA%\Programs\Blave、不彈 UAC,自動更新(結束時 /S 靜默重裝)也不需要管理員
  nsis: { oneClick: true, perMachine: false },
  afterPack: "tools/sign-python.js",
  // fuses 只在 release 翻:翻了之後 --remote-debugging-port / --inspect / ELECTRON_RUN_AS_NODE 全失效,
  // 開發與自動化測試用的是沒翻的 pack 產物。
  electronFuses: RELEASE ? {
    runAsNode: false,
    enableNodeCliInspectArguments: false,
    enableNodeOptionsEnvironmentVariable: false,
    onlyLoadAppFromAsar: true,
    enableEmbeddedAsarIntegrityValidation: true,
    enableCookieEncryption: true,
  } : undefined,
  dmg: { sign: !!IDENTITY },
  // electron-builder 只公證 .app;.dmg 本身也要送 + staple,下載的人離線也驗得過。
  afterAllArtifactBuild: "tools/notarize-dmg.js",
};
