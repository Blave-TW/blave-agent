"""下單方式:整個組合一種(0.1.26)。

  1. lib/execute 與 runtime/exec_style 的兩支共用函式逐字相同(runtime 不 import workspace lib)
  2. 遷移規則(portfolio_execution):有 execution_default 照它;沒有 → 舊 per-strategy map 依金額加權、
     最重的勝、平手市價;金額 0 / 表外 entry 不算
  3. resolve_execution 一律回組合設定,不看最大貢獻者是誰;設定檔讀不到回 None(延後那一腿)
  4. runtime _cmd_execution:新格式寫 execution_default + 展開 map;舊格式逐支跟存著的 map 比(沒變 → 維持現值、
     變的都同一種 → 它、否則金額加權;混雜設定原封重送不改);
     兩份都帶時 execution_default 勝;任何一個壞 spec 整包拒收、檔案不動
  5. _cmd_amounts:改成員前先釘住設定,map 重新展開給新成員(舊 lib 照最大貢獻者讀 map,也拿到同一種)
  6. 台灣券商與原生單位:統一、群益在 reconciler 就轉走、不經 dispatch_order;口數／股數列在 dispatch_order
     一律單筆市價——組合設定是 TWAP／追價也一樣

Run: cd blave-agent && .venv/bin/python tests/check_exec_global.py
"""
import ast
import json
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
WS = tempfile.mkdtemp(prefix="exec-global-")
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.pop("BLAVE_AGENT_LOCAL", None)
os.chdir(WS)
os.makedirs(os.path.join(WS, "manager"))

from lib import execute as ex  # noqa: E402
sys.path.insert(0, os.path.join(ROOT, "runtime"))
import exec_style  # noqa: E402
import command_listener as cl  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


def defs(path):
    tree = ast.parse(open(path, encoding="utf-8").read())
    return {n.name: ast.unparse(n) for n in tree.body if isinstance(n, ast.FunctionDef)}


# ── 1. 兩份逐字相同 ──
lib_defs = defs(os.path.join(ROOT, "lib", "execute.py"))
rt_defs = defs(os.path.join(ROOT, "runtime", "exec_style.py"))
for name in ("_exec_spec_clean", "portfolio_execution"):
    check(name in lib_defs and lib_defs.get(name) == rt_defs.get(name),
          f"1 {name}: lib/execute.py == runtime/exec_style.py")

# ── 2. 遷移規則 ──
TW30 = {"type": "twap", "duration_min": 30}
TW15 = {"type": "twap", "duration_min": 15}
CH = {"type": "chase"}
MK = {"type": "market"}
CX = {"type": "custom", "module": "my_exec"}
CASES = [
    ("execution_default 照存的回(不跟 map 比)",
     {"execution_default": CH, "execution": {"a": TW30}, "amounts": {"a": 100}}, CH),
    ("壞的 execution_default 原樣回(dispatch_order 那層大聲退市價)",
     {"execution_default": {"type": "limit"}, "amounts": {"a": 1}}, {"type": "limit"}),
    ("沒有 map、沒有 amounts → 市價", {}, MK),
    ("全部一樣 → 沿用", {"execution": {"a": TW30, "b": TW30}, "amounts": {"a": 100, "b": 50}}, TW30),
    ("金額加權:大的 TWAP 贏過兩支小的市價",
     {"execution": {"a": TW30}, "amounts": {"a": 300, "b": 100, "c": 100}}, TW30),
    ("金額加權:兩支市價加起來比較重 → 市價",
     {"execution": {"a": TW30}, "amounts": {"a": 100, "b": 80, "c": 80}}, MK),
    ("平手 → 市價", {"execution": {"a": TW30, "b": CH}, "amounts": {"a": 100, "b": 100}}, MK),
    ("TWAP 時長不同算不同:15 分 vs 30 分平手 → 市價",
     {"execution": {"a": TW30, "b": TW15}, "amounts": {"a": 1, "b": 1}}, MK),
    ("金額 0 不算票(暫停中的那支設了追價)",
     {"execution": {"a": TW30, "b": CH}, "amounts": {"a": 10, "b": 0}}, TW30),
    ("表外 entry(不在 amounts)不算票",
     {"execution": {"x": CH}, "amounts": {"a": 10}}, MK),
    ("時長字串、超出範圍照機器端 clamp 正規化",
     {"execution": {"a": {"type": "twap", "duration_min": "2000"}}, "amounts": {"a": 5}},
     {"type": "twap", "duration_min": 1440}),
    ("壞 spec(布林時長)當市價",
     {"execution": {"a": {"type": "twap", "duration_min": True}}, "amounts": {"a": 5}}, MK),
    ("金額讀不懂 / NaN / inf 不算票",
     {"execution": {"a": CH, "b": TW30, "c": TW30}, "amounts": {"a": 5, "b": "x", "c": float("nan")}}, CH),
    ("只有舊 weights 的 config 用 weights 當權重",
     {"execution": {"a": CH}, "weights": {"a": 0.6, "b": 0.4}}, CH),
    ("custom 模組名合法才算", {"execution": {"a": {"type": "custom", "module": "my_exec"}}, "amounts": {"a": 1}},
     {"type": "custom", "module": "my_exec"}),
    ("custom 模組名不合法當市價", {"execution": {"a": {"type": "custom", "module": "../x"}}, "amounts": {"a": 1}}, MK),
    ("config 不是 dict → 市價", None, MK),
]
for name, cfg, want in CASES:
    got_lib, got_rt = ex.portfolio_execution(cfg), exec_style.portfolio_execution(cfg)
    check(got_lib == want and got_rt == want, f"2 {name}: {got_lib}")

# ── 3. resolve_execution 不看最大貢獻者 ──
cfg = {"execution_default": MK, "execution": {"big": TW30}, "amounts": {"big": 900, "small": 10}}
contrib = [{"strategy": "big", "contribution": 900}, {"strategy": "small", "contribution": 10}]
check(ex.resolve_execution(contrib, cfg) == MK,
      "3 組合設定市價:最大貢獻者 map 裡是 TWAP 也一律市價")
cfg = {"execution_default": CH, "execution": {}, "amounts": {"big": 900, "small": 10}}
check(ex.resolve_execution(contrib, cfg) == CH and ex.resolve_execution([], cfg) == CH
      and ex.resolve_execution(None, cfg) == CH,
      "3 組合設定追價:不論誰貢獻、沒有貢獻者(移出平倉那一腿)都追價")
with open("manager/portfolio_config.json", "w") as f:
    f.write("{not json")
check(ex.resolve_execution(contrib) is None, "3 設定檔寫到一半(讀不到)→ None,這一腿延後")
os.remove("manager/portfolio_config.json")


# ── 4. runtime _cmd_execution ──
CFG = os.path.join(WS, "manager", "portfolio_config.json")
cl._execution_engine_ready = lambda: True


def put(cfg):
    json.dump(cfg, open(CFG, "w"))


def got():
    return json.load(open(CFG))


put({"amounts": {"a": 100, "b": 50, "z": 0}, "exchanges": {"a": "paper", "b": "paper", "z": "paper"},
     "self_ledger": True})
r = cl._cmd_execution({"execution_default": {"type": "twap", "duration_min": "45"}})
c = got()
check(r == "execution=twap" and c["execution_default"] == {"type": "twap", "duration_min": 45}
      and c["execution_fanned_from"] == {"type": "twap", "duration_min": 45}
      and c["execution"] == {n: {"type": "twap", "duration_min": 45} for n in ("a", "b", "z")}
      and c["amounts"] == {"a": 100, "b": 50, "z": 0} and c["self_ledger"] is True,
      f"4 新格式:寫 execution_default、展開到每支成員(含金額 0),其他欄位不動 ({r} {c})")
cl._cmd_execution({"execution_default": {"type": "market"}})
c = got()
check(c["execution_default"] == MK and c["execution"] == {}, "4 改回市價:展開 map 是空的(舊讀法 no entry = 市價)")

# 舊格式
put({"amounts": {"a": 100, "b": 50}, "execution_default": MK, "execution": {}})
cl._cmd_execution({"execution": {"a": TW30, "b": TW30}})
check(got()["execution_default"] == TW30, "4 舊格式全部一樣 → 那一種")
put({"amounts": {"a": 100, "b": 50, "c": 10}, "execution_default": TW30,
     "execution": {"a": TW30, "b": TW30, "c": TW30}})
cl._cmd_execution({"execution": {"a": TW30, "b": TW30, "c": CH}})
check(got()["execution_default"] == CH and got()["execution"] == {"a": CH, "b": CH, "c": CH},
      "4 舊網頁改一列(金額最小那支改追價)→ 改的那個值勝,展開回每支")
put({"amounts": {"a": 100, "b": 50, "c": 10}, "execution_default": TW30,
     "execution": {"a": TW30, "b": TW30, "c": TW30}})
cl._cmd_execution({"execution": {"a": TW30, "b": TW30}})
check(got()["execution_default"] == MK, "4 舊網頁把一列改成市價(map 少一個 entry)→ 市價")
put({"amounts": {"a": 100, "b": 50, "c": 10}, "execution_default": MK, "execution": {}})
cl._cmd_execution({"execution": {"a": TW30, "c": CH}})
check(got()["execution_default"] == TW30, "4 改了兩支、改成不同的兩種 → payload 金額加權(a 100 對 b 50、c 10)")
# 稽核 A-P1-1:舊網頁每次存金額都整份重送 map——設定混雜、原封重送不是「用戶改了少數派那一支」
for name, cfg0 in (
        ("沒有 execution_default(大策略市價、小策略 TWAP)",
         {"amounts": {"big": 1000, "small": 10}, "execution": {"small": TW30}}),
        ("execution_default 已釘住、map 是更早的混雜樣子",
         {"amounts": {"big": 1000, "small": 10}, "execution_default": MK, "execution": {"small": TW30}})):
    put(cfg0)
    cl._cmd_execution({"execution": {"small": TW30}})
    check(got()["execution_default"] == MK and got()["execution"] == {},
          f"4 舊網頁存金額時原封重送混雜 map → 維持現值市價,不變成少數派的 TWAP({name})")
put({"amounts": {"big": 1000, "s1": 10, "s2": 10}, "execution": {"s1": TW30}})
cl._cmd_execution({"execution": {"s1": CH, "s2": CH}})
check(got()["execution_default"] == CH, "4 有變的兩支都改成追價 → 追價(沒變的大策略不算)")
put({"amounts": {}})
cl._cmd_execution({"execution": {"a1": TW30}})
check(got()["execution_default"] == TW30, "4 agent 對還沒進組合的策略設 → 那一種")
put({"amounts": {"a": 1}})
cl._cmd_execution({"execution": {}})
check(got()["execution_default"] == MK and got()["execution"] == {}, "4 舊格式空 map → 市價")
put({"amounts": {"a": 1}, "execution_default": MK})
cl._cmd_execution({"execution_default": CH, "execution": {"a": CH}})
check(got()["execution_default"] == CH, "4 兩份都帶(新網頁／電腦版)→ execution_default 勝")

# 複審 1-P3-3:custom 只能由 agent 在機器上設,這個指令不收新的 custom
put({"amounts": {"a": 1, "b": 1}, "execution_default": CX, "execution": {"a": CX, "b": CX}})
before = open(CFG).read()
refused = []
for a in ({"execution_default": CX}, {"execution": {"a": {"type": "custom", "module": "other"}, "b": CX}}):
    try:
        cl._cmd_execution(a)
    except ValueError:
        refused.append(a)
check(len(refused) == 2 and open(CFG).read() == before, "4 新的 custom(execution_default 或 map 裡改成的)整包拒收、檔案不動")
cl._cmd_execution({"execution": {"a": CX, "b": CX}})
check(got()["execution_default"] == CX, "4 舊網頁原封重送存著的 custom map → 照收、維持現值")
cl._cmd_execution({"execution": {"a": CH, "b": CH}})
check(got()["execution_default"] == CH, "4 從 custom 改成別的 → 照收")
put({"amounts": {"a": 1}})
before = open(CFG).read()
BAD = [
    {}, {"execution": []}, {"execution_default": None}, {"execution_default": "market"},
    {"execution_default": {"type": "limit"}}, {"execution_default": {"type": "twap"}},
    {"execution_default": {"type": "twap", "duration_min": True}},
    {"execution_default": {"type": "custom", "module": "../x"}},
    {"execution_default": CH, "execution": {"a": {"type": "nope"}}},
    {"execution_default": CH, "execution": {"../x": CH}},
    {"execution": {"a": TW30, "b": {"type": "twap", "duration_min": "x"}}},
    {"execution": {f"s{i}": CH for i in range(201)}},
]
bad_ok = []
for a in BAD:
    try:
        cl._cmd_execution(a)
        bad_ok.append(a)
    except ValueError:
        pass
check(not bad_ok and open(CFG).read() == before, f"4 壞 spec 整包拒收、檔案不動 ({bad_ok[:2]})")
open(CFG, "w").write("{half")
try:
    cl._cmd_execution({"execution_default": CH})
    check(False, "4 設定檔讀不到 → 拒絕")
except RuntimeError:
    check(open(CFG).read() == "{half", "4 設定檔讀不到 → 拒絕、不重建")

# ── 5. _cmd_amounts 釘住、重新展開 ──
cl._sync_strategy_crons = lambda names: None
cl._strategy_has_interval = lambda n: True
cl._strategy_is_portfolio = lambda n: False
put({"amounts": {"a": 100, "b": 50}, "exchanges": {"a": "", "b": ""}, "execution": {"a": TW30}})
cl._cmd_amounts({"amounts": {"a": 100, "b": 50, "c": 500}})
c = got()
check(c["execution_default"] == TW30 and c["execution"] == {n: TW30 for n in ("a", "b", "c")},
      f"5 舊 config 存金額:用改之前的成員釘住(a 的 TWAP),新成員 c 也展開到 ({c.get('execution_default')})")
cl._cmd_amounts({"amounts": {"c": 500}})
check(got()["execution_default"] == TW30 and got()["execution"] == {"c": TW30},
      "5 已經有 execution_default:成員怎麼換都不重算,map 跟著成員")


# 複審 1-P2-1:新 runtime + 舊 workspace,agent 照舊 references 直接改 map → 存金額不能靜默洗掉
put({"amounts": {"A": 1000, "B": 100}, "exchanges": {"A": "", "B": ""}, "execution_default": MK, "execution": {"B": CX},
     "execution_fanned_from": MK})
cl._cmd_amounts({"amounts": {"A": 1000, "B": 100}})
c = got()
check(c["execution_default"] == CX and c["execution"] == {"A": CX, "B": CX},
      f"5 agent 在 runtime 外改了 map(B 設 custom)→ 存金額時換算進 execution_default,不洗掉 ({c.get('execution_default')})")
put({"amounts": {"A": 1000, "B": 100}, "exchanges": {"A": "", "B": ""}, "execution_default": TW30,
     "execution": {"A": TW30, "B": TW30}})
cl._cmd_amounts({"amounts": {"A": 1000, "B": 100, "C": 5}})
check(got()["execution_default"] == TW30 and got()["execution"] == {n: TW30 for n in "ABC"},
      "5 map 是 runtime 自己展開的那份 → 照舊釘住,新成員跟著展開")
put({"amounts": {"A": 1000, "B": 100}, "exchanges": {"A": "", "B": ""}, "execution_default": TW30,
     "execution": {"A": {"type": "twap", "duration_min": "30"}, "B": CH}, "execution_fanned_from": TW30})
cl._cmd_amounts({"amounts": {"A": 1000, "B": 100}})
check(got()["execution_default"] == CH, "5 手改只動了 B(A 只是寫法不同)→ 採用 B 改成的追價")
# 整合稽核 M1:agent 照 references/deployment.md 直接在 amounts 加一支 → map 還沒展開到它,不算改成市價
put({"amounts": {"A": 1000, "B": 100, "N": 300}, "exchanges": {"A": "", "B": "", "N": ""}, "execution_default": TW30,
     "execution": {"A": TW30, "B": TW30}, "execution_fanned_from": TW30})
cl._cmd_amounts({"amounts": {"A": 1000, "B": 100, "N": 300}})
check(got()["execution_default"] == TW30 and got()["execution"] == {n: TW30 for n in "ABN"},
      f"5 TWAP 時 agent 手加一支成員(map 沒有它)→ 存金額維持 TWAP、展開到新成員 ({got()['execution_default']})")
put({"amounts": {"A": 1000, "Z": 0}, "exchanges": {"A": "", "Z": ""}, "execution_default": CH, "execution": {"A": CH},
     "execution_fanned_from": CH})
cl._cmd_amounts({"amounts": {"A": 1000, "Z": 0}})
check(got()["execution_default"] == CH and got()["execution"] == {"A": CH, "Z": CH},
      "5 追價時手加一支金額 0 的成員 → 維持追價")
check(got().get("execution_fanned_from") == CH, "5 存金額時記下 map 是從哪一種展開的(execution_fanned_from)")
# 整合稽核 N1:agent 照新版 references 直接改 execution_default、沒動 map → 存金額不能蓋回 map 那一種
T60 = {"type": "twap", "duration_min": 60}
for want in (CH, T60, MK, CX):
    stale = CH if want == CX else TW30
    put({"amounts": {"A": 1000, "B": 100}, "exchanges": {"A": "", "B": ""}, "execution_default": want,
         "execution": {"A": stale, "B": stale}, "execution_fanned_from": stale})
    cl._cmd_amounts({"amounts": {"A": 1000, "B": 100}})
    c = got()
    check(c["execution_default"] == want and c["execution_fanned_from"] == want
          and c["execution"] == exec_style.fan_out(want, ["A", "B"]),
          f"5 agent 直接把 execution_default 從 {stale['type']} 改成 {want} → 存金額保留、map 重新展開 ({c['execution_default']})")
put({"amounts": {"A": 1000, "B": 100}, "exchanges": {"A": "", "B": ""}, "execution_default": TW30,
     "execution": {"A": TW30, "B": CH}, "execution_fanned_from": TW30})
cl._cmd_amounts({"amounts": {"A": 1000, "B": 100}})
check(got()["execution_default"] == CH, "5 有 execution_fanned_from 時舊 references 的 agent 改 map(B 追價)照樣換算進來")
# 有 execution_default、沒有 execution_fanned_from = 新版 references 的 agent 在舊 map 上改了 default → 保留 default
for want in (CH, T60, MK, CX):
    put({"amounts": {"A": 1000, "B": 100}, "exchanges": {"A": "", "B": ""}, "execution_default": want,
         "execution": {"A": TW30, "B": CH}})
    cl._cmd_amounts({"amounts": {"A": 1000, "B": 100}})
    check(got()["execution_default"] == want and got()["execution_fanned_from"] == want,
          f"5 有 default 沒有 fanned_from(舊的混雜 map)→ 保留 agent 寫的 {want}")
put({"amounts": {"A": 1000, "B": 100}, "exchanges": {"A": "", "B": ""}, "execution": {"B": CH}})
cl._cmd_amounts({"amounts": {"A": 1000, "B": 100}})
check(got()["execution_default"] == MK, "5 兩個欄位都沒有的舊設定 → 從 map 金額加權換算(A 市價 1000 勝)")
# 稽核 F1:舊網頁存金額是先原封送 execution、再送 amounts——舊 agent 改過的 map 不能在第一步被洗掉
for b_spec in (CH, CX):
    put({"amounts": {"A": 1000, "B": 100}, "exchanges": {"A": "", "B": ""}, "execution_default": TW30,
         "execution": {"A": TW30, "B": b_spec}, "execution_fanned_from": TW30})
    cl._cmd_execution({"execution": {"A": TW30, "B": b_spec}})
    cl._cmd_amounts({"amounts": {"A": 1000, "B": 100}})
    c = got()
    check(c["execution_default"] == b_spec and c["execution_fanned_from"] == b_spec,
          f"5 舊 agent 把 B 改成 {b_spec['type']},舊網頁接著原封送 execution 再送 amounts → 換算進來,不洗掉 ({c['execution_default']})")
# P3:execution_fanned_from 是壞值 → 當成沒有這個欄位(信 default)
put({"amounts": {"A": 1000, "B": 100}, "exchanges": {"A": "", "B": ""}, "execution_default": CH,
     "execution": {"A": TW30, "B": TW30}, "execution_fanned_from": {"type": "limit"}})
cl._cmd_amounts({"amounts": {"A": 1000, "B": 100}})
check(got()["execution_default"] == CH and got()["execution_fanned_from"] == CH,
      "5 execution_fanned_from 手寫成壞值 → 當成沒有,保留 agent 寫的追價")
# P3:刪除(沒路由的成員)時 execution 裡那一筆一起拿掉,之後舊格式不帶它也不會被當成改成市價
put({"amounts": {"A": 1000, "B": 100}, "exchanges": {"A": "", "B": ""}, "execution_default": TW30,
     "execution": {"A": TW30, "B": TW30}, "execution_fanned_from": TW30})
cl._prune_unrouted_member("B")
c = got()
check("B" not in c["execution"] and "B" not in c["amounts"], "5 刪除策略時 execution map 裡那一筆一起拿掉")
cl._cmd_execution({"execution": {"A": TW30}})
check(got()["execution_default"] == TW30, "5 刪掉之後舊格式只帶 A → 維持 TWAP,不變市價")


def old_lib_resolve(contributors, config):
    """The resolve_execution every workspace before 0.1.26 ships (largest contributor's map entry)."""
    m = config.get("execution") or {}
    top = max(contributors, key=lambda c: abs(float(c.get("contribution", 0) or 0)))
    spec = m.get(top.get("strategy"))
    return spec if isinstance(spec, dict) else MK


c = got()
check(all(old_lib_resolve([{"strategy": n, "contribution": 1}], c) == ex.resolve_execution([], c)
          for n in c["amounts"]),
      "5 舊 lib 讀展開後的 map:每一支當最大貢獻者都得到組合設定")

# ── 6. 台灣券商與原生單位 ──
import venue_traits  # noqa: E402  (runtime copy — same table as lib/venue_traits)
from lib import venue_traits as lvt  # noqa: E402
hw = lvt.venues("hand_wired")
check(hw == {"capital", "president"} and venue_traits.venues("hand_wired") == hw,
      f"6 hand_wired 的券商剛好是群益、統一({sorted(hw)})")
src = open(os.path.join(ROOT, "manager", "reconciler.py"), encoding="utf-8").read()
po = src[src.index("def place_order("):]
po = po[:po.index("\ndef ", 1)]
check(po.index("venue_traits.has(exchange, 'hand_wired')") < po.index("dispatch_order("),
      "6 reconciler.place_order:hand_wired 券商在 dispatch_order 之前就轉走(不讀下單方式)")
calls = []
from lib import venue_wiring  # noqa: E402
venue_wiring.auto_place_order = lambda *a, **k: calls.append(a) or {"avg_price": 1, "executed_qty": 1}
put({"execution_default": TW30, "amounts": {"t": 2}})
for typ in ("futures_contracts", "shares"):
    calls.clear()
    res = ex.dispatch_order("TXF", 2, asset_spec={"type": typ}, exchange="paper",
                            contributors=[{"strategy": "t", "contribution": 2}])
    check(isinstance(res, dict) and len(calls) == 1 and not ex.list_inflight(),
          f"6 {typ} 列:組合設定 TWAP 也只下一筆市價,不起執行緒")

print("\n" + ("ALL PASS" if not fails else f"{fails} FAIL"))
sys.exit(1 if fails else 0)
