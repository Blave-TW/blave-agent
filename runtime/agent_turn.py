"""
Agent loop, spec item 1: one process per turn ("每輪 spawn"), no persistent
agent process.

Delivery is pluggable: the same SDK loop drives either a Telegram sink
(edit-one-bubble, legacy Markdown) or a Web sink (discrete chunks POSTed to
the web-chat transport /report endpoint). Add a new surface = add a sink.

Usage:
  python3 agent_turn.py <session_id> <message> --delivery=telegram \\
      --telegram-token=... --telegram-chat-id=...
  python3 agent_turn.py <session_id> <message> --delivery=web \\
      --report-url=... --report-token=...
Prints the assistant's reply text to stdout; everything else goes to stderr.
"""
import argparse
import asyncio
import http.client
import json
import os
import re
import ssl
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

import claude_agent_sdk as sdk
import model_prefs
import session_store as ss
import strategy_reporter

_THIS_DIR = os.path.dirname(os.path.abspath(__file__))

WORKSPACE = os.environ.get("BLAVE_AGENT_WORKSPACE", "/opt/blave-agent/workspace")

# lib/notify.py (config-layer code, unmodified) resolves pairing state from
# $BLAVE_AGENT_HOME/credentials/telegram-default-allowFrom.json — a legacy
# convention. Our own pairing lives in config/telegram.json instead, so this
# runtime must keep a compat shim in sync at that path (see sync step below)
# and point BLAVE_AGENT_HOME there for every agent turn / Bash tool call.
BLAVE_AGENT_HOME = (os.environ.get("BLAVE_AGENT_HOME")
                    or os.environ.get("BLAVECLAW_HOME")
                    or "/opt/blave-agent")

# Every model routes through the real Blave proxy (api/openclaw/proxy.py)
# instead of holding raw upstream provider keys on this machine. The proxy
# picks Anthropic vs DeepSeek based on "deepseek" appearing in the model id,
# strips the provider/ prefix itself, and does real usage logging + credit
# deduction — this is the actual billing integration, not a POC shortcut.
# Auth is a single per-machine token (BLAVE_PROXY_TOKEN, matches this
# instance's openclaw_instances.ttyd_password), sent as "proxy-{token}".
PROXY_BASE_URL = "https://api.blave.org/openclaw/proxy"
PROXY_ENV = {
    "ANTHROPIC_BASE_URL": PROXY_BASE_URL,
    "ANTHROPIC_API_KEY": f"proxy-{os.environ.get('BLAVE_PROXY_TOKEN', '')}",
}

# Restrict to what a headless trading agent actually needs — the SDK's full
# default toolset burned 22k+ tokens on a single trivial turn in testing.
ALLOWED_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep"]
# Edit(path) deny rules — hold in bypassPermissions and cover Write/NotebookEdit (SDK
# docs › permissions). Live test on CLI 2.1.268 (2026-09-11): Edit, Write, Bash `>>`,
# `sed -i` and `cp` onto a listed file were all denied; a script opening the file itself
# is not covered — AGENTS.md carries the rule for that. The backtest-chain libs are what the web reads by
# contract and what a config update replaces wholesale; the rest of lib/ stays writable
# on purpose (user-built exchange helpers live there). A single leading slash anchors at
# cwd=WORKSPACE. 2026-09-11 an agent added an `anchored` option to lib/walk_forward.py
# because the user asked; the web then showed that run as rolling.
PROTECTED_EDIT_RULES = [
    "Edit(/lib/runner.py)",
    "Edit(/lib/param_scan.py)",
    "Edit(/lib/walk_forward.py)",
    "Edit(/lib/validation.py)",
    "Edit(/lib/analysis.py)",
    "Edit(/control/**)",
]


# 模型(尤其較弱的 instruction-following)看到 prompt 裡的逐字稿格式,會在寫完
# 回覆後「順著格式續寫下一個 user 回合」——實測 deepseek-v4-pro 捏造了一整則
# 使用者訊息(「幫我把參數更新到 scan 找到的最佳解」)。那段若存進歷史,下一輪
# agent 可能真的去執行使用者從沒下過的指令(對交易 agent 是實質風險)。
# SDK 沒有 stop_sequences,所以在輸出端硬攔:一出現我們自己產生的標記就截斷。
# 這些字串全是本檔產生的,正常回覆不會出現。pattern 本身放 session_store
# (單一來源——它存 summary 前也要用同一組標記做清洗)。
_SCAFFOLD_RE = ss.SCAFFOLD_RE


def strip_hallucinated_turn(text):
    """截掉模型續寫出來的假對話回合。回傳 (清理後文字, 是否有截斷)。"""
    if not text:
        return text, False
    m = _SCAFFOLD_RE.search(text)
    if not m:
        return text, False
    return text[: m.start()].rstrip(), True


# ── 建議下一步(suggested next actions)────────────────────────────────────
# 模型依 WEB_FORMATTING_RULE 在回覆末尾輸出 <suggest> 區塊(一行一句);
# WebSink.finalize 把它剝離成 {"type": "suggestions", "items": [...]} chunk,
# 前端渲染成輸入框上緣的可點建議列(點了=替用戶送出那句話)。
# TG 面沒有這條規則,但 TelegramSink 仍防禦性剝除,raw 標記絕不給用戶看到。
_SUGGEST_BLOCK_RE = re.compile(r"[ \t]*<suggest>(.*?)</suggest>[ \t]*", re.S)
# 回覆被截斷(interrupt/max_turns)時可能只剩未閉合的開頭——也要剝乾淨。
_SUGGEST_OPEN_TAIL_RE = re.compile(r"[ \t]*<suggest>(?:(?!</suggest>).)*$", re.S)
_SUGGEST_MAX_ITEMS = 3
_SUGGEST_MAX_CHARS = 80
# 中文建議句的半形標點轉全形——prompt 講了模型照樣寫半形逗號(同 Markdown 表格,
# 靠規則擋不住就在 code 收斂)。只動中文為主的行(英文建議照英文標點),
# 數字之間的逗號(1,000)保持半形。
_DIGIT_COMMA_RE = re.compile(r"(?<=\d),(?=\d)")
_HALF_TO_FULL = {",": "，", ";": "；", "!": "！", "?": "？"}


def _fullwidth_punct(line):
    # 判準與 _lang_directive 同一套(漢字要壓過英文字母)——英文建議句裡帶一個
    # 中文策略名不算中文句,標點維持英文。
    han = sum(1 for ch in line if "一" <= ch <= "鿿")
    letters = sum(1 for ch in line if ch.isascii() and ch.isalpha())
    if han < 2 or han <= letters * 0.5:
        return line
    line = _DIGIT_COMMA_RE.sub("\x00", line)
    for half, full in _HALF_TO_FULL.items():
        line = line.replace(half, full)
    # 全形標點本身佔一個字寬,後面再跟半形空格會看起來多一格。
    line = re.sub(r"([，；！？])[ \t]+", r"\1", line)
    return line.replace("\x00", ",")


def extract_suggestions(text):
    """回傳 (清理後文字, 建議清單)。剝掉所有 <suggest> 區塊(含未閉合尾段),
    items 取最後一個完整區塊;格式不符的行直接丟——fail-silent,絕不影響正文。"""
    if not text or "<suggest>" not in text:
        return text, []
    items = []
    blocks = _SUGGEST_BLOCK_RE.findall(text)
    if blocks:
        for line in blocks[-1].strip().splitlines():
            line = _fullwidth_punct(line.strip().lstrip("-•*‧·").strip())
            if line and len(line) <= _SUGGEST_MAX_CHARS:
                items.append(line)
            if len(items) >= _SUGGEST_MAX_ITEMS:
                break
    cleaned = _SUGGEST_BLOCK_RE.sub("", text)
    cleaned = _SUGGEST_OPEN_TAIL_RE.sub("", cleaned)
    return cleaned.rstrip(), items


# ── 轉出策略程式碼(export)──────────────────────────────────────────────────
# 工作頁的「轉出 XQ / MultiCharts / TradingView」走一般聊天回合:agent 依
# references/{xq-xs,multicharts-powerlanguage,tradingview-pine}.md 把轉好的檔存到
# strategies/<name>/exports/,回覆末尾自成一行帶 <export target=".." path=".." />。
# WebSink.finalize 把標記剝掉、讀檔、以 {"type": "export", ...} chunk 送出(前端自動
# 下載+在該則訊息渲染下載鈕)。標記出現幾個就送幾個 chunk;讀不到/太大/路徑不合法
# 就不送、只記 stderr——正文照常回,絕不因轉出失敗把整輪弄壞。
_EXPORT_TAG_RE = re.compile(
    r'[ \t]*<export\s+target="(xq|mc|pine)"\s+path="([^"<>]+)"\s*/>[ \t]*\n?'
)
# 格式不合(target 不在白名單、少屬性)的殘留標記只剝不觸發——raw 標記絕不露出。
_EXPORT_STRIP_RE = re.compile(r"[ \t]*<export\b[^<>]*>[ \t]*\n?")
_EXPORT_EXT = {"xq": "xs", "mc": "txt", "pine": "pine"}
_EXPORT_MAX_BYTES = 256 * 1024
_EXPORT_NAME_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")


def _read_export(target, path, workspace):
    """路徑白名單:相對路徑、無 ..、且恰為 strategies/<name>/exports/<file>;
    realpath 後仍須在 workspace/strategies 底下(擋 symlink 逃逸)。"""
    parts = path.replace("\\", "/").split("/")
    if (
        os.path.isabs(path)
        or len(parts) != 4
        or parts[0] != "strategies"
        or parts[2] != "exports"
        or not _EXPORT_NAME_RE.fullmatch(parts[1])
        or parts[3] in ("", ".", "..")
        or ".." in parts
    ):
        print(f"[agent_turn] export path rejected: {path!r}", file=sys.stderr)
        return None
    root = os.path.realpath(os.path.join(workspace, "strategies"))
    full = os.path.realpath(os.path.join(workspace, *parts))
    if not full.startswith(root + os.sep):
        print(f"[agent_turn] export path escapes workspace: {path!r}", file=sys.stderr)
        return None
    # 只收 regular file(FIFO / 目錄 / device 不讀,open 會卡住或炸);getsize 與 read
    # 之間檔案可能長大(TOCTOU),所以 read 也設上限、讀滿即拒。
    if not os.path.isfile(full):
        print(f"[agent_turn] export unreadable: {path} (not a regular file)", file=sys.stderr)
        return None
    try:
        if os.path.getsize(full) > _EXPORT_MAX_BYTES:
            print(f"[agent_turn] export too large (> {_EXPORT_MAX_BYTES}B): {path}",
                  file=sys.stderr)
            return None
        with open(full, encoding="utf-8") as f:
            content = f.read(_EXPORT_MAX_BYTES + 1)
        if len(content.encode("utf-8")) > _EXPORT_MAX_BYTES:
            print(f"[agent_turn] export too large (> {_EXPORT_MAX_BYTES}B): {path}",
                  file=sys.stderr)
            return None
    except (OSError, UnicodeDecodeError) as e:
        print(f"[agent_turn] export unreadable: {path} ({e})", file=sys.stderr)
        return None
    strategy = parts[1]
    return {
        "type": "export",
        "target": target,
        "strategy": strategy,
        "filename": f"{strategy}_{target}.{_EXPORT_EXT[target]}",
        "content": content,
    }


_EXPORT_FAIL_NOTE = "轉出檔讀取失敗，請再說一次「重新轉出」。"


def extract_exports(text, workspace=None):
    """回傳 (清理後文字, export chunk 清單)。剝掉所有 <export …/> 標記(含格式不合的
    殘留),合法且讀得到的各產一個 chunk;讀不到的不炸正文,但正文尾端補一行提示
    (多個失敗只補一行)——否則用戶只看到「轉好了」卻沒有檔案下載。"""
    if not text or "<export" not in text:
        return text, []
    workspace = workspace or WORKSPACE
    chunks = []
    failed = False
    for target, path in _EXPORT_TAG_RE.findall(text):
        chunk = _read_export(target, path, workspace)
        if chunk:
            chunks.append(chunk)
        else:
            failed = True
    cleaned = _EXPORT_STRIP_RE.sub("", text).rstrip()
    if failed:
        cleaned = f"{cleaned}\n\n{_EXPORT_FAIL_NOTE}" if cleaned else _EXPORT_FAIL_NOTE
    return cleaned, chunks


# ── 導航指引(ui_nav)──────────────────────────────────────────────────────
# 導航句回覆(「帶我看怎麼…」)第一行放 <nav>目標</nav>;WebSink 在段首攔下、
# 先送 {"type": "ui_nav", "target": ...} 再放正文——前端把自動下單頁開到對的
# 分頁後步驟文字才到,用戶照著現場做。目標白名單=references/portfolio-steps.md
# 的三套腳本(web 端 applyUiNav、webchat.py NAV_TARGETS 同一份,手動同步);
# 不在名單的目標一樣剝掉(標記絕不露出)但不觸發。
_NAV_TARGETS = ("portfolio.pos", "portfolio.venue", "portfolio.run")
_NAV_HEAD_RE = re.compile(r"^\s*<nav>\s*([^<>]{0,40}?)\s*</nav>[ \t]*\n*")
# 段首以外或殘留的標記(模型放錯位置)只剝不觸發。
_NAV_STRIP_RE = re.compile(r"[ \t]*<nav>[^<]{0,40}</nav>[ \t]*\n?")
_NAV_HOLD_MAX = 64  # 段首暫留上限:超過還沒閉合就當普通文字放行


def nav_hold_more(held):
    """段首暫留的文字是否仍可能長成 <nav> 標記(要繼續等下一個 delta)。
    一般回覆第一個 delta 就不是 '<' 開頭,立刻放行——不拖慢首字顯示。"""
    if len(held) >= _NAV_HOLD_MAX:
        return False
    probe = held.lstrip()
    return "<nav>".startswith(probe) or (probe.startswith("<nav>") and "</nav>" not in probe)


def split_nav_head(text):
    """段首若是完整 <nav> 標記:回傳 (白名單內的目標或 None, 剝掉標記後的文字, True);
    不是標記則 (None, 原文, False)。目標不在白名單也剝、只是不觸發。"""
    m = _NAV_HEAD_RE.match(text)
    if not m:
        return None, text, False
    target = m.group(1).strip()
    return (target if target in _NAV_TARGETS else None), text[m.end():], True


def _deploy_state_line():
    """部署現況的一行機器事實(建議規則配套,web 專屬)。2026-08-24 實測:
    supertrend_sol 已在模擬盤跑兩天,agent 仍建議「上模擬盤」——prompt 要求
    模型自查 deployments.json 靠不住,deterministic 餵進來才穩(phase 2 狀態機
    的第一塊)。fail-silent:讀不到就回空字串,絕不影響回合。"""
    try:
        deployed = []
        try:
            with open(os.path.join(WORKSPACE, "state", "deployments.json"),
                      encoding="utf-8") as f:
                reg = json.load(f)
            if isinstance(reg, dict):
                deployed = [k for k in reg if k != "reconciler"][:15]
        except (OSError, ValueError):
            pass
        names = []
        sdir = os.path.join(WORKSPACE, "strategies")
        if os.path.isdir(sdir):
            for e in sorted(os.listdir(sdir)):
                if e.startswith((".", "TEMPLATE")) or e == "__pycache__":
                    continue
                full = os.path.join(sdir, e)
                if os.path.isdir(full) and os.path.isfile(os.path.join(full, "strategy.py")):
                    names.append(e)
                elif os.path.isfile(full) and e.endswith(".py"):
                    names.append(e[:-3])
        undeployed = [n for n in names if n not in deployed][:15]
        paper = os.path.isfile(os.path.join(WORKSPACE, "state", "paper_ledger.json"))
        parts = ["已部署運行中:" + ("、".join(deployed) if deployed else "無")]
        if undeployed:
            parts.append("未部署:" + "、".join(undeployed))
        parts.append("模擬盤帳戶:" + ("已綁定" if paper else "未綁定"))
        return ("[部署現況(機器事實,提議前先對照——已在跑的策略不要再建議部署/上模擬盤):"
                + ";".join(parts) + "]")
    except Exception:
        return ""


# ── 圖片儲存空間滿了 ─────────────────────────────────────────────────────
# 機器上傳回測圖時被 api 以 507 擋下(每個用戶的 S3 儲存上限)。這件事只有 agent 在
# 對話裡講得掉:工作頁 banner 用戶不一定會看,機隊的 TG 通知疑似長期斷線,而且只有
# agent 講得出「舊策略的圖佔著空間,要不要刪掉幾支不用的」這種可以直接動手的話。
#
# 事實來源只有一個:strategy_reporter 真的收到過 507 才會寫那個檔(見
# strategy_reporter._record_image_quota)。不從「圖沒出現」之類的現象反推——那是猜。
#
# 什麼時候該閉嘴。配額滿了不會自己好,所以「有事實就講」等於每輪都唸。兩道門各擋一種:
#   1. 事實要還在發生。reporter 每 2 分鐘一輪,但只在圖有變動時才真的上傳,所以
#      「_QUOTA_FRESH_SEC 內沒再 507」= 這段期間沒有新圖在掉。沒東西在掉就沒必要提;
#      真的又掉了,2 分鐘內事實就會更新、緊接著那一回合就講——那也正好是用戶剛跑完
#      回測、最聽得進去的時候。
#   2. 注入過就冷卻 _QUOTA_REMIND_SEC。
# 事實過期不是完全閉嘴,而是降級成被動版:用戶兩天後自己問「我的圖呢」時,agent 手上
# 得有這條事實可以答,否則依 canon 它只能猜。
#
# 冷卻是刻意設得比 FRESH 短的(2026-08-26 改,原本 12h > FRESH):門 2 燒的是「注入過」
# 不是「模型真的講了」,而 29026 deepseek 實測命中率只有一半。原本的順序下,漏講一次
# 的代價不是「晚半天」而是「這次事件再也不會主動提」——事實 6 小時後就過期成被動版,
# 冷卻還沒退。多講的代價則有界:507 持續發生時最多 FRESH/REMIND=6 次注入(照實測命中
# 率約 3 次真的出口),而且那句話本身是「一兩句順帶」+「使用者沒接話就不要再追」。
# 一邊是靜音到底、一邊是半天內可能多唸兩句,在命中率不是 100% 的前提下偏向前者。
# 代價是門 2 不再蓋過門 1:剛好在停止掉圖、事實還沒過期的那段(用戶已刪策略但還沒重跑
# 回測,所以沒有成功上傳來清掉事實)可能會多提一次——比漏講整件事划算。
_QUOTA_FRESH_SEC = 6 * 3600
_QUOTA_REMIND_SEC = 3600
# reporter 寫事實、這裡寫「講過了」,各寫各的檔:兩者是不同 process(2 分鐘一次的
# timer vs 每輪 spawn),共用一個檔就是互相蓋掉的 read-modify-write。
_QUOTA_TOLD_PATH = os.path.join(strategy_reporter.STATE_DIR, "strategy_image_quota_told.json")

# 主動版刻意把兩件事寫死進去:空間不是刪完立刻回來(api 端一天掃一次,而且只清超過
# 一天沒被引用的圖),被擋掉的那幾張也不會自己補上(reporter 的簽章檔認為送過了)。
# 少了這兩句,用戶照做卻沒看到圖,會以為功能壞掉——之後的第二次提醒更像壞掉。
_QUOTA_LINE = (
    "[圖片儲存空間(機器事實,不是推測——這台機器上傳回測圖時,真的被伺服器以"
    "「儲存空間已滿」擋下):新的回測圖存不進去,工作頁的回測圖分頁看不到它們。"
    "本回合用一兩句話順帶告訴使用者,並提議刪掉不再用的舊策略(連同它們的圖)來空出"
    "空間。要講清楚兩件事:空間不是刪完立刻回來(伺服器每天清一次,而且只清超過一天"
    "沒被引用的圖),已經被擋掉的那幾張也不會自己補上——要等空間回來後重跑一次回測。"
    "使用者沒接話就不要再追。]"
)
_QUOTA_LINE_STALE = (
    "[圖片儲存空間(機器事實,舊訊息,不要主動提):這台機器先前上傳回測圖時,被伺服器"
    "以「儲存空間已滿」擋下過,當時那幾張圖沒有存進去。只有使用者自己問起圖片為什麼"
    "不見時才用得上這條。]"
)


def _read_state_json(path):
    try:
        with open(path) as f:
            val = json.load(f)
        return val if isinstance(val, dict) else {}
    except (OSError, ValueError):
        return {}


def _image_quota_line(now=None):
    """圖片儲存空間的一行機器事實(沒有就空字串)。fail-silent,同 _deploy_state_line。

    有副作用:回傳主動版的同時就把「注入過」記下去。記的不是「模型真的講了」——那只能
    靠字串比對模型輸出去猜,跨語言又跨措辭。改用短冷卻(見 _QUOTA_REMIND_SEC)吸收漏講
    的那幾次,不為了猜而讓一次沒命中變成整段靜音。"""
    try:
        at = _read_state_json(strategy_reporter.IMG_QUOTA_PATH).get("at")
        if not at:
            return ""
        now = now if now is not None else time.time()
        if now - at > _QUOTA_FRESH_SEC:
            return _QUOTA_LINE_STALE
        if now - (_read_state_json(_QUOTA_TOLD_PATH).get("at") or 0) < _QUOTA_REMIND_SEC:
            return ""
        try:
            os.makedirs(strategy_reporter.STATE_DIR, exist_ok=True)
            with open(_QUOTA_TOLD_PATH, "w") as f:
                json.dump({"at": int(now)}, f)
        except OSError:
            # 記不下來就不要講:寧可漏一次提醒,也不要變成每輪都唸。
            return ""
        return _QUOTA_LINE
    except Exception:
        return ""


# 導航類回合(問怎麼部署/綁定/啟動)把 references/portfolio-steps.md 的步驟腳本段
# 直接注入:UI 標籤要一字不差,模型自己不會去讀那個檔(29026 實測:啟動下單編出
# 「運行」分頁、綁定編出「渠道」分頁/「綁定」鈕)——頁面被 ui_nav 開好後錯標籤
# 立刻穿幟。事實來源仍是 bcc 那份檔,這裡只搬運、不另抄一份。
# 閘=「問怎麼做」+「部署類主題」兩者都命中(單看主題太寬:資金費率/持倉問答也會中,
# 每次誤中多塞 ~400 token 還可能把純問答帶偏成操作步驟)。
# 簡體變體:簡中錨(cn)下建議句寫成簡體,點下去送回來的就是簡體。es/pt/vi/ja 的部署類
# 建議句由錨釘成英文「Show me how to …」(_foreign_pins),所以不另收那四種語言的字。
_NAV_ASK_RE = re.compile(
    r"帶我看|带我看|show me how|怎麼|怎么|怎樣|怎样|如何|哪裡|哪里|哪邊|哪边|\bhow\b|\bwhere\b",
    re.I)
_NAV_TOPIC_RE = re.compile(
    r"模擬盤|模拟盘|交易所|綁定|绑定|部署|啟動|启动|恢復|恢复|部位|金額|金额|實盤|实盘"
    r"|paper|deploy|bind|exchange|venue|fund"
    r"|go live|live trad|real money|small (?:amount|size)|start trading|resume|restart",
    re.I,
)


def nav_topic(message):
    return bool(_NAV_ASK_RE.search(message) and _NAV_TOPIC_RE.search(message))
_STEPS_MAX_CHARS = 2400


def _portfolio_steps_block(workspace=None):
    """回傳 portfolio-steps.md 的「Step scripts」段(含之後全部),讀不到/沒那段就空字串。"""
    path = os.path.join(workspace or WORKSPACE, "references", "portfolio-steps.md")
    try:
        with open(path, encoding="utf-8") as f:
            doc = f.read()
    except OSError:
        return ""
    i = doc.find("## Step scripts")
    if i < 0:
        return ""
    j = doc.find("\n## ", i + 1)  # 只到下一個標題,日後檔尾加段不會被一併注入
    if j < 0:
        j = len(doc)
    return doc[i:min(j, i + _STEPS_MAX_CHARS)].strip()


def _is_zh(message):
    """這則用戶訊息是不是中文。漢字要「壓過」英文字母才算——「what is 台積電 price」
    是英文句帶個股名,不是中文句。只在沒有回覆語言設定、也沒有 ui_lang 時才用
    (_resolve_reply_lang 解不出語言),_lang_directive 與兜底錯誤句共用同一條判定。"""
    han = sum(1 for ch in message if "一" <= ch <= "鿿")
    letters = sum(1 for ch in message if ch.isascii() and ch.isalpha())
    return han >= 3 and han > letters * 0.5


def _lang_directive(message, suggest=False, lang=None):
    """Deterministic per-turn language pin. `lang` (resolved reply language, see
    _resolve_reply_lang) wins outright — no per-message exception. Without it the
    Han-character ratio decides what the user wrote in; either way the directive
    names ONE target language explicitly — a generic bilingual "follow the user"
    line loses to a Chinese-heavy context.
    suggest=True (web only) extends the pin to the <suggest> lines: the suggest
    rule + its example are written in Chinese, so without naming them the
    English reply comes back with Chinese suggestions (uid=1, 2026-08-25)."""
    if lang in _REPLY_LANG_PINS:
        return _REPLY_LANG_PINS[lang][1 if suggest else 0]
    if lang and lang.startswith(strategy_reporter.REPLY_LANG_CUSTOM_PREFIX):
        return _custom_pins(lang[len(strategy_reporter.REPLY_LANG_CUSTOM_PREFIX):])[
            1 if suggest else 0]
    letters = sum(1 for ch in message if ch.isascii() and ch.isalpha())
    if _is_zh(message):
        if suggest:
            return "[用中文回覆這則訊息,<suggest> 建議句也用中文]"
        return "[用中文回覆這則訊息]"
    if letters >= 2:
        if suggest:
            return (
                "[The user wrote in English — reply ENTIRELY in English. "
                "No Chinese anywhere in this reply, including headers, closing remarks "
                "and every line inside the <suggest> block (deployment suggestions "
                "start with \"Show me how to\", not 「帶我看怎麼」).]"
            )
        return (
            "[The user wrote in English — reply ENTIRELY in English. "
            "No Chinese anywhere in this reply, including headers and closing remarks.]"
        )
    if suggest:
        return "[Reply in the language of the user message above — the <suggest> lines too]"
    return "[Reply in the language of the user message above]"


def _foreign_pins(name):
    return _pins(f"[Reply ENTIRELY in {name} — this is the user's reply language, whatever "
                 f"language this message is written in. No Chinese or English sentences anywhere "
                 f"in this reply, including headers and closing remarks")


def _custom_pins(text):
    """使用者自填的語言名稱(七種以外)。text 已由 strategy_reporter.parse_reply_lang_custom
    清成單行、≤40 字、無 `]` `"` `<` `>`——這裡只把它當資料用引號包起來,不當指令。"""
    return _pins(f"[Reply ENTIRELY in the language the user specified: \"{text}\" — this is "
                 f"the user's reply language, whatever language this message is written in. "
                 f"No other language anywhere in this reply, including headers and closing remarks")


def _pins(base):
    tail = "; code, tickers and strategy names stay as they are.]"
    # 部署類建議句例外留英文:點下去送回來的句子要被 nav_topic / 導航句判定認得,
    # 否則 portfolio-steps.md 不注入、UI 標籤又會亂編(29026)。回覆本身仍照目標語言。
    suggest_tail = (
        " and every line inside the <suggest> block — EXCEPT deployment suggestions (paper "
        "trading, setting the amount, binding an exchange, starting or resuming trading): "
        "write each of those lines entirely in English, starting with \"Show me how to\" "
        "(e.g. Show me how to paper trade 〈strategy name〉), because the page recognises "
        "that exact phrase to open the right screen" + tail)
    return (base + tail, base + suggest_tail)


# 語系代碼 → (一般, suggest=True) 的尾端錨。代碼集 = strategy_reporter.REPLY_LANGS。
# 非中文語言用英文寫但點名目標語言,並明講不要中文:system prompt 與歷史多半是中文。
_REPLY_LANG_PINS = {
    "zh": ("[用繁體中文回覆這則訊息——這是使用者的回覆語言,不論這則訊息用什麼語言寫都一樣;"
           "不要用簡體字]",
           "[用繁體中文回覆這則訊息——這是使用者的回覆語言,不論這則訊息用什麼語言寫都一樣;"
           "不要用簡體字,<suggest> 建議句也用繁體中文]"),
    "cn": ("[用简体中文回复这条消息——这是用户的回复语言,不论这条消息用什么语言写都一样;"
           "不要用繁体字]",
           "[用简体中文回复这条消息——这是用户的回复语言,不论这条消息用什么语言写都一样;"
           "不要用繁体字,<suggest> 建议句也用简体中文]"),
    "en": ("[Reply ENTIRELY in English — this is the user's reply language, whatever language "
           "this message is written in. No Chinese anywhere in this reply, including headers "
           "and closing remarks.]",
           "[Reply ENTIRELY in English — this is the user's reply language, whatever language "
           "this message is written in. No Chinese anywhere in this reply, including headers, "
           "closing remarks and every line inside the <suggest> block (deployment suggestions "
           "start with \"Show me how to\", not 「帶我看怎麼」).]"),
    "es": _foreign_pins("Spanish (Español)"),
    "pt": _foreign_pins("Portuguese (Português)"),
    "vi": _foreign_pins("Vietnamese (Tiếng Việt)"),
    "ja": _foreign_pins("Japanese (日本語)"),
}


def _resolve_reply_lang(ui_lang=None):
    """回覆語言:機器上的設定 > web 回合的 ui_lang > None(交給 _is_zh 啟發式)。
    回七碼之一,或自訂語言的 `custom:<text>`(_lang_directive 認 prefix;_fault_message
    只認 zh/cn,其餘含自訂一律退英文)。"""
    lang, custom = strategy_reporter.read_reply_lang_setting()
    if lang:
        return lang
    if custom:
        return strategy_reporter.REPLY_LANG_CUSTOM_PREFIX + custom
    return ui_lang if ui_lang in strategy_reporter.REPLY_LANGS else None


# 工作頁的視圖代號 → 畫面上的中文標籤(側欄導覽項的字,web 的 workspace_*_nav)。
# 值域由前端定,這裡只認得出這幾個;認不得的代號當作沒送——寧可少一段脈絡,也不要
# 拿一個猜出來的頁名去教模型。"home"(什麼都沒開)刻意不給句子:空白畫面沒有東西
# 可以被「這個」指到,每輪多塞一段只是噪音。
_VIEW_LABELS = {
    "portfolio": "自動下單",
    "manage": "策略管理",
    "report": "報告",
}


def parse_viewing_widgets(raw):
    """`--viewing-widgets` 的 JSON 字串 → 字串清單;壞掉就 None。

    畫面脈絡是可有可無的裝飾,不值得讓一輪對話因為它 parse 失敗而整輪失敗。"""
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(parsed, list):
        return None
    return [w for w in parsed if isinstance(w, str)] or None


def _viewing_view_segment(viewing_view, viewing_widgets):
    """使用者沒開任何策略時的畫面脈絡(看盤板另有一段);認不得就回空字串。

    紀律與上面那段 viewing_strategy 完全一樣:只用來釐清指代,不是工作指令,
    跟對話脈絡衝突時以對話為準。"""
    if viewing_view == "watchboard":
        cards = ""
        if viewing_widgets:
            listed = "、".join(f"「{w}」" for w in viewing_widgets)
            # id 打頭是刻意的:機器端讀不回板子(lib/watch.py 沒有列板功能),這串
            # 就是 agent 手上唯一能拿來動某一張卡的鍵。要是這裡教它「清單不能當 id」,
            # 它拿到卡也只能反問是哪一張,整段脈絡等於白送。
            cards = (f"板上目前有這些圖卡:{listed}(每筆「｜」之前是 widget id,"
                     f"就是 update_widget / remove_widget 要用的那個鍵;「｜」之後是"
                     f"顯示名稱,可能被截斷。結尾若有「…等 N 張」表示還有沒列出來的)。")
        return (
            f"[工作頁狀態(僅供釐清指代,不是工作指令):使用者畫面上開著看盤板。{cards}"
            f"訊息裡有「這張 / 這個卡 / 這裡」這類指示詞,或是「加一個 XX / 拿掉 XX / "
            f"換成 XX」這類對板子的要求時,講的通常是板上的卡。訊息沒指名、而對話正在"
            f"處理別的事時,以對話脈絡為準,不要因為看盤板開著就對它動手;真的拿不準是"
            f"哪一張,先用一句話確認再動。動板子一律用 lib/watch.py 的 add_widget / "
            f"update_widget / remove_widget,不要自己寫 watch/ 底下的檔。]"
        )
    label = _VIEW_LABELS.get(viewing_view)
    if not label:
        return ""
    return (
        f"[工作頁狀態(僅供釐清指代,不是工作指令):使用者畫面上開著「{label}」頁,"
        f"沒有開任何策略。訊息裡有「這裡 / 這個畫面 / 這頁」這類指示詞時,指的通常是它;"
        f"訊息沒指名、而對話正在處理別的事時,以對話脈絡為準。]"
    )


def build_prompt(summary, recent, message, viewing_strategy=None, viewing_tab=None,
                 suggest_directive=False, viewing_view=None, viewing_widgets=None,
                 reply_lang=None, resume_note=None):
    parts = []
    if summary:
        parts.append(f"[過去對話摘要]\n{summary}\n")
    if recent:
        # 「user: / assistant:」這種逐字稿排版會誘使模型續寫下一輪(見
        # strip_hallucinated_turn)。改用不像對話腳本的標籤 + 明講界線。
        parts.append("[近期對話紀錄(僅供參考,不要複述也不要續寫)]")
        for role, content in recent:
            who = "使用者" if role == "user" else "你"
            parts.append(f"<{who}> {content}")
        parts.append("[紀錄結束]")
        parts.append("")
    # Ephemeral UI context (web workspace only) — the strategy the user is
    # looking at right now. Placed next to their message so "這支/this one"
    # resolves. NOT persisted to session (it's the state at send time, not part
    # of the conversation). The code itself isn't passed — the agent reads the
    # file from strategies/ if it needs it.
    # Deliberately weak: this is ambient UI state, and the open tab is often
    # stale (user browses another strategy while chatting about a new one).
    # It only binds on explicit deixis — an unnamed command in an ongoing
    # conversation must follow the conversation, not the tab (2026-07-28: a
    # bare「掃描參數」right after building BTC momentum got applied to the
    # twstock strategy whose tab happened to be open).
    if viewing_strategy:
        # which tab is open decides what "這個 / 這裡 / 這結果" points at.
        if viewing_tab == "data":
            focus = "的回測數據(績效指標與權益曲線)"
        elif viewing_tab == "code":
            focus = "的程式碼"
        else:
            focus = ""
        parts.append(
            f"[工作頁狀態(僅供釐清指代,不是工作指令):使用者畫面上開著策略"
            f"「{viewing_strategy}」{focus}。訊息裡有「這支 / 這個策略 / 這裡 / 這結果」"
            f"這類指示詞時,指的通常是它。訊息沒指名策略、而對話正在處理另一支時,"
            f"以對話脈絡為準,不要因為分頁開著就對它動手;兩邊衝突拿不準,"
            f"先用一句話確認要動哪一支再動。需要看內容就自己讀 strategies/ 底下對應的檔"
            f"(程式碼在 strategy.py、回測結果在 stats.json / pnl.png)。]"
        )
    else:
        # 只有沒開策略時才送:web 一切到別的視圖就清掉 selectedName,兩者實際互斥,
        # 而兩段畫面脈絡同時在場只會讓指代更難判。
        seg = _viewing_view_segment(viewing_view, viewing_widgets)
        if seg:
            parts.append(seg)
    parts.append("[使用者這次的訊息]")
    parts.append(message)
    # 紅線逐輪錨——**兩個 sink 都掛**,獨立於 suggest_directive:TG 是主介面之一,
    # 只放 AGENTS.md/系統尾端會輸給 in-context 慣性(deepseek 教訓,同
    # _lang_directive 的機制);建議句規則(下面那段)維持 web 專屬。
    # 單支停用句只給已更新到有這兩支工具的 workspace(同 _cmd_close_all 的 flatten.py
    # 判準):舊 workspace 指去不存在的腳本,弱模型會自己手寫一份(uid 30979 事故)
    stop_tool = os.path.isfile(os.path.join(WORKSPACE, "manager", "stop_strategy.py"))
    parts.append(
        "[紅線:部署/金額/綁定/恢復交易一律指引用戶到自動下單頁操作,不代做;"
        "急停(HALT)例外可做"
        + (";用戶明確要求停單支策略/平單一幣時可做,用 manager/stop_strategy.py、"
           "manager/close_symbol.py。]" if stop_tool else "。]")
    )
    if suggest_directive:
        state_line = _deploy_state_line()
        if state_line:
            parts.append(state_line)
        # 導航句(建議列的部署類固定起手)逐輪錨:標記規則在系統尾端,弱模型對
        # 「第一行放標記」這種位置要求最容易漏,貼著訊息再講一次。
        head = message.lstrip().lower()
        # 带我看:簡中錨下建議句會寫成簡體,點下去送回來的就是這個字形
        if head.startswith(("帶我看", "带我看", "show me how")):
            parts.append(
                "[導航句:回覆第一行單獨放 <nav>目標</nav>(portfolio.pos=設金額/部署、"
                "portfolio.venue=綁定模擬盤或交易所、portfolio.run=啟動/恢復下單,三選一),"
                "接著才給步驟。]"
            )
        if nav_topic(message):
            steps = _portfolio_steps_block()
            if steps:
                parts.append(
                    "[自動下單頁操作步驟(要帶用戶操作時照這份寫,UI 標籤一字不差、"
                    "不要自己發明分頁或按鈕名):\n" + steps + "\n]"
                )
        # 建議規則的逐輪錨(web 專屬)。系統提示尾端的版本擋不住 in-context 慣性:
        # session 歷史累積「市場問答→問句收尾」先例後,deepseek 對探索層連續三輪
        # 不服從(2026-08-24 e2e:ETH/BTC vs ETH/SOL 三輪全數問句收尾、零區塊);
        # _lang_directive 已證明「貼著訊息的逐輪指令」對弱模型有效,同機制照搬。
        parts.append(
            "[結尾規則:要提議下一步(再拉圖、補籌碼面、跑回測、掃參數、跑 MCPT、上模擬盤等)就放進"
            " <suggest> 區塊(一行一句、用戶口吻、最多 3),不要在正文用問句提議;"
            "提到策略用它的名稱、不用底線代號。"
            "命中里程碑(剛完成回測、或本輪在總結/分析一支有回測但未部署的策略)必附區塊;"
            "純寒暄或單一報價則什麼都不附。]"
        )
    # 兩個 sink 都掛(不像 _deploy_state_line 是 web 專屬):這是機器層級的事實,不是
    # 工作頁的 UI 狀態,而且只從 TG 用的人更沒有別的地方會看到它。
    # 位置擠在語言錨之前的倒數第二格(2026-08-26 從紅線句後面挪來):它是「本回合要多做
    # 一件事」的逐輪指令,跟語言錨同一類,弱模型對這種指令吃 recency——原本夾在中段,
    # 29026 deepseek 實測兩次只講一次(注入都有發生,是模型無視)。TG 那邊本來就已經在
    # 這個位置(下面那整段是 web 專屬),所以這一步只動到 web。
    # 挪完同機再跑 6 次是 4 中:跟挪之前的 1/2 在這個樣本數下分不出來,位置效果未證實。
    # 漏講的下限不靠這格,靠 _QUOTA_REMIND_SEC 的短冷卻兜底。
    if resume_note:
        parts.append(resume_note)
    quota_line = _image_quota_line()
    if quota_line:
        parts.append(quota_line)
    # 語言錨放**真正的最尾端**(recency 權重最大)且由 code 偵測、給「針對性」指令:
    # 系統規則是中文寫的+歷史多為中文,籠統的「跟著使用者語言」擋不住英文訊息被
    # 回成中文/中英混雜(實測兩輪)。必須排在上面所有中文逐輪指令(紅線句、建議句
    # 規則)之後——之前放在它們前面,英文回合正文是英文、<suggest> 卻照中文範例
    # 寫成中文(uid=1,2026-08-25)。
    parts.append(_lang_directive(message, suggest=suggest_directive, lang=reply_lang))
    return "\n".join(parts)


# references/models.md (shared blave-agent content, not ours to edit)
# points at get-api-key.py, which only exists on real openclaw machines — on
# this runtime it doesn't exist, so the model has no way to answer "which
# models do you support" correctly without this note. The proxy token it
# needs is already sitting in its own ANTHROPIC_API_KEY env var (that's what
# authenticates every model call this runtime makes), so no new credential
# exposure — just telling it where to look instead of guessing or asking the
# user for a key that already exists in its own environment.
def model_catalog_rule(session_id):
    """Per-turn (not module-level) because the switch command embeds this
    turn's own session_id — set_model.py needs it to know whose preference
    to write."""
    return (
        "\n\n---\n\n"
        "## 查詢 / 切換模型（本 runtime 專屬規則）\n"
        "如果被問到「支援哪些模型 / 計價」，不要找 references/models.md 提到的\n"
        "get-api-key.py（那是舊 openclaw 機器才有的腳本，這裡沒有），也不要用\n"
        "workspace .env 裡的 Blave API key（那組是另一套帳號認證，查不到這個）。\n"
        "改用 Bash 工具直接查真實清單：\n"
        "```\n"
        f'curl -s {PROXY_BASE_URL}/v1/models -H "x-api-key: $ANTHROPIC_API_KEY"\n'
        "```\n"
        "`$ANTHROPIC_API_KEY` 已經在你的環境變數裡（本 runtime 的 proxy token），\n"
        "不需要另外要金鑰，直接呼叫就有正確、即時的清單跟計價。\n\n"
        "如果使用者要求切換模型：先用上面的指令確認完整 model id"
        "（例如 `anthropic/claude-sonnet-5`），然後執行：\n"
        "```\n"
        f"python3 {_THIS_DIR}/set_model.py {session_id} <model_id>\n"
        "```\n"
        "**這個切換從下一則訊息才會生效**（每輪都是全新 process，這一輪已經在用"
        "原本的模型跑了，改不了這輪）——回覆使用者時要講清楚這點，不要說「已經切換」。"
    )


# ── 用戶常駐偏好 ──────────────────────────────────────────────────────────
# 對話裡表達的常駐偏好(「以後每個策略都要停損」)存 workspace/state/
# preferences.md,每輪整份注入(跟 AGENTS.md 同路徑)。滾動摘要的 schema 沒有
# 「用戶偏好」這個段落,偏好掉出近期對話視窗就會被 compaction 洗掉——這個檔
# 就是為了補這個洞。量的控制在寫入端(下面的規則要求 agent 保持 ≤10 條、寫入
# 時修剪);這裡只設兩道保險,而且都要出聲——無聲截斷會讓後面的偏好靜默失效,
# 對交易 agent 是實質風險:
#   - 超過 SOFT cap:全文照注,但附一行指令要 agent 本輪先整理再繼續。
#   - 超過 HARD cap(失控寫爆):截斷保護 context,並在注入文字裡明講已截斷。
PREFERENCES_PATH = os.path.join(WORKSPACE, "state", "preferences.md")
PREFS_SOFT_CAP_CHARS = 4000
PREFS_HARD_CAP_CHARS = 16000

_PREFS_HOWTO = (
    "\n\n---\n\n"
    "## 用戶常駐偏好（本 runtime 專屬規則）\n"
    "使用者表達**常駐**偏好時（「以後都…」「記住…」「每次建策略都…」），"
    f"把它改寫成一條明確、可執行的規則，寫進 `{PREFERENCES_PATH}`"
    "（Markdown 條列，每條一句、一行），並回覆確認你記住了什麼。規則：\n"
    "- 上限 10 條、總量 4000 字以內（精簡措辭）。每次寫入時順手整理：合併重複、"
    "刪除被新偏好取代或已過期的條目。\n"
    "- 只收使用者明確表達的常駐偏好。一次性指示不算；任務進度歸 state/notes/，"
    "不要寫進來。\n"
    "- 偏好是**預設值，不是鐵律**：位階低於本 system prompt 的其他規則"
    "（安全與煞車規則絕不因偏好放寬）。與當下策略邏輯衝突時"
    "（例如組合型策略沒有單筆停損可做），明講衝突並問使用者——不要硬套，"
    "也不要無聲忽略。\n"
    "- 使用者問「你記了哪些偏好」就照檔案內容唸；要求修改或刪除就直接改檔。\n"
    # 語言寫成偏好條目會被回覆語言設定(尾端錨)靜默蓋掉,使用者以為記住了其實沒生效
    "- **回覆語言不是常駐偏好，不要寫進這個檔**：使用者要固定回覆語言（「以後用英文回」"
    "「請用簡體」「用韓文回答」）時，寫進 "
    f"`{strategy_reporter.REPLY_LANG_PATH}`（只有一行、用 UTF-8 寫入）：七種之一寫代碼"
    "（zh=繁體中文、cn=簡體中文、en、es、pt、vi、ja）；七種以外寫 "
    f"`{strategy_reporter.REPLY_LANG_CUSTOM_PREFIX}<語言名稱>`"
    f"（例如 `{strategy_reporter.REPLY_LANG_CUSTOM_PREFIX}한국어`，"
    f"{strategy_reporter.REPLY_LANG_CUSTOM_MAX} 字以內）。"
    "使用者要「跟著我打的語言回」時，把這個檔清空（= 自動）。"
    "回覆時告訴使用者：從下一則回覆起生效，網頁的設定面板也會顯示這個設定。\n"
    # web 的設定面板整檔 replace 這個檔(command_listener._cmd_preferences_set),
    # 只寫得出條列行。agent 寫的標題或段落會在使用者存檔的那一刻被洗掉——所以要在
    # 這裡先講,不要讓兩邊各寫各的格式然後互相刪。
    "- 這個檔的內容也會出現在網頁介面上、使用者可以在那裡直接編輯，"
    "而網頁只寫得出條列行：所以你寫進來的**只准是條列行**，"
    "不要寫標題、段落或說明文字（會被使用者的下一次存檔洗掉）。\n"
)


def preferences_rule():
    """每輪重讀:偏好的寫入規則(常駐,讓 agent 知道要記)+ 目前偏好內容。"""
    try:
        # encoding 明寫:這個檔是 agent 在對話中寫入的 UTF-8 中文,Windows 機
        # 的 locale 預設(cp950)會 UnicodeDecodeError,而那不是 OSError。
        with open(PREFERENCES_PATH, encoding="utf-8") as f:
            # 有界讀取:hard cap 防的就是失控寫爆,先整份 read() 會在 cap 檢查
            # 之前把巨檔吞進記憶體(4GB 機、有 OOM 前科)。多讀 1 字元足以判定
            # 超限,MemoryError 也就不可能發生。
            content = f.read(PREFS_HARD_CAP_CHARS + 1).strip()
    except FileNotFoundError:
        content = ""
    except (OSError, UnicodeDecodeError) as e:
        # 讀壞掉(權限/IO)不能讓整輪死,但也不能裝作沒有偏好——明講讀不到。
        print(f"[agent_turn] WARNING: preferences unreadable: {e}", file=sys.stderr)
        return _PREFS_HOWTO + "\n[偏好檔目前讀取失敗，本輪先不套用，並向使用者說明。]\n"
    over_hard = len(content) > PREFS_HARD_CAP_CHARS
    # 跟 session_store._sanitize_summary 同一道防線:這段內容進的是 system
    # prompt,夾帶鷹架標記的行會偽造假對話區塊(agent 照唸偏好時也會被
    # strip_hallucinated_turn 砍斷回覆)。逐行剝掉,不截斷。
    content = "\n".join(
        line for line in content.splitlines()
        if not ss.SCAFFOLD_RE.match(line) and not line.startswith("<<<")
    ).strip()
    if not content:
        return _PREFS_HOWTO + "\n（目前沒有任何常駐偏好。）\n"
    parts = [_PREFS_HOWTO, "\n[目前的常駐偏好——建策略/下單/回測時都要套用或明講衝突]\n"]
    if over_hard:
        parts.append(content[:PREFS_HARD_CAP_CHARS])
        parts.append(
            "\n\n[警告：偏好檔大小失控，以上內容已被截斷。本輪先把 "
            "preferences.md 整理回 10 條、總量 4000 字以內（向使用者確認要留哪些），"
            "再處理訊息。]\n"
        )
        try:
            size = os.path.getsize(PREFERENCES_PATH)
        except OSError:
            size = -1
        print(
            f"[agent_turn] WARNING: preferences.md over hard cap "
            f"({size} bytes on disk), truncated",
            file=sys.stderr,
        )
    elif len(content) > PREFS_SOFT_CAP_CHARS:
        parts.append(content)
        parts.append(
            "\n\n[注意：偏好檔已超過建議大小。本輪先把 preferences.md 整理回 "
            "10 條、總量 4000 字以內（精簡措辭、合併重複、刪過期；拿不準就問"
            "使用者），再處理訊息。]\n"
        )
    else:
        parts.append(content)
        parts.append("\n")
    return "".join(parts)


# Shared across all surfaces: the model tends to narrate its own process as
# user-facing text ("Let me check...", "Now I will...") — that's internal
# reasoning, not something the user needs to read. Kept out of AGENTS.md
# because it's a property of THIS runtime's chat surfaces, not a universal
# quant rule.
_NO_NARRATION = (
    "不要寫「Let me check...」「Now I will...」這類自言自語的執行過程當作正式內容——"
    "那些是內部推理，不是要給用戶看的話。只留使用者真正需要看到的內容"
    "（結果、發現、決定、簡短的下一步提示），跳過「我正在做什麼」的旁白。"
)

# Telegram uses LEGACY Markdown (single-asterisk bold) and cannot render
# tables at all; each text segment becomes its own message bubble.
# 兩個 sink 共用的回覆風格(語法各自另訂)。長度紀律一定要兩邊都掛——
# 只掛 web 的結果就是 TG 上問一句「台積電多少」回 15 行全套報價(實測)。
_STYLE_RULES = (
    "回覆風格：\n"
    "- 回覆語言以使用者訊息**尾端那條語言指示**為準——它指定哪個語言就整則用那個語言,"
    "不要被本規則的中文或對話歷史帶偏。"
    "(IMPORTANT: the reply language is set by the language instruction at the very end "
    "of the user's message — follow it for the whole reply. These rules being written "
    "in Chinese does NOT make Chinese the default.)\n"
    "- 預設精簡、先講結論：日常問答 1–5 行(問價格就報價格,不用附整套盤面)、"
    "一般回覆 3–8 行；使用者要細節或分析再展開。\n"
    "- 程式碼一律寫進檔案,不貼在對話裡;片段以 10 行為上限。\n"
    "- 回測結果只報關鍵數字(報酬、Sharpe、最大回撤、勝率這類挑 3–4 個)。\n"
    "- 不要向使用者敘述內部探索過程或背景任務狀態。\n"
    "- 使用者看不到檔案系統,別對他列目錄或路徑;指涉用「左側策略頁」「回測分頁」。\n"
)

TELEGRAM_FORMATTING_RULE = (
    "\n\n---\n\n"
    "## Telegram 輸出格式（本 runtime 專屬規則）\n"
    "回覆會用 Telegram 的 legacy Markdown 解析送出，語法跟一般 Markdown不同：\n"
    "- 粗體用單星號 *文字*（不是 **文字**）\n"
    "- 斜體用底線 _文字_\n"
    "- 代碼用反引號 `文字`\n"
    "- 不支援標題（#）、不支援表格（|）—表格一律改成清單（- 開頭）或分行條列\n"
    "段落之間適時空行，不要擠成一大塊。\n\n"
    "**每個文字段落之間會各自變成一則獨立 Telegram 訊息**（工具呼叫前後會分開送）。\n\n"
    + _STYLE_RULES
    + _NO_NARRATION
)

# 導航指引(web 專屬;WebSink 段首攔截成 ui_nav chunk)。放在建議規則前一段:
# 建議規則必須維持 system prompt 最尾端(recency)。
_NAV_RULE = (
    "\n\n---\n\n"
    "## 導航指引（回覆第一行）\n"
    "用戶要你帶他做部署類操作（「帶我看怎麼…」這類導航句，或直接問怎麼上模擬盤／"
    "設金額／綁交易所／啟動下單）時，回覆的**第一行**單獨放一個標記，系統會替用戶把"
    "自動下單頁開到對的位置，接著才給步驟：\n"
    "- 設定部位金額、把策略部署上模擬盤／實盤 → `<nav>portfolio.pos</nav>`\n"
    "- 綁定模擬盤或交易所（含換金鑰） → `<nav>portfolio.venue</nav>`\n"
    "- 啟動／恢復下單 → `<nav>portfolio.run</nav>`\n"
    "一次只放一個、只放第一行、只用這三個值；不是在帶操作（純解釋、討論）就不要放。"
    "標記之後直接接步驟（≤4 步，照 references/portfolio-steps.md、UI 標籤原文），"
    "正文不要提到標記本身。\n"
)

# 建議下一步(web 專屬;extract_suggestions 在 finalize 剝離)。放在 system prompt
# append 的最尾端——實測 deepseek-v4-pro 對埋在中段的這條規則不服從(2026-08-24
# 29026 e2e:回測完成沒附區塊、用問句收尾),弱模型對 prompt 尾端的服從度最高;
# 「禁止問句提議收尾」是把模型自己的競爭習慣堵掉,不是風格潔癖。
_SUGGEST_RULE = (
    "\n\n---\n\n"
    "## 建議下一步（每輪回覆前必檢查）\n"
    "寫完回覆後，檢查這一輪是否命中里程碑：\n"
    "- 剛建立/修改策略、還沒回測 → 建議跑回測\n"
    "- 剛完成回測且結果可用 → 建議上模擬盤（paper）\n"
    "- 正在總結／分析／回報某支已有可用回測、還沒部署的策略（問它表現、值不值得用、"
    "要摘要）→ 必附：建議把該策略上模擬盤，或給一個具體的優化方向（見下面「優化選項」）；"
    "用戶明顯還在迭代改進中就只給優化方向、不提部署\n"
    "- 模擬盤已穩定跑一段時間且執行無異常 → 建議小額實盤\n"
    "- 用戶想實際跑但還沒綁任何交易所 → 建議先綁模擬盤\n"
    "命中時，回覆**必須以 <suggest> 區塊結尾**（其後不得再有任何文字），格式：\n"
    "<suggest>\n帶我看怎麼把〈策略名〉上模擬盤\n</suggest>\n"
    "一行一個建議、最多 3 個（通常 1 個就好）；句子＝用戶口吻的短指令"
    "（動詞＋對象＋必要參數），點了會替用戶原句送出。"
    "部署類建議（上模擬盤、小額實盤、綁定——含 paper）是**導航句**：固定以"
    "「帶我看怎麼」起手，點了你回操作步驟、不代做（部署由用戶親手在自動下單頁操作）；"
    "分析／回測類維持一般執行句。"
    "提到策略時用它的名稱（strategy.py 檔頭 # Strategy: 那行，或用戶慣稱），"
    "不要用底線目錄代號（寫「把 BTC 4h 均線交叉上模擬盤」，"
    "不寫「把 btc_ma_cross_4h 上模擬盤」）。"
    "\n優化選項（只在給優化方向時用，挑最相關的**一個**；只對還沒部署的策略提，"
    "已在跑的要改就講明另開一支）：\n"
    "‧ 參數是手挑的、沒驗過穩不穩 → 掃參數找穩定區（plateau）："
    "「掃一下〈策略名〉的參數，看有沒有穩定區」；策略資料夾已有 scan.json，"
    "或這輪就是採用掃出的穩健參數重跑回測 → 不要再提掃參數，改提別的方向或不提\n"
    "‧ MCPT p-value > 0.05（Type A 回測自動算、stats.json 已有，不要建議「跑 MCPT」）→ "
    "訊號本身沒優勢：建議加濾網或換訊號，不要建議調參數硬拉\n"
    "‧ 部位固定、波動或回撤起伏大 → 依實現波動調整部位（vol targeting，單一標的"
    "的策略適用；低波動時部位會放大，上限 VOL_CAP，提的時候講明）："
    "「幫〈策略名〉加 vol targeting 調部位」\n"
    "‧ 訊號雜訊多、假訊號一堆 → 加濾網（趨勢／波動／時段）："
    "「幫〈策略名〉加一個趨勢濾網」\n"
    "**下一步的提議只能放在 <suggest> 區塊——禁止在正文結尾用問句提議"
    "（「要不要我幫你…？」「需要我再…嗎？」這類收尾不要寫，改放 <suggest>）。**\n"
    "沒命中里程碑、但你想在結尾提議下一步（「要不要我再拉 4h？」「需要補籌碼面嗎？」"
    "這類話）——**一律把那個提議改寫成 <suggest> 區塊**（1–2 個、用戶口吻），"
    "正文不留問句；優先挑往策略／回測方向推進的提議。"
    "純寒暄或一句話問答（打招呼、問單一價格）連提議都不用、直接收尾。\n"
    "建議句的語言跟正文一致：用戶用英文，區塊內每一行都用英文，導航句以"
    "「Show me how to」起手（例：Show me how to paper trade 〈strategy name〉）。\n"
    "中文建議句的逗號、分號、驚嘆號、問號一律全形（，；！？），不要半形；"
    "英文句用英文標點。\n"
    "區塊內禁止：形容詞副詞（最強、輕鬆、高勝率）、收益承諾（開始獲利、躺賺）、"
    "催促（立即、馬上、別錯過）、emoji；策略名與數字必須真實存在。"
    "用戶**明確拒絕**過的建議（「不要」「先不上」），同一階段不要重提；只是沒點、沒回應"
    "不算拒絕——到下一個里程碑（回測重跑、換一支策略、回頭再問）可以再提，"
    "但連續兩輪不要貼一模一樣的句子（換角度或換動詞，例如「上模擬盤」→「先綁模擬盤帳戶」）。\n"
)

# Web renders standard Markdown in the browser — tables, headings, and
# double-asterisk bold all work, so no legacy-syntax constraints.
WEB_FORMATTING_RULE = (
    "\n\n---\n\n"
    "## 網頁輸出格式（本 runtime 專屬規則）\n"
    "回覆顯示在工作區的聊天欄（窄欄、旁邊就是程式碼/回測分頁），語法規則：\n"
    "- 不要用 # 標題（聊天泡泡裡太重），要分段就用**粗體行**；"
    "可用 **粗體**、清單、`行內程式碼`；表格僅限小型。\n"
    "- 建立/修改策略後說一句「程式碼在左側策略頁」即可；"
    "回測細節請使用者看回測分頁。\n\n"
    + _STYLE_RULES
    + _NO_NARRATION
    + _NAV_RULE
    + _SUGGEST_RULE
)


# Prompting alone doesn't reliably stop the model from emitting Markdown
# tables (observed in practice — the instruction was in the system prompt
# and it still happened). Telegram genuinely cannot render tables no matter
# what, so this is enforced in code instead of relying on the model to obey.
def _is_table_row(line):
    s = line.strip()
    return s.startswith("|") and s.endswith("|") and s.count("|") >= 2


def _is_table_separator(line):
    s = line.strip()
    if not (s.startswith("|") and s.endswith("|")):
        return False
    cells = s.strip("|").split("|")
    return bool(cells) and all(re.fullmatch(r"\s*:?-+:?\s*", c) for c in cells)


def _parse_row(line):
    return [c.strip() for c in line.strip().strip("|").split("|")]


def convert_markdown_tables_to_list(text):
    lines = text.split("\n")
    out = []
    i = 0
    while i < len(lines):
        if _is_table_row(lines[i]) and i + 1 < len(lines) and _is_table_separator(lines[i + 1]):
            headers = _parse_row(lines[i])
            i += 2
            while i < len(lines) and _is_table_row(lines[i]):
                cells = _parse_row(lines[i])
                if len(headers) == 2:
                    # "指標 | 數值" style tables read better as "項目: 值"
                    # than repeating the column header on every row.
                    out.append(f"- {cells[0]}: {cells[1]}" if len(cells) >= 2 else "- " + cells[0])
                else:
                    parts = [f"{h}: {c}" if h else c for h, c in zip(headers, cells)]
                    out.append("- " + "，".join(parts))
                i += 1
        else:
            out.append(lines[i])
            i += 1
    return "\n".join(out)


def tg_api(token, method, params, timeout=15):
    url = f"https://api.telegram.org/bot{token}/{method}"
    data = json.dumps(params).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


class TelegramStreamer:
    """Sends the reply as it accumulates: the FIRST call with real text does
    a plain sendMessage (no empty placeholder bubble — the typing indicator
    already covers the "something is happening" gap before any text exists);
    every subsequent call edits that same message in place. Debounced (min
    interval between edits) to stay under Telegram's edit rate limit. Falls
    back to plain text if Markdown parsing fails, rather than losing the
    update entirely."""

    MIN_EDIT_INTERVAL = 2.5

    def __init__(self, token, chat_id):
        self.token = token
        self.chat_id = chat_id
        self.message_id = None
        # monotonic,理由同 WebSink._last_flush:量的是編輯間隔,wall clock 被 NTP
        # 往前 step 的話這則泡泡會停在半途不再更新。
        self.last_edit_at = float("-inf")
        self.last_sent_text = None

    def discard(self):
        """收回這則串流中的訊息(內容被判定為旁白)。已送出就刪掉,還沒送出就無事。"""
        if self.message_id is None:
            return
        try:
            tg_api(self.token, "deleteMessage",
                   {"chat_id": self.chat_id, "message_id": self.message_id})
        except Exception as e:
            print(f"[telegram] discard failed: {e}", file=sys.stderr)
        self.message_id = None
        self.last_sent_text = None

    def _send_with_fallback(self, method, text, extra):
        try:
            return tg_api(self.token, method, {**extra, "text": text, "parse_mode": "Markdown"})
        except urllib.error.HTTPError as e:
            if e.code == 400:
                # Model's Markdown didn't parse cleanly — better a plain
                # message than a dropped update.
                return tg_api(self.token, method, {**extra, "text": text})
            raise

    def update(self, text, force=False):
        if not self.token or not self.chat_id or not text:
            return
        now = time.monotonic()
        if self.message_id and not force and (now - self.last_edit_at) < self.MIN_EDIT_INTERVAL:
            return
        # 表格轉條列在節流閘「之後」才做:逐 token 串流時一段回覆會呼叫 update 幾百
        # 次,其中 99% 會被上面擋掉,沒必要為了丟棄的結果把全文重掃一遍。轉換冪等
        # (轉出來的條列不再是表格列),所以已經轉過的 finalize 路徑再跑一次也不變形。
        text = convert_markdown_tables_to_list(text)
        if text == self.last_sent_text:
            return
        try:
            if self.message_id is None:
                resp = self._send_with_fallback("sendMessage", text, {"chat_id": self.chat_id})
                self.message_id = resp["result"]["message_id"]
            else:
                self._send_with_fallback(
                    "editMessageText", text,
                    {"chat_id": self.chat_id, "message_id": self.message_id},
                )
            self.last_edit_at = now
            self.last_sent_text = text
        except Exception as e:
            print(f"[agent_turn] telegram send/edit failed: {e}", file=sys.stderr)

    def finish(self, text):
        self.update(text, force=True)


async def _typing_loop(token, chat_id):
    # Telegram's typing indicator only lasts ~5s — refresh every 4s for the
    # whole turn (independent of the message-bubble/segment logic above; it
    # covers gaps too, e.g. while a tool call is running and no text bubble
    # is being edited). Best-effort: a failed sendChatAction shouldn't kill
    # the turn.
    if not token or not chat_id:
        return
    while True:
        try:
            tg_api(token, "sendChatAction", {"chat_id": chat_id, "action": "typing"})
        except Exception as e:
            print(f"[agent_turn] typing indicator failed: {e}", file=sys.stderr)
        await asyncio.sleep(4)


class TelegramSink:
    """Delivery sink for Telegram. Encapsulates the edit-one-bubble streaming,
    the table-to-list conversion, and the "start a new bubble after each tool
    call" segmentation (so our own bubbles interleave in true chronological
    order with any side-channel photo sends lib/notify does mid-turn)."""

    formatting_rule = TELEGRAM_FORMATTING_RULE

    def __init__(self, token, chat_id):
        self.token = token
        self.chat_id = chat_id
        self.segments = []
        self.chunk_text = ""
        self.streamer = TelegramStreamer(token, chat_id)
        self.pending_new_bubble = False
        self._last_status = ""
        self.typing_task = None

    async def start(self):
        self.typing_task = asyncio.create_task(_typing_loop(self.token, self.chat_id))

    def on_text(self, delta):
        if self.pending_new_bubble:
            self.streamer.finish(self.chunk_text)
            self.segments.append(self.chunk_text)
            self.chunk_text = ""
            self.streamer = TelegramStreamer(self.token, self.chat_id)
            self.pending_new_bubble = False
        self.chunk_text += delta
        self.streamer.update(self.chunk_text)

    def on_tool(self, block):
        # 同 WebSink:後面還有工具呼叫的文字段是旁白。TG 是邊打邊編輯同一則訊息,
        # 所以要把已經送出的那則刪掉,否則旁白會變成一堆零碎訊息。
        if self.chunk_text.strip():
            self.streamer.discard()
            self._last_status = self.chunk_text
            self.chunk_text = ""
            self.streamer = TelegramStreamer(self.token, self.chat_id)
            self.pending_new_bubble = False
            return
        self.pending_new_bubble = True

    def on_tool_result(self, block):
        # TG 沒有收據那個表面(它是編輯同一則泡泡)。必須存在:run_turn 對 sink
        # 多型呼叫,少一個方法就是 AttributeError → 整個回合掉進 except → 每個用到
        # 工具的 TG 回合都回「處理這則訊息時發生錯誤」。
        pass

    def on_status(self, text):
        # 過場旁白(帶工具呼叫的訊息裡的文字)——TG 沒有狀態列,直接不送,
        # 免得旁白變成一堆零碎訊息。留著當空回覆時的備援。
        self._last_status = text

    def on_thinking(self, block):
        # Telegram has no "thinking" surface — reasoning is ignored here (it's
        # already kept out of the reply text by the no-narration system prompt).
        pass

    def set_error(self, text, code=None):
        # Replace the in-progress chunk with the error message. `code` 是 web 面
        # 用來挑 i18n 字串的分類欄位;TG 沒有那一層(這裡的文字就是用戶收到的
        # 泡泡),簽名收下但不使用——兩個 sink 對 run_turn 是同一個介面。
        self.chunk_text = text

    def has_reply(self):
        """這一輪有沒有真正的回覆文字(旁白 _last_status 不算)。run_turn 的空回合判定。"""
        return bool(self.chunk_text.strip() or any(s.strip() for s in self.segments))

    async def stop(self):
        if self.typing_task:
            self.typing_task.cancel()

    def finalize(self):
        cleaned, cut = strip_hallucinated_turn(self.chunk_text)
        if cut:
            print("[agent_turn] 截掉模型續寫的假對話回合", file=sys.stderr)
        # TG 面沒有建議列規則,但防禦性剝除(模型偶發混淆時 raw 標記不能露出)。
        cleaned, _ = extract_suggestions(cleaned)
        cleaned = _EXPORT_STRIP_RE.sub("", cleaned)
        cleaned = _NAV_STRIP_RE.sub("", cleaned)
        self.chunk_text = cleaned
        self.chunk_text = convert_markdown_tables_to_list(self.chunk_text)
        self.streamer.finish(self.chunk_text)
        self.segments.append(self.chunk_text)
        reply = "\n\n".join(s for s in self.segments if s)
        if not reply and getattr(self, "_last_status", ""):
            # 極端情況:模型把話全講在帶工具的訊息裡、最後一則沒有純文字——
            # 用最後一句旁白當回覆,別讓用戶收到空氣。
            reply = convert_markdown_tables_to_list(self._last_status)
            self.streamer.finish(reply)
        return reply


# One keep-alive connection, reused for every chunk of the turn. urllib opens a
# fresh one per call; on this path (29026, same region as api.blave.org) a POST
# costs 12.2ms cold vs 5.5ms warm — 6.7ms of TLS+TCP per chunk. Streaming turns
# measured 7-50 chunks, so the connection now opens once instead of once per
# chunk. Single connection, no lock: WebSink is only ever driven from run_turn's
# one task (the Telegram sink's typing loop uses tg_api, not this).
_report_conn = {"key": None, "conn": None}
# Connection-level failures, i.e. the peer tore the connection down instead of
# answering. Usually a stale keep-alive (the server or nginx closed an idle
# connection before our request reached the application), in which case a replay
# is exactly right; but the same errors can also fire after the server processed
# the chunk, and then the replay puts that text in the bubble twice. Retried
# anyway: a duplicated delta is a cosmetic dent, a dropped one is a permanent
# hole in the reply. The `answered` flag keeps the window to "we never saw a
# response". The SSL pair is the same event one layer up — a TLS close_notify
# surfaces as ssl.SSLEOFError/SSLZeroReturnError (an OSError, NOT a
# ConnectionResetError), so without them a proxy that closes politely would drop
# the chunk. Anything else — including any HTTP status — is NOT retried.
_REPORT_RETRYABLE = (http.client.BadStatusLine, http.client.RemoteDisconnected,
                     ConnectionResetError, BrokenPipeError,
                     ssl.SSLEOFError, ssl.SSLZeroReturnError)


def _close_report_connection():
    conn, _report_conn["conn"], _report_conn["key"] = _report_conn["conn"], None, None
    if conn is not None:
        try:
            conn.close()
        except Exception:
            pass


def _report_connection(url, timeout):
    parts = urllib.parse.urlsplit(url)
    key = (parts.scheme, parts.hostname, parts.port)
    if _report_conn["key"] != key:
        _close_report_connection()
    if _report_conn["conn"] is None:
        cls = (http.client.HTTPSConnection if parts.scheme == "https"
               else http.client.HTTPConnection)
        _report_conn["conn"] = cls(parts.hostname, parts.port, timeout=timeout)
        _report_conn["key"] = key
    path = parts.path or "/"
    if parts.query:
        path = f"{path}?{parts.query}"
    return _report_conn["conn"], path


def _post_report(report_url, token, chunk, timeout=15):
    """POST one chunk to the web-chat transport (api/openclaw/webchat.py
    /report). Best-effort: a failed report shouldn't crash the turn."""
    data = json.dumps(chunk).encode()
    headers = {"Content-Type": "application/json", "x-api-key": f"proxy-{token}",
               "Content-Length": str(len(data))}
    for attempt in (1, 2):
        answered = False
        try:
            conn, path = _report_connection(report_url, timeout)
            conn.request("POST", path, body=data, headers=headers)
            resp = conn.getresponse()
            answered = True  # past this point the server HAS seen the chunk
            body = resp.read()  # must drain before the connection can be reused
            if resp.will_close:
                _close_report_connection()
            if resp.status >= 400:
                print(f"[agent_turn] web report failed: HTTP {resp.status}", file=sys.stderr)
                return None
            return json.loads(body)
        except Exception as e:
            _close_report_connection()  # never reuse a connection that just failed
            if attempt == 1 and not answered and isinstance(e, _REPORT_RETRYABLE):
                continue
            print(f"[agent_turn] web report failed: {e}", file=sys.stderr)
            return None


# How long text deltas may accumulate before a POST. Small enough to read as
# live typing, large enough that a 68-delta/second stream is ~4 requests/second
# instead of 68.
TEXT_FLUSH_INTERVAL = 0.25


# 行內環境變數賦值(`FOO=1 python3 x.py`)——摘要要的是被跑的東西,不是它的環境。
_BASH_ENV_PREFIX_RE = re.compile(r"^(?:\w+=\S+\s+)+")
# 指令裡唯一真正有顯示價值的東西:workspace 底下的腳本與策略檔。agent 的指令絕大
# 多數是 `python3 lib/param_scan.py strategies/xxx/strategy.py` 這個形狀。比「開頭是」
# 不是「包含」——`/usr/lib/…`、`/var/lib/…`、`/lib/x86_64-linux-gnu/…` 都含 `lib/`,
# 用包含判定會把 pip / ldd / find 的系統路徑當成腳本檔。
_SCRIPT_PREFIXES = ("lib/", "strategies/")
# 整段程式塞在參數裡:內容是模型自己寫的字串,可能很長又沒有顯示價值,整列不給
# summary。只認直譯器後面的旗標——`head -c 100 AGENTS.md` 的 -c 是位元組數,那列
# 該照常有受詞。
_INTERPRETERS = ("python", "python3", "node", "bash", "sh", "zsh", "perl", "ruby")
_INLINE_CODE_FLAGS = ("-c", "-e", "--command")
TOOL_SUMMARY_MAX = 100
TOOL_SUMMARY_BASH_MAX = 40  # 452px 的聊天欄裡一列放得下的 mono 長度


def _tool_summary(name, params, workspace=None):
    """工具呼叫的「受詞」:讓活動列從「執行中」變成「讀取 lib/data.py」。

    只從 ToolUseBlock.input 就地推導,不解析工具輸出;Bash 永遠不送完整指令
    (見 _bash_summary)。"""
    if not isinstance(params, dict):
        return ""
    out = ""
    if name in ("Read", "Write", "Edit"):
        path = params.get("file_path")
        if isinstance(path, str) and path:
            out = _workspace_relative(path, workspace)
    elif name == "Bash":
        out = _bash_summary(params.get("command"), workspace)
    elif name in ("Grep", "Glob"):
        pattern = params.get("pattern")
        if isinstance(pattern, str):
            out = pattern.strip()
    return out[:TOOL_SUMMARY_MAX]


def _bash_summary(cmd, workspace=None):
    """Bash 指令的受詞:被跑的腳本/策略檔,最多兩個路徑 token。

    不是「前兩個 token」——實測(29026 2026-09-04)`head -n 10 AGENTS.md` 會摘成
    `head -n`,而 agent 的指令大量帶旗標,收據會變成一排沒有受詞的 `grep -rn`。
    也不送完整指令:那會把模型自己組的字串原樣送進瀏覽器,長度換不到資訊。"""
    if not isinstance(cmd, str):
        return ""
    cmd = _BASH_ENV_PREFIX_RE.sub("", cmd.strip())
    tokens = cmd.split()
    if not tokens or "<<" in cmd or _has_inline_code(tokens):
        return ""
    paths = []
    for tok in tokens:
        path = _script_path(tok, workspace)
        if path:
            paths.append(path)
            if len(paths) == 2:
                break
    if paths:
        return _cut(" ".join(paths), TOOL_SUMMARY_BASH_MAX)
    # 退路:指令名 + 第一個非旗標參數(`head -n 10 AGENTS.md` → `head AGENTS.md`)。
    # 短旗標連同下一個 token 一起跳過(它多半是該旗標的 value:`-n 10`);長旗標只跳
    # 自己,因為它的 value 慣例是 `--opt=value`——把後面那個 token 也吃掉會讓
    # `git --no-pager log` 變成沒有意義的 `git 5`(實測)。
    out, rest, i = tokens[0], tokens[1:], 0
    while i < len(rest):
        if rest[i].startswith("-"):
            i += 2 if re.fullmatch(r"-\w+", rest[i]) else 1
            continue
        out += " " + rest[i]
        break
    return _cut(out, TOOL_SUMMARY_BASH_MAX)


def _has_inline_code(tokens):
    """`python3 -c …` / `node -e …`:整段程式碼是參數,沒有可顯示的受詞。"""
    for i, tok in enumerate(tokens):
        if os.path.basename(tok) not in _INTERPRETERS:
            continue
        for nxt in tokens[i + 1:]:
            if not nxt.startswith("-"):
                break  # 直譯器後面第一個非旗標=腳本檔,那就是正常的執行
            if nxt in _INLINE_CODE_FLAGS:
                return True
    return False


def _script_path(tok, workspace=None):
    """token 是 workspace 底下的腳本/策略檔就回傳相對路徑,否則空字串。

    只有絕對路徑才問 _workspace_relative:它用 abspath,而 abspath 是相對 **cwd**
    解析的,agent_turn 的 cwd(web_bridge 起的那支是 /opt/blave-agent/current)不保證
    是 workspace——拿裸 token 去 abspath 只會得到看起來對、其實是碰巧的答案。"""
    rel = _workspace_relative(tok, workspace) if tok.startswith("/") else tok
    if rel.startswith("./"):
        rel = rel[2:]
    return rel if rel.startswith(_SCRIPT_PREFIXES) else ""


def _cut(text, limit):
    return text if len(text) <= limit else text[:limit - 1] + "…"


def _workspace_relative(path, workspace=None):
    workspace = workspace or WORKSPACE
    try:
        if os.path.commonpath([os.path.abspath(path), os.path.abspath(workspace)]) \
                == os.path.abspath(workspace):
            return os.path.relpath(path, workspace)
    except ValueError:
        # Windows 機(uid=1)不同磁碟機的路徑 commonpath/relpath 都會炸——原樣顯示。
        pass
    return path


# strategies/<seg>:前面要是字串開頭、路徑分隔或 shell 分隔字元,`my_strategies/x` 不算。
# 反斜線是 Windows 機(uid=1)的 file_path。seg 碰到 shell 變數/glob 就不收(抓不準)。
_TOUCHED_RE = re.compile(r"""(?:^|[\s/\\'"=(:;&|>])strategies[/\\]([^/\\\s'"`;&|()<>]+)""")


def _touched_strategies(name, params):
    """這個工具呼叫碰過的策略名(web 靠它認新策略是哪條對話建的)。多抓無妨,語意是
    「碰過」;抓不到(變數路徑、cp -r、腳本內部產生檔名)只會少開,不會開錯。
    排除規則同 strategy_reporter._scan_sources。"""
    if not isinstance(params, dict):
        return set()
    if name in ("Write", "Edit"):
        text = params.get("file_path")
    elif name == "Bash":
        text = params.get("command")
    else:
        return set()
    if not isinstance(text, str):
        return set()
    out = set()
    for seg in _TOUCHED_RE.findall(text):
        if seg.endswith(".py"):
            seg = seg[:-3]
        if not seg or seg.startswith((".", "TEMPLATE")) or seg == "__pycache__" \
                or any(c in seg for c in "$*?[]{}"):
            continue
        out.add(seg)
    return out


class WebSink:
    """Delivery sink for the website chat. Each text delta / tool call / end
    is a discrete chunk POSTed to /report, which the browser reads over SSE.
    Text is sent as deltas (the browser appends); the transport adds seq +
    timestamp and buffers for reconnect replay, so we just push raw deltas."""

    formatting_rule = WEB_FORMATTING_RULE

    def __init__(self, report_url, report_token, session_id):
        self.report_url = report_url
        self.report_token = report_token
        self.session_id = session_id
        self.full_text = ""
        self.error_text = None
        self.error_code = None
        # Set when the user hits Stop: /report piggybacks `interrupt: true` on its
        # response (that's the only channel that reaches this VM mid-turn), and
        # run_turn breaks at the next step boundary.
        self.interrupted = False
        # Text resuming after a tool call gets a paragraph break — without it the
        # inter-tool narration fragments glue into one wall when history replays.
        self._break_before_text = False
        self._last_status = ""
        # 目前這段文字在 full_text 裡的起點。SDK 每個 block 各自一則訊息,所以
        # 「同訊息裡有沒有 tool_use」判不出旁白;真正的訊號是「這段文字後面還有沒有
        # 工具呼叫」——有就是旁白(丟去活動列),最後那段才是回覆。
        self._seg_start = 0
        # 段首暫留:文字先扣在這裡,直到判得出「是不是 <nav> 標記」才放行
        # (nav_hold_more / split_nav_head)。None=本段段首已過。
        self._head_hold = ""
        # tool_use id -> (發出時間, 工具名)。工具結果回來時用它算耗時、補回工具名
        # (done chunk 也要帶 tool)。sink 活一個回合就丟,不需要清理。
        self._tool_t0 = {}
        self._nav_fired = False  # ui_nav 一回合最多一次(旁白段誤觸發會退還,見 on_tool)
        self._nav_fired_seg = -1  # 送出 ui_nav 時的 _seg_start
        # 逐 token 的文字要先攢起來再送。實測 deepseek 一段回覆吐 ~68 delta/秒,
        # 一個 delta 一個 POST 的話,光往返就吃掉比模型生成還多的時間(而且 /report
        # 每筆都進 Redis 的 replay buffer)。攢滿 TEXT_FLUSH_INTERVAL 才送,段落
        # 邊界(工具呼叫、回合結束)一定強制送出。
        self._pending = ""
        # monotonic:量的是「距離上次送出多久」,不是時刻。uid=1 那台 Windows Server
        # 的 NTP 會 step 時鐘,wall clock 往前跳的話 now - _last_flush 變負數,字就
        # 一路攢到工具呼叫或回合結束才出現。-inf 讓第一個 delta 一定立刻送
        # (monotonic 的原點沒有定義,不能假設它從 0 開始)。
        self._last_flush = float("-inf")

    def _send(self, chunk):
        chunk.setdefault("session_id", self.session_id)
        resp = _post_report(self.report_url, self.report_token, chunk)
        if resp and resp.get("interrupt"):
            self.interrupted = True

    async def start(self):
        pass

    def on_text(self, delta):
        if not delta:
            return
        if self._break_before_text:
            self._break_before_text = False
            if self.full_text and not self.full_text.endswith("\n") and not delta.startswith("\n"):
                delta = "\n\n" + delta
        if self._head_hold is not None:
            self._head_hold += delta
            if nav_hold_more(self._head_hold):
                return
            delta = self._release_head()
            if not delta:
                return
        self._emit_text(delta)

    def _emit_text(self, delta):
        self.full_text += delta
        self._pending += delta
        if time.monotonic() - self._last_flush >= TEXT_FLUSH_INTERVAL:
            self._flush_text()

    def _flush_text(self):
        """Send whatever text has accumulated. Safe to call with nothing pending."""
        if self._pending:
            text, self._pending = self._pending, ""
            self._send({"type": "text", "text": text})
        self._last_flush = time.monotonic()

    def _release_head(self, fire=True):
        """段首暫留結束:剝掉 <nav> 標記(fire 時白名單目標先送 ui_nav,一回合一次),
        回傳要放行的文字。"""
        held, self._head_hold = self._head_hold, None
        target, rest, stripped = split_nav_head(held)
        if stripped:
            # 標記剝掉後正文成了段首:前一段(工具呼叫前的文字)還在的話補回段落分隔
            if rest and self.full_text and not self.full_text.endswith("\n") \
                    and not rest.startswith("\n"):
                rest = "\n\n" + rest
            if fire and target and not self._nav_fired and not self.interrupted:
                self._nav_fired = True
                self._nav_fired_seg = self._seg_start
                self._send({"type": "ui_nav", "target": target})
        return rest

    def _flush_head(self, fire=True):
        """段落結束(工具呼叫/回合結束):暫留的段首不管是什麼都放行。
        fire=False 用在工具呼叫前的段落——那段是旁白(要移去活動列),它的標記只剝不
        觸發,「一回合一次」的額度留給最後的真回覆。"""
        if self._head_hold is None:
            return
        rest = self._release_head(fire=fire)
        if rest:
            self._emit_text(rest)

    def on_status(self, text):
        # 過場旁白——走 thinking 通道進「思考/活動」指示器,不進泡泡、不進歷史。
        # 用戶看得到 agent 在做什麼,但對話裡只留最後的真回覆。
        if not text:
            return
        text = _NAV_STRIP_RE.sub("", text)  # 旁白也不露標記(活動列/補位路徑都會顯示它)
        if not text.strip():
            return
        self._last_status = text
        self._send({"type": "thinking", "text": text})

    def on_tool(self, block):
        # 這段文字後面接了工具呼叫 → 是過場旁白:移出回覆本文(不進歷史),
        # 改送活動列。前端收到 tool chunk 也會把對應的文字區塊從泡泡移除。
        self._flush_head(fire=False)  # 還扣著的段首:這段是旁白,標記只剝不觸發
        # SDK 整塊送、標記到時就得決定送不送,那時還不知道後面接工具——若這段
        # (已送過 ui_nav 的)其實是旁白,把「一回合一次」的額度退還給最後的真回覆;
        # 前端同回合允許再導航一次(navArmed 到 done 才關)。
        if self._nav_fired and self._nav_fired_seg == self._seg_start:
            self._nav_fired = False
        seg = self.full_text[self._seg_start:]
        if seg.strip():
            self.full_text = self.full_text[:self._seg_start]
            self._last_status = seg
            self._send({"type": "thinking", "text": seg})
        # 這段整段被收回活動列(前端收到下面的 tool chunk 就把泡泡文字移除),
        # 還沒送出去的尾巴直接丟掉——送出去只會讓前端多刪一次。
        self._pending = ""
        self._seg_start = len(self.full_text)
        self._break_before_text = True
        self._head_hold = ""  # 新段落、新段首
        # Surface which tool is running so the UI can show a status line
        # (e.g. "跑回測中"); the frontend maps tool name -> label. `id` + `summary`
        # turn that line into one receipt row per call — `id` pairs it with the
        # `status: "done"` chunk from on_tool_result, `summary` says what was
        # touched. Both additive: an older frontend still only reads tool/status.
        name = getattr(block, "name", "")
        chunk = {"type": "tool", "tool": name, "status": "running"}
        summary = _tool_summary(name, getattr(block, "input", None))
        if summary:
            chunk["summary"] = summary
        block_id = getattr(block, "id", None)
        if block_id:
            chunk["id"] = block_id
            self._tool_t0[block_id] = (time.monotonic(), name)
        self._send(chunk)

    def on_tool_result(self, block):
        """工具結果回流(SDK 把它包在 user 訊息裡)——收據那列補上耗時/錯誤態。

        結果內容一律不外送:可能是幾 MB 的回測輸出,也可能是 agent 剛 cat 出來的
        任何東西。只送 id/tool/status/ms/error。

        `ms` 是「發出後經過」不是純執行時間:同一則 AssistantMessage 裡的平行工具
        呼叫共用同一個發出時刻,第二個工具的 ms 會含第一個的等待。前端照這個語意
        標文案。對不到 id(跨訊息遺失、被 Stop 截斷)就整個不送,讓那列停在 running,
        不畫假耗時。"""
        started = self._tool_t0.pop(getattr(block, "tool_use_id", None), None)
        if not started:
            return
        t0, name = started
        self._send({
            "type": "tool", "id": block.tool_use_id, "tool": name, "status": "done",
            "ms": max(0, int((time.monotonic() - t0) * 1000)),
            "error": bool(getattr(block, "is_error", False)),
        })

    def on_thinking(self, block):
        # The model's reasoning (SDK ThinkingBlock) — feeds the workspace's
        # "thinking" indicator, which shows only the latest step, not the whole
        # trace. Not part of the reply text (full_text) or persisted history.
        text = getattr(block, "thinking", None) or getattr(block, "text", "") or ""
        if text:
            self._send({"type": "thinking", "text": text})

    def set_error(self, text, code=None):
        self.error_text = text
        self.error_code = code

    def has_reply(self):
        """同 TelegramSink.has_reply。段首暫留(_head_hold)的字還沒進 full_text,也算。"""
        return bool((self.full_text + (self._head_hold or "")).strip())

    async def stop(self):
        pass

    def finalize(self):
        if self.error_text:
            # 炸掉的回合也要把攢著的尾巴送出去,否則泡泡裡的半截回覆會比模型
            # 真正吐出來的少最後 250ms 的字。
            self._flush_text()
            chunk = {"type": "error", "message": self.error_text}
            if self.error_code:
                # 分類欄位是附加的:舊前端只讀 message,收到未知 code 也退回原路徑。
                chunk["code"] = self.error_code
            self._send(chunk)
            return self.error_text
        self._flush_head()
        if not self.full_text and getattr(self, "_last_status", ""):
            # 模型把話全講在帶工具的訊息裡——用最後一句旁白補位,別回空氣
            # (暫留已過、直接進 full_text,標記在這裡先剝乾淨)
            self.on_text(_NAV_STRIP_RE.sub("", self._last_status))
        # 攢著的尾巴一定要送:下面的 text_replace 只在清理過的內容跟原文不同時才送,
        # 沒送的話「不需要清理的回覆」反而會少掉最後 250ms 的字。
        self._flush_text()
        # 假對話一定長在最後一段(續寫發生在回覆結尾),所以只需清這一段,
        # 並叫前端把已經串流出去的那段換成乾淨版。<suggest> 區塊同理(規則要求
        # 放在回覆最末尾),一起在這段剝離——歷史(finalize 回傳值)因此也是乾淨的。
        seg = self.full_text[self._seg_start:]
        cleaned, cut = strip_hallucinated_turn(seg)
        if cut:
            print("[agent_turn] 截掉模型續寫的假對話回合", file=sys.stderr)
        cleaned, suggestions = extract_suggestions(cleaned)
        cleaned, exports = extract_exports(cleaned)
        cleaned = _NAV_STRIP_RE.sub("", cleaned)  # 放錯位置的標記只剝不觸發
        if cleaned != seg:
            self.full_text = self.full_text[: self._seg_start] + cleaned
            self._send({"type": "text_replace", "text": cleaned})
        # 被 Stop 截斷的回合不給建議也不送轉出檔——半途的里程碑判定不可信。
        if not self.interrupted:
            for chunk in exports:
                self._send(chunk)
        if suggestions and not self.interrupted:
            self._send({"type": "suggestions", "items": suggestions})
        self._send({"type": "done"})
        return self.full_text


# Partial-message streaming, if this SDK build has it. Absent = the loop in
# run_turn silently falls back to a block at a time, i.e. the old behaviour.
_STREAM_EVENT = getattr(sdk, "StreamEvent", None)
_SUPPORTS_PARTIAL = _STREAM_EVENT is not None and "include_partial_messages" in getattr(
    sdk.ClaudeAgentOptions, "__dataclass_fields__", {}
)
# 工具結果的載體:實測(29026 2026-09-04,SDK 0.2.144)工具跑完後 stream 會吐一則
# UserMessage(parent=None、blocks=['ToolResultBlock'])。同 _STREAM_EVENT 的理由用
# getattr:少了這兩個型別的 SDK build 只是收據沒有耗時,不能讓它 NameError 掉整個回合。
_USER_MESSAGE = getattr(sdk, "UserMessage", None)
_TOOL_RESULT_BLOCK = getattr(sdk, "ToolResultBlock", None)
# 探針:開著跑一回合就會在 journalctl 列出這個 query() 設定下 stream 吐出哪些訊息
# 型別。只印類別名,不印任何 content。留著——換 SDK / 換 proxy 模型時要再驗一次。
_DEBUG_MSGS = os.environ.get("BLAVE_AGENT_DEBUG_MSGS") == "1"


class LocalSink(WebSink):
    """電腦版(本機外殼)的投遞:chunk 邏輯全部沿用 WebSink,傳輸換成 stdout
    一行一個 JSON(前綴 @@BLAVE@@,讓外殼跟雜訊輸出分得開)。外殼 spawn 這支、
    逐行讀 stdout 畫進聊天欄。沒有網路、沒有 token;v1 沒有中斷(interrupted
    永遠 False)。機器端不會走到這裡——只有 --delivery local 會建它。"""

    def __init__(self, session_id):
        super().__init__(report_url=None, report_token=None, session_id=session_id)

    def _send(self, chunk):
        chunk.setdefault("session_id", self.session_id)
        try:
            sys.stdout.write("@@BLAVE@@" + json.dumps(chunk, ensure_ascii=False) + "\n")
            sys.stdout.flush()
        except Exception:
            pass  # 外殼關掉管線也不能讓回合炸掉


def _unstreamed(text, streamed):
    """The tail of a finished TextBlock that the deltas did not already deliver,
    consuming the delta buffer that block was streamed from. Normally "" — the
    deltas are the same bytes. A block that arrives with no deltas at all
    (streaming off / unsupported) comes back whole.

    `streamed` maps stream-event block index -> text already sent, and the match
    is by content, not by index: the index is the raw API message's block index,
    which does NOT line up with a position in msg.content. This SDK build hands
    out one AssistantMessage per content block (probed on 29026: thinking arrives
    as its own message at index 0, the reply as another at index 1), so indexing
    by msg.content position looks the reply's deltas up under the wrong key,
    finds nothing, and re-sends the whole reply under the copy the user just
    watched being typed. Content matching also survives the grouped shape
    ([text, thinking, text] in one message) that indexing was meant to fix."""
    if not streamed:
        return text
    for key, sent in streamed.items():
        if sent and text.startswith(sent):
            del streamed[key]
            return text[len(sent):]
    # There were deltas, but none of them is the start of this block. Keep what
    # the user is already reading rather than risk appending a second copy of the
    # whole reply underneath it.
    print("[agent_turn] stream/block text mismatch — keeping the streamed copy",
          file=sys.stderr)
    return ""


def load_agents_md():
    # AGENTS.md is the persona/rules layer (quant assistant behavior, Type
    # A/B classification, broker attribution, etc.) — it must be present on
    # every turn, not just when the model happens to go read it itself.
    path = os.path.join(WORKSPACE, "AGENTS.md")
    try:
        with open(path) as f:
            return f.read()
    except FileNotFoundError:
        print(f"[agent_turn] WARNING: AGENTS.md not found at {path}", file=sys.stderr)
        return ""


def _maybe_push_strategies(sink, last_sig, include_newborn=False, touched=None):
    """Mid-turn: the moment the agent's tools change the strategy inventory (a new
    strategy file, a finished backtest), push the fresh list so the workspace updates
    right away instead of waiting for the whole turn to end. Live SSE chunk only (size-
    trimmed to the /report cap) — the full cache is refreshed by web_bridge at turn end.

    Runs after every tool step, so the unchanged case has to be cheap: signature()
    skips the multi-MB stats.json parse, and scan() is paid solely when something
    actually moved."""
    try:
        sig = strategy_reporter.signature(include_newborn)
    except Exception as e:
        print(f"[agent_turn] mid-turn strategy signature failed: {e}", file=sys.stderr)
        return last_sig
    if sig == last_sig:
        return last_sig
    try:
        strategies = strategy_reporter.scan(include_newborn)
    except Exception as e:
        # Keep the old signature so the next step retries this push rather than
        # silently adopting a state the workspace never received.
        print(f"[agent_turn] mid-turn strategy scan failed: {e}", file=sys.stderr)
        return last_sig
    sink._send(strategy_reporter.live_chunk(strategies, touched=touched))
    return sig


_SYSPROMPT_STALE_SEC = 6 * 3600


def _write_system_prompt_file(text):
    """Append-system-prompt goes to the CLI as a file, not an argv string.

    The SDK turns system_prompt["append"] into `--append-system-prompt <text>` on the
    claude command line. Windows CreateProcess caps the whole command line at 32,767
    chars, so the ceiling is set by AGENTS.md's size and both surfaces hit it: AGENTS.md
    grew from 26,709 (08-29) to 32,384 chars (09-03), pushing the total past the cap
    (web: + catalog 635 + preferences 453 + formatting rule 2,704; Telegram's rule is
    832 — it happened to still fit on the box that broke, but on config HEAD its total
    is 34,304, over the cap too) → WinError 206 → Python FileNotFoundError → the SDK's
    connect() reports CLINotFoundError("Claude Code not found at: ...claude.exe") and
    every turn failed (2026-09-03, uid=1 large_win). Linux has no such cap but takes
    the same path so there is one behaviour to reason about (and 40 KB less argv per
    turn). `--append-system-prompt-file` is a hidden flag verified on claude 2.1.239 /
    2.1.246 / 2.1.258 (missing file → "Append system prompt file not found"; unknown
    flags → "unknown option").

    One file per turn (telegram + web bridges can run turns concurrently), in the state
    dir the bridges already write session.db to (SYSTEM-writable on Windows); the
    caller unlinks it in its finally. That finally is skipped when the bridge kills the
    turn (web_bridge TURN_TIMEOUT proc.kill(), telegram_bridge subprocess timeout),
    OOM, or reboot, and prune_job only sweeps tmp/inbound — so stale sysprompt files
    (older than 6 h; TURN_TIMEOUT is 35 min, a concurrent turn's file is never that
    old) are swept here before creating the next one.
    """
    state_dir = strategy_reporter.STATE_DIR
    os.makedirs(state_dir, exist_ok=True)
    cutoff = time.time() - _SYSPROMPT_STALE_SEC
    try:
        for name in os.listdir(state_dir):
            if not (name.startswith("sysprompt-") and name.endswith(".md")):
                continue
            stale = os.path.join(state_dir, name)
            try:
                if os.path.getmtime(stale) < cutoff:
                    os.unlink(stale)
            except OSError as e:
                print(f"[agent_turn] 清不掉殘留的 {name}: {e}", file=sys.stderr)
    except OSError as e:
        print(f"[agent_turn] 掃 sysprompt 殘留檔失敗: {e}", file=sys.stderr)
    fd, path = tempfile.mkstemp(prefix="sysprompt-", suffix=".md", dir=state_dir)
    with os.fdopen(fd, "wb") as f:
        f.write(text.encode("utf-8"))
    return path


# ── 回合炸掉時的兜底訊息 ──────────────────────────────────────────────────────
# 四個 code 是與前端的契約(web 拿它挑 i18n 字串;未知值或缺欄位就退回既有的
# 「顯示 message」路徑,舊機器不會壞)。文案定稿在
# .claude/output/designer/mockup-chat-turn-error.html #spec §1a/§1b。
FAULT_NOT_STARTED_UPSTREAM = "not_started_upstream"
FAULT_NOT_STARTED = "not_started"
FAULT_PARTIAL = "partial"
FAULT_MAX_TURNS = "max_turns"

# 只有 5xx / 429 算「上游擋掉」。零工具的回合還涵蓋 sink 少方法的 AttributeError、
# 起 CLI 子行程失敗、proxy 回 402/403(試用額度)——那些情況說「模型服務沒有回應」
# 是假話,一律退中性句。
_API_ERROR_RE = re.compile(r"API Error: (5\d\d|429)")
# 收據摘要接進歷史文字的列數上限:收件人是下一輪的模型,列夠它判斷「做到哪」就好。
TOOL_STEPS_MAX = 12

# web 與 TG 的文案刻意分岔:web 指得到活動區的收據列(「上面是…」),TG 指不到,
# 所以第二行改成「請他打什麼字」。回覆語言解析成 cn 走下面的 FAULT_TEXT_CN,其餘非中文
# 語系退英文,不為這幾句建完整 i18n 表(web 面真正的多語言在前端,靠 code 挑字串)。
FAULT_TEXT = {
    "web": {
        FAULT_NOT_STARTED_UPSTREAM: (
            "模型服務沒有回應，你剛才那句沒有被執行。機器上什麼都沒動。",
            "The model service did not answer, so your last message never ran. Nothing on the machine changed.",
        ),
        FAULT_NOT_STARTED: (
            "這一輪沒有跑起來，你剛才那句沒有被執行。機器上什麼都沒動。",
            "This turn never started, so your last message did not run. Nothing on the machine changed.",
        ),
        FAULT_PARTIAL: (
            "這一輪中途斷了，你剛才的要求可能只做完一部分。上面是斷掉前已經執行的步驟。",
            "This turn broke off midway, so your request may be only partly done. The steps above ran before it stopped.",
        ),
        FAULT_MAX_TURNS: (
            "這一輪步驟超過上限，停在半路。上面已經執行的步驟都生效了，把要求拆小一點再問一次。",
            "This turn hit the step limit and stopped partway. The steps above took effect — ask again in a smaller step.",
        ),
    },
    "tg": {
        FAULT_NOT_STARTED_UPSTREAM: (
            "模型服務沒有回應，你剛才那句沒有被執行，機器上什麼都沒動。\n把同一句再傳一次就好。",
            "The model service did not answer — your last message never ran, and nothing on the machine changed.\nSend the same message again.",
        ),
        FAULT_NOT_STARTED: (
            "這一輪沒有跑起來，你剛才那句沒有被執行，機器上什麼都沒動。\n把同一句再傳一次就好。",
            "This turn never started — your last message did not run, and nothing on the machine changed.\nSend the same message again.",
        ),
        FAULT_PARTIAL: (
            "這一輪中途斷了，你剛才的要求可能只做完一部分。\n傳「看一下機器現在的實際狀態，只講你能確認完成的」，我核對後回報。",
            "This turn broke off midway, so your request may be only partly done.\nReply “check the machine’s current state and report only what you can confirm” and I will verify.",
        ),
        FAULT_MAX_TURNS: (
            "這一輪步驟超過上限，停在半路，前面做的都生效了。\n把要求拆小一點再傳一次。",
            "This turn hit the step limit and stopped partway; everything before that took effect.\nAsk again in a smaller step.",
        ),
    },
}

# 回覆語言解析成 cn 時用的簡體版,一字一句對應上表的中文;es/pt/vi/ja 退英文。
FAULT_TEXT_CN = {
    "web": {
        FAULT_NOT_STARTED_UPSTREAM: "模型服务没有响应，你刚才那句没有被执行。机器上什么都没动。",
        FAULT_NOT_STARTED: "这一轮没有跑起来，你刚才那句没有被执行。机器上什么都没动。",
        FAULT_PARTIAL: "这一轮中途断了，你刚才的要求可能只做完一部分。上面是断掉前已经执行的步骤。",
        FAULT_MAX_TURNS: "这一轮步骤超过上限，停在半路。上面已经执行的步骤都生效了，把要求拆小一点再问一次。",
    },
    "tg": {
        FAULT_NOT_STARTED_UPSTREAM: "模型服务没有响应，你刚才那句没有被执行，机器上什么都没动。\n把同一句再传一次就好。",
        FAULT_NOT_STARTED: "这一轮没有跑起来，你刚才那句没有被执行，机器上什么都没动。\n把同一句再传一次就好。",
        FAULT_PARTIAL: "这一轮中途断了，你刚才的要求可能只做完一部分。\n传「看一下机器现在的实际状态，只讲你能确认完成的」，我核对后回报。",
        FAULT_MAX_TURNS: "这一轮步骤超过上限，停在半路，前面做的都生效了。\n把要求拆小一点再传一次。",
    },
}


def _fault_code(exc, tool_calls, result_info=None):
    """兜底例外 + 這一輪跑過幾個工具 → 四個 code 之一。

    判定順序寫死:先 max_turns 再看工具數。撞上限的回合一定跑過工具,順序反過來
    就永遠出不了 max_turns(它也是 partial 家族,只是有更精確的說法)。

    欄位一律 getattr 取,不用 isinstance(e, sdk.ResultError):那個類別是 SDK
    0.2.14x 才有的,舊 build 上做型別判定會讓分類本身炸掉。result_info 是迴圈裡
    抄下來的最後一則錯誤 ResultMessage(SDK 先把它送出來、才拋例外),連沒有
    ResultError 的 build 都拿得到 is_error / api_error_status / result。"""
    info = result_info or {}
    text = str(exc)
    subtype = getattr(exc, "subtype", None) or info.get("subtype")
    reason = getattr(exc, "terminal_reason", None) or info.get("terminal_reason")
    # 結構化欄位優先;字串比對是 CLI 自帶文案(現行 "Reached maximum number of
    # turns (N)"),換 CLI 版本要回歸驗一次——驗不過會退成 partial,降級是安全的。
    if subtype == "error_max_turns" or reason == "max_turns" \
            or "maximum number of turns" in text.lower():
        return FAULT_MAX_TURNS
    if tool_calls > 0:
        return FAULT_PARTIAL
    status = getattr(exc, "api_error_status", None)
    if not isinstance(status, int):
        status = info.get("api_error_status")
    if isinstance(status, int) and (status >= 500 or status == 429):
        return FAULT_NOT_STARTED_UPSTREAM
    if _API_ERROR_RE.search(text) or _API_ERROR_RE.search(info.get("result") or ""):
        return FAULT_NOT_STARTED_UPSTREAM
    return FAULT_NOT_STARTED


def _fault_message(code, message, surface, lang=None):
    zh, en = FAULT_TEXT[surface][code]
    if lang == "cn":
        return FAULT_TEXT_CN[surface][code]
    if lang:
        return zh if lang == "zh" else en
    return zh if _is_zh(message) else en


def _fault_receipt_suffix(steps):
    """partial / max_turns 時,接在寫進 session sqlite 的 assistant 文字後面的收據摘要。

    收件人是**下一輪的模型**,不是用戶:run_turn 每輪開新 CLI session,這一輪的工具
    呼叫不在 ss.get_context() 的 role/content 純文字裡,少了這行,用戶按「確認做到哪」
    時模型只能憑空回想。用戶看不到它——web 面用戶讀的是 api 那份 Redis 歷史,TG 面
    這行是在 finalize 把泡泡送出去之後才接上的。"""
    if not steps:
        return ""
    shown = [" ".join(x for x in step if x) for step in steps[:TOOL_STEPS_MAX]]
    more = len(steps) - len(shown)
    if more > 0:
        shown.append(f"…另有 {more} 步")
    return "\n[中斷前已執行:" + "、".join(shown) + "]"


TURN_MAX_TURNS = 50
TURN_MAX_BUDGET_USD = 10

# 空回合自動續跑。DeepSeek 串流偶發在 thinking 之後斷掉:最後一則 assistant 沒有文字也沒有
# 工具(stop_reason None、output_tokens 0),CLI 照常收尾,用戶等 7.5 分鐘看到空白(uid=1 T7,
# 2026-09-11)。同 session 再送一句「繼續」就接得上(T7b),所以這裡自動補一次,仍空才走兜底。
# 開新 CLI session 而不用 options.resume:resume 要把那則只剩 thinking 的殘缺 assistant 經
# proxy 重播給上游,離線驗不了;新 session + 對話脈絡是 T7b 實測接得上的路。
# 時間上限:bridge 在 2000s(TG)/2100s(web)砍掉整支 process,被砍的回合走
# report_turn_aborted、不經兜底,比不續跑還糟。所以第二次嘗試的 Bash 上限縮到剩下的牆鐘時間
# (扣掉 maybe_compact 最長 90s 等收尾),剩的不夠跑一支像樣的指令就不續。
_RESUME_MAX_ELAPSED_SEC = 1200
_RESUME_MIN_BUDGET_USD = 0.5
_RESUME_MIN_TURNS = 10
_BRIDGE_KILL_SEC = 2000  # the lower of telegram_bridge / web_bridge
_RESUME_TAIL_MARGIN_SEC = 150
_RESUME_MIN_TOOL_SEC = 300


def _resume_note(tool_steps):
    """第二次嘗試的逐輪錨。工具跑過就附收據:新 CLI session 看不到上一次的工具呼叫。"""
    note = ("[接續(系統訊息,不是使用者說的):你上一次處理這則訊息時,還沒寫出任何回覆就中斷了,"
            "使用者什麼都沒看到。把這則訊息的要求做完並回覆")
    if not tool_steps:
        return note + "。]"
    return (note + ";下面這些步驟中斷前已經執行、可能已生效,先確認現況,不要重做。]"
            + _fault_receipt_suffix(tool_steps))


def python_rule():
    """電腦版專屬:外殼用 BLAVE_PYTHON 指出 workspace 的直譯器(venv 的絕對路徑)。
    靠 PATH 前置不夠——Codex 用登入 shell(`zsh -lc`)跑指令,profile 會把 PATH 重排,
    `python3` 解析到沒裝 workspace 套件的那顆(2026-09-19 實測:回測報「缺 pandas」);
    環境變數不會被 profile 動到。兩條引擎都用這同一條規則,不各靠各的機制。
    機隊沒有這個變數 → 回傳空字串,system prompt 一個字都不變。"""
    py = os.environ.get("BLAVE_PYTHON")
    if not py:
        return ""
    return (
        "\n\n---\n\n"
        "## 這台機器的 Python（本 runtime 專屬規則）\n"
        f"這個 workspace 的 Python 直譯器是 `{py}`。AGENTS.md 與 references/ 裡寫的 "
        "`python3` / `python` 在這台機器上指的就是它：指令的其餘部分照原樣寫"
        "（一次一條、從 workspace 目錄執行），只把開頭的 `python3` 換成這個絕對路徑，例如\n"
        "```\n"
        f"{py} strategies/my_strategy/strategy.py\n"
        f"{py} -m tmp.x\n"
        "```\n"
        "策略、回測、`lib/` 的腳本、`-c` 單行都一樣。不要用 PATH 上的 `python3` / `python`——"
        "那可能是另一顆沒有安裝 workspace 套件（pandas 等）的直譯器；遇到 "
        "`ModuleNotFoundError` 先確認自己用的是不是上面這個路徑，不要自己 pip install。\n"
    )


def _codex_prompt(prompt, sink):
    """The Codex engine has no system-prompt channel, so the per-turn rules ride in front of
    the prompt. AGENTS.md is NOT included: Codex reads cwd's AGENTS.md itself
    (codex_engine.build_args lifts its size cap), and inlining it would feed it twice.
    model_catalog_rule is left out on purpose — it teaches switching between the proxy's
    models; this engine's model is picked in the shell (or is the user's Codex default)."""
    return ("[Runtime 規則(系統層級,位階等同 AGENTS.md;不是使用者說的,不要複述)]"
            + python_rule() + preferences_rule() + sink.formatting_rule
            + "\n\n---\n\n" + prompt)


async def run_turn(session_id, message, model, sink, viewing_strategy=None, viewing_tab=None,
                   viewing_view=None, viewing_widgets=None, ui_lang=None,
                   engine="claude", codex_bin=None, effort=None):
    # engine="codex" 是電腦版專屬(用戶自己的 Codex 訂閱),只換掉「呼叫模型並消化它的
    # 事件流」那一段;prompt、session store、兜底分類、寫回歷史全部共用。機隊不帶
    # --engine,走的是原本那條路,一行都不經過 codex 分支(閘門:
    # tests/check_codex_engine.py)。
    use_codex = engine == "codex"
    summary, recent = ss.get_context(session_id)
    reply_lang = _resolve_reply_lang(ui_lang)
    prompt = build_prompt(summary, recent, message,
                          viewing_strategy=viewing_strategy, viewing_tab=viewing_tab,
                          suggest_directive=isinstance(sink, WebSink),
                          viewing_view=viewing_view, viewing_widgets=viewing_widgets,
                          reply_lang=reply_lang)
    agents_md = load_agents_md()

    # Persist the user's message BEFORE calling the SDK — if the turn later
    # crashes (e.g. hits max_turns), the message must not vanish. Losing the
    # user's own words is worse than a slightly-early write.
    ss.append_turn(session_id, "user", message)

    # BLAVE_AGENT_DB:AGENTS.md 教 agent 用 sqlite 唯讀查自己的逐字稿;Linux 的
    # provisioning 沒設這個 env,在這裡帶最終解析值,兩個 OS 都保證看得到。
    # 過渡期兩個名字都注入:機器上的 lib/notify.py 走半手動更新通道,可能還是
    # 只讀舊名的版本(實測 2026-09-18:uid=1 的 workspace 還在 2026-09-17)。
    turn_env = {**PROXY_ENV, "BLAVE_AGENT_HOME": BLAVE_AGENT_HOME,
                "BLAVECLAW_HOME": BLAVE_AGENT_HOME, "BLAVE_AGENT_DB": ss.DB_PATH}
    # `python tmp/x.py` puts the script's own dir on sys.path, not the cwd, so a script under
    # tmp/ or report_jobs/<id>/ could not `import lib…`: nearly every report script failed its
    # first run (uid=1 Windows + 32321 Linux, 2026-09-11). options.env replaces the inherited
    # value rather than merging, so an existing PYTHONPATH is carried over explicitly.
    turn_env["PYTHONPATH"] = os.pathsep.join(
        p for p in (WORKSPACE, os.environ.get("PYTHONPATH")) if p)
    # 機器本身一律 UTC,但 agent 在聊天裡講的「現在幾點」、它讀的 log 時間戳都該是用戶的
    # 時間(report-schedules.md §2b)——沒帶的話它會把 UTC 的 10:26 當成用戶的現在。
    # 沒設定就不帶(舊機、只用 Telegram 的用戶),維持機器時間。策略子行程刻意不吃這個
    # (command_listener._strategy_subprocess_env),排程跑與手動跑的基準才會一致。
    user_tz = strategy_reporter.read_timezone()
    if user_tz:
        turn_env["TZ"] = user_tz
    # Claude Code's Bash tool auto-backgrounds any command still running at 600s
    # (CLAUDE_CODE_AUTO_BACKGROUND_TIMEOUT_MS) and caps the per-call `timeout`
    # at BASH_MAX_TIMEOUT_MS (600s). A large-universe Type C backtest (300 台股,
    # cold cache, throttled Windows box) takes longer than that: uid=1 2026-08-22
    # the run got backgrounded at 600s, the agent ended the turn "waiting", and the
    # turn's exit killed the backtest — $0.71 for no stats.json. 30 min keeps a
    # long backtest in the foreground so the agent actually sees it finish; the
    # turn's own max_turns / max_budget_usd brakes still bound the damage.
    # The auto-background threshold is min(requested timeout, AUTO_BACKGROUND), so
    # only runs the agent explicitly gives a long `timeout` stay in the foreground;
    # BASH_DEFAULT_TIMEOUT_MS is deliberately left at its 120s default so a
    # command that hangs with no timeout still gets backgrounded fast.
    # MUST stay strictly below the bridges' turn timeouts (telegram_bridge 2000s,
    # web_bridge TURN_TIMEOUT 2100s) or a rule-abiding long backtest gets the
    # whole turn killed instead. Names verified inside claude 2.1.239.
    if not os.environ.get("BLAVE_PROXY_TOKEN"):
        # 本機模式(電腦版):沒有 proxy token = 用戶自己的訂閱。這兩個必須
        # 「不存在」而不是留空——CLI 明講 API key 優先於 claude.ai 登入,
        # 留著就是 401(2026-09-18 實測)。
        # SDK 是 {**os.environ, **options.env}(subprocess_cli.py:810),所以
        # PATH/HOME/USER 這些由這支行程繼承就夠,不必在這裡複製;CLI 讀
        # Keychain 認的是 USER,外殼 spawn 這支時要帶齊(見 shell/main.js)。
        turn_env.pop("ANTHROPIC_BASE_URL", None)
        turn_env.pop("ANTHROPIC_API_KEY", None)
    turn_env.update({
        "CLAUDE_CODE_AUTO_BACKGROUND_TIMEOUT_MS": "1800000",
        "BASH_MAX_TIMEOUT_MS": "1800000",
        # The Windows native claude.exe self-updates unless told not to; set it on both
        # OSes (the Linux CLI bundled in the SDK wheel is not documented to, but this
        # costs nothing). Keep every machine on the CLI its image shipped — no 330MB
        # download mid-turn on a throttled box, no silent CLI/SDK drift. Name verified
        # inside claude 2.1.239.
        "DISABLE_AUTOUPDATER": "1",
    })
    if isinstance(sink, WebSink) and sink.report_url:
        # LocalSink 繼承 WebSink 但 report_url=None:這三個 env 是給雲端照片鏡射
        # 用的,本機不塞——塞 None 進 env 會讓 anyio 在 spawn 時炸
        # TypeError("expected str ... not NoneType"),整輪 not_started。
        # So lib/notify.report_photo_web can mirror backtest/param-scan charts into the
        # web chat (the agent's Bash-run strategy code inherits this env).
        turn_env["BLAVE_WEB_REPORT_URL"] = sink.report_url
        turn_env["BLAVE_WEB_REPORT_TOKEN"] = sink.report_token
        turn_env["BLAVE_WEB_SESSION"] = sink.session_id

    sysprompt_path = _write_system_prompt_file(
        agents_md + model_catalog_rule(session_id) + python_rule() + preferences_rule()
        + sink.formatting_rule
    ) if agents_md and not use_codex else None
    options = sdk.ClaudeAgentOptions(
        model=model,
        env=turn_env,
        cwd=WORKSPACE,
        # allowed_tools is an AUTO-APPROVE list, not a hard restriction — the
        # subagent tool (Task/Agent) ran fine outside it (07-28 實測,DeepSeek
        # 自己 spawn 了 explore 子代理)。Subagents interleave a second stream
        # into the same sink and wreck the「最後一段無工具文字=回覆」判定
        # (正式回覆被子代理尾隨的 tool chunk 收回成旁白,子代理的英文報告
        # 反而變成回覆),所以用 disallowed_tools 硬禁。`tools=` (also a valid
        # kwarg) is for *defining* custom/MCP tools — not this either.
        allowed_tools=ALLOWED_TOOLS,
        disallowed_tools=["Task", "Agent"] + PROTECTED_EDIT_RULES,
        # Keep Claude Code's own default system prompt (tool-use guidance
        # etc.) and append AGENTS.md + this surface's formatting rule on top —
        # via file, not argv (see _write_system_prompt_file). A preset without
        # "append" makes the SDK emit no system-prompt flag at all.
        system_prompt={"type": "preset", "preset": "claude_code"} if sysprompt_path else None,
        # 實測「建策略+回測+調參」正常就要 20+ 步(BTC RSI 那輪 21 步被砍在半路,
        # $1.46 白燒)。步數放寬到 50,真正的煞車改用預算——失控迴圈燒錢才是
        # 原本要防的事,用錢設限比步數合理。
        max_turns=TURN_MAX_TURNS,
        max_budget_usd=TURN_MAX_BUDGET_USD,
        # SDK 的 stdio transport 預設單條 JSON 訊息上限 1MB——agent 一個 Bash 印出
        # 大量輸出(K 線資料、回測明細)就整輪炸掉(實測:「建立 MACD 策略」第一輪
        # 就中)。放寬到 16MB;這是單條訊息的解析上限,不是常駐記憶體。
        max_buffer_size=16 * 1024 * 1024,
        permission_mode="bypassPermissions",
    )
    # Token-level text. Without it the SDK only yields a block once it is fully
    # generated, so the final answer — the one thing the user is actually waiting
    # for — lands in a single lump. Same prompt, same box, with vs without
    # (29026 Linux + uid=1 Windows): a 160-char reply went from 3.1s/3.6s of dead
    # air to 0.0s, a 950-char table from 6.0s to 0.02s, a 620-char answer after a
    # tool chain from 5.1s to 1.2s (what's left is the model's own time to first
    # token). Both sinks were already written to take deltas (WebSink appends,
    # TelegramStreamer throttles edits to one per 2.5s); this just supplies them.
    # Only text deltas are consumed — thinking still ships per block, because the
    # activity line shows one step at a time anyway and reasoning is far more
    # tokens than the reply. Set after construction, not as a kwarg: on an SDK
    # build without the field that would be a TypeError killing every turn.
    if effort:
        # 電腦版的 effort 選單。沒帶就連屬性都不碰(SDK 預設);設在建構之後,理由同下面的
        # extra_args:沒有這個欄位的 SDK build 不能因為一個 kwarg 整輪 TypeError。
        options.effort = effort
    if sysprompt_path:
        # Set after construction for the same reason as include_partial_messages
        # below: an SDK build whose options lack extra_args must not kill every turn.
        options.extra_args = {"append-system-prompt-file": sysprompt_path}
    if isinstance(sink, LocalSink):
        # 電腦版隔離(機隊不走這條,行為不變)。這裡的 agent 跑在**用戶自己的電腦、用戶
        # 自己的 Claude Code 帳號**上,CLI 預設會把用戶全域的東西整包載進來:
        # ~/.claude/CLAUDE.md、~/.claude.json 的 MCP、claude.ai 連接器、plugins、skills。
        # 2026-09-19 實際發生:用戶全域 CLAUDE.md 寫著「用 blave MCP SSH 進機器」,電腦版
        # 的 agent 就照做——把 SSH 私鑰寫進 ~/.ssh、連進用戶的雲端機抓資料畫圖,然後回報
        # 「發送成功」。同一個 app 每個人的行為都不一樣,而且碰的是 workspace 以外的東西。
        # 三個旗標各管一塊(CLI 2.1.278 用 stream-json 的 init 訊息逐項驗過):
        #   setting_sources=[]      → 不讀 user/project/local 設定與 CLAUDE.md、plugins
        #   strict_mcp_config       → 只認 --mcp-config 給的 MCP(我們沒給 = 一個都沒有)
        #   disable-slash-commands  → 連 CLI 內建的 skills(dataviz、deep-research…)也關掉
        # 規則來源只剩我們經 append-system-prompt-file 給的 AGENTS.md。登入不受影響
        # (憑證在 Keychain,不在設定檔)。
        options.setting_sources = []
        options.strict_mcp_config = True
        # 自動記憶不歸 setting_sources 管(官方文件 › What settingSources does not control):
        # 不關的話 agent 會在 ~/.claude/projects/<workspace>/memory/ 自己寫筆記、下次帶回來,
        # 行為就變成「看這台電腦以前聊過什麼」。我們的跨回合記憶只有 session.db 一條。
        turn_env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] = "1"
        options.env = turn_env
        options.extra_args = {**(getattr(options, "extra_args", None) or {}),
                              "disable-slash-commands": None}
    if _SUPPORTS_PARTIAL:
        options.include_partial_messages = True
    else:
        # 退回整塊模式是「回覆變慢」,用戶不會回報這種事——留一行給 journalctl,
        # 否則一次 SDK 降版會讓串流無聲消失。
        print("[agent_turn] SDK 沒有 include_partial_messages,這輪不串流", file=sys.stderr)

    await sink.start()
    # 回合級的工具收據(名稱, 受詞)。兜底分類要的是「這一輪有沒有發過工具呼叫」,
    # 而 WebSink._tool_t0 結束時已經被 pop 空,答不了這個問題。順帶是「做到哪」那份摘要的資料源。
    tool_steps = []
    # 本回合工具碰過的策略名,隨帶 sid 的 strategies chunk 送出。只在 ToolUseBlock 時加,
    # 所以工具結果回來那一推一定已含這一步的名字。
    touched = set()
    # 最後一則 is_error 的 ResultMessage:SDK 先把它送給呼叫端、才把錯誤包成例外
    # 拋出,所以這裡抄一份,分類就不必仰賴例外型別有沒有那些欄位。
    result_info = {}
    fault_code = None
    t_start = time.monotonic()
    spent_usd, spent_turns = 0.0, 0
    is_web = isinstance(sink, WebSink)
    strat_sig = None
    try:
        if use_codex:
            import codex_engine  # 只在這條路徑載入:機隊的回合連 import 都不發生

            def _codex_tool_start(name, params):
                nonlocal touched
                tool_steps.append((name, _tool_summary(name, params)))
                touched |= _touched_strategies(name, params)

            def _codex_tool_done():
                nonlocal strat_sig
                if not getattr(sink, "interrupted", False):
                    strat_sig = _maybe_push_strategies(sink, strat_sig, touched=touched)

            await codex_engine.run(
                codex_bin, _codex_prompt(prompt, sink), WORKSPACE,
                {**os.environ,
                 **{k: v for k, v in turn_env.items() if not k.startswith("ANTHROPIC_")}},
                sink, _codex_tool_start, _codex_tool_done, model=model, effort=effort)
        # 空回合續跑是為 DeepSeek 串流斷掉設的,Codex 沒有那個症狀,不重跑。
        for attempt in () if use_codex else (1, 2):
            query_iter = sdk.query(prompt=prompt, options=options)
            # Text already delivered as deltas, one entry per content block, so the
            # completed TextBlocks below are not re-sent. Reconciled rather than
            # trusted: if the deltas never arrived (a provider or SDK build that
            # doesn't emit them — see anthropics/claude-code#17956 for the streaming-
            # input variant), the whole block still goes out and the user gets a
            # reply, just not a live one. One entry per block, not one string for the
            # whole turn: a message can hold several text blocks (text, thinking,
            # text) and a single string would let the last one's deltas answer for all
            # of them, re-sending an earlier block whole — a second copy of it under
            # the one the user just watched being typed. Matching/consumption is in
            # _unstreamed; cleared per message so an unconsumed block (narration that
            # went to the activity line) can't be mistaken for a later reply's deltas.
            streamed = {}
            async for msg in query_iter:
                if _STREAM_EVENT is not None and isinstance(msg, _STREAM_EVENT):
                    # 同下面 AssistantMessage 的第二層防線:子代理的 delta 也不能流進
                    # 回覆泡泡/歷史(它的完整訊息稍後會走 on_status)。
                    if getattr(msg, "parent_tool_use_id", None):
                        continue
                    event = msg.event or {}
                    if event.get("type") == "content_block_delta":
                        delta = event.get("delta") or {}
                        if delta.get("type") == "text_delta":
                            text = delta.get("text") or ""
                            if text:
                                sink.on_text(text)
                                idx = event.get("index")
                                streamed[idx] = streamed.get(idx, "") + text
                elif isinstance(msg, sdk.AssistantMessage):
                    # 第二層防線(第一層是 disallowed_tools):子代理的訊息帶
                    # parent_tool_use_id,它的文字一律進活動列、不進回覆/歷史——
                    # 兩條 stream 混流時,回覆的結構判定(見下)會被子代理打亂。
                    if getattr(msg, "parent_tool_use_id", None):
                        for block in msg.content:
                            if isinstance(block, sdk.TextBlock) and block.text.strip():
                                sink.on_status(block.text)
                        continue
                    # 結構性旁白判定:同一則訊息裡帶 ToolUseBlock,其中的文字就是
                    # 「我來查一下…」式的過場話——只給狀態指示器,不進回覆/歷史。
                    # 真正的回覆是最後那則(沒有工具呼叫)的文字。用 prompt 禁止旁白
                    # 屢戰屢敗(preset 本來就鼓勵邊做邊講),這裡用結構切,100% 生效。
                    has_tool_use = any(isinstance(b, sdk.ToolUseBlock) for b in msg.content)
                    for block in msg.content:
                        if isinstance(block, sdk.TextBlock):
                            if has_tool_use:
                                sink.on_status(block.text)
                            else:
                                rest = _unstreamed(block.text, streamed)
                                if rest:
                                    sink.on_text(rest)
                        elif isinstance(block, sdk.ThinkingBlock):
                            sink.on_thinking(block)
                        elif isinstance(block, sdk.ToolUseBlock):
                            # 先記收據再交給 sink:工具是 CLI 執行的,sink 炸掉不該讓
                            # 這一步從「做到哪」的名單裡消失。
                            tool_steps.append((
                                getattr(block, "name", "") or "",
                                _tool_summary(getattr(block, "name", ""),
                                              getattr(block, "input", None)),
                            ))
                            touched |= _touched_strategies(getattr(block, "name", ""),
                                                           getattr(block, "input", None))
                            sink.on_tool(block)
                        # A Stop arrives via the /report response inside on_*; break
                        # at the next block boundary rather than mid-message.
                        if getattr(sink, "interrupted", False):
                            break
                    streamed.clear()
                elif _USER_MESSAGE is not None and isinstance(msg, _USER_MESSAGE):
                    # 工具結果:SDK 把它包成 user 訊息回流(message_parser 的 case "user"
                    # 把 tool_result block 解成 ToolResultBlock)。只拿來補收據的耗時與
                    # 推策略清單,不碰回覆文字。
                    content = getattr(msg, "content", None)
                    if _DEBUG_MSGS:
                        kinds = type(content).__name__ if isinstance(content, str) else \
                            [type(b).__name__ for b in (content or [])]
                        print(f"[agent_turn][probe] UserMessage parent="
                              f"{getattr(msg, 'parent_tool_use_id', None)!r} blocks={kinds}",
                              file=sys.stderr)
                    # 子代理的工具不進收據(同 AssistantMessage 那道第二層防線);
                    # content 是 str = 真的是注入的用戶訊息,裡面沒有工具結果。
                    on_result = getattr(sink, "on_tool_result", None)
                    if on_result and _TOOL_RESULT_BLOCK is not None \
                            and not isinstance(content, str) \
                            and not getattr(msg, "parent_tool_use_id", None):
                        for block in content or []:
                            if isinstance(block, _TOOL_RESULT_BLOCK):
                                on_result(block)
                    # 推在工具結果之後、不在工具請求時:請求當下工具還沒跑,那一推只會
                    # 帶到別人的變動、漏掉這一步建的檔,卻掛上這條對話的 session_id。
                    if is_web and not isinstance(content, str) \
                            and not getattr(msg, "parent_tool_use_id", None) \
                            and not getattr(sink, "interrupted", False):
                        strat_sig = _maybe_push_strategies(sink, strat_sig, touched=touched)
                elif isinstance(msg, sdk.ResultMessage):
                    print(f"[agent_turn] cost=${msg.total_cost_usd} turns={msg.num_turns}", file=sys.stderr)
                    spent_usd += msg.total_cost_usd or 0
                    spent_turns += msg.num_turns or 0
                    if getattr(msg, "is_error", False):
                        result_info = {
                            "subtype": getattr(msg, "subtype", None),
                            "api_error_status": getattr(msg, "api_error_status", None),
                            "terminal_reason": getattr(msg, "terminal_reason", None),
                            "result": getattr(msg, "result", None),
                        }
                elif _DEBUG_MSGS:
                    print(f"[agent_turn][probe] {type(msg).__name__}", file=sys.stderr)
                if getattr(sink, "interrupted", False):
                    print("[agent_turn] interrupted by user — stopping turn", file=sys.stderr)
                    aclose = getattr(query_iter, "aclose", None)
                    if aclose:
                        await aclose()  # let the SDK tear down the subprocess/session cleanly
                    break
            if attempt == 2 or getattr(sink, "interrupted", False) or sink.has_reply():
                break
            elapsed = time.monotonic() - t_start
            budget = TURN_MAX_BUDGET_USD - spent_usd
            tool_cap_s = min(int(turn_env["BASH_MAX_TIMEOUT_MS"]) // 1000,
                             int(_BRIDGE_KILL_SEC - _RESUME_TAIL_MARGIN_SEC - elapsed))
            if elapsed > _RESUME_MAX_ELAPSED_SEC or budget < _RESUME_MIN_BUDGET_USD \
                    or tool_cap_s < _RESUME_MIN_TOOL_SEC:
                print(f"[agent_turn] empty reply, not resuming ({elapsed:.0f}s, "
                      f"${spent_usd:.2f} spent)", file=sys.stderr)
                break
            print(f"[agent_turn] empty reply — resuming once (tools={len(tool_steps)}, "
                  f"{elapsed:.0f}s, ${spent_usd:.2f} spent)", file=sys.stderr)
            # The original message goes in again, not a literal 「繼續」: the language pin is
            # derived from it, and `recent` (read before this turn's user row was written)
            # would otherwise hold the request twice.
            prompt = build_prompt(summary, recent, message,
                                  viewing_strategy=viewing_strategy, viewing_tab=viewing_tab,
                                  suggest_directive=is_web,
                                  viewing_view=viewing_view, viewing_widgets=viewing_widgets,
                                  reply_lang=reply_lang, resume_note=_resume_note(tool_steps))
            options.max_budget_usd = budget
            options.max_turns = max(TURN_MAX_TURNS - spent_turns, _RESUME_MIN_TURNS)
            # A new dict, not an in-place update: the CLI child's env is built from
            # options.env at connect time, and a fresh object is right whether or not
            # anything upstream kept a reference to the old one.
            cap_ms = str(tool_cap_s * 1000)
            options.env = {**options.env, "BASH_MAX_TIMEOUT_MS": cap_ms,
                           "CLAUDE_CODE_AUTO_BACKGROUND_TIMEOUT_MS": cap_ms}
        # Narration still counts as the floor: when both attempts end without reply text
        # but some narration exists, finalize() shows it the way it did before resuming.
        if not getattr(sink, "interrupted", False) and not sink.has_reply() \
                and not getattr(sink, "_last_status", "").strip():
            fault_code = _fault_code(RuntimeError("the turn ended without any reply text"),
                                     len(tool_steps), result_info)
            print(f"[agent_turn] empty reply → fault={fault_code} tools={len(tool_steps)}",
                  file=sys.stderr)
            surface = "web" if is_web else "tg"
            sink.set_error(_fault_message(fault_code, message, surface, lang=reply_lang),
                           code=fault_code)
    except Exception as e:
        # A crash here must never silently drop the turn — always leave a
        # record (so future turns have context) and always give the user
        # something back.
        print(f"[agent_turn] turn failed: {e}", file=sys.stderr)
        fault_code = _fault_code(e, len(tool_steps), result_info)
        print(f"[agent_turn] fault={fault_code} tools={len(tool_steps)}", file=sys.stderr)
        surface = "web" if isinstance(sink, WebSink) else "tg"
        sink.set_error(_fault_message(fault_code, message, surface, lang=reply_lang),
                       code=fault_code)
    finally:
        await sink.stop()
        if sysprompt_path:
            try:
                os.unlink(sysprompt_path)
            except OSError as e:
                # Windows AV can hold the file briefly (web_bridge.py has the same
                # note); the next turn's stale sweep picks it up — but say so.
                print(f"[agent_turn] 刪不掉 {sysprompt_path}: {e}", file=sys.stderr)

    # done 之前補推:工具結果之後才落地的檔(背景指令、SDK 沒吐工具結果訊息)只剩
    # 這一推帶得到 session_id——web_bridge 回合末那推不帶,而且晚於 done。
    # tool_steps 擋掉純聊天回合:strat_sig 起始是 None,不擋就每輪都掃一次、推整份清單。
    # 讀取類工具也算進 tool_steps,只讀的回合也會比一次 signature()——刻意的,成本很低。
    # 在 try 外面:這裡拋出去 finalize() 就不跑,前端收不到 done/error 一路轉圈。
    if is_web and tool_steps and not getattr(sink, "interrupted", False):
        try:
            strat_sig = _maybe_push_strategies(sink, strat_sig, include_newborn=True,
                                               touched=touched)
        except Exception as e:
            print(f"[agent_turn] pre-done strategy push failed: {e}", file=sys.stderr)
    reply_text = sink.finalize()
    # 收據摘要只進 session sqlite(下一輪模型的 context),不進用戶看得到的任何表面。
    history_text = reply_text
    if fault_code in (FAULT_PARTIAL, FAULT_MAX_TURNS):
        history_text += _fault_receipt_suffix(tool_steps)
    ss.append_turn(session_id, "assistant", history_text)
    ss.maybe_compact(session_id)

    return reply_text


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("session_id")
    parser.add_argument("message")
    # 預設值在下面解析,不寫在這裡:codex 引擎要分得出「用戶真的選了 model」與「沒帶」——
    # 把我們的預設(proxy 的模型名)當成用戶選的傳給 `codex -m` 會整輪失敗。
    parser.add_argument("--model", default=None)
    parser.add_argument("--delivery", default="telegram", choices=["telegram", "web", "local"])
    parser.add_argument("--telegram-chat-id", default=None)
    parser.add_argument("--report-url", default=None)
    parser.add_argument("--viewing-strategy", default=None)
    parser.add_argument("--viewing-tab", default=None, choices=[None, "code", "data"])
    # 視圖代號不設 choices:值域是前端的,加新頁不該要 runtime 先發版才不會炸——
    # 認不認得由 build_prompt 決定(認不得就當沒送)。
    parser.add_argument("--viewing-view", default=None)
    parser.add_argument("--viewing-widgets", default=None)  # JSON 字串陣列
    # 不設 choices(同 --viewing-view):怪值只當沒送,不能 exit 2 整輪死;白名單在 _resolve_reply_lang
    parser.add_argument("--ui-lang", default=None)
    # 電腦版專屬。不帶 = claude = 機隊原本的路徑;不設 choices(同 --ui-lang),"codex"
    # 以外的值一律當 claude。codex 時 --model 有帶才轉成 `codex exec -m`(外殼只在用戶
    # 真的選了 codex 型錄裡的 model 時才帶),沒帶就讓 Codex 用用戶自己設定的預設。
    parser.add_argument("--engine", default="claude")
    parser.add_argument("--codex-bin", default=None)
    # 選填,值域由外殼依引擎/模型保證,這裡原樣轉發。沒帶 = 引擎自己的預設。
    parser.add_argument("--effort", default=None)
    args = parser.parse_args()
    viewing_widgets = parse_viewing_widgets(args.viewing_widgets)

    # Secrets come from env, never argv — argv is world-visible in `ps`. The web
    # report token IS the machine's proxy token; the Telegram bot token is passed
    # by telegram_bridge in the subprocess env.
    report_token = os.environ.get("BLAVE_PROXY_TOKEN", "")
    telegram_token = os.environ.get("BLAVE_TELEGRAM_TOKEN")

    if args.delivery == "web":
        sink = WebSink(args.report_url, report_token, args.session_id)
    elif args.delivery == "local":
        sink = LocalSink(args.session_id)
    else:
        sink = TelegramSink(telegram_token, args.telegram_chat_id)

    model = args.model
    if args.engine != "codex":
        model = model or model_prefs.DEFAULT_MODEL
    reply = asyncio.run(run_turn(
        args.session_id, args.message, model, sink,
        viewing_strategy=args.viewing_strategy, viewing_tab=args.viewing_tab,
        viewing_view=args.viewing_view, viewing_widgets=viewing_widgets,
        ui_lang=args.ui_lang, engine=args.engine, codex_bin=args.codex_bin,
        effort=args.effort,
    ))
    print(reply)


if __name__ == "__main__":
    main()
