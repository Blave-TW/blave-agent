"""A bound TW broker with nothing in the 下單設定 still reads its own snapshot — no broker.

Found 2026-10-08 (0.1.18 wrap-up): every strategy unpicked (amounts {} —
`exchanges` wiped) on a machine still bound to 統一 made the reconciler route
get_positions by `exchanges` alone, fall through to lib.venue_wiring's crypto
auto-wire (which skips the TW brokers) and raise "no officially-supported venue
bound" every round — 3/3 read failures, then an hourly 「自動下單這一輪沒跑完」.
The empty amounts are the documented way to close the broker's positions, so
the read must keep going to the broker the bind manifest
(manager/credentials.ui.json) lists, whether or not a strategy routes there.

Reuses the fake venues of tests/check_capital_ledger_paths.py (snapshot file +
SDK stubs), one scenario per child process:
  bound     manifest [venue], amounts {} / exchanges {}: the venue is the hand-wired
            one for routing, classification and the book; get_positions reads the
            snapshot; a full round converges — no exception, nothing sent, no HALT;
            with the book off, 2 lots in the snapshot read back as 2 lots.
  fallback  manifest [paper], a strategy routed to the venue: routed as before
            (pre-manifest machines and tests/check_self_ledger_qty's fake lots).
  none      no manifest, no strategy, no keys: no hand-wired venue, and
            get_positions still raises the auto-wire's "no venue bound".

Run: cd blave-agent && .venv/bin/python tests/check_hand_wired_bound.py
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.dirname(HERE)


def child(venue, sid, tmp):
    os.chdir(tmp)
    sys.path.insert(0, SRC)
    sys.path.insert(0, HERE)
    os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = tmp
    import check_capital_ledger_paths as fakes
    from lib import venue_traits
    w = {"capital": fakes.capital_world, "president": fakes.president_world}[venue](tmp)
    fakes.freeze_clock(w)
    os.makedirs("manager", exist_ok=True)
    os.makedirs("state", exist_ok=True)
    exchanges = {"txf_trend": venue} if sid == "fallback" else {}
    json.dump({"self_ledger": True, "amounts": {}, "exchanges": exchanges, "asset_specs": {}},
              open("manager/portfolio_config.json", "w"))
    json.dump({"seeded_at": "2026-01-01T00:00:00", "own_only_basis": 1, "symbols": {}},
              open("manager/ledger_seed.json", "w"))
    if sid != "none":
        json.dump({"ids": ["paper"] if sid == "fallback" else [venue]},
                  open("manager/credentials.ui.json", "w"))
    w.write_snapshot()

    from lib import guard, portfolio
    from manager import reconciler as rec
    tg = []
    rec.send_telegram = tg.append
    rec._read_env = lambda: {}
    out = {"routed": rec._hand_wired_routed()}
    if sid == "none":
        try:
            rec.get_positions()
            out["raised"] = None
        except RuntimeError as e:
            out["raised"] = str(e)
    else:
        out["current_venue"] = rec._current_venue()
        out["book_venue"] = portfolio.book_venue()
        out["flat"] = rec.get_positions()
        try:
            orders = portfolio.reconcile(get_positions_fn=rec._get_positions_guarded,
                                         place_order_fn=rec.place_order,
                                         threshold=rec._symbol_threshold, send_telegram_fn=tg.append)
            out["round"] = {"orders": orders, "error": None}
        except Exception as e:
            out["round"] = {"orders": None, "error": f"{type(e).__name__}: {e}"}
        out["sent"], out["halt"], out["telegram"] = list(w.sent), guard.halted(), list(tg)
        # read only (no round): with the book off, the broker's 2 lots must come back —
        # the snapshot is what is read, not the crypto auto-wire
        json.dump({"self_ledger": False, "amounts": {}, "exchanges": exchanges, "asset_specs": {}},
                  open("manager/portfolio_config.json", "w"))
        w.rows = {("TX2610" if venue == venue_traits.CAPITAL else "TXFJ6"): 2}
        w.write_snapshot()
        out["held"] = rec.get_positions()
    json.dump(out, open("result.json", "w"), default=str)


def verdict(venue, sid, r):
    if sid == "none":
        return (r["routed"] is None and "no officially-supported venue bound" in (r["raised"] or ""),
                f"routed={r['routed']!r} raised={r['raised']!r}")
    if sid == "fallback":
        return r["routed"] == venue, f"routed={r['routed']!r}"
    held = r["held"].get("TXF") or {}
    ok = (r["routed"] == venue and r["current_venue"] == venue and r["book_venue"] == venue
          and r["flat"] == {} and held.get("side") == "long" and float(held.get("size", 0)) == 2
          and r["round"] == {"orders": [], "error": None} and not r["sent"] and not r["halt"])
    return ok, (f"routed={r['routed']!r} current={r['current_venue']!r} book={r['book_venue']!r} "
                f"flat={r['flat']} held={r['held']} round={r['round']} sent={r['sent']} "
                f"halt={r['halt']} telegram={r['telegram']}")


def main():
    venues = ["capital"]
    if os.path.exists(os.path.join(SRC, "lib", "order_president.py")):
        venues.append("president")
    failed = []
    for venue in venues:
        for sid in ("bound", "fallback", "none"):
            tmp = tempfile.mkdtemp(prefix=f"handwired-{venue}-{sid}-")
            try:
                p = subprocess.run([sys.executable, __file__, "--child", venue, sid, tmp],
                                   capture_output=True, text=True, timeout=120)
                try:
                    r = json.load(open(os.path.join(tmp, "result.json")))
                    ok, why = verdict(venue, sid, r)
                except (OSError, ValueError):
                    ok, why = False, "child crashed:\n" + p.stderr[-3000:]
            finally:
                shutil.rmtree(tmp, ignore_errors=True)
            print(f"{'ok' if ok else 'FAIL':<5} {venue}:{sid}: {why}")
            if not ok:
                failed.append(f"{venue}:{sid}")
    print("all pass" if not failed else f"FAILED: {', '.join(failed)}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--child":
        child(*sys.argv[2:5])
    else:
        main()
