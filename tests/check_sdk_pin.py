"""runtime/sdk_pin.py + sdk_sync.py: the SDK pin rides the runtime release.

  1. one pin: runtime/SDK_VERSION is x.y.z, the desktop's AGENT_SDK and both
     provision scripts follow it, publish packs it with sdk_pin/sdk_sync and
     the sdk units, jobs.json schedules the job on both OSes
  2. sdk_pin only switches on a `.ready` whose first token EQUALS the pin and
     a bundled CLI that exists; an import failing from the pin dir falls back
     to the venv with none of the pin dir's modules left in sys.modules
  3. sdk_sync: never downgrades (venv ≥ pin → nothing installed, a leftover
     pin dir is removed), skips on low disk before pip, cleans .tmp on failure
     and stops after MAX_FAILS for that pin, writes `.ready` only after the
     real self-check (fake packages: no _bundled, wrong --version, wrong
     __version__, an empty install that would import the venv's copy), keeps
     the current + previous pin, honours a fresh lock and clears a stale one
  4. importing sdk_pin / sdk_sync touches nothing (the updater's health check
     imports every release module)
  5. with --net: publish's preflight refuses 0.2.160 (no win_amd64 wheel) and
     accepts 0.2.159

POSIX only (the fake CLI is a shell script). No network unless --net.
Run: cd blave-agent && python3 tests/check_sdk_pin.py [--net]
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import textwrap
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNTIME = os.path.join(ROOT, "runtime")
API = os.path.join(os.path.dirname(ROOT), "api")
TMP = tempfile.mkdtemp(prefix="sdk-pin-")
os.environ["BLAVE_AGENT_BASE"] = os.path.join(TMP, "base")
sys.path.insert(0, RUNTIME)
sys.path.insert(0, ROOT)

import sdk_pin  # noqa: E402
import sdk_sync  # noqa: E402

failures = []


def check(label, ok, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else f"  {detail}"))
    if not ok:
        failures.append(label)


def write(path, text, mode=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)
    if mode:
        os.chmod(path, mode)


def fake_pkg(d, sdk="0.2.159", cli="2.1.281", reported=None, bundled=True, broken=False):
    """A claude_agent_sdk-shaped package (plus a dependency) under d."""
    pkg = os.path.join(d, "claude_agent_sdk")
    write(os.path.join(pkg, "_version.py"), f'__version__ = "{sdk}"\n')
    write(os.path.join(pkg, "_cli_version.py"), f'__cli_version__ = "{cli}"\n')
    write(os.path.join(pkg, "_errors.py"), "class E(Exception): pass\n")
    write(os.path.join(d, "fakedep", "__init__.py"), f'WHERE = {d!r}\n')
    body = "from . import _errors\nimport fakedep\nfrom ._version import __version__\n"
    if broken:
        body += "raise ImportError('half-installed')\n"
    write(os.path.join(pkg, "__init__.py"), body)
    if bundled:
        write(os.path.join(pkg, "_bundled", sdk_pin.CLI_NAME),
              f"#!/bin/sh\necho '{reported or cli} (Claude Code)'\n", 0o755)
    return d


def ready(root, pin, content=None, bundled=True):
    d = os.path.join(root, pin)
    fake_pkg(d, sdk=pin, bundled=bundled)
    write(os.path.join(d, ".ready"), content if content is not None else f"{pin} 2.1.281\n")
    return d


# ── 1. one pin ──────────────────────────────────────────────────────────────
pin = open(os.path.join(RUNTIME, "SDK_VERSION")).read().strip()
check("runtime/SDK_VERSION is x.y.z", re.fullmatch(r"\d+\.\d+\.\d+", pin) is not None, pin)
main_js = open(os.path.join(ROOT, "shell", "main.js"), encoding="utf-8").read()
check("desktop AGENT_SDK == SDK_VERSION",
      f'const AGENT_SDK = "claude-agent-sdk=={pin}";' in main_js)
jobs = json.load(open(os.path.join(RUNTIME, "jobs.json")))
check("jobs.json: Linux sdk timer enabled, service not",
      jobs["linux_units"].get("blave-agent-sdk.timer") == {"enable": True}
      and jobs["linux_units"].get("blave-agent-sdk.service") == {"enable": False})
check("jobs.json: Windows task runs current/sdk_sync.py on the venv",
      (jobs["windows_tasks"].get("blave-agent-sdk") or {}).get("script") == "current/sdk_sync.py"
      and jobs["windows_tasks"]["blave-agent-sdk"].get("bin") == "venv")
if os.path.isdir(API):
    sh = open(os.path.join(API, "blave_agent", "provision.sh"), encoding="utf-8").read()
    ps = open(os.path.join(API, "blave_agent", "provision.ps1"), encoding="utf-8").read()
    check("provision.sh reads runtime/SDK_VERSION, no literal pin",
          'SDK_VERSION="$(cat "$HERE/runtime/SDK_VERSION")"' in sh
          and not re.search(r"^SDK_VERSION=\d", sh, re.M)
          and '"$HERE"/runtime/SDK_VERSION "$BASE/releases/$ver/"' in sh)
    check("provision.ps1 reads runtime\\SDK_VERSION, no literal pin",
          "Join-Path $Here 'runtime\\SDK_VERSION'" in ps
          and not re.search(r"^\$SdkVersion\s*=\s*'\d", ps, re.M)
          and "Copy-Item (Join-Path $Here 'runtime\\SDK_VERSION') $rel" in ps)
    import publish
    import io
    import tarfile
    _, data = publish.build_tarball()
    names = set(tarfile.open(fileobj=io.BytesIO(data)).getnames())
    want = {"SDK_VERSION", "sdk_pin.py", "sdk_sync.py", "blave-agent-sdk.service",
            "blave-agent-sdk.timer"}
    check("publish tarball carries the pin, both modules and the sdk units",
          want <= names, sorted(want - names))
else:
    check("api checkout beside blave-agent (provision / publish checks)", False, API)

# ── 2. sdk_pin ──────────────────────────────────────────────────────────────
root = os.path.join(TMP, "pin-root")
os.makedirs(root)
check("no pin dir → None", sdk_pin.ready_dir("0.2.159", root) is None)
d = os.path.join(root, "0.2.159")
fake_pkg(d)
check("dir without .ready → None", sdk_pin.ready_dir("0.2.159", root) is None)
write(os.path.join(d, ".ready"), "0.2.158 2.1.281\n")
check(".ready for another pin → None", sdk_pin.ready_dir("0.2.159", root) is None)
ready(root, "0.2.15", content="0.2.159 2.1.281\n")
check("pin 0.2.15 does not match `0.2.159 …`", sdk_pin.ready_dir("0.2.15", root) is None)
write(os.path.join(d, ".ready"), "0.2.159 2.1.281\n")
check("matching .ready + bundled CLI → the dir", sdk_pin.ready_dir("0.2.159", root) == d)
os.remove(os.path.join(d, "claude_agent_sdk", "_bundled", sdk_pin.CLI_NAME))
check("bundled CLI missing → None", sdk_pin.ready_dir("0.2.159", root) is None)
check("bad pin file → None", sdk_pin.read_pin(os.path.join(TMP, "nope")) is None)
write(os.path.join(TMP, "badpin"), "0.2.x\n")
check("malformed pin → None", sdk_pin.read_pin(os.path.join(TMP, "badpin")) is None)

PROBE = textwrap.dedent("""
    import json, os, sys
    sys.path.insert(0, sys.argv[1])          # the venv
    sys.path.insert(0, sys.argv[2])          # runtime/
    import sdk_pin
    sdk = sdk_pin.load(pin_file=sys.argv[3], root=sys.argv[4])
    import fakedep, claude_agent_sdk._errors as e
    print(json.dumps({"ver": sdk.__version__, "dep": fakedep.WHERE, "err": e.__file__,
                      "path": [p for p in sys.path if p.startswith(sys.argv[4])]}))
""")


def load_in_child(venv, root, pin_file):
    r = subprocess.run([sys.executable, "-c", PROBE, venv, RUNTIME, pin_file, root],
                       capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        return {"error": r.stderr[-400:]}
    return json.loads(r.stdout.strip().splitlines()[-1])


venv = fake_pkg(os.path.join(TMP, "venv"), sdk="0.2.144", cli="2.1.239")
pinf = os.path.join(TMP, "pinfile")
write(pinf, "0.2.159\n")
root2 = os.path.join(TMP, "load-root")
ready(root2, "0.2.159")
got = load_in_child(venv, root2, pinf)
check("ready pin dir → the turn imports the pin's SDK and its deps",
      got.get("ver") == "0.2.159" and got.get("dep", "").startswith(root2), got)
root3 = os.path.join(TMP, "broken-root")
bd = os.path.join(root3, "0.2.159")
fake_pkg(bd, broken=True)
write(os.path.join(bd, ".ready"), "0.2.159 2.1.281\n")
got = load_in_child(venv, root3, pinf)
check("pin dir import fails → venv SDK, nothing from the pin dir left loaded",
      got.get("ver") == "0.2.144" and got.get("dep") == venv
      and got.get("err", "").startswith(venv) and got.get("path") == [], got)
got = load_in_child(venv, os.path.join(TMP, "empty-root"), pinf)
check("no pin dir → venv SDK", got.get("ver") == "0.2.144", got)

st = sdk_pin.status(pin_file=pinf, root=root2)
check("status() reports the active pin from .ready",
      st == {"pin": "0.2.159", "active": "pin", "sdk": "0.2.159", "cli": "2.1.281"}, st)
sys.path.insert(0, venv)
st = sdk_pin.status(pin_file=pinf, root=root3 + "-none")
sys.path.remove(venv)
check("status() reports the venv's versions when the pin is not ready",
      st == {"pin": "0.2.159", "active": "venv", "sdk": "0.2.144", "cli": "2.1.239"}, st)

# ── 3. sdk_sync ─────────────────────────────────────────────────────────────
GB = 1024 ** 3


def env(name):
    base = os.path.join(TMP, name)
    os.makedirs(base)
    return dict(pin_file=pinf, root=os.path.join(base, "sdk"),
                state_path=os.path.join(base, "state", "sdk_sync.json"),
                lock_path=os.path.join(base, "state", "sdk_sync.lock"))


def no_install(pin, target):
    raise AssertionError("pip must not run here")


def fake_install(**kw):
    def install(pin, target):
        fake_pkg(target, sdk=pin, **kw)
    return install


def run(e, venv_ver="0.2.144", install=no_install, free=8 * GB, **kw):
    return sdk_sync.run(venv=lambda: (venv_ver, "x"), install=install,
                        free=lambda p: free, **e, **kw)


e = env("noop")
rec = run(e, venv_ver="0.2.159")
check("venv == pin → no install", rec and rec.get("skip") == "venv_at_or_above_pin", rec)
check("…and the second pass writes nothing new", run(e, venv_ver="0.2.159") is None)

e = env("nodown")
ready(e["root"], "0.2.159")
rec = run(e, venv_ver="0.2.160")
check("venv newer than pin → never downgrade, leftover pin dir removed",
      rec.get("skip") == "venv_at_or_above_pin" and not os.listdir(e["root"]), rec)
check("version compare is numeric (0.2.16 < 0.2.159)",
      run(env("numeric"), venv_ver="0.2.16", install=fake_install()).get("ok") is True)

e = env("disk")
rec = run(e, free=1 * GB)
check("free < 1.5GB → skipped before pip, no .tmp",
      rec.get("error") == "disk" and not os.path.exists(os.path.join(e["root"], "0.2.159.tmp")),
      rec)

e = env("fail")
calls = []


def failing(pin, target):
    calls.append(pin)
    os.makedirs(os.path.join(target, "partial"))
    raise RuntimeError("pip rc=1")


for _ in range(sdk_sync.MAX_FAILS + 2):
    rec = run(e, install=failing)
check("pip failure → .tmp removed", not os.path.exists(os.path.join(e["root"], "0.2.159.tmp")))
check(f"stops after {sdk_sync.MAX_FAILS} failures for the same pin",
      len(calls) == sdk_sync.MAX_FAILS, len(calls))
write(pinf, "0.2.160\n")
run(e, install=failing)
check("a new pin starts counting again", len(calls) == sdk_sync.MAX_FAILS + 1, len(calls))
write(pinf, "0.2.159\n")

for i, (label, kw) in enumerate([("no _bundled CLI", dict(bundled=False)),
                  ("--version reports another CLI", dict(reported="2.1.239")),
                  ("__version__ is not the pin", dict(sdk="0.2.158"))]):
    e = env(f"bad{i}")
    inst = fake_install(**kw)
    if "sdk" in kw:
        inst = (lambda k: lambda pin, target: fake_pkg(target, **k))(kw)
    rec = run(e, install=inst)
    check(f"self-check rejects: {label} (no .ready, no dir)",
          rec.get("error") and not os.path.exists(os.path.join(e["root"], "0.2.159"))
          and sdk_pin.ready_dir("0.2.159", e["root"]) is None, rec)

e = env("emptyinstall")
same = fake_pkg(os.path.join(TMP, "venv-same"))  # same version as the pin: only __file__ tells
os.environ["PYTHONPATH"] = same
rec = run(e, install=lambda pin, target: os.makedirs(target))
os.environ.pop("PYTHONPATH")
check("self-check rejects an install that imports someone else's claude_agent_sdk",
      "not the new install" in (rec.get("error") or ""), rec)

e = env("ok")
rec = run(e, install=fake_install())
d = os.path.join(e["root"], "0.2.159")
check("success → .ready written after the check, content `<pin> <cli>`",
      rec.get("ok") and open(os.path.join(d, ".ready")).read() == "0.2.159 2.1.281\n", rec)
check("…and sdk_pin now picks it", sdk_pin.ready_dir("0.2.159", e["root"]) == d)
check("ready pin → next pass does nothing", run(e) is None)
ready(e["root"], "0.2.150")
write(pinf, "0.2.160\n")
rec = run(e, install=fake_install(cli="2.1.283"))
write(pinf, "0.2.161\n")
rec = run(e, install=fake_install(cli="2.1.284"))
check("keeps the current and the previous pin only",
      sorted(os.listdir(e["root"])) == ["0.2.160", "0.2.161"]
      and rec.get("prev") == "0.2.160", (os.listdir(e["root"]), rec))
write(pinf, "0.2.159\n")

e = env("lock")
write(e["lock_path"], "")
check("a fresh lock → this pass stays out", run(e) is None)
old = time.time() - sdk_sync.LOCK_STALE_S - 10
os.utime(e["lock_path"], (old, old))
check("a stale lock is cleared", run(e, install=fake_install()).get("ok") is True)
check("lock released after the run", not os.path.exists(e["lock_path"]))

e = env("report")
run(e, free=0)
st = sdk_sync.report(state_path=e["state_path"])
check("report() = status + why the pin is not active", st.get("error") == "disk"
      and st.get("pin") == "0.2.159" and "active" in st, st)

# ── 4. import has no side effects ───────────────────────────────────────────
base = os.path.join(TMP, "import-base")
os.makedirs(base)
r = subprocess.run([sys.executable, "-c", "import sdk_pin, sdk_sync"], cwd=RUNTIME,
                   env=dict(os.environ, BLAVE_AGENT_BASE=base), capture_output=True, text=True)
check("import sdk_pin, sdk_sync writes nothing",
      r.returncode == 0 and os.listdir(base) == [], (r.stderr[-200:], os.listdir(base)))

# ── 5. publish preflight (network) ──────────────────────────────────────────
if "--net" in sys.argv:
    import publish
    check("preflight refuses 0.2.160 (no win_amd64 wheel)",
          publish.sdk_preflight("0.2.160") == ["win_amd64/py3.14", "win_amd64/py3.12"],
          publish.sdk_preflight("0.2.160"))
    check("preflight accepts 0.2.159", publish.sdk_preflight("0.2.159") == [])

import shutil  # noqa: E402
shutil.rmtree(TMP, ignore_errors=True)
print(f"\n{'FAIL' if failures else 'OK'}: {len(failures)} failure(s)")
sys.exit(1 if failures else 0)
