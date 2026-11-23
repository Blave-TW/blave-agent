import sys, time, warnings
warnings.filterwarnings('ignore', category=FutureWarning)
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from dotenv import dotenv_values
from lib.param_scan import percentile_thresholds, scan_until_interior, write_scan, plot_heatmap
import strategy as s
from lib.costs import fee_of  # the strategy's FEE, else its market default

env  = dotenv_values()
hdrs = {'api-key': env.get('blave_api_key', ''), 'secret-key': env.get('blave_secret_key', '')}

# ── 載入資料 ──────────────────────────────────────────────────────────────────
t0 = time.time()
df = s.fetch_data(hdrs)
print(f"資料載入: {time.time()-t0:.1f}s  ({len(df):,} bars)\n")

# ── 從 TI 分佈決定掃描範圍 ────────────────────────────────────────────────────
# 範圍看分佈(p5–p95),格點是 {1,2,2.5,5}×10^k 的倍數、且錨在 strategy.py 目前的
# (ENTRY_TH, EXIT_TH) —— 目前值不在格上時 web 穩健參數分頁只能顯示「不在掃描範圍」、
# 標不出目前格,所以 current= 一定要傳。預設 n_parts=17 → 每軸約 9–16 格、100–200 組合,
# 5 分 K 兩年也在 10 秒內;再細的步長沒有交易意義,鄰域平均會退化成單格。
entry_vals, exit_vals = percentile_thresholds(df['TI'], current=(s.ENTRY_TH, s.EXIT_TH))

# ── 參數掃描 ──────────────────────────────────────────────────────────────────
# 穩健點落在網格邊緣 → 往那側沿同步長延伸 5 格重掃,直到不在邊緣(全部算同一次掃描)
r = scan_until_interior(df, s.compute_signals, entry_vals, exit_vals, fee=fee_of(s),
                        current=(s.ENTRY_TH, s.EXIT_TH))
grid, entry_vals, exit_vals, nbr_mean, best_idx = r['grid'], r['row_vals'], r['col_vals'], r['nbr_mean'], r['best_idx']
best_entry, best_exit, best_sharpe = r['best_row'], r['best_col'], r['best_sharpe']
if not r['interior']:   # 停在界限／次數／時間仍在邊緣 → 不自己採用,交給用戶決定
    print(f"⚠️ 穩健點仍在網格邊緣(停止原因 {r['stop']}),真正的最佳區可能在掃描範圍外——回報用戶,請用戶決定")

print(f"穩健參數: ENTRY_TH={best_entry}, EXIT_TH={best_exit}  鄰域 Sharpe={best_sharpe:.3f}  單格 Sharpe={grid[best_idx]:.3f}")

# scan.json → web 穩健參數分頁(掃完必寫)
write_scan(grid, entry_vals, exit_vals, nbr_mean, best_idx,
           output_dir=str(Path(__file__).parent),
           row_param='ENTRY_TH', col_param='EXIT_TH', fee=fee_of(s),
           start=s.START, end=df.index[-1].strftime('%Y-%m-%d'),
           current=(s.ENTRY_TH, s.EXIT_TH), evaluated=r['evaluated'])

plot_heatmap(
    grid, entry_vals, exit_vals,
    best_idx=best_idx,
    row_label='ENTRY_TH', col_label='EXIT_TH',
    title=f'{s.STRATEGY_NAME} — Sharpe Grid (TI 24h, {s.INTERVAL})',
    output_path=str(Path(__file__).parent / 'heatmap.png'),
)
