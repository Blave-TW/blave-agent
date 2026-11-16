"""close_then_unbind (spec unbind-positions §5): close the unbound venue's positions, confirm flat,
only then drop its keys. No network, no broker, no crontab, no window.

The real manager/flatten.py runs as a child process in a scratch workspace (a copy of lib/), against
two fake venues whose positions live in sim/<venue>.json: `fakex` (crypto) and a stand-in for
統一 (`president`: same traits — hand-wired, close_needs_fill — its order and account libs swapped
for fakes that answer the way the real ones do: filled / 'sent' with ack 0000 and no fill /
a partial fill). The runtime side (command_listener) runs in this process; only the Popen of
flatten is replaced by a synchronous run of the same command line.

Each case asserts on what happened, not on source text: the keys still in .env, the request
file, the positions left on the fake venue, how many flattens started, the HALT file.

Run: cd blave-agent && python tests/check_close_then_unbind.py
"""
import atexit
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_REPO_ENV = os.path.join(ROOT, ".env")


def _no_repo_env(event, args):
    if event == "open" and args and isinstance(args[0], (str, bytes)):
        if os.path.abspath(os.fsdecode(args[0])) == _REPO_ENV:
            raise RuntimeError("test tried to open the repo .env")


sys.addaudithook(_no_repo_env)
BASE = tempfile.mkdtemp(prefix="close-unbind-")
atexit.register(shutil.rmtree, BASE, True)  # a lib/ copy per run: never left behind, even on a crash
WS = os.path.join(BASE, "workspace")
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = BASE
os.environ["BLAVE_AGENT_BASE"] = BASE
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.pop("BLAVE_AGENT_LOCAL", None)
os.environ.pop("BLAVE_TURN_INTERRUPT_FILE", None)

FAKE_ACCOUNT = '''
import json, os
def _rows():
    try:
        return json.load(open(os.path.join("sim", "{vid}.json")))
    except FileNotFoundError:
        return {{"positions": {{}}}}
def get_positions(env, book_months=None):
    rows = _rows()
    if rows.get("unreadable"):
        raise RuntimeError("snapshot unreadable")
    if {lots}:  # 統一's shape: {{root: row}}, lots, no unit field (lib/account_president)
        return {{s: {{"side": p["side"], "size": p["size"]}} for s, p in rows["positions"].items() if p["size"] > 0}}
    return [{{"symbol": s, "side": p["side"], "size": p["size"], "mark_price": 100.0}}
            for s, p in rows["positions"].items() if p["size"] > 0]
def get_account_id(env):
    return "{vid}:acct1"
def get_equity(env):
    return {{"total": 1000.0}}
'''

FAKE_ORDER = '''
import json, os
def _path():
    return os.path.join("sim", "{vid}.json")
def format_qty(env, symbol, qty, price=None):
    if float(qty) < {minimum}:
        raise ValueError("[order_reject:below_min_size] below minimum")
    return str(qty)
class SessionClosed(Exception):   # order_president's: flatten matches it by name
    from_broker = True
def close_position_partial(env, symbol, direction, qty, client_order_id=None, book_months=None):
    st = json.load(open(_path()))
    st["sent"] = st.get("sent", 0) + 1
    mode = st.get("mode", "fill")
    p = st["positions"][symbol]
    if mode == "reject":
        json.dump(st, open(_path(), "w"))
        raise RuntimeError("統一 rejected the close: statuscode=9902 尚未開始接收委託")
    if mode == "shut":
        json.dump(st, open(_path(), "w"))
        raise SessionClosed("統一 rejected the order: statuscode=9901 交易時間已結束")
    got = 0.0
    if mode == "fill":
        got = float(qty)
    elif mode == "partial":
        got = float(qty) // 2 if {lots} else float(qty) / 2
    p["size"] = round(p["size"] - got, 12)
    json.dump(st, open(_path(), "w"))
    if {lots}:
        return {{"status": "filled" if got else "sent", "executed_qty": got, "avg_price": 100.0,
                "ack": "0004" if got else "0000", "exchange": "{vid}"}}
    return {{"executed_qty": got, "avg_price": 100.0}}
'''


def build_workspace():
    if os.path.isdir(WS):
        shutil.rmtree(WS)
    for d in ("manager", "state", "sim"):
        os.makedirs(os.path.join(WS, d))
    shutil.copytree(os.path.join(ROOT, "lib"), os.path.join(WS, "lib"),
                    ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copy(os.path.join(ROOT, "manager", "flatten.py"), os.path.join(WS, "manager", "flatten.py"))
    with open(os.path.join(WS, "lib", "tw_clock.py"), "a") as f:
        # the flatten here runs only in session (the listener answers market_closed otherwise): its
        # TW futures closes must not depend on the hour the test runs
        # nor ask the real api for a clock sample (flatten's __main__ turns tw_clock.probe on)
        f.write("\n\ndef close_hold(now=None):\n    return None\n\n\ndef queued_until(now=None):\n    return None\n"
                "\n\ndef probe():\n    return False\n")
    for vid, minimum, lots in (("fakex", 0.0001, False), ("president", 1, True), ("capital", 1, True)):
        with open(os.path.join(WS, "lib", f"account_{vid}.py"), "w") as f:
            f.write(FAKE_ACCOUNT.format(vid=vid, lots=lots))
        with open(os.path.join(WS, "lib", f"order_{vid}.py"), "w") as f:
            f.write(FAKE_ORDER.format(vid=vid, minimum=minimum, lots=lots))


build_workspace()
sys.path.insert(0, WS)
sys.path.insert(0, os.path.join(ROOT, "runtime"))
import command_listener as cl  # noqa: E402
import portfolio_reporter as pr  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


ENV_LINES = {
    "fakex": ["FAKEX_API_KEY=not-a-real-key", "FAKEX_SECRET_KEY=not-a-real-secret"],
    "president": ["president_account=not-a-real-account", "president_password=not-a-real-password"],
    "capital": ["CAPITAL_API_KEY=not-a-real-id", "CAPITAL_PASSWORD=not-a-real-password"],
}
UNBIND_ENV = {"fakex": ["FAKEX_API_KEY", "FAKEX_SECRET_KEY"],
              "president": ["president_account", "president_password"],
              "capital": ["CAPITAL_API_KEY", "CAPITAL_PASSWORD"]}
SYM = {"fakex": "BTCUSDT", "president": "TXF", "capital": "TXF"}
LAUNCHES = []
RUN_FLATTEN = {"v": True}


def _fake_launch(prefix, argv=()):
    LAUNCHES.append(list(argv))
    if RUN_FLATTEN["v"]:
        r = subprocess.run([sys.executable, os.path.join(WS, "manager", "flatten.py"), *argv],
                           cwd=WS, capture_output=True, text=True, timeout=300,
                           env={**os.environ, "BLAVE_AGENT_WORKSPACE": WS})
        LOG.append(r.stdout + r.stderr)
    return prefix + "started"


LOG = []
cl._launch_flatten = _fake_launch
cl._stop_reconciler = lambda: True
cl._sync_strategy_crons = lambda names: None
cl._ON_APPLIED = cl._ON_PROGRESS = None


def path(*p):
    return os.path.join(WS, *p)


def setup(venues, ledger, positions, modes=None):
    """venues bound; ledger: the bot's book on (own positions) or the account-wide opt-out."""
    for p in ("state", "sim"):
        shutil.rmtree(path(p), ignore_errors=True)
        os.makedirs(path(p))
    for f in os.listdir(path("manager")):
        if f != "flatten.py":
            os.remove(path("manager", f))
    with open(path(".env"), "w") as f:
        f.write("\n".join(l for v in venues for l in ENV_LINES[v]) + "\n")
    seed = {"seeded_at": "2026-11-01T00:00:00", "own_only_basis": 1, "symbols": {}}
    for v in venues:
        size = positions.get(v, 0)
        json.dump({"mode": (modes or {}).get(v, "fill"),
                   "positions": {SYM[v]: {"side": "long", "size": size}} if size else {}},
                  open(path("sim", f"{v}.json"), "w"))
        if ledger and size:
            cost = size if v == "president" else size * 100.0
            seed["symbols"][f"{v}|{SYM[v]}"] = {"size": cost, "qty": size, "venue": v}
    json.dump({"self_ledger": bool(ledger), "exchanges": {}}, open(path("manager", "portfolio_config.json"), "w"))
    if ledger:
        json.dump(seed, open(path("manager", "ledger_seed.json"), "w"))
    LAUNCHES.clear()
    LOG.clear()
    cl._UNBIND_TICK.update({"next": 0.0, "probed": 0.0})


def env_has(v):
    with open(path(".env")) as f:
        txt = f.read()
    return ENV_LINES[v][0].split("=")[0] in txt


def sim_size(v):
    st = json.load(open(path("sim", f"{v}.json")))
    return st["positions"].get(SYM[v], {}).get("size", 0)


def sim_sent(v):
    return json.load(open(path("sim", f"{v}.json"))).get("sent", 0)


def marker():
    try:
        return json.load(open(path("state", "unbind_after_close.json")))
    except FileNotFoundError:
        return None


def last():
    try:
        return json.load(open(path("state", "last_flatten.json")))
    except FileNotFoundError:
        return None


def tick():
    cl._UNBIND_TICK["next"] = 0.0
    return cl.unbind_after_close_tick()


def send(v, rid=None):
    args = {"env": sum((UNBIND_ENV[x] for x in v.split("+")), [])}
    if rid:
        args["request_id"] = rid
    return cl.dispatch({"cmd": "close_then_unbind", "args": args})


IN_SESSION = {"v": True}


def _session_stub():
    import lib.tw_clock as tc
    tc.in_session = lambda ts: IN_SESSION["v"]


cl._in_workspace(_session_stub)

for ledger in (False, True):
    mode = "帳本模式" if ledger else "帳戶模式"
    for v, n in (("fakex", 0.002), ("president", 2)):
        # ── full fill → unbound ─────────────────────────────────────────────
        setup([v], ledger, {v: n})
        ack = send(v)
        check(ack == "close_then_unbind=started" and len(LAUNCHES) == 1
              and LAUNCHES[0][:2] == ["--venues", v],
              f"{mode} {v}: 有部位 → 起一個只平這家的 flatten ({ack}, {LAUNCHES})")
        lf = last() or {}
        check(lf.get("ok") is True and lf.get("done_at") and lf.get("request_id") == marker().get("request_id")
              and sim_size(v) == 0 and env_has(v),
              f"{mode} {v}: flatten 寫出結果、部位歸零;還沒 tick 前金鑰還在 ({lf}, {LOG[-1][-400:] if LOG else ''})")
        r = tick()
        check(not env_has(v) and marker() is None and str(r).startswith("credentials_remove="),
              f"{mode} {v}: 全部成交且重讀歸零 → 刪金鑰、清請求檔 ({r})")
        check(send(v) == "close_then_unbind=not_bound" and len(LAUNCHES) == 1,
              f"{mode} {v}: 解除後重送 → not_bound,不再平")

        # ── partial fill → held ─────────────────────────────────────────────
        setup([v], ledger, {v: n * 2 if v == "president" else n}, {v: "partial"})
        ack = send(v)
        r = tick()
        lf = last() or {}
        un = lf.get("unclosed") or []
        check(ack.endswith("started") and env_has(v) and (marker() or {}).get("held") is True
              and (marker() or {}).get("why") == "unclosed"
              and [u.get("key") for u in un] == [SYM[v]] and un[0].get("why") == "partial"
              and sim_size(v) > 0,
              f"{mode} {v}: 部分成交 → 停住、金鑰保留、unclosed 列出原因 partial ({r}, {lf})")
        check(os.path.exists(path("state", "HALT")), f"{mode} {v}: 停住時暫停維持")
        # a retry after the held one: a new request goes out, closes the rest, unbinds
        json.dump({**json.load(open(path("sim", f"{v}.json"))), "mode": "fill"}, open(path("sim", f"{v}.json"), "w"))
        ack = send(v)
        r = tick()
        check(ack.endswith("started") and len(LAUNCHES) == 2 and not env_has(v) and sim_size(v) == 0,
              f"{mode} {v}: 停住後再平一次(新請求)→ 平完才解除 ({ack}, {r})")

    # ── 統一 0000 with no fill = unconfirmed → held, and no second flatten ──
    setup(["president"], ledger, {"president": 2}, {"president": "sent"})
    ack = send("president", "rq1")
    r = tick()
    lf = last() or {}
    check(ack.endswith("started") and lf.get("unconfirmed") == ["TXF"] and not lf.get("unclosed")
          and (marker() or {}).get("why") == "unconfirmed" and env_has("president"),
          f"{mode} 統一: 送出但沒回報成交(0000)→ 未確認、擋住解除 ({r}, {lf})")
    check(send("president", "rq1") == "close_then_unbind=held" and len(LAUNCHES) == 1,
          f"{mode} 統一: 同一請求重送 → held,不再平")
    check(send("president", "rq2") == "close_then_unbind=unconfirmed" and len(LAUNCHES) == 1,
          f"{mode} 統一: 有未確認時新請求也不起 flatten(群益自動新平倉會反手)")
    # 「自己處理並解除」 = the old command, unchanged; it clears the waiting request
    r = cl.dispatch({"cmd": "credentials_remove", "args": {"env": UNBIND_ENV["president"]}})
    check(r.startswith("credentials_remove=") and not env_has("president") and marker() is None,
          f"{mode} 統一: 停住後送舊的 credentials_remove → 照舊解除、清掉請求檔")

    check(lf.get("reply") is None, f"{mode} 統一: 未確認時沒有「券商回覆」(那是我們自己的逾時,不是統一回的)({lf.get('reply')!r})")
    # a broker refusal: its own words travel as `reply`, apart from our own reason (`msg`)
    setup(["president"], ledger, {"president": 2}, {"president": "reject"})
    send("president")
    tick()
    lf = last() or {}
    un = lf.get("unclosed") or [{}]
    check(lf.get("reply") == "尚未開始接收委託" and un[0].get("reply") == "尚未開始接收委託"
          and "statuscode" not in (lf.get("reply") or "") and env_has("president"),
          f"{mode} 統一: 券商拒單 → reply 只放統一回的那句,沒平、不解除 ({lf})")

    # ── market closed (Wei 11-15): sent anyway; 統一's refusal holds the unbind, the keys stay ──
    setup(["president"], ledger, {"president": 2}, {"president": "shut"})
    IN_SESSION["v"] = False
    ack = send("president")
    r = tick()
    IN_SESSION["v"] = True
    lf = last() or {}
    un = lf.get("unclosed") or [{}]
    check(ack == "close_then_unbind=started" and len(LAUNCHES) == 1 and sim_sent("president") == 1
          and env_has("president") and sim_size("president") == 2
          and (marker() or {}).get("held") is True and un[0].get("why") == "market_closed"
          and lf.get("reply") == "交易時間已結束" and lf.get("ok") is False,
          f"{mode} 統一: 休市 → 照送一次,統一拒單 → 平倉失敗停住、金鑰不刪 ({ack}, {r}, {lf})")
    # Wei 11-16: not paused before the press → the HALT this press wrote is lifted, strategies trade on
    check(not os.path.exists(path("state", "HALT")) and (marker() or {}).get("halt_lifted") is True
          and cl._in_workspace(lambda: __import__("lib.guard", fromlist=["x"]).halted()) is False
          and '"source": "close_then_unbind"' in open(path("state", "audit.jsonl")).read(),
          f"{mode} 統一: 休市被拒、按之前沒暫停 → 撤回這次的 HALT(檔案與記憶體旗標),稽核留一行 ({marker()})")
    rows = json.load(open(path("manager", "order_errors.json")))
    check([r["symbol"] for r in rows] == ["TXF"] and "沒有解除連接" in rows[0]["error"]
          and "沒有停損" not in rows[0]["error"] and "[order_reject:market_closed]" in rows[0]["error"]
          and rows[0].get("halt_lifted") is True and "kind" not in rows[0],
          f"{mode} 統一: 這種拒單列(P1 內文)不講「沒有停損」,講還沒解除連接,帶 halt_lifted、沒有 kind ({rows})")
    r = tick()
    check(sim_sent("president") == 1 and env_has("president") and len(LAUNCHES) == 1
          and not os.path.exists(path("state", "HALT")),
          f"{mode} 統一: 停住之後不自己重送、不自己解除、不再掛暫停 ({r})")
    # already paused before the press: that pause stands, whatever its reason
    for prior in ({"ts": "2026-11-16T00:00:00+00:00", "reason": "user request", "source": "web"},
                  {"ts": "2026-11-16T00:00:00+00:00", "reason": "close all positions", "source": "web",
                   "closing": True, "close_id": "ca1", "already_halted": False}):
        setup(["president"], ledger, {"president": 2}, {"president": "shut"})
        json.dump(prior, open(path("state", "HALT"), "w"))
        IN_SESSION["v"] = False
        send("president")
        tick()
        IN_SESSION["v"] = True
        halt = json.load(open(path("state", "HALT"))) if os.path.exists(path("state", "HALT")) else None
        check(halt is not None and halt.get("reason") == prior["reason"] and halt.get("ts") == prior["ts"]
              and "halt_own" not in (marker() or {}) and not (marker() or {}).get("halt_lifted")
              and (marker() or {}).get("held") is True and env_has("president"),
              f"{mode} 統一: 按之前已暫停({prior['reason']})→ 休市被拒照留暫停、金鑰不刪 ({halt}, {marker()})")
        rows = json.load(open(path("manager", "order_errors.json")))
        check([r["symbol"] for r in rows] == ["TXF"] and "沒有停損" in rows[0]["error"] and "halt_lifted" not in rows[0],
              f"{mode} 統一: 按之前已暫停 → 拒單列照講「沒有停損」 ({rows})")
    # a HALT rewritten after the press is someone else's: never lifted
    def _foreign(h):
        return [dict(h, reason="exchange unbound (x)", source="web"),          # another stop took its place
                dict(h, source="reconciler"),                                    # same words, another writer
                dict(h, close_id="ca999", already_halted=True),                  # 暫停並關閉部位 pressed meanwhile
                dict(h, ts="2026-11-16T00:00:01+00:00"),                         # a new stop with the same words
                dict(h, unexplained=[{"park_id": "p1"}]),                        # an unexplained fill annotated on it
                dict(h, mismatch={"venue": "president"})]
    RUN_FLATTEN["v"] = True
    for i in range(6):
        setup(["president"], ledger, {"president": 2}, {"president": "shut"})
        IN_SESSION["v"] = False
        send("president")
        IN_SESSION["v"] = True
        own = json.load(open(path("state", "HALT")))
        bad = _foreign(own)[i]
        json.dump(bad, open(path("state", "HALT"), "w"))
        tick()
        check(os.path.exists(path("state", "HALT")) and json.load(open(path("state", "HALT"))) == bad
              and (marker() or {}).get("held") is True and not (marker() or {}).get("halt_lifted"),
              f"{mode} 統一: 休市被拒但 HALT 已不是這次那份({sorted(set(bad.items()) ^ set(own.items()), key=str) if all(not isinstance(v, (list, dict)) for v in bad.values()) else 'annotated'})→ 不撤")
        # audit 0.1.55 M2: the flag and the lifted sentence only when the HALT really went
        rows = json.load(open(path("manager", "order_errors.json")))
        check([r["symbol"] for r in rows] == ["TXF"] and "halt_lifted" not in rows[0]
              and "沒有停損" in rows[0]["error"] and "沒有解除連接" not in rows[0]["error"],
              f"{mode} 統一: HALT 沒撤 → 拒單列不帶 halt_lifted、照講「沒有停損」(真帳戶 P1) ({rows})")
    # Windows: a reader holding HALT through every retry — not lifted, the row says paused
    setup(["president"], ledger, {"president": 2}, {"president": "shut"})
    IN_SESSION["v"] = False
    send("president")
    IN_SESSION["v"] = True
    real_replace = cl.atomic_file.replace_retry
    tries = []

    def _held_open(src, dst):
        if not src.endswith(os.sep + "HALT"):
            return real_replace(src, dst)
        tries.append(src)
        raise PermissionError(13, "in use")
    cl.atomic_file.replace_retry = _held_open
    try:
        tick()
    finally:
        cl.atomic_file.replace_retry = real_replace
    rows = json.load(open(path("manager", "order_errors.json")))
    check(tries and os.path.exists(path("state", "HALT")) and (marker() or {}).get("held") is True
          and not (marker() or {}).get("halt_lifted")
          and "halt_lifted" not in rows[0] and "沒有停損" in rows[0]["error"],
          f"{mode} 統一: 撤 HALT 時搬不動(Windows 有人在讀)→ 暫停照留、拒單列照講「沒有停損」 ({tries}, {rows})")
    # rewritten between the check and the move: the moved file is judged again and put back
    setup(["president"], ledger, {"president": 2}, {"president": "shut"})
    IN_SESSION["v"] = False
    send("president")
    IN_SESSION["v"] = True
    own = json.load(open(path("state", "HALT")))
    bad = dict(own, reason="user request")
    json.dump(bad, open(path("state", "HALT"), "w"))
    real_load = cl.atomic_file.load_json
    stale = {"n": 0}

    def _stale_read(p, *a, **k):
        if p.endswith(os.sep + "HALT") and not stale["n"]:
            stale["n"] += 1
            return dict(own)   # the read before the 暫停 landed
        return real_load(p, *a, **k)
    cl.atomic_file.load_json = _stale_read
    try:
        tick()
    finally:
        cl.atomic_file.load_json = real_load
    check(stale["n"] == 1 and os.path.exists(path("state", "HALT")) and json.load(open(path("state", "HALT"))) == bad
          and not [f for f in os.listdir(path("state")) if f.startswith("HALT.lift")]
          and not (marker() or {}).get("halt_lifted"),
          f"{mode} 統一: 檢查後、搬開前被換掉的 HALT → 搬回原處、不撤、不留暫存檔 ({os.listdir(path('state'))})")
    # partial: another venue in the same request closed, 統一 refused → keys kept for both, own HALT lifted
    setup(["fakex", "president"], ledger, {"fakex": 0.002, "president": 2}, {"president": "shut"})
    IN_SESSION["v"] = False
    send("fakex+president")
    tick()
    IN_SESSION["v"] = True
    lf = last() or {}
    check(sim_size("fakex") == 0 and sim_size("president") == 2 and env_has("fakex") and env_has("president")
          and (marker() or {}).get("held") is True and not os.path.exists(path("state", "HALT"))
          and (marker() or {}).get("halt_lifted") is True
          and [u.get("why") for u in lf.get("unclosed") or []] == ["market_closed"]
          and [r.get("halt_lifted") for r in json.load(open(path("manager", "order_errors.json")))] == [True],
          f"{mode} 部分平掉(加密已平、統一休市被拒)→ 兩家金鑰都留、不解除,撤回自己的 HALT,拒單列帶 halt_lifted ({lf}, {marker()})")
    # partial with another kind of failure left: the pause stays, as before
    setup(["fakex", "president"], ledger, {"fakex": 0.002, "president": 2}, {"fakex": "reject", "president": "shut"})
    IN_SESSION["v"] = False
    send("fakex+president")
    tick()
    IN_SESSION["v"] = True
    lf = last() or {}
    check(env_has("fakex") and env_has("president") and (marker() or {}).get("held") is True
          and os.path.exists(path("state", "HALT")) and not (marker() or {}).get("halt_lifted")
          and sorted(u.get("why") for u in lf.get("unclosed") or []) != ["market_closed"] * len(lf.get("unclosed") or []),
          f"{mode} 休市被拒加上別的失敗(加密拒單)→ 暫停照留 ({lf.get('unclosed')})")
    rows = [r for r in json.load(open(path("manager", "order_errors.json"))) if r.get("symbol") == "TXF"]
    check(len(rows) == 1 and "沒有停損" in rows[0]["error"] and "halt_lifted" not in rows[0],
          f"{mode} 休市被拒加上別的失敗 → 台指期那列照講「沒有停損」、不帶 halt_lifted ({rows})")
    # 群益 (Wei 11-16): flatten words its refusal in a shut session as market_closed (tests/check_txf_close_or_fail.py;
    # its identity check needs Windows, so this Mac runs no 群益 flatten) — the lift reads only last_flatten, so a
    # 群益 market_closed lifts and a 群益 plain failure keeps the pause
    for why, lifts in (("market_closed", True), ("error", False)):
        setup(["president"], ledger, {"president": 2}, {"president": "shut"})
        IN_SESSION["v"] = False
        RUN_FLATTEN["v"] = True
        send("president")
        IN_SESSION["v"] = True
        lf = last()
        lf["venues"] = ["capital"]
        lf["unclosed"] = [{"key": "TMF", "venue": "capital", "why": why, "msg": "", "reply": None}]
        json.dump(lf, open(path("state", "last_flatten.json"), "w"))
        tick()
        check(os.path.exists(path("state", "HALT")) is not lifts and bool((marker() or {}).get("halt_lifted")) is lifts
              and (marker() or {}).get("held") is True and env_has("president"),
              f"{mode} 群益 {why} → {'撤回自己的 HALT' if lifts else '暫停照留'}、金鑰不刪 ({marker()})")
    # a workspace whose flatten.py still defers to the open (0.1.53): the listener refuses here instead
    setup(["president"], ledger, {"president": 2})
    fl = path("manager", "flatten.py")
    src = open(fl, encoding="utf-8").read()
    with open(fl, "w", encoding="utf-8") as f:
        f.write(src.replace("def _refuse_tw_futures(", "def _refuse_tw_futures_renamed("))
    IN_SESSION["v"] = False
    try:
        ack = send("president")
    finally:
        IN_SESSION["v"] = True
        with open(fl, "w", encoding="utf-8") as f:
            f.write(src)
    check(ack == "close_then_unbind=market_closed" and not LAUNCHES and marker() is None
          and not os.path.exists(path("state", "HALT")) and env_has("president") and sim_size("president") == 2,
          f"{mode} 統一: 舊 flatten(會延到開盤)休市 → market_closed,不送單、不暫停、不刪金鑰 ({ack})")
    setup(["fakex"], ledger, {"fakex": 0.002})
    IN_SESSION["v"] = False
    ack = send("fakex")
    IN_SESSION["v"] = True
    check(ack.endswith("started"), f"{mode} 加密: 台指期休市不影響加密的平倉 ({ack})")

# ── 群益 this identity can't trade (never on this OS: the identity test needs Windows) ──
check(cl._manual_venues({"capital", "fakex"}) == {"capital"}, "這個身分平不了群益(測試機不是 Windows)")
for ledger in (False, True):
    mode = "帳本模式" if ledger else "帳戶模式"
    # mixed: the closable venue closes, 群益 is kept, both unbind together once the first is flat
    setup(["fakex", "capital"], ledger, {"fakex": 0.002, "capital": 3})
    ack = send("fakex+capital")
    m = marker() or {}
    view = pr.unbind_after_close_view() or {}
    check(ack.endswith("started") and len(LAUNCHES) == 1 and LAUNCHES[0][:2] == ["--venues", "fakex"]
          and m.get("manual") == ["capital"] and view.get("manual") == ["capital"]
          and view.get("closing") == ["fakex"] and view.get("venues") == ["capital", "fakex"],
          f"{mode} 混合(加密＋群益):只平加密,群益記成保留,報告看得出來 ({ack}, {LAUNCHES}, {view})")
    r = tick()
    check(not env_has("fakex") and not env_has("capital") and marker() is None
          and sim_size("fakex") == 0 and sim_size("capital") == 3,
          f"{mode} 混合:加密平完歸零 → 兩家一次解除,群益部位留在帳上 ({r})")
    # the kept 群益's TXF out of session does not hold back the crypto close
    setup(["fakex", "capital"], ledger, {"fakex": 0.002, "capital": 3})
    IN_SESSION["v"] = False
    ack = send("fakex+capital")
    IN_SESSION["v"] = True
    check(ack.endswith("started") and LAUNCHES and LAUNCHES[0][:2] == ["--venues", "fakex"],
          f"{mode} 混合:休市只看要平的那幾家,保留的群益台指期不擋 ({ack})")
    # mixed, the closable one doesn't fill: held, neither unbinds
    setup(["fakex", "capital"], ledger, {"fakex": 0.002, "capital": 3}, {"fakex": "partial"})
    send("fakex+capital")
    r = tick()
    check(env_has("fakex") and env_has("capital") and (marker() or {}).get("held") is True,
          f"{mode} 混合:加密沒平完 → 停住,兩家都不解除 ({r})")
    # 群益 alone: nothing to close here → keep-and-unbind only
    setup(["capital"], ledger, {"capital": 3})
    ack = send("capital")
    check(ack == "close_then_unbind=capital_manual" and not LAUNCHES and marker() is None
          and env_has("capital") and not os.path.exists(path("state", "HALT")),
          f"{mode} 只綁群益且平不了 → capital_manual,不送單、不暫停、不刪金鑰 ({ack})")
vens = {"fakex": {"account": True, "order": True}, "capital": {"account": True, "order": True}}
check(pr.manual_close_venues(vens) == ["capital"] and pr.manual_close_venues({"fakex": {}}) == [],
      "報告 close_unbind_manual:綁著、這台平不了的那幾家")

# ── idempotent while running ─────────────────────────────────────────────────
setup(["fakex"], True, {"fakex": 0.002})
RUN_FLATTEN["v"] = False
a1 = send("fakex", "one")
a2 = send("fakex", "two")
check(a1.endswith("started") and a2 == "close_then_unbind=already_running" and len(LAUNCHES) == 1
      and (marker() or {}).get("request_id") == "one",
      f"進行中重送 → already_running,只起一個 flatten ({a1}, {a2})")
check(tick() is None and env_has("fakex") and (marker() or {}).get("held") is False,
      "flatten 還沒寫結果 → tick 不動作、不解除")
try:
    cl.dispatch({"cmd": "credentials_remove", "args": {"env": UNBIND_ENV["fakex"]}})
    refused = False
except RuntimeError:
    refused = True
check(refused and env_has("fakex") and (marker() or {}).get("held") is False,
      "平倉後解除進行中送 credentials_remove(另一個表面)→ 拒絕,金鑰與請求都還在")
m = marker()
m["at"] -= cl._UNBIND_START_GRACE_S + 1
json.dump(m, open(path("state", "unbind_after_close.json"), "w"))
r = tick()
check((marker() or {}).get("why") == "not_started" and env_has("fakex"),
      f"等不到 flatten 開跑 → 停住(not_started)、不解除 ({r})")
RUN_FLATTEN["v"] = True

# ── the stop must stand from close to unbind (closeout3 S2) ──────────────────
setup(["fakex"], True, {"fakex": 0.002})
RUN_FLATTEN["v"] = False
send("fakex", "rs1")
RUN_FLATTEN["v"] = True
try:
    cl.dispatch({"cmd": "resume", "args": {}})
    refused = False
except RuntimeError:
    refused = True
check(refused and os.path.exists(path("state", "HALT")) and (marker() or {}).get("halt_ts") is not None,
      "平倉後解除進行中送整機 resume → 拒絕,暫停原樣留著(請求記下它站在哪一個 HALT 上)")


def run_flatten(*argv):
    subprocess.run([sys.executable, path("manager", "flatten.py"), *argv], cwd=WS, capture_output=True, text=True,
                   timeout=300, env={**os.environ, "BLAVE_AGENT_WORKSPACE": WS})


run_flatten("--venues", "fakex", "--request-id", "rs1")
os.remove(path("state", "HALT"))   # a resume that got past the listener (an older surface, a hand edit)
st = json.load(open(path("sim", "fakex.json")))
st["positions"]["BTCUSDT"] = {"side": "long", "size": 0.002}   # …and the round kicked after the flatten re-opened it
json.dump(st, open(path("sim", "fakex.json"), "w"))
r = tick()
check(env_has("fakex") and (marker() or {}).get("why") == "resumed" and sim_size("fakex") == 0.002,
      f"flatten 平完之後暫停被拿掉(那一輪可能把部位開回來)→ 不刪金鑰、停住(resumed) ({r})")
setup(["fakex"], True, {"fakex": 0.002})
send("fakex", "rs2")
import time as _t
_t.sleep(0.01)
cl._in_workspace(lambda: __import__("lib.guard", fromlist=["trip_halt"]).trip_halt("user request", "web"))
r = tick()
check(env_has("fakex") and (marker() or {}).get("why") == "resumed",
      f"中途解除又重新暫停(HALT 換了一份)→ 一樣不刪金鑰 ({r})")

# ── a --venues the flatten can't match closes nothing → never ok (closeout3 S1) ──
setup(["fakex"], False, {"fakex": 0.002})
RUN_FLATTEN["v"] = False
send("fakex", "sc1")
RUN_FLATTEN["v"] = True
run_flatten("--venues", "zzz", "--request-id", "sc1")
lf = last() or {}
r = tick()
check(lf.get("ok") is False and [u.get("why") for u in lf.get("unclosed") or []] == ["unread"]
      and env_has("fakex") and sim_size("fakex") == 0.002 and (marker() or {}).get("held") is True,
      f"--venues 一家都沒對上(稽核情境:部位 0.002 還在)→ ok=false、unread,金鑰不刪 ({r}, {lf})")
setup(["fakex"], True, {"fakex": 0.002})
RUN_FLATTEN["v"] = False
send("fakex", "sc2")
RUN_FLATTEN["v"] = True
run_flatten("--venues", "fakex,zzz", "--request-id", "sc2")
lf = last() or {}
tick()
check(lf.get("ok") is False and env_has("fakex") and any(u.get("venue") == "zzz" and u.get("why") == "unread" for u in lf.get("unclosed") or []),
      f"範圍裡有一家沒讀到(其他家平完了)→ 一樣不算平完、不解除 ({lf})")

# ── a result that is someone else's never unbinds ────────────────────────────
setup(["fakex"], True, {"fakex": 0.002})
RUN_FLATTEN["v"] = False
send("fakex", "mine")
RUN_FLATTEN["v"] = True
json.dump({"request_id": "theirs", "done_at": 1.0, "ok": True, "closed": [], "unclosed": [], "unconfirmed": []},
          open(path("state", "last_flatten.json"), "w"))
check(tick() is None and env_has("fakex"), "別的平倉的結果(request_id 不符)→ 不解除")
json.dump({"request_id": "mine", "started_at": 1.0, "done_at": None, "ok": None,
           "closed": [], "unclosed": [], "unconfirmed": []}, open(path("state", "last_flatten.json"), "w"))
r = tick()
check((marker() or {}).get("why") == "interrupted" and env_has("fakex"),
      f"flatten 中途死掉(結果停在跑、鎖已放)→ 停住(interrupted) ({r})")

# ── only the unbound venue is closed ─────────────────────────────────────────
setup(["fakex", "president"], True, {"fakex": 0.002, "president": 2})
send("fakex")
r = tick()
check(not env_has("fakex") and env_has("president") and sim_size("president") == 2 and sim_size("fakex") == 0,
      f"兩家綁著只解一家 → 只平那一家,另一家部位與金鑰不動 ({r})")

# ── no positions: closes nothing, unbinds ────────────────────────────────────
setup(["fakex"], False, {})
ack = send("fakex")
r = tick()
check(ack.endswith("started") and not env_has("fakex"), f"沒部位 → 平零筆、照樣解除 ({ack}, {r})")

# ── a run with an error but no key named (no book baseline yet: nothing closed) → held ──
setup(["fakex"], True, {"fakex": 0.002})
os.remove(path("manager", "ledger_seed.json"))
send("fakex")
r = tick()
lf = last() or {}
check(env_has("fakex") and sim_size("fakex") == 0.002 and lf.get("ok") is False and not lf.get("unclosed")
      and (marker() or {}).get("why") == "error" and lf.get("msg"),
      f"帳本還沒基準(一筆都沒平、也沒列出標的)→ 結果 ok=false,停住(error)、不解除 ({r}, {lf})")

# ── account re-read still shows it (dust left on the account) → held ─────────
setup(["fakex"], False, {"fakex": 0.00005})
send("fakex")
r = tick()
lf = last() or {}
check(env_has("fakex") and [u.get("why") for u in lf.get("unclosed") or []] == ["still_open"],
      f"帳戶模式:重讀還有部位(低於最小量)→ still_open、不解除 ({lf})")

# ── the unbind itself fails after the keys are gone → not shown as held ──────
setup(["fakex"], False, {"fakex": 0.002})
send("fakex")


def _boom():
    raise RuntimeError("reconciler stop failed")


cl._stop_reconciler = _boom
r = tick()
cl._stop_reconciler = lambda: True
check(not env_has("fakex") and marker() is None and str(r).startswith("unbound_with_error"),
      f"解除途中後段失敗、金鑰已刪 → 清掉請求、不標停住(畫面不會說金鑰還在)({r})")

# ── an older workspace flatten (no scope / no result) is never used ─────────
setup(["fakex"], False, {"fakex": 0.002})
src = open(path("manager", "flatten.py"), encoding="utf-8").read()
open(path("manager", "flatten.py"), "w", encoding="utf-8").write(src.replace("last_flatten.json", "x.json"))
ack = send("fakex")
check(ack == "close_then_unbind=unsupported" and not LAUNCHES and env_has("fakex")
      and not os.path.exists(path("state", "HALT")),
      f"舊 flatten.py → unsupported,什麼都不做 ({ack})")
vens = {"fakex": {"account": True, "order": True}}
check(pr.can_close_unbind(vens) is False, "…報告的 can_close_unbind 同一判準 → false")
open(path("manager", "flatten.py"), "w", encoding="utf-8").write(src)
check(pr.can_close_unbind(vens) is True, "新 flatten.py → can_close_unbind true")

# ── report fields ────────────────────────────────────────────────────────────
ts = pr.txf_session()
check(isinstance(ts, dict) and isinstance(ts.get("open"), bool)
      and (ts["open"] or isinstance(ts.get("next_open"), int)), f"txf_session 形狀 ({ts})")
# Saturday 12:00 Taipei: closed, next open Monday 08:45:05
sat = 1794628800.0  # 2026-11-14 (Sat) 12:00 Taipei
ts = pr.txf_session(sat)
check(ts == {"open": False, "next_open": 1794789905}, f"週六 → 休市、下次開盤週一 08:45 ({ts})")
setup(["fakex"], False, {"fakex": 0.002})
RUN_FLATTEN["v"] = False
send("fakex", "view")
RUN_FLATTEN["v"] = True
v = pr.unbind_after_close_view()
check(v and v.get("held") is False and v.get("venues") == ["fakex"] and "env" not in v,
      f"unbind_after_close 報告欄位(不帶 env 名稱清單)({v})")

# ── the old shell's command is unchanged ─────────────────────────────────────
setup(["fakex"], False, {"fakex": 0.002})
r = cl.dispatch({"cmd": "credentials_remove", "args": {"env": UNBIND_ENV["fakex"]}})
check(r.startswith("credentials_remove=") and not env_has("fakex") and sim_size("fakex") == 0.002
      and not LAUNCHES, "舊指令 credentials_remove:照舊只刪金鑰,不平倉")

# ── clear_book (Wei 2026-11-06): the page decides; the request carries it to its own finish ──
def _reset_of(v):
    try:
        return (json.load(open(path("manager", "ledger_seed.json"))).get("venue_reset") or {}).get(v)
    except FileNotFoundError:
        return None


for flag in (True, False):
    setup(["fakex"], True, {"fakex": 0.002})
    args = {"env": UNBIND_ENV["fakex"], **({"clear_book": True} if flag else {})}
    ack = cl.dispatch({"cmd": "close_then_unbind", "args": args})
    held_flag = (marker() or {}).get("clear_book")
    r = tick()
    check(ack.endswith("started") and str(r).startswith("credentials_remove=") and not env_has("fakex")
          and held_flag is (True if flag else None) and bool(_reset_of("fakex")) is flag,
          f"close_then_unbind {'帶' if flag else '不帶'} clear_book:請求檔{'記著' if flag else '沒有'}旗標,"
          f"平完解除時{'清' if flag else '不清'}這一家的帳本 ({ack}, {r}, {held_flag}, {_reset_of('fakex')})")

# every close_all press: one close_id on the HALT it writes and in the flatten's last_flatten.json (a page
# pairs the two without a time window); already_halted = pressed while already paused
setup(["fakex"], True, {"fakex": 0.002})
ids = []
for want_already in (False, True):
    LAUNCHES.clear()
    ack = cl.dispatch({"cmd": "close_all", "args": {}})
    halt = json.load(open(path("state", "HALT")))
    last = json.load(open(path("state", "last_flatten.json")))
    cid = halt.get("close_id")
    ids.append(cid)
    check(ack == "close_all=started" and isinstance(cid, str) and cid.startswith("ca")
          and halt.get("already_halted") is want_already and halt.get("closing") is True
          and LAUNCHES and LAUNCHES[0][-2:] == ["--close-id", cid] and last.get("close_id") == cid,
          f"close_all {'on a paused page' if want_already else 'from running'}: HALT close_id == last_flatten "
          f"close_id, already_halted {want_already} ({ack}, {halt}, {last.get('close_id')}, {LAUNCHES})")
    _t.sleep(0.01)
check(len(set(ids)) == 2, f"each press its own close_id ({ids})")
# audit P2-3: pressed under an automatic pause, the HALT keeps everything it said (reason, source, ts,
# mismatch, unexplained) — only this press's close_id / already_halted are added
setup(["fakex"], True, {"fakex": 0.002})
auto = {"ts": "2026-11-14T01:00:00+00:00", "reason": "account mismatch", "source": "reconciler",
        "mismatch": {"kind": "bitget_mode_mismatch", "venue": "bitget"},
        "unexplained": [{"park_id": "p1", "reason": "x"}]}
json.dump(auto, open(path("state", "HALT"), "w"))
LAUNCHES.clear()
ack = cl.dispatch({"cmd": "close_all", "args": {}})
halt = json.load(open(path("state", "HALT")))
cid = halt.get("close_id")
check(ack == "close_all=started" and {k: halt.get(k) for k in auto} == auto and halt.get("already_halted") is True
      and "closing" not in halt and isinstance(cid, str) and LAUNCHES and LAUNCHES[0][-2:] == ["--close-id", cid],
      f"close_all on an automatic pause: the HALT's own fields are kept, close_id / already_halted added ({halt})")
# audit P3-1: a press while a flatten is still running launches nothing — the HALT names the running one's
# close_id, so the page waits for that flatten, not for one that never comes
json.dump({"close_id": "carunning", "done_at": None, "started_at": _t.time()}, open(path("state", "last_flatten.json"), "w"))
_real_launch = cl._close_all_launch
cl._close_all_launch = lambda prefix, *a, **k: prefix + "already_running"
ack = cl.dispatch({"cmd": "close_all", "args": {}})
cl._close_all_launch = _real_launch
halt = json.load(open(path("state", "HALT")))
check(ack == "close_all=already_running" and halt.get("close_id") == "carunning"
      and halt.get("reason") == auto["reason"],
      f"already_running: the HALT's close_id is the running flatten's ({ack}, {halt})")

print(f"\n{fails} FAIL" if fails else "\nALL PASS")
sys.exit(1 if fails else 0)
