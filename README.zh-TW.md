# Blave Agent

## 給 AI Agent 的量化工作台

用 Claude Code 或 Codex 寫策略、跑回測、上線自動交易<br>
免費開源

[English](README.md) | **繁體中文** | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [Español](README.es.md) | [Português](README.pt.md) | [Tiếng Việt](README.vi.md)

![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-lightgrey) ![Platform: macOS | Windows](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey)

https://github.com/user-attachments/assets/66c747e9-b068-4da9-a372-84d9afa7cb0d

[下載 macOS 版](https://github.com/Blave-TW/blave-agent/releases/latest) · [下載 Windows 版](https://download.blave.org/desktop/win/Blave-Setup.exe) · [快速開始](#quick-start) · [關電腦也照跑](https://blave.org/agent/zh)

覺得有用就按個 Star；想在新版發佈時收到通知，請按 Watch › Releases。

## 跟別的交易 agent 不一樣的地方

Claude Code 或 Codex 寫得出交易 bot，難的是真的拿來跑。在終端機裡，每支策略都是一個資料夾的腳本加一段對話紀錄，策略一多就管不動；自己接自動下單，排程、交易所 API、部位對帳、重開機、金鑰都得自己處理。Blave Agent 補的就是這一段。

### 策略收在一個 app 裡，不是散落的腳本

![app 裡的 BTC 突破策略：回測、進出場紀錄、參數掃描、樣本外驗證、程式碼分頁，旁邊是 agent 的判讀](docs/readme-backtest.png)

各支策略都在側欄，點開就有回測、進出場紀錄、參數掃描、樣本外驗證、程式碼與歷史版本。舊版可以從版本清單還原，每支策略下多少金額在「策略組合」頁設定。

### 自動下單已經接好

- **連接交易所**：Binance、OKX、Bybit、BingX、Gate.io，Windows 上還有統一期貨。金鑰先拿去交易所驗過，有提領權限的直接拒絕（Gate.io 查不到這項，請自己確認）。
- **設好金額，按「啟動下單」**。app 照排程跑每支策略，把帳戶調到目標部位；每一次下單嘗試都記在 `state/audit.jsonl`。
- 「**暫停下單（不動部位）**」在選單列（Windows 是系統匣）。結束 app 再打開後，你沒按「啟動下單」之前不會下任何單。
- **模擬交易**不用金鑰。

### 回測先查過度擬合，手續費照實算

過度擬合，指參數只是剛好貼合過去的資料。

- **MCPT p 值**：每次 Type A 回測都跑（`lib/validation.py`）——把資料打亂後，能不能做出一樣好的成績？
- **參數掃描**找一整片有效的平台，不挑最高那格（`lib/param_scan.py`）；**walk-forward** 量樣本外表現（`lib/walk_forward.py`）。
- **手續費照實算**：填 0 會被警告（`lib/quality_check.py`）。
- **一個想法只回測一次**：結果不好照實回報，不偷偷調參數（見 [`AGENTS.md`](AGENTS.md) 的 *Iteration Brakes*）。

### 沒有靈感？它幫你上網找

![agent 在內建瀏覽器裡讀十幾個網站，找 BTC 與 ETH 的策略點子](docs/readme-browser.png)

按「上網找點子」，agent 會去讀十幾個網站，帶回 3 個可以回測的策略點子，每個都寫好進出場規則、附上來源網址。挑一個，它就幫你寫成策略、跑回測。它讀的每一頁都開在 app 內建的瀏覽器裡、就在你的畫面上；交易所帳戶後台與內網位址一律擋下。

<a id="quick-start"></a>

## 快速開始

下載 [macOS 版](https://github.com/Blave-TW/blave-agent/releases/latest)或[Windows 版](https://download.blave.org/desktop/win/Blave-Setup.exe)（macOS 13 以上，或 Windows 10／11 x64），打開就能用。

第一次開啟時，選 agent 用哪個 AI：

- **自己的 Claude Code 或 Codex。** 不需要 Blave 帳號，Blave 不收 AI 費用。
- **自己的 DeepSeek 金鑰。** DeepSeek 直接向你收費；金鑰留在這台電腦的鑰匙圈，agent 讀不到。
- **Blave AI。** 登入 Blave 帳號，按用量計費。

接著講你的想法：

- 「回測 BTCUSDT 4 小時線：20 期 SMA 上穿 60 期 SMA 做多，跌回下方就空手。手續費單邊 0.05%。」
- 「把這支策略的兩個 SMA 長度掃一遍，告訴我參數平台在哪。」

動手寫之前，agent 會先判斷想法屬於哪一型：

| 型別 | 是什麼 | 回測 |
|---|---|---|
| A | 單一標的、固定週期；一個部位（多／空／空手） | 必做 |
| C | 投資組合：N 個標的加一組權重（總和不超過 1），定期再平衡 | 必做 |
| B | 其餘全部：選股器、網格、套利、警示、一次性下單 | 不做 |

<details>
<summary>平台細節</summary>

- macOS 打包版是通用版（Apple Silicon 與 Intel）。Windows 為 Electron 44 支援的版本，ARM 版尚未測試。Windows 安裝檔還沒有程式碼簽章，第一次安裝時 SmartScreen 會跳警告：按「其他資訊」再按「仍要執行」。
- Node.js 版本見 `shell/package.json` › `engines`。打包版自帶 Python 3.12；從原始碼跑時，venv 用你系統的 Python（`python3`，Windows 是 `python`）。
- Codex 在 ChatGPT app 裡：Windows 裝 Microsoft Store 的「ChatGPT」（`winget install --id 9PLM9XGG6VKS -s msstore`），Mac 裝 ChatGPT.app。Windows 暫時不要用 npm 的 `@openai/codex` 0.161–0.162.1（沙盒壞掉）。
- 用自己的 Claude Code 或 Codex 時，app 只負責啟動 CLI，登入憑證留在 CLI 自己手上。DeepSeek 金鑰在 Windows 上加密儲存，請求由 app 在本機轉送。
- `npm.cmd`：PowerShell 的執行原則擋下 `npm` 指令碼時也能跑。
- 介面語言跟著系統語系（英文或繁體中文）。要強制指定：`BLAVE_LANG=zh npm start`（PowerShell：`$env:BLAVE_LANG="zh"; npm.cmd start`）。

</details>

### 從原始碼跑

需要 macOS 13 以上或 Windows 10／11（x64）、Node.js 22.12 以上、`PATH` 上有 Python 3，再加上其中之一：已登入的 Claude Code 或 Codex、一把 DeepSeek API 金鑰，或一個 Blave 帳號。

```
git clone https://github.com/Blave-TW/blave-agent.git
cd blave-agent/shell
npm install
npm start
```

Windows 在 PowerShell 裡改跑 `npm.cmd install` 與 `npm.cmd start`。

## 最新消息

每一版改了什麼，見 [Releases](https://github.com/Blave-TW/blave-agent/releases)；按 Watch › Releases 會收到新版通知。

## 交易場所與資料

**有實測過下單函式庫的場所**（`lib/account_*.py` + `lib/order_*.py`，以真實帳戶驗證過）：

- Binance、BingX、OKX、Gate.io、Bybit——合約與現貨
- 群益期貨——台指期（大台、小台、微台）；只限 Windows 雲端主機（它的 API 是 Windows COM 元件，見 `references/capital-broker.md`），電腦版連不了，Mac 或 Windows 電腦都一樣。在 app 內上傳憑證就能開通雲端主機上的群益，不需要遠端桌面。
- 統一期貨——台指期、小台、微台；只限 Windows，因為它的憑證工具只能在 Windows 10 以上執行（見 `references/president-broker.md`）。Windows 電腦版在 app 內上傳憑證、登入即可。Windows 雲端主機要在你自己的 Windows 電腦申請或匯出憑證，再到網頁工作頁的「自動下單」上傳、在那裡確認登入，不需要遠端桌面。

怎麼連接交易場所，看 agent 跑在哪：

- **電腦版：** 在 app 的「自動下單 › 連接交易所」連 Binance、OKX、BingX、Gate.io、Bybit，會先向交易所查過金鑰。聊天裡貼金鑰會被拒絕，請改用「連接交易所」；貼過的內容會留在聊天紀錄裡，誤貼的金鑰請換一把。Type C 策略（一支策略用權重向量同時持有多檔，不是替各支策略設定金額的「策略組合」頁）可以從電腦版自動下單；工作區的 lib 太舊、還不能下 Type C 時，它在「選擇策略」裡會鎖住，更新後就能用。以口數或股數計價的 Type C 不下單；Type C 不能接到統一期貨或群益期貨，替它存金額會被拒絕。
- **雲端主機：** 在網頁工作頁的「自動下單」綁定；或在聊天裡貼 Binance、BingX、OKX、Gate.io、Bybit 的金鑰，agent 用 `lib.venue.bind` 綁上。

其他有 API 的交易所或券商，agent 可以照 `lib/account_TEMPLATE.py` 與 `lib/order_TEMPLATE.py` 現場寫一份；那份程式沒有經過 Blave 實測。

**模擬交易**不需要金鑰，內建 `lib/account_paper.py` + `lib/order_paper.py`，成交價用市場上實際的最新價，不用還原價：加密取 Binance 最新成交、台指期取最新一分鐘、股票取未還原日收盤（`lib/paper_data.py`）。

**資料。**

- 電腦版，不需帳號：加密貨幣 K 線走 Binance（USDT-M 永續、全部週期、回溯到上市日）與 BingX 公開端點；台股日線直接來自證交所與櫃買中心，還原權息用交易所自己的除權息表（上市 2010 年起、上櫃 1990 年代起）；台指期日線來自期交所公開資料（1998 年起）；全市場三大法人買賣超來自證交所（外資 2004 年起）；美股與 ETF 日線（只能回測，不能自動下單）；加密貨幣恐懼貪婪指數（2018 年起）。Blave 指標、台股分線與個股籌碼資料、台指期分線與其他期貨資料、總經行事曆需要有資料權限的 Blave 帳號。
- 雲端主機：市場資料經 `lib/data.py` 來自 Blave API——加密貨幣 K 線與指標、台股、期貨。

## 安全與邊界

- **金鑰**：只給讀取＋交易，不給提領。有提領權限的金鑰在連結時會被拒絕（Binance、OKX、BingX、Bybit）；Gate.io 查不到這個旗標，請自己確認。金鑰放在你電腦工作區的 `.env`（`~/Blave/workspace/.env`，Windows 是 `%USERPROFILE%\Blave\workspace\.env`）或你自己雲端主機的工作區，在網頁綁定的由 Blave 加密保存。agent 讀得到 `.env`，規則禁止它印出金鑰的值（`references/exchange-connect.md`）。
- **投入金額與恢復交易由你自己做**，電腦版在「自動下單」，雲端主機在網頁工作頁。你開口要求 agent 也會拒絕；它唯一能自己做的是觸發緊急停止。
- **電腦版只有 Blave 開著時才會下單**。結束 app 再打開後，交易維持暫停，直到你按「啟動下單」。
- **先驗證再回報**：下完單會向交易所查回結果才說「已下單」，每一次下單嘗試都記在 `state/audit.jsonl`。
- 回測講的是過去。MCPT 與參數掃描只能降低回測騙到你的機率，不能消掉。這裡沒有任何內容是投資建議；交易可能虧損，包括虧光。

## 雲端（付費）

策略要關電腦也照跑，就用 Blave Agent 的雲端主機：同一個工作區跑在一台專屬主機上，可以從網頁工作頁或 Telegram 對話（也能 SSH）、排程報告，或接上你自己的 Claude Code、Codex 等 MCP agent（[說明](https://blave.org/docs/zh/connect)）。方案與價格：[blave.org/agent/zh](https://blave.org/agent/zh)。

## 只想讀程式

1. [`AGENTS.md`](AGENTS.md)——agent 被要求怎麼做事
2. [`examples/README.md`](examples/README.md)——八支完整策略，各示範一種寫法
3. [`references/lib.md`](references/lib.md) 與 [`references/strategy-code.md`](references/strategy-code.md)——函式簽名與策略程式規則
4. [`strategies/TEMPLATE_A.py`](strategies/TEMPLATE_A.py) 與 [`strategies/TEMPLATE_C.py`](strategies/TEMPLATE_C.py)

<details>
<summary>目錄一覽、從原始碼跑時檔案放在哪、測試</summary>

| 路徑 | 裡面是什麼 |
|---|---|
| `AGENTS.md` | agent 的行為規則：先驗證再回報、迭代上限、資料來源、上線紅線。從這裡讀起。 |
| `lib/` | 共用函式庫：資料、回測、MCPT、參數掃描、樣本外驗證、報告、圖表、交易所帳戶與下單（`account_*.py`、`order_*.py`）、緊急停止（`guard.py`） |
| `strategies/` | 策略範本。你自己的策略也放這裡，已被 git 忽略。 |
| `examples/` | 完整的參考策略（加密貨幣、原油、台股、台指期）與匯出範本，見 [`examples/README.md`](examples/README.md) |
| `references/` | agent 動手前要讀的文件：函式簽名、策略程式規則、部署、券商串接、報告格式 |
| `manager/` | 部位管理、對帳（reconciler）、健康檢查、停止／平倉工具 |
| `allocators/` | 自訂組合權重算法的範本 |
| `runtime/` | 出貨到每一台雲端主機的 agent 迴圈、網頁與 Telegram 橋接、回報器、排程執行器，以及電腦版的本機下單常駐程式 |
| `shell/` | 電腦版（Electron） |
| `tests/` | 小型檢查，一個檔管一條契約 |

版本：工作區看 [`VERSION`](VERSION)（以日期為版號）；runtime 看 `runtime/VERSION`，變更紀錄在 [`runtime/CHANGELOG.md`](runtime/CHANGELOG.md)；電腦版看 `shell/package.json`。

關於 `openclaw` 這個名字：那是這套系統早期框架的名字。設定檔（`openclaw.json`）、API 路徑（`/openclaw/...`）與 SSH 主機名沿用它，因為那些位置真的叫這個名字。`runtime/` 裡的 runtime 自 2026-07-25 起是自家寫的，與該產品無關。

### 從原始碼跑：檔案放在哪

第一次連結時，app 會準備好 `~/Blave/`（Windows 是 `%USERPROFILE%\Blave\`）：

- `~/Blave/workspace/`——從這份 checkout 複製 `lib/`、`manager/`、`references/`、`examples/`、`allocators/`、兩支策略範本、`AGENTS.md`、`CLAUDE.md` 與 `VERSION`
- `~/Blave/venv/`——用 `python3 -m venv`（Windows 是 `python -m venv`）建立，再用 pip 裝 `claude-agent-sdk`、cryptography、pandas、numpy、matplotlib、pyarrow、requests、python-dotenv、scipy
- `~/Blave/state/`——對話紀錄、對話圖片與下單狀態

你的策略會在 `~/Blave/workspace/strategies/<name>/`。從原始碼執行時，官方檔案每次啟動都會重新複製一次，所以要改 `lib/` 請改 checkout 裡的那份，不要改 `~/Blave/workspace/` 裡的。你的策略、`.env` 與 state 不會被覆寫。

### 測試

`tests/` 裡每個檔的檔頭都寫了跑法，例如 `python tests/check_param_scan.py`、`node tests/check_shell_strings.js`。

</details>

## 貢獻

歡迎開 issue 與 pull request。送 PR 之前：

- 跑過 `tests/` 裡跟你的改動有關的檢查；
- 每個 clone 啟用一次金鑰掃描：`pip install pre-commit && pre-commit install`；
- 回測鏈的檔案（`lib/runner.py`、`param_scan.py`、`walk_forward.py`、`validation.py`、`analysis.py`）除非改動本身就是針對它們，否則不要動——網頁工作頁照契約讀它們輸出的檔案。

## 程式碼簽章政策

Windows 版目前還沒有程式碼簽章：我們已向 [SignPath Foundation](https://signpath.org) 的開源專案計畫申請，核准前 Windows 安裝檔是未簽章的。核准後，Windows 版的程式碼簽章由 [SignPath.io](https://signpath.io) 免費提供，憑證屬於 SignPath Foundation。每個版本都由本 repo 的公開 GitHub Actions workflow 從打了 tag 的 commit 建置，每次簽章由 repo 擁有者核准。角色：作者與審查者＝有寫入權限的維護者；核准者＝repo 擁有者。除[隱私權政策](https://blave.org/disclaimer/zh/privacy_policy)所述外，本程式不會把任何資訊傳給第三方。macOS 版以 Blave 自己的 Apple 身分簽章與公證。

## 授權

**Apache-2.0**——見 [`LICENSE`](LICENSE) 與 [`NOTICE`](NOTICE)。可以自由使用、修改、散布，含商業用途；含專利授權。「Blave」與 Blave 標誌是商標：fork 請改名。

**你自己寫的策略是你的。** `strategies/` 底下的東西不屬於本專案，授權不及於它。付費的部分——雲端主機、市場資料與 Blave 的 LLM proxy——是 blave.org 的服務，不在這個 repo 裡。

Claude Code 與 Codex 是各自所有者的產品；Blave Agent 與它們沒有合作或背書關係。

## 連結

- 官網：[blave.org](https://blave.org) · Blave Agent：[blave.org/agent/zh](https://blave.org/agent/zh)
- 文件：[blave.org/docs/zh](https://blave.org/docs/zh)——[快速開始](https://blave.org/docs/zh/quickstart)、[MCPT](https://blave.org/docs/zh/mcpt)、[樣本外驗證](https://blave.org/docs/zh/walk_forward)、[避免過度擬合](https://blave.org/docs/zh/avoid_overfitting)
- 策略庫：[blave.org/agent/zh/library](https://blave.org/agent/zh/library)

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
