"""主模型是 DeepSeek 時,引擎的 small/fast 模型設成不在型錄裡的幕後 id(runtime/agent_turn.background_model_env)。"""
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
src = open(os.path.join(ROOT, "runtime", "agent_turn.py"), encoding="utf-8").read()
ns = {}
exec(re.search(r'^BACKGROUND_MODEL = .*?(?=^def _relay_mode)', src, re.S | re.M).group(0), ns)
env = ns["background_model_env"]
fails = 0


def t(name, ok):
    global fails
    print(("PASS  " if ok else "FAIL  ") + name)
    fails += 0 if ok else 1


bg = ns["BACKGROUND_MODEL"]
for m in ("deepseek/deepseek-v4-pro", "deepseek-v4-flash"):
    e = env(m)
    t(f"{m}:SMALL_FAST 與 DEFAULT_HAIKU 都設成幕後 id", e == {"ANTHROPIC_SMALL_FAST_MODEL": bg, "ANTHROPIC_DEFAULT_HAIKU_MODEL": bg})
t("幕後 id 含 deepseek(proxy 照它路由)、不是型錄裡的 v4-flash / v4-pro", "deepseek" in bg and not re.search(r"v4-(flash|pro)", bg))
t("Claude 主模型、沒有模型:不設", env("anthropic/fable-5-1") == {} and env(None) == {})
t("只在 relay 或 proxy 模式套用(本機自己的訂閱不設)",
  re.search(r"if _relay_mode\(\) or os\.environ\.get\(\"BLAVE_PROXY_TOKEN\"\):\n\s+turn_env\.update\(background_model_env\(model\)\)", src) is not None)

relay = open(os.path.join(ROOT, "shell", "llmrelay.js"), encoding="utf-8").read()
models = re.search(r'models: Object\.freeze\(\[([^\]]*)\]\)', relay).group(1)
t("轉送口型錄沒有幕後 id(會被當旁支)", bg.split("/")[-1] not in models and bg not in models)

print(f"\n{fails} FAIL" if fails else "\nALL PASS")
sys.exit(1 if fails else 0)
