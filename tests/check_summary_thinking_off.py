"""背景滾動摘要(runtime/session_store._llm_summarize)明寫關思考;只在 DeepSeek 模型帶 thinking 欄位。"""
import io
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "runtime"))
import session_store as ss  # noqa: E402

fails = 0


def t(name, ok):
    global fails
    print(("PASS  " if ok else "FAIL  ") + name)
    fails += 0 if ok else 1


sent = []


class _Resp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def fake_urlopen(req, timeout=None):
    sent.append(json.loads(req.data.decode()))
    return _Resp(json.dumps({"content": [{"type": "text", "text": "摘要"}], "stop_reason": "end_turn"}).encode())


ss.urllib.request.urlopen = fake_urlopen
turns = [(1, "user", "hello"), (2, "assistant", "hi")]

out = ss._llm_summarize("", turns)
t("DeepSeek 摘要:請求帶 thinking disabled、max_tokens 不變", out == "摘要" and sent[-1].get("thinking") == {"type": "disabled"}
  and sent[-1]["max_tokens"] == ss.SUMMARY_MAX_TOKENS and "deepseek" in sent[-1]["model"])

ss.SUMMARY_MODEL = "anthropic/claude-haiku-9"
ss._llm_summarize("", turns)
t("非 DeepSeek 模型:不送 thinking 欄位", "thinking" not in sent[-1])

print(f"\n{fails} FAIL" if fails else "\nALL PASS")
sys.exit(1 if fails else 0)
