"""Every venue's get_account_id — the id lib.portfolio.book_account_check keys
the bot's book by — actually runs, hits the documented endpoint on the right
host, and fails loudly (never a silent None) when the id is missing. No network.

A NameError inside one of these (a renamed URL constant) is not a skipped check
any more: with an open book after a key change it HALTs the machine, so each
one is called here.

Run: cd blave-agent && .venv/bin/python tests/check_account_ids.py
"""
import glob, os, sys, tempfile, time
from urllib.parse import urlsplit

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(tempfile.mkdtemp(prefix="account-ids-"))

from lib import account_binance, account_gateio, account_paper, portfolio  # noqa: E402
from lib import order_paper  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


def raises(fn):
    try:
        fn()
    except Exception as e:
        return e
    return None


class _Resp:
    def __init__(self, body, status=200):
        self.body, self.status_code, self.ok = body, status, status < 400
        self.text = str(body)

    def json(self):
        return self.body


calls = []


def fake(body):
    def request(method, url, headers=None, data=None, timeout=None, **kw):
        calls.append((method, url, dict(headers or {})))
        return _Resp(body)
    return request


# ── enumeration: every account lib that trades a crypto venue has one ────────
libs = sorted(os.path.basename(p)[8:-3] for p in glob.glob(os.path.join(ROOT, "lib", "account_*.py")))
missing = []
for v in libs:
    if v in ("TEMPLATE", "capital"):
        continue
    mod = __import__(f"lib.account_{v}", fromlist=["x"])
    if not callable(getattr(mod, "get_account_id", None)):
        missing.append(v)
check(not missing and {"binance", "okx", "bybit", "bingx", "gateio", "paper"} <= set(libs),
      f"every account lib but capital defines get_account_id (missing: {missing})")

# ── Binance: spot GET /api/v3/account → uid ─────────────────────────────────
BENV = {"BINANCE_API_KEY": "k", "BINANCE_SECRET_KEY": "s"}
account_binance.requests.request = fake({"uid": 354937868, "balances": []})
del calls[:]
got = account_binance.get_account_id(BENV)
u = urlsplit(calls[-1][1]) if calls else None
check(got == "354937868" and u and u.netloc == "api.binance.com" and u.path == "/api/v3/account"
      and "signature=" in u.query, f"binance: uid from live spot /api/v3/account ({got}, {u})")
del calls[:]
got = account_binance.get_account_id({**BENV, "BINANCE_DEMO": "true"})
check(calls and urlsplit(calls[-1][1]).netloc == "demo-api.binance.com",
      "binance: BINANCE_DEMO=true reads the demo spot host")
account_binance.requests.request = fake({"balances": []})
check(raises(lambda: account_binance.get_account_id(BENV)) is not None,
      "binance: no uid in the answer → raises, never None")

# ── Gate.io: GET /api/v4/account/detail → user_id ───────────────────────────
GENV = {"GATEIO_API_KEY": "k", "GATEIO_SECRET_KEY": "s"}
account_gateio.requests.request = fake({"user_id": 1667201533, "tier": 1})
del calls[:]
got = account_gateio.get_account_id(GENV)
m, url, hdr = calls[-1]
check(got == "1667201533" and m == "GET" and urlsplit(url).path == "/api/v4/account/detail"
      and hdr.get("X-Gate-Channel-Id") == "blave" and hdr.get("SIGN"),
      f"gateio: user_id from signed /api/v4/account/detail, attribution kept ({got})")
account_gateio.requests.request = fake({"tier": 1})
check(raises(lambda: account_gateio.get_account_id(GENV)) is not None,
      "gateio: no user_id → raises, never None")

# ── paper: the ledger's created_ts; a rebind or reset is a new account ──────
PENV = {"PAPER_API_KEY": "paper", "PAPER_SECRET_KEY": "paper", "PAPER_BOUND_TS": "1000"}
a = account_paper.get_account_id(PENV)
check(a == account_paper.get_account_id(PENV), f"paper: stable across reads ({a})")
later = int(time.time()) + 100
b = account_paper.get_account_id({**PENV, "PAPER_BOUND_TS": str(later)})
check(b != a and b == f"paper:{later}", f"paper: a later bind is another account ({a} → {b})")
_t = order_paper.time.time
order_paper.time.time = lambda: later + 50
try:
    order_paper.reset_account({**PENV, "PAPER_BOUND_TS": str(later)})
finally:
    order_paper.time.time = _t
c = account_paper.get_account_id({**PENV, "PAPER_BOUND_TS": str(later)})
check(c not in (a, b), f"paper: reset_account is another account ({b} → {c})")

# ── the lib reader never raises; a code error is an error, not a skipped check ─
_orig = account_binance.get_account_id
account_binance.get_account_id = lambda env: undefined_name  # noqa: F821
uid, err, transient = portfolio._read_account_id("binance", BENV)
account_binance.get_account_id = _orig
check(uid is None and err and err.startswith("NameError") and not transient,
      f"a NameError reads as an unreadable id, not as 'unsupported' ({err})")

print(f"\ncheck_account_ids: {'PASS' if not fails else f'{fails} FAILED'}")
sys.exit(1 if fails else 0)
