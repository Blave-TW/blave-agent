"""Windows: a strategy reading a month file while a second strategy's os.replace swaps it (or
Defender scans it) gets PermissionError Errno 13 (third interpreter round:
cache\\twfutures3_1m_TXF\\2026-10.parquet via fetch_twfutures_ohlcv → _extend_cache_monthly).
fetch_data then failed and the manager parked the 1m strategy for 300 s. The cache reads now
wait it out with the writer's _REPLACE_RETRY_DELAYS; POSIX keeps a single read.

Simulates the PermissionError by patching pd.read_parquet / pq.read_schema, so it runs anywhere:
  ① current-month read: PermissionError once, then data comes back through _extend_cache_monthly;
  ② past-month schema read: same, through the batched past-month path;
  ③ PermissionError on every attempt → raises after len(delays)+1 tries;
  ④ other OSError → raises at once, no wait;
  ⑤ POSIX config (no delays) → one attempt, error surfaces as before.

Run: cd blave-agent && python3 tests/check_cache_read_retry.py
"""
import os, shutil, sys, tempfile
from datetime import datetime
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import pandas as pd  # noqa: E402
from lib import data  # noqa: E402

fails = []


def t(name, ok, got=None):
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok or got is None else f"  → {got!r}"))
    if not ok:
        fails.append(name)


WIN_DELAYS = (0.05, 0.1, 0.2, 0.4, 0.5)
real = dict(read_parquet=data.pd.read_parquet, read_schema=data.pq.read_schema,
            sleep=data.time.sleep, delays=data._REPLACE_RETRY_DELAYS, cache=data._CACHE_DIR)
d = Path(tempfile.mkdtemp(prefix="check-read-retry-"))
data._CACHE_DIR = d
cur = datetime.utcnow().strftime("%Y-%m")
frame = pd.DataFrame({"close": [1.0, 2.0]},
                     index=pd.DatetimeIndex([f"{cur}-01 00:00", f"{cur}-01 00:01"], name="ts"))


def flaky(fn, fail_with, fail_times, calls):
    def wrapped(*a, **kw):
        calls.append(1)
        if len(calls) <= fail_times:
            raise fail_with(13, "Permission denied")
        return fn(*a, **kw)
    return wrapped


def run(target, fail_with, fail_times, delays, call):
    calls, sleeps = [], []
    data._REPLACE_RETRY_DELAYS = delays
    data.time.sleep = sleeps.append
    if target == "parquet":
        data.pd.read_parquet = flaky(real["read_parquet"], fail_with, fail_times, calls)
    else:
        data.pq.read_schema = flaky(real["read_schema"], fail_with, fail_times, calls)
    out = err = None
    try:
        out = call()
    except OSError as e:
        err = e
    finally:
        data.pd.read_parquet, data.pq.read_schema = real["read_parquet"], real["read_schema"]
        data.time.sleep, data._REPLACE_RETRY_DELAYS = real["sleep"], real["delays"]
    return out, err, len(calls), sleeps


try:
    cdir = data._monthly_cache_dir("twfutures3", {"id": "TXF", "period": "1m"})
    cdir.mkdir(parents=True)
    frame.to_parquet(cdir / f"{cur}.parquet")
    present = lambda: data._extend_cache_monthly(
        "twfutures3", {"id": "TXF", "period": "1m"}, lambda s, e: pd.DataFrame(), f"{cur}-01", None)

    out, err, n, sleeps = run("parquet", PermissionError, 1, WIN_DELAYS, present)
    t("① current month: transient PermissionError, data comes back",
      err is None and out is not None and len(out) == 2, err)
    t("① one wait, second attempt wins", n == 2 and sleeps == [0.05], (n, sleeps))

    pdir = data._monthly_cache_dir("kline3", {"symbol": "X", "period": "1h"})
    pdir.mkdir(parents=True)
    pframe = pd.DataFrame({"close": [3.0]}, index=pd.DatetimeIndex(["2025-01-05"], name="ts"))
    pframe.to_parquet(pdir / "2025-01.parquet")
    os.utime(pdir / "2025-01.parquet", (1739000000, 1739000000))   # written after the month ended
    past = lambda: data._extend_cache_monthly(
        "kline3", {"symbol": "X", "period": "1h"}, lambda s, e: pd.DataFrame(), "2025-01-01", "2025-01-31")
    out, err, n, sleeps = run("schema", PermissionError, 1, WIN_DELAYS, past)
    t("② past month schema read: transient PermissionError, data comes back",
      err is None and out is not None and len(out) == 1, err)

    out, err, n, sleeps = run("parquet", PermissionError, 99, WIN_DELAYS, present)
    t("③ persistent PermissionError raises", isinstance(err, PermissionError), err)
    t("③ bounded: len(delays)+1 attempts, ~1.25s total",
      n == len(WIN_DELAYS) + 1 and abs(sum(sleeps) - 1.25) < 1e-9, (n, sleeps))

    out, err, n, sleeps = run("parquet", FileNotFoundError, 99, WIN_DELAYS, present)
    t("④ other OSError raises at once", isinstance(err, FileNotFoundError) and n == 1 and sleeps == [],
      (err, n, sleeps))

    out, err, n, sleeps = run("parquet", PermissionError, 1, (), present)
    t("⑤ POSIX config: one attempt, error surfaces as before",
      isinstance(err, PermissionError) and n == 1 and sleeps == [], (err, n, sleeps))
    t("⑤ module default is () off Windows", os.name == "nt" or real["delays"] == (), real["delays"])
finally:
    data._CACHE_DIR = real["cache"]
    shutil.rmtree(d, ignore_errors=True)

sys.exit(1 if fails else 0)
