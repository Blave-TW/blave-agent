"""Minimal check: a guessed alpha-fetcher name on lib.data fails with the list of real
fetchers + signatures + the lib.md section, on both the `from lib.data import x` path and
plain attribute access — instead of the bare `cannot import name` that sent the agent
through dir()/inspect/grep (2026-09-24 e2e, 7–8 steps per round). No network.

Run: cd blave-agent && MPLBACKEND=Agg .venv/bin/python tests/check_unknown_fetcher_hint.py
"""
import os
import sys
import inspect

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("MPLBACKEND", "Agg")

import lib.data as D

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


def hint_of(fn):
    try:
        fn()
    except ImportError as e:
        return e
    return None


def _import_guess():
    from lib.data import fetch_alpha  # noqa: F401


e = hint_of(_import_guess)
check(isinstance(e, D.UnknownFetcher), f"from lib.data import fetch_alpha -> UnknownFetcher ({type(e).__name__})")
check(e is not None and "fetch_holder_concentration(symbol, interval, start, end, headers)" in str(e),
      "message carries fetch_holder_concentration( with its signature")
check(e is not None and "lib.md" in str(e), "message points at references/lib.md")
check(e is not None and all(n + "(" in str(e) for n in D._ALPHA_FETCHERS),
      "message lists every public alpha fetcher")

for guess in ("fetch_alphas", "get_alpha", "fetch_indicator", "fetch_holder_concentrations",
              "fetch_hc", "get_holder_concentration"):
    e = hint_of(lambda: getattr(D, guess))
    check(isinstance(e, D.UnknownFetcher) and "fetch_holder_concentration(" in str(e),
          f"lib.data.{guess} -> same hint")

check(callable(D.fetch_holder_concentration) and callable(D.fetch_kline),
      "real names untouched")
check(hasattr(D, "_fetch_alpha") and hasattr(D, "_fetch_alpha_raw"), "_fetch_alpha / _fetch_alpha_raw still there")
check(not hasattr(D, "nonexistent_thing") and not hasattr(D, "__not_a_dunder__"),
      "names that do not look like a fetcher keep the plain AttributeError (hasattr -> False)")

# the table the hint is built from must equal the set of functions that call _fetch_alpha
calling = {n for n, f in vars(D).items()
           if n.startswith("fetch_") and callable(f) and "_fetch_alpha(" in inspect.getsource(f)}
check(calling == set(D._ALPHA_FETCHERS),
      f"_ALPHA_FETCHERS == every fetch_* that calls _fetch_alpha (diff: {calling ^ set(D._ALPHA_FETCHERS)})")

# references/lib.md quick reference carries the same signatures
lib_md = open(os.path.join(ROOT, "references", "lib.md"), encoding="utf-8").read()
check("Alpha fetchers — quick reference" in lib_md, "lib.md has the quick-reference line")
missing = [n for n in D._ALPHA_FETCHERS
           if f"`{n}{inspect.signature(getattr(D, n))}`" not in lib_md]
check(not missing, f"lib.md quick reference matches live signatures (missing: {missing})")

print(f"\n{'ALL PASS' if not fails else f'{fails} FAILED'}")
sys.exit(1 if fails else 0)
