"""建議下一步規則(0.1.26 精簡版,0.1.31 v2 只在里程碑出 1 句):路線對齊 0.1.24 的策略組合流程,<await/> 獨立一節且留在 prompt 最尾端。

- 回測可用 → 加進策略組合(導航句);組合兩支以上 → 組合優化／移動窗格回測;模擬盤穩定 → 小額實盤。
- 新導航句要被 nav_topic 認得,否則 portfolio-steps.md 不注入、UI 標籤亂編(29026)。
- 外語錨的英文例句、逐輪錨的例子不能還寫「上模擬盤」(弱模型照抄最近的例子)。
- v2(spec suggest-next-step-v2 §3):只出 1 句、帶 kind;沒命中里程碑不附;寫了 <await/> 不附;
  --suggest-mode reduced/off 時逐輪錨叫模型把下一步寫進正文最後一句。
"""
import os, shutil, sys, tempfile, types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))
WS = tempfile.mkdtemp(prefix="check-suggest-rule-ws-")
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.setdefault("BLAVE_AGENT_DB", os.path.join(WS, "session.db"))
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
t("<await/> 位置:<export> 之後;寫了 <await/> 的回合不附 <suggest>", "有 `<export … />` 時放在它後面" in A
  and "寫了 `<await/>` 的回合不附 <suggest>" in A and "<suggest> 仍是最後" not in A and "建議列不算等回覆" not in A)

t("回測可用 → 加進策略組合(導航句),不再是上模擬盤",
  "結論是可以用 → 「帶我看怎麼把〈策略名〉加進策略組合」" in S and "上模擬盤" not in S)
t("組合兩支以上 → 組合優化／移動窗格回測", "策略組合裡已有兩支以上策略 → 「幫我跑一次組合優化」或「跑移動窗格回測」" in S)
t("模擬盤穩定 → 小額實盤,且跟加進策略組合互斥", "已在模擬盤上（上線現況有金額、模擬交易已連接）" in S and "不再提「加進策略組合」" in S
  and "加密或台指期 → 「帶我看怎麼把〈策略名〉上小額實盤」" in S)
t("台股不建議真帳自動下單,改看持股", "台股（個股、ETF）→ 「到策略組合看〈策略名〉的持股」" in S and "股票策略不提實盤、券商" in S)
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
t("拒絕過的不重提", "明確拒絕" in S and "同一階段的建議不重提" in S)
t("v2 只在里程碑出:沒命中不附、「沒命中也寫成 <suggest>」那條刪掉", "沒命中就不附" in S and "沒命中、但你想在結尾提議下一步" not in S)
t("v2 不附建議的回合列明(問答、除錯中、用戶已講明、等回答、重複句)",
  all(k in S for k in ("市場問答、資料查詢、報價、概念解釋、寒暄", "除錯或排查還在進行", "用戶這句已經講明下一步要做什麼",
                       "這一輪在等用戶回答", "跟上一輪一模一樣的句子")))
t("v2 只寫 1 句、填進輸入框不是原句送出;一般句 ≤20 字、導航句不限", "只寫 1 句" in S and "最多 3" not in S and "原句送出" not in S
  and "填進用戶的輸入框" in S and "一般句 ≤20 字" in S and "英文 ≤48 字元" in S and "不限長度" in S)
t("v2 step 範本改短", all(k in S for k in ("「掃〈策略名〉的參數找穩定區」", "「幫〈策略名〉加 vol targeting」", "「幫〈策略名〉加趨勢濾網」",
                                           "「幫〈標的〉換一種進場訊號」", "「回測〈策略名〉」")))
t("研究題答完、還沒做成報告是里程碑(同 references/reports.md)", "- 研究／分析題答完、還沒做成報告 → 「做成報告」" in S
  and "one of the suggestion milestones" in open(os.path.join(ROOT, "references", "reports.md"), encoding="utf-8").read())
t("turn-events.md:<await/> 那輪不附 <suggest>", "A turn that writes `<await/>` carries no `<suggest>` block." in open(os.path.join(ROOT, "references", "turn-events.md"), encoding="utf-8").read())
t("B4 禁止在同一訊號加東西只管主動提的建議", "（只管你主動提的建議；用戶自己要求的照做，見 AGENTS.md）" in S)
t("_SUGGEST_MAX_ITEMS = 1", at._SUGGEST_MAX_ITEMS == 1)
_, items = at.extract_suggestions("好。\n<suggest>\n一\n二\n三\n</suggest>")
t("extract_suggestions 只留第一句", items == ["一"], items)
for line, want in (("帶我看怎麼把 A 加進策略組合", "nav"), ("  带我看怎么先绑模拟盘账户", "nav"), ("SHOW ME HOW to add A", "nav"),
                   ("Show me how to go live", "nav"), ("回測 A", "step"), ("掃 A 的參數找穩定區", "step"), ("Mostrar cómo", "step"), ("", "step")):
    t(f"suggest_kind({line!r}) = {want}", at.suggest_kind(line) == want)

# suggestions chunk 帶 kind(WebSink.finalize;LocalSink 同一支)
class _S(at.LocalSink):
    def __init__(self):
        super().__init__("desktop-test0000")
        self.sent = []

    def _send(self, chunk):
        self.sent.append(chunk)


for reply, kind in (("好。\n<suggest>\n帶我看怎麼把 A 加進策略組合\n</suggest>", "nav"),
                    ("好。\n<suggest>\n回測 A\n二\n</suggest>", "step")):
    s = _S()
    s.on_text(reply)
    s.finalize()
    sug = [c for c in s.sent if c.get("type") == "suggestions"]
    t(f"suggestions chunk 帶 kind={kind}、只一句", len(sug) == 1 and sug[0].get("kind") == kind and len(sug[0]["items"]) == 1, s.sent)

# 逐輪錨隨 suggest_mode 換
pn = at.build_prompt(None, None, "這支值得用嗎", suggest_directive=True)
pr = at.build_prompt(None, None, "這支值得用嗎", suggest_directive=True, suggest_mode="reduced")
po = at.build_prompt(None, None, "這支值得用嗎", suggest_directive=True, suggest_mode="off")
px = at.build_prompt(None, None, "這支值得用嗎", suggest_directive=True, suggest_mode="weird")
t("normal 逐輪錨 = spec §3.4 那句", "[結尾規則:只有命中里程碑才在最後附 <suggest>(1 句、用戶口吻;一般句 ≤20 字,「帶我看怎麼」開頭的不限);其他回合寫完答案就結束,不提議、不用問句收尾。" in pn)
t("reduced:導航類照附、其他改寫進正文最後一句直述", "命中導航類里程碑照樣在最後附 <suggest>" in pr and "正文最後寫一句直述的下一步" in pr and "只有命中里程碑才在最後附" not in pr)
t("off:不附 <suggest>、改寫進正文", "這一輪不附 <suggest>" in po and "正文最後寫一句直述的下一步" in po)
t("怪值當 normal", px == pn)
t("三種模式都不用問句收尾、都帶同方向", all("不用問句收尾" in p and "建議跟本則結論同方向" in p for p in (pn, pr, po)))
t("TG(suggest_directive=False)沒有結尾規則", "[結尾規則" not in at.build_prompt(None, None, "hi", suggest_mode="off"))
src = open(os.path.join(ROOT, "runtime", "agent_turn.py"), encoding="utf-8").read()
t("argparse 收 --suggest-mode(choices、預設 normal)並傳進 run_turn",
  'parser.add_argument("--suggest-mode", default="normal", choices=["normal", "reduced", "off"])' in src and "suggest_mode=args.suggest_mode" in src)
t("英文導航句", "Show me how to add 〈strategy name〉 to the portfolio" in S)

for msg in ("帶我看怎麼把 BTC 4h 均線交叉加進策略組合", "带我看怎么把 BTC 4h 均线交叉加进策略组合",
            "Show me how to add BTC 4h MA crossover to the portfolio", "帶我看怎麼把 BTC 4h 均線交叉上小額實盤"):
    t(f"nav_topic 認得導航句:{msg}", at.nav_topic(msg))
t("單純問組合優化不算導航", not at.nav_topic("組合優化怎麼算的"))

pin = at._REPLY_LANG_PINS["es"][1]
t("外語錨的英文例句換成加進策略組合", "Show me how to add 〈strategy name〉 to the portfolio" in pin and "paper trade" not in pin)
p = at.build_prompt(None, None, "這支值得用嗎", suggest_directive=True)
t("逐輪錨的例子不再寫上模擬盤", "[結尾規則:" in p and "上模擬盤" not in p.split("[結尾規則:")[1])

shutil.rmtree(WS, ignore_errors=True)
if fails:
    sys.exit(f"{len(fails)} failed")
print("all passed")
