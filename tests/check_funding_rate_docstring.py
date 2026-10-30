"""fetch_funding_rate's docstring alone must tell an agent how to label a funding-rate reply.

29026 twice quoted premiumIndex.lastFundingRate (the live estimate) as 「已結算」 or unlabelled:
the agent grepped lib/data.py's funding section and never opened references/lib.md. Asserted
offline: the docstring says 'alpha' is the predicted rate, names premiumIndex/lastFundingRate,
points at the settled-rate endpoint, gives both reply labels and the Taipei settlement times;
references/lib.md says the same; the return is still the single 'alpha' column.

Run: cd blave-agent && .venv/bin/python tests/check_funding_rate_docstring.py
"""
import os
import sys

import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import dotenv
dotenv.dotenv_values = lambda *a, **k: {}   # never read the workspace .env

import lib.data as data

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


doc = data.fetch_funding_rate.__doc__ or ""
for needle in ("PREDICTED", "never a settled one", "premiumIndex.lastFundingRate",
               "/fapi/v1/fundingRate", "本期即時預估", "上一期已結算",
               "台北 08:00 / 16:00 / 00:00", "fundingIntervalHours"):
    check(needle in doc, f"docstring has {needle!r}")

with open(os.path.join(ROOT, "references", "lib.md"), encoding="utf-8") as f:
    ref = f.read()
check("not a settled rate" in ref, "lib.md: values are the live estimate")
check("「上一期已結算" in ref and "「本期即時預估" in ref, "lib.md: both reply labels")
check("台北 08:00 / 16:00 / 00:00" in ref, "lib.md: Taipei settlement times")
check("`fetch_funding_rate` docstring states the same rule" in ref, "lib.md points at the docstring")

seen = {}


def fake_alpha(endpoint, params, headers, start, end):
    seen.update(endpoint=endpoint, params=dict(params))
    return pd.DataFrame({"alpha": [0.004]},
                        index=pd.DatetimeIndex(["2026-10-30"], tz="UTC", name="time"))


data._fetch_alpha = fake_alpha
df = data.fetch_funding_rate("BTCUSDT", "1h", "2026-10-29", "2026-10-30", {})
check(list(df.columns) == ["alpha"], "return columns unchanged: ['alpha']")
check(seen["endpoint"] == "funding_rate/get_alpha" and "exchange" not in seen["params"],
      "binance call keeps the cache-key params")

print("FAILS:", fails)
sys.exit(1 if fails else 0)
