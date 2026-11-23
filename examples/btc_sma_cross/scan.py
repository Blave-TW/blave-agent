import sys, time, warnings
warnings.filterwarnings('ignore', category=FutureWarning)
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from dotenv import dotenv_values
from lib.data import fetch_kline
from lib.param_scan import nice_grid, scan_until_interior, write_scan, plot_heatmap
import strategy as s
from lib.costs import fee_of  # the strategy's FEE, else its market default

env  = dotenv_values()
hdrs = {'api-key': env.get('blave_api_key', ''), 'secret-key': env.get('blave_secret_key', '')}

# ── 資料一次 ──────────────────────────────────────────────────────────────────
t0 = time.time()
base_df = fetch_kline(s.SYMBOL, s.INTERVAL, s.START, s.END, hdrs)
print(f"資料載入: {time.time()-t0:.1f}s  ({len(base_df):,} bars)\n")

# ── 掃描範圍 ──────────────────────────────────────────────────────────────────
# 每軸 10 格、步長是有交易意義的 K 棒數(10 / 20 根),100 組合幾秒掃完;
# 步長再細,相鄰格只差雜訊、鄰域平均就退化成單格。nice_grid 錨在檔案目前的常數,
# 目前值一定是格點(web 才標得出「你在這裡」);integer=True 輸出整數 K 棒數。
fast_vals = nice_grid(5,  95,  n=10, current=s.SMA_FAST, integer=True)   # 5, 15, 25, ..., 95
slow_vals = nice_grid(20, 200, n=10, current=s.SMA_SLOW, integer=True)   # 20, 40, 60, ..., 200

# ── 參數掃描 ──────────────────────────────────────────────────────────────────
# 穩健點落在網格邊緣 → 往那側沿同步長延伸 5 格重掃,直到不在邊緣(全部算同一次掃描)。
# K 棒數軸給 floor=1,往下延伸不會產生 0 或負的均線長度;warmup 跟著延伸後最長的窗。
r = scan_until_interior(
    base_df, s.compute_signals, fast_vals, slow_vals,
    row_param='fast', col_param='slow',
    fee=fee_of(s), warmup=lambda fv, sv: max(sv),
    valid_fn=lambda f, sl: f < sl,
    current=(s.SMA_FAST, s.SMA_SLOW), row_floor=1, col_floor=1,
)
grid, fast_vals, slow_vals, nbr_mean, best_idx = r['grid'], r['row_vals'], r['col_vals'], r['nbr_mean'], r['best_idx']
best_fast, best_slow, best_sharpe = r['best_row'], r['best_col'], r['best_sharpe']
if not r['interior']:   # 停在界限／次數／時間仍在邊緣 → 不自己採用,交給用戶決定
    print(f"⚠️ 穩健點仍在網格邊緣(停止原因 {r['stop']}),真正的最佳區可能在掃描範圍外——回報用戶,請用戶決定")

print(f"穩健參數: SMA_FAST={best_fast}, SMA_SLOW={best_slow}  鄰域 Sharpe={best_sharpe:.3f}  單格 Sharpe={grid[best_idx]:.3f}")

# scan.json → web 穩健參數分頁(掃完必寫)
write_scan(grid, fast_vals, slow_vals, nbr_mean, best_idx,
           output_dir=str(Path(__file__).parent),
           row_param='SMA_FAST', col_param='SMA_SLOW', fee=fee_of(s),
           start=s.START, end=base_df.index[-1].strftime('%Y-%m-%d'),
           current=(s.SMA_FAST, s.SMA_SLOW), evaluated=r['evaluated'])

plot_heatmap(
    grid, fast_vals, slow_vals,
    best_idx=best_idx,
    row_label='SMA Fast', col_label='SMA Slow',
    title=f'{s.STRATEGY_NAME} — Sharpe Grid',
    output_path=str(Path(__file__).parent / 'heatmap.png'),
)
