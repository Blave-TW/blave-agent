"""Minimal check for fetch_kline_batch on the Binance source (desktop): symbols fetched side by
side must not race on the cache's tmp files (a repeated symbol on a cold cache threw
FileNotFoundError 24 times in 30 — audit 0.1.7 P1-1), must keep Binance at ≤10 requests in
flight, must stop at the first failure, and stay one-at-a-time for 1m bars (memory).
No network. Run: cd blave-agent && .venv/bin/python tests/check_kline_batch_parallel.py
"""
import os, shutil, sys, tempfile, threading, time
from pathlib import Path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["BLAVE_KLINE_SOURCE"] = "binance"
import pandas as pd
from lib import data as d

import contextlib


@contextlib.contextmanager
def guard(seconds, label):
    """A case that hangs is a failure, not a stuck test (review: with the dedupe removed the batch
    deadlocked instead of going red). A pool thread that never returns cannot be interrupted from
    Python, so the watchdog reports and ends the process itself."""
    def fire():
        print(f"  FAIL  {label}: 卡住超過 {seconds} 秒(判紅)", flush=True)
        import faulthandler
        faulthandler.dump_traceback(all_threads=True)
        os._exit(1)
    t = threading.Timer(seconds, fire)
    t.daemon = True
    t.start()
    try:
        yield
    finally:
        t.cancel()


fails = 0
def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg); fails += (not cond)

STEP = {"1h": 3_600_000, "1m": 60_000}
live, peak, calls, lock = [0], [0], [], threading.Lock()
BAD = set()

class _R:
    status_code, headers, text = 200, {}, ""
    def __init__(self, page): self._p = page
    def json(self): return self._p
    def raise_for_status(self): pass

def fake_get(url, params=None, timeout=None):
    with lock:
        live[0] += 1; peak[0] = max(peak[0], live[0]); calls.append(params["symbol"])
    try:
        if params["symbol"] in BAD:
            raise ValueError(f"bad symbol {params['symbol']}")
        time.sleep(0.02)
        step = STEP[params["interval"]]
        t, end = params["startTime"], params["endTime"]
        page = []
        while t <= end and len(page) < params["limit"]:
            page.append([t, "1", "2", "0.5", "1.5", "10", t + step - 1, "0", 1, "0", "0", "0"])
            t += step
        return _R(page)
    finally:
        with lock:
            live[0] -= 1

d.requests.get = fake_get
# The real limiter (400 pages/min) is what made this test look stuck: a dozen cold rounds are ~900
# fake pages, so it slept for minutes. Pacing is not under test here; in-flight concurrency is.
d._BINANCE_LIMITER = d._RateLimiter(10 ** 6, 60)

def cold():
    tmp = Path(tempfile.mkdtemp(prefix="kb-"))
    d._CACHE_DIR = tmp
    return tmp

# 1. repeated symbol on a cold cache, many rounds
errors = []
with guard(120, "重複 symbol＋冷快取"):
  for i in range(12):
      c = cold()
      try:
          out = d.fetch_kline_batch(["BTCUSDT", "BTC/USDT", "BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT"], "1h", "2025-01-01", "2026-06-30", {})
          if set(out) != {"BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT"} or any(len(v) == 0 for v in out.values()):
              errors.append(f"round {i}: keys {sorted(out)}")
      except Exception as e:
          errors.append(f"round {i}: {type(e).__name__}: {e}")
      shutil.rmtree(c, ignore_errors=True)
check(not errors, f"重複 symbol＋冷快取 12 輪:不撞暫存檔、每個 symbol 都有資料" + ("" if not errors else f" — {errors[:2]}"))

# 2. in-flight cap and the batch really runs side by side
check(4 < peak[0] <= 10, f"Binance 同時在飛的請求 ≤10(實際最高 {peak[0]})")
check(len(set(calls)) == 5 and calls.count("BTCUSDT") == calls.count("ETHUSDT"),
      "重複的 BTC 只抓一次(去重後才平行)")

real_sem = d._BINANCE_INFLIGHT
d._BINANCE_INFLIGHT = threading.BoundedSemaphore(3); peak[0] = 0
c = cold()
with guard(60, "在飛上限"):
    d.fetch_kline_batch(["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"], "1h", "2025-01-01", "2026-06-30", {})
shutil.rmtree(c, ignore_errors=True)
check(1 < peak[0] <= 3 and real_sem._initial_value == 10, f"在飛上限由同一個 semaphore 管(設 3 → 最高 {peak[0]});正式值 10")
d._BINANCE_INFLIGHT = real_sem

# 3. first failure stops the rest
c = cold(); calls.clear(); BAD.add("ETHUSDT")
t0 = time.time()
try:
  with guard(60, "第一個壞就停"):
    d.fetch_kline_batch(["ETHUSDT"] + [f"C{i}USDT" for i in range(40)], "1h", "2026-03-01", "2026-06-30", {})
    check(False, "壞 symbol 應該丟例外")
except ValueError as e:
    started = len({s for s in calls if s != "ETHUSDT"})
    check("bad symbol ETHUSDT" in str(e) and started < 40, f"第一個壞就停:例外照原樣丟出、後面沒排的不再抓(抓了 {started}/40)")
BAD.clear(); shutil.rmtree(c, ignore_errors=True)

# 4. 1m bars stay one symbol at a time
c = cold()
seen = []
real = d.fetch_kline
def spy(sid, *a, **k):
    seen.append((sid, threading.get_ident())); return real(sid, *a, **k)
d.fetch_kline = spy
with guard(60, "1m 逐一抓"):
    d.fetch_kline_batch(["BTCUSDT", "ETHUSDT", "SOLUSDT"], "1m", "2026-06-01", "2026-06-02", {})
d.fetch_kline = real
check(len({t for _, t in seen}) == 1, "1m:逐一抓(一年 1m 原始資料約 360 MB/檔,不同時抓四檔)")
shutil.rmtree(c, ignore_errors=True)

# 5. tmp name carries the thread
check(str(threading.get_ident()) in d._tmp_path(Path("/x/2026-05.parquet")).name, "暫存檔名帶執行緒 id")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
