"""lib/security_check.py refuses downloaded code that signs the Binance stock-perps agreement. No network.

`order_binance.sign_stock_agreement(env, user_consented=True)` is the user's legal consent; the agent may
call it in the conversation after the user's yes, never a downloaded strategy. The scanner only runs on
downloads (--context install|fork), so the conversation path is untouched. Every writing below is a row:
CRITICAL ones must be do-not-run; GAPS are written down as known misses (they need runtime values a
static scan cannot see) and go red the day coverage changes without this table changing with it.
Run: cd blave-agent && .venv/bin/python tests/check_security_sign_block.py
"""
import os, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from lib import security_check as sc

fails = 0
def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1

ENV = 'env = {"BINANCE_API_KEY": "k", "BINANCE_SECRET_KEY": "s"}\n'
FN = "sign_stock" + "_agreement"   # kept split so tests/check_stock_perps' caller grep stays meaningful
CRITICAL = {
    "module attribute": f"from lib import order_binance\n{ENV}order_binance.{FN}(env, user_consented=True)\n",
    "dotted module": f"import lib.order_binance\n{ENV}lib.order_binance.{FN}(env, user_consented=True)\n",
    "import alias": f"import lib.order_binance as ob\n{ENV}ob.{FN}(env, user_consented=True)\n",
    "from-import": f"from lib.order_binance import {FN}\n{ENV}{FN}(env, user_consented=True)\n",
    "from-import alias": f"from lib.order_binance import {FN} as go\n{ENV}go(env, user_consented=True)\n",
    "star import": f"from lib.order_binance import *\n{ENV}{FN}(env, user_consented=True)\n",
    "bound to a name": f"from lib import order_binance as ob\nf = ob.{FN}\n{ENV}f(env, user_consented=True)\n",
    "getattr literal": f'from lib import order_binance as ob\n{ENV}getattr(ob, "{FN}")(env, user_consented=True)\n',
    "getattr concat": f'from lib import order_binance as ob\n{ENV}getattr(ob, "sign_" + "stock_" + "agreement")(env, user_consented=True)\n',
    "getattr f-string": f'from lib import order_binance as ob\n{ENV}getattr(ob, f"sign_{{\'stock\'}}_agreement")(env, user_consented=True)\n',
    "getattr join": f'from lib import order_binance as ob\n{ENV}getattr(ob, "_".join(["sign", "stock", "agreement"]))(env, user_consented=True)\n',
    "module __dict__": f'from lib import order_binance as ob\n{ENV}ob.__dict__["{FN}"](env, user_consented=True)\n',
    "direct _send": f'from lib import order_binance as ob\n{ENV}ob._send("POST", "/fapi/v1/stock/contract", env, plain_text=True)\n',
    "direct _send concat": f'from lib import order_binance as ob\n{ENV}ob._send("POST", "/fapi/v1/" + "stock/contract", env)\n',
    "direct _send split path": f'from lib import order_binance as ob\n{ENV}ob._send("POST", "/fapi/v1/stock" + "/" + "contract", env)\n',
}
GAPS = {
    "reversed literal": f'from lib import order_binance as ob\n{ENV}getattr(ob, "{FN[::-1]}"[::-1])(env, user_consented=True)\n',
    "pieces in variables": f'from lib import order_binance as ob\na, b = "sign_stock", "_agreement"\n{ENV}getattr(ob, a + b)(env, user_consented=True)\n',
    "%-format": f'from lib import order_binance as ob\n{ENV}getattr(ob, "%s_agreement" % "sign_stock")(env, user_consented=True)\n',
    "found by dir()": f'from lib import order_binance as ob\n{ENV}[getattr(ob, n) for n in dir(ob) if n.startswith("sign_")][0](env, user_consented=True)\n',
}
CLEAN = {
    "a stock-perp order and the refusal kind": (
        "from lib import order_binance\n# stock perps: a refused order means the agreement is not signed\n"
        f"{ENV}try:\n    order_binance.place_order('TSLAUSDT', 'BUY', 1, env)\n"
        "except order_binance.BinanceError as e:\n    if 'stock_agreement' in str(e):\n        pass\n"),
}

def scan(src):
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False, encoding="utf-8") as f:
        f.write(src)
    try:
        r = subprocess.run([sys.executable, os.path.join(ROOT, "lib", "security_check.py"), "--context", "install", f.name],
                           capture_output=True, text=True, encoding="utf-8", errors="replace")
        return r.returncode, r.stdout.splitlines(), sc.check(f.name)
    finally:
        os.unlink(f.name)

def signing(findings):
    return [x for x in findings if x["level"] == "CRITICAL" and "stock-perps agreement" in x["msg"]]

for what, src in CRITICAL.items():
    rc, lines, found = scan(src)
    check(rc == 2 and lines[:1] == ["RESULT: do-not-run"] and lines[1].startswith("NEXT: Stop") and signing(found),
          f"{what}: do-not-run, exit 2 ({lines[:1]}, rc={rc})")
    check(len({x['line'] for x in signing(found)}) == len(signing(found)), f"{what}: one finding per line")
for what, src in GAPS.items():
    rc, lines, found = scan(src)
    check(not signing(found), f"known gap, not caught statically: {what}")
for what, src in CLEAN.items():
    rc, lines, found = scan(src)
    check(rc == 0 and lines[:1] == ["RESULT: clean"], f"clean: {what} ({lines[:1]}, {found})")

rc, lines, found = scan(CRITICAL["import alias"])
check(any("Line 3: signs the Binance stock-perps agreement" in l and "never strategy code" in l for l in lines),
      f"the finding names the line and why ({[l for l in lines if 'Line' in l]})")

print(f"\n{'FAIL' if fails else 'PASS'} — {fails} failure(s)")
sys.exit(1 if fails else 0)
