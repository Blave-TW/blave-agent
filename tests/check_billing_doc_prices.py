"""references/billing.md 的方案月價表 = api account/agent_plan_config.py 的 TIERS(逐階比對)。
改 api 價格沒同步這份文件(與 bump 根 VERSION)時這支紅。找不到 api(不是 monorepo 版面、或 api 還沒有那個檔)就 SKIP。

Run: python tests/check_billing_doc_prices.py      (BLAVE_API_DIR 可另指 api)
"""
import ast
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = os.environ.get("BLAVE_API_DIR") or os.path.join(ROOT, "..", "api")
CFG = os.path.join(API, "account", "agent_plan_config.py")
if not os.path.exists(CFG):
    print(f"SKIP  找不到 {CFG}")
    sys.exit(0)

tree = ast.parse(open(CFG, encoding="utf-8").read())
tiers = next(ast.literal_eval(n.value) for n in tree.body
             if isinstance(n, ast.Assign) and any(getattr(t, "id", None) == "TIERS" for t in n.targets))
doc = open(os.path.join(ROOT, "references", "billing.md"), encoding="utf-8").read()
rows = {(m.group(1).lower(), m.group(2).lower()): int(m.group(3).replace(",", ""))
        for m in re.finditer(r"^\| (Linux|Windows) \| (Starter|Premium|Max)[^|]*\|[^|]*\| ([\d,]+) \|", doc, re.M)}
red = 0
for key, t in tiers.items():
    # agent 階(改價 v3,不含主機)不在 Meter 1 那張主機價表上,下面另外比;其他沒有 os_type 的階照樣要對得上表(對不上就紅)
    if key == "agent" or not t.get("orderable") or t.get("monthly_twd") is None:
        continue
    want = t["monthly_twd"]
    got = rows.get((t["os_type"], t["label"].lower()))
    ok = got == want
    red += not ok
    print(("PASS  " if ok else "FAIL  ") + f"{key}: api {want} / billing.md {got}")
# Agent 方案價:billing.md 有寫「888 TWD per 30 days」這類句子時,數字必須等於 TIERS["agent"];沒寫(新價公告前)就不比
agent = tiers.get("agent")
if agent and agent.get("monthly_twd"):
    stated = [int(m.group(1).replace(",", "")) for m in re.finditer(r"(?i)(?:Agent plan|The plan)[^\n|]{0,40}?\b([\d,]{3,6}) TWD per 30 days", doc)]
    ok = all(v == agent["monthly_twd"] for v in stated)
    red += not ok
    print(("PASS  " if ok else "FAIL  ") + f"agent: api {agent['monthly_twd']} / billing.md {stated or '沒寫(不比)'}")
addon = next((ast.literal_eval(n.value) for n in tree.body
              if isinstance(n, ast.Assign) and any(getattr(t, "id", None) == "V3_ADDON_MONTHLY_TWD" for t in n.targets)), None)
if addon is None:
    print("SKIP  api 還沒有 V3_ADDON_MONTHLY_TWD:不比 Agent plan 那張加購表")
else:
    plan = tiers["agent"]["monthly_twd"]
    names = {"starter": "Basic", "premium": "Advanced", "max": "Top"}
    v3rows = {(m.group(1).lower(), m.group(2)): (int(m.group(3).replace(",", "")), int(m.group(4).replace(",", "")))
              for m in re.finditer(r"^\| (Linux|Windows) (Basic|Advanced|Top)[^|]*\|[^|]*\| \+([\d,]+) \| ([\d,]+) \|", doc, re.M)}
    for key, add in addon.items():
        os_, size = key.split("_")
        got = v3rows.get((os_, names[size]))
        ok = got == (add, plan + add)
        red += not ok
        print(("PASS  " if ok else "FAIL  ") + f"v3 {key}: api +{add} / {plan + add},billing.md {got}")
    ok = f"**The plan: {plan:,} TWD per 30 days**" in doc and len(v3rows) == len(addon)
    red += not ok
    print(("PASS  " if ok else "FAIL  ") + f"v3 方案價 {plan} 寫在 Agent plan 那一節、加購表列數 = api")
# 對外不寫 AI 額度數字（改價後的方案每期、試用都一樣）：提到 AI credit／allowance 的條列裡不能有裸的額度數字。
# 放行錢包儲值的句型（自動儲值 300 TWD into the wallet、Top-up sizes 那列）。
CREDIT = os.path.join(API, "account", "agent_ai_credit.py")
if os.path.exists(CREDIT):
    ctree = ast.parse(open(CREDIT, encoding="utf-8").read())
    grants = [ast.literal_eval(n.value) for n in ctree.body if isinstance(n, ast.Assign)
              and any(getattr(t, "id", None) in ("GRANT_PERIOD_TWD", "GRANT_TRIAL_TWD") for t in n.targets)]
    # 電腦版登入送的 AI 額度也不對外講
    ftree = ast.parse(open(os.path.join(API, "account", "agent_free_credit.py"), encoding="utf-8").read())
    grants += [ast.literal_eval(n.value) for n in ftree.body if isinstance(n, ast.Assign)
               and any(getattr(t, "id", None) == "FREE_AI_CREDIT" for t in n.targets)]
    # 匯率（30 TWD/USD）與天數（30 days、30-day、30 d）不是額度
    ALLOW = re.compile(r"\b\d[\d,]* TWD into the wallet|Top-up sizes:[^\n]*|\b30 TWD/USD|\b30(?:-day| days?\b| d\b)")

    def grant_hits(text):
        # 以條列（空行或下一個 "- " 為界）為單位：一句話跨行時數字與 "credit" 常不在同一行
        items = re.split(r"\n(?=\s*- |\s*\n)", text)
        return [" ".join(it.split())[:90] for it in items if re.search(r"(?i)\bAI credit|\ballowance\b|sign-in credit", it)
                and any(re.search(rf"(?<![\d,.]){g}(?![\d,])", ALLOW.sub("", it)) for g in grants)]

    must_red = ["- The plan includes 300 TWD AI credit.", "- AI credit: 300 TWD per period.",
                "- Trial: 150 TWD in AI credit.", "- Annual plans get 300 every 30 days of AI credit.",
                "- The trial's own allowance is 150.", "- Then the 30 TWD sign-in credit, then the wallet.",
                "- Sign-in credit: 30 TWD of AI credit."]
    must_pass = ["- Auto top-up charges 300 TWD into the wallet; AI credit comes first.",
                 "- Top-up sizes: 300 / 800 / 1500 / 3000 TWD. AI credit is separate.",
                 "- AI credit: 1,300 users.", "- AI credit follows the 30-day period, renewed every 30 days.",
                 "- AI credit is billed in TWD; the site shows USD at 30 TWD/USD."]
    ok = (len(grants) == 3 and all(grant_hits(x) for x in must_red) and not any(grant_hits(x) for x in must_pass))
    red += not ok
    print(("PASS  " if ok else "FAIL  ") + f"額度數字偵測自我檢查(額度 {grants})")
    hits = grant_hits(doc)
    red += bool(hits)
    print(("PASS  " if not hits else "FAIL  ") + f"billing.md 講 AI credit／allowance 的條列沒有額度數字:{hits or '無'}")
print("ALL PASS" if not red else f"{red} 紅")
sys.exit(1 if red else 0)
