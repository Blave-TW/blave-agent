"""Mixed-version matrix: the old (shipped) and the new side of runtime/ and the
workspace lib, run together on the PAPER venue — one cell per ID of
.claude/output/specs/version-matrix-2026-09-24.md (monorepo root), and the doc
and this file must list the same IDs.

Why mixed at all: runtime/ auto-updates on every machine ~5 min after publish,
the workspace (lib/ manager/ references/ AGENTS.md …) only when the user
presses 更新 (manager/update_workspace.py), and the desktop app copies its
bundled workspace only when the bundled VERSION is newer
(shell/main.js syncOfficialOnUpdate). So new runtime + old lib is the normal
state of every machine for a while; old runtime + new lib happens when the lib
lands first.

Each cell runs in its own child process on its own scratch workspace built from
two sources: lib/ manager/ references/ AGENTS.md … from one side, `current` →
runtime/ of the other. Real code everywhere (reconciler rounds, lib.execute →
lib.order_paper, command_listener.dispatch, portfolio_reporter); stubbed: the OS
supervisor (systemd / tmux / NSSM → a fake, like tests/check_paper_scenarios.py
whose World this subclasses), the venues' HTTP transport where a cell reads a
real venue's account (canned JSON, never the network), and crontab sync.
No network: every child refuses socket connects and DNS; .env of the repo is
never opened.

V4 (update_workspace) and V3 run real processes: an old manager/reconciler.py
started by a fake systemctl, then manager/update_workspace.py from a scratch
clone whose last commit is the new tree.

The old side: --old-src DIR (e.g. a `git worktree add --detach … <ref>`) or
--old-ref REF (default HEAD; extracted with `git archive`, the repo is only
read). Once the new code is committed, HEAD is the new side: pass the last
shipped commit as --old-ref.

A cell that fails because of a real bug asserts the intended behaviour and is
listed in KNOWN_BUGS: reported "xfail"; it fails the run the day it passes.

Run:  cd blave-agent && .venv/bin/python tests/check_version_matrix.py
      … --old-ref 8804133   … --old-src /path/worktree   … --only V1-01,V2-03   … --keep
"""
import argparse
import concurrent.futures
import importlib.util
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DOC = os.path.join(os.path.dirname(ROOT), ".claude", "output", "specs",
                   "version-matrix-2026-09-24.md")
CHILD_TIMEOUT_S = 240
OFFICIAL_DIRS = ("lib", "manager", "references", "examples", "allocators")
OFFICIAL_FILES = ("AGENTS.md", "CLAUDE.md", "VERSION", "strategies/TEMPLATE_A.py",
                  "strategies/TEMPLATE_C.py")
# files a machine writes into manager/ (lib/portfolio, the reconciler, the runtime):
# never official content — V6-03 checks the new tree carries none of them
MACHINE_STATE = ("order_errors.json", "orders.jsonl", "last_reconcile.json", "ledger_seed.json",
                 "portfolio_config.json", "amounts.ui.json", "credentials.ui.json",
                 "ledger_migration.json")

CELLS = {}      # id -> (fn, lib side, runtime side, local, kind)
PHASES = {}     # name -> fn(world) for orchestrated cells
KNOWN_BUGS = {
    "V1-05": "old lib/account_gateio + account_bybit have no demo host: with GATEIO_DEMO / BYBIT_DEMO in "
             ".env the desktop gate checks a testnet key on the LIVE host and refuses it (fail-closed; only "
             "reachable when the desktop workspace was not re-synced — V6-01)",
}


def cell(cid, lib, rt, local=False, kind="child"):
    def deco(fn):
        assert cid not in CELLS, cid
        CELLS[cid] = (fn, lib, rt, local, kind)
        return fn
    return deco


def phase(name):
    def deco(fn):
        PHASES[name] = fn
        return fn
    return deco


def _load_paper_harness():
    spec = importlib.util.spec_from_file_location("check_paper_scenarios",
                                                  os.path.join(HERE, "check_paper_scenarios.py"))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


PS = _load_paper_harness()
B, E = "BTCUSDT", "ETHUSDT"
PAPER_KEYS = ["PAPER_API_KEY", "PAPER_SECRET_KEY", "PAPER_BOUND_TS"]


# ── child-side world ─────────────────────────────────────────────────────────

class VWorld(PS.World):
    """check_paper_scenarios.World with either side's lib and runtime. Attributes
    one side lacks are observations, never errors of the harness."""

    def __init__(self, ws, rt_src, lib_side, rt_side):
        self.lib_side, self.rt_side = lib_side, rt_side
        self.notes = []
        super().__init__(ws, rt_src)

    def note(self, msg):
        print("NOTE " + msg, flush=True)

    def restart_process(self):
        pf = self.pf
        for k, v in (("_baseline_seen", None), ("_baseline_wait", None)):
            if hasattr(pf, k):
                setattr(pf, k, v)
        for k in ("_pending_seen",):
            if hasattr(pf, k):
                getattr(pf, k).clear()
        if hasattr(pf, "_unconfigured_logged"):
            pf._unconfigured_logged = False
        if hasattr(self.vw, "_SPOT_LEGACY_SAID"):
            self.vw._SPOT_LEGACY_SAID.clear()
        self.guard._halt_flag = False
        self._load_reconciler()
        for fn in (getattr(self.vw, "sweep_orphan_orders", None),
                   getattr(self.ex, "reap_dead_inflight", None)):
            try:
                fn and fn()
            except Exception:
                pass

    def report(self):
        """portfolio_reporter's own fields, each "ABSENT" where this runtime has no
        such helper (the old reporter builds self_ledger straight off the flag)."""
        pr = self.pr
        cfg_path = os.path.join(self.ws, "manager", "portfolio_config.json")
        cfg = pr._read_json(cfg_path) if os.path.exists(cfg_path) else {}
        cfg = cfg if isinstance(cfg, dict) else {}
        hb = pr._mtime(os.path.join(self.ws, "state", "heartbeat", "reconciler"))
        last = pr._read_json(os.path.join(self.ws, "manager", "last_reconcile.json"))
        own = getattr(pr, "own_positions_only", None)
        ctp = getattr(pr, "can_trade_portfolio", None)
        return {"self_ledger": own(cfg, hb, last) if own else bool(cfg.get("self_ledger")),
                "can_trade_portfolio": ctp() if ctp else "ABSENT",
                "portfolio_configured": pr.portfolio_configured(cfg_path, hb, last),
                "halt": pr.halt_state(), "last": last or {}, "states": pr.strategy_states(),
                "can_wait_start": pr._workspace_has_signal_gate()}

    def book(self, digits=8, venue="paper"):
        try:
            raw = self.pf.ledger_book(venue)
        except TypeError:
            raw = self.pf.ledger_book()  # the old lib keeps one book for the machine
        return {k: (round(v["qty"], digits), round(v["cost"], 2)) + (("legacy",) if v["legacy"] else ())
                for k, v in raw.items()}


def run_child(cid, ws, rt_src, lib_side, rt_side, phase_name=None):
    w = VWorld(ws, rt_src, lib_side, rt_side)
    try:
        if phase_name:
            PHASES[phase_name](w)
        else:
            CELLS[cid][0](w)
    except Exception:
        traceback.print_exc()
        print(f"FAIL {phase_name or cid} raised")
        return 1
    return 1 if w.fails else 0


def fresh_long(w, pos=1):
    """paper bound, a1 $1,000 on BTC, signal `pos`, started, filled. On the old
    runtime resume starts nothing: the web's follow-up restart_reconciler does."""
    w.fresh(signals={"a1": pos})
    if not w.sup["running"]:
        w.cmd("restart_reconciler")
    w.settle()


def src_of(module):
    with open(module.__file__, encoding="utf-8") as f:
        return f.read()


# ── V0: same-version baselines for the mixed cells that differ ───────────────
# (cells defined below; registered here in words, see the bottom of V1)

# ── V1: new runtime + old lib ────────────────────────────────────────────────

@cell("V1-01", lib="old", rt="new")
def v1_01(w):
    """Whole-machine resume with no restart record starts the reconciler; the old
    lib then trades as it always did."""
    w.fresh(signals={"a1": 1}, start=False)
    r = w.start()
    w.check(w.sup["starts"] == 1 and "reconciler" in str(r),
            f"resume (no record) started the reconciler once ({r})")
    w.eq(w.settle(), [(B, "buy", 0.02, False)], "old lib buys amount ÷ mark")
    w.eq(w.settle(), [], "converged")
    r = w.cmd("restart_reconciler")
    w.check(w.sup["starts"] == 1, f"the web's follow-up restart is swallowed ({r})")
    rep = w.report()
    w.check(rep["self_ledger"] is True, "report self_ledger: the first save wrote the flag → true")
    w.eq(rep["can_trade_portfolio"], False, "report can_trade_portfolio false on the old lib")
    w.check("own_only" not in rep["last"], "the old lib's snapshot has no own_only")


@cell("V1-02", lib="old", rt="new")
def v1_02(w):
    """resume_wait on the old lib: the gate the new runtime writes is the one the
    old reconcile path reads; first round places nothing, a new signal trades."""
    w.fresh(signals={"a1": 1}, start=False)
    r = w.start(wait=True)
    w.check(w.sup["starts"] == 1, f"resume_wait started the reconciler ({r})")
    gate = json.load(open("state/signal_gate.json"))
    w.eq(gate, {"a1": 1.0}, "gate = the Type A position (unchanged format)")
    w.eq(w.settle(), [], "first rounds: nothing (waiting for a new signal)")
    w.sig("a1", -1)
    w.eq(w.settle(), [(B, "sell", 0.02, False)], "new signal → trades on the old lib")


@cell("V1-03", lib="old", rt="new")
def v1_03(w):
    """Process guard. The old reconciler.py takes no singleton lock, so the new
    runtime's /proc check is the only thing keeping a second one from starting.
    Cases on a fake /proc tree shaped like Linux's; then dispatch with a stray."""
    cl = w.cl
    have = hasattr(cl, "_unsupervised_reconciler_pids")
    w.check(have, "new runtime has the process-list guard")
    if not have:
        return
    proc = os.path.join(w.ws, "fakeproc")
    target_rel = "manager/reconciler.py"

    def mk(pid, argv, cwd, ppid=1, cgroup="0::/user.slice", comm=None):
        d = os.path.join(proc, str(pid))
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "cmdline"), "wb") as f:
            f.write(b"\0".join(a.encode() for a in argv) + b"\0")
        if cwd:
            os.symlink(cwd, os.path.join(d, "cwd"))
        with open(os.path.join(d, "stat"), "w") as f:
            f.write(f"{pid} ({comm or 'python3'}) S {ppid} 0 0")
        with open(os.path.join(d, "cgroup"), "w") as f:
            f.write(cgroup + "\n")

    mk(101, ["python3", target_rel], w.ws)                                     # hand run
    mk(102, ["/opt/blave-agent/venv/bin/python3", target_rel], w.ws,
       cgroup="0::/system.slice/blave-agent-reconciler.service")               # systemd
    mk(103, ["python3", "-m", "py_compile", target_rel], w.ws)                 # a compile
    mk(200, ["tmux: server (/tmp/tmux-1000/default)"], "/", comm="tmux: server")
    mk(201, ["bash", "manager/start_reconciler.sh"], w.ws, ppid=200, comm="bash")
    mk(104, ["python3", target_rel], w.ws, ppid=201)                           # under tmux
    mk(105, ["python3", "-u", os.path.join(w.ws, target_rel)], "/")            # absolute, -u
    mk(106, ["python3", "/other/ws/manager/reconciler.py"], "/")               # other ws
    got = sorted(cl._unsupervised_reconciler_pids(proc=proc))
    w.eq(got, [101, 105], "stray = hand-run ones of THIS workspace; systemd/tmux/-m/other ws not")
    rows = "\n".join([
        "10\t4\tnssm.exe\tC:\\nssm\\nssm.exe",
        "11\t10\tpowershell.exe\tpowershell -File manager\\start_reconciler_windows.ps1",
        "12\t11\tpython.exe\t\"C:\\Python\\python.exe\" manager\\reconciler.py",       # service
        "20\t3\tpython.exe\tpython C:\\blave\\workspace\\manager\\reconciler.py",      # hand run
        "21\t3\tpython.exe\tpython -m py_compile manager\\reconciler.py"])
    w.eq(sorted(cl._parse_windows_unsupervised(rows, 999)), [20],
         "Windows rows: an nssm.exe ancestor = supervised; a hand run is stray; -m is not a run")
    w.strays = [101]
    w.fresh(signals={"a1": 1}, start=False)
    r = w.start()
    w.check(w.sup["starts"] == 0 and "outside the supervisor" in str(r),
            f"resume beside a stray old reconciler starts nothing ({r})")
    r = w.cmd("restart_reconciler")
    w.check(w.sup["starts"] == 0, f"the web's follow-up is swallowed ({r})")
    r = w.cmd("restart_reconciler")
    w.check(isinstance(r, Exception) and "101" in str(r),
            f"a later explicit restart is refused with the pid ({r})")


def _rebind_new_paper_account(w):
    """After a full unbind, bind a NEW paper account (PAPER_BOUND_TS moves) and
    start again: the old account's book must not stand in for the new one."""
    w.bind_paper(ts=int(time.time()) + 5)
    w.amounts(a1=1000)
    r = w.start(human_delay=False)
    if not w.sup["running"]:
        w.cmd("restart_reconciler")
    fills = []
    for _ in range(4):
        fills += w.settle()
    w.note(f"[{w.lib_side} lib · {w.rt_side} runtime] after rebind: start {r!r}; fills {fills}; "
           f"book {w.book()}; paper BTC {w.paper_pos(B)}")
    return fills


@cell("V1-04", lib="old", rt="new")
def v1_04(w):
    """Unbind → rebind → start on the old lib: stop mark + park/unpark are
    runtime-only; the book reset is gated on the lib (old lib: not written)."""
    fresh_long(w)
    seed0 = w.seed()
    r = w.cmd("credentials_remove", env=PAPER_KEYS)
    w.check("credentials_remove" in str(r), f"unbind ({r})")
    w.check(os.path.exists("state/reconciler_stop_mark"), "stop mark written")
    parked = json.load(open("state/unbound_account_state.json"))
    w.check(any(p.endswith("last_reconcile.json") for p in parked["files"]),
            "old lib's snapshot parked")
    w.check(not os.path.exists("manager/last_reconcile.json"), "…and cleared")
    w.check(not os.path.exists("state/book_account.json"),
            "book account NOT remembered (old lib has no per-venue reset)")
    w.eq(w.seed(), seed0, "ledger_seed.json untouched")
    starts0 = w.sup["starts"]
    fills = _rebind_new_paper_account(w)
    w.check(not os.path.exists("state/unbound_account_state.json"),
            "rebind (a new paper account = another identity): parked state dropped")
    w.check(w.sup["starts"] == starts0 + 1,
            "start inside 15 s of the unbind starts the stopped daemon (stop mark)")
    w.eq(fills, [], "old lib: the old account's 0.02 is still in the one book → no re-buy "
                    "(V0-03: identical on old+old — not a regression; V0-04: new+new re-buys)")


@cell("V1-05", lib="old", rt="new", local=True)
def v1_05(w):
    """_local_real_key_gate (desktop) for OKX / BingX / Gate.io / Bybit against
    the old lib/account_*: the venues' HTTP answers are canned, never sent."""
    cl = w.cl
    cl.LOCAL_OPEN_VENUES = frozenset(cl.LOCAL_OPEN_VENUES | {"BINANCE", "OKX", "BINGX", "GATEIO", "BYBIT"})
    VENUE_GATE_CASES(w, cl)


def _fake_http(routes, hits):
    """requests' adapter answers from `routes(method, url) -> (status, json)`."""
    import requests
    from requests.models import Response

    def send(self, req, **kw):
        hits.append((req.method, req.url.split("?")[0]))
        status, body = routes(req.method, req.url)
        r = Response()
        r.status_code = status
        r._content = json.dumps(body).encode()
        r.headers["Content-Type"] = "application/json"
        r.url = req.url
        r.request = req
        return r
    requests.adapters.HTTPAdapter.send = send


def _venue_routes(mode):
    """mode: ok | reject. Answers shaped like each venue's own (both lib sides'
    get_equity paths)."""
    def routes(method, url):
        path = url.split("?")[0]
        if "okx.com" in url:
            if mode == "reject":
                return 401, {"code": "50111", "msg": "Invalid OK-ACCESS-KEY", "data": []}
            if path.endswith("/account/balance"):
                return 200, {"code": "0", "data": [{"totalEq": "321.5"}]}
            return 200, {"code": "0", "data": []}
        if "bingx" in url:
            if mode == "reject":
                return 200, {"code": 100001, "msg": "Signature verification failed"}
            if path.endswith("/swap/v3/user/balance"):
                return 200, {"code": 0, "data": [{"asset": "USDT", "equity": "210.0"}]}
            return 200, {"code": 0, "data": []}
        if "gateio" in url or "gateapi" in url:
            if mode == "reject":
                return 401, {"label": "INVALID_KEY", "message": "Invalid key provided"}
            if path.endswith("/futures/usdt/accounts"):
                return 200, {"total": "150", "unrealised_pnl": "0"}
            return 200, {"details": {}}
        if "bybit" in url:
            if mode == "reject":
                return 200, {"retCode": 10003, "retMsg": "API key is invalid.", "result": {}}
            if path.endswith("/v5/user/query-api"):
                return 200, {"retCode": 0, "result": {"uta": 1, "permissions": {"ContractTrade": ["Order"]}}}
            if path.endswith("/wallet-balance"):
                return 200, {"retCode": 0, "result": {"list": [{"totalEquity": "99.5"}]}}
            return 200, {"retCode": 0, "result": {"balance": []}}
        return 404, {}
    return routes


GATE_KEYS = {
    "OKX": {"OKX_API_KEY": "okxkey-1234", "OKX_SECRET_KEY": "okxsecret-5678", "OKX_PASSPHRASE": "pass-90"},  # gitleaks:allow
    "BINGX": {"BINGX_API_KEY": "bingxkey-1234", "BINGX_SECRET_KEY": "bingxsecret-5678"},  # gitleaks:allow
    "GATEIO": {"GATEIO_API_KEY": "gatekey-1234", "GATEIO_SECRET_KEY": "gatesecret-5678"},
    "BYBIT": {"BYBIT_API_KEY": "bybitkey-1234", "BYBIT_SECRET_KEY": "bybitsecret-5678"},  # gitleaks:allow
}
DEMO_FLAG = {"GATEIO": ("GATEIO_DEMO", "testnet"), "BYBIT": ("BYBIT_DEMO", "api-demo"),
             "OKX": ("OKX_DEMO", None)}


def VENUE_GATE_CASES(w, cl):
    has_gate = cl._local_real_key_gate.__code__.co_argcount >= 2
    if not has_gate:
        # the old runtime: Binance only, everything else refused before any read
        for vid in GATE_KEYS:
            r = w.cmd("credentials", env=GATE_KEYS[vid])
            w.check(isinstance(r, Exception), f"{vid}: old runtime refuses the desktop bind ({r})")
            w.check(vid + "_API_KEY" not in open(".env").read() if os.path.exists(".env") else True,
                    f"{vid}: nothing written")
        return
    for vid, keys in GATE_KEYS.items():
        for mode in ("ok", "reject"):
            hits = []
            _fake_http(_venue_routes(mode), hits)
            before = open(".env").read() if os.path.exists(".env") else ""
            r = w.cmd("credentials", env=keys)
            after = open(".env").read() if os.path.exists(".env") else ""
            if mode == "ok":
                w.check(not isinstance(r, Exception) and keys[vid + "_API_KEY"] in after,
                        f"{vid} good key: gate passes on the {w.lib_side} lib and .env is written ({r})")
            else:
                w.check(isinstance(r, Exception) and "REJECTED" in str(r) and after == before,
                        f"{vid} refused key: REJECTED, .env byte-identical ({str(r)[:120]})")
                w.check(not any(v in str(r) for v in keys.values() if len(v) >= 4),
                        f"{vid}: no key value in the refusal")
            w.check(bool(hits), f"{vid} {mode}: the gate made its signed read ({len(hits)} call(s))")
        # unbind again so the next venue is a clean bind
        w.cmd("credentials_remove", env=list(keys))
    demo_host_cases(w)


def demo_host_cases(w):
    """A testnet key with <VENUE>_DEMO=true in .env is checked on the demo host."""
    for vid, (flag, host_word) in DEMO_FLAG.items():
        if host_word is None:
            continue
        with open(".env", "a") as f:
            f.write(f"\n{flag}=true\n")
        hits = []
        _fake_http(_venue_routes("ok"), hits)
        r = w.cmd("credentials", env=GATE_KEYS[vid])
        hosts = sorted({h[1].split("/")[2] for h in hits})
        want = any(host_word in h for h in hosts)
        w.check(want, f"{vid} with {flag}=true in .env: the check hits the demo host "
                      f"(hosts {hosts}; {w.lib_side} lib)")
        w.cmd("credentials_remove", env=list(GATE_KEYS[vid]))
        txt = open(".env").read().replace(f"\n{flag}=true\n", "\n")
        open(".env", "w").write(txt)


@cell("V1-06", lib="old", rt="new")
def v1_06(w):
    """Funding a Type C portfolio is refused while the lib cannot trade it."""
    w.strategy("basket", B, portfolio=True)
    w.bind_paper()
    r = w.amounts(basket=1000)
    w.check(isinstance(r, Exception) and "更新 blave agent" in str(r),
            f"old lib: funding a portfolio refused, message says update ({str(r)[:80]})")
    cfg = {}
    try:
        cfg = json.load(open("manager/portfolio_config.json"))
    except (OSError, ValueError):
        pass
    w.check(not (cfg.get("amounts") or {}).get("basket"), "nothing saved for it")
    w.eq(w.report()["can_trade_portfolio"], False, "report can_trade_portfolio false")


@cell("V1-07", lib="old", rt="new")
def v1_07(w):
    """Reporter fields beside the old lib: self_ledger follows evidence, weights
    appear only for a state that carries them, nothing claims Type C trading."""
    # a machine from before the flag: config without self_ledger (account-read on the old lib)
    w.old_machine()
    w.sig("a1", 1)
    w.boot()
    w.settle()
    rep = w.report()
    w.eq(rep["self_ledger"], False, "no flag + running old lib (snapshot has no own_only) → false")
    w.sup["running"] = False
    w.age_heartbeat(400)
    w.eq(w.report()["self_ledger"], False, "no flag + reconciler down → the lib on disk (old) → false")
    st = w.report()["states"]["a1"]
    w.check("weights" not in st and "type" not in st, f"Type A state forwarded as before ({st})")
    # an old-lib Type C state (whatever the old runner wrote had no weights)
    w.strategy("basket", B, portfolio=True)
    w.ex.save_state("basket", {"position": 0.0, "updated_at": int(time.time())})
    st = w.report()["states"].get("basket") or {}
    w.check("weights" not in st and st.get("type") is None, f"old Type C state: no weights/type ({st})")
    w.eq(w.report()["can_trade_portfolio"], False, "can_trade_portfolio false")


@cell("V1-08", lib="old", rt="new")
def v1_08(w):
    """What the agent sees: every runtime-side prompt/permission line that names a
    lib file, checked against the old workspace; nothing crashes building them."""
    sys.path.insert(0, os.path.join(w.src, "runtime"))
    import types
    sdk = types.ModuleType("claude_agent_sdk")  # the SDK is not what this reads
    for n in ("ClaudeAgentOptions", "AssistantMessage", "TextBlock", "ToolUseBlock",
              "ThinkingBlock", "ResultMessage"):
        setattr(sdk, n, type(n, (), {"__init__": lambda self, **kw: self.__dict__.update(kw)}))
    sdk.query = lambda **kw: None
    sys.modules.setdefault("claude_agent_sdk", sdk)
    import agent_turn as at
    missing = [r for r in at.PROTECTED_EDIT_RULES
               if r.startswith("Edit(/lib/") and not os.path.exists(r[len("Edit(/"):-1])]
    w.eq(missing, ["Edit(/lib/exits.py)"],
         "the only rule naming a file the old lib lacks is the exits.py edit deny (inert)")
    texts = []
    for fn, args in ((getattr(at, "_viewing_env_segment", None), (True,)),
                     (getattr(at, "_viewing_env_segment", None), (False,)),
                     (getattr(at, "data_access_rule", None), ()),
                     (getattr(at, "_portfolio_steps_block", None), (w.ws,))):
        if fn:
            try:
                texts.append(str(fn(*args) or ""))
            except Exception as e:
                w.check(False, f"{fn.__name__} raised on the old workspace: {type(e).__name__}: {e}")
    os.environ["BLAVE_DATA_ACCESS"] = "0"
    try:
        texts.append(str(at.data_access_rule() or ""))
    finally:
        os.environ.pop("BLAVE_DATA_ACCESS", None)
    blob = "\n".join(texts)
    w.check(not re.search(r"lib\.exits|apply_exits|align_feed", blob),
            "no runtime-built prompt text points the agent at lib.exits / align_feed")
    agents = open("AGENTS.md", encoding="utf-8").read()
    w.check("apply_exits" not in agents and not os.path.exists("lib/exits.py"),
            "the old workspace's AGENTS.md does not mention apply_exits (rules and lib ship together)")


@cell("V1-09", lib="old", rt="new", local=True)
def v1_09(w):
    """Desktop (BLAVE_AGENT_LOCAL=1): resume does not start anything itself — the
    app sends its own restart_reconciler; the old lib then trades."""
    w.fresh(signals={"a1": 1}, start=False)
    r = w.start()
    w.eq(w.sup["starts"], 0, f"local resume: the runtime starts nothing ({r})")
    r = w.cmd("restart_reconciler")
    w.check(w.sup["starts"] == 1, f"the app's follow-up starts it ({r})")
    w.eq(w.settle(), [(B, "buy", 0.02, False)], "old lib trades")


def _paper_history_then_first_save(w, lose=("manager/portfolio_config.json", "manager/amounts.ui.json",
                                             "manager/ledger_seed.json")):
    """manager/orders.jsonl holds only PAPER fills and the paper account holds the
    bot's position, but manager/portfolio_config.json is gone (Wei's machine,
    09-23, per runtime/CHANGELOG — how it lost the file is not known). The next
    save is a first save: the old runtime leaves it in account-read mode (it
    had traded), the new one writes self_ledger + a zero baseline (paper fills
    no longer count as traded)."""
    fresh_long(w)
    for f in lose:
        try:
            os.remove(f)
        except OSError:
            pass
    w.eq(w.paper_pos(B), 0.02, "the bot's 0.02 BTC is on the paper account, logged in orders.jsonl")
    w.amounts(a1=1000)
    cfg = json.load(open("manager/portfolio_config.json"))
    w.note(f"[{w.lib_side} lib · {w.rt_side} runtime] first save wrote self_ledger="
           f"{cfg.get('self_ledger')!r}, seed={w.seed()}")
    w.restart_process()
    fills = []
    for _ in range(4):
        fills += w.settle()
    w.note(f"fills after the save: {fills}; paper BTC {w.paper_pos(B)}")
    w.eq(fills, [], "no second buy of the position the bot already holds")
    w.eq(w.paper_pos(B), 0.02, "account stays at the target")


@cell("V1-10", lib="old", rt="new")
def v1_10(w):
    """New runtime + old lib (see V0-01 / V0-02 for old+old and new+new)."""
    _paper_history_then_first_save(w)


@cell("V0-01", lib="old", rt="old")
def v0_01(w):
    """Baseline of V1-10 on old lib + old runtime."""
    _paper_history_then_first_save(w)


@cell("V0-02", lib="new", rt="new")
def v0_02(w):
    """Baseline of V1-10 on new lib + new runtime."""
    _paper_history_then_first_save(w)


@cell("V0-03", lib="old", rt="old")
def v0_03(w):
    """Baseline of V1-04 on old+old: after unbind → new paper account → start."""
    fresh_long(w)
    w.cmd("credentials_remove", env=PAPER_KEYS)
    w.eq(_rebind_new_paper_account(w), [], "old+old: no re-buy either (pre-existing)")


@cell("V0-04", lib="new", rt="new")
def v0_04(w):
    """Baseline of V1-04 on new+new: the new account's book starts empty."""
    fresh_long(w)
    w.cmd("credentials_remove", env=PAPER_KEYS)
    w.eq(_rebind_new_paper_account(w), [(B, "buy", 0.02, False)], "new+new re-buys the target")


@cell("V0-05", lib="new", rt="new", local=True)
def v0_05(w):
    """Baseline of V1-05's demo-host cases on the new lib."""
    cl = w.cl
    cl.LOCAL_OPEN_VENUES = frozenset(cl.LOCAL_OPEN_VENUES | {"BINANCE", "OKX", "BINGX", "GATEIO", "BYBIT"})
    demo_host_cases(w)


@cell("V1-11", lib="old", rt="new")
def v1_11(w):
    """Park/unpark for a real-venue account (cloud bind of OKX needs no venue
    call): same keys back → the old lib's snapshot and guard state return;
    other keys → dropped. The restored files are the old lib's own format."""
    keys = dict(GATE_KEYS["OKX"])
    r = w.cmd("credentials", env=keys)
    w.check(not isinstance(r, Exception), f"bind OKX on the cloud ({r})")
    w.sup["running"] = True
    snap = {"ts": "2026-09-23T00:00:00", "target": {}, "actual": {B: {"side": "long", "size": 10}}}
    json.dump(snap, open("manager/last_reconcile.json", "w"))
    json.dump({"venue": "okx", "account": "x"}, open("state/venue_account.json", "w"))
    w.cmd("credentials_remove", env=list(keys))
    w.check(os.path.exists("state/unbound_account_state.json") and not os.path.exists("manager/last_reconcile.json"),
            "unbind: parked and cleared")
    w.cmd("credentials", env=keys)
    w.eq(json.load(open("manager/last_reconcile.json")), snap, "same keys back: the old lib's snapshot restored as it was")
    w.check(os.path.exists("state/venue_account.json"), "…and the guard state")
    w.sup["running"] = True
    w.cmd("credentials_remove", env=list(keys))
    other = dict(keys, OKX_API_KEY="okxkey-OTHER")
    w.cmd("credentials", env=other)
    w.check(not os.path.exists("manager/last_reconcile.json") and not os.path.exists("state/unbound_account_state.json"),
            "other keys: parked state dropped, not restored")


KEEP_SEED = ("manager/portfolio_config.json", "manager/amounts.ui.json")


@cell("V1-12", lib="old", rt="new")
def v1_12(w):
    """V1-10 with the baseline kept (only the config lost): the runtime keeps the
    existing seed, the book still holds the bot's fills."""
    _paper_history_then_first_save(w, lose=KEEP_SEED)


@cell("V0-06", lib="new", rt="new")
def v0_06(w):
    """V1-12 on new lib + new runtime."""
    _paper_history_then_first_save(w, lose=KEEP_SEED)


# ── V2: old runtime + new lib ────────────────────────────────────────────────

@cell("V2-01", lib="new", rt="old")
def v2_01(w):
    """Fresh machine on the old runtime, new lib: the old first save writes a
    seed without own_only_basis; the new lib must still trade exactly once."""
    w.fresh(signals={"a1": 1}, start=False)
    seed = w.seed() or {}
    w.check(seed.get("seeded_at") and not seed.get("own_only_basis"),
            f"old runtime's seed has no own_only_basis ({seed})")
    r = w.start()
    w.eq(w.sup["starts"], 0, f"old runtime: resume without a record starts nothing ({r})")
    w.eq(w.round(), "down", "…so no round runs until someone restarts it")
    r = w.cmd("restart_reconciler")
    w.check(w.sup["starts"] == 1, f"the web's restart_reconciler starts it ({r})")
    fills = []
    for _ in range(4):
        fills += w.settle()
    w.eq(fills, [(B, "buy", 0.02, False)], "new lib buys once (migration first, then the entry)")
    w.eq(w.book(), {B: (0.02, 1000.0)}, "book = the bot's fill")
    w.check(w.snap().get("own_only") is True, "snapshot own_only")


@cell("V2-02", lib="new", rt="old")
def v2_02(w):
    """Old reporter against the new lib: no crash on the new Type C state; the
    self_ledger it reports is the flag only (safe direction: it may warn)."""
    w.old_machine()
    w.sig("a1", 1)
    w.boot()
    for _ in range(3):
        w.settle()
    rep = w.report()
    w.check(w.snap().get("own_only") is True, "new lib runs own-only")
    w.eq(rep["self_ledger"], False, "old reporter: flag missing → false (the web warns that "
                                    "manual positions may be closed — conservative, not a lie that hurts)")
    w.weights_state = {"type": "portfolio", "weights": {B: 0.5, E: 0.5}, "rebalance_at": 1790000000,
                       "bar_at": 1790000000, "updated_at": int(time.time())}
    w.strategy("basket", B, portfolio=True)
    w.ex.save_state("basket", w.weights_state)
    st = w.pr.strategy_states().get("basket")
    w.check(isinstance(st, dict), f"old reporter reads the new Type C state without raising ({st})")
    w.eq(rep["can_trade_portfolio"], "ABSENT", "old reporter has no can_trade_portfolio")


@cell("V2-03", lib="new", rt="old")
def v2_03(w):
    """Old runtime refuses Type C funding even though the new lib could trade it."""
    w.strategy("basket", B, portfolio=True)
    w.bind_paper()
    r = w.amounts(basket=1000)
    w.check(isinstance(r, Exception) and "Type C" in str(r), f"refused ({str(r)[:80]})")


@cell("V2-04", lib="new", rt="old")
def v2_04(w):
    """Old resume_wait gate format read by the new lib (Type A)."""
    w.fresh(signals={"a1": 1}, start=False)
    w.start(wait=True)
    w.cmd("restart_reconciler")
    w.eq(json.load(open("state/signal_gate.json")), {"a1": 1.0}, "gate written by the old runtime")
    fills = []
    for _ in range(3):
        fills += w.settle()
    w.eq(fills, [], "new lib honours the old gate: nothing until a new signal")
    w.sig("a1", -1)
    fills = []
    for _ in range(3):
        fills += w.settle()
    w.eq(fills, [(B, "sell", 0.02, False)], "new signal trades")


@cell("V2-05", lib="new", rt="old")
def v2_05(w):
    """Unbind → rebind (new paper account) → start on the old runtime: no park,
    no stop mark, no per-venue reset from the runtime. Either the new lib's
    account guard sees the old account's state and halts (TC-13, which the new
    runtime's park/unpark fixes), or a lib that detects the new paper account
    itself resets that venue's book and buys the target once. Both are safe."""
    fresh_long(w)
    w.cmd("credentials_remove", env=PAPER_KEYS)
    w.check(not os.path.exists("state/book_account.json"), "old runtime remembers no account")
    w.bind_paper(ts=int(time.time()) + 5)
    w.amounts(a1=1000)
    w.age_heartbeat(400)
    w.start()
    w.cmd("restart_reconciler")
    fills = []
    for _ in range(4):
        fills += w.settle()
    w.note(f"fills {fills}; book {w.book()}; paper BTC {w.paper_pos(B)}; HALT {w.halt_info()}")
    h = w.halt_info() or {}
    halted = w.halted() and "account changed" in str(h.get("reason", ""))
    rebought = fills == [(B, "buy", 0.02, False)] and w.paper_pos(B) == 0.02 and not w.halted()
    w.check(halted or rebought,
            "safe either way: the account guard halts with its reason and places nothing, or the lib "
            "itself sees another paper account, resets that venue's book and buys the target once")


@cell("V2-06", lib="new", rt="old")
def v2_06(w):
    """Old runtime helpers that import the lib by name: _capital_open_book_keys
    (ledger_positions() with no venue) and the old account reader."""
    fresh_long(w)
    fn = getattr(w.cl, "_capital_open_book_keys", None)
    if fn:
        try:
            out = fn()
            w.check(isinstance(out, str), f"_capital_open_book_keys returns ({out!r})")
        except Exception as e:
            w.check(False, f"_capital_open_book_keys raised {type(e).__name__}: {e}")
    try:
        out = w.pf.ledger_positions()
        w.check(isinstance(out, dict), f"new ledger_positions() with no venue works ({out})")
    except TypeError as e:
        w.check(False, f"new ledger_positions() needs an argument: {e}")
    sys.path.insert(0, os.path.join(w.src, "runtime"))
    import account_reader as ar
    e = ar.read_venue("paper", w.env())
    w.check(isinstance(e, dict) and e.get("error") is None and "accounts_partial" not in e,
            f"old account_reader reads the new paper lib ({ {k: e.get(k) for k in ('equity', 'error')} })")


@cell("V2-07", lib="new", rt="old")
def v2_07(w):
    """Old runtime's close_all launches the NEW manager/flatten.py: it must
    close only the bot's book, never the user's positions beside it."""
    fresh_long(w)
    for _ in range(2):
        w.settle()
    w.manual(E, 1.0)
    w.manual(B, 0.01)
    r = w.cmd("close_all")
    w.check("started" in str(r) or isinstance(r, dict), f"close_all launched ({str(r)[:80]})")
    log = w.wait_flatten()
    w.eq(w.paper_pos(), {B: 0.01, E: 1.0}, "only the bot's 0.02 BTC closed; manual BTC/ETH stay")
    w.check("Traceback" not in log, "flatten ran clean")


# ── V3: new lib first run on an existing (old-lib) machine ───────────────────
# Orchestrated: phase A runs old lib + old runtime and leaves real state; the
# workspace's official files are then swapped to the new side (what 更新 does)
# and phase B runs new lib + new runtime on the same state.

@phase("v3a")
def v3a(w):
    """old+old: two machines' worth of history in one workspace — a Type A
    strategy long, a manual ETH, a Type C basket state, flat account history."""
    w.fresh(strategies=(("a1", B), ("a2", E)), signals={"a1": 1, "a2": 0})
    if not w.sup["running"]:
        w.cmd("restart_reconciler")  # old runtime: the web's follow-up to 啟動下單
    for _ in range(2):
        w.settle()
    w.manual(E, 1.0)              # the user's own ETH, on the same account
    w.manual(B, 0.01)             # …and an extra BTC beside the bot's 0.02
    w.strategy("basket", B, portfolio=True)
    w.ex.save_state("basket", {"position": 0.0, "updated_at": int(time.time())})
    w.eq(w.paper_pos(), {B: 0.03, E: 1.0}, "phase A leaves BTC 0.03 (0.02 bot) + ETH 1.0 manual")
    json.dump({"fills": w.paper_fills(), "pos": w.paper_pos(), "seed": w.seed(),
               "cfg": json.load(open("manager/portfolio_config.json"))},
              open("state/_vm_phase_a.json", "w"))


@phase("v3b")
def v3b(w):
    a = json.load(open("state/_vm_phase_a.json"))
    w.boot()
    n0 = len(w.paper_fills())
    outs = [w.round() for _ in range(5)]
    w.check(all(o == "ok" or o.startswith("skipped") for o in outs), f"rounds run ({outs})")
    new = w.paper_fills()[n0:]
    w.eq(new, [], "new lib's first rounds on the old state place nothing")
    w.eq(w.paper_pos(), {k: v for k, v in a["pos"].items()}, "positions unchanged (manual ETH, extra BTC)")
    s = w.snap()
    w.check(s.get("own_only") is True, "snapshot own_only")
    w.eq(w.book(), {B: (0.02, 1000.0)}, "book = the bot's own 0.02 BTC, keyed to paper")
    seed = w.seed() or {}
    w.note(f"seed after migration: { {k: seed.get(k) for k in ('own_only_basis', 'seeded_at')} }")
    w.check(seed.get("own_only_basis") in (1, None), "migration basis handled")
    # the signal moves: only the bot's share trades, the manual BTC stays
    w.sig("a1", 0)
    fills = []
    for _ in range(3):
        fills += w.settle()
    w.eq(fills, [(B, "sell", 0.02, True)], "exit sells only the bot's 0.02")
    w.eq(w.paper_pos(), {B: 0.01, E: 1.0}, "manual BTC 0.01 and ETH 1.0 untouched")
    st = w.report()["states"].get("basket") or {}
    w.check("weights" not in st, "old Type C state (no weights) = no live target, not traded")


@phase("v3a_real")
def v3a_real(w):
    """old+old, 'real-shaped': the config was saved before the flag existed
    (account-read mode), history logged against a real venue id."""
    w.old_machine(strategies=(("a1", B),))
    w.sig("a1", 1)
    w.boot()
    for _ in range(2):
        w.settle()
    w.manual(E, 2.0)
    json.dump({"pos": w.paper_pos(), "cfg": json.load(open("manager/portfolio_config.json"))},
              open("state/_vm_phase_a.json", "w"))


@phase("v3b_real")
def v3b_real(w):
    a = json.load(open("state/_vm_phase_a.json"))
    w.check("self_ledger" not in a["cfg"], "phase A config has no self_ledger key")
    w.boot()
    n0 = len(w.paper_fills())
    outs = [w.round() for _ in range(6)]
    w.eq(w.paper_fills()[n0:], [], f"no order while migrating ({outs})")
    w.eq(w.paper_pos(), a["pos"], "positions unchanged")
    w.eq(w.book(), {B: (0.02, 1000.0)}, "the bot's BTC adopted into paper's book")
    w.check((w.seed() or {}).get("own_only_basis") == 1, "basis written by the new lib")
    w.sig("a1", 0)
    fills = []
    for _ in range(3):
        fills += w.settle()
    w.eq(fills, [(B, "sell", 0.02, True)], "exit sells the bot's share")
    w.eq(w.paper_pos(), {E: 2.0}, "manual ETH untouched")


@phase("v3a_rows")
def v3a_rows(w):
    """old+old: a close-all (old flatten writes per-symbol zero rows without a
    venue), then the strategy re-enters — the seed has venue-less rows."""
    fresh_long(w)
    w.cmd("close_all")
    w.wait_flatten()
    w.eq(w.paper_pos(B), 0.0, "old flatten closed the bot's BTC")
    w.start()
    if not w.sup["running"]:
        w.cmd("restart_reconciler")
    for _ in range(2):
        w.settle()
    w.manual(E, 1.0)
    rows = (w.seed() or {}).get("symbols") or {}
    w.check(any(r.get("venue") is None for r in rows.values()) and rows,
            f"old seed carries per-symbol rows without a venue ({rows})")
    w.eq(w.paper_pos(), {B: 0.02, E: 1.0}, "re-entered 0.02 BTC; manual ETH")
    json.dump({"pos": w.paper_pos()}, open("state/_vm_phase_a.json", "w"))


@phase("v3b_rows")
def v3b_rows(w):
    a = json.load(open("state/_vm_phase_a.json"))
    w.boot()
    n0 = len(w.paper_fills())
    outs = [w.round() for _ in range(5)]
    w.eq(w.paper_fills()[n0:], [], f"no order on the venue-less seed ({outs})")
    w.eq(w.paper_pos(), a["pos"], "positions unchanged")
    w.eq(w.book(), {B: (0.02, 1000.0)}, "book = the re-entered 0.02 only (the zero row cut the old fills)")
    rows = (w.seed() or {}).get("symbols") or {}
    w.note(f"seed rows after the first rounds: {rows}")
    w.check(all(k.startswith("paper|") or (r or {}).get("venue") == "paper" for k, r in rows.items()),
            "venue-less rows claimed for paper (the one bound venue)")
    w.cmd("close_all")
    w.wait_flatten(n=2)  # phase A's flatten already ended once in the same log
    w.eq(w.paper_pos(), {E: 1.0}, "new close-all: only the bot's BTC; manual ETH stays")


# ── V4 helpers: real processes ───────────────────────────────────────────────

def _fake_bin(base, ws, env):
    """systemctl / sudo / tmux for update_workspace.py: one real reconciler.py
    process, started from the workspace, is 'the unit'."""
    bindir = os.path.join(base, "bin")
    os.makedirs(bindir, exist_ok=True)
    log = os.path.join(base, "sup.log")
    pidf = os.path.join(base, "unit.pid")
    py = sys.executable
    ctl = f'''#!{py}
import os, signal, subprocess, sys, time
PIDF, WS, LOG = {pidf!r}, {ws!r}, {log!r}
def alive():
    try:
        pid = int(open(PIDF).read())
        os.kill(pid, 0)
        return pid
    except Exception:
        return None
def log(m):
    open(LOG, "a").write(f"{{time.time():.3f}} {{m}}\\n")
a = [x for x in sys.argv[1:] if not x.startswith("-")]
if a and a[0] == "is-active":
    print("active" if alive() else "inactive"); sys.exit(0 if alive() else 3)
if a and a[0] in ("restart", "start", "stop"):
    pid = alive()
    if pid:
        os.kill(pid, signal.SIGTERM)
        for _ in range(100):
            try:
                os.kill(pid, 0); time.sleep(0.05)
            except OSError:
                break
        log(f"stopped {{pid}}")
    if a[0] != "stop":
        p = subprocess.Popen([sys.executable, "manager/reconciler.py"], cwd=WS,
                             stdout=open(os.path.join(WS, "state", "reconciler.out"), "a"),
                             stderr=subprocess.STDOUT, start_new_session=True)
        open(PIDF, "w").write(str(p.pid))
        log(f"started {{p.pid}}")
    sys.exit(0)
sys.exit(1)
'''
    with open(os.path.join(bindir, "systemctl"), "w") as f:
        f.write(ctl)
    with open(os.path.join(bindir, "sudo"), "w") as f:
        f.write(f'#!/bin/sh\n[ "$1" = "-n" ] && shift\n[ "$1" = "/usr/bin/systemctl" ] && shift\n'
                f'exec "{bindir}/systemctl" "$@"\n')
    with open(os.path.join(bindir, "tmux"), "w") as f:
        f.write("#!/bin/sh\nexit 1\n")
    for n in ("systemctl", "sudo", "tmux"):
        os.chmod(os.path.join(bindir, n), 0o755)
    return bindir, log, pidf


GIT_ENV = {"PATH": "/usr/bin:/bin", "HOME": "/nonexistent", "GIT_CONFIG_GLOBAL": os.devnull,
           "GIT_CONFIG_NOSYSTEM": "1", "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
           "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}


def _g(repo, *args, check=True):
    return subprocess.run(["git", "-C", repo, *args], env=GIT_ENV, capture_output=True,
                          text=True, check=check).stdout.strip()


def make_clone(base, old_ref, new_src):
    """A scratch clone of this repo (read-only on it) at old_ref, plus one commit
    that is the new tree's official files — history holds every old blob, as the
    official clone's does. Origin = the official URL, as update_workspace wants."""
    clone = os.path.join(base, "clone")
    subprocess.run(["git", "clone", "-q", "--no-hardlinks", ROOT, clone], env=GIT_ENV,
                   check=True, capture_output=True)
    _g(clone, "checkout", "-q", "--detach", old_ref)
    for d in OFFICIAL_DIRS:
        dst = os.path.join(clone, d)
        if os.path.isdir(dst):
            shutil.rmtree(dst)
        if os.path.isdir(os.path.join(new_src, d)):
            shutil.copytree(os.path.join(new_src, d), dst,
                            ignore=shutil.ignore_patterns("__pycache__", "*.pyc", *MACHINE_STATE))
    for f in OFFICIAL_FILES:
        if os.path.exists(os.path.join(new_src, f)):
            shutil.copy(os.path.join(new_src, f), os.path.join(clone, f))
    # a VERSION the update can see (the new tree may not have bumped it yet: V6-01)
    v_old = _g(clone, "show", f"{old_ref}:VERSION")
    v_new = open(os.path.join(clone, "VERSION")).read().strip()
    if v_new <= v_old:
        open(os.path.join(clone, "VERSION"), "w").write(v_old + "-vm\n")
    _g(clone, "add", "-A", *OFFICIAL_DIRS, *[f for f in OFFICIAL_FILES
                                              if os.path.exists(os.path.join(clone, f))])
    _g(clone, "commit", "-qm", "version-matrix new tree", check=False)
    _g(clone, "remote", "set-url", "origin", "https://github.com/Blave-TW/blave-agent")
    return clone, _g(clone, "rev-parse", "HEAD")


# ── V5/V6 are the shell side: tests/check_version_matrix_shell.js ────────────

SHELL_CELLS = {}  # id -> description; run by the .js file, listed here for the doc enumeration


def shell_cell(cid):
    SHELL_CELLS[cid] = True


for _c in ("V5-01", "V5-02", "V5-03", "V5-04", "V5-05", "V6-01", "V6-05"):
    shell_cell(_c)


# ── parent ───────────────────────────────────────────────────────────────────

def _child_env(base, blocked):
    env = dict(os.environ)
    env.pop("BLAVE_AGENT_LOCAL", None)
    env["PATH"] = os.path.dirname(sys.executable) + os.pathsep + env.get("PATH", "")
    env["PYTHONPATH"] = base
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["PAPER_HARNESS_BLOCK"] = os.pathsep.join(blocked)
    env["MPLBACKEND"] = "Agg"
    return env


def make_ws(lib_src, rt_src, base, prefix="ws-"):
    ws = tempfile.mkdtemp(prefix=prefix, dir=base)
    copy_official(lib_src, ws)
    for d in ("state", "strategies"):
        os.makedirs(os.path.join(ws, d), exist_ok=True)
    os.symlink(os.path.join(rt_src, "runtime"), os.path.join(ws, "current"))
    return ws


def copy_official(src, ws):
    for d in OFFICIAL_DIRS:
        s = os.path.join(src, d)
        if not os.path.isdir(s):
            continue
        dst = os.path.join(ws, d)
        if d == "manager" and os.path.isdir(dst):
            # keep the machine's own files (portfolio_config.json, orders.jsonl …)
            for n in os.listdir(s):
                p = os.path.join(s, n)
                if os.path.isfile(p) and not n.endswith(".pyc") and n not in MACHINE_STATE:
                    shutil.copy2(p, os.path.join(dst, n))
            continue
        if os.path.isdir(dst):
            shutil.rmtree(dst)
        shutil.copytree(s, dst, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", *MACHINE_STATE))
    for f in OFFICIAL_FILES:
        p = os.path.join(src, f)
        if os.path.exists(p):
            os.makedirs(os.path.dirname(os.path.join(ws, f)) or ws, exist_ok=True)
            shutil.copy2(p, os.path.join(ws, f))


class Ctx:
    def __init__(self, a, base):
        self.a, self.base = a, base
        self.src = {"old": a.old_src, "new": a.new_src}
        self.blocked = [os.path.join(ROOT, ".env"), os.path.join(a.old_src, ".env"),
                        os.path.join(a.new_src, ".env"), os.path.expanduser("~/.config/blave")]


def spawn(ctx, ws, lib_side, rt_side, local, cid=None, phase_name=None):
    env = _child_env(ctx.base, ctx.blocked)
    env["BLAVE_AGENT_WORKSPACE"] = ws
    env["BLAVE_AGENT_HOME"] = env["BLAVECLAW_HOME"] = env["BLAVE_AGENT_BASE"] = ws
    if local:
        env["BLAVE_AGENT_LOCAL"] = "1"
    argv = [sys.executable, os.path.abspath(__file__), "--child", cid or "-", "--ws", ws,
            "--rt-src", ctx.src[rt_side], "--lib-side", lib_side, "--rt-side", rt_side]
    if phase_name:
        argv += ["--phase", phase_name]
    try:
        p = subprocess.run(argv, cwd=ws, env=env, capture_output=True, text=True,
                           timeout=CHILD_TIMEOUT_S)
        return p.returncode, p.stdout + (("\n" + p.stderr) if p.returncode else "")
    except subprocess.TimeoutExpired as e:
        return 1, f"TIMEOUT after {CHILD_TIMEOUT_S}s\n{e.stdout or ''}"


def run_cell(ctx, cid):
    fn, lib, rt, local, kind = CELLS[cid]
    t0 = time.time()
    if kind in ("orch", "static"):
        rc, out, ws = fn(ctx)
        ws = ws or tempfile.mkdtemp(dir=ctx.base)
    else:
        ws = make_ws(ctx.src[lib], ctx.src[rt], ctx.base)
        rc, out = spawn(ctx, ws, lib, rt, local, cid=cid)
    if rc == 0 and not ctx.a.keep:
        shutil.rmtree(ws, ignore_errors=True)
    return cid, rc, out, time.time() - t0, ws


def _swap_to(ctx, ws, side):
    """What 更新 does to the official files (the runtime link follows too)."""
    copy_official(ctx.src[side], ws)
    os.remove(os.path.join(ws, "current"))
    os.symlink(os.path.join(ctx.src[side], "runtime"), os.path.join(ws, "current"))


@cell("V3-01", lib="old→new", rt="old→new", kind="orch")
def v3_01(ctx):
    ws = make_ws(ctx.src["old"], ctx.src["old"], ctx.base)
    rc1, o1 = spawn(ctx, ws, "old", "old", False, phase_name="v3a")
    _swap_to(ctx, ws, "new")
    rc2, o2 = spawn(ctx, ws, "new", "new", False, phase_name="v3b")
    return (rc1 or rc2), "phase A (old lib + old runtime)\n" + o1 + "\nphase B (new + new)\n" + o2, ws


@cell("V3-02", lib="old→new", rt="old→new", kind="orch")
def v3_02(ctx):
    ws = make_ws(ctx.src["old"], ctx.src["old"], ctx.base)
    rc1, o1 = spawn(ctx, ws, "old", "old", False, phase_name="v3a_real")
    _swap_to(ctx, ws, "new")
    rc2, o2 = spawn(ctx, ws, "new", "new", False, phase_name="v3b_real")
    return (rc1 or rc2), "phase A\n" + o1 + "\nphase B\n" + o2, ws


@cell("V3-03", lib="old→new", rt="new", kind="orch")
def v3_03(ctx):
    """Real shape of the rollout: the runtime updated first (phase A on new
    runtime + old lib), then 更新 brings the lib."""
    ws = make_ws(ctx.src["old"], ctx.src["new"], ctx.base)
    rc1, o1 = spawn(ctx, ws, "old", "new", False, phase_name="v3a")
    _swap_to(ctx, ws, "new")
    rc2, o2 = spawn(ctx, ws, "new", "new", False, phase_name="v3b")
    return (rc1 or rc2), "phase A (old lib + NEW runtime)\n" + o1 + "\nphase B\n" + o2, ws


@cell("V3-04", lib="old→new", rt="new", kind="orch")
def v3_04(ctx):
    ws = make_ws(ctx.src["old"], ctx.src["new"], ctx.base)
    rc1, o1 = spawn(ctx, ws, "old", "old", False, phase_name="v3a_rows")
    _swap_to(ctx, ws, "new")
    rc2, o2 = spawn(ctx, ws, "new", "new", False, phase_name="v3b_rows")
    return (rc1 or rc2), "phase A (old + old)\n" + o1 + "\nphase B (new + new)\n" + o2, ws


@phase("v4a")
def v4a(w):
    """old+old paper machine with a live position, then the real reconciler
    process takes over (the fake systemd starts it)."""
    fresh_long(w)
    w.manual(E, 1.0)
    w.eq(w.paper_pos(), {B: 0.02, E: 1.0}, "open positions before the update")


@cell("V4-01", lib="old→new", rt="new", kind="orch")
def v4_01(ctx):
    """manager/update_workspace.py from HEAD to the new tree on a machine with a
    running (real process) paper reconciler and open positions."""
    out = []
    ws = make_ws(ctx.src["old"], ctx.src["new"], ctx.base, prefix="ws4-")
    os.remove(os.path.join(ws, "manager", "update_workspace.py")) if os.path.exists(
        os.path.join(ws, "manager", "update_workspace.py")) else None
    rc, o = spawn(ctx, ws, "old", "new", False, phase_name="v4a")
    out.append("phase A\n" + o)
    fails = rc
    env = _child_env(ctx.base, ctx.blocked)
    env["BLAVE_AGENT_WORKSPACE"] = ws
    env["BLAVE_AGENT_HOME"] = env["BLAVECLAW_HOME"] = env["BLAVE_AGENT_BASE"] = ws
    bindir, suplog, pidf = _fake_bin(ctx.base, ws, env)
    env["PATH"] = bindir + os.pathsep + env["PATH"]

    def check(cond, msg):
        nonlocal fails
        out.append(("ok   " if cond else "FAIL ") + msg)
        fails += 0 if cond else 1

    def ledger():
        try:
            return json.load(open(os.path.join(ws, "state", "paper_ledger.json")))
        except (OSError, ValueError):
            return {}

    def hb():
        try:
            return os.path.getmtime(os.path.join(ws, "state", "heartbeat", "reconciler"))
        except OSError:
            return 0

    subprocess.run([os.path.join(bindir, "systemctl"), "start", "x"], env=env, check=True)
    t0 = time.time()
    while hb() < t0 and time.time() - t0 < 30:
        time.sleep(0.2)
    check(hb() >= t0, "the old reconciler process runs (fresh heartbeat)")
    time.sleep(12)  # two real rounds of the old daemon
    fills0 = len(ledger().get("fills") or [])
    pos0 = {s: p["qty"] for s, p in (ledger().get("positions") or {}).items()}
    check(pos0 == {B: 0.02, E: 1.0}, f"old daemon holds steady ({pos0}, {fills0} fills)")
    old_pid = int(open(pidf).read())
    clone, head = make_clone(ctx.base, ctx.a.old_ref_resolved, ctx.src["new"])
    upd = os.path.join(clone, "manager", "update_workspace.py")
    plan = subprocess.run([sys.executable, upd, "plan", "--clone", clone, "--workspace", ws,
                           "--expect-head", head], env=env, capture_output=True, text=True)
    try:
        p = json.loads(plan.stdout)
    except ValueError:
        p = {"outcome": "unparsable", "raw": plan.stdout[-400:] + plan.stderr[-400:]}
    check(p.get("outcome") == "plan", f"plan runs ({p.get('outcome')}: {p.get('reason', '')})")
    check(p.get("changed_here") == [], f"no file reads as changed-here (got {p.get('changed_here')})")
    check(p.get("reconciler") == "running" and p.get("needs_restart") is True,
          "plan: reconciler running, restart needed")
    out.append(f"NOTE plan: {len(p.get('old_official') or [])} older official, "
               f"{len(p.get('missing') or [])} missing ({', '.join((p.get('missing') or [])[:12])})")
    t_apply = time.time()
    ap = subprocess.run([sys.executable, upd, "apply", "--clone", clone, "--workspace", ws,
                         "--expect-head", head, "--restart-ok"], env=env, capture_output=True,
                        text=True)
    try:
        r = json.loads(ap.stdout)
    except ValueError:
        r = {"outcome": "unparsable", "raw": ap.stdout[-400:] + ap.stderr[-400:]}
    check(r.get("outcome") == "updated" and r.get("restart") == "ok" and r.get("version_written"),
          f"apply: updated, restarted, VERSION written ({ {k: r.get(k) for k in ('outcome', 'restart', 'version_after', 'refused', 'error', 'reason')} })")
    lines = open(suplog).read().splitlines()
    restart_t = max((float(l.split()[0]) for l in lines if " started " in l), default=0)
    v_mtime = os.path.getmtime(os.path.join(ws, "VERSION"))
    newest_code = max(os.path.getmtime(os.path.join(ws, x)) for x in (r.get("replaced") or []) + (r.get("added") or []))
    check(restart_t > t_apply and v_mtime >= restart_t and v_mtime >= newest_code,
          "VERSION written last (after every file and after the restart)")
    new_pid = int(open(pidf).read())
    check(new_pid != old_pid, "the reconciler process was replaced")
    t1 = time.time()
    while hb() < t1 and time.time() - t1 < 30:
        time.sleep(0.2)
    check(hb() >= t1, "the new reconciler is up (fresh heartbeat)")
    time.sleep(20)  # four real rounds of the new daemon on the old state
    led = ledger()
    fills1 = led.get("fills") or []
    check(len(fills1) == fills0, f"no paper order across the swap and the new daemon's first rounds "
                                 f"({len(fills1) - fills0} new)")
    pos1 = {s: p["qty"] for s, p in (led.get("positions") or {}).items()}
    check(pos1 == pos0, f"positions unchanged ({pos1})")
    try:
        import fcntl
        fd = os.open(os.path.join(ws, "state", "reconciler.pid"), os.O_RDWR)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            held = False
        except OSError:
            held = True
        os.close(fd)
    except OSError:
        held = False
    check(held, "the new reconciler holds the singleton lock")
    try:
        snap = json.load(open(os.path.join(ws, "manager", "last_reconcile.json")))
    except (OSError, ValueError):
        snap = {}
    check(snap.get("own_only") is True, "new daemon runs own-only")
    check(not os.path.exists(os.path.join(ws, "state", "update_restart_pending.json")),
          "no restart owed")
    # a second daemon beside it (the old runtime's world: tmux + systemd) exits 75
    sec = subprocess.run([sys.executable, "manager/reconciler.py"], cwd=ws, env=env,
                         capture_output=True, text=True, timeout=30)
    check(sec.returncode == 75, f"a second new reconciler exits 75 (got {sec.returncode})")
    subprocess.run([os.path.join(bindir, "systemctl"), "stop", "x"], env=env)
    rout = ""
    try:
        rout = open(os.path.join(ws, "state", "reconciler.out")).read()
    except OSError:
        pass
    tb = [l for l in rout.splitlines() if "Traceback" in l]
    check(not tb, f"no traceback in the daemons' output ({len(tb)})")
    if fails:
        out.append("reconciler output tail:\n" + rout[-3000:])
    out.append(f"update result: {json.dumps(r, ensure_ascii=False)[:1500]}")
    return (1 if fails else 0), "\n".join(out), ws


@cell("V4-02", lib="old", rt="new", kind="orch")
def v4_02(ctx):
    """The hazard the process guard exists for, on real processes: two OLD
    reconcilers in one workspace both run (no lock) — two new ones do not."""
    out, fails = [], 0
    for side, want_second in (("old", "runs"), ("new", "exits 75")):
        ws = make_ws(ctx.src[side], ctx.src["new"], ctx.base, prefix=f"ws42{side}-")
        env = _child_env(ctx.base, ctx.blocked)
        env["BLAVE_AGENT_WORKSPACE"] = ws
        env["BLAVE_AGENT_HOME"] = env["BLAVECLAW_HOME"] = env["BLAVE_AGENT_BASE"] = ws
        p1 = subprocess.Popen([sys.executable, "manager/reconciler.py"], cwd=ws, env=env,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                              start_new_session=True)
        time.sleep(3)
        p2 = subprocess.Popen([sys.executable, "manager/reconciler.py"], cwd=ws, env=env,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                              start_new_session=True)
        try:
            rc2 = p2.wait(timeout=8)
        except subprocess.TimeoutExpired:
            rc2 = None
        got = "runs" if rc2 is None else f"exits {rc2}"
        ok = got == want_second
        fails += 0 if ok else 1
        out.append(("ok   " if ok else "FAIL ") + f"{side} reconciler.py: a second copy {got} "
                   f"(want: {want_second})")
        for p in (p1, p2):
            if p.poll() is None:
                p.terminate()
                try:
                    p.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    p.kill()
        if not ctx.a.keep:
            shutil.rmtree(ws, ignore_errors=True)
    ws = tempfile.mkdtemp(dir=ctx.base)
    return (1 if fails else 0), "\n".join(out), ws


# ── V6: local vs cloud workspaces ────────────────────────────────────────────

@cell("V6-03", lib="new", rt="-", kind="static")
def v6_03(ctx):
    """No machine-state file in the new tree's official dirs. update_workspace
    treats every file under lib/ manager/ references/ examples/ allocators/ as
    official except its NEVER list / manager state pattern (check_manager_state_never_official.py):
    a committed state file would be copied onto every machine that lacks one
    (\"missing\") and read as \"changed here\" on every machine that has its own —
    VERSION then never written."""
    out, bad = [], []
    for d in OFFICIAL_DIRS:
        root = os.path.join(ctx.src["new"], d)
        for dp, dn, fn in os.walk(root):
            dn[:] = [x for x in dn if x != "__pycache__"]
            for n in fn:
                if n in MACHINE_STATE:
                    rel = os.path.relpath(os.path.join(dp, n), ctx.src["new"])
                    ign = subprocess.run(["git", "-C", ROOT, "check-ignore", "-q", rel]).returncode == 0 \
                        if ctx.src["new"] == ROOT else False
                    if not ign:
                        bad.append(rel)
    upd = open(os.path.join(ctx.src["new"], "manager", "update_workspace.py")).read()
    never = re.search(r"^NEVER = \((.*)\)$", upd, re.M)
    out.append(f"NOTE update_workspace NEVER = ({never.group(1) if never else '?'})")
    ok = not bad
    out.append(("ok   " if ok else "FAIL ") + "no machine-state file in the official dirs"
               + ("" if ok else f": {bad} (not ignored — `git add -A` would ship it)"))
    return (0 if ok else 1), "\n".join(out), None


@cell("V6-04", lib="old", rt="new")
def v6_04(w):
    """A strategy written against the NEW local lib, sent to a cloud machine still
    on the OLD lib (cloud-handoff §3 reports the gap and continues): what breaks
    and how loudly. Real files: the new examples/ and the new template's exit
    recipe, imported on the old lib."""
    import importlib
    sys.path.insert(0, w.ws)
    def try_import(label, code):
        path = os.path.join("strategies", "vm_probe", "strategy.py")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        open(path, "w").write(code)
        spec = importlib.util.spec_from_file_location("vm_probe_" + label, path)
        m = importlib.util.module_from_spec(spec)
        try:
            spec.loader.exec_module(m)
            return m, None
        except Exception as e:
            return None, f"{type(e).__name__}: {e}"
    ex_path = os.path.join(w.src, "examples", "tw100_foreign_zscore", "strategy.py")  # w.src = the new side
    ex_new = open(ex_path).read() if os.path.exists(ex_path) else ""
    uses_align = "align_feed" in ex_new
    w.check(uses_align, "the new example tw100_foreign_zscore uses align_feed")
    m, err = try_import("align", ex_new)
    fetch = getattr(m, "fetch_data", None) if m else None
    if m and fetch:
        try:
            fetch({})
            err = "fetch_data ran"
        except Exception as e:
            err = f"{type(e).__name__}: {str(e)[:120]}"
    w.note(f"new example on the old lib: {err}")
    w.check(err and ("align_feed" in err or "ImportError" in err or "cannot import" in err),
            "an align_feed strategy fails on the old lib with an import error naming it (loud, not wrong numbers)")
    m, err = try_import("exits", "from lib.exits import apply_exits\n")
    w.check(err is not None and "exits" in err, f"lib.exits on the old lib: {err}")


# ── doc enumeration ──────────────────────────────────────────────────────────

HEAD_RE = re.compile(r"^### (V\d-\d{2})\b")
HARNESS_RE = re.compile(r"^- \*\*Harness:\*\*\s*(.+)$")
VERDICT_RE = re.compile(r"^- \*\*Verdict:\*\*\s*(PASS|FAIL|NOTE|DOC)\b")


def read_doc():
    rows, cur = {}, None
    with open(DOC, encoding="utf-8") as f:
        for line in f:
            m = HEAD_RE.match(line)
            if m:
                cur = m.group(1)
                rows[cur] = {"dup": cur in rows, "harness": None, "verdict": None}
                continue
            s = line.strip()
            m = HARNESS_RE.match(s)
            if m and cur and rows[cur]["harness"] is None:
                rows[cur]["harness"] = m.group(1)
            m = VERDICT_RE.match(s)
            if m and cur and rows[cur]["verdict"] is None:
                rows[cur]["verdict"] = m.group(1)
    return rows


def enumerate_check():
    if not os.path.exists(DOC):
        return [f"doc not found: {DOC}"]
    bad, rows = [], read_doc()
    for cid, r in sorted(rows.items()):
        if r["dup"]:
            bad.append(f"{cid}: listed twice")
        if not r["harness"]:
            bad.append(f"{cid}: no '- **Harness:**' line")
        if not r["verdict"]:
            bad.append(f"{cid}: no '- **Verdict:**' line")
        if cid not in CELLS and cid not in SHELL_CELLS and not (r["harness"] or "").startswith("doc"):
            bad.append(f"{cid}: in the doc, no test here or in the .js")
        if cid in CELLS and (r["verdict"] == "FAIL") != (cid in KNOWN_BUGS):
            bad.append(f"{cid}: FAIL in the doc and KNOWN_BUGS here disagree")
    for cid in list(CELLS) + list(SHELL_CELLS):
        if cid not in rows:
            bad.append(f"{cid}: test case not in the doc")
    return bad


def resolve_old(a, base):
    if a.old_src:
        a.old_src = os.path.abspath(a.old_src)
        a.old_ref_resolved = subprocess.run(["git", "-C", a.old_src, "rev-parse", "HEAD"],
                                            capture_output=True, text=True).stdout.strip() or a.old_ref
        return
    ref = subprocess.run(["git", "-C", ROOT, "rev-parse", a.old_ref], capture_output=True,
                         text=True, check=True).stdout.strip()
    d = os.path.join(base, "old-src")
    os.makedirs(d)
    tar = subprocess.run(["git", "-C", ROOT, "archive", ref], capture_output=True, check=True).stdout
    subprocess.run(["tar", "-x", "-C", d], input=tar, check=True)
    a.old_src, a.old_ref_resolved = d, ref


def parent(a):
    bad = enumerate_check()
    print("== enumeration: doc ↔ cells")
    for b in bad:
        print("FAIL " + b)
    if not bad:
        print(f"ok   {len(CELLS)} cells here + {len(SHELL_CELLS)} in check_version_matrix_shell.js")
    ids = sorted(CELLS) if not a.only else [s.strip() for s in a.only.split(",") if s.strip()]
    unknown = [s for s in ids if s not in CELLS]
    if unknown:
        print(f"FAIL unknown cells {unknown}")
        return 1
    base = tempfile.mkdtemp(prefix="vmatrix-", dir=a.tmp or None)
    with open(os.path.join(base, "sitecustomize.py"), "w") as f:
        f.write(PS.SITECUSTOMIZE)
    resolve_old(a, base)
    a.new_src = os.path.abspath(a.new_src)
    print(f"   old = {a.old_src} ({a.old_ref_resolved[:9]})\n   new = {a.new_src}")
    ctx = Ctx(a, base)
    failed, xfail = [], []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, a.jobs)) as pool:
        futs = [pool.submit(run_cell, ctx, cid) for cid in ids]
        for fut in concurrent.futures.as_completed(futs):
            cid, rc, out, dt, ws = fut.result()
            fn, lib, rt, local, kind = CELLS[cid]
            known = cid in KNOWN_BUGS
            verdict = ("xfail (known bug)" if rc and known else "XPASS: known bug no longer "
                       "reproduces" if known else "pass" if rc == 0 else "FAIL")
            print(f"== {cid} [lib {lib} · runtime {rt}{' · desktop' if local else ''}]  {verdict}"
                  f"  ({dt:.1f}s)" + ("" if rc == 0 and not a.keep else f"  ws={ws}"))
            if rc or known or a.verbose:
                if known:
                    print(f"   known bug: {KNOWN_BUGS[cid]}")
                print("   " + out.strip().replace("\n", "\n   "))
            if rc and known:
                xfail.append(cid)
            elif rc or known:
                failed.append(cid)
    if not failed and not a.keep:
        shutil.rmtree(base, ignore_errors=True)
    print()
    print(f"{len(ids) - len(failed) - len(xfail)}/{len(ids)} cells pass"
          + (f"; known bugs reproduced: {','.join(sorted(xfail))}" if xfail else "")
          + (f"; FAILED: {','.join(sorted(failed))}" if failed else ""))
    return 1 if failed or bad else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--child")
    ap.add_argument("--phase")
    ap.add_argument("--ws")
    ap.add_argument("--rt-src")
    ap.add_argument("--lib-side")
    ap.add_argument("--rt-side")
    ap.add_argument("--old-src")
    ap.add_argument("--old-ref", default="HEAD")
    ap.add_argument("--new-src", default=ROOT)
    ap.add_argument("--tmp", help="parent dir for scratch workspaces (default: system temp)")
    ap.add_argument("--only")
    ap.add_argument("-j", "--jobs", type=int, default=4)
    ap.add_argument("--keep", action="store_true")
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args()
    if a.child:
        sys.exit(run_child(a.child, a.ws, os.path.abspath(a.rt_src), a.lib_side, a.rt_side,
                           a.phase))
    sys.exit(parent(a))


if __name__ == "__main__":
    main()
