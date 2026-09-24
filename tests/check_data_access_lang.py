"""資料不可用那一段不可以給模型「成品句」——給了,模型就照抄,逐輪語言錨壓不過它。

2026-09-23:Wei 用中文問「現在btc籌碼集中度如何」,整則回英文。查下來錨沒有錯
(`_is_zh` 判對、`[用中文回覆這則訊息]` 貼在 prompt 最尾端),錯在 `data_access_rule()`
的 access="0" 那一段:它用英文散文把「要跟用戶說的那句話」寫成成品
(「This desktop has NO Blave data access right now.」),模型直接抄過去。
一行通用的語言錨打不過一句剛好就是這則要回的現成句子。

這支鎖兩件事:
  ① 那一段裡沒有給用戶讀的成品句,而且明講「每一句用戶讀的都自己寫、用該輪語言」;
     約束本身(哪些資料、怎樣才有、marker、不要編、不要去別處找憑證)一條都不能少。
  ② 中文訊息 → prompt 最尾端是中文錨(本機那條路與 web / TG 同一個 build_prompt)。

**沒鎖到的**:模型真的用中文回答。那要真的跑一次模型,不是這裡能決定的;
這支只證明「送進去的東西不再自相矛盾」。

跑法:cd blave-agent && python3 tests/check_data_access_lang.py
"""
import os, re, sys, tempfile, types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))
_tmp = tempfile.mkdtemp(prefix="check-data-lang-")
os.makedirs(os.path.join(_tmp, "ws", "state"))
os.environ.update({"BLAVE_AGENT_WORKSPACE": os.path.join(_tmp, "ws"),
                   "BLAVE_AGENT_STATE": os.path.join(_tmp, "state"),
                   "BLAVE_AGENT_DB": os.path.join(_tmp, "session.db")})
os.environ.pop("BLAVE_PROXY_TOKEN", None)
# SDK 不是這支在測的東西
sdk = types.ModuleType("claude_agent_sdk")
class _Obj:
    def __init__(self, **kw): self.__dict__.update(kw)
for _n in ("ClaudeAgentOptions", "AssistantMessage", "TextBlock", "ToolUseBlock", "ThinkingBlock", "ResultMessage"):
    setattr(sdk, _n, type(_n, (_Obj,), {}))
sdk.query = lambda **kw: None
sys.modules["claude_agent_sdk"] = sdk
import agent_turn  # noqa: E402

red = 0
def t(name, ok):
    global red
    print(("PASS  " if ok else "FAIL  ") + name)
    if not ok: red += 1

os.environ["BLAVE_DATA_ACCESS"] = "0"
block = agent_turn.data_access_rule()

# ① 沒有成品句:那次事故抄走的就是這一句(以及它的任何微調版)
t("access=0:沒有給用戶讀的成品句(事故原句與其變體都不在)",
  not re.search(r"This desktop has NO Blave data access", block)
  and not re.search(r"say this plainly", block, re.I))
t("access=0:明講「用戶讀的每一句自己寫、用該輪語言」,而且不要照抄這一段",
  "not wording for the user" in block
  and re.search(r"language the per-turn language directive names", block)
  and re.search(r"[Dd]o not copy, translate or adapt any phrasing from this block", block))
# 約束一條都不能少(設計師之後會換文案,但這些必須留著)
for need, label in [
    (r"holder concentration", "哪些是 Blave 專屬資料"),
    (r"card trial", "什麼條件才有(試用)"),
    (r"cloud machine", "什麼條件才有(雲端主機)"),
    (r"charged per clock hour of use", "沒有主機也拿得到:按有用到的整點小時收(沒有主機也能買資料)"),
    (r"balance that covers the hourly data fee", "條件裡有「餘額付得起這一小時」,不只試用與主機"),
    (r"name which data is missing", "要講缺哪一項"),
    (r"no directions, next steps or prices", "不給指路 / 不報價"),
    (r"once per conversation", "一次對話只講一次(marker)"),
    (r"do not repeat the unavailability", "一次對話只講一次(那句話本身)"),
    (r"Never fabricate the missing data", "不可以編數據"),
    (r"no SSH, no\s+other machines", "不可以去別處找憑證"),
    (r"fetch_kline", "公開 K 線照樣回答"),
    (re.escape(agent_turn.DATA_ACCESS_CARD), "marker 還在"),
]:
    t("access=0:約束保留 —— " + label, bool(re.search(need, block)))

os.environ["BLAVE_DATA_ACCESS"] = "1"
one = agent_turn.data_access_rule()
t("access=1 照舊有內容、access 未設時整段不出", bool(one)
  and (os.environ.pop("BLAVE_DATA_ACCESS", None), agent_turn.data_access_rule() == "")[1])
# access=1:講的必須是 api 現在真的會回的東西。`DATA_NOT_INCLUDED` 已經被 api 拿掉——
# 桌面 key 不含在試用／主機／API 方案裡時改成按小時收費,扣不到才 403 ERR007。
# 教模型認一個永遠不會到的 403,等於那條路上沒有規則。
t("access=1:不再教模型認已經不存在的 DATA_NOT_INCLUDED", "DATA_NOT_INCLUDED" not in one)
for need, label in [
    (r"`ERR007`", "扣不到這一小時的資料費"),
    (r"`ERR005`", "key 被刪／撤銷"),
    (r"`KEY_SCOPE`", "越權"),
    (r"per clock hour", "按小時、不是按次"),
    (r"can therefore cost the user money", "成功的呼叫也會花到錢"),
    (r"never state a rate, currency or deadline the body did not", "不准自己編費率／期限"),
    (r"not wording for the user", "一樣不給可抄的成品句"),
    (r"fetch_kline", "公開 K 線照舊"),
]:
    t("access=1:" + label, bool(re.search(need, one)))

# ② 中文訊息 → prompt 最尾端是中文錨(本機那條路跟 web / TG 同一個 build_prompt)
msg = "現在btc籌碼集中度如何"
t("中文訊息判成中文(事故當天那一句)", agent_turn._is_zh(msg))
prompt = agent_turn.build_prompt("", [], msg)
t("中文錨貼在 prompt 最尾端", prompt.rstrip().endswith("[用中文回覆這則訊息]"))
en = agent_turn.build_prompt("", [], "how is btc holder concentration")
t("英文訊息照樣錨成英文(不是一律中文)", "English" in en.rstrip().split("\n")[-1])
# 錨要排在資料那一段後面:誰在後面誰的 recency 大
os.environ["BLAVE_DATA_ACCESS"] = "0"
whole = agent_turn.data_access_rule() + "\n" + agent_turn.build_prompt("", [], msg)
t("語言錨在資料規則之後", whole.rindex("[用中文回覆這則訊息]") > whole.rindex("Blave-only datasets"))

# ③ 有漢字就是中文,除非有英文句子的證據(文法字)。兩個方向都用真實形狀的訊息:
#   2026-09-23 兩次判錯——「做vol target到30%」(2 個漢字、9 個字母,整則回英文)與貼金鑰那一句
zh_msgs = [
    "做vol target到30%",
    "幫我看一下 BTC 的 Sharpe",
    "把 MCPT 跑一次",
    "幫我把這組 Binance 金鑰綁到真錢帳戶:BINANCE_API_KEY=FAKE_not_a_real_key_0000 BINANCE_SECRET_KEY=FAKE_not_a_real_secret_0000",
    "幫我把這組 Binance 金鑰綁到真錢帳戶：BINANCE_API_KEY=FAKE_not_a_real_key_0000 BINANCE_SECRET_KEY=FAKE_not_a_real_secret_0000",
    "drawdown 太大了,改一下",
    "用 lib/data.py 抓 BTCUSDT 1h 的資料",
    "打開 https://blave.org/zh/agent/workspace 看一下",
    "這個識別碼 a3f9c2e1-7b04-4d6e-9e21-5c0b8d4f1a77 要附在信裡嗎",
    "幫我做一個 buy the dip 策略",
    "現在是 risk on 還是 risk off",
    "這個 out of sample 表現怎樣",
    "現在btc籌碼集中度如何",
    "好",
    # 稽核 M1:貼上的錯誤訊息 / 程式碼是別人寫的英文,不算用戶的英文句
    "幫我看這個錯誤:ValueError: cannot convert the series to <class 'float'>",
    "這個錯誤是什麼意思 KeyError: 'close' is not in the index",
    "跑回測出現 Traceback (most recent call last): File \"lib/data.py\", line 12, in <module>",
    "這段為什麼錯 / for i in range(10): print(i)",
    "這段為什麼錯\n```\nfor i in range(10):\n    print(i)\n```",
    "`df.loc[i] is None` 為什麼會這樣",
    "如果 price is above the MA 就進場",
    "錯誤訊息: Order would immediately trigger. 怎麼辦",
]
for m in zh_msgs:
    t("→ 中文:" + m[:28].replace("\n", " "), agent_turn._is_zh(m))
for m in zh_msgs[:4]:
    t("prompt 尾端是中文錨:" + m[:20], agent_turn.build_prompt("", [], m).rstrip().endswith("[用中文回覆這則訊息]"))
en_msgs = [
    "what is 台積電 price",
    "run a backtest on 2330",
    "How has 台積電 performed this week compared with 鴻海 and 聯發科?",
    "Show me the BTCUSDT funding rate history on 幣安 for the last week",
    "Is 做多 good right now?",
    "run a backtest on 均線交叉",
    "what's the Sharpe of my strategy",
    "for i in range(10)",   # 沒有漢字:不管裡面是什麼,都不是中文句
    "What does this mean? ValueError: cannot convert 台積電 data",   # 英文句在前、貼上的錯誤在後:照樣英文
    # 稽核 Delta 2:英文句裡的括號不是程式碼;只有股名在頭尾、沒有中文虛字的英文句不是「中文句夾英文」
    "Buy 台積電 (2330) if RSI < 30 and price is above the MA",
    "Is 台積電 [2330] above the 200-day MA?",
    "台積電 looks weak today, should I switch to 聯發科",
    "「台積電」 is looking stronger than 「鴻海」",
]
for m in en_msgs:
    t("→ 不是中文:" + m[:30], not agent_turn._is_zh(m))
    t("prompt 尾端是英文錨:" + m[:24], "English" in agent_turn.build_prompt("", [], m).rstrip().split("\n")[-1])

print(("\n%d 紅" % red) if red else "\nALL PASS")
sys.exit(1 if red else 0)
