"""模型漏寫 <export …/> 標記時,轉出卡照出(e2e 0.1.8 #49)。

實測:同一則對話先轉 XQ(回覆結尾是標記,出卡)、再轉 Pine——回覆結尾改成 <suggest> 區塊、標記不見了,
檔案與 lint sidecar 都在,runtime 沒有東西可送,聊天沒有卡。「回覆必須以 <suggest> 結尾」跟「標記放最後」
搶同一個位置。鎖:
  ① 回覆沒有標記、這一輪 lint 過的轉出檔(sidecar 的 exported_at 在這一輪之內、工具碰過那支策略)→ 送 chunk;
  ② 上一輪轉的(exported_at 早於這一輪)、別條對話碰的策略、sidecar 壞掉 → 不送;
  ③ 回覆有標記 → 照標記走,不重複送;被停止的回合不送;
  ④ 標記後面接 <suggest> 兩個都收;prompt 與三份 reference 都寫明兩者並存時標記在前。

跑法:cd blave-agent && python3 tests/check_export_unmarked.py
"""
import json, os, sys, tempfile, time, types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))
WS = tempfile.mkdtemp(prefix="check-export-unmarked-ws-")
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.setdefault("BLAVE_AGENT_DB", os.path.join(WS, "session.db"))
sys.modules["claude_agent_sdk"] = types.ModuleType("claude_agent_sdk")
import agent_turn as at  # noqa: E402

fails = []


def t(name, ok, got=None):
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok or got is None else f"  → {got!r}"))
    if not ok:
        fails.append(name)


def iso(ts):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))


def put(name, target, exported_at, meta=None):
    fn = {"xq": "xq.xs", "mc": "mc.txt", "pine": "pine.pine"}[target]
    d = os.path.join(WS, "strategies", name, "exports")
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, fn), "w", encoding="utf-8") as f:
        f.write(f"// {name} {target}\n")
    with open(os.path.join(d, fn + ".meta.json"), "w", encoding="utf-8") as f:
        f.write(meta if meta is not None else json.dumps(
            {"target": target, "source_sha256": "x", "exported_at": exported_at, "template": None}))


class _Sink(at.LocalSink):
    def __init__(self):
        super().__init__("desktop-test0000")
        self.sent = []

    def _send(self, chunk):
        self.sent.append(chunk)

    def cards(self):
        return [(c["strategy"], c["target"]) for c in self.sent if c["type"] == "export"]


now = time.time()
put("tsmc_ma_cross", "xq", iso(now - 120))      # 上一輪轉的
put("tsmc_ma_cross", "pine", iso(now + 1))      # 這一輪轉的
put("other", "pine", iso(now + 1))              # 同時間別條對話轉的
REPLY = "Lint 通過，檔案已存好。請貼進 TradingView 的 Pine 編輯器編譯。\n\n<suggest>\n把台積電均線上模擬盤\n</suggest>"

s = _Sink()
s.started_at = now
s.export_touched = {"tsmc_ma_cross"}
s.on_text(REPLY)
out = s.finalize()
t("① 漏標記:這一輪的 Pine 出卡;上一輪的 XQ、別條對話的策略不出", s.cards() == [("tsmc_ma_cross", "pine")], s.cards())
card = next((c for c in s.sent if c["type"] == "export"), {})
t("chunk 形狀同標記路徑(filename 由策略名組、帶內容)",
  card.get("filename") == "tsmc_ma_cross_pine.pine" and card.get("content") == "// tsmc_ma_cross pine\n", card)
t("回覆本文不動、建議照送", out.startswith("Lint 通過") and "<suggest>" not in out
  and any(c["type"] == "suggestions" for c in s.sent), out)
order = [c["type"] for c in s.sent if c["type"] in ("export", "done")]
t("export 在 done 之前", order == ["export", "done"], order)

s = _Sink()
s.started_at = now
s.on_text(REPLY)
s.finalize()
t("② 這一輪的工具沒碰過任何策略 → 不送", s.cards() == [], s.cards())

put("broken", "pine", None, meta="{not json")
put("wrongtarget", "pine", None, meta=json.dumps({"target": "xq", "exported_at": iso(now + 1)}))
put("nodate", "pine", None, meta=json.dumps({"target": "pine"}))
got = at.unmarked_exports(now, {"broken", "wrongtarget", "nodate", "missing", "../x"}, WS)
t("② sidecar 壞掉 / target 對不上 / 沒有時間 / 沒有檔 / 壞名字 → 不送也不炸", got == [], got)

s = _Sink()
s.started_at = now
s.export_touched = {"tsmc_ma_cross"}
s.on_text('轉好了。\n\n<export target="pine" path="strategies/tsmc_ma_cross/exports/pine.pine" />\n\n<suggest>\n把台積電均線上模擬盤\n</suggest>')
out = s.finalize()
t("③④ 標記後面接 <suggest>:一張卡(不重複)、建議照送、標記不露出",
  s.cards() == [("tsmc_ma_cross", "pine")] and any(c["type"] == "suggestions" for c in s.sent) and out == "轉好了。", (s.cards(), out))

s = _Sink()
s.started_at = now
s.export_touched = {"tsmc_ma_cross"}
s.on_text('轉好了。\n\n<export target="pine" path="strategies/nope/exports/pine.pine" />')
out = s.finalize()
t("③ 標記寫了但讀不到 → 照舊只補失敗那一句,不拿別的檔頂替", s.cards() == [] and out.endswith(at._EXPORT_FAIL_NOTE), (s.cards(), out))

s = _Sink()
s.started_at = now
s.export_touched = {"tsmc_ma_cross"}
s.interrupted = True
s.on_text(REPLY)
s.finalize()
t("③ 被停止的回合不送", s.cards() == [], s.cards())

src = open(os.path.join(ROOT, "runtime", "agent_turn.py"), encoding="utf-8").read()
t("run_turn 把這一輪碰過的策略交給 sink", "sink.export_touched = touched" in src)
t("④ prompt:有轉出檔時標記放在 <suggest> 前一行", "放在 <suggest> 區塊的前一行" in at._SUGGEST_RULE)
for fn in ("xq-xs.md", "multicharts-powerlanguage.md", "tradingview-pine.md"):
    ref = open(os.path.join(ROOT, "references", fn), encoding="utf-8").read()
    t(f"④ references/{fn}:<suggest> 在標記之後、不准省標記", "never drop the marker" in ref)

if fails:
    sys.exit(f"{len(fails)} failed")
print("all passed")
