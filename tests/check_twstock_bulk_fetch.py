"""台股 /bulk (one whole-market request per dataset) must be a pure transport change.

Pins, against an in-process fake api that answers /batch and /bulk from the same rows:
  1. daily (price_adj / price): a large warm universe takes its delta from ONE /bulk request,
     and the returned frames AND the cache files are value-for-value those of the /batch path;
  2. a small universe stays on /batch; an api without /bulk (404) or a /bulk error falls back
     to /batch with the same result; a 503 `building` is waited out (Retry-After + jitter,
     checked through the real _retry_get), then /batch; ids
     outside the bulk's `stock_ids`, or in its `failed`, are asked of /batch;
  3. BLAVE_FETCH_FRESH_SINCE (set by manager/wait_for_bar on the run after its check): a
     second fetch makes no request at all and returns the first one's frames;
  4. fundamentals (monthly revenue / ratios): a filing-day refresh of a large cached universe
     is one /bulk request whose recent rows are spliced onto the cached history — the frame
     (dtypes included) equals a full /batch re-read; the 30-day full re-read still happens
     on schedule, and an uncached or uncovered id goes to /batch;
  5. manager/wait_for_bar hands the check's start time to the strategy subprocess;
  6. the cache layer's per-id costs: the filing-due check is memoized without changing a
     single answer, and leftover-migration cleanup lists the cache dir once, not per id.
No network. Run: cd blave-agent && .venv/bin/python tests/check_twstock_bulk_fetch.py
"""
import os, shutil, sys, tempfile, time
from datetime import datetime, timedelta, timezone
from pathlib import Path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import pandas as pd
import requests
from lib import data as d

TMP = Path(tempfile.mkdtemp(prefix="twbulk-"))
d._CACHE_DIR = TMP / "cache"
REAL_RETRY_GET = d._retry_get
os.environ.pop("BLAVE_FETCH_FRESH_SINCE", None)

fails = 0
def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg); fails += (not cond)


class _R:
    def __init__(self, body): self._b = body
    def json(self): return self._b


def _404(url):
    resp = requests.Response(); resp.status_code = 404
    return requests.HTTPError(f"404 Client Error: NOT FOUND for url: {url}", response=resp)


NOW = datetime.now(timezone.utc).replace(tzinfo=None)
DAYS = [dd for dd in pd.bdate_range(NOW - timedelta(days=75), NOW).strftime("%Y-%m-%d")]
IDS = [str(1100 + i) for i in range(450)]          # ≥ _BULK_MIN_IDS
UNLISTED = "2311"                                 # delisted: outside the bulk universe


class Api:
    """Rows per (endpoint, id); /batch and /bulk filter them the same way the api does."""
    def __init__(self):
        self.rows, self.calls = {}, []
        self.bulk_mode = "ok"            # ok | 404 | error
        self.bulk_failed = set()

    def get(self, url, **kw):
        p = kw.get("params") or {}
        kind, endpoint = url.split("/")[-2:]
        self.calls.append((kind, endpoint))
        if kind == "bulk":
            if self.bulk_mode == "404":
                raise _404(url)
            if self.bulk_mode.startswith("building"):
                left = int(self.bulk_mode.split(":")[1])
                if left:
                    self.bulk_mode = f"building:{left - 1}"
                    resp = requests.Response(); resp.status_code = 503
                    resp._content = b'{"error": "Data temporarily unavailable.", "building": true}'
                    raise requests.HTTPError("503 Server Error", response=resp)
            if self.bulk_mode == "error":
                raise requests.ConnectionError("down")
            universe = sorted({sid for (ep, sid) in self.rows if ep == endpoint and sid != UNLISTED})
            data = {sid: rows for sid in universe if sid not in self.bulk_failed
                    for rows in [self._cut(endpoint, sid, p.get("start"), p.get("end"))] if rows}
            return _R({"data_type": endpoint, "stock_ids": universe, "data": data,
                       "failed": sorted(self.bulk_failed & set(universe))})
        ids = p["stock_ids"].split(",")
        data = {sid: rows for sid in ids
                for rows in [self._cut(endpoint, sid, p.get("start"), p.get("end"))] if rows}
        return _R({"data_type": endpoint, "data": data, "failed": []})

    def _cut(self, endpoint, sid, start, end):
        return [r for r in self.rows.get((endpoint, sid), [])
                if (not start or r["date"] >= start) and (not end or r["date"] <= end)]


def _price_rows(sid, days, bump=0.0):
    base = int(sid) % 97 + 10
    return [{"date": day, "stock_id": sid, "open": base + i * 0.5 + bump, "high": base + i * 0.5 + 1,
             "low": base + i * 0.5 - 1, "close": base + i * 0.5 + 0.25 + bump, "volume": 1000 + i,
             "spread": 0.5, "turnover_value": 99, "turnover_count": 3} for i, day in enumerate(days)]


def _snapshot(prefix):
    out = {}
    for f in sorted(d._CACHE_DIR.glob(f"{prefix}_*.parquet")):
        out[f.name] = pd.read_parquet(f)
    return out


def _same_frames(a, b):
    if set(a) != set(b):
        return False, f"keys differ: {sorted(set(a) ^ set(b))[:5]}"
    for k in a:
        try:
            pd.testing.assert_frame_equal(a[k], b[k], check_exact=True)
        except AssertionError as e:
            return False, f"{k}: {str(e)[:200]}"
    return True, ""


# ── 1-3. daily datasets ───────────────────────────────────────────────────────
api = Api()
d._retry_get = api.get
ALL = IDS + [UNLISTED]
for sid in ALL:
    api.rows[("price_adj", sid)] = _price_rows(sid, DAYS[:-2])
    api.rows[("price", sid)] = _price_rows(sid, DAYS[:-2])
START = DAYS[5]

d.fetch_twstock_price_adj_batch(ALL, START, None, {})      # cold: phase 2 via /batch
d.fetch_twstock_price_batch(ALL, START, None, {})
SEED = TMP / "seed"
shutil.copytree(d._CACHE_DIR, SEED)

# the next two trading days land, and the api revises one of yesterday's rows
for sid in ALL:
    api.rows[("price_adj", sid)] = _price_rows(sid, DAYS)
    api.rows[("price", sid)] = _price_rows(sid, DAYS)
api.rows[("price_adj", "1105")][-3]["close"] += 1.0


def _warm(mode, ids=ALL, fetch=d.fetch_twstock_price_adj_batch):
    shutil.rmtree(d._CACHE_DIR, ignore_errors=True)
    shutil.copytree(SEED, d._CACHE_DIR)
    api.calls.clear(); api.bulk_mode = mode
    out = fetch(ids, START, None, {})
    return out, list(api.calls)


old, old_calls = _warm("404")        # 404 on /bulk → exactly the old /batch path
old_files = _snapshot("twstock_price2")
new, new_calls = _warm("ok")
new_files = _snapshot("twstock_price2")
check(new_calls == [("bulk", "price_adj"), ("batch", "price_adj")],
      f"warm large universe: one /bulk request + one /batch for the id outside its universe ({new_calls[:4]})")
check(old_calls.count(("batch", "price_adj")) == 10 and old_calls[0] == ("bulk", "price_adj"),
      f"api without /bulk: one 404, then the 10 /batch chunks ({len(old_calls)} calls)")
same, why = _same_frames(old, new)
check(same, f"returned frames identical, value for value ({why})")
same, why = _same_frames(old_files, new_files)
check(same, f"cache files identical, value for value ({why})")
check(new["1105"]["Close"].iloc[-3] == old["1105"]["Close"].iloc[-3] and len(new["1105"]) == len(DAYS) - 5,
      "the revised row and the two new days are in")

err, err_calls = _warm("error")
same, _ = _same_frames(old, err)
check(same and err_calls.count(("batch", "price_adj")) == 10, "a /bulk error falls back to /batch, same frames")

raw_old, _ = _warm("404", fetch=d.fetch_twstock_price_batch)
raw_new, raw_calls = _warm("ok", fetch=d.fetch_twstock_price_batch)
same, why = _same_frames(raw_old, raw_new)
check(same and raw_calls == [("bulk", "price"), ("batch", "price")], f"price (raw) too: one /bulk, identical frames ({why})")

api.bulk_failed = {"1200"}
part, part_calls = _warm("ok")
api.bulk_failed = set()
same, why = _same_frames(old, part)
check(same and part_calls == [("bulk", "price_adj"), ("batch", "price_adj")],
      f"uncovered (delisted) and bulk-failed ids are asked of /batch, same frames ({part_calls}; {why})")

real_sleep, d.time.sleep = d.time.sleep, (lambda s: None)
busy, busy_calls = _warm("building:2")
same, why = _same_frames(old, busy)
check(same and busy_calls[:3] == [("bulk", "price_adj")] * 3,
      f"503 building (another machine's request is building it): waits and asks /bulk again ({busy_calls[:4]}; {why})")
real_wait, d._BULK_BUILDING_WAIT_S = d._BULK_BUILDING_WAIT_S, -1
stuck, stuck_calls = _warm("building:99")
d._BULK_BUILDING_WAIT_S, d.time.sleep = real_wait, real_sleep
same, why = _same_frames(old, stuck)
check(same and stuck_calls.count(("bulk", "price_adj")) == 1 and stuck_calls.count(("batch", "price_adj")) == 10,
      f"…and past the wait falls back to /batch, same frames ({len(stuck_calls)} calls; {why})")

small, small_calls = _warm("ok", ids=IDS[:30])
check(all(k == "batch" for k, _ in small_calls) and len(small_calls) == 1,
      f"a small universe stays on /batch ({small_calls})")

# 3. wait_for_bar's second fetch
shutil.rmtree(d._CACHE_DIR, ignore_errors=True); shutil.copytree(SEED, d._CACHE_DIR)
api.bulk_mode = "ok"
check_started = datetime.now(timezone.utc).replace(tzinfo=None).strftime(d._META_TS_FMT)
first = d.fetch_twstock_price_adj_batch(ALL, START, None, {})
api.calls.clear()
os.environ["BLAVE_FETCH_FRESH_SINCE"] = check_started
second = d.fetch_twstock_price_adj_batch(ALL, START, None, {})
os.environ.pop("BLAVE_FETCH_FRESH_SINCE")
same, why = _same_frames(first, second)
check(api.calls == [] and same, f"fresh-since: the run's fetch makes 0 requests, same frames ({api.calls[:3]}; {why})")
os.environ["BLAVE_FETCH_FRESH_SINCE"] = (datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(minutes=1)).strftime(d._META_TS_FMT)
d.fetch_twstock_price_adj_batch(ALL, START, None, {})
os.environ.pop("BLAVE_FETCH_FRESH_SINCE")
check(api.calls == [("bulk", "price_adj"), ("batch", "price_adj")], f"a cache older than fresh-since is asked again ({api.calls[:3]})")


# 3b. the 503 `building` path through the real _retry_get (only requests.get is faked)
real_get, real_sleep = d.requests.get, d.time.sleep
sleeps, sent = [], []


def _http(status, body, headers=None):
    resp = requests.Response()
    resp.status_code, resp._content = status, body.encode()
    resp.headers.update(headers or {})
    resp.url = "fake"
    return resp


def _get_building(n_busy, retry_after="7"):
    state = {"left": n_busy}

    def get(url, **kw):
        sent.append(url.split("/")[-2])
        if "/bulk/" in url and state["left"]:
            state["left"] -= 1
            return _http(503, '{"error": "Data temporarily unavailable.", "building": true}',
                         {"Retry-After": retry_after})
        return _http(200, __import__("json").dumps(api.get(url, **kw).json()))
    return get


try:
    d._retry_get = REAL_RETRY_GET
    d.time.sleep = sleeps.append
    d.requests.get = _get_building(2)
    shutil.rmtree(d._CACHE_DIR, ignore_errors=True); shutil.copytree(SEED, d._CACHE_DIR)
    api.bulk_mode = "ok"
    real_out = d.fetch_twstock_price_adj_batch(ALL, START, None, {})
    same, why = _same_frames(old, real_out)
    check(same and sent[:3] == ["bulk"] * 3,
          f"real _retry_get: two 503 building, then the body; same frames ({sent[:4]}; {why})")
    check(len(sleeps) == 2 and all(7 <= x <= 9 for x in sleeps),
          f"waits Retry-After (7 s) plus 0–2 s jitter each time, and no extra retry sleep ({sleeps})")
    sleeps.clear(); sent.clear()
    d.requests.get = _get_building(10 ** 6, retry_after="1")
    real_wait, d._BULK_BUILDING_WAIT_S = d._BULK_BUILDING_WAIT_S, 0.0
    shutil.rmtree(d._CACHE_DIR, ignore_errors=True); shutil.copytree(SEED, d._CACHE_DIR)
    stuck_out = d.fetch_twstock_price_adj_batch(ALL, START, None, {})
    d._BULK_BUILDING_WAIT_S = real_wait
    same, why = _same_frames(old, stuck_out)
    check(same and sent.count("bulk") == 1 and sent.count("batch") == 10 and sleeps == [],
          f"still building past the wait → /batch, same frames, no sleep ({sent.count('bulk')} bulk, {sleeps}; {why})")
    sleeps.clear(); sent.clear()
    d.requests.get = _get_building(10 ** 6, retry_after="8")
    shutil.rmtree(d._CACHE_DIR, ignore_errors=True); shutil.copytree(SEED, d._CACHE_DIR)
    capped_out = d.fetch_twstock_price_adj_batch(ALL, START, None, {})   # wait (90 s) not reached: sleep is faked
    same, why = _same_frames(old, capped_out)
    check(same and sent.count("bulk") == d._BULK_MAX_POLLS + 1 and len(sleeps) == d._BULK_MAX_POLLS
          and sent.count("bulk") * 4 * 2 < 60,
          f"poll cap: {d._BULK_MAX_POLLS} waits then /batch — 4 datasets × check+run stay under 60 / 5 min "
          f"({sent.count('bulk')} bulk requests; {why})")
finally:
    d._retry_get, d.requests.get, d.time.sleep = api.get, real_get, real_sleep


# ── 4. fundamentals ───────────────────────────────────────────────────────────
def _rev_rows(sid, months):
    return [{"date": m, "stock_id": sid, "country": "Taiwan", "create_time": f"{m[:8]}10",
             "revenue": (int(sid) * 1000 + i) * 1000, "revenue_month": int(m[5:7]),
             "revenue_year": int(m[:4])} for i, m in enumerate(months)]


def _ratio_rows(sid, quarters):
    # one ratio null throughout (a bank's gross margin), one null in old quarters only
    return [{"date": q, "stock_id": sid, "roe_ttm": round(int(sid) / 100 + i * 0.1, 4),
             "gross_margin_q": None, "fcf_q": None if i < 10 else float(i) * 1e6}
            for i, q in enumerate(quarters)]


MONTHS = list(pd.date_range("2010-01-01", NOW, freq="MS").strftime("%Y-%m-%d"))
QUARTERS = list(pd.date_range("2013-03-31", NOW, freq="QE").strftime("%Y-%m-%d"))
FIDS = IDS + [UNLISTED]
api = Api()
d._retry_get = api.get
for sid in FIDS:
    api.rows[("monthly_revenue", sid)] = _rev_rows(sid, MONTHS[:-1])
    api.rows[("ratios", sid)] = _ratio_rows(sid, QUARTERS[:-1])

shutil.rmtree(d._CACHE_DIR, ignore_errors=True)
d.fetch_twstock_monthly_revenue_batch(FIDS, {})
d.fetch_twstock_ratios_batch(FIDS, {})
FSEED = TMP / "fseed"
shutil.rmtree(FSEED, ignore_errors=True); shutil.copytree(d._CACHE_DIR, FSEED)

for sid in FIDS:                       # a filing lands, and last month's figure is restated
    api.rows[("monthly_revenue", sid)] = _rev_rows(sid, MONTHS)
    api.rows[("monthly_revenue", sid)][-2]["revenue"] += 7
    api.rows[("ratios", sid)] = _ratio_rows(sid, QUARTERS)

real_due = d._filing_due_since
d._filing_due_since = lambda prefix, written: True     # every cache file predates the filing


def _frefresh(mode, fetch, age_days=1):
    shutil.rmtree(d._CACHE_DIR, ignore_errors=True)
    shutil.copytree(FSEED, d._CACHE_DIR)
    stamp = time.time() - age_days * 86400
    for f in d._CACHE_DIR.glob("*.parquet"):
        os.utime(f, (stamp, stamp))
    api.calls.clear(); api.bulk_mode = mode
    return fetch(FIDS, {}), list(api.calls)


for name, fetch, endpoint in (("monthly revenue", d.fetch_twstock_monthly_revenue_batch, "monthly_revenue"),
                              ("ratios", d.fetch_twstock_ratios_batch, "ratios")):
    full, full_calls = _frefresh("404", fetch)
    bulk, bulk_calls = _frefresh("ok", fetch)
    same, why = _same_frames(full, bulk)
    check(same, f"{name}: spliced frame == a full /batch re-read, dtypes included ({why})")
    check(bulk_calls == [("bulk", endpoint), ("batch", endpoint)],
          f"{name}: one /bulk, and only the uncovered id on /batch ({bulk_calls})")
    if endpoint == "ratios":
        check(str(bulk["1100"]["gross_margin_q"].dtype) == "float64", "ratios: all-null column still float after the splice")
    # the next tick reads the spliced files as fresh, and they keep the old full-read stamp
    d._filing_due_since = real_due
    api.calls.clear()
    again = fetch(FIDS, {})
    same, _ = _same_frames(bulk, again)
    check(same and api.calls == [], f"{name}: next tick is a cache hit ({api.calls[:3]})")
    prefix = "twstock_rev" if endpoint == "monthly_revenue" else "twstock_ratios"
    path = d._fundamental_cache_path(prefix, "1100")
    check(time.time() - d._full_fetched_at(path) > 0.9 * 86400,
          f"{name}: the splice keeps the last full read's stamp")
    d._filing_due_since = lambda prefix, written: True
    old_full, old_calls = _frefresh("ok", fetch, age_days=31)
    check(all(k == "batch" for k, _ in old_calls) and old_calls,
          f"{name}: past 30 days since the full read → full /batch re-read, no /bulk ({old_calls[:2]})")
d._filing_due_since = real_due


# ── 5. wait_for_bar passes the check's start time on ──────────────────────────
import importlib.util
spec = importlib.util.spec_from_file_location(
    "wfb", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "manager", "wait_for_bar.py"))
wfb = importlib.util.module_from_spec(spec); spec.loader.exec_module(wfb)
seen = {}


class _Proc:
    pid, returncode = 4242, 0
    def __init__(self, args, **kw): seen["env"] = kw.get("env")
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def communicate(self, timeout=None): return "", ""


cwd = os.getcwd(); os.chdir(TMP)
try:
    wfb.subprocess.Popen = _Proc
    wfb._lock_note_child = lambda *a: None
    wfb._fetched_since = datetime(2026, 10, 15, 9, 30, 5)
    wfb._run_strategy_protected("s")
    check((seen["env"] or {}).get("BLAVE_FETCH_FRESH_SINCE") == "2026-10-15T09:30:05",
          f"wait_for_bar: the run gets BLAVE_FETCH_FRESH_SINCE = the check's start ({(seen['env'] or {}).get('BLAVE_FETCH_FRESH_SINCE')})")
    wfb._fetched_since = None
    wfb._run_strategy_protected("s")
    check(seen["env"] is None, "wait_for_bar: no check (fetched_since unset) → the environment is untouched")
finally:
    os.chdir(cwd)

# ── 6. the cache layer's own per-id costs ───────────────────────────────────
def _filing_due_reference(prefix, written_epoch):      # the pre-memo implementation, verbatim
    rules = {'twstock_rev':  ('MS', (d._revenue_available, d._revenue_available_insurance)),
             'twstock_fin':  ('QS', (d._quarterly_report_available, d._quarterly_report_available_finance)),
             'twstock_bs':   ('QS', (d._quarterly_report_available, d._quarterly_report_available_finance)),
             'twstock_ratios': ('QS', (d._quarterly_report_available, d._quarterly_report_available_finance))}
    if prefix not in rules:
        return False
    freq, fns = rules[prefix]
    now = pd.Timestamp.now(tz='Asia/Taipei')
    written = pd.Timestamp(written_epoch, unit='s', tz='UTC').tz_convert('Asia/Taipei')
    stamps = pd.date_range((written - pd.Timedelta(days=400)).normalize().tz_localize(None),
                           now.normalize().tz_localize(None), freq=freq).tz_localize('Asia/Taipei')
    return any(((fn(stamps) > written) & (fn(stamps) <= now)).any() for fn in fns)


grid = [time.time() - h * 3600 for h in range(0, 24 * 450, 5)]
diff = [(p, e) for p in ("twstock_rev", "twstock_ratios", "twstock_fin", "twstock_inst")
        for e in grid if d._filing_due_since(p, e) != _filing_due_reference(p, e)]
check(not diff, f"memoized filing-due check == the original on {len(grid) * 4} (prefix, written) pairs ({diff[:3]})")

shutil.rmtree(d._CACHE_DIR, ignore_errors=True)
d._CACHE_DIR.mkdir(parents=True)
d._LEFTOVERS.clear()
frame = pd.DataFrame({"Close": [1.0]}, index=pd.to_datetime(["2026-10-01"]))
for i in range(40):
    d._write_single("twstock_price2", {"id": str(5000 + i)}, frame,
                    {"from": "2026-10", "to": "2026-10", "tail_fetched_at": "2026-10-02T00:00:00"})
stale = d._monthly_cache_dir("twstock_price2", {"id": "5003"})
(stale.parent / f"{stale.name}.migrating.999").mkdir()
stale.mkdir()
listings = []
real_scandir = d.os.scandir
d.os.scandir = lambda path: listings.append(path) or real_scandir(path)
try:
    for i in range(40):
        d._read_single("twstock_price2", {"id": str(5000 + i)})
finally:
    d.os.scandir = real_scandir
check(not stale.exists() and not (stale.parent / f"{stale.name}.migrating.999").exists(),
      "a leftover monthly dir and .migrating.<pid> dir next to a single file are still removed")
cache_listings = [x for x in listings if not isinstance(x, int) and Path(x) == stale.parent]
check(len(cache_listings) == 1, f"the cache dir is listed once for 40 ids, not once per id ({len(cache_listings)})")

shutil.rmtree(TMP, ignore_errors=True)
print("ALL PASS" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
