# shell/

- 改 `shell/`、`runtime/`,或在開發機上跑電腦版測試前,先讀 canon `.claude/docs/desktop-dev.md`(隔離的 `BLAVE_HOME`、`--use-mock-keychain`、只跑不開窗的測試);出貨前讀 `.claude/docs/blave-agent-update-channels.md`。
- repo 根目錄的 `CLAUDE.md` 與 `AGENTS.md` 會隨包送到用戶的 workspace(`electron-builder.config.js` 的 `SHIP`、`main.js` 的 `OFFICIAL_FILES`、`manager/update_workspace.py`),是產品的一部分。給開發者的指引不寫進那兩檔;改它們等於出貨,同一個 commit bump `VERSION`。
- `spawn`／`execFile` 遇到 EPERM 是同步 throw,不走 `error` 事件(Node 只有 EACCES／EAGAIN／EMFILE／ENFILE／ENOENT 走事件)。每個入口都包 `try`,在 `catch` 裡把該收的收掉(resolve、放掉 busy 旗標);寫法照 `main.js` 的 `run` 與 `daemon.js` 的 `start()`。

- 打包／開發版前裝依賴:用 `.nvmrc` 釘的 Node 精確版跑 `npm ci`;Electron 44.10 的下載腳本在 `npm ci` 後常沒跑(`node_modules/electron/path.txt` 不存在、`electron .` 報 failed to install correctly),在 `shell/` 下手動 `node node_modules/electron/install.js` 補上。
