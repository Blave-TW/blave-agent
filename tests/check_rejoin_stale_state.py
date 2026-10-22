"""A strategy added back to 下單設定 never trades a state.json older than its latest bar
(audit B3, runtime command_listener._retire_prejoin_signals).

Outside `amounts` a strategy is not scheduled, so its state.json is its last run's position.
The save that adds it back (with an amount: the 0.1.26 picker) used to put that position on
the account within one reconciler round, before any new signal.

  S1  unpicked long, aged days, re-added with $1000: no order until a new signal; the old
      file is kept as state.json.prejoin and the bar_wait record is gone.
  S2  the new signal after the re-add trades, its own direction (short), not the old one.
  S3  continuing members are untouched: state.json (content, mtime), bar_wait record — an
      amount raise on a member whose last tick is hours old trades in the same round, and a
      member sharing the re-added one's symbol trades its own change while that one waits (lib/portfolio
      first_signal_wait freezes only what the waiting one replaces).
  S4  picked at $0, funded by a second save before any new tick (the web picker's two
      saves): still no order; the first tick after the pick trades.
  S5  a stale state.json that cannot be moved refuses the save before anything is written.
  S6  fork-and-switch: the fork's one-off signal run inside the current bar nets against the
      original in the same save (no trade); one from an earlier bar is set aside, and the
      symbol waits for the fork's first scheduled signal instead of closing and buying back.
  S7  unpick and re-add inside the same bar: the state is the current bar's — kept, trades at
      once, and its bar_wait record is kept too (F1: no recompute on newer data).
  S8  strategy.py edited after the state was written (same bar): set aside.
  S9  a Type B joiner: always set aside (no bar to judge; the kickoff recomputes it). Cloud only.
  S10 the first save on a machine that traded without `amounts` (MG-08): nothing set aside —
      the lib adopts the held position and does not buy it again, before or after a new tick.
  S11 the first save on a machine that never traded, with a days-old one-off signal: set aside.

  S12 (F1) a kept state keeps its bar_wait record: a daily bar the epoch cut opens before the
      close, signal from this morning, re-added after the close — trades once, no recompute.
  S13 (F2) a torn first read of portfolio_config.json does not change who is joining.
  S14 (F3) a member the mirror still trades (hand-removed from the config) is not a joiner.
  S15 a sharing violation reading the mirror or a joiner's state.json → SAVE_FAILED.
  S16 (R0) a name the mirror holds at $0 is not a member the reconciler trades: hand-removed
      from the config while paused, then funded — its stale state is set aside.
  S17 (R1) a mirror lib/portfolio rejects (an amount that is not a number, `contracts` not a
      dict) does not make its names members; the runtime's judgement equals the lib's on a
      grid of mirror shapes.
  S18 (R2) `amounts` hand-deleted from the config on a machine that traded, the mirror valid:
      not the adoption save — the stale re-add is still set aside.

Discriminators against origin/main: S1, S2, S4, S5, S6 (older run), S8, S9, S11, S15 go red;
S3's "untouched" lines, S6 (current run), S7, S10, S12, S14 pass there by design — they pin
what must not change (S12 / S14 / S13 discriminate against the first version of this fix).

Every case runs on the paper harness (tests/check_paper_scenarios.World: the real runtime
dispatch, lib/portfolio, manager/reconciler and lib/order_paper on a scratch workspace), as
a cloud machine and as the desktop (BLAVE_AGENT_LOCAL=1 from the first save under test).

Run: cd blave-agent && .venv/bin/python tests/check_rejoin_stale_state.py   [--src DIR]
"""
import argparse
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("paper_scen", os.path.join(HERE, "check_paper_scenarios.py"))
ps = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ps)

B, E = "BTCUSDT", "ETHUSDT"
CASES = {}
CLOUD_ONLY = set()


def case(fn=None, cloud_only=False):
    def deco(f):
        CASES[f.__name__] = f
        if cloud_only:
            CLOUD_ONLY.add(f.__name__)
        return f
    return deco(fn) if fn else deco


def state(name):
    p = f"strategies/{name}/state.json"
    return json.load(open(p)) if os.path.exists(p) else None


def bar_wait(name, last="2026-01-01T00:00:00"):
    os.makedirs("state/bar_wait", exist_ok=True)
    json.dump({"last_processed_bar": last}, open(f"state/bar_wait/{name}.json", "w"))


def age(path, seconds):
    t = time.time() - seconds
    os.utime(path, (t, t))


def age_state(name, seconds):
    age(f"strategies/{name}/state.json", seconds)


def mid_bar():
    """The harness strategies are 1h: a "this bar" signal written seconds before the hour
    turns would be an earlier bar's by the time the save reads it."""
    left = 3600 - time.time() % 3600
    if left < 30:
        time.sleep(left + 1)


def unpick(w, name, keep, days=3, record=True):
    """`name` unpicked (its position closed), state.json left at its last position and,
    with days > 0, aged like a strategy that sat out that long."""
    w.amounts(**keep)
    w.check(not isinstance(w.settle(), Exception), "unpick settles")
    if days:
        age_state(name, days * 86400)
    if record:
        bar_wait(name)


class _Patched:
    """cl.<attr> replaced for one block: command_listener resolves `open` and its own
    helpers through its module globals, so the save under test sees the stand-in."""

    def __init__(self, mod, attr, fn):
        self.mod, self.attr, self.fn = mod, attr, fn

    def __enter__(self):
        self.had = self.attr in vars(self.mod)
        self.old = vars(self.mod).get(self.attr)
        setattr(self.mod, self.attr, self.fn)

    def __exit__(self, *exc):
        if self.had:
            setattr(self.mod, self.attr, self.old)
        else:
            delattr(self.mod, self.attr)


@case
def s1_s2(w):
    w.fresh(signals={"a1": 1})
    w.eq(w.settle(), [(B, "buy", 0.02, False)], "a1 enters long")
    unpick(w, "a1", {})
    w.eq((w.paper_pos(B), state("a1")["position"]), (0.0, 1.0), "out: BTC flat, state.json still long")
    old = state("a1")
    r = w.amounts(a1=1000)
    w.check(not isinstance(r, Exception), f"re-add a1 with $1000 saves ({r})")
    w.eq(w.settle(), [], "S1: re-added with an amount — no order on the old long")
    w.eq(w.paper_pos(B), 0.0, "S1: BTC stays flat")
    w.check(state("a1") is None, "S1: state.json set aside")
    w.eq(json.load(open("strategies/a1/state.json.prejoin")), old, "S1: kept as state.json.prejoin")
    w.check(not os.path.exists("state/bar_wait/a1.json"), "S1: bar_wait record removed")
    w.sig("a1", -1)
    w.eq(w.settle(), [(B, "sell", 0.02, False)], "S2: the new signal (short) trades")
    w.eq(w.paper_pos(B), -0.02, "S2: BTC short 0.02")
    w.amounts(a1=2000)
    w.eq(w.settle(), [(B, "sell", 0.02, False)], "S2: once in, an amount change trades at once")
    w.check(state("a1") is not None, "S2: a save of a member keeps its state.json")


@case
def s3(w):
    w.fresh(strategies=(("a1", B), ("c1", B), ("e1", E)),
            amounts={"a1": 1000, "c1": 1000, "e1": 1000}, signals={"a1": 1, "c1": 1, "e1": 1})
    w.eq(sorted(w.settle()), [(B, "buy", 0.04, False), (E, "buy", 0.5, False)], "all three enter")
    unpick(w, "a1", {"c1": 1000, "e1": 1000})
    w.eq(w.paper_pos(B), 0.02, "unpicking a1 sold its share only")
    for n in ("c1", "e1"):
        age_state(n, 5 * 3600)   # the last tick was hours ago (a 1d strategy mid-bar)
        bar_wait(n, "2026-10-16T00:00:00")

    def snapshot():
        return {n: (open(f"strategies/{n}/state.json").read(),
                    os.path.getmtime(f"strategies/{n}/state.json"),
                    open(f"state/bar_wait/{n}.json").read()) for n in ("c1", "e1")}
    before = snapshot()
    r = w.amounts(a1=1000, c1=1000, e1=2000)
    w.check(not isinstance(r, Exception), f"one save: a1 back, e1 raised ({r})")
    w.eq(w.settle(), [(E, "buy", 0.5, False)], "S3: e1's raise trades in the same round; a1 places nothing")
    w.eq(snapshot(), before, "S3: continuing members' state.json (content, mtime) and bar_wait untouched")
    w.check(not any(os.path.exists(f"strategies/{n}/state.json.prejoin") for n in ("c1", "e1")),
            "S3: no .prejoin for members")
    w.sig("c1", 0)
    w.eq(w.settle(), [(B, "sell", 0.02, True)],
         "S3: c1, sharing BTC with a1 that has no first signal yet, exits on its own signal (lib first_signal_wait freezes only what a1 replaces)")
    w.sig("a1", 1)
    w.eq(w.settle(), [(B, "buy", 0.02, False)], "S3: a1's first new signal enters")


@case
def s4(w):
    w.fresh(signals={"a1": 1})
    w.settle()
    unpick(w, "a1", {})
    w.amounts(a1=0)
    w.eq(w.settle(), [], "S4: picked at $0 — nothing")
    w.check(state("a1") is None, "S4: the pick at $0 sets the stale state.json aside too")
    w.amounts(a1=1000)
    w.eq(w.settle(), [], "S4: funded before any new tick — still no order")
    w.sig("a1", 1)
    w.eq(w.settle(), [(B, "buy", 0.02, False)], "S4: the first tick after the pick trades")


@case
def s5(w):
    w.fresh(signals={"a1": 1})
    w.settle()
    unpick(w, "a1", {})
    cfg = open("manager/portfolio_config.json").read()
    mir = open("manager/amounts.ui.json").read()
    import atomic_file
    real = atomic_file.replace_retry

    def locked(src, dst):
        if src.endswith("state.json"):
            raise PermissionError(13, "in use")
        return real(src, dst)
    atomic_file.replace_retry = locked
    try:
        r = w.amounts(a1=1000)
    finally:
        atomic_file.replace_retry = real
    w.check(isinstance(r, RuntimeError) and str(r).startswith("SAVE_FAILED: "),
            f"S5: the save is refused as SAVE_FAILED (the pages' retry sentence) ({r!r})")
    w.eq((open("manager/portfolio_config.json").read(), open("manager/amounts.ui.json").read()),
         (cfg, mir), "S5: config and mirror unchanged")
    w.eq(w.settle(), [], "S5: nothing trades")
    r = w.amounts(a1=1000)
    w.check(not isinstance(r, Exception) and state("a1") is None, "S5: the retry saves and sets it aside")
    w.eq(w.settle(), [], "S5: and still no order on the old long")


@case
def s6(w):
    w.fresh(signals={"a1": 1})
    w.settle()
    w.strategy("f1", B)
    mid_bar()
    w.sig("f1", 1)   # BLAVE_MODE=live python3 strategies/f1/strategy.py, this bar, never picked
    r = w.amounts(a1=0, f1=1000)
    w.check(not isinstance(r, Exception), f"switch save ({r})")
    w.eq(w.settle(), [], "S6: the fork's signal from this bar nets against the original: no trade")
    w.eq(w.paper_pos(B), 0.02, "S6: BTC still long 0.02")
    w.strategy("f2", B)
    w.sig("f2", 1)
    age_state("f2", 2 * 3600)   # run an earlier bar
    r = w.amounts(a1=0, f1=0, f2=1000)
    w.eq(w.settle(), [], "S6: a fork run on an earlier bar is not traded, and BTC waits for its first signal (no close)")
    w.check(state("f2") is None, "S6: f2's older state.json set aside")
    w.sig("f2", 1)
    w.eq(w.settle(), [], "S6: f2's first scheduled signal takes BTC over — no close and buy-back")
    w.eq(w.paper_pos(B), 0.02, "S6: BTC still long 0.02")


@case
def s7(w):
    mid_bar()
    w.fresh(signals={"a1": 1})
    w.settle()
    unpick(w, "a1", {}, days=0)
    w.eq(w.paper_pos(B), 0.0, "S7: out, BTC flat")
    w.amounts(a1=1000)
    w.eq(w.settle(), [(B, "buy", 0.02, False)], "S7: re-added in the same bar: its current signal trades")
    w.check(state("a1") is not None and not os.path.exists("strategies/a1/state.json.prejoin"),
            "S7: state.json kept")
    w.eq(json.load(open("state/bar_wait/a1.json")), {"last_processed_bar": "2026-01-01T00:00:00"},
         "S7: a kept state keeps its bar_wait record")


@case
def s8(w):
    w.fresh(signals={"a1": 1})
    w.settle()
    unpick(w, "a1", {}, days=0)
    age_state("a1", 1)
    src = open("strategies/a1/strategy.py").read()
    open("strategies/a1/strategy.py", "w").write(src + "\n# edited while unpicked\n")
    w.amounts(a1=1000)
    w.eq(w.settle(), [], "S8: strategy.py newer than its state.json: not traded")
    w.check(state("a1") is None, "S8: set aside")


@case(cloud_only=True)
def s9(w):
    w.fresh(signals={"a1": 1})
    w.settle()
    w.strategy("b1", B, type_b=True)
    w.sig("b1", 1)
    w.amounts(a1=1000, b1=1000)
    w.eq(w.settle(), [], "S9: a Type B joiner's pre-pick state.json is not traded")
    w.check(state("b1") is None, "S9: set aside")
    w.sig("b1", 1)
    w.eq(w.settle(), [(B, "buy", 0.02, False)], "S9: its next run trades")


@case
def s12(w):
    """F1: a daily strategy whose bar the epoch cut (00:00 UTC) opens before the market closes
    (TWSE / TAIFEX 1d): signal computed this morning, unpicked, re-added after the close. The
    state is this epoch bar's and is kept, so its bar_wait record — this bar processed — must
    stay: deleting it recomputes at once on the bar that closed since, which a continuing
    member does not yet trade, and an entry plus its reversal minutes apart follows."""
    day = 86400
    floor = time.time() // day * day
    if time.time() - floor < 300:
        time.sleep(300 - (time.time() - floor))
    w.strategy("t1", B)
    path = "strategies/t1/strategy.py"
    src = open(path).read()
    open(path, "w").write(src.replace('INTERVAL = "1h"', 'INTERVAL = "1d"'))
    age(path, 2 * day)
    w.fresh(strategies=(), amounts={"t1": 1000}, signals={"t1": 1})
    w.eq(w.settle(), [(B, "buy", 0.02, False)], "S12: t1 enters on this morning's signal")
    unpick(w, "t1", {}, days=0, record=False)
    t = floor + 120   # 08:02 TPE, inside this epoch bar
    os.utime("strategies/t1/state.json", (t, t))
    from datetime import datetime, timezone
    done = {"last_processed_bar": datetime.fromtimestamp(floor - day, timezone.utc)
            .replace(tzinfo=None).isoformat()}
    os.makedirs("state/bar_wait", exist_ok=True)
    json.dump(done, open("state/bar_wait/t1.json", "w"))
    w.amounts(t1=1000)
    w.eq(w.settle(), [(B, "buy", 0.02, False)], "S12: re-added after the close: this bar's state trades once")
    w.eq(json.load(open("state/bar_wait/t1.json")), done,
         "S12: bar_wait still says this bar is done — no recompute on the newer bar, no round trip")
    w.check(state("t1") is not None, "S12: state.json kept")


@case
def s13(w):
    """F2: the first, error-swallowing read of portfolio_config.json lands on manager.py's
    non-atomic rewrite (empty file); the save's own read a moment later is whole. Membership
    and "first write of amounts" come from the second read, so the stale re-add is still
    caught on a machine that has traded (paper fills on bound paper count)."""
    w.fresh(signals={"a1": 1})
    w.settle()
    unpick(w, "a1", {})
    import builtins
    import io
    real, hit = builtins.open, []

    def torn(path, *a, **k):
        if str(path).endswith("portfolio_config.json") and not hit and not (a and "w" in a[0]):
            hit.append(path)
            return io.StringIO("")
        return real(path, *a, **k)
    # the reads go through atomic_file.load_json (its retry) — patch its open too
    with _Patched(w.cl, "open", torn), _Patched(w.cl.atomic_file, "open", torn):
        r = w.amounts(a1=1000)
    w.check(hit and not isinstance(r, Exception), f"S13: first read torn, save lands ({r})")
    w.eq(w.settle(), [], "S13: still no order on the old long")
    w.check(state("a1") is None, "S13: set aside")


@case
def s14(w):
    """F3: the reconciler's members are the mirror's (amounts.ui.json). An agent hand-removed
    c1 from portfolio_config.json; the mirror still has it, so it is trading. The user's next
    save keeps c1: not a joiner for the reconciler, so its state stays and nothing trades —
    a save must not close a position the user did not touch."""
    w.fresh(strategies=(("a1", B), ("c1", E)), amounts={"a1": 1000, "c1": 1000},
            signals={"a1": 1, "c1": 1})
    w.settle()
    cfg = json.load(open("manager/portfolio_config.json"))
    del cfg["amounts"]["c1"]
    json.dump(cfg, open("manager/portfolio_config.json", "w"))
    age_state("c1", 3 * 86400)
    w.eq(w.settle(), [], "S14: hand edit — the mirror still trades c1")
    r = w.amounts(a1=1000, c1=1000)
    w.check(not isinstance(r, Exception), f"S14: the save lands ({r})")
    w.eq(w.settle(), [], "S14: no close of c1's ETH")
    w.check(state("c1") is not None, "S14: c1's state.json kept")


@case
def s15(w):
    """A read that hits a sharing violation (Windows) refuses the save as SAVE_FAILED — the
    mirror (reconciler membership) and a joiner's state.json mtime."""
    w.fresh(signals={"a1": 1})
    w.settle()
    unpick(w, "a1", {})
    import builtins
    real = builtins.open

    def locked_mirror(path, *a, **k):
        if str(path).endswith("amounts.ui.json") and not (a and "w" in a[0]):
            raise PermissionError(13, "in use", path)
        return real(path, *a, **k)
    before = open("manager/portfolio_config.json").read()
    # the reads go through atomic_file.load_json (its retry) — patch its open too
    with _Patched(w.cl, "open", locked_mirror), _Patched(w.cl.atomic_file, "open", locked_mirror):
        r = w.amounts(a1=1000)
    w.check(str(r).startswith("SAVE_FAILED: "), f"S15: mirror unreadable → SAVE_FAILED ({r!r})")
    real_mtime = os.path.getmtime

    def locked_mtime(p):
        if str(p).endswith("a1/state.json"):
            raise PermissionError(13, "in use", p)
        return real_mtime(p)
    os.path.getmtime = locked_mtime
    try:
        r = w.amounts(a1=1000)
    finally:
        os.path.getmtime = real_mtime
    w.check(str(r).startswith("SAVE_FAILED: "), f"S15: state.json mtime unreadable → SAVE_FAILED ({r!r})")
    w.eq(open("manager/portfolio_config.json").read(), before, "S15: nothing written")
    w.eq(w.settle(), [], "S15: nothing trades")


def _hand_remove_from_config(name):
    cfg = json.load(open("manager/portfolio_config.json"))
    del cfg["amounts"][name]
    json.dump(cfg, open("manager/portfolio_config.json", "w"))


@case
def s16(w):
    w.fresh(strategies=(("a1", B), ("c1", E)), amounts={"a1": 1000, "c1": 1000},
            signals={"a1": 1, "c1": 1})
    w.settle()
    w.amounts(a1=1000, c1=0)
    w.eq(w.settle(), [(E, "sell", 0.5, True)], "S16: c1 paused at $0 closes its ETH")
    _hand_remove_from_config("c1")
    age_state("c1", 3 * 86400)
    bar_wait("c1")
    r = w.amounts(a1=1000, c1=1000)
    w.check(not isinstance(r, Exception), f"S16: c1 funded ({r})")
    w.eq(w.settle(), [], "S16: no order on c1's stale long")
    w.check(state("c1") is None, "S16: c1's state.json set aside")


MIRROR_SHAPES = [
    {"amounts": {"a1": 1000}, "exchanges": {"a1": "paper"}},
    {"amounts": {"a1": "1000"}, "exchanges": {"a1": "paper"}},
    {"amounts": {"a1": "x"}, "exchanges": {"a1": "paper"}},
    {"amounts": {"a1": None}, "exchanges": {"a1": "paper"}},
    {"amounts": {"a1": 1000}, "exchanges": {"a1": "paper"}, "contracts": []},
    {"amounts": {"a1": 1000}, "exchanges": {"a1": "paper"}, "contracts": {}},
    {"amounts": [], "exchanges": {}},
    {"amounts": {}, "exchanges": None},
    [],
    "x",
]


@case
def s17(w):
    w.fresh(strategies=(("a1", B), ("c1", E)), amounts={"a1": 1000, "c1": 1000},
            signals={"a1": 1, "c1": 1})
    w.settle()
    unpick(w, "c1", {"a1": 1000})
    keep = open("manager/amounts.ui.json").read()
    for shape in MIRROR_SHAPES:
        json.dump(shape, open("manager/amounts.ui.json", "w"))
        try:
            lib_valid = w.pf._load_ui_mirror() is not None
        except AttributeError:
            lib_valid = False   # a non-object mirror raises in the lib: no round trades on it
        w.eq(w.cl._mirror_members()[0], lib_valid,
             f"S17: runtime and lib agree the mirror is valid: {json.dumps(shape)}")
    open("manager/amounts.ui.json", "w").write(keep)
    mir = json.load(open("manager/amounts.ui.json"))
    mir["amounts"]["c1"] = 1000
    mir["exchanges"]["c1"] = "paper"
    mir["contracts"] = []   # the lib ignores this mirror: it trades the config, where c1 is out
    json.dump(mir, open("manager/amounts.ui.json", "w"))
    w.eq(w.settle(), [], "S17: the rejected mirror trades nothing new")
    r = w.amounts(a1=1000, c1=1000)
    w.check(not isinstance(r, Exception), f"S17: c1 re-added ({r})")
    w.eq(w.settle(), [], "S17: no order on c1's stale long")
    w.check(state("c1") is None, "S17: c1's state.json set aside")


@case
def s18(w):
    w.fresh(signals={"a1": 1})
    w.settle()
    unpick(w, "a1", {})
    cfg = json.load(open("manager/portfolio_config.json"))
    del cfg["amounts"]
    json.dump(cfg, open("manager/portfolio_config.json", "w"))
    w.check(w.cl._traded_on_a_real_venue(), "S18: the machine has traded (paper bound, paper fills)")
    r = w.amounts(a1=1000)
    w.check(not isinstance(r, Exception), f"S18: re-add saves ({r})")
    w.eq(w.settle(), [], "S18: no order on the old long")
    w.check(state("a1") is None, "S18: set aside")


def _mg08(w, local):
    w.strategy("a1", B)
    w.bind_paper()
    w.sig("a1", 1)
    age_state("a1", 2 * 3600)
    w.manual(B, 0.02)
    with open("manager/orders.jsonl", "w") as f:
        f.write(json.dumps({"ts": "2026-09-01T00:00:00", "symbol": B, "exchange": "binance",
                            "legs": [{"signed_diff": 1000, "executed_qty": 0.02}]}) + "\n")
    w.boot()
    w.round()
    if local:
        os.environ["BLAVE_AGENT_LOCAL"] = "1"
    w.amounts(a1=1000)
    w.check(state("a1") is not None, "S10: the adoption save sets nothing aside")
    w.round()
    w.round()
    w.eq((w.paper_fills(), w.book()), ([], {B: (0.02, 1000.0)}), "S10: adopted, nothing re-bought")
    w.sig("a1", 1)
    w.settle()
    w.eq((w.paper_fills(), w.paper_pos(B)), ([], 0.02), "S10: and not after its next tick either")


@case
def s10(w):
    _mg08(w, w._local)


@case
def s11(w):
    w.strategy("a1", B)
    w.bind_paper()
    w.sig("a1", 1)
    age_state("a1", 3 * 86400)
    w.boot()
    if w._local:
        os.environ["BLAVE_AGENT_LOCAL"] = "1"
    w.amounts(a1=1000)
    w.settle()
    w.eq((w.paper_fills(), state("a1")), ([], None), "S11: a first save that never traded: old run set aside")
    w.sig("a1", 1)
    w.eq(w.settle(), [(B, "buy", 0.02, False)], "S11: the first tick after the save trades")


def run_child(cid, ws, src):
    name, _, mode = cid.partition("@")
    w = ps.World(ws, src)
    w._local = mode == "desktop"
    if w._local:
        # set up and started the way the paper harness does (cloud), then every save under
        # test runs as the desktop's runtime — as check_paper_scenarios' both-mode cases do
        fresh = w.fresh

        def fresh_then_local(*a, **k):
            fresh(*a, **k)
            os.environ["BLAVE_AGENT_LOCAL"] = "1"
        w.fresh = fresh_then_local
    try:
        CASES[name](w)
        w.eq(w.cl._local_mode(), w._local, f"ran as the {mode}")
    except Exception:
        traceback.print_exc()
        print(f"FAIL {cid} raised")
        return 1
    return 1 if w.fails else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--child")
    ap.add_argument("--ws")
    ap.add_argument("--src", default=ps.ROOT)
    a = ap.parse_args()
    if a.child:
        sys.exit(run_child(a.child, a.ws, os.path.abspath(a.src)))
    src = os.path.abspath(a.src)
    base = tempfile.mkdtemp(prefix="rejoin-stale-")
    with open(os.path.join(base, "sitecustomize.py"), "w") as f:
        f.write(ps.SITECUSTOMIZE)
    ids = [f"{n}@{m}" for n in CASES for m in ("cloud", "desktop")
           if m == "cloud" or n not in CLOUD_ONLY]
    failed = []
    for cid in ids:
        ws = ps.make_ws(src, base)
        env = ps._child_env(base, src)
        env["BLAVE_AGENT_WORKSPACE"] = ws
        env["BLAVE_AGENT_HOME"] = env["BLAVECLAW_HOME"] = env["BLAVE_AGENT_BASE"] = ws
        try:
            p = subprocess.run([sys.executable, os.path.abspath(__file__), "--child", cid,
                                "--ws", ws, "--src", src], cwd=ws, env=env,
                               capture_output=True, text=True, timeout=ps.CHILD_TIMEOUT_S)
            rc, out = p.returncode, p.stdout + (("\n" + p.stderr) if p.returncode else "")
        except subprocess.TimeoutExpired as e:
            rc, out = 1, f"TIMEOUT\n{e.stdout or ''}"
        print(f"== {cid}  {'pass' if rc == 0 else 'FAIL'}")
        print("   " + out.strip().replace("\n", "\n   "))
        if rc:
            failed.append(cid)
    shutil.rmtree(base, ignore_errors=True)
    print(f"\n{len(ids) - len(failed)}/{len(ids)} pass" + (f"; FAILED: {failed}" if failed else ""))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
