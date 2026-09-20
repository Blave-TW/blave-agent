// 打包設定。未簽章階段:identity null = 完全不找憑證、不簽。
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

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
  npmRebuild: false,
  files: ["main.js", "preload.js", "renderer/**/*", "package.json"],
  extraResources: [
    { from: "..", to: "agent", filter: tracked },
    { from: "vendor/python", to: "python", filter: ["**/*", "!**/__pycache__"] },
  ],
  mac: {
    category: "public.app-category.finance",
    target: [{ target: "dir", arch: [process.arch] }, { target: "dmg", arch: [process.arch] }],
    identity: null,
  },
  dmg: { sign: false },
};
