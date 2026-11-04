"""回覆提到策略寫顯示名稱(DISPLAY_NAME),不寫程式代號;交易所寫名稱不寫 id。

鎖:① _STYLE_RULES(web、電腦版、App、Telegram 共用)與建議規則帶這幾條;② _display_name 只取 DISPLAY_NAME 常數,
沒有、跟代號一樣、含事實行分隔字、路徑形狀、讀不到都退回 None;③ _deploy_state_line 每一列都帶「顯示名（代號）」、
沒名稱的照寫代號、壞檔不讓那一行消失;④ build_prompt 的工作頁狀態帶顯示名,雲端視角不查本機同名資料夾。

跑法:cd blave-agent && python3 tests/check_strategy_display_names.py
"""
import json, os, shutil, sys, tempfile, time, types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))
WS = tempfile.mkdtemp(prefix="check-display-names-ws-")
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.setdefault("BLAVE_AGENT_DB", os.path.join(WS, "session.db"))
sys.modules["claude_agent_sdk"] = types.ModuleType("claude_agent_sdk")
import agent_turn as at  # noqa: E402

fails = []


def t(name, ok, got=None):
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok or got is None else f"  → {got!r}"))
    if not ok:
        fails.append(name)


def write(rel, obj):
    p = os.path.join(WS, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        f.write(obj if isinstance(obj, str) else json.dumps(obj))


def strat(code, display=None, extra=""):
    body = f'STRATEGY_NAME = "{code}"\n' + (f"DISPLAY_NAME = {display!r}\n" if display is not None else "") + extra
    write(f"strategies/{code}/strategy.py", body)


# ① 規則字串
S = at._STYLE_RULES
# 三處同一個退路順序:DISPLAY_NAME → # Strategy: 或用戶慣稱 → 代號(稽核 P2:錨與規則講法不同,模型每輪兩句都收到)
ORDER = ("DISPLAY_NAME", "# Strategy: 或用戶慣稱", "都沒有才用代號")
for nm_, txt in (("_STYLE_RULES", S), ("_SUGGEST_RULE", at._SUGGEST_RULE), ("_SUGGEST_ANCHOR_TAIL", at._SUGGEST_ANCHOR_TAIL)):
    pos = [txt.find(w) for w in ORDER]
    t(f"{nm_}:名稱退路照 DISPLAY_NAME → # Strategy:／慣稱 → 代號", all(x >= 0 for x in pos) and pos == sorted(pos), pos)
t("沒有跟退路矛盾的「不寫資料夾名／不寫代號／不寫 STRATEGY_NAME」",
  not any(w in x for w in ("不寫資料夾名", "不寫代號", "STRATEGY_NAME", "底線代號")
          for x in (S, at._SUGGEST_ANCHOR_TAIL)) and "沒有才用 # Strategy:" not in at._SUGGEST_RULE)
t("風格規則:交易所寫名稱不寫 id,統一／群益／模擬交易都在、中英都有",
  "不寫 id" in S and all(f"{k} 寫{zh}(英文 {en})" in S for k, (zh, en) in at._VENUE_NAMES.items())
  and {"president", "capital", "paper"} <= set(at._VENUE_NAMES))
t("四個表面都掛到:WEB／LOCAL／Telegram 的格式規則都含 _STYLE_RULES",
  all(S in r for r in (at.WEB_FORMATTING_RULE, at.LOCAL_FORMATTING_RULE, at.TELEGRAM_FORMATTING_RULE)))
_zh = open(os.path.join(ROOT, "shell", "i18n", "zh.po"), encoding="utf-8").read()
_en = open(os.path.join(ROOT, "shell", "i18n", "en.po"), encoding="utf-8").read()
_off = [(k, zh, en) for k, (zh, en) in at._VENUE_NAMES.items() if f'msgstr "{zh}"' not in _zh or f'msgstr "{en}"' not in _en]
t("交易所名稱跟外殼 zh.po／en.po 的 msgstr 同字", not _off, _off)
_new = [l for l in S.splitlines() if "DISPLAY_NAME" in l or "不寫 id" in l]
t("新加的兩條沒有破折號", len(_new) == 2 and not any("——" in l for l in _new), _new)

# ② _display_name
shutil.rmtree(WS)
os.makedirs(WS)
strat("btc_ma_4h", "BTC 4h 均線交叉")
strat("plain")
strat("same", "same")
strat("bad_sep", "A、B")
strat("broken", "壞掉的檔", extra="def oops(:\n")
strat("quoted", "Bob's BTC trend")
write("strategies/flat_one.py", 'DISPLAY_NAME = "單檔策略"\n')
write("strategies/runs_code/strategy.py", 'import os\nos.makedirs("PWNED")\nDISPLAY_NAME = "不執行"\n')
D = at._display_name
t("有 DISPLAY_NAME → 名稱", D(WS, "btc_ma_4h") == "BTC 4h 均線交叉", D(WS, "btc_ma_4h"))
t("單檔策略 strategies/x.py 也讀得到", D(WS, "flat_one") == "單檔策略", D(WS, "flat_one"))
t("值裡有引號照全名(走 ast)", D(WS, "quoted") == "Bob's BTC trend", D(WS, "quoted"))
t("只解析不執行", D(WS, "runs_code") == "不執行" and not os.path.exists(os.path.join(WS, "PWNED")))
t("語法錯的檔仍拿得到名稱(strategy_consts 的退路)", D(WS, "broken") == "壞掉的檔", D(WS, "broken"))
strat("fake_code", "A（b）")
strat("fake_quote", "A」(代號 b)「")
for i, ch in enumerate(("\u2028", "\u2029", "\x85", "\x0b", "\x0c", "\u202e", "\x00")):
    strat(f"sep_{i}", f"A{ch}B")
write("strategies/bom/strategy.py", "\ufeffDISPLAY_NAME = '有 BOM'\n")
write("strategies/big/strategy.py", 'DISPLAY_NAME = "大檔"\n' + "x = 1\n" * 400000)
t("檔頭有 BOM 也拿得到", D(WS, "bom") == "有 BOM", D(WS, "bom"))
t("大檔只讀檔頭:截斷後照樣拿得到名稱", D(WS, "big") == "大檔", D(WS, "big"))
_orig_consts = at.strategy_reporter.strategy_consts
_lens = []
at.strategy_reporter.strategy_consts = lambda src: (_lens.append(len(src)), _orig_consts(src))[1]
try:
    D(WS, "big")
finally:
    at.strategy_reporter.strategy_consts = _orig_consts
t("解析的字數有上限(_NAME_READ_MAX)", _lens and max(_lens) <= at._NAME_READ_MAX, _lens)
_bad = ["fake_code", "fake_quote"] + [f"sep_{i}" for i in range(7)]
for code in ("plain", "same", "bad_sep", "missing", "", "../btc_ma_4h", "a/b", "a\\b", ".hidden",
             "D:btc_ma_4h", "C:", "x:y", os.path.join(WS, "strategies", "btc_ma_4h"), *_bad):
    t(f"退回 None:{code!r}", D(WS, code) is None, D(WS, code))
t("工作區不存在 → None,不丟例外", D("/nonexistent-ws-xyz", "btc_ma_4h") is None)

# ③ _deploy_state_line
shutil.rmtree(WS)
os.makedirs(WS)
strat("btc_ma_4h", "BTC 4h 均線交叉")
strat("eth_zero", "ETH 零金額")
strat("sol_draft", "SOL 草稿")
strat("cron_b", "自排程 B")
strat("no_name")
write("strategies/garbage/strategy.py", "\x00\xff not python")
write("manager/portfolio_config.json", {"amounts": {"btc_ma_4h": 1000, "no_name": 200, "eth_zero": 0}})
write("state/deployments.json", {"btc_ma_4h": {}, "no_name": {}, "eth_zero": {}, "cron_b": {"type": "cron"},
                                 "reconciler": {"type": "daemon"}})
write("state/HALT_btc_ma_4h", "{}")
line = at._deploy_state_line(WS)
t("有金額那一列:顯示名（代號）,沒名稱的照寫代號", "策略組合有金額:BTC 4h 均線交叉（btc_ma_4h）、no_name;" in line, line)
t("自己排程的策略帶名稱", "自己排程的策略:自排程 B（cron_b）" in line, line)
t("金額 0 那一列帶名稱、註記照舊", "ETH 零金額（eth_zero）(在策略組合、金額 0)" in line, line)
t("還沒上線帶名稱;讀不出來的照寫代號", "SOL 草稿（sol_draft）" in line and "、garbage" in line, line)
t("名稱查不到不會把代號弄丟(每支代號都還在)", all(c in line for c in ("btc_ma_4h", "no_name", "eth_zero", "cron_b", "sol_draft")))
orig = at.strategy_reporter.strategy_consts
at.strategy_reporter.strategy_consts = lambda src: (_ for _ in ()).throw(RuntimeError("boom"))
try:
    line2 = at._deploy_state_line(WS)
finally:
    at.strategy_reporter.strategy_consts = orig
t("解析名稱丟例外:那一行照出、全寫代號", line2.startswith("[上線現況") and "策略組合有金額:btc_ma_4h、no_name;" in line2
  and "BTC 4h" not in line2, line2)

# ③b 200 支策略:只解析會出現在那一行的(每列最多 15 支,四列)
shutil.rmtree(WS)
os.makedirs(WS)
for i in range(200):
    strat(f"s{i:03d}", f"策略 {i}")
write("manager/portfolio_config.json", {"amounts": {**{f"s{i:03d}": 100 for i in range(30)},
                                                   **{f"s{i:03d}": 0 for i in range(30, 60)}}})
write("state/deployments.json", {})
_calls = []
_orig_consts = at.strategy_reporter.strategy_consts
at.strategy_reporter.strategy_consts = lambda src: (_calls.append(1), _orig_consts(src))[1]
try:
    line3 = at._deploy_state_line(WS)
finally:
    at.strategy_reporter.strategy_consts = _orig_consts
t(f"200 支只解析需要的(≤ 15×4,實際 {len(_calls)})", 0 < len(_calls) <= 60, len(_calls))
t("…那一行照樣帶名稱", "策略 0（s000）" in line3 and "策略 30（s030）(在策略組合、金額 0)" in line3, line3[:300])

# ④ build_prompt 的工作頁狀態
strat("btc_ma_4h", "BTC 4h 均線交叉")
strat("no_name")
p = at.build_prompt("", [], "這支怎麼樣", viewing_strategy="btc_ma_4h")
t("本機:工作頁狀態帶顯示名與代號", "開著策略「BTC 4h 均線交叉」(代號 btc_ma_4h)" in p, p[-600:])
p = at.build_prompt("", [], "這支怎麼樣", viewing_strategy="no_name")
t("沒名稱:照寫代號", "開著策略「no_name」。" in p or "開著策略「no_name」的" in p, p[-600:])
p = at.build_prompt("", [], "這支怎麼樣", viewing_strategy="btc_ma_4h", viewing_env="cloud")
t("雲端視角:不拿本機同名資料夾的名稱", "開著策略「btc_ma_4h」" in p and "BTC 4h 均線交叉" not in p, p[-600:])
p = at.build_prompt("", [], "這支怎麼樣", viewing_strategy="../../etc")
t("怪代號:不讀檔、照寫", "開著策略「../../etc」" in p)

shutil.rmtree(WS, ignore_errors=True)
if fails:
    sys.exit(f"{len(fails)} failed")
print("all passed")
