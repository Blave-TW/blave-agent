"""電腦版 A′ runtime 那半:`--viewing-env=cloud` 進 prompt、tool chunk 的 `where`。
跑法:python tests/check_viewing_env.py [agent_turn.py 路徑](路徑給突變複本用)
"""
import importlib.util
import os
import sys
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "runtime", "agent_turn.py")
sys.path.insert(0, os.path.join(ROOT, "runtime"))
sdk = types.ModuleType("claude_agent_sdk")
sdk.__getattr__ = lambda name: type(name, (), {})  # 機隊外沒有 SDK;被測的都是純函式
sys.modules["claude_agent_sdk"] = sdk
spec = importlib.util.spec_from_file_location("agent_turn", path)
at = importlib.util.module_from_spec(spec)
spec.loader.exec_module(at)

red = 0


def t(name, ok):
    global red
    print(("PASS  " if ok else "FAIL  ") + name)
    red += 0 if ok else 1


cases = [dict(viewing_strategy="btc_mom", viewing_tab="code"), dict(viewing_view="portfolio"), {}]
for kw in cases:
    base = at.build_prompt("", [], "這支", **kw)
    t(f"沒送/怪值 → prompt 逐字不變 {kw}",
      base == at.build_prompt("", [], "這支", viewing_env=None, cloud_mcp=True, **kw)
      == at.build_prompt("", [], "這支", viewing_env="local", cloud_mcp=True, **kw))
    on = at.build_prompt("", [], "這支", viewing_env="cloud", cloud_mcp=True, **kw)
    off = at.build_prompt("", [], "這支", viewing_env="cloud", cloud_mcp=False, **kw)
    t(f"cloud → 有雲端段、在訊息之前 {kw}",
      "「雲端主機」視角" in on and on.index("「雲端主機」視角") < on.index("[使用者這次的訊息]"))
    t(f"cloud 掛 MCP 講 MCP、沒掛講連不上且不拿本機頂替 {kw}",
      "`blave` MCP" in on and "連不上雲端主機" not in on
      and "連不上雲端主機" in off and "不要改在這台電腦上做同名那支" in off)
    t(f"沒掛 MCP 點名 ssh 與本機金鑰 {kw}", "ssh" in off and "金鑰" in off)
    t(f"掛 MCP 先取連線再照 cloud-handoff(含 NEVER),不說「一律經 MCP」 {kw}",
      "取得連線" in on and "cloud-handoff.md" in on and "NEVER" in on and "一律經" not in on)

W = at._tool_where
t("mcp__blave__* → cloud", W("mcp__blave__get_ssh_access", {}) == "cloud")
t("Bash ssh/scp/sftp/rsync 起頭 → cloud",
  all(W("Bash", {"command": c}) == "cloud" for c in (
      "ssh -o X user@h ls", "  scp a b:c", "sftp h", "rsync -a x h:y", "/usr/bin/ssh h")))
t("其餘 → local", all(w == "local" for w in (
    W("Bash", {"command": "python3 lib/x.py"}), W("Bash", {"command": "cd x && ssh h"}),
    W("Bash", {"command": "sshpass x"}), W("Bash", {}), W("Bash", None),
    W("Read", {"file_path": "/x"}), W("mcp__other__x", {}), W("Edit", {"command": "ssh h"}),
    W("Bash", {"command": "rsync -a a/ b/"}), W("Bash", {"command": "echo ssh | grep s"}))))
t("切段、剝包裝後任一段是遠端 → cloud",
  all(W("Bash", {"command": c}) == "cloud" for c in (
      "grep x .env | ssh h 'cat > .env'", "ls; ssh h ls", "ls\nscp a h:b", "sudo ssh h",
      "sudo -u blaveagent ssh h", "env X=1 ssh h", "X=1 ssh h", "timeout 60 ssh h",
      "nohup ssh h", "command ssh h", "exec ssh h", "'ssh' h", "rsync -a a/ h:b/",
      "rsync -a u@h:x/ y/")))


class Rec(at.WebSink):
    def __init__(self):
        super().__init__(None, "", "s")
        self.sent = []

    def _send(self, chunk):
        self.sent.append(chunk)


s = Rec()
s.on_tool(types.SimpleNamespace(id="1", name="Bash", input={"command": "ssh h ls"}))
s.on_tool_result(types.SimpleNamespace(tool_use_id="1", is_error=False))
s.on_tool(types.SimpleNamespace(id="2", name="Read", input={"file_path": "/x"}))
tools = [c for c in s.sent if c.get("type") == "tool"]
t("running/done chunk 都帶 where", [(c["status"], c.get("where")) for c in tools]
  == [("running", "cloud"), ("done", "cloud"), ("running", "local")])

print("\nall green" if not red else f"\n{red} red")
sys.exit(1 if red else 0)
