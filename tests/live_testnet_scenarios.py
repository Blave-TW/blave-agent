"""Live TESTNET scenarios for the real order path — demo money only, run by hand.

NOT part of the normal test run (those are tests/check_*.py). It trades on each
venue's demo / testnet with the keys in ~/.config/blave/testnet.env and walks
the production path end to end, in a scratch workspace (a temp dir, never
~/Blave/workspace): lib.portfolio.reconcile → manager/reconciler.py
place_order + _symbol_threshold → lib.execute → lib.venue_wiring →
lib/order_* / lib/account_*, and manager/flatten.py for close-all. After every
step it reads the venue's actual position and prints one PASS/FAIL line.

Safety — checked before anything from lib/ is imported, fatal when violated:
- the env file is exactly ~/.config/blave/testnet.env and not a symlink;
- every venue with a key in it has its demo flag set to true, and nothing
  else in it is a credential this harness cannot route to a demo host;
- no exchange credential in the process environment, BLAVE_AGENT_WORKSPACE and
  proxy variables unset, not run from inside ~/Blave/workspace;
- every HTTP request is checked at the transport (requests' HTTPAdapter.send,
  after redirects) BEFORE it is sent: the host must be that venue's demo host,
  and on OKX (one host for live and demo) x-simulated-trading: 1 must be on it.
  DNS for any other host is refused too, so nothing outside requests gets out;
- key values never reach the console or the log (every line is redacted).
The scenario symbol must be flat on the demo account before the run. At the
end everything on it is closed (the manual position included) and the scratch
workspaces, which hold a 0600 copy of the keys, are deleted.

Run (≈5–8 minutes per venue, one venue at a time with --venue):
    cd blave-agent && .venv/bin/python tests/live_testnet_scenarios.py
    cd blave-agent && .venv/bin/python tests/live_testnet_scenarios.py --venue okx --symbol ETHUSDT
Guard self-test, no network: .venv/bin/python tests/check_live_testnet_guards.py
"""
import argparse
import importlib
import json
import logging
import math
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from urllib.parse import parse_qs, urlsplit

HARNESS = os.path.abspath(__file__)
ROOT = os.path.dirname(os.path.dirname(HARNESS))
HOME = os.path.expanduser("~")
EXPECTED_ENV = os.path.join(HOME, ".config", "blave", "testnet.env")
REAL_WORKSPACE = os.path.join(HOME, "Blave", "workspace")
WS_MARKER = ".blave-testnet-scratch"
STRATEGY = "testnet_probe"

VENUES = {
    "binance": {"prefixes": ("BINANCE",), "flags": ("BINANCE_DEMO",),
                "hosts": {"demo-fapi.binance.com", "demo-api.binance.com"}},
    "okx": {"prefixes": ("OKX",), "flags": ("OKX_DEMO",), "hosts": {"www.okx.com"},
            "header": ("x-simulated-trading", "1")},
    "bybit": {"prefixes": ("BYBIT",), "flags": ("BYBIT_DEMO",),
              "hosts": {"api-demo.bybit.com"}},
    "gateio": {"prefixes": ("GATEIO", "GATE"), "flags": ("GATEIO_DEMO", "GATE_DEMO"),
               "hosts": {"api-testnet.gateapi.io"}},
}
_API_KEY_RE = re.compile(r"^([A-Za-z0-9]+)_API_KEY$")
_CRED_RE = re.compile(r"_(API_KEY|SECRET_KEY|API_SECRET|SECRET|PASSPHRASE)$", re.IGNORECASE)
# the shapes a workspace / venue .env uses; a bare *_SECRET in a shell is usually something else
_ENV_CRED_RE = re.compile(r"_(API_KEY|SECRET_KEY|API_SECRET|PASSPHRASE)$", re.IGNORECASE)
_PROXY_VARS = ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")


class Fatal(Exception):
    """A safety precondition failed — nothing may trade."""


class LiveHostRefused(Exception):
    """A request was about to leave for a non-demo destination."""


class SetupFailed(Exception):
    """The demo account cannot run the scenarios (mode, funds, a setup order
    refused) — this venue stops cleanly with the message, the next one runs."""


OKX_MODE_STOP = "OKX 帳戶模式不支援合約，請切到合約模式或跨幣種保證金"


# ── redaction ────────────────────────────────────────────────────────────────
class _Redactor:
    def __init__(self):
        self.secrets = set()

    def __call__(self, text):
        text = str(text)
        for s in sorted(self.secrets, key=len, reverse=True):
            if len(s) >= 6:
                text = text.replace(s, "***")
        return text


REDACT = _Redactor()


class _RedactingFormatter(logging.Formatter):
    def format(self, record):
        return REDACT(super().format(record))


class _ConsoleFormatter(logging.Formatter):
    """One line per record on the console; tracebacks go to the log file only."""

    def format(self, record):
        return REDACT(f"  log: {record.levelname} {record.getMessage()}")


def _utc_naive():
    """UTC as lib.portfolio writes it (naive isoformat) — compared as strings."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def say(msg=""):
    print(REDACT(msg), flush=True)


# ── preflight ────────────────────────────────────────────────────────────────
def parse_env(path):
    """Same parse as lib.venue_wiring.read_env (the dict every lib takes)."""
    env = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip("'\"")
    return env


def _venue_of_prefix(prefix):
    return next((v for v, c in VENUES.items() if prefix.upper() in c["prefixes"]), None)


def check_environ(environ, cwd):
    leaked = sorted(k for k in environ if _ENV_CRED_RE.search(k))
    if leaked:
        raise Fatal(f"exchange credentials in the process environment ({', '.join(leaked)}) — "
                    f"a real .env may be loaded; run from a clean shell")
    if environ.get("BLAVE_AGENT_WORKSPACE"):
        raise Fatal("BLAVE_AGENT_WORKSPACE is set — this must not run against a real workspace")
    proxies = [k for k in _PROXY_VARS if environ.get(k)]
    if proxies:
        raise Fatal(f"proxy variables set ({', '.join(proxies)}) — the host guard needs direct "
                    f"connections; unset them for this run")
    real = os.path.realpath(REAL_WORKSPACE)
    here = os.path.realpath(cwd)
    if here == real or here.startswith(real + os.sep):
        raise Fatal(f"run from inside {REAL_WORKSPACE} — refused")


def venue_env(env, venue):
    """Only this venue's lines, with every spelling of its demo flag set."""
    prefixes = VENUES[venue]["prefixes"]
    out = {k: v for k, v in env.items()
           if any(k.upper().startswith(p + "_") for p in prefixes)}
    for flag in VENUES[venue]["flags"]:
        out[flag] = "true"
    return out


def secrets_of(env):
    return {v for k, v in env.items() if _CRED_RE.search(k) and v}


def preflight(env_path, expected=EXPECTED_ENV, environ=None, cwd=None):
    """({venue: env dict}, secret values). Raises Fatal on any violation."""
    environ = os.environ if environ is None else environ
    cwd = os.getcwd() if cwd is None else cwd
    if os.path.islink(expected) or os.path.islink(env_path):
        raise Fatal(f"{expected} must be a regular file, not a symlink")
    if os.path.realpath(env_path) != os.path.realpath(expected):
        raise Fatal(f"env file must be exactly {expected} (got {env_path})")
    if not os.path.isfile(env_path):
        raise Fatal(f"{expected} not found")
    real_ws_env = os.path.realpath(os.path.join(REAL_WORKSPACE, ".env"))
    if os.path.realpath(env_path) == real_ws_env or (
            os.path.exists(real_ws_env) and os.path.samefile(env_path, real_ws_env)):
        raise Fatal(f"{env_path} is the real workspace .env — refused")
    check_environ(environ, cwd)
    env = parse_env(env_path)
    venues = set()
    for k in env:
        m = _API_KEY_RE.match(k)
        if not m:
            if _CRED_RE.search(k) and not any(
                    k.upper().startswith(p + "_") for c in VENUES.values() for p in c["prefixes"]):
                raise Fatal(f"{k}: a credential this harness cannot route to a demo host — "
                            f"remove it from {expected}")
            continue
        venue = _venue_of_prefix(m.group(1))
        if venue is None:
            raise Fatal(f"{k}: not a venue with a demo host here — remove it from {expected}")
        venues.add(venue)
    if not venues:
        raise Fatal(f"no venue keys in {expected}")
    for venue in venues:
        flags = VENUES[venue]["flags"]
        if not any(str(env.get(f, "")).lower() == "true" for f in flags):
            raise Fatal(f"{venue}: keys present but {' / '.join(flags)} is not true")
    return {v: venue_env(env, v) for v in sorted(venues)}, secrets_of(env)


# ── transport guard ──────────────────────────────────────────────────────────
WIRE = []  # one row per order-creating request: {venue, path, ok, why}

_BINANCE_ORDER_IDS = {"/fapi/v1/order": ("newClientOrderId", "x-52DDFAFN"),
                      "/fapi/v1/algoOrder": ("clientAlgoId", "x-52DDFAFN"),
                      "/api/v3/order": ("newClientOrderId", "x-GBN6HWR2")}
_OKX_ORDER_PATHS = ("/api/v5/trade/order", "/api/v5/trade/order-algo",
                    "/api/v5/trade/batch-orders")
_OKX_TAG = "96ee7de3fd4bBCDE"
_BYBIT_ORDER_PATHS = ("/v5/order/create",)
_GATE_ORDER_PATHS = ("/api/v4/futures/usdt/orders", "/api/v4/futures/usdt/price_orders",
                     "/api/v4/spot/orders")


def _record_attribution(venue, method, path, headers, body):
    if isinstance(body, bytes):
        body = body.decode("utf-8", "replace")
    if venue == "binance" and method == "POST" and path in _BINANCE_ORDER_IDS:
        field, prefix = _BINANCE_ORDER_IDS[path]
        got = (parse_qs(body or "").get(field) or [""])[0]
        WIRE.append({"venue": venue, "path": path, "ok": got.startswith(prefix),
                     "why": f"{field}={got[:12]}…"})
    elif venue == "okx" and method == "POST" and path in _OKX_ORDER_PATHS:
        try:
            items = json.loads(body or "{}")
        except ValueError:
            items = {}
        items = items if isinstance(items, list) else [items]
        ok = bool(items) and all(isinstance(i, dict) and i.get("tag") == _OKX_TAG for i in items)
        WIRE.append({"venue": venue, "path": path, "ok": ok, "why": "tag"})
    elif venue == "bybit" and method == "POST" and path in _BYBIT_ORDER_PATHS:
        WIRE.append({"venue": venue, "path": path, "ok": headers.get("referer") == "Ue001036",
                     "why": "referer"})
    elif venue == "gateio" and method == "POST" and path in _GATE_ORDER_PATHS:
        WIRE.append({"venue": venue, "path": path,
                     "ok": headers.get("x-gate-channel-id") == "blave", "why": "channel"})


def check_request(allowed, method, url, headers, body):
    """Raise LiveHostRefused unless this request goes to a demo destination."""
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    where = f"{method} {parts.scheme}://{host}{parts.path}"
    if parts.scheme != "https" or host not in allowed:
        raise LiveHostRefused(f"refused {where} — not a demo/testnet host")
    venue = allowed[host]
    hdr = {str(k).lower(): str(v) for k, v in (headers or {}).items()}
    need = VENUES[venue].get("header")
    if need and hdr.get(need[0]) != need[1]:
        raise LiveHostRefused(f"refused {where} — without {need[0]}: {need[1]} this is LIVE "
                              f"trading on the same host")
    _record_attribution(venue, method.upper(), parts.path, hdr, body)


_FILL_PATHS = {("POST", "/api/v3/order"), ("POST", "/fapi/v1/order"),
               ("GET", "/api/v5/trade/order")}


def _log_fill(request, resp):
    """Every order reply to the log file (never the console): the fills, their
    fee and fee asset — what a wallet-vs-book mismatch is traced back to."""
    try:
        parts = urlsplit(request.url)
        if (str(request.method).upper(), parts.path) in _FILL_PATHS:
            body = request.body.decode() if isinstance(request.body, bytes) else (request.body or "")
            cid = (re.search(r"(?:newClientOrderId|clOrdId)=([\w-]+)", body + "&" + (parts.query or ""))
                   or [None, ""])[1]
            logging.info(REDACT(f"[wire] {request.method} {parts.path} {cid} -> "
                                f"{(resp.text or '')[:1500]}"))
    except Exception:
        pass


def install_http_guard(venues):
    """Wrap the lowest send in requests and DNS resolution. Call before lib/
    is imported; idempotent per process (a second call is refused)."""
    import requests.adapters
    if getattr(requests.adapters.HTTPAdapter.send, "_testnet_guard", False):
        raise Fatal("HTTP guard already installed in this process")
    allowed = {h: v for v in venues for h in VENUES[v]["hosts"]}
    orig_send = requests.adapters.HTTPAdapter.send

    def guarded_send(self, request, *args, **kwargs):
        check_request(allowed, request.method or "GET", request.url, request.headers,
                      request.body)
        resp = orig_send(self, request, *args, **kwargs)
        _log_fill(request, resp)
        return resp

    guarded_send._testnet_guard = True
    requests.adapters.HTTPAdapter.send = guarded_send
    orig_gai = socket.getaddrinfo

    def guarded_getaddrinfo(host, *args, **kwargs):
        name = (host.decode() if isinstance(host, bytes) else str(host or "")).lower()
        if name not in allowed:
            raise LiveHostRefused(f"refused DNS lookup for {name!r} — not a demo/testnet host")
        return orig_gai(host, *args, **kwargs)

    socket.getaddrinfo = guarded_getaddrinfo
    return allowed


def _assert_selectors(venue, env):
    """The libs' own host selectors must answer demo for this env — before any
    network (the transport guard is the backstop, this is the early clear fail)."""
    o = importlib.import_module(f"lib.order_{venue}")
    a = importlib.import_module(f"lib.account_{venue}")
    if venue == "binance":
        ok = (o._base(env) == o.DEMO_URL and o._base(env, True) == o.SPOT_DEMO_URL
              and a._fapi(env) == a.FAPI_DEMO_URL and a._spot(env) == a.SPOT_DEMO_URL)
    elif venue in ("bybit", "gateio"):
        ok = o._host(env) == o.DEMO_HOST and a._host(env) == a.DEMO_HOST
    else:  # okx: one host, the header decides — asserted per request by the guard
        ok = True
    if not ok:
        raise Fatal(f"{venue}: lib host selector does not resolve to the demo host")


# ── workspace ────────────────────────────────────────────────────────────────
def make_workspace(venue, env):
    ws = os.path.realpath(tempfile.mkdtemp(prefix=f"blave-testnet-{venue}-"))
    open(os.path.join(ws, WS_MARKER), "w").close()
    shutil.copytree(os.path.join(ROOT, "lib"), os.path.join(ws, "lib"),
                    ignore=shutil.ignore_patterns("__pycache__"))
    os.makedirs(os.path.join(ws, "manager"))
    for name in ("reconciler.py", "flatten.py"):
        shutil.copy2(os.path.join(ROOT, "manager", name), os.path.join(ws, "manager", name))
    os.makedirs(os.path.join(ws, "strategies", STRATEGY))
    os.makedirs(os.path.join(ws, "state"))
    fd = os.open(os.path.join(ws, ".env"), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write("".join(f"{k}={v}\n" for k, v in env.items()))
    return ws


def check_workspace(ws):
    ws = os.path.realpath(ws)
    tmp = os.path.realpath(tempfile.gettempdir())
    if not ws.startswith(tmp + os.sep) or not os.path.isfile(os.path.join(ws, WS_MARKER)):
        raise Fatal(f"{ws} is not a scratch workspace made by this harness")
    return ws


def enter_workspace(ws):
    os.chdir(ws)
    from lib import portfolio
    portfolio._baseline_seen = None
    portfolio._baseline_wait = None
    rec = sys.modules.get("manager.reconciler")
    if rec is not None:
        rec._min_order_gate.clear()


def canon(sym):
    return str(sym or "").replace("-", "").replace("_", "").upper()


def reconcile_rounds(max_rounds=4):
    """One reconciler trigger plus its force_next re-runs: rounds until nothing
    fills. Returns every executed order."""
    from lib import venue_wiring
    from lib.portfolio import reconcile
    import manager.reconciler as rec
    done = []
    for _ in range(max_rounds):
        orders = reconcile(get_positions_fn=venue_wiring.auto_get_positions,
                           place_order_fn=rec.place_order, threshold=rec._symbol_threshold)
        done += orders or []
        if not orders:
            break
    return done


def book_rows():
    from lib.portfolio import ledger_book
    return {k: {"qty": r["qty"], "cost": round(r["cost"], 4), "legacy": r["legacy"]}
            for k, r in ledger_book().items()}


# ── child process (fresh interpreter: restart and flatten) ───────────────────
def child_main(args):
    try:
        ws = check_workspace(args.workspace)
        check_environ(os.environ, ws)
        env = parse_env(os.path.join(ws, ".env"))
        REDACT.secrets |= secrets_of(env)
        others = [k for k in env if _API_KEY_RE.match(k)
                  and _venue_of_prefix(_API_KEY_RE.match(k).group(1)) != args.venue]
        if others or not any(str(env.get(f, "")).lower() == "true"
                             for f in VENUES[args.venue]["flags"]):
            raise Fatal("scratch .env is not a single demo venue")
        install_http_guard([args.venue])
    except Fatal as e:
        print("RESULT " + json.dumps({"fatal": str(e)}))
        return 2
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr)
    for h in logging.getLogger().handlers:
        h.setFormatter(_RedactingFormatter("%(levelname)s %(message)s"))
    sys.path.insert(0, ws)
    os.chdir(ws)
    _assert_selectors(args.venue, env)
    if args.internal == "round":
        orders = reconcile_rounds()
        out = {"executed": len(orders), "book": book_rows()}
    elif args.internal == "book":
        out = {"book": book_rows()}
    elif args.internal == "flatten":
        import manager.flatten as flatten_mod  # chdirs to its own workspace root
        result = flatten_mod.flatten()
        from lib import guard
        out = {"result": result, "halted": guard.halted(), "book": book_rows()}
    else:
        out = {"fatal": f"unknown action {args.internal}"}
    print("RESULT " + REDACT(json.dumps(out, default=str)))
    return 0


def run_child(ws, venue, action):
    p = subprocess.run([sys.executable, HARNESS, "--internal", action, "--workspace", ws,
                        "--venue", venue], cwd=ws, capture_output=True, text=True, timeout=600)
    logging.info(REDACT(f"[child {action}] stderr:\n{p.stderr[-4000:]}"))
    lines = [ln for ln in p.stdout.splitlines() if ln.startswith("RESULT ")]
    if not lines:
        return {"fatal": f"child {action} exited {p.returncode} without a result "
                         f"(see log): {REDACT(p.stderr[-300:])}"}
    return json.loads(lines[-1][len("RESULT "):])


# ── one venue ────────────────────────────────────────────────────────────────
class VenueRun:
    def __init__(self, venue, env, symbol):
        self.venue, self.env, self.sym = venue, env, symbol
        self.order = importlib.import_module(f"lib.order_{venue}")
        self.acct = importlib.import_module(f"lib.account_{venue}")
        self.results = []
        self.workspaces = []

    # reads
    def net_qty(self):
        time.sleep(1.5)  # a fill can lag the position endpoint by a beat
        rows = self.acct.get_positions(self.env)
        return sum((1 if p.get("side") == "long" else -1) * float(p.get("size") or 0)
                   for p in rows if canon(p.get("symbol")) == self.sym)

    def book_qty(self):
        return book_rows().get(self.sym, {}).get("qty", 0.0)

    def calibrate(self):
        from lib import venue_wiring
        import manager.reconciler as rec
        self.lot = venue_wiring._lot_base(self.order, self.env, self.sym)
        self.mark = float(self.order.get_mark_price(self.env, self.sym))
        self.gate = float(rec._symbol_threshold(self.sym))
        lot_usd = self.lot * self.mark
        self.A = float(math.ceil(max(3 * self.gate, 6 * lot_usd)))
        self.tol = self.lot * 1.0 + 1e-12
        self.exact = self.lot * 1e-6 + 1e-12
        say(f"[{self.venue}] {self.sym}: lot {self.lot:g} (${lot_usd:.2f}), mark {self.mark:g}, "
            f"entry gate ${self.gate:.2f}, base amount A = ${self.A:.0f}")

    def qty_for(self, usd):
        self.mark = float(self.order.get_mark_price(self.env, self.sym))
        n = math.floor(abs(usd) / self.mark / self.lot + 0.5)
        return math.copysign(n * self.lot, usd) if n else 0.0

    # writes
    def set_target(self, usd):
        pos = 0 if usd == 0 else (1 if usd > 0 else -1)
        amount = abs(usd) if usd else self.A
        with open(f"strategies/{STRATEGY}/state.json", "w") as f:
            json.dump({"symbol": self.sym, "position": pos}, f)
        with open("manager/portfolio_config.json", "w") as f:
            json.dump({"amounts": {STRATEGY: amount}, "exchanges": {STRATEGY: self.venue}}, f)

    def manual(self, direction, qty):
        """A position placed OUTSIDE the ledger — what a user does in the app."""
        cid = "man" + _utc_naive().strftime("%H%M%S%f")
        try:
            placed = self.order.place_market_order(self.env, self.sym, direction, abs(qty),
                                                   client_order_id=cid)
        except LiveHostRefused:
            raise
        except Exception as e:
            raise SetupFailed(f"the manual {direction} {abs(qty):g} {self.sym} could not be "
                              f"opened: {type(e).__name__}: {e}") from e
        if placed is False:
            raise SetupFailed(f"the manual {direction} {abs(qty):g} {self.sym} is below the "
                              f"venue minimum — nothing opened")

    def ready(self):
        """Read-only checks that the demo account can run this at all, before
        any order: OKX account mode, a futures account with funds."""
        if self.venue == "okx":
            try:
                lv = self.acct.check_account_mode(self.env)
            except self.acct.AccountModeError as e:
                raise SetupFailed(OKX_MODE_STOP) from e
            say(f"[okx] account mode acctLv={lv} (2 futures / 3 multi-currency / 4 portfolio)")
        if self.venue == "gateio":
            self._gate_book_sane()
        try:
            equity = float(self.acct.get_equity(self.env).get("equity") or 0)
        except LiveHostRefused:
            raise
        except Exception as e:
            raise SetupFailed(f"account read failed: {type(e).__name__}: {e}") from e
        if equity <= 0:
            hint = (" — a Gate.io futures account exists only after the first transfer into it"
                    if self.venue == "gateio" else "")
            raise SetupFailed(f"futures equity is {equity:g}: fund the demo account first{hint}")
        self.equity = equity

    def _gate_book_sane(self):
        """Gate.io refuses a market order whose worst fill lies past mark ×
        (1 ± order_price_deviate) — MARKET_PRICE_TOO_DEVIATED (measured on the
        testnet: ETH ask 2784.3, mark 2660, bound 2713.2 = mark × 1.02). A book
        sitting past that bound refuses every order and proves nothing."""
        import requests
        c = self.sym
        try:
            c = self.order._contract(self.sym)
            base = self.order._host(self.env) + self.order.PREFIX + "/futures/usdt"
            spec = requests.get(f"{base}/contracts/{c}", timeout=10).json()
            t = requests.get(f"{base}/tickers", params={"contract": c}, timeout=10).json()[0]
            mark, ask, bid = (float(t["mark_price"]), float(t["lowest_ask"]),
                              float(t["highest_bid"]))
            bound = min(float(spec.get("order_price_deviate") or 1),
                        float(spec.get("market_order_slip_ratio") or 1))
        except LiveHostRefused:
            raise
        except Exception as e:
            say(f"[gateio] {c} book vs mark not checked ({type(e).__name__}: {e})")
            return
        if ask > mark * (1 + bound) or bid < mark * (1 - bound):
            raise SetupFailed(f"Gate.io testnet {c} book is too far from the mark (ask {ask:g}, "
                              f"bid {bid:g}, mark {mark:g}, allowed ±{bound:.0%}) — every market "
                              f"order is refused with MARKET_PRICE_TOO_DEVIATED there; run with "
                              f"another --symbol (e.g. BTCUSDT) or later")
        say(f"[gateio] {c} book within ±{bound:.0%} of mark {mark:g} (ask {ask:g}, bid {bid:g})")

    def need_margin(self):
        # the largest exposure any scenario holds is 3A (11b); at 1x that is the bar
        if self.equity < 4 * self.A:
            raise SetupFailed(f"demo equity {self.equity:.0f} is under 4 × A = {4 * self.A:.0f} "
                              f"— top the demo account up")

    def close_all_direct(self):
        """Close everything on the symbol, straight through the order lib."""
        if hasattr(self.order, "cancel_all_orders"):
            try:
                self.order.cancel_all_orders(self.env, self.sym)
            except Exception as e:
                logging.warning(f"cancel_all_orders: {e}")
        for _ in range(3):
            rows = [p for p in self.acct.get_positions(self.env)
                    if canon(p.get("symbol")) == self.sym and float(p.get("size") or 0) > 0]
            if not rows:
                return True
            for p in rows:
                cid = "cln" + _utc_naive().strftime("%H%M%S%f")
                self.order.close_position_partial(self.env, self.sym, p["side"],
                                                  float(p["size"]), client_order_id=cid)
            time.sleep(2)
        return not any(canon(p.get("symbol")) == self.sym for p in self.acct.get_positions(self.env))

    # verdicts
    def verdict(self, scenario, ok, expected, actual):
        self.results.append((scenario, bool(ok)))
        line = (f"{'PASS' if ok else 'FAIL'}  [{self.venue}] {scenario}: expected {expected} | "
                f"actual {actual}")
        say(line)
        logging.info(REDACT(f"[verdict] {line} | book {book_rows()}"))

    def expect_qty(self, scenario, expected, exact=False):
        act = self.net_qty()
        tol = self.exact if exact else self.tol
        self.verdict(scenario, abs(act - expected) <= tol,
                     f"{expected:+.6g}{'' if exact else f' ±{self.lot:g}'}", f"{act:+.6g}")
        return act

    def step(self, usd):
        self.set_target(usd)
        return reconcile_rounds()


def _count_lines(path, event=None):
    try:
        with open(path) as f:
            lines = [ln for ln in f if ln.strip()]
    except OSError:
        return 0
    if event is None:
        return len(lines)
    return sum(1 for ln in lines if f'"event": "{event}"' in ln)


def _new_errors(since, sym):
    try:
        with open("manager/order_errors.json") as f:
            rows = json.load(f)
    except (OSError, ValueError):
        return []
    return [r for r in rows if r.get("symbol") == sym and str(r.get("ts")) > since]


def scenarios(r, ws):
    A = r.A
    # 1–4: open, increase, decrease, close
    r.step(A)
    act = r.expect_qty("1 open long from flat", r.qty_for(A))
    if abs(act) <= r.exact:
        errs = _new_errors("", r.sym)
        raise SetupFailed("the first order did not fill — "
                          + (f"venue said: {errs[-1]['error']}" if errs else "no order error on file"))
    r.verdict("1b book = account (bot-only)", abs(r.book_qty() - act) <= r.exact,
              f"{act:+.6g}", f"{r.book_qty():+.6g}")
    r.step(2 * A)
    r.expect_qty("2 increase", r.qty_for(2 * A))
    r.step(A)
    act = r.expect_qty("3 decrease", r.qty_for(A))
    r.verdict("3b book = account", abs(r.book_qty() - act) <= r.exact,
              f"{act:+.6g}", f"{r.book_qty():+.6g}")
    r.step(0)
    r.expect_qty("4 close to flat, no dust", 0.0, exact=True)
    r.verdict("4b book empty", r.sym not in book_rows(), "no row", book_rows().get(r.sym))

    # 5 flip long→short in one step
    r.step(A)
    r.expect_qty("5a long before the flip", r.qty_for(A))
    r.step(-A)
    r.expect_qty("5 flip long→short in one step", r.qty_for(-A))

    # 6 short open and close
    r.step(0)
    r.expect_qty("6a close the short", 0.0, exact=True)
    r.step(-A)
    r.expect_qty("6b short open from flat", r.qty_for(-A))
    r.step(0)
    r.expect_qty("6c short close", 0.0, exact=True)

    # 7 venue-minimum boundary (entry gate = max($10, 1.05 × min qty, min notional)),
    # re-read now: the gate is valued at the mark and calibrate() was minutes ago
    import manager.reconciler as rec
    rec._min_order_gate.clear()
    r.gate = float(rec._symbol_threshold(r.sym))
    before = _count_lines("manager/orders.jsonl")
    r.step(0.5 * r.gate)
    r.verdict("7a target half the venue minimum places nothing",
              _count_lines("manager/orders.jsonl") == before and abs(r.net_qty()) <= r.exact,
              "0 orders, flat", f"{_count_lines('manager/orders.jsonl') - before} orders, "
                                f"{r.net_qty():+.6g}")
    r.step(1.1 * r.gate)
    act = r.expect_qty(f"7b target 1.1 × the minimum (${1.1 * r.gate:.2f}) places one minimum "
                       f"order", r.qty_for(1.1 * r.gate))
    r.verdict("7c that order is at least one lot", abs(act) >= r.lot - r.exact,
              f"≥ {r.lot:g}", f"{act:+.6g}")
    r.step(0)
    r.expect_qty("7d close", 0.0, exact=True)

    # 8 a venue rejection is reported once per round, never retried in a loop.
    # Measured against the position it starts from, so a 7d failure does not repeat here.
    equity = float(r.acct.get_equity(r.env).get("equity") or 0)
    p0 = r.net_qty()
    since = _utc_naive().isoformat()
    attempts = []
    r.set_target(1000 * max(equity, 1000.0))
    for _ in range(2):
        a0 = _count_lines("state/audit.jsonl", "order_attempt")
        filled = reconcile_rounds(max_rounds=1)
        attempts.append((_count_lines("state/audit.jsonl", "order_attempt") - a0, len(filled)))
    errs = _new_errors(since, r.sym)
    r.verdict("8 rejected order (1000× equity) reported, not retried",
              all(n <= 1 and f == 0 for n, f in attempts) and errs
              and abs(r.net_qty() - p0) <= r.exact,
              f"≤1 attempt and 0 fills per round, an order error, position unchanged at {p0:+.6g}",
              f"(attempts, fills) per round {attempts}, "
              f"error {(errs[-1]['error'][:90] if errs else None)!r}, {r.net_qty():+.6g}")
    r.step(0)

    # 13 restart mid-way: a fresh process reads the same book and keeps it
    r.step(A)
    act = r.expect_qty("13a open in this process", r.qty_for(A))
    parent_book = book_rows()
    out = run_child(ws, r.venue, "round")
    r.verdict("13b fresh process, same target: no order, same book",
              out.get("executed") == 0 and out.get("book") == parent_book,
              f"0 orders, {parent_book.get(r.sym)}",
              f"{out.get('executed')} orders, {(out.get('book') or {}).get(r.sym)} "
              f"{out.get('fatal') or ''}")
    r.set_target(2 * A)
    out = run_child(ws, r.venue, "round")
    act = r.expect_qty("13c fresh process increases to 2A", r.qty_for(2 * A))
    r.verdict("13d book (read back here) = account", abs(r.book_qty() - act) <= r.exact,
              f"{act:+.6g}", f"{r.book_qty():+.6g} {out.get('fatal') or ''}")
    r.set_target(0)
    out = run_child(ws, r.venue, "round")
    r.expect_qty("13e fresh process closes to flat", 0.0, exact=True)


def scenario_manual_and_close_all(r, ws):
    A = r.A
    m = r.qty_for(A)
    r.manual("long", m)
    man = r.expect_qty("9a manual long placed outside the ledger", m)
    r.step(0)
    r.expect_qty("9b zero target leaves the manual position alone", man, exact=True)
    r.step(A)
    r.expect_qty("9c target on the same symbol buys on top", man + r.qty_for(A))
    r.step(0)
    r.expect_qty("9d closing the bot's share leaves the manual share exactly", man, exact=True)

    # 10 close-all closes only the book share
    r.step(A)
    r.expect_qty("10a bot long on top of the manual long", man + r.qty_for(A))
    out = run_child(ws, r.venue, "flatten")
    r.expect_qty("10 close-all closes only the bot's share", man, exact=True)
    r.verdict("10b close-all tripped HALT and emptied the book",
              out.get("halted") is True and r.sym not in (out.get("book") or {}),
              "halted, no book row",
              f"halted={out.get('halted')}, book={(out.get('book') or {}).get(r.sym)} "
              f"{out.get('fatal') or ''}")
    r.set_target(0)  # before the halt goes: a resume must not re-buy the target
    from lib import guard
    guard.clear_halt("tests/live_testnet_scenarios (scratch workspace)")
    # Not covered: a bot SHORT target on the manual long's symbol. On a one-way / net
    # account that order nets the manual long away at the venue — no book can undo it.


def scenario_migration(r, env):
    """11: first round of the own-positions rule on an account that already
    holds the symbol — a fresh workspace with no book at all."""
    A = r.A
    for label, mult, whole in (("11a whole-adopt (held 1.2 × target)", 1.2, True),
                               ("11b min-adopt (held 3 × target)", 3.0, False)):
        ws = make_workspace(r.venue, env)
        r.workspaces.append(ws)
        enter_workspace(ws)
        held = r.qty_for(mult * A)
        r.manual("long", held)
        held = r.net_qty()
        r.set_target(A)
        # round 1 only confirms the read, round 2 writes the baseline, round 3 trades on it
        for _ in range(3):
            reconcile_rounds(max_rounds=1)
        adopted = r.book_qty()
        if whole:
            ok = abs(adopted - held) <= r.exact
            exp = f"book {held:+.6g} (the whole position)"
        else:
            want = r.qty_for(A)
            ok = abs(adopted - want) <= r.tol and adopted < held
            exp = f"book {want:+.6g} ±{r.lot:g} (the target's share)"
        r.verdict(label, ok, exp, f"book {adopted:+.6g}")
        r.expect_qty(f"{label[:3]} adoption sold nothing", held, exact=True)
        r.step(0)
        r.expect_qty(f"{label[:3]} target 0 closes only the adopted share", held - adopted,
                     exact=True)
        r.verdict(f"{label[:3]} direct cleanup", r.close_all_direct(), "flat", "see above")


# ── spot (--market spot) ─────────────────────────────────────────────────────
_SPOT_QUOTES = ("USDT", "USDC")


class SpotRun(VenueRun):
    """Spot has no positions: the WALLET is the position, and it is one pool of
    the bot's coins and the user's. `self.user` = the coins that are the user's
    (what the wallet held before the run, plus any bought here outside the
    ledger); every check measures the wallet against it."""

    def __init__(self, venue, env, symbol):
        super().__init__(venue, env, symbol)
        self.key = symbol + "@spot"
        self.quote = next((q for q in _SPOT_QUOTES if symbol.endswith(q)), None)
        if not self.quote:
            raise SetupFailed(f"{symbol}: spot scenarios need a USDT or USDC pair")
        self.base = symbol[:-len(self.quote)]

    # reads
    def balances(self):
        time.sleep(1.5)  # a fill can lag the balance endpoint by a beat
        return self.order.get_spot_balances(self.env)

    def wallet(self):
        return float(self.balances().get(self.base, 0.0))

    def book_qty(self):
        return book_rows().get(self.key, {}).get("qty", 0.0)

    def ready(self):
        try:
            bal = self.balances()
        except LiveHostRefused:
            raise
        except Exception as e:
            raise SetupFailed(f"spot wallet read failed: {type(e).__name__}: {e}") from e
        self.quote_bal = float(bal.get(self.quote, 0.0))
        self.base0 = self.user = float(bal.get(self.base, 0.0))
        if self.venue == "okx":
            self._okx_price_limit_sane()

    def _okx_price_limit_sane(self):
        """OKX cancels a market order whose fill would cross its price limit
        (cancelSource 15). A demo spot book can sit outside that limit for good
        (measured: ETH-USDT ask 2750 against a buy limit of 2701.84) — then every
        buy is canceled and the run proves nothing about the lib."""
        inst = self.order._spot_inst(self.sym)
        try:
            lim = self.order._send("GET", "/api/v5/public/price-limit", self.env,
                                   params={"instId": inst})[0]
            book = self.order._send("GET", "/api/v5/market/books", self.env,
                                    params={"instId": inst, "sz": "1"})[0]
            ask, bid = float(book["asks"][0][0]), float(book["bids"][0][0])
            buy_lmt, sell_lmt = float(lim["buyLmt"]), float(lim["sellLmt"])
        except LiveHostRefused:
            raise
        except Exception as e:
            say(f"[okx] {inst} price limit not checked ({type(e).__name__}: {e})")
            return
        if ask > buy_lmt or bid < sell_lmt:
            raise SetupFailed(f"OKX demo {inst} book is outside the venue's price limit (ask "
                              f"{ask:g} vs buy limit {buy_lmt:g}, bid {bid:g} vs sell limit "
                              f"{sell_lmt:g}) — OKX cancels every market order there; run with "
                              f"another --symbol (e.g. BTCUSDT)")

    def calibrate(self):
        import manager.reconciler as rec
        rules = self.order.get_spot_rules(self.env, self.sym)
        self.step_q = float(rules["step"])
        self.mark = float(self.order.get_spot_price(self.env, self.sym))
        self.venue_min = max(float(rules.get("min_notional") or 0),
                             float(rules.get("min_qty") or 0) * self.mark)
        rec._min_order_gate.clear()
        self.gate = float(rec._symbol_threshold(self.key))
        self.A = float(math.ceil(max(3 * self.gate, 6 * self.venue_min)))
        # one taker fee on the largest buy here, taken in the base coin
        self.fee_tol = self.step_q + 0.002 * 3 * self.A / self.mark
        say(f"[{self.venue}] {self.sym} spot: step {self.step_q:g} {self.base}, price "
            f"{self.mark:g}, venue minimum ${self.venue_min:.2f}, reconcile gate "
            f"${self.gate:.2f}, A = ${self.A:.0f}; wallet at start {self.base0:g} {self.base}, "
            f"{self.quote_bal:.2f} {self.quote}")

    def need_margin(self):
        # the most this run buys at once: 3A (11b) on top of what it already holds
        if self.quote_bal < 6 * self.A:
            raise SetupFailed(f"spot {self.quote} {self.quote_bal:.2f} is under 6 × A = "
                              f"{6 * self.A:.0f} — top the demo spot wallet up")

    # writes
    def set_target(self, usd):
        with open(f"strategies/{STRATEGY}/strategy.py", "w") as f:
            f.write('MARKET = "spot"\n')
        super().set_target(usd)

    def manual_buy(self, usd):
        """Coins bought OUTSIDE the ledger — the user's own, never the bot's."""
        cid = "man" + _utc_naive().strftime("%H%M%S%f")
        try:
            placed = self.order.place_spot_market_order(self.env, self.sym, "buy",
                                                        quote_qty=usd, client_order_id=cid)
        except LiveHostRefused:
            raise
        except Exception as e:
            raise SetupFailed(f"the user's own {self.base} (${usd:.0f}) could not be bought: "
                              f"{type(e).__name__}: {e}") from e
        if placed is False:
            raise SetupFailed(f"the user's own {self.base} buy (${usd:.0f}) is below the "
                              f"venue minimum")

    def restore(self, to=None):
        """Sell the wallet down to `to` (default: its quantity at the start of the
        run); never below. A migration case passes its own starting quantity: the
        main workspace's book still owns the dust its closes left, and selling
        that from here would leave the book owning coins that are gone."""
        extra = self.wallet() - (self.base0 if to is None else to)
        if extra > 0:
            cid = "cln" + _utc_naive().strftime("%H%M%S%f")
            self.order.place_spot_market_order(self.env, self.sym, "sell", base_qty=extra,
                                               client_order_id=cid)
        return self.wallet()

    # verdicts
    def expect_coins(self, scenario, usd):
        """The bot's coins in the wallet ≈ usd at the current price (quote-sized
        buys; the base-coin fee and the price between read and fill are inside 2%)."""
        got = self.wallet() - self.user
        self.mark = float(self.order.get_spot_price(self.env, self.sym))
        want = usd / self.mark
        self.verdict(scenario, abs(got - want) <= 0.02 * want + self.step_q,
                     f"bot's coins ≈ {want:.6g} {self.base} (${usd:.0f}) ±2%",
                     f"{got:.6g} {self.base}")
        return got

    def expect_untouched(self, scenario):
        """Bot's coins gone (less than one step left) and not one of the user's sold."""
        w = self.wallet()
        diff = w - self.user
        if diff < -1e-12:
            why = f"USER'S COINS SOLD: {-diff:.6g} {self.base} (≈{-diff / (self.fee_tol or 1):.2f}× the fee tolerance)"
        else:
            why = f"{diff:+.6g} {self.base} vs the user's coins"
        self.verdict(scenario, -1e-12 <= diff <= self.step_q + 1e-12,
                     f"wallet = user's {self.user:.6g} {self.base} (+ < one step)", why)
        if diff < 0:
            self.user = w  # what is left is the user's: the next check reports only its own loss
        return w


def spot_scenarios(r, ws):
    import manager.reconciler as rec
    A = r.A
    r.step(A)
    got = r.expect_coins("1 buy from zero", A)
    if got <= r.step_q:
        errs = _new_errors("", r.key)
        raise SetupFailed("the first spot buy did not fill — "
                          + (f"venue said: {errs[-1]['error']}" if errs else "no order error on file"))
    book = r.book_qty()
    r.verdict("1b book qty ≤ coins that landed (otherwise a full sell takes the difference "
              "out of the user's coins)", book <= got + 1e-12,
              f"book ≤ {got:.8g}", f"book {book:.8g} ({book - got:+.3g} {r.base}: a fee taken in "
              f"{r.base} is not in the book)" if book > got + 1e-12 else f"book {book:.8g}")
    r.step(2 * A)
    r.expect_coins("2 increase", 2 * A)
    r.step(A)
    r.expect_coins("3 partial sell", A)
    r.step(0)
    r.expect_untouched("4 full sell: no dust, the user's coins untouched")
    left = r.book_qty()
    r.verdict("4b book holds nothing a sell could reach (< one step)", left <= r.step_q,
              f"≤ {r.step_q:g} {r.base}", f"{left:.8g} {r.base}")

    r.step(A)
    r.expect_coins("5a buy before the short signal", A)
    r.step(-A)
    r.expect_untouched("5 short signal on spot is clamped to 0: sells the bot's coins, never below")
    before = _count_lines("manager/orders.jsonl")
    r.step(-A)
    r.verdict("5b short signal from flat places nothing", _count_lines("manager/orders.jsonl")
              == before, "0 orders", f"{_count_lines('manager/orders.jsonl') - before} orders")
    r.expect_untouched("5c …and sells none of the user's coins")

    rec._min_order_gate.clear()
    r.gate = float(rec._symbol_threshold(r.key))
    before = _count_lines("manager/orders.jsonl")
    r.step(0.5 * r.gate)
    r.verdict(f"6a target half the reconcile gate (${0.5 * r.gate:.2f}) places nothing",
              _count_lines("manager/orders.jsonl") == before, "0 orders",
              f"{_count_lines('manager/orders.jsonl') - before} orders")
    r.step(1.1 * r.gate)
    r.expect_coins(f"6b target 1.1 × the gate (${1.1 * r.gate:.2f}) buys it", 1.1 * r.gate)
    r.step(0)
    r.expect_untouched("6c close")
    w0 = r.wallet()
    q = round(0.5 * r.venue_min, 2)
    try:
        res = r.order.place_spot_market_order(r.env, r.sym, "buy", quote_qty=q)
        what = "False" if res is False else f"filled {res.get('executed_qty')}"
    except LiveHostRefused:
        raise
    except Exception as e:
        res, what = None, f"{type(e).__name__}: {e}"
    w1 = r.wallet()
    r.verdict(f"6d a buy under the venue minimum (${q:.2f}) is skipped by the lib, nothing bought",
              res is False and abs(w1 - w0) <= 1e-12, "False, wallet unchanged",
              f"{what}, wallet {w1 - w0:+.6g}")

    since = _utc_naive().isoformat()
    attempts = []
    r.set_target(1000 * max(r.quote_bal, 1000.0))
    for _ in range(2):
        a0 = _count_lines("state/audit.jsonl", "order_attempt")
        filled = reconcile_rounds(max_rounds=1)
        attempts.append((_count_lines("state/audit.jsonl", "order_attempt") - a0, len(filled)))
    errs = _new_errors(since, r.key)
    r.verdict("7 rejected buy (1000× the quote balance) reported, not retried",
              all(n <= 1 and f == 0 for n, f in attempts) and bool(errs),
              "≤1 attempt and 0 fills per round, an order error",
              f"(attempts, fills) per round {attempts}, "
              f"error {(errs[-1]['error'][:90] if errs else None)!r}")
    r.step(0)
    r.expect_untouched("7b nothing bought, nothing of the user's sold")

    r.step(A)
    r.expect_coins("13a buy in this process", A)
    parent_book = book_rows()
    out = run_child(ws, r.venue, "round")
    r.verdict("13b fresh process, same target: no order, same book",
              out.get("executed") == 0 and out.get("book") == parent_book,
              f"0 orders, {parent_book.get(r.key)}",
              f"{out.get('executed')} orders, {(out.get('book') or {}).get(r.key)} "
              f"{out.get('fatal') or ''}")
    r.set_target(2 * A)
    out = run_child(ws, r.venue, "round")
    r.expect_coins("13c fresh process increases to 2A", 2 * A)
    r.set_target(0)
    out = run_child(ws, r.venue, "round")
    r.expect_untouched(f"13d fresh process sells to zero {out.get('fatal') or ''}".strip())


def spot_user_coins_and_close_all(r, env):
    """In a fresh workspace with an empty book: the main one's closes leave
    sub-step dust in its book, which would ride along into these closes and blur
    what is the user's. Everything in the wallet here is the user's."""
    from lib.portfolio import seed_ledger
    A = r.A
    ws = make_workspace(r.venue, env)
    r.workspaces.append(ws)
    enter_workspace(ws)
    seed_ledger(lambda: {})
    r.manual_buy(A)
    r.user = r.wallet()
    say(f"[{r.venue}] the user's own {r.base} now {r.user:.6g} (start {r.base0:.6g} + a buy "
        f"outside the ledger)")
    r.step(0)
    r.expect_untouched("9a zero target never sells the user's coins")
    r.step(A)
    r.expect_coins("9b target on the same coin buys on top", A)
    r.step(0)
    r.expect_untouched("9c closing the bot's share leaves the user's coins")
    r.step(A)
    r.expect_coins("10a bot coins on top of the user's", A)
    out = run_child(ws, r.venue, "flatten")
    r.expect_untouched("10 close-all sells only the bot's coins")
    r.verdict("10b close-all tripped HALT and emptied the book",
              out.get("halted") is True and r.key not in (out.get("book") or {}),
              "halted, no book row",
              f"halted={out.get('halted')}, book={(out.get('book') or {}).get(r.key)} "
              f"{out.get('fatal') or ''}")
    r.set_target(0)  # before the halt goes: a resume must not re-buy the target
    from lib import guard
    guard.clear_halt("tests/live_testnet_scenarios (scratch workspace)")


def spot_migration(r, env):
    """11: first round of the own-positions rule with coins already in the wallet —
    a fresh workspace with no book."""
    A = r.A
    cases = [("11b split (held > 1.5 × target: only the target's share)", 3.0, False)]
    if r.base0 < r.step_q:
        cases.insert(0, ("11a whole (held ≤ 1.5 × target: all of it)", 1.2, True))
    else:
        say(f"SKIP  [{r.venue}] 11a whole-adopt: the wallet already held {r.base0:g} {r.base} "
            f"before the run, and a whole adoption would make those the bot's to sell — run "
            f"with a --symbol whose coin the demo wallet does not hold to cover it")
    for label, mult, whole in cases:
        ws = make_workspace(r.venue, env)
        r.workspaces.append(ws)
        enter_workspace(ws)
        before = r.wallet()
        r.manual_buy(mult * A)
        held = r.wallet()
        r.set_target(A)
        # round 1 only confirms the read, round 2 writes the baseline, round 3 trades on it
        for _ in range(3):
            reconcile_rounds(max_rounds=1)
        adopted = r.book_qty()
        mark = float(r.order.get_spot_price(r.env, r.sym))
        if whole:
            ok, exp = abs(adopted - held) <= 1e-12, f"book {held:.8g} (the whole wallet)"
        else:
            want = A / mark
            ok = abs(adopted - want) <= 0.02 * want + r.step_q and adopted < held
            exp = f"book ≈ {want:.6g} ±2% (the target's share)"
        r.verdict(label, ok, exp, f"book {adopted:.8g}")
        w = r.wallet()
        r.verdict(f"{label[:3]} adoption sold nothing", abs(w - held) <= 1e-12,
                  f"{held:.8g}", f"{w:.8g}")
        r.step(0)
        w = r.wallet()
        left = held - adopted
        r.verdict(f"{label[:3]} target 0 sells only the adopted coins",
                  left - 1e-12 <= w <= left + r.step_q + 1e-12,
                  f"{left:.8g} (+ < one step)", f"{w:.8g}")
        r.restore(to=before)


def run_venue_spot(venue, env, symbol):
    ws = make_workspace(venue, env)
    enter_workspace(ws)
    _assert_selectors(venue, env)
    from lib.portfolio import seed_ledger
    import manager.reconciler  # noqa: F401 — imported inside the workspace (cwd-relative state)
    try:
        r = SpotRun(venue, env, symbol)
        r.workspaces.append(ws)
        r.ready()
    except SetupFailed as e:
        say(f"ABORT [{venue}] {e} — nothing traded")
        shutil.rmtree(ws, ignore_errors=True)
        return [("setup: demo spot wallet ready", False)]
    seed_ledger(lambda: {})  # fresh start: every coin already in the wallet is the user's
    wire0 = len([w for w in WIRE if w["venue"] == venue])
    try:
        r.calibrate()
        r.need_margin()
        spot_scenarios(r, ws)
        spot_migration(r, env)
        enter_workspace(ws)
        spot_user_coins_and_close_all(r, env)
        rows = [w for w in WIRE if w["venue"] == venue][wire0:]
        bad = [w for w in rows if not w["ok"]]
        r.verdict("12 broker attribution on every spot order request on the wire",
                  rows and not bad, f"{len(rows)} order requests, all attributed",
                  f"{len(rows) - len(bad)}/{len(rows)}" + (f" — missing on {bad[:3]}" if bad else ""))
    except LiveHostRefused as e:
        r.verdict("SAFETY: a non-demo request was refused — run aborted", False, "none", str(e))
    except SetupFailed as e:
        logging.info("setup failed", exc_info=True)
        say(f"ABORT [{venue}] {e} — the rest of this venue is skipped, cleaning up")
        r.results.append(("setup: " + str(e)[:80], False))
    except Exception as e:
        logging.exception("scenario run aborted")
        r.verdict("run aborted by an exception (see log)", False, "no exception",
                  f"{type(e).__name__}: {e}")
    finally:
        try:
            enter_workspace(ws)
            from lib import guard
            if guard.halted():
                guard.clear_halt("tests/live_testnet_scenarios cleanup (scratch workspace)")
            w = r.restore()
            tol = getattr(r, "fee_tol", r.step_q if hasattr(r, "step_q") else 0.0)
            r.verdict("cleanup: wallet back to its starting quantity within one fee",
                      abs(w - r.base0) <= tol + 1e-12,
                      f"{r.base0:.8g} ±{tol:.3g} {r.base}", f"{w:.8g} ({w - r.base0:+.3g})")
        except Exception as e:
            r.verdict("cleanup", False, "wallet restored", f"{type(e).__name__}: {e} — CHECK THE "
                                                             f"DEMO WALLET BY HAND")
        os.chdir(tempfile.gettempdir())
        for w in r.workspaces:
            shutil.rmtree(w, ignore_errors=True)
    return r.results


def run_venue(venue, env, symbol):
    ws = make_workspace(venue, env)
    enter_workspace(ws)
    _assert_selectors(venue, env)
    from lib.portfolio import seed_ledger
    import manager.reconciler  # noqa: F401 — imported inside the workspace (cwd-relative state)
    r = VenueRun(venue, env, symbol)
    r.workspaces.append(ws)
    try:
        r.ready()
        start = r.net_qty()
    except SetupFailed as e:
        say(f"ABORT [{venue}] {e} — nothing traded")
        shutil.rmtree(ws, ignore_errors=True)
        return [("setup: demo account ready", False)]
    if abs(start) > 0:
        say(f"SKIP  [{venue}] {symbol} is not flat on the demo account ({start:+.6g}) — close it "
            f"first or pick --symbol; nothing traded")
        shutil.rmtree(ws, ignore_errors=True)
        return [(f"preflight {symbol} flat", False)]
    seed_ledger(lambda: {})  # fresh start: the book is empty, everything else is the user's
    wire0 = len([w for w in WIRE if w["venue"] == venue])
    try:
        r.calibrate()
        r.need_margin()
        scenarios(r, ws)
        scenario_migration(r, env)
        enter_workspace(ws)
        scenario_manual_and_close_all(r, ws)
        rows = [w for w in WIRE if w["venue"] == venue][wire0:]
        bad = [w for w in rows if not w["ok"]]
        r.verdict("12 broker attribution on every order request on the wire",
                  rows and not bad, f"{len(rows)} order requests, all attributed",
                  f"{len(rows) - len(bad)}/{len(rows)}" + (f" — missing on {bad[:3]}" if bad else ""))
    except LiveHostRefused as e:
        r.verdict("SAFETY: a non-demo request was refused — run aborted", False, "none", str(e))
    except SetupFailed as e:
        logging.info("setup failed", exc_info=True)
        say(f"ABORT [{venue}] {e} — the rest of this venue is skipped, cleaning up")
        r.results.append(("setup: " + str(e)[:80], False))
    except Exception as e:
        logging.exception("scenario run aborted")
        r.verdict("run aborted by an exception (see log)", False, "no exception",
                  f"{type(e).__name__}: {e}")
    finally:
        try:
            enter_workspace(ws)
            from lib import guard
            if guard.halted():
                guard.clear_halt("tests/live_testnet_scenarios cleanup (scratch workspace)")
            flat = r.close_all_direct()
            r.verdict("cleanup: symbol flat on the demo account", flat, "flat",
                      f"{r.net_qty():+.6g}")
        except Exception as e:
            r.verdict("cleanup", False, "flat", f"{type(e).__name__}: {e} — CHECK THE DEMO "
                                                 f"ACCOUNT BY HAND")
        os.chdir(tempfile.gettempdir())
        for w in r.workspaces:
            shutil.rmtree(w, ignore_errors=True)
    return r.results


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--venue", default="all", help="binance / okx / bybit / gateio / all")
    ap.add_argument("--symbol", default="ETHUSDT")
    ap.add_argument("--market", default="swap", choices=("swap", "spot"))
    ap.add_argument("--internal", help=argparse.SUPPRESS)
    ap.add_argument("--workspace", help=argparse.SUPPRESS)
    args = ap.parse_args(argv)
    if args.internal:
        return child_main(args)

    try:
        envs, secrets = preflight(EXPECTED_ENV)
    except Fatal as e:
        say(f"FATAL {e}")
        return 2
    REDACT.secrets |= secrets
    venues = sorted(envs) if args.venue == "all" else [args.venue]
    missing = [v for v in venues if v not in envs]
    if missing:
        say(f"FATAL no keys for {missing} in {EXPECTED_ENV}")
        return 2
    install_http_guard(venues)
    home = os.path.realpath(tempfile.mkdtemp(prefix="blave-testnet-home-"))
    os.environ["BLAVE_AGENT_BASE"] = home  # lib.events / lib.notify: nothing to reach
    os.environ["BLAVE_AGENT_HOME"] = home
    # this process imports lib/ and manager/ from here for the whole run; each
    # workspace keeps its own copy for the cwd-relative checks and the children
    shutil.copytree(os.path.join(ROOT, "lib"), os.path.join(home, "lib"),
                    ignore=shutil.ignore_patterns("__pycache__"))
    os.makedirs(os.path.join(home, "manager"))
    for name in ("reconciler.py", "flatten.py"):
        shutil.copy2(os.path.join(ROOT, "manager", name), os.path.join(home, "manager", name))
    sys.path.insert(0, home)
    log_path = os.path.join(tempfile.gettempdir(),
                            f"blave-testnet-{datetime.now():%Y%m%d-%H%M%S}.log")
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    fh = logging.FileHandler(log_path)
    fh.setFormatter(_RedactingFormatter("%(asctime)s %(levelname)s %(message)s"))
    ch = logging.StreamHandler(sys.stderr)
    ch.setLevel(logging.ERROR)
    ch.setFormatter(_ConsoleFormatter())
    root.addHandler(fh)
    root.addHandler(ch)
    say(f"venues {venues}, {args.market} {args.symbol.upper()}, keys: "
        f"{sorted(k for e in envs.values() for k in e if _CRED_RE.search(k))} (values never shown)")
    say(f"full log: {log_path}")

    results, t0 = [], time.time()
    for venue in venues:
        run = run_venue_spot if args.market == "spot" else run_venue
        results += [(f"[{venue}] {s}", ok) for s, ok in
                    run(venue, envs[venue], canon(args.symbol))]
    shutil.rmtree(home, ignore_errors=True)
    failed = [s for s, ok in results if not ok]
    say(f"\n{len(results) - len(failed)}/{len(results)} passed in {time.time() - t0:.0f}s"
        + ("" if not failed else "\nFAILED:\n  " + "\n  ".join(failed)))
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
