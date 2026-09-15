"""Close ONE perp position (one symbol, one side) on one venue.

    cd workspace && python3 manager/close_symbol.py --venue bingx --symbol XRPUSDT --side long \\
        --key-name BINGX_API_KEY_XRP_V2 --secret-name BINGX_SECRET_KEY_XRP_V2 \\
        [--passphrase-name OKX_PASSPHRASE_X] [--demo-name BINGX_DEMO_XRP_V2] [--dry-run]

For "close that one coin" requests. manager/flatten.py is the whole-account
panic button and trips the global HALT; this touches nothing but the named
symbol and never trips HALT (every other strategy keeps trading).

Keys: the .env NAMES are passed explicitly and only those are used. Every
other credential and demo flag of the venue is removed from the env the libs
see, so a missing name can never fall back to the main account — an agent's
hand-written `or env.get("BINGX_API_KEY")` did exactly that (uid 30979,
2026-09). No --demo-name = live endpoints, and the output says so.

Refusals (heuristic, no override flag): a live strategy whose files mention the
same symbol on the same key would re-open the position. Spot (`@spot`),
non-crypto-perp venues, and a symbol that also has an opposite-side position
(hedge mode — the symbol-wide cancel would strip its protection) are refused.

Cancels (regular + conditional) and the close go through lib/order_<venue>,
which already does broker attribution, guard and audit.

Exit: 0 closed and verified (sub-minimum dust may remain, printed) · 1 a step
failed, something is left, or conditional orders could not be listed ·
2 refused or the exchange could not be read, nothing changed · 4 no position on
that side, nothing sent (same codes as manager/stop_strategy.py).
"""
import argparse
import importlib
import json
import logging
import os
import platform
import re
import subprocess
import sys
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
for _p in (ROOT, HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from lib.data import normalize_symbol  # noqa: E402
from lib.venue_wiring import read_env  # noqa: E402

# shared with stop_strategy.py: 3 is its "no name matched"
OK, FAILED, REFUSED, NO_POSITION = 0, 1, 2, 4

# lib/account_gateio + order_gateio accept both spellings
_HEADS = {"gateio": ("GATEIO", "GATE")}
_VENUE_WORDS = {"gateio": r"gateio|gate_io|gate\.io"}
_CRED_FIELDS = ("API_KEY", "SECRET_KEY", "API_SECRET", "PASSPHRASE", "DEMO")
_NOT_PERP = {"capital", "sinopac"}
_QUOTES = ("USDT", "USDC", "USD")
_NAME_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")
_ENV_NAME_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
# libs whose get_open_orders already includes conditional orders
_CONDITIONAL_IN_REGULAR = {"order_bingx"}
# libs whose cancel_all_orders clears regular AND conditional orders
_CANCEL_ALL_COVERS_CONDITIONAL = {"order_bingx", "order_binance", "order_gateio", "order_bybit"}
# code and config only — data dumps (.csv) and logs mention every symbol ever traded
_SCAN_EXT = (".py", ".json", ".yaml", ".yml", ".toml", ".txt", ".env", ".ini", ".cfg", ".conf")
_MAX_SCAN_BYTES = 2_000_000


class Refused(Exception):
    pass


def _heads(venue):
    return _HEADS.get(venue, (venue.upper(),))


def credential_names(env):
    """Credential-looking NAMES in .env — never values."""
    return sorted(k for k in env if re.search(r"API_KEY|SECRET|PASSPHRASE|DEMO", k))


def resolve_keys(env, venue, key_name=None, secret_name=None, passphrase_name=None,
                 demo_name=None):
    """(env the libs should see, key name in use, is_generic). Raises Refused.
    is_generic: the key is the venue's own {VENUE}_API_KEY — the account the
    reconciler, 交易歷史 and self-ledger track."""
    given = [n for n in (key_name, secret_name, passphrase_name, demo_name) if n]
    if venue == "paper":
        if given:
            raise Refused("paper has no keys — key/demo name flags do not apply")
        return dict(env), None, True
    heads = _heads(venue)
    if not key_name or not secret_name or (venue == "okx" and not passphrase_name):
        need = "--key-name, --secret-name" + (", --passphrase-name" if venue == "okx" else "")
        raise Refused(f"{need} required; credential names in .env: "
                      f"{credential_names(env) or 'none'}")
    for n in given:
        if not _ENV_NAME_RE.fullmatch(n):
            raise Refused(f"bad .env name: {n!r}")
    missing = [n for n in given if not env.get(n)]
    if missing:
        raise Refused(f"not in .env (no fallback): {', '.join(missing)}; credential names in "
                      f".env: {credential_names(env) or 'none'}")
    scoped = {k: v for k, v in env.items()
              if k not in given
              and not any(k == f"{h}_{f}" or k.startswith(f"{h}_{f}_")
                          for h in heads for f in _CRED_FIELDS)}
    scoped[f"{heads[0]}_API_KEY"] = env[key_name]
    scoped[f"{heads[0]}_SECRET_KEY"] = env[secret_name]
    if passphrase_name:
        scoped[f"{heads[0]}_PASSPHRASE"] = env[passphrase_name]
    # explicit value on every spelling: the libs fall back to os.environ only
    # when the env dict lacks the key
    for h in heads:
        scoped[f"{h}_DEMO"] = env[demo_name] if demo_name else "false"
    return scoped, key_name, key_name in {f"{h}_API_KEY" for h in heads}


def _scrub_process_demo(venue):
    for h in _heads(venue):
        os.environ.pop(f"{h}_DEMO", None)


def strategy_line_patterns(name):
    """Schedule lines / process command lines that run strategy <name>: the
    run_strategy.sh / wait_for_bar.py forms, and ANY reference to
    strategies/<name>/ or strategies/<name>.py (monitors like
    strategies/<name>/position_monitor.py are what the web delete's purge misses)."""
    n = re.escape(name)
    return [re.compile(r"run_strategy\.sh\s+['\"]?%s['\"]?(\s|$)" % n),
            re.compile(r"wait_for_bar\.py\s+['\"]?%s['\"]?(\s|$)" % n),
            re.compile(r"strategies[/\\]%s([/\\]|\.py\b)" % n)]


def schedule_lines(text):
    return [l for l in (text or "").splitlines() if l.strip() and not l.lstrip().startswith("#")]


def read_schedules():
    """Active schedule text: crontab, or schtasks' verbose rows on Windows
    (each row carries its Task To Run). Raises Refused when unreadable — a
    conflict check that can't see schedules must not wave the close through."""
    try:
        if platform.system() == "Windows":
            out = subprocess.run(["schtasks", "/query", "/v", "/fo", "csv", "/nh"],
                                 capture_output=True, text=True, errors="replace", timeout=30)
            if out.returncode != 0:
                raise Refused(f"schtasks query failed: {(out.stderr or '').strip()[:120]}")
            return out.stdout
        out = subprocess.run(["crontab", "-l"], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError) as e:
        raise Refused(f"cannot read schedules ({type(e).__name__}: {e})")
    if out.returncode != 0:
        if "no crontab" in (out.stderr or "").lower():
            return ""
        raise Refused(f"crontab -l failed: {(out.stderr or '').strip()[:120]}")
    return out.stdout


_ARGV0_RE = re.compile(r"^(.*[/\\])?(python[0-9.]*(\.exe)?|bash)$")


def read_processes():
    """ps text ('pid args' per line); '' on Windows (no ps)."""
    if platform.system() == "Windows":
        return ""
    out = subprocess.run(["ps", "-eo", "pid=,args="], capture_output=True, text=True, timeout=10)
    return out.stdout


def running_pids(name, ps_text):
    """PIDs of python/bash processes running <name> (argv[0] must be python or
    bash — an editor or `grep strategies/<name>/` never counts)."""
    pats = strategy_line_patterns(name)
    me = {os.getpid(), os.getppid()}
    pids = []
    for line in (ps_text or "").splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) != 2 or not parts[0].isdigit():
            continue
        pid, args = int(parts[0]), parts[1]
        if pid in me or not _ARGV0_RE.match(args.split()[0]):
            continue
        if any(p.search(args) for p in pats):
            pids.append(pid)
    return sorted(pids)


def portfolio_members(cfg):
    """{strategy: exchange or None} — the key union the reconciler trades off
    (same as the runtime's delete guard: amounts | weights | exchanges)."""
    out = {}
    if not isinstance(cfg, dict):
        return out
    for key in ("amounts", "weights", "exchanges"):
        val = cfg.get(key)
        if isinstance(val, dict):
            for k in val:
                out.setdefault(k, None)
    ex = cfg.get("exchanges")
    if isinstance(ex, dict):
        for k, v in ex.items():
            out[k] = v if isinstance(v, str) else None
    return out


def canonical_symbol(symbol):
    sym = normalize_symbol(symbol or "")
    return sym[:-4] if sym.endswith("SWAP") and sym[:-4].endswith(_QUOTES) else sym


def symbol_regex(symbol):
    sym = canonical_symbol(symbol)
    for q in _QUOTES:
        if sym.endswith(q) and len(sym) > len(q):
            body = re.escape(sym[:-len(q)]) + r"[-_/]?" + q
            break
    else:
        body = re.escape(sym)
    return re.compile(r"(?<![A-Za-z0-9])%s(?![A-Za-z0-9])" % body, re.IGNORECASE)


def _read_text(path):
    try:
        base = os.path.basename(path).lower()
        if not (base.endswith(_SCAN_EXT) or base.startswith(".env")) \
                or os.path.getsize(path) > _MAX_SCAN_BYTES:
            return ""
        with open(path, "rb") as f:
            raw = f.read()
    except OSError:
        return ""
    return "" if b"\0" in raw[:4096] else raw.decode("utf-8", errors="replace")


def strategy_sources(strategies_dir):
    """{name: concatenated text of every text file} for strategies/<name>/ and strategies/<name>.py."""
    out = {}
    if not os.path.isdir(strategies_dir):
        return out
    for entry in sorted(os.listdir(strategies_dir)):
        if entry.startswith((".", "TEMPLATE")) or entry == "__pycache__":
            continue
        full = os.path.join(strategies_dir, entry)
        if os.path.isdir(full):
            paths = []
            for d, dirs, files in os.walk(full):
                dirs[:] = [x for x in dirs if x != "__pycache__" and not x.startswith(".")]
                paths += [os.path.join(d, f) for f in files]
            name = entry
        elif entry.endswith(".py"):
            paths, name = [full], entry[:-3]
        else:
            continue
        out[name] = out.get(name, "") + "\n".join(_read_text(p) for p in paths)
    return out


def find_conflicts(strategies_dir, schedule_text, ps_text, members, venue, key_name, symbol,
                   is_generic, exclude=()):
    """(conflicting names, scanned names). Heuristic. A strategy conflicts when
    it is LIVE — a schedule line or a running python/bash process references it,
    or it is a portfolio member routed to this venue (generic key only: the
    reconciler trades on it) — AND its files mention the symbol AND it is on the
    same key:
      named key → the literal key name appears;
      generic key → the generic name appears, or no key name of this venue
      appears but the files name the venue (order_<venue> / the venue word)."""
    lines = schedule_lines(schedule_text)
    sym_re = symbol_regex(symbol)
    heads = "|".join(_heads(venue))
    generic_re = re.compile(r"(?<![A-Za-z0-9_])(%s)_API_KEY(?![A-Za-z0-9_])" % heads)
    other_key_re = re.compile(r"(?<![A-Za-z0-9_])(%s)_API_KEY_[A-Za-z0-9_]+" % heads)
    venue_re = re.compile(r"(?<![A-Za-z0-9])(%s)(?![A-Za-z0-9])" % _VENUE_WORDS.get(venue, re.escape(venue)),
                          re.IGNORECASE)
    sources = strategy_sources(strategies_dir)
    conflicts = []
    for name, src in sources.items():
        if name in exclude or not sym_re.search(src):
            continue
        live = (any(p.search(l) for p in strategy_line_patterns(name) for l in lines)
                or bool(running_pids(name, ps_text)))
        if is_generic and members.get(name) == venue:
            # routing lives in portfolio_config, not in the strategy's files
            live = same_key = True
        elif is_generic:
            same_key = bool(generic_re.search(src)) or (
                not other_key_re.search(src) and bool(venue_re.search(src)))
        else:
            same_key = bool(re.search(r"(?<![A-Za-z0-9_])%s(?![A-Za-z0-9_])"
                                      % re.escape(key_name), src))
        if live and same_key:
            conflicts.append(name)
    return conflicts, sorted(n for n in sources if n not in exclude)


def load_members():
    from lib.portfolio import load_portfolio_config
    out = {}
    path = os.path.join("manager", "portfolio_config.json")
    try:
        with open(path) as f:
            out.update(portfolio_members(json.load(f)))
    except FileNotFoundError:
        pass
    except (OSError, ValueError) as e:
        # manager.py writes it non-atomically — unreadable may be mid-write
        raise Refused(f"portfolio config unreadable ({type(e).__name__}) — try again")
    for k, v in portfolio_members(load_portfolio_config()).items():
        if k not in out or v is not None:
            out[k] = v
    return out


def validate(venue, symbol, side):
    """Checks that need no network. Returns the canonical symbol."""
    if not _NAME_RE.fullmatch(venue or "") or venue != venue.lower():
        raise Refused("bad --venue (lowercase venue id, e.g. bingx)")
    if venue in _NOT_PERP:
        raise Refused(f"{venue} is not a crypto perp venue — close_symbol is perp only")
    if "@" in (symbol or ""):
        raise Refused("spot inventory (@spot) is not a perp position — close_symbol is perp only")
    if side not in ("long", "short"):
        raise Refused("--side must be long or short")
    sym = canonical_symbol(symbol)
    if not re.fullmatch(r"[A-Z0-9]{2,30}", sym):
        raise Refused("bad --symbol")
    for kind in ("account", "order"):
        if not os.path.isfile(os.path.join("lib", f"{kind}_{venue}.py")):
            raise Refused(f"lib/{kind}_{venue}.py missing — venue not supported here")
    return sym


def load_venue(venue):
    return (importlib.import_module(f"lib.account_{venue}"),
            importlib.import_module(f"lib.order_{venue}"))


def wait_inflight(sym):
    from flatten import _wait_for_inflight
    return _wait_for_inflight(symbol=sym)


class Ctx:
    def __init__(self, **kw):
        self.__dict__.update(kw)


def prepare(venue, symbol, side, key_name=None, secret_name=None, passphrase_name=None,
            demo_name=None, exclude=()):
    """Everything that can refuse without touching the exchange. Any failure is
    a refusal: nothing has been changed yet."""
    try:
        return _prepare(venue, symbol, side, key_name, secret_name, passphrase_name,
                        demo_name, exclude)
    except Refused:
        raise
    except Exception as e:
        raise Refused(f"preparation failed ({type(e).__name__}: {str(e)[:200]}) — nothing changed")


def read_before_change(ctx, label):
    """read_state for a point where nothing has been changed yet: a failed read
    is a refusal (exit 2), not a half-done close."""
    try:
        return read_state(ctx, label)
    except Exception as e:
        raise Refused(f"exchange read failed ({type(e).__name__}: {str(e)[:200]}) — nothing changed")


def _prepare(venue, symbol, side, key_name, secret_name, passphrase_name, demo_name, exclude):
    sym = validate(venue, symbol, side)
    env, key, generic = resolve_keys(read_env(".env"), venue, key_name, secret_name,
                                     passphrase_name, demo_name)
    conflicts, scanned = find_conflicts("strategies", read_schedules(), read_processes(),
                                        load_members(), venue, key, sym, generic, exclude)
    print(f"conflict check (heuristic — file text, schedules, processes, portfolio): "
          f"scanned {len(scanned)}: {', '.join(scanned) or 'none'}")
    if conflicts:
        raise Refused(f"live strategies trade {sym} on this key: {', '.join(conflicts)} — they "
                      f"would re-open it; stop them first (manager/stop_strategy.py) or, for "
                      f"下單設定 members, the user removes them on the web")
    _scrub_process_demo(venue)
    acct, order = load_venue(venue)
    print(f"key: {key}" + (" (generic key)" if generic and key else "") if key else "key: none (paper)")
    demo = env.get(f"{_heads(venue)[0]}_DEMO", "false")
    print(f"demo: {demo}" + ("" if demo_name else " (no --demo-name → live endpoints)"))
    return Ctx(venue=venue, sym=sym, side=side, env=env, key=key, generic=generic,
               acct=acct, order=order)


def _rows(positions, sym):
    if isinstance(positions, dict):  # agent-written libs sometimes return the reconciler shape
        positions = [{"symbol": k, **(v if isinstance(v, dict) else {})} for k, v in positions.items()]
    return [p for p in positions or []
            if canonical_symbol(str(p.get("symbol") or "")) == sym and float(p.get("size") or 0) > 0]


def _algo_rows(order, env, sym):
    """Conditional orders, or None when this lib cannot list them."""
    name = order.__name__.split(".")[-1]
    if name == "order_okx":
        return order.get_open_algo_orders(env, sym, ord_types=order.CLOSE_ALGO_ORD_TYPES) or []
    if hasattr(order, "get_open_algo_orders"):
        return order.get_open_algo_orders(env, sym) or []
    if name in _CONDITIONAL_IN_REGULAR:
        return []
    return None


def read_state(ctx, label):
    """(position rows, regular orders, conditional orders or None). Prints it all."""
    try:
        eq = ctx.acct.get_equity(ctx.env)
        print(f"[{label}] equity: {eq.get('equity') if isinstance(eq, dict) else eq}")
    except Exception as e:
        print(f"[{label}] equity read failed: {type(e).__name__}: {e}")
    rows = _rows(ctx.acct.get_positions(ctx.env), ctx.sym)
    print(f"[{label}] {ctx.sym} positions: " +
          (", ".join(f"{p.get('side')} {p.get('size')} @mark {p.get('mark_price')}" for p in rows)
           or "none"))
    regular = ctx.order.get_open_orders(ctx.env, ctx.sym) or []
    algo = _algo_rows(ctx.order, ctx.env, ctx.sym)
    print(f"[{label}] {ctx.sym} open orders: {len(regular)}")
    for o in regular:
        print(f"    order {_oid(o)} {o.get('side') or o.get('positionSide') or ''} {o.get('type') or ''}")
    if algo is None:
        print(f"[{label}] WARNING: {ctx.order.__name__} cannot list conditional orders")
    else:
        print(f"[{label}] {ctx.sym} conditional orders: {len(algo)}")
        for o in algo:
            print(f"    algo {_algo_id(o)} {o.get('ordType') or o.get('stop_order_type') or ''}")
    return rows, regular, algo


def _oid(o):
    return o.get("order_id") or o.get("orderId") or o.get("ordId") or o.get("id")


def _algo_id(o):
    return o.get("algoId") or o.get("algo_id") or o.get("order_id") or o.get("id")


def check_other_side(ctx, rows):
    other = [p for p in rows if p.get("side") != ctx.side]
    if other:
        raise Refused(f"{ctx.sym} also has a {other[0].get('side')} position on this account "
                      f"(hedge mode) — not touching it; close by hand on the exchange")


def _cancel(order, env, sym, regular, algo):
    """Returns False when some order kind could not be cancelled by this lib."""
    name = order.__name__.split(".")[-1]
    if name in _CANCEL_ALL_COVERS_CONDITIONAL:
        order.cancel_all_orders(env, sym)
        return True
    for o in regular:
        order.cancel_order(env, sym, _oid(o))
    if not algo:
        return algo is not None
    if name == "order_paper":
        order.cancel_protective_orders(env, sym)
        return True
    if name == "order_okx":
        for o in algo:
            order.cancel_algo_order(env, sym, _algo_id(o))
        return True
    return False


def run_close(ctx, dry_run=False):
    from lib.portfolio import _append_reconciler_log, _record_order_error, zero_ledger_symbols

    sym, side, env, order = ctx.sym, ctx.side, ctx.env, ctx.order
    wait_inflight(sym)
    rows, regular, algo = read_before_change(ctx, "before")
    check_other_side(ctx, rows)
    before = [p for p in rows if p.get("side") == side]
    if not before:
        print(f"no {side} {sym} position — nothing sent, orders left as they are")
        if regular or algo:
            print(f"WARNING: {sym} still has {len(regular)} open and {len(algo or [])} conditional "
                  f"order(s) on this account — not cancelled: "
                  f"{', '.join(str(_oid(o)) for o in regular)} {', '.join(str(_algo_id(o)) for o in algo or [])}")
        return NO_POSITION
    if dry_run:
        print("dry run — nothing sent")
        return OK

    unprotected = (f"WARNING: protective orders on {sym} were cancelled but the {side} position may "
                   f"still be OPEN and UNPROTECTED — check and close it on the exchange now")
    ok = True
    if algo is None:
        print("WARNING: conditional orders cannot be listed on this venue lib — they may survive")
        ok = False
    try:
        if not _cancel(order, env, sym, regular, algo):
            print("WARNING: this venue lib cannot cancel conditional orders")
            ok = False
    except Exception as e:
        print(f"cancel failed: {type(e).__name__}: {e}")
        _record_order_error(sym, ctx.venue, f"close_symbol cancel: {e}")
        ok = False

    # sized from a fresh read: a TP/SL may have fired between the snapshot and the
    # cancel; if that read fails, close the pre-cancel size (reduce-only caps it)
    try:
        target = [p for p in _rows(ctx.acct.get_positions(env), sym) if p.get("side") == side]
    except Exception as e:
        print(f"position re-read after cancel failed ({type(e).__name__}: {e}) — "
              f"closing the pre-cancel size reduce-only")
        target, ok = before, False
    size = float(target[0]["size"]) if target else 0.0
    closed = False
    if not target:
        print(f"{side} {sym} is already gone after the cancel (a trigger fired?) — no close sent")
    else:
        price = float(target[0].get("mark_price") or 0)
        try:
            # no price arg: with it format_qty also enforces min notional, which
            # reduce-only closes are exempt from on some venues (flatten audit S2)
            order.format_qty(env, sym, size)
        except ValueError:
            print(f"{sym} {side} {size} is below the venue minimum — dust left")
            target = []
        if target:
            cid = f"csym{datetime.utcnow().strftime('%Y%m%d%H%M%S%f')}"
            try:
                result = order.close_position_partial(env, sym, side, size, client_order_id=cid)
                closed = True
            except Exception as e:
                print(f"close failed: {type(e).__name__}: {e}")
                print(unprotected)
                _record_order_error(sym, ctx.venue, f"close_symbol: {e}")
                result, ok = None, False
            if closed:
                r = result if isinstance(result, dict) else {}
                print(f"closed {side} {sym} {size}: avg_price={r.get('avg_price')} "
                      f"executed_qty={r.get('executed_qty')}")
            if closed and ctx.generic:
                # only the generic key's account is what 交易歷史 and the self-ledger
                # track; a named sub-account key must not zero the main account's row
                notional = round(size * price, 2) if price else None
                leg = {"signed_diff": (-notional if side == "long" else notional) if notional else None,
                       "reduce_only": True, "exchange": ctx.venue}
                if r.get("avg_price") is not None:
                    leg["fill_price"] = r["avg_price"]
                if r.get("executed_qty") is not None:
                    leg["executed_qty"] = r["executed_qty"]
                _append_reconciler_log({"action": "SELL" if side == "long" else "BUY",
                                        "symbol": sym, "signed_diff": leg["signed_diff"],
                                        "exchange": ctx.venue, "asset_spec": None,
                                        "contributors": [], "legs": [leg]})
                zero_ledger_symbols({sym})

    try:
        rows, regular, algo = read_state(ctx, "after")
    except Exception as e:
        print(f"read after the close failed ({type(e).__name__}: {e}) — result unverified")
        if not closed:
            print(unprotected)
        return FAILED
    if [p for p in rows if p.get("side") == side] and (closed or not ok):
        print(f"WARNING: {side} {sym} still open")
        print(unprotected)
        ok = False
    if regular or algo:
        print(f"WARNING: {sym} still has open orders")
        ok = False
    if algo is None:
        print("WARNING: conditional orders could not be verified")
        ok = False
    return OK if ok else FAILED


def close_symbol(venue, symbol, side, key_name=None, secret_name=None, passphrase_name=None,
                 demo_name=None, dry_run=False):
    """Run from the workspace root. Returns an exit code; raises Refused."""
    ctx = prepare(venue, symbol, side, key_name, secret_name, passphrase_name, demo_name)
    return run_close(ctx, dry_run)


def add_key_args(ap):
    ap.add_argument("--key-name", help=".env name of the API key")
    ap.add_argument("--secret-name", help=".env name of the secret")
    ap.add_argument("--passphrase-name", help=".env name of the passphrase (OKX)")
    ap.add_argument("--demo-name", help=".env name of the demo flag; omitted = live")


def main(argv=None):
    ap = argparse.ArgumentParser(description="Close one perp position on one venue.")
    ap.add_argument("--venue", required=True)
    ap.add_argument("--symbol", required=True)
    ap.add_argument("--side", required=True, choices=("long", "short"))
    add_key_args(ap)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    os.chdir(ROOT)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        return close_symbol(a.venue, a.symbol, a.side, a.key_name, a.secret_name,
                            a.passphrase_name, a.demo_name, a.dry_run)
    except Refused as e:
        print(f"REFUSED: {e}")
        return REFUSED


if __name__ == "__main__":
    sys.exit(main())
