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
print("ALL PASS" if not red else f"{red} 紅")
sys.exit(1 if red else 0)
