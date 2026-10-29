"""runtime/local_proxy.py:BLAVE_PROXY_BASE(電腦版本機帳號轉送口)只收解析過的 http://127.0.0.1:<port>[/path]。
userinfo、別的 host、https、沒 port、query／fragment 一律退回 api(稽核 s1 P2-3);agent_turn 與 session_store 兩處都用它。
跑法:python3 tests/check_local_proxy_base.py
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))
import local_proxy as lp  # noqa: E402

red = 0


def t(name, ok):
    global red
    print(("PASS  " if ok else "FAIL  ") + name)
    red += 0 if ok else 1


D = lp.DEFAULT_PROXY_BASE
good = {"http://127.0.0.1:5123/openclaw/proxy": "http://127.0.0.1:5123/openclaw/proxy", "http://127.0.0.1:5123/openclaw/proxy/": "http://127.0.0.1:5123/openclaw/proxy"}
bad = ["", "http://127.0.0.1:1@evil.example/x", "http://evil.example@127.0.0.1:5/x", "http://u:p@127.0.0.1:5/x", "https://127.0.0.1:5/x",
       "http://127.0.0.1/x", "http://127.0.0.1:abc/x", "http://localhost:5/x", "http://127.0.0.2:5/x", "http://127.0.0.1:5/x?y=1",
       "http://127.0.0.1:5/x#f", "http://127.0.0.1.evil.example:5/x", "http://[::1]:5/x", "//127.0.0.1:5/x", "http://127.0.0.1:0/x"]
for v, want in good.items():
    t("收:" + v, lp.proxy_base({"BLAVE_PROXY_BASE": v}) == want)
for v in bad:
    t("不收,退回 api:" + repr(v), lp.proxy_base({"BLAVE_PROXY_BASE": v}) == D)
t("沒設 = api", lp.proxy_base({}) == D)
for name in ("agent_turn.py", "session_store.py"):
    src = open(os.path.join(ROOT, "runtime", name), encoding="utf-8").read()
    t(name + " 用 local_proxy.proxy_base(),沒有字串前綴比對", "PROXY_BASE_URL = local_proxy.proxy_base()" in src and 'startswith("http://127.0.0.1:")' not in src)
print(("\n%d 紅" % red) if red else "\nALL PASS")
sys.exit(1 if red else 0)
