"""Taiwan-broker branches go through lib/venue_traits.py — no network.

1. Enumeration: every string constant equal to a TW broker id in manager/,
   lib/ and runtime/ (.py, via ast — docstrings, f-string messages and
   regexes that merely mention the name are not branches) sits in the trait
   table or in that broker's own files. A new `== "capital"` anywhere else
   fails here, so a broker's behaviour stays readable from one table.
2. runtime/venue_traits.py is byte-identical to lib/venue_traits.py (the
   runtime ships on its own channel and cannot import the workspace's copy).
3. Every hand_wired venue has a reconciler block and vice versa — a routed
   hand_wired venue without one would otherwise fall through to the crypto
   auto-wire with lot counts.
4. The derived venue sets match what the table encodes today.

Run: cd blave-agent && python3 tests/check_venue_traits.py
"""
import ast, os, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

fails = 0


def check(cond, msg, detail=None):
    global fails
    print(("ok   " if cond else "FAIL ") + msg + ("" if cond or detail is None else f"  {detail}"))
    fails += 0 if cond else 1


TW_IDS = ("capital", "sinopac", "president")
TABLES = {"lib/venue_traits.py", "runtime/venue_traits.py"}
OWN = {
    "capital": {"lib/order_capital.py", "lib/account_capital.py", "lib/capital_worker.py",
                "lib/capital_vault.py", "runtime/capital_connect.py"},
    "sinopac": {"lib/order_sinopac.py"},
    "president": {"lib/order_president.py", "lib/account_president.py", "lib/president_worker.py",
                  "lib/president_vault.py"},
}


def literals(src):
    """(lineno, value) for every str constant naming a TW broker id."""
    out = []
    for node in ast.walk(ast.parse(src)):
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and node.value in TW_IDS:
            out.append((node.lineno, node.value))
    return out


# the scanner itself must see the shapes it is meant to catch
probe = 'if vid == "capital":\n    pass\nx = {"sinopac", "president"}\ny = f"capital: {z}"\n"""capital"""\n'
check(sorted(v for _, v in literals(probe)) == ["capital", "capital", "president", "sinopac"],
      "scanner catches ==, set members and a bare docstring equal to the id, not f-string text",
      literals(probe))

hits = []
for top in ("manager", "lib", "runtime"):
    for dirpath, _, files in os.walk(os.path.join(ROOT, top)):
        for f in sorted(files):
            if not f.endswith(".py"):
                continue
            rel = os.path.relpath(os.path.join(dirpath, f), ROOT).replace(os.sep, "/")
            if rel in TABLES:
                continue
            with open(os.path.join(ROOT, rel), encoding="utf-8") as fh:
                for lineno, value in literals(fh.read()):
                    if rel not in OWN[value]:
                        hits.append(f"{rel}:{lineno} {value!r}")
check(not hits, "no TW broker id literal outside lib/venue_traits.py and the broker's own files",
      hits)

with open(os.path.join(ROOT, "lib", "venue_traits.py"), "rb") as a, \
        open(os.path.join(ROOT, "runtime", "venue_traits.py"), "rb") as b:
    check(a.read() == b.read(), "runtime/venue_traits.py is a byte-identical copy of lib/venue_traits.py")

os.chdir(tempfile.mkdtemp(prefix="vtraits-"))
os.makedirs("manager", exist_ok=True)
open("manager/portfolio_config.json", "w").write("{}")

from lib import venue_traits  # noqa: E402
from lib import venue_wiring  # noqa: E402
from manager import close_symbol, reconciler  # noqa: E402

check(set(reconciler._HAND_WIRED) == set(venue_traits.venues("hand_wired")),
      "reconciler._HAND_WIRED covers exactly the hand_wired venues",
      (sorted(reconciler._HAND_WIRED), sorted(venue_traits.venues("hand_wired"))))
check(venue_wiring._NON_AUTO == {"sinopac", "president", "capital"}, "venue_wiring._NON_AUTO",
      venue_wiring._NON_AUTO)
check(close_symbol._NOT_PERP == {"capital", "sinopac", "president"}, "close_symbol._NOT_PERP",
      close_symbol._NOT_PERP)
check(venue_traits.venues("hand_wired") == {"capital"}, "hand_wired venues")
check(venue_traits.venues("native_units") == {"capital"}, "native_units venues")
check(venue_traits.venues("windows_identity") == {"capital"}, "windows_identity venues")
check(venue_traits.hand_wired_routed(["binance", "capital"]) == "capital"
      and venue_traits.hand_wired_routed(["binance", ""]) is None
      and venue_traits.hand_wired_routed(["Capital"]) is None,
      "hand_wired_routed: exact id match, first hit, None otherwise")
check(not venue_traits.has(None, "hand_wired") and venue_traits.get(None, "perp") is True
      and venue_traits.get(["capital"], "auto_wire") is True,
      "non-str venue ids get the crypto defaults")

try:
    reconciler._hand_wired_impl("nosuchbroker")
    check(False, "a hand_wired venue without a reconciler block raises")
except RuntimeError:
    check(True, "a hand_wired venue without a reconciler block raises")

print(f"\n{'FAILED: ' + str(fails) if fails else 'all passed'}")
sys.exit(1 if fails else 0)
