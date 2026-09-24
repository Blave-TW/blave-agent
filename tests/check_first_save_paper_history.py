"""The first save after a paper machine lost its config AND its book seed
(version matrix V1-10 / V0-02, 2026-09-24).

A paper-bound machine whose manager/orders.jsonl logs the bot's open paper
position must not come out of its first 下單設定 save with a zero book, or the
next round buys that position again. Paper fills count as "traded" when paper
is the venue bound now; they still do not when a REAL venue is bound (Wei
09-23: two old paper fills must not keep a Binance account off the book).

Runs one child on a scratch workspace with the paper-scenario harness (real
command_listener.dispatch, real reconciler rounds on lib.order_paper), network
blocked. Keys are not-a-real-* strings.

Run: cd blave-agent && .venv/bin/python tests/check_first_save_paper_history.py
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import check_paper_scenarios as ps  # noqa: E402

B = "BTCUSDT"


def child(ws):
    w = ps.World(ws, ROOT)
    cl = w.cl
    orders = os.path.join("manager", "orders.jsonl")
    lost = ("manager/portfolio_config.json", "manager/amounts.ui.json", "manager/ledger_seed.json")

    # the repro: paper-bound, the bot holds 0.02, config + seed gone, one save, rounds
    w.fresh(signals={"a1": 1})
    w.settle()
    w.eq(w.paper_pos(B), 0.02, "the bot's 0.02 BTC is on the paper account, logged in orders.jsonl")
    for f in lost:
        if os.path.exists(f):
            os.remove(f)
    w.amounts(a1=1000)
    cfg = json.load(open("manager/portfolio_config.json"))
    w.check(cfg.get("self_ledger") is not True,
            f"paper bound, paper fills logged: the first save is not a fresh zero book ({cfg.get('self_ledger')!r})")
    w.restart_process()
    fills = []
    for _ in range(4):
        fills += w.settle()
    w.eq(fills, [], "no second buy of the position the bot already holds")
    w.eq(w.paper_pos(B), 0.02, "the paper account stays at the target")

    # the decision itself, on the .env bound now (no venue is called)
    def first_save(env_lines, fills_):
        with open(".env", "w") as f:
            f.write("\n".join(["BLAVE_API_KEY=not-a-real-blave"] + env_lines) + "\n")
        if fills_ is None:
            if os.path.exists(orders):
                os.remove(orders)
        else:
            with open(orders, "w") as f:
                f.write("".join(json.dumps(x) + "\n" for x in fills_))
        return cl._fresh_portfolio_config()

    paper = ["PAPER_API_KEY=paper", "PAPER_SECRET_KEY=paper", "PAPER_BOUND_TS=1"]
    binance = ["BINANCE_API_KEY=not-a-real-binance-key", "BINANCE_SECRET_KEY=not-a-real-binance-secret"]
    pf = [{"exchange": "paper", "symbol": B}]
    w.eq(first_save(binance, pf), {"self_ledger": True},
         "a REAL venue bound, only paper fills logged: still a fresh book (Wei 09-23 intent kept)")
    w.eq(first_save(paper, pf), {}, "paper bound, paper fills logged: traded — no zero book")
    w.eq(first_save(paper, None), {"self_ledger": True}, "paper bound, nothing ever filled: a fresh book")
    w.eq(first_save(binance, [{"exchange": "binance", "symbol": B}]), {},
         "a real venue bound, a real fill logged: traded")
    w.eq(first_save([], pf), {"self_ledger": True}, "nothing bound, only paper fills: a fresh book")
    with open(orders, "w") as f:
        f.write("{torn\n")
    w.eq(cl._fresh_portfolio_config(), {}, "an unreadable orders.jsonl counts as traded (conservative)")
    return w.fails


def parent():
    base = tempfile.mkdtemp(prefix="first-save-")
    try:
        with open(os.path.join(base, "sitecustomize.py"), "w") as f:
            f.write(ps.SITECUSTOMIZE)
        ws = ps.make_ws(ROOT, base)
        env = ps._child_env(base, ROOT)
        env["BLAVE_AGENT_WORKSPACE"] = ws
        env["BLAVE_AGENT_HOME"] = env["BLAVECLAW_HOME"] = env["BLAVE_AGENT_BASE"] = ws
        p = subprocess.run([sys.executable, os.path.abspath(__file__), "--child", ws],
                           cwd=ws, env=env, capture_output=True, text=True, timeout=300)
        print(p.stdout.rstrip())
        if p.returncode:
            print(p.stderr[-3000:])
        return p.returncode
    finally:
        shutil.rmtree(base, ignore_errors=True)


if __name__ == "__main__":
    if sys.argv[1:2] == ["--child"]:
        n = child(sys.argv[2])
        print("\nFAILED" if n else "\nall ok")
        sys.exit(1 if n else 0)
    sys.exit(parent())
