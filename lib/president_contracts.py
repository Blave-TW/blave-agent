"""統一期貨 contract months: settlement, the entry roll, and which held rows are
the bot's. Pure functions — no broker, no order lib (lib/account_president
imports this, and importing an order lib marks a process as a money process).

A held row of a root is one of:
- the bot's: the FRONT month (first whose settlement is still ahead) or the
  computed ENTRY month (they differ between the roll at 15:00 the day before
  settlement and the 13:30 settlement);
- SETTLED residue: its settlement time has passed and the broker no longer
  lists it (or the list is unknown) — cash-settled, treated as not held, never
  closed or added to. Before its settlement time a held row is real whatever
  the list says (an index month trades until 13:30 on its settlement day; a
  row missing from the list then means a short list, not a gone contract), so
  the month alone decides;
- PENDING: its settlement time has passed but the broker still lists it — a
  holiday-postponed settlement, or a broker list that has not dropped it yet.
  Treated as the bot's expiring month (a held month is added to, never a second
  month opened beside it): ignoring it would double the exposure for a day if it
  is really still trading, and the order path's own contract-list check
  refuses a contract that is not;
- MANUAL: any other month (a far month the user opened in the app) — the read
  fails for that root: Blave will not touch it, and summing it in would
  mis-count the lots.
"""
import calendar
import re
from datetime import datetime, timedelta, timezone

TAIPEI = timezone(timedelta(hours=8), "Asia/Taipei")  # no ZoneInfo: Windows has no tz database
ROOTS = ("TXF", "MXF", "TMF")
MONTH_CODES = "ABCDEFGHIJKL"  # futures month letters, A = January
SETTLE_HOUR, SETTLE_MINUTE = 13, 30
NIGHT_OPEN_HOUR, NIGHT_OPEN_MINUTE = 15, 0
PROD_RE = re.compile(r"^(TXF|MXF|TMF)([A-L])(\d)$")


class ManualPosition(RuntimeError):
    """A month of a root the bot does not trade is held — the read fails for it."""


def _now(now):
    now = now or datetime.now(TAIPEI)
    if now.tzinfo is None:
        raise ValueError("needs a timezone-aware time")
    return now


def settlement_at(year, month):
    """13:30 Taipei on the third Wednesday of year/month."""
    first = calendar.weekday(year, month, 1)  # Mon=0
    day = 1 + (calendar.WEDNESDAY - first) % 7 + 14
    return datetime(year, month, day, SETTLE_HOUR, SETTLE_MINUTE, tzinfo=TAIPEI)


def entry_roll_at(year, month):
    """15:00 Taipei the day before settlement — the night session that opens the
    settlement day's trading date. From then on new positions go to the next
    month: one opened in the expiring contract would be cash-settled at 13:30
    next day and re-opened by the reconciler in the next month, two extra round
    trips. The backtest's TXFR1 stays on the expiring contract until 13:30; the
    live difference is the calendar spread's move over those ≤22h30m, on new
    entries only (a held expiring position is added to in its own month, and
    closes go to whatever month is held)."""
    return (settlement_at(year, month) - timedelta(days=1)).replace(
        hour=NIGHT_OPEN_HOUR, minute=NIGHT_OPEN_MINUTE)


def prod_id(root, year, month):
    return f"{root}{MONTH_CODES[month - 1]}{year % 10}"


def _first_after(root, now, cutoff):
    root = str(root).upper()
    if root not in ROOTS:
        raise ValueError(f"{root!r} is not TXF/MXF/TMF")
    now = _now(now)
    y, m = now.astimezone(TAIPEI).year, now.astimezone(TAIPEI).month
    while cutoff(y, m) <= now:
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return prod_id(root, y, m)


def computed_near(root, now=None):
    """The contract a new position goes to at `now` (the roll rule)."""
    return _first_after(root, now, entry_roll_at)


def front_month(root, now=None):
    """The first contract whose settlement is still ahead at `now`."""
    return _first_after(root, now, settlement_at)


def month_of(productid, now=None):
    """(year, month) of a contract code; the year digit resolves to the decade
    that puts it within a year behind `now` (contracts here are ≤12 months out)."""
    m = PROD_RE.match(str(productid).upper())
    if not m:
        raise ValueError(f"{productid!r} is not a TXF/MXF/TMF month contract code")
    now = _now(now).astimezone(TAIPEI)
    year = now.year - now.year % 10 + int(m.group(3))
    if year < now.year - 1:
        year += 10
    elif year > now.year + 8:
        year -= 10
    return year, MONTH_CODES.index(m.group(2)) + 1


def classify_row(row, listed=None, now=None):
    """'bot' / 'settled' / 'pending' / 'manual' for one held row (see module doc).
    `listed`: the broker's contract codes for this row's root, or None if unknown."""
    now = _now(now)
    pid = row["productid"]
    settled_by_time = settlement_at(*month_of(pid, now)) <= now
    if settled_by_time:
        if listed is not None and pid in listed:
            return "pending"
        return "settled"
    if pid in (front_month(row["root"], now), computed_near(row["root"], now)):
        return "bot"
    return "manual"


def bot_rows(rows, listed_by_root=None, now=None):
    """The held rows the bot counts (bot + pending), and the settled residue it
    ignores. Raises ManualPosition for a month the bot does not trade."""
    keep, residue = [], []
    for r in rows:
        if not r.get("net"):
            continue
        listed = (listed_by_root or {}).get(r["root"])
        kind = classify_row(r, listed, now)
        if kind == "manual":
            raise ManualPosition(
                f"偵測到 {r['productid']}({r['net']:+d} 口)的手動部位,Blave 不會動它;請先在 App 處理"
                f"或告訴 agent — {r['root']} 暫停對帳")
        (residue if kind == "settled" else keep).append(r)
    return keep, residue
