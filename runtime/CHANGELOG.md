# Runtime changelog

Queued-for-release state lives HERE, not in anyone's memory: any commit that
changes `runtime/` adds a line under **Unreleased** in the same commit. At
publish time, bump `VERSION`, move the Unreleased lines under the new version
heading, and ship — the file sits next to `VERSION` so the publisher cannot
miss it. (Channel rules: `.claude/docs/blave-agent-update-channels.md`.)

## Unreleased

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
