"""A rebind that evicts the old venue HALTs before the new keys reach .env (work order
live-order-batch0 C). The reconciler re-reads .env every round, so with the HALT after the
write a round in between traded the whole target on the new account.

- trip_halt runs while .env still holds the old pair and none of the new one (paper → OKX,
  the switch to real money, and OKX → BingX).
- trip_halt raising: the bind is refused, .env and the manifest are unchanged, no HALT.
- the .env write failing after the HALT: the command fails, the HALT stays.

Runtime only, no network. Keys are not-a-real-* strings.
Run: cd blave-agent && .venv/bin/python tests/check_rebind_halt_first.py
"""
import os
import shutil
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = tempfile.mkdtemp(prefix="rebind-halt-")
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = BASE
WS = os.path.join(BASE, "workspace")
shutil.copytree(os.path.join(ROOT, "lib"), os.path.join(WS, "lib"),
                ignore=shutil.ignore_patterns("__pycache__"))
os.makedirs(os.path.join(WS, "state"))
os.makedirs(os.path.join(WS, "manager"))
with open(os.path.join(WS, "manager", "portfolio_config.json"), "w") as f:
    f.write("{}")
os.environ["BLAVE_AGENT_BASE"] = BASE
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.pop("BLAVE_AGENT_LOCAL", None)
os.chdir(WS)
sys.path.insert(0, os.path.join(ROOT, "runtime"))

import command_listener as cl  # noqa: E402

sys.path.insert(0, WS)
import lib.account_okx as _okx  # noqa: E402
import lib.account_bingx as _bingx  # noqa: E402
from lib import guard  # noqa: E402


def _no_account_id(env):
    raise RuntimeError("no network in this test")


_okx.get_account_id = _bingx.get_account_id = _no_account_id
cl._sync_strategy_crons = lambda names: None

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


ENV = os.path.join(WS, ".env")
HALT = os.path.join(WS, "state", "HALT")
MANIFEST = os.path.join(WS, "manager", "credentials.ui.json")
PAPER = {"PAPER_API_KEY": "paper", "PAPER_SECRET_KEY": "paper", "PAPER_BOUND_TS": "100"}
OKX = {"OKX_API_KEY": "not-a-real-okx-key", "OKX_SECRET_KEY": "not-a-real-okx-secret",
       "OKX_PASSPHRASE": "not-a-real-okx-pass"}
BINGX = {"BINGX_API_KEY": "not-a-real-bingx-key", "BINGX_SECRET_KEY": "not-a-real-bingx-secret"}
REAL_TRIP = guard.trip_halt


def fresh(env):
    for p in (HALT, MANIFEST):
        if os.path.exists(p):
            os.remove(p)
    guard._halt_flag = False
    guard.trip_halt = REAL_TRIP
    with open(ENV, "w") as f:
        f.write("BLAVE_API_KEY=bk\nBLAVE_SECRET_KEY=bs\n" + "".join(f"{k}={v}\n" for k, v in env.items()))


def bind(env):
    return cl.dispatch({"cmd": "credentials", "args": {"env": dict(env)}})


def read(path):
    try:
        with open(path) as f:
            return f.read()
    except FileNotFoundError:
        return None


def has(text, env):
    return all(f"{k}={v}" in text.splitlines() for k, v in env.items())


def lacks(text, env):
    """None of env's pair fields (PAPER_BOUND_TS is no pair field and outlives an eviction)."""
    pair = {k for k in env if k.endswith(("_API_KEY", "_SECRET_KEY", "_PASSPHRASE"))}
    return not any(l.split("=", 1)[0] in pair for l in text.splitlines())


# ── the HALT goes on while the old keys are still the bound ones ────────────────────────
for old, new, name in ((PAPER, OKX, "paper → okx"), (OKX, BINGX, "okx → bingx")):
    fresh(old)
    seen = []

    def spy(reason, source, **extra):
        seen.append((reason, read(ENV)))
        return REAL_TRIP(reason, source, **extra)

    guard.trip_halt = spy
    bind(new)
    body = read(ENV)
    check(len(seen) == 1 and has(seen[0][1], old) and lacks(seen[0][1], new),
          f"{name}: trip_halt sees the old pair in .env and none of the new one")
    check(len(seen) == 1 and seen[0][0].startswith("venue rebind (") and seen[0][0].endswith(" evicted)"),
          f"{name}: reason stays 'venue rebind (<ids> evicted)' ({seen and seen[0][0]})")
    check(os.path.isfile(HALT) and has(body, new) and lacks(body, old),
          f"{name}: bound to the new venue, HALT on disk")

# a bind that evicts nothing does not halt
fresh({})
guard.trip_halt = lambda *a, **k: check(False, "first bind: trip_halt not called")
bind(OKX)
check(not os.path.exists(HALT) and has(read(ENV), OKX), "first bind (nothing evicted): no HALT")

# ── trip_halt raising: nothing written, the command fails ──────────────────────────────
fresh(OKX)
before_env, before_manifest = read(ENV), read(MANIFEST)


def boom(reason, source, **extra):
    raise OSError("disk full")


guard.trip_halt = boom
try:
    bind(BINGX)
    check(False, "halt failure: the command fails")
except RuntimeError as e:
    check("rebind halt not set" in str(e) and "not-a-real" not in str(e),
          f"halt failure: the command fails, no key value in the error ({e})")
check(read(ENV) == before_env, "halt failure: .env unchanged")
check(read(MANIFEST) == before_manifest, "halt failure: manifest unchanged")
check(not os.path.exists(HALT), "halt failure: no HALT file")

# a HALT that lands outside the workspace (wrong cwd) is the same failure
fresh(OKX)
before_env = read(ENV)
guard.trip_halt = lambda reason, source, **extra: None
try:
    bind(BINGX)
    check(False, "HALT not on disk: the command fails")
except RuntimeError:
    check(read(ENV) == before_env, "HALT not on disk: the command fails, .env unchanged")

# ── the .env write failing after the HALT: the HALT stays, the command fails ───────────
fresh(OKX)
before_env = read(ENV)
real_replacing = cl.atomic_file.replacing


def broken(path, *a, **k):
    if path == ENV:
        raise OSError("write failed")
    return real_replacing(path, *a, **k)


cl.atomic_file.replacing = broken
try:
    bind(BINGX)
    check(False, "write failure: the command fails")
except OSError:
    check(True, "write failure: the command fails")
finally:
    cl.atomic_file.replacing = real_replacing
check(os.path.isfile(HALT) and read(ENV) == before_env, "write failure: HALT kept, .env unchanged")

guard.trip_halt = REAL_TRIP
os.chdir(ROOT)
shutil.rmtree(BASE, ignore_errors=True)
print("FAILED" if fails else "ALL OK")
sys.exit(1 if fails else 0)
