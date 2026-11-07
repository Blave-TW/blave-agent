"""Strategy transfer without an agent turn — the runtime half of the desktop's 送上雲端 / 拉回這台電腦
(runtime/strategy_transfer.py + command_listener strategy_import / strategy_export; the agent's
procedure for the same thing is references/cloud-handoff.md). No network; crontab stubbed; real
subprocesses in a temp workspace carrying a copy of this repo's lib/.

  1. Shapes: import args, file list (names, hashes, base64, caps, UTF-8), a local import takes no keys.
  2. Portability: a lib module the destination lacks, an allocator, a strategies import → NOT_PORTABLE;
     sibling helpers and official lib modules pass.
  3. Destination (§4a): folder, single-file layout, a symlink, a 下單設定 key, the deployment registry
     and a crontab word all count as taken; never overwritten; `to`'s N is where the search starts;
     a cut name stays ≤ 64.
  4. Rename (§4c): only the STRATEGY_NAME line, DISPLAY_NAME numbered (（N） with CJK, (N) otherwise),
     files still naming the source listed; two STRATEGY_NAME lines → refused; a STRATEGY_NAME that is
     not the folder → NAME_MISMATCH before anything is written.
  5. Writes: half a copy is cleaned up (only what this import wrote, its own folder); nothing is left
     on a refusal.
  6. Runs: Type A → quiet backtest = v1 of <dest>, record gone; a data failure → failed DATA in the
     report; Type B → 120 s trial with its exit and tail; Type B that can order → not run, no record;
     a listener restart settles a dead run; _kill_transfer stops a live one.
  7. Keys (cloud): the managed .env block written exactly, other sources and lines untouched, a source
     replaced as a unit, 0600; values never in the ack.
  8. Export: *.py only, outputs and symlinks stay, left_behind named, handed over under the command
     id; an api refusal → HANDOVER. local_daemon takes import only; both have handlers.
  9. Staged files (拉回 here): read from state/transfer_in/<id>/, re-hashed, capped, symlinks not
     followed, the stage always removed; a cloud machine refuses them.
 10. Helpers that only read STRATEGY_NAME (scan.py's chart title) move, both directions; every form
     that writes it is refused; an unparseable helper falls back to the substring rule; dropping the
     Attribute branch turns the `s.STRATEGY_NAME = "x"` case red (mutation).

Run: cd blave-agent && .venv/bin/python tests/check_strategy_transfer.py
"""
import base64
import hashlib
import json
import os
import shutil
import stat
import sys
import tempfile
import time
import types

# BLAVE_AGENT_LOCAL=1 below makes the import's backtest child run under THIS interpreter
# (command_listener._workspace_python); without pandas it dies on import and §6 reads as a
# transfer bug ("the backtest finishes" FAIL, then a missing versions/index.json).
try:
    import pandas  # noqa: F401
except ImportError:
    sys.exit(f"FAIL this interpreter ({sys.executable}) has no pandas — run with blave-agent's .venv "
             "(tests/run_all.sh picks it) so the imported strategy's backtest can run")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNTIME = os.path.join(ROOT, "runtime")
BASE = tempfile.mkdtemp(prefix="strategy-transfer-")
WS = os.path.join(BASE, "workspace")
os.makedirs(os.path.join(WS, "manager"))
os.makedirs(os.path.join(WS, "state"))
os.makedirs(os.path.join(WS, "strategies"))
shutil.copytree(os.path.join(ROOT, "lib"), os.path.join(WS, "lib"),
                ignore=shutil.ignore_patterns("__pycache__"))
os.environ.update({"BLAVE_AGENT_HOME": BASE, "BLAVECLAW_HOME": BASE, "BLAVE_AGENT_BASE": BASE,
                   "BLAVE_AGENT_WORKSPACE": WS, "BLAVE_AGENT_STATE": os.path.join(BASE, "state"),
                   "BLAVE_AGENT_DB": os.path.join(BASE, "session.db"),
                   "BLAVE_AGENT_LOCAL": "1",   # the child interpreter is this venv's (it has pandas)
                   "MPLBACKEND": "Agg", "PYTHONPYCACHEPREFIX": os.path.join(BASE, "pycache")})
os.environ.pop("BLAVE_PROXY_TOKEN", None)
sys.path.insert(0, RUNTIME)
import strategy_transfer as T  # noqa: E402
import command_listener as cl  # noqa: E402
import strategy_reporter as rep  # noqa: E402
import local_daemon as ld  # noqa: E402

CRON = []
REAL_CRONTAB_LINES = T._crontab_lines
T._crontab_lines = lambda: list(CRON)   # never the real crontab of the machine running this
fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


PUSHES = []
cl._ON_APPLIED = lambda: PUSHES.append(time.time())
SDIR = os.path.join(WS, "strategies")


def tf(f, text):
    raw = text.encode("utf-8") if isinstance(text, str) else text
    return {"f": f, "sha256": hashlib.sha256(raw).hexdigest(), "b64": base64.b64encode(raw).decode()}


def read(p):
    with open(p, encoding="utf-8") as fh:
        return fh.read()


def wait(cond, timeout=120):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.2)
    return False


def code_of(e):
    return str(e).split(":", 1)[0]


TYPE_A = '''# Strategy: momentum
# Type:     A
import json, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))
import numpy as np
import pandas as pd
from lib.runner import run
import helper

STRATEGY_NAME = "{name}"
DISPLAY_NAME  = "{display}"
SYMBOL        = "BTCUSDT"
INTERVAL      = "1h"
START         = "2024-01-01"
FEE           = 0.0005
MCPT          = False


def fetch_data(hdrs):
    if helper.HOW == "data":
        from lib.data import DataAccessError
        raise DataAccessError("ERR007 test: no data access")
    idx = pd.date_range("2024-01-01", periods=300, freq="h")
    c = pd.Series(100 + np.cumsum(np.sin(np.arange(300) / 5.0)), index=idx)
    return pd.DataFrame({{"Open": c, "High": c, "Low": c, "Close": c, "Volume": 1.0}}, index=idx)


def compute_signals(df):
    return pd.Series(np.where(np.arange(len(df)) % 30 < 15, 1.0, 0.0), index=df.index)


run(locals(), fetch_data, compute_signals)
'''


def type_a(name="momo", display="動能 BTC", how=""):
    return [tf("strategy.py", TYPE_A.format(name=name, display=display)),
            tf("helper.py", f'HOW = "{how}"\n# helper of {name}\n')]


def imp(args):
    d = cl.dispatch({"cmd": "strategy_import", "args": args})
    assert isinstance(d, cl.Deferred)
    try:
        return d.fn()
    finally:
        d.cleanup()


def refused(args):
    try:
        imp(args)
    except ValueError as e:
        return code_of(e)
    except OSError as e:
        return type(e).__name__
    return None


def folders():
    return sorted(os.listdir(SDIR))


with open(os.path.join(WS, "manager", "portfolio_config.json"), "w") as fh:
    json.dump({"amounts": {"live_one": 100}, "weights": {"w_one": 1}, "exchanges": {}}, fh)
with open(os.path.join(WS, "state", "deployments.json"), "w") as fh:
    json.dump({"deployed_one": {"type": "wait_for_bar"}}, fh)

# ── 1. shapes ────────────────────────────────────────────────────────────────
GOOD = {"name": "momo", "files": type_a()}
BAD_ARGS = [{}, {"name": "momo"}, {"files": GOOD["files"]}, dict(GOOD, x=1), dict(GOOD, name="../x"),
            dict(GOOD, name="x" * 65), dict(GOOD, name="動能"), dict(GOOD, to="a/b"), dict(GOOD, to=5),
            dict(GOOD, env={"BINANCE_API_KEY": "v"}), dict(GOOD, env={"DATA_API_KEY": "v"}),
            dict(GOOD, env={"DATA_DATAX_KEY": "v"}), dict(GOOD, env={"DATA_FRED_KEY": "a'b"}),
            dict(GOOD, env={"DATA_FRED_KEY": "a${B}"}), dict(GOOD, env={}), ["momo"]]
codes = set()
for a in BAD_ARGS:
    try:
        T.import_args(a, local=False)
        codes.add("accepted")
    except ValueError as e:
        codes.add(code_of(e))
check(codes == {"BAD_ARGS"}, f"bad import args → BAD_ARGS (got {codes})")
SP = tf("strategy.py", "x = 1\n")
BAD_FILES = {
    "no strategy.py": [tf("leg.py", "x")], "traversal": [SP, dict(tf("x.py", "x"), f="../x.py")],
    "slash": [SP, dict(tf("x.py", "x"), f="a/b.py")], "backslash": [SP, dict(tf("x.py", "x"), f="a\\b.py")],
    "hidden": [SP, tf(".h.py", "x")], "not .py": [SP, tf("p.json", "{}")], "case twin": [SP, tf("Strategy.py", "x")],
    "duplicate": [SP, SP], "sha": [dict(SP, sha256="0" * 64)], "b64": [dict(SP, b64="not base64!")],
    "extra key": [dict(SP, x=1)], "21 files": [SP] + [tf(f"l{i}.py", "x") for i in range(20)], "empty": [],
}
got = {}
for label, files in BAD_FILES.items():
    try:
        T.decode_files(files)
        got[label] = "accepted"
    except ValueError as e:
        got[label] = code_of(e)
check(set(got.values()) == {"BAD_FILES"}, f"bad file lists → BAD_FILES ({got})")
for label, files, want in (("one file over 128KB", [SP, tf("b.py", "x" * (T.FILE_MAX + 1))], "TOO_LARGE"),
                           ("total over 160KB", [SP, tf("b1.py", "x" * 90000), tf("b2.py", "y" * 90000)], "TOO_LARGE"),
                           ("not UTF-8", [SP, tf("b.py", b"\xff\xfe")], "NOT_UTF8")):
    try:
        T.decode_files(files)
        c = "accepted"
    except ValueError as e:
        c = code_of(e)
    check(c == want, f"{label} → {want} (got {c})")
try:
    T.import_args(dict(GOOD, env={"DATA_FRED_KEY": "v"}), local=True)
    c = "accepted"
except ValueError as e:
    c = code_of(e)
check(c == "BAD_ARGS", "a local import (拉回) takes no data-source keys")
check(T.import_args(dict(GOOD, to="momo_5"), False)[1] == 5 and T.import_args(GOOD, False)[1] == 2
      and T.import_args(dict(GOOD, to="momo_1"), False)[1] == 2, "to's _N is where the free-name search starts (≥ 2)")
check(T.NAME_RE.pattern == T.WIN_RESERVED + "[A-Za-z0-9_-]{1,64}"
      and T.FILE_RE.pattern == T.WIN_RESERVED + r"[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}\.py"
      and (T.MAX_FILES, T.FILE_MAX, T.TOTAL_MAX, T.ENV_MAX) == (20, 128 * 1024, 160 * 1024, 16),
      "limits = the api's (agent_command TRANSFER_*)")
api_src = os.path.join(os.environ.get("BLAVE_API_DIR") or os.path.join(os.path.dirname(ROOT), "api"),
                       "openclaw", "agent_command.py")
if os.path.isfile(api_src):
    s = read(api_src)
    check(f'_WIN_RESERVED = r"{T.WIN_RESERVED}"' in s
          and 'TRANSFER_NAME_RE = re.compile(_WIN_RESERVED + r"[A-Za-z0-9_-]{1,64}")' in s
          and r'TRANSFER_FILE_RE = re.compile(_WIN_RESERVED + r"[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}\.py")' in s
          and "TRANSFER_MAX_FILES = 20" in s and "TRANSFER_FILE_MAX = 128 * 1024" in s
          and "TRANSFER_TOTAL_MAX = 160 * 1024" in s and "TRANSFER_ENV_MAX = 16" in s,
          "…and the api next to this repo says the same")
else:
    print("NOTE  no api source next to this repo (set BLAVE_API_DIR): limits compared to the constants only")

RESERVED_NAMES = ["con", "NUL", "Aux", "prn", "com1", "LPT9"]
RESERVED_FILES = ["con.py", "nul.helper.py", "COM3.py", "lpt1.x.py"]
check(not any(T.NAME_RE.fullmatch(n) for n in RESERVED_NAMES) and not any(T.FILE_RE.fullmatch(f) for f in RESERVED_FILES)
      and all(T.NAME_RE.fullmatch(n) for n in ("con_2", "console", "com10", "nul-x"))
      and all(T.FILE_RE.fullmatch(f) for f in ("console.py", "com10.py", "con_x.py")),
      "Windows reserved names refused (folder and file stem), look-alikes pass")
codes = set()
for n in RESERVED_NAMES:
    try:
        T.import_args(dict(GOOD, name=n), local=False)
        codes.add("accepted")
    except ValueError as e:
        codes.add(code_of(e))
for f in RESERVED_FILES:
    try:
        T.decode_files([SP, tf(f, "x = 1\n")])
        codes.add("accepted")
    except ValueError as e:
        codes.add(code_of(e))
check(codes == {"BAD_ARGS", "BAD_FILES"}, f"…as a strategy name → BAD_ARGS, as a file → BAD_FILES ({codes})")

# ── 2. portability ───────────────────────────────────────────────────────────
check(T.missing_modules([TYPE_A, "import helper\nfrom lib import data\nfrom lib.data import fetch_kline\n"], WS) == [],
      "official lib modules and a sibling helper travel")
check(T.missing_modules(["import lib.my_tools\nfrom lib import nope\nfrom allocators.x import y\nimport strategies.other\n"], WS)
      == ["allocators.x", "lib.my_tools", "lib.nope", "strategies.other"], "custom lib module, allocator, strategies import → missing")
check(T.missing_modules(["def broken(:\n"], WS) == [], "an unparseable file is left to the run")
check(refused(dict(GOOD, files=[tf("strategy.py", 'STRATEGY_NAME = "momo"\nimport lib.my_tools\n')])) == "NOT_PORTABLE"
      and folders() == [], "NOT_PORTABLE refused before anything is written")

# ── 3. destination ───────────────────────────────────────────────────────────
os.makedirs(os.path.join(SDIR, "momo"))
with open(os.path.join(SDIR, "momo", "strategy.py"), "w") as fh:
    fh.write("ORIGINAL")
with open(os.path.join(SDIR, "single.py"), "w") as fh:
    fh.write("x = 1\n")
os.symlink(BASE, os.path.join(SDIR, "linked"))
CRON[:] = ["*/5 * * * * cd /w && python3 strategies/cron_one/strategy.py", "0 * * * * cron_onex"]
taken = T.taken_check(WS)
check([taken(x) for x in ("momo", "single", "linked", "live_one", "w_one", "deployed_one", "cron_one", "free_one", "cron_on")]
      == [True] * 7 + [False, False], "taken: folder, single file, symlink, amounts, weights, deployments, crontab word")
check(T.candidate("x" * 64, 2) == "x" * 62 + "_2" and len(T.candidate("x" * 64, 1234)) == 64, "a cut name stays ≤ 64")
CRON[:] = []

# the real _crontab_lines: an unreadable crontab is never "free" (§4a)
import shutil as _sh  # noqa: E402
import subprocess as _sp  # noqa: E402
real_which, real_run, stub_cron = _sh.which, T.subprocess.run, T._crontab_lines


def cron_run(rc, err, raise_=None):
    def fake(*a, **k):
        if raise_:
            raise raise_
        return _sp.CompletedProcess(a[0], rc, stdout="0 * * * * x\n" if rc == 0 else "", stderr=err)
    return fake


cron_cases = {"permission denied": (cron_run(1, "crontab: permission denied"), "CHECK_FAILED"),
              "timed out": (cron_run(0, "", _sp.TimeoutExpired("crontab", 15)), "CHECK_FAILED"),
              "OSError": (cron_run(0, "", OSError("boom")), "CHECK_FAILED"),
              "no crontab for user": (cron_run(1, "no crontab for blaveagent"), []),
              "one line": (cron_run(0, ""), ["0 * * * * x"])}
got = {}
_sh.which = lambda name: "/usr/bin/crontab"
T._crontab_lines = REAL_CRONTAB_LINES
try:
    for label, (fake, want) in cron_cases.items():
        T.subprocess.run = fake
        try:
            got[label] = T._crontab_lines() == want
        except ValueError as e:
            got[label] = code_of(e) == want
    T.subprocess.run = cron_run(1, "crontab: permission denied")
    n0 = folders()
    c = refused({"name": "fresh_one", "files": [tf("strategy.py", 'STRATEGY_NAME = "fresh_one"\n')]})
finally:
    _sh.which, T.subprocess.run, T._crontab_lines = real_which, real_run, stub_cron
check(all(got.values()), f"crontab -l unreadable → CHECK_FAILED, 'no crontab' → empty ({got})")
check(c == "CHECK_FAILED" and folders() == n0, f"…an import with an unreadable crontab writes nothing ({c})")

# ── 4. rename ────────────────────────────────────────────────────────────────
files = T.decode_files(type_a())
out, still = T.rename(files, "momo", "momo_3")
s_new = next(t for f, _, t in out if f == "strategy.py")
check('STRATEGY_NAME = "momo_3"' in s_new and 'DISPLAY_NAME  = "動能 BTC（3）"' in s_new
      and s_new.count("momo") == 1 and still == ["helper.py"], f"rename: STRATEGY_NAME line, （3） on a CJK display name, helper still names it ({still})")
out_en, _ = T.rename(T.decode_files(type_a(display="BTC momentum")), "momo", "momo_2")
check('DISPLAY_NAME  = "BTC momentum (2)"' in next(t for f, _, t in out_en if f == "strategy.py"), "(2) on a non-CJK display name")
check(next(r for f, r, _ in out if f == "strategy.py") == s_new.encode("utf-8"), "the bytes written are the renamed text")
twice = [tf("strategy.py", 'STRATEGY_NAME = "momo"\nSTRATEGY_NAME = "momo"\n')]
try:
    T.rename(T.decode_files(twice), "momo", "momo_2")
    c = "accepted"
except ValueError as e:
    c = code_of(e)
check(c == "NO_STRATEGY_NAME", "two STRATEGY_NAME lines → NO_STRATEGY_NAME")
n_before = folders()
check(refused({"name": "momo", "files": type_a(name="other")}) == "NAME_MISMATCH" and folders() == n_before,
      "STRATEGY_NAME ≠ folder → NAME_MISMATCH, nothing written (the run would write into strategies/other/)")
# lib/runner writes under strategies/<STRATEGY_NAME>/: anything that is not one top-level literal is refused
BAD_NAMES = {
    "annotated, other name": ('STRATEGY_NAME: str = "other"\n', "NAME_MISMATCH"),
    "annotated, same name, renamed in transit": ('STRATEGY_NAME: str = "momo"\n', None),
    "indirect": ('NAME = "momo"\nSTRATEGY_NAME = NAME\n', "NO_STRATEGY_NAME"),
    "f-string": ('X = "mo"\nSTRATEGY_NAME = f"{X}mo"\n', "NO_STRATEGY_NAME"),
    "Type A header, no constant": ('# Type: A\nx = 1\n', "NO_STRATEGY_NAME"),
    "Type C header, no constant": ('# Type: C\nx = 1\n', "NO_STRATEGY_NAME"),
    "Type A by compute_signals, no constant": ('def compute_signals(df):\n    return df\n', "NO_STRATEGY_NAME"),
    "Type B, indirect": ('# Type: B\nNAME = "momo"\nSTRATEGY_NAME = NAME\n', "NO_STRATEGY_NAME"),
    "Type B, bound twice": ('STRATEGY_NAME = "momo"\nSTRATEGY_NAME = "other"\nprint(1)\n', "NO_STRATEGY_NAME"),
    "Type B, only named in a comment": ('# STRATEGY_NAME is not needed here\nprint(1)\n', "NO_STRATEGY_NAME"),
    "rebound later": ('STRATEGY_NAME = "momo"\nSTRATEGY_NAME = "other"\n', "NO_STRATEGY_NAME"),
    "inside a block": ('if True:\n    STRATEGY_NAME = "other"\nSTRATEGY_NAME = "momo"\n', "NO_STRATEGY_NAME"),
    "tuple target": ('STRATEGY_NAME, X = "other", 1\n', "NO_STRATEGY_NAME"),
    "augmented": ('STRATEGY_NAME = "momo"\nSTRATEGY_NAME += "_x"\n', "NO_STRATEGY_NAME"),
}
got = {}
for label, (src, want) in BAD_NAMES.items():
    if want is None:
        continue
    got[label] = (refused({"name": "momo", "files": [tf("strategy.py", src)]}), want)
check(all(c == w for c, w in got.values()) and folders() == n_before,
      f"STRATEGY_NAME not one top-level literal of the folder's name → refused, nothing written ({got})")
ann = T.decode_files([tf("strategy.py", 'STRATEGY_NAME: str = "momo"  # id\nDISPLAY_NAME: str = "動能"\n')])
check(T.check_name(ann, "momo") == "momo", "an annotated STRATEGY_NAME of the folder's name passes")
a_out, _ = T.rename(ann, "momo", "momo_4")
a_txt = a_out[0][2]
check('STRATEGY_NAME: str = "momo_4"  # id' in a_txt and 'DISPLAY_NAME: str = "動能（4）"' in a_txt
      and T.strategy_name_const(a_txt) == "momo_4",
      f"…and is renamed in transit, annotation and comment kept ({a_txt!r})")

# ── 5. writes ────────────────────────────────────────────────────────────────
real_replace = cl.os.replace
calls = []


def flaky_replace(a, b):
    calls.append(b)
    if len(calls) == 2:
        raise OSError("disk full (test)")
    return real_replace(a, b)


cl.os.replace = flaky_replace
try:
    c = refused({"name": "momo", "files": type_a()})
finally:
    cl.os.replace = real_replace
check(c == "OSError" and not os.path.exists(os.path.join(SDIR, "momo_2")) and read(os.path.join(SDIR, "momo", "strategy.py")) == "ORIGINAL",
      f"half a copy → its own files and folder removed, the source untouched (got {c}, {folders()})")

# ── 6. runs ──────────────────────────────────────────────────────────────────
PUSHES.clear()
res = imp({"name": "momo", "to": "momo_2", "files": type_a()})
D = os.path.join(SDIR, "momo_2")
check(res["dest"] == "momo_2" and res["renamed"] and res["type"] == "A" and res["run"] == "backtest"
      and res["still_names"] == ["helper.py"] and "keys" not in res, f"Type A import → momo_2, backtest started ({res})")
check(read(os.path.join(SDIR, "momo", "strategy.py")) == "ORIGINAL", "the taken name is never overwritten")
check(sorted(os.listdir(D))[:2] == ["helper.py", "strategy.py"] and not [x for x in os.listdir(D) if x.endswith(".handoff")],
      "files in place, no .handoff left")
doc = cl._read_transfer_doc("momo_2")
check(doc and doc["status"] == "running" and doc["kind"] == "backtest", f"record running ({doc})")
check(wait(lambda: cl._read_transfer_doc("momo_2") is None), "the backtest finishes and the record goes")
idx = json.loads(read(os.path.join(D, "versions", "index.json")))
check(os.path.isfile(os.path.join(D, "stats.json")) and idx["current"] == 1 and idx["counter"] == 1,
      "stats.json written into momo_2 and it is v1 (canon strategy-versions §2)")
check(not os.path.exists(os.path.join(SDIR, "momo", "stats.json")), "nothing written into the source's folder")
check(wait(lambda: PUSHES and len(PUSHES) >= 2), "pushed at the ack and at the run's end")
entry = next(s for s in rep.scan(include_newborn=True) if s["name"] == "momo_2")
check("transfer" not in entry and entry.get("backtest"), "report: no transfer block after success, the backtest is there")

res = imp({"name": "momo", "files": type_a(how="data")})
check(res["dest"] == "momo_3", f"next free name ({res['dest']})")
check(wait(lambda: (cl._read_transfer_doc("momo_3") or {}).get("status") == "failed"), "a data failure settles failed")
entry = next(s for s in rep.scan(include_newborn=True) if s["name"] == "momo_3")
check(entry.get("transfer", {}).get("status") == "failed" and entry["transfer"].get("err") == "DATA"
      and entry["transfer"]["kind"] == "backtest" and entry["transfer"]["from"] == "cloud",
      f"report: transfer failed DATA ({entry.get('transfer')})")
mark_a = rep.strategy_marker(entry)
os.remove(os.path.join(SDIR, "momo_3", cl.TRANSFER_FILE))
check(rep.strategy_marker(entry) != mark_a, "the record is in the strategy's marker (a failure is re-sent)")

TB = 'STRATEGY_NAME = "watcher"\nprint("checked BTC: no alert")\n'
res = imp({"name": "watcher", "files": [tf("strategy.py", TB)]})
check(res["dest"] == "watcher" and not res["renamed"] and res["type"] == "B" and res["run"] == "trial"
      and res["can_order"] is False, f"Type B → trial ({res})")
check(wait(lambda: (cl._read_transfer_doc("watcher") or {}).get("status") == "done"), "the trial finishes")
tr = next(s for s in rep.scan(include_newborn=True) if s["name"] == "watcher").get("transfer", {})
check(tr.get("kind") == "trial" and tr.get("exit") == 0 and "no alert" in tr.get("tail", ""), f"report: trial exit 0 and its tail ({tr})")

TO = 'STRATEGY_NAME = "trader"\nimport requests\nrequests.post("https://x", json={})\n'
res = imp({"name": "trader", "files": [tf("strategy.py", TO)]})
check(res["run"] == "not_run" and res["can_order"] and res["order_lines"] and cl._read_transfer_doc("trader") is None,
      f"Type B that can place an order → never run ({res['order_lines']})")
check(refused({"name": "broken_a", "files": [tf("strategy.py", "# Type: A\ndef x(:\n")]}) == "NO_STRATEGY_NAME"
      and "broken_a" not in folders(), "a Type A strategy.py that does not parse → NO_STRATEGY_NAME, nothing written")
res = imp({"name": "broken_b", "files": [tf("strategy.py", "# Type: B\ndef x(:\n")]})
check(res["run"] == "not_run" and res["syntax_errors"] and cl._read_transfer_doc("broken_b") is None,
      "an unnamed Type B strategy.py that does not compile → moved, not run, the error named")

# a plain Type B script with no STRATEGY_NAME at all: moved under the folder id, never backtested
PLAIN = 'import os\nprint("plain monitor ok", os.environ.get("BLAVE_MODE"))\n# alerts for plain\n'
res = imp({"name": "plain", "files": [tf("strategy.py", PLAIN)]})
check(res["dest"] == "plain" and res["type"] == "B" and res["run"] == "trial" and not res["renamed"],
      f"unnamed Type B → moved as its folder id, a trial (no backtest) ({res})")
check(wait(lambda: (cl._read_transfer_doc("plain") or {}).get("status") == "done")
      and not os.path.exists(os.path.join(SDIR, "plain", "stats.json")) and not os.path.exists(os.path.join(SDIR, "plain", "versions")),
      "…the trial finishes, no stats.json, no version minted")
check((cl._read_transfer_doc("plain") or {}).get("tail", "").strip().endswith("plain monitor ok backtest"),
      f"…the trial runs BLAVE_MODE=backtest, never live ({(cl._read_transfer_doc('plain') or {}).get('tail')!r})")

# the unnamed Type B exception only holds when no file names STRATEGY_NAME and none imports lib.runner:
# each of these points runner at another (live) strategy and is refused before anything is written
RUN_TAIL = "\ndef fetch_data(h):\n    return None\ndef signals(df):\n    return df\nrun(locals(), fetch_data, signals)\n"
VIA_STAR = [tf("strategy.py", "# Type: B\nfrom helper import *\nfrom lib.runner import run" + RUN_TAIL),
            tf("helper.py", 'STRATEGY_NAME = "live_one"\n')]
NAME_TRICKS = {
    "# Type: B + helper import * + lib.runner": VIA_STAR,
    "no header + helper import * + lib.runner": [tf("strategy.py", "from helper import *\nfrom lib.runner import run" + RUN_TAIL),
                                                  VIA_STAR[1]],
    "globals()": [tf("strategy.py", '# Type: B\nimport lib.runner\nglobals()["STRATEGY" + "_NAME"] = "live_one"\n'
                                    "lib.runner.run(globals(), None, None)\n")],
    "setattr(sys.modules)": [tf("strategy.py", 'import sys\nfrom lib import runner\n'
                                               'setattr(sys.modules[__name__], "STRATEGY" + "_NAME", "live_one")\n'
                                               "runner.run(globals(), None, None)\n")],
    "from lib import *": [tf("strategy.py", '# Type: B\nfrom lib import *\nprint(1)\n')],
    "helper names it, no runner": [tf("strategy.py", "# Type: B\nimport helper\n"), tf("helper.py", 'STRATEGY_NAME = "live_one"\n')],
}
n0 = folders()
got = {label: refused({"name": "tricky", "files": files}) for label, files in NAME_TRICKS.items()}
check(set(got.values()) == {"NO_STRATEGY_NAME"} and folders() == n0, f"unnamed Type B tricks → NO_STRATEGY_NAME, nothing written ({got})")
check(T.imports_runner(["import lib.runner as r"]) and T.imports_runner(["from lib.runner import run"])
      and T.imports_runner(["from lib import runner"]) and T.imports_runner(["from lib import *"])
      and not T.imports_runner(["from lib import data", "import helper", "def x(:"]), "imports_runner: the four forms, not lib.data / a sibling")

# cross-file override (any type): a helper copied from another strategy still binds STRATEGY_NAME, or a
# wildcard import could pull one over strategy.py's literal — the backtest would mint under that strategy
OVERRIDES = {
    "Type A, helper binds it, import *": [tf("strategy.py", TYPE_A.format(name="momo", display="x").replace(
        "import helper\n", "from helper import *\n")), tf("helper.py", 'STRATEGY_NAME = "live_one"\nHOW = ""\n')],
    "Type A, helper rebinds __main__'s": [tf("strategy.py", TYPE_A.format(name="momo", display="x")),
                                          tf("helper.py", 'import __main__\n__main__.STRATEGY_NAME = "live_one"\nHOW = ""\n')],
    "import * of a helper with no name": [tf("strategy.py", TYPE_A.format(name="momo", display="x").replace(
        "import helper\n", "import helper\nfrom helper import *\n")), tf("helper.py", 'HOW = ""\n')],
}
n0 = folders()
got = {label: refused({"name": "momo", "files": files}) for label, files in OVERRIDES.items()}
check(set(got.values()) == {"NO_STRATEGY_NAME"} and folders() == n0,
      f"a helper binding STRATEGY_NAME, or any import *, → NO_STRATEGY_NAME, nothing written ({got})")

# layer 1, whatever got past layer 2: a trial whose code names a strategy in the 下單設定 (live_one,
# amount 100) writes no live state.json for it — the trial runs BLAVE_MODE=backtest
cl._transfer_write("l1probe", T.decode_files(type_a(name="live_one")))
cl._start_transfer_run("l1probe", "trial", "cloud", "0" * 16)
check(wait(lambda: (cl._read_transfer_doc("l1probe") or {}).get("status") not in (None, "running"), 120)
      and not os.path.exists(os.path.join(SDIR, "live_one", "state.json")),
      f"a trial pointed at a live strategy writes no state.json for it ({cl._read_transfer_doc('l1probe')}, "
      f"{os.listdir(os.path.join(SDIR, 'live_one')) if os.path.isdir(os.path.join(SDIR, 'live_one')) else None})")
for leftover in ("l1probe", "live_one"):
    shutil.rmtree(os.path.join(SDIR, leftover), ignore_errors=True)
res = imp({"name": "plain", "files": [tf("strategy.py", PLAIN)]})
check(res["dest"] == "plain_2" and res["renamed"] and res["run"] == "trial" and res["still_names"] == ["strategy.py"]
      and read(os.path.join(SDIR, "plain_2", "strategy.py")) == PLAIN,
      f"…taken name → plain_2, the text untouched (nothing to rename), the mention listed ({res})")
wait(lambda: (cl._read_transfer_doc("plain_2") or {}).get("status") == "done")
res = imp({"name": "broken", "files": [tf("strategy.py", 'STRATEGY_NAME = "broken"\nimport helper\n'),
                                        tf("helper.py", "def x(:\n")]})
check(res["run"] == "not_run" and res["syntax_errors"] and "helper.py" in res["syntax_errors"][0],
      "Type B with a file that does not compile → not run, the error named")

# writes a marker in the workspace (outside its own folder) once it is really running, then sleeps:
# the delete below happens only after that, so the run cannot end on its own by failing to open its file
slow = 'import time\nSTRATEGY_NAME = "slow"\nopen("slow.started", "w").close()\ntime.sleep(60)\n'
MARK = os.path.join(WS, "slow.started")
res = imp({"name": "slow", "files": [tf("strategy.py", slow)]})
pid = cl._read_transfer_doc("slow")["pid"]
check(wait(lambda: os.path.exists(MARK), 30), "the slow run is up (its marker is written)")


def pid_alive(p):
    try:
        os.kill(p, 0)
    except OSError:
        return False
    import subprocess
    r = subprocess.run(["ps", "-o", "stat=", "-p", str(p)], capture_output=True, text=True)
    return bool(r.stdout.strip()) and not r.stdout.strip().startswith("Z")


time.sleep(1)
check(pid_alive(pid), "the slow run is alive before the delete")
out = cl._cmd_delete_strategy({"name": "slow"})
check(str(out).startswith("delete_strategy=") and wait(lambda: not pid_alive(pid), 15) and "slow" not in folders(),
      f"delete_strategy (the command entry) kills the live transfer run and the folder goes ({out})")
time.sleep(1)
check("slow" not in folders(), "…and the dead run does not recreate the folder")
with open(os.path.join(SDIR, "momo_3", cl.TRANSFER_FILE), "w") as fh:
    json.dump({"kind": "backtest", "status": "running", "at": int(time.time()) - 5, "pid": 999999, "from": "cloud"}, fh)
cl._resume_transfer_watch()
check((cl._read_transfer_doc("momo_3") or {}).get("status") == "failed", "listener restart: a dead run is settled, not left running")
old = {"kind": "trial", "status": "done", "at": int(time.time()) - rep.TRANSFER_KEEP_S - 10, "exit": 0}
with open(os.path.join(SDIR, "watcher", cl.TRANSFER_FILE), "w") as fh:
    json.dump(old, fh)
check("transfer" not in next(s for s in rep.scan(include_newborn=True) if s["name"] == "watcher"), "a settled record older than a week is not reported")

# ── 7. keys (cloud) ──────────────────────────────────────────────────────────
ENV = os.path.join(WS, ".env")
with open(ENV, "w") as fh:
    fh.write("BLAVE_API_KEY=k\nDATA_API_KEY=exchange\nDATA_FRED_KEY='stray'\n"
             f"{T.ENV_BEGIN}\n# source FRED added=111\nDATA_FRED_KEY='old'\nDATA_FRED_EXTRA='old2'\n"
             f"# source POLYGON added=222\nDATA_POLYGON_TOKEN='keep'\n{T.ENV_END}\n")
import contextlib  # noqa: E402
LOCK_HELD, ENV_WRITES = [False], []
real_env_lock, real_replacing = cl._env_lock, cl.atomic_file.replacing


@contextlib.contextmanager
def spy_lock(*a, **k):
    with real_env_lock(*a, **k):
        LOCK_HELD[0] = True
        try:
            yield
        finally:
            LOCK_HELD[0] = False


def spy_replacing(path, *a, **k):
    if os.path.basename(path) == ".env":
        ENV_WRITES.append(LOCK_HELD[0])
    return real_replacing(path, *a, **k)


cl._env_lock, cl.atomic_file.replacing = spy_lock, spy_replacing
os.environ["BLAVE_AGENT_LOCAL"] = "0"
try:
    VAL = "MARKER_VALUE_8c1"
    res = imp({"name": "trader", "files": [tf("strategy.py", TO)], "env": {"DATA_FRED_KEY": VAL, "DATA_NEWS_TOKEN": "n1"}})
finally:
    os.environ["BLAVE_AGENT_LOCAL"] = "1"
    cl._env_lock, cl.atomic_file.replacing = real_env_lock, real_replacing
check(ENV_WRITES == [True], f".env is replaced only while .env.lock is held ({ENV_WRITES})")
env_text = read(ENV)
check(res["keys"] == ["DATA_FRED_KEY", "DATA_NEWS_TOKEN"] and VAL not in json.dumps(res), f"keys written, names only in the ack ({res.get('keys')})")
check(env_text.startswith("BLAVE_API_KEY=k\nDATA_API_KEY=exchange\n" + T.ENV_BEGIN) and "'stray'" not in env_text
      and "DATA_FRED_EXTRA" not in env_text and f"# source FRED added=111\nDATA_FRED_KEY='{VAL}'" in env_text
      and "# source POLYGON added=222\nDATA_POLYGON_TOKEN='keep'" in env_text and "DATA_NEWS_TOKEN='n1'" in env_text
      and env_text.endswith(T.ENV_END + "\n"),
      "block: FRED replaced as a unit (stray copy and old field gone, added kept), POLYGON and other lines untouched")
check(stat.S_IMODE(os.stat(ENV).st_mode) == 0o600, ".env stays 0600")
txt, _ = T.merge_env_text("", {"DATA_X_KEY": "v"}, now=5)
check(txt == f"{T.ENV_BEGIN}\n# source X added=5\nDATA_X_KEY='v'\n{T.ENV_END}\n", "a fresh .env gets exactly the managed block")
try:
    T.merge_env_text("", {f"DATA_X_F{i}": "v" for i in range(9)})
    c = "accepted"
except ValueError as e:
    c = code_of(e)
check(c == "BAD_ARGS", "more than 8 fields in a source → refused")

# ── 8. export ────────────────────────────────────────────────────────────────
E = os.path.join(SDIR, "momo_2")
with open(os.path.join(E, "params.json"), "w") as fh:
    fh.write("{}")
os.makedirs(os.path.join(E, "data"))
os.symlink(os.path.join(SDIR, "momo", "strategy.py"), os.path.join(E, "link.py"))
SENT = []


class _Resp:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return b'{"status": "ok"}'


def fake_urlopen(req, timeout=None):
    SENT.append((req.full_url, json.loads(req.data.decode()), dict(req.header_items())))
    return _Resp()


real_urlopen = cl.urllib.request.urlopen
cl.urllib.request.urlopen = fake_urlopen
CID = "a" * 32
try:
    d = cl.dispatch({"id": CID, "cmd": "strategy_export", "args": {"name": "momo_2"}})
    res = d.fn()
finally:
    cl.urllib.request.urlopen = real_urlopen
url, body, _ = SENT[0]
check(url.endswith("/export") and body["id"] == CID and body["name"] == "momo_2", "handed over under this command's id")
check([x["f"] for x in body["files"]] == ["helper.py", "strategy.py"]
      and res["files"] == [{"f": x["f"], "sha256": x["sha256"]} for x in body["files"]] and res["type"] == "A",
      "only the regular *.py travel; the ack carries their hashes")
check(sorted(res["left_behind"]) == ["data/", "link.py", "params.json"], f"left behind named: inputs and a symlink, not run outputs ({res['left_behind']})")
check(all(hashlib.sha256(base64.b64decode(x["b64"])).hexdigest() == x["sha256"] for x in body["files"]), "hashes match the bytes sent")


def http_err(req, timeout=None):
    import urllib.error
    raise urllib.error.HTTPError(req.full_url, 409, "conflict", {}, None)


cl.urllib.request.urlopen = http_err
try:
    c = None
    try:
        cl.dispatch({"id": CID, "cmd": "strategy_export", "args": {"name": "momo_2"}}).fn()
    except ValueError as e:
        c = code_of(e)
finally:
    cl.urllib.request.urlopen = real_urlopen
check(c == "HANDOVER", "an api refusal → HANDOVER")
for args, want in (({"name": "nope"}, "NO_SOURCE"), ({"name": "linked"}, "NO_SOURCE"), ({}, "BAD_ARGS"), ({"name": "../x"}, "BAD_ARGS")):
    try:
        d = cl.dispatch({"id": CID, "cmd": "strategy_export", "args": args})
        d.fn()
        c = "accepted"
    except ValueError as e:
        c = code_of(e)
    check(c == want, f"export {args} → {want} (got {c})")
with open(os.path.join(E, "we ird.py"), "w") as fh:
    fh.write("x = 1\n")
try:
    T.collect_export(WS, "momo_2")
    c = "accepted"
except ValueError as e:
    c = code_of(e)
check(c == "BAD_FILES", "a .py whose name fails the allow-list stops the export")
check("strategy_export" in ld.CLOUD_ONLY and "strategy_import" in ld.ALLOWED and "strategy_import" not in ld.CLOUD_ONLY,
      "local_daemon takes strategy_import (拉回, files staged by the app) and refuses strategy_export")
check({"strategy_import", "strategy_export"} <= set(cl.HANDLERS), "both have handlers")

# ── 9. staged files (拉回 onto this computer) ────────────────────────────────
STAGE_ROOT = os.path.join(WS, "state", "transfer_in")


def stage(sid, files, raw_over=None):
    d = os.path.join(STAGE_ROOT, sid)
    os.makedirs(d, exist_ok=True)
    for x in files:
        with open(os.path.join(d, x["f"]), "wb") as fh:
            fh.write((raw_over or {}).get(x["f"], base64.b64decode(x["b64"])))
    return [{"f": x["f"], "sha256": x["sha256"]} for x in files]


SID = "a" * 32
PULL = type_a(name="pulled", display="拉回 BTC")
got = T.import_args({"name": "pulled", "stage": SID, "files": stage(SID, PULL)}, local=True, workspace=WS)
check([f for f, _, _ in got[2]] == ["strategy.py", "helper.py"] and got[2][0][1] == base64.b64decode(PULL[0]["b64"])
      and not os.path.exists(os.path.join(STAGE_ROOT, SID)), "staged files read back as the import's files; the stage is removed")
for label, args_fn, want in (
        ("a cloud machine refuses staged files",
         lambda: T.import_args({"name": "pulled", "stage": SID, "files": stage(SID, PULL)}, local=False, workspace=WS),
         "BAD_ARGS"),
        ("a path-shaped stage id", lambda: T.import_args({"name": "pulled", "stage": "../x", "files": []}, True, WS),
         "BAD_ARGS"),
        ("a stage that was never written", lambda: T.import_args({"name": "pulled", "stage": "b" * 32,
                                                                  "files": [{"f": "strategy.py", "sha256": "0" * 64}]}, True, WS),
         "BAD_ARGS"),
        ("a staged file edited after the hash check",
         lambda: T.import_args({"name": "pulled", "stage": SID,
                                "files": stage(SID, PULL, {"helper.py": b"HOW = 'x'\n"})}, True, WS), "BAD_FILES"),
        ("a listed file missing from the stage",
         lambda: T.import_args({"name": "pulled", "stage": SID,
                                "files": stage(SID, PULL[:1]) + [{"f": "helper.py", "sha256": PULL[1]["sha256"]}]}, True, WS),
         "BAD_FILES"),
        ("a staged file over 128 KB",
         lambda: T.import_args({"name": "pulled", "stage": SID, "files": stage(SID, [PULL[0], tf("big.py", "x" * (T.FILE_MAX + 1))])},
                               True, WS), "TOO_LARGE"),
        ("a staged file carrying b64 too", lambda: T.import_args({"name": "pulled", "stage": SID, "files": [
            dict(stage(SID, PULL)[0], b64=PULL[0]["b64"])]}, True, WS), "BAD_FILES")):
    try:
        args_fn()
        c = "accepted"
    except ValueError as e:
        c = code_of(e)
    left = os.path.exists(os.path.join(STAGE_ROOT, SID))
    if label.startswith("a cloud"):   # never staged there by the app: the refusal comes first, nothing is read
        shutil.rmtree(os.path.join(STAGE_ROOT, SID), ignore_errors=True)
        left = False
    check(c == want and not left, f"{label} → {want}, stage removed (got {c})")
if os.name != "nt":
    os.makedirs(os.path.join(STAGE_ROOT, SID))
    outside = os.path.join(BASE, "outside.py")
    with open(outside, "w") as fh:
        fh.write("SECRET = 1\n")
    os.symlink(outside, os.path.join(STAGE_ROOT, SID, "strategy.py"))
    try:
        T.import_args({"name": "pulled", "stage": SID, "files": [{"f": "strategy.py", "sha256": hashlib.sha256(b"SECRET = 1\n").hexdigest()}]},
                      True, WS)   # the right hash: only refusing to follow the link stops it
        c = "accepted"
    except ValueError as e:
        c = code_of(e)
    check(c == "BAD_FILES" and os.path.exists(outside), f"a staged symlink is not followed → BAD_FILES (got {c})")
r = imp({"name": "pulled", "stage": SID, "files": stage(SID, PULL)})
check(r.get("dest") == "pulled" and r.get("run") == "backtest" and os.path.isfile(os.path.join(SDIR, "pulled", "strategy.py"))
      and not os.path.exists(os.path.join(STAGE_ROOT, SID)), f"strategy_import with a stage lands like any import → {r}")
check(wait(lambda: os.path.isfile(os.path.join(SDIR, "pulled", "stats.json"))
           and not os.path.exists(os.path.join(SDIR, "pulled", "transfer.json"))), "…and its backtest finishes")

# ── 10. helpers that read STRATEGY_NAME vs helpers that write it ─────────────
with open(os.path.join(ROOT, "examples", "btc_sma_cross", "scan.py"), encoding="utf-8") as fh:
    SCAN = fh.read()   # the shipped example: `title=f'{s.STRATEGY_NAME} — Sharpe Grid'`
check("s.STRATEGY_NAME" in SCAN, "fixture: the example scan.py still reads s.STRATEGY_NAME")


def with_helper(name, helper_text, f="scan.py"):
    return [tf("strategy.py", TYPE_A.format(name=name, display="x")), tf("helper.py", 'HOW = ""\n'), tf(f, helper_text)]


def name_check(files, name="momo"):
    try:
        return T.check_name(T.decode_files(files), name)
    except T.Refused as e:
        return e.code


READS = {
    "the example scan.py": SCAN,
    "f-string": 'import strategy as s\ntitle = f"{s.STRATEGY_NAME} grid"\n',
    "plain read into another name": 'import strategy as s\nname = s.STRATEGY_NAME\nprint(s.STRATEGY_NAME)\n',
    "bare-name read in a function": 'def f():\n    return STRATEGY_NAME\n',
}
got = {k: name_check(with_helper("momo", v)) for k, v in READS.items()}
check(set(got.values()) == {"momo"}, f"helpers that only read STRATEGY_NAME pass check_name ({got})")
WRITES = {
    "module level": 'STRATEGY_NAME = "x"\n',
    "attribute": 'import strategy as s\ns.STRATEGY_NAME = "x"\n',
    "setattr": 'import strategy as s\nsetattr(s, "STRATEGY_NAME", "x")\n',
    "annotated": 'STRATEGY_NAME: str = "x"\n',
    "augmented attribute": 'import strategy as s\ns.STRATEGY_NAME += "_x"\n',
    "annotated attribute": 'import strategy as s\ns.STRATEGY_NAME: str = "x"\n',
    "inside a function": 'def f():\n    global STRATEGY_NAME\n    STRATEGY_NAME = "x"\n',
    "global alone": 'def f():\n    global STRATEGY_NAME\n',
    "for target": 'for STRATEGY_NAME in ["x"]:\n    pass\n',
    "with target": 'import contextlib\nwith contextlib.nullcontext("x") as STRATEGY_NAME:\n    pass\n',
    "walrus": 'if (STRATEGY_NAME := "x"):\n    pass\n',
    "tuple unpacking": 'STRATEGY_NAME, Y = "x", 1\n',
    "import as": 'import json as STRATEGY_NAME\n',
    "from import": 'from other import STRATEGY_NAME\n',
    "from import as": 'from other import X as STRATEGY_NAME\n',
    "del": 'import strategy as s\ndel s.STRATEGY_NAME\n',
    "globals()[…]": 'globals()["STRATEGY_NAME"] = "x"\n',
    "a config dict for runner": 'from lib.runner import run\nrun({"STRATEGY_NAME": "x"}, None, None)\n',
    "keyword": 'globals().update(STRATEGY_NAME="x")\n',
    "exec": 'exec("STRATEGY_NAME = \'x\'")\n',
    "def": 'def STRATEGY_NAME():\n    return "x"\n',
    "class": 'class STRATEGY_NAME:\n    pass\n',
    "except as": 'try:\n    pass\nexcept Exception as STRATEGY_NAME:\n    pass\n',
    "parameter": 'def f(STRATEGY_NAME="x"):\n    return STRATEGY_NAME\n',
    "match capture": 'match 1:\n    case STRATEGY_NAME:\n        pass\n',
    "unparseable, names it": 'STRATEGY_NAME = "x"\ndef broken(:\n',
    "getattr read (data form)": 'import strategy as s\nn = getattr(s, "STRATEGY_NAME", "")\n',
    "docstring mentions it": '"""Plots STRATEGY_NAME."""\nx = 1\n',
}
# the eight that a version of this check let through and the substring rule had refused (code-auditor
# 0149): each turns the name into a run-time setattr; the first four were seen rewriting run(locals())
AUDIT = {
    "getattr rebound to setattr": ('import __main__\ngetattr = setattr\ngetattr(__main__, "STRATEGY_NAME", "live_one")\n', "STR"),
    "setattr imported as hasattr": ('import __main__\nfrom builtins import setattr as hasattr\nhasattr(__main__, "STRATEGY_NAME", "live_one")\n', "STR"),
    "bytes literal": ('import __main__\nsetattr(__main__, b"STRATEGY_NAME".decode(), "live_one")\n', "BYTES"),
    "module docstring as the name": ('"""STRATEGY_NAME"""\nimport __main__\nsetattr(__main__, __doc__, "live_one")\n', "STR"),
    "function docstring as the name": ('import __main__\ndef k():\n    "STRATEGY_NAME"\nsetattr(__main__, k.__doc__, "live_one")\n', "STR"),
    "name from getattr's AttributeError": ('import __main__\ntry:\n    getattr(object(), "STRATEGY_NAME")\nexcept AttributeError as e:\n'
                                           '    setattr(__main__, e.name, "live_one")\n', "STR"),
    "comment read back from the source": ('# STRATEGY_NAME\nimport __main__\nsetattr(__main__, open(__file__).read().split()[1], "live_one")\n', "COMMENT"),
    "match mapping rest": ('match {}:\n    case {**STRATEGY_NAME}:\n        pass\n', "MATCH"),
}
WRITES.update({k: v for k, (v, _) in AUDIT.items()})
got = {k: name_check(with_helper("momo", v)) for k, v in WRITES.items()}
check(set(got.values()) == {"NO_STRATEGY_NAME"}, f"every form of writing STRATEGY_NAME in a helper → NO_STRATEGY_NAME ({got})")
check(name_check(with_helper("momo", "def broken(:\n")) == "momo",
      "an unparseable helper that never names STRATEGY_NAME is left to the compile check (§6B), as before")
check(name_check(with_helper("momo", 'import strategy as s\nt = s.STRATEGY_NAME\n'), name="other") == "NAME_MISMATCH",
      "a read-only helper does not hide a strategy.py whose name is not the folder → NAME_MISMATCH")
check(name_check([tf("strategy.py", TYPE_A.format(name="momo", display="x").replace("import helper\n", "from scan import *\n")),
                  tf("helper.py", 'HOW = ""\n'), tf("scan.py", SCAN)]) == "NO_STRATEGY_NAME",
      "import * still refuses even when the helper only reads the name")

# the refusal's detail is `<why>: <file names>` only (the desktop picks its sentence by <why>, shows the names)


def name_detail(files, name="momo"):
    try:
        T.check_name(T.decode_files(files), name)
    except T.Refused as e:
        return str(e)
    return None


check(name_detail(with_helper("momo", WRITES["attribute"]) + [tf("plot.py", "# STRATEGY_NAME\n")])
      == "NO_STRATEGY_NAME: helpers: plot.py, scan.py"
      and name_detail([tf("strategy.py", TYPE_A.format(name="momo", display="x").replace("import helper\n", "from scan import *\n")),
                       tf("helper.py", 'HOW = ""\n'), tf("scan.py", SCAN)]) == "NO_STRATEGY_NAME: wildcard: strategy.py"
      and name_detail([tf("strategy.py", '# Type: A\nSTRATEGY_NAME = "momo"\nSTRATEGY_NAME = "x"\n')]) == "NO_STRATEGY_NAME: literal: strategy.py",
      "NO_STRATEGY_NAME detail: helpers / wildcard / literal, then the file names, comma-separated")
try:
    T.rename([("strategy.py", b"", 'STRATEGY_NAME = "other"\n')], "momo", "momo_2")
    rn = None
except T.Refused as e:
    rn = str(e)
check(rn == "NO_STRATEGY_NAME: literal: strategy.py", f"rename without the single literal line → literal detail ({rn})")

# mutation: drop one branch of _writes_strategy_name and the cases it alone stops must get through —
# so each assertion above is load-bearing (a red, not a coincidence of some other branch)
with open(os.path.join(RUNTIME, "strategy_transfer.py"), encoding="utf-8") as fh:
    SRC = fh.read()
BRANCH = {
    "ATTR": ("        if isinstance(node, ast.Attribute) and node.attr == key and isinstance(node.ctx, store):\n"
             "            return True   # strategy.STRATEGY_NAME = …, __main__.STRATEGY_NAME = …\n"),
    "STR": ("        if isinstance(node, ast.Constant) and isinstance(node.value, str) and key in node.value:\n"
            "            return True\n"),
    "BYTES": ("        if isinstance(node, ast.Constant) and isinstance(node.value, bytes) and key.encode() in node.value:\n"
              "            return True   # setattr(m, b\"STRATEGY_NAME\".decode(), …)\n"),
    "COMMENT": ("    if any(key in c for c in comments):\n"
                "        return True   # `# STRATEGY_NAME` read back through open(__file__)\n"),
    "MATCH": ('        if type(node).__name__ == "MatchMapping" and getattr(node, "rest", None) == key:\n'
              "            return True   # case {**STRATEGY_NAME}:\n"),
}


def mutant_verdict(branch, helper_text):
    m = types.ModuleType("strategy_transfer_mutant_" + branch)
    exec(compile(SRC.replace(BRANCH[branch], ""), m.__name__ + ".py", "exec"), m.__dict__)
    try:
        return m.check_name(T.decode_files(with_helper("momo", helper_text)), "momo")
    except m.Refused as e:
        return e.code


check(all(SRC.count(b) == 1 for b in BRANCH.values()), "mutation: each branch is found once in strategy_transfer.py")
cases = [("attribute", WRITES["attribute"], "ATTR")] + [(k, v, b) for k, (v, b) in AUDIT.items()]
got = {k: (name_check(with_helper("momo", v)), mutant_verdict(b, v)) for k, v, b in cases}
check(all(now == "NO_STRATEGY_NAME" and mut == "momo" for now, mut in got.values()),
      f"mutation: each case is refused now and gets through once its own branch is dropped ({got})")

# both directions run the same check: 送上雲端 lands on the cloud machine's listener, 拉回 on this
# computer's (local_daemon → the same handler, files staged by the app)
os.environ["BLAVE_AGENT_LOCAL"] = "0"
try:
    up = imp({"name": "zec_up", "files": with_helper("zec_up", SCAN)})
    up_bad = refused({"name": "zec_bad", "files": with_helper("zec_bad", WRITES["attribute"])})
finally:
    os.environ["BLAVE_AGENT_LOCAL"] = "1"
check(up.get("dest") == "zec_up" and up.get("run") == "backtest" and "scan.py" in os.listdir(os.path.join(SDIR, "zec_up")),
      f"送上雲端: a strategy with scan.py reading s.STRATEGY_NAME moves and backtests ({up})")
check(up_bad == "NO_STRATEGY_NAME" and "zec_bad" not in os.listdir(SDIR), f"送上雲端: a helper writing it → refused, nothing written ({up_bad})")
wait(lambda: (cl._read_transfer_doc("zec_up") or {}).get("status") != "running")
SID2, SID3 = "b" * 32, "c" * 32
down = imp({"name": "zec_down", "stage": SID2, "files": stage(SID2, with_helper("zec_down", SCAN))})
down_bad = refused({"name": "zec_down_bad", "stage": SID3, "files": stage(SID3, with_helper("zec_down_bad", WRITES["setattr"]))})
check(down.get("dest") == "zec_down" and down.get("run") == "backtest" and not os.path.exists(os.path.join(STAGE_ROOT, SID2)),
      f"拉回: the same strategy, staged, moves and backtests ({down})")
check(down_bad == "NO_STRATEGY_NAME" and "zec_down_bad" not in os.listdir(SDIR) and not os.path.exists(os.path.join(STAGE_ROOT, SID3)),
      f"拉回: a helper writing it → refused, nothing written, stage removed ({down_bad})")
wait(lambda: (cl._read_transfer_doc("zec_down") or {}).get("status") != "running")

time.sleep(0.5)
shutil.rmtree(BASE, ignore_errors=True)
print("all ok" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
