"""
Static quality analysis for Type A / Type C strategy files — catches a broken or
unfilled compute_signals() contract, backtest fee-drag gaming (FEE=0), a
TAIFEX futures strategy missing the mandatory txf_settlement_mask, an
indicator-driven Type A strategy without a PLOT_SERIES declaration, and a
pinned END date (which freezes a deployed strategy's signals forever), before a
strategy is submitted to the marketplace or run after being purchased.

Usage:
    python3 lib/quality_check.py [--context install|fork|edit] strategies/xyz.py

First output line (the verdict to act on): RESULT: clean | run-as-is | do-not-run
With --context, the second line is `NEXT: <what to do now>` for that situation:
    install — a library / shared strategy installed as is
    fork    — an existing strategy taken as the base of the user's own
    edit    — a strategy the agent wrote or is changing (also before a marketplace submission)
--context goes before the file: an older checker then reads it as the path and says do-not-run.
Exit codes (fallback only — PowerShell on Windows folds 1 and 2 into 1):
    0 — clean
    1 — warnings only (review before running/submitting)
    2 — critical issues, file unreadable, no file argument, or the scan itself failed (do NOT run/submit)
"""

import ast
import sys
from pathlib import Path


def check(filepath: str) -> list[dict]:
    """Return list of findings: {level: 'CRITICAL'|'WARNING', line: int, msg: str, check: id}"""
    try:
        source = Path(filepath).read_text(encoding="utf-8-sig")   # a Windows editor's BOM is not a syntax error
    except (OSError, UnicodeDecodeError) as e:
        return [{"level": "CRITICAL", "line": 0, "msg": f"Cannot read file: {e}", "check": "read"}]

    try:
        tree = ast.parse(source)
    except (SyntaxError, ValueError) as e:
        return [{"level": "CRITICAL", "line": 0, "msg": f"Cannot parse file: {e}", "check": "read"}]

    findings = []
    for check_id, fn in _CHECKS:
        for f in fn(tree):
            # _check_compute_signals reports a broken contract (CRITICAL) and an unfilled
            # template (WARNING); they are acted on differently, so they get separate ids.
            f["check"] = "template" if check_id == "compute_signals" and f["level"] == "WARNING" else check_id
            findings.append(f)
    return sorted(findings, key=lambda f: f["line"])


def _parse_for_runner(filepath: str):
    # The backtest runner (lib/runner.py) calls the single-check entry points
    # below on the file that is *executing* — it obviously parses, and the full
    # CLI already reports read/parse problems as CRITICAL, so return None here.
    try:
        return ast.parse(Path(filepath).read_text(encoding="utf-8-sig"))
    except (OSError, SyntaxError, ValueError):
        return None


def txf_settlement_findings(filepath: str) -> list[dict]:
    """TAIFEX settlement-mask check only — the runner's blocking guard."""
    tree = _parse_for_runner(filepath)
    return _check_txf_settlement_mask(tree) if tree is not None else []


def plot_series_findings(filepath: str) -> list[dict]:
    """PLOT_SERIES check only — the runner's non-blocking backtest hint."""
    tree = _parse_for_runner(filepath)
    found = _check_plot_series(tree) if tree is not None else []
    # The CLI message keeps its old wording (output without --context is frozen); the runner
    # prints this one after every backtest, where an own strategy's missing line is a question.
    return [dict(f, msg=f["msg"][:f["msg"].index(" — ") + 3] + _PLOT_SERIES_RUNNER_HINT) for f in found]


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

# lib helpers that turn an indicator into a position by themselves (lib/strategy.py) — a
# strategy built on one has no comparison of its own. A closed list on purpose: the helpers
# that only reshape an existing signal (apply_exits, apply_vol_scaling, clamp_spot,
# settlement_signals_from_db) return flat for an unfilled template's all-NaN signal, so
# calling them proves nothing. tests/check_quality_template_helpers.py enumerates
# lib/strategy.py and lib/exits.py, so a new helper there has to be put on one side.
_SIGNAL_HELPERS = {"threshold_position", "hysteresis"}


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
    # A call to a _SIGNAL_HELPERS function is signal logic too: the comparison is inside lib.
    has_logic = any(
        (isinstance(n, ast.Compare) and not (isinstance(n.left, ast.Name) and n.left.id == "MARKET"))
        or isinstance(n, (ast.For, ast.While))
        or (isinstance(n, ast.Call) and _call_name(n) in _SIGNAL_HELPERS)
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
    "fetch_twstock_ohlcv", "fetch_twstock_quote", "fetch_twstock_quote_batch", "fetch_usstock_price",
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


_PLOT_SERIES_RUNNER_HINT = (
    "the backtest tab's trade chart gets no indicator line. A library strategy installed as is, or "
    "a fresh fork's baseline: leave it and say so in one sentence. A strategy you wrote or are "
    "editing: ask the user whether to add PLOT_SERIES (references/plot-series.md)."
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
        "the backtest tab's trade chart gets no indicator line, so the user cannot see "
        "why it traded. Downloaded library strategy installed as is, or the baseline run of a "
        "fresh fork: do not edit it — run it unchanged and tell the user the chart will have no "
        "indicator line (references/marketplace.md, step 7 of the install flow / step 5 of the "
        "fork flow). A strategy you wrote or are editing: "
        + _PLOT_SERIES_FIX,
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


# ── Blave data need on the desktop (strategy-library listing) ──────────────────

# Every public top-level name in lib/data.py sits in exactly one of these three
# sets — tests/check_blave_data_need.py enumerates data.py and goes red on a new
# or moved one. "Public" = never calls api.blave.org on the desktop build:
# fetch_kline(_batch) go to Binance there (BLAVE_KLINE_SOURCE=binance). The
# single-ticker Taiwan daily pair is NOT public: when the exchanges / FinMind
# fail it falls back to Blave, which stops a keyless desktop.
_DESKTOP_PUBLIC_DATA = frozenset({
    "fetch_kline", "fetch_kline_batch", "fetch_bingx_kline", "fetch_usstock_price",
    "fetch_fear_greed", "fetch_binance_ticker_24h",
    "fetch_tw_announcements_public", "fetch_twfutures_institutional_public",
    "fetch_txf_daily_public", "fetch_twmarket_index_public", "fetch_twmarket_institutional_public",
    "fetch_twmarket_margin_public", "fetch_twmarket_turnover_public",
    "fetch_twse_day_all_public", "tw_market_public_allowed",
    "align_feed", "feed_available_at", "join_tw_flow", "normalize_symbol",
    "settlement_signals_from_db", "twstock_industry_name", "txf_settlement_mask",
})
_BLAVE_DATA = frozenset({
    "fetch_capital_shortage", "fetch_cvd_coin", "fetch_cvd_table", "fetch_db_kline",
    "fetch_economic_calendar", "fetch_funding_rate", "fetch_holder_concentration",
    "fetch_liquidation", "fetch_liquidation_coin", "fetch_liquidation_exchanges",
    "fetch_liquidation_map", "fetch_long_short_ratio_coin", "fetch_long_short_ratio_table",
    "fetch_market_direction", "fetch_market_sentiment", "fetch_news",
    "fetch_open_interest_coin", "fetch_open_interest_history", "fetch_open_interest_table",
    "fetch_squeeze_momentum",
    "fetch_stock_futures_batch_daily", "fetch_stock_futures_ohlcv_symbols",
    "fetch_taker_intensity", "fetch_top_trader_exposure", "fetch_unusual_movement",
    "fetch_whale_hunter",
    "fetch_twfutures_bid_ask_vol", "fetch_twfutures_institutional", "fetch_twfutures_ohlcv",
    "fetch_twfutures_ohlcv_batch", "fetch_twfutures_pcr",
    "fetch_twmarket_dividend_points", "fetch_twmarket_index", "fetch_twmarket_institutional",
    "fetch_twmarket_margin", "fetch_twmarket_turnover",
    "fetch_twstock_all_broker_net", "fetch_twstock_balance_sheet",
    "fetch_twstock_balance_sheet_batch", "fetch_twstock_branch_daily_net",
    "fetch_twstock_broker_net", "fetch_twstock_dividend", "fetch_twstock_dividend_batch",
    "fetch_twstock_financials", "fetch_twstock_financials_batch",
    "fetch_twstock_foreign_shareholding_batch", "fetch_twstock_holidays", "fetch_twstock_info",
    "fetch_twstock_institutional", "fetch_twstock_institutional_batch", "fetch_twstock_list",
    "fetch_twstock_market_value_all", "fetch_twstock_monthly_revenue",
    "fetch_twstock_monthly_revenue_batch", "fetch_twstock_ohlcv", "fetch_twstock_ohlcv_symbols",
    "fetch_twstock_per", "fetch_twstock_per_batch", "fetch_twstock_price", "fetch_twstock_price_adj",
    "fetch_twstock_price_adj_batch",
    "fetch_twstock_price_batch", "fetch_twstock_quote", "fetch_twstock_quote_batch",
    "fetch_twstock_shareholding", "fetch_twstock_shareholding_batch",
    "fetch_twstock_trader_flows", "is_tw_trading_day",
})
# Classes and constants that carry no fetch. BASE is deliberately absent: a
# strategy that takes it builds its own Blave URL.
_DATA_INERT = frozenset({
    "DataAccessError", "BatchIncomplete", "UnknownFetcher", "TwPublicUnavailable", "UsStockUnavailable",
    "UsStockNotHere", "UsStockNotFound", "FeedNotPublished", "closed_bars_only", "live_feeds",
    "FEED_TIMING", "TW_FLOWS", "TWSE_INDUSTRY_NAMES", "PUBLIC_SOURCE_EN",
})
# Shipped lib modules that call Blave fetchers themselves (the report builders).
# The test lists every lib module that reaches lib.data's Blave names.
_LIB_REACHING_BLAVE = frozenset({"report_bricks", "report_templates"})
_DYNAMIC_IMPORTS = {"__import__", "import_module", "exec", "eval"}


def blave_data_need(source: str):
    """Does this strategy code need the Blave data key on the desktop? True / False, or None
    when it can't be told statically. Stored per listing at publish time
    (api scripts/marketplace_admin.py); the desktop treats None like True.

    True wins over None: one certain Blave call settles it. None covers what a static read
    can't follow — any lib.data name outside the three sets (BASE, private helpers, a fetcher
    this checkout doesn't know), `import *`, the lib.data module passed around as a value or
    read by a computed name, dynamic imports / exec / vars(), the report builders, relative
    or custom `lib.*` modules (helper code). A wrong False only costs a failed backtest: the
    data gate itself is lib/data.py plus the api."""
    try:
        return _blave_data_need(source)
    except Exception:
        # Deeply nested code makes ast.parse raise MemoryError / RecursionError (api runs this on
        # untrusted community code): can't tell, and one listing must not stop a whole publish.
        return None


def _blave_data_need(source: str):
    try:
        tree = ast.parse(source)
    except (SyntaxError, ValueError):
        return None
    known = _DESKTOP_PUBLIC_DATA | _BLAVE_DATA | _DATA_INERT
    shipped = {p.stem for p in Path(__file__).parent.iterdir()
               if p.suffix == ".py" or (p.is_dir() and not p.name.startswith(("_", ".")))}
    bare_strings = {id(n.value) for n in ast.walk(tree) if isinstance(n, ast.Expr)}
    data_aliases = set()
    for n in ast.walk(tree):
        if isinstance(n, ast.ImportFrom) and n.module == "lib" and not n.level:
            data_aliases |= {a.asname or "data" for a in n.names if a.name == "data"}
        elif isinstance(n, ast.Import):
            data_aliases |= {a.asname for a in n.names if a.name == "lib.data" and a.asname}

    def is_data(node):
        return (isinstance(node, ast.Name) and node.id in data_aliases
                or isinstance(node, ast.Attribute) and node.attr == "data"
                and isinstance(node.value, ast.Name) and node.value.id == "lib")

    # every place the lib.data module object may appear legitimately: as the base of `.name`,
    # or as getattr's first argument with a constant name
    allowed = set()
    for n in ast.walk(tree):
        if isinstance(n, ast.Attribute) and is_data(n.value):
            allowed.add(id(n.value))
            if isinstance(n.value, ast.Attribute):
                allowed.add(id(n.value.value))
        elif (isinstance(n, ast.Call) and _call_name(n) == "getattr" and len(n.args) >= 2
              and is_data(n.args[0]) and isinstance(n.args[1], ast.Constant)):
            allowed.add(id(n.args[0]))

    used, unknown = set(), False   # used = names taken from lib.data, however they were reached
    for n in ast.walk(tree):
        if (isinstance(n, ast.Name) and n.id in data_aliases or is_data(n)) and id(n) not in allowed:
            unknown = True   # the module handed around as a value (D = data, f(data), vars(data))
        if isinstance(n, ast.ImportFrom):
            mod = n.module or ""
            if n.level or mod.split(".")[0] == "strategies":
                unknown = True
            elif mod == "lib.data":
                used |= {a.name for a in n.names}
                unknown |= any(a.name not in known for a in n.names)
            elif mod == "lib":
                unknown |= any(a.name not in shipped or a.name in _LIB_REACHING_BLAVE for a in n.names)
            elif mod.startswith("lib.") and (mod.split(".")[1] not in shipped
                                             or mod.split(".")[1] in _LIB_REACHING_BLAVE):
                unknown = True
        elif isinstance(n, ast.Import):
            for a in n.names:
                parts = a.name.split(".")
                if parts[0] == "strategies" or parts[0] == "lib" and len(parts) > 1 and (
                        parts[1] not in shipped or parts[1] in _LIB_REACHING_BLAVE):
                    unknown = True
        elif isinstance(n, ast.Attribute) and is_data(n.value):
            used.add(n.attr)
            unknown |= n.attr not in known
        elif isinstance(n, ast.Constant) and isinstance(n.value, str) and id(n) not in bare_strings:
            if "api.blave.org" in n.value:   # a direct HTTP call past lib/data.py
                return True
        if isinstance(n, ast.Call):
            name = _call_name(n)
            if name in _DYNAMIC_IMPORTS:
                unknown = True
            elif name == "getattr" and len(n.args) >= 2 and is_data(n.args[0]):
                attr = n.args[1]
                if isinstance(attr, ast.Constant) and isinstance(attr.value, str):
                    used.add(attr.value)
                    unknown |= attr.value not in known
                else:
                    unknown = True

    if used & _BLAVE_DATA:
        return True
    return None if unknown else False


# ── Helpers ───────────────────────────────────────────────────────────────────

def _c(line: int, msg: str) -> dict:
    return {"level": "CRITICAL", "line": line, "msg": msg}

def _w(line: int, msg: str) -> dict:
    return {"level": "WARNING", "line": line, "msg": msg}


# ── Check registry and the NEXT line ────────────────────────────────────────────

# The order is the old concatenation order; findings are sorted by line afterwards.
_CHECKS = (
    ("fee", _check_fee),
    ("compute_signals", _check_compute_signals),
    ("txf_mask", _check_txf_settlement_mask),
    ("plot_series", _check_plot_series),
    ("end", _check_end),
    ("spot_short", _check_spot_short),
    ("exit_loop", _check_exit_loop),
)
# Every id a finding can carry, with its level. tests/check_scan_context.py enumerates it.
CHECK_LEVELS = {
    "read": "CRITICAL", "compute_signals": "CRITICAL", "txf_mask": "CRITICAL", "end": "CRITICAL",
    "template": "WARNING", "fee": "WARNING", "plot_series": "WARNING", "spot_short": "WARNING",
    "exit_loop": "WARNING",
}
CONTEXTS = ("install", "fork", "edit")
# WARNINGs that refuse the file in these contexts: an unfinished template is not installed or forked.
BLOCKS_IN = {"template": ("install", "fork")}

# install / fork run a WARNING-only file unchanged (references/marketplace.md); the reply then
# says what the user will see, one plain sentence per warning.
USER_EFFECT = {
    "fee": "the backtest counts no trading fee, so the returns look better than they would be",
    "plot_series": "the backtest chart has no indicator line",
    "spot_short": "its short signals stay flat because spot cannot short",
    "exit_loop": "its stop / target exits are custom code rather than the standard exit helper",
}
# edit: the user decides whether a warning gets fixed; this is what fixing it would mean.
EDIT_FIX = {
    "template": "fill in the unfinished template logic",
    "fee": "use the venue's real fee",
    "plot_series": "declare PLOT_SERIES",
    "spot_short": "make compute_signals long-only",
    "exit_loop": "use lib.exits.apply_exits",
}


def blocks(context, finding: dict) -> bool:
    return finding["level"] == "CRITICAL" or context in BLOCKS_IN.get(finding["check"], ())


def verdict(context, findings: list) -> str:
    if any(blocks(context, f) for f in findings):
        return "do-not-run"
    return "run-as-is" if findings else "clean"


def next_line(context: str, findings: list) -> str:
    blocked = any(blocks(context, f) for f in findings)
    warns = list(dict.fromkeys(f["check"] for f in findings if f["level"] == "WARNING"))
    if context == "install":
        if blocked:
            return ("NEXT: Stop — do not install it: delete this file (in a bundle, only this file) and "
                    "tell the user in one plain sentence why it was not installed.")
        if warns:
            return ("NEXT: Go on with the install flow in references/marketplace.md — the steps after its "
                    "quality scan (move, then run as that flow says) — and run it unchanged — do not edit the code and do not ask about these warnings; after the run "
                    "tell the user, one plain sentence each: " + "; ".join(USER_EFFECT[w] for w in warns) + ".")
        return ("NEXT: Go on with the install flow in references/marketplace.md — the steps after its "
                "quality scan (move, then run as that flow says).")
    if context == "fork":
        if blocked:
            return "NEXT: Stop — create no fork: delete this file and tell the user in one plain sentence why."
        if warns:
            return ("NEXT: Go on with the fork flow (references/marketplace.md, steps 4–5) and run the "
                    "baseline unchanged — do not fix these warnings or ask about them now (fix only if the "
                    "user asks for changes); in the report tell the user, one plain sentence each: "
                    + "; ".join(USER_EFFECT[w] for w in warns) + ".")
        return "NEXT: Go on with the fork flow (references/marketplace.md, steps 4–5)."
    if blocked:
        return "NEXT: Do not backtest or submit it — fix every critical finding above, then run this check again."
    if warns:
        return ("NEXT: Before the backtest or a submission, tell the user each warning in plain words and ask "
                "whether to fix it (" + "; ".join(EDIT_FIX[w] for w in warns) + "); if the user accepts it "
                "as it is, go on without fixing it or running this check again.")
    return "NEXT: Go on — backtest or submit it."


def parse_args(argv: list):
    """(file or None, context or None); ValueError on a bad, missing or repeated --context and on
    more than one file — a second file would otherwise go unscanned behind the first one's verdict."""
    path, context, i = None, None, 0
    while i < len(argv):
        a = argv[i]
        if a == "--context" or a.startswith("--context="):
            if context is not None:
                raise ValueError("--context given more than once")
            if a == "--context":
                i += 1
                value = argv[i] if i < len(argv) else ""
            else:
                value = a.split("=", 1)[1]
            if value not in CONTEXTS:
                raise ValueError(f"--context must be one of {', '.join(CONTEXTS)} (got {value!r})")
            context = value
        elif path is None:
            path = a
        else:
            raise ValueError("scan one file at a time")
        i += 1
    return path, context


# ── CLI ───────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    # The verdict line comes first. On Windows a run wrapped in `powershell -Command` (Codex)
    # comes back as exit 1 for both 1 and 2, so the exit code is only a fallback — and a crash
    # must never surface as a bare exit 1 (read as "run-as-is"): any unexpected error is do-not-run.
    _verdict_out = False
    _context = None

    def _verdict(v, nxt=None):
        global _verdict_out
        print("RESULT: " + v + ("\n" + nxt if nxt else ""), flush=True)
        _verdict_out = True

    def _main() -> int:
        global _context
        try:
            sys.stdout.reconfigure(errors="replace")
        except Exception as e:
            print(f"Error: {e}", file=sys.stderr)
        try:
            path, _context = parse_args(sys.argv[1:])
        except ValueError as e:
            _verdict("do-not-run")
            print(f"Error: {e}")
            return 2
        if path is None:
            _verdict("do-not-run")
            print("Usage: python3 lib/quality_check.py <strategy_file.py>")
            return 2

        results = check(path)
        criticals = [r for r in results if r["level"] == "CRITICAL"]
        v = verdict(_context, results)
        _verdict(v, next_line(_context, results) if _context else None)

        if not results:
            print("✅ No issues found.")
            return 0

        print(f"{'❌' if criticals else '⚠️ '} {len(results)} issue(s) found in {path}:\n")
        for r in results:
            icon = "❌" if r["level"] == "CRITICAL" else "⚠️ "
            print(f"  {icon} Line {r['line']}: {r['msg']}")

        if _context:   # the NEXT line already said what to do
            return 2 if v == "do-not-run" else 1
        print()
        if criticals:
            print("❌ CRITICAL issues — do NOT run/submit this strategy without fixing them.")
            return 2
        print("⚠️  Warnings only. Downloaded library strategy installed as is, or the baseline "
              "run of a fresh fork: run it unchanged and mention each warning in the reply "
              "(references/marketplace.md, step 7 of the install flow / step 5 of the fork flow). "
              "Otherwise confirm with user before running/submitting.")
        return 1

    try:
        _code = _main()
    except Exception as e:
        if not _verdict_out:
            _verdict("do-not-run", next_line(_context, [{"level": "CRITICAL", "check": "read"}])
                     if _context else None)
        print(f"Error: {type(e).__name__}: {e}", file=sys.stderr)
        _code = 2
    sys.exit(_code)
