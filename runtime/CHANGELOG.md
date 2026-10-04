# Runtime changelog

Queued-for-release state lives HERE, not in anyone's memory: any commit that
changes `runtime/` adds a line under **Unreleased** in the same commit. At
publish time, bump `VERSION`, move the Unreleased lines under the new version
heading, and ship — the file sits next to `VERSION` so the publisher cannot
miss it. (Channel rules: `.claude/docs/blave-agent-update-channels.md`.)

## Unreleased

## 1.1.112 — 2026-10-04(desktop 0.1.14)

- **Windows 上 Codex 引擎的 shell 指令全被擋(`codex_engine.build_args`)**:codex 0.160 在 Windows、沒設定沙盒模式、workspace-write、approval=never 同時成立時,每一條 shell 指令都是 Forbidden(stderr `rejected: blocked by policy`,`core/src/exec_policy.rs`);選沙盒模式的 setup 只有 TUI 會跑,只用 `codex exec` 的用戶永遠碰不到。現在 Windows 上多帶 `-c windows.sandbox="unelevated"`(restricted token + ACL,不提權、不改系統設定);用戶 `config.toml`(`$CODEX_HOME` 或 `~/.codex`)已設 `windows.sandbox`,或舊鍵 `features.windows_sandbox`／`features.windows_sandbox_elevated`／`enable_experimental_windows_sandbox` 時不帶(`-c` 會蓋過設定,不把 elevated 的人降級);頂層 `profile = "x"` 指到的 `[profiles.x]` 底下設了同樣的鍵也算(稽核 P2-2),profile 名稱不存在或型別不對當作沒設;讀不了 config 照帶。macOS／Linux 的 argv 不變。測試機(codex 0.160.0,RDP session)實跑:帶旗標兩條指令 exit 0,拿掉旗標同一 prompt 被 policy 擋。測試 `tests/check_codex_engine.py` 4c 節。

- **Windows 電腦版的 Codex 回合每條 shell 指令仍被沙盒拒跑(`codex_engine.run`)**:電腦版給子行程 `TMPDIR=os.tmpdir()`,Windows 上那是 8.3 短檔名(`C:\Users\ADMINI~1\...`)。codex 0.160 unelevated 沙盒把權限設定的可寫根(`TMPDIR` 經 canonicalize 展開成長檔名)跟舊版投影(`TMPDIR` 原樣)逐字比對,不一致就整條拒跑:`windows unelevated restricted-token sandbox cannot enforce split writable root sets directly; refusing to run unsandboxed`(`sandboxing/src/windows.rs`),沙盒 log 連 START 都沒有。直接跑 `codex exec` 的環境沒有 `TMPDIR`,所以重現不出來。現在 Windows 上 spawn codex 前拔掉 `TMPDIR`(POSIX 慣例;Windows 沙盒自己會把 `TEMP`／`TMP` 設成可寫,`windows-sandbox-rs/src/allow.rs`)。macOS／Linux 不變。測試機(codex 0.160.0,session 2、無 console 父行程+`CREATE_NO_WINDOW`、照 `childEnv` 組的環境)實跑:短檔名 `TMPDIR` 重現拒跑;換長檔名即通過;修正後的 `run()` 讀檔與 `tempfile` 寫入都 exit 0。測試 `tests/check_codex_engine.py`。
- **外殼修正(desktop 0.1.14;不在 runtime/ 但同一批出貨,`shell/main.js`、`shell/renderer/app.js`、`suggest.js`、`index.html`、`telemetry.js`、i18n)**:Windows 偵測 npm 版 Codex(略過無副檔名 shim、補巢狀平台套件路徑;where.exe 固定 cwd、只收 PATH 內結果,不撿工作目錄裡的 codex.exe/claude.exe);Codex 型錄空時每輪收尾重讀,剛裝好的電腦模型選擇器會出現;安裝識別碼從 設定 › 隱私 搬到 設定 › 一般 › 關於;建議下一步加關閉 ×(× 或 Esc 收合、焦點回輸入框),`feature_used` 加 `suggest_closed`(api 白名單同批)。

## 1.1.111 — 2026-10-03(desktop 0.1.13)

- **外殼策略庫轉換 UI(desktop 0.1.13;spec-0.1.13-library-conversion §1–§8;不在 runtime/ 但同一批出貨,`shell/renderer/library.js`、`newstrategy.js`、`index.html`、`library.css`、`telemetry.js`、i18n)**:本機沒登入、或登入但付不出資料費(沒綁卡 / 餘額不足 / 查不到帳號狀態,含 `dataAccess` 為 null)時,清單分「現在就能用」與第二組(要先登入 / 綁卡後能用 / 儲值後能用 / 帳號狀態確認後能用),閘門卡掛在第二組標題下;沒登入時第一組只放官方 × 免費 × 不用 Blave 資料的策略(`libAnonOk`),已登入時第一組是 `blave_data = none` 的;有卡與雲端平鋪。詳情主鈕:免登入策略沒登入也是「用這支」(主行程走匿名 `/public_code`),其他沒登入只講登入;要資料(含未標)的登入後才講綁卡,鈕下第一句看資料需求、第二句看原因;分組中的免資料策略鈕下講「只用交易所公開價格」。`lib.gate.noCard` / `noBalance` / `unknown` 退役、清單頂端的 `#lib-gate` 拿掉。上網找點子:歡迎頁第二顆籤、策略庫頁首句尾、第一組空、市場空四個入口共用 `libIdeaOn`(這台電腦 × 內建瀏覽器開著 × 引擎跑得動),開同一個框(殼同新增策略框,市場三選一 + 方向選填 + 預覽 + 誠實句,Blave AI 才講費用)。頁首說明拿掉「官方策略免費…」那句。埋點:新事件 `lib_pick{data}`(本機「用這支」回合跑起來)、`idea_sent{from}`,`feature_used` 新名 `lib_installed`、`library_no_new`(api 白名單同批)。
- **電腦版資料卡只在真的撞到資料牆時出(0.1.13 策略庫轉換;spec §9 D1)**:`data_access_rule` 的 access=0 段改寫——事實句從「這台沒有 Blave 資料」改成「用到 Blave 資料的 `lib/data.py` 呼叫會停在 `DataAccessError`」;講缺資料、掛 `<blave-card:data-access/>` 只在這一輪真的撞到 `DataAccessError` 時,用戶開口要資料集但沒撞牆不出卡(先打,不憑事實段就說拿不到);台股單檔日線寫明「先走交易所 / FinMind,失敗才要 Blave」,不再說台股資料一律拿不到。只影響電腦版(BLAVE_DATA_ACCESS 只有外殼會設);雲端機 prompt 不變。
- **群益台指期單的成交回報晚到也照實記(`lib/order_capital.py`、`manager/reconciler.py`、`manager/flatten.py`;已隨 blave-agent VERSION 2026-10-03-e 出貨,這裡補記)**:8/17 實測成交回報 15–30 秒才到,單在 15 秒逾時就回 `sent`／0 口,self_ledger 帳本照 0 記、下一輪重複下單。現在看起來沒成交完或沒回報時再等最多 30 秒(`LATE_REPORT_S`)收晚到的回報,等待中 COM 出錯也把已確認的口數回傳(帶 `error`);等完仍未確認或只成交一部分 → 對帳器寫一筆下單失敗紀錄(平台轉成 P1 `order_error`:工作頁、TG、email),叫用戶到群益確認實際部位,照常繼續跑、不 HALT(Wei 拍板)。每張單最多多等 30 秒。全部出場等進行中的執行改成最多 90 秒(一張群益單最長 15＋30 秒,反手兩張共用同一個進行中標記)。測試 `tests/check_capital_late_fill.py`(新,虛擬時鐘跑真的 `_await_fill`)。
- **回合結束後的背景回測與假承諾回報(2026-10-03)**:`NO_LATER_TOOLS` 加 `ScheduleWakeup`／`PushNotification`／`RemoteTrigger`(claude 2.1.239、2.1.281 內名稱已核);新 PreToolUse Bash 守門 `_bg_guard_hooks`(**所有回合都掛,含雲端**——雲端 `KillMode=process` 同樣受害;語言/排程器兩道照舊只掛電腦版):`run_in_background` 一律拒絕;前景啟動回測/掃參(`strategies/…py`、含 `-X utf8`,`lib.runner|param_scan|walk_forward|validation`)而 `timeout` 低於 min(這一輪 Bash 上限, 這一輪還剩的時間)的拒絕(會被 CLI 轉背景、回合結束被殺,09-28 事故路徑);只放行 `nohup`／`setsid` 開頭、結尾單一 `&` 的脫離啟動。拒絕理由只給單一指令的 python `time.sleep` 輪詢(2.1.281 實測可用;開頭 `sleep N`≥25 會被 CLI 擋)。上限在呼叫當下讀 `options.env`(續跑會換小),剩餘時間用續跑判斷同一條式子。另:還原重跑的分類多認 `BatchIncomplete` 與 Type C 0 筆交易為 DATA(可再跑一次)。測試 `tests/check_bg_backtest_guard.py`(新)。**機隊掛載:發版前在 29026 跑一個真實回合，確認 hook 有觸發。**
- **runtime 寫檔不再跟著 agent 預先放好的 symlink 走(稽核 2026-10-02 N1 的 runtime 半,隨 desktop 0.1.13)**:原本 43 處「固定暫存檔名 `path + ".tmp"`(或 pid 檔名)寫好再 `os.replace`」,agent 能在 workspace / state 裡先把那個名字做成指向外面的 symlink,`open(tmp, "w")` 就把內容寫到 runtime 那個用戶寫得到的任何地方——其中 `.env`(`_cmd_credentials` / `_cmd_credentials_remove`:agent 寫得到的行加交易所 key)與 `report_uploader.log_error` 的檔尾改寫內容是 agent 控制的。新 `atomic_file.py`:`replacing(path)` 用隨機檔名 + `O_CREAT|O_EXCL` 建暫存檔(名字已被佔走就 `FileExistsError`,不寫)、寫完才 replace,只清自己建的暫存檔;權限預設同 `open()`,`.env` 建檔即 0600(`fchmod`),Windows 雲端的 ACL 走 `prepare`;`telegram_bridge` 沿用 `replace_retry`。`log_error` 的 append 改 `append_line`(`O_NOFOLLOW`)。`events.py` 被 `lib/events.py` 以檔案路徑載入(sys.path 沒有 runtime/),改在函式內才 import。沒換的 7 處(搬檔、log 輪替、symlink 建立、已經是隨機名的群益 vault)列在測試的審過清單。測試 `tests/check_runtime_atomic_file.py`(新:照 PoC 種 symlink 跑真的 `_cmd_credentials` / `log_error`;列舉 runtime/ 每個 `os.replace` / `os.rename`)。
- **同一類的 append 與 reports/ 底下的搬檔、刪檔(續上一條)**:append 寫入改走 `atomic_file.open_append` / `append_line` / `touch`(`O_NOFOLLOW`),包括 `state/audit.jsonl` 兩處、`state/execution/kick`、`state/flatten.log` 兩處、`state/reconciler.log` 兩處。`events.append` 自己 inline 同樣的 open,因為策略行程用檔案路徑載入它。`report_uploader` 的 `_retire`、`_prune_sent`、`_sweep_orphan_files`、`_clear_failed` 改走 `atomic_file.SafeDir`:從 workspace 一層一層用 `O_NOFOLLOW` 開目錄,之後只用那個 fd 操作。原本 agent 把 `reports/sent` 換成指向外面的 symlink,「只留最近 20 份」就會刪掉那個目錄裡其餘的檔;換 `reports/failed` 會刪掉外面同名的 `<id>.json`;搬檔則把 agent 取名的 `<id>.json` 放進外面的目錄。Windows 沒有 dir_fd,改成開目錄時檢查 realpath 必須在 workspace 底下(junction 不用權限就建得出來，檢查之後的競態不在保護範圍)。`report_runner.py` 檔頭說明改正。測試同一支擴充:列舉 append、`O_APPEND`,以及沒有 `O_EXCL` / `O_NOFOLLOW` 的 `O_CREAT`(鎖檔、`write_json_600` 列理由);刪檔與搬檔有 PoC,也模擬「打開之後才被換成 symlink」;強制走 Windows 分支再驗一次;Windows 換行比對與 `open()` 同 bytes。
- **workspace 裡的一般寫檔、殘留暫存檔(續上一條,code 稽核 audit-sec-runtime-tmp-013)**:直接 `open(path, "w"/"wb")` 寫 workspace 的地方改走 `atomic_file`,包括 `command_listener._beat`(電腦版每 5 秒一次,symlink 會把外面的檔截斷)、`order_errors.json`(內容來自 agent 寫得到的那份)、`report_jobs/<id>/` 的 `run.log`、`.lock`、`.degraded_alert`、升級提示檔、雲端附件 `tmp/inbound/<name>`;子行程即時寫的 log(`mgmt_backtest.log`、策略版本 `rerun.log`)改 `open_truncate`(截斷但不跟 symlink)。`BASE/state` 底下的寫檔不在電腦版 Codex 沙箱的可寫範圍內(可寫的只有 workspace 與暫存目錄),雲端 runtime 與 agent 又是同一個用戶,所以只列理由不換。崩潰留下的隨機名暫存檔:runtime 啟動時清一次(10 分鐘以上);`.env` 的暫存檔(裡面是明文 key)在 `_cmd_credentials` / `_cmd_credentials_remove` 的 .env 鎖裡另外清(60 秒以上,外殼的寫法也算)。`pending_status` 不把 runtime 自己的暫存檔算成「寫到一半的報告」。SafeDir:Windows 分支遇到不存在的目錄改丟 `FileNotFoundError`(之前每次上傳成功都會多印一行假錯誤);建目錄時另一個行程先建好也照樣打開。測試多一張一般寫檔的審過清單。
- **回測「交易次數」只算 |Δw| ≥ 0.00005 的權重變化(desktop 0.1.13 #9,`lib/analysis.count_trades`;`lib/runner.py` Type A／C、`lib/walk_forward.py` 樣本外與各輪)**:跟 `stats['trades']` 寫到小數 4 位的同一條,交易次數 = 進出場紀錄的筆數。量測:官方 #102(SOL Supertrend,波動率調倉)兩份本機回測 2156 vs 2095、2112 vs 2051,差的 61 筆全是四捨五入成 0 的微調,沒有 nan／價格 ≤ 0 被丟、沒有截斷。**對外數字會變**:同一份碼更新 lib 後重跑,交易次數變少(#102 這次 2168 → 2107),版本比較框的「交易次數」新舊兩版會差這一塊;已上架策略在策略庫的數字要重新上架才變;權重只有微調的策略會變成 0 筆並出 0 筆警告。**同一版也會對不上**:沒改碼重跑時不鑄新版(`_same_code_version`),版本紀錄存的 `trades` 還是舊定義,報告的 stats.json 是新定義,直到改碼產生新版。手續費照舊算全部 Δw;參數掃描與樣本外驗證挑參數時「完全沒動過」的排除規則不變(只改報出來的次數)。測試 `tests/check_trade_count.py`(新)。
- **拒單帶分類 token(desktop 0.1.13,spec-0.1.13-order-copy #14;`lib/reject_token.py` 新、各 `lib/order_*.py`、`lib/portfolio.py`)**:認得的拒單在錯誤字串最前面加 `[order_reject:<kind>]`(insufficient_margin / below_min_size / symbol_unavailable / key_permission / reduce_only_rejected / paper_margin),外殼與網頁只認這個 token 翻白話。代碼只收官方文件或實測過的:Binance -2019、-2010(訊息是 insufficient balance 那一種)、-2022、-4118;Bybit 110004/110007/110012/110045、110017;OKX 51008、51020;Gate.io BALANCE_NOT_ENOUGH;金鑰被拒一律用各家 `account_*._CREDENTIAL`;lib 自己擋的低於最小量、合約不存在/暫停、模擬帳戶現金不足/非 USDT 報價/台指期保證金。**沒分類(照原文顯示)**:BingX 的保證金與只減倉代碼、OKX 只減倉、Gate.io 其餘 label——查不到官方逐字;群益這版不分類。`_record_order_error` 把被呼叫端前綴推到後面的 token 移回最前面,200 字截斷後還在;TG／電腦版通知那一句拿掉 token。錯誤的型別與 `code` 屬性不變。workspace 只更新一半(`lib/reject_token.py` 沒落地)時各 order lib 退回不帶 token,下單照常。測試 `tests/check_reject_token.py`(新)。
- **外殼下單 UX(desktop 0.1.13,ux-order-1-4-5 §1/§2/§3 與 order-copy #8/#12/#14;`shell/renderer/trade.js`、`trade.css`、`app.css`、i18n、`shell/telemetry.js`)**:合計列下的倍數提醒三級(`LEV_T1/T2/T3` = 1/5/10;只在有未存改動時;合約列才講交易所槓桿要設幾倍、Binance L>5 接子帳戶 5 倍那句;真錢 ≥10 倍確認框要勾 `tr.lev.ack` 才能存;模擬帳戶 5 倍起 `tr.lev.lossPaper`);金額表加「訊號」欄、表頭「金額」、表下 `tr.amountFoot`;部位表同標的兩支以上有金額的策略出「N 支策略」拆解;解除暫停會平倉時鈕與原因行換「平倉並解除暫停」、確認框逐筆列出部位與讀到的時間,部位改用即時讀帳數(讀帳失敗/過期才退回快照);連接框第一段子帳戶建議;暫停框主鈕「暫停開新倉」;投資組合策略被鎖改講「要先更新」並在選擇策略框給更新出口(`tr.cloud.typeC` 退役);拒單六種白話句與部位表那一行「請 agent 查原因」(只填本機聊天框、不送出);群益口數單的「大台（TX2610）」改讀 `legs[].resolved_symbol`(lib 的 order leg 與全部出場的 leg 都帶上月份合約,orders.jsonl 的 symbol 仍是帳本 key);口數／金額格打到一半或打錯的原字跨報告重畫保留(設計稽核 B7),沒動過的舊小數口數點名 `tr.badLotsOld`。模擬帳戶 10 倍上限在外殼一起退役(smallfixes #5 / #13,配合 `lib/order_paper.py` 拿掉引擎上限):`TR_PAPER_MAX_LEV`、`trLevCheck`、`tr.levBlock` / `tr.levStillOver` / `tr.levOverShort` 與 `.over` 紅色拿掉,倍數一律墨色,超過 10 倍照樣可存;`tr.err.paperLev` 與它的解析留著給還沒更新 lib 的機器。稽核跟進:按「儲存」先把每一格重驗一次(不靠 blur);解除暫停的部位,即時讀帳失敗或過期、而且舊快照說空的 → 「可能」框,不判成不會平倉;self_ledger 帳本空但那一輪有下單 → 不知道;讀不到帳本換 `tr.relX2TitleN`/`tr.relX2BodyN`;確認框列出「改成 0」的策略(`tr.saveZeroed`);`tr.err.paperLev` 句尾改「請調低金額」;`tests/check_web_desktop_parity.js`(新)比對兩個表面的 LEV_T 與幣別對照表(BLAVE_WEB_DIR,找不到就紅)。埋點 `feature_used` 加 `trade_lev_ack`、`trade_net_open`、`trade_err_ask`(api 白名單同批)。
- **外殼小修(desktop 0.1.13 小修 spec;不在 runtime/ 但同一批出貨,`shell/renderer/trade.js`、`report-trades.js/.css`、`app.css`、`versions.js`、i18n)**:
  - 群益口數存檔確認框:那一列名目(口 × 點值 × 指數)超過 TWD 淨值 5 倍(`LEV_T2`,槓桿提醒 1／5／10 的第 2 級)、或沒有報價／淨值時大台 ≥ 50、小台 ≥ 200、微台 ≥ 1,000 口,那一列下面多一句提醒(`tr.txfBigNotional`／`tr.txfBigLots`,灰記號、不擋、不上紅,沒改的舊列也檢查)。
  - 口數格只收整數(可帶千分位,空白 = 0);小數、負數標紅並擋儲存(`tr.badLots`),不再把 2.9 截成 2。
  - 讀帳失敗時的帳戶幣:讀到的 → 那家的固定幣別(`CX_VENUES[].ccy`、模擬 USDT、群益 TWD;`tests/check_venue_ccy.py` 逐支對 `lib/account_*.py`)→ 自訂交易所查不到就不帶幣別、不出倍數,改講 `tr.ccyUnknown`。不再寫死退成 USDT。
  - en 口數單複數:1 口用 `tr.lotUnit`／`tr.txfConfirm1`／`tr.txfConfirmNoQuote1`／`tr.txfBigNotional1`(`trLotsKey`)。
  - 進出場紀錄窄框(清單 ≤ 560)每一列固定兩行:方向+數量+種類一行、價格與部位一行;各段不在內部斷行。
  - 隱私面板 `priv.collect.3` 改寫「作業系統與版本」(Windows 也是這一句)。
  - 群益商品名:下單紀錄與總覽事件寫「大台（TX2610）」(代碼等寬),交易所部位表的口數列寫商品名。

## 1.1.110 — 2026-10-03

- **SDK 鎖檔漏了平台專用的相依(1.1.109 canary 抓到:uid=1 Windows `sdk_sync` 被 `--require-hashes` 拒裝,`pywin32>=311` 沒釘)**:pip 的 `--platform`/`--python-version` 只挑 wheel,requirement 的環境標記仍用跑 pip 那台 Mac 判斷,所以 Mac 上產的鎖檔漏了 mcp 的 `pywin32; sys_platform == "win32"`(兩個 Windows 鎖檔),也漏了 anyio 的 `exceptiongroup; python_version < "3.11"`(Linux py3.10 鎖檔,下次換 pin 才會炸)。`publish.py lock` 改成:版本與 wheel 仍由 pip 挑,套件集合改以各平台自己的 PEP 508 標記(`TARGET_ENV`)重算閉包,pip 因主機標記漏掉的補成額外 root 再解,直到集合穩定;只用 pip 與它內附的 `packaging`,沒有新依賴。`publish` 前置檢查新增完整性:每個鎖檔都要等於「在該平台標記下、以 PyPI 上該版本 Requires-Dist 算出的閉包」(多、少、版本不符都擋;要網路,約 20 秒)。五個鎖檔重產:兩個 Windows 多 `pywin32==312`,Linux 多 `exceptiongroup==1.3.1`,Mac 兩份不變。Windows 上 pin 目錄的 pywin32:`sdk_pin.add_dir` 先以完整路徑載入 pin 目錄 `pywin32_system32` 的 DLL(venv 自己的 pywin32 開機時已登記它的 DLL 目錄,pywintypes 又是用檔名載入,不先載會混到兩個版本),自我驗證在 Windows 另 import `pywintypes`、`win32api` 並確認來自新裝的目錄。測試 `tests/check_sdk_pin.py` 5b 節。

## 1.1.109 — 2026-10-03

- **SDK 版本跟著 runtime 發版走**:新增 `runtime/SDK_VERSION`(0.2.159,唯一的 pin;provision 與電腦版 `AGENT_SDK` 對齊它,`tests/check_sdk_pin.py` 釘一致)與 `runtime/sdk-lock-<平台>.txt`(`python publish.py lock` 產生、跟 pin 一起 commit:整棵相依樹逐套件釘版本,附該版本每個 wheel 的 sha256;publish 缺檔或不是這個 pin 就拒絕,並隨 tarball 出貨)。新 release job `sdk_sync.py`(Linux `blave-agent-sdk.timer` 以 blaveagent 跑、每 30 分鐘;Windows `blave-agent-sdk` 排程)在 venv 版本低於 pin 時,用本機平台那份 lock 以 `--require-hashes` wheel-only 裝進 `$BASE/sdk/<pin>.tmp`(沒有對應平台的 lock 就不裝、記 error)→ 子行程照開輪的方式自我驗證(從 .tmp import claude_agent_sdk、mcp.server、mcp.shared.memory,建一個 in-process MCP server,`__version__` 等於 pin,實跑 `_bundled/claude --version` 等於 `__cli_version__`)→ rename → 寫 `.ready`。不降版(venv ≥ pin 不裝也不刪;比 venv 舊的 ready 目錄只把 `.ready` 改名退出輪替)、pip 前剩餘空間要 ≥ 1.5GB、同一 pin 連敗 6 次停 24 小時、pip 上限 700 秒(整輪落在 unit 的 1200 秒內)。只在成功安裝後才清到「目前+上一個」pin,有對話在跑就延到下一輪(判斷照抄 updater `turn_in_flight`),state 檔遺失或損壞時一律不清。`agent_turn` 改由 `sdk_pin.load()` 取 SDK:pin 目錄的 `.ready`(O_NONBLOCK + 一般檔才讀)等於 pin 且內建 CLI 在,才排到 runtime 目錄之後、venv 之前,並照 site.py 重播該目錄的 `.pth`(pip --target 不會跑;為 pywin32 這類套件,另把 `pywin32_system32` 加進 DLL 目錄);import 失敗就清掉那個目錄載入的模組、改用 venv、把 `.ready` 改名 `.bad`——下一輪 sync 記一次失敗並重裝。portfolio 回報新增 `sdk`(`pin`、`active`=pin/venv、`sdk`、`cli`,沒切過去時帶 `error`/`fails`/`skip`)。`publish.py` 新增 `publish --canary`/`promote`(promote 只在 canary 版號比正式新、且 tarball 的 sha256／大小對得上時才寫;api `_RELEASE_CANARY_UIDS` 先發)。**規矩:改 pin 的那一版不得包含必須用新 SDK 才跑得動的程式碼**——job 裝好之前那幾分鐘,新 runtime 會配舊 SDK。api 先上(canary 分流、systemd unit 檔在 api repo)。測試 `tests/check_sdk_pin.py`(`--net` 另驗 lock 解析)。
- **Blave AI 型錄升到 Sonnet 5.5／Opus 5.5／Fable 5.1**:看圖改用 `anthropic/claude-sonnet-5-5`(`model_prefs.VISION_MODEL`),切換模型提示的範例 id 跟著換,並註明 `/v1/models` 裡帶 `legacy: true` 的舊型號不要選。api 先上(proxy 型錄要先認得新 id),舊 id 照收不斷線。

## 1.1.108 — 2026-10-02(desktop 0.1.12)

- **Windows 對帳器在第一次載入 numpy 時永久卡死(0.1.12 Windows 真機 e2e)**:`local_daemon` 的父行程監看在 Windows 用一條執行緒對 stdin 做阻塞 `read(0)`,CRT 在整段等待期間握著 fd 0 的鎖;同一行程裡 numpy 的 OpenBLAS DLL 初始化(在 loader lock 底下)要拿同一把鎖 → 死結,直到 app 關掉 stdin。對帳器(`--run-reconciler`)與 daemon(`--secret-stdin`)都跑這條監看;模擬帳戶每次要價格(`paper_data` → 策略 `fetch_data` → `lib.data`)必中,所有交易所在同方向調整部位時的 drift band(`portfolio._daily_sigma` → `lib.data`)也會走到。現象:「補齊部位」後實際一直 0、約數分鐘後畫面說「下單停了，不是你按的」、再按啟動卡在「啟動中…」。修法:`_wait_parent_gone_nt` 的 stdin 監看改成 `PeekNamedPipe` 輪詢(每 0.2 秒,`PEEK_S`),只在有資料時才讀,寫端關掉(ERROR_BROKEN_PIPE)= 父行程關了 stdin;不是 pipe 的 stdin 退回原本的阻塞讀。POSIX 路徑(select + read)不變。測試 `tests/check_parent_watch_peek.py`(新;Windows 上真的開監看再 `import numpy`,舊讀法當對照會卡住)。

## 1.1.107 — 2026-10-02(desktop 0.1.12)

- **由 runtime 修掉沒更新 workspace 的機器上那份壞 K 線快取(雲端版本落後 D 案)**:api `/kline` 10-01 前會多回一根 end_date 隔天的殘缺 bar,舊 lib 把它併進 `cache/kline2_*` 不再重抓的過去月份;lib 換 kline3 只到得了有更新 workspace 的機器。新增 `kline_cache_heal.py`,`portfolio_reporter` 回報與 ack **之後**跑:不刪不改檔,只把受影響的過去月份檔 mtime 撥回該月月初(不跟 symlink),讓舊 lib 自己的 `_written_before_month_end` 補抓(merge keep='last',修好的 api 蓋掉那根)。檔案從不消失,進行中的自動下單那一輪不會讀不到檔。
  - **代價(照實)**:被標記的目錄下一次被讀到時,讀取範圍內所有被標的過去月份重抓一遍——實務上是 START 到上個月。單支 `fetch_kline` 是一段區間、每 365 天一個請求(3m 等 sub-5min 每 30 天);Type C 的 `fetch_kline_batch` 這些月份早於預抓窗,會掉到逐 symbol 的單支請求,約「symbol 數 × ⌈歷史天數/365⌉」。機器 key 的上限是 500 次／5 分鐘(api_plan_required,per key 與 per IP 各一桶):100 檔 × 3 年 ≈ 300 次在上限內;約 160 檔 × 3 年以上的日線組合可能在收盤那一輪撞 429,`_retry_get` 退避(2→64 秒)後仍會完成,但那一輪會晚幾分鐘。交易所端:api 對過去整月讀自己存的 data.binance.vision 月檔(不吃 Binance weight),只有近 45 天走 fapi,且這段 api 已經存著。
  - **節流**:每台先隨機等 0–6 小時(全機隊不在同一個 bar close 一起抓),之後每小時最多標 20 個目錄;快取很大的機器會分好幾個小時標完,快的週期因此分散在多個 bar close。日線以上的組合在下一次收盤仍可能一次重抓整個 universe(上面的估算)。
  - **範圍**:過去月份、在 min(FIX_TS 10-03 08:00 UTC, 開始修補的時刻)之前寫的、不是空月標記;1 分／5 分(1m、1min、5m、5min、5T 等寫法都算)那根是完整 base bar,只標近乎空的月份檔(批次冷抓把那根單獨寫成下個月的檔、被當成完整)。lib 已是 kline3、或是 2026-08-11 以前沒有補抓機制的 lib:記 `skipped`(`lib: kline3`／`pre_refetch`),不掃描。
  - **紀錄**:`state/kline2_heal.json`(`waiting`/`healing`/`done`/`partial`/`skipped`),以 `kline2_heal` 帶在 portfolio 回報裡(api 原樣存進 `agent:portfolio:{uid}`)。每一步先寫進狀態檔才動檔,狀態檔寫不進去就完全不修;有錯的那一輪整趟重來,最多 3 趟,重來時跳過開始修補後 lib 已補過的檔。
  - **出貨閘門**:api 的 /kline end_date 不含端點修正(origin 上是 c604255c,a737850f 的 cherry-pick)必須已在 prod、且上線早於 FIX_TS;否則舊 lib 會從還沒修的 api 把壞 bar 補回去、mtime 晚於月底而永久不再補。晚了就把 FIX_TS 改成「實際部署 + 1 天」再發。
  - 測試 `tests/check_kline_cache_heal.py`(用 lib 自己的 `_extend_cache_monthly` 端到端驗證壞 bar 被換掉;21 個突變全殺)。
- **外殼金額表的台指期列改成口數(desktop 0.1.12,查證報告 verify-order-ux-claims #1;不在 runtime/ 但同一批出貨,`shell/renderer/trade.js`、`trade.css`、i18n)**:標的是 TXF／MXF／TMF 的列(同 `command_listener._TXF_ASSET_SPECS`、網頁 `TXF_SPECS`,看標的不看綁哪家),金額格的單位固定「口」(不跟帳戶幣,讀帳失敗也一樣;窄寬不收)、數字鍵盤、aria 講口數、小數取整數部分(同網頁 parseInt,離開欄位回寫);標的欄寫商品名(微台／小台／大台)。合計與目標部位先換成參考金額(口 × 點值 × 指數,同網頁 `txfRefMoney`);報價跟網頁同一支(api `GET /studio/charts/twfutures/txf_summary?symbol=TXF`,匿名可讀):主行程 `txfQuote` 取、5 分鐘快取、失敗回上一份並 60 秒內不重問,經 preload `txfQuote`(IPC `txf-quote`)給畫面,只在雲端視角畫到口數列時才問;報價進金額表簽章,回來的值下一輪輪詢就畫上。口數換出來的參考金額(目標部位、合計、確認框)固定標 TWD、不經帳戶幣(讀帳失敗時不會把台幣標成 USDT;設計稽核第二輪 R2-S2),表下「金額單位」那一行只要有一格畫成錢就出(R2-S1)。合計與確認框合計同網頁 `pfRefTotal`:有錢的口數列 → 合計標 TWD;口數列與一般列都有錢、帳戶幣又不是 TWD → 不把兩種幣相加,畫「—」;倍數只在合計幣別 = 帳戶幣時才出。問不到(離線、api 錯)照網頁退回「—」、不出倍數(原本口數當錢加總除以 TWD 淨值,顯示約 0.00x)。口數列不掛最小進場額;確認框列「N 口商品」。同一個口數在別頁也照口畫:下單紀錄與總覽事件的口數單(asset_spec 是 futures_contracts 或交易所是群益,同網頁 lotBased)寫「N 口」、窄寬不收,下單紀錄的 title 改掛名目市值(口 × 成交點 × 點值 TWD,`tr.orderNotional`;點值單上優先、舊列照群益解析代碼查);策略版本守門框的金額是口數時改用 `ver.guardLeadLots`(zh「{lots} 口在跑」,設計稽核 S1),剛好 1 口時用 `ver.guardLeadLot1`(en「{lots} lot」,同網頁 `workspace_ver_guard_lead_lot1`);交易所部位表的口數列(`trIsLot` 或代號是 TXF／MXF／TMF)目標、實際、差額與「不歸 Blave 管」都寫「±N 口」(`trLotsInto`,同網頁 paintVenueLots;設計稽核 B1),窄寬不收「口」;表下「金額單位」那一行在全是口數列/口數單時不出。字串沿用網頁譯法(`tr.lotsUnit`、`tr.lotsAria`、`tr.txfConfirm`、`tr.txfConfirmNoQuote`、`tr.txfProd.*`、`tr.orderNotional`)。對帳器與下單 lib 不動。
- **外殼部位表的策略名可點(desktop 0.1.12,spec-0.1.12-pf-strategy-link;不在 runtime/ 但同一批出貨,`shell/renderer/trade.js`、`trade.css`、`shell/telemetry.js`)**:自動下單「部位」金額表的策略名在清單上有那支時是 `<button class="pf-strat">`(canon「表格代號連結」:hover 底線＋換 ink-2、熱區撐滿整格、`.sub-sym[title]` 蓋在熱區上),點了開那支的「進出場紀錄」;Type C 落「回測數據」,沒有回測由 `rpTab` 退「程式碼」、時光機由 `verShowTab` 接手;分頁在 `stratSelect`／`rpCloudSelect` 之前就定。不在清單 → 照舊純文字;畫的時候在、點下去那刻不在(本機 `TR.list`,雲端清單 code OK 且沒有)→ 原地換成文字、唸 `res.gone.strat`、不換頁;本機清單說在、`stratSelect` 卻讀不到 → 回「部位」並唸同一句(設計稽核 C2)。輪詢重畫部位分頁時,鍵盤焦點在策略名或表外的鈕(選擇策略、還原、儲存、區段標題的說明鈕)上 → 重建後還給同一顆(策略名認 `data-name`、其他認 `data-fk`);那一顆沒了、停用或在收起的儲存列裡就給 `#tr-tab-pos`(設計稽核 S1,同網頁表外鈕那一案)。`.pf-scroll` 四邊留 4px 給 focus 框(負 margin 抵銷,760 上限跟著加 8)。返回照舊走側欄「自動下單」、回到「部位」。埋點 `feature_used` 新增 `trade_strat_open`(本機確定打開才送、雲端照開就送;api 白名單同批)。沒有新字串。
- **偷看未來檢查不再誤判美國／台灣假日(desktop 0.1.12,`lib/runner.py`、`lib/data.py`)**:外部日資料(美股、台股籌碼)用 `align_feed` 接到 24/7 的 K 棒上時,假日那天永遠不會有資料列——完整回測裡那幾根是中段 NaN(沿用部位),截斷重跑時卻被 `align_feed` 當成「該到未到」從尾端切掉,檢查拿 NaN 去比、判成偷看未來而拒絕回測(實測:BTC + SPY 濾網,截在 2023-04-09 Good Friday 後)。現在截斷重跑期間 `align_feed` 會記下自己切掉的 K 棒,檢查只放過**這幾根**;截斷結果裡少掉的其他 K 棒照舊算差異。測試 `tests/check_lookahead_guard.py` 加一例(每週五當假日)與「沒被 align_feed 切的缺 K 棒照樣抓」。
- **美股日線稽核修正(desktop 0.1.12,`lib/data.py`)**:電腦版閘門下移到發請求的最底層——Yahoo 的 `_yahoo_session`(每個直接請求都經過它)與 yfinance 抓取函式,直接叫私有函式或拿 session 在雲端也一個請求都不送;雲端排程報告(`BLAVE_MODE=live`+`BLAVE_SCHEDULED_RUN=1`)改回「美股資料目前只在電腦版可用」。Yahoo 回 200 但沒有 bar、yfinance 沒資料、yfinance 把缺的 adjclose 用 Close 補上(區間內有配息卻 Adj Close 全等於 Close)都算失敗、不寫快取。429 重試完仍被擋 → 這個程序 15 分鐘內不再問 Yahoo;yfinance 丟 YFRateLimitError 同理。yfinance 改用 `config.debug.hide_exceptions=False`(`raise_errors` 已棄用)並帶 `actions=True`。`align_feed` 的 `us_trading_days` 在歷史中段因美國假日填 NaN 時印 ⚠️(幾根、哪一天、多半是假日),不加假日表(Wei 拍板)。
- **策略套件加 yfinance(desktop 0.1.12,`shell/main.js` `WORKSPACE_DEPS` 7 → 17 個)**:yfinance 1.7.0 與它拉進的 curl_cffi、lxml、peewee、protobuf、websockets、beautifulsoup4、multitasking、platformdirs、pytz 全部釘版,yfinance 排最後;三平台 cp312 wheel 與兩種裝法 freeze 相同已驗。既有用戶的記號檔內容變了,下次開 app 補裝這十個(mac arm64 約 13 MB、x64 約 9 MB、win 約 8 MB)。
- **美股日線(desktop 0.1.12,不在 runtime/ 但同一批出貨)**:`lib/data.py` 新增 `fetch_usstock_price(symbol, start, end, headers=None)`——只在電腦版(`BLAVE_AGENT_LOCAL=1`)抓,先打 Yahoo v8 chart(誠實 UA、自己的 session 與每秒 1 次節流),失敗退 yfinance(`auto_adjust=False` 取原始再用同一個還原式);還原口徑 = yfinance `auto_adjust=True`(OHLC × adjclose/close,量不還原)。快取一檔一個整段快照,有新 bar 可能已定才整份重抓、不合併(拆股/配息會改寫全部舊 bar)。雲端主機丟 `UsStockUnavailable`(訊息含「美股資料目前只在電腦版可用」)、上線 tick(電腦版也沒帶該旗標,`BLAVE_MODE=live`)丟同一型別但說「美股策略目前還不能上線」,都在發請求前就擋。`FEED_TIMING['usstock_price']` = 紐約 17:00(時區帶夏令),當天未定的 bar 不進結果也不進快取;`align_feed` 新增 `us_trading_days`,並修掉 bars 全落在週末時候選日為空的 IndexError(台股 feed 同一處)。`_sanity_check_ohlc` 新增夾擠檢查:開/收落在高低之外 → 撐開高低並印 ⚠️(不丟 bar;現有快取實測:加密/台指期/Yahoo 0 根,Blave 台股原始日K 76/168k 根,6669、6770 上市前)。`lib/quality_check.py` 把它算成標的自身價格(不觸發 PLOT_SERIES 提醒)。`references/lib.md` 新增 *US stocks / ETFs* 一節、`references/strategy-code.md` 補公布時間一列,`AGENTS.md`(瘦身後的 Data Sources)只加一句指路;`references/cloud-handoff.md` 送上雲端前擋用到美股資料的策略。測試 `tests/check_usstock_daily.py`(fixture 在 `tests/fixtures/usstock_daily/`)。動到 `lib/`、`references/`、`AGENTS.md`:**發版時要 bump 根 `VERSION`**。
- **市場對應交易所的檢查沒有出貨(desktop 0.1.12,Wei 拍板)**:開發期間做的那一套(`runtime/market_gate.py`、合約表 `runtime/market_contracts.py` 與 `tools/build_market_contracts.py`、存金額與啟動下單的 `MARKET_*` 拒絕、對帳器的停單 `state/market_hold*.json`、下單前 `judge_symbol`、`market_hold`／`market_check_off` 事件、報告的 `market_gate`、`stats.json` 的 `market`／`market_symbols`、外殼的鎖與「已停單」顯示)出貨前整個拿掉,`publish.py` 也不再查合約表新鮮度。代價照實(Wei 已接受,跟 0.1.11 相同):用到美股資料的策略可以勾進自動下單——①一般 Type A 美股策略:上線的 tick 沒有 `BLAVE_AGENT_LOCAL`(mac 走 `_LOCAL_ENV_PASS` 白名單、Windows 濾掉 `BLAVE_*`),`fetch_usstock_price` 在發請求前就丟例外,tick 失敗、從不寫 `state.json`,所以不會下單;②已上線、已有 `state.json` 的策略被改成用到美股資料:之後每一輪 tick 都失敗,`state.json` 停在最後一筆,對帳器照那筆部位持有(沒有新鮮度檢查),不出場、停損也不跑,只發 P2 `strategy_failed`(電腦版不在 P1 通知裡);③策略程式自己設 `BLAVE_AGENT_LOCAL`(拿掉 `MARKET_FLAG` 之後存得進去):電腦版的 tick 會真的抓到 Yahoo 並照 SYMBOL 下單,例如下到 Binance 的 `SPYUSDT`,程式不擋,只靠 `references/lib.md` 叫 agent 不要這樣做。`TYPE_B:` 拒絕碼保留(電腦版本機不跑 Type B,外殼讀它換成 `tr.typeB.rejected`)。埋點 `pick_gate_lock` 留在白名單(api 已登記、兩端逐字比對),0.1.12 起沒有送出點。測試 `tests/check_no_market_gate.py`(存金額不看市場、`TYPE_B` 照擋)、`tests/check_amounts_manifest_filter.py`(繼承路由只認 UI 綁的交易所;原本只被已刪的 `check_market_gate.py` 間接測到)。
- **外殼小改(desktop 0.1.12,不在 runtime/ 但同一批出貨)**:新增策略框的預覽句不再附「加密貨幣標的未註明市場時,預設 USDT 本位永續合約。」(任何標的都不接,`ns.msgDefault` 刪掉);進出場紀錄在回測 INTERVAL ≥ 1 天時只印日期,固定用 UTC+8 取(UTC 午夜與台北午夜兩種日 K 時間戳都落在當天),清單與十字線同一格式;選擇策略框裡有原因句的列(台幣計價、Type C),勾選框 `aria-describedby` 指向那一句、原因句 `aria-hidden`;歡迎頁籤「看免費策略」改「看現成策略」(en「See Ready-Made Strategies」);連接交易所框在這台電腦視角也列群益,選到只說明要用 Windows 雲端主機(開機時選 Windows、開好不能換)、不給按鈕;`cx.acct.meta`、`cx.lead`、`cx.leadCloud` 拿掉「抓資料」;`shell/reportshare.js` TOS_VERSION 對齊 web 2026-10-01。

## 1.1.106 — 2026-10-01(desktop 0.1.11)

- **部署現況那一行照畫面的字講(desktop 0.1.11 B8)**:agent 會把這行原樣講給用戶聽,內部名稱換成畫面上的「自動下單」——「對帳下單程式沒在跑」→「自動下單沒在跑」、「下單設定裡但金額 0」→「自動下單頁金額 0」、「下單設定裡有金額」→「自動下單頁有金額」、設定檔壞掉那句不再帶 `manager/portfolio_config.json` 路徑;設計稽核 0.1.11 D8 再改「其他排程」→「自己排程的策略」、「單支暫停」→「已自動暫停」、「未部署」→「還沒上線」、「模擬盤帳戶:已綁定／未綁定」→「模擬交易:已連接／未連接」;code 稽核 P1-1:「還沒上線」照畫面的定義(上線中 = 金額 > 0),金額 0 的也列進去並加註「(在自動下單頁、金額 0)」,拿掉另列的「自動下單頁金額 0」,金額 0 的排最前面(超過 15 支截斷時註記不被截掉),金額讀不到時不列;段名改「[上線現況」,規則句改成「有金額的策略不要再建議上線(真倉或模擬交易都算);「還沒上線」裡標了金額 0 的,只建議到自動下單頁設金額」;同段 prompt 的導航句(portfolio.pos=設金額上線、portfolio.venue=連接模擬交易或交易所)與里程碑規則(有回測但還沒上線、就不提上線)跟著換;`tests/check_deploy_prompt_010.py` 列舉每一種狀態鎖住不出現內部名稱。
- **上線現況的規則句定稿(desktop 0.1.11 code 複驗 R-P2-4 / R-P2-3)**:有金額的策略和「自己排程的策略」都算已上線、不要再建議上線;金額讀不到時後半句換成「不要推斷哪些策略還沒上線,也先不要建議上線;用戶問起,就請他到自動下單頁看」;`tests/check_deploy_prompt_010.py` 兩種情況逐字鎖住。
- **更新回覆句照畫面講「自動下單」(desktop 0.1.11 D8,不在 runtime/ 但同一批出貨)**:`references/updating.md`、`references/cloud-handoff.md` 裡 agent 一字不改轉述的「下單程式…」/ "The order program…" 改成「自動下單…」/ "Auto-trading…"。動到 `references/`:**發版時要 bump 根 `VERSION`**,否則用戶端看不到(隨 VERSION 2026-10-01 出貨)。

## 1.1.105 — 2026-09-30(desktop 0.1.10)

- **建議列不再跟回覆的結論打架(0.1.10 #7a)**:回覆說「不建議直接拿去用——訊號要先站得住，調參數硬拉沒有意義」，建議列卻是「幫〈策略〉加一個趨勢濾網」。
  根因在 `_SUGGEST_RULE` 本身:總結里程碑不看結論一律「必附:上模擬盤或優化方向」,而 MCPT p > 0.05 那條開的藥方就是「加濾網或換訊號」。
  改成建議跟正文結論同方向(可以用 → 上模擬盤;還在迭代 → 優化方向;不建議用 → 不提部署,訊號站不住只提換訊號、不在同一個訊號上加濾網／調參數／vol targeting),
  加一條「正文勸退的事不准出現在 <suggest>」,逐輪錨同步。
- **電腦版的部署步驟照電腦版的畫面(0.1.10 #7b)**:導航類回合注入 `references/portfolio-steps.md` 時,依表面(`LocalSink`,或 `BLAVE_AGENT_LOCAL=1`——電腦版起的排程報告回合也算)只帶那一套
  (`### Web workspace` / `### Desktop app` 子段;舊檔沒有子段就整段照舊),並講明是 app 左側的自動下單頁、不是網頁工作頁。
  電腦版外殼不處理 `ui_nav`:電腦版的網頁系回合改用 `LOCAL_FORMATTING_RULE`(只把 `_NAV_RULE` 換成不要標記、不承諾自動開頁的一段,建議規則仍在最尾端),導航句的 <nav> 逐輪錨電腦版不掛;網頁不變。
- **暫停下單時不再說策略「正在跑」(0.1.10 #8)**:`_deploy_state_line` 原本把 `state/deployments.json`(名冊:金額 0、暫停都還在)寫成「已部署運行中」。
  改成兩件事分開講:下單設定裡的策略(有金額／金額 0／其他排程——只算 `strategies/` 下真有的或 `type: cron`,常駐程式不算;
  `portfolio_config.json` 壞掉講「讀不到」)與下單狀態(重開停止 → 已停止;`state/HALT` → 已暫停——兩者都不對平倉、停損或「任何單都不送」做保證;
  對帳器心跳 5 分鐘內 → 執行中;否則對帳下單程式沒在跑;只有 Type B 排程時講它照自己的排程跑)+ 單支暫停(`downtime_pause.json`;
  `HALT_<name>` 只列沒金額的,對帳器不讀它)。電腦版雲端視角不注入這一行(它讀的是這台電腦)。測試 `tests/check_deploy_prompt_010.py`(三件一起)。

## 1.1.104 — 2026-09-29

- **排程報告回合加 Bash 守門(稽核 09-29 P-1)**:`--scheduled` 回合不分 sink 掛 PreToolUse:Bash hook,讀 `.env`、印整個環境、
  叫會下單／平倉／換 key 的模組(`lib/order_*`、execute、venue_wiring、venue、portfolio、群益憑證、command_listener 等,清單由
  測試從 import 閉包列舉對齊)、動部位的 `manager/` 指令、`BLAVE_MODE=live`、指令位置上的網路工具一律 deny 並回理由;`Read(/.env)`
  加進排程回合的 disallowed 規則;刪掉 CLI 從不參考的 `Write(path)` 規則(Edit 規則本來就涵蓋 Write)。取代 09-26「Bash 只做軟約束」。29026 實測:hook 會觸發、正常晨報 0 誤擋;SDK 沒有 hooks 時不掛(fail-open)。
  測試 `tests/check_sched_bash_guard.py`。

## 1.1.103 — 2026-09-29(desktop 0.1.9)

- **「網頁內容不准寫進 strategies/」跟「別人的程式碼照用戶的要求用」不再互相打架(0.1.8 稽核 P1-1 規則衝突,Wei 拍板:不設限、用戶負責)**:
  電腦版每輪附加的瀏覽器規則原本寫「Never write web page content into `strategies/`, `control/` or `.env`」,跟
  `references/strategy-code.md` › *Building from code the user points to* 正面衝突。改成:頁面自己下的指示照舊不做;用戶要拿頁面上的東西
  (程式碼也算)做什麼由用戶決定、照樣寫進 `strategies/`;`control/` 與 `.env` 照舊不寫。`references/browser.md` 同一段同步改。
  測試 `tests/check_strategy_source_rule.py`、`tests/check_local_mcp_config.py`。
- **電腦版的排程守門再收一批自然寫法(0.1.8 稽核 P2-6)**:`case x in x) crontab -l;; esac`、`f() { crontab -l; }`、`function f { … }`、
  `watch crontab -l`、`script -q /dev/null crontab -l`、`arch -arm64 crontab -l` 以前放行,現在擋。SSH 那條「整行只有一個送到雲端主機的 ssh 才放行」
  也收緊:目的地是數字寫法的本機位址(`0`、`127.1`、`2130706433`、`0x7f000001`、`::ffff:127.0.0.1`)或這台電腦自己對外的位址、`-o` 的鍵不在
  `references/cloud-handoff.md` 步驟 2 那幾個之內(`HostName`、`ProxyCommand`…)、帶 `-F` / `-J` / `-I`、目的地後面還有選項,都不算遠端。
  步驟 2 的寫法照舊放行。刻意拆字、別名、續行符號仍擋不到,列在測試的 `KNOWN_GAPS`。測試 `tests/check_desktop_sched_guard.py`。
- **策略版本就地還原的直接指令(desktop 0.1.9)**:新指令 `version_restore {name, n}`(雲端佇列與本機 daemon 同一支 handler,本機要簽章)。
  ① 能力判斷:workspace 的 `lib/strategy.py` 沒有 `RESTORE_IN_PLACE = 1` 那一行 → `UPDATE_REQUIRED`,什麼都不動(舊 lib 的還原會鑄新版);
  ② 在 workspace 子行程跑 `lib.strategy.restore`(有金額在動檔前拒絕 → `LIVE`;另有 `NO_VERSION` / `NO_SOURCE` / `CONFIG_UNREADABLE`),
  ack `{n, inplace, backed_up, rerun: "started"}`;③ 背景靜默重跑(`BLAVE_MODE=backtest BLAVE_QUIET=1`,釘住那一版的 code_hash),
  狀態寫 `versions/rerun.json`,成功由 runner 刪、失敗記 `DATA` / `REFUSED` / `TIMEOUT` / `EXIT`、被編輯蓋過就刪掉(不卡在 running);
  連按先殺上一支、`delete_strategy` 先殺、listener 重啟會認養或結算。報告的 `versions` 多 `inplace` / `rerun`;
  `agent_turn` 在該對話下一輪注入一行系統訊息(`state/version_events.jsonl`)。電腦版的重跑帶 `BLAVE_AGENT_LOCAL=1`
  (台股走 TWSE / TPEx,同 agent 自己回測;live tick 不帶);`delete_strategy` 等還原鎖最多 10 秒,拿不到回「稍後再試」
  (稽核 0.1.9 P1-3 / P2-7)。測試 `tests/check_restore_command.py`。

## 1.1.102 — 2026-09-28(desktop 0.1.8)

- **停止那一句的「下單」改成「執行下單指令」(0.1.8 e2e,第十六批 #2)**:`_STOP_STEP_TEXT["order"]` 原本是「下單 / 下单 / placing an order」,
  但這一種涵蓋下單、撤單、TWAP、平倉、改槓桿、對帳,停在撤單時會寫成「中斷的步驟：下單」。改成跟狀態列(`act.order`,第十四批定稿)同一套字:
  「執行下單指令 / 执行下单指令 / running an order command」。背景腳本那句的「下單腳本」不變。測試 `tests/check_stop_note_steps.py`。
- **一份報告出事不再卡住整輪上傳(0.1.8 稽核 P2-12,第十批 #7)**:尾註某一列的 `id` 是陣列或物件、而且同一個 block 裡另有重複 id 要改名時,
  `unique_footnotes` 丟 `TypeError: unhashable type`;`upload_one` 沒接,整輪中斷、`_save_state` 沒跑,下一輪同一份再炸一次,排在後面的報告都送不出去。
  ① 改名時只拿字串 id 比對(跟 api 的 `unique_footnotes`、外殼的 `uniqueFootnotes` 同一個答案),那一列原樣留著由驗證器拒收;
  ② `upload_one` 裡正規化失敗就原樣送(api 會講哪裡錯);③ `run_once` 接住單份報告的任何例外:記 log、照退避(`_defer`)、繼續下一份。
  測試 `tests/check_report_footnotes.py`。
- **排程守門認得自然的寫法(0.1.8 稽核 P1-3,第十批 #3)**:`if crontab -l …; then`、`for …; do crontab $f; done`、`while …; do launchctl list; done`、
  `{ crontab -l; }`、`! crontab -l`、`sudo -u root crontab`、`env -i crontab`、`command -p` / `time -p` / `nice crontab`、`… | xargs crontab`、
  `find … -exec crontab {} \;` 原本都放行,macOS 的系統框照樣會掛住回合。`_SCHED_CMD_RE` 的指令位置多認 shell 關鍵字之後、find 的 `-exec` / `-ok` 之後;
  前綴指令連同它自己的選項一起認(`_prefix_re`)。送給 ssh 的 heredoc **沒加引號**而且內文的 `$( )` / 反引號裡叫排程器(這台電腦的 shell 先展開)→ 擋,
  理由是「寫法」那一條;加引號的、沒加引號但展開的部分跟排程器無關的照放行,雲端主機上裝排程那條路不變。
  順帶少誤擋:`echo` / `printf` / `grep` / `rg` / `cat` / `sed` / `awk` / `man` / `git` 的引號參數只是字(`echo "crontab -l 可以列出排程"`),不算指令位置。
  這道守門防的是自然寫出來的指令,不是安全邊界:拆字拼回去、`eval`、直譯器裡拼字、symlink、寫進檔案的腳本照舊只有規則層,測試裡列成 `KNOWN_GAPS`。
  Codex 引擎沒有對應的攔截點(hook 只掛在 Claude SDK),那條路照舊只有規則層。測試 `tests/check_desktop_sched_guard.py`(列舉)。
- **電腦版用 Codex 引擎時,Codex 自己的 web search 也關掉(0.1.8 稽核 P1-2,第十批 #2)**:Codex 的 `web_search` 沒設時是 `cached`(開著),
  用戶在設定 › 隱私關掉內建瀏覽器後,Codex 引擎照樣能用它自己的搜尋上網,查到的東西不出現在聊天裡、也不過網域政策;Claude 那條早就把
  WebSearch / WebFetch 關了。`codex_engine.build_args(..., web_search_off=True)` 多帶 `-c web_search="disabled"`;要不要關跟 Claude 那條
  同一個判斷(`web_tools_off()` 不是空的:電腦版三種狀態都關,舊外殼只在掛了瀏覽器時關),雲端機的 argv 逐字不變。鍵名與值對過實際的執行檔
  (0.155.0-alpha.9.2 對不認得的值回「expected one of `disabled`, `cached`, `indexed`, `live` in `web_search`」)與 0.146.0 / 0.155 的原始碼。
  管不到的:管理者的 requirements 不准 `disabled` 時以管理者為準;用戶自己 `~/.codex/config.toml` 裡掛的 MCP 照舊只有規則層。
  測試 `tests/check_codex_engine.py`。
- **沒有建議時回覆就此結束,不交代「沒有建議」(0.1.8 e2e,第九批 #3)**:改報告標題的回覆正文之後多了兩行——
  「これ以上の提案は不要 — 純修改，不附建議。」與為那句日文道歉的一行。來源是 `_SUGGEST_RULE`(每輪接在 system prompt 最後):它只寫了
  「命中時怎麼寫」與「純寒暄直接收尾」,沒寫「沒有要提議時什麼都不寫」,模型把檢查結果寫進了正文。規則最後補一段:沒有要提議 → 正文寫完就結束;
  不交代沒有建議、不說明為什麼沒有 `<suggest>`、不提這一節;不評論、不更正自己前面的句子。不做回覆後處理(濾句子)。測試 `tests/check_reply_rules_018.py`。
- **電腦版的排程守門分得出「這台電腦」與「雲端主機」(0.1.8 開發版;Wei 09-28:雲端主機可以裝,先確認、只裝被要求的那一條)**:
  雲端視角下 `ssh … blaveagent@<host> "(crontab -l; …) | crontab -"` 被當成本機擋下,理由還寫「這是電腦版…macOS 會跳系統框」。
  `sched_verdict(cmd)`:一行指令**整行**只有一個送到別台主機的 `ssh <選項> <user>@<host> <遠端指令>`(可帶一段 heredoc 當輸入)才放行;
  行上有管線、轉向、`;` `&&` `||`、括號、`$( )`、反引號、第二個指令,目的地是 localhost / 127.* / 本機主機名 / 沒有 `user@`,
  選項帶 ProxyCommand / LocalCommand / KnownHostsCommand,引號沒收尾——一律照擋。餵給本機直譯器的 heredoc 腳本裡提到排程器也擋(原本擋不到)。
  拒絕理由分兩條:`SCHED_DENY_REASON`(這台電腦不排程)、`SCHED_DENY_REASON_FORM`(寫法讓 runtime 分不出來:講認得的寫法,不是的話照實講並停手)。
  擋不到的照舊只有規則層:寫進檔案再執行的腳本、把字拆開拼回去。規則在 `references/cloud-handoff.md` › *A schedule on the cloud machine*。
  `mcp_rule` 補一句「回覆第一句講用戶要的事」。測試 `tests/check_desktop_sched_guard.py`(列舉)。
- **雲端連線的收尾不進回覆(0.1.8 e2e #44,第三次)**:雲端相關的回合仍以「清理完成，tmp/cloud-handoff 已刪除。」開頭或收尾。`mcp_rule` 那句
  「delete that folder before the turn ends」後面補「回覆裡不提那個資料夾、連線與清理」——這一句每輪都在 system prompt 裡,是 agent 覺得要交代的來源之一。
  不做回覆後處理(濾句子):以規則為準。測試 `tests/check_local_mcp_config.py`。
- **等背景工作的輸出時,狀態列講的是那支指令在做的事(0.1.8 e2e #134)**:回測被逾時移到背景後,agent 用 `TaskOutput` 在回合內等,
  狀態列寫「正在委派研究」(`TaskOutput` 被歸在 delegate)。子代理在這個 runtime 是關掉的,`TaskOutput` 等的一定是指令:tool chunk 的
  `kind` / `kind_obj` 改成這一輪上一個 Bash 指令的分類(「正在跑回測 …」),沒有就 `unknown`(「正在處理」)。三個表面共用。測試 `tests/check_tool_kind.py`。
- **外殼給這一輪的指示不進用戶的訊息(0.1.8 e2e #131)**:電腦版「新增報告」原本把「這份只要產出一次，不用建立排程。…」接在用戶寫的需求後面
  一起當訊息送,泡泡與對話存檔裡就是用戶「說了」他沒說過的話。外殼改成只送「幫我建立報告：「…」。」,指示用環境變數
  `BLAVE_TURN_NOTE`(代號:`report_once` / `report_recur`)分開帶;`turn_note_rule` 把代號換成規則接進這一輪的提示(Claude 的 system prompt、
  Codex 的前置規則),不寫進歷史。只有電腦版(LocalSink)認、只認 `TURN_NOTES` 表上的代號。測試 `tests/check_local_mcp_config.py`。
- **電腦版上網只有內建瀏覽器一條路(0.1.8 e2e #125;Wei 09-28)**:設定 › 隱私把內建瀏覽器關掉後,agent 改用引擎自己的
  WebSearch 照樣上網,畫面上沒有瀏覽摘要列、來源裡還有內建瀏覽器會擋的網域。外殼每一輪帶 `BLAVE_BROWSER`(`on` / `off` /
  `unavailable`);電腦版回合(LocalSink)看到這個變數就把 `WebSearch`、`WebFetch` 都放進 `disallowed_tools`——**開著時也關**
  (原本只關 WebFetch、留 WebSearch:spec desktop-browser-agent-tools D1 的預設值,改掉),搜尋走 `browser_search`。沒掛瀏覽器時
  `browser_rule` 換成「這一輪不上網」那一段:被要求上網時第一句講明、給兩條路、不把記憶講成剛查到的、不附來源清單;報告不帶網路新聞。
  `curl` / `wget` / 腳本抓網頁只在規則層禁(指令層分不出網頁與行情 API,硬擋會擋到 `lib/data.py` 以外的交易所呼叫)。
  Codex 引擎沒有關內建搜尋的通道(本機沒有 codex 可驗旗標,沒驗過的旗標不送),只有規則。不帶 `BLAVE_BROWSER` 的舊外殼、雲端:行為不變。
  測試 `tests/check_local_mcp_config.py`。
- **停止的回合一定有「已停止。」(0.1.8 e2e #87)**:停在兩個工具之間(沒有工具在跑)時 `_stop_note` 回空字串,
  `finalize` 拿最後一句過場旁白補位,聊天裡最後一則是「Coinbase 被封鎖，改開 calquify…」,看起來像正式回答。
  `_stop_note` 不再有「都沒有就不說話」:沒有步驟、沒有背景腳本時回「已停止。」/ "Stopped.",run_turn 一律接上。
  句框與英文用詞照設計師第四批:zh「已停止。中斷的步驟：搜尋。」、cn「已停止。中断的步骤：搜索。」、en "Stopped. Interrupted: searching the web.";
  en 步驟一律動名詞(searching the web / running a backtest / running a strategy / scanning parameters / delegating research)。
  三個表面(電腦版、web、TG)共用。測試 `tests/check_stop_note_steps.py`。
- **本機對帳程式離開時 log 寫得出原因(0.1.8 e2e #110)**:`state/reconciler.log` 原本只有一行沒有時間的
  `reconciler leaving`,分不出是 daemon 叫它停、app 沒了、還是別的行程送的 SIGTERM。那一晚四次「無故結束」是
  `tests/check_turn_stop.py` 結尾的 `pkill -f manager/reconciler.py`——全機依名稱殺,同一台電腦上正在跑的電腦版對帳程式
  每跑一次測試就被停 10 秒(離開時還會撤自己的掛單)。測試改成只殺自己起的那個 pid,並檢查 tests/ 沒有任何 pkill / killall。
  log:對帳程式寫 `<時間> reconciler leaving (pid N): SIGTERM | parent closed stdin | parent process is gone`;
  daemon(`ReconcilerSupervisor._note`)在自己動手前寫 `stopping the reconciler (pid N): <原因>`(指令重啟帶最後一個指令、
  daemon 收工帶收工原因、收孤兒),沒叫它停卻結束的寫 `exited (code X) without this daemon stopping it`。
  「leaving: SIGTERM」上面沒有 daemon 那一行 = 外面送的。行為不變(照舊 10 秒後拉起)。測試 `tests/check_local_daemon_chain.py`。
- **電腦版的 agent 不碰系統排程器(0.1.8 e2e #64 #75)**:用戶回 YES 要上線 Type B,agent 照雲端文件跑 `crontab`;
  macOS 跳系統框「想要管理你的電腦」,指令掛 4 分 33 秒,agent 接著建議用戶開完整磁碟取用權限。電腦版回合(LocalSink)多掛一個
  PreToolUse hook(`_sched_guard_hooks`,只對 Bash):指令位置上的 `crontab` / `launchctl` / `schtasks` 一律 deny,理由回給模型
  (不換方法重試、不叫用戶改系統權限、Type A/C 指到自動下單頁、Type B 這台不能定時跑+兩個出口)。讀文件的 `grep crontab …` 不擋;
  agent 自己寫的腳本裡呼叫、Codex 引擎(沒有 hook 通道)擋不到,靠 AGENTS.md 與 references/deployment.md › Desktop app。
  機隊不掛。測試 `tests/check_desktop_sched_guard.py`、`tests/check_reply_lang_rule.py`。
- **回一句「YES」不再把整則回覆變成英文(0.1.8 e2e #65)**:回覆語言的判定只看當則訊息,中文對話裡回「YES」確認 →
  訊息尾端的錨、系統層規則、PostToolUse 提醒三處一起點名 English(逐字稿裡每一則提醒都寫 in English,不是 hook 沒觸發)。
  `_lang_basis(message, recent)`:當則看不出語言(沒有非 ASCII 的字、自己打的英文字 ≤ 2 個且沒有文法字)就沿用最近一則看得出來的
  用戶訊息;其餘照舊。有回覆語言設定 / ui_lang 的回合不受影響。兩條引擎、機隊與電腦版共用。測試 `tests/check_reply_lang_rule.py`。
- **模型漏寫 `<export …/>` 標記時轉出卡照出(0.1.8 e2e #49)**:同一則對話第二次轉出(Pine)回覆結尾是 `<suggest>` 區塊、
  標記不見了——「回覆必須以 <suggest> 結尾」跟 references 的「標記放最後、後面不准有字」搶同一個位置。檔案與 lint sidecar
  都在,runtime 沒東西可送,聊天沒有卡。兩道:① `_SUGGEST_RULE` 與三份轉出 reference 寫明兩者並存時標記在前、不准省;
  ② `WebSink.finalize` 在回覆完全沒有標記時呼叫 `unmarked_exports(started_at, touched)`——這一輪工具碰過的策略裡,
  lint sidecar 的 `exported_at` 落在這一輪之內的轉出檔各送一個 chunk(形狀同標記路徑)。回覆有標記(含讀不到)照舊只走標記;
  被停止的回合不送。測試 `tests/check_export_unmarked.py`。
- **停止那一句不露內部工具名(0.1.8 e2e #28)**:「停止時還在跑的步驟：mcp__blave_browser__browser_search。」→「…：搜尋。」。
  `_tool_t0` 多記一格 kind,`_stop_note` 的 `in_flight` 改收 kind、經 `_STOP_STEP_TEXT`(zh / cn / en)換成人話;
  對不到的(unknown、silent、新 kind)不列,只剩「已停止。」/ "Stopped."。測試 `tests/check_stop_note_steps.py`。
- **上網查資料不再以對方條款 / robots 禁 AI 為由排除網站(Wei 09-28 拍板,取代 1.1.101 兩條「固定新聞站」)**:
  DeepSeek 排程 prompt(`report_runner.scheduled_prompt`)拿掉「other news sites' terms forbid automated AI
  access, do not fetch them」;鉅亨列表頁+TWSE/TAIFEX/Binance/OKX 公告頁改成優先清單(實測抓得到的起點),
  1.1.101 撤下的五站(經濟日報、MoneyDJ、CoinDesk、Cointelegraph、Decrypt)以 `_OTHER_NEWS_PAGES` 列在後面當備援。
  `_news_describe`、references/reports.md、references/browser.md、AGENTS.md 同步;電腦版瀏覽器的 agent 黑名單
  清空(The Block 放行),名單只留給有危害的網站。內網、相似網域、交易所/券商後台、銀行、金流、授權頁、
  blave.org、動作分級、下載、速率上限都不動。測試 `tests/check_report_runner_agent.py`、
  `tests/check_report_bricks.py`、`tests/check_shell_browser_policy.js`。
- **轉出檔讀不到那一句跟著回覆語言(spec-desktop-strategy-export-0.1.8 §6-3)**:`_EXPORT_FAIL_NOTE` 原本只有繁中,
  英文介面叫 agent 轉 Pine 讀檔失敗也拿到中文。`_export_fail_note(message, reply_lang)` 同 `_fault_message` 的解析
  (設定 > 看用戶打的字;zh / cn / 其餘一律英文),run_turn 在 finalize 前掛到 sink 上;`extract_exports` 多一個
  `note=` 參數,不給仍是繁中(api `tests/check_export_marker.py` 不受影響)。測試 `tests/check_export_fail_note_lang.py`。

## 1.1.101 — 2026-09-27

- **DeepSeek 排程的固定來源加回鉅亨列表頁+官方公告頁(Wei 09-27 拍板)**:鉅亨授權涵蓋抓其網站
  新聞列表頁——`https://news.cnyes.com/news/cat/headline`(台股/通用)與
  `https://news.cnyes.com/news/cat/bc_crypto`(加密)進 prompt 點名為 licensed 固定來源;官方公告頁
  逐站查證後加入:TWSE(robots 對 * 與 GPTBot 明文 Allow;列表 HTML 靠 JS,改用 rwd JSON 端點)、
  TAIFEX(無 robots.txt、userTerms 無自動化禁令,用 `/cht/11/announcement`)、Binance(robots 對 *
  Allow 且公告 sitemap 在列,ToU 反爬條款由資料夥伴關係涵蓋,Wei 09-27)、OKX(robots 公告路徑無禁令,
  API Agreement 反爬只限超出個人使用規模;下單夥伴,Wei 09-27)。CoinMarketCap 查證不過
  (robots 對 * Disallow `/headlines/*`),不進名單。台股與加密固定來源各湊滿 3 站,加密排程不再預設
  `few_sources` 降級(下面那條「加密沒有授權候選」的說法由此取代);五個禁站照舊不點名。
  `_news_describe`、references/reports.md(含 source-quality 清單撤 CoinDesk/MoneyDJ/經濟日報/工商時報)
  與 AGENTS.md 的 DeepSeek 句同步。
- **DeepSeek 聊天回合也不綁 CLI 的假 USD 預算(稽核 A-P1-2)**:上一批只豁免了排程回合;聊天照掛
  `max_budget_usd=10`,而 CLI 對經 proxy 的 DeepSeek 用 Claude 價目表(~0.116 假 USD/步),約 86 步就撞牆,
  1.1.100 的 100 步宣稱對主力配置不成立。改成聊天與排程同一條 `_cli_cost_trusted` 判定:非 Anthropic 模型
  一律不綁 USD 上限。真實曝險上界:29026 帳本實測 DeepSeek 約 0.9 點/步(9 步 8.06 點),100 步 ≈ 90 點
  (成本基礎 ≈2.8 USD)——由步數與時間擋,不是錢。
- **電腦版聊天回合補牆鐘 35 分鐘(`_TURN_WALL_CLOCK_SEC=2100`,同 web bridge 等級)**:稽核指出電腦版
  (LocalSink)沒有 bridge 回合逾時,外殼只有停止鈕後的 5 秒沉默殺——拿掉假預算後等於沒有時間煞車。牆鐘掛在
  訊息迴圈裡(只在有訊息時檢查:完全沉默的 CLI 不燒 token,歸停止鈕管),到點收掉回合、不續跑,用戶拿到
  「只做完一部分」那句。只掛 LocalSink;雲端 TG/web bridge(2000/2100 秒)與排程 runner(600 秒)照舊自己管。
  已知限制:牆鐘在 Claude 引擎的迴圈裡,`engine=codex`(用戶自己的訂閱)沒有——照舊沒有時間上限。
- **DeepSeek 排程的固定新聞站撤下(ToS 逐站查證,09-27)**:1.1.99 寫死的六站,五站的條款或 robots.txt
  禁止自動化/AI 使用——Cointelegraph(ToS 明文禁 AI/LLM)、經濟日報與 MoneyDJ(robots.txt 明文禁 LLM 且
  Disallow ClaudeBot)、CoinDesk(ToS 禁 robots/scrapers + robots 擋 anthropic-ai/ClaudeBot/CCBot)、
  Decrypt(ToS 禁自動化 data-mine/scrape)。只剩鉅亨(Blave 授權方,service.htm 與 robots 查無禁令)。
  DeepSeek 版 prompt 改成只 WebFetch 授權候選的連結;湊不滿 3 站(加密沒有授權候選)走 `few_sources`
  一句照發——這是產品行為,不提換模型。`_news_describe` 的聊天版名單與 references/AGENTS 同步撤下
  被禁的站名,改寫「先看目標站的條款與 robots 有沒有禁 AI」。

## 1.1.100 — 2026-09-27

- **聊天回合步數上限 50 → 100(電腦版與雲端一致;排程 25 不動;Wei 09-27)**:「建 BNB MA 策略+回測+上
  TradingView 對照」在 50 步被砍在貼完 Pine 之後(同日 ETH 那輪也用滿 49 步)——瀏覽器 UI 任務每個
  click/wait/snapshot 都是一步,乾淨做完就要 ~60 步。煞車仍是預算(10 USD)與 bridge 回合逾時,不是步數。
  references/browser.md 補一條:TradingView 換 symbol 走 `?symbol=` URL、不用搜尋框(那次在搜尋框上燒掉
  約 20 步)。測試 `tests/check_scheduled_budget.py` 期望值同步。

## 1.1.99 — 2026-09-27

- **DeepSeek 的排程報告照樣有新聞欄(WebFetch 固定來源)**:WebSearch 是 Anthropic 伺服器端工具,DeepSeek 經 proxy 沒有;
  但 WebFetch 是 CLI 自己抓網頁、用同一個模型摘要——mock proxy 實測(claude 2.1.283,model=deepseek/deepseek-v4-pro,
  09-27):tool_use 有執行、摘要子呼叫帶同一個 model id,經 proxy 一樣路由到 DeepSeek 計費。`report_runner.scheduled_prompt`
  分兩版:Claude 版照舊 WebSearch→WebFetch;DeepSeek 版(含沒有模型偏好的預設)直接 WebFetch 授權候選的連結加 2–3 個
  固定頭條頁(crypto:CoinDesk/Cointelegraph/Decrypt;台股:鉅亨/經濟日報/MoneyDJ),照樣湊滿 3 個網站出完整版。
  完全沒有上網工具的模型才降級(新聞欄不出＋尾註一句),這是產品行為:R8 的說明句講一次「這台目前的模型不含上網查新聞,
  這個排程會出數據＋判讀版」,不建議切模型、不比價(Wei 09-27;references/reports.md §News 表、R8 與 AGENTS.md 同步改)。
  測試 `tests/check_report_runner_agent.py`(兩版 prompt 各一例、預設模型走 WebFetch 版)。
- **非 Anthropic 模型的排程回合不再用 CLI 的 USD 成本當預算**:CLI 的 `total_cost_usd` 照 Claude 價目表估,
  經 proxy 跑 DeepSeek 時整個錯——29026 實測(09-27 14:25,deepseek-v4-pro)9 步被它算到 1.045 USD 撞預算、
  退成 data-only,而 api 帳本同一輪 12 筆 `usage_llm` 合計只扣 8.06 點(成本基礎 ≈0.25 USD,CLI 高估約 4 倍)。
  改法:`max_budget_usd` 只在模型是 Anthropic 系(claude/sonnet/opus/haiku/fable)時才綁(0.84),其他模型
  (含沒偏好的預設 DeepSeek)靠 25 步+runner 10 分鐘擋;`.sched_result.json` 照實記 CLI 值但多帶
  `cost_untrusted: true`;runner 的降級判定看到 `cost_untrusted` 就不把 budget 當成因(那個數不是真的)。
  續跑的剩餘預算對不可信成本不再扣減。測試 `tests/check_scheduled_budget.py`、`check_report_runner_agent.py`。

## 1.1.98 — 2026-09-27

- **回合狀態列的分類(`agent_turn._tool_kind`;spec-turn-status-summary ①)**:每個 tool chunk 多帶 `kind`／`kind_obj`(受詞:網域、
  搜尋字、策略名、代號、檔名,≤60)／`kind_tab`(瀏覽器分頁 alias),前端照 kind 查自己的字,把「執行中 · 第 39 步」換成
  「正在讀 investing.com」。不送任何顯示字、不呼叫模型。兩條誠實規則:**下單**只認真的下單呼叫(place_/cancel_/run_twap/
  close_position),`get_order`／`get_contract_rules` 這類查詢不算;**回測 vs 實盤**用 workspace 的明確路徑讀下單設定
  (`manager/amounts.ui.json` 優先,再 `portfolio_config.json`),不呼叫 cwd 相對的 `strategy_amounts()`,`BLAVE_MODE=backtest` 優先。
  執行的是 workspace 腳本時連腳本內容(前 64 KB)一起掃;ssh 包起來的剝掉外層照同一套規則,內層分不出來就是「連雲端主機」;
  `grep`／`cat` 這類純讀檔的指令先看指令頭(grep 一支含 publish( 的檔不算在組報告)。另送 `tool_prep`(模型開始生工具參數時,
  只帶工具名;大的 Write 要 10–30 秒,狀態列說「正在寫程式」)。**api 要先上**:`_safe_tool_chunk` 收 kind 白名單、
  `tool_prep` 進 TURN_CHUNK_TYPES(舊 api 會把 kind 欄位丟掉,前端退回只看工具名)。列舉測試 `tests/check_tool_kind.py`;
  本機電腦版最近 20 個回合的逐字稿重放:331 次工具呼叫,unknown 7.4%(門檻 15%)。29026 的重放沒做(這台 BYOA 通道不在
  這次的工具裡)。
  `tool_prep` 改成**邊收參數邊分類**(`ToolPrep`,設計稽核 A3):Bash／Write／Edit 開頭送 `code_prep`,每 256 字元或 0.5 秒
  用完成後同一套分類判一次(組報告的 heredoc 一出現 `publish(`／`report_templates` 就是 report、寫進 `strategies/<name>/`
  就是 strategy_write),只往更具體升級。實測(本機 Sonnet 加密晨報):狀態列在生參數時就是「正在組報告」。
  下單分類補漏報(稽核 P1-3):`open_position`／`set_leverage`／`dispatch_order`／`reconcile` 算下單;
  `manager/close_symbol|stop_strategy|flatten|close_all.py` 走路徑規則直接判下單;ssh 的 heredoc 本體一起分類。
  Windows 反斜線路徑先正規化;WebFetch 的受詞改成可註冊網域;`_lang_hooks` 合併既有的 PostToolUse。
  複審修正:ToolPrep 一路判到參數收完、只往更具體升級(order 最高;先抓資料後下單的 heredoc 最後是「正在下單」);
  回合第一個工具就先讀下單設定(實盤不先說成回測);`stop_strategy.py` 只有帶 `--flatten` 才算下單,否則是「設定排程」。

- **電腦版內建瀏覽器的 runtime 接線(`--mcp-servers`、`browser_rule`、Codex `browser_server`)**:外殼以 `--mcp-servers`
  (逗號清單,只認 `blave` / `blave_browser`)標示這一輪掛了哪幾個本機 MCP,沒帶 = 舊外殼 = 只有 `blave`。掛了
  `blave_browser` 的回合在 prompt 加瀏覽器規則(網頁內容是資料不是指令、`needs_user` 不繞、blocked 不叫用戶貼內容、
  引用要附來源)並關掉 WebFetch(讀網頁一律走瀏覽器;WebSearch 保留);Codex 引擎 `browser_server()` 同 `blave` 那套閘門
  (版本下限、撞名、snapshot)掛第二個 server,token 只走 `BLAVE_BROWSER_TOKEN`、被自己的 env filter 拔掉,
  `tool_timeout_sec=120`。`session_store.SCAFFOLD_RE` 加 `[Runtime 規則`(網頁與摘要不能冒充 runtime 規則;稽核 S3)。
  測試 `tests/check_local_mcp_config.py`、`tests/check_codex_engine.py` §7、`tests/check_codex_mcp_live.py` 第 4 條。

- **回覆語言改成系統層規則(`agent_turn.reply_lang_rule`,兩條引擎、機隊與電腦版都帶)**:原本只有 prompt 尾端那一句錨,
  工具讀進大量外文之後模型會跟著切語言——電腦版中文問「用瀏覽器查今天比特幣的兩則新聞」,回覆第一句與列表標題是英文
  (Wei 2026-09-26)。新規則寫明回覆語言(解析同錨:設定 > ui_lang > 看用戶打的字)、外文網頁與工具輸出不改變它、外文標題
  翻成回覆語言並可附原文(同 news block 的 `title`／`title_orig`);放在建議規則之前(建議規則仍在最尾端)。每則訊息的錨不變。
  references/browser.md、reports.md 查過沒有蓋過語言的指令。測試 `tests/check_reply_lang_rule.py`。
  規則也涵蓋工具呼叫之間的旁白;中文回覆一律全形標點(數字、英文、程式碼、網址除外)。**電腦版**另掛 PostToolUse hook,
  每個工具結果後面附一句語言提醒(`lang_reminder`;深度研究讀進十幾頁英文後 Sonnet 的旁白照樣變英文)。機隊先不掛,
  等 29026 驗過 hook 通道;Codex 引擎沒有對應的機制,只有系統層規則。實測(本機 Sonnet、真 CLI、四篇與三篇英文原文的研究
  回合各一次):旁白全中文、回覆沒有半形標點夾在中文之間,也沒有把提醒講給用戶聽。

- **雲端排程報告改成到點跑一輪 agent 寫判讀、整理新聞(`report_runner`、`agent_turn --delivery report --scheduled`)**:
  只對 `job.json.agent_consent == true` 的 job(登記時用戶聽過每份估價、同意;這版之前登記的全部照舊出數據版、不加尾註)。
  用戶「當時」的模型偏好(`state/model_prefs.json` 的 `_last`),不在登記時固定。每份上限 1.0 USD(Wei 09-26 由 0.8 調高;Sonnet 實測每份 0.46–0.55)、25 步(續跑不加步數)、10 分鐘;
  Edit/Write 擋 strategies/ control/ report_jobs/ lib/ .env(**Bash 不擋:軟約束,Wei 09-26 接受**)。每個 job 每天最多起一次回合
  (失敗、立即執行都算)。回合名額照 turn_slots(對話優先;試用機單一名額不佔、記憶體低不加);逾時先建停止旗標讓 turn_stop 收掉整棵樹
  (動錢的行程放過),寬限 20 秒再硬殺。沒完成就退回 `run.py` 的純資料版,尾註一句原因(`BLAVE_REPORT_DEGRADED`);原因只看結構化結果
  (`report_jobs/<id>/.sched_result.json` 與 runner 自己的逾時),不在回覆文字裡找字。連續 3 次降級發 `report_degraded`(P2,冷卻檔獨立,
  不壓掉 strategy_failed);餘額不足只寫尾註。報告歸屬靠 `lib.report.write_report` 在 `BLAVE_SCHEDULED_JOB` 下寫的 `.published`。
  **電腦版排程這版照舊只出數據版**(下一版);電腦版 app 關著時錯過的那一格記一筆 `skipped / app_closed`,不補跑。
  每日次數另存 `report_jobs/<id>/.agent_day`,拿到名額、起回合**之前**寫入(runs.jsonl 只留 50 行會洗掉計數;runner 中途被殺也算數)。
  稽核 0.1.7 修正:SDK 預算設「上限 − 0.16」(SDK 每步結束才比,超過的那一步照付;0.16 = 實測快取命中時單步最大成本);收盤報告 job 碰到休市(週末,或
  workspace 的 `is_tw_trading_day` 說休市)在起回合前就跳過(`agent_skipped: market_closed`,不花預算、不算次數、不算降級);
  雲端 `run.py` 也帶 `BLAVE_SCHEDULED_RUN=1`,純資料版休市照舊 skipped,不再落到上個交易日重發;沒有 `turn_limits.json`
  (api 還沒回過名額)當成單一名額不叫 agent;回合名額改成直接用 `turn_slots`(不再在 runner 裡抄一份);回合帶
  `--ui-lang`(用戶登記時的語言),訊息給 pack 的確切呼叫、雲端走 WebSearch/WebFetch。
  同意過的 job 最密每小時一次(登記時拒絕更密的 cron)。試用機／單一名額:`agent_skipped: single_slot`,中性(不加尾註、不計次、
  不通知),`lib.report.scheduled_agent_available()` 讓 R8 不去徵求同意。重新登記沒帶 `agent_consent` = 沿用舊值。
  排程回合步數用完就不續跑(max_turns=0 對 SDK 是沒有上限)。硬殺後讀輸出最多等 10 秒。`report_degraded` 送成功才寫冷卻戳記。
  試用轉付費(`agent_available()` 由 False 變 True):每個還沒同意的報告 job 記一筆 P3 `report_agent_available`(只記不推),下一份排程報告尾註一句
  「升級後排程可以請 AI 整理新聞，跟 agent 說一聲就能開」,只講一次;不自動開、不扣費。寫 `.agent_day` 失敗就不起回合、名額馬上還回去。
  新增 `session_store.clear_session`;api 新事件型別 `report_degraded`、`report_agent_available`(**先部署 api**,再發這個 VERSION)。

- **報告 pack 只在同一輪重用**:`agent_turn` 每一輪把 `BLAVE_TURN_ID` 放進回合環境,`lib/report_bricks` 以它判斷
  「同一輪」——publish 被拒後重送同一包,下一輪一律重建(行情已經變了)。測試 `tests/check_codex_engine.py`、
  `tests/check_report_flow.py`。

- **停止鈕按下 ≤2 秒停住,連跑到一半的工具一起殺掉(新 `runtime/turn_stop.py`)**:原本唯一的通道是 `/report` 回應夾帶的
  `interrupt: true`,而 run_turn 只在訊息邊界檢查——agent 在跑回測／Bash、或模型安靜思考時根本不 POST,停止要等工具跑完才生效。
  現在啟動方給每一輪一個旗標檔路徑(環境變數 `BLAVE_TURN_INTERRUPT_FILE`,不上 argv:舊 runtime 不認也不會 exit 2),建檔 = 停;
  agent_turn 每 0.25 秒看一次(`/report` 夾帶的那條照舊有效、也走同一段),看到就殺這一輪的子行程樹(引擎 + 工具),1 秒內串流沒自己
  結束就取消回合,照既有 interrupted 收尾(`done`、不給建議與轉出、寫回歷史;不送 `error`)。Claude 與 Codex 兩條引擎共用。
  **網頁**:api 的 `/interrupt` 本來就會往 inbox 丟一則 `interrupt` 控制訊息(BLPOP 即時送到),web_bridge 以前對跑著的回合只 ack;
  現在寫那一輪的旗標檔(`state/turn_stop/<uuid>`,回合結束刪)。**api 不用改。**
  **電腦版**:外殼每輪給一個旗標檔、停止鈕寫它(見 shell)。
  殺的範圍:POSIX 沿父子關係找這一輪的引擎與工具;**動錢的行程一律不殺、讓它跑完**(規則集中在 `turn_stop.MONEY_ARGV`):
  指令列含 close_symbol／stop_strategy／manager/flatten／close_all／update_workspace／seed_ledger／reconciler.py／capital_worker／
  lib/order_*／lib/execute／lib/venue／lib/portfolio(含 `from lib import … venue／portfolio／execute／order_*`)的行程,以及
  import 過任何 `lib/order_*`、呼叫過 `venue.bind` 或 portfolio 寫帳函式的行程(`lib/guard.mark_money_process` 寫
  `state/execution/money_pids/<pid>`,活到行程結束——不是每筆下單才標:撤停損與平倉之間那個空檔才是危險點)。
  保留的單位是**整個工具 session**(Claude 每次 Bash 呼叫一個 setsid session):`python3 x.py | tail` 的 tail 也留著,
  否則腳本下一次 print 就 BrokenPipe。
  Claude 的工具輸出寫檔,引擎照殺、平倉腳本脫離後跑完;Codex 的工具輸出走 Codex 的管線,所以 Codex **留到腳本結束、最多
  120 秒**,期間整棵樹都不殺(`x.py | tail` 的 tail 可能就在引擎自己的 session 裡)(`HOLD_MAX_S`;codex_engine 在有 watcher 的回合停止後只排乾不轉送、絕不自己 break／殺,殺不殺由 turn_stop 決定;
  runtime 每秒送 ping)。超過 120 秒(前景 reconciler、TWAP、監控迴圈)就殺 Codex,回覆寫明「X 停止後兩分鐘仍未結束,
  已不再等它,輸出已中斷,可能沒跑完」。
  回覆與歷史寫「已停止;X 會動到部位或帳本,沒有中斷,仍在背景跑完」與停止時還在跑的步驟;被停止的回合也把工具收據寫進歷史。
  `/report` 夾帶的停止會在區塊邊界結束迴圈、可能早於 watcher 第一次掃:收尾時再掃一次(實測 SDK 0.2.144 的 `aclose()`
  不會結束 CLI,也不會殺仍在跑的 Bash 工具)。
  **Windows(未經真機驗證)只殺引擎本身、不加 `/T`**,工具自己跑完。**Windows 電腦版 + Codex 上架前必修**:殺 Codex 會讓
  管線上的平倉腳本 BrokenPipe,應改為 nt 且留引擎時完全不殺、只取消回合。後續:以 GetProcessTimes 確認子行程晚於父行程才信
  ppid、逐 pid 殺;Windows 的 money_pids 只寫不清,探活不能用 `os.kill(pid, 0)`(會 TerminateProcess);標記寫入行程建立時間
  以防 PID 重用;`lib[./]execute` 比對可收窄到 `-c`／`-m` 參數。
  另:同一個工具呼叫裡平倉之後接無限迴圈(例如 `close_symbol …; while true; …`),Claude 下整個 session 會被保留、停不掉(稽核 T2,後續)。
  web_bridge 啟動時清掉 `state/turn_stop/` 的殘留旗標。**`lib/` 有改(guard、每支 order_*、portfolio 寫帳函式、venue.bind),
  要走 workspace 通道(VERSION)**;舊 workspace 只有指令列那條規則在保護,臨手寫的下單腳本要等 lib 更新後才受保護。
  實測(本機 dev 外殼,真 CLI):Claude 0.73 秒、Codex 1.34 秒從按下到按鈕回到送出,`time.sleep` 工具行程都不在了;
  網頁路徑本機模擬(真 web_bridge + agent_turn + Claude CLI、假 api):inbox `interrupt` → `/report` 收到 `done` 0.07 秒。
  測試 `tests/check_turn_stop.py`。

- **群益雲端開通:登記兩個仍把密碼放上指令列的點**(`capital_connect` 檔頭 audit C-1 註記:`schtasks /rp`、
  `certutil -p`;換掉的做法會改變金鑰落地方式,要 desktop-win-test 真機驗過才動)。新增守門測試
  `tests/check_capital_argv_secrets.py`:第三個把 secret 放上 argv 的點會紅。

- **雲端視角要的報告在雲端主機上組與發**(`agent_turn._viewing_env_segment`):用戶看著雲端主機要報告(任何類型)時,
  資料包與 `publish()` 照 `references/cloud-handoff.md` › Reports asked from the cloud view 在那台主機跑,網路搜尋留在
  這台電腦;連不上雲端就先問、不擅自改在本機產出;回覆講報告幾分鐘後出現在雲端的報告清單、不說已打開。
  測試 `tests/check_cloud_report_script.py`。

- **群益雲端免 RDP 開通(新 `runtime/capital_connect.py`,五個機器指令 `capital_setup`／`capital_pfx_key`／`capital_pfx`／`capital_probe`／`capital_finish`)**:
  用戶在自己的 Windows 匯出的 pfx 以主機一次性 RSA-OAEP 公鑰封裝上傳(api 只轉送密文),主機解密、驗是群益且未過期、經 schtasks 密碼載具
  以 Administrator `certutil -user -importpfx … NoRoot` 匯入,刪掉同 ID 舊證與過期證、probe、再由 `capital_finish` 裝 NSSM worker(Administrator)。
  進度寫 `state/capital_connect.json`,portfolio 報告帶 `capital_connect`(網頁與電腦版同一份)。雲端 Windows 且 workspace lib 支援時,
  `credentials` 綁群益會把身分證字號＋交易密碼改存 `credentials/capital_vault.json`(只有 Administrator 讀得到,SYSTEM 只能刪),`.env` 只留哨兵;
  解綁一併刪 vault(刪不掉也不中斷解綁)。哨兵的 id 是空值(舊版 lib 在送出登入前就以「missing」失敗,不會拿哨兵當密碼);
`credentials\` 目錄先收權再寫,暫存檔任何失敗都刪。群益回 300/307 後,runtime、worker、`order_capital` 都不再用同一組帳密登入
(`state/capital_login_block.json`;300 只有帳密換了才解除;307 另可由用戶按「我已解鎖」
= `capital_probe {"after_unlock": true}` 放行恰好一次 probe 登入,worker 與下單 lib 期間照樣拒登,放行以獨占建立的 claim 檔搶、同時兩支 probe 只有一支登入;bridge 中斷會關掉放行窗口;成功即解除(`--once` 自己清這組帳密的 block)、失敗就回到 block 且同一組帳密不再放行),worker 失敗改指數退避(30 秒起、上限 30 分)。匯入前不刪任何有私鑰的證;
新證比同 ID 現有的舊 → `PFX_OLDER`;同 ID 同到期日的舊那張在新證匯入後刪掉。只有 capital_* 指令會建立 `capital_connect.json`。雲端主機寫 `.env` 時一律收掉 Users 的讀取權。本機模式與非 Windows 一律拒收。測試 `tests/check_capital_connect.py`
  (需 `cryptography`)、desktop-win-test 真機驗過(見 `.claude/output/backend/capital-cloud-progress-2026-09-26.md`)。**要 workspace 同時更新**
  (`lib/capital_vault.py` 等),舊 workspace 照舊把帳密寫 `.env`,不會拿哨兵去登入。

## 1.1.97 — 2026-09-26

- **電腦版排程報告帶 `BLAVE_AGENT_LOCAL=1`、`BLAVE_SCHEDULED_RUN=1` 與電腦版策略同一份放行名單(含 `BLAVE_KLINE_SOURCE`,
  排程的加密報告跟聊天一樣走 Binance K 線)**(`report_runner._subprocess_env`;策略子程序不變):
  沒有 Blave 資料權限時,排程的台股大盤晨報／收盤報告改走 TWSE／TAIFEX 免費資料,不再 401 整份 failed。權限狀態由
  `lib/data.py` 讀外殼維護的 `.env` key(空 = 無權限;經 `_retry_get` 的端點回 401／403 ERR007／ERR005 同義——
  台指期 K 線、`fetch_db_kline`、內外盤三處直接 `requests.get` 的只認空 key),只在有排程旗標時這樣讀——
  聊天回合(含自帶 key、外殼不設 `BLAVE_DATA_ACCESS` 的那種)照舊收到原始 403／401。

## 1.1.96 — 2026-09-25

- **有提領權限的金鑰一律拒收(Wei 2026-09-25 拍板,推翻 09-22「不擋」)**:`_binance_bind_check` 在四個 boolean 之後、交易那格之前
  看 `enableWithdrawals`,開著就 `WITHDRAW_ENABLED:` 拒絕(每個模式:電腦版、雲端、web 連接交易所都經這條);
  OKX / BingX / Bybit 也每個模式都查(`_withdraw_gate`:電腦版在 `_local_real_key_gate` 讀完帳戶之後、雲端主機／web 綁定
  在 `_cmd_credentials` 寫入前只打這一支)——`lib/account_<id>.withdraw_enabled`(OKX `/account/config` perm、
  Bybit `/user/query-api` permissions.Wallet、BingX `/account/apiPermissions` 的 `permissions` 整數代碼:三把真機實測 [2]、[2,5]、[1,2,3,5] → 1、3 = 現貨／合約交易、2 = 讀取、5 = 提領,未映射代碼一律拒;`apiRestrictions` 的 enableFutures／enableSpotAndMarginTrading 開了交易也回 False,不能拿它判交易),True → `WITHDRAW_ENABLED`、
  讀不到 / 不是 bool → `UNKNOWN`,fail-closed;`_WITHDRAW_CHECKED` 列的那家 lib 缺這支函式照「no permission check」拒絕。
  Gate.io 沒有可查的欄位,不在表上、外殼連結框改提示用戶自己確認。只在綁定當下擋:電腦版 24 小時重查不看提領、不通知。
  測試 `tests/check_credentials_withdraw_gate.py`、`tests/check_local_real_key_gate.py`。
- **已知窗口(刻意不放行)**:雲端主機 runtime 發版後 ~5 分鐘全機隊吃到,workspace 只在用戶說「更新」才換——
  workspace 還是這一批之前的版本(lib 沒 `withdraw_enabled`)時,綁 OKX / BingX / Bybit(web 連接、聊天貼 key 都算)
  一律 `no permission check … run 更新 blave agent first` 拒絕、不寫入,更新 workspace 後即可;已綁的金鑰不受影響。
  電腦版沒有這個窗口(runtime 與 lib 同一包出貨)。出貨順序:先 push repo(VERSION 亮提示)再 publish runtime。
  矩陣 `tests/check_version_matrix.py` V1-11 / V1-05 把這條拒絕釘成預期。

## 1.1.95 — 2026-09-25

- **daemon 開的子程序一律 `stdin=DEVNULL`,Windows 再加 `CREATE_NO_WINDOW`**(`command_listener._child_kw`,
  50 個 `subprocess.run/Popen` 呼叫點全部經它;`local_daemon` 的對帳器 spawn 保留 `stdin=PIPE`(EOF 是它的 parent watch)
  只加 flag、帳戶讀取器與 `_pid_cwd` 同樣不繼承;`portfolio_reporter._run` / schtasks / crontab 三處也補上)。
  0.1.3 Windows 真機(Lightsail Server 2022):`_tick_one` 每分鐘開的 `wait_for_bar.py` 卡在直譯器啟動(3–8MB、單執行緒、
  只載 15 個 DLL),一小時累積 36 支,30 分鐘 timeout 的 `kill()` 只殺到 venv 啟動器、真 python 變孤兒;同一支腳本用 SSH /
  排程工作開都 0.2 秒退。差別只有一個:daemon 的 stdin 是 Electron 給的 overlapped pipe(`--secret-stdin`,parent-watch
  執行緒還 `read(0)` 掛在上面),子程序繼承了它。改 `stdin=DEVNULL` 後真機 0.2 秒退、`state/bar_wait/<name>.json` 正常更新。
  子程序本來就不該拿到 secret 通道,雲端 Linux 機一樣適用。測試 `tests/check_child_stdin.py`(AST 列舉三個檔的每個 spawn 點、
  nt 模式的 flag、`_tick_one` 真的帶 DEVNULL)。

- **`local_daemon.py` 能在 Windows 跑(電腦版 Windows x64 MVP,未經真機驗證)**:「app 沒了=停單+撤掛單」的三重保證各有 Windows
  對應——parent watch 改成阻塞 `read(0)` 執行緒 + `WaitForSingleObject(ppid)` 兩道(`select` 對 pipe 無效、父死不會 re-parent);
  鎖走 `fcntl`/`msvcrt` 雙軌,對帳器在 Windows 自己拿鎖、daemon 只確認(`pass_fds` 不可用);撤單 sweep 掛在 EOF/parent-gone 路徑
  (TerminateProcess 沒有 handler),daemon 停對帳器先關它 stdin、逾時才 kill;`<base>/current` 用 junction;L786「needs a POSIX
  system」改成「缺 fcntl 且缺 msvcrt」才拒。POSIX 路徑一字不變(`_nt()` 分支)。外殼 `shell/daemon.js` win32 收工只送 EOF、
  9 秒逾時才 kill()(darwin 不變)。測試 `tests/check_local_daemon_windows.py`、`tests/check_shell_daemon_win32.js`。
  同批:`command_listener._local_child_env` 在 Windows 從 allowlist 改 denylist(只拔 `BLAVE_*` / `ANTHROPIC_*` / `OPENAI_*`,
  SystemRoot 等系統變數才進得來);外殼對 Windows 子行程帶 `PYTHONUTF8=1`(整棵 Python 樹繼承,不然 stdout 遇 emoji 就
  UnicodeEncodeError)並對每個 spawn 帶 `windowsHide`(不彈黑色主控台);`command_listener._env_lock` 在 Windows 走 msvcrt
  鎖 `.env.lock` byte 0,與 `shell/datasrc.js` 那把互斥(之前直接不上鎖)。測試 `tests/check_local_env_windows.py`、
  `tests/check_shell_win_env.js`。

## 1.1.94 — 2026-09-25

- **電腦版雲端視角:純資料查詢一律本機查**(`agent_turn.py` `_viewing_env_segment`):行情、指標、Blave 資料、
  公開 K 線、跟主機無關的研究問題在這台電腦用本機 `lib/` 查,不交接到雲端跑(之前一律 SSH 交接,16 步/80 秒);
  只有那台主機自己的東西(部位、單、log、策略檔、回測結果、狀態)才去雲端讀。按「問的是什麼」分,不做失敗再繞的 fallback。

## 1.1.93 — 2026-09-24

- **電腦版沒資料權限那一輪,規則講真正的原因**(`agent_turn.py` `data_access_rule()` 讀外殼帶的 `BLAVE_DATA_ACCESS_WHY`:
  `signed_out` / `no_card` / `no_balance` / `unknown`,Facts 多一句事實 + 「不是 signed_out 就不准叫用戶去登入」;
  外殼 `shell/main.js` `dataAccessWhy()` 從 signedIn + account_status 的 `reason` 對出來、只在 `BLAVE_DATA_ACCESS=0` 時帶)。
  09-24 真機:用戶登入著、只是餘額不夠,agent 回「需要登入 Blave 帳號才能存取」。舊外殼不帶 → 原文不變。
  測試 `tests/check_data_access_lang.py` §④、`tests/check_shell_data_env.js` WHY 那組。

## 1.1.92 — 2026-09-24

- **電腦版沒資料權限那一輪,`lib/data.py` 第一次呼叫就停**(`agent_turn.py` `data_access_rule()` 補一句「同一段對話裡權限會變、
  失敗即最終」;workspace 端 `lib/data.py` 在 `BLAVE_DATA_ACCESS=0` 時所有打 Blave 的路直接 raise,走 blave-agent VERSION)。
  09-24 真機:餘額不夠被擋那輪 agent 不信規則、翻 .env 與環境變數 10 步才放棄,用戶等 80 秒。測試 `tests/check_data_access_gate.py`。
- **`workspace_update` 的 `applying` 有 20 分鐘時效**(`portfolio_reporter.py` `WORKSPACE_UPDATE_APPLYING_TTL_S`):更新腳本中途被砍
  (ssh 逾時、回合結束、機器重開)時狀態檔停在 `applying`,電腦版會顯示「更新中…」24 小時、檢查更新按不了;超過 20 分鐘轉成
  `failed / error / "applying timed out"`。測試 `tests/check_workspace_update_status.py` §6。
- **報告多帶 `workspace_update`**(`portfolio_reporter.py` `workspace_update()`):`manager/update_workspace.py apply` 寫的
  `state/workspace_update.json` 原樣轉發(`state: applying|done|failed`、`outcome`、`from`/`to`、`restarted`、`reason`、
  `replaced_changed`、`backup_dir`、`version_written`、`ts`),檔案不在或超過 24 小時就不帶——電腦版用 `applying` 畫「更新中…」、
  用 `done` 出事後那一行(設計 v4 §3)。workspace 端同批:更新不再問人(改過的官方檔一律換、先備份)、只在安全時刻重啟下單程式
  (`trading_busy()`:無在途執行、對帳器不在一輪之中;`--wait-busy` 輪詢),走 blave-agent VERSION。
  測試 `tests/check_workspace_update_status.py`。

## 1.1.91 — 2026-09-24

- **關閉部位後頁面立刻看到部位歸零,不再等 5 分鐘心跳**(`command_listener.py` `_kick_when_flatten_exits`、`_kick_reconciler`;
  workspace 端 `manager/flatten.py` `_kick_reconciler`,走 blave-agent VERSION)。頁面的「實際」欄讀的是對帳器寫的
  `manager/last_reconcile.json`,而平倉是另一支程序、賣完就退,對帳器要等下一次心跳才重讀(29026,09-24:03:51:41 賣掉、
  03:56:42 才不顯示 +1,000)。現在 flatten 收工時碰 `state/execution/kick`(對帳器監看的 mtime,一個 poll 內就跑一輪);
  runtime 這邊等 flatten 程序退出後也碰一次,還沒按「更新」、flatten.py 是舊版的 workspace 一樣生效(Windows 走 powershell
  起程序、等不到,只靠 workspace 端);兩次快按時輸的那支(退出碼 3)不碰,由持鎖那支收工碰。HALT 下那一輪只重讀、只寫快照,
  不下任何單(本來就是:快照在下單前寫、進場腿被 HALT 擋)。flatten 留有未確認平倉的列(群益)時 workspace 端不碰、等心跳:
  群益部位快照最舊 300 秒,馬上跑一輪會對還顯示「有倉」的同一口再送一腿 reduce(sNewClose=2 變反向開倉)。
  解除綁定不用補:解綁本來就會重寫 `state/HALT`(mtime 變了就觸發一輪),全解綁更是直接停放並清掉快照。
  測試 `tests/check_flatten_singleflight.py` §4/§5、`tests/check_reconciler_autohalt.py` §3.15。

## 1.1.90 — 2026-09-24

- **模擬帳戶弄丟設定與帳本起點後的第一次儲存不再重買一次**(`command_listener.py` `_traded_on_a_real_venue`;版本矩陣 V1-10 / V0-02)。
  現在綁的就是 paper 時,paper 成交也算「交易過」:第一次儲存不寫零帳本,機器人已持有的模擬部位不會被當成用戶的再買一份。
  綁的是真實交易所時照舊不算 paper 成交(Wei 09-23 的規則不變)。測試 `tests/check_first_save_paper_history.py`。
- **`manager/` 底下的機器狀態檔不進版控、也永遠不算官方檔**(`.gitignore` 的 `manager/*.json|jsonl|tmp`;
  `manager/update_workspace.py` 的 `NEVER` 補齊 runtime／lib 會寫的那些檔、加上狀態檔樣式與 `manager/executors/`;版本矩陣 V6-03)。
  以前只擋 `portfolio_config.json` 與 `amounts.ui.json`,誤提交一個 `order_errors.json` 就會被複製到每台機器、或卡住 VERSION。
  測試 `tests/check_manager_state_never_official.py`(列舉每個寫檔點)。
- **解綁 → 重綁 → 啟動下單兩個卡點**(`command_listener.py`;模擬情境矩陣 TC-28、TC-13)。① 解綁確認停掉對帳器時寫
  `state/reconciler_stop_mark`,之後不比它新的心跳一律不算「正在跑」:15 秒內重綁再按啟動,不再回「已在跑」卻什麼都沒起。
  ② 全解綁把舊帳戶的快照(`manager/last_reconcile.json`)與帳戶守門狀態(`state/venue_account.json`)停放到
  `state/unbound_account_state.json` 再清掉;重綁時帳戶識別相同就原樣還原(行為照舊),不同就丟掉,新帳戶第一次啟動
  不再因舊帳戶的部位觸發守門。帳戶識別=交易所金鑰值的 sha256(同 reconciler `_key_fingerprint` 的規則)加
  `PAPER_BOUND_TS`(模擬帳戶每次新綁都是新帳戶)。測試 `tests/check_unbind_rebind_account_state.py`。
- **電腦版可以綁 OKX、BingX、Gate.io、Bybit 的真實金鑰,先過交易所自己那一關才寫入**(`command_listener.py`
  `_local_real_key_gate`、`_LOCAL_KEY_CHECKS`;`local_daemon.py` 的 `LOCAL_OPEN_VENUES`)。寫 `.env` 之前用這次送來的
  金鑰呼叫 `lib/account_<id>.get_equity` 一次(`.env` 裡同一家的舊金鑰不代打;`*_DEMO` 這類旗標照讀),失敗就什麼都不寫、
  回 `REJECTED: <交易所的錯誤>`(金鑰值與網址遮掉),缺欄位回 `INCOMPLETE_PAIR`,讀不懂回 `UNKNOWN`。沒有檢查的交易所
  (或 workspace 沒有那支 `lib/account_*`)照舊一律不寫。對話綁定在電腦版仍只開 paper。測試 `tests/check_local_real_key_gate.py` §4c。
- **回測正確性五修(lib／manager 層,出貨走 blave-agent VERSION,不是 runtime publish)**:① 每次回測自動跑「截斷不變」檢查(`lib/runner.py` `_enforce_lookahead` 等),截掉尾端再重算 fetch_data＋compute_signals,已存在的 K 棒部位一變就拒絕回測、印「偷看未來」、不寫 stats.json/版本;無法重現(非決定性、fetch_data 走 lib.data 以外)只警告。② runner 無效 K 棒過濾補上 Open(Open=0、Close 有效的棒原本記成 −100%,聯電期 CCF 2020-05-14 實例)。③ Type C 範本/範例:`rank(method='first')`(同分讓權重和變 1.5/0.5)、`_rebalance_mask` 改每期第一根(舊版 `shift(-1)` 讓上線每根都再平衡;既有 Type C 回測數字會變、舊寫法會被 ① 擋下);runner 對權重列總和 >1 或 NaN 警告。④ 加密 K 線形成中那根不再進訊號:`lib.data.closed_bars_only()` 由 runner 與 `wait_for_bar` 包住 fetch_data,fetch_kline／fetch_kline_batch／fetch_bingx_kline 在範圍內丟掉 label+interval>now 的棒(範圍外不變)。⑤ `txf_settlement_mask` 迴圈上界多看一根 K 棒:上線 tick 的最後一根就是結算前那根時原本標不到(回測有平倉、上線抱過結算)。測試 `tests/check_lookahead_guard.py`、`check_runner_open_zero.py`、`check_typec_template.py`、`check_kline_forming_bar.py`、`check_settlement_mask_live.py`。
- **外部資料依發佈時間對齊(R2,lib／manager 層,同上走 blave-agent VERSION)**:`lib.data.align_feed` 以 `FEED_TIMING`(各 feed 的發佈時間與出處,不確定的標 待確認)把非價格資料接到「發佈時間 ≤ K 棒收盤」的那根;該到未到的列:歷史中段給 NaN、回測尾段截掉、上線(runner 與 `wait_for_bar` 的 `live_feeds()` 範圍)丟 `FeedNotPublished` 拒算。`wait_for_bar` 把它當「未就緒」(不發 fetch_error、不退避),從該列應發佈的時間起算 15 分鐘才告警並點名 feed。回測的偷看未來檢查改以發佈時間截斷已記錄的 feed,日資料直接 ffill 到盤中 K 棒會被擋。配方與發佈時間表在 `references/strategy-code.md` › External data。另:Type C 無效格(Open／Close 為 0 或 NaN)不再記 −100%(`lib/runner.py` `_fill_invalid_cells`);`examples/tw100_foreign_zscore` 權重欄位對齊 price_df;`wait_for_bar` 的新鮮度比對先把帶時區的 K 棒轉 UTC(原本台北時間當 UTC,早 8 小時判就緒)。測試 `tests/check_feed_alignment.py`、`check_typec_invalid_cells.py`、`check_wait_for_bar_tz.py`、`check_typec_template.py`。範本 `examples/tw100_foreign_zscore`、`tw2317_broker_zscore` 改用 `align_feed`(日 K 數字不變、上線多了未公布就拒算的閘門),測試 `check_examples_align_feed.py`;`align_feed` 遇到整個空的 feed 改丟清楚的 ValueError。
- **外部資料發佈時間全數查證(lib 層,走 blave-agent VERSION)**:`FEED_TIMING` 改為「官方發佈與 Blave 實際供應取較晚者」——TWSE Data E-Shop 產製時間、FinMind 更新時間、證交法 §36 與金管會《財報及營運情形公告申報特殊適用範圍辦法》(金融業 Q2 8/31、保險業月營收 15 日),加上 api 快取(台股日資料 5 分鐘;月營收／財報／外資持股按 UTC 日快取 → 隔日 08:00)與分點 job 實測(09-23 21:31 寫入)。TWSE 成交量、PCR、集保週資料官方無公布時間,保留保守值並註明。30 天財報／月營收本機快取在申報期限過後自動重抓。新增 `lib.data.join_tw_flow`:台股日頻籌碼(期貨法人、個股法人、大盤法人、融資、PCR、本益比、分點)一行抓取並依發佈時間接上 K 棒,配方與指標在 `references/strategy-code.md` › Taiwan daily flows,AGENTS.md 一句指路。測試 `tests/check_tw_flow_helper.py`。
- **Type C 回測報告不再缺欄(lib 層)**:`stats.json` 補上 `fee [%]`(報告讀的鍵,原本只寫 `fee`,顯示「手續費 —」)、`Sortino Ratio`、`Omega Ratio`(由投組自己的逐根報酬計算,同 Type A 的 `compute_stats`);`fee` 保留。測試 `tests/check_typec_stats_keys.py`。
- **`lib/exits.py` 加進 agent 不能改的 lib 名單**(`agent_turn.py` `PROTECTED_EDIT_RULES` 多一條 `Edit(/lib/exits.py)`):
  停損／停利／移動停損／時間停損改成 lib 函式 `apply_exits`,agent 只呼叫、不改;和 runner、param_scan 同一層保護。
- **整機啟動下單(`resume` / `resume_wait` 不帶 `strategies`)沒有重開紀錄時,也會確保對帳器在跑**
  (`command_listener.py` `_ensure_reconciler_running`、`_reconciler_supervised`;`dispatch`)。原本只有
  `state/reconciler_stopped.json` 存在時才會順手起對帳器,而電腦版的雲端啟動只送這一個指令:從沒跑過對帳器的新機、
  或解綁/死掉後沒有紀錄的機器,按啟動只清了 HALT、什麼都不會下單(29026,09-23)。心跳 15 秒內=在跑、不重啟;
  沒心跳或超過 300 秒(與報告同一個窗)=起來;中間那段問 systemd/tmux/NSSM,問不出來(含 NSSM 的 `*_PENDING` 過渡態)當作在跑。網頁接著送的
  `restart_reconciler` 照樣吞掉一次;起不來 ack 失敗並帶原因。電腦版本機(`BLAVE_AGENT_LOCAL`)不變。
  `resume_wait` 的閘門照舊:新對帳器第一輪零筆單。測試 `tests/check_machine_restart_stop.py` §6b。
  配套(workspace 端,`manager/reconciler.py`):對帳器開頭先鎖 `state/reconciler.pid`(flock/msvcrt),同一個 workspace
  第二支直接以 75 離開、不跑任何一輪也不掃單;兩個看門狗包裝遇 75 安靜重試、不發重啟通知。測試 `tests/check_reconciler_singleton.py`。
  runtime 自動更新比 workspace(按「更新」才到)早,舊版 reconciler 不拿那把鎖:三條起對帳器的路(雲端啟動、重開後的啟動、
  明確的 `restart_reconciler`)起之前都先讀行程表(`/proc`,Windows 用 Win32_Process),本 workspace 有**不在 systemd／tmux／NSSM
  底下**的 reconciler.py 行程就不起第二支(`_stray_reconciler_pids`;明確重啟回失敗並帶 pid)。在監督底下的(卡住的也算)
  照舊由那次重啟換掉。只認真的執行(`python [選項] …/reconciler.py`),`-m py_compile`、`-c` 不算。
- **回合出錯也會清掉雲端交接的金鑰**(`agent_turn.py` `_remove_cloud_handoff_dir`,在 `run_turn` 的 `finally`):
  `<workspace>/tmp/cloud-handoff/`(短效 SSH 金鑰與憑證)原本只靠 agent 在回合結束前自己刪,回合撞 max_turns、
  半途或崩潰時沒機會刪,就留在磁碟上等下一個回合碰巧清。現在不論怎麼收場都清;不存在不出錯,只動那一個路徑
  (它是連結只拿掉連結、`tmp` 指到 workspace 外面整個不碰)。行程被直接殺掉時仍跑不到,那時靠下一回合的規則。
  測試 `tests/check_cloud_handoff_cleanup.py`(真的跑一個撞 max_turns 的回合)。
- **雲端視角提示多一句:`references/cloud-handoff.md` 不要一次 cat 整份**(`_viewing_env_segment`):
  那份檔 56KB,cat 的輸出會被截斷,每個雲端回合多花一步重讀。說法不綁引擎——有讀檔工具就用,沒有就 `sed -n` 分段讀
  (Codex 也吃同一段 prompt,它沒有 Read 工具)。

- **電腦版沒有資料時講的條件,補上「按小時付費」這條路**(`agent_turn.py` `data_access_rule()` 的 `access == "0"`):
  沒有主機也能買資料之後(api `3417d589`),`0` 的來源只剩沒登入、這一小時付不出資料費(`data_access = none`)、
  或舊 api 且不含資料。原本條件只列試用與雲端主機,會把付得起每小時資料費的路講漏,等於叫人去開主機。
  現在事實與「回覆必須講的條件」都含「餘額付得起這一小時的資料費」。仍然不給指路、不報價(錢與動作由外殼的卡講)。

- **回覆語言判定改成「有漢字就是中文,除非有英文句子的證據」**(`agent_turn.py` `_is_zh`)。舊判定比字元數
  (漢字 >= 3 且壓過英文字母的一半),2026-09-23 兩次判錯、整則回英文:Wei 打「做vol target到30%」(2 個漢字、
  9 個字母——台灣交易員的中文句本來就夾英文行話),以及「幫我把這組 Binance 金鑰綁到真錢帳戶:BINANCE_API_KEY=… …」
  (15 個漢字對約 70 個字母)。現在:沒有漢字 = 不是中文(不變);有漢字時,只有**兩個以上英文文法字**
  (what / is / the / of …),或一個文法字而且英文字母至少是漢字四倍,才算英文句——「what is 台積電 price」照舊英文。
  數字母前先丟掉像識別字的片段(含 `_` `=` `/`、全大寫、夾數字的長片段),以及不是用戶自己寫的英文:
  ``` 區塊、反引號、貼上的錯誤訊息／traceback(`XxxError:`、`Traceback`、`File "…", line N` 到行尾)、
  看起來像程式的非中文片段(`= ; { }` 或字緊接左括號,`for i in range(10)` 的 for／in／i 是 Python 不是文法字;
  英文句裡的「(2330)」「[2330]」不算)。頭尾都是中文、而且有中文虛字的句子(「如果 price is above the MA 就進場」)
  直接算中文;只有股名在頭尾的英文句(「台積電 looks weak today, should I switch to 聯發科」)不算。仍然只看用戶打的字,不看介面語言
  (電腦版刻意不帶 `--ui-lang`,`shell/main.js`)。測試 `tests/check_data_access_lang.py` ③。
- **電腦版 Codex 下的 `blave` MCP 從上線起就一次都沒呼叫成功過,修好了**(`codex_engine.py` `build_args`
  多一個 `-c mcp_servers.blave.default_tools_approval_mode="approve"`,只給我們掛的這一個 server)。
  `codex exec` 寫死 `approval_policy=never`,而 Codex 把沒有標註的 MCP 工具當成要核准——兩者相遇就是
  「MCP tool call requires approval, but approval policy is never」,呼叫在送出前就被拒。受影響的是 Codex 下
  **每一支** `blave` 工具:雲端更新、送上雲端、拉回電腦、雲端策略清單、機器狀態。Claude / Blave AI 那條
  (`bypassPermissions`)不受影響。2026-09-23 Wei 切到 Codex 後按更新鈕兩次都被擋。09-22 的 Codex MCP 查證
  只驗到 Codex 送出 `initialize`(握手),沒有在 `exec` 底下真的呼叫過一次工具,所以沒抓到;而拼錯的 `-c` 鍵
  Codex 會默默忽略,只看 argv 的測試抓不到。新增 `tests/check_codex_mcp_live.py`:用本機裝的 codex 執行檔、
  假模型、假 MCP 跑真的回合,驗「照出貨的 argv 呼叫送達」「拿掉這個旗標就被擋」「別的 MCP server 仍被擋」
  (0.155.0-alpha.9.2 與下限 0.146.0 都過;找不到 codex 就 SKIP)。

- **對帳器只碰 Blave 自己開的部位**(Wei 09-23;設計 `.claude/output/specs/reconciler-own-positions-only-2026-09-23.md`)。
  lib:`lib/portfolio.own_positions_only(config)`——設定檔沒有明寫 `"self_ledger": false` 的機器一律拿帳本(自己的成交)
  比對、定量、平倉,不再把整個帳戶當成機器人的;`execute.py` / `venue_wiring.py` / `manager/flatten.py` 的旗標判斷都改走它。
  沒有帳本基準(`seeded_at` 空)時第一輪自己寫(Wei 09-23 拍板):每個標的,帳戶與目標**同方向**時 Blave 擁有
  min(|帳戶|, |目標|),其餘是用戶的;沒有策略在交易、目標是平的、或帳戶跟目標反方向(目標多、帳戶空)→ Blave 擁有 0。
  這條規則本身永遠不會賣東西(收進來的份額不超過目標)。模擬帳戶同一條。數量照同比例切帳戶的數量,讀不到(現貨)就是 legacy 列。
  只有 TWAP / 追價還在跑時延後(那一輪只讀,快照 `needs_baseline: {"reason": "inflight"}`)。不再 raise。
  對帳器還沒跑過第一輪時「全部平倉」不平任何合約部位(講清楚原因);之後只平帳本那一份(數量 = min(帳本, 帳戶))。
  現貨同一條:錢包是 Blave 與用戶的同一池,「全部平倉」與對帳器的現貨賣單都只賣 min(帳本數量, 錢包);帳本列沒有數量(legacy)
  的現貨**不賣**、記一筆原因(舊的全部平倉會把策略幣種的整個現貨庫存賣掉,含用戶自己的幣)。遷移收現貨時數量取錢包的同比例。
  下單路徑稽核 09-23 補:① 遷移收進來的數量用該交易所 order lib 的 `format_qty` / `format_spot_qty` 往下取到整數步長
  (按比例切出來的 0.0012 BTC 平倉時只平得掉 0.001、剩下的被註銷後留在交易所);② **帳本按交易所分開**(基準列 key
  `交易所|標的`、成交看 `exchange`),對帳器只用它下單那一家的帳本,全部平倉每家只平自己那份——綁兩家時不再平到另一家的手動部位,
  模擬改路由到 Binance 不再賣用戶在 Binance 的幣;③ 遷移閘門改看基準裡的 `own_only_basis: 1`(只有新 lib 寫),不再只看
  `seeded_at`——新 runtime 在舊 lib 旁解除綁定寫的基準不算數;runtime 的解除綁定歸零只在磁碟上的 lib 已有此規則時才寫(帶標記);
  ④ 遷移只在輸入可信時寫(已存金額、有金額的策略 state 讀得到、數量讀取沒失敗、連兩輪看到一樣的部位、沒有進行中的 TWAP/追價),
  否則那一輪只讀、`needs_baseline.reason` 說原因;⑤ 沒有數量的現貨帳本列在建帳本時註銷一次,不再每輪報錯、不擋進場。
  Delta 2 補:⑥ 取整改在**基礎幣**上做(`_lot_base`),`format_qty` 只當閘門——OKX / Gate.io 的回傳是合約張數,原本會收成
  1/ct_val 倍、當輪把整個標的 reduce-only 賣掉;七家(Binance、OKX、Gate.io、Bybit、BingX、模擬、群益口數)各有測試;
  ⑦ Wei 拍板:帳戶名目 ≤ 1.5 倍目標(`_ADOPT_WHOLE_RATIO`)整份收成 Blave 的,成本記目標;超過才切;
  ⑧ 沒有 `symbol` 的策略狀態(Type C)不再卡遷移;同一個非暫時理由等 3 輪＋10 分鐘就退回「讀得到的照規則、讀不到的算用戶的」,
  記 audit＋一筆下單錯誤,出場單恢復;⑨ 沒有交易所的舊帳本列在新 lib 第一次讀到時歸位。
  Delta 3 補:⑩ 讀不到 state 但知道交易哪個幣的策略,只有那個幣等(基準的 `pending`,對帳兩邊都不算),策略恢復後照規則收進來,
  不再疊買一份;全台退回只剩「連幣都查不到」的時候;⑪ 舊列歸位:綁兩家以上改看成交紀錄的 `exchange`,沒有證據或互相矛盾 →
  停在 `?`,哪一家都不讀、報一次錯。
  快照多 `own_only: true`。電腦版部位分頁:「實際」改成 Blave 的帳本,帳本上沒有的帳戶部位畫成中性的「不歸 Blave 管」,不再上紅色「賣」。
  runtime:回報的 `self_ledger` 改報「真的在跑的碼是不是只碰自己的部位」(明寫的旗標照用;沒寫 → 對帳器在跑看它快照的
  `own_only`,沒在跑看磁碟上的 lib),舊 lib 照舊報 false、確認框照舊警告;新機建檔的「交易過」只算**真實交易所**的成交
  (Wei 那台兩筆模擬成交讓 Binance 的設定沒開帳本,手動多單被當成機器人的);**完整解除綁定時帳本歸零**(key 沒記交易所,
  舊交易所的成交會被當成下一家的部位賣掉)。出貨順序:runtime 可以先(回報靠證據,不會對舊 lib 說謊),lib 隨 blave-agent 更新。
  測試 `tests/check_own_positions_only.py`、`tests/check_shell_own_positions.js`;`check_drift_band.py` (a)/(e)、`check_unconfigured_readonly.py` 改成新規則,
  其餘考帳戶讀取算術的測試改明寫 `"self_ledger": false`。

- **帳戶讀取器把 `accounts_partial` 傳下去**(`account_reader.read_venue`):lib 的錢包分佈讀失敗、`accounts` 只剩下單錢包時
  (`lib/account_binance.get_equity` 現在會標),回報帶 `accounts_partial: true`。電腦版權益曲線靠它不把那一輪記成全帳戶
  (那一輪記下去,當日損益會是 −82% 這種假數字)。舊 lib 不標,行為同以前。

- **投資組合(Type C)策略接上自動下單**(Wei 09-23;設計 `.claude/output/specs/typec-live-2026-09-23.md`)。
  lib:live tick 寫 `state.json` = `{"type": "portfolio", "market", "weights": {SYMBOL: w}, "rebalance_at", "bar_at"}`
  (`lib/runner.typec_live_state`,權重矩陣最後一列,跟回測下一根持有的那一列相同);`aggregate_portfolio` 每個資產 `金額 × w`,
  跟同標的的其他策略淨額相加,現貨每支策略的負權重先壓 0;再平衡之間權重不變 → 目標不變,帳本不因價格漂移交易;掉出權重的資產只平
  Blave 帳本那一份;口數/股數的 Type C 這版不接(略過並 warning);沒有 `weights` 的舊 state = 還沒有 live 目標。`save_state` 改成
  tmp＋replace(寫到一半的 state 會讓那支策略的目標整輪消失)。runtime:`_cmd_amounts` 只在磁碟上的 lib 能交易 Type C 時才接受
  撥款(回報新增 `can_trade_portfolio`,電腦版部位分頁據此解鎖);`resume_wait` 對 Type C 記 `rebalance_at`,下一次再平衡才開始交易。
  回報的 `states` 對 Type C 多帶 `type`、`weights`(驗證過:標的正規化、只收有限的非 0 數字、最多 100 個、權重大的優先)、
  `rebalance_at`——網頁 `pfClientTargets` 與電腦版 `trClientTargets` 才拿得到權重。電腦版部位分頁的目標算進 Type C 每個資產。網頁 `workspace.html` 的目標計算與撥款鎖交前端。測試 `tests/check_typec_live.py`、
  `tests/check_shell_own_positions.js`。

- **現貨買進的手續費不再讓全平賣到用戶的幣**(testnet harness 抓到):交易所回報的 `executed_qty` 是扣手續費前的量,手續費用買到的幣付時
  錢包只收到 executed − fee,帳本卻記 executed,每一次全平(含全部平倉)都多賣一筆手續費的用戶幣。帳本改記真正到帳的量
  (`lib/venue_wiring.spot_book_qty`:Binance / OKX / Gate.io 讀 commission + commission_asset,Bybit 買單手續費一律是幣;BNB / USDT
  付的不扣;不回報手續費(BingX)→ 少記 0.2% 並寫 audit `spot_fee_unknown`);市價、TWAP、追價、custom 的入帳點都改用它,
  `executed_qty` 的意思不變。測試 `tests/check_spot_fee_book.py`。

- **模擬情境 harness 抓到的五個下單路徑 bug**(`tests/check_paper_scenarios.py`,matrix `.claude/output/specs/paper-scenario-matrix-2026-09-23.md`):
  MG-10b 寫基準那一輪也把等待中的幣排除在對帳外;TC-22 市價單也寫 in-flight 標記(寫進 `orders.jsonl` 才移除),在成交與記帳之間被殺掉時,
  下次啟動 `reap_dead_inflight` 會 HALT,不再重買一份;MP-04 單向持倉帳戶上 Blave 的部位被淨進用戶反方向的倉時,出場改送一般單、剛好是
  帳本那份,用戶原本的倉位復原(各家單向/雙向偵測:`venue_wiring._net_position_mode`,測試 `tests/check_net_mode.py`;全部平倉在 HALT 下,
  order lib 擋非減倉單,那份留著);ED-25 全部平倉對口數/股數部位(unit "contracts")照口數平;ED-12 用帳本定量的平倉不再先讀市價。

- **下單路徑稽核 Delta 4**:① 單向帳戶的淨額出場要有進場時記下的 `netted_qty`(上限就是它)、連兩次讀到、帳戶模式讀得到才送——
  用戶自己平掉 Blave 的倉又開反向時,不再把他的倉放大(ZZ-01);② 全部平倉也還原被淨掉的份額,HALT 下只放行這一張
  (`lib.guard.netted_restore`;各家 order lib 的 HALT 檢查改用 `guard.entry_blocked()`);③ 全部平倉與 `close_symbol` 比對每一家的
  `executed_qty`,部分成交留在帳本、報「未平完」;④ 現貨手續費:Binance 市價單按每筆 fill 的幣種分開算(BNB 中途用完),追價單從
  `myTrades` 讀,Bybit 的訂單列帶 `cumExecFee`,只剩 BingX 用 0.2% 上限;⑤ 完整解除綁定不再重設帳本(按交易所分開了),只有在同一家
  綁了**別的帳戶**才把那一家歸零(怎麼認帳戶見下一條 Delta 5)。模擬情境新增 MP-04b / MP-04c,
  測試 `tests/check_partial_close.py`、`check_net_mode.py`、`check_spot_fee_book.py`、`check_own_positions_only.py`。

- **下單路徑稽核 Delta 5**:① 帳本認的是交易所自己的帳戶 id,不是金鑰(`lib.portfolio.book_account_check`,seed `venue_account`):
  各家 `get_account_id`——Binance 現貨 `/api/v3/account` 的 `uid`、Gate.io `/api/v4/account/detail` 的 `user_id`(兩支新增)、
  OKX／Bybit／BingX 原有、模擬帳戶用帳本的 `created_ts`。每次綁定(網頁、對話、電腦版都走 `_cmd_credentials`)用剛寫進去的金鑰讀一次
  並記成那一家帳本的帳戶(`_bind_book_accounts`,模擬帳戶除外);讀不到不擋綁定,改記金鑰指紋。綁定、對帳器啟動、每次金鑰變動
  (模擬帳戶含 `PAPER_BOUND_TS`)、全部平倉動手前都比一次:同一個 id 帳本照留(換金鑰不再歸零);不同 id 當場把那一家的帳本歸零再讀,
  真交易所另外 HALT,清掉 HALT 不會把舊帳本帶回來——直接覆蓋綁定、或解綁→綁別家→再綁回原交易所的另一個帳戶,都不會再賣到新帳戶裡
  用戶自己的倉。對不上(新金鑰讀不到 id,或帳本當初記的是讀不到 id 的金鑰)而那一家帳本還有部位時不猜:HALT 一次、之後每輪都不下單
  (網路類錯誤只等下一輪、不 HALT),全部平倉在那一家什麼都不平並說明;報告 `account_guard.book_hold` {venue, reason, since} 問用戶,
  新指令 `book_account_confirm {venue, same}` 一鍵回答:same=true 帳本照留、記成新金鑰的;false 那一家帳本從現在歸零(原本的部位歸用戶)。
  兩個答案都不下、不平、不撤任何單,重送不重做,寫稽核;HALT 留給用戶按啟動下單。綁定回覆多一欄 `book_account` {venue: 判定}。
  帳戶確認稽核(Delta 6)六修:① 答案只在那一家「現在正在問」、且交易所自己分不出來時才生效,過期或重送的答案回 `nothing_to_confirm`、
  什麼都不寫(答過「同一個」後另一台裝置的舊「不同」不再清空帳本);② 保留期間那一家收不到 Blave 任何單:各家 order lib 的閘門
  (`guard.check_account_hold`)連平倉、保護單都擋,進行中的 TWAP／追價在下一張子單前停下並照記已成交的量——`holds_all: true` 就是這個意思;
  ③ 綁定時讀到另一個帳戶 id:帳本照歸零,並立刻 HALT、在帳戶守門留 `bind_reset`,對帳器下一輪走原本「換帳戶 → HALT 並通知」那條路發通知
  (舊帳戶上 Blave 開的部位不再管),新帳戶在按啟動下單前不下單;若用戶已先按啟動,只補通知不再 HALT;④ 帳本空時讀不到 id 不再把驗證過的 id 洗掉;
  ⑤ 換金鑰後讀 id 一直網路錯誤、那一家有部位:最多 10 分鐘／3 輪就當成讀不到——HALT 並問用戶,不再無限期「執行中」卻每輪跳過;
  ⑥ 被保留擋下的啟動下單(`held:`)不再刪「主機重開停止」紀錄、也不起對帳器。重稽(Delta 7)補三條:換帳戶的通知就是那次 HALT 本身
  (平台的 `halt` P1 事件帶著理由到頁面／email／TG),機器端不再另發 TG、已按過啟動的也不補發;paper 永遠不被下單閘擋;
  任何一種回答都踢一下對帳器,過期的題目一個輪詢內就清掉。測試 `check_bind_account_id.py`、`check_own_positions_only.py`、
  `check_reconciler_autohalt.py`、`check_net_mode.py`。
  移除 runtime 以金鑰雜湊認帳戶的 `state/book_account.json`。群益讀不到 id,不比。api 端(`openclaw/agent_command.py` ALLOWED、
  `openclaw/desktop_auth.py` CLOUD_MACHINE_ONLY_COMMANDS)要先上,這條指令才送得到機器。
  ② HALT 下還原淨額的那一張:`guard.netted_restore` 改成只限本執行緒、只限一張、只限指定的幣／方向／不超過記錄的數量,
  由各家 `place_market_order` 用自己的單去對(`guard.arm_restore`)。③ 限價追價的進場也記 `netted_qty`(開始前讀一次)。
  ④ 一口不到 $10 的合約(Gate.io／OKX BTC 一口約 $8.4)Blave 自己的倉終於平得掉:整倉平倉門檻在一口小於 $20 時改為
  $10 減半口(`manager/reconciler._close_gate`),平的量仍以帳本為上限。模擬情境新增 TC-36、TC-37、MP-04d,測試 `tests/check_account_ids.py`、`check_bind_account_id.py`、`check_close_gate_sublot.py`、
  `check_net_mode.py`、`check_reconciler_autohalt.py`、`check_own_positions_only.py`。

## 1.1.89

- **資料規則那一段不再給模型「成品句」**(`agent_turn.py` `data_access_rule()`,`access == "0"`):
  整段改寫成「給模型的事實與約束」,並明講**用戶讀到的每一句都由模型自己用該輪語言寫、不准照抄這一段**。
  原本它用英文散文把要對用戶說的話寫成成品,模型直接抄走——2026-09-23 Wei 用中文問籌碼集中度、整則回英文,
  逐輪語言錨(貼在 prompt 最尾端的一行)打不過一句「剛好就是這則要回的內容」的現成句子。
  約束一條都沒少(缺哪些資料、怎樣才有、marker 一次對話只講一次、不要編數據、不要去別處找憑證、公開 K 線照答)。
  測試 `tests/check_data_access_lang.py`。
- **`access == "1"`(電腦版資料 key)那一段改成跟 api 現況一致**:api 已經**移除 `DATA_NOT_INCLUDED`**,
  桌面 key 不含在試用／主機／API 方案裡時不再被擋,而是跟一般 key 走同一條**按小時**的資料費
  (`decorators.py` 的 `blave_data_included` → `deduct_blave_api_credit`),扣不到才 403 `ERR007`(body 帶當下費率、
  `retry_after` 是上限不是等待時間、以及儲值／API 方案／開主機三個出口)。這一段現在講三種不同的 403——
  `ERR007`(這一小時的費扣不到)、`ERR005`(key 被刪／撤銷 → 在 app 重新登入)、`KEY_SCOPE`(越權),
  並且明說「成功的呼叫也會花到錢,只抓這一輪要用的、不要輪詢」。同樣寫成事實與約束,不給可抄的成品句。

## 1.1.88

- **回報多 `portfolio_configured`(bool,**可能整個不出現**)**:`manager/portfolio_config.json`(或平台先寫的
  `amounts.ui.json`)存在 = true。false = 從沒存過金額**而且**確定「接下來要跑的那份碼」帶唯讀閘門:對帳器活著時只認它自己
  寫的證據(`last_reconcile.json` 的 `read_only`),沒活著才看 workspace `lib/portfolio.py` 上有沒有閘門;兩者都答不出來
  就**不放這個 key**(舊機器分支,前端照舊提示會平倉)。欄位隨 runtime 自動出貨、閘門隨 workspace 半手動出貨,
  只憑 runtime 自己的行為報 false 會對「runtime 已更新、workspace 還沒」的機器說謊(稽核 09-23 B2);
  `restart_failed`(檔換好了但舊程式還在跑)是最貴的那一格。測試 `tests/check_unconfigured_readonly.py`。
- **`_fresh_portfolio_config()` 的「這台交易過」只看 `manager/orders.jsonl`**:不再算 `last_reconcile.json`——唯讀那輪
  照樣寫快照,於是用戶**第一次**存金額的設定檔少了 `self_ledger`,下一輪把他自己的手動部位平掉(稽核 09-23 B1,真錢)。
  測試 `tests/check_unconfigured_readonly.py`、`tests/check_drift_band.py`。
- **VERSION 一變就推 strategies 回報(帶 `config_version`)**:jobs.json 新增 `blave-agent-strategies.path`(api repo
  `blave_agent/systemd/`,監看 `workspace/VERSION` → `blave-agent-strategies.service`);Windows 的 `file_watcher`
  同步監看 `VERSION` → `strategy_reporter.py`。雲端更新寫完 VERSION 後 app／網頁幾秒內就看到新版本,不必等 2 分鐘 timer。
  **出貨順序:api repo 的 unit 檔要先在(publish 從 `../api/blave_agent/systemd/` 打包),再發 runtime。**
  測試 `tests/check_update_workspace.py` §8。
- **`manager/update_workspace.py`(雲端更新腳本)三修**(稽核 09-23):① clone 的驗證從 `git status --porcelain` 改成
  比對 `git ls-tree -r <expect-head>` 的 blob——官方檔清單直接來自那個 commit,所以被 `.gitignore` 藏起來的植入檔不算官方檔、
  永遠不會被複製進 workspace,`VERSION` 也一併逐 byte 驗;② Windows 的 `nssm status` 是 UTF-16,`text=True` 解出來夾著 NUL,
  **裝過對帳器服務的 Windows 機器一律卡在 plan**(`nssm_text` 修;Windows 分支仍未在真機驗過,`updating.md` §2 已寫明);
  ③ 例外不再吐 traceback:最外層包成 `"outcome": "error"` 並帶上已完成的步驟(備份資料夾建立失敗、VERSION 寫入失敗等),
  另外「plan 之後才出現的檔」不再撞 `os.path.join(None, …)`,改記成 `refused`。
  **已知、這批不修**(稽核 B5/B6/B7/B8/B10):重啟會打斷進行中的 TWAP/chase(`reap_dead_inflight` 可能直接 HALT)、
  `restart: "ok"` 只證明 supervisor 迴圈活著而非新碼跑起來、半成品(寫到一半被 `refused` 的 `lib/`)仍會重啟、
  plan 與 apply 之間用戶按了啟動下單時 `--restart-ok` 仍成立
  (文件側已改成「只有拿到用戶的 yes 才帶」)、以及舊的 tmux 機器一律 fail-closed 停在 plan(沒有替代路徑)。
  測試 `tests/check_update_workspace.py` §7b–7e。文件側順手補:`updating.md` §2 的 clone 指令加 `-c core.autocrlf=false`
  (Windows 預設會把 clone checkout 成 CRLF,逐檔比 blob 會全數不符、第一個檔就停——`cloud-handoff.md` U2 走 `GIT_CONFIG_NOSYSTEM=1`
  的 `env -i`,不受影響),以及 §2 第 3 步要在同一則訊息問重啟(`--restart-ok` 的 yes 只能是這個,否則要重啟時就不跑 apply)。
- **雲端更新只在該重啟時才重啟**(承上,原列為「已知不修」):`needs_restart` 不再把「VERSION 有差」當理由——每次真實更新
  VERSION 都會變,等於**每次更新都重啟正在跑的對帳器**,連只換 `references/` 的純文件更新也是(重啟會切掉進行中的
  TWAP/chase,還可能觸發 HALT),原本的 `touches_code` 幾乎是死碼。改成照 `cloud-handoff.md` U7 / `updating.md` §2 的字面:
  要換的檔裡有 `lib/` 或 `manager/` 才重啟;要換的只有 `references/` 之類則不重啟、VERSION 照寫。
  **VERSION 落後但三個清單全空**(上一輪檔案換完了卻沒做完重啟或寫 VERSION)仍算「上次沒做完」而重啟,U8 那條補做路徑完整。
  **「要換的檔」在 apply 是 `todo`(真的會寫的那些),不是 `changed_here` 全集**(稽核 09-23):用戶改過一個官方 `lib/` 檔
  又選擇保留時,舊算法每一次更新都會 `sudo systemctl restart` 一次下單程式,而**一個 byte 都沒寫**,且 `outcome` 永遠 `partial`、
  VERSION 永遠寫不下去——更新燈對那台永遠亮著、U9 的「再按一次更新就能補完」永遠不會成真。plan 看不到 `--allow`,所以 plan
  仍照最壞情況回答(那正是 U5 要問用戶的那一題);apply 看得到,就只算真的要寫的。
- **重啟失敗會被記住**:`state/update_restart_pending.json`——新 `lib/` 已在磁碟、舊 `lib/` 還在跑著的程序裡,而**之後任何一輪的
  檔案清單都看不出這件事**(清單只比磁碟與 clone,磁碟已經是對的)。於是重啟沒回到 running 的那一輪自己記下來,下一輪不管清單
  長什麼樣都欠著這次重啟;沒有這個記錄時,「上一輪換了 `lib/` 但重啟失敗、這一輪只剩一個非碼檔要換」會安靜地寫下 VERSION、
  對平台回報「已更新」,而下單程式還在跑舊碼。重啟回到 running、或任何一輪發現對帳器沒在跑(沒有東西握著舊碼,下次啟動從磁碟讀)
  就清掉;`not_running_anymore` 同理不寫,`skipped_not_gated` 也不寫——那裡重啟是**被禁止**而非欠著,記了只會每輪索取一個
  腳本必定再次拒絕的同意。判準依據:對帳器是常駐 daemon,啟動下單 只刪停止記錄、程序不重載碼(`manager/reconciler.py`
  › `RESTART_STOP_PATH`)。plan/apply 的 JSON 多一個 `restart_pending`;文件側同步:`cloud-handoff.md` U3(欄位)、U7、U8 與
  `updating.md` §2 重啟那組各補一句。**「讀不到對帳器狀態」算重啟失敗,不算「用戶把它停掉了」**(稽核 09-23):
  `reconciler_state()` 回 tuple(`is-active` 回 `activating`、dbus 連不上、timeout)時,舊碼 `!= "running"` 成立 →
  走 `not_running_anymore` → 清掉記錄、寫 VERSION、回報 `updated`,而 daemon 還在跑舊 `lib/`——正是記錄存在的那一格被繞過去,
  且同一個值在 run 開頭是 `raise Stop`(同值兩種相反處理)。複製檔案要時間,期間 systemd 在 `Restart=` 退避就會回 `activating`,
  不罕見。測試 `tests/check_update_workspace.py` §9–§13(四格 `needs_restart`、重啟失敗四步序列、讀不到狀態、保留檔不重啟,
  每格各帶變異驗證;另加一行把 `"RESTART_STOP_PATH"` 這個字串 probe 釘在**真的** `manager/reconciler.py` 上——
  `runtime/command_listener.py:1519` 的孿生 probe 也吃同一個符號,改名的話兩邊一起靜默翻面而測試全綠。
  `lib/portfolio.py` 的 `def portfolio_configured(` 同理,補在 `tests/check_unconfigured_readonly.py`)。
  **已知、這批不修**:① 上一輪 `failed`、這一輪 `skipped_not_gated` 時記錄不清但 `complete` 仍成立,
  機器照樣寫 VERSION、回報「已更新」,而沒有 gate 的對帳器繼續拿舊碼下單——這是 U7 現行契約(「Without the gate … that is
  not a failure」)的後果,U7 已補一句寫明後果(舊碼續跑到用戶自己停掉對帳器、VERSION 照樣寫),要堵得先改 U7 的語意;② 記錄分不出「現在跑的是新碼還是舊碼」,daemon 自己
  重開過(reboot / crash)之後記錄仍在,下一次更新會多問一次、多重啟一次——取捨是寧可多重啟一次,不要漏重啟一次;
  ③ `restart_reconciler()` 把 `sudo` 的 rc 與 stderr 丟掉,只回 True/False:沒有 `provision.sh:298` 那條 sudoers 的舊機
  會每輪 `restart_failed`、記錄永在、VERSION 永不寫,而用戶與 agent 都無從分辨這是永久性(缺 sudoers)還是暫時性的——
  建議之後在 JSON 加 `restart_error`(rc + stderr 前 120 字);④ **S2**:腳本以 `python3` 執行,`PYTHONPATH` / user-site
  `.pth` / shell function 都能換掉真正跑的東西(一行 `/usr/bin/python3 -I` 可收);⑤ **S3**:`write_atomic()` 的
  `shutil.copyfile(src, tmp)` 會跟 symlink——預先放一個 `lib/data.py.update-tmp` 指到 workspace 外,官方內容會寫出去一次
  (下一輪 `plan` 才 fail-closed);`api/blave_agent/control/updater.py` 的 `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW` 可照抄。
  ④⑤ 都在「攻擊者已經是機器上的 `blaveagent`」這個 Accepted limit 內,沒有提權。

## 1.1.87 — 2026-09-23

- **電腦版 `mcp_rule` 加雲端更新例外**:掛 `blave` MCP 時,可寫範圍多一條 `references/cloud-handoff.md` ›
  *Updating the cloud machine*(用戶在這段對話要求才做、只寫官方 clone 的整檔、永不碰 `control/`)。Wei 09-22:
  電腦版任何動作都不觸發雲端 agent 回合,雲端更新改由本機 agent 經 MCP 做;規則另加一句:不得經 SSH 在雲端開 agent
  回合(不跑它的 runtime 或 agent,會扣雲端 AI 額度)。測試 `tests/check_local_mcp_config.py`。
- **回報分清「沒有設定檔」與「讀不到設定檔」**:`portfolio_config.json` 不存在時 `config` 照舊 `{}`;
  存在但讀/解析失敗(或不是 object)改回 `config: null`。原本兩者都是 `{}`,電腦版存金額會當成「目前沒金額」
  把主機上其他 key 整份蓋掉。null-safe 只對讀取側成立(api `_funded(None)` 直接跳過,比 `{}` 更不會誤報
  deployed;web 顯示照舊);web 與電腦版存金額時須另擋 null(另批修)。測試 `tests/check_report_config_read.py`。
- **主機重開機=自動下單停止(Wei 09-22,fail-closed;疊加在 downtime watch 之上,`downtime-lib-freeze` 那套 lib 擱置不出)**:
  `command_listener.run()` 在排程執行緒與輪詢之前比對開機識別碼,記在 `state/boot_id`(Linux `boot_id`;Windows
  `GetTickCount64`,tick 比紀錄小才算重開,watch 迴圈每 5 秒把紀錄跟上,不看 wall clock)。換了 → 重開前對帳器活著
  (心跳在 `downtime_watch` 戳記前 300 秒內;已 HALT 也算,HALT 內容不動)就**先**寫 `state/reconciler_stopped.json`
  與事件 `machine_restart_stopped`,**再**把這次開機起來的對帳器停掉(停不掉重試一次);停成功才在紀錄補 `stopped_at`。
  停不掉:一律寫 `audit.jsonl`;workspace 的 `manager/reconciler.py` 沒有閘門(找不到 `RESTART_STOP_PATH`)時改送事件
  `machine_restart_stop_failed`(`down_from`、`down_to`;api 要先登記),**只送這一則、不再送 `machine_restart_stopped`**(免兩則說法相反的 P1)。**紀錄在的期間一張單都不下**:對帳器每輪先看紀錄、
  整輪跳過,解除那輪 `force_next`;`place_order` 開頭也擋;`lib/execute` 的 TWAP/chase/custom 切片看到紀錄就停;
  `lib/guard.check_restart_stop` 擋在每個 `lib/order_*` 的共同關卡(進場、平倉、SL/TP 都擋,只放撤單與槓桿)——
  Type B 策略、agent 自己的腳本一樣被擋。這幾半隨 workspace 出(要 bump blave-agent `VERSION`),沒更新 workspace 的機器
  只靠殺。**不掛 HALT**。第一次無紀錄、runtime 換版、電腦版 local mode 都不動。回報 `reconciler.stopped =
  {reason: "machine_restart", at, gated}`,期間 `alive: false`;`gated: false` = workspace 對帳器沒有閘門且停止後還在打
  心跳(可能還在交易)。**只有整機 `resume`/`resume_wait`(用戶的啟動下單)能解除**:對帳器 15 秒內打過心跳且晚於
  `stopped_at`(沒有就晚於偵測時間)→ 只刪紀錄(即解除)、不重啟;否則啟動它(電腦版雲端啟動不送 `restart_reconciler`);
  啟動失敗或紀錄刪不掉都 raise(ack 失敗帶原因)、紀錄保留。兩種成功都吞掉網頁跟著送的那一個 `restart_reconciler`
  (只吞一次,停止後即失效);紀錄在時單獨來的 `restart_reconciler` 一律拒絕。Windows 每次 listener 啟動(含 runtime
  換版)在停止之後把對帳器服務校正成 DEMAND_START,結果只寫到 `deployments.json` 既有的 reconciler 那筆,失敗一律進 log。
  平台的 `close_all`(網頁「暫停並關閉部位」)照樣平倉:listener 不掛 HALT(workspace 對帳器沒有閘門時照掛,否則舊對帳器
  下一輪會把部位建回來)、寫一次性 `state/close_all_pass.json`(120 秒)再起
  `flatten.py`,flatten 以 `guard.claim_close_all_pass()` 認領(原子 rename,一次性,只放行該行程的 reduce;進場與 SL/TP
  照擋),平完紀錄仍在、機器仍停;ack 為 `close_all=restart_stopped:<狀態>`。沒有 pass 的 flatten(agent 自己跑)什麼都不平、
  寫 order_errors(文案叫用戶到交易所自己平,啟動下單不會平倉;MVP 停止狀態沒有平倉鈕)。Type B:`run_strategy.sh` 看到紀錄就記一行 log、exit 0、不碰 heartbeat,healthcheck 把紀錄期間的過期
  heartbeat 當暫停、不報。群益的檢查移到三個 `place_*` 開頭(SKCOM 登入之前)。paper `reset_account` 放行。HALT 拒單數
  也算紀錄期間被拒的進場。已知行為(Wei 裁定):停損停利也擋,紀錄若恰好落在 `open_position` 進場成交與掛 SL/TP 之間,
  該部位到按「啟動下單」前沒有停損(開機後數秒的窗口;交易所上已掛的停損不受影響)。
  回報 `reconciler.stopped.recomputed`(bool):所有有金額的 Type A/C 策略都已經算到「開機那一刻最新收盤的那根 bar」
  (`state/bar_wait/<name>.json` 的 `last_processed_bar` ≥ 那根的開盤標籤;或開機後檢查過、資料沒有比已處理的更新=休市/資料停住)
  才是 true,前端在 false 時把「補齊部位」灰掉(`等新訊號` 照常);沒有這類策略=true;沒綁交易所(排程不跑)=true。
  `_cmd_resume` 不加拒絕路徑。Type A/C 在停止期間照常由 runtime 排程計算。
  `gated` 改看正在跑的行程:對帳器每輪跟心跳一起 touch `state/heartbeat/reconciler.gated`(只有新版會寫),listener 與
  reporter 在對帳器正在跑時只認這個標記(≥ 心跳 − 10 秒);在跑卻沒有新鮮標記(舊行程,或剛起來還沒跑第一輪)一律當沒閘門;
  沒在跑才看磁碟上的 `reconciler.py`(下次啟動載入的就是它)。`close_all` 只有在「對帳器確認有閘門 且 `flatten.py` 會認領
  pass」時才不掛 HALT,其餘照舊同步掛;pass 寫不進去 ack 回 `nothing_closed` 不起 flatten,flatten 起不來就刪掉 pass。
  開機識別碼換了、但 downtime 戳記比這次開機還新(有舊 runtime 在這次開機跑過:降版再升版)→ 只補記、不停機。
  未來時間的 pass 無效。
  `recomputed` 的「停滯=已最新」只在開機後那次檢查沒失敗時才算(`last_attempt_failed_at`/`wrapper_error_alerted_at` 晚於
  `down_to` 就不算);整段包 try,任何例外=false、回報照送;`INTERVAL = "0m"` 不當 Type A/C。**「對帳器在跑」有兩條
  路徑、兩個門檻,不是同一件事**:啟動下單(resume)判斷「已在跑、只刪紀錄不重啟」用 15 秒內的心跳;`close_all` 與停不掉時
  判斷閘門(`_reconciler_gated`)改成跟 reporter 同一式子(停止後有心跳、300 秒內),不再是 15 秒。
  已知行為(不修,都偏 fail-closed 或很低):① 短週期策略(例如 1m)收盤前最後一根資料晚到超過一個週期、或重開機剛好蓋住
  那根收盤後的一個週期、或開機後第一次檢查失敗接著休市時,`recomputed` 會一路 false 到市場重開——「補齊部位」整晚/整個週末
  灰掉,「等新訊號」照常可選;② 開機判斷可能漏判(fail-open)兩種:開機後 NTP 校時前 RTC 慢超過「停機時間 + 60 秒」;
  Windows 上一次開機很短且這次 runtime 起得晚(僅這種 Windows 情況需要用戶在那段短開機期間按過啟動下單才會真的在跑);
  ③ 策略的 `fetch_data` 把斷線吞成空資料(不 raise)時,`wait_for_bar` 當成「沒新資料」存檔、不寫失敗欄位,`recomputed`
  可能提早變 true、補齊用到舊訊號。官方 TEMPLATE_C 與 examples 都有 `if close_df.empty: raise`;根治要改 `wait_for_bar`
  (看到 None 而先前看過資料就記成失敗,或記「最近一次成功觀察資料的時間」),另案、要 bump `VERSION`。
  **出貨順序:api(`machine_restart_stopped`、`machine_restart_stop_failed` 型別與文案、`reconciler_dead` 遇 `stopped`
  跳過)→ runtime → web/電腦版顯示;對帳器/lib 閘門隨下一次 blave-agent `VERSION`**。測試
  `tests/check_machine_restart_stop.py`、`tests/check_reconciler_restart_gate.py`、`tests/check_restart_stop_order_gate.py`。

## 1.1.86 — 2026-09-22

- **修 1.1.84/1.1.85 雲端機全數回滾**:`codex_engine.py` 模組頂層 `import tomllib`,雲端機是
  Python 3.10(沒有 tomllib),updater 健康檢查 import 時 `ModuleNotFoundError` → 回滾。改成讀
  config 時才 import;import 不到就不掛 blave MCP(stderr 一行,回合照跑)。新增閘門
  `tests/check_runtime_py310_compat.py`:`runtime/*.py` 以 3.10 語法解析、擋 import 時就會跑到的
  3.11+ stdlib 模組/名稱與 3.12 f-string 同引號巢狀。

## 1.1.85 — 2026-09-22

- **群益「全部平倉刻意未平倉」變成 P1 通知(機器端)**:`order_errors` 的群益跳過列多帶
  `kind:"manual_close_required"`、`symbols`(逗號分隔帳本 key,如 `TMF,TXF`)、`reason:"identity"`,
  平台據此分流成新事件型別;舊欄位 `symbol`/`error` 保留給舊 api/舊電腦版。`flatten.py` 一次平倉的所有群益
  部位**合併成一列**(原本一部位一列,會擠掉 5 筆上限裡的加密錯誤);listener 的 `halted_capital_manual`
  那列從群益快照檔讀 symbols(不登入群益,讀不到給 `""`;self_ledger 開時只列帳本裡同方向的機器人部位,
  與 flatten 同口徑,讀帳本失敗退回全列),自己組列、不依賴 workspace 的
  `_record_order_error` 新簽章。**出貨順序 api → web(與電腦版 shell)→ runtime(publish)→ workspace
  (push 同 commit bump `VERSION`)**;api 先上是硬條件,反過來舊 api 只會當一般 `order_error`(不壞)。
- **群益「全部平倉」誠實化(止血)**:Windows 的 `blave-agent-web` 出廠是 LocalSystem(uid=1 實機查證),
  網頁／電腦版全部平倉起的 `flatten.py` 繼承這個身分 → SKCOM 602,群益部位根本沒平、畫面只看到 HALT。
  現在:`flatten.py` 在「非 Administrator 密碼登入身分」(token 查 `GetUserNameW` + INTERACTIVE/BATCH/SERVICE
  群組;判斷不了一律當不行)下**不送群益單**,每個群益部位記一條「請在群益下單軟體手動平倉」到
  `order_errors`,加密腿照平、HALT 照掛;reporter 的 `can_flatten` 在唯一可平 venue 是群益時回 false
  (前端只剩「暫停」);listener 對舊畫面送來的 close_all 回新狀態 `close_all=halted_capital_manual`
  (純加法,下游無比對)、不起 flatten。根治(schtasks Administrator 載具)另案。
  同批修 workspace 層 `flatten.py` 的既有真錢洞:
  - self_ledger 歸零只給真的平掉的:身分跳過、平倉丟例外、查不到價格、壞資料列、群益回 `sent` 或成交不足
    (不算已平,記錯)的標的一律不歸零;同一帳本 key 一列平、一列沒平也不歸零;任一 venue 有 order lib
    卻沒 account lib(另記一筆錯)／讀部位失敗／有部位沒 order lib／出現沒代碼的部位列時,**整個收尾掃帳本
    不做**(帳本 key 不帶 venue,分不出是誰的)。`DATA_<來源>` 金鑰不再被當成交易所(同
    `account_reader._venues`)。未涵蓋:加密 venue 回報的成交量不檢查(各 lib 回傳形狀不一,未逐一驗)。
  - 群益部位改以帳本 key(TM2610→TMF,只認「前綴+YYMM」)查帳本、記紀錄、歸零;原本用解析代碼查,永遠查不到。
  - 群益只送「TX/MTX/TM + YYMM」期貨列:選擇權列(TXO/TX1…)等其他代碼一律不送、記「請在群益下單軟體手動平倉」。
  - **已知風險、Wei 接受**:轉倉期間的非近月期貨列照今天的行為送出——平倉只能送近月 alias,所以平遠月那列
    實際是在近月下單(可能開出新倉、遠月那口沒動)。開 self_ledger 時轉倉期同一個帳本 key 會有兩列、兩列都會送,
    可能超平。根治待 capital_worker 回報 alias 當下對應的合約。
  閘門:`tests/check_capital_flatten_identity.py`(含兩份身分函式 AST 相等)。

## 1.1.84 — 2026-09-22

- **Binance 綁定不再查提領權限**(Wei 09-22 拍板:電腦版 MVP 全面不查提領):`_binance_bind_check` 拿掉
  `WITHDRAW_ENABLED` 那道——提領開著的 key 照寫 `.env`,不擋、不提醒;web 連接、電腦版、聊天綁定三條路都走這支,一起生效。
  其餘照擋:交易權限全關(`TRADING_DISABLED`)、半套、查不到/看不懂、429/418 退讓;沒白名單照舊只提醒。ack 的 `binance` 形狀不變。
  電腦版 app 那道(`shell/binance_check.js`)同步拿掉。閘門:`tests/check_credentials_withdraw_gate.py`、`tests/check_local_real_key_gate.py`。

- **電腦版 Codex 引擎掛 `blave` MCP**:`codex_engine.mcp_server()` 判掛不掛,`agent_turn` 算一次、同一個值交給
  `codex_engine.run(mcp_url=)` 與 `_codex_prompt`(`mcp_rule` 圍籬接上;`--viewing-env=cloud` 的提示段 Codex 也照真的有沒有掛)。
  接入碼只走環境變數 `BLAVE_MCP_TOKEN`(`bearer_token_env_var`),argv 只有 url 與變數名;不掛就把兩個變數拔掉再 spawn。
  **接入碼不進 agent 的 shell**:Codex 預設把整份 env 傳給 agent 跑的指令(0.150+ `ignore_default_excludes` 預設 true),
  掛上時加 `-c shell_environment_policy.filters.BLAVE_MCP_TOKEN="exclude"` 只拔這一個(`BLAVE_WEB_REPORT_TOKEN` 聊天圖鏡射要留著);
  0.155.x 的 `shell_snapshot`(stable、預設開)會把 policy 整個繞過(實測 `inherit="none"` 都漏),所以同時帶
  `-c features.shell_snapshot=false`——**掛 MCP 的 Codex 回合每條指令多約 150 ms**;另一條路 `shell_snapshot_v2`(0.155 開發中、預設關,
  用戶可開;會不會照 policy 未確立)也一併 `-c features.shell_snapshot_v2=false`。版本下限 0.146.0(`filters` 從 #34590 起);
  另外先跑 `codex -c features.shell_snapshot=false features list` 確認真的關掉(managed requirements 釘住會無聲蓋過 `-c`),
  關不掉、撞名(`mcp_servers.blave` 已存在)、用戶 config 用舊寫法 `exclude`/`include_only` 陣列(會被我們的 `filters` 頂掉)
  → 這輪不掛(stderr 一行、回合照跑)。受管層在 `-c` 之上(`/etc/codex/managed_config.toml` 40、macOS MDM
  `com.openai.codex` `config_toml_base64` 50,那裡的舊寫法陣列會反過來頂掉我們的 `filters`)→ 兩層任一碰
  `shell_environment_policy`、或讀到但解析不了,也不掛。已接受的殘留:同 uid 以 `ps -E <codex pid>` 讀得到行程 env
  (與 Claude 路徑 0600 設定檔同 uid 可讀對等)。`mcp_tool_call` 收據名改成 `mcp__<server>__<tool>`,`_tool_where` 才標得出雲端那步。
  實機:codex 0.146.0 / 0.155.0-alpha.9.2 / 0.155.1 讓 agent 跑 `env | grep BLAVE_` 皆看不到碼。閘門:`tests/check_codex_engine.py`
  第 6 節、`tests/check_shell_mcp_code.js`。

- **電腦版 A′(操作對象隨視角走)runtime 那半**:`agent_turn.py` 認 `--viewing-env`(只在電腦版外殼的雲端視角
  送 `cloud`;不設 choices,怪值與非 LocalSink 當沒送)→ prompt 多一段「這句做在雲端主機、上面的策略/頁面是
  雲端那一份」;有掛 `blave` MCP 講「先用它取得連線,再照 cloud-handoff.md 做(含 NEVER 列表)」;這輪沒掛
  (含 Codex 引擎)時改講「連不上雲端、不拿本機同名那支頂替,不用 ssh/scp/sftp/rsync、不用本機找到的金鑰/憑證/SSH
  設定連線」,對齊 `mcp_rule` / cloud-handoff.md #31。沒送時 prompt 逐字不變。tool chunk(running 與 done)加 `where`:
  `mcp__blave__*` = `cloud`;Bash 照 `|`、`;`、換行切段(不切 `&&`),剝掉 `env`/`VAR=`/`sudo`/`command`/`exec`/
  `nohup`/`timeout` 包裝後任一段是 ssh/scp/sftp、或 rsync 帶 `[user@]host:path` 參數 = `cloud`,其餘 `local`(純加法)。
  **出貨順序 runtime 先於 shell**:`parse_args()` 遇未知旗標 exit 2,外殼先送 `--viewing-env` 會讓雲端視角每輪都死。
  閘門:`tests/check_viewing_env.py`、`tests/check_shell_viewing.js`。

- **全部平倉單飛鎖**(真錢路徑):兩顆鈕永遠可按 → `close_all` 本來就會被重送,而 `_cmd_close_all` 每一筆都
  `Popen` 一支 detached `manager/flatten.py`,全無互斥。第二支不是無害重播——**群益的平倉是
  `sNewClose=2`「auto 新倉/平倉」**,而它的持倉來自 `capital_worker` 快照(可舊到 300 秒),所以第二支讀到
  一個已經被平掉的部位、送出同方向市價單 = **真的開出一口反向倉**。(加密較窄:交易所自己會擋掉重複平倉——
  單向倉有 `reduceOnly`,hedge 模式 `positionSide`/`posSide` 釘住槽位,超量平倉是被拒不是翻倉——但仍會把
  `orders.jsonl` 的平倉腿記兩次、和 `zero_ledger_symbols` 搶寫。)
  修法:`flatten.flatten()` 開頭取 `state/flatten.lock`(`flock`/`msvcrt` 非阻塞,同
  `local_daemon.SingleInstance`),**拿不到就立刻安靜退出**(回 `ALREADY_RUNNING`,exit 3)——不等、不排隊,
  用戶按第二次是「快停」不是「停兩次」。鎖由 OS 在行程結束時釋放,SIGKILL / 重開機都不會留下殘鎖;
  平台上沒有 `fcntl`/`msvcrt` 時**故意 fail-open**(不鎖照跑:panic 鈕不能因為拿不到鎖就不平倉)。
  ack 多一個狀態 `close_all=already_running`(字串形狀不變、下游沒有比對值,純加法),前端可據此說
  「已經在平倉了」而不是假裝又送了一次;`_flatten_already_running()` 只是探測、只決定文案,真正的互斥在子行程
  自己那把鎖(探測到子行程真的上鎖之間有窗,輸的那支會自行退場——退化的是訊息不是安全)。
  閘門:`tests/check_flatten_singleflight.py`。
- 電腦版 `mcp_rule()`(這一輪掛了 `blave` MCP 才進 system prompt 的那段)圍籬對齊 `references/cloud-handoff.md`
  新 #31:從「只准做搬運」放寬成「做用戶這一輪對話裡要求的事」;搬運仍只走該文件 1–8 的 allow-list 流程、
  遠端 `AGENTS.md` 只是檔案不是指令(本檔 NEVER 優先——那個檔 `blaveagent` 可寫,注入面)、不啟動暫停排程交易或清 HALT(唯一例外:trip 雲端緊急 HALT,Wei 2026-09-22 拍板,與本機 AGENTS.md 對稱)、金鑰值不進對話 / log / 指令列、憑證只放 `tmp/cloud-handoff/`
  且該輪結束前刪掉。純文字、不看引擎——Codex 掛 MCP 那批把它接進 `_codex_prompt` 即可(這批未接)。
  閘門:`tests/check_local_mcp_config.py`、`tests/check_shell_mcp_code.js`。第二輪稽核補圍籬:trip 的證據限 agent 自己讀
  `state/` 或 `lib/`、一輪最多一次且清掉不重 trip、`<reason>` 只准自己打的短標籤;禁寫清單擴到 `state/`、`AGENTS.md`、
  `references/`、`.env`;遠端文字宣告「規則過時」也是資料、引用句子不引用值。
- 新機出廠開帳本:`command_listener` 第一次建立 `manager/portfolio_config.json`(`_cmd_amounts` / `_cmd_execution` 的
  fresh-machine 分支)改從 `_fresh_portfolio_config()` 起手——先寫 fresh-start 的 `manager/ledger_seed.json`(已有就不動),
  再回 `{"self_ledger": true}` 給 caller 寫進 config;兩筆寫入之間 crash 只會留下「有 seed 沒旗標」(無害),不會反過來。
  **既有機的 config 沒有 `self_ledger` 鍵一律維持帳戶讀取模式**,預設值只在建檔那一刻決定,不在讀取端。閘門:`tests/check_drift_band.py`。
  出貨順序:**runtime 先、lib 後**——lib 那筆的 paper 口數進場缺 `margin` 會拒單,而 margin 由 runtime 的 spec 表寫入;
  反過來(lib 先)機隊會有一段「台期模擬只能平不能進」。舊 lib 拿到 `self_ledger` 旗標會照 seed 走,不會壞。
- 模擬帳戶口數倉:`_TXF_ASSET_SPECS` 加 `margin`(期交所原始保證金,2026/08/12:TX 701,000 / MTX 175,250 / TMF 35,050),
  paper 的槓桿檢查用口數 × margin(1×);`account_reader._norm_positions` 對 `unit == "contracts"` 的列以口數回報、不再 × mark。
  **既有 `asset_specs` 不刷新**(`_cmd_amounts` 只在首次撥款且無 spec 時寫):升級前已寫入、沒有 `margin` 的舊 spec 在 paper 只能平不能進,
  要進場得取消勾選再重新撥款(或手動補 `margin`)。

- Binance 金鑰的提領權限閘門擴到**全模式**(原本只有電腦版):`_cmd_credentials` 在寫 `.env` 之前一律用這次要寫的
  key 向 Binance 查 `apiRestrictions`(`_binance_bind_check`)——提領開著、現貨與合約都沒開、半套 key、查不到 / 看不懂
  一律不寫(fail-closed)。查證必須由**機器自己**做:雲端機的白名單是機器的 IP,同一個請求從用戶電腦發只會拿到 -2015。
  **web 的連接交易所流程也會走到**(同一個處理函式,Wei 2026-09-22 已知並同意):雲端機從此也擋提領開著的 key,
  Binance 連不上時綁定會失敗要重試。`ipRestrict` 只回報不強制(沒設白名單照樣綁,由呼叫端提醒)。
  Binance 以外(paper、OKX、Gate.io、Bybit、BingX、台灣券商、資料來源金鑰)完全不變,不發任何請求。
  **ack 形狀改了**:成功回 `{"credentials": N, "binance": {checked, code, ipRestrict, spot, futures} | null}`
  (舊 runtime 回字串 `"credentials=N"`,呼叫端據此分辨「沒查過」與「查過且乾淨」);被拒是
  `ok:false` + `error="ValueError: <CODE>: …"`,CODE 用 `shell/binance_check.js` 同一套代號
  (WITHDRAW_ENABLED / TRADING_DISABLED / INCOMPLETE_PAIR / IP_OR_KEY / BAD_KEY_FORMAT / BAD_SECRET /
  CLOCK / RATE_LIMITED / NETWORK / UNKNOWN)。
  被 Binance 限速(429/418)會**上鎖**(`_binance_rl_until`,429 鎖 60 秒、418 鎖 5 分鐘,與
  `shell/binance_link.js` 同一組窗),窗內直接拒絕、**完全不發請求**:上層沒有任何退讓
  (web 的 command endpoint 沒有 rate limit,用戶失敗就再按一次),而 429 被重試會升級成 418
  = 這台機器的 IP 被 Binance 封,連用戶自己策略的下單一起死。
  窗是**行程內**的:web / 桌面那條(長駐行程)有效,聊天貼 key 那條(`lib/venue.py` 每輪重載模組、跑在子行程)沒有——
  刻意如此,聊天綁定每重試一次要多一輪對話,產生不了這個窗要擋的連點。閘門:`tests/check_credentials_withdraw_gate.py`。
- 電腦版:本機真錢金鑰的權限閘門下沉到 `.env` 的唯一寫入點(`command_listener._cmd_credentials` 的本機分支 →
  `_local_real_key_gate`):寫入前向 Binance 查 `apiRestrictions`,提領開著、現貨與合約都沒開、查不到或看不懂 → 不寫(fail-closed)。
  `LOCAL_OPEN_VENUES` 預設仍只有 paper;Binance 只在 `local_daemon` 自己的行程裡打開,聊天綁定那條路打不開真錢。
  (雲端見上面那條:同一道 Binance 檢查後來擴到全模式;留在本機的只剩「沒有檢查器的交易所一律不寫」。)
- 電腦版:`agent_turn.py` 新增 `--mcp-config <路徑>`——外殼替這一輪準備的單次 MCP 設定檔(只有 `blave` 一個 server)。**只在 LocalSink 認**,機隊帶了也不理;
  只收 workspace 以外的真檔;交給 SDK 的是路徑字串(dict 會讓 SDK 把 Bearer 放上 argv);`strict_mcp_config` 仍為 True(用戶全域的 MCP 照舊一個都不載)。
  掛了才在 system prompt 多一段 `mcp_rule`;沒掛一個字都不變。外殼那邊這個功能預設關。
- `agent_turn.py` 新增 `--message-stdin`:訊息從 stdin 讀、不放 argv(電腦版用;同一台電腦上的人 `ps` 看得到命令列,而聊天貼 key 是支援的流程)。
  訊息的位置參數變成選填;機隊照舊帶位置參數,行為不變。stdin 最多讀 1 MiB(`MESSAGE_STDIN_MAX`),超過就以用法錯誤結束,不無上限地讀進記憶體。
- 電腦版:`local_daemon` 的孤兒修正——app 被強殺時不再留下沒人管的下單機(stdin EOF 之外另外輪詢父行程;`_log` 不因 stderr 斷掉而中止收工)。

## 1.1.83 — 2026-09-21

- 停機跨 K 棒收盤 → 全部暫停等用戶逐支確認(雲端與電腦版同一條;設計:blave-canon
  `output/specs/downtime-pause-design-2026-09.md`)。runtime 這一半:`command_listener` 加
  downtime watch(5 秒一跳寫 `state/heartbeat/downtime_watch`;行程啟動時、每輪排程開頭、watch
  執行緒各判一次,空窗 ≥ 90 秒就把區間交給 workspace 的 `python -m lib.downtime gap`,跨不跨棒與
  暫停本身都在 lib);**沒有戳記=首次啟動,不判**(既有機隊升級不會被暫停);workspace 沒有
  `lib/downtime.py` 時只寫戳記、什麼都不做。`resume` / `resume_wait` 收
  `{"strategies": [...]}`=逐支(不碰整機 HALT),不帶=整機舊行為＋結束所有暫停;`resume_wait`
  對暫停中的策略不再當下寫基準(交給 lib 在重算後寫)。新指令 `downtime_hold`(`api` 的
  `ALLOWED` 要先上)。`portfolio_reporter.build_report()` 多 `can_downtime_pause` 與
  `downtime_pause`(`local_status.json` 同一份)。lib 端靠 byte-grep 本檔的
  `DOWNTIME_RESUME_PROTOCOL = ` 賦值判斷 runtime 支不支援——它代表逐支 resume 與整機清暫停那幾個
  handler 存在,**拿掉 handler 就一起拿掉它**。gap 交不出去(子行程起不來/鎖被佔)時:重試期間排程
  不 tick 任何策略,15 次(≈75 秒,長過 lib 的 30 秒過期鎖)後放棄、**放行這段停機**,只留機上紀錄(log ＋ workspace `state/audit.jsonl` 一行 `downtime_check_failed`;P3,不寫事件、不上平台)。
  `delete_strategy` 順手清掉該策略的暫停 entry。閘門:`tests/check_downtime_watch.py`
  (只靠 runtime 就要綠——跑在沒有 `lib/downtime.py` 的 workspace 上,正是 runtime 先發之後機隊的狀態);
  lib 那一半的 `check_downtime_pause.py`／`check_downtime_pause_chain.py` 跟著 lib 那筆 commit 走。
  **出貨順序(定案):api(`ALLOWED` ＋ `agent_events.SPECS` 的 `downtime_paused` = P1)→ runtime →
  web／shell 確認卡(含「運轉中」狀態列顯示暫停)→ 最後才是 lib ＋ `VERSION`。**
  runtime 單獨上線對機隊零變化(沒有新 lib 就只寫戳記);lib 先於確認卡=頁面綠燈、實際連出場都凍結、
  用戶只能 停止→啟動;lib 的 TG 文案也以確認卡已上線為前提。

- 電腦版實盤鏈第 1 步(paper):新增 `local_daemon.py`——在用戶電腦上跑**同一份**排程執行緒
  (`_scheduler_loop`)、同一組 `_cmd_*` handler、同一支 `manager/reconciler.py`、同一個
  `build_report()`;只換傳輸(`state/local_cmd/in|ack` 檔案佇列,HMAC 簽章、secret 走 stdin,
  `halt` 免簽)與監督者(daemon 自己當對帳器的父行程:當掉 10 秒重啟、flock 交給子行程繼承
  防雙開、啟動不自動起對帳器;對帳器經 `--run-reconciler` 起,父行程 pipe EOF 或 SIGTERM 時先撤自己的未成交限價單再走,新 daemon 啟動先收孤兒),狀態寫 `state/local_status.json`,並把 `<BASE>/current` 連到
  runtime(電腦版之前沒有這個目錄,`lib/events` 的事件全被靜默丟掉)。`command_listener` /
  `portfolio_reporter` 加 `BLAVE_AGENT_LOCAL=1` 開關(部署形態,不是 OS):直譯器用
  `sys.executable`、不讀不寫 crontab、Type B 在 `amounts` 明確拒絕、對帳器啟停交給
  `_LOCAL_HOST`、`credentials` 只准 paper(`LOCAL_OPEN_VENUES`,聊天綁定同一道閘門;
  `agent_turn` 在 LocalSink 時自己帶開關)。daemon 只在呼叫端已設開關且 `<BASE>/control`
  不存在時啟動。簽章不是同用戶隔離,擋什麼沒擋什麼寫在設計文件 §3。**開關沒設時零改變**(既有檔案的 diff 全為純新增、0 刪改;閘門:
  `tests/check_local_daemon.py`、`tests/check_local_daemon_chain.py`)。白名單與
  `api/openclaw/agent_command.py` 的 `ALLOWED` 由測試釘住同步。設計:blave-canon
  `output/specs/desktop-local-daemon-design-2026-09.md`。

- 電腦版 Blave 資料:`data_access_rule()` 讀外殼 spawn 時設的 `BLAVE_DATA_ACCESS`——`1`
  (用 Blave 的 AI 登入,資料 key 已寫進 workspace `.env`):指標與台股照 AGENTS.md 取,加密 K 線
  仍走 Binance 公開端點、不准換來源,403 `DATA_NOT_INCLUDED`(試用結束且沒主機／API 方案)照實告訴用戶,403 `Invalid API key` = key 已被刪／撤銷、請用戶在 app 重新登入(不找別的 key),
  上架／分享／刪除／報告上傳回 403 `KEY_SCOPE` 時請用戶到網站或雲端機做;`0`(沒有 key:自己的 Claude Code / Codex、
  沒登入,或登入了但帳號不含資料):平實講一次「資料在綁卡試用中、或名下有雲端主機／API 方案時才有」
  (不指路、不報價、不催促、同一段對話不重複),並在那則回覆文字最末獨立一行放
  `<blave-card:data-access/>`(外殼換成帶按鈕的卡片;一段對話最多一次;sink 原樣帶著不剝;prompt 明令 agent 不得提到按鈕、卡片或 app 會顯示什麼——實測它會把這件事講給用戶聽、還講錯),做完公開 K 線做得到的部分、不捏造、不去別處找憑證
  (不 SSH、不碰別台機器)。兩條引擎都帶;變數不存在(機隊)回空字串,system prompt 零改變
  (閘門:`tests/check_codex_engine.py`)。api 側要先上線(`/oauth/desktop/token` 回資料 key)。

- 電腦版隔離(只在 `--delivery local`,LocalSink;機隊行為零改變):`setting_sources=[]`、
  `strict_mcp_config`、`--disable-slash-commands`、`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`。
  電腦版的 agent 跑在用戶自己的 Claude Code 帳號上,CLI 預設會把用戶全域的
  `~/.claude/CLAUDE.md`、`~/.claude.json` 的 MCP、claude.ai 連接器、plugins、skills、自動記憶
  整包載進來——2026-09-19 實際發生:用戶全域 CLAUDE.md 叫它用 MCP SSH 進雲端機,它照做
  (把私鑰寫進 `~/.ssh`、到雲端機上畫圖、回報「發送成功」)。四個開關各管一塊,逐項用
  CLI 2.1.278 的 stream-json init 訊息驗過(MCP 5→0、skills 28→0、memory_paths→None)。

- 電腦版本機模式:`--delivery local`(LocalSink,chunk 邏輯沿用 WebSink、傳輸
  換 stdout JSONL,前綴 @@BLAVE@@);`BLAVE_PROXY_TOKEN` **不存在**時視為本機——
  拔掉 ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY(留著會蓋掉用戶的訂閱登入 → 401,
  2026-09-18 實測)、PATH/HOME/USER 由行程繼承即可(SDK 是 `{**os.environ, **options.env}`),外殼負責帶齊。
  機隊每台都有 token,行為零改變。

- 電腦版 Codex 引擎:`agent_turn.py … --engine codex --codex-bin <絕對路徑>`(新檔
  `codex_engine.py`)。只換「呼叫模型並消化事件流」那一段——跑
  `codex exec --json --ephemeral -s workspace-write`,JSONL 事件翻成同一個 sink 的呼叫;
  prompt、session store、四個 fault code、寫回歷史全部共用。不帶 `--engine` = `claude`,
  那條路徑連 `codex_engine` 都不 import,機隊行為零改變(閘門:
  `tests/check_codex_engine.py`)。`--engine codex` 時 `--model` 只在**明確帶旗標**時才轉成 `codex -m`(見下方 model / effort 那條)。
  多輪脈絡只走我們自己的 session store,不用 `exec resume`(兩個都用會重複餵)。
  三個不加就會靜默壞掉的旗標:`sandbox_workspace_write.network_access=true`(workspace-write
  預設斷網)、`project_doc_max_bytes`(Codex 原生讀 AGENTS.md 但 32 KiB 截斷,我們的是 39 KB)、
  prompt 走 stdin(不進 argv)。頂層 `error` 事件不是終局(Codex 原始碼:重連通知走這條),
  只有 `turn.failed` 才是。

- 電腦版:環境變數 `BLAVE_PYTHON`(外殼帶 venv python 的絕對路徑)有設時,`python_rule()`
  把「這個 workspace 的 python3 就是這個路徑」加進指示——Claude 走 system prompt 檔、Codex 走
  prompt 前綴,同一條規則。起因:Codex 用登入 shell 跑指令,profile 重排 PATH,`python3`
  解析到沒裝套件的那顆(回測報缺 pandas);PATH 前置救不了,環境變數不會被 profile 動。
  沒設(整個機隊)→ 回傳空字串,system prompt 逐字不變(`tests/check_codex_engine.py` §5)。

- 電腦版的 model / effort 選單:新旗標 `--effort <level>`(選填,值域由外殼保證,原樣轉發)。
  Claude → `options.effort`(有帶才設);Codex → `-c model_reasoning_effort=<level>`。Codex 引擎下
  `--model` 現在會生效(`codex exec -m <slug>`),但只認**明確帶的旗標**:`--model` 的 argparse
  預設改為 None、claude 引擎才在 main() 補 `model_prefs.DEFAULT_MODEL`——我們的預設模型名絕不
  流進 `codex -m`。都沒帶時 Claude 的 options 與 codex 的 argv 逐字不變(`tests/check_codex_engine.py`
  §1、§4)。實測備忘(CLI 2.1.239,mock upstream):不帶 `--effort` 時 CLI 本來就送
  `output_config.effort="high"` + `effort-2025-11-24` beta(含 deepseek 模型名);haiku 則完全
  不送 effort,`--effort` 對它是 no-op。
- 資料來源金鑰(BYO Data,命名 `DATA_<SOURCE>_<FIELD>`)不再被當成交易所。成對的
  `DATA_X_API_KEY`+`DATA_X_SECRET_KEY/PASSWORD/PASSPHRASE` 形狀跟已綁場所一模一樣,舊行為是:下次
  綁/換交易所時被當成「另一個場所」整對驅逐,還為一個不存在的場所觸發 HALT。改在
  `command_listener._venue_cred_ids` 一處跳過 `DATA_` 開頭的 id(驅逐掃描、
  `credentials.ui.json`、routing 繼承、排程的 bound 判斷、`lib/venue.py` 的 `_bound_ids` 全部吃這支);
  `_cmd_credentials_remove` 移除 `DATA_*` 不算解除綁定(不 HALT、不動 account.json)——判斷對象是
  去掉 `_API_KEY` 尾碼後的 **id**,跟綁定側同一個口徑(id 恰為 `DATA` 的自訂場所仍是場所,綁/解一致);
  `portfolio_reporter.venues()` 與 `account_reader._venues()` 不回報/不讀 `data_x`。**必須早於任何 `DATA_` 金鑰落到機器**(出貨順序
  runtime → api → lib → shell/web)。這一版只有「認得並跳過」,沒有 `data_credentials` 指令。
  `credentials` 指令的 payload 裡出現 `DATA_` 開頭的 id 直接拒收(ValueError,`.env` 不動):這種 id
  對所有場所判斷都隱形,網頁自訂交易所名稱被 slug 成 `DATA_MARKET` 時會綁了卻不驅逐、不進 manifest、
  不排程,全部靜默——改成大聲失敗。**機隊上既有的 `DATA_*` 自訂場所不受這道閘保護,發版前仍要查一次。**
  閘門:`tests/check_data_cred_skip.py`。

## 1.1.82 — 2026-09-18

- 環境變數 `BLAVECLAW_HOME` 更名為 `BLAVE_AGENT_HOME`。`agent_turn` / `telegram_pairing`
  改成讀新名優先、舊名次之;`agent_turn` 送進每個 turn 的環境**兩個名字都注入**——機器上的
  `lib/notify.py` 走半手動更新通道,可能還是只讀舊名的版本,雙寫才不會在通道落差期間
  無聲停掉 Telegram 通知。舊名的讀取端**移除條件**:機隊回報的 `config_version`(Redis `agent:config_version:{uid}`)全部 ≥ 帶著新版 `lib/notify.py` 的那個 workspace VERSION——條件寫在這裡,不住在任何 agent 的記憶裡。

## 1.1.81 — 2026-09-18

- `command_listener` 自己把所在目錄(`current/`)加進 `sys.path`,再 import sibling。修的是
  **聊天貼 key 綁交易所**:`lib/venue.py` 用 `spec_from_file_location` 從 agent turn 載這支,
  而 turn 的 PYTHONPATH 只有 workspace、importlib 不會把被載檔案的目錄放進 `sys.path`——
  1.1.68 加了模組層 `import turn_slots` 之後,全機隊的 chat-bind 從 2026-09-11 起必定
  ImportError(web 自動下單頁不受影響,那條走 bridge 自己的行程)。`append` 不是 `insert(0)`:
  workspace 的同名模組仍該贏。閘門在 api `tests/check_command_listener_standalone.py`。

- 註解裡的 `blaveclaw-config` 改為 `blave-agent`(repo 改名),無邏輯變動。
  已發版的版本段落**維持舊名不動**——那是當時的事實。

## 1.1.80 — 2026-09-18

- `strategy_reporter` reports INCREMENTALLY: `POST /openclaw/agent/strategies/one` per
  strategy whose files changed, then `POST /openclaw/agent/strategies/manifest` to close the
  round, which answers `missing` (what the api does not hold at the marker we quoted) — those
  are re-sent with their images forced, then the manifest goes again. Replaces the
  whole-inventory POST, which at 20 strategies was a 52MB body every two minutes and froze
  uid=32321's cache for a day when it crossed the api's ceiling. **The api must be deployed
  first**: there is no fallback to the old body, so a machine shipped ahead of it POSTs to a 404.
  - `strategy_marker()` is what a strategy is offered under: status + stats/scan/wf mtimes +
    the image signature + a content hash of code/display_name/description/versions. The image
    signature is in it because images travel out of band; the content hash is in it because an
    agent can edit a strategy without re-running its backtest (and a Type B never backtests),
    which no output mtime would ever show. `signature()` is untouched — its "live strategies
    are tracked by existence only" exemption belongs to the mid-turn push and must not leak here.
  - `strategy_marker()` returns a HASH of its columns, not the columns themselves: the image
    signature carries agent-written filenames, and eight descriptive ones measured 522 chars —
    past the api's field limit, which used to mean that strategy never reported again.
  - `state/strategy_report_acked.json` records what the api acknowledged, written only after a
    2xx. `web_bridge`'s turn-end sync sends but does not write it (two processes, no lock); the
    timer re-sends those once within two minutes.
  - The inline-base64 image fallback is now budgeted (`_IMG_B64_FALLBACK_BUDGET`, 3MB per
    strategy) so a body can never exceed what the api will accept; an image left out is not
    recorded as delivered, so the next tick retries it.
  - `/one`'s answer carries `dropped_images`: the api took the strategy but could not keep N of
    the images we inlined. The reporter then records NO signature for that strategy, so the next
    tick re-attaches and re-uploads them instead of believing they are delivered.
  - A strategy the api permanently refuses, and a 429, no longer take the round down: the
    manifest still goes out, because that is what refreshes every object's cache TTL.
  - The `predates gzip` uncompressed-retry branch is gone (the fleet is long past it).
  - `main()` runs `sync_versions()` / `sync_charts()` even when the report failed — they are
    separate channels, and skipping them is how uid=32321 also lost three chart chunks. The
    exit code still reports the failure.

## 1.1.79 — 2026-09-16

- Scheduled reports now run on the USER's wall clock, not the machine's (contract
  `.claude/docs/report-schedules.md` §2b/§3). `job.json`'s `schedule.cron` is evaluated in
  `schedule.tz` (IANA, the user's zone), so the cron holds exactly the time the user said and
  nothing converts anything: `report_runner.cron_next(expr, now, tz)` starts and returns through
  `zoneinfo` (DST is its problem, not ours), and `load_job` validates `schedule.tz` — absent is
  an old registration, machine local, NOT a broken file. Why: machines are UTC and Ubuntu's cron
  has no per-user zone (`man 5 crontab` LIMITATIONS: `TZ` in a crontab reaches the command's
  environment, not the schedule), so the conversion could only be the agent's — and it didn't do
  it: a user's 「11:30」 was written as UTC and fired at 19:30 Taipei.
- The trigger moved in-process: `command_listener._fire_due_reports()` runs on the scheduler
  thread (every 60s) and `Popen(report_runner.py <id>)` when a job comes due. Nothing installs a
  report schedule in crontab / schtasks any more (`_sync_report_crons`,
  `_sync_report_tasks_windows` and `report_runner.cron_to_schtasks` are gone), and
  `_sweep_legacy_report_schedules()` removes the old `# blave-report:` lines and
  `blave-web-report-*` tasks on upgrade — without it every job would fire twice, once per path.
  It runs at every runtime start and is idempotent (no marker file to look for: a machine with
  no stale lines reads its crontab and writes nothing).
  A missed slot is not made up and the slot memory stays in memory. Side effect: Windows has no
  cron subset to work around any more, `30 8 * * 1-5` is one job on both platforms.
- New command `tz_set` (`{"tz": <IANA>, "if_unset"?: bool}`) → `state/timezone`; the web sends the
  browser's zone on workspace load, and `if_unset` keeps an existing setting (a trip abroad or one
  page load on a borrowed laptop must not shift every registered schedule). One reader,
  `strategy_reporter.read_timezone()` (path + parse live next to `reply_lang`'s).
- The agent's own turns now run with `TZ` set to that zone (`agent_turn`'s `turn_env`), so 「現在
  幾點」 and every log timestamp it reads are the user's time — until now it read the machine's UTC
  and answered 10:26 when the user's clock said 18:26. Not set = no `TZ`, machine time as before.
  Strategy subprocesses deliberately do NOT get it (`_strategy_subprocess_env()`'s Windows denylist
  now drops `TZ` too, the Linux allowlist never had it): a strategy must read the same clock whether
  the scheduler or the agent started it.

## 1.1.78 — 2026-09-15

- agent_turn: the per-turn red-line anchor adds "stopping one strategy / closing one coin on
  the user's explicit request is allowed, via manager/stop_strategy.py and
  manager/close_symbol.py" — only when the workspace has `manager/stop_strategy.py`
  (blaveclaw-config 2026-09-15-b), same existence gate as `_cmd_close_all`'s flatten.py.
  Why: uid 30979 asked to close and stop one strategy; the anchor only said HALT was
  allowed, so deepseek spent 24 minutes deciding whether it could, then hand-wrote a close
  script with a generic-key fallback and left the registry entries behind.

## 1.1.77 — 2026-09-14

- agent_turn: every `strategies` chunk it pushes (after a tool result, and pre-done) now
  carries `touched`: the sorted strategy names this turn's own tools touched, so the web can
  attribute a new strategy to the conversation that made it instead of "whichever sid chunk
  carried the name first" (uid=1, two parallel turns: A's chunk carried B's new DOGE strategy
  4.7s before B's own did, so it was claimed by A and neither side opened it). Names come from
  `ToolUseBlock.input` — Write/Edit `file_path`, Bash `command` — as any `strategies/<seg>`
  (absolute and Windows `\` paths too; `<seg>.py` → `<seg>`; `TEMPLATE*`, `__pycache__`,
  dot-names, and segments with `$`/glob characters are skipped). Subagent tools don't count.
  Read/Glob/Grep don't count. Always present on these chunks (`[]` = touched nothing), so its
  presence also marks a runtime that sends it. `live_chunk(strategies, touched=None)` adds the
  field before the size-budget loop; web_bridge's turn-end / watcher / command pushes don't
  send it. Checks: `tests/check_agent_turn_strategies_push.py` case 8,
  `tests/check_web_bridge_turn_end_newborn.py`.
  KNOWN GAPS (miss an open, never open the wrong one): a path built from a shell variable
  (`strategies/$NAME`), `cp -r` / `mv` of a whole folder into `strategies/` without naming the
  strategy dir, a script that generates the file name itself, and a strategy whose
  `STRATEGY_NAME` differs from its directory / file name (touched holds the path segment,
  the list holds `STRATEGY_NAME`). Over-capture is by design: `python3 strategies/X/...` counts
  as touching X.

## 1.1.76 — 2026-09-14

- FIX (1.1.75): the pre-done chunk auto-opened a just-created strategy, then web_bridge's
  turn-end push (no `session_id`) ~1s later still hid it as a newborn, so the sidebar redraw
  dropped the selection until the watcher pushed it back (uid=1: open 415.4s, done 415.9s,
  hidden 417.1s, back 439s). `sync_strategies` / `_sync_strategies_locked` gain
  `include_newborn`; only the turn-end call in `_worker` passes True. Watcher and command
  syncs keep hiding newborns (a file can be mid-write at those moments).
  The turn-end `since` dedup now only yields to a sync that also included newborns
  (`_last_full_sync_started`): the watcher can fire between `_running.pop` and the turn-end
  call (during `sync_portfolio`), and letting that newborn-hiding sync stand in for the
  turn-end one would bring the bug straight back. The watcher's own fingerprint does fire
  once for the name afterwards (the turn-end scan puts it in `_seen_names`, so the next
  `signature()` includes it) — one redundant push that already carries the file.
  SIDE EFFECT: web_bridge's `_seen_names` is process-wide, so with two turns in parallel,
  A's turn-end scan can surface a draft B is still writing a few seconds early, and it then
  stays listed. That push has no `session_id`, so nothing auto-opens; cosmetic only.
  Check: `tests/check_web_bridge_turn_end_newborn.py`.

## 1.1.75 — 2026-09-14

- FIX (1.1.74): a strategy the agent created and kept touching until the turn ended (no
  backtest) still never reached the pre-done `strategies` chunk. `_scan_sources` hides a
  "newborn" (no stats.json, source mtime < 15s), and `signature()` shares that filter, so the
  pre-done compare saw no change and pushed nothing; the first push to carry the name was the
  watcher's, without `session_id` (uid=1: done at 104s, name first seen at 126s).
  `signature` / `scan` / `_scan_sources` gain `include_newborn=False`; only agent_turn's
  pre-done push passes True (the turn is over, nothing is still writing the file). Pushes
  after each tool result, web_bridge's turn-end push and the watcher keep hiding newborns.
  Check: `tests/check_agent_turn_strategies_push.py` case 7.

## 1.1.74 — 2026-09-14

- agent_turn: the mid-turn `strategies` chunk (carries `session_id`) now goes out after each
  tool RESULT instead of at the tool request, plus once more right before `done` on any web
  turn that used a tool (skipped when interrupted). Before, a strategy created by the turn's
  last tool never appeared in a chunk with `session_id` — only in web_bridge's turn-end push,
  which has no `session_id` and lands after `done`. web_bridge's turn-end / watcher /
  command pushes stay without `session_id`: the turn-end `since` dedup lets one scan stand in
  for two sessions that finished back to back, so it cannot be attributed to either.
  Check: `tests/check_agent_turn_strategies_push.py`.
  DEPLOY GATE: deploy the web build that reads `session_id` on `strategies` chunks
  (workspace auto-open per conversation) once the fleet has picked up this runtime. During
  the few minutes an updater downgrade can put a machine back on an older runtime, a turn's
  last-tool strategy simply does not auto-open; the older push-at-tool-request timing also
  brings back its higher odds of another conversation claiming a new name first.

## 1.1.73 — 2026-09-14

- portfolio_reporter: payload gains `account_guard` `{venue, account_id_seeded, account_id_supported,
  last_read_error, last_read_at, pending}` from `state/venue_account.json` + `state/account_id_read.json`
  (blaveclaw-config reconciler), so a fail-soft account-id read is visible without SSH. Never
  the id. `null` on a workspace whose reconciler predates the guard.

## 1.1.72 — 2026-09-12

- REGRESSION FIX (1.1.70): no Linux machine could link or pair Telegram since 1.1.70.
  1.1.70 wrote `config/telegram.json` as tmp + `os.replace` inside `config/`, but
  provision.sh makes `config/` `root:root 755` (only `telegram.json` itself is
  `blaveagent 600`), so the pairing poller and the bridge's auto-pair (both run as
  blaveagent) died with `PermissionError` creating the tmp: the token never landed and
  the first message never paired. Windows was unaffected (it already wrote in place).
  Now `write_json_600` rewrites the file in place on every platform, as before 1.1.70:
  POSIX opens it without `O_TRUNC`, takes an exclusive `flock`, truncates, writes and
  re-applies 0600, so the three writers (poller, `reset()`, bridge auto-pair) can't
  interleave into a file that stays corrupt. No directory permissions change. Readers
  take no lock; the empty / half-written file a read can land on mid-write is handled
  by `read_config` (1.1.71: one re-read, then "mid-write" = skip the round), with the
  same accepted residual risk the 1.1.71 entry describes, now on Linux too.

## 1.1.71 — 2026-09-12

- REGRESSION FIX (1.1.70): a machine that never linked Telegram could not link at all.
  provision / first-boot pre-create `config/telegram.json` as a 0-byte file; 1.1.70's
  "unparsable = mid-write, skip this round" took it for a torn write, so the pairing
  poller never asked the backend for the token (journal: `telegram.json unreadable
  (mid-write?)` every 15s). Now one reader for poller and bridge
  (`telegram_pairing.read_config`): empty / whitespace-only = unpaired `{}`; empty or
  unparsable gets one re-read after 0.3s first — on Windows the file is rewritten in
  place, and that instant's 0 bytes taken as `{}` would re-deliver the token and wipe
  the pairing (the hole 1.1.70 closed). Still unparsable after the re-read = mid-write
  only if written in the last 10s (skip the round / bridge keeps its last good copy);
  older = corrupt, treated as unpaired and rewritten, so it can never block linking.
  Read as `utf-8-sig` (a BOM no longer makes the file unparsable).
  What actually stops a Windows mid-write read is the 0.3s re-read; the "written in
  the last 10s" test is only a second guard, not the main defence (NTFS may update
  last-write only when the writer closes the file, so a torn file's mtime can look
  old). Both reads landing inside a write is an accepted residual risk.
  A paired machine whose `telegram.json` is really corrupt (not written for a while) is
  now read as `{}` by both poller and bridge: the poller rewrites the token without
  `allowed_chat_id` and the user sends one message to pair again — a deliberate
  self-heal, better than 1.1.70 skipping forever.

## 1.1.70 — 2026-09-11

- Telegram unlink / re-link from the web (spec `workspace-connect-settings` §1). The
  api's `/telegram/config` now also returns `pair_gen` (changes on every web link /
  unlink). telegram_pairing converges `telegram.json` on token + `pair_gen`: every tick
  while unpaired (as before), every 5 min while paired (`state/tg_pair_checked`; a
  machine stopped longer than that checks on its first tick after boot, so a change made
  while it was off lands on its own). A backend without `pair_gen` never unpairs — only
  a token difference does. Instant path: new command `telegram_reset {gen}`
  (platform-queued by the api's POST/DELETE, not web-sendable) → same apply. Apply =
  clear lib/notify's compat files itself (allowFrom removed, `openclaw.json` botToken
  dropped — `control/sync_notify_compat.py` only ever writes them and has no release
  channel), drop `state/tg_offset` unless it is keyed to the same bot (a same-bot offset
  holds handled-but-unconfirmed updates; deleting it replays them), write
  `telegram.json` = `{bot_token?, pair_gen}`
  without `allowed_chat_id`. `telegram.json` writes are now tmp+replace (three writers).
- telegram_bridge: pairing identity = (bot id, `pair_gen`); a change resets offset and
  the backlog drain without a restart, so the same token pasted back re-pairs to
  whichever account messages first. `state/tg_offset` is now `{"bot", "offset"}`
  (bare int still read). Config is re-read before each update; a pairing that changed
  mid-batch drops the rest of the batch unconfirmed and never writes the old pairing
  back. A portfolio report is pushed right after auto-pair (pending → linked on the web
  without waiting for the 2-minute timer).
- Audit hardening of the above: (a) the pre-pair backlog drain drops everything sent
  before `pair_at` (api time of the web link/unlink, now also in `/telegram/config` and
  `telegram.json`; 5s clock slack) — re-linking the same bot to switch accounts let the
  old account's recent message (inside the 2-minute grace) or the interrupted batch win
  the new pairing; without `pair_at` the 2-minute grace stays. (b) The poller unpairs on
  a null token only when the backend also states a `pair_gen` — an old api, or a row
  caught mid-resume behind a cached auth, answers null for a paired machine. (c)
  `os.replace` of `telegram.json` / `tg_offset` retries PermissionError (Windows: loses
  to a process holding the file open); an offset save that still fails is logged, not
  fatal to the bridge.
- Second audit: `telegram.json` is rewritten in place on Windows (a replaced file would
  lose provision.ps1's explicit Administrators/SYSTEM ACL); converge records a new
  `pair_gen` even with no token on either side (else the web's pending_apply never
  clears) and replaces a token only when the backend states a generation; the bridge
  re-reads `telegram.json` right before an auto-pair write; the reporter reads
  `tg_pair_gen` before the chat ids; `reporter_notices.json` uses a unique temp name
  (the timer, web_bridge and telegram_bridge can build a report at once).
- Final audit: an unparsable `telegram.json` (Windows: read mid in-place write) makes
  the poller skip the round and the bridge keep its last good config — read as `{}` it
  re-delivered the token, wiped the pairing and let the next sender pair.
  `telegram.json` temp files are unique per write and removed on failure (they hold the
  token); a failed bridge write is logged, not fatal. A reset whose token fetch fails
  keeps the current bot's offset.
- portfolio_reporter: payload carries `tg_pair_gen` (the generation actually applied);
  the api drives the web's `pending_apply` off it and, once it has a generation for the
  machine, accepts `tg_chat_ids` only from a report carrying it.
- agent_turn: a turn that ends with no reply text and was not interrupted (DeepSeek
  cutting the stream after thinking — uid=1, 2026-09-11) is resumed once in the same
  turn slot: new CLI session, original prompt + continuation anchor + first attempt's
  tool receipts, remaining budget/steps, Bash timeouts cut to the wall time left (no
  resume under 300s). Still empty → the last narration is the reply if there was any,
  else the existing fault (`partial` / `not_started`).
- The agent turn env and report_runner's `run.py` env get `PYTHONPATH=<workspace>`
  (prepended to any existing value), so `tmp/x.py` and `report_jobs/<id>/run.py` import
  `lib` without their own `sys.path.insert`.
- report_uploader: a successful upload of an id deletes `reports/failed/<id>.json` and
  its `.files/` sidecar (the `upload_errors.log` line stays).
- report_runner: a `report_jobs/<id>/` with no `job.json` is a draft (sample run before
  the user confirms) — not listed, not installed; a `job.json` that exists but is broken
  is still reported as an error.

## 1.1.69 — 2026-09-11

- agent_turn: the backtest-chain libs (`lib/runner.py`, `param_scan.py`,
  `walk_forward.py`, `validation.py`, `analysis.py`) and `control/` are
  deny-listed for the edit tools (`PROTECTED_EDIT_RULES`; holds in
  bypassPermissions; live test on CLI 2.1.268: Edit, Write, Bash `>>`, `sed -i`
  and `cp` onto a listed file all denied — a script opening the file itself is
  not covered, AGENTS.md carries the rule for that). The rest of
  lib/ stays writable: user-built exchange helpers live there and the update
  flow merges it. A real machine's agent extended `lib/walk_forward.py` with an
  `anchored` option on request — the web then rendered that run as rolling.

## 1.1.68 — 2026-09-11

- 回覆語言設定改三態:自動(預設;檔不存在或空)/ 七碼 / 自訂文字(`state/reply_lang` 存
  `custom:<text>`;清洗只在 `strategy_reporter.parse_reply_lang_custom` 一份,讀檔與 listener 共用:
  各種空白(含換行與 U+2028 等行分隔、NBSP/全形/tab)換一般空白並壓縮、不切行(切行會把 `Ko<U+2028>rean`
  存成錯但有效的 `Ko`)、刪控制與零寬/雙向字元、`]` `"` 換全形、含 `<` `>`
  或鷹架標記開頭視為無效、清洗後 >40 字視為無效、剛好是七碼(不分大小寫)正規化成該碼;讀取改
  `read_reply_lang_setting()` → `(代碼, 自訂文字)`,`read_reply_lang()` 刪除)。手寫檔行為變化:讀檔只取
  `readline` 那一行(`zh\nextra` 現在認 zh、開頭空行 = 自動;該行解碼後 >512 字 = 自動、不截斷;手寫的
  `ZH` 與 `custom:ZH` 一樣正規化成 zh),讀不動的警告
  每個 process 只印一次;開頭是 `FF FE` / `FE FF` 的檔用 UTF-16 解(PowerShell 5.1 的 `>` 重導),
  `_PREFS_HOWTO` 要求用 UTF-8 寫這個檔。
  `reply_lang_set` args 加 `custom`(非空時 `lang` 必須是 `""`,api 與機器各驗一次;api 另在該用戶
  `can_reply_lang_custom` 旗標缺席時以 `reply_lang_custom unsupported` 400 擋掉非空 custom——1.1.67 的
  listener 只讀 `lang`,收到會刪掉現有設定),ack 回
  `{"lang", "custom"}`;兩者皆空 = 刪檔 = 自動。reporter payload 加 `reply_lang_custom`(欄位在 =
  api 的 `can_reply_lang_custom` 旗標,前端據此顯示「其他」)。自訂語言的尾端錨把文字用引號包住當資料
  (「Reply ENTIRELY in the language the user specified: "<text>"」),suggest 版同 es/pt/vi/ja 把部署
  建議句釘成英文;兜底錯誤句退英文。`_PREFS_HOWTO` 改成:七種寫代碼、七種以外寫 `custom:<語言名稱>`、
  「跟著我打的語言回」= 清空檔案(web 不再自動 seed,清了不會被寫回)。既有機器已 seed 的值不動。
  檢查:`tests/check_agent_reply_lang.py`。

- 工作頁多對話＋並行回合(`.claude/mockups/chat-sessions/spec-c.md` §3.4;api 端 `openclaw/webchat.py`
  同 commit、**先部署**——反過來機器會對舊 api 回報 `turn_state` 被當一般 chunk 轉發,無害但沒有狀態)。
  `web_bridge` 派工改寫:poll 迴圈只收件,訊息依 `session_id` 進各自的本地 FIFO(`state/web_queue.json`
  落盤、tmp+replace)、**進佇列即 ack**(舊的「開工即 ack」在本地排隊 >60s 會被 api 的租約重送、跑兩次);
  dispatcher thread 在有名額時開跑最早等候的 session,同 session 嚴格序列、跨 session 並行,開不了跑的回報
  `turn_state: queued`(每分鐘重報續命)、開跑 `running`、結束 `done`;inbox 新的 `interrupt` 控制訊息把還沒
  開跑的訊息撤回並回報 `cancelled`(在跑的照舊由 /report 夾帶的旗標中斷)。`on_term` 對每條進行中的回合各發
  一次 `report_turn_aborted`,排隊中的留在磁碟、重啟後照序恢復並各重報一次 `queued`。`_current_session`
  換成 `_running` 登記表;變化偵測 thread 改看「任一回合進行中」;turn-end 的 `sync_portfolio` /
  `sync_strategies` 多一個 `since`,回合結束後已有一次 sync 起跑就略過(portfolio 補上同款鎖)。心跳只由
  poll 迴圈 touch(迴圈不再被回合擋住)。
- 新 `turn_slots.py`:跨行程名額=`state/turn_slots/slot-N` 的 O_EXCL 檔(90s 沒動視為死人留下、可回收;不用
  pid——Windows 的 `os.kill(pid, 0)` 會殺掉行程)。保鮮由獨立的 `keep_fresh` thread 每 4 秒 touch:web 是
  「`_running` 登記著的每個名額」,TG 是這一輪的名額到 `subprocess.run` 結束——不跟回合迴圈或 typing 綁在一起,
  因為那些會卡在 timeout 管不到的 DNS 解析、`proc.kill()/wait()` 上,卡超過 90 秒名額就會被別人回收。上限讀 `state/turn_limits.json`
  (`command_listener` 從 command poll 回應的 `turn_limits` 落檔,api `agent_command.turn_limits`:方案
  vCPU 數=上限,Starter 2／Premium 4／Max 8、Windows Starter 2,試用固定 1;檔案不存在=2)。開跑前另看
  `MemAvailable`(`portfolio_reporter._memory`)<1GB:**已有回合在跑**才擋、維持排隊,零回合一律放行一條
  (否則機器會永遠不回話)。`telegram_bridge` 佔同一組名額:spawn 前 `_wait_for_slot`,typing pinger 順便
  touch 名額檔,TG 等名額時沒有提示。**Windows 未實測**:名額檔的 O_EXCL／utime／90s 回收與
  `GlobalMemoryStatusEx` 那條路只在 Linux（本機 macOS 檢查）跑過,Windows Starter 的上限 2 也是外推。
- `model_prefs`:`set` 同時寫 `_last`,沒有自己偏好的 session 沿用它——新對話不再退回預設模型。
- `session_store._conn`:`timeout=30` + `PRAGMA journal_mode=WAL`,多個 `agent_turn` 同時寫同一個檔。
- 收件依 `message_id` 去重(最近 200 個＋佇列中＋進行中的一律算已收,重啟時從磁碟佇列重建):ack 沒送達、或
  落盤後 ack 前被殺,api 會在 60s 租約到期後重送,不去重就同一句跑兩遍。`on_term` 不拿 `_lock`(signal
  handler 在主線程,主線程可能正持鎖寫佇列,不可重入鎖會卡到 systemd SIGKILL、一則通知都沒發)。回合結束時先
  回報 `done`(／`queued`)才離開 `_running`,dispatcher 不會夾在中間開跑同 session 下一則、讓舊的 `done`
  蓋掉新的 `running`。
- **已知限制(接受不修)**:① 兩個 bridge 同時回收同一個過期名額檔時,上限可能暫時多 1。② bridge 停機超過
  180 秒期間用戶刪了某條對話,bridge 回來仍會跑那條排隊中的訊息(回覆寫不進已刪的對話)。③ `KillMode=process`
  讓 bridge 重啟後 `agent_turn` 孤兒繼續跑到完,它的名額檔 90 秒沒人 touch 就被回收——這段期間上限短暫超額,
  同一個 session 也可能跟孤兒並跑。④ TG 可能一直等不到名額:`telegram_bridge._wait_for_slot` 每 3 秒搶一次,
  web dispatcher 每 5 秒派工、有新訊息或回合結束時立刻派,web 佇列一直有料時 TG 會持續輸掉搶位,用戶只看到
  typing。上限 1 的試用戶最明顯。⑤ 回合結束時 `turn_state: done` 是在 session 還留在 `_running` 時送出的網路
  POST(刻意:避免下一則的 `running` 夾進 `done` 與 `queued` 之間);這個 POST 卡在 DNS 解析(urlopen 的
  timeout 管不到)時,同一條對話的下一則要等它回來才會開跑,其他對話不受影響。
- 檢查:`tests/check_web_dispatch.py`(派工序列／並行／上限／記憶體門檻／落盤與 ack 時機／message_id 去重／
  interrupt 撤回／on_term 逐條通知與持鎖不卡／done 先於離開 `_running`／model_prefs 回退／WAL)、
  `tests/check_webchat_sessions.py`(api 端 per-session 分流、遷移與並發遷移、空殼清理)。

## 1.1.67 — 2026-09-10

- 回覆語言設定:機器上存 `state/reply_lang`(單行語系代碼 zh/cn/en/es/pt/vi/ja,= web `<lang>`;
  白名單、路徑、讀取函式只在 `strategy_reporter` 一份)。`command_listener` 新指令 `reply_lang_set`
  `{"lang", "if_unset"?}`:白名單再驗、原子寫,ack 回 `{"lang": 實際值}`;`if_unset: true`(web 自動
  帶入才送)已有有效設定就不寫、回現有值,免得最多舊 2 分鐘的回報讓介面語言蓋掉 agent 剛寫的值。
  reporter payload 一律帶 `reply_lang`(未設定 `""`,欄位在不在 = api 的 `can_reply_lang` 旗標)。
  讀檔用 `utf-8-sig`(Windows 上 PowerShell 寫的 BOM 不會被靜默當成沒設定)。
- 語言錨優先序改在 code 算:設定 > web 回合的 `ui_lang`(`web_bridge` 白名單後接成 `--ui-lang`)>
  既有 `_is_zh` 啟發式,仍是訊息尾端那一條;有設定就一律照設定、沒有逐則例外。七個語言各有指名的
  尾端錨(繁/簡分開、互禁),`<suggest>` 版涵蓋建議句;`_STYLE_RULES` 的語言條改成「以尾端語言指示為準」;
  兜底錯誤句跟著解析出的語言(cn 有簡體版 `FAULT_TEXT_CN`,es/pt/vi/ja 退英文)。無設定、無 `ui_lang`
  (Telegram 未設定、舊 web)時錨與改版前逐字相同。根因=按鈕代送的中文指令夾英文識別字被判成英文
  (32321「用繁體中文回答」仍回英文)。
- agent 只能在七個代碼間切換這個設定、不准刪檔「取消」(刪檔 = 沒設定,web 下次開頁會自動帶回介面語言);
  「跟著我打的語言回」答不支援並指向設定面板。語言偏好一律寫 `state/reply_lang`,不進 preferences.md。
- 導航判定:`_NAV_ASK_RE`／`_NAV_TOPIC_RE` 與導航句開頭補簡體字形(带我看、怎么、模拟盘、绑定…);
  es/pt/vi/ja 的 `<suggest>` 錨把部署類建議句釘成英文「Show me how to …」,點下去照樣注入
  portfolio-steps.md(否則 UI 標籤又會亂編,29026)。

## 1.1.66 — 2026-09-10

- 樣本外驗證(walk-forward)機器端回報:`_read_wf` 讀 `strategies/<name>/wf.json`、`scan()` 每支策略
  附 `wf`(同 `scan` 的 fail-soft 契約:讀不到就不帶這個 key,形狀驗證是 api 的事)。`signature()`
  多一欄 `_wf_marker`(mtime+size)——wf.json 跟 scan.json 一樣只由顯式驗證寫入、不是每根 K 棒都寫,
  所以沒有 `_stats_marker` 那種 live/deployed 豁免,指紋一動就是使用者真的要了什麼。檔案由
  blaveclaw-config `lib/walk_forward.py` 產出;api 端 `_clean_wf` 全有或全無地驗證。

## 1.1.65 — 2026-09-10

- 策略名閘門 `_CHART_NAME_RE` 由 64 字放寬到 128(canon §9b)。機隊上已經有 65 與 69 字的策略,
  它們的權益圖從來沒上傳成功過、也不會有版本——64 這個數字是抄 `command_listener` 的,不是 S3 的限制。
  api 端 `agent_chart_data`／`agent_strategy_versions` 與 web `strategy_versions.js` 同批放寬,四處必須一致,
  否則摘要清單會列出一堆 blob 永遠 404 的版本。`command_listener` 的 delete_strategy 仍是 64(另案)。

## 1.1.64 — 2026-09-10

- 策略版本(canon `.claude/docs/strategy-versions.md`,第 2 步機器端):`strategy_reporter`
  多兩件事——① `scan()` 每支策略附 `versions`(`counter`/`current`/`items`/`drift`),來源是
  `strategies/<name>/versions/index.json` 加 `drift.json` 存在與否,只帶摘要(每支 ≤20 筆、
  每筆約 200 bytes),不帶碼也不帶曲線,否則 16MB 的 strategies cache 會被 20 份策略碼撐爆;
  ② 新增 `sync_versions()`,把還沒送過的 `v<N>.json` gzip PUT 到
  `/openclaw/agent/version/<strategy>/<n>`,版本 immutable 所以每個號碼一輩子只送一次,進度記在
  `state/strategy_version_sync.json`。排在 `sync_charts` 之前(預算 10 秒):
  `TimeoutStartSec=120` 已被圖片 30＋圖表 45＋report 15 吃掉大半,排後面會被餓死。api 端點還沒
  部署時的 404 不是失敗——靜音退避一小時,不洗 log 也不每 2 分鐘空打;409 當成已存在;永久性
  4xx 與過大的 blob 記成已送,免得每輪重試同一份送不出去的東西。機器端**不送 DELETE**(canon §8,
  清理由 api 在 PUT 時掃)。`_chart_request` 多一個 `timeout` 參數、chart 的 state 讀寫抽成
  `_load_state_file`/`_save_state_file` 給兩條通道共用。檢查:機器端產出那半在
  `blaveclaw-config/tests/check_strategy_versions.py`＋既有 `tests/check_agent_chart_sync.py`。

- Agent 常駐規則的 web 讀寫(`state/preferences.md`,原本只有聊天寫入路徑、web 零可見度):
  `strategy_reporter.report_cache()` 的 payload 多一個 `preferences`(原文字串;沒有那個檔
  就空字串,讀不動則整欄省略——欄位在不在就是 api 端的能力旗標,塞 "" 會讓 web 顯示成
  0 條規則、使用者一存就蓋掉還有內容的檔)。`command_listener` 新增 `preferences_set`
  指令:args 是 `{"rules": [str, ...]}` 結構而非整份 markdown,機器端再驗一次(必須
  list、每條是單行非空字串,條數與長度只有傳輸健全性的天花板 100 條 / 1000 字——介面講的
  10 條 × 150 字**刻意不在後端執法**:整檔 replace 之下擋掉第 11 條,等於 agent 自己寫超過
  之後使用者連刪都刪不掉,而「先刪掉幾條」正是超限態唯一的復原路徑)、剝掉 `<<<` 與
  `session_store.SCAFFOLD_RE` 命中的行
  (同 `agent_turn.preferences_rule()` 讀時那道防線,寫時先擋),組 `- ` 行後以
  tmp+`os.replace` 原子換檔(`agent_turn` 每輪整份讀它,不能讀到半份),ack 的 `result`
  回真正落檔的 `{"rules": [...]}` 讓 web 秒級收 spinner。並發不加鎖:agent 也會改這個檔,
  last-write-wins。`agent_turn._PREFS_HOWTO` 補一句「這個檔網頁也會編輯、只准寫條列行」
  ——否則 agent 寫的標題行會被使用者的下一次存檔洗掉,兩邊互刪。回報後的推送沿用既有
  `on_applied → sync_strategies` 那條路,沒有新增 spawn。檢查:`tests/check_agent_rules.py`。
  **已知行為(接受不修,留紀錄免得下一個人當 bug 查)**:Windows 上 `os.replace` 在目標檔
  正被另一個 process 開著讀的瞬間會丟 `PermissionError`,而 `agent_turn.preferences_rule()`
  每輪都會 open 這個檔幾毫秒——所以 Windows 機上存規則有極低機率撞上這個窗。後果止於
  handler raise → ack 回 error → 面板顯示「沒有存到」,使用者再按一次就好;檔案本身完好
  (原子換檔沒發生 = 舊版原封不動),不會半份、不會遺失。要修就得在這裡加重試迴圈,
  為一個可重試、使用者看得見的失敗加一段只在 Windows 生效的迴圈,不划算。

- 事件通道(通知收斂案第①步,canon `.claude/docs/notifications.md`):新增 `events.py`
  ——機器側 P1／P2 事件 append 到 `state/events.jsonl`(id=epoch 微秒、保證比檔案最後
  一筆大,`ts` epoch 秒,`type`＋`payload`),`portfolio_reporter` 每 2 分鐘把水位線以上
  的帶在既有 payload 送上去,平台回應的 `acked_through` 寫回 `state/events.acked`、
  水位線以下輪替檔案。寫入端只 append 永不改檔,輪替只有 reporter 做(config 側
  dual-write 照同一條規則)。payload 另外加 `resources`(disk_pct／記憶體三數字／
  gateway,Windows 走 `nssm status` 與 GlobalMemoryStatusEx)與 `tg_chat_ids`(配對的
  chat id):平台每小時 SSH 進機器的部署巡檢同批退役,那兩件事只剩這條路上來——
  `tg_chat_ids` 是 fan-out router 判斷「有沒有配對 TG」的依據,漏掉的話通知會安靜地
  停止送達。檢查:`tests/check_events_channel.py`。

## 1.1.63 — 2026-09-10

- `_stop_reconciler()`(解綁前「daemon 真的停了嗎」那道確認)的判定全部改看 exit code,
  不再比對 tmux 的 stderr 文字,順序也倒過來:先問 systemd(`systemctl is-active`,
  命中 running-set 才 `sudo -n systemctl stop`),tmux 降為 legacy fallback、但在
  systemd 乾淨停掉之後仍然照查(機隊 tmux→systemd 遷移未完,daemon 可能在任一邊),
  改用 `tmux has-session` 的 rc:rc≠0 就是沒有 session——沒 server 與沒那個 session
  結論相同,所以訊息內容無關緊要。舊版在「機器上根本沒有 tmux server」時**必然**誤判成
  「還在跑」:tmux 3.2a 印的是 `error connecting to /tmp/tmux-0/default (No such file
  or directory)`,舊碼比對的 `find session` / `no server` / `failed to connect` 一個都
  不含——而那正是 blave-agent 機的常態(daemon 走 systemd,平常根本不開 tmux)。實測
  後果:uid 29026 於 2026-09-09 09:37 從 web 解綁 bybit,`_stop_reconciler()` 回 False、
  membership 保留,daemon 從沒被停掉,接下來 16 小時每 5 分鐘噴一則 Telegram、累計
  190 則,journal 只留下一句 `reconciler not confirmed stopped — membership kept`。
  running-set(`active/activating/reloading/deactivating/failed`)與
  `_cmd_restart_reconciler` 那組仍維持逐字一致,保守契約不變(不確定一律當還在跑、回
  False);兩條 False 出口現在會把 rc 與 stderr 前 150 字寫進 log——29026 那次只有一句
  「membership kept」,看不出是卡在 tmux 還是 sudo。確認停掉後另外用
  `_purge_deployment_registry(["reconciler"])` 退掉 `state/deployments.json` 的健康
  註冊:`_register_reconciler_deployment` 每次 啟動下單 都會寫進去,但全站沒有任何地方
  會刪——2026-08-19 稽核修 Type A/C 的同一個 bug 時,daemon 那筆被註記為 "untouched
  either way" 而漏掉。目前還沒爆是因為 `manager/healthcheck.py` 的 cron 只裝在舊
  openclaw/blaveclaw 機上,等它補裝到機隊,就會為一個用戶主動關掉的 daemon 每 6 小時
  各叫一次 heartbeat 過期。檢查:`tests/check_reconciler_stop.py`。

## 1.1.62 — 2026-09-08

- 回合炸掉時的兜底訊息從一句「處理這則訊息時發生錯誤」拆成四種,並帶一個 `code` 給
  web(`not_started_upstream` / `not_started` / `partial` / `max_turns`,文案定稿見
  `.claude/output/designer/mockup-chat-turn-error.html` #spec §1a/§1b)。判定順序寫死
  「先 max_turns 再看這一輪發過幾個工具呼叫」——撞上限的回合一定跑過工具,反過來就永遠
  出不了 max_turns。**「你剛才那句沒有被執行」只在零工具時才講**:工具跑到一半才炸的
  回合說這句是假話(uid=18198 要求「刪除全部 api」,上游 503,但同一句在別的回合可能已經
  改過 `.env`)。零工具再分兩句:只有 `api_error_status` 5xx/429 或錯誤文字命中
  `API Error: (5\d\d|429)` 才說「模型服務沒有回應」,402/403(試用額度)、sink 缺方法、
  起 CLI 子行程失敗一律走中性句。分類欄位一律 `getattr` 取,不做
  `isinstance(e, sdk.ResultError)`——那個類別是 0.2.14x 才有的;迴圈裡順手抄一份
  `is_error` 的 `ResultMessage`(SDK 先送訊息、才拋例外),舊 build 也分得出來。
  `max_turns` 結構化欄位(`subtype` / `terminal_reason`)優先,CLI 文案字串比對留作退路。
  中/英由既有的漢字比例判定(抽成 `_is_zh`,與 `_lang_directive` 共用),其餘語系退英文。
- `partial` / `max_turns` 時把這一輪的工具收據(動詞+受詞)接在寫進 session sqlite 的
  assistant 文字後面。每輪開新 CLI session,這一輪的工具呼叫不在 `ss.get_context()` 裡,
  少了這行,用戶按「確認做到哪」時模型只能憑空回想。它只給下一輪的模型讀:web 面用戶讀的
  是 api 那份歷史,TG 面它是在泡泡送出之後才接上去的。
- 同 commit 的 api 端(`openclaw/webchat.py`,獨立部署):失敗的回合現在會寫進 durable
  history——`error` 分支以前只 delete 累加器,所以 F5 之後失敗訊息、半截回覆、收據、動作鈕
  全部消失(首次 subscribe 用 `latest_seq` 種 lastSeq,重載不會 replay)。歷史訊息多一個
  `fault` = `{code?, message, steps:[{tool, summary?, ms?, error?, cut?}]}`(等不到 `done`
  的那列帶 `cut: true`,前端畫成中斷步驟),`steps` 用與 live
  `tool` chunk 相同的欄位名,前端重載時可以用同一個列渲染器重建。收據靠新的
  `webchat:curtools:<user_id>` 逐輪暫存(`done`/`error` 都清)。`code` 白名單在 api 端擋
  一次,認不得就當沒送、不 400——新 runtime 打到還沒部署的 api 不能因此掉整輪。
  收據列的上限以「列」計而不是 chunk 計(`running` 才吃額度,`done` 只會填已在列的那行——
  擋掉它會讓那行變成假的「被中斷」),沒有 `id` 的列一律不標 `cut`(舊 runtime 根本不送
  `done`,標了就是捏造事實)。`error` 分支多一道等冪守衛:`_post_report` 會重送 chunk,
  沒有它重載後會看到兩則一樣的失敗通知。同時歷史裡的 user 訊息改存**原句**+另欄
  `attachment`(檔名),不再存夾著 `📎` 的顯示字串——重載後「再送一次」不能把那行標記
  當正文送給 agent,純附件訊息的 `text` 是空的,前端據此不畫鈕(spec §3)。
  檢查:`tests/check_turn_fault.py`、`tests/check_webchat_fold.py`。

- `command_listener._cmd_credentials` is now also the writer behind blaveclaw-config's
  `lib.venue.bind` (a key pasted in chat is bound through the same eviction / manifest /
  halt path as a web bind). Docstring only — no behaviour change; the dependency is
  recorded so a refactor of `_in_workspace` / `_cmd_credentials` / `_ui_manifest_ids`
  knows it has a caller outside this file.

## 1.1.61 — 2026-09-04

- Viewing context beyond a strategy: `web_bridge` now forwards `viewing_view` and
  `viewing_widgets` from the browser's `context`, and `agent_turn.build_prompt` turns
  them into the same kind of 「僅供釐清指代」 segment the open-strategy one already
  emits. On the watchboard the agent gets one line per card and the instruction to change
  the board through `lib/watch.py` — the machine cannot read the board back, so without
  this the answer to 「把這張換成 5 分 K」 was 「我看不到你開著哪一頁」 (uid=1). Each line
  is `<id>｜<title> (<type> …)`, and the prompt says so: the id is the only key the agent
  can act on, and a segment that lists the cards without naming the id just moves the dead
  end from 「我看不到」 to 「你說哪一張」.
  Only one screen segment is ever emitted: the view one is skipped whenever a strategy
  is open (web clears the selection on every other view, so they are exclusive).
  Widgets travel as one JSON argv value, not one flag per card, and unknown view codes
  are silently ignored so the frontend can add a view without a runtime release first.
- Widget labels reach an LLM prompt verbatim from the browser, so the caps and the
  filtering (24 cards, 64 chars, control chars and `[` `]` stripped — the segment is one
  bracket-delimited line, so a newline or a stray `]` closes it early and the rest reads
  as instructions) live on both sides of the wire:
  `openclaw/webchat.py` `_clamp_viewing_context` (shipped in the same commit) and
  `web_bridge.clamp_viewing`. Not redundant — runtime auto-updates in ~5 minutes while
  an api deploy is manual, so a fresh runtime routinely polls an api without the cap.
  Over-long input is truncated, never a 400.

## 1.1.60 — 2026-09-04

- Tool-call receipt: `on_tool`'s chunk now carries `id` and `summary` so the workspace
  activity line can keep one row per call instead of one verb that the next tool
  overwrites. `summary` is derived in place from `ToolUseBlock.input` — never from tool
  output. Bash never sends the full command: it prefers a workspace path starting with
  `lib/` or `strategies/` (at most two tokens), falls back to "command name + first
  non-flag argument", and sends nothing for `python3 -c …` / heredoc shapes, where the
  argument is a model-authored string with no display value. Prefix matching, not
  substring — `/usr/lib/`, `/var/lib/` and `/lib/x86_64-linux-gnu/` all contain `lib/`.
- New `on_tool_result`: the SDK returns tool results as a `UserMessage` carrying
  `ToolResultBlock`, which the turn loop did not observe at all. It is now matched back
  to the issuing `tool_use_id` and reported as a `status: "done"` chunk with `ms` and
  `error`. Result content is never forwarded (a backtest's stdout can be megabytes).
  `ms` is elapsed-since-issued, not execution time — parallel calls in one
  `AssistantMessage` share an issue timestamp. Verified on a real turn (29026,
  SDK 0.2.144, 2026-09-04); `BLAVE_AGENT_DEBUG_MSGS` keeps the probe for the next SDK
  or proxy-model change.
- `TelegramSink.on_tool_result` is a no-op but must exist: `run_turn` calls the sink
  polymorphically, and a missing method is an `AttributeError` that drops every
  tool-using Telegram turn into the generic error reply. `--delivery telegram` is the
  default.
- Server side (`openclaw/webchat.py`, shipped in the same commit): `/report` rebuilds a
  `tool` chunk from validated fields only, the same discipline as `export`, and the id
  cap is 128 — the id is minted by whichever model the proxy routed to, and dropping it
  is worse than allowing a long one, since `done` then cannot match and the row never
  settles.

## 1.1.59 — 2026-09-03

- `agent_turn`: the appended system prompt (AGENTS.md + catalog / preferences / formatting
  rules) now reaches claude via `--append-system-prompt-file <state/sysprompt-*.md>`
  (one temp file per turn, unlinked in the turn's `finally`; files older than 6 h are
  swept before the next one is created, since a killed turn / OOM / reboot skips that
  `finally`) instead of `system_prompt["append"]` → `--append-system-prompt <text>` on
  argv. Windows CreateProcess caps the command line at 32,767 chars, so the ceiling is
  set by AGENTS.md's size and both surfaces hit it: AGENTS.md grew from 26,709 (08-29)
  to 32,384 chars (09-03), pushing the total past the cap → WinError 206 → SDK
  `CLINotFoundError` → every web turn `turn failed` (2026-09-03, uid=1 large_win;
  Telegram's total is over the cap on config HEAD too). Same path on Linux. Flag
  verified on claude 2.1.239 / 2.1.246 / 2.1.258. `extra_args` is set after options
  construction (like `include_partial_messages`) so an SDK build without the field
  doesn't kill every turn; tests/stubs gains the field.

## 1.1.58 — 2026-09-03

- `agent_turn._SUGGEST_RULE` 優化選項: no more "scan the parameters" suggestion once the
  strategy folder has a `scan.json` or the turn is the adopt-and-rebacktest of scanned
  params; the MCPT line no longer suggests running MCPT (automatic in every Type A
  backtest, p-value in `stats.json`) — instead p-value > 0.05 → suggest a filter or a
  different signal, not parameter tuning.

## 1.1.57 — 2026-09-03

- Watchboard (`.claude/docs/watchboard.md` §4): `report_uploader` also sweeps
  `workspace/watch/` — `ops/*.json` POSTed to `/openclaw/agent/watch/ops` in file-name
  order (200 → `ops/sent/`, 4xx other than 408/429 → `ops/failed/`, else backoff) and
  `data/<widget_id>.json` PUT to `/watch/data/<id>` with overwrite semantics (the file
  stays in place; the mtime+size last shipped is kept in `state/watch_uploads.json`, so
  only a rewritten file is re-sent; ≤64 KB; image sidecar `data/<id>.files/` with the
  report's three-way failure rule, except a 507 on the sole block → failed). Errors go
  to `watch/upload_errors.log`; the quiet-window wait covers both trees.
  `blave-agent-reports.path` watches `watch/ops` + `watch/data` (Windows:
  `file_watcher` gets the same two dirs). `report_runner` accepts `job.json`
  `"kind": "watch"` (`prompt` optional): the run is `ok` only when
  `watch/data/<id>.json` was rewritten, `skipped` (with a stderr line) otherwise, no
  report ids; `strategy_reporter.report_schedules` leaves watch jobs out of the
  定期報告 list. Check: tests/check_agent_watch.py.

## 1.1.56 — 2026-09-02

- performance_report retired: Blave Agent ships **no built-in report** — every
  report is a job the user registered under `workspace/report_jobs/`
  (`.claude/docs/report-schedules.md`) or asked for in chat. The hourly equity
  sampling into `workspace/state/equity_history.jsonl` goes with it (nothing else
  read that file; the platform keeps `agent_equity_snapshot`).
  `blave-agent-perfreport.{service,timer}` and the Windows `blave-agent-perfreport`
  task leave `jobs.json` + `blave_agent/systemd/`. **Fleet mechanism — read before
  assuming the timer is gone:** the manifest has no remove semantics.
  `control/updater.py apply_jobs` only installs listed units and `enable --now`s the
  `enable: true` ones; `_apply_windows_tasks` only registers listed tasks. A dropped
  entry (and equally `"enable": false`) leaves the unit enabled / the task
  registered on every machine that took 1.1.52–1.1.54, and control/ cannot update
  itself. So `performance_report.py` stays as a tombstone that exits 0: those
  machines keep an hourly fire that reads nothing, writes nothing and uploads
  nothing, instead of an hourly `failed` unit. Actually removing it is a
  per-machine hand step (`systemctl disable --now blave-agent-perfreport.timer`,
  rm the two unit files, `daemon-reload` / `Unregister-ScheduledTask
  blave-agent-perfreport`), after which the tombstone can be deleted. Existing
  `daily-*` / `wk-*` / `mo-*` reports and `state/equity_history.jsonl`,
  `state/performance_report.json` are left in place. tests/check_report_pipeline.py
  shrinks to the uploader half (the fixtures stand in for the generator's docs).

## 1.1.55 — 2026-09-02

- strategy_reporter: `strategies/<name>/scan.json` (blaveclaw-config
  `lib/param_scan.write_scan`, the 穩健參數 grid) is reported as the strategy's
  top-level `scan`, sibling of `backtest`; absent / unparseable → key absent, never
  fatal. `signature()` gains a fourth column (scan.json mtime+size, no live
  exemption — only an explicit scan writes it) so a finished scan reaches the open
  workspace mid-turn. Shape validation is the api's (`agent_strategies._clean_scan`,
  drops the key alone). Check: tests/check_strategy_scan.py.

## 1.1.54 — 2026-09-02

- report crontab lines address the runner through `<BASE>/current/`, not the resolved
  `releases/<version>/` path `__file__` gives on a machine (29026 e2e) — a line is only
  rewritten when it changes, so a pinned path would keep every job on the release it was
  installed under.
- Scheduled reports (`.claude/docs/report-schedules.md`): the agent registers a
  job by writing `workspace/report_jobs/<id>/{job.json,run.py}`; this runtime
  owns everything after that. New `report_runner.py <id>` runs the script
  (cwd=workspace, system python, `BLAVE_*` stripped, 600 s), classifies the run
  `ok` / `skipped` (exit 0, no `reports/*.json` with mtime ≥ start) / `failed`,
  appends to `runs.jsonl` (last 50 kept, stems `[A-Za-z0-9_-]{1,64}` only, ≤50),
  overwrites `run.log`, holds `report_jobs/<id>/.lock` for the run (a second
  runner exits 3 without recording), and on `failed` calls
  `manager/alert_failure.py` best-effort. Stdlib-only, no runtime imports. `command_listener._sync_report_crons`
  installs one `# blave-report:<id>` crontab line (Linux) / `blave-web-report-<id>`
  scheduled task (Windows, cron subset only) per enabled job, under `_cron_lock`,
  every scheduler tick and after each `report_*` command; the crontab is only
  rewritten when the tagged set differs. Five new commands: `report_pause`,
  `report_resume`, `report_run_now`, `report_delete`, `report_edit_pending`
  (args `{id}`; the last also takes `prompt` / `schedule_human`). `strategy_reporter`
  adds `report_schedules` to the cache payload (registration + last run +
  `next_run_at` from a built-in 5-field cron evaluator; `{id, error}` for a job
  it will not install: bad file, cron field outside ASCII `[0-9*,/-]` or a
  timestamp outside 0–2100, past the 20 valid-job cap, Windows-inexpressible
  cron) — omitted, not emptied, if the scan itself fails.

## 1.1.53 — 2026-09-02

- performance_report: the daily report gains a 運行狀況 section after the
  existing blocks — one `table` row per strategy known to either
  `strategies/*/state.json` or `state/deployments.json` (排程 = the registry's
  `type`, 最後成功執行 = `state/heartbeat/<name>` mtime as 「3 小時前」, 逾期 =
  heartbeat older than 2 × `expect_every_minutes`, 目前部位 = state.json
  position; `type == "daemon"` registry entries — the reconciler — are NOT
  strategies and are left out, the service-heartbeat callout covers them),
  plus `callout` blocks (tone warning) that appear ONLY when there is something
  to say. The daily is per-day and idempotent, so the HALT callout is
  REPORT-DAY based, not 「now」 based: it reads `state/audit.jsonl` (lib/guard.py's
  append-only `halt_tripped` / `halt_cleared` lines, last 1 MB) and fires when a
  `halt_tripped` falls inside the report day (lists the day's tripped / cleared
  times + reason + source, `%m/%d %H:%M` UTC like every other timestamp) OR
  `state/HALT` still exists (adds a 「目前仍在 HALT」 line with the file's ts /
  reason / source; title 「HALT：新倉下單已暫停」 vs 「…曾暫停新倉下單（已解除）」).
  A halt tripped and cleared within the day is therefore reported even though
  the file is gone by the time the daily is produced. The other callouts:
  entries in `manager/order_errors.json` dated the report's day — titled
  「下單失敗（最近 N 筆）」 because the writer (`lib/portfolio._record_order_error`)
  keeps only the last 5, so the day's true count is unknowable; lines in
  `reports/upload_errors.log` dated that day (≤5); and a `reconciler` /
  `command_listener` heartbeat that exists and is older than 300 s — this one
  is a LIVE condition (heartbeats have only an mtime, no history), so its
  title and first line say 「產報告時」 with the generation time. Nothing wrong
  = no callout; silence is the normal state. The columns are untagged
  (`text`): the position carries a sign but is a direction, not a P&L, so the
  contract's colour gate must stay neutral. The service-heartbeat callout only
  fires when the heartbeat FILE exists — a machine that never configured
  auto-trading has none, and a daily 「reconciler dead」 for it would be noise.
  Every input is optional: a missing file drops that row/callout, never the
  report. Existing daily/weekly blocks are byte-identical to before.
- performance_report: new monthly report, `mo-YYYY-MM` (`type=performance`,
  `report_type=績效月報`, period = first..last day of the last FINISHED UTC
  month, same catch-up semantics as the weekly). Blocks: kpi_row (帳戶權益 /
  本月報酬 / 本月最大回撤 / 年化波動 / 交易日數 / 策略數), line_chart 本月權益
  (with `y_unit`), drawdown over the month window, the monthly-returns calendar
  heatmap (same ≥2-month gate as the weekly), metric_table 風險指標 = the
  weekly set computed on the month's daily closes (the first day's base is the
  previous month's last close, matching `monthly_returns`) plus Sortino,
  Calmar, 勝率(日), 獲利因子(日), 最佳日 / 最差日 — undefined ratios (no losing
  day, no downside, no drawdown) render as 「—」 rather than 0 or inf — and the
  分策略 table. **No 「分策略貢獻」 bar_chart**: nothing on disk is a real
  per-strategy P&L — `orders.jsonl` `contributors` are each strategy's TARGET
  notional at reconcile time and `stats.json` `daily_returns` are backtests —
  so the block is omitted rather than invented. `due()` now returns a third
  element (the month) and `main()` runs a third `("monthly", …)` tuple, so
  idempotence / state / rollback come from the same loop.
- performance_report: `strategy_rows()` and `exposure_rows()` are computed
  ONCE per tick in `main()` and passed into all three builders (lazily — a
  tick where every report is already done still scans nothing), instead of
  each build re-walking `strategies/` (stats.json can be several MB) inside
  the shared `_BUDGET_S`. Standalone calls still compute their own.
- tests/check_report_pipeline.py: builds daily + monthly from fixture files
  (deployments / heartbeats / HALT / audit.jsonl / order + upload errors)
  through the real `validate_report`, asserts the 運行狀況 roster (daemon
  excluded), the overdue rule at a point where 1× vs 2× flips (90-min-old
  heartbeat on a 60-min cadence), a future-mtime heartbeat (age 0, not
  overdue), per-day filtering, the four HALT cases (tripped on the day and
  still halted / tripped-and-cleared within the day with the file gone /
  standing halt from an earlier day / events on other days only → no callout),
  zero callouts on a healthy machine with AND without service heartbeat files,
  an all-up month rendering Sortino / 獲利因子 / Calmar as 「—」 with no nan /
  inf string anywhere, `due()` across the year boundary and a leap February,
  and proves the check is wired to the validator by over-filling one metric
  cell (must 400).

## 1.1.52 — 2026-09-01

- telegram_bridge: `download_tg_file` scrubs the bot token out of exception text
  before logging — the download URL embeds the token, and exceptions like
  `http.client.InvalidURL` echo the whole URL; with blaveagent now in the
  systemd-journal group, stderr is readable by user-side code on the machine.
- report_uploader: new — the machine's only path from a report JSON to
  `PUT /openclaw/agent/report/<id>`, and the owner of the drop-dir contract
  (`workspace/reports/<id>.json`, written atomically, id = file stem). Runs a
  deliberately looser-than-api contract check before spending a request and
  writes every refusal — local or the api's own 400 — to
  `workspace/reports/upload_errors.log` so the machine's agent can read what it
  got wrong. Uploaded reports move to `reports/sent/`, permanently refused ones
  to `reports/failed/`; transient failures back off (60s→1h) and retry
  indefinitely. No Telegram here — the summary push is platform-side
  (`agent_reports._notify_stored`), so sending from the machine too would
  double every alert. This file's existence is also what flips
  `strategy_reporter._can_report()` true fleet-wide.
- report_uploader: report figures now ride along in a sidecar directory,
  `workspace/reports/<id>.files/` — an `image` block carries `{"file":
  "equity.png"}` and this process uploads the bytes (same strategy_image
  channel, now via the public `strategy_reporter.put_image`) and rewrites the
  field into `sha256`. Producers need no token, which is the point:
  `command_listener._strategy_subprocess_env()` strips every `BLAVE_*`, so a
  scheduled script could not PUT an image at all — and scheduled research
  figures are what the block exists for. Failure semantics split three ways:
  a producer mistake (missing file, non-image extension, 0/>2MB) refuses the
  whole report, anything transient defers it intact, and only a 507 image
  quota drops the block and ships the rest (logged, plus the quota marker the
  agent raises in chat). Sidecars move with their report into `sent/` /
  `failed/`; orphaned ones are swept after a day. Contract:
  `.claude/docs/report-blocks.md` §2.5.
- report_uploader: the exit code speaks only to service-level failure (no
  `BLAVE_PROXY_TOKEN`, drop dir uncreatable). A round that ran to completion is
  `rc=0` no matter what it processed — deferrals are a normal state (api
  briefly down, figure still being written, tick budget spent) and a permanent
  refusal is the producer's broken report being correctly archived, so exiting
  1 on either left `blave-agent-reports.service` sitting in `failed` and buried
  real faults in false ones (seen on 29026). Nothing is lost: the counts line
  reaches the journal on Linux and `logs\tasks.log` on Windows regardless of
  rc, and refusals/backoffs keep their durable records in
  `upload_errors.log` + `failed/` and `state/report_uploads.json`.
- performance_report: new — deterministic, zero-LLM daily/weekly performance
  reports. Hourly: samples account equity into
  `workspace/state/equity_history.jsonl` (same cadence and per-venue rules as
  the platform's `agent_equity_snapshot`) and drops `daily-YYYY-MM-DD` /
  `wk-YYYY-MM-DD` in the drop dir when the period they cover has ended. Reads
  disk products only (`manager/account.json`, `manager/last_reconcile.json`,
  `strategies/*/{state,stats}.json`) — never `workspace/lib/`, which may be
  arbitrarily old. Missing inputs cost blocks, not the report; mixed-currency
  accounts degrade rather than invent an fx rate.
- performance_report: the weekly risk grid now tags each metric with the
  contract's `metric_table.items[].format` — untagged items render neutral, so
  without it the signed ones (年化報酬, 最大回撤) lose their up/down colour.
  Needs an api that accepts the field (same release train as the rest of this
  section); an older api refuses the whole report with 400.
- report_uploader: a deeply nested report JSON is now refused into `failed/`
  instead of killing the run. `json.loads` raises `RecursionError` on it, which
  is a `RuntimeError` subclass and NOT a `ValueError`, so it went straight
  through `upload_one` → `run_once` → `main()` with `_save_state` never
  reached — and since `pending()` orders by mtime, oldest first, the poison file
  sorts first on every subsequent path/timer run, so one such file meant that
  machine never shipped another report until somebody SSH'd in and deleted it.
  Same widening on `_read_json` (the backoff state file) and on `_serialize`.
- report_uploader: a report file is size-checked before it is read. Anything
  past 4× `REPORT_MAX_BYTES` cannot serialize under the 2 MB ceiling anyway, and
  reading a multi-GB file out of the drop dir just to find that out would OOM
  the machine; it is refused into `failed/` unread.
- performance_report: non-finite numbers are gated everywhere they enter, not
  just type-checked. `_read_json` uses a bare `json.load`, which ACCEPTS the
  non-standard `NaN` / `Infinity` literals, so a venue reporting a broken equity
  reached `append_sample`'s `json.dumps(allow_nan=False)` and raised a
  `ValueError` that the surrounding `except OSError` did not catch — `main()`
  died in the sampling step and the daily/weekly reports were never produced at
  all. The same gate keeps a NaN backtest Sharpe out of the per-strategy table,
  where `f"{nan:.2f}"` had been rendering the string `nan` as if it were a
  number.
- performance_report: the daily and weekly builds now share ONE deadline,
  computed at the start of `main()`. Each used to anchor its own
  `time.time() + _BUDGET_S` at call time, so a Monday run could spend 60s + 60s
  plus sampling and blow through the unit's `TimeoutStartSec=120` — SIGKILL,
  state unsaved, the whole thing repeated the next hour.
- performance_report: a venue that reports no currency at all now degrades the
  equity series the same way a genuinely mixed-currency account does. It used to
  be dropped from the currency set and silently summed in with the known ones,
  which is exactly the invented fx rate this module refuses to produce. A
  machine where NO venue reports a currency still gets its chart, unlabelled.
- file_watcher: watches the reports drop dir (Windows stand-in for the new
  `blave-agent-reports.path`).
- report_uploader: a run woken by the drop-dir trigger now waits out the
  half-written-file quiet window (≤3s, on the same tick budget) and rescans
  once, instead of exiting empty-handed. The trigger fires milliseconds after
  the write, so every report was inside `QUIET_S` when the run started and
  systemd never re-triggers for events during a run — measured 148s from
  landing to upload, i.e. the path unit was a no-op for normal writes. The
  guard itself is untouched: a file still being written when the wait ends
  falls to the 2-minute timer as before, and a run with nothing new never
  sleeps. Same fix on Windows, where `file_watcher` runs the same script. A
  run that ships nothing now says what it saw ("inside the quiet window" /
  "half-written .tmp" / "backing off") — those were indistinguishable silent
  runs in the journal.
- performance_report: the daily/weekly equity `line_chart` now carries the
  account currency as the contract's `line_chart.y_unit` — apart from
  `drawdown` (the one chart whose unit the contract pins), the web cannot tell
  a % series from a USDT equity series, so omitting it printed the axis as bare
  numbers even though the same report's `kpi_row` was already labelling the
  equity "USDT" (seen on 29026). Only when the currency is known and fits the
  contract's 8-char limit: a longer string is dropped rather than truncated (a
  truncated ticker is a wrong unit, which is worse than none), and mixed
  currencies already drop the whole series upstream, so a chart that exists has
  exactly one currency or none at all. No other chart block gains a unit:
  `drawdown` is pinned by the contract and `heatmap` has no such field.
- jobs.json: `blave-agent-reports` (uploader, 2 min + path/dir trigger) and
  `blave-agent-perfreport` (hourly) on both Linux and Windows.

## 1.1.51

- strategy_reporter: the change watcher's live-strategy exemption now also
  covers strategies in the deployment registry (state/deployments.json,
  wait_for_bar/cron) — web-deployed strategies run with BLAVE_MODE=live and
  keep MODE="backtest" in the file, so per-bar stats.json rewrites were
  firing a ~0.5MB strategies chunk every bar, around the clock (uid=32321,
  116MB replay buffer). Registry read is fail-open.
- portfolio_reporter: strategy figures now carry `ran_at` (stats.json mtime).
  The workspace page uses it to judge "would a re-run help" — backtests run
  within 24h are never flagged stale, making holiday closures a non-issue
  (web fallback until this ships: weekday-lag rule, immune to weekends only).

## 1.1.50

- web_bridge: strategy change watcher — polls strategy_reporter.signature()
  every 3s so BYO-agent backtests reach the workspace in seconds instead of
  the 2-min reporter timer. (Recorded retroactively — shipped without a
  changelog entry; its draft-strategy blind spot is fixed in 1.1.51.)

## 1.1.49

- strategy_reporter: side-rail breathing dot now covers Type A/C in-process
  scheduler runs (previously only crontab entries were scanned).
