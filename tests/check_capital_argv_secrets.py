"""Secrets on a child's command line in runtime/capital_connect.py (recheck audit C-1).

Two known sites are accepted and documented in the module docstring (Known limit):
schtasks /rp <Administrator password> and certutil -p <export password>. This check
enumerates every subprocess call whose argv list names a password-like variable and
fails if the set differs — a new site, or a fixed one still listed as known.
Run: cd blave-agent && python3 tests/check_capital_argv_secrets.py
"""
import ast, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "runtime", "capital_connect.py")
SECRET_NAMES = {"pw", "admin_pw", "password", "passwd", "secret", "export_pw", "trade_pw"}
CALLS = {"run", "Popen", "check_output", "check_call", "call", "_run_quiet"}
KNOWN = {("_as_administrator", "admin_pw"), ("_certutil_import", "pw")}

tree = ast.parse(open(SRC, encoding="utf-8").read())
found = set()
for fn in ast.walk(tree):
    if not isinstance(fn, ast.FunctionDef):
        continue
    for call in ast.walk(fn):
        if not isinstance(call, ast.Call) or not call.args:
            continue
        name = call.func.attr if isinstance(call.func, ast.Attribute) else getattr(call.func, "id", "")
        if name not in CALLS or not isinstance(call.args[0], (ast.List, ast.Tuple)):
            continue
        for el in call.args[0].elts:
            for n in ast.walk(el):
                if isinstance(n, ast.Name) and n.id in SECRET_NAMES:
                    found.add((fn.name, n.id))
doc = ast.get_docstring(tree) or ""
ok1 = found == KNOWN
ok2 = "Known limit (audit C-1" in doc and "/rp" in doc and "certutil" in doc
print(("PASS" if ok1 else "FAIL") + f"  secrets on argv are exactly the two documented sites: {sorted(found)}")
print(("PASS" if ok2 else "FAIL") + "  the module docstring states the known limit and why")
sys.exit(0 if ok1 and ok2 else 1)
