"""Minimal check (spec order-unknown-outcome §5): every crypto venue lib's
OrderNotConfirmed subclasses lib.unconfirmed.OrderOutcomeUnknown, so a result-unknown
order is parked by its own class — never left to the venue_wiring name-based wrapper.
Enumerates lib/order_*.py; a new venue defining the class without the base fails here.
order_sinopac is excluded: the TW brokers keep their own unconfirmed system (spec §4.7).
No network.

Run: cd blave-agent && .venv/bin/python tests/check_outcome_unknown_enum.py
"""
import glob
import importlib
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("MPLBACKEND", "Agg")

from lib.unconfirmed import OrderOutcomeUnknown

TW_OWN_SYSTEM = {"order_sinopac"}

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


found = []
for path in sorted(glob.glob(os.path.join(ROOT, "lib", "order_*.py"))):
    name = os.path.basename(path)[:-3]
    with open(path, encoding="utf-8") as f:
        if not re.search(r"^class OrderNotConfirmed\b", f.read(), re.M):
            continue
    found.append(name)
    if name in TW_OWN_SYSTEM:
        continue
    mod = importlib.import_module(f"lib.{name}")
    check(issubclass(mod.OrderNotConfirmed, OrderOutcomeUnknown),
          f"{name}.OrderNotConfirmed subclasses OrderOutcomeUnknown")

check(len([n for n in found if n not in TW_OWN_SYSTEM]) >= 7,
      f"enumerated the crypto venue libs ({', '.join(found)})")

print("all ok" if not fails else f"{fails} failed")
sys.exit(1 if fails else 0)
