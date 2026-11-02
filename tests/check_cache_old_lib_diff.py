"""Updating the lib must not change the past: one seeded-hole cache replayed through the lib before
the rollover fixes (cb4dd64a) and this one, same fake api, same fixed clocks, including a rollover.

Pins: every row before the update month is equal in every series at every step, file contents
before that month are equal, and until the first rollover the requests are the same.
Needs the old commit in history; a shallow clone prints SKIP. No network.
Run: cd blave-agent && .venv/bin/python tests/check_cache_old_lib_diff.py
"""
import hashlib, os, pickle, shutil, subprocess, sys, tempfile
from datetime import datetime, timezone
from pathlib import Path

OLD = "cb4dd64a"
ROOT = Path(__file__).resolve().parent.parent
STEPS = (("update", datetime(2026, 11, 15, 3), "2026-11-15"), ("later", datetime(2026, 11, 20, 3), "2026-11-20"),
         ("rollover", datetime(2026, 12, 1, 0, 5), "2026-11-30 23:00"), ("grace", datetime(2026, 12, 1, 0, 20), "2026-12-01"),
         ("after", datetime(2026, 12, 9, 3), "2026-12-09"))


def replay(root, out_path):
    sys.path.insert(0, root)
    import pandas as pd
    from lib import data as d
    assert d.__file__.startswith(root), d.__file__
    tmp = Path(tempfile.mkdtemp(prefix="cachediff-"))
    d._CACHE_DIR = tmp / "cache"
    os.environ.update(BLAVE_KLINE_SOURCE="blave", BLAVE_TWSTOCK_DAILY_SOURCE="blave")
    os.environ.pop("BLAVE_FETCH_FRESH_SINCE", None)

    class Clock(datetime):
        at = STEPS[0][1]

        @classmethod
        def utcnow(cls):
            return cls.at

        @classmethod
        def now(cls, tz=None):
            return cls.at if tz is None else cls.at.replace(tzinfo=timezone.utc).astimezone(tz)

    d.datetime = Clock

    def mtimes():
        return {p: p.stat().st_mtime_ns for p in d._CACHE_DIR.rglob("*.parquet")}

    def at(when, fn, *a, **kw):
        Clock.at = when
        before = mtimes()
        try:
            return fn(*a, **kw)
        finally:
            ts = when.replace(tzinfo=timezone.utc).timestamp()
            for p, ns in mtimes().items():
                if before.get(p) != ns:
                    os.utime(p, (ts, ts))

    def bars(s, e, f):
        return pd.date_range(s, e, freq=f, inclusive="left")

    def seed(prefix, params, idx, written, cols=("Open", "High", "Low", "Close", "Volume")):
        mdir = d._monthly_cache_dir(prefix, params)
        mdir.mkdir(parents=True, exist_ok=True)
        idx = pd.DatetimeIndex(idx)
        path = mdir / f"{idx[0]:%Y-%m}.parquet"
        pd.DataFrame({c: 1.0 for c in cols}, index=idx).to_parquet(path)
        ts = written.replace(tzinfo=timezone.utc).timestamp()
        os.utime(path, (ts, ts))

    published, calls = [None], []

    class R:
        def __init__(self, body): self.body = body
        def json(self): return self.body

    def get(url, **kw):
        p = kw["params"]
        calls.append((url.split("/")[-1][:24], p.get("start_date", p.get("start")), p.get("end_date", p.get("end"))))
        if "kline/batch" in url:
            f = url.split("period=")[1]
            ts = [t for t in bars("2026-01-01", "2027-01-01", f)
                  if pd.Timestamp(p["start_date"]) <= t < pd.Timestamp(p["end_date"]) + pd.Timedelta(days=1) and t < published[0]]
            rows = [{"time": int(t.timestamp()), "open": 2., "high": 2., "low": 2., "close": 2., "volume": 2.} for t in ts]
            return R({"data": {s: rows for s in p["symbols"].split(",")}, "failed": []})
        ids = p["stock_ids"].split(",")
        rows = [{"date": str(t.date()), "open": 2., "close": 2.} for t in pd.bdate_range(p["start"], p["end"]) if t < published[0]]
        return R({"data": {i: rows for i in ids}, "failed": []})

    def raw(s, e):
        calls.append(("raw", s, e))
        ts = [t for t in bars("2026-01-01", "2027-01-01", "1h") if pd.Timestamp(s) <= t < pd.Timestamp(e) and t < published[0]]
        return pd.DataFrame({"alpha": 2.0}, index=pd.DatetimeIndex(ts))

    d._retry_get = get
    syms = ["BTCUSDT", "ETHUSDT"]
    gap = bars("2026-08-01", "2026-09-01", "1h")
    for s in syms:
        seed("kline3_1h", {"id": s}, gap[(gap < "2026-08-10") | (gap >= "2026-08-12")], datetime(2026, 9, 5))
        seed("kline3_1h", {"id": s}, bars("2026-09-21", "2026-10-01", "1h"), datetime(2026, 10, 3))
        seed("kline3_1h", {"id": s}, bars("2026-10-01", "2026-10-31 22:00", "1h"), datetime(2026, 11, 1, 0, 1))
        seed("kline3_1h", {"id": s}, bars("2026-11-01", "2026-11-14", "1h"), datetime(2026, 11, 14))
    alpha = {"symbol": "BTCUSDT", "period": "1h"}
    seed("whale_hunter", alpha, bars("2026-09-01", "2026-09-30", "1h"), datetime(2026, 10, 1, 0, 1), ("alpha",))
    seed("whale_hunter", alpha, bars("2026-10-01", "2026-10-31 22:00", "1h"), datetime(2026, 11, 1, 0, 1), ("alpha",))
    seed("whale_hunter", alpha, bars("2026-11-01", "2026-11-14", "1h"), datetime(2026, 11, 14), ("alpha",))
    txf = {"symbol": "TXF"}
    seed("twfutures3_5m", txf, bars("2026-09-01", "2026-09-29", "1h"), datetime(2026, 10, 1, 0, 1), ("Close",))
    seed("twfutures3_5m", txf, bars("2026-10-01", "2026-10-30", "1h"), datetime(2026, 11, 1, 2), ("Close",))
    seed("twfutures3_5m", txf, bars("2026-11-01", "2026-11-14", "1h"), datetime(2026, 11, 14), ("Close",))
    days = pd.DatetimeIndex([t for t in pd.bdate_range("2026-05-01", "2026-11-13") if str(t.date()) not in ("2026-09-29", "2026-09-30")])
    meta = {"from": "2026-05", "to": "2026-11", "tail_fetched_at": "2026-11-13T12:00:00"}
    d._write_single("twstock_inst", {"id": "2330"}, pd.DataFrame({"foreign_net": 1.0}, index=days), dict(meta))
    for s in ("2317", "2454"):
        d._write_single("twstock_price3", {"id": s}, pd.DataFrame({"Open": 1., "Close": 1.}, index=days), dict(meta))

    steps = {}
    for label, when, last in STEPS:
        published[0] = pd.Timestamp(last)
        calls.clear()
        frames = {}
        for s, df in at(when, d.fetch_kline_batch, syms, "1h", "2026-08-01", None, {}).items():
            frames[f"batch {s}"] = df
        frames["alpha"] = at(when, d._extend_cache_monthly, "whale_hunter", alpha, raw, "2026-09-01", None)
        frames["txf"] = at(when, d._extend_cache_monthly, "twfutures3_5m", txf, raw, "2026-09-01", None)
        for s, df in at(when, d.fetch_twstock_price_adj_batch, ["2317", "2454"], "2026-05-01", None, {}).items():
            frames[f"tw {s}"] = df
        files = {str(p.relative_to(d._CACHE_DIR)): hashlib.sha1(pd.read_parquet(p).to_csv().encode()).hexdigest()
                 for p in sorted(d._CACHE_DIR.rglob("*.parquet"))}
        steps[label] = (frames, list(calls), files)
    with open(out_path, "wb") as f:
        pickle.dump(steps, f)
    shutil.rmtree(tmp, ignore_errors=True)


def main():
    import pandas as pd
    fails = 0

    def check(cond, msg):
        nonlocal fails
        print(("  PASS  " if cond else "  FAIL  ") + msg); fails += (not cond)

    if subprocess.run(["git", "cat-file", "-e", f"{OLD}^{{commit}}"], cwd=ROOT, capture_output=True).returncode:
        print(f"SKIP  {OLD} is not in this clone")
        return 0
    tmp = Path(tempfile.mkdtemp(prefix="cachediff-lib-"))
    archive = subprocess.run(["git", "archive", OLD, "lib"], cwd=ROOT, capture_output=True, check=True).stdout
    subprocess.run(["tar", "-x", "-C", str(tmp)], input=archive, check=True)
    runs = {}
    for name, root in (("old", str(tmp)), ("new", str(ROOT))):
        out = tmp / f"{name}.pkl"
        r = subprocess.run([sys.executable, __file__, "--replay", root, str(out)], capture_output=True, text=True)
        if r.returncode:
            print(r.stdout[-800:], r.stderr[-800:])
        check(r.returncode == 0, f"{name} lib replays")
        runs[name] = pickle.loads(out.read_bytes())
    cut = pd.Timestamp("2026-11-01")
    for label, _, _ in STEPS:
        fo, co, xo = runs["old"][label]
        fn, cn, xn = runs["new"][label]
        same = all(fo[k][fo[k].index.tz_localize(None) < cut if fo[k].index.tz else fo[k].index < cut].equals(
                   fn[k][fn[k].index.tz_localize(None) < cut if fn[k].index.tz else fn[k].index < cut]) for k in fo)
        check(same and set(fo) == set(fn), f"{label}: every row before the update month is equal")
        older = [k for k in xo if "2026-11" not in k and "2026-12" not in k and k.count("/")]
        check(older and all(xo[k] == xn[k] for k in older), f"{label}: month files before it are equal ({len(older)})")
        if label in ("update", "later"):
            check(co == cn, f"{label}: the same requests ({len(co)} vs {len(cn)})")
    shutil.rmtree(tmp, ignore_errors=True)
    print("ALL PASS" if not fails else f"{fails} FAILED")
    return 1 if fails else 0


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--replay":
        replay(sys.argv[2], sys.argv[3])
    else:
        sys.exit(main())
