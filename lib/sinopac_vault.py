"""永豐 futures: when this machine last sent an order, and how long the worker's position read lags it.

manager/flatten reads ORDER_SETTLE_S and last_order_at here (lib.venue_traits snapshot_settle_wait);
lib/sinopac_worker writes the marker right before every place_order and holds its own reads to it;
lib/sinopac_futures_account refuses a position read that started too soon after it.
Stdlib only (winreplace aside), imported as lib.sinopac_vault.
"""
import logging
import os
import time

try:
    if __package__ == "lib":  # never a same-named file elsewhere on sys.path
        from lib.winreplace import atomic_replace, read_retry
    else:  # loaded with lib/ itself on sys.path
        from winreplace import atomic_replace, read_retry
except ImportError:  # half-updated workspace (lib/winreplace.py not landed): one plain read
    atomic_replace = os.replace

    def read_retry(read, *args, **kwargs):
        return read(*args, **kwargs)


# The one settle window every 永豐 reader and the worker use — never restate the number elsewhere.
# UNMEASURED: M0-b (2026-11-16, real account, 1.7.11) only saw list_positions still return [] right
# after a Filled TMF market IOC; how long it lags was not timed. 20 s is borrowed from 統一 (its
# position query showed a live fill 12.0 s / 10.9 s after the send, 10-02), as lib/capital_vault
# borrows it, and fits manager/flatten's TURN_SETTLE_BUDGET_S (25 s). Too short and a lagging []
# read past the window is taken as flat and the position is opened again. The gate-flip live test
# (audit M3) must time fill → list_positions, set ORDER_SETTLE_MEASURED_S to the worst lag seen and
# this to at least twice it; tests/check_sinopac_futures.py refuses a flipped gate until then.
ORDER_SETTLE_S = 20
ORDER_SETTLE_MEASURED_S = None
LAST_ORDER_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                               "state", "sinopac_last_order_at")
# the worker's failed-login record (lib/sinopac_worker STOP_PATH): only the user's --once clears it
LOGIN_STOPPED_PATH = os.path.join(os.path.dirname(LAST_ORDER_PATH), "sinopac_login_stopped.json")
# = lib/capital_vault.MARKER_UNREADABLE_MAX_S
MARKER_UNREADABLE_MAX_S = ORDER_SETTLE_S * 15
_last_order_mem = 0.0
_marker_unreadable_since = None


class MarkerUnreadable(RuntimeError):
    pass


def _read_text(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def mark_order_sent():
    """Raises OSError when the marker cannot be written: the worker then does not send (a send
    the other processes cannot see is one they may read as flat)."""
    global _last_order_mem
    _last_order_mem = time.time()
    os.makedirs(os.path.dirname(LAST_ORDER_PATH), exist_ok=True)
    tmp = f"{LAST_ORDER_PATH}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(repr(_last_order_mem))
    atomic_replace(tmp, LAST_ORDER_PATH)


def last_order_at():
    """Unix time of the last 永豐 futures send on this machine, 0.0 if none. A marker that is there
    but unreadable counts as a send just now (nothing reads as settled); past
    MARKER_UNREADABLE_MAX_S it raises MarkerUnreadable."""
    global _marker_unreadable_since
    try:
        disk = float(read_retry(_read_text, LAST_ORDER_PATH).strip() or 0)
    except FileNotFoundError:
        disk = 0.0
    except ValueError:  # not a number: when it was written still bounds the send, and expires
        try:
            disk = os.path.getmtime(LAST_ORDER_PATH)
        except OSError:
            disk = time.time()
    except OSError as e:
        now = time.time()
        if _marker_unreadable_since is None:
            _marker_unreadable_since = now
        if now - _marker_unreadable_since > MARKER_UNREADABLE_MAX_S:
            raise MarkerUnreadable(
                f"永豐下單紀錄 {LAST_ORDER_PATH} 已 {int(now - _marker_unreadable_since)} 秒讀不到"
                f"({type(e).__name__}),永豐部位無法確認是否已更新 / the 永豐 last-order marker has "
                f"been unreadable for {int(now - _marker_unreadable_since)} s") from e
        logging.warning(f"sinopac: last-order marker unreadable ({type(e).__name__}) — read as a send now")
        return max(now, _last_order_mem)
    _marker_unreadable_since = None
    return max(disk, _last_order_mem)


def login_stopped():
    """A failed worker login has stopped 永豐: nothing logs in or trades there until the user confirms."""
    return os.path.exists(LOGIN_STOPPED_PATH)


def settled_at():
    """The earliest a position read may START and still be trusted to show every send so far."""
    last = last_order_at()
    return last + ORDER_SETTLE_S if last else 0.0
