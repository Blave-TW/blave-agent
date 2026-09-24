"""
Static quality analysis for Type A / Type C strategy files — catches a broken or
unfilled compute_signals() contract, backtest fee-drag gaming (FEE=0), a
TAIFEX futures strategy missing the mandatory txf_settlement_mask, an
indicator-driven Type A strategy without a PLOT_SERIES declaration, and a
pinned END date (which freezes a deployed strategy's signals forever), before a
strategy is submitted to the marketplace or run after being purchased.

Usage:
    python3 lib/quality_check.py strategies/xyz.py

Exit codes:
    0 — clean
    1 — warnings only (review before running/submitting)
    2 — critical issues, file unreadable, or no file argument (do NOT run/submit)
"""

import ast
import sys
from pathlib import Path


def check(filepath: str) -> list[dict]:
    """Return list of findings: {level: 'CRITICAL'|'WARNING', line: int, msg: str}"""
    try:
        source = Path(filepath).read_text(encoding="utf-8")
    except OSError as e:
        return [{"level": "CRITICAL", "line": 0, "msg": f"Cannot read file: {e}"}]

    try:
        tree = ast.parse(source)
    except SyntaxError as e:
        return [{"level": "CRITICAL", "line": 0, "msg": f"Cannot parse file: {e}"}]

    findings = (
        _check_fee(tree) + _check_compute_signals(tree)
        + _check_txf_settlement_mask(tree) + _check_plot_series(tree)
        + _check_end(tree) + _check_spot_short(tree) + _check_exit_loop(tree)
    )
    return sorted(findings, key=lambda f: f["line"])


def _parse_for_runner(filepath: str):
    # The backtest runner (lib/runner.py) calls the single-check entry points
    # below on the file that is *executing* — it obviously parses, and the full
    # CLI already reports read/parse problems as CRITICAL, so return None here.
    try:
        return ast.parse(Path(filepath).read_text(encoding="utf-8"))
    except (OSError, SyntaxError, ValueError):
        return None


def txf_settlement_findings(filepath: str) -> list[dict]:
    """TAIFEX settlement-mask check only — the runner's blocking guard."""
    tree = _parse_for_runner(filepath)
    return _check_txf_settlement_mask(tree) if tree is not None else []


def plot_series_findings(filepath: str) -> list[dict]:
    """PLOT_SERIES check only — the runner's non-blocking backtest hint."""
    tree = _parse_for_runner(filepath)
    return _check_plot_series(tree) if tree is not None else []


def exit_loop_findings(filepath: str) -> list[dict]:
    """Hand-written exit loop check only — the runner's non-blocking backtest warning."""
    tree = _parse_for_runner(filepath)
    return _check_exit_loop(tree) if tree is not None else []


def end_pinned_findings(filepath: str) -> list[dict]:
    """Pinned-END check only — the runner's blocking backtest guard."""
    tree = _parse_for_runner(filepath)
    return _check_end(tree) if tree is not None else []


# ── Pinned END check ────────────────────────────────────────────────────────────

def _check_end(tree: ast.AST) -> list[dict]:
    # Module level only (tree.body, not ast.walk): a local END inside a helper
    # is not the config constant and must not trip the guard. Only the LAST
    # module-level assignment is judged — it is the value that takes effect.
    last = None  # (lineno, value node) of the last module-level END assignment
    for node in tree.body:
        if isinstance(node, ast.Assign):
            targets, value = node.targets, node.value
        elif isinstance(node, ast.AnnAssign) and node.value is not None:
            targets, value = [node.target], node.value
        else:
            continue
        for target in targets:
            names = target.elts if isinstance(target, ast.Tuple) else [target]
            for i, name in enumerate(names):
                if not (isinstance(name, ast.Name) and name.id == "END"):
                    continue
                v = value
                # `START, END = "2022-01-01", "2026-05-21"` — pick END's element;
                # a tuple target fed by a non-tuple (e.g. a call) keeps the whole
                # expression and fails the constant test below, as it should.
                if (isinstance(target, ast.Tuple) and isinstance(value, ast.Tuple)
                        and len(value.elts) == len(target.elts)):
                    v = value.elts[i]
                last = (node.lineno, v)
    if last is None:
        return []
    lineno, v = last
    if isinstance(v, ast.Constant) and v.value is None:
        return []
    # CRITICAL for a date and for any expression alike: nothing on the live
    # path (lib/runner.py, the schedulers) ever overrides END, so a pinned
    # date freezes a deployed strategy's signals at that date forever — and a
    # computed END can hide the same pin.
    return [_c(
        lineno,
        "END is not None — nothing on the live path overrides END, so a "
        "deployed strategy freezes its signals at that date forever. Set "
        "END = None; nearly every fetcher uses a monthly-delta cache, so "
        "backtests still only re-fetch the current month.",
    )]


# ── FEE=0 gaming check ──────────────────────────────────────────────────────────

def _check_fee(tree: ast.AST) -> list[dict]:
    findings = []
    for node in ast.walk(tree):
        # cover both `FEE = 0` (Assign) and `FEE: float = 0` (AnnAssign)
        if isinstance(node, ast.Assign):
            targets, value = node.targets, node.value
        elif isinstance(node, ast.AnnAssign) and node.value is not None:
            targets, value = [node.target], node.value
        else:
            continue

        for target in targets:
            if not (isinstance(target, ast.Name) and target.id == "FEE"):
                continue
            if (
                isinstance(value, ast.Constant)
                and isinstance(value.value, (int, float))
                and value.value == 0
            ):
                # WARNING, not CRITICAL — zero-fee venues exist and the user may
                # deliberately test without fee drag; surface it, don't block.
                findings.append(_w(
                    node.lineno,
                    "FEE=0 — backtest reports zero transaction cost, inflating "
                    "apparent Sharpe/return. Confirm the venue genuinely charges "
                    "none; otherwise use a realistic fee (e.g. 0.0005).",
                ))
            elif not isinstance(value, ast.Constant):
                # FEE = 0.0*1, FEE = X if Y else Z, … — can't statically verify;
                # an expression here is itself suspicious for a config constant
                findings.append(_w(
                    node.lineno,
                    "FEE is not a plain numeric constant — verify it evaluates to "
                    "a realistic nonzero fee (a computed FEE can hide FEE=0).",
                ))
    return findings


# ── compute_signals contract check ──────────────────────────────────────────────

def _check_compute_signals(tree: ast.AST) -> list[dict]:
    fn = next(
        (n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == "compute_signals"),
        None,
    )
    if fn is None:
        return [_c(0, "compute_signals() not found — Type A/C strategies must define it "
                      "(see TEMPLATE_A.py / TEMPLATE_C.py)")]

    returns = [n for n in ast.walk(fn) if isinstance(n, ast.Return)]
    if not returns or all(r.value is None for r in returns):
        return [_c(fn.lineno, "compute_signals() has no return value — must return a pd.Series "
                              "(or a (pd.Series, exec_at_close) tuple, see references/strategy-code.md)")]

    # Unfilled-template heuristic: real signal logic virtually always contains a
    # comparison (threshold, crossover, rank filter) or a stateful loop somewhere
    # in the strategy's functions. The TEMPLATE stubs have neither (commented-out
    # logic / NotImplementedError). Checked across all function bodies — not just
    # compute_signals, because Type A/C conventionally split logic into helpers
    # (_add_indicators, _compute_weights) — but NOT at module level, where the
    # boilerplate `if __name__ == '__main__'` is itself a Compare node. WARNING
    # only — a strategy whose comparisons all live in numpy calls could trip this.
    # `if MARKET == "spot": signal = signal.clip(lower=0.0)` ships in TEMPLATE_A — not signal logic.
    has_logic = any(
        (isinstance(n, ast.Compare) and not (isinstance(n.left, ast.Name) and n.left.id == "MARKET"))
        or isinstance(n, (ast.For, ast.While))
        for f in ast.walk(tree) if isinstance(f, ast.FunctionDef)
        for n in ast.walk(f)
    )
    if not has_logic:
        return [_w(fn.lineno, "no comparison or loop found anywhere in the file — looks like "
                              "the TEMPLATE stub logic was left unfilled")]

    # TEMPLATE_C's stub helpers are explicit: `raise NotImplementedError`. Any
    # reachable one left in a strategy file means an unfilled template section
    # (the shipped _rebalance_mask helper is real logic, so the Compare
    # heuristic above alone can't see this).
    findings = []
    for n in ast.walk(tree):
        if isinstance(n, ast.Raise) and n.exc is not None:
            exc = n.exc.func if isinstance(n.exc, ast.Call) else n.exc
            if isinstance(exc, ast.Name) and exc.id == "NotImplementedError":
                findings.append(_w(n.lineno, "raise NotImplementedError — a TEMPLATE stub "
                                             "section was left unfilled"))
    return findings


# ── TAIFEX settlement-mask check ────────────────────────────────────────────────

# Only the R1 continuous-series fetchers — the ones whose roll gap fabricates
# PnL. Auxiliary TAIFEX feeds (pcr, bid_ask_vol) and the per-contract-month
# fetch_stock_futures_batch_daily deliberately do NOT trigger: a strategy may
# use them as indicators while trading a non-TAIFEX symbol.
_TWFUTURES_PRICE_FETCHERS = {
    "fetch_twfutures_ohlcv",
    "fetch_twfutures_ohlcv_batch",
}
_TAIFEX_INDEX_SYMBOLS = {"TXF", "MXF", "TMF"}

_MASK_FIX = (
    "Fix in compute_signals: `settle = txf_settlement_mask(df.index); "
    "signal[settle] = 0.0; return signal, settle` (Type C: `weights.loc[settle] = 0.0` "
    "and return settle as exec_at_close). See references/lib.md › txf_settlement_mask "
    "and strategies/txf_composite_60m/strategy.py for a real example."
)


def _call_name(node: ast.Call):
    if isinstance(node.func, ast.Name):
        return node.func.id
    if isinstance(node.func, ast.Attribute):
        return node.func.attr
    return None


def _check_txf_settlement_mask(tree: ast.AST) -> list[dict]:
    # A strategy is treated as TAIFEX if it fetches a TAIFEX price series, or —
    # covering fetches hidden behind a helper module — declares SYMBOL as an
    # index-futures contract. Stock futures (e.g. 'CDF') can't be enumerated
    # statically, but they necessarily fetch via fetch_twfutures_* so the call
    # trigger covers them.
    trigger = None
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and _call_name(node) in _TWFUTURES_PRICE_FETCHERS:
            trigger = (node.lineno, f"calls {_call_name(node)}()")
            break
    if trigger is None:
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign):
                targets, value = node.targets, node.value
            elif isinstance(node, ast.AnnAssign) and node.value is not None:
                targets, value = [node.target], node.value
            else:
                continue
            if (
                any(isinstance(t, ast.Name) and t.id == "SYMBOL" for t in targets)
                and isinstance(value, ast.Constant)
                and value.value in _TAIFEX_INDEX_SYMBOLS
            ):
                trigger = (node.lineno, f"SYMBOL = '{value.value}'")
                break
    if trigger is None:
        return []

    mask_calls = [
        n for n in ast.walk(tree)
        if isinstance(n, ast.Call) and _call_name(n) == "txf_settlement_mask"
    ]
    if not mask_calls:
        return [_c(
            trigger[0],
            f"TAIFEX futures strategy ({trigger[1]}) without txf_settlement_mask — "
            "the data is an unadjusted continuous series; every monthly roll books "
            "the contract-basis gap as fake PnL (~+4%/yr × gross exposure) and the "
            "backtest omits real roll fees. " + _MASK_FIX,
        )]

    # Cargo-cult guard: calling the mask but throwing the result away. Only the
    # bare-expression-statement form is detectable statically; assigning the mask
    # without actually zeroing the signal with it passes this check.
    discarded = {
        id(s.value) for s in ast.walk(tree)
        if isinstance(s, ast.Expr) and isinstance(s.value, ast.Call)
    }
    if all(id(c) in discarded for c in mask_calls):
        return [_c(
            mask_calls[0].lineno,
            "txf_settlement_mask() is called but its result is discarded — the "
            "mask must zero the signal and be returned as exec_at_close. " + _MASK_FIX,
        )]
    return []


# ── PLOT_SERIES declaration check (Type A) ──────────────────────────────────────

# Fetchers that return the traded instrument's own price/OHLCV (or pure metadata):
# calling one says nothing about indicators. Any OTHER lib.data fetch_* call
# (alpha feeds, twstock institutional / broker / PER, TAIFEX pcr, a spot index
# used for basis …) pulls an exogenous series the signal is almost certainly
# built on — that is the "external indicator" case the rule targets.
_PRICE_OR_META_FETCHERS = {
    "fetch_data",  # the strategy's own entry point
    "fetch_kline", "fetch_kline_batch", "fetch_bingx_kline", "fetch_db_kline",
    "fetch_twstock_price", "fetch_twstock_price_adj",
    "fetch_twstock_price_batch", "fetch_twstock_price_adj_batch",
    "fetch_twstock_ohlcv", "fetch_twstock_quote", "fetch_twstock_quote_batch",
    "fetch_twfutures_ohlcv", "fetch_twfutures_ohlcv_batch",
    "fetch_stock_futures_batch_daily",
    "fetch_twstock_ohlcv_symbols", "fetch_stock_futures_ohlcv_symbols",
    "fetch_twstock_list", "fetch_twstock_info", "fetch_economic_calendar",
}
# Window computations — the self-computed indicator case. shift/diff/pct_change
# deliberately do NOT count: "Close above yesterday's Close" is a pure price rule.
_INDICATOR_METHODS = {"rolling", "ewm"}

_PLOT_SERIES_FIX = (
    "Declare the 1–2 df columns that explain the entries/exits in the config "
    "section — e.g. PLOT_SERIES = {\"Taker Intensity 24h\": \"TI\"} (oscillator, "
    "sub-pane) or {\"SMA fast\": (\"SMA_F\", {\"overlay\": True})} (price units, "
    "overlay); the column must exist in the df fetch_data returns. See AGENTS.md › "
    "Backtest Output, references/plot-series.md, examples/btc_ti_5min/strategy.py."
)


def _assigns(tree: ast.AST, name: str) -> bool:
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            targets = node.targets
        elif isinstance(node, ast.AnnAssign) and node.value is not None:
            targets = [node.target]
        else:
            continue
        if any(isinstance(t, ast.Name) and t.id == name for t in targets):
            return True
    return False


def _check_plot_series(tree: ast.AST) -> list[dict]:
    # Type A = single-symbol config. Type C files declare UNIVERSE instead of
    # SYMBOL and have no single trade chart to overlay, so they are skipped.
    if not _assigns(tree, "SYMBOL") or _assigns(tree, "UNIVERSE"):
        return []
    if _assigns(tree, "PLOT_SERIES"):
        return []

    trigger = next(
        ((n.lineno, "defines _add_indicators()") for n in ast.walk(tree)
         if isinstance(n, ast.FunctionDef) and n.name == "_add_indicators"),
        None,
    )
    if trigger is None:
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            name = _call_name(node)
            if name in _INDICATOR_METHODS or (
                name and name.startswith("fetch_") and name not in _PRICE_OR_META_FETCHERS
            ):
                trigger = (node.lineno, f"calls {name}()")
                break
    if trigger is None:
        return []  # pure price rule — PLOT_SERIES is optional

    return [_w(
        trigger[0],
        f"indicator-driven Type A strategy ({trigger[1]}) without PLOT_SERIES — "
        "the web workspace chart gets no indicator pane, so the user cannot see "
        "why it traded. " + _PLOT_SERIES_FIX,
    )]


# ── Hand-written exit loop check ────────────────────────────────────────────────

# Name tokens (split on "_" and case): a stop/target level vs an entry price. Token-exact so
# `slow` / `stopped_at_bar` style words are not read as `sl` / `stop` by accident.
_STOP_TOKENS = {"sl", "tp", "tsl", "stop", "stoploss", "takeprofit", "take", "target", "profit",
                "trail", "trailing", "limit"}
_ENTRY_NAMES = {"ep", "avg_price", "avg_cost", "buy_price", "fill_price", "cost_basis", "cost_price",
                "open_price", "entry"}


def _tokens(name: str) -> list[str]:
    import re
    return [t.lower() for t in re.findall(r"[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+", name)]


def _is_stop_name(name: str) -> bool:
    return any(t in _STOP_TOKENS for t in _tokens(name))


def _is_entry_name(name: str) -> bool:
    return name.lower() in _ENTRY_NAMES or "entry" in _tokens(name)


def _names(node) -> set:
    return {n.id for n in ast.walk(node) if isinstance(n, ast.Name)}


def _check_exit_loop(tree: ast.AST) -> list[dict]:
    # A per-bar loop that assigns an entry price and compares it (or a level derived from it)
    # against a stop / target — the shape of the 2026-09-23 no-op stop and the 29026
    # e2e_exit_test SL/TP loop. lib.exits.apply_exits does this with invalid-bar, roll and
    # no-same-bar-re-entry handling; any apply_exits call in the file clears the check.
    # WARNING only: a hand-written loop can be correct, it just is not the sanctioned path.
    if any(isinstance(n, ast.Call) and _call_name(n) == "apply_exits" for n in ast.walk(tree)):
        return []
    for loop in ast.walk(tree):
        if not isinstance(loop, (ast.For, ast.While)):
            continue
        assigns = [n for n in ast.walk(loop) if isinstance(n, (ast.Assign, ast.AugAssign, ast.AnnAssign))]

        def targets(a):
            ts = a.targets if isinstance(a, ast.Assign) else [a.target]
            return {n.id for t in ts for n in ast.walk(t) if isinstance(n, ast.Name)}

        entry = {name for a in assigns for name in targets(a) if _is_entry_name(name)}
        if not entry:
            continue
        tainted, stopish = set(entry), set()
        changed = True
        while changed:
            changed = False
            for a in assigns:
                if a.value is None or not (_names(a.value) & tainted):
                    continue
                for name in targets(a) - tainted:
                    tainted.add(name)
                    changed = True
                    if _is_stop_name(name) or any(_is_stop_name(x) for x in _names(a.value)):
                        stopish.add(name)
        for cmp in (n for n in ast.walk(loop) if isinstance(n, ast.Compare)):
            used = _names(cmp)
            if not (used & tainted):
                continue
            if used & stopish or any(_is_stop_name(x) for x in used):
                return [_w(cmp.lineno,
                           "hand-written exit loop — tracks an entry price ("
                           + ", ".join(sorted(entry)) + ") and compares it to a stop / target "
                           "level. Use lib.exits.apply_exits(signal, df, stop_pct=..., tp_pct=..., "
                           "trail_pct=..., max_bars=..., trigger=\"intrabar\" or \"close\"); it handles "
                           "High/Low touches, gaps, invalid bars, rolls and no same-bar re-entry. If the "
                           "rule is one it cannot model, tell the user that instead of hand-rolling a "
                           "loop (references/strategy-code.md › Exits on top of an existing signal).")]
    return []


# ── Spot short check ────────────────────────────────────────────────────────────

def _module_str(tree: ast.AST, name: str):
    # value of the LAST module-level `NAME = "<str>"`, else None
    val = None
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in node.targets):
            val = node.value.value if isinstance(node.value, ast.Constant) and isinstance(node.value.value, str) else None
    return val


def _negative_const(node) -> bool:
    return (isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub)
            and isinstance(node.operand, ast.Constant) and isinstance(node.operand.value, (int, float))
            and node.operand.value > 0)


def _check_spot_short(tree: ast.AST) -> list[dict]:
    # Type A only (Type C weights are checked elsewhere). The backtest runner clamps a spot
    # strategy's shorts to flat (lib/exits.clamp_spot), but param_scan / walk_forward call
    # compute_signals directly and would still score short profits — so the file itself must
    # be long-only. Triggers: `x[...] = -<n>` or threshold_position with a reachable short
    # side; `.clip(lower=0...)` / clamp_spot anywhere in the file clears it.
    if _module_str(tree, "MARKET") != "spot" or not _assigns(tree, "SYMBOL") or _assigns(tree, "UNIVERSE"):
        return []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            if _call_name(node) == "clamp_spot":
                return []
            if _call_name(node) == "clip" and any(
                    k.arg == "lower" and isinstance(k.value, ast.Constant) and k.value.value == 0
                    for k in node.keywords):
                return []
    for node in ast.walk(tree):
        if (isinstance(node, ast.Assign) and _negative_const(node.value)
                and any(isinstance(t, ast.Subscript) for t in node.targets)):
            return [_w(node.lineno, "MARKET is spot but compute_signals sets a short (negative) "
                                    "signal — spot cannot short. " + _SPOT_FIX)]
        if isinstance(node, ast.Call) and _call_name(node) == "threshold_position":
            short = node.args[4] if len(node.args) > 4 else next(
                (k.value for k in node.keywords if k.arg == "short_th"), None)
            off = (_negative_const(short) and short.operand.value >= 1e8)
            if not off:
                return [_w(node.lineno, "MARKET is spot but threshold_position has a reachable short "
                                        "side — spot cannot short. " + _SPOT_FIX)]
    return []


_SPOT_FIX = ("The backtest clamps it to flat, same as live, but scans and walk-forward "
             "call compute_signals directly and still score it: end compute_signals with "
             "`signal = signal.clip(lower=0.0)` (or pass short_th=-1e9).")


# ── Helpers ───────────────────────────────────────────────────────────────────

def _c(line: int, msg: str) -> dict:
    return {"level": "CRITICAL", "line": line, "msg": msg}

def _w(line: int, msg: str) -> dict:
    return {"level": "WARNING", "line": line, "msg": msg}


# ── CLI ───────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    if len(sys.argv) < 2:
        # exit 2, not 0 — a missing argument must never read as a passing scan
        print("Usage: python3 lib/quality_check.py <strategy_file.py>")
        sys.exit(2)

    results = check(sys.argv[1])

    if not results:
        print("✅ No issues found.")
        sys.exit(0)

    criticals = [r for r in results if r["level"] == "CRITICAL"]
    warnings  = [r for r in results if r["level"] == "WARNING"]

    print(f"{'❌' if criticals else '⚠️ '} {len(results)} issue(s) found in {sys.argv[1]}:\n")
    for r in results:
        icon = "❌" if r["level"] == "CRITICAL" else "⚠️ "
        print(f"  {icon} Line {r['line']}: {r['msg']}")

    print()
    if criticals:
        print("❌ CRITICAL issues — do NOT run/submit this strategy without fixing them.")
        sys.exit(2)
    else:
        print("⚠️  Warnings only — confirm with user before running/submitting.")
        sys.exit(1)
