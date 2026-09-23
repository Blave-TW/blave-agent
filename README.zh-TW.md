# Blave Agent

[English](README.md) | 繁體中文

**一個 quant agent workspace（給 AI agent 用的量化工作區）。** AI agent——Claude Code、Codex，或 Blave 自己的 AI——就在這個目錄裡工作；把交易想法做成「回測過、可以上線」的策略所需要的函式庫、規則與範本，都放在這裡。

你用白話講想法。agent 在這個工作區裡抓資料、寫策略、跑回測，檢查結果是不是運氣、換一組相近的參數還站不站得住，寫成報告；等你自己接上交易所之後，再照排程自動執行。

它是給「有交易想法，卻不想把時間耗在接 API、清資料、修 bot」的人用的。不用寫程式；想寫的話，這裡全是看得懂、改得動的 Python。

這個 repo 同時是兩樣東西：

- 每一台 Blave Agent 雲端主機（[blave.org](https://blave.org)）上的 workspace 與 runtime；
- Blave 電腦版（macOS，在 `shell/`）——同一個工作區，跑在你自己的電腦上。

## agent 在這裡做什麼

1. **想法。** 動手寫之前，agent 先判斷策略屬於哪一型（見下表）。
2. **資料。** 一律走 `lib/data.py`：加密貨幣 K 線與指標、台股與期貨、經濟行事曆。不手寫抓資料的腳本。
3. **策略。** 從 `strategies/TEMPLATE_A.py` 或 `strategies/TEMPLATE_C.py` 寫起，手續費要填符合真實市場的數字；手續費填 0 當成 bug 處理。
4. **回測。** `lib/runner.py` 執行，並在 `strategies/<name>/` 底下寫出 `stats.json` 與損益圖。預設一次請求只跑一次回測：結果不好就照實回報，agent 不會自己一直調參數重跑。
5. **檢驗。**
   - 蒙地卡羅排列檢定（MCPT，`lib/validation.py`）：每次 Type A 回測都會跑，並記下 p 值——把資料打亂之後，能不能做出一樣好的成績？
   - 參數掃描（`lib/param_scan.py`）：找的是「一整片都有效」的穩健區，不是最高的那一格。
   - 滾動式樣本外驗證（walk-forward，`lib/walk_forward.py`）：量樣本外的表現。
6. **報告。** `lib/report.py` 寫出結構化報告（KPI、圖、表、文字），之後隨時回頭看。
7. **上線。** 排程執行的是掛在系統排程器上的固定程式——執行迴圈裡沒有 LLM。`manager/reconciler.py` 把帳戶對到目標部位；緊急停止開關（`state/HALT`）在下單函式庫那一層擋掉所有新曝險，平倉與停損照常放行。

### 策略三型

| 型別 | 是什麼 | 回測 |
|---|---|---|
| A | 單一標的、固定週期；一個部位（多／空／空手） | 必做 |
| C | 投資組合：N 個標的加一組權重（總和不超過 1），定期再平衡 | 必做 |
| B | 其餘全部：選股器、網格、套利、警示、一次性下單 | 不做 |

### 目錄一覽

| 路徑 | 裡面是什麼 |
|---|---|
| `AGENTS.md` | agent 的行為規則：先驗證再回報、迭代上限、資料來源、上線紅線。從這裡讀起。 |
| `lib/` | 共用函式庫：資料、回測、MCPT、參數掃描、樣本外驗證、報告、圖表、看盤板、交易所帳戶與下單（`account_*.py`、`order_*.py`）、緊急停止（`guard.py`） |
| `strategies/` | 策略範本。你自己的策略也放這裡，已被 git 忽略。 |
| `examples/` | 完整的參考策略（加密貨幣、原油、台股、台指期）與匯出範本，見 [`examples/README.md`](examples/README.md) |
| `references/` | agent 動手前要讀的文件：函式簽名、策略程式規則、部署、券商串接、報告格式 |
| `manager/` | 部位管理、對帳（reconciler）、健康檢查、停止／平倉工具 |
| `allocators/` | 自訂組合權重算法的範本 |
| `runtime/` | 出貨到每一台雲端主機的 agent 迴圈、網頁與 Telegram 橋接、回報器、排程執行器 |
| `shell/` | 電腦版（Electron） |
| `tests/` | 小型檢查，一個檔管一條契約 |

## 三種用法

**雲端——[blave.org](https://blave.org/agent/zh) 的 Blave Agent。** 一台專屬主機裝著這個工作區；不管你有沒有在線上聊天，策略都繼續跑。你從網頁工作頁或 Telegram 跟 agent 對話，想用 SSH 也可以。方案與價格請看官網，這份 README 不寫。

**電腦版——本 repo 的 `shell/`。** agent 跑在你的 Mac 上，工作區在 `~/Blave/`。AI 由你選：

- 用你自己的 Claude Code 或 Codex（自己安裝、自己登入）——Blave 不收 AI 費用；或
- 用 Blave 的 AI——登入 Blave 帳號，按用量計費。

電腦版只負責啟動這些 CLI。你的 Claude Code、Codex 登入憑證留在 CLI 自己手上，app 不讀。

**自帶 agent。** 已經有雲端主機的話，可以把自己的 Claude Code、Codex 或其他支援 MCP 的 agent 接上去：agent 會拿到一張短效 SSH 憑證，在同一個工作區裡、照同一份 `AGENTS.md` 做事。設定入口在網頁工作頁的「設定 › 連結」，說明見 [blave.org/docs/zh/connect](https://blave.org/docs/zh/connect)。

Claude Code 與 Codex 是各自所有者的產品；Blave Agent 與它們沒有合作或背書關係。

## 快速開始

### 電腦版：從原始碼執行（macOS）

電腦版目前是 MVP：只支援 macOS，還沒有打包好的安裝檔，所以要從原始碼跑。

需要：

- macOS
- Node.js 與 npm（TODO: 待確認最低版本；app 釘的是 Electron 38.2.1）
- `PATH` 上有 `python3`（TODO: 待確認最低版本）
- 已安裝並登入的 Claude Code 或 Codex，或一個 Blave 帳號

```
git clone https://github.com/Blave-TW/blave-agent.git
cd blave-agent/shell
npm install
npm start
```

第一次連結時，app 會準備好 `~/Blave/`：

- `~/Blave/workspace/`——從這份 checkout 複製 `lib/`、`manager/`、`references/`、`examples/`、兩支策略範本、`AGENTS.md` 與 `VERSION`
- `~/Blave/venv/`——用 `python3 -m venv` 建立，再用 pip 裝 `claude-agent-sdk`、pandas、numpy、matplotlib、pyarrow、requests、python-dotenv、scipy
- `~/Blave/state/`——對話紀錄與圖片

你的策略會在 `~/Blave/workspace/strategies/<name>/`。從原始碼執行時，官方檔案每次啟動都會重新複製一次，所以要改 `lib/` 請改 checkout 裡的那份，不要改 `~/Blave/workspace/` 裡的。你的策略、`.env` 與 state 不會被覆寫。

介面語言跟著系統語系（英文或繁體中文）。要強制指定：`BLAVE_LANG=zh npm start`。

TODO: 電腦版能不能實盤下單，待確認。這份 README 講的上線流程是雲端主機的流程。

### 只想讀程式

1. [`AGENTS.md`](AGENTS.md)——agent 被要求怎麼做事
2. [`examples/README.md`](examples/README.md)——八支完整策略，各示範一種寫法
3. [`references/lib.md`](references/lib.md) 與 [`references/strategy-code.md`](references/strategy-code.md)——函式簽名與策略程式規則
4. [`strategies/TEMPLATE_A.py`](strategies/TEMPLATE_A.py) 與 [`strategies/TEMPLATE_C.py`](strategies/TEMPLATE_C.py)

`tests/` 裡每個檔的檔頭都寫了跑法，例如 `python tests/check_param_scan.py`、`node tests/check_shell_strings.js`。

## 資料與交易場所

**資料。**

- 雲端主機：市場資料經 `lib/data.py` 來自 Blave API——加密貨幣 K 線與指標、台股、期貨。憑證在工作區的 `.env`。
- 電腦版：加密貨幣 K 線走 Binance 公開端點，不需要帳號。Blave 的指標與台股資料需要有資料權限的 Blave 帳號。

**有實測過下單函式庫的場所**（`lib/account_*.py` + `lib/order_*.py`，以真實帳戶驗證過）：

- Binance、BingX、OKX、Gate.io、Bybit——合約與現貨
- 群益期貨——台指期與台股現股；僅限 Windows 工作區

其他有 API 的交易所或券商，agent 可以照 `lib/account_TEMPLATE.py` 與 `lib/order_TEMPLATE.py` 現場寫一份；那份程式沒有經過 Blave 實測。

**模擬交易**不需要金鑰，內建 `lib/account_paper.py` + `lib/order_paper.py`，成交價取自 Binance 公開報價。

## 安全，以及這不是什麼

- 交易所金鑰放在你自己機器上、工作區的 `.env` 裡，已被 git 忽略。請用只能交易、關閉提領的金鑰。
- 投入金額、綁定交易場所、恢復交易，這三件事由你自己在網頁上做。就算你開口要求，agent 也會拒絕代勞。它唯一可以隨時自己做的，是觸發緊急停止。
- agent 先驗證再回報：改完檔案會重讀確認，下完單會向交易所查回結果才說「已下單」。每一次下單嘗試都記在 `state/audit.jsonl`。
- 回測講的是過去，不預測、也不保證未來績效。MCPT 與參數掃描能降低「你看到的只是運氣」的機率，不能把它消掉。
- 這裡沒有任何內容是投資建議。交易可能虧損，包括虧光。

## 專案狀態

- 工作區版本：見 [`VERSION`](VERSION)（以日期為版號）。runtime 版本：`runtime/VERSION`，變更紀錄在 [`runtime/CHANGELOG.md`](runtime/CHANGELOG.md)。
- 雲端：正式營運中。電腦版：MVP，僅 macOS，從原始碼執行。
- 關於 `openclaw` 這個名字：那是這套系統早期框架的名字。設定檔（`openclaw.json`）、API 路徑（`/openclaw/...`）與 SSH 主機名沿用它，因為那些位置真的叫這個名字。`runtime/` 裡的 runtime 自 2026-07-25 起是自家寫的，與該產品無關。

## 貢獻

歡迎開 issue 與 pull request。送 PR 之前：

- 跑過 `tests/` 裡跟你的改動有關的檢查；
- 每個 clone 啟用一次金鑰掃描：`pip install pre-commit && pre-commit install`；
- 回測鏈的檔案（`lib/runner.py`、`param_scan.py`、`walk_forward.py`、`validation.py`、`analysis.py`）除非改動本身就是針對它們，否則不要動——網頁工作頁照契約讀它們輸出的檔案。

## 授權

**Apache-2.0**——見 [`LICENSE`](LICENSE) 與 [`NOTICE`](NOTICE)。可以自由使用、修改、散布，含商業用途；含專利授權。「Blave」與 Blave 標誌是商標：fork 請改名。

**你自己寫的策略是你的。** `strategies/` 底下你（或 agent 替你）寫出來的東西不屬於本專案，授權不及於它。

付費的部分不在這個 repo 裡：雲端主機、市場資料與 Blave 的 LLM proxy 都是 blave.org 的服務。這份程式碼可以免費在你自己的電腦上跑，接你自己的 AI 訂閱與你自己的資料來源。

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

- `AGENTS.md`、`CLAUDE.md`、`strategies/TEMPLATE_A.py`、`strategies/TEMPLATE_C.py`、`manager/`、`examples/`、`allocators/`：整個換掉(只限 clone 裡有的檔)
- `references/`：不同的整檔換掉（先備份到 `.official-backup/`）；缺的複製進來
- `lib/`：補上本機缺的官方檔（`venue_errors.py` 一定要有）；不同的官方檔——回測鏈五個檔（`runner.py`、`param_scan.py`、`walk_forward.py`、`validation.py`、`analysis.py`）、`data.py`、官方下單／帳戶 lib 等——一律整檔覆蓋（先備份到 `.official-backup/`）、不合併。`lib/order_*.py`／`lib/account_*.py` 若參考 clone 裡**沒有**同名檔，那是用戶自己的交易所串接，**完全不碰**
- `VERSION`：原樣複製，永遠最後做，而且前面每一步都成功才做
- 做完刪掉 `/tmp/oc-config`
