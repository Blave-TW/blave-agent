"""lib/param_scan.scan_until_interior — a plateau on a grid border is extended and rescanned until it is
interior (Wei 11-23), with the stops the agent turns into answer buttons: a physical bound (floor / ceil),
EDGE_MAX_EXTENSIONS, the scan time budget. An axis at the 40-cell cap is coarsened, never stopped on.
`evaluated` counts every combo that produced a Sharpe across all passes and write_scan reports it.
The old extend_axis keeps its behaviour.

Analytic Sharpe surfaces go through a stand-in scan_grid (the loop logic); one tiny synthetic OHLC series
goes through the real scan_grid (the skip of already-scanned cells).
Run: cd blave-agent && .venv/bin/python tests/check_param_scan_extend.py
"""
import json, os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("MPLBACKEND", "Agg")
for k in ("BLAVE_TURN_ID", "BLAVE_TURN_PID"):
    os.environ.pop(k, None)
import numpy as np
import pandas as pd
import lib.param_scan as ps
from lib.param_scan import (scan_until_interior, extend_axis, nice_grid, write_scan, find_plateau,
                            SCAN_MAX_AXIS, EDGE_EXTEND, EDGE_MAX_EXTENSIONS, SCAN_BUDGET_S)

fails = 0
def check(cond, msg, detail=""):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg + ("" if cond or not detail else f"  → {detail}"))
    fails += (not cond)

_real_scan_grid = ps.scan_grid
calls = []

def fake_scan(surface):
    """scan_grid stand-in: Sharpe = surface(row, col); honours valid_fn and skip like the real one."""
    def scan_grid(data, fn, row_vals, col_vals, row_param='entry_th', col_param='exit_th', fee=None,
                  valid_fn=None, warmup=0, skip=None, **_):
        g = np.full((len(row_vals), len(col_vals)), np.nan)
        for i, r in enumerate(row_vals):
            for j, c in enumerate(col_vals):
                if (valid_fn and not valid_fn(r, c)) or (skip and ps._cell_key(r, c) in skip):
                    continue
                calls.append((r, c))
                g[i, j] = surface(r, c)
        return g
    return scan_grid

def run(surface, rows, cols, **kw):
    calls.clear()
    ps.scan_grid = fake_scan(surface)
    try:
        return scan_until_interior(None, None, rows, cols, fee=0.0005, **kw)
    finally:
        ps.scan_grid = _real_scan_grid

check(EDGE_MAX_EXTENSIONS == 6 and SCAN_BUDGET_S == 300 and EDGE_EXTEND == 5, "常數:最多延伸 6 次、預算 300 秒、每次 5 格")

# ── (a) 邊緣兩次才落內部 → 延伸 2 次、interior ────────────────────────────────────
peak = lambda r, c: 2.0 - ((r - 130) / 40.0) ** 2 - ((c - 30) / 20.0) ** 2
rows = nice_grid(20, 100, current=20, integer=True, step=5)        # 20..100
cols = nice_grid(10, 50, current=10, integer=True, step=5)         # 10..50, peak 30 inside
r = run(peak, rows, cols, current=(20, 10))
check(r["interior"] and r["edges"] == [] and r["stop"] == "interior", "高原落到內部 → interior、stop='interior'", r["stop"])
check(r["extensions"] == 2, "列軸 hi 側延伸兩次(100→125 仍在邊、→150 落內部)", r["extensions"])
check(r["row_vals"][0] == 20 and r["row_vals"][-1] == 150 and np.diff(r["row_vals"]).tolist() == [5] * (len(r["row_vals"]) - 1),
      "延伸後列軸 20..150、步長不變", r["row_vals"][-1])
check(r["col_vals"] == cols, "沒碰邊的欄軸不動")
check(r["best_row"] == 130 and r["best_col"] == 30, "最後高原 = 真正的最佳 (130, 30)", (r["best_row"], r["best_col"]))
check(r["grid"].shape == (len(r["row_vals"]), len(r["col_vals"])) and r["nbr_mean"].shape == r["grid"].shape,
      "回傳的是最後那一張完整網格")
check(len(calls) == len(set(calls)), "已掃過的格不重算", f"{len(calls)} calls / {len(set(calls))} unique")
check([h["edges"] for h in r["path"]] == [[(0, 'hi')], [(0, 'hi')], []] and len(r["path"]) == 3,
      "path 記每一輪的高原與邊緣", r["path"])

# ── (c) N 組含所有延伸 ────────────────────────────────────────────────────────────
check(r["evaluated"] == int(np.count_nonzero(~np.isnan(r["grid"]))) == len(set(calls)),
      "evaluated = 所有延伸算過、有 Sharpe 的組數", (r["evaluated"], len(set(calls))))
noted = []
import lib.iterate as it
_orig_note = it.note_params
it.note_params = lambda name, n: noted.append(n)
try:
    d = tempfile.mkdtemp(prefix="scan-ext-", dir=os.environ.get("SCRATCHPAD") or None)
    write_scan(r["grid"], r["row_vals"], r["col_vals"], r["nbr_mean"], r["best_idx"], d, "ENTRY", "EXIT",
               0.0005, None, None, evaluated=r["evaluated"] + 7)
    write_scan(r["grid"], r["row_vals"], r["col_vals"], r["nbr_mean"], r["best_idx"], d, "ENTRY", "EXIT",
               0.0005, None, None)
    write_scan(r["grid"], r["row_vals"], r["col_vals"], r["nbr_mean"], r["best_idx"], d, "ENTRY", "EXIT",
               0.0005, None, None, current=(20, 10), evaluated=3)
finally:
    it.note_params = _orig_note
fin = int(np.count_nonzero(~np.isnan(r["grid"])))
check(noted == [r["evaluated"] + 7, fin, fin], "write_scan(evaluated=N) 記 N;沒傳或小於網格格數 → 照網格格數", noted)
doc = json.load(open(os.path.join(d, "scan.json")))
check(len(doc["row_vals"]) <= SCAN_MAX_AXIS and doc["row_vals"] == r["row_vals"] and doc["current"]["i"] == 0,
      "scan.json 寫最後那張網格、current 仍標得到")

# ── (b1) 次數上限:一路往上爬 → 6 次後仍在邊緣,不採用 ──────────────────────────────
climb = lambda r_, c: r_ / 10.0 - ((c - 30) / 20.0) ** 2
r = run(climb, nice_grid(5, 75, current=5, integer=True, step=5), cols, current=(5, 10))
check(not r["interior"] and r["stop"] == "extensions" and r["extensions"] == EDGE_MAX_EXTENSIONS and r["edges"] == [(0, 'hi')],
      "延伸 6 次仍在邊緣 → stop='extensions'、edges 非空", (r["stop"], r["extensions"], r["edges"]))
check(len(r["row_vals"]) <= SCAN_MAX_AXIS, f"軸長始終 ≤ {SCAN_MAX_AXIS}(撞 40 改放粗步長)", len(r["row_vals"]))
check(r["row_vals"][1] - r["row_vals"][0] > 5 and 5 in r["row_vals"], "撞 40 後步長放粗、目前值仍在格上",
      r["row_vals"][:4])
check(r["evaluated"] > int(np.count_nonzero(~np.isnan(r["grid"]))),
      "放粗後丟掉的細格仍算進 evaluated", (r["evaluated"], int(np.count_nonzero(~np.isnan(r["grid"])))))
check(r["evaluated"] == len(set(calls)), "evaluated = 實際算過的不重複組數", (r["evaluated"], len(set(calls))))
r2 = run(climb, nice_grid(5, 75, current=5, integer=True, step=5), cols, current=(5, 10), max_extensions=2)
check(r2["stop"] == "extensions" and r2["extensions"] == 2, "max_extensions 可調小", r2["extensions"])

# ── (b2) 40 格:放粗而不是停 ──────────────────────────────────────────────────────
r = run(peak, list(range(20, 100, 2)), cols, current=(20, 10))                     # 40 cells, peak 130 beyond
check(r["interior"] and r["best_row"] is not None and abs(r["best_row"] - 130) <= 10 and len(r["row_vals"]) <= SCAN_MAX_AXIS,
      "已滿 40 格仍可延伸(步長放粗)並找到內部高原", (r["stop"], r["best_row"], len(r["row_vals"])))

# ── (b3) floor / ceil:碰到物理界限仍在邊緣 → stop='bound' ────────────────────────
down = lambda r_, c: -r_ / 10.0 - ((c - 30) / 20.0) ** 2
r = run(down, list(range(1, 16)), cols, current=(10, 10), row_floor=1)
check(not r["interior"] and r["stop"] == "bound" and r["edges"] == [(0, 'lo')] and r["extensions"] == 0,
      "bar 數 floor=1、高原在 1 → stop='bound'、不延伸", (r["stop"], r["edges"], r["extensions"]))
r = run(down, list(range(5, 31, 5)), cols, current=(10, 10), row_floor=1)
check(r["stop"] == "bound" and r["row_vals"][0] >= 1, "lo 側延伸到 floor 為止、不產生 0 或負的窗", r["row_vals"][:3])
r = run(down, list(range(20, 201, 20)), cols, current=(20, 10), row_floor=1)
check(r["row_vals"][0] == 1 and r["row_vals"][1] == 20 and r["extensions"] == 1 and r["stop"] == "bound"
      and r["best_row"] == 1 and [h["edges"] for h in r["path"]][0] == [(0, 'lo')],
      "步長 20、最小 20、floor=1 → 先補 1 再掃,掃到 1 仍貼著才算 bound", (r["row_vals"][:3], r["extensions"], r["stop"]))
c0 = calls.count((1, 30))
check(c0 == 1, "補進來的 floor 格有真的掃到", c0)
r = run(down, list(range(10, 51, 10)), cols, current=(10, 10), row_floor=3)
check(r["row_vals"][0] == 3 and r["row_vals"][1] == 10 and r["stop"] == "bound", "floor=3、最小 10、步長 10 → 補 3", r["row_vals"][:3])
r = run(lambda r_, c: -abs(r_ - 8) - ((c - 30) / 20.0) ** 2, list(range(20, 201, 20)), cols, current=(20, 10), row_floor=1)
check(r["row_vals"][0] == 1 and r["stop"] == "bound" and r["best_row"] == 1, "最佳在 8:補 1 後高原貼 1 → bound(不再往下)", r["path"])
pct = lambda r_, c: r_ - ((c - 30) / 20.0) ** 2
r = run(pct, [60.0, 70.0, 80.0, 90.0], cols, current=(60.0, 10), row_ceil=95.0)
check(r["stop"] == "bound" and r["row_vals"][-2:] == [90.0, 95.0], "ceil=95、步長 10 → 補 95 再判 bound", r["row_vals"])
r = run(pct, [60.0, 70.0, 80.0, 90.0], cols, current=(60.0, 10), row_ceil=100.0)
check(r["stop"] == "bound" and max(r["row_vals"]) <= 100.0 and r["edges"] == [(0, 'hi')],
      "門檻 ceil=100 → 延伸到 100 為止、stop='bound'", (r["stop"], r["row_vals"]))
check(extend_axis([60.0, 70.0, 80.0, 90.0], 'hi', ceil=100.0) == [60.0, 70.0, 80.0, 90.0, 100.0], "extend_axis ceil= 截掉超過界限的格")

# ── (b4) 時間預算:下一輪估計超過就停 ─────────────────────────────────────────────
r = run(climb, nice_grid(5, 75, current=5, integer=True, step=5), cols, current=(5, 10), max_seconds=0)
check(r["stop"] == "time" and r["extensions"] == 0 and not r["interior"], "預算 0 秒 → 不延伸、stop='time'", r["stop"])

# ── 角落:兩軸都往外 ─────────────────────────────────────────────────────────────
corner = lambda r_, c: 2.0 - ((r_ - 120) / 40.0) ** 2 - ((c - 70) / 20.0) ** 2
r = run(corner, nice_grid(20, 100, current=20, integer=True, step=5), cols, current=(20, 10))
check(r["interior"] and r["best_row"] == 120 and r["best_col"] == 70, "角落 → 兩軸各自往外延伸到內部", (r["best_row"], r["best_col"]))

# ── 內部就不延伸 ───────────────────────────────────────────────────────────────
r = run(peak, nice_grid(100, 160, current=100, integer=True, step=5), cols, current=(100, 10))
check(r["interior"] and r["extensions"] == 0 and r["stop"] == "interior", "一開始就在內部 → 0 次延伸")

# ── 真的 scan_grid:skip 已算過的格、結果跟整張重掃一樣 ────────────────────────────
n = 600
idx = pd.date_range("2024-01-01", periods=n, freq="D")
close = pd.Series(100 + np.cumsum(np.sin(np.arange(n) / 9.0)), index=idx)
df = pd.DataFrame({"Open": close.shift(1).fillna(100.0), "Close": close}, index=idx)
def sig(data, fast=5, slow=20):
    return (data["Close"].rolling(fast).mean() > data["Close"].rolling(slow).mean()).astype(float)
rows = [2, 3, 4, 5]
colv = [10, 12, 14]
res = scan_until_interior(df, sig, rows, colv, row_param='fast', col_param='slow', fee=0.0005,
                          valid_fn=lambda f, s_: f < s_, warmup=lambda rv, cv: max(cv), current=(3, 12),
                          row_floor=1, col_floor=2)
full = _real_scan_grid(df, sig, res["row_vals"], res["col_vals"], row_param='fast', col_param='slow',
                       fee=0.0005, valid_fn=lambda f, s_: f < s_, warmup=max(res["col_vals"]))
check(np.allclose(res["grid"], full, equal_nan=True), "真 scan_grid:延伸後拼起來的網格 = 整張重掃",
      (res["row_vals"], res["col_vals"]))
check(res["evaluated"] >= int(np.count_nonzero(~np.isnan(res["grid"]))), "真 scan_grid:evaluated ≥ 最後網格格數")

# ── (d) 舊 extend_axis 行為不變 ───────────────────────────────────────────────────
check(extend_axis([0.5, 0.75, 1.0, 1.25], 'hi') == [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5], "extend_axis hi 預設 5 格")
check(extend_axis([20, 30, 40], 'lo', floor=1) == [10, 20, 30, 40], "extend_axis floor=1 照舊")
check(extend_axis(list(range(38)), 'hi') == list(range(40)), "extend_axis 夾在 40")
check(extend_axis(list(range(40)), 'lo') == list(range(40)), "extend_axis 已 40 → 原樣")

print("all checks passed" if not fails else f"FAILED: {fails}"); sys.exit(1 if fails else 0)
