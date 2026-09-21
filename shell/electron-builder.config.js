// 打包設定。兩種模式,全由環境變數決定——這個檔不寫任何憑證名、Key ID、Issuer、路徑:
//   npm run pack     沒設 BLAVE_MAC_IDENTITY → identity null:不找憑證、不簽、不翻 fuses(debug port 可用)。
//   npm run release  BLAVE_MAC_IDENTITY="<公司名 (TEAMID)>"(Developer ID Application 冒號後那段)
//                    + APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER(electron-builder 自己讀,公證用)。
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const IDENTITY = process.env.BLAVE_MAC_IDENTITY || null;
const RELEASE = process.env.BLAVE_RELEASE === "1";
if (RELEASE && !IDENTITY) throw new Error("release 要設 BLAVE_MAC_IDENTITY");
// 反過來也擋:有簽章卻沒翻 fuses、沒 blaveRelease 的產物,外觀與 Gatekeeper 都跟正式版分不出來(稽核 S1)
if (IDENTITY && !RELEASE) throw new Error("設了 BLAVE_MAC_IDENTITY 就要走 npm run release(BLAVE_RELEASE=1);不簽的 pack/dist 請先 unset");
// 自動更新的來源(放 latest-mac.yml 與 zip 的那個網址目錄)。不寫死在 repo:沒設 = 這個包不會自動更新。
// release 必須有——發出去卻不會更新的版本,之後就修不到了。
const UPDATE_URL = process.env.BLAVE_UPDATE_URL || null;
if (UPDATE_URL && !/^https:\/\/[^\s]+$/.test(UPDATE_URL)) throw new Error("BLAVE_UPDATE_URL 要是 https:// 開頭的網址");
if (RELEASE && !UPDATE_URL && process.env.BLAVE_NO_AUTOUPDATE !== "1") throw new Error("release 要設 BLAVE_UPDATE_URL(刻意不帶自動更新:BLAVE_NO_AUTOUPDATE=1)");
const NOTARIZE = !!(process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER);
if (RELEASE && !NOTARIZE && process.env.BLAVE_SKIP_NOTARIZE !== "1")
  throw new Error("release 要設 APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER(只簽不公證:BLAVE_SKIP_NOTARIZE=1)");

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

module.exports = {
  appId: "org.blave.desktop",
  productName: "Blave",
  directories: { output: "dist" },
  asar: true,
  extraMetadata: RELEASE || UPDATE_URL ? { ...(RELEASE ? { blaveRelease: true } : {}), ...(UPDATE_URL ? { blaveUpdateUrl: UPDATE_URL } : {}) } : undefined,   // main.js 靠它認發佈版 / 更新來源
  publish: UPDATE_URL ? [{ provider: "generic", url: UPDATE_URL }] : null,   // 只為了產生 latest-mac.yml;上傳是手動的(--publish never)
  npmRebuild: false,
  files: ["main.js", "daemon.js", "telemetry.js", "updater.js", "cloud.js", "minversion.js", "traytext.js", "preload.js", "renderer/**/*", "assets/**/*", "package.json"],
  extraResources: [
    { from: "..", to: "agent", filter: tracked },
    { from: "vendor/python", to: "python", filter: ["**/*", "!**/__pycache__"] },
  ],
  mac: {
    category: "public.app-category.finance",
    // zip 是給自動更新吃的(macOS 的 electron-updater 只認 zip);dmg 是給人下載的
    target: [{ target: "dir", arch: [process.arch] }, { target: "dmg", arch: [process.arch] }, ...(UPDATE_URL ? [{ target: "zip", arch: [process.arch] }] : [])],
    icon: "build/icon.icns",
    // 防回滾(稽核 M2):更新包的真偽靠 Squirrel 驗簽章,但「舊的合法簽章包 + yml 謊報新版號」簽章是過的。
    // 這個開關讓 Squirrel 真的比 CFBundleShortVersionString,比現在舊就不裝。代價:版號必須是嚴格的 A.B.C。
    extendInfo: { ElectronSquirrelPreventDowngrades: true },
    identity: IDENTITY,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.inherit.plist",
    // 隨包 Python 由 tools/sign-python.js 自己簽(它要另一份 entitlements)
    signIgnore: ["/Contents/Resources/python/"],
    notarize: NOTARIZE,
  },
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
