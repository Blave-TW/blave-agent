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
  extraMetadata: RELEASE ? { blaveRelease: true } : undefined,   // main.js 靠它認發佈版
  npmRebuild: false,
  files: ["main.js", "daemon.js", "preload.js", "renderer/**/*", "package.json"],
  extraResources: [
    { from: "..", to: "agent", filter: tracked },
    { from: "vendor/python", to: "python", filter: ["**/*", "!**/__pycache__"] },
  ],
  mac: {
    category: "public.app-category.finance",
    target: [{ target: "dir", arch: [process.arch] }, { target: "dmg", arch: [process.arch] }],
    icon: "build/icon.icns",
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
