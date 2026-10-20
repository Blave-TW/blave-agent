"""The markets lib/paper_data prices at, canned at requests' adapter for tests.

Binance's last trade (/fapi/v1/ticker/price) and Blave's TAIFEX series
(/studio/market/twfutures/ohlcv/<code>/<schema>) answer with the latest Close of
the test strategy that trades the symbol (its fetch_data is each test's own mark
channel: state/mark.txt, state/marks.json, …). No such strategy, or its
fetch_data fails → Binance's -1121 / an empty series, i.e. no price. The real
lib/paper_data parses the answers; no socket is opened.

In-process:   import paper_market; paper_market.install()
Subprocesses: append paper_market.SRC to the sitecustomize.py the child loads.
"""

SRC = r'''
def _paper_market_install():
    import json, os, time
    try:
        import requests
        from requests.models import Response
    except ImportError:
        return
    if getattr(requests.adapters.HTTPAdapter.send, "_paper_market", False):
        return
    orig = requests.adapters.HTTPAdapter.send

    def owner_close(sym):
        try:
            from lib import paper_data
            name = paper_data._resolve_strategy(sym)
            df = paper_data._load_strategy(name).fetch_data({}) if name else None
            return float(df["Close"].iloc[-1]) if df is not None and len(df) else None
        except Exception:
            return None

    def answer(req, status, body):
        r = Response()
        r.status_code, r._content = status, json.dumps(body).encode()
        r.headers["Content-Type"] = "application/json"
        r.url, r.request = req.url, req
        return r

    def send(adapter, req, **kw):
        from urllib.parse import parse_qs, urlsplit
        u = urlsplit(req.url)
        if u.netloc == "fapi.binance.com" and u.path == "/fapi/v1/ticker/price":
            sym = (parse_qs(u.query).get("symbol") or [""])[0]
            px = owner_close(sym)
            if px is None:
                return answer(req, 400, {"code": -1121, "msg": "Invalid symbol."})
            return answer(req, 200, {"symbol": sym, "price": str(px), "time": int(time.time() * 1000)})
        if u.path.startswith("/studio/market/twfutures/ohlcv/"):
            px = owner_close(u.path.rstrip("/").split("/")[-2])
            rows = [] if px is None else [{"ts": time.strftime("%Y-%m-%dT%H:%M:00Z", time.gmtime()),
                                           "open": px, "high": px, "low": px, "close": px, "volume": 1}]
            return answer(req, 200, {"data": rows})
        return orig(adapter, req, **kw)
    send._paper_market = True
    requests.adapters.HTTPAdapter.send = send


_paper_market_install()
'''


def install():
    exec(SRC, {"__name__": "paper_market_canned"})
