"""資料卡改由 runtime 觸發(spec login-upgrade-buttons-0150 §1.1、§5 runtime 1–4)。

鎖四件事:
  ① data_access_hit 的 fixture 表:access=0 的 traceback／_NO_ACCESS_MSG → denied;access=1 的 api 403 body
     (lib/data 聊天回合實際印出來的兩種樣子)→ err005／err007;Read 工具、沒設旗標、只有一個 ERR007 字樣 → 不算。
  ② LocalSink:一輪最多一張 card、在 done 之前;err005 與 err007 同輪 → err005;被 Stop 截斷不送。
  ③ Codex:command_execution 的 aggregated_output 走同一個比對,結果跟 Claude 那條一樣。
  ④ relogin 原因與 no_credit 失敗代碼。

跑法:cd blave-agent && python3 tests/check_data_access_card.py
"""
import ast, contextlib, io, json, os, sys, tempfile, types
from types import SimpleNamespace

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))
_tmp = tempfile.mkdtemp(prefix="check-data-card-")
os.makedirs(os.path.join(_tmp, "ws", "state"))
os.environ.update({"BLAVE_AGENT_WORKSPACE": os.path.join(_tmp, "ws"),
                   "BLAVE_AGENT_STATE": os.path.join(_tmp, "state"),
                   "BLAVE_AGENT_DB": os.path.join(_tmp, "session.db")})
os.environ.pop("BLAVE_PROXY_TOKEN", None)
for k in ("BLAVE_DATA_ACCESS", "BLAVE_DATA_ACCESS_WHY"):
    os.environ.pop(k, None)
sdk = types.ModuleType("claude_agent_sdk")
for _name in ("ClaudeAgentOptions", "AssistantMessage", "TextBlock", "ToolUseBlock", "ThinkingBlock", "ResultMessage"):
    setattr(sdk, _name, type(_name, (), {"__init__": lambda self, **kw: self.__dict__.update(kw)}))
sys.modules["claude_agent_sdk"] = sdk
import agent_turn as at  # noqa: E402
import codex_engine  # noqa: E402

red = 0


def t(name, cond, why=""):
    global red
    print(("PASS  " if cond else "FAIL  ") + name + ("" if cond or not why else "  " + str(why)))
    if not cond:
        red += 1


# lib/data 的原句從原始碼讀,不抄一份:那句一改,這裡跟著用新的
src = open(os.path.join(ROOT, "lib", "data.py"), encoding="utf-8").read()
NO_ACCESS = next(ast.literal_eval(n.value) for n in ast.parse(src).body
                 if isinstance(n, ast.Assign) and getattr(n.targets[0], "id", "") == "_NO_ACCESS_MSG")
TRACE = ("Traceback (most recent call last):\n  File \"<string>\", line 3, in <module>\n"
         "  File \"/x/Blave/lib/data.py\", line 86, in _check_data_access\n    raise DataAccessError(_NO_ACCESS_MSG)\n"
         "lib.data.DataAccessError: " + NO_ACCESS + "\n")


def body(code, msg):   # Flask jsonify(正式環境):排序過的 compact JSON;lib/data 只附頭 200 字
    return json.dumps({"error_code": code, "message": msg, "next_steps": {"agent_plan": "https://blave.org/x"}},
                      sort_keys=True, separators=(",", ":"))[:200]


URL = "https://api.blave.org/holder_concentration/get_alpha?symbol=BTC"
E007 = ("requests.exceptions.HTTPError: 403 Client Error: Forbidden for url: " + URL + " — "
        + body("ERR007", "Blave data access requires a Blave Agent cloud plan (every tier includes data, also for the desktop app) or an API plan."))
E005 = "RuntimeError: /kline BTCUSDT 1h HTTP 403: " + body("ERR005", "Invalid API key.")
DOC = ("| 403 | `ERR007` | no data access |\nERR007 — the account has no data access right now\n"
       '403 `{"error_code": "ERR007"}` — see next_steps\n')
hit = at.data_access_hit
for name, args, want in [
    ("access=0 + Bash 輸出帶 traceback → denied", ("Bash", TRACE, "0"), "denied"),
    ("access=0 + 只印了 _NO_ACCESS_MSG(agent 自己 print(e))→ denied", ("Bash", "fetch failed: " + NO_ACCESS, "0"), "denied"),
    ("access=0 + PowerShell → denied", ("PowerShell", TRACE, "0"), "denied"),
    ("access=0 + content 是 [{type:text}] 清單 → denied", ("Bash", [{"type": "text", "text": TRACE}], "0"), "denied"),
    ("access=0 + 同一段字在 Read 結果裡 → 不算", ("Read", TRACE, "0"), None),
    ("access=0 + Grep 結果 → 不算", ("Grep", TRACE, "0"), None),
    ("access=0 + grep 出 `except DataAccessError:` → 不算", ("Bash", "lib/data.py:4567:        except DataAccessError:\n", "0"), None),
    ("沒設 BLAVE_DATA_ACCESS → 不算", ("Bash", TRACE, ""), None),
    ("沒設 BLAVE_DATA_ACCESS(ERR007 body)→ 不算", ("Bash", E007, ""), None),
    ("access=1 + api 403 body 帶 ERR007 → err007", ("Bash", E007, "1"), "err007"),
    ("access=1 + fetch_kline 那種 HTTP 403 帶 ERR005 → err005", ("Bash", E005, "1"), "err005"),
    ("access=1 + 冒號後有空白的 body(debug 版 jsonify)→ err007", ("Bash", 'HTTPError: 403 Client Error: Forbidden — {"error_code": "ERR007"}', "1"), "err007"),
    ("access=1 + 只有 ERR007 字樣的文件內容 → 不算", ("Bash", DOC, "1"), None),
    ("access=1 + Read 的 api 403 body → 不算", ("Read", E007, "1"), None),
    ("access=1 + traceback 的 DataAccessError → 不算(那是 access=0 的事)", ("Bash", TRACE, "1"), None),
    ("access=0 + ERR007 body → 不算(access=0 不送請求)", ("Bash", E007, "0"), None),
    ("access=1 + 兩種同一段 → err005", ("Bash", E007 + "\n" + E005, "1"), "err005"),
    ("尾端 64 KB 以外的命中不算", ("Bash", E007 + "\n" + "x" * (at.DATA_CARD_SCAN_CHARS + 10), "1"), None),
]:
    got = hit(*args)
    t("① " + name, got == want, got)
# 稽核 0150 P3:超長單行不能讓比對回溯到秒級(舊式 [^\n]*? 在 64 KB 一行上要 2.3 秒)
import time
for name, text in [("403 後面接 64 KB 沒有 body", "HTTP 403: " + "x" * at.DATA_CARD_SCAN_CHARS),
                   ("整行重複 403 Client Error", "403 Client Error " * (at.DATA_CARD_SCAN_CHARS // 17)),
                   ("403 後面一整行 error_code 但沒有冒號", "403 Client Error " + '"error_code"' * 5000)]:
    t0 = time.perf_counter(); got = hit("Bash", text, "1"); ms = (time.perf_counter() - t0) * 1000
    t(f"① 超長單行({name}):< 500ms 而且不算命中(舊寫法 2.7 秒;門檻放寬給慢的 Windows 機)", got is None and ms < 500, f"{got} {ms:.1f}ms")
os.environ["BLAVE_DATA_ACCESS"] = "0"
t("① access 沒給就讀環境變數", hit("Bash", TRACE) == "denied")
os.environ.pop("BLAVE_DATA_ACCESS")


def run_sink(results, engine="claude", interrupted=False):
    """一輪:每筆 (工具名, 輸出) 一個工具呼叫,回合結束;回 LocalSink 印出的 chunk。"""
    out = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
        sink = at.LocalSink("s1")
        if engine == "claude":
            for i, (name, text) in enumerate(results):
                sink.on_tool(SimpleNamespace(id=f"u{i}", name=name, input={"command": "python3 x.py"}))
                sink.on_tool_result(SimpleNamespace(tool_use_id=f"u{i}", is_error=True, content=text))
        else:
            tr = codex_engine.CodexTranslator(sink)
            for i, (kind, text) in enumerate(results):
                item = {"id": f"i{i}", "type": kind, "command": "/bin/zsh -lc 'python3 x.py'", "aggregated_output": text,
                        "exit_code": 1, "status": "failed", "changes": [{"kind": "update", "path": "/x/a.py"}]}
                tr.feed({"type": "item.started", "item": {**item, "status": "in_progress"}})
                tr.feed({"type": "item.completed", "item": item})
        sink.on_text("拿不到籌碼集中度。")
        sink.interrupted = interrupted
        sink.finalize()
    return [json.loads(x[len("@@BLAVE@@"):]) for x in out.getvalue().splitlines() if x.startswith("@@BLAVE@@")]


cards = lambda cs: [c for c in cs if c["type"] == "card"]
os.environ["BLAVE_DATA_ACCESS"] = "0"
cs = run_sink([("Bash", TRACE), ("Bash", TRACE)])
t("② 兩次命中只送一張,形狀對", cards(cs) == [{"type": "card", "id": "data-access", "code": "denied", "session_id": "s1"}], cards(cs))
types_ = [c["type"] for c in cs]
t("② card 在 done 之前", "card" in types_ and types_.index("card") < types_.index("done") and types_[-1] == "done", types_)
t("② Read 讀到同一段 → 不送", cards(run_sink([("Read", TRACE)])) == [])
t("② 被 Stop 截斷 → 不送", cards(run_sink([("Bash", TRACE)], interrupted=True)) == [])
os.environ["BLAVE_DATA_ACCESS"] = "1"
cs = run_sink([("Bash", E007), ("Bash", E005), ("Bash", E007)])
t("② err005 與 err007 同輪 → 只送 err005", [c["code"] for c in cards(cs)] == ["err005"], cards(cs))
t("② 只有文件裡的 ERR007 → 不送", cards(run_sink([("Bash", DOC)])) == [])
os.environ.pop("BLAVE_DATA_ACCESS")
t("② 沒設旗標(雲端機／own)→ 不送", cards(run_sink([("Bash", TRACE), ("Bash", E005)])) == [])

# ③ Codex:同一組 fixture、同一個結果;file_change(Edit)不比
for access, text, want in [("0", TRACE, ["denied"]), ("1", E007, ["err007"]), ("1", E005, ["err005"]), ("1", DOC, [])]:
    os.environ["BLAVE_DATA_ACCESS"] = access
    claude = [c["code"] for c in cards(run_sink([("Bash", text)]))]
    codex = [c["code"] for c in cards(run_sink([("command_execution", text)], engine="codex"))]
    t(f"③ Codex 與 Claude 同一個結果(access={access}, want={want})", claude == codex == want, (claude, codex))
os.environ["BLAVE_DATA_ACCESS"] = "0"
t("③ Codex 的 file_change 不比", cards(run_sink([("file_change", TRACE)], engine="codex")) == [])
os.environ.pop("BLAVE_DATA_ACCESS")

# ④ relogin:有那一句事實,回覆那條講重新登入、不講方案
t("④ DATA_ACCESS_WHY 有 relogin", "relogin" in at.DATA_ACCESS_WHY)
os.environ.update({"BLAVE_DATA_ACCESS": "0", "BLAVE_DATA_ACCESS_WHY": "relogin"})
rule = at.data_access_rule()
reply = rule[rule.index("your reply must:"):rule.index("Say it once per conversation")]
t("④ relogin:事實句在、回覆講重新登入、沒有「needs a plan」", at.DATA_ACCESS_WHY["relogin"] in rule
  and "has expired and needs signing in again" in reply and "needs a plan" not in reply and "unless the reason is signed_out or relogin" in rule, reply)
os.environ["BLAVE_DATA_ACCESS_WHY"] = "no_plan"
reply = (lambda r: r[r.index("your reply must:"):r.index("Say it once per conversation")])(at.data_access_rule())
t("④ no_plan 照舊講要方案、不講重新登入", "needs a plan" in reply and "signing in again" not in reply)
for k in ("BLAVE_DATA_ACCESS", "BLAVE_DATA_ACCESS_WHY"):
    os.environ.pop(k)

# ④ 失敗代碼
fc = at._fault_code
t("④ API Error: 402 → no_credit", fc(RuntimeError("API Error: 402 {\"type\":\"error\"}"), 0) == at.FAULT_NO_CREDIT)
t("④ result 帶 INSUFFICIENT_CREDIT → no_credit", fc(RuntimeError("x"), 0, {"result": '{"error_code":"INSUFFICIENT_CREDIT"}'}) == at.FAULT_NO_CREDIT)
t("④ api_error_status 402 → no_credit", fc(SimpleNamespace(api_error_status=402), 0) == at.FAULT_NO_CREDIT)
t("④ API Error: 503 照舊 not_started_upstream", fc(RuntimeError("API Error: 503 overloaded"), 0) == at.FAULT_NOT_STARTED_UPSTREAM)
t("④ proxy 403 試用額度照舊 not_started", fc(RuntimeError('API Error: 403 {"error_code":"TRIAL_AI_LOCKED"}'), 0) == at.FAULT_NOT_STARTED)
t("④ 跑過工具的 402 照舊 partial(收據比較重要)", fc(RuntimeError("API Error: 402"), 2) == at.FAULT_PARTIAL)
os.environ.update({"BLAVE_LLM_RELAY_URL": "http://127.0.0.1:1/x", "BLAVE_LLM_RELAY_TOKEN": "t"})
t("④ 自帶 API 金鑰(relay 模式)的供應商 402 → 不是 no_credit(同 relay.js 的 apikey 規則)", fc(RuntimeError("API Error: 402 insufficient_quota"), 0) == at.FAULT_NOT_STARTED
  and fc(SimpleNamespace(api_error_status=402), 0) == at.FAULT_NOT_STARTED)
for k in ("BLAVE_LLM_RELAY_URL", "BLAVE_LLM_RELAY_TOKEN"):
    os.environ.pop(k)
t("④ 四份文案表都有 no_credit(TG 沒有會 KeyError)",
  all(at.FAULT_NO_CREDIT in at.FAULT_TEXT[s] and at.FAULT_NO_CREDIT in at.FAULT_TEXT_CN[s] for s in ("web", "tg")))
t("④ web 句跟工作頁 402 卡「有卡」那態同字面", at.FAULT_TEXT["web"][at.FAULT_NO_CREDIT]
  == ("Blave 餘額用完了，這一輪沒有跑。", "Your Blave balance is empty, so this turn didn’t run."))
t("④ _fault_message:TG cn", at._fault_message(at.FAULT_NO_CREDIT, "x", "tg", lang="cn").startswith("Blave 余额用完了"))

print(("全部通過" if not red else f"{red} 條沒過"))
sys.exit(1 if red else 0)
