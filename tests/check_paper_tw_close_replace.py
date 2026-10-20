"""Windows: state/paper_tw_close.json (flatten's deferred paper TW closes) was written with a bare
os.replace while the reconciler reads it — WinError 5 failed defer_paper_tw_close / the
reconciler round. Both writers now go through lib/winreplace.atomic_replace.

Simulates the PermissionError by patching os.replace, so it runs anywhere:
  ① defer_paper_tw_close: PermissionError once → keys land;
  ② _paper_tw_deferred (halted, some keys no longer held): PermissionError once → file narrowed;
  ③ POSIX config (no delays) → the error surfaces as before.

Run: cd blave-agent && python3 tests/check_paper_tw_close_replace.py
"""
import json, os, shutil, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from lib import portfolio, winreplace  # noqa: E402

fails = []


def t(name, ok, got=None):
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok or got is None else f"  → {got!r}"))
    if not ok:
        fails.append(name)


WIN_DELAYS = (0.05, 0.1, 0.2, 0.4, 0.5)
real_replace, real_sleep, real_delays = os.replace, winreplace.time.sleep, winreplace.REPLACE_RETRY_DELAYS
cwd = os.getcwd()
d = tempfile.mkdtemp(prefix="check-paper-tw-close-")
os.chdir(d)


def run(call, delays):
    calls = []

    def fake_replace(src, dst):
        calls.append(1)
        if len(calls) == 1:
            raise PermissionError(5, "Access is denied")
        real_replace(src, dst)

    winreplace.REPLACE_RETRY_DELAYS = delays
    os.replace, winreplace.time.sleep = fake_replace, (lambda s: None)
    out = err = None
    try:
        out = call()
    except OSError as e:
        err = e
    finally:
        os.replace, winreplace.time.sleep, winreplace.REPLACE_RETRY_DELAYS = real_replace, real_sleep, real_delays
    return out, err


def keys_on_disk():
    with open(portfolio._PAPER_TW_CLOSE_PATH) as f:
        return json.load(f)["keys"]


try:
    out, err = run(lambda: portfolio.defer_paper_tw_close(["paper:2330", "paper:2317"]), WIN_DELAYS)
    t("① defer_paper_tw_close: transient PermissionError, keys land",
      err is None and keys_on_disk() == ["paper:2317", "paper:2330"], err)

    held = {"paper:2330": {"size": 1}, "paper:2317": {"size": 0}}
    out, err = run(lambda: portfolio._paper_tw_deferred(held, True), WIN_DELAYS)
    t("② _paper_tw_deferred: transient PermissionError, file narrowed to held keys",
      err is None and out == {"paper:2330"} and keys_on_disk() == ["paper:2330"], (err, out))

    out, err = run(lambda: portfolio.defer_paper_tw_close(["paper:2454"]), ())
    t("③ POSIX config: error surfaces as before", isinstance(err, PermissionError), err)
finally:
    os.chdir(cwd)
    shutil.rmtree(d, ignore_errors=True)

sys.exit(1 if fails else 0)
