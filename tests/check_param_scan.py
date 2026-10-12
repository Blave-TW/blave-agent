"""Minimal check for lib/param_scan.write_scan + lib/validation.write_mcpt_to_stats —
no network, no api. nice_grid / percentile_thresholds must put the strategy's current
constant on a nice-step lattice (the web marks "you are here" only for an on-grid current);
default axes are ~15 cells; on_edge / extend_axis grow a border-plateau axis once, ≤ 40.
A fake 5×9 Sharpe grid (NaN cells, a sharp isolated peak that is NOT
the plateau) goes through find_plateau → write_scan; asserts the scan.json contract the
web 穩健參數 tab reads (keys, shapes, NaN → null, peak ≠ plateau, current on/off grid);
the single-constant shape (N×1, col_param '_', col_vals [0]) goes through the same path.
Then a stub stats.json takes the MCPT merge and must keep every other field (the runner's
carry-over of those keys across live ticks is covered by tests/check_mcpt_auto.py).
Run: cd blave-agent && .venv/bin/python tests/check_param_scan.py
"""
import json, math, os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import numpy as np
import pandas as pd
from lib.param_scan import (find_plateau, write_scan, _locate, nice_grid, nice_step, percentile_thresholds,
                            on_edge, extend_axis, SCAN_MAX_AXIS, GRID_N, EDGE_EXTEND)
import lib.validation as V

fails = 0
def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg); fails += (not cond)

tmp = tempfile.mkdtemp(prefix="scan-", dir=os.environ.get("SCRATCHPAD") or None)
row_vals = [0.5, 0.6, 0.7, 0.8, 0.9]                  # ENTRY_TH
col_vals = [round(0.1 * k, 1) for k in range(1, 10)]  # EXIT_TH 0.1..0.9
grid = np.full((5, 9), 0.4)
grid[3, 1] = 3.0                                      # isolated spike, neighbours stay 0.4
grid[1:4, 5:9] = 1.2                                  # broad 3×4 hill → the plateau
grid[0, 0] = np.nan; grid[4, 8] = np.nan; grid[2, 4] = np.nan   # invalid / never-traded

best_idx, nbr_mean, best_row, best_col, best_sharpe = find_plateau(grid, row_vals, col_vals)
check(tuple(best_idx) != (3, 1), "find_plateau 不選孤立尖峰 (3,1)")
check(1 <= best_idx[0] <= 3 and 5 <= best_idx[1] <= 8, f"plateau 落在平台區 → {tuple(int(x) for x in best_idx)}")

path = write_scan(grid, row_vals, col_vals, nbr_mean, best_idx, tmp,
                  row_param="ENTRY_TH", col_param="EXIT_TH", fee=0.0005,
                  start="2024-01-01", end="2026-08-31", current=(0.8, 0.2))
doc = json.load(open(path))
KEYS = {"row_param", "col_param", "row_vals", "col_vals", "grid", "nbr_mean", "peak", "plateau",
        "current", "fee", "start", "end", "window", "generated_at"}
check(os.path.basename(path) == "scan.json" and not os.path.exists(path + ".tmp"), "寫到 scan.json,無 .tmp 殘留")
check(set(doc) == KEYS, f"欄位名照契約 → 多/少: {set(doc) ^ KEYS or '無'}")
check(doc["row_param"] == "ENTRY_TH" and doc["col_param"] == "EXIT_TH", "row_param / col_param")
check(doc["row_vals"] == row_vals and doc["col_vals"] == col_vals, "row_vals / col_vals 原序")
check(len(doc["grid"]) == 5 and all(len(r) == 9 for r in doc["grid"]), "grid 5×9")
check(len(doc["nbr_mean"]) == 5 and all(len(r) == 9 for r in doc["nbr_mean"]), "nbr_mean 5×9")
check(doc["grid"][0][0] is None and doc["grid"][4][8] is None and doc["grid"][2][4] is None, "grid NaN → null")
check(doc["nbr_mean"][0][0] is None and doc["nbr_mean"][2][4] is None, "nbr_mean NaN → null(NaN 格自身無鄰域均值)")
check(all(v is None or isinstance(v, float) for r in doc["grid"] + doc["nbr_mean"] for v in r), "數值格皆 float 或 null")
check(doc["peak"] == {"i": 3, "j": 1, "sharpe": 3.0}, f"peak = 全域最高格 (3,1,3.0) → {doc['peak']}")
check((doc["plateau"]["i"], doc["plateau"]["j"]) == tuple(int(x) for x in best_idx)
      and math.isclose(doc["plateau"]["sharpe"], round(best_sharpe, 4)), "plateau = find_plateau best_idx,sharpe 為鄰域平均")
check(doc["peak"]["i"] != doc["plateau"]["i"] or doc["peak"]["j"] != doc["plateau"]["j"], "尖峰 ≠ 穩健點")
check(doc["current"] == {"i": 3, "j": 1, "vals": [0.8, 0.2]}, f"current 在網格上 → i/j 對應 → {doc['current']}")
check(doc["fee"] == 0.0005 and doc["start"] == "2024-01-01" and doc["end"] == "2026-08-31" and doc["window"] == 1, "fee / start / end / window")
check(isinstance(doc["generated_at"], int) and doc["generated_at"] > 1_700_000_000, "generated_at epoch 秒")
check("NaN" not in open(path).read(), "檔內沒有 NaN 字面值")

write_scan(grid, row_vals, col_vals, nbr_mean, best_idx, tmp, "ENTRY_TH", "EXIT_TH", 0.0005, None, None,
           current=(0.83, 0.2))
doc2 = json.load(open(path))
check(doc2["current"] == {"i": None, "j": None, "vals": [0.83, 0.2]}, f"current 不在網格 → i/j null、vals 保留 → {doc2['current']}")
check(doc2["start"] is None and doc2["end"] is None, "start/end 可為 null")
write_scan(grid, np.array(row_vals), np.array(col_vals), nbr_mean, best_idx, tmp, "ENTRY_TH", "EXIT_TH", 0.0005, None, None)
check(json.load(open(path))["current"] is None and json.load(open(path))["row_vals"] == row_vals, "沒傳 current → null;numpy vals 轉原生 list")
try:
    write_scan(grid[:4], row_vals, col_vals, nbr_mean, best_idx, tmp, "A", "B", 0.0, None, None); check(False, "形狀不合要 raise")
except ValueError:
    check(True, "形狀不合要 raise")
big_r = list(range(41)); big_g = np.full((41, 9), 0.5); d3 = tempfile.mkdtemp(prefix="scan-big-", dir=os.environ.get("SCRATCHPAD") or None)
try:
    write_scan(big_g, big_r, col_vals, big_g, (0, 0), d3, "A", "B", 0.0, None, None); check(False, "軸超過 40 要 raise(api 上限)")
except ValueError as e:
    check("40" in str(e), "軸超過 40 要 raise(api 上限)")
check(not os.path.exists(os.path.join(d3, "scan.json")), "超限時不寫 scan.json")
g40 = np.full((40, 40), 0.5); v40 = list(range(40))
b40, n40, *_ = find_plateau(g40, v40, v40)
write_scan(g40, v40, v40, n40, b40, d3, "A", "B", 0.0, None, None)
check(len(json.load(open(os.path.join(d3, "scan.json")))["grid"]) == 40, "剛好 40×40 可寫")

check(_locate(200.0, [199.998, 199.999, 200.0, 200.001]) == 2, "_locate 大數值細步長取最近格,不取第一個 isclose")
check(_locate(0.2, col_vals) == 1 and _locate(0.83, row_vals) is None, "_locate 命中 / 不在格上")

# ── nice_grid / percentile_thresholds: 目前值必在格上、步長好看 ───────────────────────
def on_lattice(vals, cur, step):
    return all(math.isclose((v - cur) / step, round((v - cur) / step), abs_tol=1e-9) for v in vals)
check(nice_step(1.979 - 0.065, 9) == 0.25, "步長 (p95−p5)/(n−1)=0.239 → 0.25")
check([nice_step(x, 2) for x in (0.35, 3.5, 0.7, 12, 0.0038)] == [0.25, 2.5, 0.5, 10.0, 0.005], "步長只取 {1,2,2.5,5}×10^k")
check(nice_step(12, 2, integer=True) == 10 and nice_step(2.4, 2, integer=True) == 2 and nice_step(0.3, 2, integer=True) == 1, "整數步長至少 1、不出 2.5")
g = nice_grid(0.065, 1.979, 9, current=0.5)
check(g == [0.0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0], f"current=0.5, p5=0.065, p95=1.979, n=9 → 0.25 步、含 0.5、全是 0.25 倍數 → {g}")
check(0.5 in g and on_lattice(g, 0.5, 0.25) and g[0] <= 0.065 and g[-1] >= 1.979, "涵蓋 [p5,p95]、目前值是格點")
g = nice_grid(-1.849, 0.065, 9, current=0.0)
check(0.0 in g and on_lattice(g, 0.0, 0.25) and g[0] <= -1.849 and g[-1] >= 0.065, f"EXIT 軸錨在 0 → {g}")
g = nice_grid(1.0, 1.5, 9, current=0.5)
check(0.5 in g and g[0] <= 0.5 and g[-1] >= 1.5, f"current 在範圍外 → 範圍擴到含 current → {g}")
g = nice_grid(1.686 - 1, 1.686 + 1, 9, current=1.686)
check(1.686 in g and on_lattice(g, 1.686, 0.25) and _locate(1.686, g) is not None, f"不整齊的 current 也必在格上(鄰格差 0.25 倍數)→ {g}")
g = nice_grid(3, 15, 7, current=5, integer=True)
check(g == [3, 5, 7, 9, 11, 13, 15] and all(type(v) is int for v in g), f"整數參數輸出 int → {g}")
g = nice_grid(500, 3000, 6, current=1500, integer=True)
check(g == [500, 1000, 1500, 2000, 2500, 3000] and all(type(v) is int for v in g), f"整數步長 500 → {g}")
g = nice_grid(20, 22, 9, current=21, integer=True)
check(g == [20, 21, 22], f"整數軸步長不小於 1 → {g}")
g = nice_grid(0, 10, 1000, current=5)
check(len(g) <= SCAN_MAX_AXIS and 5.0 in g and g[0] <= 0 and g[-1] >= 10, f"步長太細 → 放粗到 ≤ {SCAN_MAX_AXIS} 格({len(g)} 格,步長 {g[1]-g[0]})")
g = nice_grid(0, 10000, 5000, current=0, integer=True)
check(len(g) <= SCAN_MAX_AXIS and all(type(v) is int for v in g), f"整數軸放粗也 ≤ {SCAN_MAX_AXIS}({len(g)} 格)")
check(nice_grid(0, 1, 5, current=0.5, step=0.5) == [0.0, 0.5, 1.0], "step= 可指定,仍錨在 current")
for bad in ((float('nan'), 1, 0.5), (0, 1, float('inf'))):
    try:
        nice_grid(bad[0], bad[1], 5, current=bad[2]); check(False, f"nice_grid 非有限值要 raise {bad}")
    except ValueError:
        check(True, f"nice_grid 非有限值要 raise {bad}")
try:
    nice_grid(3, 15, 7, current=5.5, integer=True); check(False, "整數軸 current 非整數要 raise")
except ValueError:
    check(True, "整數軸 current 非整數要 raise")
rng = np.random.default_rng(0)
ser = pd.Series(rng.normal(1.0, 0.6, 5000)); ser.iloc[:50] = np.nan
e, x = percentile_thresholds(ser, 9, current=(0.5, 0.0))
p5, p95 = np.percentile(ser.dropna(), [5, 95]); st = nice_step(p95 - p5, 9)
check(0.5 in e and 0.0 in x and on_lattice(e, 0.5, st) and on_lattice(x, 0.0, st), f"percentile_thresholds 兩軸各含目前值、同一步長 {st}")
check(e[-1] >= p95 and x[0] <= p5 and e[0] <= (p5 + p95) / 2 <= x[-1] and len(e) <= SCAN_MAX_AXIS and len(x) <= SCAN_MAX_AXIS, "entry 涵蓋 [mid,p95]、exit 涵蓋 [p5,mid]")
check(all(isinstance(v, float) for v in e + x) and _locate(0.5, e) is not None and _locate(0.0, x) is not None, "軸值原生 float,_locate 找得到目前值")
e0, x0 = percentile_thresholds(ser, 9)
check(0.0 in e0 and 0.0 in x0, "沒傳 current → 兩軸錨在 0")

# ── 預設格數:每軸目標 15(取整後 11–21),percentile 切半後每側 ≈ 9 ──────────────
check(GRID_N == 15 and EDGE_EXTEND == 5, "GRID_N=15、EDGE_EXTEND=5")
for lo, hi, cur, integ in ((0.065, 1.979, 0.5, False), (-1.849, 0.065, 0.0, False), (0, 1, 0.5, False),
                           (0.5, 3.0, 1.686, False), (3, 15, 5, True), (0, 100, 50, True), (5, 200, 20, True), (20, 120, 60, True)):
    g = nice_grid(lo, hi, current=cur, integer=integ)
    check(11 <= len(g) <= 21, f"預設 n → {len(g)} 格 (lo={lo}, hi={hi}, integer={integ})")
e15, x15 = percentile_thresholds(ser, current=(0.5, 0.0))
check(7 <= len(x15) <= 13 and len(e15) <= 21 and math.isclose(e15[1] - e15[0], x15[1] - x15[0]), f"percentile_thresholds 預設 n_parts=17 → 每側約 9 格 ({len(e15)}×{len(x15)})、同步長")
check(len(e15) * len(x15) <= 400, "預設兩軸乘積 ≤ 400 組合")

# ── on_edge / extend_axis:穩健點在邊緣就往那側延伸 ───────────────────────────
check(on_edge((2, 4), (5, 9)) == [], "on_edge 內部 → 空")
check(on_edge((0, 4), (5, 9)) == [(0, 'lo')] and on_edge((4, 4), (5, 9)) == [(0, 'hi')], "on_edge 列軸上/下邊")
check(on_edge((2, 0), (5, 9)) == [(1, 'lo')] and on_edge((2, 8), (5, 9)) == [(1, 'hi')], "on_edge 欄軸左/右邊")
check(on_edge((0, 8), (5, 9)) == [(0, 'lo'), (1, 'hi')], "on_edge 角落 → 兩筆")
check(isinstance(on_edge(best_idx, grid.shape), list), "on_edge 直接吃 find_plateau 的 best_idx(numpy int)與 grid.shape")
try:
    on_edge((5, 0), (5, 9)); check(False, "on_edge 索引出界要 raise")
except ValueError:
    check(True, "on_edge 索引出界要 raise")
fx = [0.5, 0.75, 1.0, 1.25]
check(extend_axis(fx, 'hi') == [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5], f"extend_axis hi 加 5 格、步長不變 → {extend_axis(fx, 'hi')}")
check(extend_axis(fx, 'lo') == [-0.75, -0.5, -0.25, 0.0, 0.25, 0.5, 0.75, 1.0, 1.25], f"extend_axis lo 往下加 5 格 → {extend_axis(fx, 'lo')}")
check(extend_axis(fx, 'hi', 2) == fx + [1.5, 1.75], "extend_axis k 可指定")
gi = extend_axis([5, 15, 25], 'hi')
check(gi == [5, 15, 25, 35, 45, 55, 65, 75] and all(type(v) is int for v in gi), f"整數軸延伸輸出 int、步長 10 → {gi}")
gi = extend_axis(range(5, 35, 10), 'lo', floor=1)
check(gi == [5, 15, 25], f"floor=1:往下延伸全是負數就全丟、軸不變 → {gi}")
gi = extend_axis([20, 30, 40], 'lo', floor=1)
check(gi == [10, 20, 30, 40], f"floor=1 只丟 < 1 的格 → {gi}")
g38 = extend_axis(list(range(38)), 'hi')
check(len(g38) == SCAN_MAX_AXIS and g38[-1] == 39, f"延伸不超過 {SCAN_MAX_AXIS}(38+5 → {len(g38)})")
check(extend_axis(list(range(40)), 'lo') == list(range(40)), "已 40 格 → 原樣回傳")
g0 = nice_grid(0.065, 1.979, current=0.5)
check(0.5 in extend_axis(g0, 'lo') and _locate(0.5, extend_axis(g0, 'hi')) is not None, "延伸後目前值仍在格上")
for bad, why in (([0.5], "只有 1 格"), ([0.5, 0.7, 1.0], "步長不一致"), ([1.0, 0.5], "遞減")):
    try:
        extend_axis(bad, 'hi'); check(False, f"extend_axis {why} 要 raise")
    except ValueError:
        check(True, f"extend_axis {why} 要 raise")
try:
    extend_axis(fx, 'up'); check(False, "extend_axis side 非 lo/hi 要 raise")
except ValueError:
    check(True, "extend_axis side 非 lo/hi 要 raise")
# 邊緣 → 延伸 → 重掃 → write_scan 整段走一遍(用假 grid 模擬重掃結果)
row_e = extend_axis(row_vals, 'hi'); grid_e = np.full((len(row_e), 9), 0.4); grid_e[6:9, 2:6] = 1.5
b_e, n_e, *_ = find_plateau(grid_e, row_e, col_vals)
write_scan(grid_e, row_e, col_vals, n_e, b_e, d3, "ENTRY_TH", "EXIT_TH", 0.0005, None, None, current=(0.8, 0.2))
doc_e = json.load(open(os.path.join(d3, "scan.json")))
check(doc_e["row_vals"] == [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4] and doc_e["current"]["i"] == 3, f"延伸軸寫進 scan.json、current 仍標得到 → {doc_e['row_vals']}")
for bad_cur, why in (((True, 0.3), "current 含 bool"), ((float("nan"), 0.3), "current 含 NaN")):
    try:
        write_scan(grid, row_vals, col_vals, nbr_mean, best_idx, d3, "A", "B", 0.0, None, None, current=bad_cur); check(False, f"{why} 要 raise")
    except ValueError:
        check(True, f"{why} 要 raise")
try:
    write_scan(grid, [0.5, float("nan"), 0.7, 0.8, 0.9], col_vals, nbr_mean, best_idx, d3, "A", "B", 0.0, None, None); check(False, "row_vals 含 NaN 要 raise")
except ValueError:
    check(True, "row_vals 含 NaN 要 raise")
write_scan(grid, [0.1 * k for k in (5, 6, 7, 8, 9)], col_vals, nbr_mean, best_idx, d3, "A", "B", 0.0, None, None)
check(json.load(open(os.path.join(d3, "scan.json")))["row_vals"] == [0.5, 0.6, 0.7, 0.8, 0.9], "軸值 round(10) 去掉浮點雜訊")

# ── 小數位統一:nice_grid / write_scan / _locate 都是 round(10),細步長的目前值標得到 ──────
fine = nice_grid(0.0001, 0.0002, current=0.00012345, step=0.00001)
check(0.00012345 in fine and len(fine) == 12, f"步長 1e-5 的軸含 current=0.00012345 → {fine}")
g_f = np.full((len(fine), 9), 0.4); b_f, n_f, *_ = find_plateau(g_f, fine, col_vals)
write_scan(g_f, fine, col_vals, n_f, b_f, d3, "TH", "EXIT_TH", 0.0005, None, None, current=(0.00012345, 0.2))
doc_f = json.load(open(os.path.join(d3, "scan.json")))
check(doc_f["row_vals"] == fine and doc_f["current"]["i"] == fine.index(0.00012345) and doc_f["current"]["j"] == 1,
      f"current=0.00012345 經 write_scan 仍標得到(round(6) 會把它磨成 0.000123 而找不到)→ {doc_f['current']}")
check(_locate(0.00012345, fine) == fine.index(0.00012345) and _locate(0.1 + 0.2, [0.1, 0.2, 0.3]) == 2, "_locate 比對前同樣 round(10):0.1+0.2 命中 0.3")
g_z = nice_grid(-0.5, 0.5, current=0.25, step=0.25)
check(g_z == [-0.5, -0.25, 0.0, 0.25, 0.5] and "-0.0" not in str(g_z) and all(math.copysign(1, v) > 0 for v in g_z if v == 0),
      f"nice_grid 不輸出 -0.0 → {g_z}")
try:
    nice_grid(3, 15, current=5, integer=True, step=2.5); check(False, "整數軸 step=2.5 要 raise(不可截斷成 2)")
except ValueError:
    check(True, "整數軸 step=2.5 要 raise(不可截斷成 2)")
check(nice_grid(3, 15, current=5, integer=True, step=2.0) == [3, 5, 7, 9, 11, 13, 15], "整數軸 step=2.0(整數值 float)可接受")
check(on_edge((0, 2), (1, 5)) == [] and on_edge((0, 0), (1, 5)) == [(1, 'lo')] and on_edge((0, 4), (1, 5)) == [(1, 'hi')],
      "1×N 網格:長度 1 的軸略過、另一軸照判")
check(on_edge((0, 0), (1, 1)) == [], "1×1 網格 → 空")
g_1n = np.array([[0.4, 0.5, 1.2, 1.3, 1.1]]); b_1n, n_1n, *_ = find_plateau(g_1n, [7], col_vals[:5])
check(on_edge(b_1n, g_1n.shape) in ([], [(1, 'hi')]) and all(ax == 1 for ax, _ in on_edge(b_1n, g_1n.shape)), f"1×5 grid find_plateau → on_edge 不炸、只報欄軸 → {on_edge(b_1n, g_1n.shape)}")

# ── 單一參數:N×1 + col_param='_'(一格的第二軸,與 walk-forward 同一約定)────────────
d1 = tempfile.mkdtemp(prefix="scan-1d-", dir=os.environ.get("SCRATCHPAD") or None)
rows1 = nice_grid(5, 60, current=20, integer=True)                      # 5, 10, …, 60
# 1-D 鄰域只有三格,邊緣/NaN 旁只剩兩格會把尖峰的均值抬高——尖峰放內部、NaN 放尾端
g1 = np.full((len(rows1), 1), 0.4); g1[5:9, 0] = 1.6; g1[3, 0] = 2.5; g1[-1, 0] = np.nan
b1, n1, br1, bc1, bs1 = find_plateau(g1, rows1, [0])
check(tuple(b1) != (3, 0) and 6 <= b1[0] <= 7 and b1[1] == 0 and bc1 == 0, f"N×1 find_plateau 不選孤立尖峰、j 為 0 → {tuple(int(x) for x in b1)}")
check(math.isclose(n1[6, 0], 1.6) and math.isclose(n1[3, 0], (0.4 + 2.5 + 0.4) / 3), "N×1 鄰域 = 列軸上三格(沒有第二軸可鄰)")
check(on_edge(b1, g1.shape) == [] and on_edge((0, 0), g1.shape) == [(0, 'lo')] and on_edge((len(rows1) - 1, 0), g1.shape) == [(0, 'hi')],
      "N×1 on_edge:長度 1 的欄軸略過、列軸上下邊照判")
p1 = write_scan(g1, rows1, [0], n1, b1, d1, row_param="WINDOW", col_param="_", fee=0.0005,
                start="2024-01-01", end="2026-08-31", current=(20, 0))
doc1 = json.load(open(p1))
check(doc1["row_param"] == "WINDOW" and doc1["col_param"] == "_" and doc1["col_vals"] == [0] and doc1["row_vals"] == rows1, "N×1 寫得出來:col_param='_'、col_vals=[0]")
check(len(doc1["grid"]) == len(rows1) and all(len(r) == 1 for r in doc1["grid"] + doc1["nbr_mean"]) and doc1["grid"][-1][0] is None, "grid / nbr_mean N×1、NaN → null")
check(doc1["peak"] == {"i": 3, "j": 0, "sharpe": 2.5} and doc1["plateau"]["j"] == 0 and doc1["plateau"]["i"] == int(b1[0]), f"peak / plateau 的 j 恆為 0 → {doc1['peak']} / {doc1['plateau']}")
check(doc1["current"] == {"i": rows1.index(20), "j": 0, "vals": [20, 0]}, f"current 標在列軸上、vals 剛好兩個數 → {doc1['current']}")
write_scan(g1, rows1, [0], n1, b1, d1, "WINDOW", "_", 0.0005, None, None, current=(21, 0))
check(json.load(open(p1))["current"] == {"i": None, "j": None, "vals": [21, 0]}, "N×1 current 不在列軸上 → i/j null、vals 仍兩個數")
g1e = g1.copy(); g1e[-1, 0] = 3.0; g1e[-2, 0] = 3.0                      # 平台推到列軸 hi 邊
b1e, n1e, *_ = find_plateau(g1e, rows1, [0])
check(on_edge(b1e, g1e.shape) == [(0, 'hi')], f"N×1 平台在列軸邊緣 → 只報 (0,'hi') → {on_edge(b1e, g1e.shape)}")
rows1e = extend_axis(rows1, 'hi'); g1x = np.vstack([g1e, np.full((5, 1), 0.4)]); b1x, n1x, *_ = find_plateau(g1x, rows1e, [0])
write_scan(g1x, rows1e, [0], n1x, b1x, d1, "WINDOW", "_", 0.0005, None, None, current=(20, 0))
doc1x = json.load(open(p1))
check(len(doc1x["row_vals"]) == len(rows1) + 5 and doc1x["col_vals"] == [0] and doc1x["current"]["i"] == rows1.index(20), "N×1 延伸列軸後重寫:欄軸仍一格、current 仍標得到")
b11, n11, *_ = find_plateau(np.array([[0.7]]), [20], [0])
write_scan(np.array([[0.7]]), [20], [0], n11, b11, d1, "WINDOW", "_", 0.0005, None, None, current=(20, 0))
doc11 = json.load(open(p1))
check(doc11["grid"] == [[0.7]] and doc11["peak"] == doc11["plateau"] == {"i": 0, "j": 0, "sharpe": 0.7} and doc11["current"]["vals"] == [20, 0], "1×1 也寫得出來(軸下限是 1)")

# ── MCPT merge into stats.json ────────────────────────────────────────────────
V._REPO_ROOT = tmp
sdir = os.path.join(tmp, "strategies", "demo"); os.makedirs(sdir)
before = {"strategy": "demo", "Sharpe Ratio": 1.23, "Trades": 42, "daily_returns": [0.1, -0.2], "panes": [{"x": 1}]}
json.dump(before, open(os.path.join(sdir, "stats.json"), "w"), indent=2)
V.write_mcpt_to_stats("demo", 0.0345, 2000)
after = json.load(open(os.path.join(sdir, "stats.json")))
check(after["MCPT p-value"] == 0.0345 and after["MCPT Permutations"] == 2000, "MCPT 兩個 key 寫入")
check({k: after[k] for k in before} == before, "其他欄位原樣不動")
check(set(after) - set(before) == {"MCPT p-value", "MCPT Permutations"}, "只多這兩個 key")
check(not os.path.exists(os.path.join(sdir, "stats.json.tmp")), "stats.json 無 .tmp 殘留")
try:
    V.write_mcpt_to_stats("nope", 0.5, 10); check(False, "stats.json 不存在要 raise,不憑空造檔")
except FileNotFoundError:
    check(True, "stats.json 不存在要 raise,不憑空造檔")
check(not os.path.exists(os.path.join(tmp, "strategies", "nope", "stats.json")), "raise 後確實沒造檔")
for bad in (1.5, float("nan"), float("inf")):
    try:
        V.write_mcpt_to_stats("demo", bad, 10); check(False, f"p 值 {bad} 要 raise")
    except ValueError:
        check(True, f"p 值 {bad} 要 raise")
check(json.load(open(os.path.join(sdir, "stats.json")))["MCPT p-value"] == 0.0345, "raise 後 stats.json 不動")
check(len(doc["current"]["vals"]) == 2 and len(doc2["current"]["vals"]) == 2, "current.vals 固定長度 2")
check(all(math.isfinite(doc[k]["sharpe"]) and 0 <= doc[k]["i"] < 5 and 0 <= doc[k]["j"] < 9 for k in ("peak", "plateau")), "peak/plateau 完整物件、i/j 在範圍內、sharpe finite")
allnan = np.full((5, 9), np.nan); d2 = tempfile.mkdtemp(prefix="scan-nan-", dir=os.environ.get("SCRATCHPAD") or None)
try:
    find_plateau(allnan, row_vals, col_vals); check(False, "全 NaN grid find_plateau 要 raise")
except ValueError:
    check(True, "全 NaN grid find_plateau 要 raise")
try:
    write_scan(allnan, row_vals, col_vals, allnan, (0, 0), d2, "A", "B", 0.0, None, None); check(False, "全 NaN grid write_scan 要 raise")
except ValueError:
    check(True, "全 NaN grid write_scan 要 raise")
check(not os.path.exists(os.path.join(d2, "scan.json")), "全 NaN 時不寫 scan.json")
g_inf = grid.copy(); g_inf[0, 1] = np.inf
write_scan(g_inf, row_vals, col_vals, nbr_mean, best_idx, tmp, "ENTRY_TH", "EXIT_TH", 0.0005, None, None)
check(json.load(open(path))["grid"][0][1] is None and "Infinity" not in open(path).read(), "inf 格 → null,檔內無 Infinity")


# ── plot_heatmap: the one-cell second axis ('_') must not leak into the PNG ──────────────
from lib.param_scan import plot_heatmap, plt
plt.switch_backend("Agg")
_cap, _orig_savefig = {}, plt.savefig
def _spy_savefig(*a, **k):                      # read the axes right before they are saved and closed
    ax = plt.gcf().axes[0]
    _cap.update(size=tuple(plt.gcf().get_size_inches()), xticks=list(ax.get_xticks()), xlabel=ax.get_xlabel(), title=ax.get_title())
    return _orig_savefig(*a, **k)
plt.savefig = _spy_savefig
try:
    png1 = plot_heatmap(g1, rows1, [0], b1, row_label="WINDOW", col_label="_", output_path=os.path.join(tmp, "heatmap1.png"), send_telegram=False)
    check(os.path.getsize(png1) > 0, "N×1 plot_heatmap 寫得出 PNG")
    check(_cap["xticks"] == [] and _cap["xlabel"] == "", f"N×1 + '_':不畫 x 刻度與 xlabel → {_cap['xticks']} / {_cap['xlabel']!r}")
    check("_" not in _cap["title"] and f"WINDOW={rows1[int(b1[0])]}" in _cap["title"], f"標題只寫真參數、沒有 _=0 → {_cap['title']}")
    check(abs(_cap["size"][0] - 4) < 1e-6, f"一欄圖寬 4 吋 → {_cap['size']}")
    plot_heatmap(grid, row_vals, col_vals, best_idx, output_path=os.path.join(tmp, "heatmap2.png"), send_telegram=False)
    check(len(_cap["xticks"]) == 9 and _cap["xlabel"] == "EXIT_TH" and "EXIT_TH=" in _cap["title"] and _cap["size"][0] >= 8, f"二維熱圖照舊:9 個 x 刻度、xlabel、標題帶第二軸、寬 ≥ 8 → {_cap['size']}")
    plot_heatmap(g1, rows1, [0.5], b1, row_label="WINDOW", col_label="EXIT_TH", output_path=os.path.join(tmp, "heatmap3.png"), send_telegram=False)
    check(_cap["xticks"] == [0] and _cap["xlabel"] == "EXIT_TH", "第二軸是真常數只有一格:照二維畫(x 刻度與 xlabel 都在)")
finally:
    plt.savefig = _orig_savefig

print("all checks passed" if not fails else f"FAILED: {fails}"); sys.exit(1 if fails else 0)
