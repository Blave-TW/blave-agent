"""Windows: the cache writers outside _atomic_to_parquet still did a bare os.replace, so a
reader holding the target (another strategy, Defender) failed the fetch with WinError 5:
_write_single (one-file daily caches), _write_market_file (twstock_public_market.json),
_tw_cdn_write (CDN file + .meta.json). They now go through lib/winreplace.atomic_replace.

Simulates the PermissionError by patching os.replace, so it runs anywhere:
  ① each writer: PermissionError once → file lands, no *.tmp left;
  ② POSIX config (no delays) → the error surfaces as before, no *.tmp left.

Run: cd blave-agent && python3 tests/check_cache_write_retry.py
"""
import json, os, shutil, sys, tempfile
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


WIN_DELAYS = (0.05, 0.1, 0.2, 0.4, 0.5)
real_replace, real_sleep, real_delays, real_cache = (
    os.replace, data.time.sleep, winreplace.REPLACE_RETRY_DELAYS, data._CACHE_DIR)
d = Path(tempfile.mkdtemp(prefix="check-write-retry-"))
data._CACHE_DIR = d
META = {"from": "2026-10-01", "to": "2026-10-01", "tail_fetched_at": "2026-10-21T00:00:00"}
frame = pd.DataFrame({"close": [1.0]}, index=pd.DatetimeIndex(["2026-10-01"], name="ts"))


def run(write, fail_times, delays):
    calls = []

    def fake_replace(src, dst):
        calls.append(1)
        if len(calls) <= fail_times:
            raise PermissionError(5, "Access is denied")
        real_replace(src, dst)

    winreplace.REPLACE_RETRY_DELAYS = delays
    os.replace, data.time.sleep = fake_replace, (lambda s: None)
    err = None
    try:
        write()
    except OSError as e:
        err = e
    finally:
        os.replace, data.time.sleep, winreplace.REPLACE_RETRY_DELAYS = real_replace, real_sleep, real_delays
    return err, list(d.rglob("*.tmp"))


writers = {
    "_write_single": (
        lambda: data._write_single("twstock_x", {"id": "2330"}, frame, META),
        lambda: data._read_single_meta("twstock_x", {"id": "2330"}) == META),
    "_write_market_file": (
        lambda: data._write_market_file({"twse": ["2330"]}),
        lambda: json.loads(data._tw_market_file().read_text()) == {"twse": ["2330"]}),
    "_tw_cdn_write": (
        lambda: data._tw_cdn_write(data._tw_cdn_dir() / "manifest.json", b'{"a": 1}', {"etag": "e"}),
        lambda: (data._tw_cdn_dir() / "manifest.json").read_bytes() == b'{"a": 1}'
        and data._tw_cdn_meta(data._tw_cdn_dir() / "manifest.json") == {"etag": "e"}),
}

try:
    for name, (write, landed) in writers.items():
        err, tmps = run(write, 1, WIN_DELAYS)
        t(f"① {name}: transient PermissionError, file lands", err is None and landed(), err)
        t(f"① {name}: no tmp left", tmps == [], tmps)
    for name, (write, _) in writers.items():
        err, tmps = run(write, 1, ())
        t(f"② {name}: POSIX config, error surfaces as before",
          isinstance(err, PermissionError) and tmps == [], (err, tmps))
finally:
    data._CACHE_DIR = real_cache
    shutil.rmtree(d, ignore_errors=True)

sys.exit(1 if fails else 0)
