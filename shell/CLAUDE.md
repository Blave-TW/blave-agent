# shell/

- 打包／開發版前裝依賴:用 `.nvmrc` 釘的 Node 精確版跑 `npm ci`;Electron 44.10 的下載腳本在 `npm ci` 後常沒跑(`node_modules/electron/path.txt` 不存在、`electron .` 報 failed to install correctly),在 `shell/` 下手動 `node node_modules/electron/install.js` 補上。
