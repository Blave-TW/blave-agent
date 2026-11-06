"""機器自己發的通知寫策略名稱(lib/strategy_names.py,canon notifications §3.1),
以及 dual-write 那一半只在事件落不了檔時才送(canon §5 第 2 步,五個發送點)。

  1. clean() 跑 api tests/check_strategy_names.py 的 CASES(同一張表,兩邊規則一字不差);
     api 那棵用 BLAVE_API_DIR 指定(預設 monorepo 的 ../api),找不到就 fail
  2. label() 從策略檔讀 DISPLAY_NAME;沒有、讀不到、解析失敗回代號
  3. 五個發送點:事件落檔了(emit 回 id)不送 TG;落不了檔(舊 runtime)才送,字寫名稱;
     bar_stale computed=true 平台壓成 P3,照送

Run: cd blave-agent && .venv/bin/python tests/check_strategy_names_lib.py
"""
import importlib.util
import json
import os
import re
import sys
import tempfile
import types
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from lib import strategy_names as sn

red = []


def ok(name, cond, why=""):
    print(("PASS  " if cond else "FAIL  ") + name + ("" if cond or not why else "  " + str(why)))
    if not cond:
        red.append(name)


# ── 1. 同一張測資 ────────────────────────────────────────────────────────────
api_dir = os.environ.get("BLAVE_API_DIR") or os.path.join(ROOT, "..", "api")
api_test = os.path.join(api_dir, "tests", "check_strategy_names.py")
if not os.path.isfile(api_test):
    ok("找得到 api 那棵的測資(" + api_test + ";設 BLAVE_API_DIR)", False)
    cases = []
else:
    src = open(api_test, encoding="utf-8").read()
    m = re.search(r"# CASES_BEGIN\nCASES = json\.loads\(r'''(.*?)'''\)\n# CASES_END", src, re.S)
    cases = json.loads(m.group(1)) if m else []
    ok("api 測資讀得到", len(cases) > 20, len(cases))
    api_rule = open(os.path.join(api_dir, "openclaw", "strategy_names.py"), encoding="utf-8").read()
    mine = open(os.path.join(ROOT, "lib", "strategy_names.py"), encoding="utf-8").read()
    for const in ("LABEL_MAX = ", "_UNSAFE = ", "_FOLD = ", "_URL = ", "_SPACE = "):
        line = lambda s: next((x for x in s.splitlines() if x.startswith(const)), None)
        ok(f"{const.strip(' =')} 跟 api 同一行", line(api_rule) is not None and line(api_rule) == line(mine),
           (line(api_rule), line(mine)))
    tld = lambda s: re.search(r"URL_TLDS = \((.*?)\)", s, re.S).group(1).split()
    ok("URL_TLDS 跟 api 同一份", tld(api_rule) == tld(mine))
bad = [(n, c, want, sn.clean(n, c)) for n, c, want in cases if (sn.clean(n, c) or "") != want]
ok(f"clean() 過 {len(cases)} 筆測資", not bad, bad)

# ── 2. label() 讀策略檔 ──────────────────────────────────────────────────────
ws = tempfile.mkdtemp()
os.makedirs(os.path.join(ws, "strategies", "eth_ma"))
with open(os.path.join(ws, "strategies", "eth_ma", "strategy.py"), "w", encoding="utf-8") as f:
    f.write('STRATEGY_NAME = "eth_ma"\nDISPLAY_NAME = "ETH 均線交叉（4h）"\nINTERVAL = "4h"\n')
with open(os.path.join(ws, "strategies", "flat.py"), "w", encoding="utf-8") as f:
    f.write('DISPLAY_NAME = "到 t.me/x 領取"\n')
with open(os.path.join(ws, "strategies", "broken.py"), "w", encoding="utf-8") as f:
    f.write('DISPLAY_NAME = "x\n')
ok("讀得到名稱、（）照 fold", sn.label("eth_ma", ws) == "ETH 均線交叉(4h)", sn.label("eth_ma", ws))
ok("網址名稱退代號", sn.label("flat", ws) == "flat")
ok("解析失敗退代號", sn.label("broken", ws) == "broken")
ok("沒有這支退代號", sn.label("gone", ws) == "gone")
ok("路徑樣的代號不去讀", sn.label("../eth_ma", ws) == "../eth_ma")

# ── 3. 五個發送點 ────────────────────────────────────────────────────────────
sent, landed = [], [None]
sys.modules["lib.notify"] = types.SimpleNamespace(send_text=lambda m: sent.append(m))
sys.modules["lib.events"] = types.SimpleNamespace(emit=lambda t, **p: landed[0])

os.environ["BLAVE_AGENT_BASE"] = os.path.join(ws, "_no_base")
cwd = os.getcwd()
os.chdir(ws)
os.makedirs("state", exist_ok=True)
try:
    spec = importlib.util.spec_from_file_location("wfb_names", os.path.join(ROOT, "manager", "wait_for_bar.py"))
    wfb = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(wfb)
    spec = importlib.util.spec_from_file_location("af_names", os.path.join(ROOT, "manager", "alert_failure.py"))
    af = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(af)

    when = datetime(2026, 11, 5, 9, 0)
    calls = {
        "strategy_failed": lambda: af.alert("eth_ma", 1, "Traceback"),
        "bar_stale": lambda: wfb._alert_stale("eth_ma", when, 7, "ETHUSDT"),
        "bar_stale lag": lambda: wfb._alert_lag("eth_ma", 20, "ETHUSDT"),
        "dead_members": lambda: wfb._note_dead("eth_ma", {}, ["2330"], ["2330"]),
        "scheduler_error": lambda: wfb._alert_wrapper_error("eth_ma", ValueError("x")),
    }
    for name, call in calls.items():
        landed[0], sent[:] = 1762300000000000, []
        call()
        ok(f"{name}:事件落檔了就不送(平台送)", sent == [], sent)
        landed[0] = None
        for p in ("strategies/eth_ma/failure_alert_state.json", "state/bar_wait/eth_ma.json"):
            if os.path.exists(p):
                os.remove(p)
        call()
        zh = name != "strategy_failed"   # alert_failure 那則是英文,不加引號
        ok(f"{name}:落不了檔才送,寫名稱" + (",包「」" if zh else ""), len(sent) == 1 and ("「ETH 均線交叉(4h)」" if zh else "Strategy ETH 均線交叉(4h) failed") in sent[0]
           and "eth_ma" not in sent[0], sent)
    landed[0], sent[:] = 1762300000000000, []
    wfb._alert_stale("eth_ma", when, 7, "ETHUSDT", computed=True)
    ok("bar_stale computed=true 平台不送,照送", len(sent) == 1 and "ETH 均線交叉(4h)" in sent[0], sent)
finally:
    os.chdir(cwd)

print(f"\n{len(red)} 紅" if red else "\ncheck_strategy_names_lib: ALL PASS")
sys.exit(1 if red else 0)
