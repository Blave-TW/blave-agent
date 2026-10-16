"""建議下一步規則(0.1.26 精簡版):路線對齊 0.1.24 的策略組合流程,<await/> 獨立一節且留在 prompt 最尾端。

- 回測可用 → 加進策略組合(導航句);組合兩支以上 → 組合優化／移動窗格回測;模擬盤穩定 → 小額實盤。
- 新導航句要被 nav_topic 認得,否則 portfolio-steps.md 不注入、UI 標籤亂編(29026)。
- 外語錨的英文例句、逐輪錨的例子不能還寫「上模擬盤」(弱模型照抄最近的例子)。
"""
import os, sys, types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))
sys.modules["claude_agent_sdk"] = types.ModuleType("claude_agent_sdk")
import agent_turn as at  # noqa: E402

fails = []


def t(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else f" — {detail}"))
    if not cond:
        fails.append(name)


S, A = at._SUGGEST_RULE, at._AWAIT_RULE
for name in ("WEB_FORMATTING_RULE", "LOCAL_FORMATTING_RULE"):
    t(f"{name} 最後一節是 <await/> 規則,前一節是建議規則", getattr(at, name).endswith(S + A))
t("<await/> 規則只在獨立那一節", "<await/>" in A and "<await/>" not in S)
t("<await/> 位置:<export> 之後、<suggest> 之前", "有 `<export … />` 時放在它後面" in A and "<suggest> 仍是最後" in A)

t("回測可用 → 加進策略組合(導航句),不再是上模擬盤",
  "結論是可以用 → 「帶我看怎麼把〈策略名〉加進策略組合」" in S and "上模擬盤" not in S)
t("組合兩支以上 → 組合優化／移動窗格回測", "策略組合裡已有兩支以上策略 → 「幫我跑一次組合優化」或「跑移動窗格回測」" in S)
t("模擬盤穩定 → 小額實盤,且跟加進策略組合互斥", "已在模擬盤上（上線現況有金額、模擬交易已連接）" in S and "不再提「加進策略組合」" in S
  and "加密或台指期 → 「帶我看怎麼把〈策略名〉上小額實盤」" in S)
t("台股不建議真帳自動下單,改看持股手動下單", "台股（個股、ETF）→ 「到策略組合看〈策略名〉的持股，照著手動下單」" in S and "股票策略不提實盤、券商" in S)
t("看持股手動下單不是導航句(不注入部署步驟)", not at.nav_topic("到策略組合看台積電日線均線交叉的持股，照著手動下單"))
line = at._deploy_state_line("/nonexistent-ws")
t("上線現況不再一刀切「不要再建議上線」(會擋掉模擬盤→小額實盤)", "不要再建議上線(" not in line and "在模擬交易上跑穩的,下一步是換真倉小額跑" in line, line)
steps = open(os.path.join(ROOT, "references", "portfolio-steps.md"), encoding="utf-8").read()
t("設金額步驟走策略組合 › 配置(0.1.24),不再是自動下單 › 部位",
  steps.count("點左側「策略組合」，切到「配置」分頁") == 2 and "切到「部位」分頁" not in steps and steps.count("「到自動下單啟動」") == 2)
t("股票真帳沒有步驟,改看持股手動下單", "futures-only" in steps and "by hand" in steps)
t("MCPT 沒過只提換訊號,明文禁止掃參數等在同一訊號上加東西", "MCPT p-value > 0.05" in S and "只提換訊號" in S
  and "**禁止**提在同一個訊號上加東西（濾網、調參數、掃參數、vol targeting 都算，參數是手挑的也一樣）" in S and "而且訊號站得住的策略" in S)
t("正文不用問句提議、也不列方向問用戶挑", "禁止在正文結尾用問句提議，也不在正文列出幾個方向問用戶挑哪個" in S and "「哪個先試？」" in S)
t("拒絕過的不重提", "明確拒絕" in S and "同一階段不重提" in S)
t("英文導航句", "Show me how to add 〈strategy name〉 to the portfolio" in S)

for msg in ("帶我看怎麼把 BTC 4h 均線交叉加進策略組合", "带我看怎么把 BTC 4h 均线交叉加进策略组合",
            "Show me how to add BTC 4h MA crossover to the portfolio", "帶我看怎麼把 BTC 4h 均線交叉上小額實盤"):
    t(f"nav_topic 認得導航句:{msg}", at.nav_topic(msg))
t("單純問組合優化不算導航", not at.nav_topic("組合優化怎麼算的"))

pin = at._REPLY_LANG_PINS["es"][1]
t("外語錨的英文例句換成加進策略組合", "Show me how to add 〈strategy name〉 to the portfolio" in pin and "paper trade" not in pin)
p = at.build_prompt(None, None, "這支值得用嗎", suggest_directive=True)
t("逐輪錨的例子不再寫上模擬盤", "[結尾規則:" in p and "上模擬盤" not in p.split("[結尾規則:")[1])

if fails:
    sys.exit(f"{len(fails)} failed")
print("all passed")
