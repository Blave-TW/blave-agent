"""Minimal check for restoring a strategy version IN PLACE — the lib half
(.claude/docs/strategy-versions.md §2/§3/§5/§6; runtime half: tests/check_restore_command.py).

Drives the real lib/runner.run() on synthetic prices (MCPT off, no network) inside a temp
workspace:

  - restore(n): code back byte for byte, `current` = n, no new number, drift.json gone,
    last_note = n's VERSION_NOTE, stats/scan/wf/pnl.png moved to versions/pre-restore/;
    a current file no version holds is saved to versions/pre-restore.py first (backed_up),
    a second restore of the same version backs nothing up and leaves that slot alone;
    list_versions marks the current entry
  - same code mints nothing: a re-run keeps `current`; with two stored versions of the same
    code, `current` wins over the higher number; otherwise the highest match
  - drift compares against the version `current` points at, not the last entry
  - last_note: after a restore, an edit that forgets to update VERSION_NOTE stores an empty
    note, not the restored version's old line
  - a backtest whose file changes mid-run writes nothing (no stats.json, no version, the
    pending rerun.json untouched); a strategy deleted mid-run is not recreated
  - BLAVE_QUIET=1: a full backtest (stats, pnl.png, clears rerun.json) that pushes nothing —
    no Telegram, no photo, no chat mirror — on Type A and Type C
  - RESTORE_IN_PLACE is present as the plain `RESTORE_IN_PLACE = 1` line the runtime greps

Run: cd blave-agent && MPLBACKEND=Agg .venv/bin/python tests/check_restore_in_place.py
"""
import contextlib
import io
import json
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("MPLBACKEND", "Agg")
for k in ("BLAVE_MODE", "BLAVE_QUIET", "BLAVE_EXPECT_CODE_HASH"):
    os.environ.pop(k, None)

import numpy as np
import pandas as pd

import lib.notify as notify
import lib.runner as runner
import lib.strategy as strategy

runner.dotenv_values = lambda *a, **k: {}   # never read a real workspace .env

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


WS = Path(tempfile.mkdtemp(prefix="restore-inplace-"))
os.chdir(WS)
runner._REPO_ROOT = WS
strategy._REPO_ROOT = WS
(WS / "manager").mkdir()
(WS / "manager" / "portfolio_config.json").write_text(json.dumps({"amounts": {}, "exchanges": {}}))

NAME = "rip"
OUT = WS / "strategies" / NAME
SRC = OUT / "strategy.py"
VDIR = OUT / "versions"
OUT.mkdir(parents=True)

n = 400
IDX = pd.date_range("2024-01-01", periods=n, freq="h")
CLOSE = pd.Series(100 + np.cumsum(np.sin(np.arange(n) / 7.0)), index=IDX)
DF = pd.DataFrame({"Open": CLOSE, "High": CLOSE * 1.001, "Low": CLOSE * 0.999,
                   "Close": CLOSE, "Volume": 1.0}, index=IDX)
SIGNALS = pd.Series(np.where(np.arange(n) % 40 < 20, 1.0, 0.0), index=IDX)

PUSHED = []
notify.report_photo_web = lambda p: PUSHED.append(("chat", p))
notify.send_photo = lambda p: PUSHED.append(("photo", p))


def _try(fn):
    try:
        return fn()
    except Exception as e:
        return e


def code(note, tag):
    return f'VERSION_NOTE = "{note}"\n# {tag}\n'


def run(note, src=None, env=None, fetch=None, name=NAME, tg=None):
    """One run() of `name` with VERSION_NOTE `note`; `src` rewrites the file first."""
    path = WS / "strategies" / name / "strategy.py"
    if src is not None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(src, encoding="utf-8")
    config = {"STRATEGY_NAME": name, "SYMBOL": "BTCUSDT", "INTERVAL": "1h", "START": "2024-01-01",
              "FEE": 0.0005, "MCPT": False, "VERSION_NOTE": note, "__file__": str(path)}
    for k in ("BLAVE_MODE", "BLAVE_QUIET", "BLAVE_EXPECT_CODE_HASH"):
        os.environ.pop(k, None)
    os.environ.update(env or {})
    try:
        with contextlib.redirect_stdout(io.StringIO()) as out:
            runner.run(config, fetch or (lambda h: DF), lambda d: SIGNALS, tg)
        return out.getvalue()
    finally:
        for k in ("BLAVE_MODE", "BLAVE_QUIET", "BLAVE_EXPECT_CODE_HASH"):
            os.environ.pop(k, None)


def index():
    return json.loads((VDIR / "index.json").read_text())


def hashes():
    return {i["n"]: i["code_hash"] for i in index()["items"]}


def results_in_place():
    for f, body in (("scan.json", "{}"), ("wf.json", "{}")):
        (OUT / f).write_text(body)


check(re.search(r"^RESTORE_IN_PLACE\s*=\s*1\b", (Path(ROOT) / "lib" / "strategy.py").read_text(), re.M)
      is not None, "lib/strategy.py carries the `RESTORE_IN_PLACE = 1` line the runtime greps for")

# ── three versions ───────────────────────────────────────────────────────────
A, B, C = code("a", "A"), code("b", "B"), code("c", "C")
run("a", A)
run("b", B)
run("c", C)
check(index()["counter"] == 3 and index()["current"] == 3, "three edits → v1..v3, current 3")

# ── same code mints nothing ──────────────────────────────────────────────────
run("c")
check(index()["counter"] == 3 and index()["current"] == 3 and not (VDIR / "v4.json").exists(),
      "a re-run without an edit mints nothing (counter stays 3)")

# ── restore: in place, backup, stash ─────────────────────────────────────────
X = code("x", "hand edit nobody backtested")
SRC.write_text(X, encoding="utf-8")
results_in_place()
(OUT / "drift.json").write_text("{}")   # not the real location — make sure only versions/ is touched
(VDIR / "drift.json").write_text("{}")
before_pnl = (OUT / "pnl.png").read_bytes()
res = strategy.restore(NAME, 2)
check(SRC.read_bytes() == B.encode() and res == {"path": str(SRC), "version": 2, "inplace": True,
                                                 "backed_up": True, "stuck": []},
      f"restore(2): v2's code back byte for byte, inplace, backed_up (got {res})")
check(index()["current"] == 2 and index()["counter"] == 3 and not (VDIR / "v4.json").exists(),
      "…current points at 2, no new number")
check((VDIR / "pre-restore.py").read_bytes() == X.encode(),
      "…the unbacktested file was saved to versions/pre-restore.py before being overwritten")
check(index()["last_note"] == "b", f"…last_note is v2's VERSION_NOTE (got {index()['last_note']!r})")
check(not (VDIR / "drift.json").exists(), "…drift.json removed")
stash = VDIR / "pre-restore"
check(all(not (OUT / f).exists() for f in strategy.RESTORE_STASHED)
      and sorted(p.name for p in stash.iterdir()) == sorted(strategy.RESTORE_STASHED)
      and (stash / "pnl.png").read_bytes() == before_pnl,
      "…stats.json / scan.json / wf.json / pnl.png moved into versions/pre-restore/")
lv = strategy.list_versions(NAME)
check([i.get("current") for i in lv] == [None, True, None] and "current" not in index()["items"][1],
      "list_versions marks the current entry (in the answer only, never stored)")

res2 = strategy.restore(NAME, 2)
check(res2["backed_up"] is False and (VDIR / "pre-restore.py").read_bytes() == X.encode()
      and sorted(p.name for p in stash.iterdir()) == sorted(strategy.RESTORE_STASHED),
      "restoring the same version again: nothing backed up, both slots left as they were")

# ── drift compares against current ───────────────────────────────────────────
run("b", B, env={"BLAVE_MODE": "live"})
check(not (VDIR / "drift.json").exists(), "live tick on v2's code while current=2 → no drift flag "
      "(the last entry is v3 — comparing against it would flag)")
run("c", C, env={"BLAVE_MODE": "live"})
check(json.loads((VDIR / "drift.json").read_text()).get("version") == 2,
      "live tick on v3's code while current=2 → drift flag naming v2")
SRC.write_text(B, encoding="utf-8")

# ── the restore's re-run: quiet, same code, clears rerun.json ────────────────
(VDIR / "rerun.json").write_text(json.dumps({"n": 2, "at": 1, "status": "running", "pid": 1}))
TG = []
del PUSHED[:]
out = run("b", env={"BLAVE_MODE": "backtest", "BLAVE_QUIET": "1"}, tg=TG.append)
check(index()["current"] == 2 and index()["counter"] == 3,
      "quiet re-run of v2's code: mints nothing, current stays 2")
check((OUT / "stats.json").exists() and (OUT / "pnl.png").exists() and not (VDIR / "rerun.json").exists(),
      "…writes stats.json, redraws pnl.png, deletes rerun.json")
check(not TG and not PUSHED, f"…pushes nothing: no Telegram, no photo, no chat mirror (got {TG} {PUSHED})")
check(not (VDIR / "drift.json").exists(), "…and clears the drift flag")
run("b", env={"BLAVE_MODE": "backtest"}, tg=TG.append)
check(len(TG) == 1 and ("photo", str(OUT / "pnl.png")) in PUSHED and ("chat", str(OUT / "pnl.png")) in PUSHED,
      "positive control: the same backtest without BLAVE_QUIET sends Telegram + photo + chat mirror")

# ── same code: current first, then the highest match ─────────────────────────
items = index()["items"]
dup = dict(items[0], n=4)                                # v4 = same code as v1 (a pre-rule duplicate)
blob = json.loads((VDIR / "v1.json").read_text())
(VDIR / "v4.json").write_text(json.dumps(dict(blob, n=4)))
idx = index()
idx.update(counter=4, items=items + [dup])
(VDIR / "index.json").write_text(json.dumps(idx))
strategy.restore(NAME, 1)
run("a", env={"BLAVE_MODE": "backtest", "BLAVE_QUIET": "1"})
check(index()["current"] == 1 and index()["counter"] == 4,
      "v1 and v4 hold the same code, current=1: the re-run stays on v1 (not the higher v4)")
strategy.restore(NAME, 3)
SRC.write_text(A, encoding="utf-8")
run("a", env={"BLAVE_MODE": "backtest"})
check(index()["current"] == 4 and index()["counter"] == 4,
      "current=3, file now v1/v4's code: no mint, current → the highest match (v4)")

# ── last_note after a restore ────────────────────────────────────────────────
strategy.restore(NAME, 2)
run("b", code("b", "edited, note not updated"), env={"BLAVE_MODE": "backtest"})
check(index()["counter"] == 5 and index()["items"][-1]["note"] == "",
      f"after restoring v2, an edit that keeps v2's note is stored with an empty note "
      f"(got {index()['items'][-1]['note']!r})")

# ── superseded: the file changes mid-run ─────────────────────────────────────
strategy.restore(NAME, 2)
(VDIR / "rerun.json").write_text(json.dumps({"n": 2, "at": 1, "status": "running", "pid": 1}))
before = (VDIR / "index.json").read_bytes()


def edit_mid_run(h):
    SRC.write_text(code("y", "edited while the backtest ran"), encoding="utf-8")
    return DF


out = run("b", env={"BLAVE_MODE": "backtest", "BLAVE_QUIET": "1"}, fetch=edit_mid_run)
check(not (OUT / "stats.json").exists() and (VDIR / "index.json").read_bytes() == before
      and not (VDIR / "v6.json").exists() and "discarded" in out,
      "file changed mid-backtest → nothing written: no stats.json, index untouched, no v6, says so")
check((VDIR / "rerun.json").exists(),
      "…and the pending rerun.json is left for the runtime (a superseded run is not a finished one)")

os.remove(VDIR / "rerun.json")
SRC.write_text(code("y", "an edit that landed before run() read the file"), encoding="utf-8")
out = run("y", env={"BLAVE_MODE": "backtest", "BLAVE_QUIET": "1",
                    "BLAVE_EXPECT_CODE_HASH": hashes()[2]})
check(not (OUT / "stats.json").exists() and (VDIR / "index.json").read_bytes() == before and "discarded" in out,
      "a restore's re-run pinned to v2's hash, file already edited when run() read it → nothing written")
SRC.write_text(B, encoding="utf-8")
run("b", env={"BLAVE_MODE": "backtest", "BLAVE_QUIET": "1", "BLAVE_EXPECT_CODE_HASH": hashes()[2]})
check((OUT / "stats.json").exists() and index()["current"] == 2,
      "…the same pin on v2's own code runs normally")

GHOST = "ghost"
run("g", code("g", "G"), name=GHOST)
gdir = WS / "strategies" / GHOST


def delete_mid_run(h):
    shutil.rmtree(gdir)
    return DF


run("g", fetch=delete_mid_run, name=GHOST, env={"BLAVE_MODE": "backtest"})
check(not gdir.exists(), "strategy deleted mid-backtest → its folder is not recreated")

# ── Type C: quiet and superseded take the same gates ─────────────────────────
rng = np.random.default_rng(3)
D = pd.bdate_range("2023-01-02", periods=300)
PC = pd.DataFrame(100 * np.exp(np.cumsum(rng.normal(0.0003, 0.012, (300, 3)), axis=0)), index=D,
                  columns=list("ABC"))


def typec(data):
    c = data
    w = np.where(c.pct_change(10, fill_method=None).rank(axis=1) >= 2, 0.5, 0.0)
    return w, pd.concat({"close": c, "open": c}, axis=1)


PF = WS / "strategies" / "pf"
PF.mkdir()
(PF / "strategy.py").write_text(code("pf", "C1"), encoding="utf-8")
cfg = {"STRATEGY_NAME": "pf", "INTERVAL": "1d", "START": "2023-01-02", "FEE": 0.001,
       "VERSION_NOTE": "pf", "__file__": str(PF / "strategy.py")}
TG = []
del PUSHED[:]
os.environ.update({"BLAVE_MODE": "backtest", "BLAVE_QUIET": "1"})
with contextlib.redirect_stdout(io.StringIO()):
    runner.run(cfg, lambda h: PC.copy(), typec, TG.append)
check((PF / "stats.json").exists() and (PF / "pnl.png").exists() and not TG and not PUSHED,
      "Type C quiet backtest: stats.json + pnl.png written, nothing pushed")


def pf_edit(h):
    (PF / "strategy.py").write_text(code("pf", "C2"), encoding="utf-8")
    return PC.copy()


(PF / "stats.json").unlink()
with contextlib.redirect_stdout(io.StringIO()):
    runner.run(cfg, pf_edit, typec, TG.append)
check(not (PF / "stats.json").exists() and json.loads((PF / "versions" / "index.json").read_text())["counter"] == 1,
      "Type C file changed mid-backtest → no stats.json, no version")
for k in ("BLAVE_MODE", "BLAVE_QUIET", "BLAVE_EXPECT_CODE_HASH"):
    os.environ.pop(k, None)

# ── refusals carry the runtime's codes ───────────────────────────────────────
(WS / "manager" / "portfolio_config.json").write_text(json.dumps({"amounts": {NAME: 100}, "exchanges": {}}))
try:
    strategy.restore(NAME, 1)
    check(False, "funded → refused")
except ValueError as e:
    check(getattr(e, "restore_code", None) == "LIVE", "funded → ValueError tagged LIVE")
(WS / "manager" / "portfolio_config.json").write_text("{half")
try:
    strategy.restore(NAME, 1)
    check(False, "unreadable config → refused")
except Exception as e:
    check(getattr(e, "restore_code", None) == "CONFIG_UNREADABLE", "unreadable config → fails closed, CONFIG_UNREADABLE")
(WS / "manager" / "portfolio_config.json").write_text(json.dumps({"amounts": {}, "exchanges": {}}))
try:
    strategy.restore(NAME, 99)
    check(False, "missing version → refused")
except FileNotFoundError as e:
    check(getattr(e, "restore_code", None) == "NO_VERSION" and "kept" in str(e), "missing version → NO_VERSION")


# ── audit 0.1.9 P1-1: a restore landing while an older re-run writes its results ──
# The old re-run has passed its "file unchanged" check and is writing stats.json when the user
# (or the agent) restores another version. Before the fix its mint pulled `current` back to the
# old version: v2's code beside v1's numbers. Now the write tail and restore() share one lock.
import threading
R1 = "race"
R1DIR = WS / "strategies" / R1
run("a", code("a", "RA"), name=R1)
run("b", code("b", "RB"), name=R1)
run("c", code("c", "RC"), name=R1)
strategy.restore(R1, 1)                       # v1's re-run is about to run
real_write = runner._write_stats
racer = {}


def racing_write(out_dir, stats):
    runner._write_stats = real_write
    t = threading.Thread(target=lambda: racer.setdefault("res", strategy.restore(R1, 2)))
    t.start()
    racer["t"] = t
    t.join(0.5)                               # restore(2) gets as far as it can meanwhile
    return real_write(out_dir, stats)


runner._write_stats = racing_write
try:
    run("a", env={"BLAVE_MODE": "backtest", "BLAVE_QUIET": "1"}, name=R1)
finally:
    runner._write_stats = real_write
racer["t"].join(35)
r1_idx = json.loads((R1DIR / "versions" / "index.json").read_text())
check((R1DIR / "strategy.py").read_text() == code("b", "RB") and r1_idx["current"] == 2
      and not (R1DIR / "stats.json").exists(),
      f"re-run of v1 racing restore(v2): file v2, current 2, no v1 numbers left "
      f"(current {r1_idx['current']}, stats {(R1DIR / 'stats.json').exists()})")

# ── P2-1: deleted while the interpreter was still importing (run() cannot read __file__) ──
G2 = "ghost2"
run("g", code("g", "G2"), name=G2)
g2 = WS / "strategies" / G2
shutil.rmtree(g2)
with contextlib.redirect_stdout(io.StringIO()):
    os.environ["BLAVE_MODE"] = "backtest"
    try:
        runner.run({"STRATEGY_NAME": G2, "SYMBOL": "BTCUSDT", "INTERVAL": "1h", "START": "2024-01-01",
                    "FEE": 0.0005, "MCPT": False, "VERSION_NOTE": "g", "__file__": str(g2 / "strategy.py")},
                   lambda h: DF, lambda d: SIGNALS, None)
    except Exception:
        pass
    finally:
        os.environ.pop("BLAVE_MODE", None)
check(not (g2 / "stats.json").exists() and not (g2 / "versions").exists(),
      "strategy file already gone when run() starts → no stats.json, no version (no ghost)")

# ── P2-2: funded while the restore waited for the lock ───────────────────────
P22 = "wait"
run("a", code("a", "WA"), name=P22)
run("b", code("b", "WB"), name=P22)
p22 = WS / "strategies" / P22 / "strategy.py"
before = p22.read_bytes()
out = {}
with strategy.versions_lock(P22):
    t = threading.Thread(target=lambda: out.setdefault("r", _try(lambda: strategy.restore(P22, 1))))
    t.start()
    import time as _t
    _t.sleep(0.3)
    (WS / "manager" / "portfolio_config.json").write_text(json.dumps({"amounts": {P22: 50}, "exchanges": {}}))
t.join(35)
(WS / "manager" / "portfolio_config.json").write_text(json.dumps({"amounts": {}, "exchanges": {}}))
check(getattr(out.get("r"), "restore_code", None) == "LIVE" and p22.read_bytes() == before,
      "funded while restore() waited for the lock → LIVE, file untouched (amounts read again inside)")

# ── P2-3: a failure after the file was written puts the old file back ─────────
real_rb = strategy._replace_bytes


def failing_index(path, data, attempts=5):
    if Path(path).name == "index.json":
        raise PermissionError("index.json held open")
    return real_rb(path, data, attempts)


strategy._replace_bytes = failing_index
try:
    strategy.restore(P22, 1)
    check(False, "index write failure → raises")
except PermissionError:
    check(p22.read_bytes() == before and json.loads((WS / "strategies" / P22 / "versions" / "index.json").read_text())["current"] == 2,
          "index write fails after the code was written → the old file is put back, current unchanged")
finally:
    strategy._replace_bytes = real_rb

# ── P2-9: a blob on disk that the index no longer lists → NO_VERSION before any write ──
blob_only = WS / "strategies" / P22 / "versions" / "v9.json"
blob_only.write_text((WS / "strategies" / P22 / "versions" / "v1.json").read_text())
try:
    strategy.restore(P22, 9)
    check(False, "blob without index entry → NO_VERSION")
except FileNotFoundError as e:
    check(getattr(e, "restore_code", None) == "NO_VERSION" and p22.read_bytes() == before,
          "blob without an index entry → NO_VERSION, file untouched (not a misleading inplace:false)")

# ── P2-6: two unbacktested edits restored over in turn are both kept ──────────
vd = WS / "strategies" / P22 / "versions"
for f in vd.glob("pre-restore*.py"):
    f.unlink()
p22.write_text("# edit E\n")
strategy.restore(P22, 1)
p22.write_text("# edit F\n")
strategy.restore(P22, 2)
check((vd / "pre-restore.py").read_text() == "# edit F\n" and (vd / "pre-restore.1.py").read_text() == "# edit E\n",
      "two restores over two unbacktested edits keep both (pre-restore.py newest, .1 older)")

# ── P2-10: live tick that read the index before a restore wrote the file ──────
DR = "drace"
run("a", code("a", "DA"), name=DR)
run("b", code("b", "DB"), name=DR)
old_idx = json.loads((WS / "strategies" / DR / "versions" / "index.json").read_text())
strategy.restore(DR, 1)
real_load = strategy.load_index
calls = {"n": 0}


def stale_first(name):
    calls["n"] += 1
    return old_idx if calls["n"] == 1 else real_load(name)


strategy.load_index = stale_first
try:
    run("a", env={"BLAVE_MODE": "live"}, name=DR)
finally:
    strategy.load_index = real_load
check(not (WS / "strategies" / DR / "versions" / "drift.json").exists(),
      "live tick that read the pre-restore index: reads it again before flagging → no stale drift flag")

print("FAILED" if fails else "ALL PASS")
sys.exit(1 if fails else 0)
