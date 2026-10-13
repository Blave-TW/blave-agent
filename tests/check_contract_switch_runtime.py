"""TXF / MXF / TMF contract switch, runtime side (command_listener._cmd_amounts,
portfolio_reporter.can_switch_contract / execution_contract).

  V  can_switch_contract asks the code that trades next: a running reconciler's
     snapshot `caps` (the disk lib does not count while an old process runs),
     else the lib on disk.
  A  `amounts` + `contracts` is one atomic save: stored only where it differs
     from SYMBOL, mirrored (the key present), spec written for the contract
     traded; `contracts` absent keeps what is saved, pruned to the members.
  X  refusals, each before anything is written: an old reconciler / lib
     (CONTRACT_NEEDS_UPDATE — the 20× case: 20 lots saved for TMF traded as
     TXF), not a member / bad value (BAD_CONTRACT), not 台指期 (NOT_TXF_FAMILY),
     Type B (CONTRACT_TYPE), a funded rollover under HALT (CONTRACT_HALTED),
     with a waiting strategy on either contract (CONTRACT_GATED), with 統一
     lots parked on either contract or the park file unreadable
     (CONTRACT_PARKED). An unfunded switch under HALT is fine (nothing trades).
  D  dispatch() (the cloud poll and local_daemon both call it) passes `contracts` on.
  M  the credential-evict mirror update carries `contracts` through.
  E  execution_contract (runtime copy) == lib/portfolio.execution_symbol over a
     grid of symbols × overrides × mirror shapes.

Run: cd blave-agent && .venv/bin/python tests/check_contract_switch_runtime.py
"""
import json
import os
import shutil
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = tempfile.mkdtemp(prefix="contract-switch-rt-")
WS = os.path.join(BASE, "workspace")
for d in ("manager", "state/heartbeat", "lib"):
    os.makedirs(os.path.join(WS, d))
os.environ["BLAVE_AGENT_BASE"] = BASE
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.pop("BLAVE_AGENT_LOCAL", None)
sys.path.insert(0, os.path.join(ROOT, "runtime"))
sys.path.insert(0, ROOT)
os.chdir(WS)
import command_listener as cl  # noqa: E402
import portfolio_reporter as pr  # noqa: E402
from lib import portfolio as lib_portfolio  # noqa: E402

fails = 0
CONFIG = os.path.join(WS, "manager", "portfolio_config.json")
MIRROR = os.path.join(WS, "manager", "amounts.ui.json")
SNAP = os.path.join(WS, "manager", "last_reconcile.json")
HB = os.path.join(WS, "state", "heartbeat", "reconciler")
HALT = os.path.join(WS, "state", "HALT")
GATE = os.path.join(WS, "state", "signal_gate.json")
PARK = os.path.join(WS, "state", "president_pending_sent.json")


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


def strategy(name, sym, interval=True):
    d = os.path.join(WS, "strategies", name)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "stats.json"), "w") as f:
        json.dump({"symbol": sym, "trades": 3}, f)
    with open(os.path.join(d, "strategy.py"), "w") as f:
        f.write(f'SYMBOL = "{sym}"\n' + ('INTERVAL = "1h"\n' if interval else ""))


for n, s in (("txf_a", "TXF"), ("txf_b", "TXF"), ("mxf_a", "MXF"), ("btc_a", "BTCUSDT")):
    strategy(n, s)
strategy("txf_cron", "TXF", interval=False)
with open(os.path.join(WS, "manager", "wait_for_bar.py"), "w") as f:
    f.write("# present\n")
with open(os.path.join(WS, ".env"), "w") as f:
    f.write("CAPITAL_API_KEY=A123456789\nCAPITAL_PASSWORD=vault:abc\n")
cl._sync_strategy_crons = lambda names: None


def lib_disk(new):
    for name in ("portfolio.py", "paper_data.py"):
        src = os.path.join(ROOT, "lib", name)
        dst = os.path.join(WS, "lib", name)
        if new:
            shutil.copy(src, dst)
        else:
            with open(dst, "w") as f:
                f.write("# an older lib\n")


def reconciler(running, caps):
    if running:
        open(HB, "w").close()
        os.utime(HB, None)
    elif os.path.exists(HB):
        os.remove(HB)
    doc = {"ts": "x", "target": {}, "actual": {}, "orders": []}
    if caps:
        doc["caps"] = ["contract_override"]
    with open(SNAP, "w") as f:
        json.dump(doc, f)


def reset():
    for p in (CONFIG, MIRROR, HALT, GATE, PARK):
        if os.path.exists(p):
            os.remove(p)


def save(amounts, contracts=None):
    args = {"amounts": amounts}
    if contracts is not None:
        args["contracts"] = contracts
    try:
        cl._cmd_amounts(args)
    except ValueError as e:
        return str(e)
    return None


def stored():
    cfg = json.load(open(CONFIG)) if os.path.exists(CONFIG) else None
    mir = json.load(open(MIRROR)) if os.path.exists(MIRROR) else None
    return cfg, mir


def files():
    return tuple(open(p).read() if os.path.exists(p) else None for p in (CONFIG, MIRROR))


# ── V: capability ───────────────────────────────────────────────────────────
# The process list counts as unreadable throughout this file, so "not running"
# here is the fail-closed case (stale heartbeat, presence not provable); the
# provably-absent case is tests/check_contract_switch_stopped.py.
cl._unsupervised_reconciler_pids = lambda proc="/proc", all_=False: None
for running, caps, disk, want, broken in ((True, True, False, True, False), (True, False, True, False, True),
                                          (False, False, True, False, False), (False, True, True, False, False),
                                          (False, True, False, False, True)):
    lib_disk(disk)
    reconciler(running, caps)
    got = pr.can_switch_contract()
    check(got is want, f"V running={running} caps={caps} disk_new={disk} → switch {want} (got {got}): "
                       "a stale heartbeat is never read off the disk")
    got = pr.contract_override_broken()
    check(got is broken, f"V …switch in force broken={broken} (got {got})")
lib_disk(True)
reconciler(True, True)
check(pr.build_report().get("can_switch_contract") is True, "V report carries can_switch_contract")

# ── A: the save ─────────────────────────────────────────────────────────────
reset()
err = save({"txf_a": 20}, {"txf_a": "TMF"})
cfg, mir = stored()
check(err is None and cfg["contracts"] == {"txf_a": "TMF"} and mir["contracts"] == {"txf_a": "TMF"},
      f"A switch saved in config and mirror ({err}, {cfg and cfg.get('contracts')})")
check(cfg["asset_specs"]["txf_a"]["contract_value"] == 10, "A spec is the TMF one")
check(lib_portfolio.execution_symbol("txf_a", "TXF", cfg) == "TMF", "A the lib keys it TMF")
err = save({"txf_a": 20})
check(err is None and stored()[0]["contracts"] == {"txf_a": "TMF"} and stored()[1]["contracts"] == {"txf_a": "TMF"},
      f"A `contracts` absent (old client) keeps the saved switch ({err})")
err = save({"mxf_a": 0})
check(err is None and stored()[0]["contracts"] == {} and stored()[1]["contracts"] == {},
      f"A unpicking the strategy drops its switch ({err})")
err = save({"txf_a": 1, "mxf_a": 4}, {"txf_a": "TXF", "mxf_a": "MXF"})
check(err is None and stored()[0]["contracts"] == {}, f"A a value equal to SYMBOL is not stored ({err})")
err = save({"txf_a": 1}, {"txf_a": "TMF"})
check(err is None and stored()[0]["asset_specs"]["txf_a"]["contract_value"] == 10,
      f"A funded switch rewrites a TXF spec to TMF ({err})")
err = save({"txf_a": 1}, {})
check(err is None and stored()[0]["contracts"] == {}
      and stored()[0]["asset_specs"]["txf_a"]["contract_value"] == 200,
      f"A switching back clears it and the spec is TXF again ({err})")

# ── X: refusals ─────────────────────────────────────────────────────────────


def refused(code, amounts, contracts, msg):
    before = files()
    err = save(amounts, contracts)
    check(err is not None and err.startswith(code + ":") and files() == before,
          f"X {msg}: {code}, nothing written ({err})")


reset()
save({"txf_a": 1, "txf_b": 1})
lib_disk(True)
reconciler(True, False)  # updated on disk, the running reconciler is still the old one
refused("CONTRACT_NEEDS_UPDATE", {"txf_a": 20, "txf_b": 1}, {"txf_a": "TMF"},
        "old reconciler still running (restart deferred)")
lib_disk(False)
reconciler(False, False)
refused("CONTRACT_NEEDS_UPDATE", {"txf_a": 0, "txf_b": 1}, {"txf_a": "TMF"}, "old lib, even an unfunded switch")
lib_disk(True)
reconciler(True, True)
refused("BAD_CONTRACT", {"txf_a": 1}, {"txf_b": "TMF"}, "a name not in this save")
refused("BAD_CONTRACT", {"txf_a": 1}, {"txf_a": "TX"}, "a value outside TXF/MXF/TMF")
refused("BAD_CONTRACT", {"txf_a": 1}, ["TMF"], "not a mapping")
refused("NOT_TXF_FAMILY", {"btc_a": 1}, {"btc_a": "TMF"}, "a crypto strategy")
refused("CONTRACT_TYPE", {"txf_cron": 1}, {"txf_cron": "TMF"}, "a Type B (no INTERVAL)")

open(HALT, "w").close()
refused("CONTRACT_HALTED", {"txf_a": 20, "txf_b": 1}, {"txf_a": "TMF"}, "funded rollover under HALT")
err = save({"txf_a": 0, "txf_b": 1}, {"txf_a": "TMF"})
check(err is None and stored()[0]["contracts"] == {"txf_a": "TMF"},
      f"X …an unfunded switch under HALT saves (nothing trades) ({err})")
os.remove(HALT)
save({"txf_a": 1, "txf_b": 1}, {})

json.dump({"txf_a": 1.0}, open(GATE, "w"))
refused("CONTRACT_GATED", {"txf_a": 20, "txf_b": 1}, {"txf_a": "TMF"}, "the strategy waits for a new signal")
json.dump({"txf_b": 1.0}, open(GATE, "w"))
refused("CONTRACT_GATED", {"txf_a": 20, "txf_b": 1}, {"txf_a": "TMF"},
        "another strategy on the old contract waits (its key is held as is)")
json.dump({"mxf_a": 1.0}, open(GATE, "w"))
err = save({"txf_a": 20, "txf_b": 1, "mxf_a": 1}, {"txf_a": "TMF"})
check(err is None, f"X …a waiting strategy on an unrelated contract does not block ({err})")
save({"txf_a": 1, "txf_b": 1}, {})
os.remove(GATE)

json.dump({"TXFK6": {"root": "TXF", "lots": 1}}, open(PARK, "w"))
refused("CONTRACT_PARKED", {"txf_a": 20, "txf_b": 1}, {"txf_a": "TMF"}, "統一 lots parked on the old contract")
json.dump({"TMFK6": {"root": "TMF", "lots": 1}}, open(PARK, "w"))
refused("CONTRACT_PARKED", {"txf_a": 20, "txf_b": 1}, {"txf_a": "TMF"}, "統一 lots parked on the new contract")
open(PARK, "w").write("{not json")
refused("CONTRACT_PARKED", {"txf_a": 20, "txf_b": 1}, {"txf_a": "TMF"}, "park file unreadable")
os.remove(PARK)
err = save({"txf_a": 20, "txf_b": 1}, {"txf_a": "TMF"})
check(err is None and stored()[0]["contracts"] == {"txf_a": "TMF"}, f"X with none of the above it saves ({err})")
lib_disk(False)
reconciler(False, False)
refused("CONTRACT_NEEDS_UPDATE", {"txf_a": 20, "txf_b": 1}, None,
        "a funded switch in force while the lib cannot honour it (no `contracts` sent)")
lib_disk(True)
reconciler(True, True)

# ── D: the real entry path (dispatch, what the cloud poll and local_daemon call) ──
reset()
cl.dispatch({"cmd": "amounts", "args": {"amounts": {"txf_a": 20}, "contracts": {"txf_a": "TMF"}}})
check(stored()[0]["contracts"] == {"txf_a": "TMF"} and stored()[1]["contracts"] == {"txf_a": "TMF"},
      "D dispatch carries `contracts` through to the save")
save({"txf_a": 1, "txf_b": 1}, {})
save({"txf_a": 20, "txf_b": 1}, {"txf_a": "TMF"})

# ── Y: exposure (audit P1-2) and the scope of the rollover checks ────────────
reset()
save({"txf_a": 1, "txf_b": 1})
for lots, root, ok in ((20, "TMF", True), (4, "MXF", True), (3, "MXF", True), (5, "MXF", True),
                       (2, "MXF", True), (7, "MXF", False), (40, "TMF", False), (19, "TMF", True)):
    before = files()
    err = save({"txf_a": lots, "txf_b": 1}, {"txf_a": root})
    good = err is None if ok else (err or "").startswith("CONTRACT_EXPOSURE_MISMATCH:") and files() == before
    check(good, f"Y 1 TXF → {lots} {root}: {'saved' if ok else 'CONTRACT_EXPOSURE_MISMATCH'} ({err})")
    if err is None:
        save({"txf_a": 1, "txf_b": 1}, {})
save({"txf_a": 20, "txf_b": 1}, {"txf_a": "TMF"})
refused("CONTRACT_EXPOSURE_MISMATCH", {"txf_a": 20, "txf_b": 1}, {},
        "20 TMF sent back unconverted as 20 TXF (the 20× case)")
check(save({"txf_a": 1, "txf_b": 1}, {}) is None, "Y …converted back to 1 TXF saves")
check(save({"txf_a": 3, "txf_b": 1}) is None, "Y resizing without a switch is not checked")
save({"txf_a": 0, "txf_b": 1})
open(HALT, "w").close()
refused("CONTRACT_HALTED", {"txf_a": 20, "txf_b": 1}, {"txf_a": "TMF"},
        "previous amount 0 (its close may not have filled) still counts as a rollover")
os.remove(HALT)
reconciler(False, True)
refused("CONTRACT_NEEDS_UPDATE", {"txf_a": 0, "txf_b": 1}, {"txf_a": "TMF"},
        "reconciler not running (stale heartbeat): no switch, fail-closed")
check(save({"txf_a": 0, "txf_b": 2}) is None, "Y …a plain amounts save still goes through while stopped")
reconciler(True, True)
save({"txf_a": 1, "txf_b": 1}, {"txf_a": "TMF"})
save({"txf_a": 20, "txf_b": 1}, {"txf_a": "TMF"})

# ── RR: the rollover record (state/contract_rollover.json) ──────────────────
ROLL = os.path.join(WS, "state", "contract_rollover.json")


def roll():
    return json.load(open(ROLL)) if os.path.exists(ROLL) else None


reset()
if os.path.exists(ROLL):
    os.remove(ROLL)
save({"txf_a": 1, "txf_b": 1})
check(roll() is None, "RR a save without a switch writes no record")
save({"txf_a": 20, "txf_b": 1}, {"txf_a": "TMF"})
r1 = roll()
check(set(r1) == {"txf_a"} and (r1["txf_a"]["from"], r1["txf_a"]["to"]) == ("TXF", "TMF") and r1["txf_a"].get("at"),
      f"RR switch TXF→TMF recorded ({r1})")
save({"txf_a": 20, "txf_b": 1}, {"txf_a": "TMF"})
check(roll() == r1, "RR saving the same switch again leaves the record (and its time) as is")
save({"txf_a": 4, "txf_b": 1}, {"txf_a": "MXF"})
check((roll()["txf_a"]["from"], roll()["txf_a"]["to"]) == ("TXF", "MXF"),
      f"RR onward switch while open: from stays TXF, to follows ({roll()})")
save({"txf_a": 1, "txf_b": 1}, {})
check(roll() == {}, f"RR switching back to the old contract drops the record ({roll()})")
save({"txf_a": 20, "txf_b": 1}, {"txf_a": "TMF"})
save({"txf_b": 1})
check(set(roll()) == {"txf_a"} and (roll()["txf_a"]["from"], roll()["txf_a"]["to"]) == ("TXF", None),
      f"RR unpicked mid-rollover: record kept, from TXF, nothing to open ({roll()})")
save({"txf_a": 4, "txf_b": 1}, {"txf_a": "MXF"})
check((roll()["txf_a"]["from"], roll()["txf_a"]["to"]) == ("TXF", "MXF"),
      f"RR re-picked onto MXF: starts from the record's TXF ({roll()})")
DONE = os.path.join(WS, "state", "contract_rollover_done.json")
json.dump({"txf_a": roll()["txf_a"]["id"]}, open(DONE, "w"))  # the lib saw it finish
save({"txf_b": 1})
check(set(roll()) == {"txf_a"} and (roll()["txf_a"]["from"], roll()["txf_a"]["to"]) == ("MXF", None),
      f"RR unpicked after the switch finished (lots on MXF): record from MXF ({roll()})")
save({"txf_a": 20, "txf_b": 1}, {"txf_a": "TMF"})
check((roll()["txf_a"]["from"], roll()["txf_a"]["to"]) == ("MXF", "TMF"),
      f"RR …re-picked onto TMF starts from MXF, not its SYMBOL ({roll()})")
os.remove(DONE)
save({"txf_a": 1, "txf_b": 1}, {})
os.remove(ROLL)
save({"txf_a": 20, "txf_b": 1}, {"txf_a": "TMF"})
open(ROLL, "w").write("{broken")
before = files()
try:
    cl._cmd_amounts({"amounts": {"txf_a": 4, "txf_b": 1}, "contracts": {"txf_a": "MXF"}})
    raised = None
except RuntimeError as e:
    raised = str(e)
check((raised or "").startswith("CONTRACT_RECORD_UNREADABLE:") and files() == before
      and open(ROLL).read() == "{broken",
      f"RR record unreadable: a switch is refused (CONTRACT_RECORD_UNREADABLE), files left as they are ({raised})")
check(save({"txf_a": 0, "txf_b": 1}) is None and open(ROLL).read() == "{broken",
      "RR …an amount-0 save (flatten) still goes through, record untouched")
os.remove(ROLL)
save({"txf_a": 1, "txf_b": 1}, {})
save({"txf_b": 1})
before = roll()
refused("CONTRACT_EXPOSURE_MISMATCH", {"txf_b": 40}, {"txf_b": "TMF"}, "RR refusal")
check(roll() == before, "RR a refused save writes no record")

save({"txf_a": 1, "txf_b": 1}, {})
save({"txf_a": 20, "txf_b": 1}, {"txf_a": "TMF"})

# ── M: evict keeps contracts ────────────────────────────────────────────────
cl._clear_evicted_in_ui_mirror({"capital"})
mir = json.load(open(MIRROR))
check(mir.get("contracts") == {"txf_a": "TMF"} and set(mir["exchanges"].values()) == {""},
      f"M evict blanks routing, carries contracts ({mir.get('contracts')})")

# ── E: runtime copy == lib ──────────────────────────────────────────────────
grid_ok = True
for sym in ("TXF", "MXF", "TMF", "TXFR1", "BTCUSDT", None, ""):
    for ov in (None, "TXF", "MXF", "TMF", "BAD"):
        for where in ("config", "mirror", "mirror_without_key"):
            contracts = {} if ov is None else {"s": ov}
            cfg = {"contracts": contracts} if where == "config" else {"contracts": {"s": "MXF"}}
            mirror = ({"contracts": contracts} if where == "mirror" else
                      {"amounts": {}} if where == "mirror_without_key" else None)
            effective = contracts if where != "mirror_without_key" else {"s": "MXF"}
            want = lib_portfolio.execution_symbol("s", sym, {"contracts": effective}) if sym else sym
            got = pr.execution_contract("s", sym, cfg if where != "mirror_without_key" else cfg, mirror)
            if got != want:
                grid_ok = False
                print(f"     mismatch sym={sym} ov={ov} where={where}: runtime {got} lib {want}")
check(grid_ok, "E runtime execution_contract matches lib execution_symbol on the grid")

shutil.rmtree(BASE, ignore_errors=True)
print(f"\n{'ALL PASS' if not fails else f'{fails} FAIL'}")
sys.exit(1 if fails else 0)
