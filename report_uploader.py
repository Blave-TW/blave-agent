"""Report uploader: the machine's ONLY path from a report JSON to the platform
(PUT /openclaw/agent/report/<id>), and the owner of the drop-dir contract.

Drop-dir contract — anything on this machine (this runtime's own generators, a
manager/ script, or a report the user's own agent wrote by hand) publishes a
report by landing a file in `workspace/reports/<id>.json`:

  * `<id>` = the file's stem, and it is the report id: `[A-Za-z0-9_-]{1,64}`.
    Re-using an id overwrites the stored report, so a re-run of a deterministic
    generator is idempotent for free.
  * WRITE IT ATOMICALLY — write `<id>.json.tmp` (any name not ending in
    `.json` is ignored by the scan) and `os.replace()` it into place, the same
    convention account_reader/command_listener use for every file another
    process watches. Belt and braces for producers that don't: a file whose
    mtime is younger than QUIET_S is left for the next tick, so a torn write
    is never parsed, and drop() below is the sanctioned way to do it right.
  * The envelope `id` is filled in from the file name when absent; when it is
    present and DIFFERENT the report is refused rather than guessed at — the
    same stance the api takes on its own id/URL mismatch.
  * Uploaded → moved to `reports/sent/` (newest few kept, the rest deleted).
    Refused for good → `reports/failed/` plus a line in `upload_errors.log`.
    Neither directory is ever re-scanned, so nothing uploads twice.

Figures ride along in a sidecar directory, `workspace/reports/<id>.files/`:
an `image` block carries `{"file": "equity.png"}` — a plain file name in that
directory — and THIS process uploads the bytes and rewrites the field into the
`sha256` the api contract wants (`.claude/docs/report-blocks.md` §2.5). Write
the images first, the report JSON last, and both are complete before anything
is picked up. The sidecar moves with its report into `sent/` / `failed/`.

Why the uploader carries the bytes rather than the producer:
`command_listener._strategy_subprocess_env()` strips every `BLAVE_*` from a
strategy subprocess, so a scheduled script has no machine token and cannot PUT
to /openclaw/agent/strategy_image at all — which is exactly the long-tail
research figure the block exists for. This process has the token; the producer
still needs nothing but files.

Why the drop dir is a directory and not a function call: it is what lets a
custom report ship without waiting for blaveclaw-config's manual update
channel (`.claude/docs/blave-agent-update-channels.md`) — the producer needs no
library, no token and no knowledge of the api, just a file.

No Telegram here. The summary push happens platform-side after the report is
stored (`api/openclaw/agent_reports._notify_stored`), which reaches the user
even when this machine is off; sending from here too would double every alert.

The watchboard (`.claude/docs/watchboard.md` §4) rides the same process with
the same file discipline under `workspace/watch/`: `ops/<epoch_ms>-<op>.json`
is POSTed in file-name order (200 → `ops/sent/`, 4xx → `ops/failed/`, else
backoff), and `data/<widget_id>.json` is PUT with overwrite semantics — the
file STAYS in place (the scheduled script rewrites it, and report_runner judges
a watch job by that file's mtime), this process remembers the mtime+size it
last shipped and only re-sends when they move. `data/<widget_id>.files/` is
the image sidecar, same rules as a report's. Errors go to
`watch/upload_errors.log`.

VM auth = proxy-{ttyd_password} (BLAVE_PROXY_TOKEN), same trust model as
strategy_reporter / portfolio_reporter: the token resolves to this user only.
"""
import json
import os
import re
import shutil
import sys
import time
import urllib.error
import urllib.request

# 圖片走既有的 strategy_image 通道：副檔名白名單、大小上限、PUT 與 507 語意都在
# 那裡實作過一次，這裡不重寫第二份(會漂開的那種)。
import strategy_reporter

WORKSPACE = os.environ.get("BLAVE_AGENT_WORKSPACE", "/opt/blave-agent/workspace")
REPORTS_DIR = os.path.join(WORKSPACE, "reports")
SENT_DIR = os.path.join(REPORTS_DIR, "sent")
FAILED_DIR = os.path.join(REPORTS_DIR, "failed")
# 機器端 agent 讀得懂的錯誤日誌：契約錯誤與 api 的 400 都寫這裡（api 的訊息本來就
# 帶 blocks[3].items[1].value 這種路徑），不是丟進 systemd journal 讓人 SSH 去撈。
ERROR_LOG = os.path.join(REPORTS_DIR, "upload_errors.log")
STATE_DIR = os.environ.get("BLAVE_AGENT_STATE", "/opt/blave-agent/state")
_STATE_PATH = os.path.join(STATE_DIR, "report_uploads.json")
API_URL = os.environ.get("BLAVE_REPORT_URL", "https://api.blave.org/openclaw/agent/report")
PROXY_TOKEN = os.environ.get("BLAVE_PROXY_TOKEN", "")

# 看盤板(.claude/docs/watchboard.md §4):ops 依檔名時序 POST,data 覆蓋語意 PUT
WATCH_DIR = os.path.join(WORKSPACE, "watch")
WATCH_OPS_DIR = os.path.join(WATCH_DIR, "ops")
WATCH_OPS_SENT_DIR = os.path.join(WATCH_OPS_DIR, "sent")
WATCH_OPS_FAILED_DIR = os.path.join(WATCH_OPS_DIR, "failed")
WATCH_DATA_DIR = os.path.join(WATCH_DIR, "data")
WATCH_DATA_FAILED_DIR = os.path.join(WATCH_DATA_DIR, "failed")
WATCH_ERROR_LOG = os.path.join(WATCH_DIR, "upload_errors.log")
WATCH_API_URL = os.environ.get("BLAVE_WATCH_URL", "https://api.blave.org/openclaw/agent/watch")
_WATCH_STATE_PATH = os.path.join(STATE_DIR, "watch_uploads.json")
WATCH_DATA_MAX_BYTES = 64 * 1024  # mirrored from openclaw/agent_watch.DATA_MAX_BYTES
_WIDGET_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,32}")

_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")
_FNREF_RE = re.compile(r"\[\^([A-Za-z0-9_-]{1,32})\]")
# image block 的 `file`:sidecar 目錄裡的**檔名**，不是路徑。擋掉 `../`、絕對路徑與
# 隱藏檔——產出端是用戶自己的 agent，但一個手滑的字串不該讓這個 process 去讀
# sidecar 以外的檔案，再用機器 token 把它 PUT 上去。
_FILE_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}")
# `<id>.files/`;id 的字元集不含 `.`,所以這個字尾永遠不會撞到某份報告的檔名。
FILES_SUFFIX = ".files"
REPORT_MAX_BYTES = 2 * 1024 * 1024  # mirrored from openclaw/agent_reports.REPORT_MAX_BYTES
_MAX_BLOCKS = 120
_ENVELOPE = ("schema_version", "id", "type", "title", "created_at", "blocks")

# 半寫檔防線：mtime 比這個新的檔留到下一輪。原子換檔才是主要保證，這只是給沒照
# 契約寫的產出端的網子。
QUIET_S = 2
# 這支程式唯一的 sleep，上限 = 一份剛落地的檔最多就差 QUIET_S 秒，多的 1 秒是給
# mtime 粒度與時鐘校正的餘裕(也順便封住 mtime 在未來的檔)。理由見 main()。
QUIET_WAIT_MAX_S = QUIET_S + 1
UPLOAD_TIMEOUT = 20
# systemd TimeoutStartSec=120：預算 + 一個在途請求要留在裡面。超過就把剩下的檔
# 留給下一輪——drop dir 本身就是佇列，沒有東西會因此遺失。（實測前例：
# strategy_reporter 的圖片上傳 5 張 x 15s = 150s 被 systemd 砍掉，報告整份沒送出。）
TICK_BUDGET_S = 75
SENT_KEEP = 20
# 沒有對應報告的 sidecar 目錄(產出端寫完圖就掛掉，或搬走報告時目錄搬不動)撐過這段
# 時間才清。契約是圖先落、報告後落，剛出現的孤兒可能只是那份報告還沒寫完。
_ORPHAN_FILES_MAX_AGE_S = 86400
_BACKOFF_BASE_S = 60
_BACKOFF_MAX_S = 3600
_ERROR_LOG_MAX_BYTES = 64 * 1024
_ERROR_LOG_KEEP_LINES = 200

# 文件本身就是錯的，重送同樣的 bytes 永遠不會變對：400=違反契約、413=超過 2MB。
# 其他一律當暫時性（含 401/403/404/5xx/連線失敗）並無限重試——404 正是「runtime
# 先發版、api 還沒部署」的那一刻，把它當永久失敗會讓整批報告在部署完成前就被
# 判死；一天的 api 中斷同理不該讓報告消失。累積量由產出速率自然設限。
_PERMANENT_STATUS = (400, 413)


# 401 / 403 在機器剛起來的 30 秒內是 proxy 的 negative cache,不是這個檔的錯:退避重送,
# 但有上限——token 真的失效時不能無限重試
_WATCH_AUTH_STATUS = (401, 403)
_WATCH_AUTH_MAX_ATTEMPTS = 10


def _watch_permanent(code):
    """看盤板通道的永久失敗(契約 §4.1:200 / 4xx 各自搬 sent/ failed/;§4.2 的 404 =
    widget 不在了)。408 / 429 是「再送就會好」的 4xx,401 / 403 見上,照暫時性退避。
    跟報告那條的 (400, 413) 刻意不同:報告的 404 是 api 還沒部署,看盤板的出貨順序是
    api 先上。"""
    return 400 <= code < 500 and code not in (408, 429) + _WATCH_AUTH_STATUS

# json 的 loads/dumps 在夠深的巢狀上丟的是 RecursionError,而它是 RuntimeError 的
# 子類、**不是** ValueError。只接 ValueError 的話這個例外會一路穿透 upload_one →
# run_once,main() 當場死掉而且 _save_state 沒跑;pending() 又是 mtime 最舊優先，
# 毒檔永遠排第一 → 之後每一輪 path/timer 觸發都在同一個檔上死掉，那台機器的所有
# 報告永久送不出去,直到有人 SSH 進去手刪。深巢是「重送同樣的 bytes 永遠不會變對」
# 的那一類，所以判永久失敗進 failed/。
_JSON_ERRORS = (ValueError, RecursionError)
# 讀檔前的大小預檢。上限是序列化後的 body,磁碟上那份可能帶縮排、或用
# ensure_ascii=True 把每個中文字寫成 6 bytes(utf-8 是 3),所以留 4 倍餘裕;超過就
# 不可能序列化到 2MB 以內，而為了確認這件事把幾 GB 讀進記憶體會 OOM 掉整台機器。
_READ_MAX_BYTES = 4 * REPORT_MAX_BYTES


def _read_json(path, default=None):
    # utf-8 明寫：報告標題與策略名帶中文，cp950 的 Windows 機用 locale 預設會炸
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError,) + _JSON_ERRORS:
        return default


def _write_json(path, obj):
    """原子寫：同一份檔可能正被別的 process 讀。"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, allow_nan=False)
    os.replace(tmp, path)


def drop(doc):
    """把一份報告放進 drop dir(產出端該用的入口)，回傳落地路徑。

    寫 .tmp 再 os.replace——上面契約要求的原子性由這裡實作一次，產出端不必各自
    重寫一遍。id 取自 doc，所以同一份報告重跑會覆蓋自己而不是堆出兩份。"""
    report_id = doc["id"]
    if not _ID_RE.fullmatch(report_id):
        raise ValueError(f"report id {report_id!r} must match [A-Za-z0-9_-]{{1,64}}")
    path = os.path.join(REPORTS_DIR, report_id + ".json")
    _write_json(path, doc)
    return path


def files_dir(report_id):
    """這份報告的圖片 sidecar 目錄。產出端把圖寫進這裡、**寫完才落報告 JSON**。"""
    return os.path.join(REPORTS_DIR, report_id + FILES_SUFFIX)


def log_error(report_id, message, log_path=ERROR_LOG):
    """機器端 agent 讀的錯誤日誌（append，尾端有界）。"""
    line = f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} {report_id}: {message}\n"
    try:
        os.makedirs(os.path.dirname(log_path), exist_ok=True)
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(line)
        if os.path.getsize(log_path) > _ERROR_LOG_MAX_BYTES:
            with open(log_path, encoding="utf-8", errors="replace") as f:
                tail = f.readlines()[-_ERROR_LOG_KEEP_LINES:]
            tmp = log_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                f.writelines(tail)
            os.replace(tmp, log_path)
    except OSError as e:
        print(f"[report_uploader] error log write failed: {e}", file=sys.stderr)


def check_report(doc, report_id):
    """本地契約預檢。回傳錯誤字串，或 None 代表可以送。

    刻意**比 api 寬**。唯一的驗證實作是 api 的 validate_report()
    (`.claude/docs/report-blocks.md` §5)，它跟這支程式在不同的發版節奏上：本地
    檢查比 api 嚴的那一刻，一份 api 會收的合法報告就被這台機器永久擋住，而且沒有
    任何人看得到。所以這裡只驗「不會隨 schema_version 放寬」的東西——信封形狀、
    id 與檔名的對應、block 陣列界限、以及契約 §5 那幾條結構規則。欄位層的規則
    (值域、未知欄位、各 block 的必填)留給 api：它的 400 訊息本來就帶路徑，
    照樣會進同一份 upload_errors.log。

    列舉型欄位（type / schema_version / block type 的合法值）刻意不驗：那些正是
    升版會擴充的集合，舊 runtime 拿舊清單去擋新報告就是上面說的那個失敗。"""
    if not isinstance(doc, dict):
        return "report: must be an object"
    missing = [k for k in _ENVELOPE if k not in doc]
    if missing:
        return "report: missing field(s): " + ", ".join(missing)
    if not isinstance(doc["id"], str) or not _ID_RE.fullmatch(doc["id"]):
        return "report.id: must match [A-Za-z0-9_-]{1,64}"
    if doc["id"] != report_id:
        return f"report.id: does not match the file name ({report_id})"
    if not isinstance(doc["title"], str) or not 1 <= len(doc["title"]) <= 200:
        return "report.title: must be a 1–200 character string"
    if isinstance(doc["created_at"], bool) or not isinstance(doc["created_at"], int):
        return "report.created_at: must be an int (unix seconds, UTC)"
    blocks = doc["blocks"]
    if not isinstance(blocks, list) or not 1 <= len(blocks) <= _MAX_BLOCKS:
        return f"report.blocks: must hold 1–{_MAX_BLOCKS} blocks"
    types = []
    for i, b in enumerate(blocks):
        if not isinstance(b, dict):
            return f"blocks[{i}]: must be an object"
        if not isinstance(b.get("type"), str) or not b["type"]:
            return f"blocks[{i}].type: must be a non-empty string"
        types.append(b["type"])
    if types.count("meta") != 1 or types[0] != "meta":
        return "blocks: must open with exactly one meta block"
    if types.count("footnote") > 1:
        return "blocks: holds at most one footnote block"
    if "footnote" in types and types[-1] != "footnote":
        return "blocks: the footnote block must be last"
    leads = [i for i, b in enumerate(blocks)
             if b["type"] == "text" and b.get("variant") == "lead"]
    if len(leads) > 1:
        return "blocks: holds at most one text block with variant=lead"
    if leads and leads[0] != 1:
        return f"blocks[{leads[0]}]: the lead text must follow the meta block"
    footnote_ids = set()
    for b in blocks:
        if b["type"] == "footnote":
            for it in b.get("items") or []:
                if isinstance(it, dict) and isinstance(it.get("id"), str):
                    footnote_ids.add(it["id"])
    for i, b in enumerate(blocks):
        if b["type"] != "text" or not isinstance(b.get("markdown"), str):
            continue
        for ref in _FNREF_RE.findall(b["markdown"]):
            if ref not in footnote_ids:
                return (f"blocks[{i}].markdown: footnote reference [^{ref}] has no "
                        f"matching footnote item")
    return _check_image_files(blocks)


def _check_image_files(blocks, path="blocks"):
    """image.file 是 drop-dir 契約自己的欄位,api 沒有它(收到就是未知 prop → 400),
    所以驗它不違反 check_report「不比 api 嚴」那條——這一段是本地唯一的驗證實作。只在
    `file` 出現時才說話:image block 少了 sha256 又沒有 file 留給 api 去判,
    免得將來多一種合法的圖片參照被舊 runtime 擋死。看盤板的單一 block 也走這裡。"""
    for i, b in enumerate(blocks):
        if not isinstance(b, dict) or b.get("type") != "image" or "file" not in b:
            continue
        p = f"{path}[{i}]" if path == "blocks" else path
        if not isinstance(b["file"], str) or not _FILE_RE.fullmatch(b["file"]):
            return (f"{p}.file: must be a plain file name in <id>{FILES_SUFFIX}/ "
                    f"([A-Za-z0-9][A-Za-z0-9._-]{{0,79}}), not a path")
        if "sha256" in b:
            return (f"{p}: carries both file and sha256 — use file for a picture "
                    f"in <id>{FILES_SUFFIX}/, sha256 for one already uploaded")
    return None


def _serialize(doc):
    """(bytes, None) 或 (None, 錯誤字串)。allow_nan=False 就是契約的「數字必須有限」
    ——NaN/Infinity 送出去 api 一定 400，在這裡擋掉省一趟。"""
    try:
        body = json.dumps(doc, ensure_ascii=False, allow_nan=False).encode("utf-8")
    except _JSON_ERRORS as e:
        return None, f"report: not valid JSON ({e})"
    if len(body) > REPORT_MAX_BYTES:
        return None, (f"report: {len(body)} bytes exceeds the "
                      f"{REPORT_MAX_BYTES} byte ceiling")
    return body, None


def _resolve_images(doc, report_id, started, token, sidecar=None, log_path=ERROR_LOG):
    """把 image block 的 `file` 參照換成 `sha256`——圖檔本體 PUT 進既有的
    strategy_image 通道。回傳 (`ok` / `permanent` / `retry`, 訊息)。

    失敗語意刻意分三類,判準是「誰做錯了、重試會不會好轉」:

      * **產出端寫錯**(檔案不在 sidecar 裡、副檔名不在白名單、0 或超過 2MB)
        → `permanent`,整份進 failed/。同一份契約裡對不到的 `[^id]` 尾註引用就是
        這樣處理的:報告是文件，引用一張不存在的圖跟引用一條不存在的註一樣，
        是寫壞了，該讓產它的 agent 當場知道，而不是默默出一份缺圖的報告。
      * **暫時性**(檔案在但這輪讀不到、上傳連線失敗、tick 預算用完)
        → `retry`,整份留在 drop dir 退避重來。不降級:圖下一輪就會上去，
        為了早幾分鐘送達而永久拿掉一張圖不划算。
      * **507 圖片配額滿** → 拿掉那個 block、記進 upload_errors.log、照送。
        這是唯一「重試不會好轉、又不是產出端的錯」的情形(語意見
        strategy_reporter.put_image),不降級就等於這份報告永遠送不出去。
        用戶不會只看到一個洞:507 會寫進 IMG_QUOTA_PATH，由 agent 在對話裡講。
        (**跟報告本身的 507 不同**——那個是「該淘汰的舊報告刪不掉」，會自己好轉，
        所以照舊當暫時性退避。兩條通道的同一個狀態碼語意本來就不同。)

    每一輪重試都把整份的圖重傳，刻意不記「這些 hash 已經傳過了」:平台的孤兒清掃
    (agent_strategy_images.sweep_orphans)保護的是**已存下的報告**引用到的 hash,
    圖傳完到報告 PUT 成功之間，那些圖沒有任何人引用，只靠清掃自己的 24 小時寬限
    活著。重傳讓寬限期跟著每一輪重新計時;記住已傳過則會讓一份卡了一天的報告在
    送達時圖已經被掃掉。內容定址，重傳同樣的 bytes 只是覆寫同一個 key。"""
    blocks = doc.get("blocks") or []
    targets = [(i, b) for i, b in enumerate(blocks)
               if isinstance(b, dict) and b.get("type") == "image"
               and isinstance(b.get("file"), str)]
    if not targets:
        return "ok", None  # 一張圖都沒試 = 對配額狀態不表態，marker 原封不動
    d = sidecar or files_dir(report_id)
    resolved, dropped = {}, {}
    refused = uploaded = False
    # 這一輪有沒有走完整份清單。任何中途 return 都算沒走完——不管是預算用完、
    # 讀不到還是產出端寫錯:沒被試到的那幾張可能正是會被拒的那張,所以「有一張傳
    # 成功了」就不足以當成「配額鬆開了」的證據。同 record_image_quota 的原始紀律。
    complete = False
    try:
        for i, b in targets:
            name = b["file"]
            if name in resolved or name in dropped:
                continue  # 同一張圖被兩個 block 引用：只傳一次
            mime = strategy_reporter.IMG_EXTS.get(os.path.splitext(name)[1].lower())
            if not mime:
                return "permanent", (
                    f"blocks[{i}].file: {name} is not one of "
                    f"{', '.join(sorted(strategy_reporter.IMG_EXTS))}")
            try:
                with open(os.path.join(d, name), "rb") as f:
                    data = f.read()
            except FileNotFoundError:
                return "permanent", (
                    f"blocks[{i}].file: there is no {name} in {report_id}{FILES_SUFFIX}/")
            except OSError as e:
                # 讀不到 != 不存在。同 upload_one 對報告本身的處置:Windows 上防毒
                # 或另一個寫入端的鎖可能撐得比 QUIET_S 久，判永久就是把一份好報告
                # 搬進 failed/ 永遠不再送。
                return "retry", f"{name} not readable this tick: {e}"
            if not data or len(data) > strategy_reporter.IMG_MAX_BYTES:
                return "permanent", (
                    f"blocks[{i}].file: {name} is {len(data)} bytes "
                    f"(1–{strategy_reporter.IMG_MAX_BYTES} allowed)")
            if time.time() - started > TICK_BUDGET_S:
                # 圖片 PUT 是循序的:api 掛住(而不是回答)時每張要付滿 timeout,
                # 六張就頂到 blave-agent-reports.service 的 TimeoutStartSec=120。
                return "retry", "tick budget spent before every image was uploaded"
            h, over_quota = strategy_reporter.put_image(data, mime, token)
            uploaded = uploaded or bool(h)
            refused = refused or over_quota
            if h:
                resolved[name] = h
            elif over_quota:
                dropped[name] = "the image storage quota is full (HTTP 507)"
            else:
                return "retry", f"image upload failed ({name})"
        complete = True
    finally:
        strategy_reporter.record_image_quota(refused, uploaded, complete=complete)

    for _i, b in targets:
        name = b["file"]
        if name in resolved:
            del b["file"]  # api 那邊是未知 prop → 400；換成它認得的 sha256
            b["sha256"] = resolved[name]
    if dropped:
        doc["blocks"] = [b for b in blocks
                         if not (b.get("type") == "image" and b.get("file") in dropped)]
        for name, why in sorted(dropped.items()):
            log_error(report_id, f"image {name} left out of the report: {why}", log_path)
    return "ok", None


def _request(url, body, method, token):
    req = urllib.request.Request(
        url, data=body, method=method,
        headers={"Content-Type": "application/json", "x-api-key": f"proxy-{token}"},
    )
    with urllib.request.urlopen(req, timeout=UPLOAD_TIMEOUT) as resp:
        return resp.read().decode()


def _put(body, report_id, token):
    return _request(f"{API_URL}/{report_id}", body, "PUT", token)


def _api_error(e, permanent=None):
    """HTTPError → (訊息， 是否永久)。api 的 JSON error 欄位就是要給 agent 讀的。
    `permanent`:狀態碼 → bool;預設是報告通道的 (400, 413)。"""
    try:
        detail = json.loads(e.read() or b"{}").get("error") or ""
    except Exception:  # noqa: BLE001 — 讀不出 body 不能蓋掉真正的狀態碼
        detail = ""
    is_permanent = permanent(e.code) if permanent else e.code in _PERMANENT_STATUS
    return (f"HTTP {e.code} {detail}".strip(), is_permanent)


def _load_state(path=_STATE_PATH):
    state = _read_json(path, {})
    return state if isinstance(state, dict) else {}


def _save_state(state, path=_STATE_PATH):
    try:
        _write_json(path, state)
    except OSError as e:
        # 退避狀態掉了最多就是下一輪立刻重試，不值得讓整輪失敗
        print(f"[report_uploader] state write failed: {e}", file=sys.stderr)


def pending():
    """[(report_id, path)]，最舊的先送。"""
    try:
        names = sorted(os.listdir(REPORTS_DIR))
    except OSError:
        return []
    out = []
    for name in names:
        if not name.endswith(".json"):
            continue  # .tmp / sent/ / failed/ / upload_errors.log
        path = os.path.join(REPORTS_DIR, name)
        if not os.path.isfile(path):
            continue
        out.append((name[:-5], path))
    out.sort(key=lambda it: os.path.getmtime(it[1]) if os.path.exists(it[1]) else 0)
    return out


def _retire(path, target_dir):
    """報告連同它的圖片 sidecar 一起搬走——drop dir 不留孤兒目錄。"""
    os.makedirs(target_dir, exist_ok=True)
    os.replace(path, os.path.join(target_dir, os.path.basename(path)))
    src = os.path.splitext(path)[0] + FILES_SUFFIX
    if not os.path.isdir(src):
        return
    dst = os.path.join(target_dir, os.path.basename(src))
    shutil.rmtree(dst, ignore_errors=True)  # os.replace 換不掉非空目錄
    try:
        os.replace(src, dst)
    except OSError as e:
        # 報告已經搬走了，這個目錄現在是孤兒——_sweep_orphan_files 一天後收掉它
        print(f"[report_uploader] {os.path.basename(src)} not retired: {e}",
              file=sys.stderr)


def _prune_sent(sent_dir=SENT_DIR):
    """sent/ 只留最近幾份給機器端 agent 回頭看；本體在平台上，這裡不是歸檔。"""
    try:
        files = [os.path.join(sent_dir, n) for n in os.listdir(sent_dir)]
    except OSError:
        return
    files = [p for p in files if os.path.isfile(p)]
    if len(files) <= SENT_KEEP:
        return
    files.sort(key=os.path.getmtime, reverse=True)
    for path in files[SENT_KEEP:]:
        try:
            os.remove(path)
        except OSError:
            pass
        shutil.rmtree(os.path.splitext(path)[0] + FILES_SUFFIX, ignore_errors=True)


def _sweep_orphan_files():
    """清掉沒有報告 / data 檔的 sidecar 目錄。兩個來源:產出端寫完圖就掛掉、以及 _retire
    搬走報告後目錄自己搬不動。給滿一天寬限——契約是圖先落、報告後落,剛出現的孤兒
    可能只是那份報告還在寫。"""
    cutoff = time.time() - _ORPHAN_FILES_MAX_AGE_S
    for base in (REPORTS_DIR, WATCH_DATA_DIR):
        try:
            names = os.listdir(base)
        except OSError:
            continue
        for name in names:
            if not name.endswith(FILES_SUFFIX):
                continue
            d = os.path.join(base, name)
            if not os.path.isdir(d) or os.path.exists(d[:-len(FILES_SUFFIX)] + ".json"):
                continue
            try:
                if os.path.getmtime(d) > cutoff:
                    continue
            except OSError:
                continue
            shutil.rmtree(d, ignore_errors=True)


def _fail_permanently(report_id, path, message, state, failed_dir=FAILED_DIR,
                      log_path=ERROR_LOG):
    log_error(report_id, message, log_path)
    print(f"[report_uploader] {report_id} refused: {message}", file=sys.stderr)
    try:
        _retire(path, failed_dir)
    except OSError as e:
        print(f"[report_uploader] {report_id} could not be moved to failed/: {e}",
              file=sys.stderr)
    state.pop(report_id, None)


def _defer(report_id, message, state):
    """暫時性失敗：指數退避，上限一小時，不設放棄次數。"""
    entry = state.get(report_id) if isinstance(state.get(report_id), dict) else {}
    attempts = int(entry.get("attempts") or 0) + 1
    delay = min(_BACKOFF_BASE_S * (2 ** (attempts - 1)), _BACKOFF_MAX_S)
    state[report_id] = {"attempts": attempts, "next_at": int(time.time()) + delay,
                        "error": message}
    print(f"[report_uploader] {report_id} deferred {delay}s (attempt {attempts}): "
          f"{message}", file=sys.stderr)


def _newest_mtime(report_id, path, sidecar=None):
    """報告與它 sidecar 裡每張圖之中最新的 mtime。

    契約要求圖先落、報告最後才 os.replace,所以報告靜置了圖通常也靜置了;這條是
    給沒照順序寫的產出端的網子，同 QUIET_S 對報告本身的角色。"""
    newest = os.path.getmtime(path)
    d = sidecar or files_dir(report_id)
    try:
        for name in os.listdir(d):
            p = os.path.join(d, name)
            if os.path.isfile(p):
                newest = max(newest, os.path.getmtime(p))
    except OSError:
        pass
    return newest


def _quiet_left(report_id, path, now, sidecar=None):
    """離靜默期滿還有幾秒(<= 0 = 這一輪可以動它)。

    半寫檔防線的**唯一**實作:upload_one 用它擋、pending_status 用它算還要等多久，
    兩邊講的才會是同一件事。讀不到 mtime 當成還沒靜置(同 upload_one 原本的處置)。"""
    try:
        return QUIET_S - (now - _newest_mtime(report_id, path, sidecar))
    except OSError:
        return QUIET_S


def pending_status(state=None, now=None):
    """drop dir 現在卡在哪：{"quiet_wait": 秒, "quiet": 份數, "deferring": 份數,
    "tmp": 份數}。

    `quiet_wait` 是 main() 決定要不要多等一輪的唯一依據,只算「唯一阻礙是 QUIET_S」
    的檔——退避中的等再久也不會動，所以不算；沒有這種檔就回 0，timer 觸發的那一輪
    因此一秒都不多付。其餘三項只用來在 journal 上交代這一輪看到了什麼。"""
    now = time.time() if now is None else now
    state = _load_state() if state is None else state
    watch_state = _load_state(_WATCH_STATE_PATH)
    out = {"quiet_wait": 0.0, "quiet": 0, "deferring": 0, "tmp": 0}
    # 看盤板的檔跟報告走同一道靜默期防線(path unit 看的是同一棵 watch/ 樹)
    queue = [(rid, path, state, None) for rid, path in pending()]
    queue += [(f"ops:{name}", path, watch_state, None) for name, path in pending_ops()]
    queue += [(f"data:{wid}", path, watch_state, watch_files_dir(wid))
              for wid, path in pending_data(watch_state)]
    for key, path, st, sidecar in queue:
        entry = st.get(key)
        if isinstance(entry, dict) and now < (entry.get("next_at") or 0):
            out["deferring"] += 1
            continue
        left = _quiet_left(key, path, now, sidecar)
        if left > 0:
            out["quiet"] += 1
            out["quiet_wait"] = max(out["quiet_wait"], left)
    if out["quiet_wait"]:
        # +0.05 = mtime 粒度的餘裕，免得睡醒還差幾微秒又被自己的防線擋下
        out["quiet_wait"] = min(out["quiet_wait"] + 0.05, QUIET_WAIT_MAX_S)
    for d in (REPORTS_DIR, WATCH_OPS_DIR, WATCH_DATA_DIR):
        try:
            out["tmp"] += sum(1 for n in os.listdir(d) if n.endswith(".tmp"))
        except OSError:
            pass
    return out


def upload_one(report_id, path, state, token, started=None):
    """一份報告走完一輪。回傳 'sent' / 'failed' / 'deferred' / 'skipped'。

    `started` = 這一輪掃描的起點,圖片上傳跟報告 PUT 共用 TICK_BUDGET_S。"""
    started = time.time() if started is None else started
    if not _ID_RE.fullmatch(report_id):
        _fail_permanently(report_id, path,
                          "file name is not a valid report id ([A-Za-z0-9_-]{1,64})",
                          state)
        return "failed"
    if _quiet_left(report_id, path, time.time()) > 0:
        return "skipped"  # 可能還在寫，留給下一輪（main() 會等滿再掃一次）
    entry = state.get(report_id)
    if isinstance(entry, dict) and time.time() < (entry.get("next_at") or 0):
        return "skipped"

    try:
        size = os.path.getsize(path)
    except OSError as e:
        print(f"[report_uploader] {report_id} not sizeable this tick: {e}", file=sys.stderr)
        return "skipped"
    if size > _READ_MAX_BYTES:
        _fail_permanently(report_id, path,
                          f"file is {size} bytes; anything past {_READ_MAX_BYTES} cannot "
                          f"serialize under the {REPORT_MAX_BYTES} byte ceiling",
                          state)
        return "failed"

    try:
        with open(path, encoding="utf-8") as f:
            raw = f.read()
    except OSError as e:
        # 開不起來 != 壞報告。Windows 上防毒或另一個寫入端的鎖可能撐得比 QUIET_S
        # 久，判成永久失敗就是把一份好報告搬進 failed/ 永遠不再送。
        print(f"[report_uploader] {report_id} not readable this tick: {e}", file=sys.stderr)
        return "skipped"
    except ValueError as e:  # UnicodeDecodeError：內容不是 UTF-8，重試也不會變
        _fail_permanently(report_id, path, f"file is not valid UTF-8 ({e})", state)
        return "failed"
    try:
        doc = json.loads(raw)
    except _JSON_ERRORS as e:
        _fail_permanently(report_id, path, f"file is not valid JSON ({e})", state)
        return "failed"
    if isinstance(doc, dict):
        doc.setdefault("id", report_id)  # 檔名即 id；不一致才拒收，見 check_report
    err = check_report(doc, report_id)
    if err:
        _fail_permanently(report_id, path, err, state)
        return "failed"
    outcome, message = _resolve_images(doc, report_id, started, token)
    if outcome == "permanent":
        _fail_permanently(report_id, path, message, state)
        return "failed"
    if outcome == "retry":
        _defer(report_id, message, state)
        return "deferred"
    body, err = _serialize(doc)
    if err:
        _fail_permanently(report_id, path, err, state)
        return "failed"

    try:
        resp = _put(body, report_id, token)
    except urllib.error.HTTPError as e:
        message, permanent = _api_error(e)
        if permanent:
            _fail_permanently(report_id, path, message, state)
            return "failed"
        _defer(report_id, message, state)
        return "deferred"
    except Exception as e:  # noqa: BLE001 — 連線層什麼都可能丟，一律當暫時性
        _defer(report_id, f"{type(e).__name__}: {e}", state)
        return "deferred"

    print(f"[report_uploader] uploaded {report_id} ({len(body)} bytes): {resp}",
          file=sys.stderr)
    state.pop(report_id, None)
    try:
        _retire(path, SENT_DIR)
        _prune_sent()
    except OSError as e:
        # 已經上傳成功但搬不走：留在原地會重送（同 id 覆蓋，平台不會多一份），
        # 但要看得見，否則就變成每輪重送的無聲迴圈
        print(f"[report_uploader] {report_id} uploaded but not retired: {e}",
              file=sys.stderr)
    return "sent"


def run_once(token=None, started=None):
    """掃一次 drop dir。回傳 {結果： 數量}。

    `started` = TICK_BUDGET_S 的計時起點。main() 等完靜默期的第二輪沿用第一輪的
    起點，兩輪加起來的最壞時長才還在 unit 的 TimeoutStartSec 裡。"""
    token = token or PROXY_TOKEN
    counts = {"sent": 0, "failed": 0, "deferred": 0, "skipped": 0}
    _sweep_orphan_files()  # 孤兒 sidecar 正好是「沒有報告可掃」的那一輪才留下來的
    files = pending()
    if not files:
        return counts
    state = _load_state()
    started = time.time() if started is None else started
    for report_id, path in files:
        if time.time() - started > TICK_BUDGET_S:
            counts["skipped"] += 1
            continue
        counts[upload_one(report_id, path, state, token, started)] += 1
    live = {rid for rid, _ in files}
    for gone in [rid for rid in state if rid not in live]:
        state.pop(gone)  # 檔案沒了（送出或人工刪掉），退避紀錄跟著走
    _save_state(state)
    return counts


# ── 看盤板(.claude/docs/watchboard.md §4)──────────────────────────────────────


def watch_files_dir(widget_id):
    """machine widget 內容的圖片 sidecar:watch/data/<widget_id>.files/,規則同報告。"""
    return os.path.join(WATCH_DATA_DIR, widget_id + FILES_SUFFIX)


def pending_ops():
    """[(檔名, 路徑)] 依檔名排序——檔名以 epoch_ms 開頭,排序就是 agent 下手的順序,
    而 add → update → remove 的先後是有意義的(順序倒了 update 會撞 404)。"""
    try:
        names = sorted(os.listdir(WATCH_OPS_DIR))
    except OSError:
        return []
    return [(n, os.path.join(WATCH_OPS_DIR, n)) for n in names
            if n.endswith(".json") and os.path.isfile(os.path.join(WATCH_OPS_DIR, n))]


def _data_stamp(path):
    st = os.stat(path)
    return [st.st_mtime, st.st_size]


def pending_data(state):
    """[(widget_id, 路徑)]:data/ 裡 mtime 或大小跟上次送成功時不同的檔。檔案留在
    原地(排程腳本覆寫它、runner 靠它的 mtime 判斷有沒有產出),所以「送過了」記在
    state 裡而不是靠搬檔。"""
    try:
        names = sorted(os.listdir(WATCH_DATA_DIR))
    except OSError:
        return []
    out = []
    for name in names:
        if not name.endswith(".json"):
            continue
        path = os.path.join(WATCH_DATA_DIR, name)
        if not os.path.isfile(path):
            continue
        wid = name[:-5]
        entry = state.get(f"data:{wid}")
        try:
            if isinstance(entry, dict) and entry.get("sent") == _data_stamp(path):
                continue
        except OSError:
            continue
        out.append((wid, path))
    return out


def _read_watch_file(key, path, max_bytes, state, failed_dir):
    """讀一個 ops / data 檔成 dict。回傳 (doc, outcome):doc 為 None 時 outcome 是
    'skipped'(這輪讀不到)或 'failed'(已搬進 failed/)。同 upload_one 對報告的三道門。"""
    try:
        size = os.path.getsize(path)
    except OSError as e:
        print(f"[report_uploader] {key} not sizeable this tick: {e}", file=sys.stderr)
        return None, "skipped"
    if size > max_bytes:
        _fail_permanently(key, path, f"file is {size} bytes; the ceiling is {max_bytes}",
                          state, failed_dir, WATCH_ERROR_LOG)
        return None, "failed"
    try:
        with open(path, encoding="utf-8") as f:
            raw = f.read()
    except OSError as e:
        print(f"[report_uploader] {key} not readable this tick: {e}", file=sys.stderr)
        return None, "skipped"
    except ValueError as e:
        _fail_permanently(key, path, f"file is not valid UTF-8 ({e})", state, failed_dir,
                          WATCH_ERROR_LOG)
        return None, "failed"
    try:
        doc = json.loads(raw)
    except _JSON_ERRORS as e:
        _fail_permanently(key, path, f"file is not valid JSON ({e})", state, failed_dir,
                          WATCH_ERROR_LOG)
        return None, "failed"
    if not isinstance(doc, dict):
        _fail_permanently(key, path, "must be a JSON object", state, failed_dir,
                          WATCH_ERROR_LOG)
        return None, "failed"
    return doc, "ok"


def _send_watch(key, path, body, url, method, state, token, failed_dir):
    """一個 ops / data 請求的收尾:200 → 'sent'、永久 4xx → failed/、其餘退避。"""
    try:
        resp = _request(url, body, method, token)
    except urllib.error.HTTPError as e:
        message, permanent = _api_error(e, _watch_permanent)
        entry = state.get(key) if isinstance(state.get(key), dict) else {}
        if e.code in _WATCH_AUTH_STATUS \
                and int(entry.get("attempts") or 0) + 1 >= _WATCH_AUTH_MAX_ATTEMPTS:
            permanent = True
            message += f" (after {_WATCH_AUTH_MAX_ATTEMPTS} attempts)"
        if permanent:
            _fail_permanently(key, path, message, state, failed_dir, WATCH_ERROR_LOG)
            return "failed"
        _defer(key, message, state)
        return "deferred"
    except Exception as e:  # noqa: BLE001 — 連線層什麼都可能丟，一律當暫時性
        _defer(key, f"{type(e).__name__}: {e}", state)
        return "deferred"
    print(f"[report_uploader] {key} ({len(body)} bytes): {resp}", file=sys.stderr)
    return "sent"


def upload_op(name, path, state, token):
    """一個 ops 檔走完一輪:POST /ops。回傳 'sent' / 'failed' / 'deferred' / 'skipped'。"""
    key = f"ops:{name}"
    if _quiet_left(key, path, time.time()) > 0:
        return "skipped"
    entry = state.get(key)
    if isinstance(entry, dict) and time.time() < (entry.get("next_at") or 0):
        return "skipped"
    doc, outcome = _read_watch_file(key, path, WATCH_DATA_MAX_BYTES, state,
                                    WATCH_OPS_FAILED_DIR)
    if doc is None:
        return outcome
    body, err = _serialize(doc)
    if err:
        _fail_permanently(key, path, err, state, WATCH_OPS_FAILED_DIR, WATCH_ERROR_LOG)
        return "failed"
    outcome = _send_watch(key, path, body, f"{WATCH_API_URL}/ops", "POST", state, token,
                          WATCH_OPS_FAILED_DIR)
    if outcome != "sent":
        return outcome
    state.pop(key, None)
    try:
        _retire(path, WATCH_OPS_SENT_DIR)
        _prune_sent(WATCH_OPS_SENT_DIR)
    except OSError as e:
        print(f"[report_uploader] {key} applied but not retired: {e}", file=sys.stderr)
    return "sent"


def upload_data(widget_id, path, state, token, started):
    """一個 data 檔走完一輪:PUT /data/<widget_id>,覆蓋語意。成功後檔案留在原地,
    state 記下送出時的 mtime+大小;失敗語意同報告(圖片三分法、永久 4xx 進 failed/)。"""
    key = f"data:{widget_id}"
    if not _WIDGET_ID_RE.fullmatch(widget_id):
        _fail_permanently(key, path, "file name is not a valid widget id ([A-Za-z0-9_-]{1,32})",
                          state, WATCH_DATA_FAILED_DIR, WATCH_ERROR_LOG)
        return "failed"
    sidecar = watch_files_dir(widget_id)
    if _quiet_left(key, path, time.time(), sidecar) > 0:
        return "skipped"
    entry = state.get(key)
    if isinstance(entry, dict) and time.time() < (entry.get("next_at") or 0):
        return "skipped"
    try:
        stamp = _data_stamp(path)  # 讀之前取:讀完才改的檔下一輪會再送一次,不會漏
    except OSError as e:
        print(f"[report_uploader] {key} not sizeable this tick: {e}", file=sys.stderr)
        return "skipped"
    doc, outcome = _read_watch_file(key, path, WATCH_DATA_MAX_BYTES, state,
                                    WATCH_DATA_FAILED_DIR)
    if doc is None:
        return outcome
    doc.setdefault("widget_id", widget_id)
    if doc["widget_id"] != widget_id:
        _fail_permanently(key, path, f"widget_id does not match the file name ({widget_id})",
                          state, WATCH_DATA_FAILED_DIR, WATCH_ERROR_LOG)
        return "failed"
    block = doc.get("block")
    if not isinstance(block, dict) or not isinstance(block.get("type"), str):
        _fail_permanently(key, path, "block: must be an object with a type", state,
                          WATCH_DATA_FAILED_DIR, WATCH_ERROR_LOG)
        return "failed"
    err = _check_image_files([block], "block")
    if err:
        _fail_permanently(key, path, err, state, WATCH_DATA_FAILED_DIR, WATCH_ERROR_LOG)
        return "failed"
    holder = {"blocks": [block]}
    outcome, message = _resolve_images(holder, widget_id, started, token, sidecar,
                                       WATCH_ERROR_LOG)
    if outcome == "permanent":
        _fail_permanently(key, path, message, state, WATCH_DATA_FAILED_DIR, WATCH_ERROR_LOG)
        return "failed"
    if outcome == "retry":
        _defer(key, message, state)
        return "deferred"
    if not holder["blocks"]:
        # 507 拿掉的是唯一的那個 block——報告還有別的內容可送,widget 沒有
        _fail_permanently(key, path, "the only block is an image and the image storage "
                          "quota is full (HTTP 507)", state, WATCH_DATA_FAILED_DIR,
                          WATCH_ERROR_LOG)
        return "failed"
    doc["block"] = holder["blocks"][0]
    body, err = _serialize(doc)
    if err:
        _fail_permanently(key, path, err, state, WATCH_DATA_FAILED_DIR, WATCH_ERROR_LOG)
        return "failed"
    if len(body) > WATCH_DATA_MAX_BYTES:
        _fail_permanently(key, path, f"{len(body)} bytes exceeds the {WATCH_DATA_MAX_BYTES} "
                          "byte ceiling", state, WATCH_DATA_FAILED_DIR, WATCH_ERROR_LOG)
        return "failed"
    outcome = _send_watch(key, path, body, f"{WATCH_API_URL}/data/{widget_id}", "PUT", state,
                          token, WATCH_DATA_FAILED_DIR)
    if outcome == "sent":
        state[key] = {"sent": stamp}
    return outcome


def run_watch_once(token=None, started=None):
    """掃一次 watch/ 樹:ops 先(依檔名)、data 後。回傳 {結果: 數量},預算同報告那輪。"""
    token = token or PROXY_TOKEN
    counts = {"sent": 0, "failed": 0, "deferred": 0, "skipped": 0}
    state = _load_state(_WATCH_STATE_PATH)
    ops, data = pending_ops(), pending_data(state)
    if not ops and not data:
        return counts
    started = time.time() if started is None else started
    for i, (name, path) in enumerate(ops):
        if time.time() - started > TICK_BUDGET_S:
            counts["skipped"] += 1
            continue
        outcome = upload_op(name, path, state, token)
        counts[outcome] += 1
        if outcome in ("deferred", "skipped"):
            # 後面的 op 不能越過還沒送出去的這個(add → update → remove 的先後有意義);
            # 剩下的留給下一輪。data 那條獨立,照送
            counts["skipped"] += len(ops) - i - 1
            break
    for wid, path in data:
        if time.time() - started > TICK_BUDGET_S:
            counts["skipped"] += 1
            continue
        counts[upload_data(wid, path, state, token, started)] += 1
    live = {f"ops:{n}" for n, _ in ops}
    try:
        live |= {f"data:{n[:-5]}" for n in os.listdir(WATCH_DATA_DIR) if n.endswith(".json")}
    except OSError:
        pass
    for gone in [k for k in state if k not in live]:
        state.pop(gone)  # 檔案沒了,退避紀錄與「送過了」的戳記跟著走
    _save_state(state, _WATCH_STATE_PATH)
    return counts


def _idle_note():
    """一輪什麼都沒送出去時，說一句掃到了什麼。

    一份報告會叫醒兩輪(.tmp 落地動一次目錄 mtime，os.replace 再動一次)，兩輪原本
    都完全無輸出，journal 上分不出「看到 .json 但還在靜默期」跟「只看到寫到一半的
    .tmp」。真的空目錄照樣不說話——沉默因此只剩一個意思。"""
    st = pending_status()
    bits = []
    if st["quiet"]:
        bits.append(f"{st['quiet']} inside the {QUIET_S}s quiet window")
    if st["deferring"]:
        bits.append(f"{st['deferring']} backing off")
    if st["tmp"]:
        bits.append(f"{st['tmp']} half-written .tmp")
    if bits:
        print("[report_uploader] nothing shipped: " + ", ".join(bits), file=sys.stderr)


def _run_all(started):
    counts = run_once(started=started)
    return {k: counts[k] + v for k, v in run_watch_once(started=started).items()}


def main():
    if not PROXY_TOKEN:
        print("[report_uploader] BLAVE_PROXY_TOKEN not set; exiting", file=sys.stderr)
        sys.exit(1)
    try:
        # 空目錄本身就是文件（用戶的 agent 看得到有這個地方可以放報告），而且
        # blave-agent-reports.path 監看的目標存在，inotify 才不必靠父目錄轉接
        # (watch/ops、watch/data 同理,同一個 path unit 看)
        for d in (REPORTS_DIR, WATCH_OPS_DIR, WATCH_DATA_DIR):
            os.makedirs(d, exist_ok=True)
    except OSError as e:
        print(f"[report_uploader] cannot create {REPORTS_DIR}: {e}", file=sys.stderr)
        sys.exit(1)
    started = time.time()
    counts = _run_all(started)
    # blave-agent-reports.path 是寫檔後**毫秒內**觸發的，所以它叫醒的這一輪看到的
    # 報告必定還在 QUIET_S 靜默期裡；而 systemd 不會為執行期間發生的事件重新觸發，
    # 這一輪空手而回就等於 path 觸發失效，每份報告都要等滿下一次 2 分鐘 timer
    # (實測 148 秒)。等滿靜默期再掃一次即可：防線本身一動也沒動，只是這一輪不提早
    # 收工。沒有「只差靜默期」的檔就不等，所以 timer 觸發的那一輪、以及上傳後搬檔
    # 造成的空觸發，一秒都不多付。只重掃一次：睡醒還在寫的檔是產出端沒照契約寫，
    # 那本來就該落到 timer 手上，不是在這裡陪它耗掉 unit 的 TimeoutStartSec。
    wait = pending_status()["quiet_wait"]
    if wait and time.time() - started + wait < TICK_BUDGET_S:
        time.sleep(wait)
        counts = {k: counts[k] + v for k, v in _run_all(started).items()}
    if counts["sent"] or counts["failed"] or counts["deferred"]:
        print(f"[report_uploader] {counts}", file=sys.stderr)
    else:
        _idle_note()
    # 掃完就是 rc=0。退出碼只講服務級失敗（上面那兩個 exit:沒 token、drop dir 建不
    # 起來），不講處理結果——deferred 是正常狀態（api 暫時不通、圖還沒寫完、預算用完，
    # 而 timer 每 2 分鐘就再來一次）、failed 是產出端寫壞一份報告而這支程式**正確地**
    # 把它歸檔；拿這兩個 exit 1 會讓 unit 長期停在 failed，真故障淹沒在假訊號裡。
    # 可見性不靠退出碼:counts 那行在 Linux 進 journal、在 Windows 由 run_task.ps1 的
    # `*>> logs\tasks.log` 無條件收走，而永久失敗另有 upload_errors.log + failed/、
    # 退避另有 state/report_uploads.json——都是不隨退出碼消失的持久紀錄。


if __name__ == "__main__":
    main()
