"""回合結束一律清掉 `<workspace>/tmp/cloud-handoff/`(雲端交接的短效 SSH 金鑰與憑證)。

規則要 agent 在回合結束前自己刪;回合出錯(撞 max_turns、半途、崩潰)時它沒機會刪,金鑰會留在
磁碟上等下一個回合碰巧清。這支真的跑一次 run_turn(SDK 用假的,跑一個工具之後撞 max_turns),
驗那個資料夾不見了;另外驗清理只碰那一個路徑:不存在不出錯、連結只拿掉連結、`tmp` 指到
workspace 外面時整個不碰。
另外釘住雲端視角那一段叫 agent 用 Read 讀 cloud-handoff.md(56KB,cat 會被截斷、多花一步)。

跑法:cd blave-agent && python3 tests/check_cloud_handoff_cleanup.py
"""
import asyncio, contextlib, io, json, os, sys, tempfile, types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))
_tmp = tempfile.mkdtemp(prefix="check-handoff-")
WS = os.path.join(_tmp, "ws")
os.makedirs(os.path.join(WS, "state"))
os.environ.update({"BLAVE_AGENT_WORKSPACE": WS, "BLAVE_AGENT_STATE": os.path.join(_tmp, "state"),
                   "BLAVE_AGENT_DB": os.path.join(_tmp, "session.db")})
os.environ.pop("BLAVE_PROXY_TOKEN", None)

sdk = types.ModuleType("claude_agent_sdk")


class _Obj:
    def __init__(self, **kw):
        self.__dict__.update(kw)


for _n in ("ClaudeAgentOptions", "AssistantMessage", "TextBlock", "ToolUseBlock", "ThinkingBlock", "ResultMessage"):
    setattr(sdk, _n, type(_n, (_Obj,), {}))


async def _max_turns_query(prompt, options):
    # 跑了一個工具之後撞上步驟上限(CLI 自帶的那句;_fault_code 認得)
    yield sdk.AssistantMessage(content=[sdk.ToolUseBlock(id="t1", name="Bash", input={"command": "ssh host true"})])
    raise RuntimeError("Reached maximum number of turns (40)")


sdk.query = _max_turns_query
sys.modules["claude_agent_sdk"] = sdk
import agent_turn as at  # noqa: E402

red = 0


def t(name, ok):
    global red
    print(("PASS  " if ok else "FAIL  ") + name)
    red += 0 if ok else 1


HANDOFF = os.path.join(WS, "tmp", "cloud-handoff")


def plant():
    os.makedirs(HANDOFF, exist_ok=True)
    for f in ("id_ed25519", "id_ed25519-cert.pub"):
        with open(os.path.join(HANDOFF, f), "w") as fh:
            fh.write("fake")


# ① 撞 max_turns 的回合:交接資料夾照樣被清掉
plant()
out = io.StringIO()
with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
    asyncio.run(at.run_turn("s1", "幫我更新雲端主機", "sonnet", at.LocalSink("s1")))
chunks = [json.loads(line[len("@@BLAVE@@"):]) for line in out.getvalue().splitlines() if line.startswith("@@BLAVE@@")]
t("這一回合真的是 max_turns 出錯收場", any(c.get("type") == "error" and c.get("code") == at.FAULT_MAX_TURNS for c in chunks))
t("max_turns 收場之後 tmp/cloud-handoff/(金鑰與憑證)不在了", not os.path.lexists(HANDOFF))
t("tmp/ 本身留著(只清那一個資料夾)", os.path.isdir(os.path.join(WS, "tmp")))

# ② 不存在:不出錯
at._remove_cloud_handoff_dir(WS)
t("資料夾不存在時清理不出錯", not os.path.lexists(HANDOFF))

# ③ cloud-handoff 是指到外面的連結:只拿掉連結,外面那份一個字不動
outside = os.path.join(_tmp, "outside")
os.makedirs(outside)
with open(os.path.join(outside, "keep"), "w") as fh:
    fh.write("keep")
os.symlink(outside, HANDOFF)
at._remove_cloud_handoff_dir(WS)
t("cloud-handoff 是連結:只拿掉連結,目標資料夾與檔案原封不動",
  not os.path.lexists(HANDOFF) and os.path.isfile(os.path.join(outside, "keep")))

# ④ tmp 本身指到 workspace 外面:整個不碰
os.rmdir(os.path.join(WS, "tmp"))
os.makedirs(os.path.join(outside, "cloud-handoff"))
os.symlink(outside, os.path.join(WS, "tmp"))
at._remove_cloud_handoff_dir(WS)
t("tmp 指到 workspace 外面:外面的 cloud-handoff 不碰", os.path.isdir(os.path.join(outside, "cloud-handoff")))

# ⑥ 多條對話並行(0.1.37):只清這一輪自己的子資料夾,別條的原封不動;舊版直接放在 cloud-handoff/ 底下的檔一起清
os.unlink(os.path.join(WS, "tmp"))
os.makedirs(os.path.join(WS, "tmp"))
for sid in ("desktop-aaaa1111", "desktop-bbbb2222"):
    os.makedirs(os.path.join(HANDOFF, sid))
    with open(os.path.join(HANDOFF, sid, "id"), "w") as fh:
        fh.write("fake")
with open(os.path.join(HANDOFF, "id"), "w") as fh:
    fh.write("legacy")
at._remove_cloud_handoff_dir(WS, "desktop-aaaa1111")
t("並行:這一輪(A)的子資料夾清掉", not os.path.lexists(os.path.join(HANDOFF, "desktop-aaaa1111")))
t("並行:別條(B)的子資料夾與金鑰原封不動", os.path.isfile(os.path.join(HANDOFF, "desktop-bbbb2222", "id")))
t("並行:舊版留在 cloud-handoff/ 底下的檔一起清", not os.path.lexists(os.path.join(HANDOFF, "id")))
at._remove_cloud_handoff_dir(WS, "desktop-bbbb2222")
t("最後一條收尾:cloud-handoff/ 空了就拿掉", not os.path.lexists(HANDOFF))
t("子資料夾名就是對話 id;怪字退回固定字(會被貼進命令列)",
  at.handoff_folder("desktop-ab12cd34") == "desktop-ab12cd34" and at.handoff_folder("../x") == "turn" and at.handoff_folder(None) == "turn" and at.handoff_folder("d" * 33) == "turn" and at.handoff_folder("d" * 32) == "d" * 32)
rule = at.mcp_rule(True, "desktop-ab12cd34")
t("mcp_rule 寫明這一輪的資料夾、get_ssh_access 帶 handoff_dir、別碰別條的",
  "`tmp/cloud-handoff/desktop-ab12cd34/`" in rule and "`handoff_dir` = `desktop-ab12cd34`" in rule and "never touch those" in rule)
t("run_turn 收尾只清這一輪的(帶 session_id)", "_remove_cloud_handoff_dir(session_id=session_id)" in open(os.path.join(ROOT, "runtime", "agent_turn.py"), encoding="utf-8").read())

# ⑤ 雲端視角(掛上 MCP)那一段:cloud-handoff.md 不要一次 cat;不綁引擎(Codex 沒有 Read 工具)
seg = at._viewing_env_segment(True)
t("雲端視角提示:cloud-handoff.md 不要一次 cat 整份,沒有讀檔工具就分段讀",
  "不要一次 cat" in seg and "sed -n" in seg and "cloud-handoff.md" in seg)
t("雲端視角提示不點名只有 Claude 才有的工具(Codex 那條也吃同一段)", "Read" not in seg and "Bash" not in seg)

print(("\n%d 紅" % red) if red else "\nALL PASS")
sys.exit(1 if red else 0)
