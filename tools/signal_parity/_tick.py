"""One replayed live tick: `python _tick.py strategies/<name>/strategy.py`, cwd = a replay
workspace built by replay.py, BLAVE_MODE=live and BLAVE_EXPECTED_BAR=<naive UTC ISO> in the env.

Runs the strategy file as `__main__` exactly as wait_for_bar would, with three substitutions
installed before the strategy imports anything:
  - the network is blocked (requests + raw sockets), so a cache miss fails loudly instead of
    fetching — the replay must see only what the parquet holds;
  - lib.data's cache extenders (_extend_cache_monthly / _extend_cache_single — the batch
    fetchers' per-id extension goes through them too, so cached ids of a Taiwan batch are
    served; uncached ones would need the network and fail) get an empty fetcher and their
    result is cut to labels <= BLAVE_EXPECTED_BAR — what a live fetch returned once that bar
    had closed (the forming bar is gone; later bars do not exist yet);
  - Telegram / web-chat sends are no-ops (BLAVE_AGENT_HOME also points at the workspace, so
    lib.notify / lib.events find no config even unpatched).
Nothing else is touched: the runner's own live path, closed_bars_only / live_feeds scopes,
state.json writes and exit codes are the lib under test.
"""
import os
import runpy
import socket
import sys


def _blocked(*_a, **_k):
    raise RuntimeError("signal_parity: network blocked — the replay cache does not hold this data")


def _block_network():
    socket.create_connection = _blocked
    socket.socket.connect = _blocked
    try:
        import requests
        requests.Session.request = _blocked
        for n in ("get", "post", "put", "delete", "head", "request"):
            setattr(requests, n, _blocked)
    except ImportError:
        pass


def _patch_data(cut_iso):
    import pandas as pd
    import lib.data as D
    cut = pd.Timestamp(cut_iso)

    def _cut(obj):
        if isinstance(obj, (pd.DataFrame, pd.Series)) and isinstance(obj.index, pd.DatetimeIndex) \
                and len(obj):
            c = cut if obj.index.tz is None else cut.tz_localize("UTC").tz_convert(obj.index.tz)
            return obj[obj.index <= c]
        return obj

    def _wrap(fn):
        def wrapped(prefix, params, fetch_raw_fn, start, end, *a, **k):
            return _cut(fn(prefix, params, lambda *_a, **_k: pd.DataFrame(), start, end, *a, **k))
        return wrapped

    for name in ("_extend_cache_monthly", "_extend_cache_single"):
        if hasattr(D, name):
            setattr(D, name, _wrap(getattr(D, name)))
        else:
            print(f"[signal_parity] lib.data has no {name} — this lib's cache path is not cut",
                  file=sys.stderr)


def _patch_notify():
    try:
        import lib.notify as N
    except Exception:
        return
    noop = lambda *a, **k: None
    for name in ("send_text", "send_photo", "report_photo_web"):
        if hasattr(N, name):
            setattr(N, name, noop)
    if hasattr(N, "make_sender"):
        N.make_sender = lambda photo=False: noop


def main():
    strategy = sys.argv[1]
    cut = os.environ.get("BLAVE_EXPECTED_BAR")
    if not cut:
        sys.exit("signal_parity: BLAVE_EXPECTED_BAR not set")
    ws = os.getcwd()
    # what `python strategies/<name>/strategy.py` would have had: sys.path[0] = the strategy's
    # own directory (sibling imports), the workspace root next (the file inserts it too)
    sys.path[0] = os.path.dirname(os.path.abspath(strategy))
    sys.path.insert(1, ws)
    sys.argv = [os.path.abspath(strategy)]
    _block_network()
    _patch_data(cut)
    _patch_notify()
    runpy.run_path(strategy, run_name="__main__")


if __name__ == "__main__":
    main()
