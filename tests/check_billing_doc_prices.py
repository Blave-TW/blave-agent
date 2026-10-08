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
    if not t.get("orderable") or t.get("monthly_twd") is None:
        continue
    want = t["monthly_twd"]
    got = rows.get((t["os_type"], t["label"].lower()))
    ok = got == want
    red += not ok
    print(("PASS  " if ok else "FAIL  ") + f"{key}: api {want} / billing.md {got}")
print("ALL PASS" if not red else f"{red} 紅")
sys.exit(1 if red else 0)
