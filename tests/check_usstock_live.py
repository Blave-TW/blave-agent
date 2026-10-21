"""US daily signals live on the desktop and the cloud, traded on the stock's crypto perp (NVDA → NVDAUSDT).

  lib.data gate (fetch_usstock_price on a live tick, BLAVE_MODE=live):
  - passes, desktop and cloud alike, only inside us_live_strategy(name, SYMBOL), for a strategy routed
    to a crypto exchange or paper whose SYMBOL is the ticker's Binance EQUITY perp
  - refused (UsStockNotHere, the reason in Chinese, no request to Yahoo): no scope (an
    older runner); no venue; a TW broker; Type C (no SYMBOL); bare 'NVDA'; another stock's perp;
    a coin; SPY beside NVDAUSDT
  - Binance's list or the 下單設定 unreadable → UsStockUnavailable (a failed round), no request
  - backtests, chat and scheduled reports (desktop and cloud) need no scope, as before — but a live
    scope inside a scheduled report (its run.py calling lib.runner.run) is gated; the pass does not outlive the
    call (a private Yahoo fetcher on the same live tick is refused afterwards)
  runner (lib.runner.run, live):
  - a NVDAUSDT strategy on Binance writes state.json {symbol: NVDAUSDT} from the Yahoo bars
  - Yahoo and yfinance both failing → the tick raises, state.json is byte-identical (the
    position is held, never read as flat)
  wait_for_bar:
  - a US-only daily strategy expects the latest NYSE session whose bar is final (17:00 New York,
    daylight saving followed — it runs then, not at the next UTC midnight): weekends and NYSE
    holidays (Good Friday, Thanksgiving, Juneteenth, the Friday before a Saturday 4 July) are
    skipped — no fetch, no alert, a wait left behind is cleared; Columbus Day trades
  - a crypto daily strategy keeps the plain calendar floor
  - the freshness probe runs fetch_data inside us_live_strategy(<folder name>, SYMBOL)
  - Yahoo down during the probe → the strategy_failed alert ends with 「美股日線這輪抓不到…部位
    維持原樣」 (the event keeps the last 500 characters), the run is not started, state.json untouched;
    it is flagged transient, so the alert says the next run retries instead of "will likely repeat"
    (a UsStockNotHere refusal is not transient)
  paper: NVDAUSDT fills at Binance's last trade (lib.paper_data); its once-a-day collision check
    reads the strategy's own Yahoo close in the reconciler's env (desktop flag, no BLAVE_MODE), so
    no live scope is needed there
No network: the raw Yahoo / yfinance fetchers, lib.stock_perps.binance_rows and
lib.paper_data._binance_last are stubbed.

Run: cd blave-agent && MPLBACKEND=Agg .venv/bin/python tests/check_usstock_live.py
"""
import importlib.util
import json
import os
import sys
import tempfile
from datetime import datetime as _dt
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("MPLBACKEND", "Agg")

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

import lib.data as D  # noqa: E402
import lib.runner as runner  # noqa: E402
import lib.stock_perps as sp  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


WS = Path(tempfile.mkdtemp(prefix="usstock-live-"))
os.chdir(WS)
(WS / "manager").mkdir()
CFG = WS / "manager" / "portfolio_config.json"
D._CACHE_DIR = Path(tempfile.mkdtemp(prefix="usstock-live-cache-"))
ROWS = {"NVDAUSDT": ("EQUITY", "NVDA"), "AAPLUSDT": ("EQUITY", "AAPL"), "BTCUSDT": ("COIN", "BTC")}
sp.binance_rows = lambda: ROWS

days = pd.bdate_range("2026-06-01", "2026-10-16")
close = 100 + np.cumsum(np.sin(np.arange(len(days)) / 5.0))
RAW = pd.DataFrame({"Open": close, "High": close + 1, "Low": close - 1, "Close": close,
                    "AdjClose": close, "Volume": 1e6}, index=pd.DatetimeIndex(days, name="date"))
calls = []


def yahoo_ok(sym):
    calls.append(("yahoo", sym))
    return RAW.copy()


def source_down(label):
    def f(sym):
        calls.append((label, sym))
        raise D.UsStockUnavailable(f"{label} down")
    return f


D._fetch_usstock_yahoo_raw = yahoo_ok
D._fetch_usstock_yfinance_raw = source_down("yfinance")


def route(name, venue):
    CFG.write_text(json.dumps({"amounts": {name: 100}, "exchanges": {name: venue} if venue else {}}))


def env(local=True, mode="live", scheduled=False):
    for k in ("BLAVE_AGENT_LOCAL", "BLAVE_MODE", "BLAVE_SCHEDULED_RUN"):
        os.environ.pop(k, None)
    if local:
        os.environ["BLAVE_AGENT_LOCAL"] = "1"
    if mode:
        os.environ["BLAVE_MODE"] = mode
    if scheduled:
        os.environ["BLAVE_SCHEDULED_RUN"] = "1"


def fetch(ticker="NVDA", scope=("us_nvda", "NVDAUSDT")):
    calls.clear()
    for p in D._CACHE_DIR.glob("usstock_daily_*"):
        p.unlink()
    try:
        if scope is None:
            return D.fetch_usstock_price(ticker, "2026-09-01", None), None
        with D.us_live_strategy(*scope):
            return D.fetch_usstock_price(ticker, "2026-09-01", None), None
    except Exception as e:
        return None, e


# ── the gate ─────────────────────────────────────────────────────────────────
env()
for venue in ("binance", "bingx", "okx", "gateio", "bybit", "paper"):
    route("us_nvda", venue)
    df, err = fetch()
    check(err is None and df is not None and len(df) and calls == [("yahoo", "NVDA")],
          f"desktop live tick, NVDA → NVDAUSDT routed to {venue}: fetched ({err!r})")
env(local=False)
for venue in ("binance", "bingx", "paper"):
    route("us_nvda", venue)
    df, err = fetch()
    check(err is None and df is not None and len(df) and calls == [("yahoo", "NVDA")],
          f"cloud live tick (no BLAVE_AGENT_LOCAL), NVDA → NVDAUSDT routed to {venue}: fetched ({err!r})")

route("us_nvda", "binance")
cases = (
    ("no scope (older runner)", {}, "NVDA", None, "沒有標明"),
    ("cloud, no scope", dict(local=False), "NVDA", None, "沒有標明"),
    ("cloud, bare SYMBOL 'NVDA'", dict(local=False), "NVDA", ("us_nvda", "NVDA"), "NVDAUSDT"),
    ("bare SYMBOL 'NVDA'", {}, "NVDA", ("us_nvda", "NVDA"), "NVDAUSDT"),
    ("another stock's perp (AAPLUSDT)", {}, "NVDA", ("us_nvda", "AAPLUSDT"), "對不上"),
    ("a coin (BTCUSDT)", {}, "BTC", ("us_nvda", "BTCUSDT"), "不是 Binance 的股票永續"),
    ("SPY beside NVDAUSDT", {}, "SPY", ("us_nvda", "NVDAUSDT"), "SPY"),
    ("Type C (no SYMBOL)", {}, "NVDA", ("us_nvda", None), "Type C"),
)
for label, kw, ticker, scope, word in cases:
    env(**kw)
    df, err = fetch(ticker, scope)
    check(isinstance(err, D.UsStockNotHere) and word in str(err) and calls == [],
          f"refused, no request: {label} ({err!r})")
env()
for venue, word in ((None, "還沒綁交易所"), ("capital", "台灣期貨商"), ("president", "台灣期貨商")):
    route("us_nvda", venue)
    df, err = fetch()
    check(isinstance(err, D.UsStockNotHere) and word in str(err) and calls == [],
          f"refused, no request: routed to {venue} ({err!r})")
route("us_nvda", "binance")
sp.binance_rows = lambda: None
df, err = fetch()
check(isinstance(err, D.UsStockUnavailable) and not isinstance(err, D.UsStockNotHere) and calls == [],
      f"Binance exchangeInfo unreadable: a failed round (UsStockUnavailable), no request ({err!r})")
sp.binance_rows = lambda: ROWS
CFG.write_text("{not json")
df, err = fetch()
check(isinstance(err, D.UsStockUnavailable) and not isinstance(err, D.UsStockNotHere) and calls == [],
      f"下單設定 unreadable: a failed round, no request ({err!r})")
route("us_nvda", "binance")
MIRROR = WS / "manager" / "amounts.ui.json"
MIRROR.write_text(json.dumps({"amounts": {"us_nvda": 100}, "exchanges": {"us_nvda": "capital"}}))
df, err = fetch()
check(isinstance(err, D.UsStockNotHere) and "台灣期貨商" in str(err),
      f"the UI mirror's routing wins over the config's, as lib.portfolio reads it ({err!r})")
MIRROR.unlink()

for label, kw in (("chat / backtest (no BLAVE_MODE)", dict(mode=None)), ("BLAVE_MODE=backtest", dict(mode="backtest")),
                  ("desktop scheduled report", dict(scheduled=True)),
                  ("cloud chat / backtest", dict(local=False, mode=None)),
                  ("cloud scheduled report", dict(local=False, scheduled=True))):
    env(**kw)
    df, err = fetch(scope=None)
    check(err is None and calls == [("yahoo", "NVDA")], f"{label}: fetched without a scope ({err!r})")
for local in (True, False):  # a report's run.py running a picked strategy live is a tick
    where = "desktop" if local else "cloud"
    env(local=local, scheduled=True)
    df, err = fetch(scope=("us_nvda", "NVDA"))
    check(isinstance(err, D.UsStockNotHere) and "NVDAUSDT" in str(err) and calls == [],
          f"{where} scheduled report, live scope, bare SYMBOL 'NVDA': refused, no request ({err!r})")
    df, err = fetch()
    check(err is None and calls == [("yahoo", "NVDA")],
          f"{where} scheduled report, live scope, NVDAUSDT on binance: fetched ({err!r})")

env()
fetch()
try:
    D._yahoo_session()
    check(False, "the pass ends with the call")
except D.UsStockNotHere:
    check(True, "the pass ends with the call: a private Yahoo fetcher on the same live tick is refused after it")

# ── runner live tick ─────────────────────────────────────────────────────────
runner._REPO_ROOT = WS
NAME = "us_nvda"
STATE = WS / "strategies" / NAME / "state.json"
STATE.parent.mkdir(parents=True, exist_ok=True)
CONFIG = {"STRATEGY_NAME": NAME, "SYMBOL": "NVDAUSDT", "INTERVAL": "1d", "START": "2026-06-01",
          "FEE": 0.0005, "MCPT": False}


def fetch_data(hdrs):
    return D.fetch_usstock_price("NVDA", "2026-06-01", None)


def compute(df):
    return pd.Series(1.0, index=df.index)


env()
route(NAME, "binance")
calls.clear()
for p in D._CACHE_DIR.glob("usstock_daily_*"):
    p.unlink()
err = None
try:
    runner.run(CONFIG, fetch_data, compute, send_telegram_fn=None)
except BaseException as e:
    err = e
st = json.loads(STATE.read_text()) if STATE.exists() else {}
check(err is None and st.get("symbol") == "NVDAUSDT" and st.get("position") == 1 and calls == [("yahoo", "NVDA")],
      f"runner live tick: state.json carries NVDAUSDT, position 1, from the Yahoo bars ({err!r}, {st})")

before = STATE.read_bytes()
D._fetch_usstock_yahoo_raw = source_down("yahoo")
for p in D._CACHE_DIR.glob("usstock_daily_*"):
    p.unlink()
err = None
try:
    runner.run(CONFIG, fetch_data, lambda df: pd.Series(0.0, index=df.index), send_telegram_fn=None)
except BaseException as e:
    err = e
check(isinstance(err, D.UsStockUnavailable) and STATE.read_bytes() == before,
      f"Yahoo and yfinance down: the tick fails, state.json byte-identical (held, not flat) ({err!r})")
D._fetch_usstock_yahoo_raw = yahoo_ok

# ── wait_for_bar ─────────────────────────────────────────────────────────────
spec = importlib.util.spec_from_file_location("wfb_us", os.path.join(ROOT, "manager", "wait_for_bar.py"))
wfb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wfb)
D_ = pd.Timestamp
for day, want, label in (("2026-10-17", "2026-10-16", "Saturday → Friday"),
                         ("2026-10-18", "2026-10-16", "Sunday → Friday"),
                         ("2026-10-12", "2026-10-12", "Columbus Day trades"),
                         ("2026-04-03", "2026-04-02", "Good Friday → Thursday"),
                         ("2026-11-26", "2026-11-25", "Thanksgiving → Wednesday"),
                         ("2026-06-19", "2026-06-18", "Juneteenth → Thursday"),
                         ("2026-07-03", "2026-07-02", "Friday before a Saturday 4 July → Thursday"),
                         ("2027-12-31", "2027-12-31", "the Friday before a Saturday New Year trades")):
    got = wfb._us_last_session(_dt.fromisoformat(day))
    check(got == _dt.fromisoformat(want), f"_us_last_session {day}: {label} (got {got.date()})")

STRAT = ('STRATEGY_NAME = "{n}"\nINTERVAL = "1d"\nSYMBOL = "{s}"\nfrom lib.data import {f}\n\n'
         'def fetch_data(headers):\n    return {f}({t!r}, "2026-06-01", None)\n')
(WS / "strategies" / NAME / "strategy.py").write_text(STRAT.format(n=NAME, s="NVDAUSDT", f="fetch_usstock_price", t="NVDA"))
(WS / "strategies" / "btc_d").mkdir(parents=True, exist_ok=True)
(WS / "strategies" / "btc_d" / "strategy.py").write_text(STRAT.format(n="btc_d", s="BTCUSDT", f="fetch_kline", t="BTCUSDT"))
check(wfb._us_stock_daily(NAME) and not wfb._us_stock_daily("btc_d"), "_us_stock_daily: US-only prices yes, crypto no")

probes, runs, alerts = [], [], []
real_probe = wfb._check_freshness


class _Now(_dt):
    at = None

    @classmethod
    def now(cls, tz=None):
        return cls.at.replace(tzinfo=tz) if tz else cls.at


class _Alerts:
    @staticmethod
    def alert(name, code, output, **kw):
        alerts.append((name, code, output, kw))


wfb.datetime = _Now
wfb._alert_failure = lambda: _Alerts
wfb._run_strategy_protected = lambda name: runs.append(name) or True
wfb._check_freshness = lambda mod, expected: probes.append((mod.STRATEGY_NAME, expected)) or (expected, True, None, {"": expected})


def tick(name, at, last=None, pending=None):
    probes.clear(), runs.clear(), alerts.clear()
    st_path = WS / "state" / "bar_wait" / f"{name}.json"
    st_path.parent.mkdir(parents=True, exist_ok=True)
    st_path.write_text(json.dumps({**wfb._default_state(), "last_processed_bar": last,
                                   "pending_since": pending, "stall_alert_at": 1.0 if pending else None}))
    _Now.at = _dt.fromisoformat(at)
    wfb._tick(name)
    return json.loads(st_path.read_text())


st = tick(NAME, "2026-11-27T00:30", last="2026-11-25T00:00:00", pending="2026-11-27T00:01:00")
check(probes == [] and alerts == [] and st["pending_since"] is None and st["stall_alert_at"] is None,
      f"Thanksgiving (Fri 00:30 UTC expects Thu): skipped to Wed, no fetch, no alert, the old wait cleared ({probes}, {st})")
st = tick(NAME, "2026-10-19T00:30", last="2026-10-16T00:00:00")
check(probes == [] and alerts == [], f"Monday 00:30 UTC (expects Sunday): Friday already ran, no fetch ({probes})")
st = tick(NAME, "2026-10-20T00:30", last="2026-10-16T00:00:00")
check(probes == [(NAME, _dt(2026, 10, 19))] and runs == [NAME] and st["last_processed_bar"] == "2026-10-19T00:00:00",
      f"Tuesday 00:30 UTC: Monday's session is probed and run ({probes}, {runs})")
st = tick(NAME, "2026-10-19T20:55", last="2026-10-16T00:00:00")
check(probes == [], f"Monday 16:55 New York: Monday's bar is not final, Friday already ran, no fetch ({probes})")
st = tick(NAME, "2026-10-19T21:05", last="2026-10-16T00:00:00")
check(probes == [(NAME, _dt(2026, 10, 19))] and runs == [NAME],
      f"Monday 17:05 New York (21:05 UTC, daylight saving): Monday's session runs now, not at UTC midnight ({probes})")
st = tick(NAME, "2026-11-23T22:05", last="2026-11-20T00:00:00")
check(probes == [(NAME, _dt(2026, 11, 23))], f"winter: Monday 17:05 New York is 22:05 UTC ({probes})")
st = tick(NAME, "2026-11-23T21:55", last="2026-11-20T00:00:00")
check(probes == [], f"winter: 21:55 UTC is 16:55 New York, not final yet ({probes})")
fin = D.FEED_TIMING["usstock_price"]["available"](pd.DatetimeIndex(["2026-10-19"]).tz_localize("America/New_York"))[0]
check(wfb._US_FINAL_HOUR == fin.hour and fin.minute == 0,
      f"wait_for_bar's 17:00 New York is FEED_TIMING['usstock_price'] ({wfb._US_FINAL_HOUR} vs {fin})")
st = tick("btc_d", "2026-10-19T00:30", last="2026-10-17T00:00:00")
check(probes == [("btc_d", _dt(2026, 10, 18))], f"crypto daily on Monday: expects Sunday as before ({probes})")


def probe_down(mod, expected):
    raise D.UsStockUnavailable("NVDA: no US daily bars this time — Yahoo: down; yfinance: down")


wfb._check_freshness = probe_down
st_file = WS / "strategies" / NAME / "state.json"
before = st_file.read_bytes()
st = tick(NAME, "2026-10-21T00:30", last="2026-10-19T00:00:00")
check(len(alerts) == 1 and alerts[0][1] == "fetch_error" and "美股日線這輪抓不到" in alerts[0][2][-500:]
      and "部位維持原樣" in alerts[0][2][-500:] and runs == [] and st["last_attempt_failed_at"]
      and st["last_processed_bar"] == "2026-10-19T00:00:00" and st_file.read_bytes() == before,
      f"Yahoo down at the probe: one fetch_error alert whose last 500 chars say the position is held, no run, state.json untouched ({alerts[:1]})")
check(alerts[0][3] == {"transient": True}, f"…flagged transient: the alert must not also say the error repeats every run ({alerts[0][3]})")


def probe_refused(mod, expected):
    raise D.UsStockNotHere(D._us_not_live("「us_nvda」還沒綁交易所"))


wfb._check_freshness = probe_refused
st = tick(NAME, "2026-10-21T00:30", last="2026-10-19T00:00:00")
check(len(alerts) == 1 and alerts[0][3] == {"transient": False} and "稍後自動重試" not in alerts[0][2],
      f"a routing refusal (UsStockNotHere) repeats every run: not transient, no 'retries later' line ({alerts[:1]})")

# the real alert text: transient says the next run retries; the default keeps "will likely repeat"
import lib.events as _events  # noqa: E402
import lib.notify as _notify  # noqa: E402
from manager import alert_failure as _af  # noqa: E402
sent, _cwd, _send, _emit = [], os.getcwd(), _notify.send_text, _events.emit
_notify.send_text = lambda m, *a, **k: sent.append(m)
emitted = []
_events.emit = lambda ev, **k: emitted.append((ev, k))   # no event file outside the temp workspace
os.chdir(WS)
try:
    for flag in (True, False):
        state_file = WS / "strategies" / NAME / "failure_alert_state.json"
        if state_file.exists():
            state_file.unlink()
        _af.alert(NAME, "fetch_error", "boom", transient=flag)
finally:
    os.chdir(_cwd)
    _notify.send_text = _send
    _events.emit = _emit
check(len(sent) == 2 and "likely repeat" not in sent[0] and "tries again automatically" in sent[0]
      and "likely repeat" in sent[1] and "tries again" not in sent[1],
      f"alert_failure: transient → 'tries again automatically', never 'will likely repeat'; default unchanged ({sent})")
check([(e, k.get("transient")) for e, k in emitted] == [("strategy_failed", True), ("strategy_failed", False)],
      f"the strategy_failed event carries transient, so the platform's push says the same as Telegram ({emitted})")

wfb._check_freshness = real_probe
scopes = []
real_gate = D._us_live_gate
D._us_live_gate = lambda sym: scopes.append((D._US_LIVE, sym)) or real_gate(sym)
env()
route(NAME, "binance")
mod = wfb._load_strategy_module(NAME)
for p in D._CACHE_DIR.glob("usstock_daily_*"):
    p.unlink()
ts, ready, _s, _l = wfb._check_freshness(mod, _dt(2026, 10, 16))
D._us_live_gate = real_gate
check(scopes == [((NAME, "NVDAUSDT"), "NVDA")] and ready and ts == _dt(2026, 10, 16),
      f"the real probe fetches inside us_live_strategy('{NAME}', 'NVDAUSDT') and sees Friday's bar ({scopes}, {ts})")

# ── paper fill price (the reconciler's env: desktop flag, no BLAVE_MODE) ────────
# lib.paper_data: a perp (stock perps included) fills at Binance's last trade, checked once a day
# against the owning strategy's own close for a ticker collision — that close is the Yahoo NVDA
# bar, read here without a live scope
import lib.paper_data as paper_data  # noqa: E402
env(mode=None)
for p in D._CACHE_DIR.glob("usstock_daily_*"):
    p.unlink()
asked = []
paper_data._binance_last = lambda sym: asked.append(sym) or 181.5
calls.clear()
try:
    price, owner = paper_data.current_price("NVDAUSDT", {}, max_age=0)
except Exception as e:
    price, owner = e, None
check(price == 181.5 and owner is None and asked == ["NVDAUSDT"] and calls == [("yahoo", "NVDA")],
      f"paper prices NVDAUSDT at Binance's last trade; the collision check reads the strategy's own "
      f"Yahoo close without a live scope ({price!r}, {owner}, {asked}, {calls})")

print("FAIL" if fails else "OK", f"({fails} failed)")
sys.exit(1 if fails else 0)
