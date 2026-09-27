"""停止那一句不露內部工具名(e2e 0.1.8 #28:「中斷的步驟：mcp__blave_browser__browser_search。」)。

鎖:① 還在跑的步驟用 kind 對到的人話(zh / cn / en);② 對不到的(unknown、silent、外殼不認得的新 kind)
不列,只剩「已停止。」,沒有步驟在跑也一樣有這一句(#87);③ 狀態列認得的每一種工具 kind(shell/i18n/en.po 的 act.*)這裡都有一句——列舉,
不是抽樣;④ sink 記下來的就是 kind,不是工具名。

跑法:cd blave-agent && python3 tests/check_stop_note_steps.py
"""
import os, re, sys, tempfile, types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))
WS = tempfile.mkdtemp(prefix="check-stop-note-ws-")
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.setdefault("BLAVE_AGENT_DB", os.path.join(WS, "session.db"))
sys.modules["claude_agent_sdk"] = types.ModuleType("claude_agent_sdk")
import agent_turn as at  # noqa: E402

fails = []


def t(name, ok, got=None):
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok or got is None else f"  → {got!r}"))
    if not ok:
        fails.append(name)


ZH, EN = "幫我查一下比特幣新聞", "look up bitcoin news"
n = at._stop_note([], ["search"], ZH)
t("zh:搜尋", n == "已停止。中斷的步驟：搜尋。", n)
n = at._stop_note([], ["search", "backtest", "search"], ZH)
t("zh:多步去重、頓號", n == "已停止。中斷的步驟：搜尋、跑回測。", n)
n = at._stop_note([], ["web_read"], ZH, "cn")
t("cn:读网页", n == "已停止。中断的步骤：读网页。", n)
n = at._stop_note([], ["search", "backtest"], EN)
t("en", n == "Stopped. Interrupted: searching the web, running a backtest.", n)
n = at._stop_note([], ["unknown", "silent", "brand_new_kind", "mcp__blave_browser__browser_search"], ZH)
t("對不到 → 只寫已停止", n == "已停止。", n)
n = at._stop_note([], ["unknown"], EN)
t("en 對不到 → Stopped.", n == "Stopped.", n)
t("沒有在跑的步驟 → 仍有「已停止。」(#87)", at._stop_note([], [], ZH) == "已停止。" and at._stop_note([], [], EN) == "Stopped.")
n = at._stop_note(["order script"], ["unknown"], ZH)
t("背景下單腳本那句照舊、步驟不列", n.startswith("已停止。下單腳本 會動到部位") and "步驟" not in n, n)

# ③ 列舉:狀態列的 act.* 扣掉不是工具的那幾個
po = open(os.path.join(ROOT, "shell", "i18n", "en.po"), encoding="utf-8").read()
kinds = set(re.findall(r'^msgid "act\.([a-z_]+)"$', po, re.M)) - {"thinking", "reply", "unknown", "need_user", "code_prep"}
missing = sorted(kinds - set(at._STOP_STEP_TEXT))
t(f"狀態列的 {len(kinds)} 種工具 kind 都有一句", len(kinds) > 20 and not missing, missing)
t("en 步驟一律動名詞(不混名詞)", all(v[2].split()[0].endswith("ing") for v in at._STOP_STEP_TEXT.values()),
  [v[2] for v in at._STOP_STEP_TEXT.values() if not v[2].split()[0].endswith("ing")])
bad = [k for k, v in at._STOP_STEP_TEXT.items()
       if len(v) != 3 or not all(v) or re.search(r"[A-Za-z_]", v[0] + v[1]) or "__" in v[2]]
t("中文那兩句沒有英文字、英文那句沒有工具名", not bad, bad)


# ④ sink 記的是 kind
class _Sink(at.LocalSink):
    def __init__(self):
        super().__init__("desktop-test0000")
        self.sent = []

    def _send(self, chunk):
        self.sent.append(chunk)


s = _Sink()
s.on_tool(types.SimpleNamespace(id="t1", name="mcp__blave_browser__browser_search", input={"query": "btc"}))
s.on_tool(types.SimpleNamespace(id="t2", name="ToolFromTheFuture", input={}))
flight = [v[3] for v in s._tool_t0.values()]
t("sink 記下 kind", flight == ["search", "unknown"], flight)
n = at._stop_note([], flight, ZH)
t("整條:瀏覽器搜尋被停 → 沒有工具名", n == "已停止。中斷的步驟：搜尋。", n)
src = open(os.path.join(ROOT, "runtime", "agent_turn.py"), encoding="utf-8").read()
t("run_turn 交給 _stop_note 的是 kind(v[3])", '[v[3] for v in getattr(sink, "_tool_t0", {}).values()]' in src)
s.on_tool_result(types.SimpleNamespace(tool_use_id="t1", is_error=False))
done = [c for c in s.sent if c.get("status") == "done"]
t("工具結果照舊帶工具名與耗時", len(done) == 1 and done[0]["tool"] == "mcp__blave_browser__browser_search" and "ms" in done[0], done)

# ⑤ #87:停在兩個工具之間(沒有步驟在跑、只有過場旁白)→ 回覆是「已停止。」,不是那句旁白
s = _Sink()
s.on_text("Coinbase 被封鎖，改開 calquify 補足六個網站。")
s.on_tool(types.SimpleNamespace(id="t9", name="mcp__blave_browser__browser_wait", input={}))
s.on_tool_result(types.SimpleNamespace(tool_use_id="t9", is_error=False))
s.interrupted = True
s.on_text(at._stop_note([], [v[3] for v in s._tool_t0.values()], ZH))
reply = s.finalize()
t("停在兩個工具之間:回覆是已停止、旁白不補位", reply == "已停止。", reply)
t("run_turn 不再看 note 有沒有字才送", "if note:" not in src[src.index("stopped = getattr(sink"):src.index("reply_text = sink.finalize()")])

if fails:
    sys.exit(f"{len(fails)} failed")
print("all passed")
