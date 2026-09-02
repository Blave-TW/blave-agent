"""File-event watcher — the Windows stand-in for the Linux systemd path units.

Linux gets its event chain from PathModified units (.env / lib/ → re-read
accounts; last_reconcile.json → re-read + push; account.json → push). Windows
Task Scheduler has no file trigger, so this always-on service (NSSM,
blave-agent-watcher) polls mtimes every couple of seconds and runs the same
two programs the Linux units would. Harmless on Linux too, but only registered
on Windows — the path units already cover it there (except the Capital watch,
which is Windows-only by nature; see WATCHES).

Runs from current/ like the bridges, so it updates with every release. The
jobs it spawns are the SAME oneshots the timers run — this only shortens the
latency between "something changed" and "the next run", it adds no new code
paths. A crash is safe (NSSM restarts it; the 2-minute timers keep working
underneath), so failures here degrade to the timer cadence, never to silence.
"""
import os
import subprocess
import sys
import time

IS_WINDOWS = os.name == "nt"
BASE = os.environ.get("BLAVE_AGENT_BASE") or (
    r"C:\blave-agent" if IS_WINDOWS else "/opt/blave-agent"
)
WORKSPACE = os.environ.get("BLAVE_AGENT_WORKSPACE", os.path.join(BASE, "workspace"))
CURRENT = os.path.join(BASE, "current")
VENV_PY = os.environ.get(
    "BLAVE_AGENT_PYTHON",
    os.path.join(BASE, "venv", "Scripts", "python.exe") if IS_WINDOWS
    else os.path.join(BASE, "venv", "bin", "python3"),
)
# account modules need the SYSTEM interpreter (agent-installed deps) — the same
# split the Linux unit (/usr/bin/python3) and provision.ps1's task list make.
SYS_PY = "python" if IS_WINDOWS else "/usr/bin/python3"

POLL_S = 2
# 觸發後的最小間隔:一輪對帳可能連寫兩次(下單前快照+收斂輪),不用每次都跟
DEBOUNCE_S = 5

ACCOUNT = (SYS_PY, os.path.join(CURRENT, "account_reader.py"))
REPORT = (VENV_PY, os.path.join(CURRENT, "portfolio_reporter.py"))
UPLOAD = (VENV_PY, os.path.join(CURRENT, "report_uploader.py"))

# path → jobs to run when its mtime moves (the three Linux path units +
# one Windows-only Capital watch).
# .env runs BOTH: on Linux the chain is .env→account→(account.json path)→report,
# but the baseline refresh below hides our own account.json write — so the
# report must ride in the same trigger, not wait for a second hop.
WATCHES = {
    os.path.join(WORKSPACE, ".env"): (ACCOUNT, REPORT),
    os.path.join(WORKSPACE, "manager", "last_reconcile.json"): (ACCOUNT, REPORT),
    os.path.join(WORKSPACE, "manager", "account.json"): (REPORT,),
    # lib/ 目錄 mtime:agent 寫出新的 lib/account_{venue}.py 的當下重讀——
    # venue 可讀性=金鑰(.env)+模組(lib/)兩件事,只看 .env 會漏後者
    # (實測串 Binance 時模組比金鑰晚 72 秒,卡到下一輪 2 分鐘 timer)。
    # 目錄 mtime 只動在檔案增刪,既有檔改內容不觸發——夠用,「新 venue 接上」
    # 就是新增檔案那一刻。
    os.path.join(WORKSPACE, "lib"): (ACCOUNT, REPORT),
    # 群益(Capital)帳戶快照:capital_worker(第三方常駐,COM)寫,
    # order_capital 成交後 touch state/capital_refresh 讓 worker 10 秒內提前
    # 重寫——這裡接著跑 account_reader+reporter,成交到平台秒級、到頁面
    # ~30 秒內(剩頁面 30s 輪詢;原本要 ~3.5 分)。
    # 副作用(刻意接受,非漏 debounce):worker 每 60s 例行重寫也會動 mtime,
    # 群益機的回報節奏因此從 2min timer 變 ~60s 事件觸發;reporter 很輕
    # (本地讀+一個 POST)。第三方寫的檔,不進 SELF_WRITTEN。Linux 不加對應
    # path unit:群益 API 走 Windows COM,Linux 機不會有這個檔。
    os.path.join(WORKSPACE, "state", "capital_account.json"): (ACCOUNT, REPORT),
    # 報告 drop dir(契約見 report_uploader.py):任何腳本——含用戶自己的 agent——
    # 把 <id>.json 寫進去,runtime 撿走上傳。Linux 端的對應是
    # blave-agent-reports.path,這裡是 Windows 的替身,同 lib/ 那條:目錄 mtime
    # 只動在檔案增刪,而「有新報告」正好就是新增檔案那一刻。
    # 刻意不進 SELF_WRITTEN:上傳成功後檔案被搬走會再動一次目錄 mtime、多跑一輪
    # 空的 uploader(很便宜),但把基準吃掉就會吞掉上傳期間才落地的下一份報告
    # ——那正是稽核 B5 的形狀。
    # 這裡不必補「太新就重跑一次」:2 秒輪詢撞上 uploader 的 QUIET_S 靜默期跟
    # Linux path unit 是同一個形狀,而那段等待做在 uploader 自己的 main() 裡
    # (跑的是同一支程式),Windows 這條跟著一起好。
    os.path.join(WORKSPACE, "reports"): (UPLOAD,),
    # 看盤板(watchboard.md §4)的兩個 drop dir,同一支 uploader 掃;Linux 端是
    # blave-agent-reports.path 多看的兩個目錄。data/ 是覆蓋語意——原子 os.replace
    # 也會動目錄 mtime,所以照契約寫的產出端一樣秒級觸發。
    os.path.join(WORKSPACE, "watch", "ops"): (UPLOAD,),
    os.path.join(WORKSPACE, "watch", "data"): (UPLOAD,),
}


def _mtime(path):
    try:
        return os.path.getmtime(path)
    except OSError:
        return None


def _run(cmd):
    # a failing job must be VISIBLE in the service log — DEVNULL here would be
    # another "fails silently for months" hole (audited)
    try:
        r = subprocess.run(list(cmd), timeout=180, cwd=CURRENT,
                           capture_output=True, text=True)
        if r.returncode != 0:
            print(f"[watcher] {os.path.basename(cmd[-1])} rc={r.returncode}: "
                  f"{(r.stderr or '').strip()[-300:]}", file=sys.stderr)
    except Exception as e:
        print(f"[watcher] {os.path.basename(cmd[-1])} failed: {type(e).__name__}",
              file=sys.stderr)


HEARTBEAT = os.path.join(BASE, "state", "watcher_heartbeat")
# 這輪 jobs 自己會重寫的檔——只有它的基準在 jobs 跑完後刷新;其他 watch 檔
# 在 jobs 執行期間的第三方寫入(例如 reconciler 的 force_next 收斂輪快照)
# 必須留著下一輪觸發,不能被整批基準刷新吞掉(稽核 B5:被吞的正是
# 「成交後真實部位」那份快照)。
SELF_WRITTEN = {os.path.join(WORKSPACE, "manager", "account.json")}


def main():
    seen = {p: _mtime(p) for p in WATCHES}
    pending = set()  # debounce=延後到下一輪,不是丟棄
    last_fire = {}
    while True:
        time.sleep(POLL_S)
        try:
            os.makedirs(os.path.dirname(HEARTBEAT), exist_ok=True)
            with open(HEARTBEAT, "w") as f:
                f.write(str(int(time.time())))
        except OSError:
            pass
        for path, jobs in WATCHES.items():
            m = _mtime(path)
            moved = m != seen[path]
            if not moved and path not in pending:
                continue
            now = time.time()
            if now - last_fire.get(path, 0) < DEBOUNCE_S:
                pending.add(path)   # 記帳,冷卻結束再跑
                seen[path] = m
                continue
            pending.discard(path)
            seen[path] = m
            last_fire[path] = now
            for cmd in jobs:
                _run(cmd)
            # 只刷新「自己寫的檔」的基準——防自我re-trigger;其餘檔案若在
            # jobs 執行期間被第三方改動,下一輪照常觸發
            for p2 in SELF_WRITTEN:
                if p2 in seen:
                    seen[p2] = _mtime(p2)


if __name__ == "__main__":
    main()
