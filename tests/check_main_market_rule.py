"""主要市場(spec market-pref-2026-11-09 §6):--main-market → main_market_rule 接在兩條引擎的 preferences_rule() 後面;
web_bridge 從 context.main_market 帶旗標。all、沒帶、怪值整段不出、不 exit 2。
Run: cd blave-agent && .venv/bin/python tests/check_main_market_rule.py
"""
import os
import shutil
import subprocess
import sys
import tempfile
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))
_tmp = tempfile.mkdtemp(prefix="check-main-market-")
STATE = os.path.join(_tmp, "state")
os.makedirs(STATE)
os.environ.update({
    "BLAVE_AGENT_BASE": _tmp,
    "BLAVE_AGENT_STATE": STATE,
    "BLAVE_AGENT_WORKSPACE": os.path.join(_tmp, "ws"),
    "BLAVE_AGENT_DB": os.path.join(_tmp, "session.db"),
    "BLAVE_AGENT_MODEL_PREFS": os.path.join(STATE, "model_prefs.json"),
    "BLAVE_AGENT_WEB_QUEUE": os.path.join(STATE, "web_queue.json"),
})
os.environ.pop("BLAVE_PROXY_TOKEN", None)
sys.modules.setdefault("claude_agent_sdk", types.ModuleType("claude_agent_sdk"))
import agent_turn as at  # noqa: E402
import web_bridge as wb  # noqa: E402

fails = []


def t(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else f" — {detail!r}"))
    if not cond:
        fails.append(name)


WANT = ("\n\n---\n\n## 主要市場（runtime 規則）\n用戶主要做{n}。用戶沒講市場或標的時，以{n}為預設來挑資料、舉例和建策略；"
        "用戶講了別的市場就照他講的做，不必提醒他設定過主要市場。\n")
for v, name in (("crypto", "加密貨幣"), ("twstock", "台股"), ("txf", "台指期"), ("usstock", "美股")):
    t(f"{v} → 那一段寫「{name}」,逐字同 spec", at.main_market_rule(v) == WANT.format(n=name), at.main_market_rule(v))
for v in ("all", None, "", "stock", "TXF", 1, ["crypto"]):
    t(f"{v!r} → 空字串", at.main_market_rule(v) == "")

src = open(os.path.join(ROOT, "runtime", "agent_turn.py"), encoding="utf-8").read()
t("Claude 那條:system prompt 裡接在 preferences_rule() 後面",
  "+ preferences_rule() + main_market_rule(main_market)\n        + reply_lang_rule(lang_msg, reply_lang)" in src)
cp = at._codex_prompt("PROMPT", at.LocalSink("s1"), False, main_market="txf")
t("Codex 那條:[Runtime 規則…] 前綴有那一段、在偏好之後、在 prompt 之前",
  at.main_market_rule("txf") in cp and cp.index(at.main_market_rule("txf")) > cp.index("目前") and cp.index(at.main_market_rule("txf")) < cp.index("PROMPT"), cp[:200])
t("Codex 那條:沒帶就沒有", "主要市場（runtime 規則）" not in at._codex_prompt("PROMPT", at.LocalSink("s1"), False))
t("Codex 呼叫點把 main_market 交進 _codex_prompt", "codex_mcp_blocked,\n                              main_market), WORKSPACE," in src)
t("argparse 不設 choices、交進 run_turn",
  'parser.add_argument("--main-market", default=None)' in src and "main_market=args.main_market," in src)

# 怪值不能讓 argparse exit 2:真的跑一次 parse(只到 parse_args,不進回合)
probe = ("import sys, types; sys.modules['claude_agent_sdk']=types.ModuleType('claude_agent_sdk'); sys.path.insert(0, %r); "
         "import agent_turn as at, argparse\n"
         "orig = argparse.ArgumentParser.parse_args\n"
         "def pa(self, *a, **k):\n    ns = orig(self, *a, **k); print('MM=' + repr(ns.main_market)); sys.exit(0)\n"
         "argparse.ArgumentParser.parse_args = pa\nat.main()\n") % os.path.join(ROOT, "runtime")
for flag, want in (("--main-market=txf", "'txf'"), ("--main-market=stock", "'stock'"), (None, "None")):
    argv = [sys.executable, "-c", probe, "--delivery", "local"] + ([flag] if flag else []) + ["--", "s1", "hi"]
    r = subprocess.run(argv, capture_output=True, text=True, env={**os.environ}, timeout=60)
    t(f"argparse 收 {flag or '(沒帶)'} → exit 0、值 {want}", r.returncode == 0 and ("MM=" + want) in r.stdout, (r.returncode, r.stdout[-200:], r.stderr[-300:]))

# web_bridge:context.main_market → entry → 合法值才帶旗標
wb.ack_message = lambda mid: None
wb._post_chunk = lambda chunk, log=False: None


def ingest(mid, ctx):
    wb._queues.clear()
    wb._seen.clear()
    wb._ingest({"type": "user_message", "message_id": mid, "session_id": "s1", "content": "hi", "context": ctx})
    return (wb._queues.get("s1") or [None])[-1]


t("context.main_market 收進佇列 entry", ingest("m1", {"main_market": "crypto"}).get("main_market") == "crypto")
t("沒這個鍵 → entry 是 None", ingest("m2", {}).get("main_market") is None)


class FakeProc:
    returncode = 0

    def poll(self):
        return 0


cmds = {}
real = wb.subprocess.Popen
try:
    for v in ("crypto", "twstock", "txf", "usstock", "all", None, "stock", "crypto --help", 3):
        wb.subprocess.Popen = lambda cmd, *a, _v=v, **kw: (cmds.__setitem__(repr(_v), cmd), FakeProc())[1]
        wb.run_agent_turn("s1", "hi", main_market=v)
finally:
    wb.subprocess.Popen = real


def flags(v):
    return [a for a in cmds[repr(v)] if a.startswith("--main-market")]


t("crypto → --main-market=crypto(單一 argv、在 -- 之前)",
  flags("crypto") == ["--main-market=crypto"] and cmds["'crypto'"].index("--main-market=crypto") < cmds["'crypto'"].index("--"))
t("四個市場各帶自己的值", all(flags(v) == ["--main-market=" + v] for v in ("twstock", "txf", "usstock")))
t("all、沒送、怪值都不帶", all(flags(v) == [] for v in ("all", None, "stock", "crypto --help", 3)), cmds)
wsrc = open(os.path.join(ROOT, "runtime", "web_bridge.py"), encoding="utf-8").read()
t("_worker 把 entry 的 main_market 交給 run_agent_turn", 'main_market=entry.get("main_market")' in wsrc)

shutil.rmtree(_tmp, ignore_errors=True)
print(f"\n{len(fails)} failed" if fails else "\nall passed")
sys.exit(1 if fails else 0)
