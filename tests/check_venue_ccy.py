"""Minimal check: the desktop app's fallback currency table (shell/renderer/trade.js — CX_VENUES[].ccy
plus TR_VENUE_CCY_OTHER for paper / capital) has exactly one entry per lib/account_*.py, and each
entry equals the `currency` that venue's get_equity() returns (the literal, or the .get() default
for a dynamic value like BingX's row.get("asset", "USDT")). A failed account read writes
currency: null, so this table is what the app labels the amounts with — a new venue that is not
registered here, or a lib that changes its currency, turns this red.

Run: cd blave-agent && python3 tests/check_venue_ccy.py
"""
import ast
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


def lib_currency(path):
    tree = ast.parse(path.read_text(encoding="utf-8"))
    fn = next((n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "get_equity"), None)
    if fn is None:
        return None
    for node in ast.walk(fn):
        if not isinstance(node, ast.Dict):
            continue
        for k, v in zip(node.keys, node.values):
            if not (isinstance(k, ast.Constant) and k.value == "currency"):
                continue
            if isinstance(v, ast.Constant) and isinstance(v.value, str):
                return v.value
            if (isinstance(v, ast.Call) and isinstance(v.func, ast.Attribute) and v.func.attr == "get"
                    and len(v.args) == 2 and isinstance(v.args[1], ast.Constant)):
                return v.args[1].value
            return "<dynamic>"
    return None


libs = {p.stem[len("account_"):]: lib_currency(p) for p in sorted((ROOT / "lib").glob("account_*.py"))
        if p.stem != "account_TEMPLATE"}
check(len(libs) >= 7 and all(isinstance(v, str) and v != "<dynamic>" for v in libs.values()),
      f"every lib/account_*.py get_equity() returns a readable currency ({libs})")

src = (ROOT / "shell" / "renderer" / "trade.js").read_text(encoding="utf-8")
cx = re.search(r"const CX_VENUES = \{(.*?)\};", src, re.S)
other = re.search(r"const TR_VENUE_CCY_OTHER = \{(.*?)\};", src, re.S)
table = {}
if cx:
    for vid, body in re.findall(r"(\w+): \{([^}]*)\}", cx.group(1)):
        m = re.search(r'ccy: "(\w+)"', body)
        table[vid] = m.group(1) if m else None
if other:
    table.update(dict(re.findall(r'(\w+): "(\w+)"', other.group(1))))
check(bool(cx) and bool(other), "trade.js has CX_VENUES and TR_VENUE_CCY_OTHER")
check(set(table) == set(libs), f"one table entry per account lib (table {sorted(table)} vs libs {sorted(libs)})")
check(all(table.get(v) == c for v, c in libs.items()),
      "each entry equals that lib's currency: " + ", ".join(f"{v} {table.get(v)}/{c}" for v, c in sorted(libs.items())))

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
