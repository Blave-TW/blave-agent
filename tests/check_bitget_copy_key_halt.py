"""Bitget 40731 (a copy-trading key or an elite-trader account) at the reconciler: the position read
is CREDENTIAL, so the first one HALTs — and the HALT reason / Telegram line say which key to bind
instead of the generic "fix or rebind the key" (rebinding the same kind of key cannot fix it).
The reason ends with [bitget_copy_trading_key] (the desktop banner reads it) and stays ≤ 200 chars
(the platform's halt event cuts there). Any other CREDENTIAL code keeps the generic sentence.

No network: the error is lib/account_bitget.error_of's real one from a fake reply.
Run: cd blave-agent && .venv/bin/python tests/check_bitget_copy_key_halt.py
"""
import json
import os
import sys
import tempfile
import time

SRC = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = tempfile.mkdtemp(prefix="bitget-copy-halt-")
os.chdir(TMP)
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = TMP
sys.path.insert(0, SRC)
from manager import reconciler as rec  # noqa: E402
from lib import account_bitget as acct, guard  # noqa: E402

fails = 0


def check(cond, msg, detail=""):
    global fails
    print(("ok   " if cond else "FAIL ") + msg + (f"  {detail}" if detail and not cond else ""))
    fails += 0 if cond else 1


class Reply:
    status_code = 400

    def __init__(self, code, msg):
        self._body = {"code": code, "msg": msg, "requestTime": 1, "data": None}
        self.text = json.dumps(self._body)

    def json(self):
        return self._body


sent = []
rec.send_telegram = sent.append
ENV = {"BITGET_API_KEY": "bg_not_a_real_key"}

exc = acct.error_of(ENV, Reply("40731", "This product does not support copy trading"),
                    "/api/v2/mix/position/all-position")
kind = acct.classify(exc)
check(kind == "credential", "40731 position read → CREDENTIAL", kind)
rec._on_read_failure("bitget", exc, kind, time.time())
h = guard.halt_info() or {}
reason = str(h.get("reason") or "")
check(guard.halted() and h.get("source") == "reconciler", "the first 40731 read HALTs (source reconciler)", h)
check(reason.endswith(acct.COPY_KEY_TAG) and len(reason) <= 200 and "copy-trading or elite-trader" in reason
      and "regular account" in reason,
      "HALT reason names the kind of key to bind, ends with the marker, ≤ 200 chars", f"{len(reason)} {reason}")
check(len(sent) == 1 and "copy-trading or elite-trader" in sent[0] and acct.COPY_KEY_TAG not in sent[0]
      and "fix or rebind" not in sent[0],
      "Telegram says which key to bind, without the marker", sent)

guard.clear_halt("test")
del sent[:]
exc = acct.error_of(ENV, Reply("40006", "Invalid ACCESS_KEY"), "/api/v2/mix/position/all-position")
rec._on_read_failure("bitget", exc, acct.classify(exc), time.time())
h = guard.halt_info() or {}
check(guard.halted() and h.get("reason") == "the exchange rejected the API key / permission (bitget 40006)"
      and len(sent) == 1 and "fix or rebind the key" in sent[0],
      "any other CREDENTIAL code keeps the generic reason and Telegram line", (h, sent))

print("all ok" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
