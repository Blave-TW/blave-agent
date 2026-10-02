"""Does a strategy's market match the exchange this machine is bound to? One judge for every
surface: the save refusal (command_listener._cmd_amounts / _cmd_resume) and the verdicts the
report carries to the desktop app and the web workspace (portfolio_reporter), which only display
them — they never re-judge.

Inputs, read from disk (this runtime never imports workspace code):
  - stats.json `market` — written by a backtest from the lib.data price fetcher it really called
    (lib/runner._stats_market): crypto_perp:<venue> / crypto_spot:<venue> / tw_futures /
    tw_stock / us_stock / other; absent on a backtest from before 0.1.12;
  - stats.json `symbol` (Type A) / `market_symbols` (Type C) — what the crypto contract check
    looks up in runtime/market_contracts.py;
  - the strategy folder's code — a US-stock fetcher anywhere in it (also a crypto strategy that
    filters on SPY: no live tick can fetch US data), or BLAVE_AGENT_LOCAL mentioned at all.

Reasons (spec-0.1.12-venue-market-gate §2), most fundamental first: us > legacy / legacyMoved >
twStock / other / twFut / cryptoOnBroker / src. None = trades on that venue. No `market` (a
backtest from before 0.1.12) on a real venue (群益 included, paper not): `legacy` when the
strategy is already routed to that venue — it traded there, so only a NEW pick or $0 → funded
waits for a re-run backtest (the caller applies that) — else `legacyMoved`: routed elsewhere,
unrouted (a rebind blanks the routes) or not picked, nothing says this venue's contract is the
one it was backtested on (Binance ONUSDT is a coin, OKX / Bybit ONUSDT an equity perpetual).

Venues: the five crypto exchanges, paper and 群益 are judged; an official venue the gate has no
column for yet (OFFICIAL_UNJUDGED — Blave ships its order lib) is refused as `other`; any other
id is a user-wired exchange (自訂交易所) and passes. tests/check_market_gate.py enumerates
lib/order_*.py so a newly shipped venue lib cannot fall through to "custom"."""
import io
import json
import os
import re
import sys
import time
import tokenize

REAL_VENUES = ("binance", "bingx", "okx", "gateio", "bybit")
KNOWN_VENUES = REAL_VENUES + ("paper", "capital")
OFFICIAL_UNJUDGED = ("sinopac", "president")

# lib.data's US-stock entry points (public and private), the package behind its fallback and its
# Yahoo session. Code names only: comments and strings are stripped first, so a crypto strategy
# that merely mentions one is not refused.
_US_STOCK_NAMES = re.compile(r"fetch_usstock_price|_usstock_daily|_fetch_usstock_\w+|_yahoo_session|_YAHOO_\w*|yfinance")


def _code_names(src):
    """NAME tokens of a Python source, comments and strings dropped. A file that does not tokenize
    (it would not run either) is matched on its raw text — refusing errs on the safe side."""
    try:
        return " ".join(t.string for t in tokenize.generate_tokens(io.StringIO(src).readline)
                        if t.type == tokenize.NAME)
    except (tokenize.TokenError, IndentationError, SyntaxError):
        return src


def code_flags(folder, cache=None):
    """"flag" when any .py in the strategy folder mentions BLAVE_AGENT_LOCAL anywhere (raw text —
    strategy code trying to unlock the desktop-only path), "us" when one names a US-stock
    fetcher in code (a helper module next to strategy.py counts), else None. `cache` (a dict)
    keeps the answer until a file in the folder changes."""
    try:
        files = sorted(f for f in os.listdir(folder) if f.endswith(".py"))[:50]
        sig = tuple((f, os.stat(os.path.join(folder, f)).st_mtime_ns) for f in files)
    except OSError:
        return None
    if cache is not None and cache.get(folder, (None,))[0] == sig:
        return cache[folder][1]
    found = _scan(folder, files)
    if cache is not None:
        cache[folder] = (sig, found)
    return found


def _scan(folder, files):
    found = None
    for f in files:
        try:
            with open(os.path.join(folder, f), encoding="utf-8", errors="replace") as fh:
                src = fh.read()
        except OSError:
            continue
        if "BLAVE_AGENT_LOCAL" in src:
            return "flag"
        if _US_STOCK_NAMES.search(_code_names(src)):
            found = "us"
    return found


_TABLE = {"sig": None, "perp": {}, "err": None, "tried": 0.0}
_RETRY_S = 5.0   # an unreadable table is retried at most this often (≈ once per reconcile round)


def _contracts():
    """runtime/market_contracts.PERP, loaded by path next to this file (lib/portfolio loads this
    module by path from the reconciler, where the runtime dir is not on sys.path) and kept until
    the file changes. None when it cannot be read (Wei: then the table step is skipped and orders
    go through as before 0.1.12 — never "everything mismatches"): logged on every failed load,
    retried every round, and reported (table_status)."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "market_contracts.py")
    try:
        sig = os.stat(path).st_mtime_ns
    except OSError as e:
        return _table_failed(sig=None, why=f"missing ({type(e).__name__})")
    if _TABLE["sig"] == sig and _TABLE["err"] is None:
        return _TABLE["perp"]
    if _TABLE["err"] is not None and _TABLE["sig"] == sig and time.time() - _TABLE["tried"] < _RETRY_S:
        return None
    try:
        ns = {}
        with open(path, encoding="utf-8") as f:
            exec(compile(f.read(), path, "exec"), ns)  # generated: two literals
        if not isinstance(ns.get("PERP"), dict) or not ns["PERP"]:
            raise ValueError("no PERP table")
    except Exception as e:
        return _table_failed(sig=sig, why=f"unreadable ({type(e).__name__}: {str(e)[:80]})")
    if _TABLE["err"] is not None:
        print(f"[market_gate] contract table readable again — the table check is back on", file=sys.stderr)
    _TABLE.update(sig=sig, perp=ns["PERP"], err=None, tried=time.time())
    return _TABLE["perp"]


def _table_failed(sig, why):
    now = time.time()
    if _TABLE["err"] is None or now - _TABLE["tried"] >= _RETRY_S or _TABLE["sig"] != sig:
        print(f"[market_gate] contract table {why} — the contract-table check is skipped, orders go "
              f"through unchecked against it; retrying", file=sys.stderr)
        _TABLE.update(sig=sig, perp={}, err=why, tried=now)
    return None


def table_status():
    """{"ok": bool, "why": str|None} — whether the contract table is in use right now."""
    _contracts()
    return {"ok": _TABLE["err"] is None, "why": _TABLE["err"]}


def _sym(s):
    return str(s or "").replace("-", "").replace("_", "").replace("/", "").upper()


def same_contract(symbols, src, venue, table=None):
    """Every symbol is the same crypto perpetual on `src` and `venue` (runtime/market_contracts).
    No readable table: True — the check is skipped (see _contracts)."""
    table = _contracts() if table is None else table
    if table is None:
        return True
    syms = [_sym(s) for s in symbols if s]
    return bool(syms) and all(src in table.get(s, "").split() and venue in table.get(s, "").split()
                              for s in syms)


def is_custom(venue):
    return bool(venue) and venue not in KNOWN_VENUES and venue not in OFFICIAL_UNJUDGED


def reason(market, venue, symbols=(), us=False, table=None, label=None):
    """Why a strategy cannot trade on `venue`, or None. `venue` None = nothing bound (only `us`
    can be said); `label` = the venue the strategy is routed to now (portfolio exchanges)."""
    if us or market == "us_stock":
        return "us"
    if not venue or is_custom(venue):
        return None
    if venue in OFFICIAL_UNJUDGED:
        return "other"
    if not market:
        if venue == "paper":
            return None
        return "legacy" if label == venue else "legacyMoved"
    if market == "tw_stock":
        return "twStock"
    if market == "tw_futures":
        return None if venue == "capital" else "twFut"
    if market.startswith(("crypto_perp:", "crypto_spot:")):
        if venue == "paper":     # paper prices fills from the strategy's own fetch_data
            return None
        if venue == "capital":
            return "cryptoOnBroker"
        kind, src = market.split(":", 1)
        if src == venue:
            return None
        if kind == "crypto_perp" and same_contract(symbols, src, venue, table):
            return None
        return "src"             # spot across exchanges: no spot table yet — not the same contract
    return "other"


def read_stats(folder, cache=None):
    """(market, symbols) from strategies/<name>/stats.json, cached by mtime when `cache` is a
    dict. (None, ()) when unreadable — an unreadable file is a strategy with no recorded market."""
    path = os.path.join(folder, "stats.json")
    try:
        mt = os.stat(path).st_mtime_ns
    except OSError:
        return None, ()
    if cache is not None and cache.get(path, (None,))[0] == mt:
        return cache[path][1]
    try:
        with open(path, encoding="utf-8") as f:
            s = json.load(f)
        m = s.get("market") if isinstance(s, dict) else None
        syms = s.get("market_symbols") if isinstance(s, dict) else None
        if not isinstance(syms, list):
            syms = [s.get("symbol")] if isinstance(s, dict) and isinstance(s.get("symbol"), str) else []
        out = (m if isinstance(m, str) and m else None, tuple(x for x in syms if isinstance(x, str)))
    except (OSError, ValueError):
        out = (None, ())
    if cache is not None:
        cache[path] = (mt, out)
    return out


def live_symbols(folder):
    """Symbols the live state hands the reconciler — a Type C's nonzero `weights` (a universe
    picked at run time can drift from the backtest's `market_symbols`) and a Type A's `symbol`
    (code can write another one than the backtest's): the report judges exactly what the
    order-time check (lib/portfolio, judge_symbol) judges, so the two never disagree on a hold."""
    try:
        with open(os.path.join(folder, "state.json"), encoding="utf-8") as f:
            st = json.load(f)
    except (OSError, ValueError):
        return ()
    if not isinstance(st, dict):
        return ()
    one = (str(st["symbol"]),) if isinstance(st.get("symbol"), str) and st["symbol"] else ()
    w = st.get("weights")
    if not isinstance(w, dict):
        return one
    out = list(one)
    for k, v in w.items():
        try:
            if float(v) != 0:
                out.append(str(k))
        except (TypeError, ValueError):
            out.append(str(k))   # unreadable weight: judge the symbol anyway
    return tuple(out)


def judged_symbols(folder, symbols):
    syms = tuple(symbols) + live_symbols(folder)
    seen, out = set(), []
    for x in syms:
        if _sym(x) not in seen:
            seen.add(_sym(x))
            out.append(x)
    return tuple(out)


def read_routing(workspace):
    """(amounts, exchanges) the reconciler trades on: manager/amounts.ui.json when it is valid
    (lib.portfolio.load_portfolio_config's UI-authoritative override), else portfolio_config.json.
    ({}, {}) when neither reads."""
    for name in ("amounts.ui.json", "portfolio_config.json"):
        try:
            with open(os.path.join(workspace, "manager", name), encoding="utf-8") as f:
                doc = json.load(f)
        except (OSError, ValueError):
            continue
        if isinstance(doc, dict) and isinstance(doc.get("amounts"), dict):
            ex = doc.get("exchanges")
            return doc["amounts"], ex if isinstance(ex, dict) else {}
    return {}, {}


def funded(amounts, name):
    try:
        return float(amounts.get(name, 0)) > 0
    except (TypeError, ValueError):
        return False


HOLDS_PATH = os.path.join("state", "market_hold.json")
ALERTED_PATH = os.path.join("state", "market_hold_alerted.json")
ALERT_DEDUP_S = 24 * 3600


def should_alert(workspace, name, why, now=None):
    """One P1 per strategy and reason per day, whoever notices first — the order-time check
    (lib/portfolio) and the report (portfolio_reporter) both write state/market_hold.json, and a
    hold that one of them dropped and the other re-added must not page the user again. Records the
    alert when it says yes."""
    now = time.time() if now is None else now
    path = os.path.join(workspace, ALERTED_PATH)
    try:
        with open(path, encoding="utf-8") as f:
            seen = json.load(f)
        seen = seen if isinstance(seen, dict) else {}
    except (OSError, ValueError):
        seen = {}
    last = seen.get(name)
    if isinstance(last, dict) and last.get("reason") == why and isinstance(last.get("at"), (int, float)) \
            and now - last["at"] < ALERT_DEDUP_S:
        return False
    seen[name] = {"reason": why, "at": now}
    seen = {k: v for k, v in seen.items() if isinstance(v, dict) and now - float(v.get("at") or 0) < ALERT_DEDUP_S}
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(seen, f)
        os.replace(tmp, path)
    except OSError:
        pass
    return True


def holds(workspace, cache=None):
    """{name: {venue, reason[, symbols]}} for every funded Type A/C strategy whose market no
    longer matches the venue it is routed to — the save gate let it in, then the table, its
    symbols, its stats or its code changed. `symbols` (a crypto symbol mismatch only) = the ones
    that are not the same contract there; absent = the whole strategy. lib/portfolio freezes
    exactly that share (no entry, no exit); the report warns. A Type B that orders by itself
    (mode None) never reaches lib/portfolio and is not judged."""
    amounts, labels = read_routing(workspace)
    out = {}
    for name in sorted(amounts):
        venue = str(labels.get(name) or "").lower()
        if not venue or not funded(amounts, name):
            continue
        why, market, syms = judge(workspace, name, venue, label=venue, cache=cache)
        if not why or why in ("legacy", "notRun"):   # notRun: no symbol written, nothing trades yet
            continue
        out[name] = {"venue": venue, "reason": why}
        if why == "unconfirmed":
            bad = sorted(_sym(x) for x in syms if symbols_reason([x], venue))
            if bad:
                out[name]["symbols"] = bad
        elif why == "src" and market.startswith("crypto_perp:"):
            src = market.split(":", 1)[1]
            bad = sorted(_sym(x) for x in syms if not same_contract([x], src, venue))
            if bad:
                out[name]["symbols"] = bad
    return out


# What the gate judges a strategy by (`mode`):
#   "market"  — a stats.json (Type A/C, or a backtested strategy whatever its INTERVAL looks like:
#               an `INTERVAL: str = '1h'` the scheduler regex misses still runs lib.runner, writes
#               stats.json and state.json) or a valid INTERVAL: the market rules above.
#   "symbols" — a Type B that feeds the reconciler: a state.json with a symbol / weights (however
#               it got written — lib.execute.update_state or a json.dump of its own), or, before
#               its first run (no state.json yet), code that names update_state. No market to
#               judge, so every symbol it hands the reconciler must be one the contract table
#               confirms as a crypto perpetual on that exchange (TXF / MXF / TMF on 群益):
#               `unconfirmed` otherwise, `notRun` while it has not written one yet.
#   None      — a Type B that places its own orders (a state.json without a symbol, or none and
#               no update_state): not judged, as before 0.1.12. Whatever it is, anything that
#               reaches the reconciler is judged again right before its order (judge_symbol,
#               lib/portfolio) — a strategy this misses cannot place a first order through it.
_FEEDS_NAMES = re.compile(r"\bupdate_state\b")
_TW_INDEX_FUTURES = ("TXF", "MXF", "TMF")


def state_symbols(folder):
    """Symbols the strategy's state.json hands the reconciler (Type A `symbol`, Type C every
    `weights` key); () when there is no such state."""
    try:
        with open(os.path.join(folder, "state.json"), encoding="utf-8") as f:
            st = json.load(f)
    except (OSError, ValueError):
        return ()
    if not isinstance(st, dict):
        return ()
    out = [str(k) for k in st["weights"]] if isinstance(st.get("weights"), dict) else []
    if isinstance(st.get("symbol"), str) and st["symbol"]:
        out.append(st["symbol"])
    return tuple(dict.fromkeys(out))


def _feeds_by_code(folder):
    try:
        files = sorted(f for f in os.listdir(folder) if f.endswith(".py"))[:50]
    except OSError:
        return False
    for f in files:
        try:
            with open(os.path.join(folder, f), encoding="utf-8", errors="replace") as fh:
                if _FEEDS_NAMES.search(_code_names(fh.read())):
                    return True
        except OSError:
            continue
    return False


def gate_mode(workspace, name):
    folder = os.path.join(workspace, "strategies", name)
    if os.path.isfile(os.path.join(folder, "stats.json")) or not type_b(workspace, name):
        return "market"
    if os.path.isfile(os.path.join(folder, "state.json")):
        return "symbols" if state_symbols(folder) else None
    return "symbols" if _feeds_by_code(folder) else None


def symbols_reason(symbols, venue, table=None):
    """Why a reconciler-fed Type B's symbols cannot trade on `venue`, or None."""
    if not venue or is_custom(venue) or venue == "paper":
        return None
    if venue in OFFICIAL_UNJUDGED:
        return "other"
    syms = [_sym(s) for s in symbols if s]
    if not syms:
        return "notRun"
    if venue == "capital":
        ok = all((s[:-2] if s.endswith("R1") else s) in _TW_INDEX_FUTURES for s in syms)
        return None if ok else "unconfirmed"
    table = _contracts() if table is None else table
    if table is None:
        return None   # no readable table: the table step is skipped (see _contracts)
    return None if all(venue in table.get(s, "").split() for s in syms) else "unconfirmed"


def judge(workspace, name, venue, label=None, cache=None, table=None):
    """(reason or None, market, symbols judged) for strategies/<name>/ on `venue`."""
    folder = os.path.join(workspace, "strategies", name)
    mode = gate_mode(workspace, name)
    if mode is None:
        return None, None, ()
    if mode == "symbols":
        syms = state_symbols(folder)
        return symbols_reason(syms, venue, table), None, syms
    market, symbols = read_stats(folder, cache)
    syms = judged_symbols(folder, symbols)
    return reason(market, venue, syms, us=code_flags(folder, cache) == "us", table=table, label=label), market, syms


_SYMBOL_CACHE = {}   # (workspace, name, symbol, venue) → (signature, reason)
_FILE_CACHE = {}     # read_stats / code_flags, shared by every symbol of a strategy: one parse per change


def _folder_sig(workspace, folder):
    try:
        files = sorted(f for f in os.listdir(folder) if f.endswith(".py") or f == "stats.json")
        return (tuple((f, os.stat(os.path.join(folder, f)).st_mtime_ns) for f in files),
                os.path.isfile(os.path.join(workspace, "manager", "wait_for_bar.py")), _TABLE["sig"], _TABLE["err"])
    except OSError:
        return None


def judge_symbol(workspace, name, symbol, venue, cache=None):
    """Reason the reconciler must not order `symbol` for strategy `name` on `venue` (routed
    there), or None — the same rules as judge(), for one symbol it is about to trade. Whatever
    wrote the state (a Type B the save-time mode missed included): a strategy with a stats.json
    or a valid INTERVAL is judged by its market, anything else by the symbol itself. Cached until
    a .py, stats.json or the contract table changes: the reconciler asks every few seconds."""
    folder = os.path.join(workspace, "strategies", name)
    _contracts()  # refresh _TABLE["sig"] before the signature reads it
    cache = _FILE_CACHE if cache is None else cache
    key = (workspace, name, _sym(symbol), venue)
    sig = _folder_sig(workspace, folder)
    hit = _SYMBOL_CACHE.get(key)
    if sig is not None and hit and hit[0] == sig:
        return hit[1]
    if os.path.isfile(os.path.join(folder, "stats.json")) or not type_b(workspace, name):
        market, _ = read_stats(folder, cache)
        why = reason(market, venue, [symbol], us=code_flags(folder, cache) == "us", label=venue)
    else:
        why = symbols_reason([symbol], venue)
    if sig is not None:
        _SYMBOL_CACHE[key] = (sig, why)
    return why


# Type A/C = the workspace has manager/wait_for_bar.py and strategy.py declares a valid INTERVAL —
# the same test as command_listener._strategy_has_interval (tests/check_market_gate.py runs both
# on the same cases). Anything else is Type B: crontab / schtasks, never lib/portfolio, so the gate
# never judges it (it had no market rule before 0.1.12 and has no backtest to record one).
_INTERVAL_RE = re.compile(r'^\s*INTERVAL\s*=\s*["\']([^"\']+)["\']', re.M)
_INTERVAL_VALUE_RE = re.compile(r"^(\d+)(min|m|h|d|w)$")


def type_b(workspace, name):
    if not os.path.isfile(os.path.join(workspace, "manager", "wait_for_bar.py")):
        return True
    try:
        with open(os.path.join(workspace, "strategies", name, "strategy.py"),
                  encoding="utf-8", errors="replace") as f:
            m = _INTERVAL_RE.search(f.read())
    except OSError:
        return True
    return not (m and _INTERVAL_VALUE_RE.fullmatch(m.group(1)))


def lib_writes_market(workspace):
    """The workspace lib records `market` on a backtest (capability flag, like
    portfolio_reporter.can_trade_portfolio): a lib from before it can never write one, so a
    re-run backtest could never lift `legacy` — the whole gate stays off there."""
    try:
        with open(os.path.join(workspace, "lib", "runner.py"), encoding="utf-8", errors="replace") as f:
            return "def _stats_market(" in f.read()
    except OSError:
        return False


def data_venues(workspace):
    """Exchanges whose klines the workspace lib can backtest on (lib.data fetch_kline = Binance,
    fetch_bingx_kline = BingX) — what decides whether "re-run it on {venue} data" can be said."""
    try:
        with open(os.path.join(workspace, "lib", "data.py"), encoding="utf-8", errors="replace") as f:
            src = f.read()
    except OSError:
        return []
    return [v for v, fn in (("binance", "def fetch_kline("), ("bingx", "def fetch_bingx_kline("))
            if fn in src]
