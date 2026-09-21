"""official_venues() never routes a data-source id (DATA_<SOURCE>_*) — no network.

Worst case on purpose: the DATA pair is in .env, BOTH official-shaped libs exist on disk
and the id is in the UI bind manifest — everything that makes a real venue route. It still
must not. Same rule as runtime command_listener._is_data_cred_id: judged on the id, so a
venue whose id is exactly DATA (env DATA_API_KEY) is NOT a data source.
Run: cd blave-agent && .venv/bin/python tests/check_venue_wiring_data_skip.py
"""
import json, os, shutil, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from lib import venue_wiring as vw  # noqa: E402

WS = tempfile.mkdtemp(prefix="vw-dataskip-")
os.makedirs(os.path.join(WS, "lib"))
os.makedirs(os.path.join(WS, "manager"))
IDS = ["data_polygon", "data_fred", "data", "okx"]
for vid in IDS:
    for kind in ("account", "order"):
        open(os.path.join(WS, "lib", f"{kind}_{vid}.py"), "w").close()
with open(os.path.join(WS, "manager", "credentials.ui.json"), "w") as f:
    json.dump({"ids": IDS}, f)
os.chdir(WS)

env = {
    "DATA_POLYGON_API_KEY": "k", "DATA_POLYGON_SECRET_KEY": "s",
    "data_fred_api_key": "k", "data_fred_password": "p",
    "DATA_API_KEY": "k", "DATA_SECRET_KEY": "s",
    "OKX_API_KEY": "k", "OKX_SECRET_KEY": "s", "OKX_PASSPHRASE": "p",
    "blave_api_key": "k",
}
fails = 0
def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1

got = vw.official_venues(env)
check("data_polygon" not in got, f"DATA_POLYGON pair + libs + manifest: not a venue ({got})")
check("data_fred" not in got, f"lowercase data_fred pair: not a venue ({got})")
check(got == ["data", "okx"], f"real venue and the id that is exactly DATA still route ({got})")
check(not os.path.exists(os.path.join(WS, "state")), "no manifest alert fired for the skipped ids")

os.chdir(ROOT)
shutil.rmtree(WS)
print("FAILED" if fails else "all ok")
sys.exit(1 if fails else 0)
