"""統一 setup 的 pip (runtime/president_connect.run_setup) ignores the user's Python and pip setup
(audit desktop-python-isolation S3, 0.1.57): every pip it starts carries --isolated, and its env
has no PYTHON* / PIP_* from the daemon's environment (a PYTHONHOME from a GIS installer, a
PIP_INDEX_URL). No network, no pip runs: capital_connect._run_quiet is faked.

Run: cd blave-agent && .venv/bin/python tests/check_president_pip_isolated.py
"""
import os
import shutil
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = tempfile.mkdtemp(prefix="prespip-")
WS = os.path.join(TMP, "workspace")
for d in ("lib", "state", "manager"):
    os.makedirs(os.path.join(WS, d))
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = TMP
os.environ["BLAVE_AGENT_LOCAL"] = "1"
sys.path.insert(0, os.path.join(ROOT, "runtime"))
sys.path.insert(0, ROOT)

import capital_connect as cc  # noqa: E402
import president_connect as pc  # noqa: E402

fails = []


def check(name, cond, detail=None):
    print(("PASS  " if cond else "FAIL  ") + name + ("" if cond or detail is None else f"  <- {detail!r}"))
    if not cond:
        fails.append(name)


class _R:
    returncode = 0


calls = []


def fake_run(argv, timeout, what, env=None):
    calls.append((list(argv), env))
    return _R()


SET = {"PYTHONHOME": "/evil/home", "PYTHONPATH": "/evil/site", "pythonstartup": "/evil/s.py",
       "PIP_INDEX_URL": "https://evil.example/simple", "PIP_NO_BINARY": ":all:",
       "PYTHONUTF8": "1", "PYTHONPYCACHEPREFIX": "/blave/state/pycache"}  # the last two are the app's own
os.environ.update(SET)
cc._run_quiet = fake_run
sys.modules["cryptography"] = None  # import fails → the second pip (cryptography) runs too
try:
    pc.run_setup()
finally:
    for k in SET:
        os.environ.pop(k, None)
    del sys.modules["cryptography"]

pips = [(a, e) for a, e in calls if a[1:3] == ["-m", "pip"]]
check("both pip installs ran (unitrade, cryptography)", [a[-1] for a, _ in pips] == [pc.UNITRADE_PIN, "cryptography"],
      [a for a, _ in pips])
check("every pip carries --isolated (no pip.ini / PIP_* config)", pips and all("--isolated" in a for a, _ in pips),
      [a for a, _ in pips])
OWN = {"PYTHONUTF8": "1", "PYTHONPYCACHEPREFIX": "/blave/state/pycache"}
check("every pip env drops the user's PYTHON* / PIP_* (any case), keeps the app's PYTHONUTF8 / PYTHONPYCACHEPREFIX and the rest",
      pips and all(e is not None and {k: v for k, v in e.items() if k.upper().startswith(("PYTHON", "PIP_"))} == OWN
                   and e.get("BLAVE_AGENT_LOCAL") == "1" for _, e in pips),
      [sorted(k for k in (e or {}) if k.upper().startswith(("PYTHON", "PIP_"))) for _, e in pips])

shutil.rmtree(TMP, ignore_errors=True)
print("\n全綠" if not fails else f"\n{len(fails)} 紅")
sys.exit(1 if fails else 0)
