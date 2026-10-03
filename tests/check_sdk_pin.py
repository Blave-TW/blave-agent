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
     the current + previous pin (only after a successful install, deferred
     while a turn runs, never on a missing state file), installs from the
     platform's hash lock and refuses without one, counts a `.bad` (a turn fell
     back) as a failure and reinstalls, resets the failure count after 24h,
     honours a fresh lock and clears a stale one; `.ready` as a FIFO does not
     hang; a .pth in the pin dir is replayed
  4. importing sdk_pin / sdk_sync touches nothing (the updater's health check
     imports every release module)
  5. publish: the committed hash locks are current and shipped; promote refuses a
     canary that is not newer or whose tarball does not match its sha256
  5b. lock completeness is judged under each target's own markers (a win32-only,
     a python<3.11-only and a darwin-only dep land only in their own lock; the
     committed Windows locks carry pywin32, the Linux 3.10 one exceptiongroup)
  6. with --net: `publish.py lock` cannot resolve 0.2.160 on Windows (no
     win_amd64 wheel), resolves 0.2.159 to exactly the committed lock, and every
     committed lock equals the closure from PyPI's Requires-Dist

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


def fake_pkg(d, sdk="0.2.159", cli="2.1.281", reported=None, bundled=True, broken=False,
             mcp_server=True, mcp=True):
    """A claude_agent_sdk-shaped package (plus mcp and a dependency) under d."""
    if mcp:
        write(os.path.join(d, "mcp", "__init__.py"), "")
        write(os.path.join(d, "mcp", "shared", "__init__.py"), "")
        write(os.path.join(d, "mcp", "shared", "memory.py"), "")
    if mcp and mcp_server:
        write(os.path.join(d, "mcp", "server", "__init__.py"), "class Server: pass\n")
    pkg = os.path.join(d, "claude_agent_sdk")
    write(os.path.join(pkg, "_version.py"), f'__version__ = "{sdk}"\n')
    write(os.path.join(pkg, "_cli_version.py"), f'__cli_version__ = "{cli}"\n')
    write(os.path.join(pkg, "_errors.py"), "class E(Exception): pass\n")
    write(os.path.join(d, "fakedep", "__init__.py"), f'WHERE = {d!r}\n')
    body = ("from . import _errors\nimport fakedep\nfrom ._version import __version__\n"
            "def create_sdk_mcp_server(name, version='1.0.0', tools=None):\n"
            "    return object()\n")
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
          and '"$HERE"/runtime/SDK_VERSION' in sh)
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
            "blave-agent-sdk.timer"} | {f"sdk-lock-{k}.txt" for k, _, _ in publish.SDK_TARGETS}
    check("publish tarball carries the pin, both modules, the sdk units and every lock",
          want <= names, sorted(want - names))
    # the machine side of the same tarball: control/updater.py's flat extract takes the
    # lock files, and its import health check only ever looks at the .py files
    sys.path.insert(0, os.path.join(API, "blave_agent", "control"))
    os.environ.setdefault("BLAVE_AGENT_STATE_DIR", os.path.join(TMP, "upd-state"))
    import updater
    import urllib.request as _ur
    updater.RELEASES_DIR = os.path.join(TMP, "releases")
    os.makedirs(updater.RELEASES_DIR)
    _real = _ur.urlopen

    class _Resp(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    updater.urllib.request.urlopen = lambda req, timeout=None: _Resp(data)
    import hashlib as _h
    rel = updater.download_release("t", "9.9.9", _h.sha256(data).hexdigest())
    updater.urllib.request.urlopen = _real
    got = set(os.listdir(rel))
    check("updater's flat extract accepts the lock files and SDK_VERSION",
          {"SDK_VERSION"} | {f"sdk-lock-{k}.txt" for k, _, _ in publish.SDK_TARGETS} <= got,
          sorted(got)[:5])
    check("updater health check imports only .py (locks are not modules)",
          not [m for m in updater.runtime_modules(rel) if "lock" in m])
    check("committed locks are for the current pin", publish.stale_locks(pin) == [],
          publish.stale_locks(pin))
    check("a lock for another pin counts as stale", publish.stale_locks("0.2.158") != [])
    lock_lines = open(publish.lock_path("linux_x86_64-py3.10")).read().splitlines()[1:]
    check("every lock line is name==version with at least one sha256",
          lock_lines and all(re.fullmatch(r"[A-Za-z0-9_.-]+==[^ ]+( --hash=sha256:[0-9a-f]{64})+", ln)
                             for ln in lock_lines))
    check("lock pins claude-agent-sdk to the pin",
          any(ln.startswith(f"claude-agent-sdk=={pin} ") for ln in lock_lines))
    check("provision installs from the same lock with --require-hashes",
          "--require-hashes -r" in sh and "runtime/sdk_pin.py" in sh and "sdk-lock-*.txt" in sh
          and "--require-hashes -r $lock" in ps and "runtime\\sdk_pin.py" in ps
          and "sdk-lock-*.txt" in ps)
    check("lock_key() names this interpreter's lock the way SDK_TARGETS does",
          re.fullmatch(r"(linux|win|macosx)_[a-z0-9_]+-py3\.\d+", sdk_pin.lock_key())
          and all(re.fullmatch(r"(linux|win|macosx)_[a-z0-9_]+-py3\.\d+", k)
                  for k, _, _ in publish.SDK_TARGETS))
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
check("…and the dir is out of rotation: .ready renamed to .bad",
      os.path.exists(os.path.join(bd, ".bad")) and not os.path.exists(os.path.join(bd, ".ready")))
check("…so the next turn goes straight to the venv",
      load_in_child(venv, root3, pinf).get("ver") == "0.2.144")
st = sdk_sync.report(state_path=os.path.join(TMP, "no-state.json"), root=root3, pin_file=pinf)
check("report() shows venv + the fallback before any sync ran",
      st.get("active") == "venv" and st.get("error") == sdk_sync.BAD_ERROR, st)

# a FIFO planted as .ready must not hang a turn
fr = os.path.join(TMP, "fifo-root")
fake_pkg(os.path.join(fr, "0.2.159"))
os.mkfifo(os.path.join(fr, "0.2.159", ".ready"))
r = subprocess.run([sys.executable, "-c", "import sys; sys.path.insert(0, sys.argv[1]); import sdk_pin; "
                    "print(sdk_pin.ready_dir('0.2.159', sys.argv[2]))", RUNTIME, fr],
                   capture_output=True, text=True, timeout=20)
check("FIFO .ready → None, no hang", r.stdout.strip() == "None", (r.stdout, r.stderr[-200:]))

# .pth files in the pin dir are replayed (pip --target does not run them)
pr = os.path.join(TMP, "pth-root")
pd = ready(pr, "0.2.159")
write(os.path.join(pd, "extra.pth"), "# comment\nsub\nimport pthmark\n")
write(os.path.join(pd, "sub", "pthsub_mod.py"), "")
write(os.path.join(pd, "pthmark.py"), "")
r = subprocess.run([sys.executable, "-c", textwrap.dedent("""
    import json, sys
    sys.path.insert(0, sys.argv[1]); sys.path.insert(0, sys.argv[2])
    import sdk_pin
    sdk_pin.load(pin_file=sys.argv[3], root=sys.argv[4])
    import pthsub_mod
    i = sys.path.index(sys.argv[5])
    print(json.dumps([pthsub_mod.__file__, "pthmark" in sys.modules, sys.path[i + 1]]))
"""), venv, RUNTIME, pinf, pr, pd], capture_output=True, text=True, timeout=60)
got = json.loads(r.stdout.strip().splitlines()[-1]) if r.returncode == 0 else r.stderr[-300:]
check(".pth path lines go right after the pin dir, import lines run",
      isinstance(got, list) and got[0].startswith(os.path.join(pd, "sub")) and got[1]
      and got[2] == os.path.join(pd, "sub"), got)
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


LOCKF = os.path.join(TMP, "sdk-lock-test.txt")
write(LOCKF, "# claude-agent-sdk==0.2.159 test\n")
LOCKS_SEEN = []


def no_install(pin, target, lock):
    raise AssertionError("pip must not run here")


def fake_install(**kw):
    def install(pin, target, lock):
        LOCKS_SEEN.append(lock)
        fake_pkg(target, sdk=pin, **kw)
    return install


def run(e, venv_ver="0.2.144", install=no_install, free=8 * GB, busy=False, **kw):
    kw.setdefault("lock_file", LOCKF)
    return sdk_sync.run(venv=lambda: (venv_ver, "x"), install=install,
                        free=lambda p: free, busy=lambda: busy, **e, **kw)


e = env("noop")
rec = run(e, venv_ver="0.2.159")
check("venv == pin → no install", rec and rec.get("skip") == "venv_at_or_above_pin", rec)
check("…and the second pass writes nothing new", run(e, venv_ver="0.2.159") is None)

e = env("nodown")
ready(e["root"], "0.2.159")
ready(e["root"], "0.2.150")
rec = run(e, venv_ver="0.2.160")
check("venv newer than pin → never downgrade: the pin dir leaves rotation, nothing deleted",
      rec.get("skip") == "venv_at_or_above_pin" and sorted(os.listdir(e["root"])) == ["0.2.150", "0.2.159"]
      and sdk_pin.ready_dir("0.2.159", e["root"]) is None, rec)
e = env("equal-keep")
ready(e["root"], "0.2.159")
run(e, venv_ver="0.2.159")
check("venv == pin → a ready pin dir is left as is",
      sdk_pin.ready_dir("0.2.159", e["root"]) is not None)
check("version compare is numeric (0.2.16 < 0.2.159)",
      run(env("numeric"), venv_ver="0.2.16", install=fake_install()).get("ok") is True)

e = env("disk")
rec = run(e, free=1 * GB)
check("free < 1.5GB → skipped before pip, no .tmp",
      rec.get("error") == "disk" and not os.path.exists(os.path.join(e["root"], "0.2.159.tmp")),
      rec)

e = env("fail")
calls = []


def failing(pin, target, lock):
    calls.append(pin)
    os.makedirs(os.path.join(target, "partial"))
    raise RuntimeError("pip rc=1")


for _ in range(sdk_sync.MAX_FAILS + 2):
    rec = run(e, install=failing)
check("pip failure → .tmp removed", not os.path.exists(os.path.join(e["root"], "0.2.159.tmp")))
check(f"stops after {sdk_sync.MAX_FAILS} failures for the same pin",
      len(calls) == sdk_sync.MAX_FAILS, len(calls))
st = json.load(open(e["state_path"]))
st["at"] -= sdk_sync.FAIL_RESET_S + 60
json.dump(st, open(e["state_path"], "w"))
run(e, install=failing)
check("24h after the last failure the count resets and it tries again",
      len(calls) == sdk_sync.MAX_FAILS + 1, len(calls))
write(pinf, "0.2.160\n")
run(e, install=failing)
check("a new pin starts counting again", len(calls) == sdk_sync.MAX_FAILS + 2, len(calls))
write(pinf, "0.2.159\n")

e = env("nolock")
rec = run(e, install=no_install, lock_file=os.path.join(TMP, "sdk-lock-nope.txt"))
check("no lock file for this platform → nothing installed, error recorded",
      "no lock file sdk-lock-nope.txt" in (rec.get("error") or "")
      and not os.path.exists(os.path.join(e["root"], "0.2.159.tmp")), rec)

for i, (label, kw) in enumerate([("no _bundled CLI", dict(bundled=False)),
                  ("mcp.server missing (a turn's in-process MCP would fail)", dict(mcp_server=False)),
                  ("--version reports another CLI", dict(reported="2.1.239")),
                  ("__version__ is not the pin", dict(sdk="0.2.158"))]):
    e = env(f"bad{i}")
    inst = fake_install(**kw)
    if "sdk" in kw:
        inst = (lambda k: lambda pin, target, lock: fake_pkg(target, **k))(kw)
    rec = run(e, install=inst)
    check(f"self-check rejects: {label} (no .ready, no dir)",
          rec.get("error") and not os.path.exists(os.path.join(e["root"], "0.2.159"))
          and sdk_pin.ready_dir("0.2.159", e["root"]) is None, rec)

e = env("emptyinstall")
same = fake_pkg(os.path.join(TMP, "venv-same"))  # same version as the pin: only __file__ tells
os.environ["PYTHONPATH"] = same
rec = run(e, install=lambda pin, target, lock: os.makedirs(target))
os.environ.pop("PYTHONPATH")
check("self-check rejects an install that imports someone else's claude_agent_sdk",
      "not the new install" in (rec.get("error") or ""), rec)
e = env("foreignmcp")
os.environ["PYTHONPATH"] = same
rec = run(e, install=lambda pin, target, lock: fake_pkg(target, mcp=False))
os.environ.pop("PYTHONPATH")
check("self-check rejects an install whose mcp comes from somewhere else",
      "not the new install" in (rec.get("error") or ""), rec)

e = env("ok")
_save = sdk_sync._save_state
sdk_sync._save_state(e["state_path"], {})   # a machine that has run the job before
rec = run(e, install=fake_install())
check("installs from the platform lock it was given", LOCKS_SEEN[-1] == LOCKF, LOCKS_SEEN[-1:])
d = os.path.join(e["root"], "0.2.159")
check("success → .ready written after the check, content `<pin> <cli>`",
      rec.get("ok") and open(os.path.join(d, ".ready")).read() == "0.2.159 2.1.281\n", rec)
check("…and sdk_pin now picks it", sdk_pin.ready_dir("0.2.159", e["root"]) == d)
check("ready pin → next pass does nothing", run(e) is None)
ready(e["root"], "0.2.150")
write(pinf, "0.2.160\n")
rec = run(e, install=fake_install(cli="2.1.283"))
write(pinf, "0.2.161\n")
rec = run(e, install=fake_install(cli="2.1.284"), busy=True)
check("a turn running → installed, but nothing pruned yet",
      rec.get("ok") and rec.get("prune_pending") is True
      and sorted(os.listdir(e["root"])) == ["0.2.159", "0.2.160", "0.2.161"],
      (os.listdir(e["root"]), rec))
check("…still running next pass → still nothing pruned",
      run(e, busy=True) is None and len(os.listdir(e["root"])) == 3)
rec = run(e)
check("turn done → keeps the current and the previous pin only",
      sorted(os.listdir(e["root"])) == ["0.2.160", "0.2.161"]
      and rec.get("prev") == "0.2.160" and rec.get("prune_pending") is False,
      (os.listdir(e["root"]), rec))
write(pinf, "0.2.159\n")

e = env("nostate")
ready(e["root"], "0.2.150")
ready(e["root"], "0.2.155")
write(e["state_path"], "{corrupt")
rec = run(e, install=fake_install())
check("state file unreadable → installed, nothing pruned (previous pin unknown)",
      rec.get("ok") and sorted(os.listdir(e["root"])) == ["0.2.150", "0.2.155", "0.2.159"]
      and rec.get("prune_pending") is False, (os.listdir(e["root"]), rec))
check("…and no later pass prunes on that say-so", run(e) is None and len(os.listdir(e["root"])) == 3)

e = env("bad-last")
bd3 = ready(e["root"], "0.2.159")
os.replace(os.path.join(bd3, ".ready"), os.path.join(bd3, ".bad"))
sdk_sync._save_state(e["state_path"], {"pin": "0.2.159", "fails": sdk_sync.MAX_FAILS - 1,
                                      "at": int(time.time())})
rec = run(e, install=no_install)
check("a .bad counts as a failure: the last allowed one stops retries",
      rec.get("error") == sdk_sync.BAD_ERROR and rec.get("fails") == sdk_sync.MAX_FAILS, rec)

e = env("bad")
bd2 = ready(e["root"], "0.2.159")
os.replace(os.path.join(bd2, ".ready"), os.path.join(bd2, ".bad"))
rec = run(e, install=fake_install())
check("a .bad dir counts one failure and is reinstalled",
      rec.get("ok") and sdk_pin.ready_dir("0.2.159", e["root"]) == bd2
      and not os.path.exists(os.path.join(bd2, ".bad")), rec)
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
st = sdk_sync.report(state_path=e["state_path"], root=e["root"], pin_file=pinf)
check("report() = status + why the pin is not active", st.get("error") == "disk"
      and st.get("pin") == "0.2.159" and "active" in st, st)

# ── 4. import has no side effects ───────────────────────────────────────────
base = os.path.join(TMP, "import-base")
os.makedirs(base)
r = subprocess.run([sys.executable, "-c", "import sdk_pin, sdk_sync"], cwd=RUNTIME,
                   env=dict(os.environ, BLAVE_AGENT_BASE=base), capture_output=True, text=True)
check("import sdk_pin, sdk_sync writes nothing",
      r.returncode == 0 and os.listdir(base) == [], (r.stderr[-200:], os.listdir(base)))

# ── 5. promote ──────────────────────────────────────────────────────────────
import hashlib  # noqa: E402

import publish  # noqa: E402


class FakeS3:
    def __init__(self, objs):
        self.objs, self.puts = objs, []

    def get_object(self, Bucket, Key):
        if Key not in self.objs:
            e = Exception("404")
            e.response = {"Error": {"Code": "NoSuchKey"}}
            raise e
        body = self.objs[Key]
        return {"Body": type("B", (), {"read": lambda self: body})()}

    def put_object(self, Bucket, Key, Body, ContentType=None):
        self.puts.append(Key)
        self.objs[Key] = Body


def mf(v, data):
    return json.dumps({"latest": v, "sha256": hashlib.sha256(data).hexdigest(),
                       "size": len(data)}).encode()


def promote(main_v, canary_v, tar=b"tar", claimed=b"tar"):
    objs = {"blave-agent/manifest-canary.json": mf(canary_v, claimed),
            f"blave-agent/releases/{canary_v}.tar.gz": tar}
    if main_v:
        objs["blave-agent/manifest.json"] = mf(main_v, b"x")
    s3 = FakeS3(objs)
    try:
        publish.promote(s3, "b")
    except SystemExit as e:
        return str(e), s3.puts
    return "ok", s3.puts


check("promote: canary newer + tarball matches → manifest.json written",
      promote("1.1.109", "1.1.110") == ("ok", ["blave-agent/manifest.json"]))
out, puts = promote("1.1.110", "1.1.110")
check("promote: canary not newer (already promoted / stale) → refused, nothing written",
      "not newer" in out and puts == [], out)
out, puts = promote("1.1.111", "1.1.110")
check("promote: canary older than the fleet → refused", "not newer" in out and puts == [], out)
out, puts = promote("1.1.109", "1.1.110", tar=b"other")
check("promote: tarball sha256 differs from the canary manifest → refused",
      "does not match" in out and puts == [], out)
check("promote: 1.1.10 is newer than 1.1.9", promote("1.1.9", "1.1.10")[0] == "ok")

# ── 5b. locks follow each platform's own markers ────────────────────────────
# pip evaluates markers on the machine running it, so a lock built on a Mac lost
# mcp's `pywin32; sys_platform == "win32"` (runtime 1.1.109 canary, uid=1) and
# anyio's `exceptiongroup; python_version < "3.11"` for the 3.10 Linux fleet.
TREE = {
    "claude-agent-sdk": ["mcp>=1", "jwtish[crypto]>=2"],
    "mcp": ['winonly>=311; sys_platform == "win32"', 'oldpy; python_version < "3.11"',
            'maconly; sys_platform == "darwin"'],
    "jwtish": ['cryptoish>=3; extra == "crypto"', 'never; extra == "other"'],
    "winonly": [], "oldpy": [], "maconly": [], "cryptoish": [], "never": [],
}
VERS = {"claude-agent-sdk": "0.2.159", "mcp": "2.3.0", "jwtish": "2.15.1", "cryptoish": "50.0.2",
        "winonly": "312", "oldpy": "1.3.1", "maconly": "1.0"}


def problems(key, drop=(), extra=None):
    v = {n: x for n, x in VERS.items() if n not in drop}
    v.update(extra or {})
    return publish.lock_problems("0.2.159", key, requires_of=TREE.get, versions=v)


win_ok = problems("win_amd64-py3.14", drop=("oldpy", "maconly"))
check("win closure = sdk, mcp, jwtish[crypto]→cryptoish, winonly (no py<3.11 / mac-only / unused extra)",
      win_ok == [], win_ok)
check("win lock without the win32-only dep → reported missing",
      problems("win_amd64-py3.14", drop=("oldpy", "maconly", "winonly")) == ["missing winonly"])
check("linux 3.10 lock must carry the python_version < 3.11 dep",
      problems("linux_x86_64-py3.10", drop=("winonly", "maconly", "oldpy")) == ["missing oldpy"])
check("mac lock must carry the darwin-only dep and must not carry the win32-only one",
      problems("macosx_arm64-py3.12", drop=("oldpy",)) == ["not needed on this platform: winonly"]
      and problems("macosx_arm64-py3.12", drop=("oldpy", "winonly", "maconly")) == ["missing maconly"])
check("a pinned version outside the requirement's specifier is reported",
      problems("win_amd64-py3.14", drop=("oldpy", "maconly"), extra={"winonly": "310"})
      == ["winonly==310 does not satisfy winonly>=311; sys_platform == \"win32\""])
locks = {k: publish.read_lock(k) for k, _, _ in publish.SDK_TARGETS}
check("committed locks: pywin32 on both Windows targets, nowhere else",
      all(("pywin32" in v) == k.startswith("win_") for k, v in locks.items()),
      {k: "pywin32" in v for k, v in locks.items()})
check("committed locks: exceptiongroup (anyio on py < 3.11) only on Linux py3.10",
      all(("exceptiongroup" in v) == (k == "linux_x86_64-py3.10") for k, v in locks.items()),
      {k: "exceptiongroup" in v for k, v in locks.items()})

# ── 6. lock resolution (network) ────────────────────────────────────────────
if "--net" in sys.argv:
    check("lock: 0.2.160 has no win_amd64 wheel → unresolvable",
          publish.sdk_lock_text("0.2.160", "win_amd64-py3.14", "win_amd64", "3.14") is None)
    text = publish.sdk_lock_text("0.2.159", "win_amd64-py3.14", "win_amd64", "3.14")
    check("lock: 0.2.159 resolves and matches the committed lock",
          text == open(publish.lock_path("win_amd64-py3.14")).read())
    for k, _, _ in publish.SDK_TARGETS:
        got = publish.lock_problems(pin, k)
        check(f"committed lock {k} = closure under its markers (PyPI Requires-Dist)", got == [], got)

import shutil  # noqa: E402
shutil.rmtree(TMP, ignore_errors=True)
print(f"\n{'FAIL' if failures else 'OK'}: {len(failures)} failure(s)")
sys.exit(1 if failures else 0)
