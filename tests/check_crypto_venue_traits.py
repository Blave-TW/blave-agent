"""Crypto-venue branches in the shared order path go through lib/venue_traits.py — no network.

The crypto mirror of tests/check_venue_traits.py (which keeps TW broker ids out of shared files).

1. Enumeration: every string constant equal to a crypto venue id (or its order_ / account_
   module name) in the shared order-path files (ast — comments, docstrings' text inside
   f-strings and regexes are not branches) is on ALLOWED below, keyed by file + enclosing
   function (or module-level assignment) + value, with a count. A new `vid == "okx"` fails
   here: the behaviour belongs in a venue_traits cell every venue declares.
2. Every crypto lib/order_<id>.py (git ls-files; TW brokers and the template aside) has a
   venue_traits row that declares instrument_class and binance_name_gate explicitly — a venue
   that cannot report its class says so in the table, not by being absent from it.
3. Parametrised over those venues: lib.venue_wiring.instrument_gate does what the row says,
   and a venue whose row names a class reads it from its own get_contract_rules ("category").

Run: cd blave-agent && .venv/bin/python tests/check_crypto_venue_traits.py
"""
import ast, collections, importlib, os, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

fails = 0


def check(cond, msg, detail=None):
    global fails
    print(("ok   " if cond else "FAIL ") + msg + ("" if cond or detail is None else f"  {detail}"))
    fails += 0 if cond else 1


from lib import venue_traits  # noqa: E402

tracked = subprocess.run(["git", "-C", ROOT, "ls-files", "lib/order_*.py"], capture_output=True,
                         text=True, check=True).stdout.split()
TW = venue_traits.venues("auto_wire", False) | venue_traits.venues("hand_wired")
ORDER_IDS = sorted({os.path.basename(f)[len("order_"):-3] for f in tracked} - {"TEMPLATE"} - TW)
EXCHANGES = set(ORDER_IDS) - {"paper"}   # 'paper' is the simulator, not a venue name to branch on
NAMES = EXCHANGES | {f"{k}_{v}" for v in EXCHANGES for k in ("order", "account")} \
    | {f"lib.{k}_{v}" for v in EXCHANGES for k in ("order", "account")}

SHARED = ("lib/venue_wiring.py", "lib/execute.py", "lib/portfolio.py", "manager/flatten.py",
          "manager/reconciler.py", "lib/data.py", "manager/close_symbol.py")
# what is there today, each with why it is not a venue branch to move into the table
ALLOWED = {
    # Binance is the data source: the verdict "compare with Binance's bars"
    ("lib/venue_wiring.py", "_BARS_DEFAULT", "binance"): 1,
    # Bybit spot buys carry no fee asset (its buy fee is always the base coin, measured)
    ("lib/venue_wiring.py", "spot_book_qty", "bybit"): 1,
    # BLAVE_KLINE_SOURCE=binance: where fetch_kline reads bars, not an order venue
    ("lib/data.py", "fetch_kline", "binance"): 1,
    ("lib/data.py", "fetch_kline_batch", "binance"): 1,
    ("lib/portfolio.py", "_daily_sigma", "binance"): 1,
    # the Blave API's `exchange` parameter of these two series (data, not orders)
    ("lib/data.py", "fetch_funding_rate", "binance"): 2,
    ("lib/data.py", "_OI_HISTORY_START", "binance"): 1,
    ("lib/data.py", "_OI_HISTORY_START", "bybit"): 1,
    ("lib/data.py", "fetch_open_interest_history", "binance"): 2,
    # close_symbol is the user's one-off close, keys named by flag, not the reconciler's path:
    # Gate.io's two .env spellings, and OKX's passphrase flag
    ("manager/close_symbol.py", "_HEADS", "gateio"): 1,
    ("manager/close_symbol.py", "_VENUE_WORDS", "gateio"): 1,
    ("manager/close_symbol.py", "resolve_keys", "okx"): 2,
    # each lib's measured open-order / cancel-all coverage, and OKX's separate algo-order API
    # (CLOSE_ALGO_ORD_TYPES); the reconciler does not cancel orders this way
    ("manager/close_symbol.py", "_CONDITIONAL_IN_REGULAR", "order_bingx"): 1,
    ("manager/close_symbol.py", "_CANCEL_ALL_COVERS_CONDITIONAL", "order_bingx"): 1,
    ("manager/close_symbol.py", "_CANCEL_ALL_COVERS_CONDITIONAL", "order_binance"): 1,
    ("manager/close_symbol.py", "_CANCEL_ALL_COVERS_CONDITIONAL", "order_gateio"): 1,
    ("manager/close_symbol.py", "_CANCEL_ALL_COVERS_CONDITIONAL", "order_bybit"): 1,
    ("manager/close_symbol.py", "_CANCEL_ALL_COVERS_CONDITIONAL", "order_stockcoin"): 1,
    ("manager/close_symbol.py", "_CANCEL_ALL_COVERS_CONDITIONAL", "order_bitget"): 1,
    ("manager/close_symbol.py", "_algo_rows", "order_okx"): 1,
    ("manager/close_symbol.py", "_cancel", "order_okx"): 1,
}


def literals(src):
    """Counter of (scope, value) for every str constant naming a crypto venue; scope = the
    innermost def, else the module-level assignment target, else '<module>'."""
    out = collections.Counter()

    def visit(node, scope):
        for child in ast.iter_child_nodes(node):
            s = scope
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                s = child.name
            elif scope == "<module>" and isinstance(child, (ast.Assign, ast.AnnAssign)):
                tgt = child.targets[0] if isinstance(child, ast.Assign) else child.target
                s = tgt.id if isinstance(tgt, ast.Name) else scope
            if isinstance(child, ast.Constant) and isinstance(child.value, str) and child.value in NAMES:
                out[(s, child.value)] += 1
            visit(child, s)

    visit(ast.parse(src), "<module>")
    return out


probe = ('X = {"okx": 1}\ndef f(vid):\n    if vid == "bybit":\n        pass\n'
         '    y = f"okx: {vid}"\n    import_module("lib.order_gateio")\n    """okx"""\n')
check(literals(probe) == collections.Counter({("X", "okx"): 1, ("f", "bybit"): 1,
                                              ("f", "lib.order_gateio"): 1, ("f", "okx"): 1}),
      "scanner catches dict keys, ==, module names and a bare docstring equal to the id, "
      "not f-string text", literals(probe))
check(EXCHANGES >= {"binance", "bingx", "bitget", "bybit", "gateio", "okx", "stockcoin"},
      "the crypto venues are enumerated from lib/order_*.py", sorted(EXCHANGES))

found = collections.Counter()
for rel in SHARED:
    with open(os.path.join(ROOT, rel), encoding="utf-8") as fh:
        for (scope, value), n in literals(fh.read()).items():
            found[(rel, scope, value)] += n
extra = {k: n for k, n in found.items() if n > ALLOWED.get(k, 0)}
check(not extra, "no crypto venue id literal in the shared order path beyond ALLOWED "
                 "(a venue branch is a venue_traits cell)", extra)
stale = {k: n for k, n in ALLOWED.items() if found.get(k, 0) < n}
check(not stale, "ALLOWED is not looser than the code (shrink it when a literal goes)", stale)

# ── 2. every crypto order lib declares both cells ─────────────────────────────
CLASS_VALUES = {None, "stock", "coin_stock_commodity"}
for vid in ORDER_IDS:
    row = venue_traits.TRAITS.get(vid, {})
    check("instrument_class" in row and row["instrument_class"] in CLASS_VALUES,
          f"{vid}: venue_traits declares instrument_class ({row.get('instrument_class')!r})")
    check("binance_name_gate" in row and isinstance(row["binance_name_gate"], bool),
          f"{vid}: venue_traits declares binance_name_gate ({row.get('binance_name_gate')!r})")
    # instrument_gate returns before the name gate on a venue with no class to compare
    check(not row.get("binance_name_gate") or row.get("instrument_class") is not None,
          f"{vid}: binance_name_gate on only with an instrument_class (else it never runs)")
    if row.get("instrument_class") or row.get("binance_name_gate"):
        check(bool(row.get("label")), f"{vid}: a gated venue has a label for the refusal")
    if row.get("instrument_class"):
        with open(os.path.join(ROOT, "lib", f"order_{vid}.py"), encoding="utf-8") as fh:
            tree = ast.parse(fh.read())
        fn = next((n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "get_contract_rules"), None)
        keys = {k.value for d in ast.walk(fn) if isinstance(d, ast.Dict) for k in d.keys
                if isinstance(k, ast.Constant)} if fn else set()
        check({"category", "equity"} <= keys,
              f"{vid}: get_contract_rules returns 'category' and 'equity' (the class the gate reads)",
              sorted(keys))
with open(os.path.join(ROOT, "lib", "venue_traits.py"), "rb") as a, \
        open(os.path.join(ROOT, "runtime", "venue_traits.py"), "rb") as b:
    check(a.read() == b.read(), "runtime/venue_traits.py is a byte-identical copy of lib/venue_traits.py")

# ── 3. instrument_gate follows the row, venue by venue ───────────────────────
os.chdir(tempfile.mkdtemp(prefix="cvtraits-"))
from lib import venue_wiring as vw  # noqa: E402

venue = [None]
vw.read_env = lambda path=".env": {}
vw.detect_venue = lambda env: venue[0]
BINANCE = {"COINX": "COIN", "STOCKX": "EQUITY", "GOLDX": "COMMODITY"}
vw._binance_class = lambda sym: BINANCE.get(sym[:-4])
vw._binance_lists_none_of = lambda sym: sym[:-4] not in BINANCE
venue_rows = {}


def refused(sym):
    try:
        vw.instrument_gate(sym)
    except RuntimeError as e:
        return str(e)
    return None


for vid in ORDER_IDS:
    lib = importlib.import_module(f"lib.order_{vid}")
    real = getattr(lib, "get_contract_rules", None)
    lib.get_contract_rules = lambda env, sym: venue_rows[sym]
    venue[0] = vid
    cls, names = venue_traits.get(vid, "instrument_class"), venue_traits.get(vid, "binance_name_gate")
    label = venue_traits.get(vid, "label")
    venue_rows.update({"COINXUSDT": {"equity": True, "category": "EQUITY"},     # a stock on the venue
                       "STOCKXUSDT": {"equity": False, "category": "COIN" if cls == "coin_stock_commodity" else None},
                       "GOLDXUSDT": {"equity": True, "category": "EQUITY"},
                       "NONEUSDT": {"equity": False, "category": None}})
    stock_v_coin, coin_v_stock = refused("COINXUSDT"), refused("STOCKXUSDT")
    if cls:
        check(stock_v_coin is not None and label in stock_v_coin and coin_v_stock is not None,
              f"{vid} ({cls}): its stock vs a Binance coin and its coin vs a Binance stock are refused, "
              f"named {label}")
        check(refused("GOLDXUSDT") is not None,
              f"{vid} ({cls}): its stock vs a Binance commodity is refused (one class path for all)")
    else:
        check(stock_v_coin is None and coin_v_stock is None and refused("GOLDXUSDT") is None,
              f"{vid}: instrument_class None — not compared (today's behaviour, declared)")
    pepe = refused("NONEUSDT")
    if cls and names:
        check(pepe is not None and "Binance 沒有同名合約" in pepe and label in pepe,
              f"{vid}: a ticker Binance does not list is refused (binance_name_gate)")
    else:
        check(pepe is None, f"{vid}: binance_name_gate off — a ticker Binance does not list passes")
    if real is not None:
        lib.get_contract_rules = real

print(f"\n{'FAILED: ' + str(fails) if fails else 'all passed'}")
sys.exit(1 if fails else 0)
