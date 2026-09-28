"""A real venue's key REFUSED at the bind while paper is trading: nothing is
saved and paper goes on as if the bind had never been tried — the other half of
check_paper_scenarios.py's TC-15 (a key that passes evicts paper and HALTs).

Two cases, each on a cloud machine and on the desktop (BLAVE_AGENT_LOCAL=1):
  TC-38  the key may withdraw                          → WITHDRAW_ENABLED
  TC-39  the permission cannot be read: OKX cannot be
         reached, or answers without `perm`            → UNKNOWN / REJECTED
These ids are not in the paper scenario matrix yet, which is why they live here
and not in check_paper_scenarios.py (its enumeration allows no case the matrix
does not list). The harness is that file's: same scratch workspace, same real
runtime/command_listener + lib + reconciler rounds, same network and .env
blocks in the child. OKX's answers are canned (World.okx_answers).

Run:     cd blave-agent && .venv/bin/python tests/check_paper_bind_refused.py
"""
import argparse
import os
import shutil
import subprocess
import sys
import tempfile
import traceback

import check_paper_scenarios as ps

B = ps.B
WATCHED = (".env", "manager/portfolio_config.json", "manager/amounts.ui.json",
           "manager/credentials.ui.json", "manager/ledger_seed.json",
           "state/paper_ledger.json", "state/account_guard.json")


def _files():
    out = {}
    for p in WATCHED:
        try:
            with open(p, "rb") as f:
                out[p] = f.read()
        except OSError:
            out[p] = None
    return out


def _refused(w, local, answers, code, what):
    """One refused bind over a paper long; then paper still trades."""
    hits = w.okx_answers(**answers)
    before, n_events = _files(), len(w.events())
    r = w.cmd("credentials", env=ps.OKX_KEYS)
    w.check(isinstance(r, ValueError) and str(r).startswith(code + ": ") and "not saved" in str(r),
            f"{what}: refused with {code} ({r})")
    w.check(not any(v in str(r) for v in ps.OKX_KEYS.values()), "no key value in the refusal")
    w.check(ps.OKX_CONFIG in hits, f"OKX was asked for the key's permissions ({sorted(set(hits))})")
    after = _files()
    w.eq([p for p in WATCHED if after[p] != before[p]], [],
         ".env, routing, manifest, book seed, paper ledger: byte-identical")
    w.eq([p for p in WATCHED[:6] if before[p] is None], [], "…and each of them is there to compare")
    w.check(b"OKX_" not in after[".env"], "no okx line in .env")
    w.check(not w.halted(), "no HALT")
    w.eq(len(w.events()), n_events, "no event")
    w.eq((w.sup["running"], w.sup["stops"]), (True, 0), "the reconciler was not stopped")
    cfg = ps.json.load(open("manager/portfolio_config.json"))
    w.eq((cfg["amounts"], cfg["exchanges"]), ({"a1": 1000.0}, {"a1": "paper"}), "amounts and routing")
    w.eq((w.book(venue="paper"), w.book(venue="okx")), ({B: (0.02, 1000.0)}, {}), "books")


def _world(w, local):
    ps._long(w)
    if local:
        os.environ["BLAVE_AGENT_LOCAL"] = "1"
        w.cl.LOCAL_OPEN_VENUES = frozenset(w.cl.LOCAL_OPEN_VENUES | {"OKX"})
    w.eq(w.cl._local_mode(), local, "desktop" if local else "cloud machine")


def _paper_goes_on(w):
    w.eq(w.settle(), [], "signal unchanged: paper places nothing")
    w.sig("a1", 0)
    w.eq(w.settle(), [(B, "sell", 0.02, True)], "the next signal trades on paper as before")
    w.check(not w.halted(), "still no HALT")


def tc38(w, local):
    _world(w, local)
    _refused(w, local, {"perm": "read_only,withdraw,trade"}, "WITHDRAW_ENABLED",
             "a key that may withdraw")
    _paper_goes_on(w)


def tc39(w, local):
    _world(w, local)
    # the desktop reads the account first (_local_real_key_gate): OKX out of
    # reach is refused there, before the permission is asked
    _refused(w, local, {"down": True}, "REJECTED" if local else "UNKNOWN", "OKX cannot be reached")
    _refused(w, local, {"perm": None}, "UNKNOWN", "an answer without `perm`")
    _paper_goes_on(w)


CASES = {"TC-38": tc38, "TC-39": tc39}
MODES = {"cloud": False, "desktop": True}


def child(a):
    sid, mode = a.child.split("@")
    w = ps.World(a.ws, ps.ROOT)
    try:
        CASES[sid](w, MODES[mode])
    except Exception:
        traceback.print_exc()
        print(f"FAIL {a.child} raised")
        return 1
    return 1 if w.fails else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--child")
    ap.add_argument("--ws")
    a = ap.parse_args()
    if a.child:
        sys.exit(child(a))
    base = tempfile.mkdtemp(prefix="paper-bind-")
    with open(os.path.join(base, "sitecustomize.py"), "w") as f:
        f.write(ps.SITECUSTOMIZE)
    failed = []
    for cid in [f"{s}@{m}" for s in CASES for m in MODES]:
        ws = ps.make_ws(ps.ROOT, base)
        env = ps._child_env(base, ps.ROOT)
        env["BLAVE_AGENT_WORKSPACE"] = ws
        env["BLAVE_AGENT_HOME"] = env["BLAVECLAW_HOME"] = env["BLAVE_AGENT_BASE"] = ws
        try:
            p = subprocess.run([sys.executable, os.path.abspath(__file__), "--child", cid, "--ws", ws],
                               cwd=ws, env=env, capture_output=True, text=True,
                               timeout=ps.CHILD_TIMEOUT_S)
            rc, out = p.returncode, p.stdout + (("\n" + p.stderr) if p.returncode else "")
        except subprocess.TimeoutExpired as e:
            rc, out = 1, f"TIMEOUT after {ps.CHILD_TIMEOUT_S}s\n{e.stdout or ''}"
        print(f"== {cid}  {'pass' if rc == 0 else 'FAIL'}")
        if rc or os.environ.get("PAPER_HARNESS_VERBOSE"):
            print("   " + out.strip().replace("\n", "\n   "))
        if rc:
            failed.append(cid)
    if not failed:
        shutil.rmtree(base, ignore_errors=True)
    n = len(CASES) * len(MODES)
    print(f"\n{n - len(failed)}/{n} pass" + (f"; FAILED: {','.join(failed)}" if failed else ""))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
