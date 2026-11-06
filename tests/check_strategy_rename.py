"""Renaming a strategy — the lib half (spec strategy-rename-2026-11-05 §3/§5/§6; canon
strategy-versions §2 改名不算改碼; runtime half: tests/check_rename_command.py).

Drives the real lib/runner.run() on synthetic prices (MCPT off, no network) in a temp workspace:

  - code_hash leaves out column-0 `DISPLAY_NAME =` lines, byte for byte as
    tests/fixtures/code_hash_name.json says (the runtime and the shell run the same fixture)
  - a funded strategy renamed through rename(): the next live tick raises no drift flag, the next
    backtest mints nothing; also when its versions were minted before the rule (raw-bytes
    hashes) — rename re-spells them
  - renamed in chat (the line edited by hand) over a pre-rule version: the live tick still raises
    no drift flag (rekey_current); a real edit still does
  - restore(n) keeps the file's current name, stays in place, no drift on the next tick
  - rename() itself: only the string changes (comment, BOM, CRLF kept), the line is added under
    STRATEGY_NAME when missing, BAD_NAME / DUPLICATE / NOT_FOUND / NOT_LITERAL, an unchanged
    name writes nothing
  - name_problem() rejects everything runtime agent_turn._display_name would drop back to the
    code, and nothing the spec lets through

Run: cd blave-agent && MPLBACKEND=Agg .venv/bin/python tests/check_strategy_rename.py
"""
import contextlib
import hashlib
import io
import json
import os
import re
import sys
import tempfile
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "runtime"))
os.environ.setdefault("MPLBACKEND", "Agg")
for k in ("BLAVE_MODE", "BLAVE_QUIET", "BLAVE_EXPECT_CODE_HASH"):
    os.environ.pop(k, None)

import numpy as np
import pandas as pd

import lib.notify as notify
import lib.runner as runner
import lib.strategy as strategy

runner.dotenv_values = lambda *a, **k: {}
notify.report_photo_web = lambda p: None
notify.send_photo = lambda p: None

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


def code_of(e):
    return getattr(e, "restore_code", None)


def _try(fn):
    try:
        return fn()
    except Exception as e:
        return e


# ── the hash ──────────────────────────────────────────────────────────────────
FIX = json.loads((Path(ROOT) / "tests" / "fixtures" / "code_hash_name.json").read_text(encoding="utf-8"))
for c in FIX["cases"]:
    src, norm = c["src"].encode("utf-8"), c["norm"].encode("utf-8")
    check(strategy.code_hash(src) == hashlib.sha256(norm).hexdigest()[:16],
          f"code_hash fixture: {c['why']}")
check(strategy.raw_code_hash(b"x") == hashlib.sha256(b"x").hexdigest()[:16]
      and strategy.hash_matches(b'A=1\nDISPLAY_NAME = "a"\n', strategy.raw_code_hash(b'A=1\nDISPLAY_NAME = "a"\n'))
      and not strategy.hash_matches(b"A=1\n", None),
      "hash_matches takes the raw form too (stamps from before the rule), never None")
check(re.search(r"^STRATEGY_RENAME\s*=\s*1\b", (Path(ROOT) / "lib" / "strategy.py").read_text(), re.M)
      is not None, "lib/strategy.py carries the `STRATEGY_RENAME = 1` line the runtime and shell grep for")

# ── name rules ────────────────────────────────────────────────────────────────
for v, want in (("均線 A", None), ("x" * 60, None), ("x" * 61, "TOO_LONG"), ("", "EMPTY"),
                ("[測試] 均線", None), ("ETH（4h）", None), ("a[b]", None), ("[範本]", "WRAPPED"),
                ("a​b", "CHAR"), ('a"b', "CHAR"), ("a\\b", "CHAR")):
    check(strategy.name_problem(v) == want, f"name_problem({v[:12]!r}) = {want} (got {strategy.name_problem(v)})")
for ch in "、;:；：「」":
    check(strategy.name_problem("a" + ch + "b") == "CHAR", f"name_problem rejects {ch!r} (spec NAME_BAD)")
import types  # noqa: E402
sys.modules.setdefault("claude_agent_sdk", types.ModuleType("claude_agent_sdk"))
import agent_turn  # noqa: E402  the reader whose limits these rules exist for
missed = [hex(cp) for cp in range(0x110000) if not 0xD800 <= cp <= 0xDFFF
          and not agent_turn._name_ok(chr(cp)) and strategy.name_problem("a" + chr(cp) + "b") != "CHAR"]
check(not missed, f"every character runtime _display_name drops back to the code is refused here (missed {missed[:5]})")
check(strategy.NAME_MAX == 60, "NAME_MAX = 60 = runtime _display_name's v[:60]")

# ── workspace ─────────────────────────────────────────────────────────────────
WS = Path(tempfile.mkdtemp(prefix="strategy-rename-"))
os.chdir(WS)
runner._REPO_ROOT = WS
strategy._REPO_ROOT = WS
(WS / "manager").mkdir()


def fund(name, amount):
    (WS / "manager" / "portfolio_config.json").write_text(
        json.dumps({"amounts": {name: amount} if amount else {}, "exchanges": {}}))


fund("x", 0)
n = 400
IDX = pd.date_range("2024-01-01", periods=n, freq="h")
CLOSE = pd.Series(100 + np.cumsum(np.sin(np.arange(n) / 7.0)), index=IDX)
DF = pd.DataFrame({"Open": CLOSE, "High": CLOSE * 1.001, "Low": CLOSE * 0.999,
                   "Close": CLOSE, "Volume": 1.0}, index=IDX)
SIGNALS = pd.Series(np.where(np.arange(n) % 40 < 20, 1.0, 0.0), index=IDX)


def path_of(name):
    return WS / "strategies" / name / "strategy.py"


def vdir(name):
    return WS / "strategies" / name / "versions"


def run(name, mode, src=None):
    p = path_of(name)
    if src is not None:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(src, encoding="utf-8", newline="")
    config = {"STRATEGY_NAME": name, "SYMBOL": "BTCUSDT", "INTERVAL": "1h", "START": "2024-01-01",
              "FEE": 0.0005, "MCPT": False, "VERSION_NOTE": "", "__file__": str(p)}
    os.environ["BLAVE_MODE"] = mode
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            runner.run(config, lambda h: DF, lambda d: SIGNALS, None)
    finally:
        os.environ.pop("BLAVE_MODE", None)
        for k, fd in list(runner._held_backtest_locks.items()):   # a real run exits, letting go
            os.close(fd)
            del runner._held_backtest_locks[k]


def index(name):
    return json.loads((vdir(name) / "index.json").read_text())


def drifted(name):
    return (vdir(name) / "drift.json").exists()


def legacy(name):
    """What a machine upgraded from the raw-bytes era holds: every entry's hash raw."""
    idx = index(name)
    for i in idx["items"]:
        blob = json.loads((vdir(name) / f"v{i['n']}.json").read_text())
        i["code_hash"] = strategy.raw_code_hash(blob["code"].encode("utf-8"))
    (vdir(name) / "index.json").write_text(json.dumps(idx))


def src(display, tag, comment=""):
    return (f'"""{tag}"""\nSTRATEGY_NAME = "s"\nDISPLAY_NAME = "{display}"{comment}\n'
            f'SYMBOL = "BTCUSDT"\n# {tag}\n')


# ── a funded strategy renamed through the button ──────────────────────────────
for era in ("new", "legacy"):
    NAME = f"live_{era}"
    run(NAME, "backtest", src(f"均線 {era}", "v1"))
    run(NAME, "backtest", src(f"均線 {era}", "v2"))
    if era == "legacy":
        legacy(NAME)
    fund(NAME, 100)
    run(NAME, "live")
    check(not drifted(NAME), f"[{era}] baseline: a live tick on current code raises no drift flag")
    res = strategy.rename(NAME, f"  趨勢 {era}  ")
    check(res["changed"] is True and strategy.literal_name(path_of(NAME).read_text(encoding="utf-8")) == f"趨勢 {era}",
          f"[{era}] rename() writes the stripped name")
    run(NAME, "live")
    check(not drifted(NAME), f"[{era}] after rename, the live tick raises no 檔案已改 flag")
    fund(NAME, 0)
    run(NAME, "backtest")
    check(index(NAME)["counter"] == 2 and index(NAME)["current"] == 2,
          f"[{era}] after rename, a backtest mints no new version (counter {index(NAME)['counter']})")
    if era == "legacy":
        check(all(i["code_hash"] == strategy.code_hash(
            json.loads((vdir(NAME) / f"v{i['n']}.json").read_text())["code"].encode()) for i in index(NAME)["items"]),
            "[legacy] rename re-spelled every pre-rule entry name-blind")

# ── renamed in chat over a pre-rule version ───────────────────────────────────
NAME = "chat"
run(NAME, "backtest", src("原名", "v1"))
legacy(NAME)
fund(NAME, 100)
path_of(NAME).write_text(src("聊天改的名", "v1"), encoding="utf-8")
run(NAME, "live")
check(not drifted(NAME), "the DISPLAY_NAME line edited by hand over a pre-rule version: no drift flag")
path_of(NAME).write_text(src("聊天改的名", "v1 edited"), encoding="utf-8")
run(NAME, "live")
check(drifted(NAME), "positive control: a real code edit still raises the drift flag")
fund(NAME, 0)

# ── restore keeps the current name ────────────────────────────────────────────
for era in ("new", "legacy"):
    NAME = f"rst_{era}"
    run(NAME, "backtest", src(f"舊名 {era}", "v1"))
    run(NAME, "backtest", src(f"舊名 {era}", "v2"))
    if era == "legacy":
        legacy(NAME)
    strategy.rename(NAME, f"新名 {era}")
    res = strategy.restore(NAME, 1)
    text = path_of(NAME).read_text(encoding="utf-8")
    check(res["inplace"] is True and index(NAME)["current"] == 1 and "# v1" in text,
          f"[{era}] restore(1): v1's code back in place, current 1 (got {res})")
    check(strategy.literal_name(text) == f"新名 {era}", f"[{era}] …and the name stays the current one, not v1's")
    fund(NAME, 100)
    run(NAME, "live")
    check(not drifted(NAME), f"[{era}] …the next live tick raises no drift flag")
    fund(NAME, 0)
    run(NAME, "backtest")
    check(index(NAME)["counter"] == 2 and index(NAME)["current"] == 1,
          f"[{era}] …and its re-run mints nothing, current stays 1")

# ── rename() itself ───────────────────────────────────────────────────────────
NAME = "edit"
p = path_of(NAME)
p.parent.mkdir(parents=True)
p.write_bytes(b'\xef\xbb\xbf"""d"""\r\nSTRATEGY_NAME = "edit"\r\nDISPLAY_NAME = \'Bob\'  # shown\r\nX = 1\r\n')
before = p.read_bytes()
strategy.rename(NAME, "編輯名")
check(p.read_bytes() == b'\xef\xbb\xbf"""d"""\r\nSTRATEGY_NAME = "edit"\r\nDISPLAY_NAME = "' + "編輯名".encode() + b'"  # shown\r\nX = 1\r\n',
      "only the string changes: BOM, CRLF and the trailing comment stay, written in \"…\"")
check(strategy.code_hash(p.read_bytes()) == strategy.code_hash(before), "…and code_hash is unchanged")
os.utime(p, ns=(1_700_000_000_000_000_000, 1_700_000_000_000_000_000))
strategy.rename(NAME, "留在原位")
check(p.stat().st_mtime_ns == 1_700_000_000_000_000_000 and strategy.literal_name(p.read_text(encoding="utf-8-sig")) == "留在原位",
      "rename keeps the file's mtime (Wei: the renamed strategy keeps its place in the desktop's 'touched last' order)")
strategy.rename(NAME, "編輯名")
mt = p.stat().st_mtime_ns
check(strategy.rename(NAME, "編輯名")["changed"] is False and p.stat().st_mtime_ns == mt,
      "the same name again writes nothing")

p.write_text('"""doc"""\nSTRATEGY_NAME = "edit"\nX = 1\n', encoding="utf-8")
before = p.read_bytes()
strategy.rename(NAME, "加上的名")
check(p.read_text(encoding="utf-8") == '"""doc"""\nSTRATEGY_NAME = "edit"\nDISPLAY_NAME = "加上的名"\nX = 1\n'
      and strategy.code_hash(p.read_bytes()) == strategy.code_hash(before),
      "no DISPLAY_NAME: added under STRATEGY_NAME, code_hash unchanged")
p.write_text('"""doc"""\nfrom __future__ import annotations\nX = 1\n', encoding="utf-8")
strategy.rename(NAME, "B")
check(p.read_text(encoding="utf-8") == '"""doc"""\nfrom __future__ import annotations\nDISPLAY_NAME = "B"\nX = 1\n',
      "no STRATEGY_NAME either: under the docstring and __future__ imports")

for body, why in (('DISPLAY_NAME = "a" + "b"\n', "an expression"),
                  ('DISPLAY_NAME: str = "a"\n', "an annotation"),
                  ('DISPLAY_NAME = "a"\nDISPLAY_NAME = "b"\n', "assigned twice"),
                  ('DISPLAY_NAME = (\n    "a")\n', "two lines"),
                  ('DISPLAY_NAME = f"a"\n', "an f-string"),
                  ('DISPLAY_NAME = "a\\u0041"\n', "an escape"),
                  ('def f(:\n', "a syntax error")):
    p.write_text(body, encoding="utf-8")
    keep = p.read_bytes()
    e = _try(lambda: strategy.rename(NAME, "新"))
    check(code_of(e) == "NOT_LITERAL" and p.read_bytes() == keep, f"NOT_LITERAL, file untouched: {why}")
p.write_bytes(b'DISPLAY_NAME = "a"\n# \xff\n')
check(code_of(_try(lambda: strategy.rename(NAME, "新"))) == "NOT_LITERAL", "NOT_LITERAL: not UTF-8")

p.write_text('DISPLAY_NAME = "a"\n', encoding="utf-8")
for v in ("", "   ", "x" * 61, "a;b", "[x]", 'a"b', None):
    e = _try(lambda: strategy.rename(NAME, v))
    check(code_of(e) == "BAD_NAME", f"BAD_NAME: {v!r}")
check(code_of(_try(lambda: strategy.rename("nope", "x"))) == "NOT_FOUND", "NOT_FOUND: no such strategy")
(WS / "strategies" / "single.py").write_text('DISPLAY_NAME = "Ｔrend Ａ"\n', encoding="utf-8")
(WS / "strategies" / "noname").mkdir()
(WS / "strategies" / "noname" / "strategy.py").write_text('STRATEGY_NAME = "noname_id"\n', encoding="utf-8")
for v, why in (("trend a", "another's DISPLAY_NAME, NFKC + lower"), ("NoName", "a folder shown as its name"),
               ("noname_id", "a STRATEGY_NAME shown as its name"), (" 趨勢 NEW ", "a name set above (live_new)")):
    check(code_of(_try(lambda: strategy.rename(NAME, v))) == "DUPLICATE", f"DUPLICATE: {why}")
check(strategy.rename(NAME, "a")["changed"] is False, "its own current name is not a duplicate")

import fcntl  # noqa: E402
lk = os.open(p.parent / runner.BACKTEST_LOCK, os.O_CREAT | os.O_RDWR, 0o600)
fcntl.flock(lk, fcntl.LOCK_EX)
check(code_of(_try(lambda: strategy.rename(NAME, "跑中"))) == "JOB_RUNNING",
      "JOB_RUNNING while a backtest holds the runner's lock")
os.close(lk)
check(strategy.rename(NAME, "跑完")["changed"] is True, "…and renames once it is released")

print(f"\n{'FAIL' if fails else 'OK'}: {fails} failure(s)")
sys.exit(1 if fails else 0)
