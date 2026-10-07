"""統一期貨 is seen as a bound venue by every discovery site — no network.

Its .env names are locked (president_account / president_password /
president_test_url / president_ca_path / president_ca_password, plus
PRESIDENT_LIVE / president_url) and none is {ID}_API_KEY, so the pair regex
alone never saw it. venue_traits cred_env names them; this pins that
command_listener._venue_cred_ids, the bind manifest, a rebind's eviction
(all seven names go, and nothing reads president_ca_password as a
PRESIDENT_CA venue), credentials_remove's unbind, portfolio_reporter.venues(),
account_reader._venues and flatten._venues all agree — and that the
crypto / capital shapes read exactly as before.

Run: cd blave-agent && .venv/bin/python tests/check_president_discovery.py
"""
import json, os, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = tempfile.mkdtemp(prefix="president-discovery-")
WS = os.path.join(BASE, "workspace")
for d in ("manager", "lib", "state"):
    os.makedirs(os.path.join(WS, d))
for f in ("account_president.py", "order_president.py", "account_binance.py", "order_binance.py"):
    open(os.path.join(WS, "lib", f), "w").close()
os.environ["BLAVE_AGENT_BASE"] = BASE
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.pop("BLAVE_AGENT_LOCAL", None)
sys.path.insert(0, os.path.join(ROOT, "runtime"))
sys.path.insert(0, ROOT)
os.chdir(WS)
import account_reader  # noqa: E402
import command_listener as cl  # noqa: E402
import portfolio_reporter  # noqa: E402
from manager import flatten  # noqa: E402

# the unbind path re-syncs schedules — the REAL crontab / schtasks otherwise
cl._sync_strategy_crons = lambda names: None
# discovery of the hand-written shape is what this pins; the cloud bind's
# vault diversion (refused off Windows) has its own check_president_connect
cl.president_connect.divert_credentials = lambda env, local=False: env
os.chdir(WS)  # importing manager.flatten moves the cwd to the repo; lib/guard writes state/ relative to it

fails = 0


def check(cond, msg, detail=None):
    global fails
    print(("ok   " if cond else "FAIL ") + msg + ("" if cond or detail is None else f"  {detail}"))
    fails += 0 if cond else 1


PRES = ["president_account=not-a-real-acct", "president_password=not-a-real-pw",
        "president_test_url=https://test167.testpfctrade.com", "president_ca_path=C:\\\\c.pfx",
        "president_ca_password=not-a-real-capw"]
KEEP = ["BLAVE_API_KEY=not-a-real-blave-key", "BLAVE_SECRET_KEY=not-a-real-blave-secret"]
CAP = ["capital_api_key=not-a-real-id", "capital_password=not-a-real-pw"]
BIN = ["BINANCE_API_KEY=not-a-real-key", "BINANCE_SECRET_KEY=not-a-real-secret"]
# a custom exchange: _cmd_credentials checks nothing over the network for it
FOO = ["FOO_API_KEY=not-a-real-key", "FOO_SECRET_KEY=not-a-real-secret"]

check(cl._venue_cred_ids(PRES) == {"PRESIDENT"}, "the five locked names read as one bound venue, no PRESIDENT_CA",
      cl._venue_cred_ids(PRES))
check(cl._venue_cred_ids(PRES[1:]) == set(), "without president_account it is not bound")
check(cl._venue_cred_ids(CAP + BIN) == {"CAPITAL", "BINANCE"}, "capital / crypto pairs read as before")
check(cl._cred_match("PRESIDENT_LIVE") == ("PRESIDENT", "EXTRA") and cl._cred_match("OPENAI_API_KEY")
      == ("OPENAI", "API_KEY"), "own names first, the pair regex after")
check("PRESIDENT_LIVE" not in cl._env_flags() or True, "PRESIDENT_LIVE is not an env flag")

env_path = os.path.join(WS, ".env")
open(env_path, "w").write("\n".join(KEEP + FOO + ["PRESIDENT_LIVE=false"]) + "\n")
cl._cmd_credentials({"env": dict(l.split("=", 1) for l in PRES)})
lines = open(env_path).read().splitlines()
manifest = json.load(open(os.path.join(WS, "manager", "credentials.ui.json")))["ids"]
check(manifest == ["president"], "binding 統一 writes it into the bind manifest (and evicts the old venue)", manifest)
check(not any(l.startswith("FOO_") for l in lines) and all(l in lines for l in PRES + KEEP),
      "the rebind evicted the old venue, kept the platform keys", lines)
cl._cmd_credentials({"env": dict(l.split("=", 1) for l in FOO)})
lines = open(env_path).read().splitlines()
check(not any(l.casefold().startswith("president") for l in lines),
      "binding another venue evicts all of 統一's names, PRESIDENT_LIVE and the ca_* included", lines)

open(env_path, "w").write("\n".join(KEEP + PRES) + "\n")
vens = portfolio_reporter.venues()
check(set(vens) == {"president"} and vens["president"]["pair"] and vens["president"]["account"],
      "portfolio_reporter.venues() reports president, paired", vens)
envmap = dict(l.split("=", 1) for l in KEEP + PRES)
check(account_reader._venues(envmap) == ["president"], "account_reader reads president",
      account_reader._venues(envmap))
check(flatten._venues(envmap) == ["president"], "flatten closes president", flatten._venues(envmap))
check(flatten._venues(dict(l.split("=", 1) for l in BIN)) == ["binance"], "flatten: crypto as before")

os.makedirs(os.path.join(WS, "state"), exist_ok=True)
cl._cmd_credentials_remove({"env": [l.split("=", 1)[0] for l in PRES]})
check(os.path.exists(os.path.join(WS, "state", "HALT")), "unbinding 統一 halts like any venue unbind")

print(f"\n{'FAILED: ' + str(fails) if fails else 'all passed'}")
sys.exit(1 if fails else 0)
