"""Windows: a second strategy reading the same month file makes os.replace fail with WinError 5
(0.1.23, test machine 2: twfutures3_1m_TXF/2026-10.parquet, three failures in 11 minutes).
_atomic_to_parquet waits the reader out on Windows; POSIX keeps a single replace.

Simulates the PermissionError by patching os.replace, so it runs on macOS/Linux too:
  ① a few PermissionErrors then success → new frame on disk, no *.tmp left;
  ② PermissionError on every attempt → raises after the bounded attempts, old file intact;
  ③ any other OSError → raises at once, no wait;
  ④ POSIX default config → one attempt, no wait (behaviour unchanged).

Run: cd blave-agent && python3 tests/check_cache_replace_retry.py
"""
import os, shutil, sys, tempfile
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import pandas as pd  # noqa: E402
from lib import data, winreplace  # noqa: E402

fails = []


def t(name, ok, got=None):
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok or got is None else f"  → {got!r}"))
    if not ok:
        fails.append(name)


real_replace, real_sleep, real_delays = os.replace, data.time.sleep, winreplace.REPLACE_RETRY_DELAYS
WIN_DELAYS = (0.05, 0.1, 0.2, 0.4, 0.5)
d = Path(tempfile.mkdtemp(prefix="check-replace-retry-"))
old = pd.DataFrame({"close": [1.0]}, index=pd.DatetimeIndex(["2026-10-01"], name="ts"))
new = pd.DataFrame({"close": [1.0, 2.0]}, index=pd.DatetimeIndex(["2026-10-01", "2026-10-02"], name="ts"))


def run(fail_with, fail_times, delays):
    path = d / "2026-10.parquet"
    old.to_parquet(path)
    calls, sleeps = [], []

    def fake_replace(src, dst):
        calls.append(1)
        if len(calls) <= fail_times:
            raise fail_with(5, "Access is denied")
        real_replace(src, dst)

    winreplace.REPLACE_RETRY_DELAYS = delays
    os.replace = fake_replace
    data.time.sleep = sleeps.append
    err = None
    try:
        data._atomic_to_parquet(new, path)
    except OSError as e:
        err = e
    finally:
        os.replace, data.time.sleep, winreplace.REPLACE_RETRY_DELAYS = real_replace, real_sleep, real_delays
    return err, len(calls), sleeps, pd.read_parquet(path), list(d.glob("*.tmp"))


try:
    err, n, sleeps, got, tmps = run(PermissionError, 2, WIN_DELAYS)
    t("① transient PermissionError: write lands", err is None and got.equals(new), err)
    t("① two waits, then the third attempt wins", n == 3 and sleeps == [0.05, 0.1], (n, sleeps))
    t("① no tmp left", tmps == [], tmps)

    err, n, sleeps, got, tmps = run(PermissionError, 99, WIN_DELAYS)
    t("② persistent PermissionError raises", isinstance(err, PermissionError), err)
    t("② bounded: len(delays)+1 attempts, ~1.25s total",
      n == len(WIN_DELAYS) + 1 and abs(sum(sleeps) - 1.25) < 1e-9, (n, sleeps))
    t("② old file intact, no tmp left", got.equals(old) and tmps == [], (got, tmps))

    err, n, sleeps, got, tmps = run(FileNotFoundError, 99, WIN_DELAYS)
    t("③ other OSError raises at once", isinstance(err, FileNotFoundError) and n == 1 and sleeps == [],
      (err, n, sleeps))

    err, n, sleeps, got, tmps = run(PermissionError, 1, ())
    t("④ POSIX config: one attempt, error surfaces as before",
      isinstance(err, PermissionError) and n == 1 and sleeps == [] and got.equals(old), (err, n, sleeps))
    t("④ module default is () off Windows", os.name == "nt" or real_delays == (), real_delays)

    err, n, sleeps, got, tmps = run(PermissionError, 0, real_delays)
    t("normal path: write lands in one attempt", err is None and n == 1 and got.equals(new), err)
finally:
    shutil.rmtree(d, ignore_errors=True)

sys.exit(1 if fails else 0)
