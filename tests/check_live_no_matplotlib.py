"""A live tick never imports matplotlib; charts still come out on Agg with the CJK fonts.

lib/analysis.py loads pyplot on the first chart (_plt), so a Type A / C live tick, which draws
nothing, does not pay pyplot's import every bar. What the old top-level import gave every later
`import matplotlib.pyplot` in the same process now comes from lib/__init__.py (MPLBACKEND,
MATPLOTLIBRC → lib/matplotlibrc). Each case runs in a fresh interpreter:

  (1) examples/txf_ma_1m live tick (fetch stubbed, no network) → state.json written, and no
      matplotlib module loaded — someone putting a matplotlib import back on that path fails here;
  (2) MPLBACKEND / MATPLOTLIBRC unset: import lib.runner, then matplotlib.pyplot → lib/matplotlibrc
      is the rc file loaded, font.family starts with Noto Sans CJK TC, backend agg; its font list
      equals lib.analysis.CJK_FONTS;
  (3) plot_pnl writes a non-empty PNG;
  (4) half-updated workspace — the old empty lib/__init__.py and no lib/matplotlibrc beside the
      new analysis.py: plot_pnl still draws on Agg with the CJK fonts; MATPLOTLIBRC naming a
      missing file imports quietly.

Run: cd blave-agent && .venv/bin/python tests/check_live_no_matplotlib.py
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = tempfile.mkdtemp(prefix="live-no-mpl-")
CJK = "Noto Sans CJK TC"

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


def run_py(code, *args, path=ROOT, extra_env=None, cwd=TMP):
    env = {k: v for k, v in os.environ.items()
           if k not in ("MPLBACKEND", "MATPLOTLIBRC", "BLAVE_MODE", "BLAVE_AGENT_LOCAL")}
    env.update(extra_env or {})
    r = subprocess.run([sys.executable, "-c", code, path, *args], cwd=cwd, env=env,
                       capture_output=True, text=True, timeout=300)
    last = (r.stdout.strip().splitlines() or [""])[-1]
    try:
        out = json.loads(last)
    except ValueError:
        out = None
    return r, out


# ── (1) live tick ────────────────────────────────────────────────────────────────────────────
TICK = r'''
import json, os, runpy, socket, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
ws = sys.argv[2]
os.chdir(ws)
def _no_net(*a, **k):
    raise OSError("no network in this test")
socket.socket.connect = _no_net
socket.create_connection = _no_net
import numpy as np, pandas as pd
import lib.data, lib.runner
lib.runner._REPO_ROOT = Path(ws)
n = 30000
idx = pd.date_range("2025-01-02 00:45", periods=n, freq="min")
close = 20000 + 50 * np.sin(np.arange(n) / 900.0)
df = pd.DataFrame({"Open": close, "High": close + 1, "Low": close - 1, "Close": close,
                   "Volume": 1.0}, index=idx)
lib.data.fetch_twfutures_ohlcv = lambda *a, **k: df.copy()
lib.runner.tw_fetch_closes = lambda *a, **k: {}
runpy.run_path(os.path.join(ws, "strategies", "txf_ma_1m", "strategy.py"), run_name="__main__")
state = os.path.join(ws, "strategies", "txf_ma_1m", "state.json")
print(json.dumps({"mpl": sorted(m for m in sys.modules if m.split(".")[0] == "matplotlib"),
                  "state": json.load(open(state)) if os.path.exists(state) else None}))
'''
ws = os.path.join(TMP, "ws")
os.makedirs(os.path.join(ws, "strategies", "txf_ma_1m"))
os.makedirs(os.path.join(ws, "state"))
shutil.copy(os.path.join(ROOT, "examples", "txf_ma_1m", "strategy.py"),
            os.path.join(ws, "strategies", "txf_ma_1m", "strategy.py"))
ws_env = {k: ws for k in ("BLAVE_AGENT_HOME", "BLAVECLAW_HOME", "BLAVE_AGENT_BASE", "BLAVE_AGENT_WORKSPACE")}
r, out = run_py(TICK, ws, extra_env=dict(ws_env, BLAVE_MODE="live"))
check(r.returncode == 0 and out is not None, f"txf_ma_1m live tick runs → exit {r.returncode} {r.stderr[-600:]}")
if out:
    check(isinstance(out["state"], dict) and "position" in out["state"],
          f"the tick wrote state.json with a position → {out['state']}")
    check(out["mpl"] == [], f"no matplotlib module loaded by a live tick → {out['mpl'][:5]}")

# ── (2) side effects of the old import, from lib/__init__.py + lib/matplotlibrc ──────────────
RC = r'''
import json, sys
sys.path.insert(0, sys.argv[1])
import lib.runner
import matplotlib, matplotlib.pyplot as plt
print(json.dumps({"fname": matplotlib.matplotlib_fname(), "font": list(matplotlib.rcParams["font.family"]),
                  "backend": plt.get_backend().lower()}))
'''
r, out = run_py(RC)
check(r.returncode == 0 and out is not None, f"import lib.runner then pyplot → exit {r.returncode} {r.stderr[-400:]}")
if out:
    check(os.path.abspath(out["fname"]) == os.path.join(ROOT, "lib", "matplotlibrc"),
          f"the rc file loaded is lib/matplotlibrc → {out['fname']}")
    check(out["font"][:1] == [CJK], f"font.family starts with {CJK} → {out['font'][:2]}")
    check(out["backend"] == "agg", f"backend agg → {out['backend']}")

# lib's own charts get the rc file's list (_plt only fills in over matplotlib's default): the two copies stay one
rc_line = [l for l in open(os.path.join(ROOT, "lib", "matplotlibrc"), encoding="utf-8") if l.startswith("font.family:")]
sys.path.insert(0, ROOT)
from lib.analysis import CJK_FONTS  # noqa: E402
rc_fonts = [f.strip() for f in rc_line[0].split(":", 1)[1].split(",")] if rc_line else []
check(rc_fonts == CJK_FONTS, f"lib/matplotlibrc font.family == lib.analysis.CJK_FONTS → {rc_fonts}")

# ── (3) + (4) plot_pnl, with the full lib and with a half-updated one ────────────────────────
PLOT = r'''
import json, os, sys
sys.path.insert(0, sys.argv[1])
import numpy as np, pandas as pd
from lib.analysis import plot_pnl
import matplotlib
n = 300
idx = pd.date_range("2025-01-01", periods=n, freq="h")
df = pd.DataFrame({"Close": 100 + np.cumsum(np.sin(np.arange(n) / 9.0))}, index=idx)
pos = (np.sin(np.arange(n) / 20.0) > 0).astype(float)
cum = np.cumprod(1 + 0.001 * np.cos(np.arange(n) / 11.0))
out = sys.argv[2]
plot_pnl(df, {"cum": cum, "position": pos}, title="測試 PnL", output_path=out)
print(json.dumps({"size": os.path.getsize(out) if os.path.exists(out) else 0,
                  "font": list(matplotlib.rcParams["font.family"]),
                  "backend": matplotlib.get_backend().lower()}))
'''
png = os.path.join(TMP, "pnl.png")
r, out = run_py(PLOT, png)
check(r.returncode == 0 and out is not None and out["size"] > 0,
      f"plot_pnl writes a non-empty PNG → exit {r.returncode} {out} {r.stderr[-400:]}")

half = os.path.join(TMP, "half")
shutil.copytree(os.path.join(ROOT, "lib"), os.path.join(half, "lib"),
                ignore=shutil.ignore_patterns("__pycache__"))
open(os.path.join(half, "lib", "__init__.py"), "w").close()
os.remove(os.path.join(half, "lib", "matplotlibrc"))
png = os.path.join(TMP, "pnl_half.png")
r, out = run_py(PLOT, png, path=half)
check(r.returncode == 0 and out is not None and out["size"] > 0,
      f"half-updated (empty __init__, no rc file): plot_pnl writes a PNG → exit {r.returncode} {r.stderr[-400:]}")
if out:
    check(out["font"][:1] == [CJK] and out["backend"] == "agg",
          f"half-updated: still Agg + {CJK} → {out['backend']} {out['font'][:2]}")

r, out = run_py(RC, extra_env={"MATPLOTLIBRC": os.path.join(TMP, "missing", "matplotlibrc")})
check(r.returncode == 0 and out is not None and "matplotlibrc" not in r.stderr,
      f"MATPLOTLIBRC naming a missing file: imports quietly → exit {r.returncode} {r.stderr[-300:]}")

shutil.rmtree(TMP, ignore_errors=True)
print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
