<div align="center">

<img src="docs/icon.png" width="80" alt="">

# Blave Agent

**給 AI Agent 的量化工作台**<br>
用 Claude Code 或 Codex 寫策略、跑回測、上線自動交易。免費開源。

<a href="https://github.com/Blave-TW/blave-agent/releases"><img src="https://img.shields.io/github/v/release/Blave-TW/blave-agent?filter=desktop-*&label=latest&color=555" alt="最新版本"></a>

[English](README.md) | **繁體中文** | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [Español](README.es.md) | [Português](README.pt.md) | [Tiếng Việt](README.vi.md)

<a href="https://download.blave.org/desktop/mac/Blave-universal.dmg"><img src="docs/readme-dl-mac.zh-TW.png" alt="下載 Mac 版" width="173"></a>&nbsp;&nbsp; <a href="https://download.blave.org/desktop/win/Blave-Setup.exe"><img src="docs/readme-dl-win.zh-TW.png" alt="下載 Windows 版" width="173"></a>

</div>

https://github.com/user-attachments/assets/66c747e9-b068-4da9-a372-84d9afa7cb0d

<p align="center"><a href="https://blave.org/docs/zh">文件</a></p>

## 你會得到

- **所有策略在一個 app 裡。** 每支都有回測、成交、參數掃描、版本。
- **回測會抓過度最佳化。** MCPT p 值、參數高原、樣本外驗證。
- **預設算真實手續費。** 手續費填 0 會警告。
- **自動下單已經接好。** 幣安、OKX、Bybit、BingX、Gate.io，以及台指期（Windows）。
- **模擬交易。** 不用金鑰。
- **上網幫你找點子。** 讀幾個網站，帶回三個能回測的。
- **AI 自己選。** Claude Code、Codex、DeepSeek 金鑰或 Blave AI。

![app 裡的 BTC 突破策略](docs/readme-backtest.png)

<p align="center">⭐ 如果它幫你省下一個週末接 API，按個 Star。這能幫其他交易者找到它。</p>

<a id="quick-start"></a>

## 快速開始

1. 下載 [macOS](https://download.blave.org/desktop/mac/Blave-universal.dmg) 或 [Windows](https://download.blave.org/desktop/win/Blave-Setup.exe) 版並打開。
2. 選 AI。
3. 說出你的點子：

> 回測 BTCUSDT 4 小時線：SMA 20 上穿 SMA 60 做多，下穿就平倉。單邊手續費 0.05%。

<details><summary>平台說明</summary>

macOS 13 以上（通用版）或 Windows 10/11 x64。Windows 安裝檔還沒簽章：選「其他資訊 › 仍要執行」。

</details>

<details><summary>從原始碼建置</summary>

需要 Node.js 22.12 以上，且 `PATH` 上有 Python 3。

```
git clone https://github.com/Blave-TW/blave-agent.git
cd blave-agent/shell
npm install
npm start
```

Windows 在 PowerShell 裡改跑 `npm.cmd install` 與 `npm.cmd start`。

</details>

## 安全

- **只有你能配置資金與恢復交易。** agent 只能停。
- **每筆委託都跟交易所核對過**，記在 `state/audit.jsonl`。
- **回測只代表過去。** 交易可能賠光本金。

交易所與金鑰：[文件](https://blave.org/docs/zh/exchange_api) · 資料來源：[加密](https://blave.org/docs/zh/data_crypto)、[台股](https://blave.org/docs/zh/data_twstock)

## 雲端執行（付費）

關電腦策略也照跑，從網頁或 Telegram 跟它對話。[方案](https://blave.org/agent/zh)

## 更新

每一版的內容：[Releases](https://github.com/Blave-TW/blave-agent/releases)。按 Watch › Releases 收新版通知。

## 給開發者

<details><summary>檔案結構、測試、貢獻</summary>

先讀 `AGENTS.md`，再讀 `examples/README.md` 和 `references/lib.md`。`tests/` 一個契約一個檔。送 PR 前跑相關測試，並執行 `pre-commit install`。

</details>

## 授權

Apache-2.0。你寫的策略歸你。「Blave」是商標：fork 請改名。

Claude Code 與 Codex 是各自所有者的產品；Blave Agent 與它們沒有合作或背書關係。

## 程式碼簽章政策

Windows 版目前還沒有程式碼簽章：我們已向 [SignPath Foundation](https://signpath.org) 的開源專案計畫申請，核准前 Windows 安裝檔是未簽章的。核准後，Windows 版的程式碼簽章由 [SignPath.io](https://signpath.io) 免費提供，憑證屬於 SignPath Foundation。每個版本都由本 repo 的公開 GitHub Actions workflow 從打了 tag 的 commit 建置，每次簽章由 repo 擁有者核准。角色：作者與審查者＝有寫入權限的維護者；核准者＝repo 擁有者。除[隱私權政策](https://blave.org/disclaimer/zh/privacy_policy)所述外，本程式不會把任何資訊傳給第三方。macOS 版以 Blave 自己的 Apple 身分簽章與公證。

---

## 給維護者與既有機器

<details>
<summary>發版（runtime）與更新既有的工作區</summary>

### 發版（runtime）

```
cd blave-agent
export BLAVE_S3_KEY=... BLAVE_S3_SECRET=... BLAVE_S3_REGION=... BLAVE_S3_BUCKET=...
python publish.py            # dry-run，不需要憑證
python publish.py publish    # 真的上傳，機隊約 6 分鐘內吃到
```

發版前 bump `runtime/VERSION`，並把 `runtime/CHANGELOG.md` 的 Unreleased 搬到新版號下。打包時會從 `../api/blave_agent/systemd/` 取 `jobs.json` 宣告的 unit 檔，所以 **api 的 checkout 要跟這個 repo 並排**；不在的話會帶著完整路徑當場失敗。

`runtime/` 的歷史是 2026-09-18 從 api repo 以 subtree 合併過來的（165 則）。因為是合併不是改名，`git log -- runtime/` 只會看到那一則合併；要看完整歷史用 `git log HEAD^2`（檔案在那條線上是根目錄路徑，例如 `agent_turn.py`）。

新機器由開機腳本自動安裝，不需要手動步驟。

**凡是機器該吃到的改動，同一個 commit 就要 bump `VERSION`**（日期 `YYYY-MM-DD`，同一天重推加 `-b`／`-c`）——平台拿每台機器回報的 VERSION 跟這個 repo 的比，來點亮網頁上的「有更新」提示；沒 bump 的 push，用戶端完全看不到。

### 更新既有的工作區

這一節是操作契約：`references/updating.md` 會叫 agent 照英文版 README 的 "Updating an existing workspace" 一節做，電腦版複製的也是同一張檔案清單。**生效的是英文原文**，見 [README.md › Updating an existing workspace](README.md#updating-an-existing-workspace)；下面只是摘要，兩邊不一致時以英文版為準。

跟你的 agent 說：把 https://github.com/Blave-TW/blave-agent clone 到 `/tmp/oc-config` 當**參考**，逐檔比對。不做合併：跟 clone 不同的官方檔（clone 裡有同路徑的檔）先備份到 `.official-backup/<舊版號>-<UTC 時間>/`（保留相對路徑、舊備份不覆寫），再整檔換成 clone 的版本；本機那份若不等於該檔任何一個歷史官方版（在 `--filter=blob:none` 的 clone 上用 `git hash-object` 對 `git log --raw`），就是在這台被改過：先問用戶，用戶要留就不動、`VERSION` 不升；替換用暫存名再 `mv`；clone 裡沒有的檔一律不碰——

- `AGENTS.md`、`CLAUDE.md`、`strategies/TEMPLATE_A.py`、`strategies/TEMPLATE_C.py`、`manager/`、`examples/`、`allocators/`：整個換掉（只限 clone 裡有的檔）
- `references/`：不同的整檔換掉（先備份到 `.official-backup/`）；缺的複製進來
- `lib/`：補上本機缺的官方檔（`venue_errors.py` 一定要有）；不同的官方檔——回測鏈五個檔（`runner.py`、`param_scan.py`、`walk_forward.py`、`validation.py`、`analysis.py`）、`data.py`、官方下單／帳戶 lib 等——一律整檔覆蓋（先備份到 `.official-backup/`）、不合併。`lib/order_*.py`／`lib/account_*.py` 若參考 clone 裡**沒有**同名檔，那是用戶自己的交易所串接，**完全不碰**
- `VERSION`：原樣複製，永遠最後做，而且前面每一步都成功才做
- 做完刪掉 `/tmp/oc-config`

</details>
