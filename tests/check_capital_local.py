"""群益 on the desktop app (runtime/capital_local.py + lib/capital_vault's in-memory path + the
local_daemon / command_listener wiring) — no network, no broker, no Windows, no COM.

  1. seal: a bundle sealed by shell/capital_local.js (node) opens here; 統一's key does not open it,
     a flipped byte / garbage → SEAL_INVALID
  2. shape: the ID is 身分證 / 居留證 format, the password 1–64 chars without a line break
  3. bind: .env gets exactly the two sentinels (empty id, vault:<fingerprint>), the real values stay
     in memory only (no vault file); a 群益 write that did not come from this step is refused
  4. the lib: a child with the line resolves id + password from it; a line from another binding
     (fingerprint mismatch) or none at all never logs in; the cloud vault path is unchanged
  5. the reconciler's one line carries both venues' keys; each vault picks only its own
  6. probe: the worker's --once result → the status' probe section; 300 blocks these credentials,
     the next probe is refused (PW_RECHECK_NEEDED) until a new password is bound; 307 + after_unlock
     grants the one retry
  7. worker: never restarted after a refused login (exit 3), restarted otherwise; local_tick marks it
     LOGIN_FAILED:<state>; capital_worker exits 3 only on the desktop
  8. unbind: worker stopped, secrets dropped, probe / worker sections back to idle
  9. dispatch: refused off the desktop and off Windows; capital_local is a local-only daemon command
 10. setup: a zip member that climbs out of the extraction dir is refused

Run: cd blave-agent && /usr/bin/python3 tests/check_capital_local.py  (needs `cryptography` and node)
"""
import base64
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest.mock as um
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = tempfile.mkdtemp(prefix="capllocal-")
WS = os.path.join(BASE, "workspace")
for d in ("lib", "state", "manager"):
    os.makedirs(os.path.join(WS, d))
with open(os.path.join(WS, "manager", "portfolio_config.json"), "w") as f:
    f.write("{}")
for name in ("capital_vault.py", "capital_worker.py", "order_capital.py", "president_vault.py", "guard.py",
             "winreplace.py", "__init__.py"):
    src = os.path.join(ROOT, "lib", name)
    if os.path.exists(src):
        shutil.copy(src, os.path.join(WS, "lib"))
os.environ["BLAVE_AGENT_BASE"] = BASE
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ["BLAVE_AGENT_LOCAL"] = "1"
sys.path.insert(0, os.path.join(ROOT, "runtime"))
sys.path.insert(0, WS)
os.chdir(WS)
import capital_connect as cc  # noqa: E402
import capital_local as capl  # noqa: E402
import command_listener as cl  # noqa: E402
import local_daemon as ld  # noqa: E402
import president_connect as pc  # noqa: E402

cl._sync_strategy_crons = lambda names: None
fails = []


def check(name, cond, detail=""):
    print(("ok   " if cond else "FAIL ") + name + ("" if cond else f"  {detail}"))
    if not cond:
        fails.append(name)


def code_of(fn):
    try:
        fn()
    except Exception as e:
        return str(e).split(":", 1)[0]
    return None


try:
    cc._crypto()
except ValueError:
    print("SKIP  cryptography not installed in this python (run with /usr/bin/python3)")
    sys.exit(0)

SECRET = "e" * 64
capl.set_seal_key(SECRET)
pc.set_seal_key(SECRET)
NODE = shutil.which("node")
ID, PW = "A123456789", "trade-pw"


def node_seal(obj, module="capital_local"):
    js = (f"const L=require({json.dumps(os.path.join(ROOT, 'shell', module + '.js'))});"
          f"process.stdout.write(L.sealFor({json.dumps(SECRET)}, {json.dumps(obj)}))")
    return subprocess.run([NODE, "-e", js], capture_output=True, text=True, timeout=60).stdout


# 1. seal
if NODE:
    blob = node_seal({"id": ID, "pw": PW})
    check("1 node 封的那包這裡打得開", capl.open_sealed(blob) == {"id": ID, "pw": PW})
    check("1 統一的金鑰打不開群益的包、群益的打不開統一的", code_of(lambda: pc.open_sealed(blob)) == "SEAL_INVALID"
          and code_of(lambda: capl.open_sealed(node_seal({"a": 1}, "president_local"))) == "SEAL_INVALID")
    raw = bytearray(base64.b64decode(blob))
    raw[20] ^= 1
    check("1 改一個 byte / 亂碼 → SEAL_INVALID", code_of(lambda: capl.open_sealed(base64.b64encode(bytes(raw)).decode())) == "SEAL_INVALID"
          and code_of(lambda: capl.open_sealed("!!")) == "SEAL_INVALID")
else:
    print("SKIP  1 (node not found)")


def seal_py(obj):
    import secrets as _s
    iv = _s.token_bytes(12)
    ct = cc._crypto()["AESGCM"](capl._LOCAL["key"]).encrypt(iv, json.dumps(obj).encode(), capl._SEAL_AAD)
    return base64.b64encode(iv + ct).decode()


# 2. shape
check("2 身分證 / 居留證格式", capl._bundle({"id": ID, "pw": PW}) == {"id": ID, "pw": PW}
      and capl._bundle({"id": "AC12345678", "pw": PW})["id"] == "AC12345678")
check("2 壞的身分證 / 密碼 → BAD_ID / BAD_PW", code_of(lambda: capl._bundle({"id": "a123456789", "pw": PW})) == "BAD_ID"
      and code_of(lambda: capl._bundle({"id": ID, "pw": "a\nb"})) == "BAD_PW" and code_of(lambda: capl._bundle({"id": ID, "pw": "x" * 65})) == "BAD_PW")

# 3. bind
envp = os.path.join(WS, ".env")
cl.LOCAL_OPEN_VENUES = frozenset(cl.LOCAL_OPEN_VENUES | {"CAPITAL"})   # = local_daemon at start
check("3 不是 bind 那一步寫的群益(聊天綁定、別的寫法)→ NOT_CHECKED,.env 沒動",
      code_of(lambda: cl._cmd_credentials({"env": {"capital_api_key": "", "capital_password": "vault:0123456789abcdef"}})) == "NOT_CHECKED"
      and not os.path.exists(envp))
cl.LOCAL_OPEN_VENUES = frozenset(cl.LOCAL_OPEN_VENUES | {"CAPITAL"})
capl.IS_WINDOWS = True
capl._LOCAL["pending"] = {"id": ID, "pw": PW}
good = capl._bound_env({"id": ID, "pw": PW})
check("3 bind 閘:多一行、密碼指紋不同、身分證不是空的 → 都 NOT_CHECKED;剛好那兩行才放行",
      code_of(lambda: capl.local_bind_gate(dict(good, capital_id=""))) == "NOT_CHECKED"
      and code_of(lambda: capl.local_bind_gate(dict(good, capital_password="vault:" + cc.vault_fingerprint(ID, "x")))) == "NOT_CHECKED"
      and code_of(lambda: capl.local_bind_gate(dict(good, capital_api_key=ID))) == "NOT_CHECKED"
      and code_of(lambda: capl.local_bind_gate({k.upper(): v for k, v in good.items()})) is None)
capl._LOCAL["pending"] = None
pushes, respawned = [], []
capl._LOCAL["on_secrets"] = lambda: respawned.append(1)
capl._bind({"id": ID, "pw": PW}, lambda: pushes.append(1))
check("3 bind 之後重起對帳器(它的那一行是起來時給的)", respawned == [1])
capl._LOCAL["on_secrets"] = None
env_txt = open(envp).read()
fp = cc.vault_fingerprint(ID, PW)
check("3 .env 只有兩行 sentinel(身分證空、密碼是指紋),沒有明文", f"capital_password=vault:{fp}" in env_txt and ID not in env_txt and PW not in env_txt
      and any(l.split("=", 1)[0].casefold() == "capital_api_key" and l.split("=", 1)[1] == "" for l in env_txt.splitlines()), env_txt)
check("3 .env 這兩行(身分證是空值)照樣認得是綁了群益(帳戶列、補交、解綁都靠它)", "CAPITAL" in cl._venue_cred_ids(env_txt.splitlines()), cl._venue_cred_ids(env_txt.splitlines()))
check("3 沒有 vault 檔;秘密只在記憶體", not os.path.exists(os.path.join(BASE, "credentials", "capital_vault.json")) and capl.secrets() == {"capital_api_key": ID, "capital_password": PW})
check("3 status 沒有身分證 / 密碼", ID not in json.dumps(capl.read_status()) and PW not in json.dumps(capl.read_status()))
check("3 secrets:別組帳密 → REBOUND", code_of(lambda: capl.local_dispatch({"op": "secrets", "sealed": seal_py({"id": ID, "pw": "other"})}, None)) == "REBOUND")
check("3 secrets:同一組 → 收", capl.local_dispatch({"op": "secrets", "sealed": seal_py({"id": ID, "pw": PW})}, None) == {"secrets": "ok"})

# 4. the lib
sys.path.insert(0, os.path.join(WS, "lib"))
import capital_vault as cv  # noqa: E402
cv._LOCAL = None
env = {"capital_api_key": "", "capital_password": "vault:" + fp}
check("4 沒拿到那一行的行程(agent)登不進去", code_of(lambda: cv.resolve(env)) is not None)
cv.use_local_secrets({"capital_api_key": ID, "capital_password": PW, "president_password": "x"})
check("4 拿到那一行 → 身分證與密碼;只挑群益的兩個 key", cv.resolve(env) == (ID, PW) and set(cv._LOCAL) == {"capital_api_key", "capital_password"})
cv.use_local_secrets({"capital_api_key": ID, "capital_password": "old-pw"})
def _msg(fn):
    try:
        fn()
    except RuntimeError as e:
        return str(e)
    return ""


check("4 別次綁定留下的那一行(指紋對不上)→ 不登入", "do not match" in _msg(lambda: cv.resolve(env)))
r, w = os.pipe()
os.write(w, (json.dumps({"capital_api_key": ID, "capital_password": PW}) + "\n").encode())
os.close(w)
cv._LOCAL = None
os.environ[cv.STDIN_FLAG] = "1"
saved0 = os.dup(0)
os.dup2(r, 0)
try:
    got = cv.resolve(env)
finally:
    os.dup2(saved0, 0)
check("4 子行程從 stdin 讀一次那一行、旗標用完就拿掉", got == (ID, PW) and cv.STDIN_FLAG not in os.environ)
cv._LOCAL = None
os.environ.pop("BLAVE_AGENT_LOCAL")
vault = os.path.join(BASE, "credentials", "capital_vault.json")
os.makedirs(os.path.dirname(vault), exist_ok=True)
with open(vault, "w") as f:
    json.dump({"capital_api_key": "Z199999999", "capital_password": "cloud"}, f)
check("4 雲端(沒有本機旗標)照舊讀 vault 檔", cv.resolve(env) == ("Z199999999", "cloud"))
os.remove(vault)
os.environ["BLAVE_AGENT_LOCAL"] = "1"
check("4 明文 .env(舊的綁法)不受影響", cv.resolve({"capital_api_key": ID, "capital_password": "plain"}) == (ID, "plain"))

# 5. the reconciler's line
pc._LOCAL["secrets"] = {"account": "70000011234", "password": "ppw", "ca_password": "", "live": True}
line = json.loads(ld.secret_line_all())
check("5 一行帶兩家的 key", line.get("capital_password") == PW and line.get("president_password") == "ppw")
import importlib  # noqa: E402
pv = importlib.import_module("lib.president_vault")
pv.use_local_secrets(line)
check("5 統一的 vault 只挑自己的", "capital_password" not in (pv._LOCAL or {}))
pc._LOCAL["secrets"] = None
capl_secrets = capl._LOCAL["secrets"]
capl._LOCAL["secrets"] = None
check("5 兩家都沒有 → 空字串(不帶 stdin 行)", ld.secret_line_all() == "")
capl._LOCAL["secrets"] = capl_secrets
check("5 local_daemon:capital_local 只在本機、不在 api 清單", "capital_local" in ld.LOCAL_ONLY and "capital_local" not in ld.ALLOWED)
src_ld = open(os.path.join(ROOT, "runtime", "local_daemon.py"), encoding="utf-8").read()
check("5 local_daemon 六處接線(封裝金鑰、補交後重起對帳器、孤兒回收、每秒 tick、狀態、關機停)",
      all(x in src_ld for x in ("self.capl.set_seal_key(self.secret)", 'self.capl._LOCAL["on_secrets"]', 'self.capl._LOCAL["worker"].reap_orphan(',
                                "self.capl.local_tick()", 'doc["capital_local"] = self.capl.local_info()', "self.capl.local_shutdown()"))
      and "capital_vault.use_local_secrets(" in src_ld.split("def _take_president_line", 1)[1].split("def run_reconciler", 1)[0])

# 6. probe
state_probe = os.path.join(WS, "state", "capital_probe.json")


def fake_probe(obj, rc):
    def run(argv, timeout, what):
        if obj is not None:
            with open(state_probe, "w") as f:
                json.dump(obj, f)
        return subprocess.CompletedProcess(argv, rc, b"", b"")
    return run


capl._local_run = fake_probe({"ok": True, "accounts": {"futures": "F1", "securities": None}, "read_at": 1}, 0)
st = capl.probe_once()
check("6 probe ok → status probe ok、期貨有、證券沒有,沒有帳號原文", st["state"] == "ok" and capl.read_status()["probe"]["futures"] is True
      and capl.read_status()["probe"]["securities"] is False and "F1" not in json.dumps(capl.read_status()))
capl._local_run = fake_probe({"ok": False, "stage": "login", "code": 300}, 2)
capl.probe_once()
check("6 300 → pw_wrong,這組帳密被擋", capl.read_status()["probe"]["state"] == "pw_wrong" and cc.pw_blocked() == 300)
check("6 被擋時再按確認 → PW_RECHECK_NEEDED(不登入)", code_of(lambda: capl.local_dispatch({"op": "probe"}, None)) == "PW_RECHECK_NEEDED"
      and code_of(lambda: capl.local_dispatch({"op": "start"}, None)) == "PW_RECHECK_NEEDED")
check("6 300 不給「我已解鎖」那一次", code_of(lambda: capl.local_dispatch({"op": "probe", "after_unlock": True}, lambda job, cleanup: (job, cleanup))) == "PW_RECHECK_NEEDED")
capl._release_step() if capl._busy.locked() else None
capl._bind({"id": ID, "pw": "new-pw"}, None)
check("6 重填密碼(新指紋)→ 不再被擋、probe / worker 歸 idle", cc.pw_blocked() is None and capl.read_status()["probe"]["status"] == "idle")
capl._local_run = fake_probe({"ok": False, "stage": "login", "code": 307}, 2)
capl.probe_once()
taken = {}
d = capl.local_dispatch({"op": "probe", "after_unlock": True}, lambda job, cleanup: taken.update(job=job, cleanup=cleanup) or "deferred")
blk = json.load(open(os.path.join(WS, "state", "capital_login_block.json")))
check("6 307 → 「我已解鎖」放行一次(allow_once)、busy 記成 capital_local:probe", d == "deferred" and blk.get("allow_once") is True
      and capl.read_status()["busy"] == "capital_local:probe")
taken["cleanup"]()
check("6 步驟收尾清 busy", capl.read_status()["busy"] is None and not capl._busy.locked())
check("6 解鎖那一次用掉了 → 再要一次 PW_RECHECK_NEEDED", code_of(lambda: capl.local_dispatch({"op": "probe", "after_unlock": True}, lambda j, cleanup: cleanup())) == "PW_RECHECK_NEEDED")
for code, state in ((321, "verify_needed"), (600, "cert_old"), (602, "cert_unusable"), (604, "cert_expired")):
    capl._bind({"id": ID, "pw": f"pw{code}"}, None)
    capl._local_run = fake_probe({"ok": False, "stage": "login", "code": code}, 2)
    capl.probe_once()
    check(f"6 {code} → {state},不擋帳密", capl.read_status()["probe"]["state"] == state and cc.pw_blocked() is None)
capl._local_run = fake_probe(None, 3)
capl._local_run = lambda argv, timeout, what: (_ for _ in ()).throw(RuntimeError("probe timed out"))
check("6 逾時 → timeout", capl.probe_once()["state"] == "timeout")

# 7. worker
class FakeProc:
    def __init__(self, rc):
        self.rc, self.pid, self.stdin = rc, 999999, io.BytesIO()

    def poll(self):
        return self.rc

    def wait(self, t=None):
        return self.rc


w = capl._LOCAL["worker"]
spawned = []
w._spawn = lambda: spawned.append(1)
w.wanted, w.proc = True, FakeProc(3)
cc.block_login(300)
capl.local_tick()
check("7 登入被拒停下來(exit 3)→ 不重起、worker 記 LOGIN_FAILED:pw_wrong", spawned == [] and w.wanted is False
      and capl.read_status()["worker"]["error"] == "LOGIN_FAILED:pw_wrong")
w.wanted, w.proc, w.respawn_at = True, FakeProc(3), 0
w.tick(); w.tick()
check("7 supervisor 自己也不重起 exit 3 的 worker(就算還 wanted)", spawned == [])
cc.clear_block()
w.wanted, w.proc, w.respawn_at = True, FakeProc(1), None
capl.local_tick()
w.respawn_at = 0
capl.local_tick()
check("7 其他的結束 → 等一下再起", spawned == [1])
wsrc = open(os.path.join(ROOT, "lib", "capital_worker.py"), encoding="utf-8").read()
check("7 capital_worker:exit 3 只在本機(BLAVE_AGENT_LOCAL=1)、雲端照舊 backoff", 'if os.environ.get("BLAVE_AGENT_LOCAL") == "1" and e.code in capital_vault.BLOCK_CODES:' in wsrc
      and "sys.exit(LOGIN_STOPPED_EXIT)" in wsrc and wsrc.count("_fail_and_exit({\"ok\": False, \"error\": str(e)})") == 1
      and capl.LOGIN_STOPPED_EXIT == 3 and "LOGIN_STOPPED_EXIT = 3" in wsrc)

# 8. unbind
w.proc = None
LAD = os.path.join(BASE, "LocalAppData")
os.environ["LOCALAPPDATA"] = LAD
logd = os.path.join(LAD, "Blave", "capital", "log")
os.makedirs(logd)
with open(os.path.join(logd, "CapitalLog_x.txt"), "w") as f:
    f.write("A123456789")
leftovers = [os.path.join(WS, "state", n) for n in ("capital_probe.json", "capital_account.json", "capital_worker.log", "capital_worker.log.1")]
for f in leftovers:
    open(f, "w").write("{}")
cc.block_login(300)
blockf = os.path.join(WS, "state", "capital_login_block.json")
respawned = []
capl._LOCAL["on_secrets"] = lambda: respawned.append("unbind")
cl._cmd_credentials_remove({"env": ["capital_api_key", "capital_password"]})
capl._LOCAL["on_secrets"] = None
check("8 解除綁定 → 秘密丟掉、worker 停、probe 歸 idle、.env 兩行拿掉", capl._LOCAL["secrets"] is None and w.wanted is False
      and capl.read_status()["probe"]["status"] == "idle" and "capital_password" not in open(envp).read())
check("8 …對帳器重起(它記憶體裡那一行要丟)、群益 log(含身分證)與 probe／快照／worker log 刪掉", respawned == ["unbind"]
      and not os.path.exists(logd) and not any(os.path.exists(f) for f in leftovers))
check("8 …錯密碼的封鎖留著(同一組錯密碼重綁不能多換一次機會)", os.path.exists(blockf))
os.remove(blockf)
# 對帳器還握著 SKCOM 時 log 刪不掉(Windows 檔案鎖):記下來,local_tick 之後再刪;DLL 旁的 CapitalLog* 也算;C:\skcom 不碰
skx = os.path.join(LAD, "Blave", "capital", "skcom", "x64")
os.makedirs(skx, exist_ok=True)
for n in ("CapitalLog_20261020.txt", "SKCOM.dll"):
    open(os.path.join(skx, n), "w").write("x")
os.makedirs(logd, exist_ok=True)
open(os.path.join(logd, "CapitalLog_y.txt"), "w").write("A123456789")
locked = {os.path.join(skx, "CapitalLog_20261020.txt")}
real_remove = os.remove


def remove_locked(path, *a, **k):
    if path in locked:
        raise PermissionError(13, "in use")
    return real_remove(path, *a, **k)


flagf = os.path.join(WS, "state", "capital_log_purge")
with um.patch.object(capl.os, "remove", remove_locked):
    capl.drop_local(["capital_password"])
check("8 刪不掉(對帳器還開著)→ 記下來;刪得掉的照刪;DLL 不動", os.path.exists(flagf) and not os.path.exists(logd)
      and os.path.exists(os.path.join(skx, "CapitalLog_20261020.txt")) and os.path.exists(os.path.join(skx, "SKCOM.dll")))
capl._PURGE["next"] = 0
with um.patch.object(capl.os, "remove", remove_locked):
    capl.local_tick()
check("8 …還鎖著:下一輪照樣留著記號、30 秒後再試", os.path.exists(flagf) and capl._PURGE["next"] > time.time() + 20)
locked.clear()
capl._PURGE["next"] = 0
capl.local_tick()
check("8 …對帳器退出之後:local_tick 刪掉、記號拿掉", not os.path.exists(os.path.join(skx, "CapitalLog_20261020.txt")) and not os.path.exists(flagf)
      and os.path.exists(os.path.join(skx, "SKCOM.dll")))
os.makedirs(logd, exist_ok=True)
open(os.path.join(logd, "CapitalLog_z.txt"), "w").write("A123456789")
capl.startup_sweep()
check("8 daemon 啟動時沒綁群益 → 補掃一次", not os.path.exists(logd))
os.makedirs(logd, exist_ok=True)
with open(envp, "a") as f:
    f.write("capital_password=vault:0123456789abcdef\n")
capl.startup_sweep()
check("8 …綁著群益時不掃(那份 log 在用)", os.path.exists(logd))
lines = [l for l in open(envp).read().splitlines() if not l.startswith("capital_password=")]
open(envp, "w").write("\n".join(lines) + "\n")
shutil.rmtree(logd)
check("8 local_daemon 啟動時叫 startup_sweep", "self.capl.startup_sweep()" in open(os.path.join(ROOT, "runtime", "local_daemon.py"), encoding="utf-8").read())

# 9. dispatch
os.environ.pop("BLAVE_AGENT_LOCAL")
check("9 不在電腦版 → NOT_LOCAL", code_of(lambda: capl.local_dispatch({"op": "setup"}, None)) == "NOT_LOCAL")
os.environ["BLAVE_AGENT_LOCAL"] = "1"
check("9 形狀:亂的 op / 多的欄位 / after_unlock:false → BAD_ARGS", code_of(lambda: capl.local_dispatch({"op": "rm"}, None)) == "BAD_ARGS"
      and code_of(lambda: capl.local_dispatch({"op": "setup", "x": 1}, None)) == "BAD_ARGS"
      and code_of(lambda: capl.local_dispatch({"op": "probe", "after_unlock": False}, None)) == "BAD_ARGS")
check("9 沒有秘密就 probe / start → NO_SECRETS", code_of(lambda: capl.local_dispatch({"op": "probe"}, None)) == "NO_SECRETS"
      and code_of(lambda: capl.local_dispatch({"op": "start"}, None)) == "NO_SECRETS")
capl.IS_WINDOWS = False
check("9 不是 Windows → NOT_WINDOWS", code_of(lambda: capl.local_dispatch({"op": "setup"}, None)) == "NOT_WINDOWS")
capl.IS_WINDOWS = True
check("9 command_listener 有 capital_local handler、本機群益綁定走 bind gate", "capital_local" in cl.HANDLERS
      and 'elif vid == "CAPITAL":\n                # same reason as 統一' in open(os.path.join(ROOT, "runtime", "command_listener.py"), encoding="utf-8").read())

# 10. setup: SKCOM per-user, every file compared with the pinned zip
import hashlib  # noqa: E402


def mkzip(path, members):
    with zipfile.ZipFile(path, "w") as zf:
        for name, data in members.items():
            zf.writestr(name, data)
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


good_zip = os.path.join(BASE, "good.zip")
X = "CapitalAPI_2.13.59/\u5143\u4ef6/x64/"
good_sha = mkzip(good_zip, {X + "SKCOM.dll": b"skcom-v1", X + "SKProxyLIB.dll": b"proxy-v1", "CapitalAPI_2.13.59/x86/SKCOM.dll": b"x86", "readme.txt": b"r"})
capl.CAP_ZIP_SHA256 = good_sha
downloads, restricted, regs = [], [], []
capl._download = lambda url, dest, max_bytes, sha256=None: (downloads.append(url), shutil.copy(good_zip, dest))
capl._restrict_dir = lambda p: (restricted.append(p), os.makedirs(p, exist_ok=True))
real_run = subprocess.run
fake_run = lambda argv, **kw: (regs.append(argv), subprocess.CompletedProcess(argv, 0, b"", b""))[1]
skdir = os.path.join(LAD, "Blave", "capital", "skcom", "x64")
with um.patch.object(capl.subprocess, "run", fake_run):
    capl._ensure_skcom(tempfile.mkdtemp(dir=BASE))
check("10 裝在 %LOCALAPPDATA%\\Blave\\capital(權限收窄)、只有 x64 那一層、per-user 註冊指到那裡",
      sorted(os.listdir(skdir)) == ["SKCOM.dll", "SKProxyLIB.dll"] and restricted == [os.path.join(LAD, "Blave", "capital")]
      and regs[-1] == ["regsvr32.exe", "/s", "/n", "/i:user", os.path.join(skdir, "SKCOM.dll")] and len(downloads) == 1)
with open(os.path.join(skdir, "SKCOM.dll"), "wb") as f:
    f.write(b"planted")
os.remove(os.path.join(skdir, "SKProxyLIB.dll"))
with um.patch.object(capl.subprocess, "run", fake_run):
    capl._ensure_skcom(tempfile.mkdtemp(dir=BASE))
check("10 下一次 setup:被換掉的 DLL 照 zip 重寫、少的補回,快取的 zip 雜湊對就不再下載",
      open(os.path.join(skdir, "SKCOM.dll"), "rb").read() == b"skcom-v1" and open(os.path.join(skdir, "SKProxyLIB.dll"), "rb").read() == b"proxy-v1"
      and len(downloads) == 1)
with open(os.path.join(LAD, "Blave", "capital", "dl", "CapitalAPI_2.13.59.zip"), "ab") as f:
    f.write(b"tamper")
with um.patch.object(capl.subprocess, "run", fake_run):
    capl._ensure_skcom(tempfile.mkdtemp(dir=BASE))
check("10 快取的 zip 被改過(雜湊不對)→ 重新下載", len(downloads) == 2)
for bad_members, what in (({X + "SKCOM.dll": b"x", X + "..": b"x"}, "成員名是 .."), ({X + "SKCOM.dll": b"x", X + "a\\b.dll": b"x"}, "成員名帶反斜線"),
                          ({X + "SKCOM.dll": b"x", "other/x64/SKCOM.dll": b"y"}, "兩個 x64 資料夾都有 SKCOM.dll")):
    bz = os.path.join(BASE, "bad.zip")
    capl.CAP_ZIP_SHA256 = mkzip(bz, bad_members)
    shutil.rmtree(os.path.join(LAD, "Blave", "capital", "dl"), ignore_errors=True)
    capl._download = lambda url, dest, max_bytes, sha256=None: shutil.copy(bz, dest)
    with um.patch.object(capl.subprocess, "run", fake_run):
        check("10 zip 不像樣(" + what + ")→ 拒絕", code_of(lambda: capl._ensure_skcom(tempfile.mkdtemp(dir=BASE))) is not None)
check("10 setup 只在缺 VC++ 2010 時才下載微軟的安裝程式、先驗簽章是 Microsoft", "if _vc_present():\n        return" in open(os.path.join(ROOT, "runtime", "capital_local.py"), encoding="utf-8").read()
      and "-ne 'Microsoft Corporation'" in capl._PS_VC)
check("10 comtypes 釘版本(M0 在 test-4 跑過的 1.4.17),已裝的版本不同也重裝", capl.COMTYPES_PIN == "comtypes==1.4.17" and "comtypes.__version__ == '1.4.17'" in capl._COMTYPES_OK)

# 11. the lib loads SKCOM from the same per-user folder and points SKCOM's log there
importlib.reload(cv)
check("11 本機:lib 的 SKCOM 路徑 = runtime 裝的那裡;雲端(沒有本機旗標)照舊 C:\\skcom\\x64", cv.skcom_dll() == os.path.join(skdir, "SKCOM.dll")
      and cv.local_dir() == capl.local_dir())
os.environ.pop("BLAVE_AGENT_LOCAL")
check("11 …雲端", cv.skcom_dll() == r"C:\skcom\x64\SKCOM.dll" and cv.local_dir() is None)


class Center:
    def __init__(self):
        self.calls = []

    def SKCenterLib_SetLogPath(self, p):
        self.calls.append(p)


c0 = Center()
cv.set_log_path(c0)
os.environ["BLAVE_AGENT_LOCAL"] = "1"
c1 = Center()
cv.set_log_path(c1)
check("11 群益 log:本機指到 %LOCALAPPDATA%\\Blave\\capital\\log(解綁時刪),雲端不動", c0.calls == [] and c1.calls == [os.path.join(LAD, "Blave", "capital", "log")]
      and os.path.isdir(c1.calls[0]))
for libname in ("capital_worker.py", "order_capital.py"):
    src = open(os.path.join(ROOT, "lib", libname), encoding="utf-8").read()
    check(f"11 {libname}:從 capital_vault.skcom_dll() 載入、登入前先 set_log_path、不再寫死 C:\\skcom",
          "GetModule(capital_vault.skcom_dll())" in src and "skcom\\x64" not in src
          and src.index("capital_vault.set_log_path(center)") < src.index("SKCenterLib_Login(login_id, password)"))

shutil.rmtree(BASE, ignore_errors=True)
print(f"\n{len(fails)} FAILED" if fails else "\nall ok")
sys.exit(1 if fails else 0)
