"""機器側事件通道:P1／P2 事件先落 `state/events.jsonl`,由 portfolio_reporter
每 2 分鐘連同既有 payload 送上平台(`POST /openclaw/agent/portfolio`),平台落
`agent_event` 再依級別 fan-out。分級與路由的規格在 `.claude/docs/notifications.md`。

為什麼是「檔案 ＋ 搭現有 payload」而不是機器自己送:機器自己判斷、自己發告警要送得出
去,得同時滿足「機器活著＋排程還在＋網路通＋TG 有配對」——那正是出事時最不可能同時成立
的四件事。事件先落檔就沒有這個問題:離線期間留在檔案裡、恢復後補送,平台依事件 id 去重。

**寫入端只 append,永遠不改檔**(config 側 lib/notify 的 dual-write 也照這條)。
輪替與截斷只有 reporter 做——它是唯一知道水位線的人,而且每 2 分鐘固定跑一次。
兩邊都改檔的話,append 與重寫之間的競態會直接吃掉事件。

檔案格式(一行一個 JSON 物件,UTF-8,LF):
    {"id": 1757469600123456, "ts": 1757469600, "type": "execution_stuck",
     "payload": {"symbol": "BTCUSDT", "style": "twap", "kind": "overdue"}}
  id      機器本地產生的單調遞增整數(epoch 微秒,並保證比檔案現有最後一筆大)。
          平台的 ack 水位線就是它,所以只能往上長。
  ts      事件發生時刻,epoch 秒(UTC)。
  type    事件型別,對應平台 openclaw/agent_events.py 的登記表。
  payload 該型別的欄位;平台端一律過白名單、截長度,多送的欄位會被丟掉。
"""
import json
import os
import sys
import time

BASE = os.environ.get("BLAVE_AGENT_BASE") or (
    r"C:\blave-agent" if os.name == "nt" else "/opt/blave-agent"
)
WORKSPACE = os.environ.get("BLAVE_AGENT_WORKSPACE", f"{BASE}/workspace")
STATE_DIR = os.path.join(WORKSPACE, "state")
EVENTS_PATH = os.path.join(STATE_DIR, "events.jsonl")
ACKED_PATH = os.path.join(STATE_DIR, "events.acked")

# 單筆事件的行長上限:超過的行不送(平台也有 4KB payload 上限),留在檔裡等輪替清掉
MAX_LINE_BYTES = 8192
# 單次回報最多帶幾筆／幾 bytes:回報整包有 4MB 硬上限(平台 PORTFOLIO_MAX_BYTES),
# 積壓的事件分幾輪送完就好,2 分鐘一輪追得上
MAX_SEND = 100
MAX_SEND_BYTES = 256 * 1024
# 輪替門檻:每次 ack 後都重寫檔案太吵(而且每次重寫都對 append 開一次競態窗),
# 所以檔案小的時候就讓已 ack 的行躺著
ROTATE_MIN_BYTES = 128 * 1024
ROTATE_MIN_LINES = 200
# 平台長期收不到(壞掉/機器離線很久)時的硬上限:超過就從最舊的丟起。
# 丟事件很痛,但把用戶機的磁碟寫爆更痛——而且磁碟滿了連交易紀錄都寫不進去。
HARD_CAP_BYTES = 2 * 1024 * 1024


def _log(msg):
    print(f"[events] {msg}", file=sys.stderr)


def _last_id():
    """檔案裡目前最大的事件 id(空檔/讀不到=0)。

    只讀檔尾 4KB:id 只要單調遞增,而檔案是 append-only,最後一行就是最大的。
    壞行(半截的、非 JSON)往前跳過——Windows 的 append 不是原子的,寧可跳過也不
    能讓一行壞資料把 id 打回去、之後的事件全部躲在水位線底下永遠送不出去。"""
    try:
        with open(EVENTS_PATH, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - 4096))
            tail = f.read()
    except OSError:
        return 0
    for raw in reversed(tail.splitlines()):
        ev = _parse(raw)
        if ev:
            return ev["id"]
    return 0


def _parse(raw):
    """一行 bytes → 事件 dict,壞行回 None(id 必須是正整數,type 必須是字串)。"""
    try:
        ev = json.loads(raw.decode("utf-8", "replace"))
    except ValueError:
        return None
    if not isinstance(ev, dict):
        return None
    ev_id, ev_type = ev.get("id"), ev.get("type")
    if not isinstance(ev_id, int) or isinstance(ev_id, bool) or ev_id <= 0:
        return None
    if not isinstance(ev_type, str) or not ev_type:
        return None
    return ev


def append(ev_type, payload=None, ts=None):
    """事件落檔,回事件 id(寫失敗回 None——通知不能反過來炸掉呼叫端的主流程)。

    id = max(epoch 微秒, 檔案最後一筆 + 1):時鐘被 NTP 往回撥時仍然遞增,否則新事件
    會掉到平台的 ack 水位線底下、永遠送不出去。兩個 process 在同一微秒各自讀到同一個
    last_id 才會撞號(那一筆會被平台當重複丟掉);事件本身稀疏,這個窗接受。

    整行一次 write:POSIX 的 O_APPEND 對這種單行寫是原子的,Windows 的 CRT append
    不保證,所以讀取端一律容忍壞行(見 _parse)。"""
    ev = {
        "id": max(int(time.time() * 1_000_000), _last_id() + 1),
        "ts": int(ts if ts is not None else time.time()),
        "type": str(ev_type),
        "payload": payload if isinstance(payload, dict) else {},
    }
    try:
        line = json.dumps(ev, ensure_ascii=False, separators=(",", ":")) + "\n"
    except (TypeError, ValueError) as e:
        _log(f"append {ev_type}: payload not JSON-serialisable ({e})")
        return None
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(EVENTS_PATH, "a", encoding="utf-8") as f:
            f.write(line)
    except OSError as e:
        _log(f"append {ev_type} failed: {e}")
        return None
    return ev["id"]


def load_acked():
    """平台已收下的最大事件 id;檔案不在/壞掉=0(寧可重送也不要漏送,平台照 id 去重)。"""
    try:
        with open(ACKED_PATH, encoding="utf-8") as f:
            return max(0, int(f.read().strip() or 0))
    except (OSError, ValueError):
        return 0


def save_acked(value):
    """水位線只能往前走:回應裡的 acked_through 比現值小就不動(平台換機/回滾時
    的舊值不該把已經送成功的事件變回未送)。回是否寫入。"""
    try:
        value = int(value)
    except (TypeError, ValueError):
        return False
    if value <= load_acked():
        return False
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        tmp = ACKED_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(str(value))
        os.replace(tmp, ACKED_PATH)
        return True
    except OSError as e:
        _log(f"acked write failed: {e}")
        return False


def unsent(acked=None, limit=MAX_SEND, max_bytes=MAX_SEND_BYTES):
    """要放進這輪 payload 的事件(id 由小到大)。只取水位線以上的;超長的單行跳過
    (平台也存不下,留給輪替清),整批到 limit 或 max_bytes 就停、剩下的下一輪再送。"""
    if acked is None:
        acked = load_acked()
    out, total = [], 0
    try:
        with open(EVENTS_PATH, "rb") as f:
            for raw in f:
                if len(raw) > MAX_LINE_BYTES:
                    continue
                ev = _parse(raw)
                if not ev or ev["id"] <= acked:
                    continue
                total += len(raw)
                if total > max_bytes:
                    break
                out.append(ev)
                if len(out) >= limit:
                    break
    except OSError:
        return []
    return out


def rotate(acked=None):
    """水位線以下的行清掉(＋硬上限保護)。**只有 reporter 呼叫**:檔案重寫與別的
    process 的 append 之間有一個毫秒級競態窗,所以要嘛沒事別開這個窗,要嘛開得夠少。
    回丟掉的行數。

    小檔不動:已 ack 的行躺著不佔什麼,每輪重寫反而是每輪開一次競態窗。"""
    if acked is None:
        acked = load_acked()
    try:
        size = os.path.getsize(EVENTS_PATH)
    except OSError:
        return 0
    try:
        with open(EVENTS_PATH, "rb") as f:
            lines = f.readlines()
    except OSError as e:
        _log(f"rotate read failed: {e}")
        return 0

    keep, dropped = [], 0
    for raw in lines:
        ev = _parse(raw)
        if ev is None or ev["id"] <= acked:
            dropped += 1  # 壞行也一併清掉:它永遠不會被 ack,留著只是佔位
            continue
        keep.append(raw)
    over_cap = size > HARD_CAP_BYTES
    if not over_cap and (dropped == 0
                         or (size < ROTATE_MIN_BYTES and len(lines) < ROTATE_MIN_LINES)):
        return 0

    if over_cap:
        # 平台長期收不下:留最新的一批,最舊的先丟。丟掉的事件在 log 留痕,
        # 不然「通知消失了」會查不出是被誰吃掉的。
        kept_bytes, tail = 0, []
        for raw in reversed(keep):
            kept_bytes += len(raw)
            if kept_bytes > HARD_CAP_BYTES // 2:
                break
            tail.append(raw)
        forced = len(keep) - len(tail)
        if forced > 0:
            _log(f"events.jsonl over {HARD_CAP_BYTES} bytes — dropped {forced} "
                 f"oldest unacked event(s)")
            dropped += forced
        keep = list(reversed(tail))

    try:
        tmp = EVENTS_PATH + ".tmp"
        with open(tmp, "wb") as f:
            f.writelines(keep)
        os.replace(tmp, EVENTS_PATH)
    except OSError as e:
        _log(f"rotate write failed: {e}")
        return 0
    return dropped
