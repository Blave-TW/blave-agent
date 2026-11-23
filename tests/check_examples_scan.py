"""examples/*/scan.py that call scan_until_interior run end to end on synthetic data — they are the
pattern references/lib.md points the agent to, so a broken one is copied into user strategies.
No network: fetch is stubbed, .env is never read (dotenv stubbed, cwd is a temp dir), Telegram / web
image sends are stubbed. Each script runs in a copy of its folder, so nothing is written under examples/.
Run: cd blave-agent && .venv/bin/python tests/check_examples_scan.py
"""
import json, os, runpy, shutil, sys, tempfile
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("MPLBACKEND", "Agg")
for k in ("BLAVE_TURN_ID", "BLAVE_TURN_PID"):
    os.environ.pop(k, None)
import numpy as np
import pandas as pd
import dotenv
import lib.data, lib.notify, lib.iterate

fails = 0
def check(cond, msg, detail=""):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg + ("" if cond or not detail else f"  → {detail}"))
    fails += (not cond)

dotenv.dotenv_values = lambda *a, **k: {}
lib.notify.send_photo = lambda *a, **k: None
lib.notify.report_photo_web = lambda *a, **k: None
noted = []
lib.iterate.note_params = lambda name, n: noted.append(n)

rng = np.random.default_rng(3)

def ohlc(n, freq):
    idx = pd.date_range("2023-01-01", periods=n, freq=freq)
    c = pd.Series(100 + np.cumsum(np.sin(np.arange(n) / 120.0) + rng.normal(0, 0.4, n)), index=idx)
    return pd.DataFrame({"Open": c.shift(1).fillna(100.0), "High": c + 1, "Low": c - 1, "Close": c, "Volume": 1.0}, index=idx)

def sma_data():
    lib.data.fetch_kline = lambda *a, **k: ohlc(1500, "4h")

def ti_data(s):
    df = ohlc(3000, "5min")
    df["TI"] = np.sin(np.arange(len(df)) / 200.0) + 1.0 + rng.normal(0, 0.2, len(df))
    s.fetch_data = lambda hdrs: df

def broker_data(s):
    df = ohlc(700, "D")
    df.attrs["branch_df"] = pd.DataFrame(rng.normal(0, 1, (len(df), 12)), index=df.index)
    s.fetch_data = lambda hdrs: df

CASES = [("btc_sma_cross", None), ("btc_ti_5min", ti_data), ("tw2317_broker_zscore", broker_data)]
cwd = os.getcwd()
for name, prep in CASES:
    work = tempfile.mkdtemp(prefix="ex-scan-", dir=os.environ.get("SCRATCHPAD") or None)
    sdir = os.path.join(work, "strategies", name)
    shutil.copytree(os.path.join(ROOT, "examples", name), sdir)
    sys.modules.pop("strategy", None)
    sys.path.insert(0, sdir)
    os.chdir(work)
    noted.clear()
    try:
        import strategy as s
        sma_data() if prep is None else prep(s)
        runpy.run_path(os.path.join(sdir, "scan.py"), run_name="__main__")
        doc = json.load(open(os.path.join(sdir, "scan.json")))
        cells = sum(v is not None for row in doc["grid"] for v in row)
        check(len(doc["row_vals"]) <= 40 and len(doc["col_vals"]) <= 40 and os.path.exists(os.path.join(sdir, "heatmap.png")),
              f"{name}: scan.py 跑完、寫出 scan.json 與 heatmap")
        check(len(noted) == 1 and noted[0] >= cells, f"{name}: write_scan 收到 evaluated(含延伸)", (noted, cells))
    except BaseException as e:
        check(False, f"{name}: scan.py 用合成資料跑不完", f"{type(e).__name__}: {e}")
    finally:
        os.chdir(cwd)
        sys.path.remove(sdir)
        shutil.rmtree(work, ignore_errors=True)

print("all checks passed" if not fails else f"FAILED: {fails}"); sys.exit(1 if fails else 0)
