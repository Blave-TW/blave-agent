"""FEE is PER SIDE (one-way) everywhere. No network.

  1. the engine: precise_pnl (run() and param_scan) and walk_forward._price_pnl charge |Δw|·FEE —
     open + close = 2·FEE, a long→short flip = 2·FEE on one bar;
  2. every FEE line in the templates and the shipped examples says per side, and nothing near a
     FEE line in them, AGENTS.md or references/ calls it a round trip;
  3. the templates and examples of a covered market ship lib.costs' default for it.
Run: cd blave-agent && .venv/bin/python tests/check_fee_per_side.py
"""
import glob, os, re, sys
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from lib.analysis import precise_pnl
from lib.walk_forward import _price_pnl

fails = 0
def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1

FEE = 0.0005
close = np.full(6, 100.0)

def fees(pos):
    pos = np.asarray(pos, float)
    w_curr = np.r_[0.0, pos[:-1]]
    w_prev = np.r_[0.0, 0.0, pos[:-2]]
    _, _, _, tc = precise_pnl(close, close, w_curr, w_prev, np.zeros(len(pos), bool), FEE)
    return tc

check(np.isclose(fees([1, 1, 0, 0, 0, 0]).sum(), 2 * FEE), "precise_pnl: open + close = 2·FEE")
tc = fees([1, 1, -1, -1, 0, 0])
check(np.isclose(tc.max(), 2 * FEE) and np.isclose(tc.sum(), 4 * FEE), "precise_pnl: a long→short flip = 2·FEE on one bar")
_, dw = _price_pnl(np.array([1, 1, 0, 0, 0, 0], float), np.zeros(6, bool), close, close, FEE)
check(np.isclose(np.abs(dw).sum() * FEE, 2 * FEE), "walk_forward._price_pnl: same |Δw| per side")

TRACKED = sorted(glob.glob(os.path.join(ROOT, "strategies", "TEMPLATE_*.py"))
                 + glob.glob(os.path.join(ROOT, "examples", "*", "strategy.py")))
FEE_LINE = re.compile(r"^FEE\s*=\s*([0-9.eE-]+)\s*(#.*)?$")
PER_SIDE = re.compile(r"per side|PER SIDE|單邊")
values = {}
for p in TRACKED:
    rel = os.path.relpath(p, ROOT)
    lines = open(p, encoding="utf-8").read().splitlines()
    hits = [(i, FEE_LINE.match(l)) for i, l in enumerate(lines) if FEE_LINE.match(l)]
    check(len(hits) == 1, f"{rel}: one FEE line")
    for i, m in hits:
        values[rel] = float(m.group(1))
        check(bool(m.group(2)) and bool(PER_SIDE.search(m.group(2))), f"{rel}: FEE comment says per side")

ROUND = re.compile(r"round[- ]trip|來回", re.I)
for p in TRACKED + [os.path.join(ROOT, "AGENTS.md")] + sorted(glob.glob(os.path.join(ROOT, "references", "*.md"))):
    lines = open(p, encoding="utf-8").read().splitlines()
    for i, l in enumerate(lines):
        if "FEE" in l and ROUND.search(l):
            near = l
        elif re.match(r"^\s*FEE\s*=", l):
            near = "\n".join(lines[max(0, i - 2):i + 3])
        else:
            continue
        ok = not ROUND.search(near) or re.search(r"round trip (is charged twice|pays it twice)|open then close = `2 × FEE`", near)
        check(bool(ok), f"{os.path.relpath(p, ROOT)}:{i + 1}: FEE is not described as a round trip")

from lib.costs import default_fee
DEFAULTS = {"examples/tsmc_ma/strategy.py": default_fee("2330"),
            "examples/tw2317_broker_zscore/strategy.py": default_fee("2317"),
            "examples/tw100_foreign_zscore/strategy.py": default_fee(universe=["2330", "2317"]),
            "examples/twstock_momentum/strategy.py": default_fee(universe=["2330", "2317"]),
            "strategies/TEMPLATE_C.py": default_fee(universe=["2330", "0050"]),
            "strategies/TEMPLATE_A.py": default_fee("BTCUSDT", "swap"),
            "examples/btc_sma_cross/strategy.py": default_fee("BTCUSDT"),
            "examples/btc_ti_5min/strategy.py": default_fee("BTCUSDT"),
            "examples/txf_ma_1m/strategy.py": default_fee("TXF")}
for rel, want in DEFAULTS.items():
    check(values.get(rel) == want, f"{rel}: FEE {values.get(rel)} = the market default {want}")

print("all ok" if not fails else "FAILED")
sys.exit(1 if fails else 0)
