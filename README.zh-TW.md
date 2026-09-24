<!-- TODO: logo 亮暗兩版——<picture> + prefers-color-scheme，寬 64–80px。repo 內目前沒有亮暗版 logo 檔（只有 shell/build/icon.icns）。 -->

# Blave Agent

**給你的 AI agent 用的量化工作台**

上線前，先看清楚是本事還是運氣。

在 Claude Code 或 Codex 裡用。下單不經過 LLM。macOS 測試版。

[English](README.md) | **繁體中文**

![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-lightgrey) ![Platform: macOS](https://img.shields.io/badge/platform-macOS-lightgrey)

<!-- TODO: 30s demo GIF (1600w, shown at 800w, dark, ≤8MB): one sentence → backtest with p-value → live -->

[下載 macOS 版](https://github.com/Blave-TW/blave-agent/releases/latest) · [快速開始（從原始碼）](#quick-start) · [在雲端 24 小時跑](https://blave.org/agent/zh)

覺得有用就按個 Star；想在新版發佈時收到通知，請按 Watch › Releases。

## 跟別的交易 agent 不一樣的地方

### 回測先檢查是不是運氣

- 每次 Type A 回測預設都會跑蒙地卡羅排列檢定（MCPT，`lib/validation.py`），記下 p 值：把資料打亂之後，能不能做出一樣好的成績？
- 參數掃描（`lib/param_scan.py`）找的是「一整片都有效」的參數平台，不是最高的那一格。
- 滾動式樣本外驗證（walk-forward，`lib/walk_forward.py`）量樣本外的表現。
- 手續費要符合真實市場。填 0 會被 `lib/quality_check.py` 標出來，並當成 bug 處理。
- 一個想法預設只回測一次。結果不好就照實回報，agent 不會偷偷調參數調到數字好看（見 [`AGENTS.md`](AGENTS.md) 的 *Iteration Brakes*）。

### 看得到實盤跑的是不是回測那份

回測會把策略定版。實盤跑的程式跟定版時不同，這支策略就會被標記——網頁工作頁顯示「上線中 · 檔案已改」，而不是乾淨的「上線中」。標記不會擋下執行。只適用有回測的策略類型（Type A 與 C），而且只限定過版的策略。

### 下單迴圈裡沒有 LLM

AI 負責研究與寫程式。排程跑的是確定性的程式，`manager/reconciler.py` 把帳戶對到目標部位。緊急停止開關（`state/HALT`）在下單函式庫那一層擋掉新曝險，平倉與停損照常放行。

<a id="quick-start"></a>

## 快速開始（從原始碼）

需要：

- macOS 13 以上。打包版是通用版：Apple Silicon 與 Intel 同一個安裝檔。
- Node.js 22.12 以上與 npm（`shell/package.json` › `engines`）
- `PATH` 上有 `python3`。打包版自帶 Python 3.12；從原始碼跑時，venv 用的是你系統的 `python3`。<!-- TODO: 從原始碼跑的 Python 最低版本（釘版的套件是在 3.12 上驗過的） -->
- 已安裝並登入的 Claude Code 或 Codex，或一個 Blave 帳號

```
git clone https://github.com/Blave-TW/blave-agent.git
cd blave-agent/shell
npm install
npm start
```

第一次開啟時，選 agent 用哪個 AI：

- **自己的 Claude Code 或 Codex。** 不需要 Blave 帳號，Blave 不收 AI 費用。app 只負責啟動 CLI，你的 Claude Code、Codex 登入憑證留在 CLI 自己手上。
- **Blave 的 AI。** 登入 Blave 帳號，按用量計費。

接著講你的想法，例如：

- 「回測 BTCUSDT 4 小時線：20 期 SMA 上穿 60 期 SMA 做多，跌回下方就空手。手續費單邊 0.05%。」
- 「用 BTC、ETH、SOL 做一個等權重的投資組合，每週再平衡，跑回測。」
- 「把這支策略的兩個 SMA 長度掃一遍，告訴我參數平台在哪。」

動手寫之前，agent 會先判斷想法屬於哪一型：

| 型別 | 是什麼 | 回測 |
|---|---|---|
| A | 單一標的、固定週期；一個部位（多／空／空手） | 必做 |
| C | 投資組合：N 個標的加一組權重（總和不超過 1），定期再平衡 | 必做 |
| B | 其餘全部：選股器、網格、套利、警示、一次性下單 | 不做 |

介面語言跟著系統語系（英文或繁體中文）。要強制指定：`BLAVE_LANG=zh npm start`。

## 最新消息

- **2026-09-24**——電腦版 0.1.1：第一個公開版，通用版（Apple Silicon 與 Intel），發在 GitHub Releases。台股日線與加密貨幣恐懼貪婪指數改走免費公開來源。
- **2026-09-23**——電腦版 0.0.4，簽章與公證完成，發在測試軌。
- **2026-09-21**——電腦版可以連接 Binance 真實帳戶，在你的 Mac 上下單。
- **2026-09-19**——改用 Apache-2.0 授權。

## 交易場所與資料

**有實測過下單函式庫的場所**（`lib/account_*.py` + `lib/order_*.py`，以真實帳戶驗證過）：

- Binance、BingX、OKX、Gate.io、Bybit——合約與現貨
- 群益期貨——台指期與台股現股；僅限 Windows 工作區（它的 API 是 Windows COM 元件，見 `references/capital-broker.md`）

怎麼連接交易場所，看 agent 跑在哪：

- **電腦版：** 在 app 的「自動下單 › 連接交易所」連 Binance、OKX、BingX、Gate.io、Bybit，會先向交易所查過金鑰。聊天裡貼金鑰會被拒絕，請改用「連接交易所」；貼過的內容會留在聊天紀錄裡，誤貼的金鑰請換一把。投資組合（Type C）策略暫不支援從電腦版自動下單。
- **雲端主機：** 在網頁工作頁的「自動下單」綁定；或在聊天裡貼 Binance、BingX、OKX、Gate.io、Bybit 的金鑰，agent 用 `lib.venue.bind` 綁上。

其他有 API 的交易所或券商，agent 可以照 `lib/account_TEMPLATE.py` 與 `lib/order_TEMPLATE.py` 現場寫一份；那份程式沒有經過 Blave 實測。

**模擬交易**不需要金鑰，內建 `lib/account_paper.py` + `lib/order_paper.py`，成交價取策略自己資料來源的最新收盤價（`lib/paper_data.py`）。

**資料。**

- 電腦版，不需帳號：加密貨幣 K 線走 Binance（USDT-M 永續、全部週期、回溯到上市日）與 BingX 公開端點；台股日線直接來自證交所與櫃買中心，還原權息用交易所自己的除權息表（上市 2010 年起、上櫃 1990 年代起）；加密貨幣恐懼貪婪指數來自 alternative.me（2018 年起）。Blave 指標、台股分線與籌碼資料、期貨、總經行事曆需要有資料權限的 Blave 帳號。
- 雲端主機：市場資料經 `lib/data.py` 來自 Blave API——加密貨幣 K 線與指標、台股、期貨。

## 安全與邊界

- **交易所金鑰放在哪，看你用哪個表面。** 電腦版：寫在你 Mac 上工作區的 `.env`（`~/Blave/workspace/.env`）。雲端主機：在你自己那台主機工作區的 `.env`。在網頁綁定：由 Blave 加密保存。agent 讀得到工作區的 `.env`，它的規則禁止印出金鑰的值（`references/exchange-connect.md`）。請用只能交易、關閉提領的金鑰。
- 投入金額與恢復交易由你自己做——電腦版在 app 的「自動下單」，雲端主機在網頁工作頁。就算你開口要求，agent 也會拒絕代勞。它唯一可以隨時自己做的，是觸發緊急停止。
- 電腦版只有在 Blave 開著時才會下單；結束 app 再打開後，交易維持暫停，直到你按「啟動下單」。
- agent 先驗證再回報：改完檔案會重讀確認，下完單會向交易所查回結果才說「已下單」。每一次下單嘗試都記在 `state/audit.jsonl`。
- 回測講的是過去，不預測、也不保證未來績效。MCPT 與參數掃描能降低「你看到的只是運氣」的機率，不能把它消掉。
- 這裡沒有任何內容是投資建議。交易可能虧損，包括虧光。

## 雲端（付費）

策略要 24 小時跑、關電腦也照跑，就用 Blave Agent 的雲端主機：同一個工作區，跑在一台專屬主機上。你從網頁工作頁或 Telegram 跟 agent 對話，想用 SSH 也可以。也可以把自己的 Claude Code、Codex 或其他支援 MCP 的 agent 接到那台主機：設定入口在網頁工作頁的「設定 › 連結」，說明見 [blave.org/docs/zh/connect](https://blave.org/docs/zh/connect)。方案與價格：[blave.org/agent/zh](https://blave.org/agent/zh)。

## 從原始碼跑：檔案放在哪

第一次連結時，app 會準備好 `~/Blave/`：

- `~/Blave/workspace/`——從這份 checkout 複製 `lib/`、`manager/`、`references/`、`examples/`、`allocators/`、兩支策略範本、`AGENTS.md`、`CLAUDE.md` 與 `VERSION`
- `~/Blave/venv/`——用 `python3 -m venv` 建立，再用 pip 裝 `claude-agent-sdk`、cryptography、pandas、numpy、matplotlib、pyarrow、requests、python-dotenv、scipy
- `~/Blave/state/`——對話紀錄、對話圖片與下單狀態

你的策略會在 `~/Blave/workspace/strategies/<name>/`。從原始碼執行時，官方檔案每次啟動都會重新複製一次，所以要改 `lib/` 請改 checkout 裡的那份，不要改 `~/Blave/workspace/` 裡的。你的策略、`.env` 與 state 不會被覆寫。

## 目錄一覽

| 路徑 | 裡面是什麼 |
|---|---|
| `AGENTS.md` | agent 的行為規則：先驗證再回報、迭代上限、資料來源、上線紅線。從這裡讀起。 |
| `lib/` | 共用函式庫：資料、回測、MCPT、參數掃描、樣本外驗證、報告、圖表、看盤板、交易所帳戶與下單（`account_*.py`、`order_*.py`）、緊急停止（`guard.py`） |
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

## 只想讀程式

1. [`AGENTS.md`](AGENTS.md)——agent 被要求怎麼做事
2. [`examples/README.md`](examples/README.md)——八支完整策略，各示範一種寫法
3. [`references/lib.md`](references/lib.md) 與 [`references/strategy-code.md`](references/strategy-code.md)——函式簽名與策略程式規則
4. [`strategies/TEMPLATE_A.py`](strategies/TEMPLATE_A.py) 與 [`strategies/TEMPLATE_C.py`](strategies/TEMPLATE_C.py)

`tests/` 裡每個檔的檔頭都寫了跑法，例如 `python tests/check_param_scan.py`、`node tests/check_shell_strings.js`。

## 貢獻

歡迎開 issue 與 pull request。送 PR 之前：

- 跑過 `tests/` 裡跟你的改動有關的檢查；
- 每個 clone 啟用一次金鑰掃描：`pip install pre-commit && pre-commit install`；
- 回測鏈的檔案（`lib/runner.py`、`param_scan.py`、`walk_forward.py`、`validation.py`、`analysis.py`）除非改動本身就是針對它們，否則不要動——網頁工作頁照契約讀它們輸出的檔案。

## 授權

**Apache-2.0**——見 [`LICENSE`](LICENSE) 與 [`NOTICE`](NOTICE)。可以自由使用、修改、散布，含商業用途；含專利授權。「Blave」與 Blave 標誌是商標：fork 請改名。

**你自己寫的策略是你的。** `strategies/` 底下你（或 agent 替你）寫出來的東西不屬於本專案，授權不及於它。

付費的部分不在這個 repo 裡：雲端主機、市場資料與 Blave 的 LLM proxy 都是 blave.org 的服務。這份程式碼可以免費在你自己的電腦上跑，接你自己的 AI 訂閱與你自己的資料來源。

Claude Code 與 Codex 是各自所有者的產品；Blave Agent 與它們沒有合作或背書關係。

## 連結

- 官網：[blave.org](https://blave.org) · Blave Agent：[blave.org/agent/zh](https://blave.org/agent/zh)
- 文件：[blave.org/docs/zh](https://blave.org/docs/zh)——[快速開始](https://blave.org/docs/zh/quickstart)、[MCPT](https://blave.org/docs/zh/mcpt)、[樣本外驗證](https://blave.org/docs/zh/walk_forward)、[避免過度擬合](https://blave.org/docs/zh/avoid_overfitting)
- 策略庫：[blave.org/agent/zh/library](https://blave.org/agent/zh/library)

---

## 給維護者與既有機器

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
