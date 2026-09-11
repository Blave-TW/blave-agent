# Runtime changelog

Queued-for-release state lives HERE, not in anyone's memory: any commit that
changes `runtime/` adds a line under **Unreleased** in the same commit. At
publish time, bump `VERSION`, move the Unreleased lines under the new version
heading, and ship — the file sits next to `VERSION` so the publisher cannot
miss it. (Channel rules: `.claude/docs/blave-agent-update-channels.md`.)

## Unreleased

(none)

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
