"""Never-configured machine = read-only reconciler (Wei 2026-09-23).

Without manager/portfolio_config.json (amounts never saved) the target is
empty and, without self_ledger, every position on the account reads as "close
it" — the user's manual ones included. lib/portfolio.reconcile must read and
snapshot positions but send NOTHING. Saving amounts — even all 0, the taught
way to flatten — makes it trade (close) as before. The report says which.

Then the two ways that guard was still losing the user's money (audit
2026-09-23):
  B1 — the read-only round writes manager/last_reconcile.json, and
  command_listener._fresh_portfolio_config() counted that file as "this
  machine has traded": the user's FIRST save then came out WITHOUT
  self_ledger, and the next round closed their manual position. Only
  orders.jsonl (an order really sent) counts. Tested through _cmd_amounts,
  the real save path.
  B2 — the report field ships with the runtime, the guard with the workspace
  lib: `portfolio_configured: false` may only be reported on evidence about
  the code that will actually run (a running reconciler's own snapshot, or —
  when it is not running — the lib on disk it will load next).

Run: cd blave-agent && .venv/bin/python tests/check_unconfigured_readonly.py
"""
import json
import os
import shutil
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = tempfile.mkdtemp(prefix="unconfigured-")
# notify config = none: any alert falls back to a log line, never a real Telegram
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = TMP
os.environ["BLAVE_AGENT_BASE"] = TMP
os.environ["BLAVE_AGENT_WORKSPACE"] = TMP
os.makedirs(os.path.join(TMP, "manager"))
os.makedirs(os.path.join(TMP, "state"))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "runtime"))


def _no_real_env(event, args):
    """This test imports the real command_listener and runs _cmd_amounts. The
    repo's own gitignored .env holds LIVE exchange keys; a code path that reads
    it could reach a real account. Nothing here may open it."""
    if event == "open" and os.path.abspath(str(args[0])) == os.path.join(ROOT, ".env"):
        raise PermissionError("the repo .env must never be read by a test")


sys.addaudithook(_no_real_env)
cwd = os.getcwd()
os.chdir(TMP)

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


from lib import portfolio  # noqa: E402
import portfolio_reporter  # noqa: E402

# the workspace copy of the lib under test, for the report's own evidence check
# (written after the import above, which must resolve to the repo's lib)
os.makedirs(os.path.join(TMP, "lib"), exist_ok=True)
with open(os.path.join(TMP, "lib", "portfolio.py"), "w") as f:
    f.write("def portfolio_configured():\n    pass\n")

placed = []
POSITIONS = {"BTCUSDT": {"side": "long", "size": 500.0}}  # the user's own manual long


def run():
    del placed[:]
    return portfolio.reconcile(
        get_positions_fn=lambda: dict(POSITIONS),
        place_order_fn=lambda symbol, diff, spec=None, **kw: placed.append((symbol, diff, kw)) or {
            "avg_price": 100.0, "executed_qty": abs(diff) / 100.0, "exchange": "binance"},
        threshold=10)


CFG = os.path.join(TMP, "manager", "portfolio_config.json")
MIRROR = os.path.join(TMP, "manager", "amounts.ui.json")
SNAP = os.path.join(TMP, "manager", "last_reconcile.json")
try:
    res = run()
    snap = json.load(open(SNAP)) if os.path.exists(SNAP) else {}
    check(res == [] and placed == [] and "BTCUSDT" in (snap.get("actual") or {})
          and not snap.get("orders"),
          "no portfolio_config.json (never saved): positions read and snapshotted, NO order — the "
          "manual long is not closed")
    check(snap.get("read_only") is True,
          "…and the round records read_only in the snapshot (the running reconciler's own word, "
          "which is the only thing the report may call read-only on)")
    check(portfolio_reporter.build_report()["portfolio_configured"] is False,
          "…and the report says portfolio_configured: false")

    json.dump({"amounts": {}, "exchanges": {}}, open(CFG, "w"))
    run()
    check(len(placed) == 1 and placed[0][0] == "BTCUSDT" and placed[0][1] < 0
          and "read_only" not in json.load(open(SNAP)),
          "amounts saved (all 0 — the taught way to flatten): the position is closed as before, "
          "and the snapshot no longer says read_only")
    check(portfolio_reporter.build_report()["portfolio_configured"] is True,
          "…and the report says portfolio_configured: true")

    os.remove(CFG)
    json.dump({"amounts": {}, "exchanges": {}}, open(MIRROR, "w"))
    run()
    check(len(placed) == 1,
          "only the UI mirror exists (the save wrote it first): configured — it trades")
    os.remove(MIRROR)
    run()
    check(placed == [], "config gone again: back to read-only")

    # B1 — the first save after read-only rounds, through the real save path
    for leftover in (SNAP, os.path.join(TMP, "manager", "orders.jsonl")):
        if os.path.exists(leftover):
            os.remove(leftover)  # the rounds above traded; B1 starts from a fresh machine
    import command_listener as cl  # noqa: E402
    cl._sync_strategy_crons = lambda *a, **k: None   # never near a real crontab
    os.makedirs(os.path.join(TMP, "strategies", "s"), exist_ok=True)
    with open(os.path.join(TMP, "strategies", "s", "strategy.py"), "w") as f:
        f.write("SYMBOL = 'ETHUSDT'\n")
    run()  # a read-only round: writes the snapshot, sends nothing
    check(os.path.exists(SNAP) and not os.path.exists(os.path.join(TMP, "manager", "orders.jsonl")),
          "read-only round: a snapshot on disk, no orders.jsonl")
    real_popen = cl.subprocess.Popen
    cl.subprocess.Popen = lambda *a, **k: None  # no strategy kickoff out of a test
    try:
        cl._cmd_amounts({"amounts": {"s": 100}})
    finally:
        cl.subprocess.Popen = real_popen
    saved = json.load(open(CFG))
    check(saved.get("self_ledger") is True,
          "…the user's FIRST save still turns self_ledger ON (the snapshot is not a trade)")
    run()
    check(placed == [],
          "…so the next round leaves the user's own BTCUSDT long alone (B1: it was closed)")

    # …and a machine that really traded still starts in account-read mode
    for f_ in (CFG, MIRROR):
        if os.path.exists(f_):
            os.remove(f_)  # _cmd_amounts wrote both
    with open(os.path.join(TMP, "manager", "orders.jsonl"), "w") as f:
        f.write('{"symbol": "BTCUSDT"}\n')
    check(cl._fresh_portfolio_config() == {},
          "a machine with orders.jsonl (it has placed an order) is not a fresh machine")
    os.remove(os.path.join(TMP, "manager", "orders.jsonl"))

    # B2 — false only on evidence about the code that runs next
    HB = os.path.join(TMP, "state", "heartbeat", "reconciler")
    os.makedirs(os.path.dirname(HB), exist_ok=True)
    LIB = os.path.join(TMP, "lib", "portfolio.py")
    os.makedirs(os.path.dirname(LIB), exist_ok=True)

    def field(alive, snapshot_guard, lib_guard):
        if os.path.exists(HB):
            os.remove(HB)
        if alive:
            open(HB, "w").close()
        with open(SNAP, "w") as f:
            json.dump({"actual": {}, "orders": []} | ({"read_only": True} if snapshot_guard else {}), f)
        with open(LIB, "w") as f:
            f.write("def portfolio_configured():\n    pass\n" if lib_guard else "# old lib\n")
        return portfolio_reporter.build_report()

    check(field(True, True, False).get("portfolio_configured") is False,
          "reconciler running + its own snapshot says read_only: portfolio_configured false")
    check("portfolio_configured" not in field(True, False, True),
          "reconciler running on an OLD lib (no read_only in its snapshot): the key is left out, "
          "even though the lib on disk has the guard (update applied, restart failed)")
    check(field(False, False, True).get("portfolio_configured") is False,
          "reconciler stopped + the lib it will load has the guard: false")
    check("portfolio_configured" not in field(False, False, False),
          "reconciler stopped + an old lib on disk: the key is left out (the pages warn)")
    json.dump({"amounts": {}}, open(CFG, "w"))
    check(field(True, False, False).get("portfolio_configured") is True,
          "amounts saved: true, whatever the reconciler is doing")
    # The guard probe is a string read out of the workspace lib (the reporter
    # ships with the runtime and must not import it). The stubs above prove
    # both answers; only this proves the real lib still carries the name it
    # looks for — a rename passes every other test and drops the field forever.
    with open(os.path.join(ROOT, "lib", "portfolio.py")) as f:
        check("def portfolio_configured(" in f.read(),
              "the real lib/portfolio.py defines portfolio_configured, the name "
              "portfolio_reporter._ws_lib_read_only_guard() greps for")
finally:
    os.chdir(cwd)
    shutil.rmtree(TMP, ignore_errors=True)

print("\nFAILED" if fails else "\nall ok")
sys.exit(1 if fails else 0)
