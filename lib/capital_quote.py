"""群益期貨 1-minute bars for the live tick: SKQuoteLib pushes them to the
capital worker (same process and login as its account reads), this module turns
them into state/capital_bars_TXF_1m.json — the same one-way snapshot contract as
state/president_bars_TXF_1m.json (lib/president_quote), read by
lib/data._with_broker_tail to extend the Blave series past its last bar on a
群益-bound machine. TXF only: MXF / TMF strategies read the TXF series like their
backtests (lib/data aliases them).

Pure state and conversion, no COM: the worker owns SKQuoteLib, the event sink and
the connection state machine, and hands each event to a book here. Two books, one
per source the manual offers (§4-4-u / §4-4-m); which one the worker subscribes to
is pinned by the M0 probe (references/capital-broker.md › Quote feed):
- LiveKBook: OnNotifyLiveKLineData — nType 1 = a minute bar (the session's own
  backfill first, then one per minute), 2 = the forming minute on every trade
  (never written: not closed), 0 = reset (memory only: the file keeps its rolling
  rows, or the night session's first minutes could not be joined to Blave);
- TickBook: OnNotifyTicksLONG / OnNotifyHistoryTicksLONG trades folded into minute
  bars; trial-match ticks (nSimulate 1) never count; a minute is closed once a
  later minute's trade arrived or TICK_GRACE_S after its end.

Conversion to the cache convention (lib/twf_feed): END label, closing-match and
settlement-day bars dropped, series span only. Measured on win-test-6 2026-11-06
(references/capital-broker.md › Quote feed): live K labels a bar by its END minute
(1501 = the night session's first bar, 0500 its last, 0846 the day's first; an
nType 1 bar arrives within a second of that minute), nDate is the CALENDAR day for
live K and ticks alike (the manual's 交易日期 for ticks is not what the server
sends: 23:59 stamps the evening, 00:00 the next day), prices are raw integers
(÷ PRICE_DIV), nType 1 nQty is the bar's own volume (nType 2's grows through the
minute). The session's backfill runs from the night session's 15:01 bar.
"""
import os
import time
from datetime import datetime, timedelta

if __package__ == "lib":  # never a same-named file elsewhere on sys.path
    from lib import president_contracts as pc, twf_feed
else:  # run as a script: lib/ is sys.path[0]
    import president_contracts as pc
    import twf_feed

WORKSPACE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE = os.path.join(WORKSPACE, "state")
TAIPEI = pc.TAIPEI
ROOT = "TXF"

BAR_LABEL_OFFSET_MIN = 0      # live K label → cache END label (measured: already END)
PRICE_DIV = 100               # §4-4-u, measured: TXF 3888800 → 38888.00
CLOCK_SLACK_S = 120           # an event this far ahead of the machine clock is still "now"
TICK_GRACE_S = 3              # a trade stamped in the last second can arrive after the minute
HEARTBEAT_S = 15              # snapshot re-stamped this often while subscribed
SILENT_S = 180                # no event at all for this long in a session = the feed is down

NOT_ENABLED = "QUOTE_NOT_ENABLED"
SILENT = "QUOTE_SILENT"


def snapshot_path(root=ROOT):
    return os.path.join(STATE, f"capital_bars_{root}_1m.json")


def event_minute(n_date, hms, now, has_seconds=False):
    """(nDate YYYYMMDD calendar day, nTimehm HHmm or nTimehms HHmmss) → aware Taipei
    datetime of the minute it names; None when unreadable, outside the sessions or
    more than CLOCK_SLACK_S ahead of `now`."""
    try:
        n_date, hms = int(n_date), int(hms)
        h, m = (hms // 10000, hms // 100 % 100) if has_seconds else (hms // 100, hms % 100)
        at = datetime(n_date // 10000, n_date // 100 % 100, n_date % 100, h, m, tzinfo=TAIPEI)
    except (TypeError, ValueError):
        return None
    if at > now + timedelta(seconds=CLOCK_SLACK_S) or not twf_feed.in_session(at):
        return None
    return at


def _closing_call(minute, hms):
    if hms % 100:
        return False
    hm = (minute.hour, minute.minute)
    if hm == twf_feed.DAY_CUT:
        return True
    return hm == twf_feed.SETTLE_CUT and minute.date() == pc.settlement_at(minute.year, minute.month).date()


def _px(raw):
    return float(raw) / PRICE_DIV


class LiveKBook:
    """OnNotifyLiveKLineData events → closed minute bars (module doc)."""

    def __init__(self):
        self.bars = {}            # broker label minute → (o, h, l, c, v)
        self.last_event_at = None
        self.resets = 0

    def on_event(self, n_type, n_date, n_timehm, o, h, l, c, qty, now):
        self.last_event_at = now.timestamp()
        if int(n_type) == 0:
            self.bars.clear()
            self.resets += 1
            return
        if int(n_type) != 1:
            return
        label = event_minute(n_date, n_timehm, now)
        if label is not None and min(o, h, l, c) > 0:
            self.bars[label] = (_px(o), _px(h), _px(l), _px(c), int(qty))

    def rows(self, productid, now):
        back = timedelta(minutes=1 - BAR_LABEL_OFFSET_MIN)   # label → the minute the bar starts
        items = [(label - back,) + b for label, b in self.bars.items()]
        return twf_feed.cache_rows(items, productid, now, 1)


class TickBook:
    """Trades → minute bars (module doc), keyed by the minute the trade happened in
    (its START; END = +1)."""

    def __init__(self):
        self.bars = {}            # minute start → [o, h, l, c, v]
        self.newest = None        # latest minute any trade has been seen in
        self.last_event_at = None
        # (nDate, nPtr, nTimehms) of every trade counted: a re-subscribe, or SKCOM's own
        # reconnect, replays the whole trading day through OnNotifyHistoryTicksLONG
        self.seen = set()

    def on_tick(self, n_date, n_timehms, close, qty, simulate, now, ptr=None):
        self.last_event_at = now.timestamp()
        if int(simulate) != 0 or int(close) <= 0 or int(qty) <= 0:
            return
        if ptr is not None:
            key = (int(n_date), int(ptr), int(n_timehms))
            if key in self.seen:
                return
            self.seen.add(key)
        start = event_minute(n_date, n_timehms, now, has_seconds=True)
        if start is None:
            return
        if _closing_call(start, int(n_timehms)):
            # the day's closing auction prints at 13:45:00 (13:30:00 on settlement day); the Blave
            # cache folds it into the bar ending then (measured 11-04 / 11-05: close and volume)
            start -= timedelta(minutes=1)
        px, q = _px(close), int(qty)
        b = self.bars.get(start)
        if b is None:
            self.bars[start] = [px, px, px, px, q]
        else:
            b[1], b[2], b[3], b[4] = max(b[1], px), min(b[2], px), px, b[4] + q
        if self.newest is None or start > self.newest:
            self.newest = start

    def trim(self, now):
        """Forget what the snapshot's rolling window no longer holds."""
        floor = now - timedelta(days=twf_feed.KEEP_DAYS)
        self.bars = {s: b for s, b in self.bars.items() if s >= floor}
        day = int(floor.strftime("%Y%m%d"))
        self.seen = {k for k in self.seen if k[0] >= day}

    def rows(self, productid, now):
        items = []
        for s, b in self.bars.items():
            closed = (self.newest is not None and s < self.newest) or \
                now >= s + timedelta(minutes=1, seconds=TICK_GRACE_S)
            if closed:
                items.append((s,) + tuple(b))
        return twf_feed.cache_rows(items, productid, now, 1)


def build_snapshot(prev, new_rows, productid, now, conn, last_event_at, error=None, source="ticks", silence=True):
    """The snapshot dict for snapshot_path(): the rolling rows plus whether this
    moment's feed can be trusted. ok only while subscribed, an event arrived within
    SILENT_S and no error is pending; rows are kept either way (lib/data reads only
    an `ok`, fresh snapshot). `silence` False: no trade is due now (after the close), so a
    quiet feed is not a dead one."""
    prev = prev if isinstance(prev, dict) else {}
    now_epoch = int(now.timestamp())
    rows = twf_feed.merge_rows(prev.get("rows"), new_rows, now_epoch)
    if error is None and conn != "subscribed":
        error = f"QUOTE_{str(conn).upper()}"
    if error is None and silence and (last_event_at is None or now_epoch - last_event_at > SILENT_S):
        error = SILENT
    return {"root": ROOT, "broker": "capital", "productid": productid, "source": source,
            "label": "end", "written_at": int(time.time()), "ok": error is None, "error": error,
            "earliest": rows[0][0] if rows else None, "latest": rows[-1][0] if rows else None,
            "rows": rows, "conn": conn,
            "last_event_at": int(last_event_at) if last_event_at else None}


def write_snapshot(snap, root=ROOT):
    try:
        twf_feed.atomic_write(snapshot_path(root), snap)
    except OSError as e:
        print(f"[capital_quote] {root}: snapshot write failed: {type(e).__name__}", flush=True)
    return snap


def pause(reason, root=ROOT):
    """Market closed: re-stamp the last snapshot (rows, ok and error kept) with
    `paused` so the reader tells "no session" from "feed stale"."""
    snap = twf_feed.read_json(snapshot_path(root)) or {
        "root": root, "broker": "capital", "productid": None, "ok": False, "error": None,
        "earliest": None, "latest": None, "rows": []}
    snap["paused"] = reason
    snap["written_at"] = int(time.time())
    return write_snapshot(snap, root)


def replay(events, now=None, productid=None, code=None, tick_index=None):
    """Recorded raw events (the M0 probe's jsonl rows: {"ev": "kline"|"tick", "at":
    receive epoch, ...the event's own arguments}) → (kline rows, tick rows) as of
    `now` (default: the last event's receive time). A reset (nType 0) first keeps
    what the live-K book held, the way the snapshot file keeps its rows. For fixtures
    and the bar-by-bar comparison against Blave; the worker feeds the books live.
    With several products subscribed, `code` keeps one product's live K (the event
    names it) and `tick_index` one product's trades (a tick names only its nIndex)."""
    lk, tk = LiveKBook(), TickBook()
    kept, last = [], None

    def pid(at):
        return productid or pc.series_contract(ROOT, at)

    for e in sorted(events, key=lambda e: float(e["at"])):
        at = datetime.fromtimestamp(float(e["at"]), TAIPEI)
        last = at
        if e.get("ev") == "kline":
            if code is not None and e.get("code") not in (None, code):
                continue
            if int(e["nType"]) == 0 and lk.bars:
                kept += lk.rows(pid(at), at)
            lk.on_event(e["nType"], e["nDate"], e["nTimehm"], e["nOpen"], e["nHigh"], e["nLow"],
                        e["nClose"], e["nQty"], at)
        elif e.get("ev") == "tick":
            if tick_index is not None and e.get("nIndex") != tick_index:
                continue
            tk.on_tick(e["nDate"], e["nTimehms"], e["nClose"], e["nQty"], e.get("nSimulate", 0), at, e.get("nPtr"))
    now = now or last or datetime.now(TAIPEI)
    krows = {r[0]: r for r in kept + lk.rows(pid(now), now)}
    return [krows[k] for k in sorted(krows)], tk.rows(pid(now), now)


# ── the worker's quote thread (lib/capital_worker._quote_thread) ───────────────────
QUOTE_CODE = "TX00"           # 群益's near-month alias (its OrderID says which month it is)
READY, DOWN = 3003, (3002, 3021, 3022, 3033)
CONN_LIMIT, NO_MARKET = 3030, 3031
FIRST_READY_S = 600           # first connect: the product file downloads before 3003
REENTER_AFTER_S = 90          # a drop SKCOM has not healed by then gets one EnterMonitor
REENTER_BACKOFF_S = (30, 60, 120, 300)
LIST_EVERY_S = 1800           # re-read which month TX00 is
ROLL_GUARD = "QUOTE_ROLL_GUARD"
BACKFILL = "QUOTE_BACKFILL"
SILENT_REDO_S = (360, 900, 1800, 3600)   # spacing of the silence actions (a holiday is all silence)


def settlement_window(now):
    """From the night session before a settlement day (15:00 the day before) to the end of
    that day's own night session: when TX00 switches months is unmeasured, so its trades
    then may belong to either month."""
    now = now.astimezone(TAIPEI)
    return any(d == pc.settlement_at(d.year, d.month).date()
               for d in (now.date(), (now - timedelta(hours=6)).date(), (now + timedelta(hours=9)).date()))


def roll_guard(now, alias_month):
    """True while the near-month alias cannot be trusted to be the Blave series month:
    the settlement window, or TX00's own OrderID unknown or naming another month than
    president_contracts.series_contract."""
    return settlement_window(now) or alias_month != pc.series_contract(ROOT, now)


def _trading(now):
    """A trade can print now: the feed windows minus the minutes around the open and
    after the close (13:45–15:00, 05:00–08:45), where quiet is normal."""
    hm = (now.hour, now.minute)
    return twf_feed.in_session(now) and not (twf_feed.DAY_CUT <= hm < twf_feed.NIGHT_OPEN) \
        and not (twf_feed.NIGHT_CUT <= hm < twf_feed.DAY_OPEN)


def alias_month(stock_data, code=QUOTE_CODE):
    """OnNotifyStockList text → the exchange product id behind `code` ("TXFK600" → "TXFK6"), or None."""
    for item in str(stock_data).split(";"):
        f = [x.strip() for x in item.split(",")]
        if len(f) > 3 and f[0] == code and len(f[3]) >= 5:
            return f[3][:5]
    return None


class QuoteFeed:
    """SKQuoteLib on the worker's login → state/capital_bars_TXF_1m.json. Driven by
    one thread that owns the COM object and pumps it (step() between pumps); the event
    sink only updates this object, every COM call happens in step(). Never logs in,
    never calls LeaveMonitor (it would also drop the order-reply link), never raises.

    After every RequestTicks SKCOM replays the trading day in order through
    OnNotifyHistoryTicksLONG before the first live trade (40–46 s measured); until that
    first live trade the book holds half-replayed minutes, so the snapshot is not ok
    (QUOTE_BACKFILL). Every retry is on a backoff set before the COM call: each extra
    RequestTicks can eat the subscription quota (3027)."""

    def __init__(self, q, clock=time.time, now=lambda: datetime.now(TAIPEI)):
        self.q, self.clock, self.now = q, clock, now
        self.book = TickBook()
        self.state = "idle"       # idle → entering → subscribed; down on a drop
        self.ready = False
        self.first = True
        self.entered_at = self.down_at = None
        self.retries = 0
        self.next_enter = 0.0
        self.resub_at = 0.0
        self.error = None
        self.month = None
        self.list_at = 0.0
        self.written_at = 0.0
        self.backfilling = False
        self.live_ref = None      # last live trade, or the subscribe before the first one
        self.silent_n = 0
        self.silent_next = 0.0

    # events (from the sink, same thread)
    def on_connection(self, kind, code):
        kind = int(kind)
        if kind == READY:
            self.ready, self.down_at, self.retries, self.error = True, None, 0, None
        elif kind in DOWN:
            self.ready, self.silent_n, self.silent_next = False, 0, 0.0   # a reported drop: the ordinary reconnect path
            if self.state == "subscribed":
                self.state = "down"
            self.down_at = self.down_at or self.clock()
        elif kind == CONN_LIMIT:
            self.error = "QUOTE_CONN_LIMIT"
        elif kind == NO_MARKET:
            self.error = NOT_ENABLED

    def on_tick(self, n_date, n_timehms, close, qty, simulate, ptr, live=True):
        now = self.now()
        if live:
            self.backfilling, self.live_ref, self.silent_n, self.silent_next = False, self.clock(), 0, 0.0
        if settlement_window(now) or (self.month and self.month != pc.series_contract(ROOT, now)):
            return  # TX00 may be (or is) another month: its trades must not land on the series bars
        self.book.on_tick(n_date, n_timehms, close, qty, simulate, now, ptr)

    def on_list(self, data):
        m = alias_month(data)
        if m:
            self.month = m

    # COM calls
    def _backoff(self):
        d = REENTER_BACKOFF_S[min(self.retries, len(REENTER_BACKOFF_S) - 1)]
        self.retries += 1
        return self.clock() + d

    def _enter(self):
        self.entered_at = self.clock()
        self.next_enter = self._backoff()
        self.state = "entering"
        code = self.q.SKQuoteLib_EnterMonitorLONGByMarket(1)
        if _ret(code) != 0:
            self.error = f"QUOTE_ENTER:{_ret(code)}"

    def _subscribe(self):
        self.resub_at = self._backoff()   # before the calls: a raising one must not be retried every pump
        self.list_at = self.clock()
        self.first = False
        try:
            self.q.SKQuoteLib_CancelRequestTicks(QUOTE_CODE)
        except Exception:  # noqa: BLE001 — nothing subscribed yet
            pass
        self.q.SKQuoteLib_RequestStockList(2)
        rc = _ret(self.q.SKQuoteLib_RequestTicks(0, QUOTE_CODE))
        if rc != 0:
            self.state, self.error = "entering", f"QUOTE_SUBSCRIBE:{rc}"
            return
        self.state, self.error, self.resub_at = "subscribed", None, 0.0
        self.backfilling, self.live_ref = True, self.clock()

    def _silence(self, t):
        """A session minute with no trade for 2 × SILENT_S: a dead link SKCOM never reported, or a
        holiday. Re-subscribe and full re-enter take turns, on a growing spacing that a 3003 does
        not reset (a holiday would otherwise loop every few minutes all day); a live trade or a
        reported drop ends it."""
        self.silent_next = t + SILENT_REDO_S[min(self.silent_n, len(SILENT_REDO_S) - 1)]
        self.silent_n += 1
        if self.silent_n % 2:
            self._subscribe()
        else:
            self.ready = False
            self._enter()

    def step(self):
        now, t = self.now(), self.clock()
        if self.state == "idle":
            self._enter()
        elif self.state in ("entering", "down") and self.silent_n and not self.ready:
            # a silence step's EnterMonitor got no 3003 (a holiday may just be quiet): the next
            # step comes on the silence spacing, never on the 30 s – 5 min reconnect backoff
            if t >= self.silent_next:
                self._silence(t)
        elif self.state in ("entering", "down"):
            if self.ready:
                if t >= self.resub_at:
                    self._subscribe()
            elif self.state == "entering" and t - self.entered_at > (FIRST_READY_S if self.first else REENTER_AFTER_S):
                self.error = self.error or "QUOTE_NOT_READY"
                if t >= self.next_enter:
                    self._enter()
            elif self.state == "down" and t - self.down_at > REENTER_AFTER_S and t >= self.next_enter:
                self._enter()
        elif self.state == "subscribed":
            if _trading(now) and self.live_ref is not None and t - self.live_ref > 2 * SILENT_S \
                    and t >= self.silent_next:
                self._silence(t)
            elif t - self.list_at > LIST_EVERY_S:
                self.list_at = t
                self.q.SKQuoteLib_RequestStockList(2)
        if t - self.written_at >= HEARTBEAT_S:
            self.written_at = t
            self.write(now)

    def write(self, now):
        if not twf_feed.in_session(now):
            return pause("closed")
        pid = pc.series_contract(ROOT, now)
        self.book.trim(now)
        err = self.error
        if err is None and self.state == "subscribed":
            err = BACKFILL if self.backfilling else ROLL_GUARD if roll_guard(now, self.month) else None
        last = None if self.live_ref is None else now.timestamp() - (self.clock() - self.live_ref)
        snap = build_snapshot(twf_feed.read_json(snapshot_path()), self.book.rows(pid, now), pid, now,
                              self.state, last, err, silence=_trading(now))
        snap["alias_month"] = self.month
        return write_snapshot(snap)


class QuoteSink:
    """SKQuoteLib event sink: hands each event to the feed, never calls COM."""

    def __init__(self, feed):
        self.feed = feed

    def OnConnection(self, nKind, nCode):
        self.feed.on_connection(nKind, nCode)

    def OnNotifyTicksLONG(self, sMarketNo, nIndex, nPtr, nDate, nTimehms, nTimemillismicros, nBid, nAsk,
                          nClose, nQty, nSimulate):
        self.feed.on_tick(nDate, nTimehms, nClose, nQty, nSimulate, nPtr)

    def OnNotifyHistoryTicksLONG(self, sMarketNo, nIndex, nPtr, nDate, nTimehms, nTimemillismicros, nBid,
                                 nAsk, nClose, nQty, nSimulate):
        self.feed.on_tick(nDate, nTimehms, nClose, nQty, nSimulate, nPtr, live=False)

    def OnNotifyStockList(self, sMarketNo, bstrStockData):
        self.feed.on_list(bstrStockData)


def _ret(r):
    """comtypes hands back [in,out] params with the result as a tuple; the code is last."""
    return r[-1] if isinstance(r, (tuple, list)) else r


def run(create, get_events, pump, stop=lambda: False, log=print):
    """Thread body: create the quote object on this thread, wire the sink, then pump
    and step until stop(). A failing step is logged (once per distinct error) and the
    loop goes on — the account worker this shares a process with must not notice."""
    q = create()
    feed = QuoteFeed(q)
    handle = get_events(q, QuoteSink(feed))  # noqa: F841 — held for the loop: a dropped one is GC'd with its connection point
    said = None
    while not stop():
        try:
            pump()
            feed.step()
            said = None
        except Exception as e:  # noqa: BLE001
            msg = f"{type(e).__name__}: {e}"[:200]
            if msg != said:
                log(f"[capital_quote] step failed: {msg}")
                said = msg
            time.sleep(1)
        time.sleep(0.05)
    return feed
