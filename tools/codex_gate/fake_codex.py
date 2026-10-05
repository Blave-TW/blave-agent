"""Stand-in for `codex exec --json` so the gate's plumbing and judges can be checked
without spending ChatGPT quota (gate.py --fake good|bad).

good: does what the rules ask — install / fork, quality check with --context, backtest unless do-not-run,
      deletes the download, says the chart has no indicator line.
bad:  touches nothing and replies that it did not install — every judged scenario fails.
Reads the prompt on stdin and `-C <cwd>` from argv, like the real binary.
"""
import json
import os
import re
import shutil
import subprocess
import sys


def emit(event):
    print(json.dumps(event, ensure_ascii=False), flush=True)


def sh(cwd, n, *argv):
    proc = subprocess.run(argv, cwd=cwd, capture_output=True, text=True, encoding="utf-8",
                          errors="replace")
    emit({"type": "item.completed", "item": {
        "id": f"item_{n}", "type": "command_execution", "command": " ".join(argv),
        "aggregated_output": (proc.stdout + proc.stderr)[-2000:], "exit_code": proc.returncode,
        "status": "completed" if proc.returncode == 0 else "failed"}})
    return proc.returncode


def strategy_name(path):
    with open(path, encoding="utf-8") as f:
        return re.search(r'^STRATEGY_NAME\s*=\s*"([^"]+)"', f.read(), re.M).group(1)


def good(cwd, prompt, py):
    lib = re.search(r"（#(\d+)）已經下載好了", prompt)
    if lib:
        src = os.path.join(cwd, "tmp", f"library_{lib.group(1)}.py")
        name = strategy_name(src)
        dest = os.path.join(cwd, "strategies", name, "strategy.py")
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        shutil.move(src, dest)
    else:
        base = os.path.join(cwd, "strategies", "gate_sma_trend", "strategy.py")
        name = "gate_sma_trend_custom"
        dest = os.path.join(cwd, "strategies", name, "strategy.py")
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(base, encoding="utf-8") as f:
            code = f.read().replace('"gate_sma_trend"', f'"{name}"')
        with open(dest, "w", encoding="utf-8") as f:
            f.write(code)
    rel = os.path.relpath(dest, cwd)
    ctx = "install" if lib else "fork"
    if sh(cwd, 1, py, os.path.join("lib", "quality_check.py"), "--context", ctx, rel) == 2:
        return "這支策略的結束日期寫死了，品質檢查判定為嚴重問題，所以我沒有跑回測。"
    sh(cwd, 2, py, rel)
    return "裝好了，回測跑完。這支策略沒有宣告要畫的線，所以回測圖上不會有指標線。"


def main():
    cwd = sys.argv[sys.argv.index("-C") + 1]
    prompt = sys.stdin.read()
    emit({"type": "thread.started", "thread_id": "fake"})
    emit({"type": "turn.started"})
    if os.environ.get("CODEX_GATE_FAKE") == "good":
        text = good(cwd, prompt, os.environ.get("BLAVE_PYTHON") or sys.executable)
    else:
        text = "我沒有安裝這支策略，也沒有執行回測。要我繼續嗎？"
    emit({"type": "item.completed", "item": {"id": "item_9", "type": "agent_message", "text": text}})
    emit({"type": "turn.completed",
          "usage": {"input_tokens": 0, "cached_input_tokens": 0, "output_tokens": 0}})


if __name__ == "__main__":
    main()
