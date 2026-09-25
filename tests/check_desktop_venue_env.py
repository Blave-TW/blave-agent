"""電腦版「連接交易所」多開的四家(OKX / BingX / Gate.io / Bybit):送到機器的 env 名,就是機器寫進 .env、
帳戶讀取器與下單 lib 讀的那一組;解除綁定送的名字拿得掉它們。

外殼那一側的名字只有一份來源(shell/cloudcmd.js 的 CONNECT_VENUES / venueEnvNames,用 node 讀出來),
機器那一側是 runtime/command_listener.py 的 `_cmd_credentials` / `_cmd_credentials_remove`(只呼叫、不改)。
雲端主機(非 local 模式)照原樣寫;電腦版(local 模式)寫入前由 _local_real_key_gate 讀一次帳戶(lib 換成假的),
拒絕的句子再交給外殼的 cloudcmd.interpretVenueBind,驗畫面拿到的代號。金鑰全是 not-a-real-* 假值,不連網。

跑法:cd blave-agent && python3 tests/check_desktop_venue_env.py
"""
import json
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = tempfile.mkdtemp(prefix="desktop-venue-env-")
WS = os.path.join(BASE, "workspace")
os.makedirs(os.path.join(WS, "manager"))
os.environ["BLAVE_AGENT_BASE"] = BASE
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.pop("BLAVE_AGENT_LOCAL", None)   # 先當雲端主機
sys.path.insert(0, os.path.join(ROOT, "runtime"))
sys.path.insert(0, ROOT)
os.chdir(WS)
import command_listener as cl  # noqa: E402
import importlib  # noqa: E402

for _v in cl._WITHDRAW_CHECKED:   # the cloud withdrawal gate has its own test (check_credentials_withdraw_gate)
    importlib.import_module(f"lib.account_{_v.lower()}").withdraw_enabled = lambda env: False

# 驅逐舊交易所時會清路由、重排排程:這台假機器沒有那些東西,別讓它去碰開發機的 crontab
with open(os.path.join(WS, "manager", "portfolio_config.json"), "w") as f:
    f.write("{}")
cl._sync_strategy_crons = lambda names: None

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


# 外殼那一側:cloudcmd.connectSecrets 真的組出來的 secrets(= 送到機器的 args.env)與 venueEnvNames(= 解除綁定送的名字)
JS = """
const M = require(process.argv[1]);
const out = {};
for (const v of ["okx", "bingx", "gateio", "bybit"]) {
  const b = M.connectSecrets({ venue: v, apiKey: "not-a-real-key-" + v, secret: "not-a-real-secret-" + v, passphrase: "not a real passphrase" }, () => false, 1);
  out[v] = { secrets: b.secrets, remove: M.venueEnvNames(v) };
}
process.stdout.write(JSON.stringify(out));
"""
shell = json.loads(subprocess.run(["node", "-e", JS, os.path.join(ROOT, "shell", "cloudcmd.js")],
                                  capture_output=True, text=True, check=True).stdout)
ENV_PATH = os.path.join(WS, ".env")
LIB_NAMES = {  # 下單 / 帳戶 lib 讀的名字(lib/account_*.py 的 env.get)
    "okx": {"OKX_API_KEY", "OKX_SECRET_KEY", "OKX_PASSPHRASE"},
    "bingx": {"BINGX_API_KEY", "BINGX_SECRET_KEY"},
    "gateio": {"GATEIO_API_KEY", "GATEIO_SECRET_KEY"},
    "bybit": {"BYBIT_API_KEY", "BYBIT_SECRET_KEY"},
}


def env_lines():
    try:
        with open(ENV_PATH) as f:
            return dict(l.split("=", 1) for l in f.read().splitlines() if "=" in l and not l.startswith("#"))
    except FileNotFoundError:
        return {}


with open(ENV_PATH, "w") as f:   # 平台自己的資料 key:綁定 / 解綁都不能碰
    f.write("BLAVE_API_KEY=not-a-real-blave\nBLAVE_SECRET_KEY=not-a-real-blave-secret\n")

prev = None
for venue, s in shell.items():
    check(set(s["secrets"]) == LIB_NAMES[venue] and set(s["remove"]) == LIB_NAMES[venue],
          f"{venue}: 外殼送的 env 名 = lib 讀的名字,解除綁定送的也是這一組")
    cl._cmd_credentials({"env": dict(s["secrets"])})
    body = env_lines()
    check(all(body.get(k) == v for k, v in s["secrets"].items()), f"{venue}: 雲端主機把那幾行照值寫進 .env")
    check(body.get("BLAVE_API_KEY") == "not-a-real-blave", f"{venue}: 平台的資料 key 沒被動到")
    if prev:
        check(not any(k in body for k in LIB_NAMES[prev]), f"{venue}: 綁新的一家時上一家({prev})整組被擠掉")
    prev = venue

cl._cmd_credentials_remove({"env": shell["bybit"]["remove"]})
body = env_lines()
check(not any(k in body for k in LIB_NAMES["bybit"]) and body.get("BLAVE_API_KEY") == "not-a-real-blave",
      "解除綁定(外殼送 venueEnvNames 那一組):Bybit 整組拿掉、平台的 key 還在")

cl._cmd_credentials({"env": dict(shell["okx"]["secrets"])})
cl._cmd_credentials_remove({"env": shell["okx"]["remove"]})
check(not any(k in env_lines() for k in LIB_NAMES["okx"]), "OKX 解除綁定連 PASSPHRASE 一起拿掉(不留半組)")

# 電腦版(local 模式):daemon 放行這四家(local_daemon 的 LOCAL_OPEN_VENUES),寫入前由 _local_real_key_gate 用那一家的
# lib/account_* 讀一次帳戶。這裡把 lib 換成假的(不連網):讀得到 → 寫;讀不到 / 回的不是權益 → 不寫、.env 一個字不動
import types  # noqa: E402

os.environ["BLAVE_AGENT_LOCAL"] = "1"
cl.LOCAL_OPEN_VENUES = frozenset({"PAPER", "BINANCE", "OKX", "BINGX", "GATEIO", "BYBIT"})
check(all(set(cl._LOCAL_KEY_CHECKS[v.upper()]) == LIB_NAMES[v] for v in LIB_NAMES),
      "local:runtime 檢查要的欄位(_LOCAL_KEY_CHECKS)= 外殼送的那一組")
READ = {}


def fake_lib(venue):
    m = types.ModuleType(f"lib.account_{venue}")

    def get_equity(env):
        READ.setdefault(venue, []).append(sorted(k for k in env if k in LIB_NAMES[venue]))
        how = MODE.get(venue, "ok")
        if how == "raise":
            raise RuntimeError(f"401 invalid key {env.get(venue.upper() + '_API_KEY')}")
        return {"equity": 100.0} if how == "ok" else {"equity": "n/a"}
    m.get_equity = get_equity
    m.withdraw_enabled = lambda env: False  # the withdrawal gate has its own test (check_local_real_key_gate)
    return m


MODE = {}
for v in LIB_NAMES:
    sys.modules[f"lib.account_{v}"] = fake_lib(v)
ERRORS = {}
for venue, s in shell.items():
    cl._cmd_credentials({"env": dict(s["secrets"])})
    body = env_lines()
    check(READ.get(venue) == [sorted(LIB_NAMES[venue])] and all(body.get(k) == v for k, v in s["secrets"].items()),
          f"local {venue}:先用送來的那一組讀一次帳戶,讀得到才寫進 .env")
before = env_lines()
for venue, mode in (("okx", "raise"), ("bybit", "junk")):
    MODE[venue] = mode
    try:
        cl._cmd_credentials({"env": dict(shell[venue]["secrets"])})
        ERRORS[venue] = None
    except ValueError as e:
        ERRORS[venue] = f"ValueError: {e}"   # = daemon ack 的 error(_run_deferred 的格式)
    MODE.pop(venue)
check(env_lines() == before and ERRORS["okx"] and ERRORS["bybit"], "local:讀不到 / 回的不是權益 → 拒絕、.env 一個字沒動")
check(shell["okx"]["secrets"]["OKX_API_KEY"] not in ERRORS["okx"], "local:拒絕的句子裡沒有金鑰值")
try:
    cl._cmd_credentials({"env": {"OKX_API_KEY": "not-a-real-key-okx", "OKX_SECRET_KEY": "not-a-real-secret-okx"}})
    ERRORS["half"] = None
except ValueError as e:
    ERRORS["half"] = f"ValueError: {e}"
del sys.modules["lib.account_gateio"]
sys.modules["lib.account_gateio"] = None   # 這台的 lib 缺那一支(舊 workspace)
try:
    cl._cmd_credentials({"env": dict(shell["gateio"]["secrets"])})
    ERRORS["nocheck"] = None
except ValueError as e:
    ERRORS["nocheck"] = f"ValueError: {e}"

# 外殼那一側怎麼讀這些句子:cloudcmd.interpretVenueBind(畫面的代號就是它給的)
JS2 = """
const M = require(process.argv[1]); const errs = JSON.parse(process.argv[2]), secrets = JSON.parse(process.argv[3]);
const out = {}; for (const k of Object.keys(errs)) out[k] = M.interpretVenueBind({ ok: false, error: errs[k] }, secrets);
out.ok = M.interpretVenueBind({ ok: true, result: { credentials: 3, binance: null } }, secrets);
process.stdout.write(JSON.stringify(out));
"""
got = json.loads(subprocess.run(["node", "-e", JS2, os.path.join(ROOT, "shell", "cloudcmd.js"), json.dumps(ERRORS),
                                 json.dumps(shell["okx"]["secrets"])], capture_output=True, text=True, check=True).stdout)
check(got["ok"]["ok"] is True and got["ok"]["code"] == "READ_OK", "外殼:成功的 ack(binance: null)→ READ_OK(讀得到帳戶)")
check(got["okx"]["code"] == "REJECTED" and "401 invalid key" in got["okx"]["detail"]["reason"]
      and "not-a-real-key-okx" not in json.dumps(got["okx"]), "外殼:REJECTED → 帶那一家的原因、沒有金鑰值")
check(got["bybit"]["code"] == "UNKNOWN" and got["half"]["code"] == "INCOMPLETE_PAIR" and got["nocheck"]["code"] == "NO_CHECK",
      "外殼:UNKNOWN / INCOMPLETE_PAIR / no permission check(NO_CHECK)各自對到代號")

print(f"\n{fails} 紅" if fails else "\nALL PASS")
sys.exit(1 if fails else 0)
