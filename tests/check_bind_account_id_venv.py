"""A cloud bind records the exchange account id even though the bridge's own venv
(/opt/blave-agent/venv) has no `requests`: the id is read by the workspace interpreter
(command_listener._read_bind_account_ids), the same one _tick_one runs wait_for_bar under.
Before, the read ran in-process, every lib.account_* import failed, lib.portfolio took that
for "no account lib", and no cloud bind ever recorded an id.

  ① premise: in this process `requests` cannot import, so an in-process read sees no lib;
  ② a cloud OKX bind still records venue_account.okx.id from the workspace child;
  ③ the keys never reach the child's argv;
  ④ a venue whose lib does import here is still read in-process — only the others go to the child.

Run: cd blave-agent && .venv/bin/python tests/check_bind_account_id_venv.py
"""
import json
import os
import socket
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = tempfile.mkdtemp(prefix="bind-acct-venv-")
WS = os.path.join(BASE, "workspace")
LIB = os.path.join(WS, "lib")
os.makedirs(os.path.join(WS, "manager"))
os.makedirs(LIB)
for n in os.listdir(os.path.join(ROOT, "lib")):
    if n not in ("account_okx.py", "account_gateio.py", "__pycache__"):
        os.symlink(os.path.join(ROOT, "lib", n), os.path.join(LIB, n))
with open(os.path.join(LIB, "account_okx.py"), "w") as f:
    f.write("import requests  # noqa: F401  — what every real account lib needs\n"
            "def get_account_id(env):\n"
            "    return 'OKX-UID-7' if env.get('OKX_API_KEY') == 'okx-key' else None\n")
with open(os.path.join(LIB, "account_gateio.py"), "w") as f:
    f.write("def get_account_id(env):\n"
            "    return 'GATE-IN-PROCESS-%d' % __import__('os').getpid()\n")
with open(os.path.join(WS, "manager", "portfolio_config.json"), "w") as f:
    f.write("{}")
os.environ["BLAVE_AGENT_BASE"] = BASE
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.pop("BLAVE_AGENT_LOCAL", None)
sys.path.insert(0, os.path.join(ROOT, "runtime"))
os.chdir(WS)


def _no_network(*a, **k):
    raise OSError("no network in this test")


socket.socket.connect = _no_network

import command_listener as cl  # noqa: E402

sys.modules["requests"] = None  # the bridge venv: `import requests` → ImportError
cl._sync_strategy_crons = lambda names: None
cl._workspace_python = lambda: sys.executable  # stands in for the box's python3, which has it
ARGV = []
_run = subprocess.run


def _spy(cmd, *a, **k):
    ARGV.append(list(cmd))
    return _run(cmd, *a, **k)


subprocess.run = _spy

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


sys.path.insert(0, WS)
from lib import portfolio  # noqa: E402

check(portfolio._read_account_id("okx", {"OKX_API_KEY": "okx-key"}) == (None, None, False),
      "① in-process read in a venv without requests sees no account lib")

env = {"OKX_API_KEY": "okx-key", "OKX_SECRET_KEY": "okx-secret", "OKX_PASSPHRASE": "okx-pass"}
try:
    r = cl.dispatch({"cmd": "credentials", "args": {"env": env}})
except Exception as e:
    r = e
seed_path = os.path.join(WS, "manager", "ledger_seed.json")
seed = json.load(open(seed_path)) if os.path.exists(seed_path) else {}
rec = (seed.get("venue_account") or {}).get("okx") or {}
check(isinstance(r, dict) and r.get("book_account") == {"okx": "ok"} and rec.get("id") == "OKX-UID-7",
      f"② cloud bind records the account id read by the workspace interpreter ({r}, {rec})")
child = [c for c in ARGV if cl._ACCOUNT_ID_PY in c]
check(len(child) == 1 and not any(v in " ".join(child[0]) for v in env.values()),
      f"③ one child read, no key on its argv ({child})")

ARGV.clear()
got = cl._bind_book_accounts(["OKX", "GATEIO"])
seed = json.load(open(seed_path))
gate = ((seed.get("venue_account") or {}).get("gateio") or {}).get("id")
child = [c for c in ARGV if cl._ACCOUNT_ID_PY in c]
check(got.get("gateio") == "ok" and gate == f"GATE-IN-PROCESS-{os.getpid()}"
      and len(child) == 1 and child[0][3:] == ["okx"],
      f"④ importable lib read in-process, only okx sent to the child ({got}, {gate}, {child})")

print("ALL PASS" if not fails else f"{fails} FAIL")
sys.exit(1 if fails else 0)
