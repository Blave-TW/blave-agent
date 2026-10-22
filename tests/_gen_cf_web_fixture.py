"""Regenerates web's tests/cf_save_routing_fixture.json (web tests/check_pf_a1_save.js ⑦b) from
tests/_cf_lib_after.py — the real reporter + runtime save + lib aggregate_portfolio. Same inputs as
this repo's check_shell_a1_save.js 「存檔後的路由」; rerun whenever the runtime's routing rule or
the reporter changes.

Run: cd blave-agent && .venv/bin/python tests/_gen_cf_web_fixture.py <web repo dir>
"""
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
H = os.path.join(ROOT, "tests", "_cf_lib_after.py")
if len(sys.argv) != 2 or not os.path.isdir(os.path.join(sys.argv[1], "tests")):
    raise SystemExit("usage: _gen_cf_web_fixture.py <web repo dir>")
OUT = os.path.join(sys.argv[1], "tests", "cf_save_routing_fixture.json")
BTC={"symbol":"BTCUSDT","market":None,"position":1}
TW={"symbol":"2330","market":None,"position":1,"raw_closes":{"2330":1000}}
PC={"weights":{"2330":0.6,"2603":-0.4},"market":None,"raw_closes":{"2330":1000,"2603":200}}
TWS={"symbol":"2603","market":None,"position":-1,"raw_closes":{"2603":200}}
both={"btc":500,"tw":100000}; blank2={"btc":"","tw":""}
P={"env":["paper"],"manifest":["paper"]}; BN={"env":["binance"],"manifest":["binance"]}
def m(*a):
    o={}
    for x in a: o.update(x)
    return o
cases=[
 ["paper_idle","綁模擬帳戶、沒路由(綁之前存的)、下單程式還沒啟動",m(P,{"mode":"idle","before":{"amounts":both,"exchanges":blank2},"send":both,"strategies":{"btc":BTC,"tw":TW}})],
 ["paper_run","綁模擬帳戶、沒路由、下單程式在跑",m(P,{"mode":"run","before":{"amounts":both,"exchanges":blank2},"send":both,"strategies":{"btc":BTC,"tw":TW}})],
 ["paper_halt","綁模擬帳戶、沒路由、暫停中(0.1.28 Wei 實測的狀態)",m(P,{"mode":"halt","before":{"amounts":both,"exchanges":blank2},"send":both,"strategies":{"btc":BTC,"tw":TW}})],
 ["bn_run","綁真實交易所(Binance)、沒路由、在跑",m(BN,{"mode":"run","before":{"amounts":{"btc":500},"exchanges":{"btc":""}},"send":{"btc":500},"strategies":{"btc":BTC}})],
 ["bn_idle","綁真實交易所(Binance)、沒路由、還沒啟動",m(BN,{"mode":"idle","before":{"amounts":{"btc":500},"exchanges":{"btc":""}},"send":{"btc":800},"strategies":{"btc":BTC}})],
 ["paper_routed","已有路由(模擬帳戶)、在跑、改金額",m(P,{"mode":"run","before":{"amounts":both,"exchanges":{"btc":"paper","tw":"paper"}},"send":{"btc":800,"tw":100000},"strategies":{"btc":BTC,"tw":TW}})],
 ["bn_routed","已有路由(Binance)、在跑、改金額",m(BN,{"mode":"run","before":{"amounts":{"btc":500},"exchanges":{"btc":"binance"}},"send":{"btc":800},"strategies":{"btc":BTC}})],
 ["book","帳上有部位(Binance 多 300):單 = 目標 800 − 帳上 300",m(BN,{"mode":"run","before":{"amounts":{"btc":500},"exchanges":{"btc":"binance"}},"send":{"btc":800},"strategies":{"btc":BTC},"book":{"BTCUSDT":{"side":"long","size":300,"mark_price":50000}}})],
 ["two_blank","同時綁兩家、沒路由:runtime 不知道繼承誰、照樣沒路由",{"env":["binance","paper"],"manifest":["binance","paper"],"mode":"run","before":{"amounts":both,"exchanges":blank2},"send":both,"strategies":{"btc":BTC,"tw":TW}}],
 ["s3_manifest","稽核 S3:.env 有 Binance＋模擬、綁定清單只有模擬 → runtime 繼承模擬(台股照路由那家判,不看畫面第一家 Binance)",{"env":["binance","paper"],"manifest":["paper"],"mode":"run","before":{"amounts":both,"exchanges":blank2},"send":both,"strategies":{"btc":BTC,"tw":TW}}],
 ["two_split","同時綁 Binance＋模擬:加密路由 Binance、台股路由模擬 → 兩筆都列",{"env":["binance","paper"],"manifest":["binance","paper"],"mode":"run","before":{"amounts":both,"exchanges":{"btc":"binance","tw":"paper"}},"send":both,"strategies":{"btc":BTC,"tw":TW}}],
 ["two_paper","同時綁 Binance＋模擬、兩支都路由模擬 → 台股與加密都照模擬列",{"env":["binance","paper"],"manifest":["binance","paper"],"mode":"run","before":{"amounts":both,"exchanges":{"btc":"paper","tw":"paper"}},"send":both,"strategies":{"btc":BTC,"tw":TW}}],
 ["two_tw_binance","同時綁 Binance＋模擬、台股路由 Binance → Binance 下不了台股、不列(只列加密)",{"env":["binance","paper"],"manifest":["binance","paper"],"mode":"run","before":{"amounts":both,"exchanges":{"btc":"paper","tw":"binance"}},"send":both,"strategies":{"btc":BTC,"tw":TW}}],
 ["s4_nolib","稽核 S4:綁了沒有 lib 的交易所＋模擬(清單兩家都有)→ runtime 不繼承",{"env":["kucoin","paper"],"manifest":["kucoin","paper"],"libs":{"paper":["order","account"]},"mode":"run","before":{"amounts":{"btc":500},"exchanges":{"btc":""}},"send":{"btc":500},"strategies":{"btc":BTC}}],
 ["typec","投資組合(Type C,台股一多一空)、綁模擬帳戶、沒路由、在跑:空頭壓 0",m(P,{"mode":"run","before":{"amounts":{"pc":1000000},"exchanges":{"pc":""}},"send":{"pc":1000000},"strategies":{"pc":PC}})],
 ["tw_short","單一標的台股做空、綁模擬帳戶、沒路由、在跑:現股不放空、不下單",m(P,{"mode":"run","before":{"amounts":{"tws":100000},"exchanges":{"tws":""}},"send":{"tws":100000},"strategies":{"tws":TWS}})],
 ["old_runtime","舊 runtime(報告沒有 save_routing):退回自己推,單一模擬帳戶照樣對",m(P,{"mode":"run","oldRuntime":True,"before":{"amounts":both,"exchanges":blank2},"send":both,"strategies":{"btc":BTC,"tw":TW}})],
 ["routing_single","綁定集合讀報告的 save_routing(單一模擬):列單",m(P,{"mode":"run","before":{"amounts":{"btc":500},"exchanges":{"btc":""}},"send":{"btc":500},"strategies":{"btc":BTC}})],
 ["none","沒綁交易所:框不列單;存檔後對帳器也一筆都不送",{"env":[],"manifest":[],"mode":"idle","before":{"amounts":both,"exchanges":blank2},"send":{"btc":500,"tw":200000},"strategies":{"btc":BTC,"tw":TW}}],
 ["s7_sinopac","稽核 S7:只綁 sinopac(只有下單 lib):runtime 路由 sinopac、對帳器接不上不送單;框也不列單",{"env":["sinopac"],"manifest":["sinopac"],"libs":{"sinopac":["order"]},"mode":"idle","before":{"amounts":{"tw":100000},"exchanges":{"tw":""}},"send":{"tw":100000},"strategies":{"tw":TW}}],
]
out = []
for key, name, sc in cases:
    q = {k: v for k, v in sc.items() if k not in ("mode", "oldRuntime", "book")}
    p = subprocess.run([sys.executable, H], input=json.dumps(q), capture_output=True, text=True)
    L = json.loads(p.stdout.strip().split("\n")[-1])
    if "error" in L:
        raise SystemExit(key + ": " + L["error"])
    out.append({"key": key, "name": name, "scenario": sc,
                "lib": {"report": {"venues": L["report"]["venues"], "states": L["report"]["states"],
                                   "save_routing": L["report"].get("save_routing")},
                        "before": L["before"], "targets": L["targets"], "exchanges": L["exchanges"]}})
rev = subprocess.run(["git", "-C", ROOT, "log", "-1", "--format=%h"], capture_output=True, text=True).stdout.strip()
json.dump({"_source": "blave-agent tests/_cf_lib_after.py @ " + rev
           + "(真的 reporter＋runtime 存檔＋lib aggregate_portfolio);重產:blave-agent tests/_gen_cf_web_fixture.py <web>",
           "cases": out}, open(OUT, "w"), ensure_ascii=False, indent=1)
for c in out:
    print(c["key"], c["lib"]["exchanges"], c["lib"]["targets"], c["lib"]["report"]["save_routing"])
