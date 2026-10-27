"""Bitget 的電腦版連接入口:閘門(lib/venue_traits.py bitget 列的 verified_modes)關著時,每一層都看不到 Bitget;
翻開一種帳戶類型時,只開那一種,另一種的金鑰被拒、畫面講得出原因。

  ① 四份閘門同值:lib/venue_traits.py、runtime/venue_traits.py、shell/cloudcmd.js、shell/renderer/trade.js
  ② 外殼(node):關著 → 連接框兩個視角都不列、connectSecrets 不收、daemon trusted 不收、說明區沒有 Bitget 那句;
     解除綁定的名字照給(網頁舊的 Bitget 列綁過的機器 .env 可能已有 BITGET_*)。
     把閘門在測試裡開成 classic → 列出來、多一格 passphrase、送得出去、說明區講統一帳戶會被拒
  ③ runtime:local_daemon 的放行清單只在閘門開著時有 BITGET;關著時電腦版寫不進 BITGET_*
  ④ 放行了但這台 workspace 的 lib 還關著(舊 workspace)→ lib 不簽章、不連網、不寫;
     lib 只開 classic、金鑰是統一帳戶 → 被拒,而且外殼把 lib 的句子對到 cx.err.bitgetUta

不連網(socket.connect 換成會拋錯的),金鑰全是 not-a-real-*。
跑法:cd blave-agent && .venv/bin/python tests/check_bitget_surfaces.py
"""
import ast
import importlib.util
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = tempfile.mkdtemp(prefix="bitget-surfaces-")
WS = os.path.join(BASE, "workspace")
os.makedirs(os.path.join(WS, "manager"))
os.environ["BLAVE_AGENT_BASE"] = BASE
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ["BLAVE_AGENT_LOCAL"] = "1"
sys.path.insert(0, os.path.join(ROOT, "runtime"))
sys.path.insert(0, ROOT)
os.chdir(WS)

wire = []


def _no_net(self, *a, **k):
    wire.append(a)
    raise OSError("network is off in this test")


socket.socket.connect = _no_net

import command_listener as cl  # noqa: E402

with open(os.path.join(WS, "manager", "portfolio_config.json"), "w") as f:
    f.write("{}")
cl._sync_strategy_crons = lambda names: None

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, path))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def node(js, *args):
    r = subprocess.run(["node", "-e", js, *args], capture_output=True, text=True, cwd=ROOT)
    if r.returncode:
        raise RuntimeError(r.stderr[-800:])
    return json.loads(r.stdout)


SHELL = os.path.join(ROOT, "shell")
TRADE = open(os.path.join(SHELL, "renderer", "trade.js"), encoding="utf-8").read()
CONST_RE = r"^const BITGET_VERIFIED_MODES = (\[[^\]\n]*\]);$"

# ── ① 四份同值 ──
lib_modes = list(load("lib/venue_traits.py", "lib_vt").verified_modes("bitget"))
rt_modes = list(load("runtime/venue_traits.py", "rt_vt").verified_modes("bitget"))
cc_modes = node("process.stdout.write(JSON.stringify(require(process.argv[1]).BITGET_VERIFIED_MODES))",
                os.path.join(SHELL, "cloudcmd.js"))
m = re.search(CONST_RE, TRADE, re.M)
tr_modes = json.loads(m.group(1)) if m else None
check(lib_modes == rt_modes == cc_modes == tr_modes,
      f"① 閘門四份同值 lib={lib_modes} runtime={rt_modes} cloudcmd={cc_modes} trade.js={tr_modes}")
check(set(lib_modes) <= {"uta", "classic"}, "① 只會是 uta / classic")
CLOSED = not lib_modes

# ── ② 外殼 ──
# trade.js 的常數區(同 check_shell_connect_venues ②)eval 進來;opened 時把閘門換成 ["classic"]
SHELL_JS = r"""
const fs = require("fs"), path = require("path");
const [shellDir, openArg] = process.argv.slice(1), opened = openArg === "1";
const CC = require(path.join(shellDir, "cloudcmd.js"));
if (opened) CC.BITGET_VERIFIED_MODES.splice(0, CC.BITGET_VERIFIED_MODES.length, "classic");   // daemon 載入前就改:它在載入時決定 trusted
const { argsOk } = require(path.join(shellDir, "daemon.js"));
let src = fs.readFileSync(path.join(shellDir, "renderer", "trade.js"), "utf8");
if (opened) src = src.replace(/^const BITGET_VERIFIED_MODES = \[[^\]\n]*\];$/m, 'const BITGET_VERIFIED_MODES = ["classic"];');
const cut = (n) => { const i = src.indexOf("function " + n + "("); let d = 0; for (let k = src.indexOf("{", i); k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}" && --d === 0) return src.slice(i, k + 1); } throw new Error(n); };
const t = (k) => k;
eval(src.slice(src.indexOf("const PAPER = "), src.indexOf("\nfunction trEl(")).replace(/^const /gm, "var "));
eval(cut("trEnvNames"));
eval(cut("trErrToken"));
// 說明區:cxModalPaint 裡 Bitget 那一句的條件,用同一個式子算
const notePart = /if \(venue === "bitget" && BITGET_VERIFIED_MODES\.length === 1\) note\.appendChild\(trEl\("p", "", (.*?)\)\);/.exec(src);
const noteKey = notePart && BITGET_VERIFIED_MODES.length === 1 ? eval(notePart[1]) : null;
const passHint = /venue === "okx" \? t\("cx\.passHint"\) : t\("cx\.passHintV"/.test(src);
const modeText = /if \(c === "MODE_UNVERIFIED"\) return d\.mode === "uta" \? t\("cx\.err\.bitgetUta"\) : t\("cx\.err\.bitgetClassic"\);/.test(src);
const K = "not-a-real-key-bitget", S = "not-a-real-secret-bitget", P = "not a real passphrase";
const trio = { BITGET_API_KEY: K, BITGET_SECRET_KEY: S, BITGET_PASSPHRASE: P };
const reasons = JSON.parse(process.argv[3] || "{}");
process.stdout.write(JSON.stringify({
  local: cxVenuesFor("local"), cloud: cxVenuesFor("cloud"),
  built: CC.connectSecrets({ venue: "bitget", apiKey: K, secret: S, passphrase: P }, () => false, 1),
  noPass: CC.connectSecrets({ venue: "bitget", apiKey: K, secret: S }, () => false, 1),
  trusted: argsOk("credentials", { env: trio }, true), renderer: argsOk("credentials", { env: trio }),
  remove: argsOk("credentials_remove", { env: CC.venueEnvNames("bitget") }),
  removeNames: CC.venueEnvNames("bitget"), trEnv: trEnvNames("bitget"),
  pass: !!(CX_VENUES.bitget && CX_VENUES.bitget.pass), label: CX_VENUES.bitget && CX_VENUES.bitget.label,
  noteKey, passHint, modeText,
  modeErr: Object.fromEntries(Object.entries(reasons).map(([k, v]) => [k, CC.interpretVenueBind({ ok: false, error: v }, {})])),
  token: Object.fromEntries(Object.entries(reasons).map(([k, v]) => { const o = CC.interpretVenueBind({ ok: false, error: v }, {}); return [k, trErrToken((o.detail || {}).reason)]; })),
}));
"""
TRIO = ["BITGET_API_KEY", "BITGET_SECRET_KEY", "BITGET_PASSPHRASE"]


def shell_view(opened, reasons=None):
    return node(SHELL_JS, SHELL, "1" if opened else "0", json.dumps(reasons or {}))


if CLOSED:
    v = shell_view(False)
    check("bitget" not in v["local"] and "bitget" not in v["cloud"], "② 關著:連接框兩個視角都不列 Bitget")
    check(v["built"] == {"error": "BAD_ARGS"}, "② 關著:connectSecrets(bitget)→ BAD_ARGS(renderer 被攻破也送不出去)")
    check(v["trusted"] is False and v["renderer"] is False, "② 關著:daemon trusted / renderer 兩條路都不收 BITGET_* 三件組")
    check(v["noteKey"] is None, "② 關著:說明區沒有 Bitget 那一句")
else:
    print("skip ② 關著那一段:閘門已經翻開(", lib_modes, ")")
v = shell_view(False)
check(v["removeNames"] == TRIO and v["trEnv"] == TRIO and v["remove"] is True,
      "② 解除綁定:BITGET_* 三件組一直拿得掉(主行程與 renderer 同一組名字,鎖死的舊 env 名)")
check(v["passHint"], "② passphrase 提示:OKX 照舊,其他家用 cx.passHintV(不寫死 OKX)")

o = shell_view(True, {
    "uta": "ValueError: REJECTED: bitget did not accept this key (BitgetError: [order_reject:key_permission] "
           "這組 Bitget 金鑰的帳戶是統一帳戶 [bitget_account_mode:uta]，Blave 目前只支援 Bitget 的經典帳戶：請到 Bitget App 把帳戶換成經典帳戶，或改綁其他交易所) — not saved",
    "classic": "ValueError: REJECTED: bitget did not accept this key (BitgetError: 這組 Bitget 金鑰的帳戶是經典帳戶 [bitget_account_mode:classic]，但……) — not saved",
    # the old Chinese opening without the marker: words are no longer read
    "words": "ValueError: REJECTED: bitget did not accept this key (BitgetError: 這組 Bitget 金鑰的帳戶是統一帳戶，Blave 目前只支援 Bitget 的經典帳戶) — not saved",
    "other": "ValueError: REJECTED: bitget did not accept this key (BitgetError: bitget /api/v2/mix/account/accounts code=40037: Apikey does not exist) — not saved"})
check("bitget" in o["local"] and "bitget" in o["cloud"] and o["label"] == "Bitget" and o["pass"],
      "② 翻開 classic:兩個視角都列 Bitget、多一格 passphrase")
check(o["built"] == {"venue": "bitget", "secrets": {"BITGET_API_KEY": "not-a-real-key-bitget",
                                                     "BITGET_SECRET_KEY": "not-a-real-secret-bitget",
                                                     "BITGET_PASSPHRASE": "not a real passphrase"}}
      and o["noPass"] == {"error": "INCOMPLETE_PAIR"},
      "② 翻開:送出 BITGET_* 三件組;沒填 passphrase = 沒填齊")
check(o["trusted"] is True and o["renderer"] is False, "② 翻開:daemon 只在 trusted 那條路收")
check(o["noteKey"] == "cx.note.bitgetClassicOnly", "② 翻開 classic:說明區講統一帳戶會被拒")
me = o["modeErr"]
check(me["uta"] == {"ok": False, "code": "MODE_UNVERIFIED", "detail": {"mode": "uta"}}
      and me["classic"]["code"] == "REJECTED" and me["other"]["code"] == "REJECTED" and me["words"]["code"] == "REJECTED" and o["modeText"],
      "② 翻開 classic:帶 [bitget_account_mode:uta] 的拒絕 → MODE_UNVERIFIED(畫面 cx.err.bitgetUta);經典帳戶、其他原因、沒有標記的中文句照原文 REJECTED")

# ── ③ runtime 放行清單 = local_daemon 那一行 ──
src = open(os.path.join(ROOT, "runtime", "local_daemon.py"), encoding="utf-8").read()
stmt = next(n for n in ast.walk(ast.parse(src)) if isinstance(n, ast.Assign) and len(n.targets) == 1
            and ast.unparse(n.targets[0]) == "cl.LOCAL_OPEN_VENUES")
code = ast.get_source_segment(src, stmt)


def open_list(modes):
    stub = types.SimpleNamespace(LOCAL_OPEN_VENUES=frozenset({"PAPER"}),
                                 venue_traits=types.SimpleNamespace(verified_modes=lambda v: tuple(modes) if v == "bitget" else ()))
    ns = {"cl": stub}
    exec(code, ns)
    return stub.LOCAL_OPEN_VENUES


check("BITGET" not in open_list(()) and "BITGET" in open_list(("classic",)),
      "③ local_daemon:閘門空 → 不放行 BITGET;開一種 → 放行")
check(open_list(lib_modes) >= {"OKX", "STOCKCOIN"} and (("BITGET" in open_list(lib_modes)) == (not CLOSED)),
      "③ 用 runtime 現在的閘門算出來的放行清單")
check(cl._LOCAL_KEY_CHECKS.get("BITGET") == tuple(TRIO), "③ _LOCAL_KEY_CHECKS:Bitget 寫入前要三件組")

ENV_PATH = os.path.join(WS, ".env")
ENV = dict(zip(TRIO, ["not-a-real-key-bitget", "not-a-real-secret-bitget", "not a real passphrase"]))


def refused():
    try:
        cl._cmd_credentials({"env": dict(ENV)})
        return None
    except ValueError as e:
        return str(e)


cl.LOCAL_OPEN_VENUES = open_list(lib_modes)
if CLOSED:
    r = refused()
    check(r is not None and "只開放模擬交易" in r and not os.path.exists(ENV_PATH),
          "③ 關著:電腦版寫不進 BITGET_*(沒寫 .env)")

# ── ④ 放行之後,lib 決定 ──
cl.LOCAL_OPEN_VENUES = open_list(("classic",))
import lib.account_bitget as ab  # noqa: E402

ab.VERIFIED_MODES = frozenset()  # 舊 workspace:lib 的閘門還關著
wire.clear()
r = refused()
check(r is not None and r.startswith("REJECTED: bitget did not accept this key") and "沒有送出" in r
      and not os.path.exists(ENV_PATH) and not wire,
      "④ 放行了但 lib 還關著:不簽章、不連網、不寫,拒絕句子講得出 Bitget 還沒開放")
stale = shell_view(True, {"stale": "ValueError: " + (r or "")})["modeErr"]["stale"]
check(stale == {"ok": False, "code": "NO_CHECK", "detail": {}}, "④ 那一句到外殼 = NO_CHECK(畫面叫人先更新,不是「Bitget 拒絕」)")

ab.VERIFIED_MODES = frozenset({"classic"})
ab._mode.update(mode=None, at=0.0)


def settings_says_unified(env, path, params=None, timeout=10):
    if path == "/api/v3/account/settings":
        return {"accountMode": "unified"}
    raise AssertionError("only the mode is read before the refusal: " + path)


ab.send_get = settings_says_unified
r = refused()
check(r is not None and "統一帳戶" in r and not os.path.exists(ENV_PATH), "④ lib 只開 classic、金鑰是統一帳戶 → 被拒、沒寫")
o = shell_view(True, {"uta": "ValueError: " + (r or "")})
check(o["modeErr"]["uta"]["code"] == "MODE_UNVERIFIED" and o["modeErr"]["uta"]["detail"] == {"mode": "uta"},
      "④ lib 真的那一句經過 interpretVenueBind(含遮罩)→ MODE_UNVERIFIED uta(英文介面看得懂)")
c = shell_view(False, {"uta": "ValueError: " + (r or "")})
if "uta" in cc_modes:
    check(c["modeErr"]["uta"]["code"] != "MODE_UNVERIFIED",
          "④ 外殼現在的閘門開著統一帳戶:舊 lib 丟的統一帳戶拒絕不再講成「還不支援」(照 lib 原文)")
else:
    check(c["modeErr"]["uta"]["code"] == "MODE_UNVERIFIED", "④ 外殼現在的閘門沒開統一帳戶時也一樣")


def settings_unreadable(env, path, params=None, timeout=10):
    if path == "/api/v3/account/settings":
        raise ab.BitgetError("bitget /api/v3/account/settings code=40014: Incorrect permissions", code="40014")
    raise ab.BitgetError("bitget v2 code=40085: classic API on a UTA", code=ab.UTA_MODE)


ab._mode.update(mode=None, at=0.0)
ab.send_get = settings_unreadable
r = refused()
o = shell_view(True, {"uta": "ValueError: " + (r or "")})
check(r is not None and o["modeErr"]["uta"]["code"] == "MODE_UNVERIFIED",
      "④ 統一帳戶但讀不到帳戶設定(lib 叫人去勾權限)→ 統一帳戶沒開放時,外殼改講「只支援經典帳戶」")


class _Reply:
    status_code = 400

    def __init__(self, code, msg):
        self._body = {"code": code, "msg": msg, "requestTime": 1, "data": None}
        self.text = json.dumps(self._body)

    def json(self):
        return self._body


def copy_trading_key(env, path, params=None, timeout=10):
    # a copy-trading key: the v3 settings answer "classic", every account read 40731 (error_of's real sentence)
    if path == "/api/v3/account/settings":
        return {"accountMode": "classic", "accountLevel": "basic", "holdMode": "hedge_mode"}
    raise ab.error_of(env, _Reply("40731", "This product does not support copy trading"), path)


ab._mode.update(mode=None, at=0.0)
ab.send_get = copy_trading_key
r = refused()
o = shell_view(True, {"copy": "ValueError: " + (r or "")})
check(r is not None and not os.path.exists(ENV_PATH) and "帳戶模式是" not in r
      and o["modeErr"]["copy"]["code"] == "REJECTED" and o["token"]["copy"] == "bitget_copy_trading_key",
      "④ 跟單金鑰(40731):被拒、沒寫;經過 _scrub 與 interpretVenueBind 的遮罩後標記還在 → 連接框 cx.err.bitgetCopyKey,"
      "不是「帳戶模式 classic 不支援」:" + str(r)[:160])
check(not wire, "全程沒有任何連線")

print("all ok" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
