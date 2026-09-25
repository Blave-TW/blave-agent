"""Data-source credentials (DATA_<SOURCE>_<FIELD>) are never a venue — no network.

A paired DATA_POLYGON_API_KEY + DATA_POLYGON_SECRET_KEY has the exact shape of a bound
exchange. Pins, against the real runtime/command_listener.py + portfolio_reporter.py:
  1. binding paper, then switching venue (paper → okx), leaves every DATA_* line byte-identical,
     evicts only the real venue, and the HALT names only that venue;
  1b. the credentials command refuses any DATA_* id in its payload (ValueError, .env untouched);
  2. the first bind (nothing to evict) raises no HALT at all despite the DATA pair;
  3. credentials.ui.json never lists a data id; the reporter's venues() never reports one;
  4. unbinding the exchange keeps DATA_* and treats the machine as unbound (data pair is not
     "a venue left"); removing a DATA key is not an unbind — no HALT; but a venue whose id is
     exactly DATA (env DATA_API_KEY) still unbinds like any venue — the prefix is judged on the
     id, never on the env name; account_reader skips data ids even when an account lib exists;
  5. enumeration: every DATA_-prefixed id shape is skipped by _venue_cred_ids, every
     non-DATA look-alike still counts.
Run: cd blave-agent && .venv/bin/python tests/check_data_cred_skip.py
"""
import importlib.util, json, os, shutil, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNTIME = os.path.join(ROOT, "runtime")
BASE = tempfile.mkdtemp(prefix="datacred-")
WS = os.path.join(BASE, "workspace")
os.makedirs(os.path.join(WS, "manager"))
with open(os.path.join(WS, "manager", "portfolio_config.json"), "w") as f:
    f.write("{}")
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.pop("BLAVE_AGENT_LOCAL", None)
sys.path.insert(0, ROOT)      # lib.guard (trip_halt)
sys.path.insert(0, RUNTIME)   # runtime sibling imports
os.chdir(WS)


def load(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(RUNTIME, name + ".py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


cl = load("command_listener")
import lib.account_okx as _okx  # noqa: E402

_okx.withdraw_enabled = lambda env: False  # the cloud withdrawal gate has its own test (check_credentials_withdraw_gate)
pr = load("portfolio_reporter")
# never touch this machine's crontab / services from a test
SYNCED, STOPPED = [], []
cl._sync_strategy_crons = lambda names: SYNCED.append(set(names))
cl._stop_reconciler = lambda: STOPPED.append(1) or True

ENV = os.path.join(WS, ".env")
HALT = os.path.join(WS, "state", "HALT")
MANIFEST = os.path.join(WS, "manager", "credentials.ui.json")
DATA_LINES = ["DATA_POLYGON_API_KEY=dp-key-5b1e", "DATA_POLYGON_SECRET_KEY=dp-sec-9c2a",  # gitleaks:allow (fake)
              "data_fred_api_key=df-key-77aa", "data_fred_password=df-pw-31bd"]  # gitleaks:allow (fake)
with open(ENV, "w") as f:
    f.write("\n".join(["blave_api_key=bk", "blave_secret_key=bs", "# mine"] + DATA_LINES) + "\n")

fails = 0
def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1

def env_lines():
    with open(ENV) as f:
        return f.read().splitlines()

def manifest_ids():
    with open(MANIFEST) as f:
        return json.load(f)["ids"]

def data_intact():
    return [l for l in env_lines() if l.upper().startswith("DATA_")] == DATA_LINES

# ── 1st bind: paper over a .env that already holds two paired data sources
cl._in_workspace(cl._cmd_credentials, {"env": {"PAPER_API_KEY": "paper", "PAPER_SECRET_KEY": "paper"}})
check(data_intact(), "bind paper: DATA_* lines byte-identical, same order")
check(not os.path.exists(HALT), "bind paper: no HALT (the data pairs were not read as evicted venues)")
check(manifest_ids() == ["paper"], f"bind paper: manifest = ['paper'] ({manifest_ids()})")

# ── switch venue: paper → okx
cl._in_workspace(cl._cmd_credentials, {"env": {
    "OKX_API_KEY": "ok-key-1d4f", "OKX_SECRET_KEY": "ok-sec-8e3b", "OKX_PASSPHRASE": "ok-pp-6a7c"}})  # gitleaks:allow (fake)
lines = env_lines()
check(data_intact(), "switch to okx: DATA_* lines byte-identical")
check(not any(l.startswith("PAPER_") for l in lines) and "OKX_API_KEY=ok-key-1d4f" in lines,
      "switch to okx: paper evicted, okx written")
check("blave_api_key=bk" in lines and "# mine" in lines, "switch to okx: blave keys + comment kept")
with open(HALT) as f:
    halt = json.load(f)
check("paper" in halt.get("reason", "") and "data" not in halt.get("reason", "").lower(),
      f"switch to okx: the one HALT names paper only ({halt.get('reason')})")
check(manifest_ids() == ["okx"], f"switch to okx: manifest = ['okx'] ({manifest_ids()})")

# ── status report
v = pr.venues()
check(set(v) == {"okx"}, f"reporter venues() = okx only ({sorted(v)})")

# ── a DATA_* id is refused by the credentials command — loudly, before .env is touched
#    (a custom exchange slugged DATA_MARKET would otherwise bind invisibly)
os.remove(HALT)
before = env_lines()
for payload in ({"DATA_TIINGO_API_KEY": "dt-key-0f0f", "DATA_TIINGO_SECRET_KEY": "dt-sec-1e1e"},  # gitleaks:allow (fake)
                {"data_market_api_key": "dt-key-0f0f"},  # gitleaks:allow (fake)
                {"OKX_API_KEY": "ok-key-1d4f", "DATA_X_PASSPHRASE": "dt-pp-2c2c"}):  # gitleaks:allow (fake)
    try:
        cl._in_workspace(cl._cmd_credentials, {"env": payload})
        err = None
    except ValueError as e:
        err = str(e)
    check(err is not None and "DATA_" in err and not any(v in err for v in payload.values())
          and env_lines() == before and not os.path.exists(HALT) and manifest_ids() == ["okx"],
          f"credentials refuses {sorted(payload)}: ValueError names the prefix, no value, .env/HALT/manifest untouched")
with open(ENV, "a") as f:  # a data pair that landed some other way (the future data channel)
    f.write("DATA_TIINGO_API_KEY=dt-key-0f0f\nDATA_TIINGO_SECRET_KEY=dt-sec-1e1e\n")  # gitleaks:allow (fake)
DATA_LINES += ["DATA_TIINGO_API_KEY=dt-key-0f0f", "DATA_TIINGO_SECRET_KEY=dt-sec-1e1e"]

# ── removing a data key is not an unbind
cl._in_workspace(cl._cmd_credentials_remove, {"env": ["DATA_TIINGO_API_KEY", "DATA_TIINGO_SECRET_KEY"]})
del DATA_LINES[-2:]
check(data_intact() and not os.path.exists(HALT) and not STOPPED and manifest_ids() == ["okx"],
      "remove DATA key: no HALT, reconciler untouched, okx still bound")

# ── unbinding the exchange: data stays, machine reads as unbound
cl._in_workspace(cl._cmd_credentials_remove, {"env": ["OKX_API_KEY", "OKX_SECRET_KEY", "OKX_PASSPHRASE"]})
check(data_intact() and not any(l.startswith("OKX_") for l in env_lines()), "unbind okx: DATA_* kept, okx gone")
with open(HALT) as f:
    halt = json.load(f)
check("okx" in halt.get("reason", "") and "data" not in halt.get("reason", "").lower(),
      f"unbind okx: HALT names okx only ({halt.get('reason')})")
check(manifest_ids() == [] and STOPPED == [1] and SYNCED[-1:] == [set()],
      "unbind okx: no venue left — manifest empty, schedules + daemon stopped (data pair is not a venue)")
check(pr.venues() == {}, "reporter venues() empty after unbind")

# ── a venue whose id IS "DATA" (custom exchange named "Data"): its env names start with the
#    prefix, its id does not — bind and unbind must agree it is a venue (same as before DATA_*)
with open(ENV, "w") as f:
    f.write("blave_api_key=bk\n")
# bound THROUGH the command (not by writing the file): the refusal must look at the id ("DATA"),
# not at the env name ("DATA_API_KEY") — judging the env name would refuse this legal venue
cl._in_workspace(cl._cmd_credentials, {"env": {"DATA_API_KEY": "dv-key-4c4c", "DATA_SECRET_KEY": "dv-sec-2d2d"}})  # gitleaks:allow (fake)
check(manifest_ids() == ["data"] and "DATA_API_KEY=dv-key-4c4c" in open(ENV).read(),
      f"venue id DATA: binds through the command and reaches the manifest ({manifest_ids()})")
if os.path.isfile(HALT):
    os.remove(HALT)
del STOPPED[:]
cl._in_workspace(cl._cmd_credentials_remove, {"env": ["DATA_API_KEY", "DATA_SECRET_KEY"]})
halted = os.path.isfile(HALT)
reason = json.load(open(HALT)).get("reason", "") if halted else ""
check(halted and "(data)" in reason and STOPPED == [1] and SYNCED[-1:] == [set()],
      f"venue id DATA: unbind halts + stops reconciler and schedules (HALT={halted} {reason!r}, stopped={STOPPED})")

# ── account_reader: a data source is not a venue even if lib/account_data_<src>.py exists
ar = load("account_reader")
os.makedirs(os.path.join(WS, "lib"))
for n in ("account_data_polygon.py", "account_okx.py", "account_data.py"):
    open(os.path.join(WS, "lib", n), "w").close()
got = ar._venues({"DATA_POLYGON_API_KEY": "x", "data_fred_api_key": "x", "OKX_API_KEY": "x",
                  "DATA_API_KEY": "x", "blave_api_key": "x"})
check(got == ["data", "okx"], f"account_reader._venues skips data_* ids, keeps okx and the venue 'data' ({got})")

# ── enumeration
def ids(*names):
    return cl._venue_cred_ids([n + "=x" for n in names])

SKIPPED = ["DATA_POLYGON", "data_polygon", "Data_Fred", "DATA_BYBIT", "DATA_A_B_C", "DATA_1"]
for i in SKIPPED:
    for sfx in ("SECRET_KEY", "PASSWORD", "PASSPHRASE"):
        check(ids(f"{i}_API_KEY", f"{i}_{sfx}") == set(), f"skipped: {i} + {sfx}")
COUNTED = ["BYBIT", "DATABENTO", "DATA", "MYDATA_X", "X_DATA_Y"]  # look-alikes that are NOT the prefix
for i in COUNTED:
    check(ids(f"{i}_API_KEY", f"{i}_SECRET_KEY") == {i}, f"still a venue: {i}")

shutil.rmtree(BASE)
print("FAILED" if fails else "ALL OK")
sys.exit(1 if fails else 0)
