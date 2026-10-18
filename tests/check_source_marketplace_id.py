"""`source_marketplace_id` in the strategy report: strategy_reporter reads
strategies/<name>/source.json (written by the references/marketplace.md install flow) so
the web's Strategy Library can tell which listings sit on this machine. No network.

Run: cd blave-agent && .venv/bin/python tests/check_source_marketplace_id.py
"""
import json
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = tempfile.mkdtemp(prefix="source-id-")
WS = os.path.join(BASE, "workspace")
SD = os.path.join(WS, "strategies")
os.makedirs(SD)
os.environ["BLAVE_AGENT_BASE"] = BASE
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
sys.path.insert(0, os.path.join(ROOT, "runtime"))
import strategy_reporter as sr  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


def strat(name, source=None, raw=None):
    d = os.path.join(SD, name)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "strategy.py"), "w") as f:
        f.write(f'STRATEGY_NAME = "{name}"\nDISPLAY_NAME = "{name}"\n')
    p = os.path.join(d, "source.json")
    if raw is not None:
        with open(p, "w") as f:
            f.write(raw)
    elif source is not None:
        with open(p, "w") as f:
            json.dump(source, f)
    elif os.path.exists(p):
        os.remove(p)


check(sr.STRATEGIES_DIR == SD, "reporter reads the temp workspace")
strat("lib_ok", {"marketplace_id": 132})
for name, body in (("bad_str", {"marketplace_id": "132"}), ("bad_zero", {"marketplace_id": 0}),
                   ("bad_neg", {"marketplace_id": -5}), ("bad_float", {"marketplace_id": 132.0}),
                   ("bad_bool", {"marketplace_id": True}), ("bad_list", [132]),
                   ("bad_big", {"marketplace_id": 10 ** 10})):
    strat(name, body)
strat("bad_json", raw="{not json")
strat("own", None)
with open(os.path.join(SD, "flat.py"), "w") as f:
    f.write('STRATEGY_NAME = "flat"\n')
os.makedirs(os.path.join(SD, "flat"))
with open(os.path.join(SD, "flat", "source.json"), "w") as f:
    json.dump({"marketplace_id": 7}, f)

got = {s["name"]: s for s in sr.scan(include_newborn=True)}
check(got["lib_ok"].get("source_marketplace_id") == 132
      and type(got["lib_ok"]["source_marketplace_id"]) is int, "valid id → int field")
check(all("source_marketplace_id" not in got[n] for n in
          ("bad_str", "bad_zero", "bad_neg", "bad_float", "bad_bool", "bad_list", "bad_big", "bad_json", "own")),
      "string / 0 / negative / float / bool / non-object / too big / broken json / no file → field absent")
check(got["flat"].get("source_marketplace_id") == 7, "single-file layout reads strategies/<name>/source.json")
chunk = json.loads(json.dumps(sr.live_chunk(list(got.values()))))
chunk_rows = chunk.get("strategies", chunk) if isinstance(chunk, dict) else chunk
check(any(isinstance(r, dict) and r.get("source_marketplace_id") == 132 for r in chunk_rows),
      "live strategies chunk carries it")

# The id can land after the backtest (no stats/scan/wf change): both fingerprints must move,
# or incremental reporting never sends it and agent_turn never pushes a chunk.
strat("late", None)
before_sig = sr.signature(include_newborn=True)
before = next(s for s in sr.scan(include_newborn=True) if s["name"] == "late")
strat("late", {"marketplace_id": 99})
after_sig = sr.signature(include_newborn=True)
after = next(s for s in sr.scan(include_newborn=True) if s["name"] == "late")
check(sr.strategy_marker(before) != sr.strategy_marker(after), "strategy_marker changes when source.json appears")
check(before_sig != after_sig, "signature changes when source.json appears")

print("FAILED" if fails else "all ok")
sys.exit(1 if fails else 0)
