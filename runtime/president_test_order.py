"""統一期貨 test-environment order: the one order runtime/president_connect.py's
president_test_order places, so the user can tell their broker "I placed a test
order through the API" and get production API access. Run by that step with
the worker's python (unitrade lives there): `python president_test_order.py <workspace>`.

What it sends: TMF (微台) near month, 1 lot, market IOC buy. Why IOC rather than
a far limit order cancelled afterwards: an IOC leaves nothing resting at the
broker by definition, the test host answers 0000 and never fills (measured
10-02), and a cancel depends on replace_order, which lib/order_president has
never verified. If a fill ever does arrive, one close-only IOC sell for the
filled lots goes right after it.

Test environment only, checked three times: president_connect refuses the
command unless the vault is off production; here the lib's own resolve() must
say not live and give a *.testpfctrade.com host; and the lib's login refuses a
server that does not report itself a test server. The login is the lib's one
login path (president_vault.login, explicit — the user pressed it: one real login per press; a
failure stops logins like any other; maintenance window,
logout on every failure).

Only the stdlib and runtime/atomic_file at import time (the runtime health
check imports every module); the lib and the SDK load in run(). Output: <workspace>/state/president_test_order.json
— a class, codes, the time and the order number; never broker text, which can
carry the national id.
"""
import json
import os
import re
import sys
import threading
import time
from urllib.parse import urlparse

import atomic_file  # runtime/, next to this script (sys.path[0] when run as one)

ROOT = "TMF"
REPLY_WAIT_S = 15
FILL_GRACE_S = 2
ACCEPTED = ("0000", "0001", "0003", "0004", "0006")  # = lib/order_president._ACCEPTED
_CODE_RE = re.compile(r"[A-Za-z0-9]{1,12}")


def _code(v):
    v = str(v or "").strip()
    return v if _CODE_RE.fullmatch(v) else None


def _write(workspace, payload):
    path = os.path.join(workspace, "state", "president_test_order.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with atomic_file.replacing(path, encoding="utf-8") as f:
        json.dump(payload, f)


class _Reports:
    """on_reply / on_match, copied at callback time (the SDK reuses one object)."""

    def __init__(self):
        self.lock = threading.Lock()
        self.replies = {}
        self.fills = {}

    def on_reply(self, r):
        row = {k: getattr(r, k, None) for k in ("seq", "orderno", "statuscode", "matchqty")}
        with self.lock:
            self.replies.setdefault(str(row["seq"] or "").strip(), []).append(row)

    def on_match(self, m):
        with self.lock:
            self.fills.setdefault(str(m.orderno), {})[str(m.matchseq)] = int(m.matchqty or 0)

    def latest(self, seq):
        with self.lock:
            rows = self.replies.get(seq) or []
            return dict(rows[-1]) if rows else None

    def filled(self, orderno):
        with self.lock:
            return sum((self.fills.get(str(orderno)) or {}).values())


def _send(api, order_cls, reports, actno, productid, bs, lots, closing):
    o = order_cls()
    o.actno = actno
    o.subactno = ""
    o.productid = productid
    o.bs = bs
    o.ordertype = "M"
    o.price = 0
    o.orderqty = lots
    o.ordercondition = "I"
    o.opencloseflag = "1" if closing else ""
    o.dtrade = "N"
    o.note = "blavetest"
    resp = api.dtrade.order(o)
    if not resp.issend:
        return None, _code(getattr(resp, "errorcode", None))
    seq = str(resp.seq).strip()
    deadline = time.time() + REPLY_WAIT_S
    while time.time() < deadline:
        ack = reports.latest(seq)
        if ack and ack["statuscode"] not in (None, "", "STAR"):
            return ack, None
        time.sleep(0.05)
    return reports.latest(seq) or {}, None


def run(workspace):
    sys.path.insert(0, os.path.join(workspace, "lib"))
    import president_vault as pv
    from president_contracts import computed_near

    creds = pv.resolve()
    host = (urlparse(creds["url"]).hostname or "").lower()
    if creds["live"] or not host.endswith(pv.TEST_HOST_SUFFIX):
        return {"result": "live_refused"}
    from unitrade.unitrade import DOrderObject

    api = pv.login(creds, pv.SDK_LOG_DIR, explicit=True)
    try:
        if api.test_mode is not True:  # login() already refuses this; kept next to the send
            return {"result": "live_refused"}
        productid = computed_near(ROOT)
        resp = api.get_domestic_contracts(ROOT, "F")
        listed = [str(c.prod_id).upper() for c in (resp.data or [])] if resp and resp.ok else []
        if productid not in listed:
            return {"result": "not_sent", "productid": productid}
        accounts = api.get_accounts() or []
        if not accounts:
            return {"result": "not_sent", "productid": productid}
        reports = _Reports()
        api.dtrade.on_reply = reports.on_reply
        api.dtrade.on_match = reports.on_match
        sent_at = time.time()
        ack, err = _send(api, DOrderObject, reports, accounts[0], productid, "B", 1, closing=False)
        out = {"sent_at": sent_at, "productid": productid}
        if ack is None:
            return dict(out, result="not_sent", statuscode=err)
        code = _code(ack.get("statuscode"))
        out.update(statuscode=code, orderno=_code(ack.get("orderno")))
        if code is None:
            return dict(out, result="no_reply")
        if code not in ACCEPTED:
            return dict(out, result="rejected")
        time.sleep(FILL_GRACE_S)
        replied = str((reports.latest(str(ack.get("seq") or "").strip()) or ack).get("matchqty") or "0").strip()
        lots = max(reports.filled(ack.get("orderno")), int(replied) if replied.isdigit() else 0)
        out.update(result="accepted", filled=lots > 0)
        if lots > 0:
            close_ack, _ = _send(api, DOrderObject, reports, accounts[0], productid, "S", lots, closing=True)
            out["closed"] = bool(close_ack) and _code(close_ack.get("statuscode")) in ACCEPTED
        return out
    finally:
        api.logout()


def main(argv):
    if len(argv) != 2 or not os.path.isdir(argv[1]):
        print("usage: president_test_order.py <workspace>", file=sys.stderr)
        return 64
    workspace = argv[1]
    try:
        out = run(workspace)
    except Exception as e:  # noqa: BLE001 — only a class leaves
        login_kind = getattr(e, "kind", None)
        if type(e).__name__ == "LoginError" and isinstance(login_kind, str):
            out = {"error": f"統一期貨 login failed: {login_kind}"}
        else:
            out = {"error": type(e).__name__}
    out["read_at"] = time.time()
    try:
        _write(workspace, out)
    except OSError:
        return 3
    return 0 if out.get("result") == "accepted" else 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
