"""Minimal check for lib/walk_forward.run_walk_forward — no network, no api.

Covers the three semantics the design spec does not pin down, plus the two WFE
denominator guards:
  1. picking uses find_plateau's neighbourhood mean, but the reported train_sharpe
     (= the WFE denominator) is the picked CELL's own Sharpe;
  2. the seam bar between two runs with different parameters carries the INCOMING
     run's position (no forced flat), and per-run trade counts are cut from the one
     stitched series (they sum to the stitched total);
  3. every training slice skips its first `warmup` bars.
Plus: training Sharpe ≤ 0 → excluded run, out of the in-sample average; in-sample
mean < 0.25 → wfe null; < 3 runs raises and writes nothing; Type A and Type C both
run end to end; the wf.json contract the web 樣本外驗證 tab reads.

Run: cd blave-agent && .venv/bin/python tests/check_walk_forward.py
"""
import json, math, os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import numpy as np
import pandas as pd
from lib.param_scan import find_plateau
from lib.walk_forward import (run_walk_forward, default_windows, _run_windows, _stitch,
                              _split_runs, _wfe, _unpack, _window_stats,
                              WF_MIN_DENOM, WF_MIN_RUNS)

fails = 0
def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg); fails += (not cond)

tmp = tempfile.mkdtemp(prefix="wf-", dir=os.environ.get("SCRATCHPAD") or None)
WARMUP = 20
ENTRY_VALS = [0.0, 0.002, 0.004, 0.006]
EXIT_VALS = [-0.004, -0.002, 0.0]


def make_df(days=700, drift=0.0008, seed=7):
    """Daily OHLC with a momentum-friendly trend (drift > 0) or a grinding
    downtrend (drift < 0)."""
    rng = np.random.default_rng(seed)
    idx = pd.date_range("2023-01-01", periods=days, freq="D")
    ret = drift + 0.012 * rng.standard_normal(days) + 0.006 * np.sin(np.arange(days) / 17)
    close = 100 * np.cumprod(1 + ret)
    return pd.DataFrame({"Open": close / (1 + ret / 2), "Close": close,
                         "High": close * 1.004, "Low": close * 0.996}, index=idx)


def compute_signals(df, entry_th=0.0, exit_th=0.0):
    """Long while the 20-bar mean of 5-bar returns is above entry_th, flat below
    exit_th (hysteresis: NaN in between, carried forward by the lib)."""
    ind = df["Close"].pct_change(5).rolling(WARMUP).mean()
    sig = pd.Series(np.nan, index=df.index)
    sig[ind > entry_th] = 1.0
    sig[ind < exit_th] = 0.0
    return sig


# ── default windows: floor, never round ───────────────────────────────────────
check(all(default_windows(d) == (1095, 30) for d in (1185, 1700)),
      f"≥ 1185 天用 1095/30 → {default_windows(1185)}")
check(all(default_windows(d) == (365, 30) for d in (455, 730, 1184)),
      f"455–1184 天維持 365/30(不掉進比例公式)→ {default_windows(1184)}")
check(default_windows(454) == (148, 37) and default_windows(365) == (120, 30),
      "不夠切 3 輪的短資料退回比例公式(4:1、floor)")
check(default_windows(120) == (120, 30), "短資料仍守 30 天步長下限")

# ── seam: run k's first test bar carries run k's own position ─────────────────
POS_A = np.full(60, 1.0)
POS_B = np.full(60, -1.0)
POS_B[35] = 0.5                       # a distinctive value inside run 2's test window
fake = {(0, 0): POS_A, (1, 1): POS_B}
zeros = np.zeros(60, dtype=bool)
prices = np.linspace(100, 160, 60)
wins = [(0, 20, 30), (10, 30, 40)]    # rolling, contiguous test windows [20,30) [30,40)
pos_oos, exec_oos, _c, _o, a, b = _stitch(
    [(0, 0), (1, 1)], wins, lambda i, j: (fake[(i, j)], zeros, prices, prices))
check((a, b) == (20, 40) and len(pos_oos) == 20, f"樣本外 = 兩段測試窗接起來 [20,40) → {(a, b)}")
check(np.all(pos_oos[:10] == POS_A[20:30]), "第 1 輪測試窗 = 第 1 輪參數的部位")
check(pos_oos[10] == POS_B[30] and np.all(pos_oos[10:] == POS_B[30:40]),
      "接縫那根的部位 = 第 2 輪參數算出來的值(不強制歸零)")
check(pos_oos[15] == 0.5, "接縫後照抄第 2 輪自己的序列(含 35 那根的 0.5)")

# ── in-sample guards, as pure functions ───────────────────────────────────────
valid, excluded = _split_runs([1.2, -0.3, 0.0, 0.8])
check(valid == [0, 3] and excluded == [2, 3], f"訓練 Sharpe ≤ 0(含 0)判失敗 → 排除第 2、3 輪 → {excluded}")
check(_split_runs([-1.0, -2.0])[0] == [] and _split_runs([-1.0, -2.0])[1] == [1, 2], "全數失敗 → 沒有有效輪")
check(_wfe(0.62, 1.51) == 0.4106, f"WFE = 樣本外 ÷ 樣本內 → {_wfe(0.62, 1.51)}")
check(_wfe(0.5, WF_MIN_DENOM) == 2.0 and _wfe(0.5, WF_MIN_DENOM - 0.001) is None,
      f"樣本內 Sharpe < {WF_MIN_DENOM} 不做除法 → null")
check(_wfe(0.5, 0.0) is None and _wfe(0.5, -1.2) is None and _wfe(0.5, None) is None,
      "分母 ≤ 0 或沒有有效輪 → null(不會出現負的 WFE)")

# ── end to end, Type A ────────────────────────────────────────────────────────
df = make_df()
LOOKBACK, STEP = 240, 60
path = run_walk_forward(df, compute_signals, ENTRY_VALS, EXIT_VALS, tmp,
                        row_param="ENTRY_TH", col_param="EXIT_TH", fee=0.0005,
                        lookback_days=LOOKBACK, step_days=STEP, warmup=WARMUP,
                        current=(0.002, 0.0))
doc = json.load(open(path))
KEYS = {"row_param", "col_param", "row_vals", "col_vals", "current", "lookback_days",
        "step_days", "n_runs", "tail_days", "fee", "start", "end", "oos", "oos_stats",
        "is_stats", "wfe", "excluded_runs", "runs", "generated_at"}
STATS_KEYS = {"Sharpe Ratio", "Ann. Return [%]", "Max Drawdown [%]", "Trades"}
RUN_KEYS = {"k", "train_start", "train_end", "test_start", "test_end", "params",
            "train_sharpe", "test_sharpe", "test_return", "trades"}
check(os.path.basename(path) == "wf.json" and not os.path.exists(path + ".tmp"), "寫到 wf.json,無 .tmp 殘留")
check(set(doc) == KEYS, f"欄位名照契約 → 多/少: {set(doc) ^ KEYS or '無'}")
check(doc["n_runs"] == len(doc["runs"]) == 7, f"700 天 / 訓練 240 / 步長 60 → 7 輪 → {doc['n_runs']}")
SPAN = (df.index[-1] - df.index[0]).days
check(doc["lookback_days"] == LOOKBACK and doc["step_days"] == STEP
      and doc["tail_days"] == SPAN - LOOKBACK - 7 * STEP,
      f"窗長回報 + 末尾不足一輪的天數 → {doc['tail_days']}")
check(doc["current"] == [0.002, 0.0] and doc["row_param"] == "ENTRY_TH" and doc["col_param"] == "EXIT_TH",
      "current 是值(給 stale 判定比對程式碼常數)、軸名是常數名")
check(doc["row_vals"] == ENTRY_VALS and doc["col_vals"] == EXIT_VALS, "軸原序原值")
check(all(set(r) == RUN_KEYS for r in doc["runs"]), "runs[] 欄位照契約")
check([r["k"] for r in doc["runs"]] == list(range(1, 8)), "runs[].k 從 1 連號")
check(all(r["params"][0] in ENTRY_VALS and r["params"][1] in EXIT_VALS for r in doc["runs"]),
      "每輪選中的參數落在軸上(前端要拿它定位落點格)")
check(set(doc["oos_stats"]) == set(doc["is_stats"]) == STATS_KEYS, "oos_stats / is_stats 四個 key 沿用 runner 字串")
check(len(doc["oos"]["dates"]) == len(doc["oos"]["cum"]) > 0, "樣本外曲線 dates / cum 等長")
check(doc["oos"]["dates"][0] == doc["runs"][0]["test_start"], "曲線從第 1 輪測試窗開始")
check(doc["oos"]["dates"][-1] == doc["runs"][-1]["test_end"], "曲線收在最後一輪測試窗")
check(doc["oos"]["dates"] == sorted(set(doc["oos"]["dates"])) and all(math.isfinite(v) for v in doc["oos"]["cum"]),
      "曲線一天一點、日期遞增不重複,cum 全是有限數")
check("NaN" not in open(path).read() and "Infinity" not in open(path).read(), "檔內沒有 NaN / Infinity 字面值")

# 交易次數:明細表各輪加總 = 比較表樣本外那格(同一條接起來的序列切出來的)
check(sum(r["trades"] for r in doc["runs"]) == doc["oos_stats"]["Trades"],
      f"各輪交易次數加總 = 樣本外整段交易次數 → {sum(r['trades'] for r in doc['runs'])} vs {doc['oos_stats']['Trades']}")
# 報酬:各輪測試窗報酬複利 = 曲線終點
compounded = (math.prod(1 + r["test_return"] / 100 for r in doc["runs"]) - 1) * 100
check(abs(compounded - doc["oos"]["cum"][-1]) < 0.02,
      f"各輪測試窗報酬複利 = 曲線終點 → {compounded:.4f} vs {doc['oos']['cum'][-1]:.4f}")

# 樣本內平均只算有效輪,且分母是「選中格自己的 Sharpe」
train_ok = [r["train_sharpe"] for r in doc["runs"] if r["train_sharpe"] > 0]
check(doc["excluded_runs"] == [r["k"] for r in doc["runs"] if r["train_sharpe"] <= 0],
      f"excluded_runs = 訓練 Sharpe ≤ 0 的輪 → {doc['excluded_runs']}")
check(train_ok and abs(doc["is_stats"]["Sharpe Ratio"] - sum(train_ok) / len(train_ok)) < 5e-4,
      "is_stats Sharpe = 有效輪 train_sharpe 的平均(= 比較表樣本內那格 = WFE 分母)")
check(doc["wfe"] is None or abs(doc["wfe"] - doc["oos_stats"]["Sharpe Ratio"] / doc["is_stats"]["Sharpe Ratio"]) < 5e-4,
      f"wfe = 表上兩格相除 → {doc['wfe']}")

# 選參用鄰域平均、報告用格子自己的 Sharpe:分母必須對得起單格,不是 nbr_mean
wins_a, _tail, _total = _run_windows(df.index, LOOKBACK, STEP, WARMUP)
r1 = doc["runs"][0]
pos, exec_raw, cl, op, _ = _unpack(compute_signals(df, entry_th=r1["params"][0], exit_th=r1["params"][1]), df)
t0, t1, _t2 = wins_a[0]
cell = _window_stats(pos, exec_raw, cl, op, df.index, t0 + WARMUP, t1, 0.0005)
check(cell is not None and abs(cell[0] - r1["train_sharpe"]) < 5e-4,
      f"train_sharpe = 選中格自己的 Sharpe(重算對得上)→ {r1['train_sharpe']} vs {cell[0]:.4f}")

# …而且分母不是鄰域平均:重建第 1 輪的網格,選中格自己的 Sharpe ≠ 它的 nbr_mean
grid1 = np.full((len(ENTRY_VALS), len(EXIT_VALS)), np.nan)
for gi, ev in enumerate(ENTRY_VALS):
    for gj, xv in enumerate(EXIT_VALS):
        if not ev > xv:
            continue
        p2, e2, c2, o2, _ = _unpack(compute_signals(df, entry_th=ev, exit_th=xv), df)
        st = _window_stats(p2, e2, c2, o2, df.index, t0 + WARMUP, t1, 0.0005)
        if st:
            grid1[gi, gj] = st[0]
best1, nbr1, _br, _bc, _ns = find_plateau(grid1, ENTRY_VALS, EXIT_VALS)
check((ENTRY_VALS[best1[0]], EXIT_VALS[best1[1]]) == tuple(r1["params"]),
      f"選參用 find_plateau 的鄰域平均(重建網格選到同一格)→ {r1['params']}")
check(abs(nbr1[best1] - r1["train_sharpe"]) > 1e-6,
      f"報告用的是格子自己的 Sharpe,不是它的 nbr_mean({r1['train_sharpe']} vs 鄰域 {nbr1[best1]:.4f})")

# ── warmup 逐輪套用:第一輪訓練切片有被裁掉開頭 ────────────────────────────────
check(r1["train_start"] == df.index[WARMUP].strftime("%Y-%m-%d") != df.index[0].strftime("%Y-%m-%d"),
      f"第 1 輪訓練窗從第 {WARMUP} 根起算(開頭被裁掉)→ {r1['train_start']}")
untrimmed = _window_stats(pos, exec_raw, cl, op, df.index, t0, t1, 0.0005)
check(untrimmed is not None and abs(untrimmed[0] - cell[0]) > 1e-6,
      f"沒裁 warmup 的訓練 Sharpe 不一樣({untrimmed[0]:.4f} vs {cell[0]:.4f})→ 裁切確實有作用")
check(all(r["train_start"] > p["train_start"] and r["train_end"] > p["train_end"]
          for p, r in zip(doc["runs"], doc["runs"][1:])), "rolling:訓練窗頭尾都逐輪往前滾(不是 anchored)")
spans = {(pd.Timestamp(r["train_end"]) - pd.Timestamp(r["train_start"])).days for r in doc["runs"]}
check(max(spans) - min(spans) <= 1, f"每輪訓練窗等長(warmup 逐輪套用的結果)→ {sorted(spans)}")
check([r["test_start"] for r in doc["runs"][1:]] == [
      (pd.Timestamp(r["test_end"]) + pd.Timedelta(days=1)).strftime("%Y-%m-%d") for r in doc["runs"][:-1]],
      "測試窗首尾相接、不重疊(所以能接成一條)")

# ── 兩條分母護欄的 e2e:手續費吃掉每一輪 → 每輪訓練 Sharpe ≤ 0 ─────────────────
path_b = run_walk_forward(make_df(drift=-0.0004, seed=11), compute_signals, ENTRY_VALS, EXIT_VALS,
                          tmp, row_param="ENTRY_TH", col_param="EXIT_TH", fee=0.4,
                          lookback_days=LOOKBACK, step_days=STEP, warmup=WARMUP)
bad = json.load(open(path_b))
check(bad["excluded_runs"] == [r["k"] for r in bad["runs"] if r["train_sharpe"] <= 0]
      == [r["k"] for r in bad["runs"]], f"每輪訓練 Sharpe ≤ 0 → 全數判失敗 → {bad['excluded_runs']}")
check(bad["is_stats"]["Sharpe Ratio"] is None and bad["is_stats"]["Trades"] is None,
      f"沒有有效輪 → 樣本內那列畫 —(null,不是 0)→ {bad['is_stats']}")
check(bad["wfe"] is None, f"樣本內 Sharpe 不合格 → wfe = null(不做除法)→ {bad['wfe']}")
check(len(bad["runs"]) == bad["n_runs"] and bad["current"] is None
      and bad["oos_stats"]["Sharpe Ratio"] is not None,
      "被排除的輪照樣列在 runs[]、樣本外照算;沒傳 current → null")

# ── 輪數不足:不跑、不寫檔 ────────────────────────────────────────────────────
short_dir = tempfile.mkdtemp(prefix="wf-short-", dir=os.environ.get("SCRATCHPAD") or None)
try:
    run_walk_forward(make_df(days=330), compute_signals, ENTRY_VALS, EXIT_VALS, short_dir,
                     row_param="ENTRY_TH", col_param="EXIT_TH", fee=0.0005, lookback_days=240,
                     step_days=60, warmup=WARMUP)
    check(False, f"少於 {WF_MIN_RUNS} 輪要 raise")
except ValueError as e:
    check(str(WF_MIN_RUNS) in str(e) and "輪" in str(e), f"少於 {WF_MIN_RUNS} 輪要 raise 並講清楚只夠幾輪")
check(not os.path.exists(os.path.join(short_dir, "wf.json")), "輪數不足時不寫 wf.json")

# ── 整數 numpy 軸(SMA 長度)+ valid_fn:寫檔前要轉成原生型別 ─────────────────
def compute_sma(dfx, fast=5, slow=20):
    f = dfx["Close"].rolling(int(fast)).mean()
    s = dfx["Close"].rolling(int(slow)).mean()
    return (f > s).astype(float)


FAST, SLOW = np.arange(3, 9), np.arange(10, 40, 10)
path_i = run_walk_forward(df, compute_sma, FAST, SLOW, tmp, row_param="FAST", col_param="SLOW",
                          fee=0.0005, row_kw="fast", col_kw="slow", lookback_days=LOOKBACK,
                          step_days=STEP, warmup=30, valid_fn=lambda f, s: f < s,
                          current=(np.int64(5), np.int64(20)))
doci = json.load(open(path_i))
check(doci["row_vals"] == list(range(3, 9)) and doci["col_vals"] == [10, 20, 30],
      f"numpy 整數軸轉成原生 int(否則 json.dump 會在跑完之後才炸)→ {doci['row_vals']}")
check(all(isinstance(v, int) for v in doci["row_vals"] + doci["col_vals"] + doci["current"]),
      "軸值與 current 都是原生 int")
check(all(r["params"][0] in doci["row_vals"] and r["params"][1] > r["params"][0] for r in doci["runs"]),
      "valid_fn 有生效:每輪選到的 fast < slow")

# ── Type C(投組)也要跑得動 ──────────────────────────────────────────────────
def make_portfolio(days=700, seed=3):
    rng = np.random.default_rng(seed)
    idx = pd.date_range("2023-01-01", periods=days, freq="D")
    cols = ["AAA", "BBB"]
    rets = 0.0006 + 0.012 * rng.standard_normal((days, 2))
    close = pd.DataFrame(100 * np.cumprod(1 + rets, axis=0), index=idx, columns=cols)
    open_ = close / (1 + pd.DataFrame(rets, index=idx, columns=cols) / 2)
    return pd.concat({"close": close, "open": open_}, axis=1)


def compute_weights(price_df, entry_th=0.0, exit_th=0.0):
    close = price_df["close"]
    mom = close.pct_change(5).rolling(WARMUP).mean()
    w = ((mom > entry_th).astype(float) * 0.5 - (mom < exit_th).astype(float) * 0.0)
    return w.values, price_df


pf = make_portfolio()
path_c = run_walk_forward(pf, compute_weights, ENTRY_VALS, EXIT_VALS, tmp,
                          row_param="ENTRY_TH", col_param="EXIT_TH", fee=0.0005,
                          lookback_days=LOOKBACK, step_days=STEP, warmup=WARMUP)
docc = json.load(open(path_c))
check(set(docc) == KEYS and docc["n_runs"] == len(docc["runs"]) == 7, "Type C 走同一條路,契約一樣")
check(sum(r["trades"] for r in docc["runs"]) == docc["oos_stats"]["Trades"],
      "Type C:各輪交易次數加總 = 樣本外整段")
check(math.isfinite(docc["oos_stats"]["Sharpe Ratio"]) and len(docc["oos"]["cum"]) > 0,
      "Type C:樣本外統計與曲線都算得出來")

# 兩個回合可能同時寫同一支的 wf.json:tmp 帶 pid,不互相覆蓋或搶 os.replace
_replaced = []
_orig_replace = os.replace
os.replace = lambda a, b: (_replaced.append(a), _orig_replace(a, b))[1]
try:
    run_walk_forward(df, compute_signals, ENTRY_VALS, EXIT_VALS, tempfile.mkdtemp(),
                     row_param="ENTRY_TH", col_param="EXIT_TH", fee=0.0005,
                     lookback_days=LOOKBACK, step_days=STEP, warmup=WARMUP, current=(0.002, 0.0))
finally:
    os.replace = _orig_replace
check(any(x.endswith(f"wf.json.{os.getpid()}.tmp") for x in _replaced), "wf.json 的 tmp 檔名帶 pid")

# 舊碼防線:wf.json 帶開跑時那份碼的 code_hash;跑的期間 strategy.py 變了就不寫。裸 os.replace 換成 atomic_replace
import lib.walk_forward as _wf
from lib.strategy import code_hash as _code_hash
_wf_args = dict(row_param="ENTRY_TH", col_param="EXIT_TH", fee=0.0005, lookback_days=LOOKBACK, step_days=STEP, warmup=WARMUP, current=(0.002, 0.0))
_d = tempfile.mkdtemp()
with open(os.path.join(_d, "strategy.py"), "wb") as f:
    f.write(b"A = 1\n")
_used = []
_orig_atomic = getattr(_wf, "atomic_replace", None)
_wf.atomic_replace = lambda a, b: (_used.append(a), os.replace(a, b))[1]
try:
    _doc = json.load(open(run_walk_forward(df, compute_signals, ENTRY_VALS, EXIT_VALS, _d, **_wf_args)))
finally:
    if _orig_atomic:
        _wf.atomic_replace = _orig_atomic
check(_doc.get("code_hash") == _code_hash(b"A = 1\n"), "wf.json 帶那份碼的 code_hash")
check(bool(_used), "wf.json 走 atomic_replace(Windows 重試),不是裸 os.replace")
_d2 = tempfile.mkdtemp()
_src2 = os.path.join(_d2, "strategy.py")
with open(_src2, "wb") as f:
    f.write(b"A = 1\n")
def _edit_midway(*a, **k):
    with open(_src2, "wb") as f:
        f.write(b"A = 2\n")
    return compute_signals(*a, **k)
try:
    run_walk_forward(df, _edit_midway, ENTRY_VALS, EXIT_VALS, _d2, **_wf_args)
    _exited = False
except SystemExit:
    _exited = True
check(_exited and not os.path.exists(os.path.join(_d2, "wf.json")), "跑的期間 strategy.py 變了:拒寫、不留 wf.json")


# ── time limit inside an agent turn (spec typec-iterate-return-floor-2026-11-27 §9.4(a), §9.5) ──
import contextlib, io, time
import lib.walk_forward as _wfm
import lib.strategy as _S
import lib.progress as _prog

_TWS = tempfile.mkdtemp(prefix="wf-turn-", dir=os.environ.get("SCRATCHPAD") or None)
_S._REPO_ROOT = __import__("pathlib").Path(_TWS)
_CLK = [0.0]
_wfm_clock0 = getattr(_wfm, "_clock", None)
_wfm._clock = lambda: _CLK[0]
_ws0 = _wfm._window_stats
ROWS12 = [round(-0.01 + 0.002 * k, 10) for k in range(12)]
COLS10 = [round(-0.01 + 0.002 * k, 10) for k in range(10)]
_n = [0]


def turn_ledger(started_ago=0.0, write=True):
    tid = "f" * 16
    d = os.path.join(_TWS, "state", "iterate")
    os.makedirs(d, exist_ok=True)
    pth = os.path.join(d, tid + ".json")
    if write:
        with open(pth, "w") as f:
            json.dump({"v": 1, "turn": tid, "tier": "full", "started": time.time() - started_ago, "deadline": None,
                       "max_rounds": 10, "user_asked": False, "pid": None, "strategies": []}, f)
    elif os.path.exists(pth):
        os.remove(pth)
    os.environ["BLAVE_TURN_ID"] = tid


def timed_run(rows, cols, sig_s=1.0, win_s=0.0, turn=True, started_ago=0.0, ledger=True, old_wf=False, **kw):
    """run_walk_forward on a fake clock: each compute_signals call costs sig_s, each _window_stats win_s.
    Returns (doc or the exception, stdout, compute_signals calls)."""
    _n[0] += 1
    out_dir = os.path.join(_TWS, "strategies", f"wft{_n[0]}")
    os.makedirs(out_dir, exist_ok=True)
    if old_wf:
        with open(os.path.join(out_dir, "wf.json"), "w") as f:
            f.write('{"old": 1}')
    if turn:
        turn_ledger(started_ago, ledger)
    else:
        os.environ.pop("BLAVE_TURN_ID", None)
    _CLK[0] = time.time()
    calls = [0]

    def cs(d, entry_th=0.0, exit_th=0.0):
        calls[0] += 1
        _CLK[0] += sig_s
        return compute_signals(d, entry_th, exit_th)

    def ws(*a):
        _CLK[0] += win_s
        return _ws0(*a)

    _wfm._window_stats = ws
    kw.setdefault("valid_fn", lambda r, c: True)
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            p = run_walk_forward(df, cs, rows, cols, out_dir, row_param="ENTRY_TH", col_param="EXIT_TH", fee=0.0005,
                                 lookback_days=LOOKBACK, step_days=STEP, warmup=WARMUP, **kw)
        res = json.load(open(p))
    except BaseException as e:   # SystemExit included: the skip
        res = e
    finally:
        _wfm._window_stats = _ws0
        os.environ.pop("BLAVE_TURN_ID", None)
    return res, buf.getvalue(), calls[0], out_dir


def shape(res):
    return (len(res["row_vals"]), len(res["col_vals"])) if isinstance(res, dict) else None


# 1. inside a turn, estimate over 300 s → thinned, current kept, ≥ 5 per axis
cur = (ROWS12[3], COLS10[7])
res, out, _, _ = timed_run(ROWS12, COLS10, sig_s=3.0, current=cur)
check(isinstance(res, dict) and shape(res) != (12, 10) and min(shape(res)) >= 5
      and cur[0] in res["row_vals"] and cur[1] in res["col_vals"]
      and "Walk-forward grid thinned" in out and "Walk-forward estimate" in out,
      f"回合內估計超過 300 秒:格子抽稀、current 留著、每軸 ≥ 5、印了說明 → {shape(res)} {res if not isinstance(res, dict) else ''}")
# 2. coarsest still over → skipped, nothing written, the old wf.json untouched
res, out, _, od = timed_run(ROWS12, COLS10, sig_s=20.0, old_wf=True)
check(isinstance(res, SystemExit) and "❌ Walk-forward skipped" in str(res)
      and open(os.path.join(od, "wf.json")).read() == '{"old": 1}',
      f"最粗還超過:❌ skipped、不寫、舊的 wf.json 不動 → {res!r}")
# 3. max_seconds=None, estimate over 300 but inside the turn's time → full grid
res, out, _, _ = timed_run(ROWS12, COLS10, sig_s=3.0, max_seconds=None)
check(shape(res) == (12, 10), f"用戶要求(None)、估計 < 回合剩餘:不抽稀 → {shape(res)} {res if not isinstance(res, dict) else ''}")
# 4. max_seconds=None over the turn's time → skipped with the estimate; one whole turn too short → says so
res, out, _, od = timed_run(ROWS12, COLS10, sig_s=3.0, max_seconds=None, started_ago=1500, old_wf=True)
check(isinstance(res, SystemExit) and "this turn has" in str(res) and "usually fits" in str(res)
      and open(os.path.join(od, "wf.json")).read() == '{"old": 1}',
      f"用戶要求(None)、估計 > 回合剩餘:不抽稀、不寫、講估計(新一則通常跑得完)→ {res!r}")
res, out, _, _ = timed_run(ROWS12, COLS10, sig_s=20.0, max_seconds=None)
check(isinstance(res, SystemExit) and "does not fit in one turn" in str(res), f"一整個回合都跑不完 → 那句 → {res!r}")
# 5. outside a turn: no limit
res, out, _, _ = timed_run(ROWS12, COLS10, sig_s=20.0, turn=False)
check(shape(res) == (12, 10), f"回合外:估計再大也不抽稀、不跳過 → {shape(res)}")
# 6. cut to the turn's remaining time
res_a, _, _, _ = timed_run(ROWS12, COLS10, sig_s=1.5, started_ago=1750)
res_b, _, _, _ = timed_run(ROWS12, COLS10, sig_s=1.5, started_ago=0)
check(isinstance(res_a, dict) and shape(res_a) != (12, 10) and shape(res_b) == (12, 10),
      f"上限被回合剩餘時間截短(剩 100 秒抽稀、剛開始不抽)→ {shape(res_a)} / {shape(res_b)}")
# 7. a turn id without a ledger: None is 300 s
res, _, _, _ = timed_run(ROWS12, COLS10, sig_s=3.0, max_seconds=None, ledger=False)
check(isinstance(res, dict) and shape(res) != (12, 10), f"ledger 讀不到:None 當 300 秒 → {shape(res)}")
# 8. an axis with ≤ 5 values is neither thinned nor padded
ROWS4 = [0.0, 0.002, 0.004, 0.006]
COLS12 = [round(-0.012 + 0.001 * k, 10) for k in range(12)]
res, _, _, _ = timed_run(ROWS4, COLS12, sig_s=6.0)
check(isinstance(res, dict) and shape(res)[0] == 4 and 5 <= shape(res)[1] < 12,
      f"≤ 5 個值的軸不抽不補,只抽另一軸 → {shape(res)}")
res, _, _, _ = timed_run(ROWS12, [0], sig_s=20.0)
check(isinstance(res, dict) and shape(res)[1] == 1 and 5 <= shape(res)[0] < 12, f"單常數的一格第二軸不補 → {shape(res)}")
# 9. current None / off the axis: not forced in, no error
res_n, _, _, _ = timed_run(ROWS12, COLS10, sig_s=3.0, current=None)
res_o, _, _, _ = timed_run(ROWS12, COLS10, sig_s=3.0, current=(0.0031, COLS10[7]))
check(isinstance(res_n, dict) and isinstance(res_o, dict) and 0.0031 not in res_o["row_vals"] and COLS10[7] in res_o["col_vals"]
      and all(r["params"][0] in res_o["row_vals"] and r["params"][1] in res_o["col_vals"] for r in res_o["runs"]),
      "current 是 None 或不在軸上:不硬塞、不報錯;挑到的參數都在新格子上")
# 10. only valid cells count
res_h, _, _, _ = timed_run(ROWS12, COLS10, sig_s=3.0, valid_fn=lambda r, c: ROWS12.index(r) % 2 == 0)
check(shape(res_h) == (12, 10), f"估計只算 valid 的格:排掉一半就不用抽稀 → {shape(res_h)}")
# 11. Progress total follows the new grid
_seen = []
_P0 = _prog.Progress


class _RecP(_P0):
    def __init__(self, label, total, *a, **k):
        _seen.append((label, total))
        super().__init__(label, total, *a, **k)


_prog.Progress = _RecP
try:
    res, _, _, _ = timed_run(ROWS12, COLS10, sig_s=3.0)
finally:
    _prog.Progress = _P0
wf_tot = [t for lbl, t in _seen if lbl == "walk-forward"]
check(isinstance(res, dict) and wf_tot and wf_tot[-1] == shape(res)[0] * shape(res)[1],
      f"Progress 總數 = 新格子的組數 → {wf_tot} {shape(res)}")
# 12. Type A default: cells[0] is a corner that fails row > col — the estimate measures the first cell that runs
ROWS_C = [round(-0.012 + 0.002 * k, 10) for k in range(14)]
COLS_C = [round(-0.01 + 0.002 * k, 10) for k in range(12)]
res, out, _, _ = timed_run(ROWS_C, COLS_C, sig_s=0.05, win_s=1.0, valid_fn=None)
check(isinstance(res, dict) and shape(res) != (14, 12), f"角落那格不合 row > col:照樣量得到訓練窗的時間、抽得到稀 → {shape(res)} {res if not isinstance(res, dict) else ''}")
# 12b. the measured cell is not recomputed
res, _, calls, _ = timed_run(ROWS12, COLS10, sig_s=3.0)
winners = {tuple(r["params"]) for r in res["runs"]} if isinstance(res, dict) else set()
check(isinstance(res, dict) and calls == shape(res)[0] * shape(res)[1] + len(winners),
      f"量過的那組在新格子上不重算:呼叫次數 = 格數 + 不同贏家數 → {calls} vs {shape(res)} + {len(winners)}")
# 13. max_seconds must be positive or None
bad = []
for v in (0, -5, "300"):
    r_, _, _, _ = timed_run(ROWS4, COLS10[:3], sig_s=0.0, max_seconds=v)
    bad.append(isinstance(r_, ValueError))
check(all(bad), f"max_seconds 傳 0、負數、字串 → ValueError → {bad}")
if _wfm_clock0 is not None:
    _wfm._clock = _wfm_clock0

print("all checks passed" if not fails else f"FAILED: {fails}"); sys.exit(1 if fails else 0)
