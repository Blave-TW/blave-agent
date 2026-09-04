"""
Web bridge: the website-chat counterpart to telegram_bridge.py. Long-polls the
Blave web-chat transport (api/openclaw/webchat.py) for messages the website
queued for this machine, and spawns one agent_turn.py per message with web
delivery (chunks POSTed back to /report, browser reads them over SSE).

Same trust model as the LLM proxy: this machine authenticates with its own
proxy-{ttyd_password} (BLAVE_PROXY_TOKEN), which the transport resolves to this
user's id — so /poll only ever yields this user's messages.

agent_turn.py is resolved relative to THIS file so a version deploy (symlink
swap, see updater.py) picks up the matching agent_turn.py on the next spawn.
"""
import base64
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
import urllib.request

import model_prefs
import command_listener
import portfolio_reporter
import strategy_reporter

BASE = os.environ.get("BLAVE_AGENT_BASE") or (
    r"C:\blave-agent" if os.name == "nt" else "/opt/blave-agent"
)
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))

API_BASE = os.environ.get("BLAVE_CHAT_API_BASE", "https://api.blave.org/openclaw/chat")
# lease=1: delivered messages stay recoverable server-side until we ACK at spawn —
# without it, a message claimed right before a release swap killed this process was
# gone forever (user watched「思考中」until the watchdog gave up; 07-28 實踩).
POLL_URL = f"{API_BASE}/poll?lease=1"
ACK_URL = f"{API_BASE}/ack"
REPORT_URL = f"{API_BASE}/report"
PROXY_TOKEN = os.environ.get("BLAVE_PROXY_TOKEN", "")

AGENT_TURN_SCRIPT = os.environ.get("BLAVE_AGENT_TURN_SCRIPT", f"{_THIS_DIR}/agent_turn.py")
PYTHON_BIN = os.environ.get("BLAVE_AGENT_PYTHON") or (
    rf"{BASE}\venv\Scripts\python.exe" if os.name == "nt"
    else f"{BASE}/venv/bin/python3"
)
HEARTBEAT_PATH = os.environ.get("BLAVE_AGENT_WEB_HEARTBEAT", f"{BASE}/state/web_heartbeat")

# 附件落地位置——WORKSPACE 解析跟 agent_turn.py 一致,agent 的 cwd 就是 workspace,
# 訊息裡給相對路徑 tmp/inbound/... 它自己 Read 得到
WORKSPACE = os.environ.get("BLAVE_AGENT_WORKSPACE", f"{BASE}/workspace")
INBOUND_DIR = f"{WORKSPACE}/tmp/inbound"

# 目前正在處理的 session(SIGTERM handler 要知道該通知誰)
_current_session = {"id": None}

# sync_strategies 的序列化鎖:turn-end、command-applied、下面的變化偵測 thread
# 三個來源共用一把,兩份掃描+上報永遠不會交疊(同一份 stats.json 掃到一半)。
_sync_lock = threading.Lock()
# 最近一次 sync_strategies 實際起跑(拿到鎖、開掃)的時刻。watcher 用它清帳:
# 變動發生在這個時刻之前 → 那次 scan 已把變動收走,pending 的 dirty 不必再開一發
# (沒有這條,幾乎每個改策略的回合都會 turn-end + watcher 各 sync 一次,degraded
# 網路下兩份排隊最壞 ~180 秒 > watchdog STALE_THRESHOLD 120 秒——uid=32321
# 「turn-end chunk 沒送出去就被重啟」的復刻路徑)。
_last_sync_started = 0.0

# 一輪的硬上限。參數掃描是網格搜尋(每組都回測),600s 常常不夠——真正的煞車
# 是 agent_turn 自己的 max_budget_usd/max_turns,這裡只防永久卡死。
# 必須嚴格大於 agent_turn 給 Bash 工具的 30 分鐘上限(一支前景跑滿的回測 +
# 模型往返 + 摘要壓縮),否則照規則前景跑的大回測會在這裡被殺(2026-08-22 稽核)。
TURN_TIMEOUT = 2100
# 掃描期間 agent 跑一條長 bash,中間完全不會有 chunk;前端看門狗會誤判成
# 「機器死了」。每分鐘送一個 ping 讓它知道還活著(前端只用來重置計時,不顯示)。
PING_INTERVAL = 60
# 連續幾次 TLS 憑證驗證失敗就自我了斷,讓服務管理器重拉。Windows 冷機的 Schannel
# root store 只帶 ~33 張憑證、其餘 root 要等第一次 Schannel 驗證才下載,而 python
# 的 SSL context 在 process 啟動時就固定——first-boot 事後補進系統的 root,對已經
# 在跑的這個 process 永遠不可見,它會一路 CERTIFICATE_VERIFY_FAILED 到有人重啟
# (1.0.71 image 實測)。憑證以外的錯誤不算,計數歸零。
TLS_FAIL_LIMIT = 5

# 看盤脈絡的長度上限。api 端(openclaw/webchat.py `_clamp_viewing_context`)已經
# 剪過一次,這裡再剪一次不是重複:runtime 5 分鐘自動全機隊更新、api 部署是手動的,
# 新 runtime 完全可能在還沒部署剪裁的 api 上跑,而這些字串直接進 LLM prompt 也直接
# 進 argv。兩邊值一樣,沒有共用模組可 import(不同機器上的不同 process)。
_VIEWING_VIEW_RE = re.compile(r"[a-z0-9][a-z0-9_-]{0,31}")
VIEWING_WIDGETS_MAX = 24
VIEWING_WIDGET_LABEL_MAX = 64


def clamp_viewing(view, widgets):
    """回傳 (view, widgets) 的安全版本:形狀不對就當沒有,太長就剪。

    控制字元與中括號一併剝掉:這些字串會進 prompt 裡一段 [ ] 包起來的單行脈絡,
    換行或一個 ] 就足以提前關掉那一段,後面的內容會被當成指令讀。"""
    if not isinstance(view, str) or not _VIEWING_VIEW_RE.fullmatch(view):
        view = None
    if isinstance(widgets, list):
        clean = []
        for item in widgets[:VIEWING_WIDGETS_MAX]:
            if isinstance(item, str):
                label = "".join(
                    c for c in item if ord(c) >= 32 and c not in "[]"
                )[:VIEWING_WIDGET_LABEL_MAX].strip()
                if label:
                    clean.append(label)
        widgets = clean or None
    else:
        widgets = None
    return view, widgets


def poll_once():
    """One long-poll (blocks up to ~25s server-side). Returns the message list."""
    req = urllib.request.Request(POLL_URL, headers={"x-api-key": f"proxy-{PROXY_TOKEN}"})
    with urllib.request.urlopen(req, timeout=35) as resp:
        return json.loads(resp.read()).get("messages", [])


def ack_message(message_id):
    """Confirm we're processing this message — the server drops its recovery lease.
    Called at spawn time, NOT turn end: a mid-turn death must not replay a half-
    executed message. Best-effort: on failure we process anyway (worst case the
    lease expires and the message redelivers once — visible, unlike a lost one)."""
    if not message_id:
        return
    try:
        req = urllib.request.Request(
            ACK_URL, data=json.dumps({"message_ids": [message_id]}).encode(),
            headers={"Content-Type": "application/json",
                     "x-api-key": f"proxy-{PROXY_TOKEN}"},
        )
        urllib.request.urlopen(req, timeout=10).read()
    except Exception as e:
        print(f"[web_bridge] ack failed for {message_id}: {e}", file=sys.stderr)


def sync_strategies():
    """Right after a turn (which is when the agent may have created/deployed a
    strategy), push the fresh list two ways: a live chunk on the chat stream so
    the open workspace updates the left rail instantly, and the cache so a page
    reload is fresh too. The timer (strategy_reporter) is only a slow fallback.

    序列化:三個呼叫源(turn-end / command-applied / 變化偵測 thread)共用
    _sync_lock,不讓兩份 scan+report 交疊。"""
    with _sync_lock:
        _sync_strategies_locked()


def _sync_strategies_locked():
    global _last_sync_started
    _last_sync_started = time.time()
    try:
        strategies = strategy_reporter.scan()
    except Exception as e:
        print(f"[web_bridge] strategy scan failed: {e}", file=sys.stderr)
        return
    # 順序重要:先寫快取(含圖)、再推 live chunk。瀏覽器收到 chunk 後幾秒會
    # refetch 快取補圖——倒過來的話 refetch 會跟快取寫入競速,輸了圖就不出現
    # (實測撲空過)。
    # cache: WITH images(這條走 8000 端點,沒有串流的 2MB 上限)。回合中產生
    # 的圖表因此在回合結束當下就進快取,不用等 2 分鐘的 timer。
    try:
        sigs = strategy_reporter.attach_images(strategies)
        strategy_reporter.report_cache(strategies, token=PROXY_TOKEN)
        strategy_reporter.save_image_sigs(sigs)
    except Exception as e:
        print(f"[web_bridge] strategies cache update failed: {e}", file=sys.stderr)
    # live: goes through the SSE stream the browser already has open (2MB /report cap
    # — live_chunk drops images and, when needed, the heavy backtest arrays; the browser
    # refetches the full cache a few seconds after this chunk).
    chunk = json.dumps(strategy_reporter.live_chunk(strategies)).encode()
    req = urllib.request.Request(
        REPORT_URL, data=chunk,
        headers={"Content-Type": "application/json", "x-api-key": f"proxy-{PROXY_TOKEN}"},
    )
    try:
        urllib.request.urlopen(req, timeout=15).read()
    except Exception as e:
        print(f"[web_bridge] strategies chunk push failed: {e}", file=sys.stderr)


def sync_portfolio():
    """Same idea for the 投資組合 view: a turn is the only thing that changes
    weights / members / capital, and waiting for the 2-minute timer leaves the
    user reading pre-turn numbers long enough to redo the operation. Cache only,
    no stream chunk — that view refetches the cache itself after a turn, and its
    payload (per-allocator backtest series) does not belong on the 2MB-capped
    /report."""
    try:
        portfolio_reporter.report(portfolio_reporter.build_report(), token=PROXY_TOKEN)
    except Exception as e:
        print(f"[web_bridge] portfolio report failed: {e}", file=sys.stderr)


def _post_chunk(chunk, log=False):
    """Best-effort POST of one chunk to the web-chat transport."""
    try:
        req = urllib.request.Request(
            REPORT_URL, data=json.dumps(chunk).encode(),
            headers={"Content-Type": "application/json",
                     "x-api-key": f"proxy-{PROXY_TOKEN}"},
        )
        body = urllib.request.urlopen(req, timeout=5).read()
        if log:
            print(f"[web_bridge] chunk {chunk['type']} → {body[:60]}", file=sys.stderr)
    except Exception as e:
        if log:
            print(f"[web_bridge] chunk {chunk['type']} FAILED: {e}", file=sys.stderr)


def report_turn_aborted(session_id, message=None):
    """Tell the browser the in-flight turn died, so the UI stops spinning. Called
    on SIGTERM (systemd stop/restart — e.g. a release swap) and on the turn
    timeout; without it the user just watches 「思考中」forever with no reply
    and no error."""
    _post_chunk({"type": "error", "session_id": session_id,
                 "message": message or "這輪處理被中斷了（機器剛更新或重啟），請再問一次。"},
                log=True)
    _post_chunk({"type": "done", "session_id": session_id}, log=True)


def save_attachment(attachment):
    """把 /send 帶來的 inline base64 附件落地,回傳最終檔名(相對 tmp/inbound/);
    失敗回 None。VM 端不盲信 api——檔名再消毒一次、decode 失敗當接收失敗。"""
    try:
        name = "".join(
            c for c in os.path.basename(str(attachment.get("name") or "")) if ord(c) >= 32
        )
        if not name:
            raise ValueError("empty attachment name")
        data = base64.b64decode(attachment.get("data") or "", validate=True)
        os.makedirs(INBOUND_DIR, exist_ok=True)
        path = os.path.join(INBOUND_DIR, name)
        if os.path.exists(path):
            name = f"{int(time.time())}_{name}"
            path = os.path.join(INBOUND_DIR, name)
        with open(path, "wb") as f:
            f.write(data)
        return name
    except Exception as e:
        print(f"[web_bridge] attachment save failed: {e}", file=sys.stderr)
        return None


def run_agent_turn(session_id, message, viewing_strategy=None, viewing_tab=None,
                   attachment_name=None, viewing_view=None, viewing_widgets=None):
    # 圖片附件輪由 resolve() 覆寫成 Claude(DeepSeek 相容端點不支援 image block)
    model = model_prefs.resolve(session_id, attachment_name)
    cmd = [
        PYTHON_BIN, AGENT_TURN_SCRIPT,
        f"--model={model}",
        "--delivery=web",
        f"--report-url={REPORT_URL}",
        # report token (== proxy token) is read from the inherited BLAVE_PROXY_TOKEN
        # env, not passed on argv (argv is visible in `ps`).
    ]
    if viewing_strategy:
        cmd.append(f"--viewing-strategy={viewing_strategy}")
    if viewing_tab in ("code", "data"):
        cmd.append(f"--viewing-tab={viewing_tab}")
    viewing_view, viewing_widgets = clamp_viewing(viewing_view, viewing_widgets)
    if viewing_view:
        cmd.append(f"--viewing-view={viewing_view}")
    if viewing_widgets:
        # 一個 JSON 參數,不是每張卡一個旗標:清單本來就是一個值,重複旗標會讓
        # argv 長度隨板子大小漂移。ensure_ascii 保持預設:argv 純 ASCII,Windows
        # 那半機隊不吃 codepage 的虧——代價是中文一字膨脹成 \uXXXX 六個字元,
        # 上面剪過之後最壞(24 張卡 × 64 個中文字)約 9KB,離 Linux 單一參數 128KB
        # 與 Windows 命令列 32K 都還很遠。
        cmd.append(f"--viewing-widgets={json.dumps(viewing_widgets)}")
    # `--` terminates options so a message starting with '-' (or literally '--help')
    # is taken as the positional arg, not parsed as a flag (which would silently
    # print help + exit 0 and the user would get nothing back).
    cmd += ["--", session_id, message]
    _current_session["id"] = session_id
    proc = subprocess.Popen(cmd)
    deadline = time.time() + TURN_TIMEOUT
    next_ping = time.time() + PING_INTERVAL
    try:
        while proc.poll() is None:
            time.sleep(1)
            now = time.time()
            # 心跳必須在這裡也跳:heartbeat 的語意是「這個 loop 還活著」,不是
            # 「這個 loop 有空」。只在 main() 迴圈頂端 touch 的話,整輪(實測可達
            # 273 秒)心跳都是 stale,control/heartbeat_watchdog.py 只能靠
            # turn_in_flight()(pgrep agent_turn.py)這個旁證擋下重啟——而 child
            # 一 exit 旗子就落下,後面的 sync_portfolio()/sync_strategies()(圖
            # base64 + 數 MB 上傳,好幾秒)整段裸奔。2026-08-26 uid=32321 就是在
            # 那個窗口被 watchdog 重啟,turn-end 的 strategies chunk 沒送出去,
            # 工作頁的新策略整整 23 分鐘沒長出回測。這樣改不會削弱偵測力:回合中
            # 本來就被 turn_in_flight() 擋著不會重啟,child 真的卡死另有
            # TURN_TIMEOUT 收尾。
            touch_heartbeat()
            if now >= next_ping:
                _post_chunk({"type": "ping", "session_id": session_id})
                next_ping = now + PING_INTERVAL
            if now >= deadline:
                print(f"[web_bridge] agent_turn exceeded {TURN_TIMEOUT}s — killing",
                      file=sys.stderr)
                proc.kill()
                proc.wait(timeout=10)
                report_turn_aborted(
                    session_id,
                    "這輪跑太久被中止了（超過 30 分鐘）。可以把任務拆小一點再試，"
                    "例如縮小掃描範圍或減少參數組合。",
                )
                return False
    finally:
        _current_session["id"] = None
    if proc.returncode != 0:
        print(f"[web_bridge] agent_turn failed (exit {proc.returncode})", file=sys.stderr)
        return False
    return True


def touch_heartbeat():
    """寫不進去只印一行就算了,絕不讓例外往上竄:這個函式現在是回合中每秒呼叫
    (一輪最多 ~2100 次),而不是每個 poll 迴圈一次。碟滿(workspace 跟 heartbeat
    同一顆)或 Windows 上 AV 暫時鎖檔時拋 OSError,例外會穿過 run_agent_turn 的
    finally 打死整個 main —— on_term 是 signal handler 不會跑(瀏覽器卡在「思考
    中」),而且回合後的 sync_portfolio()/sync_strategies() 直接沒機會跑,等於
    原封不動複製了這個 patch 要修的那個症狀。心跳寫不進去本來就該由 watchdog
    處理(它會照常判 stale 然後重啟),不該由一輪對話陪葬。"""
    try:
        os.makedirs(os.path.dirname(HEARTBEAT_PATH), exist_ok=True)
        with open(HEARTBEAT_PATH, "w") as f:
            f.write(str(time.time()))
    except OSError as e:
        print(f"[web_bridge] heartbeat write failed: {e}", file=sys.stderr)


def on_term(signum=None, frame=None):
    """systemd stop/restart (release swap, reboot…) while a turn is running:
    tell the browser before we go, or it spins on 「思考中」forever."""
    sid = _current_session.get("id")
    if sid:
        print(f"[web_bridge] SIGTERM mid-turn ({sid}) — telling the browser",
              file=sys.stderr)
        report_turn_aborted(sid)
    sys.exit(0)


# ── 變化偵測 thread(治本:不等 reporter 的 2 分鐘 timer)──────────────────────
# reporter 的 timer 每 2 分鐘一班,回測寫入若卡在兩班之間、或撞上寫一半的半套
# 狀態,workspace 最壞要等 ~2.5 分鐘才長出資料。這條 thread 每 3 秒用
# strategy_reporter.signature() 比一次指紋(毫秒級;live 策略它是 existence-only,
# per-bar 重寫零觸發——這是選它、不另造偵測的理由),內容一停穩就立刻 sync,
# 把延遲從分鐘壓到十幾秒。timer 保留當更慢資產(如 chart export)的兜底。
_WATCH_POLL_S = 3
# 指紋要「連續穩定」這麼久才開火:>實測 stats.json→pnl.png 的 7 秒 gap,免得在
# 回測寫到一半(stats 有了、圖還沒)就上報。更慢的 chart export 交給下一發或 timer。
_WATCH_STABLE_S = 10
# 全域最小開火間隔:參數掃描的連環回測會讓指紋每幾秒變一次,靠這個 + stable 窗
# 自然 coalesce 成一發,不會每輪回測都上報一次。
_WATCH_MIN_INTERVAL_S = 15


def _strategy_change_watcher():
    """See the block comment above. daemon thread,失敗只印不倒。"""
    last_fp = None
    dirty_since = None   # 指紋最後一次變動的時刻;None = 沒有待處理的變動
    last_fire = 0.0
    while True:
        # 整圈 try/except 續命:這條 thread 無聲死掉 = 偵測退化回 2 分鐘 timer,
        # 而它會死的路徑偏偏都很無聊(stderr 管道斷掉讓 print 自己拋 OSError)。
        # except 裡的 print 再包一層——報告失敗的那行也可能就是斷掉的管道。
        try:
            time.sleep(_WATCH_POLL_S)
            fp = strategy_reporter.signature()
            now = time.time()
            if last_fp is None:
                last_fp = fp     # 第一筆當基準,不開火
                continue
            if fp != last_fp:
                last_fp = fp
                dirty_since = now  # 重啟 stable 窗——連環回測會一直重置,天然 coalesce
                continue
            # 這一拍指紋沒變
            if dirty_since is None:
                continue           # 沒有待處理變動
            if dirty_since < _last_sync_started:
                # 這筆變動發生在最近一次 sync 起跑之前——那次 scan(turn-end 或
                # 上一發 watcher)已把它收走,再開一發只是重複上報+佔鎖
                dirty_since = None
                continue
            if now - dirty_since < _WATCH_STABLE_S:
                continue           # 還沒穩夠久
            if now - last_fire < _WATCH_MIN_INTERVAL_S:
                continue           # 太頻繁:保留 dirty_since,冷卻後下一拍補跑(pending)
            # 回合進行中不搶跑:turn-end 自己會 sync,這裡跑只是重複又要搶鎖。保留
            # dirty_since,回合結束後由上面的 _last_sync_started 檢查決定要不要補
            # (turn-end 的 scan 起跑晚於這筆變動就直接清帳)。
            if _current_session.get("id"):
                continue
            sync_strategies()
            last_fire = now
            dirty_since = None     # 開火完清帳,等下一次變動
        except Exception as e:
            try:
                print(f"[web_bridge] strategy watcher iteration failed: {e}",
                      file=sys.stderr)
            except Exception:
                pass


def main():
    if not PROXY_TOKEN:
        print("[web_bridge] BLAVE_PROXY_TOKEN not set; exiting", file=sys.stderr)
        sys.exit(1)

    signal.signal(signal.SIGTERM, on_term)
    if os.name == "nt":
        # A Windows service stop NEVER delivers SIGTERM. NSSM's default stop
        # method sends a console Ctrl-C, escalating to Ctrl-Break — Python
        # surfaces those as SIGINT / SIGBREAK. Without these the mid-turn notice
        # below never fires on Windows and the browser spins on 「思考中」 through
        # every release swap (the exact symptom this handler exists to prevent).
        signal.signal(signal.SIGINT, on_term)
        sigbreak = getattr(signal, "SIGBREAK", None)
        if sigbreak is not None:
            signal.signal(sigbreak, on_term)
    # Commands (stop/start trading, membership, exchange keys) run on their own
    # thread: this loop below blocks for the whole of an agent turn, and a stop
    # that waits minutes for a turn to finish is not a stop. Daemon thread — it
    # must never keep the bridge alive on shutdown.
    def on_command_applied():
        # Both views, every command: delete_strategy changes the left rail, the
        # rest change the portfolio, and switching on cmd here would just be a
        # second copy of the handler table to keep in sync. Commands are rare
        # user actions, and attach_images' signature file already skips
        # re-uploading unchanged images.
        sync_portfolio()
        sync_strategies()

    threading.Thread(
        target=command_listener.run,
        # on_progress: portfolio only — the backtest watcher pushes it every
        # 10s, and the full push would rescan every stats.json each time
        kwargs={"on_applied": on_command_applied, "on_progress": sync_portfolio},
        daemon=True,
        name="command-listener",
    ).start()

    # 變化偵測 thread:回測一寫完就 sync,不等 2 分鐘 timer(治本)
    threading.Thread(
        target=_strategy_change_watcher,
        daemon=True,
        name="strategy-change-watcher",
    ).start()

    print("[web_bridge] starting poll loop", file=sys.stderr)
    tls_failures = 0
    while True:
        touch_heartbeat()
        try:
            messages = poll_once()
        except Exception as e:
            print(f"[web_bridge] poll error: {e}", file=sys.stderr)
            if "CERTIFICATE_VERIFY_FAILED" in str(e):
                tls_failures += 1
                if tls_failures >= TLS_FAIL_LIMIT:
                    print(f"[web_bridge] {tls_failures} consecutive TLS verify failures "
                          f"— exiting so a restart picks up a refreshed root store",
                          file=sys.stderr)
                    sys.exit(1)
            else:
                tls_failures = 0
            time.sleep(5)
            continue
        tls_failures = 0
        for m in messages:
            if m.get("type") != "user_message":
                ack_message(m.get("message_id"))  # discarding — release the lease
                continue
            session_id = m.get("session_id") or ""
            content = m.get("content") or ""
            attachment = m.get("attachment") if isinstance(m.get("attachment"), dict) else None
            if not session_id or (not content and attachment is None):
                ack_message(m.get("message_id"))  # discarding — release the lease
                continue
            # 開工即確認:從這裡開始的失敗由 mid-turn 機制(SIGTERM 補報)負責,
            # 租約只救「領走但還沒開工」的窗口。
            ack_message(m.get("message_id"))
            attachment_name = None
            if attachment is not None:
                saved = save_attachment(attachment)
                if saved:
                    attachment_name = saved
                    note = f"[用戶傳了檔案：tmp/inbound/{saved}，請先讀取檔案內容再回應]"
                else:
                    # 接收失敗也照常跑 turn——讓 agent 告知用戶重傳,不准靜默吞掉
                    note = "[用戶附了一個檔案但接收失敗，請告知用戶重傳]"
                content = f"{content}\n{note}" if content else note
            ctx = m.get("context") if isinstance(m.get("context"), dict) else {}
            viewing_strategy = ctx.get("viewing_strategy")
            viewing_tab = ctx.get("viewing_tab")
            run_agent_turn(session_id, content, viewing_strategy=viewing_strategy,
                           viewing_tab=viewing_tab, attachment_name=attachment_name,
                           viewing_view=ctx.get("viewing_view"),
                           viewing_widgets=ctx.get("viewing_widgets"))
            # A turn may have created/deployed/removed a strategy, or changed
            # the portfolio — refresh both caches now instead of leaving the
            # user on the 2-minute timers.
            # 投資組合排前面:瀏覽器是在 done 之後固定 3 秒回抓它的快取,而策略
            # 清單的回抓綁在下面那個 chunk 送達之後——只有投資組合這條會輸掉競速,
            # 慢的那條(圖片 base64 + 數 MB 上傳)因此排後面。
            # 兩個 sync 中間各補一次心跳:這裡 turn_in_flight() 已經是 False,
            # 唯一的保護就是心跳還沒過期,窗口因此縮成「最長的單一 sync」而不是
            # 兩個的總和。不改成背景 thread 定時 touch——那會讓心跳退化成「進程
            # 還在」而不是「這個迴圈還在跑」,watchdog 對 web_bridge 唯一的真陽性
            # (閒置時 poll 迴圈 wedge)就沒了。單一 POST 真的卡死仍照常過期重啟。
            touch_heartbeat()
            sync_portfolio()
            touch_heartbeat()
            sync_strategies()


if __name__ == "__main__":
    main()
